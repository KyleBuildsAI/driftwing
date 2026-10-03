// Emissive ribbons for the light-effect engine: lightning bolts (a branching channel of segments),
// the in-cloud flash that lights the cloud base around a strike, and lighthouse-style beams.
//
// A ribbon slot is one mesh with its own material (built once, in init, and reused for the whole
// session: pools.js explains why meshes on shared materials are never created per spawn). Each
// segment is a quad that faces the camera around its own axis, computed in view space in the vertex
// shader from both ends of the segment, with a minimum width on screen so a bolt 10 km away still
// reads as a line. The fragment shader draws a hot core in a wide halo; the colour is HDR, so the
// bloom carries it. The slot's intensity (the flash envelope) and a beam's sweep angle share one vec4
// uniform (params.x, params.y): a strike costs no upload after its geometry is written, and a
// Vector4 takes new numbers in place where a float uniform would box each one.
//
// Bolt geometry comes from generateBolt(): midpoint displacement of the main channel (seeded, with a
// little downward bias so it walks down) plus forking branches, written into the slot's attribute
// arrays with no allocation: the random numbers come in a typed array (fillRandoms) and every
// segment goes through the slot's segment scratch rather than as call arguments.

/** Segments one bolt slot can hold (the main channel and its branches). */
export const BOLT_SEGMENTS = 192;
/** Levels of midpoint displacement of the main channel (2^levels segments). */
const MAIN_LEVELS = 6;
const BRANCH_LEVELS = 4;
/** Forks one bolt may have (the lightEffect engine's lightning.branches range). */
export const MAX_BRANCHES = 24;
/** Random numbers a fork draws: its origin, reach, angle, droop and brightness, then its displacement. */
const BRANCH_RANDOMS = 5 + 3 * ((1 << BRANCH_LEVELS) - 1);
/** Random numbers generateBolt() reads at most: the main channel's displacement, then every fork. */
export const BOLT_RANDOMS = 3 * ((1 << MAIN_LEVELS) - 1) + MAX_BRANCHES * BRANCH_RANDOMS;
/**
 * Screen-space minimum half-width of a ribbon, as a share of its view depth (about 2 px at 1080p): a
 * thinner channel breaks up into dots between the pixels, a bolt 5 km away must read as one line.
 */
const MIN_ANGULAR_WIDTH = 0.002;
const RENDER_ORDER = 7;

/**
 * Builds a ribbon slot of segmentCapacity segments. options: THREE, TSL, scene, name, kind ('bolt'
 * or 'beam'). Returns the mesh, its uniforms (params: x intensity, y a beam's sweep angle in radians
 * about the vertical; color), the segment scratch and the writers.
 */
export function createRibbonSlot({ THREE, TSL, scene, name, segmentCapacity, kind = 'bolt' }) {
  const {
    Fn, float, vec2, vec4, uniform, attribute, modelViewMatrix, cameraProjectionMatrix, varyingProperty,
    abs, exp, max, mix, cross, normalize, length, saturate, pow, smoothstep, sin, cos, vec3,
  } = TSL;
  const vertexCount = segmentCapacity * 4;
  const positions = new Float32Array(vertexCount * 3);
  const segmentStart = new Float32Array(vertexCount * 3);
  const segmentEnd = new Float32Array(vertexCount * 3);
  const info = new Float32Array(vertexCount * 4);
  const indices = new Uint16Array(segmentCapacity * 6);
  for (let segment = 0; segment < segmentCapacity; segment++) {
    const base = segment * 4;
    indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], segment * 6);
  }
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const startAttribute = new THREE.BufferAttribute(segmentStart, 3).setUsage(THREE.DynamicDrawUsage);
  const endAttribute = new THREE.BufferAttribute(segmentEnd, 3).setUsage(THREE.DynamicDrawUsage);
  const infoAttribute = new THREE.BufferAttribute(info, 4).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('ribbonStart', startAttribute);
  geometry.setAttribute('ribbonEnd', endAttribute);
  geometry.setAttribute('ribbonInfo', infoAttribute);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const params = uniform(new THREE.Vector4(0, 0, 0, 0));
  const intensity = params.x;
  const color = uniform(new THREE.Color(1, 1, 1));
  /** One segment on its way to writeSegment: ax, ay, az, bx, by, bz, half-width, end half-width, brightness. */
  const segmentScratch = new Float64Array(9);
  const start = attribute('ribbonStart', 'vec3');
  const end = attribute('ribbonEnd', 'vec3');
  const ribbon = attribute('ribbonInfo', 'vec4');
  const vAcross = varyingProperty('vec2', 'vRibbonAcross');

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  // ribbonInfo: x = end (0 start, 1 end), y = side (-1, +1), z = half-width (m), w = brightness.
  material.vertexNode = Fn(() => {
    const startView = modelViewMatrix.mul(vec4(start, 1)).xyz;
    const endView = modelViewMatrix.mul(vec4(end, 1)).xyz;
    const point = mix(startView, endView, ribbon.x);
    const along = endView.sub(startView);
    const side = normalize(cross(along, point.negate()));
    const halfWidth = max(ribbon.z, point.z.negate().mul(MIN_ANGULAR_WIDTH));
    vAcross.assign(vec2(ribbon.y, ribbon.w));
    return cameraProjectionMatrix.mul(vec4(point.add(side.mul(ribbon.y).mul(halfWidth)), 1));
  })();
  if (kind === 'beam') {
    // A beam: soft across, fading along its length (the brightness carries the along position).
    const vAlong = varyingProperty('float', 'vRibbonAlong');
    // The sweep turns the spokes about the vertical in the shader (params.y), as rotation.y would.
    const sweepCos = cos(params.y);
    const sweepSin = sin(params.y);
    const sweep = (point) => vec3(point.x.mul(sweepCos).add(point.z.mul(sweepSin)), point.y, point.z.mul(sweepCos).sub(point.x.mul(sweepSin)));
    material.vertexNode = Fn(() => {
      const startView = modelViewMatrix.mul(vec4(sweep(start), 1)).xyz;
      const endView = modelViewMatrix.mul(vec4(sweep(end), 1)).xyz;
      const point = mix(startView, endView, ribbon.x);
      const along = endView.sub(startView);
      const side = normalize(cross(along, point.negate()));
      const halfWidth = max(ribbon.z, point.z.negate().mul(MIN_ANGULAR_WIDTH * 1.5));
      vAcross.assign(vec2(ribbon.y, ribbon.w));
      vAlong.assign(ribbon.x);
      return cameraProjectionMatrix.mul(vec4(point.add(side.mul(ribbon.y).mul(halfWidth)), 1));
    })();
    const across = abs(vAcross.x);
    const body = exp(across.mul(across).mul(-2.4)).mul(pow(float(1).sub(vAlong), 1.1)).mul(smoothstep(0, 0.04, vAlong));
    material.colorNode = color.mul(intensity).mul(body).mul(vAcross.y);
    material.opacityNode = saturate(body.mul(intensity));
  } else {
    const across = abs(vAcross.x);
    const core = exp(across.mul(across).mul(-26));
    const halo = exp(across.mul(across).mul(-3)).mul(0.35);
    const glow = core.mul(2.2).add(halo);
    material.colorNode = color.mul(intensity).mul(vAcross.y).mul(glow);
    material.opacityNode = saturate(glow.mul(intensity).mul(vAcross.y));
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.visible = false;
  scene.add(mesh);

  let segments = 0;

  /**
   * Writes segment index from segment (a Float64Array of 9: ax, ay, az, bx, by, bz local to the mesh,
   * the half-width (m) at its start and at its end, its brightness).
   */
  function writeSegment(index, segment) {
    const ax = segment[0];
    const ay = segment[1];
    const az = segment[2];
    const bx = segment[3];
    const by = segment[4];
    const bz = segment[5];
    const halfWidth = segment[6];
    const endHalfWidth = segment[7];
    const brightness = segment[8];
    for (let corner = 0; corner < 4; corner++) {
      const vertex = index * 4 + corner;
      const atEnd = corner >= 2 ? 1 : 0;
      const offset = vertex * 3;
      positions[offset] = atEnd ? bx : ax;
      positions[offset + 1] = atEnd ? by : ay;
      positions[offset + 2] = atEnd ? bz : az;
      segmentStart[offset] = ax;
      segmentStart[offset + 1] = ay;
      segmentStart[offset + 2] = az;
      segmentEnd[offset] = bx;
      segmentEnd[offset + 1] = by;
      segmentEnd[offset + 2] = bz;
      const infoOffset = vertex * 4;
      info[infoOffset] = atEnd;
      info[infoOffset + 1] = (corner & 1) === 0 ? -1 : 1;
      info[infoOffset + 2] = atEnd ? endHalfWidth : halfWidth;
      info[infoOffset + 3] = brightness;
    }
  }

  return {
    mesh,
    material,
    params,
    color,
    segment: segmentScratch,
    writeSegment,
    get segments() { return segments; },
    /** Draws count segments and uploads the written geometry. */
    commit(count) {
      segments = count;
      geometry.setDrawRange(0, count * 6);
      positionAttribute.needsUpdate = true;
      startAttribute.needsUpdate = true;
      endAttribute.needsUpdate = true;
      infoAttribute.needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Scratch for generateBolt: the main channel's points (x, y, z), the working buffer of one
 * midpoint-displacement pass, a fork's points, and ends (the bolt's top x, y, z, bottom x, y, z and
 * half-width, which the caller fills). Allocate once per engine.
 */
export function createBoltScratch() {
  const count = (1 << MAIN_LEVELS) + 1;
  return {
    points: new Float64Array(count * 3),
    work: new Float64Array(count * 3),
    branch: new Float64Array(((1 << BRANCH_LEVELS) + 1) * 3),
    ends: new Float64Array(7),
  };
}

/**
 * Midpoint displacement of the polyline from out[0..2] to out[3..5] into out (2^levels + 1 points),
 * roughness the sideways offset as a share of each segment's length, reading 3 x (2^levels - 1)
 * random numbers from randoms[first].
 */
function displace(out, work, levels, roughness, randoms, first) {
  let next = first;
  let count = 2;
  for (let level = 0; level < levels; level++) {
    let written = 0;
    for (let index = 0; index < count - 1; index++) {
      const x0 = out[index * 3];
      const y0 = out[index * 3 + 1];
      const z0 = out[index * 3 + 2];
      const x1 = out[index * 3 + 3];
      const y1 = out[index * 3 + 4];
      const z1 = out[index * 3 + 5];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const jitter = length * roughness;
      work[written * 3] = x0;
      work[written * 3 + 1] = y0;
      work[written * 3 + 2] = z0;
      written++;
      work[written * 3] = (x0 + x1) * 0.5 + (randoms[next] * 2 - 1) * jitter;
      work[written * 3 + 1] = (y0 + y1) * 0.5 + (randoms[next + 1] * 2 - 1) * jitter * 0.35;
      work[written * 3 + 2] = (z0 + z1) * 0.5 + (randoms[next + 2] * 2 - 1) * jitter;
      next += 3;
      written++;
    }
    work[written * 3] = out[(count - 1) * 3];
    work[written * 3 + 1] = out[(count - 1) * 3 + 1];
    work[written * 3 + 2] = out[(count - 1) * 3 + 2];
    written++;
    for (let index = 0; index < written * 3; index++) out[index] = work[index];
    count = written;
  }
  return count;
}

/** Copies the segment from points[index] to points[index + 1] into segment[0..5]. */
function copySegmentEnds(segment, points, index) {
  for (let axis = 0; axis < 6; axis++) segment[axis] = points[index * 3 + axis];
}

/**
 * Writes a bolt into slot: the main channel from scratch.ends[0..2] (top) to scratch.ends[3..5]
 * (bottom), local to the slot's mesh, scratch.ends[6] its half-width in metres, and up to branches
 * forks (at most MAX_BRANCHES). Reads BOLT_RANDOMS random numbers from randoms[first] at most.
 * Returns the segment count.
 */
export function generateBolt(slot, scratch, randoms, first, branches) {
  const ends = scratch.ends;
  const points = scratch.points;
  const segment = slot.segment;
  const halfWidth = ends[6];
  for (let axis = 0; axis < 6; axis++) points[axis] = ends[axis];
  const count = displace(points, scratch.work, MAIN_LEVELS, 0.32, randoms, first);
  const branchFirst = first + 3 * ((1 << MAIN_LEVELS) - 1);
  let written = 0;
  for (let index = 0; index < count - 1 && written < BOLT_SEGMENTS; index++) {
    // The channel is brightest near the ground (the return stroke) and thins a little upward.
    const along = index / (count - 1);
    copySegmentEnds(segment, points, index);
    segment[6] = halfWidth * (0.7 + 0.3 * along);
    segment[7] = halfWidth * (0.7 + 0.3 * (index + 1) / (count - 1));
    segment[8] = 0.8 + 0.2 * along;
    slot.writeSegment(written++, segment);
  }
  const dx = ends[3] - ends[0];
  const dy = ends[4] - ends[1];
  const dz = ends[5] - ends[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const branchPoints = scratch.branch;
  const forks = branches < MAX_BRANCHES ? branches : MAX_BRANCHES;
  for (let branch = 0; branch < forks && written < BOLT_SEGMENTS; branch++) {
    const random = branchFirst + branch * BRANCH_RANDOMS;
    // Forks leave the upper two thirds of the channel, heading down and outward.
    const from = 2 + Math.floor(randoms[random] * (count * 0.65));
    const originX = points[from * 3];
    const originY = points[from * 3 + 1];
    const originZ = points[from * 3 + 2];
    const reach = length * (0.12 + randoms[random + 1] * 0.28);
    const angle = randoms[random + 2] * Math.PI * 2;
    branchPoints[0] = originX;
    branchPoints[1] = originY;
    branchPoints[2] = originZ;
    branchPoints[3] = originX + Math.cos(angle) * reach * 0.8 + dx / length * reach * 0.3;
    branchPoints[4] = originY + dy / length * reach * (0.4 + randoms[random + 3] * 0.5);
    branchPoints[5] = originZ + Math.sin(angle) * reach * 0.8 + dz / length * reach * 0.3;
    const brightness = 0.28 + randoms[random + 4] * 0.3;
    const branchCount = displace(branchPoints, scratch.work, BRANCH_LEVELS, 0.35, randoms, random + 5);
    for (let index = 0; index < branchCount - 1 && written < BOLT_SEGMENTS; index++) {
      const fade = 1 - index / (branchCount - 1);
      const nextFade = 1 - (index + 1) / (branchCount - 1);
      copySegmentEnds(segment, branchPoints, index);
      segment[6] = halfWidth * 0.55 * (0.4 + 0.6 * fade);
      segment[7] = halfWidth * 0.55 * (0.4 + 0.6 * nextFade);
      segment[8] = brightness * (0.35 + 0.65 * fade);
      slot.writeSegment(written++, segment);
    }
  }
  slot.commit(written);
  return written;
}

/**
 * Writes a beam into slot: count spokes from the origin, each length long, turned evenly around the
 * vertical axis and tilted up by tilt (radians), widening from startHalfWidth to endHalfWidth.
 * params.y sweeps them.
 */
export function generateBeams(slot, count, length, startHalfWidth, endHalfWidth, tilt) {
  const rise = Math.sin(tilt) * length;
  const run = Math.cos(tilt) * length;
  const segment = slot.segment;
  for (let beam = 0; beam < count; beam++) {
    const angle = beam * Math.PI * 2 / count;
    segment[0] = 0;
    segment[1] = 0;
    segment[2] = 0;
    segment[3] = Math.cos(angle) * run;
    segment[4] = rise;
    segment[5] = Math.sin(angle) * run;
    segment[6] = startHalfWidth;
    segment[7] = endHalfWidth;
    segment[8] = 1;
    slot.writeSegment(beam, segment);
  }
  slot.commit(count);
}
