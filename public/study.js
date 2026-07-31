/* Lernin — Study Engine
   Active recall loop with flip animation, hints, keyboard, swipe, teach-it */

import {
  getCardsDueTodayOrEarlier, getCardsDueForDeck, getCard, updateCardAfterReview,
  getReviewLogForCard, getDeck
} from './db.js';
import { gradeCard, previewIntervals } from './scheduler.js';
import { renderMath, showToast } from './app.js';

let session = {
  queue: [],
  index: 0,
  deckId: null,
  startCardId: null,
  results: { again: 0, hard: 0, good: 0, easy: 0 },
  teachItQueue: [],
  isActive: false,
  currentCard: null,
  isRevealed: false,
  touchStart: null,
  keyboardHandler: null
};

const GRADE_MAP = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };

/* ---------- Session Start ---------- */
export async function startStudySession(container, opts = {}) {
  session = {
    queue: [],
    index: 0,
    deckId: opts.deckId || null,
    startCardId: opts.startCardId || null,
    results: { again: 0, hard: 0, good: 0, easy: 0 },
    teachItQueue: [],
    isActive: true,
    currentCard: null,
    isRevealed: false,
    touchStart: null,
    keyboardHandler: null
  };

  let cards;
  if (session.deckId) {
    cards = await getCardsDueForDeck(session.deckId);
  } else {
    cards = await getCardsDueTodayOrEarlier();
  }

  // Filter out suspended
  cards = cards.filter(c => !c.suspended);

  if (cards.length === 0) {
    container.innerHTML = `
      <div class="study-session" style="justify-content:center;align-items:center;">
        <div class="empty-state">
          <div class="empty-state-icon">🎉</div>
          <div class="empty-state-title">All caught up!</div>
          <div class="empty-state-text">No cards are due right now. Great job keeping up.</div>
          <button class="btn-primary" style="margin-top:var(--space-lg);" id="backHome">Back to decks</button>
        </div>
      </div>
    `;
    container.querySelector('#backHome').addEventListener('click', () => {
      import('./app.js').then(m => m.renderDeckList());
    });
    return;
  }

  // Interleave new and review
  session.queue = interleaveQueue(cards);

  // Rotate to startCardId if specified
  if (session.startCardId) {
    const idx = session.queue.findIndex(c => c.id === session.startCardId);
    if (idx > 0) {
      const [card] = session.queue.splice(idx, 1);
      session.queue.unshift(card);
    }
  }

  renderStudyUI(container);
  showCard();
  attachKeyboard();
}

function interleaveQueue(cards) {
  const news = cards.filter(c => c.state === 'new').slice(0, 20);
  const reviews = cards.filter(c => c.state !== 'new');
  const result = [];
  let n = 0, r = 0;
  while (n < news.length || r < reviews.length) {
    if (n < news.length) result.push(news[n++]);
    if (r < reviews.length) result.push(reviews[r++]);
  }
  return result;
}

/* ---------- UI Rendering ---------- */
function renderStudyUI(container) {
  container.innerHTML = '';
  container.className = 'study-session';

  // Context bar
  const contextBar = document.createElement('div');
  contextBar.className = 'study-context-bar';
  contextBar.id = 'studyContext';
  container.appendChild(contextBar);

  // Card area
  const cardArea = document.createElement('div');
  cardArea.className = 'study-card-area';
  cardArea.id = 'cardArea';
  container.appendChild(cardArea);

  // Controls
  const controls = document.createElement('div');
  controls.className = 'study-controls';
  controls.id = 'studyControls';
  container.appendChild(controls);

  // Live region for screen readers
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.id = 'studyLive';
  container.appendChild(live);
}

function updateContextBar(card) {
  const bar = document.getElementById('studyContext');
  if (!bar || !card) return;
  const status = getCardStatus(card);
  bar.innerHTML = `
    <span class="study-context-deck">${escapeHtml(card._deckTitle || 'Deck')}</span>
    <span class="study-context-type">${card.type || 'basic'}</span>
    <span class="study-context-status">${status}</span>
  `;
}

function getCardStatus(card) {
  if (card.state === 'new') return 'New';
  const dueIn = Math.round((card.due_date - Date.now()) / 86400000);
  if (dueIn < 0) return `Overdue ${Math.abs(dueIn)}d`;
  if (dueIn === 0) return 'Due today';
  return `Due in ${dueIn}d`;
}

/* ---------- Card Display ---------- */
async function showCard() {
  if (session.index >= session.queue.length) {
    renderSessionSummary();
    return;
  }

  const card = session.queue[session.index];
  session.currentCard = card;
  session.isRevealed = false;

  // Fetch deck title if not cached
  if (!card._deckTitle && card.deckId) {
    const deck = await getDeck(card.deckId);
    card._deckTitle = deck?.title || 'Deck';
  }

  updateContextBar(card);

  const cardArea = document.getElementById('cardArea');
  cardArea.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'study-card-wrap is-entering';
  wrap.id = 'cardWrap';

  const inner = document.createElement('div');
  inner.className = 'study-card-inner';
  inner.id = 'cardInner';

  // Front
  const front = document.createElement('div');
  front.className = 'study-card-front';
  front.innerHTML = `<div class="study-card-content">${renderFront(card)}</div>`;

  // Back (hidden until flip)
  const back = document.createElement('div');
  back.className = 'study-card-back';
  back.innerHTML = `<div class="study-card-content">${renderBack(card)}</div>`;

  inner.appendChild(front);
  inner.appendChild(back);
  wrap.appendChild(inner);
  cardArea.appendChild(wrap);

  renderMath(wrap);

  // Touch handlers for swipe
  wrap.addEventListener('touchstart', onTouchStart, { passive: true });
  wrap.addEventListener('touchmove', onTouchMove, { passive: true });
  wrap.addEventListener('touchend', onTouchEnd, { passive: true });

  // Remove enter animation class after it plays
  requestAnimationFrame(() => {
    wrap.classList.remove('is-entering');
  });

  renderControls();
}

function renderFront(card) {
  let html = escapeHtml(card.front);
  if (card.type === 'cloze') {
    html = html.replace(/\{\{c\d+::([^}]+)\}\}/g, '<span style="color:var(--ink-muted);">[...]</span>');
  }
  if (card.formula) {
    html += `<div style="margin-top:var(--space-lg);">$$${escapeHtml(card.formula)}$$</div>`;
  }
  return html;
}

function renderBack(card) {
  let html = escapeHtml(card.back);

  if (card.type === 'cloze') {
    html = html.replace(/\{\{c\d+::([^}]+)\}\}/g, '<strong style="color:var(--accent);">$1</strong>');
  }

  if (card.type === 'formula' || card.formula) {
    html += `<div style="margin-top:var(--space-lg);">$$${escapeHtml(card.formula)}$$</div>`;
    if (card.variables && card.variables.length) {
      html += `<div class="formula-extras">`;
      html += renderFormulaExtra('Variables', card.variables.map(v => `${v.name}: ${v.description}`).join(' • '));
      if (card.assumptions) html += renderFormulaExtra('Assumptions', card.assumptions);
      if (card.commonMistakes) html += renderFormulaExtra('Common Mistakes', card.commonMistakes);
      if (card.applications) html += renderFormulaExtra('Applications', card.applications);
      html += `</div>`;
    }
  }

  return html;
}

function renderFormulaExtra(label, value) {
  return `
    <div class="formula-extra-block">
      <div class="formula-extra-label">${escapeHtml(label)}</div>
      <div class="formula-extra-value">${escapeHtml(value)}</div>
    </div>
  `;
}

/* ---------- Controls ---------- */
function renderControls() {
  const controls = document.getElementById('studyControls');
  if (!controls) return;

  if (!session.isRevealed) {
    controls.innerHTML = `<button class="study-reveal-btn" id="revealBtn">Show answer</button>`;
    controls.querySelector('#revealBtn').addEventListener('click', revealCard);
  } else {
    const card = session.currentCard;
    const intervals = previewIntervals(card);
    controls.innerHTML = `
      <div class="study-grade-bar">
        <button class="study-grade-btn" data-grade="again" aria-label="Again, ${formatInterval(intervals.again)}">
          <div>Again</div>
          <div class="study-grade-hint">${formatInterval(intervals.again)}</div>
        </button>
        <button class="study-grade-btn" data-grade="hard" aria-label="Hard, ${formatInterval(intervals.hard)}">
          <div>Hard</div>
          <div class="study-grade-hint">${formatInterval(intervals.hard)}</div>
        </button>
        <button class="study-grade-btn" data-grade="good" aria-label="Good, ${formatInterval(intervals.good)}">
          <div>Good</div>
          <div class="study-grade-hint">${formatInterval(intervals.good)}</div>
        </button>
        <button class="study-grade-btn" data-grade="easy" aria-label="Easy, ${formatInterval(intervals.easy)}">
          <div>Easy</div>
          <div class="study-grade-hint">${formatInterval(intervals.easy)}</div>
        </button>
      </div>
    `;
    controls.querySelectorAll('.study-grade-btn').forEach(btn => {
      btn.addEventListener('click', () => handleGrade(btn.dataset.grade));
    });
  }
}

function revealCard() {
  session.isRevealed = true;
  const inner = document.getElementById('cardInner');
  if (inner) inner.classList.add('is-flipped');

  const live = document.getElementById('studyLive');
  if (live) live.textContent = 'Answer revealed';

  renderControls();
}

/* ---------- Grading ---------- */
async function handleGrade(grade) {
  if (!session.currentCard) return;

  const card = session.currentCard;
  const fsrsUpdate = gradeCard(card, grade);

  const reviewLogEntry = {
    grade,
    reviewedAt: Date.now(),
    elapsedDays: fsrsUpdate.elapsed_days ?? null,
    teachingNote: null
  };

  session.results[grade]++;

  // Teach It for Good/Easy
  if (grade === 'good' || grade === 'easy') {
    showTeachIt(card, fsrsUpdate, reviewLogEntry);
    return;
  }

  await persistGrade(card, fsrsUpdate, reviewLogEntry);
  animateCardExit();
}

function showTeachIt(card, fsrsUpdate, reviewLogEntry) {
  const container = document.querySelector('.study-session');
  const sheet = document.createElement('div');
  sheet.className = 'teach-it-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Explain in your own words');
  sheet.innerHTML = `
    <div class="teach-it-title">Explain it back</div>
    <div class="teach-it-sub">Quick: explain this concept in your own words. This strengthens memory.</div>
    <textarea class="teach-it-textarea" placeholder="Type your explanation here..." aria-label="Your explanation"></textarea>
    <div class="teach-it-actions">
      <button class="teach-it-skip">Skip</button>
      <button class="teach-it-continue">Continue</button>
    </div>
  `;
  container.appendChild(sheet);

  const textarea = sheet.querySelector('textarea');
  textarea.focus();

  sheet.querySelector('.teach-it-skip').addEventListener('click', async () => {
    sheet.remove();
    await persistGrade(card, fsrsUpdate, reviewLogEntry);
    animateCardExit();
  });

  sheet.querySelector('.teach-it-continue').addEventListener('click', async () => {
    reviewLogEntry.teachingNote = textarea.value.trim() || null;
    sheet.remove();
    await persistGrade(card, fsrsUpdate, reviewLogEntry);
    animateCardExit();
  });
}

async function persistGrade(card, fsrsUpdate, reviewLogEntry) {
  await updateCardAfterReview(card.id, fsrsUpdate, reviewLogEntry);
}

function animateCardExit() {
  const wrap = document.getElementById('cardWrap');
  if (!wrap) {
    session.index++;
    showCard();
    return;
  }

  wrap.classList.add('is-exiting');
  setTimeout(() => {
    session.index++;
    showCard();
  }, 150);
}

/* ---------- Swipe Gestures ---------- */
function onTouchStart(e) {
  if (!session.isRevealed) return;
  session.touchStart = {
    x: e.touches[0].clientX,
    y: e.touches[0].clientY
  };
}

function onTouchMove(e) {
  if (!session.isRevealed || !session.touchStart) return;
  const dx = e.touches[0].clientX - session.touchStart.x;
  const dy = e.touches[0].clientY - session.touchStart.y;
  const wrap = document.getElementById('cardWrap');
  if (!wrap) return;

  if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
    const inner = document.getElementById('cardInner');
    if (inner) {
      inner.style.transition = 'none';
      inner.style.transform = `rotateY(180deg) translateX(${dx * 0.3}px) translateY(${dy * 0.3}px)`;
    }
  }
}

function onTouchEnd(e) {
  if (!session.isRevealed || !session.touchStart) return;
  const dx = e.changedTouches[0].clientX - session.touchStart.x;
  const dy = e.changedTouches[0].clientY - session.touchStart.y;
  session.touchStart = null;

  const inner = document.getElementById('cardInner');
  if (inner) {
    inner.style.transition = '';
    inner.style.transform = '';
  }

  const threshold = 50;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx < -threshold) handleGrade('again');
    else if (dx > threshold) handleGrade('good');
  } else {
    if (dy < -threshold) handleGrade('hard');
    else if (dy > threshold) handleGrade('easy');
  }
}

/* ---------- Keyboard ---------- */
function attachKeyboard() {
  session.keyboardHandler = (e) => {
    if (!session.isActive) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!session.isRevealed) revealCard();
      return;
    }

    if (!session.isRevealed) return;

    if (e.code === 'Digit1' || e.key === '1') { e.preventDefault(); handleGrade('again'); }
    else if (e.code === 'Digit2' || e.key === '2') { e.preventDefault(); handleGrade('hard'); }
    else if (e.code === 'Digit3' || e.key === '3') { e.preventDefault(); handleGrade('good'); }
    else if (e.code === 'Digit4' || e.key === '4') { e.preventDefault(); handleGrade('easy'); }
    else if (e.code === 'Escape') { e.preventDefault(); endStudySession(); }
  };
  document.addEventListener('keydown', session.keyboardHandler);
}

function detachKeyboard() {
  if (session.keyboardHandler) {
    document.removeEventListener('keydown', session.keyboardHandler);
    session.keyboardHandler = null;
  }
}

/* ---------- Session Summary ---------- */
function renderSessionSummary() {
  session.isActive = false;
  detachKeyboard();

  const container = document.querySelector('.study-session');
  if (!container) return;

  const total = session.results.again + session.results.hard + session.results.good + session.results.easy;
  const accuracy = total > 0 ? Math.round(((session.results.good + session.results.easy) / total) * 100) : 0;
  const circumference = 2 * Math.PI * 52;
  const offset = circumference - (accuracy / 100) * circumference;

  container.innerHTML = `
    <div class="session-summary">
      <div class="session-summary-ring">
        <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="session-summary-ring-bg" cx="60" cy="60" r="52"/>
          <circle class="session-summary-ring-fg" cx="60" cy="60" r="52"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="session-summary-score">${accuracy}%</div>
      </div>
      <div class="session-summary-label">Session accuracy</div>
      <div class="session-summary-stats">
        <div class="session-summary-stat">
          <div class="session-summary-stat-value">${total}</div>
          <div class="session-summary-stat-label">Cards</div>
        </div>
        <div class="session-summary-stat">
          <div class="session-summary-stat-value">${session.results.again}</div>
          <div class="session-summary-stat-label">Again</div>
        </div>
        <div class="session-summary-stat">
          <div class="session-summary-stat-value">${session.results.good + session.results.easy}</div>
          <div class="session-summary-stat-label">Good+</div>
        </div>
      </div>
      <button class="session-summary-btn" id="backHome">Back to decks</button>
    </div>
  `;

  container.querySelector('#backHome').addEventListener('click', () => {
    import('./app.js').then(m => m.renderDeckList());
  });
}

/* ---------- Exit ---------- */
export function endStudySession() {
  session.isActive = false;
  detachKeyboard();
  import('./app.js').then(m => m.renderDeckList());
}

/* ---------- Utilities ---------- */
function formatInterval(days) {
  if (days < 1 / 1440) return '<1m';
  if (days < 1 / 24) return `${Math.round(days * 1440)}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
