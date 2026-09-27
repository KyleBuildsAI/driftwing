// 'wingsuit' family: no engine, the suit itself.
//
//   flutter   fabric flapping: band-passed noise chopped by a ragged low-frequency wave whose rate
//             rises with airspeed (flutterHz at 40 m/s), plus a thinner high layer
//   rush      the wind tearing past the helmet, rising with airspeed and sharply with terrain
//             proximity (state.flight.agl inside proximityRange metres)
//   ground    a low roar of air compressed between suit and terrain when skimming it
//   warning   an audible-altimeter style chirp while the SIM terrain proximity warning is on
//             (state.flight.craftState.proximityWarning, an assist that is off at 0 %)
// With a canopy open (state.flight.craftState.canopy) the flutter becomes the slow luffing of the
// parachute and the rush falls away with the speed.
import { clamp } from '../../core/util.js';
import { approach, createScaffold, glide } from '../synthKit.js';

/** A ragged flapping wave: a few inharmonic-ish partials give an uneven fabric chop. */
function createFlapWave(context) {
  const real = new Float32Array([0, 0.2, 0.55, 0.15, 0.3, 0.1, 0.18, 0.05, 0.09]);
  const imaginary = new Float32Array([0, 1, 0.35, 0.5, 0.12, 0.22, 0.06, 0.1, 0.04]);
  return context.createPeriodicWave(real, imaginary);
}

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createWingsuitSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const flapWave = createFlapWave(context);

  const flutterNoise = synth.noise(noise, 1);
  const flutterFilter = synth.filter('bandpass', 260, 1.4);
  const flutter = synth.modulated(0.25, 0.75, 14, 'sine', flapWave);
  const flutterLevel = synth.gain(0);
  flutterNoise.connect(flutterFilter);
  flutterFilter.connect(flutter.carrier);
  flutter.carrier.connect(flutterLevel);
  flutterLevel.connect(synth.output);

  const snapNoise = synth.noise(noise, 1.2);
  const snapFilter = synth.filter('highpass', 1100, 0.8);
  const snap = synth.modulated(0.1, 0.9, 27, 'sine', flapWave);
  const snapLevel = synth.gain(0);
  snapNoise.connect(snapFilter);
  snapFilter.connect(snap.carrier);
  snap.carrier.connect(snapLevel);
  snapLevel.connect(synth.output);

  const rushNoise = synth.noise(noise, 1.3);
  const rushFilter = synth.filter('highpass', 1800, 0.6);
  const rushPeak = synth.filter('peaking', 4200, 1);
  rushPeak.gain.value = 4;
  const rushLevel = synth.gain(0);
  rushNoise.connect(rushFilter);
  rushFilter.connect(rushPeak);
  rushPeak.connect(rushLevel);
  rushLevel.connect(synth.output);

  const groundNoise = synth.noise(noise, 0.7);
  const groundFilter = synth.filter('bandpass', 380, 0.8);
  const groundLevel = synth.gain(0);
  groundNoise.connect(groundFilter);
  groundFilter.connect(groundLevel);
  groundLevel.connect(synth.output);

  const warningTone = synth.oscillator('square', 2100);
  const warningFilter = synth.filter('lowpass', 3200, 0.7);
  const warningGate = synth.modulated(0.5, 0.5, 7.5, 'square');
  const warningLevel = synth.gain(0);
  warningTone.connect(warningFilter);
  warningFilter.connect(warningGate.carrier);
  warningGate.carrier.connect(warningLevel);
  warningLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);
  let proximity = 0;
  let rateJitter = 0;
  const readout = { speedRatio: 0, proximity: 0, flutterRate: 0, canopy: false, warning: false, level: 0 };

  return {
    family: 'wingsuit',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
      const speedRatio = clamp(airspeed / 40, 0, 2);
      const agl = Number.isFinite(flight.agl) ? flight.agl : Infinity;
      const range = Math.max(profile.proximityRange, 5);
      const rawProximity = flight.onGround ? 0 : Math.pow(clamp(1 - agl / range, 0, 1), 1.6);
      proximity = approach(proximity, rawProximity, 0.15, interval);
      const canopy = Boolean(flight.craftState && flight.craftState.canopy);
      rateJitter += ((Math.random() - 0.5) * 0.25 - rateJitter) * 0.25;
      const flutterRate = canopy
        ? (1.6 + 1.2 * speedRatio) * (1 + rateJitter)
        : profile.flutterHz * (0.55 + 0.45 * speedRatio) * (1 + rateJitter);
      const moving = clamp((airspeed - 3) / 12, 0, 1);

      glide(flutter.lfo.frequency, flutterRate * pitch, time, 0.1);
      glide(snap.lfo.frequency, flutterRate * 1.9 * pitch, time, 0.1);
      glide(flutterFilter.frequency, (canopy ? 160 : 200 + 180 * speedRatio) * pitch, time, 0.15);
      glide(flutterLevel.gain, moving * (canopy ? 0.35 : 0.22 + 0.4 * speedRatio * speedRatio), time, 0.12);
      glide(snapLevel.gain, moving * (canopy ? 0.04 : 0.05 + 0.12 * speedRatio), time, 0.12);
      glide(rushFilter.frequency, (1400 + 1200 * speedRatio) * pitch, time, 0.15);
      glide(rushLevel.gain, moving * (0.12 + 0.5 * speedRatio * speedRatio) * (1 + 2.2 * proximity), time, 0.1);
      glide(groundLevel.gain, 0.6 * proximity * clamp(speedRatio, 0, 1.5), time, 0.1);
      glide(groundFilter.frequency, (260 + 420 * proximity) * pitch, time, 0.15);
      const warning = Boolean(flight.craftState && flight.craftState.proximityWarning === true);
      glide(warningLevel.gain, warning ? 0.5 : 0, time, 0.03);

      const level = 0.12 * profile.level;
      glide(synth.output.gain, level, time, 0.2);
      readout.speedRatio = speedRatio;
      readout.proximity = proximity;
      readout.flutterRate = flutterRate;
      readout.canopy = canopy;
      readout.warning = warning;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.4);
    },
    describe() {
      return {
        family: 'wingsuit',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { flutter: flutter.lfo.frequency.value },
        layers: { flutter: flutterLevel.gain.value, rush: rushLevel.gain.value, ground: groundLevel.gain.value, warning: warningLevel.gain.value },
      };
    },
  };
}
