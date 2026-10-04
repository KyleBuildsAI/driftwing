// Spawn-sound auditions (dev only: audio.debug.spawn in dev builds, ?debug=1 or ?test). Used by the
// audio lab (tools/lab/audio.mjs) and by the spawn debugger.
//
// Live auditions play a recipe through the real voice manager: a voice that rides with the
// listener at a chosen distance, bearing and elevation, at a chosen intensity, with its triggers,
// and the voice budget, the thunder queue and the discovery chime.
//
// render() plays a recipe through the same voice graph (buildVoiceGraph) in an OfflineAudioContext,
// faster than real time and silently, with the listener at the origin, and analyses the result:
// the level (RMS, peak, the loudest and median 50 ms blocks), the spectrum (centroid, dominant
// frequency, band levels) and the distance gain and absorption applied.
import { clamp } from '../core/util.js';
import { playThunderStrike } from './recipes/thunder.js';
import {
  absorptionCutoff,
  applyPlacement,
  buildVoiceGraph,
  distanceGain,
  recipeByName,
  resolveSpatial,
  spreadAt,
} from './spawnVoices.js';

const FFT_SIZE = 8192;
const BLOCK_SECONDS = 0.05;
const UPDATE_STEP = 0.1;
const SPECTRUM_BANDS = Object.freeze([
  Object.freeze({ name: 'sub', from: 0, to: 60 }),
  Object.freeze({ name: 'low', from: 60, to: 250 }),
  Object.freeze({ name: 'lowMid', from: 250, to: 1000 }),
  Object.freeze({ name: 'highMid', from: 1000, to: 4000 }),
  Object.freeze({ name: 'high', from: 4000, to: Infinity }),
]);

function decibels(value) {
  return value > 0 ? Math.round(20 * Math.log10(value) * 100) / 100 : -Infinity;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** In-place iterative radix-2 FFT of (real, imaginary). */
function fft(real, imaginary) {
  const size = real.length;
  for (let index = 1, swap = 0; index < size; index++) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap], real[index]];
      [imaginary[index], imaginary[swap]] = [imaginary[swap], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/** Level, dynamics and spectrum of an AudioBuffer from skipSeconds on (mono sum). */
export function analyseBuffer(buffer, skipSeconds = 0) {
  const sampleRate = buffer.sampleRate;
  const start = Math.min(Math.floor(skipSeconds * sampleRate), buffer.length - 1);
  const length = buffer.length - start;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index++) mono[index] += data[start + index] / buffer.numberOfChannels;
  }
  let sum = 0;
  let peak = 0;
  let nonFinite = 0;
  for (let index = 0; index < length; index++) {
    const sample = mono[index];
    if (!Number.isFinite(sample)) {
      nonFinite++;
      mono[index] = 0;
      continue;
    }
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(sum / Math.max(length, 1));

  const blockLength = Math.floor(BLOCK_SECONDS * sampleRate);
  const blocks = [];
  for (let blockStart = 0; blockStart + blockLength <= length; blockStart += blockLength) {
    let blockSum = 0;
    for (let index = blockStart; index < blockStart + blockLength; index++) blockSum += mono[index] * mono[index];
    blocks.push(Math.sqrt(blockSum / blockLength));
  }
  const sortedBlocks = [...blocks].sort((a, b) => a - b);

  const power = new Float64Array(FFT_SIZE / 2);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  let frames = 0;
  for (let frameStart = 0; frameStart + FFT_SIZE <= length; frameStart += FFT_SIZE / 2) {
    for (let index = 0; index < FFT_SIZE; index++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
      real[index] = mono[frameStart + index] * window;
      imaginary[index] = 0;
    }
    fft(real, imaginary);
    for (let bin = 0; bin < FFT_SIZE / 2; bin++) power[bin] += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
    frames++;
  }
  const binHz = sampleRate / FFT_SIZE;
  let total = 0;
  let weighted = 0;
  let dominantBin = 0;
  const bandPower = SPECTRUM_BANDS.map(() => 0);
  for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
    const frequency = bin * binHz;
    total += power[bin];
    weighted += power[bin] * frequency;
    if (frequency >= 30 && frequency <= 6000 && power[bin] > power[dominantBin]) dominantBin = bin;
    for (let band = 0; band < SPECTRUM_BANDS.length; band++) {
      if (frequency >= SPECTRUM_BANDS[band].from && frequency < SPECTRUM_BANDS[band].to) bandPower[band] += power[bin];
    }
  }
  let dominantHz = dominantBin * binHz;
  if (dominantBin > 0 && dominantBin < FFT_SIZE / 2 - 1) {
    const left = power[dominantBin - 1];
    const middle = power[dominantBin];
    const rightPower = power[dominantBin + 1];
    const curvature = left - 2 * middle + rightPower;
    if (curvature !== 0) dominantHz = (dominantBin + (0.5 * (left - rightPower)) / curvature) * binHz;
  }
  const bands = {};
  for (let band = 0; band < SPECTRUM_BANDS.length; band++) {
    bands[SPECTRUM_BANDS[band].name] = total > 0 ? round(10 * Math.log10(Math.max(bandPower[band] / total, 1e-12)), 1) : -Infinity;
  }
  return {
    seconds: round(length / sampleRate, 2),
    rms: round(rms, 6),
    rmsDb: decibels(rms),
    peakDb: decibels(peak),
    loudestBlockDb: decibels(sortedBlocks.length ? sortedBlocks[sortedBlocks.length - 1] : 0),
    medianBlockDb: decibels(sortedBlocks.length ? sortedBlocks[Math.floor(sortedBlocks.length / 2)] : 0),
    centroidHz: total > 0 && frames > 0 ? Math.round(weighted / total) : 0,
    dominantHz: round(dominantHz, 2),
    bands,
    nonFinite,
  };
}

/**
 * Renders a recipe offline. options: { seconds (4), distance (the recipe's refDistance), bearing
 * (degrees, 0), intensity (1), params, absorption (true), doppler (1), skip (analysis start, 1 s),
 * triggers: [{ at, name, options }] }. Resolves to the analysis plus what was applied.
 */
export async function renderRecipe({ noise, sampleRate }, recipeName, options = {}) {
  const recipe = recipeByName(recipeName);
  const params = options.params && typeof options.params === 'object' ? options.params : {};
  const spatial = resolveSpatial(recipe.spatial, params);
  const seconds = clamp(Number.isFinite(options.seconds) ? options.seconds : 4, 0.5, 30);
  const distance = Math.max(Number.isFinite(options.distance) ? options.distance : spatial.refDistance, 0);
  const bearing = ((Number.isFinite(options.bearing) ? options.bearing : 0) * Math.PI) / 180;
  const intensity = clamp(Number.isFinite(options.intensity) ? options.intensity : 1, 0, 1);
  const skip = clamp(Number.isFinite(options.skip) ? options.skip : 1, 0, seconds - 0.25);
  const triggers = Array.isArray(options.triggers) ? options.triggers : [];
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(sampleRate * seconds), sampleRate });
  const nyquist = sampleRate / 2;
  const position = { x: Math.sin(bearing) * distance, y: 0, z: -Math.cos(bearing) * distance };
  const issues = [];
  const env = {
    context,
    noise,
    destination: context.destination,
    send: null,
    nyquist,
    trackOneShot(nodes, endSource) {
      endSource.onended = () => {
        for (const node of nodes) node.disconnect();
      };
    },
  };
  const realized = buildVoiceGraph(env, { recipe, params, spatial, position, intensity }, 0);
  // Full level from the first sample: the analysis measures the recipe, not the voice's fade-in.
  realized.scaffold.output.gain.cancelScheduledValues(0);
  realized.scaffold.output.gain.setValueAtTime(1, 0);
  const gain = distanceGain(spatial, distance);
  const cutoff = options.absorption === false ? nyquist : absorptionCutoff(distance, nyquist);
  const placement = {
    position,
    cutoff,
    spread: spreadAt(spatial.size, distance),
    gain,
    spatial,
    doppler: clamp(Number.isFinite(options.doppler) ? options.doppler : 1, 0.25, 4),
  };
  applyPlacement(realized, placement, 0, 0.001);
  realized.absorption.frequency.setValueAtTime(cutoff, 0);

  const fired = [];
  function fire(trigger, time) {
    // A storm's strike is the thunder one-shot (the live voice sends it through audio.thunder()).
    if (recipe.strikes && trigger.name === 'strike') {
      const strikeIntensity = clamp(Number.isFinite(trigger.options?.intensity) ? trigger.options.intensity : 1, 0, 1.5);
      playThunderStrike({ context, noise, destination: context.destination, send: null, cutoff, trackOneShot: env.trackOneShot },
        { time, x: position.x, y: position.y, z: position.z, distance, intensity: strikeIntensity });
      return true;
    }
    return realized.synth.trigger(trigger.name, trigger.options ?? {}, time) === true;
  }
  function fireDue(time) {
    for (let index = 0; index < triggers.length; index++) {
      const trigger = triggers[index];
      const at = Number.isFinite(trigger.at) ? trigger.at : 0;
      if (fired[index] || at > time + 1e-6) continue;
      fired[index] = fire(trigger, Math.max(at, time) + 0.005);
    }
  }
  fireDue(0);
  if (realized.synth.update) realized.synth.update(0, UPDATE_STEP);
  for (let step = 1; step * UPDATE_STEP < seconds - UPDATE_STEP; step++) {
    const time = step * UPDATE_STEP;
    context.suspend(time).then(() => {
      if (realized.synth.update) realized.synth.update(context.currentTime, UPDATE_STEP);
      fireDue(context.currentTime);
      return context.resume();
    }).catch((error) => {
      issues.push(`suspend at ${time}s: ${error.message}`);
    });
  }
  const buffer = await context.startRendering();
  return {
    recipe: recipe.name,
    distance,
    intensity,
    distanceGain: round(gain, 6),
    distanceGainDb: decibels(gain),
    cutoffHz: Math.round(cutoff),
    spatial: { ...spatial },
    triggersFired: fired.map(Boolean),
    synth: realized.synth.describe(),
    nodes: realized.nodeCount,
    issues,
    ...analyseBuffer(buffer, skip),
  };
}

/**
 * The debug.spawn tools. deps: { spawnVoices, getRenderKit() -> { noise, sampleRate } | null }.
 * Voice ids are the handles' ids.
 */
export function createSpawnAudition({ spawnVoices, getRenderKit }) {
  const auditions = new Map();

  function handleFor(id) {
    if (auditions.has(id)) return auditions.get(id);
    return spawnVoices.handles().find((handle) => handle.id === id) ?? null;
  }

  return {
    recipes: spawnVoices.recipes,

    /** Plays a recipe riding with the listener. options: { distance, bearing, elevation, intensity, params }. */
    play(recipe, options = {}) {
      const handle = spawnVoices.audition(recipe, {
        distance: Number.isFinite(options.distance) ? options.distance : 150,
        bearing: options.bearing ?? 0,
        elevation: options.elevation ?? 0,
        intensity: Number.isFinite(options.intensity) ? options.intensity : 1,
        params: options.params,
      });
      auditions.set(handle.id, handle);
      return handle.id;
    },

    /** Moves an audition voice: { distance, bearing, elevation }. */
    place(id, options) {
      const handle = auditions.get(id);
      return handle ? spawnVoices.setAuditionPlacement(handle, options) : false;
    },

    intensity(id, value) {
      const handle = handleFor(id);
      if (!handle) return false;
      handle.setIntensity(value);
      return true;
    },

    trigger(id, name, options) {
      const handle = handleFor(id);
      return handle ? handle.trigger(name, options) : false;
    },

    stop(id) {
      const handle = auditions.get(id);
      if (!handle) return false;
      handle.dispose();
      auditions.delete(id);
      return true;
    },

    stopAll() {
      const count = auditions.size;
      for (const handle of auditions.values()) handle.dispose();
      auditions.clear();
      return count;
    },

    voice(id) {
      const handle = handleFor(id);
      return handle ? handle.describe() : null;
    },

    voices() {
      return spawnVoices.describeVoices();
    },

    stats() {
      return spawnVoices.describe();
    },

    /** A strike at { distance, bearing, elevation } from the listener, fixed in the world. */
    thunder(options) {
      return spawnVoices.thunderFromListener(options);
    },

    thunderLog() {
      return spawnVoices.thunderLog();
    },

    chime(options) {
      return spawnVoices.discoveryChime(options);
    },

    setBudget(value) {
      return spawnVoices.setBudget(value);
    },

    /** Offline render and analysis (see renderRecipe). Rejects before audio has started. */
    render(recipe, options) {
      const kit = getRenderKit();
      if (!kit) return Promise.reject(new Error('audio has not started yet (press a key first)'));
      return renderRecipe(kit, recipe, options);
    },
  };
}
