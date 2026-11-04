// Frozen lake: the singing ice. A sheet of lake ice under strain twangs and chirps: a crack running
// through it rings like a struck wire, and because ice carries high frequencies faster than low ones
// the sound arrives as a falling "pew" whistle, high to low in a fraction of a second, with a
// rumbling boom under it. Between the cracks a thin wind hisses over the ice.
//
// setIntensity(0..1) is the presence (the approach): the wind hiss and how often the ice sings on its
// own (a chirp every 3-9 s at full presence, scheduled from update()). trigger('crack', { strength })
// is one crack: a boom, a falling chirp and its two echoes from the far shore. Three chirp slots are
// reused round-robin, so chirps may overlap.
import { glide } from '../synthKit.js';
import { noiseBand, option, strike, sweep, wobble } from './recipeKit.js';

const CHIRP_SLOTS = 3;
const ECHO_DELAYS = Object.freeze([0.31, 0.74]);
const ECHO_LEVELS = Object.freeze([0.45, 0.2]);
const CHIRP_LEVEL = 0.22;
const BOOM_LEVEL = 0.5;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'iceSing',
  summary: 'singing lake ice: falling chirps, booms and a thin wind',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 160, rolloffFactor: 1.1, panningModel: 'HRTF', size: 300, reverb: 0.9 }),
  level: 0.04,
  floor: 0.2,
  triggers: Object.freeze(['crack']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let cracks = 0;
    let nextSong = -1;

    // The wind over the ice: a thin, high, slowly wandering hiss.
    const wind = noiseBand(kit, { rate: 1.1, type: 'bandpass', frequency: 3200, q: 1.6 });
    wobble(kit, wind.filter.frequency, 900, 0.07);

    // Chirp slots: a sine whose pitch falls steeply, through a resonant band that follows it.
    const slots = [];
    for (let index = 0; index < CHIRP_SLOTS; index++) {
      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const tone = kit.pitched(scaffold.oscillator('sine', 2400));
      const overtone = kit.pitched(scaffold.oscillator('triangle', 4800));
      const overtoneLevel = scaffold.gain(0.18);
      tone.connect(envelope);
      overtone.connect(overtoneLevel);
      overtoneLevel.connect(envelope);
      slots.push({ envelope, tone, overtone });
    }
    // The boom: low noise and a short sub thump.
    const boomGain = scaffold.gain(0);
    boomGain.connect(out);
    const boom = noiseBand(kit, { rate: 0.35, type: 'lowpass', frequency: 120, q: 0.9, level: 1, destination: boomGain });
    const thump = kit.pitched(scaffold.oscillator('sine', 48));
    const thumpGain = scaffold.gain(0);
    thump.connect(thumpGain);
    thumpGain.connect(out);

    /** One falling chirp in the next slot at time, strength 0..1.5, seconds long. */
    function chirp(time, strength, seconds) {
      const slot = slots[cracks % CHIRP_SLOTS];
      cracks++;
      const top = randomBetween(2600, 4200);
      const bottom = randomBetween(260, 520);
      strike(slot.envelope.gain, time, CHIRP_LEVEL * strength, 0.004, seconds);
      sweep(slot.tone.frequency, time, top, bottom, seconds * 0.8);
      sweep(slot.overtone.frequency, time, top * 2, bottom * 2, seconds * 0.8);
    }

    /** A crack: the boom, the chirp and its echoes off the far shore. */
    function crack(time, strength) {
      strike(boomGain.gain, time, BOOM_LEVEL * strength, 0.01, 2.6);
      sweep(boom.filter.frequency, time, 420, 70, 1.4);
      strike(thumpGain.gain, time, 0.28 * strength, 0.006, 0.9);
      sweep(thump.frequency, time, 70, 32, 0.8);
      const seconds = randomBetween(0.45, 0.9);
      chirp(time + 0.02, strength, seconds);
      for (let echo = 0; echo < ECHO_DELAYS.length; echo++) chirp(time + ECHO_DELAYS[echo], strength * ECHO_LEVELS[echo], seconds * 1.1);
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        glide(wind.gain.gain, 0.05 * (0.25 + 0.75 * value), time, immediate ? 0.01 : 1.2);
      },
      trigger(name, options, time) {
        if (name !== 'crack') return false;
        crack(time, option(options, 'strength', 1, 0, 1.5));
        return true;
      },
      update(time) {
        // The ice sings on its own while the lake is near: a lone chirp now and then, a crack rarely.
        if (intensity < 0.05) {
          nextSong = -1;
          return;
        }
        if (nextSong < 0) nextSong = time + randomBetween(3, 9) / intensity;
        if (time < nextSong) return;
        if (Math.random() < 0.25) crack(time, 0.5 + 0.5 * intensity);
        else chirp(time, 0.4 + 0.6 * intensity, randomBetween(0.35, 0.8));
        nextSong = time + randomBetween(3, 9) / intensity;
      },
      describe() {
        return { intensity, cracks };
      },
    };
  },
});
