import { CONFIG } from '../core/config.js';
import { wrapDegrees, headingFromVector, vectorFromHeading } from '../core/util.js';


// ---- Spawn selection: deterministic "screenshot moment" near the origin ---------
export function findSpawn(world, sunDirection) {
  const sunHeading = headingFromVector(sunDirection.x, sunDirection.z);
  let best = null;
  for (let ring = 0; ring < 12; ring++) {
    const samples = ring === 0 ? 1 : 6 + ring * 3;
    for (let sample = 0; sample < samples; sample++) {
      const angle = (sample / samples) * Math.PI * 2 + ring * 0.7;
      const x = Math.cos(angle) * ring * 450;
      const z = Math.sin(angle) * ring * 450;
      const here = world.heightAt(x, z);
      let min = here;
      let max = here;
      let land = here > 4 ? 1 : 0;
      for (let probe = 0; probe < 8; probe++) {
        const probeAngle = (probe / 8) * Math.PI * 2;
        const height = world.heightAt(x + Math.cos(probeAngle) * 750, z + Math.sin(probeAngle) * 750);
        min = Math.min(min, height);
        max = Math.max(max, height);
        if (height > 4) land++;
      }
      const relief = Math.min(max - min, 520);
      // Prefer the heart of a biome over blend zones so the first view has a clear identity.
      const biome = world.biomeAt(x, z);
      const purity = Math.max(...biome.weights);
      const score = relief * 0.6 + land * 22 - ring * 18 + (here > -10 ? 40 : -120) + (purity < 0.65 ? -600 : (purity - 0.65) * 300);
      if (!best || score > best.score) best = { x, z, score, biomeKey: biome.key };
    }
  }
  let bestHeading = wrapDegrees(sunHeading - 40);
  let bestHeadingScore = -Infinity;
  for (const offset of [-36, -30, -24, 24, 30, 36]) {
    const heading = wrapDegrees(sunHeading + offset);
    const forward = vectorFromHeading(heading);
    let score = 0;
    for (let step = 1; step <= 6; step++) {
      const aheadX = best.x + forward.x * step * 320;
      const aheadZ = best.z + forward.z * step * 320;
      const height = world.heightAt(aheadX, aheadZ);
      score += Math.min(height, 600) * 0.2 + (height > 4 ? 30 : 0);
      // The first view should show the biome the intro banner names.
      if (step <= 4) score += world.biomeAt(aheadX, aheadZ).key === best.biomeKey ? 45 : -70;
    }
    if (score > bestHeadingScore) {
      bestHeadingScore = score;
      bestHeading = heading;
    }
  }
  const forward = vectorFromHeading(bestHeading);
  let clearance = world.heightAt(best.x, best.z);
  for (let step = 1; step <= 16; step++) {
    clearance = Math.max(clearance, world.heightAt(best.x + forward.x * step * 110, best.z + forward.z * step * 110));
  }
  const y = Math.max(clearance + 150, CONFIG.WATER_LEVEL + 190);
  return { x: best.x, y, z: best.z, heading: bestHeading };
}
