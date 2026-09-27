// Heading indicator: a compass card that turns under a fixed lubber line and aircraft symbol,
// with the autopilot's heading bug (gold) while the autopilot is engaged.
import { CENTER, drawCase, drawGlare, label, digital } from './gaugeKit.js';

const DEG = Math.PI / 180;
const CARDINALS = Object.freeze({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' });

function drawCard(g, theme, heading) {
  g.save();
  g.translate(CENTER, CENTER);
  g.rotate(-heading * DEG);
  g.strokeStyle = theme.tick;
  g.lineCap = 'butt';
  for (let degrees = 0; degrees < 360; degrees += 5) {
    const long = degrees % 10 === 0;
    g.lineWidth = long ? 2.4 : 1.4;
    g.beginPath();
    g.moveTo(0, -84);
    g.lineTo(0, long ? -72 : -78);
    g.stroke();
    if (degrees % 30 === 0) {
      const cardinal = CARDINALS[degrees];
      label(g, cardinal || String(degrees / 10), 0, -60, {
        size: cardinal ? 18 : 15,
        color: cardinal === 'N' ? theme.accent : theme.text,
        weight: cardinal ? 750 : 600,
      });
    }
    g.rotate(5 * DEG);
  }
  g.restore();
}

function drawBug(g, theme, heading, target) {
  g.save();
  g.translate(CENTER, CENTER);
  g.rotate((target - heading) * DEG);
  g.fillStyle = theme.id === 'panel' ? '#f3c77a' : theme.yellow;
  g.beginPath();
  g.moveTo(-8, -88);
  g.lineTo(8, -88);
  g.lineTo(8, -80);
  g.lineTo(3, -80);
  g.lineTo(0, -84);
  g.lineTo(-3, -80);
  g.lineTo(-8, -80);
  g.closePath();
  g.fill();
  g.restore();
}

function drawAircraft(g, theme) {
  g.fillStyle = theme.accent;
  g.beginPath();
  g.moveTo(CENTER, CENTER - 24);
  g.lineTo(CENTER + 3, CENTER - 8);
  g.lineTo(CENTER + 22, CENTER - 1);
  g.lineTo(CENTER + 22, CENTER + 4);
  g.lineTo(CENTER + 3, CENTER + 2);
  g.lineTo(CENTER + 2.5, CENTER + 14);
  g.lineTo(CENTER + 9, CENTER + 19);
  g.lineTo(CENTER + 9, CENTER + 22);
  g.lineTo(CENTER - 9, CENTER + 22);
  g.lineTo(CENTER - 9, CENTER + 19);
  g.lineTo(CENTER - 2.5, CENTER + 14);
  g.lineTo(CENTER - 3, CENTER + 2);
  g.lineTo(CENTER - 22, CENTER + 4);
  g.lineTo(CENTER - 22, CENTER - 1);
  g.lineTo(CENTER - 3, CENTER - 8);
  g.closePath();
  g.fill();
}

export default Object.freeze({
  id: 'heading',
  label: 'Heading',
  draw(g, source, theme) {
    const { flight } = source;
    const heading = Number.isFinite(flight.heading) ? ((flight.heading % 360) + 360) % 360 : 0;
    drawCase(g, theme);
    drawCard(g, theme, heading);
    const autopilot = flight.autopilot;
    if (autopilot && autopilot.enabled && Number.isFinite(autopilot.heading)) drawBug(g, theme, heading, autopilot.heading);
    // Lubber line.
    g.fillStyle = theme.accent;
    g.beginPath();
    g.moveTo(CENTER, CENTER - 70);
    g.lineTo(CENTER - 6, CENTER - 86);
    g.lineTo(CENTER + 6, CENTER - 86);
    g.closePath();
    g.fill();
    drawAircraft(g, theme);
    if (theme.id === 'glass') {
      const rounded = Math.round(heading) % 360;
      digital(g, `${String(rounded).padStart(3, '0')}°`, CENTER - 24, 126, 48, 18, theme, { size: 13 });
    }
    drawGlare(g, theme);
  },
});
