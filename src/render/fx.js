import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp, damp, isFiniteVector } from '../core/util.js';
import { CONFIG } from '../core/config.js';

/**
 * FX: wingtip vapour contrails, wind streaks at speed and golden particle bursts.
 * - Contrails: two fixed-capacity ring-buffer ribbons fed by flight.getWingtips() while banking hard,
 *   pulling g or flying fast; camera-facing width that spreads with age, soft wispy edges, 2.6 s fade.
 * - Wind streaks: world-anchored air motes around the flight path drawn as thin additive motion-blur
 *   quads; they appear above ~70% of max speed and thicken during boost, or as strongly as the craft
 *   asks through state.flight.craftState.windStreaks (0..1).
 * - Bursts: instanced additive glow sprites (Sprite + PointsNodeMaterial) for boost, ring, waypoint and
 *   discovery moments. Listens to 'boost', 'ring:passed', 'waypoint:reached', 'landmark:discovered';
 *   direct burst() calls for the same moment are de-duplicated so nothing fires twice.
 * All vertex data is written relative to the camera each frame (float32-safe far from the origin).
 */
export function createFxSystem(ctx) {
  const { THREE: T, scene, camera, state, uniforms, bus, world } = ctx;
  const {
    Fn, attribute, float, vec2, vec3, mix, smoothstep, sin, pow, saturate, uv, oneMinus,
    instancedDynamicBufferAttribute, mx_noise_float, PI,
  } = TSL;

  const player = state.player;
  const MAX_SPEED = CONFIG.SPEED.MAX;
  const EVENT_GUARD_SECONDS = 0.35;
  const scratchTangent = new T.Vector3();
  const scratchToCamera = new T.Vector3();
  const scratchSide = new T.Vector3();
  const scratchDirection = new T.Vector3();
  const scratchBasisU = new T.Vector3();
  const scratchBasisW = new T.Vector3();
  const scratchPosition = new T.Vector3();

  function smooth01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Two unit vectors perpendicular to direction (and to each other). */
  function perpendicularBasis(direction, outU, outW) {
    if (Math.abs(direction.y) < 0.95) outU.set(0, 1, 0);
    else outU.set(1, 0, 0);
    outU.crossVectors(direction, outU).normalize();
    outW.crossVectors(direction, outU).normalize();
  }

  // =============================================================================================
  // CONTRAILS
  // =============================================================================================
  const CONTRAIL_CAPACITY = 240;
  const CONTRAIL_LIFE = 2.5;
  const CONTRAIL_SPACING = 1.6;
  const CONTRAIL_MAX_INTERVAL = 1 / 24;
  const CONTRAIL_THRESHOLD = 0.02;
  // Ribbon half-widths (m): ~0.3 m wide at the wingtip, spreading to ~1.5 m as the vapour ages.
  const CONTRAIL_TIP_HALF_WIDTH = 0.15;
  const CONTRAIL_END_HALF_WIDTH = 0.75;
  // Never wider on screen than ~1 degree: close to the lens the ribbon narrows instead of ballooning.
  const CONTRAIL_MAX_ANGULAR_HALF_WIDTH = 0.0085;
  // Vapour passing the chase camera dissolves before it can sweep across the view.
  const CONTRAIL_NEAR_FADE_START = 6;
  const CONTRAIL_NEAR_FADE_RANGE = 16;
  const CONTRAIL_PEAK_ALPHA = 0.42;
  // Any wingtip jump larger than this between two frames is a reposition, never flight (170 m/s x 50 ms).
  const CONTRAIL_FRAME_JUMP = 30;

  const contrailMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: T.DoubleSide,
    forceSinglePass: true,
  });
  const contrailData = attribute('trailData', 'vec3');
  contrailMaterial.colorNode = Fn(() => {
    // Vapour is lit by the sun and picks up the sky around it; kept below the bloom threshold.
    const sunlit = mix(vec3(0.84, 0.86, 0.9), uniforms.sunColor.mul(0.82), 0.3);
    const skyLit = mix(sunlit, uniforms.skyHorizonColor, 0.18);
    return mix(skyLit, vec3(0.42, 0.49, 0.66), uniforms.nightFactor.mul(0.85));
  })();
  contrailMaterial.opacityNode = Fn(() => {
    const across = contrailData.y;
    const edge = pow(saturate(float(1).sub(across.mul(across))), 1.8);
    const wisps = mx_noise_float(vec2(contrailData.z.mul(0.07), across.mul(0.9))).mul(0.3).add(0.8);
    return saturate(contrailData.x.mul(edge).mul(wisps));
  })();

  function createTrail() {
    const pointCapacity = CONTRAIL_CAPACITY + 2;
    const vertexCount = pointCapacity * 2;
    const positions = new Float32Array(vertexCount * 3);
    const trailData = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex++) normals[vertex * 3 + 1] = 1;
    const indices = new Uint32Array((pointCapacity - 1) * 6);
    for (let segment = 0; segment < pointCapacity - 1; segment++) {
      const base = segment * 2;
      indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], segment * 6);
    }
    const geometry = new T.BufferGeometry();
    const positionAttribute = new T.BufferAttribute(positions, 3).setUsage(T.DynamicDrawUsage);
    const dataAttribute = new T.BufferAttribute(trailData, 3).setUsage(T.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
    geometry.setAttribute('trailData', dataAttribute);
    geometry.setIndex(new T.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new T.Sphere(new T.Vector3(), 1);
    const mesh = new T.Mesh(geometry, contrailMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.visible = false;
    mesh.name = 'contrail';
    scene.add(mesh);
    ctx.registerPrewarm?.(mesh);
    return {
      mesh,
      geometry,
      positionAttribute,
      dataAttribute,
      positions,
      trailData,
      sampleX: new Float64Array(CONTRAIL_CAPACITY),
      sampleY: new Float64Array(CONTRAIL_CAPACITY),
      sampleZ: new Float64Array(CONTRAIL_CAPACITY),
      driftX: new Float32Array(CONTRAIL_CAPACITY),
      driftY: new Float32Array(CONTRAIL_CAPACITY),
      driftZ: new Float32Array(CONTRAIL_CAPACITY),
      birth: new Float64Array(CONTRAIL_CAPACITY),
      strength: new Float32Array(CONTRAIL_CAPACITY),
      along: new Float64Array(CONTRAIL_CAPACITY),
      head: 0,
      count: 0,
      emitting: false,
      driftPhase: Math.random() * Math.PI * 2,
      lastEmitTime: -1,
      hasLastTip: false,
      lastTip: new T.Vector3(),
      pointX: new Float64Array(pointCapacity),
      pointY: new Float64Array(pointCapacity),
      pointZ: new Float64Array(pointCapacity),
      pointAge: new Float32Array(pointCapacity),
      pointStrength: new Float32Array(pointCapacity),
      pointAlong: new Float64Array(pointCapacity),
    };
  }

  const trails = [createTrail(), createTrail()];
  let contrailClock = 0;
  let contrailStrength = 0;

  function newestSampleIndex(trail) {
    return (trail.head + trail.count - 1) % CONTRAIL_CAPACITY;
  }

  /** Distance from a wingtip to one stored sample (sqrt of sums: Math.hypot boxes its arguments). */
  function tipDistanceToSample(trail, index, tip) {
    const dx = tip.x - trail.sampleX[index];
    const dy = tip.y - trail.sampleY[index];
    const dz = tip.z - trail.sampleZ[index];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function pushSample(trail, tip, strength) {
    let index;
    let along = 0;
    if (trail.count > 0) {
      const last = newestSampleIndex(trail);
      along = trail.along[last] + tipDistanceToSample(trail, last, tip);
    }
    if (trail.count < CONTRAIL_CAPACITY) {
      index = (trail.head + trail.count) % CONTRAIL_CAPACITY;
      trail.count++;
    } else {
      index = trail.head;
      trail.head = (trail.head + 1) % CONTRAIL_CAPACITY;
    }
    trail.sampleX[index] = tip.x;
    trail.sampleY[index] = tip.y;
    trail.sampleZ[index] = tip.z;
    // Drift varies smoothly along the trail, so the vapour billows instead of jittering.
    trail.driftX[index] = Math.sin(along * 0.045 + trail.driftPhase) * 0.45;
    trail.driftY[index] = -0.32 - 0.18 * Math.sin(along * 0.061 + trail.driftPhase * 1.7);
    trail.driftZ[index] = Math.cos(along * 0.038 + trail.driftPhase * 2.3) * 0.45;
    trail.birth[index] = contrailClock;
    trail.strength[index] = strength;
    trail.along[index] = along % 65536;
    trail.lastEmitTime = contrailClock;
  }

  function resetTrail(trail) {
    trail.head = 0;
    trail.count = 0;
    trail.emitting = false;
  }

  /** Detects repositioning (resetTo, teleports, respawns) so no ribbon ever spans the jump. */
  function trackTip(trail, tip) {
    if (!tip) {
      trail.hasLastTip = false;
      return;
    }
    if (trail.hasLastTip && trail.lastTip.distanceToSquared(tip) > CONTRAIL_FRAME_JUMP * CONTRAIL_FRAME_JUMP) resetTrail(trail);
    trail.lastTip.copy(tip);
    trail.hasLastTip = true;
  }

  function emitTrail(trail, tip, strength) {
    while (trail.count > 0 && contrailClock - trail.birth[trail.head] > CONTRAIL_LIFE) {
      trail.head = (trail.head + 1) % CONTRAIL_CAPACITY;
      trail.count--;
    }
    if (!tip) {
      // Tips unavailable: close the ribbon softly instead of leaving it attached to a stale point.
      trail.emitting = false;
      return;
    }
    if (strength > CONTRAIL_THRESHOLD) {
      if (!trail.emitting) {
        pushSample(trail, tip, 0);
        trail.emitting = true;
        return;
      }
      const last = newestSampleIndex(trail);
      const distance = tipDistanceToSample(trail, last, tip);
      if (distance > CONTRAIL_SPACING || contrailClock - trail.lastEmitTime > CONTRAIL_MAX_INTERVAL) pushSample(trail, tip, strength);
    } else if (trail.emitting) {
      pushSample(trail, tip, 0);
      trail.emitting = false;
    }
  }

  function gatherTrailPoints(trail, tip) {
    let points = 0;
    for (let offset = 0; offset < trail.count; offset++) {
      const index = (trail.head + offset) % CONTRAIL_CAPACITY;
      const age = contrailClock - trail.birth[index];
      trail.pointX[points] = trail.sampleX[index] + trail.driftX[index] * age;
      trail.pointY[points] = trail.sampleY[index] + trail.driftY[index] * age;
      trail.pointZ[points] = trail.sampleZ[index] + trail.driftZ[index] * age;
      trail.pointAge[points] = age;
      trail.pointStrength[points] = trail.strength[index];
      trail.pointAlong[points] = trail.along[index];
      points++;
    }
    if (trail.emitting && tip && trail.count > 0) {
      const last = newestSampleIndex(trail);
      trail.pointX[points] = tip.x;
      trail.pointY[points] = tip.y;
      trail.pointZ[points] = tip.z;
      trail.pointAge[points] = 0;
      trail.pointStrength[points] = contrailStrength;
      trail.pointAlong[points] = (trail.along[last] + tipDistanceToSample(trail, last, tip)) % 65536;
      points++;
    }
    return points;
  }

  function renderTrail(trail, tip) {
    const points = gatherTrailPoints(trail, tip);
    if (points < 2) {
      trail.mesh.visible = false;
      return;
    }
    const cameraPosition = camera.position;
    trail.mesh.position.copy(cameraPosition);
    // Fallback side for degenerate points (zero tangent, or tangent pointing straight at the lens).
    scratchBasisU.set(1, 0, 0).applyQuaternion(camera.quaternion);
    let previousSideX = scratchBasisU.x;
    let previousSideY = scratchBasisU.y;
    let previousSideZ = scratchBasisU.z;
    for (let point = 0; point < points; point++) {
      const previous = Math.max(point - 1, 0);
      const next = Math.min(point + 1, points - 1);
      scratchTangent.set(
        trail.pointX[next] - trail.pointX[previous],
        trail.pointY[next] - trail.pointY[previous],
        trail.pointZ[next] - trail.pointZ[previous],
      );
      scratchToCamera.set(
        cameraPosition.x - trail.pointX[point],
        cameraPosition.y - trail.pointY[point],
        cameraPosition.z - trail.pointZ[point],
      );
      const distanceToCamera = scratchToCamera.length();
      const tangentLength = scratchTangent.length();
      scratchSide.crossVectors(scratchTangent, scratchToCamera);
      // |side| = |tangent| |toCamera| sin(angle): below ~0.5 degrees the direction is numerically noise.
      if (scratchSide.length() <= tangentLength * distanceToCamera * 0.01 || tangentLength < 1e-4) {
        scratchSide.set(previousSideX, previousSideY, previousSideZ);
      } else {
        scratchSide.normalize();
        if (scratchSide.x * previousSideX + scratchSide.y * previousSideY + scratchSide.z * previousSideZ < 0) scratchSide.negate();
      }
      previousSideX = scratchSide.x;
      previousSideY = scratchSide.y;
      previousSideZ = scratchSide.z;
      const ageRatio = clamp(trail.pointAge[point] / CONTRAIL_LIFE, 0, 1);
      const spreadWidth = CONTRAIL_TIP_HALF_WIDTH + (CONTRAIL_END_HALF_WIDTH - CONTRAIL_TIP_HALF_WIDTH) * Math.pow(ageRatio, 0.75);
      const halfWidth = Math.max(0.02, Math.min(spreadWidth, distanceToCamera * CONTRAIL_MAX_ANGULAR_HALF_WIDTH));
      const headRamp = 0.25 + 0.75 * smooth01(trail.pointAge[point] / 0.16);
      const nearFade = smooth01((distanceToCamera - CONTRAIL_NEAR_FADE_START) / CONTRAIL_NEAR_FADE_RANGE);
      const alpha = trail.pointStrength[point] * CONTRAIL_PEAK_ALPHA * Math.pow(1 - ageRatio, 1.6) * headRamp * nearFade;
      const centerX = trail.pointX[point] - cameraPosition.x;
      const centerY = trail.pointY[point] - cameraPosition.y;
      const centerZ = trail.pointZ[point] - cameraPosition.z;
      const vertex = point * 2;
      trail.positions[vertex * 3] = centerX + scratchSide.x * halfWidth;
      trail.positions[vertex * 3 + 1] = centerY + scratchSide.y * halfWidth;
      trail.positions[vertex * 3 + 2] = centerZ + scratchSide.z * halfWidth;
      trail.positions[vertex * 3 + 3] = centerX - scratchSide.x * halfWidth;
      trail.positions[vertex * 3 + 4] = centerY - scratchSide.y * halfWidth;
      trail.positions[vertex * 3 + 5] = centerZ - scratchSide.z * halfWidth;
      trail.trailData[vertex * 3] = alpha;
      trail.trailData[vertex * 3 + 1] = -1;
      trail.trailData[vertex * 3 + 2] = trail.pointAlong[point];
      trail.trailData[vertex * 3 + 3] = alpha;
      trail.trailData[vertex * 3 + 4] = 1;
      trail.trailData[vertex * 3 + 5] = trail.pointAlong[point];
    }
    trail.positionAttribute.needsUpdate = true;
    trail.dataAttribute.needsUpdate = true;
    trail.geometry.setDrawRange(0, (points - 1) * 6);
    trail.mesh.visible = true;
  }

  function contrailTargetStrength() {
    const bank = smooth01((Math.abs(player.roll) - 45) / 25);
    const pull = smooth01((player.gForce - 1.6) / 1.1);
    const fast = smooth01((player.speed - 0.85 * MAX_SPEED) / (0.15 * MAX_SPEED));
    return Math.max(bank, pull, fast);
  }

  function updateContrails(dt) {
    const flight = ctx.systems.flight;
    const tips = typeof flight?.getWingtips === 'function' ? flight.getWingtips() : null;
    const validTips = Array.isArray(tips) && tips.length >= 2 && isFiniteVector(tips[0]) && isFiniteVector(tips[1]);
    for (let side = 0; side < 2; side++) trackTip(trails[side], validTips ? tips[side] : null);
    if (dt > 0) {
      contrailClock += dt;
      contrailStrength = damp(contrailStrength, validTips ? contrailTargetStrength() : 0, 7, dt);
      for (let side = 0; side < 2; side++) emitTrail(trails[side], validTips ? tips[side] : null, contrailStrength);
    }
    for (let side = 0; side < 2; side++) renderTrail(trails[side], validTips ? tips[side] : null);
  }

  // =============================================================================================
  // WIND STREAKS
  // =============================================================================================
  const STREAK_CAPACITY = 120;
  const streakPositions = new Float32Array(STREAK_CAPACITY * 4 * 3);
  const streakData = new Float32Array(STREAK_CAPACITY * 4 * 3);
  const streakNormals = new Float32Array(STREAK_CAPACITY * 4 * 3);
  const streakIndices = new Uint32Array(STREAK_CAPACITY * 6);
  for (let streak = 0; streak < STREAK_CAPACITY; streak++) {
    const vertex = streak * 4;
    streakIndices.set([vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2], streak * 6);
    const corners = [[0, -1], [0, 1], [1, -1], [1, 1]];
    for (let corner = 0; corner < 4; corner++) {
      streakData[(vertex + corner) * 3] = corners[corner][0];
      streakData[(vertex + corner) * 3 + 1] = corners[corner][1];
      streakNormals[(vertex + corner) * 3 + 1] = 1;
    }
  }
  const streakGeometry = new T.BufferGeometry();
  const streakPositionAttribute = new T.BufferAttribute(streakPositions, 3).setUsage(T.DynamicDrawUsage);
  const streakDataAttribute = new T.BufferAttribute(streakData, 3).setUsage(T.DynamicDrawUsage);
  streakGeometry.setAttribute('position', streakPositionAttribute);
  streakGeometry.setAttribute('normal', new T.BufferAttribute(streakNormals, 3));
  streakGeometry.setAttribute('streakData', streakDataAttribute);
  streakGeometry.setIndex(new T.BufferAttribute(streakIndices, 1));
  streakGeometry.setDrawRange(0, 0);
  streakGeometry.boundingSphere = new T.Sphere(new T.Vector3(), 1);

  const streakMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    side: T.DoubleSide,
    forceSinglePass: true,
    fog: false,
  });
  const streakAttribute = attribute('streakData', 'vec3');
  streakMaterial.colorNode = mix(vec3(1.0, 0.94, 0.84), vec3(0.62, 0.72, 1.0), uniforms.nightFactor).mul(1.25);
  streakMaterial.opacityNode = Fn(() => {
    const along = streakAttribute.x;
    const across = streakAttribute.y;
    const taper = pow(saturate(sin(along.mul(PI))), 1.3).mul(oneMinus(smoothstep(0.55, 1.0, along)).mul(0.5).add(0.5));
    const edge = saturate(float(1).sub(across.mul(across)));
    return saturate(streakAttribute.z.mul(taper).mul(edge));
  })();
  const streakMesh = new T.Mesh(streakGeometry, streakMaterial);
  streakMesh.frustumCulled = false;
  streakMesh.renderOrder = 5;
  streakMesh.visible = false;
  streakMesh.name = 'wind-streaks';
  scene.add(streakMesh);
  // First shown long after boot: let core compile their pipelines behind the loading fade.
  ctx.registerPrewarm?.(streakMesh);

  const streakX = new Float64Array(STREAK_CAPACITY);
  const streakY = new Float64Array(STREAK_CAPACITY);
  const streakZ = new Float64Array(STREAK_CAPACITY);
  const streakSeed = new Float32Array(STREAK_CAPACITY);
  let streakIntensity = 0;
  let streaksSeeded = false;

  function placeStreak(index, direction, basisU, basisW, minAhead, maxAhead) {
    const ahead = minAhead + Math.random() * (maxAhead - minAhead);
    const radius = 5 + Math.sqrt(Math.random()) * 34;
    const angle = Math.random() * Math.PI * 2;
    const cameraPosition = camera.position;
    const radialU = Math.cos(angle) * radius;
    const radialW = Math.sin(angle) * radius;
    streakX[index] = cameraPosition.x + direction.x * ahead + basisU.x * radialU + basisW.x * radialW;
    streakY[index] = cameraPosition.y + direction.y * ahead + basisU.y * radialU + basisW.y * radialW;
    streakZ[index] = cameraPosition.z + direction.z * ahead + basisU.z * radialU + basisW.z * radialW;
    streakSeed[index] = Math.random();
  }

  function updateStreaks(realDt) {
    const speedRatio = player.speed / MAX_SPEED;
    const boosting = player.boost && player.boost.active ? 1 : 0;
    // A craft may ask for streaks below v1's speeds (the wingsuit: speed and terrain proximity cue).
    const craftCue = clamp(Number(state.flight?.craftState?.windStreaks) || 0, 0, 1);
    const target = state.photoMode ? 0 : Math.min(1.25, Math.max(smooth01((speedRatio - 0.7) / 0.3) * 0.8, craftCue) + boosting * 0.55);
    streakIntensity = damp(streakIntensity, target, 2.5, realDt);
    if (streakIntensity < 0.01) {
      streakMesh.visible = false;
      streaksSeeded = false;
      return;
    }
    scratchDirection.copy(player.velocity);
    if (scratchDirection.lengthSq() < 1) scratchDirection.copy(player.forward);
    scratchDirection.normalize();
    perpendicularBasis(scratchDirection, scratchBasisU, scratchBasisW);
    if (!streaksSeeded) {
      for (let index = 0; index < STREAK_CAPACITY; index++) placeStreak(index, scratchDirection, scratchBasisU, scratchBasisW, 4, 170);
      streaksSeeded = true;
    }
    const cameraPosition = camera.position;
    streakMesh.position.copy(cameraPosition);
    const activeCount = Math.round(STREAK_CAPACITY * clamp(0.45 + streakIntensity * 0.5, 0, 1));
    const streakLength = Math.max(player.speed, 20) * 0.075;
    for (let index = 0; index < activeCount; index++) {
      let relativeX = streakX[index] - cameraPosition.x;
      let relativeY = streakY[index] - cameraPosition.y;
      let relativeZ = streakZ[index] - cameraPosition.z;
      let along = relativeX * scratchDirection.x + relativeY * scratchDirection.y + relativeZ * scratchDirection.z;
      let radialSq = relativeX * relativeX + relativeY * relativeY + relativeZ * relativeZ - along * along;
      if (along < -6 || along > 190 || radialSq > 60 * 60) {
        placeStreak(index, scratchDirection, scratchBasisU, scratchBasisW, 110, 170);
        relativeX = streakX[index] - cameraPosition.x;
        relativeY = streakY[index] - cameraPosition.y;
        relativeZ = streakZ[index] - cameraPosition.z;
        along = relativeX * scratchDirection.x + relativeY * scratchDirection.y + relativeZ * scratchDirection.z;
        radialSq = relativeX * relativeX + relativeY * relativeY + relativeZ * relativeZ - along * along;
      }
      const distance = Math.sqrt(relativeX * relativeX + relativeY * relativeY + relativeZ * relativeZ);
      const seed = streakSeed[index];
      const length = streakLength * (0.7 + 0.6 * seed);
      const halfWidth = Math.max(0.035 + 0.03 * seed, distance * 0.0016);
      scratchToCamera.set(-relativeX, -relativeY, -relativeZ);
      scratchSide.crossVectors(scratchDirection, scratchToCamera);
      if (scratchSide.lengthSq() < 1e-8) scratchSide.copy(scratchBasisU);
      scratchSide.normalize().multiplyScalar(halfWidth);
      // Streaks read at the edges of the view; near the vanishing point they would only clutter.
      const fadeFar = 1 - smooth01((along - 70) / 80);
      const fadeNear = smooth01((distance - 4) / 12);
      const offAxis = along > 0.5 ? Math.sqrt(Math.max(radialSq, 0)) / along : 4;
      const fadeCentre = smooth01((offAxis - 0.12) / 0.32);
      const alpha = streakIntensity * (0.1 + 0.15 * seed) * fadeFar * fadeNear * fadeCentre;
      const endX = relativeX + scratchDirection.x * length;
      const endY = relativeY + scratchDirection.y * length;
      const endZ = relativeZ + scratchDirection.z * length;
      const base = index * 12;
      streakPositions[base] = relativeX - scratchSide.x;
      streakPositions[base + 1] = relativeY - scratchSide.y;
      streakPositions[base + 2] = relativeZ - scratchSide.z;
      streakPositions[base + 3] = relativeX + scratchSide.x;
      streakPositions[base + 4] = relativeY + scratchSide.y;
      streakPositions[base + 5] = relativeZ + scratchSide.z;
      streakPositions[base + 6] = endX - scratchSide.x;
      streakPositions[base + 7] = endY - scratchSide.y;
      streakPositions[base + 8] = endZ - scratchSide.z;
      streakPositions[base + 9] = endX + scratchSide.x;
      streakPositions[base + 10] = endY + scratchSide.y;
      streakPositions[base + 11] = endZ + scratchSide.z;
      streakData[base + 2] = alpha;
      streakData[base + 5] = alpha;
      streakData[base + 8] = alpha;
      streakData[base + 11] = alpha;
    }
    streakPositionAttribute.needsUpdate = true;
    streakDataAttribute.needsUpdate = true;
    streakGeometry.setDrawRange(0, activeCount * 6);
    streakMesh.visible = activeCount > 0;
  }

  // =============================================================================================
  // BURSTS
  // =============================================================================================
  const PARTICLE_CAPACITY = 768;
  const particleOffsets = new Float32Array(PARTICLE_CAPACITY * 3);
  const particleTints = new Float32Array(PARTICLE_CAPACITY * 4);
  const particleShapes = new Float32Array(PARTICLE_CAPACITY * 2);
  const offsetAttribute = new T.InstancedBufferAttribute(particleOffsets, 3).setUsage(T.DynamicDrawUsage);
  const tintAttribute = new T.InstancedBufferAttribute(particleTints, 4).setUsage(T.DynamicDrawUsage);
  const shapeAttribute = new T.InstancedBufferAttribute(particleShapes, 2).setUsage(T.DynamicDrawUsage);
  const particleTint = instancedDynamicBufferAttribute(tintAttribute, 'vec4');
  const particleShape = instancedDynamicBufferAttribute(shapeAttribute, 'vec2');

  const particleMaterial = new T.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    fog: false,
    sizeAttenuation: true,
  });
  particleMaterial.positionNode = instancedDynamicBufferAttribute(offsetAttribute, 'vec3');
  particleMaterial.sizeNode = particleShape.x;
  const particleRadial = uv().sub(0.5).mul(2).length();
  particleMaterial.colorNode = Fn(() => {
    const core = pow(saturate(float(1).sub(particleRadial.mul(2.2))), 2.0).mul(0.8);
    return particleTint.rgb.mul(core.add(0.6));
  })();
  particleMaterial.opacityNode = Fn(() => {
    const glow = pow(saturate(float(1).sub(particleRadial)), 2.2);
    const twinkle = sin(uniforms.time.mul(17.0).add(particleShape.y.mul(40.0))).mul(0.28).add(0.78);
    return saturate(particleTint.a.mul(glow).mul(twinkle));
  })();
  const particleSprite = new T.Sprite(particleMaterial);
  particleSprite.count = 0;
  particleSprite.frustumCulled = false;
  particleSprite.renderOrder = 6;
  particleSprite.visible = false;
  particleSprite.name = 'fx-bursts';
  scene.add(particleSprite);
  ctx.registerPrewarm?.(particleSprite);

  const particleX = new Float64Array(PARTICLE_CAPACITY);
  const particleY = new Float64Array(PARTICLE_CAPACITY);
  const particleZ = new Float64Array(PARTICLE_CAPACITY);
  const particleVelocityX = new Float32Array(PARTICLE_CAPACITY);
  const particleVelocityY = new Float32Array(PARTICLE_CAPACITY);
  const particleVelocityZ = new Float32Array(PARTICLE_CAPACITY);
  const particleAge = new Float32Array(PARTICLE_CAPACITY);
  const particleLife = new Float32Array(PARTICLE_CAPACITY);
  const particleSize = new Float32Array(PARTICLE_CAPACITY);
  const particleDrag = new Float32Array(PARTICLE_CAPACITY);
  const particleLift = new Float32Array(PARTICLE_CAPACITY);
  const particleRed = new Float32Array(PARTICLE_CAPACITY);
  const particleGreen = new Float32Array(PARTICLE_CAPACITY);
  const particleBlue = new Float32Array(PARTICLE_CAPACITY);
  const particleSeed = new Float32Array(PARTICLE_CAPACITY);
  let particleCursor = 0;
  let liveParticles = 0;

  // Linear HDR colours (bloom picks up the > 1 values).
  const PALETTE = {
    gold: [1.0, 0.64, 0.2],
    honey: [1.0, 0.8, 0.46],
    amber: [1.0, 0.42, 0.1],
    cream: [1.0, 0.9, 0.72],
    teal: [0.3, 0.86, 0.9],
  };
  // boost: a compact golden shock ring that expands around the tail and travels with the glider.
  const BURST_STYLES = {
    boost: { count: 56, shape: 'ring', speed: [5, 11], back: [1, 3], inherit: 0.97, life: [0.5, 0.95], size: [0.45, 0.9], drag: 2.2, lift: 0.3, intensity: 1.5, colors: ['gold', 'amber', 'honey'] },
    ring: { count: 84, shape: 'sphere', speed: [13, 27], back: [0, 0], inherit: 0, life: [0.9, 1.7], size: [2.2, 4.0], drag: 1.35, lift: 1.5, intensity: 1.5, colors: ['gold', 'amber', 'gold', 'honey'] },
    waypoint: { count: 96, shape: 'fountain', speed: [14, 42], back: [0, 0], inherit: 0, life: [1.3, 2.4], size: [2.6, 4.6], drag: 0.8, lift: -7, intensity: 1.7, colors: ['gold', 'honey', 'amber'] },
    discovery: { count: 120, shape: 'halo', speed: [2, 7], back: [0, 0], inherit: 0, life: [2.2, 3.6], size: [1.8, 3.6], drag: 0.45, lift: 3.5, intensity: 1.5, colors: ['gold', 'honey', 'cream', 'teal'] },
  };
  // Slow lingering sparkle layered under the ring flash (not a public burst type).
  const RING_GLITTER = { count: 26, shape: 'sphere', speed: [2, 7], back: [0, 0], inherit: 0, life: [1.8, 2.8], size: [2.0, 3.2], drag: 0.6, lift: 2.2, intensity: 1.4, colors: ['gold', 'honey', 'amber'] };
  // Sparks right in front of the lens shrink and fade instead of blooming into large blobs.
  const PARTICLE_NEAR_SHRINK_DISTANCE = 16;
  const PARTICLE_NEAR_FADE_START = 1.5;
  const PARTICLE_NEAR_FADE_RANGE = 6;

  function randomRange(range) {
    return range[0] + Math.random() * (range[1] - range[0]);
  }

  function claimParticle() {
    for (let attempt = 0; attempt < PARTICLE_CAPACITY; attempt++) {
      const index = particleCursor;
      particleCursor = (particleCursor + 1) % PARTICLE_CAPACITY;
      if (particleLife[index] <= 0) return index;
    }
    const index = particleCursor;
    particleCursor = (particleCursor + 1) % PARTICLE_CAPACITY;
    return index;
  }

  function spawnParticle(style, originX, originY, originZ, velocityX, velocityY, velocityZ) {
    const index = claimParticle();
    const colorKey = style.colors[Math.floor(Math.random() * style.colors.length)];
    const tint = PALETTE[colorKey];
    const intensity = style.intensity * (0.75 + Math.random() * 0.5);
    particleX[index] = originX;
    particleY[index] = originY;
    particleZ[index] = originZ;
    particleVelocityX[index] = velocityX;
    particleVelocityY[index] = velocityY;
    particleVelocityZ[index] = velocityZ;
    particleAge[index] = 0;
    particleLife[index] = randomRange(style.life);
    particleSize[index] = randomRange(style.size);
    particleDrag[index] = style.drag * (0.8 + Math.random() * 0.4);
    particleLift[index] = style.lift;
    particleRed[index] = tint[0] * intensity;
    particleGreen[index] = tint[1] * intensity;
    particleBlue[index] = tint[2] * intensity;
    particleSeed[index] = Math.random();
  }

  function randomUnitVector(target) {
    const z = Math.random() * 2 - 1;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(1 - z * z);
    return target.set(Math.cos(angle) * radius, z, Math.sin(angle) * radius);
  }

  function spawnBurst(type, x, y, z, options) {
    const style = BURST_STYLES[type] || BURST_STYLES.ring;
    const inherit = options && Number.isFinite(options.inherit) ? options.inherit : style.inherit;
    const count = Math.round(style.count * (options && Number.isFinite(options.countScale) ? options.countScale : 1));
    scratchDirection.copy(player.velocity);
    if (scratchDirection.lengthSq() < 1) scratchDirection.copy(player.forward);
    scratchDirection.normalize();
    perpendicularBasis(scratchDirection, scratchBasisU, scratchBasisW);
    for (let particle = 0; particle < count; particle++) {
      const speed = randomRange(style.speed);
      let originX = x;
      let originY = y;
      let originZ = z;
      if (style.shape === 'ring') {
        const angle = (particle / count) * Math.PI * 2 + Math.random() * 0.2;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const back = randomRange(style.back);
        scratchPosition.set(
          (scratchBasisU.x * cosine + scratchBasisW.x * sine) * speed - scratchDirection.x * back,
          (scratchBasisU.y * cosine + scratchBasisW.y * sine) * speed - scratchDirection.y * back,
          (scratchBasisU.z * cosine + scratchBasisW.z * sine) * speed - scratchDirection.z * back,
        );
      } else if (style.shape === 'fountain') {
        const angle = Math.random() * Math.PI * 2;
        const spread = 3 + Math.random() * 8;
        scratchPosition.set(Math.cos(angle) * spread, speed, Math.sin(angle) * spread);
      } else if (style.shape === 'halo') {
        randomUnitVector(scratchPosition);
        const radius = 6 + Math.random() * 16;
        originX += scratchPosition.x * radius;
        originY += scratchPosition.y * radius * 0.6;
        originZ += scratchPosition.z * radius;
        scratchPosition.multiplyScalar(speed);
        scratchPosition.y += 1.5 + Math.random() * 3;
      } else {
        randomUnitVector(scratchPosition).multiplyScalar(speed);
      }
      spawnParticle(
        style,
        originX,
        originY,
        originZ,
        scratchPosition.x + player.velocity.x * inherit,
        scratchPosition.y + player.velocity.y * inherit,
        scratchPosition.z + player.velocity.z * inherit,
      );
    }
    if (type === 'ring') {
      // A slower inner glitter that lingers after the main flash.
      for (let particle = 0; particle < RING_GLITTER.count; particle++) {
        randomUnitVector(scratchPosition).multiplyScalar(randomRange(RING_GLITTER.speed));
        spawnParticle(RING_GLITTER, x, y, z, scratchPosition.x, scratchPosition.y, scratchPosition.z);
      }
    }
  }

  function updateParticles(dt) {
    const cameraPosition = camera.position;
    particleSprite.position.copy(cameraPosition);
    let written = 0;
    for (let index = 0; index < PARTICLE_CAPACITY; index++) {
      if (particleLife[index] <= 0) continue;
      if (dt > 0) {
        particleAge[index] += dt;
        if (particleAge[index] >= particleLife[index]) {
          particleLife[index] = 0;
          continue;
        }
        const dragFactor = Math.exp(-particleDrag[index] * dt);
        particleVelocityX[index] *= dragFactor;
        particleVelocityY[index] = particleVelocityY[index] * dragFactor + particleLift[index] * dt;
        particleVelocityZ[index] *= dragFactor;
        particleX[index] += particleVelocityX[index] * dt;
        particleY[index] += particleVelocityY[index] * dt;
        particleZ[index] += particleVelocityZ[index] * dt;
      }
      const offsetX = particleX[index] - cameraPosition.x;
      const offsetY = particleY[index] - cameraPosition.y;
      const offsetZ = particleZ[index] - cameraPosition.z;
      const distanceToCamera = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
      const nearScale = clamp(distanceToCamera / PARTICLE_NEAR_SHRINK_DISTANCE, 0.25, 1);
      const nearFade = smooth01((distanceToCamera - PARTICLE_NEAR_FADE_START) / PARTICLE_NEAR_FADE_RANGE);
      const lifeRatio = particleAge[index] / particleLife[index];
      const fadeIn = Math.min(1, particleAge[index] * 14);
      const alpha = fadeIn * Math.pow(1 - lifeRatio, 1.5) * nearFade;
      const size = particleSize[index] * (0.45 + 0.55 * Math.sqrt(lifeRatio)) * (1 - 0.35 * lifeRatio) * nearScale;
      particleOffsets[written * 3] = offsetX;
      particleOffsets[written * 3 + 1] = offsetY;
      particleOffsets[written * 3 + 2] = offsetZ;
      particleTints[written * 4] = particleRed[index];
      particleTints[written * 4 + 1] = particleGreen[index];
      particleTints[written * 4 + 2] = particleBlue[index];
      particleTints[written * 4 + 3] = alpha;
      particleShapes[written * 2] = size;
      particleShapes[written * 2 + 1] = particleSeed[index];
      written++;
    }
    liveParticles = written;
    particleSprite.count = written;
    particleSprite.visible = written > 0;
    if (written > 0) {
      offsetAttribute.needsUpdate = true;
      tintAttribute.needsUpdate = true;
      shapeAttribute.needsUpdate = true;
    }
  }

  // ---- Burst requests: events are queued and flushed in update(); a direct burst() call for the
  // same moment (another module celebrating the same event) suppresses the duplicate. -----------
  const pendingBursts = [];
  const lastDirectBurst = {};
  const recentEventBursts = [];

  function resolvePosition(position, fallback, target) {
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) {
      return target.set(position.x, position.y, position.z);
    }
    return target.copy(fallback);
  }

  function queueEventBurst(type, x, y, z, options) {
    if (pendingBursts.length > 16) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    pendingBursts.push({ type, x, y, z, options: options || null });
  }

  function flushPendingBursts() {
    const now = state.time.realElapsed;
    while (recentEventBursts.length > 0 && now - recentEventBursts[0].time > EVENT_GUARD_SECONDS) recentEventBursts.shift();
    for (const request of pendingBursts) {
      const directTime = lastDirectBurst[request.type];
      if (directTime !== undefined && now - directTime < EVENT_GUARD_SECONDS) continue;
      spawnBurst(request.type, request.x, request.y, request.z, request.options);
      recentEventBursts.push({ type: request.type, x: request.x, y: request.y, z: request.z, time: now });
    }
    pendingBursts.length = 0;
  }

  function isDuplicateOfEventBurst(type, position) {
    const now = state.time.realElapsed;
    for (const recent of recentEventBursts) {
      if (recent.type !== type || now - recent.time > EVENT_GUARD_SECONDS) continue;
      if (Math.hypot(recent.x - position.x, recent.y - position.y, recent.z - position.z) < 80) return true;
    }
    return false;
  }

  const burstPosition = new T.Vector3();

  bus.on('boost', () => {
    const tail = scratchPosition.copy(player.forward).multiplyScalar(-5).add(player.position);
    queueEventBurst('boost', tail.x, tail.y, tail.z);
  });
  bus.on('ring:passed', (payload) => {
    const position = resolvePosition(payload && payload.position, player.position, burstPosition);
    queueEventBurst('ring', position.x, position.y, position.z);
  });
  bus.on('waypoint:reached', (payload) => {
    const x = payload && Number.isFinite(payload.x) ? payload.x : player.position.x;
    const z = payload && Number.isFinite(payload.z) ? payload.z : player.position.z;
    queueEventBurst('waypoint', x, player.position.y, z);
  });
  bus.on('landmark:discovered', (payload) => {
    const site = payload && payload.site;
    if (!site || !Number.isFinite(site.x) || !Number.isFinite(site.z)) return;
    const ground = Math.max(world.groundHeight(site.x, site.z), CONFIG.WATER_LEVEL);
    const y = site.type === 'balloons' ? player.position.y : ground + 32;
    queueEventBurst('discovery', site.x, y, site.z);
    // A lighter halo that travels with the glider, so the moment is seen whatever the view.
    const halo = scratchPosition.copy(player.forward).multiplyScalar(26).add(player.position);
    queueEventBurst('discovery', halo.x, halo.y + 2, halo.z, { inherit: 0.94, countScale: 0.55 });
  });

  return {
    update(dt, realDt) {
      flushPendingBursts();
      updateContrails(dt);
      updateStreaks(realDt);
      updateParticles(dt);
    },
    burst(type, position) {
      const kind = typeof type === 'string' && BURST_STYLES[type] ? type : 'ring';
      const target = resolvePosition(position, player.position, burstPosition);
      lastDirectBurst[kind] = state.time.realElapsed;
      if (isDuplicateOfEventBurst(kind, target)) return false;
      spawnBurst(kind, target.x, target.y, target.z);
      return true;
    },
    getStats() {
      return {
        particles: liveParticles,
        contrailPoints: trails[0].count + trails[1].count,
        contrailStrength: Math.round(contrailStrength * 100) / 100,
        streakIntensity: Math.round(streakIntensity * 100) / 100,
      };
    },
  };
}
