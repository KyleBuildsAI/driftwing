// Terrain test (?test=terrain, dev builds only; main.js never loads it in production).
//
// Proves Milestone A in the running game, on whichever backend it runs (WebGPU, or WebGL2 with
// ?renderer=webgl). The six fixture site presets of terrainFixtures.js (one per stamp type) reach the
// world through the dev-only hook: prepareTerrainTest returns them as worldPresets, main.js hands them
// to worldgen as options.presets on the main thread AND in the terrain worker's init message, so the
// test never depends on the real presets. For the nearest site of each fixture (every stamp it has):
//   1. seams, offline: the chunk builder (the very code the worker runs) builds every chunk around the
//      stamp's key points and their east and south neighbours at every LOD (0-3); for all 16 LOD
//      pairs of every neighbouring pair whose shared edge a stamp touches (and, on untouched Phase 1
//      edges, the pairs the ring layout makes: LODs at most one apart), shared edge vertices must
//      agree, the skirts must hang from the surface edge, and wherever the edges part (a T-junction
//      across an LOD boundary) the upper chunk's skirt must reach below the lower edge: no crack can
//      open (terrainChecks.js).
//   2. live: the photo-mode camera flies over the stamp's first key point and then 1150 m and 2050 m
//      away (the stamp then lies in the LOD2 and LOD3 rings); once streaming has settled, the chunk
//      meshes the terrain system actually shows around the stamp are read back and checked:
//        - worker parity: each is bit-identical to a main-thread build of the same chunk and LOD, so
//          the worker placed and stamped the world exactly as the main thread did (no messaging);
//        - live seams between neighbouring displayed chunks, at whatever LODs they show;
//        - collision: worldgen.groundHeight against the displayed LOD0 mesh's own triangles at random
//          points, within COLLISION_LIMIT_M;
//        - the LODs seen: every stamp type must be seen live at every LOD.
// Criteria: fixtures placed (every stamp type within SEARCH_RADIUS of the spawn), 0 offline and live
// seam violations, worker parity exact, collision within 0.5 m, every LOD seen per stamp type, every
// pose settled, 0 console errors and 0 warnings, and no harness problems.
//
// Output: the on-screen summary panel (per-stamp table, JSON download) and window.DRIFTWING.testReport
// (tools/run-harness.mjs --test terrain). window.DRIFTWING.terrainTest.showView(index) frames one
// stamp type from the air (the run-harness screenshots), showSummary() brings the panel back.
// The test runs in its own IndexedDB database (TEST_DATABASE) and changes no player setting.
import { CONFIG } from '../core/config.js';
import { createChunkBuilder } from '../world/chunkBuilder.js';
import { hashSiteList } from '../world/placement.js';
import { STAMP_TYPES } from '../world/stamps.js';
import { installConsoleCapture } from './testConsole.js';
import { createTestPanel } from './testPanel.js';
import { FIXTURE_STAMP_TYPE, TERRAIN_FIXTURES } from './terrainFixtures.js';
import {
  buildChunkMesh, checkSeam, checkSkirtAttachment, compareMeshBuffers, extractEdges, meshHeightAt, seamPairApplies, terrainBuilderConfig,
} from './terrainChecks.js';

export const TEST_DATABASE = 'driftwing-v2-test-terrain';
const REPORT_KIND = 'driftwing-terrain-test';
const REPORT_VERSION = 1;
/** Fixture sites are looked for this far from the spawn (m). */
const SEARCH_RADIUS = 40000;
const COLLISION_LIMIT_M = 0.5;
/** Live poses: the camera over the key point, then this far away (m) so the stamp lies in the LOD2 and LOD3 rings. */
const LIVE_OFFSETS = Object.freeze([0, 1150, 2050]);
const CAMERA_HEIGHT = 320;
/** The paused craft waits this far behind the photo camera (its tether is 900 m). */
const CRAFT_PARK_M = 300;
const SETTLE_TIMEOUT_S = 90;
const SETTLE_FRAMES = 4;
const COLLISION_SAMPLES_PER_CHUNK = 120;
const MAX_PARITY_CHUNKS = 40;
/** Offline builds run in slices of this many milliseconds per frame, so the page keeps drawing. */
const BUILD_BUDGET_MS = 12;
const LOD_COUNT = CONFIG.LOD_RESOLUTIONS.length;
const CHUNK = CONFIG.CHUNK_SIZE;

/** Called by main.js before boot: the fixtures for worldgen and the system factory. */
export function prepareTerrainTest() {
  const capture = installConsoleCapture();
  return {
    databaseName: TEST_DATABASE,
    worldPresets: TERRAIN_FIXTURES,
    createSystem: (ctx) => createTerrainTestSystem(ctx, { capture }),
  };
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function mulberry32(state) {
  let a = state | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createTerrainTestSystem(ctx, { capture }) {
  const { bus, state, world } = ctx;
  const panel = createTestPanel({ title: 'Terrain test' });
  const builderConfig = terrainBuilderConfig(CONFIG);
  const builder = createChunkBuilder(world, builderConfig);
  const report = {};
  const rows = [];
  const views = [];
  const harnessErrors = [];
  const frameWaiters = [];
  const startedAt = new Date().toISOString();
  let finishedAt = null;
  let status = 'running';
  let phase = 'waiting for the game';
  let step = '';
  let done = 0;
  let total = 0;
  let sites = [];
  let siteListHash = null;
  const livePoses = [];

  // ---- Frames ----------------------------------------------------------------------------------
  function nextFrame() {
    return new Promise((resolve) => { frameWaiters.push(resolve); });
  }

  async function waitFrames(count) {
    for (let index = 0; index < count; index++) await nextFrame();
  }

  // ---- Report ------------------------------------------------------------------------------------
  function criteria() {
    const typesFound = new Set(rows.map((row) => row.type));
    const everyType = STAMP_TYPES.every((type) => typesFound.has(type));
    const offlineViolations = rows.reduce((sum, row) => sum + row.offline.violations, 0);
    const liveViolations = rows.reduce((sum, row) => sum + row.live.seamViolations, 0);
    const parityChunks = rows.reduce((sum, row) => sum + row.live.parityChunks, 0);
    const parityWorst = rows.reduce((worst, row) => Math.max(worst, row.live.parityWorst), 0);
    const collisionWorst = rows.reduce((worst, row) => Math.max(worst, row.live.collisionWorst, row.offline.collisionWorst), 0);
    const collisionSamples = rows.reduce((sum, row) => sum + row.live.collisionSamples, 0);
    const lodsByType = new Map();
    for (const row of rows) {
      const seen = lodsByType.get(row.type) ?? new Set();
      for (const lod of row.live.lodsSeen) seen.add(lod);
      lodsByType.set(row.type, seen);
    }
    const everyLod = STAMP_TYPES.every((type) => lodsByType.has(type) && lodsByType.get(type).size === LOD_COUNT);
    const unsettled = livePoses.filter((pose) => !pose.settled).length;
    const counts = capture.counts;
    return [
      { id: 'fixtures', label: 'Fixture sites (every stamp type)', value: `${typesFound.size} / ${STAMP_TYPES.length} types`, status: world.hasStamps && everyType ? 'pass' : 'fail' },
      { id: 'seams', label: 'Offline seams, every LOD pair', value: `${offlineViolations} cracks`, status: rows.length > 0 && offlineViolations === 0 ? 'pass' : 'fail' },
      { id: 'liveSeams', label: 'Live seams (displayed LODs)', value: `${liveViolations} cracks`, status: rows.length > 0 && liveViolations === 0 ? 'pass' : 'fail' },
      { id: 'parity', label: 'Worker meshes = main-thread builds', value: `${parityChunks} chunks, max diff ${parityWorst}`, status: parityChunks > 0 && parityWorst === 0 ? 'pass' : 'fail' },
      { id: 'collision', label: `Collision vs LOD0 mesh (<= ${COLLISION_LIMIT_M} m)`, value: `${round(collisionWorst, 5)} m worst, ${collisionSamples} live samples`, status: collisionSamples > 0 && collisionWorst <= COLLISION_LIMIT_M ? 'pass' : 'fail' },
      { id: 'lods', label: 'Every LOD seen live per stamp type', value: STAMP_TYPES.map((type) => `${type} ${lodsByType.has(type) ? [...lodsByType.get(type)].sort().join('') : '-'}`).join(', '), status: everyLod ? 'pass' : 'fail' },
      { id: 'settled', label: 'Streaming settled at every pose', value: `${livePoses.length - unsettled} / ${livePoses.length}`, status: livePoses.length > 0 && unsettled === 0 ? 'pass' : 'fail' },
      { id: 'console', label: 'Console errors / warnings', value: `${counts.errors} / ${counts.warnings}`, status: counts.errors === 0 && counts.warnings === 0 ? 'pass' : 'fail' },
    ];
  }

  function publish() {
    const list = criteria();
    const failed = list.some((criterion) => criterion.status === 'fail') || harnessErrors.length > 0;
    const terrainStats = ctx.systems.terrain && ctx.systems.terrain.getStats ? ctx.systems.terrain.getStats() : null;
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status,
      result: status === 'complete' ? (failed ? 'FAIL' : 'PASS') : null,
      startedAt,
      finishedAt,
      progress: { done, total, phase, step },
      environment: {
        backend: ctx.backend,
        backends: [ctx.backend],
        revision: ctx.THREE.REVISION,
        userAgent: navigator.userAgent,
        seed: state.seed,
        terrainMode: terrainStats ? terrainStats.mode : null,
        terrainWorkers: terrainStats ? terrainStats.workers : null,
        viewRings: terrainStats ? terrainStats.viewRings : null,
      },
      config: { searchRadius: SEARCH_RADIUS, collisionLimitM: COLLISION_LIMIT_M, liveOffsets: LIVE_OFFSETS, settleTimeoutS: SETTLE_TIMEOUT_S, lodResolutions: builderConfig.lodResolutions, skirtDepths: builderConfig.skirtDepths },
      fixtures: TERRAIN_FIXTURES.map((preset) => preset.id),
      siteListHash,
      sites: sites.map((site) => ({ id: site.id, presetId: site.presetId, type: FIXTURE_STAMP_TYPE[site.presetId], x: round(site.x, 1), z: round(site.z, 1), distance: Math.round(Math.hypot(site.x - state.spawn.x, site.z - state.spawn.z)) })),
      criteria: list,
      stamps: rows,
      poses: livePoses,
      views,
      console: capture.entries.slice(0, 200),
      harnessErrors: harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function progress(label, detail) {
    step = detail;
    capture.setContext(`terrain ${phase}: ${detail}`);
    panel.setProgress({ label, detail, fraction: total > 0 ? done / total : 0 });
    publish();
  }

  // ---- Offline seams: the chunk builder at every LOD ---------------------------------------------------
  function chunksAround(stamp) {
    const keys = new Map();
    for (const point of stamp.keyPoints) {
      const cx = Math.floor(point.x / CHUNK);
      const cz = Math.floor(point.z / CHUNK);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) keys.set(`${cx + dx}:${cz + dz}`, [cx + dx, cz + dz]);
    }
    return [...keys.values()];
  }

  async function checkOffline(stamp, row) {
    const chunks = chunksAround(stamp);
    const needed = new Map();
    for (const [cx, cz] of chunks) {
      for (const [x, z] of [[cx, cz], [cx + 1, cz], [cx, cz + 1]]) needed.set(`${x}:${z}`, [x, z]);
    }
    const built = new Map();
    let sliceStart = performance.now();
    for (const [cx, cz] of needed.values()) {
      for (let lod = 0; lod < LOD_COUNT; lod++) {
        const mesh = buildChunkMesh(builder, builderConfig, cx, cz, lod);
        built.set(`${cx}:${cz}:${lod}`, { mesh: lod === 0 ? mesh : null, edges: extractEdges(mesh, CHUNK) });
        if (performance.now() - sliceStart > BUILD_BUDGET_MS) {
          await nextFrame();
          sliceStart = performance.now();
        }
      }
    }
    const offline = row.offline;
    offline.chunks = chunks.length;
    for (const [cx, cz] of chunks) {
      for (const [ncx, ncz, direction] of [[cx + 1, cz, 'east'], [cx, cz + 1, 'south']]) {
        for (let lod = 0; lod < LOD_COUNT; lod++) {
          for (let neighbourLod = 0; neighbourLod < LOD_COUNT; neighbourLod++) {
            if (!seamPairApplies(world, CHUNK, cx, cz, direction, lod, neighbourLod)) {
              offline.phase1Skipped++;
              continue;
            }
            const own = built.get(`${cx}:${cz}:${lod}`);
            const other = built.get(`${ncx}:${ncz}:${neighbourLod}`);
            const seam = checkSeam(own.edges, other.edges, direction);
            offline.seams++;
            offline.violations += seam.violations;
            offline.maxSharedDiff = Math.max(offline.maxSharedDiff, seam.maxSharedDiff);
            offline.maxGap = Math.max(offline.maxGap, seam.maxGap);
            if (seam.worstCoverage !== null) offline.worstCoverage = Math.min(offline.worstCoverage, seam.worstCoverage);
            offline.worstAttachment = Math.max(offline.worstAttachment, checkSkirtAttachment(own.edges), checkSkirtAttachment(other.edges));
          }
        }
      }
    }
    if (offline.worstAttachment > 1e-3) offline.violations++;
    const random = mulberry32(17 + row.index);
    for (const [cx, cz] of chunks) {
      const { mesh } = built.get(`${cx}:${cz}:0`);
      for (let sample = 0; sample < 60; sample++) {
        const localX = random() * CHUNK;
        const localZ = random() * CHUNK;
        const difference = Math.abs(meshHeightAt(mesh, CHUNK, localX, localZ) - world.groundHeight(cx * CHUNK + localX, cz * CHUNK + localZ));
        offline.collisionWorst = Math.max(offline.collisionWorst, Number.isFinite(difference) ? difference : Infinity);
      }
    }
  }

  // ---- Live: what the terrain system shows ------------------------------------------------------------------
  const terrain = () => ctx.systems.terrain;
  const camera = () => ctx.systems.camera;

  function terrainSettled(x, z) {
    const stats = terrain().getStats();
    return terrain().isReadyAround(x, z) && stats.queued === 0 && stats.awaitingUpload === 0 && stats.inFlight === 0 && stats.fading === 0;
  }

  /**
   * Flies the photo camera to a pose and waits until streaming has settled around it. The photo camera
   * stays within 900 m of the craft, so the (paused) craft is parked CRAFT_PARK_M behind the camera
   * first, out of the shot, through the flight system's public resetTo.
   */
  async function settleAt(position, target) {
    const lookX = target.x - position.x;
    const lookZ = target.z - position.z;
    const lookLength = Math.hypot(lookX, lookZ) || 1;
    const parkX = position.x - (lookX / lookLength) * CRAFT_PARK_M;
    const parkZ = position.z - (lookZ / lookLength) * CRAFT_PARK_M;
    const parkY = Math.max(position.y, Math.max(world.groundHeight(parkX, parkZ), CONFIG.WATER_LEVEL) + CAMERA_HEIGHT);
    const heading = (Math.atan2(lookX, -lookZ) * 180) / Math.PI;
    if (!ctx.systems.flight.resetTo({ x: parkX, y: parkY, z: parkZ, heading })) throw new Error('the flight system refused to move the craft');
    await waitFrames(1);
    if (!camera().setFreeCameraPose({ position, target })) throw new Error('the photo camera refused the pose');
    const started = performance.now();
    let quiet = 0;
    await waitFrames(2);
    while (performance.now() - started < SETTLE_TIMEOUT_S * 1000) {
      await nextFrame();
      quiet = terrainSettled(position.x, position.z) ? quiet + 1 : 0;
      if (quiet >= SETTLE_FRAMES) return { settled: true, seconds: round((performance.now() - started) / 1000, 1) };
    }
    const stats = terrain().getStats();
    return {
      settled: false,
      seconds: SETTLE_TIMEOUT_S,
      terrain: { readyAround: terrain().isReadyAround(position.x, position.z), queued: stats.queued, awaitingUpload: stats.awaitingUpload, inFlight: stats.inFlight, fading: stats.fading, mode: stats.mode },
    };
  }

  /** The chunk meshes the terrain system displays now (fades finished), by chunk key. */
  function displayedChunks() {
    const group = ctx.scene.getObjectByName('terrain');
    const found = new Map();
    if (!group) return found;
    for (const child of group.children) {
      if (!child.visible || child.userData.terrainLod === undefined || !child.material || child.material.name !== 'terrain') continue;
      const lod = child.userData.terrainLod;
      const cx = Math.round(child.position.x / CHUNK);
      const cz = Math.round(child.position.z / CHUNK);
      const key = `${cx}:${cz}`;
      if (found.has(key)) harnessErrors.push(`chunk ${key} is displayed twice`);
      found.set(key, {
        cx, cz, lod,
        resolution: builderConfig.lodResolutions[lod],
        positions: child.geometry.attributes.position.array,
        colors: child.geometry.attributes.color.array,
      });
    }
    return found;
  }

  function overlapsStamp(stamp, cx, cz) {
    return cx * CHUNK <= stamp.maxX && (cx + 1) * CHUNK >= stamp.minX && cz * CHUNK <= stamp.maxZ && (cz + 1) * CHUNK >= stamp.minZ;
  }

  function checkLive(stamp, row, poseIndex) {
    const live = row.live;
    const displayed = displayedChunks();
    const around = [...displayed.values()].filter((chunk) => overlapsStamp(stamp, chunk.cx, chunk.cz));
    for (const chunk of around) live.lodsSeen.add(chunk.lod);
    // Worker parity: LOD0 chunks first (the ones a craft touches), then the rest, up to MAX_PARITY_CHUNKS.
    const parity = around.slice().sort((first, second) => first.lod - second.lod).slice(0, MAX_PARITY_CHUNKS);
    for (const chunk of parity) {
      const reference = buildChunkMesh(builder, builderConfig, chunk.cx, chunk.cz, chunk.lod);
      live.parityWorst = Math.max(live.parityWorst, compareMeshBuffers(chunk, reference));
      live.parityChunks++;
    }
    // Seams between displayed neighbours, at whatever LODs they show.
    const edges = new Map();
    const edgesOf = (chunk) => {
      const key = `${chunk.cx}:${chunk.cz}`;
      if (!edges.has(key)) edges.set(key, extractEdges(chunk, CHUNK));
      return edges.get(key);
    };
    for (const chunk of around) {
      for (const [ncx, ncz, direction] of [[chunk.cx + 1, chunk.cz, 'east'], [chunk.cx, chunk.cz + 1, 'south']]) {
        const neighbour = displayed.get(`${ncx}:${ncz}`);
        if (!neighbour) continue;
        const seam = checkSeam(edgesOf(chunk), edgesOf(neighbour), direction);
        live.seams++;
        live.seamViolations += seam.violations;
        if (seam.worstCoverage !== null) live.worstCoverage = Math.min(live.worstCoverage, seam.worstCoverage);
        const pair = `${chunk.lod}|${neighbour.lod}`;
        live.lodPairs[pair] = (live.lodPairs[pair] ?? 0) + 1;
      }
    }
    // Collision height against the displayed LOD0 meshes.
    const random = mulberry32(1000 + row.index * 10 + poseIndex);
    for (const chunk of around) {
      if (chunk.lod !== 0) continue;
      for (let sample = 0; sample < COLLISION_SAMPLES_PER_CHUNK; sample++) {
        const localX = random() * CHUNK;
        const localZ = random() * CHUNK;
        const difference = Math.abs(meshHeightAt(chunk, CHUNK, localX, localZ) - world.groundHeight(chunk.cx * CHUNK + localX, chunk.cz * CHUNK + localZ));
        live.collisionWorst = Math.max(live.collisionWorst, Number.isFinite(difference) ? difference : Infinity);
        live.collisionSamples++;
      }
    }
    return around.length;
  }

  /** Camera pose `offset` metres from the stamp's first key point, looking at it. */
  function livePose(stamp, offset) {
    const point = stamp.keyPoints[0];
    const awayX = -stamp.dirZ;
    const awayZ = stamp.dirX;
    const x = point.x + awayX * offset;
    const z = point.z + awayZ * offset;
    const ground = Math.max(world.heightAt(x, z), CONFIG.WATER_LEVEL);
    const targetGround = Math.max(world.heightAt(point.x, point.z), CONFIG.WATER_LEVEL);
    return {
      position: { x, y: Math.max(ground, targetGround) + CAMERA_HEIGHT, z },
      target: { x: point.x + stamp.dirX * 40, y: targetGround, z: point.z + stamp.dirZ * 40 },
    };
  }

  /** A pose that frames the whole stamp from the air, for the screenshots. */
  function viewPose(stamp) {
    const size = Math.max(stamp.maxX - stamp.minX, stamp.maxZ - stamp.minZ) / 2;
    const reach = stamp.type === 'carve' ? size * 0.55 : size * 0.95;
    const rightX = -stamp.dirZ;
    const rightZ = stamp.dirX;
    // The waterfall is seen from downstream, facing its face; the gorge from the side, across its span;
    // everything else from behind its start.
    const along = stamp.type === 'cliffStep' ? 1 : stamp.type === 'gorge' ? -0.35 : -1;
    const across = stamp.type === 'gorge' ? 1 : 0.45;
    const x = stamp.x + along * stamp.dirX * reach + rightX * reach * across;
    const z = stamp.z + along * stamp.dirZ * reach + rightZ * reach * across;
    const centreGround = Math.max(world.heightAt(stamp.x, stamp.z), CONFIG.WATER_LEVEL);
    const eyeGround = Math.max(world.heightAt(x, z), CONFIG.WATER_LEVEL);
    const lift = Math.max(size * (stamp.type === 'gorge' ? 0.75 : 0.45), 140);
    return {
      position: { x, y: Math.max(eyeGround, centreGround) + lift, z },
      target: { x: stamp.x, y: centreGround, z: stamp.z },
    };
  }

  function newRow(site, stamp, index) {
    return {
      index,
      siteId: site.id,
      presetId: site.presetId,
      type: stamp.type,
      stampIndex: stamp.index,
      distance: Math.round(Math.hypot(site.x - state.spawn.x, site.z - state.spawn.z)),
      offline: { chunks: 0, seams: 0, phase1Skipped: 0, violations: 0, maxSharedDiff: 0, maxGap: 0, worstCoverage: Infinity, worstAttachment: 0, collisionWorst: 0 },
      live: { chunks: 0, seams: 0, seamViolations: 0, worstCoverage: Infinity, lodPairs: {}, lodsSeen: new Set(), parityChunks: 0, parityWorst: 0, collisionSamples: 0, collisionWorst: 0 },
      passed: false,
    };
  }

  function finishRow(row) {
    const { offline, live } = row;
    row.passed = offline.violations === 0 && live.seamViolations === 0 && live.parityChunks > 0 && live.parityWorst === 0
      && offline.collisionWorst <= COLLISION_LIMIT_M && live.collisionWorst <= COLLISION_LIMIT_M && live.collisionSamples > 0;
    offline.worstCoverage = Number.isFinite(offline.worstCoverage) ? round(offline.worstCoverage, 3) : null;
    live.worstCoverage = Number.isFinite(live.worstCoverage) ? round(live.worstCoverage, 3) : null;
    offline.maxSharedDiff = round(offline.maxSharedDiff, 6);
    offline.maxGap = round(offline.maxGap, 2);
    offline.collisionWorst = round(offline.collisionWorst, 6);
    live.collisionWorst = round(live.collisionWorst, 6);
    live.lodsSeen = [...live.lodsSeen].sort();
  }

  // ---- Run ----------------------------------------------------------------------------------------------------
  async function run() {
    phase = 'setup';
    progress('Terrain test', 'finding the fixture sites');
    if (!world.hasStamps) throw new Error('the fixture presets did not reach worldgen (world.hasStamps is false)');
    const near = world.sitesNear(state.spawn.x, state.spawn.z, SEARCH_RADIUS);
    siteListHash = hashSiteList(near);
    sites = TERRAIN_FIXTURES.map((preset) => near.find((site) => site.presetId === preset.id)).filter(Boolean);
    const stamps = sites.flatMap((site) => site.stamps.map((stamp) => ({ site, stamp })));
    total = stamps.length * (1 + LIVE_OFFSETS.length);
    ctx.setPhotoMode(true);
    await waitFrames(3);
    for (const [index, { site, stamp }] of stamps.entries()) {
      const row = newRow(site, stamp, index);
      rows.push(row);
      phase = 'offline';
      progress('Seams at every LOD pair', `${stamp.type} at ${site.id}: building chunks`);
      await checkOffline(stamp, row);
      done++;
      phase = 'live';
      for (const [poseIndex, offset] of LIVE_OFFSETS.entries()) {
        progress('Live meshes', `${stamp.type} at ${site.id}: camera ${offset} m out, waiting for the terrain`);
        const pose = livePose(stamp, offset);
        const settle = await settleAt(pose.position, pose.target);
        const chunks = checkLive(stamp, row, poseIndex);
        row.live.chunks += chunks;
        livePoses.push({ stamp: `${stamp.type} ${site.id}`, offset, settled: settle.settled, seconds: settle.seconds, chunks, terrain: settle.terrain ?? null });
        if (!settle.settled) step = `${stamp.type} at ${site.id}: ${offset} m pose did not settle (${JSON.stringify(settle.terrain)})`;
        done++;
      }
      finishRow(row);
      publish();
    }
    for (const { site, stamp } of stamps) {
      if (stamp.index !== 0) continue;
      views.push({ type: stamp.type, siteId: site.id, ...viewPose(stamp) });
    }
  }

  function showSummary() {
    const list = report.criteria;
    const summaryNode = document.querySelector('.dw-test-summary');
    panel.showSummary({
      result: report.result,
      subtitle: `${rows.length} stamps of ${new Set(rows.map((row) => row.type)).size} types · seed ${state.seed} · ${ctx.backend}`,
      meta: [
        ['Backend', ctx.backend],
        ['three.js', `r${ctx.THREE.REVISION}`],
        ['Seed', state.seed],
        ['Terrain', `${report.environment.terrainMode} (${report.environment.terrainWorkers} workers), ${report.environment.viewRings} rings`],
        ['Site-list hash', siteListHash ?? '-'],
        ['Console', `${capture.counts.errors} errors, ${capture.counts.warnings} warnings`],
      ],
      criteria: list,
      sections: [
        {
          title: 'Stamps',
          table: {
            columns: [
              { key: 'type', label: 'Stamp' },
              { key: 'site', label: 'Site' },
              { key: 'distance', label: 'km', numeric: true },
              { key: 'offline', label: 'Offline seams', numeric: true, title: 'every LOD pair of neighbouring chunks around the stamp' },
              { key: 'gap', label: 'Max gap m', numeric: true, title: 'largest T-junction gap across an LOD boundary' },
              { key: 'margin', label: 'Skirt margin m', numeric: true, title: 'how far the skirt reaches past the lower edge, worst case' },
              { key: 'live', label: 'Live seams', numeric: true },
              { key: 'lods', label: 'LODs live' },
              { key: 'parity', label: 'Worker parity' },
              { key: 'collision', label: 'Collision m', numeric: true },
              { key: 'result', label: 'Result' },
            ],
            rows: rows.map((row) => ({
              type: row.type,
              site: row.siteId,
              distance: round(row.distance / 1000, 1),
              offline: `${row.offline.seams - row.offline.violations} / ${row.offline.seams}`,
              gap: row.offline.maxGap,
              margin: row.offline.worstCoverage,
              live: `${row.live.seams - row.live.seamViolations} / ${row.live.seams}`,
              lods: row.live.lodsSeen.join(' '),
              parity: `${row.live.parityChunks} chunks, ${row.live.parityWorst === 0 ? 'identical' : `diff ${row.live.parityWorst}`}`,
              collision: round(Math.max(row.live.collisionWorst, row.offline.collisionWorst), 5),
              result: { text: row.passed ? 'PASS' : 'FAIL', status: row.passed ? 'pass' : 'fail' },
            })),
          },
        },
        ...(capture.entries.length > 0 ? [{ title: 'Console errors and warnings', notes: capture.entries.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) }] : []),
        ...(harnessErrors.length > 0 ? [{ title: 'Harness problems', notes: harnessErrors.slice() }] : []),
        { title: 'About', notes: [
          'Fixture site presets (src/dev/terrainFixtures.js) reach worldgen on both threads through the dev-only worldPresets hook; the real presets are not used.',
          'Offline: the chunk builder the worker runs builds every chunk around each stamp at LOD 0-3; all 16 LOD pairs of each neighbouring pair whose edge a stamp touches are checked for cracks (shared vertices, skirt attachment, T-junction coverage); on untouched Phase 1 edges, the pairs the ring layout makes (LODs at most one apart).',
          `Live: the photo camera hovers over each stamp and ${LIVE_OFFSETS.slice(1).join(' m and ')} m away; the displayed meshes must equal main-thread builds bit for bit, meet their neighbours without cracks, and match groundHeight within ${COLLISION_LIMIT_M} m at LOD0.`,
        ] },
      ],
      report,
      filename: `driftwing-terrain-test-${ctx.backend.toLowerCase()}.json`,
      actions: [{ label: 'Run again', onClick: () => window.location.reload() }],
    });
    if (summaryNode) summaryNode.hidden = false;
  }

  function finish() {
    status = 'complete';
    finishedAt = new Date().toISOString();
    phase = 'complete';
    step = '';
    capture.setContext('terrain complete');
    publish();
    showSummary();
  }

  function abort(error) {
    const message = `terrain test stopped during ${phase} (${step}): ${error && error.message ? error.message : error}`;
    harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    finish();
  }

  // Screenshot tour for tools/run-harness.mjs: frames one stamp type from the air, panel hidden.
  const tour = {
    get views() { return views; },
    async showView(index) {
      const view = views[index];
      if (!view) throw new Error(`no view ${index}`);
      const summaryNode = document.querySelector('.dw-test-summary');
      if (summaryNode) summaryNode.hidden = true;
      panel.hideProgress();
      const settle = await settleAt(view.position, view.target);
      await waitFrames(20);
      return { type: view.type, siteId: view.siteId, ...settle };
    },
    showSummary() {
      showSummary();
    },
  };

  bus.on('game:ready', () => {
    if (window.DRIFTWING) window.DRIFTWING.terrainTest = tour;
    publish();
    run().then(finish, abort);
  });
  panel.setProgress({ label: 'Terrain test', detail: 'waiting for the game', fraction: 0 });

  return {
    update() {
      const waiters = frameWaiters.splice(0, frameWaiters.length);
      for (const resolve of waiters) resolve();
    },
    getReport() {
      return report;
    },
  };
}
