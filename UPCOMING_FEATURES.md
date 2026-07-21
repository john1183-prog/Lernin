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

## Tier 2 — Needs a real spec before touching code

These are the "rich card schema" items from the filtered list. They all
depend on the same underlying decision (what a "rich card" actually
looks like in the data model), so they should be spec'd together in one
dedicated conversation before any of them get implemented — this is
exactly the kind of change that's expensive to redo if we start coding
against an underspecified schema and have to migrate again.

### Extend card schema for rich fields
`db.js`'s `cards` store currently holds `front`/`back`/`type` plus FSRS
state. Proposed additional fields: `formula`, `variables`, `dependsOn`,
`related`, `applications`, `commonMistakes`, `assumptions`. Before
building: decide which of these are structured (e.g. `dependsOn` as an
array of card IDs) vs. free text, how they render in Study Mode, whether
they apply to all cards or only a new "formula" card type, and how the
PDF/manual generation prompts need to change to populate them.

### Relationships between cards/decks
The `dependsOn`/`related` fields above imply an actual graph, not just
per-card metadata. Needs: a real relationship model (probably a new
store, or an index on card IDs referencing other card IDs), UI for
creating/editing relationships, and a decision on whether relationships
are deck-scoped or can cross decks (a formula in one course depending on
a concept from a prerequisite course, say).

### Rich card rendering in Study Mode
Once the schema exists: `study.js`'s `renderFront`/`renderBack` need to
handle formula rendering (likely KaTeX or similar for actual math
notation, not just plain text), and show `commonMistakes`/`assumptions`
as contextual hints without cluttering the core review flow.

### Relationship explorer / reverse lookup
Given a card, show what it depends on and what depends on it. "Reverse
lookup" = given an answer/formula, find which card(s) produce it — useful
for "I remember the formula but not what it's called" type recall.
Depends entirely on the relationship model existing first.

### Smart daily session planner
Currently `study.js` queues due cards by FSRS due date only. A smarter
planner would factor in: available study time (user-specified), weak
topics (leech rate, low mastery), and prerequisites (don't surface a
card whose `dependsOn` cards haven't been reviewed recently). Depends on
the relationship model.

### Manual creation of rich formula cards
A "New card" flow that isn't PDF/AI-generated — for adding a single
formula card by hand with its structured fields. Lower urgency than the
above since PDF/manual-paste generation covers the common case; this is
for one-off additions.

### Improved PDF-to-rich-card pipeline
Once the schema exists, `api/index.py`'s `SYSTEM_PROMPT` and
`GENERATE_CARDS_TOOL`/`GEMINI_RESPONSE_SCHEMA` need to be extended to
populate the new fields where the source text supports it (e.g. actually
extracting a formula's variables from a physics PDF), not just
front/back/type/summary as today.

### Visual connections between related concepts on the map
Once relationships exist, `canvas.js` could draw lines/arcs between
related islands (possibly across territories) — this is the piece that
would make the map feel like a genuine knowledge graph rather than a
grouped list of dots. Purely visual, no logic changes to Study Mode
itself; can be built any time after the relationship model lands.

---

## Tier 3 — Explicitly deferred, with reasons

### Push notifications / reminders
Flagged early as the single biggest lever for a spaced-repetition app
specifically (the whole model depends on showing up at the right
interval), but genuinely needs backend infrastructure — a real Web Push
service with VAPID keys, a subscription store, and a way to actually
trigger sends on a schedule (Vercel cron or similar). Not a client-only
change like everything else in this file. Worth its own dedicated
session when we're ready to add a real backend job runner.

### Map territories that visually "grow" with study activity
Beyond the mastery-driven island coloring that already exists — the idea
was territories gaining visual detail/glow as total study time invested
in them increases, independent of raw mastery. Lower priority than
everything above; revisit once the map's more fundamental issues (which
we've been actively fixing) are confirmed stable in daily use.

### Deeper map view redesign
User flagged wanting to bring a fuller discussion/reference material
before further map design work, beyond the concrete bugs already fixed
(LOD vanishing, per-island glow, drag-vs-pan dead zone, territory
bounds). Holding here pending that conversation.

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
retention, longest streak, per-deck breakdown, activity chart), and a
persistent, sectioned in-app Help view (reachable via the header's "?"
button and from a rewritten first-run empty state) covering what the app
is and how each feature works.

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

---

## Maintenance conventions

**Keep the in-app Help view in sync.** `app.js`'s `renderHelpView()` is a
persistent, sectioned reference (not a one-time tour) covering what
Lernin is and how each feature works — reachable via the "?" button in
the header and from the first-run empty state. When a feature ships, add
or update its section there in the same pass. An out-of-date Help view
actively misleads, which is worse than not having one.
