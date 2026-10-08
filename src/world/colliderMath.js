// Narrow-phase geometry for the collider service (src/world/colliders.js) and the mesh colliders
// (src/world/colliderMesh.js): a sphere swept along a segment against points, segments, triangles,
// boxes, cylinders and convex hulls, and the deterministic convex hull builder. Pure JS in float64,
// no three.js.
//
// A sweep moves a sphere centre along p(t) = p + d t, t in [0, 1], with radius r (r = 0 is a ray).
// A sweep result { t, nx, ny, nz } holds the earliest hit found so far (t = Infinity for none): a
// function writes it only for an earlier t and returns true when it did. The normal points from the
// shape toward the sphere centre at contact, so the contact point on the shape is p(t) - n r. A
// sphere that already touches the shape at t = 0 reports t = 0 with the separating normal (a centre
// inside a solid reports the direction of its shallowest way out). Shapes are in their own local
// frame: the service moves segments in and normals out.
//
// Registers: numbers travel between these functions in the float64 arrays below, never as call
// arguments or return values, because a double passed to (or returned from) a call the JIT does not
// inline is boxed into a new heap number. The caller writes SWEEP (and the shape register a primitive
// reads), then calls the primitive with the result record; nothing allocates per query.

export const EPSILON = 1e-9;
/** Segments around the circumscribed rim of a cylinder (the rim of the swept volume, see sweepCylinder). */
const RIM_SEGMENTS = 24;
/** How far (as a share of R) the circumscribed rim reaches past the true rim: 1 / cos(pi / 24) - 1. */
export const RIM_OVERREACH = 1 / Math.cos(Math.PI / RIM_SEGMENTS) - 1;
const RIM_RADIUS_SCALE = 1 + RIM_OVERREACH;
const RIM_COS = Float64Array.from({ length: RIM_SEGMENTS + 1 }, (unused, index) => Math.cos((index / RIM_SEGMENTS) * Math.PI * 2));
const RIM_SIN = Float64Array.from({ length: RIM_SEGMENTS + 1 }, (unused, index) => Math.sin((index / RIM_SEGMENTS) * Math.PI * 2));
/** Hull builder: largest point count, and the plane tolerance relative to the point cloud's size. */
export const MAX_HULL_POINTS = 64;
const HULL_TOLERANCE = 1e-6;

/** The sweep: px, py, pz (start), dx, dy, dz (delta), r (radius), in the frame of the shape tested. */
export const SWEEP = new Float64Array(7);
/** sweepTriangleFace / sweepTriangle: the corners ax, ay, az, bx, by, bz, cx, cy, cz. */
export const TRIANGLE = new Float64Array(9);
/** sweepSegment: ax, ay, az, bx, by, bz and the capsule's total radius (sweep radius + its own). */
export const SEGMENT = new Float64Array(7);
/** sweepBox: half extents hx, hy, hz. sweepCylinder: radius, halfHeight. */
export const SHAPE = new Float64Array(3);
/** rotateRegister: the vector in, and its rotated value out. */
export const VECTOR = new Float64Array(3);
const POINT = new Float64Array(4);
const HIT = new Float64Array(4);
const BOX = new Float64Array(6);
/** edgeSide: the point on the plane (qx, qy, qz) and the plane normal (nx, ny, nz). */
const PLANE = new Float64Array(6);

/**
 * A sweep result. A class of its own keeps its fields' double representation private: a literal
 * would share its map with every same-shaped literal, and once such a map turns generic every double
 * written to it is boxed.
 */
class SweepResult {
  constructor() {
    this.t = Infinity;
    this.nx = 0.5;
    this.ny = 0.5;
    this.nz = 0.5;
  }
}

export function createSweepResult() {
  const result = new SweepResult();
  resetSweepResult(result);
  return result;
}

/** A { x, y, z } with a class of its own (see SweepResult): hit points, normals, collider velocities. */
export class ColliderVector {
  constructor(x = 0.5, y = 0.5, z = 0.5) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

/** Clears a result to "no hit" (set result.t afterwards to make it a limit: only earlier hits count). */
export function resetSweepResult(result) {
  result.t = Infinity;
  result.nx = 0;
  result.ny = 1;
  result.nz = 0;
}

/** Writes HIT into result when it is earlier than what result holds; returns whether it did. */
function commit(result) {
  if (!(HIT[0] < result.t)) return false;
  result.t = HIT[0];
  result.nx = HIT[1];
  result.ny = HIT[2];
  result.nz = HIT[3];
  return true;
}

/** commit with HIT's normal normalised first (straight up for a zero vector). */
function commitNormalized(result) {
  const length = Math.sqrt(HIT[1] * HIT[1] + HIT[2] * HIT[2] + HIT[3] * HIT[3]);
  if (length > EPSILON) {
    HIT[1] /= length;
    HIT[2] /= length;
    HIT[3] /= length;
  } else {
    HIT[1] = 0;
    HIT[2] = 1;
    HIT[3] = 0;
  }
  return commit(result);
}

/** A hit at t = 0 with the normal (nx, ny, nz) already in HIT[1..3]. */
function commitStart(result) {
  HIT[0] = 0;
  return commitNormalized(result);
}

// ---- Rotations -------------------------------------------------------------------------------------
/**
 * Rotates VECTOR by the unit quaternion q (a Float64Array: x, y, z, w) in place; with inverse true by
 * its conjugate (world to local).
 */
export function rotateRegister(q, inverse) {
  const qw = q[3];
  const sx = inverse ? -q[0] : q[0];
  const sy = inverse ? -q[1] : q[1];
  const sz = inverse ? -q[2] : q[2];
  const vx = VECTOR[0];
  const vy = VECTOR[1];
  const vz = VECTOR[2];
  // v' = v + 2 w (s x v) + 2 s x (s x v)
  const cx = sy * vz - sz * vy;
  const cy = sz * vx - sx * vz;
  const cz = sx * vy - sy * vx;
  VECTOR[0] = vx + 2 * (qw * cx + sy * cz - sz * cy);
  VECTOR[1] = vy + 2 * (qw * cy + sz * cx - sx * cz);
  VECTOR[2] = vz + 2 * (qw * cz + sx * cy - sy * cx);
}

// ---- Points and segments --------------------------------------------------------------------------
/** The sphere against the point POINT[0..2] (a sphere of radius POINT[3] around it). */
function sweepPoint(result) {
  const mx = SWEEP[0] - POINT[0];
  const my = SWEEP[1] - POINT[1];
  const mz = SWEEP[2] - POINT[2];
  const radius = POINT[3];
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c <= 0) {
    HIT[1] = mx;
    HIT[2] = my;
    HIT[3] = mz;
    return commitStart(result);
  }
  const dx = SWEEP[3];
  const dy = SWEEP[4];
  const dz = SWEEP[5];
  const a = dx * dx + dy * dy + dz * dz;
  if (a < EPSILON * EPSILON) return false;
  const b = mx * dx + my * dy + mz * dz;
  if (b >= 0) return false;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return false;
  const t = (-b - Math.sqrt(discriminant)) / a;
  if (t > 1 || !(t < result.t)) return false;
  HIT[0] = t;
  HIT[1] = mx + dx * t;
  HIT[2] = my + dy * t;
  HIT[3] = mz + dz * t;
  return commitNormalized(result);
}

/** sweepPoint against SEGMENT's end a (end 0) or b (end 1). */
function sweepSegmentEnd(end, result) {
  const offset = end * 3;
  POINT[0] = SEGMENT[offset];
  POINT[1] = SEGMENT[offset + 1];
  POINT[2] = SEGMENT[offset + 2];
  POINT[3] = SEGMENT[6];
  return sweepPoint(result);
}

/**
 * The sphere against the capsule SEGMENT (the segment a-b with total radius SEGMENT[6]: the sweep's
 * radius plus the capsule's own; 0 + r for an edge). Its end spheres are included.
 */
export function sweepSegment(result) {
  const radius = SEGMENT[6];
  const ax = SEGMENT[0];
  const ay = SEGMENT[1];
  const az = SEGMENT[2];
  const abx = SEGMENT[3] - ax;
  const aby = SEGMENT[4] - ay;
  const abz = SEGMENT[5] - az;
  const mx = SWEEP[0] - ax;
  const my = SWEEP[1] - ay;
  const mz = SWEEP[2] - az;
  const dd = abx * abx + aby * aby + abz * abz;
  if (dd < EPSILON * EPSILON) return sweepSegmentEnd(0, result);
  const md = mx * abx + my * aby + mz * abz;
  // Already touching: the closest point of the segment is within the radius.
  let share = md / dd;
  if (share < 0) share = 0;
  else if (share > 1) share = 1;
  const ox = mx - abx * share;
  const oy = my - aby * share;
  const oz = mz - abz * share;
  if (ox * ox + oy * oy + oz * oz <= radius * radius) {
    HIT[1] = ox;
    HIT[2] = oy;
    HIT[3] = oz;
    return commitStart(result);
  }
  const dx = SWEEP[3];
  const dy = SWEEP[4];
  const dz = SWEEP[5];
  const nn = dx * dx + dy * dy + dz * dz;
  if (nn < EPSILON * EPSILON) return false;
  const nd = dx * abx + dy * aby + dz * abz;
  const mn = mx * dx + my * dy + mz * dz;
  const mm = mx * mx + my * my + mz * mz;
  const a = dd * nn - nd * nd;
  const c = dd * (mm - radius * radius) - md * md;
  if (a > EPSILON * dd * nn && c > 0) {
    // Outside the infinite cylinder around the axis: its entry decides between the side and an end.
    const b = dd * mn - nd * md;
    const discriminant = b * b - a * c;
    if (discriminant < 0) return false;
    const t = (-b - Math.sqrt(discriminant)) / a;
    if (t < 0 || t > 1 || !(t < result.t)) return false;
    const axial = md + nd * t;
    if (axial >= 0 && axial <= dd) {
      const along = axial / dd;
      HIT[0] = t;
      HIT[1] = mx + dx * t - abx * along;
      HIT[2] = my + dy * t - aby * along;
      HIT[3] = mz + dz * t - abz * along;
      return commitNormalized(result);
    }
    return sweepSegmentEnd(axial < 0 ? 0 : 1, result);
  }
  if (c > 0) return false;
  // Inside the infinite cylinder (or moving along it) beyond one end: only that end's sphere is ahead.
  return sweepSegmentEnd(md < 0 ? 0 : 1, result);
}

/** sweepSegment along TRIANGLE's edge from corner `from` to corner `to` (0, 1 or 2). */
function sweepTriangleEdge(from, to, result) {
  const a = from * 3;
  const b = to * 3;
  SEGMENT[0] = TRIANGLE[a];
  SEGMENT[1] = TRIANGLE[a + 1];
  SEGMENT[2] = TRIANGLE[a + 2];
  SEGMENT[3] = TRIANGLE[b];
  SEGMENT[4] = TRIANGLE[b + 1];
  SEGMENT[5] = TRIANGLE[b + 2];
  SEGMENT[6] = SWEEP[6];
  return sweepSegment(result);
}

// ---- Faces ------------------------------------------------------------------------------------------
/** Which side of TRIANGLE's edge u-v (corners) PLANE's point lies on, seen along its normal: 1, -1 or 0. */
function edgeSide(u, v) {
  const qx = PLANE[0];
  const qy = PLANE[1];
  const qz = PLANE[2];
  const nx = PLANE[3];
  const ny = PLANE[4];
  const nz = PLANE[5];
  const ux = TRIANGLE[u * 3];
  const uy = TRIANGLE[u * 3 + 1];
  const uz = TRIANGLE[u * 3 + 2];
  const ex = TRIANGLE[v * 3] - ux;
  const ey = TRIANGLE[v * 3 + 1] - uy;
  const ez = TRIANGLE[v * 3 + 2] - uz;
  const wx = qx - ux;
  const wy = qy - uy;
  const wz = qz - uz;
  const side = (ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz;
  const tolerance = Math.sqrt(ex * ex + ey * ey + ez * ez) * 1e-7;
  return side > tolerance ? 1 : side < -tolerance ? -1 : 0;
}

/**
 * The sphere against TRIANGLE's face (the face region only: sweepTriangle adds the edges). Two-sided:
 * the normal faces the side the sphere starts on.
 */
export function sweepTriangleFace(result) {
  const ax = TRIANGLE[0];
  const ay = TRIANGLE[1];
  const az = TRIANGLE[2];
  const e1x = TRIANGLE[3] - ax;
  const e1y = TRIANGLE[4] - ay;
  const e1z = TRIANGLE[5] - az;
  const e2x = TRIANGLE[6] - ax;
  const e2y = TRIANGLE[7] - ay;
  const e2z = TRIANGLE[8] - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < EPSILON) return false;
  nx /= length;
  ny /= length;
  nz /= length;
  const px = SWEEP[0];
  const py = SWEEP[1];
  const pz = SWEEP[2];
  const radius = SWEEP[6];
  let distance = (px - ax) * nx + (py - ay) * ny + (pz - az) * nz;
  if (distance < 0) {
    distance = -distance;
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  let t = 0;
  if (distance > radius) {
    const approach = -(SWEEP[3] * nx + SWEEP[4] * ny + SWEEP[5] * nz);
    if (approach <= EPSILON) return false;
    t = (distance - radius) / approach;
    if (t > 1 || !(t < result.t)) return false;
  }
  // The point on the plane under the sphere centre at t (it is r from the plane then, or closer at t = 0).
  const offset = distance > radius ? radius : distance;
  PLANE[0] = px + SWEEP[3] * t - nx * offset;
  PLANE[1] = py + SWEEP[4] * t - ny * offset;
  PLANE[2] = pz + SWEEP[5] * t - nz * offset;
  PLANE[3] = nx;
  PLANE[4] = ny;
  PLANE[5] = nz;
  const first = edgeSide(0, 1);
  const second = edgeSide(1, 2);
  const third = edgeSide(2, 0);
  if ((first > 0 || second > 0 || third > 0) && (first < 0 || second < 0 || third < 0)) return false;
  HIT[0] = t;
  HIT[1] = nx;
  HIT[2] = ny;
  HIT[3] = nz;
  return commit(result);
}

/** The sphere against TRIANGLE: its face and its three edges. */
export function sweepTriangle(result) {
  let found = sweepTriangleFace(result);
  if (SWEEP[6] > 0) {
    if (sweepTriangleEdge(0, 1, result)) found = true;
    if (sweepTriangleEdge(1, 2, result)) found = true;
    if (sweepTriangleEdge(2, 0, result)) found = true;
  }
  return found;
}

// ---- Boxes ------------------------------------------------------------------------------------------
/** True when the sweep's segment touches the axis-aligned box BOX (minX, minY, minZ, maxX, maxY, maxZ). */
function sweepTouchesBox() {
  let enter = 0;
  let exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    const origin = SWEEP[axis];
    const delta = SWEEP[axis + 3];
    const low = BOX[axis];
    const high = BOX[axis + 3];
    if (Math.abs(delta) < EPSILON) {
      if (origin < low || origin > high) return false;
      continue;
    }
    let near = (low - origin) / delta;
    let far = (high - origin) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > enter) enter = near;
    if (far < exit) exit = far;
    if (enter > exit) return false;
  }
  return true;
}

/** One face of the box SHAPE (axis 0 x, 1 y, 2 z; sign +1 or -1). */
function sweepBoxFace(axis, sign, result) {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const radius = SWEEP[6];
  const distance = sign * SWEEP[axis] - SHAPE[axis];
  if (distance < 0) return false;
  let t = 0;
  if (distance > radius) {
    const approach = -sign * SWEEP[axis + 3];
    if (approach <= EPSILON) return false;
    t = (distance - radius) / approach;
    if (t > 1 || !(t < result.t)) return false;
  }
  if (Math.abs(SWEEP[u] + SWEEP[u + 3] * t) > SHAPE[u] || Math.abs(SWEEP[v] + SWEEP[v + 3] * t) > SHAPE[v]) return false;
  HIT[0] = t;
  HIT[1] = axis === 0 ? sign : 0;
  HIT[2] = axis === 1 ? sign : 0;
  HIT[3] = axis === 2 ? sign : 0;
  return commit(result);
}

/** The sphere against the box [-SHAPE, SHAPE] (half extents hx, hy, hz; local frame). */
export function sweepBox(result) {
  const px = SWEEP[0];
  const py = SWEEP[1];
  const pz = SWEEP[2];
  const radius = SWEEP[6];
  const hx = SHAPE[0];
  const hy = SHAPE[1];
  const hz = SHAPE[2];
  const insideX = hx - Math.abs(px);
  const insideY = hy - Math.abs(py);
  const insideZ = hz - Math.abs(pz);
  if (insideX >= 0 && insideY >= 0 && insideZ >= 0) {
    // The centre is inside: out through the nearest face.
    HIT[1] = insideX <= insideY && insideX <= insideZ ? (px < 0 ? -1 : 1) : 0;
    HIT[2] = HIT[1] === 0 && insideY <= insideZ ? (py < 0 ? -1 : 1) : 0;
    HIT[3] = HIT[1] === 0 && HIT[2] === 0 ? (pz < 0 ? -1 : 1) : 0;
    return commitStart(result);
  }
  BOX[0] = -hx - radius;
  BOX[1] = -hy - radius;
  BOX[2] = -hz - radius;
  BOX[3] = hx + radius;
  BOX[4] = hy + radius;
  BOX[5] = hz + radius;
  if (!sweepTouchesBox()) return false;
  let found = false;
  for (let axis = 0; axis < 3; axis++) {
    if (sweepBoxFace(axis, 1, result)) found = true;
    if (sweepBoxFace(axis, -1, result)) found = true;
  }
  if (radius > 0) {
    // The twelve edges (their end spheres are the corners).
    for (let axis = 0; axis < 3; axis++) {
      for (let first = -1; first <= 1; first += 2) {
        for (let second = -1; second <= 1; second += 2) {
          if (sweepBoxEdge(axis, first, second, result)) found = true;
        }
      }
    }
  }
  return found;
}

/** The edge of the box SHAPE along `axis`, at side `first` of the next axis and `second` of the last. */
function sweepBoxEdge(axis, first, second, result) {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  SEGMENT[axis] = -SHAPE[axis];
  SEGMENT[axis + 3] = SHAPE[axis];
  SEGMENT[u] = first * SHAPE[u];
  SEGMENT[u + 3] = first * SHAPE[u];
  SEGMENT[v] = second * SHAPE[v];
  SEGMENT[v + 3] = second * SHAPE[v];
  SEGMENT[6] = SWEEP[6];
  return sweepSegment(result);
}

/** Depth of the shallowest way out when the point VECTOR is inside the box SHAPE, else negative. */
export function boxDepth() {
  return Math.min(SHAPE[0] - Math.abs(VECTOR[0]), SHAPE[1] - Math.abs(VECTOR[1]), SHAPE[2] - Math.abs(VECTOR[2]));
}

// ---- Cylinders --------------------------------------------------------------------------------------
/**
 * The sphere against the solid cylinder of radius SHAPE[0] and half height SHAPE[1] about the local
 * +y axis. The swept volume's side and caps are exact; its rounded rims are the 24-sided
 * circumscribed capsule ring, which reaches at most RIM_OVERREACH (0.86 %) of R past the true rim:
 * conservative, so it never lets anything through.
 */
export function sweepCylinder(result) {
  const px = SWEEP[0];
  const py = SWEEP[1];
  const pz = SWEEP[2];
  const dx = SWEEP[3];
  const dy = SWEEP[4];
  const dz = SWEEP[5];
  const r = SWEEP[6];
  const radius = SHAPE[0];
  const halfHeight = SHAPE[1];
  const radial = Math.sqrt(px * px + pz * pz);
  if (radial <= radius && Math.abs(py) <= halfHeight) {
    const sideDepth = radius - radial;
    const capDepth = halfHeight - Math.abs(py);
    const throughCap = capDepth <= sideDepth || radial < EPSILON;
    HIT[1] = throughCap ? 0 : px / radial;
    HIT[2] = throughCap ? (py < 0 ? -1 : 1) : 0;
    HIT[3] = throughCap ? 0 : pz / radial;
    return commitStart(result);
  }
  // Already touching: the closest point of the solid within r.
  const scale = radial > radius ? radius / radial : 1;
  const ox = px - px * scale;
  const oy = py - (py > halfHeight ? halfHeight : py < -halfHeight ? -halfHeight : py);
  const oz = pz - pz * scale;
  if (ox * ox + oy * oy + oz * oz <= r * r) {
    HIT[1] = ox;
    HIT[2] = oy;
    HIT[3] = oz;
    return commitStart(result);
  }
  // The enclosing cylinder (R + r, H + r) rejects most segments and finds the region of first contact.
  const outerRadius = radius + r;
  const a = dx * dx + dz * dz;
  const c = px * px + pz * pz - outerRadius * outerRadius;
  let circleEnter;
  let circleExit;
  if (a < EPSILON * EPSILON) {
    if (c > 0) return false;
    circleEnter = -Infinity;
    circleExit = Infinity;
  } else {
    const b = px * dx + pz * dz;
    const discriminant = b * b - a * c;
    if (discriminant < 0) return false;
    const root = Math.sqrt(discriminant);
    circleEnter = (-b - root) / a;
    circleExit = (-b + root) / a;
  }
  const outer = halfHeight + r;
  let slabEnter = -Infinity;
  let slabExit = Infinity;
  if (Math.abs(dy) < EPSILON) {
    if (Math.abs(py) > outer) return false;
  } else {
    slabEnter = (-outer - py) / dy;
    slabExit = (outer - py) / dy;
    if (slabEnter > slabExit) {
      const swap = slabEnter;
      slabEnter = slabExit;
      slabExit = swap;
    }
  }
  const enter = circleEnter > slabEnter ? circleEnter : slabEnter;
  const exit = circleExit < slabExit ? circleExit : slabExit;
  if (enter > exit || enter > 1 || exit < 0 || !(enter < result.t)) return false;
  if (enter >= 0) {
    const entryX = px + dx * enter;
    const entryY = py + dy * enter;
    const entryZ = pz + dz * enter;
    if (slabEnter > circleEnter) {
      // Entered through a cap plane: a cap contact when it lands over the disc.
      if (entryX * entryX + entryZ * entryZ <= radius * radius) {
        HIT[0] = enter;
        HIT[1] = 0;
        HIT[2] = entryY > 0 ? 1 : -1;
        HIT[3] = 0;
        return commit(result);
      }
    } else if (Math.abs(entryY) <= halfHeight) {
      HIT[0] = enter;
      HIT[1] = entryX;
      HIT[2] = 0;
      HIT[3] = entryZ;
      return commitNormalized(result);
    }
  }
  // A corner of the enclosing cylinder (or a start inside it): the side, a cap or a rim, whichever
  // comes first.
  let found = false;
  if (circleEnter >= 0 && circleEnter <= 1 && Math.abs(py + dy * circleEnter) <= halfHeight) {
    HIT[0] = circleEnter;
    HIT[1] = px + dx * circleEnter;
    HIT[2] = 0;
    HIT[3] = pz + dz * circleEnter;
    if (commitNormalized(result)) found = true;
  }
  for (let sign = -1; sign <= 1; sign += 2) {
    const distance = sign * py - outer;
    const approach = -sign * dy;
    if (distance < 0 || approach <= EPSILON) continue;
    const t = distance / approach;
    if (t > 1) continue;
    const capX = px + dx * t;
    const capZ = pz + dz * t;
    if (capX * capX + capZ * capZ > radius * radius) continue;
    HIT[0] = t;
    HIT[1] = 0;
    HIT[2] = sign;
    HIT[3] = 0;
    if (commit(result)) found = true;
  }
  for (let sign = -1; sign <= 1; sign += 2) {
    for (let segment = 0; segment < RIM_SEGMENTS; segment++) {
      if (sweepRimSegment(segment, sign, result)) found = true;
    }
  }
  return found;
}

/** One side of the circumscribed polygon around the rim of the cylinder SHAPE (sign: top +1, bottom -1). */
function sweepRimSegment(segment, sign, result) {
  const rimRadius = SHAPE[0] * RIM_RADIUS_SCALE;
  const y = sign * SHAPE[1];
  SEGMENT[0] = RIM_COS[segment] * rimRadius;
  SEGMENT[1] = y;
  SEGMENT[2] = RIM_SIN[segment] * rimRadius;
  SEGMENT[3] = RIM_COS[segment + 1] * rimRadius;
  SEGMENT[4] = y;
  SEGMENT[5] = RIM_SIN[segment + 1] * rimRadius;
  SEGMENT[6] = SWEEP[6];
  return sweepSegment(result);
}

/** Depth of the shallowest way out when the point VECTOR is inside the cylinder SHAPE, else negative. */
export function cylinderDepth() {
  return Math.min(SHAPE[0] - Math.sqrt(VECTOR[0] * VECTOR[0] + VECTOR[2] * VECTOR[2]), SHAPE[1] - Math.abs(VECTOR[1]));
}

/** Distance from the point VECTOR to the segment SEGMENT[0..5]. */
export function segmentDistance() {
  const px = VECTOR[0];
  const py = VECTOR[1];
  const pz = VECTOR[2];
  const ax = SEGMENT[0];
  const ay = SEGMENT[1];
  const az = SEGMENT[2];
  const abx = SEGMENT[3] - ax;
  const aby = SEGMENT[4] - ay;
  const abz = SEGMENT[5] - az;
  const dd = abx * abx + aby * aby + abz * abz;
  let share = dd > EPSILON ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / dd : 0;
  if (share < 0) share = 0;
  else if (share > 1) share = 1;
  const ox = px - ax - abx * share;
  const oy = py - ay - aby * share;
  const oz = pz - az - abz * share;
  return Math.sqrt(ox * ox + oy * oy + oz * oz);
}

// ---- Convex hulls -----------------------------------------------------------------------------------
/**
 * A deterministic incremental convex hull of `count` points (xyz triples in `points`, at most 64),
 * built once when a hull collider is added. Points are taken in index order, so the same input always
 * gives the same faces. Returns { faces: Int32Array (3 per triangle, outward counter-clockwise),
 * planes: Float64Array (nx, ny, nz, d per face; n . x = d on the face), edges: Int32Array (pairs, each
 * edge once), radius (largest distance of a point from the origin) }. Throws on fewer than four
 * points or a flat (coplanar) set.
 */
export function buildConvexHull(points, count = points.length / 3) {
  if (!Number.isInteger(count) || count < 4) throw new Error('a hull needs at least 4 points');
  if (count > MAX_HULL_POINTS) throw new Error(`a hull takes at most ${MAX_HULL_POINTS} points`);
  const px = (index) => points[index * 3];
  const py = (index) => points[index * 3 + 1];
  const pz = (index) => points[index * 3 + 2];
  let size = 0;
  let radius = 0;
  for (let index = 0; index < count; index++) {
    radius = Math.max(radius, Math.hypot(px(index), py(index), pz(index)));
    for (let axis = 0; axis < 3; axis++) size = Math.max(size, Math.abs(points[index * 3 + axis] - points[axis]));
  }
  const tolerance = Math.max(size, 1e-3) * HULL_TOLERANCE;
  // The first tetrahedron: the lowest x, the farthest from it, the farthest from that line, and the
  // farthest from that plane (lowest index on ties).
  let first = 0;
  for (let index = 1; index < count; index++) if (px(index) < px(first)) first = index;
  let second = -1;
  let best = -1;
  for (let index = 0; index < count; index++) {
    const distance = Math.hypot(px(index) - px(first), py(index) - py(first), pz(index) - pz(first));
    if (distance > best + tolerance) {
      best = distance;
      second = index;
    }
  }
  if (best <= tolerance) throw new Error('hull points are all in one place');
  let third = -1;
  best = -1;
  const lineX = px(second) - px(first);
  const lineY = py(second) - py(first);
  const lineZ = pz(second) - pz(first);
  const lineLength = Math.hypot(lineX, lineY, lineZ);
  for (let index = 0; index < count; index++) {
    const wx = px(index) - px(first);
    const wy = py(index) - py(first);
    const wz = pz(index) - pz(first);
    const distance = Math.hypot(lineY * wz - lineZ * wy, lineZ * wx - lineX * wz, lineX * wy - lineY * wx) / lineLength;
    if (distance > best + tolerance) {
      best = distance;
      third = index;
    }
  }
  if (best <= tolerance) throw new Error('hull points are all on one line');
  const faces = [];
  const makeFace = (a, b, c) => {
    const e1x = px(b) - px(a);
    const e1y = py(b) - py(a);
    const e1z = pz(b) - pz(a);
    const e2x = px(c) - px(a);
    const e2y = py(c) - py(a);
    const e2z = pz(c) - pz(a);
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    return { a, b, c, nx, ny, nz, d: nx * px(a) + ny * py(a) + nz * pz(a), alive: true };
  };
  const distanceTo = (face, index) => face.nx * px(index) + face.ny * py(index) + face.nz * pz(index) - face.d;
  const planeFace = makeFace(first, second, third);
  let fourth = -1;
  best = -1;
  for (let index = 0; index < count; index++) {
    const distance = Math.abs(distanceTo(planeFace, index));
    if (distance > best + tolerance) {
      best = distance;
      fourth = index;
    }
  }
  if (best <= tolerance) throw new Error('hull points are coplanar');
  const seed = [first, second, third, fourth];
  const centreX = (px(first) + px(second) + px(third) + px(fourth)) / 4;
  const centreY = (py(first) + py(second) + py(third) + py(fourth)) / 4;
  const centreZ = (pz(first) + pz(second) + pz(third) + pz(fourth)) / 4;
  const addOutward = (a, b, c) => {
    let face = makeFace(a, b, c);
    if (face.nx * centreX + face.ny * centreY + face.nz * centreZ - face.d > 0) face = makeFace(a, c, b);
    faces.push(face);
  };
  addOutward(first, second, third);
  addOutward(first, second, fourth);
  addOutward(first, third, fourth);
  addOutward(second, third, fourth);
  for (let index = 0; index < count; index++) {
    if (seed.includes(index)) continue;
    const visible = faces.filter((face) => face.alive && distanceTo(face, index) > tolerance);
    if (visible.length === 0) continue;
    // Horizon: directed edges of visible faces whose reverse belongs to a face that stays.
    const visibleEdges = new Set();
    for (const face of visible) {
      visibleEdges.add(face.a * 1024 + face.b);
      visibleEdges.add(face.b * 1024 + face.c);
      visibleEdges.add(face.c * 1024 + face.a);
    }
    const horizon = [];
    for (const face of visible) {
      for (const [u, v] of [[face.a, face.b], [face.b, face.c], [face.c, face.a]]) {
        if (!visibleEdges.has(v * 1024 + u)) horizon.push([u, v]);
      }
    }
    for (const face of visible) face.alive = false;
    for (const [u, v] of horizon) faces.push(makeFace(u, v, index));
  }
  const alive = faces.filter((face) => face.alive);
  const faceArray = new Int32Array(alive.length * 3);
  const planeArray = new Float64Array(alive.length * 4);
  const edgeKeys = new Set();
  const edgeList = [];
  alive.forEach((face, faceIndex) => {
    faceArray.set([face.a, face.b, face.c], faceIndex * 3);
    planeArray.set([face.nx, face.ny, face.nz, face.d], faceIndex * 4);
    for (const [u, v] of [[face.a, face.b], [face.b, face.c], [face.c, face.a]]) {
      const key = Math.min(u, v) * 1024 + Math.max(u, v);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edgeList.push(Math.min(u, v), Math.max(u, v));
    }
  });
  return { faces: faceArray, planes: planeArray, edges: Int32Array.from(edgeList), radius };
}

/** True when the sweep's segment comes within `hull.radius + r` of the origin (the hull's frame). */
function sweepNearHull(hull) {
  const dx = SWEEP[3];
  const dy = SWEEP[4];
  const dz = SWEEP[5];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  let t = lengthSquared > EPSILON ? -(SWEEP[0] * dx + SWEEP[1] * dy + SWEEP[2] * dz) / lengthSquared : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = SWEEP[0] + dx * t;
  const cy = SWEEP[1] + dy * t;
  const cz = SWEEP[2] + dz * t;
  const reach = hull.radius + SWEEP[6];
  return cx * cx + cy * cy + cz * cz <= reach * reach;
}

/**
 * The sphere against a convex hull from buildConvexHull (local frame; `points` its vertices). A
 * centre inside reports t = 0 through the face it is nearest to.
 */
export function sweepHull(points, hull, result) {
  const planes = hull.planes;
  const faceCount = planes.length / 4;
  const px = SWEEP[0];
  const py = SWEEP[1];
  const pz = SWEEP[2];
  let deepest = -Infinity;
  let deepestFace = 0;
  for (let face = 0; face < faceCount; face++) {
    const distance = planes[face * 4] * px + planes[face * 4 + 1] * py + planes[face * 4 + 2] * pz - planes[face * 4 + 3];
    if (distance > deepest) {
      deepest = distance;
      deepestFace = face;
    }
  }
  if (deepest <= 0) {
    HIT[1] = planes[deepestFace * 4];
    HIT[2] = planes[deepestFace * 4 + 1];
    HIT[3] = planes[deepestFace * 4 + 2];
    return commitStart(result);
  }
  if (!sweepNearHull(hull)) return false;
  const faces = hull.faces;
  let found = false;
  for (let face = 0; face < faceCount; face++) {
    for (let corner = 0; corner < 3; corner++) {
      const point = faces[face * 3 + corner] * 3;
      TRIANGLE[corner * 3] = points[point];
      TRIANGLE[corner * 3 + 1] = points[point + 1];
      TRIANGLE[corner * 3 + 2] = points[point + 2];
    }
    if (sweepTriangleFace(result)) found = true;
  }
  if (SWEEP[6] > 0) {
    const edges = hull.edges;
    for (let edge = 0; edge < edges.length; edge += 2) {
      const a = edges[edge] * 3;
      const b = edges[edge + 1] * 3;
      for (let axis = 0; axis < 3; axis++) {
        SEGMENT[axis] = points[a + axis];
        SEGMENT[axis + 3] = points[b + axis];
      }
      SEGMENT[6] = SWEEP[6];
      if (sweepSegment(result)) found = true;
    }
  }
  return found;
}

/** Depth of the shallowest way out when the point VECTOR is inside the hull, else a negative number. */
export function hullDepth(hull) {
  const px = VECTOR[0];
  const py = VECTOR[1];
  const pz = VECTOR[2];
  const planes = hull.planes;
  let deepest = -Infinity;
  for (let face = 0; face < planes.length; face += 4) {
    deepest = Math.max(deepest, planes[face] * px + planes[face + 1] * py + planes[face + 2] * pz - planes[face + 3]);
  }
  return -deepest;
}
