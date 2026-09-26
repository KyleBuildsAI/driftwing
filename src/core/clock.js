// Fixed-step simulation clock: physics advances in exact 1/120 s ticks no matter the frame rate.
//
// advance(frameDt) adds real time to an accumulator and returns how many ticks to run this frame;
// alpha is the leftover fraction used to interpolate the rendered pose between the last two ticks.
// Frame time is clamped (0.1 s) so a stalled tab cannot trigger a spiral of catch-up ticks, and the
// tick count per frame is capped with the excess dropped, trading sim time for responsiveness.

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
export const MAX_FRAME_DT = 0.1;

export function createFixedStepClock({ hz = PHYSICS_HZ, maxFrameDt = MAX_FRAME_DT } = {}) {
  const stepSeconds = 1 / hz;
  const maxTicks = Math.ceil(maxFrameDt * hz);
  let accumulator = 0;
  let tick = 0;
  let droppedSeconds = 0;

  return {
    stepSeconds,
    get alpha() { return accumulator / stepSeconds; },
    get tick() { return tick; },
    /** Seconds of simulation skipped because frames arrived too late to catch up. */
    get droppedSeconds() { return droppedSeconds; },

    /** Adds one frame's time and returns the number of fixed ticks to simulate now. */
    advance(frameDt) {
      const clamped = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, maxFrameDt) : 0;
      accumulator += clamped;
      let ticks = Math.floor(accumulator / stepSeconds + 1e-9);
      if (ticks > maxTicks) {
        droppedSeconds += (ticks - maxTicks) * stepSeconds;
        ticks = maxTicks;
      }
      accumulator = Math.max(0, accumulator - ticks * stepSeconds);
      tick += ticks;
      return ticks;
    },

    /** Drops any partial tick, e.g. after a teleport or when the simulation was paused. */
    reset() {
      accumulator = 0;
    },
  };
}
