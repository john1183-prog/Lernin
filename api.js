// api.js
// All backend calls live here. No DOM access, no rendering — app.js listens
// for the CustomEvents this file dispatches and decides how to show them.
// study.js never imports this file, and this file never imports study.js.

import { queueGeneration, getQueuedGenerations, clearQueuedGeneration, saveNewCards, getCardsByDeck } from './db.js';

const GENERATE_ENDPOINT = '/api/generate-cards';

// ---------------------------------------------------------------------------
// Events — app.js listens on window for these to drive toasts/UI. Kept as
// plain CustomEvents rather than a callback registry so api.js stays a pure
// network module with no UI-layer coupling.
// ---------------------------------------------------------------------------

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// 'recall:generation-success'   { deckId, cards }
// 'recall:generation-error'     { deckId, message }
// 'recall:generation-queued'    { deckId }
// 'recall:generation-retry-done' { deckId, cardCount }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends extracted PDF text to the backend for card generation. On success,
 * dedupes against the target deck and returns the *editable* card list —
 * app.js is responsible for rendering the edit step and calling
 * commitGeneratedCards() once the user approves them. This function does
 * NOT write to db.js itself, per the spec's "client-side edit step before
 * cards are committed" requirement.
 *
 * @param {string} text - raw text already extracted client-side by pdf.js
 * @param {string} deckId
 * @returns {Promise<Array<{front: string, back: string, type: string}>>}
 */
export async function generateCards(text, deckId) {
  if (!navigator.onLine) {
    await queueGeneration(deckId, text);
    emit('recall:generation-queued', { deckId });
    return [];
  }

  try {
    const response = await fetch(GENERATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, deck_id: deckId })
    });

    if (!response.ok) {
      throw new Error(`Generation failed: ${response.status}`);
    }

    const data = await response.json();
    const deduped = await dedupeAgainstDeck(data.cards, deckId);
    emit('recall:generation-success', { deckId, cards: deduped });
    return deduped;
  } catch (err) {
    // Network failure (not a server error) — queue for retry rather than
    // surfacing a dead end.
    if (err instanceof TypeError) {
      await queueGeneration(deckId, text);
      emit('recall:generation-queued', { deckId });
      return [];
    }
    emit('recall:generation-error', { deckId, message: err.message });
    return [];
  }
}

/**
 * Writes user-approved generated cards to IndexedDB. Called by app.js after
 * the edit step, never called directly from generateCards().
 *
 * Re-runs dedupeAgainstDeck() here, immediately before saveNewCards() — the
 * edit step (renderEditStep() in app.js) lets a user rewrite front/back text
 * after the initial dedupe already ran in generateCards(), so an edited card
 * could now collide with something already in the deck (or with itself
 * turning into a near-duplicate of another card). This is the single point
 * where cards actually get persisted, so it's the right place for the
 * "is this a duplicate" check that matters.
 */
export async function commitGeneratedCards(deckId, approvedCards) {
  const withIds = approvedCards.map(c => ({
    ...c,
    id: c.id || cryptoRandomId()
  }));
  const deduped = await dedupeAgainstDeck(withIds, deckId);
  return saveNewCards(deckId, deduped);
}

/**
 * Retries every queued generation request. Call this on the window 'online'
 * event (wire it up once in app.js's init) and optionally on app launch.
 */
export async function retryQueuedGenerations() {
  if (!navigator.onLine) return;

  const queued = await getQueuedGenerations();
  for (const item of queued) {
    try {
      const response = await fetch(GENERATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.rawText, deck_id: item.deckId })
      });

      if (!response.ok) continue; // leave it queued, try again next time

      const data = await response.json();
      const deduped = await dedupeAgainstDeck(data.cards, item.deckId);
      await clearQueuedGeneration(item.id);
      emit('recall:generation-retry-done', { deckId: item.deckId, cardCount: deduped.length });
      emit('recall:generation-success', { deckId: item.deckId, cards: deduped });
    } catch {
      // Still offline or the request failed again — leave queued, don't throw.
      break;
    }
  }
}

// Wire the retry automatically when connectivity returns.
window.addEventListener('online', () => {
  retryQueuedGenerations();
});

// ---------------------------------------------------------------------------
// Dedup
// Upgraded from exact-match to token-overlap (Jaccard) similarity — catches
// near-duplicates like reworded or punctuation-shifted regenerations of the
// same fact. Still not true semantic dedup (that would need embeddings or
// another LLM call per card, which is a real cost/latency tradeoff not
// worth making for v1) — this is a deliberate middle ground, not the
// spec's full ambition.
// ---------------------------------------------------------------------------

const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

async function dedupeAgainstDeck(cards, deckId) {
  const existing = await getCardsByDeck(deckId);
  const existingTokenSets = existing.map((c) => tokenSet(c.front));

  return cards.filter((c) => {
    const candidateTokens = tokenSet(c.front);
    return !existingTokenSets.some((set) => jaccardSimilarity(candidateTokens, set) >= DUPLICATE_SIMILARITY_THRESHOLD);
  });
}

function tokenSet(str) {
  return new Set(
    (str || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function cryptoRandomId() {
  return (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
