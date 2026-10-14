// Marsh: a wetland's sound bed, for the mangrove delta and the rice terraces. Water lapping at roots
// and banks (a low, wet band that surges in slow uneven waves), frogs croaking in bouts (a nasal tone
// pulsed a dozen times a second), the shimmer of insects (a high band trembling quickly) and, with
// params.trickle, water running from one paddy to the next (a bright, bubbling crackle).
//
// params (each 0..1): lap (default 0.7), frogs (0.6), insects (0.5), trickle (0). setIntensity(0..1)
// is how alive the marsh is (the frogs call more often and the insects louder). The croaks are
// scheduled a little ahead from update() on nodes that already exist, so nothing is allocated while
// they play.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, strike, wobble } from './recipeKit.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** Frog voices: the croak's tone (Hz), its nasal formant (Hz) and the pulse rate (Hz). */
const FROGS = Object.freeze([
  Object.freeze({ tone: 190, formant: 760, pulse: 13 }),
  Object.freeze({ tone: 240, formant: 980, pulse: 17 }),
  Object.freeze({ tone: 150, formant: 620, pulse: 11 }),
]);

export default Object.freeze({
  name: 'marsh',
  summary: 'lapping water, frogs and insects',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 110, rolloffFactor: 1.3, panningModel: 'equalpower', size: 320, reverb: 0.25 }),
  level: 0.05,
  floor: 0.3,
  triggers: Object.freeze([]),

  build(kit, params) {
    const { scaffold, out } = kit;
    const lapAmount = option(params, 'lap', 0.7, 0, 1);
    const frogAmount = option(params, 'frogs', 0.6, 0, 1);
    const insectAmount = option(params, 'insects', 0.5, 0, 1);
    const trickleAmount = option(params, 'trickle', 0, 0, 1);
    let intensity = 0;
    let croaks = 0;
    let nextCroak = -1;
    let frogIndex = 0;

    // Lapping: a wet low band whose level rides slow, uneven waves.
    const waves = scaffold.gain(0.6);
    waves.connect(out);
    const waveNoise = scaffold.noise(kit.noise, 0.05);
    const waveFilter = scaffold.filter('lowpass', 0.9, 0.8);
    const waveDepth = scaffold.gain(1.8);
    waveNoise.connect(waveFilter);
    waveFilter.connect(waveDepth);
    waveDepth.connect(waves.gain);
    const lap = noiseBand(kit, { rate: 0.7, type: 'bandpass', frequency: 520, q: 1.1, destination: waves });
    // Insects: a high band trembling quickly.
    const tremble = scaffold.modulated(0.5, 0.45, 23);
    tremble.carrier.connect(out);
    const insects = noiseBand(kit, { rate: 1.2, type: 'bandpass', frequency: 5200, q: 5, destination: tremble.carrier });
    wobble(kit, insects.filter.frequency, 260, 0.13);
    // Running water between paddies.
    const trickle = crackleBand(kit, { rate: 1, type: 'bandpass', frequency: 2200, q: 1.2, crackleRate: 0.3, cutoff: 80, drive: 2.4 });
    // Frogs: a tone through a nasal formant, gated pulse by pulse.
    const frogVoices = FROGS.map((frog) => {
      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const formant = kit.pitched(scaffold.filter('bandpass', frog.formant, 3));
      formant.connect(envelope);
      const tone = kit.pitched(scaffold.oscillator('square', frog.tone));
      tone.connect(formant);
      return { ...frog, envelope };
    });

    function croak(time) {
      const voice = frogVoices[frogIndex % frogVoices.length];
      frogIndex += 1 + Math.floor(Math.random() * 2);
      const pulses = 4 + Math.floor(Math.random() * 6);
      const period = 1 / (voice.pulse * randomBetween(0.9, 1.1));
      const peak = 0.5 * frogAmount * randomBetween(0.5, 1);
      for (let pulse = 0; pulse < pulses; pulse++) strike(voice.envelope.gain, time + pulse * period, peak, 0.006, period * 0.8);
      croaks++;
      return time + pulses * period;
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.8;
        glide(lap.gain.gain, 0.45 * lapAmount * (0.5 + 0.5 * value), time, timeConstant);
        glide(insects.gain.gain, 0.05 * insectAmount * (0.3 + 0.7 * value), time, timeConstant);
        glide(trickle.level.gain, 0.9 * trickleAmount * (0.6 + 0.4 * value), time, timeConstant);
      },
      trigger() {
        return false;
      },
      update(time, interval) {
        if (frogAmount <= 0) return;
        if (nextCroak < 0) nextCroak = time + randomBetween(0.5, 3);
        const horizon = time + Math.max(0.4, interval * 3);
        while (nextCroak <= horizon) {
          const end = croak(Math.max(nextCroak, time + 0.02));
          // Croaks answer each other in quick runs, then the marsh goes quiet for a while.
          nextCroak = Math.random() < 0.55 ? end + randomBetween(0.15, 0.6) : end + randomBetween(2.5, 9) / (0.4 + 0.6 * intensity);
        }
      },
      describe() {
        return { intensity, croaks };
      },
    };
  },
});
