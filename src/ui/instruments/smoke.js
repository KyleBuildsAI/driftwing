// Smoke system display (aerobatic): SMOKE with its ON lamp, the colour swatches of SMOKE_COLORS with
// the selected one ringed, and the colour's name. Reads state.flight.craftState.smoke and smokeColor
// (contract h.3); Space switches the smoke, Shift+Space cycles the colour.
import { SMOKE_COLORS } from '../../flight/trails.js';
import { CENTER, drawPlate, label, lamp, roundRect } from './gaugeKit.js';

const SWATCHES = Object.freeze(SMOKE_COLORS.map((colour) => Object.freeze({
  name: colour.id.toUpperCase(),
  fill: `rgb(${colour.tint.map((channel) => Math.round(channel * 255)).join(', ')})`,
})));
const SWATCH = Object.freeze({ SIZE: 22, GAP: 6, Y: 96 });

function selectedIndex(craftState) {
  const index = Number.isInteger(craftState.smokeColor) ? craftState.smokeColor : 0;
  return ((index % SWATCHES.length) + SWATCHES.length) % SWATCHES.length;
}

export default Object.freeze({
  id: 'smoke',
  label: 'Smoke',
  draw(pen, source, theme) {
    const craftState = source.flight.craftState || {};
    const on = craftState.smoke === true;
    const selected = selectedIndex(craftState);
    drawPlate(pen, theme);
    label(pen, 'SMOKE', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    lamp(pen, 66, 60, 8, on, theme.teal, theme);
    label(pen, on ? 'ON' : 'OFF', 82, 60, { size: 22, color: on ? theme.teal : theme.textDim, weight: 750, align: 'left', spacing: 1 });
    const total = SWATCHES.length * SWATCH.SIZE + (SWATCHES.length - 1) * SWATCH.GAP;
    const left = CENTER - total / 2;
    for (let index = 0; index < SWATCHES.length; index++) {
      const x = left + index * (SWATCH.SIZE + SWATCH.GAP);
      pen.fillStyle = SWATCHES[index].fill;
      roundRect(pen, x, SWATCH.Y, SWATCH.SIZE, SWATCH.SIZE, 4);
      pen.fill();
      if (index === selected) {
        pen.strokeStyle = on ? theme.teal : theme.text;
        pen.lineWidth = 3;
        roundRect(pen, x - 4, SWATCH.Y - 4, SWATCH.SIZE + 8, SWATCH.SIZE + 8, 6);
        pen.stroke();
      }
    }
    label(pen, SWATCHES[selected].name, CENTER, 150, { size: 17, color: theme.text, weight: 700, spacing: 1.4 });
    label(pen, 'SPACE · SHIFT+SPACE', CENTER, 176, { size: 9.5, color: theme.textDim, weight: 600, spacing: 0.8 });
  },
});
