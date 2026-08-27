/* secrets.js — small, warm discoveries for people who go looking.

   Deliberately NOT literal references to Encarta's own eggs (a pineapple
   hidden in an article, typing "good boy" for a dog emoji) -- those are
   inside jokes about a different product, and transplanting them here
   would feel like wearing someone else's memory rather than making one
   of Lernin's own. These are built from Lernin's own voice and visual
   language instead -- see UPCOMING_FEATURES.md for the reasoning.

   Each egg is a small, pure function: given some input, return a
   response (or null if it doesn't match). No DOM access here -- callers
   render the response themselves, so these stay reusable across
   whichever screen wants to check for one, and easy to unit-test.
*/

const GREETINGS = ['hello', 'hi', 'hey', 'is anyone there', 'anyone there', 'anybody there', 'anybody home'];

/**
 * Cards-view search box, and anywhere else free-text search happens.
 * Typing a greeting instead of an actual search returns a small,
 * in-voice response -- the same warm, "we've been where you are"
 * companion tone as the rest of the app, not a random non-sequitur.
 */
export function checkGreetingEasterEgg(query) {
  if (!query) return null;
  const normalized = query.trim().toLowerCase().replace(/[?!.]+$/, '');
  if (GREETINGS.includes(normalized)) {
    return "Hi. We're here. Search whenever you're ready \u2014 no rush.";
  }
  return null;
}

/**
 * Territory Map (L1). A deliberately distant, empty world coordinate --
 * chosen far past typical territory placement (territoryPosition() in
 * canvas.js spaces territories via TERRITORY_SPACING=900 * sqrt(index),
 * so even a map with a dozen territories stays well under 3200 from
 * origin) -- found only by deliberately zooming all the way in and
 * panning somewhere with nothing else there. Ties into the app's own
 * growth/mastery visual language (islands literally get more vibrant as
 * you master them) rather than being an arbitrary hidden object: the
 * idea is "this is where it all starts," not "here's a random pineapple."
 */
export const MAP_SECRET_SPOT = { x: 4000, y: -3000 };
export const MAP_SECRET_RADIUS = 160;
export const MAP_SECRET_MIN_ZOOM = 2.8; // L1's zoom caps at 3

export function isNearMapSecret(cameraX, cameraY, cameraZoom) {
  if (cameraZoom < MAP_SECRET_MIN_ZOOM) return false;
  const dx = cameraX - MAP_SECRET_SPOT.x, dy = cameraY - MAP_SECRET_SPOT.y;
  return Math.sqrt(dx * dx + dy * dy) < MAP_SECRET_RADIUS;
}

const MAP_SECRET_SEEN_KEY = 'lernin:foundMapSecret';

export function hasFoundMapSecret() {
  try { return localStorage.getItem(MAP_SECRET_SEEN_KEY) === '1'; } catch { return true; }
}

export function markMapSecretFound() {
  try { localStorage.setItem(MAP_SECRET_SEEN_KEY, '1'); } catch { /* private browsing, etc. -- fine to no-op */ }
}

/**
 * End of a study session. A genuinely real, already-wired moment (unlike
 * streak freezes, which have full backend logic in db.js but currently no
 * UI that ever calls it -- not something to bolt an easter egg onto
 * without first building the feature it'd depend on). A small session
 * (1-4 cards) getting every grade right isn't unusual enough to call out;
 * five or more clean is a genuine, noticeable run.
 */
const CLEAN_SWEEP_MIN_CARDS = 5;
const CLEAN_SWEEP_MESSAGES = [
  "Clean sweep. Every single one.",
  "Not one Again. That's a real session.",
  "All of them. Nothing slipped."
];

export function checkCleanSweep(results) {
  if (!results) return null;
  const total = (results.again || 0) + (results.hard || 0) + (results.good || 0) + (results.easy || 0);
  if (total < CLEAN_SWEEP_MIN_CARDS || results.again > 0) return null;
  return CLEAN_SWEEP_MESSAGES[Math.floor(Math.random() * CLEAN_SWEEP_MESSAGES.length)];
}
