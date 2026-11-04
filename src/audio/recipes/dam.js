// Dam with an open spillway (preset 57): the roar of the overflow plunging down the dam face, a deep,
// heavy rumble felt more than heard, surging slowly, and the hiss of the spray drifting off the
// stilling basin.
//
// The roar is two noise bands (a low thunder and a mid wash); the rumble a sub band whose level surges
// on a slow, irregular LFO pair; the spray a high hiss. setIntensity(0..1) is the flow over the
// spillway (constant for the preset, the structure engine's level): every layer follows it, and the
// wash brightens with it. No triggers.
import { glide } from '../synthKit.js';
import { noiseBand } from './recipeKit.js';

export default Object.freeze({
  name: 'dam',
  summary: 'a spillway roar with a surging sub rumble and spray',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 220, rolloffFactor: 0.8, panningModel: 'equalpower', size: 120, reverb: 0.7 }),
  level: 0.1,
  floor: 0.3,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;

    const thunder = noiseBand(kit, { rate: 0.45, type: 'lowpass', frequency: 180, q: 0.9 });
    const wash = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: 700, q: 0.6 });
    // The surge: two slow LFOs on the rumble's level (a beat that never quite repeats).
    const surgeA = scaffold.modulated(0.6, 0.3, 0.13);
    const surgeB = scaffold.modulated(0.7, 0.25, 0.071, 'triangle');
    surgeA.carrier.connect(surgeB.carrier);
    surgeB.carrier.connect(out);
    const rumble = noiseBand(kit, { rate: 0.25, type: 'lowpass', frequency: 55, q: 1.2, destination: surgeA.carrier });
    const spray = noiseBand(kit, { rate: 1.15, type: 'highpass', frequency: 4200, q: 0.5 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 1.2;
        glide(thunder.gain.gain, 0.7 * value, time, timeConstant);
        glide(wash.gain.gain, 0.35 * value, time, timeConstant);
        glide(wash.filter.frequency, 450 + 500 * value, time, timeConstant);
        glide(rumble.gain.gain, 0.9 * value, time, timeConstant);
        glide(spray.gain.gain, 0.06 * value, time, timeConstant);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity };
      },
    };
  },
});
