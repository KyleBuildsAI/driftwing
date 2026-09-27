// Trim: puts a SIM model that was just reset (mode switch, respawn, airstart, craft switch, tow
// release) into a consistent, trimmed state at its position and velocity, so the first hands-off
// seconds fly straight on instead of pitching toward whatever the reset attitude implied.
//
// The FlightController calls trimModel(model, request) after model.reset(pose) for airborne poses;
// model kinds without a trim handler are left as reset. A handler is registered per model kind:
//   registerTrimHandler('fixedWing', { trim(model, request) -> result | null });
//
// Fixed-wing trim keeps the position, the velocity vector (so the path and the track) and the bank,
// and solves for the angle of attack and the elevator that give the requested load factor with no
// pitching acceleration, by probing the model itself: each probe restores a snapshot with a
// candidate attitude and elevator, runs one physics tick and measures the load factor and the pitch
// acceleration, then the snapshot is restored again (a 2x2 Newton iteration, a handful of probes).
// The angle of attack never goes closer to the critical angle than STALL_MARGIN; when the speed is
// too low for the load there, the result reports the load it could reach. The trimmed state has the
// rates of a steady turn at that bank, the servos already at the trimmed deflections and the load
// sensor reading the trimmed load, so the assists (primed with the result, see primeAssists in
// assists.js) and the autopilot take over without a transient.
//
// result: { aoa, elevator, load, flightPath, bank, speed, stallSpeed, vne, safeSpeed: { min, max },
//           aoaLimited }  (SI, radians)
import * as THREE from 'three/webgpu';
import { DEG, clamp } from '../core/util.js';
import { createControlState } from '../input/controlState.js';

const GRAVITY = 9.81;
const handlers = new Map();

/** Registers the trim handler of a model kind: { trim(model, request) -> result | null }. */
export function registerTrimHandler(kind, handler) {
  if (!handler || typeof handler.trim !== 'function') throw new TypeError(`trim handler for "${kind}" needs trim()`);
  handlers.set(kind, handler);
}

export function hasTrimHandler(kind) {
  return handlers.has(kind);
}

/**
 * Trims a model at its current position and velocity. request: { env (the controller's tick env:
 * rho, wind, groundHeight, waterLevel), dt, throttle, trim (the pilot's pitch trim axis), bank
 * (rad, optional: the bank to keep; the model's own by default), load (optional target load
 * factor; the 1 g load for the flight path and bank by default) }. Returns null when the model kind
 * has no handler or the state cannot be trimmed (no airspeed).
 */
export function trimModel(model, request) {
  const handler = model ? handlers.get(model.kind) : null;
  if (!handler) return null;
  return handler.trim(model, request);
}

/**
 * The load factor a neutral stick holds for a flight path and bank: 1 g along the path, corrected for
 * bank up to NEUTRAL_BANK (steeper turns need back stick, as in a fly-by-wire normal law). Shared by
 * the trim and the fixed-wing assists so a trimmed state is exactly what hands-off flight holds.
 */
export const NEUTRAL_BANK = 33 * DEG;
export function neutralLoad(flightPath, bank) {
  return Math.cos(flightPath) / Math.cos(Math.min(Math.abs(bank), NEUTRAL_BANK));
}

// ============================================================================================
// FIXED-WING
// ============================================================================================
const FIXED_WING = Object.freeze({
  /** Same margin below the critical angle of attack as the auto-trim hold. */
  STALL_MARGIN: 4 * DEG,
  MIN_AOA: -8 * DEG,
  /** Safe speed range after a conversion: this multiple of the 1 g stall speed up to this share of Vne. */
  MIN_SPEED_FACTOR: 1.25,
  MAX_SPEED_FACTOR: 0.9,
  /** Hands-off loads the trim may target (the assists' comfort band). */
  MIN_LOAD: 0.85,
  MAX_LOAD: 1.2,
  ITERATIONS: 8,
  AOA_STEP: 0.25 * DEG,
  ELEVATOR_STEP: 0.03,
  LOAD_TOLERANCE: 0.004,
  PITCH_TOLERANCE: 0.004,
  MAX_TURN_RATE: 0.6,
  DT: 1 / 120,
});

function createFixedWingTrim() {
  const pathForward = new THREE.Vector3();
  const pathRight = new THREE.Vector3();
  const pathUp = new THREE.Vector3();
  const back = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const pathQuaternion = new THREE.Quaternion();
  const attitude = new THREE.Quaternion();
  const rollQuaternion = new THREE.Quaternion();
  const pitchQuaternion = new THREE.Quaternion();
  const inverse = new THREE.Quaternion();
  const airVelocity = new THREE.Vector3();
  const bodyRates = new THREE.Vector3();
  const velocityBefore = new THREE.Vector3();
  const rateBefore = new THREE.Vector3();
  const bodyUp = new THREE.Vector3();
  const acceleration = new THREE.Vector3();
  const BODY_X = new THREE.Vector3(1, 0, 0);
  const BODY_Z = new THREE.Vector3(0, 0, 1);
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const controls = createControlState();
  const probeEnv = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: () => -Infinity, waterLevel: -Infinity, rho: 1.225 };

  /** Attitude for an angle of attack: the air path, rolled to the bank, pitched up by aoa about the wing. */
  function attitudeFor(aoa, bank, target) {
    rollQuaternion.setFromAxisAngle(BODY_Z, -bank);
    pitchQuaternion.setFromAxisAngle(BODY_X, aoa);
    return target.copy(pathQuaternion).multiply(rollQuaternion).multiply(pitchQuaternion);
  }

  /** Builds the path frame (forward along the air velocity, right level); false when there is no airspeed. */
  function buildPathFrame(model, speed) {
    pathForward.copy(airVelocity).divideScalar(speed);
    pathRight.crossVectors(pathForward, WORLD_UP);
    if (pathRight.lengthSq() < 1e-6) pathRight.set(1, 0, 0).applyQuaternion(model.state.quaternion).setY(0);
    if (pathRight.lengthSq() < 1e-6) return false;
    pathRight.normalize();
    pathUp.crossVectors(pathRight, pathForward).normalize();
    back.copy(pathForward).negate();
    basis.makeBasis(pathRight, pathUp, back);
    pathQuaternion.setFromRotationMatrix(basis);
    return true;
  }

  return {
    trim(model, request = {}) {
      const env = request.env || {};
      const wind = env.wind && env.wind.vel ? env.wind.vel : null;
      airVelocity.copy(model.state.velocity);
      if (wind) airVelocity.sub(wind);
      const speed = airVelocity.length();
      if (!(speed > 1) || typeof model.snapshot !== 'function') return null;
      if (!buildPathFrame(model, speed)) return null;
      const data = model.flightData || {};
      const flightPath = Math.asin(clamp(pathForward.y, -1, 1));
      const bank = clamp(Number.isFinite(request.bank) ? request.bank : Number.isFinite(data.bank) ? data.bank : 0, -Math.PI / 2, Math.PI / 2);
      const targetLoad = Number.isFinite(request.load) ? request.load : clamp(neutralLoad(flightPath, bank), FIXED_WING.MIN_LOAD, FIXED_WING.MAX_LOAD);
      const dt = Number.isFinite(request.dt) && request.dt > 0 ? request.dt : FIXED_WING.DT;
      const trimRange = model.profile && model.profile.controls && Number.isFinite(model.profile.controls.trimRange) ? model.profile.controls.trimRange : 0;
      const pilotTrim = clamp(Number.isFinite(request.trim) ? request.trim : 0, -1, 1);

      // Probe environment: the tick's air (density, wind) without turbulence, and the real ground.
      probeEnv.time = Number.isFinite(env.time) ? env.time : 0;
      if (wind) probeEnv.wind.vel.copy(wind);
      else probeEnv.wind.vel.set(0, 0, 0);
      probeEnv.wind.turbulence = 0;
      probeEnv.rho = Number.isFinite(env.rho) ? env.rho : 1.225;
      probeEnv.groundHeight = typeof env.groundHeight === 'function' ? env.groundHeight : () => -Infinity;
      probeEnv.waterLevel = Number.isFinite(env.waterLevel) ? env.waterLevel : -Infinity;
      controls.throttle = clamp(Number.isFinite(request.throttle) ? request.throttle : 0, 0, 1);
      controls.trim = pilotTrim;
      controls.roll = 0;
      controls.yaw = 0;
      controls.actions.clear();
      controls.held.clear();

      // Steady-turn rates for the bank (world yaw rate from the horizontal share of the lift).
      const turnRate = clamp((targetLoad * GRAVITY * Math.sin(bank)) / (speed * Math.max(Math.cos(flightPath), 0.2)), -FIXED_WING.MAX_TURN_RATE, FIXED_WING.MAX_TURN_RATE);
      const base = model.snapshot();
      const probe = { load: 0, pitchAcceleration: 0, aoaCritical: data.aoaCritical, stallSpeed: 0 };

      function applyCandidate(snapshot, aoa, elevator) {
        attitudeFor(aoa, bank, attitude);
        inverse.copy(attitude).invert();
        bodyRates.set(0, -turnRate, 0).applyQuaternion(inverse);
        snapshot.quaternion = [attitude.x, attitude.y, attitude.z, attitude.w];
        snapshot.angularVelocity = [bodyRates.x, bodyRates.y, bodyRates.z];
        snapshot.surfaces = [0, clamp(elevator + pilotTrim * trimRange, -1, 1), 0];
        // The load sensor starts at the target, so after the last probe it reads about the trimmed load.
        if ('load' in snapshot) snapshot.load = targetLoad;
      }

      /** One tick from the candidate: load factor and pitch acceleration, then back to the base state. */
      function measure(aoa, elevator) {
        const snapshot = { ...base, surfaces: [...base.surfaces] };
        applyCandidate(snapshot, aoa, elevator);
        model.restore(snapshot);
        velocityBefore.copy(model.state.velocity);
        rateBefore.copy(model.state.angularVelocity);
        bodyUp.set(0, 1, 0).applyQuaternion(model.state.quaternion);
        controls.pitch = elevator;
        model.step(dt, controls, probeEnv);
        acceleration.copy(model.state.velocity).sub(velocityBefore).divideScalar(dt);
        acceleration.y += GRAVITY;
        probe.load = acceleration.dot(bodyUp) / GRAVITY;
        probe.pitchAcceleration = (model.state.angularVelocity.x - rateBefore.x) / dt;
        if (Number.isFinite(model.flightData.aoaCritical)) probe.aoaCritical = model.flightData.aoaCritical;
        if (Number.isFinite(model.flightData.stallSpeed)) probe.stallSpeed = model.flightData.stallSpeed;
        return probe;
      }

      let aoa = clamp(Number.isFinite(data.aoa) ? data.aoa : 2 * DEG, 0, 6 * DEG);
      let elevator = clamp(Number.isFinite(data.pitchCommand) ? data.pitchCommand : 0, -1, 1);
      let aoaLimited = false;
      for (let iteration = 0; iteration < FIXED_WING.ITERATIONS; iteration++) {
        const maxAoa = probe.aoaCritical - FIXED_WING.STALL_MARGIN;
        const { load, pitchAcceleration } = measure(aoa, elevator);
        const loadError = load - targetLoad;
        if (Math.abs(loadError) < FIXED_WING.LOAD_TOLERANCE && Math.abs(pitchAcceleration) < FIXED_WING.PITCH_TOLERANCE) break;
        const byAoa = measure(aoa + FIXED_WING.AOA_STEP, elevator);
        const loadPerAoa = (byAoa.load - load) / FIXED_WING.AOA_STEP;
        const pitchPerAoa = (byAoa.pitchAcceleration - pitchAcceleration) / FIXED_WING.AOA_STEP;
        const byElevator = measure(aoa, elevator + FIXED_WING.ELEVATOR_STEP);
        const loadPerElevator = (byElevator.load - load) / FIXED_WING.ELEVATOR_STEP;
        const pitchPerElevator = (byElevator.pitchAcceleration - pitchAcceleration) / FIXED_WING.ELEVATOR_STEP;
        const determinant = loadPerAoa * pitchPerElevator - loadPerElevator * pitchPerAoa;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) break;
        const aoaStep = (-loadError * pitchPerElevator + loadPerElevator * pitchAcceleration) / determinant;
        const elevatorStep = (-pitchAcceleration * loadPerAoa + pitchPerAoa * loadError) / determinant;
        const nextAoa = aoa + clamp(aoaStep, -4 * DEG, 4 * DEG);
        aoaLimited = nextAoa > maxAoa;
        aoa = clamp(nextAoa, FIXED_WING.MIN_AOA, maxAoa);
        elevator = clamp(elevator + clamp(elevatorStep, -0.4, 0.4), -1, 1);
        if (aoaLimited && Math.abs(pitchPerElevator) > 1e-6) {
          // At the angle-of-attack limit only the pitching balance is solved (the load is what it is).
          const atLimit = measure(aoa, elevator);
          elevator = clamp(elevator - atLimit.pitchAcceleration / pitchPerElevator, -1, 1);
        }
      }

      // The trimmed state, with the load sensor reading the trimmed load. The final probe also leaves
      // the model's flight data (read by the control stages before the next tick) at the trimmed values.
      const final = measure(aoa, elevator);
      const trimmed = { ...base, surfaces: [...base.surfaces] };
      applyCandidate(trimmed, aoa, elevator);
      if ('load' in trimmed) trimmed.load = final.load;
      model.restore(trimmed);
      const stallSpeed = final.stallSpeed;
      const vne = Number.isFinite(data.vne) ? data.vne : Infinity;
      return {
        aoa,
        elevator,
        load: final.load,
        targetLoad,
        flightPath,
        bank,
        speed,
        stallSpeed,
        vne,
        safeSpeed: { min: stallSpeed * FIXED_WING.MIN_SPEED_FACTOR, max: Math.max(vne * FIXED_WING.MAX_SPEED_FACTOR, stallSpeed * FIXED_WING.MIN_SPEED_FACTOR) },
        aoaLimited,
      };
    },
  };
}

registerTrimHandler('fixedWing', createFixedWingTrim());
