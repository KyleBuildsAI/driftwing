// Airspeed indicator: indicated airspeed on a 320 degree dial with the craft's operating arcs.
// SIM: green from the stall speed to 80 % of Vne, yellow caution to Vne, red line at Vne (from
// craft.limits and the SIM profile). CLASSIC: the arcade envelope (stall to max dive speed).
import { CENTER, drawCase, drawGlare, ticks, numerals, arcBand, radial, needle, label, digital, title, linearDial, clamp } from './gaugeKit.js';
import { niceStep, ceilTo } from './units.js';

/** The speed envelope in m/s for the active mode: { stall, caution, never, top }. */
function envelope(craft, mode) {
  const arcade = craft.arcadeProfile && craft.arcadeProfile.SPEED;
  const limits = craft.limits || {};
  if (mode === 'classic' && arcade) {
    return { stall: arcade.STALL, caution: arcade.CRUISE * 1.4, never: arcade.MAX, top: arcade.BOOST_MAX || arcade.MAX };
  }
  const never = Number.isFinite(limits.vne) ? limits.vne : 80;
  const targets = craft.simProfile && craft.simProfile.targets;
  const stall = targets && Number.isFinite(targets.stallSpeed) ? targets.stallSpeed : never * 0.3;
  return { stall, caution: never * 0.8, never, top: never };
}

export default Object.freeze({
  id: 'airspeed',
  label: 'Airspeed',
  draw(pen, source, theme) {
    const { flight, craft, mode, units } = source;
    const factor = units.speed.factor;
    const speeds = envelope(craft, mode);
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
    const airspeed = mode === 'sim' ? flight.indicatedAirspeed : flight.airspeed;
    const shown = clamp(Number.isFinite(airspeed) ? airspeed * factor : 0, 0, maximum);
    if (theme.id === 'glass') digital(pen, String(Math.round(shown)), CENTER - 26, 112, 52, 22, theme, { size: 15 });
    needle(pen, toAngle(shown), { length: 80, color: theme.needle });
    drawGlare(pen, theme);
  },
});
