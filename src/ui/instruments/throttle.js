// Throttle quadrant: the lever in its slot with the power fill, the throttle percentage, engine
// rpm (state.flight.rpm times the engine's rated rpm when the craft gives one), an ENGINE OFF lamp,
// and for afterburning engines the detent line (ControlState.afterburnerDetent) and an AB lamp.
import { CENTER, drawPlate, label, digital, roundRect, lamp, clamp } from './gaugeKit.js';

const SLOT = Object.freeze({ x: 58, top: 40, bottom: 164, width: 14 });

/** True when the craft's engine has an afterburner (SIM engine profile or its audio family). */
function hasAfterburner(craft) {
  const engine = craft.simProfile && craft.simProfile.engine;
  return Boolean((engine && engine.afterburner) || (craft.audioProfile && craft.audioProfile.engine === 'jet'));
}

function ratedRpm(craft) {
  const engine = craft.simProfile && craft.simProfile.engine;
  if (engine && Number.isFinite(engine.maxRpm)) return engine.maxRpm;
  const audio = craft.audioProfile;
  return audio && Number.isFinite(audio.maxRpm) ? audio.maxRpm : null;
}

export default Object.freeze({
  id: 'throttle',
  label: 'Throttle',
  draw(g, source, theme) {
    const { flight, craft, controls } = source;
    const throttle = clamp(Number.isFinite(flight.throttle) ? flight.throttle : 0, 0, 1);
    const afterburning = hasAfterburner(craft);
    drawPlate(g, theme);
    label(g, 'THROTTLE', CENTER, 28, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });

    // Slot, scale and fill.
    const height = SLOT.bottom - SLOT.top;
    g.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(g, SLOT.x - SLOT.width / 2, SLOT.top, SLOT.width, height, 6);
    g.fill();
    const fillTop = SLOT.bottom - throttle * height;
    const fill = g.createLinearGradient(0, SLOT.bottom, 0, SLOT.top);
    fill.addColorStop(0, 'rgba(243, 199, 122, 0.35)');
    fill.addColorStop(1, 'rgba(243, 199, 122, 0.85)');
    g.fillStyle = fill;
    roundRect(g, SLOT.x - SLOT.width / 2 + 3, fillTop, SLOT.width - 6, Math.max(0, SLOT.bottom - fillTop - 3), 3);
    g.fill();
    g.strokeStyle = theme.tick;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let step = 0; step <= 10; step++) {
      const y = SLOT.bottom - (step / 10) * height;
      const long = step % 5 === 0;
      g.moveTo(SLOT.x + 12, y);
      g.lineTo(SLOT.x + (long ? 24 : 18), y);
    }
    g.stroke();
    label(g, 'MAX', SLOT.x + 28, SLOT.top, { size: 9.5, color: theme.textDim, weight: 650, align: 'left' });
    label(g, 'IDLE', SLOT.x + 28, SLOT.bottom, { size: 9.5, color: theme.textDim, weight: 650, align: 'left' });
    if (afterburning) {
      const detent = clamp(Number.isFinite(controls.afterburnerDetent) ? controls.afterburnerDetent : 0.95, 0.5, 1);
      const y = SLOT.bottom - detent * height;
      g.strokeStyle = theme.red;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(SLOT.x - 14, y);
      g.lineTo(SLOT.x + 14, y);
      g.stroke();
    }
    // Lever knob.
    const knobY = SLOT.bottom - throttle * height;
    g.fillStyle = theme.id === 'panel' ? '#1a1b1f' : '#f6efe4';
    roundRect(g, SLOT.x - 20, knobY - 7, 40, 14, 5);
    g.fill();
    g.fillStyle = theme.accent;
    roundRect(g, SLOT.x - 20, knobY - 2, 40, 4, 2);
    g.fill();

    // Readouts.
    digital(g, `${Math.round(throttle * 100)}%`, 102, 46, 76, 30, theme, { size: 20 });
    const rated = ratedRpm(craft);
    const running = flight.engineOn !== false;
    if (rated && Number.isFinite(flight.rpm)) {
      digital(g, String(Math.round((flight.rpm * rated) / 10) * 10), 102, 90, 76, 24, theme, { size: 15 });
      label(g, 'RPM', 140, 124, { size: 10, color: theme.textDim, weight: 650, spacing: 1.2 });
    }
    lamp(g, 110, 150, 6, !running, theme.red, theme);
    label(g, 'ENG OFF', 122, 150, { size: 10.5, color: running ? theme.textDim : theme.red, weight: 700, align: 'left' });
    if (afterburning) {
      lamp(g, 110, 172, 6, Boolean(flight.afterburner), theme.accent, theme);
      label(g, 'AB', 122, 172, { size: 10.5, color: flight.afterburner ? theme.accent : theme.textDim, weight: 700, align: 'left' });
    }
  },
});
