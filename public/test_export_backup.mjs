// test_export_backup.mjs
// Permanent unit tests for Pre-Wipe Export Reminder & Full Library Backup (Tier 4 #7 Phase A)
// Run with: node public/test_export_backup.mjs

import assert from 'node:assert/strict';

// Set up lightweight IDB mocks for Node test environment (zero dependencies)
globalThis.IDBRequest = class IDBRequest {};
globalThis.IDBOpenDBRequest = class IDBOpenDBRequest extends IDBRequest {};
globalThis.IDBDatabase = class IDBDatabase {};
globalThis.IDBTransaction = class IDBTransaction {};
globalThis.IDBObjectStore = class IDBObjectStore {};
globalThis.IDBIndex = class IDBIndex {};
globalThis.IDBCursor = class IDBCursor {};

let dbState = {
  decks: [],
  cards: [],
  documents: [],
  reviewLog: []
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
    return Promise.resolve([]);
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
  exportDeckData,
  exportAllDecks,
  exportLibraryData
} = await import('./db.js');

console.log('=== 1. exportAllDecks: empty library returns clean bundle ===');
{
  dbState = { decks: [], cards: [], documents: [], reviewLog: [] };
  const backup = await exportAllDecks();
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.sourceApp, 'Lernin');
  assert.equal(backup.deckCount, 0);
  assert.deepEqual(backup.decks, []);
  assert.equal(typeof backup.exportedAt, 'number');
  console.log('  ok - empty library exports formatVersion 1, deckCount 0, decks []');
}

console.log('=== 2. exportDeckData: single-deck export with progress ===');
{
  dbState = {
    decks: [
      { id: 'deck-1', title: 'Neuroscience', courseTerritoryId: 'stem', archived: false }
    ],
    cards: [
      {
        id: 'card-1',
        deckId: 'deck-1',
        front: 'What is a synapse?',
        back: 'A junction between neurons',
        type: 'basic',
        state: 'review',
        difficulty: 3.2,
        stability: 14.5,
        reps: 4,
        lapses: 0,
        last_review: 1710000000000,
        due_date: 1711000000000,
        suspended: false,
        leech: false
      }
    ],
    documents: [
      {
        id: 'doc-1',
        deckId: 'deck-1',
        filename: 'synapses.pdf',
        summary: 'Overview of synaptic transmission',
        size: 4096,
        uploadedAt: 1709990000000
      }
    ],
    reviewLog: [
      {
        id: 1,
        cardId: 'card-1',
        grade: 'good',
        reviewedAt: 1710000000000,
        elapsedDays: 3
      }
    ]
  };

  const deckData = await exportDeckData('deck-1', { includeProgress: true });
  assert.equal(deckData.formatVersion, 1);
  assert.equal(deckData.sourceApp, 'Lernin');
  assert.equal(deckData.includesProgress, true);
  assert.equal(deckData.deck.title, 'Neuroscience');
  assert.equal(deckData.deck.courseTerritoryId, 'stem');
  assert.equal(deckData.deck.archived, false);

  assert.equal(deckData.cards.length, 1);
  const card = deckData.cards[0];
  assert.equal(card.id, 'card-1');
  assert.equal(card.front, 'What is a synapse?');
  assert.equal(card.back, 'A junction between neurons');
  assert.equal(card.type, 'basic');
  assert.equal(card.state, 'review');
  assert.equal(card.stability, 14.5);
  assert.equal(card.difficulty, 3.2);
  assert.equal(card.reps, 4);
  assert.equal(card.suspended, false);
  assert.equal(card.leech, false);

  assert.equal(deckData.reviewLog.length, 1);
  assert.equal(deckData.reviewLog[0].grade, 'good');
  assert.equal(deckData.reviewLog[0].cardId, 'card-1');

  assert.equal(deckData.documents.length, 1);
  assert.equal(deckData.documents[0].filename, 'synapses.pdf');
  console.log('  ok - single-deck export includes all progress and metadata');
}

console.log('=== 3. exportDeckData: share copy excludes progress ===');
{
  const shareCopy = await exportDeckData('deck-1', { includeProgress: false });
  assert.equal(shareCopy.includesProgress, false);
  assert.equal(shareCopy.cards.length, 1);
  const card = shareCopy.cards[0];
  assert.equal(card.front, 'What is a synapse?');
  assert.equal(card.state, undefined, 'Share copy must not leak FSRS state');
  assert.equal(card.stability, undefined, 'Share copy must not leak stability');
  assert.equal(card.difficulty, undefined, 'Share copy must not leak difficulty');
  assert.equal(shareCopy.reviewLog.length, 0, 'Share copy must have empty reviewLog');
  console.log('  ok - progress-free export strips FSRS fields and reviewLog');
}

console.log('=== 4. exportAllDecks: multi-deck full library backup bundle ===');
{
  dbState = {
    decks: [
      { id: 'deck-1', title: 'Neuroscience', courseTerritoryId: 'stem', archived: false },
      { id: 'deck-2', title: 'Ancient Greek', courseTerritoryId: 'humanities', archived: true }
    ],
    cards: [
      {
        id: 'card-1',
        deckId: 'deck-1',
        front: 'What is a synapse?',
        back: 'A junction between neurons',
        type: 'basic',
        state: 'review',
        difficulty: 3.2,
        stability: 14.5,
        reps: 4,
        lapses: 0,
        last_review: 1710000000000,
        due_date: 1711000000000,
        suspended: false,
        leech: false
      },
      {
        id: 'card-2',
        deckId: 'deck-2',
        front: 'Logos',
        back: 'Word / Reason',
        type: 'basic',
        state: 'new',
        difficulty: 0,
        stability: 0,
        reps: 0,
        lapses: 0,
        last_review: null,
        due_date: 1710000000000,
        suspended: false,
        leech: false
      }
    ],
    documents: [
      { id: 'doc-1', deckId: 'deck-1', filename: 'synapses.pdf', summary: 'Notes', size: 100, uploadedAt: 1710000000000 }
    ],
    reviewLog: [
      { id: 1, cardId: 'card-1', grade: 'good', reviewedAt: 1710000000000, elapsedDays: 1 }
    ]
  };

  const backup = await exportAllDecks({ includeProgress: true });
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.sourceApp, 'Lernin');
  assert.equal(backup.deckCount, 2);
  assert.equal(backup.decks.length, 2);

  const deck1 = backup.decks.find((d) => d.deck.title === 'Neuroscience');
  const deck2 = backup.decks.find((d) => d.deck.title === 'Ancient Greek');
  assert.ok(deck1, 'Deck 1 should be present in bundle');
  assert.ok(deck2, 'Deck 2 should be present in bundle');
  assert.equal(deck1.deck.archived, false);
  assert.equal(deck2.deck.archived, true);
  assert.equal(deck1.cards.length, 1);
  assert.equal(deck2.cards.length, 1);
  assert.equal(deck1.reviewLog.length, 1);
  assert.equal(deck2.reviewLog.length, 0);

  // Parity alias exportLibraryData
  assert.equal(exportLibraryData, exportAllDecks, 'exportLibraryData should alias exportAllDecks');

  // JSON serialization round-trip guarantee
  const serialized = JSON.stringify(backup, null, 2);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, backup, 'JSON round-trip must produce identical structure');
  console.log('  ok - multi-deck bundle contains all decks, correct deckCount, and clean JSON serialization');
}

console.log('=== 5. exportDeckData: error on missing deck ===');
{
  await assert.rejects(
    async () => {
      await exportDeckData('non-existent-deck');
    },
    {
      message: 'No deck found with id non-existent-deck'
    }
  );
  console.log('  ok - missing deck id throws clear descriptive error');
}

console.log('\nAll export & backup unit tests passed successfully! 🌿');
