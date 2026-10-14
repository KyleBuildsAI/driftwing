// Aerobatic extension for SimFixedWing (profile.extension; contract h.1 'aerobaticAero').
//
// The Extra 330 class airframe itself needs nothing the generic components do not already model: its
// symmetric section (cm0 0, clMin = -clMax, zero incidence) makes inverted flight the mirror of upright
// flight, the propeller's torque, P-factor, slipstream and angular momentum give the torque roll, the
// prop hang and the gyroscopic tumbles, the fuselage side force with the rudder holds a knife-edge, and
// the per-panel stall starts the snap roll's autorotation. The extension adds two things:
//   autorotation  two wing panels a side resolve the spanwise stall too coarsely to reverse the roll
//                 damping the way a real stalled wing does (the descending wing's sections stall deeper
//                 and lose lift all along the span). Past the critical angle of attack, inside the
//                 post-stall drop, a roll moment along the roll rate (profile.autorotation: gain x q S b x
//                 p b / 2V) restores it, so a stalled wing kicked by rudder snaps round, and stops as soon
//                 as the angle of attack comes back under the stall
//   judging       figure recognition on the flight clock: every physics tick it feeds the manoeuvre
//                 recognizer (maneuverRecognizer.js) from the model's own flight data, so figures are
//                 recognized deterministically at 120 Hz, then writes craftState.figureInProgress (the
//                 recognizer's guess) and craftState.lastFigure { figure, score }, and emits the typed
//                 events figureFlown { figure, score, craft, position } and journalStat (the figure's
//                 best score, op 'max'), and a toast with the figure and its score.
// A restore (the trim's probes, the NaN fallback) or a reset forgets the figure in progress, so probe
// steps never feed the recognizer a figure.
import { smoothstep } from './aero.js';
import { createManeuverRecognizer, createRecognizerInput, figureName, FIGURES } from './maneuverRecognizer.js';

/** The extension's snapshot: no state worth keeping across a restore (the recognizer restarts). */
const RESTART_SNAPSHOT = Object.freeze({ recognizer: 'restart' });
const STAT_BY_FIGURE = new Map(FIGURES.map((figure) => [figure.id, figure.stat]));
/** Scores at or above this toast as a success. */
const GOOD_SCORE = 80;

export function createAerobaticExtension({ profile, craft, bus, craftState = {}, flightData }) {
  const autorotation = profile && profile.autorotation ? profile.autorotation : null;
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
    /** The stalled wing's roll-damping reversal (see the header). */
    moments(tick, momentBody) {
      if (!autorotation || !(tick.airspeed > 5) || tick.onGround) return;
      const critical = flightData.aoaCritical;
      const beyond = Math.abs(tick.aoa) - critical;
      const share = smoothstep(autorotation.from, autorotation.full, beyond) * (1 - smoothstep(autorotation.fadeFrom, autorotation.fadeTo, beyond));
      if (!(share > 0)) return;
      // Body z is right wing up: a right roll (positive roll rate) is a negative moment about z.
      const rollRate = -tick.angularVelocity.z;
      const reduced = (rollRate * tick.wingSpan) / (2 * tick.airspeed);
      momentBody.z -= autorotation.gain * share * tick.dynamicPressure * tick.wingArea * tick.wingSpan * reduced;
    },

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
