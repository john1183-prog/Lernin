/* Lernin — Study Engine
   Active recall loop with flip animation, hints, keyboard, swipe, teach-it */

import {
  getCardsDueTodayOrEarlier, getCardsDueForDeck, getCard, updateCardAfterReview,
  getReviewLogForCard, getDeck, removeLastReviewLogForCard,
  getRelationshipsFrom, getSetting
} from './db.js';
import { gradeCard, previewIntervals, Grade } from './scheduler.js';
import {
  initSoundSetting, playFlip, playAgain, playHard, playGood, playEasy, playSessionComplete
} from './sound.js';
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
  hintVisible: false,
  touchStart: null,
  keyboardHandler: null,
  undoStack: []
};

const GRADE_MAP = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };

/** Map UI grade strings to ts-fsrs Rating numbers. */
const GRADE_TO_RATING = {
  again: Grade.AGAIN,
  hard: Grade.HARD,
  good: Grade.GOOD,
  easy: Grade.EASY
};

function toRating(grade) {
  const r = GRADE_TO_RATING[grade];
  if (r == null) throw new Error(`Unknown grade: ${grade}`);
  return r;
}

/* ---------- Session Start ---------- */
export async function startStudySession(container, opts = {}) {
  await initSoundSetting();

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
    hintVisible: false,
    touchStart: null,
    keyboardHandler: null,
    undoStack: [],
    onExit: opts.onExit || null
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
      if (typeof session.onExit === 'function') session.onExit();
      else import('./app.js').then(m => m.renderDeckList());
    });
    return teardownStudySession;
  }

  // Interleave new and review
  session.queue = interleaveQueue(cards);

  // Smart ordering: soft-reorder so prerequisites (dependsOn) come
  // before their dependents when both are already in today's queue.
  // Never blocks, never injects cards from outside the queue — see
  // UPCOMING_FEATURES.md for the full spec and reasoning.
  try {
    const smartOrderingEnabled = await getSetting('smartOrderingEnabled');
    if (smartOrderingEnabled !== false) {
      session.queue = await applyPrerequisiteOrdering(session.queue);
    }
  } catch (err) {
    // Non-fatal — study with the plain interleaved order if this fails.
  }

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
  return teardownStudySession;
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

/**
 * Soft prerequisite-first reordering. For each card in the queue, pulls
 * its `dependsOn` prerequisites earlier if they're also in the queue
 * but currently positioned later — so a prerequisite gets reviewed (or
 * introduced) right before its dependent in the same session.
 *
 * Deliberately does NOT: exclude/block anything (a due review always
 * still appears — this only changes order), or pull in cards that
 * aren't already in the queue (a prerequisite in another deck, or one
 * that isn't due today, is simply left alone — this is what makes
 * cross-deck dependsOn safe without extra cross-deck logic). Suspended
 * prerequisites are treated as satisfied (skipped), since a leech
 * elsewhere shouldn't reorder an unrelated card.
 */
async function applyPrerequisiteOrdering(queue) {
  if (queue.length < 2) return queue;

  const idSet = new Set(queue.map(c => c.id));
  const prereqMap = new Map();

  for (const card of queue) {
    try {
      const rels = await getRelationshipsFrom(card.id);
      const prereqs = rels
        .filter(r => r.type === 'dependsOn' && r.cardId !== card.id && idSet.has(r.cardId))
        .map(r => r.cardId);
      if (prereqs.length) prereqMap.set(card.id, prereqs);
    } catch (err) {
      // Non-fatal — skip reordering for this one card if lookup fails.
    }
  }

  if (prereqMap.size === 0) return queue; // common case — nothing to do

  const result = [...queue];
  const maxPasses = result.length * 3; // safety valve against cycles
  let passes = 0;
  let moved = true;

  while (moved && passes < maxPasses) {
    moved = false;
    passes++;
    for (let i = 0; i < result.length; i++) {
      const prereqs = prereqMap.get(result[i].id);
      if (!prereqs) continue;
      for (const prereqId of prereqs) {
        const pIdx = result.findIndex(c => c.id === prereqId);
        if (pIdx > i && !result[pIdx].suspended) {
          const [p] = result.splice(pIdx, 1);
          result.splice(i, 0, p);
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
  }

  return result;
}

/* ---------- UI Rendering ---------- */
function renderStudyUI(container) {
  container.innerHTML = '';
  container.className = 'study-session';

  // Header with counter, undo, help
  const header = document.createElement('div');
  header.className = 'study-header';
  header.id = 'studyHeader';
  container.appendChild(header);

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

function updateHeader() {
  const header = document.getElementById('studyHeader');
  if (!header) return;
  const total = session.queue.length;
  const current = Math.min(session.index + 1, total);
  const canUndo = session.undoStack.length > 0;

  header.innerHTML = `
    <div class="study-header-counter">Card ${current} of ${total}</div>
    <div class="study-header-actions">
      <button class="study-undo-btn" id="studyUndoBtn" aria-label="Undo last grade" ${canUndo ? '' : 'disabled'}>↩</button>
      <button class="study-help-btn" id="studyHelpBtn" aria-label="Keyboard shortcuts">?</button>
    </div>
  `;

  const undoBtn = header.querySelector('#studyUndoBtn');
  if (undoBtn && canUndo) {
    undoBtn.addEventListener('click', undoLastGrade);
  }

  const helpBtn = header.querySelector('#studyHelpBtn');
  if (helpBtn) {
    helpBtn.addEventListener('click', showShortcutsOverlay);
  }
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
  session.hintVisible = false;

  // Fetch deck title if not cached
  if (!card._deckTitle && card.deckId) {
    const deck = await getDeck(card.deckId);
    card._deckTitle = deck?.title || 'Deck';
  }

  updateHeader();
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

  // Click to flip (before reveal)
  wrap.addEventListener('click', (e) => {
    if (!session.isRevealed && !session.hintVisible) {
      revealCard();
    }
  });

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
      html += renderFormulaExtra('Variables', card.variables.map(v => `${v.name}: ${v.description}`).join(' · '));
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

/* ---------- Hint ---------- */
function getHintText(card) {
  if (card.hint) return card.hint;
  if (card.type === 'formula' || card.formula) {
    const parts = [];
    if (card.variables && card.variables.length) {
      parts.push('Variables: ' + card.variables.map(v => `${v.symbol || v.name}: ${v.meaning || v.description}`).join(', '));
    }
    if (card.assumptions) parts.push('Assumptions: ' + card.assumptions);
    return parts.join('\n') || null;
  }
  return null;
}

function toggleHint() {
  session.hintVisible = !session.hintVisible;
  const front = document.querySelector('.study-card-front');
  if (!front) return;

  let hintArea = front.querySelector('.study-hint-area');
  if (session.hintVisible) {
    if (!hintArea) {
      hintArea = document.createElement('div');
      hintArea.className = 'study-hint-area';
      const hintText = getHintText(session.currentCard);
      if (hintText) {
        hintArea.innerHTML = `
          <div class="study-hint-label">Hint</div>
          <div class="study-hint-text">${escapeHtml(hintText).replace(/\n/g, '<br>')}</div>
        `;
      } else {
        hintArea.innerHTML = `
          <div class="study-hint-label">Hint</div>
          <div class="study-hint-empty">No hint for this card</div>
        `;
      }
      front.appendChild(hintArea);
    }
  } else {
    if (hintArea) hintArea.remove();
  }
}

/* ---------- Controls ---------- */
function renderControls() {
  const controls = document.getElementById('studyControls');
  if (!controls) return;

  if (!session.isRevealed) {
    controls.innerHTML = `
      <div class="study-action-bar">
        <button class="study-action-btn is-explain" id="explainBtn" aria-label="Explain (show hint)">
          <span>💡</span> Explain
        </button>
        <button class="study-action-btn is-flip" id="revealBtn" aria-label="Flip card">
          <span>👁</span> Flip
        </button>
      </div>
      <div class="study-gesture-hints">← Swipe left = Explain &nbsp;&nbsp; → Swipe right = Flip</div>
    `;
    controls.querySelector('#explainBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHint();
    });
    controls.querySelector('#revealBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      revealCard();
    });
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
      <div class="study-gesture-hints">← Again &nbsp;&nbsp; ↑ Hard &nbsp;&nbsp; ↓ Good &nbsp;&nbsp; → Easy</div>
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
  playFlip();

  const live = document.getElementById('studyLive');
  if (live) live.textContent = 'Answer revealed';

  renderControls();
}

/* ---------- Grading ---------- */
async function handleGrade(grade) {
  if (!session.currentCard) return;

  if (grade === 'again') playAgain();
  else if (grade === 'hard') playHard();
  else if (grade === 'good') playGood();
  else if (grade === 'easy') playEasy();

  const card = session.currentCard;

  // Save for undo (pre-grade snapshot)
  session.undoStack.push({
    card: JSON.parse(JSON.stringify(card)), // deep copy
    grade,
    index: session.index
  });

  // gradeCard returns { fsrsUpdate, reviewLogEntry, leech } — never spread the
  // whole object onto the card record.
  const result = gradeCard(card, toRating(grade));
  const fsrsUpdate = result.fsrsUpdate;
  const reviewLogEntry = {
    grade,
    reviewedAt: result.reviewLogEntry?.reviewedAt ?? Date.now(),
    elapsedDays: result.reviewLogEntry?.elapsedDays ?? null,
    teachingNote: null
  };

  // Keep the in-memory queue in sync so later undos / previews see new FSRS fields
  Object.assign(card, fsrsUpdate);
  if (session.queue[session.index]) Object.assign(session.queue[session.index], fsrsUpdate);

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

async function undoLastGrade() {
  if (session.undoStack.length === 0) return;

  const lastAction = session.undoStack.pop();
  const card = lastAction.card;

  try {
    // Restore card to previous state
    await updateCardAfterReview(card.id, {
      state: card.state,
      difficulty: card.difficulty,
      stability: card.stability,
      reps: card.reps,
      lapses: card.lapses,
      last_review: card.last_review,
      due_date: card.due_date,
      suspended: card.suspended
    }, null);

    // Remove the last review log entry
    await removeLastReviewLogForCard(card.id);

    // Decrement result count
    session.results[lastAction.grade]--;

    // Restore in-memory queue entry to pre-grade snapshot
    session.index = lastAction.index;
    if (session.queue[session.index]) {
      session.queue[session.index] = JSON.parse(JSON.stringify(lastAction.card));
    }
    session.isRevealed = false;
    session.hintVisible = false;

    showToast('Undo last grade');
    showCard();
  } catch (err) {
    console.error('Undo failed:', err);
    showToast('Undo failed');
  }
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
  session.touchStart = {
    x: e.touches[0].clientX,
    y: e.touches[0].clientY
  };
}

function onTouchMove(e) {
  if (!session.touchStart) return;
  const dx = e.touches[0].clientX - session.touchStart.x;
  const dy = e.touches[0].clientY - session.touchStart.y;
  const wrap = document.getElementById('cardWrap');
  if (!wrap) return;

  if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
    const inner = document.getElementById('cardInner');
    if (inner) {
      const baseTransform = session.isRevealed ? 'rotateY(180deg)' : '';
      inner.style.transition = 'none';
      inner.style.transform = `${baseTransform} translateX(${dx * 0.3}px) translateY(${dy * 0.3}px)`;
    }
  }
}

function onTouchEnd(e) {
  if (!session.touchStart) return;
  const dx = e.changedTouches[0].clientX - session.touchStart.x;
  const dy = e.changedTouches[0].clientY - session.touchStart.y;
  session.touchStart = null;

  const inner = document.getElementById('cardInner');
  if (inner) {
    inner.style.transition = '';
    inner.style.transform = session.isRevealed ? 'rotateY(180deg)' : '';
  }

  const threshold = 50;

  if (!session.isRevealed) {
    // Before flip: left = Explain, right = Flip
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx < -threshold) toggleHint();
      else if (dx > threshold) revealCard();
    }
    return;
  }

  // After flip
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx < -threshold) handleGrade('again');
    else if (dx > threshold) handleGrade('easy');
  } else {
    if (dy < -threshold) handleGrade('hard');
    else if (dy > threshold) handleGrade('good');
  }
}

/* ---------- Keyboard ---------- */
function attachKeyboard() {
  session.keyboardHandler = (e) => {
    if (!session.isActive) return;

    // ? key shows shortcuts
    if (e.key === '?' || e.key === 'Slash') {
      e.preventDefault();
      showShortcutsOverlay();
      return;
    }

    // Escape ends session
    if (e.code === 'Escape') {
      e.preventDefault();
      endStudySession();
      return;
    }

    // U = Undo
    if (e.code === 'KeyU' || e.key === 'u' || e.key === 'U') {
      e.preventDefault();
      undoLastGrade();
      return;
    }

    if (!session.isRevealed) {
      // Space / Enter / Right arrow = Flip
      if (e.code === 'Space' || e.code === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        revealCard();
        return;
      }
      // Left arrow = Explain (toggle hint)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        toggleHint();
        return;
      }
      return;
    }

    // After flip: grading
    if (e.code === 'Digit1' || e.key === '1') { e.preventDefault(); handleGrade('again'); }
    else if (e.code === 'Digit2' || e.key === '2') { e.preventDefault(); handleGrade('hard'); }
    else if (e.code === 'Digit3' || e.key === '3') { e.preventDefault(); handleGrade('good'); }
    else if (e.code === 'Digit4' || e.key === '4') { e.preventDefault(); handleGrade('easy'); }
    // Left arrow = Again (after flip)
    else if (e.key === 'ArrowLeft') { e.preventDefault(); handleGrade('again'); }
  };
  document.addEventListener('keydown', session.keyboardHandler);
}

function detachKeyboard() {
  if (session.keyboardHandler) {
    document.removeEventListener('keydown', session.keyboardHandler);
    session.keyboardHandler = null;
  }
}

/* ---------- Shortcuts Overlay ---------- */
function showShortcutsOverlay() {
  // Remove existing overlay if any
  const existing = document.querySelector('.study-shortcuts-overlay');
  if (existing) {
    existing.remove();
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'study-shortcuts-overlay';
  overlay.innerHTML = `
    <div class="study-shortcuts-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="study-shortcuts-title">⌨️ Keyboard Shortcuts</div>
      <div class="study-shortcuts-list">
        <div class="study-shortcut-row"><span>Space / Enter / →</span><span class="study-shortcut-key">Flip card</span></div>
        <div class="study-shortcut-row"><span>← (before flip)</span><span class="study-shortcut-key">Explain</span></div>
        <div class="study-shortcut-row"><span>← (after flip)</span><span class="study-shortcut-key">Again</span></div>
        <div class="study-shortcut-row"><span>1</span><span class="study-shortcut-key">Again</span></div>
        <div class="study-shortcut-row"><span>2</span><span class="study-shortcut-key">Hard</span></div>
        <div class="study-shortcut-row"><span>3</span><span class="study-shortcut-key">Good</span></div>
        <div class="study-shortcut-row"><span>4</span><span class="study-shortcut-key">Easy</span></div>
        <div class="study-shortcut-row"><span>U</span><span class="study-shortcut-key">Undo last grade</span></div>
        <div class="study-shortcut-row"><span>?</span><span class="study-shortcut-key">Show / hide this</span></div>
        <div class="study-shortcut-row"><span>Esc</span><span class="study-shortcut-key">End session</span></div>
      </div>
      <button class="study-shortcuts-close" id="shortcutsClose">Got it</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeOverlay = () => overlay.remove();
  overlay.querySelector('#shortcutsClose').addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOverlay();
  });
}

/* ---------- Session Summary ---------- */
function renderSessionSummary() {
  session.isActive = false;
  detachKeyboard();
  playSessionComplete();

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
    if (typeof session.onExit === 'function') session.onExit();
    else import('./app.js').then(m => m.renderDeckList());
  });
}

/* ---------- Exit ---------- */
function leaveSession() {
  session.isActive = false;
  detachKeyboard();
  if (typeof session.onExit === 'function') {
    session.onExit();
  } else {
    import('./app.js').then(m => m.renderDeckList());
  }
}

/**
 * Silent teardown for the router — detaches global listeners without navigating.
 * Safe to call multiple times.
 */
export function teardownStudySession() {
  session.isActive = false;
  detachKeyboard();
}

export function endStudySession() {
  leaveSession();
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
