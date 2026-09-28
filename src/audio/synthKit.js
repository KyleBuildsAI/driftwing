// Small Web Audio building blocks shared by the engine families, the airflow beds and the cues:
// guarded parameter automation, looping noise taps, oscillators, amplitude modulation and a
// scaffold that owns a synth's nodes so it can fade out and release them cleanly.

/** setTargetAtTime that ignores non-finite targets (a NaN would throw and kill the audio system). */
export function glide(parameter, value, time, timeConstant) {
  if (!Number.isFinite(value)) return;
  parameter.setTargetAtTime(value, time, timeConstant);
}

/** Freezes a parameter at its current automated value so a new ramp starts without a jump. */
export function holdAt(parameter, time) {
  if (typeof parameter.cancelAndHoldAtTime === 'function') {
    parameter.cancelAndHoldAtTime(time);
    return;
  }
  const current = parameter.value;
  parameter.cancelScheduledValues(time);
  parameter.setValueAtTime(current, time);
}

export function smoothstep(edge0, edge1, value) {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Exponential approach of current toward target with time constant seconds over dt. */
export function approach(current, target, timeConstant, dt) {
  if (!(timeConstant > 0)) return target;
  return current + (target - current) * (1 - Math.exp(-dt / timeConstant));
}

/**
 * A periodic wave made of equal-weight cosine harmonics: a train of narrow pulses once per cycle.
 * Driving a gain with it at a blade-pass frequency gives the impulsive "slap" of rotor blades.
 */
export function createPulseWave(context, harmonics) {
  const real = new Float32Array(harmonics + 1);
  const imaginary = new Float32Array(harmonics + 1);
  for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
    // A gentle taper keeps the pulses from ringing (a raised-cosine window over the harmonics).
    real[harmonic] = 0.5 + 0.5 * Math.cos((Math.PI * harmonic) / (harmonics + 1));
  }
  return context.createPeriodicWave(real, imaginary);
}

/**
 * Owns the nodes of one continuous synth. Everything feeds output, a GainNode connected to
 * destination and silent until the synth sets a level. stop() fades output out, stops every source
 * and disconnects every node once the last source has ended.
 */
export function createScaffold(context, destination) {
  const output = context.createGain();
  output.gain.value = 0;
  output.connect(destination);
  const nodes = [output];
  const sources = [];
  const startOffsets = new Map();
  let stopped = false;

  function add(node) {
    nodes.push(node);
    if (typeof node.start === 'function') sources.push(node);
    return node;
  }

  return {
    context,
    output,
    add,

    gain(value) {
      const node = add(context.createGain());
      node.gain.value = value;
      return node;
    },

    filter(type, frequency, q) {
      const node = add(context.createBiquadFilter());
      node.type = type;
      node.frequency.value = frequency;
      node.Q.value = q;
      return node;
    },

    oscillator(type, frequency, periodicWave) {
      const node = add(context.createOscillator());
      if (periodicWave) node.setPeriodicWave(periodicWave);
      else node.type = type;
      node.frequency.value = frequency;
      return node;
    },

    /** A looping tap on the shared noise buffer at a random offset (so layers never correlate). */
    noise(buffer, playbackRate = 1) {
      const node = add(context.createBufferSource());
      node.buffer = buffer;
      node.loop = true;
      node.playbackRate.value = playbackRate;
      startOffsets.set(node, Math.random() * buffer.duration * 0.9);
      return node;
    },

    /**
     * Amplitude modulation: returns a gain whose level is base + depth * modulator(t). The
     * modulator is an oscillator created here (its frequency is the returned lfo.frequency).
     */
    modulated(base, depth, frequency, type = 'sine', periodicWave = null) {
      const carrier = add(context.createGain());
      carrier.gain.value = base;
      const lfo = add(context.createOscillator());
      if (periodicWave) lfo.setPeriodicWave(periodicWave);
      else lfo.type = type;
      lfo.frequency.value = frequency;
      const depthNode = add(context.createGain());
      depthNode.gain.value = depth;
      lfo.connect(depthNode);
      depthNode.connect(carrier.gain);
      return { carrier, lfo, depth: depthNode };
    },

    /** Starts every source created so far. */
    start(time) {
      for (const source of sources) {
        if (startOffsets.has(source)) source.start(time, startOffsets.get(source));
        else source.start(time);
      }
    },

    get stopped() {
      return stopped;
    },

    /** How many nodes the scaffold owns (every one is disconnected once stop() has finished). */
    get nodeCount() {
      return nodes.length;
    },

    /**
     * Fades out over fadeSeconds, then stops and disconnects everything. onReleased (optional) is
     * called once every node has been disconnected.
     */
    stop(time, fadeSeconds = 0.35, onReleased = null) {
      if (stopped) return;
      stopped = true;
      holdAt(output.gain, time);
      output.gain.setTargetAtTime(0, time, fadeSeconds / 4);
      const end = time + fadeSeconds + 0.05;
      const release = () => {
        for (const node of nodes) node.disconnect();
        if (onReleased) onReleased();
      };
      if (sources.length === 0) {
        release();
        return;
      }
      for (const source of sources) source.stop(end);
      sources[sources.length - 1].onended = release;
    },
  };
}
