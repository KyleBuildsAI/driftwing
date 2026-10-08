// 'paraglider' family: no engine, the wing and the air around an open harness. The variometer is the
// shared flight cue (flightCues.js, audioProfile.vario), so climbing in a thermal beeps as on a real
// paraglider vario.
//
//   flutter   the canopy's trailing edge and cells flapping: band-passed noise chopped by a ragged
//             low-frequency wave at flutterHz (at trim, rising with airspeed); folded fabric (big ears,
//             a collapse) flaps louder, faster and lower
//   rush      the wind past the helmet in the open harness, rising with airspeed
//   lines     a thin whistle of the lines that comes in on the speed bar
//   snap      a short slap of fabric when a side collapses and a softer pop when it reinflates
// The wing is silent while it lies deflated on the ground (state.flight.craftState.inflation).
import { clamp } from '../../core/util.js';
import { approach, createScaffold, glide } from '../synthKit.js';

/** A ragged flapping wave: a few inharmonic-ish partials give an uneven fabric chop. */
function createFlapWave(context) {
  const real = new Float32Array([0, 0.25, 0.5, 0.2, 0.3, 0.12, 0.16, 0.06, 0.08]);
  const imaginary = new Float32Array([0, 1, 0.3, 0.45, 0.15, 0.2, 0.08, 0.09, 0.05]);
  return context.createPeriodicWave(real, imaginary);
}

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createParagliderSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const flapWave = createFlapWave(context);

  const flutterNoise = synth.noise(noise, 0.9);
  const flutterFilter = synth.filter('bandpass', 240, 1.2);
  const flutter = synth.modulated(0.3, 0.7, 3, 'sine', flapWave);
  const flutterLevel = synth.gain(0);
  flutterNoise.connect(flutterFilter);
  flutterFilter.connect(flutter.carrier);
  flutter.carrier.connect(flutterLevel);
  flutterLevel.connect(synth.output);

  const rushNoise = synth.noise(noise, 1.25);
  const rushFilter = synth.filter('highpass', 1300, 0.6);
  const rushPeak = synth.filter('peaking', 3600, 1);
  rushPeak.gain.value = 3;
  const rushLevel = synth.gain(0);
  rushNoise.connect(rushFilter);
  rushFilter.connect(rushPeak);
  rushPeak.connect(rushLevel);
  rushLevel.connect(synth.output);

  const lineNoise = synth.noise(noise, 1.6);
  const lineFilter = synth.filter('bandpass', 1500, 18);
  const lineLevel = synth.gain(0);
  lineNoise.connect(lineFilter);
  lineFilter.connect(lineLevel);
  lineLevel.connect(synth.output);

  const snapNoise = synth.noise(noise, 0.7);
  const snapFilter = synth.filter('lowpass', 900, 0.9);
  const snapLevel = synth.gain(0);
  snapNoise.connect(snapFilter);
  snapFilter.connect(snapLevel);
  snapLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);
  const memory = { collapse: 0, snap: 0, folded: 0 };
  const readout = { speedRatio: 0, flutterRate: 0, folded: 0, bar: 0, snap: 0, inflation: 1, level: 0 };

  return {
    family: 'paraglider',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const craftState = flight.craftState || {};
      const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
      const speedRatio = clamp(airspeed / 10.5, 0, 2.5);
      const inflation = clamp(Number.isFinite(craftState.inflation) ? craftState.inflation : 1, 0, 1);
      const collapse = craftState.collapse ? Math.max(Number(craftState.collapse.left) || 0, Number(craftState.collapse.right) || 0) : 0;
      const ears = clamp(Number(craftState.earsFold) || 0, 0, 1);
      const bar = clamp(Number(craftState.speedBar) || 0, 0, 1);
      const folded = clamp(collapse * 1.4 + ears * 0.7, 0, 1);
      memory.folded = approach(memory.folded, folded, 0.15, interval);
      // A side folding fast slaps; reopening pops.
      if (collapse - memory.collapse > 0.08) memory.snap = Math.max(memory.snap, clamp((collapse - memory.collapse) * 4, 0.4, 1));
      else if (memory.collapse > 0.05 && collapse <= 0) memory.snap = Math.max(memory.snap, 0.45);
      memory.collapse = collapse;
      memory.snap = approach(memory.snap, 0, 0.12, interval);

      const ragged = 1 + 0.12 * Math.sin(time * 1.7) + 0.08 * Math.sin(time * 4.3 + 1.1);
      const flutterRate = profile.flutterHz * (0.6 + 0.4 * speedRatio) * (1 + 1.4 * memory.folded) * ragged;
      const moving = clamp((airspeed - 2) / 6, 0, 1) * inflation;
      glide(flutter.lfo.frequency, flutterRate * pitch, time, 0.1);
      glide(flutterFilter.frequency, (210 + 90 * speedRatio - 80 * memory.folded) * pitch, time, 0.15);
      glide(flutterLevel.gain, moving * (0.16 + 0.14 * speedRatio * speedRatio + 0.5 * memory.folded), time, 0.12);
      glide(rushFilter.frequency, (1100 + 700 * speedRatio) * pitch, time, 0.15);
      glide(rushLevel.gain, clamp((airspeed - 3) / 10, 0, 1) * (0.1 + 0.22 * speedRatio * speedRatio), time, 0.12);
      glide(lineFilter.frequency, (1250 + 600 * speedRatio) * pitch, time, 0.2);
      glide(lineLevel.gain, moving * bar * 0.35 * clamp(speedRatio - 0.8, 0, 1), time, 0.2);
      glide(snapLevel.gain, memory.snap * 0.9, time, 0.02);

      const level = 0.16 * profile.level;
      glide(synth.output.gain, level, time, 0.2);
      readout.speedRatio = speedRatio;
      readout.flutterRate = flutterRate;
      readout.folded = memory.folded;
      readout.bar = bar;
      readout.snap = memory.snap;
      readout.inflation = inflation;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.4);
    },
    describe() {
      return {
        family: 'paraglider',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { flutter: flutter.lfo.frequency.value, lines: lineFilter.frequency.value },
        layers: { flutter: flutterLevel.gain.value, rush: rushLevel.gain.value, lines: lineLevel.gain.value, snap: snapLevel.gain.value },
      };
    },
  };
}
