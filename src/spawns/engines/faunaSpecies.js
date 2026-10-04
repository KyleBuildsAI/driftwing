// FaunaEngine species: the low-poly meshes and their animation constants (docs/engines/fauna.md).
//
// Every mesh is built in metres at its natural size with the nose toward -z, the wings (or fins)
// along x and up along +y, in the v1 look: flat-shaded facets, warm muted plumage, vertex colours in
// the v1 palette. The fauna engine animates them in the vertex shader:
//   bird   the wings fold at `hinge` (|x| beyond it is wing) and flap about the body axis like the v1
//          birds, bending more toward the tip; between flaps they hold a glide dihedral
//   whale  the body undulates vertically from `tailStart` to the flukes (a travelling wave), and the
//          pectoral fins (|x| beyond `hinge`, ahead of the tail) sweep slowly
//   quadruped  built standing with the hooves at y = 0; the legs (vertices with a `leg` mask) swing
//          about the hip height `gait.hip` in diagonal pairs (a trot), wider as the gait quickens,
//          and the body bobs; standing still freezes them
//   bird with `wade` (the flamingo): built standing, the body at y = 0 and the legs below it; folded
//          on the ground or in the water (wings tucked, legs down, neck up), and in flight the legs
//          trail straight back and the neck reaches forward (the `leg` attribute marks legs and neck)
// Vertices may carry an `emissive` weight (the sky whale's luminous spots).
//
// SPECIES[id] = { id, kind, size (span or length, m), hinge, halfSpan, flap: { rate: [min, max] Hz,
// amplitude, dihedral, glideDihedral }, body: { tailStart, tailEnd, amplitude, wavelength, finAmplitude },
// gait: { hip, stride, amplitude: [walk, run], bob } (quadrupeds), wade: { legHeight, neckBase }
// (wading birds), cruise, speed: [min, max] m/s, minPixels, capacity, spotColor, build(THREE) ->
// BufferGeometry }. Phase 3 wave 1 adds the bison and the caribou (ground herds and columns), the
// dolphin and the flamingo (the water surface); bats, butterflies and camels come with their presets.

/**
 * Collects flat triangles with a colour (sRGB hex) and an emissive weight per triangle, and (after
 * setLeg) a `leg` attribute per vertex: (code, mask). For a quadruped the code is the leg's gait
 * phase offset (radians); for a wading bird 0 marks a leg and 1 the neck. The attribute is written
 * only when some part set it.
 */
function createMeshBuilder(THREE) {
  const positions = [];
  const colors = [];
  const emissive = [];
  const legs = [];
  const scratch = new THREE.Color();
  const leg = { code: 0, mask: 0, used: false };
  return {
    /** Marks everything emitted next as a limb (code, mask 1), or the body again (null). */
    setLeg(code) {
      if (code === null) {
        leg.code = 0;
        leg.mask = 0;
        return;
      }
      leg.code = code;
      leg.mask = 1;
      leg.used = true;
    },
    triangle(a, b, c, hex, glow = 0) {
      positions.push(...a, ...b, ...c);
      scratch.setHex(hex);
      for (let vertex = 0; vertex < 3; vertex++) {
        colors.push(scratch.r, scratch.g, scratch.b);
        emissive.push(glow);
        legs.push(leg.code, leg.mask);
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
      if (leg.used) geometry.setAttribute('leg', new THREE.Float32BufferAttribute(legs, 2));
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

/** An axis-aligned box (centre, full sizes) of six quads, one colour (sides darker below the top). */
function box(builder, cx, cy, cz, sx, sy, sz, hex, sideHex = hex) {
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  builder.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], hex);
  builder.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], sideHex);
  builder.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], sideHex);
  builder.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], sideHex);
  builder.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], sideHex);
  builder.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], sideHex);
}

/**
 * A quadruped standing with its hooves at y = 0, nose toward -z: a lofted body (hump, barrel,
 * haunches), a head and muzzle, four legs (diagonal pairs share a gait phase: front left and back
 * right 0, the others pi), a tail, and horns or antlers. spec (m): length, hip (leg top), shoulder,
 * hump, rump, width, legWidth, head: { length, drop, width }, horns | antlers, colours.
 */
function buildQuadruped(THREE, spec) {
  const builder = createMeshBuilder(THREE);
  const half = spec.length / 2;
  const hip = spec.hip;
  const width = spec.width;
  // Body rings: z, half width, half height, centre height.
  const bodyTop = (share) => spec.rump + (spec.shoulder + spec.hump - spec.rump) * Math.max(0, 1 - Math.abs(share + 0.45) / 0.55) ** 1.4;
  const ringAt = (share, widthShare) => {
    const top = Math.max(bodyTop(share), spec.rump);
    const bottom = hip - 0.08;
    return { z: share * half, width: width * widthShare, height: (top - bottom) / 2, lift: (top + bottom) / 2 };
  };
  const rings = [ringAt(-0.72, 0.62), ringAt(-0.48, 0.95), ringAt(-0.2, 1), ringAt(0.15, 0.96), ringAt(0.48, 0.9), ringAt(0.7, 0.62)];
  loft(builder, rings, 7, (ring, side, upward) => {
    if (spec.mane && ring <= 2 && upward) return spec.mane;
    return upward ? spec.back : spec.belly;
  }, [0, rings[0].lift, -half * 0.8], [0, rings[rings.length - 1].lift, half * 0.78]);
  // Head: a lofted muzzle hanging in front of the shoulders.
  const head = spec.head;
  const headTop = rings[0].lift + rings[0].height * 0.3;
  const headZ = -half * 0.74;
  const headRings = [
    { z: headZ, width: head.width * 0.55, height: head.width * 0.62, lift: headTop - head.drop * 0.25 },
    { z: headZ - head.length * 0.55, width: head.width * 0.48, height: head.width * 0.5, lift: headTop - head.drop * 0.7 },
    { z: headZ - head.length * 0.95, width: head.width * 0.34, height: head.width * 0.34, lift: headTop - head.drop },
  ];
  loft(builder, headRings, 6, (ring, side, upward) => (ring >= 3 ? spec.muzzle : upward ? spec.headColor : spec.belly), [0, headTop - head.drop * 0.1, headZ + 0.05], [0, headTop - head.drop * 1.05, headZ - head.length * 1.05]);
  if (spec.horns) {
    const hornBase = [head.width * 0.45, headTop + head.width * 0.15, headZ - head.length * 0.15];
    builder.mirrored(hornBase, [head.width * 0.95, headTop + head.width * 0.55, headZ - head.length * 0.05], [head.width * 0.5, headTop + head.width * 0.2, headZ - head.length * 0.3], spec.horns);
    builder.mirrored(hornBase, [head.width * 0.5, headTop + head.width * 0.2, headZ - head.length * 0.3], [head.width * 0.95, headTop + head.width * 0.55, headZ - head.length * 0.05], spec.horns);
  }
  if (spec.antlers) {
    const base = [head.width * 0.3, headTop + head.width * 0.2, headZ - head.length * 0.12];
    const spread = spec.antlers.spread;
    const tall = spec.antlers.height;
    const beams = [
      [base, [spread * 0.55, base[1] + tall * 0.55, base[2] + 0.18]],
      [[spread * 0.55, base[1] + tall * 0.55, base[2] + 0.18], [spread, base[1] + tall, base[2] - 0.1]],
      [[spread * 0.45, base[1] + tall * 0.45, base[2] + 0.15], [spread * 0.3, base[1] + tall * 0.85, base[2] - 0.32]],
      [[spread * 0.7, base[1] + tall * 0.7, base[2] + 0.08], [spread * 0.95, base[1] + tall * 0.62, base[2] + 0.42]],
    ];
    const thick = 0.035;
    for (const [from, to] of beams) {
      builder.mirrored(from, to, [from[0] + thick, from[1] - thick, from[2]], spec.antlers.color);
      builder.mirrored(from, [from[0] + thick, from[1] - thick, from[2]], to, spec.antlers.color);
    }
  }
  // Tail.
  const tailRoot = [0, spec.rump - 0.05, half * 0.76];
  builder.triangle(tailRoot, [0.05, spec.rump - spec.length * 0.2, half * 0.86], [-0.05, spec.rump - spec.length * 0.2, half * 0.86], spec.tail);
  builder.triangle(tailRoot, [-0.05, spec.rump - spec.length * 0.2, half * 0.86], [0.05, spec.rump - spec.length * 0.2, half * 0.86], spec.tail);
  // Legs: boxes from the hoof to just inside the body; the hoof a darker band.
  const legX = width * 0.58;
  const legs = [
    { x: -legX, z: -half * 0.42, phase: 0 },
    { x: legX, z: -half * 0.42, phase: Math.PI },
    { x: -legX, z: half * 0.46, phase: Math.PI },
    { x: legX, z: half * 0.46, phase: 0 },
  ];
  const legTop = hip + 0.12;
  for (const entry of legs) {
    builder.setLeg(entry.phase);
    box(builder, entry.x, (legTop + 0.12) / 2, entry.z, spec.legWidth, legTop - 0.12, spec.legWidth, spec.leg, spec.legShade ?? spec.leg);
    box(builder, entry.x, 0.06, entry.z, spec.legWidth * 1.08, 0.12, spec.legWidth * 1.15, spec.hoof);
  }
  builder.setLeg(null);
  return builder.finish();
}

/**
 * A wading bird (the flamingo): buildBird's body, tail and wings with a long neck rising from the
 * breast to a bent beak, and two long legs below the body (the `leg` attribute: legs 0, neck 1).
 */
function buildWader(THREE, spec) {
  const builder = createMeshBuilder(THREE);
  const bird = buildBird(THREE, spec);
  // The bird's own triangles first (no leg attribute on them).
  const position = bird.getAttribute('position');
  const color = bird.getAttribute('color');
  for (let index = 0; index < position.count; index += 3) {
    const a = [position.getX(index), position.getY(index), position.getZ(index)];
    const b = [position.getX(index + 1), position.getY(index + 1), position.getZ(index + 1)];
    const c = [position.getX(index + 2), position.getY(index + 2), position.getZ(index + 2)];
    const hex = new THREE.Color(color.getX(index), color.getY(index), color.getZ(index)).getHex();
    builder.triangle(a, b, c, hex);
  }
  bird.dispose();
  const neckBase = spec.neckBase;
  const neckTop = [0, neckBase[1] + spec.neckLength, neckBase[2] - spec.neckLength * 0.12];
  const thick = spec.neckWidth;
  builder.setLeg(1);
  // The neck: a four-sided column from the breast to the head, with a slight S.
  const middle = [0, neckBase[1] + spec.neckLength * 0.55, neckBase[2] + spec.neckLength * 0.08];
  const column = [neckBase, middle, neckTop];
  for (let segment = 0; segment < 2; segment++) {
    const from = column[segment];
    const to = column[segment + 1];
    const corners = (point, size) => [
      [point[0] - size, point[1], point[2] - size],
      [point[0] + size, point[1], point[2] - size],
      [point[0] + size, point[1], point[2] + size],
      [point[0] - size, point[1], point[2] + size],
    ];
    const lower = corners(from, thick * (segment === 0 ? 1.3 : 1));
    const upper = corners(to, thick);
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      builder.quad(lower[side], lower[next], upper[next], upper[side], spec.neckColor);
    }
  }
  // Head and the bent, black-tipped beak.
  box(builder, 0, neckTop[1] + thick, neckTop[2] - thick * 0.6, thick * 2.2, thick * 2.2, thick * 3, spec.head);
  const beakRoot = [0, neckTop[1] + thick * 0.6, neckTop[2] - thick * 2.1];
  builder.mirrored(beakRoot, [thick * 0.6, neckTop[1] + thick * 0.2, neckTop[2] - thick * 3.6], [0, neckTop[1] - thick * 1.6, neckTop[2] - thick * 3.4], spec.beak);
  builder.mirrored([0, neckTop[1] - thick * 0.4, neckTop[2] - thick * 3.2], [thick * 0.5, neckTop[1] - thick * 1.1, neckTop[2] - thick * 3.5], [0, neckTop[1] - thick * 2.4, neckTop[2] - thick * 3.1], spec.beakTip);
  // Legs: thin columns from the body to the feet, knees a little thicker.
  builder.setLeg(0);
  const legHeight = spec.legHeight;
  for (const x of [-spec.legSpread, spec.legSpread]) {
    box(builder, x, -legHeight * 0.3, spec.legZ, spec.legWidth, legHeight * 0.6, spec.legWidth, spec.legColor);
    box(builder, x, -legHeight * 0.6, spec.legZ, spec.legWidth * 1.6, spec.legWidth * 1.6, spec.legWidth * 1.6, spec.legColor);
    box(builder, x, -legHeight * 0.8, spec.legZ, spec.legWidth, legHeight * 0.4, spec.legWidth, spec.legColor);
    box(builder, x, -legHeight + 0.01, spec.legZ - 0.04, spec.legWidth * 2.2, 0.02, spec.legWidth * 4, spec.legColor);
  }
  builder.setLeg(null);
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
  bison: Object.freeze({
    id: 'bison',
    kind: 'quadruped',
    size: 3.1,
    halfSpan: 0.6,
    hinge: 0,
    gait: Object.freeze({ hip: 0.8, stride: 2.1, amplitude: Object.freeze([0.34, 0.74]), bob: 0.07 }),
    cruise: 1.2,
    speed: Object.freeze([0, 14]),
    minPixels: 1.6,
    capacity: 512,
    build: (THREE) => buildQuadruped(THREE, {
      length: 3.1, hip: 0.8, shoulder: 1.55, hump: 0.42, rump: 1.42, width: 0.48, legWidth: 0.17,
      head: { length: 0.62, drop: 0.5, width: 0.42 }, horns: 0x2a2420,
      back: 0x5a3f2a, belly: 0x3e2b1e, mane: 0x3a2618, headColor: 0x2e2018, muzzle: 0x231914,
      tail: 0x2e2018, leg: 0x3a2a1e, legShade: 0x2f2219, hoof: 0x1d1714,
    }),
  }),
  caribou: Object.freeze({
    id: 'caribou',
    kind: 'quadruped',
    size: 2.0,
    halfSpan: 0.4,
    hinge: 0,
    gait: Object.freeze({ hip: 0.78, stride: 1.75, amplitude: Object.freeze([0.3, 0.7]), bob: 0.05 }),
    cruise: 1.6,
    speed: Object.freeze([0, 16]),
    minPixels: 1.4,
    capacity: 2048,
    build: (THREE) => buildQuadruped(THREE, {
      length: 2.0, hip: 0.78, shoulder: 1.18, hump: 0.08, rump: 1.12, width: 0.3, legWidth: 0.09,
      head: { length: 0.46, drop: 0.12, width: 0.24 }, antlers: { spread: 0.55, height: 0.85, color: 0x8a7558 },
      back: 0x7a6650, belly: 0xd8cfc0, mane: 0xe4ddd0, headColor: 0x6a5845, muzzle: 0x3a3029,
      tail: 0xe8e2d6, leg: 0x6e5c48, legShade: 0x5c4c3c, hoof: 0x26201c,
    }),
  }),
  dolphin: Object.freeze({
    id: 'dolphin',
    kind: 'whale',
    size: 2.4,
    halfSpan: 0.55,
    hinge: 0.24,
    body: Object.freeze({ tailStart: -0.15, tailEnd: 1.3, amplitude: 0.16, wavelength: 2.9, finAmplitude: 0.1, rate: Object.freeze([1.5, 2.1]) }),
    cruise: 5,
    speed: Object.freeze([1, 11]),
    minPixels: 1.3,
    capacity: 128,
    build: (THREE) => buildWhale(THREE, {
      length: 2.4, girth: 0.3, fin: 0.36, flukes: 0.62, spots: 0,
      back: 0x5d6b78, belly: 0xd9dee2, finColor: 0x56636f, spotColor: 0xffffff,
    }),
  }),
  flamingo: Object.freeze({
    id: 'flamingo',
    kind: 'bird',
    size: 1.5,
    halfSpan: 0.75,
    hinge: 0.1,
    flap: Object.freeze({ rate: Object.freeze([2.7, 3.3]), amplitude: 0.62, dihedral: 0.06, glideDihedral: 0.05, glideShare: 0.15 }),
    wade: Object.freeze({ legHeight: 0.92, neckBase: Object.freeze([0, 0.08, -0.26]), legTop: Object.freeze([0, -0.04, 0.04]) }),
    cruise: 14,
    speed: Object.freeze([0, 22]),
    minPixels: 1.8,
    capacity: 512,
    build: (THREE) => buildWader(THREE, {
      span: 1.5, length: 0.62, chord: 0.24, sweep: 0.08, bodyWidth: 0.11, neck: 0, tail: 'wedge', tailLength: 0.12, tailWidth: 0.16,
      head: 0xf2a3a8, back: 0xf0a0a6, belly: 0xf6b8bb, beak: 0xf1dcd2, wing: 0xec8f98, wingTip: 0x1c1a1a, tailColor: 0xe88a94,
      neckBase: [0, 0.08, -0.26], neckLength: 0.62, neckWidth: 0.028, neckColor: 0xf2a6ab, beakTip: 0x1a1717,
      legHeight: 0.92, legSpread: 0.03, legZ: 0.04, legWidth: 0.018, legColor: 0xe0767f,
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
