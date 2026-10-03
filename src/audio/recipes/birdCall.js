// Bird calls, for the raptors ('raptor': a hawk's or an eagle's scream) and the geese ('goose').
//
// raptor: the hoarse, descending scream of a soaring hawk ("kee-eeee-arr"). A sawtooth and a band of
// breath noise through a bright resonance that glides up for an instant and then slides down, made
// rough by a fast amplitude buzz. setIntensity(0..1) is the bird's presence: how loud each scream is
// (a faint scream still carries at 0). trigger('call', { strength }) screams now; the fauna engine
// calls it when a wingman joins or peels off and on a circling group's calls.interval.
// params.pitch scales the voice: an eagle is lower and fuller (about 0.8), a hawk 1.
//
// goose: the honking of a flight of geese. Three voices of slightly different pitch honk in loose,
// overlapping bouts; each honk is a short nasal "ah" sliding into a louder "HONK" that bends down,
// through two formants. Honks are scheduled a little ahead from update() on nodes that already
// exist, so the chorus allocates nothing while it honks. setIntensity(0..1) is the chatter: 0 is
// silent, 1 a busy chorus. trigger('call') starts a bout now.
import { holdAt } from '../synthKit.js';
import { noiseBand, option, wobble } from './recipeKit.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// ---- raptor --------------------------------------------------------------------------------------
/** The scream's pitch contour (Hz at pitch 1): onset, the brief peak, the end of the slide. */
const SCREAM = Object.freeze({ onset: 2350, peak: 3150, end: 1750, seconds: 1.75 });

export const raptor = Object.freeze({
  name: 'raptor',
  summary: 'descending hawk scream',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 110, rolloffFactor: 1.3, panningModel: 'HRTF', size: 0, reverb: 0.45 }),
  level: 0.05,
  floor: 0.35,
  triggers: Object.freeze(['call']),

  build(kit, params) {
    const { scaffold, out } = kit;
    const pitch = option(params, 'pitch', 1, 0.5, 1.6);
    let intensity = 0;
    let screams = 0;
    let lastScreamAt = -1;

    const envelope = scaffold.gain(0);
    envelope.connect(out);
    // The buzz: a fast tremolo that makes the scream hoarse rather than a whistle.
    const buzz = scaffold.gain(0.72);
    buzz.connect(envelope);
    wobble(kit, buzz.gain, 0.28, 71 * pitch);
    const resonance = kit.pitched(scaffold.filter('bandpass', SCREAM.onset * pitch, 3.2));
    resonance.connect(buzz);
    const brightness = kit.pitched(scaffold.filter('peaking', SCREAM.peak * pitch * 1.4, 2));
    brightness.gain.value = 6;
    brightness.connect(resonance);
    const tone = kit.pitched(scaffold.oscillator('sawtooth', SCREAM.onset * pitch * 0.5));
    const toneLevel = scaffold.gain(0.55);
    tone.connect(toneLevel);
    toneLevel.connect(brightness);
    // A second partial an octave up keeps the scream piercing through the resonance.
    const overtone = kit.pitched(scaffold.oscillator('triangle', SCREAM.onset * pitch));
    const overtoneLevel = scaffold.gain(0.3);
    overtone.connect(overtoneLevel);
    overtoneLevel.connect(resonance);
    const breath = noiseBand(kit, { rate: 1.1, type: 'bandpass', frequency: SCREAM.onset * pitch, q: 1.4, level: 0.4, destination: brightness });

    function scream(time, strength) {
      const seconds = SCREAM.seconds * randomBetween(0.85, 1.15) * (1.15 - 0.15 * pitch);
      const peakAt = time + seconds * 0.1;
      const end = time + seconds;
      const contour = randomBetween(0.95, 1.05) * pitch;
      for (const parameter of [tone.frequency, overtone.frequency, resonance.frequency, breath.filter.frequency]) {
        const scale = parameter === tone.frequency ? 0.5 : 1;
        holdAt(parameter, time);
        parameter.setValueAtTime(SCREAM.onset * contour * scale, time);
        parameter.exponentialRampToValueAtTime(SCREAM.peak * contour * scale, peakAt);
        parameter.exponentialRampToValueAtTime(SCREAM.end * contour * scale, end);
      }
      const peak = 0.85 * strength * (0.35 + 0.65 * intensity);
      holdAt(envelope.gain, time);
      envelope.gain.linearRampToValueAtTime(peak, time + 0.06);
      envelope.gain.setTargetAtTime(peak * 0.75, time + 0.06, seconds * 0.15);
      envelope.gain.setTargetAtTime(0, time + seconds * 0.72, seconds * 0.1);
      screams++;
      lastScreamAt = time;
    }

    return {
      setIntensity(value) {
        intensity = value;
      },
      trigger(triggerName, options, time) {
        if (triggerName !== 'call') return false;
        scream(time, option(options, 'strength', 1, 0, 1));
        return true;
      },
      describe() {
        return { intensity, screams, lastScreamAt, pitch };
      },
    };
  },
});

// ---- goose ---------------------------------------------------------------------------------------
const GOOSE_VOICES = Object.freeze([
  Object.freeze({ pitch: 1, level: 1 }),
  Object.freeze({ pitch: 1.12, level: 0.8 }),
  Object.freeze({ pitch: 0.9, level: 0.7 }),
]);
/** One honk at pitch 1: the "ah" (Hz, s), the "HONK" from / to (Hz) and its length, the formants. */
const HONK = Object.freeze({ lead: 300, leadSeconds: 0.07, from: 410, to: 350, seconds: 0.26, formantOne: 1050, formantTwo: 2450 });

export const goose = Object.freeze({
  name: 'goose',
  summary: 'honking geese chorus',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 120, rolloffFactor: 1.4, panningModel: 'HRTF', size: 40, reverb: 0.3 }),
  level: 0.05,
  floor: 0,
  triggers: Object.freeze(['call']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let honks = 0;
    let nextAt = -1;
    let boutLeft = 0;
    let voiceIndex = 0;

    const voices = GOOSE_VOICES.map((voice) => {
      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const nasal = kit.pitched(scaffold.filter('bandpass', HONK.formantOne * voice.pitch, 4));
      const bright = kit.pitched(scaffold.filter('bandpass', HONK.formantTwo * voice.pitch, 6));
      const brightLevel = scaffold.gain(0.6);
      nasal.connect(envelope);
      bright.connect(brightLevel);
      brightLevel.connect(envelope);
      const source = kit.pitched(scaffold.oscillator('sawtooth', HONK.from * voice.pitch));
      const sourceLevel = scaffold.gain(0.7);
      source.connect(sourceLevel);
      sourceLevel.connect(nasal);
      sourceLevel.connect(bright);
      // A little body below the formants, so a honk is a voice and not a kazoo.
      const body = kit.pitched(scaffold.filter('lowpass', 700 * voice.pitch, 0.8));
      const bodyLevel = scaffold.gain(0.35);
      sourceLevel.connect(body);
      body.connect(bodyLevel);
      bodyLevel.connect(envelope);
      return { ...voice, envelope, source };
    });

    function honk(start) {
      const voice = voices[voiceIndex % voices.length];
      voiceIndex += 1 + Math.floor(Math.random() * 2);
      const pitch = voice.pitch * randomBetween(0.96, 1.04);
      const length = HONK.seconds * randomBetween(0.8, 1.25);
      const honkAt = start + HONK.leadSeconds;
      const end = honkAt + length;
      const frequency = voice.source.frequency;
      holdAt(frequency, start);
      frequency.setValueAtTime(HONK.lead * pitch, start);
      frequency.exponentialRampToValueAtTime(HONK.from * pitch, honkAt);
      frequency.exponentialRampToValueAtTime(HONK.to * pitch, end);
      const peak = voice.level * randomBetween(0.7, 1);
      const gain = voice.envelope.gain;
      holdAt(gain, start);
      gain.linearRampToValueAtTime(peak * 0.35, start + 0.02);
      gain.linearRampToValueAtTime(peak, honkAt + 0.03);
      gain.setTargetAtTime(peak * 0.8, honkAt + 0.03, length * 0.3);
      gain.setTargetAtTime(0, end - 0.04, 0.035);
      honks++;
      return end;
    }

    function startBout(time) {
      boutLeft = 2 + Math.floor(Math.random() * (2 + intensity * 5));
      nextAt = time;
    }

    return {
      setIntensity(value) {
        intensity = value;
      },
      trigger(triggerName, options, time) {
        if (triggerName !== 'call') return false;
        startBout(Math.max(time + 0.03, nextAt > time ? Math.min(nextAt, time + 0.4) : time + 0.03));
        return true;
      },
      update(time, interval) {
        if (nextAt < 0) nextAt = time + randomBetween(0.2, 1.5);
        const horizon = time + Math.max(0.4, interval * 3);
        while (nextAt <= horizon) {
          if (boutLeft <= 0) {
            if (intensity < 0.04) {
              nextAt = horizon + interval;
              return;
            }
            startBout(nextAt);
          }
          const end = honk(Math.max(nextAt, time + 0.02));
          boutLeft--;
          // Honks overlap a little inside a bout; bouts are farther apart when the flock is quiet.
          nextAt = boutLeft > 0 ? end + randomBetween(-0.08, 0.35) : end + randomBetween(1.5, 5) * (1.7 - intensity);
        }
      },
      describe() {
        return { intensity, honks, boutLeft, nextAt };
      },
    };
  },
});
