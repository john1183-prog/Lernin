/* canvas.js — Spatial Learning Map
   L1 Territory view · L2 Deck/card nodes · L3 Card detail
   Landmarks, relationship lines, study paths, annotations.
   Spatial review is delegated to spatial-study.js.
*/

import {
  getAllDecks, getCardsByDeck, getCard, getDeck,
  saveIslandPosition, getIslandPositionOverrides, clearIslandPosition,
  saveConceptPosition, getConceptPositionOverrides,
  getRelationshipsFrom, getRelationshipsTo,
  saveLandmark, getLandmarksForDeck, deleteLandmark,
  saveStudyPath, getStudyPathsForDeck, deleteStudyPath,
  saveAnnotation, getAnnotationsForDeck, deleteAnnotation
} from './db.js';
import { startStudySession } from './study.js';

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

let camera = { x: 0, y: 0, zoom: 1 };
let targetCamera = { x: 0, y: 0, zoom: 1 };

/** @type {1|2|3} */
let zoomLevel = 1;
let activeDeckId = null;       // L2/L3
let activeCardId = null;       // L3
let worldTerritories = [];
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
  rafId = requestAnimationFrame(renderLoop);
}

export function destroyCanvasView() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
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
    getAllDecks(),
    getIslandPositionOverrides()
  ]);

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
        relationships.push({
          fromId: node.id, toId: r.cardId, type: r.type,
          crossDeck: true, label: `→ ${r.deckId.slice(0, 8)}`
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
}

function exitToL2() {
  if (!activeDeckId) return exitToL1();
  activeCardId = null;
  zoomLevel = 2;
  targetCamera.zoom = 1.2;
  hideDetailPanel();
  updateBreadcrumb();
  updateToolbar();
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

function renderLoop() {
  camera.x += (targetCamera.x - camera.x) * 0.12;
  camera.y += (targetCamera.y - camera.y) * 0.12;
  camera.zoom += (targetCamera.zoom - camera.zoom) * 0.12;

  if (!ctx || !canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (zoomLevel === 1) {
    renderL1();
  } else {
    renderL2();
  }

  rafId = requestAnimationFrame(renderLoop);
}

function renderL1() {
  const viewport = getWorldViewportRect();
  for (const territory of worldTerritories) {
    const bounds = territory.bounds ?? territoryBounds(territory);
    if (!rectIntersects(bounds, viewport)) continue;
    drawTerritory(territory, viewport);
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

function drawTerritory(territory, viewport) {
  drawTerritoryActivityHalo(territory);
  for (const island of territory.islands) {
    if (camera.zoom >= LOD_ISLAND_DETAIL_THRESHOLD) drawIsland(island);
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

function drawIslandGlow(island, radius) {
  const s = worldToScreen(island.pos.x, island.pos.y);
  const { h, s: sat, l } = islandColor(island.mastery, island.id);
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
  g.addColorStop(0, `hsla(${h},${sat}%,${l}%,0.35)`);
  g.addColorStop(1, `hsla(${h},${sat}%,${l}%,0)`);
  ctx.beginPath();
  ctx.fillStyle = g;
  ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawIslandSimple(island) {
  const s = worldToScreen(island.pos.x, island.pos.y);
  const { h, s: sat, l } = islandColor(island.mastery, island.id);
  ctx.beginPath();
  ctx.fillStyle = `hsl(${h},${sat}%,${l}%)`;
  ctx.arc(s.x, s.y, LOD_SIMPLE_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

function drawIsland(island) {
  const s = worldToScreen(island.pos.x, island.pos.y);
  const radius = ISLAND_RADIUS_BASE * camera.zoom;
  const { h, s: sat, l } = islandColor(island.mastery, island.id);
  drawIslandGlow(island, radius * 2.2);

  if (island === hoveredIsland) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius + 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(46,125,50,0.55)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.fillStyle = `hsl(${h},${sat}%,${l}%)`;
  ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.stroke();

  const ringCount = Math.round(island.mastery * 3);
  for (let ring = 1; ring <= ringCount; ring++) {
    ctx.beginPath();
    ctx.strokeStyle = `hsla(${h},${sat}%,${l}%,0.5)`;
    ctx.lineWidth = 1.5;
    ctx.arc(s.x, s.y, radius * (0.5 + ring * 0.18), 0, Math.PI * 2);
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
    // Persist drags
    if (draggedIsland) {
      saveIslandPosition(draggedIsland.id, draggedIsland.pos.x, draggedIsland.pos.y);
    }
    if (draggedCard) {
      saveConceptPosition(draggedCard.id, draggedCard.x, draggedCard.y);
    }
    if (draggedLandmark) {
      saveLandmark(draggedLandmark);
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
    if (hit) enterDeckView(hit.deckId);
    return;
  }

  if (zoomLevel === 2) {
    const card = hitTestCard(sx, sy);
    if (card) {
      if (pathBuildMode) {
        if (!pathDraft.includes(card.id)) pathDraft.push(card.id);
        updateToolbar();
        return;
      }
      if (annotateMode) return;
      enterCardDetail(card.id);
      return;
    }
    if (annotateMode) {
      // Place text annotation
      const w = screenToWorld(sx, sy);
      const text = prompt('Annotation text?');
      if (text && text.trim()) {
        saveAnnotation({ deckId: activeDeckId, type: 'text', text: text.trim(), x: w.x, y: w.y })
          .then(rec => { annotations.push(rec); });
      }
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
    destroyCanvasView();
    startStudySession(container, {
      deckId: activeDeckId,
      onExit: () => initCanvasView(container, { onExit: onExitCallback, deckId: activeDeckId })
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
      <button class="map-path-item" data-id="${p.id}">
        <span>${escapeHtml(p.name)}</span>
        <span class="map-path-count">${p.nodeIds?.length || 0}</span>
      </button>
    `).join('')}
  `;
  pathPanelEl.querySelectorAll('.map-path-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = studyPaths.find(p => p.id === btn.dataset.id);
      if (path) startSpatialFromMap({ pathNodeIds: path.nodeIds });
    });
  });
}

async function onAddLandmark() {
  if (!activeDeckId) return;
  const name = prompt('Landmark name?', 'Fundamentals');
  if (!name || !name.trim()) return;
  const rec = await saveLandmark({
    deckId: activeDeckId,
    name: name.trim(),
    x: camera.x,
    y: camera.y,
    w: 240,
    h: 170
  });
  landmarks.push(rec);
}

async function onSavePath() {
  if (!activeDeckId || pathDraft.length < 2) {
    alert('Tap at least 2 cards to build a path.');
    return;
  }
  const name = prompt('Path name?', 'Study path');
  if (!name) return;
  const rec = await saveStudyPath({
    deckId: activeDeckId,
    name: name.trim(),
    nodeIds: [...pathDraft]
  });
  studyPaths.push(rec);
  pathBuildMode = false;
  pathDraft = [];
  updateToolbar();
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
    const deckId = activeDeckId;
    destroyCanvasView();
    startStudySession(container, {
      deckId,
      startCardId: cardId,
      onExit: () => initCanvasView(container, { onExit: onExitCallback, deckId })
    });
  });
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
