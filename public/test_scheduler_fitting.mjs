// test_scheduler_fitting.mjs
// Permanent unit tests for Tier 4 #2: FSRS initial stability calibration (w0..w3)
// Run with: node public/test_scheduler_fitting.mjs

import assert from 'node:assert/strict';
import { default_w, CLAMP_PARAMETERS } from './vendor/ts-fsrs.js';
import {
  MIN_REVIEWS_THRESHOLD,
  predictRecall,
  computeTotalLoss,
  extractFirstTransitions,
  fitInitialStabilities
} from './fsrs-fit.js';
import {
  setSchedulerWeights,
  getActiveWeights,
  gradeCard,
  newCardDefaults
} from './scheduler.js';

console.log('=== 1. Under-threshold review count (< 300) rejects fitting safely ===');
{
  const sparseLogs = [
    { cardId: 'c1', grade: 'good', reviewedAt: 1000, elapsedDays: null },
    { cardId: 'c1', grade: 'good', reviewedAt: 86400000 + 1000, elapsedDays: 1 }
  ];

  const res = fitInitialStabilities(sparseLogs);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'insufficient_reviews');
  assert.equal(res.reviewCount, 2);
  assert.equal(res.minRequired, 300);
  console.log('  ok - rejects < 300 reviews without fitting or throwing');
}

console.log('=== 2. Synthetic fixture (>= 300 reviews) produces deterministic w0..w3 within legal bounds ===');
{
  // Generate a reproducible synthetic review log with 350 reviews across 120 cards
  // Learners with high retention on first review: initial stability should calibrate higher than defaults
  const syntheticLogs = [];
  const baseTime = 1700000000000;
  const numCards = 120;

  for (let c = 0; c < numCards; c++) {
    const cardId = `card-synth-${c}`;
    const t0 = baseTime + c * 3600000;
    // Initial ratings distributed: 10% Again, 20% Hard, 50% Good, 20% Easy
    let grade0 = 'good';
    if (c % 10 === 0) grade0 = 'again';
    else if (c % 5 === 0) grade0 = 'hard';
    else if (c % 5 === 4) grade0 = 'easy';

    syntheticLogs.push({
      cardId,
      grade: grade0,
      reviewedAt: t0,
      elapsedDays: null
    });

    // Review 1 (second encounter): 3 days later for Good/Easy, 1 day later for Again/Hard
    const intervalDays = (grade0 === 'good' || grade0 === 'easy') ? 4.0 : 1.2;
    const t1 = t0 + Math.round(intervalDays * 86400000);
    // Strong learner: 92% success rate on 2nd review
    const grade1 = (c % 12 === 0) ? 'again' : 'good';
    syntheticLogs.push({
      cardId,
      grade: grade1,
      reviewedAt: t1,
      elapsedDays: intervalDays
    });

    // Optional third review to simulate real usage
    if (c < 80) {
      const t2 = t1 + 7 * 86400000;
      syntheticLogs.push({
        cardId,
        grade: 'good',
        reviewedAt: t2,
        elapsedDays: 7.0
      });
    }
  }

  assert.equal(syntheticLogs.length >= 300, true);

  const res = fitInitialStabilities(syntheticLogs);
  assert.equal(res.ok, true, `Expected ok:true, got: ${JSON.stringify(res)}`);
  assert.equal(res.weights.length, 21);
  assert.equal(res.w0_w3.length, 4);

  // Check bounds: w0..w3 must be strictly within ts-fsrs parameter clamp bounds [0.001, 100]
  const clampBounds = CLAMP_PARAMETERS(2, true);
  for (let i = 0; i < 4; i++) {
    const [minB, maxB] = clampBounds[i];
    assert.equal(res.weights[i] >= minB, true, `w${i} ${res.weights[i]} < min ${minB}`);
    assert.equal(res.weights[i] <= maxB, true, `w${i} ${res.weights[i]} > max ${maxB}`);
  }

  // Check monotonicity: w0 <= w1 <= w2 <= w3
  assert.equal(res.weights[0] <= res.weights[1], true, 'w0 must be <= w1');
  assert.equal(res.weights[1] <= res.weights[2], true, 'w1 must be <= w2');
  assert.equal(res.weights[2] <= res.weights[3], true, 'w2 must be <= w3');

  // Remainder w4..w20 must exactly equal default_w
  for (let i = 4; i < 21; i++) {
    assert.equal(res.weights[i], default_w[i], `w${i} must match default_w[${i}]`);
  }

  // Improvement check
  assert.equal(res.fittedLoss < res.baselineLoss, true, 'fitted loss must improve upon baseline');
  assert.equal(typeof res.improvementPct, 'number');

  // Determinism check: running on the same fixture produces identical weights
  const res2 = fitInitialStabilities(syntheticLogs);
  assert.deepEqual(res.weights, res2.weights, 'Fitting must be strictly deterministic');
  console.log('  ok - synthetic fixture produces valid, monotonic, deterministic w0..w3 with default remainder');
}

console.log('=== 3. No-improvement fallback rejects worse or neutral candidates ===');
{
  // Construct a fixture where default_w already models the data perfectly or data is artificially inverted
  const neutralLogs = [];
  const baseTime = 1700000000000;
  for (let i = 0; i < 160; i++) {
    const cardId = `c-neut-${i}`;
    neutralLogs.push({ cardId, grade: 'good', reviewedAt: baseTime + i * 1000, elapsedDays: null });
    // Exactly matches default_w[2] = 2.3065 interval at 90% retention
    const success = (i % 10 !== 0) ? 'good' : 'again';
    neutralLogs.push({ cardId, grade: success, reviewedAt: baseTime + i * 1000 + 2.3065 * 86400000, elapsedDays: 2.3065 });
  }

  // Require an unrealistically high loss improvement (0.50 delta) to trigger the fallback
  const res = fitInitialStabilities(neutralLogs, { minLossDelta: 0.50 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_improvement');
  console.log('  ok - rejects fit and keeps defaults when threshold improvement is not achieved');
}

console.log('=== 4. Zero mutation of input reviewLog records (immutability guarantee) ===');
{
  const fixture = [
    Object.freeze({ cardId: 'c1', grade: 'good', reviewedAt: 1000, elapsedDays: null }),
    Object.freeze({ cardId: 'c1', grade: 'again', reviewedAt: 86400000, elapsedDays: 1.0 })
  ];

  // extractFirstTransitions must not throw on frozen objects
  const obs = extractFirstTransitions(fixture);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].gradeIdx, 2);
  assert.equal(obs[0].success, 0);

  // Large frozen array for fitInitialStabilities
  const frozenArray = [];
  for (let i = 0; i < 310; i++) {
    frozenArray.push(Object.freeze({
      cardId: `f-${Math.floor(i / 2)}`,
      grade: i % 2 === 0 ? 'good' : 'hard',
      reviewedAt: 100000 + i * 86400000,
      elapsedDays: i % 2 === 0 ? null : 1.0
    }));
  }
  Object.freeze(frozenArray);

  assert.doesNotThrow(() => {
    fitInitialStabilities(frozenArray);
  });
  console.log('  ok - reviewLog array and child entries remain strictly unmutated');
}

console.log('=== 5. Dynamic scheduler integration: gradeCard with custom weights alters intervals ===');
{
  const testCard = {
    id: 'test-card-fsrs-fit',
    deckId: 'd1',
    front: 'Question',
    back: 'Answer',
    state: 'new',
    difficulty: 0,
    stability: 0,
    reps: 0,
    lapses: 0,
    due_date: Date.now(),
    last_review: null,
    suspended: false
  };

  // Grade card under DEFAULT weights
  setSchedulerWeights(null);
  assert.equal(getActiveWeights(), null);
  const defResult = gradeCard(testCard, 3); // Grade.GOOD
  const defInterval = defResult.fsrsUpdate.due_date - Date.now();
  const defStability = defResult.fsrsUpdate.stability;

  // Grade card under FITTED weights with high initial stability (w2 = 6.5 instead of default 2.3065)
  const customW = [...default_w];
  customW[2] = 6.5; // High initial stability for Good
  setSchedulerWeights(customW);
  assert.deepEqual(getActiveWeights(), customW);

  const fitResult = gradeCard(testCard, 3);
  const fitInterval = fitResult.fsrsUpdate.due_date - Date.now();
  const fitStability = fitResult.fsrsUpdate.stability;

  // Personalized initial stability should be higher, resulting in a longer interval
  assert.equal(fitStability > defStability, true, `Expected fit stability ${fitStability} > default ${defStability}`);
  assert.equal(fitInterval > defInterval, true, `Expected fit interval ${fitInterval} > default ${defInterval}`);

  // Reverting to defaults restores default stability
  setSchedulerWeights(null);
  assert.equal(getActiveWeights(), null);
  const revertResult = gradeCard(testCard, 3);
  assert.equal(revertResult.fsrsUpdate.stability, defStability);
  console.log('  ok - setSchedulerWeights dynamically customizes gradeCard intervals and reverts cleanly');
}

console.log('\nALL FSRS SCHEDULER FITTING UNIT TESTS PASSED (5/5).');
