// Altimeter: three-pointer style. The long needle turns once per 1000 units (ft or m), the short
// wide needle once per 10 000, a small outer triangle once per 100 000; a drum window shows the
// altitude to the nearest 10 units.
import { CENTER, dialAngle, drawCase, drawGlare, ticks, numerals, needle, label, digital, title, polar } from './gaugeKit.js';
import { grouped } from './units.js';

const toAngle = (fraction) => dialAngle(fraction * 360);

export default Object.freeze({
  id: 'altitude',
  label: 'Altitude',
  draw(g, source, theme) {
    const { flight, units } = source;
    const altitude = Number.isFinite(flight.altitude) ? flight.altitude * units.altitude.factor : 0;
    drawCase(g, theme);
    const digitAngle = (digit) => toAngle(digit / 10);
    ticks(g, { from: 0, to: 49, step: 1, toAngle: (value) => toAngle(value / 50), inner: 80, outer: 87, width: 1.4, color: theme.tick });
    ticks(g, { from: 0, to: 9, step: 1, toAngle: digitAngle, inner: 72, outer: 87, width: 3, color: theme.tick });
    numerals(g, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { toAngle: digitAngle, radius: 60, size: 19, color: theme.text });
    title(g, 'ALT', theme, 66);
    label(g, units.altitude.dial, CENTER, 80, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
    const drum = Math.max(0, Math.round(altitude / 10) * 10);
    digital(g, grouped(drum), CENTER - 38, 118, 76, 24, theme, { size: 17 });

    const positive = Math.max(0, altitude);
    // Ten-thousands: a small triangle riding the outer edge.
    const [tipX, tipY] = polar(toAngle((positive % 100000) / 100000), 90);
    const [baseAX, baseAY] = polar(toAngle((positive % 100000) / 100000) - 0.07, 76);
    const [baseBX, baseBY] = polar(toAngle((positive % 100000) / 100000) + 0.07, 76);
    g.beginPath();
    g.moveTo(tipX, tipY);
    g.lineTo(baseAX, baseAY);
    g.lineTo(baseBX, baseBY);
    g.closePath();
    g.fillStyle = theme.pointer;
    g.fill();
    needle(g, toAngle((positive % 10000) / 10000), { length: 50, tail: 10, width: 10, color: theme.needle, hub: 0 });
    needle(g, toAngle((positive % 1000) / 1000), { length: 82, tail: 18, width: 5, color: theme.needle });
    drawGlare(g, theme);
  },
});
