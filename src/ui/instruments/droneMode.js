// Drone flight-mode display (FPV quad): the controller mode, RATE (acro) or ANGLE (self-levelling,
// with ALT HOLD when the craft reports altitude hold), the throttle as a bar, and DISARMED while the
// motors are off. The mode comes from state.flight.craftState.droneMode ('rate' | 'angle'); a craft
// that does not report it follows the assists rule (angle mode at full assists).
import { CENTER, drawPlate, label, digital, roundRect, lamp, clamp } from './gaugeKit.js';

function droneModeOf(flight) {
  const craftState = flight.craftState || {};
  if (craftState.droneMode === 'rate' || craftState.droneMode === 'angle') return craftState.droneMode;
  return flight.assists >= 0.999 ? 'angle' : 'rate';
}

export default Object.freeze({
  id: 'droneMode',
  label: 'Flight mode',
  draw(g, source, theme) {
    const { flight } = source;
    const mode = droneModeOf(flight);
    const craftState = flight.craftState || {};
    drawPlate(g, theme);
    label(g, 'FLIGHT MODE', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    const colour = mode === 'angle' ? theme.teal : theme.accent;
    g.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(g, 22, 44, 156, 46, 6);
    g.fill();
    label(g, mode === 'angle' ? 'ANGLE' : 'RATE', CENTER, 68, { size: 30, color: colour, weight: 750, spacing: 2 });
    const altitudeHold = mode === 'angle' && craftState.altitudeHold === true;
    lamp(g, 36, 106, 6, altitudeHold, theme.teal, theme);
    label(g, 'ALT HOLD', 48, 106, { size: 10.5, color: altitudeHold ? theme.teal : theme.textDim, weight: 700, align: 'left' });
    const armed = flight.engineOn !== false;
    lamp(g, 122, 106, 6, !armed, theme.red, theme);
    label(g, 'DISARM', 134, 106, { size: 10.5, color: armed ? theme.textDim : theme.red, weight: 700, align: 'left' });
    const throttle = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
    label(g, 'THR', 22, 140, { size: 10.5, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    g.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(g, 22, 150, 110, 16, 5);
    g.fill();
    g.fillStyle = theme.yellow;
    roundRect(g, 22, 150, Math.max(8, 110 * throttle), 16, 5);
    g.fill();
    digital(g, `${Math.round(throttle * 100)}%`, 138, 146, 44, 24, theme, { size: 14 });
  },
});
