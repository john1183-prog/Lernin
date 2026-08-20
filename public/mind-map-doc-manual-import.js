/* Lernin — Document Mind Map Manual Import
   Mirrors motion-manual-import.js's pattern exactly (which itself mirrors
   manual-json-import.js): show a copyable prompt, let the person paste
   back whatever their own AI chat returned, validate it live, hand the
   parsed object to expandMindMapManual(). Reuses json-repair.js's generic
   parser -- "AI pasted some JSON" parsing isn't specific to any one
   feature. */

import { buildMindMapManualPrompt, expandMindMapManual } from './mind-map-doc-api.js';
import { parseAndRepairJSON } from './json-repair.js';

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/**
 * @param {HTMLElement} container
 * @param {string} text — document text or summary to base the mind map on
 * @param {string} documentId
 * @param {string} source — 'full-text' or 'summary-fallback', passed
 *        through to saveMindMapForDocument via expandMindMapManual
 * @param {string} label — shown in the prompt header (usually the filename)
 * @param {Function} onDone — called with { mindMap, error } on submit
 * @param {Function} [onBack]
 */
export function renderMindMapManualImport(container, text, documentId, source, label, onDone, onBack) {
  container.innerHTML = '';

  const promptValue = buildMindMapManualPrompt(text);

  const wrap = document.createElement('div');
  wrap.className = 'manual-import-view';
  wrap.innerHTML = `
    <div class="app-header">
      <button class="icon-btn" id="mmiBack" aria-label="Back">←</button>
      <div class="app-header-title">Mind Map — Manual Import</div>
      <div style="width:40px;"></div>
    </div>

    <div class="manual-import-body">
      <div class="manual-import-alert">
        <div class="manual-import-alert-icon">🧠</div>
        <div>
          <strong>No API key configured</strong>
          <p style="margin:4px 0 0;color:var(--ink-secondary);">This free manual mode is how Mind Map works without a key: copy the prompt below, run it in any AI chat, paste the JSON response back here.</p>
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
          <span>📝 AI Prompt — "${escapeHtmlLocal(label)}"</span>
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
        Create Mind Map
      </button>
      <button class="manual-import-copy" id="mmiCopyErrorBtn" style="width:100%;margin-top:8px;display:none;">
        Copy error to send back to your AI
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
      wrap.querySelector('#mmiPrompt').select();
    }
  });

  wrap.querySelector('#mmiBack').addEventListener('click', () => {
    if (onBack) onBack();
  });

  const jsonInput = wrap.querySelector('#mmiJsonInput');
  const importBtn = wrap.querySelector('#mmiImportBtn');
  const hint = wrap.querySelector('#mmiJsonHint');
  const copyErrorBtn = wrap.querySelector('#mmiCopyErrorBtn');
  let lastParsed = null;
  let lastRawInput = '';

  jsonInput.addEventListener('input', () => {
    copyErrorBtn.style.display = 'none';
    validateJSON();
  });

  function validateJSON() {
    const raw = jsonInput.value.trim();
    lastParsed = null;
    lastRawInput = raw;
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
    if (!result.data || !result.data.root || typeof result.data.root.title !== 'string') {
      hint.textContent = '⚠️ Valid JSON, but missing a "root" node with a "title" — make sure you copied the full response.';
      hint.className = 'manual-import-hint is-error';
      importBtn.disabled = true;
      return;
    }
    lastParsed = result.data;
    hint.textContent = '✅ Valid JSON — ready to import';
    hint.className = 'manual-import-hint is-valid';
    importBtn.disabled = false;
  }

  importBtn.addEventListener('click', async () => {
    if (!lastParsed) return;
    importBtn.disabled = true;
    importBtn.textContent = 'Validating…';
    copyErrorBtn.style.display = 'none';

    const result = await expandMindMapManual(lastParsed, documentId, source);

    if (result.error) {
      hint.textContent = `⚠️ ${result.error}`;
      hint.className = 'manual-import-hint is-error';
      importBtn.disabled = false;
      importBtn.textContent = 'Create Mind Map';

      copyErrorBtn.style.display = '';
      copyErrorBtn.onclick = async () => {
        const followUp = `This didn't validate — error: ${result.error}\n\nHere's what I sent you before:\n\n${lastRawInput}\n\nPlease fix the issue and return the complete corrected JSON in the same format, with no markdown fences or commentary.`;
        try {
          await navigator.clipboard.writeText(followUp);
          copyErrorBtn.textContent = 'Copied! Paste it back to your AI';
          setTimeout(() => { copyErrorBtn.textContent = 'Copy error to send back to your AI'; }, 2000);
        } catch {
          window.prompt('Copy this and paste it back to your AI:', followUp);
        }
      };
      return;
    }

    if (onDone) onDone(result);
  });
}
