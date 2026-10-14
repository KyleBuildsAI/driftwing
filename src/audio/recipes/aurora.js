// Aurora night: an airy, glassy shimmer for the legendary aurora nights. Northern-lights folklore
// tells of a faint hiss and crackle under a strong display; this is the sound of the music the eye
// hears: a breathing "ah" of filtered air (two formant bands drifting against each other), a high
// cluster of slowly beating sines (a suspended chord around A5) that swells with the curtains, and
// now and then a soft rustle, like silk.
//
// setIntensity(0..1) is the display's strength (the celestial part's presence). The chord's voices
// drift apart and back on slow LFOs, so it never settles; update() schedules a rustle every 6-14 s.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, swell, wobble } from './recipeKit.js';

const CHORD = Object.freeze([880, 987.77, 1318.51, 1760, 2217.46]);
const CHORD_LEVELS = Object.freeze([0.2, 0.12, 0.15, 0.08, 0.04]);
const BEAT_HZ = Object.freeze([0.21, 0.17, 0.13, 0.11, 0.07]);
const PAD_LEVEL = 0.18;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'aurora',
  summary: 'airy, glassy shimmer with a silky rustle',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 1500, rolloffFactor: 0.6, panningModel: 'equalpower', size: 0, reverb: 1 }),
  level: 0.03,
  floor: 0,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let rustles = 0;
    let nextRustle = -1;

    const breath = scaffold.modulated(0.7, 0.3, 0.05);
    breath.carrier.connect(out);
    // The "ah": two formant bands of air, drifting against each other.
    const lowFormant = noiseBand(kit, { rate: 0.8, type: 'bandpass', frequency: 760, q: 5, destination: breath.carrier });
    const highFormant = noiseBand(kit, { rate: 0.85, type: 'bandpass', frequency: 1180, q: 6, destination: breath.carrier });
    wobble(kit, lowFormant.filter.frequency, 90, 0.031);
    wobble(kit, highFormant.filter.frequency, 140, 0.023);

    // The chord: each voice beating against a twin a fraction of a hertz away.
    const chordLevel = scaffold.gain(0);
    chordLevel.connect(breath.carrier);
    for (let index = 0; index < CHORD.length; index++) {
      const voiceGain = scaffold.gain(CHORD_LEVELS[index]);
      voiceGain.connect(chordLevel);
      const main = kit.pitched(scaffold.oscillator('sine', CHORD[index]));
      const twin = kit.pitched(scaffold.oscillator('sine', CHORD[index] + BEAT_HZ[index] * 4));
      main.connect(voiceGain);
      twin.connect(voiceGain);
      wobble(kit, main.frequency, CHORD[index] * 0.004, BEAT_HZ[index]);
    }

    // The rustle: a soft, sparse crackle of high air.
    const rustle = crackleBand(kit, { rate: 1.2, type: 'highpass', frequency: 3800, q: 0.6, crackleRate: 0.22, cutoff: 60, drive: 2.4 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 2.5;
        glide(lowFormant.gain.gain, 0.5 * value, time, timeConstant);
        glide(highFormant.gain.gain, 0.32 * value, time, timeConstant);
        glide(chordLevel.gain, PAD_LEVEL * value * value, time, timeConstant);
      },
      trigger() {
        return false;
      },
      update(time) {
        if (intensity < 0.1) {
          nextRustle = -1;
          return;
        }
        if (nextRustle < 0) nextRustle = time + randomBetween(6, 14);
        if (time < nextRustle) return;
        swell(rustle.level.gain, time, 0.6 * intensity, 1.2, randomBetween(1.5, 3), 2.5);
        rustles++;
        nextRustle = time + randomBetween(6, 14);
      },
      describe() {
        return { intensity, rustles };
      },
    };
  },
});
