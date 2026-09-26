import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG } from '../core/config.js';
import { MathUtils, DEG, clamp, damp, isFiniteVector } from '../core/util.js';

/**
 * CLOUDS: world-anchored low-poly cumulus that drift with the wind.
 *
 * - Cloud space = world space minus a drift offset integrated from windDirection x
 *   ~6 m/s x windStrength. Cloud space is cut into 800 m cells; each cell holds at
 *   most one cluster, built deterministically from world.hash2: a wide flat-based
 *   skirt of puffs, a central core and a few smaller towers (5-14 puffs, cluster
 *   radius 95-330 m, so skies mix small wisps with big heaps).
 * - A slow two-octave "weather" field (anchored to the clouds, gently evolving)
 *   sets the coverage, so some skies are clear and some are busy. When the weather
 *   changes, puffs grow up from the base one by one (skirt first, towers last) and
 *   shrink back the same way; at the 4.5 km edge of the field clusters shrink a
 *   little and dissolve into the sky colour, so nothing ever pops.
 * - Bases sit 380-470 m ASL but rise to stay 150 m above the ground they drift
 *   over (clouds hug the snow peaks instead of burying into them).
 * - ONE opaque InstancedMesh of flat-shaded icosahedron puffs (detail 1). Flat
 *   bottoms are clamped in the vertex stage. Shading is a stylised cloud model fed
 *   by the sky's sun / moon uniforms: face normals blended with a cluster-wide
 *   ellipsoid normal (soft low-poly), wrapped sun light that is white at midday and
 *   golden at golden hour, cool blue-grey shadow sides, a warm bounce under the
 *   base, gold rims and silver linings against the sun, dim moonlit blue-grey at
 *   night. Distance haze blends into the exact sky colour behind each cloud (the
 *   sky's own skyColorNode, the same function the fog uses).
 * - Surfaces within ~70 m of the camera dissolve with a screen-space dither so
 *   flying through a cloud never shows a hard clip; a soft veil fills the view
 *   while the camera is inside a cluster.
 * - Every 0.25 s the cloud-shadow DataTexture is redrawn as soft ellipses cast
 *   along the sun direction; state.player.inCloud reports how deep the glider is
 *   inside a cluster.
 */
export function createCloudSystem(ctx) {
  const { THREE: T, scene, camera, state, uniforms, textures, world, bus } = ctx;
  const {
    uniform, float, vec3, positionLocal, positionGeometry, positionView, positionWorld, normalWorld, cameraViewMatrix,
    instancedBufferAttribute, mix, smoothstep, saturate, pow, max, dot, normalize, length, oneMinus,
    screenCoordinate, interleavedGradientNoise,
  } = TSL;

  const CELL_SIZE = 800;
  const VIEW_RANGE = 4500;
  const EDGE_FADE_START = 3400;
  const MIN_CLUSTER_RADIUS = 95;
  const MAX_CLUSTER_RADIUS = 330;
  const CELL_REACH = Math.ceil((VIEW_RANGE + CELL_SIZE) / CELL_SIZE);
  const MAX_PUFFS = 14;
  const MIN_PUFFS = 5;
  const PUFF_STRIDE = 9;
  const PUFF_GROW_SPAN = 0.3;
  const CAPACITY = 2048;
  const DRIFT_SPEED = 6;
  const BAND_BASE_MIN = 380;
  const BAND_BASE_SPAN = 90;
  const BAND_TOP = 650;
  const TERRAIN_CLEARANCE = 150;
  const WEATHER_REFRESH_SECONDS = 1.5;
  const GROUND_REFRESH_SECONDS = 3;
  const GROWTH_RATE = 0.09;
  const BASE_RATE = 0.12;
  const MIN_VISIBLE_SCALE = 0.02;
  const MIN_PUFF_SCALE = 0.04;
  const ANCHOR_STEP = 2048;
  const NEAR_DISSOLVE_START = 16;
  const NEAR_DISSOLVE_END = 70;
  const SHADOW_INTERVAL_SECONDS = 0.25;
  const SHADOW_SIZE = CONFIG.CLOUD_SHADOW.SIZE;
  const SHADOW_OPACITY = 0.9;
  const PUFF_SHADOW_DENSITY = 0.78;
  const SHADOW_BORDER_TEXELS = 5;
  const VEIL_MAX_OPACITY = 0.55;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const EVICT_INTERVAL_FRAMES = 30;
  const PUFF_JITTER = 0.07;
  // Shading shape: how much the cluster-wide ellipsoid normal softens the facets, and how strongly
  // that ellipsoid is flattened (cumulus are wide and short, so their tops face the sky).
  const SOFT_NORMAL_WEIGHT = 0.62;
  const CLUSTER_NORMAL_LIFT = 2.4;
  const BASE_OCCLUSION = 0.58;
  // Lower half of every puff sits in the crevices between its neighbours: sunlight reaches it less.
  const CREVICE_OCCLUSION = 0.52;
  const HAZE_MAX = 0.96;
  const LIT_GAIN = 1.2;

  // ---- Cluster records (pooled) -----------------------------------------------------------
  function createClusterRecord() {
    return {
      key: 0,
      cellX: 0,
      cellZ: 0,
      centerX: 0,
      centerZ: 0,
      radius: 0,
      height: 0,
      presenceRoll: 0,
      bandBase: 0,
      base: 0,
      baseTarget: 0,
      groundReference: 0,
      groundSampled: false,
      puffCount: 0,
      // Per puff: along-x, centre lift above the base, along-z, radius, vertical squash, sin/cos of the
      // half yaw, brightness, growth threshold at which it starts to appear.
      puffs: new Float32Array(MAX_PUFFS * PUFF_STRIDE),
      growth: 0,
      growthTarget: 0,
      weatherTimer: 0,
      groundTimer: 0,
      lastSeenFrame: -1,
      worldX: 0,
      worldZ: 0,
      visibleScale: 0,
      sizeScale: 0,
      skyFade: 0,
    };
  }

  const clusterCache = new Map();
  const clusterPool = [];
  const scratchCluster = createClusterRecord();
  const puffScratch = { x: 0, y: 0, z: 0, radius: 0, halfHeight: 0 };

  function clusterKey(cellX, cellZ) {
    return (cellX + 524288) * 1048576 + (cellZ + 524288);
  }

  function writePuff(puffs, puff, along, lift, across, radius, squash, halfYaw, brightness, threshold) {
    const offset = puff * PUFF_STRIDE;
    puffs[offset] = along;
    puffs[offset + 1] = lift;
    puffs[offset + 2] = across;
    puffs[offset + 3] = radius;
    puffs[offset + 4] = squash;
    puffs[offset + 5] = Math.sin(halfYaw);
    puffs[offset + 6] = Math.cos(halfYaw);
    puffs[offset + 7] = brightness;
    puffs[offset + 8] = threshold;
  }

  /**
   * Deterministic cumulus template for a cloud-space cell (offsets relative to its centre and base):
   * puff 0 is the core, then a skirt of squat puffs that hug the flat base around it, then smaller
   * towers heaped on top toward the middle.
   */
  let rollCellX = 0;
  let rollCellZ = 0;
  function roll(salt) {
    return world.hash2(rollCellX, rollCellZ, salt);
  }
  const placed = { x: 0, z: 0 };
  /** Cluster-plane offset (along / across its long axis) rotated into world x / z. */
  function placeOnAxis(along, across, aspect, axisCos, axisSin) {
    placed.x = along * aspect * axisCos - (across / aspect) * axisSin;
    placed.z = along * aspect * axisSin + (across / aspect) * axisCos;
    return placed;
  }

  function populateCluster(cluster, cellX, cellZ) {
    rollCellX = cellX;
    rollCellZ = cellZ;
    cluster.cellX = cellX;
    cluster.cellZ = cellZ;
    cluster.centerX = (cellX + 0.2 + 0.6 * roll(412)) * CELL_SIZE;
    cluster.centerZ = (cellZ + 0.2 + 0.6 * roll(413)) * CELL_SIZE;
    const sizeRoll = roll(414);
    const radius = MIN_CLUSTER_RADIUS + (MAX_CLUSTER_RADIUS - MIN_CLUSTER_RADIUS) * Math.pow(sizeRoll, 1.4);
    cluster.bandBase = BAND_BASE_MIN + BAND_BASE_SPAN * roll(416);
    // Tops stay inside the 380-650 m band over low ground.
    const height = Math.min(radius * (0.5 + 0.22 * roll(421)), BAND_TOP - cluster.bandBase);
    cluster.radius = radius;
    cluster.height = height;
    cluster.presenceRoll = roll(401);
    const puffCount = clamp(Math.round(MIN_PUFFS + (MAX_PUFFS - MIN_PUFFS) * (0.75 * Math.pow(sizeRoll, 0.45) + 0.25 * roll(415))), MIN_PUFFS, MAX_PUFFS);
    cluster.puffCount = puffCount;
    const aspect = 1 + 0.55 * roll(417);
    const axisAngle = roll(418) * Math.PI * 2;
    const axisCos = Math.cos(axisAngle);
    const axisSin = Math.sin(axisAngle);
    const phase = roll(419) * Math.PI * 2;
    const skirtCount = Math.max(3, Math.round((puffCount - 1) * 0.52));
    const towerCount = puffCount - 1 - skirtCount;

    // Core: the tallest heap, its top at the cluster height.
    const coreRadius = radius * (0.37 + 0.06 * roll(430));
    const coreSquash = 0.78 + 0.1 * roll(431);
    writePuff(cluster.puffs, 0, 0, height - coreRadius * coreSquash, 0, coreRadius, coreSquash, roll(432) * Math.PI, 1, 0);

    for (let index = 0; index < skirtCount; index++) {
      const puff = 1 + index;
      const angle = phase + (index / skirtCount) * Math.PI * 2 + 0.55 * (roll(440 + puff) - 0.5);
      const reach = radius * (0.5 + 0.2 * roll(460 + puff));
      const { x, z } = placeOnAxis(Math.cos(angle) * reach, Math.sin(angle) * reach, aspect, axisCos, axisSin);
      const puffRadius = radius * (0.24 + 0.08 * roll(480 + puff));
      const squash = 0.62 + 0.14 * roll(500 + puff);
      // Centre just above the base: the lower part is clamped flat, the top forms the low shoulders.
      const lift = puffRadius * squash * (0.25 + 0.3 * roll(520 + puff));
      const threshold = 0.08 + 0.3 * (index / skirtCount);
      writePuff(cluster.puffs, puff, x, lift, z, puffRadius, squash, roll(540 + puff) * Math.PI, 0.93 + 0.07 * roll(560 + puff), threshold);
    }

    for (let index = 0; index < towerCount; index++) {
      const puff = 1 + skirtCount + index;
      const angle = phase + 0.8 + index * GOLDEN_ANGLE;
      const reach = radius * (0.14 + 0.26 * roll(440 + puff));
      const { x, z } = placeOnAxis(Math.cos(angle) * reach, Math.sin(angle) * reach, aspect, axisCos, axisSin);
      const puffRadius = radius * (0.18 + 0.09 * roll(480 + puff));
      const squash = 0.82 + 0.14 * roll(500 + puff);
      const topFraction = 0.62 + 0.36 * roll(520 + puff) * (1 - reach / radius);
      const lift = Math.max(puffRadius * squash * 0.4, height * topFraction - puffRadius * squash);
      const threshold = 0.4 + 0.35 * (index / Math.max(1, towerCount));
      writePuff(cluster.puffs, puff, x, lift, z, puffRadius, squash, roll(540 + puff) * Math.PI, 0.95 + 0.05 * roll(560 + puff), threshold);
    }
    cluster.groundSampled = false;
    cluster.lastSeenFrame = -1;
  }

  /** World-space puff for the cluster's current growth / edge scale; false when it is hidden. */
  function resolvePuff(cluster, puff, out) {
    const offset = puff * PUFF_STRIDE;
    const puffs = cluster.puffs;
    const threshold = puffs[offset + 8];
    const appear = MathUtils.smoothstep(cluster.growth, threshold, threshold + PUFF_GROW_SPAN);
    const size = appear * cluster.sizeScale;
    if (size < MIN_PUFF_SCALE) return false;
    out.radius = puffs[offset + 3] * size;
    out.halfHeight = out.radius * puffs[offset + 4];
    out.x = cluster.worldX + puffs[offset] * cluster.sizeScale;
    out.z = cluster.worldZ + puffs[offset + 2] * cluster.sizeScale;
    // Growing puffs rise out of the base rather than floating in above it.
    out.y = cluster.base + puffs[offset + 1] * size;
    return true;
  }

  // ---- Weather + drift ------------------------------------------------------------------
  const drift = { x: 0, z: 0 };

  function coverageProbability(cloudX, cloudZ, elapsed) {
    const broad = world.noise(cloudX, cloudZ, 1 / 11000, 24);
    const evolving = world.noise(cloudX + elapsed * 3.1, cloudZ - elapsed * 2.3, 1 / 5200, 25);
    const weather = 0.5 + 0.5 * (0.68 * broad + 0.32 * evolving);
    const density = ctx.quality.cloudDensity ?? 1;
    return density * (0.16 + 0.78 * MathUtils.smoothstep(weather, 0.34, 0.72));
  }

  // Opening shot: the air around the spawn and its first stretch of flight path stays clear for a
  // while, then those clusters grow back in through the normal growth smoothing (no popping).
  const SPAWN_CLEAR_SECONDS = 25;
  const SPAWN_CLEAR_FADE_SECONDS = 12;
  const SPAWN_CLEAR_MARGIN = 350;
  const SPAWN_PATH_LENGTH = 2200;
  const spawnPath = {
    x: state.spawn?.x ?? state.player.position.x,
    z: state.spawn?.z ?? state.player.position.z,
    directionX: Math.sin((state.spawn?.heading ?? 0) * DEG),
    directionZ: -Math.cos((state.spawn?.heading ?? 0) * DEG),
  };

  function spawnClearance(cluster, elapsed) {
    if (elapsed >= SPAWN_CLEAR_SECONDS + SPAWN_CLEAR_FADE_SECONDS) return 1;
    const offsetX = cluster.centerX + drift.x - spawnPath.x;
    const offsetZ = cluster.centerZ + drift.z - spawnPath.z;
    const along = clamp(offsetX * spawnPath.directionX + offsetZ * spawnPath.directionZ, 0, SPAWN_PATH_LENGTH);
    const gapX = offsetX - spawnPath.directionX * along;
    const gapZ = offsetZ - spawnPath.directionZ * along;
    const reach = cluster.radius + SPAWN_CLEAR_MARGIN;
    if (gapX * gapX + gapZ * gapZ > reach * reach) return 1;
    return MathUtils.smoothstep(elapsed, SPAWN_CLEAR_SECONDS, SPAWN_CLEAR_SECONDS + SPAWN_CLEAR_FADE_SECONDS);
  }

  function growthTargetFor(cluster, elapsed) {
    const coverage = coverageProbability(cluster.centerX, cluster.centerZ, elapsed);
    return MathUtils.smoothstep(coverage, cluster.presenceRoll - 0.1, cluster.presenceRoll + 0.1) * spawnClearance(cluster, elapsed);
  }

  function sampleGround(cluster) {
    const worldX = cluster.centerX + drift.x;
    const worldZ = cluster.centerZ + drift.z;
    const reach = cluster.radius * 0.7;
    let highest = world.heightAt(worldX, worldZ);
    let sum = highest;
    for (let probe = 0; probe < 4; probe++) {
      const angle = (probe / 4) * Math.PI * 2 + 0.4;
      const height = world.heightAt(worldX + Math.cos(angle) * reach, worldZ + Math.sin(angle) * reach);
      highest = Math.max(highest, height);
      sum += height;
    }
    cluster.groundReference = Math.max(CONFIG.WATER_LEVEL, sum / 5);
    cluster.baseTarget = Math.max(cluster.bandBase, highest + TERRAIN_CLEARANCE);
    cluster.groundSampled = true;
  }

  function activateCluster(cellX, cellZ, key, elapsed) {
    const cluster = clusterPool.pop() ?? createClusterRecord();
    populateCluster(cluster, cellX, cellZ);
    cluster.key = key;
    cluster.growthTarget = growthTargetFor(cluster, elapsed);
    cluster.growth = cluster.growthTarget;
    cluster.weatherTimer = WEATHER_REFRESH_SECONDS * world.hash2(cellX, cellZ, 431);
    cluster.groundTimer = GROUND_REFRESH_SECONDS * world.hash2(cellX, cellZ, 432);
    cluster.base = cluster.bandBase;
    clusterCache.set(key, cluster);
    return cluster;
  }

  function advanceCluster(cluster, dt, elapsed) {
    if (dt > 0) {
      cluster.weatherTimer -= dt;
      if (cluster.weatherTimer <= 0) {
        cluster.weatherTimer += WEATHER_REFRESH_SECONDS;
        cluster.growthTarget = growthTargetFor(cluster, elapsed);
      }
      cluster.growth = damp(cluster.growth, cluster.growthTarget, GROWTH_RATE, dt);
    }
    if (cluster.growth < 0.001 && cluster.growthTarget < 0.001) return;
    if (!cluster.groundSampled) {
      sampleGround(cluster);
      cluster.base = cluster.baseTarget;
      return;
    }
    if (dt > 0) {
      cluster.groundTimer -= dt;
      if (cluster.groundTimer <= 0) {
        cluster.groundTimer += GROUND_REFRESH_SECONDS;
        sampleGround(cluster);
      }
      cluster.base = damp(cluster.base, cluster.baseTarget, BASE_RATE, dt);
    }
  }

  // ---- Material -------------------------------------------------------------------------
  // Per puff: x = flat-bottom height in puff space, y = cluster base (world y), z = cluster top, w = brightness.
  const shapeAttribute = new T.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
  // Per puff: xyz = cluster shading centre relative to the mesh anchor, w = fade into the sky (0..1).
  const centreAttribute = new T.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
  shapeAttribute.setUsage(T.DynamicDrawUsage);
  centreAttribute.setUsage(T.DynamicDrawUsage);
  const shapeData = instancedBufferAttribute(shapeAttribute);
  const centreData = instancedBufferAttribute(centreAttribute);

  const anchorPosition = uniform(new T.Vector3());
  const litColor = uniform(new T.Color(1, 1, 1));
  const shadeColor = uniform(new T.Color(0.3, 0.33, 0.42));
  const bounceColor = uniform(new T.Color(0, 0, 0));
  const moonColor = uniform(new T.Color(0, 0, 0));
  const rimColor = uniform(new T.Color(0, 0, 0));
  const silverStrength = uniform(1);
  const hazeNear = uniform(600);
  const hazeFar = uniform(VIEW_RANGE * 1.1);

  // The stylised cloud lighting below is the whole light response: the PBR light loop is skipped.
  const material = new T.MeshStandardNodeMaterial({ flatShading: true, roughness: 1, metalness: 0, fog: false });
  material.lights = false;
  // In r184 an InstancedMesh positionNode runs on the geometry-local puff (the instance matrix is applied
  // to its result), so the flat bottom is clamped in puff space: shape.x = (base - centreY) / halfHeight.
  // Puffs only rotate about y, so local y stays vertical and the clamp plane stays horizontal.
  material.positionNode = vec3(positionLocal.x, max(positionLocal.y, shapeData.x), positionLocal.z);

  const heightFraction = saturate(positionWorld.y.sub(shapeData.y).div(max(shapeData.z.sub(shapeData.y), 1)));
  const fromCentre = positionWorld.sub(anchorPosition).sub(centreData.xyz);
  const clusterNormal = normalize(fromCentre.mul(vec3(1, CLUSTER_NORMAL_LIFT, 1)));
  const shadingNormal = normalize(mix(normalWorld, clusterNormal, SOFT_NORMAL_WEIGHT));
  const viewRay = positionView.transformDirection(cameraViewMatrix);
  const facing = saturate(dot(shadingNormal, viewRay.negate()));
  const rim = pow(oneMinus(facing), 3);
  const sunDot = dot(shadingNormal, uniforms.sunDirection);
  const sunKey = pow(saturate(sunDot.mul(0.62).add(0.38)), 1.6);
  const moonKey = saturate(dot(shadingNormal, uniforms.moonDirection).mul(0.55).add(0.45));
  const occlusion = mix(float(BASE_OCCLUSION), float(1), smoothstep(0, 0.65, heightFraction));
  const underside = saturate(shadingNormal.y.negate());
  // Brightness variation stays off the shared flat base, where overlapping puffs are coplanar.
  const brightness = mix(float(1), shapeData.w, smoothstep(0, 0.12, heightFraction));
  // Crevices: the puff-local height (raw geometry, before the base clamp) shades each puff's lower
  // half, so every heap reads as its own rounded bump. Kept off the shared flat base (coplanar puffs).
  const crevice = mix(float(1), mix(float(CREVICE_OCCLUSION), float(1), smoothstep(-0.55, 0.7, positionGeometry.y)), smoothstep(0, 0.15, heightFraction));
  const towardSun = saturate(dot(viewRay, uniforms.sunDirection));
  const backLight = pow(towardSun, 3).mul(0.45).add(pow(towardSun, 16).mul(0.9));
  const towardMoon = saturate(dot(viewRay, uniforms.moonDirection));
  const bodyLight = shadeColor.mul(occlusion).mul(mix(float(0.85), float(1), crevice))
    .add(litColor.mul(sunKey).mul(mix(occlusion, float(1), 0.35)).mul(crevice))
    .add(moonColor.mul(moonKey).mul(occlusion).mul(crevice))
    .add(bounceColor.mul(underside))
    // Light scattered forward through the cloud body when looking toward the sun.
    .add(rimColor.mul(pow(towardSun, 4).mul(0.16)));
  const rimLight = rimColor.mul(rim.mul(saturate(sunDot.mul(0.7).add(0.35))))
    .add(rimColor.mul(backLight.mul(rim.mul(0.8).add(0.2)).mul(silverStrength)))
    .add(moonColor.mul(rim.mul(moonKey.add(pow(towardMoon, 4).mul(1.6))).mul(1.4)));
  // Limb darkening on each puff's own facets outlines the heaps even when the sun is behind the viewer.
  const limb = mix(float(0.84), float(1), smoothstep(0, 0.45, saturate(dot(normalWorld, viewRay.negate()))));
  const cloudRadiance = bodyLight.mul(brightness).mul(limb).add(rimLight);

  // Haze toward the exact sky behind the cloud (the sky's own function), plus the per-cluster fade.
  const skyColorNode = ctx.systems.sky?.skyColorNode;
  const skyBehind = typeof skyColorNode === 'function'
    ? skyColorNode(viewRay)
    : mix(uniforms.fogColor, uniforms.skyZenithColor, smoothstep(0.03, 0.6, saturate(viewRay.y)));
  const cameraDistance = length(positionView);
  const haze = max(smoothstep(hazeNear, hazeFar, cameraDistance).mul(HAZE_MAX), centreData.w);
  material.colorNode = mix(cloudRadiance, skyBehind, haze);

  // Screen-door dissolve close to the camera (keeps the material opaque and sort-free).
  material.maskNode = interleavedGradientNoise(screenCoordinate.xy).lessThan(smoothstep(NEAR_DISSOLVE_START, NEAR_DISSOLVE_END, cameraDistance));

  /** Icosahedron puff with a gentle deterministic radial jitter (shared positions move together). */
  function buildPuffGeometry() {
    const geometry = new T.IcosahedronGeometry(1, 1);
    const positions = geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      const x = positions.getX(index);
      const y = positions.getY(index);
      const z = positions.getZ(index);
      const hashValue = world.hash2(Math.round(x * 1000 + z * 37), Math.round(y * 1000), 470);
      const scale = 1 + PUFF_JITTER * (hashValue * 2 - 1);
      positions.setXYZ(index, x * scale, y * scale, z * scale);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  const mesh = new T.InstancedMesh(buildPuffGeometry(), material, CAPACITY);
  mesh.name = 'clouds';
  mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  mesh.count = 0;
  // The field surrounds the camera on every side: never culled as a whole.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  // ---- In-cloud veil (camera child, drawn last) ---------------------------------------------
  const veilOpacity = uniform(0);
  const veilColor = uniform(new T.Color(1, 1, 1));
  const veilMaterial = new T.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false });
  veilMaterial.colorNode = veilColor;
  veilMaterial.opacityNode = veilOpacity;
  const veil = new T.Mesh(new T.PlaneGeometry(16, 16), veilMaterial);
  veil.name = 'cloud-veil';
  veil.position.set(0, 0, -1.25);
  veil.frustumCulled = false;
  veil.renderOrder = 1000;
  veil.visible = false;
  camera.add(veil);
  // First shown long after boot: let core compile their pipelines behind the loading fade.
  ctx.registerPrewarm?.(veil);

  // ---- Per-frame instance rebuild -------------------------------------------------------------
  const reference = new T.Vector3().copy(state.player.position);
  const instanceMatrix = new T.Matrix4();
  const instancePosition = new T.Vector3();
  const instanceQuaternion = new T.Quaternion();
  const instanceScale = new T.Vector3();
  const shapeArray = shapeAttribute.array;
  const centreArray = centreAttribute.array;
  let frameCounter = 0;
  let anchorX = 0;
  let anchorZ = 0;
  let visibleClusters = 0;
  let playerCloud = 0;
  let cameraCloud = 0;

  function writeCluster(cluster, startIndex) {
    const top = cluster.base + cluster.height * cluster.sizeScale;
    const centreX = cluster.worldX - anchorX;
    const centreY = cluster.base + cluster.height * cluster.sizeScale * 0.3;
    const centreZ = cluster.worldZ - anchorZ;
    let index = startIndex;
    for (let puff = 0; puff < cluster.puffCount && index < CAPACITY; puff++) {
      if (!resolvePuff(cluster, puff, puffScratch)) continue;
      const offset = puff * PUFF_STRIDE;
      instancePosition.set(puffScratch.x - anchorX, puffScratch.y, puffScratch.z - anchorZ);
      instanceQuaternion.set(0, cluster.puffs[offset + 5], 0, cluster.puffs[offset + 6]);
      instanceScale.set(puffScratch.radius, puffScratch.halfHeight, puffScratch.radius);
      instanceMatrix.compose(instancePosition, instanceQuaternion, instanceScale);
      mesh.setMatrixAt(index, instanceMatrix);
      const dataOffset = index * 4;
      shapeArray[dataOffset] = (cluster.base - puffScratch.y) / puffScratch.halfHeight;
      shapeArray[dataOffset + 1] = cluster.base;
      shapeArray[dataOffset + 2] = top;
      shapeArray[dataOffset + 3] = cluster.puffs[offset + 7];
      centreArray[dataOffset] = centreX;
      centreArray[dataOffset + 1] = centreY;
      centreArray[dataOffset + 2] = centreZ;
      centreArray[dataOffset + 3] = cluster.skyFade;
      index++;
    }
    return index;
  }

  function rebuildInstances(dt, elapsed) {
    const cloudCameraX = reference.x - drift.x;
    const cloudCameraZ = reference.z - drift.z;
    const centerCellX = Math.floor(cloudCameraX / CELL_SIZE);
    const centerCellZ = Math.floor(cloudCameraZ / CELL_SIZE);
    const cellLimit = VIEW_RANGE + MAX_CLUSTER_RADIUS;
    let instanceCount = 0;
    visibleClusters = 0;
    for (let cellOffsetZ = -CELL_REACH; cellOffsetZ <= CELL_REACH; cellOffsetZ++) {
      const cellZ = centerCellZ + cellOffsetZ;
      const nearestZ = clamp(cloudCameraZ, cellZ * CELL_SIZE, (cellZ + 1) * CELL_SIZE) - cloudCameraZ;
      for (let cellOffsetX = -CELL_REACH; cellOffsetX <= CELL_REACH; cellOffsetX++) {
        const cellX = centerCellX + cellOffsetX;
        const nearestX = clamp(cloudCameraX, cellX * CELL_SIZE, (cellX + 1) * CELL_SIZE) - cloudCameraX;
        if (nearestX * nearestX + nearestZ * nearestZ > cellLimit * cellLimit) continue;
        const key = clusterKey(cellX, cellZ);
        const cluster = clusterCache.get(key) ?? activateCluster(cellX, cellZ, key, elapsed);
        cluster.lastSeenFrame = frameCounter;
        advanceCluster(cluster, dt, elapsed);
        cluster.worldX = cluster.centerX + drift.x;
        cluster.worldZ = cluster.centerZ + drift.z;
        const offsetX = cluster.worldX - reference.x;
        const offsetZ = cluster.worldZ - reference.z;
        const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
        const edgeVisibility = 1 - MathUtils.smoothstep(distance, EDGE_FADE_START, VIEW_RANGE);
        cluster.visibleScale = cluster.growth * edgeVisibility;
        cluster.sizeScale = (0.6 + 0.4 * cluster.growth) * (0.8 + 0.2 * edgeVisibility);
        cluster.skyFade = Math.max(1 - edgeVisibility, 1 - MathUtils.smoothstep(cluster.growth, 0, 0.25));
        if (cluster.visibleScale < MIN_VISIBLE_SCALE || instanceCount >= CAPACITY) continue;
        visibleClusters++;
        instanceCount = writeCluster(cluster, instanceCount);
      }
    }
    mesh.count = Math.min(instanceCount, CAPACITY);
    // Upload only the live instances, not the whole 2048-instance capacity every frame.
    uploadLiveRange(mesh.instanceMatrix, 16);
    uploadLiveRange(shapeAttribute, 4);
    uploadLiveRange(centreAttribute, 4);
  }

  function uploadLiveRange(attribute, itemSize) {
    attribute.clearUpdateRanges();
    if (mesh.count === 0) return;
    attribute.addUpdateRange(0, mesh.count * itemSize);
    attribute.needsUpdate = true;
  }

  function evictDistantClusters() {
    for (const cluster of clusterCache.values()) {
      if (cluster.lastSeenFrame === frameCounter) continue;
      clusterCache.delete(cluster.key);
      clusterPool.push(cluster);
    }
  }

  // ---- Inside-cloud measure (0 outside .. 1 deep inside) ---------------------------------------
  function insideMeasure(x, y, z) {
    const cloudX = x - drift.x;
    const cloudZ = z - drift.z;
    const cellX = Math.floor(cloudX / CELL_SIZE);
    const cellZ = Math.floor(cloudZ / CELL_SIZE);
    let nearest = Infinity;
    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const cluster = clusterCache.get(clusterKey(cellX + offsetX, cellZ + offsetZ));
        if (!cluster || cluster.visibleScale < MIN_VISIBLE_SCALE) continue;
        if (y < cluster.base - 6) continue;
        const reach = cluster.radius * 1.3 + 60;
        if (Math.abs(x - cluster.worldX) > reach || Math.abs(z - cluster.worldZ) > reach) continue;
        for (let puff = 0; puff < cluster.puffCount; puff++) {
          if (!resolvePuff(cluster, puff, puffScratch)) continue;
          const dx = (x - puffScratch.x) / puffScratch.radius;
          const dy = (y - puffScratch.y) / puffScratch.halfHeight;
          const dz = (z - puffScratch.z) / puffScratch.radius;
          nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
        }
      }
    }
    if (nearest === Infinity) return 0;
    return 1 - MathUtils.smoothstep(Math.sqrt(nearest), 0.72, 1.12);
  }

  // ---- Cloud-shadow texture -------------------------------------------------------------------
  const shadowTexture = textures.cloudShadow;
  const shadowBytes = shadowTexture.image.data;
  const shadowAccumulation = new Float32Array(SHADOW_SIZE * SHADOW_SIZE);
  const shadowBorder = new Float32Array(SHADOW_SIZE);
  for (let index = 0; index < SHADOW_SIZE; index++) {
    const edgeDistance = Math.min(index, SHADOW_SIZE - 1 - index);
    shadowBorder[index] = MathUtils.smoothstep(edgeDistance, 0, SHADOW_BORDER_TEXELS);
  }
  const shadowStats = { lastMs: 0, maxValue: 0, meanValue: 0, coveredTexels: 0, puffs: 0, strength: 0 };
  let shadowTimer = 0;

  function splatEllipse(localX, localZ, alongRadius, acrossRadius, directionX, directionZ, texelSize) {
    const halfWidth = Math.sqrt(alongRadius * alongRadius * directionX * directionX + acrossRadius * acrossRadius * directionZ * directionZ);
    const halfDepth = Math.sqrt(alongRadius * alongRadius * directionZ * directionZ + acrossRadius * acrossRadius * directionX * directionX);
    const halfTexels = SHADOW_SIZE / 2;
    const minColumn = Math.max(0, Math.floor((localX - halfWidth) / texelSize + halfTexels - 0.5));
    const maxColumn = Math.min(SHADOW_SIZE - 1, Math.ceil((localX + halfWidth) / texelSize + halfTexels - 0.5));
    const minRow = Math.max(0, Math.floor((localZ - halfDepth) / texelSize + halfTexels - 0.5));
    const maxRow = Math.min(SHADOW_SIZE - 1, Math.ceil((localZ + halfDepth) / texelSize + halfTexels - 0.5));
    if (minColumn > maxColumn || minRow > maxRow) return false;
    const inverseAlong = 1 / alongRadius;
    const inverseAcross = 1 / acrossRadius;
    for (let row = minRow; row <= maxRow; row++) {
      const offsetZ = (row + 0.5 - halfTexels) * texelSize - localZ;
      for (let column = minColumn; column <= maxColumn; column++) {
        const offsetX = (column + 0.5 - halfTexels) * texelSize - localX;
        const along = (offsetX * directionX + offsetZ * directionZ) * inverseAlong;
        const across = (offsetZ * directionX - offsetX * directionZ) * inverseAcross;
        const distanceSquared = along * along + across * across;
        if (distanceSquared >= 1) continue;
        const value = (1 - MathUtils.smoothstep(Math.sqrt(distanceSquared), 0.2, 1)) * PUFF_SHADOW_DENSITY;
        const cell = row * SHADOW_SIZE + column;
        shadowAccumulation[cell] = 1 - (1 - shadowAccumulation[cell]) * (1 - value);
      }
    }
    return true;
  }

  function redrawShadows() {
    const startMs = performance.now();
    const worldSize = uniforms.cloudShadowWorldSize.value;
    const texelSize = worldSize / SHADOW_SIZE;
    const centerX = Math.round(reference.x / texelSize) * texelSize;
    const centerZ = Math.round(reference.z / texelSize) * texelSize;
    const time = state.time;
    const sun = time.sunDirection;
    const strength = SHADOW_OPACITY * MathUtils.smoothstep(time.sunElevation, 2, 14) * (1 - time.nightFactor);
    shadowAccumulation.fill(0);
    let splatted = 0;
    if (strength > 0.004) {
      const horizontalLength = Math.hypot(sun.x, sun.z);
      const directionX = horizontalLength > 1e-5 ? sun.x / horizontalLength : 1;
      const directionZ = horizontalLength > 1e-5 ? sun.z / horizontalLength : 0;
      const projection = horizontalLength / Math.max(sun.y, 0.2);
      const stretch = Math.min(2.2, 1 / Math.max(sun.y, 0.05));
      const reach = worldSize / 2 + MAX_CLUSTER_RADIUS * stretch + 100;
      for (const cluster of clusterCache.values()) {
        if (cluster.visibleScale < MIN_VISIBLE_SCALE || cluster.lastSeenFrame !== frameCounter) continue;
        const clusterHeight = Math.max(30, cluster.base + 0.5 * cluster.height - cluster.groundReference);
        const shadowX = cluster.worldX - directionX * projection * clusterHeight - centerX;
        const shadowZ = cluster.worldZ - directionZ * projection * clusterHeight - centerZ;
        if (Math.abs(shadowX) > reach || Math.abs(shadowZ) > reach) continue;
        // Clusters dissolving into the sky at the field edge cast correspondingly lighter shadows.
        const presence = 1 - cluster.skyFade;
        for (let puff = 0; puff < cluster.puffCount; puff++) {
          if (!resolvePuff(cluster, puff, puffScratch)) continue;
          const puffHeight = Math.max(30, puffScratch.y - cluster.groundReference);
          const radius = puffScratch.radius * 0.92 * Math.sqrt(presence);
          if (radius < 1) continue;
          const localX = puffScratch.x - directionX * projection * puffHeight - centerX;
          const localZ = puffScratch.z - directionZ * projection * puffHeight - centerZ;
          if (splatEllipse(localX, localZ, radius * stretch, radius, directionX, directionZ, texelSize)) splatted++;
        }
      }
    }
    let maxValue = 0;
    let sum = 0;
    let covered = 0;
    for (let row = 0; row < SHADOW_SIZE; row++) {
      const rowFade = shadowBorder[row];
      for (let column = 0; column < SHADOW_SIZE; column++) {
        const cell = row * SHADOW_SIZE + column;
        const value = Math.round(clamp(shadowAccumulation[cell] * strength * rowFade * shadowBorder[column], 0, 1) * 255);
        shadowBytes[cell * 4] = value;
        if (value > maxValue) maxValue = value;
        if (value > 8) covered++;
        sum += value;
      }
    }
    shadowTexture.needsUpdate = true;
    uniforms.cloudShadowCenter.value.set(centerX, centerZ);
    shadowStats.lastMs = performance.now() - startMs;
    shadowStats.maxValue = maxValue;
    shadowStats.meanValue = sum / (SHADOW_SIZE * SHADOW_SIZE);
    shadowStats.coveredTexels = covered;
    shadowStats.puffs = splatted;
    shadowStats.strength = strength;
  }

  // ---- Look: cloud palette keyed by sun elevation (linear scene radiance) ------------------------
  function paletteKeys(entries) {
    return entries.map(([elevation, red, green, blue]) => ({ elevation, color: new T.Color().setRGB(red, green, blue) }));
  }
  // Shadow sides: cool blue-grey by day, lavender-slate at twilight, dim navy under the moon.
  const SHADE_KEYS = paletteKeys([
    [-18, 0.02, 0.024, 0.042],
    [-9, 0.03, 0.034, 0.058],
    [-3, 0.075, 0.07, 0.11],
    [2, 0.14, 0.14, 0.19],
    [8, 0.18, 0.2, 0.27],
    [18, 0.29, 0.33, 0.41],
    [35, 0.42, 0.47, 0.56],
  ]);
  const WHITE = new T.Color(1, 1, 1);
  const MOONLIGHT = new T.Color(0.05, 0.06, 0.085);
  const lookScratch = { warm: new T.Color(), color: new T.Color() };

  function samplePalette(keys, elevation, target) {
    if (elevation <= keys[0].elevation) return target.copy(keys[0].color);
    for (let index = 1; index < keys.length; index++) {
      const upper = keys[index];
      if (elevation <= upper.elevation) {
        const lower = keys[index - 1];
        const t = MathUtils.smoothstep(elevation, lower.elevation, upper.elevation);
        return target.copy(lower.color).lerp(upper.color, t);
      }
    }
    return target.copy(keys[keys.length - 1].color);
  }

  function updateLook(realDt) {
    const time = state.time;
    const elevation = time.sunElevation;
    const sunVisibility = MathUtils.smoothstep(time.sunDirection.y, -0.03, 0.05);
    const dayness = MathUtils.smoothstep(elevation, 10, 32);
    const sunColor = uniforms.sunColor.value;
    const peak = Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4);
    // Sunlit tops: golden-white at golden hour, clean white by day.
    lookScratch.warm.setRGB(sunColor.r / peak, sunColor.g / peak, sunColor.b / peak);
    litColor.value.copy(lookScratch.warm).lerp(WHITE, 0.4 + 0.45 * dayness).multiplyScalar((LIT_GAIN - 0.18 * dayness) * sunVisibility);
    samplePalette(SHADE_KEYS, elevation, shadeColor.value);
    // A little of the sky's own tint in the shadow sides keeps them coherent with the dome.
    shadeColor.value.lerp(lookScratch.color.copy(uniforms.skyZenithColor.value).multiplyScalar(0.9), 0.12);
    // Warm light bounced up from the lit landscape under the flat bases.
    bounceColor.value.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.07 * (1 - time.nightFactor));
    // Afterglow: around sunset and sunrise the undersides take the pink horizon light instead of
    // turning slate grey, so twilight clouds read as lit cumulus rather than storm blobs.
    const afterglow = MathUtils.smoothstep(elevation, -7, -2) * (1 - MathUtils.smoothstep(elevation, 2, 6));
    if (afterglow > 0) {
      shadeColor.value.lerp(lookScratch.color.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.42), 0.5 * afterglow);
      bounceColor.value.add(lookScratch.color.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.1 * afterglow));
    }
    const moonAbove = MathUtils.smoothstep(time.moonDirection.y, 0, 0.12);
    moonColor.value.copy(MOONLIGHT).multiplyScalar(time.nightFactor * moonAbove);
    rimColor.value.copy(sunColor).multiplyScalar(0.3 + 0.85 * time.goldenFactor);
    silverStrength.value = 1.1 + 0.9 * time.goldenFactor;
    hazeNear.value = Math.max(350, scene.fog.near * 0.9);
    hazeFar.value = VIEW_RANGE * 1.1;

    const target = insideMeasure(camera.position.x, camera.position.y, camera.position.z);
    cameraCloud = damp(cameraCloud, target, target > cameraCloud ? 5 : 2.5, realDt);
    const opacity = cameraCloud * VEIL_MAX_OPACITY;
    veil.visible = opacity > 0.004;
    veilOpacity.value = opacity;
    veilColor.value.copy(shadeColor.value).multiplyScalar(1.35)
      .add(lookScratch.color.copy(litColor.value).multiplyScalar(0.35))
      .add(lookScratch.warm.copy(moonColor.value).multiplyScalar(0.8));
  }

  function updateWind(elapsed) {
    uniforms.windStrength.value = 1 + 0.1 * Math.sin(elapsed * 0.011) + 0.05 * Math.sin(elapsed * 0.037 + 1.7);
  }

  // ---- Coverage query (no side effects on the live cache) ----------------------------------------
  function coverageAt(x, z) {
    const cloudX = x - drift.x;
    const cloudZ = z - drift.z;
    const cellX = Math.floor(cloudX / CELL_SIZE);
    const cellZ = Math.floor(cloudZ / CELL_SIZE);
    const elapsed = state.time.elapsed;
    let coverage = 0;
    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        let cluster = clusterCache.get(clusterKey(cellX + offsetX, cellZ + offsetZ));
        if (!cluster) {
          cluster = scratchCluster;
          populateCluster(cluster, cellX + offsetX, cellZ + offsetZ);
          cluster.growth = growthTargetFor(cluster, elapsed);
          cluster.sizeScale = 0.6 + 0.4 * cluster.growth;
          cluster.worldX = cluster.centerX + drift.x;
          cluster.worldZ = cluster.centerZ + drift.z;
          cluster.base = cluster.bandBase;
        }
        if (cluster.growth < MIN_VISIBLE_SCALE) continue;
        for (let puff = 0; puff < cluster.puffCount; puff++) {
          if (!resolvePuff(cluster, puff, puffScratch)) continue;
          const distance = Math.hypot(x - puffScratch.x, z - puffScratch.z);
          coverage = Math.max(coverage, 1 - MathUtils.smoothstep(distance / puffScratch.radius, 0.55, 1));
        }
      }
    }
    return coverage;
  }

  function refreshReference() {
    if (state.frame > 0 && isFiniteVector(camera.position)) reference.copy(camera.position);
    else reference.copy(state.player.position);
    anchorX = Math.round(reference.x / ANCHOR_STEP) * ANCHOR_STEP;
    anchorZ = Math.round(reference.z / ANCHOR_STEP) * ANCHOR_STEP;
    mesh.position.set(anchorX, 0, anchorZ);
    anchorPosition.value.set(anchorX, 0, anchorZ);
  }

  bus.on('quality:changed', () => {
    for (const cluster of clusterCache.values()) cluster.weatherTimer = 0;
  });

  // ---- Thermal cores for the WindField: every visible cumulus caps a thermal ---------------------
  function thermalCoresNear(x, z, radius, visit) {
    const cloudX = x - drift.x;
    const cloudZ = z - drift.z;
    const reach = Math.ceil(radius / CELL_SIZE);
    const centerCellX = Math.floor(cloudX / CELL_SIZE);
    const centerCellZ = Math.floor(cloudZ / CELL_SIZE);
    for (let offsetZ = -reach; offsetZ <= reach; offsetZ++) {
      for (let offsetX = -reach; offsetX <= reach; offsetX++) {
        const cluster = clusterCache.get(clusterKey(centerCellX + offsetX, centerCellZ + offsetZ));
        if (!cluster || cluster.growth < MIN_VISIBLE_SCALE) continue;
        const coreX = cluster.centerX + drift.x;
        const coreZ = cluster.centerZ + drift.z;
        if (Math.hypot(coreX - x, coreZ - z) > radius + cluster.radius) continue;
        visit(coreX, coreZ, cluster.radius * cluster.sizeScale, cluster.base, cluster.growth);
      }
    }
  }
  if (ctx.wind) ctx.wind.setThermalProvider(thermalCoresNear);

  state.player.inCloud = 0;
  refreshReference();
  updateWind(state.time.elapsed);
  rebuildInstances(0, state.time.elapsed);
  redrawShadows();
  updateLook(1);

  return {
    mesh,
    update(dt, realDt) {
      frameCounter++;
      const elapsed = state.time.elapsed;
      updateWind(elapsed);
      const wind = uniforms.windDirection.value;
      const speed = DRIFT_SPEED * uniforms.windStrength.value;
      drift.x += wind.x * speed * dt;
      drift.z += wind.y * speed * dt;
      refreshReference();
      rebuildInstances(dt, elapsed);
      if (frameCounter % EVICT_INTERVAL_FRAMES === 0) evictDistantClusters();
      const player = state.player.position;
      const playerTarget = insideMeasure(player.x, player.y, player.z);
      playerCloud = damp(playerCloud, playerTarget, playerTarget > playerCloud ? 5 : 2.5, realDt);
      state.player.inCloud = playerCloud < 0.001 ? 0 : playerCloud;
      shadowTimer -= realDt;
      if (shadowTimer <= 0) {
        shadowTimer = SHADOW_INTERVAL_SECONDS;
        redrawShadows();
      }
      updateLook(realDt);
    },
    getCoverageAt(x, z) {
      return coverageAt(x, z);
    },
    thermalCoresNear,
    getStats() {
      return {
        clusters: visibleClusters,
        cached: clusterCache.size,
        puffs: mesh.count,
        capacity: CAPACITY,
        inCloud: Math.round(playerCloud * 100) / 100,
        coverageHere: Math.round(coverageAt(state.player.position.x, state.player.position.z) * 100) / 100,
        drift: { x: Math.round(drift.x), z: Math.round(drift.z) },
        shadow: {
          updateMs: Math.round(shadowStats.lastMs * 100) / 100,
          max: shadowStats.maxValue,
          mean: Math.round(shadowStats.meanValue * 100) / 100,
          coveredTexels: shadowStats.coveredTexels,
          puffs: shadowStats.puffs,
          strength: Math.round(shadowStats.strength * 100) / 100,
        },
      };
    },
  };
}
