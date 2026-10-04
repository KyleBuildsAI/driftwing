// Terrain mesh checks shared by the terrain test (?test=terrain) and tools/lab/terrain.mjs.
//
// Pure (no DOM, no three.js): they read chunk mesh buffers exactly as chunkBuilder.js writes them
// (non-indexed, LOCAL coordinates; resolution^2 * 2 surface triangles, then resolution * 4 skirt quads
// of 6 vertices, side by side: north z = 0, west x = 0, south z = chunkSize, east x = chunkSize), so a
// build made on the main thread and a mesh the terrain worker filled are checked the same way.
//
//   seams      between two neighbouring chunks, at any pair of LODs: the vertices both edges share
//              must have the same height, and wherever one edge runs above the other (a T-junction
//              across an LOD boundary) the upper chunk's skirt must hang down past the lower edge,
//              so no gap can open. The skirts must also hang from the surface edge itself. Every LOD
//              pair applies on an edge a stamp touches; on untouched (Phase 1) edges, the pairs the
//              ring layout can make (seamPairApplies).
//   collision  the collision height (worldgen.groundHeight) against the rendered LOD0 mesh, sampled
//              through the chunk's own triangles.

import { VEGETATION_TYPE_COUNT } from '../world/vegetationSpecies.js';

/** Height tolerance for vertices that must coincide (float32 positions of equal heights). */
export const SHARED_TOLERANCE = 1e-3;

/** The chunk builder's configuration, derived from CONFIG exactly as src/world/terrain.js does. */
export function terrainBuilderConfig(config) {
  const resolutions = Array.from(config.LOD_RESOLUTIONS);
  return {
    chunkSize: config.CHUNK_SIZE,
    lodResolutions: resolutions,
    skirtDepths: resolutions.map((resolution, lod) => config.SKIRT_DEPTH * Math.pow(1.5, lod)),
    maxInstances: 640,
    headerFloats: VEGETATION_TYPE_COUNT * 6,
    vegetationTypes: VEGETATION_TYPE_COUNT,
  };
}

/** Runs a chunk-builder generator to the end. */
export function drainSteps(steps) {
  let progress = steps.next();
  while (!progress.done) progress = steps.next();
}

/**
 * Builds one chunk mesh with a chunk builder: { cx, cz, lod, resolution, positions, colors, overlays
 * (the region-overlay attribute, 4 floats per vertex), vertexCount, minY, maxY }.
 */
export function buildChunkMesh(builder, config, cx, cz, lod) {
  const floats = builder.vertexCount(lod) * 3;
  const output = {
    positions: new Float32Array(floats), normals: new Float32Array(floats), colors: new Float32Array(floats), overlays: new Float32Array((floats / 3) * 4),
    minY: 0, maxY: 0, vertexCount: 0,
  };
  drainSteps(builder.buildMesh({ cx, cz, lod }, output));
  return { cx, cz, lod, resolution: config.lodResolutions[lod], positions: output.positions, colors: output.colors, overlays: output.overlays, vertexCount: output.vertexCount, minY: output.minY, maxY: output.maxY };
}

/**
 * The four edges of a chunk mesh. Per side (0 north, 1 west, 2 south, 3 east): `surface`, the
 * surface edge as a Map from the coordinate along the edge to its height, and `skirts`, one
 * { a, b, topA, topB, lowA, lowB } per skirt quad (a < b along the edge).
 */
export function extractEdges(mesh, chunkSize) {
  const { positions, resolution } = mesh;
  const sides = [0, 1, 2, 3].map(() => ({ surface: new Map(), skirts: [] }));
  const surfaceVertices = resolution * resolution * 6;
  for (let vertex = 0; vertex < surfaceVertices; vertex++) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    if (z === 0) sides[0].surface.set(x, y);
    if (x === 0) sides[1].surface.set(z, y);
    if (z === chunkSize) sides[2].surface.set(x, y);
    if (x === chunkSize) sides[3].surface.set(z, y);
  }
  for (let quad = 0; quad < resolution * 4; quad++) {
    const side = Math.floor(quad / resolution);
    const alongX = side === 0 || side === 2;
    const ends = new Map();
    for (let corner = 0; corner < 6; corner++) {
      const vertex = surfaceVertices + quad * 6 + corner;
      const along = positions[vertex * 3 + (alongX ? 0 : 2)];
      const y = positions[vertex * 3 + 1];
      const end = ends.get(along) ?? { top: -Infinity, low: Infinity };
      end.top = Math.max(end.top, y);
      end.low = Math.min(end.low, y);
      ends.set(along, end);
    }
    const [a, b] = [...ends.keys()].sort((first, second) => first - second);
    sides[side].skirts.push({ a, b, topA: ends.get(a).top, topB: ends.get(b).top, lowA: ends.get(a).low, lowB: ends.get(b).low });
  }
  for (const side of sides) side.skirts.sort((first, second) => first.a - second.a);
  return sides;
}

/** Height of a polyline (Map along -> height, sorted keys) at `along`, linear between vertices. */
function polylineAt(keys, heights, along) {
  let low = 0;
  let high = keys.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (keys[middle] <= along) low = middle;
    else high = middle;
  }
  const start = keys[low];
  const end = keys[high];
  if (along <= start) return heights.get(start);
  if (along >= end) return heights.get(end);
  const share = (along - start) / (end - start);
  return heights.get(start) + (heights.get(end) - heights.get(start)) * share;
}

/** The bottom of a side's skirt at `along` (linear along the quad that holds it). */
function skirtBottomAt(skirts, along) {
  for (const skirt of skirts) {
    if (along < skirt.a || along > skirt.b) continue;
    return skirt.lowA + (skirt.lowB - skirt.lowA) * ((along - skirt.a) / (skirt.b - skirt.a));
  }
  return Infinity;
}

/** Skirts must hang from the surface edge: each quad's top corners are the surface edge heights. */
export function checkSkirtAttachment(edges) {
  let worst = 0;
  for (const side of edges) {
    for (const skirt of side.skirts) {
      const topA = side.surface.get(skirt.a);
      const topB = side.surface.get(skirt.b);
      const error = Math.max(topA === undefined ? Infinity : Math.abs(topA - skirt.topA), topB === undefined ? Infinity : Math.abs(topB - skirt.topB));
      if (error > worst) worst = error;
    }
  }
  return worst;
}

/**
 * Checks the seam between chunk `first` and its neighbour `second`, from their extractEdges results.
 * direction: 'east' (second is first's east neighbour) or 'south'.
 * Returns { sharedPoints, maxSharedDiff, gapPoints, maxGap, worstCoverage, violations }: worstCoverage is
 * the smallest margin (m) by which the upper chunk's skirt reaches below the lower edge where the edges
 * part (negative = a visible crack); violations counts shared-vertex mismatches plus uncovered gaps.
 */
export function checkSeam(firstEdges, secondEdges, direction) {
  const firstSide = direction === 'east' ? firstEdges[3] : firstEdges[2];
  const secondSide = direction === 'east' ? secondEdges[1] : secondEdges[0];
  const firstKeys = [...firstSide.surface.keys()].sort((a, b) => a - b);
  const secondKeys = [...secondSide.surface.keys()].sort((a, b) => a - b);
  const union = [...new Set([...firstKeys, ...secondKeys])].sort((a, b) => a - b);
  let sharedPoints = 0;
  let maxSharedDiff = 0;
  let gapPoints = 0;
  let maxGap = 0;
  let worstCoverage = Infinity;
  let violations = 0;
  for (const along of union) {
    const firstHeight = polylineAt(firstKeys, firstSide.surface, along);
    const secondHeight = polylineAt(secondKeys, secondSide.surface, along);
    if (firstSide.surface.has(along) && secondSide.surface.has(along)) {
      sharedPoints++;
      const diff = Math.abs(firstHeight - secondHeight);
      if (diff > maxSharedDiff) maxSharedDiff = diff;
      if (diff > SHARED_TOLERANCE) violations++;
      continue;
    }
    const gap = firstHeight - secondHeight;
    if (Math.abs(gap) <= SHARED_TOLERANCE) continue;
    gapPoints++;
    if (Math.abs(gap) > maxGap) maxGap = Math.abs(gap);
    // The upper edge's skirt must reach the lower edge.
    const coverage = gap > 0
      ? secondHeight - skirtBottomAt(firstSide.skirts, along)
      : firstHeight - skirtBottomAt(secondSide.skirts, along);
    if (coverage < worstCoverage) worstCoverage = coverage;
    if (coverage < -SHARED_TOLERANCE) violations++;
  }
  return { sharedPoints, maxSharedDiff, gapPoints, maxGap, worstCoverage: Number.isFinite(worstCoverage) ? worstCoverage : null, violations };
}

/**
 * Height of a LOD mesh at LOCAL (x, z) inside it, from the triangle of its vertex grid that holds
 * the point (barycentric interpolation of the buffer's own vertices).
 */
export function meshHeightAt(mesh, chunkSize, localX, localZ) {
  const { positions, resolution } = mesh;
  const step = chunkSize / resolution;
  const i = Math.min(resolution - 1, Math.max(0, Math.floor(localX / step)));
  const j = Math.min(resolution - 1, Math.max(0, Math.floor(localZ / step)));
  const quadVertex = (j * resolution + i) * 6;
  for (let triangle = 0; triangle < 2; triangle++) {
    const base = (quadVertex + triangle * 3) * 3;
    const ax = positions[base];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cz = positions[base + 8];
    const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const weightA = ((bz - cz) * (localX - cx) + (cx - bx) * (localZ - cz)) / determinant;
    const weightB = ((cz - az) * (localX - cx) + (ax - cx) * (localZ - cz)) / determinant;
    const weightC = 1 - weightA - weightB;
    if (weightA >= -1e-9 && weightB >= -1e-9 && weightC >= -1e-9) {
      return weightA * positions[base + 1] + weightB * positions[base + 4] + weightC * positions[base + 7];
    }
  }
  return NaN;
}

/**
 * Whether the seam check applies to this LOD pair. On an edge a stamp touches every pair is checked
 * (the stamp-aware skirts must close any of them). An edge no stamp touches is Phase 1 ground with the
 * fixed Phase 1 skirts, which are sized for the pairs the ring layout makes: neighbouring chunks' rings
 * differ by at most one, so their LODs differ by at most one.
 */
export function seamPairApplies(world, chunkSize, cx, cz, direction, lod, neighbourLod) {
  if (Math.abs(lod - neighbourLod) <= 1) return true;
  const minX = direction === 'east' ? (cx + 1) * chunkSize : cx * chunkSize;
  const maxX = (cx + 1) * chunkSize;
  const minZ = direction === 'south' ? (cz + 1) * chunkSize : cz * chunkSize;
  const maxZ = (cz + 1) * chunkSize;
  return world.stampsOverlap(minX, minZ, maxX, maxZ);
}

/** Largest absolute difference between two meshes' position and colour buffers (Infinity if their sizes differ). */
export function compareMeshBuffers(first, second) {
  if (first.positions.length !== second.positions.length || first.colors.length !== second.colors.length) return Infinity;
  let worst = 0;
  for (let index = 0; index < first.positions.length; index++) {
    const diff = Math.abs(first.positions[index] - second.positions[index]);
    if (diff > worst) worst = diff;
  }
  for (let index = 0; index < first.colors.length; index++) {
    const diff = Math.abs(first.colors[index] - second.colors[index]);
    if (diff > worst) worst = diff;
  }
  // The region-overlay attribute, when both carry it.
  if (first.overlays && second.overlays) {
    if (first.overlays.length !== second.overlays.length) return Infinity;
    for (let index = 0; index < first.overlays.length; index++) {
      const diff = Math.abs(first.overlays[index] - second.overlays[index]);
      if (diff > worst) worst = diff;
    }
  }
  return worst;
}
