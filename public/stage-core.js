/* stage-core.js — the pure half of the stage: no DOM, no timers, so Node tests can import it.
 *
 * The stage is the living backdrop behind every screen: a sky that follows the time of day,
 * two ranges of far hills, three layers of grass and a few drifting seeds. This file holds
 * what is drawn (seeded paths and the colour palette) and the one decision the stage makes
 * about itself (the frame watchdog). stage.js puts it on the page.
 *
 * Contrast rule (design doc, "text on opaque panels, decoration never lowers contrast"): no text sits
 * straight on the stage, so the stage's colours are free; see the note on PALETTE.
 */

import { rng } from './motion-pref.js';

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

export const BANDS = ['dawn', 'day', 'dusk', 'night'];

/** dawn 05 to 08, day 08 to 17, dusk 17 to 20, night 20 to 05 (local hours). */
export function timeBand(hour) {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

const BAND_STARTS = [5, 8, 17, 20];

/** Milliseconds from `date` to the next band boundary (always > 0), for the re-check timer. */
export function msUntilNextBand(date) {
  const d = new Date(date.getTime());
  for (const h of BAND_STARTS) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0);
    if (t.getTime() > d.getTime()) return t.getTime() - d.getTime();
  }
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, BAND_STARTS[0], 0, 0, 0);
  return next.getTime() - d.getTime();
}

/*
 * Palette per theme and band, the Sketchbook's own (js/20_stage.js, the one John approved).
 * top/bot: the sky gradient. sun: a soft glow (position sx/sy). far/near: hills. grass. seed: the
 * drifting seeds. stars: opacity of the star field (night and the edges of the day, dark theme only).
 *
 * Contrast: none of these colours is chosen for text. No text sits straight on the stage; every line
 * of text sits on an opaque panel in the page colour (Home's cards, the sheet behind each text screen,
 * the title bar, the study bands, stage.css says which), so text has exactly the contrast it has on
 * the plain page. test_stage.mjs fails if stage.css stops giving a panel to any of them, and the
 * browser audit fails if any text can reach the bare stage. (An earlier build thinned these colours
 * until secondary text kept 4.5:1 directly on every layer; that made the light stage nearly invisible
 * on a phone and was needed only while text sat on the stage.)
 */
export const PALETTE = {
  light: {
    dawn:  { top: '#F6DCCB', bot: '#F3F8F4', sun: 'rgba(255,170,120,0.55)', sx: '16%', sy: '68%', far: '#D9E6D3', near: '#C2D9BE', grass: '#9DBF8A', seed: 'rgba(120,92,60,0.6)', stars: 0 },
    day:   { top: '#D5ECEF', bot: '#F3F8F4', sun: 'rgba(255,238,170,0.55)', sx: '80%', sy: '14%', far: '#CFE4D1', near: '#B7D5B6', grass: '#8DBA7E', seed: 'rgba(110,98,70,0.55)', stars: 0 },
    dusk:  { top: '#F0D0CC', bot: '#F6F0E6', sun: 'rgba(255,140,100,0.5)', sx: '86%', sy: '60%', far: '#D8D9C9', near: '#BFD0B2', grass: '#98B67F', seed: 'rgba(125,86,64,0.6)', stars: 0 },
    night: { top: '#C9D5E8', bot: '#E3EBEE', sun: 'rgba(235,240,255,0.75)', sx: '24%', sy: '16%', far: '#C5D3CB', near: '#AEC4B6', grass: '#86A98A', seed: 'rgba(80,96,120,0.55)', stars: 0 }
  },
  dark: {
    dawn:  { top: '#34283A', bot: '#0F1810', sun: 'rgba(255,150,110,0.28)', sx: '16%', sy: '72%', far: '#1C2A22', near: '#162219', grass: '#2F5A33', seed: 'rgba(237,239,241,0.7)', stars: 0.25 },
    day:   { top: '#173A34', bot: '#0F1810', sun: 'rgba(255,230,150,0.2)', sx: '80%', sy: '14%', far: '#1A2E24', near: '#14241B', grass: '#2E5E36', seed: 'rgba(237,239,241,0.7)', stars: 0 },
    dusk:  { top: '#3A2A3A', bot: '#101810', sun: 'rgba(255,120,90,0.26)', sx: '86%', sy: '64%', far: '#1F2A22', near: '#17231A', grass: '#2D5532', seed: 'rgba(237,239,241,0.7)', stars: 0.15 },
    night: { top: '#0A1330', bot: '#0E1A18', sun: 'rgba(190,205,255,0.3)', sx: '24%', sy: '16%', far: '#142320', near: '#101D19', grass: '#27492F', seed: 'rgba(237,239,241,0.75)', stars: 1 }
  }
};

/** The palette for a theme and a band. Unknown input falls back to light/day. */
export function stagePalette(isDark, band) {
  const set = isDark ? PALETTE.dark : PALETTE.light;
  return set[band] || set.day;
}

// ---------------------------------------------------------------------------
// Drawn scenery (seeded: the same on every visit)
// ---------------------------------------------------------------------------

/** A range of hills as an SVG path, `w` by `h`, ridge near `base`. */
export function hillPath(seed, w, h, base, a1, a2) {
  const r = rng(seed);
  const p1 = r() * 6.283, p2 = r() * 6.283, p3 = r() * 6.283;
  const f1 = 1.1 + r() * 0.5, f2 = 2.3 + r() * 0.9, f3 = 4.6 + r();
  const N = 36;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push([
      t * w,
      base + a1 * Math.sin(t * 6.283 * f1 + p1) + a2 * Math.sin(t * 6.283 * f2 + p2) + a2 * 0.35 * Math.sin(t * 6.283 * f3 + p3)
    ]);
  }
  let d = 'M0 ' + h + ' L' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
  for (let i = 1; i < N; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ' Q' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1) + ' ' + mx.toFixed(1) + ' ' + my.toFixed(1);
  }
  return d + ' L' + w + ' ' + pts[N][1].toFixed(1) + ' L' + w + ' ' + h + ' Z';
}

/** Height of the grass strip in its own coordinate space (the SVG viewBox is 1440 by GRASS_H). */
export const GRASS_H = 86;

/** One layer of grass blades as an SVG path; `solidBase` adds a thin solid strip at the bottom. */
export function grassPath(seed, minH, maxH, gap, solidBase) {
  const r = rng(seed);
  let d = '';
  let x = -10;
  while (x < 1450) {
    const bh = minH + r() * (maxH - minH);
    const lean = (r() - 0.5) * 18;
    const bw = 3 + r() * 3.5;
    d += 'M' + x.toFixed(1) + ' ' + GRASS_H +
      ' Q' + (x + bw * 0.4).toFixed(1) + ' ' + (GRASS_H - bh * 0.62).toFixed(1) + ' ' + (x + bw * 0.5 + lean).toFixed(1) + ' ' + (GRASS_H - bh).toFixed(1) +
      ' Q' + (x + bw * 0.9 + lean * 0.4).toFixed(1) + ' ' + (GRASS_H - bh * 0.5).toFixed(1) + ' ' + (x + bw).toFixed(1) + ' ' + GRASS_H + 'Z';
    x += gap * (0.6 + r() * 0.8);
  }
  if (solidBase) d += 'M-10 ' + GRASS_H + ' V' + (GRASS_H - 8) + ' H1450 V' + GRASS_H + ' Z';
  return d;
}

/** Three grass layers, back to front. */
export const GRASS_LAYERS = [
  { seed: 'g1', minH: 16, maxH: 40, gap: 11, solidBase: false },
  { seed: 'g2', minH: 22, maxH: 52, gap: 13, solidBase: false },
  { seed: 'g3', minH: 12, maxH: 34, gap: 10, solidBase: true }
];

/** Star positions in percent of the sky box, seeded. */
export function starField(count = 70) {
  const r = rng('stars');
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ cx: +(r() * 100).toFixed(1), cy: +(r() * 100).toFixed(1), r: +(0.5 + r() * 0.9).toFixed(2) });
  }
  return out;
}

/**
 * The beat. Nothing on the stage moves smoothly: every animation steps (CSS steps()) and every step
 * lasts a whole number of beats, so all the layers change in the same frames and the browser has
 * nothing to redraw in between. The same motion drawn smoothly makes it redraw the screen on every
 * frame, which is most of what the stage costs. 50 ms is 20 changes a second, finer than the eye
 * follows at these speeds: a seed on a 1280 px screen moves about a pixel and a half per beat, the
 * hills about a tenth of a pixel. stage.css holds the durations and step counts for everything else;
 * test_stage.mjs fails if any of them stops being a whole number of beats.
 */
export const BEAT_MS = 50;

/**
 * Drifting seeds: height in percent, size in px, one crossing in seconds, and a negative start delay.
 * A crossing is a whole number of 5-second blocks, so its quarters and its fade-in and fade-out
 * (6 % each) come out in whole beats: `n` is the number of steps in each quarter of the crossing,
 * `m` the number in each fade (stage.js writes them as --n and --m, stage.css reads them).
 */
export function seedSpecs(count = 6) {
  const r = rng('seeds');
  const out = [];
  for (let i = 0; i < count; i++) {
    const y = Math.round(12 + r() * 52);
    const s = Math.round(14 + r() * 12);
    const d = 5 * (10 + Math.floor(r() * 8));      // 50 to 85 s, in 5-second blocks
    const delay = -Math.round(r() * 70);
    out.push({
      y, s, d, delay,
      n: Math.round((d * 250) / BEAT_MS),          // beats in a quarter of the crossing (250 ms per second of crossing)
      m: Math.round((d * 60) / BEAT_MS)            // beats in the fade-in, and the same in the fade-out (6 % is 60 ms per second)
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frame watchdog (decision 12, layer three)
// ---------------------------------------------------------------------------

/**
 * Starting values, taken from the design doc's wording (average above about 25 ms, which is under
 * 40 fps, for 2 seconds). They are NOT tuned values: tune them on a real phone.
 */
export const WATCHDOG = Object.freeze({
  windowMs: 2000,   // how long one sample runs
  slowMs: 25,       // an average frame time above this is "not keeping up"
  minFrames: 12,    // fewer frames than this in a window is too little to judge
  maxGapMs: 500     // a single gap longer than this is a stall or a background tab, not slowness
});

/**
 * Should the ambient layers pause for the rest of the visit?
 * `frameTimes` is a list of frame durations in milliseconds (time between one frame and the next).
 * Gaps over `maxGapMs` are ignored; with too few usable frames the answer is no (never punish a
 * device on a guess).
 */
export function shouldPauseAmbient(frameTimes, opts) {
  const o = Object.assign({}, WATCHDOG, opts || {});
  if (!Array.isArray(frameTimes)) return false;
  const usable = frameTimes.filter((t) => typeof t === 'number' && isFinite(t) && t > 0 && t <= o.maxGapMs);
  if (usable.length < o.minFrames) return false;
  const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
  return avg > o.slowMs;
}

/** Turn a list of rAF timestamps into frame durations (what shouldPauseAmbient takes). */
export function frameDurations(timestamps) {
  const out = [];
  for (let i = 1; i < timestamps.length; i++) out.push(timestamps[i] - timestamps[i - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Which screens get the stage
// ---------------------------------------------------------------------------

/** Every route the router (handleRoute in app.js) renders. test_stage.mjs checks this list against app.js. */
export const ROUTES = [
  'settings', 'help', 'stats', 'study', 'cards', 'leeches', 'reading-toolkit', 'map', 'mind-map',
  'maze', 'document-mind-map', 'motion', 'documents', 'new-card'
];

/** The screen a route shows: the route itself, or Home ('') for the home path and for any path the router does not know. */
export function screenForRoute(route) {
  return ROUTES.includes(route) ? route : '';
}

/*
 * The Map, deck map, document map and Maze are full-canvas screens with their own sky, and Motion Studio
 * has its own player, so the stage is switched off there rather than hidden behind an opaque canvas.
 * Every other screen gets the stage (and so does a path the router does not know: it shows Home).
 */
const STAGE_OFF_ROUTES = new Set(['map', 'mind-map', 'maze', 'document-mind-map', 'motion']);

export function stageWantedOnRoute(route) {
  return !STAGE_OFF_ROUTES.has(screenForRoute(route));
}

/**
 * Screens whose page is a soft sheet on the stage: every stage screen except Home (its cards are the
 * panels) and Study (soft bands around the open card). The sheet is the opaque page colour, so text
 * never sits straight on the stage there (stage.css says why). On a phone it covers the whole stage,
 * so stage.js holds the stage still behind it rather than animate what nobody can see.
 */
export function stageSheetOnRoute(route) {
  const r = screenForRoute(route);
  return stageWantedOnRoute(r) && r !== '' && r !== 'study';
}
