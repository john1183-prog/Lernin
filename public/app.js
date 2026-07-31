/* ---------- Lernin — App Orchestrator ----------
   Home screen, bottom sheet, theme, view routing */

import {
  getDecks, getCardsDueTodayOrEarlier, getReviewStats,
  getTheme, saveTheme, addDeck, getCardsByDeck,
  getRelationshipsFrom, getRelationshipsTo, addRelationship,
  removeRelationship, getCard, getDeck, getApiConfig, saveApiConfig, clearApiConfig,
  getReminderSettings, setReminderEnabled, wipeAllData, saveDeck,
  clearIslandPosition, saveManualCard, searchCardsByFront, searchCardsByAnswer,
  exportDeckData, importDeckData, getDocumentsByDeck, getDashboardStats, deleteDocument
} from './db.js';
import { startStudySession } from './study.js';
import { initCanvasView } from './canvas.js';
import { initConceptGraph } from './concept-graph.js';
import { renderManualJSONImport } from './manual-json-import.js';

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
  // Fix #12: Await/catch the save action to prevent unhandled rejections
  saveTheme(next).catch(err => console.error('Failed to save theme:', err)); 
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
  const [route, id] = path.split('/');

  // Cleanup: prevent stuck modals when user navigates back
  document.querySelectorAll('.sheet-backdrop, .sheet').forEach(el => el.remove());

  switch (route) {
    case '/': await renderDeckList(); break;
    case 'settings': await renderSettings(); break;
    case 'help': renderHelp(); break;
    case 'stats': await renderStats(); break;
    case 'study': enterStudy(id); break; // start with specific deck ID if provided
    case 'cards': await renderCardBrowser(id); break;
    case 'map': enterMap(); break;
    case 'concept': enterConceptGraph(id); break;
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
    // Fix #17: Add error boundary for IndexedDB queries
    [decks, dueCards, stats] = await Promise.all([
      getDecks(),
      getCardsDueTodayOrEarlier(),
      getReviewStats()
    ]);
  } catch (err) {
    showToast('Failed to load dashboard.');
    console.error(err);
    return;
  }

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="app-header-title">Lernin</div>
    <div class="app-header-actions">
      <button class="icon-btn" id="helpBtn" aria-label="Help">❓</button>
      <button class="icon-btn" id="themeToggle" aria-label="Toggle theme">🌓</button>
      <button class="icon-btn" id="settingsBtn" aria-label="Settings">⚙️</button>
    </div>
  `;
  root.appendChild(header);

  header.querySelector('#helpBtn').addEventListener('click', () => navigate('/help'));
  header.querySelector('#themeToggle').addEventListener('click', cycleTheme);
  header.querySelector('#settingsBtn').addEventListener('click', () => navigate('/settings'));

  const dueToday = dueCards.length;
  const streak = stats.currentStreak || 0;

  if (dueToday > 0) {
    const hero = document.createElement('div');
    hero.className = 'hero-cta';
    hero.innerHTML = `
      <div class="hero-cta-title">${dueToday} card${dueToday !== 1 ? 's' : ''} due today</div>
      <div class="hero-cta-sub">${streak > 0 ? `🔥 ${streak}-day streak` : 'Start building your streak'}</div>
      <button class="hero-cta-btn" id="heroStudy">Study Now</button>
    `;
    root.appendChild(hero);
    hero.querySelector('#heroStudy').addEventListener('click', () => navigate('/study/all'));
  }

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
      </div>
    `;
  } else {
    for (const deck of decks) {
      const tile = await buildDeckTile(deck);
      list.appendChild(tile);
    }
  }
  root.appendChild(list);

  const newBtn = document.createElement('button');
  newBtn.className = 'btn-secondary';
  newBtn.style.cssText = 'margin: var(--space-md); width: calc(100% - var(--space-md)*2);';
  newBtn.innerHTML = '+ New deck';
  newBtn.addEventListener('click', () => renderNewDeckForm());
  root.appendChild(newBtn);

  const mapBtn = document.createElement('button');
  mapBtn.className = 'btn-secondary';
  mapBtn.style.cssText = 'margin: 0 var(--space-md) var(--space-md); width: calc(100% - var(--space-md)*2);';
  mapBtn.innerHTML = '🗺️ Map view';
  mapBtn.addEventListener('click', () => navigate('/map'));
  root.appendChild(mapBtn);

  renderMath(root);
}

async function buildDeckTile(deck) {
  const cards = await getCardsByDeck(deck.id);
  const now = Date.now();
  
  // Fix #13: Safely parse dates in case db returns an ISO string instead of timestamp
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
      ${due > 0 ? `<div class="deck-tile-badge">${due} due</div>` : ''}
    </div>
    <div class="deck-tile-bar">
      <div class="deck-tile-bar-fill" style="width: ${masteryPct}%"></div>
    </div>
  `;

  // Fix #5: Scope the long-press timers to each tile individually to prevent race conditions
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
    { label: 'Concept Map', icon: '🕸️', action: () => navigate(`/concept/${deck.id}`) },
    { label: 'Documents', icon: '📑', action: () => navigate(`/documents/${deck.id}`) },
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

  // Fix #16: Add Escape and Tab accessibility traps for bottom sheets
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
  sheet.querySelector('.sheet-handle').addEventListener('click', closeSheet);

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
  // If 'all' is passed, set deckId to null for cross-deck study
  const targetId = deckId === 'all' ? null : deckId;
  startStudySession(root, { deckId: targetId });
}

function enterConceptGraph(deckId) {
  root.innerHTML = '';
  initConceptGraph(root, deckId, {
    onExit: () => navigate('/'),
    onStudyCard: (cardId) => {
      root.innerHTML = '';
      startStudySession(root, { deckId, startCardId: cardId });
    }
  });
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
    showToast('Failed to load settings.');
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
    <button class="icon-btn" id="settingsBack" aria-label="Back">←</button>
    <div class="app-header-title">Settings</div>
    <div style="width:40px;"></div>
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
  keyHelp.innerHTML = 'Get a key from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style="color:var(--accent);">console.anthropic.com</a> (Claude) or <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--accent);">aistudio.google.com</a> (Gemini).';
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

  // Reminders
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

  // Storage
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

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.style.cssText = 'flex:1; padding:12px 16px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:14px; font-weight:500; cursor:pointer; box-shadow:var(--shadow-sm);';
  importBtn.textContent = 'Import deck (.json)';
  importBtn.addEventListener('click', triggerDeckImport);
  storageBtnRow.appendChild(importBtn);

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

  // Danger zone
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
    <input type="text" id="resetConfirmInput" autocomplete="off" spellcheck="false"
      style="width:100%; padding:12px 14px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:15px; margin-bottom:10px; box-sizing:border-box;" />
    <div style="display:flex; gap:10px;">
      <button type="button" id="resetConfirmBtn" disabled
        style="flex:1; padding:12px; border:none; border-radius:var(--radius-md); background:var(--danger); color:white; font-size:14px; font-weight:600; cursor:pointer; opacity:0.5;">
        Permanently delete everything
      </button>
      <button type="button" id="resetCancelBtn"
        style="padding:12px 16px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:14px; cursor:pointer; box-shadow:var(--shadow-sm);">
        Cancel
      </button>
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
      showToast(err.message || 'Reset failed.');
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
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="helpBack" aria-label="Back">←</button>
    <div class="app-header-title" style="font-size:16px;">Help</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#helpBack').addEventListener('click', goBack);

  const intro = document.createElement('p');
  intro.style.cssText = 'padding:0 var(--space-md); margin:var(--space-md) 0; font-size:14px; color:var(--ink-secondary); line-height:1.6;';
  intro.textContent = 'Lernin is a spaced repetition study app: instead of re-reading notes and hoping it sticks, you review small question-and-answer cards on a schedule that adapts to how well you actually know each one. Cards you find easy come back less often; cards you struggle with come back sooner. It runs entirely on your device — your decks, cards, and study history never leave your phone or computer unless you explicitly export or generate cards.';
  wrap.appendChild(intro);

  const sections = [
    {
      title: 'Getting cards into a deck',
      body: `Two ways to add cards: generate from a PDF/notes (long-press a deck → Import / AI), or add a single card by hand (+ Card). How generation works depends on Settings:
<ul style="margin:8px 0 0; padding-left:18px;">
  <li><strong>Your own Claude or Gemini API key</strong> — one-tap generation.</li>
  <li><strong>"Paste into any AI"</strong> — copy a ready-made prompt into ChatGPT, Claude.ai, Gemini, etc., then paste the JSON result back in.</li>
</ul>
Either way, you review, edit, or discard cards before they’re saved.`
    },
    {
      title: 'Formula cards and relationships',
      body: `Formula cards have extra fields: the expression, variables, assumptions, common mistakes, and applications. Any card can be linked as <strong>Depends on</strong> or <strong>Related</strong>. Open Cards on a deck to browse, search by answer (reverse lookup), and manage relationships — including cards in other decks.`
    },
    {
      title: 'Why you bring your own AI key',
      body: `Card generation costs money per use. You connect your own Claude or Gemini key, or use free paste-into-any-AI mode. Your key stays on your device and is only sent to the provider you chose when generating cards — never stored on a Lernin server.`
    },
    {
      title: 'Reviewing cards',
      body: `Each card shows a question first; flip it to reveal the answer, then grade honestly:
<ul style="margin:8px 0 0; padding-left:18px;">
  <li><strong>Again</strong> — didn’t know it.</li>
  <li><strong>Hard</strong> — got it, but it took effort.</li>
  <li><strong>Good</strong> — knew it comfortably.</li>
  <li><strong>Easy</strong> — trivial; see it much later.</li>
</ul>
The schedule only works well if grades reflect how easily the answer came back.`
    },
    {
      title: 'Leeches, streaks, map & concept graph',
      body: `Cards you keep missing get suspended as leeches so they don’t clog the queue. Streaks count consecutive study days; freezes (earned every 7-day streak) can protect a miss. Map view shows decks as islands; Concept Map shows cards and relationships inside a deck.`
    },
    {
      title: 'Documents, export, and privacy',
      body: `When you generate from a source, Lernin keeps the filename and an AI summary — not the original file. Course Recap stitches those summaries for a quick pre-exam read. Export a full backup (with progress) or a share copy (cards only). Import always creates a new deck. By default nothing leaves your device except text you deliberately send to an AI provider when generating cards.`
    }
  ];

  const list = document.createElement('div');
  list.style.cssText = 'padding:0 var(--space-md);';

  // Fix #7: Refactor unescaped innerHTML templating to construct elements securely via DOM parsing
  for (const section of sections) {
    const details = document.createElement('details');
    details.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); margin-bottom:8px; box-shadow:var(--shadow-sm); overflow:hidden;';
    
    const summary = document.createElement('summary');
    summary.style.cssText = 'padding:12px 14px; font-size:14px; font-weight:600; color:var(--ink); cursor:pointer;';
    summary.textContent = section.title; // Safe extraction

    const bodyDiv = document.createElement('div');
    bodyDiv.style.cssText = 'padding:0 14px 14px; font-size:13px; color:var(--ink-secondary); line-height:1.6;';
    // innerHTML is safe here because 'sections' is a trusted, hardcoded array within this scope.
    bodyDiv.innerHTML = section.body; 

    details.appendChild(summary);
    details.appendChild(bodyDiv);
    list.appendChild(details);
  }

  wrap.appendChild(list);
  root.appendChild(wrap);
}

async function renderStats() {
  let stats;
  try {
    stats = await getDashboardStats();
  } catch (err) {
    showToast('Failed to load statistics.');
    return navigate('/');
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="statsBack" aria-label="Back">←</button>
    <div class="app-header-title">Statistics</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#statsBack').addEventListener('click', goBack);

  const metricsGrid = document.createElement('div');
  metricsGrid.style.cssText = 'display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; padding:var(--space-md);';

  // Fix #10: Loose equality check (`!= null`) safely catches undefined
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
      <div style="font-size:22px; font-weight:700; color:var(--ink);">${m.value}</div>
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
        <div style="font-size:14px; font-weight:600; color:var(--ink);">${escapeHtml(d.title)}</div>
        <div style="font-size:12px; color:var(--ink-muted); margin-top:2px;">
          ${d.total} card${d.total === 1 ? '' : 's'} · ${d.mastered} mastered · ${d.dueToday} due today
        </div>
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
    showToast('Failed to load dependencies.');
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
    <div style="padding:0 var(--space-lg) var(--space-lg);">
      <h2 style="font-size:18px; font-weight:700; margin-bottom:var(--space-md); color:var(--ink);">
        ${isEdit ? 'Edit deck' : 'New deck'}
      </h2>

      <label style="display:block; font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:6px;">
        Title
      </label>
      <input type="text" id="deckTitleInput"
        placeholder="e.g. EEE 307 — Field Theory"
        style="width:100%; padding:12px 14px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:16px; margin-bottom:var(--space-md); box-sizing:border-box;"
      />

      <label style="display:block; font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:6px;">
        Territory / course <span style="font-weight:400; color:var(--ink-muted);">(optional)</span>
      </label>
      <input type="text" id="deckTerritoryInput" list="territoryOptions"
        placeholder="e.g. EEE 307"
        style="width:100%; padding:12px 14px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:16px; margin-bottom:var(--space-lg); box-sizing:border-box;"
      />
      <datalist id="territoryOptions">
        ${existingTerritories.map(t => `<option value="${escapeAttr(t)}"></option>`).join('')}
      </datalist>

      <div style="display:flex; gap:10px;">
        <button type="button" id="deckCancelBtn"
          style="flex:1; padding:14px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:15px; font-weight:500; cursor:pointer; box-shadow:var(--shadow-sm);">
          Cancel
        </button>
        <button type="button" id="deckSaveBtn"
          style="flex:1; padding:14px; border:none; border-radius:var(--radius-md); background:var(--accent); color:white; font-size:15px; font-weight:600; cursor:pointer;">
          ${isEdit ? 'Save' : 'Create'}
        </button>
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
      showToast(err.message || 'Could not save deck.');
    }
  });
}

function renderPDFImport(deckId) {
  root.innerHTML = '';
  renderManualJSONImport(root, deckId, () => navigate('/'));
}

async function renderNewCardForm(deckId) {
  let deck;
  try {
    deck = await getDeck(deckId);
  } catch (err) {
    showToast('Failed to load deck data.');
    return goBack();
  }
  
  if (!deck) {
    showToast('Deck not found.');
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="newCardBack" aria-label="Cancel">←</button>
    <div class="app-header-title" style="font-size:16px;">Add card</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#newCardBack').addEventListener('click', goBack);

  const sub = document.createElement('p');
  sub.style.cssText = 'padding:0 var(--space-md); margin:var(--space-sm) 0 var(--space-md); font-size:13px; color:var(--ink-muted);';
  sub.textContent = `Adding to “${deck.title}”`;
  wrap.appendChild(sub);

  const form = document.createElement('form');
  form.style.cssText = 'padding:0 var(--space-md);';

  const typeLabel = document.createElement('div');
  typeLabel.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink-secondary); margin-bottom:8px;';
  typeLabel.textContent = 'Card type';
  form.appendChild(typeLabel);

  const typeRow = document.createElement('div');
  typeRow.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:var(--space-md);';
  const types = [
    { value: 'basic', label: 'Basic (Q&A)' },
    { value: 'cloze', label: 'Cloze' },
    { value: 'formula', label: 'Formula' }
  ];
  for (const t of types) {
    const opt = document.createElement('label');
    opt.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--surface); border-radius:var(--radius-md); cursor:pointer; box-shadow:var(--shadow-sm);';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'card-type';
    radio.value = t.value;
    radio.checked = t.value === 'basic';
    radio.addEventListener('change', updateFieldVisibility);
    opt.appendChild(radio);
    opt.appendChild(document.createTextNode(t.label));
    typeRow.appendChild(opt);
  }
  form.appendChild(typeRow);

  form.appendChild(fieldLabel('Front'));
  const frontInput = document.createElement('textarea');
  frontInput.required = true;
  frontInput.rows = 3;
  styleTextarea(frontInput);
  form.appendChild(frontInput);

  form.appendChild(fieldLabel('Back'));
  const backInput = document.createElement('textarea');
  backInput.rows = 3;
  backInput.placeholder = '(optional for cloze — answer can live in Front via {{c1::...}})';
  styleTextarea(backInput);
  form.appendChild(backInput);

  const formulaSection = document.createElement('div');
  formulaSection.style.cssText = 'display:none; border-left:3px solid var(--accent); padding-left:12px; margin:var(--space-md) 0;';

  formulaSection.appendChild(fieldLabel('Formula'));
  const formulaInput = document.createElement('input');
  formulaInput.type = 'text';
  formulaInput.placeholder = 'e.g. KE = ½mv²  or  KE = \\frac{1}{2}mv^2';
  styleInput(formulaInput);
  formulaSection.appendChild(formulaInput);

  formulaSection.appendChild(fieldLabel('Variables'));
  const variablesList = document.createElement('div');
  variablesList.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:8px;';
  formulaSection.appendChild(variablesList);

  let variableRows = [];
  function addVariableRow() {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:6px;';
    const symbolInput = document.createElement('input');
    symbolInput.type = 'text';
    symbolInput.placeholder = 'symbol';
    symbolInput.style.cssText = 'flex:0 0 80px; padding:8px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:13px;';
    const meaningInput = document.createElement('input');
    meaningInput.type = 'text';
    meaningInput.placeholder = 'meaning';
    meaningInput.style.cssText = 'flex:1; padding:8px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:13px;';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.style.cssText = 'border:none; background:transparent; color:var(--danger); font-size:14px; cursor:pointer; width:28px;';
    removeBtn.addEventListener('click', () => {
      variableRows = variableRows.filter(r => r !== row);
      row.remove();
    });
    row.appendChild(symbolInput);
    row.appendChild(meaningInput);
    row.appendChild(removeBtn);
    variablesList.appendChild(row);
    variableRows.push(row);
  }
  addVariableRow();

  const addVarBtn = document.createElement('button');
  addVarBtn.type = 'button';
  addVarBtn.textContent = '+ Add variable';
  addVarBtn.style.cssText = 'border:1px dashed rgba(0,0,0,0.15); background:transparent; color:var(--ink-muted); border-radius:var(--radius-sm); padding:8px; font-size:13px; cursor:pointer; margin-bottom:12px; width:100%;';
  addVarBtn.addEventListener('click', addVariableRow);
  formulaSection.appendChild(addVarBtn);

  formulaSection.appendChild(fieldLabel('Assumptions'));
  const assumptionsInput = document.createElement('textarea');
  assumptionsInput.rows = 2;
  styleTextarea(assumptionsInput);
  formulaSection.appendChild(assumptionsInput);

  formulaSection.appendChild(fieldLabel('Common mistakes'));
  const mistakesInput = document.createElement('textarea');
  mistakesInput.rows = 2;
  styleTextarea(mistakesInput);
  formulaSection.appendChild(mistakesInput);

  formulaSection.appendChild(fieldLabel('Applications'));
  const applicationsInput = document.createElement('textarea');
  applicationsInput.rows = 2;
  styleTextarea(applicationsInput);
  formulaSection.appendChild(applicationsInput);

  form.appendChild(formulaSection);

  function updateFieldVisibility() {
    const type = form.querySelector('input[name="card-type"]:checked')?.value || 'basic';
    formulaSection.style.display = type === 'formula' ? 'block' : 'none';
    backInput.placeholder = type === 'cloze' ? '(optional — answer can live in Front via {{c1::...}})' : '';
  }

  form.appendChild(fieldLabel('Depends on / related cards (optional)'));
  const relSearchInput = document.createElement('input');
  relSearchInput.type = 'text';
  relSearchInput.placeholder = 'Search cards by front text…';
  styleInput(relSearchInput);
  form.appendChild(relSearchInput);

  const relResultsList = document.createElement('div');
  relResultsList.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:8px;';
  form.appendChild(relResultsList);

  const relAttachedList = document.createElement('div');
  relAttachedList.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin-bottom:var(--space-md);';
  form.appendChild(relAttachedList);

  let attachedRelationships = []; 

  function renderAttached() {
    relAttachedList.innerHTML = '';
    for (const rel of attachedRelationships) {
      const chip = document.createElement('div');
      chip.style.cssText = 'display:flex; align-items:center; gap:6px; background:var(--surface); border-radius:999px; padding:6px 10px; font-size:12px; box-shadow:var(--shadow-sm);';
      chip.innerHTML = `<strong style="color:var(--accent);">${rel.type === 'dependsOn' ? 'Depends on' : 'Related'}</strong> ${escapeHtml(rel.front)} <span style="color:var(--ink-muted);">(${escapeHtml(rel.deckTitle)})</span>`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '✕';
      rm.style.cssText = 'border:none; background:transparent; color:var(--danger); cursor:pointer; font-size:12px;';
      rm.addEventListener('click', () => {
        attachedRelationships = attachedRelationships.filter(r => r !== rel);
        renderAttached();
      });
      chip.appendChild(rm);
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
        if (attachedRelationships.some(r => r.cardId === card.id)) continue;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--surface); border-radius:var(--radius-sm); padding:8px 10px; font-size:13px;';
        row.innerHTML = `<span>${escapeHtml(card.front)} <span style="color:var(--ink-muted);">(${escapeHtml(card.deckTitle)})</span></span>`;
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex; gap:4px; flex-shrink:0;';
        
        const dependsBtn = document.createElement('button');
        dependsBtn.type = 'button';
        dependsBtn.textContent = '+ Depends';
        dependsBtn.style.cssText = 'border:none; background:var(--accent-soft); color:var(--accent); border-radius:999px; padding:4px 10px; font-size:12px; cursor:pointer;';
        dependsBtn.addEventListener('click', () => {
          attachedRelationships.push({ cardId: card.id, front: card.front, deckTitle: card.deckTitle, type: 'dependsOn' });
          renderAttached();
        });
        
        const relatedBtn = document.createElement('button');
        relatedBtn.type = 'button';
        relatedBtn.textContent = '+ Related';
        relatedBtn.style.cssText = 'border:none; background:var(--surface); color:var(--ink-secondary); border-radius:999px; padding:4px 10px; font-size:12px; cursor:pointer; box-shadow:var(--shadow-sm);';
        relatedBtn.addEventListener('click', () => {
          attachedRelationships.push({ cardId: card.id, front: card.front, deckTitle: card.deckTitle, type: 'related' });
          renderAttached();
        });

        btns.appendChild(dependsBtn);
        btns.appendChild(relatedBtn);
        row.appendChild(btns);
        relResultsList.appendChild(row);
      }
    }, 200);
  });

  wrap.appendChild(form);

  async function handleSave(addAnother) {
    const type = form.querySelector('input[name="card-type"]:checked')?.value || 'basic';
    const front = frontInput.value.trim();
    if (!front) {
      showToast('Front text is required.');
      frontInput.focus();
      return;
    }

    const cardData = { deckId: deck.id, front, back: backInput.value.trim(), type };

    if (type === 'formula') {
      cardData.formula = formulaInput.value.trim();
      cardData.variables = variableRows
        .map(row => ({
          symbol: row.querySelector('input:first-child').value.trim(),
          meaning: row.querySelectorAll('input')[1].value.trim()
        }))
        .filter(v => v.symbol || v.meaning);
      cardData.assumptions = assumptionsInput.value.trim();
      cardData.commonMistakes = mistakesInput.value.trim();
      cardData.applications = applicationsInput.value.trim();
    }

    try {
      const newCardId = await saveManualCard(cardData);
      for (const rel of attachedRelationships) {
        await addRelationship(newCardId, rel.cardId, rel.type);
      }
      showToast('Card added.');
      if (addAnother) {
        await renderNewCardForm(deckId);
      } else {
        goBack();
      }
    } catch (err) {
      showToast(err.message || 'Could not save card.');
    }
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'padding:0 var(--space-md); display:flex; flex-direction:column; gap:10px; margin-top:var(--space-md);';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save card';
  saveBtn.style.cssText = 'width:100%; padding:14px; border:none; border-radius:var(--radius-md); background:var(--accent); color:white; font-size:15px; font-weight:600; cursor:pointer;';
  saveBtn.addEventListener('click', () => handleSave(false));
  actions.appendChild(saveBtn);

  const saveAndAddBtn = document.createElement('button');
  saveAndAddBtn.type = 'button';
  saveAndAddBtn.textContent = 'Save & add another';
  saveAndAddBtn.style.cssText = 'width:100%; padding:14px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:14px; font-weight:500; cursor:pointer; box-shadow:var(--shadow-sm);';
  saveAndAddBtn.addEventListener('click', () => handleSave(true));
  actions.appendChild(saveAndAddBtn);

  wrap.appendChild(actions);
  root.appendChild(wrap);

  function fieldLabel(text) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin:10px 0 4px;';
    el.textContent = text;
    return el;
  }
  function styleTextarea(el) {
    el.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; box-sizing:border-box; margin-bottom:4px;';
  }
  function styleInput(el) {
    el.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; box-sizing:border-box; margin-bottom:8px;';
  }
}

async function renderCardBrowser(deckId) {
  let deck, cards;
  try {
    deck = await getDeck(deckId);
    if (!deck) throw new Error('Deck not found');
    cards = await getCardsByDeck(deck.id);
  } catch (err) {
    showToast('Failed to load cards.');
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="cardsBack" aria-label="Back">←</button>
    <div class="app-header-title" style="font-size:16px;">Cards (${cards.length})</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#cardsBack').addEventListener('click', goBack);

  const sub = document.createElement('p');
  sub.style.cssText = 'padding:0 var(--space-md); margin:var(--space-sm) 0; font-size:13px; color:var(--ink-muted);';
  sub.textContent = deck.title;
  wrap.appendChild(sub);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '🔍 Reverse lookup: search by answer, formula, or note…';
  searchInput.style.cssText = 'display:block; width:calc(100% - 32px); margin:0 var(--space-md) var(--space-md); padding:12px 14px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font-size:14px; box-sizing:border-box;';
  wrap.appendChild(searchInput);

  const typeLabels = { basic: 'Basic', cloze: 'Cloze', formula: 'Formula' };
  const listContainer = document.createElement('div');
  listContainer.style.cssText = 'padding:0 var(--space-md);';
  wrap.appendChild(listContainer);

  function renderDeckCardList() {
    listContainer.innerHTML = '';
    if (cards.length === 0) {
      listContainer.innerHTML = `<p style="color:var(--ink-muted); font-size:14px; text-align:center; padding:var(--space-xl) 0;">No cards in this deck yet.</p>`;
      return;
    }
    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    for (const card of cards) {
      list.appendChild(buildCardRow(card, deck, () => renderCardDetailView(deck, card)));
    }
    listContainer.appendChild(list);
  }

  async function renderSearchResults(query) {
    listContainer.innerHTML = '';
    try {
      const results = await searchCardsByAnswer(query);
      if (results.length === 0) {
        listContainer.innerHTML = `<p style="color:var(--ink-muted); font-size:14px; text-align:center; padding:var(--space-xl) 0;">No cards found with that in their answer.</p>`;
        return;
      }
      const list = document.createElement('div');
      list.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
      for (const result of results) {
        const row = buildCardRow(result, null, async () => {
          const resultDeck = result.deckId === deck.id ? deck : await getDeck(result.deckId);
          const resultCard = await getCard(result.id);
          if (resultDeck && resultCard) renderCardDetailView(resultDeck, resultCard);
        });
        if (result.deckTitle) {
          const frontSpan = row.querySelector('.card-row-front');
          if (frontSpan) frontSpan.innerHTML += ` <span style="color:var(--ink-muted); font-size:12px;">(${escapeHtml(result.deckTitle)})</span>`;
        }
        list.appendChild(row);
      }
      listContainer.appendChild(list);
    } catch(err) {
      showToast('Search failed.');
    }
  }

  function buildCardRow(card, _deck, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = 'display:flex; align-items:center; gap:10px; width:100%; text-align:left; padding:12px 14px; border:none; background:var(--surface); border-radius:var(--radius-md); box-shadow:var(--shadow-sm); cursor:pointer; color:var(--ink); font-size:14px;';
    const badge = document.createElement('span');
    badge.style.cssText = 'flex-shrink:0; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; background:var(--accent-soft); color:var(--accent); text-transform:uppercase;';
    badge.textContent = typeLabels[card.type] || 'Basic';
    const front = document.createElement('span');
    front.className = 'card-row-front';
    front.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    front.textContent = card.front;
    row.appendChild(badge);
    row.appendChild(front);
    row.addEventListener('click', onClick);
    return row;
  }

  renderDeckCardList();

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const query = searchInput.value.trim();
    searchDebounce = setTimeout(() => {
      if (query) renderSearchResults(query);
      else renderDeckCardList();
    }, 200);
  });

  root.appendChild(wrap);
}

async function renderCardDetailView(deck, card) {
  let depsFrom, depsTo, allDecks;
  try {
    [depsFrom, depsTo, allDecks] = await Promise.all([
      getRelationshipsFrom(card.id),
      getRelationshipsTo(card.id),
      getDecks()
    ]);
  } catch (err) {
    showToast('Failed to load card details.');
    return;
  }
  
  const deckTitleById = new Map(allDecks.map(d => [d.id, d.title]));

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="detailBack" aria-label="Back">←</button>
    <div class="app-header-title" style="font-size:16px;">Card detail</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#detailBack').addEventListener('click', () => renderCardBrowser(deck.id));

  const content = document.createElement('div');
  content.style.cssText = 'padding:var(--space-md);';
  content.innerHTML = `
    <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Front</div>
    <div style="font-size:15px; line-height:1.6; color:var(--ink); margin-bottom:var(--space-md); word-break:break-word;">${escapeHtml(card.front)}</div>
    <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Back</div>
    <div style="font-size:15px; line-height:1.6; color:var(--ink); margin-bottom:var(--space-md); word-break:break-word;">${card.back ? escapeHtml(card.back) : '<em style="color:var(--ink-muted);">(none)</em>'}</div>
  `;
  wrap.appendChild(content);

  if (card.type === 'formula') {
    const formulaBlock = document.createElement('div');
    formulaBlock.style.cssText = 'padding:0 var(--space-md) var(--space-md);';
    formulaBlock.innerHTML = renderFormulaDetailFields(card);
    wrap.appendChild(formulaBlock);
  }

  const dependsOnList = depsFrom.filter(r => r.type === 'dependsOn');
  const dependedOnByList = depsTo.filter(r => r.type === 'dependsOn');
  const relatedList = [...depsFrom.filter(r => r.type === 'related'), ...depsTo.filter(r => r.type === 'related')];

  wrap.appendChild(buildRelationshipSection('Depends on', dependsOnList, deck, card, deckTitleById));
  wrap.appendChild(buildRelationshipSection('Depended on by', dependedOnByList, deck, card, deckTitleById));
  wrap.appendChild(buildRelationshipSection('Related', relatedList, deck, card, deckTitleById));
  wrap.appendChild(buildAddRelationshipSection(deck, card));

  root.appendChild(wrap);
  if (typeof renderMath === 'function') renderMath(wrap);
}

function renderFormulaDetailFields(card) {
  let html = '';
  if (card.formula) {
    html += `<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Formula</div>`;
    html += `<div style="font-family:var(--font-mono); font-size:15px; color:var(--ink); margin-bottom:var(--space-md);">$$${escapeHtml(card.formula)}$$</div>`;
  }
  if (Array.isArray(card.variables) && card.variables.length > 0) {
    const items = card.variables
      .filter(v => v.symbol || v.meaning || v.name || v.description)
      .map(v => {
        const sym = v.symbol || v.name || '';
        const mean = v.meaning || v.description || '';
        return `<li><strong>${escapeHtml(sym)}</strong> — ${escapeHtml(mean)}</li>`;
      })
      .join('');
    if (items) {
      html += `<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Variables</div>`;
      html += `<ul style="margin:0 0 var(--space-md); padding-left:20px; font-size:14px; color:var(--ink); line-height:1.6;">${items}</ul>`;
    }
  }
  if (card.assumptions) {
    html += `<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Assumptions</div>`;
    html += `<div style="font-size:14px; color:var(--ink); margin-bottom:var(--space-md); line-height:1.5;">${escapeHtml(card.assumptions)}</div>`;
  }
  if (card.commonMistakes) {
    html += `<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Common mistakes</div>`;
    html += `<div style="font-size:14px; color:var(--ink); margin-bottom:var(--space-md); line-height:1.5;">${escapeHtml(card.commonMistakes)}</div>`;
  }
  if (card.applications) {
    html += `<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-muted); margin-bottom:4px;">Applications</div>`;
    html += `<div style="font-size:14px; color:var(--ink); margin-bottom:var(--space-md); line-height:1.5;">${escapeHtml(card.applications)}</div>`;
  }
  return html;
}

function buildRelationshipSection(title, rels, deck, card, deckTitleById) {
  const section = document.createElement('div');
  section.style.cssText = 'padding:0 var(--space-md) var(--space-md);';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink); margin-bottom:8px;';
  heading.textContent = `${title} (${rels.length})`;
  section.appendChild(heading);

  if (rels.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:13px; color:var(--ink-muted); margin:0;';
    empty.textContent = 'None yet.';
    section.appendChild(empty);
    return section;
  }

  for (const rel of rels) {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex; align-items:center; gap:8px; background:var(--surface); border-radius:var(--radius-md); padding:10px 12px; margin-bottom:6px; box-shadow:var(--shadow-sm); font-size:13px;';

    if (rel.targetMissing || rel.sourceMissing) {
      chip.innerHTML = `<em style="color:var(--ink-muted);">(deleted card)</em>`;
    } else {
      const navBtn = document.createElement('button');
      navBtn.type = 'button';
      navBtn.style.cssText = 'border:none; background:none; color:var(--accent); font-size:13px; font-weight:500; cursor:pointer; text-align:left; padding:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      navBtn.textContent = rel.front;
      navBtn.addEventListener('click', async () => {
        const targetDeck = await getDeck(rel.deckId);
        const targetCard = await getCard(rel.cardId);
        if (targetDeck && targetCard) renderCardDetailView(targetDeck, targetCard);
      });
      chip.appendChild(navBtn);

      const deckLabel = document.createElement('span');
      deckLabel.style.cssText = 'color:var(--ink-muted); font-size:12px; flex-shrink:0;';
      deckLabel.textContent = `(${deckTitleById.get(rel.deckId) || 'Unknown'})`;
      chip.appendChild(deckLabel);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.style.cssText = 'border:none; background:transparent; color:var(--danger); cursor:pointer; font-size:14px; flex-shrink:0;';
    removeBtn.addEventListener('click', async () => {
      await removeRelationship(rel.id);
      showToast('Relationship removed.');
      renderCardDetailView(deck, card);
    });
    chip.appendChild(removeBtn);

    section.appendChild(chip);
  }
  return section;
}

function buildAddRelationshipSection(deck, card) {
  const section = document.createElement('div');
  section.style.cssText = 'padding:0 var(--space-md) var(--space-md);';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:13px; font-weight:600; color:var(--ink); margin-bottom:8px;';
  heading.textContent = 'Add a relationship';
  section.appendChild(heading);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search cards by their front text…';
  searchInput.style.cssText = 'width:100%; padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:var(--radius-sm); background:var(--surface); color:var(--ink); font-size:14px; box-sizing:border-box; margin-bottom:8px;';
  section.appendChild(searchInput);

  const resultsList = document.createElement('div');
  resultsList.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
  section.appendChild(resultsList);

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const query = searchInput.value.trim();
      resultsList.innerHTML = '';
      if (!query) return;
      const results = await searchCardsByFront(query, card.id);
      for (const result of results) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--surface); border-radius:var(--radius-sm); padding:8px 10px; font-size:13px;';
        row.innerHTML = `<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(result.front)} <span style="color:var(--ink-muted);">(${escapeHtml(result.deckTitle)})</span></span>`;
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex; gap:4px; flex-shrink:0;';

        const dependsBtn = document.createElement('button');
        dependsBtn.type = 'button';
        dependsBtn.textContent = '+ Depends';
        dependsBtn.style.cssText = 'border:none; background:var(--accent-soft); color:var(--accent); border-radius:999px; padding:4px 10px; font-size:12px; cursor:pointer;';
        dependsBtn.addEventListener('click', async () => {
          await addRelationship(card.id, result.id, 'dependsOn');
          showToast('Relationship added.');
          renderCardDetailView(deck, card);
        });

        const relatedBtn = document.createElement('button');
        relatedBtn.type = 'button';
        relatedBtn.textContent = '+ Related';
        relatedBtn.style.cssText = 'border:none; background:var(--surface); color:var(--ink-secondary); border-radius:999px; padding:4px 10px; font-size:12px; cursor:pointer; box-shadow:var(--shadow-sm);';
        relatedBtn.addEventListener('click', async () => {
          await addRelationship(card.id, result.id, 'related');
          showToast('Relationship added.');
          renderCardDetailView(deck, card);
        });

        btns.appendChild(dependsBtn);
        btns.appendChild(relatedBtn);
        row.appendChild(btns);
        resultsList.appendChild(row);
      }
    }, 200);
  });

  return section;
}

async function renderDocuments(deckId) {
  let deck, documents;
  try {
    deck = await getDeck(deckId);
    if (!deck) throw new Error('Deck not found.');
    documents = await getDocumentsByDeck(deck.id);
  } catch (err) {
    showToast('Failed to load documents.');
    return goBack();
  }

  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="docsBack" aria-label="Back">←</button>
    <div class="app-header-title" style="font-size:16px;">Documents (${documents.length})</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#docsBack').addEventListener('click', goBack);

  const sub = document.createElement('p');
  sub.style.cssText = 'padding:0 var(--space-md); margin:var(--space-sm) 0 var(--space-md); font-size:13px; color:var(--ink-muted);';
  sub.textContent = deck.title;
  wrap.appendChild(sub);

  if (documents.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'text-align:center; color:var(--ink-muted); font-size:14px; padding:var(--space-xl) var(--space-md);';
    empty.textContent = 'No documents uploaded to this deck yet. Summaries appear here after you generate cards from a PDF or import.';
    wrap.appendChild(empty);
    root.appendChild(wrap);
    return;
  }

  const withSummaries = documents.filter(d => d.summary && d.summary.trim());
  if (withSummaries.length > 0) {
    const recapBtn = document.createElement('button');
    recapBtn.type = 'button';
    recapBtn.style.cssText = 'display:block; width:calc(100% - 32px); margin:0 var(--space-md) var(--space-md); padding:14px; border:none; border-radius:var(--radius-md); background:var(--accent-soft); color:var(--accent); font-size:15px; font-weight:600; cursor:pointer; text-align:center;';
    recapBtn.textContent = '📖 Course Recap — 5 min read';
    recapBtn.addEventListener('click', () => renderCourseRecapView(deck, withSummaries));
    wrap.appendChild(recapBtn);
  }

  const list = document.createElement('div');
  list.style.cssText = 'padding:0 var(--space-md); display:flex; flex-direction:column; gap:8px;';

  for (const doc of documents) {
    list.appendChild(buildDocumentRow(deck, doc));
  }

  wrap.appendChild(list);
  root.appendChild(wrap);
}

function renderCourseRecapView(deck, documents) {
  root.innerHTML = '';
  root.style.padding = '0';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:560px; margin:0 auto; padding-bottom:var(--space-2xl);';

  const header = document.createElement('div');
  header.className = 'app-header';
  header.innerHTML = `
    <button class="icon-btn" id="recapBack" aria-label="Back">←</button>
    <div class="app-header-title" style="font-size:16px;">Course Recap</div>
    <div style="width:40px;"></div>
  `;
  wrap.appendChild(header);
  header.querySelector('#recapBack').addEventListener('click', () => navigate(`/documents/${deck.id}`));

  const intro = document.createElement('p');
  intro.style.cssText = 'padding:0 var(--space-md); margin:var(--space-md) 0; font-size:13px; color:var(--ink-muted); line-height:1.5;';
  intro.textContent = `A quick recap of everything uploaded to “${deck.title}”, built from ${documents.length} document summar${documents.length === 1 ? 'y' : 'ies'} — meant to be skimmed in a few minutes before an exam.`;
  wrap.appendChild(intro);

  for (const doc of documents) {
    const section = document.createElement('div');
    section.style.cssText = 'margin:0 var(--space-md) var(--space-lg); padding:var(--space-md); background:var(--surface); border-radius:var(--radius-md); box-shadow:var(--shadow-sm);';
    section.innerHTML = `
      <h3 style="font-size:15px; font-weight:600; color:var(--ink); margin-bottom:8px;">${escapeHtml(doc.filename)}</h3>
      <div style="font-size:14px; color:var(--ink-secondary); line-height:1.65; white-space:pre-wrap;">${escapeHtml(doc.summary)}</div>
    `;
    wrap.appendChild(section);
  }

  root.appendChild(wrap);
}

function buildDocumentRow(deck, doc) {
  const row = document.createElement('div');
  row.style.cssText = 'background:var(--surface); border-radius:var(--radius-md); box-shadow:var(--shadow-sm); overflow:hidden;';

  const top = document.createElement('div');
  top.style.cssText = 'display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:14px;';

  const content = document.createElement('div');
  content.style.cssText = 'flex:1; min-width:0;';
  content.innerHTML = `
    <div style="font-size:14px; font-weight:600; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(doc.filename)}</div>
    <div style="font-size:12px; color:var(--ink-muted); margin-top:2px;">${formatFileSize(doc.size || 0)} · uploaded ${formatUploadDate(doc.uploadedAt)}</div>
  `;
  top.appendChild(content);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:6px; flex-shrink:0;';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.style.cssText = 'border:none; background:var(--accent-soft); color:var(--accent); border-radius:999px; padding:6px 12px; font-size:12px; font-weight:500; cursor:pointer;';
  viewBtn.textContent = 'View summary';
  actions.appendChild(viewBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.style.cssText = 'border:none; background:var(--danger-soft); color:var(--danger); border-radius:999px; padding:6px 12px; font-size:12px; font-weight:500; cursor:pointer;';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    try {
      await deleteDocument(doc.id);
      showToast('Document deleted.');
      await renderDocuments(deck.id);
    } catch(err) {
      showToast('Failed to delete document');
    }
  });
  actions.appendChild(deleteBtn);

  top.appendChild(actions);
  row.appendChild(top);

  const summaryBox = document.createElement('div');
  summaryBox.style.cssText = 'display:none; padding:0 14px 14px; font-size:13px; color:var(--ink-secondary); line-height:1.6; white-space:pre-wrap; border-top:1px solid rgba(0,0,0,0.04); margin-top:0; padding-top:12px;';
  summaryBox.textContent = doc.summary || 'No summary available for this document.';
  row.appendChild(summaryBox);

  viewBtn.addEventListener('click', () => {
    const showing = summaryBox.style.display !== 'none';
    summaryBox.style.display = showing ? 'none' : 'block';
    viewBtn.textContent = showing ? 'View summary' : 'Hide summary';
  });

  return row;
}

async function exportDeck(deckId) {
  const deck = await getDeck(deckId);
  if (!deck) {
    showToast('Deck not found.');
    return;
  }
  openExportSheet(deck);
}

function openExportSheet(deck) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  document.body.appendChild(backdrop);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Export deck');

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div style="padding:0 var(--space-lg) var(--space-lg);">
      <h2 style="font-size:18px; font-weight:700; margin-bottom:8px; color:var(--ink);">
        Export “${escapeHtml(deck.title)}”
      </h2>
      <p style="font-size:13px; color:var(--ink-muted); margin-bottom:var(--space-md); line-height:1.5;">
        Choose what to include in the file.
      </p>

      <label style="display:flex; align-items:flex-start; gap:10px; padding:12px 14px; background:var(--surface); border-radius:var(--radius-md); cursor:pointer; box-shadow:var(--shadow-sm); margin-bottom:8px;">
        <input type="radio" name="export-mode" value="full" checked style="margin-top:3px;" />
        <span>
          <strong style="display:block; font-size:14px; color:var(--ink);">Full backup</strong>
          <span style="font-size:12px; color:var(--ink-muted);">Includes your study progress</span>
        </span>
      </label>

      <label style="display:flex; align-items:flex-start; gap:10px; padding:12px 14px; background:var(--surface); border-radius:var(--radius-md); cursor:pointer; box-shadow:var(--shadow-sm); margin-bottom:var(--space-lg);">
        <input type="radio" name="export-mode" value="share" style="margin-top:3px;" />
        <span>
          <strong style="display:block; font-size:14px; color:var(--ink);">Share copy</strong>
          <span style="font-size:12px; color:var(--ink-muted);">Cards only — no progress (for sending to someone else)</span>
        </span>
      </label>

      <div style="display:flex; gap:10px;">
        <button type="button" id="exportCancelBtn"
          style="flex:1; padding:14px; border:none; border-radius:var(--radius-md); background:var(--surface); color:var(--ink-secondary); font-size:15px; font-weight:500; cursor:pointer; box-shadow:var(--shadow-sm);">
          Cancel
        </button>
        <button type="button" id="exportConfirmBtn"
          style="flex:1; padding:14px; border:none; border-radius:var(--radius-md); background:var(--accent); color:white; font-size:15px; font-weight:600; cursor:pointer;">
          Export
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(sheet);

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
  sheet.querySelector('#exportCancelBtn').addEventListener('click', closeSheet);

  let startY = 0;
  sheet.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientY - startY > 80) closeSheet();
  }, { passive: true });

  sheet.querySelector('#exportConfirmBtn').addEventListener('click', async () => {
    const mode = sheet.querySelector('input[name="export-mode"]:checked')?.value || 'full';
    closeSheet();
    try {
      await downloadDeckExport(deck, mode === 'full');
    } catch (err) {
      showToast(err.message || 'Export failed.');
    }
  });
}

async function downloadDeckExport(deck, includeProgress) {
  try {
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
  } catch(err) {
    showToast('Failed to export deck');
  }
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
      showToast(`Imported “${parsed.deck.title}” — ${result.cardCount} card${result.cardCount === 1 ? '' : 's'}.`);
      navigate('/');
    } catch (err) {
      showToast(
        err.message?.includes('JSON')
          ? 'That file isn’t valid JSON.'
          : (err.message || 'Import failed.')
      );
    }
  });
  input.click();
}

/* ---------- Init ---------- */
initTheme();
window.addEventListener('hashchange', handleRoute);
handleRoute(); // Trigger correct view on first load
