// Emissive ribbons for the light-effect engine: lightning bolts (a branching channel of segments),
// the in-cloud flash that lights the cloud base around a strike, and lighthouse-style beams.
//
// A ribbon slot is one mesh with its own material (built once, in init, and reused for the whole
// session: pools.js explains why meshes on shared materials are never created per spawn). Each
// segment is a quad that faces the camera around its own axis, computed in view space in the vertex
// shader from both ends of the segment, with a minimum width on screen so a bolt 10 km away still
// reads as a line. The fragment shader draws a hot core in a wide halo; the colour is HDR, so the
// bloom carries it. The slot's intensity is one uniform (the flash envelope), so a strike costs
// no upload after its geometry is written.
//
// Bolt geometry comes from generateBolt(): midpoint displacement of the main channel (seeded, with a
// little downward bias so it walks down) plus forking branches, written into the slot's attribute
// arrays with no allocation.

/** Segments one bolt slot can hold (the main channel and its branches). */
export const BOLT_SEGMENTS = 192;
/** Levels of midpoint displacement of the main channel (2^levels segments). */
const MAIN_LEVELS = 6;
const BRANCH_LEVELS = 4;
/** Screen-space minimum half-width of a ribbon, as a share of its view depth. */
const MIN_ANGULAR_WIDTH = 0.0009;
const RENDER_ORDER = 7;

/**
 * Builds a ribbon slot of segmentCapacity segments. options: THREE, TSL, scene, name, kind ('bolt'
 * or 'beam'). Returns the mesh, its uniforms (intensity, color), the attribute arrays and writers.
 */
export function createRibbonSlot({ THREE, TSL, scene, name, segmentCapacity, kind = 'bolt' }) {
  const {
    Fn, float, vec2, vec4, uniform, attribute, modelViewMatrix, cameraProjectionMatrix, varyingProperty,
    abs, exp, max, mix, cross, normalize, length, saturate, pow, smoothstep,
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

  const intensity = uniform(0);
  const color = uniform(new THREE.Color(1, 1, 1));
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
    material.vertexNode = Fn(() => {
      const startView = modelViewMatrix.mul(vec4(start, 1)).xyz;
      const endView = modelViewMatrix.mul(vec4(end, 1)).xyz;
      const point = mix(startView, endView, ribbon.x);
      const along = endView.sub(startView);
      const side = normalize(cross(along, point.negate()));
      const halfWidth = max(ribbon.z, point.z.negate().mul(MIN_ANGULAR_WIDTH * 3));
      vAcross.assign(vec2(ribbon.y, ribbon.w));
      vAlong.assign(ribbon.x);
      return cameraProjectionMatrix.mul(vec4(point.add(side.mul(ribbon.y).mul(halfWidth)), 1));
    })();
    const across = abs(vAcross.x);
    const body = exp(across.mul(across).mul(-3.2)).mul(pow(float(1).sub(vAlong), 1.6)).mul(smoothstep(0, 0.04, vAlong));
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
   * Writes segment index from (ax, ay, az) to (bx, by, bz), local to the mesh, halfWidth (m) at its
   * start and endHalfWidth at its end.
   */
  function writeSegment(index, ax, ay, az, bx, by, bz, halfWidth, endHalfWidth, brightness) {
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
    intensity,
    color,
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
 * Scratch for generateBolt: the main channel's points (x, y, z) and the working buffer of one
 * midpoint-displacement pass. Allocate once per engine.
 */
export function createBoltScratch() {
  const count = (1 << MAIN_LEVELS) + 1;
  return { points: new Float64Array(count * 3), work: new Float64Array(count * 3), branch: new Float64Array(((1 << BRANCH_LEVELS) + 1) * 3) };
}

/**
 * Midpoint displacement of the polyline from a to b into out (2^levels + 1 points), roughness the
 * sideways offset as a share of each segment's length. rng() is the seeded source.
 */
function displace(out, work, ax, ay, az, bx, by, bz, levels, roughness, rng) {
  out[0] = ax;
  out[1] = ay;
  out[2] = az;
  out[3] = bx;
  out[4] = by;
  out[5] = bz;
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
      work[written * 3] = (x0 + x1) * 0.5 + (rng() * 2 - 1) * jitter;
      work[written * 3 + 1] = (y0 + y1) * 0.5 + (rng() * 2 - 1) * jitter * 0.35;
      work[written * 3 + 2] = (z0 + z1) * 0.5 + (rng() * 2 - 1) * jitter;
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

/**
 * Writes a bolt into slot: the main channel from (topX, topY, topZ) to (bottomX, bottomY, bottomZ)
 * (local to the slot's mesh) and up to branches forks. halfWidth in metres. Returns the segment count.
 */
export function generateBolt(slot, scratch, rng, topX, topY, topZ, bottomX, bottomY, bottomZ, halfWidth, branches) {
  const points = scratch.points;
  const count = displace(points, scratch.work, topX, topY, topZ, bottomX, bottomY, bottomZ, MAIN_LEVELS, 0.32, rng);
  let segment = 0;
  for (let index = 0; index < count - 1 && segment < BOLT_SEGMENTS; index++) {
    // The channel is brightest near the ground (the return stroke) and thins a little upward.
    const along = index / (count - 1);
    slot.writeSegment(
      segment++,
      points[index * 3], points[index * 3 + 1], points[index * 3 + 2],
      points[index * 3 + 3], points[index * 3 + 4], points[index * 3 + 5],
      halfWidth * (0.7 + 0.3 * along), halfWidth * (0.7 + 0.3 * (index + 1) / (count - 1)), 0.8 + 0.2 * along,
    );
  }
  const dx = bottomX - topX;
  const dy = bottomY - topY;
  const dz = bottomZ - topZ;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const branchPoints = scratch.branch;
  for (let branch = 0; branch < branches && segment < BOLT_SEGMENTS; branch++) {
    // Forks leave the upper two thirds of the channel, heading down and outward.
    const from = 2 + Math.floor(rng() * (count * 0.65));
    const originX = points[from * 3];
    const originY = points[from * 3 + 1];
    const originZ = points[from * 3 + 2];
    const reach = length * (0.12 + rng() * 0.28);
    const angle = rng() * Math.PI * 2;
    const tipX = originX + Math.cos(angle) * reach * 0.8 + dx / length * reach * 0.3;
    const tipY = originY + dy / length * reach * (0.4 + rng() * 0.5);
    const tipZ = originZ + Math.sin(angle) * reach * 0.8 + dz / length * reach * 0.3;
    const branchCount = displace(branchPoints, scratch.work, originX, originY, originZ, tipX, tipY, tipZ, BRANCH_LEVELS, 0.35, rng);
    const brightness = 0.28 + rng() * 0.3;
    for (let index = 0; index < branchCount - 1 && segment < BOLT_SEGMENTS; index++) {
      const fade = 1 - index / (branchCount - 1);
      const nextFade = 1 - (index + 1) / (branchCount - 1);
      slot.writeSegment(
        segment++,
        branchPoints[index * 3], branchPoints[index * 3 + 1], branchPoints[index * 3 + 2],
        branchPoints[index * 3 + 3], branchPoints[index * 3 + 4], branchPoints[index * 3 + 5],
        halfWidth * 0.55 * (0.4 + 0.6 * fade), halfWidth * 0.55 * (0.4 + 0.6 * nextFade), brightness * (0.35 + 0.65 * fade),
      );
    }
  }
  slot.commit(segment);
  return segment;
}

/**
 * Writes a beam into slot: count spokes from the origin, each length long, turned evenly around the
 * vertical axis and tilted up by tilt (radians), widening from startHalfWidth to endHalfWidth. The
 * mesh rotates to sweep them.
 */
export function generateBeams(slot, count, length, startHalfWidth, endHalfWidth, tilt) {
  const rise = Math.sin(tilt) * length;
  const run = Math.cos(tilt) * length;
  for (let beam = 0; beam < count; beam++) {
    const angle = beam * Math.PI * 2 / count;
    slot.writeSegment(beam, 0, 0, 0, Math.cos(angle) * run, rise, Math.sin(angle) * run, startHalfWidth, endHalfWidth, 1);
  }
  slot.commit(count);
}
