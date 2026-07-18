# Lernin — Full Build Guide (Now → Completion)

Status check: `db.js` is done. Everything below is the path from here to a shippable app, in the order the spec mandates. Don't skip ahead to `canvas.js` — it's built last on purpose so you always have a working app underneath it.

---

## Phase 1 — Scheduler (`scheduler.js`)

**Goal:** wrap `ts-fsrs` so nothing else in the app touches the FSRS library directly.

- Install `ts-fsrs`, initialize with default weights (`generatorParameters()` from the library).
- One function: `gradeCard(card, grade)` → runs `fsrs.repeat()`, returns the updated FSRS fields (`state`, `difficulty`, `stability`, `due_date`, `reps`, `lapses`) in the exact shape `db.js`'s `updateCardAfterReview` expects.
- Leech detection here: track `lapses` and flag `state = 'suspended'` (or a `leech: true` flag) once a configurable threshold (default 4) of consecutive "Again" grades is hit. This check belongs in scheduler.js, not study.js — study.js just displays whatever state comes back.
- Leave a clearly commented stub for per-user weight optimization later (`ts-fsrs` supports fitting weights from `reviewLog` history — not needed for v1, but the hook should exist so it's a config change later, not a rewrite).
- Unit-testable in isolation: feed it a card + grade, check the output shape. No IndexedDB or DOM needed to test this file.

**Done when:** you can grade a mock card object through all four buttons and get correct due-date math back, with no UI involved.

---

## Phase 2 — Study Mode (`study.js`)

**Goal:** the actual product. Everything before this was plumbing; this is the first thing that feels like an app.

- Pulls due cards via `getCardsDueTodayOrEarlier()`, applies the daily new-card cap and review cap client-side (config values, stored wherever your settings live — even a plain object in `app.js` is fine for v1).
- One card on screen at a time. Front → reveal → four grade buttons (Again/Hard/Good/Easy) → `scheduler.js` → `db.js` write → next card.
- Cloze rendering: if `card.type === 'cloze'`, parse `{{c1::answer}}`-style markers and blank them on the front, reveal on flip. Keep this parsing in `study.js`, not in the data layer.
- Session pacer: "12 left, ~4 min" — just card count × an assumed seconds-per-card estimate. Don't overthink this, it's a motivational display, not a scheduling input.
- **Zero network calls.** If you catch yourself importing `api.js` into `study.js`, stop — that's the one hard boundary the whole spec is built around.

**Done when:** you can study a deck end-to-end, close the app mid-session, reopen it, and pick up where FSRS left off — fully in airplane mode.

---

## Phase 3 — Generation pipeline (`api.js` + FastAPI `/generate-cards`)

**Backend first, then the client wrapper.**

Backend (`/generate-cards`):
- Accepts extracted text (already parsed client-side by `pdf.js` — the backend never sees a PDF file).
- Chunk long input (rough token-count split, not mid-sentence).
- Call the LLM with a **structured output / tool-call schema**, not a "please return JSON" prompt — this is the difference between "usually works" and "never silently corrupts a user's deck."
- Validate the response against that schema server-side. On failure, retry (2–3 attempts) before ever returning to the client. The client should never have to handle malformed JSON.
- Return a flat card array: `[{ front, back, type: 'basic'|'cloze' }]` — no ids yet, `api.js` or `app.js` assigns those on the client so they're consistent with your `db.js` key scheme.

Frontend (`api.js`):
- `generateCards(text, deckId)` — POSTs text, handles the response.
- Offline handling: if `navigator.onLine` is false (or the fetch fails), don't error out — queue the raw text (e.g. in a small IndexedDB store or even `localStorage` for this transient queue) and show a non-blocking toast. Retry automatically on `online` event.
- Client-side dedup: before handing new cards to `saveNewCards()`, compare against existing cards in the target deck (simple front-text similarity is enough for v1 — don't build a semantic dedup system for this).
- Edit step: render generated cards in an editable list before commit. This is a UI screen in `app.js`, not logic in `api.js` — keep `api.js` to network calls only, per the file structure rule.

**Done when:** you can upload a PDF, get back editable cards, tweak one, commit it, and it shows up correctly in Study Mode — and doing the same thing in airplane mode queues cleanly instead of erroring.

---

## Phase 4 — Flat list/grid view (accessibility fallback)

Build this **before** the canvas, as the spec insists — it's your only UI for a while, so it forces `app.js` orchestration to actually work.

- Simple deck list/grid, tap to enter Study Mode.
- Per-deck due count badge (pulled from `db.js`, no new logic needed).
- This is also your fallback for low-end devices — a toggle to switch to this view permanently should exist from day one, not bolted on after canvas.js ships.

**Done when:** the whole loop — browse decks, generate cards, study, review — works with zero canvas code in the app.

---

## Phase 5 — Territory Map (`canvas.js`)

Built last, as a skin over the already-working list view.

- `<canvas>`-based (not DOM nodes) infinite pan/zoom. Use pointer events for gesture handling (not deprecated touch events), matching the Pointer Events fix pattern from your Akasha Lens work.
- Viewport culling: only iterate/draw territories and islands whose bounding box intersects the current viewport rect. Level-of-detail: below some zoom threshold, draw a simplified/aggregated representation instead of full island detail.
- Vector-drawn only — paths, gradients, no raster assets, so this stays bandwidth-light.
- Island visual state (density/color/detail) is just a rendering function of the same mastery stats (review count, average stability) `db.js`/`scheduler.js` already have — no new data model needed.
- Tapping an island routes into Study Mode exactly the same way the flat list does. `canvas.js` should call the same entry point `app.js` uses for the list view, not a separate path.

**Done when:** the map is navigable, doesn't lag with culling/LOD on a large deck set, and every entry point converges on the same Study Mode.

---

## Phase 6 — PWA layer

Last, because it wraps a finished app rather than shaping it.

- `manifest.json` — name, icons, start_url, display: standalone.
- Service worker — cache the app shell (HTML/CSS/JS, not user data) so the app loads offline on a cold start, not just functions offline after first load. Cache-first for shell assets, network-first (with the offline queue from Phase 3) for `/generate-cards`.
- Test this by actually killing network before first load in an incognito/private window — "worked because it was cached from earlier testing" is the most common false-pass here.

**Done when:** fresh install, airplane mode, cold load, still opens and studies existing decks.

---

## Deployment

- Vercel edge for the FastAPI backend (or a Vercel-adjacent Python runtime if edge functions don't support your FastAPI setup as-is — worth checking Vercel's Python runtime docs before Phase 3, not after).
- Frontend as static files, no build step, so deployment is just "push the `frontend/` folder."
- Env vars (LLM API key etc.) live server-side only — never in client JS.

## Testing checklist before calling it done

- Airplane mode: generate (queues), study (works), close/reopen mid-session (resumes correctly).
- Big PDF import: confirm daily new-card cap actually caps day one, doesn't dump everything at once.
- Leech: grade a card "Again" past your threshold, confirm it gets flagged/suspended, not looping forever.
- iOS Safari storage eviction: export a deck, clear site data, reimport, confirm FSRS progress on matching card ids survives.
- QuotaExceededError: fill storage artificially (or mock it), confirm the app shows a toast instead of crashing.

## Suggested order to actually work through this with me

Since you're building phone-first via Termux/CI same as your other projects: I'd do one phase per session, each ending in something you can `git push` and see build. Say "next" or name the phase and I'll write it.
