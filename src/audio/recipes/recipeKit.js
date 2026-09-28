// Building blocks shared by the spawn recipes (recipes/*.js).
//
// A recipe builds its synth from a kit handed to it by the spawn voice (spawnVoices.js):
//   { context, noise, scaffold, out, pitched(node), trackOneShot(nodes, endSource) }
// Every node goes through the scaffold, so the voice can fade the synth and release every node at
// once. out is the voice's input (the scaffold's output gain). pitched(node) connects the voice's
// doppler signal (cents) to node.detune: sources and filters registered this way follow the
// doppler shift together, as the whole spectrum of a real moving source would.
//
// The helpers here create nodes only when a recipe is built (when a voice becomes audible), never
// in the per-update paths. Envelope helpers schedule automation on nodes that already exist.
import { holdAt } from '../synthKit.js';

/**
 * Crackle transfer curve: a symmetric dead zone that only lets the peaks of a slow random signal
 * through, squared. Driven harder, more peaks cross it and the crackle gets denser.
 */
const CRACKLE_CURVE = (() => {
  const size = 1025;
  const curve = new Float32Array(size);
  const threshold = 0.45;
  for (let index = 0; index < size; index++) {
    const x = (index / (size - 1)) * 2 - 1;
    const excess = Math.max(0, Math.abs(x) - threshold) / (1 - threshold);
    curve[index] = excess * excess;
  }
  return curve;
})();

/**
 * A looping noise layer: noise tap -> filter -> gain -> destination. The tap and the filter follow
 * the doppler. Returns { source, filter, gain }.
 */
export function noiseBand(kit, { rate = 1, type = 'lowpass', frequency = 1000, q = 0.7, level = 0, destination = kit.out }) {
  const source = kit.pitched(kit.scaffold.noise(kit.noise, rate));
  const filter = kit.pitched(kit.scaffold.filter(type, frequency, q));
  const gain = kit.scaffold.gain(level);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  return { source, filter, gain };
}

/**
 * A sparse random pulse train (0..1) for crackle, rattle, bubbling and chatter: a slow noise tap,
 * low-passed at cutoff Hz, driven into the crackle curve. drive.gain sets the density (about 1.3
 * sparse, 2 regular, 3 dense). Connect output to a GainNode's gain whose own value is 0 so the
 * pulses gate a carrier. Returns { source, filter, drive, output }.
 */
export function crackle(kit, { rate = 0.15, cutoff = 30, drive = 2 }) {
  const { scaffold } = kit;
  const source = scaffold.noise(kit.noise, rate);
  const filter = scaffold.filter('lowpass', cutoff, 0.7);
  const driveGain = scaffold.gain(drive);
  const shaper = scaffold.add(kit.context.createWaveShaper());
  shaper.curve = CRACKLE_CURVE;
  source.connect(filter);
  filter.connect(driveGain);
  driveGain.connect(shaper);
  return { source, filter, drive: driveGain, output: shaper };
}

/**
 * A carrier gated by a crackle: noiseBand -> gate (gain 0, opened by the pulses) -> level ->
 * destination. Returns { band, gate, level, crackle }.
 */
export function crackleBand(kit, { rate = 1, type = 'bandpass', frequency = 2000, q = 0.9, level = 0, crackleRate = 0.15, cutoff = 30, drive = 2, destination = kit.out }) {
  const gate = kit.scaffold.gain(0);
  const levelGain = kit.scaffold.gain(level);
  const band = noiseBand(kit, { rate, type, frequency, q, level: 1, destination: gate });
  const pulses = crackle(kit, { rate: crackleRate, cutoff, drive });
  pulses.output.connect(gate.gain);
  gate.connect(levelGain);
  levelGain.connect(destination);
  return { band, gate, level: levelGain, crackle: pulses };
}

/** A slow LFO added to an AudioParam: param += depth * sine(frequency). Returns { lfo, depth }. */
export function wobble(kit, parameter, depth, frequency, type = 'sine') {
  const lfo = kit.scaffold.oscillator(type, frequency);
  const depthGain = kit.scaffold.gain(depth);
  lfo.connect(depthGain);
  depthGain.connect(parameter);
  return { lfo, depth: depthGain };
}

/**
 * A struck envelope from wherever the parameter is now: a linear attack to peak, then an
 * exponential decay (time constant decay / 4, so it is ~98 % down after decay seconds).
 */
export function strike(parameter, time, peak, attack, decay) {
  holdAt(parameter, time);
  parameter.linearRampToValueAtTime(peak, time + attack);
  parameter.setTargetAtTime(0, time + attack, decay / 4);
}

/**
 * A swelled envelope: rises to peak with time constant attack / 3, holds for hold seconds, then
 * releases with time constant release / 4. Starts from the current value (no click on retrigger).
 */
export function swell(parameter, time, peak, attack, hold, release) {
  holdAt(parameter, time);
  parameter.setTargetAtTime(peak, time, attack / 3);
  parameter.setTargetAtTime(0, time + attack + hold, release / 4);
}

/** A frequency sweep: from start to end (both > 0) over seconds, exponentially. */
export function sweep(parameter, time, start, end, seconds) {
  holdAt(parameter, time);
  parameter.setValueAtTime(start, time);
  parameter.exponentialRampToValueAtTime(end, time + seconds);
}

/** Option number: options[key] when finite, else fallback, clamped to [min, max]. */
export function option(options, key, fallback, min, max) {
  const value = options && Number.isFinite(options[key]) ? options[key] : fallback;
  return Math.min(Math.max(value, min), max);
}
