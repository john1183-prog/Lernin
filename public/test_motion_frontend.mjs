// Run with: node --input-type=module test_motion_frontend.mjs
// (from Lernin/public, with the backend running on :8123 and fake-indexeddb installed)
import 'fake-indexeddb/auto';

// motion-api.js registers a window 'online' listener at module load time
// (same as the existing api.js) — a real browser always has `window`
// already; this just stands one up for the Node test environment.
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) =>
  realFetch(typeof url === 'string' && url.startsWith('/') ? `http://localhost:8123${url}` : url, opts);
globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.CustomEvent = class { constructor(name, opts) { this.name = name; this.detail = opts?.detail; } };

const { getMotionClientId, getMotionScripts, saveMotionScript,
        queueMotionGeneration, getQueuedMotionGenerations, clearQueuedMotionGeneration,
        getDB } = await import('./db.js');
const { generateMotion, expandMotionScriptManual, buildMotionManualPrompt } = await import('./motion-api.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    console.log(`  FAIL - ${name} ${detail}`);
    failures++;
  }
}

console.log('=== DB migration ===');
const db = await getDB();
check('motionScripts store exists', db.objectStoreNames.contains('motionScripts'));
check('motionGenQueue store exists', db.objectStoreNames.contains('motionGenQueue'));
check('DB version is 10', db.version === 10, `got ${db.version}`);

console.log('=== client ID ===');
const id1 = await getMotionClientId();
const id2 = await getMotionClientId();
check('client id generated', typeof id1 === 'string' && id1.length > 0);
check('client id stable across calls', id1 === id2, `${id1} vs ${id2}`);

console.log('=== motion script storage ===');
const rec = await saveMotionScript({ topic: 'test topic', script: { scene: {}, layers: [] } });
check('saveMotionScript returns id', !!rec.id);
const all = await getMotionScripts();
check('getMotionScripts finds it', all.some((s) => s.id === rec.id));

console.log('=== offline queue ===');
const qid = await queueMotionGeneration('queued topic');
const queued = await getQueuedMotionGenerations();
check('queueMotionGeneration queues', queued.some((q) => q.topic === 'queued topic'));
await clearQueuedMotionGeneration(qid);
const queuedAfter = await getQueuedMotionGenerations();
check('clearQueuedMotionGeneration removes it', !queuedAfter.some((q) => q.id === qid));

console.log('=== manual prompt port ===');
const prompt = buildMotionManualPrompt('the water cycle');
check('prompt contains topic', prompt.includes('the water cycle'));
check('prompt contains schema rules', prompt.includes('emphasis') && prompt.includes('easing'));

console.log('=== live backend: generateMotion with no creds (expect 401 -> error, not throw) ===');
const result1 = await generateMotion('photosynthesis');
check('no-creds request returns error not throw', result1.error != null, JSON.stringify(result1));
check('no-creds request sent X-Client-Id (server-key path attempted)', result1.status === 401, `status=${result1.status}`);

console.log('=== live backend: expandMotionScriptManual with a valid pasted script ===');
const validScript = {
  scene: { name: 'Manual Test', duration: 4 },
  layers: [{ name: 'box', type: 'rect', width: 50, height: 50, color: '#ff0000' }]
};
const result2 = await expandMotionScriptManual(validScript, 'manual test topic');
check('manual expand succeeds', result2.error === null, JSON.stringify(result2));
check('manual expand returns resolved script', result2.script && result2.script.layers.length === 1);
check('manual expand saved to IndexedDB', !!result2.id);
if (result2.id) {
  const saved = await getMotionScripts();
  check('saved record retrievable', saved.some((s) => s.id === result2.id));
}

console.log('=== live backend: expandMotionScriptManual with an invalid script ===');
const badScript = { scene: { name: 'x' }, layers: [{ name: 'a', type: 'not-a-real-type' }] };
const result3 = await expandMotionScriptManual(badScript, 'bad topic');
check('invalid script returns error, not a throw', result3.error != null, JSON.stringify(result3));
check('invalid script does not return a script', result3.script === null);

console.log('=== BYOK header correctness (never attach X-Client-Id) ===');
const { saveApiConfig, clearApiConfig } = await import('./db.js');
await saveApiConfig({ provider: 'claude', apiKey: 'sk-fake-not-a-real-key' });

let capturedHeaders = null;
const spyFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  capturedHeaders = opts.headers;
  return spyFetch(url, opts);
};

await generateMotion('anything'); // will fail auth against the real API — that's fine, only headers matter here
check('BYOK sets X-LLM-Provider', capturedHeaders['X-LLM-Provider'] === 'claude', JSON.stringify(capturedHeaders));
check('BYOK sets X-LLM-Api-Key', capturedHeaders['X-LLM-Api-Key'] === 'sk-fake-not-a-real-key');
check('BYOK never sets X-Client-Id', !('X-Client-Id' in capturedHeaders), JSON.stringify(capturedHeaders));

await clearApiConfig();
globalThis.fetch = spyFetch;

console.log('=== retryable response shape (mocked — real one only comes from an actual model mistake) ===');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ script: null, retryable: true, error: "layer 'x' is type 'rect' but is missing 'width'." }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  const result = await generateMotion('a topic');
  check('retryable flag surfaces', result.retryable === true, JSON.stringify(result));
  check('error message surfaces', result.error.includes('missing'), result.error);
  check('no script saved on a retryable failure', result.id === null);
  globalThis.fetch = realFetch;
}

console.log('=== retry_of_error is actually sent in the request body ===');
{
  const realFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return realFetch('http://localhost:8123/api/generate-motion', opts);
  };
  await generateMotion('a topic', null, 'a previous error message');
  check('retry_of_error included in request body', capturedBody.retry_of_error === 'a previous error message', JSON.stringify(capturedBody));
  globalThis.fetch = realFetch;
}

console.log('=== live backend: manual mode round-trip with audio cues ===');
{
  const scriptWithAudio = {
    scene: { name: 'Audio Manual Test', duration: 6 },
    markers: [{ name: 'beat', time: 2.0 }],
    layers: [{ name: 'box', type: 'rect', width: 50, height: 50, color: '#00ff00' }],
    audio: [
      { at: { marker: 'beat', offset: 0.3 }, tone: 'pop' },
      { at: { offset: 5.5 }, tone: 'chime' },
    ],
  };
  const result = await expandMotionScriptManual(scriptWithAudio, 'audio cue test');
  check('manual expand with audio succeeds', result.error === null, JSON.stringify(result));
  check('resolved script carries resolved audio cues', Array.isArray(result.script?.audio) && result.script.audio.length === 2, JSON.stringify(result.script?.audio));
  check('audio cue times resolved correctly', result.script?.audio?.[0]?.time === 2.3 && result.script?.audio?.[1]?.time === 5.5, JSON.stringify(result.script?.audio));

  const badAudioScript = {
    scene: { name: 'Bad Audio Test', duration: 4 },
    layers: [{ name: 'box', type: 'rect', width: 50, height: 50 }],
    audio: [{ at: { offset: 1 }, tone: 'not-a-real-tone' }],
  };
  const badResult = await expandMotionScriptManual(badAudioScript, 'bad audio test');
  check('unknown audio tone rejected, not thrown', badResult.error != null, JSON.stringify(badResult));
  check('unknown audio tone error names the bad value', badResult.error.includes('not-a-real-tone'), badResult.error);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
