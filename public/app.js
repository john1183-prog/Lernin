// app.js
// General UI orchestration + the flat list/grid deck view (the required
// accessibility fallback, built before canvas.js per the spec's build
// order). This is the ONLY view for now — canvas.js, when it exists, will
// call the same startStudySession() entry point this file uses, and will
// read the view-mode preference this file owns.

import { getAllDecks, saveDeck, getCardsByDeck, getCardsDueTodayOrEarlier, getDeckStateCounts, getReviewStats, getSuspendedCards, resetLeech, deleteCard } from './db.js';
import { startStudySession, endStudySession } from './study.js';
import { generateCards, commitGeneratedCards, retryQueuedGenerations } from './api.js';
import { initCanvasView } from './canvas.js';
import { extractTextFromPdf, isPdfFile } from './pdf-extract.js';

const root = document.getElementById('app');

// View-mode preference: 'list' or 'map'. Defaults to 'list' since canvas.js
// doesn't exist yet. Stored in a plain object, not localStorage — per the
// artifact/browser-storage restriction, and because this is a real app
// context (not an artifact), a small IndexedDB 'settings' entry would be
// the natural v2 home for this once canvas.js ships. For now it's in-memory
// and defaults sane on every load.
const uiState = {
  view: 'list',
  currentDeckId: null
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function initApp() {
  retryQueuedGenerations(); // in case there's a queue left from a prior offline session
  wireGenerationEvents();
  await renderDeckList();
}

// ---------------------------------------------------------------------------
// Deck list / grid (accessibility fallback view)
// ---------------------------------------------------------------------------

async function renderDeckList() {
  if (uiState.view === 'map') {
    await initCanvasView(root, {
      onExit: () => {
        uiState.view = 'list';
        renderDeckList();
      }
    });
    // The canvas view renders its own toggle-back affordance is out of
    // scope here; simplest v1 path is a fixed "List view" button overlaid
    // outside the canvas element itself, appended after init:
    root.appendChild(buildMapOverlayControls());
    return;
  }

  const decks = await getAllDecks();
  root.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `<h1>Your decks</h1>`;

  const viewToggle = document.createElement('button');
  viewToggle.className = 'view-toggle-btn';
  viewToggle.textContent = 'Map view';
  viewToggle.addEventListener('click', () => toggleView());
  header.appendChild(viewToggle);

  const newDeckBtn = document.createElement('button');
  newDeckBtn.className = 'new-deck-btn';
  newDeckBtn.textContent = '+ New deck';
  newDeckBtn.addEventListener('click', () => openDeckModal());
  header.appendChild(newDeckBtn);

  root.appendChild(header);

  if (decks.length === 0) {
    root.appendChild(buildEmptyDecksState());
    return;
  }

  root.appendChild(await buildHomeStats(decks));

  const grid = document.createElement('div');
  grid.className = 'deck-grid';

  for (const deck of decks) {
    grid.appendChild(await buildDeckCard(deck));
  }

  root.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Home stats card — streak + weekly activity, plus due/mastery metrics
// across all decks. Deliberately only rendered on the list view; the map
// view carries the same information ambiently through island color/size,
// so repeating it there would be redundant chrome over the canvas.
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

async function buildHomeStats(decks) {
  const [reviewStats, allDue, deckCounts] = await Promise.all([
    getReviewStats(),
    getCardsDueTodayOrEarlier(),
    Promise.all(decks.map((d) => getDeckStateCounts(d.id)))
  ]);

  const totals = deckCounts.reduce(
    (acc, c) => ({
      newCount: acc.newCount + c.newCount,
      inProgress: acc.inProgress + c.inProgress,
      mastered: acc.mastered + c.mastered,
      total: acc.total + c.total
    }),
    { newCount: 0, inProgress: 0, mastered: 0, total: 0 }
  );

  const wrap = document.createElement('div');

  const statsCard = document.createElement('div');
  statsCard.className = 'home-stats';

  const streakRow = document.createElement('div');
  streakRow.className = 'streak-row';
  streakRow.innerHTML = `
    <div class="streak-badge">${reviewStats.streakDays}<span class="streak-unit">day streak</span></div>
    <div class="streak-meta"><strong>${totals.mastered} cards mastered</strong>${reviewStats.weekTotal} reviews this week</div>
  `;
  statsCard.appendChild(streakRow);

  const sparkRow = document.createElement('div');
  sparkRow.className = 'spark-row';
  const maxCount = Math.max(1, ...reviewStats.weekCounts);
  const todayIndex = new Date().getDay(); // 0 = Sunday
  reviewStats.weekCounts.forEach((count, i) => {
    // weekCounts[i] is (6 - i) days before today, oldest first.
    const daysAgo = reviewStats.weekCounts.length - 1 - i;
    const weekday = WEEKDAY_LABELS[(todayIndex - daysAgo + 7) % 7];

    const bar = document.createElement('div');
    bar.className = 'spark-bar' + (daysAgo === 0 ? ' today' : '');
    bar.style.height = `${Math.max(8, (count / maxCount) * 100)}%`;
    bar.setAttribute('aria-label', `${weekday}: ${count} review${count === 1 ? '' : 's'}`);
    sparkRow.appendChild(bar);
  });
  statsCard.appendChild(sparkRow);

  wrap.appendChild(statsCard);

  const metricGrid = document.createElement('div');
  metricGrid.className = 'metric-grid';

  const dueCard = document.createElement('div');
  dueCard.className = 'metric-card';
  dueCard.innerHTML = `<div class="metric-label">Due today</div><div class="metric-value">${allDue.length}</div>`;
  metricGrid.appendChild(dueCard);

  const masteryCard = document.createElement('div');
  masteryCard.className = 'metric-card';
  masteryCard.innerHTML = `<div class="metric-label">Weekly reviews</div><div class="metric-value">${reviewStats.weekTotal}</div>`;
  masteryCard.appendChild(buildMasteryBar(totals));
  metricGrid.appendChild(masteryCard);

  wrap.appendChild(metricGrid);

  return wrap;
}

/**
 * Shared by the home stats card and each deck tile — new (sand) / in
 * progress (ochre) / mastered (moss), matching canvas.js's island coloring
 * so the two surfaces read as one visual language.
 */
function buildMasteryBar({ newCount, inProgress, mastered, total }) {
  const bar = document.createElement('div');
  bar.className = 'mastery-bar';
  if (total === 0) return bar;

  const seg = (count, className) => {
    const el = document.createElement('span');
    el.className = className;
    el.style.width = `${(count / total) * 100}%`;
    return el;
  };

  bar.appendChild(seg(newCount, 'mastery-seg-new'));
  bar.appendChild(seg(inProgress, 'mastery-seg-progress'));
  bar.appendChild(seg(mastered, 'mastery-seg-mastered'));
  return bar;
}

function buildMapOverlayControls() {
  const overlay = document.createElement('button');
  overlay.className = 'map-overlay-list-btn';
  overlay.textContent = 'List view';
  overlay.addEventListener('click', () => {
    uiState.view = 'list';
    renderDeckList();
  });
  return overlay;
}

async function buildDeckCard(deck) {
  const [due, counts, leeches] = await Promise.all([
    getCardsDueTodayOrEarlier({ deckId: deck.id }),
    getDeckStateCounts(deck.id),
    getSuspendedCards(deck.id)
  ]);

  const wrapper = document.createElement('div');
  wrapper.className = 'deck-card-wrapper';

  const card = document.createElement('button');
  card.className = 'deck-card';
  const masteryPct = counts.total > 0 ? Math.round((counts.mastered / counts.total) * 100) : 0;
  card.setAttribute('aria-label', `${deck.title}, ${due.length} due, ${masteryPct}% mastered`);

  const title = document.createElement('div');
  title.className = 'deck-card-title';
  title.textContent = deck.title;
  card.appendChild(title);

  if (due.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'deck-card-badge';
    badge.textContent = String(due.length);
    card.appendChild(badge);
  }

  card.appendChild(buildMasteryBar(counts));

  card.addEventListener('click', () => enterStudy(deck.id));
  wrapper.appendChild(card);
  wrapper.appendChild(buildImportButton(deck.id));

  if (leeches.length > 0) {
    wrapper.appendChild(buildLeechButton(deck, leeches.length));
  }

  return wrapper;
}

function buildLeechButton(deck, count) {
  const btn = document.createElement('button');
  btn.className = 'deck-card-leech-btn';
  btn.textContent = `Leeches (${count})`;
  btn.setAttribute('aria-label', `View ${count} leeched card${count === 1 ? '' : 's'} in ${deck.title}`);
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the parent card's study-entry click
    renderLeechView(deck);
  });
  return btn;
}

function buildImportButton(deckId) {
  const importBtn = document.createElement('button');
  importBtn.className = 'deck-card-import-btn';
  importBtn.textContent = 'Import PDF';
  importBtn.setAttribute('aria-label', 'Import PDF into this deck');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/pdf';
  fileInput.style.display = 'none';

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // allow re-selecting the same file later
    if (!file) return;

    if (!isPdfFile(file)) {
      showToast('That file doesn\u2019t look like a PDF.');
      return;
    }

    showToast('Reading PDF\u2026');
    try {
      const text = await extractTextFromPdf(file, ({ page, totalPages }) => {
        if (page === totalPages) showToast(`Read ${totalPages} page${totalPages === 1 ? '' : 's'}. Generating cards\u2026`);
      });
      if (!text.trim()) {
        showToast('Couldn\u2019t find any text in that PDF (might be scanned images).');
        return;
      }
      await handleGeneration(text, deckId);
    } catch (err) {
      showToast(`Couldn't read that PDF: ${err.message}`);
    }
  });

  importBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the parent card's study-entry click
    fileInput.click();
  });

  const container = document.createElement('div');
  container.appendChild(importBtn);
  container.appendChild(fileInput);
  return container;
}

// ---------------------------------------------------------------------------
// Leech review — a minimal maintenance surface (plain list, no canvas.js
// involvement). Reached via the "Leeches (N)" affordance on a deck card.
// ---------------------------------------------------------------------------

async function renderLeechView(deck) {
  const leeches = await getSuspendedCards(deck.id);
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'leech-view';

  const header = document.createElement('div');
  header.className = 'leech-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'leech-view-back-btn';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = `Leeches in ${deck.title} (${leeches.length})`;
  header.appendChild(heading);

  wrap.appendChild(header);

  if (leeches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'leech-view-empty';
    empty.textContent = 'No leeches left in this deck.';
    wrap.appendChild(empty);
    root.appendChild(wrap);
    return;
  }

  const list = document.createElement('div');
  list.className = 'leech-view-list';

  for (const card of leeches) {
    list.appendChild(buildLeechRow(deck, card));
  }

  wrap.appendChild(list);
  root.appendChild(wrap);
}

function buildLeechRow(deck, card) {
  const row = document.createElement('div');
  row.className = 'leech-row';

  const content = document.createElement('div');
  content.className = 'leech-row-content';
  content.innerHTML = `
    <div class="leech-row-front">${escapeHtml(card.front)}</div>
    <div class="leech-row-back">${escapeHtml(card.back)}</div>
    <div class="leech-row-lapses">Lapses: ${card.lapses}</div>
  `;
  row.appendChild(content);

  const actions = document.createElement('div');
  actions.className = 'leech-row-actions';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'leech-row-reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', async () => {
    await resetLeech(card.id);
    showToast('Card reset — back in the regular queue.');
    await renderLeechView(deck);
  });
  actions.appendChild(resetBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'leech-row-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    await deleteCard(card.id);
    showToast('Card deleted.');
    await renderLeechView(deck);
  });
  actions.appendChild(deleteBtn);

  row.appendChild(actions);
  return row;
}

function buildEmptyDecksState() {
  const empty = document.createElement('div');
  empty.className = 'empty-decks-state';
  empty.innerHTML = `
    <p>No decks yet.</p>
    <button class="create-deck-btn">Create your first deck</button>
  `;
  empty.querySelector('.create-deck-btn').addEventListener('click', () => openDeckModal());
  return empty;
}

/**
 * Real deck creation form: title + territory/course name (free text —
 * territories are just courseTerritoryId strings; canvas.js groups by
 * whatever's typed here, no separate territory table needed). Replaces the
 * earlier prompt()-based placeholder.
 */
async function openDeckModal() {
  const existingDecks = await getAllDecks();
  const existingTerritories = Array.from(
    new Set(existingDecks.map((d) => d.courseTerritoryId).filter(Boolean))
  );

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>New deck</h2>
    <label class="modal-label">Title
      <input type="text" class="modal-title-input" placeholder="e.g. EEE 307 — Field Theory" />
    </label>
    <label class="modal-label">Territory / course
      <input type="text" class="modal-territory-input" list="territory-options" placeholder="e.g. EEE 307" />
      <datalist id="territory-options">
        ${existingTerritories.map((t) => `<option value="${escapeAttr(t)}"></option>`).join('')}
      </datalist>
    </label>
    <div class="modal-actions">
      <button class="modal-cancel-btn">Cancel</button>
      <button class="modal-save-btn">Create</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const titleInput = modal.querySelector('.modal-title-input');
  const territoryInput = modal.querySelector('.modal-territory-input');
  titleInput.focus();

  const close = () => overlay.remove();

  modal.querySelector('.modal-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  modal.querySelector('.modal-save-btn').addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return;
    }
    const territory = territoryInput.value.trim() || 'uncategorized';

    await saveDeck({
      id: cryptoRandomId(),
      title,
      courseTerritoryId: territory,
      createdAt: Date.now()
    });

    close();
    await renderDeckList();
  });
}

function escapeAttr(str) {
  return (str ?? '').replace(/"/g, '&quot;');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/**
 * This view is also the required low-end-device / accessibility fallback,
 * so it must remain fully functional on its own — nothing here should ever
 * assume canvas.js is present.
 */
function toggleView() {
  uiState.view = uiState.view === 'list' ? 'map' : 'list';
  renderDeckList();
}

// ---------------------------------------------------------------------------
// Deck creation (minimal — enough to test the rest of the pipeline; a real
// creation form with territory/course assignment is a canvas.js-era concern)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Study Mode entry/exit — the single entry point canvas.js will also use
// once it exists.
// ---------------------------------------------------------------------------

function enterStudy(deckId) {
  uiState.currentDeckId = deckId;
  startStudySession(root, {
    deckId,
    onExit: () => renderDeckList()
  });
}

// ---------------------------------------------------------------------------
// Generation flow: upload -> generateCards() -> edit step -> commit
// pdf.js extraction itself lives wherever the "upload" UI triggers it
// (out of scope for this file — assume `extractedText` arrives already
// parsed client-side, per the spec's "nothing is uploaded to the server").
// ---------------------------------------------------------------------------

export async function handleGeneration(extractedText, deckId) {
  showToast('Generating cards\u2026');
  const cards = await generateCards(extractedText, deckId);
  if (cards.length > 0) {
    renderEditStep(cards, deckId);
  }
  // If cards.length === 0, either it was queued (offline) or errored —
  // wireGenerationEvents() below handles the toast either way.
}

function renderEditStep(cards, deckId) {
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'edit-step';
  wrap.innerHTML = `<h2>Review ${cards.length} generated card${cards.length === 1 ? '' : 's'}</h2>`;

  const list = document.createElement('div');
  list.className = 'edit-step-list';

  const editable = cards.map(c => ({ ...c }));

  editable.forEach((card, i) => {
    const row = document.createElement('div');
    row.className = 'edit-step-row';

    const frontInput = document.createElement('textarea');
    frontInput.value = card.front;
    frontInput.addEventListener('input', () => { editable[i].front = frontInput.value; });

    const backInput = document.createElement('textarea');
    backInput.value = card.back;
    backInput.addEventListener('input', () => { editable[i].back = backInput.value; });

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Discard';
    removeBtn.addEventListener('click', () => {
      editable[i] = null;
      row.remove();
    });

    row.appendChild(frontInput);
    row.appendChild(backInput);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });

  wrap.appendChild(list);

  const commitBtn = document.createElement('button');
  commitBtn.className = 'commit-cards-btn';
  commitBtn.textContent = 'Add to deck';
  commitBtn.addEventListener('click', async () => {
    const approved = editable.filter(Boolean);
    await commitGeneratedCards(deckId, approved);
    showToast(`Added ${approved.length} cards.`);
    await renderDeckList();
  });
  wrap.appendChild(commitBtn);

  root.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// api.js event wiring — this is the one place its CustomEvents are consumed.
// ---------------------------------------------------------------------------

function wireGenerationEvents() {
  window.addEventListener('recall:generation-queued', () => {
    showToast('Offline — your text is queued and will generate automatically once you\u2019re back online.');
  });

  window.addEventListener('recall:generation-error', (e) => {
    showToast(`Generation failed: ${e.detail.message}`);
  });

  window.addEventListener('recall:generation-retry-done', (e) => {
    showToast(`Back online — generated ${e.detail.cardCount} queued card(s).`);
  });
}

// ---------------------------------------------------------------------------
// Shared toast (small enough not to warrant its own file; study.js keeps its
// own copy rather than importing this one, to stay decoupled from app.js)
// ---------------------------------------------------------------------------

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function cryptoRandomId() {
  return (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', initApp);
