// 'proprotor' engine family: a tiltrotor's two big proprotors and their turboshafts.
//
// Rotor speed is state.flight.rotorRpm (1 = the scheduled governed speed) times the craft's
// scheduled rpm (state.flight.craftState.proprotorRpm when the model reports it, else
// profile.rotorRpm); the nacelle angle is state.flight.craftState.nacelleAngle (0 airplane mode,
// 90 helicopter mode). The character follows the nacelles:
//   thrum     band-passed noise amplitude-modulated by a pulse train at the blade-pass frequency
//             (blades * rpm / 60): with the nacelles up the discs push their wake down past the wing
//             and the beat is a deep, impulsive slap that hardens with torque and when descending
//             into the wake; tilted forward the modulation smooths out into a steady drone
//   beat      a second pulse train a fraction of a hertz off the first (the two rotors are never
//             exactly in phase): the slow throb of a tiltrotor
//   drone     the blade-pass buzz and its harmonics through a band-pass, rising as the nacelles come
//             down and with airspeed (the airplane-mode propeller note)
//   turbine   the engines' whine and hiss, spooling down when engineOn is false
import { clamp } from '../../core/util.js';
import { approach, createPulseWave, createScaffold, glide, smoothstep } from '../synthKit.js';

/** Beat between the two rotors (Hz). */
const ROTOR_BEAT_HZ = 0.35;

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createProprotorSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const pulse = createPulseWave(context, 12);

  const thrumNoise = synth.noise(noise, 0.8);
  const thrumFilter = synth.filter('bandpass', 380, 1.2);
  const thrum = synth.modulated(0.05, 1, 20, 'sine', pulse);
  const thrumLevel = synth.gain(0);
  thrumNoise.connect(thrumFilter);
  thrumFilter.connect(thrum.carrier);
  thrum.carrier.connect(thrumLevel);
  thrumLevel.connect(synth.output);

  const beatSource = synth.oscillator('sine', 20, pulse);
  const beatFilter = synth.filter('lowpass', 95, 1.3);
  const beatLevel = synth.gain(0);
  beatSource.connect(beatFilter);
  beatFilter.connect(beatLevel);
  beatLevel.connect(synth.output);

  const drone = synth.oscillator('sawtooth', 20);
  const droneFilter = synth.filter('bandpass', 160, 1.6);
  const droneLevel = synth.gain(0);
  drone.connect(droneFilter);
  droneFilter.connect(droneLevel);
  droneLevel.connect(synth.output);

  const turbineA = synth.oscillator('sine', 4300);
  const turbineB = synth.oscillator('sine', 2900);
  const turbineBLevel = synth.gain(0.55);
  const turbineLevel = synth.gain(0);
  turbineA.connect(turbineLevel);
  turbineB.connect(turbineBLevel);
  turbineBLevel.connect(turbineLevel);
  const turbineHiss = synth.noise(noise, 1.1);
  const turbineHissFilter = synth.filter('bandpass', 2300, 2.2);
  const turbineHissLevel = synth.gain(0);
  turbineHiss.connect(turbineHissFilter);
  turbineHissFilter.connect(turbineHissLevel);
  turbineLevel.connect(synth.output);
  turbineHissLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  const blades = clamp(Math.round(profile.blades), 2, 8);
  let rotor = 0;
  let turbine = 0;
  let nacelle = 90;
  const readout = { rotor: 0, turbine: 0, nacelle: 90, bladePassHz: 0, slap: 0, drone: 0, level: 0 };

  return {
    family: 'proprotor',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const craftState = flight.craftState ?? {};
      const running = flight.engineOn !== false;
      const reportedRotor = Number.isFinite(flight.rotorRpm) ? flight.rotorRpm : 0;
      const rotorTarget = reportedRotor > 0 ? reportedRotor : running ? 1 : 0;
      rotor = approach(rotor, clamp(rotorTarget, 0, 1.3), 0.25, interval);
      turbine = approach(turbine, running ? 1 : 0, running ? 1.4 : 2.8, interval);
      nacelle = approach(nacelle, clamp(Number.isFinite(craftState.nacelleAngle) ? craftState.nacelleAngle : 90, 0, 97), 0.2, interval);
      // The scheduled rpm (84 % in airplane mode) times the share of it the rotor turns at.
      const scheduledRpm = Number.isFinite(craftState.proprotorRpm) && reportedRotor > 0.05 ? craftState.proprotorRpm / reportedRotor : profile.rotorRpm;
      const rotorHz = (scheduledRpm / 60) * rotor;
      const bladePassHz = blades * rotorHz;
      const torque = clamp(Number.isFinite(flight.torque) && flight.torque > 0 ? flight.torque : clamp(flight.throttle ?? 0.5, 0, 1), 0, 1.3);
      const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
      const sink = -(Number.isFinite(flight.verticalSpeed) ? flight.verticalSpeed : 0);
      // Helicopter mode with the nacelles up, airplane mode with them forward.
      const hover = smoothstep(15, 80, nacelle);
      const vortex = clamp((sink - 2) / 5, 0, 1) * clamp(1 - airspeed / 40, 0, 1) * hover;
      const slapAmount = rotor * hover * (0.4 + 0.45 * torque + 0.6 * vortex);
      const droneAmount = rotor * (1 - hover * 0.75) * (0.35 + 0.4 * torque + 0.25 * clamp(airspeed / 120, 0, 1));
      const overspeed = clamp((rotorTarget - 1.03) / 0.1, 0, 1);

      glide(thrum.lfo.frequency, bladePassHz * pitch, time, 0.05);
      // Impulsive in the hover, smoothing toward a steady tone as the nacelles come down.
      glide(thrum.depth.gain, 0.3 + 0.7 * hover, time, 0.2);
      glide(thrumFilter.frequency, (300 + 280 * torque + 420 * vortex + 260 * (1 - hover)) * pitch, time, 0.1);
      glide(thrumLevel.gain, 0.45 * (slapAmount + 0.25 * rotor * (1 - hover)), time, 0.08);
      glide(beatSource.frequency, (bladePassHz + ROTOR_BEAT_HZ) * pitch, time, 0.05);
      glide(beatLevel.gain, 0.42 * rotor * (0.5 + 0.5 * torque) * (0.55 + 0.45 * hover), time, 0.1);
      glide(drone.frequency, bladePassHz * (1 + 0.04 * overspeed) * pitch, time, 0.05);
      glide(droneFilter.frequency, Math.max(bladePassHz * (5 + 4 * (1 - hover)), 90) * pitch, time, 0.1);
      glide(droneLevel.gain, 0.14 * droneAmount * (1 + 0.6 * overspeed), time, 0.1);
      glide(turbineA.frequency, profile.turbineHz * (0.25 + 0.75 * turbine) * pitch, time, 0.1);
      glide(turbineB.frequency, profile.turbineHz * 0.67 * (0.25 + 0.75 * turbine) * pitch, time, 0.1);
      glide(turbineLevel.gain, 0.028 * turbine * (frame.interior ? 1.5 : 0.8), time, 0.12);
      glide(turbineHissLevel.gain, 0.2 * turbine * (0.6 + 0.4 * torque), time, 0.12);

      const level = rotor < 0.03 && turbine < 0.03 ? 0 : 0.15 * Math.min(1, Math.max(rotor, turbine) * 2) * profile.level;
      glide(synth.output.gain, level, time, 0.15);
      readout.rotor = rotor;
      readout.turbine = turbine;
      readout.nacelle = nacelle;
      readout.bladePassHz = bladePassHz;
      readout.slap = slapAmount;
      readout.drone = droneAmount;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.6);
    },
    describe() {
      return {
        family: 'proprotor',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { bladePass: thrum.lfo.frequency.value, drone: drone.frequency.value, turbine: turbineA.frequency.value },
      };
    },
  };
}
