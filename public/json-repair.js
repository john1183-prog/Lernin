/* Lernin — JSON repair parser.
   Extracted from manual-json-import.js: this logic ("pull JSON out of
   arbitrary AI-pasted text") is generic to any manual-paste-JSON flow,
   not card-specific, so it lives here dependency-free rather than in a
   file that also imports app.js for renderMath/showToast — anything
   importing this alone (e.g. motion-manual-import.js) shouldn't drag in
   the whole app's routing as a side effect. */

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

export function parseAndRepairJSON(raw) {
  const data = extractJsonCandidate(raw);
  if (data === undefined) {
    return { ok: false, error: 'That doesn\u2019t look like valid JSON. Make sure you copied the model\u2019s full response, including the opening { and closing }.' };
  }
  return { ok: true, data };
}
