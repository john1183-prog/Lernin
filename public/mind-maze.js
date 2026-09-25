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
  getDeck,
  getRelationshipsFrom,
  getSetting,
  saveSetting,
  MASTERY_STABILITY_DAYS
} from './db.js';
import {
  initSoundSetting,
  playNavigate,
  playFlip,
  playAgain,
  playHard,
  playGood,
  playEasy,
  playMazeFogLift,
  playSessionComplete
} from './sound.js';

export const MAZE_MAX_CHAMBERS = 12;
export const MAZE_MAX_ATTEMPTS = 200;
export const MAZE_ATTEMPTS_RETENTION_DAYS = 30;
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

export function getMazeSettingKey(deckId) {
  return `mindMaze:${String(deckId || 'default-deck')}`;
}

/**
 * Pure helper that computes the next persisted `mindMaze:<deckId>` settings record.
 * - Day-scopes `clearedCardIds`: if `prevRecord.dayKey !== dayKey`, previous `clearedCardIds`
 *   are discarded (fresh fog on a new calendar day).
 * - Appends the attempt to `attempts`, pruning entries older than 30 days and capping at
 *   `MAZE_MAX_ATTEMPTS` (200) ring buffer.
 *
 * @param {object|null} prevRecord
 * @param {object} params
 * @param {string} params.deckId
 * @param {string} [params.dayKey]
 * @param {string|null} [params.cardId]
 * @param {string|null} [params.grade]
 * @param {'unlocked'|'soft-fail'|null} [params.outcome]
 * @param {number} [params.nowMs=Date.now()]
 * @param {number} [params.maxAttempts=MAZE_MAX_ATTEMPTS]
 * @returns {object}
 */
export function buildNextDeckMazeState(
  prevRecord,
  {
    deckId,
    dayKey = null,
    cardId = null,
    grade = null,
    outcome = null,
    nowMs = Date.now(),
    maxAttempts = MAZE_MAX_ATTEMPTS
  } = {}
) {
  const resolvedDeckId = String(deckId || prevRecord?.deckId || 'default-deck');
  const resolvedDayKey = dayKey || toMazeDayKey(nowMs);
  const isSameDay = Boolean(
    prevRecord && typeof prevRecord === 'object' && prevRecord.dayKey === resolvedDayKey
  );

  const clearedSet = new Set(
    isSameDay && Array.isArray(prevRecord.clearedCardIds)
      ? prevRecord.clearedCardIds.map((id) => String(id))
      : []
  );

  if (cardId != null && outcome === 'unlocked') {
    clearedSet.add(String(cardId));
  }

  const cutoffMs = nowMs - MAZE_ATTEMPTS_RETENTION_DAYS * 86400000;
  const priorAttempts = Array.isArray(prevRecord?.attempts)
    ? prevRecord.attempts.filter(
        (a) => a && typeof a === 'object' && (typeof a.timestamp !== 'number' || a.timestamp >= cutoffMs)
      )
    : [];

  if (cardId != null && grade != null && outcome != null) {
    priorAttempts.push({
      cardId: String(cardId),
      grade: String(grade),
      outcome: String(outcome),
      dayKey: resolvedDayKey,
      timestamp: nowMs
    });
  }

  const boundedAttempts = priorAttempts.slice(-Math.max(1, maxAttempts));

  return {
    deckId: resolvedDeckId,
    dayKey: resolvedDayKey,
    clearedCardIds: Array.from(clearedSet),
    attempts: boundedAttempts,
    updatedAt: nowMs
  };
}

/**
 * Persists a MindMaze gate outcome (`unlocked` or `soft-fail`) into the IndexedDB
 * `settings` store under `mindMaze:<deckId>` (and mirrors into `mindMazeState.byDeck[deckId]`).
 * Strictly side-mode: never touches `cards` FSRS fields or `reviewLog`.
 *
 * @param {string} deckId
 * @param {object} [opts]
 * @param {string} [opts.cardId]
 * @param {string} [opts.grade]
 * @param {'unlocked'|'soft-fail'} [opts.outcome]
 * @param {string} [opts.dayKey]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {Promise<object|null>}
 */
export async function saveDeckMazeAttempt(
  deckId,
  { cardId, grade, outcome, dayKey = null, nowMs = Date.now() } = {}
) {
  if (!deckId) return null;
  const resolvedDeckId = String(deckId);
  const resolvedDayKey = dayKey || toMazeDayKey(nowMs);
  const key = getMazeSettingKey(resolvedDeckId);
  try {
    const prev = await getSetting(key);
    const nextRecord = buildNextDeckMazeState(prev, {
      deckId: resolvedDeckId,
      dayKey: resolvedDayKey,
      cardId,
      grade,
      outcome,
      nowMs
    });
    await saveSetting(key, nextRecord);

    // Mirror into shared `mindMazeState.byDeck[deckId]` container
    const shared = (await getSetting('mindMazeState')) || { byDeck: {} };
    const nextShared = {
      ...(typeof shared === 'object' && shared ? shared : {}),
      byDeck: {
        ...(shared && typeof shared.byDeck === 'object' ? shared.byDeck : {}),
        [resolvedDeckId]: nextRecord
      }
    };
    await saveSetting('mindMazeState', nextShared);
    return nextRecord;
  } catch {
    return null;
  }
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

  const allChambersAlreadyCleared = nodes.length > 0 && nodes.every((n) => n.status === 'CLEARED');

  return {
    status: allChambersAlreadyCleared ? 'SANCTUARY' : 'ACTIVE',
    isEmptyDeck: false,
    isSanctuary: allChambersAlreadyCleared,
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

// ===========================================================================
// Phase 2: Canvas 2D Terrain, Fog-of-War & Footpath Renderer
// ===========================================================================

export const SAND_HSL = { h: 38, s: 28, l: 78 };
export const OCHRE_HSL = { h: 32, s: 55, l: 55 };
export const MOSS_HSL = { h: 110, s: 32, l: 38 };
const HUE_JITTER_RANGE = 14;

/**
 * Linearly interpolates between two HSL color objects.
 *
 * @param {{h:number, s:number, l:number}} a
 * @param {{h:number, s:number, l:number}} b
 * @param {number} t - clamped to [0, 1]
 * @returns {{h:number, s:number, l:number}}
 */
export function lerpHsl(a, b, t) {
  const clamped = Math.min(1, Math.max(0, t));
  return {
    h: a.h + (b.h - a.h) * clamped,
    s: a.s + (b.s - a.s) * clamped,
    l: a.l + (b.l - a.l) * clamped
  };
}

/**
 * Maps mastery in [0, 1] and a seed ID to the unified terrain palette
 * (`SAND_HSL` novice -> `OCHRE_HSL` intermediate -> `MOSS_HSL` mastered).
 *
 * @param {number} mastery
 * @param {string} seedId
 * @returns {{h:number, s:number, l:number}}
 */
export function chamberColor(mastery = 0, seedId = '') {
  const m = Math.min(1, Math.max(0, Number(mastery) || 0));
  const base = m < 0.5
    ? lerpHsl(SAND_HSL, OCHRE_HSL, m / 0.5)
    : lerpHsl(OCHRE_HSL, MOSS_HSL, (m - 0.5) / 0.5);
  const jitter = (hashToUnit(`hue:${seedId}`) - 0.5) * 2 * HUE_JITTER_RANGE;
  return {
    h: Math.round((base.h + jitter) * 10) / 10,
    s: Math.round(base.s * 10) / 10,
    l: Math.round(base.l * 10) / 10
  };
}

/**
 * Resolves Light vs. Dark theme tokens (`data-theme` aware).
 *
 * @param {'light'|'dark'|null} [explicitTheme]
 * @returns {object}
 */
export function getMazeThemeTokens(explicitTheme = null) {
  let isDark = explicitTheme === 'dark';
  if (!explicitTheme && typeof document !== 'undefined' && document.documentElement) {
    isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  }
  if (isDark) {
    return {
      isDark: true,
      sky: '#0A0D10',
      horizon: '#1B252C',
      waterRipple: 'rgba(120, 165, 180, 0.08)',
      ink: '#EDEFF1',
      inkMuted: '#9BA8A0',
      surfaceGlass: 'rgba(20, 26, 31, 0.88)',
      surfaceBorder: 'rgba(155, 168, 160, 0.22)',
      mistRgb: '14, 20, 25',
      mistHighlightRgb: '34, 48, 56',
      lockedStroke: 'rgba(155, 168, 160, 0.34)',
      frontierHalo: 'rgba(235, 170, 62, 0.68)',
      frontierRing: '#F2B84B',
      clearedRing: '#66BB6A',
      roadUndercoat: '#8B6F47',
      roadTopcoat: '#D4B275',
      relRoadUndercoat: '#557A46',
      relRoadTopcoat: '#9CCC65'
    };
  }
  return {
    isDark: false,
    sky: '#E6EFE9',
    horizon: '#C9DBD0',
    waterRipple: 'rgba(55, 95, 85, 0.09)',
    ink: '#1A211C',
    inkMuted: '#4E5E52',
    surfaceGlass: 'rgba(248, 250, 248, 0.92)',
    surfaceBorder: 'rgba(78, 94, 82, 0.22)',
    mistRgb: '214, 224, 218',
    mistHighlightRgb: '235, 241, 237',
    lockedStroke: 'rgba(78, 94, 82, 0.38)',
    frontierHalo: 'rgba(214, 134, 28, 0.58)',
    frontierRing: '#C97A16',
    clearedRing: '#2E7D32',
    roadUndercoat: '#8B6F47',
    roadTopcoat: '#C4A265',
    relRoadUndercoat: '#3E6B36',
    relRoadTopcoat: '#689F38'
  };
}

/**
 * Generates deterministic irregular polygon points for an island or chamber pebble.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} baseRadius
 * @param {string} seedId
 * @param {number} [pointCount=14]
 * @param {number} [irregularity=0.22]
 * @returns {Array<{x:number, y:number}>}
 */
export function buildOrganicPolygonPoints(
  cx,
  cy,
  baseRadius,
  seedId,
  pointCount = 14,
  irregularity = 0.22
) {
  const pts = [];
  const minScale = 1 - irregularity;
  for (let i = 0; i < pointCount; i++) {
    const angle = (i / pointCount) * Math.PI * 2;
    const noise = hashToUnit(`${i * 997}:${seedId}`);
    const r = baseRadius * (minScale + irregularity * 1.35 * noise);
    pts.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r
    });
  }
  return pts;
}

function traceSmoothPolygon(ctx, points) {
  if (!points || points.length < 3) return;
  ctx.beginPath();
  const len = points.length;
  const firstMidX = (points[len - 1].x + points[0].x) / 2;
  const firstMidY = (points[len - 1].y + points[0].y) / 2;
  ctx.moveTo(firstMidX, firstMidY);
  for (let i = 0; i < len; i++) {
    const curr = points[i];
    const next = points[(i + 1) % len];
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  }
  ctx.closePath();
}

/**
 * Pure/direct Canvas 2D frame renderer for MindMaze v1.
 * Draws the environment backdrop, island landform, footpaths (relationship vs seeded,
 * locked vs unlocked), chambers (`FOGGED`, `FRONTIER`, `CLEARED`), and drifting procedural fog.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} graph - output of `buildChamberGraph` / `loadDeckMazeGraph`
 * @param {{ width: number, height: number, camera?: { x: number, y: number, zoom: number } }} viewport
 * @param {object} [opts]
 * @param {'light'|'dark'|null} [opts.theme]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {string|null} [opts.hoveredNodeId=null]
 * @param {Map<string, string>|Object} [opts.cardLabelsById]
 * @returns {{ renderedNodes: number, renderedEdges: number, statusCounts: { FOGGED: number, FRONTIER: number, CLEARED: number } }}
 */
export function drawMindMazeFrame(ctx, graph, viewport = { width: 800, height: 600 }, opts = {}) {
  const width = Math.max(1, viewport.width || 800);
  const height = Math.max(1, viewport.height || 600);
  const cam = viewport.camera || { x: 0, y: 0, zoom: 1 };
  const nowMs = opts.nowMs ?? Date.now();
  const tokens = getMazeThemeTokens(opts.theme || null);
  const hoveredNodeId = opts.hoveredNodeId || null;
  const cardLabelsById = opts.cardLabelsById || null;

  const worldToScreen = (wx, wy) => ({
    x: (wx - cam.x) * cam.zoom + width / 2,
    y: (wy - cam.y) * cam.zoom + height / 2
  });

  // 1. Sky-to-horizon environment backdrop
  ctx.save();
  const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
  skyGrad.addColorStop(0, tokens.sky);
  skyGrad.addColorStop(1, tokens.horizon);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle ambient water horizon ripples
  const sway = Math.sin(nowMs / 1600) * 6;
  ctx.strokeStyle = tokens.waterRipple;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) {
    const ry = height * (0.22 + i * 0.2) + Math.sin(nowMs / 1900 + i) * 3;
    ctx.beginPath();
    ctx.moveTo(width * 0.1 + sway, ry);
    ctx.lineTo(width * 0.9 - sway, ry);
    ctx.stroke();
  }
  ctx.restore();

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const deckId = String(graph?.deckId || 'maze-island');

  // Compute average mastery for the island terrain hue
  const avgMastery = nodes.length > 0
    ? nodes.reduce((acc, n) => acc + (n.mastery || 0), 0) / nodes.length
    : (graph?.status === 'SANCTUARY' ? 0.85 : 0.25);
  const islandHsl = chamberColor(avgMastery, deckId);

  // 2. Procedural Island Silhouette encompassing the chamber layout
  const islandCenter = worldToScreen(0, 0);
  const baseIslandWorldRadius = nodes.length > 0 ? 275 : 185;
  const islandScreenRadius = Math.max(80, baseIslandWorldRadius * cam.zoom);
  const coastPts = buildOrganicPolygonPoints(
    islandCenter.x + Math.sin(nowMs / 2600) * 1.4,
    islandCenter.y + Math.cos(nowMs / 3100) * 1.1,
    islandScreenRadius,
    `island:${deckId}`,
    16,
    0.18
  );

  ctx.save();
  // Soft shoreline glow
  const glowGrad = ctx.createRadialGradient(
    islandCenter.x, islandCenter.y, islandScreenRadius * 0.2,
    islandCenter.x, islandCenter.y, islandScreenRadius * 1.25
  );
  glowGrad.addColorStop(0, `hsla(${islandHsl.h}, ${islandHsl.s}%, ${islandHsl.l}%, 0.26)`);
  glowGrad.addColorStop(1, `hsla(${islandHsl.h}, ${islandHsl.s}%, ${islandHsl.l}%, 0)`);
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(islandCenter.x, islandCenter.y, islandScreenRadius * 1.25, 0, Math.PI * 2);
  ctx.fill();

  // Island landmass fill
  traceSmoothPolygon(ctx, coastPts);
  const landGrad = ctx.createRadialGradient(
    islandCenter.x, islandCenter.y, 0,
    islandCenter.x, islandCenter.y, islandScreenRadius
  );
  const lBoost = tokens.isDark ? -12 : 6;
  landGrad.addColorStop(0, `hsl(${islandHsl.h}, ${islandHsl.s}%, ${Math.min(92, Math.max(18, islandHsl.l + lBoost + 10))}%)`);
  landGrad.addColorStop(0.68, `hsl(${islandHsl.h}, ${islandHsl.s}%, ${Math.min(88, Math.max(15, islandHsl.l + lBoost))}%)`);
  landGrad.addColorStop(1, `hsl(${islandHsl.h}, ${Math.min(100, islandHsl.s + 8)}%, ${Math.max(12, islandHsl.l + lBoost - 10)}%)`);
  ctx.fillStyle = landGrad;
  ctx.fill();

  ctx.lineWidth = 2;
  ctx.strokeStyle = tokens.isDark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(55, 75, 60, 0.32)';
  ctx.stroke();

  // Elevation contour rings
  for (let ring = 1; ring <= 2; ring++) {
    const ringPts = buildOrganicPolygonPoints(
      islandCenter.x,
      islandCenter.y,
      islandScreenRadius * (0.45 + ring * 0.22),
      `island:${deckId}`,
      16,
      0.16
    );
    traceSmoothPolygon(ctx, ringPts);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `hsla(${islandHsl.h}, ${islandHsl.s}%, ${islandHsl.l}%, 0.25)`;
    ctx.stroke();
  }

  // Scattered terrain tufts (seeded by deckId)
  const tuftCount = Math.min(28, Math.max(8, (graph?.totalActiveCards || 6) * 2));
  ctx.fillStyle = `hsla(${islandHsl.h}, ${Math.min(100, islandHsl.s + 12)}%, ${Math.max(15, islandHsl.l - 14)}%, 0.32)`;
  for (let t = 0; t < tuftCount; t++) {
    const angle = hashToUnit(`tuft-a:${deckId}:${t}`) * Math.PI * 2;
    const dist = Math.sqrt(hashToUnit(`tuft-d:${deckId}:${t}`)) * islandScreenRadius * 0.72;
    const tx = islandCenter.x + Math.cos(angle) * dist;
    const ty = islandCenter.y + Math.sin(angle) * dist;
    ctx.beginPath();
    ctx.arc(tx, ty, Math.max(1.5, 2.2 * cam.zoom), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (nodes.length === 0) {
    // Sanctuary decorative lanterns when caught up
    if (graph?.status === 'SANCTUARY') {
      for (let k = 0; k < 5; k++) {
        const ang = (k / 5) * Math.PI * 2 + nowMs / 4000;
        const dist = islandScreenRadius * 0.42;
        const lx = islandCenter.x + Math.cos(ang) * dist;
        const ly = islandCenter.y + Math.sin(ang) * dist;
        const lGrad = ctx.createRadialGradient(lx, ly, 0, lx, ly, 26 * cam.zoom);
        lGrad.addColorStop(0, tokens.frontierHalo);
        lGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = lGrad;
        ctx.beginPath();
        ctx.arc(lx, ly, 26 * cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return { renderedNodes: 0, renderedEdges: 0, statusCounts: { FOGGED: 0, FRONTIER: 0, CLEARED: 0 } };
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // 3. Footpaths (Edges: relationship vs seeded, unlocked vs locked)
  let renderedEdges = 0;
  for (const edge of edges) {
    const u = nodeById.get(edge.fromId);
    const v = nodeById.get(edge.toId);
    if (!u || !v) continue;

    const su = worldToScreen(u.x, u.y);
    const sv = worldToScreen(v.x, v.y);
    const isRelationship = edge.kind === 'relationship';
    const isUnlocked = u.status === 'CLEARED' || (u.status === 'FRONTIER' && v.status === 'CLEARED');
    const isSemiVisible = u.status === 'FRONTIER' || v.status === 'FRONTIER';

    ctx.save();
    if (isUnlocked) {
      // Double-line worn-earth road (brighter moss-tinted track for real relationship edges)
      const baseW = (isRelationship ? 5.2 : 4.0) * cam.zoom;
      ctx.globalAlpha = 0.88;
      ctx.strokeStyle = isRelationship ? tokens.relRoadUndercoat : tokens.roadUndercoat;
      ctx.lineWidth = Math.max(2, baseW);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(su.x, su.y);
      ctx.lineTo(sv.x, sv.y);
      ctx.stroke();

      ctx.strokeStyle = isRelationship ? tokens.relRoadTopcoat : tokens.roadTopcoat;
      ctx.lineWidth = Math.max(1, baseW * 0.46);
      ctx.beginPath();
      ctx.moveTo(su.x, su.y);
      ctx.lineTo(sv.x, sv.y);
      ctx.stroke();
    } else {
      // Locked path: faint dotted footpath waiting to be uncovered
      ctx.globalAlpha = isSemiVisible ? 0.44 : 0.22;
      ctx.strokeStyle = isRelationship ? tokens.frontierRing : tokens.lockedStroke;
      ctx.lineWidth = Math.max(1.2, (isRelationship ? 2.4 : 1.7) * cam.zoom);
      ctx.setLineDash(isRelationship ? [5, 5] : [3, 6]);
      ctx.beginPath();
      ctx.moveTo(su.x, su.y);
      ctx.lineTo(sv.x, sv.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Directional chevron at midpoint for `dependsOn` relationship footpaths
    if (isRelationship && edge.type === 'dependsOn') {
      const mx = (su.x + sv.x) / 2;
      const my = (su.y + sv.y) / 2;
      const ang = Math.atan2(sv.y - su.y, sv.x - su.x);
      const hs = Math.max(5, 7 * cam.zoom);
      ctx.fillStyle = isUnlocked ? tokens.relRoadTopcoat : tokens.frontierRing;
      ctx.globalAlpha = isUnlocked ? 0.9 : 0.55;
      ctx.beginPath();
      ctx.moveTo(mx + hs * Math.cos(ang), my + hs * Math.sin(ang));
      ctx.lineTo(mx - hs * Math.cos(ang - 0.55), my - hs * Math.sin(ang - 0.55));
      ctx.lineTo(mx - hs * Math.cos(ang + 0.55), my - hs * Math.sin(ang + 0.55));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    renderedEdges++;
  }

  // 4. Procedural Fog-of-War Veil over FOGGED Regions
  // Draw soft drifting mist clouds over each FOGGED chamber before rendering FRONTIER/CLEARED clearings on top
  const statusCounts = { FOGGED: 0, FRONTIER: 0, CLEARED: 0 };
  for (const node of nodes) {
    if (node.status in statusCounts) statusCounts[node.status]++;
    if (node.status !== 'FOGGED') continue;

    const sn = worldToScreen(node.x, node.y);
    const nr = Math.max(12, node.r * cam.zoom);
    const phase = hashToUnit(`fog:${node.id}`) * Math.PI * 2;
    const driftX = Math.sin(nowMs / 1100 + phase) * 5 * cam.zoom;
    const driftY = Math.cos(nowMs / 1400 + phase) * 4 * cam.zoom;
    const fogR = nr * 2.85;

    ctx.save();
    const mistGrad = ctx.createRadialGradient(
      sn.x + driftX, sn.y + driftY, nr * 0.25,
      sn.x + driftX, sn.y + driftY, fogR
    );
    mistGrad.addColorStop(0, `rgba(${tokens.mistRgb}, 0.78)`);
    mistGrad.addColorStop(0.55, `rgba(${tokens.mistHighlightRgb}, 0.48)`);
    mistGrad.addColorStop(1, `rgba(${tokens.mistRgb}, 0)`);
    ctx.fillStyle = mistGrad;
    ctx.beginPath();
    ctx.arc(sn.x + driftX, sn.y + driftY, fogR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 5. Chamber Nodes (`FOGGED` vs `FRONTIER` vs `CLEARED`)
  const unlockRipples = Array.isArray(opts.unlockRipples) ? opts.unlockRipples : [];
  const shimmerMap = opts.shimmerByNodeId instanceof Map ? opts.shimmerByNodeId : null;

  // Draw active radial fog-retreat ripples behind unlocked chambers
  for (const ripple of unlockRipples) {
    const progress = Math.min(1, Math.max(0, (nowMs - ripple.startMs) / (ripple.durationMs || 550)));
    if (progress >= 1) continue;
    const sr = worldToScreen(ripple.x, ripple.y);
    const baseR = Math.max(14, (ripple.r || 24) * cam.zoom);
    const currentR = baseR * (1 + progress * 2.3);
    const alpha = (1 - progress) * 0.62;

    ctx.save();
    const ripGrad = ctx.createRadialGradient(sr.x, sr.y, baseR * 0.4, sr.x, sr.y, currentR);
    ripGrad.addColorStop(0, `rgba(102, 187, 106, ${(alpha * 0.45).toFixed(3)})`);
    ripGrad.addColorStop(0.7, `rgba(242, 184, 75, ${alpha.toFixed(3)})`);
    ripGrad.addColorStop(1, 'rgba(242, 184, 75, 0)');
    ctx.fillStyle = ripGrad;
    ctx.beginPath();
    ctx.arc(sr.x, sr.y, currentR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const node of nodes) {
    let shimmerDx = 0;
    if (shimmerMap && shimmerMap.has(node.id)) {
      const startMs = shimmerMap.get(node.id);
      const t = (nowMs - startMs) / 320;
      if (t >= 0 && t < 1) {
        shimmerDx = Math.sin(t * Math.PI * 5) * (1 - t) * 7 * cam.zoom;
      }
    }

    const rawScreen = worldToScreen(node.x, node.y);
    const sn = { x: rawScreen.x + shimmerDx, y: rawScreen.y };
    const nr = Math.max(12, node.r * cam.zoom);
    const cHsl = chamberColor(node.mastery, node.cardId);
    const isHovered = hoveredNodeId === node.id;
    const pebblePts = buildOrganicPolygonPoints(sn.x, sn.y, nr, `chamber:${node.id}`, 12, 0.14);

    ctx.save();

    if (node.status === 'CLEARED') {
      // CLEARED: warm moss-tinted vitality halo + full mastery radial fill
      const clearHalo = ctx.createRadialGradient(sn.x, sn.y, nr * 0.4, sn.x, sn.y, nr * 2.1);
      clearHalo.addColorStop(0, `hsla(${cHsl.h}, ${Math.min(100, cHsl.s + 15)}%, ${cHsl.l}%, 0.42)`);
      clearHalo.addColorStop(1, `hsla(${cHsl.h}, ${cHsl.s}%, ${cHsl.l}%, 0)`);
      ctx.fillStyle = clearHalo;
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, nr * 2.1, 0, Math.PI * 2);
      ctx.fill();

      traceSmoothPolygon(ctx, pebblePts);
      const fillGrad = ctx.createRadialGradient(sn.x, sn.y, 0, sn.x, sn.y, nr);
      fillGrad.addColorStop(0, `hsl(${cHsl.h}, ${cHsl.s}%, ${Math.min(92, cHsl.l + 12)}%)`);
      fillGrad.addColorStop(0.7, `hsl(${cHsl.h}, ${cHsl.s}%, ${cHsl.l}%)`);
      fillGrad.addColorStop(1, `hsl(${cHsl.h}, ${Math.min(100, cHsl.s + 8)}%, ${Math.max(18, cHsl.l - 10)}%)`);
      ctx.fillStyle = fillGrad;
      ctx.fill();

      ctx.lineWidth = isHovered ? 3 : 2.2;
      ctx.strokeStyle = tokens.clearedRing;
      ctx.stroke();

      // Cleared glyph (✓ crest)
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 ${Math.max(10, Math.round(nr * 0.52))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✓', sn.x, sn.y);
    } else if (node.status === 'FRONTIER') {
      // FRONTIER: pulsing ochre lantern halo + solid stone core
      const pulse = 0.5 + 0.5 * Math.sin(nowMs / 320);
      const pulseR = nr * (1.55 + pulse * 0.35);
      const haloGrad = ctx.createRadialGradient(sn.x, sn.y, nr * 0.5, sn.x, sn.y, pulseR);
      haloGrad.addColorStop(0, tokens.frontierHalo);
      haloGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, pulseR, 0, Math.PI * 2);
      ctx.fill();

      traceSmoothPolygon(ctx, pebblePts);
      const fillGrad = ctx.createRadialGradient(sn.x, sn.y, 0, sn.x, sn.y, nr);
      fillGrad.addColorStop(0, `hsl(${cHsl.h}, ${cHsl.s}%, ${Math.min(90, cHsl.l + 8)}%)`);
      fillGrad.addColorStop(1, `hsl(${cHsl.h}, ${cHsl.s}%, ${Math.max(22, cHsl.l - 8)}%)`);
      ctx.fillStyle = fillGrad;
      ctx.fill();

      ctx.lineWidth = isHovered ? 3.2 : 2.5;
      ctx.strokeStyle = tokens.frontierRing;
      ctx.stroke();

      // Lantern spark core
      ctx.fillStyle = tokens.frontierRing;
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, Math.max(3.5, nr * 0.22), 0, Math.PI * 2);
      ctx.fill();
    } else {
      // FOGGED: desaturated stone circle beneath mist with dashed perimeter
      traceSmoothPolygon(ctx, pebblePts);
      ctx.fillStyle = `hsla(${SAND_HSL.h}, 12%, ${tokens.isDark ? 26 : 72}%, 0.42)`;
      ctx.fill();

      ctx.setLineDash([4, 4]);
      ctx.lineWidth = isHovered ? 2.2 : 1.5;
      ctx.strokeStyle = tokens.lockedStroke;
      ctx.stroke();
      ctx.setLineDash([]);

      // Unrevealed shroud symbol (?)
      ctx.fillStyle = tokens.inkMuted;
      ctx.globalAlpha = 0.65;
      ctx.font = `600 ${Math.max(9, Math.round(nr * 0.45))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', sn.x, sn.y);
    }

    // Label caption for FRONTIER and CLEARED chambers
    if (node.status !== 'FOGGED' && cam.zoom >= 0.45) {
      const rawLabel = cardLabelsById instanceof Map
        ? cardLabelsById.get(node.cardId)
        : (cardLabelsById && cardLabelsById[node.cardId]) || node.cardId;
      const cleanLabel = String(rawLabel || node.cardId)
        .replace(/\{\{c\d+::([^:}]+)(?:::[^}]+)?\}\}/g, '[...]')
        .replace(/\s+/g, ' ')
        .trim();
      const shortLabel = cleanLabel.length > 20 ? `${cleanLabel.slice(0, 19)}…` : cleanLabel;

      ctx.fillStyle = tokens.ink;
      ctx.font = `600 ${Math.max(10, Math.min(12, Math.round(11 * cam.zoom)))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(shortLabel, sn.x, sn.y + nr + 6);
    }

    ctx.restore();
  }

  return {
    renderedNodes: nodes.length,
    renderedEdges,
    statusCounts
  };
}

// ===========================================================================
// Phase 3: In-Memory Gate Outcome Resolver, Self-Contained Gate Modal & Audio
// ===========================================================================

/**
 * Normalizes a grade input ('again'|'hard'|'good'|'easy' or 1|2|3|4) into a canonical string.
 *
 * @param {string|number} grade
 * @returns {'again'|'hard'|'good'|'easy'|null}
 */
export function normalizeMazeGrade(grade) {
  if (grade === 1 || String(grade).toLowerCase() === 'again') return 'again';
  if (grade === 2 || String(grade).toLowerCase() === 'hard') return 'hard';
  if (grade === 3 || String(grade).toLowerCase() === 'good') return 'good';
  if (grade === 4 || String(grade).toLowerCase() === 'easy') return 'easy';
  return null;
}

/**
 * Applies a self-grade outcome to a FRONTIER chamber in memory.
 * Strictly side-mode: mutates ONLY the in-memory `graph.nodes` statuses (`'FRONTIER' -> 'CLEARED'`,
 * and reachable `'FOGGED'` successors -> `'FRONTIER'`).
 * Performs ZERO writes to IndexedDB `cards`, `reviewLog`, or FSRS fields.
 *
 * @param {object} graph - chamber graph from `buildChamberGraph` / `loadDeckMazeGraph`
 * @param {string} nodeIdOrCardId - id or cardId of the tapped FRONTIER chamber
 * @param {string|number} grade - 'again'|'hard'|'good'|'easy' or 1|2|3|4
 * @returns {{ outcome: 'unlocked'|'soft-fail'|'ignored', grade: string|null, unlocked: boolean, allCleared: boolean, newlyPromotedIds: Array<string>, node: object|null }}
 */
export function applyMazeGateGrade(graph, nodeIdOrCardId, grade) {
  const canonicalGrade = normalizeMazeGrade(grade);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const target = nodes.find(
    (n) => n.id === String(nodeIdOrCardId) || n.cardId === String(nodeIdOrCardId)
  );

  if (!target || !canonicalGrade || target.status !== 'FRONTIER') {
    return {
      outcome: 'ignored',
      grade: canonicalGrade,
      unlocked: false,
      allCleared: nodes.length > 0 && nodes.every((n) => n.status === 'CLEARED'),
      newlyPromotedIds: [],
      node: target || null
    };
  }

  // Soft-fail ('again'): chamber remains FRONTIER so the user can retry or take an adjacent branch
  if (canonicalGrade === 'again') {
    return {
      outcome: 'soft-fail',
      grade: canonicalGrade,
      unlocked: false,
      allCleared: false,
      newlyPromotedIds: [],
      node: target
    };
  }

  // Unlock ('hard' | 'good' | 'easy'): mark chamber CLEARED and promote connected FOGGED neighbors
  target.status = 'CLEARED';
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const newlyPromotedIds = [];

  for (const edge of edges) {
    let candidateId = null;
    if (edge.fromId === target.id) candidateId = edge.toId;
    else if (edge.toId === target.id) candidateId = edge.fromId;

    if (candidateId) {
      const neighbor = nodeById.get(candidateId);
      if (neighbor && neighbor.status === 'FOGGED') {
        neighbor.status = 'FRONTIER';
        newlyPromotedIds.push(neighbor.id);
      }
    }
  }

  // Ensure at least one FRONTIER node exists if any FOGGED chambers remain
  const anyFrontier = nodes.some((n) => n.status === 'FRONTIER');
  if (!anyFrontier) {
    const nextFogged = nodes.find((n) => n.status === 'FOGGED');
    if (nextFogged) {
      nextFogged.status = 'FRONTIER';
      newlyPromotedIds.push(nextFogged.id);
    }
  }

  const allCleared = nodes.length > 0 && nodes.every((n) => n.status === 'CLEARED');
  if (allCleared) {
    graph.status = 'SANCTUARY';
    graph.isSanctuary = true;
  }

  return {
    outcome: 'unlocked',
    grade: canonicalGrade,
    unlocked: true,
    allCleared,
    newlyPromotedIds,
    node: target
  };
}

function escapeHtmlMaze(str) {
  const s = String(str ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders cloze-safe front HTML (masks `{{c1::answer}}` and `{{c1::answer::hint}}` with `[...]`)
 * and appends formula display if present.
 */
function formatGateFrontHtml(card) {
  let html = escapeHtmlMaze(card?.front || '');
  html = html.replace(
    /\{\{c\d+::([^:}]+)(?:::([^}]+))?\}\}/g,
    (_, _ans, hint) => `<span class="mm-cloze-mask" style="color:var(--accent, #F2B84B); font-weight:600;">[${hint ? escapeHtmlMaze(hint) : '...'}]</span>`
  );
  if (card?.formula) {
    html += `<div style="margin-top:12px; padding:8px 12px; border-radius:8px; background:rgba(128,128,128,0.1); font-family:monospace;">$$${escapeHtmlMaze(card.formula)}$$</div>`;
  }
  return html;
}

/**
 * Renders the revealed answer HTML for the Gate Modal (unmasks cloze deletions, shows back,
 * and shows formula variables/assumptions if present).
 */
function formatGateBackHtml(card) {
  const parts = [];
  if (card?.type === 'cloze' || /\{\{c\d+::/.test(card?.front || '')) {
    const unmasked = escapeHtmlMaze(card?.front || '').replace(
      /\{\{c\d+::([^:}]+)(?:::[^}]+)?\}\}/g,
      '<strong style="color:var(--accent, #66BB6A);">$1</strong>'
    );
    parts.push(`<div style="margin-bottom:8px; line-height:1.5;">${unmasked}</div>`);
  }
  if (card?.back) {
    parts.push(`<div style="line-height:1.55;">${escapeHtmlMaze(card.back)}</div>`);
  }
  if (Array.isArray(card?.variables) && card.variables.length > 0) {
    const varItems = card.variables
      .map((v) => `${escapeHtmlMaze(v.symbol || v.name || '')}: ${escapeHtmlMaze(v.meaning || v.description || '')}`)
      .join(' · ');
    parts.push(`<div style="margin-top:8px; font-size:12px; color:var(--ink-secondary, #9BA8A0);"><strong>Variables:</strong> ${varItems}</div>`);
  }
  if (card?.assumptions) {
    parts.push(`<div style="margin-top:4px; font-size:12px; color:var(--ink-secondary, #9BA8A0);"><strong>Assumptions:</strong> ${escapeHtmlMaze(card.assumptions)}</div>`);
  }
  return parts.join('') || '<div style="color:var(--ink-secondary);">Answer revealed</div>';
}

/**
 * Self-contained toast helper (writes to `.toast-container` without importing from `app.js`).
 */
function showMazeToast(message, duration = 3800) {
  if (typeof document === 'undefined' || !document.body) return;
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const toast = document.createElement('div');
  toast.className = 'toast mind-maze-toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Mounts the interactive MindMaze Canvas 2D surface inside `containerEl` for a deck,
 * including the Phase 3 Gate Modal, unlock/soft-fail visual effects, and synthesizer audio cues.
 * Strictly read-only (zero FSRS/reviewLog/settings writes) and self-contained (never imports app.js).
 *
 * @param {HTMLElement} containerEl
 * @param {string} deckId
 * @param {object} [opts]
 * @param {object} [opts.graph] - optional prebuilt graph from `buildChamberGraph` / `loadDeckMazeGraph`
 * @param {(node: object, graph: object) => void} [opts.onChamberTap] - hook fired when a chamber is tapped
 * @param {() => void} [opts.onExit] - callback when Back button is clicked
 */
export async function renderMindMazeView(containerEl, deckId, opts = {}) {
  if (!containerEl) {
    throw new Error('renderMindMazeView requires a valid container element');
  }

  await initSoundSetting().catch(() => {});

  const [deck, cards, graph] = await Promise.all([
    getDeck(deckId).catch(() => null),
    getCardsByDeck(deckId).catch(() => []),
    opts.graph ? Promise.resolve(opts.graph) : loadDeckMazeGraph(deckId, opts)
  ]);

  const cardsById = new Map((cards || []).map((c) => [String(c.id), c]));
  const cardLabelsById = new Map(
    (cards || []).map((c) => [String(c.id), String(c.front || c.id)])
  );

  containerEl.innerHTML = '';
  containerEl.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.className = 'mind-maze-view';
  wrap.style.cssText = 'position:relative; width:100%; height:100%; min-height:520px; display:flex; flex-direction:column; overflow:hidden; user-select:none;';

  const deckTitle = deck?.title || deckId || 'Territory';

  function computeLegendText() {
    const nodes = graph.nodes || [];
    if (nodes.length === 0) {
      return graph.status === 'SANCTUARY' ? 'Sanctuary clear' : 'Empty territory';
    }
    const cleared = nodes.filter((n) => n.status === 'CLEARED').length;
    const frontier = nodes.filter((n) => n.status === 'FRONTIER').length;
    const fogged = nodes.filter((n) => n.status === 'FOGGED').length;
    if (cleared === nodes.length) return `All ${cleared} chambers illuminated ✨`;
    return `${cleared} cleared · ${frontier} open · ${fogged} misted`;
  }

  const isArchivedDeck = Boolean(deck?.archived);

  const header = document.createElement('div');
  header.className = 'app-header mind-maze-header';
  header.innerHTML = `
    <button class="back-btn" id="mmzBackBtn" type="button" aria-label="Back">←</button>
    <div class="app-header-title" style="display:flex; align-items:center; gap:8px;">
      <span>MindMaze · ${escapeHtmlMaze(deckTitle)}</span>
      ${isArchivedDeck ? `<span class="mind-maze-archived-badge" style="font-size:11px; font-weight:500; padding:2px 8px; border-radius:999px; background:var(--surface-elevated, rgba(128,128,128,0.14)); color:var(--ink-secondary); border:1px solid rgba(128,128,128,0.22);">📦 Archived</span>` : ''}
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <span class="mind-maze-status-pill" id="mmzLegendPill" style="font-size:12px; padding:4px 10px; border-radius:999px; background:var(--surface-elevated, rgba(128,128,128,0.14)); color:var(--ink-secondary);">
        ${escapeHtmlMaze(computeLegendText())}
      </span>
      <button class="btn-secondary" id="mmzFitBtn" type="button" style="padding:4px 10px; font-size:12px;">Center</button>
    </div>
  `;
  wrap.appendChild(header);

  const stage = document.createElement('div');
  stage.className = 'mind-maze-stage';
  stage.style.cssText = 'position:relative; flex:1; width:100%; height:100%; min-height:460px; overflow:hidden;';

  const canvasEl = document.createElement('canvas');
  canvasEl.className = 'mind-maze-canvas';
  canvasEl.style.cssText = 'display:block; width:100%; height:100%; touch-action:none;';
  stage.appendChild(canvasEl);

  function renderStateBanner(kind, customMsg = null) {
    stage.querySelector('.mind-maze-state-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = `mind-maze-state-banner is-${kind.toLowerCase()}`;
    banner.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:28px',
      'transform:translateX(-50%)',
      'max-width:440px',
      'width:calc(100% - 32px)',
      'padding:16px 20px',
      'border-radius:14px',
      'background:var(--surface, #1E252B)',
      'color:var(--ink, #EDEFF1)',
      'box-shadow:0 10px 28px rgba(0,0,0,0.28)',
      'text-align:center',
      'z-index:5'
    ].join(';');

    if (kind === 'SANCTUARY') {
      banner.innerHTML = `
        <div style="font-size:22px; margin-bottom:6px;">🌿</div>
        <div style="font-size:15px; font-weight:600; margin-bottom:4px;">Sanctuary Illuminated</div>
        <div style="font-size:13px; color:var(--ink-secondary, #9BA8A0); line-height:1.5;">
          ${escapeHtmlMaze(customMsg || graph.message || 'All paths in this territory are clear today. Wander the clearings freely, or return tomorrow when the mist rolls back in.')}
        </div>
      `;
    } else {
      banner.innerHTML = `
        <div style="font-size:22px; margin-bottom:6px;">🧭</div>
        <div style="font-size:15px; font-weight:600; margin-bottom:4px;">No Chambers Kindled Yet</div>
        <div style="font-size:13px; color:var(--ink-secondary, #9BA8A0); line-height:1.5;">
          This territory doesn’t have any active cards yet. Add or import cards to this deck to kindle its first chambers.
        </div>
      `;
    }
    stage.appendChild(banner);
  }

  if (graph.status === 'SANCTUARY' || graph.status === 'EMPTY_DECK') {
    renderStateBanner(graph.status);
  }

  wrap.appendChild(stage);
  containerEl.appendChild(wrap);

  const ctx = canvasEl.getContext('2d');
  let dpr = Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 2);
  let camera = { x: 0, y: 0, zoom: 1 };
  let targetCamera = { x: 0, y: 0, zoom: 1 };
  let hoveredNodeId = null;
  let lastTappedNode = null;
  let lastFrameStats = null;
  let rafId = null;
  let isDestroyed = false;

  // Phase 3 active visual effects & gate modal state
  const unlockRipples = [];
  const shimmerByNodeId = new Map();
  let activeGateState = null; // { node, card, revealed, modalEl }
  let lastNavSoundTime = 0;

  function playThrottledNavigate() {
    const now = Date.now();
    if (now - lastNavSoundTime < 80) return;
    lastNavSoundTime = now;
    playNavigate();
  }

  function updateLegendPill() {
    const pill = header.querySelector('#mmzLegendPill');
    if (pill) pill.textContent = computeLegendText();
  }

  function closeGateModal() {
    if (!activeGateState) return false;
    activeGateState.modalEl?.remove();
    activeGateState = null;
    return true;
  }

  function revealGateAnswer() {
    if (!activeGateState || activeGateState.revealed) return false;
    activeGateState.revealed = true;
    playFlip();

    const { modalEl } = activeGateState;
    const answerWrap = modalEl.querySelector('#mmzGateBackArea');
    const showBtnWrap = modalEl.querySelector('#mmzGateShowWrap');
    const gradeRow = modalEl.querySelector('#mmzGateGradeRow');

    if (answerWrap) answerWrap.style.display = 'block';
    if (showBtnWrap) showBtnWrap.style.display = 'none';
    if (gradeRow) gradeRow.style.display = 'grid';

    if (typeof window !== 'undefined' && typeof window.renderMathInElement === 'function' && answerWrap) {
      try {
        window.renderMathInElement(answerWrap, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ]
        });
      } catch {
        // non-fatal
      }
    }
    return true;
  }

  let lastPersistPromise = Promise.resolve(null);

  function gradeActiveGate(grade) {
    if (!activeGateState) return null;
    const { node } = activeGateState;
    const res = applyMazeGateGrade(graph, node.id, grade);
    closeGateModal();
    updateLegendPill();

    if (res && (res.outcome === 'soft-fail' || res.outcome === 'unlocked')) {
      lastPersistPromise = saveDeckMazeAttempt(deck?.id || deckId || graph.deckId, {
        cardId: node.cardId,
        grade: res.grade,
        outcome: res.outcome,
        dayKey: graph.dayKey
      });
      res.persistPromise = lastPersistPromise;
    }

    if (res.outcome === 'soft-fail') {
      playAgain();
      shimmerByNodeId.set(node.id, Date.now());
      showMazeToast('The mist holds for a moment — try an adjacent path or step back in whenever you’re ready.');
      renderFrameNow();
      return res;
    }

    if (res.outcome === 'unlocked') {
      if (res.grade === 'hard') playHard();
      else if (res.grade === 'easy') playEasy();
      else playGood();

      unlockRipples.push({
        x: node.x,
        y: node.y,
        r: node.r,
        startMs: Date.now(),
        durationMs: 550
      });

      if (res.allCleared) {
        playSessionComplete();
        renderStateBanner(
          'SANCTUARY',
          'Every clearing in this run is illuminated! The mist has lifted across this island — and your FSRS schedule remains untouched.'
        );
      } else {
        setTimeout(() => {
          if (!isDestroyed) playMazeFogLift();
        }, 110);
      }
      renderFrameNow();
    }
    return res;
  }

  function openGateModalForNode(node) {
    if (!node) return null;
    closeGateModal();

    const card = cardsById.get(String(node.cardId)) || {
      id: node.cardId,
      front: node.cardId,
      back: '',
      type: 'basic'
    };

    const isClearedPeek = node.status === 'CLEARED';
    const overlay = document.createElement('div');
    overlay.className = 'mind-maze-gate-overlay';
    overlay.style.cssText = [
      'position:absolute',
      'inset:0',
      'background:rgba(10, 14, 18, 0.56)',
      'backdrop-filter:blur(3px)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:16px',
      'z-index:20'
    ].join(';');

    overlay.innerHTML = `
      <div class="mind-maze-gate-modal" role="dialog" aria-modal="true" style="
        position:relative;
        width:100%;
        max-width:460px;
        background:var(--surface, #1C242A);
        color:var(--ink, #EDEFF1);
        border:1px solid rgba(155,168,160,0.25);
        border-radius:16px;
        padding:20px;
        box-shadow:0 16px 40px rgba(0,0,0,0.38);
      ">
        <button type="button" id="mmzGateCloseBtn" aria-label="Close gate" style="
          position:absolute; top:12px; right:14px; border:none; background:none;
          color:var(--ink-secondary, #9BA8A0); font-size:16px; cursor:pointer;
        ">✕</button>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
          <span style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; padding:3px 8px; border-radius:999px; background:${isClearedPeek ? 'rgba(102,187,106,0.18)' : 'rgba(242,184,75,0.18)'}; color:${isClearedPeek ? '#66BB6A' : '#F2B84B'};">
            ${isClearedPeek ? '✓ Cleared Chamber' : '🏮 Frontier Gate'}
          </span>
          <span style="font-size:11px; color:var(--ink-secondary, #9BA8A0);">${escapeHtmlMaze(card.type || 'basic')}</span>
        </div>

        <div class="mind-maze-gate-front" style="font-size:16px; font-weight:600; line-height:1.5; margin-bottom:14px;">
          ${formatGateFrontHtml(card)}
        </div>

        <div id="mmzGateBackArea" class="mind-maze-gate-back" style="
          display:${isClearedPeek ? 'block' : 'none'};
          padding-top:12px;
          margin-top:12px;
          border-top:1px solid rgba(155,168,160,0.2);
          font-size:14px;
        ">
          ${formatGateBackHtml(card)}
        </div>

        ${isClearedPeek ? '' : `
          <div id="mmzGateShowWrap" style="margin-top:16px;">
            <button type="button" class="btn-primary" id="mmzShowAnswerBtn" style="width:100%; padding:10px 14px; font-size:14px; font-weight:600;">
              Show Answer
            </button>
          </div>
          <div id="mmzGateGradeRow" class="mind-maze-grade-row" style="
            display:none;
            grid-template-columns:repeat(4, 1fr);
            gap:8px;
            margin-top:16px;
          ">
            <button type="button" class="btn-secondary mmz-grade-btn" id="mmzGradeAgain" data-grade="again" style="padding:9px 6px; font-size:13px; font-weight:600;">Again</button>
            <button type="button" class="btn-secondary mmz-grade-btn" id="mmzGradeHard" data-grade="hard" style="padding:9px 6px; font-size:13px; font-weight:600;">Hard</button>
            <button type="button" class="btn-primary mmz-grade-btn" id="mmzGradeGood" data-grade="good" style="padding:9px 6px; font-size:13px; font-weight:600;">Good</button>
            <button type="button" class="btn-secondary mmz-grade-btn" id="mmzGradeEasy" data-grade="easy" style="padding:9px 6px; font-size:13px; font-weight:600;">Easy</button>
          </div>
          <div style="margin-top:10px; font-size:11px; color:var(--ink-secondary, #9BA8A0); text-align:center;">
            Side-mode exploration — your FSRS study schedule is untouched.
          </div>
        `}
      </div>
    `;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeGateModal();
    });
    overlay.querySelector('#mmzGateCloseBtn')?.addEventListener('click', () => closeGateModal());
    overlay.querySelector('#mmzShowAnswerBtn')?.addEventListener('click', () => revealGateAnswer());
    overlay.querySelectorAll('.mmz-grade-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = btn.getAttribute('data-grade');
        gradeActiveGate(g);
      });
    });

    stage.appendChild(overlay);
    activeGateState = {
      node,
      card,
      revealed: isClearedPeek,
      modalEl: overlay
    };

    if (typeof window !== 'undefined' && typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(overlay, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ]
        });
      } catch {
        // non-fatal
      }
    }

    return activeGateState;
  }

  function fitCameraToGraph() {
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width || 800;
    const h = rect.height || 520;
    const nodes = graph.nodes || [];
    if (nodes.length === 0) {
      targetCamera = { x: 0, y: 0, zoom: 1 };
      camera = { ...targetCamera };
      return;
    }
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 90;
    const maxX = Math.max(...xs) + 90;
    const minY = Math.min(...ys) - 90;
    const maxY = Math.max(...ys) + 90;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const spanX = Math.max(280, maxX - minX);
    const spanY = Math.max(280, maxY - minY);
    const zoom = Math.max(0.55, Math.min(1.45, Math.min(w / spanX, h / spanY)));
    targetCamera = { x: cx, y: cy, zoom };
    camera = { ...targetCamera };
  }

  function resizeCanvas() {
    if (isDestroyed || !canvasEl) return;
    const rect = stage.getBoundingClientRect();
    const w = Math.max(320, rect.width || 800);
    const h = Math.max(320, rect.height || 520);
    dpr = Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 2);
    canvasEl.width = Math.floor(w * dpr);
    canvasEl.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderTick();
  }

  function screenToWorld(sx, sy) {
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width || 800;
    const h = rect.height || 520;
    return {
      x: (sx - w / 2) / camera.zoom + camera.x,
      y: (sy - h / 2) / camera.zoom + camera.y
    };
  }

  function hitTestChamber(sx, sy) {
    const worldPt = screenToWorld(sx, sy);
    const nodes = graph.nodes || [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = worldPt.x - n.x;
      const dy = worldPt.y - n.y;
      const hitR = n.r * 1.25;
      if (dx * dx + dy * dy <= hitR * hitR) {
        return n;
      }
    }
    return null;
  }

  function fireChamberTap(node) {
    if (!node) return null;
    lastTappedNode = node;
    playThrottledNavigate();

    if (typeof opts.onChamberTap === 'function') {
      opts.onChamberTap(node, graph);
    }
    const evDetail = { node, deckId, status: node.status, graph };
    containerEl.dispatchEvent(new CustomEvent('lernin:mindmaze-chamber-tap', { bubbles: true, detail: evDetail }));

    if (node.status === 'FOGGED') {
      showMazeToast('Clear a connected chamber first to reach this path.');
    } else if (node.status === 'FRONTIER' || node.status === 'CLEARED') {
      targetCamera.x = node.x;
      targetCamera.y = node.y;
      openGateModalForNode(node);
    }
    return node;
  }

  // Keyboard support: Escape closes gate modal first; Space/Enter reveals answer; 1..4 grades
  function onKeyDown(e) {
    if (isDestroyed) return;
    if (e.key === 'Escape') {
      if (activeGateState) {
        e.preventDefault();
        e.stopPropagation();
        closeGateModal();
      }
      return;
    }
    if (!activeGateState) return;
    if (!activeGateState.revealed && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      revealGateAnswer();
      return;
    }
    if (activeGateState.revealed && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      gradeActiveGate(Number(e.key));
    }
  }

  // Pointer pan / tap & wheel zoom
  let pointerDown = false;
  let lastPtr = { x: 0, y: 0 };
  let dragMoved = 0;
  let downChamber = null;

  function onPointerDown(e) {
    pointerDown = true;
    dragMoved = 0;
    lastPtr = { x: e.clientX, y: e.clientY };
    const rect = canvasEl.getBoundingClientRect();
    downChamber = hitTestChamber(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onPointerMove(e) {
    const rect = canvasEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (!pointerDown) {
      const hit = hitTestChamber(sx, sy);
      hoveredNodeId = hit ? hit.id : null;
      canvasEl.style.cursor = hit ? 'pointer' : 'grab';
      return;
    }
    const dx = e.clientX - lastPtr.x;
    const dy = e.clientY - lastPtr.y;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMoved > 6) {
      targetCamera.x -= dx / camera.zoom;
      targetCamera.y -= dy / camera.zoom;
      camera.x = targetCamera.x;
      camera.y = targetCamera.y;
    }
    lastPtr = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp() {
    if (pointerDown && dragMoved <= 8 && downChamber) {
      fireChamberTap(downChamber);
    }
    pointerDown = false;
    downChamber = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = 1 - e.deltaY * 0.001;
    const nextZoom = Math.max(0.4, Math.min(2.6, targetCamera.zoom * factor));
    targetCamera.zoom = nextZoom;
  }

  function renderFrameNow() {
    if (isDestroyed || !ctx || !canvasEl) return;
    const rect = stage.getBoundingClientRect();
    const w = Math.max(320, rect.width || 800);
    const h = Math.max(320, rect.height || 520);

    lastFrameStats = drawMindMazeFrame(
      ctx,
      graph,
      { width: w, height: h, camera },
      { hoveredNodeId, cardLabelsById, unlockRipples, shimmerByNodeId }
    );
  }

  function renderTick() {
    if (isDestroyed) return;
    camera.x += (targetCamera.x - camera.x) * 0.14;
    camera.y += (targetCamera.y - camera.y) * 0.14;
    camera.zoom += (targetCamera.zoom - camera.zoom) * 0.14;

    renderFrameNow();
    rafId = requestAnimationFrame(renderTick);
  }

  let themeObserver = null;
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
    themeObserver = new MutationObserver(() => {
      renderFrameNow();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }

  header.querySelector('#mmzBackBtn')?.addEventListener('click', () => {
    if (activeGateState) {
      closeGateModal();
      return;
    }
    if (typeof opts.onExit === 'function') opts.onExit();
  });
  header.querySelector('#mmzFitBtn')?.addEventListener('click', () => {
    fitCameraToGraph();
  });

  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('keydown', onKeyDown, true);
  }

  resizeCanvas();
  fitCameraToGraph();
  renderTick();

  const controller = {
    destroy() {
      isDestroyed = true;
      closeGateModal();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (themeObserver) {
        themeObserver.disconnect();
        themeObserver = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', resizeCanvas);
        window.removeEventListener('keydown', onKeyDown, true);
      }
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('pointercancel', onPointerUp);
      canvasEl.removeEventListener('wheel', onWheel);
    },
    getGraph: () => graph,
    getLastFrameStats: () => lastFrameStats,
    getLastTappedNode: () => lastTappedNode,
    getActiveGateState: () => activeGateState,
    fitCamera: fitCameraToGraph,
    redraw: renderFrameNow,
    openGateForNode: (nodeId) => {
      const target = (graph.nodes || []).find((n) => n.id === nodeId || n.cardId === nodeId);
      return openGateModalForNode(target || null);
    },
    revealGateAnswer,
    gradeActiveGate,
    closeGateModal,
    tapChamberById(nodeId) {
      const target = (graph.nodes || []).find((n) => n.id === nodeId || n.cardId === nodeId);
      return fireChamberTap(target || null);
    }
  };

  if (typeof window !== 'undefined') {
    window.__mindMazeDebug = controller;
  }

  return controller;
}


