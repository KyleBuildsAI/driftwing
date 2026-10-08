// Machmeter (spaceplane): state.flight.mach on a 0-6 dial with the sound barrier marked, the transonic
// band shaded, and the Mach number to two decimals in the window (hypersonic past Mach 5 tints it).
import { CENTER, drawCase, drawGlare, ticks, numerals, arcBand, radial, needle, label, digital, title, linearDial } from './gaugeKit.js';

const MAXIMUM = 6;
const toAngle = linearDial(0, MAXIMUM, -150, 300);

export default Object.freeze({
  id: 'mach',
  label: 'Machmeter',
  draw(pen, source, theme) {
    const { flight } = source;
    const mach = Number.isFinite(flight.mach) ? Math.max(0, flight.mach) : 0;
    drawCase(pen, theme);
    arcBand(pen, { from: 0.85, to: 1.2, toAngle, radius: 84, width: 7, color: theme.yellow });
    arcBand(pen, { from: 5, to: MAXIMUM, toAngle, radius: 84, width: 7, color: theme.red });
    ticks(pen, { from: 0, to: MAXIMUM, step: 0.2, toAngle, inner: 80, outer: 88, width: 1.4, color: theme.tick });
    ticks(pen, { from: 0, to: MAXIMUM, step: 1, toAngle, inner: 70, outer: 88, width: 3, color: theme.tick });
    numerals(pen, [0, 1, 2, 3, 4, 5, 6], { toAngle, radius: 57, size: 16, color: theme.text });
    radial(pen, toAngle(1), 64, 90, theme.accent, 3);
    title(pen, 'MACH', theme, 68);
    const hypersonic = mach >= 5;
    const regime = hypersonic ? 'HYPERSONIC' : mach >= 1 ? 'SUPERSONIC' : 'SUBSONIC';
    label(pen, regime, CENTER, 84, { size: 9, color: hypersonic ? theme.red : theme.textDim, weight: 700, spacing: 1.2 });
    digital(pen, mach.toFixed(2), CENTER - 30, 116, 60, 24, theme, { size: 16, color: hypersonic ? theme.red : null });
    needle(pen, toAngle(Math.min(mach, MAXIMUM)), { length: 78, color: theme.needle });
    drawGlare(pen, theme);
  },
});
