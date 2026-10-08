// Bush plane scenarios for ?test=craft: a take-off from a ground placement (the parking brake path,
// full power, rotation at 100 % assists) and the smoke trail through the craft ability.
export default Object.freeze({
  craft: 'bushplane',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'bushplane-ground-takeoff',
      views: ['third', 'first'],
      start: { at: 'here', mode: 'ground' },
      seconds: 45,
      script(t) {
        if (t < 2) return { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
        if (t < 14) return { throttle: 1, roll: 0, pitch: 0, yaw: 0 };
        return { throttle: 1, roll: 0, pitch: t < 24 ? 0.3 : 0.1, yaw: 0 };
      },
      checks: [
        { id: 'standing', label: 'starts standing on its gear', until: 1.5, test: (api) => api.flight.onGround },
        { id: 'rolling', label: 'rolls past 10 m/s', until: 14, test: (api) => api.flight.onGround && api.flight.groundSpeed > 10 },
        { id: 'airborne', label: 'airborne, 20 m above the ground', until: 45, test: (api) => !api.flight.onGround && api.flight.agl > 20 },
      ],
    }),
    Object.freeze({
      id: 'bushplane-smoke',
      views: ['third'],
      start: { at: 'here', mode: 'air', agl: 500 },
      seconds: 14,
      script(t, api) {
        const actions = [];
        if (t >= 1 && api.once('smokeOn')) actions.push('craftAbility');
        if (t >= 9 && api.once('smokeOff')) actions.push('craftAbility');
        return { roll: 0, pitch: 0, yaw: 0, actions };
      },
      checks: [
        { id: 'smokeOn', label: 'smoke on', until: 3, test: (api) => api.craftState.smoke === true },
        { id: 'trail', label: 'the trail streams from the tail', from: 2, until: 8, test: (api) => api.controller.getStats().trailParticles > 20 },
        { id: 'smokeOff', label: 'smoke off again', from: 9.5, until: 14, test: (api) => api.craftState.smoke === false },
      ],
    }),
  ]),
});
