// Touch input: the on-screen virtual stick and throttle slider (drawn and tracked by the UI) feed
// ControlState through the input system. The UI reports the stick deflection and the slider value
// here; merge() turns them into this frame's contribution: roll and pitch from the stick with v1's
// mild expo, and the throttle once per slider change.

import { clamp } from '../core/util.js';

/** Mild exponential response: fine near centre, full authority at the edge (v1). */
export function shapeResponse(value) {
  return value * (0.4 + 0.6 * Math.abs(value));
}

/**
 * markActivity(): wakes the HUD. Returns { merge(invert, photoMode), setStick(x, y), releaseStick(),
 * setThrottle(value), releaseThrottle(), readStick() }.
 */
export function createTouchInput({ markActivity }) {
  const stick = { active: false, x: 0, y: 0 };
  const contribution = { pitch: 0, roll: 0, throttle: null };
  let sliderValue = null;
  let previousThrottle = null;

  /**
   * This frame's touch contribution: { pitch, roll, throttle } where throttle is the new slider
   * value when it changed this frame (null otherwise).
   */
  function merge(invert, photoMode) {
    contribution.pitch = 0;
    contribution.roll = 0;
    contribution.throttle = null;
    if (stick.active && !photoMode) {
      contribution.roll = shapeResponse(stick.x);
      contribution.pitch = shapeResponse(stick.y) * invert;
      markActivity();
    }
    if (sliderValue !== null && sliderValue !== previousThrottle) {
      contribution.throttle = sliderValue;
      markActivity();
    }
    previousThrottle = sliderValue;
    return contribution;
  }

  return {
    merge,

    /** The stick is held at x right / y up, each -1..1 (after the UI's deadzone). */
    setStick(x, y) {
      stick.active = true;
      stick.x = clamp(Number.isFinite(x) ? x : 0, -1, 1);
      stick.y = clamp(Number.isFinite(y) ? y : 0, -1, 1);
      markActivity();
    },
    releaseStick() {
      stick.active = false;
      stick.x = 0;
      stick.y = 0;
    },

    /** The slider is held at value (0..1); the throttle follows it while it moves. */
    setThrottle(value) {
      if (!Number.isFinite(value)) return;
      sliderValue = clamp(value, 0, 1);
      markActivity();
    },
    releaseThrottle() {
      sliderValue = null;
    },

    /** The stick as the UI last reported it: { active, x, y } (photo mode looks around with it). */
    readStick() {
      return { active: stick.active, x: stick.x, y: stick.y };
    },
  };
}
