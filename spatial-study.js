/* spatial-study.js — Review cards at their map positions
   Uses the same FSRS scheduler as study.js but renders card modals
   over the live map instead of replacing the root DOM.
*/

import {
  getCardsDueForDeck, getCardsDueTodayOrEarlier, updateCardAfterReview, getCard
} from './db.js';
import { gradeCard, previewIntervals, Grade } from './scheduler.js';
import { showToast } from './app.js';

/**
 * @param {HTMLElement} container  map root (canvas lives inside)
 * @param {string} deckId
 * @param {{
 *   pathNodeIds?: string[],
 *   onGrade?: (cardId: string, grade: string) => void,
 *   onExit?: () => void,
 *   camera?: {x,y,zoom},
 *   targetCamera?: {x,y,zoom},
 *   cardNodes?: Array<{id,x,y}>,
 *   worldToScreen?: (x,y)=>{x,y}
 * }} opts
 */
export async function startSpatialReview(container, deckId, opts = {}) {
  let cards;
  if (opts.pathNodeIds?.length) {
    // Path order, still filter to due (or show all with badge)
    const all = await Promise.all(opts.pathNodeIds.map(id => getCard(id)));
    const now = Date.now();
    cards = all.filter(Boolean).map(c => ({
      ...c,
      _notDue: (c.due_date || 0) > now || c.suspended
    }));
  } else {
    cards = await getCardsDueForDeck(deckId);
    cards = cards.filter(c => !c.suspended);
  }

  if (!cards.length) {
    showToast('No cards due on this map');
    opts.onExit?.();
    return;
  }

  const state = {
    queue: cards,
    index: 0,
    results: { again: 0, hard: 0, good: 0, easy: 0 },
    isRevealed: false
  };

  const overlay = document.createElement('div');
  overlay.className = 'spatial-review-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Spatial review');
  container.appendChild(overlay);

  const counter = document.createElement('div');
  counter.className = 'spatial-review-counter';
  overlay.appendChild(counter);

  const exitBtn = document.createElement('button');
  exitBtn.className = 'spatial-review-exit';
  exitBtn.textContent = 'End';
  exitBtn.addEventListener('click', endSession);
  overlay.appendChild(exitBtn);

  const cardHost = document.createElement('div');
  cardHost.className = 'spatial-review-card-host';
  overlay.appendChild(cardHost);

  function panToCard(card) {
    const node = opts.cardNodes?.find(n => n.id === card.id);
    if (node && opts.targetCamera) {
      opts.targetCamera.x = node.x;
      opts.targetCamera.y = node.y;
      opts.targetCamera.zoom = Math.max(opts.targetCamera.zoom, 1.4);
    }
  }

  function showCurrent() {
    if (state.index >= state.queue.length) {
      renderSummary();
      return;
    }
    const card = state.queue[state.index];
    state.isRevealed = false;
    panToCard(card);
    counter.textContent = `${state.index + 1} / ${state.queue.length}`;

    const notDueBadge = card._notDue
      ? `<div class="spatial-not-due">Not due yet</div>` : '';

    cardHost.innerHTML = `
      <div class="spatial-review-card">
        ${notDueBadge}
        <div class="spatial-review-front">${escapeHtml(card.front || '')}</div>
        <div class="spatial-review-back is-hidden" id="spBack">${escapeHtml(card.back || '')}</div>
        <div class="spatial-review-actions" id="spActions">
          <button class="spatial-flip-btn" id="spFlip">Show answer</button>
        </div>
      </div>
    `;

    cardHost.querySelector('#spFlip')?.addEventListener('click', reveal);
  }

  function reveal() {
    state.isRevealed = true;
    const back = cardHost.querySelector('#spBack');
    if (back) back.classList.remove('is-hidden');
    const card = state.queue[state.index];
    const intervals = previewIntervals(card);
    const actions = cardHost.querySelector('#spActions');
    if (!actions) return;
    actions.innerHTML = `
      <div class="spatial-grade-bar">
        <button data-g="again">Again<br><small>${fmt(intervals.again)}</small></button>
        <button data-g="hard">Hard<br><small>${fmt(intervals.hard)}</small></button>
        <button data-g="good">Good<br><small>${fmt(intervals.good)}</small></button>
        <button data-g="easy">Easy<br><small>${fmt(intervals.easy)}</small></button>
      </div>
    `;
    actions.querySelectorAll('button[data-g]').forEach(btn => {
      btn.addEventListener('click', () => handleGrade(btn.dataset.g));
    });
  }

  async function handleGrade(grade) {
    const card = state.queue[state.index];
    if (!card._notDue) {
      const GRADE_TO_RATING = {
        again: Grade.AGAIN,
        hard: Grade.HARD,
        good: Grade.GOOD,
        easy: Grade.EASY
      };
      const rating = GRADE_TO_RATING[grade];
      if (rating == null) {
        console.error('Unknown grade', grade);
        state.index++;
        showCurrent();
        return;
      }
      // gradeCard returns { fsrsUpdate, reviewLogEntry, leech }
      const result = gradeCard(card, rating);
      const fsrsUpdate = result.fsrsUpdate;
      await updateCardAfterReview(card.id, fsrsUpdate, {
        grade,
        reviewedAt: result.reviewLogEntry?.reviewedAt ?? Date.now(),
        elapsedDays: result.reviewLogEntry?.elapsedDays ?? null,
        teachingNote: null
      });
      Object.assign(card, fsrsUpdate);
      state.results[grade]++;
      opts.onGrade?.(card.id, grade);
    }
    state.index++;
    showCurrent();
  }

  function renderSummary() {
    const total = state.results.again + state.results.hard + state.results.good + state.results.easy;
    const accuracy = total > 0
      ? Math.round(((state.results.good + state.results.easy) / total) * 100) : 0;
    cardHost.innerHTML = `
      <div class="spatial-review-card spatial-summary">
        <div class="spatial-summary-score">${accuracy}%</div>
        <div class="spatial-summary-label">Session accuracy</div>
        <div class="spatial-summary-stats">
          <span>${total} cards</span>
          <span>${state.results.again} again</span>
          <span>${state.results.good + state.results.easy} good+</span>
        </div>
        <button class="btn-primary" id="spDone">Back to map</button>
      </div>
    `;
    cardHost.querySelector('#spDone')?.addEventListener('click', endSession);
  }

  function endSession() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    opts.onExit?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') { endSession(); return; }
    if (!state.isRevealed) {
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); reveal(); }
      return;
    }
    if (e.key === '1') handleGrade('again');
    else if (e.key === '2') handleGrade('hard');
    else if (e.key === '3') handleGrade('good');
    else if (e.key === '4') handleGrade('easy');
  }
  document.addEventListener('keydown', onKey);

  showCurrent();
}

function fmt(days) {
  if (days < 1 / 1440) return '<1m';
  if (days < 1 / 24) return `${Math.round(days * 1440)}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
