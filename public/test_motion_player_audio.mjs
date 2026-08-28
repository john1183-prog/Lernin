// Run with: node --input-type=module test_motion_player_audio.mjs
// (from Lernin/public — no backend, no fake-indexeddb needed)
//
// Exercises motion-player.js's audio-cue scheduling in isolation: cues
// (already-resolved {time, tone} pairs, exactly expand_script()'s output
// shape) fire once each, in order, only as real-time forward playback
// crosses them — never as a side effect of seeking, and correctly
// re-armed across a loop wrap or a backward seek. Uses minimal in-memory
// canvas/DOM mocks and a manually-driven requestAnimationFrame so the
// whole thing runs in plain Node with no browser.

function makeEl(tag) {
  const el = {
    tagName: tag,
    style: {},
    children: [],
    parentElement: null,
    appendChild(child) { el.children.push(child); child.parentElement = el; return child; },
    remove() {
      if (!el.parentElement) return;
      const i = el.parentElement.children.indexOf(el);
      if (i >= 0) el.parentElement.children.splice(i, 1);
    },
    getBoundingClientRect() { return { width: 800, height: 500 }; },
    getContext(type) {
      if (type !== '2d') return null;
      return {
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        closePath() {}, fill() {}, stroke() {}, arc() {}, arcTo() {}, fillText() {},
        measureText() { return { width: 10 }; },
        fillStyle: '#fff', strokeStyle: '#fff', globalAlpha: 1,
        font: '', textAlign: '', textBaseline: '', lineWidth: 1,
      };
    },
  };
  return el;
}

globalThis.document = { createElement: (tag) => makeEl(tag) };
globalThis.getComputedStyle = () => ({ position: 'static' });
globalThis.ResizeObserver = class { observe() {} };
globalThis.window = {}; // no window.katex -- formula layers fall back to textContent, fine here

let rafCallback = null;
globalThis.requestAnimationFrame = (cb) => { rafCallback = cb; return 1; };
globalThis.cancelAnimationFrame = () => { rafCallback = null; };

const { createPlayer } = await import('./motion-player.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name} ${detail}`); failures++; }
}

function makeScript(overrides = {}) {
  return {
    scene: { name: 'Test', duration: 4, width: 800, height: 500, background: '#161616' },
    camera: null,
    layers: [{ name: 'box', type: 'rect', width: 50, height: 50, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, color: '#fff', keyframes: {} }],
    audio: [
      { time: 0.5, tone: 'tick' },
      { time: 2.0, tone: 'pop' },
      { time: 3.5, tone: 'chime' },
    ],
    ...overrides,
  };
}

function makeCanvas() {
  const canvas = makeEl('canvas');
  canvas.parentElement = makeEl('div');
  return canvas;
}

console.log('=== forward playback fires cues once each, in order ===');
{
  const fired = [];
  const canvas = makeCanvas();
  const player = createPlayer(canvas, makeScript(), { onAudioCue: (tone, time) => fired.push([tone, time]) });

  player.play();
  rafCallback(0);       // first frame just establishes lastTs, no dt yet
  rafCallback(600);     // t=0.6 -> crosses tick@0.5
  check('tick fires once crossing 0.6s', fired.length === 1 && fired[0][0] === 'tick', JSON.stringify(fired));

  rafCallback(2200);    // t=2.2 -> crosses pop@2.0
  check('pop fires next crossing 2.2s', fired.length === 2 && fired[1][0] === 'pop', JSON.stringify(fired));
  check('cues stay in ascending time order', fired[0][1] < fired[1][1]);
}

console.log('=== seeking never fires a cue, but re-arms cues after the seek point ===');
{
  const fired = [];
  const canvas = makeCanvas();
  const player = createPlayer(canvas, makeScript(), { onAudioCue: (tone) => fired.push(tone) });

  player.play();
  rafCallback(0);
  rafCallback(2200); // fires tick, pop
  player.pause();
  check('two cues fired before seek', fired.length === 2, JSON.stringify(fired));

  player.seek(1.0); // seeks back to before pop -- must not fire anything itself
  check('seek() itself fires nothing', fired.length === 2, JSON.stringify(fired));

  player.play();
  rafCallback(3000);
  rafCallback(5200); // t = 1.0 + 2.2 = 3.2 -> re-crosses pop@2.0
  check('pop re-fires after a backward seek past it', fired.length === 3 && fired[2] === 'pop', JSON.stringify(fired));
}

console.log('=== a cue is never double-fired within one forward pass ===');
{
  const fired = [];
  const canvas = makeCanvas();
  const player = createPlayer(canvas, makeScript(), { onAudioCue: (tone) => fired.push(tone) });

  player.play();
  rafCallback(0);
  rafCallback(600);  // crosses tick
  rafCallback(650);  // tiny advance, still past tick, must not refire
  const tickCount = fired.filter((t) => t === 'tick').length;
  check('tick fires exactly once despite multiple frames past it', tickCount === 1, JSON.stringify(fired));
}

console.log('=== looping (default) rearms all cues on wrap ===');
{
  const fired = [];
  const canvas = makeCanvas();
  const player = createPlayer(canvas, makeScript()); // no onAudioCue -- must not throw
  const player2 = createPlayer(canvas, makeScript(), { onAudioCue: (tone) => fired.push(tone) });

  player2.play();
  rafCallback(0);
  rafCallback(4500); // one big jump past duration -> fires all three cues on the way, then wraps to t=0
  check('all three cues fire once each before the wrap', fired.length === 3 && fired.includes('chime'), JSON.stringify(fired));

  rafCallback(5100); // now playing from t=0 again (0.6s elapsed) -> re-crosses tick
  check('tick re-fires after the loop wraps', fired.filter((t) => t === 'tick').length === 2, JSON.stringify(fired));

  check('player with no onAudioCue does not throw when cues cross', true);
  player.destroy();
  player2.destroy();
}

console.log('=== loop: false stops at duration and does not rearm ===');
{
  const fired = [];
  const canvas = makeCanvas();
  const player = createPlayer(canvas, makeScript(), { loop: false, onAudioCue: (tone) => fired.push(tone) });

  player.play();
  rafCallback(0);
  rafCallback(4500); // crosses all three cues on the way to/past duration
  check('all three cues fire once each by the end', fired.length === 3, JSON.stringify(fired));
  check('playback clamps at duration, not past it', player.currentTime === player.duration);
}

console.log('=== a script with no audio field plays fine (backwards compatible) ===');
{
  const canvas = makeCanvas();
  const script = makeScript();
  delete script.audio;
  let threw = false;
  try {
    const player = createPlayer(canvas, script, { onAudioCue: () => {} });
    player.play();
    rafCallback(0);
    rafCallback(600);
    player.destroy();
  } catch (e) {
    threw = true;
  }
  check('missing script.audio does not throw', !threw);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
