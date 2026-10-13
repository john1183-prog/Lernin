/* Lernin — Document Mind Map (Mind Map v2)
   Per-document, static-but-interactive topic tree generated from the
   document's own actual structure -- not derived from flashcards. Layout
   is computed entirely server-side by mind_map_engine.py's deterministic
   radial-tree algorithm (see that file), so there's no physics loop here
   at all, unlike mind-map.js's card graph. Interaction is deliberately
   still pan/zoom/tap-for-detail, reusing that file's camera math and feel
   so this doesn't read as a different app bolted on -- just no node
   dragging, since positions are structural/deterministic, not something
   a person would want to rearrange with nothing to persist it against.

   States this view walks through, in order:
     loading -> (no map yet: generate CTA) -> generating -> rendered
                                             -> retryable error -> (retry)
                                             -> hard error -> manual import

   "Rendered" has two faces of the same map: the canvas (pan / zoom / tap) and an outline list. A
   map of more than about a dozen nodes cannot show its labels on a phone without zooming in, so
   there it opens as the list and one header button swaps to the canvas (and back). Which face opens
   first is decided by mind-map-outline.js; on every screen size the button is there.
*/

import { getDocument, getMindMapForDocument, getApiConfig } from './db.js';
import { generateMindMap } from './mind-map-doc-api.js';
import { renderMindMapManualImport } from './mind-map-doc-manual-import.js';
import { MOTION_PREFILL_KEY } from './motion-studio.js';
import { depthColor, shouldStartAsOutline, buildOutlineTree } from './mind-map-outline.js';

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

let container = null, canvasEl = null, ctx = null;
let currentDeckId = null;
let nodes = [], nodeById = new Map();
let camera = { x: 0, y: 0, zoom: 1 };
let targetCamera = { x: 0, y: 0, zoom: 1 };
let rafId = null, idleTimeoutId = null;
let dpr = 1;
let hoveredNode = null;
let pointerDownNode = null;
let selectedNode = null; // the node whose detail panel is open: drawn with a ring so you can see which one it is
let isPanning = false;
let lastPointer = null;
let dragMoved = 0;
const DRAG_THRESHOLD = 4;
let detailPanelEl = null;

// The two faces of the map. `bodyEl` is the element both are drawn into; `currentView` is null until a
// map is on screen ('map' | 'outline'); `viewToggleBtn` is the header button that swaps them.
let bodyEl = null;
let currentView = null;
let viewToggleBtn = null;
let fallbackBadgeOn = false;
let cameraFitted = false;

function scheduleFrame(delayMs) {
  if (delayMs === 0) {
    if (idleTimeoutId !== null) { clearTimeout(idleTimeoutId); idleTimeoutId = null; }
    if (rafId === null) rafId = requestAnimationFrame(renderLoop);
    return;
  }
  if (rafId !== null || idleTimeoutId !== null) return;
  idleTimeoutId = setTimeout(() => { idleTimeoutId = null; rafId = requestAnimationFrame(renderLoop); }, delayMs);
}

function fitCameraToContent() {
  if (nodes.length === 0) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const spanX = Math.max(200, maxX - minX + 340);   // labels hang ~110px outside the outer nodes
  const spanY = Math.max(200, maxY - minY + 160);
  const rect = canvasEl.getBoundingClientRect();
  const zoom = rect.width && rect.height ? Math.min(rect.width / spanX, rect.height / spanY, 1.4) : 1;
  targetCamera = { x: cx, y: cy, zoom: Math.max(0.15, zoom) };
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
function nodeRadius(n) {
  return 24 - n.depth * 3.5; // shallower nodes read as more central/important
}
function hitTestNode(sx, sy) {
  const w = screenToWorld(sx, sy);
  for (const n of nodes) {
    const r = nodeRadius(n);
    const dx = w.x - n.x, dy = w.y - n.y;
    if (dx * dx + dy * dy < r * r * 1.8) return n;
  }
  return null;
}

function onPointerDown(e) {
  canvasEl.setPointerCapture(e.pointerId);
  const rect = canvasEl.getBoundingClientRect();
  const hit = hitTestNode(e.clientX - rect.left, e.clientY - rect.top);
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
  if (isPanning) {
    targetCamera.x -= dx / camera.zoom;
    targetCamera.y -= dy / camera.zoom;
    camera.x = targetCamera.x; camera.y = targetCamera.y;
  }
  lastPointer = { x: e.clientX, y: e.clientY };
  scheduleFrame(0);
}

function onPointerUp() {
  const wasTap = dragMoved <= DRAG_THRESHOLD;
  if (wasTap && pointerDownNode) openNodeDetail(pointerDownNode);
  pointerDownNode = null;
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

/** Hand a topic to Motion Studio (used by the canvas detail panel and by the outline rows). */
function explainWithMotion(node) {
  // Same one-shot handoff pattern motion-studio.js expects — see its
  // own MOTION_PREFILL_KEY comment. Not importing navigate() from
  // app.js here to avoid a circular import (app.js already imports
  // this module); setting the hash directly is exactly what
  // navigate() does anyway.
  sessionStorage.setItem(MOTION_PREFILL_KEY, node.title);
  window.location.hash = `/motion/${currentDeckId}`;
}

function openNodeDetail(node) {
  detailPanelEl?.remove();
  selectedNode = node;
  scheduleFrame(0);
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute; left:12px; right:12px; bottom:12px; background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-lg); max-height:40%; overflow-y:auto;';
  p.innerHTML = `
    <div style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:6px; padding-right:32px;">${escapeHtmlLocal(node.title)}</div>
    ${node.detail ? `<div style="font-size:13px; color:var(--ink-secondary); line-height:1.5; margin-bottom:10px;">${escapeHtmlLocal(node.detail)}</div>` : ''}
    ${currentDeckId ? `<button class="btn-secondary" id="dmmExplainBtn" style="font-size:13px; min-height:44px;">🎬 Explain with motion</button>` : ''}
  `;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  // 44 x 44 hit area around the same small glyph (it used to be just the glyph, ~14 px).
  closeBtn.style.cssText = 'position:absolute; top:0; right:0; width:44px; height:44px; padding:0; border:none; background:none; color:var(--ink-secondary); font-size:14px; cursor:pointer;';
  closeBtn.addEventListener('click', () => {
    p.remove();
    if (detailPanelEl === p) { detailPanelEl = null; selectedNode = null; scheduleFrame(0); }
  });
  p.appendChild(closeBtn);
  canvasEl.parentElement.appendChild(p);
  detailPanelEl = p;

  const explainBtn = p.querySelector('#dmmExplainBtn');
  if (explainBtn) explainBtn.addEventListener('click', () => explainWithMotion(node));
}

function renderLoop() {
  rafId = null;
  camera.x += (targetCamera.x - camera.x) * 0.18;
  camera.y += (targetCamera.y - camera.y) * 0.18;
  camera.zoom += (targetCamera.zoom - camera.zoom) * 0.18;

  if (!ctx || !canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const edgeColor = isDark ? 'rgba(160,176,162,0.3)' : 'rgba(90,107,92,0.35)';
  const nodeText = isDark ? '#EDEFF1' : '#1A1F1B';
  const nodeBorder = isDark ? '#223024' : '#FFFFFF';
  const ringColor = isDark ? '#66BB6A' : '#2E7D32'; // the app's --accent

  for (const n of nodes) {
    if (!n.parentId) continue;
    const p = nodeById.get(n.parentId);
    if (!p) continue;
    const s = worldToScreen(p.x, p.y);
    const t = worldToScreen(n.x, n.y);
    if (Math.max(s.x, t.x) < -50 || Math.min(s.x, t.x) > rect.width + 50) continue;
    if (Math.max(s.y, t.y) < -50 || Math.min(s.y, t.y) > rect.height + 50) continue;
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
  }

  for (const n of nodes) {
    const s = worldToScreen(n.x, n.y);
    const r = nodeRadius(n) * camera.zoom;
    if (s.x < -r - 60 || s.x > rect.width + r + 60 || s.y < -r - 60 || s.y > rect.height + r + 60) continue;
    const isHi = n === hoveredNode;

    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = depthColor(n.depth);
    ctx.fill();
    ctx.lineWidth = isHi ? 3 : 2;
    ctx.strokeStyle = nodeBorder;
    ctx.stroke();

    if (n === selectedNode) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ringColor;
      ctx.stroke();
    }

    if (camera.zoom > 0.35) {
      ctx.fillStyle = nodeText;
      ctx.font = `${n.depth === 1 ? '600 13px' : '11px'} system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxLen = n.depth === 1 ? 22 : 16;
      const label = n.title.length > maxLen ? n.title.slice(0, maxLen - 1) + '\u2026' : n.title;
      ctx.fillText(label, s.x, s.y + r + 12);
    }
  }

  const isActive = isPanning || lastPointer !== null ||
    Math.abs(targetCamera.x - camera.x) > 0.4 || Math.abs(targetCamera.y - camera.y) > 0.4 || Math.abs(targetCamera.zoom - camera.zoom) > 0.0015;
  scheduleFrame(isActive ? 0 : 250);
}

/** Everything the canvas face owns: the frame loop, the listeners and the detail panel. Safe to call twice. */
function stopCanvas() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (idleTimeoutId) clearTimeout(idleTimeoutId);
  idleTimeoutId = null;
  window.removeEventListener('resize', resizeCanvas);
  detailPanelEl?.remove();
  detailPanelEl = null;
  canvasEl = null; ctx = null;
  hoveredNode = null; pointerDownNode = null; selectedNode = null;
  lastPointer = null; isPanning = false; dragMoved = 0;
}

function destroy() {
  stopCanvas();
  nodes = []; nodeById = new Map();
  container = null; bodyEl = null; viewToggleBtn = null;
  currentView = null;
  fallbackBadgeOn = false;
  cameraFitted = false;
  currentDeckId = null;
}

function setupCanvasView(target) {
  target.innerHTML = ''; // every call site hands this a container that still
  // has its previous state (a loading message, the manual-import form,
  // etc.) — this function fully takes over the element, so it's
  // responsible for clearing it, not each caller individually
  canvasEl = document.createElement('canvas');
  canvasEl.style.cssText = 'display:block; width:100%; height:100%; touch-action:none;';
  target.appendChild(canvasEl);
  ctx = canvasEl.getContext('2d');

  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
}

// ---------------------------------------------------------------------------
// One map, two faces: the canvas and the outline list
// ---------------------------------------------------------------------------

// Header-button icons (programmatic SVG, no assets). Each one pictures the face you would switch TO.
const LIST_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>';
const MAP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10.84 7.32L6.66 15.68M13.16 7.32L17.34 15.68"/><circle cx="12" cy="5" r="2.6"/><circle cx="5.5" cy="18" r="2.6"/><circle cx="18.5" cy="18" r="2.6"/></svg>';

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

function makeFallbackBadge(inline) {
  const badge = document.createElement('div');
  badge.className = inline ? 'dmm-badge dmm-badge--inline' : 'dmm-badge';
  badge.textContent = 'Generated from summary · lower detail than a fresh upload';
  return badge;
}

/** The header button: hidden until a map is on screen, then names the face it will switch to. */
function updateViewToggle() {
  const btn = viewToggleBtn;
  if (!btn) return;
  if (!currentView) {
    btn.disabled = true;
    btn.innerHTML = '';
    btn.removeAttribute('aria-label');
    btn.removeAttribute('title');
    return;
  }
  const toList = currentView === 'map';
  btn.disabled = false;
  const label = toList ? 'Show as a list' : 'Show as a map';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = (toList ? LIST_ICON : MAP_ICON) + '<span>' + (toList ? 'List' : 'Map') + '</span>';
}

/**
 * Put a finished map on screen. A big map on a small screen opens as the outline list (see
 * mind-map-outline.js for the rule); everything else opens as the canvas.
 */
function presentMap(body, resolved, { fallbackBadge = false } = {}) {
  // Generating and importing are async: if the person has already left this screen (destroy() has run
  // and body is detached), drawing now would start a frame loop and a resize listener that nothing
  // would ever stop.
  if (!body.isConnected) return;
  bodyEl = body;
  nodes = resolved.nodes;
  nodeById = new Map(nodes.map(n => [n.id, n]));
  fallbackBadgeOn = fallbackBadge;
  cameraFitted = false;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (shouldStartAsOutline(nodes.length, viewport)) showOutlineView(); else showMapView();
}

function showMapView() {
  if (!bodyEl) return;
  stopCanvas();
  currentView = 'map';
  setupCanvasView(bodyEl); // clears bodyEl, builds the canvas, wires pan / zoom / tap
  canvasEl.setAttribute('role', 'img');
  canvasEl.setAttribute('aria-label', 'Mind map drawing. The List button in the header shows the same map as a text outline.');
  if (fallbackBadgeOn) bodyEl.appendChild(makeFallbackBadge(false));
  // Fit once, on the first time the canvas is shown; later switches keep wherever the person had panned to.
  if (!cameraFitted) { fitCameraToContent(); cameraFitted = true; }
  scheduleFrame(0);
  updateViewToggle();
}

function showOutlineView() {
  if (!bodyEl) return;
  stopCanvas();
  currentView = 'outline';
  bodyEl.innerHTML = '';
  bodyEl.appendChild(buildOutlineView());
  updateViewToggle();
}

/** The outline: every node once, nested the way the map branches, each row opening to its detail. */
function buildOutlineView() {
  const scroller = document.createElement('div');
  scroller.className = 'dmm-outline';
  if (fallbackBadgeOn) scroller.appendChild(makeFallbackBadge(true));

  const count = document.createElement('p');
  count.className = 'dmm-outline-count';
  count.textContent = `${nodes.length} topic${nodes.length === 1 ? '' : 's'} · tap one for its detail`;
  scroller.appendChild(count);

  const list = document.createElement('ul');
  list.className = 'dmm-outline-list';
  renderOutlineLevel(list, buildOutlineTree(nodes), { n: 0 });
  scroller.appendChild(list);
  return scroller;
}

function renderOutlineLevel(listEl, entries, counter) {
  for (const { node, children } of entries) {
    const idx = counter.n++;
    const item = document.createElement('li');
    item.className = 'dmm-outline-item';

    const detailId = `dmm-outline-detail-${idx}`;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = node.depth === 1 ? 'dmm-outline-row dmm-outline-row--root' : 'dmm-outline-row';
    row.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-controls', detailId);

    const dot = document.createElement('span');
    dot.className = 'dmm-outline-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.background = depthColor(node.depth);

    const title = document.createElement('span');
    title.className = 'dmm-outline-title';
    title.textContent = node.title;

    const chev = document.createElement('span');
    chev.className = 'dmm-outline-chev';
    chev.setAttribute('aria-hidden', 'true');

    row.append(dot, title, chev);

    const detail = document.createElement('div');
    detail.className = 'dmm-outline-detail';
    detail.id = detailId;
    detail.hidden = true;
    if (node.detail) {
      const text = document.createElement('p');
      text.className = 'dmm-outline-detail-text';
      text.textContent = node.detail;
      detail.appendChild(text);
    }
    const actions = document.createElement('div');
    actions.className = 'dmm-outline-actions';
    const showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.className = 'btn-secondary dmm-outline-action';
    showBtn.textContent = 'Show on map';
    showBtn.addEventListener('click', () => focusOnNode(node));
    actions.appendChild(showBtn);
    if (currentDeckId) {
      const motionBtn = document.createElement('button');
      motionBtn.type = 'button';
      motionBtn.className = 'btn-secondary dmm-outline-action';
      motionBtn.textContent = '🎬 Explain with motion';
      motionBtn.addEventListener('click', () => explainWithMotion(node));
      actions.appendChild(motionBtn);
    }
    detail.appendChild(actions);

    row.addEventListener('click', () => {
      const open = row.getAttribute('aria-expanded') !== 'true';
      row.setAttribute('aria-expanded', String(open));
      detail.hidden = !open;
    });

    item.append(row, detail);
    if (children.length) {
      const sub = document.createElement('ul');
      sub.className = 'dmm-outline-list';
      renderOutlineLevel(sub, children, counter);
      item.appendChild(sub);
    }
    listEl.appendChild(item);
  }
}

/** "Show on map": switch to the canvas, glide to this node and open its detail panel. */
function focusOnNode(node) {
  showMapView();
  const rect = canvasEl.getBoundingClientRect();
  const zoom = Math.max(camera.zoom, 0.9); // labels draw above 0.35; this is comfortably readable
  // Sit the node in the upper part of the view so the detail panel (bottom 40%) never covers it or its label.
  targetCamera = { x: node.x, y: node.y + (rect.height * 0.14) / zoom, zoom };
  if (reducedMotion()) camera = { ...targetCamera };
  openNodeDetail(node);
  scheduleFrame(0);
}

export async function renderDocumentMindMap(rootEl, documentId, opts = {}) {
  container = rootEl;
  const onExitCb = opts.onExit || null;
  container.innerHTML = '';
  container.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative; width:100%; height:100vh; height:100dvh; display:flex; flex-direction:column;';
  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="dmmBack" aria-label="Back">←</button>
    <div class="app-header-title">Mind Map</div>
    <button type="button" class="dmm-view-toggle" id="dmmViewToggle" disabled></button>
  `;
  wrap.appendChild(header);
  header.querySelector('#dmmBack').addEventListener('click', () => {
    if (onExitCb) onExitCb(); else history.back();
  });
  viewToggleBtn = header.querySelector('#dmmViewToggle');
  viewToggleBtn.addEventListener('click', () => {
    if (currentView === 'map') showOutlineView();
    else if (currentView === 'outline') {
      cameraFitted = false; // the Map button shows the whole map; "Show on map" is the way to a single topic
      showMapView();
    }
  });

  const body = document.createElement('div');
  body.style.cssText = 'flex:1; position:relative; overflow:hidden; background:var(--bg);';
  wrap.appendChild(body);
  container.appendChild(wrap);

  let doc, existing;
  try {
    [doc, existing] = await Promise.all([getDocument(documentId), getMindMapForDocument(documentId)]);
  } catch (err) {
    body.innerHTML = '<p style="padding:var(--space-lg); color:var(--ink-muted); text-align:center;">Failed to load this document.</p>';
    return destroy;
  }
  if (!doc) {
    body.innerHTML = '<p style="padding:var(--space-lg); color:var(--ink-muted); text-align:center;">Document not found.</p>';
    return destroy;
  }
  header.querySelector('.app-header-title').textContent = `Mind Map \u00b7 ${doc.filename}`;
  currentDeckId = doc.deckId || null;

  if (existing && existing.mindMap) {
    presentMap(body, existing.mindMap, { fallbackBadge: existing.source === 'summary-fallback' });
    return destroy;
  }

  renderGenerateCTA(body, doc, documentId);
  return destroy;
}

function renderGenerateCTA(body, doc, documentId) {
  body.innerHTML = '';
  const cta = document.createElement('div');
  cta.style.cssText = 'height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:var(--space-lg); text-align:center; gap:12px;';

  if (!doc.summary) {
    cta.innerHTML = `
      <div style="font-size:32px;">🧠</div>
      <div style="font-size:14px; color:var(--ink-muted); max-width:280px;">This document has no saved summary to build a mind map from — it was likely imported before summaries were saved for this generation path.</div>
    `;
    body.appendChild(cta);
    return;
  }

  cta.innerHTML = `
    <div style="font-size:32px;">🧠</div>
    <div style="font-size:14px; color:var(--ink); font-weight:600;">No mind map yet</div>
    <div style="font-size:13px; color:var(--ink-muted); max-width:280px;">Generates a topic map from this document's saved summary. A fresh upload gives a more detailed map than regenerating later, since only the summary is kept after import.</div>
    <button class="btn-primary" id="dmmGenerate" style="margin-top:8px;">Generate Mind Map</button>
  `;
  body.appendChild(cta);

  cta.querySelector('#dmmGenerate').addEventListener('click', () => startGeneration(body, doc, documentId, null));
}

async function startGeneration(body, doc, documentId, retryOfError) {
  body.innerHTML = '';
  const loading = document.createElement('div');
  loading.style.cssText = 'height:100%; display:flex; align-items:center; justify-content:center; color:var(--ink-muted); font-size:14px;';
  loading.textContent = retryOfError ? 'Trying again\u2026' : 'Generating\u2026';
  body.appendChild(loading);

  const config = await getApiConfig();
  const hasByok = !!(config && config.apiKey && (config.provider === 'claude' || config.provider === 'gemini'));

  const result = await generateMindMap(doc.summary, documentId, 'summary-fallback', retryOfError);

  if (result.mindMap) {
    presentMap(body, result.mindMap, { fallbackBadge: true });
    return;
  }

  if (result.retryable) {
    renderRetryState(body, doc, documentId, result.error);
    return;
  }

  // Hard failure (no key configured, quota exhausted, auth error, etc.) —
  // if there's no BYOK key at all, manual mode is the honest next step
  // rather than a dead end. If a key IS configured, the failure is
  // something else (bad key, quota, network) — show it plainly with a
  // retry option instead of pushing straight to manual mode, since the
  // key not working isn't fixed by pasting into a different AI by hand.
  if (!hasByok) {
    renderMindMapManualImport(
      body,
      doc.summary,
      documentId,
      'summary-fallback',
      doc.filename,
      (res) => {
        if (res.mindMap) presentMap(body, res.mindMap);
      },
      () => renderGenerateCTA(body, doc, documentId)
    );
    return;
  }

  renderHardError(body, doc, documentId, result.error);
}

function renderRetryState(body, doc, documentId, error) {
  body.innerHTML = '';
  const el = document.createElement('div');
  el.style.cssText = 'height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:var(--space-lg); text-align:center; gap:12px;';
  el.innerHTML = `
    <div style="font-size:32px;">\u26a0\ufe0f</div>
    <div style="font-size:13px; color:var(--ink-muted); max-width:280px;">${escapeHtmlLocal(error)}</div>
    <button class="btn-primary" id="dmmRetry">Try again</button>
  `;
  body.appendChild(el);
  el.querySelector('#dmmRetry').addEventListener('click', () => startGeneration(body, doc, documentId, error));
}

function renderHardError(body, doc, documentId, error) {
  body.innerHTML = '';
  const el = document.createElement('div');
  el.style.cssText = 'height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:var(--space-lg); text-align:center; gap:12px;';
  el.innerHTML = `
    <div style="font-size:32px;">\u26a0\ufe0f</div>
    <div style="font-size:13px; color:var(--ink-muted); max-width:280px;">${escapeHtmlLocal(error)}</div>
    <button class="btn-secondary" id="dmmBackToCta">Back</button>
  `;
  body.appendChild(el);
  el.querySelector('#dmmBackToCta').addEventListener('click', () => renderGenerateCTA(body, doc, documentId));
}
