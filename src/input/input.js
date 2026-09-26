import { clamp } from '../core/util.js';

/**
 * INPUT: keyboard, pointer-lock virtual stick with a recentring spring, drag-to-steer
 * fallback, wheel throttle, touch merge, double-tap barrel rolls and photo-mode routing.
 * Writes ctx.input every frame (pitch / roll / yaw in [-1, 1], throttleDelta, throttleTarget,
 * boost, fineControl, mouseActive, lastActivity; the UI writes ctx.input.touch). In photo mode the flight axes
 * stay neutral and keys / mouse / wheel feed the free camera through readPhotoControls().
 */
export function createInputSystem(ctx) {
  const { renderer, state, settings, bus, input } = ctx;
  const canvas = renderer.domElement;

  const FLIGHT_KEYS = new Set([
    'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Space', 'ShiftLeft', 'ShiftRight',
  ]);
  const DOUBLE_TAP_MS = 300;
  const KEY_RISE_RATE = 7;
  const KEY_FALL_RATE = 14;
  const STICK_FULL_PIXELS = 260;
  const STICK_RETURN_LAMBDA = 7;
  const STICK_MOVING_LAMBDA = 0.6;
  const STICK_REST_SECONDS = 0.06;
  const MAX_MOVEMENT_PER_EVENT = 220;
  const DRAG_RADIUS_FRACTION = 0.22;
  const DRAG_DEADZONE = 0.05;
  const CLICK_MAX_TRAVEL = 6;
  const CLICK_MAX_MS = 350;
  const WHEEL_THROTTLE_STEP = 0.05;
  const WHEEL_CHAIN_MS = 450;
  const LOCK_RETRY_MS = 1200;

  const heldKeys = new Set();
  const lastTapTime = { KeyA: -Infinity, KeyD: -Infinity };
  const keyboardAxes = { pitch: 0, roll: 0, yaw: 0 };
  const stick = { x: 0, y: 0, restSeconds: 0 };
  const drag = {
    active: false,
    pointerId: null,
    pointerType: 'mouse',
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startTime: 0,
    travel: 0,
    captureFailed: false,
  };
  const photoLook = { x: 0, y: 0, zoom: 0 };
  const touchContribution = { pitch: 0, roll: 0 };
  let pendingBoost = false;
  let previousTouchBoost = false;
  let previousTouchThrottle = null;
  let lastWheelTime = -Infinity;
  let lockRetryAfter = 0;
  let lockEverEngaged = false;
  let lockNoticeShown = false;

  // ---- Helpers ---------------------------------------------------------------------
  function markActivity() {
    input.lastActivity = performance.now();
  }

  function isTypingTarget(target) {
    if (!target || target === document.body || target === document.documentElement) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function isActivatableTarget(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName;
    return tag === 'BUTTON' || tag === 'A' || target.getAttribute?.('role') === 'button';
  }

  function isPointerLocked() {
    return document.pointerLockElement === canvas;
  }

  function keyAxis(positiveCode, negativeCode) {
    return (heldKeys.has(positiveCode) ? 1 : 0) - (heldKeys.has(negativeCode) ? 1 : 0);
  }

  function isShiftHeld() {
    return heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight');
  }

  /** Keyboard axes ease in and out so digital keys feel like a light stick. */
  function rampAxis(current, target, seconds) {
    const rising = Math.abs(target) > Math.abs(current) || Math.sign(target) !== Math.sign(current);
    const rate = (rising ? KEY_RISE_RATE : KEY_FALL_RATE) * seconds;
    if (Math.abs(target - current) <= rate) return target;
    return current + Math.sign(target - current) * rate;
  }

  /** Mild exponential response: fine near centre, full authority at the edge. */
  function shapeResponse(value) {
    return value * (0.4 + 0.6 * Math.abs(value));
  }

  function clampStickToDisc() {
    const length = Math.hypot(stick.x, stick.y);
    if (length > 1) {
      stick.x /= length;
      stick.y /= length;
    }
  }

  function clearHeldState() {
    heldKeys.clear();
    keyboardAxes.pitch = 0;
    keyboardAxes.roll = 0;
    keyboardAxes.yaw = 0;
    endDrag();
  }

  // ---- Keyboard ------------------------------------------------------------------------
  function onKeyDown(event) {
    markActivity();
    if (event.isComposing || isTypingTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const code = event.code;
    if (!FLIGHT_KEYS.has(code)) return;
    if (code === 'Space' && isActivatableTarget(event.target)) return;
    event.preventDefault();
    heldKeys.add(code);
    if (event.repeat || state.photoMode) return;
    if (code === 'Space') pendingBoost = true;
    else if (code === 'KeyA' || code === 'KeyD') detectDoubleTap(code, event.timeStamp);
  }

  function onKeyUp(event) {
    if (!heldKeys.has(event.code)) return;
    heldKeys.delete(event.code);
    if (!isTypingTarget(event.target)) event.preventDefault();
  }

  function detectDoubleTap(code, timeStamp) {
    const previous = lastTapTime[code];
    lastTapTime[code] = timeStamp;
    if (timeStamp - previous > DOUBLE_TAP_MS) return;
    lastTapTime[code] = -Infinity;
    ctx.systems.flight?.barrelRoll?.(code === 'KeyD' ? 1 : -1);
  }

  // ---- Pointer: lock, virtual stick and drag steering -------------------------------------
  function requestLock() {
    if (typeof canvas.requestPointerLock !== 'function') {
      showLockNotice();
      return;
    }
    if (performance.now() < lockRetryAfter) return;
    let request = null;
    try {
      request = canvas.requestPointerLock();
    } catch (error) {
      onLockFailed(error);
      return;
    }
    if (request && typeof request.then === 'function') request.catch(onLockFailed);
  }

  function onLockFailed() {
    lockRetryAfter = performance.now() + LOCK_RETRY_MS;
    if (!lockEverEngaged) showLockNotice();
  }

  function showLockNotice() {
    if (lockNoticeShown) return;
    lockNoticeShown = true;
    bus.emit('notify', { text: 'Mouse capture is unavailable here. Drag on the view to steer.', kind: 'info' });
  }

  function onLockChange() {
    const locked = isPointerLocked();
    if (locked) lockEverEngaged = true;
    input.mouseActive = locked;
    stick.x = 0;
    stick.y = 0;
    stick.restSeconds = 0;
    markActivity();
  }

  function onPointerDown(event) {
    markActivity();
    if (event.button !== 0 || drag.active || isPointerLocked()) return;
    drag.active = true;
    drag.pointerId = event.pointerId;
    drag.pointerType = event.pointerType || 'mouse';
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.startTime = event.timeStamp;
    drag.travel = 0;
    drag.captureFailed = false;
    capturePointer(event.pointerId);
  }

  function capturePointer(pointerId) {
    try {
      canvas.setPointerCapture(pointerId);
    } catch (error) {
      // The pointer can already be gone (released between event dispatch and capture);
      // dragging then simply follows document-level pointermove events.
      drag.captureFailed = true;
    }
  }

  function onPointerMove(event) {
    if (isPointerLocked()) {
      const moveX = clamp(event.movementX || 0, -MAX_MOVEMENT_PER_EVENT, MAX_MOVEMENT_PER_EVENT);
      const moveY = clamp(event.movementY || 0, -MAX_MOVEMENT_PER_EVENT, MAX_MOVEMENT_PER_EVENT);
      if (moveX === 0 && moveY === 0) return;
      markActivity();
      if (state.photoMode) {
        photoLook.x += moveX;
        photoLook.y += moveY;
        return;
      }
      const scale = clamp(settings.get('mouseSensitivity'), 0.2, 3) / STICK_FULL_PIXELS;
      stick.x += moveX * scale;
      stick.y += moveY * scale;
      stick.restSeconds = 0;
      clampStickToDisc();
      return;
    }
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    markActivity();
    const deltaX = event.clientX - drag.lastX;
    const deltaY = event.clientY - drag.lastY;
    drag.travel += Math.hypot(deltaX, deltaY);
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (state.photoMode) {
      photoLook.x += deltaX;
      photoLook.y += deltaY;
    }
  }

  function onPointerUp(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    const wasClick = drag.travel < CLICK_MAX_TRAVEL && event.timeStamp - drag.startTime < CLICK_MAX_MS;
    const wasMouse = drag.pointerType === 'mouse';
    endDrag();
    if (wasClick && wasMouse && !state.photoMode && !isPointerLocked()) requestLock();
  }

  function endDrag() {
    if (!drag.active) return;
    if (!drag.captureFailed && drag.pointerId !== null && canvas.hasPointerCapture?.(drag.pointerId)) {
      canvas.releasePointerCapture(drag.pointerId);
    }
    drag.active = false;
    drag.pointerId = null;
    drag.captureFailed = false;
    stick.restSeconds = STICK_REST_SECONDS;
  }

  function updateDragStick() {
    const radius = Math.max(40, Math.min(window.innerWidth, window.innerHeight) * DRAG_RADIUS_FRACTION);
    let x = (drag.lastX - drag.startX) / radius;
    let y = (drag.lastY - drag.startY) / radius;
    const length = Math.hypot(x, y);
    if (length < DRAG_DEADZONE) {
      x = 0;
      y = 0;
    } else {
      const rescaled = Math.min(1, (length - DRAG_DEADZONE) / (1 - DRAG_DEADZONE));
      x = (x / length) * rescaled;
      y = (y / length) * rescaled;
    }
    stick.x = x;
    stick.y = y;
    stick.restSeconds = 0;
  }

  function relaxStick(seconds) {
    stick.restSeconds += seconds;
    const lambda = stick.restSeconds > STICK_REST_SECONDS ? STICK_RETURN_LAMBDA : STICK_MOVING_LAMBDA;
    const decay = Math.exp(-lambda * seconds);
    stick.x *= decay;
    stick.y *= decay;
    if (Math.abs(stick.x) < 1e-4) stick.x = 0;
    if (Math.abs(stick.y) < 1e-4) stick.y = 0;
  }

  // ---- Wheel ------------------------------------------------------------------------------
  function wheelNotches(event) {
    const unit = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
    return clamp(event.deltaY / unit, -3, 3);
  }

  function onWheel(event) {
    markActivity();
    const notches = wheelNotches(event);
    if (notches === 0) return;
    if (state.photoMode) {
      photoLook.zoom += notches;
      return;
    }
    const now = performance.now();
    const chained = input.throttleTarget !== null && now - lastWheelTime < WHEEL_CHAIN_MS;
    const base = chained ? input.throttleTarget : state.player.throttle;
    lastWheelTime = now;
    input.throttleTarget = clamp(base - notches * WHEEL_THROTTLE_STEP, 0, 1);
  }

  // ---- Touch merge (UI joystick / slider / boost button write ctx.input.touch) -------------
  function mergeTouch(invert) {
    const touch = input.touch;
    const result = touchContribution;
    result.pitch = 0;
    result.roll = 0;
    if (!touch) return result;
    if (touch.active && !state.photoMode) {
      result.roll = shapeResponse(clamp(Number(touch.x) || 0, -1, 1));
      result.pitch = shapeResponse(clamp(Number(touch.y) || 0, -1, 1)) * invert;
      markActivity();
    }
    const touchThrottle = Number.isFinite(touch.throttle) ? clamp(touch.throttle, 0, 1) : null;
    if (touchThrottle !== null && touchThrottle !== previousTouchThrottle) {
      input.throttleTarget = touchThrottle;
      markActivity();
    }
    previousTouchThrottle = touchThrottle;
    const touchBoost = Boolean(touch.boost);
    if (touchBoost && !previousTouchBoost && !state.photoMode) pendingBoost = true;
    previousTouchBoost = touchBoost;
    return result;
  }

  // ---- Listeners ----------------------------------------------------------------------------
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearHeldState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearHeldState();
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockFailed);
  bus.on('photo:changed', () => {
    photoLook.x = 0;
    photoLook.y = 0;
    photoLook.zoom = 0;
    stick.x = 0;
    stick.y = 0;
    pendingBoost = false;
    endDrag();
  });

  return {
    update(dt, realDt) {
      const seconds = Math.min(Math.max(realDt, 0), 0.05);
      const photoMode = state.photoMode;
      const invert = settings.get('invertPitch') ? -1 : 1;

      const keyPitch = photoMode ? 0 : keyAxis('ArrowUp', 'ArrowDown') * invert;
      const keyRoll = photoMode ? 0 : clamp(keyAxis('KeyD', 'KeyA') + keyAxis('ArrowRight', 'ArrowLeft'), -1, 1);
      const keyYaw = photoMode ? 0 : keyAxis('KeyE', 'KeyQ');
      keyboardAxes.pitch = rampAxis(keyboardAxes.pitch, keyPitch, seconds);
      keyboardAxes.roll = rampAxis(keyboardAxes.roll, keyRoll, seconds);
      keyboardAxes.yaw = rampAxis(keyboardAxes.yaw, keyYaw, seconds);

      if (drag.active && !photoMode && !isPointerLocked()) updateDragStick();
      else relaxStick(seconds);
      const stickRoll = photoMode ? 0 : shapeResponse(stick.x);
      const stickPitch = photoMode ? 0 : -shapeResponse(stick.y) * invert;

      const touch = mergeTouch(invert);

      input.pitch = clamp(keyboardAxes.pitch + stickPitch + touch.pitch, -1, 1);
      input.roll = clamp(keyboardAxes.roll + stickRoll + touch.roll, -1, 1);
      input.yaw = clamp(keyboardAxes.yaw, -1, 1);
      input.throttleDelta = photoMode ? 0 : keyAxis('KeyW', 'KeyS');
      if (input.throttleDelta !== 0) input.throttleTarget = null;
      input.boost = pendingBoost && !photoMode;
      pendingBoost = false;
      input.fineControl = !photoMode && isShiftHeld();
      input.mouseActive = isPointerLocked();
      if (heldKeys.size > 0 || drag.active) markActivity();
    },

    isPointerLocked,

    /**
     * Free-camera controls for photo mode. Movement axes are live key states; look and
     * zoom are accumulated mouse / wheel deltas since the previous call (consumed).
     */
    readPhotoControls(out) {
      out.moveX = keyAxis('KeyD', 'KeyA');
      out.moveY = keyAxis('KeyE', 'KeyQ');
      out.moveZ = keyAxis('KeyW', 'KeyS');
      out.lookYaw = keyAxis('ArrowRight', 'ArrowLeft');
      out.lookPitch = keyAxis('ArrowUp', 'ArrowDown');
      out.fast = isShiftHeld();
      out.lookX = photoLook.x;
      out.lookY = photoLook.y;
      out.zoom = photoLook.zoom;
      photoLook.x = 0;
      photoLook.y = 0;
      photoLook.zoom = 0;
      return out;
    },

    /** Current virtual-stick deflection (for UI visualisation), x right / y down in -1..1. */
    getStick() {
      return { x: stick.x, y: stick.y, locked: isPointerLocked(), dragging: drag.active };
    },
  };
}
