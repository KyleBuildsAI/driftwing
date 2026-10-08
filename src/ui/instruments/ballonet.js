// Ballonet and vector panel (the airship). Left: the ballonet fill on a vertical scale (full is heavy,
// empty is light, the middle is neutral) with the lever's target as a hollow marker while the blowers
// catch up. Top right: the static heaviness (kg, or NEUTRAL; amber past 100 kg, red above the
// pressure height, where the airship turns heavy whatever the trim). Right: the propeller pods seen
// from the side, the thrust line at the vector angle (45 degrees down to 120 degrees up and back).
// Bottom: the pressure height, or the scenic cruise's next site and its distance while it flies.
// Reads state.flight.craftState: ballonet, ballonetTarget, heaviness, pressureHeight, vectorAngle,
// vectorTarget, scenicCruise.
import { drawPlate, label, digital, clamp } from './gaugeKit.js';
import { grouped } from './units.js';

const SCALE = Object.freeze({ x: 40, top: 44, bottom: 150, width: 16 });
const POD = Object.freeze({ x: 136, y: 112, radius: 38 });
const VECTOR_TICKS = Object.freeze([-45, 0, 45, 90, 120]);
const DEG = Math.PI / 180;
const HEAVY_WARNING = 100;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Screen direction of a thrust line at a vector angle (nose to the left, up is up). */
function thrustX(angle) {
  return -Math.cos(angle * DEG);
}
function thrustY(angle) {
  return -Math.sin(angle * DEG);
}

function drawBallonetScale(pen, theme, fill, target) {
  const height = SCALE.bottom - SCALE.top;
  label(pen, 'BALLONET', SCALE.x + 8, 30, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
  pen.fillStyle = theme.digitalBack;
  pen.fillRect(SCALE.x, SCALE.top, SCALE.width, height);
  const fillTop = SCALE.bottom - clamp(fill, 0, 1) * height;
  pen.fillStyle = theme.teal;
  pen.fillRect(SCALE.x + 2, fillTop, SCALE.width - 4, SCALE.bottom - fillTop);
  pen.strokeStyle = theme.tick;
  pen.lineWidth = 2;
  pen.beginPath();
  for (const share of [0, 0.25, 0.5, 0.75, 1]) {
    const y = SCALE.bottom - share * height;
    pen.moveTo(SCALE.x - (share === 0.5 ? 9 : 5), y);
    pen.lineTo(SCALE.x, y);
  }
  pen.stroke();
  label(pen, 'HVY', SCALE.x - 4, SCALE.top - 1, { size: 9.5, color: theme.textDim, weight: 650, align: 'right' });
  label(pen, 'N', SCALE.x - 12, SCALE.top + height / 2, { size: 10.5, color: theme.text, weight: 700, align: 'right' });
  label(pen, 'LT', SCALE.x - 4, SCALE.bottom + 1, { size: 9.5, color: theme.textDim, weight: 650, align: 'right' });
  // The lever's target: a hollow pointer beside the scale.
  const y = SCALE.bottom - clamp(target, 0, 1) * height;
  pen.strokeStyle = theme.pointer;
  pen.lineWidth = 2;
  pen.beginPath();
  pen.moveTo(SCALE.x + SCALE.width + 3, y);
  pen.lineTo(SCALE.x + SCALE.width + 14, y - 6);
  pen.lineTo(SCALE.x + SCALE.width + 14, y + 6);
  pen.closePath();
  pen.stroke();
}

function drawVector(pen, theme, angle, target) {
  label(pen, 'VECTOR', POD.x, 70, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
  pen.strokeStyle = theme.tick;
  pen.lineWidth = 2;
  pen.beginPath();
  for (const tick of VECTOR_TICKS) {
    pen.moveTo(POD.x + thrustX(tick) * (POD.radius - 6), POD.y + thrustY(tick) * (POD.radius - 6));
    pen.lineTo(POD.x + thrustX(tick) * POD.radius, POD.y + thrustY(tick) * POD.radius);
  }
  pen.stroke();
  pen.beginPath();
  // The swivel range as an arc: a thrust line at angle a points at canvas angle PI + a.
  pen.arc(POD.x, POD.y, POD.radius, Math.PI + VECTOR_TICKS[0] * DEG, Math.PI + VECTOR_TICKS[VECTOR_TICKS.length - 1] * DEG, false);
  pen.strokeStyle = theme.faceEdge || theme.tick;
  pen.lineWidth = 1;
  pen.stroke();
  // The target as a thin line, the pods' thrust line as the pointer, the pod as a small nacelle.
  pen.strokeStyle = theme.textDim;
  pen.lineWidth = 1.5;
  pen.beginPath();
  pen.moveTo(POD.x, POD.y);
  pen.lineTo(POD.x + thrustX(target) * (POD.radius - 2), POD.y + thrustY(target) * (POD.radius - 2));
  pen.stroke();
  pen.strokeStyle = theme.pointer;
  pen.lineWidth = 4;
  pen.lineCap = 'round';
  pen.beginPath();
  pen.moveTo(POD.x - thrustX(angle) * 10, POD.y - thrustY(angle) * 10);
  pen.lineTo(POD.x + thrustX(angle) * (POD.radius - 8), POD.y + thrustY(angle) * (POD.radius - 8));
  pen.stroke();
  pen.lineCap = 'butt';
  pen.fillStyle = theme.needle;
  pen.beginPath();
  pen.arc(POD.x, POD.y, 5, 0, Math.PI * 2);
  pen.fill();
  label(pen, `${Math.round(angle)}°`, POD.x + 6, POD.y + 22, { size: 12, color: theme.text, weight: 700, align: 'left' });
}

export default Object.freeze({
  id: 'ballonet',
  label: 'Ballonet and vector',
  draw(pen, source, theme) {
    const craftState = source.flight.craftState || {};
    drawPlate(pen, theme);
    const fill = finite(craftState.ballonet, 0.5);
    drawBallonetScale(pen, theme, fill, finite(craftState.ballonetTarget, fill));
    const heaviness = finite(craftState.heaviness, 0);
    const pressureHeight = finite(craftState.pressureHeight, NaN);
    const abovePressure = Number.isFinite(pressureHeight) && source.flight.altitude > pressureHeight;
    const heavyText = Math.abs(heaviness) < 15 ? 'NEUTRAL' : `${heaviness > 0 ? '+' : '-'}${grouped(Math.abs(heaviness))} kg ${heaviness > 0 ? 'HVY' : 'LT'}`;
    const heavyColor = abovePressure ? theme.red : Math.abs(heaviness) > HEAVY_WARNING ? theme.yellow : null;
    digital(pen, heavyText, 76, 26, 106, 22, theme, { color: heavyColor, size: 12.5 });
    const angle = finite(craftState.vectorAngle, 0);
    drawVector(pen, theme, angle, finite(craftState.vectorTarget, angle));
    const cruise = craftState.scenicCruise;
    const next = cruise && cruise.active ? cruise.waypoints[cruise.index] : null;
    let footer;
    if (next) {
      const position = source.flight.position;
      const metres = Math.hypot(next.x - position.x, next.z - position.z);
      footer = `${cruise.visited + 1}/${cruise.visited + cruise.waypoints.length - cruise.index} ${next.name.toUpperCase().slice(0, 14)} ${(metres / 1000).toFixed(1)} km`;
    } else {
      const altitude = source.units.altitude;
      footer = Number.isFinite(pressureHeight) ? `PRESS HT ${grouped(pressureHeight * altitude.factor)} ${altitude.label}` : 'PRESS HT --';
    }
    digital(pen, footer, 20, 164, 160, 20, theme, { color: abovePressure && !next ? theme.red : null, size: 10.5 });
  },
});
