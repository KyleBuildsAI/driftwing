// Preset pacing lab: runs the event director (src/spawns/director.js) headless with the REAL preset
// list (src/spawns/presets/index.js), the real world generator and its real site placement, over
// simulated flight paths (the director lab, tools/lab/director.mjs, proves the director's rules on
// stub presets; this lab shows how the shipped presets pace a flight).
//
// The spawn manager is a lenient stand-in: it admits every activation, ends events at their drawn
// duration, keeps one spawn per site within the site's lod.far (so a site's active state, such as
// the volcano's eruption, can be started) and reports a site coming into view (12 km, a 100 degree
// view cone), as the game's manager does.
//
// Checks:
//   presets   every preset validates and the director takes every one of them
//   reach     every event preset is activated at least once across the runs, and the volcano's
//             eruption (a site active state) too
//   ahead     no director activation lies behind the player
// Printed (not checked, see the batch notes): per scenario, the share of droughts that end within the
// 90 s pacing window, the longest drought, and the activations per preset. The pacing floor is a
// dense "anywhere, anytime" common event, which later preset batches bring (the geese, docs/specs/
// phase2.md preset 15); the shares are reported so each batch can see what its presets add.
//
// Usage: node tools/lab/preset-pacing.mjs [--hours 3] [--verbose]
import { CONFIG, WORLD_OPTIONS } from '../../src/core/config.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { PACING_WINDOW_MAX, createDirector } from '../../src/spawns/director.js';
import { angleBetween, bearingDegrees, hashString } from '../../src/spawns/candidates.js';
import { createWeatherModel } from '../../src/spawns/weather.js';
import { validatePresets } from '../../src/spawns/schema.js';
import { ENGINE_NAMES } from '../../src/spawns/engineRegistry.js';
import { PRESETS } from '../../src/spawns/presets/index.js';

function parseArgs(argv) {
  const options = { hours: 3, verbose: false };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--verbose') options.verbose = true;
    else if (flag === '--hours') options.hours = Number(argv[++index]);
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!(options.hours > 0)) throw new Error('--hours must be positive');
  return options;
}
const OPTIONS = parseArgs(process.argv);

const results = [];
function check(group, name, pass, detail = '') {
  results.push({ group, name, pass: Boolean(pass), detail });
}

const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));
const SPEEDS = Object.freeze({
  glider: { speed: 35, altitude: [700, 1800] },
  bushplane: { speed: 60, altitude: [300, 1500] },
  jet: { speed: 220, altitude: [1500, 6000] },
});
const STEP_SECONDS = 0.1;
const SITE_VIEW_RANGE = 12000;

function mulberry32(state) {
  let value = state | 0;
  return function next() {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A scripted wandering path: seeded turns at a limited rate, a slowly varying altitude. */
function createFlightPath({ pathSeed, speed, altitude: [lowAltitude, highAltitude], turnRate = 3 }) {
  const random = mulberry32(hashString(pathSeed));
  const player = { position: { x: 0, y: lowAltitude, z: 0 }, heading: random() * 360, speed };
  let targetHeading = player.heading;
  let nextTurnAt = 30 + random() * 60;
  const altitudePhase = random() * Math.PI * 2;
  return {
    player,
    step(dt, time) {
      if (time >= nextTurnAt) {
        const sign = random() < 0.5 ? -1 : 1;
        targetHeading = (player.heading + sign * (20 + random() * 100) + 360) % 360;
        nextTurnAt = time + 30 + random() * 60;
      }
      const difference = ((targetHeading - player.heading + 540) % 360) - 180;
      player.heading = (player.heading + Math.max(-turnRate * dt, Math.min(turnRate * dt, difference)) + 360) % 360;
      const radians = (player.heading * Math.PI) / 180;
      player.position.x += Math.sin(radians) * speed * dt;
      player.position.z -= Math.cos(radians) * speed * dt;
      player.position.y = lowAltitude + (highAltitude - lowAltitude) * (0.5 + 0.5 * Math.sin(time / 400 + altitudePhase));
    },
  };
}

/** The sun on the game's day clock, starting at startDayTime. */
function createSun(startDayTime) {
  const sun = { sunElevation: 0, dayTime: startDayTime };
  return {
    sun,
    update(time) {
      sun.dayTime = (startDayTime + time / CONFIG.DAY_LENGTH_DEFAULT) % 1;
      sun.sunElevation = Math.sin((sun.dayTime - 0.25) * Math.PI * 2) * CONFIG.SUN_MAX_ELEVATION_DEG;
    },
  };
}

function createView(player) {
  return function isInView(x, y, z, radius) {
    const distance = Math.hypot(x - player.position.x, z - player.position.z);
    if (distance > 40000) return false;
    if (distance <= radius) return true;
    const widen = (Math.atan2(radius, distance) * 180) / Math.PI;
    return angleBetween(bearingDegrees(player.position.x, player.position.z, x, z), player.heading) <= 50 + widen;
  };
}

/** The lenient manager: admits everything, one spawn per site within lod.far, events end at their duration. */
function createLenientManager({ bus, player, getTime, placement, isInView }) {
  const instances = new Map();
  const siteSpawns = new Map();
  const seenSites = new Set();
  const records = [];
  let serial = 0;
  const stats = { engines: {}, total: { lights: 0 } };
  for (const name of ENGINE_NAMES) stats.engines[name] = { instances: 0, particles: 0 };
  const describe = (instance) => instance;
  function create(preset, position, source, duration, site) {
    const id = `i${++serial}`;
    const instance = { id, presetId: preset.id, anchor: { x: position.x, y: position.y, z: position.z }, radius: 800, heavy: preset.heavy, ended: false, source, endsAt: duration ? getTime() + duration : Infinity, site, duration };
    instances.set(id, instance);
    return instance;
  }
  return {
    records,
    activate(presetId, options) {
      const preset = PRESET_BY_ID.get(presetId);
      const time = getTime();
      const bearing = bearingDegrees(player.position.x, player.position.z, options.position.x, options.position.z);
      records.push({ time, presetId, offAxis: angleBetween(bearing, player.heading), distance: Math.hypot(options.position.x - player.position.x, options.position.z - player.position.z) });
      return create(preset, options.position, options.source, options.duration, options.site || null).id;
    },
    deactivate(id) { return instances.delete(id); },
    getActive() { return [...instances.values()].map(describe); },
    getInstance(id) { const instance = instances.get(id); return instance && !instance.ended ? instance : null; },
    getStats() { return stats; },
    getSiteSpawn(siteId) { const instance = siteSpawns.get(siteId); return instance ? instance.id : null; },
    setSiteActive(id, active) {
      const instance = instances.get(id);
      if (!instance || instance.source !== 'site') return false;
      if (active && !instance.active) records.push({ time: getTime(), presetId: instance.presetId, offAxis: angleBetween(bearingDegrees(player.position.x, player.position.z, instance.anchor.x, instance.anchor.z), player.heading), distance: Math.hypot(instance.anchor.x - player.position.x, instance.anchor.z - player.position.z), siteActive: true });
      instance.active = active;
      return true;
    },
    update() {
      const time = getTime();
      for (const instance of instances.values()) {
        if (instance.ended) instances.delete(instance.id);
        else if (instance.source !== 'site' && time >= instance.endsAt) instance.ended = true;
      }
      const sites = placement.sitesNear(player.position.x, player.position.z, 45000);
      for (const site of sites) {
        const preset = PRESET_BY_ID.get(site.presetId);
        if (!preset) continue;
        const distance = Math.hypot(site.x - player.position.x, site.z - player.position.z);
        if (!siteSpawns.has(site.id) && distance < preset.lod.far) siteSpawns.set(site.id, create(preset, { x: site.x, y: site.groundY, z: site.z }, 'site', null, site));
        if (!seenSites.has(site.id) && distance < SITE_VIEW_RANGE && isInView(site.x, site.groundY, site.z, 500)) {
          seenSites.add(site.id);
          bus.emit('spawns:siteInView', { id: site.id, presetId: site.presetId });
        }
      }
      for (const [siteId, instance] of siteSpawns) {
        const preset = PRESET_BY_ID.get(instance.presetId);
        if (Math.hypot(instance.anchor.x - player.position.x, instance.anchor.z - player.position.z) > preset.lod.far + preset.lifetime.despawn.hysteresis) {
          instances.delete(instance.id);
          siteSpawns.delete(siteId);
        }
      }
    },
  };
}

function runScenario({ seed, craft, hours, startDayTime }) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const world = createWorldGen(seed, WORLD_OPTIONS);
  const path = createFlightPath({ pathSeed: `${seed}-${craft}-${startDayTime}`, ...SPEEDS[craft] });
  const sun = createSun(startDayTime);
  let time = 0;
  const getTime = () => time;
  const isInView = createView(path.player);
  const manager = createLenientManager({ bus, player: path.player, getTime, placement: world.placement, isInView });
  const director = createDirector({
    seedHash: world.seedHash >>> 0,
    presets: PRESETS,
    spawnManager: manager,
    weather: createWeatherModel(world.seedHash >>> 0),
    terrain: { heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: CONFIG.WATER_LEVEL },
    getPlayer: () => path.player,
    getTime,
    getSun: () => sun.sun,
    isInView,
    placement: world.placement,
    bus,
    devHooks: true,
  });
  const totalSteps = Math.round((hours * 3600) / STEP_SECONDS);
  let nextManagerTick = 0;
  for (let step = 0; step <= totalSteps; step++) {
    time = step * STEP_SECONDS;
    path.step(STEP_SECONDS, time);
    sun.update(time);
    if (time >= nextManagerTick) {
      nextManagerTick += 0.5;
      manager.update();
    }
    director.update();
  }
  const state = director.getState();
  const log = director.getLog();
  director.dispose();
  return { state, log, records: manager.records };
}

// ---- run ----------------------------------------------------------------------------------------
const started = Date.now();
let validated = '';
try {
  validatePresets(PRESETS, { engineNames: [...ENGINE_NAMES] });
} catch (error) {
  validated = error.message;
}
check('presets', `the ${PRESETS.length} real presets validate`, validated === '', validated || PRESETS.map((preset) => preset.id).join(', '));

const counts = new Map(PRESETS.map((preset) => [preset.id, 0]));
let behind = 0;
let activations = 0;
const rows = [];
for (const seed of ['DRIFTWING', 'HARNESS-1', 'P2-TERRAIN']) {
  for (const craft of Object.keys(SPEEDS)) {
    // Day (golden hour start, through the afternoon and dusk into night) and a night start.
    for (const startDayTime of [0.62, 0.95]) {
      const run = runScenario({ seed, craft, hours: OPTIONS.hours, startDayTime });
      for (const record of run.records) {
        if (record.offAxis >= 90 && !record.siteActive) behind++;
        activations++;
      }
      for (const entry of run.log) counts.set(entry.presetId, (counts.get(entry.presetId) ?? 0) + 1);
      const pacing = run.state.pacing;
      const share = pacing.droughts > 0 ? pacing.withinWindow / pacing.droughts : 1;
      rows.push(`${seed.padEnd(11)} ${craft.padEnd(9)} ${startDayTime === 0.62 ? 'day  ' : 'night'}  ${String(pacing.withinWindow).padStart(4)}/${String(pacing.droughts).padEnd(4)} droughts within ${PACING_WINDOW_MAX} s (${(share * 100).toFixed(1).padStart(5)} %), longest ${String(run.state.longestDrought).padStart(5)} s, ${run.log.length} activations`);
    }
  }
}
const events = PRESETS.filter((preset) => preset.kind === 'event');
const missing = events.filter((preset) => counts.get(preset.id) === 0).map((preset) => preset.id);
check('reach', 'every event preset is activated at least once across the runs', missing.length === 0, missing.length ? `never: ${missing.join(', ')}` : [...counts].map(([id, count]) => `${id} ${count}`).join(', '));
const activeStates = PRESETS.filter((preset) => preset.activeState);
const unstarted = activeStates.filter((preset) => counts.get(preset.id) === 0).map((preset) => preset.id);
check('reach', 'every site active state (the eruption) is started at least once', unstarted.length === 0, unstarted.length ? `never: ${unstarted.join(', ')}` : activeStates.map((preset) => `${preset.id} ${counts.get(preset.id)}`).join(', '));
check('ahead', 'no director activation behind the player', behind === 0, `${behind} of ${activations} behind`);

process.stdout.write(`\npacing with the real presets (${OPTIONS.hours} h per run, informational):\n`);
for (const row of rows) process.stdout.write(`  ${row}\n`);
process.stdout.write('\n');
let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.group.padEnd(8)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\npreset pacing lab: ${results.length - failed}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s\n`);
process.exit(failed === 0 ? 0 : 1);
