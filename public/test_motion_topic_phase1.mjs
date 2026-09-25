// Run with: node public/test_motion_topic_phase1.mjs
//
// Permanent unit test suite for Explain with Motion (Card Mind Map) — Phase 1 (`public/motion-topic.js`):
//   1. Formula card WITH variables (symbols + meanings synthesized into topic)
//   2. Formula card WITHOUT variables (front + formula, bare formula with/without deckTitle)
//   3. Cloze card: single `{{c1::term}}` and multi-cloze `{{c1::term1::hint}} ... {{c2::term2}}`
//   4. Basic card question stems ("What is...", "Define...", "How does...", "What is the difference between...")
//   5. Thin / referential fronts ("What happens in this reaction?", "ATP?", "In Figure 2...")
//   6. Empty front fallback (with deckTitle, with back snippet, and completely empty)
//   7. Zero mutation of input card records (verified with deep Object.freeze)

import assert from 'node:assert/strict';
import {
  resolveCardMotionTopic,
  stripQuizQuestionStem,
  parseClozeMarkup,
  cleanFormulaText,
  unmaskCardFrontForContext,
  buildCardMotionContextPack,
  composeCardMotionFinalTopic,
  MOTION_SOURCE_CARD_KEY,
  MAX_CONTEXT_PACK_CHARS
} from './motion-topic.js';

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// 1. Formula Card WITH Variables
// ---------------------------------------------------------------------------
console.log('=== 1. Formula card WITH variables ===');
{
  const card = deepFreeze({
    id: 'f-vars-1',
    type: 'formula',
    front: 'What is the Nernst Equilibrium Potential equation?',
    back: 'Gives the reversal potential of an ion across a membrane.',
    formula: '$$E_X = \\frac{RT}{zF} \\ln\\left(\\frac{[X]_o}{[X]_i}\\right)$$',
    variables: [
      { symbol: 'E_X', meaning: 'equilibrium potential' },
      { symbol: 'z', meaning: 'ion valence' },
      { symbol: 'F', meaning: 'Faraday constant' }
    ]
  });

  const res = resolveCardMotionTopic(card, 'Membrane Biophysics');
  assert.equal(res.sourceBranch, 'formula');
  assert.equal(res.isThin, false);
  assert.equal(res.thinReason, null);
  assert.ok(res.topic.includes('Nernst Equilibrium Potential equation'), 'Includes stripped front title');
  assert.ok(res.topic.includes('E_X (equilibrium potential)'), 'Includes variable symbol and meaning');
  assert.ok(res.topic.includes('z (ion valence)'), 'Includes second variable');
  assert.ok(!res.topic.includes('$$'), 'Strips outer LaTeX $$ delimiters');
  console.log('  ok - formula with variables synthesizes title, formula, and variable meanings');
}

// ---------------------------------------------------------------------------
// 2. Formula Card WITHOUT Variables
// ---------------------------------------------------------------------------
console.log('=== 2. Formula card WITHOUT variables ===');
{
  const cardWithFront = deepFreeze({
    id: 'f-novars-1',
    type: 'formula',
    front: 'Define the Henderson-Hasselbalch Equation',
    back: 'Relates pH, pKa, and conjugate acid/base ratio.',
    formula: 'pH = pKa + log([A-]/[HA])',
    variables: []
  });
  const res1 = resolveCardMotionTopic(cardWithFront, 'Acid-Base Chemistry');
  assert.equal(res1.sourceBranch, 'formula');
  assert.equal(res1.isThin, false);
  assert.equal(res1.topic, 'Henderson-Hasselbalch Equation (pH = pKa + log([A-]/[HA]))');

  const bareFormulaCard = deepFreeze({
    id: 'f-novars-2',
    type: 'formula',
    front: '',
    back: 'Ohm law',
    formula: 'V = I R'
  });
  const res2 = resolveCardMotionTopic(bareFormulaCard, 'Circuits 101');
  assert.equal(res2.sourceBranch, 'formula');
  assert.equal(res2.isThin, true);
  assert.equal(res2.thinReason, 'bare_formula_without_variables');
  assert.equal(res2.topic, 'Visualizing V = I R (Circuits 101)');
  console.log('  ok - formula without variables handles titled and bare formulas cleanly');
}

// ---------------------------------------------------------------------------
// 3. Single and Multi-Cloze Cards
// ---------------------------------------------------------------------------
console.log('=== 3. Single and Multi-Cloze cards ===');
{
  const singleCloze = deepFreeze({
    id: 'c-single',
    type: 'cloze',
    front: 'During glycolysis, {{c1::phosphofructokinase-1 (PFK-1)}} catalyzes the committed step converting fructose-6-phosphate to fructose-1,6-bisphosphate.'
  });
  const resSingle = resolveCardMotionTopic(singleCloze, 'Metabolism');
  assert.equal(resSingle.sourceBranch, 'cloze');
  assert.equal(resSingle.isThin, false);
  assert.ok(!resSingle.topic.includes('{{c1::'), 'Must strip all {{c1::...}} syntax');
  assert.ok(resSingle.topic.startsWith('phosphofructokinase-1 (PFK-1) — '), 'Starts with blanked term');
  assert.ok(resSingle.topic.includes('During glycolysis, phosphofructokinase-1 (PFK-1) catalyzes'), 'Contains full reconstructed sentence');

  const multiClozeWithHints = deepFreeze({
    id: 'c-multi',
    type: 'basic', // Even if card.type is 'basic', {{cN::}} markup triggers the cloze branch
    front: 'Action potentials depolarize via {{c1::voltage-gated Na+ channels::inbound channel}} and repolarize via {{c2::delayed-rectifier K+ channels::outbound channel}}.'
  });
  const resMulti = resolveCardMotionTopic(multiClozeWithHints, 'Neurophysiology');
  assert.equal(resMulti.sourceBranch, 'cloze');
  assert.equal(resMulti.isThin, false);
  assert.ok(!resMulti.topic.includes('{{c'), 'Must strip all cloze braces');
  assert.ok(!resMulti.topic.includes('inbound channel'), 'Must strip ::hint segments');
  assert.ok(
    resMulti.topic.startsWith('voltage-gated Na+ channels, delayed-rectifier K+ channels — '),
    'Lists both blanked terms before the reconstructed sentence'
  );
  console.log('  ok - single and multi-cloze cards strip {{cN::answer::hint}} and combine terms + sentence');
}

// ---------------------------------------------------------------------------
// 4. Basic Question Stems
// ---------------------------------------------------------------------------
console.log('=== 4. Basic question stems ===');
{
  const cases = [
    {
      front: 'What is the primary mechanism of oxidative phosphorylation in mitochondria?',
      expected: 'Mechanism of oxidative phosphorylation in mitochondria'
    },
    {
      front: 'What is the difference between competitive and allosteric enzyme inhibition?',
      expected: 'Difference between competitive and allosteric enzyme inhibition'
    },
    {
      front: 'How does the sodium-potassium pump maintain resting membrane potential?',
      expected: 'How the sodium-potassium pump maintain resting membrane potential'
    },
    {
      front: 'Define gravitational time dilation in general relativity ____?',
      expected: 'Gravitational time dilation in general relativity'
    }
  ];

  for (const c of cases) {
    const res = resolveCardMotionTopic(deepFreeze({ type: 'basic', front: c.front }), 'Physics & Bio');
    assert.equal(res.sourceBranch, 'basic');
    assert.equal(res.isThin, false);
    assert.equal(res.topic, c.expected);
  }
  console.log('  ok - basic question stems stripped while preserving semantic framing');
}

// ---------------------------------------------------------------------------
// 5. Thin and Referential Fronts
// ---------------------------------------------------------------------------
console.log('=== 5. Thin and referential fronts ===');
{
  const refCard = deepFreeze({
    id: 'thin-ref-1',
    type: 'basic',
    front: 'What happens to the rate of this reaction when temperature increases?'
  });
  const resRef = resolveCardMotionTopic(refCard, 'Chemical Kinetics');
  assert.equal(resRef.sourceBranch, 'basic');
  assert.equal(resRef.isThin, true);
  assert.equal(resRef.thinReason, 'referential_fragment');
  assert.ok(resRef.topic.includes('(Chemical Kinetics)'), 'Appends deckTitle when front is referential');

  const shortCard = deepFreeze({
    id: 'thin-short-1',
    type: 'basic',
    front: 'What is ATP?'
  });
  const resShort = resolveCardMotionTopic(shortCard, 'Cellular Bioenergetics');
  assert.equal(resShort.sourceBranch, 'basic');
  assert.equal(resShort.isThin, true);
  assert.equal(resShort.thinReason, 'too_short');
  assert.equal(resShort.topic, 'ATP (Cellular Bioenergetics)');

  const figCard = deepFreeze({
    id: 'thin-fig-1',
    type: 'basic',
    front: 'In Figure 2, which chamber experiences the highest systolic pressure?'
  });
  const resFig = resolveCardMotionTopic(figCard, 'Cardiac Cycle');
  assert.equal(resFig.isThin, true);
  assert.equal(resFig.thinReason, 'referential_fragment');
  console.log('  ok - referential and ultra-short fronts flagged with isThin + thinReason');
}

// ---------------------------------------------------------------------------
// 6. Empty Front Fallback
// ---------------------------------------------------------------------------
console.log('=== 6. Empty front fallback ===');
{
  const emptyWithDeckAndBack = deepFreeze({
    id: 'empty-1',
    type: 'basic',
    front: '   ',
    back: 'Countercurrent multiplication in the loop of Henle builds the medullary osmotic gradient.'
  });
  const res1 = resolveCardMotionTopic(emptyWithDeckAndBack, 'Renal Physiology');
  assert.equal(res1.sourceBranch, 'fallback');
  assert.equal(res1.isThin, true);
  assert.equal(res1.thinReason, 'empty_front');
  assert.ok(res1.topic.startsWith('Renal Physiology: Countercurrent multiplication'), 'Uses deckTitle + back snippet');

  const emptyWithDeckOnly = deepFreeze({
    id: 'empty-2',
    type: 'basic',
    front: '',
    back: ''
  });
  const res2 = resolveCardMotionTopic(emptyWithDeckOnly, 'Quantum Mechanics');
  assert.equal(res2.sourceBranch, 'fallback');
  assert.equal(res2.isThin, true);
  assert.equal(res2.thinReason, 'empty_front');
  assert.equal(res2.topic, 'Quantum Mechanics — core concept overview');

  const totallyEmpty = resolveCardMotionTopic(null, '');
  assert.equal(totallyEmpty.sourceBranch, 'fallback');
  assert.equal(totallyEmpty.isThin, true);
  assert.equal(totallyEmpty.thinReason, 'empty_front');
  assert.equal(totallyEmpty.topic, 'Core concept visual explainer');
  console.log('  ok - empty fronts fall back gracefully with isThin=true and thinReason="empty_front"');
}

// ---------------------------------------------------------------------------
// 7. Strict Card Immutability
// ---------------------------------------------------------------------------
console.log('=== 7. Zero mutation of input card ===');
{
  const rawCard = {
    id: 'immut-1',
    type: 'formula',
    front: 'What is {{c1::Snell Law}}?',
    back: 'Refraction law',
    formula: '$$n_1 \\sin\\theta_1 = n_2 \\sin\\theta_2$$',
    variables: [{ symbol: 'n_1', meaning: 'incident refractive index' }]
  };
  const beforeJson = JSON.stringify(rawCard);
  deepFreeze(rawCard);
  resolveCardMotionTopic(rawCard, 'Optics');
  assert.equal(JSON.stringify(rawCard), beforeJson, 'Input card must remain byte-for-byte unchanged');
  console.log('  ok - input card object is never mutated');
}

// ---------------------------------------------------------------------------
// 8. Phase 3: Bounded Context Pack & Final Topic Composer
// ---------------------------------------------------------------------------
console.log('=== 8. Phase 3: Bounded context pack & composeCardMotionFinalTopic ===');
{
  assert.equal(MOTION_SOURCE_CARD_KEY, 'lernin:motionStudioSourceCardId');
  assert.equal(MAX_CONTEXT_PACK_CHARS, 360);

  // When includeContext is false (default), exact editedTopic is returned with zero context appended
  const neighbors = deepFreeze([
    {
      id: 'n1',
      front: 'In {{c1::oxidative phosphorylation::pathway}}, {{c2::ATP synthase}} phosphorylates ADP.',
      back: 'SECRET BACK 1 MUST NEVER LEAK'
    },
    {
      id: 'n2',
      front: 'What is the role of the proton-motive force across the inner membrane?',
      back: 'SECRET BACK 2 MUST NEVER LEAK'
    },
    {
      id: 'n3',
      front: 'Define chemiosmotic coupling in mitochondria.',
      back: 'SECRET BACK 3 MUST NEVER LEAK'
    },
    {
      id: 'n4',
      front: 'Fourth neighbor that should be ignored because max is 3.',
      back: 'SECRET BACK 4 MUST NEVER LEAK'
    }
  ]);

  const offResult = composeCardMotionFinalTopic('Proton gradient across inner membrane', {
    includeContext: false,
    deckTitle: 'Cellular Bioenergetics',
    neighborCards: neighbors,
    docSummary: 'Detailed lecture notes on electron transport chain and ATP synthesis.'
  });
  assert.equal(
    offResult,
    'Proton gradient across inner membrane',
    'When includeContext is false, finalTopic must equal exact editedTopic'
  );

  // When includeContext is true with 3+ neighbors:
  // - Includes Deck: Cellular Bioenergetics
  // - Includes up to 3 neighbor fronts with cloze syntax unmasked
  // - Excludes 4th neighbor and excludes docSummary (since 3 neighbors are already present)
  // - Never includes any card back
  const onResult = composeCardMotionFinalTopic('Proton gradient across inner membrane', {
    includeContext: true,
    deckTitle: 'Cellular Bioenergetics',
    neighborCards: neighbors,
    docSummary: 'Detailed lecture notes on electron transport chain and ATP synthesis.'
  });
  assert.ok(onResult.startsWith('Proton gradient across inner membrane [Context — '), `Expected context suffix, got: ${onResult}`);
  assert.ok(onResult.includes('Deck: Cellular Bioenergetics'), 'Must include deck title');
  assert.ok(
    onResult.includes('In oxidative phosphorylation, ATP synthase phosphorylates ADP'),
    'Cloze syntax in neighbor front must be unmasked to plain text'
  );
  assert.ok(!onResult.includes('{{c'), 'Must not contain raw cloze markup');
  assert.ok(onResult.includes('Role of the proton-motive force'), 'Must include 2nd neighbor front');
  assert.ok(onResult.includes('Chemiosmotic coupling in mitochondria'), 'Must include 3rd neighbor front');
  assert.ok(!onResult.includes('Fourth neighbor'), 'Must cap connected neighbors at 3');
  assert.ok(!onResult.includes('Summary:'), 'Must omit docSummary when 3 neighbors are already available');
  assert.ok(!onResult.includes('SECRET BACK'), 'Must never include card backs');

  // Sparse neighbors (< 3) WITH docSummary -> includes concise Summary snippet and stays <= MAX_CONTEXT_PACK_CHARS
  const longDocSummary =
    'Cellular respiration couples exergonic electron transfer through Complexes I-IV with endergonic proton pumping across the cristae membrane, establishing an electrochemical gradient that drives F0F1-ATP synthase rotary catalysis.';
  const sparsePack = buildCardMotionContextPack({
    deckTitle: 'Cellular Bioenergetics',
    neighborCards: [neighbors[0]],
    docSummary: longDocSummary
  });
  assert.ok(sparsePack.length <= MAX_CONTEXT_PACK_CHARS, `Context pack must be <= ${MAX_CONTEXT_PACK_CHARS} chars (got ${sparsePack.length})`);
  assert.ok(sparsePack.includes('Deck: Cellular Bioenergetics'), 'Sparse pack must include deck title');
  assert.ok(sparsePack.includes('Summary:'), 'Sparse pack (< 3 neighbors) must include concise doc summary snippet');
  assert.ok(!sparsePack.includes('SECRET BACK'), 'Sparse pack must never include card backs');

  console.log('  ok - bounded context pack & composeCardMotionFinalTopic pass all assertions');
}

console.log('\nALL MOTION TOPIC PHASE 1 & PHASE 3 CHECKS PASSED');

