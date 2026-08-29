/* sound.js — lightweight UI sound effects, synthesized via Web Audio API.
   No audio files: every tone is generated with oscillators. Keeps this
   dependency-free and consistent with how the rest of the app vendors
   everything locally rather than reaching out to a CDN/asset host.

   Off by default — this is a study app, and a meaningful share of usage
   happens in libraries, lecture halls, and other quiet shared spaces.
   A toggle in Settings turns it on; nothing plays until then.
*/

import { getSetting } from './db.js';

let audioCtx = null;
let cachedEnabled = false; // populated by initSoundSetting() before first use

function getAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      audioCtx = new AC();
    } catch (err) {
      return null;
    }
  }
  // iOS/Safari can suspend the context until a user gesture resumes it.
  // Every sound here is triggered directly by a tap (flip, grade, etc.),
  // so resuming unconditionally on that same gesture is safe.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/** Call once when a study session starts, before any sound can fire. */
export async function initSoundSetting() {
  try {
    cachedEnabled = (await getSetting('soundEffectsEnabled')) === true;
  } catch (err) {
    cachedEnabled = false;
  }
  return cachedEnabled;
}

/** Called by the Settings toggle so a change takes effect immediately. */
export function setSoundEnabledCache(enabled) {
  cachedEnabled = !!enabled;
}

function isEnabled() {
  return cachedEnabled === true;
}

/** Lets a caller check the cached setting without triggering a sound —
 * used by app.js to decide whether the identity chime's once-per-session
 * gate should actually be consumed (see maybePlayIdentityChime()). */
export function isSoundEnabled() {
  return isEnabled();
}

/**
 * Plays a short set of tones. Each note: { freq, freqEnd?, start, duration,
 * type?, gain? }. Times are seconds, relative to "now." Silently no-ops if
 * sound is off, unsupported, or anything goes wrong — a missed UI sound
 * should never surface as an error to the person studying.
 */
function playTones(notes) {
  if (!isEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = note.type || 'sine';
      osc.frequency.setValueAtTime(note.freq, now + note.start);
      if (note.freqEnd) {
        osc.frequency.linearRampToValueAtTime(note.freqEnd, now + note.start + note.duration);
      }
      const peakGain = note.gain ?? 0.07;
      const attack = note.attack ?? 0.01;
      gainNode.gain.setValueAtTime(0, now + note.start);
      gainNode.gain.linearRampToValueAtTime(peakGain, now + note.start + attack);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(now + note.start);
      osc.stop(now + note.start + note.duration + 0.02);
    }
  } catch (err) {
    // Non-fatal by design — see function comment above.
  }
}

export function playFlip() {
  // Quick, soft, upward — the card-turning-over moment.
  playTones([{ freq: 480, freqEnd: 620, start: 0, duration: 0.09, gain: 0.06 }]);
}

export function playAgain() {
  // Short, low, gently descending — signals "not yet" without being
  // punishing. Grading honestly matters more than feeling good about a
  // miss, so this is deliberately mild, never harsh or buzzer-like.
  playTones([{ freq: 320, freqEnd: 220, start: 0, duration: 0.16, gain: 0.06 }]);
}

export function playHard() {
  playTones([{ freq: 380, freqEnd: 340, start: 0, duration: 0.12, gain: 0.055 }]);
}

export function playGood() {
  // Warm, settled two-note rise.
  playTones([
    { freq: 520, start: 0, duration: 0.11, gain: 0.065 },
    { freq: 660, start: 0.08, duration: 0.14, gain: 0.065 }
  ]);
}

export function playEasy() {
  // Brighter three-note rise — the small "nailed it" moment.
  playTones([
    { freq: 520, start: 0, duration: 0.09, gain: 0.06 },
    { freq: 660, start: 0.07, duration: 0.09, gain: 0.06 },
    { freq: 880, start: 0.14, duration: 0.16, gain: 0.065 }
  ]);
}

export function playLeechBanish() {
  // A card just got set aside as a leech -- a pause, not a punishment
  // (see the Help copy: "Leeches are signals, not shame"). Deliberately
  // calm and settled: two notes descending a fourth with a soft, longer
  // release, closer in character to playGood()'s warmth than
  // playAgain()'s brisk "not yet" -- there's no alarm or buzzer quality
  // here on purpose.
  playTones([
    { freq: 466.16, start: 0, duration: 0.18, gain: 0.05 },
    { freq: 349.23, start: 0.14, duration: 0.34, gain: 0.045 }
  ]);
}

export function playSessionComplete() {
  // A small closing chime — three ascending notes with a bit more air.
  playTones([
    { freq: 523.25, start: 0, duration: 0.16, gain: 0.06 },
    { freq: 659.25, start: 0.12, duration: 0.16, gain: 0.06 },
    { freq: 783.99, start: 0.24, duration: 0.3, gain: 0.065 }
  ]);
}

export function playNavigate() {
  // Very short, quiet, single-pitch tap — navigation happens far more
  // often than a flip or a grade, so this stays deliberately smaller
  // than either rather than competing with them.
  playTones([{ freq: 340, start: 0, duration: 0.035, gain: 0.035 }]);
}

// Motion Studio's fixed, named-tone palette (see AUDIO_TONES in
// motion_schema.py). A script only ever carries a tone NAME, never raw
// frequencies — this map is the one place that turns a name into an
// actual sound, so every explainer shares one consistent sound identity
// rather than each generation inventing its own. Gated by the same
// isEnabled()/playTones() path as every other UI sound above, so it's
// silent by default and respects the same Settings toggle — no separate
// on/off surface for Motion Studio audio.
const MOTION_CUE_TONES = {
  // A small beat/step landing — quiet, brief, doesn't compete with a caption.
  tick: [{ freq: 420, start: 0, duration: 0.05, gain: 0.04 }],
  // A term or detail appearing — a quick soft pop, one step up from tick.
  pop: [{ freq: 560, freqEnd: 640, start: 0, duration: 0.08, gain: 0.05 }],
  // Building toward a reveal — a short rising sweep, not a full melody.
  rise: [{ freq: 440, freqEnd: 720, start: 0, duration: 0.22, gain: 0.045 }],
  // A reveal or camera move settling — two-note landing, echoes playGood().
  arrive: [
    { freq: 523.25, start: 0, duration: 0.1, gain: 0.05 },
    { freq: 659.25, start: 0.07, duration: 0.16, gain: 0.055 },
  ],
  // The concept fully landing — a fuller three-note close, used sparingly
  // (at most once per script by convention, near the end).
  chime: [
    { freq: 523.25, start: 0, duration: 0.14, gain: 0.05 },
    { freq: 659.25, start: 0.1, duration: 0.14, gain: 0.05 },
    { freq: 783.99, start: 0.2, duration: 0.26, gain: 0.055 },
  ],
};

/** Plays one named Motion Studio audio cue. Unknown names no-op silently —
 * a resolved script only ever carries names from AUDIO_TONES, but this
 * stays defensive rather than throwing mid-playback over a bad name. */
export function playMotionCue(tone) {
  const notes = MOTION_CUE_TONES[tone];
  if (!notes) return;
  playTones(notes);
}

export function playIdentityChord() {
  // Lernin's own "arriving" sound — plays once per session, on first
  // reaching Home (see maybePlayIdentityChime() in app.js), gated by
  // sessionStorage so it never repeats mid-session no matter how much
  // navigation happens. Deliberately distinct from playSessionComplete()'s
  // three-note ascending C major arpeggio (a celebration, sequential,
  // snappy attack) — this is the same warm C major color but as one
  // sustained chord with a slow, gentle attack. Arriving somewhere calm,
  // not finishing something.
  playTones([
    { freq: 261.63, start: 0, duration: 1.1, gain: 0.05, attack: 0.25 },  // C4
    { freq: 329.63, start: 0, duration: 1.1, gain: 0.045, attack: 0.28 }, // E4
    { freq: 392.0, start: 0, duration: 1.1, gain: 0.045, attack: 0.3 },   // G4
    { freq: 523.25, start: 0.05, duration: 1.0, gain: 0.035, attack: 0.35 } // C5, a touch delayed, a little shimmer
  ]);
}
