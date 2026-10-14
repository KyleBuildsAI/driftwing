// Meadow hum: bees working a flowering field (the lavender and tulip stripes). A drone of several
// detuned wingbeats (sawtooth tones near 200 Hz through a buzzy body band), each fluttering on its
// own slow random envelope as bees come and go, a soft breeze through the stems, and now and then one
// bee passing close: its buzz swells while its pitch slides down as it flies by.
//
// setIntensity(0..1) is the field's activity (the emitter that owns the voice follows the breeze):
// how many bees you hear and how close. The fly-bys are scheduled a little ahead from update() on
// nodes that already exist.
import { glide, holdAt } from '../synthKit.js';
import { noiseBand, swell } from './recipeKit.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** The drone's wingbeats (Hz) and their shares of the level. */
const WINGBEATS = Object.freeze([
  Object.freeze({ frequency: 196, level: 1 }),
  Object.freeze({ frequency: 214, level: 0.8 }),
  Object.freeze({ frequency: 231, level: 0.7 }),
  Object.freeze({ frequency: 182, level: 0.6 }),
  Object.freeze({ frequency: 247, level: 0.5 }),
]);

export default Object.freeze({
  name: 'meadowHum',
  summary: 'bees in a flowering field',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 90, rolloffFactor: 1.4, panningModel: 'equalpower', size: 260, reverb: 0.15 }),
  level: 0.04,
  floor: 0.25,
  triggers: Object.freeze([]),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let flybys = 0;
    let nextFlyby = -1;

    const drone = scaffold.gain(0);
    drone.connect(out);
    const body = kit.pitched(scaffold.filter('bandpass', 420, 1.8));
    body.connect(drone);
    const wingbeats = WINGBEATS.map((wingbeat) => {
      // Each bee's flutter: slow noise into its gain, so the drone thickens and thins on its own.
      const flutter = scaffold.gain(0.5 * wingbeat.level);
      flutter.connect(body);
      const flutterNoise = scaffold.noise(kit.noise, randomBetween(0.05, 0.09));
      const flutterFilter = scaffold.filter('lowpass', randomBetween(1.5, 3), 0.7);
      const flutterDepth = scaffold.gain(1.2 * wingbeat.level);
      flutterNoise.connect(flutterFilter);
      flutterFilter.connect(flutterDepth);
      flutterDepth.connect(flutter.gain);
      const tone = kit.pitched(scaffold.oscillator('sawtooth', wingbeat.frequency));
      tone.connect(flutter);
      return tone;
    });
    const breeze = noiseBand(kit, { rate: 0.9, type: 'highpass', frequency: 1800, q: 0.5 });
    // The close bee: a brighter buzz with its own envelope and pitch slide.
    const closeGain = scaffold.gain(0);
    closeGain.connect(out);
    const closeBody = kit.pitched(scaffold.filter('bandpass', 520, 2.2));
    closeBody.connect(closeGain);
    const closeTone = kit.pitched(scaffold.oscillator('sawtooth', 240));
    closeTone.connect(closeBody);

    function flyby(time) {
      const seconds = randomBetween(1.2, 2.4);
      const from = randomBetween(250, 290);
      holdAt(closeTone.frequency, time);
      closeTone.frequency.setValueAtTime(from, time);
      closeTone.frequency.setValueAtTime(from, time + seconds * 0.45);
      closeTone.frequency.exponentialRampToValueAtTime(from * 0.86, time + seconds * 0.6);
      swell(closeGain.gain, time, 0.6 * (0.4 + 0.6 * intensity), seconds * 0.45, seconds * 0.1, seconds * 0.6);
      flybys++;
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.8;
        glide(drone.gain, 0.35 * (0.2 + 0.8 * value), time, timeConstant);
        glide(breeze.gain.gain, 0.05 * (0.4 + 0.6 * value), time, timeConstant);
        for (let index = 0; index < wingbeats.length; index++) {
          glide(wingbeats[index].frequency, WINGBEATS[index].frequency * (0.97 + 0.06 * value), time, timeConstant);
        }
      },
      trigger() {
        return false;
      },
      update(time, interval) {
        if (nextFlyby < 0) nextFlyby = time + randomBetween(2, 6);
        if (nextFlyby > time + Math.max(0.4, interval * 3)) return;
        if (intensity > 0.05) flyby(Math.max(nextFlyby, time + 0.02));
        nextFlyby += randomBetween(4, 12) / (0.4 + 0.6 * intensity);
      },
      describe() {
        return { intensity, flybys };
      },
    };
  },
});
