// Run with: node public/test_shell_assets.mjs
// The service worker installs its shell with cache.addAll(), which fails the WHOLE install if one
// path 404s, and the app then cannot start offline. So: every path on SHELL_ASSETS must exist, and
// every module the app imports (statically or by a literal dynamic import) must be on the list.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { console.log(`  FAIL - ${name} ${detail}`); failures++; }
}

const sw = read('sw.js');
const listSrc = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
check('SHELL_ASSETS found in sw.js', !!listSrc);
const assets = [...listSrc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('the list is not empty', assets.length > 20, `got ${assets.length}`);
check('no path is listed twice', new Set(assets).size === assets.length, assets.filter((a, i) => assets.indexOf(a) !== i).join(', '));

console.log('=== every listed path exists in public/ ===');
const missing = assets.filter((a) => a !== '/' && !existsSync(join(here, a.replace(/^\//, ''))));
check('every SHELL_ASSETS path exists', missing.length === 0, missing.join(', '));
check("'/' is covered by index.html", assets.includes('/') && assets.includes('/index.html') && existsSync(join(here, 'index.html')));

console.log('=== every module the app loads is on the list ===');
function localImports(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/(?:^|[\s;])import\s+(?:[^'"()]*?\sfrom\s+)?['"](\.\/[^'"]+)['"]/gm)) out.add(m[1]);
  for (const m of src.matchAll(/(?:^|[\s;(=])export\s+[^'"()]*?\sfrom\s+['"](\.\/[^'"]+)['"]/gm)) out.add(m[1]);
  for (const m of src.matchAll(/import\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out].map((r) => resolve(dirname(file), r.split('?')[0]));
}
const seen = new Set();
const queue = [join(here, 'app.js')];
while (queue.length) {
  const f = queue.pop();
  if (seen.has(f) || !existsSync(f) || !f.endsWith('.js')) continue;
  seen.add(f);
  for (const dep of localImports(f)) queue.push(dep);
}
const reachable = [...seen].map((f) => '/' + relative(here, f).split('\\').join('/'));
check('the import walk reached the app\'s modules', reachable.length > 20, `reached ${reachable.length}`);
const unlisted = reachable.filter((r) => !assets.includes(r));
check('every module reachable from app.js is on SHELL_ASSETS', unlisted.length === 0, unlisted.join(', '));

console.log('=== the stage (liveliness phase 1) ===');
for (const f of ['/stage.css', '/stage.js', '/stage-core.js', '/motion-pref.js']) {
  check(`${f} is on the shell list`, assets.includes(f));
}
const html = read('index.html');
const linkedCss = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/[^"]+)"/g)].map((m) => m[1]);
const ownCss = linkedCss.filter((h) => !h.startsWith('/vendor/'));
check('every stylesheet index.html links from this app is on the list', ownCss.every((h) => assets.includes(h)), ownCss.filter((h) => !assets.includes(h)).join(', '));

console.log('=== the cache version ===');
const ver = sw.match(/const CACHE_VERSION = 'lernin-shell-v(\d+)'/);
check('CACHE_VERSION has the lernin-shell-vN form', !!ver);
check('CACHE_VERSION is at least v38 (the stage release)', !!ver && Number(ver[1]) >= 38, ver ? `v${ver[1]}` : '');

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
