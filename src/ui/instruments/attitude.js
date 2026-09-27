// Attitude indicator: sky and ground card that rolls and pitches behind a fixed orange aircraft
// symbol (v1 palette), a pitch ladder every 5 degrees, and a bank scale on the case with a
// pointer that turns with the card.
import { CENTER, dialAngle, drawCase, drawGlare, label, polar, clamp } from './gaugeKit.js';

const DEG = Math.PI / 180;
const PIXELS_PER_DEGREE = 2.4;
const FACE_RADIUS = 86;
const BANK_MARKS = [10, 20, 30, 45, 60];

function drawCard(g, theme, pitch, roll) {
  g.save();
  g.beginPath();
  g.arc(CENTER, CENTER, FACE_RADIUS, 0, Math.PI * 2);
  g.clip();
  g.translate(CENTER, CENTER);
  g.rotate(-roll * DEG);
  g.translate(0, clamp(pitch, -80, 80) * PIXELS_PER_DEGREE);
  const sky = g.createLinearGradient(0, -260, 0, 0);
  sky.addColorStop(0, theme.skyHigh);
  sky.addColorStop(1, theme.sky);
  g.fillStyle = sky;
  g.fillRect(-260, -260, 520, 260);
  const ground = g.createLinearGradient(0, 0, 0, 260);
  ground.addColorStop(0, theme.ground);
  ground.addColorStop(1, theme.groundLow);
  g.fillStyle = ground;
  g.fillRect(-260, 0, 520, 260);
  g.strokeStyle = theme.horizon;
  g.lineWidth = 2.4;
  g.beginPath();
  g.moveTo(-260, 0);
  g.lineTo(260, 0);
  g.stroke();

  // Pitch ladder: the rungs within +-35 degrees of the current pitch are drawn.
  g.lineWidth = 1.8;
  const nearest = Math.round(pitch / 5) * 5;
  for (let rung = nearest - 35; rung <= nearest + 35; rung += 5) {
    if (rung === 0 || rung < -90 || rung > 90) continue;
    const y = -rung * PIXELS_PER_DEGREE;
    const half = rung % 10 === 0 ? 22 : 11;
    g.beginPath();
    g.moveTo(-half, y);
    g.lineTo(half, y);
    g.stroke();
    if (rung % 10 === 0) {
      label(g, String(Math.abs(rung)), -half - 11, y, { size: 10.5, color: theme.horizon, weight: 650 });
      label(g, String(Math.abs(rung)), half + 11, y, { size: 10.5, color: theme.horizon, weight: 650 });
    }
  }
  // Bank pointer: rides with the card, points up at the bank scale.
  g.translate(0, -clamp(pitch, -80, 80) * PIXELS_PER_DEGREE);
  g.beginPath();
  g.moveTo(0, -FACE_RADIUS + 14);
  g.lineTo(-7, -FACE_RADIUS + 26);
  g.lineTo(7, -FACE_RADIUS + 26);
  g.closePath();
  g.fillStyle = theme.pointer;
  g.fill();
  g.restore();
}

function drawBankScale(g, theme) {
  g.strokeStyle = theme.tick;
  g.lineCap = 'butt';
  for (const side of [-1, 1]) {
    for (const mark of BANK_MARKS) {
      const angle = dialAngle(side * mark);
      const long = mark === 30 || mark === 60;
      const [x0, y0] = polar(angle, FACE_RADIUS - (long ? 14 : 9));
      const [x1, y1] = polar(angle, FACE_RADIUS);
      g.lineWidth = long ? 2.6 : 1.8;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }
  // Zero-bank index.
  g.beginPath();
  g.moveTo(CENTER, CENTER - FACE_RADIUS + 12);
  g.lineTo(CENTER - 6, CENTER - FACE_RADIUS + 1);
  g.lineTo(CENTER + 6, CENTER - FACE_RADIUS + 1);
  g.closePath();
  g.fillStyle = theme.tick;
  g.fill();
}

function drawSymbol(g, theme) {
  g.fillStyle = theme.accent;
  g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  g.lineWidth = 1;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(CENTER + side * 16, CENTER - 2.5);
    g.lineTo(CENTER + side * 46, CENTER - 2.5);
    g.lineTo(CENTER + side * 46, CENTER + 2.5);
    g.lineTo(CENTER + side * 22, CENTER + 2.5);
    g.lineTo(CENTER + side * 16, CENTER + 10);
    g.closePath();
    g.fill();
    g.stroke();
  }
  g.beginPath();
  g.arc(CENTER, CENTER, 3.6, 0, Math.PI * 2);
  g.fill();
}

export default Object.freeze({
  id: 'attitude',
  label: 'Attitude',
  draw(g, source, theme) {
    const { flight } = source;
    const pitch = Number.isFinite(flight.pitch) ? flight.pitch : 0;
    const roll = Number.isFinite(flight.roll) ? flight.roll : 0;
    drawCase(g, theme, FACE_RADIUS);
    drawCard(g, theme, pitch, roll);
    drawBankScale(g, theme);
    drawSymbol(g, theme);
    drawGlare(g, theme, FACE_RADIUS);
  },
});
