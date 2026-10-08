// Wing display (paraglider): the canopy seen from behind as an arc of cells, its tips drawn folded for
// big ears and each side's collapse in red, the two brakes as bars on either side, the speed bar as a
// bar between them, the lines' swing (pendulum) as a small tilt marker, and the wing's state in words
// (TRIM, SPEED BAR, BIG EARS, COLLAPSE, STALL, LANDED, LAUNCH). Everything comes from
// state.flight.craftState (brakeLeft, brakeRight, speedBar, earsFold, collapse, pendulum, phase,
// stalled).
import { CENTER, drawPlate, label, roundRect, clamp } from './gaugeKit.js';

const CELLS = 9;
const ARC = Object.freeze({ X: CENTER, Y: 112, RADIUS: 78, HALF_ANGLE: 0.78, THICKNESS: 12 });
const BAR = Object.freeze({ TOP: 92, HEIGHT: 74, WIDTH: 14 });

function well(pen, theme, x, y, width, height) {
  pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
  roundRect(pen, x, y, width, height, 4);
  pen.fill();
}

/** A vertical bar filling down from the top (brakes) or up from the bottom (speed bar). */
function verticalBar(pen, theme, x, fraction, colour, fromTop) {
  well(pen, theme, x, BAR.TOP, BAR.WIDTH, BAR.HEIGHT);
  const height = Math.max(3, BAR.HEIGHT * clamp(fraction, 0, 1));
  pen.fillStyle = colour;
  roundRect(pen, x, fromTop ? BAR.TOP : BAR.TOP + BAR.HEIGHT - height, BAR.WIDTH, height, 4);
  pen.fill();
}

/** One cell of the arc between two angles (radians from straight up), outer and inner radius. */
function cell(pen, from, to, inner, outer) {
  pen.beginPath();
  pen.arc(ARC.X, ARC.Y, outer, from - Math.PI / 2, to - Math.PI / 2);
  pen.arc(ARC.X, ARC.Y, inner, to - Math.PI / 2, from - Math.PI / 2, true);
  pen.closePath();
}

function stateText(craftState, theme) {
  const collapse = craftState.collapse || { left: 0, right: 0 };
  if (craftState.phase === 'landed') return { text: 'LANDED', colour: theme.textDim };
  if (craftState.phase === 'launch') return { text: 'LAUNCH', colour: theme.yellow };
  if (craftState.stalled) return { text: 'STALL', colour: theme.red };
  if (collapse.left > 0.05 || collapse.right > 0.05) return { text: collapse.left >= collapse.right ? 'COLLAPSE L' : 'COLLAPSE R', colour: theme.red };
  if ((craftState.earsFold || 0) > 0.05) return { text: 'BIG EARS', colour: theme.yellow };
  if ((craftState.speedBar || 0) > 0.05) return { text: `BAR ${Math.round(craftState.speedBar * 100)}%`, colour: theme.teal };
  return { text: 'TRIM', colour: theme.green };
}

export default Object.freeze({
  id: 'speedBar',
  label: 'Wing',
  draw(pen, source, theme) {
    const craftState = source.flight.craftState || {};
    drawPlate(pen, theme);
    label(pen, 'WING', CENTER, 26, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });

    // The canopy from behind: cells on an arc, the outer ones folded down for big ears, a collapsed
    // side's cells (from its tip inward) in red, the whole arc tilted with the lines' swing.
    const ears = clamp(Number(craftState.earsFold) || 0, 0, 1);
    const collapse = craftState.collapse || { left: 0, right: 0 };
    const pendulum = clamp(Number(craftState.pendulum) || 0, -40, 40);
    pen.save();
    pen.translate(ARC.X, ARC.Y);
    pen.rotate(pendulum * 0.004);
    pen.translate(-ARC.X, -ARC.Y);
    const span = (2 * ARC.HALF_ANGLE) / CELLS;
    for (let index = 0; index < CELLS; index++) {
      const from = -ARC.HALF_ANGLE + index * span;
      const to = from + span;
      const along = (from + to) / (2 * ARC.HALF_ANGLE);
      const side = along < 0 ? clamp(Number(collapse.left) || 0, 0, 1) : clamp(Number(collapse.right) || 0, 0, 1);
      const collapsed = Math.abs(along) * 2 > 1 - 1.7 * side + 0.02 && side > 0.02;
      const folded = ears > 0.05 && Math.abs(along) * 2 > 0.66;
      const drop = folded ? ears * 14 : collapsed ? 16 : 0;
      cell(pen, from + 0.01, to - 0.01, ARC.RADIUS - ARC.THICKNESS - drop, ARC.RADIUS - drop);
      pen.fillStyle = collapsed ? theme.red : folded ? theme.textDim : index % 2 === 0 ? theme.accent : theme.white;
      pen.fill();
    }
    pen.restore();

    // Brakes either side (filling down as they are pulled), the speed bar between (filling up).
    const brakeLeft = clamp(Number(craftState.brakeLeft) || 0, 0, 1);
    const brakeRight = clamp(Number(craftState.brakeRight) || 0, 0, 1);
    const bar = clamp(Number(craftState.speedBar) || 0, 0, 1);
    verticalBar(pen, theme, 30, brakeLeft, theme.yellow, true);
    verticalBar(pen, theme, 156, brakeRight, theme.yellow, true);
    verticalBar(pen, theme, CENTER - BAR.WIDTH / 2, bar, theme.teal, false);
    label(pen, 'L', 37, 176, { size: 10, color: theme.textDim, weight: 700 });
    label(pen, 'R', 163, 176, { size: 10, color: theme.textDim, weight: 700 });
    label(pen, 'BAR', CENTER, 176, { size: 10, color: theme.textDim, weight: 700, spacing: 1 });
    const state = stateText(craftState, theme);
    label(pen, state.text, CENTER, 46, { size: 15, color: state.colour, weight: 750, spacing: 1.2 });
  },
});
