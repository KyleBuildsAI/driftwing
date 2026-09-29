// Discovery chime: v1's pentatonic bell (the same partials and scale as voices.js) in a phrase of
// its own. A quick rising run (A4 D5 G5 A5) opens into a held, shimmering bloom (D6 and G6 with a
// slow vibrato) over a soft low G3 bell. v1's landmark discovery is an even four-note climb; this
// one is a run and a bloom, so the two never sound alike.
//
// playDiscoveryChime() is the one-shot (audio.discoveryChime() and the spawn discovery event). The
// 'discovery' recipe is the same chime as a spatial voice: trigger('chime') rings it from the
// voice's position.
import { BELL_PARTIALS, frequencyForStep } from '../voices.js';
import { option } from './recipeKit.js';

const RUN_STEPS = Object.freeze([1, 3, 5, 6]);
const RUN_SPACING = 0.075;
const BLOOM_STEPS = Object.freeze([8, 10]);
const BLOOM_DELAY = 0.34;
const ROOT_STEP = -5;
const VIBRATO_RATE = 5.2;
const VIBRATO_CENTS = 7;

/**
 * Plays the chime. env: { context, destination, trackOneShot }; options: { time, volume (default
 * 0.5), brightness (0..2, default 1) }. Returns the time the chime ends.
 */
export function playDiscoveryChime(env, options) {
  const { context, destination } = env;
  const start = option(options, 'time', context.currentTime, 0, Infinity);
  const volume = option(options, 'volume', 0.5, 0, 1.5);
  const brightness = option(options, 'brightness', 1, 0, 2);
  const nodes = [];
  const output = new GainNode(context, { gain: volume * 0.22 });
  output.connect(destination);
  nodes.push(output);
  let end = start;

  function bell(frequency, noteStart, amplitude, decay, partialCount, vibrato) {
    for (let index = 0; index < partialCount; index++) {
      const partial = BELL_PARTIALS[index];
      const partialFrequency = frequency * partial.ratio;
      const partialAmplitude = amplitude * partial.gain * (partial.ratio < 1.5 ? 1 : brightness);
      if (partialFrequency > 16000 || partialAmplitude < 0.002) continue;
      const oscillator = new OscillatorNode(context, { type: 'sine', frequency: partialFrequency });
      const envelope = new GainNode(context, { gain: 0 });
      const length = decay * partial.decay;
      envelope.gain.setValueAtTime(0, noteStart);
      envelope.gain.linearRampToValueAtTime(partialAmplitude, noteStart + 0.005);
      envelope.gain.exponentialRampToValueAtTime(0.0001, noteStart + length);
      oscillator.connect(envelope);
      envelope.connect(output);
      if (vibrato) vibrato.connect(oscillator.detune);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + length + 0.05);
      nodes.push(oscillator, envelope);
      end = Math.max(end, noteStart + length + 0.05);
    }
  }

  for (let index = 0; index < RUN_STEPS.length; index++) {
    bell(frequencyForStep(RUN_STEPS[index]), start + index * RUN_SPACING, index === RUN_STEPS.length - 1 ? 0.95 : 0.8, 1.3, 3, null);
  }
  const bloomStart = start + BLOOM_DELAY;
  const vibratoSource = new OscillatorNode(context, { type: 'sine', frequency: VIBRATO_RATE });
  const vibrato = new GainNode(context, { gain: 0 });
  vibrato.gain.setValueAtTime(0, bloomStart);
  vibrato.gain.linearRampToValueAtTime(VIBRATO_CENTS, bloomStart + 1.2);
  vibratoSource.connect(vibrato);
  nodes.push(vibratoSource, vibrato);
  for (let index = 0; index < BLOOM_STEPS.length; index++) {
    bell(frequencyForStep(BLOOM_STEPS[index]), bloomStart + index * 0.02, 0.85, 4.2, BELL_PARTIALS.length, vibrato);
  }
  bell(frequencyForStep(ROOT_STEP), bloomStart, 0.55, 3.4, 3, null);
  vibratoSource.start(bloomStart);
  vibratoSource.stop(end + 0.05);
  env.trackOneShot(nodes, vibratoSource);
  return end + 0.05;
}

export default Object.freeze({
  name: 'discovery',
  summary: 'discovery chime (pentatonic bell run and bloom)',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 150, rolloffFactor: 1.4, panningModel: 'HRTF', size: 0, reverb: 0.6 }),
  level: 0.05,
  floor: 1,
  triggers: Object.freeze(['chime']),

  build(kit) {
    let chimes = 0;
    return {
      // The chime has no continuous sound, so there is nothing for an intensity to scale.
      setIntensity() {},
      trigger(name, options, time) {
        if (name !== 'chime') return false;
        chimes++;
        playDiscoveryChime({ context: kit.context, destination: kit.out, trackOneShot: kit.trackOneShot }, {
          time,
          volume: option(options, 'volume', 0.5, 0, 1.5),
          brightness: option(options, 'brightness', 1, 0, 2),
        });
        return true;
      },
      describe() {
        return { chimes };
      },
    };
  },
});
