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

// LOD threshold — below this zoom, islands draw as simplified fixed-size
// dots (see drawIslandSimple) instead of full detail (rings + labels).
// They are still drawn and still tappable at every zoom level; only the
// amount of per-island detail changes.
const LOD_ISLAND_DETAIL_THRESHOLD = 0.5;

// Fixed SCREEN-space radius (not multiplied by zoom) for simplified dots —
// deliberately not shrinking with zoom, so decks stay easy to see and tap
// even zoomed most of the way out, rather than shrinking into unclickable
// specks the way the full-detail island radius (which IS zoom-scaled)
// would.
const LOD_SIMPLE_DOT_RADIUS = 10;

// ---------------------------------------------------------------------------
// Public entry point — same signature shape as study.js's startStudySession,
// so app.js can call either one interchangeably based on view mode.
// ---------------------------------------------------------------------------

export async function initCanvasView(targetContainer, opts = {}) {
  container = targetContainer;
  onExitCallback = opts.onExit || onExitCallback;

  container.innerHTML = '';
  canvasEl = document.createElement('canvas');
  canvasEl.className = 'territory-map-canvas';
  container.appendChild(canvasEl);

  ctx = canvasEl.getContext('2d');
  refreshThemeColors();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  await buildWorldModel();
  fitCameraToContent();
  attachGestureHandlers();
  requestAnimationFrame(render);

  // Built here — not appended externally by app.js after the fact — so it
  // exists on every single path that (re-)initializes the map view,
  // including the internal one below where entering and then exiting a
  // study session re-runs initCanvasView() directly. That path used to
  // skip whatever appended this button from the outside, silently
  // dropping the only way back to list view. Reuses onExitCallback (the
  // same callback app.js passes as onExit when first opening the map) —
  // it already means "the map-view experience as a whole is done," which
  // is exactly what this button should trigger.
  if (onExitCallback) {
    const listViewBtn = document.createElement('button');
    listViewBtn.className = 'map-overlay-list-btn';
    listViewBtn.textContent = 'List view';
    listViewBtn.addEventListener('click', () => onExitCallback());
    container.appendChild(listViewBtn);
  }
}

/**
 * Centers and zooms the camera to fit every island currently on the map,
 * called once right after buildWorldModel() resolves on every view open.
 * Previously the camera always started at a fixed {x:0, y:0, zoom:1} —
 * fine by coincidence for a single territory (which now sits at the
 * origin, see territoryPosition()'s comment), but with multiple
 * territories or islands dragged away from their default spot, that fixed
 * start could easily show mostly empty space with nothing on screen.
 */
function fitCameraToContent() {
  const allIslands = worldTerritories.flatMap((t) => t.islands);
  if (allIslands.length === 0) return; // nothing to fit; keep the default camera

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const island of allIslands) {
    minX = Math.min(minX, island.pos.x);
    minY = Math.min(minY, island.pos.y);
    maxX = Math.max(maxX, island.pos.x);
    maxY = Math.max(maxY, island.pos.y);
  }

  camera.x = (minX + maxX) / 2;
  camera.y = (minY + maxY) / 2;

  if (allIslands.length === 1) {
    // A single island has a zero-size bounding box — dividing the
    // viewport by a near-zero content size below would compute an
    // extreme, meaningless zoom. A fixed, comfortable default instead.
    camera.zoom = 1;
    return;
  }

  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const padding = 1.6; // breathing room around the content, not a tight crop
  const { width, height } = canvasEl;
  camera.zoom = clampZoom(Math.min(width / (contentWidth * padding), height / (contentHeight * padding)));
}

/**
 * Reads --bg and --ink from CSS (styles.css is the single source of truth
 * for the app's palette) into module-level vars for canvas 2D to use,
 * since canvas fillStyle/strokeStyle can't reference CSS custom
 * properties directly. Called once per view-open rather than every frame
 * — cheap enough, and avoids a getComputedStyle call 60 times a second
 * for values that only change if the OS theme changes mid-session (rare,
 * and a fresh view-open re-reads it anyway).
 *
 * This replaces two previously hardcoded hex constants that had silently
 * drifted out of sync with styles.css's actual palette (one was still the
 * *original* dark theme's colors even after two full palette changes) —
 * reading live from CSS means that can't happen again.
 */
function refreshThemeColors() {
  const style = getComputedStyle(document.documentElement);
  // --map-bg/--map-ink, not --bg/--ink: the map deliberately has its own
  // neutral, brand-independent backdrop — see styles.css's :root comment
  // for why using the general --bg (which shares a hue family with
  // --moss, also the color of a fully-mastered island) made mastered
  // islands visually blend into the background.
  MAP_BG = style.getPropertyValue('--map-bg').trim() || MAP_BG;
  MAP_INK = style.getPropertyValue('--map-ink').trim() || MAP_INK;
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
    let allCardsInTerritory = [];
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
      allCardsInTerritory = allCardsInTerritory.concat(cards);
    }

    worldTerritories.push({ id: territoryId, center, islands, activityLevel: computeActivityLevel(allCardsInTerritory) });
  }
}

/**
 * 0 (untouched) to 1 (heavily studied), from total review reps across
 * every card in a territory — distinct from computeMastery(), which is
 * per-island and driven by FSRS stability. Two territories could have
 * identical average mastery but very different amounts of actual time
 * invested (a territory with 3 cards reviewed 40 times each vs. one with
 * 40 cards reviewed 3 times each); this reflects cumulative effort/
 * "aliveness," not how well any individual card is retained. Drawn as an
 * ambient halo behind a territory's islands — see drawTerritoryActivityHalo.
 */
function computeActivityLevel(cardsInTerritory) {
  const totalReps = cardsInTerritory.reduce((sum, c) => sum + (c.reps || 0), 0);
  // Soft cap: 100 cumulative reps across a territory reads as "highly
  // active" for display purposes, same style of display heuristic as
  // computeMastery's 30-day stability cap below — not a precise metric.
  return Math.min(1, totalReps / 100);
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

// Mirrors styles.css's --bg token. Canvas 2D can't read CSS custom
// properties into its drawing calls directly, so this is kept as a
// literal hex constant here — if the palette in styles.css changes,
// update this to match. (--moss/--ochre don't need a canvas-side copy
// anymore now that island glows derive their color from islandColor()'s
// HSL values directly, rather than a fixed rgba() tint.)
let MAP_BG = '#14181C';   // fallback only — refreshThemeColors() overwrites this from CSS on view init
let MAP_INK = '#EDEFF1';  // fallback only — same

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
  // Previously drew one glow gradient centered on territory.center — but a
  // territory can hold several islands, each offset from that center by
  // islandPosition()'s jitter, so the glow's brightest point (where the
  // eye is naturally drawn) very often had NO island there at all, while
  // the actual circles sat off to the side. That's exactly the "duller
  // circles don't have the main circle at their center" bug report — the
  // glow was structurally guaranteed to be off-center from what it was
  // supposedly highlighting whenever a territory had more than one deck.
  // Fixed by making the glow per-island (see drawIslandGlow) instead of
  // per-territory, so it's always concentric with the thing it's under.

  drawTerritoryActivityHalo(territory);

  const showFullDetail = camera.zoom >= LOD_ISLAND_DETAIL_THRESHOLD;

  for (const island of territory.islands) {
    const islandBounds = {
      minX: island.pos.x - ISLAND_SPACING,
      minY: island.pos.y - ISLAND_SPACING,
      maxX: island.pos.x + ISLAND_SPACING,
      maxY: island.pos.y + ISLAND_SPACING
    };
    if (!rectIntersects(islandBounds, viewport)) continue; // per-island culling
    if (showFullDetail) {
      drawIsland(island);
    } else {
      drawIslandSimple(island);
    }
  }
}

/**
 * Soft radial glow directly under one island, in that island's OWN color
 * (not a fixed universal color) — reinforces the per-deck hue identity
 * from islandColor() rather than fighting it with an unrelated tint.
 * Always centered on the exact same point as the circle drawn on top of
 * it, by construction, so it can never end up looking like it's
 * highlighting the wrong spot.
 */
function drawIslandGlow(island, radius) {
  const screen = worldToScreen(island.pos.x, island.pos.y);
  const { h, s, l } = islandColor(island.mastery, island.id);
  const gradient = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, radius);
  gradient.addColorStop(0, `hsla(${h}, ${s}%, ${l}%, 0.28)`);
  gradient.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * A very large, low-opacity ambient glow behind a territory's islands,
 * scaled by computeActivityLevel() rather than any single island's
 * mastery — a territory that's been heavily studied overall feels
 * subtly "alive" even before every individual deck is mastered. Fixed
 * ochre hue rather than tying it to the mastery color progression
 * (sand->ochre->moss): this halo sits at a much larger radius and lower
 * opacity than the per-island glows, so it needed a hue that reads as
 * "ambient warmth" distinct from both the neutral map background and
 * whatever color the islands themselves happen to be — using moss here
 * would risk exactly the same background/foreground hue collision that
 * MAP_BG's own fix (see refreshThemeColors) was about.
 */
function drawTerritoryActivityHalo(territory) {
  if (territory.activityLevel <= 0) return;
  const screen = worldToScreen(territory.center.x, territory.center.y);
  const radius = TERRITORY_SPACING * 0.55 * camera.zoom;
  const opacity = territory.activityLevel * 0.12; // capped subtle — ambience, not a competing shape
  const gradient = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, radius);
  gradient.addColorStop(0, `hsla(33, 65%, 50%, ${opacity})`);
  gradient.addColorStop(1, 'hsla(33, 65%, 50%, 0)');
  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Minimal zoomed-out marker: a solid colored dot, no rings, no label.
 * Colors match drawIsland() exactly (same islandColor() call) so panning
 * across the LOD threshold doesn't change what a deck's color means, only
 * how much detail is drawn around it. Radius is NOT scaled down with the
 * rest of the LOD reduction — it stays a fixed, easy-to-hit screen size
 * regardless of zoom, so decks stay findable and tappable even zoomed
 * most of the way out, rather than shrinking into unclickable specks.
 */
function drawIslandSimple(island) {
  const screen = worldToScreen(island.pos.x, island.pos.y);
  const { h, s, l } = islandColor(island.mastery, island.id);

  drawIslandGlow(island, LOD_SIMPLE_DOT_RADIUS * 2.5);

  ctx.beginPath();
  ctx.fillStyle = `hsl(${h}, ${s}%, ${l}%)`;
  ctx.arc(screen.x, screen.y, LOD_SIMPLE_DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.stroke();
}

// Sand (new/untouched) -> ochre (in progress) -> moss (mastered) stays the
// backbone signal — same three stops as the mastery bar on deck tiles, so a
// glance at the map and a glance at the deck list agree on what "developed"
// looks like. Values match styles.css's --sand/--ochre/--moss (converted to
// HSL here since canvas fillStyle needs a literal string, not a CSS var) —
// SAND is deliberately a muted neutral rather than a pale version of MOSS,
// so "untouched" and "mastered" stay visually distinct at a glance instead
// of both reading as "green, just different shades."
const SAND_HSL = { h: 90, s: 15, l: 62 };
const OCHRE_HSL = { h: 33, s: 65, l: 50 };
const MOSS_HSL = { h: 129, s: 42, l: 38 };

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

  drawIslandGlow(island, radius * 2.2);

  ctx.beginPath();
  ctx.fillStyle = `hsl(${h}, ${s}%, ${l}%)`;
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fill();

  // A thin dark outline so the island reads as a distinct object against
  // the ambient territory glow behind it, rather than blending into it —
  // low-mastery islands especially (pale sand color) had very little
  // contrast against the glow otherwise.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.stroke();

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
    ctx.fillStyle = MAP_INK;
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
  // Must match whichever radius drawTerritory() actually drew this frame —
  // otherwise, at low zoom, the visible (fixed-size) simplified dot and
  // its (previously zoom-shrunk) tap target drift apart, and tapping
  // squarely on a clearly visible dot can miss.
  const radius = camera.zoom >= LOD_ISLAND_DETAIL_THRESHOLD
    ? ISLAND_RADIUS_BASE * camera.zoom
    : LOD_SIMPLE_DOT_RADIUS;
  for (const territory of worldTerritories) {
    for (const island of territory.islands) {
      const screen = worldToScreen(island.pos.x, island.pos.y);
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
