// SIM virtual-stick reticle. With the mouse captured in SIM, the mouse is a free virtual stick whose
// offset from the screen centre is the deflection (ctx.systems.input.getStick(): x right / y down in
// -1..1, the virtual cursor at (x, y) * fullDeflectionPixels from the centre). This draws that
// cursor as a small gold dot with a hairline from the centre, inside a faint ring marking full
// deflection. When the full-deflection radius would not fit the screen, the whole reticle is drawn
// to scale inside 45 % of the shorter screen side.
import './stickReticle.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_RADIUS_SHARE = 0.45;
const CENTRE_MARK = 5;
const MIN_CHANGE_PIXELS = 0.25;

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function createStickReticle(ctx) {
  const host = document.getElementById('ui-root') || document.body;
  const container = document.createElement('div');
  container.className = 'dw-stick-reticle';
  container.setAttribute('aria-hidden', 'true');
  container.hidden = true;
  const svg = svgElement('svg', { width: 1, height: 1 });
  const ring = svgElement('circle', { class: 'dw-reticle-ring', cx: 0, cy: 0, r: 100 });
  const centre = svgElement('path', { class: 'dw-reticle-centre', d: `M${-CENTRE_MARK} 0H${CENTRE_MARK}M0 ${-CENTRE_MARK}V${CENTRE_MARK}` });
  const line = svgElement('line', { class: 'dw-reticle-line', x1: 0, y1: 0, x2: 0, y2: 0 });
  const dot = svgElement('circle', { class: 'dw-reticle-dot', cx: 0, cy: 0, r: 3.5 });
  svg.append(ring, centre, line, dot);
  container.appendChild(svg);
  host.appendChild(container);

  const drawn = { radius: -1, x: NaN, y: NaN };
  const stats = { visible: false, x: 0, y: 0, radius: 0, scale: 1 };

  function shouldShow(stick) {
    const flight = ctx.systems.flight;
    const sim = Boolean(flight && typeof flight.getMode === 'function' && flight.getMode() === 'sim');
    return sim && Boolean(stick && stick.locked && stick.mode === 'free') && !ctx.state.photoMode;
  }

  return {
    /** Per frame: shows, hides and moves the reticle. */
    update() {
      const input = ctx.systems.input;
      const stick = input && typeof input.getStick === 'function' ? input.getStick() : null;
      const visible = shouldShow(stick);
      stats.visible = visible;
      if (!visible) {
        container.hidden = true;
        return;
      }
      container.hidden = false;
      const full = Number.isFinite(stick.fullDeflectionPixels) && stick.fullDeflectionPixels > 0 ? stick.fullDeflectionPixels : 260;
      const limit = Math.min(window.innerWidth, window.innerHeight) * MAX_RADIUS_SHARE;
      const scale = Math.min(1, limit / full);
      const radius = full * scale;
      const x = (Number.isFinite(stick.x) ? stick.x : 0) * radius;
      const y = (Number.isFinite(stick.y) ? stick.y : 0) * radius;
      stats.x = x;
      stats.y = y;
      stats.radius = radius;
      stats.scale = scale;
      if (Math.abs(radius - drawn.radius) > MIN_CHANGE_PIXELS) {
        drawn.radius = radius;
        ring.setAttribute('r', radius.toFixed(1));
      }
      if (Math.abs(x - drawn.x) > MIN_CHANGE_PIXELS || Math.abs(y - drawn.y) > MIN_CHANGE_PIXELS || Number.isNaN(drawn.x)) {
        drawn.x = x;
        drawn.y = y;
        dot.setAttribute('cx', x.toFixed(1));
        dot.setAttribute('cy', y.toFixed(1));
        line.setAttribute('x2', x.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
      }
    },

    getStats() {
      return { ...stats };
    },
  };
}
