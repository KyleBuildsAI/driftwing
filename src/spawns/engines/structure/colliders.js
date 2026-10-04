// Structure colliders (Phase 3 contract b.5 and b.8): the recipes describe their solid parts in the
// instance's LOCAL frame (metres from the spawn anchor, the same frame their geometry uses) as
// out.colliders entries made with the local* helpers below; the engine registers them with the game's
// collider service (ctx.game.colliders) at create, lists every id in instance.colliderIds and
// removes them on dispose. Turbine nacelles and rotor discs follow their yaw every frame (setPose).
// Floating island tops become landable heightfields that publish the exact top the mesh is built
// from (islandTopHeight over islandOutline), so the Phase 2 ground surface moves onto the collider.
// Pure apart from the service it is handed: the node labs (no collider service) skip all of it.
import { islandOutline, islandTopHeight } from './recipes/islands.js';

const DEG = Math.PI / 180;
/** Reference rotor radius (m) of the shared nacelle and rotor geometry (structureEngine.js). */
const ROTOR_REFERENCE = 40;
/** The rotor hub sits this far ahead of the tower axis, in reference metres (structureEngine.js). */
const HUB_OFFSET = 3.6;
/** The nacelle box in reference metres (local: x across, y up, z aft): centre and half extents. */
const NACELLE = Object.freeze({ y: 0.2, z: 2.6, halfX: 2.1, halfY: 2.1, halfZ: 5.75 });
/** The rotor disc in reference metres: its plane sits this far ahead of the hub, this thick (half). */
const ROTOR_DISC = Object.freeze({ ahead: 1.1, halfThickness: 1.4 });
/** Island top heightfields: cell size as a share of the radius, within these bounds (m). */
const ISLAND_CELL_SHARE = 1 / 40;
const ISLAND_CELL_RANGE = Object.freeze([1.5, 4]);
/** The heightfield's bottom sits this far (m) under the rim; the underside hulls carry on below. */
const ISLAND_SLAB_DEPTH = 1.7;
const RIM_DROP = 1.2;

// ---- Local specs (the recipes) ----------------------------------------------------------------------
/** A quaternion { x, y, z, w } turning by a compass yaw (radians, clockwise from above), as meshBuilder.box. */
export function yawQuaternion(yaw) {
  return { x: 0, y: Math.sin(-yaw / 2), z: 0, w: Math.cos(-yaw / 2) };
}

/** A quaternion from three orthonormal right-handed local axes ([x, y, z] arrays): a box's frame. */
export function basisQuaternion(axisX, axisY, axisZ) {
  const m00 = axisX[0];
  const m10 = axisX[1];
  const m20 = axisX[2];
  const m01 = axisY[0];
  const m11 = axisY[1];
  const m21 = axisY[2];
  const m02 = axisZ[0];
  const m12 = axisZ[1];
  const m22 = axisZ[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return { x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s, w: 0.25 / s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return { x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s, w: (m21 - m12) / s };
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return { x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s, w: (m02 - m20) / s };
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return { x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s, w: (m10 - m01) / s };
}

/** A box: local centre, full sizes and a compass yaw (meshBuilder.box's arguments). */
export function localBox(part, cx, cy, cz, sizeX, sizeY, sizeZ, yaw, tags) {
  return { part, type: 'box', center: { x: cx, y: cy, z: cz }, halfExtents: { x: sizeX * 0.5, y: sizeY * 0.5, z: sizeZ * 0.5 }, quaternion: yawQuaternion(yaw), tags };
}

/** A box from its local centre, three orthonormal right-handed axes and half extents. */
export function localBoxAxes(part, center, axisX, axisY, axisZ, halfX, halfY, halfZ, tags) {
  return { part, type: 'box', center: { x: center[0], y: center[1], z: center[2] }, halfExtents: { x: halfX, y: halfY, z: halfZ }, quaternion: basisQuaternion(axisX, axisY, axisZ), tags };
}

/** An upright cylinder from its base centre (local) and height. */
export function localCylinder(part, x, baseY, z, radius, height, tags) {
  return { part, type: 'cylinder', center: { x, y: baseY + height * 0.5, z }, radius, halfHeight: height * 0.5, tags };
}

export function localCapsule(part, ax, ay, az, bx, by, bz, radius, tags) {
  return { part, type: 'capsule', a: { x: ax, y: ay, z: az }, b: { x: bx, y: by, z: bz }, radius, tags };
}

/** A sphere: a capsule with both ends at its centre. */
export function localSphere(part, x, y, z, radius, tags) {
  return localCapsule(part, x, y, z, x, y, z, radius, tags);
}

/** A hull of local points ([x, y, z] arrays, at most 64). */
export function localHull(part, points, tags) {
  return { part, type: 'hull', points, tags };
}

/**
 * meshBuilder.setTransform's frame as a function local [x, y, z] -> [x, y, z]: origin, compass yaw,
 * then tilts about local x and z (R = Ry(-yaw) * Rx(tiltX) * Rz(tiltZ)).
 */
export function builderFrame(x, y, z, yaw, tiltX = 0, tiltZ = 0) {
  const cy = Math.cos(-yaw);
  const sy = Math.sin(-yaw);
  const cx = Math.cos(tiltX);
  const sx = Math.sin(tiltX);
  const cz = Math.cos(tiltZ);
  const sz = Math.sin(tiltZ);
  // Rx * Rz, then Ry in front.
  const rxz = [cz, -sz, 0, cx * sz, cx * cz, -sx, sx * sz, sx * cz, cx];
  const rotation = [
    cy * rxz[0] + sy * rxz[6], cy * rxz[1] + sy * rxz[7], cy * rxz[2] + sy * rxz[8],
    rxz[3], rxz[4], rxz[5],
    -sy * rxz[0] + cy * rxz[6], -sy * rxz[1] + cy * rxz[7], -sy * rxz[2] + cy * rxz[8],
  ];
  return ([px, py, pz]) => [
    x + rotation[0] * px + rotation[1] * py + rotation[2] * pz,
    y + rotation[3] * px + rotation[4] * py + rotation[5] * pz,
    z + rotation[6] * px + rotation[7] * py + rotation[8] * pz,
  ];
}

/** Points on a lathe ring (meshBuilder.lathe's angles), circumscribed so the polygon holds the ring. */
export function ringPoints(cx, y, cz, radius, sides, phase = 0, circumscribe = true) {
  const reach = circumscribe ? radius / Math.cos(Math.PI / sides) : radius;
  const points = [];
  for (let side = 0; side < sides; side++) {
    const angle = phase + (side / sides) * Math.PI * 2;
    points.push([cx + Math.sin(angle) * reach, y, cz - Math.cos(angle) * reach]);
  }
  return points;
}

// ---- The engine side --------------------------------------------------------------------------------
function toWorld(point, anchor) {
  return { x: anchor.x + point.x, y: anchor.y + point.y, z: anchor.z + point.z };
}

/** A recipe's local spec as a world collider spec (id and owner set). */
function worldSpec(local, anchor, id, owner) {
  const tags = local.tags ?? { surface: 'stone' };
  // Perch points come in the local frame too.
  const perch = tags.perch;
  const worldTags = perch && typeof perch === 'object'
    ? { ...tags, perch: Array.isArray(perch) ? perch.map((point) => toWorld(point, anchor)) : toWorld(perch, anchor) }
    : tags;
  const spec = { id, owner, type: local.type, tags: worldTags };
  switch (local.type) {
    case 'box':
      spec.center = toWorld(local.center, anchor);
      spec.halfExtents = local.halfExtents;
      spec.quaternion = local.quaternion;
      break;
    case 'cylinder':
      spec.center = toWorld(local.center, anchor);
      spec.radius = local.radius;
      spec.halfHeight = local.halfHeight;
      if (local.quaternion) spec.quaternion = local.quaternion;
      break;
    case 'capsule':
      spec.a = toWorld(local.a, anchor);
      spec.b = toWorld(local.b, anchor);
      spec.radius = local.radius;
      break;
    case 'hull': {
      const points = new Float64Array(local.points.length * 3);
      local.points.forEach(([x, y, z], index) => points.set([anchor.x + x, anchor.y + y, anchor.z + z], index * 3));
      spec.points = points;
      break;
    }
    default:
      throw new Error(`[DRIFTWING] structure collider "${id}" has an unknown type "${local.type}"`);
  }
  return spec;
}

/**
 * Registers a structure instance's colliders: out.colliders (local specs) and the moving turbine
 * parts. prefix: `${preset.id}:${params.seed}:${serial}` (contract b.5). Every id goes into
 * instance.colliderIds; on a failure the ones added are removed and the error rethrown.
 */
export function addStructureColliders(colliders, instance, data, out, anchor, prefix) {
  if (!colliders) return;
  const owner = prefix;
  const add = (spec) => {
    colliders.add(spec);
    instance.colliderIds.push(spec.id);
  };
  try {
    out.colliders.forEach((local, index) => add(worldSpec(local, anchor, `${prefix}:${local.part}${index}`, owner)));
    if (data.turbineCount > 0) addTurbineColliders(colliders, data, prefix, owner, add);
  } catch (error) {
    removeStructureColliders(colliders, instance, data);
    throw error;
  }
}

/** The nacelle box and the rotor disc of every turbine (placed by updateTurbineColliders). */
function addTurbineColliders(colliders, data, prefix, owner, add) {
  const count = data.turbineCount;
  data.turbineColliders = {
    nacelleIds: [],
    rotorIds: [],
    nacellePoses: Array.from({ length: count }, () => new Float64Array(7)),
    rotorPoses: Array.from({ length: count }, () => new Float64Array(7)),
    yaws: new Float64Array(count).fill(NaN),
  };
  for (let index = 0; index < count; index++) {
    const size = data.turbineRadii[index] / ROTOR_REFERENCE;
    const center = { x: data.turbinePositions[index * 3], y: data.turbinePositions[index * 3 + 1], z: data.turbinePositions[index * 3 + 2] };
    const nacelleId = `${prefix}:nacelle${index}`;
    const rotorId = `${prefix}:rotor${index}`;
    add({ id: nacelleId, owner, type: 'box', center, halfExtents: { x: NACELLE.halfX * size, y: NACELLE.halfY * size, z: NACELLE.halfZ * size }, tags: { surface: 'metal' } });
    add({ id: rotorId, owner, type: 'cylinder', center, radius: data.turbineRadii[index], halfHeight: ROTOR_DISC.halfThickness * size, tags: { surface: 'metal' } });
    data.turbineColliders.nacelleIds.push(nacelleId);
    data.turbineColliders.rotorIds.push(rotorId);
  }
  updateTurbineColliders(colliders, data);
}

/**
 * Turns every turbine's nacelle box and rotor disc to its current yaw (data.turbineState); a turbine
 * whose yaw has not changed is left alone. Allocation-free.
 */
export function updateTurbineColliders(colliders, data) {
  const parts = data.turbineColliders;
  if (!colliders || !parts) return;
  for (let index = 0; index < data.turbineCount; index++) {
    const yawDegrees = data.turbineState[index * 3];
    if (yawDegrees === parts.yaws[index]) continue;
    parts.yaws[index] = yawDegrees;
    const yaw = yawDegrees * DEG;
    const size = data.turbineRadii[index] / ROTOR_REFERENCE;
    const sine = Math.sin(yaw);
    const cosine = Math.cos(yaw);
    const hubX = data.turbinePositions[index * 3];
    const hubY = data.turbinePositions[index * 3 + 1];
    const hubZ = data.turbinePositions[index * 3 + 2];
    // The instance frame: x' = (cos, 0, sin) yaw, y' = up, z' = (-sin, 0, cos) yaw (aft, downwind):
    // a turn of -yaw about +y.
    const halfTurnSine = Math.sin(-yaw / 2);
    const halfTurnCosine = Math.cos(-yaw / 2);
    const nacelle = parts.nacellePoses[index];
    nacelle[0] = hubX - sine * NACELLE.z * size;
    nacelle[1] = hubY + NACELLE.y * size;
    nacelle[2] = hubZ + cosine * NACELLE.z * size;
    nacelle[3] = 0;
    nacelle[4] = halfTurnSine;
    nacelle[5] = 0;
    nacelle[6] = halfTurnCosine;
    // The disc: ahead of the hub (upwind, -z'), its axis (local +y) laid along z': a quarter turn about
    // x, then the yaw.
    const ahead = (HUB_OFFSET + ROTOR_DISC.ahead) * size;
    const rotor = parts.rotorPoses[index];
    rotor[0] = hubX + sine * ahead;
    rotor[1] = hubY;
    rotor[2] = hubZ - cosine * ahead;
    const quarter = Math.SQRT1_2;
    rotor[3] = halfTurnCosine * quarter;
    rotor[4] = halfTurnSine * quarter;
    rotor[5] = -halfTurnSine * quarter;
    rotor[6] = halfTurnCosine * quarter;
    colliders.setPose(parts.nacelleIds[index], nacelle);
    colliders.setPose(parts.rotorIds[index], rotor);
  }
}

/** Removes every collider an instance registered (dispose, and a failed create). */
export function removeStructureColliders(colliders, instance, data) {
  if (colliders) for (const id of instance.colliderIds) colliders.remove(id);
  instance.colliderIds.length = 0;
  data.turbineColliders = null;
}

/**
 * A floating island's top as a landable heightfield spec (world): the exact top (islandTopHeight over
 * islandOutline) sampled on a grid out to one cell past the outline (rim level there), published as
 * the exact function so landings stand on exactly the rendered top, as in Phase 2.
 */
export function islandTopCollider(surface, anchor, id, owner) {
  const centreX = anchor.x + surface.x;
  const centreZ = anchor.z + surface.z;
  const topY = anchor.y + surface.topY;
  const cell = Math.min(ISLAND_CELL_RANGE[1], Math.max(ISLAND_CELL_RANGE[0], surface.radius * ISLAND_CELL_SHARE));
  const reach = surface.radius * 1.25 + cell;
  const cols = Math.ceil((reach * 2) / cell) + 1;
  const x0 = centreX - ((cols - 1) * cell) / 2;
  const z0 = centreZ - ((cols - 1) * cell) / 2;
  const heights = new Float32Array(cols * cols);
  const outlineAt = (offsetX, offsetZ) => islandOutline(Math.atan2(offsetX, -offsetZ), surface.radius, surface.phaseA, surface.phaseB, surface.phaseC);
  for (let row = 0; row < cols; row++) {
    for (let column = 0; column < cols; column++) {
      const offsetX = x0 + column * cell - centreX;
      const offsetZ = z0 + row * cell - centreZ;
      const share = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) / outlineAt(offsetX, offsetZ);
      // Inside the outline the top itself; within a cell past it the rim level; beyond, a hole.
      const pastRim = (share - 1) * outlineAt(offsetX, offsetZ);
      heights[row * cols + column] = share <= 1 ? topY + islandTopHeight(share, surface.dome) : pastRim <= cell * 1.5 ? topY - RIM_DROP : NaN;
    }
  }
  return {
    id,
    owner,
    type: 'heightfield',
    x0, z0, cell, cols, rows: cols, heights,
    bottom: topY - RIM_DROP - ISLAND_SLAB_DEPTH,
    surfaceHeightAt(x, z) {
      const offsetX = x - centreX;
      const offsetZ = z - centreZ;
      const share = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) / outlineAt(offsetX, offsetZ);
      return share > 1 ? NaN : topY + islandTopHeight(share, surface.dome);
    },
    tags: { landable: true, surface: 'stone' },
  };
}
