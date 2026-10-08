// Bush plane scenarios for ?test=craft: a ground placement and the take-off roll from it (idle until
// the pilot opens the throttle), and the smoke trail through the craft ability.
export default Object.freeze({
  craft: 'bushplane',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'bushplane-ground-start',
      views: ['third', 'first'],
      // The nearest flat, dry spot to the world's spawn, nose into the wind (flight.startAt 'ground').
      // The flat spot guarantees the first 180 m of the run, so the scenario ends with the take-off
      // roll under way; the flight lab's groundStart test flies the whole take-off on flat ground.
      start: { at: 'spawn', mode: 'ground', flatSpot: true },
      seconds: 9,
      script(t) {
        return { throttle: t < 2 ? 0 : 1, roll: 0, pitch: 0, yaw: 0 };
      },
      checks: [
        { id: 'standing', label: 'starts standing still on its gear', until: 1.5, test: (api) => api.flight.onGround && api.flight.groundSpeed < 0.5 },
        { id: 'idle', label: 'the throttle at idle before the pilot opens it', until: 1.5, test: (api) => api.flight.throttle < 0.05 },
        { id: 'rolling', label: 'the take-off roll passes 8 m/s', until: 9, test: (api) => api.flight.onGround && api.flight.groundSpeed > 8 },
        { id: 'onGround', label: 'still on its wheels through the roll', from: 0, until: 9, always: true, test: (api) => api.flight.onGround },
      ],
    }),
    Object.freeze({
      id: 'bushplane-smoke',
      views: ['third'],
      start: { at: 'spawn', mode: 'air', agl: 500 },
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
