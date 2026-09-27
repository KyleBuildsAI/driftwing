// Ground proximity (wingsuit): height above the ground or water, coloured by band, the lowest
// clearance along the next five seconds of the flight path (the shared height function, sampled
// every half second along the current velocity), and a flashing PULL UP when that path meets the
// terrain within three seconds.
import { CENTER, drawPlate, label, digital, roundRect, clamp } from './gaugeKit.js';
import { grouped } from './units.js';

const LOOKAHEAD_SECONDS = 5;
const SAMPLE_SECONDS = 0.5;
const PULL_UP_SECONDS = 3;

export default Object.freeze({
  id: 'proximity',
  label: 'Ground proximity',
  createMemory() {
    return { clearance: Infinity, impactSeconds: Infinity, blink: 0 };
  },
  reset(memory) {
    memory.clearance = Infinity;
    memory.impactSeconds = Infinity;
    memory.blink = 0;
  },
  update(memory, dt, source) {
    const { flight, world, waterLevel } = source;
    memory.blink = (memory.blink + dt) % 1;
    const position = flight.position;
    const velocity = flight.velocity;
    if (!world || !position || !velocity) return;
    let clearance = Infinity;
    let impactSeconds = Infinity;
    for (let time = SAMPLE_SECONDS; time <= LOOKAHEAD_SECONDS + 1e-6; time += SAMPLE_SECONDS) {
      const x = position.x + velocity.x * time;
      const z = position.z + velocity.z * time;
      const floor = Math.max(world.groundHeight(x, z), waterLevel);
      const gap = position.y + velocity.y * time - floor;
      if (gap < clearance) clearance = gap;
      if (gap <= 0 && time < impactSeconds) impactSeconds = time;
    }
    memory.clearance = clearance;
    memory.impactSeconds = impactSeconds;
  },
  draw(pen, source, theme, memory) {
    const { flight, units } = source;
    const factor = units.altitude.factor;
    const height = Number.isFinite(flight.agl) ? flight.agl : 0;
    const band = height < 50 ? theme.red : height < 150 ? theme.yellow : theme.green;
    drawPlate(pen, theme);
    label(pen, 'PROXIMITY', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    digital(pen, grouped(Math.max(0, height) * factor), CENTER - 56, 42, 112, 44, theme, { size: 30, color: band });
    label(pen, `AGL ${units.altitude.label}`, CENTER, 96, { size: 10, color: theme.textDim, weight: 650, spacing: 1 });
    const clearance = memory.clearance;
    const fraction = Number.isFinite(clearance) ? clamp(clearance / 200, 0, 1) : 1;
    pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(pen, 22, 112, 156, 12, 5);
    pen.fill();
    pen.fillStyle = clearance < 20 ? theme.red : clearance < 60 ? theme.yellow : theme.teal;
    roundRect(pen, 22, 112, Math.max(8, 156 * fraction), 12, 5);
    pen.fill();
    const aheadText = Number.isFinite(clearance) ? `${grouped(Math.max(0, clearance) * factor)} ${units.altitude.label}` : '--';
    label(pen, 'PATH 5 S', 22, 138, { size: 10, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    label(pen, aheadText, 178, 138, { size: 12, color: theme.text, weight: 650, align: 'right' });
    const warning = memory.impactSeconds <= PULL_UP_SECONDS;
    if (warning && memory.blink < 0.6) {
      pen.fillStyle = theme.red;
      roundRect(pen, 34, 152, 132, 30, 6);
      pen.fill();
      label(pen, 'PULL UP', CENTER, 168, { size: 17, color: '#fff7ee', weight: 800, spacing: 2 });
    } else if (!warning) {
      label(pen, Number.isFinite(memory.impactSeconds) ? `IMPACT ${memory.impactSeconds.toFixed(1)} S` : 'PATH CLEAR', CENTER, 168, { size: 11, color: theme.textDim, weight: 700, spacing: 1.4 });
    }
  },
});
