// Floating origin check (Phase 3 contract a.8), driven by tools/steps/origin-rebase.json on a dev
// server: the step file imports this module (dev builds only; nothing in the game imports it) and
// calls the window.__dwOrigin api one step at a time.
//
// Every checked frame is stepped inside an animation frame callback: three's node frame (and with it
// the post stack's scene pass, which renders once per node frame) advances on requestAnimationFrame,
// so a frame stepped there is really rendered, and its matrixWorld values are the ones the GPU used.
//
// Checks, every one reported as a PASS / FAIL line (a FAIL is a console.error, which fails the run):
//   flight     legs of tens of kilometres flown on the frame stepper (low level, then at 13 km for the
//              vertical lattice): every frame, the render-frame position of the craft, a terrain chunk,
//              the water, a spawn and the contrail relative to the camera (matrixWorld, what the GPU
//              gets) equals the same relative position from the world-frame Object3D transforms within
//              1 mm, and a far static point projects to the same pixel within 0.5 px from the render
//              matrices as from a world-frame camera. Rebases happen on the way, plus forced ones (the
//              dev hook) mid-leg; the craft state stays finite.
//   image      at fixed poses (coast, mountains, a spawn in view, 13 km up), the frame is captured with
//              the origin on one lattice point, again (the control: what two identical frames differ
//              by), then with the origin on the neighbouring lattice point: the rebased frame must
//              differ from the previous one no more than the control does, plus a small allowance for
//              float32 rounding at the new render coordinates.
//   identity   terrain heights on a grid and the site list around the craft, and the terrain's chunk
//              builds, are identical before and after forced rebases (no rebuild, no re-placement).
import { ORIGIN_QUANTUM, ORIGIN_REBASE_DISTANCE } from '../core/origin.js';
import { SITE_CELL } from '../world/placement.js';

/** Largest allowed render/world disagreement of a camera-relative position (m). */
const RELATIVE_TOLERANCE = 0.001;
/** Largest allowed render/world disagreement of a projected far point (CSS px). */
const SCREEN_TOLERANCE = 0.5;
/** Image check: allowance over the control frame pair (mean channel difference, 0..255) and changed pixels. */
const IMAGE_MEAN_ALLOWANCE = 0.35;
const IMAGE_CHANGED_ALLOWANCE = 0.002;
/** A pixel counts as changed when a channel differs by more than this (0..255). */
const IMAGE_CHANGED_LEVEL = 24;
const IMAGE_WIDTH = 320;
const IMAGE_HEIGHT = 180;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Installs window.__dwOrigin for the step file. dw is window.DRIFTWING (dev hooks needed). Returns the api.
 */
export function installOriginRebaseCheck(dw) {
  if (!dw || !dw.debug || typeof dw.debug.rebaseOrigin !== 'function') {
    throw new Error('the origin check needs the dev hooks (a dev server, or ?debug=1 / ?test)');
  }
  const { ctx } = dw;
  const { THREE, scene, camera, state, world } = ctx;
  const origin = ctx.origin;
  const flight = ctx.systems.flight;
  const results = [];
  const scratch = {
    matrix: new THREE.Matrix4(),
    view: new THREE.Matrix4(),
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    d: new THREE.Vector3(),
  };
  const capture = document.createElement('canvas');
  capture.width = IMAGE_WIDTH;
  capture.height = IMAGE_HEIGHT;
  const captureContext = capture.getContext('2d', { willReadFrequently: true });
  let spawnId = null;
  // The flight leg in progress (beginLeg, flyFrames, endLeg), or null.
  let leg = null;

  function report(id, passed, line) {
    const text = `${passed ? 'PASS' : 'FAIL'} ${id}: ${line}`;
    results.push({ id, passed, line: text });
    if (!passed) console.error(`[origin check] ${text}`);
    return text;
  }

  /** The craft's visual root: the scene child that holds the eye anchor. */
  function craftRoot() {
    let node = flight.getEyeAnchor ? flight.getEyeAnchor() : null;
    while (node && node.parent && node.parent !== scene) node = node.parent;
    return node && node.parent === scene ? node : null;
  }

  /**
   * WORLD position of an object from its local transforms up to the scene (float64, never reads the
   * render origin or any matrixWorld).
   */
  function worldOf(object, out) {
    const matrix = scratch.matrix.identity();
    for (let node = object; node && node !== scene; node = node.parent) {
      if (node.matrixAutoUpdate) node.updateMatrix();
      matrix.premultiply(node.matrix);
    }
    return out.setFromMatrixPosition(matrix);
  }

  /** RENDER-frame position of an object, as the renderer computed it (matrixWorld). */
  function renderOf(object, out) {
    return out.setFromMatrixPosition(object.matrixWorld);
  }

  /** The nearest visible object whose name matches test, from the craft's world position. */
  function nearestNamed(test) {
    let best = null;
    let bestDistance = Infinity;
    const craft = state.player.position;
    scene.traverse((node) => {
      if (!node.visible || !test(node.name)) return;
      const distance = worldOf(node, scratch.d).distanceTo(craft);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    });
    return best;
  }

  /** The tracked objects of the continuity check: craft, terrain chunk, water, spawn mesh, contrail. */
  function trackedObjects() {
    const tracked = [];
    const add = (name, object) => {
      if (object) tracked.push({ name, object });
    };
    add('craft', craftRoot());
    add('terrain', nearestNamed((name) => name.startsWith('terrain-lod')));
    add('water', nearestNamed((name) => name === 'water'));
    add('contrail', nearestNamed((name) => name === 'contrail'));
    if (spawnId !== null) {
      const anchor = ctx.systems.spawns.getInstance(spawnId)?.anchor ?? null;
      if (anchor) {
        let spawnMesh = null;
        scene.traverse((node) => {
          if (!spawnMesh && node.isMesh && node.visible && worldOf(node, scratch.d).distanceTo(anchor) < 1) spawnMesh = node;
        });
        add('spawn', spawnMesh);
      }
    }
    return tracked;
  }

  /** CSS-pixel projection of a WORLD point through the render matrices (what the GPU does). */
  function projectRender(point, out) {
    origin.toRender(point, out).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    return out.set((out.x * 0.5 + 0.5) * window.innerWidth, (-out.y * 0.5 + 0.5) * window.innerHeight, out.z);
  }

  /** The same projection through a world-frame camera built from camera.position / quaternion. */
  function projectWorld(point, out) {
    scratch.view.compose(worldOf(camera, scratch.c), camera.quaternion, scratch.a.set(1, 1, 1)).invert();
    out.copy(point).applyMatrix4(scratch.view).applyMatrix4(camera.projectionMatrix);
    return out.set((out.x * 0.5 + 0.5) * window.innerWidth, (-out.y * 0.5 + 0.5) * window.innerHeight, out.z);
  }

  /**
   * Steps one frame (frameMs) inside the next animation frame callback, after three's own (which
   * advances the node frame), so the frame is rendered; then runs after(), still in that task (a
   * WebGL2 canvas keeps no drawing buffer past it). Resolves with after()'s result.
   */
  function stepRendered(frameMs = 1000 / 60, after = null) {
    return new Promise((resolve, reject) => {
      requestAnimationFrame(() => {
        try {
          dw.debug.stepFrames(1, frameMs);
          resolve(after ? after() : null);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /** Steps count rendered frames. */
  async function stepRenderedFrames(count, frameMs = 1000 / 60) {
    for (let index = 0; index < count; index++) await stepRendered(frameMs);
  }

  /** Waits (real time, stepping frames) until the terrain is built around the craft. */
  async function settleTerrain(timeoutMs = 25000) {
    const started = performance.now();
    const terrain = ctx.systems.terrain;
    while (performance.now() - started < timeoutMs) {
      await stepRendered();
      const position = state.player.position;
      if (!terrain.isReadyAround || terrain.isReadyAround(position.x, position.z)) {
        const stats = terrain.getStats ? terrain.getStats() : null;
        if (!stats || stats.pending === 0) return true;
      }
      await sleep(40);
    }
    return false;
  }

  /** Puts the craft at a pose (world), level on the autopilot at that height and heading. */
  function placeCraft(pose) {
    flight.resetTo({ x: pose.x, y: pose.y, z: pose.z, heading: pose.heading });
    flight.setAutopilot({ enabled: true, heading: pose.heading, altitude: pose.y, speed: pose.speed ?? 240, followWaypoint: false, reason: 'origin check' });
    dw.debug.resetTiming();
  }

  /** The leg's far static point: on the ground 6 km ahead of the craft. */
  function placeFarPoint() {
    const craft = state.player.position;
    const forward = state.player.forward;
    const point = leg.farPoint;
    point.set(craft.x + forward.x * 6000, 0, craft.z + forward.z * 6000);
    point.y = world.groundHeight(point.x, point.z);
  }

  /** Mean channel difference (0..255) and the share of changed pixels between two RGBA images. */
  function compareImages(first, second) {
    let sum = 0;
    let changed = 0;
    const pixels = first.length / 4;
    for (let index = 0; index < first.length; index += 4) {
      const dr = Math.abs(first[index] - second[index]);
      const dg = Math.abs(first[index + 1] - second[index + 1]);
      const db = Math.abs(first[index + 2] - second[index + 2]);
      sum += dr + dg + db;
      if (dr > IMAGE_CHANGED_LEVEL || dg > IMAGE_CHANGED_LEVEL || db > IMAGE_CHANGED_LEVEL) changed++;
    }
    return { mean: sum / (pixels * 3), changed: changed / pixels };
  }

  /** Renders one frame and reads it back in the same task (WebGL2 keeps no drawing buffer). */
  function renderAndCapture() {
    return stepRendered(1000 / 60, () => {
      captureContext.drawImage(ctx.renderer.domElement, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
      return captureContext.getImageData(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT).data.slice();
    });
  }

  /** Mean brightness (0..255) of a captured image: proves the capture holds a rendered frame. */
  function meanBrightness(image) {
    let sum = 0;
    for (let index = 0; index < image.length; index += 4) sum += image[index] + image[index + 1] + image[index + 2];
    return sum / (image.length / 4) / 3;
  }

  const api = {
    results,

    /** Pauses the loop on the frame stepper, freezes the day and flies the jet. */
    async setup() {
      ctx.settings.set('timeFrozen', true);
      ctx.settings.set('craft', 'jet');
      dw.debug.pauseLoop();
      await stepRenderedFrames(10);
      return `origin check ready: loop paused, craft ${flight.getCraft()}, origin ${JSON.stringify(origin.getStats().offset)}`;
    },

    /** Force-spawns presetId distance metres ahead (its mesh joins the tracked objects). */
    async spawnAhead(presetId, distance = 1600) {
      spawnId = ctx.systems.spawns.forceSpawn(presetId, { distance, force: true });
      await stepRenderedFrames(5);
      return `spawned ${presetId}: ${spawnId}`;
    },

    /** Moves the craft to pose ({ x, y, z, heading }) and waits for the terrain there. */
    async goTo(pose) {
      placeCraft(pose);
      const settled = await settleTerrain();
      return `at ${Math.round(pose.x)}, ${Math.round(pose.y)}, ${Math.round(pose.z)}: terrain ${settled ? 'ready' : 'still loading'}, origin ${JSON.stringify(origin.getStats().offset)}`;
    },

    /**
     * Starts a flight leg from pose: the camera-relative continuity of every tracked object and the
     * projection of a far static point are checked every frame flown by flyFrames(). forceAt: leg
     * frame indices at which the dev hook forces a rebase one lattice step east (the next update moves
     * it back when the craft is out of range).
     */
    async beginLeg(id, pose, { forceAt = [] } = {}) {
      placeCraft(pose);
      const settled = await settleTerrain(8000);
      leg = {
        id,
        frame: 0,
        forced: new Set(forceAt),
        forcedCount: forceAt.length,
        startVersion: origin.version,
        startX: state.player.position.x,
        startZ: state.player.position.z,
        tracked: trackedObjects(),
        farPoint: new THREE.Vector3(),
        names: new Set(),
        worst: { relative: 0, relativeAtRebase: 0, relativeName: '', screen: 0, screenAtRebase: 0, nonFinite: 0, sceneMismatch: 0 },
        rebaseFrames: 0,
        checkedAtRebase: 0,
        maxAltitude: 0,
        maxRenderDistance: 0,
      };
      placeFarPoint();
      return `${id}: started at ${Math.round(pose.x)}, ${Math.round(pose.y)}, ${Math.round(pose.z)} heading ${pose.heading} (terrain ${settled ? 'ready' : 'still loading'}), tracking ${leg.tracked.map((entry) => entry.name).join(', ')}`;
    },

    /** Flies count frames of frameMs each on the current leg, checking every frame. */
    async flyFrames(count, frameMs = 100) {
      if (!leg) throw new Error('flyFrames: no leg started (beginLeg first)');
      const { worst } = leg;
      for (let step = 0; step < count; step++) {
        if (leg.forced.has(leg.frame)) dw.debug.rebaseOrigin();
        await stepRendered(frameMs);
        const player = state.player;
        if (!Number.isFinite(player.position.x + player.position.y + player.position.z + player.velocity.x + player.velocity.y + player.velocity.z)) worst.nonFinite++;
        leg.maxAltitude = Math.max(leg.maxAltitude, player.position.y);
        const rebased = origin.getStats().lastRebaseFrame === state.frame;
        if (rebased) leg.rebaseFrames++;
        if (scene.position.x !== -origin.offset.x || scene.position.y !== -origin.offset.y || scene.position.z !== -origin.offset.z) worst.sceneMismatch++;
        if (leg.frame % 60 === 0) leg.tracked = trackedObjects();
        const cameraRender = renderOf(camera, scratch.a);
        const cameraWorld = worldOf(camera, scratch.b).clone();
        leg.maxRenderDistance = Math.max(leg.maxRenderDistance, cameraRender.length());
        for (const entry of leg.tracked) {
          leg.names.add(entry.name);
          const relativeRender = renderOf(entry.object, scratch.c).sub(cameraRender);
          const relativeWorld = worldOf(entry.object, scratch.d).sub(cameraWorld);
          const error = relativeRender.distanceTo(relativeWorld);
          if (error > worst.relative) {
            worst.relative = error;
            worst.relativeName = entry.name;
          }
          if (rebased) {
            worst.relativeAtRebase = Math.max(worst.relativeAtRebase, error);
            leg.checkedAtRebase++;
          }
        }
        if (leg.frame % 50 === 0) placeFarPoint();
        const screenWorld = projectWorld(leg.farPoint, scratch.d).clone();
        if (screenWorld.z > -1 && screenWorld.z < 1) {
          const screenRender = projectRender(leg.farPoint, scratch.c);
          const error = Math.hypot(screenRender.x - screenWorld.x, screenRender.y - screenWorld.y);
          worst.screen = Math.max(worst.screen, error);
          if (rebased) worst.screenAtRebase = Math.max(worst.screenAtRebase, error);
        }
        leg.frame++;
      }
      return `${leg.id}: ${leg.frame} frames, ${origin.version - leg.startVersion} rebases so far, at ${Math.round(state.player.position.x)}, ${Math.round(state.player.position.y)}, ${Math.round(state.player.position.z)}`;
    },

    /** Ends the leg and reports it. */
    endLeg() {
      if (!leg) throw new Error('endLeg: no leg started');
      const { worst } = leg;
      const distanceKm = Math.hypot(state.player.position.x - leg.startX, state.player.position.z - leg.startZ) / 1000;
      const rebases = origin.version - leg.startVersion;
      const passed = worst.relative <= RELATIVE_TOLERANCE && worst.screen <= SCREEN_TOLERANCE && worst.nonFinite === 0 && worst.sceneMismatch === 0
        && rebases >= 2 && leg.checkedAtRebase > 0 && leg.names.has('craft') && leg.names.has('terrain') && leg.maxRenderDistance < ORIGIN_REBASE_DISTANCE + 2000;
      const line = `${leg.frame} frames, ${distanceKm.toFixed(1)} km flown, up to ${Math.round(leg.maxAltitude)} m; ${rebases} rebases (${leg.rebaseFrames} rebase frames, ${leg.forcedCount} forced); `
        + `camera-relative render vs world: worst ${(worst.relative * 1000).toFixed(4)} mm (${worst.relativeName || 'none'}), at rebase frames ${(worst.relativeAtRebase * 1000).toFixed(4)} mm over ${leg.checkedAtRebase} object checks, tolerance 1 mm; `
        + `far point on screen: worst ${worst.screen.toExponential(2)} px, at rebase frames ${worst.screenAtRebase.toExponential(2)} px, tolerance 0.5 px; `
        + `camera within ${Math.round(leg.maxRenderDistance)} m of the render origin; objects ${[...leg.names].join(', ')}; non-finite ${worst.nonFinite}; scene transform mismatches ${worst.sceneMismatch}; origin ${JSON.stringify(origin.getStats().offset)}`;
      const id = leg.id;
      leg = null;
      return report(id, passed, line);
    },

    /**
     * The image check at pose: the frame on lattice point A, the control frame, then the frame on the
     * neighbouring lattice point B (offset: lattice steps per axis). The pose must lie within the
     * threshold of both points.
     */
    async imageCheck(id, pose, offset = { x: 1, y: 0, z: 0 }) {
      placeCraft(pose);
      const settled = await settleTerrain();
      state.paused = true;
      const position = state.player.position;
      // On an axis that moves, the lattice point below the craft and the one above; elsewhere the nearest.
      const latticeOf = (value, step) => (step === 0 ? Math.round(value / ORIGIN_QUANTUM) : Math.floor(value / ORIGIN_QUANTUM)) * ORIGIN_QUANTUM;
      const latticeA = { x: latticeOf(position.x, offset.x), y: latticeOf(position.y, offset.y), z: latticeOf(position.z, offset.z) };
      const latticeB = { x: latticeA.x + offset.x * ORIGIN_QUANTUM, y: latticeA.y + offset.y * ORIGIN_QUANTUM, z: latticeA.z + offset.z * ORIGIN_QUANTUM };
      const reach = (lattice) => Math.hypot(position.x - lattice.x, position.y - lattice.y, position.z - lattice.z);
      origin.rebaseTo(latticeA);
      await stepRenderedFrames(4);
      const first = await renderAndCapture();
      const second = await renderAndCapture();
      const versionBefore = origin.version;
      origin.rebaseTo(latticeB);
      const third = await renderAndCapture();
      const fourth = await renderAndCapture();
      const brightness = meanBrightness(second);
      const stayed = origin.version === versionBefore + 1 && origin.offset.x === latticeB.x && origin.offset.y === latticeB.y && origin.offset.z === latticeB.z;
      state.paused = false;
      const control = compareImages(first, second);
      const rebase = compareImages(second, third);
      const settledAfter = compareImages(third, fourth);
      const passed = settled && stayed && brightness > 8 && reach(latticeA) < ORIGIN_REBASE_DISTANCE && reach(latticeB) < ORIGIN_REBASE_DISTANCE
        && rebase.mean <= control.mean + IMAGE_MEAN_ALLOWANCE && rebase.changed <= control.changed + IMAGE_CHANGED_ALLOWANCE;
      return report(id, passed, `pose ${Math.round(pose.x)}, ${Math.round(pose.y)}, ${Math.round(pose.z)} (terrain ${settled ? 'ready' : 'not ready'}); origin ${JSON.stringify(latticeA)} -> ${JSON.stringify(latticeB)} (${stayed ? 'held' : 'moved again'}); `
        + `frame difference across the rebase: mean ${rebase.mean.toFixed(3)}, changed ${(rebase.changed * 100).toFixed(3)} %; control pair: mean ${control.mean.toFixed(3)}, changed ${(control.changed * 100).toFixed(3)} %; `
        + `after: mean ${settledAfter.mean.toFixed(3)}; frame brightness ${brightness.toFixed(1)}/255; allowance +${IMAGE_MEAN_ALLOWANCE} mean, +${(IMAGE_CHANGED_ALLOWANCE * 100).toFixed(1)} % changed (${IMAGE_WIDTH} x ${IMAGE_HEIGHT}, changed above ${IMAGE_CHANGED_LEVEL}/255)`);
    },

    /** Terrain heights, the site list and the chunk builds before and after forced rebases. */
    async identity(id) {
      state.paused = true;
      const craft = state.player.position;
      const sample = () => {
        const heights = [];
        for (let row = 0; row < 16; row++) {
          for (let column = 0; column < 16; column++) heights.push(world.heightAt(craft.x + (column - 7.5) * 375, craft.z + (row - 7.5) * 375));
        }
        const sites = [];
        const cellX = Math.floor(craft.x / SITE_CELL);
        const cellZ = Math.floor(craft.z / SITE_CELL);
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            for (const site of world.sitesInCell(cellX + dx, cellZ + dz)) sites.push(`${site.id}@${site.x},${site.z}`);
          }
        }
        const stats = ctx.systems.terrain.getStats();
        return { heights: heights.join(','), sites: sites.join('|'), siteCount: sites.length, meshes: stats.meshesCreated.join(','), tracked: stats.tracked };
      };
      await stepRenderedFrames(2);
      const before = sample();
      const versionBefore = origin.version;
      dw.debug.rebaseOrigin({ x: origin.offset.x + 3 * ORIGIN_QUANTUM, y: origin.offset.y + ORIGIN_QUANTUM, z: origin.offset.z - 2 * ORIGIN_QUANTUM });
      await stepRenderedFrames(3);
      const during = sample();
      dw.debug.rebaseOrigin({ x: craft.x, y: craft.y, z: craft.z });
      await stepRenderedFrames(3);
      const after = sample();
      state.paused = false;
      const rebases = origin.version - versionBefore;
      const same = (a, b) => a.heights === b.heights && a.sites === b.sites && a.meshes === b.meshes;
      const passed = rebases >= 2 && same(before, during) && same(before, after);
      return report(id, passed, `${rebases} forced rebases; 256 terrain heights ${before.heights === during.heights && before.heights === after.heights ? 'identical' : 'DIFFER'}; `
        + `${before.siteCount} sites in 7 x 7 cells ${before.sites === during.sites && before.sites === after.sites ? 'identical' : 'DIFFER'}; chunk meshes built ${before.meshes} -> ${after.meshes} (tracked ${before.tracked} -> ${after.tracked})`);
    },

    /** Ends the check: the loop runs again, the day moves on. Returns the summary line. */
    finish() {
      if (spawnId !== null) ctx.systems.spawns.deactivate(spawnId, 'debug');
      flight.setAutopilot({ enabled: false, reason: 'origin check' });
      dw.debug.resumeLoop();
      ctx.settings.set('timeFrozen', false);
      const failed = results.filter((result) => !result.passed).length;
      const line = `origin check: ${results.length - failed}/${results.length} passed`;
      if (failed > 0 || results.length === 0) console.error(`[origin check] ${line}`);
      return line;
    },
  };
  window.__dwOrigin = api;
  return api;
}
