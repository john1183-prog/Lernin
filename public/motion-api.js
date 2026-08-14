// motion-api.js
// All Motion Studio backend calls live here. No DOM access, no rendering —
// mirrors api.js's pattern exactly (see that file's own header comment).
//
// Three credential paths, kept cleanly separate — see the architecture
// notes for why this separation matters long-term (retiring BYOK later
// should be deleting one `if`, not a rearchitecture):
//   1. BYOK        -> X-LLM-Provider / X-LLM-Api-Key headers, no quota touched
//   2. Server key  -> X-Client-Id header only, gated by the free quota
//   3. Manual mode -> no network call from generateMotion() at all; the
//                     caller uses expandMotionScriptManual() once the
//                     person pastes JSON back from their own AI chat

import {
  getApiConfig,
  getMotionClientId,
  queueMotionGeneration,
  getQueuedMotionGenerations,
  clearQueuedMotionGeneration,
  saveMotionScript
} from './db.js';

const GENERATE_ENDPOINT = '/api/generate-motion';
const EXPAND_ENDPOINT = '/api/expand-motion-script';

async function hasByokConfig() {
  const config = await getApiConfig();
  return !!(
    config &&
    config.apiKey &&
    (config.provider === 'claude' || config.provider === 'gemini')
  );
}

/**
 * Headers for /api/generate-motion. BYOK first — no client ID attached
 * in that case, since BYOK requests cost Lernin nothing and shouldn't be
 * tracked at all. Otherwise attaches X-Client-Id so the server-key free
 * quota can be enforced per device. Manual mode never calls this.
 */
async function motionRequestHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (await hasByokConfig()) {
    const config = await getApiConfig();
    headers['X-LLM-Provider'] = config.provider;
    headers['X-LLM-Api-Key'] = config.apiKey;
    return headers;
  }
  headers['X-Client-Id'] = await getMotionClientId();
  return headers;
}

// ---------------------------------------------------------------------------
// Events — a future UI layer listens on window for these to drive toasts.
// ---------------------------------------------------------------------------

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Best-effort extraction of a useful message from a failed response.
 * Tries `{detail: "..."}` (the shape every route here returns) first;
 * if the body isn't that shape at all — a raw platform error page, for
 * instance, not something this backend produced — falls back to
 * whatever text came back, so there's always *something* to go on
 * instead of a bare status code.
 */
async function extractErrorMessage(response) {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    if (body && body.detail) return body.detail;
  } catch {
    // not JSON — fall through to raw text below
  }
  const trimmed = text.trim();
  if (trimmed) return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  return `Request failed: HTTP ${response.status}`;
}

// 'lernin:motion-generation-success'    { topic, script, id }
// 'lernin:motion-generation-error'      { topic, message, status? }
// 'lernin:motion-generation-queued'     { topic }
// 'lernin:motion-generation-retry-done' { topic, script, id }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a Motion Studio script for `topic` via whichever credential
 * path applies (BYOK, or Lernin's server key gated by the free quota —
 * see _resolve_motion_credentials in api/index.py). Saves the resolved
 * script to IndexedDB on success. Does NOT attempt manual mode itself —
 * a 401 with no BYOK configured means the caller should route to
 * expandMotionScriptManual() instead.
 */
export async function generateMotion(topic, deckId = null) {
  if (!navigator.onLine) {
    await queueMotionGeneration(topic, deckId);
    emit('lernin:motion-generation-queued', { topic });
    return { script: null, id: null, queued: true, error: null };
  }

  try {
    const response = await fetch(GENERATE_ENDPOINT, {
      method: 'POST',
      headers: await motionRequestHeaders(),
      body: JSON.stringify({ topic })
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      emit('lernin:motion-generation-error', { topic, message, status: response.status });
      return { script: null, id: null, queued: false, error: message, status: response.status };
    }

    const data = await response.json();
    const record = await saveMotionScript({ topic, script: data.script, deckId });
    emit('lernin:motion-generation-success', { topic, script: data.script, id: record.id });
    return { script: data.script, id: record.id, queued: false, error: null };
  } catch (err) {
    // Network failure — queue for retry rather than a dead end.
    if (err instanceof TypeError) {
      await queueMotionGeneration(topic, deckId);
      emit('lernin:motion-generation-queued', { topic });
      return { script: null, id: null, queued: true, error: null };
    }
    emit('lernin:motion-generation-error', { topic, message: err.message });
    return { script: null, id: null, queued: false, error: err.message };
  }
}

/**
 * Retries queued topics once connectivity returns. The free quota still
 * applies to server-key retries, so a queued topic can come back with a
 * 402 if the quota's since been used up elsewhere — left queued in that
 * case (response not ok), not dropped.
 */
export async function retryQueuedMotionGenerations() {
  if (!navigator.onLine) return;

  const queued = await getQueuedMotionGenerations();
  for (const item of queued) {
    try {
      const response = await fetch(GENERATE_ENDPOINT, {
        method: 'POST',
        headers: await motionRequestHeaders(),
        body: JSON.stringify({ topic: item.topic })
      });

      if (!response.ok) continue; // leave queued, try again later

      const data = await response.json();
      const record = await saveMotionScript({ topic: item.topic, script: data.script, deckId: item.deckId });
      await clearQueuedMotionGeneration(item.id);
      emit('lernin:motion-generation-retry-done', { topic: item.topic, script: data.script, id: record.id });
    } catch {
      // Still offline or request failed — leave queued, don't throw.
      break;
    }
  }
}

window.addEventListener('online', () => {
  retryQueuedMotionGenerations();
});

/**
 * Manual mode: validates + expands a script the person pasted in after
 * running buildMotionManualPrompt()'s output through their own AI chat.
 * No AI call happens here at all — mirrors /api/expand-motion-script's
 * own doc comment: BYOK, server-key, and manual-paste all converge on
 * byte-identical resolved output.
 */
export async function expandMotionScriptManual(rawScript, topic, deckId = null) {
  try {
    const response = await fetch(EXPAND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawScript)
    });
    if (!response.ok) {
      return { script: null, id: null, error: await extractErrorMessage(response) };
    }
    const data = await response.json();
    const record = await saveMotionScript({ topic: topic || 'Untitled', script: data.script, deckId });
    return { script: data.script, id: record.id, error: null };
  } catch (err) {
    return { script: null, id: null, error: err.message };
  }
}

/**
 * Plain-text prompt for manual mode — ported 1:1 from
 * build_motion_manual_prompt() in api/index.py, which stays the single
 * source of truth (this mirrors it here rather than adding an endpoint
 * just to fetch prompt text, avoiding an extra round trip). If that
 * Python function ever changes, update this to match — verified
 * byte-identical (aside from the topic substitution) at the time this
 * was written.
 */
export function buildMotionManualPrompt(topic) {
  return `Create a short motion-graphics script explaining: ${topic}

Respond with ONLY a JSON object (no markdown fences, no commentary) shaped exactly like this:

{
  "scene": {"name": "...", "duration": 12, "fps": 30, "background": "#161616", "width": 800, "height": 500},
  "markers": [{"name": "reveal", "time": 1.0}],
  "camera": null,
  "layers": [
    {
      "name": "title", "type": "text", "text": "...", "fontSize": 48, "color": "#ffffff",
      "x": 400, "y": 250, "format": "text",
      "keyframes": [
        {"property": "opacity", "points": [
          {"time": {"offset": 0}, "value": 0},
          {"time": {"marker": "reveal", "offset": 0}, "value": 1, "easing": "easeOut"}
        ]}
      ]
    }
  ]
}

Rules:
- layer "type" must be one of: rect, circle, text, polygon, arrow, line, group, caption, emphasis
- keyframe "property" must be one of: x, y, scale, rotation, opacity, color
- "time" is either {"marker": "name", "offset": seconds-after-it} or {"offset": seconds} for an absolute time (omit marker)
- "easing" is one of: linear, easeIn, easeOut, easeInOut, bounce, elastic, back
- an "emphasis" layer needs "at" (a time object) and "style" (pop, slideup, fade, or zoom) -- no manual keyframes
- set "format": "formula" only for real mathematical notation (valid KaTeX/LaTeX) on a text/caption/emphasis layer, never for plain words
- keep duration reasonable, 8-45 seconds for one concept
- 1-40 layers, unique names`;
}
