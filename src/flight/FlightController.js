import * as THREE from 'three/webgpu';
import { CONFIG } from '../core/config.js';
import { DEG, clamp, damp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, isFiniteVector, isFiniteQuaternion } from '../core/util.js';
import { createFixedStepClock } from '../core/clock.js';
import { createControlState, copyControlState } from '../input/controlState.js';
import { airDensity, speedOfSound, createFlightTelemetry, SEA_LEVEL_DENSITY } from './telemetry.js';
import { flightModels as defaultFlightModels } from './models.js';
import { trimModel } from './trim.js';
import { primeAssists } from './assists.js';
import { createCrashFade } from './crashFade.js';
import { createAerotow, createRopeMaterial, createRopeStandIn, findNearestPeak, planPeakLaunch } from './relaunch.js';
import { findFlatSpot, groundPose, vegetationClearance } from './placement.js';
import { createTrailSystem } from './trails.js';
import { createParkingBrake } from './parkingBrake.js';
import { countTriangles } from '../craft/kit.js';

/**
 * FLIGHT CONTROLLER (ctx.systems.flight): owns the active craft, the CLASSIC | SIM mode and the
 * models, and keeps state.player (the v1 fields every v1 system reads) and state.flight (telemetry)
 * current in both modes.
 *
 * - CLASSIC runs the craft's ArcadeModel once per frame exactly like v1, then drifts the craft by a
 *   subtle share of the wind field (no gusts).
 * - SIM runs the craft's SIM model in fixed 120 Hz ticks from ControlState (shaped by the craft input
 *   profile and the registered control stages: assists, autopilot), samples the wind and air density
 *   per tick, guards against NaN / Infinity every tick (restoring the last good snapshot) and renders
 *   an interpolated pose.
 * - Mode switches keep position, velocity vector, attitude, seed and craft and blend the rendered
 *   pose over 0.5 s; craft switches rebuild the mesh and respawn sensibly at the same place.
 * - Soft crash (SIM): fade, respawn 300 m above the ground at the same XZ and heading, no penalty.
 * - Relaunch: aerotow (glider), nearest peak (wingsuit) or airstart; start on ground (SIM setting);
 *   hands-off assist override while a disconnected device was flying.
 * - Parking brake (parkingBrake.js): a powered craft placed on the ground with the throttle lever
 *   open holds its wheels at idle until the pilot moves the lever or brakes; a throttle no physical
 *   lever holds (keyboard, wheel, touch) goes to idle on a ground start instead.
 *
 * Mode and craft are commanded through settings ('mode', 'craft'): the controller applies a change or
 * writes the previous value back, then emits modeChanged / craftChanged.
 */

export const SIM_CEILING = 15000;
const BLEND_SECONDS = 0.5;
const CRASH_FADE_SECONDS = 0.4;
const RESPAWN_AGL = 300;
const AIRSTART_AGL = 300;
const TOW_RELEASE_AGL = 1000;
const TOW_REFUSE_AGL = 950;
const PEAK_RELAUNCH_BELOW_AGL = 300;
const MIN_SPAWN_AGL = 60;
const SPAWN_LIFT_AGL = 150;
const PENETRATION_LIMIT = 1;
const DEFAULT_BODY_STRIKE_SPEED = 5;
const OVERRIDE_INPUT = 0.35;
const OVERRIDE_SECONDS = 0.25;
const AUTOPILOT_MIN_ALTITUDE = 60;
const GRAVITY = 9.81;
/** A CLASSIC -> SIM switch keeps the roll within the SIM bank protection. */
const CONVERSION_MAX_BANK = 66 * DEG;
/** Speed changes smaller than this (m/s) after a conversion are not worth a speed blend. */
const SPEED_BLEND_MIN_CHANGE = 0.5;
/** SIM -> CLASSIC: the arcade model starts at least this far (m/s) above its soft-stall speed. */
const CLASSIC_STALL_MARGIN = 4;
/** SIM -> CLASSIC for a landed hover craft: it starts this far (m) above its CLASSIC hover floor. */
const CLASSIC_HOVER_LIFT = 1;
/** CLASSIC feels the wind field only as a gentle drift: shares of the calm (gust-free) air motion. */
const CLASSIC_WIND = Object.freeze({ HORIZONTAL_SHARE: 0.25, VERTICAL_SHARE: 0.3, LAMBDA: 0.8 });

/** Actions the flight controller performs (docs/architecture.md, ownership table). */
const CRAFT_SELECT_ACTIONS = Object.freeze(['craftSelect1', 'craftSelect2', 'craftSelect3', 'craftSelect4', 'craftSelect5', 'craftSelect6']);
const FLIGHT_ACTIONS = new Set([
  'craftAbility', 'boost', 'craftNext', 'craftPrev', ...CRAFT_SELECT_ACTIONS, 'modeToggle', 'gearToggle', 'flapsUp', 'flapsDown',
  'airbrake', 'relaunch', 'engineToggle', 'chuteDeploy',
]);
/** Flight actions the SIM model itself handles (passed to it in the tick's controls.actions). */
const MODEL_ACTIONS = new Set(['gearToggle', 'flapsUp', 'flapsDown', 'airbrake', 'engineToggle', 'chuteDeploy']);
/** Telemetry fields a model owns; reset to defaults when the model changes so nothing stale shows. */
const MODEL_TELEMETRY_FIELDS = Object.freeze(['aoa', 'sideslip', 'throttle', 'afterburner', 'engineOn', 'rpm', 'rotorRpm', 'torque', 'flaps', 'flapNotch', 'gear', 'airbrake', 'brakes', 'trim', 'stall', 'overspeed', 'activeAssists']);
const LANDING_RANK = Object.freeze({ butter: 0, smooth: 1, firm: 2, hard: 3 });

export function createFlightController(ctx) {
  const { scene, state, input, bus, world, settings } = ctx;
  const player = state.player;
  const telemetry = state.flight;
  const registry = ctx.craftRegistry;
  const models = ctx.flightModels ?? defaultFlightModels;
  const liveControls = ctx.controls ?? createControlState();

  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const IDENTITY = new THREE.Quaternion();
  const scratchVector = new THREE.Vector3();
  const scratchQuaternion = new THREE.Quaternion();
  const scratchForward = new THREE.Vector3();
  const scratchUp = new THREE.Vector3();
  const scratchRight = new THREE.Vector3();
  const inverseQuaternion = new THREE.Quaternion();

  // ---- Craft and models ------------------------------------------------------------------------
  let mode = 'classic';
  let craftId = null;
  let craft = null;
  let mesh = null;
  let arcade = null;
  let sim = null;
  let craftState = {};

  // ---- SIM fixed-step state ----------------------------------------------------------------------
  const clock = createFixedStepClock();
  const tickControls = createControlState();
  /**
   * Model actions whose press came only from the copilot this tick (tickControls.quietActions). The
   * copilot speaks its own confirmation, so the model skips its toast for them.
   */
  tickControls.quietActions = new Set();
  const env = {
    time: 0,
    wind: { vel: new THREE.Vector3(), turbulence: 0 },
    groundHeight: (x, z) => world.groundHeight(x, z),
    waterLevel: CONFIG.WATER_LEVEL,
    rho: SEA_LEVEL_DENSITY,
    world,
    craftState,
    assists: 1,
    handsOff: false,
    autopilot: player.autopilot,
    telemetry,
  };
  const interpolation = {
    previousPosition: new THREE.Vector3(),
    previousQuaternion: new THREE.Quaternion(),
    previousVelocity: new THREE.Vector3(),
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
  };
  let lastGoodSnapshot = null;
  let nanReported = false;
  const counters = { nanRestores: 0, softCrashes: 0, relaunches: 0, modeSwitches: 0, craftSwitches: 0, maxTicksPerFrame: 0 };
  // game: the shared state (ring course, waypoint) the SIM autopilot follows.
  const stageContext = { dt: 0, model: null, craft: null, craftId: null, env, autopilot: player.autopilot, assists: 1, handsOff: false, telemetry, activeAssists: [], game: state };

  // ---- Visual blend, crash, relaunch, hot-plug -----------------------------------------------------
  const blend = {
    active: false,
    elapsed: 0,
    weight: 0,
    positionOffset: new THREE.Vector3(),
    rotationOffset: new THREE.Quaternion(),
    rotation: new THREE.Quaternion(),
    base: new THREE.Quaternion(),
  };
  /** After a conversion outside the craft's safe speed range: the airspeed eases into it over the blend. */
  const speedBlend = { active: false, elapsed: 0, from: 0, to: 0, bank: 0 };
  const crash = { active: false, phase: 'idle', elapsed: 0, reason: '' };
  let crashFade = null;
  let tow = null;
  const departingTows = [];
  const ropeMaterial = createRopeMaterial();
  const override = { active: false, deviceKey: '', kind: '', name: '', savedAutopilot: null, manualSeconds: 0 };
  const autopilotOverride = { seconds: 0 };

  // ---- CLASSIC wind drift ----------------------------------------------------------------------------
  const windSample = { vel: new THREE.Vector3(), turbulence: 0 };
  const classicWind = new THREE.Vector3();
  const classicWindTarget = new THREE.Vector3();

  // ---- Telemetry helpers -------------------------------------------------------------------------------
  const telemetryDefaults = createFlightTelemetry();
  const previousTelemetryQuaternion = new THREE.Quaternion();
  const previousTelemetryVelocity = new THREE.Vector3();
  const angularScratch = new THREE.Quaternion();
  let previousAirspeed = NaN;
  let telemetryPrimed = false;

  // ---- Actions ------------------------------------------------------------------------------------------
  const pendingActions = new Set();
  const modelActions = new Set();
  /** Pending flight actions pressed by the copilot alone, and the model actions they became. */
  const copilotActions = new Set();
  const quietModelActions = new Set();
  const parkingBrake = createParkingBrake();

  const trails = createTrailSystem(ctx);

  // ============================================================================================
  // HELPERS
  // ============================================================================================
  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  function surfaceHeight(x, z) {
    return Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  }

  function catalogEntry(id) {
    return registry.catalog.find((entry) => entry.id === id) ?? null;
  }

  function craftLabel(id) {
    const entry = catalogEntry(id);
    return entry ? entry.name.toLowerCase() : String(id);
  }

  function smoothstep01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function headingOfQuaternion(quaternion, fallback) {
    scratchForward.set(0, 0, -1).applyQuaternion(quaternion);
    if (Math.hypot(scratchForward.x, scratchForward.z) < 0.05) return fallback;
    return headingFromVector(scratchForward.x, scratchForward.z);
  }

  function levelQuaternion(heading, target = new THREE.Quaternion()) {
    return target.setFromAxisAngle(WORLD_UP, -heading * DEG);
  }

  function arcadeCruise() {
    return craft.arcadeProfile.SPEED.CRUISE;
  }

  function simCruise() {
    return craft.spawn.cruise;
  }

  function cruiseThrottle() {
    if (mode === 'sim' && Number.isFinite(craft.spawn.cruiseThrottle)) return craft.spawn.cruiseThrottle;
    return craft.arcadeProfile.AUTOPILOT.CRUISE_THROTTLE;
  }

  function vectorLiteral(vector) {
    return { x: vector.x, y: vector.y, z: vector.z };
  }

  function snapCamera() {
    ctx.systems.camera?.snap?.();
  }

  // ============================================================================================
  // CRAFT
  // ============================================================================================
  /** Builds the craft's mesh and arcade model; the caller positions them. */
  function installCraft(id) {
    craft = registry.get(id);
    craftId = id;
    craftState = typeof craft.abilities?.craftAbility?.initialState === 'function' ? craft.abilities.craftAbility.initialState() : {};
    env.craftState = craftState;
    telemetry.craftState = craftState;
    mesh = craft.buildMesh(ctx);
    scene.add(mesh.root);
    arcade = models.create('arcade', { profile: craft.arcadeProfile, craft, world, bus, state, input });
  }

  function disposeCraft() {
    trails.clear();
    if (mesh) mesh.dispose();
    mesh = null;
    disposeSim();
  }

  function disposeSim() {
    if (sim && typeof sim.dispose === 'function') sim.dispose();
    sim = null;
    speedBlend.active = false;
    clearModelActions();
  }

  /** Drops queued model actions: they belong to the model (and moment) they were pressed for. */
  function clearModelActions() {
    modelActions.clear();
    quietModelActions.clear();
  }

  function createSimModel(kind) {
    return models.create(kind, { profile: craft.simProfile, craft, world, bus, state, input, craftState, settings });
  }

  function simKind() {
    return craft && craft.simProfile ? craft.simProfile.model : null;
  }

  function simAvailable() {
    const kind = simKind();
    return typeof kind === 'string' && models.has(kind);
  }

  // ============================================================================================
  // POSES
  // ============================================================================================
  /** The physical pose of the active model (unblended, uninterpolated for SIM). */
  function capturePose() {
    if (mode === 'sim' && sim) {
      return {
        position: interpolation.position.clone(),
        quaternion: interpolation.quaternion.clone(),
        velocity: interpolation.velocity.clone(),
        angularVelocity: sim.state.angularVelocity ? sim.state.angularVelocity.clone() : new THREE.Vector3(),
        throttle: Number.isFinite(telemetry.throttle) ? telemetry.throttle : player.throttle,
        onGround: Boolean(sim.contact && sim.contact.onGround),
      };
    }
    return {
      position: player.position.clone(),
      quaternion: player.quaternion.clone(),
      velocity: player.velocity.clone().add(classicWind),
      angularVelocity: telemetry.angularVelocity.clone(),
      throttle: player.throttle,
      onGround: false,
    };
  }

  /** What the viewer sees right now (mesh root), for the mode-switch blend. */
  function captureDisplayedPose() {
    if (!mesh) return null;
    return { position: mesh.root.position.clone(), quaternion: mesh.root.quaternion.clone() };
  }

  /** The unblended visual pose of the active model. */
  function visualPose(targetPosition, targetQuaternion) {
    if (mode === 'classic' && !tow) {
      targetPosition.copy(player.position).add(arcade.corkscrewOffset);
      targetQuaternion.copy(player.quaternion).multiply(arcade.wobbleQuaternion);
    } else if (mode === 'sim' && !tow) {
      targetPosition.copy(interpolation.position);
      targetQuaternion.copy(interpolation.quaternion);
    } else {
      targetPosition.copy(player.position);
      targetQuaternion.copy(player.quaternion);
    }
  }

  const blendVisualPosition = new THREE.Vector3();
  const blendVisualQuaternion = new THREE.Quaternion();

  /** Starts the 0.5 s blend from what was on screen to the new model's pose (no pops). */
  function startBlend(displayed) {
    if (!displayed) return;
    visualPose(blendVisualPosition, blendVisualQuaternion);
    blend.positionOffset.copy(displayed.position).sub(blendVisualPosition);
    blend.rotationOffset.copy(blendVisualQuaternion).invert().multiply(displayed.quaternion).normalize();
    if (!isFiniteVector(blend.positionOffset) || !isFiniteQuaternion(blend.rotationOffset)) {
      blend.active = false;
      return;
    }
    blend.active = true;
    blend.elapsed = 0;
    blend.weight = 1;
    blend.rotation.copy(blend.rotationOffset);
  }

  function updateBlend(dt) {
    if (!blend.active) return;
    blend.elapsed += dt;
    const progress = blend.elapsed / BLEND_SECONDS;
    if (progress >= 1) {
      blend.active = false;
      blend.weight = 0;
      return;
    }
    blend.weight = 1 - smoothstep01(progress);
    blend.rotation.slerpQuaternions(IDENTITY, blend.rotationOffset, blend.weight);
  }

  function clearBlend() {
    blend.active = false;
    blend.weight = 0;
  }

  // ============================================================================================
  // MODEL RESETS (teleports, spawns, conversions)
  // ============================================================================================
  function resetInterpolationFromModel() {
    if (!sim) return;
    interpolation.position.copy(sim.state.position);
    interpolation.quaternion.copy(sim.state.quaternion);
    interpolation.velocity.copy(sim.state.velocity);
    interpolation.previousPosition.copy(sim.state.position);
    interpolation.previousQuaternion.copy(sim.state.quaternion);
    interpolation.previousVelocity.copy(sim.state.velocity);
    clock.reset();
    lastGoodSnapshot = sim.snapshot();
  }

  /** The throttle the SIM model will see on its next tick (the craft input profile applied). */
  function pilotThrottle() {
    if (craft.inputProfile?.throttle === 'none') return 0;
    return Number.isFinite(liveControls.throttle) ? liveControls.throttle : 0;
  }

  /**
   * Trims the SIM model after an airborne reset: at its position and velocity, with the given bank
   * (the model's own by default), the attitude and elevator for the 1 g load along its path (see
   * trim.js); then primes the assists from the trimmed state. Model kinds without a trim handler
   * stay as reset. Returns the trim result or null.
   */
  function trimSim(bank) {
    if (!sim || (sim.contact && sim.contact.onGround)) return null;
    sampleEnvironment(state.time.elapsed);
    const result = trimModel(sim, {
      env,
      dt: clock.stepSeconds,
      throttle: pilotThrottle(),
      trim: Number.isFinite(liveControls.trim) ? liveControls.trim : 0,
      bank,
    });
    if (!result) return null;
    primeAssists(sim, result);
    return result;
  }

  /**
   * A switch keeps the velocity, but a speed outside the craft's safe range (from 1.25 x its stall
   * speed up to 0.9 x its Vne) eases into the range over the 0.5 s blend: each tick until then the
   * airspeed moves along its path toward the range and the model is re-trimmed at the new speed.
   */
  function startSpeedBlend(result) {
    speedBlend.active = false;
    if (!result || !result.safeSpeed) return;
    const target = clamp(result.speed, result.safeSpeed.min, result.safeSpeed.max);
    if (!Number.isFinite(target) || Math.abs(target - result.speed) < SPEED_BLEND_MIN_CHANGE) return;
    speedBlend.active = true;
    speedBlend.elapsed = 0;
    speedBlend.from = result.speed;
    speedBlend.to = target;
    speedBlend.bank = result.bank;
  }

  function applySpeedBlend(dt) {
    if (!speedBlend.active) return;
    speedBlend.elapsed += dt;
    const progress = smoothstep01(speedBlend.elapsed / BLEND_SECONDS);
    const speed = speedBlend.from + (speedBlend.to - speedBlend.from) * progress;
    const velocity = sim.state.velocity;
    const airVelocity = scratchVector.copy(velocity).sub(env.wind.vel);
    const airspeed = airVelocity.length();
    if (airspeed > 1) velocity.copy(env.wind.vel).addScaledVector(airVelocity, speed / airspeed);
    const result = trimSim(speedBlend.bank);
    if (progress >= 1 || !result) speedBlend.active = false;
  }

  /**
   * Puts the active model at pose (both modes) and refreshes everything derived from it. An airborne
   * SIM pose is trimmed (spawns, respawns, airstarts, tow release, craft switches: level flight at the
   * craft's SIM cruise, or the tow's velocity, with the attitude and elevator for 1 g).
   */
  function resetActiveModel(pose) {
    // Every new pose starts without the parking brake; placeOnGround sets it again when needed.
    parkingBrake.release();
    if (mode === 'sim' && sim) {
      speedBlend.active = false;
      sim.reset(pose);
      if (!pose.onGround) startSpeedBlend(trimSim());
      resetInterpolationFromModel();
      writePlayerFromSim();
    } else {
      classicWind.set(0, 0, 0);
      arcade.reset(pose);
    }
    telemetryPrimed = false;
  }

  /**
   * Level flight at cruise (or a hover) at a point, heading kept: spawns, respawns, airstarts. In SIM
   * the cruise is an airspeed, so the air's own motion at the point is added to the velocity.
   */
  function airbornePose(position, heading) {
    const quaternion = levelQuaternion(heading);
    const speed = craft.spawn.hover ? 0 : mode === 'sim' ? simCruise() : arcadeCruise();
    const velocity = vectorFromHeading(heading).multiplyScalar(speed);
    if (mode === 'sim' && speed > 0 && ctx.wind && typeof ctx.wind.sample === 'function') {
      ctx.wind.sample(position, state.time.elapsed, windSample);
      if (isFiniteVector(windSample.vel)) velocity.add(windSample.vel);
    }
    return {
      position: position.clone(),
      quaternion,
      velocity,
      angularVelocity: new THREE.Vector3(),
      throttle: cruiseThrottle(),
      onGround: false,
      engineOn: true,
    };
  }

  function currentHeading() {
    return Number.isFinite(player.heading) ? player.heading : 0;
  }

  // ============================================================================================
  // START ON GROUND
  // ============================================================================================
  function shouldStartOnGround() {
    return mode === 'sim' && settings.get('startOnGround') === true && craft.spawn.canStartOnGround === true;
  }

  /** At rest on the gear on nearby flat, dry ground clear of trees and rocks, nose into the wind. */
  function placeOnGround(x, z) {
    const spot = findFlatSpot(world, x, z, {
      waterLevel: CONFIG.WATER_LEVEL,
      headingFor: (spotX, spotZ) => windHeadingAt(spotX, spotZ),
      clearance: vegetationClearance(craft.simProfile.contacts, undefined, craft.spawn.runwayLength),
      runwayLength: craft.spawn.runwayLength,
    });
    const heading = windHeadingAt(spot.x, spot.z);
    const pose = groundPose(world, craft.simProfile.contacts, spot.x, spot.z, heading, craft.simProfile.centerOfMass?.[2] ?? 0);
    resetActiveModel({
      position: pose.position,
      quaternion: pose.quaternion,
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      throttle: 0,
      onGround: true,
      engineOn: true,
    });
    player.heading = heading;
    setParkingBrake();
    return { spot, pose };
  }

  /**
   * On the ground with power: a throttle no physical lever holds goes to idle (the input system knows
   * which); a lever still above idle (a HOTAS throttle) sets the parking brake instead.
   */
  function setParkingBrake() {
    if (craft.inputProfile?.throttle === 'none') return;
    ctx.systems.input?.idleThrottle?.();
    if (parkingBrake.engage(pilotThrottle())) notify('Parking brake set - move the throttle to taxi', 'info');
  }

  /** Each tick while set: release on the pilot's input, else hold the wheels at idle. */
  function applyParkingBrake(controls) {
    if (!parkingBrake.engaged) return;
    const reason = parkingBrake.releaseReason(liveControls, player.autopilot.enabled);
    if (reason) {
      parkingBrake.release();
      const messages = { throttle: 'Parking brake released.', brakes: 'Parking brake released: the brakes are yours.', airbrake: 'Parking brake released: the brakes are yours.', autopilot: 'Parking brake released for the autopilot.' };
      notify(messages[reason], 'info');
      return;
    }
    parkingBrake.hold(controls);
  }

  /** Heading into the wind (the direction the ambient wind blows from). */
  function windHeadingAt(x, z) {
    const surface = surfaceHeight(x, z);
    const ambient = typeof ctx.wind?.ambientAt === 'function' ? ctx.wind.ambientAt({ x, y: surface + 10, z }) : null;
    return ambient && Number.isFinite(ambient.fromDegrees) && ambient.speed > 0.2 ? wrapDegrees(ambient.fromDegrees) : currentHeading();
  }

  // ============================================================================================
  // MODE SWITCHING
  // ============================================================================================
  function emitModeChanged(previous) {
    counters.modeSwitches++;
    telemetry.mode = mode;
    bus.emitTyped('modeChanged', { mode, previous });
  }

  function resetModelTelemetry() {
    for (const field of MODEL_TELEMETRY_FIELDS) {
      const fallback = telemetryDefaults[field];
      if (Array.isArray(fallback)) telemetry[field] = [];
      else if (fallback && typeof fallback === 'object') telemetry[field] = { ...fallback };
      else telemetry[field] = fallback;
    }
  }

  /**
   * CLASSIC -> SIM. Returns false (and says why) when this craft has no SIM model yet.
   *
   * A switch mid-flight keeps the position, the velocity vector and the heading, and gives the SIM
   * model a consistent trimmed state (trim.js): the attitude is the flight path plus the 1 g angle of
   * attack for the airspeed and craft (clamped to the stall margin), the roll is kept within the bank
   * protection, the rates are those of a steady turn at that bank, the elevator sits at its trimmed
   * deflection and the assists start from that trim with the path and speed holds captured. The
   * CLASSIC attitude (which has no angle of attack of its own) differs from that by a few degrees; the
   * 0.5 s visual blend hides the difference. A speed outside the craft's safe range eases into it over
   * the same 0.5 s (startSpeedBlend).
   *
   * At boot (initial) there is no CLASSIC flight to carry over: the craft starts at its SIM cruise
   * speed, level at the spawn point (or on the ground with "Start on ground").
   */
  function enterSim({ initial = false } = {}) {
    if (!simAvailable()) {
      notify(`SIM flight for the ${craftLabel(craftId)} is not available yet, so we're staying in CLASSIC.`, 'warning');
      return false;
    }
    if (crash.active) finishCrash();
    releaseTow('mode change');
    const displayed = initial ? null : captureDisplayedPose();
    const pose = capturePose();
    let model;
    try {
      model = createSimModel(simKind());
    } catch (error) {
      console.error(`[DRIFTWING] SIM model "${simKind()}" for ${craftId} failed to start`, error);
      notify(`SIM flight for the ${craftLabel(craftId)} could not start, so we're staying in CLASSIC.`, 'warning');
      return false;
    }
    sim = model;
    mode = 'sim';
    resetModelTelemetry();
    if (initial && shouldStartOnGround()) placeOnGround(player.position.x, player.position.z);
    else if (initial) resetActiveModel(airbornePose(pose.position, headingOfQuaternion(pose.quaternion, currentHeading())));
    else {
      pose.engineOn = true;
      speedBlend.active = false;
      sim.reset(pose);
      if (!pose.onGround) {
        const bank = clamp(sim.flightData ? sim.flightData.bank : 0, -CONVERSION_MAX_BANK, CONVERSION_MAX_BANK);
        startSpeedBlend(trimSim(Number.isFinite(bank) ? bank : 0));
      }
      resetInterpolationFromModel();
    }
    writePlayerFromSim();
    player.boost.active = false;
    player.boost.remaining = 0;
    player.barrelRoll.active = false;
    player.barrelRoll.progress = 0;
    startBlend(displayed);
    telemetryPrimed = false;
    return true;
  }

  /**
   * SIM -> CLASSIC: velocity vector -> arcade speed and path, bank limited, lifted off the ground.
   * Hover craft keep hovering: throttle 0.5 (hold height), and a landed one lifts to its hover floor.
   */
  function enterClassic() {
    if (crash.active) finishCrash();
    releaseTow('mode change');
    releaseOverride('mode change', { silent: true });
    const displayed = captureDisplayedPose();
    const pose = capturePose();
    const onGround = pose.onGround;
    disposeSim();
    parkingBrake.release();
    mode = 'classic';
    resetModelTelemetry();
    refreshClassicWindTarget(pose.position);
    classicWind.copy(classicWindTarget);
    pose.velocity.sub(classicWind);
    const arcadeSpeed = craft.arcadeProfile.SPEED;
    const hover = craft.arcadeProfile.hover;
    if (hover) {
      // Rotorcraft: the hover model holds its height at throttle 0.5 (a SIM throttle is a motor or
      // collective command, not that), and a landed craft lifts to its hover floor and hovers there.
      if (onGround) {
        const heading = headingOfQuaternion(pose.quaternion, currentHeading());
        pose.position.y = Math.max(pose.position.y, surfaceHeight(pose.position.x, pose.position.z) + hover.MIN_AGL + CLASSIC_HOVER_LIFT);
        levelQuaternion(heading, pose.quaternion);
        pose.velocity.set(0, 0, 0);
      }
      pose.throttle = craft.arcadeProfile.AUTOPILOT.CRUISE_THROTTLE;
    } else if (onGround) {
      // CLASSIC cannot sit on the ground: level off at cruise a little higher (the blend hides the lift).
      // In the air the velocity carries over; the arcade model clamps it to its own speed range.
      const heading = headingOfQuaternion(pose.quaternion, currentHeading());
      const floor = surfaceHeight(pose.position.x, pose.position.z) + 30;
      pose.position.y = Math.max(pose.position.y, floor);
      levelQuaternion(heading, pose.quaternion);
      vectorFromHeading(heading, pose.velocity).multiplyScalar(arcadeSpeed.CRUISE);
    }
    // In the air the velocity carries over, but never below the arcade's soft-stall exit speed: a SIM
    // craft flying slower than CLASSIC can (the glider's SIM cruise is under the arcade stall) would
    // otherwise drop its nose the moment it switched. The rendered pose blends as always. Hover craft
    // have no stall, so a slow drift stays a slow drift.
    const classicFloor = arcadeSpeed.STALL + CLASSIC_STALL_MARGIN;
    const carried = pose.velocity.length();
    if (!hover && !onGround && carried > 1 && carried < classicFloor) pose.velocity.multiplyScalar(classicFloor / carried);
    // Craft without an engine in SIM (throttle 'none') and craft taking off from the ground cruise.
    if (onGround || craft.inputProfile?.throttle === 'none' || !Number.isFinite(pose.throttle)) pose.throttle = craft.arcadeProfile.AUTOPILOT.CRUISE_THROTTLE;
    // A SIM altitude hold may sit above the CLASSIC ceiling; hold what CLASSIC can reach instead.
    const autopilot = player.autopilot;
    if (autopilot.enabled) autopilot.altitude = clamp(autopilot.altitude, AUTOPILOT_MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    arcade.reset(pose);
    clock.reset();
    startBlend(displayed);
    telemetryPrimed = false;
    return true;
  }

  function applyMode(next) {
    if (next === mode) return true;
    const previous = mode;
    const done = next === 'sim' ? enterSim() : enterClassic();
    if (done) emitModeChanged(previous);
    return done;
  }

  /** settings.mode is the command channel: apply, or write the current mode back. */
  function onModeSetting(value) {
    if (value === mode) return;
    if (!applyMode(value)) settings.set('mode', mode);
  }

  // ============================================================================================
  // CRAFT SWITCHING
  // ============================================================================================
  function applyCraft(nextId) {
    if (nextId === craftId) return true;
    if (!registry.has(nextId)) {
      notify(`The ${craftLabel(nextId)} isn't ready to fly yet.`, 'warning');
      return false;
    }
    if (crash.active) finishCrash();
    releaseTow('craft change');
    const previous = craftId;
    const pose = capturePose();
    const wasOnGround = pose.onGround;
    disposeCraft();
    clearBlend();
    try {
      installCraft(nextId);
    } catch (error) {
      // A craft that fails to build must not take the flight system down: fly the previous one on.
      console.error(`[DRIFTWING] craft "${nextId}" failed to load`, error);
      if (mesh) {
        scene.remove(mesh.root);
        mesh.dispose();
        mesh = null;
      }
      installCraft(previous);
      if (mode === 'sim' && simAvailable()) sim = createSimModel(simKind());
      resetModelTelemetry();
      spawnAfterCraftChange(pose, wasOnGround);
      syncVisual();
      snapCamera();
      settings.set('craft', previous);
      notify(`The ${craftLabel(nextId)} could not be loaded, so you're still flying the ${craftLabel(previous)}.`, 'warning');
      return false;
    }
    let modeFellBack = false;
    if (mode === 'sim') {
      if (simAvailable()) {
        try {
          sim = createSimModel(simKind());
          resetModelTelemetry();
        } catch (error) {
          console.error(`[DRIFTWING] SIM model "${simKind()}" for ${nextId} failed to start`, error);
          modeFellBack = true;
        }
      } else {
        modeFellBack = true;
      }
      if (modeFellBack) {
        mode = 'classic';
        releaseOverride('mode change', { silent: true });
        resetModelTelemetry();
        notify(`SIM flight for the ${craftLabel(nextId)} is not available yet, so it flies in CLASSIC.`, 'warning');
      }
    }
    spawnAfterCraftChange(pose, wasOnGround);
    counters.craftSwitches++;
    telemetry.craft = craftId;
    syncVisual();
    snapCamera();
    bus.emitTyped('craftChanged', { craft: craftId, previous });
    if (modeFellBack) {
      settings.set('mode', 'classic');
      emitModeChanged('sim');
    }
    return true;
  }

  /**
   * A sensible start for the new craft at the old craft's place: peak launchers low down relaunch
   * from a peak, ground starters go on the ground when asked (or when the old craft was landed),
   * everything else flies level at cruise (hovering craft hover), lifted clear of the ground.
   */
  function spawnAfterCraftChange(pose, wasOnGround) {
    const heading = headingOfQuaternion(pose.quaternion, currentHeading());
    const position = pose.position;
    const agl = position.y - surfaceHeight(position.x, position.z);
    if (craft.spawn.relaunch === 'peak' && agl < PEAK_RELAUNCH_BELOW_AGL) {
      resetActiveModel(airbornePose(position, heading));
      launchFromPeak();
      return;
    }
    if (mode === 'sim' && craft.spawn.canStartOnGround && (shouldStartOnGround() || wasOnGround)) {
      placeOnGround(position.x, position.z);
      return;
    }
    const spawnPosition = position.clone();
    if (agl < MIN_SPAWN_AGL) spawnPosition.y = surfaceHeight(position.x, position.z) + SPAWN_LIFT_AGL;
    resetActiveModel(airbornePose(spawnPosition, heading));
  }

  function onCraftSetting(value) {
    if (value === craftId) return;
    if (!applyCraft(value)) settings.set('craft', craftId);
  }

  function selectCraft(id) {
    if (!registry.has(id)) {
      notify(`The ${craftLabel(id)} isn't ready to fly yet.`, 'warning');
      return false;
    }
    settings.set('craft', id);
    return craftId === id;
  }

  // ============================================================================================
  // SOFT CRASH AND RESPAWN (SIM only; there is no fail state)
  // ============================================================================================
  function triggerSoftCrash(reason = 'impact', details = {}) {
    if (mode !== 'sim' || crash.active || tow) return false;
    const position = sim ? sim.state.position : player.position;
    const velocity = sim ? sim.state.velocity : player.velocity;
    const impactSpeed = Number.isFinite(details.impactSpeed) ? details.impactSpeed : velocity.length();
    crash.active = true;
    crash.phase = 'fadeIn';
    crash.elapsed = 0;
    crash.reason = String(reason);
    counters.softCrashes++;
    if (!crashFade) crashFade = createCrashFade();
    crashFade.setOpacity(0);
    bus.emitTyped('softCrash', { craft: craftId, reason: crash.reason, impactSpeed: Number.isFinite(impactSpeed) ? impactSpeed : 0, position: vectorLiteral(position) });
    return true;
  }

  function respawnAfterCrash() {
    clearModelActions();
    const position = sim ? sim.state.position : player.position;
    // Craft that cannot climb (spawn.respawn 'peak': the wingsuit) start again from the nearest peak.
    if (craft.spawn.respawn === 'peak' && isFiniteVector(position)) {
      launchFromPeak();
      return;
    }
    const heading = sim ? headingOfQuaternion(sim.state.quaternion, currentHeading()) : currentHeading();
    const x = Number.isFinite(position.x) ? position.x : player.position.x;
    const z = Number.isFinite(position.z) ? position.z : player.position.z;
    const spawnPosition = new THREE.Vector3(x, surfaceHeight(x, z) + RESPAWN_AGL, z);
    resetActiveModel(airbornePose(spawnPosition, heading));
    player.heading = heading;
    syncVisual();
    snapCamera();
    notify('Soft reset: back in the air.', 'info');
  }

  function updateCrash(dt) {
    if (!crash.active) return;
    crash.elapsed += dt;
    const progress = clamp(crash.elapsed / CRASH_FADE_SECONDS, 0, 1);
    if (crash.phase === 'fadeIn') {
      crashFade.setOpacity(progress);
      if (progress >= 1) {
        respawnAfterCrash();
        crash.phase = 'fadeOut';
        crash.elapsed = 0;
      }
    } else {
      crashFade.setOpacity(1 - progress);
      if (progress >= 1) finishCrash();
    }
  }

  function finishCrash() {
    if (crash.phase === 'fadeIn') respawnAfterCrash();
    crash.active = false;
    crash.phase = 'idle';
    crash.elapsed = 0;
    crashFade?.setOpacity(0);
  }

  function crashProgress() {
    if (!crash.active) return 0;
    const progress = clamp(crash.elapsed / CRASH_FADE_SECONDS, 0, 1);
    return crash.phase === 'fadeIn' ? progress * 0.5 : 0.5 + progress * 0.5;
  }

  /** Reads the model's contact result after a tick; returns a crash reason or null. */
  function contactOutcome(model) {
    const contact = model.contact || {};
    const limits = craft.limits;
    const position = model.state.position;
    if (contact.bodyStrike) {
      const strikeSpeed = Number.isFinite(contact.bodyStrike.speed) ? contact.bodyStrike.speed : model.state.velocity.length();
      const limit = Number.isFinite(limits.bodyStrikeSpeed) ? limits.bodyStrikeSpeed : DEFAULT_BODY_STRIKE_SPEED;
      if (strikeSpeed > limit) return { reason: `${contact.bodyStrike.part ?? 'airframe'} strike`, impactSpeed: strikeSpeed };
    }
    if (contact.touchdown && Number.isFinite(contact.touchdown.sinkRate) && contact.touchdown.sinkRate > limits.crashSinkRate) {
      return { reason: 'hard landing', impactSpeed: contact.touchdown.sinkRate };
    }
    if (contact.water && !limits.floats) return { reason: 'water', impactSpeed: model.state.velocity.length() };
    if (Number.isFinite(contact.penetration) && contact.penetration > PENETRATION_LIMIT) return { reason: 'terrain', impactSpeed: model.state.velocity.length() };
    // Last-resort guards on the shared height function and the sea, whatever the model reported.
    if (position.y < world.groundHeight(position.x, position.z) - PENETRATION_LIMIT) return { reason: 'terrain', impactSpeed: model.state.velocity.length() };
    if (!limits.floats && position.y < CONFIG.WATER_LEVEL - PENETRATION_LIMIT) return { reason: 'water', impactSpeed: model.state.velocity.length() };
    return null;
  }

  // ============================================================================================
  // RELAUNCH (aerotow, peak launch, airstart)
  // ============================================================================================
  function relaunch() {
    if (crash.active || tow) return false;
    const method = craft.spawn.relaunch;
    if (method === 'aerotow') return startAerotow();
    if (method === 'peak') return launchFromPeak();
    return airstart();
  }

  function emitRelaunched(method) {
    counters.relaunches++;
    const position = mode === 'sim' && sim ? sim.state.position : player.position;
    bus.emitTyped('relaunched', { craft: craftId, method, position: vectorLiteral(position) });
  }

  function airstart() {
    const position = mode === 'sim' && sim ? sim.state.position : player.position;
    const spawnPosition = new THREE.Vector3(position.x, surfaceHeight(position.x, position.z) + AIRSTART_AGL, position.z);
    resetActiveModel(airbornePose(spawnPosition, currentHeading()));
    clearBlend();
    syncVisual();
    snapCamera();
    emitRelaunched('airstart');
    return true;
  }

  function launchFromPeak() {
    const position = mode === 'sim' && sim ? sim.state.position : player.position;
    const peak = findNearestPeak(world, position.x, position.z);
    if (!peak) {
      notify('No high peak nearby, so we start from the air.', 'info');
      return airstart();
    }
    const dive = craft.spawn.peakDive;
    const launch = planPeakLaunch(world, peak, dive ? { diveAngle: dive.angle } : undefined);
    const pose = airbornePose(launch.position, launch.heading);
    // Craft with a peak dive leave the edge nose down at their launch speed instead of level at cruise.
    if (dive && Number.isFinite(launch.pitch)) {
      pose.quaternion.multiply(scratchQuaternion.setFromAxisAngle(scratchRight.set(1, 0, 0), launch.pitch * DEG));
      pose.velocity.set(0, 0, -(mode === 'sim' ? dive.speed : dive.classicSpeed)).applyQuaternion(pose.quaternion);
    }
    resetActiveModel(pose);
    player.heading = launch.heading;
    clearBlend();
    syncVisual();
    snapCamera();
    notify(`Launching from a ${Math.round(peak.height)} m peak.`, 'info');
    emitRelaunched('peak');
    return true;
  }

  function startAerotow() {
    const pose = capturePose();
    const surface = surfaceHeight(pose.position.x, pose.position.z);
    if (pose.position.y - surface >= TOW_REFUSE_AGL) {
      notify('We are already above tow height.', 'info');
      return false;
    }
    const tugModule = registry.get('bushplane');
    if (!tugModule) {
      notify('No tow plane is available.', 'warning');
      return false;
    }
    const heading = headingOfQuaternion(pose.quaternion, currentHeading());
    const releaseSpeed = mode === 'sim' ? simCruise() : arcadeCruise();
    tow = createAerotow({
      scene,
      world,
      waterLevel: CONFIG.WATER_LEVEL,
      start: pose.position,
      startQuaternion: pose.quaternion,
      heading,
      startSpeed: Math.hypot(pose.velocity.x, pose.velocity.z),
      releaseSpeed,
      releaseAgl: TOW_RELEASE_AGL,
      tug: tugModule.buildMesh(ctx),
      gliderHook: mesh.anchors?.towHook ?? new THREE.Vector3(0, 0, -2),
      ropeMaterial,
      time: state.time,
    });
    clearBlend();
    trails.clear();
    notify('Aerotow: hooking up to the tug.', 'info');
    return true;
  }

  const ZERO_WIND = new THREE.Vector3();
  const towVisual = { aileron: 0, elevator: 0, rudder: 0, flaps: 0, throttle: 0, boost: false, propSpeed: NaN, engineOn: true, onGround: false, gearDown: true, airbrake: 0, time: state.time };

  /** Towing: the tow drives the craft's pose; at release the model takes over at the tow's velocity. */
  function updateTow(dt) {
    const status = tow.update(dt);
    writePlayerPose(status.position, status.quaternion, status.velocity, ZERO_WIND);
    towVisual.throttle = player.throttle;
    towVisual.time = state.time;
    if (dt > 0) mesh.update(towVisual, Math.min(dt, 0.05));
    if (!status.released) return;
    const releasePose = {
      position: status.position.clone(),
      quaternion: status.quaternion.clone(),
      velocity: status.velocity.clone(),
      angularVelocity: new THREE.Vector3(),
      throttle: mode === 'sim' ? 0 : cruiseThrottle(),
      onGround: false,
      engineOn: true,
    };
    departingTows.push(tow);
    tow = null;
    resetActiveModel(releasePose);
    const releasedAgl = Math.round(releasePose.position.y - surfaceHeight(releasePose.position.x, releasePose.position.z));
    notify(`Released at ${releasedAgl} m above the ground. Good lift!`, 'success');
    emitRelaunched('aerotow');
  }

  function updateDepartingTows(dt) {
    for (let index = departingTows.length - 1; index >= 0; index--) {
      const departing = departingTows[index];
      departing.update(dt);
      if (departing.finished) {
        departing.dispose();
        departingTows.splice(index, 1);
      }
    }
  }

  /** Ends a tow early (mode or craft change): the craft keeps flying from where it is. */
  function releaseTow(reason) {
    if (!tow) return;
    const releasing = tow;
    tow = null;
    releasing.release(reason);
    departingTows.push(releasing);
    const pose = { position: player.position.clone(), quaternion: player.quaternion.clone(), velocity: player.velocity.clone(), angularVelocity: new THREE.Vector3(), throttle: cruiseThrottle(), onGround: false, engineOn: true };
    resetActiveModel(pose);
  }

  // ============================================================================================
  // HOT-PLUG: hands-off assists while a disconnected device was flying (SIM)
  // ============================================================================================
  /**
   * True when the disconnected controller was the last one to move a flight axis. The match is by
   * deviceKey (ControlState.sourceDevices), so a HOTAS stick is recognised and another gamepad that
   * was not flying is not.
   */
  function deviceDrivesAxes(device) {
    const sourceDevices = liveControls.sourceDevices || {};
    return Boolean(device.deviceKey) && ['roll', 'pitch', 'yaw', 'throttle', 'collective'].some((axis) => sourceDevices[axis] === device.deviceKey);
  }

  function engageOverride(device) {
    override.active = true;
    override.deviceKey = device.deviceKey;
    override.kind = device.kind;
    override.name = device.name || 'Controller';
    override.manualSeconds = 0;
    override.savedAutopilot = { ...player.autopilot };
    // Hold the speed flown now, not the craft's cruise: the hold promises wings level and altitude only.
    const speed = Number.isFinite(telemetry.airspeed) && telemetry.airspeed > 0 ? telemetry.airspeed : player.speed;
    setAutopilot({ enabled: true, heading: player.heading, altitude: player.position.y, speed, followWaypoint: false, reason: 'device disconnected' });
    notify(`${override.name} disconnected: assists are holding wings level and altitude.`, 'warning');
    bus.emit('flight:assistOverride', { active: true, reason: 'deviceDisconnected', deviceKey: override.deviceKey });
  }

  function releaseOverride(reason, { silent = false } = {}) {
    if (!override.active) return;
    override.active = false;
    const saved = override.savedAutopilot;
    override.savedAutopilot = null;
    if (saved) setAutopilot({ enabled: saved.enabled, heading: saved.heading, altitude: saved.altitude, speed: saved.speed, followWaypoint: saved.followWaypoint, reason });
    if (!silent) notify(reason === 'device reconnected' ? `${override.name} reconnected: you have control.` : 'You have control.', 'success');
    bus.emit('flight:assistOverride', { active: false, reason });
  }

  /**
   * A controller lost on the ground: no autopilot (it would release the parking brake, and a
   * helicopter or drone would lift off by itself). A throttle no lever holds any more goes to idle and
   * a lever still above idle sets the parking brake, as on a ground start.
   */
  function holdOnGround(device) {
    const name = device.name || 'Controller';
    if (craft.inputProfile?.throttle === 'none') {
      notify(`${name} disconnected.`, 'warning');
      return;
    }
    ctx.systems.input?.idleThrottle?.();
    const braked = parkingBrake.engage(pilotThrottle());
    notify(braked ? `${name} disconnected: parking brake set - move the throttle to taxi.` : `${name} disconnected: throttle at idle.`, 'warning');
  }

  function isOnGround() {
    return Boolean(sim && sim.contact && sim.contact.onGround);
  }

  bus.onTyped('deviceDisconnected', (device) => {
    if (mode !== 'sim' || override.active || !device || !deviceDrivesAxes(device)) return;
    // Mid-flight only: the hold flies the autopilot, which must never take off on its own.
    if (isOnGround()) holdOnGround(device);
    else engageOverride(device);
  });
  bus.onTyped('deviceConnected', (device) => {
    if (!override.active || !device) return;
    if (device.deviceKey === override.deviceKey) releaseOverride('device reconnected');
  });

  /** Another device moving the stick for a moment takes control back from the hands-off hold. */
  function checkManualTakeover(dt) {
    if (!override.active) return;
    const manual = Math.max(Math.abs(liveControls.roll), Math.abs(liveControls.pitch), Math.abs(liveControls.yaw));
    override.manualSeconds = manual > OVERRIDE_INPUT ? override.manualSeconds + dt : 0;
    if (override.manualSeconds >= OVERRIDE_SECONDS) releaseOverride('manual input');
  }

  // ============================================================================================
  // AUTOPILOT (v1 options; CLASSIC delegates to the arcade model, SIM flies through control stages)
  // ============================================================================================
  function setAutopilot(options = {}) {
    if (mode === 'classic') return arcade.setAutopilot(options);
    const autopilot = player.autopilot;
    const wasEnabled = autopilot.enabled;
    const ceiling = mode === 'sim' ? SIM_CEILING : CONFIG.MAX_ALTITUDE;
    if (typeof options.enabled === 'boolean') autopilot.enabled = options.enabled;
    const engaging = autopilot.enabled && !wasEnabled;
    if (Number.isFinite(options.heading)) autopilot.heading = wrapDegrees(options.heading);
    else if (engaging) autopilot.heading = player.heading;
    if (Number.isFinite(options.altitude)) autopilot.altitude = clamp(options.altitude, AUTOPILOT_MIN_ALTITUDE, ceiling - 150);
    else if (engaging) autopilot.altitude = clamp(player.position.y, AUTOPILOT_MIN_ALTITUDE, ceiling - 150);
    if (Number.isFinite(options.speed)) autopilot.speed = Math.max(0, options.speed);
    else if (engaging || !Number.isFinite(autopilot.speed)) autopilot.speed = simCruise();
    if (typeof options.followWaypoint === 'boolean') autopilot.followWaypoint = options.followWaypoint;
    if (engaging) autopilotOverride.seconds = 0;
    const reason = typeof options.reason === 'string' && options.reason ? options.reason : 'command';
    bus.emit('autopilot:changed', {
      enabled: autopilot.enabled,
      heading: autopilot.heading,
      altitude: autopilot.altitude,
      followWaypoint: autopilot.followWaypoint,
      reason,
    });
    return { ...autopilot };
  }

  /** SIM: v1's waypoint / ring following turns into heading (and ring altitude) targets. */
  function updateSimAutopilotTarget() {
    const autopilot = player.autopilot;
    if (!autopilot.enabled || !autopilot.followWaypoint) return;
    const position = sim.state.position;
    const course = state.ringCourse;
    const ring = course && course.active ? course.nextRingPosition : null;
    if (ring && Number.isFinite(ring.x) && Number.isFinite(ring.z)) {
      autopilot.heading = bearingTo(position.x, position.z, ring.x, ring.z);
      if (Number.isFinite(ring.y)) autopilot.altitude = ring.y;
    } else if (state.waypoint && Number.isFinite(state.waypoint.x) && Number.isFinite(state.waypoint.z)) {
      autopilot.heading = bearingTo(position.x, position.z, state.waypoint.x, state.waypoint.z);
    }
  }

  /** SIM: holding the stick past 35 % for 0.25 s hands control back, like v1. */
  function updateSimAutopilotOverride(dt) {
    if (!player.autopilot.enabled || override.active) {
      autopilotOverride.seconds = 0;
      return;
    }
    const manual = Math.max(Math.abs(liveControls.roll), Math.abs(liveControls.pitch), Math.abs(liveControls.yaw));
    if (manual > OVERRIDE_INPUT) {
      autopilotOverride.seconds += dt;
      if (autopilotOverride.seconds >= OVERRIDE_SECONDS) setAutopilot({ enabled: false, reason: 'manual override' });
    } else {
      autopilotOverride.seconds = 0;
    }
  }

  // ============================================================================================
  // ACTIONS
  // ============================================================================================
  bus.on('input:action', (action) => {
    if (!action || action.phase !== 'press' || !FLIGHT_ACTIONS.has(action.id)) return;
    // A press from a device in the same frame keeps the model's toast: the pilot did it too.
    if (action.source === 'copilot' && !pendingActions.has(action.id)) copilotActions.add(action.id);
    else copilotActions.delete(action.id);
    pendingActions.add(action.id);
  });

  /** Flight-owned ids from ControlState.actions and input:action events (a press counts once per frame). */
  function collectActions() {
    for (const id of liveControls.actions) {
      if (!FLIGHT_ACTIONS.has(id)) continue;
      pendingActions.add(id);
      copilotActions.delete(id);
      liveControls.actions.delete(id);
    }
  }

  /**
   * True while the SIM model takes actions on its next tick. During the crash fade (no ticks until the
   * respawn) and an aerotow (the tow flies the craft) a model action would fire later, on a different
   * pose, so it is dropped.
   */
  function modelAcceptsActions() {
    return mode === 'sim' && !tow && !(crash.active && crash.phase === 'fadeIn');
  }

  function performActions() {
    if (pendingActions.size === 0) return;
    const actions = [...pendingActions];
    const fromCopilot = new Set(copilotActions);
    pendingActions.clear();
    copilotActions.clear();
    for (const id of actions) {
      if (MODEL_ACTIONS.has(id)) {
        if (modelAcceptsActions()) {
          modelActions.add(id);
          if (fromCopilot.has(id)) quietModelActions.add(id);
          else quietModelActions.delete(id);
        }
        continue;
      }
      performAction(id);
    }
  }

  function performAction(id) {
    switch (id) {
      case 'modeToggle':
        settings.set('mode', mode === 'sim' ? 'classic' : 'sim');
        return;
      case 'craftNext':
      case 'craftPrev': {
        const next = registry.step(craftId, id === 'craftNext' ? 1 : -1);
        if (next && next !== craftId) settings.set('craft', next);
        return;
      }
      case 'relaunch':
        relaunch();
        return;
      case 'craftAbility':
        runAbility();
        return;
      case 'boost':
        boost();
        return;
      default: {
        const selectIndex = CRAFT_SELECT_ACTIONS.indexOf(id);
        if (selectIndex >= 0) {
          const entry = registry.catalog[selectIndex];
          if (entry) selectCraft(entry.id);
        }
      }
    }
  }

  // ============================================================================================
  // CRAFT ABILITY
  // ============================================================================================
  const abilityApi = {
    get craftState() { return craftState; },
    get mode() { return mode; },
    get craft() { return craftId; },
    get telemetry() { return telemetry; },
    get player() { return player; },
    notify,
    /** The craft's relaunch (aerotow, peak launch, airstart), for abilities that bring the craft back up. */
    relaunch() {
      return relaunch();
    },
    /** Emits a particle trail ('smoke' | 'spray') from one of the mesh's named anchors; it drifts with the wind. */
    emitTrail(kind, anchorName, dt) {
      const anchor = mesh && mesh.anchors ? mesh.anchors[anchorName] : null;
      if (!anchor) return false;
      scratchVector.copy(anchor).applyQuaternion(mesh.root.quaternion).add(mesh.root.position);
      trails.emit(kind, scratchVector, telemetry.velocity, dt, telemetry.wind);
      return true;
    },
  };

  /** craftAbility: the craft's ability where it supports the mode; CLASSIC otherwise boosts (v1). */
  function runAbility() {
    const ability = craft.abilities?.craftAbility;
    const modes = ability && Array.isArray(ability.modes) ? ability.modes : ['sim'];
    if (ability && typeof ability.run === 'function' && modes.includes(mode)) return ability.run(abilityApi) !== false;
    if (mode === 'classic') return boost();
    return false;
  }

  function updateAbility(dt) {
    const ability = craft.abilities?.craftAbility;
    if (ability && typeof ability.update === 'function' && dt > 0) ability.update(abilityApi, dt);
  }

  // ============================================================================================
  // CLASSIC
  // ============================================================================================
  function refreshClassicWindTarget(position) {
    if (!ctx.wind || typeof ctx.wind.sample !== 'function') {
      classicWindTarget.set(0, 0, 0);
      return;
    }
    ctx.wind.sample(position, state.time.elapsed, windSample);
    const gust = ctx.wind.lastLayers ? ctx.wind.lastLayers.gust : null;
    classicWindTarget.copy(windSample.vel);
    if (gust) classicWindTarget.sub(gust);
    classicWindTarget.x *= CLASSIC_WIND.HORIZONTAL_SHARE;
    classicWindTarget.z *= CLASSIC_WIND.HORIZONTAL_SHARE;
    classicWindTarget.y *= CLASSIC_WIND.VERTICAL_SHARE;
    if (!isFiniteVector(classicWindTarget)) classicWindTarget.set(0, 0, 0);
  }

  /** One v1 frame, then the subtle wind drift (position only: the arcade path stays v1's). */
  function updateClassic(simDt) {
    if (!(simDt > 0)) return;
    const step = Math.min(simDt, 0.05);
    arcade.step(simDt, input);
    refreshClassicWindTarget(player.position);
    classicWind.x = damp(classicWind.x, classicWindTarget.x, CLASSIC_WIND.LAMBDA, step);
    classicWind.y = damp(classicWind.y, classicWindTarget.y, CLASSIC_WIND.LAMBDA, step);
    classicWind.z = damp(classicWind.z, classicWindTarget.z, CLASSIC_WIND.LAMBDA, step);
    if (classicWind.x !== 0 || classicWind.y !== 0 || classicWind.z !== 0) player.position.addScaledVector(classicWind, step);
    mesh.update(arcade.visual, step);
  }

  // ============================================================================================
  // SIM
  // ============================================================================================
  /** Built-in stage: the craft input profile decides what the throttle axis means. */
  function applyInputProfile(controls) {
    const profile = craft.inputProfile || {};
    if (profile.throttle === 'none') controls.throttle = 0;
    else if (profile.throttle === 'collective') controls.collective = controls.throttle;
  }

  let assistLevel = 1;

  function prepareTickControls(firstTick) {
    copyControlState(tickControls, liveControls);
    tickControls.actions.clear();
    tickControls.quietActions.clear();
    if (firstTick) {
      for (const id of modelActions) tickControls.actions.add(id);
      for (const id of quietModelActions) tickControls.quietActions.add(id);
      modelActions.clear();
      quietModelActions.clear();
    }
    applyInputProfile(tickControls);
    applyParkingBrake(tickControls);
    env.assists = override.active ? 1 : assistLevel;
    env.handsOff = override.active;
    if (override.active) {
      tickControls.roll = 0;
      tickControls.pitch = 0;
      tickControls.yaw = 0;
    }
    stageContext.model = sim;
    stageContext.craft = craft;
    stageContext.craftId = craftId;
    stageContext.assists = env.assists;
    stageContext.handsOff = env.handsOff;
    stageContext.dt = clock.stepSeconds;
    stageContext.activeAssists.length = 0;
    const stages = typeof models.controlStages === 'function' ? models.controlStages() : [];
    for (const stage of stages) stage.apply(tickControls, stageContext);
  }

  function sampleEnvironment(tickTime) {
    const position = sim.state.position;
    env.time = tickTime;
    if (ctx.wind && typeof ctx.wind.sample === 'function') ctx.wind.sample(position, tickTime, env.wind);
    else {
      env.wind.vel.set(0, 0, 0);
      env.wind.turbulence = 0;
    }
    env.rho = airDensity(position.y);
    env.autopilot = player.autopilot;
  }

  function modelIsFinite(model) {
    const modelState = model.state;
    return isFiniteVector(modelState.position) && isFiniteVector(modelState.velocity) && isFiniteQuaternion(modelState.quaternion)
      && (!modelState.angularVelocity || isFiniteVector(modelState.angularVelocity));
  }

  /** NaN / Infinity guard: restore the last good snapshot, log once per session. */
  function guardModel() {
    if (modelIsFinite(sim)) return true;
    counters.nanRestores++;
    if (!nanReported) {
      nanReported = true;
      console.error(`[DRIFTWING] SIM model "${sim.kind}" produced a non-finite state; restored the last good tick (logged once).`);
    }
    if (lastGoodSnapshot) sim.restore(lastGoodSnapshot);
    if (!modelIsFinite(sim)) {
      const position = isFiniteVector(interpolation.position) ? interpolation.position : player.position;
      sim.reset(airbornePose(position, currentHeading()));
      trimSim();
    }
    resetInterpolationFromModel();
    return false;
  }

  function enforceSimCeiling() {
    const modelState = sim.state;
    if (modelState.position.y <= SIM_CEILING) return;
    modelState.position.y = SIM_CEILING;
    if (modelState.velocity.y > 0) modelState.velocity.y = 0;
  }

  function updateSim(simDt, realDt) {
    checkManualTakeover(realDt);
    updateSimAutopilotOverride(simDt);
    if (crash.active && crash.phase === 'fadeIn') {
      clock.reset();
      return;
    }
    const ticks = clock.advance(state.time.frameDt);
    const assistSetting = settings.get('assists');
    assistLevel = assistSetting && Number.isFinite(assistSetting[craftId]) ? assistSetting[craftId] : 1;
    counters.maxTicksPerFrame = Math.max(counters.maxTicksPerFrame, ticks);
    const stepSeconds = clock.stepSeconds;
    for (let tick = 0; tick < ticks; tick++) {
      applySpeedBlend(stepSeconds);
      interpolation.previousPosition.copy(sim.state.position);
      interpolation.previousQuaternion.copy(sim.state.quaternion);
      interpolation.previousVelocity.copy(sim.state.velocity);
      updateSimAutopilotTarget();
      prepareTickControls(tick === 0);
      sampleEnvironment(state.time.elapsed - (ticks - 1 - tick) * stepSeconds);
      sim.step(stepSeconds, tickControls, env);
      if (!guardModel()) continue;
      enforceSimCeiling();
      const outcome = contactOutcome(sim);
      if (outcome) {
        interpolation.previousPosition.copy(sim.state.position);
        interpolation.previousQuaternion.copy(sim.state.quaternion);
        triggerSoftCrash(outcome.reason, outcome);
        break;
      }
      lastGoodSnapshot = sim.snapshot();
    }
    const alpha = crash.active && crash.phase === 'fadeIn' ? 1 : clamp(clock.alpha, 0, 1);
    interpolation.position.lerpVectors(interpolation.previousPosition, sim.state.position, alpha);
    interpolation.quaternion.slerpQuaternions(interpolation.previousQuaternion, sim.state.quaternion, alpha);
    interpolation.velocity.lerpVectors(interpolation.previousVelocity, sim.state.velocity, alpha);
    telemetry.alpha = alpha;
    writePlayerFromSim();
    if (mesh) {
      writeSimVisual();
      mesh.update(simVisual, simDt);
    }
  }

  const simVisual = { aileron: 0, elevator: 0, rudder: 0, flaps: 0, throttle: 0, boost: false, propSpeed: NaN, engineOn: true, onGround: false, gearDown: true, airbrake: 0, groundSpeed: 0, time: state.time };

  /** Control-surface deflections for the mesh: the model's own when it reports them, else the stick. */
  function writeSimVisual() {
    const surfaces = sim.surfaces || null;
    simVisual.aileron = surfaces && Number.isFinite(surfaces.aileron) ? surfaces.aileron : tickControls.roll;
    simVisual.elevator = surfaces && Number.isFinite(surfaces.elevator) ? surfaces.elevator : tickControls.pitch;
    simVisual.rudder = surfaces && Number.isFinite(surfaces.rudder) ? surfaces.rudder : tickControls.yaw;
    simVisual.flaps = Number.isFinite(telemetry.flaps) ? telemetry.flaps : 0;
    simVisual.throttle = Number.isFinite(telemetry.throttle) ? telemetry.throttle : 0;
    simVisual.propSpeed = surfaces && Number.isFinite(surfaces.propSpeed) ? surfaces.propSpeed : NaN;
    simVisual.engineOn = telemetry.engineOn !== false;
    simVisual.onGround = Boolean(sim.contact && sim.contact.onGround);
    simVisual.gearDown = telemetry.gear ? telemetry.gear.down !== false : true;
    simVisual.airbrake = Number.isFinite(telemetry.airbrake) ? telemetry.airbrake : 0;
    simVisual.groundSpeed = surfaces && Number.isFinite(surfaces.groundSpeed) ? surfaces.groundSpeed : 0;
    simVisual.boost = false;
    simVisual.time = state.time;
  }

  /** state.player (v1 fields) from the interpolated SIM pose, plus the blend offset while blending. */
  function writePlayerFromSim() {
    const position = scratchVector.copy(interpolation.position);
    const quaternion = scratchQuaternion.copy(interpolation.quaternion);
    if (blend.active) {
      position.addScaledVector(blend.positionOffset, blend.weight);
      quaternion.multiply(blend.rotation);
    }
    writePlayerPose(position, quaternion, interpolation.velocity, env.wind.vel);
    if (sim) {
      sim.writeTelemetry(telemetry);
      player.stalled = Boolean(telemetry.stall && telemetry.stall.stalled);
      if (Number.isFinite(telemetry.throttle)) player.throttle = telemetry.throttle;
      if (Number.isFinite(telemetry.gLoad)) player.gForce = telemetry.gLoad;
    }
  }

  let previousPlayerHeading = NaN;

  /** Writes the v1 pose fields (position, attitude axes, velocity, speed, heading, pitch, roll). */
  function writePlayerPose(position, quaternion, velocity, windVelocity) {
    player.position.copy(position);
    player.quaternion.copy(quaternion).normalize();
    player.forward.set(0, 0, -1).applyQuaternion(player.quaternion);
    player.up.set(0, 1, 0).applyQuaternion(player.quaternion);
    player.right.set(1, 0, 0).applyQuaternion(player.quaternion);
    player.velocity.copy(velocity);
    const airVelocity = scratchRight.copy(velocity).sub(windVelocity);
    player.speed = airVelocity.length();
    if (Math.hypot(player.forward.x, player.forward.z) > 0.05) player.heading = headingFromVector(player.forward.x, player.forward.z);
    player.pitch = Math.asin(clamp(player.forward.y, -1, 1)) / DEG;
    player.roll = Math.atan2(-player.right.y, player.up.y) / DEG;
    player.verticalSpeed = velocity.y;
    player.boost.active = false;
    player.barrelRoll.active = false;
  }

  function updatePlayerRates(dt) {
    if (!(dt > 0) || mode === 'classic') return;
    if (Number.isFinite(previousPlayerHeading)) {
      const change = ((((player.heading - previousPlayerHeading + 180) % 360) + 360) % 360 - 180) / dt;
      player.yawRate = damp(player.yawRate, change, 10, dt);
    }
    previousPlayerHeading = player.heading;
  }

  // ============================================================================================
  // VISUAL
  // ============================================================================================
  const visualPosition = new THREE.Vector3();
  const visualQuaternion = new THREE.Quaternion();

  /** Places the model at the (possibly safety-clamped) player pose. The camera calls this too. */
  function syncVisual() {
    if (!mesh) return;
    const root = mesh.root;
    if (mode === 'classic' && !tow) {
      root.position.copy(player.position).add(arcade.corkscrewOffset);
      root.quaternion.copy(player.quaternion).multiply(arcade.wobbleQuaternion);
      if (blend.active) {
        root.position.addScaledVector(blend.positionOffset, blend.weight);
        root.quaternion.multiply(blend.rotation);
      }
      return;
    }
    root.position.copy(player.position);
    root.quaternion.copy(player.quaternion);
  }

  function getBaseQuaternion() {
    if (mode === 'classic' && !tow) {
      if (!blend.active) return arcade.getBaseQuaternion();
      return blend.base.copy(arcade.getBaseQuaternion()).multiply(blend.rotation);
    }
    return player.quaternion;
  }

  const wingtips = [new THREE.Vector3(), new THREE.Vector3()];
  function getWingtips() {
    const root = mesh.root;
    for (let index = 0; index < 2; index++) {
      wingtips[index].copy(mesh.wingtips[index]).applyQuaternion(root.quaternion).add(root.position);
    }
    return wingtips;
  }

  // ============================================================================================
  // TELEMETRY (state.flight): written after core's safety net, from the final pose
  // ============================================================================================
  const bodyAirVelocity = new THREE.Vector3();
  const acceleration = new THREE.Vector3();

  function publishTelemetry(dt = state.time.frameDt) {
    const position = player.position;
    telemetry.mode = mode;
    telemetry.craft = craftId;
    telemetry.tick = clock.tick;
    if (mode === 'classic') telemetry.alpha = 0;
    telemetry.position.copy(position);
    telemetry.quaternion.copy(player.quaternion);

    if (ctx.wind && typeof ctx.wind.sample === 'function') {
      ctx.wind.sample(position, state.time.elapsed, windSample);
      telemetry.wind.copy(windSample.vel);
      telemetry.turbulence = windSample.turbulence;
    }
    if (mode === 'classic' && !tow) {
      telemetry.velocity.copy(player.velocity).add(classicWind);
      telemetry.airVelocity.copy(player.velocity);
    } else {
      telemetry.velocity.copy(player.velocity);
      telemetry.airVelocity.copy(player.velocity).sub(telemetry.wind);
    }
    const airspeed = telemetry.airVelocity.length();
    telemetry.airspeed = airspeed;
    telemetry.indicatedAirspeed = airspeed * Math.sqrt(airDensity(position.y) / SEA_LEVEL_DENSITY);
    telemetry.groundSpeed = Math.hypot(telemetry.velocity.x, telemetry.velocity.z);
    telemetry.mach = airspeed / speedOfSound(position.y);
    const ground = world.groundHeight(position.x, position.z);
    telemetry.altitude = position.y;
    telemetry.agl = position.y - Math.max(ground, CONFIG.WATER_LEVEL);
    telemetry.radarAltitude = telemetry.agl;
    telemetry.verticalSpeed = telemetry.velocity.y;
    telemetry.heading = player.heading;
    telemetry.pitch = player.pitch;
    telemetry.roll = player.roll;

    const step = dt > 0 ? dt : 0;
    if (telemetryPrimed && step > 0) {
      // Body rates from the frame-to-frame attitude change (x pitch up, y nose left, z right wing up).
      angularScratch.copy(previousTelemetryQuaternion).invert().multiply(player.quaternion).normalize();
      if (angularScratch.w < 0) angularScratch.set(-angularScratch.x, -angularScratch.y, -angularScratch.z, -angularScratch.w);
      const angle = 2 * Math.acos(clamp(angularScratch.w, -1, 1));
      const sine = Math.sqrt(Math.max(0, 1 - angularScratch.w * angularScratch.w));
      if (sine > 1e-6) scratchUp.set(angularScratch.x / sine, angularScratch.y / sine, angularScratch.z / sine).multiplyScalar(angle / step);
      else scratchUp.set(0, 0, 0);
      if (mode === 'sim' && sim && sim.state.angularVelocity && !tow) telemetry.angularVelocity.copy(sim.state.angularVelocity);
      else telemetry.angularVelocity.lerp(scratchUp, 1 - Math.exp(-12 * step));
      // Total-energy vario: climb rate plus the height the speed change is worth.
      const energyRate = Number.isFinite(previousAirspeed) ? (airspeed * (airspeed - previousAirspeed)) / (GRAVITY * step) : 0;
      telemetry.vario = damp(telemetry.vario, telemetry.verticalSpeed + energyRate, 3, step);
      acceleration.copy(telemetry.velocity).sub(previousTelemetryVelocity).divideScalar(step);
      acceleration.y += GRAVITY;
      scratchUp.set(0, 1, 0).applyQuaternion(player.quaternion);
      const measuredLoad = acceleration.dot(scratchUp) / GRAVITY;
      if (Number.isFinite(measuredLoad)) telemetry.gLoad = damp(telemetry.gLoad, measuredLoad, 6, step);
    } else if (!telemetryPrimed) {
      telemetry.vario = telemetry.verticalSpeed;
      telemetry.angularVelocity.set(0, 0, 0);
    }
    previousTelemetryQuaternion.copy(player.quaternion);
    previousTelemetryVelocity.copy(telemetry.velocity);
    previousAirspeed = airspeed;
    telemetryPrimed = true;

    // Angle of attack and sideslip from the air velocity in body axes (a model may refine them).
    inverseQuaternion.copy(player.quaternion).invert();
    bodyAirVelocity.copy(telemetry.airVelocity).applyQuaternion(inverseQuaternion);
    if (airspeed > 1) {
      telemetry.aoa = Math.atan2(-bodyAirVelocity.y, -bodyAirVelocity.z) / DEG;
      telemetry.sideslip = Math.asin(clamp(bodyAirVelocity.x / airspeed, -1, 1)) / DEG;
    }
    telemetry.glideRatio = telemetry.verticalSpeed < -0.1 ? telemetry.groundSpeed / -telemetry.verticalSpeed : 0;

    if (mode === 'classic' || tow) {
      if (!tow) arcade.writeTelemetry(telemetry);
      telemetry.gLoad = player.gForce;
      telemetry.onGround = false;
      telemetry.contacts = 0;
    } else if (sim) {
      sim.writeTelemetry(telemetry);
      telemetry.onGround = Boolean(sim.contact && sim.contact.onGround);
    }
    const assistSetting = settings.get('assists');
    telemetry.assists = override.active ? 1 : assistSetting && Number.isFinite(assistSetting[craftId]) ? assistSetting[craftId] : 1;
    if (mode === 'sim') {
      telemetry.activeAssists = [...stageContext.activeAssists];
      if (override.active) telemetry.activeAssists.push('hands-off hold');
    }
    telemetry.autopilot.enabled = player.autopilot.enabled;
    telemetry.autopilot.heading = player.autopilot.heading;
    telemetry.autopilot.altitude = player.autopilot.altitude;
    telemetry.autopilot.speed = Number.isFinite(player.autopilot.speed) ? player.autopilot.speed : 0;
    telemetry.crash.active = crash.active;
    telemetry.crash.reason = crash.reason;
    telemetry.crash.progress = crashProgress();
    telemetry.parkingBrake = mode === 'sim' && parkingBrake.engaged;
    telemetry.craftState = craftState;
  }

  bus.onTyped('landed', (landing) => {
    if (!landing) return;
    const record = { grade: landing.grade, sinkRate: landing.sinkRate, groundSpeed: landing.groundSpeed, craft: landing.craft };
    telemetry.lastLanding = record;
    const best = telemetry.bestLanding;
    const better = !best || LANDING_RANK[record.grade] < LANDING_RANK[best.grade] || (LANDING_RANK[record.grade] === LANDING_RANK[best.grade] && record.sinkRate < best.sinkRate);
    if (better) telemetry.bestLanding = record;
  });

  // ============================================================================================
  // PUBLIC ACTIONS (v1)
  // ============================================================================================
  function boost() {
    if (mode !== 'classic' || tow) return false;
    return arcade.boost();
  }

  function barrelRoll(direction) {
    if (mode !== 'classic' || tow) return false;
    return arcade.barrelRoll(direction);
  }

  /** Level flight at cruise from (x, y, z); also core's recovery path after a non-finite pose. */
  function resetTo(target = {}) {
    const { x, y, z } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    if (tow) releaseTow('reset');
    clearBlend();
    if (mode === 'classic') {
      const done = arcade.resetTo(target);
      classicWind.set(0, 0, 0);
      syncVisual();
      snapCamera();
      return done;
    }
    const heading = Number.isFinite(target.heading) ? wrapDegrees(target.heading) : currentHeading();
    resetActiveModel(airbornePose(new THREE.Vector3(x, y, z), heading));
    player.heading = heading;
    syncVisual();
    snapCamera();
    return true;
  }

  // ============================================================================================
  // BOOT
  // ============================================================================================
  function fallbackCraftId() {
    const available = registry.list().filter((entry) => entry.available);
    if (available.length === 0) throw new Error('no craft modules are registered');
    return available[0].id;
  }

  const requestedCraft = settings.get('craft');
  const initialCraft = registry.has(requestedCraft) ? requestedCraft : fallbackCraftId();
  installCraft(initialCraft);
  telemetry.craft = craftId;
  if (initialCraft !== requestedCraft) {
    notify(`The ${craftLabel(requestedCraft)} isn't ready to fly yet, so you're in the ${craftLabel(initialCraft)}.`, 'warning');
    settings.set('craft', initialCraft);
  }
  if (settings.get('mode') === 'sim') {
    if (!enterSim({ initial: true })) settings.set('mode', 'classic');
  }
  telemetry.mode = mode;
  syncVisual();

  bus.on('settings:changed', ({ key, value }) => {
    if (key === 'mode') onModeSetting(value);
    else if (key === 'craft') onCraftSetting(value);
  });

  // Behind the loading fade, compile the pipelines of things that first appear later.
  ctx.registerPrewarm?.(trails.object);
  ctx.registerPrewarm?.(createRopeStandIn(ropeMaterial));

  return {
    get planeMesh() {
      return mesh.root;
    },

    update(simDt, realDt) {
      collectActions();
      performActions();
      updateCrash(simDt > 0 ? realDt : 0);
      if (tow) updateTow(simDt);
      else if (mode === 'classic') updateClassic(simDt);
      else updateSim(simDt, realDt);
      updatePlayerRates(simDt);
      updateAbility(simDt);
      updateBlend(simDt);
      if (mode === 'sim' && !tow && blend.active) writePlayerFromSim();
      updateDepartingTows(simDt);
      syncVisual();
      trails.update(simDt, ctx.camera);
    },

    setAutopilot,
    barrelRoll,
    boost,
    getWingtips,
    resetTo,
    syncVisual,
    getBaseQuaternion,
    publishTelemetry,

    getMode() {
      return mode;
    },
    /** Requests a mode through the settings command channel; true when it is now active. */
    setMode(next) {
      if (next !== 'classic' && next !== 'sim') return false;
      settings.set('mode', next);
      return mode === next;
    },
    getCraft() {
      return craftId;
    },
    /** Requests a craft through the settings command channel; true when it is now flying. */
    setCraft(id) {
      return selectCraft(id);
    },
    getCraftModule() {
      return craft;
    },
    getCameraRig() {
      return craft.cameraRig;
    },
    getEyeAnchor() {
      return mesh ? mesh.eyeAnchor : null;
    },
    /** The active FlightModel (the arcade model in CLASSIC). */
    getModel() {
      return mode === 'sim' ? sim : arcade;
    },
    getCeiling() {
      return mode === 'sim' ? SIM_CEILING : CONFIG.MAX_ALTITUDE;
    },
    isTowing() {
      return tow !== null;
    },
    isAssistOverridden() {
      return override.active;
    },
    relaunch,
    triggerSoftCrash,
    runAbility,

    getStats() {
      const base = mode === 'classic' ? arcade.getStats() : { stalled: player.stalled };
      return {
        ...base,
        triangles: mesh ? countTriangles(mesh.root) : 0,
        mode,
        craft: craftId,
        simModel: sim ? sim.kind : null,
        tick: clock.tick,
        droppedSeconds: Math.round(clock.droppedSeconds * 1000) / 1000,
        towing: tow !== null,
        crash: crash.active,
        blend: blend.active,
        assistOverride: override.active,
        trailParticles: trails.count,
        ...counters,
      };
    },
  };
}
