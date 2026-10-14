// Stone wind: the wind moaning through rock, for the five-arch chain and the badland hoodoos. Three
// hollow resonances (narrow bands of noise, like air across the mouth of a jar) drift slowly in pitch
// and swell and fade independently, over a soft broadband rush and a low buffeting; a fine trickle of
// grit runs down the stone in stronger wind.
//
// setIntensity(0..1) is the wind speed at the stone (the structure engine drives it from the
// WindField): the moans rise in pitch and level with it, as the air through a gap does.
// params.pitch scales the resonances (larger openings moan lower: the arches about 0.8).
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, wobble } from './recipeKit.js';

/** The hollow resonances at pitch 1: centre frequency (Hz), band Q, the swell rate (Hz) and its depth. */
const MOANS = Object.freeze([
  Object.freeze({ frequency: 190, q: 28, rate: 0.071, depth: 0.85 }),
  Object.freeze({ frequency: 285, q: 32, rate: 0.053, depth: 0.9 }),
  Object.freeze({ frequency: 430, q: 36, rate: 0.089, depth: 0.95 }),
]);

export default Object.freeze({
  name: 'stoneWind',
  summary: 'wind moaning through rock',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 140, rolloffFactor: 1.3, panningModel: 'equalpower', size: 220, reverb: 0.45 }),
  level: 0.05,
  floor: 0.15,
  triggers: Object.freeze([]),

  build(kit, params) {
    const { scaffold, out } = kit;
    const pitch = option(params, 'pitch', 1, 0.4, 2);
    let intensity = 0;

    const moans = MOANS.map((moan) => {
      const swellGain = scaffold.modulated(0.5, 0.5 * moan.depth, moan.rate);
      swellGain.carrier.connect(out);
      const band = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: moan.frequency * pitch, q: moan.q, destination: swellGain.carrier });
      // The pitch wanders a few per cent on its own slow cycle (gusts in the gap).
      wobble(kit, band.filter.frequency, moan.frequency * pitch * 0.03, moan.rate * 1.7);
      return { ...moan, band };
    });
    const rush = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: 900, q: 0.4 });
    const buffet = noiseBand(kit, { rate: 0.45, type: 'lowpass', frequency: 120, q: 0.7 });
    const grit = crackleBand(kit, { rate: 1, type: 'highpass', frequency: 3800, q: 0.6, crackleRate: 0.25, cutoff: 60, drive: 1.4 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.9;
        for (const moan of moans) {
          glide(moan.band.gain.gain, 3.2 * value * value, time, timeConstant);
          glide(moan.band.filter.frequency, moan.frequency * pitch * (0.85 + 0.35 * value), time, timeConstant);
        }
        glide(rush.gain.gain, 0.12 * (0.2 + 0.8 * value), time, timeConstant);
        glide(buffet.gain.gain, 0.5 * value, time, timeConstant);
        glide(grit.level.gain, 0.35 * Math.max(0, value - 0.4), time, timeConstant);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity, pitch };
      },
    };
  },
});
