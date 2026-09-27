// Keyboard and mouse: v1's keyboard flying, pointer-lock virtual stick with a recentring spring,
// drag-to-steer fallback, wheel throttle and photo-mode routing, now driven by the keyboard and
// mouse binding profiles.
//
// CLASSIC keeps v1 exactly: the default keyboard layer is v1's keys, keyboard axes ease in and out
// at v1's rates, the mouse stick springs back to centre and a double-tap on the roll keys fires a
// barrel roll. SIM reuses the same code with the SIM keyboard layer; its mouse stick is a virtual
// cursor that stays where it is put (no spring) so its offset from the screen centre is the stick
// deflection. Right-drag is free look in both modes (releasing returns the view to centre).
//
// Actions are pressed on keydown / mousedown (so UI actions run in the same event as v1's hotkeys)
// and released on keyup / mouseup through the action router.

import { clamp } from '../core/util.js';
import { AXIS_TARGETS } from './defaultBindings.js';
import { shapeResponse } from './touch.js';

/** Keys v1 always tracked for flying and for the photo-mode free camera. */
const LEGACY_KEYS = Object.freeze([
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
/** Right-drag free look: pixels (as a fraction of the shorter screen side) for full deflection. */
const LOOK_FULL_FRACTION = 0.35;
const MOUSE_BUTTON_NAMES = Object.freeze(['left', 'middle', 'right', 'back', 'forward']);

/**
 * ctx: the game context. bindings: binding store. router: action router. canPress(actionId,
 * source): the input manager's gate (photo-mode subset, listening, calibration). capture: the
 * bind-by-listening session (offerKey / offerMouseButton). getMode(): 'classic' | 'sim'.
 * getCraft(): active craft id.
 */
export function createKeyboardMouse(ctx, { bindings, router, canPress, capture, getMode, getCraft }) {
  const { renderer, state, settings, bus, input } = ctx;
  const canvas = renderer.domElement;

  const heldKeys = new Set();
  const lastTapTime = new Map();
  /** Keyboard spring axes after v1's ease in / out, by target. */
  const keyboardAxes = { pitch: 0, roll: 0, yaw: 0, lookX: 0, lookY: 0, brakeL: 0, brakeR: 0 };
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
  const look = { active: false, pointerId: null, x: 0, y: 0 };
  const photoLook = { x: 0, y: 0, zoom: 0 };
  /** Code -> action ids its keydown pressed (released on keyup). */
  const keyActions = new Map();
  /** Mouse button -> action ids its mousedown pressed. */
  const mouseActions = new Map();
  let pendingWheelNotches = 0;
  let lastWheelTime = -Infinity;
  let lockRetryAfter = 0;
  let lockEverEngaged = false;
  let lockNoticeShown = false;
  let index = null;

  const frame = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    stickPitch: 0,
    stickRoll: 0,
    lookX: 0,
    lookY: 0,
    brakeL: 0,
    brakeR: 0,
    throttleDelta: 0,
    rates: {},
    wheelNotches: 0,
    fineControl: false,
    active: { pitch: false, roll: false, yaw: false, look: false, mouse: false },
  };

  // ---- Binding index ------------------------------------------------------------------------
  /**
   * Keyboard bindings indexed for the current craft: actions by key code, axis references by
   * target, and the set of codes the keyboard layer tracks. Rebuilt when bindings change.
   */
  function currentIndex() {
    const craft = getCraft();
    if (index && index.version === bindings.version && index.craft === craft) return index;
    const effective = bindings.getEffective('keyboard', craft);
    const actionsByCode = new Map();
    for (const [actionId, refs] of effective.actions) {
      for (const ref of refs) {
        if (ref.type !== 'key') continue;
        if (!actionsByCode.has(ref.code)) actionsByCode.set(ref.code, []);
        actionsByCode.get(ref.code).push({ actionId, ref });
      }
    }
    const axisRefs = effective.axes.map(([target, refs]) => [target, refs.filter((ref) => ref.type === 'keys')]);
    const tracked = new Set([...LEGACY_KEYS, ...actionsByCode.keys()]);
    for (const [, refs] of axisRefs) for (const ref of refs) tracked.add(ref.positive).add(ref.negative);
    index = { version: bindings.version, craft, actionsByCode, axisRefs, tracked };
    return index;
  }

  /**
   * Action ids a key press triggers in a mode. A Shift reference wins while Shift is held;
   * references without a Shift preference answer both.
   */
  function actionsForKey(code, shiftHeld, mode) {
    const entries = (currentIndex().actionsByCode.get(code) ?? []).filter((entry) => !entry.ref.mode || entry.ref.mode === mode);
    if (shiftHeld) {
      const exact = entries.filter((entry) => entry.ref.shift === true);
      const chosen = exact.length > 0 ? exact : entries.filter((entry) => entry.ref.shift === undefined);
      return chosen.map((entry) => entry.actionId);
    }
    return entries.filter((entry) => entry.ref.shift !== true).map((entry) => entry.actionId);
  }

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

  function clampStickToDisc() {
    const length = Math.hypot(stick.x, stick.y);
    if (length > 1) {
      stick.x /= length;
      stick.y /= length;
    }
  }

  function releaseKeyActions(code) {
    const pressed = keyActions.get(code);
    if (!pressed) return;
    keyActions.delete(code);
    for (const actionId of pressed) router.release(actionId, `key:${code}`);
  }

  function releaseMouseActions(button) {
    const pressed = mouseActions.get(button);
    if (!pressed) return;
    mouseActions.delete(button);
    for (const actionId of pressed) router.release(actionId, `mouse:${button}`);
  }

  function clearHeldState() {
    for (const code of [...keyActions.keys()]) releaseKeyActions(code);
    for (const button of [...mouseActions.keys()]) releaseMouseActions(button);
    heldKeys.clear();
    for (const target of Object.keys(keyboardAxes)) keyboardAxes[target] = 0;
    endDrag();
    endLook();
  }

  // ---- Keyboard ------------------------------------------------------------------------
  function onKeyDown(event) {
    markActivity();
    if (event.isComposing || isTypingTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const code = event.code;
    const shiftHeld = event.shiftKey || isShiftHeld();
    if (capture.active && !event.repeat && capture.offerKey(code, shiftHeld)) {
      event.preventDefault();
      return;
    }
    const mode = getMode();
    const actionIds = actionsForKey(code, shiftHeld, mode);
    if (!currentIndex().tracked.has(code) && actionIds.length === 0) return;
    if ((code === 'Space' || code === 'Enter' || code === 'NumpadEnter') && isActivatableTarget(event.target)) return;
    event.preventDefault();
    heldKeys.add(code);
    if (event.repeat) return;
    const pressed = [];
    for (const actionId of actionIds) {
      if (!canPress(actionId, 'keyboard')) continue;
      router.press(actionId, `key:${code}`, 'keyboard', 'keyboard');
      pressed.push(actionId);
    }
    if (pressed.length > 0) keyActions.set(code, pressed);
    if (!state.photoMode && mode === 'classic') detectDoubleTap(code, event.timeStamp);
  }

  function onKeyUp(event) {
    releaseKeyActions(event.code);
    if (!heldKeys.has(event.code)) return;
    heldKeys.delete(event.code);
    if (!isTypingTarget(event.target)) event.preventDefault();
  }

  /** v1's double-tap barrel roll on the roll keys (the references flagged doubleTapRoll). */
  function detectDoubleTap(code, timeStamp) {
    let direction = 0;
    for (const [target, refs] of currentIndex().axisRefs) {
      if (target !== 'roll') continue;
      for (const ref of refs) {
        if (!ref.doubleTapRoll) continue;
        if (ref.positive === code) direction = 1;
        else if (ref.negative === code) direction = -1;
      }
    }
    if (direction === 0) return;
    const previous = lastTapTime.get(code) ?? -Infinity;
    lastTapTime.set(code, timeStamp);
    if (timeStamp - previous > DOUBLE_TAP_MS) return;
    lastTapTime.set(code, -Infinity);
    ctx.systems.flight?.barrelRoll?.(direction);
  }

  /** True when a keydown would trigger an input action (the UI then leaves the key alone). */
  function consumesKey(event) {
    if (capture.active) return true;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    return actionsForKey(event.code, event.shiftKey || isShiftHeld(), getMode()).length > 0;
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
    endLook();
    markActivity();
  }

  function onPointerDown(event) {
    markActivity();
    if (event.button !== 0) {
      onOtherButtonDown(event);
      return;
    }
    if (drag.active || isPointerLocked()) return;
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

  /** Middle / right / side buttons: bound actions, and right-drag free look. */
  function onOtherButtonDown(event) {
    const button = event.button;
    if (button < 0 || button >= MOUSE_BUTTON_NAMES.length) return;
    if (capture.active && capture.offerMouseButton(button)) return;
    if (button === 2 && !state.photoMode && !look.active) {
      look.active = true;
      look.pointerId = event.pointerId;
      look.x = 0;
      look.y = 0;
    }
    if (mouseActions.has(button)) return;
    const pressed = [];
    const mode = getMode();
    for (const [actionId, refs] of bindings.getEffective('mouse', getCraft()).actions) {
      if (!refs.some((ref) => ref.type === 'mouseButton' && ref.button === button && (!ref.mode || ref.mode === mode))) continue;
      if (!canPress(actionId, 'mouse')) continue;
      router.press(actionId, `mouse:${button}`, 'mouse', 'mouse');
      pressed.push(actionId);
    }
    if (pressed.length > 0) mouseActions.set(button, pressed);
  }

  function endLook() {
    look.active = false;
    look.pointerId = null;
    look.x = 0;
    look.y = 0;
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
    if (look.active && (event.buttons & 2) === 0) endLook();
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
      if (look.active) {
        look.x += moveX;
        look.y += moveY;
        return;
      }
      const scale = clamp(settings.get('mouseSensitivity'), 0.2, 3) / STICK_FULL_PIXELS;
      stick.x += moveX * scale;
      stick.y += moveY * scale;
      stick.restSeconds = 0;
      clampStickToDisc();
      return;
    }
    if (look.active && event.pointerId === look.pointerId) {
      markActivity();
      look.x += event.movementX || 0;
      look.y += event.movementY || 0;
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
    if (event.button > 0) {
      if (event.button === 2) endLook();
      releaseMouseActions(event.button);
      return;
    }
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    const wasClick = drag.travel < CLICK_MAX_TRAVEL && event.timeStamp - drag.startTime < CLICK_MAX_MS;
    const wasMouse = drag.pointerType === 'mouse';
    endDrag();
    if (wasClick && wasMouse && !state.photoMode && !isPointerLocked()) requestLock();
  }

  function onPointerCancel(event) {
    endLook();
    for (const button of [...mouseActions.keys()]) releaseMouseActions(button);
    onPointerUp(event);
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
    if (getMode() === 'sim') {
      pendingWheelNotches += notches;
      return;
    }
    const now = performance.now();
    const chained = input.throttleTarget !== null && now - lastWheelTime < WHEEL_CHAIN_MS;
    const base = chained ? input.throttleTarget : state.player.throttle;
    lastWheelTime = now;
    input.throttleTarget = clamp(base - notches * WHEEL_THROTTLE_STEP, 0, 1);
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
  document.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockFailed);
  bus.on('photo:changed', () => {
    photoLook.x = 0;
    photoLook.y = 0;
    photoLook.zoom = 0;
    stick.x = 0;
    stick.y = 0;
    endDrag();
    endLook();
  });

  /**
   * Reads the keyboard and mouse for this frame. Returns the frame contributions (keyboard axes
   * after the ease, the mouse stick after v1's response curve, free look, rate axes, the CLASSIC
   * throttle direction and wheel notches for SIM).
   */
  function update(seconds, mode) {
    const photoMode = state.photoMode;
    const invert = settings.get('invertPitch') ? -1 : 1;
    const { axisRefs } = currentIndex();
    const springTargets = { pitch: 0, roll: 0, yaw: 0, lookX: 0, lookY: 0, brakeL: 0, brakeR: 0 };
    frame.rates = {};
    frame.throttleDelta = 0;
    for (const [target, refs] of axisRefs) {
      for (const ref of refs) {
        if (ref.mode && ref.mode !== mode) continue;
        const direction = keyAxis(ref.positive, ref.negative);
        if (ref.rate) {
          frame.rates[target] = (frame.rates[target] ?? 0) + direction * ref.rate;
          if (target === 'throttle') frame.throttleDelta += direction;
        } else if (target in springTargets) {
          springTargets[target] += direction;
        }
      }
    }
    for (const target of Object.keys(springTargets)) {
      let wanted = photoMode ? 0 : clamp(springTargets[target], AXIS_TARGETS[target].range === 'unipolar' ? 0 : -1, 1);
      if (target === 'pitch') wanted *= invert;
      keyboardAxes[target] = rampAxis(keyboardAxes[target], wanted, seconds);
    }
    frame.throttleDelta = photoMode ? 0 : clamp(frame.throttleDelta, -1, 1);
    if (photoMode) frame.rates = {};

    const freeStick = mode === 'sim' && isPointerLocked();
    if (drag.active && !photoMode && !isPointerLocked()) updateDragStick();
    else if (!freeStick) relaxStick(seconds);
    frame.stickRoll = photoMode ? 0 : shapeResponse(stick.x);
    frame.stickPitch = photoMode ? 0 : -shapeResponse(stick.y) * invert;

    const lookScale = Math.max(40, Math.min(window.innerWidth, window.innerHeight) * LOOK_FULL_FRACTION);
    frame.lookX = look.active && !photoMode ? clamp(look.x / lookScale, -1, 1) : 0;
    frame.lookY = look.active && !photoMode ? clamp(-look.y / lookScale, -1, 1) : 0;

    frame.pitch = keyboardAxes.pitch;
    frame.roll = keyboardAxes.roll;
    frame.yaw = keyboardAxes.yaw;
    frame.lookX = clamp(frame.lookX + keyboardAxes.lookX, -1, 1);
    frame.lookY = clamp(frame.lookY + keyboardAxes.lookY, -1, 1);
    frame.brakeL = keyboardAxes.brakeL;
    frame.brakeR = keyboardAxes.brakeR;
    frame.wheelNotches = photoMode ? 0 : pendingWheelNotches;
    pendingWheelNotches = 0;
    frame.fineControl = !photoMode && isShiftHeld();
    frame.active.pitch = keyboardAxes.pitch !== 0;
    frame.active.roll = keyboardAxes.roll !== 0;
    frame.active.yaw = keyboardAxes.yaw !== 0;
    frame.active.mouse = frame.stickRoll !== 0 || frame.stickPitch !== 0;
    frame.active.look = look.active;
    input.mouseActive = isPointerLocked();
    if (heldKeys.size > 0 || drag.active || look.active) markActivity();
    return frame;
  }

  return {
    update,
    isPointerLocked,
    consumesKey,
    clearHeldState,

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

    /**
     * The mouse virtual stick, x right / y down in -1..1 (a disc). mode 'spring' (CLASSIC and the
     * drag fallback: returns to centre) or 'free' (SIM with the pointer locked: the stick stays
     * where it is put, so the UI can draw a virtual cursor at that offset from the screen centre).
     */
    getStick() {
      const locked = isPointerLocked();
      return { x: stick.x, y: stick.y, locked, dragging: drag.active, mode: getMode() === 'sim' && locked ? 'free' : 'spring' };
    },

    /** Centres the mouse virtual stick (SIM recenter). */
    centerStick() {
      stick.x = 0;
      stick.y = 0;
      stick.restSeconds = 0;
    },

    /** Codes currently held (for the controls panel's live keyboard view). */
    heldKeys() {
      return [...heldKeys];
    },
  };
}
