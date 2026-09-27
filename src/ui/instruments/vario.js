// Total-energy variometer (gliders): state.flight.vario (climb corrected for speed changes) on a
// linear +-5 m/s (+-1000 fpm) dial, with a 20 second averager shown as a marker on the dial and
// in the digital window, as on a real glider vario.
import { polar } from './gaugeKit.js';
import { drawVerticalDial } from './vsi.js';
import { signed } from './units.js';

const AVERAGE_SECONDS = 20;

export default Object.freeze({
  id: 'vario',
  label: 'Variometer',
  createMemory() {
    return { average: 0, primed: false };
  },
  reset(memory) {
    memory.average = 0;
    memory.primed = false;
  },
  update(memory, dt, source) {
    const vario = source.flight.vario;
    if (!Number.isFinite(vario)) return;
    if (!memory.primed) {
      memory.average = vario;
      memory.primed = true;
      return;
    }
    memory.average += (vario - memory.average) * (1 - Math.exp(-dt / AVERAGE_SECONDS));
  },
  draw(g, source, theme, memory) {
    const { flight, units } = source;
    const aviation = units.system === 'aviation';
    const factor = units.vertical.factor;
    const value = Number.isFinite(flight.vario) ? flight.vario * factor : 0;
    const average = memory.average * factor;
    const toAngle = drawVerticalDial(g, theme, {
      value,
      maximum: aviation ? 1000 : 5,
      knee: null,
      labels: aviation ? [0, 200, 400, 600, 800, 1000] : [0, 1, 2, 3, 4, 5],
      minorStep: aviation ? 100 : 0.5,
      format: aviation ? (label) => String(label / 100) : String,
      caption: 'TE VARIO',
      unitCaption: aviation ? '×100 FPM' : 'M/S',
      digitalText: `ø ${aviation ? signed(Math.round(average / 10) * 10, 0) : signed(average, 1)}`,
      alwaysDigital: true,
      needleColor: theme.id === 'panel' ? '#f3c77a' : theme.needle,
    });
    // Averager marker: a hollow triangle on the rim.
    const angle = toAngle(average);
    const [tipX, tipY] = polar(angle, 70);
    const [leftX, leftY] = polar(angle - 0.08, 86);
    const [rightX, rightY] = polar(angle + 0.08, 86);
    g.beginPath();
    g.moveTo(tipX, tipY);
    g.lineTo(leftX, leftY);
    g.lineTo(rightX, rightY);
    g.closePath();
    g.lineWidth = 2;
    g.strokeStyle = theme.teal;
    g.stroke();
  },
});
