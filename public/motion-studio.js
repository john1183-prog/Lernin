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

import { createPlayer } from './motion-player.js';
import { generateMotion } from './motion-api.js';
import { renderMotionManualImport } from './motion-manual-import.js';
import { getApiConfig, getMotionScripts, getMotionScript, getDeck } from './db.js';

export const MOTION_PREFILL_KEY = 'lernin:motionStudioPrefillTopic';

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
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
    <div class="ms-body" style="padding: var(--space-md);">
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

  let player = null;
  let seekRaf = null;

  function setStatus(text, isError = false) {
    statusArea.textContent = text || '';
    statusArea.style.color = isError ? 'var(--danger)' : 'var(--ink-muted)';
  }

  async function playScript(script) {
    manualImportArea.innerHTML = '';
    if (player) player.destroy();
    await waitForKatex();

    stage.style.display = '';
    playerControls.style.display = 'flex';
    stage.style.aspectRatio = `${script.scene.width} / ${script.scene.height}`;

    player = createPlayer(canvas, script);
    seekSlider.max = String(script.scene.duration);
    seekSlider.value = '0';
    timeLabel.textContent = `0.0s / ${script.scene.duration.toFixed(1)}s`;
    playPauseBtn.textContent = '▶️';

    cancelAnimationFrame(seekRaf);
    function tick() {
      if (player && player.playing) {
        seekSlider.value = String(player.currentTime);
        timeLabel.textContent = `${player.currentTime.toFixed(1)}s / ${script.scene.duration.toFixed(1)}s`;
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

  async function refreshScriptList() {
    const scripts = await getMotionScripts(deckId || null);
    if (!scripts.length) {
      scriptList.innerHTML = '<p style="font-size:13px; color:var(--ink-muted);">Nothing saved yet.</p>';
      return;
    }
    scriptList.innerHTML = scripts.map((s) => `
      <div class="ms-script-item" style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border, rgba(0,0,0,0.08)); gap:8px;">
        <strong style="font-size:14px; color:var(--ink); font-weight:600;">${escapeHtmlLocal(s.topic)}</strong>
        <button class="btn-secondary" data-play-id="${s.id}" style="flex-shrink:0;">Play</button>
      </div>`).join('');
    scriptList.querySelectorAll('[data-play-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rec = await getMotionScript(btn.dataset.playId);
        if (rec) { topicInput.value = rec.topic; playScript(rec.script); stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
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
        await playScript(r.script);
        await refreshScriptList();
      },
      () => { manualImportArea.innerHTML = ''; setStatus(''); },
      deckId || null
    );
  }

  async function handleGenerate(retryOfError = null) {
    const topic = topicInput.value.trim();
    if (!topic) return;

    manualImportArea.innerHTML = '';
    generateBtn.disabled = true;
    generateBtn.textContent = retryOfError ? 'Retrying…' : 'Generating…';
    setStatus(retryOfError ? 'Retrying with the error sent back to the model…' : 'Generating…');

    const result = await generateMotion(topic, deckId || null, retryOfError);

    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate';

    if (result.queued) {
      setStatus('Offline — queued. Will retry automatically once back online.');
      return;
    }
    if (result.retryable && !retryOfError) {
      // Same convention as the harness this replaces: one confirmed retry,
      // never automatic — a second generation is a second real cost.
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
    await playScript(result.script);
    await refreshScriptList();
  }

  generateBtn.addEventListener('click', () => handleGenerate());
  topicInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGenerate(); });

  // One-shot pre-fill from a mind-map node's "Explain with motion" action —
  // consumed and cleared immediately so navigating back here later starts blank.
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

  return function destroy() {
    if (player) player.destroy();
    cancelAnimationFrame(seekRaf);
  };
}
