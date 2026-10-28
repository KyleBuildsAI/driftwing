// Caribou migration (preset 52): the soft, rolling drum of hundreds of hooves on the tundra, the dry
// clicking of their ankles (a caribou's foot tendon clicks with every stride, and a herd on the move
// crackles with it) and now and then a low, snorting grunt from somewhere in the column.
//
// The hooves are low-passed noise pulsed by a slow LFO pair at a walking cadence, with a sub thud
// under it. The clicks are a dense, bright crackle band. setIntensity(0..1) is the column's presence
// (the fauna engine's voice level): the drum and the clicks swell with it. update() grunts every
// 4-10 s; trigger('grunt', { strength }) grunts at once: a gravelly sawtooth that drops in pitch.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, swell, sweep } from './recipeKit.js';

const GRUNT_SLOTS = 2;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'caribou',
  summary: 'a drum of hooves, clicking ankles and grunts',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 90, rolloffFactor: 1.3, panningModel: 'HRTF', size: 120, reverb: 0.35 }),
  level: 0.05,
  floor: 0.2,
  triggers: Object.freeze(['grunt']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let nextGrunt = -1;
    let grunts = 0;

    // Hooves: noise under a walking pulse (two LFOs a little apart, so the beat never settles).
    const cadenceA = scaffold.modulated(0.5, 0.45, 2.3);
    const cadenceB = scaffold.modulated(0.6, 0.35, 3.1, 'triangle');
    cadenceA.carrier.connect(cadenceB.carrier);
    cadenceB.carrier.connect(out);
    const hooves = noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 320, q: 0.8, destination: cadenceA.carrier });
    const thud = noiseBand(kit, { rate: 0.4, type: 'lowpass', frequency: 90, q: 1.1 });
    // Clicking ankles: a dense, bright crackle.
    const clicks = crackleBand(kit, { rate: 1.1, type: 'bandpass', frequency: 3200, q: 2.2, crackleRate: 0.6, cutoff: 160, drive: 2.6 });

    // Grunts: a sawtooth through a low band, swelled and dropping in pitch.
    const slots = [];
    for (let index = 0; index < GRUNT_SLOTS; index++) {
      const source = kit.pitched(scaffold.oscillator('sawtooth', 120));
      const band = kit.pitched(scaffold.filter('lowpass', 520, 2.5));
      const envelope = scaffold.gain(0);
      source.connect(band);
      band.connect(envelope);
      envelope.connect(out);
      slots.push({ source, envelope });
    }

    function grunt(time, strength) {
      const slot = slots[grunts % GRUNT_SLOTS];
      grunts++;
      const pitch = randomBetween(95, 135);
      sweep(slot.source.frequency, time, pitch, pitch * 0.7, 0.45);
      swell(slot.envelope.gain, time, 0.05 * strength, 0.04, 0.22, 0.3);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.8;
        glide(hooves.gain.gain, 0.55 * value, time, timeConstant);
        glide(thud.gain.gain, 0.4 * value, time, timeConstant);
        glide(clicks.level.gain, 0.6 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'grunt') return false;
        grunt(time, option(options, 'strength', 1, 0, 1.5));
        return true;
      },
      update(time) {
        if (nextGrunt < 0) nextGrunt = time + randomBetween(1, 4);
        if (time >= nextGrunt) {
          if (intensity > 0.05) grunt(time, randomBetween(0.6, 1) * Math.min(1, intensity * 1.5));
          nextGrunt = time + randomBetween(4, 10);
        }
      },
      describe() {
        return { intensity, grunts };
      },
    };
  },
});
