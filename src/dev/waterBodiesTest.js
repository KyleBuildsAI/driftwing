// ?test=waters (dev builds only; main.js loads it): the water and overlay fixture presets of
// waterFixtures.js reach worldgen on both threads (the dev-only worldPresets hook), so the world has
// real local water bodies (a lake, a crater lake, terraced pools, a frozen lake, a salt-flat film)
// and region overlays (cherry blossom, an autumn tint sweep, flower stripes, redwoods, groves, a
// mangrove shore), and no harness runs. tools/steps/water-bodies.json frames each one (screenshots,
// both backends) and runs the checks below:
//   - proveBody(presetId): the body's mesh is built and visible, the shared water query returns its
//     level at its centre (ice: material 'ice'), never above its level, and no water outside its
//     outline or where its basin ground is above the level (sampled on a grid over its bounds);
//   - proveOverlays(): the chunks displayed around each overlay fixture carry the overlay attribute
//     it implies (tint sweep weight, ice material id, stripe id) and the vegetation species it plants;
//   - proveQuery(): the craft's water reads agree with the query (agl over a body, onWater false
//     while flying).
// A failed check logs console.error, which fails the step file.
import { WATER_FIXTURES, OVERLAY_FIXTURE_KINDS } from './waterFixtures.js';
import { createFraming } from './spawnCheckKit.js';
import { waterOutlineContains } from '../world/waters.js';

export const TEST_DATABASE = 'driftwing-v2-test-waters';
/** Fixture sites are looked for this far from the spawn (m). */
const SEARCH_RADIUS = 60000;

/** Called by main.js before boot: the fixtures for worldgen and an idle system. */
export function prepareWaterWorld() {
  return {
    databaseName: TEST_DATABASE,
    worldPresets: WATER_FIXTURES,
    createSystem: () => ({ update() {} }),
  };
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

/** Installs window.__dwWaters: the framing and checks of tools/steps/water-bodies.json. */
export function installWaterChecks(game) {
  const { ctx, state } = game;
  const framing = createFraming(ctx);
  const world = ctx.world;
  const results = [];

  function check(label, passed, detail) {
    results.push({ label, passed, detail });
    const line = `${passed ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;
    if (!passed) console.error(`[waters check] ${line}`);
    return line;
  }

  function nearestSite(presetId) {
    return world.sitesNear(state.spawn.x, state.spawn.z, SEARCH_RADIUS).find((site) => site.presetId === presetId) ?? null;
  }

  /** The point a fixture is framed on: its first water body, else overlay `overlayIndex`'s centre. */
  function focusOf(site, overlayIndex = 0) {
    if (site.waters.length > 0 && overlayIndex === 0) return { x: site.waters[0].x, z: site.waters[0].z, size: Math.max(site.waters[0].bounds.maxX - site.waters[0].bounds.minX, 200) };
    const overlay = site.overlays[Math.min(overlayIndex, site.overlays.length - 1)];
    return { x: overlay.x, z: overlay.z, size: Math.min(overlay.bounds.maxX - overlay.bounds.minX, 1200) };
  }

  async function waitForBodies(site) {
    const ids = site.waters.map((water) => water.id);
    for (let frame = 0; frame < 600; frame++) {
      const live = ctx.systems.waterBodies.bodyIds();
      const stats = ctx.systems.waterBodies.getStats();
      if (ids.every((id) => live.includes(id)) && stats.building === 0) return true;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  }

  const api = {
    results,
    /** The fixture sites near the spawn (one line). */
    setup() {
      ctx.settings.set('timeFrozen', true);
      ctx.systems.weather.forceState('clear', 0.5);
      ctx.systems.sky.setDayTime(ctx.util.dayTimeForSunElevation(24, true), { transition: 0 });
      const found = WATER_FIXTURES.map((preset) => {
        const site = nearestSite(preset.id);
        return site ? `${preset.id} ${round(Math.hypot(site.x - state.spawn.x, site.z - state.spawn.z) / 1000, 1)} km` : `${preset.id} missing`;
      });
      return check('every water and overlay fixture lies within 60 km of the spawn', !found.some((line) => line.endsWith('missing')), found.join(', '));
    },
    /** Frames the fixture's site from `view` { distance (share of its size), height, bearing, overlay (index) }. */
    async show(presetId, view = {}) {
      const site = nearestSite(presetId);
      if (!site) return check(`${presetId}: site`, false, 'not found');
      const focus = focusOf(site, view.overlay ?? 0);
      const groundY = Math.max(world.groundHeight(focus.x, focus.z), ctx.waterQuery.heightAt(focus.x, focus.z));
      const target = { x: focus.x, y: groundY, z: focus.z };
      const distance = Math.max(focus.size * (view.distance ?? 0.9), 220);
      const position = framing.viewpoint(target, distance, distance * (view.height ?? 0.45), view.bearing ?? 200);
      const framed = await framing.frameView(position, target);
      const bodies = site.waters.length > 0 ? await waitForBodies(site) : true;
      await framing.terrainIdle();
      return check(`${presetId}: framed`, framed && bodies, { site: site.id, bodies: site.waters.length, waterBodies: ctx.systems.waterBodies.getStats() });
    },
    /** The water query and the body's mesh at a fixture's water bodies. */
    proveBody(presetId) {
      const site = nearestSite(presetId);
      if (!site) return check(`${presetId}: site`, false, 'not found');
      const query = ctx.waterQuery;
      const lines = [];
      for (const body of site.waters) {
        const centre = query.sample(body.x, body.z, state.time.elapsed);
        const centreOk = centre.kind === 'lake' && centre.bodyId === body.id && Math.abs(centre.height - body.level) < 1e-9 && centre.material === body.material;
        let spills = 0;
        let above = 0;
        let covered = 0;
        const bounds = body.bounds;
        for (let row = 0; row <= 24; row++) {
          for (let column = 0; column <= 24; column++) {
            const x = bounds.minX - 30 + ((bounds.maxX - bounds.minX + 60) * column) / 24;
            const z = bounds.minZ - 30 + ((bounds.maxZ - bounds.minZ + 60) * row) / 24;
            const sample = query.sample(x, z, state.time.elapsed);
            if (sample.bodyId !== body.id) continue;
            covered++;
            if (sample.height > body.level) above++;
            if (!waterOutlineContains(body, x, z) || world.groundHeight(x, z) >= body.level) spills++;
          }
        }
        const visible = ctx.systems.waterBodies.bodyIds().includes(body.id);
        lines.push(check(`${presetId} ${body.id}: query at its centre, clipped to its basin, mesh shown`, centreOk && spills === 0 && above === 0 && covered > 0 && visible, {
          level: round(body.level), centre: { kind: centre.kind, height: round(centre.height), material: centre.material, depth: round(centre.depth) }, covered, spills, above, visible,
        }));
      }
      return lines.join(' | ');
    },
    /** The overlay attribute and species in the displayed chunks around every overlay fixture. */
    proveOverlays() {
      const lines = [];
      const kindsSeen = new Set();
      for (const [presetId, kinds] of Object.entries(OVERLAY_FIXTURE_KINDS)) {
        const site = nearestSite(presetId);
        if (!site) {
          lines.push(check(`${presetId}: site`, false, 'not found'));
          continue;
        }
        const overlay = site.overlays[0];
        const sample = world.createOverlaySample();
        world.overlayAt(overlay.x, overlay.z, sample);
        const centred = sample.overlay !== null && sample.overlay.siteId === site.id;
        if (centred) for (const kind of kinds) kindsSeen.add(kind);
        lines.push(check(`${presetId}: overlay resolved at its centre`, centred, { overlay: overlay.id, weight: round(sample.weight, 3), palette: overlay.paletteName }));
      }
      lines.push(check('every overlay kind resolved (palette, vegetation, material, tint sweep, stripes)', ['palette', 'vegetation', 'material', 'tintSweep', 'stripes'].every((kind) => kindsSeen.has(kind)), [...kindsSeen]));
      return lines.join(' | ');
    },
    /** One attribute kind ('tintSweep' | 'material' | 'stripes') is in a displayed chunk now. */
    proveAttribute(kind) {
      const component = kind === 'tintSweep' ? 0 : kind === 'material' ? 2 : 3;
      let count = 0;
      for (const child of ctx.scene.getObjectByName('terrain').children) {
        if (!child.visible || child.userData.terrainLod === undefined || !child.geometry.attributes.overlay) continue;
        const data = child.geometry.attributes.overlay.array;
        for (let index = component; index < data.length; index += 4) {
          const value = data[index];
          if (component === 0 ? value - Math.floor(value) > 0.01 : value > 0.5) count++;
        }
      }
      return check(`the displayed chunks carry the ${kind} overlay attribute`, count > 0, `${count} vertices`);
    },
    /** The species a fixture plants are among the displayed vegetation (type ids). */
    proveSpecies(types) {
      const present = new Set();
      for (const child of ctx.scene.getObjectByName('terrain').children) {
        if (child.visible && child.userData.vegetationType !== undefined && child.geometry.instanceCount > 0) present.add(child.userData.vegetationType);
      }
      return check(`vegetation types ${types.join(', ')} drawn`, types.every((type) => present.has(type)), [...present].sort((a, b) => a - b));
    },
    /** The craft's agl over the first body of presetId agrees with the water query. */
    async proveQuery(presetId) {
      const site = nearestSite(presetId);
      if (!site || site.waters.length === 0) return check(`${presetId}: water site`, false, 'not found');
      const body = site.waters[0];
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: body.x, y: body.level + 120, z: body.z, heading: 0 });
      for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
      const player = state.player;
      const water = ctx.waterQuery.heightAt(player.position.x, player.position.z);
      const expected = player.position.y - Math.max(world.groundHeight(player.position.x, player.position.z), water);
      return check(`${presetId}: the craft's height above the water is the query's`, Math.abs(player.agl - expected) < 0.01 && state.flight.onWater === false, {
        agl: round(player.agl), expected: round(expected), onWater: state.flight.onWater,
      });
    },
  };
  window.__dwWaters = api;
  return api;
}
