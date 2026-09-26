import * as THREE from 'three/webgpu';
import { clamp } from '../core/util.js';
import { CONFIG } from '../core/config.js';

/**
 * AUDIO: a small procedural WebAudio engine.
 * - The AudioContext is created only inside a user activation ('user:gesture', or unlock() called from
 *   a click/key handler). Before that every method is a silent no-op.
 * - Beds: looping pink-noise wind (body + airy layer) whose gain and cutoff follow airspeed, g-load,
 *   boost and cloud immersion, with slow gusts; a very soft two-oscillator prop hum following throttle.
 * - One-shots: boost whoosh (noise sweep + low thump), bell-like pentatonic chimes (sine partials into a
 *   generated convolution reverb), UI blips, a camera shutter click and bird wing flutter.
 * - Listens to flight/ring/waypoint/landmark/bird/UI events itself. Event cues are flushed in update();
 *   when another module already played the same kind of cue directly this moment, the event cue is
 *   skipped so nothing doubles. Master volume follows settings.masterVolume and ducks in photo mode.
 */
export function createAudioSystem(ctx) {
  const { THREE: T, bus, settings, state, camera } = ctx;
  const PENTATONIC = [0, 2, 4, 7, 9];
  const BASE_FREQUENCY = 392;
  const EVENT_GUARD_SECONDS = 0.3;
  const PARAMETER_INTERVAL = 0.05;
  const MAX_VOICES = 40;
  const BELL_PARTIALS = [
    { ratio: 1, gain: 1, decay: 1 },
    { ratio: 2.0, gain: 0.46, decay: 0.62 },
    { ratio: 3.0, gain: 0.2, decay: 0.42 },
    { ratio: 4.18, gain: 0.12, decay: 0.3 },
    { ratio: 5.43, gain: 0.065, decay: 0.2 },
  ];

  let audioContext = null;
  let graph = null;
  let status = 'locked';
  let lastIssue = null;
  let activeVoices = 0;
  let parameterTimer = 0;
  let masterTimeConstant = 0.9;
  let gustLevel = 1;
  let gustTarget = 1;
  let gustTimer = 0;
  let windPan = 0;
  const pendingCues = [];
  const lastDirectCue = { chime: -Infinity, whoosh: -Infinity, flutter: -Infinity, blip: -Infinity };
  const listenerRight = new T.Vector3();
  const toSource = new T.Vector3();

  function noteIssue(error) {
    lastIssue = error && error.message ? error.message : String(error);
  }

  function isReady() {
    return audioContext !== null && graph !== null;
  }

  function hasActivation() {
    const activation = navigator.userActivation;
    if (activation && typeof activation.isActive === 'boolean') return activation.isActive;
    return ctx.userHasInteracted === true;
  }

  // ---- Buffers, prepared in idle time --------------------------------------------------------------
  // About 7 s of stereo noise plus a reverb tail take ~100 ms to generate; doing that on the
  // first click stalled a frame. AudioBuffer needs no context, so the samples are written in small
  // idle-time slices right after load, and unlock() only has to create the context.
  const BUFFER_SAMPLE_RATE = 48000;
  const NOISE_SECONDS = 4;
  const REVERB_SECONDS = 2.8;
  const REVERB_DECAY_POWER = 2.6;
  const SAMPLES_PER_SLICE = 4096;
  const bufferJobs = [];
  let preparedBuffers = null;
  let pendingBuffers = null;

  function* fillPinkNoise(buffer) {
    const length = buffer.length;
    const fade = Math.floor(buffer.sampleRate * 0.08);
    const generated = new Float32Array(length + fade);
    for (let channel = 0; channel < 2; channel++) {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let index = 0; index < generated.length; index++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        generated[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
        if (index % SAMPLES_PER_SLICE === 0) yield;
      }
      const data = buffer.getChannelData(channel);
      data.set(generated.subarray(0, length));
      // Crossfade the tail into the head so the loop point is seamless.
      for (let index = 0; index < fade; index++) {
        const blend = index / fade;
        data[index] = generated[index] * blend + generated[length + index] * (1 - blend);
      }
      yield;
    }
  }

  function* fillImpulseResponse(buffer, decayPower) {
    const length = buffer.length;
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let smoothed = 0;
      for (let index = 0; index < length; index++) {
        const progress = index / length;
        const envelope = Math.pow(1 - progress, decayPower);
        const white = Math.random() * 2 - 1;
        smoothed += (white - smoothed) * (0.62 - 0.5 * progress);
        data[index] = smoothed * envelope;
        if (index % SAMPLES_PER_SLICE === 0) yield;
      }
      for (let reflection = 0; reflection < 6; reflection++) {
        const index = Math.floor(buffer.sampleRate * (0.011 + reflection * 0.009 + Math.random() * 0.006));
        if (index < length) data[index] += (Math.random() < 0.5 ? -1 : 1) * (0.5 - reflection * 0.06);
      }
    }
  }

  function makeBuffer(seconds, context) {
    const sampleRate = context ? context.sampleRate : BUFFER_SAMPLE_RATE;
    const length = Math.floor(sampleRate * seconds);
    return context ? context.createBuffer(2, length, sampleRate) : new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  }

  function queueBufferJobs(context) {
    const noise = makeBuffer(NOISE_SECONDS, context);
    const reverb = makeBuffer(REVERB_SECONDS, context);
    bufferJobs.push(fillPinkNoise(noise), fillImpulseResponse(reverb, REVERB_DECAY_POWER));
    pendingBuffers = { noise, reverb };
  }

  function stepBufferJob() {
    if (bufferJobs[0].next().done) bufferJobs.shift();
    if (bufferJobs.length === 0) preparedBuffers = pendingBuffers;
  }

  function requestIdle(callback) {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(callback, { timeout: 2000 });
    else setTimeout(() => callback({ timeRemaining: () => 6, didTimeout: false }), 30);
  }

  function runBufferJobsWhileIdle(deadline) {
    while (bufferJobs.length > 0 && (deadline.timeRemaining() > 2 || deadline.didTimeout)) {
      stepBufferJob();
      if (deadline.didTimeout) break;
    }
    if (bufferJobs.length > 0) requestIdle(runBufferJobsWhileIdle);
  }

  /** The prepared noise + reverb buffers; finishes any remaining slices now if the player was quicker. */
  function takePreparedBuffers(context) {
    if (!pendingBuffers) queueBufferJobs(context);
    while (bufferJobs.length > 0) stepBufferJob();
    return preparedBuffers;
  }

  if (typeof AudioBuffer === 'function') {
    try {
      queueBufferJobs(null);
      requestIdle(runBufferJobsWhileIdle);
    } catch (error) {
      // Older engines without the AudioBuffer constructor: buffers are built at unlock instead.
      noteIssue(error);
      bufferJobs.length = 0;
      pendingBuffers = null;
    }
  }

  // ---- Graph -----------------------------------------------------------------------------------------
  /** Master gain into a gentle compressor, plus the effects send and the reverb return. */
  function createOutputChain(context, reverbBuffer) {
    const master = context.createGain();
    master.gain.value = 0;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.25;
    master.connect(compressor);
    compressor.connect(context.destination);

    const effects = context.createGain();
    effects.connect(master);
    const reverb = context.createConvolver();
    reverb.buffer = reverbBuffer;
    const reverbReturn = context.createGain();
    reverbReturn.gain.value = 0.36;
    reverb.connect(reverbReturn);
    reverbReturn.connect(master);
    return { master, effects, reverb };
  }

  /** Two looping noise layers: a low body and a panned, brighter rush of air. */
  function createWindLayers(context, noise, master, start) {
    const windBodySource = context.createBufferSource();
    windBodySource.buffer = noise;
    windBodySource.loop = true;
    const windBodyFilter = context.createBiquadFilter();
    windBodyFilter.type = 'lowpass';
    windBodyFilter.frequency.value = 380;
    windBodyFilter.Q.value = 0.4;
    const windBodyGain = context.createGain();
    windBodyGain.gain.value = 0;
    windBodySource.connect(windBodyFilter);
    windBodyFilter.connect(windBodyGain);
    windBodyGain.connect(master);

    const windAirSource = context.createBufferSource();
    windAirSource.buffer = noise;
    windAirSource.loop = true;
    windAirSource.playbackRate.value = 1.19;
    const windAirFilter = context.createBiquadFilter();
    windAirFilter.type = 'bandpass';
    windAirFilter.frequency.value = 1400;
    windAirFilter.Q.value = 0.7;
    const windAirGain = context.createGain();
    windAirGain.gain.value = 0;
    const windPanner = context.createStereoPanner();
    windAirSource.connect(windAirFilter);
    windAirFilter.connect(windAirGain);
    windAirGain.connect(windPanner);
    windPanner.connect(master);

    windBodySource.start(start, 0);
    windAirSource.start(start, 1.7);
    return { windBodyFilter, windBodyGain, windAirFilter, windAirGain, windPanner };
  }

  /** A soft detuned prop hum with a slow tremolo, following the throttle. */
  function createPropHum(context, master, start) {
    const propFilter = context.createBiquadFilter();
    propFilter.type = 'lowpass';
    propFilter.frequency.value = 420;
    propFilter.Q.value = 1.1;
    const propTremolo = context.createGain();
    propTremolo.gain.value = 0.85;
    const propLfo = context.createOscillator();
    propLfo.frequency.value = 9;
    const propLfoDepth = context.createGain();
    propLfoDepth.gain.value = 0.14;
    propLfo.connect(propLfoDepth);
    propLfoDepth.connect(propTremolo.gain);
    const propGain = context.createGain();
    propGain.gain.value = 0;
    const propOscillators = [];
    for (const voice of [{ type: 'sawtooth', ratio: 1, level: 0.5 }, { type: 'sawtooth', ratio: 1.006, level: 0.45 }, { type: 'sine', ratio: 0.5, level: 0.55 }]) {
      const oscillator = context.createOscillator();
      oscillator.type = voice.type;
      oscillator.frequency.value = 72 * voice.ratio;
      const level = context.createGain();
      level.gain.value = voice.level;
      oscillator.connect(level);
      level.connect(propFilter);
      oscillator.start(start);
      propOscillators.push({ oscillator, ratio: voice.ratio });
    }
    propFilter.connect(propTremolo);
    propTremolo.connect(propGain);
    propGain.connect(master);
    propLfo.start(start);
    return { propFilter, propGain, propLfo, propOscillators };
  }

  function buildGraph(context) {
    const { noise, reverb: reverbBuffer } = takePreparedBuffers(context);
    const start = context.currentTime + 0.02;
    const output = createOutputChain(context, reverbBuffer);
    return {
      ...output,
      noise,
      ...createWindLayers(context, noise, output.master, start),
      ...createPropHum(context, output.master, start),
    };
  }

  // ---- Unlock ----------------------------------------------------------------------------------------
  function resumeIfSuspended() {
    if (audioContext && audioContext.state === 'suspended' && !document.hidden) {
      audioContext.resume().catch(noteIssue);
    }
  }

  function unlock() {
    if (status === 'unavailable') return false;
    if (audioContext) {
      resumeIfSuspended();
      return true;
    }
    if (!hasActivation()) return false;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') {
      status = 'unavailable';
      lastIssue = 'Web Audio is not supported in this browser.';
      return false;
    }
    try {
      audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      graph = buildGraph(audioContext);
    } catch (error) {
      status = 'unavailable';
      noteIssue(error);
      console.error('[DRIFTWING] audio engine failed to start', error);
      if (audioContext) audioContext.close().catch(noteIssue);
      audioContext = null;
      graph = null;
      return false;
    }
    status = audioContext.state;
    audioContext.addEventListener('statechange', () => {
      if (audioContext) status = audioContext.state;
    });
    resumeIfSuspended();
    return true;
  }

  function onActivationInput() {
    if (!audioContext) unlock();
    else resumeIfSuspended();
  }

  bus.on('user:gesture', unlock);
  // Touch pointerdown is not an activation in every browser; later taps/keys retry the unlock.
  window.addEventListener('pointerup', onActivationInput, { passive: true });
  window.addEventListener('keydown', onActivationInput);
  window.addEventListener('touchend', onActivationInput, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!audioContext) return;
    if (document.hidden) audioContext.suspend().catch(noteIssue);
    else resumeIfSuspended();
  });

  // ---- Voices ----------------------------------------------------------------------------------------
  function releaseVoice(nodes) {
    activeVoices = Math.max(0, activeVoices - 1);
    for (const node of nodes) node.disconnect();
  }

  function frequencyForStep(step) {
    const whole = Math.round(Number.isFinite(step) ? step : 0);
    const octave = Math.floor(whole / 5);
    const degree = ((whole % 5) + 5) % 5;
    return BASE_FREQUENCY * Math.pow(2, (PENTATONIC[degree] + 12 * octave) / 12);
  }

  function optionNumber(options, key, fallback, min, max) {
    const value = options && Number.isFinite(options[key]) ? options[key] : fallback;
    return clamp(value, min, max);
  }

  function playChime(step, options) {
    if (!isReady() || activeVoices >= MAX_VOICES) return false;
    const context = audioContext;
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
    const send = context.createGain();
    send.gain.value = reverbAmount;
    voiceGain.connect(panner);
    panner.connect(graph.effects);
    panner.connect(send);
    send.connect(graph.reverb);
    const nodes = [voiceGain, panner, send];
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
    activeVoices++;
    longestOscillator.onended = () => releaseVoice(nodes);
    return true;
  }

  function playWhoosh(intensity, duration) {
    if (!isReady() || activeVoices >= MAX_VOICES) return false;
    const context = audioContext;
    const level = clamp(Number.isFinite(intensity) ? intensity : 1, 0.05, 1.5);
    const length = clamp(Number.isFinite(duration) ? duration : 1.7, 0.4, 4);
    const start = context.currentTime + 0.01;
    const source = context.createBufferSource();
    source.buffer = graph.noise;
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
    const send = context.createGain();
    send.gain.value = 0.3;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(graph.effects);
    panner.connect(send);
    send.connect(graph.reverb);
    const thump = context.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(105, start);
    thump.frequency.exponentialRampToValueAtTime(38, start + 0.55);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0, start);
    thumpGain.gain.linearRampToValueAtTime(0.28 * level, start + 0.015);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
    thump.connect(thumpGain);
    thumpGain.connect(graph.effects);
    const offset = Math.random() * Math.max(0, graph.noise.duration - length - 0.1);
    source.start(start, offset);
    source.stop(start + length + 0.05);
    thump.start(start);
    thump.stop(start + 0.65);
    activeVoices++;
    const nodes = [source, filter, gain, panner, send, thump, thumpGain];
    source.onended = () => releaseVoice(nodes);
    return true;
  }

  function playFlutter(intensity, pan) {
    if (!isReady() || activeVoices >= MAX_VOICES) return false;
    const context = audioContext;
    const level = clamp(Number.isFinite(intensity) ? intensity : 1, 0.1, 1.5);
    const duration = 0.6 + 0.55 * Math.min(level, 1);
    const start = context.currentTime + 0.01;
    const panner = context.createStereoPanner();
    panner.pan.value = clamp(Number.isFinite(pan) ? pan : 0, -1, 1);
    const send = context.createGain();
    send.gain.value = 0.18;
    panner.connect(graph.effects);
    panner.connect(send);
    send.connect(graph.reverb);
    const nodes = [panner, send];
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
      source.buffer = graph.noise;
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
      source.start(start, Math.random() * (graph.noise.duration - duration - 0.2));
      source.stop(end + 0.1);
      nodes.push(source, filter, gain);
      lastSource = source;
    }
    activeVoices++;
    lastSource.onended = () => releaseVoice(nodes);
    return true;
  }

  function playBlip(options) {
    if (!isReady() || activeVoices >= MAX_VOICES) return false;
    const context = audioContext;
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
    const send = context.createGain();
    send.gain.value = 0.15;
    tone.connect(gain);
    sparkle.connect(sparkleLevel);
    sparkleLevel.connect(gain);
    gain.connect(graph.effects);
    gain.connect(send);
    send.connect(graph.reverb);
    tone.start(start);
    sparkle.start(start);
    tone.stop(start + 0.18);
    sparkle.stop(start + 0.18);
    activeVoices++;
    const nodes = [tone, sparkle, sparkleLevel, gain, send];
    tone.onended = () => releaseVoice(nodes);
    return true;
  }

  function playShutter() {
    if (!isReady() || activeVoices >= MAX_VOICES) return false;
    const context = audioContext;
    const start = context.currentTime + 0.005;
    const source = context.createBufferSource();
    source.buffer = graph.noise;
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
    gain.connect(graph.effects);
    source.start(start, Math.random() * 2);
    source.stop(start + 0.14);
    activeVoices++;
    const nodes = [source, filter, gain];
    source.onended = () => releaseVoice(nodes);
    return true;
  }

  // ---- Spatial helpers ----------------------------------------------------------------------------
  function panFor(position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return 0;
    toSource.set(position.x - camera.position.x, position.y - camera.position.y, position.z - camera.position.z);
    const distance = toSource.length();
    if (distance < 1) return 0;
    listenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return clamp(toSource.dot(listenerRight) / distance, -1, 1) * 0.75;
  }

  function proximity(position, near, far) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return 0.6;
    const sourceY = Number.isFinite(position.y) ? position.y : camera.position.y;
    const distance = Math.hypot(position.x - camera.position.x, sourceY - camera.position.y, position.z - camera.position.z);
    return 1 - 0.8 * clamp((distance - near) / (far - near), 0, 1);
  }

  // ---- Event cues ------------------------------------------------------------------------------------
  function queueCue(category, kind, play) {
    if (!isReady() || pendingCues.length > 24) return;
    pendingCues.push({ category, kind, play });
  }

  function flushCues() {
    if (pendingCues.length === 0) return;
    const now = state.time.realElapsed;
    const threaded = pendingCues.some((cue) => cue.kind === 'threaded');
    for (const cue of pendingCues) {
      if (threaded && cue.kind === 'discovery') continue;
      if (now - lastDirectCue[cue.category] < EVENT_GUARD_SECONDS) continue;
      cue.play();
    }
    pendingCues.length = 0;
  }

  function playSequence(steps, spacing, options) {
    steps.forEach((step, index) => {
      const last = index === steps.length - 1;
      playChime(step, {
        ...options,
        delay: (options.delay || 0) + index * spacing,
        decay: last ? (options.decay || 2.4) * 1.35 : options.decay,
        volume: (options.volume || 0.5) * (last ? 1.1 : 0.9),
      });
    });
  }

  bus.on('boost', () => queueCue('whoosh', 'boost', () => playWhoosh(1, 1.8)));
  bus.on('barrelroll', () => queueCue('whoosh', 'barrelroll', () => playWhoosh(0.45, 1.15)));
  bus.on('ring:passed', (payload) => {
    const streak = payload && Number.isFinite(payload.streak) ? payload.streak : 1;
    const step = 2 + clamp(Math.round(streak) - 1, 0, 10);
    const pan = panFor(payload && payload.position);
    queueCue('chime', 'ring', () => {
      playChime(step, { volume: 0.55, pan, decay: 2.2 });
      if (streak >= 3) playChime(step - 2, { volume: 0.22, pan, delay: 0.035, decay: 1.8, brightness: 0.6 });
    });
  });
  bus.on('ring:missed', () => queueCue('chime', 'miss', () => {
    playChime(-3, { volume: 0.3, decay: 0.7, brightness: 0.25, reverb: 0.3 });
    playChime(-5, { volume: 0.26, decay: 0.9, brightness: 0.2, reverb: 0.3, delay: 0.12 });
  }));
  bus.on('rings:started', () => queueCue('chime', 'rings-start', () => playSequence([0, 2], 0.1, { volume: 0.32, decay: 1.4 })));
  bus.on('rings:finished', () => queueCue('chime', 'rings-finish', () => {
    playSequence([5, 7, 9, 10, 12], 0.1, { volume: 0.45, decay: 2.6 });
    playChime(0, { volume: 0.3, delay: 0.4, decay: 3.2, brightness: 0.5 });
  }));
  bus.on('rings:cancelled', () => queueCue('blip', 'rings-cancel', () => {
    playBlip({ pitch: 0.9 });
    playBlip({ pitch: 0.7, volume: 0.8 });
  }));
  bus.on('waypoint:reached', (payload) => {
    const pan = panFor(payload && Number.isFinite(payload.x) ? { x: payload.x, y: camera.position.y, z: payload.z } : null);
    queueCue('chime', 'waypoint', () => {
      playChime(5, { volume: 0.42, pan, decay: 2.6 });
      playChime(7, { volume: 0.36, pan, delay: 0.07, decay: 2.6 });
      playChime(9, { volume: 0.34, pan, delay: 0.14, decay: 2.8 });
      playChime(10, { volume: 0.38, pan, delay: 0.24, decay: 3.2 });
    });
  });
  bus.on('landmark:discovered', (payload) => {
    const site = payload && payload.site;
    const pan = panFor(site && Number.isFinite(site.x) ? { x: site.x, y: camera.position.y, z: site.z } : null);
    queueCue('chime', 'discovery', () => playSequence([4, 6, 8, 10], 0.115, { volume: 0.46, pan, decay: 2.5 }));
  });
  bus.on('landmark:threaded', () => queueCue('chime', 'threaded', () => playSequence([5, 6, 7, 8, 9, 10, 12], 0.06, { volume: 0.38, decay: 2.2 })));
  bus.on('birds:scattered', (payload) => {
    const count = payload && Number.isFinite(payload.count) ? payload.count : 12;
    const position = payload && payload.position;
    const intensity = clamp(count / 24, 0.3, 1.3) * proximity(position, 40, 400);
    const pan = panFor(position);
    queueCue('flutter', 'birds', () => playFlutter(intensity, pan));
  });
  bus.on('waypoint:set', () => queueCue('blip', 'waypoint-set', () => playBlip({ pitch: 1 })));
  bus.on('waypoint:cleared', () => queueCue('blip', 'waypoint-clear', () => playBlip({ pitch: 0.8, volume: 0.8 })));
  bus.on('autopilot:changed', (payload) => {
    const enabled = Boolean(payload && payload.enabled);
    queueCue('blip', 'autopilot', () => playBlip({ pitch: enabled ? 1.12 : 0.84 }));
  });
  bus.on('ui:command', () => queueCue('blip', 'ui', () => playBlip({ pitch: 1 })));
  bus.on('ui:action', () => queueCue('blip', 'ui', () => playBlip({ pitch: 1.06 })));
  bus.on('copilot:listening', (payload) => {
    if (payload && payload.state === 'listening') queueCue('blip', 'mic', () => playBlip({ pitch: 1.25, volume: 0.8 }));
  });
  bus.on('screenshot:taken', () => queueCue('blip', 'shutter', () => playShutter()));

  // ---- Continuous beds -----------------------------------------------------------------------------
  function setParameter(parameter, value, time, timeConstant) {
    parameter.setTargetAtTime(value, time, timeConstant);
  }

  function updateBeds() {
    const player = state.player;
    const time = audioContext.currentTime;
    const speedRatio = clamp(player.speed / CONFIG.SPEED.MAX, 0, 1.4);
    const boosting = player.boost && player.boost.active ? 1 : 0;
    const gLoad = clamp(Math.abs((Number.isFinite(player.gForce) ? player.gForce : 1) - 1), 0, 3);
    const inCloud = clamp(Number.isFinite(player.inCloud) ? player.inCloud : 0, 0, 1);
    const throttle = clamp(Number.isFinite(player.throttle) ? player.throttle : 0, 0, 1);
    gustTimer -= PARAMETER_INTERVAL;
    if (gustTimer <= 0) {
      gustTarget = 0.78 + Math.random() * 0.5;
      gustTimer = 0.8 + Math.random() * 2.4;
    }
    gustLevel += (gustTarget - gustLevel) * 0.08;
    windPan += ((Math.random() - 0.5) * 0.4 - windPan) * 0.05;

    const bodyGain = (0.03 + 0.2 * speedRatio * speedRatio) * gustLevel * (1 + 0.25 * gLoad);
    const bodyCutoff = (200 + 950 * speedRatio) * (0.85 + 0.3 * gustLevel) * (1 - 0.3 * inCloud);
    const airGain = (0.004 + 0.1 * speedRatio * speedRatio * speedRatio + 0.05 * boosting + 0.02 * gLoad) * (0.7 + 0.3 * gustLevel);
    const airFrequency = (850 + 2500 * speedRatio) * (1 - 0.35 * inCloud);
    const propFrequency = 64 + 50 * throttle + 12 * speedRatio + 10 * boosting;
    const propLevel = 0.004 + 0.018 * Math.pow(throttle, 1.5) + 0.006 * boosting;
    const volume = clamp(Number(settings.get('masterVolume')) || 0, 0, 1);
    const masterLevel = volume * (state.photoMode ? 0.55 : 1);

    setParameter(graph.windBodyGain.gain, bodyGain, time, 0.18);
    setParameter(graph.windBodyFilter.frequency, bodyCutoff, time, 0.25);
    setParameter(graph.windAirGain.gain, airGain, time, 0.2);
    setParameter(graph.windAirFilter.frequency, airFrequency, time, 0.25);
    setParameter(graph.windPanner.pan, windPan, time, 0.4);
    for (const { oscillator, ratio } of graph.propOscillators) setParameter(oscillator.frequency, propFrequency * ratio, time, 0.3);
    setParameter(graph.propLfo.frequency, propFrequency / 8, time, 0.3);
    setParameter(graph.propFilter.frequency, 260 + 650 * throttle, time, 0.3);
    setParameter(graph.propGain.gain, propLevel, time, 0.3);
    setParameter(graph.master.gain, masterLevel, time, masterTimeConstant);
    masterTimeConstant = 0.25;
  }

  return {
    update(dt, realDt) {
      if (!isReady()) return;
      flushCues();
      parameterTimer -= realDt;
      if (parameterTimer > 0) return;
      parameterTimer = PARAMETER_INTERVAL;
      updateBeds();
    },
    unlock,
    chime(step, options) {
      lastDirectCue.chime = state.time.realElapsed;
      return playChime(step, options);
    },
    whoosh(options) {
      lastDirectCue.whoosh = state.time.realElapsed;
      return playWhoosh(options && options.intensity, options && options.duration);
    },
    blip(options) {
      lastDirectCue.blip = state.time.realElapsed;
      return playBlip(options);
    },
    flutter(options) {
      lastDirectCue.flutter = state.time.realElapsed;
      return playFlutter(options && options.intensity, options && options.pan);
    },
    getStats() {
      return {
        state: audioContext ? audioContext.state : status,
        voices: activeVoices,
        sampleRate: audioContext ? audioContext.sampleRate : null,
        issue: lastIssue,
      };
    },
  };
}
