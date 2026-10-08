// Landing grades. A touchdown is graded from the sink rate (vertical speed along the ground normal)
// at the first gear contact after a real flight, and announced with the typed 'landed' event and a
// toast. The flight controller keeps state.flight.lastLanding / bestLanding from that event and the
// journal keeps the best landing per world.
//
// Grades (sink rate at touchdown, m/s; feet per minute in brackets):
//   butter   up to 0.5  (100 fpm)  the wheels kiss the ground
//   smooth   up to 1.2  (240 fpm)  a good, normal landing
//   firm     up to 2.2  (430 fpm)  you felt it, the gear did not mind
//   hard     above 2.2             up to the craft's crash sink rate (limits.crashSinkRate), past
//                                 which the controller soft-crashes instead of grading
import { LANDING_GRADES } from '../core/events.js';

export { LANDING_GRADES };

export const LANDING_THRESHOLDS = Object.freeze({ butter: 0.5, smooth: 1.2, firm: 2.2 });
/** Best first: lower rank is better. */
export const LANDING_RANK = Object.freeze({ butter: 0, smooth: 1, firm: 2, hard: 3 });
/** A touchdown is graded only after this long in the air and this high above the ground (hops and bounces are not landings). */
const FLIGHT_MIN_SECONDS = 4;
const FLIGHT_MIN_AGL = 6;
const DEFAULT_CRASH_SINK_RATE = 4;
const DEFAULT_BODY_STRIKE_SPEED = 5;

const TOASTS = Object.freeze({
  butter: { title: 'Butter landing!', kind: 'success' },
  smooth: { title: 'Smooth landing.', kind: 'success' },
  firm: { title: 'Firm landing.', kind: 'info' },
  hard: { title: 'Hard landing.', kind: 'warning' },
});

/**
 * Per event bus: the resolver naming what a landing touched ('structure' for a landable collider top;
 * src/flight/FlightController.js registers it), or none. Without one, or when it answers null, the
 * landed event carries no surface (read as 'ground').
 */
const surfaceResolvers = new WeakMap();

/** Registers resolver(position) -> 'structure' | 'perch' | 'water' | 'ground' | null for landings on bus. */
export function setLandingSurfaceResolver(bus, resolver) {
  surfaceResolvers.set(bus, resolver);
}

/** Grade for a touchdown sink rate (m/s, positive down). */
export function gradeLanding(sinkRate) {
  const sink = Math.max(0, Number.isFinite(sinkRate) ? sinkRate : Infinity);
  if (sink <= LANDING_THRESHOLDS.butter) return 'butter';
  if (sink <= LANDING_THRESHOLDS.smooth) return 'smooth';
  if (sink <= LANDING_THRESHOLDS.firm) return 'firm';
  return 'hard';
}

/** True when landing `candidate` beats `current` (better grade, then the lower sink rate). */
export function isBetterLanding(candidate, current) {
  if (!candidate || !(candidate.grade in LANDING_RANK)) return false;
  if (!current || !(current.grade in LANDING_RANK)) return true;
  if (LANDING_RANK[candidate.grade] !== LANDING_RANK[current.grade]) return LANDING_RANK[candidate.grade] < LANDING_RANK[current.grade];
  return candidate.sinkRate < current.sinkRate;
}

/**
 * Watches a model's contact report tick by tick and grades real landings. options: { bus, craftId,
 * limits (craft limits: crashSinkRate, bodyStrikeSpeed) }. observe(report, { dt, agl, position })
 * returns the landing record when this tick graded one, else null.
 */
export function createLandingMonitor({ bus, craftId, limits = {} }) {
  const crashSinkRate = Number.isFinite(limits.crashSinkRate) ? limits.crashSinkRate : DEFAULT_CRASH_SINK_RATE;
  const strikeLimit = Number.isFinite(limits.bodyStrikeSpeed) ? limits.bodyStrikeSpeed : DEFAULT_BODY_STRIKE_SPEED;
  let flightSeconds = 0;
  let peakAgl = 0;
  let airborne = false;
  let landings = 0;

  function announce(record) {
    landings++;
    const toast = TOASTS[record.grade];
    const payload = {
      grade: record.grade,
      craft: craftId,
      sinkRate: record.sinkRate,
      groundSpeed: record.groundSpeed,
      surface: record.surface,
      position: { x: record.position.x, y: record.position.y, z: record.position.z },
    };
    const resolver = surfaceResolvers.get(bus);
    const surface = resolver ? resolver(record.position) : null;
    if (typeof surface === 'string') payload.surface = surface;
    bus.emitTyped('landed', payload);
    const feetPerMinute = Math.round((record.sinkRate * 196.85) / 10) * 10;
    bus.emit('notify', { text: `${toast.title} ${record.sinkRate.toFixed(1)} m/s (${feetPerMinute} fpm) at touchdown.`, kind: toast.kind });
  }

  return {
    get landings() {
      return landings;
    },

    observe(report, { dt, agl, position }) {
      if (!report.onGround) {
        if (!airborne) {
          airborne = true;
          flightSeconds = 0;
          peakAgl = 0;
        }
        flightSeconds += dt;
        if (Number.isFinite(agl)) peakAgl = Math.max(peakAgl, agl);
        return null;
      }
      const touchdown = report.touchdown;
      const qualifies = airborne && touchdown && flightSeconds >= FLIGHT_MIN_SECONDS && peakAgl >= FLIGHT_MIN_AGL;
      if (report.gearContacts > 0 || report.contacts > 0) airborne = false;
      if (!qualifies) return null;
      // A crash is the controller's business (fade and respawn), not a graded landing.
      // A floating craft's touchdown on the water is graded like one on the ground.
      if (touchdown.sinkRate > crashSinkRate || (report.water && !report.floating)) return null;
      if (report.bodyStrike && report.bodyStrike.speed > strikeLimit) return null;
      const record = {
        grade: gradeLanding(touchdown.sinkRate),
        sinkRate: Math.round(touchdown.sinkRate * 100) / 100,
        groundSpeed: Math.round(touchdown.groundSpeed * 10) / 10,
        part: touchdown.part,
        surface: report.surface === 'water' ? 'water' : 'ground',
        position,
      };
      announce(record);
      return record;
    },

    /** After a teleport: on the ground (no pending flight) or airborne (a fresh flight starts). */
    reset(onGround) {
      airborne = !onGround;
      flightSeconds = 0;
      peakAgl = 0;
    },

    snapshot() {
      return { flightSeconds, peakAgl, airborne };
    },

    restore(data) {
      if (!data) return;
      if (Number.isFinite(data.flightSeconds)) flightSeconds = data.flightSeconds;
      if (Number.isFinite(data.peakAgl)) peakAgl = data.peakAgl;
      if (typeof data.airborne === 'boolean') airborne = data.airborne;
    },
  };
}
