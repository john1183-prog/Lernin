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

## Tier 2 — Rich cards and relationships

The foundational decisions got made and the first slice shipped (see
below) — remaining items here are follow-ups, each independently
buildable now that the data layer exists and is tested.

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

### Visual connections between related concepts on the map
`canvas.js` could draw lines/arcs between related islands (possibly
across territories) using the same relationship data. Purely visual, no
Study Mode logic changes needed. Design settled: one line per
deck-pair (not one per relationship — aggregate, weight by count),
single subtle dashed style with no direction/arrowheads (unreadable at
that zoom level anyway), hover-to-highlight-connected matching the
existing L2 node pattern.

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

### Map — redesigned outside this chat, audited here
The "fuller discussion" mentioned below happened outside Claude
entirely — commits `4559b85` ("recreated the map") and `7b7bb2c`
("bug fixes") were a from-scratch canvas.js/db.js rewrite, prototyped
in a separate `lernin-spatial/` folder and then merged into `public/`.
Asked to verify it (not just take it on faith): the integration itself
is genuinely clean — all 19 functions canvas.js imports from db.js
exist, all 3 exports app.js needs from canvas.js are present, every
IndexedDB store it touches (territoryLayout, conceptLayouts,
landmarks, studyPaths, annotations) is in the schema, zero
TODO/FIXME/console.error markers. That's a real accomplishment for a
merge this size — this is exactly the kind of seam where this file's
other audit entries found real breakage.

That said, four things are worth a cleanup pass, found by actually
reading the code rather than assuming a rewrite this large "just
works":
- **Unconditional 60fps render loop is back.** Already fixed once in
  an earlier performance audit (see "Already shipped" list), but the
  rewrite didn't carry it forward — `renderLoop()` in canvas.js
  redraws every frame regardless of whether anything's animating.
  Does get `cancelAnimationFrame`'d on `destroyCanvasView()`, so it's
  not a permanent background drain, but real cost while the map sits
  open and idle.
- **No delete UI for landmarks, study paths, or annotations.**
  `deleteLandmark`/`deleteStudyPath`/`deleteAnnotation` are imported
  from db.js but never called anywhere in canvas.js — same
  backend-exists-UI-was-never-wired pattern as the leech review gap
  above. Once created, these are permanent.
- **Fire-and-forget writes, no failure feedback.**
  `saveIslandPosition`/`saveConceptPosition`/`saveAnnotation` are
  called with no `await` and no `.catch()`. Reasonable for position
  drags (shouldn't block on a write), less so for `saveAnnotation` —
  a typed annotation could silently fail to persist with zero
  indication to the user.
- **Annotation text uses the browser's native `prompt()`** — jarring,
  unstylable, inconsistent with the sheet/modal pattern used
  everywhere else (deck actions, export options).

Suggested: bundle a fix for these with the island-to-island lines
work (Tier 2, "Visual connections between related concepts on the
map," above), since both touch canvas.js directly — most efficient
done together rather than as separate passes.

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

---

## Active — real user feedback, not yet fully addressed

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
