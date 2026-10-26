/* motion-pref.js — one place that answers "may anything move right now?"
 *
 * Dependency-free on purpose: it imports nothing, so canvas.js (which must never import
 * app.js) and every other module may import it. It also loads in Node (tests), so every
 * browser global is reached through a guard.
 *
 * Three things live here:
 *   1. Calm: the OS "reduce motion" setting OR the Calm switch in Settings. `data-calm="1"`
 *      is kept on <html> so CSS can mirror the prefers-reduced-motion block.
 *   2. createLoop(): an animation loop that runs only while something is wanted, the tab is
 *      visible, its element is on screen and Calm is off.
 *   3. hash() / rng(): seeded helpers, so everything procedural looks the same on every visit.
 *      Never Math.random for anything the person can see.
 */

const HAS_DOM = typeof document !== 'undefined' && !!document.documentElement;
const mqReduce = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

/** localStorage boot cache for the Calm switch; index.html reads it before first paint. */
export const CALM_STORAGE_KEY = 'lernin-calm';

// ---------------------------------------------------------------------------
// Seeded helpers
// ---------------------------------------------------------------------------

/**
 * FNV-1a string hash to [0, 1), with a final mix so keys that differ only in the last
 * letter ('n1', 'n2', 'n3') do not land next to each other.
 */
export function hash(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Seeded generator (mulberry32): rng('hills')() gives the same sequence on every visit. */
export function rng(seed) {
  let a = Math.floor(hash(seed) * 4294967296) >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Calm
// ---------------------------------------------------------------------------

let calmManual = false;
const calmListeners = new Set();

/** Pure: Calm is on when the switch is on or the OS asks for reduced motion. */
export function calmFrom(manual, osReduce) {
  return !!manual || !!osReduce;
}

export function isCalm() {
  return calmFrom(calmManual, mqReduce && mqReduce.matches);
}

/** True only when the person's own Calm switch is on (what the Settings toggle shows). */
export function isCalmManual() {
  return calmManual;
}

function applyCalm() {
  if (HAS_DOM) document.documentElement.setAttribute('data-calm', isCalm() ? '1' : '0');
  for (const fn of Array.from(calmListeners)) {
    try { fn(isCalm()); } catch (e) { /* a listener must never break the others */ }
  }
}

/** Set the Calm switch (does not persist to IndexedDB: app.js does that with saveSetting). */
export function setCalm(on) {
  calmManual = !!on;
  try { localStorage.setItem(CALM_STORAGE_KEY, calmManual ? '1' : '0'); } catch (e) { /* no storage: fine */ }
  applyCalm();
}

/** Start-up: adopt a stored value (boot cache or IndexedDB) without rewriting storage. */
export function initCalm(storedManual) {
  calmManual = !!storedManual;
  try {
    const cached = localStorage.getItem(CALM_STORAGE_KEY);
    if (cached !== (calmManual ? '1' : '0')) localStorage.setItem(CALM_STORAGE_KEY, calmManual ? '1' : '0');
  } catch (e) { /* ignore */ }
  applyCalm();
}

/** Subscribe to Calm changes (switch or OS). Returns an unsubscribe function. */
export function onCalm(fn) {
  calmListeners.add(fn);
  return () => calmListeners.delete(fn);
}

if (mqReduce) {
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', applyCalm);
  else if (mqReduce.addListener) mqReduce.addListener(applyCalm);
}

/** Ambient motion (anything that moves with nobody touching the screen) is allowed. */
export function ambientAllowed() {
  return !isCalm() && !(HAS_DOM && document.hidden);
}

/**
 * Subscribe to "ambient motion just became allowed or forbidden": Calm switched, or the tab was
 * hidden or shown. Loops use it to restart themselves. Returns an unsubscribe function.
 */
export function onAmbientChange(fn) {
  const call = () => { try { fn(ambientAllowed()); } catch (e) { /* ignore */ } };
  const offCalm = onCalm(call);
  if (HAS_DOM) document.addEventListener('visibilitychange', call);
  return () => {
    offCalm();
    if (HAS_DOM) document.removeEventListener('visibilitychange', call);
  };
}

/**
 * A clock for ambient motion: the real time normally, a frozen 0 in Calm, so a redraw caused by
 * touch (a pan, a tap) never shows a different sway phase and nothing seems to move on its own.
 */
export function ambientNow() {
  return isCalm() ? 0 : Date.now();
}

// ---------------------------------------------------------------------------
// Visibility-aware animation loop
// ---------------------------------------------------------------------------

/**
 * createLoop(draw, { fps, el })
 *   draw(t)  called with the frame timestamp
 *   fps      upper limit (default 30); use 60 to see every frame
 *   el       optional element: the loop idles while it is off screen
 * Returns { start(), stop(), kick(), dispose() }. Nothing is scheduled until start(), and
 * nothing is scheduled while Calm is on, the tab is hidden or `el` is off screen.
 */
export function createLoop(draw, opts) {
  const o = Object.assign({ fps: 30, el: null }, opts || {});
  const minDt = 1000 / o.fps;
  let raf = 0;
  let last = 0;
  let wanted = false;
  let visible = true;
  let io = null;

  function allowed() { return wanted && visible && ambientAllowed(); }
  function frame(t) {
    raf = 0;
    if (!allowed()) return;
    if (t - last >= minDt - 1) { last = t; draw(t); }
    raf = requestAnimationFrame(frame);
  }
  function ensure() {
    if (!raf && allowed() && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
  }

  if (o.el && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      ensure();
    }, { threshold: 0.01 });
    io.observe(o.el);
  }
  const off = onAmbientChange(ensure);

  return {
    start() { wanted = true; ensure(); },
    stop() { wanted = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    /** Draw one frame now (a still scene stays correct) and carry on if allowed. */
    kick() { draw(typeof performance !== 'undefined' ? performance.now() : 0); ensure(); },
    dispose() {
      this.stop();
      off();
      if (io) io.disconnect();
    }
  };
}
