# Lernin UI/UX Architecture Brief — "A Place You Return To"

Written for implementation, in this repo or in antigravity. Self-contained — doesn't assume you've read the rest of this project's history, though `UPCOMING_FEATURES.md` and `HANDOFF_NEXT_SESSION.md` in the repo root are the canonical record if anything here needs more depth. Uses the assumptions → domain diagnosis → design plan → implementation strategy shape of a standard UI/UX architecture brief, filled with Lernin's actual constraints and actual current code rather than placeholders.

---

## 1. Assumptions & inferences — stated, not guessed

- **Platform is fixed, not open for reconsideration:** vanilla JS, no build step, no framework, no bundler. `/public` is served as-is. This is a load-bearing product decision, not incidental — the app boasts an offline-first PWA that starts instantly on a low-end phone with zero raster assets. Nothing in this brief should introduce a dependency, a build step, or a network asset.
- **2D only, decided explicitly.** A 3D workspace (Three.js/WebGL) was considered and rejected — not because it's a bad idea in isolation, but because it trades away the zero-dependency, tiny-footprint identity for a different kind of richness, and that trade wasn't one to make silently. Everything below assumes Canvas 2D, same as today.
- **The due-cards hero stays the top of Home.** "Study now" remains the primary, unambiguous first action. This is not being reopened. What's changing is what sits *below* it.
- **The brand voice is decided and out of scope here:** warm, rescuing, "we've suffered old study habits too" — not corrective, not a critic. See `HANDOFF_NEXT_SESSION.md` for the full reasoning. Any new copy this brief implies should match that voice.
- **The Encarta-nostalgia identity direction is decided and already partway built:** a sound identity chime, three easter eggs (`secrets.js`), theme-aware onboarding. This brief is the next phase of that same direction — visual, not just interaction-layer.
- **Existing domain-relevant infrastructure to reuse, not rebuild:**
  - `islandColor(mastery, seedId)` in `canvas.js` **already** maps a deck's average mastery to a sand → ochre → moss hue gradient. The mastery-to-color mapping this brief calls for already exists — what's missing is everything *around* that color (shape, texture, environment).
  - `sound.js`'s synthesis-only philosophy (Web Audio oscillators, zero audio files) and its existing `playIdentityChord()` gating pattern (`sessionStorage`-gated, fires once) are the template for any new sound this brief calls for.
  - `secrets.js`'s pure-function, no-DOM-access pattern for anything discoverable/hidden.
  - `lerpColor` (in `motion-player.js`) and `lerpHsl` (in `canvas.js`) already prove smooth color interpolation works cleanly in this codebase — reuse, don't reinvent.

---

## 2. Domain epistemology — how this app's "experts" actually think

Lernin's domain isn't really "flashcards" — it's the intersection of two established memory sciences it already names explicitly in its own Help copy:

- **Spaced repetition (FSRS):** retrieval strength decays over time; review timed just before forgetting is what rebuilds it. The "expert" here (a cognitive scientist, or just a good student) thinks in terms of *when*, not just *what* — timing is the whole mechanism.
- **Method of Loci / memory palace:** spatial encoding gives memory a second handle — placing an idea *somewhere* makes it more retrievable than a flat list. The "expert" here thinks spatially — a place has texture, orientation, landmarks, things that have grown or decayed.

**The current gap, precisely stated:** the Territory Map is *labeled* a memory palace but doesn't yet *behave* like a place. A perfect filled circle with a hue tied to mastery is closer to a data-visualization dot than a location. The Method of Loci depends on a place having distinguishing texture your spatial memory can actually grab onto — "the island near me is starting to look worn" is a usable memory hook; "the circle is more orange than it was" is not, even though today they're carrying the identical underlying signal.

**Aesthetic lineage:** Exploratory-Wonder (Encarta's own Virtual Globe, Myst-era discovery) crossed with the domain's own real texture — cultivated land, not abstract data. Not Bloomberg-dense (this isn't a professional tool optimizing for information-per-pixel), not Hacker-Minimal (the whole point is warmth, not austerity).

---

## 3. The design plan

### 3.1 Territory Map — the biggest single change, worth doing first

**Diagnosis of what's actually wrong**, from `canvas.js`'s real current code:
- `drawIsland()` fills a perfect circle (`ctx.arc`, constant radius). No irregularity, no coastline, no elevation — reads as a UI element, not a landform.
- The background is a flat theme color. No horizon, no water, no sense of "a world the islands sit in."
- Paths between related cards (already computed, already drawn as lines in `drawIslandConnections()`) are geometric connectors, not something that reads as a route.
- Nothing changes based on *time* — a deck studied yesterday and a deck untouched for a month render identically apart from the mastery hue.

**What to build, in order (each step is independently shippable and visible):**

1. **Procedural island silhouettes, replacing the circle.** Generate an irregular polygon per island — 12–16 points around the center, each at `baseRadius * (1 + seededNoise)`, connected with quadratic curves for a soft coastline rather than straight polygon edges. Seed the noise from the island's own ID (`hashToUnit()` already exists in `canvas.js` for exactly this) so the shape is *stable* across renders and sessions, not randomly different every reload — a place has to look like the same place when you come back to it.
2. **Terrain shading, not flat fill.** A radial gradient from a lighter "high ground" center to a darker "shoreline" edge, using the same `islandColor()` hue this island already has — this is a rendering change, not a new color decision.
3. **Texture density tied to card count.** A handful of small scattered marks (simple dots/tufts, seeded and stable per island, same technique as the coastline noise) scattered across the interior — density scales with how many cards live there. A 3-card deck should visibly look sparser than a 90-card one at a glance, before you read any number.
4. **An actual environment, not a flat background.** A soft gradient (sky-to-horizon in light theme, deep-space-to-horizon in dark) behind the whole L1 view, replacing the current flat `--bg` fill. Doesn't need to be literal — needs to stop reading as "an app's background color."
5. **Paths as routes, not lines.** The existing dashed cross-deck connector lines get a "worn path" treatment — a slightly thicker, textured stroke (dash pattern already does some of this work; a subtle double-line "road" or a lightly irregular hand-drawn wobble reads as a path between places rather than a graph edge).
6. **Recency as ambient life.** A deck untouched for weeks should look subtly quieter (slightly desaturated, less texture-shimmer) than one studied today — reuse `territory.activityLevel`, which `drawTerritoryActivityHalo()` already tracks and uses for the glow halo; extend the same signal into the terrain rendering itself, not just the halo.
7. **Idle motion, not a static frame.** A very slow, continuous sway or shimmer on water/edges even when nothing is being interacted with — same technique already shipped in `secrets.js`'s hidden map easter egg (`Math.sin(Date.now() / 900)`-driven sway). This is what makes a place feel alive rather than paused.

**The consistent visual language, stated once, applied everywhere (map AND both mind maps):**
| Signal | Meaning | Where it already exists / needs extending |
|---|---|---|
| Size | Card count | New for islands; card-mind-map nodes already vary radius by stability — keep that, don't invert the meaning between views |
| Color/hue | Mastery | Already exists (`islandColor`) for the map; card mind map colors by stability too — confirm the two use the *same* hue ramp, not two different ones that happen to both be green-ish |
| Texture/density | Card count (secondary reinforcement of size) | New |
| Ambient vibrancy | Recency of last visit | New for terrain rendering; already tracked as data |
| Paths | Actual defined relationships (`dependsOn`/`related`, from `getRelationshipsFrom`) | Already drawn; needs the route-texture pass above |

This table is the actual deliverable of this section — whoever implements this should treat it as a contract, not just this map's local convention. If a new visual surface is added later, it inherits this table rather than inventing its own meaning for size/color.

### 3.2 Universal "jump to the actual thing," a hard requirement across every visual surface

Explicit product requirement, not a nice-to-have: **from the Territory Map, the card Mind Map, the document Mind Map, or Motion Studio, there must always be a fast path to either study the related card right now, or see its full content — never a dead end that requires backing out to a deck list first.**

Current state, checked against the real code:
- Territory Map L3 (tap a node) already surfaces full card detail + a study button. ✅ already meets the bar.
- Card Mind Map's node tap (`mind-map.js`'s `openNodeDetail`) currently shows front/back text in a peek panel — **verified: no study action at all**, just a close button. This is the one clear gap against the requirement as it stands today; add a "Study this card" action to that panel.
- Document Mind Map's nodes are topic nodes from a document, not 1:1 with a specific card — there's no natural single "jump to the card" target *unless* a card was actually generated from that section. Don't force a fake mapping here. The honest version: if/when card-generation ever tags which document *section* a card came from, that becomes a real link; until then, this surface's honest action is "Explain with motion" (already shipped) and "back to Documents," not a fabricated card link.
- Motion Studio, topic-driven, has no inherent tie to a specific card either. Same honesty principle: don't force a link that isn't real. If a Motion Studio session was launched *from* a mind-map node (already the primary entry path, shipped this session), carrying that node's originating context back is legitimate; a cold, freely-typed topic doesn't have anything to link to.

**Implementation shape:** a single, small, reusable UI affordance (e.g., a `cardQuickActions(cardId)` helper returning a consistent little action row — "Study now" / "View card" — used identically wherever a real card ID is in hand). Build it once, use it everywhere a card ID actually exists, and don't invent a fake target where one doesn't exist.

### 3.3 Card Mind Map — bring it in line with the same table above

Smaller lift than the territory map, same principle: nodes are currently plain filled circles colored by stability. Apply the same texture/shape treatment at a lighter weight (this is a denser, more data-like view by nature — a full terrain treatment here would be too busy) — a soft irregular edge instead of a perfect circle is likely enough to feel consistent with the map without competing with it for detail.

### 3.4 Motion Studio — "polished, always alive, wanting to make more"

This is a smaller ask than the map, and much of it is copy/UI-state work rather than a rendering rebuild:
- The generation flow already exists and works; "alive" here likely means: richer loading/generating states (the current `setStatus('Generating…')` is plain text — a small animated indicator, reusing the sway/pulse technique already established elsewhere, would go a long way for little cost), and a stronger post-generation moment (the saved-scripts list currently just lists topics with a Play button — consider a small preview thumbnail-in-motion or an animated "new" indicator on the just-generated one).
- "Wanting to make more" is a copy/CTA question more than a rendering one — the empty/post-watch states are where this lives (e.g., after watching a generated explainer, a warm, specific prompt like "Explain another part of this deck?" rather than just leaving the person at a static list).

### 3.5 Home screen restructure

Confirmed shape: **due-cards hero stays exactly where it is, unchanged, at the top.** Below it, a new feature grid — Encarta-Kids-style: neatly boxed tiles, each with a name, a small illustrative visual (not a stock photo — something drawn in the same terrain/growth visual language as the rest of this brief, so it doesn't look bolted on), and a one-line description. Hover (or long-press-equivalent on touch) triggers a small sound (new, distinct tones per tile — same synthesis-only approach as `sound.js`'s existing chime, gated the same way so it doesn't fire on every re-render) plus a CSS animation (scale/glow, consistent with the rest of the app's motion language, `cubic-bezier(0.4, 0, 0.2, 1)` already used elsewhere).

**Proposed tile set** (confirm before building — this is a real content decision, not just layout):
- **Study** — could be redundant with the hero above it; consider whether this tile exists at all, or whether the grid starts one level down (Mind Map, Territory Map, Motion Studio, Documents) since "Study" already has the hero's full attention.
- **Territory Map**
- **Mind Map** (which one — card-based, document-based, or a single tile that routes contextually? Worth deciding explicitly rather than shipping two similarly-named tiles.)
- **Motion Studio**
- Possibly **Documents** and/or **Stats**, if they belong at this level of prominence — open question, not decided here.

**Deck list becomes secondary**, likely living either under a "Decks" tile in the grid, or as a scrollable section below the grid — not the first thing on screen the way it is today. **Archiving**: a boolean `archived` field on the deck record, an "Archive" action in the existing deck action sheet, archived decks excluded from the default list view with a small "Archived (N)" affordance to reveal them. Self-contained, no dependency on anything else in this brief — buildable independently and first, if a quick early win is useful.

---

## 4. Jaw-drop moments — specific to this domain, not generic

1. **The map, re-opened after a study streak.** Someone who's been consistent for a week opens the Territory Map and their islands are visibly lusher, denser, more alive than they remember — the payoff of the mastery-color-and-texture system landing as a felt result, not a stat.
2. **A newly imported deck's island literally taking shape** — the procedural coastline animating in (points settling from a rough circle into their final jittered shape) the first time a new deck's island renders, mirroring the existing "discovery fog" instinct from the earlier Encarta research pass, built with tools that already exist here (keyframed settling, same easing already used throughout).
3. **The hover-grid on Home** — sound + motion together, consistently, on every tile, so the *first ten seconds* in the app already feel different from a SaaS product before a single card has been studied.

---

## 5. Implementation strategy

- **Tech stack: unchanged.** Canvas 2D, vanilla JS, no new dependencies. Every technique above (seeded procedural noise, radial gradients, color interpolation, idle sway) is achievable with what's already in `canvas.js`, `secrets.js`, and `motion-player.js` today — this is a rendering-quality pass, not a new subsystem.
- **Suggested build order**, each step independently shippable and demoable:
  1. Deck archiving (fully self-contained, no dependency on anything else here).
  2. Territory Map terrain pass (§3.1, steps 1–4) — the single highest-visual-impact change.
  3. Territory Map paths + recency + idle motion (§3.1, steps 5–7).
  4. Universal jump-to-card audit (§3.2) — mostly wiring/verification against what already exists, not new rendering.
  5. Card Mind Map consistency pass (§3.3).
  6. Home restructure + hover grid (§3.5) — biggest information-architecture change, do after the visual language above exists so the grid's tile art can actually reuse it.
  7. Motion Studio polish (§3.4).
- **Verification standard, matching this project's established practice:** anything rendered gets a real Playwright screenshot at multiple states, not just a code read. Anything with a seeded/procedural element gets checked for stability (same island, reloaded, must look the same — verify the seed actually produces deterministic output, don't assume). Anything touching `canvas.js`'s existing physics/render loop gets checked against a realistic-scale deck (the existing card mind map had a real, previously-invisible physics bug that only appeared at ~97 nodes — don't assume a small test case is representative).

## 6. Open questions, not decided here — resolve before or during build, don't guess

- Exact feature-grid tile set (§3.5) — listed candidates above, not finalized.
- Whether "Mind Map" on Home routes to the card-based or document-based version, or is itself a small chooser.
- Whether Motion Studio's "make more" prompt should ever proactively suggest a topic (e.g., from a deck's weakest cards) or stay purely reactive to what the person just watched.
