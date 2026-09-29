// Tornado: a low, surging roar (the "freight train"), a howling whistle that wanders in pitch, a
// felt sub-bass rumble and a debris rattle of sparse bright hits over duller thuds.
//
// setIntensity(0..1) is the vortex strength: 0 is silent, 1 a violent tornado. The roar opens up
// and the debris gets denser as it strengthens. Heard for kilometres (inverse distance law with a
// large reference distance; the air-absorption filter leaves only the roar far away).
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, wobble } from './recipeKit.js';

export default Object.freeze({
  name: 'tornado',
  summary: 'low roar and debris rattle',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 320, rolloffFactor: 1, panningModel: 'equalpower', size: 220, reverb: 0.16 }),
  level: 0.14,
  floor: 0,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;

    // Roar and growl through a slow surge, so the whole body breathes like a passing train.
    const surge = scaffold.modulated(0.8, 0.2, 0.17);
    surge.carrier.connect(out);
    const roar = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 140, q: 0.8, destination: surge.carrier });
    const growlSurge = scaffold.modulated(0.7, 0.3, 0.11);
    growlSurge.carrier.connect(surge.carrier);
    const growl = noiseBand(kit, { rate: 0.37, type: 'bandpass', frequency: 310, q: 1.1, destination: growlSurge.carrier });

    // Howl: a narrow band of wind whose centre drifts, like air screaming past obstacles.
    const howlSurge = scaffold.modulated(0.6, 0.4, 0.23);
    howlSurge.carrier.connect(out);
    const howl = noiseBand(kit, { rate: 0.83, type: 'bandpass', frequency: 430, q: 7, destination: howlSurge.carrier });
    wobble(kit, howl.filter.frequency, 120, 0.063);

    // Sub-bass: two sines beating slowly, felt more than heard.
    const sub = scaffold.gain(0);
    sub.connect(out);
    const subLow = kit.pitched(scaffold.oscillator('sine', 31));
    const subHigh = kit.pitched(scaffold.oscillator('sine', 33.4));
    subLow.connect(sub);
    subHigh.connect(sub);

    // Debris: bright rattling hits over a slower rumble of heavier thuds.
    const rattle = crackleBand(kit, { rate: 1, frequency: 2400, q: 0.9, crackleRate: 0.16, cutoff: 34, drive: 1.6 });
    const thuds = crackleBand(kit, { rate: 0.7, frequency: 620, q: 1.3, crackleRate: 0.07, cutoff: 11, drive: 1.4 });

    function apply(time, timeConstant) {
      const strength = intensity;
      glide(roar.gain.gain, 0.95 * Math.pow(strength, 0.8), time, timeConstant);
      glide(roar.filter.frequency, 95 + 120 * strength, time, timeConstant);
      glide(growl.gain.gain, 0.7 * strength, time, timeConstant);
      glide(howl.gain.gain, 0.22 * strength * strength, time, timeConstant);
      glide(sub.gain, 0.07 * strength, time, timeConstant);
      glide(rattle.level.gain, 1.6 * strength, time, timeConstant);
      glide(rattle.crackle.drive.gain, 1.3 + 1.5 * strength, time, timeConstant);
      glide(thuds.level.gain, 1.4 * strength, time, timeConstant);
      glide(thuds.crackle.drive.gain, 1.2 + 1.2 * strength, time, timeConstant);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        apply(time, immediate ? 0.01 : 0.4);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity, roarCutoff: 95 + 120 * intensity };
      },
    };
  },
});
