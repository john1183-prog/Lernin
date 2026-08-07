/* Lernin — Manual JSON Import
   For documents that can't be parsed (scanned PDFs, PowerPoint, images).
   User gives a prompt to an external AI, pastes the JSON response here. */

import { saveNewCards, saveDocument, getCardsByDeck } from './db.js';
import { renderMath, showToast } from './app.js';

function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

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
const MANUAL_IMPORT_REASONS = {
  'direct': {
    icon: '✍️',
    title: 'Starting from a prompt',
    body: "No document needed — copy the prompt below, describe what you want to learn (a language, a topic, anything), run it in any AI chat, and paste the JSON response back here."
  },
  'no-key': {
    icon: '🔑',
    title: "You haven't added an API key yet",
    body: 'Settings → API config lets you add a Claude or Gemini key for one-tap imports. Without one, this free manual mode is how import works: copy a prompt, run it in any AI chat, paste the JSON back.'
  },
  'scanned': {
    icon: '🖼️',
    title: 'This looks image-heavy',
    body: "Our built-in extractor handles text-based PDFs and PowerPoint files automatically, but this one didn't have enough extractable text — likely a scanned document or slides that are mostly images. Add an API key in Settings for automatic AI-vision handling of this, or use manual mode below."
  },
  'extraction-failed': {
    icon: '⚠️',
    title: "Couldn't read this file",
    body: "Text extraction failed — the file may be corrupted or in an unsupported format. You can still get cards from it manually: attach the file directly in any AI chat, then paste the JSON response below."
  },
  'generation-failed': {
    icon: '⚠️',
    title: 'Automatic generation failed',
    body: null // filled in per-call with the specific error
  },
  'empty-result': {
    icon: '📭',
    title: 'Nothing came back',
    body: "Generation ran but didn't find anything to extract from this content — sometimes happens with very short or sparse text. Try the manual flow below instead."
  }
};

export function renderManualJSONImport(container, deckId, onDone, extractedText, filename, reason, reasonDetail) {
  container.innerHTML = '';

  const r = MANUAL_IMPORT_REASONS[reason] || MANUAL_IMPORT_REASONS['no-key'];
  const alertTitle = r.title;
  const alertBody = reason === 'generation-failed' && reasonDetail
    ? `Reason given: "${reasonDetail}". Common causes: an expired or mistyped key, or the provider being temporarily down. Check Settings → API config, or use manual mode below in the meantime.`
    : r.body;

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
        <div class="manual-import-alert-icon">${r.icon}</div>
        <div>
          <strong>${escapeHtmlLocal(alertTitle)}</strong>
          <p style="margin:4px 0 0;color:var(--ink-secondary);">${escapeHtmlLocal(alertBody)}</p>
          <ol class="manual-import-steps">
            <li>Copy the prompt below</li>
            <li>Go to ChatGPT, Claude, or Gemini</li>
            <li>${reason === 'direct' ? 'Paste the prompt, then reply with your topic' : 'Paste the prompt and upload your document'}</li>
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
  if (reason === 'direct') {
    // No document at all — the shared template's opening line and
    // placeholder both assume one, and the textarea is readonly (so a
    // literal unfilled placeholder would get copied verbatim). Swap in
    // wording that works when pasted into any AI chat and continued
    // with the person's own topic as their next message.
    promptValue = AI_PROMPT_TEXT
      .replace(
        'I will upload a document (PDF, PowerPoint, scanned images, or any file type).',
        "I'll tell you a topic, language, or skill I want to learn — no document, just a description."
      )
      .replace(
        '## What I am uploading\n\n[Paste your document content or describe what you are uploading]',
        "## What I want flashcards for\n\n[Reply to this message with your topic — e.g. \"Spanish present-tense verbs\" or \"key dates of the French Revolution\" — and any specifics: skill level, focus areas, how many cards.]"
      );
  } else if (extractedText) {
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
        id: (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/* ---------------- JSON Parser with Repair Heuristics ----------------
   Ported from an earlier, more robust version (see UPCOMING_FEATURES.md
   for why this replaced a simpler parser that regressed during the big
   UI/UX rewrite). Handles cases the simple fence-strip + naive quote
   swap missed: zero-width Unicode from mobile clipboards, curly/smart
   quotes used as JSON structural delimiters (vs. legitimately inside
   prose), and preamble/trailing text around the JSON block. */

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
 * order — a fenced ```json block, a fenced ``` block with no language
 * tag, a balanced {...} span found anywhere in the text, a greedy
 * first-{-to-last-} span (handles preamble/trailing prose an anchored
 * fence match would reject), and finally the raw text as-is.
 */
function extractJsonCandidate(rawText) {
  // Strip invisible/zero-width Unicode that mobile clipboards commonly
  // insert: BOM, ZWNJ, ZWJ, ZWSP, soft hyphen, directional marks, etc.
  // Non-breaking space -> regular space so JSON whitespace rules apply.
  // Curly/smart quotes used as structural JSON delimiters (i.e. the
  // whole response was auto-typographied by the source AI) are
  // normalized to straight quotes; ones legitimately inside a string as
  // prose are left alone since JSON.parse handles those fine.
  let t = rawText
    .replace(/\uFEFF|\u200B|\u200C|\u200D|\u00AD|\u200E|\u200F|[\u202A-\u202E]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/(?<=[:,\[{\s]|^)\u201C/gm, '"')
    .replace(/\u201D(?=\s*[:,\]},\n]|$)/gm, '"');

  const trimmed = t.trim();
  const candidates = [];

  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonFence) candidates.push(jsonFence[1]);

  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence && anyFence[1] !== jsonFence?.[1]) candidates.push(anyFence[1]);

  // Balanced-brace scan — only straight double-quotes (U+0022) toggle
  // inString, since normalization above converted structural curly
  // quotes already. Any curly quotes that survived are prose content.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '\u0022') { inString = !inString; continue; }
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

  // Greedy span: first { to last } — handles the common "preamble
  // before the JSON block" case when there's no nested-brace ambiguity.
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
        try {
          // Trailing commas before a closing bracket — common in
          // AI-generated JSON, not handled by the ported logic above.
          return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1'));
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}

function parseAndRepairJSON(raw) {
  const data = extractJsonCandidate(raw);
  if (data === undefined) {
    return { ok: false, error: 'That doesn\u2019t look like valid JSON. Make sure you copied the model\u2019s full response, including the opening { and closing }.' };
  }
  return { ok: true, data };
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
