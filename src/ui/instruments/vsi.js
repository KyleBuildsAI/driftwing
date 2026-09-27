// Vertical speed indicator: zero at 9 o'clock, climb clockwise over the top, descent
// anticlockwise under the bottom, both ends meeting at 3 o'clock. The scale is logarithmic so
// small rates stay readable while a jet's climb still fits (metric to 20 m/s, aviation to
// 4000 fpm, numerals in hundreds of fpm). drawVerticalDial is shared with the variometer.
import { CENTER, dialAngle, drawCase, drawGlare, ticks, numerals, needle, label, digital, title } from './gaugeKit.js';
import { signed } from './units.js';

const SWEEP = 168;

/**
 * Draws a zero-left vertical-rate dial. options: { value, maximum, labels, minorStep, knee (log
 * scale knee; null = linear), format(label), caption, unitCaption, digitalText, needleColor }.
 * Returns value -> angle for callers that add markers.
 */
export function drawVerticalDial(pen, theme, options) {
  const { maximum, knee } = options;
  const shape = (magnitude) => (knee ? Math.log1p(magnitude / knee) / Math.log1p(maximum / knee) : magnitude / maximum);
  const toAngle = (value) => {
    const magnitude = Math.min(Math.abs(value), maximum);
    return dialAngle(-90 + Math.sign(value) * shape(magnitude) * SWEEP);
  };
  drawCase(pen, theme);
  const minorValues = [];
  for (let value = options.minorStep; value < maximum + 1e-6; value += options.minorStep) minorValues.push(value, -value);
  pen.strokeStyle = theme.tick;
  pen.lineWidth = 1.4;
  pen.beginPath();
  for (const value of minorValues) {
    const angle = toAngle(value);
    pen.moveTo(CENTER + Math.cos(angle) * 79, CENTER + Math.sin(angle) * 79);
    pen.lineTo(CENTER + Math.cos(angle) * 87, CENTER + Math.sin(angle) * 87);
  }
  pen.stroke();
  const labelled = [];
  for (const value of options.labels) {
    labelled.push(value);
    if (value !== 0) labelled.push(-value);
  }
  ticks(pen, { from: 0, to: 0, step: 1, toAngle, inner: 70, outer: 88, width: 3.2, color: theme.tick });
  for (const value of labelled) {
    if (value === 0) continue;
    const angle = toAngle(value);
    pen.lineWidth = 2.6;
    pen.beginPath();
    pen.moveTo(CENTER + Math.cos(angle) * 72, CENTER + Math.sin(angle) * 72);
    pen.lineTo(CENTER + Math.cos(angle) * 88, CENTER + Math.sin(angle) * 88);
    pen.stroke();
  }
  numerals(pen, labelled, { toAngle, radius: 58, size: 15, color: theme.text, format: (value) => options.format(Math.abs(value)) });
  title(pen, options.caption, theme, 76);
  label(pen, 'UP', CENTER - 58, 64, { size: 10, color: theme.textDim, weight: 650 });
  label(pen, 'DN', CENTER - 58, 137, { size: 10, color: theme.textDim, weight: 650 });
  label(pen, options.unitCaption, CENTER + 22, 100, { size: 10, color: theme.textDim, weight: 650, spacing: 1 });
  if (theme.id === 'glass' || options.alwaysDigital) digital(pen, options.digitalText, CENTER - 30, 124, 60, 22, theme, { size: 14 });
  needle(pen, toAngle(options.value), { length: 80, color: options.needleColor || theme.needle });
  drawGlare(pen, theme);
  return toAngle;
}

export default Object.freeze({
  id: 'vsi',
  label: 'Vertical speed',
  draw(pen, source, theme) {
    const { flight, units } = source;
    const rate = Number.isFinite(flight.verticalSpeed) ? flight.verticalSpeed * units.vertical.factor : 0;
    const aviation = units.system === 'aviation';
    drawVerticalDial(pen, theme, {
      value: rate,
      maximum: aviation ? 4000 : 20,
      knee: aviation ? 500 : 2.5,
      labels: aviation ? [0, 500, 1000, 2000, 4000] : [0, 1, 2, 5, 10, 20],
      minorStep: aviation ? 250 : 1,
      format: aviation ? (value) => String(value / 100) : String,
      caption: 'VERT SPEED',
      unitCaption: aviation ? '×100 FPM' : 'M/S',
      digitalText: aviation ? signed(Math.round(rate / 10) * 10, 0) : signed(rate, 1),
    });
  },
});
