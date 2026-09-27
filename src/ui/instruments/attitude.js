// Attitude indicator: sky and ground card that rolls and pitches behind a fixed orange aircraft
// symbol (v1 palette), a pitch ladder every 5 degrees, and a bank scale on the case with a
// pointer that turns with the card.
import { CENTER, dialAngle, drawCase, drawGlare, label, polar, clamp } from './gaugeKit.js';

const DEG = Math.PI / 180;
const PIXELS_PER_DEGREE = 2.4;
const FACE_RADIUS = 86;
const BANK_MARKS = [10, 20, 30, 45, 60];

function drawCard(pen, theme, pitch, roll) {
  pen.save();
  pen.beginPath();
  pen.arc(CENTER, CENTER, FACE_RADIUS, 0, Math.PI * 2);
  pen.clip();
  pen.translate(CENTER, CENTER);
  pen.rotate(-roll * DEG);
  pen.translate(0, clamp(pitch, -80, 80) * PIXELS_PER_DEGREE);
  const sky = pen.createLinearGradient(0, -260, 0, 0);
  sky.addColorStop(0, theme.skyHigh);
  sky.addColorStop(1, theme.sky);
  pen.fillStyle = sky;
  pen.fillRect(-260, -260, 520, 260);
  const ground = pen.createLinearGradient(0, 0, 0, 260);
  ground.addColorStop(0, theme.ground);
  ground.addColorStop(1, theme.groundLow);
  pen.fillStyle = ground;
  pen.fillRect(-260, 0, 520, 260);
  pen.strokeStyle = theme.horizon;
  pen.lineWidth = 2.4;
  pen.beginPath();
  pen.moveTo(-260, 0);
  pen.lineTo(260, 0);
  pen.stroke();

  // Pitch ladder: the rungs within +-35 degrees of the current pitch are drawn.
  pen.lineWidth = 1.8;
  const nearest = Math.round(pitch / 5) * 5;
  for (let rung = nearest - 35; rung <= nearest + 35; rung += 5) {
    if (rung === 0 || rung < -90 || rung > 90) continue;
    const y = -rung * PIXELS_PER_DEGREE;
    const half = rung % 10 === 0 ? 22 : 11;
    pen.beginPath();
    pen.moveTo(-half, y);
    pen.lineTo(half, y);
    pen.stroke();
    if (rung % 10 === 0) {
      label(pen, String(Math.abs(rung)), -half - 11, y, { size: 10.5, color: theme.horizon, weight: 650 });
      label(pen, String(Math.abs(rung)), half + 11, y, { size: 10.5, color: theme.horizon, weight: 650 });
    }
  }
  // Bank pointer: rides with the card, points up at the bank scale.
  pen.translate(0, -clamp(pitch, -80, 80) * PIXELS_PER_DEGREE);
  pen.beginPath();
  pen.moveTo(0, -FACE_RADIUS + 14);
  pen.lineTo(-7, -FACE_RADIUS + 26);
  pen.lineTo(7, -FACE_RADIUS + 26);
  pen.closePath();
  pen.fillStyle = theme.pointer;
  pen.fill();
  pen.restore();
}

function drawBankScale(pen, theme) {
  pen.strokeStyle = theme.tick;
  pen.lineCap = 'butt';
  for (const side of [-1, 1]) {
    for (const mark of BANK_MARKS) {
      const angle = dialAngle(side * mark);
      const long = mark === 30 || mark === 60;
      const [x0, y0] = polar(angle, FACE_RADIUS - (long ? 14 : 9));
      const [x1, y1] = polar(angle, FACE_RADIUS);
      pen.lineWidth = long ? 2.6 : 1.8;
      pen.beginPath();
      pen.moveTo(x0, y0);
      pen.lineTo(x1, y1);
      pen.stroke();
    }
  }
  // Zero-bank index.
  pen.beginPath();
  pen.moveTo(CENTER, CENTER - FACE_RADIUS + 12);
  pen.lineTo(CENTER - 6, CENTER - FACE_RADIUS + 1);
  pen.lineTo(CENTER + 6, CENTER - FACE_RADIUS + 1);
  pen.closePath();
  pen.fillStyle = theme.tick;
  pen.fill();
}

function drawSymbol(pen, theme) {
  pen.fillStyle = theme.accent;
  pen.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  pen.lineWidth = 1;
  for (const side of [-1, 1]) {
    pen.beginPath();
    pen.moveTo(CENTER + side * 16, CENTER - 2.5);
    pen.lineTo(CENTER + side * 46, CENTER - 2.5);
    pen.lineTo(CENTER + side * 46, CENTER + 2.5);
    pen.lineTo(CENTER + side * 22, CENTER + 2.5);
    pen.lineTo(CENTER + side * 16, CENTER + 10);
    pen.closePath();
    pen.fill();
    pen.stroke();
  }
  pen.beginPath();
  pen.arc(CENTER, CENTER, 3.6, 0, Math.PI * 2);
  pen.fill();
}

export default Object.freeze({
  id: 'attitude',
  label: 'Attitude',
  draw(pen, source, theme) {
    const { flight } = source;
    const pitch = Number.isFinite(flight.pitch) ? flight.pitch : 0;
    const roll = Number.isFinite(flight.roll) ? flight.roll : 0;
    drawCase(pen, theme, FACE_RADIUS);
    drawCard(pen, theme, pitch, roll);
    drawBankScale(pen, theme);
    drawSymbol(pen, theme);
    drawGlare(pen, theme, FACE_RADIUS);
  },
});
