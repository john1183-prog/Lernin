// study-session-core.js
// Shared study session engine core for Lernin.
// Unifies queue preparation (soft caps, interleaving, prerequisite ordering),
// interval formatting, grading & persistence contract (with milestone signals),
// and session summary calculations across classic and spatial study.
//
// ZERO dependencies on app.js to preserve module hierarchy invariants.

import {
  getCardsDueTodayOrEarlier,
  getCardsDueForDeck,
  getCard,
  updateCardAfterReview,
  removeLastReviewLogForCard,
  getRelationshipsFrom,
  getSetting,
  DEFAULT_DAILY_REVIEW_CAP,
  DEFAULT_NEW_CARD_CAP
} from './db.js';
import { gradeCard, previewIntervals, Grade } from './scheduler.js';

export { Grade };

export const GRADE_MAP = {
  '1': 'again',
  '2': 'hard',
  '3': 'good',
  '4': 'easy'
};

/** Map UI grade strings to ts-fsrs Rating numbers. */
export const GRADE_TO_RATING = {
  again: Grade.AGAIN,
  hard: Grade.HARD,
  good: Grade.GOOD,
  easy: Grade.EASY
};

/**
 * Converts a grade string ('again'|'hard'|'good'|'easy') to ts-fsrs Grade number.
 * @param {string} grade
 * @returns {number}
 */
export function toRating(grade) {
  const r = GRADE_TO_RATING[grade?.toLowerCase?.() ?? grade];
  if (r == null) throw new Error(`Unknown grade: ${grade}`);
  return r;
}

/**
 * Formats an interval in days into a human-friendly string ('<1m', '10m', '4h', '3d', '2mo').
 * @param {number} days
 * @returns {string}
 */
export function formatInterval(days) {
  if (days == null || isNaN(days)) return '0d';
  if (days < 1 / 1440) return '<1m';
  if (days < 1 / 24) return `${Math.round(days * 1440)}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

/**
 * Convenience helper to preview intervals for all 4 ratings formatted for UI buttons.
 * @param {object} card
 * @returns {{ intervals: object, formatted: { again: string, hard: string, good: string, easy: string } }}
 */
export function previewCardIntervals(card) {
  const intervals = previewIntervals(card);
  return {
    intervals,
    formatted: {
      again: formatInterval(intervals.again),
      hard: formatInterval(intervals.hard),
      good: formatInterval(intervals.good),
      easy: formatInterval(intervals.easy)
    }
  };
}

/**
 * Interleave new and review cards with daily caps and overdue-first review ordering.
 *
 * @param {Array<object>} cards
 * @param {object} [opts]
 * @param {number} [opts.reviewCap]
 * @param {number} [opts.newCap]
 * @returns {Array<object>} Interleaved queue with capInfo annotations attached
 */
export function interleaveQueue(cards, { reviewCap = DEFAULT_DAILY_REVIEW_CAP, newCap = DEFAULT_NEW_CARD_CAP } = {}) {
  const allNews = cards.filter(c => c.state === 'new');
  const allReviews = cards.filter(c => c.state !== 'new');

  const news = allNews.slice(0, newCap);
  const reviews = allReviews
    .sort((a, b) => {
      const timeA = a.due_date ? new Date(a.due_date).getTime() : 0;
      const timeB = b.due_date ? new Date(b.due_date).getTime() : 0;
      return timeA - timeB; // most overdue first (due_date ASC)
    })
    .slice(0, reviewCap);

  const result = [];
  let n = 0, r = 0;
  while (n < news.length || r < reviews.length) {
    if (n < news.length) result.push(news[n++]);
    if (r < reviews.length) result.push(reviews[r++]);
  }

  result.totalNew = allNews.length;
  result.queuedNew = news.length;
  result.newTruncated = allNews.length > news.length;
  result.totalReviews = allReviews.length;
  result.queuedReviews = reviews.length;
  result.reviewsTruncated = allReviews.length > reviews.length;

  return result;
}

/**
 * Soft prerequisite-first reordering. For each card in the queue, pulls
 * its `dependsOn` prerequisites earlier if they're also in the queue
 * but currently positioned later — so a prerequisite gets reviewed (or
 * introduced) right before its dependent in the same session.
 *
 * Deliberately does NOT: exclude/block anything (a due review always
 * still appears — this only changes order), or pull in cards that
 * aren't already in the queue (a prerequisite in another deck, or one
 * that isn't due today, is simply left alone — this is what makes
 * cross-deck dependsOn safe without extra cross-deck logic). Suspended
 * prerequisites are treated as satisfied (skipped), since a leech
 * elsewhere shouldn't reorder an unrelated card.
 *
 * @param {Array<object>} queue
 * @returns {Promise<Array<object>>}
 */
export async function applyPrerequisiteOrdering(queue) {
  if (!Array.isArray(queue) || queue.length < 2) return queue;

  const idSet = new Set(queue.map(c => c.id));
  const prereqMap = new Map();

  for (const card of queue) {
    try {
      const rels = await getRelationshipsFrom(card.id);
      const prereqs = rels
        .filter(r => r.type === 'dependsOn' && r.cardId !== card.id && idSet.has(r.cardId))
        .map(r => r.cardId);
      if (prereqs.length) prereqMap.set(card.id, prereqs);
    } catch (err) {
      // Non-fatal — skip reordering for this card if lookup fails
    }
  }

  if (prereqMap.size === 0) return queue;

  const result = [...queue];
  // Preserve cap metadata on reordered array
  result.capInfo = queue.capInfo;
  result.totalNew = queue.totalNew;
  result.queuedNew = queue.queuedNew;
  result.newTruncated = queue.newTruncated;
  result.totalReviews = queue.totalReviews;
  result.queuedReviews = queue.queuedReviews;
  result.reviewsTruncated = queue.reviewsTruncated;

  const maxPasses = result.length * 3; // safety valve against cycles
  let passes = 0;
  let moved = true;

  while (moved && passes < maxPasses) {
    moved = false;
    passes++;
    for (let i = 0; i < result.length; i++) {
      const prereqs = prereqMap.get(result[i].id);
      if (!prereqs) continue;
      for (const prereqId of prereqs) {
        const pIdx = result.findIndex(c => c.id === prereqId);
        if (pIdx > i && !result[pIdx].suspended) {
          const [p] = result.splice(pIdx, 1);
          result.splice(i, 0, p);
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
  }

  return result;
}

/**
 * Prepares and normalizes a study session queue:
 * - Queries cards for deck or all due today
 * - Excludes suspended cards (including draft/unapproved cards)
 * - Prioritizes startCardId if specified
 * - Applies soft daily caps and interleaving
 * - Applies prerequisite soft-ordering (if smartOrdering is enabled)
 * - Returns the prepared queue with capInfo attached
 *
 * @param {object} [opts]
 * @param {string} [opts.deckId]
 * @param {Array<object>} [opts.cards] - Optional pre-filtered cards array
 * @param {string} [opts.startCardId] - Specific card ID to place at the start of study
 * @param {number} [opts.reviewCap]
 * @param {number} [opts.newCap]
 * @param {boolean} [opts.enableSmartOrdering=true]
 * @returns {Promise<Array<object>>}
 */
export async function prepareStudyQueue({
  deckId = null,
  cards = null,
  startCardId = null,
  reviewCap = null,
  newCap = null,
  enableSmartOrdering = true
} = {}) {
  const actualReviewCap = reviewCap ?? ((await getSetting('dailyReviewCap')) || DEFAULT_DAILY_REVIEW_CAP);
  const actualNewCap = newCap ?? DEFAULT_NEW_CARD_CAP;

  let rawCards;
  if (cards) {
    rawCards = [...cards];
  } else if (deckId) {
    rawCards = await getCardsDueForDeck(deckId);
  } else {
    rawCards = await getCardsDueTodayOrEarlier();
  }

  // Filter out suspended (including draft cards which have suspended: true)
  let activeCards = rawCards.filter(c => !c.suspended);

  // If a specific card was requested to study (e.g. from Territory Map L3 or Mind Map),
  // ensure it is present in activeCards even if not otherwise due today.
  if (startCardId) {
    const specificCard = await getCard(startCardId);
    if (specificCard && !specificCard.suspended && !activeCards.some(c => c.id === startCardId)) {
      activeCards.unshift(specificCard);
    }
  }

  if (activeCards.length === 0) {
    const emptyQueue = [];
    emptyQueue.capInfo = {
      totalNew: 0,
      queuedNew: 0,
      newTruncated: false,
      totalReviews: 0,
      queuedReviews: 0,
      reviewsTruncated: false
    };
    return emptyQueue;
  }

  let queue = interleaveQueue(activeCards, { reviewCap: actualReviewCap, newCap: actualNewCap });

  const capInfo = {
    totalNew: queue.totalNew ?? activeCards.filter(c => c.state === 'new').length,
    queuedNew: queue.queuedNew ?? queue.filter(c => c.state === 'new').length,
    newTruncated: queue.newTruncated ?? (activeCards.filter(c => c.state === 'new').length > queue.filter(c => c.state === 'new').length),
    totalReviews: queue.totalReviews ?? activeCards.filter(c => c.state !== 'new').length,
    queuedReviews: queue.queuedReviews ?? queue.filter(c => c.state !== 'new').length,
    reviewsTruncated: queue.reviewsTruncated ?? (activeCards.filter(c => c.state !== 'new').length > queue.filter(c => c.state !== 'new').length)
  };
  queue.capInfo = capInfo;

  if (enableSmartOrdering) {
    try {
      const smartOrderingSetting = await getSetting('smartOrderingEnabled');
      if (smartOrderingSetting !== false) {
        queue = await applyPrerequisiteOrdering(queue);
        queue.capInfo = capInfo;
      }
    } catch (err) {
      // Non-fatal
    }
  }

  // Rotate to startCardId if specified — guaranteed to be at front even if outside soft cap
  if (startCardId) {
    const idx = queue.findIndex(c => c.id === startCardId);
    if (idx > 0) {
      const [card] = queue.splice(idx, 1);
      queue.unshift(card);
    } else if (idx === -1) {
      const specificCard = await getCard(startCardId);
      if (specificCard && !specificCard.suspended) {
        queue.unshift(specificCard);
      }
    }
    queue.capInfo = capInfo;
  }

  return queue;
}

/**
 * Grades a card using scheduler.js (FSRS), persists the updated card state
 * and reviewLog entry to IndexedDB, applies the updates in-memory to the card,
 * and returns rich metadata including milestone signals for Teach-It.
 *
 * @param {object} params
 * @param {object} params.card - The card entity to grade (modified in-place)
 * @param {string|number} params.grade - Grade string ('again'|'hard'|'good'|'easy') or Rating number
 * @param {number} [params.now=Date.now()] - Timestamp of the review
 * @param {string|null} [params.teachingNote=null] - Optional teaching note
 * @returns {Promise<{
 *   card: object,
 *   grade: string,
 *   rating: number,
 *   fsrsUpdate: object,
 *   reviewLogEntry: object,
 *   leech: boolean,
 *   prevState: string,
 *   nextState: string,
 *   isGraduation: boolean,
 *   isRecovery: boolean
 * }>}
 */
export async function gradeAndPersistCard({
  card,
  grade,
  now = Date.now(),
  teachingNote = null
}) {
  if (!card) throw new Error('gradeAndPersistCard requires a card');

  let gradeStr;
  let rating;
  if (typeof grade === 'string') {
    gradeStr = grade.toLowerCase();
    rating = GRADE_TO_RATING[gradeStr];
    if (rating == null) throw new Error(`Unknown grade string: ${grade}`);
  } else if (typeof grade === 'number') {
    rating = grade;
    const entry = Object.entries(GRADE_TO_RATING).find(([_, r]) => r === rating);
    gradeStr = entry ? entry[0] : 'good';
  } else {
    throw new Error(`Invalid grade: ${grade}`);
  }

  const prevState = card.state;
  const lapses = card.lapses ?? 0;

  // Run FSRS scheduling
  const result = gradeCard(card, rating);
  const fsrsUpdate = result.fsrsUpdate;
  const reviewLogEntry = {
    grade: gradeStr,
    reviewedAt: result.reviewLogEntry?.reviewedAt ?? now,
    elapsedDays: result.reviewLogEntry?.elapsedDays ?? null,
    teachingNote: teachingNote ?? null
  };

  // Persist to DB
  await updateCardAfterReview(card.id, fsrsUpdate, reviewLogEntry);

  // Apply updates to in-memory card object
  Object.assign(card, fsrsUpdate);

  const nextState = fsrsUpdate.state;
  const isGraduation = (prevState === 'learning' || prevState === 'relearning') && nextState === 'review';
  const isRecovery = (typeof lapses === 'number' && lapses >= 2);

  return {
    card,
    grade: gradeStr,
    rating,
    fsrsUpdate,
    reviewLogEntry,
    leech: Boolean(result.leech),
    prevState,
    nextState,
    isGraduation,
    isRecovery
  };
}

/**
 * Reverses a card's last review state and deletes its last reviewLog entry.
 *
 * @param {object} cardSnapshot - Pre-grade snapshot of the card entity
 * @returns {Promise<void>}
 */
export async function undoGradeCard(cardSnapshot) {
  if (!cardSnapshot?.id) return;
  await updateCardAfterReview(cardSnapshot.id, {
    state: cardSnapshot.state,
    difficulty: cardSnapshot.difficulty,
    stability: cardSnapshot.stability,
    reps: cardSnapshot.reps,
    lapses: cardSnapshot.lapses,
    last_review: cardSnapshot.last_review,
    due_date: cardSnapshot.due_date,
    suspended: cardSnapshot.suspended ?? false,
    leech: cardSnapshot.leech ?? false
  }, null);

  await removeLastReviewLogForCard(cardSnapshot.id);
}

/**
 * Computes accuracy percentage and counters for a set of session grade results.
 *
 * @param {object} results - Map of grades { again, hard, good, easy }
 * @param {number} [startTime]
 * @param {number} [endTime]
 * @returns {{
 *   total: number,
 *   again: number,
 *   hard: number,
 *   good: number,
 *   easy: number,
 *   goodPlus: number,
 *   accuracy: number,
 *   durationMs: number|null
 * }}
 */
export function calculateSessionSummary(results = {}, startTime = null, endTime = null) {
  const again = results.again || 0;
  const hard = results.hard || 0;
  const good = results.good || 0;
  const easy = results.easy || 0;
  const total = again + hard + good + easy;
  const goodPlus = good + easy;
  const accuracy = total > 0 ? Math.round((goodPlus / total) * 100) : 0;
  const durationMs = (startTime && endTime) ? Math.max(0, endTime - startTime) : null;

  return {
    total,
    again,
    hard,
    good,
    easy,
    goodPlus,
    accuracy,
    durationMs
  };
}
