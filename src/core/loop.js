// Frame loop: timing, the per-frame system update in UPDATE_ORDER, the safety net and telemetry after
// flight, biome tracking, the performance governor, the render (with screenshot capture) and the
// loading-fade gate. main.js creates it once every system exists and hands loop.frame to
// renderer.setAnimationLoop.
//
// Per frame: realDt (clamped to 1/20 s; 1/60 s after a stall over 0.25 s) and simDt (0 while paused);
// state.time.frameDt is the unclamped frame time capped at 0.1 s, which the fixed-step physics clock
// consumes. A system that throws is disabled and logged once; the others keep running.
import { isFiniteVector, isFiniteQuaternion } from './util.js';

/** Sinking this far (m) below the shared height function is a soft crash. */
const PENETRATION_LIMIT = 1;
/** Seconds between biome lookups. */
const BIOME_INTERVAL = 0.4;
/** The loading fade lifts after this many warm-up frames and steady frames, or after FADE_CAP_MS. */
const FADE_WARMUP_FRAMES = 3;
const FADE_STABLE_FRAMES = 6;
const FADE_STABLE_FRAME_MS = 45;
const FADE_CAP_MS = 8000;

/**
 * Safety net: NaN attitude, terrain, altitude ceiling. The flight model has real ground contact, so
 * here it only keeps the last-resort guard: sinking more than 1 m into the shared height function is
 * a soft crash. The ceiling comes from the flight controller (15000 m). Returns enforce().
 */
function createSafetyNet(ctx, spawnHeading) {
  const { state, world, CONFIG } = ctx;
  const lastGood = {
    position: state.player.position.clone(),
    quaternion: state.player.quaternion.clone(),
    velocity: state.player.velocity.clone(),
    heading: spawnHeading,
  };

  return function enforceSafety() {
    const player = state.player;
    if (!isFiniteVector(player.position) || !isFiniteQuaternion(player.quaternion) || !isFiniteVector(player.velocity) || !Number.isFinite(player.speed)) {
      player.position.copy(lastGood.position);
      player.quaternion.copy(lastGood.quaternion);
      player.velocity.copy(lastGood.velocity);
      player.speed = Math.max(CONFIG.SPEED.STALL, lastGood.velocity.length());
      ctx.bus.emit('safety:nonFinite', { craft: ctx.systems.flight.getCraft?.() ?? null });
      // Let the flight model rebuild its internal integrators (and snap the camera)
      // from the restored pose, otherwise NaN rates would re-poison it next frame.
      ctx.systems.flight.resetTo?.({ x: player.position.x, y: player.position.y, z: player.position.z, heading: lastGood.heading });
    } else {
      player.quaternion.normalize();
    }
    const flight = ctx.systems.flight;
    const ground = world.groundHeight(player.position.x, player.position.z);
    if (player.position.y < ground - PENETRATION_LIMIT) flight.triggerSoftCrash?.('terrain');
    const ceiling = flight.getCeiling?.() ?? CONFIG.MAX_ALTITUDE;
    if (player.position.y > ceiling) {
      player.position.y = ceiling;
      if (player.velocity.y > 0) player.velocity.y = 0;
    }
    player.groundHeight = ground;
    player.altitude = player.position.y;
    player.agl = player.position.y - Math.max(ground, CONFIG.WATER_LEVEL);
    lastGood.position.copy(player.position);
    lastGood.quaternion.copy(player.quaternion);
    lastGood.velocity.copy(player.velocity);
    if (Number.isFinite(player.heading)) lastGood.heading = player.heading;
  };
}

/** Biome tracking: state.player.biome every BIOME_INTERVAL s, 'biome:changed' on a change. */
function createBiomeTracker(ctx) {
  const { state, world, bus } = ctx;
  let biomeTimer = 0;
  return function trackBiome(dt) {
    biomeTimer -= dt;
    if (biomeTimer > 0) return;
    biomeTimer = BIOME_INTERVAL;
    const info = world.biomeAt(state.player.position.x, state.player.position.z);
    const previous = state.player.biome;
    state.player.biome = info;
    if (!previous || previous.key !== info.key) bus.emit('biome:changed', { biome: info, previous });
  };
}

/**
 * Creates the frame loop. options:
 *   updateOrder     system names in update order (missing systems are skipped)
 *   render()        renders the frame (post stack or direct)
 *   spawnHeading    the spawn heading (the safety net's first good heading)
 *   prewarm         { forceDrawable(), finish() }: forceDrawable runs before every render until the
 *                   fade lifts; finish runs once as it lifts (end the systems' prewarm, restore proxies)
 *   captureScreenshot()  saves the canvas; called right after a render that a screenshot request raised
 * Returns { frame(timeMs), resetTiming(), requestScreenshot(options), disabledSystems, readyMs }.
 */
export function createFrameLoop(ctx, { updateOrder, render, spawnHeading, prewarm, captureScreenshot }) {
  const { state, bus, uniforms } = ctx;
  const order = updateOrder.filter((name) => ctx.systems[name]);
  const enforceSafety = createSafetyNet(ctx, spawnHeading);
  const trackBiome = createBiomeTracker(ctx);
  const disabledSystems = new Set();
  const fade = document.getElementById('fade');
  let lastTimeMs = null;
  let fadeStarted = false;
  let warmupFrames = 0;
  let stableFrames = 0;
  let lastCpuMs = 0;
  let readyMs = null;
  // Capture must happen in the same tick as the single render (WebGL2 has no
  // preserveDrawingBuffer); the pixel ratio is raised BEFORE that render.
  let screenshotRequest = null;
  const loopStartMs = performance.now();
  document.addEventListener('visibilitychange', () => { lastTimeMs = null; });

  function updateSystems(simDt, realDt) {
    for (const name of order) {
      if (disabledSystems.has(name)) continue;
      try {
        ctx.systems[name].update(simDt, realDt);
      } catch (error) {
        disabledSystems.add(name);
        console.error(`[DRIFTWING] system "${name}" crashed and was disabled`, error);
      }
      if (name === 'flight') {
        enforceSafety();
        // state.flight is written from the final (safety-checked) pose.
        if (!disabledSystems.has('flight')) ctx.systems.flight.publishTelemetry?.();
      }
    }
  }

  /**
   * The fade lifts once the ground is built AND frames arrive steadily (pipeline compiles finished),
   * so it never reveals a frozen canvas; FADE_CAP_MS safety cap.
   */
  function updateFadeGate(rawFrameMs) {
    warmupFrames++;
    const terrain = ctx.systems.terrain;
    const terrainReady = terrain.isReadyAround ? terrain.isReadyAround(state.player.position.x, state.player.position.z) : true;
    stableFrames = terrainReady && rawFrameMs > 0 && rawFrameMs < FADE_STABLE_FRAME_MS ? stableFrames + 1 : 0;
    if ((warmupFrames > FADE_WARMUP_FRAMES && stableFrames >= FADE_STABLE_FRAMES) || performance.now() - loopStartMs > FADE_CAP_MS) {
      fadeStarted = true;
      state.ready = true;
      prewarm.finish();
      fade.classList.add('clear');
      readyMs = Math.round(performance.now());
      bus.emit('game:ready', {});
    }
  }

  function frame(timeMs) {
    const rawFrameMs = lastTimeMs === null ? 0 : timeMs - lastTimeMs;
    let realDt = lastTimeMs === null ? 1 / 60 : (timeMs - lastTimeMs) / 1000;
    lastTimeMs = timeMs;
    if (!(realDt > 0) || realDt > 0.25) realDt = 1 / 60;
    realDt = Math.min(realDt, 1 / 20);
    const simDt = state.paused ? 0 : realDt;
    // Unclamped frame time (capped at 0.1 s after a stall) for the fixed-step physics clock.
    state.time.frameDt = state.paused ? 0 : Math.min(Math.max(rawFrameMs / 1000, 0), 0.1);
    state.frame++;
    state.time.elapsed += simDt;
    state.time.realElapsed += realDt;
    uniforms.time.value = state.time.elapsed;
    uniforms.playerPosition.value.copy(state.player.position);

    const cpuStart = performance.now();
    updateSystems(simDt, realDt);
    if (!state.paused) trackBiome(simDt);
    // The governor gets the real, unclamped frame interval: it holds the frame target, so a
    // clamped value would hide exactly the slow frames it has to react to.
    ctx.perf.update({ frameMs: rawFrameMs, cpuMs: lastCpuMs });
    const shot = screenshotRequest;
    screenshotRequest = null;
    // A capture renders at full render scale (and the raised pixel ratio) for this one frame.
    const endCapture = shot ? ctx.perf.beginCapture(shot.scale, 4096 / Math.max(1, window.innerWidth)) : null;
    if (!fadeStarted) prewarm.forceDrawable();
    render();
    lastCpuMs = performance.now() - cpuStart;
    if (shot) captureScreenshot();
    if (endCapture) endCapture();

    if (!fadeStarted) updateFadeGate(rawFrameMs);
  }

  return {
    frame,
    /**
     * Forgets the last frame time, so the next frame starts the timing afresh (realDt 1/60 s and no
     * physics time). Used when frames are driven by hand (the dev frame stepper in main.js).
     */
    resetTiming() {
      lastTimeMs = null;
    },
    /** Asks for a screenshot on the next frame (scale: pixel ratio multiplier, default 1.5). */
    requestScreenshot(options = {}) {
      screenshotRequest = { scale: options.scale ?? 1.5 };
    },
    /** Names of systems disabled after throwing. */
    disabledSystems,
    /** performance.now() (ms) when the fade lifted, or null before. */
    get readyMs() {
      return readyMs;
    },
  };
}
