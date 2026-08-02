/* concept-graph.js — DEPRECATED
   Functionality absorbed into the spatial map (canvas.js L2/L3).
   This stub keeps any stale imports from breaking until fully removed.
*/

import { openDeckOnMap } from './canvas.js';

/**
 * @deprecated Use openDeckOnMap / initCanvasView({ deckId }) instead.
 */
export async function initConceptGraph(container, deckId, callbacks = {}) {
  console.warn('[Lernin] initConceptGraph is deprecated — routing to spatial map L2');
  return openDeckOnMap(container, deckId, {
    onExit: callbacks.onExit
  });
}
