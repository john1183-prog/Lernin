// test_motion_card_extract.mjs — Permanent unit tests for Motion Studio -> SRS card extractor
import assert from 'node:assert/strict';
import { extractMotionRecallCards } from './motion-card-extract.js';

console.log('=== 1. Captions-only script -> valid basic recall card(s) ===');
{
  const script = {
    scene: { name: 'Capacitor Charging', duration: 10.0 },
    layers: [
      { type: 'caption', text: 'Current flows from the power source into the capacitor plates.' },
      { type: 'caption', text: 'Opposite charges accumulate, forming an electric field.' },
      { type: 'caption', text: 'As plate voltage reaches source voltage, current drops to zero.' }
    ]
  };

  const cards = extractMotionRecallCards(script, 'how a capacitor charges');
  assert.equal(cards.length, 2, 'Should extract 2 cards from multi-caption script');
  assert.equal(cards[0].type, 'basic');
  assert.ok(cards[0].front.includes('how a capacitor charges'));
  assert.ok(cards[0].back.includes('current drops to zero'));

  assert.equal(cards[1].type, 'basic');
  assert.ok(cards[1].front.includes('initiates'));
  assert.ok(cards[1].back.includes('Current flows'));

  // Ensure no FSRS or fidelity fields leaked
  for (const c of cards) {
    assert.equal(c.state, undefined);
    assert.equal(c.reps, undefined);
    assert.equal(c.fidelityFlag, undefined);
  }
  console.log('  ok - captions-only extracts valid process cards with clean fields');
}

console.log('=== 2. Formula layer present -> formula card path ===');
{
  const script = {
    scene: { name: 'Capacitor Formula', duration: 8.0 },
    layers: [
      { type: 'caption', text: 'Capacitance relates total charge to voltage.' },
      { type: 'formula', format: 'formula', text: '$$Q = C \\times V$$' }
    ]
  };

  const cards = extractMotionRecallCards(script, 'Capacitance');
  assert.equal(cards.length, 2, 'Should extract basic card + formula card');
  assert.equal(cards[0].type, 'basic');
  assert.ok(cards[0].back.includes('Capacitance relates'));

  assert.equal(cards[1].type, 'formula');
  assert.equal(cards[1].formula, 'Q = C \\times V');
  assert.equal(cards[1].back, 'Q = C \\times V');
  console.log('  ok - formula layer produces valid formula-type card');
}

console.log('=== 3. Emphasis layer matching caption -> cloze deletion card ===');
{
  const script = {
    scene: { name: 'Cellular Respiration', duration: 12.0 },
    layers: [
      { type: 'caption', text: 'Mitochondria produce ATP through oxidative phosphorylation in the inner membrane.' },
      { type: 'emphasis', text: 'oxidative phosphorylation' }
    ]
  };

  const cards = extractMotionRecallCards(script, 'ATP Synthesis');
  assert.ok(cards.length >= 1, 'Should extract at least 1 card');
  assert.equal(cards[0].type, 'cloze', 'Should synthesize cloze when emphasis matches caption');
  assert.ok(cards[0].front.includes('{{c1::oxidative phosphorylation}}'));
  assert.equal(cards[0].back, 'oxidative phosphorylation');
  console.log('  ok - emphasis matching caption produces clean cloze card');
}

console.log('=== 4. Sparse and empty scripts -> safe fallback or empty, never throws ===');
{
  // Null / undefined script
  assert.deepEqual(extractMotionRecallCards(null, ''), []);
  assert.deepEqual(extractMotionRecallCards(undefined, ''), []);
  assert.deepEqual(extractMotionRecallCards({}, ''), []);

  // Script with only topic
  const cardsTopicOnly = extractMotionRecallCards({}, 'Kinematics');
  assert.equal(cardsTopicOnly.length, 1);
  assert.equal(cardsTopicOnly[0].type, 'basic');
  assert.ok(cardsTopicOnly[0].front.includes('Kinematics'));

  // Script with empty layers array
  const emptyLayers = extractMotionRecallCards({ layers: [] }, 'Quantum Tunneling');
  assert.equal(emptyLayers.length, 1);
  assert.ok(emptyLayers[0].front.includes('Quantum Tunneling'));

  // Corrupted layers array with nulls
  const corrupted = extractMotionRecallCards({ layers: [null, undefined, { type: 'rect' }, { text: '' }] }, 'Entropy');
  assert.equal(corrupted.length, 1);
  assert.ok(corrupted[0].front.includes('Entropy'));

  console.log('  ok - handles null, undefined, empty, and corrupted layers safely');
}

console.log('=== 5. Non-mutation of input script object (Object.freeze guarantee) ===');
{
  const frozenScript = Object.freeze({
    scene: Object.freeze({ name: 'Frozen Scene', duration: 5.0 }),
    layers: Object.freeze([
      Object.freeze({ type: 'caption', text: 'Static charge remains at rest on an insulator.' }),
      Object.freeze({ type: 'emphasis', text: 'insulator' }),
      Object.freeze({ type: 'formula', format: 'formula', text: 'F = k \\frac{q_1 q_2}{r^2}' })
    ])
  });

  let cards = null;
  assert.doesNotThrow(() => {
    cards = extractMotionRecallCards(frozenScript, 'Electrostatics');
  }, 'Must not throw when operating on deep-frozen script');

  assert.equal(cards.length, 2);
  console.log('  ok - frozen script object is strictly non-mutated');
}

console.log('=== 6. Strict ceiling: never more than 2 cards ===');
{
  const complexScript = {
    scene: { name: 'Full Explainer', duration: 25.0 },
    layers: [
      { type: 'caption', text: 'Step 1: First phase happens.' },
      { type: 'caption', text: 'Step 2: Second phase happens.' },
      { type: 'caption', text: 'Step 3: Third phase concludes.' },
      { type: 'emphasis', text: 'First phase' },
      { type: 'emphasis', text: 'Second phase' },
      { type: 'emphasis', text: 'Third phase' },
      { type: 'formula', format: 'formula', text: 'A = B + C' },
      { type: 'formula', format: 'formula', text: 'D = E + F' }
    ]
  };

  const cards = extractMotionRecallCards(complexScript, 'Complex Topic', { maxCards: 10 });
  assert.ok(cards.length <= 2, `Expected at most 2 cards, got ${cards.length}`);
  console.log('  ok - hard cap of 2 cards strictly enforced');
}

console.log('\nALL MOTION CARD EXTRACT UNIT TESTS PASSED (6/6).');
