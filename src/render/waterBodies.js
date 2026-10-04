import { waterOutlineDistance, waterOutlineFrame } from '../world/waters.js';
import { createWaterMaterial } from './waterMaterial.js';

/**
 * WATER BODIES: the local water surfaces (lakes, pools, thin films, frozen lakes) of the sites near
 * the camera (contract section c.4), system `waterBodies`, updated right after `water`.
 *
 * - One pooled flat mesh per body within DRAW_RADIUS of the camera (farther ones are left to the far
 *   field), at the body's level: a grid laid over its outline frame (waters.js waterOutlineFrame),
 *   NEAR_GRID cells a side within LOD_NEAR_RADIUS, FAR_GRID beyond. Each vertex carries `waterShore`:
 *   the water depth to the basin ground (worldgen.groundHeight, through the water query's lattice
 *   cache) and the signed distance inside the body's outline, so the shared lake and ice materials
 *   (waterMaterial.js) fade the water in from its shore, foam along it and discard everything outside
 *   the basin: the surface never spills over a rim.
 * - Meshes are built a few rows per frame (BUILD_BUDGET_MS), so a body arriving never costs a frame;
 *   it shows once complete. The set of bodies is looked up again only after the camera moved
 *   REFRESH_DISTANCE (the lookup allocates its list; the frame update allocates nothing).
 * - Per-body looks (tint, wave scale, glint, foam, mirror) are per-object uniforms (mesh.userData.water).
 * With no water bodies in the world the system draws nothing and does no work.
 */
const DRAW_RADIUS = 12000;
const LOD_NEAR_RADIUS = 3500;
const NEAR_GRID = 40;
const FAR_GRID = 12;
const REFRESH_DISTANCE = 400;
const BUILD_BUDGET_MS = 1.2;
const LOD_HYSTERESIS = 300;
/** Default body colours (sRGB): lake water, a pool's turquoise, a thin film's pale sheen, ice. */
const DEFAULT_TINTS = Object.freeze({ lake: 0x2f8f9a, pool: 0x3fb5b0, thin: 0xbcd2d8, ice: 0xbcd6e6 });

export function createWaterBodySystem(ctx) {
  const { THREE: T, scene, camera, world } = ctx;
  const water = ctx.systems.water;
  const query = ctx.waterQuery;
  const group = new T.Group();
  group.name = 'water-bodies';
  scene.add(group);

  const shared = { waves: query.waves, effects: water.effects, clock: water.clock, lighting: water.lighting, swellScale: water.swellScale };
  const lakeMaterial = createWaterMaterial(ctx, { kind: 'lake', ...shared }).material;
  const iceMaterial = createWaterMaterial(ctx, { kind: 'ice', ...shared }).material;

  /** Pooled meshes per grid size (cells a side). */
  const pools = new Map([[NEAR_GRID, []], [FAR_GRID, []]]);
  let meshesCreated = 0;
  /** Live bodies by id: { record, mesh, grid, row (next row to build), ready }. */
  const live = new Map();
  const buildQueue = [];
  const lastRefresh = new Float64Array([NaN, NaN]);
  const wanted = new Set();

  function createGridMesh(grid) {
    const side = grid + 1;
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(side * side * 3), 3));
    const normals = new Float32Array(side * side * 3);
    for (let vertex = 0; vertex < side * side; vertex++) normals[vertex * 3 + 1] = 1;
    geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
    geometry.setAttribute('waterShore', new T.BufferAttribute(new Float32Array(side * side * 2), 2));
    const indices = new Uint16Array(grid * grid * 6);
    let cursor = 0;
    for (let row = 0; row < grid; row++) {
      for (let column = 0; column < grid; column++) {
        const a = row * side + column;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }
    geometry.setIndex(new T.BufferAttribute(indices, 1));
    geometry.boundingSphere = new T.Sphere(new T.Vector3(), 1);
    const mesh = new T.Mesh(geometry, lakeMaterial);
    mesh.name = `water-body-${grid}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    mesh.visible = false;
    mesh.userData.grid = grid;
    mesh.userData.water = { tint: new T.Color(DEFAULT_TINTS.lake), params: new T.Vector4(0.25, 1, 1, 0) };
    group.add(mesh);
    meshesCreated++;
    return mesh;
  }

  function acquireMesh(grid) {
    return pools.get(grid).pop() ?? createGridMesh(grid);
  }

  function releaseMesh(mesh) {
    mesh.visible = false;
    pools.get(mesh.userData.grid).push(mesh);
  }

  function gridFor(record) {
    const distance = Math.hypot(record.x - camera.position.x, record.z - camera.position.z);
    return distance < LOD_NEAR_RADIUS ? NEAR_GRID : FAR_GRID;
  }

  /** Starts (or restarts at another LOD) a body's mesh build. */
  function startBody(record, grid) {
    const mesh = acquireMesh(grid);
    const frame = waterOutlineFrame(record);
    const look = mesh.userData.water;
    look.tint.setHex(record.tint ?? (record.material === 'ice' ? DEFAULT_TINTS.ice : DEFAULT_TINTS[record.kind]));
    look.params.set(record.waves, record.glint, record.foam, record.mirror);
    mesh.material = record.material === 'ice' ? iceMaterial : lakeMaterial;
    mesh.position.set(frame.x, record.level, frame.z);
    mesh.updateMatrix();
    mesh.geometry.boundingSphere.center.set(0, 0, 0);
    mesh.geometry.boundingSphere.radius = Math.hypot(frame.halfAlong, frame.halfAcross) + 2;
    const entry = { record, frame, mesh, grid, row: 0, ready: false };
    live.set(record.id, entry);
    buildQueue.push(entry);
    return entry;
  }

  function stopBody(entry) {
    live.delete(entry.record.id);
    const queued = buildQueue.indexOf(entry);
    if (queued >= 0) buildQueue.splice(queued, 1);
    releaseMesh(entry.mesh);
  }

  /** Builds one row of a body's grid: positions (mesh-local) and the shore attribute. */
  function buildRow(entry) {
    const { record, frame, mesh, grid } = entry;
    const side = grid + 1;
    const positions = mesh.geometry.attributes.position.array;
    const shore = mesh.geometry.attributes.waterShore.array;
    const row = entry.row;
    const across = (row / grid * 2 - 1) * frame.halfAcross;
    const acrossX = -frame.alongZ;
    const acrossZ = frame.alongX;
    for (let column = 0; column <= grid; column++) {
      const along = (column / grid * 2 - 1) * frame.halfAlong;
      const localX = frame.alongX * along + acrossX * across;
      const localZ = frame.alongZ * along + acrossZ * across;
      const x = frame.x + localX;
      const z = frame.z + localZ;
      const vertex = row * side + column;
      positions[vertex * 3] = localX;
      positions[vertex * 3 + 1] = 0;
      positions[vertex * 3 + 2] = localZ;
      shore[vertex * 2] = record.level - query.groundHeight(x, z);
      shore[vertex * 2 + 1] = waterOutlineDistance(record, x, z);
    }
    entry.row++;
    if (entry.row > grid) {
      entry.ready = true;
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.waterShore.needsUpdate = true;
      mesh.visible = true;
    }
  }

  function runBuilds() {
    if (buildQueue.length === 0) return;
    const started = performance.now();
    while (buildQueue.length > 0 && performance.now() - started < BUILD_BUDGET_MS) {
      const entry = buildQueue[0];
      buildRow(entry);
      if (entry.ready) buildQueue.shift();
    }
  }

  /** Looks the bodies near the camera up again: new ones start, far ones go back to the pool. */
  function refresh() {
    lastRefresh[0] = camera.position.x;
    lastRefresh[1] = camera.position.z;
    wanted.clear();
    query.bodiesNear(camera.position.x, camera.position.z, DRAW_RADIUS, (record) => {
      wanted.add(record.id);
      const entry = live.get(record.id);
      const grid = gridFor(record);
      if (entry === undefined) startBody(record, grid);
      else if (entry.grid !== grid) {
        // Switch LOD only past the hysteresis band, then rebuild at the new grid.
        const distance = Math.hypot(record.x - camera.position.x, record.z - camera.position.z);
        if (Math.abs(distance - LOD_NEAR_RADIUS) > LOD_HYSTERESIS) {
          stopBody(entry);
          startBody(record, grid);
        }
      }
    });
    for (const entry of [...live.values()]) {
      if (!wanted.has(entry.record.id)) stopBody(entry);
    }
  }

  // Pipeline warm-up: one (degenerate) mesh per material is drawn behind the loading fade; the
  // meshes join the pool when the fade starts (endPrewarm).
  const warmupMeshes = [];
  if (world.hasWaters && typeof ctx.registerPrewarm === 'function') {
    for (const material of [lakeMaterial, iceMaterial]) {
      const mesh = createGridMesh(FAR_GRID);
      mesh.material = material;
      mesh.position.set(camera.position.x, -2000, camera.position.z);
      mesh.updateMatrix();
      ctx.registerPrewarm(mesh);
      warmupMeshes.push(mesh);
    }
  }

  return {
    group,
    endPrewarm() {
      for (const mesh of warmupMeshes) releaseMesh(mesh);
      warmupMeshes.length = 0;
    },
    update() {
      if (!world.hasWaters) return;
      const moved = Math.hypot(camera.position.x - lastRefresh[0], camera.position.z - lastRefresh[1]);
      if (!(moved < REFRESH_DISTANCE)) refresh();
      runBuilds();
    },
    /** The live bodies (ids), for tests. */
    bodyIds() {
      return [...live.keys()];
    },
    getStats() {
      let ready = 0;
      for (const entry of live.values()) if (entry.ready) ready++;
      return { bodies: live.size, ready, building: buildQueue.length, meshesCreated };
    },
    dispose() {
      scene.remove(group);
      for (const child of group.children) child.geometry.dispose();
      group.clear();
      lakeMaterial.dispose();
      iceMaterial.dispose();
      live.clear();
      buildQueue.length = 0;
    },
  };
}
