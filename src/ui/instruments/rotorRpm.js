// Dual tachometer (helicopter): main-rotor speed (R, orange needle; state.flight.rotorRpm, 1 =
// governed 100 %) and engine speed (E, white needle; state.flight.rpm) on one 0-120 % dial, with
// the rotor's green band at 97-103 %, caution below and red limits at 90 and 107 %.
import { CENTER, drawCase, drawGlare, ticks, numerals, arcBand, radial, needle, label, digital, title, linearDial } from './gaugeKit.js';

export default Object.freeze({
  id: 'rotorRpm',
  label: 'Rotor rpm',
  draw(g, source, theme) {
    const { flight } = source;
    const toAngle = linearDial(0, 120, -135, 270);
    drawCase(g, theme);
    arcBand(g, { from: 90, to: 97, toAngle, radius: 80, width: 7, color: theme.yellow });
    arcBand(g, { from: 97, to: 103, toAngle, radius: 80, width: 7, color: theme.green });
    arcBand(g, { from: 103, to: 107, toAngle, radius: 80, width: 7, color: theme.yellow });
    radial(g, toAngle(90), 70, 90, theme.red, 4);
    radial(g, toAngle(107), 70, 90, theme.red, 4);
    ticks(g, { from: 0, to: 120, step: 5, toAngle, inner: 81, outer: 88, width: 1.3, color: theme.tick });
    ticks(g, { from: 0, to: 120, step: 20, toAngle, inner: 72, outer: 88, width: 3, color: theme.tick });
    numerals(g, [0, 20, 40, 60, 80, 100, 120], { toAngle, radius: 58, size: 15, color: theme.text });
    title(g, 'RPM %', theme, 72);
    const rotor = Number.isFinite(flight.rotorRpm) ? flight.rotorRpm * 100 : 0;
    const engine = Number.isFinite(flight.rpm) ? flight.rpm * 100 : 0;
    label(g, 'R', CENTER - 22, 126, { size: 13, color: theme.accent, weight: 750 });
    label(g, 'E', CENTER + 22, 126, { size: 13, color: theme.text, weight: 750 });
    if (theme.id === 'glass') digital(g, `${Math.round(rotor)}`, CENTER - 20, 140, 40, 20, theme, { size: 13 });
    needle(g, toAngle(engine), { length: 70, width: 4, color: theme.needle, hub: 0 });
    needle(g, toAngle(rotor), { length: 80, color: theme.accent });
    drawGlare(g, theme);
  },
});
