/* canvas.js — Spatial Learning Map
   L1 Territory view · L2 Deck/card nodes · L3 Card detail
   Landmarks, relationship lines, study paths, annotations.
   Spatial review is delegated to spatial-study.js.
*/

import {
  getActiveDecks, getCardsByDeck, getCard, getDeck,
  saveIslandPosition, getIslandPositionOverrides, clearIslandPosition,
  saveConceptPosition, getConceptPositionOverrides,
  getRelationshipsFrom, getRelationshipsTo, getCrossDeckRelationshipPairs,
  saveLandmark, getLandmarksForDeck, deleteLandmark,
  saveStudyPath, getStudyPathsForDeck, deleteStudyPath,
  saveAnnotation, getAnnotationsForDeck, deleteAnnotation
} from './db.js';
import { startStudySession } from './study.js';
import { isNearMapSecret, hasFoundMapSecret, markMapSecretFound, MAP_SECRET_SPOT } from './secrets.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const TERRITORY_SPACING = 900;
const ISLAND_RADIUS_BASE = 26;
const ISLAND_SPACING = 90;
const CARD_NODE_R = 22;
const LOD_ISLAND_DETAIL_THRESHOLD = 0.55;
const LOD_SIMPLE_DOT_RADIUS = 8;
const DRAG_COMMIT_THRESHOLD = 10;
const SNAP_DISTANCE = 80;

const SAND_HSL = { h: 38, s: 28, l: 78 };
const OCHRE_HSL = { h: 32, s: 55, l: 55 };
const MOSS_HSL = { h: 110, s: 32, l: 38 };
const HUE_JITTER_RANGE = 16;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let container = null;
let canvasEl = null;
let ctx = null;
let onExitCallback = null;
let rafId = null;
let idleTimeoutId = null;

let camera = { x: 0, y: 0, zoom: 1 };
let targetCamera = { x: 0, y: 0, zoom: 1 };

// L1->L2 "fly-to": a one-shot callback fired once the ongoing camera
// ease reaches its target (see renderLoop's cameraSettled check below).
// Used to hold the camera zooming into the tapped island on L1 first,
// then switch to L2's own transition -- rather than the old instant
// content swap where L2's card cloud replaced L1's islands the moment
// zoomLevel flipped, before the camera had visually arrived anywhere
// near the tapped spot.
let cameraArrivedCallback = null;
let cameraArrivedTimeoutId = null;
const FLY_IN_ZOOM = 2.2; // well within L1's existing pinch/wheel-zoom range (clampZoom caps L1 at 3)
const FLY_IN_TIMEOUT_MS = 1400; // safety net only -- natural settle lands ~800-1000ms regardless of distance (exponential ease)

/** @type {1|2|3} */
let zoomLevel = 1;
let activeDeckId = null;       // L2/L3
let activeCardId = null;       // L3
let worldTerritories = [];
let crossDeckPairs = []; // [{deckIdA, deckIdB, count}] — island-to-island lines at L1
let cardNodes = [];            // L2 nodes for active deck
let landmarks = [];
let annotations = [];
let relationships = [];        // {fromId, toId, type, crossDeck?, label?}
let studyPaths = [];
let highlightedNodeId = null;
let pathBuildMode = false;
let pathDraft = [];            // node ids while building a path
let annotateMode = false;
let hoveredIsland = null;
let hoveredCard = null;

let MAP_BG = '#14181C';
let MAP_BG_SKY = '#0A0D10';
let MAP_BG_HORIZON = '#1E2830';
let MAP_INK = '#EDEFF1';

// Gestures
const activePointers = new Map();
let isPanning = false;
let lastPointer = null;
let dragMoved = 0;
let draggedIsland = null;
let draggedCard = null;
let draggedLandmark = null;
let pendingIslandHit = null;
let pendingCardHit = null;
let pendingLandmarkHit = null;
let pinchStartDist = null;
let pinchStartZoom = 1;

// DOM overlays
let breadcrumbEl = null;
let toolbarEl = null;
let detailPanelEl = null;
let pathPanelEl = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} targetContainer
 * @param {{ onExit?: Function, deckId?: string, startLevel?: 1|2|3 }} opts
 *   Pass deckId (+ optional startLevel:2) to open directly at L2 for a deck
 *   (used by the "Concept Map" bottom-sheet action).
 */
export async function initCanvasView(targetContainer, opts = {}) {
  destroyCanvasView();
  container = targetContainer;
  onExitCallback = opts.onExit || null;

  container.innerHTML = '';
  container.className = 'map-root';
  container.style.position = 'relative';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.overflow = 'hidden';

  canvasEl = document.createElement('canvas');
  canvasEl.className = 'territory-map-canvas';
  canvasEl.setAttribute('role', 'img');
  canvasEl.setAttribute('aria-label', 'Knowledge map');
  container.appendChild(canvasEl);

  ctx = canvasEl.getContext('2d');
  refreshThemeColors();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  await buildWorldModel();

  if (opts.deckId) {
    await enterDeckView(opts.deckId, { animate: false });
  } else {
    zoomLevel = 1;
    fitCameraToContent();
  }

  buildOverlays();
  attachGestureHandlers();
  updateBreadcrumb();
  rafId = requestAnimationFrame(renderLoop); // first frame always immediate
  return destroyCanvasView;
}

export function destroyCanvasView() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (idleTimeoutId) clearTimeout(idleTimeoutId);
  idleTimeoutId = null;
  // A mid-flight fly-in commit (see flyIntoDeck()) firing after teardown
  // would call enterDeckView() against a canvas/DOM that no longer
  // exists -- e.g. the person taps an island then immediately navigates
  // away before the zoom-in settles.
  if (cameraArrivedTimeoutId !== null) clearTimeout(cameraArrivedTimeoutId);
  cameraArrivedTimeoutId = null;
  cameraArrivedCallback = null;
  if (canvasEl) {
    canvasEl.removeEventListener('pointerdown', onPointerDown);
    canvasEl.removeEventListener('pointermove', onPointerMove);
    canvasEl.removeEventListener('pointerup', onPointerUp);
    canvasEl.removeEventListener('pointercancel', onPointerUp);
    canvasEl.removeEventListener('wheel', onWheel);
  }
  window.removeEventListener('resize', resizeCanvas);
  detailPanelEl?.remove();
  breadcrumbEl?.remove();
  toolbarEl?.remove();
  pathPanelEl?.remove();
  container = null;
  canvasEl = null;
  ctx = null;
  worldTerritories = [];
  cardNodes = [];
  landmarks = [];
  annotations = [];
  relationships = [];
  activeDeckId = null;
  activeCardId = null;
  zoomLevel = 1;
  pathBuildMode = false;
  pathDraft = [];
  annotateMode = false;
}

/** Open the map already zoomed into a deck (L2). Used by app.js Concept Map action. */
export async function openDeckOnMap(targetContainer, deckId, opts = {}) {
  return initCanvasView(targetContainer, { ...opts, deckId, startLevel: 2 });
}

// ---------------------------------------------------------------------------
// World model (L1)
// ---------------------------------------------------------------------------

function hashToUnit(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

function territoryPosition(territoryId, index) {
  const angle = index * 2.4;
  const radius = TERRITORY_SPACING * Math.sqrt(index);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function islandDefaultPos(territoryCenter, islandId, index, total) {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 + hashToUnit(islandId) * 0.5;
  const jitterRadius = ISLAND_SPACING * (1 + hashToUnit(islandId + 'r') * 0.4);
  return {
    x: territoryCenter.x + Math.cos(angle) * jitterRadius,
    y: territoryCenter.y + Math.sin(angle) * jitterRadius
  };
}

async function buildWorldModel() {
  const [decks, overrides] = await Promise.all([
    getActiveDecks(),
    getIslandPositionOverrides()
  ]);
  try {
    crossDeckPairs = await getCrossDeckRelationshipPairs();
  } catch (err) {
    console.warn('Failed to load cross-deck relationships — island lines skipped:', err);
    crossDeckPairs = [];
  }

  const byTerritory = new Map();
  for (const deck of decks) {
    const tid = deck.courseTerritoryId || 'uncategorized';
    if (!byTerritory.has(tid)) byTerritory.set(tid, []);
    byTerritory.get(tid).push(deck);
  }

  worldTerritories = [];
  let tIndex = 0;
  for (const [territoryId, territoryDecks] of byTerritory) {
    const center = territoryPosition(territoryId, tIndex++);
    const islands = [];
    let allCardsInTerritory = [];

    for (let i = 0; i < territoryDecks.length; i++) {
      const deck = territoryDecks[i];
      const cards = await getCardsByDeck(deck.id);
      allCardsInTerritory = allCardsInTerritory.concat(cards);
      const ov = overrides.get(deck.id);
      const pos = ov
        ? { x: ov.x, y: ov.y }
        : islandDefaultPos(center, deck.id, i, territoryDecks.length);
      islands.push({
        id: deck.id,
        deckId: deck.id,
        title: deck.title || 'Deck',
        pos,
        mastery: computeMastery(cards),
        cardCount: cards.length,
        dueCount: cards.filter(c => !c.suspended && (c.due_date || 0) <= Date.now()).length
      });
    }

    worldTerritories.push({
      id: territoryId,
      center,
      islands,
      activityLevel: computeActivityLevel(allCardsInTerritory),
      bounds: null
    });
  }

  for (const t of worldTerritories) t.bounds = territoryBounds(t);
}

function computeActivityLevel(cards) {
  const totalReps = cards.reduce((s, c) => s + (c.reps || 0), 0);
  return Math.min(1, totalReps / 100);
}

function computeMastery(cards) {
  if (!cards.length) return 0;
  const avg = cards.reduce((s, c) => s + (c.stability || 0), 0) / cards.length;
  return Math.min(1, avg / 30);
}

// ---------------------------------------------------------------------------
// L2 / L3 data
// ---------------------------------------------------------------------------

/** Tapped an island on L1: zoom the camera into it first (still rendering
 * L1) and only switch to L2's own card-cloud view once that zoom-in has
 * visually settled, or the safety timeout fires -- whichever first. */
function flyIntoDeck(island) {
  if (cameraArrivedTimeoutId !== null) clearTimeout(cameraArrivedTimeoutId);
  targetCamera = { x: island.pos.x, y: island.pos.y, zoom: FLY_IN_ZOOM };
  const commit = () => {
    if (cameraArrivedTimeoutId !== null) {
      clearTimeout(cameraArrivedTimeoutId);
      cameraArrivedTimeoutId = null;
    }
    cameraArrivedCallback = null;
    enterDeckView(island.deckId);
  };
  cameraArrivedCallback = commit;
  cameraArrivedTimeoutId = setTimeout(commit, FLY_IN_TIMEOUT_MS);
  scheduleFrame(0);
}

async function enterDeckView(deckId, { animate = true } = {}) {
  activeDeckId = deckId;
  activeCardId = null;
  zoomLevel = 2;
  pathBuildMode = false;
  pathDraft = [];
  annotateMode = false;

  const [cards, overrides, lms, anns, paths] = await Promise.all([
    getCardsByDeck(deckId),
    getConceptPositionOverrides(),
    getLandmarksForDeck(deckId),
    getAnnotationsForDeck(deckId),
    getStudyPathsForDeck(deckId)
  ]);

  landmarks = lms;
  annotations = anns;
  studyPaths = paths;

  // Auto-layout: spiral for cards without saved positions
  const unplaced = [];
  cardNodes = cards.filter(c => !c.suspended).map((c, i) => {
    const ov = overrides.get(c.id);
    const mastery = Math.min(1, (c.stability || 0) / 30);
    let x, y;
    if (ov) {
      x = ov.x; y = ov.y;
    } else {
      unplaced.push(i);
      const angle = i * 0.7;
      const r = 40 + Math.sqrt(i) * 38;
      x = Math.cos(angle) * r;
      y = Math.sin(angle) * r;
    }
    return {
      id: c.id,
      card: c,
      x, y,
      radius: CARD_NODE_R,
      mastery,
      pulse: 0 // visual feedback after grade
    };
  });

  // Relationships within (and cross-deck)
  relationships = [];
  const cardIdSet = new Set(cardNodes.map(n => n.id));
  for (const node of cardNodes) {
    const from = await getRelationshipsFrom(node.id);
    for (const r of from) {
      if (r.targetMissing) continue;
      if (cardIdSet.has(r.cardId)) {
        relationships.push({ fromId: node.id, toId: r.cardId, type: r.type });
      } else if (r.deckId) {
        let label = '→ other deck';
        try {
          const d = await getDeck(r.deckId);
          if (d?.title) label = `→ ${d.title}`;
        } catch (_) { /* ignore */ }
        relationships.push({
          fromId: node.id, toId: r.cardId, type: r.type,
          crossDeck: true, label
        });
      }
    }
  }

  // Center camera on card cloud
  if (cardNodes.length) {
    const cx = cardNodes.reduce((s, n) => s + n.x, 0) / cardNodes.length;
    const cy = cardNodes.reduce((s, n) => s + n.y, 0) / cardNodes.length;
    targetCamera.x = cx;
    targetCamera.y = cy;
    targetCamera.zoom = 1.2;
    if (!animate) {
      camera.x = cx; camera.y = cy; camera.zoom = 1.2;
    }
  } else {
    targetCamera = { x: 0, y: 0, zoom: 1.2 };
  }

  updateBreadcrumb();
  updateToolbar();
  hideDetailPanel();
}

async function enterCardDetail(cardId) {
  activeCardId = cardId;
  zoomLevel = 3;
  const node = cardNodes.find(n => n.id === cardId);
  if (node) {
    targetCamera.x = node.x;
    targetCamera.y = node.y;
    targetCamera.zoom = 2.4;
  }
  updateBreadcrumb();
  updateToolbar();
  await showDetailPanel(cardId);
}

function exitToL1() {
  zoomLevel = 1;
  activeDeckId = null;
  activeCardId = null;
  cardNodes = [];
  landmarks = [];
  annotations = [];
  relationships = [];
  studyPaths = [];
  pathBuildMode = false;
  pathDraft = [];
  annotateMode = false;
  hideDetailPanel();
  fitCameraToContent();
  updateBreadcrumb();
  updateToolbar();
  scheduleFrame(0);
}

function exitToL2() {
  if (!activeDeckId) return exitToL1();
  activeCardId = null;
  zoomLevel = 2;
  targetCamera.zoom = 1.2;
  hideDetailPanel();
  updateBreadcrumb();
  updateToolbar();
  scheduleFrame(0);
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function fitCameraToContent() {
  const allIslands = worldTerritories.flatMap(t => t.islands);
  if (!allIslands.length) {
    targetCamera = { x: 0, y: 0, zoom: 1 };
    camera = { ...targetCamera };
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const isl of allIslands) {
    minX = Math.min(minX, isl.pos.x);
    minY = Math.min(minY, isl.pos.y);
    maxX = Math.max(maxX, isl.pos.x);
    maxY = Math.max(maxY, isl.pos.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 200);
  const { width, height } = canvasEl.getBoundingClientRect();
  const zoom = Math.min(1.4, Math.min(width, height) / (span + 200));
  targetCamera = { x: cx, y: cy, zoom: clampZoom(zoom) };
  camera = { ...targetCamera };
}

function clampZoom(z) {
  if (zoomLevel === 1) return Math.min(3, Math.max(0.15, z));
  if (zoomLevel === 2) return Math.min(4, Math.max(0.4, z));
  return Math.min(5, Math.max(0.8, z));
}

function resizeCanvas() {
  if (!canvasEl || !container) return;
  const rect = container.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasEl.width = Math.max(1, Math.floor(rect.width * dpr));
  canvasEl.height = Math.max(1, Math.floor(rect.height * dpr));
  canvasEl.style.width = `${rect.width}px`;
  canvasEl.style.height = `${rect.height}px`;
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function refreshThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  MAP_BG = styles.getPropertyValue('--map-bg').trim() || MAP_BG;
  MAP_BG_SKY = styles.getPropertyValue('--map-bg-sky').trim() || MAP_BG_SKY;
  MAP_BG_HORIZON = styles.getPropertyValue('--map-bg-horizon').trim() || MAP_BG_HORIZON;
  MAP_INK = styles.getPropertyValue('--map-ink').trim() || MAP_INK;
}

function worldToScreen(wx, wy) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (wx - camera.x) * camera.zoom + rect.width / 2,
    y: (wy - camera.y) * camera.zoom + rect.height / 2
  };
}

function screenToWorld(sx, sy) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (sx - rect.width / 2) / camera.zoom + camera.x,
    y: (sy - rect.height / 2) / camera.zoom + camera.y
  };
}

function getWorldViewportRect() {
  const rect = canvasEl.getBoundingClientRect();
  const halfW = (rect.width / 2) / camera.zoom;
  const halfH = (rect.height / 2) / camera.zoom;
  return {
    minX: camera.x - halfW, minY: camera.y - halfH,
    maxX: camera.x + halfW, maxY: camera.y + halfH
  };
}

function rectIntersects(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

/**
 * Schedules the next frame. delayMs=0 means "as soon as possible"
 * (requestAnimationFrame); >0 throttles to that interval. Guards against
 * double-scheduling if something is already pending.
 */
function scheduleFrame(delayMs) {
  if (delayMs === 0) {
    // Urgent — cancel any pending slow idle tick and go immediate.
    if (idleTimeoutId !== null) {
      clearTimeout(idleTimeoutId);
      idleTimeoutId = null;
    }
    if (rafId === null) {
      rafId = requestAnimationFrame(renderLoop);
    }
    return;
  }
  // Throttled idle tick — only schedule if nothing is already pending.
  if (rafId !== null || idleTimeoutId !== null) return;
  idleTimeoutId = setTimeout(() => {
    idleTimeoutId = null;
    rafId = requestAnimationFrame(renderLoop);
  }, delayMs);
}

function renderLoop() {
  rafId = null;

  camera.x += (targetCamera.x - camera.x) * 0.12;
  camera.y += (targetCamera.y - camera.y) * 0.12;
  camera.zoom += (targetCamera.zoom - camera.zoom) * 0.12;

  if (!ctx || !canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (zoomLevel === 1) {
    drawMapBackground(rect);
    renderL1();
  } else {
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, rect.width, rect.height);
    renderL2();
  }

  const cameraSettled = Math.abs(targetCamera.x - camera.x) < 0.4 &&
                         Math.abs(targetCamera.y - camera.y) < 0.4 &&
                         Math.abs(targetCamera.zoom - camera.zoom) < 0.0015;

  // Fires flyIntoDeck()'s commit once the L1 zoom-in has visually
  // arrived, AFTER this frame renders so the settled/zoomed-in L1 frame
  // actually shows before the content swaps to L2 on the next frame.
  if (cameraSettled && cameraArrivedCallback) {
    const cb = cameraArrivedCallback;
    cameraArrivedCallback = null;
    cb();
  }

  const isActive = activePointers.size > 0 || !cameraSettled;

  // Full rate while actively dragging/panning/pinching or the camera is
  // easing toward a new target; otherwise a slow idle tick. At L1 the
  // idle sway animation needs ~25fps (40ms) to look smooth; at L2 the
  // card cloud is static so 4fps (250ms) is sufficient. Both are well
  // below the old unconditional 60fps loop.
  const hasIdleAnim = zoomLevel === 1;
  scheduleFrame(isActive ? 0 : hasIdleAnim ? 40 : 250);
}

function renderL1() {
  const viewport = getWorldViewportRect();
  drawIslandConnections();
  for (const territory of worldTerritories) {
    const bounds = territory.bounds ?? territoryBounds(territory);
    if (!rectIntersects(bounds, viewport)) continue;
    drawTerritory(territory, viewport);
  }
  if (isNearMapSecret(camera.x, camera.y, camera.zoom)) {
    drawMapSecret();
    if (!hasFoundMapSecret()) markMapSecretFound();
  }
}

/**
 * A small sprouting-plant motif at a deliberately distant, otherwise-
 * empty world coordinate (see secrets.js's MAP_SECRET_SPOT comment for
 * why that spot is safely far from any real territory). Only draws while
 * the camera is actually there at near-max zoom, so finding it takes
 * genuine deliberate exploration, not an accidental scroll-past. A gentle
 * continuous sway (not a one-shot animation) so it reads as a small
 * living thing rather than a static sprite -- ties into the same
 * growth/mastery visual language the islands themselves already use.
 */
function drawMapSecret() {
  const s = worldToScreen(MAP_SECRET_SPOT.x, MAP_SECRET_SPOT.y);
  const sway = Math.sin(Date.now() / 900) * 3;
  const scale = camera.zoom;

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.scale(scale, scale);

  // stem
  ctx.strokeStyle = '#4a7c4e';
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.moveTo(0, 14);
  ctx.quadraticCurveTo(sway * 0.3, 4, 0, -10);
  ctx.stroke();

  // two small leaves
  ctx.fillStyle = '#66BB6A';
  ctx.beginPath();
  ctx.ellipse(-6 + sway * 0.15, -4, 7, 3.5, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(6 + sway * 0.15, -8, 7, 3.5, 0.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  if (camera.zoom > 2.9) {
    ctx.fillStyle = 'rgba(160,176,162,0.7)';
    ctx.font = '11px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('every mastered card starts here', s.x, s.y + 34);
  }
}

function renderL2() {
  // Landmarks (behind everything)
  for (const lm of landmarks) drawLandmark(lm);

  // Annotations
  for (const ann of annotations) drawAnnotation(ann);

  // Relationship lines
  drawRelationshipLines();

  // Path draft / saved paths
  if (pathDraft.length > 1) drawPathLine(pathDraft, true);
  for (const p of studyPaths) {
    if (p.nodeIds?.length > 1) drawPathLine(p.nodeIds, false);
  }

  // Card nodes
  for (const node of cardNodes) drawCardNode(node);

  // Deck title header (screen-space)
  drawDeckHeader();
}

function territoryBounds(territory) {
  const pad = ISLAND_SPACING + 60;
  if (!territory.islands.length) {
    return {
      minX: territory.center.x - pad, minY: territory.center.y - pad,
      maxX: territory.center.x + pad, maxY: territory.center.y + pad
    };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const island of territory.islands) {
    minX = Math.min(minX, island.pos.x - pad);
    minY = Math.min(minY, island.pos.y - pad);
    maxX = Math.max(maxX, island.pos.x + pad);
    maxY = Math.max(maxY, island.pos.y + pad);
  }
  return { minX, minY, maxX, maxY };
}

function findIslandByDeckId(deckId) {
  for (const territory of worldTerritories) {
    const island = territory.islands.find(i => i.deckId === deckId);
    if (island) return island;
  }
  return null;
}

/**
 * Island-to-island lines at L1 — one line per deck pair (aggregated,
 * not one per relationship), weighted by how many relationships cross
 * that pair. Rendered as a worn-earth double-stroke track: a wide ochre
 * undercoat (the exposed dirt) + a narrow lighter topcoat (the trodden
 * centre). Width scales with pair.count so busier routes look wider.
 * No dashes — solid strokes read more like a real path than a schematic.
 */
function drawIslandConnections() {
  if (crossDeckPairs.length === 0) return;
  for (const pair of crossDeckPairs) {
    const a = findIslandByDeckId(pair.deckIdA);
    const b = findIslandByDeckId(pair.deckIdB);
    if (!a || !b) continue; // one side deleted/renamed since aggregation ran — skip safely

    const sa = worldToScreen(a.pos.x, a.pos.y);
    const sb = worldToScreen(b.pos.x, b.pos.y);

    const isHi = hoveredIsland && (hoveredIsland.deckId === pair.deckIdA || hoveredIsland.deckId === pair.deckIdB);
    const dim = hoveredIsland && !isHi;

    const baseWidth = Math.min(3 + pair.count * 0.6, 6) * (isHi ? 1.4 : 1);

    // Wide undercoat — worn earth / exposed dirt
    ctx.save();
    ctx.globalAlpha = dim ? 0.04 : (isHi ? 0.40 : 0.18);
    ctx.strokeStyle = '#8B6F47';
    ctx.lineWidth = baseWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.restore();

    // Narrow topcoat — trodden centre, slightly lighter
    ctx.save();
    ctx.globalAlpha = dim ? 0.06 : (isHi ? 0.55 : 0.28);
    ctx.strokeStyle = '#C4A265';
    ctx.lineWidth = baseWidth * 0.45;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTerritory(territory, viewport) {
  drawTerritoryActivityHalo(territory);
  for (const island of territory.islands) {
    if (camera.zoom >= LOD_ISLAND_DETAIL_THRESHOLD) drawIsland(island, territory);
    else drawIslandSimple(island);
  }
  // Territory label
  if (camera.zoom > 0.35 && territory.id !== 'uncategorized') {
    const s = worldToScreen(territory.center.x, territory.center.y - 80);
    ctx.fillStyle = MAP_INK;
    ctx.globalAlpha = 0.55;
    ctx.font = `600 ${Math.max(11, 13 * camera.zoom)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(territory.id, s.x, s.y);
    ctx.globalAlpha = 1;
  }
}

function drawTerritoryActivityHalo(territory) {
  if (territory.activityLevel < 0.05) return;
  const s = worldToScreen(territory.center.x, territory.center.y);
  const r = (120 + territory.activityLevel * 80) * camera.zoom;
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
  g.addColorStop(0, `rgba(46,125,50,${0.08 + territory.activityLevel * 0.12})`);
  g.addColorStop(1, 'rgba(46,125,50,0)');
  ctx.beginPath();
  ctx.fillStyle = g;
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function lerpHsl(a, b, t) {
  return { h: a.h + (b.h - a.h) * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
}

function islandColor(mastery, seedId) {
  const base = mastery < 0.5
    ? lerpHsl(SAND_HSL, OCHRE_HSL, mastery / 0.5)
    : lerpHsl(OCHRE_HSL, MOSS_HSL, (mastery - 0.5) / 0.5);
  const jitter = (hashToUnit(seedId) - 0.5) * 2 * HUE_JITTER_RANGE;
  return { h: base.h + jitter, s: base.s, l: base.l };
}

/**
 * Recency-as-ambient-life scalar in [0.3, 1.0].
 * High value → vivid, glowing, textured (recently studied).
 * Low value  → desaturated, quiet, faint (untouched or brand-new).
 *
 * Uses island.mastery as the per-island proxy (cumulative review effort)
 * blended with the territory's activityLevel as a group modifier. The
 * floor of 0.3 keeps even unstarted islands faintly visible.
 */
function islandVitality(island, territory) {
  const perIsland = island.mastery;
  const groupBoost = (territory?.activityLevel ?? 0) * 0.5;
  return 0.3 + 0.7 * Math.min(1, Math.max(perIsland, groupBoost));
}

function drawIslandGlow(island, radius, vitality) {
  const s = worldToScreen(island.pos.x, island.pos.y);
  const { h, s: sat, l } = islandColor(island.mastery, island.id);
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
  const glowAlpha = 0.35 * vitality;
  g.addColorStop(0, `hsla(${h},${sat}%,${l}%,${glowAlpha.toFixed(3)})`);
  g.addColorStop(1, `hsla(${h},${sat}%,${l}%,0)`);
  ctx.beginPath();
  ctx.fillStyle = g;
  ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Full terrain render for one island at L1 (called from drawTerritory via
 * drawIsland). Accepts the parent territory so we can compute vitality.
 *
 * Step 6 — Recency as ambient life:
 *   vitality ∈ [0.3, 1.0] scales glow alpha, fill saturation, texture
 *   alpha, and coastline/contour opacity so untouched islands look quiet
 *   and desaturated while recently studied ones look vivid.
 *
 * Step 7 — Idle motion:
 *   A tiny sinusoidal world-space offset (phase unique per island via
 *   hashToUnit) moves the island centre very slowly so it reads as alive.
 *   Amplitude is 1.2 world units — imperceptible as jitter, visible as
 *   gentle drift. All drawing uses the swayed screen position so nothing
 *   tears. The sway is purely cosmetic and never affects hit-testing or
 *   position storage.
 */
function drawIsland(island, territory) {
  // --- Step 7: per-island sinusoidal sway (idle motion) ---
  const phase = hashToUnit(island.id) * Math.PI * 2;
  const swayX = Math.sin(Date.now() / 2400 + phase) * 1.2;
  const swayY = Math.cos(Date.now() / 3100 + phase * 1.3) * 0.8;
  const s = worldToScreen(island.pos.x + swayX, island.pos.y + swayY);

  const radius = ISLAND_RADIUS_BASE * camera.zoom;
  const { h, s: sat, l } = islandColor(island.mastery, island.id);

  // --- Step 6: vitality scalar [0.3, 1.0] ---
  const vit = islandVitality(island, territory);
  const vSat = sat * (0.4 + 0.6 * vit);   // desaturate quiet islands

  drawIslandGlow(island, radius * 2.2, vit);

  const points = islandSilhouettePoints(s.x, s.y, radius, island.id);

  if (island === hoveredIsland) {
    const hoverPoints = islandSilhouettePoints(s.x, s.y, radius, island.id, 7);
    buildSilhouettePath(ctx, hoverPoints);
    ctx.strokeStyle = 'rgba(46,125,50,0.55)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // 1 & 2: Procedural silhouette and terrain shading (radial gradient high-ground -> shoreline)
  buildSilhouettePath(ctx, points);
  const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
  grad.addColorStop(0, `hsl(${h},${vSat}%,${Math.min(100, l + 14)}%)`);
  grad.addColorStop(0.6, `hsl(${h},${vSat}%,${l}%)`);
  grad.addColorStop(1, `hsl(${h},${Math.min(100, vSat + 10)}%,${Math.max(0, l - 10)}%)`);
  ctx.fillStyle = grad;
  ctx.fill();

  // Coastline stroke — quieter on low-vitality islands
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(0,0,0,${(0.25 * vit).toFixed(3)})`;
  ctx.stroke();

  // 3: Texture density marks (clipped to silhouette) — faded on quiet islands
  ctx.save();
  buildSilhouettePath(ctx, points);
  ctx.clip();
  ctx.globalAlpha = vit;
  drawIslandTexture(s.x, s.y, radius, island.id, island.cardCount, { h, s: vSat, l });
  ctx.globalAlpha = 1;
  ctx.restore();

  // Elevation contour rings reflecting mastery — quieter on low-vitality islands
  const ringCount = Math.round(island.mastery * 3);
  for (let ring = 1; ring <= ringCount; ring++) {
    const ringScale = 0.5 + ring * 0.18;
    const ringPts = islandSilhouettePoints(s.x, s.y, radius * ringScale, island.id);
    buildSilhouettePath(ctx, ringPts);
    ctx.strokeStyle = `hsla(${h},${vSat}%,${l}%,${(0.5 * vit).toFixed(3)})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  if (camera.zoom > 0.8) {
    ctx.fillStyle = MAP_INK;
    ctx.font = `${Math.max(10, 12 * camera.zoom)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(island.title, s.x, s.y + radius + 14);
    if (island.dueCount > 0) {
      ctx.font = `600 ${Math.max(9, 10 * camera.zoom)}px system-ui,sans-serif`;
      ctx.fillStyle = 'rgba(220,80,60,0.9)';
      ctx.fillText(`${island.dueCount} due`, s.x, s.y + radius + 28);
    }
  }
}

function drawMapBackground(rect) {
  const grad = ctx.createLinearGradient(0, 0, 0, rect.height);
  grad.addColorStop(0, MAP_BG_SKY);
  grad.addColorStop(1, MAP_BG_HORIZON);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, rect.width, rect.height);
}

function islandSilhouettePoints(cx, cy, baseRadius, islandId, extraRadius = 0) {
  const count = 14;
  const points = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const noise = hashToUnit(`${i * 1013}:${islandId}`);
    const r = (baseRadius * (0.72 + 0.28 * noise)) + extraRadius;
    points.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r
    });
  }
  return points;
}

function buildSilhouettePath(ctx, points) {
  const n = points.length;
  if (n < 3) return;
  ctx.beginPath();
  const mid0 = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  ctx.moveTo(mid0.x, mid0.y);
  for (let i = 1; i < n; i++) {
    const next = points[(i + 1) % n];
    const mid = { x: (points[i].x + next.x) / 2, y: (points[i].y + next.y) / 2 };
    ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
  }
  ctx.quadraticCurveTo(points[0].x, points[0].y, mid0.x, mid0.y);
  ctx.closePath();
}

function drawIslandTexture(cx, cy, radius, islandId, cardCount, { h, s: sat, l }) {
  const dotCount = Math.min(40, Math.round((cardCount || 0) * 0.6));
  if (dotCount <= 0) return;
  const dotRadius = Math.max(1.5, 1.8 * camera.zoom);
  ctx.fillStyle = `hsla(${h},${Math.min(100, sat + 15)}%,${Math.max(0, l - 24)}%,0.65)`;
  for (let k = 0; k < dotCount; k++) {
    const r = radius * 0.72 * Math.sqrt(hashToUnit(`${k * 7919}:tex:${islandId}`));
    const theta = hashToUnit(`${k * 4999}:tth:${islandId}`) * Math.PI * 2;
    const dx = cx + Math.cos(theta) * r;
    const dy = cy + Math.sin(theta) * r;
    ctx.beginPath();
    ctx.arc(dx, dy, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawIslandSimple(island) {
  const s = worldToScreen(island.pos.x, island.pos.y);
  const { h, s: sat, l } = islandColor(island.mastery, island.id);
  ctx.beginPath();
  ctx.fillStyle = `hsl(${h},${sat}%,${l}%)`;
  ctx.arc(s.x, s.y, LOD_SIMPLE_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

// ---- L2 drawing -----------------------------------------------------------

function drawLandmark(lm) {
  const tl = worldToScreen(lm.x - lm.w / 2, lm.y - lm.h / 2);
  const br = worldToScreen(lm.x + lm.w / 2, lm.y + lm.h / 2);
  const w = br.x - tl.x;
  const h = br.y - tl.y;
  ctx.save();
  ctx.fillStyle = 'rgba(46,125,50,0.05)';
  ctx.strokeStyle = 'rgba(46,125,50,0.35)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  roundRect(ctx, tl.x, tl.y, w, h, 12);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = MAP_INK;
  ctx.globalAlpha = 0.7;
  ctx.font = `600 ${Math.max(11, 12 * camera.zoom)}px system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(lm.name, (tl.x + br.x) / 2, tl.y + 16 * camera.zoom);
  ctx.restore();
}

function drawAnnotation(ann) {
  if (ann.type === 'text') {
    const s = worldToScreen(ann.x, ann.y);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = MAP_INK;
    ctx.font = `${Math.max(11, 13 * camera.zoom)}px system-ui,sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(ann.text || '', s.x, s.y);
    ctx.restore();
  } else if (ann.type === 'path' && ann.pathData) {
    // pathData is a series of world-space points: "x,y x,y ..."
    const pts = ann.pathData.split(' ').map(p => {
      const [x, y] = p.split(',').map(Number);
      return worldToScreen(x, y);
    });
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = MAP_INK;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawRelationshipLines() {
  for (const rel of relationships) {
    const a = cardNodes.find(n => n.id === rel.fromId);
    if (!a) continue;
    let bx, by;
    if (rel.crossDeck) {
      // Line to edge of viewport in direction of target
      const s = worldToScreen(a.x, a.y);
      bx = a.x + 120; by = a.y - 40;
    } else {
      const b = cardNodes.find(n => n.id === rel.toId);
      if (!b) continue;
      bx = b.x; by = b.y;
    }
    const sa = worldToScreen(a.x, a.y);
    const sb = worldToScreen(bx, by);

    const isHi = highlightedNodeId &&
      (rel.fromId === highlightedNodeId || rel.toId === highlightedNodeId);
    const dim = highlightedNodeId && !isHi;

    ctx.save();
    ctx.globalAlpha = dim ? 0.08 : (isHi ? 0.7 : 0.3);
    ctx.strokeStyle = MAP_INK;
    ctx.lineWidth = isHi ? 2 : 1.25;
    if (rel.type === 'related') ctx.setLineDash([5, 4]);
    else ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();

    if (rel.type === 'dependsOn' && !rel.crossDeck) {
      // Arrowhead at target
      const angle = Math.atan2(sb.y - sa.y, sb.x - sa.x);
      const head = 7;
      ctx.beginPath();
      ctx.moveTo(sb.x, sb.y);
      ctx.lineTo(sb.x - head * Math.cos(angle - 0.4), sb.y - head * Math.sin(angle - 0.4));
      ctx.lineTo(sb.x - head * Math.cos(angle + 0.4), sb.y - head * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = MAP_INK;
      ctx.fill();
    }

    if (rel.crossDeck && rel.label) {
      ctx.setLineDash([]);
      ctx.font = '11px system-ui,sans-serif';
      ctx.fillStyle = MAP_INK;
      ctx.fillText(rel.label, sb.x, sb.y);
    }
    ctx.restore();
  }
}

function drawPathLine(nodeIds, isDraft) {
  const pts = nodeIds.map(id => cardNodes.find(n => n.id === id)).filter(Boolean);
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = isDraft ? 'rgba(46,125,50,0.7)' : 'rgba(46,125,50,0.35)';
  ctx.lineWidth = isDraft ? 2.5 : 1.5;
  ctx.setLineDash(isDraft ? [8, 6] : [4, 6]);
  ctx.beginPath();
  const s0 = worldToScreen(pts[0].x, pts[0].y);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < pts.length; i++) {
    const s = worldToScreen(pts[i].x, pts[i].y);
    ctx.lineTo(s.x, s.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCardNode(node) {
  const s = worldToScreen(node.x, node.y);
  const r = node.radius * camera.zoom;
  const { h, s: sat, l } = islandColor(node.mastery, node.id);

  // Pulse after grade
  if (node.pulse > 0) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 10 * node.pulse, 0, Math.PI * 2);
    ctx.strokeStyle = node.pulseColor || 'rgba(46,125,50,0.6)';
    ctx.lineWidth = 3;
    ctx.globalAlpha = node.pulse;
    ctx.stroke();
    ctx.globalAlpha = 1;
    node.pulse = Math.max(0, node.pulse - 0.03);
  }

  const isHi = highlightedNodeId === node.id || hoveredCard === node;
  const inPath = pathDraft.includes(node.id);

  if (isHi || inPath) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = inPath ? 'rgba(46,125,50,0.8)' : 'rgba(46,125,50,0.5)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.fillStyle = `hsl(${h},${sat}%,${l}%)`;
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.stroke();

  // Label
  if (camera.zoom > 0.7) {
    const label = (node.card.front || '').slice(0, 28);
    ctx.fillStyle = MAP_INK;
    ctx.font = `${Math.max(9, 11 * camera.zoom)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label + (node.card.front?.length > 28 ? '…' : ''), s.x, s.y + r + 12);
  }
}

function drawDeckHeader() {
  if (!activeDeckId) return;
  const deck = worldTerritories.flatMap(t => t.islands).find(i => i.deckId === activeDeckId);
  const title = deck?.title || 'Deck';
  const rect = canvasEl.getBoundingClientRect();
  ctx.save();
  ctx.fillStyle = MAP_INK;
  ctx.globalAlpha = 0.85;
  ctx.font = '600 15px system-ui,sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 16, 28);
  ctx.font = '12px system-ui,sans-serif';
  ctx.globalAlpha = 0.55;
  ctx.fillText(`${cardNodes.length} cards · ${landmarks.length} landmarks`, 16, 46);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

function attachGestureHandlers() {
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
}

function onPointerDown(e) {
  canvasEl.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // A fresh touch during an in-flight fly-in (see flyIntoDeck()) means
  // the person is redirecting -- panning, pinching, or tapping something
  // else -- not passively waiting for the earlier tap's deck to open.
  // Without this, dragging away mid-zoom-in could leave the pending
  // commit sitting there and fire enterDeckView() for the original
  // island later, once the camera happens to settle somewhere else
  // entirely, opening a deck the person never actually chose.
  if (cameraArrivedTimeoutId !== null) {
    clearTimeout(cameraArrivedTimeoutId);
    cameraArrivedTimeoutId = null;
    cameraArrivedCallback = null;
  }
  scheduleFrame(0);
  const rect = canvasEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (activePointers.size === 1) {
    dragMoved = 0;
    draggedIsland = null;
    draggedCard = null;
    draggedLandmark = null;
    pendingIslandHit = null;
    pendingCardHit = null;
    pendingLandmarkHit = null;

    if (zoomLevel === 1) {
      const hit = hitTestIsland(sx, sy);
      if (hit) { pendingIslandHit = hit; isPanning = false; }
      else { isPanning = true; }
    } else if (zoomLevel >= 2) {
      const lm = hitTestLandmark(sx, sy);
      const card = hitTestCard(sx, sy);
      if (card) { pendingCardHit = card; isPanning = false; }
      else if (lm) { pendingLandmarkHit = lm; isPanning = false; }
      else { isPanning = true; }
    }
    lastPointer = { x: e.clientX, y: e.clientY };
  } else if (activePointers.size === 2) {
    isPanning = false;
    pendingIslandHit = pendingCardHit = pendingLandmarkHit = null;
    draggedIsland = draggedCard = draggedLandmark = null;
    const [p1, p2] = Array.from(activePointers.values());
    pinchStartDist = distance(p1, p2);
    pinchStartZoom = camera.zoom;
  }
}

function onPointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2 && pinchStartDist) {
    const [p1, p2] = Array.from(activePointers.values());
    const dist = distance(p1, p2);
    const factor = dist / pinchStartDist;
    targetCamera.zoom = clampZoom(pinchStartZoom * factor);
    camera.zoom = targetCamera.zoom;
    return;
  }

  if (activePointers.size !== 1 || !lastPointer) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  dragMoved += Math.hypot(dx, dy);

  // Commit pending drags
  if (pendingIslandHit && dragMoved > DRAG_COMMIT_THRESHOLD) {
    draggedIsland = pendingIslandHit;
    pendingIslandHit = null;
  }
  if (pendingCardHit && dragMoved > DRAG_COMMIT_THRESHOLD) {
    draggedCard = pendingCardHit;
    pendingCardHit = null;
  }
  if (pendingLandmarkHit && dragMoved > DRAG_COMMIT_THRESHOLD) {
    draggedLandmark = pendingLandmarkHit;
    pendingLandmarkHit = null;
  }

  if (draggedIsland) {
    const wdx = dx / camera.zoom;
    const wdy = dy / camera.zoom;
    draggedIsland.pos.x += wdx;
    draggedIsland.pos.y += wdy;
  } else if (draggedCard) {
    const wdx = dx / camera.zoom;
    const wdy = dy / camera.zoom;
    draggedCard.x += wdx;
    draggedCard.y += wdy;
    // Snap to landmark
    for (const lm of landmarks) {
      const d = Math.hypot(draggedCard.x - lm.x, draggedCard.y - lm.y);
      if (d < SNAP_DISTANCE) {
        draggedCard.x += (lm.x - draggedCard.x) * 0.15;
        draggedCard.y += (lm.y - draggedCard.y) * 0.15;
      }
    }
  } else if (draggedLandmark) {
    draggedLandmark.x += dx / camera.zoom;
    draggedLandmark.y += dy / camera.zoom;
  } else if (isPanning) {
    targetCamera.x -= dx / camera.zoom;
    targetCamera.y -= dy / camera.zoom;
    camera.x = targetCamera.x;
    camera.y = targetCamera.y;
  }

  // Hover
  const rect = canvasEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (zoomLevel === 1) hoveredIsland = hitTestIsland(sx, sy);
  else {
    hoveredCard = hitTestCard(sx, sy);
    highlightedNodeId = hoveredCard?.id || null;
  }

  lastPointer = { x: e.clientX, y: e.clientY };
}

function onPointerUp(e) {
  const wasTap = activePointers.size === 1 && dragMoved < 6;
  const rect = canvasEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (wasTap) {
    handleTap(sx, sy);
  } else {
    // Persist drags. Deliberately not awaited — a position save
    // shouldn't block the next drag frame — but a failure is no longer
    // fully silent: console.warn at minimum, so a real storage problem
    // (quota, eviction) leaves a trace instead of just vanishing.
    if (draggedIsland) {
      saveIslandPosition(draggedIsland.id, draggedIsland.pos.x, draggedIsland.pos.y)
        .catch(err => console.warn('Failed to save island position:', err));
    }
    if (draggedCard) {
      saveConceptPosition(draggedCard.id, draggedCard.x, draggedCard.y)
        .catch(err => console.warn('Failed to save card position:', err));
    }
    if (draggedLandmark) {
      saveLandmark(draggedLandmark)
        .catch(err => console.warn('Failed to save landmark position:', err));
    }
  }

  activePointers.delete(e.pointerId);
  draggedIsland = draggedCard = draggedLandmark = null;
  pendingIslandHit = pendingCardHit = pendingLandmarkHit = null;
  if (activePointers.size < 2) pinchStartDist = null;
  if (activePointers.size === 0) {
    isPanning = false;
    lastPointer = null;
    dragMoved = 0;
  }
}

function handleTap(sx, sy) {
  if (zoomLevel === 1) {
    const hit = hitTestIsland(sx, sy);
    if (hit) flyIntoDeck(hit);
    return;
  }

  if (zoomLevel === 2) {
    const card = hitTestCard(sx, sy);
    if (card) {
      if (pathBuildMode) {
        if (!pathDraft.includes(card.id)) pathDraft.push(card.id);
        updateToolbar();
        scheduleFrame(0);
        return;
      }
      if (annotateMode) return;
      enterCardDetail(card.id);
      return;
    }
    if (annotateMode) {
      // Place text annotation
      const w = screenToWorld(sx, sy);
      promptTextModal({ title: 'Annotation text', placeholder: 'Note…', submitLabel: 'Add' }, async (text) => {
        const rec = await saveAnnotation({ deckId: activeDeckId, type: 'text', text, x: w.x, y: w.y });
        annotations.push(rec);
        scheduleFrame(0);
      });
      return;
    }

    // Outside annotate/path-build mode, a plain tap on an existing
    // landmark or annotation offers to delete it — previously neither
    // was reachable at all (only draggable), so this was pure dead
    // capability: deleteLandmark/deleteAnnotation existed in db.js but
    // nothing in the UI ever called them.
    const landmark = hitTestLandmark(sx, sy);
    if (landmark) {
      confirmModal(`Delete landmark "${landmark.name}"?`, 'Delete', async () => {
        await deleteLandmark(landmark.id);
        landmarks = landmarks.filter(l => l.id !== landmark.id);
        scheduleFrame(0);
      });
      return;
    }
    const annotation = hitTestAnnotation(sx, sy);
    if (annotation) {
      confirmModal('Delete this annotation?', 'Delete', async () => {
        await deleteAnnotation(annotation.id);
        annotations = annotations.filter(a => a.id !== annotation.id);
        scheduleFrame(0);
      });
      return;
    }
    return;
  }

  // L3 — taps outside detail panel zoom back
  if (zoomLevel === 3) {
    // handled by panel buttons
  }
}

function onWheel(e) {
  e.preventDefault();
  const zoomDelta = -e.deltaY * 0.001;
  const next = clampZoom(camera.zoom * (1 + zoomDelta));
  targetCamera.zoom = next;
  camera.zoom = next;
  scheduleFrame(0);

  // Zoom-out past threshold returns to previous level
  if (zoomLevel === 3 && next < 1.4) exitToL2();
  else if (zoomLevel === 2 && next < 0.55) exitToL1();
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hitTestIsland(screenX, screenY) {
  const radius = camera.zoom >= LOD_ISLAND_DETAIL_THRESHOLD
    ? ISLAND_RADIUS_BASE * camera.zoom
    : LOD_SIMPLE_DOT_RADIUS;
  for (const territory of worldTerritories) {
    for (const island of territory.islands) {
      const s = worldToScreen(island.pos.x, island.pos.y);
      if (distance({ x: screenX, y: screenY }, s) <= radius + 4) return island;
    }
  }
  return null;
}

function hitTestCard(screenX, screenY) {
  for (let i = cardNodes.length - 1; i >= 0; i--) {
    const node = cardNodes[i];
    const s = worldToScreen(node.x, node.y);
    const r = node.radius * camera.zoom + 4;
    if (distance({ x: screenX, y: screenY }, s) <= r) return node;
  }
  return null;
}

/** Small reusable confirm modal — same pattern as promptAnnotationText. */
function confirmModal(message, confirmLabel, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute; inset:0; background:rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; z-index:50;';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:16px; width:min(300px, 85%); box-shadow:var(--shadow-lg);';
  box.innerHTML = `<div style="font-size:14px; color:var(--ink); margin-bottom:14px; line-height:1.4;">${escapeHtml(message)}</div>`;

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 14px; border:none; border-radius:var(--radius-sm); background:var(--surface-raised, var(--surface)); color:var(--ink-secondary); font-size:13px; cursor:pointer;';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = confirmLabel;
  confirmBtn.style.cssText = 'padding:8px 14px; border:none; border-radius:var(--radius-sm); background:#C4472B; color:white; font-size:13px; font-weight:600; cursor:pointer;';

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  (container || document.body).appendChild(overlay);

  function close() { overlay.remove(); }
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await onConfirm();
      close();
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Failed — retry?';
    }
  });
}

function hitTestAnnotation(screenX, screenY) {
  for (const ann of annotations) {
    if (ann.type !== 'text') continue; // freehand-path annotations aren't hit-testable yet
    const s = worldToScreen(ann.x, ann.y);
    const w = Math.max(40, (ann.text || '').length * 6.5 * camera.zoom);
    const h = 18 * camera.zoom;
    if (screenX >= s.x - 4 && screenX <= s.x + w && screenY >= s.y - h && screenY <= s.y + 4) return ann;
  }
  return null;
}

function hitTestLandmark(screenX, screenY) {
  for (const lm of landmarks) {
    const tl = worldToScreen(lm.x - lm.w / 2, lm.y - lm.h / 2);
    const br = worldToScreen(lm.x + lm.w / 2, lm.y + lm.h / 2);
    if (screenX >= tl.x && screenX <= br.x && screenY >= tl.y && screenY <= br.y) return lm;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overlays: breadcrumb, toolbar, detail panel, path panel
// ---------------------------------------------------------------------------

function buildOverlays() {
  // List view button
  if (onExitCallback) {
    const listBtn = document.createElement('button');
    listBtn.className = 'map-overlay-list-btn';
    listBtn.textContent = 'List view';
    listBtn.addEventListener('click', () => onExitCallback());
    container.appendChild(listBtn);
  }

  breadcrumbEl = document.createElement('div');
  breadcrumbEl.className = 'map-breadcrumb';
  breadcrumbEl.setAttribute('aria-live', 'polite');
  container.appendChild(breadcrumbEl);

  toolbarEl = document.createElement('div');
  toolbarEl.className = 'map-floating-toolbar';
  container.appendChild(toolbarEl);

  pathPanelEl = document.createElement('div');
  pathPanelEl.className = 'map-path-panel is-collapsed';
  container.appendChild(pathPanelEl);

  updateToolbar();
}

function updateBreadcrumb() {
  if (!breadcrumbEl) return;
  const parts = ['Territories'];
  if (zoomLevel >= 2 && activeDeckId) {
    const isl = worldTerritories.flatMap(t => t.islands).find(i => i.deckId === activeDeckId);
    parts.push(isl?.title || 'Deck');
  }
  if (zoomLevel === 3 && activeCardId) {
    const node = cardNodes.find(n => n.id === activeCardId);
    const label = (node?.card.front || 'Card').slice(0, 24);
    parts.push(label);
  }
  breadcrumbEl.innerHTML = parts.map((p, i) => {
    const level = i + 1;
    return `<button class="map-crumb" data-level="${level}">${escapeHtml(p)}</button>`;
  }).join('<span class="map-crumb-sep">›</span>');

  breadcrumbEl.querySelectorAll('.map-crumb').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = Number(btn.dataset.level);
      if (lvl === 1) exitToL1();
      else if (lvl === 2) exitToL2();
    });
  });
}

function updateToolbar() {
  if (!toolbarEl) return;
  if (zoomLevel === 1) {
    toolbarEl.innerHTML = `
      <button class="map-tool-btn" id="toolFit" title="Fit">⊡</button>
    `;
    toolbarEl.querySelector('#toolFit')?.addEventListener('click', fitCameraToContent);
    pathPanelEl.classList.add('is-collapsed');
    return;
  }

  // L2 / L3
  toolbarEl.innerHTML = `
    <button class="map-tool-btn" id="toolLandmark" title="Add landmark">🏷️</button>
    <button class="map-tool-btn ${pathBuildMode ? 'is-active' : ''}" id="toolPath" title="New path">🛤️</button>
    <button class="map-tool-btn ${annotateMode ? 'is-active' : ''}" id="toolAnnotate" title="Annotate">📝</button>
    <button class="map-tool-btn is-primary" id="toolSpatial" title="Review on map">🎯</button>
    <button class="map-tool-btn" id="toolStudy" title="Classic study">▶️</button>
    ${pathBuildMode ? '<button class="map-tool-btn is-primary" id="toolSavePath">Save path</button><button class="map-tool-btn" id="toolCancelPath">Cancel</button>' : ''}
  `;

  toolbarEl.querySelector('#toolLandmark')?.addEventListener('click', onAddLandmark);
  toolbarEl.querySelector('#toolPath')?.addEventListener('click', () => {
    pathBuildMode = !pathBuildMode;
    pathDraft = [];
    annotateMode = false;
    updateToolbar();
  });
  toolbarEl.querySelector('#toolAnnotate')?.addEventListener('click', () => {
    annotateMode = !annotateMode;
    pathBuildMode = false;
    updateToolbar();
  });
  toolbarEl.querySelector('#toolSpatial')?.addEventListener('click', startSpatialFromMap);
  toolbarEl.querySelector('#toolStudy')?.addEventListener('click', () => {
    if (!activeDeckId) return;
    // Capture refs BEFORE destroyCanvasView nulls module-level container
    const el = container;
    const exitCb = onExitCallback;
    const deckId = activeDeckId;
    destroyCanvasView();
    startStudySession(el, {
      deckId,
      onExit: () => initCanvasView(el, { onExit: exitCb, deckId })
    });
  });
  toolbarEl.querySelector('#toolSavePath')?.addEventListener('click', onSavePath);
  toolbarEl.querySelector('#toolCancelPath')?.addEventListener('click', () => {
    pathBuildMode = false;
    pathDraft = [];
    updateToolbar();
  });

  renderPathPanel();
}

function renderPathPanel() {
  if (!pathPanelEl || zoomLevel < 2) {
    pathPanelEl?.classList.add('is-collapsed');
    return;
  }
  if (!studyPaths.length) {
    pathPanelEl.classList.add('is-collapsed');
    pathPanelEl.innerHTML = '';
    return;
  }
  pathPanelEl.classList.remove('is-collapsed');
  pathPanelEl.innerHTML = `
    <div class="map-path-panel-title">Paths</div>
    ${studyPaths.map(p => `
      <div class="map-path-row" style="display:flex; align-items:center; gap:4px;">
        <button class="map-path-item" data-id="${p.id}" style="flex:1;">
          <span>${escapeHtml(p.name)}</span>
          <span class="map-path-count">${p.nodeIds?.length || 0}</span>
        </button>
        <button class="map-path-delete" data-id="${p.id}" title="Delete path" style="border:none; background:transparent; color:var(--ink-muted); font-size:14px; cursor:pointer; padding:4px 8px;">×</button>
      </div>
    `).join('')}
  `;
  pathPanelEl.querySelectorAll('.map-path-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = studyPaths.find(p => p.id === btn.dataset.id);
      if (path) startSpatialFromMap({ pathNodeIds: path.nodeIds });
    });
  });
  pathPanelEl.querySelectorAll('.map-path-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = studyPaths.find(p => p.id === btn.dataset.id);
      if (!path) return;
      confirmModal(`Delete path "${path.name}"?`, 'Delete', async () => {
        await deleteStudyPath(path.id);
        studyPaths = studyPaths.filter(p => p.id !== path.id);
        renderPathPanel();
        scheduleFrame(0);
      });
    });
  });
}

async function onAddLandmark() {
  if (!activeDeckId) return;
  promptTextModal({ title: 'Landmark name', placeholder: 'Fundamentals', defaultValue: 'Fundamentals', submitLabel: 'Add' }, async (name) => {
    const rec = await saveLandmark({
      deckId: activeDeckId,
      name,
      x: camera.x,
      y: camera.y,
      w: 240,
      h: 170
    });
    landmarks.push(rec);
    scheduleFrame(0);
  });
}

async function onSavePath() {
  if (!activeDeckId || pathDraft.length < 2) {
    infoModal('Tap at least 2 cards to build a path.');
    return;
  }
  promptTextModal({ title: 'Path name', placeholder: 'Study path', defaultValue: 'Study path', submitLabel: 'Save' }, async (name) => {
    const rec = await saveStudyPath({
      deckId: activeDeckId,
      name,
      nodeIds: [...pathDraft]
    });
    studyPaths.push(rec);
    pathBuildMode = false;
    pathDraft = [];
    updateToolbar();
    renderPathPanel();
    scheduleFrame(0);
  });
}

async function showDetailPanel(cardId) {
  hideDetailPanel();
  const card = await getCard(cardId);
  if (!card) return;

  const from = await getRelationshipsFrom(cardId);
  const to = await getRelationshipsTo(cardId);

  detailPanelEl = document.createElement('div');
  detailPanelEl.className = 'map-card-detail';
  detailPanelEl.setAttribute('role', 'dialog');
  detailPanelEl.setAttribute('aria-label', 'Card detail');
  detailPanelEl.innerHTML = `
    <button class="map-detail-close" id="detailBack" aria-label="Back">← Back</button>
    <div class="map-detail-front">${escapeHtml(card.front || '')}</div>
    <div class="map-detail-back">${escapeHtml(card.back || '')}</div>
    ${card.formula ? `<div class="map-detail-formula">$$${escapeHtml(card.formula)}$$</div>` : ''}
    <div class="map-detail-rels">
      ${from.filter(r => !r.targetMissing).map(r =>
        `<span class="map-rel-chip" data-id="${r.cardId}">depends → ${escapeHtml((r.front || '').slice(0, 30))}</span>`
      ).join('')}
      ${to.filter(r => !r.sourceMissing).map(r =>
        `<span class="map-rel-chip" data-id="${r.cardId}">← ${escapeHtml((r.front || '').slice(0, 30))}</span>`
      ).join('')}
    </div>
    <button class="btn-primary map-detail-study" id="detailStudy">Study this card</button>
  `;
  container.appendChild(detailPanelEl);

  detailPanelEl.querySelector('#detailBack').addEventListener('click', exitToL2);
  detailPanelEl.querySelector('#detailStudy').addEventListener('click', () => {
    const el = container;
    const exitCb = onExitCallback;
    const deckId = activeDeckId;
    destroyCanvasView();
    startStudySession(el, {
      deckId,
      startCardId: cardId,
      onExit: () => initCanvasView(el, { onExit: exitCb, deckId })
    });
  });
}

/**
 * Reusable text-input modal — replaces native prompt() calls for
 * annotation text, landmark naming, and path naming. One implementation,
 * three call sites, instead of three separate native dialogs. Shows an
 * inline error and stays open on save failure, rather than silently
 * losing what was typed. Self-contained in canvas.js (no import from
 * app.js, to avoid a circular module dependency) but uses the same CSS
 * variables as the rest of the app so it looks native to it.
 */
function promptTextModal({ title, placeholder = '', defaultValue = '', submitLabel = 'Save' }, onSubmit) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute; inset:0; background:rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; z-index:50;';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:16px; width:min(320px, 85%); box-shadow:var(--shadow-lg);';
  box.innerHTML = `<div style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:10px;">${escapeHtml(title)}</div>`;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = defaultValue;
  input.style.cssText = 'width:100%; padding:10px; border:1px solid rgba(0,0,0,0.1); border-radius:var(--radius-sm); background:var(--bg); color:var(--ink); font-size:14px; box-sizing:border-box; margin-bottom:8px;';
  box.appendChild(input);

  const errorLine = document.createElement('div');
  errorLine.style.cssText = 'font-size:12px; color:#C4472B; margin-bottom:8px; display:none;';
  box.appendChild(errorLine);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 14px; border:none; border-radius:var(--radius-sm); background:var(--surface-raised, var(--surface)); color:var(--ink-secondary); font-size:13px; cursor:pointer;';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = submitLabel;
  saveBtn.style.cssText = 'padding:8px 14px; border:none; border-radius:var(--radius-sm); background:var(--accent); color:white; font-size:13px; font-weight:600; cursor:pointer;';

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  (container || document.body).appendChild(overlay);

  input.focus();
  input.select();

  function close() { overlay.remove(); }
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  async function attemptSubmit() {
    const text = input.value.trim();
    if (!text) { close(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await onSubmit(text);
      close();
    } catch (err) {
      errorLine.textContent = 'Could not save — try again.';
      errorLine.style.display = 'block';
      saveBtn.disabled = false;
      saveBtn.textContent = submitLabel;
    }
  }
  saveBtn.addEventListener('click', attemptSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptSubmit();
    if (e.key === 'Escape') close();
  });
}

/** Single-button info modal — replaces native alert() calls. */
function infoModal(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute; inset:0; background:rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; z-index:50;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:16px; width:min(300px, 85%); box-shadow:var(--shadow-lg); text-align:center;';
  box.innerHTML = `<div style="font-size:14px; color:var(--ink); margin-bottom:14px; line-height:1.4;">${escapeHtml(message)}</div>`;
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.textContent = 'OK';
  okBtn.style.cssText = 'padding:8px 20px; border:none; border-radius:var(--radius-sm); background:var(--accent); color:white; font-size:13px; font-weight:600; cursor:pointer;';
  okBtn.addEventListener('click', () => overlay.remove());
  box.appendChild(okBtn);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  (container || document.body).appendChild(overlay);
  okBtn.focus();
}

function hideDetailPanel() {
  detailPanelEl?.remove();
  detailPanelEl = null;
}


async function startSpatialFromMap(opts = {}) {
  if (!activeDeckId) return;
  const { startSpatialReview } = await import('./spatial-study.js');
  await startSpatialReview(container, activeDeckId, {
    pathNodeIds: opts.pathNodeIds || null,
    onGrade: (cardId, grade) => {
      const node = cardNodes.find(n => n.id === cardId);
      if (!node) return;
      node.pulse = 1;
      node.pulseColor = grade === 'again' ? 'rgba(220,60,50,0.8)'
        : grade === 'easy' ? 'rgba(46,160,80,0.8)'
        : 'rgba(200,160,40,0.7)';
      // Refresh mastery tint
      getCard(cardId).then(c => {
        if (c && node) node.mastery = Math.min(1, (c.stability || 0) / 30);
      });
    },
    onExit: () => {
      // Stay on map at L2
      updateToolbar();
    },
    camera,
    targetCamera,
    cardNodes,
    worldToScreen: (x, y) => worldToScreen(x, y)
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

if (typeof window !== 'undefined') {
  window.__mapDebug = {
    getWorldTerritories: () => worldTerritories,
    getCrossDeckPairs: () => crossDeckPairs,
    getCamera: () => camera,
    worldToScreen,
    getCanvas: () => canvasEl,
    getZoomLevel: () => zoomLevel
  };
}
