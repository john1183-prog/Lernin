// app.js
// General UI orchestration + the flat list/grid deck view (the required
// accessibility fallback, built before canvas.js per the spec's build
// order). This is the ONLY view for now — canvas.js, when it exists, will
// call the same startStudySession() entry point this file uses, and will
// read the view-mode preference this file owns.

import { getAllDecks, saveDeck, getCardsByDeck, getCardsDueTodayOrEarlier, getDeckStateCounts, getReviewStats, getSuspendedCards, resetLeech, deleteCard, getApiConfig, saveApiConfig, clearApiConfig } from './db.js';
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

// ---------------------------------------------------------------------------
// Settings — lets the user bring their own Claude or Gemini API key for
// card generation, or use "Paste into any AI" mode if they don't have one.
// Stored client-side in IndexedDB (db.js's settings store); Claude/Gemini
// keys are sent to our backend per-request via headers, never persisted
// server-side — see api/index.py's _resolve_credentials(). Manual mode
// never talks to our backend at all — see renderManualPasteView().
// ---------------------------------------------------------------------------

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
  root.appendChild(wrap);
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
//
// Branches on the configured provider: Claude/Gemini go through the normal
// network call to /api/generate-cards; 'manual' (or no config at all, e.g.
// first-time users) goes through the copy/paste flow instead, which never
// touches our backend.
// ---------------------------------------------------------------------------

export async function handleGeneration(extractedText, deckId) {
  const config = await getApiConfig();

  if (!config || config.provider === 'manual') {
    renderManualPasteView(extractedText, deckId);
    return;
  }

  showToast('Generating cards\u2026');
  const cards = await generateCards(extractedText, deckId);
  if (cards.length > 0) {
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

Return ONLY valid JSON — no markdown formatting, no code fences, no
commentary before or after — in exactly this shape:
{"cards": [{"front": "...", "back": "...", "type": "basic"}, ...]}

Here is the source text:
"""
{{TEXT}}
"""`;

function buildManualPrompt(text) {
  return MANUAL_PROMPT_INSTRUCTIONS.replace('{{TEXT}}', text);
}

/**
 * Lenient parse of whatever a person pastes back from their AI tool of
 * choice: strips a wrapping ```json fence if present, accepts either
 * {"cards": [...]} or a bare [...] array, and drops (rather than throws on)
 * individual entries missing front/back — different tools are inconsistent
 * about exactly how strictly they follow the requested shape, and a whole
 * batch shouldn't fail over one bad entry.
 *
 * @returns {{cards: Array<{front: string, back: string, type: string}>, skipped: number}}
 */
function parseManualCards(rawText) {
  let cleaned = rawText.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('That doesn\u2019t look like valid JSON. Make sure you copied only the model\u2019s output, nothing else.');
  }

  const rawCards = Array.isArray(parsed) ? parsed : parsed?.cards;
  if (!Array.isArray(rawCards)) {
    throw new Error('Expected a "cards" array in the pasted JSON.');
  }

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

  return { cards, skipped };
}

function renderManualPasteView(extractedText, deckId) {
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
    const deduped = await dedupeAgainstDeck(result.cards, deckId);
    renderEditStep(deduped, deckId);
  });
  wrap.appendChild(parseBtn);

  root.appendChild(wrap);
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
