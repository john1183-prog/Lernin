// api.js
// All backend calls live here. No DOM access, no rendering — app.js listens
// for the CustomEvents this file dispatches and decides how to show them.
// study.js never imports this file, and this file never imports study.js.
//
// Generation modes:
//   - BYOK (Claude/Gemini + user key) → call /api/generate-cards
//   - Manual ("Paste into any AI") or no key → UI uses renderManualJSONImport;
//     this module must NOT call the server without a real key.
// There is no server-side default API key.

import {
  queueGeneration,
  getQueuedGenerations,
  clearQueuedGeneration,
  saveNewCards,
  getCardsByDeck,
  getApiConfig
} from './db.js';

const GENERATE_ENDPOINT = '/api/generate-cards';

/**
 * True only when the user has configured Claude or Gemini with an API key.
 */
async function hasByokConfig() {
  const config = await getApiConfig();
  return !!(
    config &&
    config.apiKey &&
    (config.provider === 'claude' || config.provider === 'gemini')
  );
}

/**
 * Builds headers for the LLM request.
 * Requires the user to have configured their own provider + key in Settings.
 * There is no server-side fallback key.
 */
async function llmRequestHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const config = await getApiConfig();
  if (
    config &&
    config.apiKey &&
    (config.provider === 'claude' || config.provider === 'gemini')
  ) {
    headers['X-LLM-Provider'] = config.provider;
    headers['X-LLM-Api-Key'] = config.apiKey;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Events — app.js listens on window for these to drive toasts/UI.
// ---------------------------------------------------------------------------

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// 'recall:generation-success'    { deckId, cards, summary? }
// 'recall:generation-error'      { deckId, message }
// 'recall:generation-queued'     { deckId }
// 'recall:generation-retry-done' { deckId, cardCount }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends extracted text to the backend for card generation (BYOK only).
 * On success, dedupes and returns the editable card list — app.js shows the
 * edit step and calls commitGeneratedCards() after the user approves.
 *
 * Without a BYOK key, this does not call the server. The UI should use the
 * manual "Paste into any AI" flow instead.
 */
export async function generateCards(text, deckId) {
  if (!(await hasByokConfig())) {
    emit('recall:generation-error', {
      deckId,
      message:
        'No API key configured. Use Settings → “Paste into any AI”, or add a Claude/Gemini key.'
    });
    return { cards: [], summary: '' };
  }

  if (!navigator.onLine) {
    await queueGeneration(deckId, text);
    emit('recall:generation-queued', { deckId });
    return { cards: [], summary: '' };
  }

  try {
    const response = await fetch(GENERATE_ENDPOINT, {
      method: 'POST',
      headers: await llmRequestHeaders(),
      body: JSON.stringify({ text, deck_id: deckId })
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 400) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Generation failed: ${response.status}`);
      }
      throw new Error(`Generation failed: ${response.status}`);
    }

    const data = await response.json();
    const deduped = await dedupeAgainstDeck(data.cards, deckId);
    const summary = data.summary || '';
    emit('recall:generation-success', { deckId, cards: deduped, summary });
    return { cards: deduped, summary };
  } catch (err) {
    // Network failure — queue for retry rather than a dead end.
    if (err instanceof TypeError) {
      await queueGeneration(deckId, text);
      emit('recall:generation-queued', { deckId });
      return { cards: [], summary: '' };
    }
    emit('recall:generation-error', { deckId, message: err.message });
    return { cards: [], summary: '' };
  }
}

/**
 * Writes user-approved generated cards to IndexedDB.
 * Called by app.js after the edit step, not from generateCards() itself.
 */
export async function commitGeneratedCards(deckId, approvedCards) {
  const withIds = approvedCards.map((c) => ({
    ...c,
    id: c.id || cryptoRandomId()
  }));
  const deduped = await dedupeAgainstDeck(withIds, deckId);
  return saveNewCards(deckId, deduped);
}

/**
 * Retries queued generation requests (BYOK only).
 * On success, cards are saved immediately so they are not lost.
 */
export async function retryQueuedGenerations() {
  if (!navigator.onLine) return;
  if (!(await hasByokConfig())) return; // nothing useful without a key

  const queued = await getQueuedGenerations();
  for (const item of queued) {
    try {
      const response = await fetch(GENERATE_ENDPOINT, {
        method: 'POST',
        headers: await llmRequestHeaders(),
        body: JSON.stringify({ text: item.rawText, deck_id: item.deckId })
      });

      if (!response.ok) continue; // leave queued, try again later

      const data = await response.json();
      const deduped = await dedupeAgainstDeck(data.cards, item.deckId);

      const withIds = deduped.map((c) => ({
        ...c,
        id: c.id || cryptoRandomId()
      }));
      await saveNewCards(item.deckId, withIds);

      await clearQueuedGeneration(item.id);
      emit('recall:generation-retry-done', {
        deckId: item.deckId,
        cardCount: withIds.length
      });
      emit('recall:generation-success', {
        deckId: item.deckId,
        cards: withIds
      });
    } catch {
      // Still offline or request failed — leave queued, don't throw.
      break;
    }
  }
}

window.addEventListener('online', () => {
  retryQueuedGenerations();
});

// ---------------------------------------------------------------------------
// Dedup (Jaccard token overlap)
// ---------------------------------------------------------------------------

const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

export async function dedupeAgainstDeck(cards, deckId) {
  const existing = await getCardsByDeck(deckId);
  const existingTokenSets = existing.map((c) => tokenSet(c.front));

  return cards.filter((c) => {
    const candidateTokens = tokenSet(c.front);
    return !existingTokenSets.some(
      (set) =>
        jaccardSimilarity(candidateTokens, set) >= DUPLICATE_SIMILARITY_THRESHOLD
    );
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
  return (
    crypto?.randomUUID?.() ??
    `\( {Date.now()}- \){Math.random().toString(36).slice(2)}`
  );
}