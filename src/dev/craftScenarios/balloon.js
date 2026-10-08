// Hot air balloon scenarios for ?test=craft (contract h.8 and Milestone P item 3: "balloon reaches a
// target wind layer"):
//
//   balloon-wind-layer   from a low drift, pick the first band of the wind-layer column at least
//                        TARGET_RISE above the balloon, burn up to it, let go (the altitude hold
//                        captures) and ride that layer: the band is the nearest to the balloon's
//                        height, its ground velocity is the band's wind, not the one it started in
//   balloon-drift-start  a 'drift' placement (what situate returns): moving with the air from the first
//                        frame, the envelope at equilibrium, level under the altitude hold
//   balloon-burner-lag   0 % assists: an 8 s burn heats the envelope at once but the climb starts only
//                        after the thermal lag; the vent cools it again
//   balloon-landing      the copilot's assisted landing: a graded touchdown, the vent collapses the
//                        envelope, the basket stops
//   balloon-bounce-drag  0 % assists: a pilot's 2.5 m/s descent into the ground: the basket bounces and
//                        drags in the wind without a soft crash; the vent stops it
//   balloon-rotation     the rotation vents turn the basket; let go, the rotation damping stops it
//   balloon-steer        the copilot's "take us ..." picks the layer going that way and climbs to it
//   balloon-water        a 'water' placement on a lake (a basket put down on the water): it floats,
//                        no water soft crash (limits.waterLanding 'basket')
//
// The general flight test drifts 400 m up, the stick rotating the basket.
import { compassName } from '../../core/util.js';

/** The wind-layer test's target: the first band at least this far (m) above the balloon at the start. */
const TARGET_RISE = 450;
/** The script lets go of the burner when the climb will coast the rest of the way: the vertical speed times this (s). */
const COAST_SECONDS = 30;

/** The horizontal distance between the ground velocity and a band's wind (m/s). */
function windMismatch(api, band) {
  const velocity = api.flight.velocity;
  return Math.hypot(velocity.x - band.vx, velocity.z - band.vz);
}

/** The band of the wind column nearest the balloon's own altitude (index). */
function nearestBand(api) {
  const column = api.craftState.windColumn;
  let best = -1;
  let distance = Infinity;
  column.forEach((band, index) => {
    const gap = Math.abs(band.altitude - api.flight.altitude);
    if (band.primed && gap < distance) {
      best = index;
      distance = gap;
    }
  });
  return best;
}

const IDLE = Object.freeze({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });

export default Object.freeze({
  craft: 'balloon',
  general: Object.freeze({
    start: Object.freeze({ at: 'spawn', mode: 'drift', agl: 400, clearRadius: 1500, clearance: 250 }),
    stick: 1,
    pulse: 8,
    throttle: 0,
    seconds: 45,
  }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'balloon-wind-layer',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'drift', agl: 150, clearRadius: 1500, clearance: 120 },
      seconds: 240,
      script(t, api) {
        const memo = api.memo;
        const column = api.craftState.windColumn;
        if (memo.target === undefined && column[0].primed) {
          const index = column.findIndex((candidate) => candidate.altitude >= api.flight.altitude + TARGET_RISE);
          memo.target = index >= 0 ? index : column.length - 1;
        }
        const band = memo.target === undefined ? null : column[memo.target];
        if (!memo.startWind && t > 3) memo.startWind = { vx: api.flight.velocity.x, vz: api.flight.velocity.z };
        const held = [];
        if (band && band.primed && !memo.released && t > 1) {
          const remaining = band.altitude - api.flight.altitude;
          if (remaining > Math.max(0, api.flight.verticalSpeed) * COAST_SECONDS + 20) held.push('craftAbility');
          else memo.released = t;
        }
        return { ...IDLE, held };
      },
      checks: [
        { id: 'lag', label: 'the burn heats at once, the climb waits (under 0.6 m/s for 6 s)', from: 1, until: 7, always: true, test: (api) => api.flight.verticalSpeed < 0.6 },
        { id: 'climbs', label: 'climbing faster than 1.5 m/s', until: 120, test: (api) => api.flight.verticalSpeed > 1.5 },
        { id: 'released', label: 'lets go of the burner below the layer', until: 200, test: (api) => Number.isFinite(api.memo.released) },
        {
          id: 'inLayer',
          label: 'the target band is the nearest to the balloon for 30 s',
          from: 60,
          test(api) {
            const memo = api.memo;
            const inside = memo.target !== undefined && nearestBand(api) === memo.target;
            memo.inLayerSeconds = inside ? (memo.inLayerSeconds ?? 0) + api.state.time.frameDt : 0;
            return memo.inLayerSeconds >= 30;
          },
        },
        {
          id: 'ridesLayer',
          label: "riding the layer: the ground velocity within 1 m/s of the band's wind",
          from: 90,
          test: (api) => api.memo.target !== undefined && nearestBand(api) === api.memo.target && windMismatch(api, api.craftState.windColumn[api.memo.target]) < 1,
        },
        {
          id: 'newLayer',
          label: 'a different wind from the one it started in (0.8 m/s or more apart)',
          from: 90,
          test(api) {
            const start = api.memo.startWind;
            return Boolean(start) && nearestBand(api) === api.memo.target && Math.hypot(api.flight.velocity.x - start.vx, api.flight.velocity.z - start.vz) > 0.8;
          },
        },
      ],
    }),
    Object.freeze({
      id: 'balloon-drift-start',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'drift', agl: 300, clearRadius: 800, clearance: 200 },
      seconds: 25,
      script: () => IDLE,
      checks: [
        { id: 'equilibrium', label: 'the envelope starts at its equilibrium temperature', until: 1.5, test: (api) => Math.abs(api.craftState.envelopeTemperature - api.craftState.equilibriumTemperature) < 1.5 },
        { id: 'drifting', label: 'moving with the air (within 2 m/s of the wind) throughout', from: 0.5, always: true, test: (api) => Math.hypot(api.flight.velocity.x - api.flight.wind.x, api.flight.velocity.z - api.flight.wind.z) < 2 },
        { id: 'level', label: 'level under the altitude hold (under 1 m/s up or down)', from: 3, always: true, test: (api) => Math.abs(api.flight.verticalSpeed) < 1 },
        { id: 'column', label: 'the wind-layer column is sampled', until: 4, test: (api) => api.craftState.windColumn.every((band) => band.primed && Number.isFinite(band.altitude)) },
      ],
    }),
    Object.freeze({
      id: 'balloon-burner-lag',
      views: ['third', 'first'],
      assists: 0,
      start: { at: 'spawn', mode: 'drift', agl: 400, clearRadius: 1200, clearance: 250 },
      seconds: 75,
      script(t, api) {
        const memo = api.memo;
        if (t >= 1.5 && memo.startTemperature === undefined) memo.startTemperature = api.craftState.envelopeTemperature;
        if (t >= 50 && memo.ventTemperature === undefined) memo.ventTemperature = api.craftState.envelopeTemperature;
        const held = [];
        if (t >= 2 && t < 10) held.push('craftAbility');
        if (t >= 50 && t < 58) held.push('craftAbilityAlt');
        return { ...IDLE, held };
      },
      checks: [
        { id: 'heats', label: 'the burn heats the envelope 3 K at once', from: 2, until: 11, test: (api) => api.craftState.envelopeTemperature - api.memo.startTemperature > 3 },
        { id: 'lagged', label: 'yet 5 s into the burn the climb has not begun (under 0.5 m/s)', from: 2, until: 7, always: true, test: (api) => api.flight.verticalSpeed < 0.5 },
        { id: 'climbs', label: 'the climb comes after the thermal lag (over 0.5 m/s)', from: 15, until: 45, test: (api) => api.flight.verticalSpeed > 0.5 },
        { id: 'ventCools', label: 'the vent cools the envelope 1.5 K', from: 52, until: 60, test: (api) => api.memo.ventTemperature - api.craftState.envelopeTemperature > 1.5 },
      ],
    }),
    Object.freeze({
      id: 'balloon-landing',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'drift', agl: 90 },
      seconds: 150,
      script(t, api) {
        if (t >= 1 && api.once('land')) api.memo.landReply = api.controller.runCraftCommand('land');
        return IDLE;
      },
      checks: [
        { id: 'command', label: 'the copilot takes the landing', until: 3, test: (api) => Boolean(api.memo.landReply && api.memo.landReply.ok) },
        { id: 'touchdown', label: 'a graded touchdown under 2 m/s', until: 120, test: (api) => api.events.count('landed') > 0 && api.events.last('landed').sinkRate < 2 },
        { id: 'deflated', label: 'the vent collapses the envelope', until: 150, test: (api) => api.flight.onGround && api.craftState.inflation < 0.3 },
        { id: 'stopped', label: 'the basket stops', from: 120, test: (api) => api.flight.onGround && api.flight.groundSpeed < 0.5 },
      ],
    }),
    Object.freeze({
      id: 'balloon-bounce-drag',
      views: ['third'],
      assists: 0,
      start: { at: 'spawn', mode: 'drift', agl: 70 },
      seconds: 120,
      script(t, api) {
        const memo = api.memo;
        if (memo.contactAt === undefined && api.flight.onGround) memo.contactAt = t;
        // Airborne time since the last contact, once the basket has touched (a bounce lasts a while).
        if (memo.contactAt !== undefined) memo.airborne = api.flight.onGround ? 0 : (memo.airborne ?? 0) + api.state.time.frameDt;
        const held = [];
        if (memo.contactAt === undefined) {
          if (-api.flight.verticalSpeed < 2.5) held.push('craftAbilityAlt');
        } else if (t - memo.contactAt > 30) {
          held.push('craftAbilityAlt');
        }
        return { ...IDLE, held };
      },
      checks: [
        { id: 'touches', label: 'the basket reaches the ground', until: 80, test: (api) => api.memo.contactAt !== undefined },
        { id: 'bounces', label: 'it bounces (airborne again for 0.25 s after the first contact)', until: 110, test: (api) => api.memo.airborne >= 0.25 },
        { id: 'drags', label: 'it drags in the wind (on the ground above 1 m/s)', until: 110, test: (api) => api.flight.onGround && api.flight.groundSpeed > 1 },
        { id: 'stops', label: 'the vent stops it', from: 100, test: (api) => api.flight.onGround && api.flight.groundSpeed < 0.5 },
      ],
    }),
    Object.freeze({
      id: 'balloon-rotation',
      views: ['third'],
      start: { at: 'spawn', mode: 'drift', agl: 300, clearRadius: 800, clearance: 200 },
      seconds: 45,
      script(t, api) {
        if (api.memo.heading === undefined) api.memo.heading = api.flight.heading;
        return { ...IDLE, roll: t < 15 ? 1 : 0 };
      },
      checks: [
        { id: 'turns', label: 'the rotation vents turn the basket 30 degrees', until: 20, test: (api) => Math.abs(((api.flight.heading - api.memo.heading + 540) % 360) - 180) > 30 },
        { id: 'damped', label: 'let go, the rotation damping stops it (under 1 deg/s)', from: 35, test: (api) => Math.abs(api.flight.angularVelocity.y) < 1 * (Math.PI / 180) },
      ],
    }),
    Object.freeze({
      id: 'balloon-steer',
      views: ['third'],
      start: { at: 'spawn', mode: 'drift', agl: 120, clearRadius: 1200, clearance: 120 },
      seconds: 45,
      script(t, api) {
        const column = api.craftState.windColumn;
        const top = column[column.length - 1];
        if (t >= 3 && top.primed && api.once('steer')) {
          api.memo.direction = compassName(top.towardDegrees);
          api.memo.reply = api.controller.runCraftCommand('steer', api.memo.direction);
        }
        return IDLE;
      },
      checks: [
        { id: 'reply', label: 'the copilot names a layer', until: 6, test: (api) => Boolean(api.memo.reply && api.memo.reply.ok && /layer/.test(api.memo.reply.text)) },
        { id: 'autopilot', label: 'the autopilot takes it toward a higher band', until: 8, test: (api) => api.flight.autopilot.enabled && api.flight.autopilot.altitude > api.flight.altitude + 100 },
        { id: 'climbing', label: 'climbing toward it', from: 10, test: (api) => api.flight.verticalSpeed > 0.5 },
      ],
    }),
    Object.freeze({
      id: 'balloon-water',
      views: ['third'],
      world: 'waters',
      assists: 0,
      start: { at: 'lake', mode: 'water' },
      seconds: 25,
      script: () => IDLE,
      checks: [
        { id: 'afloat', label: 'the basket floats on the lake (no water soft crash)', from: 1, always: true, test: (api) => api.flight.onWater && api.flight.radarAltitude < 0.8 },
      ],
    }),
  ]),
});
