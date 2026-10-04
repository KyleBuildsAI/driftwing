// Turbulence shake: the camera's generic response to the air (core/turbulence.js), so every wind
// spawn (and Phase 1's gusty low-level air, faintly) is felt in the view.
//
// A small rotation of the final camera pose: pitch, yaw and roll from smooth multi-sine noise in the
// 2-9 Hz band, running faster with airspeed, scaled per view. The cockpit and the FPV camera shake
// most (the head rides the airframe), the wing mount a little less, the chase camera less again, and
// the flyby camera (standing on the ground) not at all. It eases in quickly and out slowly, stops
// while the game is paused and is off in photo mode.
//
// It never changes the flight: it rotates the rendered camera only, after the view has written its
// pose. restore(camera) at the start of the next camera update takes the rotation back off when no
// view rewrote the camera meanwhile, so the shake never accumulates. No allocations per frame.
import { turbulenceResponse } from '../core/turbulence.js';

const DEG = Math.PI / 180;
/** Degrees of pitch, yaw and roll at full response, per view. */
const VIEW_GAIN = Object.freeze({ cockpit: 1.35, fpv: 1.1, wing: 0.8, chase: 0.75, flyby: 0 });
const MAX_PITCH = 0.9;
const MAX_YAW = 0.55;
const MAX_ROLL = 1.2;
const RISE_RATE = 6;
const FALL_RATE = 2.5;

function wave(time, seed) {
  return 0.45 * Math.sin(time * 13.2 + seed) + 0.3 * Math.sin(time * 27.1 + seed * 1.7) + 0.25 * Math.sin(time * 51.7 + seed * 2.9);
}

export function createTurbulenceShake(THREE) {
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const rotation = new THREE.Quaternion();
  const inverse = new THREE.Quaternion();
  const shaken = new THREE.Quaternion();
  const numbers = new Float64Array(4);
  const AMOUNT = 0;
  const CLOCK = 1;
  const APPLIED = 2;
  const PEAK = 3;

  return {
    /** Takes last frame's shake back off when no view has rewritten the camera since. */
    restore(camera) {
      if (numbers[APPLIED] === 1 && camera.quaternion.equals(shaken)) camera.quaternion.multiply(inverse);
      numbers[APPLIED] = 0;
    },

    /**
     * Shakes camera for this frame: dt (simulated s, 0 while paused), realDt (s), turbulence (0..1 at
     * the craft), airspeed (m/s), view (the camera view id) and enabled (false in photo mode and
     * during camera transitions). Positional, so a frame passes no object.
     */
    apply(camera, dt, realDt, turbulence, airspeed, view, enabled) {
      const gain = VIEW_GAIN[view] ?? VIEW_GAIN.chase;
      const target = enabled && dt > 0 && gain > 0 ? turbulenceResponse(turbulence, airspeed) : 0;
      const step = Math.min(Math.max(realDt, 0), 0.1);
      const rate = target > numbers[AMOUNT] ? RISE_RATE : FALL_RATE;
      numbers[AMOUNT] += (target - numbers[AMOUNT]) * Math.min(1, rate * step);
      if (numbers[AMOUNT] < 1e-4 && target === 0) {
        numbers[AMOUNT] = 0;
        return;
      }
      if (!enabled || gain <= 0) return;
      const speed = Number.isFinite(airspeed) ? Math.min(1.5, Math.max(0, airspeed) / 60) : 0;
      numbers[CLOCK] = (numbers[CLOCK] + dt * (0.8 + 0.6 * speed)) % 3600;
      const time = numbers[CLOCK];
      const scale = numbers[AMOUNT] * gain * DEG;
      euler.set(wave(time, 1.3) * MAX_PITCH * scale, wave(time * 0.9, 4.1) * MAX_YAW * scale, wave(time * 1.1, 2.6) * MAX_ROLL * scale, 'YXZ');
      rotation.setFromEuler(euler);
      inverse.copy(rotation).invert();
      camera.quaternion.multiply(rotation);
      shaken.copy(camera.quaternion);
      numbers[APPLIED] = 1;
      if (numbers[AMOUNT] > numbers[PEAK]) numbers[PEAK] = numbers[AMOUNT];
    },

    /** { amount (0..1 now), peak (highest since the last reset) }. */
    describe() {
      return { amount: Math.round(numbers[AMOUNT] * 1000) / 1000, peak: Math.round(numbers[PEAK] * 1000) / 1000 };
    },

    resetPeak() {
      numbers[PEAK] = 0;
    },
  };
}
