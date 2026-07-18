# Lernin — Pre-Ship Test Checklist

I can't run these myself — they need a real device/browser and your deployed
backend. Check them off as you go; each one maps to something specific I
built, not a generic "test everything" list.

## Offline round-trip
- [ ] Turn on airplane mode. Open the app fresh (cold load) — it should still open (PWA shell cache).
- [ ] Study an already-due card, grade it — IndexedDB write should succeed with no network.
- [ ] Close the app mid-session, reopen — should resume from where FSRS left off.
- [ ] Import a PDF while offline — should show "queued" toast, not an error.
- [ ] Turn network back on — queued generation should fire automatically (`online` event in api.js) and toast "Back online — generated N cards."

## Daily caps
- [ ] Import a large PDF that would generate 50+ cards into a fresh deck.
- [ ] Confirm only `newCardCap` (default 20) show as due on day one, not all of them.

## Leech handling
- [ ] Grade the same card "Again" four times in a row (across sessions if needed).
- [ ] Confirm it flips to `state: 'suspended'` and stops appearing in the due queue.

## Storage resilience
- [ ] Export a deck (once export UI exists — currently `exportDeck()` in db.js has no button wired up yet, worth noting).
- [ ] Clear site data in browser settings (simulates iOS Safari eviction).
- [ ] Reimport — confirm FSRS progress (stability/difficulty/due_date) on matching card ids survived, not reset to defaults.

## Quota handling
- [ ] Fill device storage artificially (or throttle via devtools) and trigger a card save.
- [ ] Confirm a toast appears ("Storage is full...") instead of a silent failure or crash.

## Territory Map
- [ ] Pan and pinch-zoom feel smooth with 20+ decks across several territories.
- [ ] Drag an island to a new spot, leave the map, come back — position should persist (territoryLayout store).
- [ ] Zoom below ~0.5 — islands should disappear, leaving just the soft territory blob (LOD).
- [ ] Toggle to List view and back — both should show the same decks/due-counts.

## PDF import
- [ ] Try a text-based PDF (should extract cleanly).
- [ ] Try a scanned/image-only PDF (should show "couldn't find any text" toast, not crash — pdf.js can't OCR).
- [ ] Try a non-PDF file (should reject with a clear toast before ever calling pdf.js).

## Generation quality spot-check
- [ ] Skim 10 generated cards for compound questions or ambiguous answers (the LLM prompt asks for atomic/unambiguous, but LLMs don't always comply).
- [ ] Confirm cloze cards render with a blank on front, full answer on back.
