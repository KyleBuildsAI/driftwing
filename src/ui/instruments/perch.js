// Perch (eagle / dragon): the creature's wings and its perch at a glance. Two bars: the flap power
// (the throttle axis; empty is a glide) and the wing tuck (the stoop). Below them the perch line:
// PERCHED on what, LANDING through the auto-landing, or the nearest perch point (kind, distance and
// height) with an arrow pointing to it relative to the heading (the ability keeps
// craftState.nearestPerch, 300 m around). A soaring climb with the flap power at zero shows its gain.
import { CENTER, drawPlate, label, digital, roundRect, clamp } from './gaugeKit.js';
import { grouped } from './units.js';

const KIND_NAMES = Object.freeze({ tree: 'TREE TOP', structure: 'LEDGE', peak: 'PEAK', ground: 'GROUND' });
const BAR = Object.freeze({ x: 62, width: 116, height: 12 });

function bar(pen, theme, y, fraction, colour) {
  pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
  roundRect(pen, BAR.x, y, BAR.width, BAR.height, 5);
  pen.fill();
  if (fraction <= 0.005) return;
  pen.fillStyle = colour;
  roundRect(pen, BAR.x, y, Math.max(8, BAR.width * clamp(fraction, 0, 1)), BAR.height, 5);
  pen.fill();
}

/** An arrow at (x, y) pointing `degrees` clockwise from straight up. */
function arrow(pen, x, y, degrees, colour) {
  pen.save();
  pen.translate(x, y);
  pen.rotate((degrees * Math.PI) / 180);
  pen.fillStyle = colour;
  pen.beginPath();
  pen.moveTo(0, -13);
  pen.lineTo(9, 9);
  pen.lineTo(0, 4);
  pen.lineTo(-9, 9);
  pen.closePath();
  pen.fill();
  pen.restore();
}

export default Object.freeze({
  id: 'perch',
  label: 'Perch',
  draw(pen, source, theme) {
    const { flight, units } = source;
    const craftState = flight.craftState || {};
    drawPlate(pen, theme);
    label(pen, 'WINGS', CENTER, 26, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    const power = clamp(Number(craftState.flapPower) || 0, 0, 1);
    const tuck = clamp(Number(craftState.wingTuck) || 0, 0, 1);
    label(pen, 'FLAP', 22, 48, { size: 10, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    bar(pen, theme, 42, power, theme.yellow);
    label(pen, 'TUCK', 22, 70, { size: 10, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    bar(pen, theme, 64, tuck, theme.teal);
    const soar = Number(craftState.soarGain) || 0;
    if (power < 0.03 && soar >= 5 && craftState.perched !== true) {
      label(pen, `SOARING +${grouped(soar * units.altitude.factor)} ${units.altitude.label}`, CENTER, 96, { size: 11, color: theme.green, weight: 700, spacing: 1 });
    } else {
      label(pen, power < 0.03 ? 'GLIDING' : `FLAPPING ${Math.round(power * 100)} %`, CENTER, 96, { size: 11, color: theme.textDim, weight: 700, spacing: 1 });
    }

    label(pen, 'PERCH', CENTER, 118, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    if (craftState.perched === true) {
      digital(pen, KIND_NAMES[craftState.perchKind] ?? 'PERCHED', CENTER - 66, 130, 132, 30, theme, { size: 16, color: theme.green });
      label(pen, 'FLAP TO TAKE OFF', CENTER, 176, { size: 10, color: theme.textDim, weight: 700, spacing: 1.2 });
      return;
    }
    if ((Number(craftState.landing) || 0) > 0) {
      digital(pen, 'LANDING', CENTER - 66, 130, 132, 30, theme, { size: 16, color: theme.yellow });
      return;
    }
    const nearest = craftState.nearestPerch;
    if (!nearest || !nearest.found) {
      label(pen, 'NONE NEAR', CENTER, 146, { size: 13, color: theme.textDim, weight: 700, spacing: 1.2 });
      return;
    }
    const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
    arrow(pen, 40, 148, nearest.bearing - heading, theme.accent);
    label(pen, KIND_NAMES[nearest.kind] ?? 'PERCH', 66, 136, { size: 11, color: theme.text, weight: 700, align: 'left', spacing: 1 });
    digital(pen, `${grouped(nearest.distance * units.altitude.factor)} ${units.altitude.label}`, 64, 146, 114, 24, theme, { size: 14, align: 'left' });
    const height = nearest.height * units.altitude.factor;
    label(pen, `${height >= 0 ? '+' : ''}${grouped(height)} ${units.altitude.label} ${height >= 0 ? 'ABOVE' : 'BELOW'}`, 66, 182, { size: 9.5, color: theme.textDim, weight: 650, align: 'left', spacing: 0.6 });
  },
});
