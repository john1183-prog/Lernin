# Lernin's Secrets — Phase 1 Encarta Identity Pivot

A reference for what's actually shipped and live on `main`, pulled directly
from the current code (not from memory of the original design conversation).
Everything below is on `main` as of commit `75791d6` (Phase 2 of this
same identity pivot is also complete as of that commit — see
`HANDOFF_NEXT_SESSION.md` for that work; this document covers only the
three Phase 1 secrets and the identity chime, unchanged since Phase 1).

All three "secrets" live in `public/secrets.js` as small, pure, unit-testable
functions — no DOM access in that file itself. Each one is wired into exactly
one real UI call site, listed below. `secrets.js`'s own header comment is
worth repeating here because it's the design principle the other two
follow: these are deliberately **not** literal references to Encarta's own
eggs (a hidden pineapple in an article, typing "good boy" for a dog emoji).
Those are inside jokes about a different product; transplanting them would
feel like wearing someone else's memory rather than making one of Lernin's
own. Instead, each secret is built from something already true about
Lernin — its own voice, its own visual language, or a moment that already
happens for real.

---

## 1. The greeting easter egg

**What it is:** Type a greeting into the Cards-view search box instead of
an actual search term, and instead of "No cards found," you get a small,
warm, in-voice response.

**Trigger:** Search box on the Cards view (any deck's card list), typing
one of: `hello`, `hi`, `hey`, `is anyone there`, `anyone there`,
`anybody there`, `anybody home`. Matching is case-insensitive and trims
trailing `?`/`!`/`.` punctuation, so "Hello?", "HI!", and "hello" all match.

**Response:** *"Hi. We're here. Search whenever you're ready — no rush."*

**Where it lives:**
- Logic: `checkGreetingEasterEgg(query)` in `public/secrets.js`
- Wired in: `public/app.js`, inside the card-list search's empty-state
  rendering — `checkGreetingEasterEgg(query) || 'No cards found.'`

**Why this one:** It's the app's own companion voice, not a random
non-sequitur — the same "we've suffered through old study habits too,
here's the rescue" tone that runs through the rest of the app, just
surfacing in an unexpected place.

---

## 2. The Territory Map secret

**What it is:** A small hidden sprouting-plant motif on the Territory Map
(L1, the zoomed-out territory overview), drawn at a coordinate deliberately
far from where any real territory would ever be placed.

**Trigger:** Zoom the Territory Map in close (past zoom level 2.8 — L1's
zoom range caps at 3, so this means being very near maximum zoom) and pan
to world coordinate `(4000, -3000)`. That spot is chosen to be safely
outside the range `territoryPosition()`'s spacing formula would ever
realistically place a real territory, even with a large course library — so
finding it takes genuine deliberate exploration, not an accidental
scroll-past.

**What you see:** A small stem with two leaves, swaying continuously and
gently (not a one-shot animation — it reads as a small living thing). At
extreme zoom (past 2.9) a caption fades in beneath it: *"every mastered
card starts here."*

**Where it lives:**
- Logic: `isNearMapSecret()`, `MAP_SECRET_SPOT`, `MAP_SECRET_RADIUS`,
  `MAP_SECRET_MIN_ZOOM`, `hasFoundMapSecret()`, `markMapSecretFound()` in
  `public/secrets.js`
- Rendering: `drawMapSecret()` in `public/canvas.js`, called from
  `renderL1()` whenever `isNearMapSecret(camera.x, camera.y, camera.zoom)`
  is true
- Discovery is recorded in `localStorage` under the key
  `lernin:foundMapSecret` (currently write-only — nothing in the app reads
  it back yet to show a "you found it" acknowledgment elsewhere; see
  Loose ends below)

**Why this one:** It ties into the map's own existing visual language —
islands already get more vibrant as you master them — so this reads as
"this is where it all starts," not an arbitrary hidden object grafted on.

**Verification:** Confirmed with real rendered screenshots at three camera
states during the original session: exactly at the spot at max zoom
(renders correctly, caption legible), far away at max zoom (correctly
empty), and exactly at the spot but zoomed out (correctly empty — confirms
the zoom gate, not just the position gate, actually works).

---

## 3. The clean sweep note

**What it is:** Finish a study session of real size with a perfect grading
record, and the session summary screen gets one extra line above the stats
grid.

**Trigger:** A study session with **5 or more graded cards** and **zero
"Again" grades**. (A small 1–4 card session going perfectly isn't unusual
enough to call out — five or more clean is a genuinely noticeable run.)

**Response:** One of three variants, chosen at random each time:
- *"Clean sweep. Every single one."*
- *"Not one Again. That's a real session."*
- *"All of them. Nothing slipped."*

**Where it lives:**
- Logic: `checkCleanSweep(results)` in `public/secrets.js`
- Wired in: `renderSessionSummary()` in `public/study.js` — shown as
  `.session-summary-sweep` between the accuracy ring and the stats grid,
  only when `checkCleanSweep()` returns non-null

**Why this one:** This replaced an originally-planned streak-freeze easter
egg. `useStreakFreeze()` turned out to be fully-built backend logic in
`db.js` with **zero frontend call sites** anywhere — no UI currently
triggers it at all, so there was nothing real to attach an egg to without
first shipping the missing feature. The clean sweep note attaches instead
to something that's already a genuine, already-wired moment.

---

## Not a secret, but part of the same moment: the identity chime

Not hidden — this one's meant to be noticed — but built in the same Phase 1
pass and worth including for completeness. `playIdentityChord()` in
`public/sound.js` plays a sustained C-major chord (C4/E4/G4, C5 with a
slight shimmer delay) the first time you reach Home in a session, gated by
a `sessionStorage` key (`lernin:identityChimePlayed`) so it fires once per
session regardless of how you navigate afterward. It's deliberately
distinct from the snappy, celebratory `playSessionComplete()` arpeggio —
this one has a slow attack, for arriving somewhere calm rather than
finishing a task. Wired in via `maybePlayIdentityChime()` in `app.js`.

---

## Loose ends worth knowing about

- **Map secret's `localStorage` flag is write-only.** `markMapSecretFound()`
  sets `lernin:foundMapSecret`, but nothing currently reads
  `hasFoundMapSecret()` back to change any UI (no badge, no changed caption
  on a second visit, nothing in Help). It's there as a hook for a future
  "you found this" acknowledgment, not a finished loop yet.
- **`useStreakFreeze()`** (`db.js`) is still fully-built backend logic with
  no frontend trigger anywhere in the app — flagged in the original
  session's handoff as worth fixing at some point, unrelated to the
  Encarta pivot itself.
- **Phase 3** (a MindMaze-style hidden quiz mode, reusing the user's own
  cards, likely triggered by a long-press on the header wordmark) is the
  next genuinely *hidden-feature*-scale idea in this vein, but it's
  explicitly scoped as its own dedicated design session — not a small
  addition like the three above.

---

*Generated from the actual code on `main` at commit `57795f5` (Phase 1
work only — unchanged through Phase 2's completion at `75791d6`), not
from the original planning conversation — every trigger condition,
coordinate, and piece of copy above was pulled directly from
`secrets.js`, `canvas.js`, `study.js`, `app.js`, and `sound.js`.*
