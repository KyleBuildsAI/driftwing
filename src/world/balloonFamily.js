// The v1 hot-air balloon family: the envelope profile, palettes and gore patterns the balloon fair
// landmarks (src/world/landmarks.js) have flown since v1, shared with the flyable hot air balloon
// (src/craft/balloon.js) so both come from one design. Plus the envelope geometry the balloon's
// flight model needs (volume, buoyancy centroid, areas), integrated from the same profile.
//
// Pure data and maths: no three.js, no DOM.

/**
 * Unit envelope profile from the mouth (bottom) to the crown: [radius, height], both as shares of
 * the envelope height (mouth to crown). The first ring is the skirt just below the mouth.
 */
export const BALLOON_PROFILE = Object.freeze([
  [0.125, -0.05], [0.13, 0], [0.19, 0.07], [0.3, 0.19], [0.41, 0.32], [0.49, 0.46],
  [0.53, 0.6], [0.52, 0.72], [0.46, 0.83], [0.36, 0.91], [0.22, 0.97], [0, 1],
].map((ring) => Object.freeze(ring)));

/** Index of the profile's mouth ring (the skirt ring sits below it). */
export const BALLOON_MOUTH_RING = 1;

/** Envelope palettes (sRGB hex): [first, second, third] gore colours. */
export const BALLOON_PALETTES = Object.freeze([
  [0xe0703a, 0xf1e4cf, 0x2c2f38],
  [0xd9483b, 0xf6d44c, 0x2f6db3],
  [0x2a9d8f, 0xe9c46a, 0xf4a261],
  [0x6a4c93, 0xf2c94c, 0xf1e4cf],
  [0x3a7ca5, 0xf1e4cf, 0xe0703a],
  [0xc0392b, 0xf5e6c8, 0x3f8f5a],
  [0xe58fa6, 0xf7f1e3, 0x5fb3b6],
  [0xf28c28, 0x5b3f8c, 0xf6e7c1],
].map((palette) => Object.freeze(palette)));

export const BALLOON_PATTERNS = Object.freeze(['gores', 'spiral', 'harlequin', 'bands', 'crown', 'sunburst']);

/**
 * Which palette colour (0, 1 or 2) paints the gore panel at `row` (0 = just above the mouth) and
 * `segment` (around the envelope) for a pattern.
 */
export function balloonPatternIndex(pattern, row, segment) {
  switch (pattern) {
    case 'gores': return row >= 8 ? 2 : segment % 2;
    case 'spiral': return (segment + row) % 4 < 2 ? 0 : 1;
    case 'harlequin': return row >= 8 ? 2 : (segment + row) % 2;
    case 'bands': return row >= 8 ? 2 : (row >= 5 && row <= 6) || row <= 1 ? 1 : 0;
    case 'crown': return row >= 7 ? (segment % 2 === 0 ? 2 : 1) : row === 5 ? 2 : 0;
    default: return row >= 8 ? 1 : segment % 4 === 0 ? 2 : segment % 4 === 2 ? 1 : 0;
  }
}

/**
 * The envelope of a given height (m, mouth to crown) as a solid of revolution of the profile,
 * integrated ring to ring (each band a conical frustum): { volume (m^3), centroid (m above the
 * mouth: where the buoyancy acts), maxRadius (m), sideArea (m^2, the silhouette seen from the side:
 * horizontal drag), topArea (m^2, seen from above: vertical drag), surfaceArea (m^2, the fabric:
 * heat loss) }. The skirt below the mouth is open fabric and holds no air.
 */
export function envelopeGeometry(height) {
  let volume = 0;
  let moment = 0;
  let sideArea = 0;
  let surfaceArea = 0;
  let maxRadius = 0;
  for (let ring = BALLOON_MOUTH_RING; ring < BALLOON_PROFILE.length - 1; ring++) {
    const [radiusA, shareA] = BALLOON_PROFILE[ring];
    const [radiusB, shareB] = BALLOON_PROFILE[ring + 1];
    const r1 = radiusA * height;
    const r2 = radiusB * height;
    const y1 = shareA * height;
    const y2 = shareB * height;
    const span = y2 - y1;
    // Frustum volume and its centroid height.
    const bandVolume = (Math.PI * span * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
    const centroid = r1 + r2 > 0 ? y1 + (span * (r1 * r1 + 2 * r1 * r2 + 3 * r2 * r2)) / (4 * (r1 * r1 + r1 * r2 + r2 * r2)) : y1;
    volume += bandVolume;
    moment += bandVolume * centroid;
    sideArea += span * (r1 + r2);
    surfaceArea += Math.PI * (r1 + r2) * Math.hypot(span, r2 - r1);
    maxRadius = Math.max(maxRadius, r1, r2);
  }
  return {
    volume,
    centroid: volume > 0 ? moment / volume : 0,
    maxRadius,
    sideArea,
    topArea: Math.PI * maxRadius * maxRadius,
    surfaceArea,
  };
}

/** The envelope radius (m) at a height above the mouth (m), interpolated along the profile. */
export function envelopeRadiusAt(height, above) {
  const share = above / height;
  for (let ring = BALLOON_MOUTH_RING; ring < BALLOON_PROFILE.length - 1; ring++) {
    const [radiusA, shareA] = BALLOON_PROFILE[ring];
    const [radiusB, shareB] = BALLOON_PROFILE[ring + 1];
    if (share <= shareB) {
      const t = Math.min(1, Math.max(0, (share - shareA) / (shareB - shareA)));
      return (radiusA + (radiusB - radiusA) * t) * height;
    }
  }
  return 0;
}
