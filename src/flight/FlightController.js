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
 * FLIGHT CONTROLLER (ctx.systems.flight): owns the active craft and its flight model, and keeps
 * state.player (the pose fields the world, camera, audio and HUD read) and state.flight (telemetry)
 * current.
 *
 * - The craft's flight model (its simProfile) runs in fixed 120 Hz ticks from ControlState (shaped by
 *   the craft input profile and the registered control stages: assists, autopilot), samples the wind
 *   and air density per tick, guards against NaN / Infinity every tick (restoring the last good
 *   snapshot) and renders an interpolated pose.
 * - Craft switches rebuild the mesh and the model and respawn sensibly at the same place.
 * - Soft crash: fade, respawn 300 m above the ground at the same XZ and heading, no penalty.
 * - Relaunch: aerotow (glider), nearest peak (wingsuit) or airstart; start on ground (setting),
 *   which prefers the nearest discovered site offering a ground-start spot (an airfield's runway,
 *   spawns.findGroundStart); hands-off assist override while a disconnected device was flying.
 * - Extra ground surfaces (ctx.groundSurfaces, src/world/groundSurfaces.js): landable ground that is
 *   not terrain (floating island tops). The contact height the models see is the higher of the
 *   terrain and any surface at most SURFACE_REACH above the craft's own height, so a craft lands on an
 *   island top but flies freely beneath it.
 * - Parking brake (parkingBrake.js): a powered craft placed on the ground with the throttle lever
 *   open holds its wheels at idle until the pilot moves the lever or brakes; a throttle no physical
 *   lever holds (keyboard, wheel, touch) goes to idle on a ground start instead.
 *
 * The craft is commanded through settings ('craft'): the controller applies a change or writes the
 * previous value back, then emits craftChanged.
 */

export const FLIGHT_CEILING = 15000;
/** A reset outside the craft's safe speed range eases into it over this time (s). */
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
/** An extra ground surface counts for a craft whose centre is at most this far (m) below it. */
const SURFACE_REACH = 12;
const DEFAULT_BODY_STRIKE_SPEED = 5;
const OVERRIDE_INPUT = 0.35;
const OVERRIDE_SECONDS = 0.25;
const AUTOPILOT_MIN_ALTITUDE = 60;
const GRAVITY = 9.81;
/** Speed changes smaller than this (m/s) after a reset are not worth a speed blend. */
const SPEED_BLEND_MIN_CHANGE = 0.5;

/** Actions the flight controller performs (docs/architecture.md, ownership table). */
const CRAFT_SELECT_ACTIONS = Object.freeze(['craftSelect1', 'craftSelect2', 'craftSelect3', 'craftSelect4', 'craftSelect5', 'craftSelect6']);
const FLIGHT_ACTIONS = new Set([
  'craftAbility', 'craftNext', 'craftPrev', ...CRAFT_SELECT_ACTIONS, 'gearToggle', 'flapsUp', 'flapsDown',
  'airbrake', 'relaunch', 'engineToggle', 'chuteDeploy',
]);
/** Flight actions the model itself handles (passed to it in the tick's controls.actions). */
const MODEL_ACTIONS = new Set(['gearToggle', 'flapsUp', 'flapsDown', 'airbrake', 'engineToggle', 'chuteDeploy']);
/** Telemetry fields a model owns; reset to defaults when the model changes so nothing stale shows. */
const MODEL_TELEMETRY_FIELDS = Object.freeze(['aoa', 'sideslip', 'throttle', 'afterburner', 'engineOn', 'rpm', 'rotorRpm', 'torque', 'flaps', 'flapNotch', 'gear', 'airbrake', 'brakes', 'trim', 'stall', 'overspeed', 'activeAssists']);
const LANDING_RANK = Object.freeze({ butter: 0, smooth: 1, firm: 2, hard: 3 });

export function createFlightController(ctx) {
  const { scene, state, bus, world, settings } = ctx;
  const player = state.player;
  const telemetry = state.flight;
  const registry = ctx.craftRegistry;
  const models = ctx.flightModels ?? defaultFlightModels;
  const liveControls = ctx.controls ?? createControlState();

  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const scratchVector = new THREE.Vector3();
  const scratchQuaternion = new THREE.Quaternion();
  const scratchForward = new THREE.Vector3();
  const scratchUp = new THREE.Vector3();
  const scratchRight = new THREE.Vector3();
  const inverseQuaternion = new THREE.Quaternion();

  // ---- Craft and model ---------------------------------------------------------------------------
  let craftId = null;
  let craft = null;
  let mesh = null;
  let sim = null;
  let craftState = {};

  // ---- Fixed-step state ---------------------------------------------------------------------------
  const clock = createFixedStepClock();
  const tickControls = createControlState();
  /**
   * Model actions whose press came only from the copilot this tick (tickControls.quietActions). The
   * copilot speaks its own confirmation, so the model skips its toast for them.
   */
  tickControls.quietActions = new Set();
  const groundSurfaces = ctx.groundSurfaces ?? null;
  /** The height (m) extra ground surfaces are looked for below: the ticking craft's height + reach. */
  const groundReference = new Float64Array([Infinity]);
  /** Terrain, or an extra ground surface above it no higher than the reference height. */
  function contactHeight(x, z) {
    const terrain = world.groundHeight(x, z);
    if (groundSurfaces === null || groundSurfaces.count === 0) return terrain;
    const surface = groundSurfaces.surfaceBelow(x, z, groundReference[0]);
    return surface > terrain ? surface : terrain;
  }
  const env = {
    time: 0,
    wind: { vel: new THREE.Vector3(), turbulence: 0 },
    groundHeight: contactHeight,
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
  const counters = { nanRestores: 0, softCrashes: 0, relaunches: 0, craftSwitches: 0, maxTicksPerFrame: 0 };
  // game: the shared state (ring course, waypoint) the autopilot follows.
  const stageContext = { dt: 0, model: null, craft: null, craftId: null, env, autopilot: player.autopilot, assists: 1, handsOff: false, telemetry, activeAssists: [], game: state };

  // ---- Speed blend, crash, relaunch, hot-plug ------------------------------------------------------
  /** After a reset outside the craft's safe speed range: the airspeed eases into it over BLEND_SECONDS. */
  const speedBlend = { active: false, elapsed: 0, from: 0, to: 0, bank: 0 };
  const crash = { active: false, phase: 'idle', elapsed: 0, reason: '' };
  let crashFade = null;
  let tow = null;
  const departingTows = [];
  const ropeMaterial = createRopeMaterial();
  const override = { active: false, deviceKey: '', kind: '', name: '', savedAutopilot: null, manualSeconds: 0 };
  const autopilotOverride = { seconds: 0 };

  const windSample = { vel: new THREE.Vector3(), turbulence: 0 };

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

  /** The highest ground at (x, z): terrain, water or any extra ground surface (island tops). */
  function surfaceHeight(x, z) {
    const terrain = world.groundHeight(x, z);
    const surface = groundSurfaces !== null && groundSurfaces.count > 0 ? groundSurfaces.surfaceBelow(x, z, Infinity) : -Infinity;
    return Math.max(terrain, surface, CONFIG.WATER_LEVEL);
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

  function simCruise() {
    return craft.spawn.cruise;
  }

  /** The throttle an airborne pose starts with; craft without an engine leave spawn.cruiseThrottle out. */
  function cruiseThrottle() {
    return Number.isFinite(craft.spawn.cruiseThrottle) ? craft.spawn.cruiseThrottle : 0;
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
  /**
   * Builds the craft's mesh and flight model; the caller positions them. Throws when either fails,
   * and leaves nothing of the new craft in the scene then.
   */
  function installCraft(id) {
    craft = registry.get(id);
    craftId = id;
    craftState = typeof craft.abilities?.craftAbility?.initialState === 'function' ? craft.abilities.craftAbility.initialState() : {};
    env.craftState = craftState;
    telemetry.craftState = craftState;
    mesh = craft.buildMesh(ctx);
    scene.add(mesh.root);
    try {
      sim = createSimModel(simKind());
    } catch (error) {
      scene.remove(mesh.root);
      mesh.dispose();
      mesh = null;
      throw error;
    }
    resetModelTelemetry();
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
    return models.create(kind, { profile: craft.simProfile, craft, world, bus, state, craftState, settings });
  }

  function simKind() {
    return craft && craft.simProfile ? craft.simProfile.model : null;
  }

  /** True when a craft module's flight model kind is registered (tests may unregister one). */
  function modelAvailable(module) {
    const kind = module && module.simProfile ? module.simProfile.model : null;
    return typeof kind === 'string' && models.has(kind);
  }

  // ============================================================================================
  // POSES
  // ============================================================================================
  /** The physical pose of the model (uninterpolated); the player pose while no model runs. */
  function capturePose() {
    if (sim) {
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
      velocity: player.velocity.clone(),
      angularVelocity: new THREE.Vector3(),
      throttle: player.throttle,
      onGround: false,
    };
  }

  // ============================================================================================
  // MODEL RESETS (teleports, spawns, craft switches)
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

  /** The throttle the model will see on its next tick (the craft input profile applied). */
  function pilotThrottle() {
    if (craft.inputProfile?.throttle === 'none') return 0;
    return Number.isFinite(liveControls.throttle) ? liveControls.throttle : 0;
  }

  /**
   * Trims the model after an airborne reset: at its position and velocity, with the given bank
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
   * An airborne reset keeps the velocity it was given, but a speed outside the craft's safe range
   * (from 1.25 x its stall speed up to 0.9 x its Vne) eases into the range over BLEND_SECONDS: each
   * tick until then the airspeed moves along its path toward the range and the model is re-trimmed
   * at the new speed.
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
   * Puts the model at pose and refreshes everything derived from it. An airborne pose is trimmed
   * (spawns, respawns, airstarts, tow release, craft switches: level flight at the craft's cruise, or
   * the tow's velocity, with the attitude and elevator for 1 g).
   */
  function resetActiveModel(pose) {
    // Every new pose starts without the parking brake; placeOnGround sets it again when needed.
    parkingBrake.release();
    speedBlend.active = false;
    sim.reset(pose);
    if (!pose.onGround) startSpeedBlend(trimSim());
    resetInterpolationFromModel();
    writePlayerFromSim();
    telemetryPrimed = false;
  }

  /**
   * Level flight at cruise (or a hover) at a point, heading kept: spawns, respawns, airstarts. The
   * cruise is an airspeed, so the air's own motion at the point is added to the velocity.
   */
  function airbornePose(position, heading) {
    const quaternion = levelQuaternion(heading);
    const speed = craft.spawn.hover ? 0 : simCruise();
    const velocity = vectorFromHeading(heading).multiplyScalar(speed);
    if (speed > 0 && ctx.wind && typeof ctx.wind.sample === 'function') {
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
    return settings.get('startOnGround') === true && craft.spawn.canStartOnGround === true;
  }

  /**
   * At rest on the gear on nearby flat, dry ground clear of trees and rocks, nose into the wind.
   * preferred ({ heading, onSurface? }) places the craft exactly at (x, z) facing heading instead: a
   * site's ground-start spot (a runway threshold) or the extra ground surface it is parked on.
   */
  function placeOnGround(x, z, preferred = null) {
    const spot = preferred ? { x, z } : findFlatSpot(world, x, z, {
      waterLevel: CONFIG.WATER_LEVEL,
      headingFor: (spotX, spotZ) => windHeadingAt(spotX, spotZ),
      clearance: vegetationClearance(craft.simProfile.contacts, undefined, craft.spawn.runwayLength),
      runwayLength: craft.spawn.runwayLength,
    });
    const heading = preferred && Number.isFinite(preferred.heading) ? wrapDegrees(preferred.heading) : windHeadingAt(spot.x, spot.z);
    const poseWorld = preferred && preferred.onSurface ? { groundHeight: (px, pz) => surfaceHeight(px, pz) } : world;
    const pose = groundPose(poseWorld, craft.simProfile.contacts, spot.x, spot.z, heading, craft.simProfile.centerOfMass?.[2] ?? 0);
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
  // CRAFT SWITCHING
  // ============================================================================================
  function resetModelTelemetry() {
    for (const field of MODEL_TELEMETRY_FIELDS) {
      const fallback = telemetryDefaults[field];
      if (Array.isArray(fallback)) telemetry[field] = [];
      else if (fallback && typeof fallback === 'object') telemetry[field] = { ...fallback };
      else telemetry[field] = fallback;
    }
  }

  function applyCraft(nextId) {
    if (nextId === craftId) return true;
    if (!registry.has(nextId) || !modelAvailable(registry.get(nextId))) {
      notify(`The ${craftLabel(nextId)} isn't ready to fly yet.`, 'warning');
      return false;
    }
    if (crash.active) finishCrash();
    releaseTow('craft change');
    const previous = craftId;
    const pose = capturePose();
    const wasOnGround = pose.onGround;
    disposeCraft();
    try {
      installCraft(nextId);
    } catch (error) {
      // A craft that fails to build must not take the flight system down: fly the previous one on.
      console.error(`[DRIFTWING] craft "${nextId}" failed to load`, error);
      installCraft(previous);
      spawnAfterCraftChange(pose, wasOnGround);
      syncVisual();
      snapCamera();
      settings.set('craft', previous);
      notify(`The ${craftLabel(nextId)} could not be loaded, so you're still flying the ${craftLabel(previous)}.`, 'warning');
      return false;
    }
    spawnAfterCraftChange(pose, wasOnGround);
    counters.craftSwitches++;
    telemetry.craft = craftId;
    syncVisual();
    snapCamera();
    bus.emitTyped('craftChanged', { craft: craftId, previous });
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
    if (craft.spawn.canStartOnGround && (shouldStartOnGround() || wasOnGround)) {
      // Parked on an extra ground surface (an island top): the new craft stays up there.
      const surface = groundSurfaces !== null && groundSurfaces.count > 0 ? groundSurfaces.surfaceBelow(position.x, position.z, position.y + SURFACE_REACH) : -Infinity;
      if (wasOnGround && surface > world.groundHeight(position.x, position.z)) placeOnGround(position.x, position.z, { heading, onSurface: true });
      else placeOnGround(position.x, position.z);
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
    if (!registry.has(id) || !modelAvailable(registry.get(id))) {
      notify(`The ${craftLabel(id)} isn't ready to fly yet.`, 'warning');
      return false;
    }
    settings.set('craft', id);
    return craftId === id;
  }

  // ============================================================================================
  // SOFT CRASH AND RESPAWN (there is no fail state)
  // ============================================================================================
  function triggerSoftCrash(reason = 'impact', details = {}) {
    if (crash.active || tow) return false;
    const position = sim.state.position;
    const velocity = sim.state.velocity;
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
    const position = sim.state.position;
    // Craft that cannot climb (spawn.respawn 'peak': the wingsuit) start again from the nearest peak.
    if (craft.spawn.respawn === 'peak' && isFiniteVector(position)) {
      launchFromPeak();
      return;
    }
    const heading = headingOfQuaternion(sim.state.quaternion, currentHeading());
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
    const position = sim.state.position;
    bus.emitTyped('relaunched', { craft: craftId, method, position: vectorLiteral(position) });
  }

  function airstart() {
    const position = sim.state.position;
    const spawnPosition = new THREE.Vector3(position.x, surfaceHeight(position.x, position.z) + AIRSTART_AGL, position.z);
    resetActiveModel(airbornePose(spawnPosition, currentHeading()));
    syncVisual();
    snapCamera();
    emitRelaunched('airstart');
    return true;
  }

  function launchFromPeak() {
    const position = sim.state.position;
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
      pose.velocity.set(0, 0, -dive.speed).applyQuaternion(pose.quaternion);
    }
    resetActiveModel(pose);
    player.heading = launch.heading;
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
    const releaseSpeed = simCruise();
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
    trails.clear();
    notify('Aerotow: hooking up to the tug.', 'info');
    return true;
  }

  const ZERO_WIND = new THREE.Vector3();
  const towVisual = { aileron: 0, elevator: 0, rudder: 0, flaps: 0, throttle: 0, propSpeed: NaN, engineOn: true, onGround: false, gearDown: true, airbrake: 0, time: state.time };

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
      throttle: 0,
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

  /** Ends a tow early (craft change, reset): the craft keeps flying from where it is. */
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
  // HOT-PLUG: hands-off assists while a disconnected device was flying
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
    if (override.active || !device || !deviceDrivesAxes(device)) return;
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
  // AUTOPILOT (v1 options; the model flies them through the autopilot control stage)
  // ============================================================================================
  function setAutopilot(options = {}) {
    const autopilot = player.autopilot;
    const wasEnabled = autopilot.enabled;
    if (typeof options.enabled === 'boolean') autopilot.enabled = options.enabled;
    const engaging = autopilot.enabled && !wasEnabled;
    if (Number.isFinite(options.heading)) autopilot.heading = wrapDegrees(options.heading);
    else if (engaging) autopilot.heading = player.heading;
    if (Number.isFinite(options.altitude)) autopilot.altitude = clamp(options.altitude, AUTOPILOT_MIN_ALTITUDE, FLIGHT_CEILING - 150);
    else if (engaging) autopilot.altitude = clamp(player.position.y, AUTOPILOT_MIN_ALTITUDE, FLIGHT_CEILING - 150);
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

  /** v1's waypoint / ring following turns into heading (and ring altitude) targets. */
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

  /** Holding the stick past 35 % for 0.25 s hands control back, like v1. */
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
   * True while the model takes actions on its next tick. During the crash fade (no ticks until the
   * respawn) and an aerotow (the tow flies the craft) a model action would fire later, on a different
   * pose, so it is dropped.
   */
  function modelAcceptsActions() {
    return !tow && !(crash.active && crash.phase === 'fadeIn');
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

  /** craftAbility: the craft's own ability (ballast, smoke, burner, hover hold, chute, flip). */
  function runAbility() {
    const ability = craft.abilities?.craftAbility;
    if (ability && typeof ability.run === 'function') return ability.run(abilityApi) !== false;
    return false;
  }

  function updateAbility(dt) {
    const ability = craft.abilities?.craftAbility;
    if (ability && typeof ability.update === 'function' && dt > 0) ability.update(abilityApi, dt);
  }

  // ============================================================================================
  // PHYSICS TICKS
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
    groundReference[0] = position.y + SURFACE_REACH;
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
      console.error(`[DRIFTWING] flight model "${sim.kind}" produced a non-finite state; restored the last good tick (logged once).`);
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
    if (modelState.position.y <= FLIGHT_CEILING) return;
    modelState.position.y = FLIGHT_CEILING;
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

  const simVisual = { aileron: 0, elevator: 0, rudder: 0, flaps: 0, throttle: 0, propSpeed: NaN, engineOn: true, onGround: false, gearDown: true, airbrake: 0, groundSpeed: 0, time: state.time };

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
    simVisual.time = state.time;
  }

  /** state.player (v1 fields) from the interpolated model pose. */
  function writePlayerFromSim() {
    writePlayerPose(interpolation.position, interpolation.quaternion, interpolation.velocity, env.wind.vel);
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
  }

  function updatePlayerRates(dt) {
    if (!(dt > 0)) return;
    if (Number.isFinite(previousPlayerHeading)) {
      const change = ((((player.heading - previousPlayerHeading + 180) % 360) + 360) % 360 - 180) / dt;
      player.yawRate = damp(player.yawRate, change, 10, dt);
    }
    previousPlayerHeading = player.heading;
  }

  // ============================================================================================
  // VISUAL
  // ============================================================================================
  /** Places the mesh at the (possibly safety-clamped) player pose. The camera calls this too. */
  function syncVisual() {
    if (!mesh) return;
    mesh.root.position.copy(player.position);
    mesh.root.quaternion.copy(player.quaternion);
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
    telemetry.craft = craftId;
    telemetry.tick = clock.tick;
    telemetry.position.copy(position);
    telemetry.quaternion.copy(player.quaternion);

    if (ctx.wind && typeof ctx.wind.sample === 'function') {
      ctx.wind.sample(position, state.time.elapsed, windSample);
      telemetry.wind.copy(windSample.vel);
      telemetry.turbulence = windSample.turbulence;
    }
    telemetry.velocity.copy(player.velocity);
    telemetry.airVelocity.copy(player.velocity).sub(telemetry.wind);
    const airspeed = telemetry.airVelocity.length();
    telemetry.airspeed = airspeed;
    telemetry.indicatedAirspeed = airspeed * Math.sqrt(airDensity(position.y) / SEA_LEVEL_DENSITY);
    telemetry.groundSpeed = Math.hypot(telemetry.velocity.x, telemetry.velocity.z);
    telemetry.mach = airspeed / speedOfSound(position.y);
    groundReference[0] = position.y + SURFACE_REACH;
    const ground = contactHeight(position.x, position.z);
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
      if (sim.state.angularVelocity && !tow) telemetry.angularVelocity.copy(sim.state.angularVelocity);
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

    if (tow) {
      telemetry.gLoad = player.gForce;
      telemetry.onGround = false;
      telemetry.contacts = 0;
    } else {
      sim.writeTelemetry(telemetry);
      telemetry.onGround = Boolean(sim.contact && sim.contact.onGround);
    }
    const assistSetting = settings.get('assists');
    telemetry.assists = override.active ? 1 : assistSetting && Number.isFinite(assistSetting[craftId]) ? assistSetting[craftId] : 1;
    telemetry.activeAssists = [...stageContext.activeAssists];
    if (override.active) telemetry.activeAssists.push('hands-off hold');
    telemetry.autopilot.enabled = player.autopilot.enabled;
    telemetry.autopilot.heading = player.autopilot.heading;
    telemetry.autopilot.altitude = player.autopilot.altitude;
    telemetry.autopilot.speed = Number.isFinite(player.autopilot.speed) ? player.autopilot.speed : 0;
    telemetry.crash.active = crash.active;
    telemetry.crash.reason = crash.reason;
    telemetry.crash.progress = crashProgress();
    telemetry.parkingBrake = parkingBrake.engaged;
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
  // RESET
  // ============================================================================================
  /** Level flight at cruise from (x, y, z); also core's recovery path after a non-finite pose. */
  function resetTo(target = {}) {
    const { x, y, z } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    if (tow) releaseTow('reset');
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
    const available = registry.list().filter((entry) => entry.available && modelAvailable(registry.get(entry.id)));
    if (available.length === 0) throw new Error('no craft modules are registered');
    return available[0].id;
  }

  /**
   * The first flight: level at the craft's cruise at the spawn point, heading kept (or on the ground
   * with "Start on ground").
   */
  function startFirstFlight() {
    if (shouldStartOnGround()) {
      const site = typeof ctx.systems.spawns?.findGroundStart === 'function' ? ctx.systems.spawns.findGroundStart(player.position.x, player.position.z) : null;
      if (site) {
        placeOnGround(site.x, site.z, { heading: site.heading });
        notify(`Starting at the ${site.name.toLowerCase()}.`, 'info');
      } else {
        placeOnGround(player.position.x, player.position.z);
      }
    } else {
      resetActiveModel(airbornePose(player.position, headingOfQuaternion(player.quaternion, currentHeading())));
    }
  }

  const requestedCraft = settings.get('craft');
  const initialCraft = registry.has(requestedCraft) && modelAvailable(registry.get(requestedCraft)) ? requestedCraft : fallbackCraftId();
  installCraft(initialCraft);
  telemetry.craft = craftId;
  if (initialCraft !== requestedCraft) {
    notify(`The ${craftLabel(requestedCraft)} isn't ready to fly yet, so you're in the ${craftLabel(initialCraft)}.`, 'warning');
    settings.set('craft', initialCraft);
  }
  startFirstFlight();
  syncVisual();

  bus.on('settings:changed', ({ key, value }) => {
    if (key === 'craft') onCraftSetting(value);
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
      else updateSim(simDt, realDt);
      updatePlayerRates(simDt);
      updateAbility(simDt);
      updateDepartingTows(simDt);
      syncVisual();
      trails.update(simDt, ctx.camera);
    },

    setAutopilot,
    getWingtips,
    resetTo,
    syncVisual,
    publishTelemetry,

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
    /** The active FlightModel. */
    getModel() {
      return sim;
    },
    getCeiling() {
      return FLIGHT_CEILING;
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
      return {
        stalled: player.stalled,
        triangles: mesh ? countTriangles(mesh.root) : 0,
        craft: craftId,
        simModel: sim ? sim.kind : null,
        tick: clock.tick,
        droppedSeconds: Math.round(clock.droppedSeconds * 1000) / 1000,
        towing: tow !== null,
        crash: crash.active,
        assistOverride: override.active,
        trailParticles: trails.count,
        ...counters,
      };
    },
  };
}
