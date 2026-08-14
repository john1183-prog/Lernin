/* Lernin — Motion Studio Manual Import
   Mirrors manual-json-import.js's pattern exactly: show a copyable prompt,
   let the person paste back whatever their own AI chat returned, validate
   it live, and hand the parsed object to expandMotionScriptManual().
   Reuses manual-json-import.js's JSON-repair parser rather than
   duplicating it — that parsing logic (fenced blocks, smart quotes,
   trailing commas, preamble text) is generic to "AI pasted some JSON",
   not card-specific. */

import { buildMotionManualPrompt, expandMotionScriptManual } from './motion-api.js';
import { parseAndRepairJSON } from './json-repair.js';

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/**
 * @param {HTMLElement} container — root element to render into
 * @param {string} topic — the topic this script is for (used in the
 *        prompt text and as the saved record's label)
 * @param {Function} onDone — called with { script, id, error } once the
 *        person submits (error is null on success)
 * @param {Function} [onBack] — called if the person backs out without submitting
 */
export function renderMotionManualImport(container, topic, onDone, onBack) {
  container.innerHTML = '';

  const promptValue = buildMotionManualPrompt(topic);

  const wrap = document.createElement('div');
  wrap.className = 'manual-import-view';
  wrap.innerHTML = `
    <div class="app-header">
      <button class="icon-btn" id="mmiBack" aria-label="Back">←</button>
      <div class="app-header-title">Motion Studio — Manual Import</div>
      <div style="width:40px;"></div>
    </div>

    <div class="manual-import-body">
      <div class="manual-import-alert">
        <div class="manual-import-alert-icon">🎬</div>
        <div>
          <strong>No API key configured</strong>
          <p style="margin:4px 0 0;color:var(--ink-secondary);">This free manual mode is how Motion Studio works without a key: copy the prompt below, run it in any AI chat, paste the JSON response back here.</p>
          <ol class="manual-import-steps">
            <li>Copy the prompt below</li>
            <li>Go to ChatGPT, Claude, or Gemini</li>
            <li>Paste the prompt as-is</li>
            <li>Copy the JSON response and paste it below</li>
          </ol>
        </div>
      </div>

      <div class="manual-import-section">
        <div class="manual-import-label">
          <span>📝 AI Prompt — "${escapeHtmlLocal(topic)}"</span>
          <button class="manual-import-copy" id="mmiCopyPrompt">Copy</button>
        </div>
        <textarea class="manual-import-prompt" id="mmiPrompt" readonly aria-label="AI prompt to copy"></textarea>
      </div>

      <div class="manual-import-section">
        <div class="manual-import-label">
          <span>📋 Paste JSON Response</span>
        </div>
        <textarea class="manual-import-json" id="mmiJsonInput" placeholder="Paste the JSON from the AI here..."></textarea>
        <div class="manual-import-hint" id="mmiJsonHint">Waiting for input...</div>
      </div>

      <button class="btn-primary" id="mmiImportBtn" style="width:100%;margin-top:var(--space-md);" disabled>
        Create Animation
      </button>
    </div>
  `;
  container.appendChild(wrap);

  wrap.querySelector('#mmiPrompt').value = promptValue;

  wrap.querySelector('#mmiCopyPrompt').addEventListener('click', async () => {
    const btn = wrap.querySelector('#mmiCopyPrompt');
    try {
      await navigator.clipboard.writeText(promptValue);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    } catch {
      const el = wrap.querySelector('#mmiPrompt');
      el.select();
    }
  });

  wrap.querySelector('#mmiBack').addEventListener('click', () => {
    if (onBack) onBack();
  });

  const jsonInput = wrap.querySelector('#mmiJsonInput');
  const importBtn = wrap.querySelector('#mmiImportBtn');
  const hint = wrap.querySelector('#mmiJsonHint');
  let lastParsed = null;

  jsonInput.addEventListener('input', validateJSON);

  function validateJSON() {
    const raw = jsonInput.value.trim();
    lastParsed = null;
    if (!raw) {
      hint.textContent = 'Waiting for input...';
      hint.className = 'manual-import-hint';
      importBtn.disabled = true;
      return;
    }

    const result = parseAndRepairJSON(raw);
    if (!result.ok) {
      hint.textContent = `⚠️ ${result.error}`;
      hint.className = 'manual-import-hint is-error';
      importBtn.disabled = true;
      return;
    }
    if (!result.data || !result.data.scene || !Array.isArray(result.data.layers)) {
      hint.textContent = '⚠️ Valid JSON, but missing "scene" or "layers" — make sure you copied the full response.';
      hint.className = 'manual-import-hint is-error';
      importBtn.disabled = true;
      return;
    }
    lastParsed = result.data;
    hint.textContent = `✅ Valid JSON — ${result.data.layers.length} layer${result.data.layers.length !== 1 ? 's' : ''} ready`;
    hint.className = 'manual-import-hint is-valid';
    importBtn.disabled = false;
  }

  importBtn.addEventListener('click', async () => {
    if (!lastParsed) return;
    importBtn.disabled = true;
    importBtn.textContent = 'Validating…';

    const result = await expandMotionScriptManual(lastParsed, topic);

    if (result.error) {
      hint.textContent = `⚠️ ${result.error}`;
      hint.className = 'manual-import-hint is-error';
      importBtn.disabled = false;
      importBtn.textContent = 'Create Animation';
      return;
    }

    if (onDone) onDone(result);
  });
}
