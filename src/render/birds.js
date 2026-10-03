import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp } from '../core/util.js';
import { CONFIG } from '../core/config.js';

/**
 * BIRDS: boid flocks drifting over the landscape.
 * One InstancedMesh (body + two wings, flat-shaded dark warm silhouettes). The wing flap runs in the
 * vertex shader: a per-instance phase from instanceIndex plus ctx.uniforms.time, with glide pauses,
 * and a CPU-driven excitement channel that makes scattered birds flap hard. Flocks spawn ahead of the
 * glider, follow a slowly wandering target, keep clear of the terrain, scatter outward/upward when the
 * glider passes through them (emitting 'birds:scattered'), regroup, and recycle once far behind.
 * While any source holds the typed wildlifeQuiet (a total solar eclipse), the flocks settle out of the
 * sky: none spawn, the flying ones fade away over a few seconds and stop scattering, and they return
 * (fading in ahead of the glider) once the last hold ends.
 */
export function createBirdSystem(ctx) {
  const { THREE: T, scene, state, world, bus, uniforms } = ctx;
  const {
    Fn, sin, cos, abs, sign, max, min, mix, smoothstep, hash, color,
    instanceIndex, positionGeometry, positionLocal, instancedDynamicBufferAttribute, TWO_PI,
  } = TSL;

  const FLOCK_SLOTS = 6;
  const BIRDS_PER_SLOT = 40;
  const CAPACITY = FLOCK_SLOTS * BIRDS_PER_SLOT;
  const WING_HINGE = 0.06;
  const MIN_SPEED = 9;
  const MAX_SPEED = 16;
  const SEPARATION_RADIUS = 4.5;
  const NEIGHBOR_RADIUS = 16;
  const SCATTER_TRIGGER_DISTANCE = 70;
  const SCATTER_RADIUS = 90;
  const RECYCLE_DISTANCE = 2500;
  const MIN_AGL = 40;
  const MAX_AGL = 220;
  const FLOOR_MARGIN = 15;
  const GRAVITY = 9.81;
  // Ground probes: each live bird re-probes about every 0.4 s, looking 1.6 s ahead; the 3-sample
  // rendered-mesh probe is only needed within PRECISE_FLOOR_CLEARANCE of the floor.
  const GROUND_REFRESH_SECONDS = 0.4;
  const GROUND_LOOK_AHEAD_SECONDS = 1.6;
  const PRECISE_FLOOR_CLEARANCE = 70;
  const MAX_GROUND_SAMPLES_PER_FRAME = 16;
  const SPAWN_FADE_SECONDS = 1.6;
  /** Seconds the flocks take to settle out of the sky when the wildlife falls quiet. */
  const QUIET_FADE_SECONDS = 4;
  const player = state.player;

  // ---- Geometry: a low-poly gull-like silhouette, nose toward -z, wings along x --------------
  function buildBirdGeometry() {
    const vertices = [];
    const addTriangle = (a, b, c) => { vertices.push(...a, ...b, ...c); };
    const nose = [0, 0.02, -0.52];
    const crown = [0, 0.09, -0.12];
    const belly = [0, -0.08, -0.08];
    const flankLeft = [-0.055, 0, -0.12];
    const flankRight = [0.055, 0, -0.12];
    const rump = [0, 0.02, 0.34];
    addTriangle(nose, flankRight, crown);
    addTriangle(nose, crown, flankLeft);
    addTriangle(nose, belly, flankRight);
    addTriangle(nose, flankLeft, belly);
    addTriangle(rump, crown, flankRight);
    addTriangle(rump, flankLeft, crown);
    addTriangle(rump, flankRight, belly);
    addTriangle(rump, belly, flankLeft);
    addTriangle([0, 0.02, 0.24], [-0.13, 0.02, 0.56], [0.13, 0.02, 0.56]);
    for (const side of [-1, 1]) {
      const rootFront = [side * WING_HINGE, 0.02, -0.15];
      const rootBack = [side * WING_HINGE, 0.02, 0.15];
      const wristFront = [side * 0.46, 0.02, -0.1];
      const wristBack = [side * 0.42, 0.02, 0.19];
      const tip = [side * 0.97, 0.02, 0.17];
      const primaryBack = [side * 0.72, 0.02, 0.27];
      addTriangle(rootFront, rootBack, wristFront);
      addTriangle(wristFront, rootBack, wristBack);
      addTriangle(wristFront, wristBack, tip);
      addTriangle(wristBack, primaryBack, tip);
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(vertices), 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  // ---- Mesh + material --------------------------------------------------------------------------
  const geometry = buildBirdGeometry();
  const material = new T.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0, flatShading: true, side: T.DoubleSide });
  const mesh = new T.InstancedMesh(geometry, material, CAPACITY);
  mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  mesh.instanceMatrix.array.fill(0);
  mesh.count = CAPACITY;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.boundingSphere = new T.Sphere(new T.Vector3(), 1);
  mesh.name = 'birds';

  // Per-instance bird axes in mesh space (the instance matrix's scaled right/up columns) plus flap
  // state: right.w = extra wing phase (accumulated on the CPU so rate changes stay continuous),
  // up.w = excitement 0..1 (scattered birds flap hard and never glide). The built-in instancing
  // places each bird; the shader adds the bird-local wing displacement along these axes.
  const axisRightData = new Float32Array(CAPACITY * 4);
  const axisUpData = new Float32Array(CAPACITY * 4);
  const axisRightAttribute = new T.InstancedBufferAttribute(axisRightData, 4).setUsage(T.DynamicDrawUsage);
  const axisUpAttribute = new T.InstancedBufferAttribute(axisUpData, 4).setUsage(T.DynamicDrawUsage);
  const birdRight = instancedDynamicBufferAttribute(axisRightAttribute, 'vec4');
  const birdUp = instancedDynamicBufferAttribute(axisUpAttribute, 'vec4');

  material.positionNode = Fn(() => {
    const local = positionGeometry;
    const rateSeed = hash(instanceIndex);
    const phaseSeed = hash(instanceIndex.add(7919));
    const time = uniforms.time;
    const excitement = birdUp.w;
    const glideWave = sin(time.mul(mix(0.21, 0.38, rateSeed)).add(phaseSeed.mul(TWO_PI)));
    const flapGate = max(smoothstep(-0.5, 0.0, glideWave), excitement);
    const phase = time.mul(mix(12.5, 16.5, rateSeed)).add(phaseSeed.mul(TWO_PI)).add(birdRight.w);
    const stroke = sin(phase).add(sin(phase.mul(2)).mul(0.2));
    const flapAngle = stroke.mul(mix(0.6, 0.82, excitement)).add(0.1);
    const glideAngle = sin(time.mul(1.2).add(rateSeed.mul(40))).mul(0.035).add(0.14);
    const wingAngle = mix(glideAngle, flapAngle, flapGate);
    const radial = abs(local.x);
    const span = max(radial.sub(WING_HINGE), 0);
    const bend = wingAngle.mul(smoothstep(0.3, 0.9, span).mul(0.55).add(1));
    const bentX = sign(local.x).mul(min(radial, WING_HINGE).add(span.mul(cos(bend))));
    const bodyBob = sin(phase).mul(-0.035).mul(flapGate);
    const liftY = span.mul(sin(bend)).add(bodyBob);
    return positionLocal.add(birdRight.xyz.mul(bentX.sub(local.x))).add(birdUp.xyz.mul(liftY));
  })();
  // Warm dark plumage per bird, darker primaries toward the wingtips.
  const plumage = mix(color(0x3a2b24), color(0x5e4a3d), hash(instanceIndex.add(311)));
  material.colorNode = mix(plumage, color(0x1a1310), smoothstep(0.5, 0.9, abs(positionGeometry.x)));
  scene.add(mesh);

  // ---- Simulation state (structure of arrays, doubles for world positions) ----------------------
  const positionX = new Float64Array(CAPACITY);
  const positionY = new Float64Array(CAPACITY);
  const positionZ = new Float64Array(CAPACITY);
  const velocityX = new Float64Array(CAPACITY);
  const velocityY = new Float64Array(CAPACITY);
  const velocityZ = new Float64Array(CAPACITY);
  const fleeX = new Float32Array(CAPACITY);
  const fleeY = new Float32Array(CAPACITY);
  const fleeZ = new Float32Array(CAPACITY);
  const bankAngle = new Float32Array(CAPACITY);
  const groundBelow = new Float32Array(CAPACITY);
  const excitementLevel = new Float32Array(CAPACITY);
  const extraPhase = new Float32Array(CAPACITY);
  const birdScale = new Float32Array(CAPACITY);
  let groundCursor = 0;
  let simulationTime = 0;
  let lastWrittenFrame = -1;
  // wildlifeQuiet holders (spawn ids) and the fade the flocks share while they settle (1 = flying).
  const quietSources = new Set();
  let quietFade = 1;

  const flocks = [];
  for (let slot = 0; slot < FLOCK_SLOTS; slot++) {
    flocks.push({
      slot,
      active: false,
      retiring: false,
      start: slot * BIRDS_PER_SLOT,
      count: 0,
      age: 0,
      seed: Math.random(),
      heading: 0,
      cruiseSpeed: 12,
      preferredAgl: 90,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      targetGround: 0,
      groundTimer: 0,
      scatterCooldown: 0,
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      radius: 0,
      fade: 0,
    });
  }

  function smooth01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Analytic terrain (or water) height: cheap enough for flock-level look-ahead probes. */
  function surfaceHeight(x, z) {
    return Math.max(world.heightAt(x, z), CONFIG.WATER_LEVEL);
  }

  /** Height of the rendered ground mesh (or water) under a bird: the floor birds must stay above. */
  function renderedSurfaceHeight(x, z) {
    return Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  }

  function targetFlockCount() {
    if (quietSources.size > 0) return 0;
    const density = Number.isFinite(ctx.quality.birdDensity) ? ctx.quality.birdDensity : 1;
    return clamp(3 + Math.floor(density * 3), 3, FLOCK_SLOTS);
  }

  function playerHeadingRadians() {
    const velocity = player.velocity;
    const horizontal = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (horizontal > 1) return Math.atan2(velocity.x, -velocity.z);
    return Math.atan2(player.forward.x, -player.forward.z);
  }

  // ---- Flock spawning -----------------------------------------------------------------------------
  function spawnFlock(flock, nearStart) {
    const density = Number.isFinite(ctx.quality.birdDensity) ? ctx.quality.birdDensity : 1;
    const playerHeading = playerHeadingRadians();
    const ahead = nearStart || Math.random() < 0.8;
    const bearing = ahead ? playerHeading + (Math.random() * 2 - 1) * (nearStart ? 0.5 : 1.15) : Math.random() * Math.PI * 2;
    const distance = nearStart ? 380 + Math.random() * 260 : 650 + Math.random() * 850;
    const x = player.position.x + Math.sin(bearing) * distance;
    const z = player.position.z - Math.cos(bearing) * distance;
    const ground = surfaceHeight(x, z);
    const playerAgl = player.position.y - ground;
    const matchPlayer = nearStart || Math.random() < 0.45;
    const agl = matchPlayer
      ? clamp(playerAgl + (Math.random() * 2 - 1) * 30, MIN_AGL, MAX_AGL)
      : MIN_AGL + Math.random() * (MAX_AGL - MIN_AGL);
    const y = ground + agl;
    flock.active = true;
    flock.retiring = false;
    flock.age = 0;
    flock.seed = Math.random();
    flock.count = clamp(Math.round((18 + Math.random() * 22) * density), 10, BIRDS_PER_SLOT);
    flock.cruiseSpeed = 11 + Math.random() * 3.5;
    flock.preferredAgl = agl;
    flock.heading = bearing + Math.PI * 0.5 * (Math.random() < 0.5 ? 1 : -1) + (Math.random() - 0.5) * 1.2;
    flock.scatterCooldown = 0;
    flock.groundTimer = 0;
    flock.targetGround = ground;
    flock.centerX = x;
    flock.centerY = y;
    flock.centerZ = z;
    flock.radius = 14;
    const directionX = Math.sin(flock.heading);
    const directionZ = -Math.cos(flock.heading);
    for (let index = flock.start; index < flock.start + BIRDS_PER_SLOT; index++) {
      const inFlock = index < flock.start + flock.count;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * 14;
      positionX[index] = x + Math.cos(angle) * radius;
      positionY[index] = y + (Math.random() - 0.5) * 8;
      positionZ[index] = z + Math.sin(angle) * radius;
      const speed = flock.cruiseSpeed * (0.9 + Math.random() * 0.2);
      velocityX[index] = directionX * speed;
      velocityY[index] = 0;
      velocityZ[index] = directionZ * speed;
      bankAngle[index] = 0;
      groundBelow[index] = ground;
      excitementLevel[index] = 0;
      extraPhase[index] = 0;
      birdScale[index] = inFlock ? 1.0 + Math.random() * 0.32 : 0;
    }
  }

  function deactivateFlock(flock) {
    flock.active = false;
    flock.retiring = false;
    flock.count = 0;
  }

  function rebalanceFlocks() {
    const wanted = targetFlockCount();
    let activeCount = 0;
    for (const flock of flocks) if (flock.active && !flock.retiring) activeCount++;
    if (activeCount > wanted) {
      for (let slot = FLOCK_SLOTS - 1; slot >= 0 && activeCount > wanted; slot--) {
        if (flocks[slot].active && !flocks[slot].retiring) {
          flocks[slot].retiring = true;
          activeCount--;
        }
      }
    } else if (activeCount < wanted) {
      for (const flock of flocks) {
        if (activeCount >= wanted) break;
        if (flock.active && flock.retiring) {
          flock.retiring = false;
          activeCount++;
        } else if (!flock.active) {
          spawnFlock(flock, false);
          activeCount++;
        }
      }
    }
  }

  // ---- Boids ----------------------------------------------------------------------------------------
  // Hot-loop rule: per-bird helpers take only integer indices and object references and write their
  // results into typed-array scratch, so no double is ever boxed and the per-bird loop allocates
  // nothing (Math.hypot is avoided for the same reason: its arguments are boxed on every call).
  const NEIGHBOR_SEPARATION = 0;
  const NEIGHBOR_ALIGNMENT = 3;
  const NEIGHBOR_COHESION = 6;
  const NEIGHBOR_COUNT = 9;
  const neighborhood = new Float64Array(10);
  const steering = new Float64Array(3);
  const SEPARATION_RADIUS_SQ = SEPARATION_RADIUS * SEPARATION_RADIUS;
  const NEIGHBOR_RADIUS_SQ = NEIGHBOR_RADIUS * NEIGHBOR_RADIUS;
  let stepSeconds = 0;
  let stepExcitementDecay = 1;
  let stepBankBlend = 0;
  let groundProbeBudget = 0;

  /** Probes the ground under and ahead of one bird; the rendered-mesh probe is used only near the floor. */
  function probeGroundBelow(index) {
    const x = positionX[index];
    const z = positionZ[index];
    const ahead = surfaceHeight(x + velocityX[index] * GROUND_LOOK_AHEAD_SECONDS, z + velocityZ[index] * GROUND_LOOK_AHEAD_SECONDS);
    // groundHeight costs three analytic samples. High above the floor the analytic height is within a
    // few metres of the mesh, far inside the cushion, so the single-sample probe is enough there.
    const nearFloor = positionY[index] - groundBelow[index] < PRECISE_FLOOR_CLEARANCE;
    const below = nearFloor ? renderedSurfaceHeight(x, z) : surfaceHeight(x, z);
    groundBelow[index] = Math.max(below, ahead);
  }

  function activeBirdCount() {
    let count = 0;
    for (const flock of flocks) if (flock.active) count += flock.count;
    return count;
  }

  /** Re-probes the ground under each live bird about every GROUND_REFRESH_SECONDS (frame-rate independent). */
  function refreshGroundSamples(dt) {
    groundProbeBudget = Math.min(groundProbeBudget + (activeBirdCount() * dt) / GROUND_REFRESH_SECONDS, MAX_GROUND_SAMPLES_PER_FRAME);
    for (let visited = 0; visited < CAPACITY && groundProbeBudget >= 1; visited++) {
      groundCursor = (groundCursor + 1) % CAPACITY;
      const flock = flocks[Math.floor(groundCursor / BIRDS_PER_SLOT)];
      if (!flock.active || groundCursor >= flock.start + flock.count) continue;
      probeGroundBelow(groundCursor);
      groundProbeBudget -= 1;
    }
  }

  function updateFlockCenter(flock) {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const end = flock.start + flock.count;
    for (let index = flock.start; index < end; index++) {
      sumX += positionX[index];
      sumY += positionY[index];
      sumZ += positionZ[index];
    }
    flock.centerX = sumX / flock.count;
    flock.centerY = sumY / flock.count;
    flock.centerZ = sumZ / flock.count;
    let radiusSq = 0;
    for (let index = flock.start; index < end; index++) {
      const dx = positionX[index] - flock.centerX;
      const dy = positionY[index] - flock.centerY;
      const dz = positionZ[index] - flock.centerZ;
      radiusSq = Math.max(radiusSq, dx * dx + dy * dy + dz * dz);
    }
    flock.radius = Math.sqrt(radiusSq) + 2;
  }

  function updateFlockTarget(flock, dt) {
    const wander = Math.sin(simulationTime * 0.071 + flock.seed * 13.7) * 0.11 + Math.sin(simulationTime * 0.023 + flock.seed * 41.3) * 0.07;
    flock.heading += wander * dt;
    const directionX = Math.sin(flock.heading);
    const directionZ = -Math.cos(flock.heading);
    flock.groundTimer -= dt;
    if (flock.groundTimer <= 0) {
      flock.groundTimer = 0.5 + Math.random() * 0.3;
      const nearGround = surfaceHeight(flock.centerX + directionX * 80, flock.centerZ + directionZ * 80);
      const farGround = surfaceHeight(flock.centerX + directionX * 220, flock.centerZ + directionZ * 220);
      flock.targetGround = Math.max(nearGround, farGround * 0.85 + nearGround * 0.15);
    }
    flock.targetX = flock.centerX + directionX * 70;
    flock.targetZ = flock.centerZ + directionZ * 70;
    flock.targetY = flock.targetGround + flock.preferredAgl;
  }

  /** 1 for a calm bird, down to 0.15 while fully excited (flocking rules loosen during a scatter). */
  function calmness(index) {
    return 1 - 0.85 * excitementLevel[index];
  }

  /** Sums separation push, neighbour velocity and neighbour offset within NEIGHBOR_RADIUS. */
  function gatherNeighbors(index, start, end) {
    neighborhood.fill(0);
    const x = positionX[index];
    const y = positionY[index];
    const z = positionZ[index];
    for (let other = start; other < end; other++) {
      if (other === index) continue;
      const dx = positionX[other] - x;
      const dy = positionY[other] - y;
      const dz = positionZ[other] - z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > NEIGHBOR_RADIUS_SQ) continue;
      if (distanceSq < SEPARATION_RADIUS_SQ && distanceSq > 1e-6) {
        const distance = Math.sqrt(distanceSq);
        const push = (1 - distance / SEPARATION_RADIUS) / distance;
        neighborhood[NEIGHBOR_SEPARATION] -= dx * push;
        neighborhood[NEIGHBOR_SEPARATION + 1] -= dy * push;
        neighborhood[NEIGHBOR_SEPARATION + 2] -= dz * push;
      }
      neighborhood[NEIGHBOR_ALIGNMENT] += velocityX[other];
      neighborhood[NEIGHBOR_ALIGNMENT + 1] += velocityY[other];
      neighborhood[NEIGHBOR_ALIGNMENT + 2] += velocityZ[other];
      neighborhood[NEIGHBOR_COHESION] += dx;
      neighborhood[NEIGHBOR_COHESION + 1] += dy;
      neighborhood[NEIGHBOR_COHESION + 2] += dz;
      neighborhood[NEIGHBOR_COUNT] += 1;
    }
  }

  /** Separation, alignment and cohesion from the gathered neighbourhood, plus a loose pull to the centre. */
  function steerWithFlock(index, flock) {
    const calm = calmness(index);
    steering[0] = neighborhood[NEIGHBOR_SEPARATION] * 14;
    steering[1] = neighborhood[NEIGHBOR_SEPARATION + 1] * 14;
    steering[2] = neighborhood[NEIGHBOR_SEPARATION + 2] * 14;
    const neighbors = neighborhood[NEIGHBOR_COUNT];
    if (neighbors > 0) {
      steering[0] += (neighborhood[NEIGHBOR_ALIGNMENT] / neighbors - velocityX[index]) * 1.4 * calm + (neighborhood[NEIGHBOR_COHESION] / neighbors) * 0.16 * calm;
      steering[1] += (neighborhood[NEIGHBOR_ALIGNMENT + 1] / neighbors - velocityY[index]) * 1.4 * calm + (neighborhood[NEIGHBOR_COHESION + 1] / neighbors) * 0.16 * calm;
      steering[2] += (neighborhood[NEIGHBOR_ALIGNMENT + 2] / neighbors - velocityZ[index]) * 1.4 * calm + (neighborhood[NEIGHBOR_COHESION + 2] / neighbors) * 0.16 * calm;
    }
    // Loose pull toward the flock centre keeps stragglers from drifting off.
    steering[0] += (flock.centerX - positionX[index]) * 0.012 * calm;
    steering[1] += (flock.centerY - positionY[index]) * 0.012 * calm;
    steering[2] += (flock.centerZ - positionZ[index]) * 0.012 * calm;
  }

  /** Seek the wandering flock target at cruise speed (half strength vertically). */
  function steerTowardTarget(index, flock) {
    const calm = calmness(index);
    const toTargetX = flock.targetX - positionX[index];
    const toTargetY = flock.targetY - positionY[index];
    const toTargetZ = flock.targetZ - positionZ[index];
    const toTargetLength = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY + toTargetZ * toTargetZ) || 1;
    const desiredScale = flock.cruiseSpeed / toTargetLength;
    steering[0] += (toTargetX * desiredScale - velocityX[index]) * 0.55 * calm;
    steering[1] += (toTargetY * desiredScale * 0.5 - velocityY[index]) * 0.55 * calm;
    steering[2] += (toTargetZ * desiredScale - velocityZ[index]) * 0.55 * calm;
  }

  /** Flee along the scatter direction while excited. */
  function steerAwayFromGlider(index) {
    const excitement = excitementLevel[index];
    if (excitement <= 0.01) return;
    const fleeStrength = 18 * excitement;
    steering[0] += fleeX[index] * fleeStrength;
    steering[1] += fleeY[index] * fleeStrength;
    steering[2] += fleeZ[index] * fleeStrength;
  }

  /** Terrain avoidance: climb when inside a soft 25 m cushion above ground + FLOOR_MARGIN. */
  function steerAboveTerrain(index) {
    const cushion = groundBelow[index] + FLOOR_MARGIN + 25 - positionY[index];
    if (cushion > 0) steering[1] += cushion * 0.9;
  }

  function limitSteering(index) {
    const lengthSq = steering[0] * steering[0] + steering[1] * steering[1] + steering[2] * steering[2];
    const limit = 12 + 22 * excitementLevel[index];
    if (lengthSq <= limit * limit) return;
    const scale = limit / Math.sqrt(lengthSq);
    steering[0] *= scale;
    steering[1] *= scale;
    steering[2] *= scale;
  }

  /** Applies the steering to velocity (climb and speed limits), banks into the turn and moves the bird. */
  function integrateBird(index) {
    const dt = stepSeconds;
    const excitement = excitementLevel[index];
    let vx = velocityX[index] + steering[0] * dt;
    let vy = velocityY[index] + steering[1] * dt;
    let vz = velocityZ[index] + steering[2] * dt;
    const climbLimit = 4.5 + 7 * excitement;
    vy = clamp(vy, -climbLimit, climbLimit);
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    const clampedSpeed = clamp(speed, MIN_SPEED, MAX_SPEED + 14 * excitement);
    if (clampedSpeed !== speed) {
      const scale = clampedSpeed / speed;
      vx *= scale;
      vy *= scale;
      vz *= scale;
    }
    // Bank into turns: lateral acceleration against the horizontal right vector.
    const horizontal = Math.sqrt(vx * vx + vz * vz) || 1;
    const lateral = (steering[0] * -vz + steering[2] * vx) / horizontal;
    const targetBank = clamp(Math.atan2(lateral, GRAVITY), -1.05, 1.05);
    bankAngle[index] += (targetBank - bankAngle[index]) * stepBankBlend;
    velocityX[index] = vx;
    velocityY[index] = vy;
    velocityZ[index] = vz;
    positionX[index] += vx * dt;
    positionY[index] += vy * dt;
    positionZ[index] += vz * dt;
    const floor = groundBelow[index] + FLOOR_MARGIN;
    if (positionY[index] < floor) {
      positionY[index] = floor;
      if (velocityY[index] < 1) velocityY[index] = 1;
    }
    excitementLevel[index] = excitement * stepExcitementDecay;
    extraPhase[index] = (extraPhase[index] + excitement * 11 * dt) % (Math.PI * 2);
  }

  function simulateFlock(flock, dt) {
    stepSeconds = dt;
    stepExcitementDecay = Math.exp(-dt / 2.4);
    // Same blend as damp(bank, target, 3.5, dt), computed once per frame.
    stepBankBlend = 1 - Math.exp(-3.5 * dt);
    const start = flock.start;
    const end = start + flock.count;
    for (let index = start; index < end; index++) {
      gatherNeighbors(index, start, end);
      steerWithFlock(index, flock);
      steerTowardTarget(index, flock);
      steerAwayFromGlider(index);
      steerAboveTerrain(index);
      limitSteering(index);
      integrateBird(index);
    }
  }

  // ---- Scatter when the glider passes through ---------------------------------------------------------
  const pathDirection = new T.Vector3();

  function tryScatter(flock) {
    if (flock.scatterCooldown > 0) return;
    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    const reach = flock.radius + SCATTER_TRIGGER_DISTANCE;
    const centerDx = flock.centerX - px;
    const centerDy = flock.centerY - py;
    const centerDz = flock.centerZ - pz;
    if (centerDx * centerDx + centerDy * centerDy + centerDz * centerDz > reach * reach) return;
    const start = flock.start;
    const end = start + flock.count;
    const triggerSq = SCATTER_TRIGGER_DISTANCE * SCATTER_TRIGGER_DISTANCE;
    let triggered = false;
    for (let index = start; index < end && !triggered; index++) {
      const dx = positionX[index] - px;
      const dy = positionY[index] - py;
      const dz = positionZ[index] - pz;
      if (dx * dx + dy * dy + dz * dz < triggerSq) triggered = true;
    }
    if (!triggered) return;
    pathDirection.copy(player.velocity);
    if (pathDirection.lengthSq() < 1) pathDirection.copy(player.forward);
    pathDirection.normalize();
    const scatterSq = SCATTER_RADIUS * SCATTER_RADIUS;
    let fled = 0;
    let fleeSumX = 0;
    let fleeSumZ = 0;
    for (let index = start; index < end; index++) {
      const dx = positionX[index] - px;
      const dy = positionY[index] - py;
      const dz = positionZ[index] - pz;
      if (dx * dx + dy * dy + dz * dz > scatterSq) {
        excitementLevel[index] = Math.max(excitementLevel[index], 0.35);
        continue;
      }
      const along = dx * pathDirection.x + dy * pathDirection.y + dz * pathDirection.z;
      let perpX = dx - pathDirection.x * along;
      let perpY = dy - pathDirection.y * along;
      let perpZ = dz - pathDirection.z * along;
      let perpLength = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
      if (perpLength < 0.5) {
        const angle = Math.random() * Math.PI * 2;
        perpX = Math.cos(angle) * -pathDirection.z;
        perpY = Math.sin(angle) * 0.5;
        perpZ = Math.cos(angle) * pathDirection.x;
        perpLength = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ) || 1;
      }
      const forwardShare = (along >= 0 ? 0.3 : -0.15);
      let directionX = perpX / perpLength + pathDirection.x * forwardShare + (Math.random() - 0.5) * 0.45;
      let directionY = perpY / perpLength + 0.75 + Math.random() * 0.4;
      let directionZ = perpZ / perpLength + pathDirection.z * forwardShare + (Math.random() - 0.5) * 0.45;
      const directionLength = Math.sqrt(directionX * directionX + directionY * directionY + directionZ * directionZ) || 1;
      directionX /= directionLength;
      directionY /= directionLength;
      directionZ /= directionLength;
      fleeX[index] = directionX;
      fleeY[index] = directionY;
      fleeZ[index] = directionZ;
      const burstSpeed = 21 + Math.random() * 7;
      velocityX[index] = velocityX[index] * 0.25 + directionX * burstSpeed;
      velocityY[index] = velocityY[index] * 0.25 + directionY * burstSpeed * 0.6;
      velocityZ[index] = velocityZ[index] * 0.25 + directionZ * burstSpeed;
      excitementLevel[index] = 1;
      fleeSumX += directionX;
      fleeSumZ += directionZ;
      fled++;
    }
    flock.scatterCooldown = 4;
    if (fled === 0) return;
    // The flock regroups away from the glider's path.
    if (fleeSumX * fleeSumX + fleeSumZ * fleeSumZ > 0.01) flock.heading = Math.atan2(fleeSumX, -fleeSumZ);
    flock.preferredAgl = clamp(flock.preferredAgl + 25, MIN_AGL, MAX_AGL);
    bus.emit('birds:scattered', {
      count: fled,
      position: { x: flock.centerX, y: flock.centerY, z: flock.centerZ },
    });
  }

  // ---- Instance matrices ------------------------------------------------------------------------------
  // Floating origin near the player keeps instance translations small (float32-safe far from 0,0).
  const origin = new T.Vector3();
  const matrixArray = mesh.instanceMatrix.array;

  function hideBirdInstance(offset, axisOffset) {
    matrixArray.fill(0, offset, offset + 16);
    axisRightData.fill(0, axisOffset, axisOffset + 3);
    axisUpData.fill(0, axisOffset, axisOffset + 3);
  }

  /** Writes one bird's instance matrix (velocity-aligned, banked) and its flap axes/state. */
  function writeBirdMatrix(index, flock) {
    const offset = index * 16;
    const axisOffset = index * 4;
    const inFlock = flock.active && index < flock.start + flock.count;
    const scale = inFlock ? birdScale[index] * flock.fade * quietFade : 0;
    axisRightData[axisOffset + 3] = extraPhase[index];
    axisUpData[axisOffset + 3] = inFlock ? excitementLevel[index] : 0;
    if (scale <= 0) {
      hideBirdInstance(offset, axisOffset);
      return;
    }
    const vx = velocityX[index];
    const vy = velocityY[index];
    const vz = velocityZ[index];
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    const forwardX = vx / speed;
    const forwardY = vy / speed;
    const forwardZ = vz / speed;
    const horizontal = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ) || 1e-6;
    const baseRightX = -forwardZ / horizontal;
    const baseRightZ = forwardX / horizontal;
    // up0 = right0 x forward
    const baseUpX = -forwardY * baseRightZ;
    const baseUpY = baseRightZ * forwardX - baseRightX * forwardZ;
    const baseUpZ = baseRightX * forwardY;
    const bank = bankAngle[index];
    const cosBank = Math.cos(bank);
    const sinBank = Math.sin(bank);
    const rightX = baseRightX * cosBank - baseUpX * sinBank;
    const rightY = -baseUpY * sinBank;
    const rightZ = baseRightZ * cosBank - baseUpZ * sinBank;
    const upX = baseUpX * cosBank + baseRightX * sinBank;
    const upY = baseUpY * cosBank;
    const upZ = baseUpZ * cosBank + baseRightZ * sinBank;
    matrixArray[offset] = rightX * scale;
    matrixArray[offset + 1] = rightY * scale;
    matrixArray[offset + 2] = rightZ * scale;
    matrixArray[offset + 3] = 0;
    matrixArray[offset + 4] = upX * scale;
    matrixArray[offset + 5] = upY * scale;
    matrixArray[offset + 6] = upZ * scale;
    matrixArray[offset + 7] = 0;
    matrixArray[offset + 8] = -forwardX * scale;
    matrixArray[offset + 9] = -forwardY * scale;
    matrixArray[offset + 10] = -forwardZ * scale;
    matrixArray[offset + 11] = 0;
    matrixArray[offset + 12] = positionX[index] - origin.x;
    matrixArray[offset + 13] = positionY[index] - origin.y;
    matrixArray[offset + 14] = positionZ[index] - origin.z;
    matrixArray[offset + 15] = 1;
    axisRightData[axisOffset] = matrixArray[offset];
    axisRightData[axisOffset + 1] = matrixArray[offset + 1];
    axisRightData[axisOffset + 2] = matrixArray[offset + 2];
    axisUpData[axisOffset] = matrixArray[offset + 4];
    axisUpData[axisOffset + 1] = matrixArray[offset + 5];
    axisUpData[axisOffset + 2] = matrixArray[offset + 6];
  }

  /** Bounding sphere (mesh-local) around every active flock; returns the number of active flocks. */
  function updateBirdBounds() {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let activeFlocks = 0;
    for (const flock of flocks) {
      if (!flock.active) continue;
      sumX += flock.centerX;
      sumY += flock.centerY;
      sumZ += flock.centerZ;
      activeFlocks++;
    }
    if (activeFlocks === 0) return 0;
    const sphere = mesh.boundingSphere;
    sphere.center.set(sumX / activeFlocks - origin.x, sumY / activeFlocks - origin.y, sumZ / activeFlocks - origin.z);
    let radius = 1;
    for (const flock of flocks) {
      if (!flock.active) continue;
      const dx = flock.centerX - origin.x - sphere.center.x;
      const dy = flock.centerY - origin.y - sphere.center.y;
      const dz = flock.centerZ - origin.z - sphere.center.z;
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz) + flock.radius + 4);
    }
    sphere.radius = radius;
    return activeFlocks;
  }

  function writeInstances() {
    origin.set(Math.round(player.position.x / 64) * 64, Math.round(player.position.y / 64) * 64, Math.round(player.position.z / 64) * 64);
    mesh.position.copy(origin);
    for (const flock of flocks) {
      flock.fade = flock.active ? smooth01(flock.age / SPAWN_FADE_SECONDS) : 0;
      const end = flock.start + BIRDS_PER_SLOT;
      for (let index = flock.start; index < end; index++) writeBirdMatrix(index, flock);
    }
    mesh.visible = updateBirdBounds() > 0;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.needsUpdate = true;
    axisRightAttribute.needsUpdate = true;
    axisUpAttribute.needsUpdate = true;
  }

  // ---- Initial flocks: one crossing the view soon after spawn, the rest spread ahead ----------------
  {
    const wanted = targetFlockCount();
    for (let slot = 0; slot < wanted; slot++) spawnFlock(flocks[slot], slot === 0);
    for (const flock of flocks) {
      if (!flock.active) continue;
      flock.age = SPAWN_FADE_SECONDS;
      updateFlockTarget(flock, 0);
    }
    writeInstances();
  }

  bus.on('quality:changed', () => rebalanceFlocks());
  bus.onTyped('wildlifeQuiet', ({ source, quiet }) => {
    const wasQuiet = quietSources.size > 0;
    if (quiet) quietSources.add(source);
    else quietSources.delete(source);
    if (wasQuiet !== quietSources.size > 0) rebalanceFlocks();
  });

  /** Fades the flocks out while the wildlife is quiet; the settled ones leave, and none fly until it ends. */
  function updateQuiet(dt) {
    const quiet = quietSources.size > 0;
    quietFade = quiet ? Math.max(0, quietFade - dt / QUIET_FADE_SECONDS) : Math.min(1, quietFade + dt / QUIET_FADE_SECONDS);
    if (!quiet || quietFade > 0) return;
    for (const flock of flocks) if (flock.active) deactivateFlock(flock);
  }

  function recycleFlocks() {
    const px = player.position.x;
    const pz = player.position.z;
    for (const flock of flocks) {
      if (!flock.active) continue;
      const dx = flock.centerX - px;
      const dz = flock.centerZ - pz;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (flock.retiring && distance > 900) {
        deactivateFlock(flock);
      } else if (!flock.retiring && distance > RECYCLE_DISTANCE) {
        spawnFlock(flock, false);
      }
    }
  }

  return {
    mesh,
    update(dt) {
      if (dt > 0) {
        simulationTime += dt;
        updateQuiet(dt);
        refreshGroundSamples(dt);
        for (const flock of flocks) {
          if (!flock.active) continue;
          flock.age += dt;
          flock.scatterCooldown = Math.max(0, flock.scatterCooldown - dt);
          updateFlockCenter(flock);
          updateFlockTarget(flock, dt);
          simulateFlock(flock, dt);
          if (quietFade > 0.5) tryScatter(flock);
        }
        recycleFlocks();
        writeInstances();
        lastWrittenFrame = state.frame;
      } else if (lastWrittenFrame < 0) {
        writeInstances();
        lastWrittenFrame = state.frame;
      }
    },
    getStats() {
      let activeFlocks = 0;
      let birds = 0;
      let excited = 0;
      let nearest = null;
      for (const flock of flocks) {
        if (!flock.active) continue;
        activeFlocks++;
        birds += flock.count;
        for (let index = flock.start; index < flock.start + flock.count; index++) {
          if (excitementLevel[index] > 0.5) excited++;
        }
        const dx = flock.centerX - player.position.x;
        const dy = flock.centerY - player.position.y;
        const dz = flock.centerZ - player.position.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!nearest || distance < nearest.distance) {
          nearest = {
            x: Math.round(flock.centerX),
            y: Math.round(flock.centerY),
            z: Math.round(flock.centerZ),
            distance: Math.round(distance),
          };
        }
      }
      return { flocks: activeFlocks, birds, excited, nearest, quiet: quietSources.size > 0, quietFade: Math.round(quietFade * 100) / 100 };
    },
  };
}
