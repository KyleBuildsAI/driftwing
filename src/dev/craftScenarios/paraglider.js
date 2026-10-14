// Paraglider scenarios for ?test=craft (Phase 3 contract h.8 and Milestone P item 3: the paraglider
// thermal climb): circling a midday thermal to climb with the variometer singing, big ears for a fast
// descent and back out, and a launch run from a slope until the wing is flying.
import { clamp, headingFromVector } from '../../core/util.js';

/** The WindField's lean of a thermal column with height: linear in the rise, capped (src/env/WindField.js). */
const LEAN_PER_METRE = 0.35 / 2.5;
const LEAN_LIMIT = 260;
/** The circle the scripted pilot flies around the core (m) and how far it searches for a thermal. */
const CIRCLE_RADIUS = 22;
const SEARCH_RADIUS = 900;
const RESEARCH_SECONDS = 5;
const WORKING = 2.5;
const LOOKAHEAD = 120;
/** Noon (sky day time); the craft test holds a scenario's time for the whole run. */
const NOON = 0.5;

function wrapSigned(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * The thermal to climb in: a thermal's core waxes and wanes over its 15-25 minute life cycle, so the
 * choice is the near one whose core stays strongest from now until LOOKAHEAD seconds on (the weaker of
 * the two readings), a working one (WORKING m/s) before any other.
 */
function findThermal(api) {
  const position = api.player.position;
  const now = api.state.time.elapsed;
  const later = new Map();
  api.wind.thermalsNear(position.x, position.z, SEARCH_RADIUS, (thermal) => later.set(thermal.id, thermal.strength), now + LOOKAHEAD);
  let best = null;
  api.wind.thermalsNear(position.x, position.z, SEARCH_RADIUS, (thermal) => {
    const strength = Math.min(thermal.strength, later.get(thermal.id) ?? 0);
    if (strength < 1) return;
    const distance = Math.hypot(thermal.x - position.x, thermal.z - position.z);
    const score = (strength >= WORKING ? 10 : 0) + strength - distance / 300;
    if (!best || score > best.score) best = { ...thermal, score };
  }, now);
  return best;
}

/** The thermal core's centre at the pilot's height: the base leaning toward the cap with the rise. */
function coreAt(thermal, height, out) {
  const lean = (rise) => Math.min(LEAN_LIMIT, Math.max(0, rise) * LEAN_PER_METRE);
  const share = lean(height - thermal.ground) / Math.max(1e-6, lean(thermal.top - thermal.ground));
  out.x = thermal.x + (thermal.capX - thermal.x) * clamp(share, 0, 1);
  out.z = thermal.z + (thermal.capZ - thermal.z) * clamp(share, 0, 1);
  return out;
}

/**
 * A scripted thermal pilot: flies to the core, then circles right around it on a CIRCLE_RADIUS circle
 * (the tangent heading, turning in when wide and out when tight) with weight shift and the inner
 * brake, re-reading the thermal every few seconds.
 */
function thermalPilot(t, api) {
  const memo = api.memo;
  if (!memo.thermal || t - memo.searchedAt > RESEARCH_SECONDS) {
    memo.thermal = findThermal(api) ?? memo.thermal ?? null;
    memo.searchedAt = t;
    memo.core = memo.core ?? { x: 0, z: 0 };
  }
  if (!memo.thermal) return { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  const position = api.player.position;
  const core = coreAt(memo.thermal, position.y, memo.core);
  const offsetX = position.x - core.x;
  const offsetZ = position.z - core.z;
  const distance = Math.hypot(offsetX, offsetZ);
  const heading = api.flight.heading;
  const circling = distance <= 120;
  const desired = circling ? headingFromVector(offsetX, offsetZ) + 90 + clamp(1.2 * (distance - CIRCLE_RADIUS), -70, 70) : headingFromVector(-offsetX, -offsetZ);
  const error = wrapSigned(desired - heading);
  // Gentle gains: the canopy's yaw lags the brakes, and a hard-driven turn oscillates and sinks.
  return {
    roll: clamp((circling ? 0.7 : 0) + error / 120, -1, 1),
    pitch: 0,
    yaw: 0,
    throttle: 0,
    brakeL: clamp(-error / 200, 0, 0.5),
    brakeR: clamp((circling ? 0.25 : 0) + error / 200, 0, 0.8),
  };
}

export default Object.freeze({
  craft: 'paraglider',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'paraglider-thermal-climb',
      views: ['third', 'first'],
      // Midday: the thermals are at full strength (the WindField's sun factor); the craft test holds the
      // sun there (the sky would warp through midday in about a minute). The start is low in the column,
      // where it is strong (a thermal tops out 600-1300 m above its ground).
      time: NOON,
      start: { at: 'thermal', mode: 'air', agl: 250 },
      seconds: 150,
      script: thermalPilot,
      checks: [
        {
          id: 'circling',
          label: 'circling the core (heading turns through 360 degrees)',
          until: 150,
          test(api) {
            const memo = api.memo;
            const heading = api.flight.heading;
            if (memo.lastHeading !== undefined) memo.turned = (memo.turned ?? 0) + Math.abs(wrapSigned(heading - memo.lastHeading));
            memo.lastHeading = heading;
            return (memo.turned ?? 0) > 360;
          },
        },
        {
          id: 'variometer',
          label: 'the variometer reads lift (above +0.5 m/s, its climb beeps) while circling',
          from: 20,
          until: 150,
          test: (api) => api.flight.vario > 0.5 && api.module.audioProfile.vario === true,
        },
        {
          id: 'climb',
          label: 'climbs 50 m above the lowest point of the climb',
          from: 20,
          until: 150,
          test(api) {
            const memo = api.memo;
            memo.lowest = Math.min(memo.lowest ?? Infinity, api.flight.altitude);
            return api.flight.altitude - memo.lowest > 50;
          },
        },
        { id: 'flying', label: 'flying the whole time (no landing)', until: 150, always: true, test: (api) => api.craftState.phase === 'flight' },
      ],
    }),
    Object.freeze({
      id: 'paraglider-big-ears',
      views: ['third'],
      start: { at: 'spawn', mode: 'air', agl: 900, clearRadius: 400 },
      seconds: 34,
      script(t) {
        return { roll: 0, pitch: 0, yaw: 0, throttle: 0, held: t >= 4 && t < 22 ? ['craftAbility'] : [] };
      },
      checks: [
        { id: 'trimSink', label: 'at trim the sink is gentle (under 2 m/s)', from: 2, until: 4, test: (api) => api.flight.verticalSpeed > -2 },
        { id: 'earsIn', label: 'big ears in (the tips folded)', from: 4, until: 10, test: (api) => api.craftState.earsFold > 0.95 && api.craftState.bigEars === true },
        { id: 'fastDescent', label: 'descending faster than 2 m/s with the ears in', from: 10, until: 22, test: (api) => api.flight.verticalSpeed < -2 },
        { id: 'earsOut', label: 'ears out again: the tips reopen', from: 24, until: 34, test: (api) => api.craftState.earsFold < 0.05 && api.craftState.bigEars === false },
      ],
    }),
    Object.freeze({
      id: 'paraglider-slope-launch',
      views: ['third', 'first'],
      // Standing on flat ground, the pilot asks WREN to launch: the copilot command takes the pilot to
      // the nearest launch slope facing into the wind (the craft's own slope finder, as a switch below
      // 60 m does), the wing inflates, the pilot runs and is lifted off.
      start: { at: 'spawn', mode: 'ground', flatSpot: true },
      seconds: 30,
      script(t, api) {
        if (t >= 1 && api.once('launch')) api.memo.reply = api.controller.runCraftCommand('launch');
        return { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
      },
      checks: [
        { id: 'standing', label: 'starts standing on the flat, the wing laid down', until: 0.9, test: (api) => api.flight.onGround && api.craftState.phase === 'landed' },
        { id: 'command', label: 'the launch command runs (a slope found)', from: 1, until: 3, test: (api) => Boolean(api.memo.reply && api.memo.reply.ok && /Launching|Inflating/.test(api.memo.reply.text)) },
        { id: 'inflating', label: 'the wing inflates and the pilot runs', from: 1, until: 9, test: (api) => api.craftState.phase === 'launch' && api.craftState.inflation > 0.5 && api.flight.groundSpeed > 2 },
        { id: 'airborne', label: 'airborne: flying the wing clear of the slope', from: 2, until: 30, test: (api) => api.craftState.phase === 'flight' && !api.flight.onGround && api.agl() > 5 },
      ],
    }),
  ]),
});
