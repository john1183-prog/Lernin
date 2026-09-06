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
 * Repairs backslashes inside JSON string values that aren't valid JSON
 * escapes -- overwhelmingly, LaTeX in a "formula" field (\frac, \Delta,
 * \alpha...) that a model emitted with a single backslash instead of the
 * doubled one JSON string syntax actually requires. Two distinct failure
 * modes this fixes, found from a real reported case:
 *   - \Delta, \alpha, etc. -- the letter after the backslash isn't a
 *     valid JSON escape character (only " \ / b f n r t u are) at all, so
 *     JSON.parse throws outright ("Invalid \escape"). Unambiguous to
 *     repair -- there's no reading of this input where it was ever valid.
 *   - \frac, \tau, \nabla, \beta, \rangle -- these start with a letter
 *     (f/t/n/b/r) that *is* a valid JSON escape char (form feed, tab,
 *     newline, backspace, carriage return respectively), so JSON.parse
 *     doesn't error at all -- it silently succeeds with a literal control
 *     character spliced into the string where "\frac" was meant to be,
 *     corrupting formula text without ever surfacing an error. Repaired
 *     via a heuristic: a genuine control-character escape in real card
 *     text is essentially never immediately followed by another letter
 *     continuing what reads as a word (no one's flashcard back legitimately
 *     contains a literal form-feed character followed directly by "rac");
 *     \f/\n/\r/\t/\b immediately followed by [a-zA-Z] gets the same
 *     backslash-doubling treatment. A genuine "\n" used for an intentional
 *     line break is virtually always followed by whitespace, punctuation,
 *     or end-of-string, not directly by more lowercase letters -- left
 *     untouched.
 */
function repairLatexBackslashes(text) {
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  const CONTROL_CHARS = new Set(['b', 'f', 'n', 'r', 't']);
  let result = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) { result += ch; continue; }

      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += text.slice(i, i + 6);
          i += 5;
        } else {
          result += '\\\\u'; // "\u" not followed by 4 hex digits -- not a real unicode escape
          i += 1;
        }
        continue;
      }

      if (VALID_ESCAPES.has(next)) {
        // Real control-char escapes in prose are followed by whatever
        // comes next in the text -- often a capital letter starting a new
        // sentence/line ("Line one\nLine two"). LaTeX command names are
        // near-universally lowercase multi-letter words (frac, tau, beta,
        // nabla...), so requiring 2+ LOWERCASE letters specifically (not
        // just "any letter") is what actually distinguishes "this is
        // probably \tau" from "this is a real newline before a sentence."
        const nextTwo = text.slice(i + 2, i + 4);
        const looksLikeLatexWord = CONTROL_CHARS.has(next) && /^[a-z]{2}/.test(nextTwo);
        if (looksLikeLatexWord) {
          result += '\\\\' + next;
        } else {
          result += ch + next; // genuinely valid escape, leave as-is
        }
        i += 1;
        continue;
      }

      // \D, \a, \e, \g, ... -- not a valid JSON escape under any reading
      result += '\\\\' + next;
      i += 1;
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

  for (const original of candidates) {
    // Applied unconditionally, before the first parse attempt, not as a
    // reactive fallback-on-exception: \frac/\tau/\nabla-style LaTeX
    // collides with valid JSON escape characters (\f, \t, \n...) and
    // JSON.parse does NOT throw on those -- it silently succeeds with a
    // literal control character spliced into the string instead of the
    // intended LaTeX. Waiting for an exception to trigger this repair
    // would never catch that case at all, only the (also real, but
    // separate) class where the backslash is followed by a letter with
    // no valid JSON meaning at all (\Delta, \alpha), which does throw.
    // Verified safe to always apply: a no-op on already-valid JSON,
    // confirmed against real newlines/tabs, already-correct double
    // backslashes, and literal Windows-style paths.
    const candidate = repairLatexBackslashes(original);
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
          try {
            // Real-world broken JSON often has more than one issue at
            // once (unescaped quotes AND a trailing comma, say) — try
            // both remaining repairs composed together as a last resort.
            let fixed = repairUnescapedQuotes(candidate);
            fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
            return JSON.parse(fixed);
          } catch {
            continue;
          }
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
