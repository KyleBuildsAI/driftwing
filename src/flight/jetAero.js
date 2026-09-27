// Jet aerodynamics and engine: the SimFixedWing extension (profile.extension) the jet flies with.
// It adds what the generic airframe does not model, from the jet's simProfile.jet block:
//   engine        an afterburning turbofan: spool lag (slow from idle, quicker near the top), thrust
//                 lapse with air density and ram recovery with Mach, afterburner light-off delay and
//                 ramp, the variable nozzle, and the afterburner detent on the throttle lever
//   transonic     wave drag rising from the drag-divergence Mach to a peak just past Mach 1 and easing
//                 off supersonic, the induced-drag growth of a supersonic wing, and the aerodynamic
//                 centre moving aft (more nose-down moment per unit lift) through the transonic band
//   handling      a pitch authority schedule with dynamic pressure (the stabilator actuators'
//                 hinge-moment limit), wing rock near the critical angle of attack (the flight control
//                 system in jetFcs.js damps it whenever the assists are on), and the over-G and Mach
//                 buffet with a warning
//
// Throttle and afterburner detent (ControlState.throttle, afterburnerDetent, sources.throttle):
//   - A HOTAS throttle is a real lever: past the detent the burner lights, and the range beyond it
//     sets the afterburner stage.
//   - Every other throttle (keyboard, wheel, gamepad trigger, touch, the autopilot) moves the dry range
//     only and stops at the detent. The craft ability (craftState.abRequest = 'toggle') pushes the
//     lever through the detent to full afterburner; pulling the lever back cancels it.
//   Crossing the detent writes craftState.abDetent (the audio click) and shows a short notice.
import { DEG, clamp } from '../core/util.js';
import { SEA_LEVEL_DENSITY, smoothstep, speedOfSound } from './aero.js';

/** A lever this far below where the burner was engaged (by the ability) cancels it. */
const LEVER_CANCEL = 0.02;
/** A HOTAS lever lights the burner at the detent and cancels it this far below (no chatter). */
const DETENT_HYSTERESIS = 0.01;
const NOTICE_SECONDS = 1.2;
const OVER_G_NOTICE_SECONDS = 3;

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

/** Smooth deterministic noise in about [-1, 1] (buffet). */
function shake(time, phase, frequency) {
  return 0.6 * Math.sin(time * frequency * 6.2832 + phase) + 0.4 * Math.sin(time * frequency * 2.37 * 6.2832 + phase * 1.9);
}

function approach(current, target, rate) {
  if (target > current) return Math.min(target, current + rate);
  return Math.max(target, current - rate);
}

/**
 * Wave-drag coefficient (on the wing area) at Mach `mach` from the profile's drag-rise table.
 * Exported for the flight lab's drag-rise curve.
 */
export function waveDrag(transonic, mach) {
  return table(transonic.waveDrag, mach);
}

/**
 * Static-to-flight thrust factor: density lapse (sigma^lapse) times ram recovery (1 + ram * M),
 * fading past the inlet's design Mach. Exported for the flight lab.
 */
export function thrustFactor(engine, rho, mach) {
  const sigma = Math.max(rho / SEA_LEVEL_DENSITY, 0.02);
  return Math.pow(sigma, engine.lapse) * (1 + engine.ram * mach) * (1 - smoothstep(engine.inletMach, engine.inletMach + 0.4, mach));
}

/**
 * The extension factory SimFixedWing calls: createJetExtension({ profile, craft, bus, craftState,
 * limits, flightData }) -> hooks (see SimFixedWing.js). Everything jet-specific reads profile.jet.
 */
export function createJetExtension({ profile, bus, craftState = {}, limits = {}, flightData }) {
  const jet = profile.jet;
  const engine = jet.engine;
  const transonic = jet.transonic;
  const handling = jet.handling;
  const gLimit = Number.isFinite(limits.gLimit) ? limits.gLimit : 9;
  const vneMach = Number.isFinite(limits.vneMach) ? limits.vneMach : Infinity;
  /** Height of the thrust line above the centre of mass (m): below it, thrust pitches the nose up. */
  const thrustLineHeight = engine.position[1] - (profile.centerOfMass ? profile.centerOfMass[1] : 0);
  const burnerIncrement = engine.abThrust - engine.dryThrust;

  // ---- Engine state ----------------------------------------------------------------------------
  const spool = {
    /** Core speed, 0..1 of rated (idle at engine.idleSpool). */
    speed: engine.idleSpool,
    /** Afterburner stage commanded (0..1 of the afterburner range) and delivered (after light-off). */
    abCommand: 0,
    abLevel: 0,
    /** Seconds the burner has been commanded with the core at speed (light-off delay). */
    lightOff: 0,
    /** Nozzle opening 0 (closed, idle) .. 1 (full afterburner). */
    nozzle: 0,
    thrust: 0,
  };
  const lever = {
    /** Burner engaged through the ability (a soft lever cannot pass the detent itself). */
    latched: false,
    latchLever: 0,
    /** A HOTAS lever sitting past the detent. */
    physical: false,
    commanded: false,
    lastNotice: -Infinity,
  };
  const air = { mach: 0, overG: false, lastOverGNotice: -Infinity, overGSeconds: 0 };
  let clock = 0;

  function notify(text, kind = 'info') {
    if (bus) bus.emit('notify', { text, kind });
  }

  // ============================================================================================
  // THROTTLE AND DETENT
  // ============================================================================================
  /**
   * Reads the lever and the ability's request; returns the dry command (0..1 of military power) and
   * sets the afterburner command. Writes the effective lever (the instrument's throttle) to systems.
   */
  function readLever(controls, systems) {
    const detent = clamp(Number.isFinite(controls.afterburnerDetent) ? controls.afterburnerDetent : 0.95, 0.8, 1);
    const position = clamp(Number.isFinite(controls.throttle) ? controls.throttle : 0, 0, 1);
    const source = controls.sources ? controls.sources.throttle : null;
    const physicalLever = source === 'hotas';
    const running = systems.running;

    const request = craftState.abRequest;
    craftState.abRequest = null;
    if (request === 'toggle') {
      if (!running) notify('The engine is off: no afterburner.', 'warning');
      else if (lever.commanded && lever.physical && !lever.latched) notify('Pull the throttle back through the detent to cancel the afterburner.');
      else if (lever.commanded) lever.latched = false;
      else {
        lever.latched = true;
        lever.latchLever = position;
      }
    }
    if (lever.latched) {
      if (position < lever.latchLever - LEVER_CANCEL || !running) lever.latched = false;
      else lever.latchLever = Math.max(lever.latchLever, position);
    }
    if (physicalLever) lever.physical = lever.physical ? position >= detent - DETENT_HYSTERESIS : position >= detent;
    else lever.physical = false;

    const commanded = running && (lever.latched || lever.physical);
    const stage = Math.max(lever.latched ? 1 : 0, lever.physical ? clamp((position - detent) / Math.max(1 - detent, 1e-3), 0, 1) : 0);
    const dry = physicalLever ? Math.min(position / detent, 1) : position;
    spool.abCommand = commanded ? stage : 0;
    systems.throttle = commanded ? detent + (1 - detent) * stage : dry * detent;

    if (commanded !== lever.commanded) {
      lever.commanded = commanded;
      craftState.abDetent = commanded;
      if (clock - lever.lastNotice >= NOTICE_SECONDS) {
        lever.lastNotice = clock;
        notify(commanded ? 'Afterburner.' : 'Afterburner off.', commanded ? 'success' : 'info');
      }
    }
    return commanded ? 1 : dry;
  }

  // ============================================================================================
  // ENGINE
  // ============================================================================================
  /** Core spool toward the dry command; slow from idle, quicker near the top, like a real turbofan. */
  function updateSpool(dry, running, mach, dt) {
    const target = running ? engine.idleSpool + (1 - engine.idleSpool) * dry : clamp(mach * 0.3, 0, 0.3);
    const upward = target > spool.speed;
    const pace = upward ? engine.spoolUpSeconds * (1.55 - spool.speed) : engine.spoolDownSeconds;
    spool.speed += (target - spool.speed) * (1 - Math.exp(-dt / Math.max(pace, 0.05)));
    // The burner lights once the core is near military speed, after a short delay, then ramps.
    const atSpeed = running && spool.speed >= 0.95;
    spool.lightOff = spool.abCommand > 0 && atSpeed ? spool.lightOff + dt : 0;
    const abTarget = spool.lightOff >= engine.abLightOffSeconds ? spool.abCommand : 0;
    spool.abLevel = approach(spool.abLevel, abTarget, dt / (abTarget > spool.abLevel ? engine.abRampSeconds : engine.abRampSeconds * 0.5));
    // The nozzle: nearly closed at idle, trimmed open at military power, wide open in afterburner.
    const nozzleTarget = running ? 0.18 + 0.12 * Math.max(0, 1 - dry) + 0.7 * spool.abLevel : 0.4;
    spool.nozzle = approach(spool.nozzle, nozzleTarget, dt / engine.nozzleSeconds);
  }

  /** Dry share of military thrust from the core speed (idle thrust at idle spool). */
  function dryShare() {
    const fraction = clamp((spool.speed - engine.idleSpool) / (1 - engine.idleSpool), 0, 1);
    return engine.idleThrust + (1 - engine.idleThrust) * Math.pow(fraction, 1.35);
  }

  const engineHooks = {
    update(controls, tick) {
      clock = tick.time;
      const systems = tick.systems;
      const dry = readLever(controls, systems);
      updateSpool(dry, systems.running, air.mach, tick.dt);
      systems.rpmShare = spool.speed;
      systems.powerShare = systems.running ? dryShare() : 0;
    },

    /** Thrust along the thrust line (body -z); returns the thrust in newtons. */
    forces(tick, forceBody, momentBody) {
      const running = tick.systems.running;
      const factor = thrustFactor(engine, tick.rho, air.mach);
      const dry = running ? engine.dryThrust * dryShare() : 0;
      const burner = running ? burnerIncrement * spool.abLevel * (engine.abMinimum + (1 - engine.abMinimum) * spool.abCommand) : 0;
      const thrust = (dry + burner) * factor;
      spool.thrust = thrust;
      forceBody.z -= thrust;
      // A thrust line off the centre of mass pitches the nose (r x F about body x).
      momentBody.x -= thrust * thrustLineHeight;
      return thrust;
    },

    reset(pose, systems) {
      const onGround = pose.onGround === true;
      const throttle = Number.isFinite(pose.throttle) ? clamp(pose.throttle, 0, 1) : 0;
      spool.speed = systems.running ? (onGround ? engine.idleSpool : engine.idleSpool + (1 - engine.idleSpool) * throttle) : 0;
      spool.abCommand = 0;
      spool.abLevel = 0;
      spool.lightOff = 0;
      spool.nozzle = 0.25;
      spool.thrust = 0;
      lever.latched = false;
      lever.physical = false;
      lever.commanded = false;
      craftState.abDetent = false;
      craftState.abRequest = null;
      systems.rpmShare = spool.speed;
      systems.powerShare = systems.running ? dryShare() : 0;
    },
  };

  // ============================================================================================
  // AERODYNAMICS AND HANDLING
  // ============================================================================================
  /** Extra zero-lift drag plus the supersonic wing's extra induced drag, on the wing area. */
  function dragCoefficient(tick) {
    const wave = waveDrag(transonic, air.mach);
    const inducedGrowth = transonic.supersonicInduced * smoothstep(transonic.inducedFrom, transonic.inducedFull, air.mach);
    return wave + inducedGrowth * tick.wingCl * tick.wingCl;
  }

  /** Stabilator authority falls with dynamic pressure (the actuators' hinge-moment limit). */
  function shapeControls(controls, tick) {
    const q = tick.flightData.dynamicPressure;
    if (q > handling.pitchAuthorityPressure && Number.isFinite(controls.pitch)) {
      controls.pitch *= Math.max(handling.pitchAuthorityFloor, handling.pitchAuthorityPressure / q);
    }
  }

  function moments(tick, momentBody) {
    const q = tick.dynamicPressure;
    const airspeed = tick.airspeed;
    if (!(airspeed > 5)) return;
    const qS = q * tick.wingArea;
    const aoa = tick.aoa;
    const rates = tick.angularVelocity;

    // Pitch damping of the wing, strakes and fuselage (the tail's share comes from the airframe model).
    momentBody.x -= qS * tick.meanChord * handling.pitchDamping * ((rates.x * tick.meanChord) / (2 * airspeed));

    // Aerodynamic centre moving aft through the transonic band: more nose-down moment per unit lift.
    const shift = transonic.acShift * smoothstep(transonic.acShiftFrom, transonic.acShiftFull, air.mach);
    momentBody.x -= qS * tick.meanChord * shift * tick.wingCl;

    // Wing rock: near the critical angle of attack the roll damping turns negative (asymmetric vortex
    // bursting); the cubic term bounds it into a limit cycle. The flight control system's roll damper
    // (src/flight/jetFcs.js) holds it off whenever the assists are on.
    const rock = handling.wingRock;
    const rockShare = smoothstep(rock.from * DEG, rock.full * DEG, aoa) * (1 - smoothstep(rock.fadeFrom * DEG, rock.fadeTo * DEG, aoa));
    if (rockShare > 0) {
      const rollRate = rates.z;
      const bounded = rollRate * (1 - (rollRate * rollRate) / (rock.rateLimit * rock.rateLimit));
      const reduced = (bounded * tick.wingSpan) / (2 * airspeed);
      momentBody.z += qS * tick.wingSpan * rockShare * (rock.gain * reduced + rock.seed * shake(tick.time, 0.7, rock.seedFrequency));
    }

    // Over-G and transonic (Mach) buffet: short shaking moments that grow with the exceedance.
    const overG = smoothstep(handling.overGTolerance, handling.overGTolerance + handling.overGBuffetRange, Math.abs(tick.gLoad) - (tick.gLoad >= 0 ? gLimit : gLimit * handling.negativeShare));
    const machBuffet = handling.machBuffet * smoothstep(0.93, 0.99, air.mach) * (1 - smoothstep(1.02, 1.08, air.mach));
    const overspeed = smoothstep(vneMach, vneMach + 0.1, air.mach);
    const buffet = Math.max(overG, machBuffet, overspeed);
    if (buffet > 0) {
      const scale = qS * tick.meanChord * handling.buffetMoment * buffet;
      momentBody.x += scale * shake(tick.time, 0.4, 9);
      momentBody.y += scale * 0.4 * shake(tick.time, 1.9, 7);
      momentBody.z += scale * 0.8 * shake(tick.time, 3.1, 11);
    }
  }

  /** Mach, the Mach limit and the over-G warning, after the tick's flight data is written. */
  function afterStep(tick) {
    air.mach = tick.airspeed / speedOfSound(tick.altitude);
    flightData.mach = air.mach;
    if (air.mach > vneMach) flightData.overspeed = true;
    const load = tick.gLoad;
    const exceeded = load > gLimit + handling.overGTolerance || load < -gLimit * handling.negativeShare - handling.overGTolerance;
    air.overGSeconds = exceeded ? air.overGSeconds + tick.dt : 0;
    const overG = air.overG ? load > gLimit - 0.3 || load < -gLimit * handling.negativeShare + 0.3 : exceeded;
    air.overG = overG;
    craftState.overG = overG;
    if (exceeded && air.overGSeconds >= 0.1 && tick.time - air.lastOverGNotice >= OVER_G_NOTICE_SECONDS) {
      air.lastOverGNotice = tick.time;
      notify(`Over-G: ${load.toFixed(1)} g. The airframe is rated for ${gLimit} g.`, 'warning');
    }
    craftState.mach = air.mach;
    craftState.spool = spool.speed;
    craftState.afterburner = spool.abLevel;
    craftState.nozzle = spool.nozzle;
    craftState.thrust = spool.thrust;
  }

  function writeTelemetry(flight) {
    flight.afterburner = spool.abLevel > 0.05;
  }

  function reset(pose, systems) {
    // Airborne starts (spawns, airstarts, mode switches in flight) fly clean: gear up, no flaps.
    const onGround = pose.onGround === true;
    systems.gearDown = onGround;
    systems.gearPosition = onGround ? 1 : 0;
    air.overG = false;
    air.overGSeconds = 0;
    craftState.overG = false;
    const altitude = pose.position ? pose.position.y : 0;
    const speed = pose.velocity ? pose.velocity.length() : 0;
    air.mach = speed / speedOfSound(altitude);
    flightData.mach = air.mach;
  }

  function snapshot() {
    return { spool: { ...spool }, lever: { ...lever, lastNotice: 0 }, mach: air.mach };
  }

  function restore(data) {
    if (data.spool) Object.assign(spool, data.spool);
    if (data.lever) {
      Object.assign(lever, data.lever);
      lever.lastNotice = -Infinity;
    }
    if (Number.isFinite(data.mach)) air.mach = data.mach;
    craftState.abDetent = lever.commanded;
  }

  flightData.mach = 0;

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
