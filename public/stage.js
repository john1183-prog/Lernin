/* stage.js — the living backdrop behind every screen.
 *
 * A sky that follows the time of day (inside the chosen light or dark theme), two ranges of far
 * hills, three layers of grass and a few drifting seeds. Everything is drawn from seeded SVG
 * paths and moved with CSS `transform` and `opacity` only, so no script runs per frame, and it moves
 * in steps on one shared 50 ms beat (BEAT_MS in stage-core.js) so the browser redraws 20 times a
 * second rather than 60.
 *
 * It is a sibling BEFORE #root (screens replace root.innerHTML, so it must not live inside),
 * behind everything (z-index -1), and decorative: aria-hidden, never carries meaning, and
 * every colour keeps the app's secondary text at 4.5:1 or better (see stage-core.js).
 *
 * It pauses (never hides) while the study card is up, while a phone-width text screen's sheet covers it,
 * and for good for the visit if the frame watchdog sees the device not keeping up. Calm switches it
 * off entirely (CSS).
 *
 * No import from app.js: app.js calls into this file, never the other way round.
 */

import { createLoop, ambientAllowed, onAmbientChange } from './motion-pref.js';
import {
  timeBand, msUntilNextBand, stagePalette, hillPath, grassPath, starField, seedSpecs,
  GRASS_LAYERS, GRASS_H, WATCHDOG, shouldPauseAmbient, frameDurations, stageWantedOnRoute, stageSheetOnRoute, screenForRoute
} from './stage-core.js';

const SVG_SEED = '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none"><path d="M12 22 V12"/><path d="M12 12 L5 5 M12 12 L8 3 M12 12 L12 2 M12 12 L16 3 M12 12 L19 5"/></g><g fill="currentColor"><circle cx="12" cy="22" r="1.7"/><circle cx="5" cy="5" r="1"/><circle cx="8" cy="3" r="1"/><circle cx="12" cy="2" r="1"/><circle cx="16" cy="3" r="1"/><circle cx="19" cy="5" r="1"/></g></svg>';

let el = null;
let built = false;
let onRoute = false;                       // does the current screen get the stage at all?
let currentRoute = '';
let narrowMq = null;                       // phone width: a text screen's sheet covers the whole stage
let rootEl = null;                         // #root: a study session mounts here (see syncStudyPause)
const NARROW = '(max-width: 759px)';       // keep in step with the sheet's media query in stage.css
const pauseWhy = { study: false, watchdog: false, sheet: false };
let bandTimer = 0;
let watchdogTimer = 0;
let sampler = null;
let samples = [];
let watchdogDone = false;                  // verdict reached: stop sampling for the rest of the visit

function isDarkNow() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function buildLayers() {
  const hillFar = hillPath('hill-far', 1440, 420, 150, 46, 18);
  const hillNear = hillPath('hill-near', 1440, 300, 120, 34, 14);
  const grass = GRASS_LAYERS.map((g) =>
    '<svg viewBox="0 0 1440 ' + GRASS_H + '" preserveAspectRatio="none" aria-hidden="true"><path d="' +
    grassPath(g.seed, g.minH, g.maxH, g.gap, g.solidBase) + '"/></svg>').join('');
  const stars = starField().map((s) => '<circle cx="' + s.cx + '%" cy="' + s.cy + '%" r="' + s.r + '"/>').join('');
  const seeds = seedSpecs().map((s) =>
    '<div class="stage-seed" style="--y:' + s.y + '%;--s:' + s.s + 'px;--d:' + s.d + 's;--delay:' + s.delay + 's;--n:' + s.n + ';--m:' + s.m + '">' + SVG_SEED + '</div>').join('');

  el.innerHTML =
    '<div class="stage-glow"></div>' +
    '<div class="stage-stars"><svg width="100%" height="100%" fill="#fff" aria-hidden="true">' + stars + '</svg></div>' +
    '<svg class="stage-hill stage-hill-far" viewBox="0 0 1440 420" preserveAspectRatio="none" aria-hidden="true"><path d="' + hillFar + '"/></svg>' +
    '<svg class="stage-hill stage-hill-near" viewBox="0 0 1440 300" preserveAspectRatio="none" aria-hidden="true"><path d="' + hillNear + '"/></svg>' +
    '<div class="stage-grass">' + grass + '</div>' +
    '<div class="stage-seeds">' + seeds + '</div>';
}

/** Put the current theme's palette for the current time band on the stage. */
function applyPalette() {
  if (!el) return;
  const band = timeBand(new Date().getHours());
  const dark = isDarkNow();
  const p = stagePalette(dark, band);
  const s = el.style;
  s.setProperty('--sky-top', p.top);
  s.setProperty('--sky-bottom', p.bot);
  s.setProperty('--sun', p.sun);
  s.setProperty('--sun-x', p.sx);
  s.setProperty('--sun-y', p.sy);
  s.setProperty('--hill-far', p.far);
  s.setProperty('--hill-near', p.near);
  s.setProperty('--grass', p.grass);
  s.setProperty('--seed', p.seed);
  s.setProperty('--stars', String(p.stars));
  el.dataset.band = band;
  el.dataset.theme = dark ? 'dark' : 'light';
  if (p.stars > 0) el.setAttribute('data-stars', ''); else el.removeAttribute('data-stars');
}

function scheduleBandCheck() {
  clearTimeout(bandTimer);
  // wake a moment after the next boundary; one timer, not a poll
  bandTimer = setTimeout(() => { applyPalette(); scheduleBandCheck(); }, msUntilNextBand(new Date()) + 1000);
}

function syncPaused() {
  if (!el) return;
  const paused = pauseWhy.study || pauseWhy.watchdog || pauseWhy.sheet;
  el.toggleAttribute('data-paused', paused);
  el.dataset.pausedWhy = pauseWhy.watchdog ? 'watchdog' : pauseWhy.study ? 'study' : pauseWhy.sheet ? 'sheet' : '';
}

/** On a phone a text screen's sheet hides the stage, so nothing should animate behind it. */
function syncSheetPause() {
  pauseWhy.sheet = stageSheetOnRoute(currentRoute) && !!(narrowMq && narrowMq.matches);
  syncPaused();
}

/**
 * The study card holds the stage still (decision 9). That is the /study route, and also "Study this card"
 * from a card's detail page, which mounts a session on #root while the address still says /cards/...
 * So the truth is what #root holds: a session sets the class on #root itself, or (nothing due, empty deck)
 * puts a .study-session child in it.
 */
function syncStudyPause() {
  const studying = currentRoute === 'study' ||
    !!(rootEl && (rootEl.classList.contains('study-session') || rootEl.querySelector(':scope > .study-session')));
  if (studying === pauseWhy.study) return;
  pauseWhy.study = studying;
  syncPaused();
}

// ---------------------------------------------------------------------------
// Frame watchdog: if frames keep averaging over ~25 ms for 2 seconds, pause the ambient layers
// for the rest of the visit. The sampler only runs during a short window, only while the stage is
// on screen and moving, and never in Calm or a hidden tab (createLoop sees to that).
// ---------------------------------------------------------------------------

function sampleWindow() {
  clearTimeout(watchdogTimer);
  if (watchdogDone || !onRoute || pauseWhy.study || pauseWhy.sheet || !ambientAllowed()) {
    // not a moment to measure: look again later
    if (!watchdogDone) watchdogTimer = setTimeout(sampleWindow, 15000);
    return;
  }
  samples = [];
  sampler = sampler || createLoop((t) => { samples.push(t); }, { fps: 60 });
  sampler.start();
  watchdogTimer = setTimeout(() => {
    sampler.stop();
    if (shouldPauseAmbient(frameDurations(samples))) {
      watchdogDone = true;
      pauseWhy.watchdog = true;
      syncPaused();
      return;
    }
    watchdogTimer = setTimeout(sampleWindow, 45000);
  }, WATCHDOG.windowMs);
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Build the stage once. Safe to call twice. */
export function initStage() {
  if (built) return;
  el = document.getElementById('stage');
  if (!el) return;
  built = true;
  buildLayers();
  applyPalette();
  syncPaused();
  scheduleBandCheck();
  // the palette follows the theme: the app sets data-theme on <html>
  new MutationObserver(applyPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener('change', applyPalette) : mq.addListener && mq.addListener(applyPalette));
  }
  // a phone-width text screen hides the stage behind its sheet: hold it still while that is so
  if (window.matchMedia) {
    narrowMq = window.matchMedia(NARROW);
    (narrowMq.addEventListener ? narrowMq.addEventListener('change', syncSheetPause) : narrowMq.addListener && narrowMq.addListener(syncSheetPause));
    syncSheetPause();   // setStageRoute may have run before this point
  }
  // a study session can be mounted on #root from any screen: watch what #root holds (its children and its class only)
  rootEl = document.getElementById('root');
  if (rootEl) new MutationObserver(syncStudyPause).observe(rootEl, { childList: true, attributes: true, attributeFilter: ['class'] });
  syncStudyPause();
  // coming back to a tab after the band changed
  onAmbientChange((allowed) => { if (allowed) applyPalette(); });
  // two frames so the first palette is in place before the fade-in transition is switched on
  requestAnimationFrame(() => requestAnimationFrame(() => { if (el) el.setAttribute('data-ready', ''); }));
  watchdogTimer = setTimeout(sampleWindow, 1500);
}

/**
 * Tell the stage which screen is showing. `route` is the router's first path segment ('' for Home).
 * Called by app.js on every route. Sets <html data-stage> and data-screen for the stylesheet.
 */
export function setStageRoute(route) {
  const r = screenForRoute(route);          // the screen the router really shows (Home for a path it does not know)
  const root = document.documentElement;
  currentRoute = r;
  onRoute = stageWantedOnRoute(r);
  root.setAttribute('data-stage', onRoute ? 'on' : 'off');
  root.setAttribute('data-screen', r === '' ? 'home' : r);
  syncStudyPause();                        // decision 9: the card stays still, so the stage holds still behind it
  syncSheetPause();                        // (also calls syncPaused)
}
