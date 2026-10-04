// Gauge drawing kit shared by every instrument renderer.
//
// Instruments draw in a 200 x 200 design box (centre 100, 100); the caller scales the canvas so one
// design unit maps to whatever pixel size the panel texture or HUD tile uses. Two themes:
//   panel: a real steam gauge (black face, white markings, dark bezel with mounting screws, a faint
//          glass glare), drawn onto the cockpit panel texture;
//   glass: the v1 HUD look (no face, warm cream markings, gold needle, digital readouts), drawn
//          onto transparent HUD tiles that sit on the v1 glass background.
// Angles: dialAngle(degrees) takes degrees clockwise from 12 o'clock and returns canvas radians.

const DEG = Math.PI / 180;
export const DESIGN_SIZE = 200;
export const CENTER = 100;
export const FONT_FAMILY = '"Inter", "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

export const THEMES = Object.freeze({
  panel: Object.freeze({
    id: 'panel',
    bezel: '#26282e',
    bezelLight: '#4b4e58',
    bezelDark: '#101114',
    face: '#121317',
    faceEdge: '#08090b',
    screw: '#3a3d45',
    tick: '#f1eee6',
    text: '#f1eee6',
    textDim: '#a8a69e',
    needle: '#f6f3ea',
    pointer: '#e0703a',
    accent: '#e0703a',
    green: '#35a852',
    yellow: '#e6c142',
    red: '#d8412c',
    white: '#f1eee6',
    teal: '#6cc6c9',
    sky: '#3a78bd',
    skyHigh: '#1f4f8c',
    ground: '#8a5a32',
    groundLow: '#5a3a1e',
    horizon: '#f6f3ea',
    lampOff: '#2a2c31',
    digitalBack: '#050607',
    digitalText: '#f3c77a',
    plate: '#1b1d22',
    glare: true,
  }),
  glass: Object.freeze({
    id: 'glass',
    bezel: null,
    face: 'rgba(12, 9, 16, 0.18)',
    faceEdge: 'rgba(255, 240, 220, 0.22)',
    tick: 'rgba(246, 239, 228, 0.92)',
    text: '#f6efe4',
    textDim: 'rgba(246, 239, 228, 0.66)',
    needle: '#f3c77a',
    pointer: '#f3c77a',
    accent: '#e0703a',
    green: '#8fd3d6',
    yellow: '#f3c77a',
    red: '#f2a37e',
    white: 'rgba(246, 239, 228, 0.85)',
    teal: '#8fd3d6',
    sky: 'rgba(92, 150, 205, 0.62)',
    skyHigh: 'rgba(58, 96, 160, 0.62)',
    ground: 'rgba(160, 108, 64, 0.62)',
    groundLow: 'rgba(104, 70, 40, 0.62)',
    horizon: '#f6efe4',
    lampOff: 'rgba(255, 240, 220, 0.12)',
    digitalBack: 'rgba(8, 6, 12, 0.34)',
    digitalText: '#f6efe4',
    plate: 'rgba(12, 9, 16, 0.18)',
    glare: false,
  }),
});

/** Degrees clockwise from 12 o'clock -> canvas radians (0 = 3 o'clock, clockwise positive). */
export function dialAngle(degrees) {
  return (degrees - 90) * DEG;
}

export function polar(angle, radius) {
  return [CENTER + Math.cos(angle) * radius, CENTER + Math.sin(angle) * radius];
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function font(size, weight = 600) {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

/** Text centred (or aligned) at x, y. */
export function label(pen, text, x, y, { size = 14, color = '#fff', weight = 600, align = 'center', baseline = 'middle', spacing = 0 } = {}) {
  pen.font = font(size, weight);
  pen.fillStyle = color;
  pen.textAlign = align;
  pen.textBaseline = baseline;
  if ('letterSpacing' in pen) pen.letterSpacing = `${spacing}px`;
  pen.fillText(text, x, y);
  if ('letterSpacing' in pen) pen.letterSpacing = '0px';
}

/**
 * Gauge case: panel theme draws the square mounting plate screws, the bezel ring and the black
 * face; glass theme a hairline ring on a faint tint. radius is the face radius.
 */
export function drawCase(pen, theme, radius = 90) {
  if (theme.bezel) {
    for (const [x, y] of [[14, 14], [186, 14], [14, 186], [186, 186]]) {
      pen.beginPath();
      pen.arc(x, y, 6, 0, Math.PI * 2);
      pen.fillStyle = theme.screw;
      pen.fill();
      pen.strokeStyle = theme.bezelDark;
      pen.lineWidth = 1.6;
      pen.beginPath();
      pen.moveTo(x - 4, y - 1.5);
      pen.lineTo(x + 4, y + 1.5);
      pen.stroke();
    }
    const ring = pen.createLinearGradient(0, 4, 0, 196);
    ring.addColorStop(0, theme.bezelLight);
    ring.addColorStop(0.5, theme.bezel);
    ring.addColorStop(1, theme.bezelDark);
    pen.beginPath();
    pen.arc(CENTER, CENTER, radius + 8, 0, Math.PI * 2);
    pen.fillStyle = ring;
    pen.fill();
    const face = pen.createRadialGradient(CENTER, CENTER - 20, radius * 0.2, CENTER, CENTER, radius);
    face.addColorStop(0, theme.face);
    face.addColorStop(1, theme.faceEdge);
    pen.beginPath();
    pen.arc(CENTER, CENTER, radius, 0, Math.PI * 2);
    pen.fillStyle = face;
    pen.fill();
    return;
  }
  pen.beginPath();
  pen.arc(CENTER, CENTER, radius, 0, Math.PI * 2);
  pen.fillStyle = theme.face;
  pen.fill();
  pen.lineWidth = 1.5;
  pen.strokeStyle = theme.faceEdge;
  pen.stroke();
}

/** Glass glare over a panel gauge (a soft highlight along the upper-left of the cover glass). */
export function drawGlare(pen, theme, radius = 90) {
  if (!theme.glare) return;
  pen.save();
  pen.beginPath();
  pen.arc(CENTER, CENTER, radius, 0, Math.PI * 2);
  pen.clip();
  const glare = pen.createLinearGradient(30, 20, 120, 120);
  glare.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
  glare.addColorStop(0.45, 'rgba(255, 255, 255, 0.03)');
  glare.addColorStop(0.46, 'rgba(255, 255, 255, 0)');
  pen.fillStyle = glare;
  pen.fillRect(0, 0, DESIGN_SIZE, DESIGN_SIZE);
  pen.restore();
}

/** Radial tick marks for every step between from and to (value -> angle through toAngle). */
export function ticks(pen, { from, to, step, toAngle, inner, outer, width = 2, color }) {
  pen.strokeStyle = color;
  pen.lineWidth = width;
  pen.lineCap = 'butt';
  pen.beginPath();
  const count = Math.round((to - from) / step);
  for (let index = 0; index <= count; index++) {
    const angle = toAngle(from + index * step);
    const [x0, y0] = polar(angle, inner);
    const [x1, y1] = polar(angle, outer);
    pen.moveTo(x0, y0);
    pen.lineTo(x1, y1);
  }
  pen.stroke();
}

/** Numerals at the given values, upright, on a circle of radius. */
export function numerals(pen, values, { toAngle, radius, size = 16, color, format = String, weight = 600 }) {
  pen.font = font(size, weight);
  pen.fillStyle = color;
  pen.textAlign = 'center';
  pen.textBaseline = 'middle';
  for (const value of values) {
    const [x, y] = polar(toAngle(value), radius);
    pen.fillText(format(value), x, y + 0.5);
  }
}

/** A coloured band along the dial between two values. */
export function arcBand(pen, { from, to, toAngle, radius, width, color }) {
  if (!(to > from)) return;
  pen.beginPath();
  pen.arc(CENTER, CENTER, radius, toAngle(from), toAngle(to), false);
  pen.strokeStyle = color;
  pen.lineWidth = width;
  pen.lineCap = 'butt';
  pen.stroke();
}

/** A radial line across the band (red line, limit marks). */
export function radial(pen, angle, inner, outer, color, width = 3) {
  const [x0, y0] = polar(angle, inner);
  const [x1, y1] = polar(angle, outer);
  pen.beginPath();
  pen.moveTo(x0, y0);
  pen.lineTo(x1, y1);
  pen.strokeStyle = color;
  pen.lineWidth = width;
  pen.lineCap = 'butt';
  pen.stroke();
}

/** A tapered needle from the hub, with a short counterweight tail and a hub cap. */
export function needle(pen, angle, { length = 78, tail = 16, width = 5, color, hub = 8, hubColor = null }) {
  pen.save();
  pen.translate(CENTER, CENTER);
  pen.rotate(angle);
  pen.beginPath();
  pen.moveTo(-tail, -width * 0.6);
  pen.lineTo(length - 6, -width * 0.32);
  pen.lineTo(length, 0);
  pen.lineTo(length - 6, width * 0.32);
  pen.lineTo(-tail, width * 0.6);
  pen.closePath();
  pen.fillStyle = color;
  pen.shadowColor = 'rgba(0, 0, 0, 0.45)';
  pen.shadowBlur = 3;
  pen.shadowOffsetY = 1.5;
  pen.fill();
  pen.restore();
  if (hub > 0) {
    pen.beginPath();
    pen.arc(CENTER, CENTER, hub, 0, Math.PI * 2);
    pen.fillStyle = hubColor || '#2b2d33';
    pen.fill();
  }
}

/** A small digital readout window with centred (or left / right aligned) text. */
export function digital(pen, text, x, y, width, height, theme, { color = null, size = null, align = 'center' } = {}) {
  pen.fillStyle = theme.digitalBack;
  roundRect(pen, x, y, width, height, 4);
  pen.fill();
  if (theme.id === 'panel') {
    pen.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    pen.lineWidth = 1;
    pen.stroke();
  }
  const textSize = size || Math.round(height * 0.72);
  const textX = align === 'right' ? x + width - 5 : align === 'left' ? x + 5 : x + width / 2;
  label(pen, text, textX, y + height / 2 + 1, { size: textSize, color: color || theme.digitalText, weight: 650, align });
}

export function roundRect(pen, x, y, width, height, radius) {
  pen.beginPath();
  pen.moveTo(x + radius, y);
  pen.lineTo(x + width - radius, y);
  pen.arcTo(x + width, y, x + width, y + radius, radius);
  pen.lineTo(x + width, y + height - radius);
  pen.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  pen.lineTo(x + radius, y + height);
  pen.arcTo(x, y + height, x, y + height - radius, radius);
  pen.lineTo(x, y + radius);
  pen.arcTo(x, y, x + radius, y, radius);
  pen.closePath();
}

/** A round indicator lamp (lit colour or the theme's dark lens). */
export function lamp(pen, x, y, radius, lit, colour, theme) {
  pen.beginPath();
  pen.arc(x, y, radius, 0, Math.PI * 2);
  pen.fillStyle = lit ? colour : theme.lampOff;
  if (lit) {
    pen.shadowColor = colour;
    pen.shadowBlur = theme.id === 'panel' ? 8 : 6;
  }
  pen.fill();
  pen.shadowBlur = 0;
  pen.lineWidth = 1.2;
  pen.strokeStyle = theme.id === 'panel' ? '#000' : 'rgba(255, 240, 220, 0.2)';
  pen.stroke();
}

/**
 * A rectangular instrument plate (non-round instruments: throttle quadrant, flap and gear panel,
 * digital computers). Panel theme: screwed plate with a recessed black face; glass: nothing, the
 * HUD tile is the plate.
 */
export function drawPlate(pen, theme) {
  if (theme.id !== 'panel') return;
  pen.fillStyle = theme.plate;
  roundRect(pen, 4, 4, 192, 192, 10);
  pen.fill();
  pen.fillStyle = theme.face;
  roundRect(pen, 14, 14, 172, 172, 7);
  pen.fill();
  pen.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  pen.lineWidth = 2;
  pen.stroke();
  for (const [x, y] of [[9, 9], [191, 9], [9, 191], [191, 191]]) {
    pen.beginPath();
    pen.arc(x, y, 3.2, 0, Math.PI * 2);
    pen.fillStyle = theme.screw;
    pen.fill();
  }
}

/** Instrument title along the top of the face (small caps, spaced). */
export function title(pen, text, theme, y = 56) {
  label(pen, text, CENTER, y, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
}

/** A value mapped linearly onto a dial sweep: returns value -> canvas angle. */
export function linearDial(min, max, startDegrees, sweepDegrees) {
  return (value) => dialAngle(startDegrees + (clamp(value, min, max) - min) / (max - min) * sweepDegrees);
}
