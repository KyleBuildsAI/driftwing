// Parking brake: a powered craft started or placed on the ground (start on ground, a craft switch
// while landed) with the pilot's throttle lever above idle would roll (or lift) the moment it
// appears, and a physical HOTAS lever cannot be moved by software. The flight controller engages
// this brake instead: the wheels are held (both toe brakes) and the engine stays at idle (throttle,
// collective and thrust at zero) until the pilot moves the throttle lever noticeably, presses the
// toe brakes or the airbrake, or engages the autopilot. The brake reads the pilot's live
// ControlState and shapes the tick's copy before the control stages run.

/** Lever positions at or below this count as idle: no brake needed. */
export const PARKING_IDLE_THROTTLE = 0.05;
/** Lever travel (0..1) from where it was when the brake set that counts as moving it. */
export const PARKING_RELEASE_TRAVEL = 0.08;
/** Toe brake deflection that counts as pressing the brakes. */
const PARKING_RELEASE_BRAKE = 0.5;

export function createParkingBrake() {
  const brake = { engaged: false, throttle: 0 };

  return {
    get engaged() {
      return brake.engaged;
    },

    /**
     * Sets the brake when the lever (the pilot's live throttle, 0..1) is above idle; returns true
     * when it set. The lever position is remembered so only a real move releases it.
     */
    engage(lever) {
      const position = Number.isFinite(lever) ? lever : 0;
      if (position <= PARKING_IDLE_THROTTLE) {
        brake.engaged = false;
        return false;
      }
      brake.engaged = true;
      brake.throttle = position;
      return true;
    },

    release() {
      const was = brake.engaged;
      brake.engaged = false;
      return was;
    },

    /**
     * The reason the pilot's live controls release the brake ('throttle' | 'brakes' | 'airbrake'),
     * or null while it holds. autopilot: true when the autopilot is flying.
     */
    releaseReason(pilot, autopilot = false) {
      if (!brake.engaged) return null;
      const throttle = Number.isFinite(pilot.throttle) ? pilot.throttle : brake.throttle;
      if (Math.abs(throttle - brake.throttle) > PARKING_RELEASE_TRAVEL) return 'throttle';
      if ((Number.isFinite(pilot.brakeL) && pilot.brakeL > PARKING_RELEASE_BRAKE) || (Number.isFinite(pilot.brakeR) && pilot.brakeR > PARKING_RELEASE_BRAKE)) return 'brakes';
      if (pilot.held && pilot.held.has('airbrake')) return 'airbrake';
      if (autopilot) return 'autopilot';
      return null;
    },

    /** While set: engine at idle and the wheels held, on the tick's controls. */
    hold(controls) {
      if (!brake.engaged) return;
      controls.throttle = 0;
      controls.collective = 0;
      controls.afterburner = false;
      controls.brakeL = 1;
      controls.brakeR = 1;
    },
  };
}
