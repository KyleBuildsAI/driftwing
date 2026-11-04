// Gale: a storm wind. A howl that whistles and moans as its pitch wanders, gusts that swell and
// die away on slow out-of-step cycles, a broad buffeting body under them, and a fine hiss of
// whatever the wind carries (sand grit, snow, sea spray) riding the gusts.
//
// setIntensity(0..1) is the wind's strength: 0 is silent, 1 a full gale; the howl rises in pitch
// and the hiss thickens as it strengthens. params (a preset's audio.params) may set grit (0..1,
// default 0.5: the carried hiss), howl (0..1, default 0.6: the whistle) and depth (0..1, default
// 0.4: the low buffeting, a hurricane's roar near 1). Heard far (inverse distance law, a wide
// reference distance), so a sandstorm wall or a squall line is heard before it arrives.
import { glide } from '../synthKit.js';
import { noiseBand, option, wobble } from './recipeKit.js';

export default Object.freeze({
  name: 'gale',
  summary: 'howling storm wind with gusts and grit',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 400, rolloffFactor: 1, panningModel: 'equalpower', size: 600, reverb: 0.2 }),
  level: 0.12,
  floor: 0,
  triggers: Object.freeze([]),

  build(kit, params) {
    const { scaffold, out } = kit;
    const grit = option(params, 'grit', 0.5, 0, 1);
    const howlShare = option(params, 'howl', 0.6, 0, 1);
    const depth = option(params, 'depth', 0.4, 0, 1);
    let intensity = 0;

    // Gusts: two slow swells out of step, multiplied into everything that moves with the wind.
    const gustSlow = scaffold.modulated(0.7, 0.3, 0.083);
    const gustFast = scaffold.modulated(0.75, 0.25, 0.19, 'triangle');
    gustSlow.carrier.connect(gustFast.carrier);
    gustFast.carrier.connect(out);

    // Body: broadband buffeting air, mid-low, the bulk of the gale.
    const body = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: 520, q: 0.6, destination: gustSlow.carrier });

    // Howl: two narrow, resonant bands whose centres wander independently (the wind singing past
    // edges), a fifth or so apart.
    const howlLow = noiseBand(kit, { rate: 0.9, type: 'bandpass', frequency: 640, q: 14, destination: gustSlow.carrier });
    const howlHigh = noiseBand(kit, { rate: 1.05, type: 'bandpass', frequency: 980, q: 18, destination: gustFast.carrier });
    wobble(kit, howlLow.filter.frequency, 140, 0.071);
    wobble(kit, howlHigh.filter.frequency, 210, 0.113, 'triangle');

    // Grit: a fine high hiss on the gusts.
    const hiss = noiseBand(kit, { rate: 1.2, type: 'highpass', frequency: 4200, q: 0.6, destination: gustFast.carrier });

    // Depth: a low rumble of the whole storm, steady under the gusts.
    const rumble = noiseBand(kit, { rate: 0.45, type: 'lowpass', frequency: 110, q: 0.7 });

    function apply(time, timeConstant) {
      const strength = intensity;
      glide(body.gain.gain, 0.6 * Math.pow(strength, 0.8), time, timeConstant);
      glide(body.filter.frequency, 380 + 320 * strength, time, timeConstant);
      glide(howlLow.gain.gain, 1.4 * howlShare * strength * strength, time, timeConstant);
      glide(howlHigh.gain.gain, 1.1 * howlShare * strength * strength, time, timeConstant);
      glide(hiss.gain.gain, 0.32 * grit * strength, time, timeConstant);
      glide(rumble.gain.gain, 0.9 * depth * strength, time, timeConstant);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        apply(time, immediate ? 0.01 : 0.6);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity, grit, howl: howlShare, depth };
      },
    };
  },
});
