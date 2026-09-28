// Sky lantern festival: a soft ambient pad. Five chord tones, each a pair of detuned triangle
// waves, through a low-pass that slowly breathes, drifting from chord to chord with a long
// portamento (D add9, B minor add9, G major 7, A add9), over a faint warm air layer.
//
// setIntensity(0..1) is the festival's density (how many lanterns are near). The chord moves every
// 14 to 22 s, scheduled from update() on the existing oscillators.
import { glide } from '../synthKit.js';
import { noiseBand, wobble } from './recipeKit.js';

const CHORDS = Object.freeze([
  Object.freeze([146.83, 220, 293.66, 369.99, 659.26]),
  Object.freeze([123.47, 185, 246.94, 293.66, 554.37]),
  Object.freeze([98, 196, 246.94, 369.99, 587.33]),
  Object.freeze([110, 164.81, 220, 277.18, 493.88]),
]);
const TONE_LEVELS = Object.freeze([0.26, 0.2, 0.17, 0.13, 0.06]);
const DETUNE_CENTS = 6;
const PORTAMENTO = 1.8;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'lantern',
  summary: 'soft ambient pad',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 120, rolloffFactor: 1.1, panningModel: 'equalpower', size: 400, reverb: 0.8 }),
  level: 0.035,
  floor: 0,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let chord = 0;
    let nextChange = -1;
    let changes = 0;

    const breath = scaffold.modulated(0.8, 0.2, 0.083);
    breath.carrier.connect(out);
    const level = scaffold.gain(0);
    level.connect(breath.carrier);
    const warmth = kit.pitched(scaffold.filter('lowpass', 950, 0.8));
    warmth.connect(level);
    wobble(kit, warmth.frequency, 380, 0.047);

    const tones = [];
    for (let index = 0; index < CHORDS[0].length; index++) {
      const toneGain = scaffold.gain(TONE_LEVELS[index] * 0.5);
      toneGain.connect(warmth);
      const low = kit.pitched(scaffold.oscillator('triangle', CHORDS[0][index]));
      const high = kit.pitched(scaffold.oscillator('triangle', CHORDS[0][index]));
      low.detune.value = -DETUNE_CENTS;
      high.detune.value = DETUNE_CENTS;
      low.connect(toneGain);
      high.connect(toneGain);
      tones.push(low, high);
    }
    const air = noiseBand(kit, { rate: 0.9, type: 'bandpass', frequency: 1100, q: 0.8 });

    function moveTo(nextChord, time) {
      chord = nextChord;
      changes++;
      const frequencies = CHORDS[chord];
      for (let index = 0; index < tones.length; index++) {
        glide(tones[index].frequency, frequencies[index >> 1], time, PORTAMENTO);
      }
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 1.2;
        glide(level.gain, 0.9 * value, time, timeConstant);
        glide(air.gain.gain, 0.02 * value, time, timeConstant);
      },
      trigger() {
        return false;
      },
      update(time) {
        if (nextChange < 0) nextChange = time + randomBetween(14, 22);
        if (time < nextChange) return;
        moveTo((chord + 1) % CHORDS.length, time);
        nextChange = time + randomBetween(14, 22);
      },
      describe() {
        return { intensity, chord, changes };
      },
    };
  },
});
