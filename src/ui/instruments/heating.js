// Re-entry heating display (spaceplane): the heating index (state.flight.craftState.heating, from
// rho V^3) as a bar that warms from green to red, the dynamic pressure, the BLACKOUT lamp while the
// plasma cuts the radio link and the entry guidance phase.
import { CENTER, drawPlate, label, digital, roundRect, lamp, clamp } from './gaugeKit.js';

const PHASE_TEXT = Object.freeze({ off: 'ENTRY OFF', armed: 'ENTRY ARMED', entry: 'ENTRY 40 DEG', glide: 'HYPERSONIC GLIDE' });

function heatColour(theme, heating) {
  if (heating > 0.7) return theme.red;
  if (heating > 0.35) return theme.yellow;
  return theme.green;
}

export default Object.freeze({
  id: 'heating',
  label: 'Heating',
  draw(pen, source, theme) {
    const { flight } = source;
    const craftState = flight.craftState || {};
    const heating = clamp(Number.isFinite(craftState.heating) ? craftState.heating : 0, 0, 1);
    drawPlate(pen, theme);
    label(pen, 'HEATING', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(pen, 22, 42, 156, 22, 6);
    pen.fill();
    pen.fillStyle = heatColour(theme, heating);
    roundRect(pen, 22, 42, Math.max(10, 156 * heating), 22, 6);
    pen.fill();
    digital(pen, `${Math.round(heating * 100)}%`, 62, 72, 76, 26, theme, { size: 17, color: heating > 0.7 ? theme.red : null });
    const pressure = Number.isFinite(craftState.dynamicPressure) ? craftState.dynamicPressure : 0;
    label(pen, 'Q', 22, 120, { size: 10.5, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    digital(pen, pressure >= 1000 ? `${(pressure / 1000).toFixed(1)} kPa` : `${Math.round(pressure)} Pa`, 40, 108, 100, 24, theme, { size: 14 });
    const blackout = craftState.blackout === true;
    lamp(pen, 34, 154, 7, blackout, theme.red, theme);
    label(pen, 'BLACKOUT', 48, 154, { size: 10.5, color: blackout ? theme.red : theme.textDim, weight: 700, align: 'left' });
    const phase = PHASE_TEXT[craftState.reentryPhase] ?? PHASE_TEXT.off;
    const guiding = craftState.reentryPhase === 'entry' || craftState.reentryPhase === 'glide';
    label(pen, phase, CENTER, 178, { size: 10.5, color: guiding ? theme.teal : craftState.autoReentry ? theme.yellow : theme.textDim, weight: 700, spacing: 1 });
  },
});
