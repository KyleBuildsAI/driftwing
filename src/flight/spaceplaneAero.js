// Spaceplane aerodynamics, engine and reaction control: the SimFixedWing extension (profile.extension)
// the suborbital spaceplane flies with. It adds what the generic airframe does not model, from the
// craft's simProfile.space block:
//   engine        an air-augmented rocket (rocket-based combined cycle): the rocket core's thrust (a
//                 little back-pressure loss in dense air) plus the air its exhaust entrains and burns
//                 (an ejector at low speed, ram augmentation to about Mach 4), which grows with the
//                 mass flow (rho x V, up to the inlet's limit) and fades past Mach 4-6 and in thin air.
//                 The core alone is short of 1 g, so a full-power climb builds its energy low down and
//                 coasts on it to an apogee near 100-120 km; there is no fuel limit
//   reaction control  RCS thrusters on all three axes. Their authority blends in automatically as the
//                 dynamic pressure falls (rcsBlend: 1 in vacuum, 0 once the aerodynamic surfaces have
//                 the air to work with); the yaw jets also stay on at entry angles of attack, where the
//                 fin sits in the wing's wake (as on the real orbiters). The pedals fire the yaw jets
//   supersonic    wave drag through Mach 1 easing off at hypersonic speeds, the supersonic wing's extra
//                 induced drag, and the wing and body pitch damping
//   re-entry      heating proxy rho x V^3 over the profile's reference, gated by a hypersonic Mach
//                 range (cooler flow does not glow), with the skin's thermal lag; buffeting that grows
//                 with the heating and the dynamic pressure
//   apogee        the apogee prediction while climbing (null descending): h + vy^2 / 2 (g - a sin pitch)
//                 with the thrust acceleration a while that is a real deceleration, else ballistic
//
// Derived values go to craftState after every tick (contract h.3: apogee, dynamicPressure, rcsBlend,
// heating; plus mach, thrust, rcsPitch / rcsYaw / rcsRoll for the thruster puffs). The comms blackout,
// the re-entry phases and their events belong to the craft's ability update (src/craft/spaceplane.js),
// which runs once per frame: the trim's probe ticks restore this extension's own state from its
// snapshot, so nothing here may emit events.
import { clamp } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, smoothstep, speedOfSound } from './aero.js';

/** Below this deceleration (m/s^2) a powered climb has no apogee in sight: the prediction is ballistic. */
const POWERED_APOGEE_MIN_DECELERATION = 1;

/** Linear interpolation through [x, y] points (clamped at both ends). */
function table(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index++) {
    if (x <= points[index][0]) {
      const [x0, y0] = points[index - 1];
      const [x1, y1] = points[index];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** Smooth deterministic noise in about [-1, 1] (re-entry buffet). */
function shake(time, phase, frequency) {
  return 0.6 * Math.sin(time * frequency * 6.2832 + phase) + 0.4 * Math.sin(time * frequency * 2.37 * 6.2832 + phase * 1.9);
}

/**
 * Thrust (N) of the air-augmented rocket at full power for a density, airspeed and Mach number:
 * { core, air, total }. Exported for the flight lab. engine is simProfile.space.engine.
 */
export function rocketThrust(engine, rho, airspeed, mach, out = { core: 0, air: 0, total: 0 }) {
  const densityRatio = rho / SEA_LEVEL_DENSITY;
  out.core = engine.coreThrust * (1 - engine.backPressureLoss * Math.min(densityRatio, 1));
  const massFlow = Math.min(engine.airFlowCap, rho * Math.max(airspeed, engine.airFlowMinSpeed));
  out.air = engine.airThrust * massFlow * (1 - smoothstep(engine.airFadeMach[0], engine.airFadeMach[1], mach));
  out.total = out.core + out.air;
  return out;
}

/** The share of RCS authority (0..1) at a dynamic pressure (Pa): 1 in vacuum, 0 once the surfaces bite. */
export function rcsBlendAt(rcs, dynamicPressure) {
  return 1 - smoothstep(rcs.blendFrom, rcs.blendTo, dynamicPressure);
}

/**
 * The re-entry heating index (0 = cold, 1 = the profile's reference) for a density, airspeed and Mach
 * number: rho V^3 over the reference, gated by the hypersonic Mach range. Exported for the lab.
 */
export function heatingIndex(heating, rho, airspeed, mach) {
  return ((rho * airspeed * airspeed * airspeed) / heating.reference) * smoothstep(heating.machFrom, heating.machFull, mach);
}

/**
 * The apogee prediction (m) from an altitude, a climb rate, the thrust acceleration (m/s^2) and the
 * pitch (rad): above the air the climb decelerates at g less the thrust's vertical share, so while that
 * is a real deceleration the prediction counts the thrust (h + vy^2 / 2 (g - a sin pitch)); otherwise
 * it is ballistic. null while not climbing.
 */
export function apogeePrediction(altitude, verticalSpeed, thrustAcceleration, pitch) {
  if (!(verticalSpeed > 0)) return null;
  const deceleration = GRAVITY - Math.max(thrustAcceleration, 0) * Math.sin(pitch);
  if (deceleration < POWERED_APOGEE_MIN_DECELERATION) return ballisticApogee(altitude, verticalSpeed);
  return altitude + (verticalSpeed * verticalSpeed) / (2 * deceleration);
}

/** The ballistic apogee (m) from an altitude and a climb rate; null while not climbing. */
export function ballisticApogee(altitude, verticalSpeed) {
  if (!(verticalSpeed > 0)) return null;
  return altitude + (verticalSpeed * verticalSpeed) / (2 * GRAVITY);
}

export function createSpaceplaneExtension({ profile, craftState, flightData }) {
  const space = profile.space;
  const engine = space.engine;
  const rcs = space.rcs;
  const supersonic = space.supersonic;
  const heating = space.heating;
  const handling = space.handling;
  const thrustLineHeight = engine.position[1] - (profile.centerOfMass ? profile.centerOfMass[1] : 0);

  const thrustScratch = { core: 0, air: 0, total: 0 };
  /** Engine: the lagged thrust level (0..1 of the lever, ignition and shutdown lag) and the last thrust (N). */
  const rocket = { level: 0, thrust: 0, core: 0, air: 0 };
  /** Reaction control: the blend and the commanded jet levels (-1..1) per axis after the blend. */
  const jets = { blend: 1, yawBlend: 1, pitch: 0, yaw: 0, roll: 0 };
  /** Air data (this tick's): Mach, dynamic pressure; the skin heating (lagged) and its raw index. */
  const air = { mach: 0, dynamicPressure: 0, heat: 0, heatIndex: 0, buffet: 0, apogee: null };

  function writeCraftState() {
    craftState.mach = air.mach;
    craftState.dynamicPressure = air.dynamicPressure;
    craftState.rcsBlend = jets.blend;
    craftState.rcsPitch = jets.pitch;
    craftState.rcsYaw = jets.yaw;
    craftState.rcsRoll = jets.roll;
    craftState.heating = clamp(air.heat, 0, 1);
    craftState.apogee = air.apogee;
    craftState.thrust = rocket.thrust;
    craftState.thrustLevel = rocket.level;
  }

  /**
   * The RCS reads this tick's shaped stick (after the assists): each axis fires its jets in
   * proportion, scaled by the blend. The yaw jets also stay on at entry angles of attack.
   */
  function shapeControls(controls, tick) {
    const q = Number.isFinite(tick.dynamicPressure) ? tick.dynamicPressure : 0;
    jets.blend = rcsBlendAt(rcs, q);
    const entry = smoothstep(rcs.yawEntryAoa[0], rcs.yawEntryAoa[1], Math.abs(tick.aoa)) * smoothstep(rcs.yawEntryMach[0], rcs.yawEntryMach[1], air.mach);
    jets.yawBlend = Math.max(jets.blend, entry);
    jets.pitch = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1) * jets.blend;
    jets.roll = clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1) * jets.blend;
    jets.yaw = clamp(Number.isFinite(controls.yaw) ? controls.yaw : 0, -1, 1) * jets.yawBlend;
  }

  const engineHooks = {
    update(controls, tick) {
      const systems = tick.systems;
      const target = systems.running ? systems.throttle : 0;
      const seconds = target > rocket.level ? engine.ignitionSeconds : engine.shutdownSeconds;
      rocket.level += (target - rocket.level) * (1 - Math.exp(-tick.dt / Math.max(seconds, 0.02)));
      if (rocket.level < 1e-4 && target === 0) rocket.level = 0;
      systems.rpmShare = rocket.level;
      systems.powerShare = rocket.level;
    },

    /** Rocket thrust along the thrust line (body -z) and the RCS moments; returns the thrust (N). */
    forces(tick, forceBody, momentBody) {
      rocketThrust(engine, tick.rho, tick.airspeed, air.mach, thrustScratch);
      const thrust = rocket.level * thrustScratch.total;
      rocket.thrust = thrust;
      rocket.core = rocket.level * thrustScratch.core;
      rocket.air = rocket.level * thrustScratch.air;
      forceBody.z -= thrust;
      // A thrust line off the centre of mass pitches the nose (r x F about body x).
      momentBody.x -= thrust * thrustLineHeight;
      // Reaction control (body rates: x nose up, y nose left, z right wing up).
      momentBody.x += rcs.torque[0] * jets.pitch;
      momentBody.y -= rcs.torque[1] * jets.yaw;
      momentBody.z -= rcs.torque[2] * jets.roll;
      return thrust;
    },

    reset(pose, systems) {
      const throttle = Number.isFinite(pose.throttle) ? clamp(pose.throttle, 0, 1) : 0;
      rocket.level = systems.running && pose.onGround !== true ? throttle : 0;
      rocket.thrust = 0;
      rocket.core = 0;
      rocket.air = 0;
      systems.rpmShare = rocket.level;
      systems.powerShare = rocket.level;
    },
  };

  /** Wave drag on the wing area plus the supersonic wing's extra induced drag. */
  function dragCoefficient(tick) {
    const wave = table(supersonic.waveDrag, air.mach);
    const inducedGrowth = supersonic.supersonicInduced * smoothstep(supersonic.inducedFrom, supersonic.inducedFull, air.mach);
    return wave + inducedGrowth * tick.wingCl * tick.wingCl;
  }

  function moments(tick, momentBody) {
    const airspeed = tick.airspeed;
    if (!(airspeed > 5)) return;
    const qS = tick.dynamicPressure * tick.wingArea;
    const rates = tick.angularVelocity;
    // Pitch damping of the delta wing and the body (the elevons' share comes from the airframe model).
    momentBody.x -= qS * tick.meanChord * handling.pitchDamping * ((rates.x * tick.meanChord) / (2 * airspeed));
    momentBody.y -= qS * tick.wingSpan * handling.yawDamping * ((rates.y * tick.wingSpan) / (2 * airspeed));
    // Re-entry buffeting: the shock layer shakes the airframe, growing with the heating.
    const buffet = air.buffet;
    if (buffet > 0) {
      const scale = qS * tick.meanChord * handling.buffetMoment * buffet;
      momentBody.x += scale * shake(tick.time, 0.4, 7.5);
      momentBody.y += scale * 0.5 * shake(tick.time, 1.9, 5.5);
      momentBody.z += scale * 0.9 * shake(tick.time, 3.1, 9.5);
    }
  }

  /** Air data, heating, the apogee prediction and the craft state, after the tick's flight data. */
  function afterStep(tick) {
    air.mach = tick.airspeed / speedOfSound(tick.altitude);
    air.dynamicPressure = tick.dynamicPressure;
    air.heatIndex = heatingIndex(heating, tick.rho, tick.airspeed, air.mach);
    // The skin heats and cools with a lag (the glow follows the skin, not the instantaneous flow).
    air.heat += (Math.min(air.heatIndex, heating.maxIndex) - air.heat) * (1 - Math.exp(-tick.dt / heating.lagSeconds));
    air.buffet = smoothstep(heating.buffetFrom, 1, air.heat);
    air.apogee = apogeePrediction(tick.altitude, flightData.verticalSpeed, rocket.thrust / tick.mass, flightData.pitch);
    flightData.mach = air.mach;
    flightData.rcsBlend = jets.blend;
    flightData.heating = air.heat;
    writeCraftState();
  }

  /**
   * The rocket has no afterburner; rpm is the thrust level. Stall buffet and the stall warning need
   * air: they fade with the dynamic pressure (a high angle of attack in vacuum is not a stall), and the
   * re-entry buffet joins the buffet the camera and the audio read.
   */
  function writeTelemetry(flight) {
    flight.afterburner = false;
    flight.rpm = rocket.level;
    const airShare = smoothstep(handling.stallPressure[0], handling.stallPressure[1], air.dynamicPressure);
    flight.stall.buffet = Math.round(Math.max(flight.stall.buffet * airShare, air.buffet * handling.buffetTelemetry) * 1000) / 1000;
    flight.stall.warning = flight.stall.warning && airShare > 0.5;
    flight.stall.stalled = flight.stall.stalled && airShare > 0.5;
  }

  function reset(pose, systems) {
    // Airborne starts (spawns, climbs, respawns) fly clean: gear up.
    const onGround = pose.onGround === true;
    systems.gearDown = onGround;
    systems.gearPosition = onGround ? 1 : 0;
    const altitude = pose.position ? pose.position.y : 0;
    const speed = pose.velocity ? pose.velocity.length() : 0;
    air.mach = speed / speedOfSound(altitude);
    air.heat = 0;
    air.heatIndex = 0;
    air.buffet = 0;
    air.apogee = pose.velocity ? ballisticApogee(altitude, pose.velocity.y) : null;
    jets.pitch = 0;
    jets.yaw = 0;
    jets.roll = 0;
    flightData.mach = air.mach;
    writeCraftState();
  }

  function snapshot() {
    return { rocket: { ...rocket }, jets: { ...jets }, air: { ...air } };
  }

  function restore(data) {
    if (data.rocket) Object.assign(rocket, data.rocket);
    if (data.jets) Object.assign(jets, data.jets);
    if (data.air) Object.assign(air, data.air);
    writeCraftState();
  }

  flightData.mach = 0;
  flightData.rcsBlend = 1;
  flightData.heating = 0;
  /** RCS control power (rad/s^2 at full stick) per axis for the assists: pitch, yaw, roll. */
  const inertia = profile.inertia;
  flightData.rcsPower = Object.freeze([rcs.torque[0] / inertia.pitch, rcs.torque[1] / inertia.yaw, rcs.torque[2] / inertia.roll]);

  return {
    engine: engineHooks,
    shapeControls,
    dragCoefficient,
    moments,
    afterStep,
    writeTelemetry,
    reset,
    snapshot,
    restore,
  };
}
