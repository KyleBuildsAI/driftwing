// One-shot voices from v1, unchanged in sound: bell-like pentatonic chimes (sine partials into the
// convolution reverb), the boost whoosh (noise sweep plus a low thump), bird wing flutter, UI blips
// and the camera shutter. Each voice picks a mixer bus; at the default mix every bus is unity, so
// the levels are v1's. The voice pool caps simultaneous one-shots (sim cues share it).
import { clamp } from '../core/util.js';

const PENTATONIC = [0, 2, 4, 7, 9];
const BASE_FREQUENCY = 392;
const MAX_VOICES = 40;
const BELL_PARTIALS = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2.0, gain: 0.46, decay: 0.62 },
  { ratio: 3.0, gain: 0.2, decay: 0.42 },
  { ratio: 4.18, gain: 0.12, decay: 0.3 },
  { ratio: 5.43, gain: 0.065, decay: 0.2 },
];

function optionNumber(options, key, fallback, min, max) {
  const value = options && Number.isFinite(options[key]) ? options[key] : fallback;
  return clamp(value, min, max);
}

export function frequencyForStep(step) {
  const whole = Math.round(Number.isFinite(step) ? step : 0);
  const octave = Math.floor(whole / 5);
  const degree = ((whole % 5) + 5) % 5;
  return BASE_FREQUENCY * Math.pow(2, (PENTATONIC[degree] + 12 * octave) / 12);
}

/** kit: { context, noise, mixer }. */
export function createVoices(kit) {
  const { context, noise, mixer } = kit;
  let activeVoices = 0;

  function canStart() {
    return activeVoices < MAX_VOICES;
  }

  /** Counts a started voice and releases its nodes when endSource ends. */
  function track(nodes, endSource) {
    activeVoices++;
    endSource.onended = () => {
      activeVoices = Math.max(0, activeVoices - 1);
      for (const node of nodes) node.disconnect();
    };
  }

  /** Connects a voice's output to a bus, plus a reverb send of the given amount. */
  function route(node, busName, sendAmount, nodes) {
    node.connect(mixer.input(busName));
    if (sendAmount > 0) {
      const send = context.createGain();
      send.gain.value = sendAmount;
      node.connect(send);
      send.connect(mixer.send(busName));
      nodes.push(send);
    }
  }

  function playChime(step, options, busName = 'ui') {
    if (!canStart()) return false;
    const volume = optionNumber(options, 'volume', 0.5, 0, 1.5);
    const delay = optionNumber(options, 'delay', 0, 0, 4);
    const pan = optionNumber(options, 'pan', 0, -1, 1);
    const decay = optionNumber(options, 'decay', 2.4, 0.2, 6);
    const brightness = optionNumber(options, 'brightness', 1, 0, 2);
    const reverbAmount = optionNumber(options, 'reverb', 0.55, 0, 1);
    const frequency = frequencyForStep(step);
    const start = context.currentTime + 0.012 + delay;
    const voiceGain = context.createGain();
    voiceGain.gain.value = volume * 0.22;
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    voiceGain.connect(panner);
    const nodes = [voiceGain, panner];
    route(panner, busName, reverbAmount, nodes);
    let longestOscillator = null;
    let longestLength = 0;
    const partials = [...BELL_PARTIALS, { ratio: 1.0035, gain: 0.35, decay: 0.8 }];
    for (const partial of partials) {
      const partialFrequency = frequency * partial.ratio;
      const amplitude = partial.gain * (partial.ratio < 1.5 ? 1 : brightness);
      if (partialFrequency > 16000 || amplitude < 0.002) continue;
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = partialFrequency;
      const envelope = context.createGain();
      const length = decay * partial.decay;
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(amplitude, start + 0.005);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
      oscillator.connect(envelope);
      envelope.connect(voiceGain);
      oscillator.start(start);
      oscillator.stop(start + length + 0.05);
      nodes.push(oscillator, envelope);
      if (length > longestLength) {
        longestLength = length;
        longestOscillator = oscillator;
      }
    }
    if (!longestOscillator) {
      for (const node of nodes) node.disconnect();
      return false;
    }
    track(nodes, longestOscillator);
    return true;
  }

  function playWhoosh(intensity, duration, busName = 'environment') {
    if (!canStart()) return false;
    const level = clamp(Number.isFinite(intensity) ? intensity : 1, 0.05, 1.5);
    const length = clamp(Number.isFinite(duration) ? duration : 1.7, 0.4, 4);
    const start = context.currentTime + 0.01;
    const source = context.createBufferSource();
    source.buffer = noise;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(240, start);
    filter.frequency.exponentialRampToValueAtTime(2600, start + length * 0.32);
    filter.frequency.exponentialRampToValueAtTime(520, start + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4 * level, start + length * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(-0.45, start);
    panner.pan.linearRampToValueAtTime(0.45, start + length);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    const thump = context.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(105, start);
    thump.frequency.exponentialRampToValueAtTime(38, start + 0.55);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0, start);
    thumpGain.gain.linearRampToValueAtTime(0.28 * level, start + 0.015);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
    thump.connect(thumpGain);
    thumpGain.connect(mixer.input(busName));
    const nodes = [source, filter, gain, panner, thump, thumpGain];
    route(panner, busName, 0.3, nodes);
    const offset = Math.random() * Math.max(0, noise.duration - length - 0.1);
    source.start(start, offset);
    source.stop(start + length + 0.05);
    thump.start(start);
    thump.stop(start + 0.65);
    track(nodes, source);
    return true;
  }

  function playFlutter(intensity, pan, busName = 'environment') {
    if (!canStart()) return false;
    const level = clamp(Number.isFinite(intensity) ? intensity : 1, 0.1, 1.5);
    const duration = 0.6 + 0.55 * Math.min(level, 1);
    const start = context.currentTime + 0.01;
    const panner = context.createStereoPanner();
    panner.pan.value = clamp(Number.isFinite(pan) ? pan : 0, -1, 1);
    const nodes = [panner];
    route(panner, busName, 0.18, nodes);
    const layers = [
      { frequency: 2400, rate: 16 },
      { frequency: 1250, rate: 11 },
      { frequency: 3500, rate: 21 },
    ];
    const layerCount = level > 0.6 ? 3 : 2;
    let lastSource = null;
    for (let layer = 0; layer < layerCount; layer++) {
      const settingsForLayer = layers[layer];
      const source = context.createBufferSource();
      source.buffer = noise;
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = settingsForLayer.frequency * (0.9 + Math.random() * 0.2);
      filter.Q.value = 1.3;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, start);
      const end = start + duration;
      let time = start + Math.random() * 0.06;
      while (time < end) {
        const interval = (1 / settingsForLayer.rate) * (0.7 + Math.random() * 0.6);
        const progress = (time - start) / duration;
        const peak = 0.12 * level * Math.pow(1 - progress, 1.2) * (0.6 + Math.random() * 0.4);
        const grain = Math.min(0.028 + Math.random() * 0.012, interval * 0.85);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(peak, time + 0.006);
        gain.gain.linearRampToValueAtTime(0, time + grain);
        time += interval;
      }
      source.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      source.start(start, Math.random() * (noise.duration - duration - 0.2));
      source.stop(end + 0.1);
      nodes.push(source, filter, gain);
      lastSource = source;
    }
    track(nodes, lastSource);
    return true;
  }

  function playBlip(options, busName = 'ui') {
    if (!canStart()) return false;
    const pitch = optionNumber(options, 'pitch', 1, 0.25, 4);
    const volume = optionNumber(options, 'volume', 1, 0, 2);
    const start = context.currentTime + 0.005;
    const tone = context.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(1180 * pitch, start);
    tone.frequency.exponentialRampToValueAtTime(1480 * pitch, start + 0.05);
    const sparkle = context.createOscillator();
    sparkle.type = 'triangle';
    sparkle.frequency.value = 2360 * pitch;
    const sparkleLevel = context.createGain();
    sparkleLevel.gain.value = 0.18;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.06 * volume, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    tone.connect(gain);
    sparkle.connect(sparkleLevel);
    sparkleLevel.connect(gain);
    const nodes = [tone, sparkle, sparkleLevel, gain];
    route(gain, busName, 0.15, nodes);
    tone.start(start);
    sparkle.start(start);
    tone.stop(start + 0.18);
    sparkle.stop(start + 0.18);
    track(nodes, tone);
    return true;
  }

  function playShutter(busName = 'ui') {
    if (!canStart()) return false;
    const start = context.currentTime + 0.005;
    const source = context.createBufferSource();
    source.buffer = noise;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3200;
    filter.Q.value = 0.8;
    const gain = context.createGain();
    for (const [offset, level] of [[0, 0.22], [0.075, 0.12]]) {
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(level, start + offset + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.045);
    }
    source.connect(filter);
    filter.connect(gain);
    gain.connect(mixer.input(busName));
    source.start(start, Math.random() * 2);
    source.stop(start + 0.14);
    track([source, filter, gain], source);
    return true;
  }

  return {
    canStart,
    track,
    route,
    playChime,
    playWhoosh,
    playFlutter,
    playBlip,
    playShutter,
    get active() {
      return activeVoices;
    },
  };
}
