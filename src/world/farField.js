import { createMapTileService } from './mapTiles.js';
import { curvatureDropNode } from '../render/curvature.js';
import { MAX_VIEW_DISTANCE } from '../env/atmosphere.js';

/**
 * FAR FIELD (contract g.4, system 'farField', updated right after 'terrain'): the planet beyond the
 * terrain chunks, seen from high altitude.
 *
 * - Tiles: a quadtree of square tiles on a power-of-two world grid, 1 km (level 0) to 256 km (level 8,
 *   the roots), split while the camera is closer than SPLIT_FACTOR tile sizes (about 45 tiles a level,
 *   each quad some 14 px across on screen), out to the horizon. Each
 *   tile is a 32 x 32 quad grid in tile-local coordinates at its world centre, from the Phase 2
 *   map-tile worker (createMapTileService, fields surface and albedo, its own IndexedDB cache), with
 *   skirts, flat shading, vertex curvature (render/curvature.js) and a sun glint on water (lakes come
 *   through world.waterBodyAt in the tile fields). Tiles of 16 km and finer sample the stamped world;
 *   coarser ones the bare world (stamps are sub-sample details there, and each one costs a placement
 *   pass in the worker).
 * - No holes: a node is replaced by its four children only once all four are ready, and every tile
 *   drawn keeps its ancestors cached, so the coverage only ever refines. The roots (a few 256 km tiles)
 *   load first, from 4.5 km camera altitude, before the far field draws at 6 km. The children being
 *   gathered for a split are kept with the tiles in use (never evicted before their siblings arrive),
 *   and refinement stops short of the mesh budget, so the cache never thrashes. After RELEASE_SECONDS
 *   below the prefetch altitude every tile mesh is disposed (CPU arrays and GPU buffers); the next climb
 *   rebuilds them from the worker's IndexedDB cache.
 * - Handoff with the terrain: from 6 km the far field fills the annulus beyond the terrain's coverage.
 *   In the overlap band both draw: the far-field ground sits FAR_SINK (0.2 %) of the distance lower and
 *   the two cross-fade with complementary screen-door dithers (handoffPresenceNode: the far field keeps
 *   a pixel where the dither is below the presence, the terrain where it is not), so every pixel shows
 *   exactly one of them. From 11 to 13 km the band closes in to the nadir and the terrain stops drawing
 *   (terrain.setFarFieldHandoff).
 * - Clouds from above: a cloud-layer shell at cloud height out to the horizon, from the cumulus field's
 *   own deterministic coverage (clouds.getCoverageProbability) and the regional weather (storm cells
 *   read dark and dense), refreshed time-sliced into a small texture around the camera. It opens a hole
 *   where the v1 cloud field draws its real clusters (within ~4 km).
 * - Every shader term is camera-relative (positionWorld - cameraPosition), so it holds in the floating
 *   origin's render frame; tile meshes sit at world tile centres like any scene child.
 *
 * Allocation: the frame path (selection, culling, the coverage slice) is allocation-free; a tile's
 * request and its arrival allocate (a promise and the transferred arrays), a few times a second at most.
 */

const TILE_QUADS = 32;
const TILE_VERTICES = TILE_QUADS + 1;
const GRID_VERTICES = TILE_VERTICES * TILE_VERTICES;
const SKIRT_VERTICES = TILE_VERTICES * 4;
const TILE_VERTEX_COUNT = GRID_VERTICES + SKIRT_VERTICES;
const BASE_TILE_SIZE = 1024;
const ROOT_LEVEL = 8;
const SPLIT_FACTOR = 2.2;
/** Tiles at or below this level (16 km) sample the stamped world; coarser ones the bare world. */
const STAMPED_MAX_LEVEL = 4;
/** Requests waiting in the worker queue at most (the rest are asked for as these finish). */
const MAX_PENDING = 40;
/** Tile meshes kept at most (drawn, ancestors of drawn, and recently used). */
const MAX_TILE_MESHES = 720;
/** Refinement asks for no new children once the tiles in use come this close to MAX_TILE_MESHES. */
const MESH_HEADROOM = 64;
/** Selection stack and selection list capacities. */
const STACK_CAPACITY = 4096;
const MAX_SELECTED = 900;
/** The far-field ground sits this share of the horizontal distance below the true ground. */
const FAR_SINK = 0.002;
/** Skirt depth: this share of the tile size plus a floor (m). */
const SKIRT_SHARE = 0.025;
const SKIRT_FLOOR = 40;
/** The roots are requested from this camera altitude (m), ahead of the 6 km far-field band. */
const PREFETCH_ALTITUDE = 4500;
/** Below PREFETCH_ALTITUDE this long (s), the tiles give their memory back (a climb rebuilds them). */
const RELEASE_SECONDS = 20;
/** Reselect at least this often (s), or when the camera moved this share of its altitude. */
const SELECT_INTERVAL = 0.25;
const SELECT_MOVE_SHARE = 0.02;
/** Pending requests are re-prioritised (and stale ones dropped) at this interval (s). */
const REPRIORITIZE_INTERVAL = 0.6;
/** The handoff band, as shares of the terrain's coverage radius (inner edge, width). */
const HANDOFF_INNER_SHARE = 0.8;
const HANDOFF_FADE_SHARE = 0.3;
const HANDOFF_MIN_FADE = 1;

// Cloud shell.
const SHELL_RINGS = 40;
const SHELL_SEGMENTS = 96;
const SHELL_INNER_RADIUS = 2500;
const SHELL_HEIGHT = 1500;
/** The v1 cloud field's edge fade (clouds.js EDGE_FADE_START .. VIEW_RANGE): the shell fades in over it. */
const SHELL_HOLE_START = 3400;
const SHELL_HOLE_END = 4600;
const COVERAGE_SIZE = 96;
const COVERAGE_TEXELS_PER_FRAME = 384;
const SHELL_START_ALTITUDE = 5000;
const SHELL_FULL_ALTITUDE = 7000;

/** Interleaved gradient noise (0..1) on the pixel grid, offset so it is independent of the LOD fade's. */
export function handoffDitherNode(TSL) {
  const { floor, fract, dot, vec2, screenCoordinate } = TSL;
  const pixel = floor(screenCoordinate.xy).add(vec2(37, 17));
  return fract(fract(dot(pixel, vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

/**
 * The far field's share (0..1) of a fragment at horizontal render distance `distanceNode` from the
 * camera: 0 inside innerRadius - fade, 1 beyond innerRadius, times the far field's weight. The far
 * field keeps a pixel where handoffDitherNode < presence, the terrain where it is not.
 */
export function handoffPresenceNode(TSL, { innerRadius, fade, weight }, distanceNode) {
  const { clamp } = TSL;
  return clamp(distanceNode.sub(innerRadius.sub(fade)).div(fade), 0, 1).mul(weight);
}

/** The horizontal render distance (a float node) from the camera to a render-frame world position node. */
function horizontalDistanceNode(TSL, worldPosition) {
  const { cameraPosition } = TSL;
  const offsetX = worldPosition.x.sub(cameraPosition.x);
  const offsetZ = worldPosition.z.sub(cameraPosition.z);
  return offsetX.mul(offsetX).add(offsetZ.mul(offsetZ)).sqrt();
}

export function createFarFieldSystem(ctx) {
  const { THREE, TSL, scene, camera, state, uniforms, world, settings } = ctx;
  const {
    Fn, vec3, vec4, uniform, attribute, mix, smoothstep, max, texture, positionLocal, positionWorld,
    modelWorldMatrix, cameraPosition, mx_noise_float,
  } = TSL;
  const terrain = ctx.systems.terrain;
  if (!terrain || typeof terrain.setFarFieldHandoff !== 'function' || typeof terrain.getCoverageRadius !== 'function' || !terrain.handoffUniforms) {
    throw new Error('the far field needs the terrain system (setFarFieldHandoff, getCoverageRadius, handoffUniforms)');
  }
  const tiles = createMapTileService({ seed: state.seed, worldOptions: ctx.worldOptions });
  const waterLevel = world.WATER_LEVEL;
  // The handoff band's uniforms belong to the terrain (its high-altitude materials read them too):
  // { innerRadius, fade, weight }, written through terrain.setFarFieldHandoff.
  const handoff = terrain.handoffUniforms;

  // ==========================================================================================
  // TILE MATERIAL
  // ==========================================================================================
  const tileWorld = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const tileDistance = horizontalDistanceNode(TSL, tileWorld);
  const tileMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  tileMaterial.name = 'far-field';
  tileMaterial.positionNode = Fn(() => {
    const drop = curvatureDropNode(ctx, tileWorld).add(tileDistance.mul(FAR_SINK));
    return vec3(positionLocal.x, positionLocal.y.sub(drop), positionLocal.z);
  })();
  tileMaterial.colorNode = vec4(attribute('color', 'vec3'), 1);
  // Water is glossy (the sun's glint from altitude), land matte like the terrain.
  tileMaterial.roughnessNode = mix(0.95, 0.2, attribute('farWater', 'float'));
  const fragmentDistance = horizontalDistanceNode(TSL, positionWorld);
  tileMaterial.maskNode = handoffDitherNode(TSL).lessThan(handoffPresenceNode(TSL, handoff, fragmentDistance));

  // ==========================================================================================
  // TILE GEOMETRY (pooled meshes, one shared index buffer)
  // ==========================================================================================
  const group = new THREE.Group();
  group.name = 'far-field';
  group.visible = false;
  scene.add(group);

  function buildIndex() {
    const indices = [];
    const vertex = (row, column) => row * TILE_VERTICES + column;
    for (let row = 0; row < TILE_QUADS; row++) {
      for (let column = 0; column < TILE_QUADS; column++) {
        const a = vertex(row, column);
        const b = vertex(row + 1, column);
        const c = vertex(row, column + 1);
        const d = vertex(row + 1, column + 1);
        indices.push(a, b, c, c, b, d);
      }
    }
    // Skirts: each edge's vertices, then its lowered copies (GRID_VERTICES + edge * TILE_VERTICES + i).
    const edges = [
      (i) => vertex(0, i),
      (i) => vertex(TILE_QUADS, i),
      (i) => vertex(i, 0),
      (i) => vertex(i, TILE_QUADS),
    ];
    edges.forEach((edgeVertex, edge) => {
      for (let index = 0; index < TILE_QUADS; index++) {
        const top0 = edgeVertex(index);
        const top1 = edgeVertex(index + 1);
        const low0 = GRID_VERTICES + edge * TILE_VERTICES + index;
        const low1 = low0 + 1;
        indices.push(top0, low0, top1, top1, low0, low1);
      }
    });
    return new THREE.BufferAttribute(new Uint16Array(indices), 1);
  }
  const sharedIndex = buildIndex();
  const SRGB_TO_LINEAR = new Float32Array(256);
  for (let index = 0; index < 256; index++) {
    const value = index / 255;
    SRGB_TO_LINEAR[index] = value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  const meshPool = [];
  let meshesCreated = 0;
  // Whether a mesh went to a tile since the last release: the prewarm stand-in alone is no reason to
  // release (disposing it would free a geometry 20 s after boot, in the middle of whatever is running).
  let tilesBuilt = false;
  function createTileMesh() {
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(sharedIndex);
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TILE_VERTEX_COUNT * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TILE_VERTEX_COUNT * 3), 3));
    geometry.setAttribute('farWater', new THREE.BufferAttribute(new Float32Array(TILE_VERTEX_COUNT), 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    const mesh = new THREE.Mesh(geometry, tileMaterial);
    mesh.name = 'far-field-tile';
    mesh.matrixAutoUpdate = false;
    // Culled by the far field itself against the curved ground (the GPU bounds do not know the drop).
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    group.add(mesh);
    meshesCreated++;
    return mesh;
  }

  /** Fills a pooled mesh from a tile's surface heights and albedo. */
  function fillTileMesh(mesh, record, surface, albedo) {
    const geometry = mesh.geometry;
    const positions = geometry.attributes.position.array;
    const colors = geometry.attributes.color.array;
    const water = geometry.attributes.farWater.array;
    const size = record.size;
    const spacing = size / TILE_QUADS;
    const half = size / 2;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let row = 0; row < TILE_VERTICES; row++) {
      for (let column = 0; column < TILE_VERTICES; column++) {
        const index = row * TILE_VERTICES + column;
        const height = Number.isFinite(surface[index]) ? surface[index] : waterLevel;
        positions[index * 3] = column * spacing - half;
        positions[index * 3 + 1] = height;
        positions[index * 3 + 2] = row * spacing - half;
        colors[index * 3] = SRGB_TO_LINEAR[albedo[index * 4]];
        colors[index * 3 + 1] = SRGB_TO_LINEAR[albedo[index * 4 + 1]];
        colors[index * 3 + 2] = SRGB_TO_LINEAR[albedo[index * 4 + 2]];
        water[index] = albedo[index * 4 + 3] === 0 ? 1 : 0;
        if (height < minY) minY = height;
        if (height > maxY) maxY = height;
      }
    }
    const skirt = size * SKIRT_SHARE + SKIRT_FLOOR;
    for (let edge = 0; edge < 4; edge++) {
      for (let index = 0; index < TILE_VERTICES; index++) {
        const source = edge === 0 ? index : edge === 1 ? TILE_QUADS * TILE_VERTICES + index : edge === 2 ? index * TILE_VERTICES : index * TILE_VERTICES + TILE_QUADS;
        const target = GRID_VERTICES + edge * TILE_VERTICES + index;
        positions[target * 3] = positions[source * 3];
        positions[target * 3 + 1] = positions[source * 3 + 1] - skirt;
        positions[target * 3 + 2] = positions[source * 3 + 2];
        colors[target * 3] = colors[source * 3];
        colors[target * 3 + 1] = colors[source * 3 + 1];
        colors[target * 3 + 2] = colors[source * 3 + 2];
        water[target] = water[source];
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.farWater.needsUpdate = true;
    geometry.boundingSphere.center.set(0, (minY + maxY) / 2, 0);
    geometry.boundingSphere.radius = Math.sqrt(half * half * 2 + ((maxY - minY + skirt) / 2) ** 2);
    record.minY = minY;
    record.maxY = maxY;
    mesh.position.set(record.x0 + half, 0, record.z0 + half);
    mesh.updateMatrix();
  }

  // ==========================================================================================
  // TILE RECORDS
  // ==========================================================================================
  const STATE_PENDING = 1;
  const STATE_READY = 2;
  const records = new Map();
  let pendingCount = 0;
  let readySinceSelect = false;
  let serviceFailed = false;
  const counters = { requested: 0, arrived: 0, dropped: 0, evicted: 0, failed: 0, released: 0 };

  function tileKey(level, tileX, tileZ) {
    return (level * 1048576 + (tileX + 524288)) * 1048576 + (tileZ + 524288);
  }
  function levelSize(level) {
    return BASE_TILE_SIZE * 2 ** level;
  }

  function recordFor(level, tileX, tileZ) {
    return records.get(tileKey(level, tileX, tileZ));
  }

  function isReady(level, tileX, tileZ) {
    const record = records.get(tileKey(level, tileX, tileZ));
    return record !== undefined && record.state === STATE_READY;
  }

  /** Asks the worker for a tile (no-op when it is pending or ready, or the queue is full). */
  function requestTile(level, tileX, tileZ, priority) {
    const key = tileKey(level, tileX, tileZ);
    let record = records.get(key);
    if (serviceFailed || (record !== undefined && record.state !== 0)) return;
    if (pendingCount >= MAX_PENDING && level !== ROOT_LEVEL) return;
    const size = levelSize(level);
    if (record === undefined) {
      record = { key, level, tileX, tileZ, size, x0: tileX * size, z0: tileZ * size, state: 0, mesh: null, lastUsed: 0, minY: 0, maxY: 0, request: 0 };
      records.set(key, record);
    }
    record.state = STATE_PENDING;
    record.request++;
    const requestNumber = record.request;
    pendingCount++;
    counters.requested++;
    const spacing = size / TILE_QUADS;
    tiles.request({
      x: record.x0 - spacing / 2,
      z: record.z0 - spacing / 2,
      size: size + spacing,
      resolution: TILE_VERTICES,
      fields: ['surface', 'albedo'],
      stamps: level <= STAMPED_MAX_LEVEL,
    }, { priority }).then((tile) => {
      if (disposed || records.get(key) !== record || record.request !== requestNumber) return;
      pendingCount--;
      if (!tile) {
        // Dropped (stale): asked again when needed. A failed worker (the service logs it once) stops
        // the asking; the far field then draws what it has.
        record.state = 0;
        counters.dropped++;
        if (tiles.stats().failed) serviceFailed = true;
        return;
      }
      record.mesh = acquireMesh();
      fillTileMesh(record.mesh, record, tile.surface, tile.albedo);
      record.state = STATE_READY;
      counters.arrived++;
      readySinceSelect = true;
    }, (error) => {
      console.error('[DRIFTWING] a far-field tile failed to build', error);
      if (records.get(key) === record) {
        pendingCount--;
        record.state = 0;
        counters.failed++;
      }
    });
  }

  function acquireMesh() {
    tilesBuilt = true;
    if (meshPool.length > 0) return meshPool.pop();
    if (meshesCreated >= MAX_TILE_MESHES) evictTiles(1);
    return meshPool.length > 0 ? meshPool.pop() : createTileMesh();
  }

  /** Frees the meshes of the least recently used ready tiles not drawn this frame. */
  function evictTiles(wanted) {
    let freed = 0;
    while (freed < wanted) {
      let oldest = null;
      for (const record of records.values()) {
        if (record.state !== STATE_READY || record.lastUsed >= selectStamp) continue;
        if (oldest === null || record.lastUsed < oldest.lastUsed) oldest = record;
      }
      if (oldest === null) return;
      oldest.mesh.visible = false;
      meshPool.push(oldest.mesh);
      oldest.mesh = null;
      records.delete(oldest.key);
      counters.evicted++;
      freed++;
    }
  }

  // ==========================================================================================
  // SELECTION (allocation-free quadtree walk)
  // ==========================================================================================
  const stackLevel = new Int8Array(STACK_CAPACITY);
  const stackX = new Int32Array(STACK_CAPACITY);
  const stackZ = new Int32Array(STACK_CAPACITY);
  const selected = new Array(MAX_SELECTED).fill(null);
  let selectedCount = 0;
  let holes = 0;
  // Bumped by every selection: a tile (or an ancestor of one, or a child gathered for a split) used by
  // the latest selection is never evicted; usedCount counts them.
  let selectStamp = 1;
  let usedCount = 0;
  const view = { x: 0, z: 0, altitude: 0, reach: 0, inner: 0 };
  const lastSelect = { x: NaN, z: NaN, altitude: NaN, timer: 0 };

  /** Marks a record (if any) as used by this selection. */
  function touch(record) {
    if (record === undefined || record.lastUsed === selectStamp) return;
    record.lastUsed = selectStamp;
    usedCount++;
  }

  /** Requests a child gathered for a split, or keeps it if it is already built. */
  function gatherChild(level, tileX, tileZ, priority) {
    const record = records.get(tileKey(level, tileX, tileZ));
    if (record !== undefined && record.state === STATE_READY) {
      touch(record);
      return;
    }
    if (usedCount + pendingCount < MAX_TILE_MESHES - MESH_HEADROOM) requestTile(level, tileX, tileZ, priority);
  }

  /** Marks a tile and every ancestor as used this frame (ancestors are the fallback coverage). */
  function touchLineage(level, tileX, tileZ) {
    let currentX = tileX;
    let currentZ = tileZ;
    for (let current = level; current <= ROOT_LEVEL; current++) {
      touch(records.get(tileKey(current, currentX, currentZ)));
      currentX = Math.floor(currentX / 2);
      currentZ = Math.floor(currentZ / 2);
    }
  }

  function select() {
    selectStamp++;
    selectedCount = 0;
    holes = 0;
    usedCount = 0;
    const rootSize = levelSize(ROOT_LEVEL);
    const minRootX = Math.floor((view.x - view.reach) / rootSize);
    const maxRootX = Math.floor((view.x + view.reach) / rootSize);
    const minRootZ = Math.floor((view.z - view.reach) / rootSize);
    const maxRootZ = Math.floor((view.z + view.reach) / rootSize);
    let top = 0;
    for (let rootZ = minRootZ; rootZ <= maxRootZ; rootZ++) {
      for (let rootX = minRootX; rootX <= maxRootX; rootX++) {
        if (top >= STACK_CAPACITY) break;
        stackLevel[top] = ROOT_LEVEL;
        stackX[top] = rootX;
        stackZ[top] = rootZ;
        top++;
      }
    }
    const height = Math.max(view.altitude - waterLevel, 1);
    while (top > 0) {
      top--;
      const level = stackLevel[top];
      const tileX = stackX[top];
      const tileZ = stackZ[top];
      const size = levelSize(level);
      const minX = tileX * size;
      const minZ = tileZ * size;
      const gapX = Math.max(minX - view.x, 0, view.x - (minX + size));
      const gapZ = Math.max(minZ - view.z, 0, view.z - (minZ + size));
      const nearest = Math.sqrt(gapX * gapX + gapZ * gapZ);
      if (nearest > view.reach) continue;
      // Wholly inside the terrain's own disc: the terrain draws it.
      const farX = Math.max(Math.abs(minX - view.x), Math.abs(minX + size - view.x));
      const farZ = Math.max(Math.abs(minZ - view.z), Math.abs(minZ + size - view.z));
      if (Math.sqrt(farX * farX + farZ * farZ) < view.inner) continue;
      const distance = Math.sqrt(nearest * nearest + height * height);
      const priority = -level * 1000 + distance / size;
      if (level > 0 && distance < SPLIT_FACTOR * size) {
        const childLevel = level - 1;
        const childX = tileX * 2;
        const childZ = tileZ * 2;
        const ready = isReady(childLevel, childX, childZ) && isReady(childLevel, childX + 1, childZ)
          && isReady(childLevel, childX, childZ + 1) && isReady(childLevel, childX + 1, childZ + 1);
        if (ready && top + 4 <= STACK_CAPACITY) {
          for (let child = 0; child < 4; child++) {
            stackLevel[top] = childLevel;
            stackX[top] = childX + (child & 1);
            stackZ[top] = childZ + (child >> 1);
            top++;
          }
          continue;
        }
        const childPriority = priority + 1000 + 0.5;
        gatherChild(childLevel, childX, childZ, childPriority);
        gatherChild(childLevel, childX + 1, childZ, childPriority);
        gatherChild(childLevel, childX, childZ + 1, childPriority);
        gatherChild(childLevel, childX + 1, childZ + 1, childPriority);
      }
      const record = recordFor(level, tileX, tileZ);
      if (record === undefined || record.state !== STATE_READY) {
        requestTile(level, tileX, tileZ, priority);
        holes++;
        continue;
      }
      if (selectedCount < MAX_SELECTED) selected[selectedCount++] = record;
      touchLineage(level, tileX, tileZ);
    }
  }

  // ---- Re-prioritising the queue -----------------------------------------------------------------
  /** The record a pending request spec belongs to (from its padded footprint). */
  function recordOfSpec(spec) {
    const size = (spec.size * TILE_QUADS) / TILE_VERTICES;
    const level = Math.round(Math.log2(size / BASE_TILE_SIZE));
    const spacing = size / TILE_QUADS;
    return recordFor(level, Math.round((spec.x + spacing / 2) / size), Math.round((spec.z + spacing / 2) / size));
  }
  function reprioritize() {
    const height = Math.max(view.altitude - waterLevel, 1);
    tiles.reprioritize((spec) => {
      const record = recordOfSpec(spec);
      if (record === undefined) return null;
      const half = record.size / 2;
      const centreX = record.x0 + half - view.x;
      const centreZ = record.z0 + half - view.z;
      const nearest = Math.max(0, Math.sqrt(centreX * centreX + centreZ * centreZ) - half * Math.SQRT2);
      if (nearest > view.reach * 1.2 && record.level !== ROOT_LEVEL) {
        // Stale: the drop resolves its promise with null, which frees the record for a later ask.
        return null;
      }
      return -record.level * 1000 + Math.sqrt(nearest * nearest + height * height) / record.size;
    });
  }

  // ---- Culling against the curved ground ------------------------------------------------------------
  const viewMatrix = new THREE.Matrix4();
  const projectionView = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const cullSphere = new THREE.Sphere();
  const unitScale = new THREE.Vector3(1, 1, 1);
  let drawn = 0;
  const previouslyDrawn = new Array(MAX_SELECTED).fill(null);
  let previouslyDrawnCount = 0;

  function cullAndShow() {
    // The view matrix from the camera's own pose: the camera is a scene child, so its position and
    // quaternion are world values (matrixWorld is the render frame under the floating origin).
    viewMatrix.compose(camera.position, camera.quaternion, unitScale).invert();
    projectionView.multiplyMatrices(camera.projectionMatrix, viewMatrix);
    frustum.setFromProjectionMatrix(projectionView, camera.coordinateSystem, camera.reversedDepth);
    for (let index = 0; index < previouslyDrawnCount; index++) {
      const record = previouslyDrawn[index];
      if (record.mesh !== null) record.mesh.visible = false;
      previouslyDrawn[index] = null;
    }
    previouslyDrawnCount = 0;
    drawn = 0;
    const amount = uniforms.curvatureAmount.value;
    const radius = uniforms.planetRadius.value;
    for (let index = 0; index < selectedCount; index++) {
      const record = selected[index];
      if (record.mesh === null) continue;
      const half = record.size / 2;
      const centreX = record.x0 + half;
      const centreZ = record.z0 + half;
      const offsetX = centreX - camera.position.x;
      const offsetZ = centreZ - camera.position.z;
      const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
      const drop = (amount * distance * distance) / (2 * radius) + distance * FAR_SINK;
      // The drop varies across the tile by about its slope times the half diagonal.
      const dropSpread = ((amount * distance) / radius + FAR_SINK) * half * Math.SQRT2;
      cullSphere.center.set(centreX, (record.minY + record.maxY) / 2 - drop, centreZ);
      cullSphere.radius = Math.sqrt(half * half * 2 + ((record.maxY - record.minY) / 2 + dropSpread) ** 2) + SKIRT_FLOOR;
      if (!frustum.intersectsSphere(cullSphere)) continue;
      record.mesh.visible = true;
      previouslyDrawn[previouslyDrawnCount++] = record;
      drawn++;
    }
  }

  // ==========================================================================================
  // CLOUD SHELL
  // ==========================================================================================
  const coverageData = new Uint8Array(COVERAGE_SIZE * COVERAGE_SIZE * 4);
  const coverageStaging = new Uint8Array(COVERAGE_SIZE * COVERAGE_SIZE * 4);
  const coverageTexture = new THREE.DataTexture(coverageData, COVERAGE_SIZE, COVERAGE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  coverageTexture.magFilter = THREE.LinearFilter;
  coverageTexture.minFilter = THREE.LinearFilter;
  coverageTexture.wrapS = THREE.ClampToEdgeWrapping;
  coverageTexture.wrapT = THREE.ClampToEdgeWrapping;
  coverageTexture.generateMipmaps = false;
  coverageTexture.needsUpdate = true;
  const coverage = {
    cursor: 0,
    // The snapshot being filled (world centre and side) and the one on the texture.
    stagingX: 0, stagingZ: 0, stagingSize: 1,
    shownX: 0, shownZ: 0, shownSize: 1,
    valid: false,
    refreshes: 0,
  };
  const weatherSample = { state: 'clear', stateIndex: 0, progress: 0, storminess: 0, golden: 0, bucket: 0, regionX: 0, regionZ: 0 };

  const shellUniforms = {
    outerRadius: uniform(100000),
    // The camera's world x / z minus the coverage snapshot's centre (m), and the snapshot's side (m).
    textureOffset: uniform(new THREE.Vector2()),
    textureSize: uniform(1),
    // The camera's world x / z: the breakup noise samples world positions.
    cameraXZ: uniform(new THREE.Vector2()),
    weight: uniform(0),
  };
  const shellGeometry = (() => {
    const positions = [];
    const indices = [];
    for (let ring = 0; ring < SHELL_RINGS; ring++) {
      const share = ring / (SHELL_RINGS - 1);
      for (let segment = 0; segment < SHELL_SEGMENTS; segment++) {
        const angle = (segment / SHELL_SEGMENTS) * Math.PI * 2;
        // Unit direction in x / z, the ring share in y (mapped to a radius in the vertex shader).
        positions.push(Math.cos(angle), share, Math.sin(angle));
      }
    }
    for (let ring = 0; ring < SHELL_RINGS - 1; ring++) {
      for (let segment = 0; segment < SHELL_SEGMENTS; segment++) {
        const next = (segment + 1) % SHELL_SEGMENTS;
        const a = ring * SHELL_SEGMENTS + segment;
        const b = ring * SHELL_SEGMENTS + next;
        const c = (ring + 1) * SHELL_SEGMENTS + segment;
        const d = (ring + 1) * SHELL_SEGMENTS + next;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(indices);
    return geometry;
  })();
  const shellMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  shellMaterial.name = 'far-field-cloud-shell';
  // Rings spaced geometrically from SHELL_INNER_RADIUS to the horizon, lowered by the curvature.
  const shellRadius = Fn(() => {
    const ratio = max(shellUniforms.outerRadius.div(SHELL_INNER_RADIUS), 1.0001);
    return ratio.pow(positionLocal.y).mul(SHELL_INNER_RADIUS);
  })();
  const shellLocal = vec3(positionLocal.x.mul(shellRadius), 0, positionLocal.z.mul(shellRadius));
  const shellWorld = modelWorldMatrix.mul(vec4(shellLocal, 1)).xyz;
  shellMaterial.positionNode = vec3(shellLocal.x, shellLocal.y.sub(curvatureDropNode(ctx, shellWorld)), shellLocal.z);
  const shellOffset = positionWorld.xz.sub(cameraPosition.xz);
  const shellDistance = shellOffset.length();
  const coverageUv = shellOffset.add(shellUniforms.textureOffset).div(shellUniforms.textureSize).add(0.5);
  const coverageSample = texture(coverageTexture, coverageUv);
  const worldXZ = shellOffset.add(shellUniforms.cameraXZ);
  const breakup = mx_noise_float(vec3(worldXZ.mul(1 / 2600), uniforms.time.mul(0.003))).mul(0.6)
    .add(mx_noise_float(vec3(worldXZ.mul(1 / 900), uniforms.time.mul(0.005).add(7.1))).mul(0.4));
  const storm = coverageSample.g;
  const cloudiness = smoothstep(0.42, 0.74, coverageSample.r.mul(0.85).add(breakup.mul(0.32)).add(storm.mul(0.45)));
  const shellHole = smoothstep(SHELL_HOLE_START, SHELL_HOLE_END, shellDistance);
  shellMaterial.opacityNode = cloudiness.mul(0.9).mul(shellHole).mul(shellUniforms.weight);
  const stormShade = vec3(0.3, 0.33, 0.38);
  const sunlit = uniforms.sunColor.mul(max(uniforms.sunDirection.y, 0.0).mul(0.75).add(0.25));
  const ambient = vec3(0.32, 0.36, 0.44).mul(mix(1.0, 0.12, uniforms.nightFactor));
  shellMaterial.colorNode = mix(vec3(0.96, 0.96, 0.97), stormShade, storm).mul(sunlit.add(ambient));
  const shell = new THREE.Mesh(shellGeometry, shellMaterial);
  shell.name = 'far-field-cloud-shell';
  shell.frustumCulled = false;
  shell.castShadow = false;
  shell.receiveShadow = false;
  // After the ground and the far field, before the lures and the near effects.
  shell.renderOrder = 0;
  shell.visible = false;
  scene.add(shell);

  // The cloud field and the weather are created after the far field (which follows the terrain), so
  // they are looked up on first use.
  let cloudSystem = null;
  let weatherModel = null;
  let sourcesResolved = false;
  function resolveSources() {
    sourcesResolved = true;
    const clouds = ctx.systems.clouds;
    cloudSystem = clouds && typeof clouds.getCoverageProbability === 'function' ? clouds : null;
    const weather = ctx.systems.weather;
    weatherModel = weather && weather.model && typeof weather.model.sampleAt === 'function' ? weather.model : null;
  }

  /** Fills the next slice of the coverage snapshot; swaps it onto the texture when complete. */
  function refreshCoverage(reach) {
    const total = COVERAGE_SIZE * COVERAGE_SIZE;
    if (coverage.cursor === 0) {
      coverage.stagingSize = Math.max(reach * 2, 20000);
      const texel = coverage.stagingSize / COVERAGE_SIZE;
      coverage.stagingX = Math.round(camera.position.x / texel) * texel;
      coverage.stagingZ = Math.round(camera.position.z / texel) * texel;
    }
    const texel = coverage.stagingSize / COVERAGE_SIZE;
    const originX = coverage.stagingX - coverage.stagingSize / 2;
    const originZ = coverage.stagingZ - coverage.stagingSize / 2;
    const time = state.time.elapsed;
    const end = Math.min(total, coverage.cursor + COVERAGE_TEXELS_PER_FRAME);
    for (let index = coverage.cursor; index < end; index++) {
      const column = index % COVERAGE_SIZE;
      const row = (index - column) / COVERAGE_SIZE;
      const x = originX + (column + 0.5) * texel;
      const z = originZ + (row + 0.5) * texel;
      const cover = cloudSystem.getCoverageProbability(x, z);
      const stormLevel = weatherModel === null ? 0 : weatherModel.sampleAt(x, z, time, weatherSample).storminess;
      coverageStaging[index * 4] = Math.round(Math.min(1, Math.max(0, cover)) * 255);
      coverageStaging[index * 4 + 1] = Math.round(Math.min(1, Math.max(0, stormLevel)) * 255);
      coverageStaging[index * 4 + 2] = 0;
      coverageStaging[index * 4 + 3] = 255;
    }
    coverage.cursor = end;
    if (end < total) return;
    coverage.cursor = 0;
    coverageData.set(coverageStaging);
    coverageTexture.needsUpdate = true;
    coverage.shownX = coverage.stagingX;
    coverage.shownZ = coverage.stagingZ;
    coverage.shownSize = coverage.stagingSize;
    coverage.valid = true;
    coverage.refreshes++;
  }

  function updateShell(altitude, reach) {
    if (!sourcesResolved) resolveSources();
    const weight = cloudSystem === null ? 0 : smoothRange(SHELL_START_ALTITUDE, SHELL_FULL_ALTITUDE, altitude);
    if (weight <= 0) {
      shell.visible = false;
      return;
    }
    refreshCoverage(reach);
    shell.visible = coverage.valid;
    shellUniforms.weight.value = weight;
    shellUniforms.outerRadius.value = Math.max(reach, SHELL_INNER_RADIUS * 2);
    shellUniforms.textureOffset.value.set(camera.position.x - coverage.shownX, camera.position.z - coverage.shownZ);
    shellUniforms.cameraXZ.value.set(camera.position.x, camera.position.z);
    shellUniforms.textureSize.value = coverage.shownSize;
    shell.position.set(camera.position.x, SHELL_HEIGHT, camera.position.z);
  }

  function smoothRange(edge0, edge1, value) {
    const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // ==========================================================================================
  // PREWARM: a stand-in tile and the shell draw behind the loading fade
  // ==========================================================================================
  const standIn = createTileMesh();
  meshPool.push(standIn);
  ctx.registerPrewarm?.(standIn);
  ctx.registerPrewarm?.(shell);

  // ==========================================================================================
  // FRAME
  // ==========================================================================================
  let disposed = false;
  let active = false;
  let reprioritizeTimer = 0;
  let lowSeconds = 0;
  const atmosphereFallback = { altitude: 0, farField: 0, handoff: 0, horizonDistance: 0 };

  /**
   * Gives every tile's memory back: drops the queued requests (answers still in flight find their
   * record gone and are ignored), disposes every tile mesh's geometry and forgets the records. The
   * shared index buffer and the material stay (the material's pipeline stays compiled).
   */
  function releaseTiles() {
    tiles.reprioritize(() => null);
    for (let index = 0; index < previouslyDrawnCount; index++) previouslyDrawn[index] = null;
    previouslyDrawnCount = 0;
    for (let index = 0; index < selectedCount; index++) selected[index] = null;
    selectedCount = 0;
    drawn = 0;
    for (const mesh of group.children) mesh.geometry.dispose();
    group.clear();
    meshPool.length = 0;
    meshesCreated = 0;
    tilesBuilt = false;
    records.clear();
    pendingCount = 0;
    readySinceSelect = false;
    lastSelect.timer = 0;
    counters.released++;
  }

  /** This frame's handoff band (m): its inner edge and width; the terrain's own disc is view.inner. */
  const band = { inner: 0, fade: HANDOFF_MIN_FADE };
  function computeBand(atmosphere) {
    const coverageRadius = terrain.getCoverageRadius();
    const open = 1 - atmosphere.handoff;
    band.inner = coverageRadius * HANDOFF_INNER_SHARE * open;
    band.fade = Math.max(HANDOFF_MIN_FADE, coverageRadius * HANDOFF_FADE_SHARE * open);
    view.inner = Math.max(0, band.inner - band.fade);
  }

  function update(dt, realDt) {
    if (disposed) return;
    const atmosphere = state.atmosphere ?? atmosphereFallback;
    const altitude = camera.position.y;
    view.x = camera.position.x;
    view.z = camera.position.z;
    view.altitude = altitude;
    view.reach = Math.min(MAX_VIEW_DISTANCE, Math.max(atmosphere.horizonDistance * 1.05, levelSize(ROOT_LEVEL)));
    if (altitude < PREFETCH_ALTITUDE) {
      if (active) {
        active = false;
        group.visible = false;
        terrain.setFarFieldHandoff({ innerRadius: Infinity, fade: 0, weight: 0 });
      }
      shell.visible = false;
      lowSeconds += realDt;
      if (lowSeconds >= RELEASE_SECONDS && (tilesBuilt || records.size > 0)) releaseTiles();
      return;
    }
    lowSeconds = 0;
    computeBand(atmosphere);
    if (atmosphere.farField > 0) {
      if (!active) {
        active = true;
        group.visible = true;
      }
      terrain.setFarFieldHandoff({ innerRadius: atmosphere.handoff >= 1 ? 0 : band.inner, fade: band.fade, weight: atmosphere.farField });
    } else if (active) {
      active = false;
      group.visible = false;
      terrain.setFarFieldHandoff({ innerRadius: Infinity, fade: 0, weight: 0 });
    }
    // Reselect on a timer, on a move, or when tiles arrived (the coverage may refine).
    lastSelect.timer -= realDt;
    const moved = Math.abs(view.x - lastSelect.x) + Math.abs(view.z - lastSelect.z) + Math.abs(altitude - lastSelect.altitude);
    if (!(moved < Math.max(50, altitude * SELECT_MOVE_SHARE)) || lastSelect.timer <= 0 || readySinceSelect) {
      lastSelect.x = view.x;
      lastSelect.z = view.z;
      lastSelect.altitude = altitude;
      lastSelect.timer = SELECT_INTERVAL;
      readySinceSelect = false;
      select();
    }
    reprioritizeTimer -= realDt;
    if (reprioritizeTimer <= 0) {
      reprioritizeTimer = REPRIORITIZE_INTERVAL;
      reprioritize();
    }
    if (active) cullAndShow();
    updateShell(altitude, view.reach);
  }

  return {
    update,
    /**
     * Dev and tests: { active, selected, drawn, holes (selected tiles not built yet: 0 once loaded),
     * used (tiles the selection keeps: selected, their ancestors and children being gathered), ready,
     * pending, levels (selected per level), meshes, reach, inner, handoff, shell, counters, service,
     * planetRadiusKm }.
     */
    getStats() {
      let ready = 0;
      let pending = 0;
      const levels = new Array(ROOT_LEVEL + 1).fill(0);
      for (const record of records.values()) {
        if (record.state === STATE_READY) ready++;
        else if (record.state === STATE_PENDING) pending++;
      }
      for (let index = 0; index < selectedCount; index++) levels[selected[index].level]++;
      return {
        active,
        selected: selectedCount,
        drawn,
        holes,
        used: usedCount,
        ready,
        pending,
        levels,
        meshes: meshesCreated,
        pooled: meshPool.length,
        reach: Math.round(view.reach),
        inner: Math.round(view.inner),
        handoff: { innerRadius: Math.round(handoff.innerRadius.value), fade: Math.round(handoff.fade.value), weight: Math.round(handoff.weight.value * 1000) / 1000 },
        shell: { visible: shell.visible, refreshes: coverage.refreshes, size: Math.round(coverage.shownSize) },
        counters: { ...counters },
        service: tiles.stats(),
        planetRadiusKm: settings.get('planetRadiusKm'),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tiles.dispose();
      terrain.setFarFieldHandoff({ innerRadius: Infinity, fade: 0, weight: 0 });
      scene.remove(group);
      scene.remove(shell);
      for (const child of group.children) child.geometry.dispose();
      group.clear();
      shellGeometry.dispose();
      tileMaterial.dispose();
      shellMaterial.dispose();
      coverageTexture.dispose();
      records.clear();
      meshPool.length = 0;
    },
  };
}
