// Wingsuit glide display: the glide ratio over the ground as a large "2.5 : 1" readout, and the
// horizontal and vertical speeds that make it, each as a bar with its value in the chosen units.
import { CENTER, drawPlate, label, digital, roundRect, clamp } from './gaugeKit.js';

function bar(g, theme, y, fraction, colour) {
  g.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
  roundRect(g, 22, y, 100, 12, 5);
  g.fill();
  g.fillStyle = colour;
  roundRect(g, 22, y, Math.max(8, 100 * clamp(fraction, 0, 1)), 12, 5);
  g.fill();
}

export default Object.freeze({
  id: 'glide',
  label: 'Glide',
  draw(g, source, theme) {
    const { flight, units } = source;
    drawPlate(g, theme);
    label(g, 'GLIDE', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    const ratio = flight.glideRatio;
    const text = ratio > 0 && Number.isFinite(ratio) ? `${Math.min(ratio, 9.9).toFixed(1)} : 1` : '-- : 1';
    digital(g, text, CENTER - 60, 42, 120, 44, theme, { size: 28 });
    const horizontal = Number.isFinite(flight.groundSpeed) ? flight.groundSpeed : 0;
    const vertical = Number.isFinite(flight.verticalSpeed) ? flight.verticalSpeed : 0;
    label(g, 'FORWARD', 22, 104, { size: 10, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    bar(g, theme, 112, horizontal / 70, theme.teal);
    digital(g, `${Math.round(horizontal * units.speed.factor)}`, 128, 104, 50, 24, theme, { size: 14 });
    label(g, units.speed.label, 153, 136, { size: 9.5, color: theme.textDim, weight: 650 });
    label(g, 'SINK', 22, 150, { size: 10, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    bar(g, theme, 158, -vertical / 40, theme.yellow);
    const sink = -vertical * units.vertical.factor;
    digital(g, units.system === 'aviation' ? `${Math.round(sink / 10) * 10}` : sink.toFixed(1), 128, 150, 50, 24, theme, { size: 14 });
    label(g, units.vertical.label, 153, 182, { size: 9.5, color: theme.textDim, weight: 650 });
  },
});
