// Jet scenarios for ?test=craft: a 'climb' placement (45 degrees at full power, the throttle preset
// to the stop) keeps climbing.
export default Object.freeze({
  craft: 'jet',
  general: Object.freeze({ stick: 0.25 }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'jet-climb-start',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'climb', agl: 1500, speed: 220 },
      seconds: 18,
      checks: [
        { id: 'climbing', label: 'climbing faster than 30 m/s', until: 4, test: (api) => api.flight.verticalSpeed > 30 },
        { id: 'fullPower', label: 'the throttle at full power', until: 2, test: (api) => api.flight.throttle > 0.9 },
        { id: 'gained', label: '300 m gained', until: 18, test: (api) => api.flight.altitude - api.start.y > 300 },
      ],
    }),
  ]),
});
