// DRIFTWING entry point: boots the renderer, world and every system, then runs the frame loop.
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG, WORLD_OPTIONS } from './core/config.js';
import { createAudioSystem } from './audio/AudioEngine.js';
import { createBirdSystem } from './render/birds.js';
import { createCameraRig } from './camera/chase.js';
import { createCloudSystem } from './render/clouds.js';
import { createCopilotSystem } from './copilot/copilot.js';
import { createFlightSystem } from './flight/arcadeFlight.js';
import { createFxSystem } from './render/fx.js';
import { createInputSystem } from './input/input.js';
import { createJournal } from './gameplay/journal.js';
import { createLandmarkSystem } from './world/landmarks.js';
import { createPerfGovernor } from './core/perf.js';
import { createPostStack } from './render/post.js';
import { createRingCourseSystem } from './gameplay/rings.js';
import { createSettings } from './core/settings.js';
import { createSkySystem } from './render/sky.js';
import { createTerrainSystem } from './world/terrain.js';
import { createUISystem } from './ui/ui.js';
import { createWaterSystem } from './render/water.js';
import { createWaypointSystem } from './gameplay/waypoints.js';
import { createWorldGen } from './world/worldgen.js';
import { DEG, clamp, damp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, compassName, isFiniteVector, isFiniteQuaternion } from './core/util.js';
import { EventBus } from './core/eventBus.js';
import { attachTypedEvents } from './core/events.js';
import { createWindField } from './env/WindField.js';
import { craftRegistry } from './craft/registry.js';
import { createControlState } from './input/controlState.js';
import { createFlightTelemetry, airDensity, speedOfSound } from './flight/telemetry.js';
import { storage } from './core/storage.js';
import { findSpawn } from './world/spawn.js';
import { resolveSeed } from './core/seed.js';
import { sunDirectionForDayTime, moonDirectionForDayTime, dayTimeForSunElevation } from './core/sun.js';


// ============================================================================
// BOOT
// ============================================================================
async function boot() {
  const params = new URLSearchParams(window.location.search);
  await storage.init();
  const bus = attachTypedEvents(new EventBus(), { validate: import.meta.env.DEV || params.get('debug') === '1' });
  const settings = createSettings(bus);
  const seed = resolveSeed(params);
  if (params.get('seed') !== seed) {
    params.set('seed', seed);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  }

  // ---- Renderer: WebGPU first, WebGL2 fallback ---------------------------------
  let webgpuAvailable = false;
  if (params.get('renderer') !== 'webgl' && navigator.gpu) {
    try {
      webgpuAvailable = (await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' })) !== null;
    } catch (error) {
      webgpuAvailable = false;
    }
  }
  // Reversed depth only on WebGPU: on WebGL2 it needs EXT_clip_control (warns otherwise).
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: !webgpuAvailable, reversedDepthBuffer: webgpuAvailable });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.domElement.id = 'view';
  renderer.domElement.setAttribute('tabindex', '0');
  renderer.domElement.setAttribute('aria-label', 'DRIFTWING flight view');
  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  document.body.prepend(renderer.domElement);
  await renderer.init();
  const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
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
  const world = createWorldGen(seed, WORLD_OPTIONS);
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
      boost: { active: false, remaining: 0, cooldown: 0, cooldownTotal: 6 },
      barrelRoll: { active: false, direction: 0, progress: 0 },
      autopilot: { enabled: false, heading: spawn.heading, altitude: spawn.y, followWaypoint: false },
      biome: world.biomeAt(spawn.x, spawn.z),
    },
    flight: createFlightTelemetry(),
    waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
    perf: { fps: 60, frameMs: 16.7 },
  };
  state.player.right.set(1, 0, 0).applyQuaternion(state.player.quaternion);

  const input = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttleDelta: 0,
    throttleTarget: null,
    boost: false,
    fineControl: false,
    mouseActive: false,
    lastActivity: 0,
    touch: { active: false, x: 0, y: 0, throttle: null, boost: false },
  };

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
    worldOptions: WORLD_OPTIONS,
    state,
    input,
    controls: createControlState(),
    craftRegistry,
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

  const perf = createPerfGovernor(ctx);

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
    ['audio', createAudioSystem],
    ['ui', createUISystem],
    ['input', createInputSystem],
    ['sky', createSkySystem],
    ['terrain', createTerrainSystem],
    ['water', createWaterSystem],
    ['clouds', createCloudSystem],
    ['birds', createBirdSystem],
    ['journal', createJournal],
    ['landmarks', createLandmarkSystem],
    ['waypoints', createWaypointSystem],
    ['rings', createRingCourseSystem],
    ['flight', createFlightSystem],
    ['camera', createCameraRig],
    ['fx', createFxSystem],
    ['copilot', createCopilotSystem],
  ];
  for (const [name, factory] of factories) {
    try {
      ctx.systems[name] = factory(ctx);
    } catch (error) {
      console.error(`[DRIFTWING] system "${name}" failed to initialise`, error);
      ctx.systems[name] = { update() {}, failed: true };
    }
  }
  // Optional lifecycle hooks: prewarm() right after creation (draw lazily-shown
  // materials once behind the fade so the first ring course, beacon, boost or
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
  const UPDATE_ORDER = ['input', 'flight', 'camera', 'terrain', 'sky', 'water', 'clouds', 'birds', 'landmarks', 'journal', 'waypoints', 'rings', 'fx', 'copilot', 'audio', 'ui'];

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

  // ---- Photo mode + screenshot -----------------------------------------------------------
  ctx.setPhotoMode = (active) => {
    const next = Boolean(active);
    if (state.photoMode === next) return;
    state.photoMode = next;
    state.paused = next;
    ctx.systems.camera.setPhotoMode?.(next);
    ctx.systems.ui.setPhotoMode?.(next);
    bus.emit('photo:changed', { active: next });
  };
  // Capture must happen in the same tick as the single render (WebGL2 has no
  // preserveDrawingBuffer); the pixel ratio is raised BEFORE that render.
  let screenshotRequest = null;
  ctx.requestScreenshot = (options = {}) => { screenshotRequest = { scale: options.scale ?? 1.5 }; };
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
  function render() {
    if (post) {
      try {
        post.pipeline.render();
        return;
      } catch (error) {
        console.error('[DRIFTWING] post stack failed, rendering directly', error);
        post = null;
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

  // ---- Safety net: NaN attitude, terrain clamp, altitude ceiling -------------------------
  const lastGood = {
    position: state.player.position.clone(),
    quaternion: state.player.quaternion.clone(),
    velocity: state.player.velocity.clone(),
    heading: spawn.heading,
  };
  function enforceSafety() {
    const player = state.player;
    if (!isFiniteVector(player.position) || !isFiniteQuaternion(player.quaternion) || !isFiniteVector(player.velocity) || !Number.isFinite(player.speed)) {
      player.position.copy(lastGood.position);
      player.quaternion.copy(lastGood.quaternion);
      player.velocity.copy(lastGood.velocity);
      player.speed = Math.max(CONFIG.SPEED.STALL, lastGood.velocity.length());
      // Let the flight model rebuild its internal integrators (and snap the camera)
      // from the restored pose, otherwise NaN rates would re-poison it next frame.
      ctx.systems.flight.resetTo?.({ x: player.position.x, y: player.position.y, z: player.position.z, heading: lastGood.heading });
    } else {
      player.quaternion.normalize();
    }
    const ground = world.groundHeight(player.position.x, player.position.z);
    const floor = Math.max(ground + CONFIG.GROUND_CLEARANCE, CONFIG.WATER_LEVEL + CONFIG.WATER_CLEARANCE);
    if (player.position.y < floor) {
      player.position.y = floor;
      if (player.velocity.y < 0) player.velocity.y = 0;
    }
    if (player.position.y > CONFIG.MAX_ALTITUDE) {
      player.position.y = CONFIG.MAX_ALTITUDE;
      if (player.velocity.y > 0) player.velocity.y = 0;
    }
    player.groundHeight = ground;
    player.altitude = player.position.y;
    player.agl = player.position.y - Math.max(ground, CONFIG.WATER_LEVEL);
    lastGood.position.copy(player.position);
    lastGood.quaternion.copy(player.quaternion);
    lastGood.velocity.copy(player.velocity);
    if (Number.isFinite(player.heading)) lastGood.heading = player.heading;
  }

  // ---- Bridges from the v1 arcade flight and input state to the v2 contracts -----------------
  // ctx.controls (ControlState) and state.flight (telemetry) are what v2 systems read.
  const windSample = { vel: new THREE.Vector3(), turbulence: 0 };
  function bridgeLegacyControls() {
    const controls = ctx.controls;
    controls.pitch = input.pitch;
    controls.roll = input.roll;
    controls.yaw = input.yaw;
    controls.throttle = state.player.throttle;
  }
  function writeLegacyTelemetry() {
    const player = state.player;
    const flight = state.flight;
    flight.position.copy(player.position);
    flight.velocity.copy(player.velocity);
    flight.quaternion.copy(player.quaternion);
    ctx.wind.sample(player.position, state.time.elapsed, windSample);
    flight.wind.copy(windSample.vel);
    flight.turbulence = windSample.turbulence;
    flight.airVelocity.copy(player.velocity).sub(windSample.vel);
    flight.airspeed = flight.airVelocity.length();
    flight.indicatedAirspeed = flight.airspeed * Math.sqrt(airDensity(player.altitude) / 1.225);
    flight.groundSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    flight.mach = flight.airspeed / speedOfSound(player.altitude);
    flight.altitude = player.altitude;
    flight.agl = player.agl;
    flight.radarAltitude = player.agl;
    flight.verticalSpeed = player.verticalSpeed;
    flight.vario = player.verticalSpeed;
    flight.heading = player.heading;
    flight.pitch = player.pitch;
    flight.roll = player.roll;
    flight.gLoad = player.gForce;
    flight.throttle = player.throttle;
    flight.rpm = player.throttle;
    flight.stall.stalled = player.stalled;
    flight.stall.warning = player.stalled;
    flight.autopilot.enabled = player.autopilot.enabled;
    flight.autopilot.heading = player.autopilot.heading;
    flight.autopilot.altitude = player.autopilot.altitude;
    flight.glideRatio = player.verticalSpeed < -0.1 ? flight.groundSpeed / -player.verticalSpeed : 0;
  }

  // ---- Biome tracking ----------------------------------------------------------------------------
  let biomeTimer = 0;
  function trackBiome(dt) {
    biomeTimer -= dt;
    if (biomeTimer > 0) return;
    biomeTimer = 0.4;
    const info = world.biomeAt(state.player.position.x, state.player.position.z);
    const previous = state.player.biome;
    state.player.biome = info;
    if (!previous || previous.key !== info.key) bus.emit('biome:changed', { biome: info, previous });
  }

  // ---- Main loop --------------------------------------------------------------------------------------
  const disabledSystems = new Set();
  let lastTimeMs = null;
  document.addEventListener('visibilitychange', () => { lastTimeMs = null; });
  const fade = document.getElementById('fade');
  let fadeStarted = false;
  let warmupFrames = 0;
  let stableFrames = 0;
  let lastCpuMs = 0;
  const loopStartMs = performance.now();

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
    for (const name of UPDATE_ORDER) {
      if (disabledSystems.has(name)) continue;
      try {
        ctx.systems[name].update(simDt, realDt);
      } catch (error) {
        disabledSystems.add(name);
        console.error(`[DRIFTWING] system "${name}" crashed and was disabled`, error);
      }
      if (name === 'input') bridgeLegacyControls();
      if (name === 'flight') {
        enforceSafety();
        writeLegacyTelemetry();
      }
    }
    if (!state.paused) trackBiome(simDt);
    perf.update(realDt, lastCpuMs);
    const shot = screenshotRequest;
    screenshotRequest = null;
    let restorePixelRatio = 0;
    if (shot && shot.scale !== 1) {
      restorePixelRatio = renderer.getPixelRatio();
      renderer.setPixelRatio(Math.min(restorePixelRatio * shot.scale, 4096 / Math.max(1, window.innerWidth)));
    }
    if (!fadeStarted) forcePrewarmDrawable();
    render();
    lastCpuMs = performance.now() - cpuStart;
    if (shot) captureScreenshot();
    if (restorePixelRatio) renderer.setPixelRatio(restorePixelRatio);

    // The fade lifts once the ground is built AND frames arrive steadily (pipeline
    // compiles finished), so it never reveals a frozen canvas; 8 s safety cap.
    if (!fadeStarted) {
      warmupFrames++;
      const terrainReady = ctx.systems.terrain.isReadyAround ? ctx.systems.terrain.isReadyAround(state.player.position.x, state.player.position.z) : true;
      stableFrames = terrainReady && rawFrameMs > 0 && rawFrameMs < 45 ? stableFrames + 1 : 0;
      if ((warmupFrames > 3 && stableFrames >= 6) || performance.now() - loopStartMs > 8000) {
        fadeStarted = true;
        state.ready = true;
        callSystemHook('endPrewarm');
        endPrewarmProxies();
        fade.classList.add('clear');
        debugHandle.readyMs = Math.round(performance.now());
        bus.emit('game:ready', {});
      }
    }
    debugHandle.frame = state.frame;
  }

  const debugHandle = {
    ready: false,
    backend,
    revision: THREE.REVISION,
    seed,
    frame: 0,
    readyMs: null,
    ctx,
    get state() { return state; },
    getStats() {
      const info = renderer.info;
      return {
        backend,
        revision: THREE.REVISION,
        seed,
        fps: Math.round(state.perf.fps),
        frameMs: Math.round(state.perf.frameMs * 10) / 10,
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
        disabledSystems: [...disabledSystems],
      };
    },
  };
  window.DRIFTWING = debugHandle;
  bus.on('game:ready', () => { debugHandle.ready = true; });

  renderer.setAnimationLoop(frame);
}


boot().catch((error) => {
  console.error('[DRIFTWING] boot failed', error);
  const panel = document.getElementById('boot-error');
  const message = document.getElementById('boot-error-message');
  message.textContent = `DRIFTWING could not start: ${error && error.message ? error.message : error}. Try a current version of Chrome, Edge or Safari.`;
  panel.hidden = false;
});
