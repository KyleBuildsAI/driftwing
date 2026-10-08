// 'burner' family: the hot air balloon. It drifts with the wind, so the airflow beds stay quiet and
// almost everything you hear is the balloon itself:
//
//   roar     the burner: broadband combustion noise with a low rumble and the hiss of the propane
//            jet, a ragged flutter in the flame, rising with state.flight.craftState.burner (the
//            flame, 0..1); a short whump as it lights
//   pilot    the pilot lights' faint hiss, heard in the basket when the burner is quiet
//   vent     hot air rushing out of the crown while the parachute vent is open (craftState.vent),
//            distant: the vent is twenty metres overhead
//   creak    the wicker basket and its suspension creaking as the load changes: a blast kicks the
//            envelope, the rig swings (state.flight.angularVelocity), the basket touches down or
//            drags along the ground. Each creak is a short resonant burst with its own pitch
//
// Otherwise near silence. Parameters: roarHz (the rumble's centre), creakRate (creaks per second at a
// strong swing), level.
import { clamp } from '../../core/util.js';
import { approach, createScaffold, glide, holdAt } from '../synthKit.js';

/** A blast kick, a swing past this tilt rate (rad/s) or a load change past this (g) creaks the basket. */
const SWING_RATE = 0.025;
const LOAD_STEP = 0.035;
const CREAK_COOLDOWN = 0.18;
const DRAG_CREAK_SPEED = 0.6;

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createBurnerSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);

  const roarNoise = synth.noise(noise, 0.85);
  const roarBody = synth.filter('lowpass', 1500, 0.6);
  const roarPeak = synth.filter('peaking', profile.roarHz, 0.9);
  roarPeak.gain.value = 7;
  const flutter = synth.modulated(0.78, 0.22, 11, 'sawtooth');
  const roarLevel = synth.gain(0);
  roarNoise.connect(roarBody);
  roarBody.connect(roarPeak);
  roarPeak.connect(flutter.carrier);
  flutter.carrier.connect(roarLevel);
  roarLevel.connect(synth.output);

  const rumbleNoise = synth.noise(noise, 0.5);
  const rumbleFilter = synth.filter('lowpass', 150, 0.9);
  const rumbleLevel = synth.gain(0);
  rumbleNoise.connect(rumbleFilter);
  rumbleFilter.connect(rumbleLevel);
  rumbleLevel.connect(synth.output);

  const jetNoise = synth.noise(noise, 1.4);
  const jetFilter = synth.filter('highpass', 2600, 0.7);
  const jetLevel = synth.gain(0);
  jetNoise.connect(jetFilter);
  jetFilter.connect(jetLevel);
  jetLevel.connect(synth.output);

  // The whump of the burner lighting: a short low thud.
  const whumpNoise = synth.noise(noise, 0.4);
  const whumpFilter = synth.filter('lowpass', 110, 1.2);
  const whumpGate = synth.gain(0);
  whumpNoise.connect(whumpFilter);
  whumpFilter.connect(whumpGate);
  whumpGate.connect(synth.output);

  const pilotNoise = synth.noise(noise, 1.1);
  const pilotFilter = synth.filter('bandpass', 3600, 3);
  const pilotLevel = synth.gain(0);
  pilotNoise.connect(pilotFilter);
  pilotFilter.connect(pilotLevel);
  pilotLevel.connect(synth.output);

  const ventNoise = synth.noise(noise, 0.7);
  const ventFilter = synth.filter('bandpass', 650, 0.8);
  const ventLevel = synth.gain(0);
  ventNoise.connect(ventFilter);
  ventFilter.connect(ventLevel);
  ventLevel.connect(synth.output);

  // Creaks: a buzzy low tone and a grain of noise through a narrow resonance, gated per creak.
  const creakTone = synth.oscillator('sawtooth', 95);
  const creakGrain = synth.noise(noise, 0.6);
  const creakFilter = synth.filter('bandpass', 820, 7);
  const creakGate = synth.gain(0);
  creakTone.connect(creakFilter);
  creakGrain.connect(creakFilter);
  creakFilter.connect(creakGate);
  creakGate.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  let flame = 0;
  let previousBurner = 0;
  let previousLoad = 1;
  let previousGround = false;
  let cooldown = 0;
  let creaks = 0;
  const readout = { burner: 0, vent: 0, swing: 0, creaks: 0, level: 0 };

  /** One creak at time: its own pitch, length and strength. */
  function creak(time, strength) {
    if (cooldown > 0) return;
    cooldown = CREAK_COOLDOWN + Math.random() * 0.25;
    creaks++;
    const pitch = 70 + Math.random() * 70;
    const length = 0.12 + Math.random() * 0.3;
    holdAt(creakTone.frequency, time);
    creakTone.frequency.setValueAtTime(pitch, time);
    creakTone.frequency.linearRampToValueAtTime(pitch * (0.8 + Math.random() * 0.15), time + length);
    holdAt(creakFilter.frequency, time);
    creakFilter.frequency.setValueAtTime(520 + Math.random() * 700, time);
    holdAt(creakGate.gain, time);
    creakGate.gain.linearRampToValueAtTime(clamp(strength, 0.05, 1) * 0.32, time + 0.025);
    creakGate.gain.setTargetAtTime(0, time + 0.03, length / 3);
  }

  return {
    family: 'burner',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const craftState = flight.craftState || {};
      const burner = clamp(Number(craftState.burner) || 0, 0, 1);
      const vent = clamp(Number(craftState.vent) || 0, 0, 1);
      flame = approach(flame, burner, 0.05, interval);
      cooldown = Math.max(0, cooldown - interval);

      glide(roarLevel.gain, 0.95 * flame, time, 0.04);
      glide(rumbleLevel.gain, 1.1 * flame, time, 0.06);
      glide(jetLevel.gain, 0.22 * flame, time, 0.03);
      glide(roarBody.frequency, (900 + 900 * flame) * pitch, time, 0.08);
      glide(flutter.lfo.frequency, (9 + 5 * Math.random()) * pitch, time, 0.05);
      glide(pilotLevel.gain, 0.025 * (1 - flame), time, 0.2);
      glide(ventLevel.gain, 0.16 * vent, time, 0.15);
      glide(ventFilter.frequency, (520 + 260 * vent) * pitch, time, 0.2);

      // Creaks: the burner lighting, the rig swinging, the load changing, the basket on the ground.
      const angular = flight.angularVelocity;
      const swing = angular ? Math.hypot(angular.x, angular.z) : 0;
      const load = Number.isFinite(flight.gLoad) ? flight.gLoad : 1;
      const onGround = flight.onGround === true;
      if (burner > 0.5 && previousBurner <= 0.5) {
        holdAt(whumpGate.gain, time);
        whumpGate.gain.linearRampToValueAtTime(1.4, time + 0.04);
        whumpGate.gain.setTargetAtTime(0, time + 0.06, 0.12);
        creak(time, 0.5);
      }
      else if (onGround && !previousGround) creak(time, 1);
      else if (Math.abs(load - previousLoad) > LOAD_STEP) creak(time, clamp(Math.abs(load - previousLoad) * 8, 0.2, 1));
      else if (swing > SWING_RATE && Math.random() < swing * profile.creakRate * interval * 40) creak(time, clamp(swing * 12, 0.15, 0.8));
      else if (onGround && flight.groundSpeed > DRAG_CREAK_SPEED && Math.random() < profile.creakRate * interval) creak(time, 0.7);
      previousBurner = burner;
      previousLoad = load;
      previousGround = onGround;

      const level = 0.3 * profile.level;
      glide(synth.output.gain, level, time, 0.2);
      readout.burner = flame;
      readout.vent = vent;
      readout.swing = swing;
      readout.creaks = creaks;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.4);
    },
    describe() {
      return {
        family: 'burner',
        target: { ...readout },
        level: synth.output.gain.value,
        frequencies: { roarHz: roarPeak.frequency.value, creak: creakTone.frequency.value },
        layers: { roar: roarLevel.gain.value, rumble: rumbleLevel.gain.value, jet: jetLevel.gain.value, whump: whumpGate.gain.value, pilot: pilotLevel.gain.value, vent: ventLevel.gain.value, creak: creakGate.gain.value },
      };
    },
  };
}
