// canvas.js
// Layer 1 — the Territory Map. Built last, on top of an already-working
// list view (app.js). This file owns pan/zoom, viewport culling, LOD, and
// hit-testing. It routes taps into Study Mode through the exact same
// startStudySession() entry point app.js uses — no separate path.
//
// Navigation/motivation only: no studying happens in this file.

import { getAllDecks, getCardsByDeck, saveIslandPosition, getIslandPositionOverrides } from './db.js';
import { startStudySession } from './study.js';

// ---------------------------------------------------------------------------
// Layout
// Positions are deterministic (hashed from id), not stored, so there's no
// schema addition needed just to remember "where" a territory sits. If you
// later want user-draggable custom layouts, that's a small addition: an
// optional {x, y} override read from a new db.js store, falling back to
// this hash when absent.
// ---------------------------------------------------------------------------

const TERRITORY_SPACING = 900;   // world-space px between territory centers
const ISLAND_RADIUS_BASE = 26;
const ISLAND_SPACING = 90;

function hashToUnit(str) {
  // Simple deterministic string hash -> [0, 1). Not cryptographic, just
  // needs to be stable across renders for a given id.
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return (h % 10000) / 10000;
}

function territoryPosition(territoryId, index) {
  // Spiral layout so territories don't overlap as more are added, and don't
  // require a fixed grid size decided up front. Deliberately radius=0 at
  // index 0 (no "+0.5" base offset) — the camera starts fixed at world
  // origin (0,0) with no auto-centering logic, so the first (often only)
  // territory MUST land at the origin or it's off-screen on load. This bit
  // everyone with a single territory (i.e. anyone who hasn't split decks
  // across multiple courseTerritoryIds yet) — the map looked completely
  // blank because the one territory that existed was always ~450 world
  // units away from what the camera was looking at.
  const angle = index * 2.4;
  const radius = TERRITORY_SPACING * Math.sqrt(index);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function islandPosition(territoryCenter, islandId, index, total) {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 + hashToUnit(islandId) * 0.5;
  const jitterRadius = ISLAND_SPACING * (1 + (index % 3) * 0.4);
  return {
    x: territoryCenter.x + Math.cos(angle) * jitterRadius,
    y: territoryCenter.y + Math.sin(angle) * jitterRadius
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ctx = null;
let canvasEl = null;
let camera = { x: 0, y: 0, zoom: 1 };
let worldTerritories = []; // [{ id, center, islands: [{ id, deckId, title, pos, mastery }] }]
let container = null;
let onExitCallback = null;

let isPanning = false;
let lastPointer = null;
let pinchStartDist = null;
let pinchStartZoom = null;
const activePointers = new Map();

// Island-drag state — dragging an island repositions it (persisted via
// db.js); dragging empty space pans the camera. These are mutually
// exclusive per gesture, decided at pointerdown time.
let draggedIsland = null;
let dragMoved = 0;

// LOD threshold — below this zoom, draw simplified territory blobs only.
const LOD_ISLAND_DETAIL_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Public entry point — same signature shape as study.js's startStudySession,
// so app.js can call either one interchangeably based on view mode.
// ---------------------------------------------------------------------------

export async function initCanvasView(targetContainer, opts = {}) {
  container = targetContainer;
  onExitCallback = opts.onExit || null;

  container.innerHTML = '';
  canvasEl = document.createElement('canvas');
  canvasEl.className = 'territory-map-canvas';
  container.appendChild(canvasEl);

  ctx = canvasEl.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  await buildWorldModel();
  attachGestureHandlers();
  requestAnimationFrame(render);
}

export function destroyCanvasView() {
  window.removeEventListener('resize', resizeCanvas);
  if (canvasEl) {
    canvasEl.removeEventListener('pointerdown', onPointerDown);
    canvasEl.removeEventListener('pointermove', onPointerMove);
    canvasEl.removeEventListener('pointerup', onPointerUp);
    canvasEl.removeEventListener('wheel', onWheel);
  }
  ctx = null;
  canvasEl = null;
}

function resizeCanvas() {
  if (!canvasEl) return;
  const rect = container.getBoundingClientRect();
  canvasEl.width = rect.width;
  canvasEl.height = rect.height;
}

// ---------------------------------------------------------------------------
// World model — groups decks by courseTerritoryId, computes a mastery score
// per island from its cards' average FSRS stability. Built once per view
// entry, not recomputed every frame.
// ---------------------------------------------------------------------------

async function buildWorldModel() {
  const decks = await getAllDecks();
  const overrides = await getIslandPositionOverrides();
  const byTerritory = new Map();

  for (const deck of decks) {
    const key = deck.courseTerritoryId || 'uncategorized';
    if (!byTerritory.has(key)) byTerritory.set(key, []);
    byTerritory.get(key).push(deck);
  }

  const territoryIds = Array.from(byTerritory.keys());
  worldTerritories = [];

  for (let ti = 0; ti < territoryIds.length; ti++) {
    const territoryId = territoryIds[ti];
    const decksInTerritory = byTerritory.get(territoryId);
    const center = territoryPosition(territoryId, ti);

    const islands = [];
    for (let di = 0; di < decksInTerritory.length; di++) {
      const deck = decksInTerritory[di];
      const cards = await getCardsByDeck(deck.id);
      const mastery = computeMastery(cards);
      const pos = overrides.get(deck.id) || islandPosition(center, deck.id, di, decksInTerritory.length);
      islands.push({
        id: deck.id,
        deckId: deck.id,
        title: deck.title,
        pos,
        mastery
      });
    }

    worldTerritories.push({ id: territoryId, center, islands });
  }
}

/**
 * 0 (untouched) to 1 (well-mastered), averaged across a deck's cards.
 * Stability is unbounded in FSRS, so this is a soft, capped normalization —
 * a display heuristic, not an FSRS-accurate metric.
 */
function computeMastery(cards) {
  if (cards.length === 0) return 0;
  const avgStability = cards.reduce((sum, c) => sum + (c.stability || 0), 0) / cards.length;
  return Math.min(1, avgStability / 30); // ~30 days stability treated as "mastered" for display purposes
}

// ---------------------------------------------------------------------------
// Rendering
// Vector-drawn only (canvas paths/gradients) — no raster image assets.
// ---------------------------------------------------------------------------

// Mirrors styles.css's --bg / --moss / --ochre / --sand tokens. Canvas 2D
// can't read CSS custom properties into its drawing calls directly, so
// these are kept as literal hex constants here — if the palette in
// styles.css changes, update these to match. (A getComputedStyle-based sync
// is possible later but isn't worth the added complexity for three colors.)
const MAP_BG = '#241D14';
const MOSS = '76, 148, 68';     // rgb triple, for use in rgba()
const OCHRE = '181, 129, 60';   // rgb triple

function render() {
  if (!ctx) return; // view was destroyed

  const { width, height } = canvasEl;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, width, height);

  const viewport = getWorldViewportRect();

  for (const territory of worldTerritories) {
    if (!rectIntersects(territory.bounds ?? territoryBounds(territory), viewport)) continue;
    drawTerritory(territory, viewport);
  }

  requestAnimationFrame(render);
}

function territoryBounds(territory) {
  // Computed from the territory's ACTUAL island positions, not a fixed
  // radius around center. A fixed radius (the previous approach) breaks
  // the moment an island is dragged far enough from center — which is
  // exactly what happens when someone rearranges their map — because the
  // outer per-territory cull check in render() would exclude the whole
  // territory (dragged island included) once its assumed fixed-size box no
  // longer intersected the viewport, even though the dragged island itself
  // was still clearly on screen.
  const pad = ISLAND_SPACING + 60; // island radius + room for its label
  if (territory.islands.length === 0) {
    return {
      minX: territory.center.x - pad,
      minY: territory.center.y - pad,
      maxX: territory.center.x + pad,
      maxY: territory.center.y + pad
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

function getWorldViewportRect() {
  const { width, height } = canvasEl;
  const halfW = (width / 2) / camera.zoom;
  const halfH = (height / 2) / camera.zoom;
  return {
    minX: camera.x - halfW,
    minY: camera.y - halfH,
    maxX: camera.x + halfW,
    maxY: camera.y + halfH
  };
}

function rectIntersects(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function worldToScreen(wx, wy) {
  const { width, height } = canvasEl;
  return {
    x: (wx - camera.x) * camera.zoom + width / 2,
    y: (wy - camera.y) * camera.zoom + height / 2
  };
}

function drawTerritory(territory, viewport) {
  const screenCenter = worldToScreen(territory.center.x, territory.center.y);
  const screenRadius = TERRITORY_SPACING * 0.45 * camera.zoom;

  const gradient = ctx.createRadialGradient(
    screenCenter.x, screenCenter.y, 0,
    screenCenter.x, screenCenter.y, screenRadius
  );
  gradient.addColorStop(0, `rgba(${MOSS}, 0.18)`);
  gradient.addColorStop(1, `rgba(${MOSS}, 0.02)`);

  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.arc(screenCenter.x, screenCenter.y, screenRadius, 0, Math.PI * 2);
  ctx.fill();

  // LOD: below the zoom threshold, this soft blob is ALL we draw for the
  // territory — no island-level detail, no labels.
  if (camera.zoom < LOD_ISLAND_DETAIL_THRESHOLD) return;

  for (const island of territory.islands) {
    const islandBounds = {
      minX: island.pos.x - ISLAND_SPACING,
      minY: island.pos.y - ISLAND_SPACING,
      maxX: island.pos.x + ISLAND_SPACING,
      maxY: island.pos.y + ISLAND_SPACING
    };
    if (!rectIntersects(islandBounds, viewport)) continue; // per-island culling
    drawIsland(island);
  }
}

// Sand (new/untouched) -> ochre (in progress) -> moss (mastered) stays the
// backbone signal — same three stops as the mastery bar on deck tiles, so a
// glance at the map and a glance at the deck list agree on what "developed"
// looks like. Defined in HSL (not RGB) so a small per-deck hue jitter can be
// layered on top without a manual RGB<->HSL conversion.
const SAND_HSL = { h: 40, s: 30, l: 68 };
const OCHRE_HSL = { h: 32, s: 50, l: 48 };
const MOSS_HSL = { h: 115, s: 40, l: 40 };

// Every fresh deck starts at mastery 0, which without this would make every
// island on the map an identical dusty-sand dot — the map reads as "blank"
// until someone actually studies something. This gives each deck a stable,
// subtle hue offset (seeded from its own id, so it never changes between
// renders) so islands are visually distinguishable from the very first
// visit. Kept small (±16°) so decks still read as one warm family, not a
// rainbow — mastery (via lerpHsl below) is still the dominant signal.
const HUE_JITTER_RANGE = 16;

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

function drawIsland(island) {
  const screen = worldToScreen(island.pos.x, island.pos.y);
  const radius = ISLAND_RADIUS_BASE * camera.zoom;

  // Mastery drives the sand->ochre->moss progression; the deck's own id
  // drives a subtle hue offset within that — together, color communicates
  // both "how developed is this deck" and "which deck is this," at a glance.
  const { h, s, l } = islandColor(island.mastery, island.id);

  ctx.beginPath();
  ctx.fillStyle = `hsl(${h}, ${s}%, ${l}%)`;
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Detail rings scale with mastery — more "developed" islands get more
  // concentric detail, all vector, no raster.
  const ringCount = Math.round(island.mastery * 3);
  for (let ring = 1; ring <= ringCount; ring++) {
    ctx.beginPath();
    ctx.strokeStyle = `hsla(${h}, ${s}%, ${l}%, 0.5)`;
    ctx.lineWidth = 1.5;
    ctx.arc(screen.x, screen.y, radius * (0.5 + ring * 0.18), 0, Math.PI * 2);
    ctx.stroke();
  }

  if (camera.zoom > 0.8) {
    ctx.fillStyle = '#F0E6D2';
    ctx.font = `${Math.max(10, 12 * camera.zoom)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(island.title, screen.x, screen.y + radius + 14);
  }
}

// ---------------------------------------------------------------------------
// Gestures — pointer events (not touch events), so this works uniformly
// across mouse, touch, and stylus.
// ---------------------------------------------------------------------------

function attachGestureHandlers() {
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
}

// A touch/pointer-down landing on an island doesn't immediately commit to
// "drag this island" — below this many px of accumulated movement, nothing
// moves yet. Without this, a pan gesture that happens to *start* on top of
// an island (a 52px-diameter target, easy to clip when starting a pan near
// a deck) would relocate the island on the very first pixel of movement,
// and that new position gets persisted on release. Above the threshold, it
// commits to a real drag, same as before.
const DRAG_COMMIT_THRESHOLD = 10;
let pendingIslandHit = null; // candidate island from pointerdown, not yet committed to dragging

function onPointerDown(e) {
  canvasEl.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1) {
    const rect = canvasEl.getBoundingClientRect();
    const hit = hitTestIsland(e.clientX - rect.left, e.clientY - rect.top);

    dragMoved = 0;
    draggedIsland = null;
    if (hit) {
      // Candidate only — see DRAG_COMMIT_THRESHOLD above. Camera pan is
      // deliberately NOT started for this pointer either, until we know
      // whether this resolves to a tap, a real island drag, or a pan that
      // merely started on top of an island.
      pendingIslandHit = hit;
      isPanning = false;
    } else {
      pendingIslandHit = null;
      isPanning = true;
    }
    lastPointer = { x: e.clientX, y: e.clientY };
  } else if (activePointers.size === 2) {
    isPanning = false;
    draggedIsland = null;
    pendingIslandHit = null;
    const [p1, p2] = Array.from(activePointers.values());
    pinchStartDist = distance(p1, p2);
    pinchStartZoom = camera.zoom;
  }
}

function onPointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    const [p1, p2] = Array.from(activePointers.values());
    const dist = distance(p1, p2);
    if (pinchStartDist) {
      const newZoom = clampZoom(pinchStartZoom * (dist / pinchStartDist));
      camera.zoom = newZoom;
    }
    return;
  }

  if (!lastPointer) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  dragMoved += Math.abs(dx) + Math.abs(dy);

  if (draggedIsland) {
    // Already committed to dragging this island — move it directly.
    draggedIsland.pos.x += dx / camera.zoom;
    draggedIsland.pos.y += dy / camera.zoom;
  } else if (pendingIslandHit) {
    // Started on an island, not yet committed either way.
    if (dragMoved >= DRAG_COMMIT_THRESHOLD) {
      draggedIsland = pendingIslandHit;
      pendingIslandHit = null;
      // Apply this frame's delta now that we've committed — no retroactive
      // catch-up of the movement that happened during the dead-zone, so the
      // island doesn't jump.
      draggedIsland.pos.x += dx / camera.zoom;
      draggedIsland.pos.y += dy / camera.zoom;
    }
    // Below threshold: don't move anything yet, just keep accumulating.
  } else if (isPanning) {
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
  }

  lastPointer = { x: e.clientX, y: e.clientY };
}

function onPointerUp(e) {
  const wasTap = activePointers.size === 1 && dragMoved < 6;

  if (wasTap) {
    const rect = canvasEl.getBoundingClientRect();
    const hit = hitTestIsland(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) enterStudyFromMap(hit.deckId);
  } else if (draggedIsland) {
    // Real drag on an island — persist the new position rather than
    // discarding it back to the hash-based default on next load.
    saveIslandPosition(draggedIsland.id, draggedIsland.pos.x, draggedIsland.pos.y);
  }

  activePointers.delete(e.pointerId);
  draggedIsland = null;
  pendingIslandHit = null;
  if (activePointers.size < 2) {
    pinchStartDist = null;
  }
  if (activePointers.size === 0) {
    isPanning = false;
    lastPointer = null;
    dragMoved = 0;
  }
}

function onWheel(e) {
  e.preventDefault();
  const zoomDelta = -e.deltaY * 0.001;
  camera.zoom = clampZoom(camera.zoom * (1 + zoomDelta));
}

function clampZoom(z) {
  return Math.min(3, Math.max(0.15, z));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Hit-testing — tapping an island routes into Study Mode through the exact
// same entry point the flat list view uses.
// ---------------------------------------------------------------------------

/**
 * Screen-space hit test. Shared by pointerdown (to decide pan-vs-drag) and
 * pointerup (to resolve a tap) so there's exactly one hit-testing
 * implementation, not two that could drift apart.
 */
function hitTestIsland(screenX, screenY) {
  for (const territory of worldTerritories) {
    for (const island of territory.islands) {
      const screen = worldToScreen(island.pos.x, island.pos.y);
      const radius = ISLAND_RADIUS_BASE * camera.zoom;
      if (distance({ x: screenX, y: screenY }, screen) <= radius) {
        return island;
      }
    }
  }
  return null;
}

function enterStudyFromMap(deckId) {
  destroyCanvasView();
  startStudySession(container, {
    deckId,
    onExit: () => initCanvasView(container, { onExit: onExitCallback })
  });
}
