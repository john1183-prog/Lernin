// motion-card-extract.js — Motion Studio -> SRS recall card extractor
//
// Pure, deterministic extractor that inspects a resolved Motion Studio visual
// script (captions, emphasis layers, formulas, and topic) to synthesize 1-2
// targeted recall cards for the user's spaced repetition deck.
//
// Invariants:
// - Zero dependencies; synchronous execution; offline-first.
// - Zero imports from app.js or motion-studio.js.
// - Strictly non-mutating on input script objects (safe on frozen structures).
// - Never sets fidelityFlag or FSRS fields on returned draft cards.
// - Hard max 2 cards.

/**
 * Escapes special regex characters in a search term.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes and trims whitespace.
 *
 * @param {unknown} val
 * @returns {string}
 */
function cleanText(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/\s+/g, ' ').trim();
}

/**
 * Strips outer LaTeX math delimiters ($$...$$ or $...$) and trims.
 *
 * @param {unknown} formula
 * @returns {string}
 */
function cleanFormula(formula) {
  const t = cleanText(formula);
  if (!t) return '';
  return t.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim();
}

/**
 * Finds a caption containing the given search term (case-insensitive) and
 * returns match metadata for cloze construction.
 *
 * @param {string[]} captions
 * @param {string} term
 * @returns {{ caption: string, start: number, length: number, matchText: string } | null}
 */
function findCaptionMatch(captions, term) {
  const stripped = term.replace(/^\$+|\$+$/g, '').trim();
  if (!stripped || stripped.length < 2) return null;
  const re = new RegExp(`(^|[^a-zA-Z0-9])(${escapeRegExp(stripped)})([^a-zA-Z0-9]|$)`, 'i');

  for (const cap of captions) {
    const m = cap.match(re);
    if (m && m[2]) {
      const idx = cap.indexOf(m[2]);
      if (idx !== -1) {
        return {
          caption: cap,
          start: idx,
          length: m[2].length,
          matchText: m[2]
        };
      }
    }
  }
  return null;
}

/**
 * Extracts 1-2 draft recall cards from a resolved motion script.
 *
 * @param {object} script - Resolved motion script object (scene, layers, markers)
 * @param {string} topic - User's prompt or deck topic
 * @param {object} [opts] - Extraction options ({ maxCards = 2 })
 * @returns {Array<{ front: string, back: string, type: 'basic'|'cloze'|'formula', formula?: string }>}
 */
export function extractMotionRecallCards(script, topic = '', opts = {}) {
  const maxCards = Math.max(1, Math.min(2, opts.maxCards || 2));

  const cleanTopic = cleanText(topic) || cleanText(script?.scene?.name) || 'this concept';
  const layers = Array.isArray(script?.layers) ? script.layers : [];

  const captions = [];
  const emphases = [];
  const formulas = [];
  const texts = [];

  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const txt = cleanText(l.text);
    if (!txt) continue;

    if (l.type === 'caption') {
      if (!captions.includes(txt)) captions.push(txt);
    } else if (l.type === 'emphasis') {
      if (!emphases.includes(txt)) emphases.push(txt);
    }

    if (l.format === 'formula' || l.type === 'formula') {
      const cf = cleanFormula(txt);
      if (cf && !formulas.includes(cf)) formulas.push(cf);
    } else if (l.type === 'text') {
      if (!texts.includes(txt)) texts.push(txt);
    }
  }

  // If no script content and no valid topic, return empty
  if (!captions.length && !emphases.length && !formulas.length && !texts.length && cleanTopic === 'this concept') {
    return [];
  }

  const results = [];

  // -------------------------------------------------------------
  // Card 1: Primary Conceptual / Mechanism Card
  // -------------------------------------------------------------
  let card1 = null;

  // Strategy 1: Cloze deletion if an emphasis term is found in a caption
  if (emphases.length > 0 && captions.length > 0) {
    for (const em of emphases) {
      const match = findCaptionMatch(captions, em);
      if (match) {
        const clozeFront =
          match.caption.slice(0, match.start) +
          `{{c1::${match.matchText}}}` +
          match.caption.slice(match.start + match.length);
        card1 = {
          type: 'cloze',
          front: clozeFront,
          back: match.matchText
        };
        break;
      }
    }
  }

  // Strategy 2: If formula exists and no captions, formula card is primary
  if (!card1 && formulas.length > 0 && captions.length === 0) {
    card1 = {
      type: 'formula',
      front: `What equation governs ${cleanTopic}?`,
      back: formulas[0],
      formula: formulas[0]
    };
  }

  // Strategy 3: Multi-caption sequence -> test process outcome
  if (!card1 && captions.length >= 2) {
    card1 = {
      type: 'basic',
      front: `In ${cleanTopic}, what is the key outcome?`,
      back: captions[captions.length - 1]
    };
  }

  // Strategy 4: Single caption -> test primary mechanism
  if (!card1 && captions.length === 1) {
    card1 = {
      type: 'basic',
      front: `How does ${cleanTopic} work?`,
      back: captions[0]
    };
  }

  // Strategy 5: Emphasis only -> test key emphasized term
  if (!card1 && emphases.length > 0) {
    card1 = {
      type: 'basic',
      front: `What is the key concept in ${cleanTopic}?`,
      back: emphases[0]
    };
  }

  // Strategy 6: Text layers or fallback topic question
  if (!card1 && texts.length > 0) {
    card1 = {
      type: 'basic',
      front: `What are key elements of ${cleanTopic}?`,
      back: texts.join(', ')
    };
  }

  if (!card1 && cleanTopic !== 'this concept') {
    card1 = {
      type: 'basic',
      front: `What is ${cleanTopic}?`,
      back: ''
    };
  }

  if (card1) {
    results.push(card1);
  }

  // -------------------------------------------------------------
  // Card 2: Secondary Card (Formula, distinct emphasis, or initial cause)
  // Only generated when a distinct, meaningful second facet exists!
  // -------------------------------------------------------------
  if (results.length === 1 && maxCards >= 2) {
    let card2 = null;

    // Condition A: Formula layer exists and wasn't already used as card 1
    if (formulas.length > 0 && results[0].back !== formulas[0] && results[0].formula !== formulas[0]) {
      card2 = {
        type: 'formula',
        front: `What equation governs ${cleanTopic}?`,
        back: formulas[0],
        formula: formulas[0]
      };
    }
    // Condition B: Second distinct emphasis term exists
    else if (emphases.length >= 2) {
      const secondEm = emphases[1];
      const match2 = findCaptionMatch(captions, secondEm);
      if (match2 && !results[0].front.includes(`{{c1::${match2.matchText}}}`)) {
        card2 = {
          type: 'cloze',
          front:
            match2.caption.slice(0, match2.start) +
            `{{c1::${match2.matchText}}}` +
            match2.caption.slice(match2.start + match2.length),
          back: match2.matchText
        };
      } else {
        card2 = {
          type: 'basic',
          front: `In ${cleanTopic}, what is ${secondEm}?`,
          back: captions.length > 1 ? captions[0] : secondEm
        };
      }
    }
    // Condition C: Multiple captions exist and card 1 only tested the final outcome
    else if (captions.length >= 2 && results[0].type === 'basic' && results[0].back === captions[captions.length - 1]) {
      card2 = {
        type: 'basic',
        front: `What initiates ${cleanTopic}?`,
        back: captions[0]
      };
    }
    // Condition D: Card 1 was cloze and we have a solid process caption for basic recall
    else if (results[0].type === 'cloze' && captions.length > 0) {
      const otherCaption = captions.find(c => !c.includes(results[0].back)) || captions[0];
      if (otherCaption) {
        card2 = {
          type: 'basic',
          front: `What happens during ${cleanTopic}?`,
          back: otherCaption
        };
      }
    }

    if (card2) {
      results.push(card2);
    }
  }

  return results.slice(0, 2);
}
