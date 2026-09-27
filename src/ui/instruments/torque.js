// Torque meter (helicopter): main-rotor torque in percent of rated (state.flight.torque, 1 = 100 %),
// green to 85 %, yellow to the 100 % red line, with a transient range to 120 %.
import { CENTER, drawCase, drawGlare, ticks, numerals, arcBand, radial, needle, label, digital, title, linearDial } from './gaugeKit.js';

export default Object.freeze({
  id: 'torque',
  label: 'Torque',
  draw(pen, source, theme) {
    const { flight } = source;
    const toAngle = linearDial(0, 120, -135, 270);
    drawCase(pen, theme);
    arcBand(pen, { from: 0, to: 85, toAngle, radius: 80, width: 7, color: theme.green });
    arcBand(pen, { from: 85, to: 100, toAngle, radius: 80, width: 7, color: theme.yellow });
    radial(pen, toAngle(100), 70, 90, theme.red, 4);
    ticks(pen, { from: 0, to: 120, step: 5, toAngle, inner: 81, outer: 88, width: 1.3, color: theme.tick });
    ticks(pen, { from: 0, to: 120, step: 20, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    numerals(pen, [0, 20, 40, 60, 80, 100, 120], { toAngle, radius: 58, size: 15, color: theme.text });
    title(pen, 'TORQUE', theme, 72);
    label(pen, '%', CENTER, 86, { size: 11, color: theme.textDim, weight: 650 });
    const torque = Number.isFinite(flight.torque) ? flight.torque * 100 : 0;
    if (theme.id === 'glass' || torque > 100) digital(pen, `${Math.round(torque)}%`, CENTER - 26, 132, 52, 22, theme, { size: 14, color: torque > 100 ? theme.red : null });
    needle(pen, toAngle(torque), { length: 80, color: theme.needle });
    drawGlare(pen, theme);
  },
});
