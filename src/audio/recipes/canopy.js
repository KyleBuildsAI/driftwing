// The world tree: a vast canopy in the wind. Two layers of leaf rustle (band-passed noise, a hiss
// and a softer rush below it) that swell and ebb in slow gusts, and the deep, slow groan of the
// giant limbs: sparse pulses gating a resonant low band, like timber flexing under its own weight.
//
// setIntensity(0..1) is the approach: the rustle and the groans grow as the player closes in.
// trigger('creak', { strength }) is one long groan of a limb (a sweep down through the low band).
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, swell, sweep, wobble } from './recipeKit.js';

const RUSTLE_LEVEL = 0.34;
const RUSH_LEVEL = 0.22;
const GROAN_LEVEL = 0.6;

export default Object.freeze({
  name: 'canopy',
  summary: 'leaves rustling in gusts and the slow groan of giant limbs',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 220, rolloffFactor: 1.1, panningModel: 'HRTF', size: 500, reverb: 0.6 }),
  level: 0.05,
  floor: 0.15,
  triggers: Object.freeze(['creak']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let creaks = 0;

    const gusts = scaffold.gain(0.6);
    gusts.connect(out);
    wobble(kit, gusts.gain, 0.32, 0.07);
    const rustle = noiseBand(kit, { rate: 1.3, type: 'bandpass', frequency: 3200, q: 0.9, destination: gusts });
    const rush = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: 900, q: 0.7, destination: gusts });
    wobble(kit, rustle.filter.frequency, 900, 0.11);
    const groans = crackleBand(kit, { rate: 0.4, type: 'bandpass', frequency: 140, q: 6, crackleRate: 0.05, cutoff: 6, drive: 1.6 });
    const creak = noiseBand(kit, { rate: 0.5, type: 'bandpass', frequency: 220, q: 9 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.9;
        glide(rustle.gain.gain, RUSTLE_LEVEL * (0.25 + 0.75 * value), time, timeConstant);
        glide(rush.gain.gain, RUSH_LEVEL * (0.4 + 0.6 * value), time, timeConstant);
        glide(groans.level.gain, GROAN_LEVEL * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'creak') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        creaks++;
        swell(creak.gain.gain, time, 2.4 * strength, 0.5, 1.2, 1.4);
        sweep(creak.filter.frequency, time, 320, 110, 2.6);
        return true;
      },
      describe() {
        return { intensity, creaks };
      },
    };
  },
});
