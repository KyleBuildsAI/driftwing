// Aerobatic manoeuvre recognizer: watches the flight on the 120 Hz flight clock and names the figure
// just flown, scored 0-100 for precision (pure; no three.js, no allocation per sample).
//
// How it reads the flight:
//   rotations   the body rates are integrated into total pitch, roll and yaw rotation (degrees, in body
//               axes), so a loop is 360 degrees of pitch whatever the speed, and a roll 360 of roll
//   figures     a figure is everything flown between two stretches of straight, wings-level upright
//               flight (the entry needs ENTRY_SECONDS of it, the exit EXIT_SECONDS). While a figure is
//               open the recognizer sums its rotations and keeps markers in the order they happen:
//                 UP      the nose passed 70 degrees up (a vertical line up)
//                 DOWN    the nose passed 70 degrees down
//                 TOP     inverted near the horizon (the top of a loop, the middle of a roll)
//                 SLIDE   nose high and sinking tail first for SLIDE_SECONDS (a tailslide)
//                 SNAP    stalled and rolling faster than 180 deg/s (a snap roll's autorotation)
//                 TUMBLE  stalled with fast pitch and yaw together (a gyroscopic tumble)
//               On the exit the figure is classified from its totals, markers, heading and height
//               change (classify, in priority order), and scored by its own criteria (score below).
//   passes      the knife-edge pass and the inverted pass are held states, not rotations: 3 s or more
//               at 90 degrees of bank (or upside down) with the height held, scored on how well the
//               height, heading and bank were held. They are recognized when the hold ends.
//   lomcevak    a tumble is only credited at assists of LOMCEVAK_MAX_ASSISTS or less: the V2 reading of
//               the spec's "SIM only" (higher assists hold the angle of attack below the stall anyway).
//
// The caller feeds one sample per physics tick (createRecognizerInput, filled from the flight model)
// and gets onFigure(figureId, score, details) for every figure recognized; figureInProgress names the
// figure that the open window looks like so far (or null).

const RAD = 180 / Math.PI;

/** The figures, their names and the journal stat that keeps each one's best score. */
export const FIGURES = Object.freeze([
  Object.freeze({ id: 'loop', name: 'Loop', stat: 'aerobaticLoop' }),
  Object.freeze({ id: 'aileronRoll', name: 'Aileron roll', stat: 'aerobaticAileronRoll' }),
  Object.freeze({ id: 'barrelRoll', name: 'Barrel roll', stat: 'aerobaticBarrelRoll' }),
  Object.freeze({ id: 'immelmann', name: 'Immelmann', stat: 'aerobaticImmelmann' }),
  Object.freeze({ id: 'splitS', name: 'Split-S', stat: 'aerobaticSplitS' }),
  Object.freeze({ id: 'cubanEight', name: 'Cuban eight', stat: 'aerobaticCubanEight' }),
  Object.freeze({ id: 'hammerhead', name: 'Hammerhead', stat: 'aerobaticHammerhead' }),
  Object.freeze({ id: 'knifeEdge', name: 'Knife-edge pass', stat: 'aerobaticKnifeEdge' }),
  Object.freeze({ id: 'invertedPass', name: 'Inverted pass', stat: 'aerobaticInvertedPass' }),
  Object.freeze({ id: 'snapRoll', name: 'Snap roll', stat: 'aerobaticSnapRoll' }),
  Object.freeze({ id: 'tailslide', name: 'Tailslide', stat: 'aerobaticTailslide' }),
  Object.freeze({ id: 'lomcevak', name: 'Lomcevak', stat: 'aerobaticLomcevak' }),
]);
export const FIGURE_IDS = Object.freeze(FIGURES.map((figure) => figure.id));
const FIGURE_BY_ID = new Map(FIGURES.map((figure) => [figure.id, figure]));

/** The display name of a figure id ('' for an unknown id). */
export function figureName(id) {
  const figure = FIGURE_BY_ID.get(id);
  return figure ? figure.name : '';
}

/** A tumble is credited as a lomcevak only at this assist level or below. */
export const LOMCEVAK_MAX_ASSISTS = 0.25;

/** Straight and level: pitch and bank inside these (deg), body rates under RATE (deg/s). */
const LEVEL = Object.freeze({ PITCH: 12, BANK: 12, RATE: 25, ENTRY_SECONDS: 0.5, EXIT_SECONDS: 0.75 });
/** A figure starts when the craft leaves level flight past these (deg, deg/s). */
const DEPARTURE = Object.freeze({ BANK: 25, PITCH: 20, RATE: 40 });
/** A window longer than this is not one figure (a long turn); it is dropped. */
const WINDOW_MAX_SECONDS = 45;
/** Below this airspeed (m/s) on a level stretch the craft is not flying figures (taxi, hover). */
const MIN_AIRSPEED = 20;
const MARKER = Object.freeze({ UP: 1, DOWN: 2, TOP: 3, SLIDE: 4, SNAP: 5, TUMBLE: 6 });
const MAX_MARKERS = 32;
const VERTICAL = Object.freeze({ ENTER: 70, REARM: 50 });
const TOP = Object.freeze({ UP_Y: -0.5, PITCH: 40, REARM_UP_Y: 0, REARM_PITCH: 55 });
const SLIDE = Object.freeze({ PITCH: 55, SINK: 2, SECONDS: 0.4 });
const SNAP = Object.freeze({ ROLL_RATE: 180, SECONDS: 0.15 });
const TUMBLE = Object.freeze({ PITCH_RATE: 120, YAW_RATE: 90, SECONDS: 0.3 });
/** Rolling segments (for the roll-rate evenness) are samples rolling faster than this (deg/s). */
const ROLLING_RATE = 60;
/** Held passes: 3 s or more, brief excursions up to GRACE seconds forgiven. */
const PASS = Object.freeze({
  SECONDS: 3,
  GRACE: 0.3,
  KNIFE_BANK_MIN: 72,
  KNIFE_BANK_MAX: 108,
  INVERTED_BANK: 155,
  PITCH: 20,
  VERTICAL_SPEED: 6,
  MIN_AIRSPEED: 30,
});

function wrap180(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** Points lost for an error beyond a tolerance, at a rate per unit. */
function over(error, tolerance, perUnit) {
  return Math.max(0, error - tolerance) * perUnit;
}

/** The per-tick input the caller fills (reused). Angles in radians except heading (compass degrees). */
export function createRecognizerInput() {
  return {
    dt: 0,
    pitch: 0,
    bank: 0,
    heading: 0,
    /** Body rates (rad/s): roll right, pitch nose up, yaw nose right positive. */
    rollRate: 0,
    pitchRate: 0,
    yawRate: 0,
    gLoad: 1,
    stalled: false,
    airspeed: 0,
    verticalSpeed: 0,
    flightPath: 0,
    altitude: 0,
    onGround: false,
    /** The assist level 0..1 (the lomcevak is credited at LOMCEVAK_MAX_ASSISTS or below). */
    assists: 1,
  };
}

/** A held-pass tracker (knife-edge or inverted). */
function createPass() {
  return { time: 0, grace: 0, startAltitude: 0, startHeading: 0, maxAltitudeError: 0, maxHeadingError: 0, bankErrorSum: 0, samples: 0 };
}

/**
 * The recognizer. onFigure(figureId, score, details) is called for every figure recognized; details is
 * a reused object { duration, pitch, roll, yaw, headingChange, heightChange, minAirspeed, maxG, minG }
 * (copy what you keep).
 */
export function createManeuverRecognizer({ onFigure = null } = {}) {
  // Running rotation totals since the last reset (deg, body axes).
  let totalPitch = 0;
  let totalRoll = 0;
  let totalYaw = 0;
  let levelTime = 0;
  let armed = false;
  let inProgress = null;

  /** The last level sample before a figure: its totals, heading and height. */
  const entry = { pitch: 0, roll: 0, yaw: 0, heading: 0, altitude: 0 };
  const figureWindow = {
    open: false,
    time: 0,
    along: 0,
    alongMin: 0,
    alongMax: 0,
    maxAltitude: 0,
    minAltitude: 0,
    maxPitch: 0,
    minPitch: 0,
    minAirspeed: Infinity,
    maxG: 1,
    minG: 1,
    maxPitchDeviation: 0,
    maxAltitudeDeviation: 0,
    maxHeadingDeviation: 0,
    rollSum: 0,
    rollSquares: 0,
    rollSamples: 0,
    slideTime: 0,
    passRecognized: false,
    markerCount: 0,
    markers: new Int8Array(MAX_MARKERS),
    markerAltitudes: new Float64Array(MAX_MARKERS),
  };
  const arm = { up: true, down: true, top: true, slide: true, snap: true, tumble: true };
  const timers = { slide: 0, snap: 0, tumble: 0 };
  const knife = createPass();
  const inverted = createPass();
  const details = { duration: 0, pitch: 0, roll: 0, yaw: 0, headingChange: 0, heightChange: 0, minAirspeed: 0, maxG: 1, minG: 1 };
  const stats = { windows: 0, recognized: 0, aborted: 0, lastFigure: null, lastScore: 0 };

  function resetPass(pass) {
    pass.time = 0;
    pass.grace = 0;
    pass.maxAltitudeError = 0;
    pass.maxHeadingError = 0;
    pass.bankErrorSum = 0;
    pass.samples = 0;
  }

  function closeWindowState() {
    figureWindow.open = false;
    figureWindow.markerCount = 0;
    arm.up = true;
    arm.down = true;
    arm.top = true;
    arm.slide = true;
    arm.snap = true;
    arm.tumble = true;
    timers.slide = 0;
    timers.snap = 0;
    timers.tumble = 0;
  }

  /** Forgets everything in progress (reset, resync after a restore, landing). */
  function reset() {
    levelTime = 0;
    armed = false;
    inProgress = null;
    closeWindowState();
    resetPass(knife);
    resetPass(inverted);
  }

  function addMarker(kind, altitude) {
    if (figureWindow.markerCount >= MAX_MARKERS) return;
    figureWindow.markers[figureWindow.markerCount] = kind;
    figureWindow.markerAltitudes[figureWindow.markerCount] = altitude;
    figureWindow.markerCount++;
  }

  function countMarkers(kind) {
    let count = 0;
    for (let index = 0; index < figureWindow.markerCount; index++) if (figureWindow.markers[index] === kind) count++;
    return count;
  }

  function firstMarker(kind) {
    for (let index = 0; index < figureWindow.markerCount; index++) if (figureWindow.markers[index] === kind) return index;
    return -1;
  }

  function lastMarker(kind) {
    for (let index = figureWindow.markerCount - 1; index >= 0; index--) if (figureWindow.markers[index] === kind) return index;
    return -1;
  }

  function openWindow() {
    closeWindowState();
    figureWindow.open = true;
    figureWindow.time = 0;
    figureWindow.along = 0;
    figureWindow.alongMin = 0;
    figureWindow.alongMax = 0;
    figureWindow.maxAltitude = entry.altitude;
    figureWindow.minAltitude = entry.altitude;
    figureWindow.maxPitch = -90;
    figureWindow.minPitch = 90;
    figureWindow.minAirspeed = Infinity;
    figureWindow.maxG = -Infinity;
    figureWindow.minG = Infinity;
    figureWindow.maxPitchDeviation = 0;
    figureWindow.maxAltitudeDeviation = 0;
    figureWindow.maxHeadingDeviation = 0;
    figureWindow.rollSum = 0;
    figureWindow.rollSquares = 0;
    figureWindow.rollSamples = 0;
    figureWindow.slideTime = 0;
    figureWindow.passRecognized = false;
    stats.windows++;
  }

  /** Sets the markers from this sample (each fires once, then re-arms past its hysteresis). */
  function updateMarkers(pitch, upY, input, rollRate, pitchRate, yawRate, dt) {
    if (arm.up && pitch > VERTICAL.ENTER) {
      addMarker(MARKER.UP, input.altitude);
      arm.up = false;
    } else if (!arm.up && pitch < VERTICAL.REARM) arm.up = true;
    if (arm.down && pitch < -VERTICAL.ENTER) {
      addMarker(MARKER.DOWN, input.altitude);
      arm.down = false;
    } else if (!arm.down && pitch > -VERTICAL.REARM) arm.down = true;
    if (arm.top && upY < TOP.UP_Y && Math.abs(pitch) < TOP.PITCH) {
      addMarker(MARKER.TOP, input.altitude);
      arm.top = false;
    } else if (!arm.top && (upY > TOP.REARM_UP_Y || Math.abs(pitch) > TOP.REARM_PITCH)) arm.top = true;

    const sliding = pitch > SLIDE.PITCH && input.verticalSpeed < -SLIDE.SINK;
    timers.slide = sliding ? timers.slide + dt : 0;
    if (sliding) figureWindow.slideTime += dt;
    if (arm.slide && timers.slide >= SLIDE.SECONDS) {
      addMarker(MARKER.SLIDE, input.altitude);
      arm.slide = false;
    }
    const snapping = input.stalled && Math.abs(rollRate) > SNAP.ROLL_RATE;
    timers.snap = snapping ? timers.snap + dt : 0;
    if (arm.snap && timers.snap >= SNAP.SECONDS) {
      addMarker(MARKER.SNAP, input.altitude);
      arm.snap = false;
    }
    const tumbling = input.stalled && Math.abs(pitchRate) > TUMBLE.PITCH_RATE && Math.abs(yawRate) > TUMBLE.YAW_RATE;
    timers.tumble = tumbling ? timers.tumble + dt : 0;
    if (arm.tumble && timers.tumble >= TUMBLE.SECONDS) {
      addMarker(MARKER.TUMBLE, input.altitude);
      arm.tumble = false;
    }
  }

  function accumulate(input, pitch, upY, rollRate, pitchRate, yawRate, dt) {
    figureWindow.time += dt;
    // Distance flown along the entry heading (through the air, from the nose heading and the path).
    const horizontal = input.airspeed * Math.cos(input.flightPath);
    figureWindow.along += horizontal * Math.cos((input.heading - entry.heading) / RAD) * dt;
    figureWindow.alongMin = Math.min(figureWindow.alongMin, figureWindow.along);
    figureWindow.alongMax = Math.max(figureWindow.alongMax, figureWindow.along);
    figureWindow.maxAltitude = Math.max(figureWindow.maxAltitude, input.altitude);
    figureWindow.minAltitude = Math.min(figureWindow.minAltitude, input.altitude);
    figureWindow.maxPitch = Math.max(figureWindow.maxPitch, pitch);
    figureWindow.minPitch = Math.min(figureWindow.minPitch, pitch);
    figureWindow.minAirspeed = Math.min(figureWindow.minAirspeed, input.airspeed);
    figureWindow.maxG = Math.max(figureWindow.maxG, input.gLoad);
    figureWindow.minG = Math.min(figureWindow.minG, input.gLoad);
    figureWindow.maxPitchDeviation = Math.max(figureWindow.maxPitchDeviation, Math.abs(pitch));
    figureWindow.maxAltitudeDeviation = Math.max(figureWindow.maxAltitudeDeviation, Math.abs(input.altitude - entry.altitude));
    if (Math.abs(pitch) < 60) figureWindow.maxHeadingDeviation = Math.max(figureWindow.maxHeadingDeviation, Math.abs(wrap180(input.heading - entry.heading)));
    if (Math.abs(rollRate) > ROLLING_RATE) {
      figureWindow.rollSum += Math.abs(rollRate);
      figureWindow.rollSquares += rollRate * rollRate;
      figureWindow.rollSamples++;
    }
    updateMarkers(pitch, upY, input, rollRate, pitchRate, yawRate, dt);
  }

  // ---- Classification -------------------------------------------------------------------------------
  /** The figure the closed window is (or null), from its totals and markers, in priority order. */
  function classify(summary, assists) {
    const { pitch, roll, yaw, headingChange, heightChange, duration } = summary;
    const absRoll = Math.abs(roll);
    const turnedAround = Math.abs(headingChange) >= 145;
    const sameHeading = (limit) => Math.abs(headingChange) <= limit;
    const up = firstMarker(MARKER.UP);
    const down = firstMarker(MARKER.DOWN);
    const top = firstMarker(MARKER.TOP);
    const has = (kind) => firstMarker(kind) >= 0;

    if (has(MARKER.TUMBLE) && Math.abs(pitch) + Math.abs(yaw) >= 360) return assists <= LOMCEVAK_MAX_ASSISTS ? 'lomcevak' : null;
    if (up >= 0 && has(MARKER.SLIDE) && lastMarker(MARKER.DOWN) > firstMarker(MARKER.SLIDE)) return 'tailslide';
    if (has(MARKER.SNAP) && absRoll >= 250 && absRoll <= 470 && duration < 5 && up < 0 && down < 0) return 'snapRoll';
    if (up >= 0 && down > up && top < 0 && Math.abs(yaw) >= 120 && turnedAround) return 'hammerhead';
    if (countMarkers(MARKER.UP) >= 2 && countMarkers(MARKER.TOP) >= 2 && pitch >= 430 && pitch <= 680 && sameHeading(40)) return 'cubanEight';
    if (pitch >= 290 && pitch <= 430 && absRoll <= 60 && up >= 0 && top > up && down > top && sameHeading(35)) return 'loop';
    if (pitch >= 130 && pitch <= 240 && absRoll >= 130 && absRoll <= 230 && turnedAround) {
      if (up >= 0 && top > up && down < 0 && heightChange > 40) return 'immelmann';
      if (top >= 0 && down > top && (up < 0 || up > top) && heightChange < -40) return 'splitS';
    }
    if (absRoll >= 290 && absRoll <= 440 && pitch >= 90 && pitch <= 450 && top >= 0 && up < 0 && down < 0 && summary.minG > 0.1 && sameHeading(45) && duration < 12) return 'barrelRoll';
    const rolls = Math.round(absRoll / 360);
    if (rolls >= 1 && rolls <= 3 && Math.abs(absRoll - rolls * 360) <= 60 && Math.abs(pitch) <= 80 && up < 0 && down < 0 && duration <= 4 + 2 * rolls && sameHeading(30)) return 'aileronRoll';
    return null;
  }

  /** The precision score (0-100) of a figure from its figureWindow. */
  function scoreFigure(figure, summary) {
    const absRoll = Math.abs(summary.roll);
    const headingError = Math.abs(summary.headingChange);
    const reverseError = Math.abs(wrap180(summary.headingChange - 180));
    const heightError = Math.abs(summary.heightChange);
    switch (figure) {
      case 'loop': {
        // Round: as tall as it is long; out on the entry heading and height, wings level throughout.
        const height = figureWindow.maxAltitude - entry.altitude;
        const length = figureWindow.alongMax - figureWindow.alongMin;
        const roundness = length > 1 ? Math.abs(height / length - 1) : 0;
        return clampScore(100 - over(headingError, 4, 1.2) - over(heightError, 15, 0.3) - Math.min(30, roundness * 45) - over(absRoll, 10, 0.5));
      }
      case 'aileronRoll': {
        // On the heading and the height, the nose on the horizon, an even roll rate, a crisp stop.
        const rolls = Math.max(1, Math.round(absRoll / 360));
        const meanRate = figureWindow.rollSamples > 0 ? figureWindow.rollSum / figureWindow.rollSamples : 0;
        const variance = figureWindow.rollSamples > 0 ? Math.max(0, figureWindow.rollSquares / figureWindow.rollSamples - meanRate * meanRate) : 0;
        const unevenness = meanRate > 0 ? Math.sqrt(variance) / meanRate : 0;
        return clampScore(100 - over(figureWindow.maxHeadingDeviation, 3, 1.5) - over(figureWindow.maxAltitudeDeviation, 8, 0.6) - over(figureWindow.maxPitchDeviation, 6, 1.2)
          - Math.min(20, unevenness * 40) - Math.abs(absRoll - rolls * 360) * 0.4);
      }
      case 'barrelRoll':
        return clampScore(100 - over(headingError, 6, 1) - over(heightError, 20, 0.25) - Math.abs(absRoll - 360) * 0.3 - Math.max(0, 0.6 - summary.minG) * 25);
      case 'immelmann':
      case 'splitS':
        return clampScore(100 - over(reverseError, 5, 1.2) - Math.abs(absRoll - 180) * 0.4 - Math.abs(summary.pitch - 180) * 0.25);
      case 'cubanEight': {
        const firstTop = firstMarker(MARKER.TOP);
        const secondTop = lastMarker(MARKER.TOP);
        const symmetry = Math.abs(figureWindow.markerAltitudes[firstTop] - figureWindow.markerAltitudes[secondTop]);
        return clampScore(100 - over(headingError, 6, 1) - over(heightError, 25, 0.25) - over(symmetry, 10, 0.3) - Math.abs(summary.pitch - 540) * 0.1);
      }
      case 'hammerhead':
        // Truly vertical up and down lines, a tight pivot (slow at the top), no roll.
        return clampScore(100 - over(reverseError, 6, 1) - over(88 - figureWindow.maxPitch, 0, 1.2) - over(88 + figureWindow.minPitch, 0, 1.2)
          - over(figureWindow.minAirspeed, 8, 1.5) - over(absRoll, 15, 0.4));
      case 'tailslide': {
        const exitError = Math.min(headingError, reverseError);
        return clampScore(100 - over(85 - figureWindow.maxPitch, 0, 1.2) - Math.max(0, 1 - figureWindow.slideTime) * 25 - over(exitError, 8, 0.8) - over(absRoll, 20, 0.3));
      }
      case 'snapRoll':
        return clampScore(100 - over(headingError, 8, 1) - over(figureWindow.maxAltitudeDeviation, 20, 0.3) - Math.abs(absRoll - 360) * 0.4);
      case 'lomcevak': {
        const heightLoss = Math.max(0, -summary.heightChange);
        const rotation = Math.abs(summary.pitch) + Math.abs(summary.yaw);
        return clampScore(100 - over(heightLoss, 80, 0.15) - Math.max(0, 540 - rotation) * 0.05);
      }
      default:
        return 0;
    }
  }

  function fillDetails(duration, headingChange, heightChange) {
    details.duration = duration;
    details.pitch = totalPitch - entry.pitch;
    details.roll = totalRoll - entry.roll;
    details.yaw = totalYaw - entry.yaw;
    details.headingChange = headingChange;
    details.heightChange = heightChange;
    details.minAirspeed = Number.isFinite(figureWindow.minAirspeed) ? figureWindow.minAirspeed : 0;
    details.maxG = Number.isFinite(figureWindow.maxG) ? figureWindow.maxG : 1;
    details.minG = Number.isFinite(figureWindow.minG) ? figureWindow.minG : 1;
    return details;
  }

  function recognize(figure, score, summary) {
    stats.recognized++;
    stats.lastFigure = figure;
    stats.lastScore = score;
    if (onFigure) onFigure(figure, score, summary);
  }

  function closeWindow(input) {
    const summary = fillDetails(figureWindow.time, wrap180(input.heading - entry.heading), input.altitude - entry.altitude);
    const figure = figureWindow.passRecognized ? null : classify(summary, input.assists);
    closeWindowState();
    if (figure) recognize(figure, scoreFigure(figure, summary), summary);
  }

  // ---- Held passes ------------------------------------------------------------------------------------
  function updatePass(pass, holding, bankError, input, dt, figure) {
    if (holding) {
      if (pass.time === 0) {
        pass.startAltitude = input.altitude;
        pass.startHeading = input.heading;
      }
      pass.time += dt;
      pass.grace = 0;
      pass.maxAltitudeError = Math.max(pass.maxAltitudeError, Math.abs(input.altitude - pass.startAltitude));
      pass.maxHeadingError = Math.max(pass.maxHeadingError, Math.abs(wrap180(input.heading - pass.startHeading)));
      pass.bankErrorSum += bankError;
      pass.samples++;
      return;
    }
    if (pass.time === 0) return;
    pass.grace += dt;
    if (pass.grace < PASS.GRACE) return;
    if (pass.time >= PASS.SECONDS) {
      const meanBankError = pass.samples > 0 ? pass.bankErrorSum / pass.samples : 0;
      const score = clampScore(100 - over(pass.maxAltitudeError, 4, 2) - over(pass.maxHeadingError, 4, 1.5) - over(meanBankError, 3, 2) - Math.max(0, 4 - pass.time) * 5);
      const summary = fillDetails(pass.time, wrap180(input.heading - pass.startHeading), input.altitude - pass.startAltitude);
      if (figureWindow.open) figureWindow.passRecognized = true;
      recognize(figure, score, summary);
    }
    resetPass(pass);
  }

  function updatePasses(input, pitch, bank, dt) {
    const steady = Math.abs(pitch) < PASS.PITCH && Math.abs(input.verticalSpeed) < PASS.VERTICAL_SPEED && input.airspeed > PASS.MIN_AIRSPEED;
    const absBank = Math.abs(bank);
    updatePass(knife, steady && absBank >= PASS.KNIFE_BANK_MIN && absBank <= PASS.KNIFE_BANK_MAX, Math.abs(absBank - 90), input, dt, 'knifeEdge');
    updatePass(inverted, steady && absBank >= PASS.INVERTED_BANK, 180 - absBank, input, dt, 'invertedPass');
  }

  /** The figure the open window looks like so far (contract h.3 figureInProgress). */
  function guessInProgress() {
    if (knife.time >= 1) return 'knifeEdge';
    if (inverted.time >= 1) return 'invertedPass';
    if (!figureWindow.open) return null;
    const pitch = totalPitch - entry.pitch;
    const absRoll = Math.abs(totalRoll - entry.roll);
    const yaw = Math.abs(totalYaw - entry.yaw);
    const up = firstMarker(MARKER.UP) >= 0;
    const top = firstMarker(MARKER.TOP) >= 0;
    if (firstMarker(MARKER.TUMBLE) >= 0) return 'lomcevak';
    if (firstMarker(MARKER.SNAP) >= 0) return 'snapRoll';
    if (up && firstMarker(MARKER.SLIDE) >= 0) return 'tailslide';
    if (up && yaw > 60 && !top) return 'hammerhead';
    if (countMarkers(MARKER.UP) >= 2) return 'cubanEight';
    if (up && top) return absRoll > 120 ? 'immelmann' : 'loop';
    if (top && firstMarker(MARKER.DOWN) >= 0 && absRoll > 120) return 'splitS';
    if (up || pitch > 90) return 'loop';
    if (absRoll > 60) return pitch > 60 ? 'barrelRoll' : 'aileronRoll';
    return null;
  }

  return {
    FIGURES,

    /** One physics tick of flight. */
    sample(input) {
      const dt = input.dt;
      if (!(dt > 0)) return;
      const pitch = input.pitch * RAD;
      const bank = input.bank * RAD;
      const rollRate = input.rollRate * RAD;
      const pitchRate = input.pitchRate * RAD;
      const yawRate = input.yawRate * RAD;
      if (input.onGround || !Number.isFinite(pitch) || !Number.isFinite(bank) || !Number.isFinite(rollRate) || !Number.isFinite(input.altitude)) {
        reset();
        return;
      }
      totalPitch += pitchRate * dt;
      totalRoll += rollRate * dt;
      totalYaw += yawRate * dt;
      const upY = Math.cos(input.pitch) * Math.cos(input.bank);
      updatePasses(input, pitch, bank, dt);

      const rate = Math.hypot(rollRate, pitchRate, yawRate);
      const level = Math.abs(pitch) < LEVEL.PITCH && Math.abs(bank) < LEVEL.BANK && rate < LEVEL.RATE && input.airspeed > MIN_AIRSPEED;
      levelTime = level ? levelTime + dt : 0;

      if (figureWindow.open) {
        accumulate(input, pitch, upY, rollRate, pitchRate, yawRate, dt);
        if (level && levelTime >= LEVEL.EXIT_SECONDS) {
          closeWindow(input);
        } else if (figureWindow.time > WINDOW_MAX_SECONDS) {
          stats.aborted++;
          closeWindowState();
          armed = false;
        }
      } else if (level) {
        if (levelTime >= LEVEL.ENTRY_SECONDS) {
          armed = true;
          entry.pitch = totalPitch;
          entry.roll = totalRoll;
          entry.yaw = totalYaw;
          entry.heading = input.heading;
          entry.altitude = input.altitude;
        }
      } else if (armed && (Math.abs(bank) > DEPARTURE.BANK || Math.abs(pitch) > DEPARTURE.PITCH || rate > DEPARTURE.RATE)) {
        armed = false;
        openWindow();
        accumulate(input, pitch, upY, rollRate, pitchRate, yawRate, dt);
      }
      inProgress = guessInProgress();
    },

    reset,

    /** The figure the flight looks like so far (an id from FIGURE_IDS), or null. */
    get figureInProgress() {
      return inProgress;
    },

    /** True while a figure window is open. */
    get windowOpen() {
      return figureWindow.open;
    },

    /** { windows, recognized, aborted, lastFigure, lastScore } (tests and the lab). */
    get stats() {
      return stats;
    },
  };
}
