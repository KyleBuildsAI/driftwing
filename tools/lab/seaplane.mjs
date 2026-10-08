// Seaplane lab: the amphibious floatplane (src/craft/seaplane.js) and its floats extension
// (src/flight/floats.js) headless in node: the flight model with the game's control stages over flat
// water or flat ground, then the whole craft through the real FlightController (placements, the soft
// crash outcomes, the landing grade, the gear advisory, the spray and the mesh).
//
// The water is a flat sea (or a synthetic swell with orbital velocities for the waves test) at 0 m,
// the bed or the land at the height a test needs; sea-level standard air; calm unless a test sets a
// wind. Physics runs at the game's fixed 120 Hz.
//
// Tests:
//   registry    the module registers (every optional field valid), its audio family and instrument exist
//   flight      power-off stall clean and with full flaps, cruise at 70 % power, full-power climb
//   afloat      at rest on the water the floats carry the weight: level, steady, no strikes, the
//               report afloat (onGround, surface water), the wheels resolved up
//   waves       on a swell the floats ride the crests and troughs (heave follows the water), no strikes
//   hump        a towing tank at a fixed 6 degree trim: the water resistance peaks near the hump speed
//               (about 45 km/h) and falls well below the peak on the step; planing carries the load
//   takeoff     full power and two notches of flaps: at 100 % assists hands off (the water assist), and
//               at 0 % with a neutral stick: over the hump, on the step, airborne; liftoff speed and run
//   porpoise    on the step at 0 % assists, the nose pushed low: porpoising grows past 0.3; back at the
//               right trim it dies away. At 100 % hands off it never starts
//   landing     a powered approach to a water touchdown: the landed event (surface water, graded), the
//               run-out to taxi speed, the journal stat; a hard arrival exceeds the crash sink rate
//   noseOver    gear down: the advisory rises on the approach, then the wheels dig in (body strike
//               'nose-over'); wheels down in the water at a walking pace (a ramp) do not
//   land        wheels down on land: parked steady, rolls and takes off; wheels up: a slow beaching
//               skids to a stop, a fast arrival is a body strike ('floats on land'); the skid advisory
//   rudders     taxiing at idle, full right pedal turns far faster with the water rudders down than up;
//               the differential toe brakes steer them too; above the step they are out of the water
//   gear        the gear toggle works on the water and in the air, and refuses on land with weight on
//               the wheels; the copilot's landing configuration command sets it
//   situate     over water low: afloat (water rudders down); high: a low approach into the wind at
//               1.3 x stall; on land: on the wheels; flying over land: the Phase 1 rules
//   copilot     every phrase is a valid regex that matches its sample transcript with the right value;
//               the commands answer and act; the status line reads the state
//   controller  through the FlightController: a craft switch over water floats the seaplane, a water
//               landing grades with surface 'water', the nose-over and the wheels-up skid soft-crash with
//               their reasons, the gear advisory speaks once, the spray emits droplets, the mesh animates
//               the wheels and water rudders, and dispose leaves no listener behind
//   scenarios   the ?test=craft scripts (src/dev/craftScenarios/seaplane.js) fly through the controller
//               in their own world (CRAFT-1 with the water fixtures: the real terrain, sea channel and
//               fixture lake) in calm air and two steady winds, and pass their checks: takeoff and
//               landing on the ocean and on the lake, and the wheels-down nose-over
//   allocation  20 000 ticks on the step allocate nothing that survives a full collection
//
// Usage: node --expose-gc tools/lab/seaplane.mjs [--verbose] [--only=test]
// Prints one line per check (failures and the numbers always) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import seaplane from '../../src/craft/seaplane.js';
import { craftRegistry, createCraftRegistry, CRAFT_CATALOG, CRAFT_GROUPS } from '../../src/craft/registry.js';
import '../../src/craft/index.js';
import { flightModels } from '../../src/flight/models.js';
import { createFloatsExtension, displacementDragShape, floatSectionArea } from '../../src/flight/floats.js';
import { createFlightController } from '../../src/flight/FlightController.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { ENGINE_FAMILIES, resolveAudioProfile } from '../../src/audio/engines/index.js';
import { INSTRUMENTS } from '../../src/ui/instruments/index.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { CRAFT_IDS } from '../../src/core/settings.js';
import { DEG, clamp, wrapDegrees } from '../../src/core/util.js';
import seaplaneScenarios from '../../src/dev/craftScenarios/seaplane.js';
import { WORLD_OPTIONS } from '../../src/core/config.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { createWaterQuery } from '../../src/world/waterQuery.js';
import { WATER_FIXTURES } from '../../src/dev/waterFixtures.js';
import { prevailingWindDirection } from '../../src/env/WindField.js';

const VERBOSE = process.argv.includes('--verbose');
const ONLY = (process.argv.find((flag) => flag.startsWith('--only=')) ?? '').slice(7);
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose' && !flag.startsWith('--only=')) throw new Error(`Unknown flag ${flag}`);
}
const DT = 1 / 120;
const FRAME = 1 / 60;
const SEA_LEVEL_RHO = 1.225;
const KMH = 3.6;
const MASS = seaplane.simProfile.mass.empty + seaplane.simProfile.mass.pilot + seaplane.simProfile.mass.fuel;
const WEIGHT = MASS * 9.81;
const results = [];
const started = Date.now();

function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}
function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}
function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

// ============================================================================================
// RIG: the flight model with the game's control stages over flat water (or ground)
// ============================================================================================
/**
 * world: { ground (m, the bed or the land), water (m, or -Infinity for none), swell? { amplitude,
 * wavelength, period } }. The extension instance is captured so the tests can read its hydro state.
 */
function createRig({ ground = -20, water = 0, swell = null, assists = 0, wind = null } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [], stats: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  bus.onTyped('journalStat', (payload) => events.stats.push(payload));
  let extension = null;
  const profile = { ...seaplane.simProfile, extension: (args) => (extension = createFloatsExtension(args)) };
  const craftState = seaplane.abilities.craftAbility.initialState();
  const world = { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL: water };
  const model = flightModels.create('fixedWing', { profile, craft: seaplane, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = {
    time: 0, wind: { vel: wind ? wind.clone() : new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: water,
    rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry,
  };
  if (swell) {
    // A synthetic long-crested swell travelling north (Airy wave): height, slope and orbital velocity.
    const waveNumber = (2 * Math.PI) / swell.wavelength;
    const omega = (2 * Math.PI) / swell.period;
    env.waterHeight = (x, z) => water + swell.amplitude * Math.cos(waveNumber * z + omega * env.time);
    env.waterSample = (x, z, out) => {
      const phase = waveNumber * z + omega * env.time;
      const slope = -swell.amplitude * waveNumber * Math.sin(phase);
      out.height = water + swell.amplitude * Math.cos(phase);
      const length = Math.hypot(slope, 1);
      out.normalX = 0;
      out.normalY = 1 / length;
      out.normalZ = -slope / length;
      out.velocityX = 0;
      out.velocityY = swell.amplitude * omega * Math.sin(phase);
      out.velocityZ = -swell.amplitude * omega * Math.cos(phase);
      out.kind = 'ocean';
      out.bodyId = null;
      out.body = null;
      out.material = 'water';
      out.depth = out.height - ground;
      out.film = false;
      return out;
    };
  }
  const context = { dt: DT, model, craft: seaplane, craftId: 'seaplane', env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { model, data: model.flightData, pilot, controls, env, context, events, telemetry, craftState, time: 0, bus };
  Object.defineProperty(rig, 'hydro', { get: () => extension.hydro });
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
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
  rig.setAssists = (level) => {
    env.assists = level;
    context.assists = level;
    telemetry.assists = level;
  };
  /** Afloat at rest (the reset puts the wheels up once the floats are found in the water). */
  rig.afloat = ({ heading = 0, speed = 0, engineOn = true } = {}) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG);
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(0, water + 1.75, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn });
    pilot.throttle = 0;
  };
  /** Parked on the wheels on flat land. */
  rig.parked = ({ heading = 0 } = {}) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG);
    model.reset({ position: new THREE.Vector3(0, ground + 2.55, 0), quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn: true });
    pilot.throttle = 0;
  };
  /** Level flight at speed, `height` m above the surface, heading 0 (north). */
  rig.airborne = ({ speed, height = 1200, throttle = 0, pitch = 0 }) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch * DEG);
    const velocity = new THREE.Vector3(0, 0, -speed);
    model.reset({ position: new THREE.Vector3(0, Math.max(water, ground) + height, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  rig.selectFlaps = (notch) => {
    for (let step = 0; step < 4; step++) pilot.actions.add('flapsUp');
    rig.tick();
    for (let step = 0; step < notch; step++) {
      pilot.actions.add('flapsDown');
      rig.tick();
    }
  };
  rig.press = (action) => {
    pilot.actions.add(action);
    rig.tick();
  };
  rig.distance = (from) => Math.hypot(model.state.position.x - from.x, model.state.position.z - from.z);
  return rig;
}

// ---- Scripted pilots (closed loops on the stick, rudder and throttle) ----------------------------
function createPid(kp, ki, kd, min = -1, max = 1) {
  let integral = 0;
  let previous = NaN;
  return {
    reset(value = 0) {
      integral = value;
      previous = NaN;
    },
    update(error, dt, measuredRate = NaN) {
      const derivative = Number.isFinite(measuredRate) ? measuredRate : Number.isFinite(previous) ? (error - previous) / dt : 0;
      previous = error;
      const output = integral + kp * error + kd * derivative;
      if ((output < max || error < 0) && (output > min || error > 0)) integral = clamp(integral + ki * error * dt, min, max);
      return clamp(integral + kp * error + kd * derivative, min, max);
    },
  };
}
function flyLevelWings(rig, bank = 0) {
  rig.pilot.roll = clamp(1.6 * (bank * DEG - rig.data.bank) - 0.35 * rig.data.rollRate, -1, 1);
  rig.pilot.yaw = clamp(4 * rig.data.sideslip, -1, 1);
}
function createSpeedPilot(target) {
  const pid = createPid(0.05, 0.02, 0.1);
  let lastSpeed = NaN;
  return {
    target,
    fly(rig) {
      const speed = rig.data.airspeed;
      const acceleration = Number.isFinite(lastSpeed) ? (speed - lastSpeed) / DT : 0;
      lastSpeed = speed;
      rig.pilot.pitch = clamp(pid.update(speed - this.target, DT, acceleration) - 0.25 * rig.data.pitchRate, -1, 1);
    },
  };
}
function createAltitudePilot(target) {
  const pid = createPid(0.12, 0.08, 0.02);
  return {
    target,
    fly(rig) {
      const climb = clamp((this.target - rig.model.state.position.y) * 0.15, -4, 4);
      rig.pilot.pitch = clamp(pid.update(climb - rig.data.verticalSpeed, DT) - 0.25 * rig.data.pitchRate, -1, 1);
    },
  };
}
/** Holds a vertical speed with the elevator (gentle gains: the floats' pitch inertia is large). */
function createSinkPilot() {
  const pid = createPid(0.06, 0.04, 0);
  return {
    target: 0,
    reset(value) {
      pid.reset(value);
    },
    fly(rig) {
      rig.pilot.pitch = clamp(pid.update(this.target - rig.data.verticalSpeed, DT) - 0.6 * rig.data.pitchRate, -1, 1);
    },
  };
}

// ============================================================================================
// TESTS
// ============================================================================================
function testRegistry() {
  check('registry', 'the seaplane registers in the game registry with every optional field valid', craftRegistry.has('seaplane') && craftRegistry.get('seaplane') === seaplane);
  const lab = createCraftRegistry(CRAFT_CATALOG, CRAFT_GROUPS);
  let error = null;
  try {
    lab.register(seaplane);
  } catch (caught) {
    error = caught;
  }
  check('registry', 'a fresh registry validates the module', error === null, error ? error.message : '');
  check('registry', "the 'radial' audio family exists and the profile resolves to it", Boolean(ENGINE_FAMILIES.radial) && resolveAudioProfile(seaplane.audioProfile, seaplane.instruments).engine === 'radial');
  check('registry', 'every listed instrument has a renderer (waterRudder included)', seaplane.instruments.every((id) => Boolean(INSTRUMENTS[id])) && Boolean(INSTRUMENTS.waterRudder));
  const layout = seaplane.cameraRig.cockpit.panel.layout.flat();
  check('registry', 'the cockpit panel shows every instrument', seaplane.instruments.every((id) => layout.includes(id)));
  const chine = 0.46 * Math.tan(22 * DEG);
  const area = floatSectionArea(0.5, 0.92, Math.tan(22 * DEG), 0.85);
  const vee = floatSectionArea(0.1, 0.92, Math.tan(22 * DEG), 0.85);
  check('registry', 'float section area: V bottom then the full beam', round(area, 6) === round(0.5 * chine * 0.92 + (0.5 - chine) * 0.92, 6) && round(vee, 6) === round((0.1 * 0.1) / Math.tan(22 * DEG), 6), `${round(area, 4)} m^2, ${round(vee, 4)} m^2`);
  check('registry', 'displacement drag shape peaks at the hump ratio', Math.abs(displacementDragShape(1, 0.2) - 0.2) < 1e-12 && displacementDragShape(0.6, 0.2) < 0.2 && displacementDragShape(1.6, 0.2) < 0.2);
}

/** Power-off stall: decelerate wings level at 0 % assists holding level flight until the critical angle. */
function stallSpeed(flaps) {
  const rig = createRig({ water: -Infinity, ground: 0 });
  rig.airborne({ speed: 36, height: 1500, throttle: 0 });
  if (flaps) rig.selectFlaps(flaps);
  const settle = createSpeedPilot(36);
  rig.run(20, (lab) => {
    flyLevelWings(lab);
    settle.fly(lab);
  });
  const level = createSinkPilot();
  level.reset(rig.pilot.pitch);
  let stall = null;
  let minimum = Infinity;
  rig.run(90, (lab) => {
    flyLevelWings(lab);
    level.fly(lab);
    minimum = Math.min(minimum, lab.data.airspeed);
    if (lab.data.aoa >= lab.data.aoaCritical || lab.data.stalled) {
      stall = lab.data.airspeed;
      return true;
    }
    return false;
  });
  return stall ?? minimum;
}

function testFlight() {
  const targets = seaplane.simProfile.targets;
  const clean = stallSpeed(0);
  check('flight', `stall speed clean ${round(clean * KMH, 0)} km/h (target ${round(targets.stallSpeedClean * KMH, 0)})`, Math.abs(clean - targets.stallSpeedClean) <= targets.stallSpeedClean * 0.1, `${round(clean, 1)} m/s`);
  const full = stallSpeed(3);
  check('flight', `stall speed full flaps ${round(full * KMH, 0)} km/h (target ${round(targets.stallSpeedFullFlaps * KMH, 0)})`, Math.abs(full - targets.stallSpeedFullFlaps) <= targets.stallSpeedFullFlaps * 0.1, `${round(full, 1)} m/s`);

  const cruise = createRig({ water: -Infinity, ground: 0 });
  cruise.airborne({ speed: 50, height: 600, throttle: 0.7 });
  const hold = createAltitudePilot(600);
  cruise.run(150, (lab) => {
    flyLevelWings(lab);
    hold.fly(lab);
    lab.pilot.throttle = 0.7;
  });
  check('flight', `cruise at 70 % power ${round(cruise.data.airspeed * KMH, 0)} km/h (target ${round(targets.cruiseSpeed * KMH, 0)})`, Math.abs(cruise.data.airspeed - targets.cruiseSpeed) <= targets.cruiseSpeed * 0.1, `${round(cruise.data.airspeed, 1)} m/s`);

  const climb = createRig({ water: -Infinity, ground: 0 });
  climb.airborne({ speed: 34, height: 300, throttle: 1 });
  const speed = createSpeedPilot(34);
  let rate = 0;
  let samples = 0;
  climb.run(60, (lab) => {
    flyLevelWings(lab);
    speed.fly(lab);
    lab.pilot.throttle = 1;
    if (lab.time > 45) {
      rate += lab.model.state.velocity.y;
      samples++;
    }
  });
  rate /= samples;
  check('flight', `full-power climb ${round(rate, 1)} m/s at 34 m/s (target ${targets.climbRate})`, Math.abs(rate - targets.climbRate) <= targets.climbRate * 0.15, `${round(rate, 2)} m/s`);
}

function testAfloat() {
  // Engine off: at idle the prop would taxi it forward.
  const rig = createRig();
  rig.afloat({ engineOn: false });
  let strikes = 0;
  let heaveRange = { low: Infinity, high: -Infinity };
  let pitchRange = { low: Infinity, high: -Infinity };
  rig.run(12, (lab) => {
    if (lab.model.contact.bodyStrike) strikes++;
    if (lab.time > 6) {
      heaveRange.low = Math.min(heaveRange.low, lab.model.state.position.y);
      heaveRange.high = Math.max(heaveRange.high, lab.model.state.position.y);
      pitchRange.low = Math.min(pitchRange.low, lab.data.pitch / DEG);
      pitchRange.high = Math.max(pitchRange.high, lab.data.pitch / DEG);
    }
  });
  const contact = rig.model.contact;
  check('afloat', 'the floats carry the weight (buoyancy within 3 %)', Math.abs(rig.hydro.buoyancy - WEIGHT) < WEIGHT * 0.03, `${round(rig.hydro.buoyancy, 0)} N vs ${round(WEIGHT, 0)} N`);
  check('afloat', 'steady at rest: heave under 2 cm and pitch under 0.3 degrees of motion over the last 6 s', heaveRange.high - heaveRange.low < 0.02 && pitchRange.high - pitchRange.low < 0.3, `heave ${round(heaveRange.high - heaveRange.low, 3)} m, pitch ${round(pitchRange.low, 2)}..${round(pitchRange.high, 2)} deg`);
  check('afloat', 'nearly level (pitch within 2 degrees, roll within 1)', Math.abs(rig.data.pitch / DEG) < 2 && Math.abs(rig.data.bank / DEG) < 1, `pitch ${round(rig.data.pitch / DEG, 2)}, roll ${round(rig.data.bank / DEG, 2)}`);
  check('afloat', 'the propeller clears the water by at least 0.4 m', rig.model.state.position.y + seaplane.simProfile.contacts.find((entry) => entry.id === 'propTip').position[1] > 0.4, `${round(rig.model.state.position.y - 1.17, 2)} m`);
  check('afloat', 'the report is afloat: onGround, floating, surface water; no strikes', contact.onGround && contact.floating && contact.surface === 'water' && contact.water && strikes === 0, JSON.stringify({ onGround: contact.onGround, floating: contact.floating, surface: contact.surface, strikes }));
  check('afloat', 'a reset on the water puts the wheels up', rig.craftState.gearPosition === 0, `gear ${rig.craftState.gearPosition}`);
  check('afloat', 'craftState: onWater, not on the step, no porpoise', rig.craftState.onWater === true && rig.craftState.onStep === false && rig.craftState.porpoise === 0);
}

function testWaves() {
  const rig = createRig({ swell: { amplitude: 0.5, wavelength: 40, period: 5 } });
  rig.afloat();
  rig.run(4);
  let low = Infinity;
  let high = -Infinity;
  let strikes = 0;
  let finite = true;
  rig.run(15, (lab) => {
    low = Math.min(low, lab.model.state.position.y);
    high = Math.max(high, lab.model.state.position.y);
    if (lab.model.contact.bodyStrike) strikes++;
    if (!Number.isFinite(lab.model.state.position.y)) finite = false;
  });
  check('waves', 'the floats ride a 1 m swell (heave 0.4-1.3 m)', high - low > 0.4 && high - low < 1.3, `${round(high - low, 2)} m`);
  check('waves', 'no strikes and no NaN on the swell', strikes === 0 && finite && rig.model.contact.floating, `${strikes} strikes`);
  const run = waterTakeoff({ assists: 1, swell: { amplitude: 0.5, wavelength: 40, period: 5 } });
  check('waves', 'a takeoff run through the swell: skips are part of the run (no hard touchdown), airborne', run.liftoff !== null && run.hardTouchdowns === 0 && run.strikes === 0, run.liftoff ? `${round(run.liftoff.distance, 0)} m, ${run.hardTouchdowns} hard touchdowns, ${run.strikes} strikes` : 'never lifted off');
}

/** Water resistance (fraction of the weight) at a towed speed and a fixed trim, free to heave. */
function towResistance(speed, trim) {
  const rig = createRig();
  rig.afloat();
  rig.run(1);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), trim * DEG);
  const fixed = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  const hold = (lab) => {
    lab.model.restore({ ...lab.model.snapshot(), quaternion: fixed, angularVelocity: [0, 0, 0] });
    lab.model.state.velocity.x = 0;
    lab.model.state.velocity.z = -speed;
  };
  rig.run(6, hold);
  let drag = 0;
  let lift = 0;
  let buoyancy = 0;
  let samples = 0;
  rig.run(2, (lab) => {
    hold(lab);
    drag += lab.hydro.drag;
    lift += lab.hydro.planingLift;
    buoyancy += lab.hydro.buoyancy;
    samples++;
  });
  // The resistance along the track: drag along the keel plus the normal force tilted aft by the trim.
  const resistance = (drag / samples + (lift / samples) * Math.sin(trim * DEG)) / WEIGHT;
  return { resistance, liftShare: lift / (lift + buoyancy) };
}

function testHump() {
  const speeds = [4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22];
  const curve = speeds.map((speed) => ({ speed, ...towResistance(speed, 6) }));
  log('  tow tank (trim 6 deg):', curve.map((point) => `${point.speed}:${round(point.resistance, 3)}`).join(' '));
  const peak = curve.reduce((best, point) => (point.resistance > best.resistance ? point : best));
  const atTwenty = curve.find((point) => point.speed === 20);
  check('hump', `the water resistance peaks at ${round(peak.speed * KMH, 0)} km/h (about 45 km/h: 36-54)`, peak.speed * KMH >= 36 && peak.speed * KMH <= 54, `peak ${round(peak.resistance, 3)} W at ${peak.speed} m/s`);
  check('hump', 'the hump costs 15-30 % of the weight', peak.resistance >= 0.15 && peak.resistance <= 0.3, round(peak.resistance, 3));
  check('hump', 'on the step at 72 km/h the resistance is under 60 % of the hump', atTwenty.resistance < 0.6 * peak.resistance, `${round(atTwenty.resistance, 3)} vs ${round(peak.resistance, 3)}`);
  check('hump', 'below the hump the water carries the weight by buoyancy; on the step by planing', curve.find((point) => point.speed === 6).liftShare < 0.3 && atTwenty.liftShare > 0.6, `6 m/s ${round(curve.find((point) => point.speed === 6).liftShare, 2)}, 20 m/s ${round(atTwenty.liftShare, 2)}`);
}

/** A water takeoff at full power, flaps 2: returns the liftoff and what the run saw. */
function waterTakeoff({ assists, stick = 0, rotate = 0.15, swell = null }) {
  const rig = createRig({ assists, swell });
  rig.afloat();
  rig.run(3);
  rig.selectFlaps(2);
  rig.pilot.throttle = 1;
  const start = rig.model.state.position.clone();
  let liftoff = null;
  let stepSeconds = 0;
  let maxSpray = 0;
  let strikes = 0;
  let maxPorpoise = 0;
  let hardTouchdowns = 0;
  let slowestAcceleration = Infinity;
  let lastSpeed = 0;
  rig.run(60, (lab) => {
    flyLevelWings(lab);
    // On the water the rudder is the pilot's: keep straight with it (yaw rate to zero).
    lab.pilot.yaw = clamp(-2 * lab.data.yawRate, -1, 1);
    lab.pilot.pitch = lab.data.airspeed > 25 ? rotate : stick;
    if (lab.craftState.onStep) stepSeconds += DT;
    maxSpray = Math.max(maxSpray, lab.craftState.spray);
    maxPorpoise = Math.max(maxPorpoise, lab.craftState.porpoise);
    if (lab.model.contact.bodyStrike) strikes++;
    if (lab.model.contact.touchdown && lab.model.contact.touchdown.sinkRate > seaplane.limits.crashSinkRate) hardTouchdowns++;
    const speed = Math.abs(lab.craftState.waterSpeed);
    if (lab.model.contact.floating && speed > 6 && speed < 13) slowestAcceleration = Math.min(slowestAcceleration, (speed - lastSpeed) / DT);
    lastSpeed = speed;
    if (!liftoff && !lab.model.contact.onGround && lab.time > 5) liftoff = { time: lab.time, distance: lab.distance(start), speed: lab.data.airspeed };
    return Boolean(liftoff && lab.model.state.position.y > 15);
  });
  return { rig, liftoff, stepSeconds, maxSpray, strikes, maxPorpoise, hardTouchdowns };
}

function testTakeoff() {
  for (const [assists, label] of [[1, '100 % assists, hands off'], [0, '0 % assists, neutral stick']]) {
    const run = waterTakeoff({ assists });
    const liftoff = run.liftoff;
    check('takeoff', `${label}: airborne from the water`, liftoff !== null, liftoff ? `${round(liftoff.distance, 0)} m, ${round(liftoff.speed * KMH, 0)} km/h, ${round(liftoff.time, 1)} s` : 'never lifted off');
    if (!liftoff) continue;
    check('takeoff', `${label}: over the hump onto the step before lifting off`, run.stepSeconds > 3, `${round(run.stepSeconds, 1)} s on the step`);
    check('takeoff', `${label}: liftoff near 1.05-1.25 x the flaps-2 stall (24-30 m/s)`, liftoff.speed > 24 && liftoff.speed < 30, `${round(liftoff.speed, 1)} m/s`);
    check('takeoff', `${label}: the water run is under 330 m (a lake's length)`, liftoff.distance < 330, `${round(liftoff.distance, 0)} m`);
    check('takeoff', `${label}: spray off the floats, no strikes, no runaway porpoise`, run.maxSpray > 0.3 && run.strikes === 0 && run.maxPorpoise < 0.5, `spray ${round(run.maxSpray, 2)}, strikes ${run.strikes}, porpoise ${round(run.maxPorpoise, 2)}`);
  }
}

/**
 * Gets onto the step (neutral stick) and holds about 17 m/s with the throttle; rig.flyStep(trim)
 * then holds a trim attitude with the elevator (null: hands off) for one tick of a script.
 */
function onTheStep(assists) {
  const rig = createRig({ assists });
  rig.afloat();
  rig.run(2);
  rig.pilot.throttle = 1;
  const speed = createPid(0.15, 0.05, 0, 0, 1);
  const attitude = createPid(0.08, 0.06, 0);
  rig.flyStep = (trim) => {
    rig.pilot.yaw = clamp(-2 * rig.data.yawRate, -1, 1);
    flyLevelWings(rig);
    rig.pilot.pitch = trim === null ? 0 : attitude.update(trim - rig.hydro.heldTrim, DT);
    if (Math.abs(rig.craftState.waterSpeed) > 14 || rig.craftState.onStep) rig.pilot.throttle = speed.update(17 - Math.abs(rig.craftState.waterSpeed), DT);
  };
  rig.run(25, () => rig.flyStep(null));
  return rig;
}

function testPorpoise() {
  const middle = (seaplane.simProfile.floats.hump.trimLow + seaplane.simProfile.floats.hump.trimHigh) / 2;
  const rig = onTheStep(0);
  rig.run(8, () => rig.flyStep(middle));
  check('porpoise', `on the step at about 17 m/s holding ${middle} degrees (0 % assists): no porpoise`, rig.craftState.onStep && rig.craftState.porpoise < 0.1, `${rig.craftState.waterSpeed} m/s, trim ${rig.craftState.trim}, porpoise ${rig.craftState.porpoise}`);
  let peak = 0;
  let lowest = Infinity;
  rig.run(8, (lab) => {
    rig.flyStep(1);
    peak = Math.max(peak, lab.craftState.porpoise);
    lowest = Math.min(lowest, lab.hydro.heldTrim);
  });
  check('porpoise', 'the nose held below the stable band: porpoising grows past 0.3', peak > 0.3 && lowest < seaplane.simProfile.floats.hump.trimLow, `peak ${round(peak, 2)}, held trim down to ${round(lowest, 1)} deg`);
  let after = 1;
  rig.run(6, (lab) => {
    rig.flyStep(middle);
    after = lab.craftState.porpoise;
  });
  check('porpoise', 'back at the right attitude it dies away (under 0.1 within 6 s)', after < 0.1, `porpoise ${round(after, 3)}`);
  const assisted = onTheStep(1);
  let assistedPeak = 0;
  assisted.run(10, (lab) => {
    assisted.flyStep(null);
    assistedPeak = Math.max(assistedPeak, lab.craftState.porpoise);
  });
  check('porpoise', 'at 100 % assists hands off the water assist holds the trim band (no porpoise)', assistedPeak < 0.05 && assisted.craftState.trim > 3.5 && assisted.craftState.trim < 9.5, `peak ${round(assistedPeak, 3)}, trim ${assisted.craftState.trim}`);
}

/** A powered approach from 25 m over the water down to a touchdown at the held sink rate. */
function waterLanding({ assists = 0, sink = 0.7, gearDown = false, flare = true, ground = -20, water = 0 } = {}) {
  const rig = createRig({ assists, ground, water });
  rig.airborne({ speed: 30, height: 25, throttle: 0.35 });
  rig.selectFlaps(3);
  if (gearDown) rig.press('gearToggle');
  const speedHold = createPid(0.08, 0.03, 0, 0, 1);
  const vertical = createSinkPilot();
  vertical.reset(0);
  let touchdown = null;
  let warning = false;
  let warningBefore = false;
  let strike = null;
  let strikeSeen = false;
  rig.run(70, (lab) => {
    flyLevelWings(lab);
    const height = lab.model.state.position.y - Math.max(water, ground) - 2.2;
    vertical.target = flare && height < 3 ? -Math.min(sink, 0.4) : -sink;
    if (!touchdown) {
      vertical.fly(lab);
      lab.pilot.throttle = speedHold.update(26 - lab.data.airspeed, DT);
    } else {
      // After the touchdown: power off, stick neutral, the water slows it down.
      lab.pilot.throttle = 0;
      lab.pilot.pitch = 0;
      lab.pilot.yaw = clamp(-2 * lab.data.yawRate, -1, 1);
    }
    if (lab.craftState.noseOverWarning || lab.craftState.skidWarning) warning = true;
    if (!touchdown && lab.model.contact.touchdown) {
      touchdown = { sinkRate: lab.model.contact.touchdown.sinkRate, time: lab.time, speed: Math.hypot(lab.model.state.velocity.x, lab.model.state.velocity.z) };
      warningBefore = warning;
    }
    if (lab.model.contact.bodyStrike && !strikeSeen) {
      strikeSeen = true;
      strike = { part: lab.model.contact.bodyStrike.part, speed: lab.model.contact.bodyStrike.speed, time: lab.time };
      return true;
    }
    return Boolean(touchdown && lab.time > touchdown.time + 25);
  });
  return { rig, touchdown, warningBefore, warning, strike };
}

function testLanding() {
  const landing = waterLanding({});
  const touchdown = landing.touchdown;
  check('landing', 'a powered approach touches down on the water', touchdown !== null && !landing.strike, touchdown ? `sink ${round(touchdown.sinkRate, 2)} m/s at ${round(touchdown.speed * KMH, 0)} km/h` : JSON.stringify(landing.strike));
  const landed = landing.rig.events.landed[0];
  check('landing', "the landed event: surface 'water', graded like a ground landing", landed && landed.surface === 'water' && ['butter', 'smooth', 'firm'].includes(landed.grade), JSON.stringify(landed ?? null));
  check('landing', 'the run-out slows it to taxi speed within 25 s, afloat', Math.abs(landing.rig.craftState.waterSpeed) < 5 && landing.rig.model.contact.floating, `${landing.rig.craftState.waterSpeed} m/s`);
  check('landing', 'the journal hears of the water landing (seaplaneWaterLandings)', landing.rig.events.stats.some((stat) => stat.key === 'seaplaneWaterLandings' && stat.op === 'add' && stat.value === 1), JSON.stringify(landing.rig.events.stats));
  // A hard arrival: 5 m/s down from just above the water.
  const hard = createRig();
  hard.model.reset({ position: new THREE.Vector3(0, 4.5, 0), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 6 * DEG), velocity: new THREE.Vector3(0, -5, -25), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: false, engineOn: true });
  let hardTouchdown = null;
  hard.run(3, (lab) => {
    if (lab.model.contact.touchdown && !hardTouchdown) hardTouchdown = lab.model.contact.touchdown.sinkRate;
    return hardTouchdown !== null;
  });
  check('landing', 'a hard arrival on the water exceeds the crash sink rate (the soft crash)', hardTouchdown !== null && hardTouchdown > seaplane.limits.crashSinkRate, `${round(hardTouchdown, 2)} m/s`);
}

function testNoseOver() {
  const run = waterLanding({ gearDown: true });
  check('noseOver', 'gear down over the water: the advisory rises on the approach, before touching', run.warningBefore || (run.warning && run.strike && !run.touchdown), `warning ${run.warning}, before ${run.warningBefore}`);
  check('noseOver', "the wheels dig in: body strike 'nose-over' (the soft crash)", run.strike && run.strike.part === 'nose-over', JSON.stringify(run.strike));

  const ramp = createRig({ assists: 1 });
  ramp.afloat();
  ramp.run(1);
  ramp.press('gearToggle');
  ramp.run(9);
  let rampStrike = null;
  ramp.pilot.throttle = 0.12;
  ramp.run(10, (lab) => {
    if (lab.model.contact.bodyStrike) rampStrike = lab.model.contact.bodyStrike.part;
    lab.pilot.throttle = Math.abs(lab.craftState.waterSpeed) > 2 ? 0 : 0.12;
  });
  check('noseOver', 'wheels down in the water at a walking pace (a ramp) do not dig in', ramp.craftState.gearPosition === 1 && rampStrike === null, `gear ${ramp.craftState.gearPosition}, ${ramp.craftState.waterSpeed} m/s, strike ${rampStrike}`);
  let warned = false;
  let strike = null;
  ramp.pilot.throttle = 1;
  ramp.run(8, (lab) => {
    if (lab.craftState.noseOverWarning) warned = warned || Math.abs(lab.craftState.waterSpeed) < seaplane.limits.noseOverSpeed;
    if (lab.model.contact.bodyStrike) {
      strike = { part: lab.model.contact.bodyStrike.part, speed: lab.model.contact.bodyStrike.speed };
      return true;
    }
    return false;
  });
  check('noseOver', 'speeding up with the wheels down: the advisory first, then the nose-over above the limit', warned && strike && strike.part === 'nose-over' && strike.speed > seaplane.limits.noseOverSpeed, JSON.stringify({ warned, strike }));
}

function testLand() {
  const rig = createRig({ water: -Infinity, ground: 0 });
  rig.parked();
  let strikes = 0;
  rig.run(8, (lab) => {
    if (lab.model.contact.bodyStrike) strikes++;
  });
  check('land', 'parked on the wheels: steady, on the gear, no strikes', rig.model.contact.onGround && rig.model.contact.gearContacts >= 3 && strikes === 0 && rig.craftState.gearPosition === 1 && rig.model.state.velocity.length() < 0.1, `gear contacts ${rig.model.contact.gearContacts}, speed ${round(rig.model.state.velocity.length(), 3)}`);
  rig.press('gearToggle');
  check('land', 'the gear refuses to retract with the weight on the wheels', rig.craftState.gearPosition === 1 && rig.events.notify.some((text) => /stays down/.test(text)), rig.events.notify.join(' | '));
  rig.selectFlaps(2);
  rig.pilot.throttle = 1;
  const start = rig.model.state.position.clone();
  let liftoff = null;
  rig.run(40, (lab) => {
    flyLevelWings(lab);
    lab.pilot.yaw = clamp(-2 * lab.data.yawRate, -1, 1);
    lab.pilot.pitch = lab.data.airspeed > 25 ? 0.25 : 0;
    if (lab.model.contact.bodyStrike) strikes++;
    if (!liftoff && !lab.model.contact.onGround) liftoff = { distance: lab.distance(start), speed: lab.data.airspeed };
    return Boolean(liftoff);
  });
  check('land', 'wheels down: rolls and takes off from land', liftoff !== null && strikes === 0, liftoff ? `${round(liftoff.distance, 0)} m at ${round(liftoff.speed, 1)} m/s` : 'no liftoff');

  const beach = createRig({ water: -Infinity, ground: 0 });
  beach.parked();
  beach.run(1);
  beach.model.restore({ ...beach.model.snapshot(), systems: { ...beach.model.snapshot().systems, gearDown: false, gearPosition: 0 } });
  const quaternion = new THREE.Quaternion();
  beach.model.reset({ position: new THREE.Vector3(0, 2.25, 0), quaternion, velocity: new THREE.Vector3(0, 0, -3), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: false, engineOn: true });
  let beachStrike = null;
  beach.run(8, (lab) => {
    if (lab.model.contact.bodyStrike) beachStrike = lab.model.contact.bodyStrike.part;
  });
  check('land', 'wheels up, a slow beaching (3 m/s) skids to a stop on the keels', beachStrike === null && beach.model.state.velocity.length() < 0.3 && beach.craftState.gearPosition === 0, `strike ${beachStrike}, speed ${round(beach.model.state.velocity.length(), 2)}`);

  const skid = waterLanding({ ground: 0, water: -Infinity });
  check('land', "wheels up on land at landing speed: body strike 'floats on land' (the soft crash)", skid.strike && skid.strike.part === 'floats on land' && skid.strike.speed > seaplane.limits.skidCrashSpeed, JSON.stringify(skid.strike));
  check('land', 'the skid advisory rose on the approach over land', skid.warning, `warning ${skid.warning}`);
}

/** Heading change (deg, accumulated: right positive) over 8 s taxiing at idle with the given pedal and toe brakes. */
function taxiTurn({ rudders, yaw = 0, brakeL = 0, brakeR = 0, throttle = 0.15 }) {
  const rig = createRig();
  rig.afloat();
  rig.craftState.waterRudders = rudders;
  rig.run(1);
  let previous = rig.data.heading;
  let turned = 0;
  rig.run(8, (lab) => {
    lab.pilot.throttle = throttle;
    lab.pilot.yaw = yaw;
    lab.pilot.brakeL = brakeL;
    lab.pilot.brakeR = brakeR;
    turned += wrapDegrees(lab.data.heading - previous + 180) - 180;
    previous = lab.data.heading;
  });
  return turned;
}

function testRudders() {
  const down = taxiTurn({ rudders: true, yaw: 1 });
  const up = taxiTurn({ rudders: false, yaw: 1 });
  check('rudders', 'full right pedal at idle: water rudders down turn right far faster than up', down > 25 && down > 2 * Math.max(up, 1), `down ${round(down, 1)} deg, up ${round(up, 1)} deg in 8 s`);
  const toe = taxiTurn({ rudders: true, brakeL: 1 });
  check('rudders', 'the left toe brake steers the water rudders left', toe < -15, `${round(toe, 1)} deg`);
  const step = onTheStep(1);
  const sternWet = step.craftState.onStep;
  let headingChange = 0;
  step.craftState.waterRudders = true;
  const before = step.data.heading;
  step.run(1, () => {
    step.flyStep(null);
    step.pilot.yaw = 0;
  });
  headingChange = Math.abs(wrapDegrees(step.data.heading - before + 180) - 180);
  check('rudders', 'on the step the sterns (and the water rudders) are out of the water: no yaw from lowering them', sternWet && headingChange < 2, `${round(headingChange, 2)} deg`);
}

function testGear() {
  const rig = createRig();
  rig.afloat();
  rig.run(1);
  rig.press('gearToggle');
  rig.run(9);
  check('gear', 'the gear toggle lowers the wheels on the water (8 s travel)', rig.craftState.gearPosition === 1 && rig.events.notify.some((text) => /Gear down/.test(text)), `gear ${rig.craftState.gearPosition}`);
  rig.press('gearToggle');
  rig.run(9);
  check('gear', 'and raises them again on the water', rig.craftState.gearPosition === 0, `gear ${rig.craftState.gearPosition}`);
  const air = createRig();
  air.airborne({ speed: 45, height: 400, throttle: 0.6 });
  check('gear', 'airborne resets start with the wheels up (the water configuration)', air.craftState.gearPosition === 0 || air.model.snapshot().systems.gearDown === false);
  const api = { craftState: air.craftState, setCraftState(field, value) { air.craftState[field] = value; } };
  const reply = seaplane.copilot.commands.find((command) => command.id === 'landingConfig').run(api, 'runway');
  air.run(10, (lab) => flyLevelWings(lab));
  check('gear', "the copilot's 'runway landing' configuration lowers the gear", air.model.snapshot().systems.gearDown === true && air.craftState.gearPosition === 1 && /Gear down/.test(reply), reply);
  seaplane.copilot.commands.find((command) => command.id === 'landingConfig').run(api, 'water');
  air.run(10, (lab) => flyLevelWings(lab));
  check('gear', "and 'water landing' raises it with the water rudders up", air.model.snapshot().systems.gearDown === false && air.craftState.waterRudders === false);
}

function situationAt({ overWater, agl, wasOnGround = false, wasOnWater = false, groundSpeed = 40 }) {
  const position = new THREE.Vector3(100, (overWater ? 0 : 50) + agl, 200);
  return {
    position, heading: 90, trackHeading: 90, groundSpeed, velocity: new THREE.Vector3(groundSpeed, 0, 0), airspeed: groundSpeed, agl,
    surfaceHeight: overWater ? 0 : 50, overWater, waterBody: null, waterHeight: overWater ? 0 : null, wasOnGround, wasOnWater,
    previousCraft: 'glider', wind: { vel: new THREE.Vector3(), turbulence: 0 }, time: 0, dayTime: 0.5,
  };
}

function testSituate() {
  const api = { headingIntoWind: () => 250 };
  const low = seaplane.situate(situationAt({ overWater: true, agl: 12, groundSpeed: 1 }), api);
  check('situate', 'over water and low: afloat, nose into the wind, water rudders down', low.mode === 'water' && low.heading === 250 && low.speed === 0 && low.craftState.waterRudders === true, JSON.stringify(low));
  const landed = seaplane.situate(situationAt({ overWater: true, agl: 2, wasOnWater: true, groundSpeed: 5 }), api);
  check('situate', 'landed on the water and moving: afloat along the track', landed.mode === 'water' && landed.heading === 90 && landed.speed === 5, JSON.stringify(landed));
  const high = seaplane.situate(situationAt({ overWater: true, agl: 900 }), api);
  const stall = Math.sqrt((2 * WEIGHT) / (SEA_LEVEL_RHO * seaplane.simProfile.wing.area * seaplane.simProfile.aero.clMax));
  check('situate', 'over water and high: a low approach into the wind at 1.3 x stall, at most 150 m up', high.mode === 'air' && high.heading === 250 && Math.abs(high.speed - 1.3 * stall) < 0.01 && high.position.y <= 150 && high.position.y >= 60, JSON.stringify(high));
  const ground = seaplane.situate(situationAt({ overWater: false, agl: 0.5, wasOnGround: true }), api);
  check('situate', 'landed on land: on the wheels at a flat spot', ground.mode === 'ground' && ground.flatSpot === true, JSON.stringify(ground));
  const flying = seaplane.situate(situationAt({ overWater: false, agl: 600 }), api);
  check('situate', 'flying over land: the Phase 1 rules (no mode), water rudders up', flying.mode === undefined && flying.craftState.waterRudders === false, JSON.stringify(flying));
}

function testCopilot() {
  const samples = {
    waterRudders: [['water rudders down', 'down'], ['raise the water rudders', 'raise'], ['water rudder up', 'up']],
    landingConfig: [['set up for a water landing', 'water'], ['runway landing checklist', 'runway'], ['gear for lake landing', 'lake']],
    stepCheck: [['are we on the step', undefined], ['step status', undefined]],
  };
  for (const command of seaplane.copilot.commands) {
    const expressions = command.phrases.map((phrase) => new RegExp(phrase, 'i'));
    for (const [text, value] of samples[command.id] ?? []) {
      const match = expressions.map((expression) => expression.exec(text)).find(Boolean);
      check('copilot', `"${text}" -> ${command.id}${value ? ` (${value})` : ''}`, match && match[1] === value, match ? `captured ${match[1]}` : 'no match');
    }
  }
  const craftState = seaplane.abilities.craftAbility.initialState();
  const api = { craftState, telemetry: { gear: { down: false } }, setCraftState(field, value) { craftState[field] = value; } };
  const run = (id, value) => seaplane.copilot.commands.find((command) => command.id === id).run(api, value);
  check('copilot', 'water rudders down / up act and answer', /down/.test(run('waterRudders', 'down')) && craftState.waterRudders === true && /up/.test(run('waterRudders', 'raise')) && craftState.waterRudders === false);
  Object.assign(craftState, { onWater: true, onStep: true, waterSpeed: 16, trim: 6.4, porpoise: 0 });
  const status = seaplane.copilot.status(craftState, { gear: { down: false } });
  check('copilot', 'the status line reads the gear, the water rudders and the step', /Gear up/.test(status) && /Water rudders up/.test(status) && /On the step at 58 km\/h/.test(status), status);
  craftState.porpoise = 0.6;
  craftState.trim = 2;
  check('copilot', 'porpoising: the status says which way to move the nose', /ease the nose up/.test(seaplane.copilot.status(craftState, { gear: { down: true } })));
}

// ---- Through the FlightController -------------------------------------------------------------
const SEA_SOUTH_OF = 3000;

/** The soft-crash fade draws a DOM overlay; headless it gets a stand-in element. */
function ensureDocumentStandIn() {
  if (typeof globalThis.document !== 'undefined') return;
  const element = { style: {}, setAttribute() {} };
  globalThis.document = { body: { appendChild() {} }, getElementById: () => null, createElement: () => element };
}

/**
 * The controller in a world: the flat sea south of SEA_SOUTH_OF with land at 40 m north of it, or a
 * synthetic water world { groundHeight, waterQuery } (createWaterWorld).
 */
function createGame(waterWorld = null, steadyWind = null) {
  ensureDocumentStandIn();
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], softCrash: [], landed: [], speech: [], stats: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('softCrash', (payload) => events.softCrash.push(payload));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  bus.onTyped('journalStat', (payload) => events.stats.push(payload));
  // Land at 40 m north of z = 3000, a sea 30 m deep south of it.
  const world = waterWorld ? { groundHeight: waterWorld.groundHeight, heightAt: waterWorld.groundHeight, WATER_LEVEL: 0 } : {
    groundHeight: (x, z) => (z < SEA_SOUTH_OF ? 40 : -30),
    heightAt: (x, z) => (z < SEA_SOUTH_OF ? 40 : -30),
    WATER_LEVEL: 0,
  };
  const player = {
    position: new THREE.Vector3(0, 300, 6000), velocity: new THREE.Vector3(0, 0, -40), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0), speed: 40, throttle: 0.5, heading: 0, pitch: 0, roll: 0, yawRate: 0, verticalSpeed: 0,
    gForce: 1, altitude: 300, groundHeight: 0, agl: 300, stalled: false, autopilot: { enabled: false, heading: 0, altitude: 300, followWaypoint: false }, inCloud: 0,
  };
  const state = {
    frame: 0, paused: false, photoMode: false, seed: 'SEAPLANE-LAB',
    time: { elapsed: 0, realElapsed: 0, frameDt: 0, nightFactor: 0, sunElevation: 30, dayTime: 0.45 },
    player, flight: createFlightTelemetry(), waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const settingsValues = { craft: 'glider', startOnGround: false, assists: Object.fromEntries(CRAFT_IDS.map((id) => [id, 1])), craftFavorites: ['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv', 'aerobatic', 'seaplane', 'eagle', 'spaceplane'], craftSkins: {} };
  const controls = createControlState();
  const { uniform } = TSL;
  const sprays = { emitted: 0 };
  const effects = {
    createSpray: (overrides = {}) => ({ x: 0, y: 0, z: 0, count: 0, ...overrides }),
    emitSpray(spray) {
      sprays.emitted += spray.count;
      return spray.count;
    },
  };
  const ctx = {
    THREE, TSL, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50000), state, controls, bus, world,
    uniforms: { time: uniform(0), sunDirection: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)), skyHorizonColor: uniform(new THREE.Color(1, 1, 1)), skyZenithColor: uniform(new THREE.Color(1, 1, 1)), nightFactor: uniform(0) },
    craftRegistry,
    flightModels,
    waterQuery: waterWorld ? waterWorld.waterQuery : undefined,
    settings: {
      get: (key) => {
        const value = settingsValues[key];
        if (Array.isArray(value)) return value.slice();
        return value && typeof value === 'object' ? { ...value } : value;
      },
      set(key, value) {
        settingsValues[key] = value;
        bus.emit('settings:changed', { key, value, settings: { ...settingsValues } });
        return true;
      },
      update(key, patch) {
        settingsValues[key] = { ...settingsValues[key], ...patch };
        bus.emit('settings:changed', { key, value: settingsValues[key], settings: { ...settingsValues } });
        return true;
      },
    },
    wind: {
      sample(pos, t, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
        if (steadyWind) out.vel.copy(steadyWind.vel);
        else out.vel.set(0, 0, 0);
        out.turbulence = 0;
        return out;
      },
      ambientAt: () => (steadyWind ? { speed: steadyWind.speed, fromDegrees: steadyWind.fromDegrees } : { speed: 4, fromDegrees: 200 }),
    },
    systems: {
      camera: { snap() {} },
      input: { presetThrottle: (value) => { controls.throttle = value; return true; } },
      copilot: { speak: (text) => { events.speech.push(text); return text; } },
      water: { effects },
    },
    registerPrewarm() {},
  };
  const flight = createFlightController(ctx);
  ctx.systems.flight = flight;
  const game = { flight, state, controls, events, ctx, settings: ctx.settings, sprays, bus };
  game.frame = () => {
    state.frame++;
    state.time.elapsed += FRAME;
    state.time.realElapsed += FRAME;
    state.time.frameDt = FRAME;
    flight.update(FRAME, FRAME);
    flight.publishTelemetry(FRAME);
  };
  game.run = (seconds, script) => {
    for (let frame = 0; frame < Math.round(seconds / FRAME); frame++) {
      if (script && script(game) === true) return;
      game.frame();
    }
  };
  return game;
}

/**
 * A 0 % assists approach pilot on the live controls: holds a sink rate with the elevator and an
 * airspeed with the throttle until the floats touch, then power off and stick neutral.
 */
function createApproachPilot({ sink, speed }) {
  const vertical = createPid(0.06, 0.04, 0);
  const power = createPid(0.08, 0.03, 0, 0, 1);
  let touched = false;
  return (game) => {
    const flightState = game.state.flight;
    if (flightState.onGround) touched = true;
    // Wings level with the ailerons, the ball centred with the rudder (on the water: yaw rate to zero).
    game.controls.roll = clamp(-1.6 * flightState.roll * DEG + 0.35 * flightState.angularVelocity.z, -1, 1);
    game.controls.yaw = flightState.onGround ? clamp(2 * flightState.angularVelocity.y, -1, 1) : clamp(4 * flightState.sideslip * DEG, -1, 1);
    if (touched) {
      game.controls.pitch = 0;
      game.controls.throttle = 0;
      return;
    }
    game.controls.pitch = clamp(vertical.update(-sink - flightState.verticalSpeed, FRAME) - 0.6 * flightState.angularVelocity.x, -1, 1);
    game.controls.throttle = power.update(speed - flightState.airspeed, FRAME);
  };
}

/** Three flapsDown presses on consecutive frames (a reset leaves the flaps up). */
function setFullFlaps(game) {
  for (let notch = 0; notch < 3; notch++) {
    game.controls.actions.add('flapsDown');
    game.frame();
  }
}

/** The four gear legs of the mesh: the groups whose second child is the wheel group. */
function gearLegs(root) {
  const legs = [];
  root.traverse((object) => {
    if (object.isGroup && object.children.length === 2 && object.children[1].isGroup && object.children[1].children.length === 1) legs.push(object);
  });
  return legs;
}

function testController() {
  const game = createGame();
  game.run(1);
  // Low over the sea in the glider, then switch: the seaplane is placed afloat.
  game.flight.startAt({ mode: 'air', position: { x: 0, y: 18, z: 5000 }, heading: 180, speed: 26 });
  game.run(0.2);
  game.settings.set('craft', 'seaplane');
  game.run(1);
  const telemetry = game.state.flight;
  check('controller', 'a switch low over the sea places the seaplane afloat (situate: water), wheels up', game.flight.getCraft() === 'seaplane' && telemetry.onWater === true && telemetry.craftState.waterRudders === true && telemetry.gear.down === false && game.flight.getStats().placements >= 1, `onWater ${telemetry.onWater}, rudders ${telemetry.craftState.waterRudders}, gear ${telemetry.gear.down}`);
  game.run(4);
  check('controller', 'afloat through the controller: no soft crash, still on the water', game.events.softCrash.length === 0 && telemetry.onWater && telemetry.onGround, `crashes ${game.events.softCrash.length}`);
  const legs = gearLegs(game.flight.planeMesh);
  check('controller', 'the mesh carries four gear legs, folded up (wheels up on the water)', legs.length === 4 && legs.every((leg) => Math.abs(leg.rotation.x) > 1), legs.map((leg) => round(leg.rotation.x, 2)).join(', '));

  // Full power: the spray flies off the floats.
  game.controls.throttle = 1;
  game.run(10);
  check('controller', 'the takeoff run throws spray (droplets through the water effects layer)', game.sprays.emitted > 200, `${game.sprays.emitted} droplets`);
  check('controller', 'the water-rudder reminder appears on the run', game.events.notify.some((text) => /Water rudders are still down/.test(text)), game.events.notify.slice(-4).join(' | '));
  const rudderBefore = telemetry.craftState.waterRudders;
  game.flight.runAbility('craftAbility');
  check('controller', 'the ability raises the water rudders', rudderBefore === true && telemetry.craftState.waterRudders === false);

  // A water landing at 0 % assists, graded with surface 'water'.
  game.settings.update('assists', { seaplane: 0 });
  game.flight.startAt({ mode: 'air', position: { x: 0, y: 30, z: 5200 }, heading: 180, speed: 27 });
  setFullFlaps(game);
  const approach = createApproachPilot({ sink: 0.8, speed: 26 });
  game.run(60, (lab) => {
    approach(lab);
    return lab.events.landed.length > 0 && lab.state.flight.groundSpeed < 4;
  });
  check('controller', "a water landing through the controller: landed with surface 'water', no soft crash", game.events.landed.length === 1 && game.events.landed[0].surface === 'water' && game.events.softCrash.length === 0, JSON.stringify(game.events.landed[0] ?? game.events.softCrash[0] ?? null));
  check('controller', 'journal stats from the landing (seaplaneWaterLandings)', game.events.stats.some((stat) => stat.key === 'seaplaneWaterLandings'));

  // Wheels down over the water: the advisory speaks once, then the nose-over soft crash.
  game.flight.startAt({ mode: 'air', position: { x: 0, y: 40, z: 5400 }, heading: 180, speed: 27 });
  game.controls.actions.add('gearToggle');
  const spokenBefore = game.events.speech.length;
  const crashesBefore = game.events.softCrash.length;
  setFullFlaps(game);
  const wheelsDown = createApproachPilot({ sink: 1.2, speed: 26 });
  game.run(60, (lab) => {
    wheelsDown(lab);
    return lab.events.softCrash.length > crashesBefore;
  });
  const advisories = game.events.speech.slice(spokenBefore).filter((text) => /Gear is down/.test(text));
  check('controller', 'gear down over water: WREN speaks the gear advisory once before contact', advisories.length === 1, game.events.speech.slice(spokenBefore).join(' | '));
  const noseOver = game.events.softCrash[crashesBefore];
  check('controller', "the wheels-down water landing soft-crashes with reason 'nose-over strike'", noseOver && noseOver.reason === 'nose-over strike', JSON.stringify(noseOver ?? null));
  game.run(2);

  // Wheels up onto land at speed: the skid soft crash.
  game.flight.startAt({ mode: 'air', position: { x: 0, y: 70, z: 2600 }, heading: 0, speed: 27 });
  game.run(0.1);
  if (game.state.flight.gear.down) game.controls.actions.add('gearToggle');
  const skidBefore = game.events.softCrash.length;
  const skidSpoken = game.events.speech.length;
  setFullFlaps(game);
  const onLand = createApproachPilot({ sink: 1.2, speed: 26 });
  game.run(60, (lab) => {
    onLand(lab);
    return lab.events.softCrash.length > skidBefore;
  });
  const skid = game.events.softCrash[skidBefore];
  check('controller', "wheels up onto land at speed soft-crashes with reason 'floats on land strike'", skid && skid.reason === 'floats on land strike', JSON.stringify(skid ?? null));
  check('controller', 'the skid advisory spoke on that approach', game.events.speech.slice(skidSpoken).some((text) => /Gear is up/.test(text)), game.events.speech.slice(skidSpoken).join(' | '));
  game.run(2);

  // The mesh: the legs follow the gear down after a gear toggle in the air.
  game.controls.actions.add('gearToggle');
  game.run(10);
  const down = gearLegs(game.flight.planeMesh);
  check('controller', 'the legs swing down with the gear (8 s travel)', game.state.flight.gear.down === true && down.every((leg) => Math.abs(leg.rotation.x) < 0.01), down.map((leg) => round(leg.rotation.x, 3)).join(', '));

  // Dispose: switching away removes the extension's landed listener.
  const before = game.bus.listeners.get('landed')?.size ?? 0;
  game.settings.set('craft', 'glider');
  game.run(0.5);
  const after = game.bus.listeners.get('landed')?.size ?? 0;
  check('controller', "switching away disposes the floats extension (its 'landed' listener is gone)", game.flight.getCraft() === 'glider' && after === before - 1, `${before} -> ${after}`);
}

// ---- The ?test=craft scenarios, dry-run in node ------------------------------------------------
/** The scenarios' world: seed CRAFT-1 with the water fixtures, as the craft test builds it. */
function createWaterWorld() {
  const world = createWorldGen('CRAFT-1', { ...WORLD_OPTIONS, presets: WATER_FIXTURES });
  const clock = { elapsed: 0 };
  const waterQuery = createWaterQuery({ world, windDirection: prevailingWindDirection(world), clock });
  return { groundHeight: (x, z) => world.groundHeight(x, z), waterQuery, clock, world };
}

/**
 * Flies one scenario of the seaplane's ?test=craft file through the controller in a steady wind
 * (m/s, blowing from fromDegrees): { checks, crashes, memo }. The start resolves as the craft test
 * resolves it (a fixed point; afloat or `agl` above the surface).
 */
function flyScenario(scenario, waterWorld, wind) {
  const windVector = new THREE.Vector3(-Math.sin(wind.fromDegrees * DEG), 0, Math.cos(wind.fromDegrees * DEG)).multiplyScalar(wind.speed);
  const game = createGame(waterWorld, { vel: windVector, speed: wind.speed, fromDegrees: wind.fromDegrees });
  game.settings.set('craft', 'seaplane');
  game.run(0.5);
  const start = scenario.start;
  const surface = Math.max(waterWorld.groundHeight(start.at.x, start.at.z), waterWorld.waterQuery.heightAt(start.at.x, start.at.z));
  const heading = Number.isFinite(start.heading) ? start.heading : 300;
  const placement = { mode: start.mode, heading, position: { x: start.at.x, y: start.mode === 'water' ? surface : surface + start.agl, z: start.at.z } };
  if (Number.isFinite(start.speed)) placement.speed = start.speed;
  if (start.craftState) placement.craftState = start.craftState;
  game.flight.startAt(placement);
  game.run(0.05);
  const typed = new Map();
  for (const type of ['landed', 'softCrash']) game.bus.onTyped(type, (payload) => typed.set(type, { count: (typed.get(type)?.count ?? 0) + 1, last: payload }));
  const once = new Set();
  const memo = {};
  const player = game.state.player;
  const startPose = { x: player.position.x, y: player.position.y, z: player.position.z, heading };
  const run = { t: 0 };
  const surfaceAt = (x, z) => Math.max(waterWorld.groundHeight(x, z), waterWorld.waterQuery.heightAt(x, z));
  const api = {
    get t() { return run.t; },
    get flight() { return game.state.flight; },
    get craftState() { return game.state.flight.craftState; },
    get player() { return game.state.player; },
    world: game.ctx.world,
    waterQuery: waterWorld.waterQuery,
    wind: game.ctx.wind,
    memo,
    start: startPose,
    once(key) {
      if (once.has(key)) return false;
      once.add(key);
      return true;
    },
    events: { count: (type) => typed.get(type)?.count ?? 0, last: (type) => typed.get(type)?.last ?? null },
    agl: () => player.position.y - surfaceAt(player.position.x, player.position.z),
  };
  const states = scenario.checks.map(() => ({ passed: false, failed: false, seen: false }));
  const axes = ['roll', 'pitch', 'yaw', 'throttle', 'brakeL', 'brakeR'];
  const startElapsed = game.state.time.elapsed;
  game.run(scenario.seconds, (lab) => {
    run.t = lab.state.time.elapsed - startElapsed;
    waterWorld.clock.elapsed = lab.state.time.elapsed;
    const controls = scenario.script(run.t, api);
    for (const axis of axes) if (Number.isFinite(controls[axis])) lab.controls[axis] = controls[axis];
    for (const action of controls.actions ?? []) lab.controls.actions.add(action);
    if (process.env.SEA_DEBUG && Math.round(run.t * 60) % 60 === 0) log('   ', scenario.id, round(run.t, 0), memo.phase, 'x', round(player.position.x, 0), 'z', round(player.position.z, 0), 'agl', round(api.agl(), 1), 'v', round(game.state.flight.airspeed, 1), 'vs', round(game.state.flight.verticalSpeed, 1), 'hdg', round(game.state.flight.heading, 0), 'thr', round(game.state.flight.throttle, 2), 'onG', game.state.flight.onGround, memo.plan ? `plan ${memo.plan.heading} ahead ${memo.plan.ahead} behind ${memo.plan.behind} rim ${round(memo.plan.rim, 1)} side ${memo.plan.side}` : '');
    scenario.checks.forEach((check, index) => {
      const state = states[index];
      const from = Number.isFinite(check.from) ? check.from : 0;
      const until = Number.isFinite(check.until) ? check.until : scenario.seconds;
      if (run.t < from || run.t > until || state.failed || (!check.always && state.passed)) return;
      const holds = Boolean(check.test(api));
      state.seen = true;
      if (check.always && !holds) state.failed = true;
      else if (holds) state.passed = true;
    });
    return false;
  });
  return {
    checks: scenario.checks.map((check, index) => ({ id: check.id, passed: check.always ? states[index].seen && !states[index].failed : states[index].passed })),
    crashes: game.events.softCrash,
    memo,
  };
}

/** Steady winds the dry-run flies in: calm, and 6 m/s from two directions. */
const SCENARIO_WINDS = Object.freeze([
  Object.freeze({ speed: 0, fromDegrees: 0 }),
  Object.freeze({ speed: 6, fromDegrees: 40 }),
  Object.freeze({ speed: 6, fromDegrees: 230 }),
]);

function testScenarios() {
  const waterWorld = createWaterWorld();
  for (const scenario of seaplaneScenarios.scenarios) {
    for (const wind of SCENARIO_WINDS) {
      if (process.env.SEA_ONLY && process.env.SEA_ONLY !== `${scenario.id}:${wind.fromDegrees}:${wind.speed}`) continue;
      const result = flyScenario(scenario, waterWorld, wind);
      const failed = result.checks.filter((check) => !check.passed).map((check) => check.id);
      const crashesOk = scenario.allowCrash || result.crashes.length === 0;
      check('scenarios', `${scenario.id} (wind ${wind.speed} m/s from ${wind.fromDegrees}): every check passes${scenario.allowCrash ? '' : ' with no soft crash'}`, failed.length === 0 && crashesOk, `failed [${failed.join(', ')}], crashes ${JSON.stringify(result.crashes.map((crash) => crash.reason))}, phase ${result.memo.phase}`);
    }
  }
}

function testAllocation() {
  if (typeof global.gc !== 'function') {
    check('allocation', 'run with --expose-gc to measure', false, 'no global.gc');
    return;
  }
  const rig = onTheStep(1);
  rig.run(2);
  global.gc();
  const before = process.memoryUsage().heapUsed;
  rig.run(20000 * DT, () => rig.flyStep(null));
  global.gc();
  const growth = process.memoryUsage().heapUsed - before;
  check('allocation', '20 000 ticks on the step retain nothing (heap within 128 KB after a full collection)', growth < 128 * 1024, `${round(growth / 1024, 1)} KB`);
}

const TESTS = { registry: testRegistry, flight: testFlight, afloat: testAfloat, waves: testWaves, hump: testHump, takeoff: testTakeoff, porpoise: testPorpoise, landing: testLanding, noseOver: testNoseOver, land: testLand, rudders: testRudders, gear: testGear, situate: testSituate, copilot: testCopilot, controller: testController, scenarios: testScenarios, allocation: testAllocation };
for (const [name, test] of Object.entries(TESTS)) {
  if (ONLY && ONLY !== name) continue;
  try {
    test();
  } catch (error) {
    check(name, 'the test ran without throwing', false, error && error.stack ? error.stack.split('\n').slice(0, 3).join(' / ') : String(error));
  }
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} seaplane checks in ${round((Date.now() - started) / 1000, 1)} s\n`);
process.exit(failed === 0 ? 0 : 1);
