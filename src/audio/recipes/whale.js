// Whale song, for the whale pod ('whale') and the sky whale ('skyWhale').
//
// A formant voice: a sawtooth (and a sub-octave sine) with a slow vibrato, shaped by two resonant
// band-pass formants and a touch of breath noise. The song is a sequence of units in the manner of
// humpback song (long rising moans, falling cries, low groans, short whoops, held tones) grouped in
// phrases, with the pitch gliding through each unit and the formants morphing from a closed "oo" to
// an open "ah" and back. Units are scheduled a little ahead on nodes that already exist, so the
// song allocates nothing while it sings.
//
// setIntensity(0..1) is the song activity: 0 stops new phrases, 1 sings with short pauses.
// trigger('call') starts a phrase now. The sky whale sings more than an octave lower, slower, with a
// heavy sub-octave and a vast reverb: larger and deeper, just as melancholic.
import { glide } from '../synthKit.js';
import { noiseBand, wobble } from './recipeKit.js';

// from / to (and optional via at 45 %) in Hz; seconds; vowel 0 = "oo", 1 = "ah".
const UNITS = Object.freeze([
  Object.freeze({ from: 105, via: 0, to: 262, seconds: 2.6, vowelFrom: 0, vowelTo: 0.9, level: 1 }),
  Object.freeze({ from: 395, via: 0, to: 150, seconds: 1.9, vowelFrom: 1, vowelTo: 0.2, level: 0.85 }),
  Object.freeze({ from: 88, via: 96, to: 80, seconds: 3.1, vowelFrom: 0.1, vowelTo: 0.3, level: 0.9 }),
  Object.freeze({ from: 210, via: 0, to: 430, seconds: 0.6, vowelFrom: 0.3, vowelTo: 1, level: 0.6 }),
  Object.freeze({ from: 302, via: 0, to: 294, seconds: 1.5, vowelFrom: 0.6, vowelTo: 0.5, level: 0.75 }),
  Object.freeze({ from: 160, via: 205, to: 118, seconds: 2.3, vowelFrom: 0.2, vowelTo: 0.7, level: 0.95 }),
  Object.freeze({ from: 520, via: 0, to: 330, seconds: 1.1, vowelFrom: 1, vowelTo: 0.6, level: 0.55 }),
]);
const PHRASES = Object.freeze([
  Object.freeze([0, 1, 3]),
  Object.freeze([2, 4, 1]),
  Object.freeze([5, 3, 3, 0]),
  Object.freeze([4, 6, 1, 2]),
  Object.freeze([0, 5, 2]),
]);
// Formant frequencies (F1, F2) of the two vowels.
const VOWEL_CLOSED = Object.freeze([320, 820]);
const VOWEL_OPEN = Object.freeze([690, 1180]);

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function createSongRecipe({ name, summary, spatial, level, voice }) {
  return Object.freeze({
    name,
    summary,
    spatial: Object.freeze(spatial),
    level,
    floor: 0.3,
    triggers: Object.freeze(['call']),

    build(kit) {
      const { scaffold, out } = kit;
      let intensity = 0;
      let unitsSung = 0;
      let phrase = PHRASES[0];
      let unitIndex = 0;
      let nextAt = -1;
      let lastUnitEnd = 0;
      let lastPitch = 0;

      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const smooth = kit.pitched(scaffold.filter('lowpass', 2300 * voice.formantScale, 0.6));
      smooth.connect(envelope);
      const formantOne = kit.pitched(scaffold.filter('bandpass', VOWEL_CLOSED[0] * voice.formantScale, 5));
      const formantTwo = kit.pitched(scaffold.filter('bandpass', VOWEL_CLOSED[1] * voice.formantScale, 7));
      const formantTwoLevel = scaffold.gain(0.55);
      formantOne.connect(smooth);
      formantTwo.connect(formantTwoLevel);
      formantTwoLevel.connect(smooth);
      // The fundamental also reaches the output directly, so the low moan keeps its body.
      const body = scaffold.gain(voice.body);
      body.connect(smooth);

      const source = kit.pitched(scaffold.oscillator('sawtooth', 120 * voice.pitchScale));
      const sourceLevel = scaffold.gain(0.5);
      source.connect(sourceLevel);
      sourceLevel.connect(formantOne);
      sourceLevel.connect(formantTwo);
      const sub = kit.pitched(scaffold.oscillator('sine', 60 * voice.pitchScale));
      const subLevel = scaffold.gain(voice.sub);
      sub.connect(subLevel);
      subLevel.connect(body);
      sourceLevel.connect(body);
      wobble(kit, source.detune, voice.vibratoCents, voice.vibratoRate);
      wobble(kit, sub.detune, voice.vibratoCents, voice.vibratoRate);
      // Breath: noise through the same formants.
      noiseBand(kit, { rate: 0.8, type: 'lowpass', frequency: 1600, q: 0.5, level: voice.breath, destination: formantOne });

      function scheduleUnit(start) {
        const unit = UNITS[phrase[unitIndex]];
        const seconds = unit.seconds * voice.durationScale;
        const end = start + seconds;
        const pitch = voice.pitchScale;
        const formant = voice.formantScale;
        const peak = unit.level * randomBetween(0.85, 1);
        source.frequency.cancelScheduledValues(start);
        sub.frequency.cancelScheduledValues(start);
        source.frequency.setValueAtTime(unit.from * pitch, start);
        sub.frequency.setValueAtTime(unit.from * pitch * 0.5, start);
        if (unit.via > 0) {
          source.frequency.exponentialRampToValueAtTime(unit.via * pitch, start + seconds * 0.45);
          sub.frequency.exponentialRampToValueAtTime(unit.via * pitch * 0.5, start + seconds * 0.45);
        }
        source.frequency.exponentialRampToValueAtTime(unit.to * pitch, end);
        sub.frequency.exponentialRampToValueAtTime(unit.to * pitch * 0.5, end);
        const openFrom = unit.vowelFrom;
        const openTo = unit.vowelTo;
        formantOne.frequency.cancelScheduledValues(start);
        formantOne.frequency.setValueAtTime(formant * (VOWEL_CLOSED[0] + (VOWEL_OPEN[0] - VOWEL_CLOSED[0]) * openFrom), start);
        formantOne.frequency.linearRampToValueAtTime(formant * (VOWEL_CLOSED[0] + (VOWEL_OPEN[0] - VOWEL_CLOSED[0]) * openTo), end);
        formantTwo.frequency.cancelScheduledValues(start);
        formantTwo.frequency.setValueAtTime(formant * (VOWEL_CLOSED[1] + (VOWEL_OPEN[1] - VOWEL_CLOSED[1]) * openFrom), start);
        formantTwo.frequency.linearRampToValueAtTime(formant * (VOWEL_CLOSED[1] + (VOWEL_OPEN[1] - VOWEL_CLOSED[1]) * openTo), end);
        const attack = Math.min(0.6, seconds * 0.3);
        const release = Math.min(1.2, seconds * 0.35);
        envelope.gain.cancelScheduledValues(start);
        envelope.gain.setTargetAtTime(peak, start, attack / 3);
        envelope.gain.setTargetAtTime(0, end - release, release / 3);
        unitsSung++;
        lastPitch = unit.to * pitch;
        lastUnitEnd = end;
        unitIndex++;
        if (unitIndex >= phrase.length) {
          phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
          unitIndex = 0;
          const pause = randomBetween(voice.phrasePause[0], voice.phrasePause[1]) * (1.6 - intensity);
          nextAt = end + pause;
        } else {
          nextAt = end + randomBetween(voice.unitGap[0], voice.unitGap[1]);
        }
      }

      return {
        setIntensity(value) {
          intensity = value;
        },
        trigger(triggerName, options, time) {
          if (triggerName !== 'call') return false;
          phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
          unitIndex = 0;
          nextAt = Math.max(time + 0.05, lastUnitEnd + 0.25);
          return true;
        },
        update(time, interval) {
          if (nextAt < 0) nextAt = time + randomBetween(0.3, 1.8);
          const horizon = time + Math.max(0.4, interval * 3);
          if (nextAt > horizon) return;
          if (intensity < 0.04 && unitIndex === 0) {
            nextAt = horizon + interval;
            return;
          }
          scheduleUnit(Math.max(nextAt, time + 0.02));
        },
        describe() {
          return { intensity, unitsSung, pitch: lastPitch, nextAt };
        },
      };
    },
  });
}

export const whale = createSongRecipe({
  name: 'whale',
  summary: 'humpback song: formant glides, slow and melancholic',
  spatial: { distanceModel: 'exponential', refDistance: 150, rolloffFactor: 1.6, panningModel: 'HRTF', size: 80, reverb: 0.55 },
  level: 0.07,
  voice: {
    pitchScale: 1, durationScale: 1, formantScale: 1, sub: 0.25, body: 0.18, breath: 0.35,
    vibratoCents: 9, vibratoRate: 2.7, unitGap: [0.35, 1.3], phrasePause: [4, 11],
  },
});

export const skyWhale = createSongRecipe({
  name: 'skyWhale',
  summary: 'sky whale song: deeper, slower and larger than the whales',
  spatial: { distanceModel: 'inverse', refDistance: 450, rolloffFactor: 0.9, panningModel: 'equalpower', size: 260, reverb: 0.85 },
  level: 0.09,
  voice: {
    pitchScale: 0.42, durationScale: 1.8, formantScale: 0.62, sub: 0.45, body: 0.22, breath: 0.4,
    vibratoCents: 6, vibratoRate: 1.4, unitGap: [0.6, 2], phrasePause: [7, 16],
  },
});
