// Eagle / dragon flight lab: flies SimFlapper headless (node, no renderer) with scripted controls
// through the same control stages the game runs every physics tick (the autopilot and the flapper
// assists) and prints its measured performance against the spec numbers (Milestone E, item 13), the
// perch behaviour and the ignition service the dragon's fire uses.
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3), still unless a test adds wind,
// over flat ground at sea level (a hill for the peak perch, a ridge for ridge lift). Physics runs at
// the game's fixed 120 Hz. Perch points come from a stand-in for the collider service's perchesNear.
//
// Tests:
//   glide       flap power 0, neutral stick: the best glide (about 12 : 1 near 45 km/h), steady
//   polar       the pitch range: the least sink (about 1 m/s) and the slowest unstalled glide
//   flapping    the cruise flap power holds height; full flap power climbs (about 2.5 m/s)
//   stoop       wings tucked, nose down: the dive reaches 60 m/s; untucked it pulls out
//   handling    a roll pulse turns it; 100 % assists keep full pull out of the stall; 0 % stalls and
//               recovers hands off
//   soaring     a thermal (rising air) and ridge lift (wind up a slope) carry it up with the flap
//               power at zero
//   perch       a slow approach catches a tree-top perch: the auto-landing, then standing still at
//               the perch point (the perched event); the same throttle stays perched, raised throttle
//               takes off (the perched false event) without catching the perch again; a fast pass
//               does not land; a perch behind a wall (a blocked line of flight) is refused
//   peak        a slow pass low over a hilltop lands on the peak
//   ground      a slow touchdown on flat ground stands (graded as a landing, no perched event); a
//               fast dive into the ground strikes the body (the soft crash)
//   placement   a resting reset at a perch point stands on it; at a ground point stands on the ground
//   autopilot   the copilot's perch approach (craftState.perchTarget) flies to the perch and lands,
//               on flat ground, on a hillside, and at the real tree-top perches around the spawn of
//               the CRAFT-1 world (the game's world generator and vegetation perch provider)
//   ignition    the ignition service: add, cone, ignite once, extinguish, remove, refusals
//   allocation  young-generation bytes per model step in flapping flight, slow flight scanning for
//               perches and on a perch (a child process with clean type feedback; the wingsuit's step
//               is printed for comparison)
//
// Usage: node tools/lab/eagle.mjs [--verbose]
// Prints a PASS / FAIL table and exits non-zero if any check fails.
import * as v8 from 'node:v8';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import eagle from '../../src/craft/eagle.js';
import wingsuit from '../../src/craft/wingsuit.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createIgnitionService } from '../../src/gameplay/ignition.js';
import { DEG, clamp } from '../../src/core/util.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { createColliderWorld } from '../../src/world/colliders.js';
import { registerVegetationColliders } from '../../src/world/vegetationColliders.js';
import { findSpawn } from '../../src/world/spawn.js';
import { sunDirectionForDayTime, dayTimeForSunElevation } from '../../src/core/sun.js';
import { CONFIG, WORLD_OPTIONS } from '../../src/core/config.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const WATER_LEVEL = -60;
const KMH = 3.6;
const FEET = eagle.simProfile.perch.feet;
const VERBOSE = process.argv.includes('--verbose');
/** The allocation measure runs in a child process of its own (--allocation-child), with clean type feedback. */
const ALLOCATION_CHILD = process.argv.includes('--allocation-child');

function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
function createFlatWorld(ground = 0) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL };
}

/** A round hill: height `height` at (x, z), falling off over `radius` metres (a gaussian). */
function createHillWorld(x, z, height, radius) {
  const surface = (px, pz) => height * Math.exp(-((px - x) ** 2 + (pz - z) ** 2) / (radius * radius));
  return { groundHeight: surface, heightAt: surface, WATER_LEVEL };
}

/** A ridge running east-west north of the origin: rising `gradient` metres per metre from z = start northward to `top`. */
function createRidgeWorld(gradient, start, top) {
  const surface = (px, pz) => clamp((start - pz) * gradient, 0, top);
  return { groundHeight: surface, heightAt: surface, WATER_LEVEL };
}

/** A stand-in for the collider service: perch points, and walls (axis-aligned boxes) that block the line of flight. */
function createColliders(perches = [], walls = []) {
  return {
    perchesNear(x, y, z, radius, visit) {
      for (const perch of perches) {
        if (Math.hypot(perch.x - x, perch.y - y, perch.z - z) <= radius) visit(perch.x, perch.y, perch.z, perch.kind, perch.id);
      }
    },
    raycast(origin, direction, maxDistance, filter, out) {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      for (const wall of walls) {
        for (let step = 0; step <= 64; step++) {
          const share = (step / 64) * maxDistance;
          const px = origin.x + (direction.x / length) * share;
          const py = origin.y + (direction.y / length) * share;
          const pz = origin.z + (direction.z / length) * share;
          if (px >= wall.min[0] && px <= wall.max[0] && py >= wall.min[1] && py <= wall.max[1] && pz >= wall.min[2] && pz <= wall.max[2]) {
            out.distance = share;
            return true;
          }
        }
      }
      return false;
    },
    insideSolid() {
      return null;
    },
    liftClear(x, y) {
      return y;
    },
  };
}

function createRig({ assists = 0, world = createFlatWorld(), colliders = null } = {}) {
  const craft = eagle;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [], perched: [], journalStat: [], invalid: 0 };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push({ ...payload }));
  bus.onTyped('perched', (payload) => events.perched.push({ ...payload, position: { ...payload.position } }));
  bus.onTyped('journalStat', (payload) => events.journalStat.push({ ...payload }));
  const craftState = { ...craft.abilities.craftAbility.initialState(), ...craft.abilities.craftAbilityAlt.initialState(), skin: 'eagle' };
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry, colliders };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, env, context, events, craftState, time: 0, autopilot, windAt: null, nonFinite: 0 };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    if (rig.windAt) rig.windAt(model.state.position, env.wind.vel);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    const state = model.state;
    if (![state.position.x, state.position.y, state.position.z, state.velocity.x, state.velocity.y, state.velocity.z, state.quaternion.w].every(Number.isFinite)) rig.nonFinite++;
    rig.time += DT;
  };
  rig.run = (seconds, script) => {
    const ticks = Math.round(seconds / DT);
    for (let tick = 0; tick < ticks; tick++) {
      if (script && script(rig) === true) return true;
      rig.tick();
    }
    return false;
  };
  /** In the air at `speed` heading `heading` (level, the model trims its own attitude). */
  rig.airborne = ({ speed = 12.5, heading = 0, altitude = 2000, x = 0, z = 0, path = 0 } = {}) => {
    const direction = new THREE.Quaternion().setFromEuler(new THREE.Euler(path * DEG, -heading * DEG, 0, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(direction);
    model.reset({ position: new THREE.Vector3(x, altitude, z), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG), velocity, angularVelocity: new THREE.Vector3(), onGround: false, throttle: 0 });
  };
  rig.state = () => model.state;
  return rig;
}

/** Wings level (or a bank target) through the roll. */
function levelWings(rig, bank = 0) {
  const data = rig.data;
  rig.pilot.roll = clamp(1.5 * (bank * DEG - data.bank) - 0.3 * data.rollRate, -1, 1);
}

/** Glide ratio (ground referenced), mean airspeed and sink over `seconds`. */
function measureGlide(rig, seconds, script) {
  const start = rig.state().position.clone();
  let speedSum = 0;
  let samples = 0;
  rig.run(seconds, (current) => {
    if (script) script(current);
    speedSum += current.data.airspeed;
    samples++;
  });
  const end = rig.state().position;
  const distance = Math.hypot(end.x - start.x, end.z - start.z);
  const drop = start.y - end.y;
  return { glide: drop > 0 ? distance / drop : Infinity, speed: speedSum / Math.max(samples, 1), sink: drop / seconds, drop, distance };
}

/** The approach start `distance` out from a perch and `above` over it, on the side whose ground stays lowest. */
function lowSideStart(surface, perch, distance, above) {
  let best = null;
  for (let index = 0; index < 16; index++) {
    const heading = index * 22.5;
    const radians = heading * DEG;
    let margin = Infinity;
    for (let along = 5; along <= distance; along += 5) {
      margin = Math.min(margin, perch.y + (above * along) / distance - surface(perch.x - Math.sin(radians) * along, perch.z + Math.cos(radians) * along));
    }
    if (!best || margin > best.margin) best = { heading, margin, x: perch.x - Math.sin(radians) * distance, z: perch.z + Math.cos(radians) * distance };
  }
  return best;
}


const world = createWorldGen('CRAFT-1', WORLD_OPTIONS);
const colliders = createColliderWorld({});
registerVegetationColliders(colliders, world);
const spawn = findSpawn(world, sunDirectionForDayTime(dayTimeForSunElevation(CONFIG.START_SUN_ELEVATION_DEG, true)));
const ground = (x, z) => world.groundHeight(x, z);
const surface = (x, z) => Math.max(ground(x, z), CONFIG.WATER_LEVEL);
const flightWorld = { groundHeight: ground, heightAt: ground, WATER_LEVEL: CONFIG.WATER_LEVEL };
const perches = [];
colliders.perchesNear(spawn.x, ground(spawn.x, spawn.z), spawn.z, 600, (x, y, z, kind, id) => perches.push({ x, y, z, kind, id }));
perches.sort((f, s2) => Math.hypot(f.x - spawn.x, f.z - spawn.z) - Math.hypot(s2.x - spawn.x, s2.z - spawn.z));
const perch = perches[+process.argv[2] || 0];
const start = lowSideStart(surface, perch, 160, 30);
const exit = (start.heading + 180) % 360;
console.log('perch', perch.id, 'ground under', (perch.y - ground(perch.x, perch.z)).toFixed(1), 'exit', exit);
const rig = createRig({ assists: 1, world: flightWorld, colliders });
rig.env.waterLevel = CONFIG.WATER_LEVEL;
rig.model.reset({ position: new THREE.Vector3(perch.x, perch.y, perch.z), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -exit * DEG), velocity: new THREE.Vector3(), onGround: true });
rig.pilot.throttle = 0.1; rig.run(1); rig.pilot.throttle = 0.85;
let t = 0;
const pr = (c) => { const p = c.state().position; console.log(t.toFixed(2), c.model.phase, 'agl', (p.y - surface(p.x, p.z)).toFixed(1), 'dy', (p.y - perch.y).toFixed(1), 'as', c.data.airspeed.toFixed(1), 'vs', c.state().velocity.y.toFixed(1), 'pitch', (c.data.pitch / DEG).toFixed(0), 'aoa', (c.data.aoa / DEG).toFixed(0), 'flap', c.data.flapPower.toFixed(2), 'onG', c.model.contact.onGround, 'ap', c.autopilot.enabled); };
for (let i = 0; i < 12; i++) { rig.run(0.25); t += 0.25; pr(rig); if (i === 3) Object.assign(rig.autopilot, { enabled: true, heading: exit, altitude: perch.y + 80, speed: 13 }); }
for (let i = 0; i < 10; i++) { rig.run(2); t += 2; pr(rig); }
