// 'glider' engine family: v1's soft detuned "prop hum" with a slow tremolo, following the throttle
// exactly as v1 did. It is part of the CLASSIC glider's character; a SIM sailplane has no engine,
// so in SIM the hum is silent and the glider is carried by the airflow beds and the variometer.
import { createScaffold, glide } from '../synthKit.js';

const VOICES = [
  { type: 'sawtooth', ratio: 1, level: 0.5 },
  { type: 'sawtooth', ratio: 1.006, level: 0.45 },
  { type: 'sine', ratio: 0.5, level: 0.55 },
];

/** kit: { context, noise, destination }. */
export function createGliderSynth(kit) {
  const synth = createScaffold(kit.context, kit.destination);
  const propFilter = synth.filter('lowpass', 420, 1.1);
  const propTremolo = synth.gain(0.85);
  const propLfo = synth.oscillator('sine', 9);
  const propLfoDepth = synth.gain(0.14);
  propLfo.connect(propLfoDepth);
  propLfoDepth.connect(propTremolo.gain);
  const oscillators = VOICES.map((voice) => {
    const oscillator = synth.oscillator(voice.type, 72 * voice.ratio);
    const level = synth.gain(voice.level);
    oscillator.connect(level);
    level.connect(propFilter);
    return { oscillator, ratio: voice.ratio };
  });
  propFilter.connect(propTremolo);
  propTremolo.connect(synth.output);
  synth.start(kit.context.currentTime + 0.02);
  const readout = { frequency: 0, level: 0 };

  return {
    family: 'glider',
    /** v1 formula; frame.v1 carries v1's speed ratio, boost flag and throttle. */
    update(frame, pitch) {
      const { time } = frame;
      const { throttle, speedRatio, boosting } = frame.v1;
      const propFrequency = (64 + 50 * throttle + 12 * speedRatio + 10 * boosting) * pitch;
      const propLevel = frame.classic ? 0.004 + 0.018 * Math.pow(throttle, 1.5) + 0.006 * boosting : 0;
      for (const { oscillator, ratio } of oscillators) glide(oscillator.frequency, propFrequency * ratio, time, 0.3);
      glide(propLfo.frequency, propFrequency / 8, time, 0.3);
      glide(propFilter.frequency, 260 + 650 * throttle, time, 0.3);
      glide(synth.output.gain, propLevel, time, 0.3);
      readout.frequency = propFrequency;
      readout.level = propLevel;
    },
    stop(time) {
      synth.stop(time);
    },
    describe() {
      return {
        family: 'glider',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: oscillators.map(({ oscillator }) => oscillator.frequency.value),
      };
    },
  };
}
