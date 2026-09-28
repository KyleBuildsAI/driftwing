// Geyser: a bubbling, gurgling pool with a thin wisp of steam between eruptions, and hiss bursts.
//
// setIntensity(0..1) is how restless the pool is (the gurgle and the idle steam). trigger('burst',
// { duration, strength }) erupts: a whoosh that sweeps up into a roaring, sputtering hiss of steam
// and water held for duration seconds (default 4), then a long fade with the water splattering
// back down.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, swell, sweep } from './recipeKit.js';

export default Object.freeze({
  name: 'geyser',
  summary: 'bubbling pool and hiss bursts',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 50, rolloffFactor: 1.3, panningModel: 'HRTF', size: 30, reverb: 0.25 }),
  level: 0.1,
  floor: 0.35,
  triggers: Object.freeze(['burst']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let bursts = 0;

    // Idle: bloops of a resonant low band, and a faint steam hiss.
    const gurgle = crackleBand(kit, { rate: 0.8, type: 'bandpass', frequency: 340, q: 4, crackleRate: 0.12, cutoff: 9, drive: 1.6 });
    const steam = noiseBand(kit, { rate: 1.2, type: 'highpass', frequency: 3200, q: 0.5 });

    // Burst: a hiss band sputtering on a fast random modulation, over a roaring body.
    const burstGain = scaffold.gain(0);
    burstGain.connect(out);
    const sputter = scaffold.gain(0.7);
    sputter.connect(burstGain);
    const sputterNoise = scaffold.noise(kit.noise, 0.9);
    const sputterFilter = scaffold.filter('lowpass', 14, 0.7);
    const sputterDepth = scaffold.gain(5);
    sputterNoise.connect(sputterFilter);
    sputterFilter.connect(sputterDepth);
    sputterDepth.connect(sputter.gain);
    const hiss = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 2600, q: 0.5, level: 1, destination: sputter });
    const roar = noiseBand(kit, { rate: 0.7, type: 'lowpass', frequency: 520, q: 0.7, level: 0.9, destination: burstGain });
    const splatter = crackleBand(kit, { rate: 1, type: 'bandpass', frequency: 1800, q: 0.7, crackleRate: 0.2, cutoff: 45, drive: 2.6 });

    function apply(time, timeConstant) {
      glide(gurgle.level.gain, 3 * (0.25 + 0.75 * intensity), time, timeConstant);
      glide(gurgle.crackle.drive.gain, 1.3 + 0.8 * intensity, time, timeConstant);
      glide(steam.gain.gain, 0.03 * intensity, time, timeConstant);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        apply(time, immediate ? 0.01 : 0.5);
      },
      trigger(name, options, time) {
        if (name !== 'burst') return false;
        const duration = option(options, 'duration', 4, 0.5, 30);
        const strength = option(options, 'strength', 1, 0, 1.5);
        bursts++;
        swell(burstGain.gain, time, 0.9 * strength, 0.35, duration, 2.8);
        sweep(hiss.filter.frequency, time, 700, 2600, 0.45);
        sweep(roar.filter.frequency, time, 260, 520, 0.6);
        swell(splatter.level.gain, time + duration * 0.6, 2.4 * strength, 0.8, duration * 0.4, 3.5);
        return true;
      },
      describe() {
        return { intensity, bursts };
      },
    };
  },
});
