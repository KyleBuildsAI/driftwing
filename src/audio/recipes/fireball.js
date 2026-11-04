// Fireball impact (preset 60): a bolide tearing down the sky with a rising, ragged roar, the double
// crack of its sonic boom and the deep thud of the impact rolling off the hills, then the crackle
// and hiss of the scorched ground burning.
//
// Before the impact setIntensity(0..1) is the approach (the structure engine's recipe level: 0 far,
// 1 at impact): a low roar whose band opens as it nears, over a tearing crackle. trigger('boom',
// { strength }) is the arrival: two sharp cracks a fifth of a second apart, a heavy thud and a long,
// low rumble; from then on setIntensity is the fire (the scar cooling): a bed of crackle and hiss.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, swell } from './recipeKit.js';

export default Object.freeze({
  name: 'fireball',
  summary: 'a bolide roar, a sonic boom and impact, then burning',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 900, rolloffFactor: 0.6, panningModel: 'equalpower', size: 200, reverb: 0.9 }),
  level: 0.08,
  floor: 0,
  triggers: Object.freeze(['boom']),

  build(kit) {
    let intensity = 0;
    let impacted = false;
    let booms = 0;

    const roar = noiseBand(kit, { rate: 0.55, type: 'lowpass', frequency: 160, q: 1 });
    const tear = crackleBand(kit, { rate: 0.8, type: 'bandpass', frequency: 900, q: 0.8, crackleRate: 0.4, cutoff: 70, drive: 2.4 });
    const crack = noiseBand(kit, { rate: 1, type: 'highpass', frequency: 900, q: 0.5 });
    const thud = noiseBand(kit, { rate: 0.35, type: 'lowpass', frequency: 70, q: 1.3 });
    const rumble = noiseBand(kit, { rate: 0.3, type: 'lowpass', frequency: 110, q: 0.8 });
    const fire = crackleBand(kit, { rate: 1.1, type: 'bandpass', frequency: 2600, q: 0.9, crackleRate: 0.3, cutoff: 60, drive: 2 });
    const hiss = noiseBand(kit, { rate: 1, type: 'highpass', frequency: 3800, q: 0.5 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.4;
        if (impacted) {
          glide(fire.level.gain, 0.5 * value, time, timeConstant * 3);
          glide(hiss.gain.gain, 0.08 * value, time, timeConstant * 3);
          return;
        }
        glide(roar.gain.gain, 0.8 * value, time, timeConstant);
        glide(roar.filter.frequency, 120 + 700 * value, time, timeConstant);
        glide(tear.level.gain, 0.4 * value * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'boom') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        booms++;
        impacted = true;
        glide(roar.gain.gain, 0, time, 0.08);
        glide(tear.level.gain, 0, time, 0.08);
        strike(crack.gain.gain, time, 0.9 * strength, 0.002, 0.18);
        strike(crack.gain.gain, time + 0.2, 0.7 * strength, 0.002, 0.2);
        strike(thud.gain.gain, time + 0.05, 1.2 * strength, 0.01, 1.4);
        swell(rumble.gain.gain, time + 0.1, 0.8 * strength, 0.3, 1.5, 7);
        return true;
      },
      describe() {
        return { intensity, impacted, booms };
      },
    };
  },
});
