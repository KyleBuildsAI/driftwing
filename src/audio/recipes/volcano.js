// Volcano: a sub-bass rumble from deep inside the mountain, a roiling, surging mid layer (the vent
// churning), a breathy degassing hiss, and eruption booms.
//
// setIntensity(0..1) is the activity: a dormant cone at about 0.15 only murmurs; 1 is a full
// eruption. trigger('boom', { strength }) fires an explosion: a pressure thump with a falling
// pitch, a burst of low noise, and a patter of falling tephra a moment later. Two boom slots
// alternate, so booms may overlap.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, sweep, wobble } from './recipeKit.js';

const BOOM_SLOTS = 2;

export default Object.freeze({
  name: 'volcano',
  summary: 'sub-bass rumble and eruption booms',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 700, rolloffFactor: 0.9, panningModel: 'equalpower', size: 500, reverb: 0.3 }),
  level: 0.12,
  floor: 0.15,
  triggers: Object.freeze(['boom']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let booms = 0;

    // Rumble: very low noise and two slowly beating sub sines.
    const rumbleSurge = scaffold.modulated(0.75, 0.25, 0.09);
    rumbleSurge.carrier.connect(out);
    const rumble = noiseBand(kit, { rate: 0.25, type: 'lowpass', frequency: 58, q: 1, destination: rumbleSurge.carrier });
    const subGain = scaffold.gain(0);
    subGain.connect(rumbleSurge.carrier);
    const subA = kit.pitched(scaffold.oscillator('sine', 27));
    const subB = kit.pitched(scaffold.oscillator('sine', 29.3));
    subA.connect(subGain);
    subB.connect(subGain);

    // Roil: the vent churning, in irregular surges.
    const roil = crackleBand(kit, { rate: 0.45, type: 'bandpass', frequency: 170, q: 0.8, crackleRate: 0.05, cutoff: 3, drive: 2.2 });
    // Degassing hiss, gently wandering.
    const hiss = noiseBand(kit, { rate: 1.07, type: 'bandpass', frequency: 950, q: 0.6 });
    wobble(kit, hiss.filter.frequency, 260, 0.045);

    // Boom slots: thump oscillator, low noise burst and tephra patter.
    const slots = [];
    for (let index = 0; index < BOOM_SLOTS; index++) {
      const burstGain = scaffold.gain(0);
      burstGain.connect(out);
      const burst = noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 300, q: 0.8, level: 1, destination: burstGain });
      const thump = kit.pitched(scaffold.oscillator('sine', 60));
      const thumpGain = scaffold.gain(0);
      thump.connect(thumpGain);
      thumpGain.connect(out);
      const tephra = crackleBand(kit, { rate: 1, type: 'bandpass', frequency: 1500, q: 0.8, crackleRate: 0.18, cutoff: 40, drive: 2.4 });
      slots.push({ burstGain, burst, thump, thumpGain, tephra });
    }

    function apply(time, timeConstant) {
      const activity = intensity;
      glide(rumble.gain.gain, 1.1 * (0.35 + 0.65 * activity), time, timeConstant);
      glide(subGain.gain, 0.1 * (0.3 + 0.7 * activity), time, timeConstant);
      glide(roil.level.gain, 2.2 * activity, time, timeConstant);
      glide(roil.crackle.drive.gain, 1.6 + 1.2 * activity, time, timeConstant);
      glide(hiss.gain.gain, 0.05 * activity, time, timeConstant);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        apply(time, immediate ? 0.01 : 0.8);
      },
      trigger(name, options, time) {
        if (name !== 'boom') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        const slot = slots[booms % BOOM_SLOTS];
        booms++;
        strike(slot.thumpGain.gain, time, 0.55 * strength, 0.008, 1.6);
        sweep(slot.thump.frequency, time, 85, 24, 1.2);
        strike(slot.burstGain.gain, time, 1.3 * strength, 0.012, 3.2);
        sweep(slot.burst.filter.frequency, time, 1400, 160, 1.6);
        // The tephra patter starts as the bombs come down.
        strike(slot.tephra.level.gain, time + 1.4, 1.6 * strength, 0.5, 4.5);
        return true;
      },
      describe() {
        return { intensity, booms };
      },
    };
  },
});
