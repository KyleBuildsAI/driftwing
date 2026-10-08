// Aerobatic scenarios for ?test=craft (Milestone P item 3: the recognizer detects a scripted loop and
// an aileron roll), plus the smoke system and a snap roll with the assists off. The pilot scripts read
// the body rates from state.flight.angularVelocity (body axes, rad/s: x pitch up, z right wing up) and
// integrate them per frame in the run's memo, so the pulls hold the wings where they started.
const DEG = Math.PI / 180;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Integrates the body roll (deg, right positive) and returns the frame's roll rate (rad/s). */
function trackRoll(api) {
  const memo = api.memo;
  const rollRate = -api.flight.angularVelocity.z;
  const dt = Number.isFinite(memo.lastT) ? api.t - memo.lastT : 0;
  memo.lastT = api.t;
  memo.roll = (memo.roll ?? 0) + (rollRate / DEG) * dt;
  memo.peakRollRate = Math.max(memo.peakRollRate ?? 0, Math.abs(rollRate) / DEG);
  return rollRate;
}

/** Aileron that keeps the body's roll at `reference` degrees of the integrated roll. */
function holdRoll(api, reference, rollRate) {
  return clamp(-0.04 * (api.memo.roll - reference) - 0.15 * rollRate, -1, 1);
}

/** The figure of the last figureFlown event, or ''. */
function lastFigure(api) {
  const event = api.events.last('figureFlown');
  return event ? event.figure : '';
}

export default Object.freeze({
  craft: 'aerobatic',
  // The general test's roll pulses at 40 % would roll it 240 degrees: 15 % is the same gentle input.
  general: Object.freeze({ stick: 0.15 }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'aerobatic-loop',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 900, clearRadius: 2500, speed: 85, throttle: 1 },
      seconds: 26,
      script(t, api) {
        const memo = api.memo;
        const rollRate = trackRoll(api);
        const pitch = api.flight.pitch;
        if (t < 3 || memo.done) return { roll: 0, pitch: 0, yaw: 0, throttle: 1 };
        if (pitch > 70) memo.up = true;
        if (memo.up && Math.abs(api.flight.roll) > 150) memo.top = true;
        if (memo.top && pitch < -60) memo.down = true;
        if (memo.down && pitch > -8) {
          memo.done = true;
          return { roll: 0, pitch: 0, yaw: 0, throttle: 1 };
        }
        return { roll: holdRoll(api, 0, rollRate), pitch: 0.8, yaw: 0, throttle: 1 };
      },
      checks: [
        { id: 'inProgress', label: 'the figure display calls it a loop on the way round', from: 4, until: 16, test: (api) => api.craftState.figureInProgress === 'loop' },
        { id: 'loop', label: 'the recognizer names the loop', until: 26, test: (api) => lastFigure(api) === 'loop' },
        { id: 'scored', label: 'scored for precision (0-100) and kept as lastFigure', until: 26, test: (api) => api.craftState.lastFigure?.figure === 'loop' && api.craftState.lastFigure.score >= 0 && api.craftState.lastFigure.score <= 100 },
        { id: 'journal', label: 'the best loop score reaches the journal', until: 26, test: (api) => api.events.last('journalStat')?.key === 'aerobaticLoop' },
      ],
    }),
    Object.freeze({
      id: 'aerobatic-roll',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 900, clearRadius: 2000, speed: 80, throttle: 0.8 },
      seconds: 12,
      script(t, api) {
        trackRoll(api);
        const rolling = t >= 3 && api.memo.roll < 330;
        return { roll: rolling ? 1 : 0, pitch: 0, yaw: 0, throttle: 0.8 };
      },
      checks: [
        { id: 'rate', label: 'rolls faster than 300 deg/s', from: 3, until: 6, test: (api) => api.memo.peakRollRate > 300 },
        { id: 'aileronRoll', label: 'the recognizer names the aileron roll', until: 12, test: (api) => lastFigure(api) === 'aileronRoll' },
        { id: 'one', label: 'one figure, no other', from: 11, until: 12, test: (api) => api.events.count('figureFlown') === 1 },
      ],
    }),
    Object.freeze({
      id: 'aerobatic-smoke',
      views: ['third'],
      start: { at: 'spawn', mode: 'air', agl: 600, speed: 80, throttle: 0.7 },
      seconds: 12,
      script(t, api) {
        const actions = [];
        if (t >= 1 && api.once('smokeOn')) actions.push('craftAbility');
        if (t >= 3 && api.once('colour')) actions.push('craftAbilityAlt');
        if (t >= 8 && api.once('smokeOff')) actions.push('craftAbility');
        return { roll: 0, pitch: 0, yaw: 0, actions };
      },
      checks: [
        { id: 'smokeOn', label: 'Space switches the smoke on', until: 3, test: (api) => api.craftState.smoke === true },
        { id: 'colour', label: 'Shift+Space cycles the colour', from: 3, until: 6, test: (api) => api.craftState.smokeColor === 1 },
        { id: 'ribbon', label: 'the ribbon is laid behind the craft', from: 2, until: 8, test: (api) => (api.controller.planeMesh.userData.smokeRibbon?.getStats().liveSamples ?? 0) > 30 },
        { id: 'puffs', label: 'the puffs stream from the nozzle', from: 2, until: 8, test: (api) => api.controller.getStats().trailParticles > 20 },
        { id: 'smokeOff', label: 'smoke off again, the ribbon still hanging in the sky', from: 9, until: 12, test: (api) => api.craftState.smoke === false && (api.controller.planeMesh.userData.smokeRibbon?.getStats().liveSamples ?? 0) > 30 },
      ],
    }),
    Object.freeze({
      id: 'aerobatic-snap',
      views: ['third'],
      assists: 0,
      start: { at: 'spawn', mode: 'air', agl: 1200, clearRadius: 2000, speed: 68, throttle: 0.7 },
      seconds: 14,
      script(t, api) {
        const memo = api.memo;
        const rollRate = trackRoll(api);
        if (t < 3) return { roll: clamp(-0.02 * api.flight.roll, -0.3, 0.3), pitch: clamp(-0.03 * api.flight.pitch, -0.2, 0.2), yaw: 0, throttle: 0.7 };
        if (!memo.stopping && memo.roll < 240) return { roll: 0, pitch: 0.7, yaw: 1, throttle: 0.7 };
        memo.stopping = true;
        // Stop the rotation (forward stick, opposite rudder), then fly wings level onto the horizon.
        if (!memo.stopped) {
          if (Math.abs(rollRate) < 60 * DEG) memo.stopped = true;
          return { roll: -0.3, pitch: -0.2, yaw: -1, throttle: 0.7 };
        }
        return { roll: clamp(-0.02 * api.flight.roll - 0.1 * rollRate, -1, 1), pitch: clamp(-0.03 * api.flight.pitch, -0.3, 0.3), yaw: 0, throttle: 0.7 };
      },
      checks: [
        { id: 'stalled', label: 'one wing stalls into the autorotation', from: 3, until: 6, test: (api) => api.flight.stall.stalled === true },
        { id: 'snapRoll', label: 'the recognizer names the snap roll', until: 14, test: (api) => lastFigure(api) === 'snapRoll' },
      ],
    }),
  ]),
});
