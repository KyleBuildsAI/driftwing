// Wind-layer column (hot air balloon): the WindField sampled at every band of height above the ground
// below the balloon (state.flight.craftState.windColumn, refreshed once a second by the balloon's
// burner ability and smoothed), highest band at the top. Each row shows the band's altitude, an
// arrow pointing where its wind goes (north up) and its speed with a bar. A balloon goes where the
// wind at its height goes, so steering means picking a row: the triangle on the left is the
// balloon's own altitude, the band it is in is lit, and the band the altitude hold or the autopilot
// is taking it to is outlined in gold. The header shows the ground track.
import { dialAngle, drawPlate, label, roundRect, clamp } from './gaugeKit.js';
import { grouped } from './units.js';

const TOP = 38;
const BOTTOM = 176;
const ARROW_X = 92;
const BAR_LEFT = 110;
const BAR_RIGHT = 182;
/** Bars are full at this wind speed (m/s). */
const BAR_FULL = 15;

function drawArrow(pen, x, y, towardDegrees, size, colour) {
  const angle = dialAngle(towardDegrees);
  pen.save();
  pen.translate(x, y);
  pen.rotate(angle);
  pen.beginPath();
  pen.moveTo(size, 0);
  pen.lineTo(-size * 0.7, -size * 0.6);
  pen.lineTo(-size * 0.35, 0);
  pen.lineTo(-size * 0.7, size * 0.6);
  pen.closePath();
  pen.fillStyle = colour;
  pen.fill();
  pen.restore();
}

/** The row (fractional, 0 = the top row) of an altitude among the bands (highest first). */
function rowOf(column, altitude) {
  const count = column.length;
  for (let index = 0; index < count - 1; index++) {
    const upper = column[count - 1 - index];
    const lower = column[count - 2 - index];
    if (altitude >= lower.altitude) return index + clamp((upper.altitude - altitude) / Math.max(upper.altitude - lower.altitude, 1), 0, 1);
  }
  return count - 1;
}

export default Object.freeze({
  id: 'windColumn',
  label: 'Wind layers',
  draw(pen, source, theme) {
    const { flight, units } = source;
    const craftState = flight.craftState || {};
    const column = Array.isArray(craftState.windColumn) ? craftState.windColumn : [];
    drawPlate(pen, theme);
    label(pen, 'WIND LAYERS', 22, 26, { size: 11, color: theme.textDim, weight: 650, spacing: 1.4, align: 'left' });
    const groundSpeed = Number.isFinite(flight.groundSpeed) ? flight.groundSpeed : 0;
    if (groundSpeed > 0.3 && flight.velocity) {
      const track = Math.round(((Math.atan2(flight.velocity.x, -flight.velocity.z) / Math.PI) * 180 + 360) % 360);
      label(pen, `TRK ${String(track).padStart(3, '0')}°`, 180, 26, { size: 11, color: theme.text, weight: 650, align: 'right' });
    }
    if (column.length === 0 || !column[0].primed) {
      label(pen, 'SAMPLING', 100, 112, { size: 13, color: theme.textDim, weight: 700, spacing: 1.6 });
      return;
    }
    const count = column.length;
    const rowHeight = (BOTTOM - TOP) / count;
    const altitude = Number.isFinite(flight.altitude) ? flight.altitude : column[0].altitude;
    const here = rowOf(column, altitude);
    const target = Number.isFinite(craftState.altitudeHold) ? craftState.altitudeHold : flight.autopilot && flight.autopilot.enabled ? flight.autopilot.altitude : null;
    const targetRow = Number.isFinite(target) ? Math.round(rowOf(column, target)) : -1;
    const speedFactor = units.speed.factor;
    for (let row = 0; row < count; row++) {
      const band = column[count - 1 - row];
      const y = TOP + row * rowHeight;
      const middle = y + rowHeight / 2;
      if (Math.round(here) === row) {
        pen.fillStyle = theme.id === 'panel' ? 'rgba(108, 198, 201, 0.16)' : 'rgba(143, 211, 214, 0.18)';
        roundRect(pen, 30, y + 1, 154, rowHeight - 2, 3);
        pen.fill();
      }
      if (row === targetRow) {
        pen.strokeStyle = theme.id === 'panel' ? '#f3c77a' : theme.yellow;
        pen.lineWidth = 1.5;
        roundRect(pen, 30, y + 1, 154, rowHeight - 2, 3);
        pen.stroke();
      }
      label(pen, grouped(band.altitude * units.altitude.factor), 72, middle, { size: 10, color: theme.text, weight: 600, align: 'right' });
      drawArrow(pen, ARROW_X, middle, band.towardDegrees, Math.min(7, rowHeight * 0.42), band.speed > 0.3 ? theme.needle : theme.textDim);
      const share = clamp(band.speed / BAR_FULL, 0, 1);
      pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.3)';
      roundRect(pen, BAR_LEFT, middle - 3, BAR_RIGHT - BAR_LEFT, 6, 3);
      pen.fill();
      pen.fillStyle = theme.teal;
      roundRect(pen, BAR_LEFT, middle - 3, Math.max(4, (BAR_RIGHT - BAR_LEFT) * share), 6, 3);
      pen.fill();
      label(pen, String(Math.round(band.speed * speedFactor)), BAR_RIGHT, middle - 0.5, { size: 9, color: theme.text, weight: 650, align: 'right' });
    }
    // The balloon's own altitude: a triangle on the left edge.
    const markerY = TOP + (here + 0.5) * rowHeight;
    pen.beginPath();
    pen.moveTo(28, markerY);
    pen.lineTo(19, markerY - 5);
    pen.lineTo(19, markerY + 5);
    pen.closePath();
    pen.fillStyle = theme.accent;
    pen.fill();
    label(pen, units.speed.label.toUpperCase(), 182, BOTTOM + 6, { size: 8, color: theme.textDim, weight: 650, align: 'right', spacing: 0.8 });
  },
});
