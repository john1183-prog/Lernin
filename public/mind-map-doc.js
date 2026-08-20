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
*/

import { getDocument, getMindMapForDocument, getApiConfig } from './db.js';
import { generateMindMap } from './mind-map-doc-api.js';
import { renderMindMapManualImport } from './mind-map-doc-manual-import.js';

const DEPTH_COLORS = ['#e8a33d', '#4a90d9', '#7fbf7f', '#c77fbf'];

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

let container = null, canvasEl = null, ctx = null;
let nodes = [], nodeById = new Map();
let camera = { x: 0, y: 0, zoom: 1 };
let targetCamera = { x: 0, y: 0, zoom: 1 };
let rafId = null, idleTimeoutId = null;
let dpr = 1;
let hoveredNode = null;
let pointerDownNode = null;
let isPanning = false;
let lastPointer = null;
let dragMoved = 0;
const DRAG_THRESHOLD = 4;
let detailPanelEl = null;

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
  const spanX = Math.max(200, maxX - minX + 160);
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

function openNodeDetail(node) {
  detailPanelEl?.remove();
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute; left:12px; right:12px; bottom:12px; background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-lg); max-height:40%; overflow-y:auto;';
  p.innerHTML = `
    <div style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:6px;">${escapeHtmlLocal(node.title)}</div>
    ${node.detail ? `<div style="font-size:13px; color:var(--ink-secondary); line-height:1.5;">${escapeHtmlLocal(node.detail)}</div>` : ''}
  `;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '\u2715';
  closeBtn.style.cssText = 'position:absolute; top:8px; right:10px; border:none; background:none; color:var(--ink-muted); font-size:14px; cursor:pointer;';
  closeBtn.addEventListener('click', () => p.remove());
  p.appendChild(closeBtn);
  canvasEl.parentElement.appendChild(p);
  detailPanelEl = p;
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
    ctx.fillStyle = DEPTH_COLORS[(n.depth - 1) % DEPTH_COLORS.length];
    ctx.fill();
    ctx.lineWidth = isHi ? 3 : 2;
    ctx.strokeStyle = nodeBorder;
    ctx.stroke();

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

function destroy() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (idleTimeoutId) clearTimeout(idleTimeoutId);
  idleTimeoutId = null;
  window.removeEventListener('resize', resizeCanvas);
  detailPanelEl?.remove();
  detailPanelEl = null;
  nodes = []; nodeById = new Map();
  container = null; canvasEl = null; ctx = null;
  hoveredNode = null; pointerDownNode = null;
  lastPointer = null; isPanning = false;
}

function setupCanvasView(bodyEl) {
  bodyEl.innerHTML = ''; // every call site hands this a container that still
  // has its previous state (a loading message, the manual-import form,
  // etc.) — this function fully takes over the element, so it's
  // responsible for clearing it, not each caller individually
  canvasEl = document.createElement('canvas');
  canvasEl.style.cssText = 'display:block; width:100%; height:100%; touch-action:none;';
  bodyEl.appendChild(canvasEl);
  ctx = canvasEl.getContext('2d');

  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointercancel', onPointerUp);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
}

function loadResolvedMap(resolved) {
  nodes = resolved.nodes;
  nodeById = new Map(nodes.map(n => [n.id, n]));
  fitCameraToContent();
  scheduleFrame(0);
}

export async function renderDocumentMindMap(rootEl, documentId, opts = {}) {
  container = rootEl;
  const onExitCb = opts.onExit || null;
  container.innerHTML = '';
  container.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative; width:100%; height:100%; display:flex; flex-direction:column;';
  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="dmmBack" aria-label="Back">←</button>
    <div class="app-header-title">Mind Map</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#dmmBack').addEventListener('click', () => {
    if (onExitCb) onExitCb(); else history.back();
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

  if (existing && existing.mindMap) {
    setupCanvasView(body);
    if (existing.source === 'summary-fallback') {
      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute; top:8px; left:50%; transform:translateX(-50%); background:var(--surface); color:var(--ink-muted); font-size:11px; padding:4px 10px; border-radius:999px; box-shadow:var(--shadow-sm);';
      badge.textContent = 'Generated from summary \u00b7 lower detail than a fresh upload';
      body.appendChild(badge);
    }
    loadResolvedMap(existing.mindMap);
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
    setupCanvasView(body);
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute; top:8px; left:50%; transform:translateX(-50%); background:var(--surface); color:var(--ink-muted); font-size:11px; padding:4px 10px; border-radius:999px; box-shadow:var(--shadow-sm);';
    badge.textContent = 'Generated from summary \u00b7 lower detail than a fresh upload';
    body.appendChild(badge);
    loadResolvedMap(result.mindMap);
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
        if (res.mindMap) {
          setupCanvasView(body);
          loadResolvedMap(res.mindMap);
        }
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
