// Crystal spires: a harmonic hum and glassy chimes.
//
// The hum is a bank of sine partials on one fundamental (harmonics 1, 2, 3, 4 and 6, plus a twin of
// the fundamental 0.7 Hz sharp that makes it shimmer), all driven by one frequency signal, so the
// whole chord glides as one. setIntensity(0..1) is the approach: the fundamental rises from
// params.baseHz (default 196 Hz, G3) by params.rangeSemitones (default 12, an octave) and the hum
// grows louder and brighter.
//
// trigger('chime', { strength, notes }) rings a short cascade of struck-glass notes (the modes of a
// free bar: 1, 2.76, 5.40, 8.93) on the pentatonic scale of the current fundamental, for flying
// between the spires. Four chime slots are reused round-robin.
import { glide } from '../synthKit.js';
import { option, strike, wobble } from './recipeKit.js';

const HUM_PARTIALS = Object.freeze([
  Object.freeze({ ratio: 1, gain: 0.5, bright: 0 }),
  Object.freeze({ ratio: 2, gain: 0.26, bright: 0.1 }),
  Object.freeze({ ratio: 3, gain: 0.1, bright: 0.12 }),
  Object.freeze({ ratio: 4, gain: 0.04, bright: 0.09 }),
  Object.freeze({ ratio: 6, gain: 0.015, bright: 0.06 }),
]);
const BAR_MODES = Object.freeze([
  Object.freeze({ ratio: 1, gain: 1, decay: 3.4 }),
  Object.freeze({ ratio: 2.756, gain: 0.42, decay: 1.7 }),
  Object.freeze({ ratio: 5.404, gain: 0.2, decay: 0.8 }),
  Object.freeze({ ratio: 8.933, gain: 0.08, decay: 0.4 }),
]);
const PENTATONIC = Object.freeze([0, 2, 4, 7, 9, 12, 14, 16]);
const CHIME_SLOTS = 4;
const CHIME_OCTAVE = 4;
const MAX_MODE_FREQUENCY = 16000;
const HUM_LEVEL = 0.2;
const CHIME_LEVEL = 0.1;

/** The hum's fundamental (Hz) for an approach intensity. */
export function crystalPitch(intensity, baseHz = 196, rangeSemitones = 12) {
  return baseHz * Math.pow(2, (Math.min(Math.max(intensity, 0), 1) * rangeSemitones) / 12);
}

export default Object.freeze({
  name: 'crystal',
  summary: 'harmonic hum rising in pitch on approach, and chimes',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 60, rolloffFactor: 1.4, panningModel: 'HRTF', size: 40, reverb: 0.7 }),
  level: 0.05,
  floor: 0.35,
  triggers: Object.freeze(['chime']),

  build(kit, params) {
    const { scaffold, out, context } = kit;
    const baseHz = option(params, 'baseHz', 196, 40, 2000);
    const rangeSemitones = option(params, 'rangeSemitones', 12, 0, 36);
    let intensity = 0;
    let fundamental = baseHz;
    let chimes = 0;

    // One frequency signal drives every partial: osc.frequency = 0 + ratio * pitch.
    const pitch = scaffold.add(new ConstantSourceNode(context, { offset: baseHz }));
    const tremolo = scaffold.modulated(0.8, 0.2, 0.37);
    tremolo.carrier.connect(out);
    const partialLevels = [];
    for (const partial of HUM_PARTIALS) {
      const oscillator = kit.pitched(scaffold.oscillator('sine', 0));
      const ratio = scaffold.gain(partial.ratio);
      pitch.connect(ratio);
      ratio.connect(oscillator.frequency);
      const levelGain = scaffold.gain(0);
      oscillator.connect(levelGain);
      levelGain.connect(tremolo.carrier);
      partialLevels.push(levelGain);
    }
    const twin = kit.pitched(scaffold.oscillator('sine', 0.7));
    pitch.connect(twin.frequency);
    const twinLevel = scaffold.gain(0);
    twin.connect(twinLevel);
    twinLevel.connect(tremolo.carrier);
    wobble(kit, pitch.offset, 0.6, 0.11);

    const slots = [];
    for (let index = 0; index < CHIME_SLOTS; index++) {
      const modes = [];
      for (const mode of BAR_MODES) {
        const oscillator = kit.pitched(scaffold.oscillator('sine', 880 * mode.ratio));
        const envelope = scaffold.gain(0);
        oscillator.connect(envelope);
        envelope.connect(out);
        modes.push({ oscillator, envelope, mode });
      }
      slots.push(modes);
    }

    function applyHum(time, timeConstant) {
      fundamental = crystalPitch(intensity, baseHz, rangeSemitones);
      glide(pitch.offset, fundamental, time, timeConstant);
      const loudness = HUM_LEVEL * (0.35 + 0.65 * intensity);
      for (let index = 0; index < HUM_PARTIALS.length; index++) {
        const partial = HUM_PARTIALS[index];
        glide(partialLevels[index].gain, loudness * (partial.gain + partial.bright * intensity), time, timeConstant);
      }
      glide(twinLevel.gain, loudness * 0.3, time, timeConstant);
    }

    function ring(slot, time, frequency, strength) {
      for (let index = 0; index < slot.length; index++) {
        const { oscillator, envelope, mode } = slot[index];
        const modeFrequency = frequency * mode.ratio;
        // Modes above the audible band would alias; the bar simply has fewer of them up there.
        if (modeFrequency > MAX_MODE_FREQUENCY) continue;
        oscillator.frequency.setValueAtTime(modeFrequency, time);
        strike(envelope.gain, time, CHIME_LEVEL * strength * mode.gain, 0.003, mode.decay);
      }
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        applyHum(time, immediate ? 0.01 : 0.5);
      },
      trigger(name, options, time) {
        if (name !== 'chime') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        const notes = Math.round(option(options, 'notes', 3, 1, CHIME_SLOTS));
        let degree = Math.floor(Math.random() * 3);
        for (let note = 0; note < notes; note++) {
          const frequency = fundamental * CHIME_OCTAVE * Math.pow(2, PENTATONIC[degree] / 12);
          ring(slots[chimes % CHIME_SLOTS], time + note * 0.085, frequency, strength * (note === 0 ? 1 : 0.8));
          chimes++;
          degree = Math.min(PENTATONIC.length - 1, degree + 1 + Math.floor(Math.random() * 2));
        }
        return true;
      },
      describe() {
        return { intensity, fundamental, chimes };
      },
    };
  },
});
