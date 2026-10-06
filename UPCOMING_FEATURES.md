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

**Motion Studio audio cues (Encarta identity pivot, Phase 2)** — a
named, synthesized-tone-only vocabulary (`tick`, `pop`, `rise`,
`arrive`, `chime` — see `AUDIO_TONES` in `motion_schema.py`) an LLM can
place sparingly (max 12, typically 2-5) on a script's existing markers.
Deliberately NOT free-form frequency/duration params — an LLM has no
ear, so a small named palette with sounds actually tuned by hand (in
`sound.js`'s `playMotionCue()`, reusing the existing `playTones()`
engine) is the only way every generation shares one consistent sound
identity rather than each invention sounding different.
`motion_engine.py`'s `expand_script()` resolves cues to absolute
`{time, tone}` pairs, sorted — same marker-resolution path as every
other keyframe. `motion-player.js` stays a pure renderer: it never
plays a sound itself, just tracks a pointer into the sorted cue list
and calls `opts.onAudioCue(tone, time)` once per cue, only as real-time
forward playback crosses it (never on seek/scrub, correctly re-armed
across a loop wrap or a backward seek — verified with 15 checks in
`public/test_motion_player_audio.mjs` against real player logic with
lightweight canvas/DOM mocks and a manually-driven `requestAnimationFrame`,
no browser needed). Wired into every real player call site
(`motion-studio.js`, the Help onboarding player in `app.js`,
`motion-test.html`'s dev harness) via `onAudioCue: (tone) =>
playMotionCue(tone)` — gated by the same sound-enabled cache as every
other UI sound, no separate on/off surface. `motion-test.html` needed
its own `initSoundSetting()` call added: it's a standalone dev page
that never imports `app.js` (which is what primes that cache for the
real app), so cues would have silently no-op'd there forever without
it — a real gap caught while wiring this in, not a hypothetical one.
The shared few-shot example (`_MOTION_EXAMPLE_JSON` in `api/index.py`)
now demonstrates 4 cues synced to its existing markers; the JS mirror
of the manual-mode prompt (`buildMotionManualPrompt()` in
`motion-api.js`) was re-verified byte-identical to Python's
`build_motion_manual_prompt()` output via the documented splice-and-
diff process, not hand-retyped. 40 backend unit tests (6 new), a live
HTTP round-trip against a running local server (valid cues resolve
correctly, an unknown tone is rejected with a clear error, a script
with no `audio` field still works), and the existing `motion-test.html`
harness now audibly exercises the whole pipeline end to end. The two
already-committed onboarding script JSON assets don't have `audio` yet
— by design, deferred to a follow-up pass (see Phase 2 remaining below)
rather than bundled in here.

Still open from the same Phase 2 plan: — now that real audio actually
exists — revisiting the onboarding script's content to add cues synced
to its existing 5 beats (**done**, see below). This closes out Phase 2
entirely. Phase 3 (a MindMaze-style hidden quiz mode) stays its own
dedicated design pass, not folded into this.

**Camera fly-to on L1→L2 (Encarta identity pivot, Phase 2)** — tapping
a territory-map island used to instantly swap L1's islands for L2's
card cloud the moment `zoomLevel` flipped, before the camera had
visually arrived anywhere near the tapped spot -- a jarring content cut
rather than a "diving into the deck" feel. `flyIntoDeck()` in
`canvas.js` now holds on L1, easing the camera into the tapped island
(zoom 2.2, well within L1's existing pinch/wheel-zoom range) using the
render loop's own settle-detection (`cameraSettled`), and only then
calls the real `enterDeckView()` to start L2's own transition -- a
one-shot callback (`cameraArrivedCallback`) fired from inside
`renderLoop()` right after that frame renders, so the fully-zoomed-in
L1 frame actually shows before content swaps. A 1400ms safety timeout
guards against the callback never firing (natural settle lands
~800-1000ms regardless of starting distance, since the ease is
exponential). Two edge cases handled, not hypothetical -- both found by
tracing through what could go wrong, not by hitting them live: (1) a
mid-flight tap on the canvas destroy path (`destroyCanvasView()`) could
otherwise leave a pending `setTimeout` that fires `enterDeckView()`
against a torn-down view; (2) starting a new gesture mid-flight
(`onPointerDown()`) -- panning, pinching, tapping elsewhere -- could
otherwise leave the original commit pending and open the wrong deck
later once the camera happened to settle somewhere unrelated. Both now
cancel the pending commit/timeout. Verified with a live Playwright
render through the real app's actual navigation (a real
pointerdown+pointerup pair, not a synthetic `.click()`, per the
project's own documented lesson that synthetic clicks don't always
reproduce real interaction behavior) against a deck seeded via the
app's real `db.js` functions (`addDeck`/`saveManualCard`) -- not a
synthetic harness. Four screenshots across the transition confirm the
island genuinely grows across frames before the swap (not an instant
cut), and the final frame shows the correct breadcrumb
("Territories › [deck name]") with both seeded cards rendered as L2
nodes. Zero real console errors (two Google-Fonts-CDN failures were
sandbox network-config noise, unrelated to this change, and excluded
from the pass condition with that reasoning documented in the test
itself).

**Leech banishment animation + sound (Encarta identity pivot, Phase 2)**
— a card crossing the lapse threshold (`LEECH_LAPSE_THRESHOLD = 4` in
`scheduler.js`) used to just silently vanish from the queue with the
same 150ms sideways-swipe exit as any other grade; `gradeCard()`'s
`leech` flag on the return value was computed but never read anywhere
in `study.js`. Now that moment gets its own deliberately calmer,
slower treatment -- a settling drift-down-and-shrink
(`cardBanish`/`is-exiting-leech` in `styles.css`, 600ms vs the normal
150ms) plus a distinct descending two-note tone (`playLeechBanish()`
in `sound.js`, a fourth down with a soft, longer release -- closer in
character to `playGood()`'s warmth than `playAgain()`'s brisk "not
yet") plus a toast in the same voice as the existing Leeches Help copy
("Leeches are signals, not shame"): "Set aside for now — that's not a
fail, just a signal to come back to it differently." `result.leech`
from `gradeCard()` now threads through `handleGrade()` →
`showTeachIt()` (its Skip/Continue handlers, for completeness, even
though a lapse-driven leech realistically only ever fires on
Again/Hard, not the Good/Easy grades that route through Teach-It) →
`animateCardExit(isLeech)`, which branches on it. Confirmed
`undoLastGrade()` needed no changes: its pre-grade snapshot (taken
before `gradeCard()` runs) already restores `suspended` correctly if a
leech-triggering grade gets undone. Verified with a live Playwright
render through the real study session UI, not a synthetic harness: a
card seeded one lapse away from the threshold via the app's real
`db.js` functions, graded "Again" via the actual grade button (not a
direct function call), with the real `AudioContext.createOscillator`
instrumented to prove tones actually fired (not just "no exception
thrown") -- confirmed real oscillator calls, the card's
`suspended`/`leech`/`lapses` fields correctly updated in IndexedDB, the
toast rendered with the exact expected copy, and three screenshots
(before grading, mid-animation, after settle/session-summary)
confirming the card visually drifts and fades rather than cutting
instantly, with the toast persisting naturally into the session
summary. Zero real console errors (the same sandbox-only
Google-Fonts-CDN noise as other Playwright verifications this session,
excluded from the pass condition with that reasoning documented in the
test itself).

**Onboarding script audio cues (Encarta identity pivot, Phase 2 —
closes out Phase 2)** — the two committed onboarding assets
(`public/onboarding-script.json` and `-light.json`) were designed and
verified silent, before the audio-cue subsystem existed. Both now carry
7 audio cues, added directly to the resolved JSON (these are
already-expanded `expand_script()`-shaped output consumed straight by
`motion-player.js`, not raw `MotionScript` source with markers -- so
cues are hardcoded absolute times, not marker-relative). Times were
read directly off the asset's own existing keyframes (`traveling_dot`'s
`x` arrivals and each `nodeN`'s scale-pulse, both landing at exactly
0.5/5.5/10.5/15.5/20.5s) rather than guessed: a `tick` at each of the 5
step-arrivals, an `arrive` at 24.5s when the camera's final keyframe
settles and the closing caption begins fading in, and a single `chime`
at 25.6s as the closing caption reaches full opacity and the whole
"how Lernin works" idea lands. Confirmed both assets share byte-
identical timing before reusing one cue array for both (`diff`-level
comparison of every layer's keyframe times, scene duration, and camera
keyframes -- not assumed from the theme-pass being "just a color
swap"). Verified with a live Playwright render through the real Help
view, not a synthetic harness: real `AudioContext.createOscillator`
instrumented to record wall-clock timing of every tone (not just that
tones fired), the real onboarding JSON fetched and its `audio` array
confirmed present with all 7 cues, and the actual poster-button ▶ Play
control clicked to start real playback. The recorded oscillator timing
lines up with the intended schedule to within measurement noise:
consecutive tick spacing lands at exactly 5.0s (matching
5.5s-apart cues precisely), the arrive cue lands 4.0s after the last
tick (matching 24.5−20.5), and chime lands 1.1s after arrive (matching
25.6−24.5) -- an exact match, not just "some sound played somewhere."
One earlier, unrelated oscillator call (a UI navigation sound firing on
the route change to Help, unrelated to the video itself) showed up in
the same capture window and was accounted for rather than mistaken for
a timing bug. Three screenshots across playback (before play, mid
playback at the "Understand it first" beat, and the final frame with
all 5 nodes lit and the closing caption visible) confirm the visual
sequence still plays correctly after the edit -- adding the `audio` key
didn't disturb anything the player already reads. Zero real console
errors (same sandbox Google-Fonts-CDN noise as every other Playwright
**Territory Map Terrain Pass (UI/UX Architecture Brief §5, Step 2; §3.1 Steps 1–4)** —
shipped Build Step 2 from `UI_UX_ARCHITECTURE_BRIEF.md`, transforming the Territory
Map from abstract geometric data dots into rich, textured memory palace islands.
- **Procedural Island Silhouettes** (`public/canvas.js`): Replaced the circular
  `ctx.arc` island bodies with 14-point irregular polygons smoothed via quadratic
  splines (`islandSilhouettePoints`, `buildSilhouettePath`). The shape is seeded
  strictly from the deck's ID using deterministic multiplier hashing, ensuring
  each island's coastline is completely stable across reloads and sessions.
  The hover outline (`is-hovered`) smoothly tracks the procedural coastline with
  a 7px offset path.
- **Terrain Shading** (`public/canvas.js`): Radial elevation gradient from lighter
  "high ground" center to base midtone to a deeper "shoreline" edge, deriving stops
  from `islandColor(mastery, id)` without altering existing color decisions.
- **Texture Density Tied to Card Count** (`public/canvas.js`): `drawIslandTexture`
  scatters small tufts/marks across the island interior, scaled proportionally to
  card count (`Math.min(40, Math.round(cardCount * 0.6))`) and clipped strictly
  within the coastline boundary. A 3-card deck visibly shows sparse texture (2 dots),
  while larger decks (e.g. 30 cards) show rich density (18 dots), providing instant
  spatial feedback on deck size before reading numbers.
- **Environment Background Gradient** (`public/styles.css`, `public/canvas.js`):
  Replaced the flat canvas fill on L1 with a sky-to-horizon gradient using new
  design tokens `--map-bg-sky` and `--map-bg-horizon` across both light theme
  (`#D0DEDE` to `#E8EDE9`) and dark theme (`#0A0D10` to `#1E2830`). The L2/L3 card
  cloud views retain the uniform flat `MAP_BG` fill with zero gradient bleed.
- **LOD Path Preserved**: Zooming out below the LOD threshold (< 0.55) continues to
  use `drawIslandSimple`, rendering lightweight overview dots without degradation.
- **Verified via automated headless Chrome CDP test**:
  - Dark theme environment gradient verified via pixel sampling (sky #0A0D10 -> horizon #1E2830).
  - Silhouette determinism and pixel stability verified across browser reload (exact match on all coordinates).

**Tier 1 #1 — Formula Card Variables Render Fix (`study.js`)** —
fixed formula card back rendering when variables use the `{symbol, meaning}` shape:
- **Study Mode** (`public/study.js`):
  * In `renderBack()`, updated the variables mapping from `${v.name}: ${v.description}` to the fallback pattern used by `getHintText()` and the card editor: `${v.symbol || v.name}: ${v.meaning || v.description}`.
  * Eliminates the bug where formula card backs rendered "undefined: undefined" when variables were generated by LLMs with `{symbol, meaning}` instead of `{name, description}`.
- **Verified via automated headless Chrome CDP test**:
  * Tested formula card containing `{symbol, meaning}` variables in study mode; confirmed correct rendering (`E: Energy · m: Mass · c: Speed of light`) and absence of `"undefined"`.
  * Verified exact parity between `renderBack()` and `getHintText()`.
  * Screenshots captured in both Light and Dark themes (`formula_card_back_light.png`, `formula_card_back_dark.png`).
  * Python backend (`test_*.py`) and Node audio regression suites pass with zero regressions.

**Tier 1 #2 — Mastery Stability Threshold Standardization (`db.js`, `canvas.js`, `mind-map.js`, `app.js`)** —
aligned the mastery threshold to 30 days everywhere across the app:
- **Unified Single Source of Truth** (`public/db.js`):
  * Changed `MASTERY_STABILITY_DAYS` from 21 to 30 and exported it so all surfaces share a single threshold representing ~1 month of FSRS stability.
  * Updated `getDeckStateCounts(deckId)` to use `MASTERY_STABILITY_DAYS = 30`, ensuring a card is only counted as mastered once its stability reaches 30 days.
  * Updated comments to accurately describe alignment with canvas and mind map coloring.
- **Surface Audit & Alignment**:
  * *Territory Map* (`public/canvas.js`): Imported `MASTERY_STABILITY_DAYS` and unified `computeMastery()`, `enterDeckView()`, and `onGrade` to divide card stability by `MASTERY_STABILITY_DAYS`.
  * *Mind Map* (`public/mind-map.js`): Imported `MASTERY_STABILITY_DAYS` and updated node layout to divide stability by `MASTERY_STABILITY_DAYS`.
  * *Home Deck Tiles* (`public/app.js`): Imported `MASTERY_STABILITY_DAYS` and updated `buildDeckTile()` to check `(c.stability || 0) >= MASTERY_STABILITY_DAYS`.
- **Verified via automated headless Chrome CDP test**:
  * Tested card stability boundary in IndexedDB: card with stability 25 correctly excluded from mastered count (classified as in-progress), while cards with stability >= 30 counted as mastered.
  * Parity verified between `getDeckStateCounts`, `getDashboardStats`, and Home screen deck tile progress bar.
  * Screenshots captured in both Light and Dark themes (`mastery_deck_tile_light.png`, `mastery_deck_tile_dark.png`).
  * Python backend (`test_*.py`, 64/64 passing) and Node audio regression suites pass with zero regressions.

**Tier 1 #3 — Daily Review Soft Cap & Overdue-First Ordering with Continue Loop (`db.js`, `study.js`, `spatial-study.js`, `app.js`, `styles.css`)** —
implemented soft review cap (default 50) + new-card cap (default 20) with overdue-first ordering and completion continue loop:
- **Single Source of Truth & Settings** (`public/db.js`):
  * Corrected stale comment on `getCardsDueTodayOrEarlier()`: scheduler owns memory math while queue capping and overdue-first ordering live in `interleaveQueue()` (`study.js`).
  * Exported `DEFAULT_DAILY_REVIEW_CAP = 50` and `DEFAULT_NEW_CARD_CAP = 20`.
  * Allows user override via `getSetting('dailyReviewCap')`.
- **Queue Assembly & Study Session Flow** (`public/study.js`):
  * Updated `interleaveQueue(cards, { reviewCap, newCap })` to sort reviews by `due_date ASC` (oldest / most overdue first) and clamp reviews to `reviewCap` and new cards to `newCap`.
  * In `startStudySession(container, opts)`: reads `reviewCap` (respecting `opts.reviewCap` and `dailyReviewCap` setting), ensures explicit `startCardId` (jump-to-card) is prepended to the queue even if cut off by the soft cap, and awaits `showCard()`.
  * On session completion (`renderSessionSummary()`): checks if cards remain due (`getCardsDueForDeck` or `getCardsDueTodayOrEarlier`); if so, renders warm backlog messaging ("Daily focus target reached! N cards remain in your backlog.") with action buttons: `#continueStudyBtn` ("Study another N", where N = min(25, remaining due)) and `#finishTodayBtn` ("Finish for today").
- **Spatial Review Parity** (`public/spatial-study.js`):
  * Path-based spatial review (`pathNodeIds`) remains intentionally uncapped (respecting the user's explicit path selection).
  * Non-path spatial deck review applies the same `interleaveQueue` soft cap (70 cards total = 50 reviews + 20 new) for parity with standard study mode.
- **Home Framing & Honest Stats Strip** (`public/app.js`, `public/styles.css`):
  * Home hero CTA displays focus framing when `dueToday > reviewCap`: title "50 cards to study today", subtitle note "... · N total in backlog". When `dueToday <= reviewCap`, displays exact count.
  * Stats strip maintains honesty by reporting the true total due count (`📚 N due`).
  * Added `.session-summary-btn-secondary` in `styles.css` for the secondary finish CTA.
- **Verified via automated headless Chrome CDP test**:
  * Tested with 80 overdue reviews and 30 new cards: verified `interleaveQueue` assembled exactly 70 cards (50 review + 20 new), reviews ordered strictly by `due_date ASC`, and `startCardId` rendered first at index 0.
  * Spatial study verified: non-path capped at 70 ("1 / 70"), path uncapped at 60 ("1 / 60").
  * Home screen verified: hero shows focus framing ("50 cards to study today" + "110 total in backlog"), stats strip shows true total (110 due).
  * Completion screen verified: displays focus target message, "Study another 25", and "Finish for today".
  * Continue loop verified: clicking "Study another 25" smoothly starts the next batch in the active study container.
  * Screenshots captured in both Light and Dark themes (`study_completion_backlog_light.png`, `study_completion_backlog_dark.png`).
  * Python backend tests (64/64 passing) and Node audio regression suites pass with zero regressions.

**Tier 1 #4 — Document / PDF Text Chunking with Per-Card Provenance (`api/text_chunker.py`, `api/index.py`, `pdf-extract.js`, `api.js`, `db.js`, `app.js`)** —
implemented authoritative backend text chunking for long documents and PDFs with per-card provenance:
- **Zero-Dependency Backend Chunker** (`api/text_chunker.py`, `api/index.py`):
  * Authoritative server-side chunking: splits text into ~14,000-character chunks with ~800-character overlap, prioritizing paragraph boundaries (`\n\n`), newlines, and sentence breaks.
  * Extracted page markers (`--- Page N ---` or `[Page N]`) into formatted ranges (`p. 3` or `pp. 1–5`).
  * Enforces `MAX_CHUNKS = 5` and hard stop of 40 cards total per upload (`MAX_CARDS_PER_UPLOAD = 40`).
  * When text exceeds 5 chunks, generates from the first 5 and returns a warm, encouraging warning: *"This document is extensive! We turned the first 5 sections into bite-sized cards so you can master them without overwhelm."*
  * Attaches optional `sourceInfo: { chunkIndex, totalChunks, pageRange }` to each generated card.
  * Shared generator helper `_generate_cards_from_text` unified across standard `/api/generate-cards` and PowerPoint extraction in `/api/generate-cards-vision`.
- **Client Extraction & Page Marker Preservation** (`public/pdf-extract.js`):
  * Preserves explicit page markers (`--- Page ${pageNum} ---\n${pageText}`) during client-side PDF extraction so the backend chunker can tag cards with their source page range.
  * Removed phantom "backend chunk_text()" comment in favor of accurate documentation.
- **Intra-Batch & Cross-Deck Deduplication** (`public/api.js`):
  * Extended `dedupeAgainstDeck` with `seenTokenSets` tracking to simultaneously eliminate duplicate concepts generated across overlapping chunks within the same batch.
  * Surfaces backend `warning` on `generateCards` return payload and emits in `recall:generation-success` event.
- **Card Persistence & Provenance Display** (`public/db.js`, `public/app.js`):
  * Persists `sourceInfo` in IndexedDB (`cards` store) in both `saveNewCards` and `saveManualCard` without requiring a schema version bump.
  * In `handleExtractedText`, displays warm server warning toast for 6s when present.
  * In PDF extraction, displays soft preliminary notice for substantial texts (>100,000 chars) without blocking.
  * In card review step (`renderEditStep`), renders clean `.card-provenance-tag` badges (`pp. 1–3 · Section 1 of 3` or `Section 1 of 2`) above the card front in both Light and Dark themes.
- **Verified via automated unit & headless Chrome CDP tests**:
  * Added 11 comprehensive unit tests in `api/test_text_chunker.py` verifying single/multi-chunk splitting, overlap preservation, paragraph boundary preference, page range detection, 40-card hard cap, and truncation warnings (all 75 backend tests passing).
  * Headless Chrome CDP verified: IndexedDB `sourceInfo` persistence, intra-batch deduplication, and card edit step provenance badge rendering in both Light and Dark themes (`card_provenance_edit_light.png`, `card_provenance_edit_dark.png`).
  * Node audio test suite (`test_motion_player_audio.mjs`) and Python backend test suite (`test_*.py`) pass cleanly with zero regressions.

**Tier 1 #5 — Deck Cascade Deletion Across Orphan Stores (`public/db.js`)** —
extended `deleteDeck(deckId)` to cascade-delete all deck-scoped and card-scoped records across all associated IndexedDB stores in a single atomic transaction:
- **Full Store Coverage & Atomic Single-Transaction Guarantee** (`public/db.js`):
  * Previously, `deleteDeck()` only deleted records from `decks`, `cards`, and `documents` (plus a best-effort, detached `territoryLayout` delete), leaving orphan rows in 7+ other stores that permanently inflated stats queries and relationship lookups.
  * Extended `deleteDeck()` to operate across all 14 stores within a single atomic `readwrite` transaction:
    - `decks`: removes the deck record.
    - `cards`: removes all cards belonging to the deck (`by_deckId`).
    - `documents`: removes all uploaded document summaries for the deck (`by_deckId`).
    - `reviewLog`: deletes all review history entries for cards in this deck (`by_cardId`), preventing permanent lifetime review and leech count inflation.
    - `cardRelationships`: deletes all incoming and outgoing prerequisite and related edges (`by_fromCardId` and `by_toCardId`) pointing to or from any card in the deck, eliminating dangling graph pointers.
    - `documentMindMaps`: deletes all document mind maps belonging to this deck's documents (and direct deckId key fallback).
    - `motionScripts`: deletes all motion graphics scripts belonging to the deck (`by_deckId`).
    - `studyPaths`: deletes all spatial study paths scoped to the deck (`by_deckId`).
    - `landmarks`: deletes all spatial landmarks for the deck (`by_deckId`).
    - `annotations`: deletes all text and freehand canvas annotations for the deck (`by_deckId`).
    - `territoryLayout`: deletes user-dragged island positions on the Territory Map (`islandId = deckId`), now cleanly part of the atomic transaction rather than silently swallowed.
    - `conceptLayouts`: deletes concept graph node position overrides for all cards in the deck.
    - `genQueue` & `motionGenQueue`: clears pending offline card and motion generation requests scoped to the deck.
  * Preserved `archiveDeck` / `unarchiveDeck` semantics: archiving strictly toggles the `archived` boolean flag without deleting records.
  * Preserved global device settings: `settings` store is untouched.
- **Verified via automated headless Chrome CDP test**:
  * Seeded sample rows across all 14 stores for a test deck (`deck-to-delete`), a preserved deck (`deck-to-keep`), and an archive test deck (`deck-to-archive`).
  * Confirmed `archiveDeck()` toggles `archived: true` while preserving 100% of cards and review logs.
  * Confirmed `deleteDeck()` reduces rows to exactly 0 across all 14 stores for `deck-to-delete`, with zero dangling card relationships.
  * Confirmed all rows for `deck-to-keep` remain completely intact.
  * Captured UI screenshots in both Light and Dark themes (`deck_deleted_decklist_light.png`, `deck_deleted_decklist_dark.png`).
  * Python backend tests (75/75 passing) and Node audio regression suites pass with zero regressions.

**Tier 1 #6 — Leech Flag Restoration on Undo (`public/study.js`)** —
restored the `leech` flag alongside `suspended` in `undoLastGrade()`, ensuring cards undone after triggering a leech state cleanly revert back to unleeched, active status:
- **Consistent Leech Reversion on Undo** (`public/study.js`):
  * Previously, `handleGrade()` snapshotted only `{ card: JSON.parse(JSON.stringify(card)), grade, index }` and `undoLastGrade()` restored `state`, `difficulty`, `stability`, `reps`, `lapses`, `last_review`, `due_date`, and `suspended`, but omitted `leech`.
  * If a grade (e.g. 4th lapse on "Again") triggered leech banishment, `gradeCard()` set both `suspended: true` and `leech: true`. Calling `undoLastGrade()` then set `suspended: false`, but left `leech: true` permanently in IndexedDB. As a result, the card looked like a leech in queries and views while continuing to study normally as an unsuspended card.
  * Explicitly captured `snapshotCard.suspended = snapshotCard.suspended ?? false` and `snapshotCard.leech = snapshotCard.leech ?? false` in the pre-grade snapshot before any grading or leech mutations run.
  * Extended `undoLastGrade()` to pass `{ suspended: card.suspended ?? false, leech: card.leech ?? false }` into `updateCardAfterReview(card.id, ...)`.
  * Preserved all leech detection thresholds (`LEECH_LAPSE_THRESHOLD = 4`), banishment animations, Teach-It flows, and normal review queue behavior.
- **Verified via automated headless Chrome CDP test**:
  * Real-path study flow verified: card with 3 lapses graded "Again" transitioned to 4 lapses, `suspended: true`, and `leech: true` with banishment animation.
  * Undoing the grade restored the card to 3 lapses, `suspended: false`, and `leech: false` in IndexedDB.
  * Confirmed the undone card returned immediately to the study queue and was active/studyable on screen.
  * Confirmed query `getSuspendedCards()` returned 0 cards after undo.
  * Verified non-leech review undo regression (grading "Good" and undoing cleanly preserves card state with `suspended: false, leech: false`).
  * Captured UI screenshots in both Light and Dark themes (`undo_leech_restored_light.png`, `undo_leech_restored_dark.png`).
  * Python backend test suite (75/75 passing) and Node audio regression suites pass with zero regressions.

**Tier 1 #7 — Service Worker Offline Shell Completeness and Waiting-Worker Update Prompt (`public/sw.js`, `public/app.js`, `public/styles.css`, `public/index.html`)** —
completed the offline shell asset list and implemented the standard waiting-service-worker update prompt so returning users get notified when a new version is ready rather than silently serving stale cache:
- **Shell Asset Completeness (`public/sw.js`)** — `SHELL_ASSETS` bumped from 17 entries to 38, covering every app module required for a true offline cold start:
  * Added (previously missing): `secrets.js`, `json-repair.js`, `motion-studio.js`, `motion-player.js`, `motion-api.js`, `motion-manual-import.js`, `mind-map-doc.js`, `mind-map-doc-api.js`, `mind-map-doc-manual-import.js`, `onboarding-script.json`, `onboarding-script-light.json`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png`.
  * Removed: `/concept-graph.js` (file is a deprecated stub with a comment saying "DEPRECATED — functionality absorbed into canvas.js L2/L3"; no live imports reference it from routing code; kept in the tree for Tier 2 #6 removal decision).
  * Reordered: HTML/CSS/manifest moved to top of list for visual clarity; `styles.css` and `manifest.json` moved earlier.
  * `vendor/pdf.min.mjs` and `vendor/pdf.worker.min.mjs` deliberately excluded (~1.7 MB combined): `pdf-extract.js` itself documents this choice — most installs never import a PDF; the SW's opportunistic same-origin cache handler precaches them on first actual use.
  * KaTeX vendor files (CSS, JS, fonts, `auto-render.min.js`) deliberately excluded: KaTeX is loaded via `<script defer>` tags in `index.html` with cross-origin fonts from `fonts.gstatic.com`; the fetch handler already caches both same-origin and `fonts.gstatic.com` responses opportunistically; inclusion in `cache.addAll` would require managing 20+ font files explicitly.
- **CACHE_VERSION bump** — `'lernin-shell-v25'` → `'lernin-shell-v26'`. Comment updated to accurately describe the new bump-and-prompt workflow rather than the old manual-bump-only note.
- **Waiting Worker Update Prompt** (`public/sw.js`, `public/app.js`, `public/styles.css`):
  * `self.skipWaiting()` removed from the `install` event — new workers now wait rather than immediately taking over.
  * Added `message` event listener: when the active page posts `{ type: 'SKIP_WAITING' }`, the worker activates and claims clients.
  * `initServiceWorker()` added to `app.js`: registers `/sw.js`, wires `controllerchange` → page reload (only if `__swUserApprovedRefresh` is set), and handles both the "already waiting" and "updatefound → installed" cases.
  * `showUpdatePrompt(waitingWorker)` added to `app.js`: injects a `.toast.update-prompt` element into the `.toast-container` with text *"New version ready — refresh?"*, a green "Refresh" button (posts `SKIP_WAITING`, disables itself, triggers controlled reload), and a muted "Later" link that dismisses cleanly with the existing `toastOut` animation.
  * `@keyframes toastIn` / `@keyframes toastOut` added to `styles.css` (they were referenced by the toast classes but never defined — a pre-existing gap surfaced by the new prompt's dismiss animation).
  * All new prompt styles in `.update-prompt`, `.update-prompt-text`, `.update-prompt-actions`, `.update-prompt-btn`, `.update-prompt-dismiss` added to `styles.css`.
  * SW registration script removed from `index.html` (was inline `<script>`); registration now lives exclusively in `initServiceWorker()` inside the module graph, keeping SW lifecycle in one place.
- **Verified via automated headless Chrome CDP test**:
  * Cache inspection (`lernin-shell-v26`): all 32 precached entries confirmed present; `/concept-graph.js` confirmed absent.
  * Update prompt: element rendered with correct warm text, both "Later" (dismiss with animation) and "Refresh" (skipWaiting called, button disabled, `__swUserApprovedRefresh` set) flows verified.
  * Offline cold-start smoke: with `Network.emulateNetworkConditions offline=true`, navigation to `#/motion/:deckId` rendered the Motion Studio topic-input (`#msTopicInput`), navigation to `#/mind-map-doc/:docId` handled gracefully; dynamic imports of `motion-player.js`, `motion-api.js`, `motion-manual-import.js`, `secrets.js`, and `json-repair.js` all resolved from cache without network.
  * Screenshots captured in both Light and Dark themes (`sw_update_prompt_light.png`, `sw_update_prompt_dark.png`).
  * Python backend test suite (75/75 passing) and Node audio regression suites pass with zero regressions.

**Tier 1 #8 — Motion Studio Emphasis Exit Timing Clamped (`api/motion_engine.py`, `api/test_motion_engine.py`)** —
clamped emphasis layer exit timing to ensure late-appearing emphasis elements complete their fade-out at or before `scene.duration` instead of freezing on screen:
- **Root Cause & Behavior** (`api/motion_engine.py`):
  * `motion_engine.py` computed an emphasis layer's exit fade at `at + hold + 0.25s` via `_add_point()` directly, bypassing the duration boundary checks applied to manual keyframes.
  * In `motion-player.js`, playback stops/clamps at `scene.duration`. When an emphasis layer appeared late in a scene (such as `at = 4.0s` with default `hold = 0.9s` on a 5.0s scene, pushing the exit fade to `5.15s`), the entrance animation ran, but playback froze at `t = 5.0s` while the element was still at 94%–100% opacity, causing it to freeze permanently on screen.
- **Timing Clamping Fix** (`api/motion_engine.py`):
  * When `at + hold + 0.25 > scene.duration`, clamp `hold = max(0.0, scene.duration - at - 0.25)`, scheduling `exit_start = at + hold` and `exit_end = min(scene.duration, exit_start + 0.25)`.
  * If `exit_end > exit_start`, opacity smoothly fades from 1.0 down to 0.0 (and scale to 0.85) reaching completion exactly at `exit_end <= scene.duration`. If `exit_end <= exit_start`, final opacity 0.0 and scale 0.85 are applied at `exit_end`.
  * Added `add_point(prop, t, val, easing)` helper that caps all emphasis keyframe points at `min(scene.duration, t)`, preventing any entrance or exit beat from ever overrunning `scene.duration`.
- **Verified via Unit Tests & Headless Chrome CDP**:
  * Added 3 unit tests in `TestEmphasisExpansion` (`api/test_motion_engine.py`):
    - `test_late_emphasis_exit_clamped_to_scene_duration`: verifies `at=4.0`, default `hold=0.9` on 5.0s scene clamps hold to 0.75s, exits at 5.0s, opacity reaches 0.
    - `test_late_emphasis_explicit_large_hold_clamped`: verifies explicit `hold=2.0` at `at=4.2` clamps hold to 0.55s, exits by 5.0s with opacity 0.
    - `test_very_late_emphasis_exit_shortened_within_duration`: verifies `at=4.85` on 5.0s scene sets hold to 0.0s, exit completes within 5.0s with opacity 0.
  * Full Python backend test suite passed: 78/78 tests passing (up from 75).
  * Node audio regression suite (`node public/test_motion_player_audio.mjs`) passed with zero regressions.

**Tier 4 #4 — Motion Studio → SRS Bridge (1–2 Recall Cards Per Script) (`public/motion-card-extract.js`, `public/motion-studio.js`, `public/motion-player.js`, `public/styles.css`, `public/sw.js`, `public/test_motion_card_extract.mjs`, `UPCOMING_FEATURES.md`)** —
shipped optional, user-confirmed bridge feeding Motion Studio explainers into the SRS review queue without duplicating mind-map cards or auto-writing unreviewed flashcards:
- **Pure Recall Card Extractor (`public/motion-card-extract.js`)**:
  * Pure synchronous, zero-dependency, offline-first helper `extractMotionRecallCards(script, topic, opts)`.
  * Extracts 1–2 draft recall cards strictly grounded in the animation script:
    - Cloze cards when an emphasis layer matches a key term in an explainer caption.
    - Formula cards from KaTeX formula layers (`format: 'formula'`) with math syntax intact.
    - Conceptual process cards from sequential captions and topic prompts.
  * Strictly non-mutating (`Object.freeze`-safe), hard-capped at $\le 2$ cards (default 1 card; reveals optional 2nd card affordance only when the script contains a formula layer or distinct secondary emphasis/caption).
  * Automatically tags `sourceInfo: { type: 'motion', scriptId, topic }` on save; strictly avoids stamping `fidelityFlag` on motion-derived cards.
- **Motion Studio Post-Watch & Saved Library Integration (`public/motion-studio.js`, `public/styles.css`)**:
  * **Post-Watch Bridge Affordance (`showPostWatchCard`)**: Renders warm primary CTA `🌿 Turn into study card` (`#msStudyBridgeBtn`) on explainer completion.
  * **Source-Card Suppression**: When `sessionStorage` contains `MOTION_SOURCE_CARD_KEY` (`'lernin:motionStudioSourceCardId'` from an "Explain with motion" mind-map node flow), the bridge button is cleanly suppressed to prioritize `← Back to card on Mind Map` and prevent duplicate cards.
  * **Saved Explainer Drawer (`refreshScriptList`)**: Adds `🌿 Create card` button (`.ms-create-card-btn`) to every saved script row with an inline collapsible drawer (`.ms-script-card-drawer`).
  * **Interactive Draft Panel (`renderBridgeDraftPanel`)**: Inline editing of Front/Back fields, type badges (`CLOZE`, `FORMULA`, `BASIC`), `+ Add a second card` button, and card removal.
  * **Global Route Deck Target (`#/motion`)**: When accessed without a deck context (`deckId` null), dynamically presents an active deck selector (`getActiveDecks()`), keeping the Add button disabled until a deck is chosen.
  * **FSRS Lifecycle Integrity**: Explicit user tap writes to IndexedDB via `saveNewCards(deckId, cards)` with clean default FSRS scheduling parameters (`state: 'new'`, `difficulty: 0`, `stability: 0`, `reps: 0`, `lapses: 0`, `last_review: null`, `due_date: Date.now()`, `suspended: false`).
- **Player Thumbnail Tree Recursion Guard (`public/motion-player.js`)**:
  * Fixed `childrenOf(layers, parent)` to require `parent && parent.name`, preventing an exponential $3^{25}$ call stack recursion freeze when rendering thumbnails for scripts whose layers lack explicit `name` attributes.
- **Service Worker Shell Registration (`public/sw.js`)**:
  * Registered `'/motion-card-extract.js'` in `SHELL_ASSETS` and bumped `CACHE_VERSION` to `'lernin-shell-v31'`.
- **Permanent Test Suite & Headless Chrome CDP Verification**:
  * Added `public/test_motion_card_extract.mjs` with 6 unit tests covering captions, formulas, cloze extraction, fallback resilience, Object.freeze non-mutation, and the 2-card ceiling.
  * Verified end-to-end via headless Chrome CDP with 7 automated assertions and captured screenshots in Light and Dark themes (`motion_srs_bridge_draft_light.png`, `motion_srs_bridge_draft_dark.png`).

**Tier 4 #1 — Cheap Verification Pass on Generated Cards (Flag Only, Never Auto-Fix) (`public/card-fidelity.js`, `public/db.js`, `public/app.js`, `public/manual-json-import.js`, `public/styles.css`, `public/sw.js`, `public/test_card_fidelity.mjs`, `UPCOMING_FEATURES.md`)** —
shipped client-side verification pass on newly generated and imported cards that flags unverified content against source text without auto-fixing or rewriting card text:
- **Pure Deterministic Verifier (`public/card-fidelity.js`)**:
  * Zero remote calls, zero bundler dependencies, pure synchronous check running offline-first in `/public`.
  * Checks substantive entities, technical terms, cloze blanks (`{{cN::term}}`), and formula variables against source document text.
  * Stamps `fidelityFlag: { status: 'unverified', reason: '...', flaggedAt: Date.now() }` on cards whose key terms cannot be grounded in the source text.
  * Preserves full FSRS lifecycle integrity; `fidelityFlag` is an inert metadata property ignored by `scheduler.js`, `study.js`, and `reviewLog`. Cards retain clean default FSRS scheduling fields (`state: 'new'`, `difficulty: 0`, `stability: 0`, `reps: 0`, `lapses: 0`, `last_review: null`, `suspended: false`).
- **Warm Review Step UX (`renderEditStep` in `public/app.js`)**:
  * Unverified cards remain selected by default in `renderEditStep` so user agency is respected.
  * Renders warm amber alert banner (`.card-fidelity-banner`) with brand-aligned rescuing copy: `🌿 Double-check source` ("Some details in this card weren't found in your uploaded text. We couldn't confirm this in your upload, but it might still be great to learn.").
  * Inline "Edit" action opens textarea editors for front and back; saving edits marks the flag dismissed and refreshes the card.
  * "Keep anyway" action dismisses the banner immediately with a toast notification.
- **Card Browser & Detail View Integration (`public/app.js`, `public/styles.css`)**:
  * Per-deck card browser displays subtle `🌿` indicator on tile corners (`.card-tile-fidelity`) for unverified cards.
  * Card detail view renders fidelity banner with inline Edit and Keep anyway actions.
  * Database helpers `dismissCardFidelity(cardId)` and `updateCardContent(cardId, updates)` allow permanent dismissal or text updates in IndexedDB.
- **Study Mode Silence**:
  * Study Mode completely ignores fidelity flags during active recall; zero banners, zero badges, and zero interruptions on card face.
- **Service Worker Shell Registration (`public/sw.js`)**:
  * Registered `'/card-fidelity.js'` in `SHELL_ASSETS` and bumped `CACHE_VERSION` to `'lernin-shell-v30'`.
- **Permanent Test Suite & Real-Path Headless Chrome CDP Verification**:
  * Added `public/test_card_fidelity.mjs` with 10 comprehensive unit tests covering basic cards, cloze blanks, formula variables, case/punctuation insensitivity, empty text handling, and batch operations.
  * Verified via automated headless Chrome CDP script (`fidelity_p1_editstep_light.png`, `fidelity_p1_editstep_dark.png`, `fidelity_p1_cardbrowser_light.png`, `fidelity_p1_detailview_light.png`, `fidelity_p1_studymode_light.png`) confirming 8 real DOM and IndexedDB assertions across Light and Dark themes.

**Explain with Motion (Card Mind Map) — Phase 4 Polish: Post-Watch Back Link to Source Card (`public/motion-studio.js`, `public/mind-map.js`, `public/motion-topic.js`, `public/styles.css`, `public/sw.js`, `public/test_motion_topic_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
shipped Phase 4 polish (post-watch navigation back to originating card on the Card Mind Map):
- **Post-Watch Back Link in Motion Studio (`showPostWatchCard` in `public/motion-studio.js`)**:
  * Reads `MOTION_SOURCE_CARD_KEY` (`'lernin:motionStudioSourceCardId'`) from `sessionStorage` alongside active `deckId`.
  * When source card is present, renders a warm secondary action button: `← Back to card on Mind Map` (`#msBackToCardBtn`).
  * On click: sets `MIND_MAP_FOCUS_CARD_KEY` (`'lernin:mindMapFocusCardId'`) in `sessionStorage`, cleans up `MOTION_SOURCE_CARD_KEY` to avoid stale links, destroys the active player, and navigates back to `#/mind-map/${deckId}`.
  * When `MOTION_SOURCE_CARD_KEY` is missing (doc-map or Studio-started flows), the back link is completely omitted with zero broken controls.
- **Auto-Focusing Source Card on Mind Map Re-entry (`renderMindMap` in `public/mind-map.js`)**:
  * On load, reads and single-shot clears `MIND_MAP_FOCUS_CARD_KEY` from `sessionStorage`.
  * If a matching node is found, centers the camera on `(targetNode.x, targetNode.y)` and immediately opens `openNodeDetail(targetNode)`.
- **Shell Parity & Styles (`public/styles.css`, `public/sw.js`)**:
  * Added `.ms-back-to-card-btn` styling to `public/styles.css` matching Lernin's warm tactile button aesthetic in Light and Dark themes.
  * Bumped `CACHE_VERSION` to `'lernin-shell-v29'` in `public/sw.js`.

**Explain with Motion (Card Mind Map) — Phase 3: Bounded Context Pack & Motion Studio Prefill Handoff (`public/motion-topic.js`, `public/mind-map.js`, `public/sw.js`, `public/test_motion_topic_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
shipped Phase 3 (bounded context pack assembly when `Include deck context` is checked, `MOTION_PREFILL_KEY` + `MOTION_SOURCE_CARD_KEY` `sessionStorage` handoff, `#/motion/:deckId` hash navigation without importing `app.js`, and service worker shell cache registration for `/motion-topic.js`):
- **Bounded Context Pack & Final Topic Composer (`public/motion-topic.js`)**:
  * Exports `MOTION_SOURCE_CARD_KEY = 'lernin:motionStudioSourceCardId'`, `MAX_CONTEXT_PACK_CHARS = 360`, `unmaskCardFrontForContext`, `buildCardMotionContextPack`, and `composeCardMotionFinalTopic`.
  * When `includeContext === false` (default): `composeCardMotionFinalTopic` returns the exact trimmed `editedTopic` with zero context appended.
  * When `includeContext === true`: builds a bounded context string ($\le 360$ chars) containing `Deck: <deckTitle>`, up to 3 connected neighbor card fronts (`dependsOn` prioritized before `related`) with `{{cN::answer::hint}}` cloze syntax unmasked to plain text (`unmaskCardFrontForContext`), and an optional concise document summary snippet only when connected neighbors are sparse ($< 3$) and a document summary exists for the deck (`getDocumentsByDeck`). Never includes card backs or full deck dumps.
- **Motion Studio Prefill Handoff (`public/mind-map.js` & `public/sw.js`)**:
  * Clicking `#mmMotionGenerateBtn` inside `openNodeDetail` writes `finalTopic` to `sessionStorage.setItem(MOTION_PREFILL_KEY, finalTopic)` and `String(node.card.id)` to `sessionStorage.setItem(MOTION_SOURCE_CARD_KEY, ...)`, then navigates to `#/motion/:deckId` via `window.location.hash` (preserving strict zero-`app.js`-import hierarchy) where Motion Studio consumes `MOTION_PREFILL_KEY`, populates `#msTopicInput`, and initiates generation/manual-prompt flow.
  * Registered `'/motion-topic.js'` in `SHELL_ASSETS` and bumped `CACHE_VERSION` to `'lernin-shell-v28'` in `public/sw.js`.

**Explain with Motion (Card Mind Map) — Phase 2: Node Detail Panel UX (`public/mind-map.js`, `UPCOMING_FEATURES.md`)** —
shipped Phase 2 (Explain with motion section inside `openNodeDetail` in `public/mind-map.js` with local deterministic topic prefill, source-branch badge, conditional `isThin` helper nudge, default-unchecked `Include deck context` checkbox, and Generate button stub); **Phases 3–4 remain open** (Phase 3: Optional deck context pack assembly & `MOTION_PREFILL` handoff to Motion Studio; Phase 4: SW shell & end-to-end polish):
- **Node Detail Panel UX (`openNodeDetail` in `public/mind-map.js`)**:
  * Imports `resolveCardMotionTopic` strictly from `./motion-topic.js` with zero `app.js` imports and zero network/LLM requests on node tap.
  * Renders `.mm-explain-motion-section` containing an editable topic `<input id="mmMotionTopicInput">` prefilled with `resolveCardMotionTopic(node.card, currentDeckTitle).topic` and a branch indicator pill (`.mm-motion-branch-pill` for `Formula card`, `Cloze card`, `Card topic`, or `Deck fallback`).
  * Conditionally renders a warm rescuing helper banner (`.mm-motion-thin-badge`) when `isThin === true` (`referential_fragment`, `bare_formula_without_variables`, `empty_front`, or `too_short`).
  * Renders the `Include deck context (related cards & summary)` checkbox (`#mmMotionIncludeContext`) strictly **OFF (unchecked) by default**.
  * Includes `#mmMotionGenerateBtn` (`🎬 Generate motion explainer`), preparing `p.__preparedMotionRequest` and dispatching `lernin:mind-map-motion-prepare` without navigating until Phase 3 wires `MOTION_PREFILL_KEY` and context assembly.

**Explain with Motion (Card Mind Map) — Phase 1: Deterministic Local Topic Resolver (`public/motion-topic.js`, `public/test_motion_topic_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
shipped Phase 1 (`resolveCardMotionTopic` pure local extractor and permanent Node test suite); **Phases 2–4 remain open** (Phase 2: Card Mind Map node detail panel UI, editable topic field & thin-topic nudge; Phase 3: Optional context pack & `MOTION_PREFILL` handoff to Motion Studio; Phase 4: SW shell & end-to-end verification):
- **Pure Local Topic Extraction (`resolveCardMotionTopic` in `public/motion-topic.js`)**:
  * Zero network/LLM calls and zero `app.js` or DOM imports; strictly non-mutating on input card records.
  * **Formula branch (`sourceBranch: 'formula'`)**: Prioritizes `card.variables` (`symbol`/`name` + `meaning`/`description`) alongside stripped `front` and `cleanFormulaText(card.formula)`; falls back cleanly when variables are absent and flags bare formulas (`thinReason: 'bare_formula_without_variables'`).
  * **Cloze branch (`sourceBranch: 'cloze'`)**: Strips `{{cN::answer::hint}}` markup via `parseClozeMarkup`, combining unique blanked terms with the full reconstructed surrounding sentence.
  * **Basic branch (`sourceBranch: 'basic'`)**: Strips common interrogative quiz stems (`What is...`, `Define...`, `How does...`, trailing `?` and `____`) via `stripQuizQuestionStem`, while flagging short or referential prompts (`isThin: true`, `thinReason: 'referential_fragment' | 'too_short'`) and appending `deckTitle` when helpful.
  * **Empty front fallback (`sourceBranch: 'fallback'`)**: Gracefully resolves empty/whitespace fronts using `deckTitle` and/or a concise `card.back` snippet (`isThin: true`, `thinReason: 'empty_front'`).

**MindMaze v1 — Phase 4 (Vertical Slice Complete): Day-Scoped Persistence, `#/maze/:deckId` Route, Entry Points & SW Shell (`public/mind-maze.js`, `public/app.js`, `public/canvas.js`, `public/sw.js`, `public/test_mind_maze_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
completed all 4 phases of MindMaze v1 as a pure side-mode fog-of-war territory exploration experience (does not count as formal reviews and never alters FSRS schedules or `reviewLog`):
- **Day-Scoped Persistence & Bounded Attempts Ring Buffer (`public/mind-maze.js`)**:
  * Added `getMazeSettingKey(deckId)` (`mindMaze:<deckId>`), `buildNextDeckMazeState(prevRecord, params)`, and `saveDeckMazeAttempt(deckId, params)` persisting into IndexedDB `settings` (`mindMaze:<deckId>` and mirrored in `mindMazeState.byDeck[deckId]`) with zero `DB_VERSION` bump.
  * On gate unlock (`Hard` / `Good` / `Easy`), appends `cardId` to today's `clearedCardIds` (`dayKey: YYYY-MM-DD`) and records `{ cardId, grade, outcome, dayKey, timestamp }` in `attempts` (pruned beyond 30 days and bounded to `MAZE_MAX_ATTEMPTS = 200`).
  * Reloading or re-entering `#/maze/:deckId` on the same calendar day restores `CLEARED` chambers, promotes adjacent `FOGGED` successors to `FRONTIER`, and restores `SANCTUARY` state if all chambers were already cleared today.
  * On a new calendar `dayKey`, previous `clearedCardIds` are ignored/discarded so fresh fog rolls back in automatically.
- **SPA Routing, Entry Points, Archived Deck Badge & Help Documentation (`public/app.js`, `public/canvas.js`, `public/sw.js`)**:
  * Wired `#/maze/:deckId` route (`enterMindMaze`) in `public/app.js`, with entry points in the deck action bottom sheet (**🧭 Wander MindMaze**) and the L2 Territory Map toolbar (`#toolMindMaze` in `public/canvas.js`, navigating via `window.location.hash` with zero `app.js` imports).
  * Archived decks remain playable in MindMaze with a subtle `📦 Archived` header badge (`.mind-maze-archived-badge`) and zero auto-unarchive side effects.
  * Added **MindMaze (Side-Mode Fog Exploration)** card to the in-app Help view (`renderHelp()`), clarifying that MindMaze is a pure side-mode that never writes FSRS intervals or review counts.
  * Added `/mind-maze.js` to `SHELL_ASSETS` and bumped `CACHE_VERSION` to `lernin-shell-v27` in `public/sw.js` for cold-start offline parity.

**MindMaze v1 — Phase 3: Gate Modal, Unlock/Soft-Fail & Synth Audio (`public/mind-maze.js`, `public/sound.js`, `public/test_mind_maze_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
shipped Phase 3 (self-contained Gate Modal on `FRONTIER` chamber tap, cloze-safe prompt + answer reveal, side-mode grading `Again`/`Hard`/`Good`/`Easy` without FSRS intervals, in-memory unlock & soft-fail animations, `Escape` handling, full-clear detection, and synthesizer audio cues):
- **Self-Contained Gate Modal & Side-Mode Grading (`public/mind-maze.js`)**:
  * Wired `FRONTIER` chamber tap to open `.mind-maze-gate-overlay` / `.mind-maze-gate-modal` displaying the due card's front (masking `{{cN::answer::hint}}` cloze syntax as `[...]` and rendering `$$formula$$` when present).
  * Clicking **Show Answer** (or pressing `Space`/`Enter`) calls `playFlip()`, reveals the card back (with cloze answers highlighted and formula variables/assumptions displayed), and surfaces the 4 grade buttons (**Again**, **Hard**, **Good**, **Easy** — keys `1`–`4`, strictly omitting FSRS interval labels).
  * Pressing `Escape` closes the open Gate Modal first without exiting the maze or writing to IndexedDB.
- **In-Memory Unlock, Soft-Fail & Full-Clear Resolution (`applyMazeGateGrade`)**:
  * **Unlock (`Hard` / `Good` / `Easy`)**: Transitions the chamber to `CLEARED`, promotes connected `FOGGED` successors to `FRONTIER`, animates a `550ms` radial fog-retreat ripple on the Canvas 2D surface, and updates the header status pill.
  * **Soft Fail (`Again`)**: Preserves `FRONTIER` status on the chamber (never locks out or penalizes), plays `playAgain()`, triggers a `320ms` dampened horizontal shimmer on the node, and displays a warm rescuing toast (*"The mist holds for a moment — try an adjacent path or step back in whenever you’re ready."*).
  * **Full Clear**: When all chambers in the run reach `CLEARED`, transitions in-session status to `SANCTUARY`, fires `playSessionComplete()`, and displays the Sanctuary Illuminated celebration banner.
  * Performs **zero** writes to IndexedDB `cards` FSRS fields or `reviewLog`.
- **Synthesizer Audio (`public/sound.js`)**:
  * Added oscillator-only `playMazeFogLift()` (debounced triangle-wave D4 + A4 fifth interval) to accompany chamber unlock, alongside throttled `playNavigate()`, `playFlip()`, `playAgain()`, `playHard()`, `playGood()`, `playEasy()`, and `playSessionComplete()`.

**MindMaze v1 — Phase 2: Canvas 2D Terrain, Fog-of-War & Footpath Renderer (`public/mind-maze.js`, `public/test_mind_maze_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
shipped Phase 2 (Canvas 2D terrain, procedural fog-of-war, footpath renderer, light/dark theme tokens, `SANCTUARY`/`EMPTY_DECK` banners, and Phase 3 `onChamberTap` hook); **Phases 3–4 remain open** (Phase 3: Gate modal, self-grading & synth audio cues; Phase 4: Day-scoped reveal persistence & `#/maze/:deckId` route integration):
- **Canvas 2D Terrain, Chambers, Footpaths & Procedural Fog (`drawMindMazeFrame`, `renderMindMazeView`)**:
  * Implemented `drawMindMazeFrame` and `renderMindMazeView` in `public/mind-maze.js` (zero `app.js` imports, strictly read-only against IndexedDB FSRS fields, `reviewLog`, and `settings`).
  * Renders sky-to-horizon gradients, water ripples, and a 16-point organic quadratic-curve island silhouette (`buildOrganicPolygonPoints`) with elevation contours and seeded terrain tufts colored by average deck mastery (`SAND_HSL` $\rightarrow$ `OCHRE_HSL` $\rightarrow$ `MOSS_HSL`).
  * Renders distinct visual treatments for `CLEARED` (warm moss-tinted halo, mastery radial fill, `✓` crest, and card label), `FRONTIER` (pulsing ochre lantern halo, stone core, and card label), and `FOGGED` (desaturated stone pebble beneath drifting sinusoidal radial mist clouds with dashed border and `?` shroud).
  * Renders double-line worn-earth footpaths for unlocked routes (`#8B6F47` / `#C4A265`, with moss-tinted tracks and directional `dependsOn` chevrons for real relationship edges) and faint dashed tracks for locked routes.
  * Supports smooth camera fit-to-graph (`fitCameraToGraph`), pointer pan, and wheel zoom, plus `data-theme` aware Light and Dark theme tokens (`getMazeThemeTokens`).
  * Renders self-contained overlay banners for `SANCTUARY` (0 due cards when active cards exist) and `EMPTY_DECK` (0 total active cards).
  * Exposes `onChamberTap(node, graph)` callback and `lernin:mindmaze-chamber-tap` CustomEvent for Phase 3 gate modal attachment.

**MindMaze v1 — Phase 1: Deterministic Chamber Graph Builder & Read-Only Data Layer (`public/mind-maze.js`, `public/test_mind_maze_phase1.mjs`, `UPCOMING_FEATURES.md`)** —
shipped Phase 1 (pure deterministic due-card chamber graph builder and read-only IndexedDB data layer); **Phases 2–4 remain open** (Phase 2: Canvas 2D terrain/fog/footpath renderer; Phase 3: Gate modal & synth audio cues; Phase 4: Day-scoped reveal persistence & `#/maze/:deckId` route integration):
- **Pure Side-Mode & Dependency Hierarchy (`public/mind-maze.js`)**:
  * Created self-contained `public/mind-maze.js` importing strictly from `./db.js` (`getCardsByDeck`, `getRelationshipsFrom`, `getSetting`, `MASTERY_STABILITY_DAYS`) and never from `app.js`.
  * Performs zero writes to `cards` FSRS fields or `reviewLog`, preserving pure side-mode guarantees.
- **Deterministic Due-Card Selection & DAG Construction (`selectMazeDueCards`, `buildChamberGraph`, `loadDeckMazeGraph`)**:
  * Filters active (`!card.suspended && card.state !== 'suspended'`) due cards (`due_date <= nowMs` or `state === 'new'`), capping each run at `MAZE_MAX_CHAMBERS = 12`.
  * When `> 12` due cards exist, deterministically prioritizes due cards participating in intra-deck relationships (`dependsOn` / `related`) alongside earliest `due_date`, pulling connected due partners into the 12-chamber set.
  * Computes chamber nodes (`{ id, cardId, x, y, r, status: 'FOGGED'|'FRONTIER'|'CLEARED', stability, mastery }`) with radius (`18px`–`34px`) and mastery (`0`–`1`) derived from `MASTERY_STABILITY_DAYS = 30`.
  * Wires primary edges from real `dependsOn` / `related` relationships (`kind: 'relationship'`) and fills remaining reachability via a seeded DAG (`kind: 'seeded'`, branch factor 1–2) seeded by `${deckId}:${dayKey}`.
  * Distinguishes `status: 'SANCTUARY'` (0 due cards when active cards exist) from `status: 'EMPTY_DECK'` (0 total active cards) without throwing exceptions.
  * Supports optional day-scoped read of `mindMazeState` (`resolveClearedCardIdsFromState`, `readDeckMazeClearedIds`) to mark already-cleared chambers `'CLEARED'` and promote their connected children to `'FRONTIER'`.
- **Verification (`public/test_mind_maze_phase1.mjs`)**:
  * Added permanent unit test suite covering `>12` due truncation/determinism, relationship preference & full DAG reachability, `SANCTUARY` vs `EMPTY_DECK` distinction, suspended card filtering, and `Object.freeze` non-mutation guarantees.

**Tier 2 #6 — Delete Dead `concept-graph.js` Module (`public/concept-graph.js`, `public/app.js`, `public/mind-map.js`, `public/styles.css`, `UPCOMING_FEATURES.md`)** —
completely removed dead `concept-graph.js` deprecated stub, cleaned up unused CSS classes, and purged lingering naming references:
- **Dead Code Purge (`public/concept-graph.js`)**:
  * Deleted `public/concept-graph.js` (a 17-line deprecated stub that redirected calls to `canvas.js`'s L2 map). The file was previously evicted from the service worker shell precache in Tier 1 #7 and retained no active import or dynamic load sites across the entire codebase.
- **Reference & Style Cleanup (`public/app.js`, `public/styles.css`, `public/mind-map.js`)**:
  * In `public/app.js`: Renamed internal router handler `enterConceptGraph(deckId)` to `enterDeckMap(deckId)` to accurately reflect that route `#/map/:deckId` directly initializes `openDeckOnMap(root, deckId)`.
  * In `public/styles.css`: Removed obsolete `.concept-graph-container`, `.concept-graph-header`, `.concept-graph-title`, and `.concept-graph-canvas` rules that only pertained to the pre-rewrite concept graph DOM overlay.
  * In `public/mind-map.js`: Updated physics tuning comment to reference the legacy prototype rather than an active module file.
- **Verified Zero Residual Live References & Regressions**:
  * Ripgrep confirmation across the entire repository showed 0 import sites, 0 dynamic loads, and 0 active references to `concept-graph` or `initConceptGraph`.
  * Python backend test suite (102/102 tests passing) and Node audio regression suite passed with zero regressions.

**Tier 2 #5 — Surface New-Card Session Cap for Large Imports (`public/study.js`, `public/spatial-study.js`, `public/styles.css`, `UPCOMING_FEATURES.md`)** —
surfaced the session new-card and review caps at session start, in the study chrome, and at session summary so fresh imports (>20 new cards) are never silently truncated:
- **Root Cause & Silent Truncation Problem (`public/study.js`)**:
  * `interleaveQueue` caps new cards at `DEFAULT_NEW_CARD_CAP = 20` and reviews at `DEFAULT_DAILY_REVIEW_CAP = 100`.
  * When a student imported a large deck (such as 50 or 100 new cards), the session queue was silently capped to 20 cards with no UI feedback, leaving users believing their deck was missing cards or that import had failed.
- **Approach A: Surface the Cap via Toast, Chrome Counter Badge, and Summary Breakdown (`public/study.js`, `public/spatial-study.js`, `public/styles.css`)**:
  * **Truncation Detection in `interleaveQueue`**: Attached clean metadata to the returned queue array (`totalNew`, `queuedNew`, `newTruncated`, `totalReviews`, `queuedReviews`, `reviewsTruncated`) without mutating array semantics.
  * **Warm Session Start Toast (`startStudySession`, `startSpatialReview`)**:
    - When new cards are truncated: fires `showToast("${queuedNew} of ${totalNew} new cards in this session — more tomorrow. Pacing keeps learning durable! 🌿", 5000)`.
    - When reviews are truncated: fires `showToast("${queuedReviews} of ${totalReviews} reviews in this session — more tomorrow. Steady pacing keeps recall strong! 🌿", 5000)`.
    - When both are truncated: fires `showToast("${queuedNew} of ${totalNew} new cards and ${queuedReviews} of ${totalReviews} reviews in this session — more tomorrow! 🌿", 5000)`.
  * **Persistent Study Chrome Header Badge (`updateHeader`, `styles.css`)**:
    - Added `.study-header-cap-badge` next to `Card X of Y` in `.study-header-counter` displaying `[20 of 100 new]` (with hover tooltip `20 of 100 new cards in this session (80 more waiting)`).
    - Styled with `--accent` and `--accent-soft` pill styling that cleanly adapts across Light and Dark themes.
  * **Session Summary Breakdown & Continuation (`renderSessionSummary`)**:
    - Delineated remaining cards in the backlog note: `Daily focus target reached! <strong>${remainingNew}</strong> new card(s) remain in this deck — more ready for tomorrow.`
    - Configured "Study another ${nextBatchCount}" continue button to pass `newCap: nextBatchCount` alongside `reviewCap: 25`, allowing students who wish to continue introducing new cards to do so in controlled batches.
- **Verified via Automated Headless Chrome CDP & Regression Suites**:
  * `interleaveQueue` unit assertions: verified `newTruncated`, `totalNew`, `queuedNew` on capped vs small sets.
  * Live CDP test with 45-card import fixture: verified session start toast, `.study-header-counter` text, `.study-header-cap-badge` pill, and title tooltip.
  * Session completion test: verified backlog note explicitly identifies remaining 25 new cards; verified clicking "Study another 25" loads the next batch (`Card 1 of 25`).
  * Captured UI screenshots in both Light and Dark modes (`tier2_5_study_light.png`, `tier2_5_study_dark.png`, `tier2_5_summary_light.png`).
  * Python backend test suite (102/102 tests passing) and Node audio regression suite passed with zero regressions.

**Tier 2 #4 — Streak Freeze State Pruning & Search Full-Scan Documentation (`public/db.js`, `UPCOMING_FEATURES.md`)** —
bounded `frozenDayKeys` growth to a generous 730-day outer window and added durable architectural documentation and parameters for in-memory card search full scans:
- **`frozenDayKeys` Growth & Bounded Pruning (`public/db.js`)**:
  * **Problem**: Previously, `streakFreezeState.frozenDayKeys` appended each newly frozen day key (`'YYYY-M-D'`) indefinitely, causing the stored array to grow unboundedly over the lifetime of a student's installation with no eviction mechanism.
  * **Retention Bound Choice (`FROZEN_DAY_KEYS_RETENTION_DAYS = 730`)**: Aligned the retention window with Tier 1 #10's streak search outer safety bound (`computeStreakDays(..., maxDays = 730)` / 2 years). Because any frozen day older than 730 days is beyond the maximum reach of any streak calculation walk, pruning entries beyond 730 days bounds storage growth without modifying freeze protection semantics for active or recent periods.
  * **Pruning Locations (Load & Save)**:
    - `pruneFrozenDayKeys(keys, nowMs)`: Helper that parses `'YYYY-M-D'` day keys to midnight timestamps, filters out entries older than `nowMs - 730 days`, drops malformed entries, and deduplicates keys.
    - `getStreakFreezeState(nowMs)` (Load): Prunes `record.frozenDayKeys` upon reading from IndexedDB `settings`, ensuring any in-memory calculations (such as `computeStreakDays` and `studiedToday` checks) evaluate against the bounded set.
    - `saveStreakFreezeState(state, nowMs)` (Save): Prunes `state.frozenDayKeys` prior to persisting to IndexedDB `settings`, ensuring old keys are discarded from disk.
    - `useStreakFreeze(dayKey)`: Supported optional `dayKey` parameter (defaulting to today), checking for prior coverage and persisting via `saveStreakFreezeState` with automatic pruning.
- **Search Scale Limit & Architectural Notes (`searchCardsByFront`, `searchCardsByAnswer` in `public/db.js`)**:
  * **Full-Scan Behavior**: Both `searchCardsByFront` and `searchCardsByAnswer` perform unindexed full table scans via `db.getAll('cards')` followed by in-memory filtering (inspecting question front or 6+ supplementary card fields: `back`, `formula`, `assumptions`, `commonMistakes`, `applications`, and `variables`).
  * **Current Scale Limit**: Perfectly suited and fast (~2-5ms in modern V8/SpiderMonkey) for typical personal flashcard decks (< 5,000–10,000 cards).
  * **Future Index Recommendation**: Documented durable architectural guidance for scale: if deck collections expand beyond 10,000 cards, replace linear in-memory filtering with an IndexedDB multi-entry index on lowercased/tokenized front text or an inverted full-text search index (e.g. FlexSearch/MiniSearch / Web Worker).
  * **API Signatures Preserved & Enhanced**: Added optional `maxResults` (default 20) and handled `(query, excludeCardId, maxResults)` and `(term, maxResults)` signatures backwards-compatibly.
- **Verified via Automated Headless Chrome CDP & Regression Suites**:
  * Verified `pruneFrozenDayKeys` directly: keys >730d (e.g. 731d, 1000d) are pruned; keys <=730d (today, 50d, 100d, 700d, 730d) are kept; invalid keys dropped; duplicates deduplicated.
  * Verified `getStreakFreezeState()` read-pruning on live IndexedDB.
  * Verified `saveStreakFreezeState()` write-pruning directly persisted to IndexedDB.
  * Verified `useStreakFreeze()` first use success, second use prevention, and explicit `dayKey` coverage.
  * Verified `searchCardsByFront` and `searchCardsByAnswer` substring matching, exclusion, and `maxResults` limits.
  * Captured UI screenshots in both Light and Dark modes (`tier2_4_home_light.png`, `tier2_4_home_dark.png`).
  * Python backend test suite (102/102 tests passing) and Node audio regression suite passed with zero regressions.

**Tier 2 #3 — Single Source of Truth for Theme (`public/db.js`, `public/app.js`, `public/index.html`)** —
unified theme persistence onto a single canonical store (IndexedDB `settings.theme`) with `localStorage['lernin-theme']` operating strictly as a synchronized boot cache to prevent Flash of Unstyled Content (FOUC):
- **Store Drift & Dual Writers Resolved**:
  * Theme preference was previously stored in two separate places (`localStorage` key `lernin-theme` and IndexedDB `settings` key `theme`), written from different code paths with disparate validation, leading to potential drift across offline reloads, multi-tab usage, or unseeded states.
- **Canonical Store Choice & Hard FOUC Boot-Cache Rationale**:
  * **Canonical Single Source of Truth (`IndexedDB settings.theme`)**: All user preferences in Lernin (`fontFamily`, `smartOrderingEnabled`, `soundEffectsEnabled`, `reminderSettings`, `apiConfig`, `streakFreezeState`) reside canonically in the IndexedDB `settings` store. Standardizing theme preference on IndexedDB unifies user preference persistence under a consistent schema and storage API.
  * **Synchronous Boot-Cache Rationale (`localStorage['lernin-theme']`)**: IndexedDB is inherently asynchronous and cannot block the browser's first paint. `localStorage.getItem('lernin-theme')` is retained strictly as a synchronous boot cache executed in `<head>` before stylesheets and the body parse, ensuring immediate application of `<html data-theme="...">` without Flash of Unstyled Content (FOUC). Documented this role with explicit comments at both the synchronous boot read in `index.html` and the write mirror in `db.js`.
- **Read-Repair & Healing Contract (`public/db.js`)**:
  * `getTheme()` queries the canonical IndexedDB `settings` store via `getSetting('theme')`.
  * If canonical IndexedDB holds a valid value (`'system'`, `'light'`, `'dark'`), it auto-repairs `localStorage` cache if it drifted or was missing.
  * If canonical IndexedDB is unseeded (fresh install / cleared database), it seeds IndexedDB once from any valid `localStorage` boot value (falling back to `'system'`) and synchronizes both stores.
- **Single Centralized Write Helper & Unified Callers (`public/db.js`, `public/app.js`)**:
  * `saveTheme(value)` in `db.js` writes to canonical IndexedDB first via `saveSetting('theme', theme)`, then mirrors to `localStorage['lernin-theme']` in a defensive try/catch block.
  * `setTheme(theme, persist = true)` in `app.js` serves as the sole UI mutation coordinator: updates in-memory `currentTheme`, applies DOM attributes (`document.documentElement.setAttribute('data-theme', effective)`), manages system media query listeners, updates header toggle titles/aria-labels, and calls `saveTheme(valid)` when persisting.
  * **Header cycle toggle (`#themeToggle`)**: `cycleTheme()` routes through `setTheme(next, true)` cycling cleanly across `system -> light -> dark -> system` based on in-memory preference (resolving the previous bug where reading DOM `data-theme` got stuck on OS dark mode).
  * **Settings Appearance theme picker**: Added a Theme radio group (`System default (follows OS)`, `Light`, `Dark`) to the Settings view Appearance section, routing directly through `setTheme(value, true)` with feedback toasts.
  * **Multi-tab synchronization**: Added a `storage` event listener on `window` in `initTheme()` that responds to `e.key === 'lernin-theme'` by reading canonical `getTheme()` and calling `setTheme(canonical, false)` to heal UI without creating a second database writer.
- **Verified via Automated Headless Chrome CDP & Regression Suites**:
  * Verified initial unseeded boot defaults to `'system'` and seeds both stores.
  * Verified `setTheme('dark')` persists across full page reload in headless Chrome (DOM, IndexedDB, and localStorage match).
  * Verified `#themeToggle` cycle through `system -> light -> dark -> system`.
  * Verified drift healing: deliberately corrupted `localStorage` with `'light'` while IndexedDB was `'dark'`; verified `getTheme()` healed `localStorage` back to `'dark'`.
  * Verified cache seeding: deleted IndexedDB record while `localStorage` had `'light'`; verified `getTheme()` seeded IndexedDB with `'light'`.
  * Verified Settings view Appearance theme picker selection (`dark` and `light` radio selection updates all stores and DOM).
  * Verified multi-tab `storage` event synchronization.
  * Captured UI screenshots in both Light and Dark modes: `tier2_3_home_dark.png`, `tier2_3_home_light.png`, `tier2_3_settings_dark.png`, `tier2_3_settings_light.png`.
  * Full Python backend test suite passed: 102/102 tests passing (exit code 0).
  * Node audio regression suite (`node public/test_motion_player_audio.mjs`) passed: `ALL CHECKS PASSED` (exit code 0).

**Tier 2 #2 — Sanitize 500 Responses & Upstream Provider Error Payloads (`api/index.py`, `api/test_error_sanitization.py`)** —
eliminated internal exception leakage and raw Gemini response payloads from client-facing HTTP error responses across all backend generation and expansion endpoints:
- **Root Cause & Information Disclosure** (`api/index.py`):
  * `generate_motion`, `expand_motion_script`, `generate_mind_map`, and `expand_mind_map` previously returned `f"{type(e).__name__}: {e}"` directly to clients on 500 responses (explicitly tagged in code as temporary pre-launch scaffolding).
  * Upstream Gemini HTTP errors (`httpx.HTTPStatusError`) in `generate_motion` and `generate_mind_map` interpolated `{e.response.text[:300]}` directly into client `detail` fields, potentially disclosing raw upstream error JSON, prompt echoes, or provider error details to clients.
- **Sanitized Client Messages & Server-Side Logging** (`api/index.py`):
  * Replaced all client-facing 500 error details across all 7 API endpoints with clean, user-safe messages:
    - `/api/generate-motion`: `"Motion generation failed. Please try again."`
    - `/api/expand-motion-script`: `"Motion script expansion failed. Please try again."`
    - `/api/generate-mind-map`: `"Mind map generation failed. Please try again."`
    - `/api/expand-mind-map`: `"Mind map expansion failed. Please try again."`
    - `/api/generate-cards` & `/api/generate-cards-vision`: `"Card generation failed. Please try again."`
    - `/api/extract-ppt-text`: `"PowerPoint text extraction failed. Please try again."`
  * Sanitized Gemini 502 responses across all endpoints to return strictly `f"Gemini error: {e.response.status_code}"`, eliminating raw response text interpolation.
  * Preserved full server-side observability: raw Gemini errors are logged via `logger.warning(...)`, and unexpected 500 exceptions are logged with full tracebacks via `logger.exception(...)`.
  * Preserved status code semantics: 500 for unexpected internal errors, 502 for upstream provider failures, and 4xx for client validation/credential/quota errors.
- **Verified via Automated Unit Tests & Regression Suites**:
  * Created `api/test_error_sanitization.py` with 10 automated unit tests asserting that simulated internal failures and upstream provider crashes:
    - Return status code 500 (or 502 for upstream provider errors).
    - Return exact, sanitized client messages.
    - Never leak exception class names (e.g. `RuntimeError`, `TypeError`, `KeyError`, `ValueError`, `IndexError`, `HTTPStatusError`) or internal error strings in the response body.
    - Never leak raw upstream provider payloads in the response body.
  * Full Python backend test suite passed: 102/102 tests passing (up from 92).
  * Node audio regression suite (`node public/test_motion_player_audio.mjs`) passed with zero regressions.

**Tier 2 #1 — Explicit Read/Write Contract Separation for `getReviewStats()` (`public/db.js`, `public/app.js`)** —
separated read and write responsibilities by making `getReviewStats()` a pure read query and extracting streak freeze milestone auto-awarding into an explicit `maybeAwardStreakFreezes()` mutation function:
- **Contract Ambiguity & Hidden Side-Effect** (`public/db.js`):
  * `getReviewStats()` was documented and treated as a read-only query for dashboard stats, but executed an implicit database write to the `settings` object store (`saveStreakFreezeState`) whenever a user's streak crossed a 7-day milestone (`Math.floor(streakDays / 7) > freezeState.lastAwardedMilestone`).
  * While benign in simple single-user flows, this hidden write created a critical concurrency and correctness landmine for caching layers, read replication, service worker background checks, and test harnesses assuming read purity.
- **Approach Chosen — Option A: Split the Write** (`public/db.js`, `public/app.js`):
  * **Pure Read Contract** (`public/db.js`): stripped the `settings` write mutation from `getReviewStats()`. The function now purely reads `reviewLog` and `settings`, returning `{ streakDays, weekCounts, weekTotal, studiedToday, freezesAvailable }` without any side effects. Repeated calls against the same state execute zero writes to IndexedDB.
  * **Explicit Write Operation** (`public/db.js`): added and exported `maybeAwardStreakFreezes(streakDays)`. Checks if `milestone = Math.floor(streakDays / 7)` exceeds `lastAwardedMilestone`. If so, increments `freezesAvailable` (capped at `MAX_STREAK_FREEZES = 3`), updates `lastAwardedMilestone`, persists to `settings`, and returns `{ awarded: true, freezesAvailable, lastAwardedMilestone }`. Otherwise returns `{ awarded: false, freezesAvailable, lastAwardedMilestone }`. Supports computing `streakDays` defensively if omitted.
  * **Updated Call Sites** (`public/app.js`):
    - `renderDeckList()`: reads `getReviewStats()`, then explicitly invokes `await maybeAwardStreakFreezes(stats.streakDays)`. If awarded, updates `stats.freezesAvailable` for immediate rendering of `#streakFreezeCard`.
    - `handleUseStreakFreeze()`: reads `getReviewStats()`, then explicitly invokes `await maybeAwardStreakFreezes(stats.streakDays)` to ensure any newly earned freeze is awarded before validating availability.
    - `maybeFireDailyStudyReminder()`: retained pure read `await getReviewStats()` without write side-effects during background reminder checks.
- **Verified via Automated Headless Chrome CDP & Regression Suites**:
  * **Pure Read Verification**: Seeded a 7-day streak fixture in `reviewLog`; invoked `getReviewStats()` 3 consecutive times; verified `settings.streakFreezeState` was never written (remained `undefined`/null) and `freezesAvailable` remained 0 before explicit award.
  * **Explicit Write Verification**: Invoked `maybeAwardStreakFreezes(stats.streakDays)`; verified `{ awarded: true, freezesAvailable: 1, lastAwardedMilestone: 1 }`, verified `settings.streakFreezeState` was written to IndexedDB, and verified subsequent `getReviewStats()` calls read `freezesAvailable: 1`.
  * **Milestone Idempotency Verification**: Invoked `maybeAwardStreakFreezes()` a second time at milestone 1; verified `{ awarded: false, freezesAvailable: 1 }` without duplicate awards.
  * **Milestone Cap Verification**: Seeded 3 freezes (cap); crossed milestone 3; verified freeze count remained capped at 3 with `lastAwardedMilestone: 3`.
  * **Freeze Usage UX Preserved**: Verified `useStreakFreeze()` spent 1 freeze, marked today as protected, and prevented double spend on the same day.
  * **Live UI Dashboard Verification**: Rendered deck list in real headless Chrome; verified home dashboard rendered streak badge (`🔥 7 day streak`) and freeze badge (`🧊 2 freezes`); captured screenshots in both Light and Dark themes (`tier2_1_home_light.png`, `tier2_1_home_dark.png`).
  * Full Python backend test suite passed: 92/92 tests passing (exit code 0).
  * Node audio regression suite passed: `ALL CHECKS PASSED` (exit code 0).

**Tier 1 #11 — Trusted Client IP Resolution and IP-Keyed Free-Tier Quota (`api/index.py`, `api/test_anti_abuse.py`)** —
hardened client IP resolution against header spoofing and keyed free-tier generation quotas for Motion Studio and Mind Map on trusted client IP rather than attacker-controlled `X-Client-Id`:
- **Root Cause & Vulnerabilities** (`api/index.py`):
  * `_client_ip(request)` previously parsed `X-Forwarded-For` by taking `split(",")[0].strip()` (the leftmost address). In HTTP proxy chaining, the leftmost hop is set by the client and trivially spoofed, allowing attackers to evade IP-based rate limiting by rotating fake IP headers.
  * Free-tier generation quotas for both Motion Studio (`_motion_quota`) and Mind Map (`_mind_map_quota`) were keyed directly on the client-supplied `X-Client-Id` header. Attackers could generate unlimited scripts against John's server key (`MOTION_SERVER_CLAUDE_KEY`) by simply rotating or spoofing `X-Client-Id` values per request.
- **Trusted IP Resolution & IP-Keyed Quota Enforcement** (`api/index.py`):
  * Rewrote `_client_ip(request)` with strict proxy-aware priority:
    1. `x-vercel-forwarded-for` (first value if comma-separated): set directly by Vercel's edge proxy infrastructure.
    2. `x-real-ip`: set by reverse proxy hops.
    3. `x-forwarded-for` rightmost non-empty token (`[p.strip() for p in forwarded.split(",") if p.strip()][-1]`): extracts the peer hop appended by the trusted intermediate proxy rather than the untrusted client-claimed leftmost token.
    4. `request.client.host`: direct socket connection fallback (local development / testing).
    5. `"unknown"`: safe fallback when no client address is observable.
  * Keyed `_motion_quota` and `_mind_map_quota` strictly on `client_ip = _client_ip(request)`. Rotating or spoofing `X-Client-Id` from the same IP shares the same quota bucket and cannot multiply or reset free generations.
  * Removed hard 400 error on missing `X-Client-Id`; `X-Client-Id` remains optional client telemetry and omitting it cannot bypass the IP-level quota.
  * IP rate limiter (`_rate_limit`) automatically inherits the hardened, spoof-resistant `_client_ip` resolution.
  * BYOK routes (`X-LLM-Api-Key` present) remain untouched and bypass server-side quotas.
  * Explicitly documented in code and backlog that quota and rate-limit enforcement is in-memory and per-instance until Tier 3 Upstash Redis is provisioned.
- **Verified via Unit Tests & Regression Suites**:
  * Created `api/test_anti_abuse.py` with 14 unit tests:
    - `TestClientIpResolution`: validates leftmost spoof rejection, rightmost extraction across multi-hop chains, whitespace/empty segment handling, `x-vercel-forwarded-for` precedence, `x-real-ip` precedence, direct client host fallback, and `"unknown"` fallback.
    - `TestFreeTierQuotas`: validates quota sharing across multiple distinct client IDs from the same IP, 402 rejection on quota exhaustion, quota enforcement when `X-Client-Id` is omitted, and BYOK quota bypass for both Motion Studio and Mind Map.
    - `TestRateLimiting`: validates rate limiting against the trusted rightmost IP despite leftmost spoofing.
  * Full Python backend test suite passed: 92/92 tests passing (up from 78).
  * Node audio regression suite (`node public/test_motion_player_audio.mjs`) passed with zero regressions.

**Tier 1 #10 — Streak Computation Beyond 60 Days with Descending Index Cursor (`public/db.js`)** —
computed streaks accurately beyond 60 days by walking backward through `reviewLog` using an indexed cursor on `by_reviewedAt` until a gap or outer bound (730 days) is encountered, eliminating the fixed 60-day fetch window:
- **Root Cause & Behavior** (`public/db.js`):
  * `getReviewStats()` previously fetched `reviewLog` entries bounded by `lookbackStart = startOfLocalDay(nowMs - 60 * 24 * 60 * 60 * 1000)`.
  * For users with unbroken streaks exceeding 60 days, older days were excluded from the fetched set; the backward day-by-day walk encountered a false gap at day 60, permanently freezing the streak counter at 60 days.
- **Descending Index Walk with Outer Bound** (`public/db.js`):
  * Added and exported `computeStreakDays(db, nowMs, frozenDayKeys, maxDays = 730)`.
  * Opens an IDB cursor on `reviewLog` index `by_reviewedAt` with direction `'prev'` bounded by `endOfLocalDay(nowMs)`.
  * Steps calendar days backward from `nowMs` using local calendar day arithmetic (`Date.prototype.setDate()`).
  * Fast-skips multiple reviews on the same calendar day via `cursor.continue(startOfLocalDay(cursor.key) - 1)`, jumping directly to earlier dates in a single IDB step.
  * Preserved freeze-day behavior (`frozenDayKeys` covered days increment `streakDays` and preserve cursor position for earlier reviews).
  * Preserved unstudied-today grace period (`currentKey === todayKey` does not reset or break the streak).
  * Enforces an outer safety bound (`maxDays = 730`, 2 years) to prevent unbounded scans.
  * Decoupled 7-day weekly activity query (`weekCounts`, `weekTotal`, `studiedToday`), which now fetches only the past 7 days instead of the previous 60-day block.
  * Preserved milestone-based freeze auto-awarding (`Math.floor(streakDays / 7)`).
- **Verified via Automated Headless Chrome CDP**:
  * 75 consecutive days test: seeded 75 days of reviews across real IndexedDB; verified `stats.streakDays === 75` (exceeding the old 60-day limit).
  * Gap detection test: removed Day -30 review; verified streak breaks cleanly at day 30 (`stats.streakDays === 30`).
  * Streak freeze test: added Day -30 to `frozenDayKeys`; verified streak freeze bridges the gap, restoring the full 75-day streak (`stats.streakDays === 75`).
  * Unstudied today test: removed today's review; verified streak reports 74 days and `studiedToday === false` without resetting.
  * Outer safety bound test: verified `computeStreakDays` with `maxDays = 10` respects the bound.
  * Live UI test: verified home screen stats badge renders `🔥 75-day streak`.
  * Captured screenshots in Light and Dark themes (`streak_75d_home_light.png`, `streak_75d_home_dark.png`).
  * Python backend test suite (78/78 passing) and Node audio test suite (`ALL CHECKS PASSED`) pass with zero regressions.

**Tier 1 #9 — Teach-It Grade Persistence Before Sheet Display (`public/db.js`, `public/study.js`)** —
persisted grades and review log records to IndexedDB immediately upon grading, before opening the Teach-It explanation sheet, so dismissing the session via Escape or navigating away cannot silently drop reviews:
- **Root Cause & Behavior** (`public/study.js`):
  * `handleGrade()` in `study.js` previously incremented `session.results[grade]` in memory before displaying the Teach-It sheet for "Good" or "Easy" grades, but deferred `persistGrade()` (the IndexedDB write to `cards` and `reviewLog`) to the sheet's Skip/Continue button click handlers.
  * If a user pressed Escape while the Teach-It sheet was open (or navigated away), the global Escape handler triggered `endStudySession()`, exiting the session with the in-memory results incremented but without writing the card state or review log to IndexedDB. The grade was silently dropped.
- **Immediate Persistence Fix** (`public/study.js`, `public/db.js`):
  * In `handleGrade()`: moved `await persistGrade(card, fsrsUpdate, reviewLogEntry)` immediately before the `if (grade === 'good' || grade === 'easy')` check. The card's updated FSRS parameters and reviewLog record are written to IndexedDB before `showTeachIt()` opens.
  * In `public/db.js`: added and exported `updateLastReviewLogTeachingNote(cardId, teachingNote)`, which looks up the most recent reviewLog record for the card using a cursor on the `by_cardId` index and updates its `teachingNote` in place.
  * In `showTeachIt()`: Skip now removes the sheet and proceeds to card exit without calling `persistGrade()`, eliminating duplicate reviewLog entries. Continue updates `teachingNote` via `updateLastReviewLogTeachingNote` only if the user entered an explanation, then exits cleanly without double-persisting.
  * In `undoLastGrade()`, `leaveSession()`, and `teardownStudySession()`: ensure any active `.teach-it-sheet` is cleanly removed from the DOM. Exported `undoLastGrade` from `study.js`.
  * In `attachKeyboard()`: Escape key continues to end the study session from any focused element (including inputs/textareas), while all other study shortcuts (? / U / space / numbers) are prevented from firing while the user is actively typing in a textarea or input.
- **Verified via Automated Headless Chrome CDP**:
  * Escape test: Graded "Good" → verified Teach-It sheet opened → pressed Escape → verified card FSRS state was saved in IndexedDB (`reps === 1`, state updated) and reviewLog recorded the review (`grade: 'good'`) without silent drops.
  * Skip test: Graded "Good" → clicked Skip → verified card persisted with exactly 1 reviewLog entry (`teachingNote === null`), confirming no double persistence.
  * Continue test: Graded "Easy" → typed custom explanation → clicked Continue → verified card persisted with exactly 1 reviewLog entry and `teachingNote` set to the entered text.
  * Undo test: Invoked `undoLastGrade()` → verified card state restored to pre-grade snapshot (`reps === 0`) and reviewLog record removed.
  * Captured UI screenshots in both Light and Dark themes (`teach_it_sheet_light.png`, `teach_it_sheet_dark.png`).
  * Python backend test suite (78/78 passing) and Node audio regression suites pass with zero regressions.

**Map Secret Discovery Acknowledgment (`hasFoundMapSecret`)** —
wired up a one-time, in-voice acknowledgment toast when the secret sprout motif on the Territory Map is first discovered:
- **Spatial Map Integration** (`public/canvas.js`):
  * In `renderL1()`, reads `hasFoundMapSecret()` when the camera reaches `MAP_SECRET_SPOT` at zoom > 2.8.
  * On initial discovery, marks the secret found (`markMapSecretFound()`, persisted via `localStorage.getItem('lernin:foundMapSecret') === '1'`) and fires a quiet, warm toast: *"You found the quiet corner. Every mastered card starts here. 🌱"*.
  * Built a lightweight, self-contained `showMapToast()` helper in `canvas.js` appending to `.toast-container`, avoiding circular module imports between `app.js` and `canvas.js`.
  * Anti-spam guaranteed: subsequent frames, repeated visits, and navigation away/back check `hasFoundMapSecret()` and never re-trigger the acknowledgment.
- **Verified via automated headless Chrome CDP test**:
  * Clean initial state confirmed (`hasFound: false`, `toasts: 0`).
  * Camera fly-in to `(4000, -3000, 3.0)` verified triggering the sprout motif and exactly one acknowledgment toast.
  * Verified `hasFound` flipped to `true` and `localStorage` saved `'1'`.
  * Anti-spam verified: staying at coordinates for multiple frames produces no duplicate toast; moving away and returning produces no duplicate toast.
  * Screenshot captured: `map_secret_found_toast.png`.
  * Audio test suite (`test_motion_player_audio.mjs`) and Python backend test suite (`test_*.py`) pass cleanly.

**Archived Deck Differentiation in Statistics (`getDashboardStats`)** —
distinguished archived decks from active decks in `/stats` while preserving lifetime aggregate statistics:
- **Database Model** (`public/db.js`):
  * Updated `getDashboardStats()` to include `archived: !!deck.archived` on each `perDeck` entry.
  * Lifetime totals (`totalReviewsLifetime`, `totalCardsStudied`, `leechCount`) continue to include archived decks to preserve full historical study records.
- **User Interface** (`public/app.js`):
  * In `renderStats()`, archived decks in the "By deck" breakdown now render with an explicit `📦 Archived` badge (`.deck-tile-badge.is-archived-badge`).
  * Archived deck rows are visually distinguished with dashed border and subtle muted opacity (`opacity: 0.82; border: 1px dashed var(--border);`), making them immediately identifiable from active study decks.
- **Verified via automated headless Chrome CDP test**:
  * Seeded active and archived test decks into IndexedDB.
  * Verified `getDashboardStats()` returns `archived: false` for active decks and `archived: true` for archived decks.
  * Verified `/stats` renders both decks, with the active deck displayed cleanly and the archived deck clearly badged with `📦 Archived`.
  * Screenshots captured in both Light and Dark themes (`stats_archived_deck_light.png`, `stats_archived_deck_dark.png`).
  * Audio test suite and Python backend test suite passed with 100% success.

**Streak Display Bug Fix & Streak Freeze Wiring (`useStreakFreeze`)** —
fixed the streak display calculation on Home and wired up the streak freeze system:
- **Streak Display Fix** (`public/app.js`):
  * Fixed `stats.currentStreak` (undefined) → `stats.streakDays` in the Home render path so streaks
    accurately reflect consecutive review days (previously was always `0-day streak`).
  * Fixed `stats.totalReviews` (undefined on `getReviewStats()`) → `stats.weekTotal` so the Home stats
    strip remains visible on zero-due days when a streak > 0 is active (previously disappeared completely
    when all cards were finished).
- **Streak Freeze Wiring** (`public/app.js`, `public/db.js`, `public/styles.css`):
  * Surfaced `freezesAvailable` on the Home stats strip with an interactive pill button (`.stat-freeze-btn`,
    `#homeFreezeBtn`) when freezes > 0.
  * Surfaced `Streak freezes` (X / 3) in the `/stats` metrics grid (completing the grid to 6 balanced cards)
    and added a dedicated "Streak Protection" card with a "Protect today" action button.
  * In `public/db.js`, enhanced `useStreakFreeze()` to guard against spending a freeze if today is already
    reviewed or frozen, returning `false` (no freeze wasted).
  * Wired warm, supportive toast messaging matching the "not shame" voice:
    - Success: *"Streak protected for today 🧊 Take the rest you need — your momentum is safe."*
    - Already covered: *"Today is already protected! Save your freeze for when you need a rest day."*
    - Zero available: *"No streak freezes left right now — you earn a new freeze every 7 streak days."*
  * Refreshes stats strip immediately upon spending, decrements count, and persists across page reload.
- **Verified via automated headless Chrome CDP test**:
  - Non-zero streak (`🔥 4-day streak`) correctly rendered in hero banner and stats strip.
  - Zero-due day with active streak confirmed to keep stats strip visible.
  - Spending freeze decrements `freezesAvailable` (2 → 1) and marks today as protected.
  - Reload persistence verified: 1 freeze remains available, streak includes frozen day (5 days).
  - Double-spend guard verified: attempting a second freeze on the same day returns false with supportive toast.
  - `/stats` view verified displaying `1 / 3 Streak freezes` and Streak Protection card.
  - Screenshots captured: `streak_home_with_due.png`, `streak_home_zero_due.png`, `stats_view_streak_freeze.png`.
  - Audio tests (`test_motion_player_audio.mjs`) & backend tests (`test_*.py`): ALL CHECKS PASSED, OK.

**Home Screen Residual Polish (Dark Hero Contrast, Deck Progress Meter & Header Consolidation)** —
shipped residual Home-screen polish fixes following the UI/UX architecture build order:
- **Dark-Mode Hero Contrast** (`public/styles.css`):
  * Replaced low-contrast light-sage gradient in dark theme with a deep, saturated pine / forest green
    gradient (`linear-gradient(135deg, #14351C 0%, #0D2313 100%)`) with a subtle green border
    (`rgba(102, 187, 106, 0.28)`) and elevated shadow.
  * Title text rendered in crisp pure white (`#FFFFFF`, ~12.2:1 contrast), subtitle in soft sage
    (`#A3C4A8`, ~7.5:1 contrast), and CTA button in vibrant mint (`#66BB6A` with `#08160B` dark text,
    ~10.4:1 contrast). Light theme remains untouched with deep forest green gradient and white text.
- **Deck Progress Meter Trough & Alignment** (`public/app.js`, `public/styles.css`):
  * Replaced the thin 4px hairline under the header with a dedicated metric row (`.deck-tile-metrics`).
  * Progress bar (`.deck-tile-bar`) given a 6px height with fully rounded pill ends (`border-radius: 999px`)
    and a clear muted trough background (`rgba(0, 0, 0, 0.08)` in light theme, `rgba(255, 255, 255, 0.12)`
    in dark theme) so low progress never reads as an accidental border.
  * Aligned the progress meter and "N due" badge together on the metric row, keeping the header clean
    with only the deck title and action menu button (`⋮`).
- **Header Icon Consolidation & Overflow Menu** (`public/app.js`, `public/styles.css`):
  * Reduced top header buttons from 6 to 3 directly visible controls: view-mode toggle (`viewToggle`),
    theme toggle (`themeToggle`), and overflow menu button (`overflowBtn`, `⋮`).
  * Retired the redundant map icon from the top bar so the Territory Map feature tile in the grid
    remains the primary entry point.
  * Added an accessible anchored overflow dropdown menu (`.header-overflow-menu`) housing Import (`📥`),
    Help (`❓`), and Settings (`⚙️`), complete with click-away dismiss, Escape key dismiss, and aria-expanded state.
- **Verified via automated headless Chrome CDP test**:
  - Dark mode hero contrast verified: pine background, white title, sage subtitle, high-contrast CTA button.
  - Light mode hero verified: deep forest green, white text.
  - Deck progress meter verified: 6px height, rounded ends, subtle background trough, badge aligned on metric row.
  - Header actions verified: exactly 3 visible icon buttons; map icon absent; Territory Map tile present in grid.
  - Overflow menu verified: opens on click, closes on Escape, closes on click-away, navigates to Help and Settings.
  - Real screenshots captured: `home_polish_light.png`, `home_polish_dark.png`, `home_overflow_open.png`.
  - Audio regression suite (`node public/test_motion_player_audio.mjs`): ALL CHECKS PASSED.
  - Python backend unit test suite (`python -m unittest discover -s api -p "test_*.py"`): 64 tests passing, OK.

**Motion Studio Polish (UI/UX Architecture Brief §5, Step 7; §3.4)** —
shipped Build Step 7 from `UI_UX_ARCHITECTURE_BRIEF.md`, completing the §5 build order with
rich animated loading states, 16:9 explainer preview thumbnails, just-generated item highlighting,
and an Option C hybrid post-watch call to action.
- **Richer Animated Loading & Generating State** (`public/motion-studio.js`, `public/styles.css`):
  Replaced static text with `.ms-generating-widget` containing 3 organic dots styled in the terrain
  palette (`#D7C8A9` sand, `#BC7E32` ochre, `#4B7443` moss). The dots animate with gentle sinusoidal
  breathing (`msDotPulse`) and idle vertical sway (`msDotSway`) matching the Territory Map idle motion.
  Progressive reassurance copy cycles dynamically across phases ("Drafting visual concept & scene layout…",
  "Synthesizing animations & mathematical curves…", "Polishing timing & harmonic motion cues…", and
  "Refining visual script with model feedback…" when retrying).
- **Stronger Post-Generation Moment & 16:9 Canvas Thumbnails** (`public/motion-player.js`, `public/motion-studio.js`):
  * Exported `renderScriptThumbnail(canvas, script, targetTime)` in `motion-player.js` to draw a crisp,
    scaled vector frame of any script onto an 88×50px canvas (`.ms-script-thumb`), giving every saved
    explainer an immediate visual identity instead of a plain text row.
  * When a script is generated, the item in the saved explainers list is emphasized with `.ms-item-just-generated`
    (accent border and ambient glow) and an animated, pulsing `"✨ New"` pill badge (`.ms-badge-new`).
- **"Wanting to Make More" Post-Watch CTA — Option C Hybrid** (`public/motion-player.js`, `public/motion-studio.js`):
  * Added `onLoopComplete` (and `onEnded`) callbacks to `createPlayer` in `motion-player.js`, triggering when
    forward playback crosses duration.
  * In `motion-studio.js`, completing an explainer reveals a warm post-watch card (`.ms-post-watch-card`)
    directly below the player controls:
    * Title: *"Watched to the end! ✨"*
    * Prompt: Warm contextual prompt (*"Explain another part of <Deck Title>?"* when deck-scoped;
      *"Ready to explore further? Explain another concept or dive deeper."* when global).
    * Primary CTA: *"Explain another topic"* smoothly scrolls up, clears, and highlights the topic input.
    * Replay button: *"↺ Replay"* seeks to 0 and restarts playback.
    * Option C Secondary Affordance: When scoped to a deck, a gentle secondary button
      (`"💡 Suggest a concept from this deck’s tricky cards"`) inspects the deck's cards on tap,
      ranks them by lowest stability and highest lapses, and renders 1–2 quick-tap suggestion chips.
      Tapping a chip pre-fills the topic input and focuses it ready to generate.
    * Global view (`#/motion` without a deck) strictly preserves the honesty principle: no unsolicited
      card links or fake suggestions are rendered.
- **Verified via automated headless Chrome CDP test (`scratch/verify_step7_motion.py`)**:
  - Header title confirms deck-scoped context (`Motion Studio · Quantum Physics`).
  - Saved explainers render 16:9 canvas thumbnails with non-empty rendered vector graphics.
  - Generating widget renders 3 terrain dots with sinusoidal pulse and sway keyframes and progressive copy.
  - Newly generated script highlights with pulsing "✨ New" badge; older items do not.
  - Deck-scoped post-watch CTA card renders title, deck prompt, primary button, and secondary suggest button.
  - Clicking suggest button ranks cards by stability and reveals top weakest concepts as clickable chips.
  - Clicking a chip pre-fills and focuses topic input.
  - Global `/motion` post-watch CTA confirmed purely reactive with zero unsolicited suggestion buttons.
  - Screenshots captured in Light and Dark themes (`motion_generating_state_light.png`,
    `motion_saved_thumbnails_light.png`, `motion_post_watch_deck_scoped.png`, `motion_post_watch_global.png`,
    `motion_studio_dark.png`).
  - Player audio regression suite (`test_motion_player_audio.mjs`) passing: ALL CHECKS PASSED.
  - Python test suite (`test_*.py`): 64 tests passing, OK.

**Home Restructure & Hover Grid (UI/UX Architecture Brief §5, Step 6; §3.5)** —
shipped Build Step 6 from `UI_UX_ARCHITECTURE_BRIEF.md`, restructuring the Home screen into an
exploratory Encarta-Kids-style discovery hub while keeping core study urgency clear.
- **Due-Cards Hero Stays at Top**: The primary study callout (`.hero-cta` and `.stats-strip`)
  remains anchored at the very top of Home, preserving the app's unambiguous "Study now" first action.
- **Encarta-Kids-Style Feature Grid** (`public/app.js`, `public/styles.css`): Directly below the hero,
  a responsive 4-tile exploratory grid (`.feature-grid`) showcases the app's spatial and creation surfaces:
  * **Territory Map**: "Explore your knowledge landscape" → routes to `#/map`.
  * **Mind Map**: "Trace connected ideas & relations" → routes via chooser or single-deck fast path.
  * **Motion Studio**: "Watch visual concept explainers" → routes to `#/motion`.
  * **Documents**: "Extract cards & study texts" → routes to `#/documents`.
  *(Study and Stats are intentionally excluded from the grid tiles since the top hero and stats-strip already own them).*
- **Procedural Terrain Visual Language Tile Art**: Zero stock photos or external assets. Each tile features
  crisp, scalable inline SVG artwork created in the exact terrain palette (`SAND_HSL`, `OCHRE_HSL`, `MOSS_HSL`,
  and water/earth accents) with organic pebble contours and elevation shading matching the Territory Map.
- **Synthesis-Only Audio & CSS Motion**:
  * Added `playTileHover(tileKey)` in `public/sound.js` using Web Audio oscillators with distinct harmonic intervals
    per tile (Territory Map: C4-G4 fifth; Mind Map: D4-G4 rising fourth; Motion Studio: E4-B4 shimmer; Documents: A3-E4 fifth),
    gated by the user's sound setting with 60ms debounce to prevent noise clutter on pointer scrubbing.
  * CSS scale/glow animation (`translateY(-3px) scale(1.02)` and warm ambient shadow) on hover, focus, and touch.
- **Mind Map Chooser Bottom Sheet**:
  * When multiple active decks or documents exist, clicking the Mind Map tile opens a warm bottom sheet
    (`.mind-map-chooser-sheet`) letting the user choose between Deck Cards or Document Outline.
  * Single active deck fast path: If only one active deck exists, clicking Mind Map jumps straight into that
    deck's card mind map without modal friction.
- **Global Documents View** (`public/app.js`): Upgraded `renderDocuments` to support a top-level view when no
  specific deck ID is passed, displaying all imported documents across decks with outline links and deletion.
- **Secondary Deck List & Archived Section**:
  * Decks now sit gracefully below the feature grid with a dedicated header (`.deck-section-header`) showing
    deck count and layout view toggle (`☰ List`, `⊞ Grid`, `↔ Strip`).
  * The `📦 Archived (N) ▸` collapsable container remains intact directly below the active decks, preserving
    expansion toggle, unarchive, and deletion flows.
- **Verified via automated headless Chrome CDP test**:
  - DOM hierarchy verified: Hero -> Stats Strip -> Feature Grid -> Deck Section Header -> Deck List -> Archived.
  - Exactly 4 approved tiles verified with procedural SVG art (no Study/Stats duplicate tiles).
  - Hover CSS transform and synthesized audio trigger verified.
  - Light and Dark theme rendering confirmed via screenshots (`home_feature_grid_light.png`, `home_feature_grid_dark.png`).
  - Territory Map, Motion Studio, and Documents direct tile routing verified.
  - Mind Map Chooser verified opening with deck and document options, and routing correctly.
  - Mind Map single-deck fast path verified jumping straight into card graph.
  - Secondary deck list and collapsable archived container verified functional.
  - All unit & regression suites passing.

**Card Mind Map Consistency Pass (UI/UX Architecture Brief §5, Step 5; §3.3)** —
shipped Build Step 5 from `UI_UX_ARCHITECTURE_BRIEF.md`, bringing Card Mind Map nodes into
harmony with the Territory Map's visual language while preserving graph density and legibility.
- **Procedural Organic Pebble Silhouettes** (`public/mind-map.js`): Replaced circular `ctx.arc`
  fills with 10-point irregular polygon contours smoothed via quadratic splines (`nodeSilhouettePoints`,
  `buildNodePath`). The contour is seeded strictly from `cardId` using deterministic hashing (`hashToUnit`),
  ensuring each card's pebble shape is stable across reloads and sessions.
- **Lighter-Weight Calibration for Dense Graphs**: Territory Map islands use 14 points with 28% modulation
  and internal tuft marks. For the denser Card Mind Map (25–100 nodes), nodes use 10 points with gentle
  12% modulation (`0.88 + 0.12 * noise`) and omit internal speckles, producing an organic pebble feel
  without distorting label text or creating visual clutter.
- **Terrain Elevation Radial Shading** (`public/mind-map.js`): Replaced flat fills with a high-ground radial
  gradient from lighter elevated center (`l + 10%`), base midtone at `0.6`, to deeper shoreline edge
  (`s + 6%, l - 8%`), matching the Territory Map's topographical depth cues.
- **Unified Color Palette & Deterministic Jitter**: Nodes derive color from the shared palette
  `SAND_HSL (38, 28%, 78%)` → `OCHRE_HSL (32, 55%, 55%)` → `MOSS_HSL (110, 32%, 38%)` with deterministic
  ±6° hue jitter keyed to `cardId`. Size (`22 + mastery * 18`) and color meanings are strictly preserved.
- **Organic Hover & Drag Halo**: Selection and drag rings track the organic pebble contour with a 4px offset path.
- **Verified via automated headless Chrome CDP test**:
  - Soft irregular pebble contours verified via non-circular radial coordinate measurements.
  - 100% determinism and pixel stability verified across browser page reload (exact match on all coordinates).
  - High-ground radial terrain gradient confirmed (center lightness > perimeter lightness).
  - Color and size semantics confirmed aligned with mastery (sand/small for novice, moss/large for mastered).
  - Dense deck layout verified uncluttered and legible.
  - All unit & regression suites passing.

**Universal Jump-to-Card Audit & Card Mind Map Study Action (UI/UX Architecture Brief §5, Step 4; §3.2)** —
shipped Build Step 4 from `UI_UX_ARCHITECTURE_BRIEF.md`, ensuring every visual surface provides a fast path
to study cards without dead ends.
- **Surface Audit (§3.2)**:
  - *Territory Map L3* (`public/canvas.js`): Already surfaces card front/back, formula, relationship chips,
    and a primary `"Study this card"` button launching `startStudySession`. Verified meeting the bar.
  - *Card Mind Map* (`public/mind-map.js`): Node tap previously opened a peek panel showing only front/back
    and a close button — identified as the clear gap. Upgraded with full formula support and a primary
    `"Study this card"` action.
  - *Document Mind Map* (`public/mind-map-doc.js`): Nodes represent document structural sections/topics rather
    than individual cards. Retained honest actions (`"Explain with motion"` and `"Back"`) without inventing
    fabricated card links.
  - *Motion Studio* (`public/motion-studio.js`): Topic-driven explainer studio. Retained honest action model
    (prefills when arriving from mind-map node; freely-typed topics do not link to fake cards).
- **Reusable `cardQuickActions` Helper** (`public/study.js`):
  Exported helper that renders a standard action row with a `"Study this card"` primary button
  (`.card-action-study`) that seamlessly launches `startStudySession(container, { deckId, startCardId, onExit })`.
- **Card Mind Map Study Integration** (`public/mind-map.js`):
  Tapping a node in the force-directed card graph now shows front, back, LaTeX formulas (`$$...$$`), and the
  `cardQuickActions` row. Clicking `"Study this card"` destroys the mind map view, runs the active recall study
  session starting with that exact card, and on exit smoothly restores the Mind Map view.
- **Study Engine Card Injection Guarantee** (`public/study.js`):
  When `startStudySession` receives `startCardId`, it fetches the card via `getCard(startCardId)` and guarantees
  it is present at the front of the study queue, even if the deck has 0 cards due today. This ensures explicit
  "Study this card" jumps never get blocked by the "All caught up!" empty state screen.
- **Verified via automated headless Chrome CDP test**:
  - Card Mind Map node tap opens peek panel containing the `"Study this card"` button.
  - Clicking `"Study this card"` immediately launches the study engine displaying the card's front, back, and grading buttons.
  - Exiting the study session smoothly returns the user to the Card Mind Map.
  - Territory Map L3 study button verified intact and functional.
  - Document Mind Map and Motion Studio confirmed honest without fabricated card links.
  - All unit & regression suites passing.

**Territory Map: Paths + Recency + Idle Motion (UI/UX Architecture Brief §5, Step 3; §3.1 Steps 5–7)** —
shipped Build Step 3 from `UI_UX_ARCHITECTURE_BRIEF.md`, adding life and narrative to the Territory Map.
- **Paths as Routes (Step 5)** (`public/canvas.js`): Cross-deck connector lines now render as worn-earth
  double-stroke tracks. A wide ochre undercoat (`#8B6F47`, solid, round-capped) represents the exposed dirt;
  a narrower lighter topcoat (`#C4A265`) represents the trodden centre. Both strokes scale width with
  `pair.count` (more shared cards = wider, better-travelled road). Hover alpha behaviour is preserved;
  dashes are gone — solid strokes read as real paths, not schematic indicators.
- **Recency as Ambient Life (Step 6)** (`public/canvas.js`): New `islandVitality(island, territory)`
  helper returns a [0.3, 1.0] scalar blending per-island mastery with the territory's `activityLevel`.
  High vitality → vivid glow, saturated fill, dense texture, strong coastline. Low vitality (untouched
  or brand-new deck) → desaturated, faint, quiet. Applied to: glow alpha, HSL saturation, texture dot
  alpha, coastline opacity, and contour ring opacity. Floor of 0.3 keeps all islands faintly visible.
- **Idle Motion (Step 7)** (`public/canvas.js`): Each island sways continuously on two slightly different
  frequencies (~0.042 Hz X / ~0.032 Hz Y, amplitude 1.2/0.8 world units). Phase is unique per island via
  `hashToUnit(island.id) * Math.PI * 2`, making each one feel independently alive. All drawing (silhouette,
  texture, glow, label) uses the swayed screen position so nothing tears. Hit-testing is unaffected (uses
  stored world pos, not swayed pos). Idle frame rate at L1 raised from 250ms to 40ms (~25fps) to drive
  smooth sway; L2 stays at 250ms idle.
- **L2/LOD Isolation**: All three effects are L1-only. L2 flat fill and 250ms idle tick are unaffected.
  `drawIslandSimple` (LOD fallback, zoom < 0.55) is unaffected.
- **Verified via automated headless Chrome CDP test**:
  - Path colour confirmed warm ochre (not MAP_INK grey) at connector midpoint.
  - Vitality difference confirmed between low-mastery (mastery≈0) and high-mastery (mastery≈0.6) islands
    via fill pixel saturation comparison.
  - Sway confirmed live: island centre pixel shifts between two frames captured 200ms apart.
  - L2 background confirmed static (no pixel change between frames at L2).
  - All unit & regression suites passing.

**Deck Archiving & Hard Deletion (UI/UX Architecture Brief §5, Step 1)** —
shipped Build Step 1 from `UI_UX_ARCHITECTURE_BRIEF.md`.
- **Data layer** (`public/db.js`): `saveDeck` persists `archived` boolean
  field (default `false`); `archiveDeck(deckId)` and `unarchiveDeck(deckId)`
  helpers; `getActiveDecks()` and `getArchivedDecks()`; `deleteDeck(deckId)`
  cascades deletion across `decks`, `cards`, and `documents`, and cleans up
  `territoryLayout` overrides; `getCardsDueTodayOrEarlier()` updated so the
  global query (no `deckId`) excludes cards belonging to archived decks,
  meaning archived decks never inflate the Home hero "N cards due today" count
  nor appear in the "Study all" session queue; `exportDeckData` and
  `importDeckData` preserve the `archived` field.
- **Territory Map** (`public/canvas.js`): `buildWorldModel` updated to query
  `getActiveDecks()` instead of `getAllDecks()`, ensuring archived deck islands
  do not render on the map.
- **UI & Bottom Sheet** (`public/app.js`, `public/styles.css`): Home screen
  `renderDeckList()` separates active decks from archived decks. When archived
  decks exist, a collapsable `📦 Archived (N) ▸` section renders below the
  active deck list; tapping expands an inline list of archived deck tiles
  with dashed borders and muted styling. The deck bottom sheet (`openBottomSheet`)
  contextually offers "Archive" (or "Unarchive" for archived decks) and "Delete"
  (with `.sheet-action.is-danger` styling) separated by a sheet divider.
- **Delete confirmation modal**: `openDeleteDeckConfirm(deck)` displays a warm,
  rescuing confirmation sheet stating the exact card count and reminding the user
  that archiving is a safe non-destructive alternative before they permanently delete.
  Canceling ("Keep deck") aborts safely; confirming ("Delete permanently")
  hard-deletes the deck and cards and displays a warm toast.
- **Verified end-to-end**: automated headless Chrome CDP test through real app
  navigation: seed deck + 2 cards (1 due) → verify deck in active list, on map,
  and in due count → archive deck → verify excluded from active list, excluded
  from map, due count drops to 0, appears under Archived (1) toggle → reload
  browser → verify persistence of archived state across reload → unarchive deck →
  verify restored to active list, restored to map, due count restored → trigger
  delete dialog → test "Keep deck" cancel (deck survives) → test "Delete permanently"
  (deck & cards deleted from IndexedDB, empty state rendered). 64/64 backend tests
  and motion audio test pass.


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

### Unescaped LaTeX backslashes silently corrupting or breaking manual-mode paste-back (fixed)
Direct user report: a real 16-card physics deck (basic + formula cards,
LaTeX like `\frac{d}{t}` and `\Delta v`) failed to import via manual
mode, with an error message ("check the opening { and closing }") that
had nothing to do with the actual problem.

Root cause, confirmed by testing the exact reported JSON against
`json.loads`: models routinely emit LaTeX in JSON string values with a
single backslash (`\frac`, `\Delta`) instead of the doubled backslash
JSON string syntax requires. This produces two distinct, differently-
dangerous failure modes:
- `\Delta`, `\alpha` — the letter after the backslash isn't a valid JSON
  escape character at all, so `JSON.parse` throws outright. This was the
  error actually surfaced, misleadingly attributed to missing braces.
- `\frac`, `\tau`, `\nabla`, `\beta` — these start with a letter (f/t/n/b/r)
  that *is* a valid JSON escape (form feed, tab, newline, backspace,
  carriage return respectively), so `JSON.parse` does **not** throw — it
  silently succeeds with a literal control character spliced into the
  string where the LaTeX command was meant to be. No error, no visible
  symptom beyond a corrupted formula, easy to miss entirely.

`json-repair.js`'s existing repair chain (`repairUnescapedQuotes`,
trailing-comma stripping) had no handling for either case. Added
`repairLatexBackslashes()`: repairs the first class unconditionally (no
reading of that input was ever valid JSON), and repairs the second via
a heuristic — a genuine control-character escape in real prose is
essentially never immediately followed by 2+ more lowercase letters
forming a word (`frac`, `tau`, `nabla`...), since real sentences
resume with capitals, punctuation, or whitespace, not a continued
lowercase run.

**Caught a real bug in the first version of this fix via testing, not
assumption:** initially wired in as a reactive fallback, only invoked
when `JSON.parse` threw. The `\frac`-style silent-corruption case never
throws in the first place, so the fix never ran for exactly the failure
mode it was built to catch — only the `\Delta`-style hard failure ever
reached it. Fixed by applying the repair unconditionally, before the
first parse attempt, on every candidate. **Caught a second real bug**
from the same testing pass: the initial "followed by any letter"
heuristic false-positived on genuine intentional newlines followed by a
capitalized sentence start (`"Line one\nLine two"` — capital L looks
like "any letter" too) — narrowed to specifically 2+ *lowercase*
letters, which still catches every realistic LaTeX command name
(lowercase words) while leaving real prose newlines/tabs alone.

Verified: the exact reported 16-card JSON now imports cleanly with
every formula (`\frac{d}{t}`, `\frac{\Delta v}{\Delta t}`,
`\frac{1}{2}mv^2`) and every LaTeX variable name (`\Delta v`, `\Delta t`)
recovered correctly. A 13-case test suite covering both failure modes,
already-correct double-escaped input, genuine Windows-style paths,
genuine intentional newlines/tabs (including the capital-letter-after
case that broke the first version), multiple LaTeX terms in one value,
and LaTeX combined with a trailing comma (the composed-repair path) —
all pass. This fix lives in one shared function used by all four
manual-mode paste-back flows (card generation ×2 call sites, Motion
Studio, Mind Map v2), so it's not card-generation-specific — any of
them could have hit the same silent corruption.

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
