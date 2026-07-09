// scheduler.js
// Thin wrapper around ts-fsrs. Nothing outside this file should import
// 'ts-fsrs' directly — study.js calls gradeCard() and gets back a plain
// object shaped exactly for db.js's updateCardAfterReview().

import { fsrs, generatorParameters, createEmptyCard, Rating, State } from './vendor/ts-fsrs.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Default global FSRS weights. generatorParameters() with no overrides uses
// the library's shipped default parameter set (trained on a large aggregate
// dataset) — this is what every new user starts on.
//
// PER-USER OPTIMIZATION HOOK (not implemented for v1):
// ts-fsrs ships a companion optimizer (`@open-spaced-repetition/binding`, or
// the fsrs-rs trainer) that fits a personalized 19/21-weight set from a
// user's own reviewLog history. When that's built, swap this line for:
//   const params = generatorParameters({ w: userFittedWeights });
// stored per-user (e.g. in a `settings` object in db.js) rather than hardcoded.
// Nothing else in this file needs to change — gradeCard()'s signature is
// stable regardless of where the weights come from.
const params = generatorParameters({
  enable_fuzz: true,
  enable_short_term: true
});

const scheduler = fsrs(params);

// Leech threshold: total lifetime lapses (Rating.Again count) at which a
// card is flagged rather than left to loop indefinitely. Anki uses the same
// "total lapses," not "consecutive," definition — a card that's lapsed 4
// times over months is still a leech worth surfacing to the user.
const LEECH_LAPSE_THRESHOLD = 4;

// Grade constants exposed to study.js so it never has to import Rating
// directly or guess numeric values.
export const Grade = {
  AGAIN: Rating.Again,
  HARD: Rating.Hard,
  GOOD: Rating.Good,
  EASY: Rating.Easy
};

const GRADE_LABELS = {
  [Rating.Again]: 'again',
  [Rating.Hard]: 'hard',
  [Rating.Good]: 'good',
  [Rating.Easy]: 'easy'
};

// ---------------------------------------------------------------------------
// Card shape translation
// ts-fsrs works in Date objects and its own State enum. db.js stores
// epoch-ms numbers and the string states 'new'|'learning'|'review'|
// 'relearning' (see DEFAULT_FSRS_FIELDS in db.js) plus a separate
// `suspended` boolean for leech tracking — `state` never holds 'suspended'
// itself. These two small converters are the only place the state mapping
// lives.
// ---------------------------------------------------------------------------

const STATE_LABELS = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning'
};

// Suspension (leech state) is app-level metadata layered on top of ts-fsrs's
// own state machine — ts-fsrs's State enum has no "suspended" concept. It is
// tracked via a separate `suspended` boolean on the stored record (see
// DEFAULT_FSRS_FIELDS in db.js), NOT by overloading the FSRS `state` string.
// toStoredCard() therefore only ever writes the real underlying FSRS state
// here; gradeCard() is responsible for setting `suspended`/`leech` alongside
// it, and reverseState() below must be able to reconstruct that same
// underlying state regardless of whether the card is currently suspended.
function toStoredCard(fsrsCard) {
  return {
    state: STATE_LABELS[fsrsCard.state] ?? 'new',
    difficulty: fsrsCard.difficulty,
    stability: fsrsCard.stability,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    last_review: fsrsCard.last_review ? fsrsCard.last_review.getTime() : null,
    due_date: fsrsCard.due.getTime()
  };
}

function fromStoredCard(record) {
  // Reconstruct the minimal ts-fsrs Card shape from what db.js persisted.
  // createEmptyCard() gives us correct defaults for any fields ts-fsrs
  // needs internally that db.js doesn't track (e.g. elapsed_days,
  // scheduled_days get recomputed by repeat()/next() anyway).
  const base = createEmptyCard(record.last_review ? new Date(record.last_review) : new Date());
  return {
    ...base,
    due: new Date(record.due_date),
    stability: record.stability,
    difficulty: record.difficulty,
    reps: record.reps,
    lapses: record.lapses,
    state: reverseState(record.state),
    last_review: record.last_review ? new Date(record.last_review) : undefined
  };
}

function reverseState(label) {
  switch (label) {
    case 'learning': return State.Learning;
    case 'review': return State.Review;
    case 'relearning': return State.Relearning;
    // 'suspended' is app-level metadata, not a ts-fsrs state — a suspended
    // card is always suspended out of learning/review/relearning, never out
    // of New (a brand-new card can't be a leech yet). Treating it as Review
    // here is a safe, conservative reconstruction: if reverseState() is ever
    // called on a card whose real underlying FSRS state wasn't separately
    // tracked, this avoids silently resetting real learning progress back to
    // New. In the normal path (see fromStoredCard()), the caller resolves the
    // real underlying state from record.state directly and this branch is
    // effectively unreachable.
    case 'suspended': return State.Review;
    default: return State.New;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Grades a card and returns the exact object shape db.js's
 * updateCardAfterReview(cardId, fsrsUpdate, reviewLogEntry) expects.
 * Does no IndexedDB access itself — study.js is responsible for the write.
 *
 * @param {object} cardRecord - the card object as read from db.js (must include
 *   due_date, stability, difficulty, reps, lapses, state, last_review)
 * @param {number} grade - one of Grade.AGAIN / HARD / GOOD / EASY
 * @param {Date} [now] - override "now", mainly for testing
 * @returns {{ fsrsUpdate: object, reviewLogEntry: object, leech: boolean }}
 */
export function gradeCard(cardRecord, grade, now = new Date()) {
  const fsrsCard = fromStoredCard(cardRecord);
  const result = scheduler.next(fsrsCard, now, grade);

  const fsrsUpdate = toStoredCard(result.card);

  // Leech check happens here, not in study.js — study.js just renders
  // whatever comes back. Suspension is layered on as its own field rather
  // than overwriting `state`: ts-fsrs has no "suspended" state of its own,
  // so stomping `state` with a string it doesn't recognize would corrupt the
  // card's real learning/review/relearning progress the next time it's read
  // back through fromStoredCard()/reverseState(). `state` therefore always
  // reflects what ts-fsrs actually computed; `suspended`/`leech` are the
  // app-level flags that say whether the card should currently be excluded
  // from study sessions.
  const leech = fsrsUpdate.lapses >= LEECH_LAPSE_THRESHOLD;
  if (leech) {
    fsrsUpdate.suspended = true;
    fsrsUpdate.leech = true;
  }

  const reviewLogEntry = {
    grade: GRADE_LABELS[grade],
    reviewedAt: now.getTime(),
    elapsedDays: result.log.elapsed_days ?? null
  };

  return { fsrsUpdate, reviewLogEntry, leech };
}

/**
 * Previews all four outcomes (interval lengths) for a card without applying
 * any of them — useful for showing "Again <10m> / Hard <1d> / Good <3d> /
 * Easy <6d>" style hints on the grade buttons before the user picks one.
 *
 * @param {object} cardRecord
 * @param {Date} [now]
 * @returns {{ again: number, hard: number, good: number, easy: number }} days until due, per rating
 */
export function previewIntervals(cardRecord, now = new Date()) {
  const fsrsCard = fromStoredCard(cardRecord);
  const preview = scheduler.repeat(fsrsCard, now);

  return {
    again: preview[Rating.Again].card.scheduled_days,
    hard: preview[Rating.Hard].card.scheduled_days,
    good: preview[Rating.Good].card.scheduled_days,
    easy: preview[Rating.Easy].card.scheduled_days
  };
}

/**
 * Builds the default FSRS field set for a brand-new card. db.js already
 * stamps its own DEFAULT_FSRS_FIELDS on insert (state/difficulty/stability/
 * due_date etc.) — this exists for the rare case app.js wants to preview a
 * new card's schedule before it's persisted, without duplicating the ts-fsrs
 * defaults logic in two places.
 */
export function newCardDefaults(now = new Date()) {
  return toStoredCard(createEmptyCard(now));
}
