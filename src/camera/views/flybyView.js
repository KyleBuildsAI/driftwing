// Flyby cam: a fixed camera placed ahead along the flight path and a little to one side, which
// tracks the craft as it passes. It relocates (a clean cut, alternating sides) once the craft has
// passed and pulled away, when the terrain hides the craft for a moment, after a long wait, or after
// a teleport. Placement uses the shared height function, so the camera is never inside terrain or
// water, and a candidate is only used when it can see the craft now and at the pass point.
import * as THREE from 'three/webgpu';
import { CONFIG } from '../../core/config.js';

const DEG = Math.PI / 180;
const LOOK_LIMITS = Object.freeze({ yawRange: 18, maxYaw: 18, up: 12, down: 12 });
const FLYBY = Object.freeze({
  LEAD_SECONDS: 3.4,
  MIN_LEAD: 70,
  MAX_LEAD: 650,
  MIN_SIDE: 10,
  MAX_SIDE: 55,
  SIDE_SHARE: 0.12,
  CLEARANCE: 4,
  WATER_CLEARANCE: 2.5,
  RECEDE_FACTOR: 1.35,
  RECEDE_MIN: 90,
  MAX_RANGE: 1400,
  OCCLUDED_SECONDS: 0.35,
  MAX_WAIT_SECONDS: 16,
  TELEPORT_DISTANCE: 400,
  SIGHT_SAMPLES: 14,
  SIGHT_MARGIN: 1.5,
  CHECK_INTERVAL: 0.1,
});

export function createFlybyView(ctx) {
  const { world } = ctx;
  const camera = new THREE.Vector3();
  const lastCraft = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const side = new THREE.Vector3();
  const passPoint = new THREE.Vector3();
  const candidate = new THREE.Vector3();
  const lookMatrix = new THREE.Matrix4();
  const offsetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const offsetQuaternion = new THREE.Quaternion();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const state = {
    placed: false,
    sideSign: 1,
    placementDistance: 0,
    closest: Infinity,
    passed: false,
    occludedSeconds: 0,
    waitSeconds: 0,
    checkTimer: 0,
    placements: 0,
  };

  /** The camera's floor: clear of the ground and of the water (the ocean or a local body). */
  function floorAt(x, z) {
    const water = ctx.waterQuery ? ctx.waterQuery.heightAt(x, z) : CONFIG.WATER_LEVEL;
    return Math.max(world.groundHeight(x, z) + FLYBY.CLEARANCE, water + FLYBY.WATER_CLEARANCE);
  }

  /** True when the straight line from `from` to `to` stays above the terrain (with a small margin). */
  function hasLineOfSight(from, to) {
    for (let index = 1; index < FLYBY.SIGHT_SAMPLES; index++) {
      const t = index / FLYBY.SIGHT_SAMPLES;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const z = from.z + (to.z - from.z) * t;
      if (y < world.groundHeight(x, z) + FLYBY.SIGHT_MARGIN) return false;
    }
    return true;
  }

  /** Places the camera ahead of the craft at `position` flying along `velocity`. */
  function place(position, velocity, heading) {
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed > 3) direction.copy(velocity).divideScalar(speed);
    else direction.set(Math.sin(heading * DEG), 0, -Math.cos(heading * DEG));
    const lead = Math.min(FLYBY.MAX_LEAD, Math.max(FLYBY.MIN_LEAD, speed * FLYBY.LEAD_SECONDS));
    passPoint.copy(position).addScaledVector(direction, lead);
    side.crossVectors(direction, worldUp);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const sideDistance = Math.min(FLYBY.MAX_SIDE, Math.max(FLYBY.MIN_SIDE, speed * FLYBY.SIDE_SHARE));
    // Candidates: this side, the other side, then higher and closer versions of both.
    const attempts = [
      [state.sideSign, 1, 2],
      [-state.sideSign, 1, 2],
      [state.sideSign, 1, 14],
      [-state.sideSign, 1, 14],
      [state.sideSign, 0.6, 30],
      [-state.sideSign, 0.6, 30],
    ];
    for (const [sign, sideScale, rise] of attempts) {
      candidate.copy(passPoint).addScaledVector(side, sign * sideDistance * sideScale);
      candidate.y = Math.max(passPoint.y + rise * (0.5 + Math.random()), floorAt(candidate.x, candidate.z));
      if (hasLineOfSight(candidate, position) && hasLineOfSight(candidate, passPoint)) {
        commit(candidate, position, lead, sign);
        return;
      }
    }
    // Nothing clear: hover above the pass point, higher than any terrain on the way to the craft.
    let ridge = floorAt(passPoint.x, passPoint.z);
    for (let index = 1; index < FLYBY.SIGHT_SAMPLES; index++) {
      const t = index / FLYBY.SIGHT_SAMPLES;
      ridge = Math.max(ridge, floorAt(passPoint.x + (position.x - passPoint.x) * t, passPoint.z + (position.z - passPoint.z) * t));
    }
    candidate.copy(passPoint).addScaledVector(side, state.sideSign * sideDistance);
    candidate.y = Math.max(ridge + 20, passPoint.y + 20, floorAt(candidate.x, candidate.z));
    commit(candidate, position, lead, state.sideSign);
  }

  function commit(point, position, lead, sign) {
    camera.copy(point);
    state.placed = true;
    state.sideSign = -sign;
    state.placementDistance = Math.max(lead, camera.distanceTo(position));
    state.closest = Infinity;
    state.passed = false;
    state.occludedSeconds = 0;
    state.waitSeconds = 0;
    state.checkTimer = 0;
    state.placements++;
  }

  /** True when the current placement has done its job and a new one is due. */
  function needsRelocation(position, dt) {
    const distance = camera.distanceTo(position);
    state.closest = Math.min(state.closest, distance);
    if (distance > state.closest + 5) state.passed = true;
    state.waitSeconds += dt;
    state.checkTimer -= dt;
    if (state.checkTimer <= 0) {
      state.checkTimer = FLYBY.CHECK_INTERVAL;
      state.occludedSeconds = hasLineOfSight(camera, position) ? 0 : state.occludedSeconds + FLYBY.CHECK_INTERVAL;
    }
    if (state.occludedSeconds >= FLYBY.OCCLUDED_SECONDS) return true;
    if (distance > FLYBY.MAX_RANGE) return true;
    if (state.passed && distance > Math.max(FLYBY.RECEDE_MIN, state.placementDistance * 0.5, state.closest * FLYBY.RECEDE_FACTOR)) return true;
    return state.waitSeconds > FLYBY.MAX_WAIT_SECONDS;
  }

  return {
    id: 'flyby',
    lookLimits: LOOK_LIMITS,
    near: CONFIG.CAMERA.NEAR,

    isAvailable() {
      return true;
    },

    /** Forces a fresh placement on the next update (view entered, teleport, snap). */
    reset() {
      state.placed = false;
    },

    get placements() {
      return state.placements;
    },

    get cameraPosition() {
      return camera;
    },

    update(root, rig, look, out, mesh, dt, player) {
      const position = root.position;
      if (state.placed && position.distanceTo(lastCraft) > FLYBY.TELEPORT_DISTANCE) state.placed = false;
      lastCraft.copy(position);
      if (!state.placed || needsRelocation(position, dt)) place(position, player.velocity, player.heading);
      lookMatrix.lookAt(camera, position, worldUp);
      out.position.copy(camera);
      out.quaternion.setFromRotationMatrix(lookMatrix);
      offsetEuler.set(look.pitch * DEG, -look.yaw * DEG, 0, 'YXZ');
      offsetQuaternion.setFromEuler(offsetEuler);
      out.quaternion.multiply(offsetQuaternion);
      return true;
    },
  };
}
