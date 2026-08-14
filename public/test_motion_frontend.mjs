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
check('DB version is 9', db.version === 9, `got ${db.version}`);

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
