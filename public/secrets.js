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
