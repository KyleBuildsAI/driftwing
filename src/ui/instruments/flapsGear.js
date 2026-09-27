// Flaps and gear panel. Left: the flap position on a notched scale (UP, 1, 2, ...) from the SIM
// profile's notches, or, on craft without flaps, the spoiler / airbrake extension. Right: the
// landing gear as three lamps (green down and locked, red in transit, dark up) or a FIXED plaque.
// Bottom: BRAKE and airbrake lamps.
import { drawPlate, label, roundRect, lamp, clamp } from './gaugeKit.js';

const SCALE = Object.freeze({ x: 48, top: 48, bottom: 150 });

function flapNotches(craft) {
  const flaps = craft.simProfile && craft.simProfile.flaps;
  if (flaps && Array.isArray(flaps.notches) && flaps.notches.length > 1) return flaps.notches;
  const count = craft.inputProfile && Number.isFinite(craft.inputProfile.flapNotches) ? craft.inputProfile.flapNotches : 0;
  if (count <= 0) return null;
  return Array.from({ length: count + 1 }, (unused, index) => index / count);
}

function drawScale(g, theme, positions, labels, value, caption) {
  const height = SCALE.bottom - SCALE.top;
  label(g, caption, SCALE.x + 6, 32, { size: 10.5, color: theme.textDim, weight: 650, spacing: 1.4 });
  g.strokeStyle = theme.tick;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(SCALE.x, SCALE.top);
  g.lineTo(SCALE.x, SCALE.bottom);
  positions.forEach((position) => {
    const y = SCALE.top + position * height;
    g.moveTo(SCALE.x - 8, y);
    g.lineTo(SCALE.x, y);
  });
  g.stroke();
  positions.forEach((position, index) => {
    label(g, labels[index], SCALE.x - 12, SCALE.top + position * height, { size: 11, color: theme.text, weight: 650, align: 'right' });
  });
  const y = SCALE.top + clamp(value, 0, 1) * height;
  g.fillStyle = theme.pointer;
  g.beginPath();
  g.moveTo(SCALE.x + 3, y);
  g.lineTo(SCALE.x + 17, y - 7);
  g.lineTo(SCALE.x + 17, y + 7);
  g.closePath();
  g.fill();
}

function drawGear(g, theme, gear) {
  label(g, 'GEAR', 142, 32, { size: 10.5, color: theme.textDim, weight: 650, spacing: 1.4 });
  const retractable = Boolean(gear && gear.retractable);
  const transit = retractable && gear.transit > 0.001;
  const down = !retractable || (gear.down && !transit);
  const colour = transit ? theme.red : theme.id === 'panel' ? '#3fdc62' : theme.green;
  const lit = transit || down;
  lamp(g, 142, 58, 8, lit, colour, theme);
  lamp(g, 124, 84, 8, lit, colour, theme);
  lamp(g, 160, 84, 8, lit, colour, theme);
  const text = !retractable ? 'FIXED' : transit ? 'TRANSIT' : down ? 'DOWN' : 'UP';
  g.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
  roundRect(g, 110, 104, 64, 20, 4);
  g.fill();
  label(g, text, 142, 115, { size: 11, color: transit ? theme.red : theme.text, weight: 700, spacing: 1 });
}

export default Object.freeze({
  id: 'flapsGear',
  label: 'Flaps and gear',
  draw(g, source, theme) {
    const { flight, craft } = source;
    drawPlate(g, theme);
    const notches = flapNotches(craft);
    if (notches) {
      const last = notches[notches.length - 1] || 1;
      const positions = notches.map((notch) => notch / last);
      const labels = notches.map((notch, index) => (index === 0 ? 'UP' : String(index)));
      drawScale(g, theme, positions, labels, Number.isFinite(flight.flaps) ? flight.flaps : 0, 'FLAPS');
    } else {
      drawScale(g, theme, [0, 0.5, 1], ['IN', '½', 'OUT'], Number.isFinite(flight.airbrake) ? flight.airbrake : 0, 'SPOILER');
    }
    drawGear(g, theme, flight.gear);
    const braking = Number.isFinite(flight.brakes) && flight.brakes > 0.05;
    const airbrake = Number.isFinite(flight.airbrake) && flight.airbrake > 0.05;
    lamp(g, 116, 150, 6, braking, theme.yellow, theme);
    label(g, 'BRAKE', 128, 150, { size: 10.5, color: braking ? theme.yellow : theme.textDim, weight: 700, align: 'left' });
    lamp(g, 116, 172, 6, airbrake, theme.yellow, theme);
    label(g, notches ? 'AIRBRK' : 'SPLR', 128, 172, { size: 10.5, color: airbrake ? theme.yellow : theme.textDim, weight: 700, align: 'left' });
    if (notches) label(g, `NOTCH ${flight.flapNotch || 0}`, SCALE.x, 172, { size: 10, color: theme.textDim, weight: 650 });
  },
});
