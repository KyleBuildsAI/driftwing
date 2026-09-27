// 'heli' engine family: a light turbine helicopter.
//
// Rotor speed is state.flight.rotorRpm (1 = governed); a model that leaves it at 0 while the
// engine runs is treated as governed. Voices:
//   slap      band-passed noise amplitude-modulated by a pulse train at the main-rotor blade-pass
//             frequency (blades * rotorRpm / 60): the "wop wop". It hardens with torque and with
//             blade-vortex interaction when descending slowly
//   thump     the same pulse train low-passed: the chest-felt beat of each blade
//   tail      the tail rotor's faster buzz
//   turbine   the engine's whine and hiss, which spools down when engineOn is false while the rotor
//             keeps turning (autorotation)
import { clamp } from '../../core/util.js';
import { approach, createPulseWave, createScaffold, glide } from '../synthKit.js';

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createHeliSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const pulse = createPulseWave(context, 14);

  const slapNoise = synth.noise(noise, 0.9);
  const slapFilter = synth.filter('bandpass', 520, 1.1);
  const slap = synth.modulated(0.04, 1, 13, 'sine', pulse);
  const slapLevel = synth.gain(0);
  slapNoise.connect(slapFilter);
  slapFilter.connect(slap.carrier);
  slap.carrier.connect(slapLevel);
  slapLevel.connect(synth.output);

  const thumpSource = synth.oscillator('sine', 13, pulse);
  const thumpFilter = synth.filter('lowpass', 110, 1.4);
  const thumpLevel = synth.gain(0);
  thumpSource.connect(thumpFilter);
  thumpFilter.connect(thumpLevel);
  thumpLevel.connect(synth.output);

  const tail = synth.oscillator('sawtooth', 70);
  const tailFilter = synth.filter('bandpass', 300, 2);
  const tailLevel = synth.gain(0);
  tail.connect(tailFilter);
  tailFilter.connect(tailLevel);
  tailLevel.connect(synth.output);

  const turbineA = synth.oscillator('sine', 5000);
  const turbineB = synth.oscillator('sine', 3350);
  const turbineBLevel = synth.gain(0.5);
  const turbineLevel = synth.gain(0);
  turbineA.connect(turbineLevel);
  turbineB.connect(turbineBLevel);
  turbineBLevel.connect(turbineLevel);
  const turbineHiss = synth.noise(noise, 1.2);
  const turbineHissFilter = synth.filter('bandpass', 2600, 2.5);
  const turbineHissLevel = synth.gain(0);
  turbineHiss.connect(turbineHissFilter);
  turbineHissFilter.connect(turbineHissLevel);
  turbineLevel.connect(synth.output);
  turbineHissLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  const blades = clamp(Math.round(profile.blades), 2, 8);
  const tailBlades = clamp(Math.round(profile.tailBlades), 2, 8);
  let rotor = 0;
  let turbine = 0;
  const readout = { rotor: 0, turbine: 0, bladePassHz: 0, tailHz: 0, slap: 0, level: 0 };

  return {
    family: 'heli',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const running = flight.engineOn !== false;
      const reportedRotor = Number.isFinite(flight.rotorRpm) ? flight.rotorRpm : 0;
      const rotorTarget = reportedRotor > 0 ? reportedRotor : running ? 1 : 0;
      rotor = approach(rotor, clamp(rotorTarget, 0, 1.2), 0.25, interval);
      turbine = approach(turbine, running ? 1 : 0, running ? 1.2 : 2.5, interval);
      const torque = clamp(Number.isFinite(flight.torque) && flight.torque > 0 ? flight.torque : clamp(flight.throttle ?? 0.5, 0, 1), 0, 1.3);
      const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
      const sink = -(Number.isFinite(flight.verticalSpeed) ? flight.verticalSpeed : 0);
      // Blade-vortex interaction: descending into the rotor's own wake at low speed.
      const vortex = clamp((sink - 1.5) / 4, 0, 1) * clamp(1 - airspeed / 35, 0, 1);
      const rotorHz = (profile.rotorRpm / 60) * rotor;
      const bladePassHz = blades * rotorHz;
      const tailHz = tailBlades * rotorHz * profile.tailRatio;
      const slapAmount = rotor * (0.35 + 0.45 * torque + 0.6 * vortex + 0.15 * clamp(airspeed / 60, 0, 1));

      glide(slap.lfo.frequency, bladePassHz * pitch, time, 0.05);
      glide(thumpSource.frequency, bladePassHz * pitch, time, 0.05);
      glide(slapFilter.frequency, (420 + 380 * torque + 500 * vortex) * pitch, time, 0.1);
      glide(slapLevel.gain, 0.5 * slapAmount, time, 0.08);
      glide(thumpLevel.gain, 0.5 * rotor * (0.6 + 0.4 * torque), time, 0.1);
      glide(tail.frequency, tailHz * pitch, time, 0.05);
      glide(tailFilter.frequency, Math.max(tailHz * 4, 200) * pitch, time, 0.1);
      glide(tailLevel.gain, 0.09 * rotor, time, 0.1);
      glide(turbineA.frequency, profile.turbineHz * (0.25 + 0.75 * turbine) * pitch, time, 0.1);
      glide(turbineB.frequency, profile.turbineHz * 0.67 * (0.25 + 0.75 * turbine) * pitch, time, 0.1);
      glide(turbineLevel.gain, 0.03 * turbine * (frame.interior ? 1.4 : 0.8), time, 0.12);
      glide(turbineHissLevel.gain, 0.22 * turbine, time, 0.12);

      const level = rotor < 0.03 && turbine < 0.03 ? 0 : 0.14 * Math.min(1, Math.max(rotor, turbine) * 2) * profile.level;
      glide(synth.output.gain, level, time, 0.15);
      readout.rotor = rotor;
      readout.turbine = turbine;
      readout.bladePassHz = bladePassHz;
      readout.tailHz = tailHz;
      readout.slap = slapAmount;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.6);
    },
    describe() {
      return {
        family: 'heli',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { bladePass: slap.lfo.frequency.value, tail: tail.frequency.value, turbine: turbineA.frequency.value },
      };
    },
  };
}
