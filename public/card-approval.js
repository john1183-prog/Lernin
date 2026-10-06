/**
 * card-approval.js
 *
 * Tier 4 #5: Two-pass card approval for AI-generated and imported decks.
 * Partitions cards into "Ready to study" and "Check against source" (drafts),
 * prepares staged commit payloads, and provides predicates to differentiate
 * drafts from leeches and active cards.
 *
 * Platform invariants:
 * - Pure vanilla JS; zero dependencies.
 * - Preserves FSRS mathematical fields and scheduling invariants.
 * - Warm, protective voice: drafts are held safely rather than discarded.
 */

import { checkCardsFidelity } from './card-fidelity.js';

/**
 * Returns true if the card is a held AI draft (suspended with unverified fidelity flag).
 * Distinguishes drafts from leeches (which are suspended due to repeated recall lapses).
 *
 * @param {object} card
 * @returns {boolean}
 */
export function isDraftCard(card) {
  return Boolean(card && card.suspended && card.fidelityFlag && card.fidelityFlag.status === 'unverified');
}

/**
 * Returns true if the card is a real leech (suspended or state==='suspended', but NOT an unverified draft).
 *
 * @param {object} card
 * @returns {boolean}
 */
export function isLeechCard(card) {
  return Boolean(card && (card.suspended || card.state === 'suspended') && !isDraftCard(card));
}

/**
 * Partitions a list of cards into ready vs draft categories.
 * If sourceText is provided, runs client-side fidelity check first.
 *
 * @param {Array<object>} cards
 * @param {string|null} [sourceText]
 * @returns {{ ready: Array<object>, drafts: Array<object> }}
 */
export function partitionCardsForApproval(cards, sourceText = null) {
  if (!Array.isArray(cards)) return { ready: [], drafts: [] };

  const clone = cards.map(c => ({ ...c }));
  if (sourceText && typeof sourceText === 'string' && sourceText.trim()) {
    checkCardsFidelity(clone, sourceText);
  }

  const ready = [];
  const drafts = [];

  for (const card of clone) {
    if (card.fidelityFlag && card.fidelityFlag.status === 'unverified') {
      drafts.push(card);
    } else {
      ready.push(card);
    }
  }

  return { ready, drafts };
}

/**
 * Builds the commit payload for saveNewCards given an array of items with selection status.
 * Selected items are saved active (suspended: false).
 * Unselected items are saved as drafts (suspended: true).
 *
 * @param {Array<{ card: object, selected: boolean }>} items
 * @returns {Array<object>} cards ready for saveNewCards
 */
export function buildApprovalCommitPayload(items) {
  if (!Array.isArray(items)) return [];
  const payload = [];
  for (const item of items) {
    if (!item || !item.card) continue;
    if (item.selected) {
      payload.push({
        ...item.card,
        suspended: false
      });
    } else {
      payload.push({
        ...item.card,
        suspended: true
      });
    }
  }
  return payload;
}
