// Run with: node public/test_mind_maze_phase1.mjs
//
// Permanent unit test suite for MindMaze v1 Phase 1 (`public/mind-maze.js`):
//   1. >12 due cards -> exactly 12 selected, 100% deterministic
//   2. Relationship edges (`dependsOn` / `related`) preferred in selection & graph edges
//   3. 0 due (`SANCTUARY`) vs 0 total cards (`EMPTY_DECK`) distinction
//   4. Suspended cards (`suspended: true` or `state: 'suspended'`) filtered out
//   5. Zero mutation of input card records (verified with deep Object.freeze)
//   6. Day-scoped `mindMazeState` clearedCardIds promotes frontier chambers cleanly

import assert from 'node:assert/strict';
import {
  MAZE_MAX_CHAMBERS,
  CHAMBER_RADIUS_MIN,
  CHAMBER_RADIUS_MAX,
  toMazeDayKey,
  hashToUnit,
  isCardActiveForMaze,
  isCardDueForMaze,
  selectMazeDueCards,
  resolveClearedCardIdsFromState,
  buildChamberGraph,
  chamberColor,
  getMazeThemeTokens,
  drawMindMazeFrame,
  normalizeMazeGrade,
  applyMazeGateGrade
} from './mind-maze.js';

const NOW = 1727265600000; // Fixed epoch ms anchor
const DAY_KEY = '2026-09-25';

function makeFrozenCard(overrides = {}) {
  const card = {
    id: overrides.id || 'card-1',
    deckId: overrides.deckId || 'deck-alpha',
    front: overrides.front || `Question for ${overrides.id || 'card-1'}`,
    back: overrides.back || 'Answer',
    type: overrides.type || 'basic',
    state: overrides.state || 'review',
    stability: overrides.stability ?? 15,
    difficulty: overrides.difficulty ?? 5,
    reps: overrides.reps ?? 3,
    lapses: overrides.lapses ?? 0,
    due_date: overrides.due_date ?? (NOW - 3600_000),
    suspended: overrides.suspended ?? false
  };
  return Object.freeze(card);
}

console.log('=== 1. >12 due cards -> exactly 12 selected, deterministic ===');
{
  const twentyDueCards = Object.freeze(
    Array.from({ length: 20 }, (_, i) =>
      makeFrozenCard({
        id: `card-${String(i + 1).padStart(2, '0')}`,
        due_date: NOW - (20 - i) * 1000,
        stability: (i * 3) % 35
      })
    )
  );

  const graphA = buildChamberGraph({
    deckId: 'deck-alpha',
    cards: twentyDueCards,
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  const graphB = buildChamberGraph({
    deckId: 'deck-alpha',
    cards: [...twentyDueCards].reverse(),
    nowMs: NOW,
    dayKey: DAY_KEY
  });

  assert.equal(graphA.status, 'ACTIVE');
  assert.equal(graphA.nodes.length, MAZE_MAX_CHAMBERS, 'Must cap chambers at exactly 12');
  assert.equal(graphA.totalActiveCards, 20);
  assert.equal(graphA.totalDueCards, 20);
  assert.equal(graphA.truncatedDueCount, 8);

  // Exact determinism even when input array order is reversed
  assert.deepEqual(graphA.nodes, graphB.nodes, 'Node layout and order must be 100% deterministic');
  assert.deepEqual(graphA.edges, graphB.edges, 'Edge set must be 100% deterministic');

  // Entry chamber starts FRONTIER, others FOGGED when clearedCardIds is empty
  assert.equal(graphA.nodes[0].status, 'FRONTIER');
  for (let i = 1; i < graphA.nodes.length; i++) {
    assert.equal(graphA.nodes[i].status, 'FOGGED');
    assert.ok(graphA.nodes[i].r >= CHAMBER_RADIUS_MIN && graphA.nodes[i].r <= CHAMBER_RADIUS_MAX);
  }
  console.log('  ok - 20 due cards capped to 12 deterministic chambers with valid radii & statuses');
}

console.log('=== 2. Relationship edges preferred in selection and graph construction ===');
{
  // Create 16 due cards. Cards 14 and 15 have slightly later due_date than 1..12,
  // but share a real `dependsOn` relationship and `related` link with card-16.
  const cards = Object.freeze(
    Array.from({ length: 16 }, (_, i) =>
      makeFrozenCard({
        id: `rel-card-${String(i + 1).padStart(2, '0')}`,
        due_date: NOW - (16 - i) * 1000
      })
    )
  );

  const relMap = new Map([
    ['rel-card-14', [{ cardId: 'rel-card-15', type: 'dependsOn' }]],
    ['rel-card-15', [{ cardId: 'rel-card-16', type: 'related' }]]
  ]);

  const graph = buildChamberGraph({
    deckId: 'deck-rel',
    cards,
    relationshipsByCardId: relMap,
    nowMs: NOW,
    dayKey: DAY_KEY
  });

  assert.equal(graph.nodes.length, 12);
  const selectedCardIds = new Set(graph.nodes.map((n) => n.cardId));
  assert.ok(selectedCardIds.has('rel-card-14'), 'Connected due card 14 must be preferred into the 12-cap');
  assert.ok(selectedCardIds.has('rel-card-15'), 'Connected due card 15 must be preferred into the 12-cap');
  assert.ok(selectedCardIds.has('rel-card-16'), 'Connected due card 16 must be preferred into the 12-cap');

  const relEdges = graph.edges.filter((e) => e.kind === 'relationship');
  assert.equal(relEdges.length, 2, 'Both real relationships must be materialized as relationship edges');
  assert.ok(relEdges.some((e) => e.type === 'dependsOn'));
  assert.ok(relEdges.some((e) => e.type === 'related'));

  // Verify every node in the 12-chamber graph is reachable from entryNodeId
  const adj = new Map();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) adj.get(e.fromId).push(e.toId);

  const visited = new Set([graph.entryNodeId]);
  const queue = [graph.entryNodeId];
  while (queue.length > 0) {
    const curr = queue.shift();
    for (const nxt of adj.get(curr) || []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }
  assert.equal(visited.size, graph.nodes.length, 'Every chamber must be reachable from entryNodeId');
  console.log('  ok - relationship-connected due cards preferred and wired into a fully reachable DAG');
}

console.log('=== 3. Zero-due (SANCTUARY) vs Zero-total-cards (EMPTY_DECK) distinction ===');
{
  const emptyRes = buildChamberGraph({
    deckId: 'deck-empty',
    cards: [],
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  assert.equal(emptyRes.status, 'EMPTY_DECK');
  assert.equal(emptyRes.isEmptyDeck, true);
  assert.equal(emptyRes.isSanctuary, false);
  assert.equal(emptyRes.totalActiveCards, 0);
  assert.equal(emptyRes.nodes.length, 0);

  const futureCards = Object.freeze([
    makeFrozenCard({ id: 'fut-1', due_date: NOW + 86400_000, state: 'review' }),
    makeFrozenCard({ id: 'fut-2', due_date: NOW + 172800_000, state: 'review' })
  ]);
  const sanctuaryRes = buildChamberGraph({
    deckId: 'deck-caught-up',
    cards: futureCards,
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  assert.equal(sanctuaryRes.status, 'SANCTUARY');
  assert.equal(sanctuaryRes.isSanctuary, true);
  assert.equal(sanctuaryRes.isEmptyDeck, false);
  assert.equal(sanctuaryRes.totalActiveCards, 2);
  assert.equal(sanctuaryRes.totalDueCards, 0);
  assert.ok(typeof sanctuaryRes.message === 'string' && sanctuaryRes.message.length > 10);
  console.log('  ok - 0 due returns SANCTUARY while 0 total cards returns EMPTY_DECK');
}

console.log('=== 4. Suspended cards filtered out ===');
{
  const mixedCards = Object.freeze([
    makeFrozenCard({ id: 'susp-bool', due_date: NOW - 5000, suspended: true }),
    makeFrozenCard({ id: 'susp-state', due_date: NOW - 5000, state: 'suspended' }),
    makeFrozenCard({ id: 'valid-due', due_date: NOW - 1000, suspended: false })
  ]);

  const res = buildChamberGraph({
    deckId: 'deck-susp',
    cards: mixedCards,
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  assert.equal(res.status, 'ACTIVE');
  assert.equal(res.totalActiveCards, 1);
  assert.equal(res.totalDueCards, 1);
  assert.equal(res.nodes.length, 1);
  assert.equal(res.nodes[0].cardId, 'valid-due');

  // Deck where ALL cards are suspended behaves as EMPTY_DECK (0 active cards)
  const allSuspendedRes = buildChamberGraph({
    deckId: 'deck-all-susp',
    cards: mixedCards.slice(0, 2),
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  assert.equal(allSuspendedRes.status, 'EMPTY_DECK');
  console.log('  ok - suspended cards (boolean and state) strictly excluded');
}

console.log('=== 5. Zero mutation of card records & day-scoped mindMazeState support ===');
{
  const rawCards = [
    makeFrozenCard({ id: 'c1', due_date: NOW - 9000, stability: 10 }),
    makeFrozenCard({ id: 'c2', due_date: NOW - 8000, stability: 20 }),
    makeFrozenCard({ id: 'c3', due_date: NOW - 7000, stability: 30 })
  ];
  const snapshotBefore = JSON.stringify(rawCards);

  const stateToday = {
    dayKey: DAY_KEY,
    deckId: 'deck-alpha',
    clearedCardIds: ['c1']
  };
  const stateYesterday = {
    dayKey: '2026-09-24',
    deckId: 'deck-alpha',
    clearedCardIds: ['c1', 'c2']
  };

  assert.deepEqual(resolveClearedCardIdsFromState(stateToday, 'deck-alpha', DAY_KEY), ['c1']);
  assert.deepEqual(resolveClearedCardIdsFromState(stateYesterday, 'deck-alpha', DAY_KEY), []);

  const graphWithCleared = buildChamberGraph({
    deckId: 'deck-alpha',
    cards: Object.freeze(rawCards),
    clearedCardIds: resolveClearedCardIdsFromState(stateToday, 'deck-alpha', DAY_KEY),
    nowMs: NOW,
    dayKey: DAY_KEY
  });

  assert.equal(JSON.stringify(rawCards), snapshotBefore, 'Card records must never be mutated');
  assert.equal(graphWithCleared.nodes[0].cardId, 'c1');
  assert.equal(graphWithCleared.nodes[0].status, 'CLEARED');
  assert.ok(
    graphWithCleared.nodes.slice(1).some((n) => n.status === 'FRONTIER'),
    'Clearing the entry chamber must promote its connected children to FRONTIER'
  );
  console.log('  ok - zero mutation of card records and day-scoped clearedCardIds promotes frontier');
}

console.log('=== 6. Phase 2 Canvas 2D renderer (drawMindMazeFrame) across ACTIVE / SANCTUARY / EMPTY_DECK ===');
{
  const makeMockCtx = () => {
    const ops = [];
    const gradStub = { addColorStop() {} };
    return {
      ops,
      save() {},
      restore() {},
      beginPath() { ops.push('beginPath'); },
      closePath() {},
      moveTo() {},
      lineTo() {},
      quadraticCurveTo() { ops.push('quadraticCurveTo'); },
      arc() { ops.push('arc'); },
      fill() { ops.push('fill'); },
      stroke() { ops.push('stroke'); },
      fillRect() { ops.push('fillRect'); },
      fillText(txt) { ops.push(`fillText:${txt}`); },
      setLineDash() {},
      createLinearGradient() { return gradStub; },
      createRadialGradient() { return gradStub; }
    };
  };

  const sampleCards = Object.freeze([
    makeFrozenCard({ id: 'm1', due_date: NOW - 9000, stability: 28 }),
    makeFrozenCard({ id: 'm2', due_date: NOW - 8000, stability: 12 }),
    makeFrozenCard({ id: 'm3', due_date: NOW - 7000, stability: 3 }),
    makeFrozenCard({ id: 'm4', due_date: NOW - 6000, stability: 0 })
  ]);
  const activeGraph = buildChamberGraph({
    deckId: 'deck-render',
    cards: sampleCards,
    clearedCardIds: ['m1'],
    nowMs: NOW,
    dayKey: DAY_KEY
  });

  for (const theme of ['light', 'dark']) {
    const ctx = makeMockCtx();
    const stats = drawMindMazeFrame(ctx, activeGraph, { width: 960, height: 640 }, { theme, nowMs: NOW });
    assert.equal(stats.renderedNodes, 4);
    assert.ok(stats.renderedEdges >= 3);
    assert.equal(stats.statusCounts.CLEARED, 1);
    assert.ok(stats.statusCounts.FRONTIER >= 1);
    assert.ok(stats.statusCounts.FOGGED >= 1);
    assert.ok(ctx.ops.includes('fillText:✓'), 'Cleared node must render ✓ crest');
    assert.ok(ctx.ops.includes('fillText:?'), 'Fogged node must render ? shroud');
  }

  // SANCTUARY & EMPTY_DECK must render cleanly without throwing
  const sanctuaryGraph = buildChamberGraph({
    deckId: 'deck-sanc',
    cards: [makeFrozenCard({ id: 's1', due_date: NOW + 999999 })],
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  const emptyGraph = buildChamberGraph({
    deckId: 'deck-emp',
    cards: [],
    nowMs: NOW,
    dayKey: DAY_KEY
  });
  assert.equal(drawMindMazeFrame(makeMockCtx(), sanctuaryGraph, { width: 800, height: 500 }, { theme: 'dark' }).renderedNodes, 0);
  assert.equal(drawMindMazeFrame(makeMockCtx(), emptyGraph, { width: 800, height: 500 }, { theme: 'light' }).renderedNodes, 0);
  console.log('  ok - ACTIVE (CLEARED/FRONTIER/FOGGED), SANCTUARY, and EMPTY_DECK paint cleanly in Light & Dark');
}

console.log('=== 7. Phase 3 Gate Outcome Resolver (applyMazeGateGrade: unlock, soft-fail, full clear, zero FSRS writes) ===');
{
  const cards = Object.freeze([
    makeFrozenCard({ id: 'g1', due_date: NOW - 3000, stability: 10 }),
    makeFrozenCard({ id: 'g2', due_date: NOW - 2000, stability: 15 }),
    makeFrozenCard({ id: 'g3', due_date: NOW - 1000, stability: 20 })
  ]);
  const cardsSnapshot = JSON.stringify(cards);

  const g = buildChamberGraph({
    deckId: 'deck-gate-p3',
    cards,
    nowMs: NOW,
    dayKey: DAY_KEY
  });

  // Entry node starts FRONTIER, others FOGGED
  assert.equal(g.nodes[0].status, 'FRONTIER');
  assert.equal(g.nodes[1].status, 'FOGGED');
  assert.equal(g.nodes[2].status, 'FOGGED');

  // 1. Soft-fail ('again' / 1) keeps node FRONTIER
  const failRes = applyMazeGateGrade(g, g.nodes[0].id, 'again');
  assert.equal(failRes.outcome, 'soft-fail');
  assert.equal(failRes.unlocked, false);
  assert.equal(g.nodes[0].status, 'FRONTIER', 'Soft-fail must keep chamber FRONTIER');
  assert.equal(g.nodes[1].status, 'FOGGED', 'Soft-fail must not unlock fogged successors');

  // 2. Unlock ('good' / 3) transitions entry node to CLEARED and promotes connected successor(s) to FRONTIER
  const unlock1 = applyMazeGateGrade(g, g.nodes[0].id, 'good');
  assert.equal(unlock1.outcome, 'unlocked');
  assert.equal(unlock1.unlocked, true);
  assert.equal(unlock1.allCleared, false);
  assert.equal(g.nodes[0].status, 'CLEARED');
  assert.ok(unlock1.newlyPromotedIds.length >= 1, 'Unlocking entry must promote at least one FOGGED successor');

  // 3. Clear remaining FRONTIER chambers using 'hard' and 'easy' until allCleared === true
  while (!g.nodes.every((n) => n.status === 'CLEARED')) {
    const nextFrontier = g.nodes.find((n) => n.status === 'FRONTIER');
    assert.ok(nextFrontier, 'Must always have a reachable FRONTIER chamber until all are cleared');
    applyMazeGateGrade(g, nextFrontier.id, 'easy');
  }

  assert.equal(g.status, 'SANCTUARY', 'Full clear transitions in-session status to SANCTUARY');
  assert.equal(JSON.stringify(cards), cardsSnapshot, 'Card FSRS records must remain 100% untouched');
  console.log('  ok - applyMazeGateGrade handles soft-fail, progressive unlock, and full-clear with zero FSRS mutation');
}

console.log('\nALL MINDMAZE PHASE 1, PHASE 2 & PHASE 3 CHECKS PASSED');


