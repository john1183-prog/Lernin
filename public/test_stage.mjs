// Run with: node public/test_stage.mjs
// Tests for liveliness phase 1 (the stage): the pure stage logic, the motion preferences,
// the seeded scenery, the colour contrast computed from the app's real design tokens, and a few
// drift guards between index.html, stage.css and styles.css.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name} ${detail}`); failures++; }
}

// ---------------------------------------------------------------------------
// 1. Pure stage logic (no DOM)
// ---------------------------------------------------------------------------
const core = await import('./stage-core.js');
const {
  BANDS, timeBand, msUntilNextBand, PALETTE, stagePalette, hillPath, grassPath, starField, seedSpecs, BEAT_MS,
  GRASS_LAYERS, WATCHDOG, shouldPauseAmbient, frameDurations, stageWantedOnRoute, stageSheetOnRoute, screenForRoute, ROUTES
} = core;

console.log('=== time of day ===');
const bandAt = (h) => timeBand(h);
check('05:00 is dawn', bandAt(5) === 'dawn');
check('04:59 is still night', bandAt(4.99) === 'night');
check('07:59 is dawn', bandAt(7.99) === 'dawn');
check('08:00 is day', bandAt(8) === 'day');
check('16:59 is day', bandAt(16.99) === 'day');
check('17:00 is dusk', bandAt(17) === 'dusk');
check('19:59 is dusk', bandAt(19.99) === 'dusk');
check('20:00 is night', bandAt(20) === 'night');
check('00:00 and 03:00 are night', bandAt(0) === 'night' && bandAt(3) === 'night');
check('out-of-range hours wrap (24 -> night, 29 -> dawn, -1 -> night)', bandAt(24) === 'night' && bandAt(29) === 'dawn' && bandAt(-1) === 'night');
check('every hour of the day maps to one of the four bands', Array.from({ length: 24 }, (_, h) => bandAt(h)).every((b) => BANDS.includes(b)));
{
  const counts = {};
  for (let h = 0; h < 24; h++) counts[bandAt(h)] = (counts[bandAt(h)] || 0) + 1;
  check('band lengths are 3 / 9 / 3 / 9 hours', counts.dawn === 3 && counts.day === 9 && counts.dusk === 3 && counts.night === 9, JSON.stringify(counts));
}
{
  const at = (h, m = 0) => new Date(2026, 9, 21, h, m, 0, 0);
  check('next boundary from 04:00 is 05:00 (1 h)', msUntilNextBand(at(4)) === 3600000);
  check('next boundary from 05:00 exactly is 08:00 (3 h), never 0', msUntilNextBand(at(5)) === 3 * 3600000);
  check('next boundary from 12:30 is 17:00 (4.5 h)', msUntilNextBand(at(12, 30)) === 4.5 * 3600000);
  check('next boundary from 21:00 crosses midnight to 05:00 (8 h)', msUntilNextBand(at(21)) === 8 * 3600000);
  let always = true;
  for (let h = 0; h < 24; h++) for (const m of [0, 1, 30, 59]) if (!(msUntilNextBand(at(h, m)) > 0)) always = false;
  check('the next boundary is always in the future', always);
}

console.log('=== scenery is seeded (same on every visit) ===');
{
  const realRandom = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  let threw = false;
  try { hillPath('x', 1440, 420, 150, 46, 18); grassPath('g1', 16, 40, 11, false); starField(); seedSpecs(); } catch (e) { threw = true; }
  Math.random = realRandom;
  check('nothing procedural calls Math.random', !threw);
}
check('same seed, same hills', hillPath('hill-far', 1440, 420, 150, 46, 18) === hillPath('hill-far', 1440, 420, 150, 46, 18));
check('different seed, different hills', hillPath('hill-far', 1440, 420, 150, 46, 18) !== hillPath('hill-near', 1440, 420, 150, 46, 18));
check('same seed, same grass', GRASS_LAYERS.every((g) => grassPath(g.seed, g.minH, g.maxH, g.gap, g.solidBase) === grassPath(g.seed, g.minH, g.maxH, g.gap, g.solidBase)));
check('the three grass layers differ from each other', new Set(GRASS_LAYERS.map((g) => grassPath(g.seed, g.minH, g.maxH, g.gap, g.solidBase))).size === 3);
check('stars and seeds are stable', JSON.stringify(starField()) === JSON.stringify(starField()) && JSON.stringify(seedSpecs()) === JSON.stringify(seedSpecs()));
check('70 stars and 6 seeds by default', starField().length === 70 && seedSpecs().length === 6);
check('hill path is a closed path with no NaN', /^M0 420 L/.test(hillPath('hill-far', 1440, 420, 150, 46, 18)) && !/NaN/.test(hillPath('hill-far', 1440, 420, 150, 46, 18)) && hillPath('hill-far', 1440, 420, 150, 46, 18).endsWith('Z'));
check('grass paths have no NaN', GRASS_LAYERS.every((g) => !/NaN/.test(grassPath(g.seed, g.minH, g.maxH, g.gap, g.solidBase))));
check('seed specs stay in range', seedSpecs().every((s) => s.y >= 12 && s.y <= 64 && s.s >= 14 && s.s <= 26 && s.d >= 46 && s.d <= 86 && s.delay <= 0 && s.delay >= -70));
check('the beat is 50 ms (20 changes a second)', BEAT_MS === 50);
check('every seed crossing is whole 5-second blocks; its quarters, its fades and its start delay are whole beats (so every seed steps on the beat)',
  seedSpecs().every((s) => s.d % 5 === 0 && Number.isInteger(s.n) && Number.isInteger(s.m) && s.n * BEAT_MS === s.d * 250 && s.m * BEAT_MS === s.d * 60 && (s.delay * 1000) % BEAT_MS === 0),
  JSON.stringify(seedSpecs()));
check('the seeds, with their step counts, are still the same on every visit (same seed, same specs)', JSON.stringify(seedSpecs()) === JSON.stringify(seedSpecs()) && seedSpecs().every((s) => s.n > 0 && s.m > 0));

console.log('=== frame watchdog (pure) ===');
check('smooth 60 fps does not pause', shouldPauseAmbient(Array(120).fill(16.7)) === false);
check('steady 40 fps (25 ms) is the line: not above it, so no pause', shouldPauseAmbient(Array(80).fill(25)) === false);
check('steady 30 fps (33 ms) pauses', shouldPauseAmbient(Array(60).fill(33)) === true);
check('a slow phone at 20 fps pauses', shouldPauseAmbient(Array(40).fill(50)) === true);
check('one long stall among smooth frames does not pause (stalls are ignored)', shouldPauseAmbient([...Array(100).fill(16.7), 900, 1200]) === false);
check('too few frames to judge means no pause', shouldPauseAmbient(Array(WATCHDOG.minFrames - 1).fill(100)) === false);
check('exactly the minimum number of slow frames can pause', shouldPauseAmbient(Array(WATCHDOG.minFrames).fill(100)) === true);
check('only stalls (a background tab) means no pause', shouldPauseAmbient(Array(50).fill(2000)) === false);
check('bad input never pauses and never throws', shouldPauseAmbient(null) === false && shouldPauseAmbient(undefined) === false && shouldPauseAmbient('x') === false && shouldPauseAmbient([NaN, -5, 0, Infinity, 'a']) === false);
check('thresholds can be overridden (tuning on a real phone)', shouldPauseAmbient(Array(60).fill(30), { slowMs: 40 }) === false && shouldPauseAmbient(Array(60).fill(30), { slowMs: 20 }) === true);
check('the starting values are the document\'s wording (25 ms, 2 s)', WATCHDOG.slowMs === 25 && WATCHDOG.windowMs === 2000);
check('frameDurations turns timestamps into gaps', JSON.stringify(frameDurations([0, 16, 33, 50])) === JSON.stringify([16, 17, 17]) && frameDurations([5]).length === 0 && frameDurations([]).length === 0);

console.log('=== which screens get the stage ===');
check('Home, Study, lists, Help, Settings and Stats get it', ['', 'settings', 'help', 'stats', 'study', 'cards', 'leeches', 'documents', 'new-card', 'reading-toolkit'].every(stageWantedOnRoute));
check('the Map, deck map, document map, Maze and Motion Studio keep their own sky', ['map', 'mind-map', 'maze', 'document-mind-map', 'motion'].every((r) => !stageWantedOnRoute(r)));
check('an unknown route (the router shows Home) gets the stage', stageWantedOnRoute('nonsense') && stageWantedOnRoute(undefined));
check('an unknown path shows Home, so it is Home to the stage too', screenForRoute('nonsense') === '' && screenForRoute(undefined) === '' && screenForRoute('') === '' && screenForRoute('settings') === 'settings');
check('Settings, Help, Stats, the lists and the forms are sheets', ['settings', 'help', 'stats', 'cards', 'leeches', 'documents', 'new-card', 'reading-toolkit'].every(stageSheetOnRoute));
check('Home, Study, an unknown path and the canvas screens are not sheets', ['', undefined, 'nonsense', 'study', 'map', 'mind-map', 'maze', 'document-mind-map', 'motion'].every((r) => !stageSheetOnRoute(r)));
{
  // the list of routes must be the router's own: a route added to app.js and forgotten here would be treated as Home
  const app = read('app.js');
  const sw = app.match(/switch \(route\) \{([\s\S]*?)default:/);
  const cases = sw ? [...sw[1].matchAll(/case '([a-z-]+)'/g)].map((m) => m[1]).filter((r) => r !== '/') : [];
  const missing = cases.filter((r) => !ROUTES.includes(r));
  const extra = ROUTES.filter((r) => !cases.includes(r));
  check(`stage-core.js lists every route app.js renders (${cases.length} found)`, cases.length >= 14 && missing.length === 0 && extra.length === 0, `missing ${missing} extra ${extra}`);
}

// ---------------------------------------------------------------------------
// 2. Contrast, computed from the app's real tokens in styles.css
// ---------------------------------------------------------------------------
console.log('=== contrast (decoration never lowers contrast) ===');
const css = read('styles.css');
const stageCss = read('stage.css');
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const rootBlock = css.match(/:root\s*\{([^}]*)\}/)[1];
const darkBlock = css.match(/^\[data-theme="dark"\]\s*\{([^}]*)\}/m)[1];
const TOKENS = { light: tokensIn(rootBlock), dark: { ...tokensIn(rootBlock), ...tokensIn(darkBlock) } };

const hex = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgba = (str) => {
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return { rgb: hex(str), a: 1 };
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
};
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const over = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));   // fg (with alpha) over an opaque bg

check('the design tokens parsed (light and dark text colours)', !!TOKENS.light['ink-secondary'] && !!TOKENS.dark['ink-secondary'] && !!TOKENS.light.ink && !!TOKENS.dark.ink);

const MIN = 4.5;
const HEX = /^#[0-9A-Fa-f]{6}$/;
for (const theme of ['light', 'dark']) {
  const ink = hex(TOKENS[theme].ink);
  let worst = Infinity, worstWhere = '';
  for (const band of BANDS) {
    const p = PALETTE[theme][band];
    check(`${theme}/${band} has every field, with real colours`, ['top', 'bot', 'sun', 'sx', 'sy', 'far', 'near', 'grass', 'seed', 'stars'].every((k) => p[k] !== undefined) && ['top', 'bot', 'far', 'near', 'grass'].every((k) => HEX.test(p[k])) && /^rgba\(/.test(p.sun) && /^rgba\(/.test(p.seed));
    // The net. No text is meant to sit on the bare stage (the panel checks below and the browser audit
    // see to that), but if a heading were ever missed, the primary ink still has to read on every layer
    // and under the glow. (Seeds are small shapes and are left out.)
    const top = hex(p.top), bot = hex(p.bot);
    const where = [];
    for (const k of ['top', 'bot', 'far', 'near', 'grass']) where.push([`${band} ${k}`, hex(p[k])]);
    where.push([`${band} sun glow over top`, over(rgba(p.sun), top)], [`${band} sun glow over bottom`, over(rgba(p.sun), bot)]);
    for (const [name, bg] of where) { const r = ratio(ink, bg); if (r < worst) { worst = r; worstWhere = `${theme} ${name}`; } }
  }
  check(`${theme}: primary ink keeps ${MIN}:1 on every backdrop colour, as a net (worst ${worst.toFixed(2)}: ${worstWhere})`, worst >= MIN);
}
check('the light palette is lighter than the dark one on every band (the stage follows the theme)', BANDS.every((b) => lum(hex(PALETTE.light[b].top)) > lum(hex(PALETTE.dark[b].top)) && lum(hex(PALETTE.light[b].far)) > lum(hex(PALETTE.dark[b].far))));

check('stagePalette falls back to light/day for unknown input', stagePalette(false, 'nope') === PALETTE.light.day && stagePalette(true, 'nope') === PALETTE.dark.day);
check('stars appear only in the dark theme', BANDS.every((b) => PALETTE.light[b].stars === 0) && PALETTE.dark.night.stars === 1);

// ---- text sits on opaque panels, so it has exactly the contrast it has on the plain page ----
console.log('=== text on opaque panels ===');
{
  check('the sheet is the opaque page colour (--sheet: var(--bg))', /html\[data-stage="on"\]\s*\{\s*--sheet:\s*var\(--bg\);\s*\}/.test(stageCss));
  check('no stage rule makes a panel translucent (no color-mix, no rgba page colour)', !/color-mix\(/.test(stageCss));
  // what the stage cannot fix: text colours that are already under 4.5:1 on the plain page (reported, not caused here)
  for (const theme of ['light', 'dark']) {
    const bg = hex(TOKENS[theme].bg);
    const already = ['ink-secondary', 'ink-muted', 'accent', 'danger'].map((t) => [t, ratio(hex(TOKENS[theme][t]), bg)]).filter(([, r]) => r < MIN);
    console.log(`  info - ${theme}: text colours already under ${MIN}:1 on the page colour today (not caused by the stage): ${already.map(([t, r]) => `${t} ${r.toFixed(2)}`).join(', ') || 'none'}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Drift guards: the files that have to agree
// ---------------------------------------------------------------------------
console.log('=== drift guards ===');
{
  // every animated property in stage.css is transform or opacity (decision: cheap by construction)
  const bad = [];
  for (const m of stageCss.matchAll(/@keyframes\s+([a-z0-9-]+)\s*\{([\s\S]*?)\n\}/g)) {
    for (const d of m[2].matchAll(/([a-z-]+)\s*:/g)) {
      if (!['transform', 'opacity'].includes(d[1])) bad.push(`${m[1]}:${d[1]}`);
    }
  }
  check('stage keyframes animate only transform and opacity', bad.length === 0, bad.join(', '));
  check('stage.css has the six keyframe sets (glow, twinkle, hill drift, grass sway, the seeds\' path and their fade)', (stageCss.match(/@keyframes/g) || []).length === 6);
  {
    // the cost rule: nothing on the stage moves smoothly, and every step is a whole number of 50 ms beats
    const parts = [];
    for (const m of stageCss.matchAll(/(?:^|[;{\s])animation:\s*([^;{}]*);/g)) {
      const v = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (/^none\b/.test(v)) continue;                       // the Calm and reduced-motion rules switch animations off
      let depth = 0, cur = '';
      for (const ch of v) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
      }
      parts.push(cur.trim());
    }
    const ms = (p) => [...p.replace(/steps\([^)]*\)/g, '').matchAll(/(-?\d*\.?\d+)(ms|s)\b/g)].map((t) => Math.round(parseFloat(t[1]) * (t[2] === 's' ? 1000 : 1)));
    check('the stage runs nine animations (glow, twinkle, two hills, three grass layers, a seed\'s path and its fade)', parts.length === 9, String(parts.length));
    check('every stage animation steps: none is smooth (smooth motion redraws the screen on every frame)', parts.length > 0 && parts.every((p) => /steps\(/.test(p) && !/\b(ease|ease-in|ease-out|ease-in-out|linear)\b|cubic-bezier/.test(p)), parts.filter((p) => !/steps\(/.test(p)).join(' | '));
    const literal = parts.filter((p) => /steps\(\d+/.test(p));
    check('seven of them have their step counts written out here', literal.length === 7, String(literal.length));
    const offBeat = literal.filter((p) => {
      const k = +p.match(/steps\((\d+)/)[1];
      const [dur, delay = 0] = ms(p);
      return !(dur > 0 && dur % (k * BEAT_MS) === 0 && delay % BEAT_MS === 0);
    });
    check('every one of those steps lasts a whole number of beats (and starts on one), so all the layers change in the same frames', offBeat.length === 0, offBeat.join(' | '));
    const seedParts = parts.filter((p) => /steps\(var\(/.test(p));
    check('a seed\'s path steps --n times a quarter and its fade --m times, the counts seedSpecs works out in whole beats', seedParts.length === 2 && /^stage-seed var\(--d\) steps\(var\(--n\), end\) var\(--delay\) infinite$/.test(seedParts[0]) && /^stage-seed-fade var\(--d\) steps\(var\(--m\), end\) var\(--delay\) infinite$/.test(seedParts[1]), seedParts.join(' | '));
    check('stage.js writes those counts (--n and --m) on every seed', /--n:' \+ s\.n/.test(read('stage.js')) && /--m:' \+ s\.m/.test(read('stage.js')));
    const kf = (name) => (stageCss.match(new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}')) || [])[1] || '';
    const offsets = (body) => [...body.matchAll(/(\d+)%\s*\{/g)].map((x) => +x[1]).join(',');
    check('the seeds\' path is four equal quarters (0, 25, 50, 75, 100 %), so --n beats a quarter holds for every quarter, and it moves nothing but transform', offsets(kf('stage-seed')) === '0,25,50,75,100' && !/opacity/.test(kf('stage-seed')), offsets(kf('stage-seed')));
    check('the seeds\' fade is 6 % in and 6 % out (0, 6, 94, 100 %), the share the --m count is worked out for, and it moves nothing but opacity', offsets(kf('stage-seed-fade')) === '0,6,94,100' && !/transform/.test(kf('stage-seed-fade')), offsets(kf('stage-seed-fade')));
  }
  check('Calm and OS reduced motion both switch the stage animations off', /html\[data-calm="1"\] #stage[^{]*\{[^}]*animation:\s*none/.test(stageCss) && /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/.test(stageCss));
  check('the stage holds still (paused, not hidden) when marked paused', /#stage\[data-paused\][^{]*\{[^}]*animation-play-state:\s*paused/.test(stageCss));
  check('text screens sit on the sheet: every #root wrapper except the study layer gets it', /html\[data-stage="on"\] #root:not\(\.study-session\) > div:not\(\.study-session\)\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss));
  check('the title bar and the study bands are soft panels', /html\[data-stage="on"\] \.app-header\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss) && /\.study-header,\s*html\[data-stage="on"\] \.study-context-bar,\s*html\[data-stage="on"\] \.study-controls\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss));
  check('the loose text on Home (the Your Decks title, the archived toggle, the empty state) sits on soft panels', /\.home-column \.deck-section-title\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss) && /\.home-column \.archived-decks-toggle\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss) && /\.home-column \.empty-state\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss));
  check('the archived-deck list (its tiles are drawn at 72 % opacity) sits on a soft panel', /\.home-column \.archived-deck-list\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss) && /\.deck-tile\.is-archived\s*\{[^}]*opacity:\s*0\.72/.test(css));
  check('the centred messages in a study session and its summary sit on soft panels', /\.study-session > \.empty-state,\s*html\[data-stage="on"\] \.session-summary\s*\{[^}]*background:\s*var\(--sheet\)/.test(stageCss));
  // the stage paints over the canvas background, which comes from <body> (propagated to the canvas because <html> has none):
  // the day <html> or :root gets a background of its own, that background covers the stage and it silently disappears
  const rootBlocks = [];
  for (const src of [css, stageCss]) for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:html|:root|\[data-theme="[a-z]+"\])[ \t]*\{([^}]*)\}/g)) rootBlocks.push(m[1]);
  check('no html or :root rule sets a background (it would hide the stage)', rootBlocks.length >= 3 && !rootBlocks.some((b) => /(^|[;\s])background(-color|-image)?\s*:/.test(b)), rootBlocks.length);
  check('body keeps the page colour (var(--bg)) that the stage and the panels are built around', /\nbody\s*\{[^}]*background:\s*var\(--bg\)/.test(css));
  check('the phone-width pause in stage.js uses the same breakpoint as the sheet in stage.css', /\(max-width: 759px\)/.test(read('stage.js')) && /@media \(min-width: 760px\)/.test(stageCss));
  check('on a phone the sheet ends in a soft rounded edge (the same 759 px breakpoint)', /@media \(max-width: 759px\)\s*\{[^@]*#root:not\(\.study-session\) > div:not\(\.app-header\):not\(\.study-session\)\s*\{[^}]*border-radius:\s*0 0 var\(--radius-lg\) var\(--radius-lg\)/.test(stageCss));
  // the study pause follows what #root holds, not only the /study route ("Study this card" mounts a session under /cards/...)
  const stageSrc = read('stage.js'), studySrc = read('study.js'), appSrc = read('app.js');
  check('stage.js watches #root for a study session (class on #root, or a .study-session child)', /new MutationObserver\(syncStudyPause\)\.observe\(rootEl,\s*\{[^}]*childList:\s*true[^}]*attributeFilter:\s*\['class'\]/.test(stageSrc) && /classList\.contains\('study-session'\)/.test(stageSrc) && /:scope > \.study-session/.test(stageSrc));
  check('study.js still marks a session the way stage.js looks for it (target.className = study-session; empty states wrap .study-session)', /target\.className = 'study-session'/.test(studySrc) && /<div class="study-session"/.test(studySrc));
  check('the only places that mount a session on #root are the /study route and "Study this card" (both covered)', (appSrc.match(/startStudySession\(root,/g) || []).length === 2);
  // the in-app Help describes the backdrop and Calm, and names the switch exactly as Settings labels it
  const label = (appSrc.match(/document\.createTextNode\('\s*([^']*\(Calm\))'\)/) || [])[1];
  check('Settings has the Calm switch labelled "Keep things still (Calm)"', label === 'Keep things still (Calm)', label);
  check('Help has a "The backdrop and Calm" section that names the switch the way Settings does', /title: 'The backdrop and Calm'/.test(appSrc) && appSrc.split('Keep things still (Calm)').length - 1 >= 3);
  check('Help has the FAQ entry about turning the backdrop off', /q: 'Can I turn the moving backdrop off\?'/.test(appSrc));
}
{
  // the Calm block in styles.css mirrors the prefers-reduced-motion block next to it
  const osBlock = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/);
  const calmBlock = css.match(/\[data-calm="1"\] \*,\s*\[data-calm="1"\] \*::before,\s*\[data-calm="1"\] \*::after\s*\{([^}]*)\}/);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  check('styles.css has the reduced-motion block and its Calm mirror', !!osBlock && !!calmBlock);
  check('the Calm block says exactly what the reduced-motion block says', !!osBlock && !!calmBlock && norm(osBlock[1]) === norm(calmBlock[1]));
  check('the Help animations are mirrored for Calm too', /\[data-calm="1"\] \.help-view/.test(css) && /\[data-calm="1"\] \.help-closer/.test(css));
}
{
  const html = read('index.html');
  check('index.html mounts #stage before #root, hidden from assistive tech', /<div id="stage" aria-hidden="true"><\/div>\s*<div id="root">/.test(html));
  check('index.html links stage.css after styles.css', html.indexOf('/styles.css') > 0 && html.indexOf('/stage.css') > html.indexOf('/styles.css'));
  check('the boot script reads the same Calm key motion-pref.js writes', html.includes("localStorage.getItem('lernin-calm')"));
}
{
  const mp = await import('./motion-pref.js');
  check('CALM_STORAGE_KEY is lernin-calm (index.html reads it before first paint)', mp.CALM_STORAGE_KEY === 'lernin-calm');
}
for (const f of ['stage.js', 'stage-core.js', 'motion-pref.js']) {
  const src = read(f);
  check(`${f} never uses Math.random`, !/Math\.random\s*\(/.test(src));
  check(`${f} never imports app.js`, !/from\s+['"]\.\/app\.js['"]/.test(src));
}
check('motion-pref.js imports nothing', !/^\s*import\s/m.test(read('motion-pref.js')));
check('stage-core.js imports only motion-pref.js', (read('stage-core.js').match(/^\s*import\s[^;]*from\s+'([^']+)'/gm) || []).every((l) => l.includes("'./motion-pref.js'")));
check('canvas.js still never imports app.js', !/from\s+['"]\.\/app\.js['"]/.test(read('canvas.js')));
check('canvas.js imports motion-pref.js (allowed: it imports nothing)', /from '\.\/motion-pref\.js'/.test(read('canvas.js')));

// ---------------------------------------------------------------------------
// 4. motion-pref.js with a fake browser: Calm, hidden tab, and the loop
// ---------------------------------------------------------------------------
console.log('=== motion preferences and the loop (fake browser) ===');
{
  const handlers = {};
  const attrs = {};
  let reduce = false;
  const mqHandlers = [];
  const store = {};
  const rafQueue = [];
  globalThis.document = {
    hidden: false,
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] },
    addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    removeEventListener: (t, f) => { handlers[t] = (handlers[t] || []).filter((x) => x !== f); }
  };
  globalThis.window = {
    matchMedia: () => ({ get matches() { return reduce; }, addEventListener: (t, f) => mqHandlers.push(f) })
  };
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  globalThis.requestAnimationFrame = (f) => { rafQueue.push(f); return rafQueue.length; };
  globalThis.cancelAnimationFrame = (id) => { rafQueue[id - 1] = null; };
  const runFrame = (t) => { const f = rafQueue.shift(); if (f) f(t); return !!f; };
  const pending = () => rafQueue.filter(Boolean).length;
  const fireVisibility = () => (handlers.visibilitychange || []).forEach((f) => f());
  const fireOs = () => mqHandlers.forEach((f) => f());

  const mp = await import('./motion-pref.js?fake=1');

  check('Calm starts off', mp.isCalm() === false && mp.isCalmManual() === false && mp.ambientAllowed() === true);
  mp.setCalm(true);
  check('the Calm switch puts data-calm="1" on <html> and caches it', attrs['data-calm'] === '1' && store['lernin-calm'] === '1' && mp.isCalm() && mp.isCalmManual());
  check('Calm freezes the ambient clock at 0', mp.ambientNow() === 0);
  mp.setCalm(false);
  check('switching Calm off clears it', attrs['data-calm'] === '0' && store['lernin-calm'] === '0' && !mp.isCalm() && mp.ambientNow() > 1e12);
  reduce = true; fireOs();
  check('the OS reduce-motion setting alone makes it calm (switch still off)', mp.isCalm() && !mp.isCalmManual() && attrs['data-calm'] === '1');
  mp.initCalm(false);
  check('initCalm(false) with OS reduce on stays calm', mp.isCalm() && attrs['data-calm'] === '1');
  reduce = false; fireOs();
  check('OS setting off again: calm is off', !mp.isCalm() && attrs['data-calm'] === '0');
  mp.initCalm(true);
  check('initCalm(true) adopts a stored switch and keeps the cache in step', mp.isCalm() && store['lernin-calm'] === '1');
  mp.setCalm(false);
  check('calmFrom is a plain OR', mp.calmFrom(false, false) === false && mp.calmFrom(true, false) && mp.calmFrom(false, true) && mp.calmFrom(true, true));

  // subscriptions
  let calls = 0;
  const off = mp.onCalm(() => { calls++; });
  mp.setCalm(true); mp.setCalm(false);
  off(); mp.setCalm(true); mp.setCalm(false);
  check('onCalm notifies until it is unsubscribed', calls === 2);
  let amb = [];
  const offAmb = mp.onAmbientChange((a) => amb.push(a));
  document.hidden = true; fireVisibility();
  document.hidden = false; fireVisibility();
  mp.setCalm(true); mp.setCalm(false);
  offAmb();
  check('onAmbientChange follows a hidden tab and Calm (false, true, false, true)', JSON.stringify(amb) === JSON.stringify([false, true, false, true]), JSON.stringify(amb));
  check('unsubscribing removes the visibility listener', (handlers.visibilitychange || []).length === 0);

  // the loop
  let drawn = 0;
  const loop = mp.createLoop(() => { drawn++; }, { fps: 60 });
  check('nothing is scheduled before start()', pending() === 0);
  loop.start();
  check('start() schedules one frame', pending() === 1);
  runFrame(100); runFrame(120); runFrame(140);
  check('frames draw and keep going', drawn === 3 && pending() === 1, `drawn ${drawn}`);
  mp.setCalm(true);
  runFrame(160);
  check('Calm: the next frame draws nothing and schedules nothing', drawn === 3 && pending() === 0, `drawn ${drawn} pending ${pending()}`);
  mp.setCalm(false);
  check('Calm off: the loop restarts by itself', pending() === 1);
  document.hidden = true; fireVisibility();
  runFrame(200);
  check('a hidden tab stops the loop', pending() === 0 && drawn === 3);
  document.hidden = false; fireVisibility();
  check('a visible tab resumes it', pending() === 1);
  loop.stop();
  check('stop() cancels the pending frame', pending() === 0);
  mp.setCalm(true);
  const before = drawn;
  loop.kick();
  check('kick() still draws one frame in Calm (a still scene stays correct) and schedules nothing', drawn === before + 1 && pending() === 0);
  mp.setCalm(false);
  check('a stopped loop stays stopped when Calm turns off', pending() === 0);

  // fps cap
  let slow = 0;
  const l30 = mp.createLoop(() => { slow++; }, { fps: 30 });
  l30.start();
  for (let t = 1000; t < 1000 + 17 * 12; t += 17) runFrame(t);
  l30.dispose();
  check('a 30 fps loop skips frames on a 60 Hz screen (about half drawn)', slow >= 5 && slow <= 7, `drew ${slow} of 12`);
  check('dispose() leaves nothing pending', pending() === 0);
}

// ---------------------------------------------------------------------------
// 5. Seeded helpers
// ---------------------------------------------------------------------------
console.log('=== seeded helpers ===');
{
  const { hash, rng } = await import('./motion-pref.js');
  check('hash is stable and in [0,1)', hash('deck-1') === hash('deck-1') && hash('deck-1') >= 0 && hash('deck-1') < 1);
  check('hash separates keys that differ in the last letter', new Set(['n1', 'n2', 'n3', 'n4', 'n5'].map(hash)).size === 5);
  const a = rng('seed'), b = rng('seed'), c = rng('other');
  const sa = [a(), a(), a(), a()], sb = [b(), b(), b(), b()], sc = [c(), c(), c(), c()];
  check('rng gives the same sequence for the same seed', JSON.stringify(sa) === JSON.stringify(sb));
  check('rng gives a different sequence for another seed', JSON.stringify(sa) !== JSON.stringify(sc));
  const r = rng('range'); let inRange = true, sum = 0;
  for (let i = 0; i < 2000; i++) { const v = r(); sum += v; if (!(v >= 0 && v < 1)) inRange = false; }
  check('rng stays in [0,1) and is roughly uniform (mean near 0.5)', inRange && Math.abs(sum / 2000 - 0.5) < 0.05, `mean ${(sum / 2000).toFixed(3)}`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
