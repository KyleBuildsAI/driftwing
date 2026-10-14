// Calving glacier: the ice front groaning and ticking as it creeps into the sea, the crack that rings
// out when a slab breaks away, and the splash as it plunges into the water.
//
// setIntensity(0..1) is how restless the ice is: deep groans (a low sawtooth through narrow resonances,
// gliding slowly) and the dry ticks of the ice settling, more of both at 1. trigger('crack',
// { strength }) is the slab breaking off: a sharp report, a boom and a rumble rolling after it.
// trigger('splash', { strength }) is the slab hitting the sea: a deep whump and the wash of water.
// Groans are scheduled a little ahead on nodes that already exist, so the ice allocates nothing.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, swell, sweep } from './recipeKit.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'calving',
  summary: 'groaning ice, the crack of a slab breaking and its splash',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 260, rolloffFactor: 1.1, panningModel: 'equalpower', size: 220, reverb: 0.7 }),
  level: 0.08,
  floor: 0.2,
  triggers: Object.freeze(['crack', 'splash']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let groans = 0;
    let cracks = 0;
    let splashes = 0;
    let nextAt = -1;

    // Groans: a low sawtooth through two narrow resonances, under an envelope.
    const groanGain = scaffold.gain(0);
    groanGain.connect(out);
    const groanTone = kit.pitched(scaffold.oscillator('sawtooth', 70));
    const resonanceA = kit.pitched(scaffold.filter('bandpass', 240, 9));
    const resonanceB = kit.pitched(scaffold.filter('bandpass', 610, 12));
    groanTone.connect(resonanceA);
    groanTone.connect(resonanceB);
    resonanceA.connect(groanGain);
    resonanceB.connect(groanGain);
    // Ticks: sparse dry clicks of the ice settling.
    const ticks = crackleBand(kit, { rate: 1, type: 'bandpass', frequency: 3400, q: 1.2, crackleRate: 0.1, cutoff: 22, drive: 1.4 });
    // The crack: a bright report, a boom under it and a rumble rolling after.
    const reportGain = scaffold.gain(0);
    reportGain.connect(out);
    noiseBand(kit, { rate: 1.3, type: 'highpass', frequency: 1100, q: 0.6, level: 1, destination: reportGain });
    const boomGain = scaffold.gain(0);
    boomGain.connect(out);
    const boom = noiseBand(kit, { rate: 0.45, type: 'lowpass', frequency: 110, q: 1, level: 1, destination: boomGain });
    const rumbleGain = scaffold.gain(0);
    rumbleGain.connect(out);
    noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 260, q: 0.6, level: 1, destination: rumbleGain });
    // The splash: a whump sweeping down and the wash of displaced water.
    const washGain = scaffold.gain(0);
    washGain.connect(out);
    const wash = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 900, q: 0.5, level: 1, destination: washGain });

    function scheduleGroan(start) {
      const seconds = randomBetween(1.2, 3.4);
      const from = randomBetween(48, 96);
      groanTone.frequency.cancelScheduledValues(start);
      groanTone.frequency.setValueAtTime(from, start);
      groanTone.frequency.exponentialRampToValueAtTime(from * randomBetween(0.7, 1.45), start + seconds);
      swell(groanGain.gain, start, (0.5 + 0.5 * intensity) * randomBetween(0.6, 1), seconds * 0.3, seconds * 0.4, seconds * 0.6);
      groans++;
      return start + seconds;
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.6;
        glide(ticks.level.gain, 0.6 * value, time, timeConstant);
        glide(ticks.crackle.drive.gain, 1.2 + 0.7 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        const strength = option(options, 'strength', 1, 0, 1.5);
        if (name === 'crack') {
          cracks++;
          strike(reportGain.gain, time, 3 * strength, 0.003, 0.5);
          strike(boomGain.gain, time + 0.02, 2.2 * strength, 0.02, 2.4);
          sweep(boom.filter.frequency, time, 180, 70, 1.6);
          swell(rumbleGain.gain, time + 0.3, 1.1 * strength, 0.8, 2.2, 4);
          return true;
        }
        if (name === 'splash') {
          splashes++;
          strike(boomGain.gain, time, 2.6 * strength, 0.05, 2.8);
          sweep(boom.filter.frequency, time, 320, 55, 2);
          swell(washGain.gain, time + 0.15, 1.6 * strength, 0.5, 1.4, 4.5);
          sweep(wash.filter.frequency, time + 0.15, 1800, 500, 3);
          return true;
        }
        return false;
      },
      update(time, interval) {
        if (nextAt < 0) nextAt = time + randomBetween(0.5, 2.5);
        const horizon = time + Math.max(0.4, interval * 3);
        if (nextAt > horizon) return;
        const start = Math.max(nextAt, time + 0.02);
        const end = intensity > 0.05 ? scheduleGroan(start) : start;
        nextAt = end + randomBetween(1.5, 6) * (1.6 - intensity);
      },
      describe() {
        return { intensity, groans, cracks, splashes, nextAt };
      },
    };
  },
});
