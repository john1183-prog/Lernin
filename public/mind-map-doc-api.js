// mind-map-doc-api.js
// All Mind Map v2 (document-derived, static) backend calls live here. No
// DOM access, no rendering — mirrors motion-api.js's own pattern, which
// mirrors api.js's. Same three credential paths as Motion Studio (BYOK /
// server-key-with-quota / manual-mode), reusing the same X-Client-Id
// mechanism (getMotionClientId() — genuinely just "an anonymous ID for
// this device", not actually Motion-specific despite the name; reused as
// -is rather than renamed to avoid touching Motion Studio's own working,
// already-shipped storage key).
//
// Deliberately NO offline retry queue here, unlike motionGenQueue. Motion
// Studio generation is the thing someone explicitly asked for right now;
// mind map generation is a best-effort side-call fired after cards
// generate successfully (see handleExtractedText in app.js) — if it fails
// or the device is offline, nothing is lost: the Documents view's "Mind
// Map" action generates on demand, using the saved summary as a fallback
// input if the original full text is no longer available (see
// saveMindMapForDocument's doc comment in db.js for the 'source' field
// this distinction is recorded under).

import { getApiConfig, getMotionClientId, saveMindMapForDocument } from './db.js';

const GENERATE_ENDPOINT = '/api/generate-mind-map';
const EXPAND_ENDPOINT = '/api/expand-mind-map';

async function hasByokConfig() {
  const config = await getApiConfig();
  return !!(
    config &&
    config.apiKey &&
    (config.provider === 'claude' || config.provider === 'gemini')
  );
}

async function mindMapRequestHeaders() {
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

/**
 * Generates a mind map for a document via whichever credential path
 * applies, saves it to IndexedDB on success (keyed by documentId,
 * overwriting any previous one for the same document). `source` is
 * caller-supplied ('full-text' or 'summary-fallback') and just gets
 * stored alongside the result — this function doesn't know or care which
 * kind of text it was handed, only the caller does (see handleExtractedText
 * and the Documents-view action in app.js for the two call sites).
 *
 * @param {string} retryOfError — pass the error from a previous attempt to
 *   make this a user-confirmed retry, same convention as
 *   motion-api.js's generateMotion(). Never call automatically in a loop.
 */
export async function generateMindMap(text, documentId, source, retryOfError = null) {
  try {
    const body = { text };
    if (retryOfError) body.retry_of_error = retryOfError;

    const response = await fetch(GENERATE_ENDPOINT, {
      method: 'POST',
      headers: await mindMapRequestHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      return { mindMap: null, retryable: false, error: await extractErrorMessage(response), status: response.status };
    }

    const data = await response.json();
    if (data.retryable) {
      return { mindMap: null, retryable: true, error: data.error };
    }

    await saveMindMapForDocument(documentId, data.mind_map, source);
    return { mindMap: data.mind_map, retryable: false, error: null };
  } catch (err) {
    return { mindMap: null, retryable: false, error: err.message };
  }
}

/**
 * Manual mode: validates + expands a topic tree pasted back after running
 * buildMindMapManualPrompt()'s output through the person's own AI chat.
 * No AI call happens here — mirrors expandMotionScriptManual().
 */
export async function expandMindMapManual(rawTree, documentId, source) {
  try {
    const response = await fetch(EXPAND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawTree)
    });
    if (!response.ok) {
      return { mindMap: null, error: await extractErrorMessage(response) };
    }
    const data = await response.json();
    await saveMindMapForDocument(documentId, data.mind_map, source);
    return { mindMap: data.mind_map, error: null };
  } catch (err) {
    return { mindMap: null, error: err.message };
  }
}

/**
 * Plain-text prompt for manual mode — ported 1:1 from
 * build_mind_map_manual_prompt() in api/index.py, which stays the single
 * source of truth. If that Python function ever changes, this needs
 * re-syncing using the byte-comparison process documented alongside
 * Motion Studio's equivalent (extract Python's output with a placeholder,
 * splice into this template literal, diff the two -- never hand-retype).
 */
export function buildMindMapManualPrompt(text) {
  return `Read the following document and produce a topic-tree mind map of it. Respond with ONLY a JSON object (no markdown fences, no commentary) shaped like this fully worked example. The subject below (photosynthesis) is unrelated to the document -- match its SHAPE, not its subject matter:

{
  "root": {
    "title": "Photosynthesis",
    "detail": "How plants convert light energy into chemical energy stored in sugar",
    "children": [
      {
        "title": "Light-Dependent Reactions", "detail": "Convert light energy into ATP and NADPH",
        "children": [
          {
            "title": "Photosystem II", "detail": "Absorbs light and splits water molecules",
            "children": [
              {"title": "Releases oxygen as a byproduct"},
              {"title": "Passes electrons down the transport chain"}
            ]
          },
          {"title": "Photosystem I", "detail": "Re-energizes electrons to produce NADPH"}
        ]
      },
      {
        "title": "Light-Independent Reactions", "detail": "The Calvin cycle -- builds sugar from CO2 using the ATP and NADPH made above",
        "children": [
          {"title": "Carbon fixation", "detail": "CO2 attaches to a 5-carbon molecule"},
          {"title": "Sugar production", "detail": "Produces G3P, which becomes glucose"}
        ]
      },
      {
        "title": "Requirements", "detail": "What the whole process depends on",
        "children": [
          {"title": "Sunlight"},
          {"title": "Water"},
          {"title": "Carbon dioxide"}
        ]
      }
    ]
  }
}

Rules:
- exactly four possible levels: root, then up to three more nested levels of "children" -- a leaf simply has no "children" key (or an empty list)
- "detail" is optional at every level -- include it whenever a node covers real content worth explaining (see "Photosystem II" above), skip it for simple self-evident leaves (see "Sunlight" above) rather than restating the title as a fake sentence
- depth doesn't have to be even across branches -- go four levels deep only where the material actually has that much to say (see "Photosystem II" vs. "Photosystem I" above), not as a pattern repeated everywhere
- base every node on what the document actually says, not on outside knowledge of the subject or generic padding
- total nodes across the whole tree: 3-40
- title up to 80 characters, detail up to 240 characters

Document:

${text}`;
}
