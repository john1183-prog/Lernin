// teach-it.js
// Pacing policy and helpers for the Teach-It (Feynman technique) explanation flow.
// Zero dependencies, vanilla JS, runs offline in /public.

export const TEACH_IT_MAX_AUTO_PER_SESSION = 2;
export const TEACH_IT_MIN_CARDS_BETWEEN_AUTO = 4;

/**
 * Pure evaluation function for deciding whether an automatic Teach-It prompt
 * should be offered after a card is graded.
 *
 * Locked rules:
 * - Grade must be 'good' or 'easy'
 * - At most 2 auto prompts per study session
 * - At least 4 graded cards between auto prompts
 * - Must be a milestone:
 *   - Graduation: state transitions from 'learning' or 'relearning' -> 'review'
 *   - Recovery: card has had lapses >= 2
 *
 * @param {object} params
 * @param {string} params.grade - 'again' | 'hard' | 'good' | 'easy'
 * @param {string} [params.prevState] - card state before grade ('new', 'learning', 'review', 'relearning')
 * @param {string} [params.nextState] - card state after grade
 * @param {number} [params.lapses] - card lapse count
 * @param {number} [params.autoOfferedThisSession=0] - count of auto prompts already shown in this session
 * @param {number} [params.cardsSinceLastAuto=Infinity] - count of graded cards since the last auto prompt
 * @returns {boolean}
 */
export function shouldOfferTeachIt({
  grade,
  prevState,
  nextState,
  lapses = 0,
  autoOfferedThisSession = 0,
  cardsSinceLastAuto = Infinity
} = {}) {
  // 1. Grade must be 'good' or 'easy'
  if (grade !== 'good' && grade !== 'easy') {
    return false;
  }

  // 2. Max 2 automatic offers per session
  if (autoOfferedThisSession >= TEACH_IT_MAX_AUTO_PER_SESSION) {
    return false;
  }

  // 3. Spacing constraint: at least 4 cards between auto prompts
  if (cardsSinceLastAuto !== null && cardsSinceLastAuto !== undefined && cardsSinceLastAuto < TEACH_IT_MIN_CARDS_BETWEEN_AUTO) {
    return false;
  }

  // 4. Milestone check: Graduation or Recovery
  const isGraduation = (prevState === 'learning' || prevState === 'relearning') && nextState === 'review';
  const isRecovery = (typeof lapses === 'number' && lapses >= 2);

  return Boolean(isGraduation || isRecovery);
}

/**
 * Formats a timestamp into a friendly, warm relative time string.
 *
 * @param {number} timestamp
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!timestamp || typeof timestamp !== 'number') return 'Recently';

  const elapsedMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  if (months === 1) return '1 month ago';
  if (months < 12) return `${months} months ago`;
  return 'Over a year ago';
}
