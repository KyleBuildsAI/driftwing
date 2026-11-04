// Structure movers (Phase 3, preset 41): rigid parts of a structure that move after it is built, each
// on its own pooled mesh with its own collider hull turned with it every frame.
//
//   drift   a floating body (an iceberg): it rides the sea (the water layer's surface, so a passing
//           calving wave lifts it) with a slow bob and rock, drifts along a heading that turns lazily,
//           and keeps to its leash and to water at least its draft deep (a navigable grid sampled
//           once at create, so the frame never asks the terrain)
//   calve   a slab of an ice front: it rests flush with the face until its turn comes (the instance's
//           calving schedule, or setParam('calve')), shudders as the crack rings out, topples outward
//           about its outer base edge and plunges into the sea (a splash, a ring wave spreading across
//           the water and the voice's 'crack' and 'splash'), floats away as a berg, melts under the
//           surface, and slides back out of the face as the glacier advances
//
// A recipe adds movers through context.addMover(spec) (structureEngine.js): spec { builder (a mesh
// builder holding the part in its own frame: origin at its base centre, -z its face direction for a
// slab), x, y, z (its rest position, local to the anchor), yaw (radians, compass), motion, hull (local
// [x, y, z] points of its collider, at most 64; empty for none), drift: { speed, heading, leash,
// draft, bob, tilt, spin, homeX, homeZ }, calve: { depth (the slab's thickness along the face
// normal), height, recess } }, and once per structure context.setCalving({ interval: [min, max],
// first, wave: { height, width, speed, travel } }) and context.setNavigation(grid).
//
// The frame update allocates nothing: every number lives in the instance's typed arrays, poses are
// written straight into each mesh's matrix and each collider's pose array, and the rare event work
// (a splash, a crack) copies a few numbers into descriptors made at create.

const DRIFT = 0;
const CALVE = 1;
/** Calving slab states. */
const ATTACHED = 0;
const CRACKING = 1;
const TOPPLING = 2;
const FLOATING = 3;
const MELTING = 4;
const REGROWING = 5;
/** Seconds each calving state lasts. */
const CRACK_SECONDS = 1.6;
const TOPPLE_SECONDS = 3.4;
const FLOAT_SECONDS = 70;
const MELT_SECONDS = 24;
const REGROW_SECONDS = 30;
/** A toppled slab ends lying this far over (radians). */
const TOPPLE_ANGLE = 1.35;
/** Per mover in `state`: [x, y, z, yaw, heading, timer, phase, tilt angle, drop, water y]. */
const STATE_STRIDE = 10;
/** Per mover in `rest`: [x, y, z, yaw, faceX, faceZ, depth, height, recess]. */
const REST_STRIDE = 9;
/** Per drifting body in `drift`: [speed, leash, draft, bob, tilt, spin, home x, home z]. */
const DRIFT_STRIDE = 8;
/** The water surface under each drifting body is refreshed on a round robin of this many frames. */
const WATER_ROUND = 6;

/** A navigable grid: cells of `cell` metres over the world box; 1 where the sea is deep enough. */
export function createNavigationGrid(minX, minZ, cell, columns, rows, deepEnough) {
  const open = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      open[row * columns + column] = deepEnough(minX + (column + 0.5) * cell, minZ + (row + 0.5) * cell) ? 1 : 0;
    }
  }
  return { minX, minZ, cell, columns, rows, open };
}

function navigable(grid, x, z) {
  if (grid === null) return true;
  const column = Math.floor((x - grid.minX) / grid.cell);
  const row = Math.floor((z - grid.minZ) / grid.cell);
  if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) return false;
  return grid.open[row * grid.columns + column] === 1;
}

/**
 * Writes the rotation quaternion of a yaw (compass, radians) after a tilt about the local x axis
 * (pitch) and the local z axis (roll) into pose[3..6]: q = yaw * pitch * roll.
 */
function writeRotation(pose, yaw, pitch, roll) {
  const hy = -yaw * 0.5;
  const hp = pitch * 0.5;
  const hr = roll * 0.5;
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cp = Math.cos(hp);
  const sp = Math.sin(hp);
  const cr = Math.cos(hr);
  const sr = Math.sin(hr);
  // pitch * roll (about x, then z)
  const px = sp * cr;
  const py = -sp * sr;
  const pz = cp * sr;
  const pw = cp * cr;
  // yaw (about y) * (pitch * roll)
  pose[3] = cy * px + sy * pz;
  pose[4] = sy * pw + cy * py;
  pose[5] = cy * pz - sy * px;
  pose[6] = cy * pw - sy * py;
}

/** Writes pose (x, y, z, quaternion) into a column-major 4x4 matrix's elements. */
function writeMatrix(elements, pose, dropY) {
  const x = pose[3];
  const y = pose[4];
  const z = pose[5];
  const w = pose[6];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  elements[0] = 1 - (yy + zz);
  elements[1] = xy + wz;
  elements[2] = xz - wy;
  elements[3] = 0;
  elements[4] = xy - wz;
  elements[5] = 1 - (xx + zz);
  elements[6] = yz + wx;
  elements[7] = 0;
  elements[8] = xz + wy;
  elements[9] = yz - wx;
  elements[10] = 1 - (xx + yy);
  elements[11] = 0;
  elements[12] = pose[0];
  elements[13] = pose[1] - dropY;
  elements[14] = pose[2];
  elements[15] = 1;
}

/**
 * Builds the movers of one structure instance from the recipe's specs (world positions from the
 * anchor). Returns the record the engine keeps in data.movers, or null when the recipe added none.
 */
export function createMovers(THREE, out, anchor, rng) {
  const specs = out.movers;
  if (specs.length === 0) return null;
  const count = specs.length;
  const movers = {
    count,
    kind: new Uint8Array(count),
    status: new Uint8Array(count),
    state: new Float64Array(count * STATE_STRIDE),
    rest: new Float64Array(count * REST_STRIDE),
    drift: new Float64Array(count * DRIFT_STRIDE),
    /** 1 once an attached slab's resting pose is written (nothing moves it until it calves). */
    still: new Uint8Array(count),
    poses: Array.from({ length: count }, () => new Float64Array(7)),
    geometries: specs.map((spec) => spec.builder.toGeometry(THREE)),
    hulls: specs.map((spec) => spec.hull),
    meshes: new Array(count).fill(null),
    colliderIds: new Array(count).fill(null),
    navigation: out.navigation ?? null,
    calving: out.calving ?? null,
    // The calving clock: [seconds to the next calving, the next slab's index, a forced calving waiting].
    clock: new Float64Array(3),
    // The ring wave of the last plunge: [age (s), x, z, active].
    wave: new Float64Array(4),
    waveSlot: -1,
    waveDescriptor: null,
    splash: null,
    events: 0,
    hidden: false,
    frame: 0,
    rng,
  };
  specs.forEach((spec, index) => {
    const state = index * STATE_STRIDE;
    const rest = index * REST_STRIDE;
    movers.kind[index] = spec.motion === 'calve' ? CALVE : DRIFT;
    movers.state[state] = anchor.x + spec.x;
    movers.state[state + 1] = anchor.y + spec.y;
    movers.state[state + 2] = anchor.z + spec.z;
    movers.state[state + 3] = spec.yaw;
    movers.state[state + 6] = rng() * Math.PI * 2;
    movers.rest[rest] = movers.state[state];
    movers.rest[rest + 1] = movers.state[state + 1];
    movers.rest[rest + 2] = movers.state[state + 2];
    movers.rest[rest + 3] = spec.yaw;
    movers.rest[rest + 4] = Math.sin(spec.yaw);
    movers.rest[rest + 5] = -Math.cos(spec.yaw);
    if (spec.motion === 'calve') {
      movers.rest[rest + 6] = spec.calve.depth;
      movers.rest[rest + 7] = spec.calve.height;
      movers.rest[rest + 8] = spec.calve.recess;
    } else {
      const drift = spec.drift;
      const base = index * DRIFT_STRIDE;
      movers.drift[base] = drift.speed;
      movers.drift[base + 1] = drift.leash;
      movers.drift[base + 2] = drift.draft;
      movers.drift[base + 3] = drift.bob;
      movers.drift[base + 4] = drift.tilt;
      movers.drift[base + 5] = drift.spin;
      movers.drift[base + 6] = anchor.x + drift.homeX;
      movers.drift[base + 7] = anchor.z + drift.homeZ;
      movers.state[state + 4] = drift.heading;
    }
  });
  if (movers.calving) {
    const calving = movers.calving;
    movers.clock[0] = calving.first;
    movers.clock[1] = 0;
  }
  return movers;
}

/** Shows every mover on a pooled mesh and registers its collider hull. */
export function showMovers(movers, pool, colliders, instance, prefix, look, swayOffset) {
  if (!movers) return;
  for (let index = 0; index < movers.count; index++) {
    const geometry = movers.geometries[index];
    if (!geometry) continue;
    const mesh = pool.acquire(geometry);
    if (!mesh) throw new Error('[DRIFTWING] structure: every mover mesh is in use');
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.look = look;
    mesh.userData.swayOffset = swayOffset;
    movers.meshes[index] = mesh;
    movers.geometries[index] = null;
    const hull = movers.hulls[index];
    if (colliders && hull && hull.length >= 4) {
      const id = `${prefix}:mover${index}`;
      const points = new Float64Array(hull.length * 3);
      hull.forEach(([x, y, z], point) => points.set([x, y, z], point * 3));
      const state = index * STATE_STRIDE;
      colliders.add({
        id, owner: prefix, type: 'hull', points,
        center: { x: movers.state[state], y: movers.state[state + 1], z: movers.state[state + 2] },
        tags: { surface: 'ice' },
      });
      instance.colliderIds.push(id);
      movers.colliderIds[index] = id;
    }
  }
}

/** Releases the meshes (and their geometries) and the ring wave; the engine removes the colliders. */
export function releaseMovers(movers, pool, water) {
  if (!movers) return;
  for (let index = 0; index < movers.count; index++) {
    const mesh = movers.meshes[index];
    if (mesh) {
      const geometry = mesh.geometry;
      mesh.matrixAutoUpdate = true;
      pool.release(mesh);
      geometry.dispose();
      movers.meshes[index] = null;
    } else if (movers.geometries[index]) {
      movers.geometries[index].dispose();
      movers.geometries[index] = null;
    }
  }
  if (movers.waveSlot >= 0 && water) water.releaseWave(movers.waveSlot);
  movers.waveSlot = -1;
}

/** Shows or hides every mover mesh (the heavy far tier hides them). */
export function setMoversVisible(movers, visible) {
  if (!movers) return;
  movers.hidden = !visible;
  // Shown again: every resting slab is posed afresh on the next frame (its matrix was not kept up).
  if (visible) movers.still.fill(0);
  for (let index = 0; index < movers.count; index++) if (movers.meshes[index]) movers.meshes[index].visible = visible;
}

/** Starts the next calving now (setParam 'calve'): the soonest attached slab cracks. */
export function forceCalving(movers) {
  if (!movers || !movers.calving) return false;
  movers.clock[2] = 1;
  return true;
}

function startCalving(movers, index, context) {
  movers.status[index] = CRACKING;
  movers.state[index * STATE_STRIDE + 5] = 0;
  movers.events++;
  if (context.voice) context.voice.trigger('crack', { strength: 1 });
  const state = index * STATE_STRIDE;
  context.bus.emit('structure:calve', {
    spawnId: context.instance.id, presetId: context.instance.presetId, slab: index, stage: 'crack',
    position: { x: Math.round(movers.state[state]), y: Math.round(movers.state[state + 1]), z: Math.round(movers.state[state + 2]) },
  });
}

/** The plunge: a splash where the slab hits, a ring wave spreading from it, the voice's splash. */
function plunge(movers, index, context) {
  const state = index * STATE_STRIDE;
  const rest = index * REST_STRIDE;
  const x = movers.state[state] + movers.rest[rest + 4] * movers.rest[rest + 7] * 0.5;
  const z = movers.state[state + 2] + movers.rest[rest + 5] * movers.rest[rest + 7] * 0.5;
  const water = context.water;
  if (water) {
    if (movers.splash === null) movers.splash = water.createMark();
    movers.splash.x = x;
    movers.splash.z = z;
    movers.splash.strength = 1;
    movers.splash.glow = 0;
    water.splashMark(movers.splash);
    if (movers.waveSlot < 0) movers.waveSlot = water.acquireWave();
    if (movers.waveSlot >= 0) {
      movers.wave[0] = 0;
      movers.wave[1] = x;
      movers.wave[2] = z;
      movers.wave[3] = 1;
      if (movers.waveDescriptor === null) movers.waveDescriptor = water.createWave({ ring: true, lean: 0.35, foam: 0.85 });
    }
  }
  if (context.voice) context.voice.trigger('splash', { strength: 1 });
  context.bus.emit('structure:calve', {
    spawnId: context.instance.id, presetId: context.instance.presetId, slab: index, stage: 'splash', position: { x: Math.round(x), y: Math.round(context.waterLevel), z: Math.round(z) },
  });
}

/** The ring wave of the last plunge: spreading at the calving's wave speed, losing height, then gone. */
function updateRingWave(movers, context, dt) {
  if (movers.wave[3] < 0.5 || movers.waveSlot < 0 || !context.water) return;
  const wave = movers.calving.wave;
  movers.wave[0] += dt;
  const front = movers.wave[0] * wave.speed;
  const descriptor = movers.waveDescriptor;
  if (front > wave.travel) {
    movers.wave[3] = 0;
    descriptor.weight = 0;
    context.water.setWave(movers.waveSlot, descriptor);
    context.water.releaseWave(movers.waveSlot);
    movers.waveSlot = -1;
    return;
  }
  descriptor.x = movers.wave[1];
  descriptor.z = movers.wave[2];
  descriptor.front = front;
  descriptor.height = wave.height / Math.sqrt(1 + front / 60);
  descriptor.width = wave.width;
  const rise = front < 30 ? front / 30 : 1;
  const fall = (wave.travel - front) / (wave.travel * 0.3);
  descriptor.weight = rise * (fall < 1 ? fall : 1);
  context.water.setWave(movers.waveSlot, descriptor);
}

function updateDrifting(movers, index, context, dt, time) {
  const state = index * STATE_STRIDE;
  const base = index * DRIFT_STRIDE;
  const speed = movers.drift[base];
  const leash = movers.drift[base + 1];
  let heading = movers.state[state + 4];
  // A lazy turn, and back toward home past the leash.
  heading += Math.sin(time * 0.013 + movers.state[state + 6] * 7) * 0.02 * dt;
  const awayX = movers.state[state] - movers.drift[base + 6];
  const awayZ = movers.state[state + 2] - movers.drift[base + 7];
  if (awayX * awayX + awayZ * awayZ > leash * leash) {
    const homeward = Math.atan2(-awayX, awayZ);
    let delta = homeward - heading;
    delta -= Math.PI * 2 * Math.floor((delta + Math.PI) / (Math.PI * 2));
    heading += (delta > 0 ? 1 : -1) * Math.min(Math.abs(delta), 0.12 * dt);
  }
  const nextX = movers.state[state] + Math.sin(heading) * speed * dt;
  const nextZ = movers.state[state + 2] - Math.cos(heading) * speed * dt;
  if (navigable(movers.navigation, nextX, nextZ)) {
    movers.state[state] = nextX;
    movers.state[state + 2] = nextZ;
  } else {
    // Shoaling ahead: turn about.
    heading += Math.PI * 0.6;
  }
  movers.state[state + 4] = heading;
  movers.state[state + 3] += movers.drift[base + 5] * dt;
}

function updateCalving(movers, index, context, dt, time) {
  const state = index * STATE_STRIDE;
  const rest = index * REST_STRIDE;
  const status = movers.status[index];
  movers.state[state + 5] += dt;
  const timer = movers.state[state + 5];
  const faceX = movers.rest[rest + 4];
  const faceZ = movers.rest[rest + 5];
  const depth = movers.rest[rest + 6];
  const height = movers.rest[rest + 7];
  if (status === ATTACHED) return;
  if (status === CRACKING) {
    // A shudder at the face.
    const shake = Math.sin(timer * 41) * 0.25;
    movers.state[state] = movers.rest[rest] + faceX * shake;
    movers.state[state + 2] = movers.rest[rest + 2] + faceZ * shake;
    if (timer >= CRACK_SECONDS) {
      movers.status[index] = TOPPLING;
      movers.state[state + 5] = 0;
    }
    return;
  }
  if (status === TOPPLING) {
    const share = Math.min(timer / TOPPLE_SECONDS, 1);
    const angle = TOPPLE_ANGLE * share * share;
    // About the outer base edge (depth / 2 out along the face), falling into the sea as it goes.
    const pivotOut = depth * 0.5;
    const drop = (movers.rest[rest + 1] - (context.waterLevel - height * 0.35)) * Math.pow(share, 2.5);
    const swing = pivotOut - Math.cos(angle) * pivotOut + Math.sin(angle) * height * 0.5;
    movers.state[state] = movers.rest[rest] + faceX * swing;
    movers.state[state + 1] = movers.rest[rest + 1] - drop;
    movers.state[state + 2] = movers.rest[rest + 2] + faceZ * swing;
    movers.state[state + 7] = angle;
    if (share >= 1) {
      movers.status[index] = FLOATING;
      movers.state[state + 5] = 0;
      plunge(movers, index, context);
    }
    return;
  }
  if (status === FLOATING || status === MELTING) {
    // Away from the face on the outflow, bobbing; melting under the surface at the end.
    const outward = status === FLOATING ? 1.4 * (1 - timer / FLOAT_SECONDS * 0.6) : 0.5;
    movers.state[state] += faceX * outward * dt;
    movers.state[state + 2] += faceZ * outward * dt;
    const floatY = movers.state[state + 9] - height * 0.35;
    const sink = status === MELTING ? (timer / MELT_SECONDS) * height * 1.4 : 0;
    movers.state[state + 1] += (floatY - sink + Math.sin(time * 0.5 + movers.state[state + 6]) * 0.4 - movers.state[state + 1]) * Math.min(1, dt * 1.5);
    movers.state[state + 7] += (TOPPLE_ANGLE * 0.82 - movers.state[state + 7]) * Math.min(1, dt * 0.3);
    if (status === FLOATING && timer >= FLOAT_SECONDS) {
      movers.status[index] = MELTING;
      movers.state[state + 5] = 0;
    } else if (status === MELTING && timer >= MELT_SECONDS) {
      movers.status[index] = REGROWING;
      movers.state[state + 5] = 0;
      movers.state[state + 7] = 0;
    }
    return;
  }
  // Regrowing: back inside the face, sliding out as the glacier advances.
  const share = Math.min(timer / REGROW_SECONDS, 1);
  const recess = movers.rest[rest + 8] * (1 - share);
  movers.state[state] = movers.rest[rest] - faceX * recess;
  movers.state[state + 1] = movers.rest[rest + 1];
  movers.state[state + 2] = movers.rest[rest + 2] - faceZ * recess;
  if (share >= 1) {
    movers.status[index] = ATTACHED;
    movers.state[state] = movers.rest[rest];
    movers.state[state + 2] = movers.rest[rest + 2];
  }
}

/**
 * One frame of every mover (context: { instance (the spawn instance: its id and presetId name the
 * events), water (the layer or null), waterLevel, voice (or null), bus, colliders (or null), dropAt
 * (x, z) -> the curvature drop }). Allocation-free.
 */
export function updateMovers(movers, context, dt, time) {
  if (!movers || dt <= 0) return;
  const water = context.water;
  movers.frame++;
  // The calving schedule: the next attached slab cracks when its time comes (or when forced).
  if (movers.calving) {
    movers.clock[0] -= dt;
    if (movers.clock[0] <= 0 || movers.clock[2] > 0.5) {
      for (let attempt = 0; attempt < movers.count; attempt++) {
        const index = (movers.clock[1] + attempt) % movers.count;
        if (movers.kind[index] !== CALVE || movers.status[index] !== ATTACHED) continue;
        startCalving(movers, index, context);
        movers.clock[1] = (index + 1) % movers.count;
        break;
      }
      const interval = movers.calving.interval;
      movers.clock[0] = interval[0] + (interval[1] - interval[0]) * movers.rng();
      movers.clock[2] = 0;
    }
    updateRingWave(movers, context, dt);
  }
  for (let index = 0; index < movers.count; index++) {
    const state = index * STATE_STRIDE;
    // The sea surface under the body (the layer's waves included), on a round robin.
    if ((movers.frame + index) % WATER_ROUND === 0) {
      movers.state[state + 9] = water ? water.surfaceHeightAt(movers.state[state], movers.state[state + 2]) : context.waterLevel;
    }
    const pose = movers.poses[index];
    if (movers.kind[index] === DRIFT) {
      updateDrifting(movers, index, context, dt, time);
      const base = index * DRIFT_STRIDE;
      const phase = movers.state[state + 6];
      const bob = Math.sin(time * 0.42 + phase) * movers.drift[base + 3];
      pose[0] = movers.state[state];
      pose[1] = movers.state[state + 9] - movers.drift[base + 2] + bob;
      pose[2] = movers.state[state + 2];
      const tilt = movers.drift[base + 4];
      writeRotation(pose, movers.state[state + 3], Math.sin(time * 0.37 + phase * 1.3) * tilt, Math.cos(time * 0.29 + phase * 0.7) * tilt);
    } else {
      updateCalving(movers, index, context, dt, time);
      // A slab resting at the face is posed once; nothing moves it until it calves.
      if (movers.status[index] === ATTACHED) {
        if (movers.still[index] === 1) continue;
        movers.still[index] = 1;
      } else {
        movers.still[index] = 0;
      }
      pose[0] = movers.state[state];
      pose[1] = movers.state[state + 1];
      pose[2] = movers.state[state + 2];
      // Toppling outward: the slab's face (local -z) tips down, a pitch about its local x.
      writeRotation(pose, movers.state[state + 3], -movers.state[state + 7], 0);
    }
    const mesh = movers.meshes[index];
    if (mesh && !movers.hidden) {
      writeMatrix(mesh.matrix.elements, pose, context.dropAt(pose[0], pose[2]));
      mesh.matrixWorldNeedsUpdate = true;
    }
    const id = movers.colliderIds[index];
    if (id !== null && context.colliders) context.colliders.setPose(id, pose);
  }
}

/** Live numbers for dev tools and tests. */
export function describeMovers(movers) {
  if (!movers) return null;
  const statuses = ['attached', 'cracking', 'toppling', 'floating', 'melting', 'regrowing'];
  const list = [];
  for (let index = 0; index < movers.count; index++) {
    const state = index * STATE_STRIDE;
    list.push({
      motion: movers.kind[index] === CALVE ? 'calve' : 'drift',
      status: movers.kind[index] === CALVE ? statuses[movers.status[index]] : 'drifting',
      x: Math.round(movers.state[state]), y: Math.round(movers.state[state + 1] * 10) / 10, z: Math.round(movers.state[state + 2]),
      collider: movers.colliderIds[index],
    });
  }
  return { count: movers.count, calvings: movers.events, ringWave: movers.wave[3] > 0.5, list };
}
