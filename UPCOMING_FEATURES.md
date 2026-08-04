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

### Smart daily session planner
Currently `study.js` queues due cards by FSRS due date only. A smarter
planner would factor in available study time, weak topics, and
prerequisites (don't surface a card whose `dependsOn` cards haven't been
reviewed recently) — now buildable against the real relationship data
and a working explorer to reason about it against.

### Visual connections between related concepts on the map
`canvas.js` could draw lines/arcs between related islands (possibly
across territories) using the same relationship data. Purely visual, no
Study Mode logic changes needed.

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

### Deeper map view redesign
User flagged wanting to bring a fuller discussion/reference material
before further map design work, beyond the concrete bugs already fixed
(LOD vanishing, per-island glow, drag-vs-pan dead zone, territory
bounds, camera auto-fit, persistent list-view button, background/
foreground hue collision). Holding here pending that conversation —
likely the next major phase of work.

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
local study reminders, and a map territory activity halo — only the
smart session planner and map connections remain, see Tier 2 above.

A **Reading Toolkit** (Settings → "Open Reading Toolkit",
`/reading-toolkit`) — an explicitly side/non-core feature, a static
library of copy-ready prompts for pairing reading with any AI chat
tool, grouped by before/during/after reading plus deeper-comprehension
techniques (Feynman check, Socratic push-back). Doesn't touch decks,
cards, or generation. Content lives in `READING_PROMPT_GROUPS` in
app.js — plain data, edit directly to add/remove prompts.

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

### Found this session, deliberately not touched
Two more regressions from the same `e426d5d` rewrite, left alone on
request (no reported issues, priority was not risking breakage):

- **Export choice narrowed to full-backup only.** `exportDeckData(deckId,
  { includeProgress })` in db.js still supports a progress-free
  "share copy" export, but the UI's `exportDeck()` never passes that
  option anymore — no modal, always full backup. The old
  `openExportOptionsModal` is gone.
- **Manual JSON-paste parsing got more brittle.** The old
  `extractJsonCandidate`/`repairUnescapedQuotes` handled zero-width
  Unicode (common from mobile clipboards), context-aware smart-quote
  normalization, and preamble text before/after the JSON. Current
  `parseAndRepairJSON` in manual-json-import.js only strips a markdown
  fence and does a naive quote swap — more likely to fail on
  real-world AI-pasted output.
- **Relationship picker no longer available at card-creation time.**
  You used to be able to link "depends on"/"related" cards live while
  creating a new card. `renderNewCardForm` now has no relationship
  code at all — linking only works after the fact, via card detail
  view (`addRelationship` call there) or by drawing lines on the map.

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
