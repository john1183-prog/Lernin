/* Lernin — Mind Map
   Per-deck force-directed graph of cards and their relationships.

   Revived from an earlier standalone view. It existed once, got folded
   into the territory map's L2 during a later rewrite (which replaced
   its physics-based layout with a plain index-ordered spiral — cards
   place in insertion order, not by how they relate), then the original
   file was reduced to a deprecated stub. Brought back here as its own
   focused view rather than re-merged into the map, since a force-
   directed "shape of this course" layout is a genuinely different job
   than the territory map's landmark/path/exploration tooling — this
   view has none of that, just cards and how they connect.

   Deliberately does NOT use conceptLayouts (the store the territory
   map's L2 already uses for card positions) — reusing it would mean
   dragging a node here also relocates that card on the territory map,
   and the two views would fight over the same position every time
   either one opens. Instead: a fresh force-directed layout runs every
   time this view opens, so it always reflects the current true
   relationship structure. Dragging during a session is visual-only,
   nothing is persisted.
*/

import { getCardsByDeck, getRelationshipsFrom, getDeck } from './db.js';

const SAND_HSL = { h: 38, s: 28, l: 78 };
const OCHRE_HSL = { h: 32, s: 55, l: 55 };
const MOSS_HSL = { h: 110, s: 32, l: 38 };

function lerpHsl(a, b, t) {
  return { h: a.h + (b.h - a.h) * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
}

function masteryColor(mastery) {
  const c = mastery < 0.5
    ? lerpHsl(SAND_HSL, OCHRE_HSL, mastery / 0.5)
    : lerpHsl(OCHRE_HSL, MOSS_HSL, (mastery - 0.5) / 0.5);
  return `hsl(${Math.round(c.h)}, ${Math.round(c.s)}%, ${Math.round(c.l)}%)`;
}

/**
 * Classic force-directed layout: pairwise repulsion, spring attraction
 * along edges, mild center gravity, damped. Run as a one-shot solve
 * before the first render, not a continuous per-frame simulation —
 * sensible at flashcard-deck scale (tens of nodes, not thousands) and
 * means the view is stable and readable immediately, not visibly
 * jittering into place.
 *
 * Parameters were re-tuned, not just ported as-is. The original
 * concept-graph.js's values (repulsion 800, springLength 140) were
 * verified — via a standalone test harness, not assumed — to actually
 * produce the OPPOSITE of the intended effect on a realistic sparse
 * graph (a few small connected clusters plus isolated cards, typical
 * of a real deck): connected pairs ended up ~35% farther apart than
 * unconnected ones, because 140 was longer than the graph's natural
 * repulsion+gravity equilibrium spacing, so springs were pulling
 * connected nodes apart rather than together. springLength=95 (short
 * enough to pull connected pairs in below that equilibrium, long
 * enough to leave a comfortable gap between two max-radius nodes at
 * rest) reliably clusters connected pairs closer across repeated
 * random-seed trials on both small and 25-node test graphs.
 */
function runForceLayout(nodes, edges) {
  const repulsion = 800;
  const springLength = 95;
  const springK = 0.06;
  const centerGravity = 0.015;
  const damping = 0.9;
  const iterations = 200;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    for (const e of edges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - springLength) * springK;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      e.source.vx += fx; e.source.vy += fy;
      e.target.vx -= fx; e.target.vy -= fy;
    }
    for (const n of nodes) {
      n.vx -= n.x * centerGravity;
      n.vy -= n.y * centerGravity;
    }
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      n.vx *= damping; n.vy *= damping;
    }
  }
}

let container = null, canvasEl = null, ctx = null;
let nodes = [], edges = [];
let camera = { x: 0, y: 0, zoom: 1 };
let targetCamera = { x: 0, y: 0, zoom: 1 };
let rafId = null, idleTimeoutId = null;
let dpr = 1;
let hoveredNode = null, draggedNode = null;
let pointerDownNode = null;
let isPanning = false;
let lastPointer = null;
let dragMoved = 0;
let onExitCb = null;
const DRAG_THRESHOLD = 4;

function scheduleFrame(delayMs) {
  if (delayMs === 0) {
    if (idleTimeoutId !== null) { clearTimeout(idleTimeoutId); idleTimeoutId = null; }
    if (rafId === null) rafId = requestAnimationFrame(renderLoop);
    return;
  }
  if (rafId !== null || idleTimeoutId !== null) return;
  idleTimeoutId = setTimeout(() => { idleTimeoutId = null; rafId = requestAnimationFrame(renderLoop); }, delayMs);
}

export async function renderMindMap(rootEl, deckId, opts = {}) {
  container = rootEl;
  onExitCb = opts.onExit || null;
  container.innerHTML = '';
  container.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative; width:100%; height:100%; display:flex; flex-direction:column;';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="mmBack" aria-label="Back">←</button>
    <div class="app-header-title">Mind Map</div>
    <button class="icon-btn" id="mmReset" aria-label="Reset layout" title="Reset layout">↺</button>
  `;
  wrap.appendChild(header);

  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'flex:1; position:relative; overflow:hidden; background:var(--bg);';
  canvasEl = document.createElement('canvas');
  canvasEl.style.cssText = 'display:block; width:100%; height:100%; touch-action:none;';
  canvasWrap.appendChild(canvasEl);
  wrap.appendChild(canvasWrap);

  container.appendChild(wrap);
  ctx = canvasEl.getContext('2d');

  header.querySelector('#mmBack').addEventListener('click', () => {
    if (onExitCb) onExitCb(); else history.back();
  });
  header.querySelector('#mmReset').addEventListener('click', () => {
    buildLayout();
    fitCameraToContent();
    scheduleFrame(0);
  });

  let cards, deck;
  try {
    [cards, deck] = await Promise.all([getCardsByDeck(deckId), getDeck(deckId)]);
  } catch (err) {
    canvasWrap.innerHTML = '<p style="padding:var(--space-lg); color:var(--ink-muted); text-align:center;">Failed to load this deck\u2019s cards.</p>';
    return destroy;
  }
  cards = cards.filter(c => !c.suspended);

  if (deck) header.querySelector('.app-header-title').textContent = `Mind Map \u00b7 ${deck.title}`;

  if (cards.length === 0) {
    canvasWrap.innerHTML = '<p style="padding:var(--space-lg); color:var(--ink-muted); text-align:center;">No cards in this deck yet.</p>';
    return destroy;
  }

  // Build nodes, then edges (within this deck only — cross-deck
  // relationships already render as lines between islands on the
  // territory map's L1, a different, appropriately zoomed-out view).
  const cardIdSet = new Set(cards.map(c => c.id));
  nodes = cards.map(c => {
    const mastery = Math.min(1, (c.stability || 0) / 30);
    return {
      id: c.id, card: c, mastery,
      x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400,
      vx: 0, vy: 0,
      radius: 22 + mastery * 18
    };
  });
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const rawEdges = [];
  for (const card of cards) {
    let rels;
    try { rels = await getRelationshipsFrom(card.id); } catch (err) { rels = []; }
    for (const r of rels) {
      if (r.targetMissing || !cardIdSet.has(r.cardId)) continue;
      rawEdges.push({ source: card.id, target: r.cardId, type: r.type });
    }
  }
  edges = rawEdges
    .map(r => ({ source: nodeMap.get(r.source), target: nodeMap.get(r.target), type: r.type }))
    .filter(e => e.source && e.target);

  buildLayout();
  fitCameraToContent();

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });

  scheduleFrame(0);
  return destroy;
}

function buildLayout() {
  for (const n of nodes) {
    n.x = (Math.random() - 0.5) * 400;
    n.y = (Math.random() - 0.5) * 400;
    n.vx = 0; n.vy = 0;
  }
  runForceLayout(nodes, edges);
}

function fitCameraToContent() {
  if (nodes.length === 0) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const spanX = Math.max(200, maxX - minX + 160);
  const spanY = Math.max(200, maxY - minY + 160);
  const rect = canvasEl.getBoundingClientRect();
  const zoom = rect.width && rect.height ? Math.min(rect.width / spanX, rect.height / spanY, 1.4) : 1;
  targetCamera = { x: cx, y: cy, zoom: Math.max(0.2, zoom) };
  camera = { ...targetCamera };
}

function resizeCanvas() {
  if (!canvasEl || !canvasEl.parentElement) return;
  const rect = canvasEl.parentElement.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasEl.width = Math.max(1, Math.floor(rect.width * dpr));
  canvasEl.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleFrame(0);
}

function worldToScreen(wx, wy) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: (wx - camera.x) * camera.zoom + rect.width / 2, y: (wy - camera.y) * camera.zoom + rect.height / 2 };
}
function screenToWorld(sx, sy) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: (sx - rect.width / 2) / camera.zoom + camera.x, y: (sy - rect.height / 2) / camera.zoom + camera.y };
}
function hitTestNode(sx, sy) {
  const w = screenToWorld(sx, sy);
  for (const n of nodes) {
    const dx = w.x - n.x, dy = w.y - n.y;
    if (dx * dx + dy * dy < n.radius * n.radius * 1.5) return n;
  }
  return null;
}

function onPointerDown(e) {
  canvasEl.setPointerCapture(e.pointerId);
  const rect = canvasEl.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const hit = hitTestNode(sx, sy);
  pointerDownNode = hit;
  isPanning = !hit;
  lastPointer = { x: e.clientX, y: e.clientY };
  dragMoved = 0;
  scheduleFrame(0);
}

function onPointerMove(e) {
  if (!lastPointer) {
    const rect = canvasEl.getBoundingClientRect();
    hoveredNode = hitTestNode(e.clientX - rect.left, e.clientY - rect.top);
    return;
  }
  const dx = e.clientX - lastPointer.x, dy = e.clientY - lastPointer.y;
  dragMoved += Math.abs(dx) + Math.abs(dy);

  if (pointerDownNode && dragMoved > DRAG_THRESHOLD) {
    draggedNode = pointerDownNode;
    isPanning = false;
  }

  if (draggedNode) {
    draggedNode.x += dx / camera.zoom;
    draggedNode.y += dy / camera.zoom;
    draggedNode.vx = 0; draggedNode.vy = 0;
  } else if (isPanning) {
    targetCamera.x -= dx / camera.zoom;
    targetCamera.y -= dy / camera.zoom;
    camera.x = targetCamera.x; camera.y = targetCamera.y;
  }
  lastPointer = { x: e.clientX, y: e.clientY };
  scheduleFrame(0);
}

function onPointerUp(e) {
  const wasTap = dragMoved <= DRAG_THRESHOLD;
  if (wasTap && pointerDownNode) openNodeDetail(pointerDownNode);
  pointerDownNode = null;
  draggedNode = null;
  isPanning = false;
  lastPointer = null;
  dragMoved = 0;
}

function onWheel(e) {
  e.preventDefault();
  const zoomDelta = -e.deltaY * 0.001;
  const next = Math.max(0.15, Math.min(3, camera.zoom * (1 + zoomDelta)));
  targetCamera.zoom = next; camera.zoom = next;
  scheduleFrame(0);
}

let detailPanelEl = null;
function openNodeDetail(node) {
  detailPanelEl?.remove();
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute; left:12px; right:12px; bottom:12px; background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-lg); max-height:40%; overflow-y:auto;';
  p.innerHTML = `
    <div style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:6px;">${escapeHtmlLocal(node.card.front)}</div>
    <div style="font-size:13px; color:var(--ink-secondary); line-height:1.5;">${escapeHtmlLocal(node.card.back || '')}</div>
  `;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '\u2715';
  closeBtn.style.cssText = 'position:absolute; top:8px; right:10px; border:none; background:none; color:var(--ink-muted); font-size:14px; cursor:pointer;';
  closeBtn.addEventListener('click', () => p.remove());
  p.style.position = 'absolute';
  p.appendChild(closeBtn);
  canvasEl.parentElement.appendChild(p);
  detailPanelEl = p;
}

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function renderLoop() {
  rafId = null;
  camera.x += (targetCamera.x - camera.x) * 0.15;
  camera.y += (targetCamera.y - camera.y) * 0.15;
  camera.zoom += (targetCamera.zoom - camera.zoom) * 0.15;

  if (!ctx || !canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const edgeDepends = isDark ? 'rgba(160,176,162,0.35)' : 'rgba(90,107,92,0.4)';
  const edgeRelated = isDark ? 'rgba(107,123,109,0.22)' : 'rgba(138,154,140,0.28)';
  const nodeText = isDark ? '#EDEFF1' : '#1A1F1B';
  const nodeBorder = isDark ? '#223024' : '#FFFFFF';

  for (const e of edges) {
    const s = worldToScreen(e.source.x, e.source.y);
    const t = worldToScreen(e.target.x, e.target.y);
    if (Math.max(s.x, t.x) < -50 || Math.min(s.x, t.x) > rect.width + 50) continue;
    if (Math.max(s.y, t.y) < -50 || Math.min(s.y, t.y) > rect.height + 50) continue;
    ctx.strokeStyle = e.type === 'dependsOn' ? edgeDepends : edgeRelated;
    ctx.lineWidth = 1.5;
    if (e.type === 'dependsOn') {
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      const ang = Math.atan2(t.y - s.y, t.x - s.x);
      const hs = 7;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x - hs * Math.cos(ang - 0.5), t.y - hs * Math.sin(ang - 0.5));
      ctx.lineTo(t.x - hs * Math.cos(ang + 0.5), t.y - hs * Math.sin(ang + 0.5));
      ctx.closePath();
      ctx.fillStyle = edgeDepends;
      ctx.fill();
    } else {
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  for (const n of nodes) {
    const s = worldToScreen(n.x, n.y);
    const r = n.radius * camera.zoom;
    if (s.x < -r - 40 || s.x > rect.width + r + 40 || s.y < -r - 40 || s.y > rect.height + r + 40) continue;
    const isHi = n === hoveredNode || n === draggedNode;

    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = masteryColor(n.mastery);
    ctx.fill();
    ctx.lineWidth = isHi ? 3 : 2;
    ctx.strokeStyle = nodeBorder;
    ctx.stroke();

    if (camera.zoom > 0.4) {
      ctx.fillStyle = nodeText;
      ctx.font = `${Math.max(9, Math.min(12, r * 0.4))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = n.card.front.length > 18 ? n.card.front.slice(0, 17) + '\u2026' : n.card.front;
      ctx.fillText(label, s.x, s.y, r * 1.8);
    }
  }

  const isActive = draggedNode !== null || isPanning || lastPointer !== null ||
    Math.abs(targetCamera.x - camera.x) > 0.4 || Math.abs(targetCamera.y - camera.y) > 0.4 || Math.abs(targetCamera.zoom - camera.zoom) > 0.0015;
  scheduleFrame(isActive ? 0 : 250);
}

function destroy() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (idleTimeoutId) clearTimeout(idleTimeoutId);
  idleTimeoutId = null;
  window.removeEventListener('resize', resizeCanvas);
  detailPanelEl?.remove();
  detailPanelEl = null;
  nodes = []; edges = [];
  container = null; canvasEl = null; ctx = null;
  hoveredNode = null; draggedNode = null; pointerDownNode = null;
  lastPointer = null; isPanning = false;
}
