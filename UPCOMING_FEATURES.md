# Lernin — Upcoming Features

A running backlog of everything discussed but not yet (fully) built, kept
in the repo so context survives between sessions. When we pick something
up, move it to "In progress," and once shipped, move it to
`BUILD_GUIDE.md`'s history or just delete the entry — this file is meant
to stay a live backlog, not an append-only log.

Priority tiers reflect my honest read of value-vs-effort, not the order
things were requested in. Re-order freely — these are recommendations,
not a queue.

---

## Tier 1 — High value, no architectural prerequisites

These can each be picked up independently, in any order.

---

### Motion Studio — backend, player, and frontend plumbing built and verified; bare harness works, no real UI yet

Manim-style, LLM-driven motion-graphics generator: describe a study
topic, get a short animated explainer. Scoped as the single most
valuable feature in the app.

**Backend** (`api/motion_schema.py`, `api/motion_engine.py`, routes in
`api/index.py`) **and the canvas player** (`public/motion-player.js`)
are built and verified: 18 passing unit tests on the expansion engine,
live HTTP tests against both routes (BYOK/server-key/manual-mode
credential resolution, quota, error translation), and headless-Chrome
screenshot verification against a resolved 11-layer test scene —
shapes, group/parent nesting, camera pan/zoom, an arrow, a KaTeX
formula caption. That pass caught and fixed a real bug: `drawLayer()`'s
`ctx.restore()` ran before a layer's children were drawn, so group
nesting was silently broken (confirmed visually — a group's children
rendered off-canvas — then fixed and re-verified pixel-accurate against
hand-calculated positions).

**Frontend plumbing** is now built too: an anonymous per-device client
ID (`getMotionClientId()` in `db.js`, `settings` store) sent only on
server-key-quota requests, never on BYOK ones; two new IndexedDB stores
(`motionScripts`, `motionGenQueue` — `DB_VERSION` bumped to 9) for
resolved scripts and an offline retry queue, kept as their own store
rather than folding into the existing `genQueue` since that store's
record shape is card-generation-specific; `public/motion-api.js`
mirroring `api.js`'s BYOK/offline-queue/CustomEvent pattern exactly;
and a manual-mode paste-back flow (`public/motion-manual-import.js`)
mirroring `manual-json-import.js`'s UI pattern. Its JSON-repair parser
was extracted into a new dependency-free `public/json-repair.js` in the
process — the parser was generic ("pull JSON out of arbitrary AI-pasted
text") but `manual-json-import.js` also imports `app.js` for
`renderMath`/`showToast`, and that import was firing `app.js`'s
top-level SPA routing as a side effect on pages that don't have that
DOM, which the motion harness below caught as a real console error.

**`public/motion-test.html`** is the bare test harness the roadmap
called for — deliberately not real UI, just a topic box, a canvas, and
play/seek controls, verified end-to-end with headless Chrome: topic
entry → 401 with no key configured → manual-mode fallback renders →
pasted JSON validates → resolves → plays (KaTeX overlay scaling
confirmed correct once the canvas got proper responsive CSS, which it
was missing at first — the overlay's scale math already assumed a
CSS-stretched canvas, so this was a real gap, not just cosmetic) →
saves to the scripts list → replayable.

**Real deployment bug found after this actually shipped to production,
and it took two attempts to actually fix:** the first live generation
on the deployed site 500'd with no useful detail. Vercel's Runtime Logs
showed the real error: `ModuleNotFoundError: No module named
'motion_schema'`. `api/index.py`'s `from motion_schema import ...` /
`from motion_engine import ...` are the *first* same-directory
local-file imports anywhere in this project — everything else
index.py imports is a pip package — so this class of bug had never
been hit before.

First attempt: an explicit `includeFiles` glob in `vercel.json`. This
was the wrong fix, confirmed the hard way — same exact error on the
next deploy. Vercel's own docs say Python functions bundle every
reachable file by default (no tree-shaking), so the files were
probably never missing from the bundle in the first place;
`includeFiles` controls what's *included in the deployment*, not
what's on Python's `sys.path`, and the second deploy proved those are
different problems.

Second attempt, the real fix: the traceback shows Vercel's own runtime
(`vc_init.py`) loads `index.py` via `importlib.import_module()` —
dynamic loading, not running it as a script. That distinction matters:
a normally-run script gets its own directory auto-added to
`sys.path`; a dynamically-loaded module doesn't. So `motion_schema.py`
could be sitting right next to `index.py` in the deployed bundle and
still be unimportable, because its directory was simply never on the
path. Fixed with an explicit `sys.path.insert(0, ...)` for this file's
own directory before the sibling imports. Verified locally (not just
theorized) by reproducing Vercel's exact loading mechanism —
`importlib.util.spec_from_file_location` + `exec_module`, from a clean
subprocess with the real project layout — which reproduced the
identical `ModuleNotFoundError` against the unfixed code and resolved
cleanly against the fixed version.

Also hardened both motion routes in the same pass: credential
resolution used to sit outside the route's try/except entirely, so a
crash there produced no detail message at all — now the whole route
body is wrapped, logged server-side, and (temporarily, while this is
pre-launch) the exception itself rides along in the response so it's
visible without needing dashboard access.

**Third round, past the import error entirely, a different pre-existing
bug:** `RuntimeError: Form data requires "python-multipart" to be
installed`, crashing on `/api/generate-cards-vision` (not a Motion
Studio route — this predates it) at module-import time, since any
`File`/`Form`/`UploadFile` route parameter triggers FastAPI's multipart
check as soon as the route decorator runs. `python-multipart` was
missing from `requirements.txt` the whole time; local dev sessions
never caught it because it kept getting `pip install`ed directly into
whatever sandbox was open at the time, as a "make uvicorn run" fix,
without ever being added to the one file that actually determines what
Vercel installs. Same failure mode as the sys.path bug, different
mechanism: something worked locally for reasons that don't hold in the
actual deployment environment. Fixed by adding it to `requirements.txt`
and, this time, verifying the fix in a genuinely clean virtualenv with
*only* `requirements.txt` installed — no uvicorn, no leftover manual
installs from earlier in a session — confirming all 5 routes register
and the two that need multipart parsing actually work.

**Pattern worth remembering across all three of these:** a sandbox
that's been worked in for a while accumulates fixes that never make it
into a committed file (a missing pip install, a stale local server).
Vercel only ever sees `requirements.txt` and the actual repo contents —
if something needed to be manually patched locally to get a test
passing, that patch needs to land in a real file, not just the
sandbox's state, or it'll pass locally and fail in production every
time.

**First real end-to-end use, via manual mode, surfaced a genuine script-
quality bug this schema should have caught:** a physics-overview script
had three captions using `at`/`style` (emphasis-only fields) instead of
`type: "emphasis"` — silently ignored rather than rejected, leaving
those captions with no opacity keyframes at all, so they were visible
from frame zero for the entire duration. Combined with every other text
layer fading in but never fading back out, the result was every section
label piled on screen simultaneously by the end — confirmed against the
actual screenshots, not just the JSON. Fixed two ways: `motion_schema.py`
now rejects `at`/`hold`/`style`/`size`/`slot` on any non-`"emphasis"`
layer with a specific, actionable error instead of silently dropping
them (new tests cover this, including a direct reproduction of the
physics script's exact mistake); and both prompts (the Python system
prompt and the manual-mode prompt — kept re-verified byte-identical,
same process as before) now explicitly scope those fields to emphasis
layers and instruct treating a scene as sequential beats that fade out
old content, not an accumulating pile — aiming for ~2-4 layers visible
at once rather than everything that's ever appeared.

**First real BYOK attempt (Gemini) found a genuinely different class of
bug, and it revealed the "type": [x, "null"] pattern was never actually
verified against a live call at all:** `400 Invalid JSON payload
received... Proto field is not repeating, cannot start list`. Gemini's
schema is a scalar-typed subset of OpenAPI 3.0 — its `type` field is a
protobuf enum, not a repeating field, so it rejects ANY array value for
`type`, not just JSON-Schema-style nullable unions. The old comment
above `MOTION_SCRIPT_SCHEMA` claimed this pattern was already proven
by the existing card-generation schema — it wasn't; that schema had
the identical bug the whole time, fixed alongside this one (unrelated
to Motion Studio, found while researching the real fix).

Rewrote the whole schema Gemini-compatible: every nullable field is now
a single `type` plus a sibling `nullable: true` (Gemini's own
documented pattern) instead of a type array. One field needed a
different fix entirely — `KeyframePoint.value` genuinely can be either
a number or a hex-color string, and Gemini has no way to express a type
union at all (no array, no oneOf/anyOf). Declared it as a plain string
uniformly and added a `field_validator` that coerces a numeric-looking
string back to a real float before it reaches the resolved JSON —
without this, every Gemini-generated x/y/scale/rotation/opacity
keyframe would've silently stopped interpolating smoothly (the player
only lerps between two numbers) and just snapped between values
instead. Added a permanent structural test that walks the entire schema
tree checking for array-typed fields, non-string enum values, and
oneOf/anyOf/allOf — this exact bug class shouldn't be able to come back
silently. 28 tests total, all passing. Couldn't verify against Gemini's
actual live endpoint from the sandbox (not in the network allowlist),
so this is verified as thoroughly as possible short of an actual call —
the real confirmation is the next live attempt.

**Product concern raised directly: reliability matters a lot more once
this might be paid, and no prompt is ever going to be 100% reliable.**
Three concrete responses, none of them "write a better prompt":

- **Debuggability.** There was previously no way to see what a
  generation actually produced — a blank-screen result was a dead end.
  `motion-test.html` now has a "View JSON" toggle for the currently-
  loaded script, and every entry in the saved-scripts list gets its own
  "JSON" button that retrieves that record directly from IndexedDB
  without needing to replay it. Since `generateMotion()` already saves
  to IndexedDB before the player ever touches the result, a script that
  renders blank is still fully recoverable after the fact — this is
  exactly the tool needed to diagnose the next one.
- **Auto-correct what's safe to auto-correct.** `Scene.width` / `height`
  / `fps` / `duration` are now clamped into range instead of rejected
  when a model ignores the prompt guidance and picks something out of
  bounds — a model asking for width=3000 is a mundane, harmless mistake
  with an obvious correct fallback, not a sign the whole script is
  wrong. New tests cover the exact bounds. Deliberately did NOT do this
  for the emphasis-field misuse from before — auto-converting a
  caption to an emphasis layer would silently change its behavior
  (auto-positioning kicks in, ignoring any explicit x/y), which could
  produce a result that's different from, not closer to, what was
  intended. That one's still a hard reject with a specific error.
- **Close the loop when something still can't be auto-fixed.** Manual
  mode's paste-back flow now shows a "Copy error to send back to your
  AI" button whenever the backend rejects a script, which copies a
  ready-to-paste follow-up (the exact error plus the original JSON) so
  fixing a mistake doesn't mean retyping anything.

**Built, per explicit direction: user-confirmed retry-with-feedback,
logged.** Not automatic — a model mistake gets one confirmed retry via
`window.confirm()` in the harness before a second API call happens,
since that's real money/quota either way. Kept deliberately stateless
rather than round-tripping full conversation context: a retry doesn't
reconstruct the exact prior turn, it just tells the model what went
wrong (`retry_note`, appended to a fresh user message) and asks for a
better attempt — simpler and more robust than trying to replay a tool-
use block or partial Gemini response across two independent HTTP
requests, and works identically for both providers. `/api/generate-
motion` now distinguishes hard failures (auth, rate limit, missing
credentials — retrying won't fix these, stays a normal HTTP error) from
retryable ones (validation failure, incomplete generation, a timing
issue in `expand_script`) — those return 200 with `retryable: true` and
a specific error instead of a hard error, so the frontend can offer the
retry rather than just failing. Every retryable failure and every
confirmed retry attempt is logged (`logger.info`, visible in Vercel's
Runtime Logs) — "reported in the repo" beyond that is a natural
extension once the Redis quota migration happens (same infra, same
motivation: persistent counters instead of an in-memory dict that
resets on every cold start), not a separate bespoke mechanism.

**A live Gemini generation surfaced a second real production bug in
the same session, found from a single pasted example:** a script for
"How Small is Small?" came back with a well-formed scene (name,
duration) but exactly one layer — a rect with literally every type-
specific field null. Root cause: `_call_claude_motion` sets an explicit
`max_tokens=8192`; `_call_gemini_motion` set no token budget at all,
silently relying on Gemini's own default. A rich multi-layer script in
this schema's fairly verbose JSON shape can plausibly exceed a smaller
default, and Gemini's structured-output mode can close the JSON out
gracefully enough when that happens to still pass `json.loads()` and
even schema validation — while being almost entirely empty. Fixed two
ways: matched Claude's `max_tokens=8192` as an explicit
`maxOutputTokens`, and added a `finishReason` check that fails loudly
(as a retryable error, not a silent pass-through) on anything other
than `STOP`.

Also added, since it directly targets the exact defect in that pasted
script and is cheap insurance regardless of the token-budget theory
being the whole story: every field on `Layer` is `Optional` so one
model can describe every layer type, but that doesn't mean every field
is optional *in practice* — a `rect` with no width/height or a `circle`
with no radius has nothing to draw. `Layer` now has a
`_has_visible_content` validator requiring the fields each type
actually needs (dimensions for rect, radius for circle/polygon,
non-empty text for text/caption/emphasis) — the exact production script
would now be rejected outright rather than silently accepted as a
content-empty layer. 34 tests total (8 new across this and the retry
work), all passing, plus a live Playwright pass (mocking the network
response, since triggering a real retryable failure needs an actual
live model call) confirming the full confirm-dialog-to-retry-to-success
flow works end to end.

**Richer few-shot example added to both prompts.** `MOTION_SYSTEM_PROMPT`
(shared by both providers' API calls) previously described the schema in
prose only, no worked example at all; `build_motion_manual_prompt()`'s
example was a single text layer with a fade-in and nothing else — neither
showed markers referenced from more than one beat, an emphasis layer, a
camera move, or a layer fading back out. Both now share a single six-layer
worked example (`_MOTION_EXAMPLE_JSON`, defined once in `index.py`, on an
unrelated physics topic so it can't be mistaken for a template to copy)
demonstrating: marker-driven pacing across three beats (`setup`, `reveal`,
`conclusion`); a layer meant to persist getting a fade-in and no second
opacity point (`header`) — no special flag, that's the entire mechanism;
two layers timing their fade-out to a NEGATIVE offset from the next marker
so it finishes exactly as the next beat starts (`force_arrow`,
`setup_caption`) — a technique neither prompt mentioned before; a layer
with two independent keyframe tracks at once (`formula`, animating opacity
and scale together); the emphasis shorthand needing no manual keyframes or
x/y/fontSize (`formula_emphasis`); and a camera zoom track synced to the
same markers as the content instead of running on its own clock.

Verified before being embedded anywhere, in this order: `MotionScript.
model_validate()` + `expand_script()` on the example standalone; re-run
against the actual live `build_motion_manual_prompt()` /
`MOTION_SYSTEM_PROMPT` output after editing (catches any transcription
slip the edit itself introduced, not just the original draft); then a real
HTTP round trip through a locally running server — `POST /api/expand-
motion-script` with the example body, 200 OK, correctly resolved camera
and layer keyframes. The manual-mode JS mirror (`buildMotionManualPrompt()`
in `motion-api.js`) was re-synced using this file's own established
byte-comparison process: extracted the Python function's exact output with
a placeholder topic, spliced it into the JS template literal, then ran the
actual JS function through Node and diffed the two outputs — byte-for-byte
identical, no backticks or stray `${` sequences in the spliced text either.
All 34 existing unit tests still pass unmodified. Pure prompt content, no
schema or engine changes, so nothing else needed touching.

**Real in-app UI shipped** (`motion-studio.js`), replacing "bare test
harness only" — `motion-test.html` stays as a separate, lower-level dev
tool for testing the pipeline directly, not something a person is meant
to find; the app's own navigation now points at the real view. Reachable
two ways: a new "Motion" entry in the deck action sheet (next to Mind
Map), and — the more natural path — tapping any node in a document's
Mind Map v2 now shows "Explain with motion," which hands the node's
title off as a pre-filled topic and auto-generates on arrival. The
handoff uses a one-shot `sessionStorage` key
(`motion-studio.js`'s `MOTION_PREFILL_KEY`) rather than a URL query
param, since the app's hash router is a plain two-segment
`/route/:id` parser with no query-string support, and topics can contain
characters that would need escaping there anyway.

Verified past what a screenshot alone would show: real canvas pixel
content was inspected at multiple timestamps (0 bright pixels at t=0,
the layer's own opacity keyframe says it should be invisible there;
1310 near-white pixels at t=1.5s and t=3s, after the fade-in completes)
to confirm the player is actually resolving and drawing keyframes, not
just displaying controls around an empty canvas. The full navigation
path was also driven for real — not the usual isolated seeding harness —
starting from a blank app load, creating a deck through the actual UI,
clicking the actual `.deck-menu-btn`, clicking "Motion" in the real
bottom sheet, confirming the hash actually changed
(`#/motion/<realDeckId>`) and the resulting view showed the real deck
name.

That real-navigation pass caught a genuine pre-existing bug, invisible
until a deck-scoped view existed to expose it: `renderMotionManualImport()`
never accepted or passed a `deckId` at all, so every manually-imported
script silently saved with `deckId: null` regardless of which deck it
was created from. `motion-test.html`'s script list was never filtered by
deck (shows everything, always), so this had no visible symptom there.
`motion-studio.js`'s deck-scoped "Saved explainers" list is the first
place that actually filters by `deckId`, and a manual import promptly
vanished from it. Fixed: `renderMotionManualImport()` now takes an
optional `deckId` and threads it through to `expandMotionScriptManual()`
(which already accepted one — only the UI layer was dropping it);
`motion-studio.js`'s call site passes its own deckId, `motion-test.html`'s
stays `null` since that harness has no deck context to give it. Re-verified
live: an imported script now shows up correctly in the deck's own list.

**Not started:** end-to-end verification with a real Claude/Gemini
key — everything above was proven with a bogus/no-key 401 path and the
manual-paste path; nobody's yet confirmed the model reliably produces a
well-formed script via the actual tool-calling schema, and the richer
example's actual effect on real generation quality is still unmeasured —
that's the natural next real-key test now that the prompt itself has
changed. **Still needed before persistent storage is trustworthy:** the
free-quota counter is still an in-memory dict (same limitation as the
pre-existing IP rate-limiter) — needs a Vercel Marketplace → Upstash
Redis integration before this is trusted with real traffic. **Also not
done:** a matching "Explain with motion" hook on the card-based mind
map's node detail panel (card fronts are often short quiz-style
fragments rather than clean explainer topics, so this needs a bit more
thought than the document mind map's node-title-as-topic approach, not
just a copy-paste of the same hook) — and the Help section still doesn't
reflect any of this; a guided "how to use Lernin" walkthrough plus a
curated, pre-generated onboarding explainer (using this feature to
explain the app itself) are the next planned pieces, not yet started.

---

### Mind Map v2 — backend and frontend built, verified, wired end to end

A static, per-document topic-tree mind map generated from a document's
*actual text*, not derived from flashcards — cards are already a lossy,
study-optimized transformation of the source, so going through them as
an intermediate step produces something less faithful to the document's
real structure than working from the document directly. Distinct from
the existing card-based `mind-map.js` (deck-scoped, force-directed,
relationship-driven — see "Already shipped" below), which stays as-is.

Placement: a new 🧠 action on each row in the Documents view, next to
the existing delete button — that view is already the per-document
list, so this needed no new nav entry and no change to the existing
force-directed Mind Map's menu item. Interactive (pan/zoom/tap-for-
detail), not animated — no keyframes/playback, unlike Motion Studio,
and deliberately no node dragging either: the layout is structural and
deterministic, so dragging a node would just be visual noise with
nothing to persist it against, unlike the card graph's physics-based
one where dragging still respects the springs.

**Schema** (`api/mind_map_schema.py`) is deliberately non-recursive —
`root` → up to 3 more nested levels of `children`, four fixed levels
total, no self-referencing type — even though a topic hierarchy is
conceptually recursive. Gemini's older `responseSchema` path (the same
OpenAPI-3.0-subset style this project already uses for card generation
and Motion Studio) has a well-documented history of failing on
recursive/self-referencing schemas (multiple open
`googleapis/python-genai` issues, `pydantic-ai`'s own "Recursive $refs
... are not supported by Gemini" report); a newer `responseJsonSchema`
path reportedly added `$ref`/recursion support more recently, but which
path this project's actual Gemini integration would land on couldn't be
verified live (`generativelanguage.googleapis.com` isn't reachable from
this sandbox) — so rather than risk repeating the exact class of bug
Motion Studio's `type` field hit in production, the schema sidesteps
the question with a bounded depth instead. The internal Pydantic model
is still genuinely recursive (Python has no such restriction) and
independently re-validates the same depth/count bounds via a tree walk,
so a manually-pasted script that's deeper than the generation schema
structurally allows is still caught, not silently accepted by one path
and rejected by the other. All fields required except `detail`
(optional at every level, so a self-evident leaf doesn't need invented
padding) — no other nullable fields anywhere, sidestepping that whole
category of the Motion Studio lesson too.

**Layout** (`api/mind_map_engine.py`) mirrors `motion_engine.py`'s
split deliberately: the model generates semantic structure only
(titles, details, parent/child relationships), a pure deterministic
function turns that into concrete non-overlapping (x, y) coordinates —
so a bad layout is a reproducible geometry bug in this file, and a bad
topic breakdown is a prompt-quality problem, and the two can never be
tangled together the way AI-authored positions would tangle them.
Radial layout: root at canvas center, each ring's radius grows with how
crowded that ring actually is (not a flat step), each node's angular
slice weighted by its own subtree size so a branch with many
descendants gets proportionally more room. 24 unit tests
(`api/test_mind_map_engine.py`) covering schema bounds (depth, node
count, blank/oversized fields), the Gemini-safety structural walk (no
list-valued `type`, no `$ref`/`$defs` anywhere), and the layout engine
itself (no coincident positions, no NaN/infinite coordinates, parent
IDs correct, crowded rings get larger radii than sparse ones, exactly-
at-boundary cases for both node count and depth). Beyond the numeric
tests, the layout was also rendered to an actual image (PIL, then
separately via the real running renderer through Playwright) and
inspected — a radial layout can pass every numeric property (unique
positions, monotonic radius, correct parent IDs) and still look wrong
in a way none of those properties would catch.

**Prompt** (`MIND_MAP_SYSTEM_PROMPT` / `build_mind_map_manual_prompt()`
in `index.py`) includes a fully worked example from the start —
applying Motion Studio's "richer few-shot example" lesson immediately
rather than shipping bare rules and retrofitting an example later.
Deliberately demonstrates uneven depth across branches (one branch goes
the full four levels because the source material had two distinct
sub-points worth naming, sibling branches stop at two or three because
there was nothing more specific to say) and optional `detail` being
skipped for self-evident leaves rather than restated as a fake
sentence. Validated end to end (`MindMapScript.model_validate()` +
`expand_mind_map()`) before landing in either prompt.

**Routes** (`/api/generate-mind-map`, `/api/expand-mind-map`) mirror
Motion Studio's `/api/generate-motion` / `/api/expand-motion-script`
exactly — same three-path credential model (BYOK / server-key-with-
quota / manual-mode), same retryable-vs-hard-error taxonomy, own
independent quota pool (`MIND_MAP_FREE_LIMIT`, separate from Motion
Studio's) so the two features' free generations don't share one
counter. Verified live against a real locally-running server: manual
mode with a valid tree (200, correctly resolved 13-node/1080×1080
layout), a genuinely malformed tree — too few nodes — (clean 400 with a
specific message, not a crash), missing credentials (clean 400/401,
not a crash), text too short (clean 400), and a bogus server-key
Claude request against the actual live Claude API (167ms round trip,
`"Invalid Claude API key."` — the real translated Anthropic auth
error, not a local short-circuit, confirming the full credential→
provider-call→error-translation pipeline end to end).

**Frontend** (`mind-map-doc-api.js`, `mind-map-doc-manual-import.js`,
`mind-map-doc.js`) mirrors Motion Studio's file split. One deliberate
difference: no offline retry queue the way `motionGenQueue` exists for
Motion Studio — mind-map generation is a best-effort side-call fired
after cards generate successfully, not something the person explicitly
asked for right now, so a failure or an offline device loses nothing;
the Documents-view action generates on demand later instead (see
Option A/B below). `mind-map-doc-api.js`'s manual prompt was byte-
verified against the live Python output the same way Motion Studio's
is — extracted with a placeholder, spliced into the JS template
literal, diffed against a live Node run of the actual JS function:
identical. Storage: `db.js` DB_VERSION bumped to 10, new
`documentMindMaps` store keyed directly by `documentId` (1:1 —
regenerating overwrites, unlike `motionScripts`' 1:many-per-deck),
`deleteDocument()` now cascades to remove the associated mind map.
Verified with a real `fake-indexeddb` test: save/get round-trip,
regenerate-overwrites-not-duplicates, explicit delete, cascade delete
via `deleteDocument()`, and deleting a document with no mind map
doesn't throw.

**Option A/B, both built.** Option A (the faithful path): generation
now fires from `handleExtractedText()` in `app.js` immediately after
`saveDocument()` succeeds on the BYOK auto-generate path, using the
full extracted `text` while it's still in memory — fire-and-forget,
can't block the person from seeing their cards. Option B (the
fallback): the Documents-view action's "no mind map yet" state offers
to generate on demand from the document's saved `summary` instead,
for documents where Option A wasn't attempted, failed, or predates
this feature entirely (raw text is never persisted anywhere — see
`mind_map_schema.py`'s module docstring for why that's structural, not
an oversight). Mind maps generated either way are labeled by their
`source` field; a summary-sourced one shows a small "lower detail than
a fresh upload" badge rather than presenting both the same way.

**End-to-end UI verification, not just backend HTTP calls this time.**
Built an isolated seeding harness (real `db.js` functions + the real
running renderer, served through a small static+API proxy, driven by
Playwright) and screenshotted every state: an already-generated map
rendering correctly, the summary-fallback badge, the "no mind map yet"
CTA, the manual-import fallback triggering correctly on a real 401 from
a bogus key, and a full paste-JSON-and-submit round trip actually
producing a rendered tree. This caught two real bugs neither the unit
tests nor a code read surfaced:
- `.app-header-title` had no overflow handling at all — any header
  using the shared `.app-header` pattern with a long enough title (a
  document filename, here) would wrap to a second line and overlap the
  fixed 56px header height. General bug in shared CSS, not mind-map-
  specific, just the first view with text long enough to expose it.
  Fixed at the shared class level (`flex:1; min-width:0; overflow:
  hidden; text-overflow:ellipsis; white-space:nowrap; text-align:
  center`) so every view using `.app-header` benefits, not just this one.
- `setupCanvasView()` appended a canvas without clearing its container
  first. Every call site assumed the container was already empty, but
  none of them actually were (a loading message, the manual-import
  form) — so after a successful generation the canvas rendered
  correctly but sat *underneath* the still-mounted previous UI, and a
  button like "Validating…" would appear stuck forever even though the
  map had actually resolved. Fixed by having `setupCanvasView()` clear
  its container itself, since it's the one taking full ownership of
  that element — safer than trusting every current and future call
  site to remember to clear first.

**Also fixed in this pass, found while building this:** the BYOK
auto-generate path's `summary` return value was silently discarded —
`handleExtractedText()` called `generateCards()`, got back
`{ cards, summary }`, and only ever passed `cards` on, so
`saveDocument()` was never invoked for the most common generation path
and the Documents/Course Recap views were effectively empty for
anyone using it. Fixed: `saveDocument()` is now called (fire-and-forget,
non-blocking, so a save failure can't block someone from seeing their
cards) whenever a summary comes back. This was a real, pre-existing bug
independent of Mind Map v2, but directly relevant to it — the new
Documents-view action needed a document list that was actually
populated to have anything to attach to.

**Not started:** no real-key end-to-end generation test yet — same gap
as Motion Studio's, proven so far only with a bogus-key 401 path and
the manual-paste path; the richer few-shot example's actual effect on
real generation quality is unmeasured, same as Motion Studio's. The
isolated test harness used for the screenshot verification above was a
throwaway (`public/test-mindmap-harness.html`, deleted before this
commit) — not shipped, unlike Motion Studio's `motion-test.html` which
is a deliberate permanent dev tool; this one was pure automation
scaffolding, not something a person would want to open by hand.

---

## Tier 2 — Rich cards and relationships

Fully shipped — every item originally scoped here, including the
follow-ups, is done (see below).

**Shipped:** a third card type, `'formula'` (alongside `basic`/`cloze`),
with `formula`/`variables`/`assumptions`/`commonMistakes`/`applications`
fields — scoped to formula cards only, not added to every card. A
dedicated `cardRelationships` store (not arrays embedded on the card
record — see `db.js`'s v6 migration comment for why) with `dependsOn`/
`related` links, indexed both directions, deliberately allowed to cross
decks. A "+ Card" manual creation view supporting all three types plus a
live-search relationship picker. Rich rendering in Study Mode — formula,
variables, assumptions, common mistakes, and applications all show on
the back reveal (plain text/monospace, not real math typesetting —
revisit if that turns out insufficient once people are actually using
formula cards). A card browser ("Cards" button per deck) and a
relationship explorer — a card's detail view shows what it depends on,
what depends on it, and what's related, in both directions, with
add/remove and cross-deck navigation. Reverse lookup — a search box in
the "Cards" view searches by answer/formula/notes content (not the
question) across every deck at once, for "I remember the answer but not
which card it's on." AI pipeline extraction — both the API-key path
(`api/index.py`'s Anthropic tool schema + Gemini response schema) and
manual-paste mode's prompt now recognize actual named formulas in
source text and populate the same structured fields, with explicit
anti-hallucination guardrails (assumptions/commonMistakes/applications
are left empty rather than invented when the source text doesn't state
one — the prompt is explicit that an absent field is expected, not a
failure). Also fixed two real bugs found while wiring this up: generated
formula cards' extra fields were being silently dropped at save time
(`saveNewCards` only ever copied front/back/type), and the review/edit
step's Undo action destroyed and rebuilt cards from a stripped-down
{front, back, type} object, which would have permanently lost a formula
card's fields the moment it was discarded-then-undone. All of it tested
end-to-end against real IndexedDB semantics (fake-indexeddb) or, for
the rendering/parsing, against realistic card data including
HTML-unsafe characters — not just read through.

**Not shipped yet, on purpose (decided when scoping this):**

### Smart daily session planner — shipped
`study.js`'s `applyPrerequisiteOrdering()` soft-reorders the queue
after `interleaveQueue()`, before the explicit `startCardId` override
(manually choosing a card to study always wins over automatic
ordering). Settings → "Reorder sessions by prerequisite", default on
(`getSetting('smartOrderingEnabled')`, anything but explicit `false`
counts as enabled). Verified against 6 scenarios in a standalone test
harness: simple pull-forward, chained dependencies, prerequisite
outside today's queue (correctly left alone — no injection), circular
dependency (terminates safely via the `queue.length * 3` pass cap,
doesn't hang), already-correct order (no unnecessary moves), and
`related`-type links (correctly ignored — only `dependsOn` reorders).

---

## Tier 3 — Explicitly deferred, with reasons

**Shipped (scoped down from the original idea):** local study reminders
— db.js's "Study reminders" section, app.js's `checkAndShowStudyReminder`.
NOT true push notification: real push needs a server-side subscription
store and something to trigger sends on a schedule (Vercel cron or
similar), and this app has no server-side storage of any user data by
design — adding one just for this would be a real architecture change,
not a client-only feature, and would contradict what the Help view
already tells people about their data. What's actually built: a
Settings toggle requests Notification permission, and on every app open,
a check fires at most one local notification per calendar day if it's
evening and today hasn't been studied yet. This cannot wake up a fully
closed app/browser the way true push can — it only fires while the app
has been opened at least once that day. If real push is wanted later,
it needs its own dedicated session to add a real backend job runner and
a subscription store, which is a bigger decision than a quiet addition.

Also shipped: map territories now have a subtle ambient "activity halo"
— canvas.js's `computeActivityLevel`/`drawTerritoryActivityHalo` — scaled
by total review reps across a territory's cards, independent of any
single island's mastery. Deliberately a fixed warm hue rather than tied
to the mastery color progression, to avoid reintroducing the exact
background/foreground hue-collision bug that `--map-bg` was just fixed
for (see the Active section below).

### Map — redesigned outside this chat, audited and cleaned up here
The "fuller discussion" mentioned below happened outside Claude
entirely — commits `4559b85` ("recreated the map") and `7b7bb2c`
("bug fixes") were a from-scratch canvas.js/db.js rewrite, prototyped
in a separate `lernin-spatial/` folder and merged into `public/`.
Verified rather than taken on faith: the integration itself was
genuinely clean (all imports/exports/schema lined up). Four real gaps
were found by reading the actual code — render loop, delete UI,
silent writes, native dialogs — all four now fixed, see "Already
shipped" below for details. Island-to-island lines at L1 (the
originally-requested Tier 2 follow-up) shipped in the same pass,
bundled together since both touched canvas.js directly.

---

## Already shipped (for context — not backlog items)

Infinite pan/zoom canvas, mastery color encoding, draggable islands with
persistent positions, click-island-to-study, PDF text extraction with
per-document summaries (not full-file storage), Course Recap view,
BYOK (Claude/Gemini/manual-paste), streaks with freeze tokens,
session-end summary, leech review with history context, deck
edit/rename/re-territory, hard reload + storage usage in Settings,
Reset-everything, RecallDB→Lernin rename with data migration, the
green/gold rebrand, deck export/import (JSON, with a full-backup vs.
progress-free share-copy choice), a statistics dashboard (30-day
retention, longest streak, per-deck breakdown, activity chart), a
persistent, sectioned in-app Help view (reachable via the header's "?"
button and from a rewritten first-run empty state) covering what the app
is and how each feature works, rich formula cards fully end-to-end
(schema, cross-deck dependsOn/related relationships, manual creation
with a relationship picker, Study Mode rendering, a card browser +
relationship explorer, cross-deck reverse lookup, and AI generation —
both the API-key path and manual-paste mode — actually populating
formula fields from source text with anti-hallucination guardrails),
local study reminders, a map territory activity halo, and a
prerequisite-aware smart session planner — only the visual map
connections between related islands remain, see Tier 2 above.

A **Reading Toolkit** (Settings → "Open Reading Toolkit",
`/reading-toolkit`) — an explicitly side/non-core feature, a static
library of copy-ready prompts for pairing reading with any AI chat
tool, grouped by before/during/after reading plus deeper-comprehension
techniques (Feynman check, Socratic push-back). Doesn't touch decks,
cards, or generation. Content lives in `READING_PROMPT_GROUPS` in
app.js — plain data, edit directly to add/remove prompts.

**Card browser redesign** — the per-deck Cards view replaced its flat
stacked-row list with a solitaire-style grid (`.card-tile-grid` in
styles.css). Each card is a fixed-aspect-ratio (5:7) tile with a
dog-ear corner fold, a custom mark as the type indicator (chevron for
basic, gapped line for cloze, division sign for formula —
`CARD_TYPE_ICON` in app.js, inline SVG) and a colored dot for review
stage (`CARD_STATE_COLOR`, reusing the same rust/amber/green palette
as the leech-review grade dots for cross-view color consistency),
plus a pause-mark badge (`CARD_SUSPENDED_ICON`) + reduced opacity on
suspended cards. Originally shipped with actual playing-card suits
(♠♣♦♥) — replaced after feedback that it read as borrowed-from-a-
card-game rather than Lernin's own; the custom marks were iterated
through several rounds of headless-Chrome screenshot testing before
landing on ones that read clearly at 14px without ambiguity (an
early "two bars" mark for basic looked like an equals sign; an early
formula mark looked like a checkmark). Text is centered and
line-clamped rather than truncated by character count. Actually
rendered via headless Chrome screenshots (light mode, dark mode, a
denser 12-card grid) before shipping, not just code-reviewed — all
three held up. A one-line legend under search explains the
notation.

**Sound effects** — synthesized via Web Audio API in a new `sound.js`
module, no audio files (kept dependency-free, matching how everything
else is vendored locally rather than pulled from a CDN). Distinct
tones for flip, each grade, and session complete — Again is
deliberately mild rather than punishing, since honest self-grading
matters more than a "reward" sound discouraging it. Settings →
"Play sound effects while studying," **off by default** — a study app
gets used in libraries and other quiet shared spaces, so this is one
of the few opt-in toggles here that defaults off rather than on.
Toggling takes effect immediately mid-session via a cached-setting
pattern (`setSoundEnabledCache`), no restart needed. `sound.js` added
to the service worker precache list, cache bumped to v24. A follow-up
pass added `playNavigate()`, a quieter/shorter tap hooked into
`handleRoute()` (the single true entry point for every route change,
including browser back/forward — `navigate()` alone wouldn't have
covered those) — skips the very first cold-load call so nothing plays
before the person has done anything.

**Relationship picker restored at card-creation time** — not via the
originally-suggested silent-autosave approach (too much new
complexity/risk for what it bought: what happens on Cancel after an
autosave, keeping type changes in sync, etc.). Simpler version
shipped instead: the existing single Save button is untouched: after
a successful save, `showPostSaveLinkStep()` shows the same live-search
picker card detail view has (extracted into a shared
`buildRelationshipPicker()` so both stay in sync rather than
duplicating ~50 lines of UI) before returning you to wherever you
were. Skippable — "Done" leaves immediately, nothing is required.
"+ Add another card" loops back into the form for chaining several
related cards in one sitting. Both exit paths use `goBack()` rather
than a hardcoded destination, since the URL hash never changes during
this synthetic post-save step — consistent with every other back
button in the app.

**Map cleanup pass + island-to-island lines at L1** — the four gaps
found while auditing the outside-chat map redesign, all fixed
together since they all touch canvas.js:
- **Render loop**: replaced the unconditional 60fps `renderLoop()`
  with an activity-gated one (`scheduleFrame(delayMs)`) — full rate
  while `activePointers.size > 0` (dragging/panning/pinching) or the
  camera hasn't settled toward its target, a throttled ~250ms idle
  tick otherwise. A slow self-correcting idle tick rather than a
  fully precise dirty-flag system was a deliberate trade-off: still a
  15x+ reduction in idle frames, but self-corrects within ~250ms even
  if some future change forgets to trigger a redraw, instead of
  risking a frozen map from one missed call site. Wired into every
  discrete interaction that needs to feel instant regardless of idle
  state: wheel zoom, pointer-down, exit-to-L1/L2, tap-to-add
  annotation/landmark, path-draft additions.
- **Delete UI**: `deleteLandmark`/`deleteStudyPath`/`deleteAnnotation`
  were imported from db.js but never called anywhere — now, a plain
  tap on an existing landmark or annotation (outside annotate mode,
  which still means "add new" as before) shows a delete-confirm
  modal; study paths get a "×" button in the existing Paths panel.
- **Silent writes**: `saveIslandPosition`/`saveConceptPosition`
  stay fire-and-forget (correct — shouldn't block the next drag
  frame on a write) but now `.catch()` into a `console.warn` instead
  of vanishing entirely; `saveAnnotation` properly propagates
  failures into the new modal so a failed save doesn't just silently
  lose what was typed.
- **Native dialogs**: all three (`prompt()` ×2 for landmark/path
  naming, `alert()` ×1 for the "need 2+ cards" path-build message,
  plus the annotation-text `prompt()` already mentioned above)
  replaced with custom modals matching the app's actual design
  language — consolidated into two reusable helpers
  (`promptTextModal`, `infoModal`, plus `confirmModal` for the new
  delete confirmations) rather than one-off implementations each.
- **Island-to-island lines**: new `getCrossDeckRelationshipPairs()`
  in db.js aggregates every cross-deck relationship into one entry
  per deck pair with a count (tested against reverse-direction and
  same-deck edge cases before wiring in). `drawIslandConnections()`
  in canvas.js draws one dashed line per pair at L1, weighted by
  count, dimmed/highlighted via the existing `hoveredIsland`
  mechanism — same hover pattern L2 already had, just extended to
  islands. A failure to load relationship data degrades to "no lines"
  rather than breaking map load, since it's decoration, not core.

**Mind Map** — new `mind-map.js`, a standalone per-deck force-directed
graph, revived from the pre-rewrite `concept-graph.js` (which had been
reduced to a 16-line deprecated stub redirecting to the territory
map's L2 — its physics-based layout was replaced by a plain index-
ordered spiral that ignores relationship structure entirely). Kept as
its own focused view rather than merged back into the territory map:
different job (see the shape of a course at a glance vs. explore
landmarks/paths), and reusing the map's `conceptLayouts` position
store would mean dragging a node here also relocates that card on the
territory map. Instead: fresh layout computed every time the view
opens, in-session dragging is visual-only and never persisted.

The ported physics parameters were **not** trusted as-is. Built a
standalone test harness before shipping and found the original
values (repulsion 800, springLength 140) actually produced the
*opposite* of the intended effect on a realistic sparse graph (a few
small clusters plus isolated cards, typical of a real deck):
connected pairs ended up ~35% farther apart than unconnected ones,
because 140 was longer than the graph's natural repulsion+gravity
equilibrium spacing, so springs were pulling connected nodes apart
rather than together — not a porting error (verified the constants
matched the original file exactly), a pre-existing tuning issue.
Re-tuned to springLength=95/springK=0.06/iterations=200, verified
against the actual shipped `runForceLayout()` function (not just the
test-harness copy) across 15 random-seed trials on a 25-node test
graph: connected pairs reliably closer, worst-case 1.16x, comfortable
node spacing at rest for even two max-radius nodes.

**Two more real bugs found later, from an actual live screenshot on a
97-card deck** (not from further test-harness work — the 25-node
harness above never exercised either of these): every node was
visibly overlapping its neighbors, and independently, the simulation
could diverge outright rather than settle at all, on some decks.
Neither was an N-scaling problem with the springLength=95/repulsion=800
values just above (re-verified those still hold at N=97 the same way
they did at N=25) — both were gaps in the untuned parts of the model
that the smaller test scale never happened to expose. First: repulsion
has no relationship to actual node radius, so nothing ever guaranteed
touching nodes would stay apart — confirmed empirically (avg
nearest-neighbor gap 36.6px vs ~62.6px of combined radius actually
needed at N=97), fixed with a `resolveCollisions()` post-process pass
(80 iterations, tuned against N=150 stress tests — 40 left ~9px of
residual overlap, 80 didn't). Second, found while stress-testing the
fix: repulsion's `1/d²` term has a singularity as distance approaches
0, and explicit-Euler integration with a fixed damping constant has no
protection against the resulting force spike — max velocity was
observed oscillating (38 → 128 → 166 → 600) instead of decaying, span
growing past 4000px, on a 97-node/25-edge test case. Fixed with a
MIN_DIST floor on the repulsion distance and a MAX_VEL cap per
iteration (both standard stabilizers for this class of simulation).
Verified across 45+ randomized trials at N=8/25/97/150: zero
divergences, down from routine at N=97. Also, separately: the same
live screenshot showed the home screen's header title clipped to
"Le…" — a same-session regression from `.app-header-title`'s
long-filename overflow fix (Mind Map v2, below) being too aggressive
for a title sharing space with six icon buttons; fixed by sizing the
title to its natural width first and only shrinking under genuine
pressure, with the icon row now protected from ever being the one
that shrinks.

---

## Active — real user feedback, not yet fully addressed

### Help voice rewritten: corrective -> rescuing, plus consistency pass
Direct feedback: "wrong voice mixed with inconsistency." The diagnosis
matched what a read-through confirmed -- the original voice (hero,
Philosophy, the two engines) was confident but *corrective*: "You are
not re-reading notes. You are training retrieval," "Highlighting feels
productive. It is not," "Do not let the streak become the goal." That
stance is a critic pointing out what you're doing wrong, not a rescue.
Layered on top, the sections added in the last two passes (How it fits
together, the guide reorder) were written flatter and more neutral,
so the page as a whole didn't even agree with itself.

New direction, given directly: "the app has come to rescue you," told
in the voice of something that has personally suffered through old
reading habits and is genuinely glad you don't have to anymore. Not
"you're doing it wrong" -- "we did it wrong too, here's the way out."
Rewrote every section that carries real tonal weight: the hero (kicker,
title, both lead paragraphs), "The two engines," all six Philosophy
items (retitled "Why we built it this way"), and "How it fits
together" (added a closing line it was missing). Also removed an
orphaned "Max tip:" device -- a named character that appeared in
exactly three call-outs deep in the reference guide with zero
introduction or presence anywhere else in the app, which was its own
small inconsistency -- folded into the same first-person voice instead
("What actually helps:"). Softened a few remaining scolding lines found
along the way ("Lie to it and you get... a rude exam" in the FAQ, "Do
not let the streak become the goal") to match. Left the FAQ's mostly
factual Q&A and the step-by-step instructional content in the detailed
guide largely alone -- neutral/direct is the right register for "press
Space to flip," rewriting those into warm prose would read as forced.

Caught and fixed a real HTML bug introduced while editing the walkthrough
section: a new closing paragraph landed between two `</ol>` tags (invalid
nesting -- a stray duplicate close tag), caught by re-viewing the file
after the edit rather than trusting the str_replace diff alone. Verified
with real screenshots of every rewritten section, plus a TOC regression
check (re-clicked a TOC link post-edit to confirm the earlier
click-interception fix still holds -- title stayed "Help", no navigation
away).

### Onboarding motion graphic redesigned for real motion (v1 read as a slideshow)
Direct feedback on the first version: "looks like a slide show." Fair —
looking back at it, every beat was the same static composition (title
top, big word center, caption below), captions only faded in place with
zero position movement, and the camera drift was 1.0 → 1.08 across the
*entire* 27 seconds, imperceptible. Fades between static states is a
slideshow's whole vocabulary, not motion graphics'.

Redesigned around one throughline of genuinely continuous motion: a row
of 5 step-nodes with a connecting line, and a traveling dot that glides
(real position keyframes, eased, not a teleport) from node to node,
arriving at each exactly on that beat's marker. Verified the glide is
actually continuous, not jumping at marker boundaries, by pixel-sampling
the dot's rendered x-position at 6 timestamps between two markers:
109 → 120 → 165 → 231 → 256 → 260, smooth and monotonic. Each node also
pulses (scale + a real smooth color interpolation, dim gray to its lit
color) the moment the dot arrives, and *stays* lit afterward — so by the
end, the whole track visibly shows the journey completed, not just the
current step. Captions now slide up into position (y + opacity moving
together) instead of materializing in place. Emphasis style varies per
beat (pop / zoom / slideup / pop / zoom) instead of repeating the same
animation five times. Camera now does a small eased push-in synced to
each marker and eases back out before the next, instead of one
continuous drift too subtle to register.

Verified same as the original: schema validation, expand_script(),
screenshots at all six beats, one continuity check (the pixel-sampling
above), and a full 27-second real-time playback with zero console
errors — then re-checked once more inside the actual Help view (not
just the isolated test harness) before replacing the shipped asset.

### Curated onboarding motion graphic added to Help
Third and last piece of the "make the app feel like one connected
workflow" pass (Motion Studio wiring, Help restructure, this). A
27-second explainer walking through the same five steps as "How it
fits together," in Motion Studio's own format — proof the feature is
good enough to put in front of someone on day one, and a second
modality for the same message rather than a repeat of it in a
different font.

Deliberately a **fixed, pre-generated, reviewed asset**
(`public/onboarding-script.json`), not a live per-visitor generation:
Help has to load instantly with no API key required from a first-time
visitor, and `motion-player.js` already only ever reads resolved
data (never executes anything from a script), so serving a pre-baked
one costs nothing at runtime and needs no credential path at all.
Embedded right after the hero, before the TOC — a poster-style play
button, not autoplay, matching the app's existing principle (see the
sound-effects convention elsewhere) that anything firing without the
person having done something reads as an ad, not feedback for an
action they took. Ends with an explicit "Watch again" state
(`{loop: false}` passed to `createPlayer`, polled for
`currentTime >= duration`) rather than either looping silently forever
or just freezing with no way back in.

Building it caught its own mistake worth noting for next time: the
first render pass fed the *raw* script (with the emphasis shorthand's
`at`/`hold`/`style` fields) directly to `motion-player.js`, skipping
`expand_script()` entirely -- every emphasis layer rendered
simultaneously as unreadable overlapping text, since the player expects
already-resolved keyframes, not the AI-generation-schema shape. Fixed
by running it through the real `/api/expand-motion-script` endpoint
(the same one manual mode uses) and shipping *that* resolved output as
the actual asset, not the source script. Re-verified per-beat via
Playwright at all six markers, one transition frame, and a full
27-second real-time playback with zero console errors; two captions
("understand", "study") were also cut for length after the first
per-beat pass showed them overflowing the canvas edge -- re-verified
after the edit, comfortable margins on all six beats now.

### Help restructured into an explicit workflow + a real TOC navigation bug fixed
Feedback: flashcards should stay the app's main/hero feature (they do —
that's unchanged), but the newer comprehension tools (both mind maps,
Motion Studio) needed to feel like they belong to one workflow rather
than bolted-on extras, and Help should actually say what that workflow
is rather than leaving it to be inferred from a flat feature list.

Two changes: (1) `guideSections` reordered from an arbitrary list into
the actual intended sequence — orient (Home & decks) → bring material
in (Getting cards in) → understand it before drilling (Mind Map per
document, Motion Studio — moved up from the tail end) → make cards
(Formula cards) → study (Study session) → reflect (territory Map, Mind
Map per deck) → maintain/reference (Leeches/streaks/stats, Documents,
Reading Toolkit). "Mind Map" renamed to "Mind Map (per deck)" for
parallel clarity against "Mind Map (per document)" now that both exist.
(2) New "How it fits together" section — five numbered steps, in the
app's own established voice (the hero/philosophy sections' direct,
slightly wry tone, not generic onboarding copy), explicitly naming the
order rather than leaving someone to infer it from section ordering
alone.

Verified with the real rendered Help view (Playwright, not just reading
the JSX-equivalent template strings), which caught a real, pre-existing
bug along the way, affecting all four of the *original* TOC links too,
not just the new one: the app's hash router treats every `hashchange`
as a route to parse (`path.split('/')`), and a bare in-page fragment
like `#help-order` has no leading `/`, so it parses as an undefined
route and silently falls through to the deck-list default — clicking
any Help TOC link was navigating away from Help entirely instead of
scrolling to a section. Confirmed the mechanism directly (setting
`location.hash` to a bare fragment did navigate to the deck list, title
changed to "Lernin", the target section vanished from the DOM) after a
synthetic Playwright click on the same link didn't reproduce it at all
— worth noting for future verification work on this file: a headless
synthetic `.click()` on these anchors didn't trigger the browser's
native hash-navigation the way a real tap does, so this bug would have
stayed invisible to exactly that kind of test; confirming via direct
`location.hash` assignment was what actually exposed it. Fixed by
intercepting the TOC links' clicks and scrolling manually
(`scrollIntoView`), never letting them touch `location.hash` — the
standard pattern for in-page anchors inside a router-driven SPA anyway.
Re-verified: three different TOC links now scroll correctly (increasing
`scrollY`, title/hash unchanged) instead of navigating away.

### Settings page tidy-up
The API config form at the top was a raw `<form>` with no section
heading, structurally inconsistent with every block below it (all of
which use a shared `makeSection(title)` helper — a titled card).
Wrapped it in the same pattern ("AI card generation"). Also reordered:
Reading Toolkit (explicitly a side/non-core feature) was sitting
between Sound effects and Storage — moved to just above Danger zone,
so the settings that are actually about the app's core behavior
(generation, appearance, study experience, storage) all group
together first.

### Gemini generation silently failing + import UX confusion (fixed)
User report: tried an old Gemini key, generation failed, landed in
manual mode with no idea why. Root cause turned out to be three
compounding bugs, not one:

1. **`GEMINI_MODEL` defaulted to `gemini-1.5-flash-latest` — a fully
   shut-down model.** Confirmed via web search: all Gemini 1.0 and 1.5
   models return 404 as of their retirement. Every default-config
   Gemini call has been failing regardless of key validity. Updated
   default to `gemini-3.6-flash` (current GA, stable, no shutdown
   date announced as of Aug 2026) — still overridable via the
   `GEMINI_MODEL` env var without a code change. Worth revisiting
   periodically; hardcoded model IDs in a fast-moving API surface are
   an ongoing maintenance item, not a one-time fix.
2. **The frontend discarded the backend's specific error message for
   any status code other than 401/400.** Gemini failures come back as
   502 from our backend (`_call_gemini` wraps the provider's status
   code), so the actual reason ("Gemini error: 404") was thrown away
   in favor of a generic "Generation failed: 502". Fixed in api.js's
   `generateCards()` — now always tries to extract `body.detail`
   regardless of status.
3. **Double-toast, unexplained redirect to manual mode.**
   `generateCards()` emitted its own vague toast via
   `recall:generation-error` *and* `handleExtractedText()` showed a
   second generic one, then silently dropped into manual mode with no
   explanation. Restructured: `generateCards()` now returns
   `{ cards, summary, error }` instead of emitting a toast-triggering
   event (it has exactly one caller, confirmed before removing the
   emission) — one clear, specific message now: "Automatic generation
   failed: {reason} — switching to manual mode. Check your key in
   Settings, or paste the text into any AI instead."

Also addressed the broader version of the same complaint — landing in
manual mode with no context wasn't unique to the Gemini-failure path.
`renderManualJSONImport()` now takes a `reason` parameter
(`no-key`/`scanned`/`extraction-failed`/`generation-failed`/
`empty-result`/`direct`) and shows context-appropriate copy instead of
one hardcoded message that always assumed "scanned PDF or image-heavy
slides" — misleading for what's actually the most common case (no API
key configured at all).

### Import view redesign
Two more things addressed in the same pass, since they touched the
same view:
- **Upfront key-status hint.** The old flow only explained "why
  manual mode" after the fact, once you'd already uploaded something
  and hit a dead end. `renderImportView()` now checks `getApiConfig()`
  before you pick a file and shows a plain-language note ("No API key
  added — uploads will use free manual mode...") with a direct link to
  Settings, so first-time users aren't surprised.
- **Styled upload area + direct JSON-paste entry point.** The file
  picker was a bare `<input type="file">` with a thin border — no
  visual weight as an actual action. Restyled as a proper card with a
  dashed drop-zone-style button. Added a second card, "No file? Start
  from a prompt" → "Paste JSON directly", for anything with no
  document to upload at all — language learning, general topics,
  brainstormed content, anything you'd rather just describe to an AI
  than hunt for a source file first. Required a real fix, not just UI:
  the shared prompt template (`AI_PROMPT_TEXT` in manual-json-import.js)
  was hardcoded around "I will upload a document," and its placeholder
  bracket would have been copied verbatim into the prompt unfilled
  (the textarea is `readonly`, so there was no way for the user to
  edit it out). Added a `reason === 'direct'` branch that swaps in
  wording that works standalone and ends on a natural continuation
  point ("reply with your topic") rather than a broken bracket.
  Verified the substitution against the real template string, not
  just visually. Both new call-site cards verified visually in light
  and dark mode via headless Chrome before shipping.

### iOS Safari PDF upload (fixed, needs real-device confirmation)
A user reported PDF import not working on iPhone Safari. Root cause:
pdf-extract.js was loading pdf.js *and its Worker script* from jsDelivr
at runtime — cross-origin Worker/module-worker loading is a long-standing
source of browser-specific failures, and WebKit has repeatedly been
named in pdf.js's own issue tracker for exactly this failure mode
("Setting up fake worker failed", worker not loading on Safari/iOS).
Fixed by vendoring pdf.js locally (same pattern as idb/ts-fsrs), so the
worker now loads same-origin. Not pre-cached in the service worker's
install step (adds ~1.7MB, most installs may never import a PDF) — the
existing opportunistic same-origin caching picks it up after first use.
Could not be tested end-to-end in the working environment (pdf.js's
browser build needs real DOM globals unavailable in plain Node) — needs
confirmation on an actual iPhone.

### Map background/island color collision (fixed, needs visual confirmation)
User reported island circles blending into the map background. Root
cause: the map's background read the general `--bg` brand token, which
after the green rebrand is a dark green — the same hue family as
`--moss`, also the color of a fully-mastered island. Fixed with
dedicated `--map-bg`/`--map-ink` tokens (styles.css), deliberately
neutral and decoupled from the brand palette regardless of what it
becomes in a future redesign. Also added a subtle dark outline to every
island (done in an earlier session) and the activity halo above uses a
fixed hue for the same reason. Logic-level confirmed (colors compute as
intended), but actual visual contrast on a real screen needs a look.

### Map view opens to blank space / "List view" button disappears (fixed)
Two related bugs, both found while addressing the above: the camera
always started at a fixed `{x:0, y:0}` regardless of where islands
actually were, which could show empty space on open — now
`fitCameraToContent()` centers and zooms to fit everything on every
view open. Separately, the "List view" button was appended externally
from app.js after `initCanvasView()` returned, which worked on the
first open but was silently skipped by the internal path used when
returning from a study session started via the map — canvas.js now
builds the button itself on every init, so it can't be dropped by a
path app.js doesn't control.

### Audit findings from a fresh-eyes repo review (fixed)
A commit-history dig turned up several places where this file (and the
in-app Help view) had drifted from what actually shipped — worth
recording since it means this file's claims aren't self-verifying,
future sessions should spot-check against the code, not just read the
backlog.

**Fraunces display font, silently dropped.** The "Organic UI redesign"
(`7f3eb0a`) established Fraunces as the heading/title typeface via
`--font-display`, used across ~25 selectors for most of the project's
life. The later "UI/UX rewrite" commit (`e426d5d`) — which introduced
the font-selector settings feature — replaced it with system-ui as the
default and never brought `--font-display` back. `sw.js` still had the
Fraunces caching logic the whole time, just orphaned since nothing
linked the stylesheet. Restored: `--font-display` back in styles.css,
applied to the current title/header classes (skipped
`.map-path-panel-title` — an 11px all-caps micro-label, Fraunces reads
poorly that small), Google Fonts `<link>` restored in index.html.

**Leech review UI had no entry point.** `db.js`'s `resetLeech`/
`getSuspendedCards`/`getReviewHistoryForCard` were fully intact and
untouched by the rewrite, but nothing in `app.js` ever called them —
no button, no route. The Help view was actively telling users to
"review leeches from stats/leech surfaces" that didn't exist. Restored
as `renderLeechView()`, reachable via a "Leeches" action on the deck
sheet (`/leeches/:deckId`) — lists suspended cards with recent
grade-history dots and a reset action. Help/FAQ text corrected to
point at the real entry point.

**Study reminder notifications never actually fired.** The Settings
toggle and `Notification.requestPermission()` call existed, and
`db.js` had `getReminderSettings`/`markReminderShownToday`, but nothing
ever called `markReminderShownToday()` or `new Notification(...)` —
this file's Tier 3 entry above describes the feature as shipped, but
the actual firing logic didn't exist until this pass.
`checkAndShowStudyReminder()` now runs once per app open and does what
the Tier 3 description says.

**Three corrupted fallback-ID template literals.** `db.js`,
`manual-json-import.js`, and `api.js` each had a mangled fallback ID
generator — literal `\(`/`\)` characters instead of `${`/`}` — for the
rare case `crypto.randomUUID()` is unavailable. Fixed in all three;
low real-world impact since randomUUID covers virtually all modern
browsers, but worth having correct.

**`getApiConfig()` unguarded in the import flow.** The file-picker's
`change` handler called `getApiConfig()` with no try/catch — a
corrupted-IndexedDB read would fail silently with no user feedback.
Now wrapped with a toast on failure.

### Found this session, now fixed
Two more regressions from the same `e426d5d` rewrite, initially left
alone (no reported issues yet, priority was not risking breakage), then
restored once explicitly requested:

- **Export choice narrowed to full-backup only — restored.**
  `exportDeckData(deckId, { includeProgress })` in db.js always
  supported a progress-free "share copy" export, but `exportDeck()`
  in app.js never passed that option. Restored as
  `openExportOptionsSheet()` — reuses the same `.sheet`/`.sheet-backdrop`
  pattern as the deck action sheet, offers "Full backup" vs "Share copy",
  wired to the existing `includeProgress` param. `exportDeck()` now takes
  `{ includeProgress = true }` and downloads `-share.json` for the
  progress-free variant.
- **Manual JSON-paste parsing hardened.** Ported the old
  `extractJsonCandidate`/`repairUnescapedQuotes` (from commit `221e443`,
  before the rewrite dropped them) into `manual-json-import.js`,
  replacing the simpler fence-strip + naive quote-swap that had
  regressed. Handles zero-width Unicode from mobile clipboards,
  context-aware smart-quote normalization (structural delimiter vs.
  prose), and preamble/trailing text around the JSON block — plus kept
  the regressed version's one genuine improvement (trailing-comma
  repair) as an additional fallback, since the old ported version
  didn't have that. Verified against 6 representative inputs (clean
  JSON, fenced with preamble, smart quotes, zero-width + trailing comma,
  unescaped internal quote, invalid input) — all parse correctly or
  fail cleanly with the expected error.

### Relationship-type dropdown was silently broken (fixed) — critical, found during smart-planner design
While designing prerequisite-aware queuing (see below), tracing
`addRelationship()`'s exact validation turned up a live bug blocking
it entirely: the card-detail "Add relationship" dropdown sent
`depends_on`/`related_to`/`prerequisite` (snake_case, plus a third
option that doesn't exist), but `addRelationship()` in db.js only ever
accepted `dependsOn`/`related` (camelCase, two options). Every single
click has been throwing and getting silently swallowed by the
try/catch since whichever commit introduced the mismatch — meaning
almost no `dependsOn`/`related` data likely exists in real decks yet.
Fixed: dropdown now sends `dependsOn`/`related` matching what the
backend actually validates. Confirmed no other snake_case leftovers
anywhere else in the codebase. This was a hard blocker for the smart
planner (no relationship data = nothing to plan around), so it had to
be fixed first.

### PowerPoint import — verified, hardened, and now works without an API key
Asked to confirm whether .pptx import actually works: mostly, but with
real gaps, now closed.

- **Tables and speaker notes were silently dropped.** The old
  `_extract_ppt_text` only walked `shape.text`, which doesn't exist on
  table shapes (`shape.table`) or group shapes — both common in
  lecture/problem-set slides. Verified with a synthetic .pptx
  containing a title+bullets slide, a table, speaker notes, and a
  grouped textbox: only the title/bullets came through before the
  fix. Now recursively walks group shapes, extracts table cells
  (`row | cells | joined`), and appends speaker notes per slide
  (`[Speaker notes: ...]`). Re-verified against the same file — all
  four content types now extract correctly.
- **PPTX extraction was gated behind BYOK for no real reason.** Unlike
  PDF (extracted client-side via pdf.js for everyone, BYOK only gates
  the generation call after), PPTX went straight to the vision
  endpoint, which requires an API key — so manual (non-BYOK) users got
  zero pre-extraction, just "upload the file yourself to ChatGPT/
  Claude/Gemini." Added `/api/extract-ppt-text` — unauthenticated,
  rate-limited, pure parsing (no LLM call, so no key needed) — and
  routed PPTX through it first for everyone, falling back to vision
  (BYOK) or the file-name-only manual prompt (non-BYOK, unavoidable
  without OCR) only when a deck is genuinely image-heavy (<50 chars
  extracted). Manual-mode users now get the same real pre-filled
  prompt text BYOK users always got. Verified over real HTTP
  (uvicorn + curl): correct extraction, correct 400 on wrong file
  type, correct graceful empty-string on a corrupted file.
- **Added a client-side file-size pre-check** (20MB, matching the
  backend's existing limit) so an oversized file fails fast with a
  clear message instead of a wasted upload round-trip.

### Still open — found this session, not yet addressed

---

## Maintenance conventions

**Keep the in-app Help view in sync.** `app.js`'s `renderHelp()` is a
persistent, sectioned reference (not a one-time tour) covering what
Lernin is and how each feature works — reachable via the "?" button in
the header and from the first-run empty state. When a feature ships, add
or update its section there in the same pass. An out-of-date Help view
actively misleads, which is worse than not having one — it did exactly
this with leech review this session (see Active section above);
check the Help view's claims against the actual code, not just against
this file, since this file can drift too.
