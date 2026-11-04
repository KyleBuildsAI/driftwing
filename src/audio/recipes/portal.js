// The portal ring: a deep, beating hum with a glassy whine above it.
//
// The hum is two low triangle drones a fifth apart (params.baseHz, default 55 Hz) with a twin a little
// sharp of each, so the chord beats slowly, through a low-pass that opens with the approach; above it
// a narrow band of noise sings and wavers. setIntensity(0..1) is the approach: everything grows
// louder and brighter as the player closes in.
//
// trigger('surge', { strength }) is the crossing: a whoosh sweeping up through the band while the hum
// slides up an octave and back, as the world falls away.
import { glide } from '../synthKit.js';
import { noiseBand, option, swell, sweep, wobble } from './recipeKit.js';

const DRONE_RATIOS = Object.freeze([1, 1.5]);
const BEAT_HZ = Object.freeze([0.6, 0.9]);
const HUM_LEVEL = 0.22;
const WHINE_LEVEL = 0.05;

export default Object.freeze({
  name: 'portal',
  summary: 'deep beating hum and a wavering whine; a rising whoosh for a crossing',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 90, rolloffFactor: 1.3, panningModel: 'HRTF', size: 60, reverb: 0.75 }),
  level: 0.05,
  floor: 0.2,
  triggers: Object.freeze(['surge']),

  build(kit, params) {
    const { scaffold, out, context } = kit;
    const baseHz = option(params, 'baseHz', 55, 25, 400);
    let intensity = 0;
    let surges = 0;

    const tone = kit.pitched(scaffold.filter('lowpass', baseHz * 4, 1.2));
    const humLevel = scaffold.gain(0);
    tone.connect(humLevel);
    humLevel.connect(out);
    // One pitch signal drives every drone, so a surge slides the whole chord.
    const pitch = scaffold.add(new ConstantSourceNode(context, { offset: baseHz }));
    for (let index = 0; index < DRONE_RATIOS.length; index++) {
      for (const offset of [0, BEAT_HZ[index]]) {
        const oscillator = kit.pitched(scaffold.oscillator('triangle', offset));
        const ratio = scaffold.gain(DRONE_RATIOS[index]);
        pitch.connect(ratio);
        ratio.connect(oscillator.frequency);
        const level = scaffold.gain(index === 0 ? 0.5 : 0.32);
        oscillator.connect(level);
        level.connect(tone);
      }
    }
    const whine = noiseBand(kit, { rate: 1.2, type: 'bandpass', frequency: 1700, q: 14 });
    wobble(kit, whine.filter.frequency, 220, 0.37);
    const rush = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 300, q: 1.1 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.6;
        glide(humLevel.gain, HUM_LEVEL * (0.3 + 0.7 * value), time, timeConstant);
        glide(tone.frequency, baseHz * (3 + 6 * value), time, timeConstant);
        glide(whine.gain.gain, WHINE_LEVEL * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'surge') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        surges++;
        swell(rush.gain.gain, time, 0.9 * strength, 0.25, 0.5, 1.2);
        sweep(rush.filter.frequency, time, 200, 4200, 1.4);
        sweep(pitch.offset, time, baseHz, baseHz * 2, 0.7);
        pitch.offset.setTargetAtTime(baseHz, time + 0.8, 0.5);
        return true;
      },
      describe() {
        return { intensity, surges };
      },
    };
  },
});
