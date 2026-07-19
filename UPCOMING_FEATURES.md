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

### Statistics dashboard
Surface the data that's already being tracked (`reviewLog`, mastery per
deck, streaks) in a real view instead of just the home-screen summary
card. Retention rate over time, mastery breakdown per deck, a proper
review-history chart, "readiness" signal ahead of an exam. No schema
changes needed — this is entirely a new view over existing data.

### Export / import decks
JSON export of a deck (cards + FSRS state + review log, optionally
excluding review log for a "fresh copy to share" mode) and a matching
import. High value for: backing up before the risky changes we keep
making, sharing a deck with a classmate, moving between devices without
relying on the RecallDB→Lernin-style migration path working perfectly
every time.

### Onboarding / empty states
First-time open currently shows a mostly-blank home screen. Needs: a
first-run explainer (what this app does, BYOK vs. manual-paste mode,
where to start), and better empty states for Documents/Leeches/Course
Recap when there's nothing there yet (some of these already have basic
empty-state text; worth a pass to make them actually guide the next
action rather than just stating "nothing here").

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
Reset-everything, RecallDB→Lernin rename with data migration, and the
green/gold rebrand.
