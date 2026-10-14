// 'rocket' engine family: the spaceplane's air-augmented rocket, its RCS jets and the re-entry roar.
//
// The engine's thrust level is state.flight.craftState.thrustLevel (the extension's lagged lever),
// else state.flight.rpm. Sound needs air to reach the listener, so every airborne voice scales with the
// density at the craft (the air presence, sqrt(rho / rho0) with a soft knee): voices
//   roar       broadband rocket roar with a turbulent crackle (fast noise bursts), loud and bright in
//              dense air, thinning to near silence as the air goes; the chase view hears it best
//   rumble     the structure-borne rumble: a low band of noise and a sub tone through the airframe,
//              independent of the air, so in vacuum the cockpit keeps only this (quiet, outside views
//              hear none of it)
//   jets       RCS puffs: a short hiss whenever a thruster fires (craftState.rcsPitch / rcsYaw /
//              rcsRoll), a muffled thump inside, faint outside in thin air
//   re-entry   the shock layer's roar, from the heating and the dynamic pressure: it comes back with
//              the density on the way down, a low tearing roar in the cockpit
import { clamp } from '../../core/util.js';
import { airDensity, SEA_LEVEL_DENSITY } from '../../flight/telemetry.js';
import { approach, createScaffold, glide } from '../synthKit.js';

/** How much of the airborne sound reaches the listener at a density ratio (1 dense, ~0 in vacuum). */
export function airPresence(densityRatio) {
  const ratio = clamp(densityRatio, 0, 1);
  return clamp(Math.sqrt(ratio) * 1.6, 0, 1);
}

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createRocketSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);

  // Roar: low-passed noise with a resonant body, swelled by a fast crackle.
  const roarNoise = synth.noise(noise, 0.9);
  const roarFilter = synth.filter('lowpass', 1800, 0.6);
  const roarBody = synth.filter('peaking', 90, 0.9);
  roarBody.gain.value = 8;
  const crackleStage = synth.gain(1);
  const crackle = synth.noise(noise, 0.35);
  const crackleFilter = synth.filter('bandpass', 38, 0.8);
  const crackleDepth = synth.gain(0.9);
  crackle.connect(crackleFilter);
  crackleFilter.connect(crackleDepth);
  crackleDepth.connect(crackleStage.gain);
  const roarLevel = synth.gain(0);
  roarNoise.connect(roarFilter);
  roarFilter.connect(roarBody);
  roarBody.connect(crackleStage);
  crackleStage.connect(roarLevel);
  roarLevel.connect(synth.output);

  // Structure-borne rumble: low noise and a sub tone.
  const rumbleNoise = synth.noise(noise, 0.5);
  const rumbleFilter = synth.filter('lowpass', 120, 0.9);
  const rumbleLevel = synth.gain(0);
  rumbleNoise.connect(rumbleFilter);
  rumbleFilter.connect(rumbleLevel);
  rumbleLevel.connect(synth.output);
  const subTone = synth.oscillator('sine', 34);
  const subLevel = synth.gain(0);
  subTone.connect(subLevel);
  subLevel.connect(synth.output);

  // RCS jets: hiss (outside, in air) and a thump (inside, through the structure).
  const jetNoise = synth.noise(noise, 1.4);
  const jetFilter = synth.filter('highpass', 2400, 0.7);
  const jetLevel = synth.gain(0);
  jetNoise.connect(jetFilter);
  jetFilter.connect(jetLevel);
  jetLevel.connect(synth.output);
  const thumpNoise = synth.noise(noise, 0.6);
  const thumpFilter = synth.filter('bandpass', 180, 1.2);
  const thumpLevel = synth.gain(0);
  thumpNoise.connect(thumpFilter);
  thumpFilter.connect(thumpLevel);
  thumpLevel.connect(synth.output);

  // Re-entry roar: a tearing band of noise that rises with the heating and the dynamic pressure.
  const entryNoise = synth.noise(noise, 0.75);
  const entryFilter = synth.filter('bandpass', 420, 0.6);
  const entryLevel = synth.gain(0);
  entryNoise.connect(entryFilter);
  entryFilter.connect(entryLevel);
  entryLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);

  let thrust = 0;
  let jets = 0;
  let entry = 0;
  const readout = { thrust: 0, presence: 0, roar: 0, rumble: 0, jets: 0, entry: 0, level: 0 };

  return {
    family: 'rocket',
    update(frame, pitch) {
      const { time, interval, flight } = frame;
      const craftState = flight.craftState || {};
      const running = flight.engineOn !== false;
      const lever = Number.isFinite(craftState.thrustLevel) ? craftState.thrustLevel : Number.isFinite(flight.rpm) ? flight.rpm : 0;
      thrust = approach(thrust, running ? clamp(lever, 0, 1) : 0, 0.08, interval);
      const altitude = Number.isFinite(flight.altitude) ? flight.altitude : 0;
      const presence = airPresence(airDensity(altitude) / SEA_LEVEL_DENSITY);
      const outside = !frame.interior;

      const roar = thrust * presence;
      glide(roarLevel.gain, roar * (outside ? 1.3 : 0.55) * profile.level, time, 0.1);
      glide(roarFilter.frequency, (500 + 2200 * roar) * pitch, time, 0.12);
      glide(roarBody.frequency, profile.roarHz * pitch, time, 0.2);

      // The rumble is the structure's, not the air's: the cockpit hears it at any height.
      const rumble = thrust * (outside ? 0.25 * presence : 0.55);
      glide(rumbleLevel.gain, rumble, time, 0.12);
      glide(rumbleFilter.frequency, (70 + 90 * thrust) * pitch, time, 0.2);
      glide(subTone.frequency, profile.rumbleHz * (0.8 + 0.3 * thrust) * pitch, time, 0.15);
      glide(subLevel.gain, 0.22 * rumble, time, 0.15);

      const jetCommand = Math.max(Math.abs(Number.isFinite(craftState.rcsPitch) ? craftState.rcsPitch : 0), Math.abs(Number.isFinite(craftState.rcsYaw) ? craftState.rcsYaw : 0), Math.abs(Number.isFinite(craftState.rcsRoll) ? craftState.rcsRoll : 0));
      jets = approach(jets, jetCommand > 0.04 ? clamp(0.4 + 0.6 * jetCommand, 0, 1) : 0, jetCommand > jets ? 0.02 : 0.06, interval);
      glide(jetLevel.gain, jets * (outside ? 0.12 * presence : 0.05), time, 0.02);
      glide(thumpLevel.gain, jets * (outside ? 0 : 0.35), time, 0.02);

      const heating = clamp(Number.isFinite(craftState.heating) ? craftState.heating : 0, 0, 1);
      const pressure = clamp((Number.isFinite(craftState.dynamicPressure) ? craftState.dynamicPressure : 0) / 30000, 0, 1);
      entry = approach(entry, Math.max(heating, pressure * presence) * Math.max(presence, heating), 0.3, interval);
      glide(entryLevel.gain, entry * (outside ? 0.7 : 0.9), time, 0.15);
      glide(entryFilter.frequency, (260 + 520 * entry) * pitch, time, 0.2);

      const level = 0.14 * profile.level;
      glide(synth.output.gain, level, time, 0.15);
      readout.thrust = thrust;
      readout.presence = presence;
      readout.roar = roar;
      readout.rumble = rumble;
      readout.jets = jets;
      readout.entry = entry;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.4);
    },
    describe() {
      return {
        family: 'rocket',
        target: { ...readout },
        level: synth.output.gain.value,
        roarGain: roarLevel.gain.value,
        rumbleGain: rumbleLevel.gain.value,
        entryGain: entryLevel.gain.value,
      };
    },
  };
}
