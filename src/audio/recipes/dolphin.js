// Dolphins: signature whistles (pure tones sliding up and down through a few kHz) and buzzing click
// trains, the chatter of a pod at play, with the splash of a leap under them.
//
// setIntensity(0..1) is how chatty the pod is: 0 falls silent, 1 whistles every second or two. A
// whistle glides through one of a few contours; a click train is a fast pulse whose rate rises
// (a dolphin closing in on something). trigger('call') whistles and clicks now. Calls are scheduled a
// little ahead on nodes that already exist, so the pod allocates nothing while it chatters.
import { glide } from '../synthKit.js';
import { noiseBand, swell } from './recipeKit.js';

// Whistle contours: frequencies (Hz) at 0, 40 % and 100 % of the whistle, and its length (s).
const CONTOURS = Object.freeze([
  Object.freeze({ start: 6200, middle: 11800, end: 8400, seconds: 0.7 }),
  Object.freeze({ start: 9800, middle: 7200, end: 12600, seconds: 0.9 }),
  Object.freeze({ start: 5600, middle: 6100, end: 13500, seconds: 0.5 }),
  Object.freeze({ start: 12000, middle: 8800, end: 6600, seconds: 1.1 }),
  Object.freeze({ start: 7400, middle: 12400, end: 7600, seconds: 0.6 }),
]);

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default Object.freeze({
  name: 'dolphin',
  summary: 'dolphin whistles and click trains',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 90, rolloffFactor: 1.7, panningModel: 'HRTF', size: 40, reverb: 0.3 }),
  level: 0.06,
  floor: 0.3,
  triggers: Object.freeze(['call']),

  build(kit) {
    const { scaffold, out } = kit;
    let intensity = 0;
    let whistles = 0;
    let clickTrains = 0;
    let nextAt = -1;
    let lastEnd = 0;

    const whistleGain = scaffold.gain(0);
    whistleGain.connect(out);
    const whistle = kit.pitched(scaffold.oscillator('sine', 8000));
    whistle.connect(whistleGain);
    // Clicks: a square pulse train high-passed to its sharp edges, under an envelope.
    const clickGain = scaffold.gain(0);
    clickGain.connect(out);
    const clicks = scaffold.oscillator('square', 60);
    const clickFilter = kit.pitched(scaffold.filter('highpass', 4800, 0.8));
    clicks.connect(clickFilter);
    clickFilter.connect(clickGain);
    // The water around the pod: a faint hiss with the splash of a leap now and then.
    const water = noiseBand(kit, { rate: 1.1, type: 'highpass', frequency: 2400, q: 0.5 });

    function scheduleCall(start, loudness) {
      const contour = CONTOURS[Math.floor(Math.random() * CONTOURS.length)];
      const seconds = contour.seconds * randomBetween(0.8, 1.25);
      whistle.frequency.cancelScheduledValues(start);
      whistle.frequency.setValueAtTime(contour.start, start);
      whistle.frequency.exponentialRampToValueAtTime(contour.middle, start + seconds * 0.4);
      whistle.frequency.exponentialRampToValueAtTime(contour.end, start + seconds);
      swell(whistleGain.gain, start, 0.55 * loudness, 0.05, seconds - 0.1, 0.12);
      whistles++;
      let end = start + seconds;
      if (Math.random() < 0.6) {
        // A click train after the whistle, its rate rising.
        const clickStart = end + randomBetween(0.05, 0.3);
        const clickSeconds = randomBetween(0.5, 1.4);
        clicks.frequency.cancelScheduledValues(clickStart);
        clicks.frequency.setValueAtTime(randomBetween(25, 60), clickStart);
        clicks.frequency.exponentialRampToValueAtTime(randomBetween(180, 420), clickStart + clickSeconds);
        swell(clickGain.gain, clickStart, 0.4 * loudness, 0.04, clickSeconds - 0.08, 0.1);
        clickTrains++;
        end = clickStart + clickSeconds;
      }
      lastEnd = end;
      return end;
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        glide(water.gain.gain, 0.02 * value, time, immediate ? 0.01 : 0.5);
      },
      trigger(name, options, time) {
        if (name !== 'call') return false;
        const end = scheduleCall(Math.max(time + 0.02, lastEnd + 0.05), 1.6);
        nextAt = end + randomBetween(0.4, 1.2);
        return true;
      },
      update(time, interval) {
        if (nextAt < 0) nextAt = time + randomBetween(0.3, 1.5);
        const horizon = time + Math.max(0.4, interval * 3);
        if (nextAt > horizon) return;
        const start = Math.max(nextAt, time + 0.02);
        const end = intensity > 0.04 ? scheduleCall(start, 0.5 + 0.5 * intensity) : start;
        nextAt = end + randomBetween(0.8, 3.5) * (1.8 - intensity);
      },
      describe() {
        return { intensity, whistles, clickTrains, nextAt };
      },
    };
  },
});
