// 'prop' engine family: a piston engine and propeller driven by RPM.
//
// The engine speed follows state.flight.rpm (0..1 of maxRpm, never below idleRpm while running,
// spinning down when engineOn is false). Voices:
//   exhaust   sawtooth at the firing frequency (cylinders * rpm / 120, four-stroke) plus a crank
//             sub-harmonic and a second harmonic, through a resonant low-pass that opens with load
//   pops      noise pulsed at the firing frequency: the individual exhaust beats
//   prop      the blade-pass buzz (blades * rpm / 60) and a tip rasp that grows with rpm
import { clamp } from '../../core/util.js';
import { approach, createPulseWave, createScaffold, glide } from '../synthKit.js';

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createPropSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const pulse = createPulseWave(context, 8);

  const exhaustFilter = synth.filter('lowpass', 600, 3);
  const exhaust = synth.oscillator('sawtooth', 90);
  const exhaustLevel = synth.gain(0.5);
  const crank = synth.oscillator('square', 45);
  const crankLevel = synth.gain(0.2);
  const harmonic = synth.oscillator('triangle', 180);
  const harmonicLevel = synth.gain(0.12);
  exhaust.connect(exhaustLevel);
  exhaustLevel.connect(exhaustFilter);
  crank.connect(crankLevel);
  crankLevel.connect(exhaustFilter);
  harmonic.connect(harmonicLevel);
  harmonicLevel.connect(exhaustFilter);
  const bodyLevel = synth.gain(1);
  exhaustFilter.connect(bodyLevel);
  bodyLevel.connect(synth.output);

  const popNoise = synth.noise(noise, 1);
  const popFilter = synth.filter('bandpass', 450, 1.2);
  const pops = synth.modulated(0.15, 0.85, 90, 'sine', pulse);
  const popLevel = synth.gain(0.4);
  popNoise.connect(popFilter);
  popFilter.connect(pops.carrier);
  pops.carrier.connect(popLevel);
  popLevel.connect(synth.output);

  const blade = synth.oscillator('sawtooth', 90);
  const bladeFilter = synth.filter('bandpass', 270, 4);
  const bladeLevel = synth.gain(0.1);
  blade.connect(bladeFilter);
  bladeFilter.connect(bladeLevel);
  bladeLevel.connect(synth.output);

  const raspNoise = synth.noise(noise, 1.1);
  const raspFilter = synth.filter('highpass', 2200, 0.7);
  const rasp = synth.modulated(0.3, 0.7, 90, 'sine', pulse);
  const raspLevel = synth.gain(0);
  raspNoise.connect(raspFilter);
  raspFilter.connect(rasp.carrier);
  rasp.carrier.connect(raspLevel);
  raspLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  const cylinders = clamp(Math.round(profile.cylinders), 1, 18);
  const blades = clamp(Math.round(profile.blades), 2, 8);
  const maxRpm = Math.max(profile.maxRpm, 500);
  const idleRpm = clamp(profile.idleRpm, 200, maxRpm);
  let engineRpm = 0;
  const readout = { engineRpm: 0, firingHz: 0, bladeHz: 0, level: 0 };

  return {
    family: 'prop',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const running = flight.engineOn !== false;
      const rpmFraction = clamp(Number.isFinite(flight.rpm) ? flight.rpm : 0, 0, 1.15);
      const target = running ? Math.max(idleRpm, maxRpm * rpmFraction) : 0;
      engineRpm = approach(engineRpm, target, target > engineRpm ? 0.35 : running ? 0.6 : 1.6, interval);
      const load = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
      const spin = engineRpm / maxRpm;
      const firingHz = (cylinders * engineRpm) / 120;
      const bladeHz = (blades * engineRpm) / 60;
      const airflow = clamp((Number.isFinite(flight.airspeed) ? flight.airspeed : 0) / 60, 0, 1.5);

      glide(exhaust.frequency, firingHz * pitch, time, 0.06);
      glide(crank.frequency, firingHz * 0.5 * pitch, time, 0.06);
      glide(harmonic.frequency, firingHz * 2 * pitch, time, 0.06);
      glide(exhaustFilter.frequency, (220 + 1500 * load + 2.5 * firingHz) * pitch, time, 0.1);
      glide(pops.lfo.frequency, firingHz * pitch, time, 0.06);
      glide(popFilter.frequency, (320 + 3 * firingHz) * pitch, time, 0.1);
      glide(popLevel.gain, 0.25 + 0.45 * load, time, 0.1);
      glide(blade.frequency, bladeHz * pitch, time, 0.06);
      glide(bladeFilter.frequency, bladeHz * 3 * pitch, time, 0.1);
      glide(bladeLevel.gain, 0.06 + 0.22 * load + 0.08 * airflow, time, 0.1);
      glide(rasp.lfo.frequency, bladeHz * pitch, time, 0.06);
      glide(raspLevel.gain, 0.25 * spin * spin * (0.4 + 0.6 * load), time, 0.1);

      const level = spin < 0.04 ? 0 : (0.035 + 0.075 * load) * Math.min(1, spin * 3) * profile.level;
      glide(synth.output.gain, level, time, 0.12);
      readout.engineRpm = engineRpm;
      readout.firingHz = firingHz;
      readout.bladeHz = bladeHz;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time);
    },
    describe() {
      return {
        family: 'prop',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { exhaust: exhaust.frequency.value, crank: crank.frequency.value, blade: blade.frequency.value, pops: pops.lfo.frequency.value },
      };
    },
  };
}
