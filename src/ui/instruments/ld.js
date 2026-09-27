// Glide computer (gliders): the aerodynamic glide ratio (L/D through the air mass: horizontal air
// speed over sink through the air) as a large readout with a bar against the craft's best L/D,
// plus the glide ratio over the ground (what reaches the next field, wind included) and its
// 15 second average.
import { CENTER, drawPlate, label, digital, roundRect, clamp } from './gaugeKit.js';

const AVERAGE_SECONDS = 15;
const MAX_SHOWN = 99;

/** Glide ratio as text ('--' while climbing or level, capped at 99). */
function ratioText(ratio) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return '--';
  return String(Math.round(Math.min(ratio, MAX_SHOWN)));
}

function airGlideRatio(flight) {
  const air = flight.airVelocity;
  if (!air || !(air.y < -0.05)) return 0;
  return Math.hypot(air.x, air.z) / -air.y;
}

export default Object.freeze({
  id: 'ld',
  label: 'Glide ratio',
  createMemory() {
    return { distance: 0, height: 0 };
  },
  reset(memory) {
    memory.distance = 0;
    memory.height = 0;
  },
  update(memory, dt, source) {
    const flight = source.flight;
    if (!(dt > 0) || !Number.isFinite(flight.groundSpeed) || !Number.isFinite(flight.verticalSpeed)) return;
    // Exponentially weighted distance flown and height lost: their ratio is the recent glide ratio.
    const keep = Math.exp(-dt / AVERAGE_SECONDS);
    memory.distance = memory.distance * keep + flight.groundSpeed * dt;
    memory.height = memory.height * keep - flight.verticalSpeed * dt;
  },
  draw(g, source, theme, memory) {
    const { flight, craft } = source;
    const targets = craft.simProfile && craft.simProfile.targets;
    const best = targets && Number.isFinite(targets.liftToDrag) ? targets.liftToDrag : 40;
    const air = airGlideRatio(flight);
    drawPlate(g, theme);
    label(g, 'GLIDE  L/D', CENTER, 30, { size: 11, color: theme.textDim, weight: 650, spacing: 1.6 });
    digital(g, ratioText(air), CENTER - 46, 44, 92, 50, theme, { size: 38 });
    // Bar against the best glide ratio.
    const fraction = clamp(air / best, 0, 1);
    g.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(g, 30, 104, 140, 10, 5);
    g.fill();
    g.fillStyle = fraction > 0.85 ? theme.green : theme.yellow;
    roundRect(g, 30, 104, Math.max(10, 140 * fraction), 10, 5);
    g.fill();
    label(g, `BEST ${best}`, 170, 124, { size: 10, color: theme.textDim, weight: 650, align: 'right' });
    label(g, 'AIR', 30, 124, { size: 10, color: theme.textDim, weight: 650, align: 'left' });
    label(g, 'GROUND', 44, 146, { size: 10, color: theme.textDim, weight: 650, spacing: 1 });
    label(g, 'AVG', 132, 146, { size: 10, color: theme.textDim, weight: 650, spacing: 1 });
    digital(g, ratioText(flight.glideRatio), 18, 156, 54, 26, theme, { size: 17 });
    const average = memory.height > 1 ? memory.distance / memory.height : 0;
    digital(g, ratioText(average), 104, 156, 54, 26, theme, { size: 17 });
  },
});
