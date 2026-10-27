// Forest wisps: a glassy shimmer. A cluster of high sine partials on a slow-drifting pentatonic chord,
// each fading in and out on its own slow cycle so the chord twinkles, over a breathy air band, and a
// soft rising "ting" now and then as a wisp brightens.
//
// setIntensity(0..1) is the wisps' presence (how near they are): the shimmer grows louder and
// brighter. update() schedules the twinkles and moves the chord on every 9 to 15 s.
import { glide } from '../synthKit.js';
import { noiseBand, option, strike, wobble } from './recipeKit.js';

/** Pentatonic chord tones (Hz) the shimmer moves between: E6 G#6 B6 C#7 E7 and neighbours. */
const CHORDS = Object.freeze([
  Object.freeze([1318.5, 1661.2, 1975.5, 2217.5, 2637]),
  Object.freeze([1244.5, 1480, 1864.7, 2093, 2489]),
  Object.freeze([1396.9, 1760, 2093, 2349.3, 2793.8]),
]);
const PARTIAL_LEVEL = 0.05;
const TING_SLOTS = 3;
const TING_LEVEL = 0.06;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'wisps',
  summary: 'glassy twinkling shimmer and soft tings',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 40, rolloffFactor: 1.6, panningModel: 'HRTF', size: 30, reverb: 0.8 }),
  level: 0.04,
  floor: 0.2,
  triggers: Object.freeze(['chime']),

  build(kit, params) {
    const { scaffold, out } = kit;
    const pitchScale = option(params, 'pitch', 1, 0.5, 2);
    let intensity = 0;
    let chord = 0;
    let nextChord = -1;
    let nextTing = -1;
    let tings = 0;

    const shimmer = scaffold.gain(0);
    shimmer.connect(out);
    const partials = [];
    for (let index = 0; index < CHORDS[0].length; index++) {
      const oscillator = kit.pitched(scaffold.oscillator('sine', CHORDS[0][index] * pitchScale));
      // Each partial breathes on its own slow cycle (0.07-0.21 Hz), never in step with the others.
      const twinkle = scaffold.modulated(0.5, 0.5, 0.07 + index * 0.031);
      oscillator.connect(twinkle.carrier);
      const level = scaffold.gain(PARTIAL_LEVEL * (1 - index * 0.12));
      twinkle.carrier.connect(level);
      level.connect(shimmer);
      wobble(kit, oscillator.frequency, 3 + index, 0.21 + index * 0.05);
      partials.push(oscillator);
    }
    const air = noiseBand(kit, { rate: 1.2, type: 'bandpass', frequency: 5200, q: 1.4 });
    const slots = [];
    for (let index = 0; index < TING_SLOTS; index++) {
      const oscillator = kit.pitched(scaffold.oscillator('triangle', 2637 * pitchScale));
      const envelope = scaffold.gain(0);
      oscillator.connect(envelope);
      envelope.connect(out);
      slots.push({ oscillator, envelope });
    }

    function ting(time, strength) {
      const slot = slots[tings % TING_SLOTS];
      const tones = CHORDS[chord];
      const frequency = tones[Math.floor(Math.random() * tones.length)] * 2 * pitchScale;
      slot.oscillator.frequency.setValueAtTime(frequency * 0.94, time);
      slot.oscillator.frequency.exponentialRampToValueAtTime(frequency, time + 0.12);
      strike(slot.envelope.gain, time, TING_LEVEL * strength * (0.4 + 0.6 * intensity), 0.02, 1.6);
      tings++;
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.8;
        glide(shimmer.gain, 0.25 + 0.75 * value, time, timeConstant);
        glide(air.gain.gain, 0.012 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'chime') return false;
        ting(time, option(options, 'strength', 1, 0, 1.5));
        return true;
      },
      update(time) {
        if (nextChord < 0) nextChord = time + randomBetween(9, 15);
        if (nextTing < 0) nextTing = time + randomBetween(1.5, 4);
        if (time >= nextTing) {
          if (intensity > 0.05) ting(time, 0.6 + Math.random() * 0.4);
          nextTing = time + randomBetween(1.8, 5.5);
        }
        if (time < nextChord) return;
        chord = (chord + 1) % CHORDS.length;
        const tones = CHORDS[chord];
        for (let index = 0; index < partials.length; index++) glide(partials[index].frequency, tones[index] * pitchScale, time, 1.4);
        nextChord = time + randomBetween(9, 15);
      },
      describe() {
        return { intensity, chord, tings };
      },
    };
  },
});
