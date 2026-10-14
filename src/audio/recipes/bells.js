// Monastery bells and prayer flags (preset 53): the flutter and snap of many small flags in the wind,
// a deep temple bell struck now and then from the pavilion, and small bells tinkling in the gusts.
//
// The flags are band-passed noise gated by a fast, irregular flutter (two detuned LFOs), louder and
// brighter in a stronger wind. The temple bell is a struck set of inharmonic partials (a bronze bell's
// hum, prime, tierce, quint and nominal, each decaying in its own time) on a slow, beating pair, so
// it rings for many seconds with a gentle wow. The small bells are bright two-partial pings.
// setIntensity(0..1) is the wind on the flags (the structure engine drives it with the wind speed).
// update() strikes the temple bell every 24-48 s and the small bells more often in more wind.
// trigger('bell', { strength }) strikes the temple bell; trigger('chime', { strength }) the small bells.
import { glide } from '../synthKit.js';
import { noiseBand, option, strike } from './recipeKit.js';

const TEMPLE_HZ = 98;
/** A bronze bell's partials (ratios to the hum note an octave below the strike note) and decays (s). */
const BELL_PARTIALS = Object.freeze([
  Object.freeze({ ratio: 0.5, gain: 0.55, decay: 14 }),
  Object.freeze({ ratio: 1, gain: 0.8, decay: 9 }),
  Object.freeze({ ratio: 1.19, gain: 0.45, decay: 6 }),
  Object.freeze({ ratio: 1.5, gain: 0.25, decay: 4 }),
  Object.freeze({ ratio: 2, gain: 0.35, decay: 3.2 }),
  Object.freeze({ ratio: 2.51, gain: 0.12, decay: 1.8 }),
]);
const SMALL_BELL_HZ = Object.freeze([1568, 1760, 2093, 2349]);
const SMALL_SLOTS = 3;
const BELL_LEVEL = 0.16;
const SMALL_LEVEL = 0.05;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'bells',
  summary: 'prayer flags fluttering, a deep temple bell and small bells',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 110, rolloffFactor: 1.25, panningModel: 'HRTF', size: 60, reverb: 0.85 }),
  level: 0.05,
  floor: 0.3,
  triggers: Object.freeze(['bell', 'chime']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let nextBell = -1;
    let nextChime = -1;
    let bells = 0;
    let chimes = 0;

    // Flags: noise through a band whose flutter is two detuned LFOs (an irregular snapping).
    const flutterA = scaffold.modulated(0.45, 0.35, 7.3);
    const flutterB = scaffold.modulated(0.6, 0.4, 11.9, 'triangle');
    flutterA.carrier.connect(flutterB.carrier);
    flutterB.carrier.connect(out);
    const flags = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 1300, q: 0.7, destination: flutterA.carrier });
    const rustle = noiseBand(kit, { rate: 0.8, type: 'highpass', frequency: 3600, q: 0.5 });

    // The temple bell: its partials on a beating pair (a slow wow), each struck and left to ring.
    const partials = [];
    for (const partial of BELL_PARTIALS) {
      const voice = kit.pitched(scaffold.oscillator('sine', TEMPLE_HZ * 2 * partial.ratio));
      const twin = kit.pitched(scaffold.oscillator('sine', TEMPLE_HZ * 2 * partial.ratio + 0.6));
      const envelope = scaffold.gain(0);
      voice.connect(envelope);
      twin.connect(envelope);
      envelope.connect(out);
      partials.push({ envelope, partial });
    }
    // Small bells: round-robin slots of two bright partials.
    const slots = [];
    for (let index = 0; index < SMALL_SLOTS; index++) {
      const high = kit.pitched(scaffold.oscillator('sine', SMALL_BELL_HZ[0]));
      const higher = kit.pitched(scaffold.oscillator('sine', SMALL_BELL_HZ[0] * 2.76));
      const envelope = scaffold.gain(0);
      const overtone = scaffold.gain(0);
      high.connect(envelope);
      higher.connect(overtone);
      envelope.connect(out);
      overtone.connect(out);
      slots.push({ high, higher, envelope, overtone });
    }

    function ringBell(time, strength) {
      bells++;
      for (const { envelope, partial } of partials) strike(envelope.gain, time, BELL_LEVEL * strength * partial.gain, 0.004, partial.decay);
    }

    function ringSmall(time, strength) {
      const slot = slots[chimes % SMALL_SLOTS];
      chimes++;
      const frequency = SMALL_BELL_HZ[Math.floor(Math.random() * SMALL_BELL_HZ.length)];
      slot.high.frequency.setValueAtTime(frequency, time);
      slot.higher.frequency.setValueAtTime(frequency * 2.76, time);
      strike(slot.envelope.gain, time, SMALL_LEVEL * strength, 0.002, 1.6);
      strike(slot.overtone.gain, time, SMALL_LEVEL * 0.35 * strength, 0.002, 0.5);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.7;
        glide(flags.gain.gain, 0.05 + 0.5 * value, time, timeConstant);
        glide(flags.filter.frequency, 900 + 1400 * value, time, timeConstant);
        glide(rustle.gain.gain, 0.04 * value, time, timeConstant);
        glide(flutterA.lfo.frequency, 5 + 6 * value, time, timeConstant);
        glide(flutterB.lfo.frequency, 8 + 9 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        const strength = option(options, 'strength', 1, 0, 1.5);
        if (name === 'bell') {
          ringBell(time, strength);
          return true;
        }
        if (name === 'chime') {
          ringSmall(time, strength);
          return true;
        }
        return false;
      },
      update(time) {
        if (nextBell < 0) nextBell = time + randomBetween(3, 10);
        if (nextChime < 0) nextChime = time + randomBetween(2, 6);
        if (time >= nextBell) {
          ringBell(time, randomBetween(0.75, 1));
          nextBell = time + randomBetween(24, 48);
        }
        if (time >= nextChime) {
          ringSmall(time, 0.5 + 0.5 * intensity);
          nextChime = time + randomBetween(2, 5) / (0.3 + intensity);
        }
      },
      describe() {
        return { intensity, bells, chimes };
      },
    };
  },
});
