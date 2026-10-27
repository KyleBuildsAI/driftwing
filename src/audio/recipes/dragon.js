// The wild dragon of the dragon racer: heavy wingbeats, a slow rumbling breath, and a roar.
//
// The wingbeats are low thumps of filtered noise gated by a slow raised sine (about 1.3 beats a
// second), the band opening as each beat swells; a rumbling breath (a low growl band wavering in pitch)
// sits under them. setIntensity(0..1) is the approach: the beats and the breath grow as the player
// closes in (the voice follows the dragon as it flies).
// trigger('roar', { strength }) is the launch roar: a growling sawtooth chord sweeping down through a
// resonant band, with a rush of breath and the crackle of fire.
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, option, swell, sweep, wobble } from './recipeKit.js';

const BEAT_LEVEL = 0.7;
const BREATH_LEVEL = 0.16;
const BEAT_RATE = 1.3;

export default Object.freeze({
  name: 'dragon',
  summary: 'heavy wingbeats and a rumbling breath; a roar with a rush of fire',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 120, rolloffFactor: 1.4, panningModel: 'HRTF', size: 30, reverb: 0.55 }),
  level: 0.06,
  floor: 0.1,
  triggers: Object.freeze(['roar']),

  build(kit, params) {
    const { scaffold, out } = kit;
    const growlHz = option(params, 'growlHz', 62, 30, 200);
    let intensity = 0;
    let roars = 0;

    // Wingbeats: a band of low noise whose gate swings from shut to open on each beat (0.5 + 0.5 sin),
    // its filter opening with it, so each beat is a dull swelling thump.
    const beatLevel = scaffold.gain(0);
    beatLevel.connect(out);
    const beatGate = scaffold.gain(0);
    beatGate.connect(beatLevel);
    const thump = noiseBand(kit, { rate: 0.5, type: 'lowpass', frequency: 180, q: 1.4, level: 1, destination: beatGate });
    wobble(kit, beatGate.gain, 0.5, BEAT_RATE);
    const beatOffset = scaffold.add(new ConstantSourceNode(kit.context, { offset: 0.5 }));
    beatOffset.connect(beatGate.gain);
    wobble(kit, thump.filter.frequency, 60, BEAT_RATE);

    const breath = noiseBand(kit, { rate: 0.4, type: 'bandpass', frequency: 140, q: 3 });
    wobble(kit, breath.filter.frequency, 30, 0.21);

    // The roar: a growling chord (two detuned sawtooths and a sub) through a resonant band.
    const roarBand = kit.pitched(scaffold.filter('bandpass', 600, 2.2));
    const roarLevel = scaffold.gain(0);
    roarBand.connect(roarLevel);
    roarLevel.connect(out);
    for (const [ratio, detune] of [[1, -9], [1, 8], [1.5, 0], [0.5, 0]]) {
      const voice = kit.pitched(scaffold.oscillator('sawtooth', growlHz * ratio));
      voice.detune.value = detune;
      voice.connect(roarBand);
    }
    wobble(kit, roarBand.frequency, 120, 7.5);
    const fireRush = noiseBand(kit, { rate: 1, type: 'highpass', frequency: 900, q: 0.6 });
    const fireCrackle = crackleBand(kit, { rate: 1.2, type: 'bandpass', frequency: 2400, q: 1.2, crackleRate: 0.4, cutoff: 40, drive: 2.6 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.5;
        glide(beatLevel.gain, BEAT_LEVEL * value, time, timeConstant);
        glide(breath.gain.gain, BREATH_LEVEL * (0.3 + 0.7 * value), time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'roar') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        roars++;
        swell(roarLevel.gain, time, 0.5 * strength, 0.12, 1.1, 0.9);
        sweep(roarBand.frequency, time, 900, 260, 1.8);
        swell(fireRush.gain.gain, time + 0.3, 0.45 * strength, 0.2, 1.2, 0.8);
        swell(fireCrackle.level.gain, time + 0.3, 0.8 * strength, 0.2, 1.2, 0.8);
        return true;
      },
      describe() {
        return { intensity, roars };
      },
    };
  },
});
