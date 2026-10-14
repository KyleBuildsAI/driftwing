// Dev-only checks for presets 31-40 (Phase 3 wave 3, batch p3/presets-31-40): installPresetChecks31(game)
// installs the generic preset kit of presetChecks.js (window.__dwPresets: conditions, start, frame,
// discovered, site, end with the shared dispose check) and adds the batch's own checks to it:
//   - grow(presetId): the weather volumes of a spawn grown at once (a still does not wait minutes);
//   - wind(presetId, probes): the WindField probed at points in the spawn's frame, each judged
//     against its expectations (the gust front of a sandstorm, the calm eye and violent eyewall);
//   - cockpit(presetId, offset, expect): the craft parked inside the spawn in the cockpit view, the
//     weather volume's camera weather judged (a sandstorm's grit, a squall's whiteout);
//   - chase(): back to the chase view and out of photo mode;
//   - parts(presetId, expect): engine facts of a live spawn (colliders, lava ribbons, water bodies).
// tools/steps/presets-31-40.json drives it (a dev server: it imports this module by URL). Never part of
// a production build: only step files import it. Every failed check calls console.error.
import { installPresetChecks } from './presetChecks.js';
import { frames, wait } from './spawnCheckKit.js';
import { PRESET_BY_ID } from '../spawns/presets/index.js';

const DEG = Math.PI / 180;

export function installPresetChecks31(game) {
  const api = installPresetChecks(game);
  const { ctx, state } = game;
  const THREE = ctx.THREE;
  const manager = ctx.systems.spawns.manager;
  const probePoint = new THREE.Vector3();

  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    api.results.push(line);
    if (!ok) console.error(`[presets check] ${line}`);
    return line;
  }

  /** The live spawn of presetId (the newest), or null. */
  function spawnOf(presetId) {
    const active = manager.getActive().filter((record) => record.presetId === presetId);
    return active.length > 0 ? active[active.length - 1] : null;
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

  Object.assign(api, {
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
     * Probes the wind at each probe { label, offset: [right, up, forward], speedMin, speedMax,
     * turbulenceMin, turbulenceMax, upMin, upMax } (every bound optional) and judges it.
     */
    wind(presetId, probes) {
      const record = spawnOf(presetId);
      if (!record) return check(`${presetId}: wind`, false, 'no live spawn');
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

    /** The player's position and the state the step file reports (debug). */
    where() {
      const player = state.player.position;
      return { x: Math.round(player.x), y: Math.round(player.y), z: Math.round(player.z), heading: Math.round(state.player.heading) };
    },
  });
  return api;
}
