// Meteors: a faint sizzle, like the "electrophonic" hiss observers report hearing with a bright
// meteor. Between streaks the shower keeps a barely audible crackle.
//
// setIntensity(0..1) is the shower's activity (the background crackle). trigger('streak',
// { duration, strength }) is one meteor: a thin, crackling sizzle whose band slides down as it
// burns out (duration default 1.2 s). trigger('fireball', { strength }) is a bright bolide: a
// louder, longer sizzle with popping fragments and a soft low whoomp. Two streak slots alternate.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, swell, sweep } from './recipeKit.js';

const STREAK_SLOTS = 2;

export default Object.freeze({
  name: 'meteor',
  summary: 'faint sizzle',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 1500, rolloffFactor: 0.7, panningModel: 'equalpower', size: 0, reverb: 0.4 }),
  level: 0.02,
  floor: 0.5,
  triggers: Object.freeze(['streak', 'fireball']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let streaks = 0;

    const background = crackleBand(kit, { rate: 1.2, type: 'highpass', frequency: 5200, q: 0.5, crackleRate: 0.1, cutoff: 25, drive: 1.3 });

    const slots = [];
    for (let index = 0; index < STREAK_SLOTS; index++) {
      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const sizzle = crackleBand(kit, { rate: 1, type: 'bandpass', frequency: 5000, q: 1.4, level: 1, crackleRate: 0.35, cutoff: 90, drive: 2.8, destination: envelope });
      const hiss = noiseBand(kit, { rate: 1.05, type: 'bandpass', frequency: 5000, q: 1.2, level: 0.35, destination: envelope });
      slots.push({ envelope, sizzle, hiss });
    }
    const pops = crackleBand(kit, { rate: 0.9, type: 'bandpass', frequency: 900, q: 0.8, crackleRate: 0.2, cutoff: 30, drive: 2.2 });
    const whoomp = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 140, q: 0.8 });

    function streak(time, duration, strength, bright) {
      const slot = slots[streaks % STREAK_SLOTS];
      streaks++;
      swell(slot.envelope.gain, time, 0.5 * strength, 0.12, duration, 0.6);
      sweep(slot.sizzle.band.filter.frequency, time, bright ? 7800 : 6800, bright ? 2200 : 3200, duration + 0.4);
      sweep(slot.hiss.filter.frequency, time, bright ? 7000 : 6200, bright ? 2000 : 3000, duration + 0.4);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        glide(background.level.gain, 0.5 * value, time, immediate ? 0.01 : 0.8);
      },
      trigger(name, options, time) {
        const strength = option(options, 'strength', 1, 0, 1.5);
        if (name === 'streak') {
          streak(time, option(options, 'duration', 1.2, 0.2, 6), strength, false);
          return true;
        }
        if (name === 'fireball') {
          streak(time, option(options, 'duration', 3, 0.5, 8), 1.8 * strength, true);
          swell(pops.level.gain, time + 0.3, 2.2 * strength, 0.2, 1.6, 1.2);
          strike(whoomp.gain.gain, time + 0.1, 0.5 * strength, 0.25, 2.4);
          return true;
        }
        return false;
      },
      describe() {
        return { intensity, streaks };
      },
    };
  },
});
