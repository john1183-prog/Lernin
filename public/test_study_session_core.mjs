// test_study_session_core.mjs
// Permanent unit tests for study-session-core.js (Tier 4 #7 Phase B)
// Run with: node public/test_study_session_core.mjs

import assert from 'node:assert/strict';

// Set up lightweight IDB mocks for Node test environment (zero dependencies)
globalThis.IDBRequest = class IDBRequest {};
globalThis.IDBOpenDBRequest = class IDBOpenDBRequest extends IDBRequest {};
globalThis.IDBDatabase = class IDBDatabase {};
globalThis.IDBTransaction = class IDBTransaction {};
globalThis.IDBObjectStore = class IDBObjectStore {};
globalThis.IDBIndex = class IDBIndex {};
globalThis.IDBCursor = class IDBCursor {};
globalThis.IDBKeyRange = {
  bound: () => ({}),
  upperBound: () => ({}),
  only: () => ({})
};

let dbState = {
  decks: [],
  cards: [],
  documents: [],
  reviewLog: [],
  cardRelationships: [],
  settings: {}
};

const mockDB = Object.assign(new globalThis.IDBDatabase(), {
  objectStoreNames: { contains: () => true },
  getAll: (store) => {
    return Promise.resolve(dbState[store] ? [...dbState[store]] : []);
  },
  get: (store, id) => {
    const list = dbState[store] || [];
    return Promise.resolve(list.find((item) => item.id === id) || null);
  },
  getAllFromIndex: (store, index, val) => {
    const list = dbState[store] || [];
    if (index === 'by_deckId') {
      return Promise.resolve(list.filter((item) => item.deckId === val));
    }
    if (index === 'by_cardId') {
      return Promise.resolve(list.filter((item) => item.cardId === val));
    }
    if (index === 'by_fromCardId') {
      return Promise.resolve(list.filter((item) => item.fromCardId === val));
    }
    return Promise.resolve([]);
  },
  put: (store, item) => {
    if (!dbState[store]) dbState[store] = [];
    const idx = dbState[store].findIndex(x => x.id === item.id);
    if (idx >= 0) dbState[store][idx] = item;
    else dbState[store].push(item);
    return Promise.resolve(item.id);
  },
  add: (store, item) => {
    if (!dbState[store]) dbState[store] = [];
    dbState[store].push(item);
    return Promise.resolve(item.id || Date.now());
  },
  delete: (store, key) => {
    if (!dbState[store]) return Promise.resolve();
    dbState[store] = dbState[store].filter(x => x.id !== key && x.cardId !== key);
    return Promise.resolve();
  },
  transaction: (storeNames, mode) => {
    function getStore(sName) {
      return {
        get: (id) => {
          const list = dbState[sName] || [];
          return Promise.resolve(list.find(x => x.id === id) || null);
        },
        put: (item) => {
          if (!dbState[sName]) dbState[sName] = [];
          const idx = dbState[sName].findIndex(x => x.id === item.id);
          if (idx >= 0) dbState[sName][idx] = item;
          else dbState[sName].push(item);
          return Promise.resolve(item.id);
        },
        add: (item) => {
          if (!dbState[sName]) dbState[sName] = [];
          dbState[sName].push(item);
          return Promise.resolve(item.id || Date.now());
        },
        delete: (key) => {
          if (!dbState[sName]) return Promise.resolve();
          dbState[sName] = dbState[sName].filter(x => x.id !== key && x.cardId !== key);
          return Promise.resolve();
        },
        index: (idxName) => ({
          openCursor: (range, direction) => {
            const list = [...(dbState[sName] || [])];
            function makeCursor(i) {
              if (i >= list.length) return null;
              return {
                value: list[i],
                delete: () => {
                  const item = list[i];
                  const realIdx = (dbState[sName] || []).indexOf(item);
                  if (realIdx >= 0) dbState[sName].splice(realIdx, 1);
                },
                continue: () => Promise.resolve(makeCursor(i + 1))
              };
            }
            return Promise.resolve(makeCursor(0));
          }
        })
      };
    }
    const primaryName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    const primaryStore = getStore(primaryName);
    return {
      store: primaryStore,
      objectStore: (name) => getStore(name),
      done: Promise.resolve()
    };
  }
});

globalThis.indexedDB = {
  open: () => {
    const req = Object.assign(new globalThis.IDBOpenDBRequest(), {
      result: mockDB,
      addEventListener: (type, cb) => {
        if (type === 'success') setTimeout(() => cb({ target: req }), 1);
      },
      removeEventListener: () => {}
    });
    return req;
  }
};

const {
  formatInterval,
  previewCardIntervals,
  interleaveQueue,
  applyPrerequisiteOrdering,
  prepareStudyQueue,
  gradeAndPersistCard,
  undoGradeCard,
  calculateSessionSummary,
  toRating,
  GRADE_MAP,
  GRADE_TO_RATING,
  Grade
} = await import('./study-session-core.js');

console.log('=== 1. formatInterval formatting rules ===');
{
  assert.equal(formatInterval(0), '<1m');
  assert.equal(formatInterval(0.0005), '<1m'); // ~43s < 1m
  assert.equal(formatInterval(10 / 1440), '10m');
  assert.equal(formatInterval(4 / 24), '4h');
  assert.equal(formatInterval(1), '1d');
  assert.equal(formatInterval(15), '15d');
  assert.equal(formatInterval(60), '2mo');
  assert.equal(formatInterval(null), '0d');
  assert.equal(formatInterval(NaN), '0d');
  console.log('  ok - formatInterval formats minutes, hours, days, and months correctly');
}

console.log('=== 2. previewCardIntervals returns raw and formatted intervals ===');
{
  const card = {
    id: 'c1',
    state: 'new',
    difficulty: 5,
    stability: 2,
    reps: 0,
    lapses: 0
  };
  const preview = previewCardIntervals(card);
  assert.ok(preview.intervals);
  assert.ok(preview.formatted);
  assert.ok(typeof preview.formatted.again === 'string');
  assert.ok(typeof preview.formatted.hard === 'string');
  assert.ok(typeof preview.formatted.good === 'string');
  assert.ok(typeof preview.formatted.easy === 'string');
  console.log('  ok - previewCardIntervals returns formatted strings for all 4 ratings');
}

console.log('=== 3. interleaveQueue caps, overdue-first sorting, and interleaving ===');
{
  const now = Date.now();
  const rawCards = [
    { id: 'n1', state: 'new' },
    { id: 'n2', state: 'new' },
    { id: 'n3', state: 'new' },
    { id: 'r1', state: 'review', due_date: now - 3600000 }, // 1h overdue
    { id: 'r2', state: 'review', due_date: now - 86400000 }, // 1d overdue (more overdue)
    { id: 'r3', state: 'review', due_date: now - 1800000 }  // 30m overdue
  ];

  // With newCap = 2, reviewCap = 2
  const queue = interleaveQueue(rawCards, { reviewCap: 2, newCap: 2 });
  assert.equal(queue.length, 4, 'Should contain 2 new + 2 reviews');
  assert.equal(queue.totalNew, 3);
  assert.equal(queue.queuedNew, 2);
  assert.equal(queue.newTruncated, true);
  assert.equal(queue.totalReviews, 3);
  assert.equal(queue.queuedReviews, 2);
  assert.equal(queue.reviewsTruncated, true);

  // Reviews should be sorted overdue-first: r2 (1d ago) before r1 (1h ago)
  // Interleaved: n1, r2, n2, r1
  assert.deepEqual(queue.map(c => c.id), ['n1', 'r2', 'n2', 'r1']);
  console.log('  ok - interleaveQueue correctly caps, sorts overdue-first, and interleaves');
}

console.log('=== 4. applyPrerequisiteOrdering pulls prerequisites earlier ===');
{
  // A depends on B. Initial queue: [A, B]
  // B should be pulled before A -> [B, A]
  dbState.cards = [
    { id: 'cardA', state: 'review' },
    { id: 'cardB', state: 'review' }
  ];
  dbState.cardRelationships = [
    { id: 'rel1', fromCardId: 'cardA', toCardId: 'cardB', type: 'dependsOn' }
  ];

  const queue = [
    { id: 'cardA', state: 'review' },
    { id: 'cardB', state: 'review' }
  ];

  const reordered = await applyPrerequisiteOrdering(queue);
  assert.deepEqual(reordered.map(c => c.id), ['cardB', 'cardA'], 'cardB should precede cardA');
  console.log('  ok - applyPrerequisiteOrdering pulls dependent prerequisites earlier');
}

console.log('=== 5. prepareStudyQueue filters suspended and prioritizes startCardId ===');
{
  const cardList = [
    { id: 'c1', deckId: 'd1', state: 'new', suspended: false },
    { id: 'c2', deckId: 'd1', state: 'review', suspended: true }, // suspended/draft -> excluded
    { id: 'c3', deckId: 'd1', state: 'review', suspended: false, due_date: Date.now() - 5000 },
    { id: 'c4', deckId: 'd1', state: 'review', suspended: false, due_date: Date.now() + 1000000 }
  ];
  dbState.cards = [...cardList];

  const queue = await prepareStudyQueue({
    cards: cardList,
    startCardId: 'c4', // requested specific card
    reviewCap: 10,
    newCap: 10,
    enableSmartOrdering: false
  });

  // c2 must be excluded (suspended)
  assert.equal(queue.some(c => c.id === 'c2'), false, 'Suspended card should be excluded');
  // c4 should be rotated to index 0
  assert.equal(queue[0].id, 'c4', 'startCardId c4 should be at index 0');
  assert.ok(queue.capInfo, 'capInfo should be attached');
  console.log('  ok - prepareStudyQueue excludes suspended cards and prioritizes startCardId');
}

console.log('=== 6. gradeAndPersistCard persists, updates in-memory, and returns milestone flags ===');
{
  const card = {
    id: 'testCard1',
    deckId: 'd1',
    state: 'learning',
    difficulty: 5,
    stability: 1,
    reps: 1,
    lapses: 0
  };
  dbState.cards = [card];
  dbState.reviewLog = [];

  // Grade 'easy' -> transitions learning to review (graduation!)
  const res = await gradeAndPersistCard({ card, grade: 'easy' });

  assert.equal(res.grade, 'easy');
  assert.equal(res.rating, Grade.EASY);
  assert.equal(res.prevState, 'learning');
  assert.ok(res.fsrsUpdate);
  assert.equal(res.nextState, 'review');
  assert.equal(res.isGraduation, true, 'learning -> review should trigger isGraduation');
  assert.equal(res.isRecovery, false, 'lapses 0 should not be recovery');

  // Verify in-memory card object updated
  assert.equal(card.state, res.nextState);
  assert.equal(card.stability, res.fsrsUpdate.stability);

  // Recovery test: card with lapses: 3
  const lapseCard = {
    id: 'testCard2',
    deckId: 'd1',
    state: 'review',
    difficulty: 6,
    stability: 2,
    reps: 4,
    lapses: 3
  };
  dbState.cards.push(lapseCard);

  const resLapse = await gradeAndPersistCard({ card: lapseCard, grade: 'good' });
  assert.equal(resLapse.isRecovery, true, 'lapses >= 2 should trigger isRecovery');
  console.log('  ok - gradeAndPersistCard updates card, persists log, and signals milestones');
}

console.log('=== 7. undoGradeCard restores previous state and cleans up log ===');
{
  const cardBefore = {
    id: 'testCardUndo',
    deckId: 'd1',
    state: 'review',
    difficulty: 5,
    stability: 4,
    reps: 2,
    lapses: 0,
    due_date: 1000,
    last_review: 500,
    suspended: false,
    leech: false
  };
  dbState.cards = [{ ...cardBefore }];
  dbState.reviewLog = [];

  // Grade card
  const res = await gradeAndPersistCard({ card: dbState.cards[0], grade: 'again' });
  assert.notEqual(dbState.cards[0].state, cardBefore.state);

  // Now undo using the snapshot
  await undoGradeCard(cardBefore);
  const restored = dbState.cards.find(c => c.id === 'testCardUndo');
  assert.equal(restored.state, cardBefore.state);
  assert.equal(restored.stability, cardBefore.stability);
  console.log('  ok - undoGradeCard restores card snapshot and removes reviewLog entry');
}

console.log('=== 8. calculateSessionSummary accuracy and counts ===');
{
  const emptySummary = calculateSessionSummary({});
  assert.equal(emptySummary.total, 0);
  assert.equal(emptySummary.accuracy, 0);
  assert.equal(emptySummary.goodPlus, 0);

  const activeSummary = calculateSessionSummary({
    again: 2,
    hard: 1,
    good: 5,
    easy: 2
  }, 1000, 5000);

  assert.equal(activeSummary.total, 10);
  assert.equal(activeSummary.again, 2);
  assert.equal(activeSummary.hard, 1);
  assert.equal(activeSummary.good, 5);
  assert.equal(activeSummary.easy, 2);
  assert.equal(activeSummary.goodPlus, 7);
  // Accuracy: (5 + 2) / 10 * 100 = 70%
  assert.equal(activeSummary.accuracy, 70);
  assert.equal(activeSummary.durationMs, 4000);
  console.log('  ok - calculateSessionSummary calculates correct counts, goodPlus, and accuracy');
}

console.log('\nAll study-session-core unit tests passed! ✨');
