// Touch input: merges what the UI's on-screen joystick, throttle slider and boost button write into
// ctx.input.touch (v1 behaviour, unchanged).
//
// The joystick feeds pitch / roll with v1's mild expo; a slider change sets the throttle target
// once per change; the boost button presses the 'boost' action in CLASSIC and 'craftAbility' in
// SIM through the action router.

import { clamp } from '../core/util.js';

/** Mild exponential response: fine near centre, full authority at the edge (v1). */
export function shapeResponse(value) {
  return value * (0.4 + 0.6 * Math.abs(value));
}

/**
 * input: ctx.input (the UI writes input.touch); router: action router; markActivity(): wakes the
 * HUD. Returns { merge(invert, photoMode, mode), throttleChange }.
 */
export function createTouchInput({ input, router, markActivity }) {
  const contribution = { pitch: 0, roll: 0, throttle: null };
  let previousBoost = false;
  let previousThrottle = null;
  let boostAction = null;

  /**
   * Reads input.touch for this frame. Returns { pitch, roll, throttle } where throttle is the new
   * slider value when it changed this frame (null otherwise).
   */
  function merge(invert, photoMode, mode) {
    const touch = input.touch;
    contribution.pitch = 0;
    contribution.roll = 0;
    contribution.throttle = null;
    if (!touch) return contribution;
    if (touch.active && !photoMode) {
      contribution.roll = shapeResponse(clamp(Number(touch.x) || 0, -1, 1));
      contribution.pitch = shapeResponse(clamp(Number(touch.y) || 0, -1, 1)) * invert;
      markActivity();
    }
    const touchThrottle = Number.isFinite(touch.throttle) ? clamp(touch.throttle, 0, 1) : null;
    if (touchThrottle !== null && touchThrottle !== previousThrottle) {
      contribution.throttle = touchThrottle;
      markActivity();
    }
    previousThrottle = touchThrottle;
    const touchBoost = Boolean(touch.boost);
    if (touchBoost && !previousBoost && !photoMode) {
      boostAction = mode === 'sim' ? 'craftAbility' : 'boost';
      router.press(boostAction, 'touch:boost', 'touch', 'touch');
    } else if (!touchBoost && previousBoost && boostAction) {
      router.release(boostAction, 'touch:boost');
      boostAction = null;
    }
    previousBoost = touchBoost;
    return contribution;
  }

  return { merge };
}
