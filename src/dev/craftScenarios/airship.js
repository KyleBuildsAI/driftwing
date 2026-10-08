// Airship scenarios for ?test=craft: the scenic cruise visits three sites (spec Milestone P item 3:
// the craft ability plans a chain through the director's and the landmarks' sites near the world's
// spawn and the autopilot flies it hands off), and the static and vectored lift (the rocker swivels
// the pods straight up for a climb with no way on, then the flap keys held fill the ballonets for a
// heavy descent). The general test pulses the stick fully for 3 s: an airship answers its controls
// slowly.
export default Object.freeze({
  craft: 'airship',
  general: Object.freeze({ stick: 1, pulse: 3 }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'airship-scenic-cruise',
      views: ['third', 'first'],
      // Above the spawn and clear of the hills around it; the cruise climbs to its own altitude.
      // The second view's run starts with the first run's craft state (the same craft stays installed):
      // the harness turns the autopilot off at the start, which ends that cruise, and the press at 2 s
      // starts a new one (its visit count from zero), so the visits are checked from 3 s on.
      start: { at: 'spawn', mode: 'air', agl: 400, clearRadius: 2500, clearance: 280, speed: 18, craftState: { ballonetTarget: 0.5, vectorTarget: 0 } },
      seconds: 480,
      script(t, api) {
        return { roll: 0, pitch: 0, yaw: 0, actions: t >= 2 && api.once('cruise') ? ['craftAbility'] : [] };
      },
      checks: [
        {
          id: 'planned',
          label: 'the scenic cruise plans a chain of three sites and engages the autopilot',
          from: 3,
          until: 12,
          test: (api) => api.craftState.scenicCruise.active && api.craftState.scenicCruise.visited === 0 && api.craftState.scenicCruise.waypoints.length >= 3 && api.flight.autopilot.enabled,
        },
        {
          id: 'flying',
          label: 'the cruise keeps flying until three sites are behind it',
          from: 12,
          always: true,
          test: (api) => api.craftState.scenicCruise.active || api.craftState.scenicCruise.visited >= 3,
        },
        { id: 'visited', label: 'visits three sites', from: 3, test: (api) => api.craftState.scenicCruise.visited >= 3 },
        { id: 'aloft', label: 'clear of the ground all the way', from: 2, always: true, test: (api) => !api.flight.onGround && api.agl() > 60 },
      ],
    }),
    Object.freeze({
      id: 'airship-vector-ballonet',
      views: ['third', 'first'],
      // Drifting with the air, no way on, at neutral trim; the props swivel up and the throttle opens.
      start: { at: 'spawn', mode: 'drift', agl: 500, clearRadius: 600, clearance: 400, craftState: { ballonetTarget: 0.5, vectorTarget: 0 } },
      seconds: 110,
      script(t) {
        // The rocker to its forward stop (the pods snap to 120 degrees), then back a quarter (90
        // degrees: the lever moves the pods relatively), full throttle until 45 s; then idle, the
        // rocker back to the middle (the pods forward) and the flap keys held (ballonets filling).
        const controls = { roll: 0, pitch: 0, yaw: 0, throttle: t < 45 ? 1 : 0, held: [] };
        if (t >= 1 && t < 3) controls.trim = 1;
        else if (t >= 3 && t < 45) controls.trim = 0.75;
        else if (t >= 45) controls.trim = 0;
        if (t >= 50 && t < 56) controls.held.push('flapsDown');
        return controls;
      },
      checks: [
        { id: 'vectored', label: 'the pods swivel up to 90 degrees', from: 1, until: 15, test: (api) => api.craftState.vectorAngle >= 89 },
        { id: 'climbing', label: 'vectored thrust climbs with no way on (over 2.5 m/s)', from: 10, until: 45, test: (api) => api.flight.verticalSpeed > 2.5 && api.flight.airspeed < 10 },
        { id: 'forward', label: 'the pods back to forward', from: 46, until: 60, test: (api) => Math.abs(api.craftState.vectorAngle) < 1 },
        { id: 'heavy', label: 'the flap keys fill the ballonets: static heaviness over 100 kg', from: 50, until: 80, test: (api) => api.craftState.ballonetTarget > 0.85 && api.craftState.heaviness > 100 },
        { id: 'sinking', label: 'heavy, it sinks (over 1 m/s)', from: 60, until: 110, test: (api) => api.flight.verticalSpeed < -1 },
        { id: 'aloft', label: 'clear of the ground all the way', always: true, test: (api) => !api.flight.onGround && api.agl() > 60 },
      ],
    }),
  ]),
});
