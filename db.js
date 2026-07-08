// db.js
// IndexedDB data layer for the offline-first spaced repetition app.
// Uses the `idb` promise wrapper. All other modules (scheduler.js, study.js,
// canvas.js, api.js) talk to IndexedDB only through this file — nobody else
// touches the raw idb handle.

import { openDB } from 'idb';

const DB_NAME = 'RecallDB';
const DB_VERSION = 3;

// ---------------------------------------------------------------------------
// Default FSRS metadata stamped onto every newly created card.
// scheduler.js owns the actual FSRS math; this is just the shape written here.
// ---------------------------------------------------------------------------
const DEFAULT_FSRS_FIELDS = {
  state: 'new',       // 'new' | 'learning' | 'review' | 'relearning'
  difficulty: 0,
  stability: 0,
  reps: 0,
  lapses: 0,
  last_review: null,  // ISO string or null
  due_date: Date.now() // epoch ms; new cards are due immediately by default
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

      // Future migrations: `if (oldVersion < 4) { ... }` etc. Never delete
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
 * @returns {Promise<Array>}
 */
export async function getCardsDueTodayOrEarlier({ deckId, now, limit } = {}) {
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
      results.push(cursor.value);
      if (limit && results.length >= limit) break;
      cursor = await cursor.continue();
    }
  } else {
    const index = tx.store.index('by_due_date');
    const range = IDBKeyRange.upperBound(cutoff);
    let cursor = await index.openCursor(range);
    while (cursor) {
      results.push(cursor.value);
      if (limit && results.length >= limit) break;
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
