// The sleeping stone giant: slow, enormous breathing with a grinding snore under it.
//
// The breath is two bands of air noise (a low rush and a hollow throat band); the snore is a buzzing
// low sawtooth through a narrow low-pass, gated by its own slow flutter, with a deep sub tone under
// it. setIntensity(0..1) is the breath itself: the breath emitter's pulsing level drives it (the
// emitter owns the voice), so the giant is loudest as the mist puffs from its nose and quiet between.
// The snore comes in only near the top of each breath.
import { glide } from '../synthKit.js';
import { noiseBand, option, wobble } from './recipeKit.js';

const RUSH_LEVEL = 0.42;
const THROAT_LEVEL = 0.26;
const SNORE_LEVEL = 0.2;
const SUB_LEVEL = 0.32;

export default Object.freeze({
  name: 'giant',
  summary: 'slow, enormous breathing with a grinding snore',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 400, rolloffFactor: 1.6, panningModel: 'HRTF', size: 800, reverb: 0.7 }),
  level: 0.06,
  floor: 0.05,
  triggers: Object.freeze([]),

  build(kit, params) {
    const { scaffold, out } = kit;
    const snoreHz = option(params, 'snoreHz', 41, 20, 120);
    let intensity = 0;

    const rush = noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 520, q: 0.6 });
    const throat = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: 260, q: 2.4 });
    wobble(kit, throat.filter.frequency, 40, 0.13);
    const snoreLevel = scaffold.gain(0);
    snoreLevel.connect(out);
    const flutter = scaffold.gain(0.55);
    flutter.connect(snoreLevel);
    wobble(kit, flutter.gain, 0.45, 23);
    const snoreTone = kit.pitched(scaffold.filter('lowpass', snoreHz * 4, 3));
    snoreTone.connect(flutter);
    const buzz = kit.pitched(scaffold.oscillator('sawtooth', snoreHz));
    buzz.connect(snoreTone);
    const subLevel = scaffold.gain(0);
    subLevel.connect(out);
    const sub = kit.pitched(scaffold.oscillator('sine', snoreHz * 0.5));
    sub.connect(subLevel);

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.45;
        const breath = Math.pow(Math.min(Math.max(value, 0), 1), 1.5);
        const snore = Math.max(0, (value - 0.65) / 0.35);
        glide(rush.gain.gain, RUSH_LEVEL * breath, time, timeConstant);
        glide(throat.gain.gain, THROAT_LEVEL * breath, time, timeConstant);
        glide(snoreLevel.gain, SNORE_LEVEL * snore * snore, time, timeConstant);
        glide(subLevel.gain, SUB_LEVEL * breath, time, timeConstant);
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
