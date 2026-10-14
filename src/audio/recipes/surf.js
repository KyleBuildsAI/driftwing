// Surf: waves breaking on a reef or a rocky shore, a tidal bore churning up an estuary, the crest of a
// rogue wave. Each breaker is a swell of bright, hissing noise that crashes (the band sweeping up as
// the lip throws over) and drains away as a fizzing backwash; breakers roll in every few seconds, out
// of step, over a faint constant wash.
//
// setIntensity(0..1) is the size of the surf: louder breakers, rolling in more often, with more of the
// low thump of the water landing. trigger('crash', { strength }) throws one big breaker now (a rogue
// wave's crest passing, a bore's front breaking). Breakers are scheduled a little ahead on nodes that
// already exist, so the surf allocates nothing while it rolls.
import { glide } from '../synthKit.js';
import { noiseBand, option, strike, swell, sweep } from './recipeKit.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'surf',
  summary: 'breakers rolling onto a reef: crash and fizzing backwash',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 120, rolloffFactor: 1.5, panningModel: 'equalpower', size: 140, reverb: 0.3 }),
  level: 0.08,
  floor: 0.15,
  triggers: Object.freeze(['crash']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let breakers = 0;
    let crashes = 0;
    let nextAt = -1;

    // The constant wash: a soft mid band.
    const wash = noiseBand(kit, { rate: 0.9, type: 'bandpass', frequency: 1300, q: 0.45 });
    // A breaker: a bright band whose level and centre swell and fall, a low thump as it lands and a
    // high fizz of the backwash after it.
    const breakerGain = scaffold.gain(0);
    breakerGain.connect(out);
    const breaker = noiseBand(kit, { rate: 1.05, type: 'bandpass', frequency: 900, q: 0.6, level: 1, destination: breakerGain });
    const thumpGain = scaffold.gain(0);
    thumpGain.connect(out);
    noiseBand(kit, { rate: 0.55, type: 'lowpass', frequency: 150, q: 0.8, level: 1, destination: thumpGain });
    const fizzGain = scaffold.gain(0);
    fizzGain.connect(out);
    noiseBand(kit, { rate: 1.2, type: 'highpass', frequency: 5200, q: 0.5, level: 1, destination: fizzGain });

    /** One breaker from start: strength scales it (1 a full set wave). */
    function rollBreaker(start, strength) {
      swell(breakerGain.gain, start, 0.9 * strength, 0.7, 0.35, 2.4);
      sweep(breaker.filter.frequency, start, 650, 2100, 0.8);
      strike(thumpGain.gain, start + 0.6, 1.1 * strength * (0.4 + 0.6 * intensity), 0.06, 1.4);
      swell(fizzGain.gain, start + 1.1, 0.32 * strength, 0.5, 0.4, 2.8);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        glide(wash.gain.gain, 0.05 + 0.09 * value, time, immediate ? 0.01 : 0.8);
      },
      trigger(name, options, time) {
        if (name !== 'crash') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        crashes++;
        swell(breakerGain.gain, time, 2.6 * strength, 0.3, 0.9, 3.4);
        sweep(breaker.filter.frequency, time, 420, 2600, 0.6);
        strike(thumpGain.gain, time + 0.35, 2.4 * strength, 0.05, 2.2);
        swell(fizzGain.gain, time + 1.2, 0.7 * strength, 0.5, 0.8, 3.5);
        nextAt = Math.max(nextAt, time + 4);
        return true;
      },
      update(time, interval) {
        if (nextAt < 0) nextAt = time + randomBetween(0.2, 1.5);
        const horizon = time + Math.max(0.4, interval * 3);
        if (nextAt > horizon) return;
        const start = Math.max(nextAt, time + 0.02);
        if (intensity > 0.03) {
          rollBreaker(start, (0.35 + 0.65 * intensity) * randomBetween(0.7, 1));
          breakers++;
        }
        nextAt = start + randomBetween(3.2, 6.5) * (1.45 - 0.6 * intensity);
      },
      describe() {
        return { intensity, breakers, crashes, nextAt };
      },
    };
  },
});
