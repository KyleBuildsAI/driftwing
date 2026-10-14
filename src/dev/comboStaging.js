// Dev-only staging for the legendary combos and the midnight sun (presets 92-100): the F9 debugger's
// "Force combo" button and the preset checks of presets 91-100 call stageCombo(ctx, presetId). The
// owner's manual checklist forces one legendary combo from the F9 debugger, and a combo forced on the
// spot (the debugger's plain Spawn) skips its preconditions but not its place: an eclipse over the
// monoliths needs a monolith circle, a resonating grove needs crystal spires. So each combo here has
// a staging: the time of day and weather it belongs to (held), the place it happens (the nearest
// snow, open water, coast, landmark or site to the craft, found the same way every time), a viewpoint
// for the craft (placed `approach` metres short of the place, `altitude` up, facing it, or with the sun
// behind it for a rainbow), anything the place needs awake (the volcano's eruption, through the
// director so it ends on its own), and then the combo itself, started through the director's debug
// path on that spot (forceSpawn with `at`), its members with it. The midnight sun is scheduled on the
// current night and the clock is set to midnight. Deterministic: the same seed and the same craft
// position give the same place, viewpoint and seed. Never part of a production bundle: only the dev
// debugger and the dev check modules import it.
import { frames, holdConditions } from './spawnCheckKit.js';

/** Stagings by preset id: sun elevation (deg, evening unless morning) or a dayTime, weather, the place, the viewpoint. */
export const COMBO_STAGING = Object.freeze({
  auroraMeteorShower: Object.freeze({ sun: -30, weather: 'clear', place: Object.freeze({ kind: 'biome', biome: 'snow' }), approach: 600, altitude: 350 }),
  volcanoAurora: Object.freeze({ sun: -28, weather: 'clear', place: Object.freeze({ kind: 'site', presetId: 'volcano', wake: true }), approach: 7000, altitude: 900 }),
  doubleRainbowWhales: Object.freeze({ sun: 8, weather: 'clearing', place: Object.freeze({ kind: 'coast' }), approach: 2200, altitude: 220, sunBehind: true }),
  eclipseMonoliths: Object.freeze({ sun: 35, morning: true, weather: 'clear', place: Object.freeze({ kind: 'landmark', landmark: 'monoliths' }), approach: 900, altitude: 160 }),
  cometBreakup: Object.freeze({ sun: -30, weather: 'clear', place: Object.freeze({ kind: 'water' }), approach: 1500, altitude: 400 }),
  migrationConvergence: Object.freeze({ sun: 22, weather: 'clear', place: Object.freeze({ kind: 'biome', biome: 'meadows' }), approach: 1800, altitude: 260 }),
  midnightSun: Object.freeze({ dayTime: 0, weather: 'clear', place: Object.freeze({ kind: 'biome', biome: 'snow' }), approach: 0, altitude: 500, override: true }),
  resonatingSpires: Object.freeze({ sun: -5, weather: 'storm', place: Object.freeze({ kind: 'site', presetId: 'crystalSpires' }), approach: 1400, altitude: 200 }),
  lighthouseBeacons: Object.freeze({ sun: -18, weather: 'clear', place: Object.freeze({ kind: 'landmark', landmark: 'lighthouse' }), approach: 2600, altitude: 320 }),
});

/** How far the place searches reach (m), and the ring step of the surface searches. */
const SEARCH_RADIUS = 60000;
const RING_STEP = 500;
/** A site the craft was moved to is built within this many seconds (the site feed sweeps). */
const SITE_WAIT_S = 45;

/** Whether presetId has a staging (the debugger shows Force combo for these). */
export function hasComboStaging(presetId) {
  return Object.hasOwn(COMBO_STAGING, presetId);
}

/**
 * The surface spot nearest (x, z) passing test, searched ring by ring outward (RING_STEP apart,
 * compass order on each ring), or null within SEARCH_RADIUS.
 */
function ringSearch(x, z, test) {
  for (let radius = 0; radius <= SEARCH_RADIUS; radius += RING_STEP) {
    const steps = Math.max(1, Math.round((2 * Math.PI * radius) / RING_STEP));
    for (let index = 0; index < steps; index++) {
      const angle = (index / steps) * Math.PI * 2;
      const px = x + Math.sin(angle) * radius;
      const pz = z - Math.cos(angle) * radius;
      if (test(px, pz)) return { x: px, z: pz };
    }
  }
  return null;
}

/** The place of a staging near (x, z): { x, z, site?, label } or throws naming what is missing. */
function findPlace(ctx, place, x, z) {
  const world = ctx.world;
  const water = world.WATER_LEVEL;
  const below = (px, pz, depth) => world.groundHeight(px, pz) < water - depth;
  const ringAll = (px, pz, reach, test) => {
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      if (!test(px + Math.sin(angle) * reach, pz - Math.cos(angle) * reach)) return false;
    }
    return true;
  };
  if (place.kind === 'biome') {
    const found = world.findNearest(x, z, place.biome, SEARCH_RADIUS);
    if (!found) throw new Error(`no ${place.biome} within ${SEARCH_RADIUS / 1000} km`);
    return { x: found.x, z: found.z, label: `${place.biome} ${Math.round(found.distance)} m away` };
  }
  if (place.kind === 'water') {
    const found = ringSearch(x, z, (px, pz) => below(px, pz, 6) && ringAll(px, pz, 1500, (qx, qz) => below(qx, qz, 2)));
    if (!found) throw new Error(`no open water within ${SEARCH_RADIUS / 1000} km`);
    return { ...found, label: 'open water' };
  }
  if (place.kind === 'coast') {
    const found = ringSearch(x, z, (px, pz) => below(px, pz, 5) && ringAll(px, pz, 600, (qx, qz) => below(qx, qz, 1)));
    if (!found) throw new Error(`no coastal water within ${SEARCH_RADIUS / 1000} km`);
    return { ...found, label: 'coastal water' };
  }
  if (place.kind === 'landmark') {
    for (let radius = 6000; radius <= SEARCH_RADIUS; radius *= 2) {
      let best = null;
      let bestDistance = Infinity;
      for (const site of world.landmarkSitesNear(x, z, radius)) {
        if (site.type !== place.landmark) continue;
        const distance = Math.hypot(site.x - x, site.z - z);
        if (distance < bestDistance) {
          best = site;
          bestDistance = distance;
        }
      }
      if (best) return { x: best.x, z: best.z, label: `${place.landmark} ${best.id}` };
    }
    throw new Error(`no ${place.landmark} within ${SEARCH_RADIUS / 1000} km`);
  }
  if (place.kind === 'site') {
    const site = ctx.systems.spawns.manager.findNearestSite(place.presetId, x, z, SEARCH_RADIUS + 30000);
    if (!site) throw new Error(`no ${place.presetId} site within ${(SEARCH_RADIUS + 30000) / 1000} km`);
    return { x: site.x, z: site.z, site, label: `site ${site.id}` };
  }
  throw new Error(`unknown place kind "${place.kind}"`);
}

/** The compass heading away from the sun (the sun behind the craft). */
function downSun(state) {
  const sun = state.time.sunDirection;
  return ((Math.atan2(-sun.x, sun.z) * 180) / Math.PI + 360) % 360;
}

/**
 * Stages presetId (one of COMBO_STAGING) and forces it: conditions, place, viewpoint, what the place
 * needs awake, then the combo on the spot. Resolves to { presetId, id, place, view, woke } (id: the
 * combo id or the override's) or throws with the reason.
 */
export async function stageCombo(ctx, presetId) {
  const staging = COMBO_STAGING[presetId];
  if (!staging) throw new Error(`no combo staging for "${presetId}"`);
  const { state, world } = ctx;
  const spawns = ctx.systems.spawns;
  const director = spawns.director;
  if (!director) throw new Error('the director is not running');
  if (Number.isFinite(staging.dayTime)) {
    holdConditions(ctx, { sun: 0, weather: staging.weather });
    ctx.systems.sky.setDayTime(staging.dayTime, { transition: 0 });
  } else {
    holdConditions(ctx, { sun: staging.sun, morning: staging.morning === true, weather: staging.weather });
  }
  await frames(2);
  const from = state.player.position;
  const place = findPlace(ctx, staging.place, from.x, from.z);
  // The viewpoint: short of the place, facing it (or along the sun's direction with it ahead).
  const heading = staging.sunBehind ? downSun(state) : (staging.approach > 0 ? ctx.util.bearingTo(from.x, from.z, place.x, place.z) : state.player.heading);
  const radians = (heading * Math.PI) / 180;
  const viewX = place.x - Math.sin(radians) * staging.approach;
  const viewZ = place.z + Math.cos(radians) * staging.approach;
  const viewY = Math.max(world.groundHeight(viewX, viewZ), world.groundHeight(place.x, place.z), world.WATER_LEVEL) + staging.altitude;
  ctx.setPhotoMode(false);
  if (!ctx.systems.flight.resetTo({ x: viewX, y: viewY, z: viewZ, heading })) throw new Error('the flight system refused the viewpoint');
  await frames(3);
  let woke = null;
  if (place.site) {
    // The site is built as the craft nears it (the site feed); its eruption goes through the director.
    const manager = spawns.manager;
    const started = performance.now();
    while (!manager.getSiteSpawn(place.site.id) && performance.now() - started < SITE_WAIT_S * 1000) await frames(5);
    if (!manager.getSiteSpawn(place.site.id)) throw new Error(`the ${place.site.presetId} site ${place.site.id} was not built within ${SITE_WAIT_S} s`);
    if (staging.place.wake) {
      woke = director.forceSiteActive(place.site.id);
      if (!woke) throw new Error(`the ${place.site.presetId} site ${place.site.id} could not be woken`);
    }
  }
  let id;
  if (staging.override) {
    id = spawns.forceSpawn(presetId, { force: true });
  } else {
    id = spawns.forceSpawn(presetId, { force: true, at: { x: place.x, z: place.z } });
  }
  if (!id) throw new Error(`the director refused ${presetId} (${spawns.manager.getStats().lastRefusal ?? 'see the console'})`);
  return {
    presetId,
    id,
    place: { x: Math.round(place.x), z: Math.round(place.z), label: place.label },
    view: { x: Math.round(viewX), y: Math.round(viewY), z: Math.round(viewZ), heading: Math.round(heading) },
    woke,
  };
}
