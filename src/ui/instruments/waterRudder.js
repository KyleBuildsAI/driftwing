// Water panel (the seaplane): the water rudders and the amphibian gear advisory.
// Top: the gear advisory window, the way an amphibian's annunciator reads it: GEAR UP / WATER
// (green over water), GEAR DOWN / RUNWAY, and a flashing red GEAR DOWN! (wheels down over water: a
// nose-over waiting to happen) or amber GEAR UP! (wheels up over land: the floats would skid).
// Middle: the water rudders, UP or DOWN, with their deflection from the pedals while down.
// Bottom: the STEP lamp (planing), the porpoise meter and the trim angle on the water.
// Everything comes from state.flight (gear) and state.flight.craftState (the floats extension).
import { CENTER, drawPlate, label, digital, roundRect, lamp, clamp } from './gaugeKit.js';
import { signed } from './units.js';

/** Flashing advisories alternate every this many physics ticks (120 Hz: half a second). */
const FLASH_TICKS = 60;

function advisory(flight, craftState) {
  const gearDown = Boolean(flight.gear && flight.gear.down);
  const transit = Boolean(flight.gear && flight.gear.transit > 0.001);
  if (craftState.noseOverWarning === true) return { top: 'GEAR DOWN!', bottom: 'WATER BELOW', tone: 'red', flash: true };
  if (craftState.skidWarning === true) return { top: 'GEAR UP!', bottom: 'LAND BELOW', tone: 'yellow', flash: true };
  if (transit) return { top: 'GEAR', bottom: 'IN TRANSIT', tone: 'red', flash: false };
  return gearDown ? { top: 'GEAR DOWN', bottom: 'RUNWAY', tone: 'text', flash: false } : { top: 'GEAR UP', bottom: 'WATER', tone: 'green', flash: false };
}

function drawRudderScale(pen, theme, deflection, down) {
  const left = 64;
  const right = 176;
  const y = 112;
  pen.strokeStyle = theme.tick;
  pen.lineWidth = 2;
  pen.beginPath();
  pen.moveTo(left, y);
  pen.lineTo(right, y);
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const x = left + (right - left) * fraction;
    pen.moveTo(x, y - (fraction === 0.5 ? 8 : 5));
    pen.lineTo(x, y);
  }
  pen.stroke();
  if (!down) return;
  const x = left + (right - left) * (0.5 + 0.5 * clamp(deflection, -1, 1));
  pen.fillStyle = theme.pointer;
  pen.beginPath();
  pen.moveTo(x, y + 3);
  pen.lineTo(x - 7, y + 15);
  pen.lineTo(x + 7, y + 15);
  pen.closePath();
  pen.fill();
}

export default Object.freeze({
  id: 'waterRudder',
  label: 'Water rudders and gear',
  draw(pen, source, theme) {
    const { flight, controls, units } = source;
    const craftState = flight.craftState || {};
    drawPlate(pen, theme);

    const advice = advisory(flight, craftState);
    const flashOff = advice.flash && Math.floor((Number.isFinite(flight.tick) ? flight.tick : 0) / FLASH_TICKS) % 2 === 1;
    const colour = advice.tone === 'red' ? theme.red : advice.tone === 'yellow' ? theme.yellow : advice.tone === 'green' ? theme.green : theme.text;
    pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(pen, 24, 24, 152, 50, 6);
    pen.fill();
    if (!flashOff) {
      label(pen, advice.top, CENTER, 42, { size: 17, color: colour, weight: 750, spacing: 1.2 });
      label(pen, advice.bottom, CENTER, 61, { size: 11, color: advice.flash ? colour : theme.textDim, weight: 700, spacing: 1.4 });
    }

    const down = craftState.waterRudders === true;
    label(pen, 'W/RUD', 22, 98, { size: 10.5, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    label(pen, down ? 'DOWN' : 'UP', 22, 116, { size: 13, color: down ? theme.teal : theme.text, weight: 750, align: 'left' });
    const yaw = controls && Number.isFinite(controls.yaw) ? controls.yaw : 0;
    const toe = controls ? (Number.isFinite(controls.brakeR) ? controls.brakeR : 0) - (Number.isFinite(controls.brakeL) ? controls.brakeL : 0) : 0;
    drawRudderScale(pen, theme, yaw + toe, down);

    const onStep = craftState.onStep === true;
    lamp(pen, 30, 146, 6, onStep, theme.green, theme);
    label(pen, 'STEP', 42, 146, { size: 10.5, color: onStep ? theme.green : theme.textDim, weight: 700, align: 'left' });
    const porpoise = clamp(Number.isFinite(craftState.porpoise) ? craftState.porpoise : 0, 0, 1);
    label(pen, 'PORP', 86, 146, { size: 10.5, color: porpoise > 0.3 ? theme.red : theme.textDim, weight: 700, align: 'left' });
    pen.fillStyle = theme.id === 'panel' ? '#050607' : 'rgba(8, 6, 12, 0.34)';
    roundRect(pen, 122, 140, 54, 12, 4);
    pen.fill();
    if (porpoise > 0.01) {
      pen.fillStyle = porpoise > 0.3 ? theme.red : theme.yellow;
      roundRect(pen, 122, 140, Math.max(6, 54 * porpoise), 12, 4);
      pen.fill();
    }
    const onWater = craftState.onWater === true;
    label(pen, 'TRIM', 22, 172, { size: 10.5, color: theme.textDim, weight: 650, align: 'left', spacing: 1 });
    const trim = Number.isFinite(craftState.trim) ? craftState.trim : 0;
    digital(pen, onWater ? `${signed(trim)}°` : '---', 56, 161, 58, 22, theme, { size: 14 });
    // The speed through the water, in the player's speed unit.
    const speed = Number.isFinite(craftState.waterSpeed) ? Math.abs(craftState.waterSpeed) : 0;
    digital(pen, onWater ? `${Math.round(speed * units.speed.factor)} ${units.speed.label}` : units.speed.label, 118, 161, 62, 22, theme, { size: 12 });
  },
});
