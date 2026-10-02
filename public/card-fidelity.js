/**
 * card-fidelity.js
 *
 * Lightweight, client-side, dependency-free deterministic grounding check for flashcards.
 * Verifies whether key terms, numbers, entities, or formula variables generated on a card
 * appear in the document source text available in memory at review time.
 *
 * Platform invariants:
 * - Pure vanilla JS; zero dependencies.
 * - Flag only: never rewrites or alters user-visible card text.
 * - Leaves FSRS fields and scheduling completely untouched.
 * - Rescuing, empathetic tone: "Double-check source" rather than "error" or "invalid".
 */

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any',
  'are', 'aren\'t', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'can\'t', 'cannot', 'could', 'couldn\'t',
  'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t',
  'have', 'haven\'t', 'having', 'he', 'he\'d', 'he\'ll', 'he\'s', 'her', 'here',
  'here\'s', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'how\'s', 'i',
  'i\'d', 'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into', 'is', 'isn\'t', 'it',
  'it\'s', 'its', 'itself', 'let\'s', 'me', 'more', 'most', 'mustn\'t', 'my',
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shan\'t',
  'she', 'she\'d', 'she\'ll', 'she\'s', 'should', 'shouldn\'t', 'so', 'some',
  'such', 'than', 'that', 'that\'s', 'the', 'their', 'theirs', 'them', 'themselves',
  'then', 'there', 'there\'s', 'these', 'they', 'they\'d', 'they\'ll', 'they\'re',
  'they\'ve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up',
  'very', 'was', 'wasn\'t', 'we', 'we\'d', 'we\'ll', 'we\'re', 'we\'ve', 'were',
  'weren\'t', 'what', 'what\'s', 'when', 'when\'s', 'where', 'where\'s', 'which',
  'while', 'who', 'who\'s', 'whom', 'why', 'why\'s', 'with', 'won\'t', 'would',
  'wouldn\'t', 'you', 'you\'d', 'you\'ll', 'you\'re', 'you\'ve', 'your', 'yours',
  'yourself', 'yourselves', 'define', 'explain', 'describe', 'state', 'meaning',
  'true', 'false', 'question', 'answer'
]);

/**
 * Checks whether normalized target text contains a specific term (case-insensitive,
 * respecting word boundaries for single alphanumeric words).
 */
export function containsTerm(sourceLower, term) {
  if (!term) return true;
  const termLower = String(term).toLowerCase().trim();
  if (!termLower) return true;

  // Single alphanumeric word: use word boundary search
  if (/^[a-z0-9]+$/i.test(termLower)) {
    const re = new RegExp(`\\b${termLower}\\b`, 'i');
    return re.test(sourceLower);
  }

  // Phrase or symbol: direct substring inclusion
  return sourceLower.includes(termLower);
}

/**
 * Extracts masked answers from Anki/Lernin cloze syntax: {{c1::answer}} or {{c1::answer::hint}}
 */
export function extractClozeTerms(text) {
  if (!text) return [];
  const terms = [];
  const regex = /\{\{c\d+::([^}]+)\}\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1];
    const answer = raw.split('::')[0].trim();
    if (answer) {
      terms.push(answer);
    }
  }
  return terms;
}

/**
 * Inspects a card against sourceText (and optional chunkText) to verify grounding.
 * Returns { flagged: boolean, reason: string | null }.
 *
 * @param {object} card - Flashcard object (front, back, type, formula, variables, etc.)
 * @param {string} sourceText - Full or chunked source document text
 * @param {object} [options] - Optional settings (e.g. { chunkText, chunks })
 * @returns {{ flagged: boolean, reason: string | null }}
 */
export function checkCardFidelity(card, sourceText, options = {}) {
  if (!card || typeof card !== 'object') {
    return { flagged: false, reason: null };
  }

  // Skip silently if no usable source text is available
  if (!sourceText || typeof sourceText !== 'string' || !sourceText.trim()) {
    return { flagged: false, reason: null };
  }

  const fullSourceLower = sourceText.toLowerCase();

  // If a specific chunk is identified and available, check chunk first
  let chunkSourceLower = null;
  if (options.chunkText && typeof options.chunkText === 'string') {
    chunkSourceLower = options.chunkText.toLowerCase();
  } else if (options.chunks && Array.isArray(options.chunks) && card.sourceInfo && card.sourceInfo.chunkIndex) {
    const chunk = options.chunks[card.sourceInfo.chunkIndex - 1];
    if (chunk && typeof chunk === 'string') {
      chunkSourceLower = chunk.toLowerCase();
    }
  }

  // Helper to test if text is present in the chunk or fallback to full source
  function termInSource(term) {
    if (chunkSourceLower && containsTerm(chunkSourceLower, term)) {
      return true;
    }
    return containsTerm(fullSourceLower, term);
  }

  const cardType = (card.type || 'basic').toLowerCase();

  // 1. Cloze cards
  const clozeTerms = [
    ...extractClozeTerms(card.front),
    ...extractClozeTerms(card.back)
  ];
  if (cardType === 'cloze' || clozeTerms.length > 0) {
    if (clozeTerms.length > 0) {
      for (const term of clozeTerms) {
        if (!termInSource(term)) {
          return {
            flagged: true,
            reason: `Cloze term "${term}" was not found in the source reading.`
          };
        }
      }
      return { flagged: false, reason: null };
    }
  }

  // 2. Formula cards
  if (cardType === 'formula' || card.formula) {
    if (card.variables && Array.isArray(card.variables) && card.variables.length > 0) {
      for (const v of card.variables) {
        const sym = (v.symbol || v.name || '').trim();
        const meaning = (v.meaning || v.description || '').trim();
        const symMatches = sym ? termInSource(sym) : false;
        const meaningMatches = meaning ? termInSource(meaning) : false;

        // If neither the variable symbol nor its descriptive name appears, flag it
        if (!symMatches && !meaningMatches && (sym || meaning)) {
          return {
            flagged: true,
            reason: `Formula variable "${sym || meaning}" was not found in the source reading.`
          };
        }
      }
    }
  }

  // 3. Basic & General cards
  // Check answer facts, numbers, dates, and proper nouns on the back
  const backText = card.back || '';
  const frontText = card.front || '';

  // Extract explicit numbers / dates / percentages from back
  const numbersOnBack = backText.match(/\b\d+(?:\.\d+)?%?\b/g) || [];
  for (const num of numbersOnBack) {
    if (!termInSource(num)) {
      return {
        flagged: true,
        reason: `Answer quantity or number "${num}" was not found in the source reading.`
      };
    }
  }

  // Extract proper nouns / capitalized multi-letter entities from back
  const capitalizedOnBack = (backText.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [])
    .filter(w => !STOPWORDS.has(w.toLowerCase()));

  if (capitalizedOnBack.length > 0) {
    let anyFound = false;
    for (const ent of capitalizedOnBack) {
      if (termInSource(ent)) {
        anyFound = true;
        break;
      }
    }
    if (!anyFound) {
      return {
        flagged: true,
        reason: `Key entity "${capitalizedOnBack[0]}" was not found in the source reading.`
      };
    }
  }

  // Extract content words of substantive length (>= 5 chars, non-stopwords) from back
  const contentWordsBack = (backText.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
    .filter(w => !STOPWORDS.has(w));

  if (contentWordsBack.length >= 2) {
    let matchedCount = 0;
    for (const w of contentWordsBack) {
      if (termInSource(w)) {
        matchedCount++;
      }
    }
    // If none of the substantive answer words appear anywhere in source text, flag
    if (matchedCount === 0) {
      return {
        flagged: true,
        reason: 'Key answer terms were not found in the source reading.'
      };
    }
  } else if (contentWordsBack.length === 1) {
    // Single-word substantive answer: check front and back
    const singleWord = contentWordsBack[0];
    if (!termInSource(singleWord)) {
      const frontWords = (frontText.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
        .filter(w => !STOPWORDS.has(w));
      const frontMatched = frontWords.some(w => termInSource(w));
      if (!frontMatched) {
        return {
          flagged: true,
          reason: `Answer term "${singleWord}" was not found in the source reading.`
        };
      }
    }
  }

  return { flagged: false, reason: null };
}

/**
 * Convenience helper to check an array of cards and stamp `card.fidelityFlag`
 * on unverified items.
 *
 * @param {Array<object>} cards
 * @param {string} sourceText
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function checkCardsFidelity(cards, sourceText, options = {}) {
  if (!Array.isArray(cards)) return cards;
  if (!sourceText || typeof sourceText !== 'string' || !sourceText.trim()) return cards;

  for (const card of cards) {
    if (!card) continue;
    // If previously dismissed by user, preserve their decision
    if (card.fidelityFlag && card.fidelityFlag.status === 'dismissed') continue;

    const res = checkCardFidelity(card, sourceText, options);
    if (res.flagged) {
      card.fidelityFlag = {
        status: 'unverified',
        reason: res.reason,
        flaggedAt: Date.now()
      };
    } else if (card.fidelityFlag && card.fidelityFlag.status === 'unverified') {
      delete card.fidelityFlag;
    }
  }

  return cards;
}
