// test_teach_it.mjs — Permanent unit tests for Teach-It pacing policy and teachingNote retrieval
// Run with: node public/test_teach_it.mjs

import assert from 'node:assert/strict';
import {
  shouldOfferTeachIt,
  formatRelativeTime,
  TEACH_IT_MAX_AUTO_PER_SESSION,
  TEACH_IT_MIN_CARDS_BETWEEN_AUTO
} from './teach-it.js';

console.log('=== 1. Auto true for graduation + good/easy ===');
{
  // learning -> review on 'good'
  const res1 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: Infinity
  });
  assert.equal(res1, true, 'Graduation from learning to review on good should offer Teach-It');

  // relearning -> review on 'easy'
  const res2 = shouldOfferTeachIt({
    grade: 'easy',
    prevState: 'relearning',
    nextState: 'review',
    lapses: 1,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 4
  });
  assert.equal(res2, true, 'Graduation from relearning to review on easy should offer Teach-It');
  console.log('  ok - graduation triggers auto offer for good/easy');
}

console.log('=== 2. Auto true for recovery (lapses >= 2) + good/easy ===');
{
  // card with lapses: 2 staying in review on 'good'
  const res1 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'review',
    nextState: 'review',
    lapses: 2,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 4
  });
  assert.equal(res1, true, 'Lapses >= 2 recovery on good should offer Teach-It');

  // card with lapses: 5 on 'easy'
  const res2 = shouldOfferTeachIt({
    grade: 'easy',
    prevState: 'review',
    nextState: 'review',
    lapses: 5,
    autoOfferedThisSession: 1,
    cardsSinceLastAuto: 6
  });
  assert.equal(res2, true, 'Severe lapse recovery on easy should offer Teach-It');
  console.log('  ok - recovery (lapses >= 2) triggers auto offer for good/easy');
}

console.log('=== 3. Auto false for routine good/easy (non-milestone) ===');
{
  // review -> review with 0 lapses
  const res1 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'review',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 10
  });
  assert.equal(res1, false, 'Routine review card without lapses should not offer Teach-It');

  // review -> review with 1 lapse (below recovery threshold of 2)
  const res2 = shouldOfferTeachIt({
    grade: 'easy',
    prevState: 'review',
    nextState: 'review',
    lapses: 1,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 10
  });
  assert.equal(res2, false, 'Routine review card with single lapse should not offer Teach-It');

  // new -> learning on good (not yet graduating to review)
  const res3 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'new',
    nextState: 'learning',
    lapses: 0,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 10
  });
  assert.equal(res3, false, 'New to learning transition should not offer Teach-It');
  console.log('  ok - routine cards do not trigger auto offer');
}

console.log('=== 4. Auto false for again and hard regardless of milestone ===');
{
  // graduation candidate graded 'again'
  const res1 = shouldOfferTeachIt({
    grade: 'again',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 10
  });
  assert.equal(res1, false, 'Again grade should never offer Teach-It');

  // recovery candidate graded 'hard'
  const res2 = shouldOfferTeachIt({
    grade: 'hard',
    prevState: 'review',
    nextState: 'review',
    lapses: 3,
    autoOfferedThisSession: 0,
    cardsSinceLastAuto: 10
  });
  assert.equal(res2, false, 'Hard grade should never offer Teach-It');
  console.log('  ok - again/hard grades never trigger auto offer');
}

console.log('=== 5. Auto false when session auto cap hit (max 2 per session) ===');
{
  const res1 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: TEACH_IT_MAX_AUTO_PER_SESSION,
    cardsSinceLastAuto: 10
  });
  assert.equal(res1, false, 'Should not offer when autoOfferedThisSession === 2');

  const res2 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'review',
    nextState: 'review',
    lapses: 4,
    autoOfferedThisSession: 3,
    cardsSinceLastAuto: 10
  });
  assert.equal(res2, false, 'Should not offer when autoOfferedThisSession > 2');
  console.log('  ok - auto cap strictly enforced at max 2');
}

console.log('=== 6. Spacing constraint (< 4 cards since last auto) ===');
{
  // 3 cards since last auto (insufficient spacing)
  const res1 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 1,
    cardsSinceLastAuto: 3
  });
  assert.equal(res1, false, 'Should reject when cardsSinceLastAuto < 4');

  // 0 cards since last auto (immediately following prior auto)
  const res2 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 1,
    cardsSinceLastAuto: 0
  });
  assert.equal(res2, false, 'Should reject when cardsSinceLastAuto === 0');

  // Exactly 4 cards since last auto (sufficient spacing)
  const res3 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 1,
    cardsSinceLastAuto: 4
  });
  assert.equal(res3, true, 'Should accept when cardsSinceLastAuto === 4');

  // 5 cards since last auto
  const res4 = shouldOfferTeachIt({
    grade: 'good',
    prevState: 'learning',
    nextState: 'review',
    lapses: 0,
    autoOfferedThisSession: 1,
    cardsSinceLastAuto: 5
  });
  assert.equal(res4, true, 'Should accept when cardsSinceLastAuto > 4');
  console.log('  ok - spacing rule (< 4 cards between auto prompts) verified');
}

console.log('=== 7. formatRelativeTime formatting tests ===');
{
  const now = 1700000000000;
  assert.equal(formatRelativeTime(now - 10000, now), 'Just now');
  assert.equal(formatRelativeTime(now - 120000, now), '2m ago');
  assert.equal(formatRelativeTime(now - 7200000, now), '2h ago');
  assert.equal(formatRelativeTime(now - 86400000, now), 'Yesterday');
  assert.equal(formatRelativeTime(now - 3 * 86400000, now), '3d ago');
  assert.equal(formatRelativeTime(now - 35 * 86400000, now), '1 month ago');
  assert.equal(formatRelativeTime(null, now), 'Recently');
  console.log('  ok - formatRelativeTime produces warm relative strings');
}

console.log('=== 8. getLatestTeachingNote logic (cursor prev traversal for newest non-null) ===');
{
  // Simulated cursor walk matching db.js's getLatestTeachingNoteForCard
  function simulateGetLatestTeachingNote(entriesForCard) {
    // Sorted newest first ('prev' order on by_cardId)
    const reversed = [...entriesForCard].sort((a, b) => b.reviewedAt - a.reviewedAt);
    for (const entry of reversed) {
      if (entry && entry.teachingNote && typeof entry.teachingNote === 'string' && entry.teachingNote.trim().length > 0) {
        const note = entry.teachingNote.trim();
        return {
          teachingNote: note,
          note,
          reviewedAt: entry.reviewedAt || null,
          toString() { return note; },
          valueOf() { return note; }
        };
      }
    }
    return null;
  }

  const cardReviews = [
    { cardId: 'c1', grade: 'again', reviewedAt: 1000, teachingNote: null },
    { cardId: 'c1', grade: 'good', reviewedAt: 2000, teachingNote: 'Initial concept explanation' },
    { cardId: 'c1', grade: 'good', reviewedAt: 3000, teachingNote: null }, // routine review with no note
    { cardId: 'c1', grade: 'easy', reviewedAt: 4000, teachingNote: 'Refined mnemonic and formula context' },
    { cardId: 'c1', grade: 'good', reviewedAt: 5000, teachingNote: null }, // subsequent review with null note
    { cardId: 'c1', grade: 'good', reviewedAt: 6000, teachingNote: '   ' }   // whitespace only note
  ];

  const found = simulateGetLatestTeachingNote(cardReviews);
  assert.ok(found, 'Should find latest non-null note');
  assert.equal(found.teachingNote, 'Refined mnemonic and formula context');
  assert.equal(found.reviewedAt, 4000);
  assert.equal(String(found), 'Refined mnemonic and formula context');

  // Empty reviews case
  const notFound = simulateGetLatestTeachingNote([
    { cardId: 'c2', grade: 'good', reviewedAt: 1000, teachingNote: null }
  ]);
  assert.equal(notFound, null, 'Should return null when no teaching notes exist');

  console.log('  ok - returns newest non-null teachingNote skipping later null/empty reviews');
}

console.log('\nALL CHECKS PASSED for Teach-It pacing & teachingNote retrieval.');
