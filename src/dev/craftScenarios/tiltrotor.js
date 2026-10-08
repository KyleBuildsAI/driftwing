// Tiltrotor scenarios for ?test=craft (Phase 3 contract h.8, the spec's Milestone P item 3: "tiltrotor
// full conversion both ways"):
//   tiltrotor-conversion   from a hover, the flap buttons select airplane mode (two detents) and the
//                          auto-nacelle schedule converts as the airspeed builds; after a short cruise
//                          they select the hover again and the nacelles come back up as the speed bleeds
//                          off. The corridor holds all the way, and both conversions reach the journal.
//   tiltrotor-overspeed    auto-nacelle off (the craft ability) at 120 m/s, the nacelles straight to the
//                          hover detent: out of the corridor's upper edge, the rotor-overspeed state and
//                          its real consequences (blade-stall buffet, the craft slows hard), no damage.
//   tiltrotor-wing-stall   auto-nacelle off in airplane mode with the lever at idle: the airspeed
//                          bleeds below the corridor's lower edge, the wing-stall state, and the craft
//                          sinks; no soft crash.
const KMH = 3.6;

/** The journal's tiltrotorConversions record (0 before the first). */
function conversionsCounted(api) {
  const journal = api.ctx.systems.journal;
  const stat = journal ? journal.getRecords().stats.tiltrotorConversions : null;
  return stat ? stat.value : 0;
}

/** Presses the two detent steps of one direction on separate frames (90 -> 60 -> 0, or back). */
function detents(t, api, from, action, key) {
  if (t >= from && api.once(`${key}1`)) return [action];
  if (t >= from + 0.3 && api.once(`${key}2`)) return [action];
  return [];
}

export default Object.freeze({
  craft: 'tiltrotor',
  general: Object.freeze({ stick: 0.4 }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'tiltrotor-conversion',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'hover', agl: 450, clearRadius: 6000, clearance: 350, throttle: 0.5 },
      seconds: 80,
      script(t, api) {
        const memo = api.memo;
        const angle = api.craftState.nacelleAngle;
        if (!memo.phase) {
          memo.phase = 'hover';
          memo.conversionsBefore = conversionsCounted(api);
        }
        if (memo.phase === 'hover' && t >= 2) memo.phase = 'toAirplane';
        if (memo.phase === 'toAirplane' && angle <= 1) {
          memo.phase = 'cruise';
          memo.airplaneAt = t;
        }
        if (memo.phase === 'cruise' && t - memo.airplaneAt >= 10) {
          memo.phase = 'toHover';
          memo.hoverFrom = t;
        }
        if (memo.phase === 'toHover' && angle >= 75) memo.phase = 'settle';
        switch (memo.phase) {
          case 'toAirplane':
            return { throttle: 0.8, pitch: 0, roll: 0, yaw: 0, actions: detents(t, api, 2, 'flapsUp', 'forward') };
          case 'cruise':
            return { throttle: 0.62, pitch: 0, roll: 0, yaw: 0 };
          case 'toHover':
            return { throttle: 0.15, pitch: 0.25, roll: 0, yaw: 0, actions: detents(t, api, memo.hoverFrom, 'flapsDown', 'up') };
          case 'settle':
            return { throttle: 0.5, pitch: 0, roll: 0, yaw: 0 };
          default:
            return { throttle: 0.5, pitch: 0, roll: 0, yaw: 0 };
        }
      },
      checks: [
        { id: 'selected', label: 'airplane mode selected with the flap buttons (nacelle target 0)', until: 4, test: (api) => api.craftState.nacelleTarget === 0 },
        { id: 'airplane', label: 'converted to airplane mode: nacelles at 0 degrees above 200 km/h', until: 45, test: (api) => api.craftState.nacelleAngle <= 1 && api.flight.airspeed * KMH > 200 },
        { id: 'hover', label: 'converted back: nacelles at 85 degrees or more', from: 25, until: 80, test: (api) => api.craftState.nacelleAngle >= 85 && api.craftState.mode === 'hover' },
        { id: 'corridor', label: 'inside the conversion corridor all the way', until: 80, always: true, test: (api) => api.craftState.corridor.state === 'ok' },
        { id: 'aloft', label: 'well clear of the ground all the way (over 100 m)', until: 80, always: true, test: (api) => api.agl() > 100 },
        { id: 'journal', label: 'both conversions counted in the journal records', until: 80, test: (api) => conversionsCounted(api) - api.memo.conversionsBefore >= 2 },
      ],
    }),
    Object.freeze({
      id: 'tiltrotor-overspeed',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 900, speed: 120, throttle: 0.6, clearRadius: 3000, clearance: 600 },
      seconds: 24,
      script(t, api) {
        const memo = api.memo;
        if (memo.startSpeed === undefined && t >= 1.5) memo.startSpeed = api.flight.airspeed;
        const actions = [];
        if (t >= 1 && api.once('autoOff')) actions.push('craftAbility');
        actions.push(...detents(t, api, 2, 'flapsDown', 'up'));
        return { throttle: 0.6, pitch: 0, roll: 0, yaw: 0, actions };
      },
      checks: [
        { id: 'autoOff', label: 'auto-nacelle off (the craft ability)', until: 2, test: (api) => api.craftState.autoNacelle === false },
        { id: 'overspeed', label: 'out of the corridor: the rotor-overspeed state', from: 2, until: 14, test: (api) => api.craftState.corridor.state === 'overspeed' },
        { id: 'buffet', label: 'the retreating blades stall: buffet over 0.3', from: 2, until: 16, test: (api) => api.flight.stall.buffet > 0.3 },
        { id: 'slows', label: 'the raised rotors slow the craft by 20 m/s', from: 4, until: 24, test: (api) => api.memo.startSpeed - api.flight.airspeed > 20 },
        { id: 'flying', label: 'still flying (no damage: over 100 m up)', until: 24, always: true, test: (api) => api.agl() > 100 },
      ],
    }),
    Object.freeze({
      id: 'tiltrotor-wing-stall',
      views: ['third'],
      start: { at: 'spawn', mode: 'air', agl: 1200, speed: 85, throttle: 0.55, clearRadius: 3000, clearance: 900, craftState: { autoNacelle: false, nacelleAngle: 0, nacelleTarget: 0 } },
      seconds: 34,
      script(t) {
        return { throttle: t < 1 ? 0.55 : 0.1, pitch: 0, roll: 0, yaw: 0 };
      },
      checks: [
        { id: 'airplane', label: 'airplane mode with auto-nacelle off', until: 1, test: (api) => api.craftState.autoNacelle === false && api.craftState.nacelleAngle <= 1 },
        { id: 'wingStall', label: 'below the corridor: the wing-stall state', from: 3, until: 30, test: (api) => api.craftState.corridor.state === 'wingStall' },
        { id: 'warning', label: 'the stall warning sounds', from: 3, until: 32, test: (api) => api.flight.stall.warning === true },
        { id: 'sinks', label: 'the wing gives up: sinking faster than 8 m/s', from: 8, until: 34, test: (api) => api.flight.verticalSpeed < -8 },
        { id: 'flying', label: 'still flying (over 150 m up)', until: 34, always: true, test: (api) => api.agl() > 150 },
      ],
    }),
  ]),
});
