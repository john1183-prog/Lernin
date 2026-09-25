// motion-topic.js — Explain with Motion (Card Mind Map) Phase 1
//
// Pure deterministic local topic resolver that transforms a flashcard record
// (`formula`, `cloze`, `basic`, or empty fallback) into a clean Motion Studio
// topic prompt without any network or LLM calls.
//
// Platform Invariants:
//   - Zero imports from `app.js` or DOM-dependent modules.
//   - Zero mutation of input `card` objects (safe on frozen records).

const CLOZE_TAG_REGEX = /\{\{c\d+::([\s\S]*?)(?:::(?:[\s\S]*?))?\}\}/gi;
const CLOZE_DETECT_REGEX = /\{\{c\d+::/i;

const REFERENTIAL_PHRASE_REGEX =
  /\b(?:(?:this|that|these|those)\s+(?:reaction|process|equation|formula|step|structure|stage|mechanism|diagram|graph|figure|table|law|theorem|principle|pathway|cycle|system|method|curve|cell|organelle|molecule|force|layer|concept|phenomenon)|the\s+above|the\s+following|shown\s+above|shown\s+below|in\s+figure\s+\d+|in\s+the\s+diagram|from\s+page\s+\d+|as\s+shown\s+in)\b/i;

const BARE_PRONOUN_START_REGEX = /^(?:it|they|this|that|these|those|he|she)\b/i;

/**
 * Normalizes whitespace and trims a string safely.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWhitespace(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Strips outer display/inline LaTeX math delimiters (`$$...$$` or `$...$`)
 * and trims whitespace.
 *
 * @param {unknown} rawFormula
 * @returns {string}
 */
export function cleanFormulaText(rawFormula) {
  const trimmed = normalizeWhitespace(rawFormula);
  if (!trimmed) return '';
  return trimmed
    .replace(/^\$\$([\s\S]*)\$\$$/, '$1')
    .replace(/^\$([\s\S]*)\$$/, '$1')
    .trim();
}

/**
 * Capitalizes the first character of a non-empty string while leaving the rest intact.
 *
 * @param {string} str
 * @returns {string}
 */
function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Strips common flashcard quiz question stems ("What is the...", "Define...",
 * "How does...", trailing `?`, fill-in-the-blank underscores) to produce a
 * clean topic phrase suitable for Motion Studio.
 *
 * @param {string} rawText
 * @returns {string}
 */
export function stripQuizQuestionStem(rawText) {
  let text = normalizeWhitespace(rawText);
  if (!text) return '';

  // Remove fill-in-the-blank underscores (`____`)
  text = text.replace(/_{2,}/g, '').trim();

  // Preserve semantic framing for "difference between X and Y"
  const diffMatch = text.match(
    /^(?:what|which)\s+(?:is|are|was|were)\s+(?:the\s+|an?\s+)?(?:main\s+|key\s+)?(difference|distinction)s?\s+between\s+([\s\S]+)$/i
  );
  if (diffMatch) {
    text = `Difference between ${diffMatch[2]}`;
  } else {
    // Preserve semantic framing for "role/mechanism/function/purpose/effect of X"
    const roleMatch = text.match(
      /^(?:what|which)\s+(?:is|are|was|were)\s+(?:the\s+|an?\s+)?(?:primary\s+|main\s+|key\s+)?(role|mechanism|function|purpose|effect|impact|significance|cause)\s+of\s+([\s\S]+)$/i
    );
    if (roleMatch) {
      text = `${capitalizeFirst(roleMatch[1].toLowerCase())} of ${roleMatch[2]}`;
    } else {
      // Strip generic interrogative prefixes
      const stemPatterns = [
        /^(?:what|which)\s+(?:is|are|was|were)\s+(?:meant\s+by|defined\s+as)\s+(?:the\s+|an?\s+)?/i,
        /^(?:what|which)\s+(?:is|are|was|were)\s+(?:the\s+|an?\s+)?(?:definition|meaning)\s+of\s+(?:the\s+|an?\s+)?/i,
        /^(?:what|which)\s+(?:is|are|was|were)\s+(?:the\s+|an?\s+)?/i,
        /^(?:how)\s+(?:does|do|did)\s+([\s\S]+)$/i,
        /^(?:why)\s+(?:does|do|did|is|are)\s+([\s\S]+)$/i,
        /^(?:define|explain|describe|state|list|name|identify|summarize|outline|compare\s+and\s+contrast|compare|contrast|give\s+an?\s+example\s+of|calculate|derive)\s+(?:the\s+|an?\s+)?/i
      ];

      for (const pattern of stemPatterns) {
        if (pattern.source.startsWith('^(?:how)')) {
          const m = text.match(pattern);
          if (m) {
            text = `How ${m[1]}`;
            break;
          }
        } else if (pattern.source.startsWith('^(?:why)')) {
          const m = text.match(pattern);
          if (m) {
            text = `Why ${m[1]}`;
            break;
          }
        } else if (pattern.test(text)) {
          text = text.replace(pattern, '');
          break;
        }
      }
    }
  }

  // Strip trailing question marks, colons, or periods
  text = text.replace(/[?:.]+$/g, '').trim();
  return capitalizeFirst(text);
}

/**
 * Parses Anki-style cloze deletions (`{{c1::answer}}` and `{{c2::answer::hint}}`).
 * Returns the deduplicated list of blanked terms and the reconstructed full sentence.
 *
 * @param {string} rawFront
 * @returns {{ terms: string[], cleanSentence: string }}
 */
export function parseClozeMarkup(rawFront) {
  const source = normalizeWhitespace(rawFront);
  if (!source) return { terms: [], cleanSentence: '' };

  const terms = [];
  const seenLower = new Set();

  const replaced = source.replace(CLOZE_TAG_REGEX, (_, answer) => {
    const cleanAns = normalizeWhitespace(answer);
    if (cleanAns) {
      const key = cleanAns.toLowerCase();
      if (!seenLower.has(key)) {
        seenLower.add(key);
        terms.push(cleanAns);
      }
    }
    return cleanAns || '';
  });

  const cleanSentence = normalizeWhitespace(replaced).replace(/[?]+$/g, '').trim();
  return { terms, cleanSentence };
}

/**
 * Evaluates whether a resolved candidate phrase is thin or referential
 * (e.g. dangling "this reaction", single-token fragment, or bare symbol).
 *
 * @param {string} rawFront
 * @param {string} corePhrase
 * @returns {{ isThin: boolean, thinReason: string | null }}
 */
export function assessTopicThinness(rawFront, corePhrase) {
  const raw = normalizeWhitespace(rawFront);
  const phrase = normalizeWhitespace(corePhrase);

  if (!raw && !phrase) {
    return { isThin: true, thinReason: 'empty_front' };
  }

  if (REFERENTIAL_PHRASE_REGEX.test(raw) || REFERENTIAL_PHRASE_REGEX.test(phrase)) {
    return { isThin: true, thinReason: 'referential_fragment' };
  }

  const words = phrase.split(/\s+/).filter(Boolean);
  if (BARE_PRONOUN_START_REGEX.test(phrase) && words.length <= 7) {
    return { isThin: true, thinReason: 'referential_fragment' };
  }

  if (phrase.length < 10 || words.length < 2) {
    return { isThin: true, thinReason: 'too_short' };
  }

  return { isThin: false, thinReason: null };
}

/**
 * Pure deterministic topic extractor for the Card-Based Mind Map's "Explain with motion" action.
 * Does NOT make any network or LLM calls, and NEVER mutates the input `card`.
 *
 * @param {object|null|undefined} card - Flashcard record from IndexedDB
 * @param {string|{deckTitle?: string}} [deckTitleOrOpts=''] - Optional deck title for context fallback
 * @returns {{
 *   topic: string,
 *   sourceBranch: 'formula' | 'cloze' | 'basic' | 'fallback',
 *   isThin: boolean,
 *   thinReason: string | null
 * }}
 */
export function resolveCardMotionTopic(card, deckTitleOrOpts = '') {
  const deckTitle =
    typeof deckTitleOrOpts === 'string'
      ? normalizeWhitespace(deckTitleOrOpts)
      : normalizeWhitespace(deckTitleOrOpts?.deckTitle || '');

  const rawFront = normalizeWhitespace(card?.front || '');
  const rawBack = normalizeWhitespace(card?.back || '');
  const rawFormula = cleanFormulaText(card?.formula || '');
  const cardType = typeof card?.type === 'string' ? card.type.toLowerCase().trim() : 'basic';

  // -------------------------------------------------------------------------
  // Branch 1: Formula Card (`type === 'formula'` or non-empty `card.formula`)
  // -------------------------------------------------------------------------
  const isFormulaCard = cardType === 'formula' || rawFormula.length > 0;
  if (isFormulaCard) {
    const varList = Array.isArray(card?.variables) ? card.variables : [];
    const formattedVars = [];
    for (const v of varList) {
      if (!v || typeof v !== 'object') continue;
      const sym = normalizeWhitespace(v.symbol || v.name || '');
      const meaning = normalizeWhitespace(v.meaning || v.description || v.label || '');
      if (sym && meaning) {
        formattedVars.push(`${sym} (${meaning})`);
      } else if (meaning) {
        formattedVars.push(meaning);
      } else if (sym) {
        formattedVars.push(sym);
      }
    }

    const cleanedFront = stripQuizQuestionStem(rawFront);
    const hasDistinctFront =
      cleanedFront.length > 0 &&
      cleanedFront.toLowerCase() !== rawFormula.toLowerCase();

    if (formattedVars.length > 0) {
      const varSummary = formattedVars.slice(0, 4).join(', ');
      let topic = '';
      if (hasDistinctFront && rawFormula) {
        topic = `${cleanedFront}: ${rawFormula} — relating ${varSummary}`;
      } else if (hasDistinctFront) {
        topic = `${cleanedFront} — relating ${varSummary}`;
      } else if (rawFormula) {
        topic = `Formula ${rawFormula} — relating ${varSummary}`;
      } else {
        topic = `Relationship between ${varSummary}`;
      }
      return {
        topic,
        sourceBranch: 'formula',
        isThin: false,
        thinReason: null
      };
    }

    // Formula card WITHOUT variables
    if (hasDistinctFront && rawFormula) {
      const thinCheck = assessTopicThinness(rawFront, cleanedFront);
      return {
        topic: `${cleanedFront} (${rawFormula})`,
        sourceBranch: 'formula',
        isThin: thinCheck.isThin,
        thinReason: thinCheck.thinReason
      };
    }

    if (rawFormula) {
      const isBareFormula = rawFormula.length < 12;
      const topic = deckTitle
        ? `Visualizing ${rawFormula} (${deckTitle})`
        : `Visualizing formula: ${rawFormula}`;
      return {
        topic,
        sourceBranch: 'formula',
        isThin: isBareFormula,
        thinReason: isBareFormula ? 'bare_formula_without_variables' : null
      };
    }

    if (hasDistinctFront) {
      const thinCheck = assessTopicThinness(rawFront, cleanedFront);
      const topic = thinCheck.isThin && deckTitle ? `${cleanedFront} (${deckTitle})` : cleanedFront;
      return {
        topic,
        sourceBranch: 'formula',
        isThin: thinCheck.isThin,
        thinReason: thinCheck.thinReason
      };
    }
    // If both front and formula are empty on a type:'formula' card, fall through to fallback
  }

  // -------------------------------------------------------------------------
  // Branch 2: Cloze Card (`type === 'cloze'` or contains `{{cN::...}}` markup)
  // -------------------------------------------------------------------------
  const hasClozeMarkup = CLOZE_DETECT_REGEX.test(rawFront);
  if ((cardType === 'cloze' || hasClozeMarkup) && rawFront.length > 0) {
    const { terms, cleanSentence } = parseClozeMarkup(rawFront);
    if (terms.length > 0) {
      const joinedTerms = terms.join(', ');
      const sentenceMatchesTermsOnly =
        cleanSentence.toLowerCase() === terms.join(' ').toLowerCase();
      const corePhrase = sentenceMatchesTermsOnly
        ? joinedTerms
        : `${joinedTerms} — ${cleanSentence}`;
      const thinCheck = assessTopicThinness(cleanSentence, cleanSentence || joinedTerms);
      const topic =
        thinCheck.isThin && deckTitle && !corePhrase.includes(deckTitle)
          ? `${corePhrase} (${deckTitle})`
          : corePhrase;
      return {
        topic,
        sourceBranch: 'cloze',
        isThin: thinCheck.isThin,
        thinReason: thinCheck.thinReason
      };
    }

    if (cleanSentence.length > 0) {
      const stripped = stripQuizQuestionStem(cleanSentence);
      const thinCheck = assessTopicThinness(cleanSentence, stripped);
      const topic =
        thinCheck.isThin && deckTitle && !stripped.includes(deckTitle)
          ? `${stripped} (${deckTitle})`
          : stripped;
      return {
        topic,
        sourceBranch: 'cloze',
        isThin: thinCheck.isThin,
        thinReason: thinCheck.thinReason
      };
    }
  }

  // -------------------------------------------------------------------------
  // Branch 3: Basic Card (non-empty `front`)
  // -------------------------------------------------------------------------
  if (rawFront.length > 0) {
    const stripped = stripQuizQuestionStem(rawFront) || rawFront;
    const thinCheck = assessTopicThinness(rawFront, stripped);
    const topic =
      thinCheck.isThin && deckTitle && !stripped.toLowerCase().includes(deckTitle.toLowerCase())
        ? `${stripped} (${deckTitle})`
        : stripped;
    return {
      topic,
      sourceBranch: 'basic',
      isThin: thinCheck.isThin,
      thinReason: thinCheck.thinReason
    };
  }

  // -------------------------------------------------------------------------
  // Branch 4: Empty Front Fallback (`sourceBranch: 'fallback'`)
  // -------------------------------------------------------------------------
  const backSnippet = rawBack
    ? stripQuizQuestionStem(rawBack).slice(0, 72).trim()
    : '';
  let fallbackTopic = 'Core concept visual explainer';
  if (deckTitle && backSnippet) {
    fallbackTopic = `${deckTitle}: ${backSnippet}`;
  } else if (deckTitle) {
    fallbackTopic = `${deckTitle} — core concept overview`;
  } else if (backSnippet) {
    fallbackTopic = backSnippet;
  }

  return {
    topic: fallbackTopic,
    sourceBranch: 'fallback',
    isThin: true,
    thinReason: 'empty_front'
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Bounded Context Pack Builder & Motion Studio Prefill Composer
// ---------------------------------------------------------------------------

/** SessionStorage key storing the originating card ID when jumping from Card Mind Map to Motion Studio. */
export const MOTION_SOURCE_CARD_KEY = 'lernin:motionStudioSourceCardId';

/** Maximum character length for the appended `[Context — ...]` pack. */
export const MAX_CONTEXT_PACK_CHARS = 360;

/**
 * Unmasks a neighbor card's front text into a concise, clean phrase suitable
 * for context injection:
 * - Strips `{{cN::answer::hint}}` cloze markup down to `answer`
 * - Strips leading quiz question stems ("What is...", "State...", etc.)
 * - Normalizes whitespace and caps individual neighbor snippets at 85 chars
 * - Never reads `card.back`
 *
 * @param {Object|string} neighborCardOrFront
 * @returns {string}
 */
export function unmaskCardFrontForContext(neighborCardOrFront) {
  const rawFront =
    typeof neighborCardOrFront === 'string'
      ? neighborCardOrFront
      : neighborCardOrFront?.front || '';
  const normalized = normalizeWhitespace(rawFront);
  if (!normalized) return '';

  const { cleanSentence } = parseClozeMarkup(normalized);
  const unmasked = cleanSentence || normalized;
  const stripped = stripQuizQuestionStem(unmasked) || unmasked;
  const clean = normalizeWhitespace(stripped);
  if (clean.length <= 85) return clean;
  return `${clean.slice(0, 82).trim()}...`;
}

/**
 * Builds a bounded context string (<= maxChars, default 360) when the user
 * explicitly checks "Include deck context (related cards & summary)".
 *
 * Rules:
 * - Includes `Deck: <deckTitle>` if present.
 * - Includes up to 3 connected neighbor card fronts (`Related concepts: ...`)
 *   with cloze syntax unmasked (`{{cN::answer}}` -> `answer`).
 * - Never includes card backs or full deck dumps.
 * - Includes a concise document summary snippet ONLY when neighbors are sparse
 *   (< 3 valid neighbor fronts) and `docSummary` is non-empty.
 *
 * @param {Object} [opts]
 * @param {string} [opts.deckTitle]
 * @param {Array<Object|string>} [opts.neighborCards]
 * @param {string} [opts.docSummary]
 * @param {number} [opts.maxChars]
 * @returns {string}
 */
export function buildCardMotionContextPack(opts = {}) {
  const deckTitle = normalizeWhitespace(opts.deckTitle || '');
  const rawNeighbors = Array.isArray(opts.neighborCards) ? opts.neighborCards : [];
  const docSummary = normalizeWhitespace(opts.docSummary || '');
  const maxChars =
    typeof opts.maxChars === 'number' && opts.maxChars > 40
      ? opts.maxChars
      : MAX_CONTEXT_PACK_CHARS;

  const segments = [];
  if (deckTitle) {
    segments.push(`Deck: ${deckTitle}`);
  }

  // Up to 3 distinct, non-empty neighbor fronts (cloze-unmasked, no card backs)
  const neighborFronts = [];
  const seenLower = new Set();
  for (const n of rawNeighbors) {
    if (neighborFronts.length >= 3) break;
    const cleaned = unmaskCardFrontForContext(n);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    neighborFronts.push(cleaned);
  }

  if (neighborFronts.length > 0) {
    segments.push(`Related concepts: ${neighborFronts.join(' | ')}`);
  }

  // Only include concise document summary snippet when neighbors are sparse (< 3)
  if (neighborFronts.length < 3 && docSummary) {
    const snippetLimit = neighborFronts.length === 0 ? 180 : 110;
    const summarySnippet =
      docSummary.length > snippetLimit
        ? `${docSummary.slice(0, snippetLimit - 3).trim()}...`
        : docSummary;
    segments.push(`Summary: ${summarySnippet}`);
  }

  let pack = segments.join('; ');
  if (pack.length > maxChars) {
    pack = `${pack.slice(0, maxChars - 3).trim()}...`;
  }
  return pack;
}

/**
 * Composes the final topic string handed off to Motion Studio via
 * `sessionStorage.setItem(MOTION_PREFILL_KEY, finalTopic)`.
 *
 * - When `includeContext` is false (default): returns `editedTopic` trimmed.
 * - When `includeContext` is true: appends `[Context — <boundedPack>]` if a
 *   non-empty context pack was built.
 *
 * @param {string} editedTopic
 * @param {Object} [opts]
 * @param {boolean} [opts.includeContext=false]
 * @param {string} [opts.deckTitle='']
 * @param {Array<Object|string>} [opts.neighborCards=[]]
 * @param {string} [opts.docSummary='']
 * @param {number} [opts.maxContextChars=MAX_CONTEXT_PACK_CHARS]
 * @returns {string}
 */
export function composeCardMotionFinalTopic(editedTopic, opts = {}) {
  const baseTopic = normalizeWhitespace(editedTopic || '');
  if (!opts || !opts.includeContext) {
    return baseTopic;
  }

  const pack = buildCardMotionContextPack({
    deckTitle: opts.deckTitle,
    neighborCards: opts.neighborCards,
    docSummary: opts.docSummary,
    maxChars: opts.maxContextChars ?? MAX_CONTEXT_PACK_CHARS
  });

  if (!pack) {
    return baseTopic;
  }
  return baseTopic ? `${baseTopic} [Context — ${pack}]` : pack;
}

