// Recipe 'windFarm': rows of three-bladed turbines. The towers and their foundations are static
// geometry; the nacelles and rotors are shared instanced meshes the engine turns every frame: each
// nacelle yaws into the real ambient wind (the WindField, probed at hub height) and the rotors spin
// at a speed that follows the wind speed between cut-in and rated wind. Optional wake turbulence
// downwind of every rotor (a WindField source, see the engine).
import { PALETTE, paint } from '../palette.js';
import { frameFromHeading } from '../common.js';
import { roll, rollInteger } from '../../params.js';

export const WIND_FARM_DEFAULTS = Object.freeze({
  count: [5, 8],
  rows: 1,
  spacing: 260,
  rowSpacing: 480,
  jitter: 0.12,
  hubHeight: [72, 86],
  rotorRadius: [36, 42],
  towerColor: 0xf2efe8,
  align: 'wind',
  maxRpm: 16,
  cutIn: 3,
  ratedWind: 11,
  cutOut: 25,
  yawRate: 5,
  wake: Object.freeze({ length: 8, deficit: 0.35, turbulence: 0.45, expansion: 0.075 }),
});

export function buildWindFarm(context, read) {
  const { rng, body, detail, out, windX, windZ } = context;
  const count = rollInteger(read.range('count', WIND_FARM_DEFAULTS.count, 1, 16), rng);
  const rows = read.integer('rows', WIND_FARM_DEFAULTS.rows, 1, 4);
  const spacing = read.number('spacing', WIND_FARM_DEFAULTS.spacing, 60, 1200);
  const rowSpacing = read.number('rowSpacing', WIND_FARM_DEFAULTS.rowSpacing, 60, 2000);
  const jitter = read.number('jitter', WIND_FARM_DEFAULTS.jitter, 0, 0.45);
  const hubRange = read.range('hubHeight', WIND_FARM_DEFAULTS.hubHeight, 15, 160);
  const rotorRange = read.range('rotorRadius', WIND_FARM_DEFAULTS.rotorRadius, 4, 80);
  const towerPaint = paint(read.color('towerColor', WIND_FARM_DEFAULTS.towerColor));
  const align = read.choice('align', WIND_FARM_DEFAULTS.align, ['wind', 'site']);
  const turbine = {
    maxRpm: read.number('maxRpm', WIND_FARM_DEFAULTS.maxRpm, 0, 40),
    cutIn: read.number('cutIn', WIND_FARM_DEFAULTS.cutIn, 0, 20),
    ratedWind: read.number('ratedWind', WIND_FARM_DEFAULTS.ratedWind, 1, 40),
    cutOut: read.number('cutOut', WIND_FARM_DEFAULTS.cutOut, 5, 80),
    yawRate: read.number('yawRate', WIND_FARM_DEFAULTS.yawRate, 0.1, 90),
  };
  if (turbine.ratedWind <= turbine.cutIn) read.fail('ratedWind', 'must be above cutIn');
  const wakeParams = read.object('wake', WIND_FARM_DEFAULTS.wake);
  if (wakeParams) {
    const wakeRead = read.nested('wake');
    out.wake = {
      length: wakeRead.number('length', WIND_FARM_DEFAULTS.wake.length, 1, 30),
      deficit: wakeRead.number('deficit', WIND_FARM_DEFAULTS.wake.deficit, 0, 0.9),
      turbulence: wakeRead.number('turbulence', WIND_FARM_DEFAULTS.wake.turbulence, 0, 1),
      expansion: wakeRead.number('expansion', WIND_FARM_DEFAULTS.wake.expansion, 0, 0.3),
    };
  }
  out.turbineSettings = turbine;

  // Rows run across the prevailing wind (so each row meets clean air) or across the site heading.
  let rowX;
  let rowZ;
  let downX;
  let downZ;
  if (align === 'wind') {
    downX = windX;
    downZ = windZ;
    rowX = -windZ;
    rowZ = windX;
  } else {
    const frame = frameFromHeading(context.heading);
    rowX = frame.rightX;
    rowZ = frame.rightZ;
    downX = frame.forwardX;
    downZ = frame.forwardZ;
  }
  const perRow = Math.ceil(count / rows);
  let extent = 0;
  let placed = 0;
  let hubSum = 0;
  for (let row = 0; row < rows && placed < count; row++) {
    const inRow = Math.min(perRow, count - placed);
    const stagger = row % 2 === 1 ? spacing * 0.5 : 0;
    for (let index = 0; index < inRow; index++) {
      const along = (index - (inRow - 1) / 2) * spacing + stagger + (context.rng() - 0.5) * 2 * jitter * spacing;
      const across = (row - (rows - 1) / 2) * rowSpacing + (context.rng() - 0.5) * 2 * jitter * spacing;
      const x = rowX * along + downX * across;
      const z = rowZ * along + downZ * across;
      const ground = context.ground(x, z);
      const hubHeight = roll(hubRange, rng);
      const rotorRadius = Math.min(roll(rotorRange, rng), hubHeight * 0.9);
      addTower(body, detail, x, ground, z, hubHeight, rotorRadius, towerPaint, rng);
      out.turbines.push({
        x, y: ground + hubHeight, z, rotorRadius,
        phase: rng() * Math.PI * 2,
        speedScale: 0.92 + rng() * 0.16,
        yawOffset: (rng() - 0.5) * 6,
      });
      extent = Math.max(extent, Math.sqrt(x * x + z * z) + rotorRadius);
      hubSum += ground + hubHeight;
      placed++;
    }
  }
  out.radius = Math.max(out.radius, extent);
  out.audioPoint = [0, hubSum / placed, 0];
  out.windProbe = [0, hubSum / placed, 0];
}

/** A tapered tower on a concrete foundation, with a service door and a band near the base. */
function addTower(body, detail, x, ground, z, hubHeight, rotorRadius, towerPaint, random) {
  const baseRadius = Math.max(1.6, rotorRadius * 0.065);
  const topRadius = baseRadius * 0.58;
  const top = hubHeight - 2.2;
  // Foundation pad: sunk into the ground so slopes never show its underside.
  body.setSway(0).setPaint(PALETTE.concrete).prism(x, ground - 3, z, 8, baseRadius * 3.2, baseRadius * 2.9, 3.6, random() * 6);
  body.setPaint(PALETTE.towerBand).lathe(x, ground, z, [[baseRadius, 0], [baseRadius * 0.97, 3.5]], 12);
  body.setPaint(towerPaint).lathe(x, ground + 3.5, z, [[baseRadius * 0.97, 0], [(baseRadius + topRadius) * 0.5, (top - 3.5) * 0.5], [topRadius, top - 3.5]], 12, { closeTop: true });
  // Service door and steps (near detail).
  detail.setPaint(PALETTE.metalDark).box(x, ground + 1.3, z + baseRadius * 0.98, 1.1, 2.2, 0.2);
  detail.setPaint(PALETTE.concreteDark).box(x, ground + 0.25, z + baseRadius + 0.8, 1.8, 0.5, 1.4);
}
