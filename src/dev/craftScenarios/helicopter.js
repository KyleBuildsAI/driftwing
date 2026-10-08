// Helicopter scenarios for ?test=craft: a 'hover' placement, then hover hold through the craft
// ability keeps the helicopter still.
export default Object.freeze({
  craft: 'helicopter',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'helicopter-hover-hold',
      views: ['third', 'first'],
      start: { at: 'here', mode: 'hover', agl: 60 },
      seconds: 24,
      script(t, api) {
        return { throttle: 0.5, roll: 0, pitch: 0, yaw: 0, actions: t >= 2 && api.once('hold') ? ['craftAbility'] : [] };
      },
      checks: [
        { id: 'holdOn', label: 'hover hold on', until: 4, test: (api) => api.craftState.hoverHold === true },
        { id: 'still', label: 'holding still (under 4 m/s over the ground)', from: 8, until: 24, always: true, test: (api) => api.flight.groundSpeed < 4 },
        { id: 'aloft', label: 'still in the air', from: 8, until: 24, always: true, test: (api) => !api.flight.onGround && api.flight.agl > 10 },
      ],
    }),
  ]),
});
