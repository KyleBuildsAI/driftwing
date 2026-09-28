// Waterfall: a pink-noise roar in three layers (a thundering low plunge, the broad body of falling
// water, a bright spray hiss), each surging slowly and independently the way real falls do.
//
// setIntensity(0..1) is the flow: more water is louder and fuller in the low end.
import { glide } from '../synthKit.js';
import { noiseBand } from './recipeKit.js';

export default Object.freeze({
  name: 'waterfall',
  summary: 'pink-noise roar',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 130, rolloffFactor: 1, panningModel: 'equalpower', size: 160, reverb: 0.35 }),
  level: 0.1,
  floor: 0,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;

    const plungeSurge = scaffold.modulated(0.85, 0.15, 0.071);
    plungeSurge.carrier.connect(out);
    const plunge = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 190, q: 0.7, destination: plungeSurge.carrier });

    const bodySurge = scaffold.modulated(0.9, 0.1, 0.113);
    bodySurge.carrier.connect(out);
    const body = noiseBand(kit, { rate: 1, type: 'lowpass', frequency: 4200, q: 0.5, destination: bodySurge.carrier });
    const warmth = kit.pitched(scaffold.filter('lowshelf', 260, 0.7));
    warmth.gain.value = 5;
    body.filter.disconnect();
    body.filter.connect(warmth);
    warmth.connect(body.gain);

    const spraySurge = scaffold.modulated(0.8, 0.2, 0.167);
    spraySurge.carrier.connect(out);
    const spray = noiseBand(kit, { rate: 1.13, type: 'highpass', frequency: 2600, q: 0.5, destination: spraySurge.carrier });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.6;
        glide(plunge.gain.gain, 1.1 * Math.pow(value, 0.7), time, timeConstant);
        glide(body.gain.gain, 0.42 * value, time, timeConstant);
        glide(spray.gain.gain, 0.2 * value, time, timeConstant);
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
