// Procedural sample buffers for the audio engine: seamless looping stereo pink noise (every bed,
// engine and one-shot filters it) and a generated convolution-reverb impulse response.
//
// About 7 s of stereo noise plus a reverb tail take ~100 ms to generate; doing that on the first
// click stalled a frame in v1. AudioBuffer needs no context, so the samples are written in small
// idle-time slices right after load, and the unlock only has to create the context.

const BUFFER_SAMPLE_RATE = 48000;
const NOISE_SECONDS = 4;
const REVERB_SECONDS = 2.8;
const REVERB_DECAY_POWER = 2.6;
const SAMPLES_PER_SLICE = 4096;

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

function requestIdle(callback) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(callback, { timeout: 2000 });
  else setTimeout(() => callback({ timeRemaining: () => 6, didTimeout: false }), 30);
}

/**
 * Starts generating the noise and reverb buffers in idle time. take(context) returns them,
 * finishing any remaining slices synchronously when the player was quicker than the idle queue.
 * onIssue receives a non-fatal problem (engines without the AudioBuffer constructor build the
 * buffers at unlock instead).
 */
export function createBufferFactory(onIssue) {
  const bufferJobs = [];
  let preparedBuffers = null;
  let pendingBuffers = null;

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

  function runBufferJobsWhileIdle(deadline) {
    while (bufferJobs.length > 0 && (deadline.timeRemaining() > 2 || deadline.didTimeout)) {
      stepBufferJob();
      if (deadline.didTimeout) break;
    }
    if (bufferJobs.length > 0) requestIdle(runBufferJobsWhileIdle);
  }

  if (typeof AudioBuffer === 'function') {
    try {
      queueBufferJobs(null);
      requestIdle(runBufferJobsWhileIdle);
    } catch (error) {
      onIssue(error);
      bufferJobs.length = 0;
      pendingBuffers = null;
    }
  }

  return {
    /** The prepared { noise, reverb } buffers for this context. */
    take(context) {
      if (!pendingBuffers) queueBufferJobs(context);
      while (bufferJobs.length > 0) stepBufferJob();
      return preparedBuffers;
    },
  };
}
