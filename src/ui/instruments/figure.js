// Figure display (aerobatic): the figure the recognizer sees in progress (state.flight.craftState
// figureInProgress), else the last figure judged with its score as big digits and a score bar, plus
// the live load factor. Figures come from src/flight/maneuverRecognizer.js (contract h.3).
import { figureName } from '../../flight/maneuverRecognizer.js';
import { CENTER, drawPlate, label, digital, roundRect, clamp } from './gaugeKit.js';

/** The score bar's colour bands: excellent, good, ragged. */
function scoreColour(score, theme) {
  if (score >= 85) return theme.teal;
  if (score >= 60) return theme.yellow;
  return theme.accent;
}

export default Object.freeze({
  id: 'figure',
  label: 'Figure',
  draw(pen, source, theme) {
    const { flight } = source;
    const craftState = flight.craftState || {};
    drawPlate(pen, theme);
    const inProgress = figureName(craftState.figureInProgress);
    const last = craftState.lastFigure && figureName(craftState.lastFigure.figure) ? craftState.lastFigure : null;
    label(pen, inProgress ? 'FLYING' : 'LAST FIGURE', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    if (inProgress) {
      label(pen, inProgress.toUpperCase(), CENTER, 70, { size: 18, color: theme.teal, weight: 750, spacing: 1 });
    } else if (last) {
      label(pen, figureName(last.figure).toUpperCase(), CENTER, 58, { size: 16, color: theme.text, weight: 700, spacing: 1 });
      digital(pen, `${Math.round(last.score)}`, CENTER - 34, 74, 68, 34, theme, { size: 24, color: scoreColour(last.score, theme) });
      pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
      roundRect(pen, 30, 116, 140, 10, 4);
      pen.fill();
      pen.fillStyle = scoreColour(last.score, theme);
      roundRect(pen, 30, 116, Math.max(8, 140 * clamp(last.score / 100, 0, 1)), 10, 4);
      pen.fill();
    } else {
      label(pen, 'NONE YET', CENTER, 70, { size: 16, color: theme.textDim, weight: 700, spacing: 1.2 });
    }
    const load = Number.isFinite(flight.gLoad) ? flight.gLoad : 1;
    label(pen, 'LOAD', 30, 156, { size: 10.5, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    digital(pen, `${load.toFixed(1)} g`, 84, 142, 86, 28, theme, { size: 15, color: Math.abs(load) > 8.5 ? theme.red : null });
  },
});
