// Heading indicator: a compass card that turns under a fixed lubber line and aircraft symbol,
// with the autopilot's heading bug (gold) while the autopilot is engaged.
import { CENTER, drawCase, drawGlare, label, digital } from './gaugeKit.js';

const DEG = Math.PI / 180;
const CARDINALS = Object.freeze({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' });

function drawCard(pen, theme, heading) {
  pen.save();
  pen.translate(CENTER, CENTER);
  pen.rotate(-heading * DEG);
  pen.strokeStyle = theme.tick;
  pen.lineCap = 'butt';
  for (let degrees = 0; degrees < 360; degrees += 5) {
    const long = degrees % 10 === 0;
    pen.lineWidth = long ? 2.4 : 1.4;
    pen.beginPath();
    pen.moveTo(0, -84);
    pen.lineTo(0, long ? -72 : -78);
    pen.stroke();
    if (degrees % 30 === 0) {
      const cardinal = CARDINALS[degrees];
      label(pen, cardinal || String(degrees / 10), 0, -60, {
        size: cardinal ? 18 : 15,
        color: cardinal === 'N' ? theme.accent : theme.text,
        weight: cardinal ? 750 : 600,
      });
    }
    pen.rotate(5 * DEG);
  }
  pen.restore();
}

function drawBug(pen, theme, heading, target) {
  pen.save();
  pen.translate(CENTER, CENTER);
  pen.rotate((target - heading) * DEG);
  pen.fillStyle = theme.id === 'panel' ? '#f3c77a' : theme.yellow;
  pen.beginPath();
  pen.moveTo(-8, -88);
  pen.lineTo(8, -88);
  pen.lineTo(8, -80);
  pen.lineTo(3, -80);
  pen.lineTo(0, -84);
  pen.lineTo(-3, -80);
  pen.lineTo(-8, -80);
  pen.closePath();
  pen.fill();
  pen.restore();
}

function drawAircraft(pen, theme) {
  pen.fillStyle = theme.accent;
  pen.beginPath();
  pen.moveTo(CENTER, CENTER - 24);
  pen.lineTo(CENTER + 3, CENTER - 8);
  pen.lineTo(CENTER + 22, CENTER - 1);
  pen.lineTo(CENTER + 22, CENTER + 4);
  pen.lineTo(CENTER + 3, CENTER + 2);
  pen.lineTo(CENTER + 2.5, CENTER + 14);
  pen.lineTo(CENTER + 9, CENTER + 19);
  pen.lineTo(CENTER + 9, CENTER + 22);
  pen.lineTo(CENTER - 9, CENTER + 22);
  pen.lineTo(CENTER - 9, CENTER + 19);
  pen.lineTo(CENTER - 2.5, CENTER + 14);
  pen.lineTo(CENTER - 3, CENTER + 2);
  pen.lineTo(CENTER - 22, CENTER + 4);
  pen.lineTo(CENTER - 22, CENTER - 1);
  pen.lineTo(CENTER - 3, CENTER - 8);
  pen.closePath();
  pen.fill();
}

export default Object.freeze({
  id: 'heading',
  label: 'Heading',
  draw(pen, source, theme) {
    const { flight } = source;
    const heading = Number.isFinite(flight.heading) ? ((flight.heading % 360) + 360) % 360 : 0;
    drawCase(pen, theme);
    drawCard(pen, theme, heading);
    const autopilot = flight.autopilot;
    if (autopilot && autopilot.enabled && Number.isFinite(autopilot.heading)) drawBug(pen, theme, heading, autopilot.heading);
    // Lubber line.
    pen.fillStyle = theme.accent;
    pen.beginPath();
    pen.moveTo(CENTER, CENTER - 70);
    pen.lineTo(CENTER - 6, CENTER - 86);
    pen.lineTo(CENTER + 6, CENTER - 86);
    pen.closePath();
    pen.fill();
    drawAircraft(pen, theme);
    if (theme.id === 'glass') {
      const rounded = Math.round(heading) % 360;
      digital(pen, `${String(rounded).padStart(3, '0')}°`, CENTER - 24, 126, 48, 18, theme, { size: 13 });
    }
    drawGlare(pen, theme);
  },
});
