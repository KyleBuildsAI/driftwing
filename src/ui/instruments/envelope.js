// Envelope temperature (hot air balloon): the air inside the envelope (state.flight.craftState
// .envelopeTemperature) on a dial from ambient to past the fabric's red line, with the temperature at
// which the balloon floats as a gold bug (craftState.equilibriumTemperature: above it the balloon
// rises, below it sinks, 20-30 s later), the red line (craftState.redLine), the burner and vent lamps,
// the net lift and the altitude hold. Celsius in metric units, Fahrenheit in aviation units (as US
// balloon instruments read). The temperature flag shows once the envelope has passed its red line.
import { CENTER, drawCase, drawGlare, ticks, numerals, radial, needle, label, digital, title, linearDial, arcBand, lamp, polar } from './gaugeKit.js';
import { grouped, signed } from './units.js';

const MIN_CELSIUS = 0;
const MAX_CELSIUS = 140;
const CAUTION_CELSIUS = 15;

function toFahrenheit(celsius) {
  return celsius * 1.8 + 32;
}

export default Object.freeze({
  id: 'envelope',
  label: 'Envelope temperature',
  draw(pen, source, theme) {
    const { flight, units } = source;
    const craftState = flight.craftState || {};
    const fahrenheit = units.system === 'aviation';
    const convert = fahrenheit ? toFahrenheit : (celsius) => celsius;
    const minimum = convert(MIN_CELSIUS);
    const maximum = convert(MAX_CELSIUS);
    const toAngle = linearDial(minimum, maximum, -135, 270);
    const temperature = convert(Number.isFinite(craftState.envelopeTemperature) ? craftState.envelopeTemperature : MIN_CELSIUS);
    const redLine = convert(Number.isFinite(craftState.redLine) ? craftState.redLine : 120);
    const equilibrium = Number.isFinite(craftState.equilibriumTemperature) ? convert(craftState.equilibriumTemperature) : null;
    drawCase(pen, theme);
    const step = fahrenheit ? 20 : 10;
    ticks(pen, { from: minimum, to: maximum, step: step / 2, toAngle, inner: 81, outer: 88, width: 1.4, color: theme.tick });
    ticks(pen, { from: minimum, to: maximum, step, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    const labels = [];
    for (let value = Math.ceil(minimum / (step * 2)) * step * 2; value <= maximum; value += step * 2) labels.push(value);
    numerals(pen, labels, { toAngle, radius: 58, size: 13, color: theme.text });
    // The normal operating band, then the caution band (15 C) below the red line.
    const caution = CAUTION_CELSIUS * (fahrenheit ? 1.8 : 1);
    arcBand(pen, { from: convert(50), to: redLine - caution, toAngle, radius: 84, width: 6, color: theme.green });
    arcBand(pen, { from: redLine - caution, to: redLine, toAngle, radius: 84, width: 6, color: theme.yellow });
    radial(pen, toAngle(redLine), 68, 90, theme.red, 4);
    if (equilibrium !== null && equilibrium <= maximum) {
      // The float bug: a gold triangle on the rim.
      const angle = toAngle(equilibrium);
      const [tipX, tipY] = polar(angle, 70);
      const [leftX, leftY] = polar(angle - 0.07, 86);
      const [rightX, rightY] = polar(angle + 0.07, 86);
      pen.beginPath();
      pen.moveTo(tipX, tipY);
      pen.lineTo(leftX, leftY);
      pen.lineTo(rightX, rightY);
      pen.closePath();
      pen.fillStyle = theme.id === 'panel' ? '#f3c77a' : theme.yellow;
      pen.fill();
    }
    title(pen, 'ENVELOPE', theme, 66);
    label(pen, fahrenheit ? '°F' : '°C', CENTER, 80, { size: 11, color: theme.textDim, weight: 700 });
    lamp(pen, CENTER - 30, 98, 6, craftState.burner > 0.05, theme.accent, theme);
    label(pen, 'BURN', CENTER - 30, 110, { size: 8, color: theme.textDim, weight: 700, spacing: 0.8 });
    lamp(pen, CENTER + 30, 98, 6, craftState.vent > 0.05, theme.teal, theme);
    label(pen, 'VENT', CENTER + 30, 110, { size: 8, color: theme.textDim, weight: 700, spacing: 0.8 });
    const lift = Number.isFinite(craftState.lift) ? craftState.lift : 0;
    digital(pen, `${signed(lift, 0)} kg`, CENTER - 32, 122, 64, 20, theme, { size: 13 });
    let note = '';
    if (craftState.tempFlag) note = 'TEMP FLAG';
    else if (craftState.tethered) note = 'TIED DOWN';
    else if (craftState.landing) note = 'LANDING';
    else if (Number.isFinite(craftState.altitudeHold)) note = `HOLD ${grouped(craftState.altitudeHold * units.altitude.factor)}`;
    if (note) label(pen, note, CENTER, 156, { size: 10, color: craftState.tempFlag ? theme.red : theme.textDim, weight: 750, spacing: 1 });
    needle(pen, toAngle(temperature), { length: 80, color: craftState.overTemperature ? theme.red : theme.needle });
    drawGlare(pen, theme);
  },
});
