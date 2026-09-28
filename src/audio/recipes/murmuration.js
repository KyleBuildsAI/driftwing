// Starling murmuration: the rush of thousands of wings. A bright band of air fluttering on a fast
// random modulation (countless wingbeats), a low whoosh that surges as the flock turns, and a sparse
// high chatter of calls.
//
// setIntensity(0..1) is how close and dense the flock is. trigger('scatter') is the flock bursting
// apart around the craft: a sudden flurry of wingbeats that settles over a couple of seconds.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, swell } from './recipeKit.js';

export default Object.freeze({
  name: 'murmuration',
  summary: 'wing rush',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 70, rolloffFactor: 1.3, panningModel: 'HRTF', size: 180, reverb: 0.15 }),
  level: 0.06,
  floor: 0,
  triggers: Object.freeze(['scatter']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let scatters = 0;

    // Wing flutter: a band of air gated by fast random wingbeats, surging with the flock's turns.
    const rushSurge = scaffold.modulated(0.7, 0.3, 0.21);
    rushSurge.carrier.connect(out);
    const flutter = scaffold.gain(0.55);
    flutter.connect(rushSurge.carrier);
    const beatNoise = scaffold.noise(kit.noise, 2);
    const beatFilter = scaffold.filter('lowpass', 38, 0.7);
    const beatDepth = scaffold.gain(4);
    beatNoise.connect(beatFilter);
    beatFilter.connect(beatDepth);
    beatDepth.connect(flutter.gain);
    const rush = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 1700, q: 0.6, destination: flutter });

    const whooshSurge = scaffold.modulated(0.6, 0.4, 0.17);
    whooshSurge.carrier.connect(out);
    const whoosh = noiseBand(kit, { rate: 0.6, type: 'bandpass', frequency: 480, q: 0.5, destination: whooshSurge.carrier });

    const chatter = crackleBand(kit, { rate: 1.3, type: 'bandpass', frequency: 4300, q: 9, crackleRate: 0.25, cutoff: 55, drive: 1.5 });
    const flurry = crackleBand(kit, { rate: 1.1, type: 'bandpass', frequency: 2100, q: 0.6, crackleRate: 0.3, cutoff: 70, drive: 3.2 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.4;
        glide(rush.gain.gain, 0.5 * value, time, timeConstant);
        glide(whoosh.gain.gain, 0.3 * value, time, timeConstant);
        glide(chatter.level.gain, 2.2 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'scatter') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        scatters++;
        swell(flurry.level.gain, time, 3 * strength, 0.08, 0.35, 2.4);
        return true;
      },
      describe() {
        return { intensity, scatters };
      },
    };
  },
});
