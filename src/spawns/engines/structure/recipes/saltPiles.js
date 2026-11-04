// Recipe 'saltPiles': rows of harvested salt heaped into little cones on a salt flat (preset 40, salt
// flat mirror lake), standing in the shallows at the edge of the water film so each doubles in the
// mirror. The rows run straight across the site's basin stamp at `edge` of its radius from the centre,
// each cone slightly different, with a low crust rim at its foot. Every cone is a small solid
// cylinder (a craft taxiing on the flat bumps into them). Without a basin stamp (a debug spawn) the
// rows stand `radius` metres ahead of the anchor.
import { paint } from '../palette.js';
import { findStamp, frameFromHeading } from '../common.js';
import { localCylinder } from '../colliders.js';
import { roll, rollInteger } from '../../engineKit.js';

export const SALT_PILES_DEFAULTS = Object.freeze({
  stamp: 0,
  rows: [3, 5],
  perRow: [24, 40],
  spacing: 7,
  rowGap: 9,
  height: [0.9, 1.5],
  edge: 0.62,
  radius: 300,
});

const SALT = Object.freeze([paint(0xf4f1ea), paint(0xece7dc), paint(0xf8f6f0)]);
const CRUST = paint(0xd8d0c0);

export function buildSaltPiles(context, read) {
  const { rng, body, out, anchor } = context;
  const stampIndex = read.integer('stamp', SALT_PILES_DEFAULTS.stamp, 0, 16);
  const rowRange = read.range('rows', SALT_PILES_DEFAULTS.rows, 1, 12);
  const perRowRange = read.range('perRow', SALT_PILES_DEFAULTS.perRow, 1, 80);
  const spacing = read.number('spacing', SALT_PILES_DEFAULTS.spacing, 2, 40);
  const rowGap = read.number('rowGap', SALT_PILES_DEFAULTS.rowGap, 2, 60);
  const heightRange = read.range('height', SALT_PILES_DEFAULTS.height, 0.3, 4);
  const edge = read.number('edge', SALT_PILES_DEFAULTS.edge, 0, 0.95);
  const basin = findStamp(context.site, 'basin', stampIndex);
  const frame = frameFromHeading(context.heading);
  // The rows' centre: `edge` of the basin's radius out from its centre, along the site heading.
  const reach = basin ? basin.radius * edge : read.number('radius', SALT_PILES_DEFAULTS.radius, 20, 3000);
  const baseX = (basin ? basin.x - anchor.x : 0) + frame.forwardX * reach;
  const baseZ = (basin ? basin.z - anchor.z : 0) + frame.forwardZ * reach;
  const rows = rollInteger(rowRange, rng);
  let cones = 0;
  for (let row = 0; row < rows; row++) {
    const count = rollInteger(perRowRange, rng);
    const rowOffset = (row - (rows - 1) / 2) * rowGap;
    for (let index = 0; index < count; index++) {
      const across = (index - (count - 1) / 2) * spacing + (rng() - 0.5) * spacing * 0.2;
      const along = rowOffset + (rng() - 0.5) * 1.2;
      const x = baseX + frame.rightX * across + frame.forwardX * along;
      const z = baseZ + frame.rightZ * across + frame.forwardZ * along;
      const height = roll(heightRange, rng);
      const radius = height * (0.75 + rng() * 0.2);
      const y = context.ground(x, z);
      // A low crust rim, then the cone, its tip a little off centre.
      body.setPaint(CRUST).lathe(x, y - 0.2, z, [[radius * 1.25, 0], [radius * 1.1, 0.28]], 7, { closeTop: true, phase: rng() * 6 });
      body.setPaint(SALT[(row + index) % SALT.length]).lathe(x, y, z, [[radius, 0], [radius * 0.55, height * 0.6], [0, height]], 7, { closeBottom: true, phase: rng() * 6 });
      out.colliders.push(localCylinder('saltPile', x, y - 0.2, z, radius * 0.9, height + 0.2, { surface: 'stone' }));
      cones++;
    }
  }
  out.facts.saltPiles = cones;
  out.audioPoint = [baseX, context.ground(baseX, baseZ) + 4, baseZ];
  out.radius = Math.max(out.radius, Math.hypot(baseX, baseZ) + rows * rowGap + 40 * spacing);
}
