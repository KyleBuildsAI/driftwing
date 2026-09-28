// Airspeed indicator: indicated airspeed on a 320 degree dial with the craft's operating arcs.
// Green from the stall speed to 80 % of Vne, yellow caution to Vne, red line at Vne (from
// craft.limits and the flight profile's targets).
// Craft with a Mach limit (craft.limits.vneMach: jets) get a Mach window under the hub.
import { CENTER, drawCase, drawGlare, ticks, numerals, arcBand, radial, needle, label, digital, title, linearDial, clamp } from './gaugeKit.js';
import { niceStep, ceilTo } from './units.js';

/** The craft's speed envelope in m/s: { stall, caution, never, top }. */
function envelope(craft) {
  const limits = craft.limits || {};
  const never = Number.isFinite(limits.vne) ? limits.vne : 80;
  const targets = craft.simProfile && craft.simProfile.targets;
  const stall = targets && Number.isFinite(targets.stallSpeed) ? targets.stallSpeed : never * 0.3;
  return { stall, caution: never * 0.8, never, top: never };
}

export default Object.freeze({
  id: 'airspeed',
  label: 'Airspeed',
  draw(pen, source, theme) {
    const { flight, craft, units } = source;
    const factor = units.speed.factor;
    const speeds = envelope(craft);
    const major = niceStep((speeds.top * 1.12 * factor) / 8);
    const maximum = ceilTo(speeds.top * 1.12 * factor, major);
    const toAngle = linearDial(0, maximum, 18, 324);
    drawCase(pen, theme);
    arcBand(pen, { from: speeds.stall * factor, to: speeds.caution * factor, toAngle, radius: 80, width: 7, color: theme.green });
    arcBand(pen, { from: speeds.caution * factor, to: speeds.never * factor, toAngle, radius: 80, width: 7, color: theme.yellow });
    radial(pen, toAngle(speeds.never * factor), 73, 88, theme.red, 4);
    ticks(pen, { from: 0, to: maximum, step: major / 2, toAngle, inner: 78, outer: 88, width: 1.6, color: theme.tick });
    ticks(pen, { from: 0, to: maximum, step: major, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    const labels = [];
    const labelStep = maximum / major > 8 ? major * 2 : major;
    for (let value = 0; value <= maximum + 1e-6; value += labelStep) labels.push(value);
    numerals(pen, labels, { toAngle, radius: 58, size: 16, color: theme.text });
    title(pen, 'AIRSPEED', theme, 66);
    label(pen, units.speed.dial, CENTER, 80, { size: 11, color: theme.textDim, weight: 650, spacing: 1.2 });
    const airspeed = flight.indicatedAirspeed;
    const shown = clamp(Number.isFinite(airspeed) ? airspeed * factor : 0, 0, maximum);
    if (theme.id === 'glass') digital(pen, String(Math.round(shown)), CENTER - 26, 112, 52, 22, theme, { size: 15 });
    if (craft.limits && Number.isFinite(craft.limits.vneMach)) {
      const mach = Number.isFinite(flight.mach) ? flight.mach : 0;
      digital(pen, `M ${mach.toFixed(2)}`, CENTER - 30, theme.id === 'glass' ? 138 : 120, 60, 20, theme, { size: 13 });
    }
    needle(pen, toAngle(shown), { length: 80, color: theme.needle });
    drawGlare(pen, theme);
  },
});
