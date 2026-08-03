/* ---------- Lernin — App Orchestrator ----------
   Home screen, bottom sheet, theme, view routing */

import {
  getDecks, getCardsDueTodayOrEarlier, getReviewStats,
  getTheme, saveTheme, addDeck, getCardsByDeck,
  getRelationshipsFrom, getRelationshipsTo, addRelationship,
  removeRelationship, getCard, getDeck, getApiConfig, saveApiConfig, clearApiConfig,
  getReminderSettings, setReminderEnabled, wipeAllData, saveDeck,
  clearIslandPosition, saveManualCard, searchCardsByFront, searchCardsByAnswer,
  exportDeckData, importDeckData, getDocumentsByDeck, getDashboardStats, deleteDocument,
  getSetting, saveSetting
} from './db.js';
import { startStudySession } from './study.js';
import { initCanvasView, openDeckOnMap } from './canvas.js';
import { renderManualJSONImport } from './manual-json-import.js';
import { extractTextFromPdf } from './pdf-extract.js';
import { generateCards, commitGeneratedCards } from './api.js';

const root = document.getElementById('root');
const LONG_PRESS_MS = 500;

/* ---------- Theme ---------- */
let systemThemeListener = null;
const themeMediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

async function initTheme() {
  try {
    const saved = await getTheme();
    applyTheme(saved);
    setupThemeListener(saved);
  } catch (err) {
    console.error('Failed to init theme:', err);
  }
}

function applyTheme(theme) {
  let effective = theme;
  if (theme === 'system' && themeMediaQuery) {
    effective = themeMediaQuery.matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
}

function setupThemeListener(theme) {
  if (!themeMediaQuery) return;
  if (theme === 'system') {
    if (!systemThemeListener) {
      systemThemeListener = () => applyTheme('system');
      themeMediaQuery.addEventListener('change', systemThemeListener);
    }
  } else {
    if (systemThemeListener) {
      themeMediaQuery.removeEventListener('change', systemThemeListener);
      systemThemeListener = null;
    }
  }
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const order = { system: 'light', light: 'dark', dark: 'system' };
  const next = order[current] || 'system';
  applyTheme(next);
  setupThemeListener(next);
  saveTheme(next).catch(err => console.error('Failed to save theme:', err));
}

/* ---------- Font ---------- */
const FONT_OPTIONS = [
  { value: 'default', label: 'Default', stack: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { value: 'serif', label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
  { value: 'mono', label: 'Monospace', stack: "'SF Mono', 'Courier New', monospace" },
  { value: 'clean', label: 'Clean', stack: "'Helvetica Neue', Arial, sans-serif" }
];

async function initFont() {
  try {
    const saved = await getSetting('fontFamily');
    applyFont(saved || 'default');
  } catch (err) {
    console.error('Failed to init font:', err);
  }
}

function applyFont(fontKey) {
  const option = FONT_OPTIONS.find(f => f.value === fontKey) || FONT_OPTIONS[0];
  document.documentElement.style.setProperty('--font-body', option.stack);
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

/* ---------- Utilities ---------- */
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str ?? '').replace(/"/g, '&quot;');
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadDate(ts) {
  if (!ts) return 'unknown date';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/* ---------- Routing ---------- */
export function navigate(path) {
  window.location.hash = path;
}

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    navigate('/');
  }
}

async function handleRoute() {
  const path = window.location.hash.slice(1) || '/';
  const [_, route, id] = path.split('/');

  document.querySelectorAll('.sheet-backdrop, .sheet').forEach(el => el.remove());

  switch (route) {
    case '/': await renderDeckList(); break;
    case 'settings': await renderSettings(); break;
    case 'help': renderHelp(); break;
    case 'stats': await renderStats(); break;
    case 'study': enterStudy(id); break;
    case 'cards': await renderCardBrowser(id); break;
    case 'map': if (id) enterConceptGraph(id); else enterMap(); break;
    case 'documents': await renderDocuments(id); break;
    case 'new-card': await renderNewCardForm(id); break;
    default: await renderDeckList();
  }
}

/* ---------- Home Screen ---------- */
export async function renderDeckList() {
  root.innerHTML = '';
  root.style.padding = '0';

  let decks, dueCards, stats;
  try {
    [decks, dueCards, stats] = await Promise.all([
      getDecks(),
      getCardsDueTodayOrEarlier(),
      getReviewStats()
    ]);
  } catch (err) {
    showToast('Failed to load dashboard.', 5000);
    console.error(err);
    return;
  }

  const viewMode = localStorage.getItem('deckViewMode') || 'list';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="app-header-title">Lernin</div>
    <div class="app-header-actions">
      <button class="icon-btn" id="viewToggle" aria-label="Change view">☰</button>
      <button class="icon-btn" id="importBtn" aria-label="Import deck">📥</button>
      <button class="icon-btn" id="mapBtn" aria-label="Map view">🗺️</button>
      <button class="icon-btn" id="helpBtn" aria-label="Help">❓</button>
      <button class="icon-btn" id="themeToggle" aria-label="Toggle theme">🌓</button>
      <button class="icon-btn" id="settingsBtn" aria-label="Settings">⚙️</button>
    </div>
  `;
  root.appendChild(header);

  header.querySelector('#helpBtn').addEventListener('click', () => navigate('/help'));
  header.querySelector('#themeToggle').addEventListener('click', cycleTheme);
  header.querySelector('#settingsBtn').addEventListener('click', () => navigate('/settings'));
  header.querySelector('#importBtn').addEventListener('click', triggerDeckImport);
  header.querySelector('#mapBtn').addEventListener('click', () => navigate('/map'));

  header.querySelector('#viewToggle').addEventListener('click', () => {
    const modes = ['list', 'grid', 'horizontal'];
    const current = localStorage.getItem('deckViewMode') || 'list';
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    localStorage.setItem('deckViewMode', next);
    renderDeckList();
  });

  const dueToday = dueCards.length;
  const streak = stats.currentStreak || 0;

  if (dueToday > 0) {
    const hero = document.createElement('div');
    hero.className = 'hero-cta';
    hero.innerHTML = `
      <div class="hero-cta-title">${dueToday} card${dueToday !== 1 ? 's' : ''} due today</div>
      <div class="hero-cta-sub">${streak > 0 ? `🔥 ${streak}-day streak` : 'Start building your streak'}</div>
      <button class="hero-cta-btn" id="heroStudy">Study now</button>
    `;
    root.appendChild(hero);
    hero.querySelector('#heroStudy').addEventListener('click', () => navigate('/study/all'));
  }

  if (dueToday > 0 || streak > 0 || stats.totalReviews > 0) {
    const strip = document.createElement('div');
    strip.className = 'stats-strip';
    strip.innerHTML = `
      <div class="stat-item"><span class="stat-value">🔥${streak}</span>day streak</div>
      <div class="stat-item"><span class="stat-value">📚${dueToday}</span>due</div>
      <a href="#" class="stat-link" id="viewStats">View full statistics →</a>
    `;
    root.appendChild(strip);
    strip.querySelector('#viewStats').addEventListener('click', (e) => {
      e.preventDefault();
      navigate('/stats');
    });
  }

  const list = document.createElement('div');
  list.className = 'deck-list';

  if (decks.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📚</div>
        <div class="empty-state-title">No decks yet</div>
        <div class="empty-state-text">Create a deck or import a PDF to get started with active recall.</div>
        <div class="empty-state-actions">
          <button class="btn-secondary" id="emptyImportBtn">📥 Import deck</button>
          <button class="btn-secondary" id="emptyHelpBtn">❓ How Lernin works</button>
        </div>
      </div>
    `;
    list.querySelector('#emptyImportBtn').addEventListener('click', triggerDeckImport);
    list.querySelector('#emptyHelpBtn').addEventListener('click', () => navigate('/help'));
  } else {
    for (const deck of decks) {
      const tile = await buildDeckTile(deck);
      list.appendChild(tile);
    }
  }

  if (viewMode === 'grid') {
    list.style.display = 'grid';
    list.style.gridTemplateColumns = '1fr 1fr';
    list.style.gap = 'var(--space-sm)';
    list.style.padding = '0 var(--space-md)';
  } else if (viewMode === 'horizontal') {
    list.style.display = 'flex';
    list.style.overflowX = 'auto';
    list.style.gap = 'var(--space-sm)';
    list.style.padding = '0 var(--space-md)';
    list.style.flexWrap = 'nowrap';
    for (const tile of list.children) {
      if (!tile.classList.contains('empty-state')) {
        tile.style.flexShrink = '0';
        tile.style.width = '160px';
      }
    }
  } else {
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = 'var(--space-sm)';
    list.style.padding = '0 var(--space-md)';
  }

  root.appendChild(list);

  const newBtn = document.createElement('button');
  newBtn.className = 'btn-secondary';
  newBtn.style.cssText = 'margin: var(--space-md); width: calc(100% - var(--space-md)*2);';
  newBtn.innerHTML = '+ New deck';
  newBtn.addEventListener('click', () => renderNewDeckForm());
  root.appendChild(newBtn);

  renderMath(root);
}

async function buildDeckTile(deck) {
  const cards = await getCardsByDeck(deck.id);
  const now = Date.now();

  const due = cards.filter(c => !c.suspended && new Date(c.due_date).getTime() <= now).length;
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
      <div style="display:flex;align-items:center;gap:8px;">
        ${due > 0 ? `<span class="deck-tile-badge">${due} due</span>` : ''}
        <button class="deck-menu-btn" aria-label="Open actions">⋮</button>
      </div>
    </div>
    <div class="deck-tile-bar">
      <div class="deck-tile-bar-fill" style="width:${masteryPct}%"></div>
    </div>
  `;

  const menuBtn = tile.querySelector('.deck-menu-btn');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openBottomSheet(deck);
  });

  let tileLongPressTimer = null;
  let tileIsLongPress = false;

  tile.addEventListener('click', () => {
    if (!tileIsLongPress) navigate(`/study/${deck.id}`);
  });

  tile.addEventListener('pointerdown', (e) => {
    tileIsLongPress = false;
    tileLongPressTimer = setTimeout(() => {
      tileIsLongPress = true;
      openBottomSheet(deck);
    }, LONG_PRESS_MS);
  });

  const clearTimer = () => clearTimeout(tileLongPressTimer);
  tile.addEventListener('pointerup', clearTimer);
  tile.addEventListener('pointerleave', clearTimer);
  tile.addEventListener('pointercancel', clearTimer);
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
    { label: 'Study', icon: '▶️', primary: true, action: () => navigate(`/study/${deck.id}`) },
    { label: 'Import PDF', icon: '📄', action: () => renderPDFImport(deck.id) },
    { label: '+ Card', icon: '➕', action: () => navigate(`/new-card/${deck.id}`) },
    { label: 'Cards', icon: '🃏', action: () => navigate(`/cards/${deck.id}`) },
    { label: 'Concept Map', icon: '🕸️', action: () => navigate(`/map/${deck.id}`) },
    { label: 'Documents', icon: '📑', action: () => navigate(`/documents/${deck.id}`) },
    { label: 'Edit', icon: '✏️', action: () => renderDeckEdit(deck) },
    { label: 'Export', icon: '⬆️', action: () => exportDeck(deck.id) },
  ];

  let html = '<div class="sheet-handle"></div>';
  actions.forEach((a, i) => {
    if (i === 4) html += '<div class="sheet-divider"></div>';
    html += `
      <button class="sheet-action ${a.primary ? 'is-primary' : ''}">
        <span class="sheet-action-icon">${a.icon}</span>
        ${escapeHtml(a.label)}
      </button>
    `;
  });
  sheet.innerHTML = html;
  document.body.appendChild(sheet);

  const focusable = sheet.querySelectorAll('button');
  if (focusable.length) focusable[0].focus();

  let isClosing = false;
  function closeSheet() {
    if (isClosing) return;
    isClosing = true;
    document.removeEventListener('keydown', trapKeys);
    sheet.style.animation = 'slideDown 0.25s ease forwards';
    backdrop.style.animation = 'fadeIn 0.2s ease reverse forwards';
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
    }, 250);
  }

  function trapKeys(e) {
    if (e.key === 'Escape') {
      closeSheet();
    } else if (e.key === 'Tab' && focusable.length > 0) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  document.addEventListener('keydown', trapKeys);

  backdrop.addEventListener('click', closeSheet);
  const handle = sheet.querySelector('.sheet-handle');
  if (handle) handle.addEventListener('click', closeSheet);

  sheet.querySelectorAll('.sheet-action').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      closeSheet();
      actions[i].action();
    });
  });

  let startY = 0;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientY - startY > 80) closeSheet();
  });
}

/* ---------- Views ---------- */
function enterStudy(deckId) {
  root.innerHTML = '';
  const targetId = deckId === 'all' ? null : deckId;
  startStudySession(root, { deckId: targetId });
}

function enterConceptGraph(deckId) {
  // Absorbed into the spatial map — open at L2 for this deck
  root.innerHTML = '';
  openDeckOnMap(root, deckId, { onExit: () => navigate('/') });
}

function enterMap() {
  root.innerHTML = '';
  initCanvasView(root, { onExit: () => navigate('/') });
}

async function renderSettings() {
  let existing, reminderSettings;
  try {
    existing = await getApiConfig();
    reminderSettings = await getReminderSettings();
  } catch (err) {
    showToast('Failed to load settings.', 5000);
    return navigate('/');
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.className = 'settings-view';
  wrap.style.cssText = 'padding:0 0 var(--space-2xl); max-width:560px; margin:0 auto;';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="settingsBack" aria-label="Back">←</button>
    <div class="app-header-title">Settings</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#settingsBack').addEventListener('click', goBack);

  const intro = document.createElement('p');
  intro.style.cssText = 'padding:0 var(--space-md); margin:var(--space-md) 0; color:var(--ink-secondary); font-size:14px; line-height:1.6;';
  intro.textContent = 'Choose how you\'d like to generate cards. Bring your own Claude or Gemini API key for one-tap generation, or use "Paste into any AI" if you don\'t have a key — no key is stored or sent anywhere except directly to the provider you choose at the moment you generate cards.';
  wrap.appendChild(intro);

  const form = document.createElement('form');
  form.style.cssText = 'padding:0 var(--space-md);';

  const providerLabel = document.createElement('div');
  providerLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:8px;';
  providerLabel.textContent = 'Provider';
  form.appendChild(providerLabel);

  const providerRow = document.createElement('div');
  providerRow.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:var(--space-md);';

  const providers = [
    { value: 'claude', label: 'Claude (Anthropic)' },
    { value: 'gemini', label: 'Gemini (Google)' },
    { value: 'manual', label: 'Paste into any AI (no key needed)' }
  ];
  const currentProvider = existing?.provider || 'manual';

  for (const p of providers) {
    const optionLabel = document.createElement('label');
    optionLabel.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--surface); border-radius:var(--radius-md); cursor:pointer; box-shadow:var(--shadow-sm);';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'provider';
    radio.value = p.value;
    radio.checked = p.value === currentProvider;
    radio.addEventListener('change', updateKeyFieldVisibility);
    optionLabel.appendChild(radio);
    optionLabel.appendChild(document.createTextNode(p.label));
    providerRow.appendChild(optionLabel);
  }
  form.appendChild(providerRow);

  const keyLabel = document.createElement('div');
  keyLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:8px;';
  keyLabel.textContent = 'API key';
  form.appendChild(keyLabel);

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = existing?.apiKey ? '•••••••• (saved — enter a new key to replace it)' : 'Paste your API key';
  keyInput.style.cssText = 'width:100%; padding:12px 14px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:15px; margin-bottom:8px; box-sizing:border-box;';
  form.appendChild(keyInput);

  const keyHelp = document.createElement('p');
  keyHelp.style.cssText = 'font-size:13px; color:var(--ink-muted); margin-bottom:var(--space-md); line-height:1.5;';
  keyHelp.innerHTML = 'Get a key from console.anthropic.com (Claude) or aistudio.google.com (Gemini).';
  form.appendChild(keyHelp);

  const manualNote = document.createElement('p');
  manualNote.style.cssText = 'font-size:13px; color:var(--ink-muted); margin-bottom:var(--space-md); line-height:1.5; display:none;';
  manualNote.textContent = 'No key needed. When you generate cards, you\'ll get a prompt to copy into ChatGPT, Claude.ai, Gemini, etc., and a box to paste the result back in.';
  form.appendChild(manualNote);

  function updateKeyFieldVisibility() {
    const provider = form.querySelector('input[name="provider"]:checked')?.value || 'manual';
    const isManual = provider === 'manual';
    keyLabel.style.display = isManual ? 'none' : '';
    keyInput.style.display = isManual ? 'none' : '';
    keyHelp.style.display = isManual ? 'none' : '';
    manualNote.style.display = isManual ? '' : 'none';
  }
  updateKeyFieldVisibility();

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:10px; margin-bottom:var(--space-xl);';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn-primary';
  saveBtn.style.cssText = 'flex:1; padding:14px; border:none; border-radius:var(--radius-md); background:var(--accent); color:white; font-size:15px; font-weight:600; cursor:pointer;';
  saveBtn.textContent = 'Save';
  actions.appendChild(saveBtn);

  if (existing) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.style.cssText = 'padding:14px 16px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:14px; cursor:pointer; box-shadow:var(--shadow-sm);';
    removeBtn.textContent = 'Remove key';
    removeBtn.addEventListener('click', async () => {
      await clearApiConfig();
      showToast('Settings cleared.');
      await renderSettings();
    });
    actions.appendChild(removeBtn);
  }
  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const provider = form.querySelector('input[name="provider"]:checked')?.value || 'manual';
    if (provider === 'manual') {
      await saveApiConfig({ provider, apiKey: '' });
      showToast('Settings saved.');
      return renderSettings();
    }
    const apiKey = keyInput.value.trim() || (existing?.provider === provider ? existing?.apiKey : '');
    if (!apiKey) {
      showToast('Enter an API key to save.');
      return;
    }
    await saveApiConfig({ provider, apiKey });
    showToast('Settings saved.');
    await renderSettings();
  });

  wrap.appendChild(form);

  /* Appearance section with font selector */
  const appearanceSection = makeSection('Appearance');
  const fontLabel = document.createElement('div');
  fontLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:8px;';
  fontLabel.textContent = 'Font';
  appearanceSection.appendChild(fontLabel);

  const fontRow = document.createElement('div');
  fontRow.className = 'font-selector';
  const currentFont = (await getSetting('fontFamily')) || 'default';

  for (const f of FONT_OPTIONS) {
    const opt = document.createElement('label');
    opt.className = 'font-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'fontFamily';
    radio.value = f.value;
    radio.checked = f.value === currentFont;
    opt.appendChild(radio);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = f.label;
    nameSpan.style.fontFamily = f.stack;
    opt.appendChild(nameSpan);
    fontRow.appendChild(opt);
  }
  appearanceSection.appendChild(fontRow);

  fontRow.querySelectorAll('input[name="fontFamily"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      const value = fontRow.querySelector('input[name="fontFamily"]:checked')?.value || 'default';
      await saveSetting('fontFamily', value);
      applyFont(value);
      showToast('Font updated.');
    });
  });

  wrap.appendChild(appearanceSection);

  const reminderSection = makeSection('Study reminders');
  const reminderIntro = document.createElement('p');
  reminderIntro.style.cssText = 'font-size:13px; color:var(--ink-muted); margin-bottom:12px; line-height:1.5;';
  reminderIntro.textContent = 'If you haven\'t studied by evening, Lernin can show a local reminder — at most once a day, only while the app has been opened that day. This isn\'t true push notification.';
  reminderSection.appendChild(reminderIntro);

  const reminderLabel = document.createElement('label');
  reminderLabel.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--surface); border-radius:var(--radius-md); cursor:pointer; box-shadow:var(--shadow-sm);';
  const reminderToggle = document.createElement('input');
  reminderToggle.type = 'checkbox';
  reminderToggle.checked = reminderSettings.enabled;
  reminderLabel.appendChild(reminderToggle);
  reminderLabel.appendChild(document.createTextNode(' Show evening study reminders'));
  reminderSection.appendChild(reminderLabel);

  reminderToggle.addEventListener('change', async () => {
    if (reminderToggle.checked) {
      if (typeof Notification === 'undefined') {
        showToast('This browser doesn\'t support notifications.');
        reminderToggle.checked = false;
        return;
      }
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        showToast('Notification permission was not granted.');
        reminderToggle.checked = false;
        return;
      }
    }
    await setReminderEnabled(reminderToggle.checked);
    showToast(reminderToggle.checked ? 'Reminders on.' : 'Reminders off.');
  });
  wrap.appendChild(reminderSection);

  const storageSection = makeSection('Storage');
  const storageUsageText = document.createElement('p');
  storageUsageText.style.cssText = 'font-size:13px; color:var(--ink-muted); margin-bottom:12px;';
  storageUsageText.textContent = 'Checking storage usage…';
  storageSection.appendChild(storageUsageText);

  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage, quota }) => {
      if (typeof usage === 'number' && typeof quota === 'number' && quota > 0) {
        const pct = Math.round((usage / quota) * 100);
        storageUsageText.textContent = `Using ${formatFileSize(usage)} of ${formatFileSize(quota)} available (${pct}%).`;
      } else {
        storageUsageText.textContent = 'Storage usage isn\'t available in this browser.';
      }
    }).catch(() => {
      storageUsageText.textContent = 'Storage usage isn\'t available in this browser.';
    });
  }

  const reloadIntro = document.createElement('p');
  reloadIntro.style.cssText = 'font-size:13px; color:var(--ink-muted); margin-bottom:12px; line-height:1.5;';
  reloadIntro.textContent = 'If a new version was deployed but the app still looks old, use Hard reload. Your decks and cards are untouched.';
  storageSection.appendChild(reloadIntro);

  const storageBtnRow = document.createElement('div');
  storageBtnRow.style.cssText = 'display:flex; gap:10px; margin-bottom:12px;';

  const hardReloadBtn = document.createElement('button');
  hardReloadBtn.type = 'button';
  hardReloadBtn.style.cssText = 'flex:1; padding:12px 16px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:14px; font-weight:500; cursor:pointer; box-shadow:var(--shadow-sm);';
  hardReloadBtn.textContent = 'Hard reload';
  hardReloadBtn.addEventListener('click', async () => {
    hardReloadBtn.disabled = true;
    hardReloadBtn.textContent = 'Reloading…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch {}
    window.location.href = `${window.location.pathname}?_r=${Date.now()}`;
  });
  storageBtnRow.appendChild(hardReloadBtn);
  storageSection.appendChild(storageBtnRow);
  wrap.appendChild(storageSection);

  const dangerSection = makeSection('Danger zone');
  const dangerIntro = document.createElement('p');
  dangerIntro.style.cssText = 'font-size:13px; color:var(--ink-muted); margin-bottom:12px; line-height:1.5;';
  dangerIntro.textContent = 'Permanently deletes every deck, card, and review history on this device. This cannot be undone.';
  dangerSection.appendChild(dangerIntro);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.style.cssText = 'padding:12px 16px; border:none; border-radius:var(--radius-md); background:var(--danger-soft); color:var(--danger); font-size:14px; font-weight:600; cursor:pointer;';
  resetBtn.textContent = 'Reset everything…';
  dangerSection.appendChild(resetBtn);

  const confirmWrap = document.createElement('div');
  confirmWrap.style.cssText = 'display:none; margin-top:12px;';
  confirmWrap.innerHTML = `
    <p style="font-size:13px; color:var(--ink-muted); margin-bottom:8px;">Type RESET to confirm:</p>
    <input type="text" id="resetConfirmInput" placeholder="RESET" style="width:100%; padding:10px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; margin-bottom:8px; box-sizing:border-box;">
    <div style="display:flex; gap:8px;">
      <button type="button" id="resetCancelBtn" style="flex:1; padding:10px; border:none; border-radius:var(--radius-sm); background:var(--surface); color:var(--ink-secondary); font-size:14px; cursor:pointer;">Cancel</button>
      <button type="button" id="resetConfirmBtn" disabled style="flex:1; padding:10px; border:none; border-radius:var(--radius-sm); background:var(--danger); color:white; font-size:14px; font-weight:600; cursor:pointer; opacity:0.5;">Permanently delete everything</button>
    </div>
  `;
  dangerSection.appendChild(confirmWrap);

  resetBtn.addEventListener('click', () => {
    confirmWrap.style.display = confirmWrap.style.display === 'none' ? 'block' : 'none';
  });

  const confirmInput = confirmWrap.querySelector('#resetConfirmInput');
  const confirmBtn = confirmWrap.querySelector('#resetConfirmBtn');
  confirmInput.addEventListener('input', () => {
    const ok = confirmInput.value.trim() === 'RESET';
    confirmBtn.disabled = !ok;
    confirmBtn.style.opacity = ok ? '1' : '0.5';
  });
  confirmWrap.querySelector('#resetCancelBtn').addEventListener('click', () => {
    confirmWrap.style.display = 'none';
    confirmInput.value = '';
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.5';
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    try {
      await wipeAllData();
      window.location.hash = '';
      window.location.reload();
    } catch (err) {
      showToast(err.message || 'Reset failed.', 5000);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Permanently delete everything';
    }
  });

  wrap.appendChild(dangerSection);
  root.appendChild(wrap);

  function makeSection(title) {
    const section = document.createElement('div');
    section.style.cssText = 'padding:0 var(--space-md); margin-bottom:var(--space-xl);';
    const h = document.createElement('h3');
    h.style.cssText = 'font-size:15px; font-weight:600; color:var(--ink); margin-bottom:10px;';
    h.textContent = title;
    section.appendChild(h);
    return section;
  }
}

function renderHelp() {
  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.className = 'help-view';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="helpBack" aria-label="Back">←</button>
    <div class="app-header-title">Help</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#helpBack').addEventListener('click', goBack);

  // ---- Hero ----
  const hero = document.createElement('div');
  hero.className = 'help-hero';
  hero.innerHTML = `
    <div class="help-hero-kicker">You already know the pain</div>
    <h1 class="help-hero-title">Stop rereading. Start remembering.</h1>
    <p class="help-hero-lead">
      Lernin is a study app built for the version of you that is drowning in PDFs,
      highlighting entire chapters, and still blanking in the exam hall.
      It combines two things that actually work:
      <strong>spaced repetition</strong> (so you review the right card at the right time)
      and a <strong>Memory Palace</strong> map based on the <strong>Method of Loci</strong>
      (so your brain can hang knowledge on places, not just lists).
    </p>
    <p class="help-hero-lead help-hero-lead-soft">
      Everything runs on your device. Your decks, grades, and streaks stay yours.
      This page is the field manual — use it once, then go study.
    </p>
  `;
  wrap.appendChild(hero);

  // ---- TOC ----
  const toc = document.createElement('nav');
  toc.className = 'help-toc';
  toc.setAttribute('aria-label', 'Help sections');
  toc.innerHTML = `
    <a href="#help-engines">The two engines</a>
    <a href="#help-philosophy">Philosophy</a>
    <a href="#help-guide">How to use every part</a>
    <a href="#help-faq">FAQ</a>
  `;
  wrap.appendChild(toc);

  // ---- Engines ----
  const engines = document.createElement('section');
  engines.className = 'help-section';
  engines.id = 'help-engines';
  engines.innerHTML = `
    <h2 class="help-section-title">The two engines</h2>
    <div class="help-cards">
      <article class="help-card">
        <div class="help-card-icon">⏱</div>
        <h3>Spaced repetition (FSRS)</h3>
        <p>
          You grade each card <em>Again / Hard / Good / Easy</em>. Lernin uses an
          FSRS scheduler so hard cards come back sooner and easy ones wait longer.
          You are not “re-reading notes.” You are training retrieval — the skill exams actually test.
        </p>
        <p>
          Honest grades matter more than perfect streaks. If you peeked, hit <strong>Again</strong>.
          The algorithm only works if you tell it the truth.
        </p>
      </article>
      <article class="help-card">
        <div class="help-card-icon">🏛️</div>
        <h3>Memory Palace (Method of Loci)</h3>
        <p>
          The map is not decoration. <strong>Method of Loci</strong> is the ancient trick of
          placing ideas in imaginary places so you can walk the path later and pull them back.
          In Lernin, decks are islands, cards are nodes you can drag, and landmarks are rooms
          in your palace (“Fundamentals”, “Edge cases”, “Formula wall”).
        </p>
        <p>
          Zoom in, arrange cards on purpose, draw study paths, then review <em>on the map</em>
          so position and meaning reinforce each other.
        </p>
      </article>
    </div>
  `;
  wrap.appendChild(engines);

  // ---- Philosophy ----
  const phil = document.createElement('section');
  phil.className = 'help-section';
  phil.id = 'help-philosophy';
  phil.innerHTML = `
    <h2 class="help-section-title">Philosophy</h2>
    <ul class="help-philosophy-list">
      <li><strong>Retrieval over recognition.</strong> Highlighting feels productive. It is not. Flipping a card and failing is progress.</li>
      <li><strong>Your map, your memory.</strong> When you place a card on purpose, you encode a second handle on that idea. Use it.</li>
      <li><strong>Offline first.</strong> Study on a plane. No account required for the core loop.</li>
      <li><strong>You own the bill for AI.</strong> Bring your own Claude/Gemini key, or paste into any AI. Lernin is not farming your notes on a mystery server.</li>
      <li><strong>Explain it back.</strong> After Good/Easy, the Teach-it prompt is optional — but saying it in your own words is how knowledge sticks.</li>
      <li><strong>Leeches are signals, not shame.</strong> A card you keep missing gets suspended so it stops poisoning the queue. Fix it later on purpose.</li>
    </ul>
  `;
  wrap.appendChild(phil);

  // ---- How to use ----
  const guideSections = [
    {
      title: 'Home & decks',
      body: `
        <p>Home lists your decks with due counts and mastery. Long-press (or use the sheet) a deck for actions.</p>
        <ul>
          <li><strong>Study</strong> — classic queue of due cards for that deck (or study everything due from the global flow).</li>
          <li><strong>Map (🗺️)</strong> in the header — territory view of all decks as islands.</li>
          <li><strong>Import (📥)</strong> — load a previously exported deck backup.</li>
          <li><strong>Stats / Settings / Help</strong> — top icons. Settings is where you pick AI mode and theme.</li>
        </ul>
        <p><em>Max tip:</em> Keep decks small and thematic (one course unit per deck). Giant mixed decks make the Memory Palace messy.</p>
      `
    },
    {
      title: 'Getting cards in (PDF, AI, manual)',
      body: `
        <p>Two honest paths:</p>
        <ol>
          <li><strong>Import PDF / AI generate</strong> from the deck sheet → extract text → generate cards → <em>review every card</em> before commit. Delete junk. Fix wording. You are the editor; the model is the intern.</li>
          <li><strong>+ Card</strong> — write front/back yourself. Use for formulas, definitions you keep missing, and exam traps.</li>
        </ol>
        <p>In Settings choose:</p>
        <ul>
          <li><strong>Your Claude or Gemini API key</strong> — one-tap generation. Key stays on device; sent only to that provider when you generate.</li>
          <li><strong>Paste into any AI</strong> — copy the prompt, paste JSON back. Free, slightly more friction.</li>
        </ul>
        <p><em>Max tip:</em> Prefer fewer sharp cards over hundreds of vague ones. One idea per card.</p>
      `
    },
    {
      title: 'Study session (classic queue)',
      body: `
        <p>Question first. Struggle. Then flip. Then grade.</p>
        <ul>
          <li><strong>Again</strong> — blank or wrong.</li>
          <li><strong>Hard</strong> — correct, but slow or shaky.</li>
          <li><strong>Good</strong> — solid recall.</li>
          <li><strong>Easy</strong> — trivial; schedule far out.</li>
        </ul>
        <p><strong>Explain (💡)</strong> shows a hint before you flip. <strong>Teach-it</strong> after Good/Easy asks you to explain in your own words — do it when the concept is core to the course.</p>
        <p><strong>Undo (↩ or U)</strong> if you fat-fingered a grade. Press <strong>?</strong> in session for the full shortcut list.</p>
        <p>Keyboard: Space/Enter/→ flip · ← hint (before flip) or Again (after) · 1–4 grades · Esc ends session.</p>
        <p>Swipe: before flip ← hint, → flip · after flip ← Again, → Easy, ↑ Hard, ↓ Good.</p>
      `
    },
    {
      title: 'The map — your Memory Palace',
      body: `
        <p>Open <strong>🗺️ Map</strong>. Three zoom levels (Method of Loci, digital):</p>
        <ol>
          <li><strong>L1 Territories</strong> — courses/groups as regions; decks as islands. Drag islands; positions save.</li>
          <li><strong>L2 Deck view</strong> — tap an island. Cards become nodes. Drag them. Add <strong>landmarks</strong> (named zones). Draw <strong>relationship lines</strong> (depends-on / related). Build a <strong>study path</strong> by tapping nodes in order.</li>
          <li><strong>L3 Card detail</strong> — tap a node for full front/back/formula and a button to study that card.</li>
        </ol>
        <p>Toolbar on L2:</p>
        <ul>
          <li>🏷️ Landmark — name a region of the palace</li>
          <li>🛤️ Path — tap cards in sequence, save a named route (e.g. “Pre-exam sweep”)</li>
          <li>📝 Annotate — drop text labels on the canvas</li>
          <li>🎯 Review on map — spatial review: camera pans to each due card at its position</li>
          <li>▶️ Classic study — same FSRS queue, flat UI</li>
        </ul>
        <p>From a deck sheet, <strong>Concept Map</strong> jumps straight into L2 for that deck.</p>
        <p><em>Max tip:</em> Spend ten minutes arranging a hard deck after import. Place prerequisites left/top, applications right/bottom. Your future self will walk that layout under stress.</p>
      `
    },
    {
      title: 'Formula cards & relationships',
      body: `
        <p>Formula cards can store the expression, variables, assumptions, common mistakes, and applications. Use them for engineering, math, physics — anything where the symbol soup is the point.</p>
        <p>Link cards with <strong>Depends on</strong> or <strong>Related</strong> (including across decks). On the map, those links draw as lines so the graph is visible while you study positions.</p>
        <p>In <strong>Cards</strong> view you can browse, search, and reverse-lookup by answer when you remember the result but not the name.</p>
      `
    },
    {
      title: 'Leeches, streaks, stats',
      body: `
        <p><strong>Leeches</strong> — cards with too many lapses get suspended so they stop clogging every session. Review them deliberately from stats/leech surfaces; reset when you have a better formulation or mnemonic.</p>
        <p><strong>Streaks</strong> — consecutive days you actually reviewed. Freezes (earned on longer streaks) can protect a missed day. Do not let the streak become the goal; the goal is recall under pressure.</p>
        <p><strong>Stats</strong> — retention, activity, per-deck breakdown. Use it to decide which palace wing to renovate this week.</p>
      `
    },
    {
      title: 'Documents, export, privacy',
      body: `
        <p>When you generate from a source, Lernin keeps the <em>filename + AI summary</em>, not the original PDF. Documents and Course Recap help you remember what you ingested.</p>
        <p><strong>Export</strong> a full backup (cards + progress) before switching devices. Import creates a new deck — it will not silently overwrite.</p>
        <p>By default nothing leaves your device except text you intentionally send to an AI provider during generation. No Lernin account is required for the core study loop.</p>
      `
    }
  ];

  const guide = document.createElement('section');
  guide.className = 'help-section';
  guide.id = 'help-guide';
  guide.innerHTML = `<h2 class="help-section-title">How to use every part</h2>`;
  const guideList = document.createElement('div');
  guideList.className = 'help-accordion';
  guideSections.forEach((s, i) => {
    const details = document.createElement('details');
    details.className = 'help-details';
    if (i === 0) details.open = true;
    details.style.setProperty('--help-i', String(i));
    details.innerHTML = `
      <summary class="help-summary">${s.title}</summary>
      <div class="help-details-body">${s.body}</div>
    `;
    guideList.appendChild(details);
  });
  guide.appendChild(guideList);
  wrap.appendChild(guide);

  // ---- FAQ ----
  const faqs = [
    {
      q: 'Is my data private?',
      a: 'Decks, cards, review history, map positions, and streaks live in IndexedDB on your device. Lernin does not require an account for studying. The only time text leaves the device is when you deliberately generate cards with an AI provider you chose.'
    },
    {
      q: 'Is my API key safe?',
      a: 'Your Claude or Gemini key is stored locally in settings. It is sent only to that provider when you hit generate — not to a Lernin backend for storage. Prefer a key you can rotate; clear it in Settings anytime.'
    },
    {
      q: 'Does this replace Anki?',
      a: 'If you already live in Anki and love it, keep it. Lernin is for students who want FSRS-style scheduling plus a real Memory Palace map, formula-aware cards, and offline-first UX without a plugin maze. You can export backups; there is no magic one-click Anki sync.'
    },
    {
      q: 'Why did a card disappear from my queue?',
      a: 'It may be suspended as a leech after repeated failures, or simply not due yet. Check Stats / leech surfaces, or open the deck’s Cards list. Suspended cards are hidden from normal study on purpose.'
    },
    {
      q: 'What if I grade everything Easy to “finish faster”?',
      a: 'You will feel productive and learn almost nothing. The scheduler trusts you. Lie to it and you get an optimistic calendar and a rude exam. Grade the struggle you actually had.'
    },
    {
      q: 'Map vs classic study — which should I use?',
      a: 'Classic Study is fastest for daily due cards. Spatial review (🎯 on the map) is for encoding and for decks you have arranged deliberately. Many people: arrange once on the map, then grind due cards in classic mode, and run a path on the palace the night before the exam.'
    },
    {
      q: 'Will I lose everything if I clear browser data?',
      a: 'Yes — IndexedDB can be wiped with site data. Export a backup from the deck sheet regularly, especially before exams or browser resets. On aggressive mobile browsers, export more often.'
    },
    {
      q: 'Can I study offline?',
      a: 'Yes. The app shell is cached by a service worker; your data is local. AI generation needs network. Spatial and classic review do not.'
    },
    {
      q: 'What is Teach-it for?',
      a: 'After Good or Easy, you can type a quick explanation in your own words. That second retrieval is often the difference between “I recognized it” and “I can teach it.” Skip when you are tired; use it on high-value cards.'
    },
    {
      q: 'How do I get maximum value in one week?',
      a: 'Day 1: one deck, import or write 30–50 sharp cards. Day 2: open the map, place them, add 2–3 landmarks. Days 3–6: clear due cards daily with honest grades. Day 7: run a saved path with 🎯 spatial review. Export a backup.'
    }
  ];

  const faqSec = document.createElement('section');
  faqSec.className = 'help-section';
  faqSec.id = 'help-faq';
  faqSec.innerHTML = `<h2 class="help-section-title">FAQ</h2>`;
  const faqList = document.createElement('div');
  faqList.className = 'help-accordion';
  faqs.forEach((f, i) => {
    const details = document.createElement('details');
    details.className = 'help-details help-faq-item';
    details.style.setProperty('--help-i', String(i));
    details.innerHTML = `
      <summary class="help-summary">${f.q}</summary>
      <div class="help-details-body"><p>${f.a}</p></div>
    `;
    faqList.appendChild(details);
  });
  faqSec.appendChild(faqList);
  wrap.appendChild(faqSec);

  // ---- Closer ----
  const closer = document.createElement('div');
  closer.className = 'help-closer';
  closer.innerHTML = `
    <p>You do not need another aesthetic notes app. You need a system that forces retrieval and gives your spatial brain somewhere to put the knowledge.</p>
    <p class="help-closer-em">Open a deck. Grade honestly. Build a corner of your palace. Then go pass the thing you are studying for.</p>
    <button type="button" class="btn-primary help-closer-btn" id="helpGoHome">Back to decks</button>
  `;
  wrap.appendChild(closer);
  closer.querySelector('#helpGoHome').addEventListener('click', () => navigate('/'));

  root.appendChild(wrap);

  // Smooth in-page TOC (no layout thrash)
  toc.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

async function renderStats() {
  let stats;
  try {
    stats = await getDashboardStats();
  } catch (err) {
    showToast('Failed to load statistics.', 5000);
    return navigate('/');
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="statsBack" aria-label="Back">←</button>
    <div class="app-header-title">Statistics</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#statsBack').addEventListener('click', goBack);

  const metricsGrid = document.createElement('div');
  metricsGrid.style.cssText = 'display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; padding:var(--space-md);';

  const metrics = [
    { label: '30-day retention', value: stats.retention30d != null ? `${stats.retention30d}%` : '—' },
    { label: 'Longest streak', value: `${stats.longestStreak365d}d` },
    { label: 'Total reviews', value: (stats.totalReviewsLifetime || 0).toLocaleString() },
    { label: 'Cards studied', value: (stats.totalCardsStudied || 0).toLocaleString() },
    { label: 'Leeches', value: (stats.leechCount || 0).toLocaleString() }
  ];

  for (const m of metrics) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:var(--space-md); box-shadow:var(--shadow-sm); text-align:center;';
    card.innerHTML = `
      <div style="font-size:24px; font-weight:700; color:var(--ink);">${m.value}</div>
      <div style="font-size:12px; color:var(--ink-muted); margin-top:2px;">${m.label}</div>
    `;
    metricsGrid.appendChild(card);
  }
  wrap.appendChild(metricsGrid);

  const chartHeading = document.createElement('h3');
  chartHeading.style.cssText = 'font-size:14px; font-weight:600; color:var(--ink); padding:0 var(--space-md); margin:var(--space-md) 0 8px;';
  chartHeading.textContent = 'Last 30 days';
  wrap.appendChild(chartHeading);

  const chartRow = document.createElement('div');
  chartRow.style.cssText = 'display:flex; align-items:flex-end; gap:3px; height:80px; padding:0 var(--space-md) var(--space-md);';

  const dailyCounts = stats.dailyCounts30d || [0];
  const maxDaily = Math.max(1, ...dailyCounts);

  dailyCounts.forEach((count, i) => {
    const daysAgo = (dailyCounts.length - 1) - i;
    const bar = document.createElement('div');
    bar.style.cssText = `
      flex:1; border-radius:3px 3px 0 0; min-height:4px;
      height:${Math.max(4, (count / maxDaily) * 100)}%;
      background:${daysAgo === 0 ? 'var(--accent)' : 'var(--sand)'};
    `;
    bar.setAttribute('aria-label', `${daysAgo === 0 ? 'Today' : daysAgo + ' days ago'}: ${count} review${count === 1 ? '' : 's'}`);
    bar.title = bar.getAttribute('aria-label');
    chartRow.appendChild(bar);
  });
  wrap.appendChild(chartRow);

  const deckHeading = document.createElement('h3');
  deckHeading.style.cssText = 'font-size:14px; font-weight:600; color:var(--ink); padding:0 var(--space-md); margin:var(--space-md) 0 8px;';
  deckHeading.textContent = 'By deck';
  wrap.appendChild(deckHeading);

  if (!stats.perDeck || stats.perDeck.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'padding:0 var(--space-md); color:var(--ink-muted); font-size:14px;';
    empty.textContent = 'No decks yet.';
    wrap.appendChild(empty);
  } else {
    const deckList = document.createElement('div');
    deckList.style.cssText = 'padding:0 var(--space-md); display:flex; flex-direction:column; gap:8px;';
    for (const d of stats.perDeck) {
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:12px 14px; box-shadow:var(--shadow-sm);';
      row.innerHTML = `
        <div style="font-weight:600; color:var(--ink); margin-bottom:2px;">${escapeHtml(d.title)}</div>
        <div style="font-size:13px; color:var(--ink-muted);">${d.total} card${d.total === 1 ? '' : 's'} · ${d.mastered} mastered · ${d.dueToday} due today</div>
      `;
      deckList.appendChild(row);
    }
    wrap.appendChild(deckList);
  }

  root.appendChild(wrap);
}

async function renderNewDeckForm() {
  openDeckSheet(null);
}

function renderDeckEdit(deck) {
  openDeckSheet(deck);
}

async function openDeckSheet(existingDeck = null) {
  let decks;
  try {
    decks = await getDecks();
  } catch(e) {
    showToast('Failed to load dependencies.', 5000);
    return;
  }
  const isEdit = !!existingDeck;
  const existingTerritories = Array.from(
    new Set(decks.map(d => d.courseTerritoryId).filter(t => t && t !== 'uncategorized'))
  );

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  document.body.appendChild(backdrop);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', isEdit ? 'Edit deck' : 'New deck');

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <h2 style="padding:0 var(--space-lg); margin-bottom:var(--space-md); font-size:18px;">${isEdit ? 'Edit deck' : 'New deck'}</h2>
    <div style="padding:0 var(--space-lg); display:flex; flex-direction:column; gap:12px;">
      <div>
        <label style="font-size:13px; font-weight:600; color:var(--ink-secondary); display:block; margin-bottom:4px;">Title</label>
        <input type="text" id="deckTitleInput" placeholder="e.g. Biology 101" style="width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:15px; box-sizing:border-box;">
      </div>
      <div>
        <label style="font-size:13px; font-weight:600; color:var(--ink-secondary); display:block; margin-bottom:4px;">Territory / course (optional)</label>
        <input type="text" id="deckTerritoryInput" list="territoryList" placeholder="e.g. Science" style="width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:15px; box-sizing:border-box;">
        <datalist id="territoryList">${existingTerritories.map(t => `<option value="${escapeAttr(t)}">`).join('')}</datalist>
      </div>
      <div style="display:flex; gap:10px; margin-top:4px;">
        <button type="button" id="deckCancelBtn" style="flex:1; padding:12px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:15px; cursor:pointer; box-shadow:var(--shadow-sm);">Cancel</button>
        <button type="button" id="deckSaveBtn" style="flex:1; padding:12px; border:none; border-radius:var(--radius-md); background:var(--accent); color:white; font-size:15px; font-weight:600; cursor:pointer;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(sheet);

  const titleInput = sheet.querySelector('#deckTitleInput');
  const territoryInput = sheet.querySelector('#deckTerritoryInput');

  if (isEdit) {
    titleInput.value = existingDeck.title || '';
    territoryInput.value = existingDeck.courseTerritoryId === 'uncategorized' ? '' : (existingDeck.courseTerritoryId || '');
  }
  titleInput.focus();

  let isClosing = false;
  function closeSheet() {
    if (isClosing) return;
    isClosing = true;
    sheet.style.animation = 'slideDown 0.25s ease forwards';
    backdrop.style.animation = 'fadeIn 0.2s ease reverse forwards';
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
    }, 250);
  }

  backdrop.addEventListener('click', closeSheet);
  sheet.querySelector('.sheet-handle').addEventListener('click', closeSheet);
  sheet.querySelector('#deckCancelBtn').addEventListener('click', closeSheet);

  let startY = 0;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientY - startY > 80) closeSheet();
  }, { passive: true });

  sheet.querySelector('#deckSaveBtn').addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      showToast('Enter a deck title.');
      return;
    }
    const territory = territoryInput.value.trim() || 'uncategorized';

    try {
      if (isEdit) {
        const territoryChanged = territory !== (existingDeck.courseTerritoryId || 'uncategorized');
        await saveDeck({ ...existingDeck, title, courseTerritoryId: territory });
        if (territoryChanged && typeof clearIslandPosition === 'function') {
          await clearIslandPosition(existingDeck.id);
        }
        showToast('Deck updated.');
      } else {
        await addDeck({ title, courseTerritoryId: territory });
        showToast('Deck created.');
      }
      closeSheet();
      await renderDeckList();
    } catch (err) {
      showToast(err.message || 'Could not save deck.', 5000);
    }
  });
}

function renderPDFImport(deckId) {
  renderImportView(deckId);
}

async function renderImportView(deckId) {
  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="importBack" aria-label="Back">←</button>
    <div class="app-header-title">Import</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#importBack').addEventListener('click', () => navigate('/'));

  const body = document.createElement('div');
  body.style.cssText = 'padding:var(--space-md);';

  const fileLabel = document.createElement('div');
  fileLabel.style.cssText = 'font-size:14px; font-weight:600; color:var(--ink); margin-bottom:8px;';
  fileLabel.textContent = 'Select a file';
  body.appendChild(fileLabel);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pdf,.txt,.md,.jpg,.jpeg,.png,.ppt,.pptx';
  fileInput.style.cssText = 'width:100%; padding:12px; border:1.5px solid var(--sand); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:14px;';
  body.appendChild(fileInput);

  const hint = document.createElement('p');
  hint.style.cssText = 'font-size:12px; color:var(--ink-muted); margin-top:6px;';
  hint.textContent = 'Supports text PDFs, .txt, .md, images, and PowerPoint files.';
  body.appendChild(hint);

  const progressArea = document.createElement('div');
  progressArea.style.cssText = 'margin-top:var(--space-md); display:none;';
  body.appendChild(progressArea);

  const statusText = document.createElement('div');
  statusText.style.cssText = 'font-size:13px; color:var(--ink-secondary); margin-bottom:8px;';
  progressArea.appendChild(statusText);

  const progressBar = document.createElement('div');
  progressBar.style.cssText = 'height:4px; background:var(--sand); border-radius:2px; overflow:hidden;';
  const progressFill = document.createElement('div');
  progressFill.style.cssText = 'height:100%; background:var(--accent); width:0%; transition:width 0.3s;';
  progressBar.appendChild(progressFill);
  progressArea.appendChild(progressBar);

  wrap.appendChild(body);
  root.appendChild(wrap);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    const isPdf = ext === 'pdf';
    const isText = ext === 'txt' || ext === 'md';
    const isImage = ['jpg', 'jpeg', 'png'].includes(ext);
    const isPpt = ['ppt', 'pptx'].includes(ext);

    if (!isPdf && !isText && !isImage && !isPpt) {
      showToast('Please select a .pdf, .txt, .md, .jpg, .png, or .ppt file', 5000);
      return;
    }

    const config = await getApiConfig();
    const isByok = config && (config.provider === 'claude' || config.provider === 'gemini') && config.apiKey;

    if (isText) {
      progressArea.style.display = 'block';
      statusText.textContent = 'Reading file...';
      progressFill.style.width = '50%';

      try {
        const text = await file.text();
        progressFill.style.width = '100%';
        await handleExtractedText(text, deckId, config, file.name);
      } catch (err) {
        showToast('Failed to read file.', 5000);
        progressArea.style.display = 'none';
      }
      return;
    }

    if (isPdf) {
      progressArea.style.display = 'block';
      statusText.textContent = 'Extracting text from PDF...';
      progressFill.style.width = '10%';

      try {
        const text = await extractTextFromPdf(file, ({ page, totalPages }) => {
          const pct = Math.round((page / totalPages) * 80);
          progressFill.style.width = pct + '%';
          statusText.textContent = `Extracting page ${page} of ${totalPages}...`;
        });

        progressFill.style.width = '100%';
        statusText.textContent = 'Extraction complete.';

        if (text.trim().length < 50) {
          showToast('PDF appears to be scanned. Using AI vision...');
          if (isByok) {
            await uploadVisionFile(file, deckId, config);
          } else {
            renderManualJSONImport(root, deckId, () => navigate('/'), null, file.name);
          }
          return;
        }

        await handleExtractedText(text, deckId, config, file.name);
      } catch (err) {
        console.error('PDF extraction failed:', err);
        showToast('Could not extract text. Try the manual copy-paste flow instead.', 5000);
        renderManualJSONImport(root, deckId, () => navigate('/'), null, file.name);
      }
      return;
    }

    // Vision path for images and PowerPoint
    if (isImage || isPpt) {
      if (isByok) {
        progressArea.style.display = 'block';
        statusText.textContent = 'Reading document with AI...';
        progressFill.style.width = '30%';
        await uploadVisionFile(file, deckId, config);
      } else {
        renderManualJSONImport(root, deckId, () => navigate('/'), null, file.name);
      }
      return;
    }
  });
}

async function handleExtractedText(text, deckId, config, filename) {
  const isByok = config && (config.provider === 'claude' || config.provider === 'gemini') && config.apiKey;

  if (isByok) {
    const result = await generateCards(text, deckId);
    if (result && result.cards && result.cards.length > 0) {
      renderEditStep(result.cards, deckId);
      return;
    }
    // Offline queue returns empty intentionally — toast already shown.
    // Online empty result: offer manual paste so the user isn't stuck.
    if (navigator.onLine) {
      showToast('Generation returned no cards. You can paste JSON from any AI instead.');
      renderManualJSONImport(root, deckId, () => navigate('/'), text, filename);
    }
  } else {
    renderManualJSONImport(root, deckId, () => navigate('/'), text, filename);
  }
}

async function uploadVisionFile(file, deckId, config) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('deck_id', deckId);

  try {
    const response = await fetch('/api/generate-cards-vision', {
      method: 'POST',
      headers: {
        'X-LLM-Provider': config.provider,
        'X-LLM-Api-Key': config.apiKey
      },
      body: formData
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Vision generation failed: ${response.status}`);
    }

    const data = await response.json();
    if (data.cards && data.cards.length > 0) {
      renderEditStep(data.cards, deckId);
    } else {
      showToast('No cards generated from this file.');
    }
  } catch (err) {
    showToast('Generation failed: ' + err.message, 5000);
  }
}

function renderEditStep(cards, deckId) {
  root.innerHTML = '';
  root.style.padding = '0';

  const approved = [...cards];
  let discardedCount = 0;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="editBack" aria-label="Back">←</button>
    <div class="app-header-title">Review cards</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#editBack').addEventListener('click', () => navigate('/'));

  const sub = document.createElement('p');
  sub.style.cssText = 'padding:0 var(--space-md); margin:var(--space-sm) 0 var(--space-md); font-size:13px; color:var(--ink-muted);';
  sub.textContent = "Tap the ✕ to discard cards you don't want. Then import the rest.";
  wrap.appendChild(sub);

  const list = document.createElement('div');
  list.style.cssText = 'padding:0 var(--space-md); display:flex; flex-direction:column; gap:8px;';

  function renderCards() {
    list.innerHTML = '';
    for (let i = 0; i < approved.length; i++) {
      const card = approved[i];
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm); position:relative;';

      const typeBadge = document.createElement('span');
      typeBadge.style.cssText = 'position:absolute; top:10px; right:44px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; background:var(--accent-soft); color:var(--accent); text-transform:uppercase;';
      typeBadge.textContent = card.type || 'basic';
      row.appendChild(typeBadge);

      const front = document.createElement('div');
      front.style.cssText = 'font-size:14px; font-weight:600; color:var(--ink); margin-bottom:6px; padding-right:60px;';
      front.textContent = card.front;
      row.appendChild(front);

      const back = document.createElement('div');
      back.style.cssText = 'font-size:13px; color:var(--ink-secondary); line-height:1.5;';
      back.textContent = card.back;
      row.appendChild(back);

      // Hint field (editable)
      const hintWrap = document.createElement('div');
      hintWrap.style.cssText = 'margin-top:8px;';
      const hintLabel = document.createElement('div');
      hintLabel.style.cssText = 'font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;';
      hintLabel.textContent = 'Hint / Explanation';
      hintWrap.appendChild(hintLabel);
      const hintInput = document.createElement('textarea');
      hintInput.rows = 2;
      hintInput.placeholder = 'Optional hint shown before revealing the answer…';
      hintInput.style.cssText = 'width:100%; padding:8px 10px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:13px; font-family:inherit; resize:vertical; box-sizing:border-box;';
      hintInput.value = card.hint || '';
      hintInput.addEventListener('input', () => {
        card.hint = hintInput.value.trim() || undefined;
      });
      hintWrap.appendChild(hintInput);
      row.appendChild(hintWrap);

      if (card.type === 'formula') {
        if (card.formula) {
          const formula = document.createElement('div');
          formula.style.cssText = 'margin-top:8px; font-family:var(--font-mono); font-size:13px; color:var(--ink-secondary); background:var(--bg); padding:8px; border-radius:var(--radius-sm);';
          formula.textContent = card.formula;
          row.appendChild(formula);
        }
        if (card.variables && card.variables.length > 0) {
          const vars = document.createElement('div');
          vars.style.cssText = 'margin-top:6px; font-size:12px; color:var(--ink-muted);';
          vars.textContent = card.variables.map(v => `${v.symbol || v.name}: ${v.meaning || v.description}`).join(' | ');
          row.appendChild(vars);
        }
      }

      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.textContent = '✕';
      discardBtn.style.cssText = 'position:absolute; top:10px; right:10px; width:28px; height:28px; border:none; background:var(--danger-soft); color:var(--danger); border-radius:50%; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center;';
      discardBtn.addEventListener('click', () => {
        approved.splice(i, 1);
        discardedCount++;
        renderCards();
        updateSummary();
      });
      row.appendChild(discardBtn);

      list.appendChild(row);
    }
  }

  wrap.appendChild(list);

  const summary = document.createElement('div');
  summary.style.cssText = 'padding:0 var(--space-md); margin:var(--space-md) 0; font-size:13px; color:var(--ink-muted); text-align:center;';
  function updateSummary() {
    summary.textContent = `${approved.length} of ${cards.length} cards selected${discardedCount > 0 ? ` (${discardedCount} discarded)` : ''}`;
  }
  updateSummary();
  wrap.appendChild(summary);

  const importBtn = document.createElement('button');
  importBtn.className = 'btn-primary';
  importBtn.style.cssText = 'width:calc(100% - 32px); margin:0 var(--space-md) var(--space-md); padding:14px;';
  importBtn.textContent = 'Import all selected';
  importBtn.addEventListener('click', async () => {
    if (approved.length === 0) {
      showToast('No cards selected to import.', 5000);
      return;
    }
    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    try {
      await commitGeneratedCards(deckId, approved);
      showToast(`Imported ${approved.length} card${approved.length !== 1 ? 's' : ''}.`);
      navigate('/');
    } catch (err) {
      showToast(err.message || 'Import failed.', 5000);
      importBtn.disabled = false;
      importBtn.textContent = 'Import all selected';
    }
  });
  wrap.appendChild(importBtn);

  root.appendChild(wrap);
  renderCards();
}

async function renderNewCardForm(deckId) {
  let deck;
  try {
    deck = await getDeck(deckId);
  } catch (err) {
    showToast('Failed to load deck data.', 5000);
    return goBack();
  }

  if (!deck) {
    showToast('Deck not found.', 5000);
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="newCardBack" aria-label="Back">←</button>
    <div class="app-header-title">New card</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#newCardBack').addEventListener('click', goBack);

  const sub = document.createElement('p');
  sub.style.cssText = 'padding:0 var(--space-md); margin:var(--space-sm) 0 var(--space-md); font-size:13px; color:var(--ink-muted);';
  sub.textContent = `Adding to "${deck.title}"`;
  wrap.appendChild(sub);

  const form = document.createElement('form');
  form.style.cssText = 'padding:0 var(--space-md); display:flex; flex-direction:column; gap:12px;';

  const typeLabel = document.createElement('div');
  typeLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  typeLabel.textContent = 'Card type';
  form.appendChild(typeLabel);

  const typeRow = document.createElement('div');
  typeRow.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
  const types = [
    { value: 'basic', label: 'Basic' },
    { value: 'cloze', label: 'Cloze' },
    { value: 'formula', label: 'Formula' }
  ];
  for (const t of types) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex; align-items:center; gap:6px; padding:8px 12px; background:var(--surface); border-radius:var(--radius-sm); cursor:pointer; box-shadow:var(--shadow-sm); font-size:14px;';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'cardType';
    radio.value = t.value;
    radio.checked = t.value === 'basic';
    label.appendChild(radio);
    label.appendChild(document.createTextNode(t.label));
    typeRow.appendChild(label);
  }
  form.appendChild(typeRow);

  const frontLabel = document.createElement('div');
  frontLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  frontLabel.textContent = 'Front (question)';
  form.appendChild(frontLabel);

  const frontInput = document.createElement('textarea');
  frontInput.rows = 3;
  frontInput.placeholder = 'What is the capital of France?';
  frontInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:15px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  form.appendChild(frontInput);

  const backLabel = document.createElement('div');
  backLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  backLabel.textContent = 'Back (answer)';
  form.appendChild(backLabel);

  const backInput = document.createElement('textarea');
  backInput.rows = 3;
  backInput.placeholder = 'Paris';
  backInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:15px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  form.appendChild(backInput);

  // Hint / Explanation field
  const hintLabel = document.createElement('div');
  hintLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  hintLabel.textContent = 'Hint / Explanation (optional)';
  form.appendChild(hintLabel);

  const hintInput = document.createElement('textarea');
  hintInput.rows = 2;
  hintInput.placeholder = 'Shown before the answer is revealed to help recall…';
  hintInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:15px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  form.appendChild(hintInput);

  const formulaFields = document.createElement('div');
  formulaFields.style.cssText = 'display:none; flex-direction:column; gap:12px;';
  formulaFields.id = 'formulaFields';

  const formulaInput = document.createElement('textarea');
  formulaInput.rows = 2;
  formulaInput.placeholder = 'E = mc^2';
  formulaInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:15px; font-family:var(--font-mono); resize:vertical; box-sizing:border-box;';
  const formulaLabel = document.createElement('div');
  formulaLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  formulaLabel.textContent = 'Formula (LaTeX)';
  formulaFields.appendChild(formulaLabel);
  formulaFields.appendChild(formulaInput);

  const varsInput = document.createElement('textarea');
  varsInput.rows = 2;
  varsInput.placeholder = 'E: energy\nm: mass\nc: speed of light';
  varsInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  const varsLabel = document.createElement('div');
  varsLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  varsLabel.textContent = 'Variables (one per line: name: description)';
  formulaFields.appendChild(varsLabel);
  formulaFields.appendChild(varsInput);

  const assumptionsInput = document.createElement('textarea');
  assumptionsInput.rows = 2;
  assumptionsInput.placeholder = 'c is constant in vacuum';
  assumptionsInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  const assumptionsLabel = document.createElement('div');
  assumptionsLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  assumptionsLabel.textContent = 'Assumptions (optional)';
  formulaFields.appendChild(assumptionsLabel);
  formulaFields.appendChild(assumptionsInput);

  const mistakesInput = document.createElement('textarea');
  mistakesInput.rows = 2;
  mistakesInput.placeholder = 'Forgetting to square c';
  mistakesInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  const mistakesLabel = document.createElement('div');
  mistakesLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  mistakesLabel.textContent = 'Common mistakes (optional)';
  formulaFields.appendChild(mistakesLabel);
  formulaFields.appendChild(mistakesInput);

  const applicationsInput = document.createElement('textarea');
  applicationsInput.rows = 2;
  applicationsInput.placeholder = 'Nuclear energy, particle physics';
  applicationsInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; box-sizing:border-box;';
  const applicationsLabel = document.createElement('div');
  applicationsLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:4px;';
  applicationsLabel.textContent = 'Applications (optional)';
  formulaFields.appendChild(applicationsLabel);
  formulaFields.appendChild(applicationsInput);

  form.appendChild(formulaFields);

  typeRow.querySelectorAll('input[name="cardType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      formulaFields.style.display = radio.value === 'formula' && radio.checked ? 'flex' : 'none';
    });
  });

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:10px; margin-top:4px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.style.cssText = 'flex:1; padding:12px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:15px; cursor:pointer; box-shadow:var(--shadow-sm);';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', goBack);
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.style.cssText = 'flex:1; padding:12px; border:none; border-radius:var(--radius-md); background:var(--accent); color:white; font-size:15px; font-weight:600; cursor:pointer;';
  saveBtn.textContent = 'Save';
  actions.appendChild(saveBtn);

  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = form.querySelector('input[name="cardType"]:checked')?.value || 'basic';
    const front = frontInput.value.trim();
    const back = backInput.value.trim();
    const hint = hintInput.value.trim() || undefined;

    if (!front || !back) {
      showToast('Fill in both front and back.', 5000);
      return;
    }

    const card = { front, back, hint, type, deckId: deck.id };

    if (type === 'formula') {
      card.formula = formulaInput.value.trim() || undefined;
      const varsText = varsInput.value.trim();
      if (varsText) {
        card.variables = varsText.split('\n').map(line => {
          const [name, ...rest] = line.split(':');
          return { name: name.trim(), description: rest.join(':').trim() };
        }).filter(v => v.name);
      }
      card.assumptions = assumptionsInput.value.trim() || undefined;
      card.commonMistakes = mistakesInput.value.trim() || undefined;
      card.applications = applicationsInput.value.trim() || undefined;
    }

    try {
      await saveManualCard(card);
      showToast('Card saved.');
      goBack();
    } catch (err) {
      showToast(err.message || 'Failed to save card.', 5000);
    }
  });

  wrap.appendChild(form);
  root.appendChild(wrap);
}

async function renderCardBrowser(deckId) {
  let deck, cards;
  try {
    deck = await getDeck(deckId);
    cards = await getCardsByDeck(deckId);
  } catch (err) {
    showToast('Failed to load cards.', 5000);
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="browserBack" aria-label="Back">←</button>
    <div class="app-header-title">${escapeHtml(deck.title)}</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#browserBack').addEventListener('click', goBack);

  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding:var(--space-sm) var(--space-md);';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search cards…';
  searchInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:15px; box-sizing:border-box;';
  searchWrap.appendChild(searchInput);
  wrap.appendChild(searchWrap);

  const list = document.createElement('div');
  list.style.cssText = 'padding:0 var(--space-md); display:flex; flex-direction:column; gap:8px;';

  function renderCardList(filteredCards) {
    list.innerHTML = '';
    if (filteredCards.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center; padding:var(--space-xl) 0; color:var(--ink-muted); font-size:14px;';
      empty.textContent = 'No cards found.';
      list.appendChild(empty);
      return;
    }

    for (const card of filteredCards) {
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm); cursor:pointer;';
      row.innerHTML = `
        <div style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:4px;">${escapeHtml(card.front.substring(0, 100))}${card.front.length > 100 ? '…' : ''}</div>
        <div style="font-size:12px; color:var(--ink-muted);">${card.type || 'basic'} · ${card.state || 'new'}</div>
      `;
      row.addEventListener('click', () => renderCardDetailView(card, deck));
      list.appendChild(row);
    }
  }

  renderCardList(cards);

  searchInput.addEventListener('input', async () => {
    const query = searchInput.value.trim();
    if (!query) {
      renderCardList(cards);
      return;
    }
    try {
      const byFront = await searchCardsByFront(query);
      const byBack = await searchCardsByAnswer(query);
      const merged = [...byFront, ...byBack].filter(c => c.deckId === deckId);
      const unique = Array.from(new Map(merged.map(c => [c.id, c])).values());
      renderCardList(unique);
    } catch (err) {
      console.error('Search failed:', err);
    }
  });

  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary';
  addBtn.style.cssText = 'width:calc(100% - 32px); margin:var(--space-md); padding:14px;';
  addBtn.textContent = '+ Add card';
  addBtn.addEventListener('click', () => navigate(`/new-card/${deckId}`));
  wrap.appendChild(addBtn);

  root.appendChild(wrap);
}

async function renderCardDetailView(card, deck) {
  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="detailBack" aria-label="Back">←</button>
    <div class="app-header-title">Card</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#detailBack').addEventListener('click', () => navigate(`/cards/${deck.id}`));

  const body = document.createElement('div');
  body.style.cssText = 'padding:var(--space-md); display:flex; flex-direction:column; gap:12px;';

  const frontBlock = document.createElement('div');
  frontBlock.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm);';
  frontBlock.innerHTML = `<div style="font-size:12px; font-weight:600; color:var(--ink-muted); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:6px;">Front</div><div style="font-size:15px; color:var(--ink); line-height:1.6;">${escapeHtml(card.front)}</div>`;
  body.appendChild(frontBlock);

  const backBlock = document.createElement('div');
  backBlock.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm);';
  backBlock.innerHTML = `<div style="font-size:12px; font-weight:600; color:var(--ink-muted); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:6px;">Back</div><div style="font-size:15px; color:var(--ink); line-height:1.6;">${escapeHtml(card.back)}</div>`;
  body.appendChild(backBlock);

  if (card.hint) {
    const hintBlock = document.createElement('div');
    hintBlock.style.cssText = 'background:var(--accent-soft); border-radius:var(--radius-md); padding:14px; border-left:3px solid var(--accent);';
    hintBlock.innerHTML = `<div style="font-size:12px; font-weight:600; color:var(--accent); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:6px;">Hint</div><div style="font-size:14px; color:var(--ink-secondary); line-height:1.6;">${escapeHtml(card.hint)}</div>`;
    body.appendChild(hintBlock);
  }

  if (card.formula) {
    const formulaBlock = document.createElement('div');
    formulaBlock.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm);';
    formulaBlock.innerHTML = `<div style="font-size:12px; font-weight:600; color:var(--ink-muted); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:6px;">Formula</div><div style="font-family:var(--font-mono); font-size:15px; color:var(--ink);">$$${escapeHtml(card.formula)}$$</div>`;
    body.appendChild(formulaBlock);
  }

  // Relationships
  const relsFrom = await getRelationshipsFrom(card.id);
  const relsTo = await getRelationshipsTo(card.id);

  if (relsFrom.length > 0 || relsTo.length > 0) {
    const relBlock = document.createElement('div');
    relBlock.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm);';
    let relHtml = '<div style="font-size:12px; font-weight:600; color:var(--ink-muted); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:8px;">Relationships</div>';
    for (const r of relsFrom) {
      relHtml += `<div style="font-size:13px; color:var(--ink-secondary); margin-bottom:4px;">→ ${escapeHtml(r.type)}: ${escapeHtml(r.toCard?.front?.substring(0, 60) || 'Card')}…</div>`;
    }
    for (const r of relsTo) {
      relHtml += `<div style="font-size:13px; color:var(--ink-secondary); margin-bottom:4px;">← ${escapeHtml(r.type)}: ${escapeHtml(r.fromCard?.front?.substring(0, 60) || 'Card')}…</div>`;
    }
    relBlock.innerHTML = relHtml;
    body.appendChild(relBlock);
  }

  // Add relationship
  const addRelBlock = document.createElement('div');
  addRelBlock.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm);';
  addRelBlock.innerHTML = '<div style="font-size:12px; font-weight:600; color:var(--ink-muted); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:8px;">Add relationship</div>';

  const relTypeSelect = document.createElement('select');
  relTypeSelect.style.cssText = 'width:100%; padding:10px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; margin-bottom:8px; box-sizing:border-box;';
  relTypeSelect.innerHTML = `
    <option value="depends_on">Depends on</option>
    <option value="related_to">Related to</option>
    <option value="prerequisite">Prerequisite</option>
  `;
  addRelBlock.appendChild(relTypeSelect);

  const relSearch = document.createElement('input');
  relSearch.type = 'text';
  relSearch.placeholder = 'Search cards by answer…';
  relSearch.style.cssText = 'width:100%; padding:10px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; margin-bottom:8px; box-sizing:border-box;';
  addRelBlock.appendChild(relSearch);

  const relResults = document.createElement('div');
  relResults.style.cssText = 'display:flex; flex-direction:column; gap:4px; max-height:200px; overflow-y:auto;';
  addRelBlock.appendChild(relResults);

  relSearch.addEventListener('input', async () => {
    const query = relSearch.value.trim();
    if (!query) {
      relResults.innerHTML = '';
      return;
    }
    try {
      const results = await searchCardsByAnswer(query);
      relResults.innerHTML = '';
      for (const c of results.slice(0, 10)) {
        if (c.id === card.id) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = 'text-align:left; padding:8px 10px; border:none; background:var(--bg); border-radius:var(--radius-sm); cursor:pointer; font-size:13px; color:var(--ink);';
        row.textContent = c.front.substring(0, 80);
        row.addEventListener('click', async () => {
          try {
            await addRelationship(card.id, c.id, relTypeSelect.value);
            showToast('Relationship added.');
            renderCardDetailView(card, deck);
          } catch (err) {
            showToast(err.message || 'Failed to add relationship.', 5000);
          }
        });
        relResults.appendChild(row);
      }
    } catch (err) {
      console.error('Search failed:', err);
    }
  });

  body.appendChild(addRelBlock);

  const studyBtn = document.createElement('button');
  studyBtn.className = 'btn-primary';
  studyBtn.style.cssText = 'width:100%; padding:14px; margin-top:4px;';
  studyBtn.textContent = 'Study this card';
  studyBtn.addEventListener('click', () => {
    root.innerHTML = '';
    startStudySession(root, { deckId: deck.id, startCardId: card.id });
  });
  body.appendChild(studyBtn);

  wrap.appendChild(body);
  root.appendChild(wrap);
  renderMath(wrap);
}

async function renderDocuments(deckId) {
  let deck, docs;
  try {
    deck = await getDeck(deckId);
    docs = await getDocumentsByDeck(deckId);
  } catch (err) {
    showToast('Failed to load documents.', 5000);
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="docsBack" aria-label="Back">←</button>
    <div class="app-header-title">${escapeHtml(deck.title)}</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#docsBack').addEventListener('click', goBack);

  const body = document.createElement('div');
  body.style.cssText = 'padding:var(--space-md);';

  if (docs.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center; padding:var(--space-xl) 0; color:var(--ink-muted); font-size:14px;';
    empty.textContent = 'No documents imported yet.';
    body.appendChild(empty);
  } else {
    for (const doc of docs) {
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm); margin-bottom:8px; display:flex; align-items:center; justify-content:space-between;';
      row.innerHTML = `
        <div>
          <div style="font-size:14px; font-weight:600; color:var(--ink);">${escapeHtml(doc.filename)}</div>
          <div style="font-size:12px; color:var(--ink-muted);">${formatFileSize(doc.size)} · ${formatUploadDate(doc.uploadedAt)}</div>
        </div>
        <button class="doc-delete-btn" data-id="${doc.id}" style="width:32px;height:32px;border:none;background:transparent;color:var(--danger);font-size:18px;cursor:pointer;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;">🗑</button>
      `;
      row.querySelector('.doc-delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this document?')) return;
        try {
          await deleteDocument(doc.id);
          showToast('Document deleted.');
          renderDocuments(deckId);
        } catch (err) {
          showToast(err.message || 'Failed to delete.', 5000);
        }
      });
      body.appendChild(row);
    }
  }

  const recapBtn = document.createElement('button');
  recapBtn.className = 'btn-secondary';
  recapBtn.style.cssText = 'width:100%; padding:14px; margin-top:var(--space-md);';
  recapBtn.textContent = '📋 Course Recap';
  recapBtn.addEventListener('click', () => renderCourseRecapView(deckId));
  body.appendChild(recapBtn);

  wrap.appendChild(body);
  root.appendChild(wrap);
}

async function renderCourseRecapView(deckId) {
  let deck, docs;
  try {
    deck = await getDeck(deckId);
    docs = await getDocumentsByDeck(deckId);
  } catch (err) {
    showToast('Failed to load recap.', 5000);
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="back-btn" id="recapBack" aria-label="Back">←</button>
    <div class="app-header-title">Course Recap</div>
    <div style="width:48px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#recapBack').addEventListener('click', () => renderDocuments(deckId));

  const body = document.createElement('div');
  body.style.cssText = 'padding:var(--space-md);';

  if (docs.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center; padding:var(--space-xl) 0; color:var(--ink-muted); font-size:14px;';
    empty.textContent = 'No documents to recap.';
    body.appendChild(empty);
  } else {
    for (const doc of docs) {
      const block = document.createElement('div');
      block.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm); margin-bottom:12px;';
      block.innerHTML = `
        <div style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:6px;">${escapeHtml(doc.filename)}</div>
        <div style="font-size:13px; color:var(--ink-secondary); line-height:1.6;">${escapeHtml(doc.summary || 'No summary available.')}</div>
      `;
      body.appendChild(block);
    }
  }

  wrap.appendChild(body);
  root.appendChild(wrap);
}

/* ---------- Import / Export ---------- */
export async function triggerDeckImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await importDeckData(data);
      showToast(`Imported ${result.deckCount} deck(s), ${result.cardCount} card(s).`);
      await renderDeckList();
    } catch (err) {
      showToast(err.message || 'Import failed. Check the file format.', 5000);
    } finally {
      input.remove();
    }
  });

  input.click();
}

async function exportDeck(deckId) {
  try {
    const data = await exportDeckData(deckId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lernin-deck-${deckId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Deck exported.');
  } catch (err) {
    showToast(err.message || 'Export failed.', 5000);
  }
}

/* ---------- Generation Event Listeners ---------- */
function initGenerationListeners() {
  window.addEventListener('recall:generation-success', (e) => {
    const { cards } = e.detail || {};
    // Online path usually goes through renderEditStep; this covers offline retry auto-save.
    if (cards && cards.length) {
      showToast(`${cards.length} card${cards.length === 1 ? '' : 's'} ready in the deck.`);
    } else {
      showToast('Cards generated! Review them in the deck.');
    }
  });

  window.addEventListener('recall:generation-error', (e) => {
    const { message } = e.detail || {};
    showToast('Generation failed: ' + (message || 'Unknown error'));
  });

  window.addEventListener('recall:generation-queued', () => {
    showToast("No connection. Cards will generate when you're back online.");
  });

  window.addEventListener('recall:generation-retry-done', (e) => {
    const { cardCount } = e.detail || {};
    const n = cardCount || 0;
    showToast(`${n} card${n === 1 ? '' : 's'} added from queued request.`);
  });
}

/* ---------- Init ---------- */
window.addEventListener('hashchange', handleRoute);
initTheme();
initFont();
initGenerationListeners();
handleRoute();
