// The turbulence response every felt effect shares (camera shake, cockpit rattle): how strongly the
// player should feel the WindField's turbulence at the craft (state.flight.turbulence, the
// WindField sample at the craft each frame).
//
// Zero at zero, and still zero through the light chop the Phase 1 field reports in ordinary flight
// (0.07 in calm air aloft, about 0.18 on the golden-hour opening), so the opening and quiet flight
// are untouched. Above the dead zone it rises with the square: Phase 1's gusty low-level air and
// thermal edges (0.3-0.45) are a faint tremor, a wind spawn's core (0.8-1) the full effect. Faster
// flight hits the bumps harder.

/** Turbulence at or below this reads as calm (ordinary Phase 1 chop stays under it). */
export const TURBULENCE_DEAD_ZONE = 0.2;
/** Airspeed (m/s) at which the bumps are felt in full. */
const FULL_EFFECT_AIRSPEED = 45;

/** 0..1: how hard turbulence (0..1) at airspeed (m/s) is felt. */
export function turbulenceResponse(turbulence, airspeed = FULL_EFFECT_AIRSPEED) {
  if (!(turbulence > TURBULENCE_DEAD_ZONE)) return 0;
  const share = Math.min(1, (turbulence - TURBULENCE_DEAD_ZONE) / (1 - TURBULENCE_DEAD_ZONE));
  const speed = Number.isFinite(airspeed) ? Math.min(1, Math.max(0, airspeed) / FULL_EFFECT_AIRSPEED) : 1;
  return share * share * (0.55 + 0.45 * speed);
}
