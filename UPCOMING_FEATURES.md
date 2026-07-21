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
live-search relationship picker. All of it tested end-to-end against
real IndexedDB semantics (fake-indexeddb), not just read through.

**Not shipped yet, on purpose (decided when scoping this):**

### Rich card rendering in Study Mode
Formula cards currently render with plain front/back like any other card
— `study.js` doesn't yet surface `formula`/`variables`/`commonMistakes`
during review. Decided: plain text/monospace for v1 rather than real math
typesetting (KaTeX) — revisit if that turns out insufficient once people
are actually using formula cards.

### Improved PDF-to-rich-card pipeline
`api/index.py`'s generation prompts still only populate
`front`/`back`/`type`/`summary`. Extending them to actually extract
formula/variables/etc. from source text is real prompt-engineering work,
deliberately deferred until the manually-created path is proven out.

### Relationship explorer / reverse lookup
Given a card, show what it depends on and what depends on it (the data
functions — `getRelationshipsFrom`/`getRelationshipsTo` — already exist
in `db.js`; this is the UI to browse them, separate from attaching them
during creation). "Reverse lookup" = given an answer/formula, find which
card(s) produce it.

### Smart daily session planner
Currently `study.js` queues due cards by FSRS due date only. A smarter
planner would factor in available study time, weak topics, and
prerequisites (don't surface a card whose `dependsOn` cards haven't been
reviewed recently) — now buildable against the real relationship data.

### Visual connections between related concepts on the map
`canvas.js` could draw lines/arcs between related islands (possibly
across territories) using the same relationship data. Purely visual, no
Study Mode logic changes needed.

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
retention, longest streak, per-deck breakdown, activity chart), a
persistent, sectioned in-app Help view (reachable via the header's "?"
button and from a rewritten first-run empty state) covering what the app
is and how each feature works, and a rich card data layer (formula card
type, cross-deck dependsOn/related relationships, manual card creation
with a relationship picker) — Study Mode rendering and the AI generation
pipeline don't use these fields yet, see Tier 2 above.

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
