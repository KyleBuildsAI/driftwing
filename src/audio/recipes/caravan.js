// Camel caravan (preset 58): the hollow clonk of copper camel bells swinging out of step down the
// line, soft footfalls in the sand, the creak of the saddles and now and then a camel's gargling
// grumble.
//
// The bells are struck in update() on an irregular schedule (several camels, each bell on its own
// stride), each a hollow pair of partials, round-robin over a few slots. The footfalls are low noise
// under a slow sway, the creaks a sparse crackle. setIntensity(0..1) is the caravan's presence (the
// fauna engine's voice level): the bells ring more often and the footfalls swell with it.
// trigger('bell', { strength }) clonks a bell; trigger('grumble', { strength }) grumbles.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, swell, sweep } from './recipeKit.js';

const BELL_HZ = Object.freeze([392, 440, 466, 523, 587]);
const BELL_SLOTS = 4;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'caravan',
  summary: 'camel bells, footfalls in sand and a grumble',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 60, rolloffFactor: 1.4, panningModel: 'HRTF', size: 40, reverb: 0.3 }),
  level: 0.04,
  floor: 0.2,
  triggers: Object.freeze(['bell', 'grumble']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let nextBell = -1;
    let nextGrumble = -1;
    let bells = 0;
    let grumbles = 0;

    const slots = [];
    for (let index = 0; index < BELL_SLOTS; index++) {
      const fundamental = kit.pitched(scaffold.oscillator('triangle', BELL_HZ[0]));
      const partial = kit.pitched(scaffold.oscillator('sine', BELL_HZ[0] * 2.32));
      const envelope = scaffold.gain(0);
      const partialLevel = scaffold.gain(0);
      fundamental.connect(envelope);
      partial.connect(partialLevel);
      envelope.connect(out);
      partialLevel.connect(out);
      slots.push({ fundamental, partial, envelope, partialLevel });
    }
    const sway = scaffold.modulated(0.5, 0.4, 0.7);
    sway.carrier.connect(out);
    const footfalls = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 260, q: 0.7, destination: sway.carrier });
    const creak = crackleBand(kit, { rate: 0.7, type: 'bandpass', frequency: 1100, q: 4, crackleRate: 0.08, cutoff: 20, drive: 1.4 });
    // The grumble: a low sawtooth through a resonant band, chopped fast (the gargle).
    const growl = kit.pitched(scaffold.oscillator('sawtooth', 85));
    const throat = kit.pitched(scaffold.filter('bandpass', 380, 3));
    const gargle = scaffold.modulated(0, 1, 23);
    const growlLevel = scaffold.gain(0);
    growl.connect(throat);
    throat.connect(gargle.carrier);
    gargle.carrier.connect(growlLevel);
    growlLevel.connect(out);

    function clonk(time, strength) {
      const slot = slots[bells % BELL_SLOTS];
      bells++;
      const frequency = BELL_HZ[Math.floor(Math.random() * BELL_HZ.length)];
      slot.fundamental.frequency.setValueAtTime(frequency, time);
      slot.partial.frequency.setValueAtTime(frequency * 2.32, time);
      strike(slot.envelope.gain, time, 0.07 * strength, 0.003, 1.1);
      strike(slot.partialLevel.gain, time, 0.035 * strength, 0.002, 0.45);
    }

    function grumble(time, strength) {
      grumbles++;
      sweep(growl.frequency, time, 95, 70, 1.4);
      swell(growlLevel.gain, time, 0.06 * strength, 0.1, 0.9, 0.5);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.8;
        glide(footfalls.gain.gain, 0.4 * value, time, timeConstant);
        glide(creak.level.gain, 0.25 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        const strength = option(options, 'strength', 1, 0, 1.5);
        if (name === 'bell') {
          clonk(time, strength);
          return true;
        }
        if (name === 'grumble') {
          grumble(time, strength);
          return true;
        }
        return false;
      },
      update(time) {
        if (nextBell < 0) nextBell = time + randomBetween(0.2, 1);
        if (nextGrumble < 0) nextGrumble = time + randomBetween(6, 14);
        if (time >= nextBell) {
          if (intensity > 0.05) clonk(time, randomBetween(0.5, 1));
          nextBell = time + randomBetween(0.25, 0.9) / (0.4 + intensity);
        }
        if (time >= nextGrumble) {
          if (intensity > 0.05) grumble(time, randomBetween(0.6, 1));
          nextGrumble = time + randomBetween(12, 30);
        }
      },
      describe() {
        return { intensity, bells, grumbles };
      },
    };
  },
});
