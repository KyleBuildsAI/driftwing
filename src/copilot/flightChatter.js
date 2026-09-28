import { bearingTo, compassName } from '../core/util.js';
import { craftCapabilities } from './flightState.js';
import { formatSinkRate } from './grammar.js';

/**
 * WREN's v2 chatter: short, rare lines about landings, soft crashes and craft changes, and a lift
 * hint for gliders (the nearest working thermal, or ridge lift we are already in). All of
 * it goes through the v1 chatter gate (offerChatter), so settings.copilotChatter, photo mode and the
 * v1 pacing (one unsolicited line per 30 s, quiet 10 s after any line) still hold. Lines that only
 * make sense right away carry a short time-to-live and are dropped if the gate stays closed.
 */

const LANDING_TTL = 12;
const CRASH_TTL = 8;
const CHANGE_TTL = 8;
const LIFT_TTL = 15;
/** At most one crash reassurance per this many seconds (no nagging after several in a row). */
const CRASH_LINE_GAP = 90;
/** Lift hints: checked every LIFT_CHECK seconds, spoken at most once per LIFT_HINT_GAP. */
const LIFT_CHECK = 2;
const LIFT_HINT_GAP = 180;
/** Sinking for this long (vario below LIFT_SINK_VARIO) before a thermal hint makes sense. */
const LIFT_SINK_SECONDS = 12;
const LIFT_SINK_VARIO = -0.4;
const THERMAL_MIN_STRENGTH = 1.2;
const THERMAL_MAX_DISTANCE = 3200;
/** Ridge lift: rising air at the craft this strong for this long, low over the ground, with no thermal near. */
const RIDGE_MIN_RISE = 0.8;
const RIDGE_SECONDS = 6;
const RIDGE_MAX_AGL = 450;
/** A craft change the copilot made itself is not narrated a second time. */
const OWN_CHANGE_WINDOW = 3;

export function createFlightChatter(ctx, { offerChatter, pick }) {
  const { bus, state, settings } = ctx;
  const ownChanges = { craft: -Infinity };
  const lift = { timer: 0, sinkSeconds: 0, riseSeconds: 0, lastHintAt: -Infinity };
  let landingCount = 0;
  let lastCrashLineAt = -Infinity;

  const now = () => state.time.realElapsed;
  const craftName = (id) => {
    const entry = ctx.craftRegistry?.catalog?.find((candidate) => candidate.id === id);
    return entry ? entry.name.toLowerCase() : id;
  };

  function noteCopilotChange(kind) {
    ownChanges[kind] = now();
  }

  function recentlyChangedByCopilot(kind) {
    return now() - ownChanges[kind] < OWN_CHANGE_WINDOW;
  }

  // ---- Landings --------------------------------------------------------------------------------------
  // The flight controller's 'landed' listener runs first (it is created before the copilot), so
  // state.flight.bestLanding already includes this landing when ours runs.
  let bestBefore = null;
  bus.onTyped('landed', (landing) => {
    if (!landing) return;
    landingCount++;
    const best = state.flight.bestLanding;
    const newBest = Boolean(bestBefore) && best && best.grade === landing.grade && best.sinkRate === landing.sinkRate;
    bestBefore = best ? { grade: best.grade, sinkRate: best.sinkRate } : bestBefore;
    const units = settings.get('units');
    const sink = formatSinkRate(landing.sinkRate, units);
    let line = '';
    if (newBest) {
      line = pick('landingBest', [`${landing.grade === 'butter' ? 'Butter' : 'Lovely'}, and your best landing yet: ${sink}.`, `New personal best: ${sink} at touchdown.`]);
    } else if (landing.grade === 'butter') {
      line = pick('landingButter', [`Butter. ${sink}. I barely felt it.`, `Now that's a landing. ${sink}.`]);
    } else if (landing.grade === 'hard') {
      line = pick('landingHard', ['Bit of a thump, but the gear is fine. A longer flare next time.', 'Firm arrival. Everything is still attached.']);
    } else if (landingCount === 1) {
      line = pick('landingFirst', [`First landing: ${landing.grade}, ${sink}.`, `We're down. ${landing.grade.charAt(0).toUpperCase()}${landing.grade.slice(1)}, ${sink}.`]);
    }
    if (line) offerChatter(line, 3, LANDING_TTL);
  });

  // ---- Soft crash ---------------------------------------------------------------------------------------
  bus.onTyped('softCrash', () => {
    if (now() - lastCrashLineAt < CRASH_LINE_GAP) return;
    lastCrashLineAt = now();
    offerChatter(pick('softCrash', [
      "No harm done. We're back in the air, nothing lost.",
      'Oops. No penalties up here; back at 300 metres, same heading.',
      "That one didn't count. Fresh start, same view.",
    ]), 4, CRASH_TTL);
  });

  // ---- Craft changes made elsewhere (picker, keys, HOTAS) ------------------------------------------------
  bus.onTyped('craftChanged', ({ craft }) => {
    lift.sinkSeconds = 0;
    lift.riseSeconds = 0;
    if (recentlyChangedByCopilot('craft')) return;
    offerChatter(pick('craftChatter', [`The ${craftName(craft)}. Let's see what she can do.`, `${craftName(craft).charAt(0).toUpperCase()}${craftName(craft).slice(1)} ready.`]), 2, CHANGE_TTL);
  });

  // ---- Lift hint for gliders ----------------------------------------------------------------------------
  function gliderFlying() {
    const flight = ctx.systems.flight;
    if (!flight || flight.isTowing?.()) return false;
    const module = flight.getCraftModule?.();
    return Boolean(module) && !craftCapabilities(module).engine && module.simProfile?.model === 'fixedWing';
  }

  function checkLift(dt) {
    lift.timer -= dt;
    const telemetry = state.flight;
    if (!gliderFlying() || telemetry.onGround || telemetry.crash?.active) {
      lift.sinkSeconds = 0;
      lift.riseSeconds = 0;
      return;
    }
    lift.sinkSeconds = telemetry.vario < LIFT_SINK_VARIO ? lift.sinkSeconds + dt : 0;
    const rising = telemetry.wind.y > RIDGE_MIN_RISE && telemetry.agl < RIDGE_MAX_AGL;
    lift.riseSeconds = rising ? lift.riseSeconds + dt : 0;
    if (lift.timer > 0) return;
    lift.timer = LIFT_CHECK;
    if (!settings.get('copilotChatter') || now() - lift.lastHintAt < LIFT_HINT_GAP) return;
    const position = telemetry.position;
    const thermal = typeof ctx.wind?.nearestThermal === 'function' ? ctx.wind.nearestThermal(position, THERMAL_MIN_STRENGTH) : null;
    const insideThermal = thermal && thermal.distance < thermal.radius * 1.2;
    if (lift.riseSeconds >= RIDGE_SECONDS && !insideThermal) {
      lift.lastHintAt = now();
      offerChatter(pick('ridgeLift', [
        "We're in ridge lift. Stay on the windward face and it will carry us.",
        'Feel that? The wind is climbing the slope. Fly along the ridge to keep it.',
      ]), 2, LIFT_TTL);
      return;
    }
    if (lift.sinkSeconds >= LIFT_SINK_SECONDS && thermal && !insideThermal && thermal.distance <= THERMAL_MAX_DISTANCE) {
      lift.lastHintAt = now();
      const bearing = bearingTo(position.x, position.z, thermal.capX ?? thermal.x, thermal.capZ ?? thermal.z);
      const distance = thermal.distance >= 950 ? `${(thermal.distance / 1000).toFixed(1)} km` : `${Math.round(thermal.distance / 50) * 50} metres`;
      offerChatter(pick('thermal', [
        `There's a thermal about ${distance} to the ${compassName(bearing)}, under that little cumulus. Worth a detour.`,
        `Lift ${distance} ${compassName(bearing)}: a good thermal under the small cloud. Circle tight in it.`,
      ]), 2, LIFT_TTL);
    }
  }

  return {
    noteCopilotChange,
    get landingCount() {
      return landingCount;
    },
    update(realDt) {
      if (!state.ready || state.paused) return;
      checkLift(realDt);
    },
    getStats() {
      return { landingCount, liftSinkSeconds: Math.round(lift.sinkSeconds * 10) / 10, liftRiseSeconds: Math.round(lift.riseSeconds * 10) / 10, lastLiftHintAt: Number.isFinite(lift.lastHintAt) ? lift.lastHintAt : null };
    },
  };
}
