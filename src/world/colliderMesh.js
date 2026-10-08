// Mesh colliders (contract b.6): a three-mesh-bvh MeshBVH over a geometry that no set of primitives
// can stand in for (the cave tunnel of preset 77: a rock mountain with a winding bore, where both the
// inside and the outside are solid surfaces). Main thread only. A preset uses a mesh collider only
// with the lead's agreement, recorded in its preset docs; every other structure fits primitives.
//
// The geometry stays in its own local frame; the collider holds the rigid world transform (rotation
// and translation, float64) and its inverse. A sweep moves the segment into the local frame, walks the
// BVH with shapecast (the box of the swept sphere against the nodes, then the sphere against each
// triangle's face and edges, colliderMath.js) and hands the normal back in the world frame. Triangles
// are two-sided, so the winding of the source geometry does not matter for sweeps, nor for depth()
// (inside or outside by ray parity, which needs a closed mesh). The BVH is built once when the
// collider is created (deterministic geometry from the site seed) and released by dispose().
import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import { SWEEP, TRIANGLE, VECTOR, createSweepResult, rotateRegister, sweepTriangle } from './colliderMath.js';

/** The rotation part of a world matrix must be orthonormal within this (a rigid transform). */
const RIGID_TOLERANCE = 1e-6;
/**
 * depth()'s parity rays: three fixed directions off every axis and diagonal (a ray grazing an edge or
 * a vertex can count a crossing twice or not at all; the majority of three settles it).
 */
const PARITY_DIRECTIONS = Object.freeze([
  new THREE.Vector3(0.5714, 0.6143, 0.5442).normalize(),
  new THREE.Vector3(-0.7311, 0.2087, 0.6495).normalize(),
  new THREE.Vector3(0.1362, -0.8891, -0.4369).normalize(),
]);
/** Two parity hits closer than this (m) along a ray are one crossing (a shared edge). */
const PARITY_MERGE = 1e-7;

/** The rotation of a column-major 4x4 matrix as a unit quaternion (x, y, z, w) into out. */
function quaternionFromMatrix(m, out) {
  const trace = m[0] + m[5] + m[10];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s;
    out[0] = (m[6] - m[9]) * s;
    out[1] = (m[8] - m[2]) * s;
    out[2] = (m[1] - m[4]) * s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[5] - m[10]);
    out[3] = (m[6] - m[9]) / s;
    out[0] = 0.25 * s;
    out[1] = (m[4] + m[1]) / s;
    out[2] = (m[8] + m[2]) / s;
  } else if (m[5] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[5] - m[0] - m[10]);
    out[3] = (m[8] - m[2]) / s;
    out[0] = (m[4] + m[1]) / s;
    out[1] = 0.25 * s;
    out[2] = (m[9] + m[6]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[10] - m[0] - m[5]);
    out[3] = (m[1] - m[4]) / s;
    out[0] = (m[8] + m[2]) / s;
    out[1] = (m[9] + m[6]) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

function assertRigid(m) {
  const columns = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  for (let first = 0; first < 3; first++) {
    const length = Math.hypot(...columns[first]);
    if (Math.abs(length - 1) > RIGID_TOLERANCE) throw new Error('[DRIFTWING] a mesh collider needs a rigid world matrix (no scale)');
    for (let second = first + 1; second < 3; second++) {
      const dot = columns[first][0] * columns[second][0] + columns[first][1] * columns[second][1] + columns[first][2] * columns[second][2];
      if (Math.abs(dot) > RIGID_TOLERANCE) throw new Error('[DRIFTWING] a mesh collider needs a rigid world matrix (no shear)');
    }
  }
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new Error('[DRIFTWING] a mesh collider needs an affine world matrix');
}

/**
 * Builds a mesh collider. geometry: a BufferGeometry in its local frame (indexed or not; the BVH may
 * add an index). worldMatrixElements: Float64Array(16), column-major (three.js order), rigid. options:
 * { maxLeafSize = 8 }. Returns { type: 'mesh', bvh, matrix, inverse, bounds: { min, max }, sweep,
 * depth, dispose }; pass it as the `mesh` field of a collider spec.
 */
export function createMeshCollider(geometry, worldMatrixElements, { maxLeafSize = 8 } = {}) {
  if (!geometry || !geometry.isBufferGeometry || !geometry.attributes.position) throw new Error('[DRIFTWING] a mesh collider needs a BufferGeometry with positions');
  if (!worldMatrixElements || worldMatrixElements.length !== 16 || !Array.prototype.every.call(worldMatrixElements, Number.isFinite)) {
    throw new Error('[DRIFTWING] a mesh collider needs a finite Float64Array(16) world matrix');
  }
  const matrix = Float64Array.from(worldMatrixElements);
  assertRigid(matrix);
  // three-mesh-bvh 0.9 calls the leaf size targetLeafSize (maxLeafSize is deprecated and warns).
  let bvh = new MeshBVH(geometry, { targetLeafSize: maxLeafSize });
  const rotation = quaternionFromMatrix(matrix, new Float64Array(4));
  const translation = new Float64Array([matrix[12], matrix[13], matrix[14]]);
  // The rigid inverse: R^T and -R^T t.
  const inverse = new Float64Array([
    matrix[0], matrix[4], matrix[8], 0,
    matrix[1], matrix[5], matrix[9], 0,
    matrix[2], matrix[6], matrix[10], 0,
    -(matrix[0] * matrix[12] + matrix[1] * matrix[13] + matrix[2] * matrix[14]),
    -(matrix[4] * matrix[12] + matrix[5] * matrix[13] + matrix[6] * matrix[14]),
    -(matrix[8] * matrix[12] + matrix[9] * matrix[13] + matrix[10] * matrix[14]),
    1,
  ]);

  // World bounds: the local bounding box's eight corners through the matrix.
  const localBox = new THREE.Box3();
  bvh.getBoundingBox(localBox);
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (let index = 0; index < 8; index++) {
    VECTOR[0] = index & 1 ? localBox.max.x : localBox.min.x;
    VECTOR[1] = index & 2 ? localBox.max.y : localBox.min.y;
    VECTOR[2] = index & 4 ? localBox.max.z : localBox.min.z;
    rotateRegister(rotation, false);
    for (const [axis, key] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
      const value = VECTOR[axis] + translation[axis];
      if (value < bounds.min[key]) bounds.min[key] = value;
      if (value > bounds.max[key]) bounds.max[key] = value;
    }
  }

  // Per-sweep state, read by the shapecast callbacks (made once). The local sweep sits in SWEEP for
  // the whole walk; each triangle goes through TRIANGLE.
  const sweepBox = new THREE.Box3();
  const localHit = createSweepResult();
  const sweepState = { found: false };
  const callbacks = {
    intersectsBounds: (box) => box.intersectsBox(sweepBox),
    intersectsTriangle: (triangle) => {
      TRIANGLE[0] = triangle.a.x;
      TRIANGLE[1] = triangle.a.y;
      TRIANGLE[2] = triangle.a.z;
      TRIANGLE[3] = triangle.b.x;
      TRIANGLE[4] = triangle.b.y;
      TRIANGLE[5] = triangle.b.z;
      TRIANGLE[6] = triangle.c.x;
      TRIANGLE[7] = triangle.c.y;
      TRIANGLE[8] = triangle.c.z;
      if (sweepTriangle(localHit)) sweepState.found = true;
      return false;
    },
  };

  // depth(): the distance to the closest point, inside or outside by the parity of ray crossings.
  const queryPoint = new THREE.Vector3();
  const closest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const ray = new THREE.Ray();

  /** VECTOR = the world point (x, y, z) in the local frame. */
  function pointToLocal(x, y, z) {
    VECTOR[0] = x - translation[0];
    VECTOR[1] = y - translation[1];
    VECTOR[2] = z - translation[2];
    rotateRegister(rotation, true);
  }

  /** Whether a ray from queryPoint along direction crosses the surface an odd number of times. */
  function oddCrossings(direction) {
    ray.origin.copy(queryPoint);
    ray.direction.copy(direction);
    const hits = bvh.raycast(ray, THREE.DoubleSide);
    hits.sort((first, second) => first.distance - second.distance);
    let crossings = 0;
    let last = -Infinity;
    for (const hit of hits) {
      if (hit.distance - last > PARITY_MERGE) crossings++;
      last = hit.distance;
    }
    return crossings % 2 === 1;
  }

  return {
    type: 'mesh',
    get bvh() {
      return bvh;
    },
    matrix,
    inverse,
    bounds,

    /**
     * The sphere `world` (a Float64Array: px, py, pz, dx, dy, dz, r in the world frame) against the
     * mesh: writes result (world normal) for a hit before result.t and returns true (the collider
     * service's narrow phase). three-mesh-bvh's shapecast makes a small callbacks object per walk.
     */
    sweep(world, result) {
      if (!bvh) return false;
      pointToLocal(world[0], world[1], world[2]);
      SWEEP[0] = VECTOR[0];
      SWEEP[1] = VECTOR[1];
      SWEEP[2] = VECTOR[2];
      VECTOR[0] = world[3];
      VECTOR[1] = world[4];
      VECTOR[2] = world[5];
      rotateRegister(rotation, true);
      SWEEP[3] = VECTOR[0];
      SWEEP[4] = VECTOR[1];
      SWEEP[5] = VECTOR[2];
      const radius = world[6];
      SWEEP[6] = radius;
      sweepBox.min.set(Math.min(SWEEP[0], SWEEP[0] + SWEEP[3]) - radius, Math.min(SWEEP[1], SWEEP[1] + SWEEP[4]) - radius, Math.min(SWEEP[2], SWEEP[2] + SWEEP[5]) - radius);
      sweepBox.max.set(Math.max(SWEEP[0], SWEEP[0] + SWEEP[3]) + radius, Math.max(SWEEP[1], SWEEP[1] + SWEEP[4]) + radius, Math.max(SWEEP[2], SWEEP[2] + SWEEP[5]) + radius);
      localHit.t = result.t;
      sweepState.found = false;
      bvh.shapecast(callbacks);
      if (!sweepState.found) return false;
      VECTOR[0] = localHit.nx;
      VECTOR[1] = localHit.ny;
      VECTOR[2] = localHit.nz;
      rotateRegister(rotation, false);
      result.t = localHit.t;
      result.nx = VECTOR[0];
      result.ny = VECTOR[1];
      result.nz = VECTOR[2];
      return true;
    },

    /**
     * How deep (m) the world point lies inside the closed mesh (positive), or minus its distance
     * outside: the distance to the closest point, inside when most of three parity rays cross the
     * surface an odd number of times. For checks and tests (three-mesh-bvh allocates its ray hits).
     */
    depth(x, y, z) {
      if (!bvh) return -Infinity;
      pointToLocal(x, y, z);
      queryPoint.set(VECTOR[0], VECTOR[1], VECTOR[2]);
      if (!bvh.closestPointToPoint(queryPoint, closest)) return -Infinity;
      if (closest.distance < 1e-9) return 0;
      let odd = 0;
      for (const direction of PARITY_DIRECTIONS) if (oddCrossings(direction)) odd++;
      return odd >= 2 ? closest.distance : -closest.distance;
    },

    /** Releases the BVH (the geometry stays the caller's to dispose). */
    dispose() {
      bvh = null;
    },
  };
}
