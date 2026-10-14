// Nacelle angle and the conversion corridor (tiltrotor). A chart of nacelle angle (up the side: 0
// airplane mode at the bottom, the 97 degree stop at the top, ticks at the 0 / 60 / 90 detents)
// against true airspeed (across, 0-160 m/s in the player's units): the safe band between the
// corridor's edges (src/flight/tiltrotorCorridor.js, at the current air density), the wing-stall
// region below it and the rotor-overspeed region above it. The craft is the dot (airspeed, nacelle
// angle); the pilot's selection is the open marker on the right edge, the commanded angle (after the
// auto-nacelle schedule) a short bar. The readout shows the angle, AUTO while the schedule runs, and
// the corridor state, flashing outside it. Reads state.flight.craftState (nacelleAngle,
// nacelleTarget, nacelleCommand, autoNacelle, corridor) and the craft's simProfile.
import { CENTER, drawPlate, label, digital, roundRect, lamp, clamp } from './gaugeKit.js';
import { NACELLE, corridorParameters, conversionCorridor } from '../../flight/tiltrotorCorridor.js';

const CHART = Object.freeze({ LEFT: 34, RIGHT: 178, TOP: 56, BOTTOM: 150 });
const MAX_SPEED = 160;
const SAMPLES = 33;
const SEA_LEVEL_DENSITY = 1.225;
const DENSITY_SCALE_HEIGHT = 8500;
/** The corridor curves are rebuilt when the air density changes by this share. */
const DENSITY_STEP = 0.01;
const parameterCache = new WeakMap();

function parametersFor(craft) {
  if (!craft || !craft.simProfile || !craft.simProfile.wing) return null;
  let parameters = parameterCache.get(craft);
  if (!parameters) {
    parameters = corridorParameters(craft.simProfile);
    parameterCache.set(craft, parameters);
  }
  return parameters;
}

const xFor = (speed) => CHART.LEFT + (clamp(speed, 0, MAX_SPEED) / MAX_SPEED) * (CHART.RIGHT - CHART.LEFT);
const yFor = (angle) => CHART.BOTTOM - (clamp(angle, NACELLE.MIN, NACELLE.MAX) / NACELLE.MAX) * (CHART.BOTTOM - CHART.TOP);

export default Object.freeze({
  id: 'nacelle',
  label: 'Nacelle and conversion corridor',
  createMemory() {
    return { minimum: new Float32Array(SAMPLES), maximum: new Float32Array(SAMPLES), density: NaN, parameters: null, blink: 0, corridor: { min: 0, max: NACELLE.MAX } };
  },
  reset(memory) {
    memory.density = NaN;
    memory.parameters = null;
    memory.blink = 0;
  },
  update(memory, dt, source) {
    memory.blink = (memory.blink + dt) % 1;
    const parameters = parametersFor(source.craft);
    const altitude = Number.isFinite(source.flight.altitude) ? source.flight.altitude : 0;
    const density = SEA_LEVEL_DENSITY * Math.exp(-Math.max(altitude, -500) / DENSITY_SCALE_HEIGHT);
    if (!parameters || (parameters === memory.parameters && Math.abs(density - memory.density) < DENSITY_STEP * memory.density)) return;
    memory.parameters = parameters;
    memory.density = density;
    for (let index = 0; index < SAMPLES; index++) {
      conversionCorridor((index / (SAMPLES - 1)) * MAX_SPEED, density, parameters, memory.corridor);
      memory.minimum[index] = memory.corridor.min;
      memory.maximum[index] = memory.corridor.max;
    }
  },
  draw(pen, source, theme, memory) {
    const { flight, units } = source;
    const craftState = flight.craftState ?? {};
    const angle = Number.isFinite(craftState.nacelleAngle) ? craftState.nacelleAngle : NACELLE.HOVER;
    const selection = Number.isFinite(craftState.nacelleTarget) ? craftState.nacelleTarget : angle;
    const command = Number.isFinite(craftState.nacelleCommand) ? craftState.nacelleCommand : selection;
    const corridorState = craftState.corridor && typeof craftState.corridor.state === 'string' ? craftState.corridor.state : 'ok';
    const airspeed = Number.isFinite(flight.airspeed) ? flight.airspeed : 0;
    drawPlate(pen, theme);
    label(pen, 'NACELLE', 22, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6, align: 'left' });
    digital(pen, `${Math.round(angle)}°`, 112, 18, 66, 26, theme, { size: 18 });
    lamp(pen, 100, 31, 5, craftState.autoNacelle === true, theme.green, theme);
    label(pen, 'AUTO', 92, 31, { size: 8, color: theme.textDim, weight: 700, align: 'right' });

    // The regions: overspeed above the corridor, wing stall below it, the safe band between.
    const back = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.3)';
    pen.fillStyle = back;
    roundRect(pen, CHART.LEFT, CHART.TOP, CHART.RIGHT - CHART.LEFT, CHART.BOTTOM - CHART.TOP, 4);
    pen.fill();
    if (memory.parameters) {
      pen.globalAlpha = 0.55;
      pen.fillStyle = theme.red;
      pen.beginPath();
      pen.moveTo(CHART.LEFT, CHART.TOP);
      for (let index = 0; index < SAMPLES; index++) pen.lineTo(xFor((index / (SAMPLES - 1)) * MAX_SPEED), yFor(memory.maximum[index]));
      pen.lineTo(CHART.RIGHT, CHART.TOP);
      pen.closePath();
      pen.fill();
      pen.fillStyle = theme.yellow;
      pen.beginPath();
      pen.moveTo(CHART.LEFT, CHART.BOTTOM);
      for (let index = 0; index < SAMPLES; index++) pen.lineTo(xFor((index / (SAMPLES - 1)) * MAX_SPEED), yFor(memory.minimum[index]));
      pen.lineTo(CHART.RIGHT, CHART.BOTTOM);
      pen.closePath();
      pen.fill();
      pen.globalAlpha = 0.35;
      pen.fillStyle = theme.green;
      pen.beginPath();
      for (let index = 0; index < SAMPLES; index++) pen.lineTo(xFor((index / (SAMPLES - 1)) * MAX_SPEED), yFor(memory.maximum[index]));
      for (let index = SAMPLES - 1; index >= 0; index--) pen.lineTo(xFor((index / (SAMPLES - 1)) * MAX_SPEED), yFor(memory.minimum[index]));
      pen.closePath();
      pen.fill();
      pen.globalAlpha = 1;
    }
    // Detent ticks and the speed scale.
    pen.strokeStyle = theme.tick;
    pen.lineWidth = 1.2;
    pen.beginPath();
    for (const detent of NACELLE.DETENTS) {
      pen.moveTo(CHART.LEFT - 5, yFor(detent));
      pen.lineTo(CHART.LEFT, yFor(detent));
    }
    for (let speed = 0; speed <= MAX_SPEED; speed += 40) {
      pen.moveTo(xFor(speed), CHART.BOTTOM);
      pen.lineTo(xFor(speed), CHART.BOTTOM + 4);
    }
    pen.stroke();
    for (const detent of NACELLE.DETENTS) label(pen, String(detent), CHART.LEFT - 7, yFor(detent), { size: 9, color: theme.text, weight: 650, align: 'right' });
    const factor = units.speed.factor;
    for (let speed = 40; speed <= MAX_SPEED; speed += 40) label(pen, String(Math.round(speed * factor)), xFor(speed), CHART.BOTTOM + 11, { size: 8.5, color: theme.textDim, weight: 600 });
    label(pen, units.speed.label, CHART.LEFT - 4, CHART.BOTTOM + 11, { size: 8, color: theme.textDim, weight: 650, align: 'right' });

    // Selection (open marker on the right edge), command (bar), the craft (dot).
    const selectionY = yFor(selection);
    pen.strokeStyle = theme.text;
    pen.lineWidth = 1.6;
    pen.beginPath();
    pen.moveTo(CHART.RIGHT + 9, selectionY - 5);
    pen.lineTo(CHART.RIGHT + 2, selectionY);
    pen.lineTo(CHART.RIGHT + 9, selectionY + 5);
    pen.closePath();
    pen.stroke();
    pen.fillStyle = theme.pointer;
    pen.fillRect(CHART.RIGHT - 9, yFor(command) - 1.2, 9, 2.4);
    const dotX = xFor(airspeed);
    const dotY = yFor(angle);
    pen.beginPath();
    pen.arc(dotX, dotY, 4.6, 0, Math.PI * 2);
    pen.fillStyle = corridorState === 'ok' ? theme.needle : theme.red;
    pen.fill();
    pen.strokeStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.6)';
    pen.lineWidth = 1.4;
    pen.stroke();

    // Corridor state.
    const outside = corridorState !== 'ok';
    const text = corridorState === 'wingStall' ? 'WING STALL' : corridorState === 'overspeed' ? 'ROTOR OVERSPEED' : 'CORRIDOR';
    if (outside && memory.blink < 0.6) {
      pen.fillStyle = theme.red;
      roundRect(pen, 28, 168, 144, 22, 5);
      pen.fill();
      label(pen, text, CENTER, 179, { size: 12, color: '#fff7ee', weight: 800, spacing: 1.4 });
    } else if (!outside) {
      label(pen, text, CENTER, 179, { size: 10, color: theme.textDim, weight: 700, spacing: 1.6 });
    }
  },
});
