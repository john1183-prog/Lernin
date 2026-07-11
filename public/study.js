// study.js
// Layer 2 — the review loop. Fully offline, zero network awareness, zero
// canvas dependency. This is the only file that should import scheduler.js
// for grading; canvas.js and app.js's list view both route INTO this module
// rather than reimplementing any of it.

import { getCardsDueTodayOrEarlier, updateCardAfterReview } from './db.js';
import { gradeCard, Grade } from './scheduler.js';

// ---------------------------------------------------------------------------
// Config (daily caps — a big PDF import should not dump 150 cards on day one)
// ---------------------------------------------------------------------------

const DEFAULT_NEW_CARD_CAP = 20;
const DEFAULT_REVIEW_CAP = 100;
const SECONDS_PER_CARD_ESTIMATE = 20; // for the "~4 min" pacer, not a scheduling input

// ---------------------------------------------------------------------------
// Session state
// Kept module-local rather than in a class — study.js only ever runs one
// session at a time, and this keeps the file small per the "no monolith"
// file-structure rule.
// ---------------------------------------------------------------------------

let session = null; // { deckId, queue: [], index: 0, container: HTMLElement, onExit: fn }

/**
 * Starts a study session for a deck (or all decks if deckId is omitted) and
 * renders it into `container`. This is the single entry point canvas.js and
 * the flat list view both call — same code path either way.
 *
 * @param {HTMLElement} container - element to render Study Mode into
 * @param {object} opts
 * @param {string} [opts.deckId]
 * @param {number} [opts.newCardCap]
 * @param {number} [opts.reviewCap]
 * @param {() => void} [opts.onExit] - called when the user backs out of the session
 */
export async function startStudySession(container, opts = {}) {
  const { deckId, newCardCap = DEFAULT_NEW_CARD_CAP, reviewCap = DEFAULT_REVIEW_CAP, onExit } = opts;

  // getCardsDueTodayOrEarlier() already excludes suspended cards by default
  // (excludeSuspended: true) during its cursor walk. The `!card.suspended`
  // check below is defense-in-depth only, now that `state` no longer doubles
  // as the suspension flag — a card's `state` is always one of
  // new/learning/review/relearning regardless of whether it's suspended.
  const dueCards = await getCardsDueTodayOrEarlier({ deckId });

  const newCards = dueCards.filter(c => c.state === 'new' && !c.suspended).slice(0, newCardCap);
  const reviewCards = dueCards
    .filter(c => c.state !== 'new' && !c.suspended)
    .slice(0, reviewCap);

  // Interleave rather than "all reviews then all new" — keeps sessions from
  // front-loading the hardest (newest) material.
  const queue = interleave(reviewCards, newCards);

  session = { deckId, queue, index: 0, container, onExit };

  if (queue.length === 0) {
    renderEmptyState(container);
    return;
  }

  renderCard();
}

function interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// No canvas, no framework — direct DOM. Thumb-reachable means the grade
// buttons sit in a fixed bottom bar, not scrolled away with long card content.
// ---------------------------------------------------------------------------

function renderCard() {
  const { queue, index, container } = session;
  const card = queue[index];
  const remaining = queue.length - index;
  const etaMinutes = Math.max(1, Math.round((remaining * SECONDS_PER_CARD_ESTIMATE) / 60));

  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'study-session';

  wrap.appendChild(buildTopBar(remaining, etaMinutes));

  const cardEl = document.createElement('div');
  cardEl.className = 'study-card';

  const frontEl = document.createElement('div');
  frontEl.className = 'study-card-front';
  frontEl.innerHTML = renderFront(card);
  cardEl.appendChild(frontEl);

  const backEl = document.createElement('div');
  backEl.className = 'study-card-back';
  backEl.style.display = 'none';
  backEl.innerHTML = renderBack(card);
  cardEl.appendChild(backEl);

  wrap.appendChild(cardEl);

  const revealBtn = document.createElement('button');
  revealBtn.className = 'study-reveal-btn';
  revealBtn.textContent = 'Show answer';
  revealBtn.addEventListener('click', () => {
    backEl.style.display = '';
    revealBtn.style.display = 'none';
    gradeBar.style.display = '';
  });
  wrap.appendChild(revealBtn);

  const gradeBar = buildGradeBar(card);
  gradeBar.style.display = 'none';
  wrap.appendChild(gradeBar);

  container.appendChild(wrap);
}

function buildTopBar(remaining, etaMinutes) {
  const bar = document.createElement('div');
  bar.className = 'study-top-bar';

  const exitBtn = document.createElement('button');
  exitBtn.className = 'study-exit-btn';
  exitBtn.setAttribute('aria-label', 'Exit study session');
  exitBtn.textContent = '\u2715';
  exitBtn.addEventListener('click', () => endStudySession());
  bar.appendChild(exitBtn);

  const pacer = document.createElement('div');
  pacer.className = 'study-pacer';
  pacer.textContent = `${remaining} left, ~${etaMinutes} min`;
  bar.appendChild(pacer);

  return bar;
}

function buildGradeBar(card) {
  const bar = document.createElement('div');
  bar.className = 'study-grade-bar';

  const grades = [
    { label: 'Again', value: Grade.AGAIN },
    { label: 'Hard', value: Grade.HARD },
    { label: 'Good', value: Grade.GOOD },
    { label: 'Easy', value: Grade.EASY }
  ];

  for (const g of grades) {
    const btn = document.createElement('button');
    btn.className = `study-grade-btn study-grade-${g.label.toLowerCase()}`;
    btn.textContent = g.label;
    btn.addEventListener('click', () => handleGrade(card, g.value));
    bar.appendChild(btn);
  }

  return bar;
}

function renderEmptyState(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'study-empty-state-wrap';

  const exitBtn = document.createElement('button');
  exitBtn.className = 'study-exit-btn';
  exitBtn.setAttribute('aria-label', 'Back');
  exitBtn.textContent = '\u2715';
  exitBtn.addEventListener('click', () => endStudySession());
  wrap.appendChild(exitBtn);

  const empty = document.createElement('div');
  empty.className = 'study-empty-state';
  empty.textContent = 'Nothing due right now. Come back later.';
  wrap.appendChild(empty);

  container.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Card content rendering — Q&A and cloze
// ---------------------------------------------------------------------------

// Matches {{c1::answer}} or {{c1::answer::hint}}
const CLOZE_PATTERN = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g;

function renderFront(card) {
  if (card.type === 'cloze') {
    return escapeHtml(card.front).replace(CLOZE_PATTERN, (_match, _num, _answer, hint) =>
      hint ? `<span class="cloze-blank">[${escapeHtml(hint)}]</span>` : '<span class="cloze-blank">[...]</span>'
    );
  }
  return escapeHtml(card.front);
}

function renderBack(card) {
  if (card.type === 'cloze') {
    // Reveal: strip the cloze markers, show the answers inline.
    return escapeHtml(card.front).replace(CLOZE_PATTERN, (_match, _num, answer) =>
      `<span class="cloze-answer">${escapeHtml(answer)}</span>`
    );
  }
  return escapeHtml(card.back);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

async function handleGrade(card, grade) {
  const { fsrsUpdate, reviewLogEntry } = gradeCard(card, grade);

  try {
    await updateCardAfterReview(card.id, fsrsUpdate, reviewLogEntry);
  } catch (err) {
    if (err.message === 'STORAGE_QUOTA_EXCEEDED') {
      showToast(session.container, "Storage is full — this grade wasn't saved. Free up space and retry.");
      return; // don't advance the queue on a failed write
    }
    throw err;
  }

  advance();
}

function advance() {
  session.index += 1;
  if (session.index >= session.queue.length) {
    renderEmptyState(session.container);
    if (session.onExit) session.onExit();
    session = null; // avoid double-firing onExit if the empty state's exit button is clicked too
    return;
  }
  renderCard();
}

function showToast(container, message) {
  const toast = document.createElement('div');
  toast.className = 'study-toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/**
 * Ends the session early (user backs out via app.js's nav, not a queue
 * exhaustion). Does no cleanup beyond clearing local state — nothing here
 * needs to touch the network or cancel anything, since every write already
 * completed synchronously per-card.
 */
export function endStudySession() {
  if (session?.onExit) session.onExit();
  session = null;
}
