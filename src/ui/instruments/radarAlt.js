// Radar altimeter: height above the ground or water (state.flight.radarAltitude) on a square-root
// dial that spreads the low range (metric 0-750 m, aviation 0-2500 ft). Above the range the needle
// parks behind the OFF flag, as the real instrument does when it loses the ground return.
import { CENTER, dialAngle, drawCase, drawGlare, ticks, numerals, needle, label, digital, title, roundRect } from './gaugeKit.js';
import { grouped } from './units.js';

const SWEEP = 300;

export default Object.freeze({
  id: 'radarAlt',
  label: 'Radar altitude',
  draw(pen, source, theme) {
    const { flight, units } = source;
    const aviation = units.system === 'aviation';
    const maximum = aviation ? 2500 : 750;
    const toAngle = (value) => dialAngle(-150 + Math.sqrt(Math.min(Math.max(value, 0), maximum) / maximum) * SWEEP);
    const height = Number.isFinite(flight.radarAltitude) ? flight.radarAltitude * units.altitude.factor : maximum * 2;
    const inRange = height <= maximum;
    drawCase(pen, theme);
    const labels = aviation ? [0, 50, 100, 200, 500, 1000, 2500] : [0, 10, 25, 50, 100, 200, 400, 750];
    const minor = aviation ? [10, 20, 30, 40, 150, 300, 400, 700, 1500, 2000] : [5, 15, 20, 30, 40, 75, 150, 300, 500, 600];
    ticks(pen, { from: 0, to: 0, step: 1, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    for (const value of minor) ticks(pen, { from: value, to: value, step: 1, toAngle, inner: 81, outer: 88, width: 1.4, color: theme.tick });
    for (const value of labels) ticks(pen, { from: value, to: value, step: 1, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    numerals(pen, labels, { toAngle, radius: 58, size: 13, color: theme.text });
    title(pen, 'RAD ALT', theme, 72);
    label(pen, units.altitude.dial, CENTER, 86, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
    if (inRange) {
      digital(pen, grouped(Math.round(height)), CENTER - 26, 118, 52, 22, theme, { size: 14 });
      needle(pen, toAngle(height), { length: 80, color: theme.needle });
    } else {
      pen.fillStyle = theme.red;
      roundRect(pen, CENTER - 22, 122, 44, 22, 4);
      pen.fill();
      label(pen, 'OFF', CENTER, 134, { size: 13, color: '#fff7ee', weight: 750, spacing: 1 });
      needle(pen, toAngle(maximum), { length: 80, color: theme.needle });
    }
    drawGlare(pen, theme);
  },
});
