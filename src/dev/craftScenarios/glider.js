// Glider scenarios for ?test=craft: the spoilers steepen the glide (both toe brakes open them in
// the air), started as a placement at 800 m above the ground.
export default Object.freeze({
  craft: 'glider',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'glider-spoilers',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 800 },
      seconds: 24,
      script(t) {
        return { roll: 0, pitch: 0, yaw: 0, brakeL: t >= 3 && t < 15 ? 1 : 0, brakeR: t >= 3 && t < 15 ? 1 : 0 };
      },
      checks: [
        { id: 'spoilersOut', label: 'spoilers out (half or more)', until: 8, test: (api) => api.flight.airbrake >= 0.5 },
        // The total-energy vario: at 100 % assists the flight-path hold trades speed for height, so the
        // spoilers show as energy lost, not only as sink.
        { id: 'steepGlide', label: 'losing energy faster than 2.5 m/s with the spoilers out (total-energy vario)', from: 5, until: 15, test: (api) => api.flight.vario < -2.5 },
        { id: 'spoilersIn', label: 'spoilers back in', from: 17, until: 24, test: (api) => api.flight.airbrake < 0.1 },
      ],
    }),
  ]),
});
