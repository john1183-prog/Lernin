// app.js
// General UI orchestration + the flat list/grid deck view (the required
// accessibility fallback, built before canvas.js per the spec's build
// order). This is the ONLY view for now — canvas.js, when it exists, will
// call the same startStudySession() entry point this file uses, and will
// read the view-mode preference this file owns.

import { getAllDecks, saveDeck, getCardsByDeck, getCardsDueTodayOrEarlier, getDeckStateCounts, getReviewStats, getSuspendedCards, resetLeech, deleteCard, getApiConfig, saveApiConfig, clearApiConfig, wipeAllData, saveDocument, getDocumentsByDeck, deleteDocument, clearIslandPosition, useStreakFreeze, getReviewHistoryForCard, migrateFromOldDatabaseIfNeeded, exportDeckData, importDeckData, getDashboardStats, saveManualCard, addRelationship, removeRelationship, getRelationshipsFrom, searchCardsByFront } from './db.js';
import { startStudySession, endStudySession } from './study.js';
import { generateCards, commitGeneratedCards, retryQueuedGenerations, dedupeAgainstDeck } from './api.js';
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
  // Must complete before renderDeckList() — otherwise a user's first paint
  // after this rename ships would show an empty deck list while migration
  // is still copying their real data across in the background.
  await migrateFromOldDatabaseIfNeeded();
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

  const importBtn = document.createElement('button');
  importBtn.className = 'import-deck-btn';
  importBtn.textContent = 'Import';
  importBtn.setAttribute('aria-label', 'Import a deck from a file');
  importBtn.addEventListener('click', () => triggerDeckImport());
  header.appendChild(importBtn);

  const helpBtn = document.createElement('button');
  helpBtn.className = 'help-btn';
  helpBtn.setAttribute('aria-label', 'Help — what is Lernin and how does it work');
  helpBtn.textContent = '?';
  helpBtn.addEventListener('click', () => renderHelpView());
  header.appendChild(helpBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'settings-btn';
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.textContent = '\u2699\uFE0F Settings';
  settingsBtn.addEventListener('click', () => renderSettingsView());
  header.appendChild(settingsBtn);

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
  if (reviewStats.freezesAvailable > 0) {
    const freezeBadge = document.createElement('span');
    freezeBadge.className = 'streak-freeze-badge';
    freezeBadge.title = 'Streak freezes: skip a day without breaking your streak. Earned every 7-day streak, up to 3.';
    freezeBadge.textContent = `\u2744\ufe0f ${reviewStats.freezesAvailable}`;
    streakRow.appendChild(freezeBadge);
  }
  statsCard.appendChild(streakRow);

  if (!reviewStats.studiedToday && reviewStats.streakDays > 0) {
    const atRisk = document.createElement('div');
    atRisk.className = 'streak-at-risk';
    if (reviewStats.freezesAvailable > 0) {
      atRisk.innerHTML = `<span>Haven\u2019t studied today \u2014 your streak is at risk.</span>`;
      const freezeBtn = document.createElement('button');
      freezeBtn.className = 'streak-freeze-btn';
      freezeBtn.textContent = 'Use a freeze';
      freezeBtn.addEventListener('click', async () => {
        const used = await useStreakFreeze();
        if (used) {
          showToast('Streak protected for today.');
          await renderDeckList();
        }
      });
      atRisk.appendChild(freezeBtn);
    } else {
      atRisk.innerHTML = `<span>Haven\u2019t studied today \u2014 your streak is at risk.</span>`;
    }
    statsCard.appendChild(atRisk);
  }

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

  const viewStatsLink = document.createElement('button');
  viewStatsLink.className = 'view-full-stats-btn';
  viewStatsLink.textContent = 'View full statistics \u2192';
  viewStatsLink.addEventListener('click', (e) => {
    e.stopPropagation();
    renderStatsView();
  });
  statsCard.appendChild(viewStatsLink);

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
  const [due, counts, leeches, documents] = await Promise.all([
    getCardsDueTodayOrEarlier({ deckId: deck.id }),
    getDeckStateCounts(deck.id),
    getSuspendedCards(deck.id),
    getDocumentsByDeck(deck.id)
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
  wrapper.appendChild(buildEditDeckButton(deck));
  wrapper.appendChild(buildExportDeckButton(deck));
  wrapper.appendChild(buildNewCardButton(deck));

  if (documents.length > 0) {
    wrapper.appendChild(buildDocumentsButton(deck, documents.length));
  }

  if (leeches.length > 0) {
    wrapper.appendChild(buildLeechButton(deck, leeches.length));
  }

  return wrapper;
}

function buildEditDeckButton(deck) {
  const btn = document.createElement('button');
  btn.className = 'deck-card-edit-btn';
  btn.textContent = 'Edit';
  btn.setAttribute('aria-label', `Edit ${deck.title} \u2014 rename or move to a different course group`);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDeckModal(deck);
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Deck export / import — JSON backup and restore, and deck sharing. See
// db.js's exportDeckData/importDeckData for the actual data handling; this
// section is just the file-download/file-read UI glue around it.
// ---------------------------------------------------------------------------

function buildExportDeckButton(deck) {
  const btn = document.createElement('button');
  btn.className = 'deck-card-edit-btn';
  btn.textContent = 'Export';
  btn.setAttribute('aria-label', `Export ${deck.title}`);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openExportOptionsModal(deck);
  });
  return btn;
}

function buildNewCardButton(deck) {
  const btn = document.createElement('button');
  btn.className = 'deck-card-edit-btn';
  btn.textContent = '+ Card';
  btn.setAttribute('aria-label', `Add a card by hand to ${deck.title}`);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderNewCardView(deck);
  });
  return btn;
}

function openExportOptionsModal(deck) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>Export "${escapeHtml(deck.title)}"</h2>
    <p class="settings-key-help">Choose what to include in the exported file.</p>
  `;

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'modal-label';

  const fullLabel = document.createElement('label');
  fullLabel.className = 'settings-provider-option';
  fullLabel.style.display = 'flex';
  fullLabel.innerHTML = `<input type="radio" name="export-mode" value="full" checked /> Full backup (includes your study progress)`;
  optionsWrap.appendChild(fullLabel);

  const shareLabel = document.createElement('label');
  shareLabel.className = 'settings-provider-option';
  shareLabel.style.display = 'flex';
  shareLabel.style.marginTop = '8px';
  shareLabel.innerHTML = `<input type="radio" name="export-mode" value="share" /> Share copy (cards only, no progress \u2014 for sending to someone else)`;
  optionsWrap.appendChild(shareLabel);

  modal.appendChild(optionsWrap);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'modal-save-btn';
  confirmBtn.textContent = 'Export';
  confirmBtn.addEventListener('click', async () => {
    const mode = modal.querySelector('input[name="export-mode"]:checked')?.value || 'full';
    overlay.remove();
    await downloadDeckExport(deck, mode === 'full');
  });
  actions.appendChild(confirmBtn);

  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function downloadDeckExport(deck, includeProgress) {
  const data = await exportDeckData(deck.id, { includeProgress });
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const safeName = deck.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'deck';
  const a = document.createElement('a');
  a.href = url;
  a.download = `lernin-${safeName}${includeProgress ? '' : '-share'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  showToast(`Exported ${data.cards.length} card${data.cards.length === 1 ? '' : 's'}.`);
}

function triggerDeckImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await importDeckData(parsed);
      showToast(`Imported "${parsed.deck.title}" \u2014 ${result.cardCount} card${result.cardCount === 1 ? '' : 's'}.`);
      await renderDeckList();
    } catch (err) {
      showToast(err.message?.includes('JSON') ? 'That file isn\u2019t valid JSON.' : (err.message || 'Import failed.'));
    }
  });
  input.click();
}

function buildDocumentsButton(deck, count) {
  const btn = document.createElement('button');
  btn.className = 'deck-card-documents-btn';
  btn.textContent = `Documents (${count})`;
  btn.setAttribute('aria-label', `View ${count} uploaded document${count === 1 ? '' : 's'} in ${deck.title}`);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderDocumentsView(deck);
  });
  return btn;
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
      // The document record is saved once a summary actually exists (inside
      // handleGeneration / the manual-paste flow), not here — storing the
      // original PDF Blob would be a lot of browser storage for students
      // uploading many PDFs across a term, so only the filename, size, and
      // an LLM-written summary are kept, not the file itself.
      await handleGeneration(text, deckId, { filename: file.name, size: file.size });
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

  const histories = await Promise.all(leeches.map((c) => getReviewHistoryForCard(c.id)));

  leeches.forEach((card, i) => {
    list.appendChild(buildLeechRow(deck, card, histories[i]));
  });

  wrap.appendChild(list);
  root.appendChild(wrap);
}

function buildLeechRow(deck, card, history = []) {
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

  // Not real semantic "why this card keeps failing" analysis — the app
  // only ever records a grade per review, not which part of the answer
  // was wrong, so there's no data to reason about *why*. This is the
  // honest version: a quick-glance pattern (recent grades + fail rate)
  // that at least tells you whether this was one bad week or a card
  // that's basically never landing, without pretending to explain more
  // than the data actually supports.
  if (history.length > 0) {
    const recent = history.slice(-10);
    const failCount = history.filter((h) => h.grade === 'again').length;
    const failRate = Math.round((failCount / history.length) * 100);

    const historyEl = document.createElement('div');
    historyEl.className = 'leech-row-history';

    const dots = document.createElement('div');
    dots.className = 'leech-row-history-dots';
    for (const entry of recent) {
      const dot = document.createElement('span');
      dot.className = `leech-history-dot leech-history-dot-${entry.grade}`;
      dot.title = entry.grade;
      dots.appendChild(dot);
    }
    historyEl.appendChild(dots);

    const rateLabel = document.createElement('span');
    rateLabel.className = 'leech-row-fail-rate';
    rateLabel.textContent = `${failRate}% "Again" over ${history.length} review${history.length === 1 ? '' : 's'}`;
    historyEl.appendChild(rateLabel);

    row.appendChild(historyEl);
  }

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

// ---------------------------------------------------------------------------
// Settings — lets the user bring their own Claude or Gemini API key for
// card generation, or use "Paste into any AI" mode if they don't have one.
// Stored client-side in IndexedDB (db.js's settings store); Claude/Gemini
// keys are sent to our backend per-request via headers, never persisted
// server-side — see api/index.py's _resolve_credentials(). Manual mode
// never talks to our backend at all — see renderManualPasteView().
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Statistics dashboard — a broader view over the same review data the home
// screen's stats card summarizes, via db.js's getDashboardStats(). Read-only:
// no actions here beyond navigating back.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Help — a persistent, in-app reference, not a one-time tour. People kept
// reporting they didn't understand what the app was or how to use it, so
// this needs to be thorough and always reachable, not a dismiss-once modal.
//
// MAINTENANCE: when a feature ships, add or update its <details> section
// here in the same pass. This view is explicitly meant to stay in sync
// with what the app actually does — an out-of-date Help view is worse
// than none, since it actively misleads. Keep each section short enough
// to read in under a minute; link concepts together rather than repeating
// explanations across sections.
// ---------------------------------------------------------------------------

function renderHelpView() {
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'help-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = 'What is Lernin, and how does it work?';
  header.appendChild(heading);
  wrap.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'help-intro';
  intro.textContent = 'Lernin is a spaced repetition study app: instead of re-reading notes and hoping it sticks, you review small question-and-answer cards on a schedule that adapts to how well you actually know each one. Cards you find easy come back less often; cards you struggle with come back sooner. It runs entirely on your device — your decks, cards, and study history never leave your phone or computer unless you explicitly export or generate cards.';
  wrap.appendChild(intro);

  const sections = [
    {
      title: 'Getting cards into a deck',
      body: `Two ways to add cards: upload a PDF (tap "Import PDF" on a deck, and Lernin extracts the text and turns it into cards), or add a single card by hand (tap "+ Card"). How PDF generation happens depends on what you've set up in Settings:
      <ul>
        <li><strong>Your own Claude or Gemini API key</strong> — one tap, cards generate automatically.</li>
        <li><strong>"Paste into any AI" (no key needed)</strong> — you get a ready-made prompt to copy into ChatGPT, Claude.ai, Gemini, or whatever you already use, then paste the result back in.</li>
      </ul>
      Either way, you get a chance to review, edit, or discard each generated card before anything is saved — nothing is added to your deck automatically.`
    },
    {
      title: 'Formula cards and relationships',
      body: `"+ Card" lets you add a Basic, Cloze, or Formula card. Formula cards have extra structured fields: the formula itself, its variables (symbol + meaning), assumptions it relies on, common mistakes, and real-world applications — useful for STEM material where the "answer" is more than a single fact. All of this shows up when you reveal the answer during a review, after the plain question like any other card — formulas render as plain text/monospace, not typeset math.
      <br><br>
      Any card (not just formula cards) can be linked to others as <strong>Depends on</strong> (a prerequisite you should know first) or <strong>Related</strong> (a connected but non-prerequisite concept) — search for an existing card by its front text while creating a new one. These links can cross decks, so a formula in one course can depend on a concept from an earlier one.
      <br><br>
      Relationships aren't surfaced anywhere yet beyond creation — a dedicated relationship explorer and prerequisite-aware study planner are planned but not built (see the repo's UPCOMING_FEATURES.md).`
    },
    {
      title: 'Why you bring your own AI key',
      body: `Card generation calls a real AI model, which costs money per use. Rather than the app quietly funding that (and eventually having to add ads or a subscription to cover it), you connect your own Claude or Gemini key, or generate cards for free by pasting into any AI chat tool you already have access to. Your key is stored only on your device and sent directly to your chosen provider when you generate cards — never stored on any server.`
    },
    {
      title: 'Reviewing cards',
      body: `Each card shows a question first; tap it to reveal the answer, then grade yourself honestly:
      <ul>
        <li><strong>Again</strong> — you didn't know it. You'll see it again soon.</li>
        <li><strong>Hard</strong> — you got it, but it took real effort.</li>
        <li><strong>Good</strong> — you knew it comfortably.</li>
        <li><strong>Easy</strong> — trivial; you'll see it again much later.</li>
      </ul>
      Grading isn't about being right or wrong so much as being honest about how easily it came back to you — the schedule only works well if the grades reflect that.`
    },
    {
      title: 'Leeches',
      body: `A card that you keep getting wrong over and over (an "Again" streak) gets automatically suspended — pulled out of your regular review queue — rather than endlessly wasting review time on something that isn't sticking. Suspended cards show up under a deck's "Leeches" button, where you can see the card's recent grade history and either Reset it (start it over fresh) or Delete it, if it's a card that just isn't worth keeping.`
    },
    {
      title: 'Streaks and freezes',
      body: `Your streak counts consecutive days with at least one review. Every 7-day streak earns a "freeze" (up to 3 saved at once) — if you know you'll miss a day, spend a freeze from the home screen to protect your streak instead of losing it. Freezes aren't spent automatically; you choose when to use one.`
    },
    {
      title: 'The map view',
      body: `An alternative to the list view: each deck is a colored island. An island's color reflects two things — a warm-to-green progression showing how mastered that deck is, and a subtle per-deck tint so decks are visually distinguishable even before you've studied anything. Islands are grouped into "territories" by course (set when you create or edit a deck); drag an island to rearrange it within its group, or pinch to zoom out and see everything at once. Tap an island to jump straight into studying that deck.`
    },
    {
      title: 'Documents and Course Recap',
      body: `When you upload a PDF, Lernin keeps the filename and an AI-written summary of it — not the original file. This is deliberate: storing every PDF a student uploads across a term adds up fast, and the summary is what's actually useful to revisit. Under a deck's "Documents" button, you can view each summary. If a deck has multiple documents, "Course Recap" stitches all their summaries into one read-through, meant to be skimmable in a few minutes before an exam.`
    },
    {
      title: 'Settings — Storage, Hard Reload, and Reset',
      body: `<strong>Storage usage</strong> shows how much space Lernin is using on this device. <strong>Hard reload</strong> forces the app to fetch the latest version instead of a cached one — useful if an update was released but the app still looks or behaves like the old version, especially on mobile. It doesn't touch your decks or cards. <strong>Reset everything</strong> does the opposite — it permanently deletes every deck, card, and review history on this device. There's no undo, which is why it requires typing RESET to confirm. Export your decks first if there's anything you'd want back.`
    },
    {
      title: 'Export and Import',
      body: `Export a deck as a <strong>full backup</strong> (includes your study progress) or a <strong>share copy</strong> (just the cards, fresh — for sending to a classmate without handing over your personal stats). Importing a file always creates a brand-new deck; it never overwrites or merges into an existing one, so importing the same file twice just gives you two copies.`
    },
    {
      title: 'What data leaves your device',
      body: `Nothing, by default. Your decks, cards, and review history live only in your browser's local storage (IndexedDB) and are never sent to any Lernin server. The one exception: when you generate cards from a PDF, the extracted text is sent directly to whichever AI provider you've configured (Claude, Gemini, or whatever tool you paste into manually) — never to a Lernin-operated server in between.`
    }
  ];

  for (const section of sections) {
    const details = document.createElement('details');
    details.className = 'help-section';
    details.innerHTML = `<summary>${escapeHtml(section.title)}</summary><div class="help-section-body">${section.body}</div>`;
    wrap.appendChild(details);
  }

  root.appendChild(wrap);
}

async function renderStatsView() {
  const stats = await getDashboardStats();
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'stats-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = 'Statistics';
  header.appendChild(heading);
  wrap.appendChild(header);

  // --- summary metrics ---
  const metricsGrid = document.createElement('div');
  metricsGrid.className = 'stats-metrics-grid';

  const metrics = [
    { label: '30-day retention', value: stats.retention30d !== null ? `${stats.retention30d}%` : '\u2014' },
    { label: 'Longest streak', value: `${stats.longestStreak365d}d` },
    { label: 'Total reviews', value: stats.totalReviewsLifetime.toLocaleString() },
    { label: 'Cards studied', value: stats.totalCardsStudied.toLocaleString() },
    { label: 'Leeches', value: stats.leechCount.toLocaleString() }
  ];
  for (const m of metrics) {
    const card = document.createElement('div');
    card.className = 'stats-metric-card';
    card.innerHTML = `<div class="stats-metric-value">${m.value}</div><div class="stats-metric-label">${m.label}</div>`;
    metricsGrid.appendChild(card);
  }
  wrap.appendChild(metricsGrid);

  // --- 30-day activity chart ---
  const chartHeading = document.createElement('h3');
  chartHeading.className = 'stats-section-heading';
  chartHeading.textContent = 'Last 30 days';
  wrap.appendChild(chartHeading);

  const chartRow = document.createElement('div');
  chartRow.className = 'stats-chart-row';
  const maxDaily = Math.max(1, ...stats.dailyCounts30d);
  stats.dailyCounts30d.forEach((count, i) => {
    const daysAgo = stats.dailyCounts30d.length - 1 - i;
    const bar = document.createElement('div');
    bar.className = 'stats-chart-bar' + (daysAgo === 0 ? ' today' : '');
    bar.style.height = `${Math.max(6, (count / maxDaily) * 100)}%`;
    bar.setAttribute('aria-label', `${daysAgo === 0 ? 'Today' : daysAgo + ' days ago'}: ${count} review${count === 1 ? '' : 's'}`);
    chartRow.appendChild(bar);
  });
  wrap.appendChild(chartRow);

  // --- per-deck breakdown ---
  const deckHeading = document.createElement('h3');
  deckHeading.className = 'stats-section-heading';
  deckHeading.textContent = 'By deck';
  wrap.appendChild(deckHeading);

  if (stats.perDeck.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'leech-view-empty';
    empty.textContent = 'No decks yet.';
    wrap.appendChild(empty);
  } else {
    const deckList = document.createElement('div');
    deckList.className = 'stats-deck-list';
    for (const d of stats.perDeck) {
      const row = document.createElement('div');
      row.className = 'stats-deck-row';
      row.innerHTML = `
        <div class="stats-deck-row-title">${escapeHtml(d.title)}</div>
        <div class="stats-deck-row-meta">
          ${d.total} card${d.total === 1 ? '' : 's'} \u00b7 ${d.mastered} mastered \u00b7 ${d.dueToday} due today
        </div>
      `;
      deckList.appendChild(row);
    }
    wrap.appendChild(deckList);
  }

  root.appendChild(wrap);
}

async function renderSettingsView() {
  const existing = await getApiConfig();
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'settings-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = 'Settings';
  header.appendChild(heading);

  wrap.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'settings-view-intro';
  intro.textContent = 'Choose how you\u2019d like to generate cards. Bring your own Claude or Gemini API key for one-tap generation, or use "Paste into any AI" if you don\u2019t have a key \u2014 no key is stored or sent anywhere except directly to the provider you choose (for Claude/Gemini) at the moment you generate cards.';
  wrap.appendChild(intro);

  const form = document.createElement('form');
  form.className = 'settings-form';

  // --- provider choice ---
  const providerLabel = document.createElement('label');
  providerLabel.className = 'settings-form-label';
  providerLabel.textContent = 'Provider';
  form.appendChild(providerLabel);

  const providerRow = document.createElement('div');
  providerRow.className = 'settings-provider-row';

  const providers = [
    { value: 'claude', label: 'Claude (Anthropic)' },
    { value: 'gemini', label: 'Gemini (Google)' },
    { value: 'manual', label: 'Paste into any AI (no key needed)' }
  ];
  const currentProvider = existing?.provider || 'claude';

  for (const p of providers) {
    const optionLabel = document.createElement('label');
    optionLabel.className = 'settings-provider-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'provider';
    radio.value = p.value;
    radio.checked = p.value === currentProvider;
    radio.addEventListener('change', () => updateKeyFieldVisibility());

    optionLabel.appendChild(radio);
    optionLabel.appendChild(document.createTextNode(` ${p.label}`));
    providerRow.appendChild(optionLabel);
  }
  form.appendChild(providerRow);

  // --- API key (hidden entirely for manual mode) ---
  const keyLabel = document.createElement('label');
  keyLabel.className = 'settings-form-label';
  keyLabel.textContent = 'API key';
  keyLabel.setAttribute('for', 'settings-api-key-input');
  form.appendChild(keyLabel);

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.id = 'settings-api-key-input';
  keyInput.className = 'settings-api-key-input';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = existing?.apiKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved — enter a new key to replace it)' : 'Paste your API key';
  form.appendChild(keyInput);

  const keyHelp = document.createElement('p');
  keyHelp.className = 'settings-key-help';
  keyHelp.innerHTML = 'Get a key from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> (Claude) or <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a> (Gemini).';
  form.appendChild(keyHelp);

  const manualNote = document.createElement('p');
  manualNote.className = 'settings-key-help';
  manualNote.textContent = 'No key needed. When you generate cards, you\u2019ll get a prompt to copy into any AI chat tool (ChatGPT, Claude.ai, Gemini, etc.) and a box to paste the result back in.';
  manualNote.style.display = 'none';
  form.appendChild(manualNote);

  function updateKeyFieldVisibility() {
    const provider = form.querySelector('input[name="provider"]:checked')?.value || 'claude';
    const isManual = provider === 'manual';
    keyLabel.style.display = isManual ? 'none' : '';
    keyInput.style.display = isManual ? 'none' : '';
    keyHelp.style.display = isManual ? 'none' : '';
    manualNote.style.display = isManual ? '' : 'none';
  }
  updateKeyFieldVisibility();

  // --- actions ---
  const actions = document.createElement('div');
  actions.className = 'settings-form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'settings-save-btn';
  saveBtn.textContent = 'Save';
  actions.appendChild(saveBtn);

  if (existing) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'settings-remove-btn';
    removeBtn.textContent = 'Remove key';
    removeBtn.addEventListener('click', async () => {
      await clearApiConfig();
      showToast('Settings cleared \u2014 you\u2019ll need to choose a provider again before generating cards.');
      await renderSettingsView();
    });
    actions.appendChild(removeBtn);
  }

  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const provider = form.querySelector('input[name="provider"]:checked')?.value || 'claude';

    if (provider === 'manual') {
      await saveApiConfig({ provider, apiKey: '' });
      showToast('Settings saved.');
      await renderSettingsView();
      return;
    }

    const newKey = keyInput.value.trim();

    // Leaving the key field blank when a key is already saved keeps the
    // existing key (just switching provider, say) rather than wiping it —
    // the placeholder text above explains this.
    const apiKey = newKey || (existing?.provider === provider ? existing?.apiKey : '') || '';

    if (!apiKey) {
      showToast('Enter an API key to save.');
      return;
    }

    await saveApiConfig({ provider, apiKey });
    showToast('Settings saved.');
    await renderSettingsView();
  });

  wrap.appendChild(form);

  // --- storage section: usage estimate + hard reload ---
  const storageSection = document.createElement('div');
  storageSection.className = 'settings-danger-zone';

  const storageHeading = document.createElement('h3');
  storageHeading.className = 'settings-danger-heading';
  storageHeading.style.color = 'var(--ink)';
  storageHeading.textContent = 'Storage';
  storageSection.appendChild(storageHeading);

  const storageUsageText = document.createElement('p');
  storageUsageText.className = 'settings-key-help';
  storageUsageText.textContent = 'Checking storage usage\u2026';
  storageSection.appendChild(storageUsageText);

  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage, quota }) => {
      if (typeof usage === 'number' && typeof quota === 'number' && quota > 0) {
        const pct = Math.round((usage / quota) * 100);
        storageUsageText.textContent = `Using ${formatFileSize(usage)} of ${formatFileSize(quota)} available on this device (${pct}%).`;
      } else {
        storageUsageText.textContent = 'Storage usage isn\u2019t available in this browser.';
      }
    }).catch(() => {
      storageUsageText.textContent = 'Storage usage isn\u2019t available in this browser.';
    });
  } else {
    storageUsageText.textContent = 'Storage usage isn\u2019t available in this browser.';
  }

  const reloadIntro = document.createElement('p');
  reloadIntro.className = 'settings-key-help';
  reloadIntro.textContent = 'If a new version was deployed but the app still looks/behaves like the old one (common on mobile, where a normal refresh doesn\u2019t clear the cached app shell), use this to force-load the latest version. Your decks and cards are untouched — this only clears cached app code, not your data.';
  storageSection.appendChild(reloadIntro);

  const hardReloadBtn = document.createElement('button');
  hardReloadBtn.type = 'button';
  hardReloadBtn.className = 'settings-remove-btn';
  hardReloadBtn.textContent = 'Hard reload';
  hardReloadBtn.addEventListener('click', async () => {
    hardReloadBtn.disabled = true;
    hardReloadBtn.textContent = 'Reloading\u2026';
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // Best-effort — reload regardless, a normal network fetch still picks
      // up the new deployment even if unregistering/clearing partially failed.
    }
    // Cache-busting query param, not just reload() — some browsers still
    // serve a bfcache/HTTP-cache copy of the HTML on a bare reload even
    // after the service worker is gone.
    window.location.href = `${window.location.pathname}?_r=${Date.now()}`;
  });
  storageSection.appendChild(hardReloadBtn);

  wrap.appendChild(storageSection);

  // --- danger zone ---
  const dangerZone = document.createElement('div');
  dangerZone.className = 'settings-danger-zone';

  const dangerHeading = document.createElement('h3');
  dangerHeading.className = 'settings-danger-heading';
  dangerHeading.textContent = 'Danger zone';
  dangerZone.appendChild(dangerHeading);

  const dangerIntro = document.createElement('p');
  dangerIntro.className = 'settings-key-help';
  dangerIntro.textContent = 'Permanently deletes every deck, card, and review history on this device. This cannot be undone — there\u2019s no cloud backup to restore from.';
  dangerZone.appendChild(dangerIntro);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'settings-danger-btn';
  resetBtn.textContent = 'Reset everything\u2026';
  dangerZone.appendChild(resetBtn);

  // Confirmation UI is built but hidden until the button above is clicked —
  // requires typing RESET rather than a plain confirm() dialog, since a
  // single accidental tap here is unrecoverable.
  const confirmWrap = document.createElement('div');
  confirmWrap.className = 'settings-danger-confirm';
  confirmWrap.style.display = 'none';

  const confirmLabel = document.createElement('p');
  confirmLabel.className = 'settings-key-help';
  confirmLabel.textContent = 'Type RESET to confirm:';
  confirmWrap.appendChild(confirmLabel);

  const confirmInput = document.createElement('input');
  confirmInput.type = 'text';
  confirmInput.className = 'settings-danger-confirm-input';
  confirmInput.autocomplete = 'off';
  confirmInput.spellcheck = false;
  confirmWrap.appendChild(confirmInput);

  const confirmActions = document.createElement('div');
  confirmActions.className = 'settings-form-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'settings-danger-btn';
  confirmBtn.textContent = 'Permanently delete everything';
  confirmBtn.disabled = true;
  confirmActions.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-remove-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    confirmWrap.style.display = 'none';
    confirmInput.value = '';
    confirmBtn.disabled = true;
  });
  confirmActions.appendChild(cancelBtn);

  confirmWrap.appendChild(confirmActions);
  dangerZone.appendChild(confirmWrap);

  resetBtn.addEventListener('click', () => {
    confirmWrap.style.display = confirmWrap.style.display === 'none' ? '' : 'none';
  });

  confirmInput.addEventListener('input', () => {
    confirmBtn.disabled = confirmInput.value.trim() !== 'RESET';
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting\u2026';
    try {
      await wipeAllData();
      // A full reload (not just re-rendering) so every in-memory module
      // cache (getDB()'s dbPromise, canvas.js's worldTerritories, etc.)
      // starts clean rather than trying to reconcile itself against a
      // database that no longer exists.
      window.location.reload();
    } catch (err) {
      showToast(err.message || 'Reset failed.');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Permanently delete everything';
    }
  });

  wrap.appendChild(dangerZone);
  root.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Documents — lists the original PDFs uploaded into a deck (see db.js's
// documents store) so they can be reopened later, not just their extracted
// text. Same plain-list pattern as the leech review surface.
// ---------------------------------------------------------------------------

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function renderDocumentsView(deck) {
  const documents = await getDocumentsByDeck(deck.id);
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'documents-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = `Documents in ${deck.title} (${documents.length})`;
  header.appendChild(heading);

  wrap.appendChild(header);

  if (documents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'leech-view-empty';
    empty.textContent = 'No documents uploaded to this deck yet.';
    wrap.appendChild(empty);
    root.appendChild(wrap);
    return;
  }

  const withSummaries = documents.filter((d) => d.summary && d.summary.trim());
  if (withSummaries.length > 0) {
    const recapBtn = document.createElement('button');
    recapBtn.className = 'course-recap-btn';
    recapBtn.textContent = '\ud83d\udcd6 Course Recap \u2014 5 min read';
    recapBtn.addEventListener('click', () => renderCourseRecapView(deck, withSummaries));
    wrap.appendChild(recapBtn);
  }

  const list = document.createElement('div');
  list.className = 'documents-list';

  for (const doc of documents) {
    list.appendChild(buildDocumentRow(deck, doc));
  }

  wrap.appendChild(list);
  root.appendChild(wrap);
}

/**
 * Concatenates every document's summary into one scrollable read, grouped
 * by source document — deliberately NOT another LLM call: each summary
 * was already generated for free as part of that document's card
 * generation (see api/index.py's generate_cards route), so stitching them
 * together here costs nothing and needs no API key/connectivity at all,
 * which matters for anyone using manual/no-key mode.
 */
function renderCourseRecapView(deck, documents) {
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'course-recap-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => renderDocumentsView(deck));
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = `${deck.title} \u2014 Course Recap`;
  header.appendChild(heading);
  wrap.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'leech-view-empty';
  intro.style.textAlign = 'left';
  intro.style.padding = '0 0 16px';
  intro.textContent = `A quick recap of everything uploaded to this deck, built from ${documents.length} document summar${documents.length === 1 ? 'y' : 'ies'} \u2014 meant to be skimmed in a few minutes before an exam, not a replacement for the full material.`;
  wrap.appendChild(intro);

  for (const doc of documents) {
    const section = document.createElement('div');
    section.className = 'course-recap-section';
    section.innerHTML = `
      <h3 class="course-recap-section-title">${escapeHtml(doc.filename)}</h3>
      <div class="course-recap-section-body">${escapeHtml(doc.summary)}</div>
    `;
    wrap.appendChild(section);
  }

  root.appendChild(wrap);
}

function buildDocumentRow(deck, doc) {
  const row = document.createElement('div');
  row.className = 'document-row';

  const top = document.createElement('div');
  top.className = 'document-row-top';

  const content = document.createElement('div');
  content.className = 'document-row-content';
  content.innerHTML = `
    <div class="document-row-filename">${escapeHtml(doc.filename)}</div>
    <div class="document-row-meta">${formatFileSize(doc.size)} \u00b7 uploaded ${formatUploadDate(doc.uploadedAt)}</div>
  `;
  top.appendChild(content);

  const actions = document.createElement('div');
  actions.className = 'document-row-actions';

  const viewBtn = document.createElement('button');
  viewBtn.className = 'document-row-open-btn';
  viewBtn.textContent = 'View summary';
  actions.appendChild(viewBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'document-row-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    await deleteDocument(doc.id);
    showToast('Document deleted.');
    await renderDocumentsView(deck);
  });
  actions.appendChild(deleteBtn);

  top.appendChild(actions);
  row.appendChild(top);

  // The original file isn't kept (see saveDocument's doc comment in
  // db.js) — only its summary is, so "viewing a document" here means
  // reading the summary, not reopening the PDF itself.
  const summaryBox = document.createElement('div');
  summaryBox.className = 'document-row-summary';
  summaryBox.textContent = doc.summary || 'No summary available for this document.';
  summaryBox.style.display = 'none';
  row.appendChild(summaryBox);

  viewBtn.addEventListener('click', () => {
    const showing = summaryBox.style.display !== 'none';
    summaryBox.style.display = showing ? 'none' : '';
    viewBtn.textContent = showing ? 'View summary' : 'Hide summary';
  });

  return row;
}

function buildEmptyDecksState() {
  const empty = document.createElement('div');
  empty.className = 'empty-decks-state';
  empty.innerHTML = `
    <h2 class="empty-decks-heading">Welcome to Lernin</h2>
    <p class="empty-decks-explainer">A spaced repetition study app: you review small question-and-answer cards on a schedule that adapts to how well you know each one, so studying stays efficient instead of re-reading everything every time.</p>
    <p class="empty-decks-explainer">To get started: create a deck, then upload a PDF to it — Lernin turns it into cards you can review.</p>
    <button class="create-deck-btn">Create your first deck</button>
    <button class="empty-decks-help-btn">How does this all work? \u2192</button>
  `;
  empty.querySelector('.create-deck-btn').addEventListener('click', () => openDeckModal());
  empty.querySelector('.empty-decks-help-btn').addEventListener('click', () => renderHelpView());
  return empty;
}

/**
 * Shared create/edit form: title + territory/course name (free text —
 * territories are just courseTerritoryId strings; canvas.js groups by
 * whatever's typed here, no separate territory table needed).
 *
 * @param {object} [existingDeck] - pass to edit an existing deck (rename
 *        and/or move it to a different territory/course group) instead of
 *        creating a new one. Reassigning to a different territory clears
 *        any saved map drag position for it — see clearIslandPosition's
 *        doc comment for why a stale absolute position shouldn't carry
 *        over to a different territory.
 */
async function openDeckModal(existingDeck = null) {
  const existingDecks = await getAllDecks();
  const existingTerritories = Array.from(
    new Set(existingDecks.map((d) => d.courseTerritoryId).filter(Boolean))
  );
  const isEdit = !!existingDeck;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>${isEdit ? 'Edit deck' : 'New deck'}</h2>
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
      <button class="modal-save-btn">${isEdit ? 'Save' : 'Create'}</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const titleInput = modal.querySelector('.modal-title-input');
  const territoryInput = modal.querySelector('.modal-territory-input');

  if (isEdit) {
    titleInput.value = existingDeck.title;
    territoryInput.value = existingDeck.courseTerritoryId === 'uncategorized' ? '' : (existingDeck.courseTerritoryId || '');
  }
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

    if (isEdit) {
      const territoryChanged = territory !== (existingDeck.courseTerritoryId || 'uncategorized');
      await saveDeck({ ...existingDeck, title, courseTerritoryId: territory });
      if (territoryChanged) {
        await clearIslandPosition(existingDeck.id);
      }
    } else {
      await saveDeck({
        id: cryptoRandomId(),
        title,
        courseTerritoryId: territory,
        createdAt: Date.now()
      });
    }

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
//
// Branches on the configured provider: Claude/Gemini go through the normal
// network call to /api/generate-cards; 'manual' (or no config at all, e.g.
// first-time users) goes through the copy/paste flow instead, which never
// touches our backend.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Generation flow: upload -> generateCards() -> edit step -> commit
// pdf.js extraction itself lives wherever the "upload" UI triggers it
// (out of scope for this file — assume `extractedText` arrives already
// parsed client-side, per the spec's "nothing is uploaded to the server").
//
// Branches on the configured provider: Claude/Gemini go through the normal
// network call to /api/generate-cards; 'manual' (or no config at all, e.g.
// first-time users) goes through the copy/paste flow instead, which never
// touches our backend.
//
// `fileMeta` ({filename, size}) is only used to save a Documents entry once
// a summary is actually available — deliberately NOT stored ahead of time,
// and deliberately NOT storing the original file at all (see buildImportButton's
// comment: keeping every uploaded PDF in IndexedDB doesn't scale for a
// student uploading dozens of them across a term). If generation gets
// queued for offline retry or fails outright, no Documents entry is
// created for this upload — there's no summary to show yet, and wiring a
// summary update through the async retry path is more plumbing than this
// pass covers. The extracted text itself isn't lost either way (it's
// already in the offline generation queue, retried automatically).
// ---------------------------------------------------------------------------

export async function handleGeneration(extractedText, deckId, fileMeta = null) {
  const config = await getApiConfig();

  if (!config || config.provider === 'manual') {
    renderManualPasteView(extractedText, deckId, fileMeta);
    return;
  }

  showToast('Generating cards\u2026');
  const { cards, summary } = await generateCards(extractedText, deckId);
  if (cards.length > 0) {
    if (fileMeta) {
      await saveDocument({
        id: cryptoRandomId(),
        deckId,
        filename: fileMeta.filename,
        size: fileMeta.size,
        summary: summary || ''
      });
    }
    renderEditStep(cards, deckId);
  }
  // If cards.length === 0, either it was queued (offline) or errored —
  // wireGenerationEvents() below handles the toast either way.
}

// ---------------------------------------------------------------------------
// Manual ("paste into any AI") generation flow — for users without their
// own Claude/Gemini API key. Mirrors api/index.py's SYSTEM_PROMPT and card
// JSON shape so the output slots into the same edit/dedupe/commit path as
// the API-based flow, just entered by hand instead of over the network.
// ---------------------------------------------------------------------------

const MANUAL_PROMPT_INSTRUCTIONS = `You write flashcards from source text for spaced repetition study.

Rules:
- Minimum information principle: each card tests one atomic fact. No compound
  questions ("What is X and why does Y happen" is two cards, not one).
- Answers must be unambiguous — a grader could mark it right/wrong with no
  judgment call.
- Prefer cloze deletion ("type": "cloze") for definitions and lists, where the
  front contains {{c1::the answer}} inline. Use "basic" Q&A for everything else.
- Do not invent facts not present in the source text.
- Skip trivial or non-testable content (headers, page numbers, filler).
- Also write a "summary": 2-4 sentences capturing the key points of this
  text, written for a student reviewing right before an exam — dense and
  factual, not a restatement of the assignment/chapter structure.

Return ONLY valid JSON — no markdown formatting, no code fences, no
commentary before or after — in exactly this shape:
{"cards": [{"front": "...", "back": "...", "type": "basic"}, ...], "summary": "..."}

Here is the source text:
"""
{{TEXT}}
"""`;

function buildManualPrompt(text) {
  return MANUAL_PROMPT_INSTRUCTIONS.replace('{{TEXT}}', text);
}

/**
 * Fixes the single most common real-world way pasted "JSON" from a chat
 * model is invalid: literal, unescaped quote marks left inside a string
 * value (e.g. quoting source text that itself contains quotation marks —
 * scripture, dialogue, titles — without escaping them as \"). Scans
 * character-by-character tracking string state; when a quote appears
 * while already inside a string, it's treated as a legitimate terminator
 * only if the next non-whitespace character is one that can legally
 * follow a JSON string (`,` `:` `}` `]`, or end of text) — otherwise it's
 * content and gets escaped. Already-escaped quotes (\") are left alone.
 *
 * This is a heuristic, not a JSON grammar fix — it cannot distinguish
 * every possible malformed input from a correctly-escaped one with 100%
 * certainty, but it's deliberately conservative (only ever ADDS escapes,
 * never removes structure) and only ever tried as a fallback after a
 * plain JSON.parse on the same text has already failed.
 */
function repairUnescapedQuotes(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      const isTerminator = next === undefined || [',', ':', '}', ']'].includes(next);
      if (isTerminator) {
        result += ch;
        inString = false;
      } else {
        result += '\\"';
      }
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Pulls a JSON object/array out of arbitrary pasted text, trying — in
 * order — a fenced ```json block, a fenced ``` block with no language tag,
 * a balanced {...} span found anywhere in the text, and finally the raw
 * text as-is. Each candidate is tried against JSON.parse in turn.
 *
 * Why this many fallbacks: the first paste in a conversation is often
 * clean model output, but a *second* paste (this function's actual bug
 * report) tends to come from a chat that's already going — the AI adds a
 * sentence like "Sure, here's the JSON:" before the fence, or one after
 * it, which an anchored ^...$ fence match rejects outright even though
 * the JSON itself is perfectly valid.
 */
function extractJsonCandidate(rawText) {
  // Strip invisible/zero-width Unicode that Android clipboard commonly
  // inserts: BOM, ZWNJ, ZWJ, ZWSP, soft hyphen, directional marks, etc.
  // Non-breaking space -> regular space so JSON whitespace rules apply.
  // Curly/smart quotes (\u2018-\u201D) that are being used as JSON
  // structural string delimiters (i.e. the whole document was output by
  // an AI that auto-typographied its quotes) are normalised to straight
  // quotes — if they're prose content *inside* an already-delimited
  // string, JSON.parse handles them fine as regular Unicode characters.
  let t = rawText
    .replace(/\uFEFF|\u200B|\u200C|\u200D|\u00AD|\u200E|\u200F|\u202A-\u202E/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2018|\u2019/g, "'")
    // Only replace curly double-quotes when they appear to be structural
    // delimiters (immediately after : , [ { or at the very start of the
    // text), not when they're legitimately inside a string as prose.
    .replace(/(?<=[:,\[{\s]|^)\u201C/gm, '"')
    .replace(/\u201D(?=\s*[:,\]},\n]|$)/gm, '"');

  const trimmed = t.trim();
  const candidates = [];

  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonFence) candidates.push(jsonFence[1]);

  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence && anyFence[1] !== jsonFence?.[1]) candidates.push(anyFence[1]);

  // Balanced-brace scan — only straight double-quotes (U+0022) toggle
  // inString, since the normalization above converted any structural curly
  // quotes. Curly quotes that survived normalization are genuinely inside
  // prose string content and should not affect the depth counter.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '\u0022') { inString = !inString; continue; } // U+0022 straight " only
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }

  // Greedy span: grab the first { and the last } in the text. Simpler
  // than the brace-depth scanner and handles the common "preamble before
  // the JSON block" case cleanly when there are no nested objects in the
  // surrounding prose (the usual case for AI responses).
  const greedyMatch = trimmed.match(/\{[\s\S]*\}/);
  if (greedyMatch) candidates.push(greedyMatch[0]);

  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(repairUnescapedQuotes(candidate));
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function parseManualCards(rawText) {
  const parsed = extractJsonCandidate(rawText);
  if (parsed === undefined) {
    throw new Error('That doesn\u2019t look like valid JSON. Make sure you copied the model\u2019s full response, including the opening { and closing }.');
  }

  const rawCards = Array.isArray(parsed) ? parsed : parsed?.cards;
  if (!Array.isArray(rawCards)) {
    throw new Error('Expected a "cards" array in the pasted JSON.');
  }
  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';

  const cards = [];
  let skipped = 0;
  for (const c of rawCards) {
    const front = typeof c?.front === 'string' ? c.front.trim() : '';
    const back = typeof c?.back === 'string' ? c.back.trim() : '';
    const type = c?.type === 'cloze' ? 'cloze' : 'basic';

    // Only `front` is required. Cloze cards legitimately have an empty
    // `back` — the answer lives inline in `front` via {{c1::...}}, and
    // api/index.py's own Card schema has no non-empty constraint on `back`
    // either. Requiring both used to silently drop every cloze card a
    // pasted-in AI produced.
    if (!front) {
      skipped++;
      continue;
    }
    cards.push({ front, back, type });
  }

  return { cards, skipped, summary };
}

function renderManualPasteView(extractedText, deckId, fileMeta = null) {
  root.innerHTML = '';
  const prompt = buildManualPrompt(extractedText);

  const wrap = document.createElement('div');
  wrap.className = 'manual-paste-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Cancel';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = 'Generate with any AI';
  header.appendChild(heading);
  wrap.appendChild(header);

  const step1 = document.createElement('p');
  step1.className = 'manual-paste-step';
  step1.textContent = '1. Copy this prompt and paste it into ChatGPT, Claude.ai, Gemini, or any AI chat tool:';
  wrap.appendChild(step1);

  const promptBox = document.createElement('textarea');
  promptBox.className = 'manual-paste-prompt-box';
  promptBox.readOnly = true;
  promptBox.value = prompt;
  wrap.appendChild(promptBox);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'manual-paste-copy-btn';
  copyBtn.textContent = 'Copy prompt';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      showToast('Prompt copied.');
    } catch {
      promptBox.select();
      showToast('Couldn\u2019t auto-copy — the text is selected, copy it manually.');
    }
  });
  wrap.appendChild(copyBtn);

  if (prompt.length > 60000) {
    const warn = document.createElement('p');
    warn.className = 'manual-paste-warning';
    warn.textContent = 'This is a long prompt — some AI chat tools may truncate very long pastes. If generation looks incomplete, try a shorter excerpt.';
    wrap.appendChild(warn);
  }

  const step2 = document.createElement('p');
  step2.className = 'manual-paste-step';
  step2.textContent = '2. Paste the AI\u2019s JSON response here:';
  wrap.appendChild(step2);

  const responseBox = document.createElement('textarea');
  responseBox.className = 'manual-paste-response-box';
  responseBox.placeholder = '{"cards": [...]}';
  wrap.appendChild(responseBox);

  const parseBtn = document.createElement('button');
  parseBtn.type = 'button';
  parseBtn.className = 'manual-paste-parse-btn';
  parseBtn.textContent = 'Parse cards';
  parseBtn.addEventListener('click', async () => {
    if (!responseBox.value.trim()) {
      showToast('Paste the AI\u2019s response first.');
      return;
    }
    let result;
    try {
      result = parseManualCards(responseBox.value);
    } catch (err) {
      showToast(err.message);
      return;
    }
    if (result.cards.length === 0) {
      showToast('No usable cards found in that response.');
      return;
    }
    if (result.skipped > 0) {
      showToast(`Parsed ${result.cards.length} card(s), skipped ${result.skipped} incomplete entr${result.skipped === 1 ? 'y' : 'ies'}.`);
    }
    if (fileMeta) {
      await saveDocument({
        id: cryptoRandomId(),
        deckId,
        filename: fileMeta.filename,
        size: fileMeta.size,
        summary: result.summary || ''
      });
    }
    const deduped = await dedupeAgainstDeck(result.cards, deckId);
    renderEditStep(deduped, deckId);
  });
  wrap.appendChild(parseBtn);

  root.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Manual card creation — the only prior way to add a card was via PDF
// upload + AI/manual-paste generation. Supports all three card types;
// formula-specific fields and the relationship picker only apply to the
// 'formula' type, but relationships themselves are offered for every type
// (a basic card can legitimately relate to another one too).
// ---------------------------------------------------------------------------

function renderNewCardView(deck) {
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'new-card-view';

  const header = document.createElement('div');
  header.className = 'settings-view-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Cancel';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.textContent = `Add card to ${deck.title}`;
  header.appendChild(heading);
  wrap.appendChild(header);

  const form = document.createElement('form');
  form.className = 'new-card-form';

  // --- type selector ---
  const typeLabel = document.createElement('label');
  typeLabel.className = 'settings-form-label';
  typeLabel.textContent = 'Card type';
  form.appendChild(typeLabel);

  const typeRow = document.createElement('div');
  typeRow.className = 'settings-provider-row';
  const types = [
    { value: 'basic', label: 'Basic (Q&A)' },
    { value: 'cloze', label: 'Cloze' },
    { value: 'formula', label: 'Formula' }
  ];
  for (const t of types) {
    const optLabel = document.createElement('label');
    optLabel.className = 'settings-provider-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'card-type';
    radio.value = t.value;
    radio.checked = t.value === 'basic';
    radio.addEventListener('change', updateFieldVisibility);
    optLabel.appendChild(radio);
    optLabel.appendChild(document.createTextNode(` ${t.label}`));
    typeRow.appendChild(optLabel);
  }
  form.appendChild(typeRow);

  // --- front / back (always shown) ---
  const frontLabel = document.createElement('label');
  frontLabel.className = 'edit-step-field-label';
  frontLabel.textContent = 'Front';
  form.appendChild(frontLabel);
  const frontInput = document.createElement('textarea');
  frontInput.className = 'edit-step-textarea';
  frontInput.required = true;
  form.appendChild(frontInput);

  const backLabel = document.createElement('label');
  backLabel.className = 'edit-step-field-label';
  backLabel.textContent = 'Back';
  form.appendChild(backLabel);
  const backInput = document.createElement('textarea');
  backInput.className = 'edit-step-textarea';
  backInput.placeholder = '(optional for cloze \u2014 the answer can live inline in Front via {{c1::...}})';
  form.appendChild(backInput);

  // --- formula-specific fields (hidden unless type === formula) ---
  const formulaSection = document.createElement('div');
  formulaSection.className = 'new-card-formula-section';
  formulaSection.style.display = 'none';

  const formulaLabel = document.createElement('label');
  formulaLabel.className = 'edit-step-field-label';
  formulaLabel.textContent = 'Formula';
  formulaSection.appendChild(formulaLabel);
  const formulaInput = document.createElement('input');
  formulaInput.type = 'text';
  formulaInput.className = 'settings-api-key-input';
  formulaInput.placeholder = 'e.g. KE = \u00bdmv\u00b2';
  formulaSection.appendChild(formulaInput);

  const variablesLabel = document.createElement('label');
  variablesLabel.className = 'edit-step-field-label';
  variablesLabel.textContent = 'Variables';
  formulaSection.appendChild(variablesLabel);

  const variablesList = document.createElement('div');
  variablesList.className = 'new-card-variables-list';
  formulaSection.appendChild(variablesList);

  let variableRows = [];
  function addVariableRow() {
    const row = document.createElement('div');
    row.className = 'new-card-variable-row';
    const symbolInput = document.createElement('input');
    symbolInput.type = 'text';
    symbolInput.placeholder = 'symbol (e.g. m)';
    symbolInput.className = 'new-card-variable-symbol';
    const meaningInput = document.createElement('input');
    meaningInput.type = 'text';
    meaningInput.placeholder = 'meaning (e.g. mass, kg)';
    meaningInput.className = 'new-card-variable-meaning';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'new-card-variable-remove';
    removeBtn.textContent = '\u2715';
    removeBtn.addEventListener('click', () => {
      variableRows = variableRows.filter((r) => r !== row);
      row.remove();
    });
    row.appendChild(symbolInput);
    row.appendChild(meaningInput);
    row.appendChild(removeBtn);
    variablesList.appendChild(row);
    variableRows.push(row);
  }
  addVariableRow(); // start with one empty row

  const addVariableBtn = document.createElement('button');
  addVariableBtn.type = 'button';
  addVariableBtn.className = 'new-card-add-variable-btn';
  addVariableBtn.textContent = '+ Add variable';
  addVariableBtn.addEventListener('click', addVariableRow);
  formulaSection.appendChild(addVariableBtn);

  const assumptionsLabel = document.createElement('label');
  assumptionsLabel.className = 'edit-step-field-label';
  assumptionsLabel.textContent = 'Assumptions';
  formulaSection.appendChild(assumptionsLabel);
  const assumptionsInput = document.createElement('textarea');
  assumptionsInput.className = 'edit-step-textarea';
  formulaSection.appendChild(assumptionsInput);

  const mistakesLabel = document.createElement('label');
  mistakesLabel.className = 'edit-step-field-label';
  mistakesLabel.textContent = 'Common mistakes';
  formulaSection.appendChild(mistakesLabel);
  const mistakesInput = document.createElement('textarea');
  mistakesInput.className = 'edit-step-textarea';
  formulaSection.appendChild(mistakesInput);

  const applicationsLabel = document.createElement('label');
  applicationsLabel.className = 'edit-step-field-label';
  applicationsLabel.textContent = 'Applications';
  formulaSection.appendChild(applicationsLabel);
  const applicationsInput = document.createElement('textarea');
  applicationsInput.className = 'edit-step-textarea';
  formulaSection.appendChild(applicationsInput);

  form.appendChild(formulaSection);

  function updateFieldVisibility() {
    const type = form.querySelector('input[name="card-type"]:checked')?.value || 'basic';
    formulaSection.style.display = type === 'formula' ? '' : 'none';
    backInput.placeholder = type === 'cloze'
      ? '(optional \u2014 the answer can live inline in Front via {{c1::...}})'
      : '';
  }

  // --- relationships (available for every type) ---
  const relLabel = document.createElement('label');
  relLabel.className = 'edit-step-field-label';
  relLabel.textContent = 'Depends on / related cards (optional, can be in any deck)';
  form.appendChild(relLabel);

  const relSearchInput = document.createElement('input');
  relSearchInput.type = 'text';
  relSearchInput.className = 'settings-api-key-input';
  relSearchInput.placeholder = 'Search cards by their front text\u2026';
  form.appendChild(relSearchInput);

  const relResultsList = document.createElement('div');
  relResultsList.className = 'new-card-rel-results';
  form.appendChild(relResultsList);

  const relAttachedList = document.createElement('div');
  relAttachedList.className = 'new-card-rel-attached';
  form.appendChild(relAttachedList);

  let attachedRelationships = []; // { cardId, front, deckTitle, type }

  function renderAttachedRelationships() {
    relAttachedList.innerHTML = '';
    for (const rel of attachedRelationships) {
      const chip = document.createElement('div');
      chip.className = 'new-card-rel-chip';
      chip.innerHTML = `<span class="new-card-rel-chip-type">${rel.type === 'dependsOn' ? 'Depends on' : 'Related'}</span> ${escapeHtml(rel.front)} <span class="new-card-rel-chip-deck">(${escapeHtml(rel.deckTitle)})</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', () => {
        attachedRelationships = attachedRelationships.filter((r) => r !== rel);
        renderAttachedRelationships();
      });
      chip.appendChild(removeBtn);
      relAttachedList.appendChild(chip);
    }
  }

  let searchDebounce = null;
  relSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const query = relSearchInput.value.trim();
      relResultsList.innerHTML = '';
      if (!query) return;
      const results = await searchCardsByFront(query);
      for (const card of results) {
        if (attachedRelationships.some((r) => r.cardId === card.id)) continue;
        const row = document.createElement('div');
        row.className = 'new-card-rel-result-row';
        row.innerHTML = `<span>${escapeHtml(card.front)} <span class="new-card-rel-chip-deck">(${escapeHtml(card.deckTitle)})</span></span>`;
        const dependsBtn = document.createElement('button');
        dependsBtn.type = 'button';
        dependsBtn.textContent = '+ Depends on';
        dependsBtn.addEventListener('click', () => {
          attachedRelationships.push({ cardId: card.id, front: card.front, deckTitle: card.deckTitle, type: 'dependsOn' });
          renderAttachedRelationships();
        });
        const relatedBtn = document.createElement('button');
        relatedBtn.type = 'button';
        relatedBtn.textContent = '+ Related';
        relatedBtn.addEventListener('click', () => {
          attachedRelationships.push({ cardId: card.id, front: card.front, deckTitle: card.deckTitle, type: 'related' });
          renderAttachedRelationships();
        });
        row.appendChild(dependsBtn);
        row.appendChild(relatedBtn);
        relResultsList.appendChild(row);
      }
    }, 200);
  });

  wrap.appendChild(form);

  // --- save actions ---
  async function handleSave(addAnother) {
    const type = form.querySelector('input[name="card-type"]:checked')?.value || 'basic';
    const front = frontInput.value.trim();
    if (!front) {
      showToast('Front text is required.');
      frontInput.focus();
      return;
    }

    const cardData = {
      deckId: deck.id,
      front,
      back: backInput.value.trim(),
      type
    };
    if (type === 'formula') {
      cardData.formula = formulaInput.value.trim();
      cardData.variables = variableRows
        .map((row) => ({
          symbol: row.querySelector('.new-card-variable-symbol').value.trim(),
          meaning: row.querySelector('.new-card-variable-meaning').value.trim()
        }))
        .filter((v) => v.symbol || v.meaning);
      cardData.assumptions = assumptionsInput.value.trim();
      cardData.commonMistakes = mistakesInput.value.trim();
      cardData.applications = applicationsInput.value.trim();
    }

    const newCardId = await saveManualCard(cardData);
    for (const rel of attachedRelationships) {
      await addRelationship(newCardId, rel.cardId, rel.type);
    }

    showToast('Card added.');

    if (addAnother) {
      renderNewCardView(deck); // simplest reliable "reset the form" — re-render fresh
    } else {
      await renderDeckList();
    }
  }

  const actions = document.createElement('div');
  actions.className = 'settings-form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'commit-cards-btn';
  saveBtn.textContent = 'Save card';
  saveBtn.addEventListener('click', () => handleSave(false));
  actions.appendChild(saveBtn);

  const saveAndAddBtn = document.createElement('button');
  saveAndAddBtn.type = 'button';
  saveAndAddBtn.className = 'settings-remove-btn';
  saveAndAddBtn.textContent = 'Save & add another';
  saveAndAddBtn.addEventListener('click', () => handleSave(true));
  actions.appendChild(saveAndAddBtn);

  wrap.appendChild(actions);
  root.appendChild(wrap);
}

function renderEditStep(cards, deckId) {
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'edit-step';

  const header = document.createElement('div');
  header.className = 'edit-step-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'settings-view-back-btn';
  backBtn.textContent = '\u2190 Cancel';
  backBtn.addEventListener('click', () => renderDeckList());
  header.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.className = 'edit-step-heading';
  header.appendChild(heading);
  wrap.appendChild(header);

  const list = document.createElement('div');
  list.className = 'edit-step-list';

  // null = discarded (recoverable via Undo — nothing is destroyed until
  // "Add to deck" is actually clicked), not removed from the array.
  const editable = cards.map(c => ({ ...c }));

  function updateHeading() {
    const remaining = editable.filter(Boolean).length;
    heading.textContent = remaining === editable.length
      ? `Review ${editable.length} generated card${editable.length === 1 ? '' : 's'}`
      : `Review \u2014 ${remaining} of ${editable.length} will be added`;
  }

  editable.forEach((card, i) => {
    const row = document.createElement('div');
    row.className = 'edit-step-row';

    const rowHeader = document.createElement('div');
    rowHeader.className = 'edit-step-row-header';

    const typeBadge = document.createElement('span');
    typeBadge.className = `edit-step-type-badge edit-step-type-${card.type}`;
    typeBadge.textContent = card.type === 'cloze' ? 'Cloze' : 'Basic';
    rowHeader.appendChild(typeBadge);

    const discardBtn = document.createElement('button');
    discardBtn.className = 'edit-step-discard-btn';
    discardBtn.textContent = 'Discard';
    rowHeader.appendChild(discardBtn);

    row.appendChild(rowHeader);

    const frontLabel = document.createElement('label');
    frontLabel.className = 'edit-step-field-label';
    frontLabel.textContent = 'Front';
    row.appendChild(frontLabel);

    const frontInput = document.createElement('textarea');
    frontInput.className = 'edit-step-textarea';
    frontInput.value = card.front;
    frontInput.addEventListener('input', () => { editable[i].front = frontInput.value; });
    row.appendChild(frontInput);

    const backLabel = document.createElement('label');
    backLabel.className = 'edit-step-field-label';
    backLabel.textContent = 'Back';
    row.appendChild(backLabel);

    const backInput = document.createElement('textarea');
    backInput.className = 'edit-step-textarea';
    backInput.value = card.back;
    backInput.placeholder = card.type === 'cloze' ? '(optional \u2014 cloze answers live inline in Front)' : '';
    backInput.addEventListener('input', () => { editable[i].back = backInput.value; });
    row.appendChild(backInput);

    discardBtn.addEventListener('click', () => {
      const discarded = editable[i] !== null;
      editable[i] = discarded ? null : { front: frontInput.value, back: backInput.value, type: card.type };
      row.classList.toggle('edit-step-row-discarded', discarded);
      frontInput.disabled = discarded;
      backInput.disabled = discarded;
      discardBtn.textContent = discarded ? 'Undo' : 'Discard';
      updateHeading();
    });

    list.appendChild(row);
  });

  wrap.appendChild(list);
  updateHeading();

  const commitBtn = document.createElement('button');
  commitBtn.className = 'commit-cards-btn';
  commitBtn.textContent = 'Add to deck';
  commitBtn.addEventListener('click', async () => {
    const approved = editable.filter(Boolean);
    if (approved.length === 0) {
      showToast('Nothing to add \u2014 every card was discarded.');
      return;
    }
    await commitGeneratedCards(deckId, approved);
    showToast(`Added ${approved.length} card${approved.length === 1 ? '' : 's'}.`);
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
