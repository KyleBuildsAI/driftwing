import * as THREE from 'three/webgpu';
import { CONFIG } from '../core/config.js';
import { DEG, clamp, damp, isFiniteVector, isFiniteQuaternion } from '../core/util.js';

/**
 * CAMERA RIG: chase camera (critically damped lag, partial bank, look-ahead, FOV stretch,
 * low-frequency speed / boost / event shake, terrain-safe) and the photo-mode free camera
 * (WASD / QE move, mouse or touch look, wheel zoom, Shift fast) with a smooth return.
 * Narrow / portrait screens widen the lens and pull the chase back so the whole wingspan
 * fits, and shift the frame so the glider sits above the bottom UI band. Any non-finite
 * chase state re-seats the camera at once, so a bad frame never reaches the renderer.
 */
export function createCameraRig(ctx) {
  const { THREE: T, camera, state, world, bus, settings, input } = ctx;
  const player = state.player;
  const SPEED = CONFIG.SPEED;
  const CAMERA_CONFIG = CONFIG.CAMERA;

  const CHASE = Object.freeze({
    DISTANCE: 17.5,
    DISTANCE_RANGE: 9,
    HEIGHT: 4.2,
    HEIGHT_RANGE: 1.1,
    AHEAD: 16,
    AHEAD_RANGE: 12,
    AIM_LIFT: 1.1,
    BANK_SHARE: 0.6,
    VELOCITY_SHARE: 0.3,
    SPRING: 9,
    LOOK_LAMBDA: 6.5,
    UP_LAMBDA: 3.6,
    SHAPE_LAMBDA: 2,
    FOV_LAMBDA: 2.4,
    GROUND_CLEARANCE: 3,
    TELEPORT_DISTANCE: 150,
    ACCEL_PULLBACK: 0.12,
  });
  const PHOTO = Object.freeze({
    MOVE_SPEED: 14,
    FAST_MULTIPLIER: 4,
    MOVE_LAMBDA: 5,
    LOOK_RADIANS_PER_PIXEL: 0.0021,
    KEY_LOOK_RATE: 1.1,
    TOUCH_LOOK_RATE: 1.4,
    MIN_FOV: 20,
    MAX_FOV: 90,
    FOV_STEP: 3,
    MAX_RANGE: 900,
    GROUND_CLEARANCE: 1.5,
    RETURN_SECONDS: 0.9,
    ROLL_LAMBDA: 4,
  });
  // Portrait framing: at the base chase distance, keep at least HALF_WIDTH metres visible on
  // either side of the glider (15 m wingspan -> at most ~65 % of the screen width). Half of the
  // correction (in log terms) widens the lens, the other half pulls the camera back, so neither
  // the perspective nor the glider's size changes drastically. On tall screens a lens shift
  // (view offset, a fraction of the screen height) lifts the glider into the upper-middle third.
  const FRAMING = Object.freeze({
    HALF_WIDTH: 11.5,
    MAX_FOV: 90,
    LIFT: 0.15,
    LIFT_START_ASPECT: 1.05,
    LIFT_FULL_ASPECT: 0.55,
  });
  const WORLD_UP = new T.Vector3(0, 1, 0);

  // ---- Chase state --------------------------------------------------------------------
  const chase = {
    relative: new T.Vector3(),
    relativeVelocity: new T.Vector3(),
    look: new T.Vector3(0, 0, -1),
    up: new T.Vector3(0, 1, 0),
    distance: CHASE.DISTANCE,
    height: CHASE.HEIGHT,
    ahead: CHASE.AHEAD,
    fov: CAMERA_CONFIG.FOV_BASE,
    position: new T.Vector3(),
    quaternion: new T.Quaternion(),
    lastPlanePosition: new T.Vector3(),
    lastSpeed: player.speed,
    acceleration: 0,
  };
  const shapeTarget = { distance: CHASE.DISTANCE, height: CHASE.HEIGHT, ahead: CHASE.AHEAD };
  const targetLook = new T.Vector3(0, 0, -1);
  const targetUp = new T.Vector3(0, 1, 0);
  const desiredRelative = new T.Vector3();
  const planeForward = new T.Vector3();
  const planeUp = new T.Vector3();
  const velocityDirection = new T.Vector3();
  const aimPoint = new T.Vector3();
  const midpoint = new T.Vector3();
  const lookMatrix = new T.Matrix4();
  const shakeEuler = new T.Euler(0, 0, 0, 'YXZ');
  const shakeQuaternion = new T.Quaternion();
  let trauma = 0;
  let shakeClock = 0;

  // ---- Photo / transition state -----------------------------------------------------------
  let mode = 'chase';
  const free = {
    position: new T.Vector3(),
    velocity: new T.Vector3(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    fov: CAMERA_CONFIG.FOV_BASE,
    euler: new T.Euler(0, 0, 0, 'YXZ'),
    quaternion: new T.Quaternion(),
  };
  const photoControls = { moveX: 0, moveY: 0, moveZ: 0, lookYaw: 0, lookPitch: 0, fast: false, lookX: 0, lookY: 0, zoom: 0 };
  const moveForward = new T.Vector3();
  const moveRight = new T.Vector3();
  const desiredVelocity = new T.Vector3();
  const transition = { elapsed: 0, fromPosition: new T.Vector3(), fromQuaternion: new T.Quaternion(), fromFov: CAMERA_CONFIG.FOV_BASE, fromLift: 0 };
  const framing = { aspect: NaN, fovTanScale: 1, distanceScale: 1, lift: 0 };
  const projection = { fov: camera.fov, lift: 0, aspect: camera.aspect };

  function smooth01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function blendToward(vector, target, lambda, step) {
    vector.lerp(target, 1 - Math.exp(-lambda * step));
    const length = vector.length();
    if (length > 1e-6) vector.divideScalar(length);
    else vector.copy(target);
  }
  function groundFloor(x, z) {
    return Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  }
  function vectorSum(vector) {
    return vector.x + vector.y + vector.z;
  }

  // ---- Portrait / narrow-screen framing (recomputed only when the aspect changes) ---------------
  function updateFraming() {
    const aspect = camera.aspect;
    if (aspect === framing.aspect) return;
    framing.aspect = aspect;
    const validAspect = Number.isFinite(aspect) && aspect > 0;
    const baseTan = Math.tan((CAMERA_CONFIG.FOV_BASE * DEG) / 2);
    const requiredTan = FRAMING.HALF_WIDTH / CHASE.DISTANCE;
    const deficit = validAspect ? Math.max(1, requiredTan / (baseTan * aspect)) : 1;
    const maxTanScale = Math.tan((FRAMING.MAX_FOV * DEG) / 2) / baseTan;
    framing.fovTanScale = Math.min(Math.sqrt(deficit), maxTanScale);
    framing.distanceScale = deficit / framing.fovTanScale;
    const tallness = validAspect ? (FRAMING.LIFT_START_ASPECT - aspect) / (FRAMING.LIFT_START_ASPECT - FRAMING.LIFT_FULL_ASPECT) : 0;
    framing.lift = FRAMING.LIFT * smooth01(tallness);
  }

  /** Landscape vertical FOV -> the FOV used on this screen (wider on narrow screens). */
  function framedFov(fov) {
    if (framing.fovTanScale === 1) return fov;
    const widened = (2 * Math.atan(Math.tan((fov * DEG) / 2) * framing.fovTanScale)) / DEG;
    return Math.min(FRAMING.MAX_FOV, widened);
  }

  // ---- Chase camera -------------------------------------------------------------------------
  function speedFraction() {
    return clamp((player.speed - 30) / (SPEED.BOOST_MAX - 30), 0, 1);
  }

  /** Returns false (targets unchanged) when neither attitude source is usable. */
  function computeChaseTargets() {
    let attitude = ctx.systems.flight?.getBaseQuaternion?.() ?? player.quaternion;
    if (!isFiniteQuaternion(attitude)) attitude = player.quaternion;
    if (!isFiniteQuaternion(attitude)) return false;
    planeForward.set(0, 0, -1).applyQuaternion(attitude);
    planeUp.set(0, 1, 0).applyQuaternion(attitude);
    const velocityLength = player.velocity.length();
    if (velocityLength > 1 && Number.isFinite(velocityLength)) velocityDirection.copy(player.velocity).divideScalar(velocityLength);
    else velocityDirection.copy(planeForward);
    targetLook.copy(planeForward).multiplyScalar(1 - CHASE.VELOCITY_SHARE).addScaledVector(velocityDirection, CHASE.VELOCITY_SHARE).normalize();
    // Blend of the plane's up and world up: follows ~60% of the bank, continuous through
    // loops and rolls because the plane term always dominates.
    targetUp.copy(planeUp).multiplyScalar(CHASE.BANK_SHARE).addScaledVector(WORLD_UP, 1 - CHASE.BANK_SHARE);
    if (targetUp.lengthSq() < 1e-6) targetUp.copy(planeUp);
    targetUp.normalize();
    return true;
  }

  function desiredShape() {
    const fraction = speedFraction();
    const pullback = framing.distanceScale;
    shapeTarget.distance = (CHASE.DISTANCE + CHASE.DISTANCE_RANGE * fraction) * pullback + clamp(chase.acceleration * CHASE.ACCEL_PULLBACK, -1.5, 3.5);
    shapeTarget.height = (CHASE.HEIGHT + CHASE.HEIGHT_RANGE * fraction) * pullback;
    shapeTarget.ahead = CHASE.AHEAD + CHASE.AHEAD_RANGE * fraction;
    return shapeTarget;
  }

  function snap() {
    updateFraming();
    computeChaseTargets();
    chase.look.copy(targetLook);
    chase.up.copy(targetUp);
    chase.acceleration = 0;
    const shape = desiredShape();
    chase.distance = shape.distance;
    chase.height = shape.height;
    chase.ahead = shape.ahead;
    chase.relative.copy(chase.look).multiplyScalar(-chase.distance).addScaledVector(chase.up, chase.height);
    chase.relativeVelocity.set(0, 0, 0);
    chase.lastPlanePosition.copy(player.position);
    chase.lastSpeed = player.speed;
    chase.fov = targetFov();
    solveChasePose();
  }

  function targetFov() {
    const overCruise = smooth01((player.speed - SPEED.CRUISE) / (SPEED.MAX - SPEED.CRUISE));
    const range = CAMERA_CONFIG.FOV_MAX - CAMERA_CONFIG.FOV_BASE;
    const boostExtra = player.boost.active ? 0.35 * range : 0;
    return framedFov(Math.min(CAMERA_CONFIG.FOV_MAX, CAMERA_CONFIG.FOV_BASE + range * 0.85 * overCruise + boostExtra));
  }

  /** True when every chase integrator is finite (NaN / Infinity propagate through the sum). */
  function chaseStateIsFinite() {
    const sum = vectorSum(chase.relative) + vectorSum(chase.relativeVelocity) + vectorSum(chase.look) + vectorSum(chase.up)
      + vectorSum(chase.position) + vectorSum(chase.lastPlanePosition) + chase.quaternion.w + chase.quaternion.x
      + chase.distance + chase.height + chase.ahead + chase.fov + chase.acceleration + chase.lastSpeed;
    return Number.isFinite(sum);
  }

  function updateChase(dt) {
    const step = Math.min(Math.max(dt, 0), 0.05);
    updateFraming();
    // Written so that a NaN distance or any NaN chase state also re-seats the camera.
    const planeMoved = player.position.distanceTo(chase.lastPlanePosition);
    if (!(planeMoved <= CHASE.TELEPORT_DISTANCE) || !chaseStateIsFinite()) snap();
    chase.lastPlanePosition.copy(player.position);
    if (step <= 0) {
      solveChasePose();
      return;
    }
    const acceleration = (player.speed - chase.lastSpeed) / step;
    chase.lastSpeed = player.speed;
    chase.acceleration = damp(chase.acceleration, clamp(acceleration, -40, 40), 3, step);

    if (!computeChaseTargets()) {
      solveChasePose();
      return;
    }
    blendToward(chase.look, targetLook, CHASE.LOOK_LAMBDA, step);
    blendToward(chase.up, targetUp, CHASE.UP_LAMBDA, step);
    const shape = desiredShape();
    chase.distance = damp(chase.distance, shape.distance, CHASE.SHAPE_LAMBDA, step);
    chase.height = damp(chase.height, shape.height, CHASE.SHAPE_LAMBDA, step);
    chase.ahead = damp(chase.ahead, shape.ahead, CHASE.SHAPE_LAMBDA, step);

    // Critically damped spring on the plane-relative offset (no speed-dependent drift).
    desiredRelative.copy(chase.look).multiplyScalar(-chase.distance).addScaledVector(chase.up, chase.height);
    const omega = CHASE.SPRING;
    chase.relativeVelocity.x += (-2 * omega * chase.relativeVelocity.x - omega * omega * (chase.relative.x - desiredRelative.x)) * step;
    chase.relativeVelocity.y += (-2 * omega * chase.relativeVelocity.y - omega * omega * (chase.relative.y - desiredRelative.y)) * step;
    chase.relativeVelocity.z += (-2 * omega * chase.relativeVelocity.z - omega * omega * (chase.relative.z - desiredRelative.z)) * step;
    chase.relative.addScaledVector(chase.relativeVelocity, step);

    chase.fov = damp(chase.fov, targetFov(), CHASE.FOV_LAMBDA, step);
    updateShake(step);
    solveChasePose();
    if (!chaseStateIsFinite()) snap();
  }

  function keepAboveTerrain() {
    const position = chase.position;
    const floor = groundFloor(position.x, position.z) + CHASE.GROUND_CLEARANCE;
    let lift = Math.max(0, floor - position.y);
    midpoint.copy(position).add(player.position).multiplyScalar(0.5);
    const midFloor = groundFloor(midpoint.x, midpoint.z) + 1.5;
    if (midpoint.y + lift * 0.5 < midFloor) lift = Math.max(lift, (midFloor - midpoint.y) * 2);
    if (lift > 0) {
      position.y += lift;
      chase.relative.y += lift;
      if (chase.relativeVelocity.y < 0) chase.relativeVelocity.y = 0;
    }
  }

  function solveChasePose() {
    chase.position.copy(player.position).add(chase.relative);
    keepAboveTerrain();
    aimPoint.copy(player.position).addScaledVector(chase.look, chase.ahead).addScaledVector(chase.up, CHASE.AIM_LIFT);
    lookMatrix.lookAt(chase.position, aimPoint, chase.up);
    chase.quaternion.setFromRotationMatrix(lookMatrix);
    applyShake();
  }

  // ---- Shake: low-frequency ambient (max speed, boost, cloud) + event trauma ------------------
  function updateShake(step) {
    shakeClock += step;
    trauma = Math.max(0, trauma - 1.1 * step);
  }

  function smoothNoise(time, seed) {
    return Math.sin(time * 1.0 + seed) * 0.55 + Math.sin(time * 2.31 + seed * 1.7) * 0.3 + Math.sin(time * 4.7 + seed * 2.9) * 0.15;
  }

  function applyShake() {
    const overSpeed = smooth01((player.speed - SPEED.MAX * 0.85) / (SPEED.MAX * 0.15));
    const ambient = 0.3 * overSpeed + (player.boost.active ? 0.35 : 0) + 0.25 * clamp(player.inCloud ?? 0, 0, 1);
    const eventShake = trauma * trauma;
    if (ambient <= 0 && eventShake <= 0) return;
    const time = shakeClock;
    const slow = ambient;
    const fast = eventShake;
    const pitch = (smoothNoise(time * 1.6, 1.3) * slow * 0.5 + smoothNoise(time * 7.5, 4.1) * fast * 1.2) * DEG;
    const yaw = (smoothNoise(time * 1.3, 2.7) * slow * 0.6 + smoothNoise(time * 6.8, 5.3) * fast * 1.4) * DEG;
    const roll = (smoothNoise(time * 1.1, 0.4) * slow * 0.9 + smoothNoise(time * 5.9, 3.6) * fast * 2) * DEG;
    shakeEuler.set(pitch, yaw, roll, 'YXZ');
    shakeQuaternion.setFromEuler(shakeEuler);
    chase.quaternion.multiply(shakeQuaternion);
  }

  // ---- Photo mode free camera -------------------------------------------------------------------
  function enterPhotoModeFrom(position, quaternion, fov) {
    free.position.copy(position);
    free.velocity.set(0, 0, 0);
    free.euler.setFromQuaternion(quaternion, 'YXZ');
    free.yaw = free.euler.y;
    free.pitch = clamp(free.euler.x, -1.5, 1.5);
    free.roll = free.euler.z;
    free.fov = clamp(fov, PHOTO.MIN_FOV, PHOTO.MAX_FOV);
  }

  function enterPhotoMode() {
    if (isFiniteVector(camera.position) && isFiniteQuaternion(camera.quaternion)) enterPhotoModeFrom(camera.position, camera.quaternion, camera.fov);
    else enterPhotoModeFrom(chase.position, chase.quaternion, chase.fov);
    mode = 'photo';
  }

  function exitPhotoMode() {
    transition.fromPosition.copy(camera.position);
    transition.fromQuaternion.copy(camera.quaternion);
    transition.fromFov = camera.fov;
    transition.fromLift = projection.lift;
    transition.elapsed = 0;
    mode = 'returning';
  }

  function updateFreeCamera(realDt) {
    const step = Math.min(Math.max(realDt, 0), 0.05);
    const inputSystem = ctx.systems.input;
    const controls = inputSystem?.readPhotoControls ? inputSystem.readPhotoControls(photoControls) : photoControls;
    const sensitivity = clamp(settings.get('mouseSensitivity'), 0.2, 3);
    const invert = settings.get('invertPitch') ? -1 : 1;

    free.yaw -= controls.lookX * PHOTO.LOOK_RADIANS_PER_PIXEL * sensitivity;
    free.pitch -= controls.lookY * PHOTO.LOOK_RADIANS_PER_PIXEL * sensitivity * invert;
    free.yaw -= controls.lookYaw * PHOTO.KEY_LOOK_RATE * step;
    free.pitch += controls.lookPitch * PHOTO.KEY_LOOK_RATE * 0.8 * step * invert;
    const touch = input.touch;
    if (touch && touch.active) {
      free.yaw -= clamp(Number(touch.x) || 0, -1, 1) * PHOTO.TOUCH_LOOK_RATE * step;
      free.pitch += clamp(Number(touch.y) || 0, -1, 1) * PHOTO.TOUCH_LOOK_RATE * 0.75 * step * invert;
    }
    if (!Number.isFinite(free.yaw + free.pitch + free.roll + free.fov) || !isFiniteVector(free.position) || !isFiniteVector(free.velocity)) {
      enterPhotoModeFrom(chase.position, chase.quaternion, chase.fov);
    }
    free.pitch = clamp(free.pitch, -1.5, 1.5);
    free.roll = damp(free.roll, 0, PHOTO.ROLL_LAMBDA, step);
    if (controls.zoom !== 0) free.fov = clamp(free.fov + controls.zoom * PHOTO.FOV_STEP, PHOTO.MIN_FOV, PHOTO.MAX_FOV);

    free.euler.set(free.pitch, free.yaw, free.roll, 'YXZ');
    free.quaternion.setFromEuler(free.euler);
    moveForward.set(0, 0, -1).applyQuaternion(free.quaternion);
    moveRight.set(1, 0, 0).applyQuaternion(free.quaternion);
    const moveSpeed = PHOTO.MOVE_SPEED * (controls.fast ? PHOTO.FAST_MULTIPLIER : 1);
    desiredVelocity.set(0, 0, 0)
      .addScaledVector(moveForward, controls.moveZ)
      .addScaledVector(moveRight, controls.moveX)
      .addScaledVector(WORLD_UP, controls.moveY);
    if (desiredVelocity.lengthSq() > 1) desiredVelocity.normalize();
    desiredVelocity.multiplyScalar(moveSpeed);
    free.velocity.lerp(desiredVelocity, 1 - Math.exp(-PHOTO.MOVE_LAMBDA * step));
    free.position.addScaledVector(free.velocity, step);

    const offsetX = free.position.x - player.position.x;
    const offsetY = free.position.y - player.position.y;
    const offsetZ = free.position.z - player.position.z;
    const range = Math.hypot(offsetX, offsetY, offsetZ);
    if (range > PHOTO.MAX_RANGE) {
      const scale = PHOTO.MAX_RANGE / range;
      free.position.set(player.position.x + offsetX * scale, player.position.y + offsetY * scale, player.position.z + offsetZ * scale);
    }
    const floor = groundFloor(free.position.x, free.position.z) + PHOTO.GROUND_CLEARANCE;
    if (free.position.y < floor) {
      free.position.y = floor;
      if (free.velocity.y < 0) free.velocity.y = 0;
    }
    free.position.y = Math.min(free.position.y, CONFIG.MAX_ALTITUDE + 400);

    camera.position.copy(free.position);
    camera.quaternion.copy(free.quaternion);
    applyProjection(free.fov, 0);
  }

  function applyReturnTransition(realDt) {
    transition.elapsed += Math.min(Math.max(realDt, 0), 0.05);
    const blend = easeInOutCubic(clamp(transition.elapsed / PHOTO.RETURN_SECONDS, 0, 1));
    camera.position.lerpVectors(transition.fromPosition, chase.position, blend);
    camera.quaternion.slerpQuaternions(transition.fromQuaternion, chase.quaternion, blend);
    const fov = transition.fromFov + (chase.fov - transition.fromFov) * blend;
    applyProjection(fov, transition.fromLift + (framing.lift - transition.fromLift) * blend);
    if (blend >= 1) mode = 'chase';
  }

  /**
   * FOV plus the portrait lens shift. setViewOffset(aspect, 1, 0, lift, aspect, 1) keeps the
   * aspect and moves the frustum window down by lift x its height, so the picture moves up.
   * Core's resize handler only sets aspect + updateProjectionMatrix, which keeps the offset.
   */
  function applyProjection(fov, lift) {
    const aspect = camera.aspect;
    if (Math.abs(fov - projection.fov) < 0.01 && Math.abs(lift - projection.lift) < 0.0005 && aspect === projection.aspect) return;
    projection.fov = fov;
    projection.lift = lift;
    projection.aspect = aspect;
    camera.fov = fov;
    if (lift > 0.0005) camera.setViewOffset(aspect, 1, 0, lift, aspect, 1);
    else if (camera.view && camera.view.enabled) camera.clearViewOffset();
    else camera.updateProjectionMatrix();
  }

  function applyChase() {
    // A non-finite pose never reaches the renderer: keep the last good frame instead.
    if (!isFiniteVector(chase.position) || !isFiniteQuaternion(chase.quaternion)) return;
    camera.position.copy(chase.position);
    camera.quaternion.copy(chase.quaternion);
    applyProjection(chase.fov, framing.lift);
  }

  bus.on('boost', () => {
    trauma = Math.min(1, trauma + 0.45);
  });
  bus.on('stall', () => {
    trauma = Math.min(1, trauma + 0.25);
  });

  snap();
  applyChase();
  camera.updateMatrixWorld();

  return {
    update(dt, realDt) {
      ctx.systems.flight?.syncVisual?.();
      updateChase(dt);
      if (mode === 'photo') updateFreeCamera(realDt);
      else if (mode === 'returning') applyReturnTransition(realDt);
      else applyChase();
    },

    setPhotoMode(active) {
      if (active && mode !== 'photo') enterPhotoMode();
      else if (!active && mode === 'photo') exitPhotoMode();
    },

    shake(amount) {
      if (Number.isFinite(amount) && amount > 0) trauma = Math.min(1, trauma + amount);
    },

    /** Re-seat the chase camera immediately (teleports / resets). */
    snap() {
      snap();
      if (mode === 'chase') applyChase();
    },

    getMode() {
      return mode;
    },

    /**
     * Photo mode only: place the free camera at `position` looking at `target` (world
     * coordinates, plain {x, y, z}); optional `fov`. Used by scripted photo tooling.
     */
    setFreeCameraPose({ position, target, fov } = {}) {
      if (mode !== 'photo' || !position || !target) return false;
      const values = [position.x, position.y, position.z, target.x, target.y, target.z];
      if (!values.every(Number.isFinite)) return false;
      free.position.set(position.x, position.y, position.z);
      free.velocity.set(0, 0, 0);
      aimPoint.set(target.x, target.y, target.z);
      lookMatrix.lookAt(free.position, aimPoint, WORLD_UP);
      free.euler.setFromRotationMatrix(lookMatrix, 'YXZ');
      free.yaw = free.euler.y;
      free.pitch = clamp(free.euler.x, -1.5, 1.5);
      free.roll = 0;
      if (Number.isFinite(fov)) free.fov = clamp(fov, PHOTO.MIN_FOV, PHOTO.MAX_FOV);
      return true;
    },
  };
}
