// Angle-of-attack indicator: a 240 degree arc from -5 degrees to 10 past the wing's critical angle
// (simProfile.aero.alphaCritical, 15 when a craft does not give one), banded green / yellow / red
// toward the stall, with a STALL lamp driven by state.flight.stall.
import { CENTER, drawCase, drawGlare, ticks, numerals, arcBand, needle, digital, title, linearDial, lamp, label } from './gaugeKit.js';

export default Object.freeze({
  id: 'aoa',
  label: 'Angle of attack',
  draw(g, source, theme) {
    const { flight, craft } = source;
    const aero = craft.simProfile && craft.simProfile.aero;
    const critical = aero && Number.isFinite(aero.alphaCritical) ? aero.alphaCritical : 15;
    const minimum = -5;
    const maximum = Math.ceil((critical + 10) / 5) * 5;
    const toAngle = linearDial(minimum, maximum, -120, 240);
    drawCase(g, theme);
    arcBand(g, { from: 0, to: critical * 0.7, toAngle, radius: 80, width: 7, color: theme.green });
    arcBand(g, { from: critical * 0.7, to: critical * 0.9, toAngle, radius: 80, width: 7, color: theme.yellow });
    arcBand(g, { from: critical * 0.9, to: maximum, toAngle, radius: 80, width: 7, color: theme.red });
    ticks(g, { from: minimum, to: maximum, step: 1, toAngle, inner: 81, outer: 88, width: 1.3, color: theme.tick });
    ticks(g, { from: minimum, to: maximum, step: 5, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    const labels = [];
    for (let value = 0; value <= maximum; value += maximum > 30 ? 10 : 5) labels.push(value);
    numerals(g, labels, { toAngle, radius: 58, size: 15, color: theme.text });
    title(g, 'AOA', theme, 72);
    label(g, 'DEG', CENTER, 86, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
    const warning = Boolean(flight.stall && (flight.stall.warning || flight.stall.stalled));
    lamp(g, CENTER - 20, 150, 6, warning, theme.red, theme);
    label(g, 'STALL', CENTER + 6, 150, { size: 11, color: warning ? theme.red : theme.textDim, weight: 700, spacing: 1 });
    const aoa = Number.isFinite(flight.aoa) ? flight.aoa : 0;
    if (theme.id === 'glass') digital(g, `${aoa.toFixed(1)}°`, CENTER - 28, 112, 56, 22, theme, { size: 14 });
    needle(g, toAngle(aoa), { length: 80, color: theme.needle });
    drawGlare(g, theme);
  },
});
