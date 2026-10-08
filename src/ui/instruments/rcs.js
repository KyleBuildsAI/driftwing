// Reaction control display (spaceplane): the RCS blend (state.flight.craftState.rcsBlend: how much of
// the attitude control the jets have as the air thins), one centred bar per axis showing the jets
// firing (pitch, yaw, roll), and the ATT HOLD and AUTO ENTRY lamps.
import { drawPlate, label, digital, roundRect, lamp, clamp } from './gaugeKit.js';

const AXES = Object.freeze([['P', 'rcsPitch'], ['Y', 'rcsYaw'], ['R', 'rcsRoll']]);
const BAR = Object.freeze({ x: 40, width: 138, centre: 109, reach: 66 });

export default Object.freeze({
  id: 'rcs',
  label: 'Reaction control',
  draw(pen, source, theme) {
    const { flight } = source;
    const craftState = flight.craftState || {};
    const blend = clamp(Number.isFinite(craftState.rcsBlend) ? craftState.rcsBlend : 0, 0, 1);
    const back = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    drawPlate(pen, theme);
    label(pen, 'RCS', 22, 30, { size: 11, color: theme.textDim, weight: 650, align: 'left', spacing: 1.6 });
    digital(pen, `${Math.round(blend * 100)}%`, 120, 18, 58, 24, theme, { size: 15, color: blend > 0.5 ? theme.teal : null });
    pen.fillStyle = back;
    roundRect(pen, 22, 48, 156, 12, 5);
    pen.fill();
    pen.fillStyle = theme.teal;
    roundRect(pen, 22, 48, Math.max(8, 156 * blend), 12, 5);
    pen.fill();
    AXES.forEach(([name, field], index) => {
      const y = 76 + index * 24;
      const command = clamp(Number.isFinite(craftState[field]) ? craftState[field] : 0, -1, 1);
      label(pen, name, 24, y + 7, { size: 11, color: theme.textDim, weight: 700, align: 'left' });
      pen.fillStyle = back;
      roundRect(pen, BAR.x, y, BAR.width, 14, 5);
      pen.fill();
      pen.fillStyle = Math.abs(command) > 0.04 ? theme.yellow : theme.lampOff;
      const width = Math.max(3, BAR.reach * Math.abs(command));
      pen.fillRect(command >= 0 ? BAR.centre : BAR.centre - width, y + 2, width, 10);
      pen.fillStyle = theme.white;
      pen.fillRect(BAR.centre - 0.75, y, 1.5, 14);
    });
    const hold = craftState.attitudeHold === true;
    lamp(pen, 30, 160, 6, hold, theme.teal, theme);
    label(pen, 'ATT HOLD', 41, 160, { size: 10, color: hold ? theme.teal : theme.textDim, weight: 700, align: 'left' });
    const entry = craftState.autoReentry === true;
    lamp(pen, 112, 160, 6, entry, theme.yellow, theme);
    label(pen, 'AUTO ENTRY', 123, 160, { size: 10, color: entry ? theme.yellow : theme.textDim, weight: 700, align: 'left' });
  },
});
