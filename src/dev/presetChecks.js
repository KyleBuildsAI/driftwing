// Dev-only browser checks for the real spawn presets (src/spawns/presets), Milestone E: each preset
// is force-spawned in the running game (events ahead of the craft through the director's forceSpawn,
// sites at their REAL placed site from the site feed), at the time of day it belongs to, framed by
// the photo camera for a screenshot, and proven:
//   - it spawns with no console error or warning (the smoke test fails on any);
//   - its discovery fires with the glass toast (journal:discovery) and a journal entry;
//   - after dispose, GPU memory (geometries, textures) is back where it was before the create, apart
//     from geometries the WORLD drew for the first time meanwhile (the geometry tracker tells them
//     apart), its wind sources are removed and the manager reports no leak;
//   - each preset's own behaviour (the geese slot achievement, the bridge's pass-under achievement,
//     the bay's glowing trails and night hours, the eagle's join and peel calls, the hawks in their
//     thermal, the wind farm turned into the wind, the maelstrom's wind).
// tools/steps/presets-batch2.json drives it (a dev server: it imports this module by URL). Never part
// of a production build: only step files import it. Every failed check calls console.error.
import { createGeometryTracker, splitFresh } from './geometryTracker.js';

/** Resolves after `count` animation frames. */
function frames(count) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left--;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Resolves after `seconds` of wall time, frame by frame. */
async function seconds(duration) {
  const until = performance.now() + duration * 1000;
  while (performance.now() < until) await frames(1);
}

/** Compass point `distance` m from (x, z) on `bearing` degrees. */
function offset(x, z, bearing, distance) {
  const radians = (bearing * Math.PI) / 180;
  return { x: x + Math.sin(radians) * distance, z: z - Math.cos(radians) * distance };
}

/**
 * Installs window.__dwPresets on a running V2 (dev server). Returns the API; see the file header.
 */
export function installPresetChecks(game) {
  const { ctx, state } = game;
  const THREE = ctx.THREE;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const results = [];
  const ground = (x, z) => Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL);
  const events = { discovery: [], toast: [], achievement: [], ended: [], formation: [], call: [], gate: [] };
  ctx.bus.onTyped('discovery', (payload) => events.discovery.push(payload.presetId));
  ctx.bus.on('journal:discovery', (payload) => events.toast.push(payload));
  ctx.bus.onTyped('achievement', (payload) => events.achievement.push(payload.id));
  ctx.bus.onTyped('spawnEnded', (payload) => events.ended.push({ id: payload.id, reason: payload.reason }));
  ctx.bus.on('fauna:formation', (payload) => events.formation.push(payload.state));
  ctx.bus.on('fauna:call', (payload) => events.call.push(payload.reason));
  ctx.bus.on('structure:gate', (payload) => events.gate.push(payload.kind));
  const tracker = createGeometryTracker(ctx.renderer, ctx.scene);
  if (tracker) tracker.attribute(manager.registry.names().map((name) => manager.registry.get(name)));
  /** The open spawn of each preset under test: { id, before, siteId, site }. */
  const open = new Map();
  /**
   * The site presets, held out of the manager while another preset is under test: a site the feed
   * builds as the craft moves (a wind farm's towers) would add geometry no check owns. Each one is
   * added back for its own test and all are restored by finish().
   */
  const heldSites = new Map();
  const park = { x: 0, y: 0, z: 0, heading: 0 };
  /** The eagle's wingman modes seen across the escort check's calls. */
  const eagleModes = new Set();

  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    results.push(line);
    if (!ok) console.error(`[preset check] ${line}`);
    return line;
  }

  function memory() {
    const info = ctx.renderer.info.memory;
    return { geometries: info.geometries, textures: info.textures };
  }

  function setSun(elevation, morning = false) {
    ctx.systems.sky.setDayTime(ctx.util.dayTimeForSunElevation(elevation, morning), { transition: 0 });
  }

  /** True when the terrain stays below the sight line from position to target. */
  function clearSight(position, target) {
    for (let sample = 1; sample < 32; sample++) {
      const share = sample / 32;
      const y = position.y + (target.y - position.y) * share;
      if (ground(position.x + (target.x - position.x) * share, position.z + (target.z - position.z) * share) > y - 4) return false;
    }
    return true;
  }

  /** A camera position `distance` m from target with a clear view of it, trying bearings around it. */
  function viewpoint(target, distance, height, bearing) {
    for (let lift = 0; lift < 6; lift++) {
      for (const turn of [0, 40, -40, 80, -80, 120, -120, 160, -160]) {
        const point = offset(target.x, target.z, bearing + turn, distance);
        const position = { x: point.x, y: Math.max(ground(point.x, point.z) + height * (1 + lift * 0.6), target.y + height * 0.2), z: point.z };
        if (clearSight(position, target)) return position;
      }
    }
    const point = offset(target.x, target.z, bearing, distance);
    return { x: point.x, y: target.y + distance, z: point.z };
  }

  /** Waits (up to two minutes) until the terrain has nothing queued, in flight, uploading or fading. */
  async function terrainIdle() {
    const started = performance.now();
    let quiet = 0;
    while (performance.now() - started < 120000 && quiet < 20) {
      await frames(1);
      const stats = ctx.systems.terrain.getStats();
      quiet = stats.queued === 0 && stats.inFlight === 0 && stats.awaitingUpload === 0 && stats.fading === 0 ? quiet + 1 : 0;
    }
    return quiet >= 20;
  }

  /** Parks the craft behind the camera and frames target from position (photo mode). */
  async function frameView(position, target) {
    const lookX = target.x - position.x;
    const lookZ = target.z - position.z;
    const length = Math.hypot(lookX, lookZ) || 1;
    park.x = position.x - (lookX / length) * 300;
    park.z = position.z - (lookZ / length) * 300;
    park.y = Math.max(position.y, ground(park.x, park.z) + 200);
    park.heading = (Math.atan2(lookX, -lookZ) * 180) / Math.PI;
    ctx.systems.flight.resetTo(park);
    await frames(2);
    ctx.setPhotoMode(true);
    // The photo camera takes the pose once photo mode is live (a frame or two after the switch).
    let posed = false;
    for (let attempt = 0; attempt < 60 && !posed; attempt++) {
      await frames(1);
      posed = ctx.systems.camera.setFreeCameraPose({ position: new THREE.Vector3(position.x, position.y, position.z), target: new THREE.Vector3(target.x, target.y, target.z) });
    }
    const settled = await terrainIdle();
    await frames(20);
    return settled && posed;
  }

  /** Flies the craft (photo mode off) to `distance` m short of (x, z), facing it, `height` m up. */
  async function approach(x, z, distance, height, bearingFrom = null) {
    ctx.setPhotoMode(false);
    const from = bearingFrom === null ? (Math.atan2(state.player.position.x - x, -(state.player.position.z - z)) * 180) / Math.PI : bearingFrom;
    const point = offset(x, z, from, distance);
    const heading = (from + 180) % 360;
    ctx.systems.flight.resetTo({ x: point.x, y: Math.max(ground(point.x, point.z), ground(x, z)) + height, z: point.z, heading });
    await frames(3);
  }

  /** The nearest open water to (x, z) with land within 2.5 km (a coast), or null. */
  function coastalWater(x, z) {
    const open = (px, pz) => {
      for (let dx = -300; dx <= 300; dx += 150) for (let dz = -300; dz <= 300; dz += 150) if (ctx.world.heightAt(px + dx, pz + dz) > -6) return false;
      return true;
    };
    for (let reach = 0; reach < 60000; reach += 500) {
      for (let step = 0; step < 36; step++) {
        const point = offset(x, z, step * 10, reach);
        if (!open(point.x, point.z)) continue;
        for (let probe = 0; probe < 8; probe++) {
          const land = offset(point.x, point.z, probe * 45, 2500);
          if (ctx.world.heightAt(land.x, land.z) > 2) return point;
        }
      }
    }
    return null;
  }

  /** The nearest point at least 4 m deep within reach of (x, z), searched on rings 50 m apart, or null. */
  function nearestWater(x, z, reach) {
    for (let radius = 0; radius <= reach; radius += 50) {
      for (let step = 0; step < 24; step++) {
        const point = offset(x, z, step * 15, radius);
        if (ctx.world.heightAt(point.x, point.z) < ctx.world.WATER_LEVEL - 4) return point;
      }
    }
    return null;
  }

  /** The gentlest open land about `distance` m ahead of the craft (a meadow for the fireflies). */
  function openGroundAhead(distance, reach) {
    let best = null;
    for (let bearing = -60; bearing <= 60; bearing += 10) {
      for (const share of [0.7, 0.85, 1, 1.15, 1.3]) {
        const point = offset(state.player.position.x, state.player.position.z, state.player.heading + bearing, distance * share);
        const centre = ctx.world.groundHeight(point.x, point.z);
        if (centre < ctx.world.WATER_LEVEL + 3) continue;
        let spread = 0;
        for (let sample = 0; sample < 8; sample++) {
          const around = offset(point.x, point.z, sample * 45, reach);
          spread = Math.max(spread, Math.abs(ctx.world.groundHeight(around.x, around.z) - centre));
        }
        if (!best || spread < best.spread) best = { x: point.x, y: centre, z: point.z, spread };
      }
    }
    return best;
  }

  /** Starts a spawn of presetId and records the memory before it (and the world's geometries since). */
  async function begin(presetId, start) {
    await terrainIdle();
    const before = memory();
    const windBefore = ctx.wind.sourceCount;
    if (tracker) tracker.start();
    const id = start();
    open.set(presetId, { id, before, windBefore });
    return id;
  }

  /** Waits (up to 60 s) for the site feed to build the spawn of site; returns its id or null. */
  async function siteSpawn(site) {
    const started = performance.now();
    while (performance.now() - started < 60000) {
      const id = manager.getSiteSpawn(site.id);
      if (id) return id;
      await frames(5);
    }
    return null;
  }

  /** Waits (up to `limit` s) for presetId's discovery and its journal toast. */
  async function discovered(presetId, key, limit = 20) {
    const started = performance.now();
    while (performance.now() - started < limit * 1000) {
      if (events.discovery.includes(presetId) && ctx.systems.journal.hasDiscovered(key)) break;
      await frames(5);
    }
    const toast = events.toast.find((payload) => payload.entry ? payload.entry.presetId === presetId : payload.presetId === presetId) ?? null;
    return { fired: events.discovery.includes(presetId), journal: ctx.systems.journal.hasDiscovered(key), toast: toast !== null };
  }

  const api = {
    results,
    events,
    setSun,

    /** Reports the presets under test and the tracker (each smoke run has a fresh browser profile). */
    setup() {
      const presets = manager.listPresets().map((preset) => preset.id);
      for (const preset of manager.listPresets()) {
        if (preset.kind !== 'site') continue;
        heldSites.set(preset.id, preset);
        manager.removePreset(preset.id);
      }
      return check('setup: the real presets are registered and the geometry tracker is live', presets.length > 0 && tracker !== null, { presets, tracker: tracker !== null });
    },

    /**
     * Shows presetId: `how` is { sun, morning, kind: 'ahead' | 'site' | 'coast' | 'thermal' | 'meadow',
     * distance (spawn distance ahead), view: { distance, height, bearing, lift } }. Returns a line.
     */
    async show(presetId, how) {
      const preset = manager.getPreset(presetId) ?? heldSites.get(presetId);
      const { sun = 40, morning = false, kind = 'ahead', distance = 1500, view = {} } = how;
      setSun(sun, morning);
      ctx.setPhotoMode(false);
      let id = null;
      let siteId = null;
      if (kind === 'site') {
        // The preset joins the manager only after the memory baseline, so the feed builds it inside it.
        const site = ctx.world.sitesNear(state.player.position.x, state.player.position.z, 60000).find((candidate) => candidate.presetId === presetId) ?? null;
        if (!site) return check(`${presetId}: a placed site within reach`, false, 'none');
        siteId = site.id;
        await approach(site.x, site.z, 2500, 300);
        await begin(presetId, () => null);
        if (heldSites.has(presetId) && !manager.getPreset(presetId)) manager.addPreset(heldSites.get(presetId));
        id = await siteSpawn(site);
        open.get(presetId).id = id;
        open.get(presetId).siteId = site.id;
        open.get(presetId).site = site;
      } else if (kind === 'coast') {
        const water = coastalWater(state.player.position.x, state.player.position.z);
        if (!water) return check(`${presetId}: open coastal water`, false, 'none within 60 km');
        await approach(water.x, water.z, distance + 400, 250);
        id = await begin(presetId, () => system.forceSpawn(presetId, { distance, force: true }));
      } else if (kind === 'thermal') {
        const thermal = ctx.wind.nearestThermal(state.player.position, 1.2);
        if (!thermal) return check(`${presetId}: a working thermal near the craft`, false, 'none');
        await approach(thermal.x, thermal.z, 1500, 450);
        id = await begin(presetId, () => manager.activate(presetId, { position: { x: thermal.x + 200, y: ground(thermal.x + 200, thermal.z), z: thermal.z }, heading: state.player.heading, source: 'debug', force: true }));
      } else if (kind === 'meadow') {
        const spot = openGroundAhead(distance, 200);
        if (!spot) return check(`${presetId}: open ground ahead`, false, 'none');
        id = await begin(presetId, () => manager.activate(presetId, { position: spot, heading: state.player.heading, source: 'debug', force: true }));
      } else {
        id = await begin(presetId, () => system.forceSpawn(presetId, { distance, force: true }));
      }
      if (!id) return check(`${presetId}: spawned`, false, { refusal: manager.getStats().lastRefusal });
      // Flight time for the spawn to fade in and settle (the photo mode stops its clock).
      await seconds(5);
      const record = manager.getInstance(id);
      if (!record) return check(`${presetId}: spawned`, false, { ended: events.ended.filter((entry) => entry.id === id) });
      const lift = view.lift ?? 20;
      const target = { x: record.position.x, y: record.position.y + lift, z: record.position.z };
      if (view.water) {
        // Frame the water nearest the anchor (a shore site's anchor may lie on the beach).
        const water = nearestWater(record.position.x, record.position.z, 1500);
        if (water) {
          target.x = water.x;
          target.y = ctx.world.WATER_LEVEL + lift;
          target.z = water.z;
        }
      }
      const position = viewpoint(target, view.distance ?? 400, view.height ?? 60, view.bearing ?? 200);
      const settled = await frameView(position, target);
      const found = await discovered(presetId, siteId ?? presetId);
      return check(`${presetId}: spawned and framed, discovered with the toast and a journal entry`, found.fired && found.journal && found.toast,
        { id, site: siteId, category: preset.category, tier: manager.getInstance(id)?.tier, terrainSettled: settled, discovery: found, engines: preset.engines.map((entry) => entry.engine) });
    },

    /** Ends presetId's spawn: GPU memory back, wind sources removed, no leak. */
    async end(presetId) {
      const entry = open.get(presetId);
      if (!entry || !entry.id) return check(`${presetId}: ended`, false, 'never spawned');
      ctx.setPhotoMode(true);
      const record = manager.getInstance(entry.id);
      const ownSources = record ? manager.getParts(entry.id).flatMap((instance) => instance.windSourceIds) : [];
      // A site leaves with its preset (or the feed would build it again at once); an event is ended.
      if (entry.siteId) manager.removePreset(presetId);
      else manager.deactivate(entry.id, 'preset check');
      await frames(6);
      await terrainIdle();
      const after = memory();
      const fresh = tracker ? tracker.stop() : [];
      const { world, leftBehind } = splitFresh(fresh, []);
      open.delete(presetId);
      const leaks = manager.getStats().leaks;
      const live = new Set(ctx.wind.listSources().map((source) => source.id));
      const sourcesLeft = ownSources.filter((sourceId) => live.has(sourceId));
      // The world may also free geometries meanwhile (terrain chunks the craft left behind), so the
      // count may fall short of the world's first draws, never exceed them.
      const ok = leftBehind.length === 0 && after.geometries - entry.before.geometries <= world && after.textures === entry.before.textures
        && sourcesLeft.length === 0 && manager.getInstance(entry.id) === null && (leaks.windSources ?? 0) === 0 && (leaks.lights ?? 0) === 0;
      return check(`${presetId}: dispose returns GPU memory and removes its wind sources`, ok,
        { before: entry.before, after, worldFirstDrawn: world, leftBehind: leftBehind.map((item) => `${item.owner}/${item.object}`), ownWindSources: ownSources, left: sourcesLeft, windSources: `${entry.windBefore} -> ${ctx.wind.sourceCount}`, leaks });
    },

    /**
     * Geese: the craft holds the open slot for the hold time; the flock sends the achievement. With
     * pauseAt (s held), it stops there in photo mode with the camera behind the craft in its slot (for
     * the screenshot) and returns; the next call carries on to the achievement.
     */
    async geeseSlot({ pauseAt = null } = {}) {
      const entry = open.get('geeseFormation');
      const fauna = manager.registry.get('fauna');
      ctx.setPhotoMode(false);
      const started = performance.now();
      let held = 0;
      while (performance.now() - started < 30000 && !events.achievement.includes('vFormation')) {
        if (pauseAt !== null && held >= pauseAt) {
          const description = fauna.describe(entry.id);
          const forward = state.player.forward;
          const player = state.player.position;
          ctx.setPhotoMode(true);
          await frames(2);
          const posed = ctx.systems.camera.setFreeCameraPose({
            position: new THREE.Vector3(player.x - forward.x * 45, player.y + 14, player.z - forward.z * 45),
            target: new THREE.Vector3(description.center.x, description.center.y, description.center.z),
          });
          await frames(10);
          return `geese: the craft in its slot after ${Math.round(held * 10) / 10} s, paused for the screenshot (posed ${posed})`;
        }
        const formation = fauna.getFormation(entry.id);
        const description = fauna.describe(entry.id);
        if (!formation || !description) break;
        const group = manager.getParts(entry.id)[0].data.g;
        const heading = ((group[6] * 180) / Math.PI + 360) % 360;
        ctx.systems.flight.resetTo({ x: formation.slot.x, y: formation.slot.y, z: formation.slot.z, heading });
        await frames(1);
        held = Math.max(held, formation.bestHoldSeconds);
      }
      const formation = fauna.getFormation(entry.id);
      return check('geeseFormation: holding the slot completes the formation and sends the V-Formation achievement', events.achievement.includes('vFormation') && events.formation.includes('enter') && events.formation.includes('complete'),
        { bestHold: formation ? formation.bestHoldSeconds : held, complete: formation ? formation.complete : null, formation: events.formation.slice(0, 6), achievements: events.achievement, journal: ctx.systems.journal.getRecords().achievements.some((item) => item.id === 'vFormation') ? 'recorded' : 'missing' });
    },

    /** Rope bridge: flying under the deck fires the pass-under gate and Thread the Needle. */
    async bridgeGate() {
      const entry = open.get('ropeBridge');
      const instance = manager.getParts(entry.id)[0];
      const gates = instance.data.gates.data;
      const stamp = entry.site ? entry.site.stamps.find((item) => item.type === 'gorge') : null;
      const y = (gates[5] + gates[6]) * 0.5;
      const heading = (Math.atan2(gates[2], -gates[3]) * 180) / Math.PI;
      ctx.setPhotoMode(false);
      for (let step = -20; step <= 20; step++) {
        ctx.systems.flight.resetTo({ x: gates[0] + gates[2] * step * 6, y, z: gates[1] + gates[3] * step * 6, heading });
        await frames(1);
      }
      ctx.systems.flight.resetTo(park);
      await frames(3);
      return check('ropeBridge: on its gorge stamp, flying under the deck fires the gate and Thread the Needle', events.gate.includes('under') && events.achievement.includes('threadTheNeedle') && stamp !== null && gates[6] < stamp.rimY,
        { gate: [Math.round(gates[5]), Math.round(gates[6])], rimY: stamp ? Math.round(stamp.rimY) : null, floorY: stamp ? Math.round(stamp.floorY) : null, gates: events.gate, achievements: events.achievement });
    },

    /** Bay: a glow region at night, the craft skimming leaves a glowing trail, splashes on the water. */
    async bayTrails() {
      const entry = open.get('bioluminescentBay');
      const record = manager.getInstance(entry.id);
      const water = ctx.systems.water.effects;
      // Skim the craft low over the water inside the bay for a second.
      let start = null;
      for (let reach = 0; reach < 900 && !start; reach += 60) {
        for (let step = 0; step < 12 && !start; step++) {
          const point = offset(record.position.x, record.position.z, step * 30, reach);
          if (ctx.world.heightAt(point.x, point.z) < -4 && ctx.world.heightAt(point.x + 120, point.z) < -4) start = point;
        }
      }
      ctx.setPhotoMode(false);
      for (let step = 0; step < 50 && start; step++) {
        ctx.systems.flight.resetTo({ x: start.x + step * 2, y: ctx.world.WATER_LEVEL + 1.5, z: start.z, heading: 90 });
        await frames(1);
      }
      // Then a few seconds of flight time high over the bay, for the fish to jump (splashes).
      ctx.systems.flight.resetTo({ x: record.position.x, y: ground(record.position.x, record.position.z) + 400, z: record.position.z, heading: 0 });
      await seconds(8);
      const stats = water.stats();
      const splashes = manager.getParts(entry.id)[1].data.splashes;
      ctx.systems.flight.resetTo(park);
      await frames(3);
      ctx.setPhotoMode(true);
      return check('bioluminescentBay: a glow region at night, the skimming craft leaves trails, splashes land on the water', stats.glowRegions >= 1 && stats.trailRows > 0 && stats.craftContacts > 0 && splashes > 0 && start !== null,
        { glowRegions: stats.glowRegions, trailRows: stats.trailRows, craftContacts: stats.craftContacts, droplets: stats.droplets, splashes });
    },

    /** Bay: out of its hours (day) and out of view it goes; back at night the feed builds it again. */
    async bayHours() {
      const entry = open.get('bioluminescentBay');
      const siteId = entry.siteId;
      const record = manager.getInstance(entry.id);
      const spot = { x: record.position.x, z: record.position.z };
      const endedBefore = events.ended.length;
      setSun(40);
      // Look away from the bay: the craft 3 km south of it facing south, the photo camera (which keeps
      // within 900 m of the craft) just ahead of it.
      ctx.setPhotoMode(false);
      const away = { x: spot.x, y: Math.max(ground(spot.x, spot.z + 3000), 0) + 600, z: spot.z + 3000, heading: 180 };
      ctx.systems.flight.resetTo(away);
      await frames(3);
      ctx.setPhotoMode(true);
      await frames(2);
      const posed = ctx.systems.camera.setFreeCameraPose({ position: new THREE.Vector3(away.x, away.y, away.z + 200), target: new THREE.Vector3(away.x, away.y, away.z + 6000) });
      const started = performance.now();
      let last = null;
      while (performance.now() - started < 60000 && manager.getSiteSpawn(siteId)) {
        const live = manager.getInstance(manager.getSiteSpawn(siteId));
        if (live) last = { inView: live.inView, distance: live.distance, tier: live.tier };
        await frames(10);
      }
      const goneByDay = manager.getSiteSpawn(siteId) === null;
      const reason = events.ended.slice(endedBefore).find((item) => item.id === entry.id)?.reason ?? null;
      setSun(-25);
      const back = performance.now();
      let rebuilt = null;
      while (performance.now() - back < 30000 && !rebuilt) {
        rebuilt = manager.getSiteSpawn(siteId);
        await frames(10);
      }
      if (rebuilt) entry.id = rebuilt;
      return check('bioluminescentBay: gone by day once out of view, built again at night', goneByDay && reason === 'hours' && rebuilt !== null, { goneByDay, reason, rebuilt, posed, last, sun: Math.round(state.time.sunElevation) });
    },

    /** Eagle: it joins off the wing with a call, escorts, then peels off with a call. */
    /**
     * Eagle: it joins off the wing with a call, escorts, then peels off with a call. With shot: true it
     * stops 8 s into the escort in photo mode with the camera behind the craft and its wingman (for the
     * screenshot) and returns; the next call carries on to the peel.
     */
    async eagleEscort({ shot = false } = {}) {
      const entry = open.get('eagleWingman');
      const fauna = manager.registry.get('fauna');
      const record = manager.getInstance(entry.id);
      const modes = eagleModes;
      ctx.setPhotoMode(false);
      if (modes.size === 0) {
        await approach(record.position.x, record.position.z, 900, 0);
        ctx.systems.flight.resetTo({ x: state.player.position.x, y: record.position.y, z: state.player.position.z, heading: state.player.heading });
      }
      const started = performance.now();
      let escortSince = null;
      while (performance.now() - started < 110000 && !events.call.includes('peel')) {
        const description = fauna.describe(entry.id);
        if (!description) break;
        modes.add(description.mode);
        if (description.mode === 2 && escortSince === null) escortSince = performance.now();
        if (shot && escortSince !== null && performance.now() - escortSince > 8000) {
          const forward = state.player.forward;
          const right = state.player.right;
          const player = state.player.position;
          ctx.setPhotoMode(true);
          await frames(2);
          const posed = ctx.systems.camera.setFreeCameraPose({
            position: new THREE.Vector3(player.x - forward.x * 28 - right.x * 6, player.y + 7, player.z - forward.z * 28 - right.z * 6),
            target: new THREE.Vector3((player.x + description.center.x) / 2, (player.y + description.center.y) / 2, (player.z + description.center.z) / 2),
          });
          await frames(10);
          return `eagle: on the wing ${Math.round(Math.hypot(description.center.x - player.x, description.center.z - player.z))} m from the craft, paused for the screenshot (posed ${posed})`;
        }
        // Keep the craft high over the ground while the eagle flies with it.
        if (state.flight.agl < 250) ctx.systems.flight.resetTo({ x: state.player.position.x, y: ground(state.player.position.x, state.player.position.z) + 500, z: state.player.position.z, heading: state.player.heading });
        await frames(10);
      }
      return check('eagleWingman: joins off the wing with a call, escorts, peels off with a call', events.call.includes('join') && events.call.includes('peel') && modes.has(2),
        { calls: events.call, modes: [...modes], seconds: Math.round((performance.now() - started) / 1000) });
    },

    /** Hawks: circling inside the thermal they found (the lift marker). */
    hawksInThermal() {
      const entry = open.get('thermalHawks');
      const fauna = manager.registry.get('fauna');
      const description = fauna.describe(entry.id);
      const thermal = ctx.wind.nearestThermal(description.center, 0.3);
      const distance = thermal ? Math.hypot(thermal.capX - description.center.x, thermal.capZ - description.center.z) : Infinity;
      const lift = ctx.wind.probe(new THREE.Vector3(description.center.x, description.center.y, description.center.z)).vel.y;
      return check('thermalHawks: circling in a working thermal, in rising air', thermal !== null && distance < thermal.radius + 300 && lift > 0.3,
        { thermal: thermal ? thermal.id : null, strength: thermal ? Math.round(thermal.strength * 100) / 100 : null, centreToColumn: Math.round(distance), liftAtHawks: Math.round(lift * 100) / 100, count: description.count });
    },

    /** Wind farm: rotors turned into the wind and spinning, the wake source registered. */
    async windFarmTurning() {
      const entry = open.get('windFarm');
      // Flight time for the rotors to spin up (the photo mode stops the clock).
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo(park);
      await seconds(12);
      ctx.setPhotoMode(true);
      const instance = manager.getParts(entry.id)[0];
      const data = instance.data;
      const windHeading = (Math.atan2(-data.wind[0], data.wind[1]) * 180) / Math.PI;
      const yawError = Math.abs(((data.turbineState[0] - windHeading + 540) % 360) - 180);
      const wake = ctx.wind.listSources().filter((source) => source.kind === 'structure-wake').length;
      return check('windFarm: turbines face into the wind and turn, the wake is a wind source', yawError < 10 && data.turbineState[2] > 1 && wake >= 1 && data.turbineCount >= 6,
        { turbines: data.turbineCount, yawError: Math.round(yawError * 10) / 10, rpm: Math.round(data.turbineState[2] * 10) / 10, wind: Math.round(data.wind[2] * 10) / 10, wakeSources: wake });
    },

    /** Maelstrom: the air vortex blows its Rankine source over the eye (lift and swirl). */
    maelstromWind() {
      const entry = open.get('maelstrom');
      const record = manager.getInstance(entry.id);
      const eye = ctx.wind.probe(new THREE.Vector3(record.position.x + 40, ctx.world.WATER_LEVEL + 300, record.position.z));
      const south = ctx.wind.probe(new THREE.Vector3(record.position.x, ctx.world.WATER_LEVEL + 300, record.position.z + 400)).vel.x;
      const north = ctx.wind.probe(new THREE.Vector3(record.position.x, ctx.world.WATER_LEVEL + 300, record.position.z - 400)).vel.x;
      // Counter-clockwise from above: eastward south of the eye, westward north of it (the ambient
      // wind cancels in the difference).
      const swirl = (south - north) / 2;
      const vortexSources = ctx.wind.listSources().filter((source) => source.kind === 'spawn-vortex' || source.kind === 'spawn-rankine').length;
      return check('maelstrom: lift over the eye, counter-clockwise swirl around it, a vortex wind source', eye.vel.y > 4 && swirl > 2 && vortexSources >= 1 && eye.turbulence > 0.4,
        { eyeUpdraft: Math.round(eye.vel.y * 10) / 10, swirl: Math.round(swirl * 10) / 10, turbulence: Math.round(eye.turbulence * 100) / 100, vortexSources, water: ctx.systems.water.effects.stats().vortices });
    },

    /** Whale pod: on open water (moved off the coast), spouting. */
    whalesOnWater() {
      const entry = open.get('whalePod');
      const fauna = manager.registry.get('fauna');
      const description = fauna.describe(entry.id);
      const depth = ctx.world.heightAt(description.center.x, description.center.z);
      return check('whalePod: the pod swims in open water', depth < -6 && description.count >= 3,
        { count: description.count, seabed: Math.round(depth), droplets: ctx.systems.water.effects.stats().droplets });
    },

    /** The summary line; puts the renderer's geometry manager back. */
    finish() {
      if (tracker) tracker.restore();
      for (const [presetId, preset] of heldSites) if (!manager.getPreset(presetId)) manager.addPreset(preset);
      ctx.setPhotoMode(false);
      const failed = results.filter((line) => line.startsWith('FAIL'));
      return check('preset checks', failed.length === 0, `${results.length - failed.length}/${results.length} passed`);
    },
  };
  window.__dwPresets = api;
  return api;
}
