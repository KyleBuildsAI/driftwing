// Pass-through and pass-under gate detection, generic for every engine: a gate is a vertical
// rectangle in the world (a centre, a horizontal normal, a half width along the plane and a height
// band). A player segment from one frame to the next passes the gate when it crosses the plane
// inside the rectangle. 'under' and 'through' gates differ only in what they mean to the preset (a
// bridge's pass-under gate spans the gorge below its deck; a spire pair's through gate spans the gap).
//
// Gates live in one Float64Array per set (GATE_STRIDE numbers each); crossGates allocates nothing.

/** Numbers per gate: x, z, normalX, normalZ, halfWidth, minY, maxY, reach. */
export const GATE_STRIDE = 8;
/** A segment longer than this (m) between two frames is a teleport, never a pass. */
export const GATE_TELEPORT_DISTANCE = 250;

/**
 * Packs gate definitions ({ x, z, normalX, normalZ, halfWidth, minY, maxY } in world metres; the
 * normal is normalised here) into a set: { data, count, reachX/Z bounds }.
 */
export function createGateSet(gates) {
  const data = new Float64Array(Math.max(1, gates.length) * GATE_STRIDE);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  gates.forEach((gate, index) => {
    for (const field of ['x', 'z', 'normalX', 'normalZ', 'halfWidth', 'minY', 'maxY']) {
      if (!Number.isFinite(gate[field])) throw new TypeError(`[DRIFTWING] gate "${gate.id}" needs a finite ${field}`);
    }
    const length = Math.sqrt(gate.normalX * gate.normalX + gate.normalZ * gate.normalZ);
    if (length < 1e-6) throw new TypeError(`[DRIFTWING] gate "${gate.id}" needs a horizontal normal`);
    if (gate.halfWidth <= 0 || gate.maxY <= gate.minY) throw new RangeError(`[DRIFTWING] gate "${gate.id}" needs a positive width and height`);
    const base = index * GATE_STRIDE;
    data[base] = gate.x;
    data[base + 1] = gate.z;
    data[base + 2] = gate.normalX / length;
    data[base + 3] = gate.normalZ / length;
    data[base + 4] = gate.halfWidth;
    data[base + 5] = gate.minY;
    data[base + 6] = gate.maxY;
    data[base + 7] = gate.halfWidth + 60;
    minX = Math.min(minX, gate.x - gate.halfWidth);
    maxX = Math.max(maxX, gate.x + gate.halfWidth);
    minZ = Math.min(minZ, gate.z - gate.halfWidth);
    maxZ = Math.max(maxZ, gate.z + gate.halfWidth);
  });
  return { data, count: gates.length, minX, maxX, minZ, maxZ };
}

/**
 * The gate index the segment passes, from `from` (an array [x, y, z]) to `to` (an { x, y, z }
 * point), starting the search at `first`, or -1. The sign of the crossing (+1 along the gate normal,
 * -1 against it) is written to result[0]. Call again with the returned index + 1 to find more gates
 * passed in the same segment. The points come in as objects so no number is boxed on the way in.
 */
export function crossGates(set, from, to, first, result) {
  const fromX = from[0];
  const fromY = from[1];
  const fromZ = from[2];
  const toX = to.x;
  const toY = to.y;
  const toZ = to.z;
  const segmentX = toX - fromX;
  const segmentZ = toZ - fromZ;
  if (segmentX * segmentX + segmentZ * segmentZ > GATE_TELEPORT_DISTANCE * GATE_TELEPORT_DISTANCE) return -1;
  const data = set.data;
  for (let index = first; index < set.count; index++) {
    const base = index * GATE_STRIDE;
    const centreX = data[base];
    const centreZ = data[base + 1];
    const reach = data[base + 7];
    const offsetX = toX - centreX;
    const offsetZ = toZ - centreZ;
    if (offsetX * offsetX + offsetZ * offsetZ > reach * reach) continue;
    const normalX = data[base + 2];
    const normalZ = data[base + 3];
    const before = (fromX - centreX) * normalX + (fromZ - centreZ) * normalZ;
    const after = offsetX * normalX + offsetZ * normalZ;
    if ((before < 0) === (after < 0) || before === after) continue;
    const share = before / (before - after);
    const hitX = fromX + segmentX * share;
    const hitY = fromY + (toY - fromY) * share;
    const hitZ = fromZ + segmentZ * share;
    // Along the plane: the right axis (-normalZ, normalX).
    const across = (hitX - centreX) * -normalZ + (hitZ - centreZ) * normalX;
    if (across < -data[base + 4] || across > data[base + 4]) continue;
    if (hitY < data[base + 5] || hitY > data[base + 6]) continue;
    result[0] = after > 0 ? 1 : -1;
    return index;
  }
  return -1;
}
