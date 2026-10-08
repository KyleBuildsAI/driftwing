// Aerobatic extension for SimFixedWing (profile.extension; contract h.1 'aerobaticAero').
//
// The Extra 330 class airframe itself needs nothing the generic components do not already model: its
// symmetric section (cm0 0, clMin = -clMax, zero incidence) makes inverted flight the mirror of upright
// flight, the propeller's torque, P-factor, slipstream and angular momentum give the torque roll, the
// prop hang and the gyroscopic tumbles, the fuselage side force with the rudder holds a knife-edge, and
// the per-panel stall gives the snap roll's autorotation. What the extension adds is the figure judging
// on the flight clock: every physics tick it feeds the manoeuvre recognizer (maneuverRecognizer.js) from
// the model's own flight data, so figures are recognized deterministically at 120 Hz, then
//   - writes craftState.figureInProgress (the recognizer's guess) and craftState.lastFigure { figure, score }
//   - emits the typed events figureFlown { figure, score, craft, position } and journalStat (the figure's
//     best score, op 'max'), and a toast with the figure and its score.
// A restore (the trim's probes, the NaN fallback) or a reset forgets the figure in progress, so probe
// steps never feed the recognizer a figure.
import { createManeuverRecognizer, createRecognizerInput, figureName, FIGURES } from './maneuverRecognizer.js';

/** The extension's snapshot: no state worth keeping across a restore (the recognizer restarts). */
const RESTART_SNAPSHOT = Object.freeze({ recognizer: 'restart' });
const STAT_BY_FIGURE = new Map(FIGURES.map((figure) => [figure.id, figure.stat]));
/** Scores at or above this toast as a success. */
const GOOD_SCORE = 80;

export function createAerobaticExtension({ craft, bus, craftState = {}, flightData }) {
  const craftId = craft && craft.id ? craft.id : 'aerobatic';
  const input = createRecognizerInput();
  /** The tick being sampled (for the event's position). */
  let currentTick = null;

  function eventPosition() {
    const telemetry = currentTick && currentTick.env ? currentTick.env.telemetry : null;
    const position = telemetry ? telemetry.position : null;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) return { x: position.x, y: position.y, z: position.z };
    return { x: 0, y: currentTick ? currentTick.altitude : 0, z: 0 };
  }

  function onFigure(figure, score) {
    craftState.lastFigure = { figure, score };
    if (!bus) return;
    bus.emitTyped('figureFlown', { figure, score, craft: craftId, position: eventPosition() });
    const stat = STAT_BY_FIGURE.get(figure);
    if (stat) bus.emitTyped('journalStat', { key: stat, value: score, op: 'max' });
    bus.emit('notify', { text: `${figureName(figure)}: ${score} points`, kind: score >= GOOD_SCORE ? 'success' : 'info' });
  }

  const recognizer = createManeuverRecognizer({ onFigure });

  function restart() {
    recognizer.reset();
    craftState.figureInProgress = null;
  }

  return {
    afterStep(tick) {
      currentTick = tick;
      input.dt = tick.dt;
      input.pitch = flightData.pitch;
      input.bank = flightData.bank;
      input.heading = flightData.heading;
      input.rollRate = flightData.rollRate;
      input.pitchRate = flightData.pitchRate;
      input.yawRate = flightData.yawRate;
      input.gLoad = flightData.gLoad;
      input.stalled = flightData.stalled;
      input.airspeed = flightData.airspeed;
      input.verticalSpeed = flightData.verticalSpeed;
      input.flightPath = flightData.flightPath;
      input.altitude = tick.altitude;
      input.onGround = tick.onGround;
      input.assists = tick.assists;
      recognizer.sample(input);
      craftState.figureInProgress = recognizer.figureInProgress;
      currentTick = null;
    },

    reset() {
      restart();
    },

    snapshot() {
      return RESTART_SNAPSHOT;
    },

    restore() {
      restart();
    },
  };
}
