// Herd rumble: hooves drumming on the plain. A low rumble pulsing at the gallop's beat, the clatter of
// hooves and stones over it, and the deep bellow of a bull now and then.
//
// setIntensity(0..1) is the herd's gait (the fauna engine sends 0.3 at a walk and 1 in a stampede):
// the rumble swells and its beat quickens from a plod to a gallop, the clatter thickens.
// trigger('bellow', { strength }) is one bull's low, rough call. The bellow is shaped on nodes that
// already exist, so the herd allocates nothing while it runs.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, swell, sweep } from './recipeKit.js';

export default Object.freeze({
  name: 'herd',
  summary: 'drumming hooves and a bellow: a herd on the move',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 180, rolloffFactor: 1.2, panningModel: 'equalpower', size: 200, reverb: 0.25 }),
  level: 0.09,
  floor: 0.1,
  triggers: Object.freeze(['bellow']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let bellows = 0;

    // The rumble: low noise whose level beats with the gallop.
    const beat = scaffold.modulated(0.55, 0.45, 1.3);
    beat.carrier.connect(out);
    const rumble = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 95, q: 0.9, destination: beat.carrier });
    // Hoof clatter and kicked stones: a dense crackle in the low mids.
    const clatter = crackleBand(kit, { rate: 0.9, type: 'bandpass', frequency: 720, q: 1.1, crackleRate: 0.35, cutoff: 70, drive: 1.6 });
    // The bellow: a rough low sawtooth through a vowel-like resonance.
    const bellowGain = scaffold.gain(0);
    bellowGain.connect(out);
    const voice = kit.pitched(scaffold.oscillator('sawtooth', 92));
    const formant = kit.pitched(scaffold.filter('bandpass', 420, 3));
    voice.connect(formant);
    formant.connect(bellowGain);

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.7;
        glide(rumble.gain.gain, 1.3 * Math.pow(value, 0.8), time, timeConstant);
        glide(beat.lfo.frequency, 1.1 + 2.6 * value, time, timeConstant);
        glide(clatter.level.gain, 1.1 * value, time, timeConstant);
        glide(clatter.crackle.drive.gain, 1.3 + 1.4 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'bellow') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        bellows++;
        sweep(voice.frequency, time, 118, 74, 1.5);
        sweep(formant.frequency, time, 520, 330, 1.5);
        swell(bellowGain.gain, time, 0.9 * strength, 0.25, 0.8, 0.9);
        return true;
      },
      describe() {
        return { intensity, bellows };
      },
    };
  },
});
