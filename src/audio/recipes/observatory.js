// Observatory (preset 55): the quiet electric hum of a telescope building on a mountaintop, the
// rumbling whir of the dome's drive motors and the clunk of the shutter's latch.
//
// The hum is a mains tone and its harmonic, faint and steady. The drive is band-passed noise over a
// low, wavering motor tone; setIntensity(0..1) is the motors' work (the structure engine's recipe
// mode: about 0.1 idle, more while the dome turns or the shutter moves), raising the whir and its
// pitch. trigger('clunk', { strength }) is the latch: a dull thump with a short metallic ring.
import { glide } from '../synthKit.js';
import { noiseBand, option, strike, wobble } from './recipeKit.js';

export default Object.freeze({
  name: 'observatory',
  summary: 'electric hum, dome motors and the shutter latch',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 45, rolloffFactor: 1.5, panningModel: 'HRTF', size: 20, reverb: 0.5 }),
  level: 0.03,
  floor: 0.4,
  triggers: Object.freeze(['clunk']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let clunks = 0;

    const humLevel = scaffold.gain(0.012);
    humLevel.connect(out);
    const mains = kit.pitched(scaffold.oscillator('sine', 100));
    const harmonic = kit.pitched(scaffold.oscillator('sine', 200));
    const harmonicLevel = scaffold.gain(0.4);
    mains.connect(humLevel);
    harmonic.connect(harmonicLevel);
    harmonicLevel.connect(humLevel);

    const driveLevel = scaffold.gain(0);
    driveLevel.connect(out);
    const motor = kit.pitched(scaffold.oscillator('sawtooth', 46));
    const motorFilter = kit.pitched(scaffold.filter('lowpass', 260, 1.2));
    motor.connect(motorFilter);
    motorFilter.connect(driveLevel);
    wobble(kit, motor.frequency, 1.8, 0.7);
    const whir = noiseBand(kit, { rate: 0.9, type: 'bandpass', frequency: 520, q: 1.4 });

    const thump = noiseBand(kit, { rate: 0.6, type: 'lowpass', frequency: 160, q: 0.9 });
    const ring = kit.pitched(scaffold.oscillator('triangle', 740));
    const ringLevel = scaffold.gain(0);
    ring.connect(ringLevel);
    ringLevel.connect(out);

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.5;
        const work = Math.max(0, value - 0.1);
        glide(driveLevel.gain, 0.5 * work, time, timeConstant);
        glide(whir.gain.gain, 0.3 * work, time, timeConstant);
        glide(motor.frequency, 40 + 30 * work, time, timeConstant);
        glide(whir.filter.frequency, 420 + 600 * work, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'clunk') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        clunks++;
        strike(thump.gain.gain, time, 0.9 * strength, 0.005, 0.35);
        strike(ringLevel.gain, time + 0.01, 0.05 * strength, 0.002, 0.6);
        return true;
      },
      describe() {
        return { intensity, clunks };
      },
    };
  },
});
