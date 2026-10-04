// Low-poly mesh builder for the structure recipes: flat-shaded triangles with per-face normals,
// linear RGBA vertex colours (alpha is the emissive gain, as in the landmarks) and a sway weight per
// vertex (0 = rigid, 1 = swings the full amplitude; the bridge deck and the ropes use it).
//
// Recipes build in the instance's LOCAL frame (metres from the spawn anchor: +x east, +y up, -z
// north), so the vertices keep full float precision however far from the origin the site lies. A
// transform (translation, yaw about +y, then an optional tilt) applies to everything emitted until it
// is reset. The builder runs at create() time only; every array it fills is released with it.
//
// Pure apart from toGeometry(THREE): no imports, so the node labs run it directly.

/** sRGB hex (0xRRGGBB) channel to linear light. */
function channelToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** A linear RGBA paint from an sRGB hex colour; alpha is the emissive gain (0 = unlit). */
export function paint(hex, emissive = 0) {
  return Object.freeze([
    channelToLinear(((hex >> 16) & 255) / 255),
    channelToLinear(((hex >> 8) & 255) / 255),
    channelToLinear((hex & 255) / 255),
    emissive,
  ]);
}

/** paint scaled in brightness (factor) with its emissive gain kept. */
export function shade(base, factor) {
  return Object.freeze([base[0] * factor, base[1] * factor, base[2] * factor, base[3]]);
}

/** A paint between two paints (amount 0 = first, 1 = second). */
export function mixPaint(first, second, amount) {
  return Object.freeze([
    first[0] + (second[0] - first[0]) * amount,
    first[1] + (second[1] - first[1]) * amount,
    first[2] + (second[2] - first[2]) * amount,
    first[3] + (second[3] - first[3]) * amount,
  ]);
}

/**
 * Creates a builder. options.uv adds a uv attribute (the waterfall ribbons scroll their streaks along
 * it); every primitive then takes the current uv from setUv or its own arguments.
 */
export function createMeshBuilder({ uv = false } = {}) {
  const positions = [];
  const colors = [];
  const sways = [];
  const uvs = uv ? [] : null;
  let currentPaint = paint(0xffffff);
  let currentSway = 0;
  // Transform: world = origin + R * local, with R = yaw about +y after a tilt (about x, then z).
  const origin = [0, 0, 0];
  const rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const point = [0, 0, 0];

  function transform(x, y, z) {
    point[0] = origin[0] + rotation[0] * x + rotation[1] * y + rotation[2] * z;
    point[1] = origin[1] + rotation[3] * x + rotation[4] * y + rotation[5] * z;
    point[2] = origin[2] + rotation[6] * x + rotation[7] * y + rotation[8] * z;
    return point;
  }

  function pushVertex(x, y, z, u, v, sway, vertexPaint = currentPaint) {
    const world = transform(x, y, z);
    positions.push(world[0], world[1], world[2]);
    colors.push(vertexPaint[0], vertexPaint[1], vertexPaint[2], vertexPaint[3]);
    sways.push(sway);
    if (uvs) uvs.push(u, v);
  }

  const builder = {
    /** Sets the paint of everything emitted next. */
    setPaint(value) {
      currentPaint = value;
      return builder;
    },
    /** Sets the sway weight (0..1) of everything emitted next. */
    setSway(weight) {
      currentSway = weight;
      return builder;
    },
    /**
     * Places the local frame: origin (x, y, z), yaw (radians, compass: clockwise seen from above, so
     * local -z points along the yaw heading), then tiltX / tiltZ (radians) about the local axes.
     */
    setTransform(x = 0, y = 0, z = 0, yaw = 0, tiltX = 0, tiltZ = 0) {
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
      // A compass heading turns clockwise seen from above: a rotation of -yaw about +y.
      const cy = Math.cos(-yaw);
      const sy = Math.sin(-yaw);
      const cx = Math.cos(tiltX);
      const sx = Math.sin(tiltX);
      const cz = Math.cos(tiltZ);
      const sz = Math.sin(tiltZ);
      // Rz * Rx, then Ry in front: R = Ry * Rx * Rz.
      const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
      const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
      const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
      const rxz = multiply3(rx, rz);
      const result = multiply3(ry, rxz);
      for (let index = 0; index < 9; index++) rotation[index] = result[index];
      return builder;
    },
    resetTransform() {
      return builder.setTransform(0, 0, 0, 0, 0, 0);
    },
    /** One triangle, counter-clockwise seen from its front. Optional per-vertex sway and uv. */
    triangle(ax, ay, az, bx, by, bz, cx, cy, cz, swayA = currentSway, swayB = currentSway, swayC = currentSway, uvA = null, uvB = null, uvC = null) {
      pushVertex(ax, ay, az, uvA ? uvA[0] : 0, uvA ? uvA[1] : 0, swayA);
      pushVertex(bx, by, bz, uvB ? uvB[0] : 0, uvB ? uvB[1] : 0, swayB);
      pushVertex(cx, cy, cz, uvC ? uvC[0] : 0, uvC ? uvC[1] : 0, swayC);
      return builder;
    },
    /** A quad a-b-c-d (counter-clockwise from its front) as two triangles. */
    quad(a, b, c, d, swayA = currentSway, swayB = currentSway, swayC = currentSway, swayD = currentSway) {
      builder.triangle(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], swayA, swayB, swayC, a.length > 3 ? [a[3], a[4]] : null, b.length > 3 ? [b[3], b[4]] : null, c.length > 3 ? [c[3], c[4]] : null);
      builder.triangle(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], swayA, swayC, swayD, a.length > 3 ? [a[3], a[4]] : null, c.length > 3 ? [c[3], c[4]] : null, d.length > 3 ? [d[3], d[4]] : null);
      return builder;
    },
    /**
     * A quad of full vertex records { p: [x, y, z], uv: [u, v], paint, sway } (a -> b -> c -> d
     * counter-clockwise from its front): per-vertex paint and uv, for ribbons that fade along their
     * length (the waterfalls).
     */
    vertexQuad(a, b, c, d) {
      for (const vertex of [a, b, c, a, c, d]) {
        pushVertex(vertex.p[0], vertex.p[1], vertex.p[2], vertex.uv ? vertex.uv[0] : 0, vertex.uv ? vertex.uv[1] : 0, vertex.sway ?? currentSway, vertex.paint ?? currentPaint);
      }
      return builder;
    },
    /**
     * A box from its centre and three half-axis vectors (u, v, w), which must form a right-handed set
     * for the faces to point outward.
     */
    orientedBox(cx, cy, cz, ux, uy, uz, vx, vy, vz, wx, wy, wz) {
      const corner = (su, sv, sw) => [cx + ux * su + vx * sv + wx * sw, cy + uy * su + vy * sv + wy * sw, cz + uz * su + vz * sv + wz * sw];
      const p000 = corner(-1, -1, -1);
      const p100 = corner(1, -1, -1);
      const p010 = corner(-1, 1, -1);
      const p110 = corner(1, 1, -1);
      const p001 = corner(-1, -1, 1);
      const p101 = corner(1, -1, 1);
      const p011 = corner(-1, 1, 1);
      const p111 = corner(1, 1, 1);
      builder.quad(p100, p110, p111, p101); // +u
      builder.quad(p000, p001, p011, p010); // -u
      builder.quad(p010, p011, p111, p110); // +v
      builder.quad(p000, p100, p101, p001); // -v
      builder.quad(p001, p101, p111, p011); // +w
      builder.quad(p000, p010, p110, p100); // -w
      return builder;
    },
    /** An axis-aligned (in the local frame) box: centre and full sizes, turned by yaw about +y. */
    box(cx, cy, cz, sx, sy, sz, yaw = 0) {
      const cosine = Math.cos(yaw);
      const sine = Math.sin(yaw);
      // Local x turned clockwise by yaw (compass), local z likewise.
      return builder.orientedBox(cx, cy, cz, cosine * sx * 0.5, 0, sine * sx * 0.5, 0, sy * 0.5, 0, -sine * sz * 0.5, 0, cosine * sz * 0.5);
    },
    /**
     * A beam between two points with a width (horizontal) and a height (its local up). Near-vertical
     * beams take the x axis for their width.
     */
    beam(ax, ay, az, bx, by, bz, width, height = width) {
      const dx = (bx - ax) * 0.5;
      const dy = (by - ay) * 0.5;
      const dz = (bz - az) * 0.5;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 1e-6) return builder;
      // v: horizontal and perpendicular to the beam (or +x for a vertical beam).
      let vx = -dz;
      let vz = dx;
      let horizontal = Math.sqrt(vx * vx + vz * vz);
      if (horizontal < 1e-6) {
        vx = 1;
        vz = 0;
        horizontal = 1;
      }
      vx = (vx / horizontal) * width * 0.5;
      vz = (vz / horizontal) * width * 0.5;
      // w = u x v (normalised), scaled to half the height.
      const ux = dx / length;
      const uy = dy / length;
      const uz = dz / length;
      const vLength = Math.sqrt(vx * vx + vz * vz);
      const nvx = vx / vLength;
      const nvz = vz / vLength;
      let wx = uy * nvz;
      let wy = uz * nvx - ux * nvz;
      let wz = -uy * nvx;
      const wLength = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
      wx = (wx / wLength) * height * 0.5;
      wy = (wy / wLength) * height * 0.5;
      wz = (wz / wLength) * height * 0.5;
      return builder.orientedBox((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5, dx, dy, dz, vx, 0, vz, wx, wy, wz);
    },
    /**
     * A lathed solid around the local +y axis at (cx, cy, cz): rings [[radius, y], ...] from the
     * bottom up, `sides` segments. radiusAt(ring, side, radius) may perturb each vertex (jagged rock);
     * closeBottom / closeTop add fans to the axis.
     */
    lathe(cx, cy, cz, rings, sides, { radiusAt = null, closeBottom = false, closeTop = false, phase = 0 } = {}) {
      const ringPoints = rings.map(([radius, y], ringIndex) => {
        const points = [];
        for (let side = 0; side < sides; side++) {
          const angle = phase + (side / sides) * Math.PI * 2;
          const r = radiusAt ? radiusAt(ringIndex, side, radius) : radius;
          points.push([cx + Math.sin(angle) * r, cy + y, cz - Math.cos(angle) * r]);
        }
        return points;
      });
      for (let ring = 0; ring < ringPoints.length - 1; ring++) {
        const lower = ringPoints[ring];
        const upper = ringPoints[ring + 1];
        for (let side = 0; side < sides; side++) {
          const next = (side + 1) % sides;
          // Angles run clockwise seen from above, so lower[side] -> upper[side] -> upper[next] faces out.
          builder.quad(lower[side], upper[side], upper[next], lower[next]);
        }
      }
      if (closeBottom) {
        const bottom = ringPoints[0];
        const centreY = cy + rings[0][1];
        for (let side = 0; side < sides; side++) {
          const next = (side + 1) % sides;
          builder.triangle(cx, centreY, cz, bottom[side][0], bottom[side][1], bottom[side][2], bottom[next][0], bottom[next][1], bottom[next][2]);
        }
      }
      if (closeTop) {
        const top = ringPoints[ringPoints.length - 1];
        const centreY = cy + rings[rings.length - 1][1];
        for (let side = 0; side < sides; side++) {
          const next = (side + 1) % sides;
          builder.triangle(cx, centreY, cz, top[next][0], top[next][1], top[next][2], top[side][0], top[side][1], top[side][2]);
        }
      }
      return builder;
    },
    /** A frustum (cylinder or cone) from its base centre, radii and height; capped at both ends. */
    prism(cx, cy, cz, sides, radiusBottom, radiusTop, height, phase = 0) {
      return builder.lathe(cx, cy, cz, [[radiusBottom, 0], [radiusTop, height]], sides, { closeBottom: radiusBottom > 0, closeTop: radiusTop > 0, phase });
    },
    /** Vertices emitted so far. */
    get vertexCount() {
      return positions.length / 3;
    },
    /**
     * The BufferGeometry: position, normal (per face), color (RGBA) and sway, plus uv when asked.
     * Returns null when nothing was emitted.
     */
    toGeometry(THREE) {
      const count = positions.length / 3;
      if (count === 0) return null;
      const positionArray = new Float32Array(positions);
      const normalArray = new Float32Array(count * 3);
      for (let vertex = 0; vertex < count; vertex += 3) {
        const base = vertex * 3;
        const e1x = positionArray[base + 3] - positionArray[base];
        const e1y = positionArray[base + 4] - positionArray[base + 1];
        const e1z = positionArray[base + 5] - positionArray[base + 2];
        const e2x = positionArray[base + 6] - positionArray[base];
        const e2y = positionArray[base + 7] - positionArray[base + 1];
        const e2z = positionArray[base + 8] - positionArray[base + 2];
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        for (let corner = 0; corner < 3; corner++) {
          normalArray[base + corner * 3] = nx;
          normalArray[base + corner * 3 + 1] = ny;
          normalArray[base + corner * 3 + 2] = nz;
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 4));
      geometry.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(sways), 1));
      if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      return geometry;
    },
  };
  return builder;
}

/** 3x3 row-major matrix product a * b. */
function multiply3(a, b) {
  const out = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      out[row * 3 + column] = a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column];
    }
  }
  return out;
}
