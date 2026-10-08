// Glider scenarios for ?test=craft: the spoilers steepen the glide (both toe brakes open them in
// the air), started as a placement at 800 m above the ground.
export default Object.freeze({
  craft: 'glider',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'glider-spoilers',
      views: ['third', 'first'],
      start: { at: 'here', mode: 'air', agl: 800 },
      seconds: 24,
      script(t) {
        return { roll: 0, pitch: 0, yaw: 0, brakeL: t >= 3 && t < 15 ? 1 : 0, brakeR: t >= 3 && t < 15 ? 1 : 0 };
      },
      checks: [
        { id: 'spoilersOut', label: 'spoilers out (half or more)', until: 8, test: (api) => api.flight.airbrake >= 0.5 },
        { id: 'steepGlide', label: 'sinking faster than 2.5 m/s with the spoilers out', from: 5, until: 15, test: (api) => api.flight.verticalSpeed < -2.5 },
        { id: 'spoilersIn', label: 'spoilers back in', from: 17, until: 24, test: (api) => api.flight.airbrake < 0.1 },
      ],
    }),
  ]),
});
