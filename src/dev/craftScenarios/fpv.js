// FPV drone scenarios for ?test=craft: a 'hover' placement holds its height with the throttle
// centred (angle mode with altitude hold at 100 % assists).
export default Object.freeze({
  craft: 'fpv',
  general: Object.freeze({ throttle: 0.5, stick: 0.3 }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'fpv-hover-start',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'hover', agl: 30 },
      seconds: 15,
      script() {
        return { throttle: 0.5, roll: 0, pitch: 0, yaw: 0 };
      },
      checks: [
        { id: 'holding', label: 'holding its height (under 4 m/s up or down)', from: 3, until: 15, always: true, test: (api) => Math.abs(api.flight.verticalSpeed) < 4 },
        { id: 'aloft', label: 'still in the air', from: 3, until: 15, always: true, test: (api) => !api.flight.onGround && api.flight.agl > 5 },
      ],
    }),
  ]),
});
