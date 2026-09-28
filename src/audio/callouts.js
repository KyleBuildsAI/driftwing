// Radar-altitude landing callouts: "one hundred, fifty, forty, thirty, twenty, ten" as the craft
// descends toward the ground in SIM with the gear down (settings.hud.landingCallouts).
//
// Thresholds are in the player's units: feet with aviation units (as real radar altimeters call
// them), metres with metric units, so the call always matches the altitude on the HUD. A threshold
// arms only after the craft has been clearly above it and fires once per descent through it.
//
// The voice is speechSynthesis like the copilot's, but deliberately different: another voice when
// the browser has one (a lower, more synthetic one preferred), lower pitch and a clipped rate. A
// callout never overlaps another callout (a newer call waits for the current one and a stale one is
// dropped) and never talks over the copilot (a call due while the copilot speaks is skipped).
import { clamp } from '../core/util.js';

const THRESHOLDS = Object.freeze([
  { value: 100, word: 'one hundred' },
  { value: 50, word: 'fifty' },
  { value: 40, word: 'forty' },
  { value: 30, word: 'thirty' },
  { value: 20, word: 'twenty' },
  { value: 10, word: 'ten' },
]);
const FEET_PER_METRE = 3.28084;
const MIN_DESCENT_RATE = 0.3;
const PENDING_TTL_SECONDS = 1.6;
// Some speech engines never fire 'end' for an utterance; after this long it no longer blocks.
const STALE_UTTERANCE_SECONDS = 4;
const CALLOUT_PITCH = 0.72;
const CALLOUT_RATE = 1.18;

/** A threshold re-arms once the craft is this far (in callout units) above it. */
function rearmMargin(threshold) {
  return Math.max(6, threshold * 0.3);
}

/**
 * deps: { settings, getUserActivated(), getCopilotVoiceName(), onIssue(error) }.
 */
export function createCallouts({ settings, getUserActivated, getCopilotVoiceName, onIssue }) {
  const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  const UtteranceClass = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined;
  const armed = new Set();
  let voice = null;
  let voiceFor;
  let clockSeconds = 0;
  let current = null;
  let currentStartedAt = 0;
  let pending = null;
  let lastAltitude = null;
  let spoken = 0;
  const skipped = { copilot: 0, muted: 0 };
  let lastWord = null;
  let active = false;

  /** Scores a voice for the callout role: English, not the copilot's, lower and more synthetic. */
  function scoreVoice(candidate, copilotVoice) {
    const lang = String(candidate.lang || '').toLowerCase();
    if (!lang.startsWith('en')) return -1;
    const name = String(candidate.name || '').toLowerCase();
    let score = 0;
    if (copilotVoice && candidate.name === copilotVoice) score -= 10;
    if (/(david|mark|guy|george|daniel|james|ryan|christopher|eric|fred|alex|male)/.test(name)) score += 4;
    if (/natural|neural/.test(name)) score -= 1;
    if (lang === 'en-us' || lang === 'en_us') score += 1;
    if (candidate.localService) score += 1;
    return score;
  }

  function chooseVoice() {
    const copilotVoice = getCopilotVoiceName();
    if (voiceFor === copilotVoice && voice) return voice;
    voiceFor = copilotVoice;
    let best = null;
    let bestScore = -1;
    for (const candidate of synth.getVoices()) {
      const score = scoreVoice(candidate, copilotVoice);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    voice = best;
    return voice;
  }

  if (synth && typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', () => {
      voiceFor = undefined;
    });
  }

  function volume() {
    const mixer = settings.get('mixer');
    const master = clamp(Number(mixer.master) || 0, 0, 1);
    const copilot = clamp(Number(mixer.copilot) || 0, 0, 1);
    return master * copilot;
  }

  function speak(word, realTime) {
    if (!synth || typeof UtteranceClass !== 'function' || !getUserActivated()) return false;
    const level = volume();
    if (level < 0.01) {
      skipped.muted++;
      return false;
    }
    if (current && realTime - currentStartedAt > STALE_UTTERANCE_SECONDS) current = null;
    if (current) {
      // Never overlap a callout: the newest call waits for the current one to finish.
      pending = { word, at: realTime };
      return true;
    }
    if (synth.speaking || synth.pending) {
      // The copilot is talking: a late altitude call would only be noise.
      skipped.copilot++;
      return false;
    }
    try {
      const utterance = new UtteranceClass(word);
      const chosen = chooseVoice();
      if (chosen) {
        utterance.voice = chosen;
        utterance.lang = chosen.lang;
      } else {
        utterance.lang = 'en-US';
      }
      utterance.pitch = CALLOUT_PITCH;
      utterance.rate = CALLOUT_RATE;
      utterance.volume = clamp(0.3 + level * 0.8, 0, 1);
      const finish = () => {
        if (current === utterance) current = null;
        if (pending && clockSeconds - pending.at < PENDING_TTL_SECONDS && active) {
          const next = pending;
          pending = null;
          speak(next.word, clockSeconds);
        } else {
          pending = null;
        }
      };
      utterance.onend = finish;
      utterance.onerror = (event) => {
        const reason = event?.error || 'unknown';
        if (reason !== 'interrupted' && reason !== 'canceled') onIssue(new Error(`callout speech failed: ${reason}`));
        finish();
      };
      current = utterance;
      currentStartedAt = realTime;
      synth.speak(utterance);
      spoken++;
      lastWord = word;
      return true;
    } catch (error) {
      current = null;
      onIssue(error);
      return false;
    }
  }

  /** Stops a callout in progress and drops a waiting one (the copilot's speech is left alone). */
  function cancel() {
    pending = null;
    if (current && synth) {
      current = null;
      try {
        synth.cancel();
      } catch (error) {
        onIssue(error);
      }
    }
  }

  function disarm() {
    armed.clear();
    lastAltitude = null;
  }

  return {
    /** frame fields used: realTime, flight, profile, paused. Called at the parameter interval. */
    update(frame) {
      clockSeconds = frame.realTime;
      const { flight, profile } = frame;
      const enabled = settings.get('hud').landingCallouts === true;
      const gearDown = flight.gear?.down !== false;
      const crashed = flight.crash?.active === true;
      const eligible = enabled && profile.callouts && gearDown && !crashed && !frame.paused;
      if (!eligible) {
        if (active) cancel();
        active = false;
        disarm();
        return;
      }
      active = true;
      if (flight.onGround) {
        pending = null;
        disarm();
        return;
      }
      const radar = Number.isFinite(flight.radarAltitude) ? flight.radarAltitude : flight.agl;
      if (!Number.isFinite(radar)) return;
      const altitude = settings.get('units') === 'aviation' ? radar * FEET_PER_METRE : radar;
      const descending = Number.isFinite(flight.verticalSpeed) && flight.verticalSpeed < -MIN_DESCENT_RATE;
      let due = null;
      for (const threshold of THRESHOLDS) {
        if (altitude > threshold.value + rearmMargin(threshold.value)) armed.add(threshold.value);
        const crossed = lastAltitude !== null && lastAltitude > threshold.value && altitude <= threshold.value;
        if (crossed && armed.has(threshold.value)) {
          armed.delete(threshold.value);
          // Several thresholds crossed in one step: only the lowest is still worth saying.
          if (descending) due = threshold;
        }
      }
      lastAltitude = altitude;
      if (due) speak(due.word, frame.realTime);
    },

    cancel,

    /** True while one of our callouts is being spoken (so the copilot duck can ignore it). */
    get speaking() {
      return current !== null;
    },

    /** Says one callout word now (dev audition), with the same voice and overlap rules. */
    audition(word, realTime) {
      clockSeconds = realTime;
      return speak(String(word), realTime);
    },

    describe() {
      return {
        active,
        speaking: current !== null,
        pending: pending ? pending.word : null,
        armed: [...armed].sort((first, second) => second - first),
        spoken,
        skipped: { ...skipped },
        lastWord,
        voice: voice ? voice.name : null,
        available: Boolean(synth),
      };
    },
  };
}
