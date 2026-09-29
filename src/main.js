// DRIFTWING entry point and composition root: boots storage, settings, the renderer
// (render/renderer.js), the world and every system, then hands the frame loop (core/loop.js) to
// renderer.setAnimationLoop.
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG, WORLD_OPTIONS } from './core/config.js';
import { createAssistDefaults } from './flight/assistDefaults.js';
import { createAudioSystem } from './audio/AudioEngine.js';
import { createBirdSystem } from './render/birds.js';
import { createCameraSystem } from './camera/cameraManager.js';
import { createCloudSystem } from './render/clouds.js';
import { createCopilotSystem } from './copilot/copilot.js';
import { createDebugWindSystem } from './dev/debugWind.js';
import { createEmitterEngine } from './spawns/engines/emitterEngine.js';
import { createFlightController } from './flight/FlightController.js';
import { createFxSystem } from './render/fx.js';
import { createInputSystem } from './input/InputManager.js';
import { createFrameLoop } from './core/loop.js';
import { createJournal } from './gameplay/journal.js';
import { createLandmarkSystem } from './world/landmarks.js';
import { createPerfGovernor, measureDisplayRefresh } from './core/perf.js';
import { createGEffectsSystem, createPostStack } from './render/post.js';
import { createRenderer } from './render/renderer.js';
import { createRingCourseSystem } from './gameplay/rings.js';
import { createSettings } from './core/settings.js';
import { createShellBridge } from './shell/bridge.js';
import { createSkySystem } from './render/sky.js';
import { createSpawnDebugger } from './dev/spawnDebugger.js';
import { createSpawnSystem } from './spawns/index.js';
import { createTerrainSystem } from './world/terrain.js';
import { createUISystem } from './ui/ui.js';
import { createWaterSystem } from './render/water.js';
import { createWaypointSystem } from './gameplay/waypoints.js';
import { createWeatherSystem } from './spawns/weather.js';
import { createWindOverlaySystem } from './dev/windOverlay.js';
import { createWorldGen } from './world/worldgen.js';
import { DEG, clamp, damp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, compassName } from './core/util.js';
import { EventBus } from './core/eventBus.js';
import { attachTypedEvents } from './core/events.js';
import { createWindField, prevailingWindDirection } from './env/WindField.js';
import { craftRegistry } from './craft/index.js';
import { flightModels } from './flight/models.js';
import { createControlState } from './input/controlState.js';
import { createFlightTelemetry } from './flight/telemetry.js';
import { storage } from './core/storage.js';
import { findSpawn } from './world/spawn.js';
import { resolveSeed } from './core/seed.js';
import { sunDirectionForDayTime, moonDirectionForDayTime, dayTimeForSunElevation } from './core/sun.js';


// ============================================================================
// BOOT
// ============================================================================
/**
 * The spawn engines (src/spawns/engines/, contract section 3): one factory per engine, registered
 * with the spawns system before its prewarm hook initialises them.
 */
const SPAWN_ENGINE_FACTORIES = Object.freeze([
  createEmitterEngine,
]);

/**
 * Dev-only verification harnesses: ?test=1 (flight test), ?test=hotas (HOTAS pipeline test) and
 * ?test=terrain (terrain stamps: seams, worker parity, collision). Loaded on demand from dev builds
 * only, so none exists in production builds. Returns { databaseName, createSystem(ctx), worldPresets? }
 * or null; worldPresets (fixture presets) replace the preset list in worldgen on both threads.
 */
async function loadDevTest(params) {
  const test = params.get('test');
  if (test === '1') return (await import('./dev/testHarness.js')).prepareFlightTest({ params });
  if (test === 'hotas') return (await import('./dev/hotasTest.js')).prepareHotasTest({ params });
  if (test === 'terrain') return (await import('./dev/terrainTest.js')).prepareTerrainTest({ params });
  return null;
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const devHooks = import.meta.env.DEV || params.get('debug') === '1';
  // The spawn debugger (F9) and the spawns dev API: dev builds, or a production build with ?dev=1.
  const spawnDevTools = import.meta.env.DEV || params.get('dev') === '1';
  // First, so the harness sees every console message from boot on; it runs in its own database.
  const devTest = import.meta.env.DEV ? await loadDevTest(params) : null;
  // The display refresh is measured while boot waits on storage and the GPU (an idle window);
  // the result becomes the default frame target.
  const refreshProbe = measureDisplayRefresh();
  await storage.init(devTest ? { databaseName: devTest.databaseName } : undefined);
  const bus = attachTypedEvents(new EventBus(), { validate: devHooks });
  const settings = createSettings(bus);
  const seed = resolveSeed(params, new URLSearchParams(window.location.hash.slice(1)));
  if (params.get('seed') !== seed) {
    params.set('seed', seed);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  }

  // ---- Renderer: WebGPU first, WebGL2 fallback ---------------------------------
  const { renderer, backend, uniformUploads } = await createRenderer(params);
  if (params.get('debug') === '1') console.info(`[DRIFTWING] backend=${backend} three r${THREE.REVISION} seed=${seed}`);

  // ---- Scene, camera, shared uniforms ----------------------------------------------
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 2400);
  const camera = new THREE.PerspectiveCamera(CONFIG.CAMERA.FOV_BASE, window.innerWidth / window.innerHeight, CONFIG.CAMERA.NEAR, 9000);
  scene.add(camera);

  const cloudShadowData = new Uint8Array(CONFIG.CLOUD_SHADOW.SIZE * CONFIG.CLOUD_SHADOW.SIZE * 4);
  const cloudShadowTexture = new THREE.DataTexture(cloudShadowData, CONFIG.CLOUD_SHADOW.SIZE, CONFIG.CLOUD_SHADOW.SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  cloudShadowTexture.magFilter = THREE.LinearFilter;
  cloudShadowTexture.minFilter = THREE.LinearFilter;
  cloudShadowTexture.wrapS = THREE.ClampToEdgeWrapping;
  cloudShadowTexture.wrapT = THREE.ClampToEdgeWrapping;
  cloudShadowTexture.generateMipmaps = false;
  cloudShadowTexture.needsUpdate = true;

  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    moonDirection: uniform(new THREE.Vector3(0, -1, 0)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    skyHorizonColor: uniform(new THREE.Color(0xf2c48e)),
    skyZenithColor: uniform(new THREE.Color(0x4f6fa8)),
    nightFactor: uniform(0),
    goldenFactor: uniform(1),
    cloudShadowCenter: uniform(new THREE.Vector2(0, 0)),
    cloudShadowWorldSize: uniform(CONFIG.CLOUD_SHADOW.WORLD),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1),
    playerPosition: uniform(new THREE.Vector3()),
    waterLevel: uniform(CONFIG.WATER_LEVEL),
  };

  // ---- World + spawn ------------------------------------------------------------------
  // The terrain worker receives the same options (ctx.worldOptions), so both threads place the same
  // sites; only a dev test harness swaps in its own fixture presets.
  const worldOptions = devTest && Array.isArray(devTest.worldPresets) ? Object.freeze({ ...WORLD_OPTIONS, presets: devTest.worldPresets }) : WORLD_OPTIONS;
  const world = createWorldGen(seed, worldOptions);
  // Every world has its own prevailing wind; set before any system reads the uniform.
  prevailingWindDirection(world, uniforms.windDirection.value);
  const requestedTime = Number.parseFloat(params.get('time'));
  const startDayTime = Number.isFinite(requestedTime)
    ? ((requestedTime % 1) + 1) % 1
    : dayTimeForSunElevation(CONFIG.START_SUN_ELEVATION_DEG, true);
  const startSun = sunDirectionForDayTime(startDayTime);
  const spawn = findSpawn(world, startSun);

  // ---- Shared game state ----------------------------------------------------------------
  const state = {
    frame: 0,
    ready: false,
    paused: false,
    photoMode: false,
    seed,
    spawn,
    time: {
      elapsed: 0,
      realElapsed: 0,
      frameDt: 0,
      dayTime: startDayTime,
      sunDirection: startSun.clone(),
      moonDirection: moonDirectionForDayTime(startDayTime),
      sunElevation: Math.asin(startSun.y) / DEG,
      nightFactor: 0,
      goldenFactor: 1,
      label: 'golden hour',
    },
    player: {
      position: new THREE.Vector3(spawn.x, spawn.y, spawn.z),
      velocity: vectorFromHeading(spawn.heading).multiplyScalar(CONFIG.SPEED.CRUISE),
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -spawn.heading * DEG),
      forward: vectorFromHeading(spawn.heading),
      up: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(),
      speed: CONFIG.SPEED.CRUISE,
      throttle: 0.55,
      heading: spawn.heading,
      pitch: 0,
      roll: 0,
      yawRate: 0,
      verticalSpeed: 0,
      gForce: 1,
      altitude: spawn.y,
      groundHeight: world.groundHeight(spawn.x, spawn.z),
      agl: spawn.y - world.groundHeight(spawn.x, spawn.z),
      stalled: false,
      autopilot: { enabled: false, heading: spawn.heading, altitude: spawn.y, followWaypoint: false },
      biome: world.biomeAt(spawn.x, spawn.z),
    },
    flight: createFlightTelemetry(),
    waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
    perf: { fps: 60, frameMs: 16.7, renderScale: 1 },
  };
  state.player.right.set(1, 0, 0).applyQuaternion(state.player.quaternion);

  const ctx = {
    THREE,
    TSL,
    addons: { BufferGeometryUtils },
    CONFIG,
    renderer,
    backend,
    scene,
    camera,
    bus,
    settings,
    storage,
    world,
    wind: null,
    worldOptions,
    state,
    controls: createControlState(),
    craftRegistry,
    perf: null,
    flightModels,
    uniforms,
    textures: { cloudShadow: cloudShadowTexture },
    quality: {},
    systems: {},
    util: {
      clamp, damp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, compassName,
      sunDirectionForDayTime, moonDirectionForDayTime, dayTimeForSunElevation,
    },
    executeAction: () => {},
    getFlightState: null,
    setPhotoMode: null,
    requestScreenshot: null,
    userHasInteracted: false,
  };

  // ---- First user gesture: unlocks audio + speech synthesis ---------------------------
  const onFirstGesture = () => {
    if (ctx.userHasInteracted) return;
    ctx.userHasInteracted = true;
    bus.emit('user:gesture', {});
    window.removeEventListener('pointerdown', onFirstGesture, true);
    window.removeEventListener('keydown', onFirstGesture, true);
    window.removeEventListener('touchstart', onFirstGesture, true);
  };
  window.addEventListener('pointerdown', onFirstGesture, true);
  window.addEventListener('keydown', onFirstGesture, true);
  window.addEventListener('touchstart', onFirstGesture, true);

  ctx.wind = createWindField({ world, uniforms, state, bus });

  const perf = createPerfGovernor(ctx, { devHooks });
  ctx.perf = perf;
  refreshProbe.then(
    (result) => perf.setMeasuredRefresh(result),
    (error) => {
      console.error('[DRIFTWING] display refresh measurement failed', error);
      perf.setMeasuredRefresh(null);
    },
  );

  // ---- Pipeline prewarm ----------------------------------------------------------------------
  // Systems register objects that first appear long after boot (ring courses, beacons, bursts,
  // landmarks). Behind the loading fade, core renders those very objects (forced visible and
  // drawable just before each warm-up render), so their node graphs and GPU pipelines are built
  // before the player could notice a hitch. Proxies would not do: instanced objects bind their
  // own instance buffers into their shaders. Parentless registrations join a temporary group.
  const prewarmSources = [];
  const prewarmTargets = [];
  const prewarmGroup = new THREE.Group();
  prewarmGroup.name = 'prewarm-stand-ins';
  ctx.registerPrewarm = (object) => {
    if (object && object.isObject3D) prewarmSources.push(object);
  };
  function beginPrewarm() {
    const seen = new Set();
    const remember = (node) => {
      if (seen.has(node)) return;
      seen.add(node);
      const drawable = node.isMesh || node.isSprite || node.isLine;
      prewarmTargets.push({
        node,
        visible: node.visible,
        drawable,
        frustumCulled: node.frustumCulled,
        count: node.count,
        drawCount: drawable && node.geometry ? node.geometry.drawRange.count : null,
      });
    };
    for (const root of prewarmSources) {
      if (!root.parent) prewarmGroup.add(root);
      for (let node = root.parent; node && node !== scene; node = node.parent) remember(node);
      root.traverse(remember);
    }
    if (prewarmGroup.children.length > 0) scene.add(prewarmGroup);
  }
  function forcePrewarmDrawable() {
    for (const target of prewarmTargets) {
      const node = target.node;
      node.visible = true;
      if (!target.drawable) continue;
      node.frustumCulled = false;
      if ((node.isInstancedMesh || node.isSprite) && !(node.count > 0)) node.count = 1;
      if (node.geometry && node.geometry.drawRange.count === 0) node.geometry.drawRange.count = Infinity;
    }
  }
  function endPrewarmProxies() {
    for (const target of prewarmTargets) {
      const node = target.node;
      node.visible = target.visible;
      if (!target.drawable) continue;
      node.frustumCulled = target.frustumCulled;
      if (target.count !== undefined) node.count = target.count;
      if (target.drawCount !== null && node.geometry) node.geometry.drawRange.count = target.drawCount;
    }
    prewarmTargets.length = 0;
    if (prewarmGroup.parent) scene.remove(prewarmGroup);
    prewarmGroup.clear();
  }

  // ---- Systems (creation order matters for cross-references at construction) --------
  const factories = [
    // First, so the HUD lays out around the launcher shell's pill from the start.
    ['shell', createShellBridge],
    ['audio', createAudioSystem],
    ['ui', createUISystem],
    // Before input, so it hears the first deviceConnected (the one-time HOTAS assist default).
    ['assistDefaults', createAssistDefaults],
    ['input', createInputSystem],
    ['sky', createSkySystem],
    // The regional weather drives the sky through a sky modifier, so it comes right after it.
    ['weather', createWeatherSystem],
    ['terrain', createTerrainSystem],
    ['water', createWaterSystem],
    ['clouds', createCloudSystem],
    ['birds', createBirdSystem],
    // After wind (ctx.wind) and sky: spawn engines write wind sources and read the sky.
    ['spawns', (context) => createSpawnSystem(context, { devHooks: devHooks || spawnDevTools })],
    ['journal', createJournal],
    ['landmarks', createLandmarkSystem],
    ['waypoints', createWaypointSystem],
    ['rings', createRingCourseSystem],
    ['flight', createFlightController],
    ['camera', createCameraSystem],
    ['fx', createFxSystem],
    ['gEffects', createGEffectsSystem],
    ['copilot', createCopilotSystem],
    ['windOverlay', createWindOverlaySystem],
    // Dev-only: the spawn debugger (F9).
    ...(spawnDevTools ? [['spawnDebugger', createSpawnDebugger]] : []),
    // Dev-only: the debug wind source that proves the Phase 2 wind writer path.
    ...(devHooks ? [['debugWind', createDebugWindSystem]] : []),
    // Dev-only: the ?test harness (runs after input so its scripted controls reach flight).
    ...(devTest ? [['test', devTest.createSystem]] : []),
  ];
  for (const [name, factory] of factories) {
    try {
      ctx.systems[name] = factory(ctx);
    } catch (error) {
      console.error(`[DRIFTWING] system "${name}" failed to initialise`, error);
      ctx.systems[name] = { update() {}, failed: true };
    }
  }
  // Spawn engines join before the spawns system starts in its prewarm hook.
  if (typeof ctx.systems.spawns.register === 'function') {
    for (const createEngine of SPAWN_ENGINE_FACTORIES) {
      try {
        ctx.systems.spawns.register(createEngine());
      } catch (error) {
        console.error('[DRIFTWING] a spawn engine failed to register', error);
      }
    }
  }
  // Optional lifecycle hooks: prewarm() right after creation (draw lazily-shown
  // materials once behind the fade so the first ring course, beacon, burst or
  // landmark doesn't hitch on a pipeline compile), endPrewarm() when the fade starts.
  function callSystemHook(hookName) {
    for (const [name, system] of Object.entries(ctx.systems)) {
      if (typeof system[hookName] !== 'function') continue;
      try {
        system[hookName]();
      } catch (error) {
        console.error(`[DRIFTWING] system "${name}" ${hookName} failed`, error);
      }
    }
  }
  callSystemHook('prewarm');
  beginPrewarm();
  const fadeStatus = document.getElementById('fade-status');
  if (fadeStatus) fadeStatus.textContent = 'Warming up the sky';
  const UPDATE_ORDER = ['input', 'test', 'flight', 'camera', 'terrain', 'weather', 'sky', 'water', 'clouds', 'birds', 'spawns', 'landmarks', 'journal', 'waypoints', 'rings', 'fx', 'gEffects', 'copilot', 'audio', 'ui', 'windOverlay', 'debugWind', 'spawnDebugger'];

  // ---- Flight-state snapshot for the copilot (local or remote brain) -----------------
  ctx.getFlightState = () => {
    const player = state.player;
    const waypoint = state.waypoint;
    const nearby = ctx.systems.landmarks.getNearby ? ctx.systems.landmarks.getNearby(6000) : [];
    const journal = ctx.systems.journal.getData ? ctx.systems.journal.getData() : null;
    return {
      seed,
      position: { x: Math.round(player.position.x), y: Math.round(player.position.y), z: Math.round(player.position.z) },
      altitude: Math.round(player.altitude),
      altitudeAboveGround: Math.round(player.agl),
      speed: Math.round(player.speed),
      speedKmh: Math.round(player.speed * 3.6),
      heading: Math.round(player.heading),
      headingName: compassName(player.heading),
      pitch: Math.round(player.pitch),
      roll: Math.round(player.roll),
      throttle: Math.round(player.throttle * 100) / 100,
      verticalSpeed: Math.round(player.verticalSpeed * 10) / 10,
      biome: { key: player.biome.key, name: player.biome.name },
      dayTime: Math.round(state.time.dayTime * 1000) / 1000,
      timeLabel: state.time.label,
      isNight: state.time.nightFactor > 0.5,
      autopilot: { ...player.autopilot },
      waypoint: waypoint
        ? {
            x: Math.round(waypoint.x),
            z: Math.round(waypoint.z),
            label: waypoint.label,
            distance: Math.round(Math.hypot(waypoint.x - player.position.x, waypoint.z - player.position.z)),
            bearing: Math.round(bearingTo(player.position.x, player.position.z, waypoint.x, waypoint.z)),
          }
        : null,
      ringCourse: { ...state.ringCourse },
      nearbyLandmarks: nearby.slice(0, 5),
      journal,
    };
  };

  // ---- Photo mode + screenshot (requested through ctx.requestScreenshot, see the frame loop) -----
  ctx.setPhotoMode = (active) => {
    const next = Boolean(active);
    if (state.photoMode === next) return;
    state.photoMode = next;
    state.paused = next;
    ctx.systems.camera.setPhotoMode?.(next);
    ctx.systems.ui.setPhotoMode?.(next);
    bus.emit('photo:changed', { active: next });
  };
  function captureScreenshot() {
    renderer.domElement.toBlob((blob) => {
      if (!blob) {
        bus.emit('notify', { text: 'Screenshot failed on this browser.', kind: 'warning' });
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `driftwing-${seed}-${Date.now()}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      bus.emit('screenshot:taken', {});
    }, 'image/png');
  }

  // ---- Post stack --------------------------------------------------------------------------
  let post = null;
  try {
    post = createPostStack(renderer, scene, camera, uniforms);
    ctx.post = post;
    // Bloom is only dropped when the player picks the minimal preset; the auto
    // governor never toggles it, since the swap recompiles the output pipeline.
    const bloomWanted = (quality) => quality.bloom !== false || quality.auto === true;
    post.setBloomEnabled(bloomWanted(ctx.quality));
    bus.on('quality:changed', (quality) => post?.setBloomEnabled(bloomWanted(quality)));
  } catch (error) {
    console.error('[DRIFTWING] post stack unavailable, rendering directly', error);
  }
  // Dynamic resolution moves onto the scene pass now that the pipeline exists.
  perf.refreshRenderScale();
  function render() {
    if (post) {
      try {
        post.pipeline.render();
        return;
      } catch (error) {
        console.error('[DRIFTWING] post stack failed, rendering directly', error);
        post = null;
        ctx.post = null;
        perf.refreshRenderScale();
      }
    }
    renderer.render(scene, camera);
  }

  // ---- Resize ----------------------------------------------------------------------------------
  function onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    bus.emit('resize', { width, height });
  }
  window.addEventListener('resize', onResize);

  // ---- Frame loop ---------------------------------------------------------------------------------
  const loop = createFrameLoop(ctx, {
    updateOrder: UPDATE_ORDER,
    render,
    spawnHeading: spawn.heading,
    prewarm: {
      forceDrawable: forcePrewarmDrawable,
      finish() {
        callSystemHook('endPrewarm');
        endPrewarmProxies();
      },
    },
    captureScreenshot,
  });
  ctx.requestScreenshot = loop.requestScreenshot;

  const debugHandle = {
    ready: false,
    backend,
    revision: THREE.REVISION,
    seed,
    get frame() { return state.frame; },
    /** performance.now() (ms) when the loading fade lifted. */
    get readyMs() { return loop.readyMs; },
    ctx,
    get state() { return state; },
    getStats() {
      const info = renderer.info;
      return {
        backend,
        revision: THREE.REVISION,
        uniformUploadPatch: uniformUploads.installed,
        seed,
        fps: Math.round(state.perf.fps),
        frameMs: Math.round(state.perf.frameMs * 10) / 10,
        renderScale: state.perf.renderScale,
        frameTarget: state.perf.frameTarget,
        targetHz: state.perf.targetHz,
        perf: {
          refreshHz: state.perf.refreshHz,
          refreshMeasuredHz: state.perf.refreshMeasuredHz,
          refreshSource: state.perf.refreshSource,
          displayHz: state.perf.displayHz,
          frameTarget: state.perf.frameTarget,
          targetHz: state.perf.targetHz,
          targetMs: state.perf.targetMs === null ? null : Math.round(state.perf.targetMs * 100) / 100,
          controlFrameMs: Math.round(state.perf.controlFrameMs * 10) / 10,
          renderScale: state.perf.renderScale,
          dynamicResolution: state.perf.dynamicResolution,
          quality: state.perf.quality,
          qualityIndex: state.perf.qualityIndex,
          simulatedLoad: state.perf.simulatedLoad,
          scaleHistory: state.perf.scaleHistory.map((entry) => ({ ...entry })),
        },
        drawCalls: info.render.drawCalls ?? info.render.calls,
        triangles: info.render.triangles,
        quality: ctx.quality.name,
        dayTime: Math.round(state.time.dayTime * 1000) / 1000,
        timeLabel: state.time.label,
        player: ctx.getFlightState(),
        terrain: ctx.systems.terrain.getStats ? ctx.systems.terrain.getStats() : null,
        clouds: ctx.systems.clouds.getStats ? ctx.systems.clouds.getStats() : null,
        birds: ctx.systems.birds.getStats ? ctx.systems.birds.getStats() : null,
        landmarks: ctx.systems.landmarks.getStats ? ctx.systems.landmarks.getStats() : null,
        spawns: ctx.systems.spawns.getStats ? ctx.systems.spawns.getStats() : null,
        disabledSystems: [...loop.disabledSystems],
      };
    },
  };
  // Dev hooks only (dev builds, ?debug=1, ?test): scripted checks can stop the animation loop and
  // step frames by hand at a fixed frame time, so two runs see the same frame and physics timing
  // (tools/steps/view-physics.json flies the same inputs in different views this way).
  if (import.meta.env.DEV || params.get('debug') === '1' || params.has('test')) {
    const stepper = { paused: false, timeMs: 0 };
    debugHandle.debug = {
      /** Stops the animation loop; frames then run only through stepFrames(). */
      pauseLoop() {
        if (stepper.paused) return;
        stepper.paused = true;
        renderer.setAnimationLoop(null);
        stepper.timeMs = performance.now();
        loop.resetTiming();
      },
      /** Restarts the next stepped frame's timing (its frame carries no physics time). */
      resetTiming() {
        loop.resetTiming();
      },
      /** Runs count frames of frameMs each (the loop must be paused); returns state.frame. */
      stepFrames(count = 1, frameMs = 1000 / 60) {
        if (!stepper.paused) throw new Error('DRIFTWING.debug.stepFrames: call pauseLoop() first');
        for (let index = 0; index < count; index++) {
          stepper.timeMs += frameMs;
          loop.frame(stepper.timeMs);
        }
        return state.frame;
      },
      /** Hands the frames back to the animation loop. */
      resumeLoop() {
        if (!stepper.paused) return;
        stepper.paused = false;
        loop.resetTiming();
        renderer.setAnimationLoop(loop.frame);
      },
    };
  }
  window.DRIFTWING = debugHandle;
  bus.on('game:ready', () => { debugHandle.ready = true; });

  // ---- Start ------------------------------------------------------------------------------------------
  renderer.setAnimationLoop(loop.frame);
}


boot().catch((error) => {
  console.error('[DRIFTWING] boot failed', error);
  const panel = document.getElementById('boot-error');
  const message = document.getElementById('boot-error-message');
  message.textContent = `DRIFTWING could not start: ${error && error.message ? error.message : error}. Try a current version of Chrome, Edge or Safari.`;
  panel.hidden = false;
});
