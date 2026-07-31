/* Lernin — Concept Graph
   Per-deck force-directed graph of cards and relationships */

import {
  getCardsByDeck, getRelationshipsFrom, getRelationshipsTo,
  saveConceptPosition, getConceptPositionOverrides, getCard
} from './db.js';

const COLORS = {
  nodeBorder: '#FFFFFF',
  nodeText: '#1A1F1B',
  edgeDepends: 'rgba(90,107,92,0.35)',
  edgeRelated: 'rgba(138,154,140,0.25)',
  arrowhead: 'rgba(90,107,92,0.5)'
};

const DARK_COLORS = {
  nodeBorder: '#223024',
  nodeText: '#EDEFF1',
  edgeDepends: 'rgba(160,176,162,0.3)',
  edgeRelated: 'rgba(107,123,109,0.2)',
  arrowhead: 'rgba(160,176,162,0.4)'
};

function getThemeColors() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? DARK_COLORS : COLORS;
}

function islandColor(mastery, hueJitter = 0) {
  const h = 100 + hueJitter;
  let s, l;
  if (mastery < 0.3) { s = 15; l = 82; }
  else if (mastery < 0.7) { s = 55; l = 62; }
  else { s = 65; l = 38; }
  return `hsl(${h + hueJitter}, ${s}%, ${l}%)`;
}

export async function initConceptGraph(container, deckId, callbacks = {}) {
  container.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'concept-graph-header';
  header.innerHTML = `
    <button class="icon-btn" id="cgBack" aria-label="Back">←</button>
    <div class="concept-graph-title">Concept Map</div>
    <button class="icon-btn" id="cgReset" aria-label="Reset layout">↺</button>
  `;
  container.appendChild(header);

  // Canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'concept-graph-canvas';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Data
  const [cards, overrides] = await Promise.all([
    getCardsByDeck(deckId),
    getConceptPositionOverrides()
  ]);

  // Fetch relationships for these cards
  const rels = [];
  for (const card of cards) {
    const from = await getRelationshipsFrom(card.id);
    const to = await getRelationshipsTo(card.id);
    for (const r of from) {
      if (cards.find(c => c.id === r.toCardId)) {
        rels.push({ source: card.id, target: r.toCardId, type: r.type });
      }
    }
  }

  // Build nodes
  const nodes = cards.map(c => {
    const mastery = Math.min(1, (c.stability || 0) / 30);
    const ov = overrides.get(c.id);
    return {
      id: c.id,
      card: c,
      x: ov ? ov.x : (Math.random() - 0.5) * 400,
      y: ov ? ov.y : (Math.random() - 0.5) * 400,
      vx: 0, vy: 0,
      radius: 22 + mastery * 18,
      mastery,
      hueJitter: (c.id.charCodeAt(0) % 16) - 8
    };
  });

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Build edges
  const edges = rels.map(r => ({
    source: nodeMap.get(r.source),
    target: nodeMap.get(r.target),
    type: r.type
  })).filter(e => e.source && e.target);

  // Camera
  let camera = { x: 0, y: 0, zoom: 1 };
  let targetCamera = { x: 0, y: 0, zoom: 1 };

  // Fit to content
  if (nodes.length > 0) {
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    targetCamera.x = cx;
    targetCamera.y = cy;
    camera.x = cx;
    camera.y = cy;
  }

  // Run simulation
  runSimulation(nodes, edges, overrides);

  // Interaction state
  let isDragging = false;
  let isPanning = false;
  let dragNode = null;
  let lastPointer = { x: 0, y: 0 };
  let hoveredNode = null;

  function resize() {
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function worldToScreen(wx, wy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (wx - camera.x) * camera.zoom + rect.width / 2,
      y: (wy - camera.y) * camera.zoom + rect.height / 2
    };
  }

  function screenToWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (sx - rect.width / 2) / camera.zoom + camera.x,
      y: (sy - rect.height / 2) / camera.zoom + camera.y
    };
  }

  function hitTestNode(x, y) {
    const w = screenToWorld(x, y);
    for (const node of nodes) {
      const dx = w.x - node.x;
      const dy = w.y - node.y;
      if (dx * dx + dy * dy < node.radius * node.radius * 1.5) {
        return node;
      }
    }
    return null;
  }

  function drawArrow(ctx, x1, y1, x2, y2, color) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const nx = dx / dist;
    const ny = dy / dist;
    const endX = x2 - nx * 8;
    const endY = y2 - ny * 8;
    const headLen = 6;
    const angle = Math.atan2(dy, dx);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - headLen * Math.cos(angle - 0.5), endY - headLen * Math.sin(angle - 0.5));
    ctx.lineTo(endX - headLen * Math.cos(angle + 0.5), endY - headLen * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function render() {
    // Smooth camera
    camera.x += (targetCamera.x - camera.x) * 0.12;
    camera.y += (targetCamera.y - camera.y) * 0.12;
    camera.zoom += (targetCamera.zoom - camera.zoom) * 0.12;

    const rect = canvas.getBoundingClientRect();
    const colors = getThemeColors();

    ctx.clearRect(0, 0, rect.width, rect.height);

    // Viewport bounds in world space
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(rect.width, rect.height);

    // Draw edges
    for (const edge of edges) {
      const s = worldToScreen(edge.source.x, edge.source.y);
      const t = worldToScreen(edge.target.x, edge.target.y);

      // Cull
      if (Math.max(s.x, t.x) < -50 || Math.min(s.x, t.x) > rect.width + 50) continue;
      if (Math.max(s.y, t.y) < -50 || Math.min(s.y, t.y) > rect.height + 50) continue;

      const color = edge.type === 'dependsOn' ? colors.edgeDepends : colors.edgeRelated;
      if (edge.type === 'dependsOn') {
        drawArrow(ctx, s.x, s.y, t.x, t.y, color);
      } else {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = worldToScreen(node.x, node.y);

      // Cull
      if (pos.x < -60 || pos.x > rect.width + 60 || pos.y < -60 || pos.y > rect.height + 60) continue;

      const r = node.radius * camera.zoom;
      const isHovered = hoveredNode === node;

      // Glow
      if (isHovered) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(46,125,50,0.15)';
        ctx.fill();
      }

      // Node body
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = islandColor(node.mastery, node.hueJitter);
      ctx.fill();

      // Border
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = colors.nodeBorder;
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.stroke();

      // Label
      if (camera.zoom > 0.5) {
        const label = (node.card.front || '').slice(0, 20);
        ctx.fillStyle = colors.nodeText;
        ctx.font = `${isHovered ? '600' : '500'} ${Math.max(10, 12 * camera.zoom)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.fillText(label, pos.x, pos.y + r + 14 * camera.zoom);
      }
    }

    requestAnimationFrame(render);
  }

  // Input handlers
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const node = hitTestNode(e.clientX, e.clientY);
    if (node) {
      isDragging = true;
      dragNode = node;
      canvas.setPointerCapture(e.pointerId);
    } else {
      isPanning = true;
      lastPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const node = hitTestNode(e.clientX, e.clientY);
    hoveredNode = node;
    canvas.style.cursor = node ? 'pointer' : 'grab';

    if (isDragging && dragNode) {
      const w = screenToWorld(e.clientX, e.clientY);
      dragNode.x = w.x;
      dragNode.y = w.y;
    } else if (isPanning) {
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      targetCamera.x -= dx / camera.zoom;
      targetCamera.y -= dy / camera.zoom;
      lastPointer = { x: e.clientX, y: e.clientY };
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (isDragging && dragNode) {
      saveConceptPosition(dragNode.id, dragNode.x, dragNode.y);
    }
    isDragging = false;
    dragNode = null;
    isPanning = false;
    canvas.releasePointerCapture(e.pointerId);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomSpeed = 0.001;
    const newZoom = Math.max(0.2, Math.min(3, targetCamera.zoom - e.deltaY * zoomSpeed));
    targetCamera.zoom = newZoom;
  }, { passive: false });

  // Tap to preview, double-tap to study
  let lastTap = 0;
  canvas.addEventListener('pointerup', (e) => {
    const now = Date.now();
    const node = hitTestNode(e.clientX, e.clientY);
    if (!node) return;

    if (now - lastTap < 300) {
      // Double tap
      if (callbacks.onStudyCard) callbacks.onStudyCard(node.id);
    } else {
      // Single tap — show preview
      showCardPreview(node.card);
    }
    lastTap = now;
  });

  function showCardPreview(card) {
    const overlay = document.createElement('div');
    overlay.className = 'card-preview-overlay';
    overlay.innerHTML = `
      <div class="card-preview-card">
        <div class="card-preview-body">
          <div style="font-weight:600;margin-bottom:var(--space-sm);color:var(--ink-muted);font-size:12px;text-transform:uppercase;">Front</div>
          <div style="margin-bottom:var(--space-lg);">${escapeHtml(card.front)}</div>
          <div style="font-weight:600;margin-bottom:var(--space-sm);color:var(--ink-muted);font-size:12px;text-transform:uppercase;">Back</div>
          <div>${escapeHtml(card.back)}</div>
        </div>
        <div class="card-preview-actions">
          <button class="card-preview-close">Close</button>
          <button class="card-preview-study">Study this card</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.card-preview-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.card-preview-study').addEventListener('click', () => {
      overlay.remove();
      if (callbacks.onStudyCard) callbacks.onStudyCard(card.id);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  // Header buttons
  header.querySelector('#cgBack').addEventListener('click', () => {
    if (callbacks.onExit) callbacks.onExit();
  });
  header.querySelector('#cgReset').addEventListener('click', () => {
    runSimulation(nodes, edges, new Map());
  });

  requestAnimationFrame(render);
}

/* ---------- Force Simulation ---------- */
function runSimulation(nodes, edges, overrides) {
  const repulsion = 800;
  const springLength = 140;
  const springK = 0.05;
  const centerGravity = 0.015;
  const damping = 0.9;

  for (let iter = 0; iter < 150; iter++) {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    // Spring attraction
    for (const edge of edges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - springLength) * springK;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      edge.source.vx += fx; edge.source.vy += fy;
      edge.target.vx -= fx; edge.target.vy -= fy;
    }
    // Center gravity
    for (const node of nodes) {
      node.vx -= node.x * centerGravity;
      node.vy -= node.y * centerGravity;
    }
    // Apply velocity
    for (const node of nodes) {
      if (!overrides.has(node.id)) {
        node.x += node.vx;
        node.y += node.vy;
      }
      node.vx *= damping;
      node.vy *= damping;
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
