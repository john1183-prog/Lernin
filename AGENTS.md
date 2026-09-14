# Lernin Development Rules & Architectural Invariants

Universal guidelines, constraints, and operational standards for agents working in the Lernin codebase.

## 1. Platform Invariants (Non-Negotiable)
- **Zero-Dependency Vanilla JS**: The app runs directly from `/public` as an offline-first PWA with no bundler, no framework, and no build step. Never introduce npm build dependencies, external raster assets, or remote font/audio libraries.
- **2D Canvas & Procedural SVG Only**: All visual surfaces (Territory Map, Mind Maps, Feature Grid) use Canvas 2D and inline programmatic SVGs. No 3D WebGL or heavy external graphic runtimes.
- **Synthesis-Only Audio**: Sound effects must use Web Audio API oscillators directly in `sound.js`. Never introduce audio sound files (`.mp3`, `.wav`, `.ogg`). All audio cues must respect user sound settings and be properly throttled/debounced.

## 2. Visual Language & Domain Semantics
- **Size**: Tracks card count (for deck islands) or stability/retrieval strength (for card nodes).
- **Color / Hue**: Tracks mastery across the unified terrain palette (`SAND_HSL` novice → `OCHRE_HSL` intermediate → `MOSS_HSL` mastered).
- **Inheritance Contract**: Any new visual surface must strictly inherit the meanings in the visual language table from `UI_UX_ARCHITECTURE_BRIEF.md` rather than inventing new meanings for size, color, or texture.

## 3. Brand & Voice
- **Warm & Rescuing**: Lernin's voice is empathetic, supportive, and understanding ("we've suffered old study habits too") — never corrective, pedantic, or critical.
- **Copy Alignment**: Any new UI copy, empty states, micro-copy, or post-action CTAs must match this warm, encouraging voice.

## 4. Decision Protocol ("Stated, Not Guessed")
- **Never Guess Design Decisions**: When open questions, architectural choices, or underspecified requirements arise (e.g. tile sets, routing behavior, proactive vs. reactive prompts), **stop and ask the user**. Explicitly present clear options and await approval before writing code.
- **Honesty Principle across Surfaces**: Do not fabricate fake card links or artificial actions on visual surfaces that lack an underlying entity. If a surface does not map 1:1 to a card (e.g. Document Mind Map or global `/motion`), provide honest contextual actions only.

## 5. Incremental Build Order & Live Backlog Policy
- **Strict Scope Boundaries**: Work strictly on the requested step. Do not begin subsequent roadmap items prematurely.
- **Atomic Backlog Commits**: `UPCOMING_FEATURES.md` is a live backlog. Any feature or polish step committed to version control must update `UPCOMING_FEATURES.md` in the **exact same git commit** as the code changes.

## 6. Verification & Test Hygiene
- **Real-Path Browser Verification**: All visual or behavioral changes must be verified through headless Chrome CDP scripts with automated DOM assertions and captured screenshots (both Light and Dark themes).
- **Test Artifact Hygiene**: Throwaway verification harnesses (`scratch/verify_*.py` and similar temporary scripts) must be deleted or kept out of the repository before committing; only permanent test suites (`public/test_*.mjs`, `api/test_*.py`) stay in the repo.
- **Windows Shell Conventions**:
  - In PowerShell commands, use `;` to chain statements. Never use `&&`, which fails on Windows PowerShell 5.1.
  - In Python test/verification scripts, always configure `sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)` to prevent `cp1252` encoding crashes when printing unicode or emoji characters.
  - In CDP `Runtime.evaluate` blocks, import modules using root-relative paths (`await import('/db.js')`), not relative paths (`./db.js`), to guarantee resolution from any page location.
- **Full Regression Integrity**: Ensure both the Node audio test suite (`node public/test_motion_player_audio.mjs`) and the Python backend tests (`python -m unittest discover -s api -p "test_*.py"`) pass with exit code 0 before concluding.

## 7. Git & Security Hygiene
- **PAT Hygiene**: If embedding a Personal Access Token (PAT) into a git remote URL to push, embed it only for the duration of the push command, and immediately scrub the remote back to plain HTTPS (`https://github.com/john1183-prog/lernin`) afterwards. Never persist credentials in git config or remote URLs.
