/* Lernin — App Orchestrator
   Home screen, bottom sheet, theme, view routing */

import {
  getDB, getDecks, getCardsDueTodayOrEarlier, getReviewStats,
  getTheme, saveTheme, getConceptPositionOverrides,
  addDeck, deleteDeck, renameDeck, saveCards, getCardsByDeck,
  getCardsDueForDeck, getAllCards, getReviewLogForCard,
  getSetting, saveSetting, exportDecks, importDecks,
  getDocuments, getDocument, deleteDocument, saveDocument,
  getRelationshipsFrom, getRelationshipsTo, addRelationship,
  removeRelationship, getCard, getDeck
} from './db.js';
import { startStudySession } from './study.js';
import { initCanvasView } from './canvas.js';
import { initConceptGraph } from './concept-graph.js';
import { generateCards, queueOfflineGeneration, processOfflineQueue } from './api.js';
import { extractTextFromPDF } from './pdf-extract.js';
import { renderManualJSONImport } from './manual-json-import.js';

const root = document.getElementById('root');
let longPressTimer = null;
let isLongPress = false;
const LONG_PRESS_MS = 500;

/* ---------- Theme ---------- */
async function initTheme() {
  const saved = await getTheme();
  applyTheme(saved);
  if (saved === 'system') {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => applyTheme('system'));
  }
}

function applyTheme(theme) {
  let effective = theme;
  if (theme === 'system') {
    effective = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const order = { system: 'light', light: 'dark', dark: 'system' };
  const next = order[current] || 'system';
  applyTheme(next);
  saveTheme(next);
}

/* ---------- KaTeX Helper ---------- */
export function renderMath(rootEl) {
  if (window.renderMathInElement) {
    renderMathInElement(rootEl, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false
    });
  }
}

/* ---------- Toast ---------- */
export function showToast(message, duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-leaving');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

/* ---------- Home Screen ---------- */
export async function renderDeckList() {
  root.innerHTML = '';
  root.style.padding = '0';

  // Header
  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="app-header-title">Lernin</div>
    <div class="app-header-actions">
      <button class="icon-btn" id="themeToggle" aria-label="Toggle theme">🌓</button>
      <button class="icon-btn" id="settingsBtn" aria-label="Settings">⚙️</button>
    </div>
  `;
  root.appendChild(header);

  header.querySelector('#themeToggle').addEventListener('click', cycleTheme);
  header.querySelector('#settingsBtn').addEventListener('click', () => renderSettings());

  // Fetch data
  const [decks, dueCards, stats] = await Promise.all([
    getDecks(),
    getCardsDueTodayOrEarlier(),
    getReviewStats()
  ]);

  const dueToday = dueCards.length;
  const streak = stats.currentStreak || 0;

  // Hero CTA
  if (dueToday > 0) {
    const hero = document.createElement('div');
    hero.className = 'hero-cta';
    hero.innerHTML = `
      <div class="hero-cta-title">${dueToday} card${dueToday !== 1 ? 's' : ''} due today</div>
      <div class="hero-cta-sub">${streak > 0 ? `🔥 ${streak}-day streak` : 'Start building your streak'}</div>
      <button class="hero-cta-btn" id="heroStudy">Study Now</button>
    `;
    root.appendChild(hero);
    hero.querySelector('#heroStudy').addEventListener('click', () => {
      enterStudy(null); // all due cards
    });
  }

  // Stats strip (only if there's something to show)
  if (dueToday > 0 || streak > 0 || stats.totalReviews > 0) {
    const strip = document.createElement('div');
    strip.className = 'stats-strip';
    strip.innerHTML = `
      <div class="stat-item">
        <span>🔥</span>
        <span class="stat-value">${streak}</span>
        <span>day streak</span>
      </div>
      <div class="stat-item">
        <span>📚</span>
        <span class="stat-value">${dueToday}</span>
        <span>due</span>
      </div>
      <a href="#" class="stat-link" id="viewStats">View full statistics →</a>
    `;
    root.appendChild(strip);
    strip.querySelector('#viewStats').addEventListener('click', (e) => {
      e.preventDefault();
      renderStats();
    });
  }

  // Deck list
  const list = document.createElement('div');
  list.className = 'deck-list';

  if (decks.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📚</div>
        <div class="empty-state-title">No decks yet</div>
        <div class="empty-state-text">Create a deck or import a PDF to get started with active recall.</div>
      </div>
    `;
  } else {
    for (const deck of decks) {
      const tile = await buildDeckTile(deck);
      list.appendChild(tile);
    }
  }
  root.appendChild(list);

  // New deck button
  const newBtn = document.createElement('button');
  newBtn.className = 'btn-secondary';
  newBtn.style.cssText = 'margin: var(--space-md); width: calc(100% - var(--space-md)*2);';
  newBtn.innerHTML = '+ New deck';
  newBtn.addEventListener('click', () => renderNewDeckForm());
  root.appendChild(newBtn);

  // Map view button (secondary)
  const mapBtn = document.createElement('button');
  mapBtn.className = 'btn-secondary';
  mapBtn.style.cssText = 'margin: 0 var(--space-md) var(--space-md); width: calc(100% - var(--space-md)*2);';
  mapBtn.innerHTML = '🗺️ Map view';
  mapBtn.addEventListener('click', () => enterMap());
  root.appendChild(mapBtn);

  renderMath(root);
}

async function buildDeckTile(deck) {
  const cards = await getCardsByDeck(deck.id);
  const due = cards.filter(c => !c.suspended && c.due_date <= Date.now()).length;
  const total = cards.length;
  const mastered = cards.filter(c => c.state === 'review' && (c.stability || 0) >= 30).length;
  const masteryPct = total > 0 ? Math.round((mastered / total) * 100) : 0;

  const tile = document.createElement('div');
  tile.className = 'deck-tile';
  if (masteryPct >= 80) tile.classList.add('is-mastered');
  else if (masteryPct >= 30) tile.classList.add('is-progress');

  tile.innerHTML = `
    <div class="deck-tile-header">
      <div class="deck-tile-title">${escapeHtml(deck.title)}</div>
      ${due > 0 ? `<div class="deck-tile-badge">${due} due</div>` : ''}
    </div>
    <div class="deck-tile-bar">
      <div class="deck-tile-bar-fill" style="width: ${masteryPct}%"></div>
    </div>
  `;

  // Tap to study
  tile.addEventListener('click', () => {
    if (!isLongPress) enterStudy(deck.id);
  });

  // Long press for actions
  tile.addEventListener('pointerdown', (e) => {
    isLongPress = false;
    longPressTimer = setTimeout(() => {
      isLongPress = true;
      openBottomSheet(deck);
    }, LONG_PRESS_MS);
  });
  tile.addEventListener('pointerup', () => clearTimeout(longPressTimer));
  tile.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
  tile.addEventListener('contextmenu', (e) => e.preventDefault());

  return tile;
}

/* ---------- Bottom Sheet ---------- */
function openBottomSheet(deck) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  document.body.appendChild(backdrop);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', `${escapeHtml(deck.title)} actions`);

  const actions = [
    { label: 'Study', icon: '▶️', primary: true, action: () => enterStudy(deck.id) },
    { label: 'Import PDF', icon: '📄', action: () => renderPDFImport(deck.id) },
    { label: '+ Card', icon: '➕', action: () => renderNewCardForm(deck.id) },
    { label: 'Cards', icon: '🃏', action: () => renderCardBrowser(deck.id) },
    { label: 'Concept Map', icon: '🕸️', action: () => enterConceptGraph(deck.id) },
    { label: 'Documents', icon: '📑', action: () => renderDocuments(deck.id) },
    { label: 'Edit', icon: '✏️', action: () => renderDeckEdit(deck) },
    { label: 'Export', icon: '⬆️', action: () => exportDeck(deck.id) },
  ];

  let html = '<div class="sheet-handle"></div>';
  actions.forEach((a, i) => {
    if (i === 4) html += '<div class="sheet-divider"></div>';
    html += `
      <button class="sheet-action ${a.primary ? 'is-primary' : ''}" data-action="${i}">
        <span class="sheet-action-icon">${a.icon}</span>
        <span>${escapeHtml(a.label)}</span>
      </button>
    `;
  });
  sheet.innerHTML = html;
  document.body.appendChild(sheet);

  // Focus trap
  const focusable = sheet.querySelectorAll('button');
  if (focusable.length) focusable[0].focus();

  function closeSheet() {
    sheet.style.animation = 'slideDown 0.25s ease forwards';
    backdrop.style.animation = 'fadeIn 0.2s ease reverse forwards';
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
    }, 250);
  }

  backdrop.addEventListener('click', closeSheet);
  sheet.querySelector('.sheet-handle').addEventListener('click', closeSheet);

  sheet.querySelectorAll('.sheet-action').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      closeSheet();
      actions[i].action();
    });
  });

  // Swipe down to dismiss
  let startY = 0;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; });
  sheet.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientY - startY > 80) closeSheet();
  });
}

/* ---------- Study Entry ---------- */
function enterStudy(deckId) {
  root.innerHTML = '';
  startStudySession(root, { deckId });
}

function enterConceptGraph(deckId) {
  root.innerHTML = '';
  initConceptGraph(root, deckId, {
    onExit: () => renderDeckList(),
    onStudyCard: (cardId) => {
      root.innerHTML = '';
      startStudySession(root, { deckId, startCardId: cardId });
    }
  });
}

function enterMap() {
  root.innerHTML = '';
  initCanvasView(root, { onExit: () => renderDeckList() });
}

/* ---------- Placeholder views (preserve existing functionality) ---------- */
function renderSettings() {
  // TODO: integrate existing settings view with new tokens
  showToast('Settings — integrate existing renderSettings with new CSS');
}

function renderStats() {
  // TODO: integrate existing stats view with new tokens
  showToast('Statistics — integrate existing renderStats with new CSS');
}

function renderNewDeckForm() {
  // TODO: integrate existing new deck form
  showToast('New deck form — integrate existing');
}

function renderPDFImport(deckId) {
  root.innerHTML = '';
  renderManualJSONImport(root, deckId, () => renderDeckList());
}

function renderNewCardForm(deckId) {
  // TODO: integrate existing new card form
  showToast('New card form — integrate existing');
}

function renderCardBrowser(deckId) {
  // TODO: integrate existing card browser
  showToast('Card browser — integrate existing');
}

function renderDocuments(deckId) {
  // TODO: integrate existing documents view
  showToast('Documents — integrate existing');
}

function renderDeckEdit(deck) {
  // TODO: integrate existing deck edit
  showToast('Deck edit — integrate existing');
}

async function exportDeck(deckId) {
  // TODO: integrate existing export
  showToast('Export — integrate existing');
}

/* ---------- Utilities ---------- */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- Init ---------- */
initTheme();
renderDeckList();
