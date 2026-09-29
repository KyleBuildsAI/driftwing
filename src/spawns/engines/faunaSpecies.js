// FaunaEngine species: the low-poly meshes and their animation constants (docs/engines/fauna.md).
//
// Every mesh is built in metres at its natural size with the nose toward -z, the wings (or fins)
// along x and up along +y, in the v1 look: flat-shaded facets, warm muted plumage, vertex colours in
// the v1 palette. The fauna engine animates them in the vertex shader:
//   bird   the wings fold at `hinge` (|x| beyond it is wing) and flap about the body axis like the v1
//          birds, bending more toward the tip; between flaps they hold a glide dihedral
//   whale  the body undulates vertically from `tailStart` to the flukes (a travelling wave), and the
//          pectoral fins (|x| beyond `hinge`, ahead of the tail) sweep slowly
// Vertices may carry an `emissive` weight (the sky whale's luminous spots).
//
// SPECIES[id] = { id, kind, size (span or length, m), hinge, halfSpan, flap: { rate: [min, max] Hz,
// amplitude, dihedral, glideDihedral }, body: { tailStart, tailEnd, amplitude, wavelength, finAmplitude },
// cruise, speed: [min, max] m/s, minPixels, capacity, spotColor, build(THREE) -> BufferGeometry }.
// Phase 3 adds species here (ground herds, dolphins, flamingos, bats, butterflies).

/** Collects flat triangles with a colour (sRGB hex) and an emissive weight per triangle. */
function createMeshBuilder(THREE) {
  const positions = [];
  const colors = [];
  const emissive = [];
  const scratch = new THREE.Color();
  return {
    triangle(a, b, c, hex, glow = 0) {
      positions.push(...a, ...b, ...c);
      scratch.setHex(hex);
      for (let vertex = 0; vertex < 3; vertex++) {
        colors.push(scratch.r, scratch.g, scratch.b);
        emissive.push(glow);
      }
    },
    quad(a, b, c, d, hex, glow = 0) {
      this.triangle(a, b, c, hex, glow);
      this.triangle(a, c, d, hex, glow);
    },
    /** Mirrors a triangle across x = 0 (winding flipped so both faces point outward). */
    mirrored(a, b, c, hex, glow = 0) {
      this.triangle(a, b, c, hex, glow);
      this.triangle([-a[0], a[1], a[2]], [-c[0], c[1], c[2]], [-b[0], b[1], b[2]], hex, glow);
    },
    finish() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('emissive', new THREE.Float32BufferAttribute(emissive, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return geometry;
    },
  };
}

/**
 * A lofted body: rings of `sides` points along z ({ z, width, height, lift }), closed with a point at
 * each end. colorAt(ringIndex, sideIndex, upward) picks each facet's colour (upward: the facet faces
 * up). Returns nothing; writes into the builder.
 */
function loft(builder, rings, sides, colorAt, nose, tail) {
  const points = rings.map((ring) => {
    const list = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      list.push([Math.cos(angle) * ring.width, ring.lift + Math.sin(angle) * ring.height, ring.z]);
    }
    return list;
  });
  const facetColor = (ringIndex, side) => {
    const angle = ((side + 0.5) / sides) * Math.PI * 2;
    return colorAt(ringIndex, side, Math.sin(angle) > 0);
  };
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    builder.triangle(nose, points[0][next], points[0][side], facetColor(0, side));
    for (let ring = 0; ring < rings.length - 1; ring++) {
      builder.quad(points[ring][side], points[ring][next], points[ring + 1][next], points[ring + 1][side], facetColor(ring + 1, side));
    }
    const last = points[rings.length - 1];
    builder.triangle(tail, last[side], last[next], facetColor(rings.length, side));
  }
}

/**
 * A bird: body, head, tail and two wings with primaries. spec (m): span, length, chord, sweep,
 * bodyWidth, neck (extra length ahead of the wings), tail ('fan' | 'wedge'), and colours.
 */
function buildBird(THREE, spec) {
  const builder = createMeshBuilder(THREE);
  const half = spec.span / 2;
  const bodyWidth = spec.bodyWidth;
  const length = spec.length;
  const front = -length * 0.5 - spec.neck;
  const rings = [
    { z: front + length * 0.08, width: bodyWidth * 0.45, height: bodyWidth * 0.45, lift: bodyWidth * 0.2 },
    { z: front + length * 0.2 + spec.neck * 0.2, width: bodyWidth * 0.55, height: bodyWidth * 0.55, lift: bodyWidth * 0.15 },
    { z: -length * 0.12, width: bodyWidth, height: bodyWidth * 0.9, lift: 0 },
    { z: length * 0.12, width: bodyWidth * 0.85, height: bodyWidth * 0.75, lift: 0 },
    { z: length * 0.32, width: bodyWidth * 0.4, height: bodyWidth * 0.35, lift: bodyWidth * 0.1 },
  ];
  const beak = [0, bodyWidth * 0.15, front - length * 0.08];
  const rump = [0, bodyWidth * 0.12, length * 0.36];
  loft(builder, rings, 5, (ring, side, upward) => {
    if (ring <= 1) return spec.head;
    if (spec.neck > 0 && ring === 2 && upward) return spec.neckColor ?? spec.back;
    return upward ? spec.back : spec.belly;
  }, beak, rump);
  // Beak and cheek accents (a small wedge at the nose).
  builder.mirrored([0, bodyWidth * 0.2, front - length * 0.02], [bodyWidth * 0.2, bodyWidth * 0.15, front + length * 0.06], beak, spec.beak);
  if (spec.cheek) {
    builder.mirrored([bodyWidth * 0.46, bodyWidth * 0.25, front + length * 0.1], [bodyWidth * 0.5, bodyWidth * 0.05, front + length * 0.2 + spec.neck * 0.2], [bodyWidth * 0.3, bodyWidth * 0.0, front + length * 0.1], spec.cheek);
  }
  // Tail.
  const tailRoot = length * 0.26;
  const tailLength = spec.tailLength;
  if (spec.tail === 'fan') {
    builder.mirrored([0, 0.01, tailRoot], [spec.tailWidth * 0.55, 0.01, tailRoot + tailLength], [0, 0.01, tailRoot + tailLength * 1.06], spec.tailColor);
    builder.mirrored([0, 0.01, tailRoot], [spec.tailWidth * 0.22, 0.01, tailRoot + tailLength * 0.2], [spec.tailWidth * 0.55, 0.01, tailRoot + tailLength], spec.tailColor);
  } else {
    builder.mirrored([0, 0.01, tailRoot], [spec.tailWidth * 0.5, 0.01, tailRoot + tailLength], [0, 0.01, tailRoot + tailLength * 0.85], spec.tailColor);
  }
  // Wings (mirrored): root at the hinge, wrist, tip, trailing primaries.
  const hinge = bodyWidth * 0.95;
  const chord = spec.chord;
  const sweep = spec.sweep;
  const rootFront = [hinge, 0.02, -chord * 0.5];
  const rootBack = [hinge, 0.02, chord * 0.5];
  const wristFront = [half * 0.46, 0.02, -chord * 0.42 + sweep * 0.3];
  const wristBack = [half * 0.43, 0.02, chord * 0.62 + sweep * 0.3];
  const tip = [half, 0.02, chord * 0.25 + sweep];
  const primaryBack = [half * 0.74, 0.02, chord * 0.8 + sweep * 0.7];
  builder.mirrored(rootFront, wristFront, rootBack, spec.wing);
  builder.mirrored(wristFront, wristBack, rootBack, spec.wing);
  builder.mirrored(wristFront, tip, wristBack, spec.wingTip);
  builder.mirrored(wristBack, tip, primaryBack, spec.wingTip);
  if (spec.fingers) {
    // Slotted primaries (eagles, hawks): notches along the trailing tip.
    const fingerRoot = [half * 0.8, 0.02, chord * 0.55 + sweep * 0.8];
    builder.mirrored(tip, [half * 1.02, 0.02, chord * 0.62 + sweep], fingerRoot, spec.wingTip);
    builder.mirrored(fingerRoot, [half * 0.95, 0.02, chord * 0.95 + sweep * 0.9], primaryBack, spec.wingTip);
  }
  return builder.finish();
}

/**
 * A whale: a lofted body, pectoral fins, a dorsal fin and flukes. spec (m): length, girth, fin
 * (pectoral length), flukes (span), colours, and spots (luminous spots per flank, the sky whale).
 */
function buildWhale(THREE, spec) {
  const builder = createMeshBuilder(THREE);
  const length = spec.length;
  const girth = spec.girth;
  const profile = [
    [-0.46, 0.34, 0.3, 0.02],
    [-0.36, 0.72, 0.62, 0.02],
    [-0.2, 0.95, 0.86, 0],
    [0, 1, 0.9, 0],
    [0.16, 0.86, 0.78, 0.02],
    [0.3, 0.55, 0.52, 0.05],
    [0.4, 0.26, 0.24, 0.07],
  ];
  const rings = profile.map(([z, width, height, lift]) => ({ z: z * length, width: width * girth, height: height * girth, lift: lift * girth }));
  loft(builder, rings, 7, (ring, side, upward) => (upward ? spec.back : spec.belly), [0, 0.02 * girth, -0.5 * length], [0, 0.07 * girth, 0.45 * length]);
  // Throat grooves read as a pale band under the jaw.
  builder.mirrored([0.2 * girth, -0.3 * girth, -0.45 * length], [0.55 * girth, -0.5 * girth, -0.3 * length], [0.1 * girth, -0.6 * girth, -0.3 * length], spec.belly);
  // Pectoral fins: long blades behind the head, dark on top, pale beneath.
  const finRootFront = [girth * 0.7, -0.25 * girth, -0.26 * length];
  const finRootBack = [girth * 0.7, -0.3 * girth, -0.16 * length];
  const finTip = [girth * 0.7 + spec.fin, -0.55 * girth, -0.05 * length];
  builder.mirrored(finRootFront, finTip, finRootBack, spec.finColor);
  builder.mirrored(finRootFront, finRootBack, finTip, spec.belly);
  // Dorsal fin.
  builder.triangle([0, 0.8 * girth, 0.16 * length], [0, 1.25 * girth, 0.24 * length], [0, 0.62 * girth, 0.3 * length], spec.back);
  builder.triangle([0, 0.8 * girth, 0.16 * length], [0, 0.62 * girth, 0.3 * length], [0, 1.25 * girth, 0.24 * length], spec.back);
  // Flukes.
  const flukeRoot = [0, 0.07 * girth, 0.45 * length];
  const flukeSpan = spec.flukes / 2;
  builder.mirrored(flukeRoot, [flukeSpan * 0.35, 0.07 * girth, 0.46 * length], [flukeSpan, 0.08 * girth, 0.56 * length], spec.back);
  builder.mirrored(flukeRoot, [flukeSpan, 0.08 * girth, 0.56 * length], [flukeSpan * 0.2, 0.07 * girth, 0.53 * length], spec.back);
  builder.mirrored(flukeRoot, [flukeSpan, 0.06 * girth, 0.56 * length], [flukeSpan * 0.35, 0.06 * girth, 0.46 * length], spec.belly);
  builder.mirrored(flukeRoot, [flukeSpan * 0.2, 0.06 * girth, 0.53 * length], [flukeSpan, 0.06 * girth, 0.56 * length], spec.belly);
  // Luminous spots: small diamonds standing just off each flank.
  for (let index = 0; index < spec.spots; index++) {
    const along = -0.3 + (0.62 * index) / Math.max(1, spec.spots - 1);
    const t = along;
    const width = girth * (0.95 - 1.3 * t * t) * 1.02;
    const y = girth * (0.1 + 0.18 * Math.sin(index * 2.1));
    const z = along * length;
    const size = girth * 0.09;
    builder.mirrored([width, y + size, z], [width + 0.01, y, z + size * 1.4], [width, y - size, z], spec.spotColor, 1);
    builder.mirrored([width, y + size, z], [width, y - size, z], [width + 0.01, y, z - size * 1.4], spec.spotColor, 1);
  }
  return builder.finish();
}

export const SPECIES = Object.freeze({
  starling: Object.freeze({
    id: 'starling',
    kind: 'bird',
    size: 0.38,
    halfSpan: 0.19,
    hinge: 0.03,
    flap: Object.freeze({ rate: Object.freeze([11, 15]), amplitude: 0.78, dihedral: 0.1, glideDihedral: 0.06, glideShare: 0.25 }),
    cruise: 13,
    speed: Object.freeze([8, 21]),
    minPixels: 1.7,
    capacity: 8192,
    build: (THREE) => buildBird(THREE, {
      span: 0.38, length: 0.2, chord: 0.07, sweep: 0.05, bodyWidth: 0.03, neck: 0, tail: 'wedge', tailLength: 0.06, tailWidth: 0.07,
      head: 0x221c1c, back: 0x2e2724, belly: 0x3a302b, beak: 0xb89a4a, wing: 0x241e1c, wingTip: 0x161312, tailColor: 0x1c1817,
    }),
  }),
  goose: Object.freeze({
    id: 'goose',
    kind: 'bird',
    size: 1.65,
    halfSpan: 0.825,
    hinge: 0.135,
    flap: Object.freeze({ rate: Object.freeze([3.1, 3.7]), amplitude: 0.62, dihedral: 0.08, glideDihedral: 0.05, glideShare: 0.05 }),
    cruise: 18,
    speed: Object.freeze([11, 32]),
    minPixels: 2.4,
    capacity: 96,
    build: (THREE) => buildBird(THREE, {
      span: 1.65, length: 0.72, chord: 0.26, sweep: 0.12, bodyWidth: 0.135, neck: 0.36, tail: 'wedge', tailLength: 0.16, tailWidth: 0.2,
      head: 0x1c1a19, neckColor: 0x1c1a19, back: 0x7a6a58, belly: 0xcdbfa8, beak: 0x1a1817, cheek: 0xefeae0,
      wing: 0x6b5c4c, wingTip: 0x3a322b, tailColor: 0x2a2522,
    }),
  }),
  hawk: Object.freeze({
    id: 'hawk',
    kind: 'bird',
    size: 1.25,
    halfSpan: 0.625,
    hinge: 0.095,
    flap: Object.freeze({ rate: Object.freeze([3.6, 4.4]), amplitude: 0.55, dihedral: 0.12, glideDihedral: 0.16, glideShare: 0.92 }),
    cruise: 11,
    speed: Object.freeze([7, 24]),
    minPixels: 2.2,
    capacity: 64,
    build: (THREE) => buildBird(THREE, {
      span: 1.25, length: 0.52, chord: 0.3, sweep: 0.06, bodyWidth: 0.095, neck: 0, tail: 'fan', tailLength: 0.2, tailWidth: 0.26, fingers: true,
      head: 0x5e3f28, back: 0x6e4a2f, belly: 0xd8c3a0, beak: 0x3a3230, wing: 0x7a5434, wingTip: 0x3b2a1e, tailColor: 0xa4502c,
    }),
  }),
  eagle: Object.freeze({
    id: 'eagle',
    kind: 'bird',
    size: 2.1,
    halfSpan: 1.05,
    hinge: 0.16,
    flap: Object.freeze({ rate: Object.freeze([2.4, 2.9]), amplitude: 0.5, dihedral: 0.1, glideDihedral: 0.13, glideShare: 0.8 }),
    cruise: 18,
    speed: Object.freeze([9, 36]),
    minPixels: 3,
    capacity: 8,
    build: (THREE) => buildBird(THREE, {
      span: 2.1, length: 0.9, chord: 0.46, sweep: 0.08, bodyWidth: 0.16, neck: 0.05, tail: 'fan', tailLength: 0.3, tailWidth: 0.34, fingers: true,
      head: 0xf0ece2, back: 0x3d2a1e, belly: 0x33241a, beak: 0xe8b33a, wing: 0x3a281c, wingTip: 0x241a13, tailColor: 0xefe9dc,
    }),
  }),
  whale: Object.freeze({
    id: 'whale',
    kind: 'whale',
    size: 14,
    halfSpan: 4.6,
    hinge: 1.85,
    body: Object.freeze({ tailStart: -1, tailEnd: 7.8, amplitude: 0.9, wavelength: 18, finAmplitude: 0.22, rate: Object.freeze([0.22, 0.3]) }),
    cruise: 3,
    speed: Object.freeze([0.8, 7]),
    minPixels: 0,
    capacity: 24,
    build: (THREE) => buildWhale(THREE, {
      length: 14, girth: 1.75, fin: 4.2, flukes: 4.6, spots: 0,
      back: 0x2f3a44, belly: 0xc9ccc8, finColor: 0x34404b, spotColor: 0xffffff,
    }),
  }),
  skyWhale: Object.freeze({
    id: 'skyWhale',
    kind: 'whale',
    size: 1,
    halfSpan: 0.34,
    hinge: 0.14,
    body: Object.freeze({ tailStart: -0.05, tailEnd: 0.56, amplitude: 0.05, wavelength: 1.35, finAmplitude: 0.3, rate: Object.freeze([0.06, 0.08]) }),
    cruise: 7,
    speed: Object.freeze([2, 16]),
    minPixels: 0,
    capacity: 4,
    spotColor: 0x9fe8ff,
    build: (THREE) => buildWhale(THREE, {
      length: 1, girth: 0.13, fin: 0.21, flukes: 0.34, spots: 9,
      back: 0x7d8fa6, belly: 0xd8e2ec, finColor: 0x8a9db3, spotColor: 0xbff4ff,
    }),
  }),
});

export const SPECIES_IDS = Object.freeze(Object.keys(SPECIES));
