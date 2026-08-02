/* Lernin — Manual JSON Import
   For documents that can't be parsed (scanned PDFs, PowerPoint, images).
   User gives a prompt to an external AI, pastes the JSON response here. */

import { saveNewCards, saveDocument, getCardsByDeck } from './db.js';
import { renderMath, showToast } from './app.js';

const EXAMPLE_JSON = `{
  "summary": "Introduction to Newton's Laws of Motion",
  "cards": [
    {
      "front": "What does Newton's First Law state?",
      "back": "An object remains at rest or in uniform motion unless acted upon by an external force.",
      "type": "basic"
    },
    {
      "front": "F = {{c1::ma}}",
      "back": "Force equals mass times acceleration",
      "type": "cloze"
    }
  ]
}`;

/**
 * Render the manual JSON import view
 * @param {HTMLElement} container — root element to render into
 * @param {string} deckId — target deck ID
 * @param {Function} onDone — callback when import completes
 * @param {string} [extractedText] — optional extracted text to inject into prompt
 * @param {string} [filename] — optional filename for vision-file manual mode
 */
export function renderManualJSONImport(container, deckId, onDone, extractedText, filename) {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'manual-import-view';
  wrap.innerHTML = `
    <div class="app-header">
      <button class="icon-btn" id="miBack" aria-label="Back">←</button>
      <div class="app-header-title">Import from AI</div>
      <div style="width:40px;"></div>
    </div>

    <div class="manual-import-body">
      <div class="manual-import-alert">
        <div class="manual-import-alert-icon">📢</div>
        <div>
          <strong>Have a scanned PDF, PowerPoint, or image?</strong>
          <p style="margin:4px 0 0;color:var(--ink-secondary);">
            Our built-in extractor only works with text-based PDFs.
            For scanned documents, PowerPoints, images, or any other file type:
          </p>
          <ol class="manual-import-steps">
            <li>Copy the prompt below</li>
            <li>Go to ChatGPT, Claude, or Gemini</li>
            <li>Paste the prompt and upload your document</li>
            <li>Copy the JSON response and paste it below</li>
          </ol>
        </div>
      </div>

      <div class="manual-import-section">
        <div class="manual-import-label">
          <span>📝 AI Prompt</span>
          <button class="manual-import-copy" id="copyPrompt">Copy</button>
        </div>
        <textarea class="manual-import-prompt" id="aiPrompt" readonly aria-label="AI prompt to copy"></textarea>
      </div>

      <div class="manual-import-section">
        <div class="manual-import-label">
          <span>📋 Paste JSON Response</span>
          <button class="manual-import-copy" id="pasteExample">Load example</button>
        </div>
        <textarea class="manual-import-json" id="jsonInput" placeholder="Paste the JSON from the AI here..."></textarea>
        <div class="manual-import-hint" id="jsonHint">Waiting for input...</div>
      </div>

      <button class="btn-primary" id="importBtn" style="width:100%;margin-top:var(--space-md);" disabled>
        Import Cards
      </button>
    </div>
  `;
  container.appendChild(wrap);

  // Populate prompt
  const promptEl = wrap.querySelector('#aiPrompt');
  let promptValue = AI_PROMPT_TEXT;
  if (extractedText) {
    promptValue = AI_PROMPT_TEXT.replace(
      '[Paste your document content or describe what you are uploading]',
      extractedText
    );
  } else if (filename) {
    promptValue = AI_PROMPT_TEXT.replace(
      '[Paste your document content or describe what you are uploading]',
      `Upload the file "${filename}" directly to this chat.`
    );
  }
  promptEl.value = promptValue;

  // Copy button
  wrap.querySelector('#copyPrompt').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(promptValue);
      showToast('Prompt copied! Paste it into ChatGPT or Claude.');
    } catch {
      promptEl.select();
      showToast('Prompt selected — press Ctrl+C to copy');
    }
  });

  // Load example
  wrap.querySelector('#pasteExample').addEventListener('click', () => {
    wrap.querySelector('#jsonInput').value = EXAMPLE_JSON;
    validateJSON();
  });

  // Back
  wrap.querySelector('#miBack').addEventListener('click', () => {
    if (onDone) onDone();
  });

  // Live validation
  const jsonInput = wrap.querySelector('#jsonInput');
  const importBtn = wrap.querySelector('#importBtn');
  const hint = wrap.querySelector('#jsonHint');

  jsonInput.addEventListener('input', () => {
    validateJSON();
  });

  function validateJSON() {
    const raw = jsonInput.value.trim();
    if (!raw) {
      hint.textContent = 'Waiting for input...';
      hint.className = 'manual-import-hint';
      importBtn.disabled = true;
      return;
    }

    const result = parseAndRepairJSON(raw);
    if (result.ok) {
      const count = result.data.cards?.length || 0;
      hint.textContent = `✅ Valid JSON — ${count} card${count !== 1 ? 's' : ''} ready to import`;
      hint.className = 'manual-import-hint is-valid';
      importBtn.disabled = false;
    } else {
      hint.textContent = `⚠️ ${result.error}`;
      hint.className = 'manual-import-hint is-error';
      importBtn.disabled = true;
    }
  }

  importBtn.addEventListener('click', async () => {
    const raw = jsonInput.value.trim();
    const result = parseAndRepairJSON(raw);
    if (!result.ok) return;

    const { summary, cards: rawCards } = result.data;
    const existing = await getCardsByDeck(deckId);
    const existingFronts = new Set(existing.map(c => normalizeText(c.front)));

    const newCards = [];
    const skipped = [];

    for (const c of rawCards || []) {
      if (!c.front || !c.back) {
        skipped.push('Missing front/back');
        continue;
      }
      if (existingFronts.has(normalizeText(c.front))) {
        skipped.push('Duplicate: ' + c.front.slice(0, 30));
        continue;
      }
      newCards.push({
        front: c.front,
        back: c.back,
        type: c.type || 'basic',
        formula: c.formula || null,
        variables: c.variables || null,
        assumptions: c.assumptions || null,
        commonMistakes: c.commonMistakes || null,
        applications: c.applications || null
      });
    }

    if (newCards.length === 0) {
      showToast('No new cards to import (all duplicates or invalid)');
      return;
    }

    await saveNewCards(deckId, newCards);
    if (summary) {
      await saveDocument({ id: crypto.randomUUID(), deckId, filename: 'Manual import', summary });
    }

    showToast(`Imported ${newCards.length} card${newCards.length !== 1 ? 's' : ''}${skipped.length ? `, skipped ${skipped.length}` : ''}`);
    if (onDone) onDone();
  });
}

/* ---------------- JSON Parser with Repair Heuristics ---------------- */
function parseAndRepairJSON(raw) {
  // Strip markdown fences
  let cleaned = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();

  // Try direct parse first
  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch {}

  // Repair: trailing commas
  let repaired = cleaned.replace(/,(\s*[}\]])/g, '$1');

  // Repair: single quotes to double (simplistic approach)
  let inString = false;
  let quoteChar = null;
  let result = '';
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    const prev = repaired[i - 1];
    if (!inString && (ch === "'" || ch === '"')) {
      inString = true;
      quoteChar = ch;
      result += '"';
    } else if (inString && ch === quoteChar && prev !== '\\') {
      inString = false;
      quoteChar = null;
      result += '"';
    } else {
      result += ch;
    }
  }
  repaired = result;

  // Try parse again
  try {
    return { ok: true, data: JSON.parse(repaired) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function normalizeText(str) {
  return (str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ---------------- The Prompt Text ---------------- */
const AI_PROMPT_TEXT = `You are a flashcard generator. I will upload a document (PDF, PowerPoint, scanned images, or any file type). Your job is to extract the key concepts and create flashcards in the exact JSON format below.

## Output Format

Return ONLY a valid JSON object. No markdown code fences, no explanations before or after. Just raw JSON.

\`\`\`json
{
  "summary": "One-sentence summary of the document (1-2 lines)",
  "cards": [
    {
      "front": "Question or prompt shown first",
      "back": "Answer or explanation revealed after",
      "type": "basic"
    },
    {
      "front": "The capital of France is {{c1::Paris}}",
      "back": "The capital of France is Paris",
      "type": "cloze"
    },
    {
      "front": "What is the formula for kinetic energy?",
      "back": "Kinetic energy equals one-half mass times velocity squared",
      "type": "formula",
      "formula": "KE = \\frac{1}{2}mv^2",
      "variables": [
        { "name": "KE", "description": "Kinetic energy in joules" },
        { "name": "m", "description": "Mass in kilograms" },
        { "name": "v", "description": "Velocity in meters per second" }
      ],
      "assumptions": "Non-relativistic speeds",
      "commonMistakes": "Forgetting the 1/2 factor",
      "applications": "Calculating energy of moving objects"
    }
  ]
}
\`\`\`

## Rules

1. **Card types:** Use "basic" for standard Q&A, "cloze" for fill-in-the-blank (wrap the hidden word in {{c1::word}}), "formula" for math/equations.
2. **Formula cards:** If the card involves an equation, use "formula" type and include the formula field with LaTeX notation (use \\\\ for backslashes in JSON).
3. **Only include fields you are CERTAIN about.** Leave variables, assumptions, commonMistakes, and applications empty or omitted if you are not sure.
4. **Do not hallucinate.** If a concept is unclear from the document, skip it rather than invent details.
5. **Aim for 10-30 cards** depending on document length. Prioritize high-yield concepts.
6. **Front should force active recall.** Ask questions, don't just state facts.
7. **Back should be concise.** One to three sentences max.

## What I am uploading

[Paste your document content or describe what you are uploading]
`;
