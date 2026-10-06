/* Lernin — Motion Studio (real in-app view)
   Productionizes what motion-test.html proved out: generation via
   generateMotion(), playback via motion-player.js's createPlayer(), manual-
   mode fallback via motion-manual-import.js. This is the actual entry
   point now — motion-test.html stays as a separate, lower-level dev tool
   for testing the pipeline directly, not something a person is meant to
   find.

   Scoped to a deck (matches motionScripts' by_deckId index and the
   existing "Mind Map" deck action's pattern) so generated explainers are
   saved and browsable per deck, same as the card mind map's home.

   Supports an optional one-shot pre-filled topic via sessionStorage
   (see PREFILL_KEY) -- used when arriving from "Explain with motion" on a
   mind-map node, so the topic doesn't have to be retyped. The simple
   two-segment hash router (`/motion/:deckId`) has no room for a third
   piece of state like a topic string in the URL itself, and topics can
   contain characters (/, ?, etc.) that would need escaping if they were
   ever put in the hash -- sessionStorage sidesteps both problems for what
   is genuinely a one-time handoff between two views. */

import { createPlayer, renderScriptThumbnail } from './motion-player.js';
import { generateMotion } from './motion-api.js';
import { renderMotionManualImport } from './motion-manual-import.js';
import { getApiConfig, getMotionScripts, getMotionScript, getDeck, getCardsByDeck, saveNewCards, getActiveDecks } from './db.js';
import { playMotionCue } from './sound.js';
import { MOTION_SOURCE_CARD_KEY, MIND_MAP_FOCUS_CARD_KEY } from './motion-topic.js';
import { extractMotionRecallCards } from './motion-card-extract.js';

export const MOTION_PREFILL_KEY = 'lernin:motionStudioPrefillTopic';

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showMotionToast(message, duration = 3500) {
  if (typeof document === 'undefined' || !document.body) return;
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function waitForKatex() {
  return new Promise((resolve) => {
    if (window.katex) return resolve();
    const check = () => (window.katex ? resolve() : requestAnimationFrame(check));
    check();
  });
}

export async function renderMotionStudio(rootEl, deckId, opts = {}) {
  const onExitCb = opts.onExit || null;
  rootEl.innerHTML = '';
  rootEl.style.padding = '0';

  const deck = deckId ? await getDeck(deckId).catch(() => null) : null;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="app-header">
      <button class="back-btn" id="msBack" aria-label="Back">←</button>
      <div class="app-header-title">Motion Studio${deck ? ` · ${escapeHtmlLocal(deck.title)}` : ''}</div>
      <div style="width:48px;"></div>
    </div>
    <div class="ms-body" style="padding: var(--space-md); max-width: 640px; margin: 0 auto;">
      <div class="ms-row" style="display:flex; gap:var(--space-sm); align-items:flex-start; margin-bottom:var(--space-md);">
        <input class="ms-topic-input" id="msTopicInput" type="text" placeholder="e.g. how a capacitor charges"
               style="flex:1; padding:10px 12px; border-radius:var(--radius-md); border:1px solid var(--ink-secondary); font-size:15px; background:var(--surface); color:var(--ink);" />
        <button class="btn-primary" id="msGenerateBtn">Generate</button>
      </div>
      <div id="msStatusArea" style="font-size:13px; color:var(--ink-muted); margin-bottom:8px;"></div>
      <div id="msManualImportArea"></div>

      <div class="ms-stage" id="msStage" style="display:none; width:100%; background:#000; border-radius:var(--radius-md); overflow:hidden; position:relative;">
        <canvas id="msCanvas" style="display:block; width:100%; height:auto;"></canvas>
      </div>
      <div class="ms-controls" id="msPlayerControls" style="display:none; align-items:center; gap:var(--space-sm); margin-top:8px;">
        <button class="icon-btn" id="msPlayPauseBtn" aria-label="Play/Pause">▶️</button>
        <input type="range" id="msSeekSlider" min="0" max="100" value="0" style="flex:1;" />
        <span id="msTimeLabel" style="font-size:12px; color:var(--ink-muted); white-space:nowrap;">0.0s</span>
      </div>

      <div id="msPostWatchArea"></div>

      <div class="ms-scripts" style="margin-top:var(--space-lg);">
        <div class="ms-scripts-title" style="font-size:14px; font-weight:600; color:var(--ink); margin-bottom:8px;">Saved explainers${deck ? ` for ${escapeHtmlLocal(deck.title)}` : ''}</div>
        <div id="msScriptList"></div>
      </div>
    </div>
  `;
  rootEl.appendChild(wrap);

  wrap.querySelector('#msBack').addEventListener('click', () => {
    if (player) player.destroy();
    if (onExitCb) onExitCb(); else history.back();
  });

  const statusArea = wrap.querySelector('#msStatusArea');
  const manualImportArea = wrap.querySelector('#msManualImportArea');
  const stage = wrap.querySelector('#msStage');
  const canvas = wrap.querySelector('#msCanvas');
  const playerControls = wrap.querySelector('#msPlayerControls');
  const playPauseBtn = wrap.querySelector('#msPlayPauseBtn');
  const seekSlider = wrap.querySelector('#msSeekSlider');
  const timeLabel = wrap.querySelector('#msTimeLabel');
  const topicInput = wrap.querySelector('#msTopicInput');
  const generateBtn = wrap.querySelector('#msGenerateBtn');
  const scriptList = wrap.querySelector('#msScriptList');
  const postWatchArea = wrap.querySelector('#msPostWatchArea');

  let player = null;
  let seekRaf = null;
  let generatingTimer = null;
  let hasShownPostWatchForCurrent = false;
  let currentScript = null;
  let currentScriptId = null;
  let currentTopic = '';

  function setGenerating(isGen, retryOfError = null) {
    if (generatingTimer) {
      clearInterval(generatingTimer);
      generatingTimer = null;
    }

    if (!isGen) {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate';
      const widget = statusArea.querySelector('.ms-generating-widget');
      if (widget) widget.remove();
      return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = retryOfError ? 'Retrying…' : 'Generating…';

    const phrases = retryOfError
      ? [
          'Refining visual script with model feedback…',
          'Recalibrating motion parameters & formulas…',
          'Verifying layout & timings…'
        ]
      : [
          'Drafting visual concept & scene layout…',
          'Synthesizing animations & mathematical curves…',
          'Polishing timing & harmonic motion cues…'
        ];

    let phraseIdx = 0;
    statusArea.innerHTML = `
      <div class="ms-generating-widget">
        <div class="ms-generating-dots" aria-hidden="true">
          <span class="ms-dot ms-dot-1"></span>
          <span class="ms-dot ms-dot-2"></span>
          <span class="ms-dot ms-dot-3"></span>
        </div>
        <div class="ms-generating-text">${escapeHtmlLocal(phrases[0])}</div>
      </div>
    `;

    const textEl = statusArea.querySelector('.ms-generating-text');
    const startTime = Date.now();
    generatingTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      let nextIdx = 0;
      if (elapsed >= 8000) nextIdx = 2;
      else if (elapsed >= 4000) nextIdx = 1;
      if (nextIdx !== phraseIdx && textEl) {
        phraseIdx = nextIdx;
        textEl.style.opacity = '0';
        setTimeout(() => {
          if (textEl) {
            textEl.textContent = phrases[phraseIdx];
            textEl.style.opacity = '1';
          }
        }, 150);
      }
    }, 1000);
  }

  function setStatus(text, isError = false) {
    if (generatingTimer) {
      clearInterval(generatingTimer);
      generatingTimer = null;
    }
    statusArea.innerHTML = '';
    statusArea.textContent = text || '';
    statusArea.style.color = isError ? 'var(--danger)' : 'var(--ink-muted)';
  }

  async function renderBridgeDraftPanel(containerEl, script, topic, initialDeckId, onSavedCb, scriptId = null) {
    containerEl.innerHTML = '';
    const scriptToUse = script || (scriptId ? (await getMotionScript(scriptId))?.script : null) || { scene: { name: topic || 'Recall' }, layers: [] };
    const candidates = extractMotionRecallCards(scriptToUse, topic, { maxCards: 2 });
    if (!candidates.length) {
      showMotionToast("Couldn't extract recall points from this script.");
      return;
    }

    const activeCards = [{ ...candidates[0] }];
    let targetDeckId = initialDeckId || '';
    let activeDecks = [];
    let initialDeckObj = initialDeckId ? await getDeck(initialDeckId).catch(() => null) : null;

    if (!targetDeckId) {
      activeDecks = await getActiveDecks().catch(() => []);
    }

    const panel = document.createElement('div');
    panel.className = 'ms-bridge-panel';

    function getSaveButtonText() {
      const count = activeCards.length;
      const label = count === 1 ? 'Add 1 card' : `Add ${count} cards`;
      if (initialDeckObj) {
        return `${label} to ${initialDeckObj.title}`;
      }
      if (targetDeckId) {
        const d = activeDecks.find(deck => deck.id === targetDeckId);
        return d ? `${label} to ${d.title}` : label;
      }
      return label;
    }

    panel.innerHTML = `
      <div class="ms-bridge-header">
        <div class="ms-bridge-title">
          <span>🌿 Turn into recall card</span>
          <span class="ms-bridge-pill">Daily review queue</span>
        </div>
        <button type="button" class="ms-bridge-close-btn" aria-label="Close">✕</button>
      </div>
      <div class="ms-bridge-sub">We drafted this from your explainer's key points. Tweak or save to your deck.</div>

      ${!initialDeckId ? `
        <div class="ms-bridge-deck-row">
          <label class="ms-bridge-label" for="msDeckSelect-${scriptId || 'post'}">Save to deck:</label>
          <select class="ms-bridge-deck-select" id="msDeckSelect-${scriptId || 'post'}">
            <option value="">-- Choose a deck --</option>
            ${activeDecks.map(d => `<option value="${escapeHtmlLocal(d.id)}">${escapeHtmlLocal(d.title)}</option>`).join('')}
          </select>
        </div>
      ` : ''}

      <div class="ms-bridge-cards-container"></div>

      ${candidates.length > 1 ? `
        <button type="button" class="ms-bridge-add-second-btn">+ Add a second card</button>
      ` : ''}

      <div class="ms-bridge-actions">
        <button type="button" class="btn-primary ms-bridge-save-btn"${!targetDeckId ? ' disabled' : ''}>${escapeHtmlLocal(getSaveButtonText())}</button>
        <button type="button" class="btn-secondary ms-bridge-cancel-btn">Cancel</button>
      </div>
    `;

    const cardsContainer = panel.querySelector('.ms-bridge-cards-container');
    const addSecondBtn = panel.querySelector('.ms-bridge-add-second-btn');
    const saveBtn = panel.querySelector('.ms-bridge-save-btn');
    const cancelBtn = panel.querySelector('.ms-bridge-cancel-btn');
    const closeBtn = panel.querySelector('.ms-bridge-close-btn');
    const deckSelect = panel.querySelector('.ms-bridge-deck-select');

    if (deckSelect) {
      deckSelect.addEventListener('change', () => {
        targetDeckId = deckSelect.value;
        saveBtn.disabled = !targetDeckId;
        saveBtn.textContent = getSaveButtonText();
      });
    }

    function renderCards() {
      cardsContainer.innerHTML = '';
      activeCards.forEach((c, idx) => {
        const cardBox = document.createElement('div');
        cardBox.className = 'ms-bridge-card';
        cardBox.innerHTML = `
          <div class="ms-bridge-card-top">
            <div class="ms-bridge-card-num">Card ${idx + 1}</div>
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="ms-bridge-type-badge">${escapeHtmlLocal((c.type || 'basic').toUpperCase())}</span>
              ${idx > 0 ? `<button type="button" class="ms-bridge-remove-card" title="Remove second card">✕</button>` : ''}
            </div>
          </div>
          <div class="ms-bridge-field">
            <label class="ms-bridge-label">Front (question / prompt)</label>
            <textarea class="ms-bridge-input ms-bridge-front" rows="2">${escapeHtmlLocal(c.front || '')}</textarea>
          </div>
          <div class="ms-bridge-field" style="margin-top:6px;">
            <label class="ms-bridge-label">Back (answer / key takeaway)</label>
            <textarea class="ms-bridge-input ms-bridge-back" rows="2">${escapeHtmlLocal(c.back || '')}</textarea>
          </div>
        `;

        const frontInput = cardBox.querySelector('.ms-bridge-front');
        const backInput = cardBox.querySelector('.ms-bridge-back');
        frontInput.addEventListener('input', () => { c.front = frontInput.value; });
        backInput.addEventListener('input', () => { c.back = backInput.value; });

        if (idx > 0) {
          const removeBtn = cardBox.querySelector('.ms-bridge-remove-card');
          removeBtn.addEventListener('click', () => {
            activeCards.splice(idx, 1);
            renderCards();
            if (addSecondBtn) addSecondBtn.style.display = 'inline-block';
            saveBtn.textContent = getSaveButtonText();
          });
        }

        cardsContainer.appendChild(cardBox);
      });
    }

    renderCards();

    if (addSecondBtn) {
      addSecondBtn.addEventListener('click', () => {
        if (activeCards.length < 2 && candidates[1]) {
          activeCards.push({ ...candidates[1] });
          renderCards();
          addSecondBtn.style.display = 'none';
          saveBtn.textContent = getSaveButtonText();
        }
      });
    }

    function closePanel() {
      containerEl.innerHTML = '';
    }

    cancelBtn.addEventListener('click', closePanel);
    closeBtn.addEventListener('click', closePanel);

    saveBtn.addEventListener('click', async () => {
      if (!targetDeckId) {
        showMotionToast('Please choose a deck first.');
        return;
      }

      const frontInputs = cardsContainer.querySelectorAll('.ms-bridge-front');
      const backInputs = cardsContainer.querySelectorAll('.ms-bridge-back');
      for (let i = 0; i < activeCards.length; i++) {
        if (frontInputs[i]) activeCards[i].front = frontInputs[i].value;
        if (backInputs[i]) activeCards[i].back = backInputs[i].value;
      }

      const emptyCard = activeCards.find(c => !c.front.trim());
      if (emptyCard) {
        showMotionToast('Card question/front cannot be empty.');
        return;
      }

      const cardsToSave = activeCards.map(c => {
        const rec = {
          front: c.front.trim(),
          back: c.back.trim(),
          type: c.type || 'basic',
          sourceInfo: {
            type: 'motion',
            scriptId: scriptId || currentScriptId || null,
            topic: topic || currentTopic || ''
          }
        };
        if (c.type === 'formula' && c.formula) {
          rec.formula = c.formula;
        }
        return rec;
      });

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        await saveNewCards(targetDeckId, cardsToSave);
        let deckName = initialDeckObj?.title;
        if (!deckName) {
          const d = activeDecks.find(dk => dk.id === targetDeckId);
          deckName = d ? d.title : 'deck';
        }
        showMotionToast(`Added ${cardsToSave.length} recall card${cardsToSave.length > 1 ? 's' : ''} to ${deckName}.`);
        closePanel();
        if (onSavedCb) onSavedCb(cardsToSave.length);
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = getSaveButtonText();
        showMotionToast(err.message || 'Failed to save cards.');
      }
    });

    containerEl.appendChild(panel);
  }

  async function showPostWatchCard(watchedTopic = '') {
    postWatchArea.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'ms-post-watch-card';

    const isDeckScoped = !!deck && !!deckId;
    const deckTitle = deck ? deck.title : '';

    let sourceCardId = null;
    try {
      sourceCardId = sessionStorage.getItem(MOTION_SOURCE_CARD_KEY);
    } catch (_) {}
    const hasSourceCard = Boolean(sourceCardId && deckId);

    card.innerHTML = `
      <div class="ms-post-watch-title">Watched to the end! ✨</div>
      <div class="ms-post-watch-prompt">
        ${isDeckScoped
          ? `Explain another part of <strong>${escapeHtmlLocal(deckTitle)}</strong>?`
          : `Ready to explore further? Explain another concept or dive deeper.`}
      </div>
      <div class="ms-post-watch-actions">
        ${hasSourceCard ? `<button class="btn-secondary ms-back-to-card-btn" id="msBackToCardBtn">← Back to card on Mind Map</button>` : ''}
        ${!sourceCardId ? `<button class="btn-secondary ms-study-bridge-btn" id="msStudyBridgeBtn">🌿 Turn into study card</button>` : ''}
        <button class="btn-primary ms-post-watch-cta" id="msPostWatchExplainBtn">Explain another topic</button>
        ${isDeckScoped ? `<button class="ms-suggest-btn" id="msSuggestBtn">💡 Suggest a concept from this deck’s tricky cards</button>` : ''}
        <button class="btn-secondary" id="msReplayBtn" style="font-size:12px; padding:6px 10px;">↺ Replay</button>
      </div>
      <div class="ms-bridge-container" id="msBridgeContainer" style="width:100%;"></div>
      <div class="ms-suggestion-chips" id="msSuggestionChips" style="display:none;"></div>
    `;

    postWatchArea.appendChild(card);

    if (!sourceCardId) {
      const studyBridgeBtn = card.querySelector('#msStudyBridgeBtn');
      if (studyBridgeBtn) {
        studyBridgeBtn.addEventListener('click', async () => {
          const container = card.querySelector('#msBridgeContainer');
          if (!container) return;
          if (container.children.length > 0) {
            container.innerHTML = '';
            return;
          }
          await renderBridgeDraftPanel(
            container,
            currentScript,
            watchedTopic || currentTopic,
            deckId || null,
            () => {
              studyBridgeBtn.textContent = '✓ Added to deck';
              studyBridgeBtn.disabled = true;
            },
            currentScriptId
          );
        });
      }
    }

    if (hasSourceCard) {
      const backToCardBtn = card.querySelector('#msBackToCardBtn');
      if (backToCardBtn) {
        backToCardBtn.addEventListener('click', () => {
          try {
            sessionStorage.setItem(MIND_MAP_FOCUS_CARD_KEY, sourceCardId);
            sessionStorage.removeItem(MOTION_SOURCE_CARD_KEY);
          } catch (_) {}
          if (player) player.destroy();
          window.location.hash = `/mind-map/${deckId}`;
        });
      }
    }

    // Primary action: focus topic input and scroll up smoothly
    card.querySelector('#msPostWatchExplainBtn').addEventListener('click', () => {
      topicInput.value = '';
      topicInput.focus();
      topicInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      topicInput.style.borderColor = 'var(--accent)';
      setTimeout(() => { topicInput.style.borderColor = ''; }, 1200);
    });

    // Replay button
    card.querySelector('#msReplayBtn').addEventListener('click', () => {
      if (player) {
        player.seek(0);
        player.play();
        playPauseBtn.textContent = '⏸️';
      }
    });

    // Secondary affordance (Option C): reveal tricky cards suggestions on click
    if (isDeckScoped) {
      const suggestBtn = card.querySelector('#msSuggestBtn');
      const chipsContainer = card.querySelector('#msSuggestionChips');

      suggestBtn.addEventListener('click', async () => {
        suggestBtn.disabled = true;
        suggestBtn.textContent = 'Finding tricky concepts…';

        let cards = [];
        try {
          cards = await getCardsByDeck(deckId);
        } catch (e) {
          cards = [];
        }

        if (!cards || !cards.length) {
          chipsContainer.style.display = 'flex';
          chipsContainer.innerHTML = `<div style="font-size:12px; color:var(--ink-muted); padding:6px 0;">No cards in this deck yet. Type any topic above!</div>`;
          suggestBtn.style.display = 'none';
          return;
        }

        // Sort by weakest/lowest stability first, then lapses descending
        const sorted = cards.slice().sort((a, b) => {
          const sa = typeof a.stability === 'number' ? a.stability : 0;
          const sb = typeof b.stability === 'number' ? b.stability : 0;
          if (sa !== sb) return sa - sb;
          return (b.lapses || 0) - (a.lapses || 0);
        });

        const chosen = sorted.slice(0, 2);
        chipsContainer.style.display = 'flex';
        chipsContainer.innerHTML = chosen.map((c) => {
          const clean = (c.front || '')
            .replace(/\$\$?[^\$]+\$\$?/g, '')
            .replace(/[#*`_]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 48);
          const topicSuggestion = clean || 'Key concept from card';
          return `
            <button class="ms-suggestion-chip" data-topic="${escapeHtmlLocal(topicSuggestion)}">
              <span>💡</span>
              <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Explain: "${escapeHtmlLocal(topicSuggestion)}"</span>
              <span style="font-size:11px; opacity:0.6;">Tap to set</span>
            </button>
          `;
        }).join('');

        chipsContainer.querySelectorAll('.ms-suggestion-chip').forEach((chip) => {
          chip.addEventListener('click', () => {
            const topic = chip.dataset.topic;
            topicInput.value = topic;
            topicInput.focus();
            topicInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            topicInput.style.borderColor = 'var(--accent)';
            setTimeout(() => { topicInput.style.borderColor = ''; }, 1200);
          });
        });

        suggestBtn.style.display = 'none';
      });
    }
  }

  async function playScript(script, topicName = '', scriptId = null) {
    manualImportArea.innerHTML = '';
    if (player) player.destroy();
    await waitForKatex();

    currentScript = script;
    currentTopic = topicName || script.scene?.name || topicInput.value || '';
    if (scriptId) currentScriptId = scriptId;

    stage.style.display = '';
    playerControls.style.display = 'flex';
    stage.style.aspectRatio = `${script.scene.width} / ${script.scene.height}`;
    hasShownPostWatchForCurrent = false;

    player = createPlayer(canvas, script, {
      onAudioCue: (tone) => playMotionCue(tone),
      onLoopComplete: () => {
        if (!hasShownPostWatchForCurrent) {
          hasShownPostWatchForCurrent = true;
          showPostWatchCard(topicName || script.scene?.name || topicInput.value);
        }
      }
    });

    seekSlider.max = String(script.scene.duration);
    seekSlider.value = '0';
    timeLabel.textContent = `0.0s / ${script.scene.duration.toFixed(1)}s`;
    playPauseBtn.textContent = '▶️';

    cancelAnimationFrame(seekRaf);
    function tick() {
      if (player && player.playing) {
        seekSlider.value = String(player.currentTime);
        timeLabel.textContent = `${player.currentTime.toFixed(1)}s / ${script.scene.duration.toFixed(1)}s`;
        if (!hasShownPostWatchForCurrent && player.currentTime >= script.scene.duration * 0.96) {
          hasShownPostWatchForCurrent = true;
          showPostWatchCard(topicName || script.scene?.name || topicInput.value);
        }
      }
      seekRaf = requestAnimationFrame(tick);
    }
    tick();
  }

  playPauseBtn.addEventListener('click', () => {
    if (!player) return;
    if (player.playing) { player.pause(); playPauseBtn.textContent = '▶️'; }
    else { player.play(); playPauseBtn.textContent = '⏸️'; }
  });

  seekSlider.addEventListener('input', () => {
    if (!player) return;
    player.pause();
    playPauseBtn.textContent = '▶️';
    player.seek(parseFloat(seekSlider.value));
    timeLabel.textContent = `${player.currentTime.toFixed(1)}s / ${player.duration.toFixed(1)}s`;
  });

  async function refreshScriptList(justGeneratedId = null) {
    const scripts = await getMotionScripts(deckId || null);
    if (!scripts.length) {
      scriptList.innerHTML = '<p style="font-size:13px; color:var(--ink-muted);">Nothing saved yet.</p>';
      return;
    }

    scriptList.innerHTML = scripts.map((s) => {
      const isNew = justGeneratedId && s.id === justGeneratedId;
      const duration = s.script?.scene?.duration ? `${s.script.scene.duration.toFixed(1)}s` : '';
      return `
        <div class="ms-script-item ${isNew ? 'ms-item-just-generated' : ''}" data-script-id="${s.id}">
          <div class="ms-script-thumb-wrap">
            <canvas class="ms-script-thumb" id="thumb-${s.id}" width="160" height="90"></canvas>
          </div>
          <div class="ms-script-info">
            <div class="ms-script-title">
              <span>${escapeHtmlLocal(s.topic)}</span>
              ${isNew ? '<span class="ms-badge-new">✨ New</span>' : ''}
            </div>
            <div class="ms-script-meta">${duration ? `${duration} explainer` : 'Explainer'}</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
            <button class="btn-secondary ms-play-btn" data-play-id="${s.id}">Play</button>
            <button class="btn-secondary ms-create-card-btn" data-create-card-id="${s.id}">🌿 Create card</button>
          </div>
          <div class="ms-script-card-drawer" id="msCardDrawer-${s.id}" style="display:none; width:100%;"></div>
        </div>
      `;
    }).join('');

    // Draw preview thumbnail on each canvas
    for (const s of scripts) {
      const canvasEl = scriptList.querySelector(`#thumb-${s.id}`);
      if (canvasEl && s.script) {
        try {
          renderScriptThumbnail(canvasEl, s.script);
        } catch (err) {
          console.warn('Failed to render thumbnail for script', s.id, err);
        }
      }
    }

    scriptList.querySelectorAll('[data-play-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rec = await getMotionScript(btn.dataset.playId);
        if (rec) {
          topicInput.value = rec.topic;
          postWatchArea.innerHTML = '';
          currentScriptId = rec.id;
          await playScript(rec.script, rec.topic, rec.id);
          stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    });

    scriptList.querySelectorAll('[data-create-card-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.createCardId;
        const drawer = scriptList.querySelector(`#msCardDrawer-${sid}`);
        if (!drawer) return;
        if (drawer.style.display !== 'none' && drawer.children.length > 0) {
          drawer.innerHTML = '';
          drawer.style.display = 'none';
          return;
        }
        const rec = await getMotionScript(sid);
        if (rec) {
          drawer.style.display = 'block';
          await renderBridgeDraftPanel(
            drawer,
            rec.script,
            rec.topic,
            rec.deckId || deckId || null,
            () => {
              btn.textContent = '✓ Added';
              btn.disabled = true;
              drawer.innerHTML = '';
              drawer.style.display = 'none';
            },
            rec.id
          );
        }
      });
    });
  }

  function showManualMode(topic) {
    setStatus('No key configured — manual mode: paste the AI response below.');
    renderMotionManualImport(
      manualImportArea, topic,
      async (r) => {
        manualImportArea.innerHTML = '';
        setStatus('');
        currentScriptId = r.id;
        await playScript(r.script, topic, r.id);
        await refreshScriptList(r.id);
        stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
      () => { manualImportArea.innerHTML = ''; setStatus(''); },
      deckId || null
    );
  }

  async function handleGenerate(retryOfError = null) {
    const topic = topicInput.value.trim();
    if (!topic) return;

    manualImportArea.innerHTML = '';
    postWatchArea.innerHTML = '';
    setGenerating(true, retryOfError);

    const result = await generateMotion(topic, deckId || null, retryOfError);

    setGenerating(false);

    if (result.queued) {
      setStatus('Offline — queued. Will retry automatically once back online.');
      return;
    }
    if (result.retryable && !retryOfError) {
      const wantsRetry = window.confirm(
        `The AI's script didn't come out right:\n\n${result.error}\n\n` +
        `Ask it to try again with that error as feedback? This uses a second generation.`
      );
      if (wantsRetry) { await handleGenerate(result.error); return; }
      setStatus(result.error, true);
      return;
    }
    if (result.error) {
      if (result.status === 401) showManualMode(topic);
      else setStatus(result.error, true);
      return;
    }

    setStatus('');
    currentScriptId = result.id;
    await playScript(result.script, topic, result.id);
    await refreshScriptList(result.id);
    stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  generateBtn.addEventListener('click', () => handleGenerate());
  topicInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGenerate(); });

  const prefill = sessionStorage.getItem(MOTION_PREFILL_KEY);
  if (prefill) {
    sessionStorage.removeItem(MOTION_PREFILL_KEY);
    topicInput.value = prefill;
  }

  const config = await getApiConfig();
  const hasByok = !!(config && config.apiKey && (config.provider === 'claude' || config.provider === 'gemini'));
  setStatus(hasByok
    ? `Using your ${config.provider} key from Settings.`
    : 'No key configured — will try Lernin\u2019s free quota first, then fall back to manual mode.');
  await refreshScriptList();

  if (prefill) {
    await handleGenerate();
  } else {
    topicInput.focus();
  }

  if (typeof window !== 'undefined') {
    window.__motionDebug = {
      setGenerating,
      showPostWatchCard,
      refreshScriptList,
      playScript,
      getPlayer: () => player,
      getCurrentScript: () => currentScript,
      getCurrentScriptId: () => currentScriptId,
      setCurrentScript: (s, id, t) => { currentScript = s; currentScriptId = id; currentTopic = t; },
      renderBridgeDraftPanel
    };
  }

  return function destroy() {
    if (generatingTimer) clearInterval(generatingTimer);
    if (player) player.destroy();
    cancelAnimationFrame(seekRaf);
  };
}

