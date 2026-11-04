// Wind rush: open-air wind with character. A broad, gusting rush (low-passed noise through a slow,
// irregular surge), a hiss of air through grass and rock above it, and two optional voices a preset
// asks for in its audio params:
//   howlHz / howl  a resonant moan, a narrow band of wind whose centre wanders around howlHz (a canyon
//                  or a tunnel bore singing; 0 Hz leaves it out)
//   flutter        fabric snapping in the wind: a buzzing band chopped at 9-14 Hz (kites, flags)
//   gust           how hard the gusts surge (0 steady .. 1 wild)
//
// setIntensity(0..1) is the wind's strength there: louder, brighter and gustier as it rises.
import { glide } from '../synthKit.js';
import { noiseBand, option, wobble } from './recipeKit.js';

export default Object.freeze({
  name: 'windRush',
  summary: 'gusting wind rush, optional howl and fabric flutter',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 220, rolloffFactor: 1.2, panningModel: 'equalpower', size: 300, reverb: 0.4 }),
  level: 0.06,
  floor: 0.15,
  triggers: Object.freeze([]),

  build(kit, params) {
    const { scaffold, out } = kit;
    const howlHz = option(params, 'howlHz', 0, 0, 2000);
    const howlLevel = howlHz > 0 ? option(params, 'howl', 0.5, 0, 1) : 0;
    const flutterLevel = option(params, 'flutter', 0, 0, 1);
    const gustiness = option(params, 'gust', 0.6, 0, 1);
    let intensity = 0;

    // Two slow surges beating against each other make the gusts irregular.
    const surgeA = scaffold.modulated(1 - 0.35 * gustiness, 0.35 * gustiness, 0.089);
    const surgeB = scaffold.modulated(1 - 0.25 * gustiness, 0.25 * gustiness, 0.231);
    surgeA.carrier.connect(surgeB.carrier);
    surgeB.carrier.connect(out);
    const rush = noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 520, q: 0.6, destination: surgeA.carrier });
    wobble(kit, rush.filter.frequency, 160 * gustiness, 0.137);
    const hiss = noiseBand(kit, { rate: 1.1, type: 'bandpass', frequency: 3200, q: 0.7, destination: surgeA.carrier });

    let howl = null;
    if (howlLevel > 0) {
      const howlSurge = scaffold.modulated(0.6, 0.4, 0.071);
      howlSurge.carrier.connect(out);
      howl = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: howlHz, q: 9, destination: howlSurge.carrier });
      wobble(kit, howl.filter.frequency, howlHz * 0.12, 0.053);
    }
    let flutter = null;
    if (flutterLevel > 0) {
      // A buzzing band gated by a fast square chop whose rate itself wanders (the fabric snapping).
      const chop = scaffold.modulated(0.5, 0.5, 11, 'square');
      wobble(kit, chop.lfo.frequency, 2.5, 0.31);
      chop.carrier.connect(out);
      flutter = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 900, q: 2.2, destination: chop.carrier });
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.9;
        glide(rush.gain.gain, 0.55 * Math.pow(value, 0.8), time, timeConstant);
        glide(rush.filter.frequency, 360 + 520 * value, time, timeConstant);
        glide(hiss.gain.gain, 0.08 * value * value, time, timeConstant);
        if (howl) glide(howl.gain.gain, 0.5 * howlLevel * value, time, timeConstant);
        if (flutter) glide(flutter.gain.gain, 0.16 * flutterLevel * value, time, timeConstant);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity, howlHz, flutter: flutterLevel, gust: gustiness };
      },
    };
  },
});
