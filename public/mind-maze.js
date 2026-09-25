// mind-maze.js — MindMaze v1 (Phase 1: Deterministic Chamber Graph Builder & Read-Only Data Layer)
//
// Pure side-mode spatial graph generator for a single deck's due cards.
// Strictly adheres to Lernin platform invariants:
//   1. Imports ONLY from ./db.js (never imports from app.js).
//   2. 100% read-only against IndexedDB FSRS fields and reviewLog — zero writes to cards or reviewLog.
//   3. Unlock gates are non-suspended due cards only, capped at MAZE_MAX_CHAMBERS = 12 per run.
//   4. Deterministic layout and DAG footpath synthesis seeded by (deckId + local dayKey).

import {
  getCardsByDeck,
  getRelationshipsFrom,
  getSetting,
  MASTERY_STABILITY_DAYS
} from './db.js';

export const MAZE_MAX_CHAMBERS = 12;
export const CHAMBER_RADIUS_MIN = 18;
export const CHAMBER_RADIUS_MAX = 34;

/**
 * Formats an epoch ms timestamp into a local calendar day key ('YYYY-MM-DD').
 *
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function toMazeDayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Deterministic 32-bit FNV-1a string hash mapped to a unit float in [0, 1).
 *
 * @param {string} str
 * @returns {number}
 */
export function hashToUnit(str) {
  const s = String(str ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Creates a deterministic pseudo-random number generator in [0, 1) seeded by a string.
 *
 * @param {string} seedStr
 * @returns {() => number}
 */
export function createSeededRng(seedStr) {
  let state = Math.floor(hashToUnit(seedStr) * 4294967296) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function nextUnit() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 4294967296;
  };
}

/**
 * Returns true if a card record is active (not suspended / leeched).
 * Does not mutate the card.
 *
 * @param {object} card
 * @returns {boolean}
 */
export function isCardActiveForMaze(card) {
  if (!card || typeof card !== 'object') return false;
  if (card.suspended === true || card.state === 'suspended') return false;
  return true;
}

/**
 * Resolves the numeric due timestamp (epoch ms) for a card without mutating it.
 * New cards without an explicit due_date default to 0 so they sort as immediately eligible.
 *
 * @param {object} card
 * @returns {number}
 */
function resolveDueTimestamp(card) {
  if (typeof card.due_date === 'number' && Number.isFinite(card.due_date)) {
    return card.due_date;
  }
  if (typeof card.due === 'number' && Number.isFinite(card.due)) {
    return card.due;
  }
  if (card.state === 'new') {
    return 0;
  }
  return Infinity;
}

/**
 * Exact filter for MindMaze gate eligibility:
 *   - Must be active (`!card.suspended && card.state !== 'suspended'`).
 *   - Must be currently due (`due_date <= nowMs` or `due <= nowMs`), OR `state === 'new'`
 *     with no future `due_date`.
 *
 * @param {object} card
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function isCardDueForMaze(card, nowMs = Date.now()) {
  if (!isCardActiveForMaze(card)) return false;
  const dueTs = resolveDueTimestamp(card);
  return dueTs <= nowMs;
}

/**
 *Normalizes a relationship lookup structure (Map or plain object) into an array
 * of `{ cardId, type }` entries for a given source card ID.
 *
 * @param {Map<string, Array>|Object} relationshipsByCardId
 * @param {string} cardId
 * @returns {Array<{ cardId: string, type: 'dependsOn'|'related' }>}
 */
function getRelEntries(relationshipsByCardId, cardId) {
  if (!relationshipsByCardId) return [];
  const raw = relationshipsByCardId instanceof Map
    ? relationshipsByCardId.get(cardId)
    : relationshipsByCardId[cardId];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && !r.targetMissing && (r.cardId || r.toCardId))
    .map((r) => ({
      cardId: String(r.cardId ?? r.toCardId),
      type: r.type === 'dependsOn' ? 'dependsOn' : 'related'
    }));
}

/**
 * Selects up to `maxChambers` (default 12) non-suspended due cards deterministically.
 * Priority order:
 *   1. Intra-due-pool relationship connectivity (`dependsOn` / `related` links between due cards)
 *      plus earliest `due_date` first.
 *   2. Connected due partners of selected cards are pulled in immediately so relationship edges
 *      stay intact within the 12-chamber run.
 *   3. Remaining slots fill in strict `(due_date ASC, degree DESC, id ASC)` order.
 *
 * Never mutates the input array or any card object.
 *
 * @param {Array<object>} cards
 * @param {Map<string, Array>|Object} [relationshipsByCardId]
 * @param {object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {number} [opts.maxChambers=MAZE_MAX_CHAMBERS]
 * @returns {Array<object>}
 */
export function selectMazeDueCards(
  cards,
  relationshipsByCardId = new Map(),
  { nowMs = Date.now(), maxChambers = MAZE_MAX_CHAMBERS } = {}
) {
  if (!Array.isArray(cards) || cards.length === 0) return [];
  const duePool = cards.filter((c) => isCardDueForMaze(c, nowMs));
  if (duePool.length === 0) return [];

  const dueById = new Map(duePool.map((c) => [String(c.id), c]));

  // Build undirected adjacency within the due pool so we know each card's connectivity
  const neighborsByCardId = new Map();
  for (const c of duePool) {
    neighborsByCardId.set(String(c.id), new Set());
  }

  for (const c of duePool) {
    const cid = String(c.id);
    const rels = getRelEntries(relationshipsByCardId, cid);
    for (const r of rels) {
      if (r.cardId !== cid && dueById.has(r.cardId)) {
        neighborsByCardId.get(cid).add(r.cardId);
        neighborsByCardId.get(r.cardId).add(cid);
      }
    }
  }

  const compareDueAndId = (a, b) => {
    const dueA = resolveDueTimestamp(a);
    const dueB = resolveDueTimestamp(b);
    if (dueA !== dueB) return dueA - dueB;
    const degA = neighborsByCardId.get(String(a.id))?.size || 0;
    const degB = neighborsByCardId.get(String(b.id))?.size || 0;
    if (degA !== degB) return degB - degA;
    return String(a.id).localeCompare(String(b.id));
  };

  // Primary ranking: prioritize due cards that participate in intra-due relationships,
  // ordered by earliest due_date, then remaining due cards by earliest due_date.
  const ranked = [...duePool].sort((a, b) => {
    const degA = neighborsByCardId.get(String(a.id))?.size || 0;
    const degB = neighborsByCardId.get(String(b.id))?.size || 0;
    const hasRelA = degA > 0 ? 1 : 0;
    const hasRelB = degB > 0 ? 1 : 0;
    if (hasRelA !== hasRelB) return hasRelB - hasRelA;
    return compareDueAndId(a, b);
  });

  if (ranked.length <= maxChambers) {
    return [...ranked].sort(compareDueAndId);
  }

  const selected = [];
  const selectedIds = new Set();

  for (const candidate of ranked) {
    if (selected.length >= maxChambers) break;
    const cid = String(candidate.id);
    if (!selectedIds.has(cid)) {
      selected.push(candidate);
      selectedIds.add(cid);
    }
    // Pull in directly related due neighbors so relationship edges are preserved inside the 12-cap
    const neighborIds = Array.from(neighborsByCardId.get(cid) || [])
      .map((nid) => dueById.get(nid))
      .filter(Boolean)
      .sort(compareDueAndId);
    for (const neighbor of neighborIds) {
      if (selected.length >= maxChambers) break;
      const nid = String(neighbor.id);
      if (!selectedIds.has(nid)) {
        selected.push(neighbor);
        selectedIds.add(nid);
      }
    }
  }

  return selected.sort(compareDueAndId);
}

/**
 * Pure helper to extract valid day-scoped `clearedCardIds` from a persisted `mindMazeState`
 * setting record. If `dayKey` or `deckId` does not match, returns an empty array.
 *
 * @param {object|null} stateRecord
 * @param {string} deckId
 * @param {string} dayKey
 * @returns {Array<string>}
 */
export function resolveClearedCardIdsFromState(stateRecord, deckId, dayKey) {
  if (!stateRecord || typeof stateRecord !== 'object') return [];

  // Support either direct per-deck state or keyed `byDeck[deckId]` container
  const candidate = (stateRecord.byDeck && stateRecord.byDeck[deckId])
    ? stateRecord.byDeck[deckId]
    : stateRecord;

  if (!candidate || typeof candidate !== 'object') return [];
  if (candidate.dayKey !== dayKey) return [];
  if (candidate.deckId && String(candidate.deckId) !== String(deckId)) return [];
  if (!Array.isArray(candidate.clearedCardIds)) return [];

  return candidate.clearedCardIds.map((id) => String(id));
}

/**
 * Reads day-scoped `clearedCardIds` from IndexedDB `settings` store (`mindMaze:<deckId>`
 * or `mindMazeState`) without performing any database writes.
 *
 * @param {string} deckId
 * @param {object} [opts]
 * @param {string} [opts.dayKey]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {Promise<Array<string>>}
 */
export async function readDeckMazeClearedIds(deckId, { dayKey = null, nowMs = Date.now() } = {}) {
  const resolvedDayKey = dayKey || toMazeDayKey(nowMs);
  try {
    const perDeck = await getSetting(`mindMaze:${deckId}`);
    const fromPerDeck = resolveClearedCardIdsFromState(perDeck, deckId, resolvedDayKey);
    if (fromPerDeck.length > 0) return fromPerDeck;

    const shared = await getSetting('mindMazeState');
    return resolveClearedCardIdsFromState(shared, deckId, resolvedDayKey);
  } catch {
    return [];
  }
}

/**
 * Pure synchronous chamber graph builder for a single deck.
 *
 * Returns one of three structured states:
 *   1. `status: 'EMPTY_DECK'` — deck has 0 active (non-suspended) cards in total.
 *   2. `status: 'SANCTUARY'`  — deck has active cards, but 0 cards are currently due.
 *   3. `status: 'ACTIVE'`     — deck has 1..12 chamber nodes and DAG footpaths built from due cards.
 *
 * @param {object} params
 * @param {string} params.deckId
 * @param {Array<object>} params.cards - all cards belonging to the deck
 * @param {Map<string, Array>|Object} [params.relationshipsByCardId] - map of cardId -> relationship list
 * @param {Array<string>} [params.clearedCardIds] - optional card IDs already cleared today
 * @param {number} [params.nowMs=Date.now()]
 * @param {string} [params.dayKey]
 * @param {number} [params.maxChambers=MAZE_MAX_CHAMBERS]
 * @returns {object}
 */
export function buildChamberGraph({
  deckId,
  cards = [],
  relationshipsByCardId = new Map(),
  clearedCardIds = [],
  nowMs = Date.now(),
  dayKey = null,
  maxChambers = MAZE_MAX_CHAMBERS
} = {}) {
  const resolvedDeckId = String(deckId || 'default-deck');
  const resolvedDayKey = dayKey || toMazeDayKey(nowMs);
  const safeCards = Array.isArray(cards) ? cards : [];

  const activeCards = safeCards.filter((c) => isCardActiveForMaze(c));

  // 1. Zero-total-cards path (distinct from zero-due sanctuary)
  if (activeCards.length === 0) {
    return {
      status: 'EMPTY_DECK',
      isEmptyDeck: true,
      isSanctuary: false,
      deckId: resolvedDeckId,
      dayKey: resolvedDayKey,
      totalActiveCards: 0,
      totalDueCards: 0,
      truncatedDueCount: 0,
      entryNodeId: null,
      nodes: [],
      edges: []
    };
  }

  const allDueCards = activeCards.filter((c) => isCardDueForMaze(c, nowMs));

  // 2. Zero-due path (Illuminated Sanctuary state — caught up!)
  if (allDueCards.length === 0) {
    return {
      status: 'SANCTUARY',
      isEmptyDeck: false,
      isSanctuary: true,
      deckId: resolvedDeckId,
      dayKey: resolvedDayKey,
      totalActiveCards: activeCards.length,
      totalDueCards: 0,
      truncatedDueCount: 0,
      entryNodeId: null,
      message: 'All paths in this territory are clear today. Wander the clearings freely, or return tomorrow when the mist rolls back in.',
      nodes: [],
      edges: []
    };
  }

  // 3. Active due-card chamber graph (up to MAZE_MAX_CHAMBERS = 12)
  const selectedCards = selectMazeDueCards(activeCards, relationshipsByCardId, {
    nowMs,
    maxChambers
  });
  const count = selectedCards.length;
  const truncatedDueCount = Math.max(0, allDueCards.length - count);
  const rng = createSeededRng(`${resolvedDeckId}:${resolvedDayKey}`);

  // Compute deterministic tiered island positions (Entry at tier 0 bottom, ascending toward summit)
  // Tier layout: [1] -> [2..3] -> [2..3] -> ... -> [1]
  const tiers = [];
  if (count === 1) {
    tiers.push([0]);
  } else {
    tiers.push([0]); // Entry chamber is always alone at tier 0
    let idx = 1;
    const middleEnd = count > 2 ? count - 1 : count;
    while (idx < middleEnd) {
      const remainingMiddle = middleEnd - idx;
      const tierWidth = remainingMiddle === 1 ? 1 : (rng() < 0.55 ? 2 : Math.min(3, remainingMiddle));
      const row = [];
      for (let k = 0; k < tierWidth && idx < middleEnd; k++) {
        row.push(idx++);
      }
      tiers.push(row);
    }
    if (count > 2) {
      tiers.push([count - 1]); // Summit chamber at top tier
    }
  }

  const coordsByIndex = new Array(count);
  const numTiers = tiers.length;
  const ySpan = Math.min(360, Math.max(120, (numTiers - 1) * 95));
  const yStart = ySpan / 2; // bottom
  const yStep = numTiers > 1 ? ySpan / (numTiers - 1) : 0;

  for (let t = 0; t < numTiers; t++) {
    const row = tiers[t];
    const baseY = numTiers === 1 ? 0 : yStart - t * yStep;
    const rowWidth = (row.length - 1) * 130;
    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const nodeIdx = row[cIdx];
      const cardId = String(selectedCards[nodeIdx].id);
      const jitterX = (hashToUnit(`${resolvedDeckId}:${resolvedDayKey}:x:${cardId}`) - 0.5) * 24;
      const jitterY = (hashToUnit(`${resolvedDeckId}:${resolvedDayKey}:y:${cardId}`) - 0.5) * 18;
      const baseX = row.length === 1 ? 0 : -rowWidth / 2 + cIdx * 130;
      coordsByIndex[nodeIdx] = {
        x: Math.round((baseX + jitterX) * 10) / 10,
        y: Math.round((baseY + jitterY) * 10) / 10,
        tier: t
      };
    }
  }

  const nodeIndexByCardId = new Map(selectedCards.map((c, i) => [String(c.id), i]));
  const nodeIdForIndex = (i) => `chamber-${String(selectedCards[i].id)}`;

  // Build edges:
  // Step A: Prefer real dependsOn / related edges among the selected due cards
  const edges = [];
  const edgeKeySet = new Set();
  const outDegree = new Array(count).fill(0);
  const inDegree = new Array(count).fill(0);

  const addDirectedEdge = (fromIdx, toIdx, kind, type) => {
    if (fromIdx === toIdx) return false;
    // Enforce strict DAG order (lower index -> higher index) so there are never cycles
    const u = Math.min(fromIdx, toIdx);
    const v = Math.max(fromIdx, toIdx);
    const key = `${u}->${v}`;
    if (edgeKeySet.has(key)) return false;
    edgeKeySet.add(key);
    outDegree[u]++;
    inDegree[v]++;
    edges.push({
      fromId: nodeIdForIndex(u),
      toId: nodeIdForIndex(v),
      fromCardId: String(selectedCards[u].id),
      toCardId: String(selectedCards[v].id),
      kind, // 'relationship' | 'seeded'
      type  // 'dependsOn' | 'related' | 'footpath'
    });
    return true;
  };

  for (let i = 0; i < count; i++) {
    const cid = String(selectedCards[i].id);
    const rels = getRelEntries(relationshipsByCardId, cid);
    for (const rel of rels) {
      const targetIdx = nodeIndexByCardId.get(rel.cardId);
      if (targetIdx !== undefined && targetIdx !== i) {
        addDirectedEdge(i, targetIdx, 'relationship', rel.type);
      }
    }
  }

  // Step B: Fill remaining reachability with a seeded DAG (branch factor 1–2)
  // Ensure every node j > 0 has at least one incoming edge from some i < j
  for (let j = 1; j < count; j++) {
    if (inDegree[j] === 0) {
      // Candidate parents: earlier nodes with outDegree < 2, preferring closer tiers
      const candidates = [];
      for (let i = j - 1; i >= 0; i--) {
        if (outDegree[i] < 2) candidates.push(i);
      }
      const pool = candidates.length > 0 ? candidates : [j - 1];
      // Pick deterministically from the top 2 closest candidates
      const topChoices = pool.slice(0, Math.min(2, pool.length));
      const chosenParent = topChoices[Math.floor(rng() * topChoices.length)];
      addDirectedEdge(chosenParent, j, 'seeded', 'footpath');
    }
  }

  // Ensure every non-summit node i < count - 1 has at least 1 outgoing edge (and up to 2 on entry/branch nodes)
  for (let i = 0; i < count - 1; i++) {
    const targetBranchFactor = (i === 0 && count >= 3) ? 2 : 1;
    while (outDegree[i] < targetBranchFactor) {
      // Pick a higher-index node j > i, preferring nodes in the next tier
      let bestTarget = null;
      for (let j = i + 1; j < count; j++) {
        if (!edgeKeySet.has(`${i}->${j}`)) {
          bestTarget = j;
          break;
        }
      }
      if (bestTarget === null) break;
      addDirectedEdge(i, bestTarget, 'seeded', 'footpath');
    }
  }

  // Compute initial node statuses ('CLEARED' | 'FRONTIER' | 'FOGGED')
  const clearedSet = new Set((clearedCardIds || []).map((id) => String(id)));
  const statuses = new Array(count).fill('FOGGED');

  for (let i = 0; i < count; i++) {
    const cid = String(selectedCards[i].id);
    if (clearedSet.has(cid)) {
      statuses[i] = 'CLEARED';
    }
  }

  // Entry chamber (index 0) starts FRONTIER if not already CLEARED
  if (statuses[0] !== 'CLEARED') {
    statuses[0] = 'FRONTIER';
  }

  // Any chamber with an incoming edge from a CLEARED chamber becomes FRONTIER
  for (const edge of edges) {
    const u = nodeIndexByCardId.get(edge.fromCardId);
    const v = nodeIndexByCardId.get(edge.toCardId);
    if (u !== undefined && v !== undefined && statuses[u] === 'CLEARED' && statuses[v] === 'FOGGED') {
      statuses[v] = 'FRONTIER';
    }
  }

  const nodes = selectedCards.map((card, i) => {
    const stability = typeof card.stability === 'number' && card.stability > 0 ? card.stability : 0;
    const mastery = Math.min(1, Math.max(0, stability / MASTERY_STABILITY_DAYS));
    const r = Math.round((CHAMBER_RADIUS_MIN + mastery * (CHAMBER_RADIUS_MAX - CHAMBER_RADIUS_MIN)) * 10) / 10;
    return {
      id: nodeIdForIndex(i),
      cardId: String(card.id),
      x: coordsByIndex[i].x,
      y: coordsByIndex[i].y,
      r,
      status: statuses[i],
      stability,
      mastery: Math.round(mastery * 1000) / 1000
    };
  });

  return {
    status: 'ACTIVE',
    isEmptyDeck: false,
    isSanctuary: false,
    deckId: resolvedDeckId,
    dayKey: resolvedDayKey,
    totalActiveCards: activeCards.length,
    totalDueCards: allDueCards.length,
    truncatedDueCount,
    entryNodeId: nodes[0]?.id || null,
    nodes,
    edges
  };
}

/**
 * Read-only async loader that queries a deck's cards, intra-deck relationships,
 * and optional day-scoped `mindMazeState` from IndexedDB (`db.js`), then builds
 * the deterministic MindMaze chamber graph. Performs ZERO database writes.
 *
 * @param {string} deckId
 * @param {object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {string} [opts.dayKey]
 * @param {number} [opts.maxChambers=MAZE_MAX_CHAMBERS]
 * @returns {Promise<object>}
 */
export async function loadDeckMazeGraph(
  deckId,
  { nowMs = Date.now(), dayKey = null, maxChambers = MAZE_MAX_CHAMBERS } = {}
) {
  const resolvedDayKey = dayKey || toMazeDayKey(nowMs);
  const cards = await getCardsByDeck(deckId);
  const activeDueCards = (cards || []).filter((c) => isCardDueForMaze(c, nowMs));

  const relationshipsByCardId = new Map();
  await Promise.all(
    activeDueCards.map(async (c) => {
      try {
        const rels = await getRelationshipsFrom(c.id);
        relationshipsByCardId.set(String(c.id), rels || []);
      } catch {
        relationshipsByCardId.set(String(c.id), []);
      }
    })
  );

  const clearedCardIds = await readDeckMazeClearedIds(deckId, { dayKey: resolvedDayKey, nowMs });

  return buildChamberGraph({
    deckId,
    cards,
    relationshipsByCardId,
    clearedCardIds,
    nowMs,
    dayKey: resolvedDayKey,
    maxChambers
  });
}
