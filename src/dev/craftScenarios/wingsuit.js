// Wingsuit scenarios for ?test=craft: the parachute opens from an 'air' placement and slows the
// descent.
export default Object.freeze({
  craft: 'wingsuit',
  general: Object.freeze({ start: Object.freeze({ at: 'here', mode: 'air', agl: 1200 }) }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'wingsuit-canopy',
      views: ['third', 'first'],
      start: { at: 'here', mode: 'air', agl: 1200 },
      seconds: 26,
      script(t, api) {
        return { roll: 0, pitch: 0, yaw: 0, actions: t >= 4 && api.once('chute') ? ['chuteDeploy'] : [] };
      },
      checks: [
        { id: 'canopy', label: 'the canopy opens', until: 10, test: (api) => api.craftState.canopy === true },
        { id: 'slow', label: 'descending slower than 8 m/s under the canopy', from: 14, until: 26, always: true, test: (api) => api.flight.verticalSpeed > -8 },
      ],
    }),
  ]),
});
