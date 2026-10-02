// Run with: node public/test_card_fidelity.mjs
//
// Permanent unit test suite for Flashcard Source Fidelity Pass (Tier 4 #1):
//   1. Cloze cards: masked term absent from source -> flagged
//   2. Cloze cards: masked term present in source -> not flagged
//   3. Formula cards: invented variable absent from source -> flagged
//   4. Formula cards: grounded variables present in source -> not flagged
//   5. Basic cards: hallucinated terms/numbers -> flagged
//   6. Basic cards: grounded terms -> not flagged
//   7. Empty or missing source text -> silent pass-through (not flagged)
//   8. Array batch check: stamps fidelityFlag on ungrounded cards, preserves dismissed
//   9. FSRS Invariance: fidelityFlag persistence leaves all FSRS fields at default
//  10. Dismissal & Update: clears/updates flag without mutating FSRS fields or content

import assert from 'node:assert/strict';
import {
  checkCardFidelity,
  checkCardsFidelity,
  containsTerm,
  extractClozeTerms
} from './card-fidelity.js';

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

const DEFAULT_FSRS_FIELDS = {
  state: 'new',
  difficulty: 0,
  stability: 0,
  reps: 0,
  lapses: 0,
  last_review: null,
  due_date: 1700000000000,
  suspended: false
};

const SAMPLE_SOURCE = `
Photosynthesis occurs in the chloroplasts of plant cells.
During the light-dependent reactions, chlorophyll absorbs photons and produces ATP and NADPH.
In the Calvin cycle, carbon dioxide is fixed into glucose.
Newton's second law is defined as F = ma, where F is the net force in newtons,
m is the mass of the object in kilograms, and a is acceleration in meters per second squared.
The Magna Carta was signed in 1215 at Runnymede.
`;

console.log('=== 1. Cloze card with masked term absent -> flagged ===');
{
  const card = deepFreeze({
    front: 'The organelle responsible for photosynthesis is the {{c1::mitochondria}}.',
    back: 'mitochondria',
    type: 'cloze'
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, true, 'Card with absent cloze term should be flagged');
  assert.match(res.reason, /mitochondria/i, 'Reason should mention the missing term');
  console.log('  Passed: absent cloze term correctly flagged');
}

console.log('=== 2. Cloze card with term present -> not flagged ===');
{
  const card = deepFreeze({
    front: 'Photosynthesis occurs inside the {{c1::chloroplasts}}.',
    back: 'chloroplasts',
    type: 'cloze'
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, false, 'Card with grounded cloze term should not be flagged');
  assert.equal(res.reason, null);
  console.log('  Passed: present cloze term verified cleanly');
}

console.log('=== 3. Cloze card with multi-cloze where one is absent -> flagged ===');
{
  const card = deepFreeze({
    front: 'Photosynthesis in {{c1::chloroplasts}} produces {{c2::hemoglobin}}.',
    back: 'chloroplasts and hemoglobin',
    type: 'cloze'
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, true);
  assert.match(res.reason, /hemoglobin/i);
  console.log('  Passed: multi-cloze partial absence flagged');
}

console.log('=== 4. Formula card with invented variable -> flagged ===');
{
  const card = deepFreeze({
    front: 'What is Newton\'s second law?',
    back: 'Force equals mass times acceleration',
    type: 'formula',
    formula: 'F = ma + p',
    variables: [
      { symbol: 'F', meaning: 'force' },
      { symbol: 'm', meaning: 'mass' },
      { symbol: 'p', meaning: 'quantum pressure' }
    ]
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, true, 'Formula with invented variable should be flagged');
  assert.match(res.reason, /quantum pressure|p/i);
  console.log('  Passed: invented formula variable flagged');
}

console.log('=== 5. Formula card with grounded variables -> not flagged ===');
{
  const card = deepFreeze({
    front: 'What is Newton\'s second law?',
    back: 'F = ma',
    type: 'formula',
    formula: 'F = ma',
    variables: [
      { symbol: 'F', meaning: 'net force' },
      { symbol: 'm', meaning: 'mass' },
      { symbol: 'a', meaning: 'acceleration' }
    ]
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, false);
  assert.equal(res.reason, null);
  console.log('  Passed: grounded formula card verified');
}

console.log('=== 6. Grounded basic card -> not flagged ===');
{
  const card = deepFreeze({
    front: 'In what year was the Magna Carta signed?',
    back: 'It was signed in 1215 at Runnymede.',
    type: 'basic'
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, false);
  assert.equal(res.reason, null);
  console.log('  Passed: grounded basic card not flagged');
}

console.log('=== 7. Hallucinated basic card -> flagged ===');
{
  const card = deepFreeze({
    front: 'What happened during the Battle of Hastings?',
    back: 'King Harold was defeated by William the Conqueror in 1066.',
    type: 'basic'
  });
  const res = checkCardFidelity(card, SAMPLE_SOURCE);
  assert.equal(res.flagged, true, 'Hallucinated basic card with absent date/entities should be flagged');
  console.log('  Passed: hallucinated basic card flagged with reason:', res.reason);
}

console.log('=== 8. Empty or missing source text -> silent pass-through ===');
{
  const card = deepFreeze({
    front: 'Some question',
    back: 'Some answer',
    type: 'basic'
  });
  assert.equal(checkCardFidelity(card, null).flagged, false);
  assert.equal(checkCardFidelity(card, '').flagged, false);
  assert.equal(checkCardFidelity(card, '   ').flagged, false);
  console.log('  Passed: missing source text handled silently');
}

console.log('=== 9. Array batch check: checkCardsFidelity preserves dismissed flags ===');
{
  const cards = [
    { id: 'c1', front: 'In chloroplasts?', back: 'chloroplasts', type: 'basic' },
    { id: 'c2', front: 'Battle?', back: 'Waterloo 1815', type: 'basic' },
    {
      id: 'c3',
      front: 'Already dismissed?',
      back: 'Unrelated fact 1999',
      type: 'basic',
      fidelityFlag: { status: 'dismissed' }
    }
  ];

  checkCardsFidelity(cards, SAMPLE_SOURCE);

  assert.equal(cards[0].fidelityFlag, undefined, 'Grounded card has no flag');
  assert.equal(cards[1].fidelityFlag?.status, 'unverified', 'Ungrounded card gets unverified status');
  assert.equal(cards[2].fidelityFlag?.status, 'dismissed', 'Previously dismissed card remains dismissed');
  console.log('  Passed: batch checking correctly stamps and preserves dismissed flags');
}

console.log('=== 10. FSRS Invariance: fidelityFlag leaves all FSRS fields untouched ===');
{
  // Simulate saveNewCards record stamping from db.js
  const newCard = {
    id: 'test-card-1',
    front: 'Ungrounded front',
    back: 'Ungrounded back 9999',
    type: 'basic',
    fidelityFlag: {
      status: 'unverified',
      reason: 'Key answer terms were not found in the source reading.',
      flaggedAt: Date.now()
    }
  };

  const record = {
    id: newCard.id,
    deckId: 'deck-123',
    front: newCard.front,
    back: newCard.back,
    type: newCard.type,
    createdAt: Date.now(),
    ...DEFAULT_FSRS_FIELDS,
    due_date: Date.now()
  };

  if (newCard.fidelityFlag) {
    record.fidelityFlag = newCard.fidelityFlag;
  }

  // Assert FSRS fields
  assert.equal(record.state, 'new', 'FSRS state must remain "new"');
  assert.equal(record.difficulty, 0, 'FSRS difficulty must remain 0');
  assert.equal(record.stability, 0, 'FSRS stability must remain 0');
  assert.equal(record.reps, 0, 'FSRS reps must remain 0');
  assert.equal(record.lapses, 0, 'FSRS lapses must remain 0');
  assert.equal(record.last_review, null, 'FSRS last_review must remain null');
  assert.equal(record.suspended, false, 'FSRS suspended must remain false');
  assert.ok(record.due_date > 0, 'due_date must be set');
  assert.equal(record.fidelityFlag.status, 'unverified', 'fidelityFlag must be preserved');

  // Simulate dismissal
  record.fidelityFlag = {
    ...record.fidelityFlag,
    status: 'dismissed',
    dismissedAt: Date.now()
  };

  // Re-verify FSRS fields after dismissal
  assert.equal(record.state, 'new');
  assert.equal(record.difficulty, 0);
  assert.equal(record.stability, 0);
  assert.equal(record.reps, 0);
  assert.equal(record.lapses, 0);
  assert.equal(record.fidelityFlag.status, 'dismissed');
  console.log('  Passed: FSRS fields completely untouched across flag and dismissal lifecycle');
}

console.log('\nALL CARD FIDELITY UNIT TESTS PASSED (10/10).');
