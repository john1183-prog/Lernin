// db.js
// IndexedDB data layer for the offline-first spaced repetition app.
// Uses the `idb` promise wrapper. All other modules (scheduler.js, study.js,
// canvas.js, api.js) talk to IndexedDB only through this file — nobody else
// touches the raw idb handle.

import { openDB } from './vendor/idb.js';
import { newCardDefaults } from './scheduler.js';

const DB_NAME = 'Lernin';
const DB_VERSION = 5;

// Renamed from 'RecallDB' -> 'Lernin' to match the repo/product name.
// IndexedDB database names can't be renamed in place, so on first load
// after this change, migrateFromOldDatabaseIfNeeded() (called once from
// app.js on startup) copies every record across store-by-store into the
// new database name. Without this, the rename would silently orphan every
// existing user's decks/cards/review history — the app would just open a
// blank new database and look like all their data vanished.
const OLD_DB_NAME = 'RecallDB';
const MIGRATION_FLAG_KEY = 'migratedFromRecallDB';

// ---------------------------------------------------------------------------
// Default FSRS metadata stamped onto every newly created card.
// scheduler.js owns the actual FSRS math; this is just the shape written here.
// ---------------------------------------------------------------------------
const DEFAULT_FSRS_FIELDS = {
  state: 'new',       // 'new' | 'learning' | 'review' | 'relearning' — the
                      // underlying ts-fsrs state only; never 'suspended'.
  difficulty: 0,
  stability: 0,
  reps: 0,
  lapses: 0,
  last_review: null,  // ISO string or null
  due_date: Date.now(), // epoch ms; new cards are due immediately by default
  suspended: false    // leech flag, tracked independently of `state` so a
                      // suspended card's real FSRS state is never lost
};

let dbPromise = null;

/**
 * Opens (and lazily initializes) the database. Safe to call repeatedly —
 * idb + this module cache the single open connection.
 */
export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      // --- decks ---------------------------------------------------------
      if (!db.objectStoreNames.contains('decks')) {
        const decks = db.createObjectStore('decks', { keyPath: 'id' });
        decks.createIndex('by_courseTerritoryId', 'courseTerritoryId');
        decks.createIndex('by_createdAt', 'createdAt');
      }

      // --- cards -----------------------------------------------------------
      if (!db.objectStoreNames.contains('cards')) {
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('by_deckId', 'deckId');
        // The critical index: lets Study Mode pull due cards with a range
        // query instead of scanning + filtering every card in JS.
        cards.createIndex('by_due_date', 'due_date');
        cards.createIndex('by_deck_and_due', ['deckId', 'due_date']);
        cards.createIndex('by_state', 'state');
      }

      // --- reviewLog (optional: stats, leech detection) -------------------
      if (!db.objectStoreNames.contains('reviewLog')) {
        const log = db.createObjectStore('reviewLog', {
          keyPath: 'id',
          autoIncrement: true
        });
        log.createIndex('by_cardId', 'cardId');
        log.createIndex('by_reviewedAt', 'reviewedAt');
      }

      // --- genQueue (v2): raw text queued for /generate-cards while offline,
      // so a failed generation request never requires the user to re-upload
      // their PDF once connectivity returns. Owned/consumed by api.js.
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('genQueue')) {
          const queue = db.createObjectStore('genQueue', {
            keyPath: 'id',
            autoIncrement: true
          });
          queue.createIndex('by_deckId', 'deckId');
          queue.createIndex('by_queuedAt', 'queuedAt');
        }
      }

      // --- territoryLayout (v3): user-dragged island positions on the
      // Territory Map. Absence of a record for an island means canvas.js
      // falls back to its deterministic hash-based layout — this store only
      // holds overrides, not the full layout.
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('territoryLayout')) {
          db.createObjectStore('territoryLayout', { keyPath: 'islandId' });
        }
      }

      // --- settings (v4): small key/value store for local, per-device
      // preferences — currently just the user's own LLM provider + API key
      // for /api/generate-cards (see getApiConfig/saveApiConfig below).
      // Deliberately its own store rather than a field on decks/cards, since
      // it's device-local config, not study data.
      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      }

      // --- documents (v5): stores each uploaded PDF's filename + an
      // LLM-written summary alongside the deck it was imported into, so
      // "Documents" and "Course Recap" in app.js have something to show
      // for what someone uploaded — previously only the extracted text
      // made it into a card-generation request and everything about the
      // original file was discarded once extraction finished. Summary,
      // not the original file itself (see saveDocument's doc comment) —
      // storing every PDF a student uploads across a term doesn't scale.
      if (oldVersion < 5) {
        if (!db.objectStoreNames.contains('documents')) {
          const documents = db.createObjectStore('documents', { keyPath: 'id' });
          documents.createIndex('by_deckId', 'deckId');
        }
      }

      // Future migrations: `if (oldVersion < 6) { ... }` etc. Never delete
      // or rename stores in-place on user devices without a migration path.
    }
  });

  // Ask the browser not to silently evict this DB under storage pressure
  // (notably iOS Safari). Best-effort — failure here is not fatal.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {
      /* non-fatal: persistence is a request, not a guarantee */
    });
  }

  return dbPromise;
}

/**
 * One-time copy of every record from the old 'RecallDB' database into this
 * one, run on every app startup (see app.js) but only does real work once
 * — checks a flag in the settings store and bails immediately after the
 * first successful run (or first run that finds nothing to migrate).
 *
 * Safe by construction: only copies into 'decks' if 'decks' is currently
 * empty (never overwrites real data), and never throws — a failed or
 * partial migration just means the flag doesn't get set and it retries
 * next launch, which is strictly better than blocking startup on it.
 */
export async function migrateFromOldDatabaseIfNeeded() {
  const db = await getDB();

  try {
    const flag = await db.get('settings', MIGRATION_FLAG_KEY);
    if (flag) return;

    const existingDeckCount = await db.count('decks');
    if (existingDeckCount > 0) {
      // Already has data under the new name (e.g. a fresh install after
      // this change shipped) — nothing to migrate, just mark it done.
      await db.put('settings', { key: MIGRATION_FLAG_KEY, migratedAt: Date.now(), copied: false });
      return;
    }

    // Opening without a version spec attaches to whatever version already
    // exists — or silently creates an empty v1 database with no stores if
    // 'RecallDB' was never used on this device, which is harmless.
    const oldDb = await openDB(OLD_DB_NAME);
    const storeNames = ['decks', 'cards', 'reviewLog', 'genQueue', 'territoryLayout', 'settings', 'documents'];
    let copiedAny = false;

    for (const storeName of storeNames) {
      if (!oldDb.objectStoreNames.contains(storeName) || !db.objectStoreNames.contains(storeName)) continue;
      const records = await oldDb.getAll(storeName);
      if (records.length === 0) continue;

      const tx = db.transaction(storeName, 'readwrite');
      for (const record of records) {
        // Don't carry over the old DB's own (nonexistent, but just in
        // case) migration flag under this same key.
        if (storeName === 'settings' && record.key === MIGRATION_FLAG_KEY) continue;
        await tx.store.put(record);
      }
      await tx.done;
      copiedAny = true;
    }

    oldDb.close();
    await db.put('settings', { key: MIGRATION_FLAG_KEY, migratedAt: Date.now(), copied: copiedAny });
  } catch (err) {
    // Never let a migration failure block the app from loading — worst
    // case, this just retries on the next launch.
    console.error('Migration from RecallDB failed, will retry next launch:', err);
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Saves an array of newly generated cards to a deck, stamping each with
 * default FSRS metadata. Duplicate detection against the target deck is
 * expected to have already run in app.js/api.js before this is called —
 * this function assumes `newCards` is the deduplicated set.
 *
 * @param {string} deckId
 * @param {Array<{id: string, front: string, back: string, type?: string}>} newCards
 * @returns {Promise<number>} number of cards written
 */
export async function saveNewCards(deckId, newCards) {
  if (!newCards || newCards.length === 0) return 0;

  const db = await getDB();
  const tx = db.transaction('cards', 'readwrite');
  const store = tx.objectStore('cards');

  try {
    for (const card of newCards) {
      const record = {
        id: card.id,
        deckId,
        front: card.front,
        back: card.back,
        type: card.type || 'basic', // 'basic' | 'cloze'
        createdAt: Date.now(),
        ...DEFAULT_FSRS_FIELDS,
        due_date: Date.now() // explicit: new cards enter the due queue now
      };
      await store.put(record);
    }
    await tx.done;
    return newCards.length;
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      // Surface a typed error so api.js/app.js can show a clear "storage
      // full" toast instead of a generic failure.
      throw new Error('STORAGE_QUOTA_EXCEEDED');
    }
    throw err;
  }
}

/**
 * Writes updated FSRS metadata onto a card after it's been graded.
 * scheduler.js computes the new state/difficulty/stability/due_date and
 * passes the full updated object in here — this function does no FSRS math.
 *
 * @param {string} cardId
 * @param {object} fsrsUpdate - { state, difficulty, stability, reps, lapses, last_review, due_date }
 * @param {object} [reviewLogEntry] - optional { grade, reviewedAt, elapsedDays }
 */
export async function updateCardAfterReview(cardId, fsrsUpdate, reviewLogEntry) {
  const db = await getDB();
  const tx = db.transaction(
    reviewLogEntry ? ['cards', 'reviewLog'] : ['cards'],
    'readwrite'
  );
  const cardsStore = tx.objectStore('cards');

  const existing = await cardsStore.get(cardId);
  if (!existing) {
    throw new Error(`updateCardAfterReview: card ${cardId} not found`);
  }

  const updated = {
    ...existing,
    ...fsrsUpdate
  };

  try {
    await cardsStore.put(updated);

    if (reviewLogEntry) {
      await tx.objectStore('reviewLog').add({
        cardId,
        grade: reviewLogEntry.grade,           // 'again' | 'hard' | 'good' | 'easy'
        reviewedAt: reviewLogEntry.reviewedAt || Date.now(),
        elapsedDays: reviewLogEntry.elapsedDays ?? null
      });
    }

    await tx.done;
    return updated;
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      throw new Error('STORAGE_QUOTA_EXCEEDED');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Returns cards due today or earlier for a given deck (or across all decks
 * if deckId is omitted), using the indexed due_date range — never a full
 * table scan + JS filter.
 *
 * @param {object} [opts]
 * @param {string} [opts.deckId] - restrict to one deck; omit for all decks
 * @param {number} [opts.now] - override "now" (epoch ms), mainly for testing
 * @param {number} [opts.limit] - cap on results (daily review cap enforcement
 *                                 lives in scheduler.js, but a hard limit here
 *                                 avoids pulling an unbounded result set)
 * @param {boolean} [opts.excludeSuspended] - skip leeched/suspended cards
 *                                 (default true). Filtered during the cursor
 *                                 walk so suspended cards never count against
 *                                 `limit`, and so callers like app.js's
 *                                 deck-list badge never have to filter again.
 * @returns {Promise<Array>}
 */
export async function getCardsDueTodayOrEarlier({ deckId, now, limit, excludeSuspended = true } = {}) {
  const db = await getDB();
  const cutoff = now ?? Date.now();
  const tx = db.transaction('cards', 'readonly');
  const results = [];

  if (deckId) {
    // Compound index: [deckId, due_date], bounded to this deck and due <= cutoff.
    const index = tx.store.index('by_deck_and_due');
    const range = IDBKeyRange.bound([deckId, -Infinity], [deckId, cutoff]);
    let cursor = await index.openCursor(range);
    while (cursor) {
      if (!excludeSuspended || !cursor.value.suspended) {
        results.push(cursor.value);
        if (limit && results.length >= limit) break;
      }
      cursor = await cursor.continue();
    }
  } else {
    const index = tx.store.index('by_due_date');
    const range = IDBKeyRange.upperBound(cutoff);
    let cursor = await index.openCursor(range);
    while (cursor) {
      if (!excludeSuspended || !cursor.value.suspended) {
        results.push(cursor.value);
        if (limit && results.length >= limit) break;
      }
      cursor = await cursor.continue();
    }
  }

  await tx.done;
  return results;
}

/**
 * Fetch a single card by id.
 */
export async function getCard(cardId) {
  const db = await getDB();
  return db.get('cards', cardId);
}

/**
 * Permanently deletes a single card. Currently only used by the leech review
 * surface's Delete action in app.js — nothing else in the app deletes
 * individual cards today.
 */
export async function deleteCard(cardId) {
  const db = await getDB();
  return db.delete('cards', cardId);
}

/**
 * Resets a leeched (suspended) card back to a fresh-card schedule: zeroes
 * lapses, clears the suspended/leech flags, resets stability/difficulty to
 * ts-fsrs's own new-card defaults (via scheduler.js's newCardDefaults(), so
 * this file doesn't duplicate FSRS's default values), and puts the card due
 * immediately. Deliberately routed through updateCardAfterReview() rather
 * than a second read-modify-write transaction, so there is exactly one place
 * that knows how to merge a partial update onto a stored card record.
 *
 * @param {string} cardId
 */
export async function resetLeech(cardId) {
  const defaults = newCardDefaults();
  return updateCardAfterReview(cardId, {
    lapses: 0,
    suspended: false,
    leech: false,
    stability: defaults.stability,
    difficulty: defaults.difficulty,
    due_date: Date.now()
  });
}

/**
 * Fetch all leeched (suspended) cards for a deck — the leech review surface
 * in app.js is the only caller. Reuses the existing by_deckId index rather
 * than adding a new one; the suspended filter is cheap in JS since a deck's
 * leech count is expected to be small relative to its total card count.
 */
export async function getSuspendedCards(deckId) {
  const db = await getDB();
  const all = await db.getAllFromIndex('cards', 'by_deckId', deckId);
  return all.filter((c) => c.suspended);
}

/**
 * Fetch a card's full review history, oldest first — used by the leech
 * review surface to show *why* a card might have been leeched (a string of
 * "Again" grades vs. one bad day among mostly "Good"s reads very
 * differently), without attempting any real semantic analysis of what
 * specifically kept going wrong — that would need the app to record more
 * than a grade per review, which it currently doesn't.
 */
export async function getReviewHistoryForCard(cardId) {
  const db = await getDB();
  const entries = await db.getAllFromIndex('reviewLog', 'by_cardId', cardId);
  return entries.sort((a, b) => a.reviewedAt - b.reviewedAt);
}

/**
 * Fetch all cards for a deck (unfiltered by due date) — used by the flat
 * list/grid view and the canvas territory-map mastery visuals, not by
 * Study Mode.
 */
export async function getCardsByDeck(deckId) {
  const db = await getDB();
  return db.getAllFromIndex('cards', 'by_deckId', deckId);
}

// ---------------------------------------------------------------------------
// Deck CRUD (minimal — full deck management lives in app.js/canvas.js)
// ---------------------------------------------------------------------------

export async function saveDeck(deck) {
  const db = await getDB();
  return db.put('decks', {
    id: deck.id,
    title: deck.title,
    courseTerritoryId: deck.courseTerritoryId,
    createdAt: deck.createdAt || Date.now()
  });
}

export async function getAllDecks() {
  const db = await getDB();
  return db.getAll('decks');
}

export async function getDecksByTerritory(courseTerritoryId) {
  const db = await getDB();
  return db.getAllFromIndex('decks', 'by_courseTerritoryId', courseTerritoryId);
}

// ---------------------------------------------------------------------------
// Territory layout overrides (user-dragged island positions)
// canvas.js is the only caller.
// ---------------------------------------------------------------------------

export async function saveIslandPosition(islandId, x, y) {
  const db = await getDB();
  return db.put('territoryLayout', { islandId, x, y, updatedAt: Date.now() });
}

/**
 * Clears a saved drag position override — used when a deck is reassigned
 * to a different courseTerritoryId, so it falls back to a sensible default
 * spot within its new territory instead of keeping an absolute position
 * left over from whatever territory it used to belong to.
 */
export async function clearIslandPosition(islandId) {
  const db = await getDB();
  return db.delete('territoryLayout', islandId);
}

export async function getIslandPositionOverrides() {
  const db = await getDB();
  const all = await db.getAll('territoryLayout');
  const map = new Map();
  for (const rec of all) map.set(rec.islandId, { x: rec.x, y: rec.y });
  return map;
}

// ---------------------------------------------------------------------------
// Generation queue (offline retry for /generate-cards)
// api.js is the only caller of these — study.js and canvas.js never touch it.
// ---------------------------------------------------------------------------

/**
 * Queues raw extracted PDF text for retry when a /generate-cards request
 * fails while offline.
 */
export async function queueGeneration(deckId, rawText) {
  const db = await getDB();
  return db.add('genQueue', {
    deckId,
    rawText,
    queuedAt: Date.now()
  });
}

export async function getQueuedGenerations() {
  const db = await getDB();
  return db.getAll('genQueue');
}

export async function clearQueuedGeneration(id) {
  const db = await getDB();
  return db.delete('genQueue', id);
}

// ---------------------------------------------------------------------------
// Stats (app.js's home-stats card + per-deck mastery bar)
// Reads only — no writes live here. Kept in db.js rather than app.js so the
// "mastered" threshold has exactly one definition shared with canvas.js's
// island coloring, rather than two heuristics drifting apart.
// ---------------------------------------------------------------------------

// A card counts as "mastered" for display purposes once FSRS stability
// crosses ~3 weeks — matches the heuristic canvas.js uses for island color,
// so a deck's mastery bar and its island's color always agree.
const MASTERY_STABILITY_DAYS = 21;

/**
 * Buckets a deck's cards into new / in-progress / mastered for the
 * mastery bar shown on each deck tile and the home stats strip.
 * Suspended (leeched) cards are excluded from all three buckets — they're
 * neither "new" nor meaningfully "in progress" until reset.
 *
 * @param {string} deckId
 * @returns {Promise<{ total: number, newCount: number, inProgress: number, mastered: number }>}
 */
export async function getDeckStateCounts(deckId) {
  // Checks both `state === 'suspended'` (how scheduler.js marks a leech
  // today) and an explicit `suspended` boolean (in case that's split out
  // separately later) so this stays correct either way.
  const cards = (await getCardsByDeck(deckId)).filter(
    (c) => c.state !== 'suspended' && !c.suspended
  );

  let newCount = 0;
  let mastered = 0;

  for (const card of cards) {
    if (card.state === 'new') {
      newCount++;
    } else if ((card.stability || 0) >= MASTERY_STABILITY_DAYS) {
      mastered++;
    }
  }

  const total = cards.length;
  const inProgress = total - newCount - mastered;

  return { total, newCount, inProgress, mastered };
}

/**
 * Streak + weekly review activity, read from reviewLog via its indexed
 * `by_reviewedAt` field. Used by app.js's home stats card.
 *
 * Streak counts consecutive calendar days (local time) with at least one
 * review, walking backward from today. A day with zero reviews breaks the
 * streak UNLESS it's today itself (so the streak doesn't visibly reset to 0
 * the moment midnight passes, before the user has had a chance to study).
 *
 * @param {number} [now] - override "now" (epoch ms), mainly for testing
 * @returns {Promise<{ streakDays: number, weekCounts: number[], weekTotal: number }>}
 *   weekCounts is 7 entries, oldest to newest, ending with today.
 */
export async function getReviewStats(now) {
  const db = await getDB();
  const nowMs = now ?? Date.now();

  // Pull the last 60 days of review log entries — enough to compute any
  // realistic streak without scanning the entire lifetime log.
  const lookbackStart = startOfLocalDay(nowMs - 60 * 24 * 60 * 60 * 1000);
  const range = IDBKeyRange.lowerBound(lookbackStart);
  const entries = await db.getAllFromIndex('reviewLog', 'by_reviewedAt', range);

  const reviewedDayKeys = new Set(entries.map((e) => localDayKey(e.reviewedAt)));
  const freezeState = await getStreakFreezeState();
  const frozenDayKeys = new Set(freezeState.frozenDayKeys);

  let streakDays = 0;
  let cursor = startOfLocalDay(nowMs);
  const todayKey = localDayKey(nowMs);

  while (true) {
    const key = localDayKey(cursor);
    if (reviewedDayKeys.has(key) || frozenDayKeys.has(key)) {
      streakDays++;
    } else if (key !== todayKey) {
      break;
    }
    cursor -= 24 * 60 * 60 * 1000;
  }

  // Auto-award: +1 freeze (capped) every 7-day streak milestone reached,
  // tracked via lastAwardedMilestone so this doesn't re-award every time
  // getReviewStats() is called (which happens on basically every render,
  // not just once a day).
  const milestone = Math.floor(streakDays / 7);
  let currentFreezeState = freezeState;
  if (milestone > freezeState.lastAwardedMilestone) {
    currentFreezeState = {
      ...freezeState,
      freezesAvailable: Math.min(MAX_STREAK_FREEZES, freezeState.freezesAvailable + 1),
      lastAwardedMilestone: milestone
    };
    await saveStreakFreezeState(currentFreezeState);
  }

  const weekCounts = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfLocalDay(nowMs - i * 24 * 60 * 60 * 1000);
    const key = localDayKey(dayStart);
    const count = entries.filter((e) => localDayKey(e.reviewedAt) === key).length;
    weekCounts.push(count);
  }

  const weekTotal = weekCounts.reduce((a, b) => a + b, 0);
  const studiedToday = reviewedDayKeys.has(todayKey) || frozenDayKeys.has(todayKey);

  return {
    streakDays,
    weekCounts,
    weekTotal,
    studiedToday,
    freezesAvailable: currentFreezeState.freezesAvailable
  };
}

// ---------------------------------------------------------------------------
// Streak freezes — a limited resource (earned by keeping a streak going,
// spent to protect it) rather than the streak silently resetting to 0 the
// first time someone misses a day. Deliberately spent MANUALLY (via
// useStreakFreeze, called from a button in app.js) rather than
// auto-consumed the moment a gap is detected — an explicit user action is
// simpler to reason about correctness-wise than trying to silently detect
// and bridge gaps on every stats read, and it makes the tradeoff visible
// ("you're about to spend one of your 3 freezes") instead of invisible.
// ---------------------------------------------------------------------------

const STREAK_FREEZE_KEY = 'streakFreezeState';
const MAX_STREAK_FREEZES = 3;

async function getStreakFreezeState() {
  const db = await getDB();
  const record = await db.get('settings', STREAK_FREEZE_KEY);
  return record || { key: STREAK_FREEZE_KEY, freezesAvailable: 0, lastAwardedMilestone: 0, frozenDayKeys: [] };
}

async function saveStreakFreezeState(state) {
  const db = await getDB();
  return db.put('settings', { ...state, key: STREAK_FREEZE_KEY });
}

/**
 * Spends one freeze to protect today's streak (marks today as "covered"
 * without an actual review) — used when someone knows they won't get to
 * study today and doesn't want to lose their streak. Returns false (spends
 * nothing) if there are no freezes available or today is already
 * covered/reviewed.
 */
export async function useStreakFreeze() {
  const state = await getStreakFreezeState();
  const todayKey = localDayKey(Date.now());
  if (state.freezesAvailable <= 0 || state.frozenDayKeys.includes(todayKey)) return false;
  await saveStreakFreezeState({
    ...state,
    freezesAvailable: state.freezesAvailable - 1,
    frozenDayKeys: [...state.frozenDayKeys, todayKey]
  });
  return true;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Export / Import
// IndexedDB can be evicted by the OS (iOS Safari under storage pressure),
// so a full JSON export/import path is a data-safety requirement, not a
// nice-to-have.
// ---------------------------------------------------------------------------

/**
 * Exports a deck plus all its cards as a plain JSON-serializable object.
 */
export async function exportDeck(deckId) {
  const db = await getDB();
  const deck = await db.get('decks', deckId);
  if (!deck) throw new Error(`exportDeck: deck ${deckId} not found`);
  const cards = await getCardsByDeck(deckId);

  return {
    schemaVersion: DB_VERSION,
    exportedAt: Date.now(),
    deck,
    cards
  };
}

/**
 * Re-imports a previously exported deck bundle. Overwrites the deck record
 * and upserts all cards by id (existing FSRS progress on matching ids is
 * preserved because we put() the exported record as-is, not a fresh one).
 */
export async function importDeck(bundle) {
  if (!bundle || !bundle.deck || !Array.isArray(bundle.cards)) {
    throw new Error('importDeck: malformed bundle');
  }

  const db = await getDB();
  const tx = db.transaction(['decks', 'cards'], 'readwrite');

  await tx.objectStore('decks').put(bundle.deck);
  for (const card of bundle.cards) {
    await tx.objectStore('cards').put(card);
  }

  await tx.done;
  return { deckId: bundle.deck.id, cardCount: bundle.cards.length };
}

// ---------------------------------------------------------------------------
// Settings — currently just the user's own LLM provider + API key, used by
// api.js when calling /api/generate-cards. See the settings view in app.js.
//
// The key lives only in this device's IndexedDB and is sent to our own
// backend (over HTTPS, per-request, never persisted or logged server-side —
// see api/index.py) only at the moment a card-generation request is made,
// so the backend can call the chosen provider on the user's behalf. It never
// leaves the device otherwise.
// ---------------------------------------------------------------------------

const API_CONFIG_KEY = 'llmApiConfig';

/**
 * @returns {Promise<{provider: 'claude'|'gemini'|'manual', apiKey: string}|null>}
 *          null if the user hasn't configured their own key yet.
 */
export async function getApiConfig() {
  const db = await getDB();
  const record = await db.get('settings', API_CONFIG_KEY);
  return record ? { provider: record.provider, apiKey: record.apiKey } : null;
}

/**
 * @param {{provider: 'claude'|'gemini'|'manual', apiKey: string}} config
 *        'manual' means "paste into any AI, no key needed" — apiKey is
 *        ignored/empty for that provider.
 */
export async function saveApiConfig({ provider, apiKey }) {
  if (provider !== 'claude' && provider !== 'gemini' && provider !== 'manual') {
    throw new Error(`saveApiConfig: unknown provider "${provider}"`);
  }
  const db = await getDB();
  return db.put('settings', {
    key: API_CONFIG_KEY,
    provider,
    apiKey: provider === 'manual' ? '' : (apiKey ?? '')
  });
}

/**
 * Clears the stored key/provider — used by the "Remove key" action in the
 * settings view to fall back to the app's shared/default key, if any.
 */
export async function clearApiConfig() {
  const db = await getDB();
  return db.delete('settings', API_CONFIG_KEY);
}

/**
 * Nukes everything: every deck, card, review log entry, queued generation,
 * territory layout override, and saved setting — used by Settings' "Reset
 * everything" danger-zone action. There is no undo.
 *
 * Deletes the whole IndexedDB database rather than clearing each store
 * individually, so a future schema migration (new stores we haven't
 * thought of yet) can't accidentally be left out of the wipe. Closes the
 * cached connection first — deleteDatabase() blocks/hangs while any
 * connection to it is still open.
 */
export async function wipeAllData() {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Could not reset — close any other tabs with this app open and try again.'));
  });
}

// ---------------------------------------------------------------------------
// Documents — the original uploaded PDF Blob, kept alongside the deck it
// was imported into so it can be listed and re-opened later (see app.js's
// "Documents" view). Purely storage/retrieval here; extraction lives in
// pdf-extract.js and card generation in api.js — neither touches this
// store directly.
// ---------------------------------------------------------------------------

/**
 * @param {{id: string, deckId: string, filename: string, blob: Blob, size: number}} doc
 */
/**
 * @param {{id: string, deckId: string, filename: string, summary: string, size: number}} doc
 *        Deliberately does NOT store the original file — only its filename,
 *        original size (informational only), and an LLM-written summary.
 *        Storing every uploaded PDF in IndexedDB doesn't scale for a
 *        student uploading dozens of them across a term; the summary is
 *        what actually gets used later (see the Course Recap view), and
 *        costs a few KB instead of a few MB per document.
 */
export async function saveDocument({ id, deckId, filename, summary, size }) {
  const db = await getDB();
  return db.put('documents', { id, deckId, filename, summary: summary || '', size, uploadedAt: Date.now() });
}

export async function getDocumentsByDeck(deckId) {
  const db = await getDB();
  const docs = await db.getAllFromIndex('documents', 'by_deckId', deckId);
  return docs.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export async function getDocument(id) {
  const db = await getDB();
  return db.get('documents', id);
}

export async function deleteDocument(id) {
  const db = await getDB();
  return db.delete('documents', id);
}
