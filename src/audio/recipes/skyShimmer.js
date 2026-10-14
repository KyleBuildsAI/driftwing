// Night-sky shimmer (the blood moon, the green flash, noctilucent clouds, the Milky Way core, the
// moonbow): a hushed, glassy pad that twinkles like the stars it goes with.
//
// Four chord tones (the fundamental, a fifth, an octave and a twelfth above params.baseHz, default
// 330 Hz), each a pair of sines a few cents apart, every pair breathing on its own slow random
// twinkle, through a low-pass whose cutoff follows params.brightness (0..1, default 0.5), over a
// faint high air band. setIntensity(0..1) is how much of the sight the player can see (its
// visibility, eased in the engine).
//
// trigger('flash', { strength }) rings a bright glass bell (the struck-bar modes 1, 2.76, 5.40 on
// four octaves above the fundamental) with a quick rising sweep under it: the green flash itself.
import { glide } from '../synthKit.js';
import { noiseBand, option, strike, sweep, wobble } from './recipeKit.js';

const CHORD_RATIOS = Object.freeze([1, 1.5, 2, 3]);
const TONE_LEVELS = Object.freeze([0.3, 0.2, 0.16, 0.08]);
const DETUNE_CENTS = 7;
/** Each pair's twinkle: a slow sine on its level, this deep, at these rates (Hz). */
const TWINKLE_DEPTH = 0.45;
const TWINKLE_RATES = Object.freeze([0.11, 0.17, 0.23, 0.31]);
const BELL_MODES = Object.freeze([
  Object.freeze({ ratio: 1, gain: 1, decay: 2.6 }),
  Object.freeze({ ratio: 2.756, gain: 0.45, decay: 1.4 }),
  Object.freeze({ ratio: 5.404, gain: 0.2, decay: 0.7 }),
]);
const BELL_OCTAVE = 4;
const MAX_BELL_FREQUENCY = 15000;
const PAD_LEVEL = 0.32;
const BELL_LEVEL = 0.16;

export default Object.freeze({
  name: 'skyShimmer',
  summary: 'hushed glassy pad that twinkles, and a bright bell for a flash',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 1500, rolloffFactor: 0.6, panningModel: 'equalpower', size: 0, reverb: 0.85 }),
  level: 0.03,
  floor: 0,
  triggers: Object.freeze(['flash']),

  build(kit, params) {
    const { scaffold, out } = kit;
    const baseHz = option(params, 'baseHz', 330, 40, 2000);
    const brightness = option(params, 'brightness', 0.5, 0, 1);
    let intensity = 0;
    let flashes = 0;

    const level = scaffold.gain(0);
    level.connect(out);
    const tone = kit.pitched(scaffold.filter('lowpass', baseHz * (3 + 9 * brightness), 0.7));
    tone.connect(level);
    wobble(kit, tone.frequency, baseHz * (0.6 + brightness), 0.039);
    for (let index = 0; index < CHORD_RATIOS.length; index++) {
      const frequency = baseHz * CHORD_RATIOS[index];
      const pairLevel = scaffold.gain(TONE_LEVELS[index] * (1 - TWINKLE_DEPTH * 0.5));
      pairLevel.connect(tone);
      wobble(kit, pairLevel.gain, TONE_LEVELS[index] * TWINKLE_DEPTH * 0.5, TWINKLE_RATES[index]);
      const low = kit.pitched(scaffold.oscillator('sine', frequency));
      const high = kit.pitched(scaffold.oscillator('sine', frequency));
      low.detune.value = -DETUNE_CENTS;
      high.detune.value = DETUNE_CENTS;
      low.connect(pairLevel);
      high.connect(pairLevel);
    }
    const air = noiseBand(kit, { rate: 1.1, type: 'bandpass', frequency: 3600 + 4000 * brightness, q: 1.6 });

    const bell = BELL_MODES.map((mode) => {
      const oscillator = kit.pitched(scaffold.oscillator('sine', Math.min(MAX_BELL_FREQUENCY, baseHz * BELL_OCTAVE * mode.ratio)));
      const envelope = scaffold.gain(0);
      oscillator.connect(envelope);
      envelope.connect(out);
      return { oscillator, envelope, mode };
    });
    const riser = kit.pitched(scaffold.oscillator('sine', baseHz * 2));
    const riserLevel = scaffold.gain(0);
    riser.connect(riserLevel);
    riserLevel.connect(out);

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 1.4;
        glide(level.gain, PAD_LEVEL * value, time, timeConstant);
        glide(air.gain.gain, 0.012 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'flash') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        flashes++;
        for (const { oscillator, envelope, mode } of bell) {
          const frequency = baseHz * BELL_OCTAVE * mode.ratio;
          if (frequency > MAX_BELL_FREQUENCY) continue;
          oscillator.frequency.setValueAtTime(frequency, time);
          strike(envelope.gain, time, BELL_LEVEL * strength * mode.gain, 0.004, mode.decay);
        }
        sweep(riser.frequency, time, baseHz * 2, baseHz * 6, 0.45);
        strike(riserLevel.gain, time, 0.05 * strength, 0.06, 0.6);
        return true;
      },
      describe() {
        return { intensity, flashes, baseHz };
      },
    };
  },
});
