// Apogee display (spaceplane): the ballistic apogee prediction (state.flight.craftState.apogee, null
// while descending) in large digits, the altitude below it, and an altitude column from the ground to
// 150 km with the edge of space (100 km) marked, the craft's altitude as a bar and the predicted apogee
// as a caret. Kilometres, or thousands of feet with aviation units.
import { drawPlate, label, digital, roundRect, clamp } from './gaugeKit.js';

const COLUMN_TOP = 150000;
const SPACE = 100000;
const COLUMN = Object.freeze({ x: 150, y: 34, width: 22, height: 144 });

function columnY(altitude) {
  return COLUMN.y + COLUMN.height * (1 - clamp(altitude / COLUMN_TOP, 0, 1));
}

export default Object.freeze({
  id: 'apogee',
  label: 'Apogee',
  draw(pen, source, theme) {
    const { flight, units } = source;
    const craftState = flight.craftState || {};
    const scale = units.altitude.factor / 1000;
    const unit = units.system === 'aviation' ? 'KFT' : 'KM';
    const apogee = Number.isFinite(craftState.apogee) ? craftState.apogee : null;
    const altitude = Number.isFinite(flight.altitude) ? Math.max(flight.altitude, 0) : 0;
    drawPlate(pen, theme);
    label(pen, 'APOGEE', 80, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    const space = apogee !== null && apogee >= SPACE;
    const apogeeText = apogee === null ? '----' : (apogee * scale).toFixed(apogee * scale < 100 ? 1 : 0);
    digital(pen, apogeeText, 22, 42, 116, 40, theme, { size: 26, color: space ? theme.teal : null });
    label(pen, apogee === null ? 'DESCENDING' : space ? `${unit}  SPACE` : unit, 80, 96, { size: 10, color: space ? theme.teal : theme.textDim, weight: 700, spacing: 1.2 });
    label(pen, 'ALT', 22, 122, { size: 10, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    digital(pen, (altitude * scale).toFixed(1), 22, 132, 116, 28, theme, { size: 18 });
    label(pen, unit, 80, 172, { size: 9.5, color: theme.textDim, weight: 650 });

    // The column: ground to 150 km, the edge of space, the altitude bar, the apogee caret.
    pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(pen, COLUMN.x, COLUMN.y, COLUMN.width, COLUMN.height, 5);
    pen.fill();
    const top = columnY(altitude);
    pen.fillStyle = theme.yellow;
    roundRect(pen, COLUMN.x + 4, top, COLUMN.width - 8, Math.max(2, COLUMN.y + COLUMN.height - top - 2), 3);
    pen.fill();
    const spaceY = columnY(SPACE);
    pen.strokeStyle = theme.teal;
    pen.lineWidth = 2;
    pen.beginPath();
    pen.moveTo(COLUMN.x - 4, spaceY);
    pen.lineTo(COLUMN.x + COLUMN.width + 4, spaceY);
    pen.stroke();
    label(pen, '100', COLUMN.x - 6, spaceY, { size: 8.5, color: theme.teal, weight: 700, align: 'right' });
    if (apogee !== null) {
      const caretY = columnY(apogee);
      pen.beginPath();
      pen.moveTo(COLUMN.x + COLUMN.width + 2, caretY);
      pen.lineTo(COLUMN.x + COLUMN.width + 12, caretY - 6);
      pen.lineTo(COLUMN.x + COLUMN.width + 12, caretY + 6);
      pen.closePath();
      pen.fillStyle = theme.accent;
      pen.fill();
    }
  },
});
