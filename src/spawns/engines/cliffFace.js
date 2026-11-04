// Cliff faces for caves (preset 48, the bats at dusk): the steepest high ground near a point, found the
// same way by every engine part that needs it (the structure engine's cave mouth and the fauna
// engine's bat stream), so the parts of one spawn agree on where the cave is without talking to each
// other. Pure: it reads only the height function it is handed (no three.js, no DOM), at whole-metre
// coordinates, so the same activation always finds the same face.

/** The search grid: GRID x GRID points over the square of the search radius. */
const GRID = 13;
/** Central differences this far apart (m) give the slope at a point. */
const SLOPE_STEP = 8;
/** A face must slope at least this much (rise over run) and stand this high above the sea (m). */
const MIN_SLOPE = 0.55;
const MIN_HEIGHT = 25;
/** Steeper faces score higher up to this slope; beyond it height decides (a cave high on the face). */
const SLOPE_CAP = 2.2;

/**
 * The steepest high face within `radius` metres of (x, z), or null when the ground there is gentle.
 * heightAt(x, z): the world's ground height (m); waterLevel: the sea level (m).
 * Returns { x, y, z (the ground on the face), faceX, faceZ (the horizontal unit direction the face
 * looks toward: downslope), slope (rise over run) }.
 */
export function findCliffFace(heightAt, x, z, radius, waterLevel) {
  const step = (2 * radius) / (GRID - 1);
  let best = null;
  let bestScore = -Infinity;
  for (let row = 0; row < GRID; row++) {
    for (let column = 0; column < GRID; column++) {
      const px = Math.round(x - radius + column * step);
      const pz = Math.round(z - radius + row * step);
      const height = heightAt(px, pz);
      if (height < waterLevel + MIN_HEIGHT) continue;
      const gradientX = (heightAt(px + SLOPE_STEP, pz) - heightAt(px - SLOPE_STEP, pz)) / (2 * SLOPE_STEP);
      const gradientZ = (heightAt(px, pz + SLOPE_STEP) - heightAt(px, pz - SLOPE_STEP)) / (2 * SLOPE_STEP);
      const slope = Math.sqrt(gradientX * gradientX + gradientZ * gradientZ);
      if (slope < MIN_SLOPE) continue;
      const score = Math.min(slope, SLOPE_CAP) + 0.0015 * (height - waterLevel);
      if (score <= bestScore) continue;
      bestScore = score;
      best = { x: px, y: height, z: pz, faceX: -gradientX / slope, faceZ: -gradientZ / slope, slope };
    }
  }
  return best;
}
