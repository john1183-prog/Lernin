// fsrs-fit.js
// Pure, client-side FSRS initial stability calibration (w0..w3)
// Fits personalized first-review stabilities from the user's local reviewLog
// without mutating review history, without cloud dependencies, and without
// modifying deeper transition dynamics (w4..w20 remain population defaults).

import { default_w, clipParameters } from './vendor/ts-fsrs.js';

export const MIN_REVIEWS_THRESHOLD = 300;
export const MIN_OBSERVATIONS_THRESHOLD = 20;
export const MIN_LOSS_DELTA = 0.001; // Minimum cross-entropy log-loss improvement required

const GRADE_TO_RATING = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4
};

// FSRS-6 forgetting curve constants for decay = default_w[20] (0.1542)
const FSRS6_DECAY = default_w[20] || 0.1542;
const DECAY_EXP = -FSRS6_DECAY;
const DECAY_FACTOR = Math.exp(Math.pow(DECAY_EXP, -1) * Math.log(0.9)) - 1;

/**
 * Predicts retrieval probability R for elapsed days and stability S
 * R = (1 + factor * t / S)^decay
 */
export function predictRecall(elapsedDays, stability) {
  const s = Math.max(0.001, stability);
  const t = Math.max(0.001, elapsedDays);
  const r = Math.pow(1 + DECAY_FACTOR * (t / s), DECAY_EXP);
  return Math.max(1e-5, Math.min(1 - 1e-5, r));
}

/**
 * Computes binary cross-entropy log-loss for a set of observations given stability weights.
 * observations: Array of { gradeIdx, elapsedDays, success }
 */
export function computeTotalLoss(weights, observations) {
  if (!observations || observations.length === 0) return 0;
  let totalCe = 0;
  for (const obs of observations) {
    const s0 = weights[obs.gradeIdx];
    const p = predictRecall(obs.elapsedDays, s0);
    const ce = -(obs.success * Math.log(p) + (1 - obs.success) * Math.log(1 - p));
    totalCe += ce;
  }
  return totalCe / observations.length;
}

/**
 * 1D Golden-Section Search for unimodal/convex objective functions on [a, b].
 */
function goldenSectionSearch(fn, a, b, tol = 1e-4, maxIter = 40) {
  const phi = 0.618033988749895;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = fn(c);
  let fd = fn(d);

  for (let i = 0; i < maxIter && (b - a) > tol; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = fn(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = fn(d);
    }
  }
  return (a + b) / 2;
}

/**
 * Extracts first-to-second review transitions from reviewLog rows.
 * Guarantees zero mutation of input arrays.
 *
 * @param {Array<object>} reviewLogs - Array of { cardId, grade, reviewedAt, elapsedDays }
 * @returns {Array<object>} observations - Array of { gradeIdx, elapsedDays, success }
 */
export function extractFirstTransitions(reviewLogs) {
  if (!Array.isArray(reviewLogs) || reviewLogs.length === 0) return [];

  // Group by cardId without mutating input objects
  const byCard = new Map();
  for (const entry of reviewLogs) {
    if (!entry || !entry.cardId || !entry.grade) continue;
    let list = byCard.get(entry.cardId);
    if (!list) {
      list = [];
      byCard.set(entry.cardId, list);
    }
    list.push({
      cardId: entry.cardId,
      grade: entry.grade,
      reviewedAt: entry.reviewedAt || 0,
      elapsedDays: entry.elapsedDays
    });
  }

  const observations = [];
  for (const [, cardLogs] of byCard) {
    if (cardLogs.length < 2) continue;
    // Chronological order
    cardLogs.sort((a, b) => a.reviewedAt - b.reviewedAt);

    const r0 = cardLogs[0];
    const r1 = cardLogs[1];
    const rating0 = GRADE_TO_RATING[r0.grade];
    if (!rating0) continue;

    const gradeIdx = rating0 - 1; // 0..3 for Again/Hard/Good/Easy
    let elapsed = typeof r1.elapsedDays === 'number' && r1.elapsedDays > 0
      ? r1.elapsedDays
      : (r1.reviewedAt - r0.reviewedAt) / 86400000;
    elapsed = Math.max(0.01, elapsed);

    const success = r1.grade !== 'again' ? 1 : 0;
    observations.push({ gradeIdx, elapsedDays: elapsed, success });
  }

  return observations;
}

/**
 * Fits personalized initial stabilities w0..w3 from local review history.
 *
 * @param {Array<object>} reviewLogs - Raw reviewLog array from IndexedDB
 * @param {object} [opts] - Fitting options
 * @param {number} [opts.minReviews] - Minimum total reviews required (default 300)
 * @param {number} [opts.minObservations] - Minimum first-interval observations required (default 20)
 * @param {number} [opts.minLossDelta] - Minimum log-loss improvement over default_w required (default 0.001)
 * @param {number} [opts.regularizationLambda] - L2 regularization prior to default_w (default 0.04)
 * @returns {object} Fitting outcome
 */
export function fitInitialStabilities(reviewLogs, opts = {}) {
  const minReviews = opts.minReviews ?? MIN_REVIEWS_THRESHOLD;
  const minObservations = opts.minObservations ?? MIN_OBSERVATIONS_THRESHOLD;
  const minLossDelta = opts.minLossDelta ?? MIN_LOSS_DELTA;
  const lambda = opts.regularizationLambda ?? 0.04;

  const totalReviews = Array.isArray(reviewLogs) ? reviewLogs.length : 0;
  if (totalReviews < minReviews) {
    return {
      ok: false,
      reason: 'insufficient_reviews',
      reviewCount: totalReviews,
      minRequired: minReviews
    };
  }

  const observations = extractFirstTransitions(reviewLogs);
  if (observations.length < minObservations) {
    return {
      ok: false,
      reason: 'insufficient_transitions',
      reviewCount: totalReviews,
      observationCount: observations.length,
      minRequired: minObservations
    };
  }

  // Baseline loss under standard default weights
  const baselineLoss = computeTotalLoss(default_w, observations);

  // Group observations by initial grade cohort (0: Again, 1: Hard, 2: Good, 3: Easy)
  const cohorts = [[], [], [], []];
  for (const obs of observations) {
    if (obs.gradeIdx >= 0 && obs.gradeIdx <= 3) {
      cohorts[obs.gradeIdx].push(obs);
    }
  }

  const fittedW0_3 = [...default_w.slice(0, 4)];

  // Optimize each cohort independently using golden-section search
  for (let g = 0; g < 4; g++) {
    const cohort = cohorts[g];
    // If cohort is very sparse, retain population default with mild shrinkage
    if (cohort.length < 3) continue;

    const defVal = default_w[g];
    const lossFn = (wVal) => {
      let sumCe = 0;
      for (const obs of cohort) {
        const p = predictRecall(obs.elapsedDays, wVal);
        sumCe += -(obs.success * Math.log(p) + (1 - obs.success) * Math.log(1 - p));
      }
      const meanCe = sumCe / cohort.length;
      const relDiff = (wVal - defVal) / defVal;
      return meanCe + (lambda / 2) * (relDiff * relDiff);
    };

    // Bounds: [0.001, 100.0] matches CLAMP_PARAMETERS INIT_S_MAX
    const bestW = goldenSectionSearch(lossFn, 0.001, 100.0);
    fittedW0_3[g] = bestW;
  }

  // Enforce monotonicity: S0(Again) <= S0(Hard) <= S0(Good) <= S0(Easy)
  fittedW0_3[0] = Math.max(0.001, Math.min(100.0, fittedW0_3[0]));
  fittedW0_3[1] = Math.max(fittedW0_3[0], Math.min(100.0, fittedW0_3[1]));
  fittedW0_3[2] = Math.max(fittedW0_3[1], Math.min(100.0, fittedW0_3[2]));
  fittedW0_3[3] = Math.max(fittedW0_3[2], Math.min(100.0, fittedW0_3[3]));

  // Assemble full 21-element candidate parameter array
  const candidateWeights = [
    ...fittedW0_3,
    ...default_w.slice(4)
  ];

  // Legal parameter bounds clipping via ts-fsrs helper
  const clippedWeights = clipParameters(candidateWeights, 0, true);

  // Evaluate candidate log-loss across all observations
  const fittedLoss = computeTotalLoss(clippedWeights, observations);

  // Verify that personalized weights actually improve upon population defaults
  if (fittedLoss > baselineLoss - minLossDelta) {
    return {
      ok: false,
      reason: 'no_improvement',
      reviewCount: totalReviews,
      observationCount: observations.length,
      baselineLoss,
      fittedLoss,
      delta: baselineLoss - fittedLoss
    };
  }

  const improvementPct = ((baselineLoss - fittedLoss) / baselineLoss) * 100;

  return {
    ok: true,
    weights: clippedWeights,
    w0_w3: [clippedWeights[0], clippedWeights[1], clippedWeights[2], clippedWeights[3]],
    reviewCount: totalReviews,
    observationCount: observations.length,
    baselineLoss,
    fittedLoss,
    improvementPct,
    fittedAt: Date.now()
  };
}
