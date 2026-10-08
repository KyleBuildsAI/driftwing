// COLLIDERS (ctx.colliders): the structure collision service of Phase 3 (contract section b). Pure JS,
// no three.js: the node labs run it as it is, and it never touches a render matrix (colliders live in
// the WORLD frame, float64, and know nothing of the floating origin).
//
// Shapes (world metres; { x, y, z } points, { x, y, z, w } quaternions):
//   box          center, halfExtents { x, y, z }, quaternion?          an oriented box
//   cylinder     center, radius, halfHeight, quaternion?               axis local +y (a mast, a tower,
//                                                                       a flat disc for a rotor)
//   capsule      a, b, radius                                          a segment plus radius (ropes,
//                                                                       kite strings, arch ribs)
//   hull         points (xyz triples, 4..64), center?, quaternion?     a convex hull built once
//                                                                       (deterministic); with center
//                                                                       the points are local to it and
//                                                                       the hull can move (balloons)
//   heightfield  x0, z0, cell, cols, rows, heights (world y, NaN = a   a solid prism from bottom up to
//                hole), bottom, surfaceHeightAt?                        the triangulated heights:
//                                                                       landable tops (island tops)
//   mesh         mesh: a MeshCollider (src/world/colliderMesh.js)       three-mesh-bvh, main thread only,
//                                                                       where no primitive fits
//
// Every collider is a record { id, owner, type, ...shape, tags: { landable, perch, sensor, miss,
// surface }, velocity }. A landable collider publishes its up-facing faces (normal.y > 0.7) to the
// Phase 2 extra ground surfaces under its own id (heightfields publish surfaceHeightAt when given:
// the exact top the mesh is built from), so landings on structures use the existing ground contact.
// A sensor is never solid: sweeps report it to filter.onSensor (kite strings count a miss).
//
// Records are filed in a 2D spatial hash of cellSize-metre cells (like the WindField's). Providers
// (addProvider) emit procedural colliders on demand for a queried box (vegetation trunks, labyrinth
// walls); perch providers (addPerchProvider) add perch points (peaks, tree tops). Results never depend
// on insertion order (the earliest hit wins, ties go to the lower id), frame rate or streaming.
//
// Allocation: the queries allocate nothing in steady state. Numbers reach the narrow phase through the
// registers of colliderMath.js, never as call arguments, because the JIT boxes a double passed to a
// call it does not inline; for the same reason the per-tick path of the flight controller is the
// batch sweepProbes (typed arrays in, one call per tick), while sweepSphere and the other single
// queries take the contract's number arguments.
import {
  ColliderVector, EPSILON, SEGMENT, SHAPE, SWEEP, TRIANGLE, VECTOR, boxDepth, buildConvexHull, createSweepResult, cylinderDepth,
  hullDepth, resetSweepResult, rotateRegister, segmentDistance, sweepBox, sweepCylinder, sweepHull, sweepSegment,
  sweepTriangleFace,
} from './colliderMath.js';
import { createCellGrid } from './cellGrid.js';

export const COLLIDER_TYPES = Object.freeze(['box', 'cylinder', 'capsule', 'hull', 'heightfield', 'mesh']);
export const COLLIDER_SURFACES = Object.freeze(['stone', 'wood', 'metal', 'ice', 'foliage', 'cloth', 'rope']);
/** A face of a landable collider whose normal points up more than this is ground (contract b.3). */
export const LANDABLE_NORMAL_Y = 0.7;
/** The types that may be landable (their up-facing faces publish to the ground surfaces). */
const LANDABLE_TYPES = Object.freeze(['box', 'cylinder', 'hull', 'heightfield']);
/** A collider spanning more cells than this is checked by every query instead of being filed. */
const MAX_FILED_CELLS = 4096;
/** Two hits closer than this in t are a tie (the lower id wins). */
const TIE_EPSILON = 1e-12;
/** liftClear stops after this many stacked colliders. */
const MAX_LIFT_STEPS = 8;
const IDENTITY_QUATERNION = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function fail(id, field, problem) {
  throw new Error(`[DRIFTWING] collider "${id}": ${field} ${problem}`);
}

function isVector(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function readVector(id, field, value) {
  if (!isVector(value)) fail(id, field, 'must be a finite { x, y, z }');
  return value;
}

function readPositive(id, field, value) {
  if (!Number.isFinite(value) || value <= 0) fail(id, field, 'must be a positive number');
  return value;
}

/** Writes the unit quaternion of value ({ x, y, z, w }, identity when absent) into target. */
function readQuaternion(id, value, target) {
  const quaternion = value ?? IDENTITY_QUATERNION;
  if (quaternion === null || typeof quaternion !== 'object' || !Number.isFinite(quaternion.x) || !Number.isFinite(quaternion.y) || !Number.isFinite(quaternion.z) || !Number.isFinite(quaternion.w)) {
    fail(id, 'quaternion', 'must be a finite { x, y, z, w }');
  }
  const length = Math.sqrt(quaternion.x * quaternion.x + quaternion.y * quaternion.y + quaternion.z * quaternion.z + quaternion.w * quaternion.w);
  if (length < EPSILON) fail(id, 'quaternion', 'must not be zero');
  target[0] = quaternion.x / length;
  target[1] = quaternion.y / length;
  target[2] = quaternion.z / length;
  target[3] = quaternion.w / length;
}

/** The record's tags, checked and with their defaults (frozen: tags never change after add). */
function readTags(id, type, tags) {
  if (tags !== undefined && (tags === null || typeof tags !== 'object')) fail(id, 'tags', 'must be an object');
  const source = tags ?? {};
  const landable = source.landable ?? false;
  const sensor = source.sensor ?? false;
  const miss = source.miss ?? null;
  const surface = source.surface ?? 'stone';
  const perch = source.perch ?? false;
  if (typeof landable !== 'boolean') fail(id, 'tags.landable', 'must be a boolean');
  if (typeof sensor !== 'boolean') fail(id, 'tags.sensor', 'must be a boolean');
  if (miss !== null && (typeof miss !== 'string' || miss === '')) fail(id, 'tags.miss', 'must be null or a non-empty string');
  if (!COLLIDER_SURFACES.includes(surface)) fail(id, 'tags.surface', `must be one of ${COLLIDER_SURFACES.join(', ')}`);
  if (landable && sensor) fail(id, 'tags.landable', 'cannot be set on a sensor');
  if (landable && !LANDABLE_TYPES.includes(type)) fail(id, 'tags.landable', `is for ${LANDABLE_TYPES.join(', ')} colliders`);
  const perchList = Array.isArray(perch) ? perch : perch !== null && typeof perch === 'object' ? [perch] : null;
  if (perchList) perchList.forEach((point, index) => readVector(id, `tags.perch[${index}]`, point));
  else if (typeof perch !== 'boolean') fail(id, 'tags.perch', 'must be a boolean, a point or an array of points');
  return Object.freeze({ landable, perch: perchList ? Object.freeze(perchList.map((point) => Object.freeze({ x: point.x, y: point.y, z: point.z }))) : perch, sensor, miss, surface });
}

/**
 * A probe set for sweepProbes, sized for `capacity` probes: the caller fills count, from, to (world
 * xyz per probe), radii and gear (1: a gear probe, which stands on landable tops). sweepProbes writes
 * the earliest hit into hit ({ t, point, normal, id, owner, tags, velocity }) and returns its probe.
 */
export function createProbeSet(capacity) {
  return {
    count: 0,
    from: new Float64Array(capacity * 3),
    to: new Float64Array(capacity * 3),
    radii: new Float64Array(capacity),
    gear: new Uint8Array(capacity),
    hit: { t: 0.5, point: new ColliderVector(), normal: new ColliderVector(), id: null, owner: null, tags: null, velocity: null, distance: 0.5 },
  };
}

/**
 * Creates the collider world. options: { groundSurfaces (the Phase 2 extra ground surfaces, where
 * landable tops publish; null in labs without one), cellSize = 256 (m) }. main.js also passes the
 * bus (contract b.1); the service itself emits nothing (the flight controller emits colliderHit and
 * colliderSensor).
 */
export function createColliderWorld({ groundSurfaces = null, cellSize = 256 } = {}) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('[DRIFTWING] the collider world needs a positive cellSize');
  const records = new Map();
  const cells = createCellGrid();
  /** Colliders too large to file (more than MAX_FILED_CELLS cells): every query checks them. */
  const huge = [];
  const providers = [];
  const perchProviders = [];
  /** Compiled provider specs, keyed by the spec object the provider emitted (providers cache them). */
  const providerSpecs = new WeakMap();
  const failedProviders = new Set();
  // The candidates of the current query: the first candidateCount entries (the array never shrinks, since
  // setting an array's length to 0 releases its storage and the next pushes would allocate it again).
  const candidates = [];
  let candidateCount = 0;
  const counters = { sweeps: 0, hits: 0 };
  /** Sweep time (ms) while profiling is on (performance.now() boxes its result, so it is opt-in). */
  const timing = new Float64Array(2);
  let profiling = false;
  let queryStamp = 0;

  // Registers of the service (see the header): WORLD holds the sweep in the world frame (px, py, pz,
  // dx, dy, dz, r); QUERY the box a query collects (minX, minY, minZ, maxX, maxY, maxZ); FIELD_TOP a
  // heightfield's top under a point.
  const WORLD = new Float64Array(7);
  const QUERY = new Float64Array(6);
  const FIELD_TOP = new Float64Array(1);
  const hit = createSweepResult();
  const localHit = createSweepResult();
  const surfaceHit = createSweepResult();
  const best = { t: Infinity, nx: 0, ny: 1, nz: 0, record: null };
  let currentProvider = null;

  // ---- Compiling specs into records ------------------------------------------------------------------
  function compile(spec, defaultOwner = null) {
    if (spec === null || typeof spec !== 'object') throw new Error('[DRIFTWING] a collider spec must be an object');
    const id = spec.id;
    if (typeof id !== 'string' || id === '') throw new Error('[DRIFTWING] a collider needs a non-empty string id');
    const owner = spec.owner ?? defaultOwner;
    if (typeof owner !== 'string' || owner === '') fail(id, 'owner', 'must be a non-empty string');
    const type = spec.type;
    if (!COLLIDER_TYPES.includes(type)) fail(id, 'type', `must be one of ${COLLIDER_TYPES.join(', ')}`);
    const record = {
      id,
      owner,
      type,
      tags: readTags(id, type, spec.tags),
      velocity: null,
      center: new Float64Array(3),
      quaternion: new Float64Array([0, 0, 0, 1]),
      /** box: half extents; cylinder: radius, half height; capsule: radius (SHAPE layout). */
      shape: new Float64Array(3),
      ends: null,
      hull: null,
      points: null,
      field: null,
      mesh: null,
      bounds: new Float64Array(6),
      cells: new Int32Array(4),
      filed: 0,
      stamp: 0,
      perchPoints: null,
      surfaceHeight: null,
      published: false,
    };
    if (spec.velocity !== undefined && spec.velocity !== null) {
      const velocity = readVector(id, 'velocity', spec.velocity);
      record.velocity = new ColliderVector(velocity.x, velocity.y, velocity.z);
    }
    switch (type) {
      case 'box': {
        const center = readVector(id, 'center', spec.center);
        const half = readVector(id, 'halfExtents', spec.halfExtents);
        if (!(half.x > 0 && half.y > 0 && half.z > 0)) fail(id, 'halfExtents', 'must be positive on every axis');
        record.center.set([center.x, center.y, center.z]);
        record.shape.set([half.x, half.y, half.z]);
        readQuaternion(id, spec.quaternion, record.quaternion);
        break;
      }
      case 'cylinder': {
        const center = readVector(id, 'center', spec.center);
        record.center.set([center.x, center.y, center.z]);
        record.shape.set([readPositive(id, 'radius', spec.radius), readPositive(id, 'halfHeight', spec.halfHeight), 0]);
        readQuaternion(id, spec.quaternion, record.quaternion);
        break;
      }
      case 'capsule': {
        const a = readVector(id, 'a', spec.a);
        const b = readVector(id, 'b', spec.b);
        record.ends = new Float64Array([a.x, a.y, a.z, b.x, b.y, b.z]);
        record.shape[0] = readPositive(id, 'radius', spec.radius);
        break;
      }
      case 'hull':
        compileHull(record, spec);
        break;
      case 'heightfield':
        compileField(record, spec);
        break;
      case 'mesh': {
        const mesh = spec.mesh;
        if (!mesh || mesh.type !== 'mesh' || typeof mesh.sweep !== 'function' || typeof mesh.depth !== 'function' || !mesh.bounds || !isVector(mesh.bounds.min) || !isVector(mesh.bounds.max)) {
          fail(id, 'mesh', 'must be a MeshCollider from src/world/colliderMesh.js');
        }
        record.mesh = mesh;
        break;
      }
      default:
        fail(id, 'type', 'is unknown');
    }
    computeBounds(record);
    computePerches(record);
    if (record.tags.landable) record.surfaceHeight = (x, z) => surfaceHeightOf(record, x, z);
    return record;
  }

  function compileHull(record, spec) {
    const id = record.id;
    const source = spec.points;
    if (!(source instanceof Float64Array || source instanceof Float32Array || Array.isArray(source))) fail(id, 'points', 'must be a Float64Array of xyz triples');
    if (source.length % 3 !== 0) fail(id, 'points', 'must hold xyz triples');
    const count = source.length / 3;
    const points = new Float64Array(source.length);
    for (let index = 0; index < source.length; index++) {
      if (!Number.isFinite(source[index])) fail(id, 'points', 'must all be finite');
      points[index] = source[index];
    }
    if (spec.center !== undefined && spec.center !== null) {
      const center = readVector(id, 'center', spec.center);
      record.center.set([center.x, center.y, center.z]);
      readQuaternion(id, spec.quaternion, record.quaternion);
    } else {
      if (spec.quaternion !== undefined) fail(id, 'quaternion', 'needs a center (world points carry their own rotation)');
      // World points: the hull keeps them relative to their centroid (precision far from the origin).
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      for (let index = 0; index < count; index++) {
        sumX += points[index * 3];
        sumY += points[index * 3 + 1];
        sumZ += points[index * 3 + 2];
      }
      record.center.set([sumX / count, sumY / count, sumZ / count]);
      for (let index = 0; index < count; index++) {
        points[index * 3] -= record.center[0];
        points[index * 3 + 1] -= record.center[1];
        points[index * 3 + 2] -= record.center[2];
      }
    }
    try {
      record.hull = buildConvexHull(points, count);
    } catch (error) {
      fail(id, 'points', `do not make a hull: ${error.message}`);
    }
    record.points = points;
  }

  function compileField(record, spec) {
    const id = record.id;
    for (const field of ['x0', 'z0', 'bottom']) if (!Number.isFinite(spec[field])) fail(id, field, 'must be a finite number');
    const cell = readPositive(id, 'cell', spec.cell);
    if (!Number.isInteger(spec.cols) || spec.cols < 2) fail(id, 'cols', 'must be an integer of at least 2');
    if (!Number.isInteger(spec.rows) || spec.rows < 2) fail(id, 'rows', 'must be an integer of at least 2');
    const heights = spec.heights;
    if (!(heights instanceof Float32Array || heights instanceof Float64Array) || heights.length !== spec.cols * spec.rows) fail(id, 'heights', 'must be a Float32Array(cols * rows)');
    let maxHeight = -Infinity;
    let solidCells = 0;
    for (let index = 0; index < heights.length; index++) {
      const height = heights[index];
      if (Number.isNaN(height)) continue;
      if (!Number.isFinite(height) || height < spec.bottom) fail(id, 'heights', 'must be finite (or NaN for a hole) and at or above bottom');
      if (height > maxHeight) maxHeight = height;
    }
    for (let row = 0; row < spec.rows - 1; row++) for (let column = 0; column < spec.cols - 1; column++) if (cellSolidIn(heights, spec.cols, spec.rows, column, row)) solidCells++;
    if (solidCells === 0) fail(id, 'heights', 'must make at least one solid cell');
    if (spec.surfaceHeightAt !== undefined && typeof spec.surfaceHeightAt !== 'function') fail(id, 'surfaceHeightAt', 'must be a function (x, z) -> height or NaN');
    record.field = {
      x0: spec.x0, z0: spec.z0, cell, cols: spec.cols, rows: spec.rows, heights, bottom: spec.bottom, maxHeight,
      surfaceHeightAt: spec.surfaceHeightAt ?? null,
    };
  }

  // ---- Bounds, cells, perches -----------------------------------------------------------------------
  /** VECTOR = the record's local vector (x, y, z) rotated into the world frame. */
  function rotateOut(record, x, y, z) {
    VECTOR[0] = x;
    VECTOR[1] = y;
    VECTOR[2] = z;
    rotateRegister(record.quaternion, false);
  }

  function computeBounds(record) {
    const bounds = record.bounds;
    const center = record.center;
    const shape = record.shape;
    switch (record.type) {
      case 'box': {
        // Each world axis reaches the sum of the rotated half axes' components.
        for (let axis = 0; axis < 3; axis++) bounds[axis] = 0;
        for (let local = 0; local < 3; local++) {
          VECTOR[0] = local === 0 ? shape[0] : 0;
          VECTOR[1] = local === 1 ? shape[1] : 0;
          VECTOR[2] = local === 2 ? shape[2] : 0;
          rotateRegister(record.quaternion, false);
          for (let axis = 0; axis < 3; axis++) bounds[axis] += Math.abs(VECTOR[axis]);
        }
        for (let axis = 0; axis < 3; axis++) {
          bounds[axis + 3] = center[axis] + bounds[axis];
          bounds[axis] = center[axis] - bounds[axis];
        }
        break;
      }
      case 'cylinder': {
        VECTOR[0] = 0;
        VECTOR[1] = 1;
        VECTOR[2] = 0;
        rotateRegister(record.quaternion, false);
        for (let axis = 0; axis < 3; axis++) {
          const along = VECTOR[axis];
          const reach = Math.abs(along) * shape[1] + shape[0] * Math.sqrt(Math.max(0, 1 - along * along));
          bounds[axis] = center[axis] - reach;
          bounds[axis + 3] = center[axis] + reach;
        }
        break;
      }
      case 'capsule':
        for (let axis = 0; axis < 3; axis++) {
          bounds[axis] = Math.min(record.ends[axis], record.ends[axis + 3]) - shape[0];
          bounds[axis + 3] = Math.max(record.ends[axis], record.ends[axis + 3]) + shape[0];
        }
        break;
      case 'hull': {
        for (let axis = 0; axis < 3; axis++) {
          bounds[axis] = Infinity;
          bounds[axis + 3] = -Infinity;
        }
        const points = record.points;
        for (let index = 0; index < points.length; index += 3) {
          VECTOR[0] = points[index];
          VECTOR[1] = points[index + 1];
          VECTOR[2] = points[index + 2];
          rotateRegister(record.quaternion, false);
          for (let axis = 0; axis < 3; axis++) {
            const value = center[axis] + VECTOR[axis];
            if (value < bounds[axis]) bounds[axis] = value;
            if (value > bounds[axis + 3]) bounds[axis + 3] = value;
          }
        }
        break;
      }
      case 'heightfield': {
        const field = record.field;
        bounds[0] = field.x0;
        bounds[1] = field.bottom;
        bounds[2] = field.z0;
        bounds[3] = field.x0 + (field.cols - 1) * field.cell;
        bounds[4] = field.maxHeight;
        bounds[5] = field.z0 + (field.rows - 1) * field.cell;
        break;
      }
      case 'mesh': {
        const { min, max } = record.mesh.bounds;
        bounds[0] = min.x;
        bounds[1] = min.y;
        bounds[2] = min.z;
        bounds[3] = max.x;
        bounds[4] = max.y;
        bounds[5] = max.z;
        break;
      }
      default:
        break;
    }
  }

  /** Perch points (world): the given points, or for perch: true the top centre of the shape. */
  function computePerches(record) {
    const perch = record.tags.perch;
    if (perch === false) return;
    if (Array.isArray(perch)) {
      if (!record.perchPoints) {
        record.perchPoints = new Float64Array(perch.length * 3);
        perch.forEach((point, index) => record.perchPoints.set([point.x, point.y, point.z], index * 3));
      }
      return;
    }
    if (!record.perchPoints) record.perchPoints = new Float64Array(3);
    const out = record.perchPoints;
    const center = record.center;
    switch (record.type) {
      case 'box':
      case 'cylinder': {
        rotateOut(record, 0, record.shape[1], 0);
        // The face centre that points up most (a box on its side perches on its top face).
        const sign = VECTOR[1] >= 0 ? 1 : -1;
        out[0] = center[0] + VECTOR[0] * sign;
        out[1] = center[1] + VECTOR[1] * sign;
        out[2] = center[2] + VECTOR[2] * sign;
        break;
      }
      case 'capsule': {
        const top = record.ends[1] >= record.ends[4] ? 0 : 3;
        out[0] = record.ends[top];
        out[1] = record.ends[top + 1] + record.shape[0];
        out[2] = record.ends[top + 2];
        break;
      }
      case 'hull': {
        const points = record.points;
        let highest = -Infinity;
        for (let index = 0; index < points.length; index += 3) {
          rotateOut(record, points[index], points[index + 1], points[index + 2]);
          if (center[1] + VECTOR[1] > highest) {
            highest = center[1] + VECTOR[1];
            out[0] = center[0] + VECTOR[0];
            out[1] = highest;
            out[2] = center[2] + VECTOR[2];
          }
        }
        break;
      }
      case 'heightfield': {
        const field = record.field;
        let highest = -Infinity;
        for (let index = 0; index < field.heights.length; index++) {
          if (field.heights[index] > highest) {
            highest = field.heights[index];
            out[0] = field.x0 + (index % field.cols) * field.cell;
            out[1] = highest;
            out[2] = field.z0 + Math.floor(index / field.cols) * field.cell;
          }
        }
        break;
      }
      default: {
        const bounds = record.bounds;
        out[0] = (bounds[0] + bounds[3]) * 0.5;
        out[1] = bounds[4];
        out[2] = (bounds[2] + bounds[5]) * 0.5;
      }
    }
  }

  function cellRange(bounds, out) {
    out[0] = Math.floor(bounds[0] / cellSize);
    out[1] = Math.floor(bounds[2] / cellSize);
    out[2] = Math.floor(bounds[3] / cellSize);
    out[3] = Math.floor(bounds[5] / cellSize);
  }

  function file(record) {
    const range = record.cells;
    cellRange(record.bounds, range);
    if ((range[2] - range[0] + 1) * (range[3] - range[1] + 1) > MAX_FILED_CELLS) {
      record.filed = 2;
      huge.push(record);
      return;
    }
    record.filed = 1;
    for (let cellX = range[0]; cellX <= range[2]; cellX++) {
      for (let cellZ = range[1]; cellZ <= range[3]; cellZ++) cells.add(cellX, cellZ, record);
    }
  }

  /** Takes the record out of its cells (keepEmpty: it is refiling, so emptied cells stay for reuse). */
  function unfile(record, keepEmpty = false) {
    if (record.filed === 2) {
      cells.removeFrom(huge, record);
    } else if (record.filed === 1) {
      const range = record.cells;
      for (let cellX = range[0]; cellX <= range[2]; cellX++) {
        for (let cellZ = range[1]; cellZ <= range[3]; cellZ++) cells.remove(cellX, cellZ, record, keepEmpty);
      }
    }
    record.filed = 0;
  }

  const refileRange = new Int32Array(4);
  function refile(record) {
    cellRange(record.bounds, refileRange);
    const range = record.cells;
    if (record.filed === 1 && refileRange[0] === range[0] && refileRange[1] === range[1] && refileRange[2] === range[2] && refileRange[3] === range[3]) return;
    unfile(record, true);
    file(record);
  }

  // ---- Ground surfaces (landable tops) ---------------------------------------------------------------
  function publish(record) {
    if (!groundSurfaces || !record.tags.landable) return;
    const bounds = record.bounds;
    groundSurfaces.add({ id: record.id, minX: bounds[0], maxX: bounds[3], minZ: bounds[2], maxZ: bounds[5], top: bounds[4], heightAt: record.surfaceHeight });
    record.published = true;
  }

  function unpublish(record) {
    if (!record.published) return;
    groundSurfaces.remove(record.id);
    record.published = false;
  }

  /** The landable top at (x, z): the up-facing face a vertical ray meets first, or NaN. */
  function surfaceHeightOf(record, x, z) {
    const bounds = record.bounds;
    if (x < bounds[0] || x > bounds[3] || z < bounds[2] || z > bounds[5]) return NaN;
    if (record.type === 'heightfield') {
      const field = record.field;
      if (field.surfaceHeightAt) return field.surfaceHeightAt(x, z);
      return fieldTop(field, x, z) ? FIELD_TOP[0] : NaN;
    }
    const top = bounds[4] + 1;
    const drop = bounds[4] - bounds[1] + 2;
    WORLD[0] = x;
    WORLD[1] = top;
    WORLD[2] = z;
    WORLD[3] = 0;
    WORLD[4] = -drop;
    WORLD[5] = 0;
    WORLD[6] = 0;
    resetSweepResult(surfaceHit);
    if (!narrow(record, surfaceHit)) return NaN;
    if (surfaceHit.ny <= LANDABLE_NORMAL_Y) return NaN;
    return top - drop * surfaceHit.t;
  }

  // ---- Heightfields ------------------------------------------------------------------------------------
  function cellSolidIn(heights, cols, rows, column, row) {
    if (column < 0 || row < 0 || column >= cols - 1 || row >= rows - 1) return false;
    const base = row * cols + column;
    return heights[base] === heights[base] && heights[base + 1] === heights[base + 1] && heights[base + cols] === heights[base + cols] && heights[base + cols + 1] === heights[base + cols + 1];
  }

  /** FIELD_TOP[0] = the triangulated height of a solid cell at (x, z); false outside the solid cells. */
  function fieldTop(field, x, z) {
    const u = (x - field.x0) / field.cell;
    const v = (z - field.z0) / field.cell;
    // Off the grid on its far sides too (the clamp below only keeps the far edge itself in the last cell).
    if (u > field.cols - 1 || v > field.rows - 1) return false;
    const column = Math.min(Math.floor(u), field.cols - 2);
    const row = Math.min(Math.floor(v), field.rows - 2);
    if (!cellSolidIn(field.heights, field.cols, field.rows, column, row)) return false;
    const fu = u - column;
    const fv = v - row;
    const base = row * field.cols + column;
    const h00 = field.heights[base];
    const h10 = field.heights[base + 1];
    const h01 = field.heights[base + field.cols];
    const h11 = field.heights[base + field.cols + 1];
    // Triangles (00, 10, 11) and (00, 11, 01), split along the 00-11 diagonal.
    FIELD_TOP[0] = fu >= fv ? h00 + (h10 - h00) * fu + (h11 - h10) * fv : h00 + (h11 - h01) * fu + (h01 - h00) * fv;
    return true;
  }

  /** TRIANGLE corner `corner` = the grid corner `code` of the cell (bit 0: +1 column, bit 1: +1 row). */
  function loadFieldCorner(field, column, row, corner, code) {
    const dx = code & 1;
    const dz = code >> 1;
    TRIANGLE[corner * 3] = field.x0 + (column + dx) * field.cell;
    TRIANGLE[corner * 3 + 1] = field.heights[(row + dz) * field.cols + column + dx];
    TRIANGLE[corner * 3 + 2] = field.z0 + (row + dz) * field.cell;
  }

  /** TRIANGLE = the cell's corners `first`, `second`, `third` (corner codes) on its top. */
  function loadFieldTriangle(field, column, row, first, second, third) {
    loadFieldCorner(field, column, row, 0, first);
    loadFieldCorner(field, column, row, 1, second);
    loadFieldCorner(field, column, row, 2, third);
  }

  // Corner codes of a cell: bit 0 = +1 column (x), bit 1 = +1 row (z): 0 = 00, 1 = 10, 2 = 01, 3 = 11.
  const FIELD_EDGES = Object.freeze([0, 1, 0, 2, 0, 3, 1, 3, 2, 3]);
  // Walls: [neighbour column offset, neighbour row offset, corner a, corner b].
  const FIELD_WALLS = Object.freeze([0, -1, 0, 1, 0, 1, 2, 3, -1, 0, 0, 2, 1, 0, 1, 3]);

  /** SEGMENT = the cell's corners a and b on the top (top = 1) or on the bottom (top = 0). */
  function loadFieldEdge(field, column, row, a, b, topA, topB) {
    SEGMENT[0] = field.x0 + (column + (a & 1)) * field.cell;
    SEGMENT[1] = topA ? field.heights[(row + (a >> 1)) * field.cols + column + (a & 1)] : field.bottom;
    SEGMENT[2] = field.z0 + (row + (a >> 1)) * field.cell;
    SEGMENT[3] = field.x0 + (column + (b & 1)) * field.cell;
    SEGMENT[4] = topB ? field.heights[(row + (b >> 1)) * field.cols + column + (b & 1)] : field.bottom;
    SEGMENT[5] = field.z0 + (row + (b >> 1)) * field.cell;
    SEGMENT[6] = SWEEP[6];
  }

  /** A wall quad (corners a, b from the bottom up to the top) as two triangles, plus its edges. */
  function sweepFieldWall(field, column, row, a, b, result) {
    let found = false;
    const ax = field.x0 + (column + (a & 1)) * field.cell;
    const az = field.z0 + (row + (a >> 1)) * field.cell;
    const bx = field.x0 + (column + (b & 1)) * field.cell;
    const bz = field.z0 + (row + (b >> 1)) * field.cell;
    const topA = field.heights[(row + (a >> 1)) * field.cols + column + (a & 1)];
    const topB = field.heights[(row + (b >> 1)) * field.cols + column + (b & 1)];
    TRIANGLE[0] = ax;
    TRIANGLE[1] = field.bottom;
    TRIANGLE[2] = az;
    TRIANGLE[3] = bx;
    TRIANGLE[4] = field.bottom;
    TRIANGLE[5] = bz;
    TRIANGLE[6] = bx;
    TRIANGLE[7] = topB;
    TRIANGLE[8] = bz;
    if (sweepTriangleFace(result)) found = true;
    TRIANGLE[3] = bx;
    TRIANGLE[4] = topB;
    TRIANGLE[5] = bz;
    TRIANGLE[6] = ax;
    TRIANGLE[7] = topA;
    TRIANGLE[8] = az;
    if (sweepTriangleFace(result)) found = true;
    if (SWEEP[6] > 0) {
      loadFieldEdge(field, column, row, a, b, 0, 0);
      if (sweepSegment(result)) found = true;
      loadFieldEdge(field, column, row, a, a, 0, 1);
      if (sweepSegment(result)) found = true;
      loadFieldEdge(field, column, row, b, b, 0, 1);
      if (sweepSegment(result)) found = true;
    }
    return found;
  }

  /**
   * The sphere (SWEEP, world frame) against the heightfield's solid: the union of one triangular prism
   * per top triangle. Only its boundary is tested: the top triangles, the bottom, and the walls where a
   * neighbour cell is a hole or off the grid.
   */
  function sweepField(field, result) {
    const px = SWEEP[0];
    const py = SWEEP[1];
    const pz = SWEEP[2];
    const dx = SWEEP[3];
    const dy = SWEEP[4];
    const dz = SWEEP[5];
    const r = SWEEP[6];
    if (fieldTop(field, px, pz) && py <= FIELD_TOP[0] && py >= field.bottom) {
      const up = FIELD_TOP[0] - py <= py - field.bottom;
      if (!(0 < result.t)) return false;
      result.t = 0;
      result.nx = 0;
      result.ny = up ? 1 : -1;
      result.nz = 0;
      return true;
    }
    const { cols, rows, heights, bottom } = field;
    const minY = Math.min(py, py + dy) - r;
    const maxY = Math.max(py, py + dy) + r;
    const firstColumn = Math.max(0, Math.floor((Math.min(px, px + dx) - r - field.x0) / field.cell));
    const lastColumn = Math.min(cols - 2, Math.floor((Math.max(px, px + dx) + r - field.x0) / field.cell));
    const firstRow = Math.max(0, Math.floor((Math.min(pz, pz + dz) - r - field.z0) / field.cell));
    const lastRow = Math.min(rows - 2, Math.floor((Math.max(pz, pz + dz) + r - field.z0) / field.cell));
    let found = false;
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        if (!cellSolidIn(heights, cols, rows, column, row)) continue;
        const base = row * cols + column;
        if (minY > Math.max(heights[base], heights[base + 1], heights[base + cols], heights[base + cols + 1]) || maxY < bottom) continue;
        loadFieldTriangle(field, column, row, 0, 1, 3);
        if (sweepTriangleFace(result)) found = true;
        loadFieldTriangle(field, column, row, 0, 3, 2);
        if (sweepTriangleFace(result)) found = true;
        if (r > 0) {
          for (let edge = 0; edge < FIELD_EDGES.length; edge += 2) {
            loadFieldEdge(field, column, row, FIELD_EDGES[edge], FIELD_EDGES[edge + 1], 1, 1);
            if (sweepSegment(result)) found = true;
          }
        }
        if (minY <= bottom) {
          // The bottom: the same two triangles at the bottom height.
          for (let triangle = 0; triangle < 2; triangle++) {
            loadFieldTriangle(field, column, row, 0, triangle === 0 ? 1 : 3, triangle === 0 ? 3 : 2);
            TRIANGLE[1] = bottom;
            TRIANGLE[4] = bottom;
            TRIANGLE[7] = bottom;
            if (sweepTriangleFace(result)) found = true;
          }
        }
        for (let wall = 0; wall < FIELD_WALLS.length; wall += 4) {
          if (cellSolidIn(heights, cols, rows, column + FIELD_WALLS[wall], row + FIELD_WALLS[wall + 1])) continue;
          if (sweepFieldWall(field, column, row, FIELD_WALLS[wall + 2], FIELD_WALLS[wall + 3], result)) found = true;
        }
      }
    }
    return found;
  }

  // ---- The narrow phase -------------------------------------------------------------------------------
  /**
   * Sweeps the sphere WORLD against one record; writes `result` (world normal) for a hit before
   * result.t and returns true.
   */
  function narrow(record, result) {
    switch (record.type) {
      case 'capsule':
        SWEEP.set(WORLD);
        SEGMENT.set(record.ends);
        SEGMENT[6] = WORLD[6] + record.shape[0];
        return sweepSegment(result);
      case 'heightfield':
        SWEEP.set(WORLD);
        return sweepField(record.field, result);
      case 'mesh':
        return record.mesh.sweep(WORLD, result);
      default: {
        // box, cylinder, hull: into the shape's frame, and the normal back out.
        const center = record.center;
        VECTOR[0] = WORLD[0] - center[0];
        VECTOR[1] = WORLD[1] - center[1];
        VECTOR[2] = WORLD[2] - center[2];
        rotateRegister(record.quaternion, true);
        SWEEP[0] = VECTOR[0];
        SWEEP[1] = VECTOR[1];
        SWEEP[2] = VECTOR[2];
        VECTOR[0] = WORLD[3];
        VECTOR[1] = WORLD[4];
        VECTOR[2] = WORLD[5];
        rotateRegister(record.quaternion, true);
        SWEEP[3] = VECTOR[0];
        SWEEP[4] = VECTOR[1];
        SWEEP[5] = VECTOR[2];
        SWEEP[6] = WORLD[6];
        SHAPE.set(record.shape);
        localHit.t = result.t;
        let found;
        if (record.type === 'box') found = sweepBox(localHit);
        else if (record.type === 'cylinder') found = sweepCylinder(localHit);
        else found = sweepHull(record.points, record.hull, localHit);
        if (!found) return false;
        VECTOR[0] = localHit.nx;
        VECTOR[1] = localHit.ny;
        VECTOR[2] = localHit.nz;
        rotateRegister(record.quaternion, false);
        result.t = localHit.t;
        result.nx = VECTOR[0];
        result.ny = VECTOR[1];
        result.nz = VECTOR[2];
        return true;
      }
    }
  }

  /** How deep (m) the point WORLD[0..2] is inside the record's solid, else a negative number. */
  function depthOf(record) {
    switch (record.type) {
      case 'capsule':
        SEGMENT.set(record.ends);
        VECTOR[0] = WORLD[0];
        VECTOR[1] = WORLD[1];
        VECTOR[2] = WORLD[2];
        return record.shape[0] - segmentDistance();
      case 'heightfield':
        if (!fieldTop(record.field, WORLD[0], WORLD[2])) return -1;
        return Math.min(FIELD_TOP[0] - WORLD[1], WORLD[1] - record.field.bottom);
      case 'mesh':
        return record.mesh.depth(WORLD[0], WORLD[1], WORLD[2]);
      default: {
        VECTOR[0] = WORLD[0] - record.center[0];
        VECTOR[1] = WORLD[1] - record.center[1];
        VECTOR[2] = WORLD[2] - record.center[2];
        rotateRegister(record.quaternion, true);
        SHAPE.set(record.shape);
        if (record.type === 'box') return boxDepth();
        if (record.type === 'cylinder') return cylinderDepth();
        return hullDepth(record.hull);
      }
    }
  }

  // ---- Candidates: the spatial hash plus the providers -----------------------------------------------
  function overlapsQuery(bounds) {
    return bounds[0] <= QUERY[3] && bounds[3] >= QUERY[0] && bounds[1] <= QUERY[4] && bounds[4] >= QUERY[1] && bounds[2] <= QUERY[5] && bounds[5] >= QUERY[2];
  }

  function consider(record) {
    if (record.stamp === queryStamp) return;
    record.stamp = queryStamp;
    if (overlapsQuery(record.bounds)) candidates[candidateCount++] = record;
  }

  /** emit(spec) for providers: compiled once per spec object, then filtered like filed records. */
  function emitProvided(spec) {
    const provider = currentProvider;
    let record = providerSpecs.get(spec);
    if (!record) {
      try {
        record = compile(spec, provider.id);
      } catch (error) {
        if (!failedProviders.has(provider.id)) {
          failedProviders.add(provider.id);
          console.error(`[DRIFTWING] collider provider "${provider.id}" emitted an invalid collider (logged once)`, error);
        }
        return;
      }
      providerSpecs.set(spec, record);
    }
    consider(record);
  }

  /** Fills `candidates` with every collider whose bounds overlap QUERY (deduplicated); returns the count. */
  function collect() {
    queryStamp++;
    candidateCount = 0;
    const firstX = Math.floor(QUERY[0] / cellSize);
    const lastX = Math.floor(QUERY[3] / cellSize);
    const firstZ = Math.floor(QUERY[2] / cellSize);
    const lastZ = Math.floor(QUERY[5] / cellSize);
    for (let cellX = firstX; cellX <= lastX; cellX++) {
      for (let cellZ = firstZ; cellZ <= lastZ; cellZ++) {
        const cell = cells.get(cellX, cellZ);
        if (cell === undefined) continue;
        for (let index = 0; index < cell.count; index++) consider(cell.items[index]);
      }
    }
    for (let index = 0; index < huge.length; index++) consider(huge[index]);
    for (let index = 0; index < providers.length; index++) {
      currentProvider = providers[index];
      try {
        currentProvider.query(QUERY[0], QUERY[2], QUERY[3], QUERY[5], emitProvided);
      } catch (error) {
        if (!failedProviders.has(currentProvider.id)) {
          failedProviders.add(currentProvider.id);
          console.error(`[DRIFTWING] collider provider "${currentProvider.id}" failed (logged once)`, error);
        }
      }
    }
    currentProvider = null;
    return candidateCount;
  }

  /** QUERY = the box of the sweep WORLD, grown by its radius. */
  function queryFromWorld() {
    for (let axis = 0; axis < 3; axis++) {
      const start = WORLD[axis];
      const end = start + WORLD[axis + 3];
      QUERY[axis] = (start < end ? start : end) - WORLD[6];
      QUERY[axis + 3] = (start > end ? start : end) + WORLD[6];
    }
  }

  /** QUERY = the cube of half size `radius` around the point (x, y, z) object's coordinates. */
  function queryAround(point, radius) {
    QUERY[0] = point.x - radius;
    QUERY[1] = point.y - radius;
    QUERY[2] = point.z - radius;
    QUERY[3] = point.x + radius;
    QUERY[4] = point.y + radius;
    QUERY[5] = point.z + radius;
  }

  // ---- Sweeps -----------------------------------------------------------------------------------------
  /** Keeps the hit in `candidate` for `record` when it is earlier than best (ties: lower id). */
  function offer(record, candidate) {
    if (candidate.t < best.t - TIE_EPSILON || (candidate.t <= best.t + TIE_EPSILON && (best.record === null || record.id < best.record.id))) {
      best.t = candidate.t;
      best.nx = candidate.nx;
      best.ny = candidate.ny;
      best.nz = candidate.nz;
      best.record = record;
    }
  }

  function prepareHit() {
    resetSweepResult(hit);
    if (best.t !== Infinity) hit.t = best.t + TIE_EPSILON;
  }

  /** True when the record's bounds overlap the box of the sweep WORLD (filters a shared candidate list). */
  function boundsReachWorld(bounds) {
    const r = WORLD[6];
    for (let axis = 0; axis < 3; axis++) {
      const start = WORLD[axis];
      const end = start + WORLD[axis + 3];
      if ((start < end ? start : end) - r > bounds[axis + 3] || (start > end ? start : end) + r < bounds[axis]) return false;
    }
    return true;
  }

  /**
   * The earliest solid hit of the sweep WORLD against the candidates, in `best`; sensors it touches
   * before that go to onSensor(record, probe) when includeSensors (without onSensor a sensor is a hit
   * like any other). Returns true on a hit.
   */
  function sweepCandidates(includeSensors, landableTops, onSensor, probe) {
    best.t = Infinity;
    best.record = null;
    for (let index = 0; index < candidateCount; index++) {
      const record = candidates[index];
      if (record.tags.sensor || !boundsReachWorld(record.bounds)) continue;
      prepareHit();
      if (!narrow(record, hit)) continue;
      // A gear probe stands on a landable top: its up-facing faces are ground, not a strike.
      if (!landableTops && record.tags.landable && hit.ny > LANDABLE_NORMAL_Y) continue;
      offer(record, hit);
    }
    if (includeSensors) {
      for (let index = 0; index < candidateCount; index++) {
        const record = candidates[index];
        if (!record.tags.sensor || !boundsReachWorld(record.bounds)) continue;
        prepareHit();
        if (!narrow(record, hit)) continue;
        if (onSensor) onSensor(record, probe);
        else offer(record, hit);
      }
    }
    return best.record !== null;
  }

  function writeOut(out) {
    const t = best.t;
    out.t = t;
    out.normal.x = best.nx;
    out.normal.y = best.ny;
    out.normal.z = best.nz;
    out.point.x = WORLD[0] + WORLD[3] * t - best.nx * WORLD[6];
    out.point.y = WORLD[1] + WORLD[4] * t - best.ny * WORLD[6];
    out.point.z = WORLD[2] + WORLD[5] * t - best.nz * WORLD[6];
    out.id = best.record.id;
    out.owner = best.record.owner;
    out.tags = best.record.tags;
    out.velocity = best.record.velocity;
  }

  /** WORLD = the probe's sweep from probes.from to probes.to with its radius. */
  function loadProbe(probes, probe) {
    const base = probe * 3;
    WORLD[0] = probes.from[base];
    WORLD[1] = probes.from[base + 1];
    WORLD[2] = probes.from[base + 2];
    WORLD[3] = probes.to[base] - WORLD[0];
    WORLD[4] = probes.to[base + 1] - WORLD[1];
    WORLD[5] = probes.to[base + 2] - WORLD[2];
    WORLD[6] = probes.radii[probe];
  }

  // ---- The service ---------------------------------------------------------------------------------------
  const service = {
    /** Validates and indexes a collider; returns its id. Throws naming the id and the field. */
    add(spec) {
      if (spec && typeof spec.id === 'string' && records.has(spec.id)) throw new Error(`[DRIFTWING] collider "${spec.id}" already exists`);
      const record = compile(spec);
      records.set(record.id, record);
      file(record);
      try {
        publish(record);
      } catch (error) {
        unfile(record);
        records.delete(record.id);
        throw error;
      }
      return record.id;
    },

    /**
     * Moves a kinematic collider: any of center, quaternion (box, cylinder, hull with a center), a, b
     * (capsule) and velocity. Refiles it only when its cells change. Allocation-free.
     */
    update(id, fields) {
      const record = records.get(id);
      if (!record) return false;
      const movable = record.type === 'box' || record.type === 'cylinder' || record.type === 'hull';
      if (fields.center !== undefined) {
        if (!movable) fail(id, 'center', `cannot move a ${record.type}`);
        record.center[0] = fields.center.x;
        record.center[1] = fields.center.y;
        record.center[2] = fields.center.z;
      }
      if (fields.quaternion !== undefined) {
        if (!movable) fail(id, 'quaternion', `cannot turn a ${record.type}`);
        readQuaternion(id, fields.quaternion, record.quaternion);
      }
      if (fields.a !== undefined || fields.b !== undefined) {
        if (record.type !== 'capsule') fail(id, 'a', 'and b move capsules only');
        if (fields.a !== undefined) {
          record.ends[0] = fields.a.x;
          record.ends[1] = fields.a.y;
          record.ends[2] = fields.a.z;
        }
        if (fields.b !== undefined) {
          record.ends[3] = fields.b.x;
          record.ends[4] = fields.b.y;
          record.ends[5] = fields.b.z;
        }
      }
      if (fields.velocity !== undefined) {
        if (fields.velocity === null) record.velocity = null;
        else if (record.velocity) {
          record.velocity.x = fields.velocity.x;
          record.velocity.y = fields.velocity.y;
          record.velocity.z = fields.velocity.z;
        } else {
          record.velocity = new ColliderVector(fields.velocity.x, fields.velocity.y, fields.velocity.z);
        }
      }
      computeBounds(record);
      if (record.tags.perch === true) computePerches(record);
      refile(record);
      if (record.published) {
        const bounds = record.bounds;
        groundSurfaces.setBounds(record.id, bounds[0], bounds[3], bounds[2], bounds[5], bounds[4]);
      }
      return true;
    },

    /**
     * The per-frame form of update for engines moving box, cylinder or hull colliders: pose is a
     * Float64Array(7) (center x, y, z, quaternion x, y, z, w), velocity an optional Float64Array(3)
     * (m/s). Typed arrays in, so nothing is boxed or allocated.
     */
    setPose(id, pose, velocity = null) {
      const record = records.get(id);
      if (!record) return false;
      if (record.type !== 'box' && record.type !== 'cylinder' && record.type !== 'hull') fail(id, 'pose', `cannot move a ${record.type}`);
      record.center[0] = pose[0];
      record.center[1] = pose[1];
      record.center[2] = pose[2];
      const length = Math.sqrt(pose[3] * pose[3] + pose[4] * pose[4] + pose[5] * pose[5] + pose[6] * pose[6]);
      if (!(length > EPSILON)) fail(id, 'pose', 'needs a non-zero quaternion');
      record.quaternion[0] = pose[3] / length;
      record.quaternion[1] = pose[4] / length;
      record.quaternion[2] = pose[5] / length;
      record.quaternion[3] = pose[6] / length;
      if (velocity !== null) {
        if (record.velocity === null) record.velocity = new ColliderVector(velocity[0], velocity[1], velocity[2]);
        record.velocity.x = velocity[0];
        record.velocity.y = velocity[1];
        record.velocity.z = velocity[2];
      }
      computeBounds(record);
      if (record.tags.perch === true) computePerches(record);
      refile(record);
      if (record.published) {
        const bounds = record.bounds;
        groundSurfaces.setBounds(record.id, bounds[0], bounds[3], bounds[2], bounds[5], bounds[4]);
      }
      return true;
    },

    /** Removes a collider (and its published ground surface); true when it was there. */
    remove(id) {
      const record = records.get(id);
      if (!record) return false;
      unfile(record);
      unpublish(record);
      records.delete(id);
      return true;
    },

    /** Removes every collider of an owner; returns the count. */
    removeOwner(owner) {
      const ids = [];
      for (const record of records.values()) if (record.owner === owner) ids.push(record.id);
      for (const id of ids) service.remove(id);
      return ids.length;
    },

    has(id) {
      return records.has(id);
    },

    /** The live record (read only): { id, owner, type, tags, velocity, bounds, ... } or null. */
    get(id) {
      return records.get(id) ?? null;
    },

    /**
     * Procedural colliders computed on demand: provider.query(minX, minZ, maxX, maxZ, emit) calls
     * emit(spec) for every collider in the box (spec ids required; owner defaults to the provider id).
     * The provider must be deterministic and cache its specs per cell (the service compiles each spec
     * object once).
     */
    addProvider(provider) {
      if (!provider || typeof provider.id !== 'string' || provider.id === '' || typeof provider.query !== 'function') throw new Error('[DRIFTWING] a collider provider needs { id, query(minX, minZ, maxX, maxZ, emit) }');
      if (providers.some((entry) => entry.id === provider.id)) throw new Error(`[DRIFTWING] collider provider "${provider.id}" already exists`);
      providers.push(provider);
      return provider.id;
    },

    removeProvider(id) {
      const index = providers.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      providers.splice(index, 1);
      failedProviders.delete(id);
      return true;
    },

    /** Perch points from elsewhere: provider.near(x, y, z, radius, visit) visits (x, y, z, kind, sourceId). */
    addPerchProvider(provider) {
      if (!provider || typeof provider.id !== 'string' || provider.id === '' || typeof provider.near !== 'function') throw new Error('[DRIFTWING] a perch provider needs { id, near(x, y, z, radius, visit) }');
      if (perchProviders.some((entry) => entry.id === provider.id)) throw new Error(`[DRIFTWING] perch provider "${provider.id}" already exists`);
      perchProviders.push(provider);
      return provider.id;
    },

    removePerchProvider(id) {
      const index = perchProviders.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      perchProviders.splice(index, 1);
      return true;
    },

    /**
     * Continuous test of a sphere moving from `from` to `to`. filter: { sensors (include sensors;
     * default false), landableTops (default true; false ignores the up-facing faces of landable
     * colliders: a gear probe), onSensor(record) (with sensors: every sensor the segment touches
     * before the first solid hit goes here and never blocks) }. Returns true on a hit, with out =
     * { t (0..1), point, normal, id, owner, tags, velocity } for the earliest hit (ties: lower id).
     * out.point and out.normal must be { x, y, z } objects the caller owns.
     */
    sweepSphere(from, to, radius, filter, out) {
      const started = profiling ? performance.now() : 0;
      counters.sweeps++;
      WORLD[0] = from.x;
      WORLD[1] = from.y;
      WORLD[2] = from.z;
      WORLD[3] = to.x - from.x;
      WORLD[4] = to.y - from.y;
      WORLD[5] = to.z - from.z;
      WORLD[6] = radius;
      queryFromWorld();
      collect();
      const includeSensors = filter ? filter.sensors === true : false;
      const landableTops = filter ? filter.landableTops !== false : true;
      const onSensor = filter && typeof filter.onSensor === 'function' ? filter.onSensor : null;
      const found = sweepCandidates(includeSensors, landableTops, onSensor, 0);
      if (found) {
        counters.hits++;
        writeOut(out);
      }
      if (profiling) timing[0] += performance.now() - started;
      return found;
    },

    /**
     * The flight controller's per-tick batch (allocation-free): every probe of a probe set
     * (createProbeSet) swept from probes.from to probes.to. One spatial query covers them all. Gear
     * probes ignore landable tops. Sensors touched go to onSensor(record, probeIndex) (or are ignored
     * without it). Returns the index of the probe with the earliest solid hit, written into
     * probes.hit, or -1.
     */
    sweepProbes(probes, onSensor = null) {
      const started = profiling ? performance.now() : 0;
      const count = probes.count;
      for (let axis = 0; axis < 6; axis++) QUERY[axis] = axis < 3 ? Infinity : -Infinity;
      for (let probe = 0; probe < count; probe++) {
        const radius = probes.radii[probe];
        for (let axis = 0; axis < 3; axis++) {
          const start = probes.from[probe * 3 + axis];
          const end = probes.to[probe * 3 + axis];
          const low = (start < end ? start : end) - radius;
          const high = (start > end ? start : end) + radius;
          if (low < QUERY[axis]) QUERY[axis] = low;
          if (high > QUERY[axis + 3]) QUERY[axis + 3] = high;
        }
      }
      if (count === 0 || collect() === 0) {
        if (profiling) timing[0] += performance.now() - started;
        return -1;
      }
      let winner = -1;
      let winnerT = Infinity;
      let winnerRecord = null;
      const out = probes.hit;
      for (let probe = 0; probe < count; probe++) {
        counters.sweeps++;
        loadProbe(probes, probe);
        if (!sweepCandidates(onSensor !== null, probes.gear[probe] === 0, onSensor, probe)) continue;
        if (best.t < winnerT - TIE_EPSILON || (best.t <= winnerT + TIE_EPSILON && winnerRecord !== null && best.record.id < winnerRecord.id)) {
          winner = probe;
          winnerT = best.t;
          winnerRecord = best.record;
          writeOut(out);
        }
      }
      if (winner >= 0) counters.hits++;
      if (profiling) timing[0] += performance.now() - started;
      return winner;
    },

    /** True when any probe of the set, at its `to` position, touches the collider `id` (sensor re-arming). */
    probesTouch(id, probes) {
      const record = records.get(id);
      if (!record) return false;
      for (let probe = 0; probe < probes.count; probe++) {
        const base = probe * 3;
        WORLD[0] = probes.to[base];
        WORLD[1] = probes.to[base + 1];
        WORLD[2] = probes.to[base + 2];
        WORLD[3] = 0;
        WORLD[4] = 0;
        WORLD[5] = 0;
        WORLD[6] = probes.radii[probe];
        resetSweepResult(hit);
        if (narrow(record, hit)) return true;
      }
      return false;
    },

    /** Every collider (sensors too) the sphere overlaps: visit(record) for each, in no set order. */
    overlapSphere(center, radius, visit) {
      queryAround(center, radius);
      collect();
      let count = 0;
      const total = candidateCount;
      for (let index = 0; index < total; index++) {
        const record = candidates[index];
        WORLD[0] = center.x;
        WORLD[1] = center.y;
        WORLD[2] = center.z;
        WORLD[3] = 0;
        WORLD[4] = 0;
        WORLD[5] = 0;
        WORLD[6] = radius;
        resetSweepResult(hit);
        if (!narrow(record, hit)) continue;
        count++;
        visit(record);
      }
      return count;
    },

    /**
     * First hit along a ray: direction (normalised here) up to maxDistance. filter as sweepSphere
     * (without onSensor). out as sweepSphere plus out.distance (m).
     */
    raycast(origin, direction, maxDistance, filter, out) {
      const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
      if (!(length > EPSILON) || !(maxDistance > 0)) return false;
      counters.sweeps++;
      WORLD[0] = origin.x;
      WORLD[1] = origin.y;
      WORLD[2] = origin.z;
      WORLD[3] = (direction.x / length) * maxDistance;
      WORLD[4] = (direction.y / length) * maxDistance;
      WORLD[5] = (direction.z / length) * maxDistance;
      WORLD[6] = 0;
      queryFromWorld();
      collect();
      const includeSensors = filter ? filter.sensors === true : false;
      const landableTops = filter ? filter.landableTops !== false : true;
      if (!sweepCandidates(includeSensors, landableTops, null, 0)) return false;
      counters.hits++;
      writeOut(out);
      out.distance = best.t * maxDistance;
      return true;
    },

    /** True when the sphere touches the collider `id`. */
    touches(id, center, radius) {
      const record = records.get(id);
      if (!record) return false;
      WORLD[0] = center.x;
      WORLD[1] = center.y;
      WORLD[2] = center.z;
      WORLD[3] = 0;
      WORLD[4] = 0;
      WORLD[5] = 0;
      WORLD[6] = radius;
      resetSweepResult(hit);
      return narrow(record, hit);
    },

    /**
     * Perch points within radius: visit(x, y, z, kind, sourceId) with kind 'structure' for tagged
     * colliders (sourceId the collider id), then whatever the perch providers report.
     */
    perchesNear(x, y, z, radius, visit) {
      QUERY[0] = x - radius;
      QUERY[1] = y - radius;
      QUERY[2] = z - radius;
      QUERY[3] = x + radius;
      QUERY[4] = y + radius;
      QUERY[5] = z + radius;
      collect();
      let count = 0;
      const radiusSquared = radius * radius;
      const total = candidateCount;
      for (let index = 0; index < total; index++) {
        const points = candidates[index].perchPoints;
        if (!points) continue;
        for (let point = 0; point < points.length; point += 3) {
          const ox = points[point] - x;
          const oy = points[point + 1] - y;
          const oz = points[point + 2] - z;
          if (ox * ox + oy * oy + oz * oz > radiusSquared) continue;
          count++;
          visit(points[point], points[point + 1], points[point + 2], 'structure', candidates[index].id);
        }
      }
      for (let index = 0; index < perchProviders.length; index++) perchProviders[index].near(x, y, z, radius, visit);
      return count;
    },

    /**
     * The solid collider (lowest id) holding the point deeper than `tolerance` m, or null: the
     * penetration check of ?test=collision and the soak.
     */
    insideSolid(x, y, z, tolerance = 0) {
      QUERY[0] = x;
      QUERY[1] = y;
      QUERY[2] = z;
      QUERY[3] = x;
      QUERY[4] = y;
      QUERY[5] = z;
      collect();
      let found = null;
      for (let index = 0; index < candidateCount; index++) {
        const record = candidates[index];
        if (record.tags.sensor) continue;
        WORLD[0] = x;
        WORLD[1] = y;
        WORLD[2] = z;
        if (depthOf(record) > tolerance && (found === null || record.id < found.id)) found = record;
      }
      return found ? found.id : null;
    },

    /**
     * The height a point at (x, z) must rise to so it is above every solid collider whose bounds hold
     * it (stacked ones too): y itself when none does. Respawns add their own margin on top.
     */
    liftClear(x, y, z) {
      let height = y;
      for (let step = 0; step < MAX_LIFT_STEPS; step++) {
        QUERY[0] = x;
        QUERY[1] = height;
        QUERY[2] = z;
        QUERY[3] = x;
        QUERY[4] = height;
        QUERY[5] = z;
        collect();
        let top = -Infinity;
        for (let index = 0; index < candidateCount; index++) {
          const record = candidates[index];
          if (!record.tags.sensor && record.bounds[4] > top) top = record.bounds[4];
        }
        if (top <= height) return height;
        height = top;
      }
      return height;
    },

    /** True when any collider's bounds (or a provider's collider) overlap the box: a cheap broad phase. */
    boundsOccupied(minX, minY, minZ, maxX, maxY, maxZ) {
      QUERY[0] = minX;
      QUERY[1] = minY;
      QUERY[2] = minZ;
      QUERY[3] = maxX;
      QUERY[4] = maxY;
      QUERY[5] = maxZ;
      return collect() > 0;
    },

    /**
     * Turns sweep timing on or off (getStats().ms; null while off). performance.now() boxes its
     * result, so the game leaves it off and the dev tests switch it on.
     */
    profile(enabled) {
      profiling = enabled === true;
      timing[0] = 0;
    },

    get count() {
      return records.size;
    },

    get providerCount() {
      return providers.length;
    },

    getStats() {
      return {
        colliders: records.size,
        providers: providers.length,
        perchProviders: perchProviders.length,
        cells: cells.size,
        huge: huge.length,
        sweeps: counters.sweeps,
        hits: counters.hits,
        ms: profiling ? Math.round(timing[0] * 1000) / 1000 : null,
      };
    },

    /** Every registered collider: [{ id, owner, type, tags, bounds: { min, max } }] (allocates). */
    list() {
      return [...records.values()].map((record) => ({
        id: record.id,
        owner: record.owner,
        type: record.type,
        tags: record.tags,
        bounds: {
          min: { x: record.bounds[0], y: record.bounds[1], z: record.bounds[2] },
          max: { x: record.bounds[3], y: record.bounds[4], z: record.bounds[5] },
        },
      }));
    },

    /** Removes every collider and provider (teardown). */
    dispose() {
      for (const id of [...records.keys()]) service.remove(id);
      providers.length = 0;
      perchProviders.length = 0;
      candidates.length = 0;
      candidateCount = 0;
    },
  };
  return service;
}
