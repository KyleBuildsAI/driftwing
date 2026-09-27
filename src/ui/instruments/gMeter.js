// Accelerometer (G meter): load factor with red limit lines at the craft's structural limit
// (craft.limits.gLimit) and at 40 % of it negative, plus the orange tell-tale needles that keep
// the highest and lowest load since the last reset (craft change or soft crash).
import { CENTER, drawCase, drawGlare, ticks, numerals, radial, needle, label, digital, title, linearDial } from './gaugeKit.js';

export default Object.freeze({
  id: 'g',
  label: 'G meter',
  createMemory() {
    return { peak: 1, low: 1 };
  },
  reset(memory) {
    memory.peak = 1;
    memory.low = 1;
  },
  update(memory, dt, source) {
    const load = source.flight.gLoad;
    if (!Number.isFinite(load) || source.flight.crash?.active) return;
    memory.peak = Math.max(memory.peak, load);
    memory.low = Math.min(memory.low, load);
  },
  draw(g, source, theme, memory) {
    const { flight, craft } = source;
    const limit = craft.limits && Number.isFinite(craft.limits.gLimit) ? craft.limits.gLimit : 6;
    const maximum = Math.max(6, Math.ceil(limit) + 2);
    const minimum = -3;
    const toAngle = linearDial(minimum, maximum, -150, 300);
    drawCase(g, theme);
    ticks(g, { from: minimum, to: maximum, step: 0.5, toAngle, inner: 80, outer: 88, width: 1.4, color: theme.tick });
    ticks(g, { from: minimum, to: maximum, step: 1, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    const labels = [];
    for (let value = minimum; value <= maximum; value += maximum > 10 ? 2 : 1) labels.push(value);
    numerals(g, labels, { toAngle, radius: 58, size: 15, color: theme.text });
    radial(g, toAngle(limit), 70, 90, theme.red, 4);
    radial(g, toAngle(-limit * 0.4), 70, 90, theme.red, 4);
    title(g, 'G', theme, 72);
    label(g, 'ACCEL', CENTER, 128, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
    const load = Number.isFinite(flight.gLoad) ? flight.gLoad : 1;
    if (theme.id === 'glass') digital(g, `${load.toFixed(1)} G`, CENTER - 30, 140, 60, 22, theme, { size: 14 });
    needle(g, toAngle(memory.peak), { length: 76, tail: 0, width: 3, color: theme.accent, hub: 0 });
    needle(g, toAngle(memory.low), { length: 76, tail: 0, width: 3, color: theme.accent, hub: 0 });
    needle(g, toAngle(load), { length: 80, color: theme.needle });
    drawGlare(g, theme);
  },
});
