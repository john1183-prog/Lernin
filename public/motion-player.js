// Lernin — Motion Studio player.
//
// Takes the resolved JSON api/index.py's expand_script() produces (see
// motion_schema.py / motion_engine.py for the exact shape) and plays it
// back on a <canvas>. This is the ONLY code that ever draws a Motion
// Studio animation — it is fixed, shipped-once app code, never touched
// by anything AI-generated. The resolved JSON tells it what to draw and
// when; how to draw it is entirely defined here, ahead of time.
//
// Ported from the reference "Grok Motion Studio" tool's interpolation
// and canvas-drawing logic (Layer.get / applyEase / drawLayer), trimmed
// to the v1 shape set: rect, circle, text, polygon, arrow, line, group,
// caption, emphasis. No particles, physics, audio-reactive, or beat
// detection — cut for the study-explainer case, see UPCOMING_FEATURES.md.
//
// New versus the reference tool: format:"formula" layers render through
// KaTeX instead of canvas fillText. KaTeX renders to DOM, not pixels, so
// those layers get a small absolutely-positioned overlay element instead
// of a canvas draw call — rendered once, then just repositioned every
// frame via CSS transform so the expensive KaTeX render never repeats.

// ---------- Easing ----------
// Exact port of the reference tool's EZ table. No cubic-bezier support —
// the schema only offers these seven named easings, so there's nothing
// to look up beyond this table.
const EASE = {
  linear: t => t,
  easein: t => t * t * t,
  easeout: t => 1 - Math.pow(1 - t, 3),
  easeinout: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  bounce: t => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
    if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
    t -= 2.625 / d;
    return n * t * t + 0.984375;
  },
  elastic: t => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  back: t => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

function applyEase(name, t) {
  t = Math.max(0, Math.min(1, t));
  const fn = EASE[(name || 'linear').toLowerCase()] || EASE.linear;
  return fn(t);
}

/**
 * Perceived luminance of a hex color (Rec. 709 weights), used to decide
 * whether a caption's background chip should be dark or light — see
 * drawShape()'s caption case. Scene backgrounds are opaque hex strings
 * by construction (schema-validated), so no alpha handling needed.
 */
function isLightColor(hex) {
  if (!hex || hex[0] !== '#') return false;
  const h = hex.length === 4
    ? hex.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3')
    : hex;
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  if ([r, g, b].some(Number.isNaN)) return false;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6;
}

function lerpColor(hexA, hexB, t) {
  const pa = parseInt(hexA.slice(1), 16), pb = parseInt(hexB.slice(1), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b = Math.round(ab + (bb - ab) * t);
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

// ---------- Interpolation ----------
// layer.keyframes is {property: [{time, value, easing}, ...]} sorted by
// time — exactly what motion_engine.expand_script() produces. If a
// property has no keyframes, its static base value is returned as-is.
function valueAt(layer, prop, t) {
  const kfs = layer.keyframes && layer.keyframes[prop];
  const base = layer[prop];
  if (!kfs || !kfs.length) return base;
  if (t <= kfs[0].time) return kfs[0].value;
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.time && t <= b.time) {
      const seg = b.time - a.time;
      const et = applyEase(b.easing, seg === 0 ? 1 : (t - a.time) / seg);
      if (typeof a.value === 'number' && typeof b.value === 'number') {
        return a.value + (b.value - a.value) * et;
      }
      if (typeof a.value === 'string' && typeof b.value === 'string' && HEX_RE.test(a.value) && HEX_RE.test(b.value)) {
        return lerpColor(a.value, b.value, et);
      }
      return et > 0.5 ? b.value : a.value;
    }
  }
  return base;
}

// ---------- Layer tree ----------
function rootLayers(layers) {
  const names = new Set(layers.map(l => l.name));
  return layers.filter(l => !l.parent || !names.has(l.parent) || l.parent === l.name);
}
function childrenOf(layers, parent) {
  return layers.filter(l => l.parent === parent.name && l !== parent);
}

const MAX_NEST_DEPTH = 25;

// ---------- Shape drawing ----------
function polygonPath(ctx, r, sides) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = (i * 2 * Math.PI) / sides - Math.PI / 2;
    const px = r * Math.cos(a), py = r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawArrow(ctx, l, t, inheritedOpacity) {
  const x1 = valueAt(l, 'x', t), y1 = valueAt(l, 'y', t);
  const x2 = l.x2 != null ? l.x2 : x1 + 100;
  const y2 = l.y2 != null ? l.y2 : y1;
  const op = valueAt(l, 'opacity', t);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, (op != null ? op : 1) * inheritedOpacity));
  ctx.strokeStyle = valueAt(l, 'color', t) || '#ffffff';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = l.strokeWidth || 3;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1), hs = 10;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - hs * Math.cos(ang - Math.PI / 6), y2 - hs * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(x2 - hs * Math.cos(ang + Math.PI / 6), y2 - hs * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
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

// Draws one layer's non-formula content to the 2D context. Formula-format
// text/caption/emphasis layers are skipped here entirely — the overlay
// system below handles them — everything else is a plain canvas draw.
function drawShape(ctx, l, col) {
  switch (l.type) {
    case 'group':
      break;
    case 'rect':
      ctx.fillRect(-l.width / 2, -l.height / 2, l.width, l.height);
      if (l.strokeWidth) { ctx.strokeStyle = l.color; ctx.lineWidth = l.strokeWidth; ctx.strokeRect(-l.width / 2, -l.height / 2, l.width, l.height); }
      break;
    case 'circle':
      ctx.beginPath();
      ctx.arc(0, 0, l.radius, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'polygon':
      polygonPath(ctx, l.radius || 60, l.sides || 6);
      ctx.fill();
      break;
    case 'line':
      ctx.beginPath();
      ctx.moveTo(-(l.width || 100) / 2, 0);
      ctx.lineTo((l.width || 100) / 2, 0);
      ctx.strokeStyle = col;
      ctx.lineWidth = l.strokeWidth || 2;
      ctx.stroke();
      break;
    case 'text':
    case 'emphasis':
      ctx.font = `${l.fontSize || 48}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.text || '', 0, 0);
      break;
    case 'caption': {
      ctx.font = `${l.fontSize || 26}px system-ui, -apple-system, sans-serif`;
      const text = l.text || '';
      const padX = 16, padY = 10;
      const tw = ctx.measureText(text).width;
      const bw = tw + padX * 2, bh = (l.fontSize || 26) * 1.25 + padY * 2;
      // The box needs to contrast with THIS caption's own text color, not
      // a fixed assumption about the scene -- a light-theme script's dark
      // ink text (see onboarding-script-light.json) was landing on the
      // same hardcoded black chip a dark-theme script's white text uses,
      // which reads fine on a dark background but is dark-on-dark and
      // hard to read on a light one. Keying off the resolved text color
      // itself (already in hand as `col`) rather than the scene
      // background is the more direct fix: it's the box/text pair that
      // needs contrast, not the box/wider-scene pair.
      ctx.fillStyle = isLightColor(col) ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)';
      roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 8);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0);
      break;
    }
  }
}

const TEXT_TYPES = new Set(['text', 'caption', 'emphasis']);

function drawLayer(ctx, layers, l, t, inheritedOpacity, depth, overlay) {
  if (depth > MAX_NEST_DEPTH) return;

  if (l.type === 'arrow') {
    drawArrow(ctx, l, t, inheritedOpacity);
    for (const c of childrenOf(layers, l)) drawLayer(ctx, layers, c, t, inheritedOpacity, depth + 1, overlay);
    return;
  }

  const lx = valueAt(l, 'x', t), ly = valueAt(l, 'y', t);
  const sc = valueAt(l, 'scale', t);
  const scale = sc != null ? sc : 1;
  const rot = ((valueAt(l, 'rotation', t) || 0) * Math.PI) / 180;
  const ownOpRaw = valueAt(l, 'opacity', t);
  const ownOp = ownOpRaw != null ? ownOpRaw : 1;
  const op = Math.max(0, Math.min(1, ownOp * inheritedOpacity));
  const col = valueAt(l, 'color', t) || '#ffffff';

  const isFormula = TEXT_TYPES.has(l.type) && l.format === 'formula';
  if (isFormula) {
    overlay.place(l, lx, ly, rot, scale, op);
    for (const c of childrenOf(layers, l)) drawLayer(ctx, layers, c, t, op, depth + 1, overlay);
  } else {
    overlay.hide(l);
    ctx.save();
    ctx.globalAlpha = op;
    ctx.translate(lx, ly);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.fillStyle = col;
    drawShape(ctx, l, col);
    // Children must draw BEFORE restore(): group/parent hierarchy relies
    // on the canvas's cumulative transform still being active for them.
    // (Previously restore() ran first, so any layer's children were
    // drawn as if the parent had no transform at all.)
    for (const c of childrenOf(layers, l)) drawLayer(ctx, layers, c, t, op, depth + 1, overlay);
    ctx.restore();
  }
}

// ---------- KaTeX overlay ----------
// One absolutely-positioned div per formula layer, rendered through
// KaTeX exactly once (KaTeX renders to DOM, not pixels, and re-rendering
// it every frame would be wasteful and unnecessary). After that first
// render, each frame only updates its CSS transform/opacity — cheap, and
// keeps it in lockstep with the canvas layers using the same interpolated
// numbers. Nested camera div mirrors the canvas's own camera transform
// (translate to center, rotate, scale, translate by -camera) exactly, so
// formulas stay aligned with canvas content through pans and zooms.
function createOverlay(canvas) {
  const parent = canvas.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:hidden;';
  const cameraLayer = document.createElement('div');
  cameraLayer.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;';
  root.appendChild(cameraLayer);
  parent.style.position ||= 'relative';
  parent.appendChild(root);

  const els = new Map();
  const katexReady = () => typeof window !== 'undefined' && window.katex;

  function sync(sceneW, sceneH, cssW, cssH) {
    const s = cssW && sceneW ? cssW / sceneW : 1;
    root.style.width = sceneW + 'px';
    root.style.height = sceneH + 'px';
    root.style.transform = `scale(${s})`;
    root.style.transformOrigin = '0 0';
  }

  function setCamera(cx, cy, zoom, rotDeg, sceneW, sceneH) {
    cameraLayer.style.transform =
      `translate(${sceneW / 2}px, ${sceneH / 2}px) rotate(${rotDeg}deg) scale(${zoom}) translate(${-cx}px, ${-cy}px)`;
  }

  function place(layer, x, y, rotRad, scale, opacity) {
    let el = els.get(layer.name);
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;transform-origin:50% 50%;white-space:nowrap;';
      cameraLayer.appendChild(el);
      els.set(layer.name, el);
      if (katexReady()) {
        try {
          window.katex.render(layer.text || '', el, { throwOnError: false, displayMode: false });
        } catch (e) {
          el.textContent = layer.text || '';
        }
      } else {
        el.textContent = layer.text || '';
      }
      if (layer.color) el.style.color = layer.color;
      if (layer.fontSize) el.style.fontSize = layer.fontSize + 'px';
    }
    const rotDeg = (rotRad * 180) / Math.PI;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg) scale(${scale})`;
    el.style.opacity = String(opacity);
    el.style.display = '';
  }

  function hide(layer) {
    const el = els.get(layer.name);
    if (el) el.style.display = 'none';
  }

  function destroy() {
    root.remove();
  }

  return { sync, setCamera, place, hide, destroy };
}

// ---------- Audio cues ----------
// script.audio (if present) is already fully resolved by expand_script():
// [{time, tone}, ...] sorted ascending. The player never plays a sound
// itself — that would couple this pure renderer to sound.js and to the
// app's sound-enabled setting, neither of which belongs here. Instead it
// tracks a pointer into the sorted cue list and calls opts.onAudioCue(tone,
// time) once per cue, only as real-time forward playback crosses it — never
// on seek/scrub, and never more than once per cue per pass. The caller
// decides what a cue actually sounds like (see sound.js's playMotionCue()).

// ---------- Public API ----------
// createPlayer(canvas, script) returns a controller. `script` is the
// resolved JSON from /api/generate-motion or /api/expand-motion-script
// (or whatever was cached in IndexedDB from an earlier generation) —
// never anything else, and never anything executed.
export function createPlayer(canvas, script, opts = {}) {
  const ctx = canvas.getContext('2d');
  const scene = script.scene;
  const layers = script.layers;
  const camera = script.camera;

  canvas.width = scene.width;
  canvas.height = scene.height;

  const overlay = createOverlay(canvas);
  const roots = rootLayers(layers);

  const audioCues = Array.isArray(script.audio)
    ? script.audio.slice().sort((a, b) => a.time - b.time)
    : [];
  let audioCueIdx = 0;

  function fireCuesUpTo(time) {
    while (audioCueIdx < audioCues.length && audioCues[audioCueIdx].time <= time) {
      if (opts.onAudioCue) opts.onAudioCue(audioCues[audioCueIdx].tone, audioCues[audioCueIdx].time);
      audioCueIdx++;
    }
  }

  // Points audioCueIdx at the first cue strictly after `time`, so a seek
  // never fires a cue as a side effect of scrubbing, but forward playback
  // resumed from that point still fires everything after it correctly.
  function resetAudioCuePointer(time) {
    let i = 0;
    while (i < audioCues.length && audioCues[i].time <= time + 1e-6) i++;
    audioCueIdx = i;
  }

  let t = 0;
  let playing = false;
  let rafId = null;
  let lastTs = null;

  function resize() {
    const cssWidth = canvas.getBoundingClientRect().width || scene.width;
    overlay.sync(scene.width, scene.height, cssWidth);
  }

  function render() {
    ctx.fillStyle = scene.background || '#161616';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();

    let cx = scene.width / 2, cy = scene.height / 2, zoom = 1, rotDeg = 0;
    if (camera) {
      cx = valueAt(camera, 'x', t);
      cy = valueAt(camera, 'y', t);
      zoom = valueAt(camera, 'zoom', t) || 1;
      rotDeg = valueAt(camera, 'rotation', t) || 0;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotDeg * Math.PI) / 180);
      ctx.scale(zoom, zoom);
      ctx.translate(-cx, -cy);
    }
    overlay.setCamera(cx, cy, zoom, rotDeg, scene.width, scene.height);

    for (const l of roots) drawLayer(ctx, layers, l, t, 1, 0, overlay);
    ctx.restore();

    if (opts.onFrame) opts.onFrame(t);
  }

  function loop(ts) {
    if (playing) {
      if (lastTs != null) {
        t += (ts - lastTs) / 1000;
        if (t > scene.duration) {
          // Fire whatever's left before the end, then wrap (or stop).
          fireCuesUpTo(scene.duration);
          if (opts.onLoopComplete) {
            try { opts.onLoopComplete(); } catch (err) { console.error(err); }
          }
          if (opts.loop === false) {
            t = scene.duration;
            playing = false;
            if (opts.onEnded) {
              try { opts.onEnded(); } catch (err) { console.error(err); }
            }
          } else {
            t = 0;
            audioCueIdx = 0; // next pass can fire the same cues again
          }
        } else {
          fireCuesUpTo(t);
        }
      }
      lastTs = ts;
    }
    render();
    if (playing) rafId = requestAnimationFrame(loop);
  }

  resize();
  render();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
  }

  return {
    play() {
      if (playing) return;
      playing = true;
      lastTs = null;
      rafId = requestAnimationFrame(loop);
    },
    pause() {
      playing = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
    seek(seconds) {
      t = Math.max(0, Math.min(scene.duration, seconds));
      resetAudioCuePointer(t);
      render();
    },
    get currentTime() { return t; },
    get duration() { return scene.duration; },
    get playing() { return playing; },
    destroy() {
      playing = false;
      if (rafId) cancelAnimationFrame(rafId);
      overlay.destroy();
    },
  };
}

/**
 * Renders a static preview frame of a resolved Motion Studio script onto a target canvas.
 * Used for compact 16:9 thumbnails in the saved explainers list.
 */
export function renderScriptThumbnail(canvas, script, targetTime = null) {
  if (!canvas || !script || !script.scene) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const scene = script.scene;
  const layers = script.layers || [];
  const camera = script.camera;
  canvas.width = scene.width || 800;
  canvas.height = scene.height || 450;

  const duration = typeof scene.duration === 'number' && scene.duration > 0 ? scene.duration : 4;
  const t = targetTime != null
    ? targetTime
    : Math.min(duration, Math.max(0.5, duration * 0.3));

  ctx.fillStyle = scene.background || '#161616';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();

  let cx = (scene.width || 800) / 2, cy = (scene.height || 450) / 2, zoom = 1, rotDeg = 0;
  if (camera) {
    cx = valueAt(camera, 'x', t);
    cy = valueAt(camera, 'y', t);
    zoom = valueAt(camera, 'zoom', t) || 1;
    rotDeg = valueAt(camera, 'rotation', t) || 0;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);
  }

  const roots = rootLayers(layers);
  const dummyOverlay = { place() {}, hide() {} };
  for (const l of roots) {
    drawLayer(ctx, layers, l, t, 1, 0, dummyOverlay);
  }
  ctx.restore();
}

