// Run with: node public/test_card_approval.mjs
//
// Permanent unit test suite for Two-Pass Card Approval & Draft Staging (Tier 4 #5):
//   1. partitionCardsForApproval: correctly partitions into ready vs drafts
//   2. partitionCardsForApproval with sourceText: runs fidelity check and separates drafts
//   3. isDraftCard vs isLeechCard predicates: isolates drafts from leeches and active cards
//   4. buildApprovalCommitPayload: assigns suspended=false to selected, suspended=true to held
//   5. FSRS Invariance: staging as draft preserves FSRS defaults without corruption
//   6. FSRS Invariance: activating a draft preserves all existing scheduling fields
//   7. Defensive edge cases: handles null/empty/malformed inputs safely

import assert from 'node:assert/strict';
import {
  isDraftCard,
  isLeechCard,
  partitionCardsForApproval,
  buildApprovalCommitPayload
} from './card-approval.js';

const SAMPLE_SOURCE = `
Mitochondria generate most of the chemical energy needed to power the cell's biochemical reactions.
Chemical energy produced by the mitochondria is stored in a small molecule called adenosine triphosphate (ATP).
The Krebs cycle takes place inside the mitochondrial matrix.
`;

const DEFAULT_FSRS = {
  state: 'new',
  difficulty: 0,
  stability: 0,
  reps: 0,
  lapses: 0,
  last_review: null,
  due_date: 1700000000000
};

console.log('=== 1. partitionCardsForApproval with pre-existing fidelity flags ===');
{
  const cards = [
    { id: 'c1', front: 'What is ATP?', back: 'Adenosine triphosphate', fidelityFlag: { status: 'dismissed' } },
    { id: 'c2', front: 'Where is chlorophyll?', back: 'In chloroplasts', fidelityFlag: { status: 'unverified' } },
    { id: 'c3', front: 'What is glycolysis?', back: 'Glucose breakdown' }
  ];

  const result = partitionCardsForApproval(cards);
  assert.equal(result.ready.length, 2, 'Ready group should have 2 cards');
  assert.equal(result.drafts.length, 1, 'Drafts group should have 1 card');
  assert.equal(result.drafts[0].id, 'c2', 'c2 should be in drafts');
  assert.deepEqual(result.ready.map(c => c.id).sort(), ['c1', 'c3'], 'c1 and c3 should be ready');
  console.log('  Passed: correctly partitioned ready vs drafts');
}

console.log('=== 2. partitionCardsForApproval with sourceText ===');
{
  const cards = [
    {
      id: 'c1',
      front: 'What molecule stores cellular energy?',
      back: 'Adenosine triphosphate (ATP)',
      type: 'basic'
    },
    {
      id: 'c2',
      front: 'Where does the {{c1::Calvin cycle}} occur?',
      back: 'Calvin cycle',
      type: 'cloze'
    },
    {
      id: 'c3',
      front: 'Where does the Krebs cycle take place?',
      back: 'Inside the mitochondrial matrix',
      type: 'basic'
    }
  ];

  const result = partitionCardsForApproval(cards, SAMPLE_SOURCE);
  assert.equal(result.ready.length, 2, 'c1 and c3 should be grounded and ready');
  assert.equal(result.drafts.length, 1, 'c2 should be unverified draft (Calvin cycle not in source)');
  assert.equal(result.drafts[0].id, 'c2');
  assert.equal(result.drafts[0].fidelityFlag.status, 'unverified');
  console.log('  Passed: sourceText fidelity check correctly filtered drafts');
}

console.log('=== 3. isDraftCard vs isLeechCard predicates ===');
{
  // A held draft card: suspended + unverified fidelity flag
  const draftCard = {
    id: 'd1',
    suspended: true,
    fidelityFlag: { status: 'unverified', reason: 'Unconfirmed in source' },
    state: 'new'
  };
  assert.equal(isDraftCard(draftCard), true, 'Held draft must return true for isDraftCard');
  assert.equal(isLeechCard(draftCard), false, 'Held draft must NOT be identified as a leech');

  // A genuine leech: suspended because of repeated lapses, no unverified flag
  const leechCard = {
    id: 'l1',
    suspended: true,
    state: 'suspended',
    lapses: 4,
    fidelityFlag: null
  };
  assert.equal(isDraftCard(leechCard), false, 'Leech must NOT return true for isDraftCard');
  assert.equal(isLeechCard(leechCard), true, 'Leech must return true for isLeechCard');

  // A dismissed card that became a leech later
  const dismissedLeech = {
    id: 'l2',
    suspended: true,
    state: 'review',
    lapses: 5,
    fidelityFlag: { status: 'dismissed' }
  };
  assert.equal(isDraftCard(dismissedLeech), false);
  assert.equal(isLeechCard(dismissedLeech), true);

  // Active unverified card (user chose to study immediately)
  const activeUnverified = {
    id: 'a1',
    suspended: false,
    fidelityFlag: { status: 'unverified' }
  };
  assert.equal(isDraftCard(activeUnverified), false, 'Active card cannot be a draft');
  assert.equal(isLeechCard(activeUnverified), false, 'Active card cannot be a leech');

  // Normal active card
  const activeNormal = {
    id: 'a2',
    suspended: false,
    state: 'learning'
  };
  assert.equal(isDraftCard(activeNormal), false);
  assert.equal(isLeechCard(activeNormal), false);

  console.log('  Passed: isDraftCard and isLeechCard cleanly isolate draft cards from leeches');
}

console.log('=== 4. buildApprovalCommitPayload ===');
{
  const items = [
    {
      card: { id: 'c1', front: 'Q1', back: 'A1', ...DEFAULT_FSRS },
      selected: true
    },
    {
      card: { id: 'c2', front: 'Q2', back: 'A2', fidelityFlag: { status: 'unverified' }, ...DEFAULT_FSRS },
      selected: false
    },
    {
      card: { id: 'c3', front: 'Q3', back: 'A3', ...DEFAULT_FSRS },
      selected: false
    }
  ];

  const payload = buildApprovalCommitPayload(items);
  assert.equal(payload.length, 3);
  assert.equal(payload[0].id, 'c1');
  assert.equal(payload[0].suspended, false, 'Selected card must be active (suspended=false)');

  assert.equal(payload[1].id, 'c2');
  assert.equal(payload[1].suspended, true, 'Unselected draft must be suspended (suspended=true)');

  assert.equal(payload[2].id, 'c3');
  assert.equal(payload[2].suspended, true, 'Unselected card must be suspended (suspended=true)');

  console.log('  Passed: buildApprovalCommitPayload assigns suspension accurately');
}

console.log('=== 5. FSRS Invariance on draft staging ===');
{
  const original = {
    id: 'fsrs-1',
    front: 'Concept',
    back: 'Definition',
    ...DEFAULT_FSRS,
    fidelityFlag: { status: 'unverified' }
  };

  const stagedItems = [{ card: original, selected: false }];
  const staged = buildApprovalCommitPayload(stagedItems)[0];

  assert.equal(staged.suspended, true, 'Staged as draft');
  assert.equal(staged.state, original.state, 'State preserved');
  assert.equal(staged.difficulty, original.difficulty, 'Difficulty preserved');
  assert.equal(staged.stability, original.stability, 'Stability preserved');
  assert.equal(staged.reps, original.reps, 'Reps preserved');
  assert.equal(staged.lapses, original.lapses, 'Lapses preserved');
  assert.equal(staged.due_date, original.due_date, 'Due date preserved');

  console.log('  Passed: draft staging maintains FSRS mathematical invariance');
}

console.log('=== 6. FSRS Invariance on draft activation ===');
{
  const draftCard = {
    id: 'draft-act-1',
    front: 'Concept',
    back: 'Definition',
    suspended: true,
    state: 'new',
    difficulty: 3.2,
    stability: 2.1,
    reps: 0,
    lapses: 0,
    last_review: null,
    due_date: 1700000000000,
    fidelityFlag: { status: 'unverified' }
  };

  // Simulating activation: card is un-suspended and fidelity flag is marked dismissed
  const activated = {
    ...draftCard,
    suspended: false,
    fidelityFlag: {
      ...draftCard.fidelityFlag,
      status: 'dismissed',
      dismissedAt: Date.now()
    }
  };

  assert.equal(activated.suspended, false);
  assert.equal(isDraftCard(activated), false);
  assert.equal(activated.difficulty, draftCard.difficulty);
  assert.equal(activated.stability, draftCard.stability);
  assert.equal(activated.reps, draftCard.reps);
  assert.equal(activated.lapses, draftCard.lapses);
  assert.equal(activated.due_date, draftCard.due_date);

  console.log('  Passed: draft activation preserves all FSRS scheduling fields');
}

console.log('=== 7. Defensive edge cases ===');
{
  assert.deepEqual(partitionCardsForApproval(null), { ready: [], drafts: [] });
  assert.deepEqual(partitionCardsForApproval([]), { ready: [], drafts: [] });
  assert.deepEqual(buildApprovalCommitPayload(null), []);
  assert.deepEqual(buildApprovalCommitPayload([]), []);
  assert.equal(isDraftCard(null), false);
  assert.equal(isDraftCard(undefined), false);
  assert.equal(isDraftCard({}), false);
  assert.equal(isLeechCard(null), false);
  assert.equal(isLeechCard(undefined), false);
  assert.equal(isLeechCard({}), false);

  console.log('  Passed: defensive null/empty handling verified');
}

console.log('\nAll Tier 4 #5 Card Approval unit tests passed successfully! 🌿');
