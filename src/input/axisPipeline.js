// Per-axis processing for gamepad and HOTAS axes.
//
// raw (-1..1 from the Gamepad API)
//   -> normalize with the learned calibration (min / centre / max, or idle / full for one-sided
//      axes such as throttles and toe brakes)
//   -> invert -> centre deadzone -> edge saturation -> expo curve -> light low-pass smoothing
//
// Bipolar axes come out as -1..1 (0 at the calibrated centre), unipolar axes as 0..1 (0 at idle).
// Every step is a pure function so the controls panel can show the curve for any tuning.

import { clamp } from '../core/util.js';

/** Tuning applied when a binding does not say otherwise. */
export const DEFAULT_AXIS_TUNING = Object.freeze({
  invert: false,
  deadzone: 0.04,
  saturation: 0.02,
  expo: 0,
  smoothing: 0.25,
});

/** Longest smoothing time constant (seconds) at smoothing = 1; "light" filtering stays well below. */
const MAX_SMOOTHING_SECONDS = 0.1;

/** Raw end assumed idle for a one-sided axis before calibration, given the profile hint and rest value. */
export function defaultIdleRaw(axisProfile, restRaw) {
  if (axisProfile?.restIsIdle && Number.isFinite(restRaw)) return restRaw;
  if (Number.isFinite(axisProfile?.idleRaw)) return axisProfile.idleRaw;
  return -1;
}

/**
 * Maps a raw value onto -1..1 (bipolar) or 0..1 (unipolar) using the axis calibration.
 * calibration: { min, center, max } for bipolar, { idle, full } for unipolar; missing fields fall
 * back to the full raw range centred on 0 (bipolar) or to idleFallback -> the far end (unipolar).
 */
export function normalizeAxis(raw, range, calibration, idleFallback = -1) {
  if (!Number.isFinite(raw)) return 0;
  if (range === 'unipolar') {
    const idle = Number.isFinite(calibration?.idle) ? calibration.idle : idleFallback;
    const full = Number.isFinite(calibration?.full) ? calibration.full : (idle >= 0 ? -1 : 1);
    const span = full - idle;
    if (Math.abs(span) < 1e-3) return 0;
    return clamp((raw - idle) / span, 0, 1);
  }
  const center = Number.isFinite(calibration?.center) ? calibration.center : 0;
  const min = Number.isFinite(calibration?.min) ? calibration.min : -1;
  const max = Number.isFinite(calibration?.max) ? calibration.max : 1;
  if (raw >= center) {
    const span = max - center;
    return span > 1e-3 ? clamp((raw - center) / span, 0, 1) : 0;
  }
  const span = center - min;
  return span > 1e-3 ? clamp((raw - center) / span, -1, 0) : 0;
}

/**
 * Deadzone at the centre (bipolar) or the idle end (unipolar), and saturation at the far edge,
 * rescaled so the output still spans the full range without a jump.
 */
export function applyDeadzoneAndSaturation(value, range, deadzone, saturation) {
  const dead = clamp(Number(deadzone) || 0, 0, 0.5);
  const saturate = clamp(Number(saturation) || 0, 0, 0.3);
  const magnitude = Math.abs(value);
  if (magnitude <= dead) return 0;
  const shaped = clamp((magnitude - dead) / Math.max(1e-3, 1 - dead - saturate), 0, 1);
  return range === 'unipolar' ? shaped : Math.sign(value) * shaped;
}

/** Expo curve: 0 = linear, 1 = fully cubic. Fine control near centre, full authority at the edge. */
export function applyExpo(value, expo) {
  const amount = clamp(Number(expo) || 0, 0, 1);
  return value * (1 - amount) + value * value * value * amount;
}

/** Normalize and shape one raw axis value (everything except the time-based smoothing). */
export function shapeAxis(raw, range, calibration, tuning, idleFallback) {
  let value = normalizeAxis(raw, range, calibration, idleFallback);
  if (tuning?.invert) value = range === 'unipolar' ? 1 - value : -value;
  value = applyDeadzoneAndSaturation(value, range, tuning?.deadzone ?? DEFAULT_AXIS_TUNING.deadzone, tuning?.saturation ?? DEFAULT_AXIS_TUNING.saturation);
  return applyExpo(value, tuning?.expo ?? DEFAULT_AXIS_TUNING.expo);
}

/**
 * Light exponential low-pass. smoothing 0..1 maps to a 0..100 ms time constant; 0 passes the
 * value straight through. The first sample initialises the filter so nothing sweeps in from 0.
 */
export function createAxisFilter() {
  let value = 0;
  let primed = false;
  return {
    get value() { return value; },
    update(target, smoothing, seconds) {
      const tau = clamp(Number(smoothing) || 0, 0, 1) * MAX_SMOOTHING_SECONDS;
      if (!primed || tau <= 1e-4) {
        value = target;
        primed = true;
        return value;
      }
      value += (target - value) * (1 - Math.exp(-Math.max(seconds, 0) / tau));
      if (Math.abs(target - value) < 1e-4) value = target;
      return value;
    },
    reset() {
      value = 0;
      primed = false;
    },
  };
}

/**
 * Turns a continuous 0..1 lever (the HOTAS antenna) into detented notches with hysteresis, so
 * a lever resting on a boundary does not chatter between two settings. Returns a function
 * value -> notch position (0..1 in steps of 1 / (notches - 1)); craft input profiles use it for
 * flaps. hysteresis is in notch widths (0..0.45).
 */
export function createNotchQuantizer({ notches, hysteresis = 0.3 }) {
  const count = Math.max(2, Math.round(notches));
  const band = clamp(hysteresis, 0, 0.45);
  let index = 0;
  let primed = false;
  return (value) => {
    const scaled = clamp(Number(value) || 0, 0, 1) * (count - 1);
    if (!primed) {
      index = Math.round(scaled);
      primed = true;
    } else if (Math.abs(scaled - index) > 0.5 + band / 2) {
      index = clamp(Math.round(scaled), 0, count - 1);
    }
    return index / (count - 1);
  };
}
