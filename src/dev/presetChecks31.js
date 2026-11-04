// Dev-only checks for presets 31-40 (Phase 3 wave 3, batch p3/presets-31-40): installPresetChecks31(game)
// installs the generic preset kit of presetChecks.js (window.__dwPresets: conditions, start, frame,
// discovered, site, end with the shared dispose check) and adds the batch's own checks to it:
//   - grow(presetId): the weather volumes of a spawn grown at once (a still does not wait minutes);
//   - wind(presetId, probes): the WindField probed at points in the spawn's frame, each judged
//     against its expectations (the gust front of a sandstorm, the calm eye and violent eyewall);
//   - cockpit(presetId, offset, expect): the craft parked inside the spawn in the cockpit view, the
//     weather volume's camera weather judged (a sandstorm's grit, a squall's whiteout);
//   - chase(): back to the chase view and out of photo mode;
//   - parts(presetId, expect): engine facts of a live spawn (colliders, lava ribbons, water bodies);
//   - siteActive(presetId, active): the active state of presetId's site (an eruption): the site the
//     generic kit's site() built, the nearest real one to the world's spawn;
//   - siteFacts(presetId, expect): that site's recipe facts, colliders and perches, its
//     emitters' sea entries (on the water, by the lava's end) and the water bodies its stamps hold.
// tools/steps/presets-31-40.json drives it (a dev server: it imports this module by URL). Never part of
// a production build: only step files import it. Every failed check calls console.error.
import { installPresetChecks } from './presetChecks.js';
import { createFraming, frames, wait } from './spawnCheckKit.js';
import { PRESET_BY_ID } from '../spawns/presets/index.js';

const DEG = Math.PI / 180;
/** How far from the world's spawn the generic kit's site() looks for a real site (m). */
const SITE_SEARCH_RADIUS = 90000;

export function installPresetChecks31(game) {
  const api = installPresetChecks(game);
  const { ctx, state } = game;
  const THREE = ctx.THREE;
  const manager = ctx.systems.spawns.manager;
  const probePoint = new THREE.Vector3();
  const framing = createFraming(ctx);
  const surfaceAt = (x, z) => Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL);
  const isWater = (x, z) => ctx.world.groundHeight(x, z) < ctx.world.WATER_LEVEL - 4;

  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    api.results.push(line);
    if (!ok) console.error(`[presets check] ${line}`);
    return line;
  }

  /** The site the generic kit's site() builds for presetId (the nearest real one to the world's spawn), or null. */
  function siteOf(presetId) {
    return manager.findNearestSite(presetId, state.spawn.x, state.spawn.z, SITE_SEARCH_RADIUS);
  }

  /**
   * The live spawn of presetId: for a site preset the spawn of siteOf(presetId) while it is live (other
   * sites of the preset may be live too), else the newest; or null.
   */
  function spawnOf(presetId) {
    const active = manager.getActive().filter((record) => record.presetId === presetId);
    const site = PRESET_BY_ID[presetId] && PRESET_BY_ID[presetId].kind === 'site' ? siteOf(presetId) : null;
    const siteSpawnId = site ? manager.getSiteSpawn(site.id) : null;
    const own = siteSpawnId ? active.find((record) => record.id === siteSpawnId) : null;
    return own ?? (active.length > 0 ? active[active.length - 1] : null);
  }

  /** The spawn's activation heading (degrees), read from a weather volume part's frame (else 0). */
  function headingOf(record) {
    const volume = manager.getParts(record.id).find((part) => part.engine === 'weatherVolume');
    return volume ? Math.atan2(volume.data.forwardX, -volume.data.forwardZ) / DEG : 0;
  }

  /** World point at [right, up, forward] metres from the spawn's first part anchor, in its heading's frame; up is above the ground or water there. */
  function framePoint(record, offset, out) {
    const parts = manager.getParts(record.id);
    const anchor = parts[0].anchor;
    const heading = headingOf(record) * DEG;
    const [right, up, forward] = offset;
    const x = anchor.x + Math.cos(heading) * right + Math.sin(heading) * forward;
    const z = anchor.z + Math.sin(heading) * right - Math.cos(heading) * forward;
    out.set(x, Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL) + up, z);
    return out;
  }

  /**
   * A start point and heading from which `distance` ahead lies on `surface` ('water': open water, the
   * point and a ring of points `clear` m around it; 'land': dry land), searched outward from the
   * world's spawn. Returns { x, z, heading } or null.
   */
  function startFacing(surface, distance, clear) {
    const origin = state.spawn;
    for (let ring = 0; ring <= 20; ring++) {
      const reach = ring * 4000;
      const steps = ring === 0 ? 1 : 24;
      for (let step = 0; step < steps; step++) {
        const angle = (step / steps) * Math.PI * 2;
        const x = origin.x + Math.sin(angle) * reach;
        const z = origin.z - Math.cos(angle) * reach;
        let ok = surface === 'water' ? isWater(x, z) : !isWater(x, z);
        for (let around = 0; ok && around < 8; around++) {
          const turn = (around / 8) * Math.PI * 2;
          const aroundX = x + Math.sin(turn) * clear;
          const aroundZ = z - Math.cos(turn) * clear;
          ok = surface === 'water' ? isWater(aroundX, aroundZ) : !isWater(aroundX, aroundZ);
        }
        if (!ok) continue;
        const heading = ring === 0 ? origin.heading : (angle * 180) / Math.PI;
        const radians = (heading * Math.PI) / 180;
        return { x: x - Math.sin(radians) * distance, z: z + Math.cos(radians) * distance, heading };
      }
    }
    return null;
  }

  Object.assign(api, {
    /**
     * start() (the generic kit's force-spawn, baseline and run) from a start point that puts the spawn
     * over `surface` (see startFacing): the world's spawn point is moved there for the call only.
     */
    async startOn(presetId, surface, options = {}) {
      const distance = options.distance ?? 1500;
      const point = startFacing(surface, distance, options.clear ?? 2000);
      if (!point) return check(`${presetId}: a start with ${surface} ${distance} m ahead`, false, 'none within 80 km of the spawn');
      const saved = { x: state.spawn.x, y: state.spawn.y, z: state.spawn.z, heading: state.spawn.heading };
      Object.assign(state.spawn, { x: point.x, y: surfaceAt(point.x, point.z), z: point.z, heading: point.heading });
      try {
        return await api.start(presetId, options);
      } finally {
        Object.assign(state.spawn, saved);
      }
    },

    /**
     * Frames presetId's spawn in photo mode from camera [right, up, forward] (up above the anchor) at
     * target [right, up, forward], both in the spawn's frame, with an optional fov.
     */
    async frameAt(presetId, { camera, target, fov }) {
      const record = spawnOf(presetId);
      if (!record) return check(`${presetId}: framed`, false, 'no live spawn');
      const anchor = manager.getParts(record.id)[0].anchor;
      const heading = headingOf(record) * DEG;
      const toWorld = ([right, up, forward]) => ({
        x: anchor.x + Math.cos(heading) * right + Math.sin(heading) * forward,
        y: anchor.y + up,
        z: anchor.z + Math.sin(heading) * right - Math.cos(heading) * forward,
      });
      const position = toWorld(camera);
      position.y = Math.max(position.y, surfaceAt(position.x, position.z) + 20);
      const settled = await framing.frameView(position, toWorld(target), { fov });
      return check(`${presetId}: framed`, true, { terrainSettled: settled, camera: { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } });
    },

    /**
     * Holds every game preset but presetId (the site feed then builds only its sites, and no other
     * spawn's wind, modifiers or geometry moves the dispose baselines while the craft travels).
     */
    isolate(presetId) {
      const held = ctx.systems.spawns.debug.holdGamePresets();
      const preset = PRESET_BY_ID[presetId];
      if (preset && !manager.getPreset(presetId)) manager.addPreset(preset);
      return check(`${presetId}: isolated from the other game presets`, Boolean(manager.getPreset(presetId)), { held: held.length });
    },

    /** Gives the game presets back (presetId out first, so the release adds every preset once). */
    release(presetId) {
      if (presetId && manager.getPreset(presetId)) manager.removePreset(presetId);
      const released = ctx.systems.spawns.debug.releaseGamePresets();
      return `released ${released.length} presets`;
    },

    /** Enters and leaves the cockpit view once (its instruments' first draw is not a spawn's memory). */
    async warmCockpit() {
      ctx.setPhotoMode(false);
      ctx.systems.camera.setView('cockpit');
      await wait(1500);
      ctx.systems.camera.setView('chase');
      await frames(10);
      return 'cockpit view warmed';
    },

    /** Grows every weather volume of presetId's live spawn to `growth` at once. */
    grow(presetId, growth = 1) {
      const record = spawnOf(presetId);
      let grown = 0;
      for (const part of record ? manager.getParts(record.id) : []) {
        if (part.engine !== 'weatherVolume') continue;
        part.data.growth = growth;
        grown++;
      }
      return check(`${presetId}: weather volumes grown to ${growth}`, grown > 0, { grown });
    },

    /**
     * Moves the windModifier parts of presetId's live spawn `seconds` on in their own clock (their
     * sources' fade-ins are past at once; photo mode holds the simulation clock).
     */
    windAge(presetId, seconds) {
      const record = spawnOf(presetId);
      let moved = 0;
      for (const part of record ? manager.getParts(record.id) : []) {
        if (part.engine !== 'windModifier') continue;
        part.data.numbers[0] += seconds;
        moved++;
      }
      return check(`${presetId}: wind sources ${seconds} s on`, moved > 0, { moved });
    },

    /**
     * Probes the wind at each probe { label, offset: [right, up, forward], speedMin, speedMax,
     * turbulenceMin, turbulenceMax, upMin, upMax } (every bound optional) and judges it, out of photo
     * mode (the engines update their sources only while the simulation runs).
     */
    async wind(presetId, probes) {
      const record = spawnOf(presetId);
      if (!record) return check(`${presetId}: wind`, false, 'no live spawn');
      ctx.setPhotoMode(false);
      await frames(6);
      const rows = [];
      let ok = true;
      for (const probe of probes) {
        framePoint(record, probe.offset, probePoint);
        const sample = ctx.wind.probe(probePoint);
        const speed = Math.hypot(sample.vel.x, sample.vel.y, sample.vel.z);
        const pass = (probe.speedMin === undefined || speed >= probe.speedMin) && (probe.speedMax === undefined || speed <= probe.speedMax)
          && (probe.turbulenceMin === undefined || sample.turbulence >= probe.turbulenceMin) && (probe.turbulenceMax === undefined || sample.turbulence <= probe.turbulenceMax)
          && (probe.upMin === undefined || sample.vel.y >= probe.upMin) && (probe.upMax === undefined || sample.vel.y <= probe.upMax);
        ok = ok && pass;
        rows.push({ label: probe.label, pass, speed: Math.round(speed * 10) / 10, up: Math.round(sample.vel.y * 10) / 10, turbulence: Math.round(sample.turbulence * 100) / 100 });
      }
      return check(`${presetId}: its wind where the spec says (${probes.map((probe) => probe.label).join(', ')})`, ok, rows);
    },

    /**
     * Parks the craft at [right, up, forward] in the spawn's frame, in the cockpit view, out of photo
     * mode, and judges the weather volume's camera weather after `seconds`: expect { inside, canopy,
     * grit, rain } minimums (each optional).
     */
    async cockpit(presetId, offset, expect = {}, seconds = 4) {
      const record = spawnOf(presetId);
      if (!record) return check(`${presetId}: cockpit`, false, 'no live spawn');
      ctx.setPhotoMode(false);
      framePoint(record, offset, probePoint);
      ctx.systems.flight.resetTo({ x: probePoint.x, y: probePoint.y, z: probePoint.z, heading: headingOf(record) });
      ctx.systems.camera.setView('cockpit');
      await wait(seconds * 1000);
      const weather = manager.registry.get('weatherVolume').getCameraWeather();
      const ok = ['inside', 'canopy', 'grit', 'rain'].every((key) => expect[key] === undefined || weather[key] >= expect[key]);
      return check(`${presetId}: inside it in the cockpit (${Object.keys(expect).join(', ')})`, ok, weather);
    },

    /** Back to the chase view, out of photo mode. */
    async chase() {
      ctx.setPhotoMode(false);
      ctx.systems.camera.setView('chase');
      await frames(10);
      return 'chase view';
    },

    /**
     * Engine facts of presetId's live spawn: expect { colliders (minimum), engines: { [engine]:
     * { [field]: minimum } } over describe() or the instance's own fields }.
     */
    parts(presetId, expect = {}) {
      const record = spawnOf(presetId);
      if (!record) return check(`${presetId}: parts`, false, 'no live spawn');
      const parts = manager.getParts(record.id);
      const colliders = parts.reduce((sum, part) => sum + (part.colliderIds ? part.colliderIds.length : 0), 0);
      const facts = { colliders, parts: parts.map((part) => part.engine) };
      let ok = expect.colliders === undefined || colliders >= expect.colliders;
      for (const [engineName, fields] of Object.entries(expect.engines ?? {})) {
        const part = parts.find((entry) => entry.engine === engineName);
        const engine = manager.registry.get(engineName);
        const described = part && engine && typeof engine.describe === 'function' ? engine.describe(part) : part ? part.data : null;
        for (const [field, minimum] of Object.entries(fields)) {
          const value = described ? described[field] : undefined;
          facts[`${engineName}.${field}`] = value;
          ok = ok && Number.isFinite(value) && value >= minimum;
        }
      }
      return check(`${presetId}: its parts (${Object.keys(expect).join(', ')})`, ok, facts);
    },

    /**
     * The river form of presetId's live spawn: its flow paths (streams and pours) and the puffs it
     * draws; expect { paths, puffs } minimums.
     */
    river(presetId, expect = {}) {
      const record = spawnOf(presetId);
      const part = record ? manager.getParts(record.id).find((entry) => entry.engine === 'weatherVolume') : null;
      if (!part) return check(`${presetId}: river`, false, 'no live weather volume');
      const flow = part.data.layout.flow;
      const facts = { paths: flow ? flow.paths : 0, points: flow ? flow.pointCount : 0, puffs: part.data.layout.puffCount, drawn: part.data.puffsDrawn };
      const ok = facts.paths >= (expect.paths ?? 1) && facts.drawn >= (expect.puffs ?? 1);
      return check(`${presetId}: fog flowing on its paths (${facts.paths} paths, ${facts.drawn} puffs drawn)`, ok, facts);
    },

    /**
     * Counts presetId's lightning over `seconds` of live flight (the engine's strike counters, shared
     * by every lightEffect instance, so the batch runs it with the game's presets held): at least
     * `minimum` strikes, `inCloud` of them at least in the cloud.
     */
    async strikes(presetId, { seconds = 8, minimum = 1, inCloud = 0 } = {}) {
      const record = spawnOf(presetId);
      const part = record ? manager.getParts(record.id).find((entry) => entry.engine === 'lightEffect') : null;
      if (!part) return check(`${presetId}: lightning`, false, 'no live lightEffect');
      const engine = manager.registry.get('lightEffect');
      ctx.setPhotoMode(false);
      const before = engine.describe(part).strikes;
      await wait(seconds * 1000);
      const after = engine.describe(part).strikes;
      const delta = {};
      for (const key of Object.keys(after)) delta[key] = after[key] - (before[key] ?? 0);
      return check(`${presetId}: lightning in ${seconds} s (${delta.strikes} strikes, ${delta.cloud} in the cloud)`, delta.strikes >= minimum && delta.cloud >= inCloud, delta);
    },

    /**
     * Starts or ends the active state (an eruption) of presetId's site (siteOf: the one site() built),
     * out of photo mode (photo mode holds the simulation clock, so the eruption builds only while the
     * game runs).
     */
    async siteActive(presetId, active = true) {
      const site = siteOf(presetId);
      const spawnId = site ? manager.getSiteSpawn(site.id) : null;
      if (!spawnId) return check(`${presetId}: its site's active state ${active ? 'started' : 'ended'}`, false, 'its site (the one site() built) is not live');
      ctx.setPhotoMode(false);
      const result = manager.setSiteActive(spawnId, active);
      await frames(10);
      const instance = manager.getInstance(spawnId);
      return check(`${presetId}: its site's active state ${active ? 'started' : 'ended'}`, result !== false && instance && instance.active === active, { spawnId, active: instance ? instance.active : null });
    },

    /**
     * The facts of presetId's site spawn (siteOf: the one site() built), judged against expect: {
     * facts: { [name]: minimum } (the structure recipe's out.facts), colliders (minimum), perches
     * (minimum perch colliders), seaEntries (minimum emitters with seaEntry that reached the sea, each
     * standing on the water), waters: { count, kind, mirror } (the local water bodies within the
     * site's reach) }.
     */
    siteFacts(presetId, expect = {}) {
      const site = siteOf(presetId);
      const spawnId = site ? manager.getSiteSpawn(site.id) : null;
      if (!spawnId) return check(`${presetId}: site facts`, false, 'its site (the one site() built) is not live');
      const parts = manager.getParts(spawnId);
      const structure = parts.find((part) => part.engine === 'structure');
      const facts = structure && structure.data.facts ? { ...structure.data.facts } : {};
      const colliderIds = parts.flatMap((part) => part.colliderIds ?? []);
      const colliderSet = new Set(colliderIds);
      const perches = ctx.colliders ? ctx.colliders.list().filter((entry) => colliderSet.has(entry.id) && entry.tags && entry.tags.perch).length : 0;
      const entries = parts.filter((part) => part.engine === 'emitter' && part.data.config.seaEntry);
      const seaEntries = entries.filter((part) => part.data.reachedSea === true && ctx.world.groundHeight(part.anchor.x, part.anchor.z) < ctx.world.WATER_LEVEL).length;
      const bodies = [];
      ctx.waterQuery.bodiesNear(site.x, site.z, 2500, (body) => bodies.push({ kind: body.kind, mirror: body.mirror, level: Math.round(body.level * 10) / 10 }));
      const result = { site: site.id, facts, colliders: colliderIds.length, perches, seaEntries: `${seaEntries}/${entries.length}`, waters: bodies.length, waterKinds: [...new Set(bodies.map((body) => body.kind))] };
      let ok = true;
      for (const [name, minimum] of Object.entries(expect.facts ?? {})) ok = ok && Number.isFinite(facts[name]) && facts[name] >= minimum;
      if (expect.colliders !== undefined) ok = ok && colliderIds.length >= expect.colliders;
      if (expect.perches !== undefined) ok = ok && perches >= expect.perches;
      if (expect.seaEntries !== undefined) ok = ok && seaEntries >= expect.seaEntries;
      if (expect.waters) {
        const matching = bodies.filter((body) => (expect.waters.kind === undefined || body.kind === expect.waters.kind) && (expect.waters.mirror === undefined || body.mirror >= expect.waters.mirror));
        ok = ok && matching.length >= (expect.waters.count ?? 1);
      }
      return check(`${presetId}: its site's parts (${Object.keys(expect).join(', ')})`, ok, result);
    },

    /** The player's position and the state the step file reports (debug). */
    where() {
      const player = state.player.position;
      return { x: Math.round(player.x), y: Math.round(player.y), z: Math.round(player.z), heading: Math.round(state.player.heading) };
    },
  });
  return api;
}
