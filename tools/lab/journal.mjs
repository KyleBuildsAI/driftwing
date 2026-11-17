// Journal lab (contract j.1, Milestone O): the global records the journal keeps across every world
// (src/gameplay/journal.js), headless in node on the storage module's in-memory backend.
//
// Tests:
//   collection   the spawn collection reads x / 100 over the real presets (through the spawn manager's
//                registry and through the built-in list), every preset listed once
//   figures      figureFlown counts each figure and keeps its best score (0-100); unknown figures and
//                unusable scores are refused; saved with the throttled saves
//   perches      perched (settled) counts the perch and its kind; a take-off or an unknown kind does not
//   altitude     the maxAltitude statistic (op max, metres) follows the flight every frame, space
//                included (a 104 km climb reads 104 km, nothing clamps it); lower or broken altitudes
//                never lower it
//   craft        flight time per craft and per skin (the eagle's dragon); every craft module's
//                journal.stats keys join the known statistics (listJournalStats, journalStatInfo)
//   medals       the challenge medals and best times are read from the challenge system
//                (getRecords), never stored in the journal's records
//   worlds       worldVisited keeps the seed, where from and the portal; the list keeps the newest 200
//   migration    a version 1 record and the version 2 shape migrate to version 3 (figures from the
//                figure best scores, perches from eaglePerches, the highest altitude from every world's
//                journal and the balloon's and spaceplane's records), are saved back as version 3 at
//                once, and a version 3 record loads unchanged
//   hostile      corrupt and hostile storage (wrong types, prototype keys, NaN, Infinity, negative
//                and huge values, oversized maps and lists) loads clean and capped
//   allocation   a climbing flight's frames (flight time per craft and skin, the highest altitude)
//                allocate nothing (run with --expose-gc)
//
// Usage: node --expose-gc tools/lab/journal.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { WORLD_OPTIONS } from '../../src/core/config.js';
import { storage } from '../../src/core/storage.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { PRESETS } from '../../src/spawns/presets/index.js';
import { FIGURES } from '../../src/flight/maneuverRecognizer.js';
import { craftRegistry } from '../../src/craft/index.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

// The journal listens for the page hiding; node has no document or window, so give it inert ones.
globalThis.document ??= { visibilityState: 'visible', addEventListener() {} };
globalThis.window ??= { addEventListener() {} };
const { RECORDS_STORAGE_KEY, RECORDS_VERSION, JOURNAL_STATS, PERCH_KINDS, createJournal, journalStatInfo, listJournalStats } = await import('../../src/gameplay/journal.js');

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => consoleErrors.push(args.map(String).join(' '));

const WORLD = createWorldGen('JOURNAL-LAB', WORLD_OPTIONS);
const POSITION = Object.freeze({ x: 10, y: 400, z: -20 });

/** Clears every key the journal owns (the records and the per-world journals). */
function clearStorage() {
  storage.remove(RECORDS_STORAGE_KEY);
  for (const key of storage.keys('driftwing-v2.journal.')) storage.remove(key);
}

/**
 * A game session in world seed: the bus (typed payloads validated), the journal and the stand-ins it
 * reads (a spawn manager over `presets`, an optional challenge system).
 */
function session(seed, { presets = PRESETS, manager = true, challenges = null } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const systems = {};
  if (manager) {
    systems.spawns = { manager: { listPresets: () => [...presets], getPreset: (id) => presets.find((preset) => preset.id === id) ?? null, markDiscovered() {} } };
  }
  if (challenges) systems.challenges = challenges;
  const state = {
    seed,
    time: { dayTime: 0.4, label: 'morning', elapsed: 0 },
    player: { biome: WORLD.biomeAt(0, 0), speed: 0, altitude: 0 },
    flight: { craft: 'glider', craftState: {} },
  };
  const journal = createJournal({ bus, state, world: WORLD, systems });
  return { bus, journal, state };
}

/** Flies `seconds` of frames at 60 Hz, then a throttled save (realDt past the save interval). */
function fly(world, seconds, { altitude = null, save = true } = {}) {
  const frames = Math.round(seconds * 60);
  for (let frame = 0; frame < frames; frame++) {
    if (altitude !== null) world.state.player.altitude = typeof altitude === 'function' ? altitude(frame / frames) : altitude;
    world.journal.update(1 / 60, 0);
  }
  if (save) world.journal.update(0, 6);
}

// ---- Collection ------------------------------------------------------------------------------------
function testCollection() {
  clearStorage();
  const ids = PRESETS.map((preset) => preset.id);
  const viaManager = session('COLLECTION').journal.getCollection();
  check('collection', 'x / 100 over the spawn manager registry', viaManager.total === 100 && viaManager.found === 0, `${viaManager.found} / ${viaManager.total}`);
  check('collection', 'every preset is listed once, in registry order', viaManager.presets.length === 100 && new Set(viaManager.presets.map((preset) => preset.id)).size === 100 && viaManager.presets.every((preset, index) => preset.id === ids[index]));
  const builtIn = session('COLLECTION', { manager: false }).journal.getCollection();
  check('collection', 'x / 100 over the built-in list without a manager', builtIn.total === 100, `${builtIn.total}`);
  const world = session('COLLECTION');
  world.bus.emitTyped('discovery', { id: `${ids[0]}:1:1`, name: PRESETS[0].name, kind: PRESETS[0].category, position: POSITION, presetId: ids[0] });
  world.bus.emitTyped('discovery', { id: ids[99], name: PRESETS[99].name, kind: PRESETS[99].category, position: POSITION, presetId: ids[99] });
  const data = world.journal.getData();
  check('collection', 'discoveries count toward it (2 / 100)', data.collection.found === 2 && data.collection.total === 100, `${data.collection.found} / ${data.collection.total}`);
}

// ---- Figures ---------------------------------------------------------------------------------------
function testFigures() {
  clearStorage();
  const world = session('FIGURES');
  const flown = (figure, score) => world.bus.emitTyped('figureFlown', { figure, score, craft: 'aerobatic', position: POSITION });
  flown('loop', 72.4);
  flown('loop', 91.25);
  flown('loop', 64);
  flown('aileronRoll', 88);
  flown('hammerhead', 140);
  const refused = [world.journal.recordFigure({ figure: 'barrelLoop', score: 50 }), world.journal.recordFigure({ figure: 'loop', score: Number.NaN }), world.journal.recordFigure({ figure: 'loop', score: -3 }), world.journal.recordFigure(null)];
  const figures = world.journal.getRecords().figures;
  check('figures', 'each figure counts, with its best score', figures.loop?.count === 3 && figures.loop.bestScore === 91.3 && figures.aileronRoll?.count === 1 && figures.aileronRoll.bestScore === 88, JSON.stringify(figures));
  check('figures', 'scores clamp to 100', figures.hammerhead?.bestScore === 100, JSON.stringify(figures.hammerhead));
  check('figures', 'unknown figures and unusable scores are refused', refused.every((result) => result === null) && Object.keys(figures).length === 3 && figures.loop.count === 3, Object.keys(figures).join(', '));
  check('figures', 'the records list only figures the recognizer knows', Object.keys(figures).every((id) => FIGURES.some((figure) => figure.id === id)));
  const before = storage.read(RECORDS_STORAGE_KEY, null);
  world.journal.update(0, 6);
  const after = storage.read(RECORDS_STORAGE_KEY, null);
  check('figures', 'saved with the throttled saves, as the current version', !before?.figures?.loop && after.version === RECORDS_VERSION && after.figures.loop.count === 3, JSON.stringify(after.figures));
  const again = session('OTHER-WORLD').journal.getRecords().figures;
  check('figures', 'figures are global (another world reads them)', again.loop?.count === 3);
}

// ---- Perches ---------------------------------------------------------------------------------------
function testPerches() {
  clearStorage();
  const world = session('PERCHES');
  const perch = (kind, perched = true) => world.bus.emitTyped('perched', { craft: 'eagle', perchId: `${kind}:1`, kind, position: POSITION, perched });
  perch('peak');
  perch('peak');
  perch('tree');
  perch('structure');
  perch('peak', false);
  const refused = world.journal.recordPerch({ craft: 'eagle', perchId: 'x', kind: 'cloud', position: POSITION, perched: true });
  const perches = world.journal.getRecords().perches;
  check('perches', 'a settle counts the perch and its kind', perches.count === 4 && perches.kinds.peak === 2 && perches.kinds.tree === 1 && perches.kinds.structure === 1, JSON.stringify(perches));
  check('perches', 'a take-off and an unknown kind do not count', refused === null && perches.count === 4);
  check('perches', 'the kinds are those of the typed event', PERCH_KINDS.join() === 'peak,structure,tree' && Object.keys(perches.kinds).join() === PERCH_KINDS.join());
  world.journal.update(0, 6);
  check('perches', 'saved on the throttle and read by another world', session('ELSEWHERE').journal.getRecords().perches.count === 4);
}

// ---- Altitude --------------------------------------------------------------------------------------
function testAltitude() {
  clearStorage();
  check('altitude', 'maxAltitude is a known statistic: op max, altitude unit', JOURNAL_STATS.maxAltitude?.op === 'max' && JOURNAL_STATS.maxAltitude.unit === 'altitude' && journalStatInfo('maxAltitude') === JOURNAL_STATS.maxAltitude);
  const world = session('SPACE');
  world.state.flight.craft = 'spaceplane';
  fly(world, 10, { altitude: (share) => 3000 + share * 101000 });
  const climbed = world.journal.getRecords().stats.maxAltitude;
  check('altitude', 'a climb to space is followed every frame (nothing clamps it)', climbed && climbed.value > 103800 && climbed.value <= 104000 && climbed.op === 'max' && climbed.seed === 'SPACE', JSON.stringify(climbed));
  fly(world, 5, { altitude: 1500 });
  world.state.player.altitude = Number.NaN;
  world.journal.update(1 / 60, 6);
  world.state.player.altitude = -40;
  world.journal.update(1 / 60, 6);
  const kept = world.journal.getRecords().stats.maxAltitude;
  check('altitude', 'lower and broken altitudes never lower it', kept.value === climbed.value, JSON.stringify(kept));
  const saved = storage.read(RECORDS_STORAGE_KEY, null);
  check('altitude', 'saved on the throttle (metres, to 0.1 m)', saved.stats.maxAltitude.value === Math.round(climbed.value * 10) / 10, JSON.stringify(saved.stats.maxAltitude));
  const other = session('LOWLANDS');
  fly(other, 2, { altitude: 800 });
  check('altitude', 'it is global: a lower world keeps the space record', other.journal.getRecords().stats.maxAltitude.value === kept.value);
  world.bus.emitTyped('journalStat', { key: 'maxAltitude', value: 150000, op: 'max' });
  check('altitude', 'a journalStat maxAltitude folds with op max too', world.journal.getRecords().stats.maxAltitude.value === 150000);
}

// ---- Craft -----------------------------------------------------------------------------------------
function testCraft() {
  clearStorage();
  const world = session('CRAFT');
  world.state.flight = { craft: 'eagle', craftState: { skin: 'eagle' } };
  fly(world, 3, { save: false });
  world.state.flight.craftState.skin = 'dragon';
  fly(world, 2, { save: false });
  world.state.flight = { craft: 'jet', craftState: {} };
  fly(world, 1);
  const records = world.journal.getRecords();
  check('craft', 'flight time per craft', Math.abs(records.craftTime.eagle - 5) < 0.05 && Math.abs(records.craftTime.jet - 1) < 0.05, JSON.stringify(records.craftTime));
  check('craft', 'flight time per skin for a craft with skins (the eagle and the dragon)', Math.abs(records.skinTime.eagle?.eagle - 3) < 0.05 && Math.abs(records.skinTime.eagle?.dragon - 2) < 0.05 && !records.skinTime.jet, JSON.stringify(records.skinTime));
  const saved = storage.read(RECORDS_STORAGE_KEY, null);
  check('craft', 'saved on the throttle', saved.version === RECORDS_VERSION && Math.abs(saved.skinTime.eagle.dragon - 2) < 0.05, JSON.stringify(saved.skinTime));

  const stats = listJournalStats();
  const declared = [];
  for (const entry of craftRegistry.list()) {
    for (const stat of craftRegistry.get(entry.id)?.journal?.stats ?? []) declared.push({ ...stat, craft: entry.id });
  }
  const joined = declared.every((stat) => stats.some((known) => known.key === stat.key && known.craft === stat.craft && known.op === stat.op && known.label === stat.label) && journalStatInfo(stat.key)?.op === stat.op);
  check('craft', "every craft module's journal.stats keys join the known statistics", declared.length > 20 && joined, `${declared.length} module statistics, ${stats.length} known`);
  check('craft', 'the game statistics come first, then the modules in catalog order', stats.slice(0, Object.keys(JOURNAL_STATS).length).every((stat) => stat.craft === null) && stats.find((stat) => stat.craft)?.craft === craftRegistry.list().find((entry) => craftRegistry.get(entry.id)?.journal)?.id);
  world.bus.emitTyped('journalStat', { key: 'spaceplaneApogee', value: 104250, op: 'add' });
  check('craft', "a module statistic folds with its module's op", world.journal.getRecords().stats.spaceplaneApogee?.op === 'max' && consoleErrors.some((line) => /spaceplaneApogee/.test(line)), JSON.stringify(world.journal.getRecords().stats.spaceplaneApogee));
  consoleErrors.length = 0;
}

// ---- Medals ----------------------------------------------------------------------------------------
function testMedals() {
  clearStorage();
  const courses = {
    'MEDALS:canyon': { name: 'Canyon gauntlet', presetId: 'canyonGauntlet', best: { jet: { time: 61.2, medal: 'gold', splits: [], missed: 0, date: 2 }, glider: { time: 140, medal: 'none', splits: [], missed: 1, date: 1 } } },
    'OTHER:arches': { name: 'Five-arch chain', presetId: 'fiveArchChain', best: { aerobatic: { time: 48.4, medal: 'silver', splits: [], missed: 0, date: 3 } } },
  };
  let reads = 0;
  const challenges = { getRecords: () => { reads++; return JSON.parse(JSON.stringify({ version: 1, courses })); } };
  const world = session('MEDALS', { challenges });
  const tally = world.journal.getMedals();
  check('medals', 'the medals are read from the challenge system', tally.gold === 1 && tally.silver === 1 && tally.bronze === 0 && tally.none === 1 && tally.runs === 3 && tally.courses === 2 && reads > 0, JSON.stringify(tally));
  const data = world.journal.getData();
  check('medals', 'best time and medal per course and craft come through getData', data.challenges.courses['MEDALS:canyon'].best.jet.time === 61.2 && data.challenges.courses['OTHER:arches'].best.aerobatic.medal === 'silver');
  world.journal.update(0, 6);
  world.bus.emitTyped('figureFlown', { figure: 'loop', score: 80, craft: 'aerobatic', position: POSITION });
  world.journal.update(0, 6);
  const saved = storage.read(RECORDS_STORAGE_KEY, null);
  check('medals', 'the journal never stores them itself', saved && !('challenges' in saved) && !('medals' in saved) && !JSON.stringify(saved).includes('Canyon'), Object.keys(saved ?? {}).join(', '));
  check('medals', 'without a challenge system the tally is empty', session('NONE').journal.getMedals().runs === 0);
}

// ---- Worlds ----------------------------------------------------------------------------------------
function testWorlds() {
  clearStorage();
  const world = session('PORTALS');
  world.bus.emitTyped('worldVisited', { seed: 'GLOW-77', previous: 'PORTALS', portalId: 'portalRing:3:-1' });
  const first = world.journal.getRecords().worldsVisited;
  check('worlds', 'a crossing keeps the seed, where from and the portal, saved at once', first.length === 1 && first[0].seed === 'GLOW-77' && first[0].from === 'PORTALS' && first[0].portalId === 'portalRing:3:-1' && storage.read(RECORDS_STORAGE_KEY, null).worldsVisited.length === 1, JSON.stringify(first));
  world.journal.update(0, 0);
  for (let index = 0; index < 210; index++) world.bus.emitTyped('worldVisited', { seed: `W-${index}`, previous: 'PORTALS', portalId: `p${index}` });
  const visits = world.journal.getRecords().worldsVisited;
  check('worlds', 'the newest 200 are kept', visits.length === 200 && visits[0].seed === 'W-10' && visits[199].seed === 'W-209', `${visits.length}: ${visits[0].seed} .. ${visits[199].seed}`);
  check('worlds', 'a bad seed is refused', (() => { world.bus.emitTyped('worldVisited', { seed: 'not a seed', previous: 'PORTALS', portalId: 'p' }); return world.journal.getRecords().worldsVisited.length === 200; })());
}

// ---- Migration -------------------------------------------------------------------------------------
function testMigration() {
  // Version 1 (Phase 2): statistics, achievements, the best landing; no version field at all.
  clearStorage();
  storage.write('driftwing-v2.journal.OLD-WORLD', { seed: 'OLD-WORLD', maxAltitude: 12000.4, biomesVisited: [] });
  storage.write(RECORDS_STORAGE_KEY, {
    stats: {
      stormsChased: { value: 3, op: 'add', at: 1, seed: 'OLD-WORLD', presetId: 'stormChase' },
      aerobaticLoop: { value: 87, op: 'max', at: 1, seed: 'OLD-WORLD', presetId: null },
      eaglePerches: { value: 5, op: 'add', at: 1, seed: 'OLD-WORLD', presetId: null },
      spaceplaneApogee: { value: 104200, op: 'max', at: 1, seed: 'SPACE-1', presetId: null },
    },
    achievements: [{ id: 'vFormation', title: 'V-formation', at: 1, seed: 'OLD-WORLD' }],
    bestLanding: { grade: 'smooth', sinkRate: 0.8, groundSpeed: 20, craft: 'glider', at: 1 },
  });
  const fromOne = session('MIGRATE-1');
  const one = fromOne.journal.getRecords();
  const savedOne = storage.read(RECORDS_STORAGE_KEY, null);
  check('migration', 'version 1: the old records are kept', one.stats.stormsChased.value === 3 && one.achievements.length === 1 && one.bestLanding.grade === 'smooth' && Object.keys(one.craftTime).length === 0 && one.worldsVisited.length === 0);
  check('migration', 'version 1: figures from the figure best scores (flown at least once)', one.figures.loop?.count === 1 && one.figures.loop.bestScore === 87 && Object.keys(one.figures).length === 1, JSON.stringify(one.figures));
  check('migration', "version 1: perches from the eagle's perch count", one.perches.count === 5 && one.perches.kinds.peak === 0, JSON.stringify(one.perches));
  check('migration', 'version 1: the highest altitude from the records and every journal (the apogee wins)', one.stats.maxAltitude?.value === 104200 && one.stats.maxAltitude.seed === 'SPACE-1', JSON.stringify(one.stats.maxAltitude));
  check('migration', 'version 1: saved back as the current version at once', savedOne.version === RECORDS_VERSION && savedOne.figures.loop.count === 1 && fromOne.journal.getMigratedFrom() === 1, `version ${savedOne.version}, from ${fromOne.journal.getMigratedFrom()}`);

  // Version 2 (wave 2): craftTime and worldsVisited, no figures, perches or maxAltitude.
  clearStorage();
  storage.write('driftwing-v2.journal.HIGH-WORLD', { seed: 'HIGH-WORLD', maxAltitude: 15000, biomesVisited: [] });
  storage.write('driftwing-v2.journal.LOW-WORLD', { seed: 'LOW-WORLD', maxAltitude: 900, biomesVisited: [] });
  storage.write('driftwing-v2.journal.BROKEN', { seed: 'BROKEN', maxAltitude: 1e15 });
  storage.write(RECORDS_STORAGE_KEY, {
    version: 2,
    stats: { balloonMaxAltitude: { value: 3200, op: 'max', at: 1, seed: 'B', presetId: null }, aerobaticTailslide: { value: 66, op: 'max', at: 1, seed: 'B', presetId: null } },
    achievements: [],
    bestLanding: null,
    craftTime: { glider: 120.5, balloon: 40 },
    worldsVisited: [{ seed: 'GLOW-1', from: 'HIGH-WORLD', portalId: 'p1', at: 5 }],
  });
  const fromTwo = session('MIGRATE-2');
  const two = fromTwo.journal.getRecords();
  check('migration', 'version 2: craftTime and worldsVisited are kept', two.craftTime.glider === 120.5 && two.craftTime.balloon === 40 && two.worldsVisited.length === 1 && two.worldsVisited[0].seed === 'GLOW-1', JSON.stringify({ craftTime: two.craftTime, worlds: two.worldsVisited }));
  check('migration', "version 2: the highest altitude from the worlds' journals (storage damage ignored)", two.stats.maxAltitude?.value === 15000 && two.stats.maxAltitude.seed === 'HIGH-WORLD', JSON.stringify(two.stats.maxAltitude));
  check('migration', 'version 2: the tailslide best becomes a figure, no perches yet', two.figures.tailslide?.bestScore === 66 && two.perches.count === 0, JSON.stringify(two.figures));
  check('migration', 'version 2: saved back as the current version at once', storage.read(RECORDS_STORAGE_KEY, null).version === RECORDS_VERSION && fromTwo.journal.getMigratedFrom() === 2);

  // Version 3 loads as it is: no second migration, nothing changes.
  storage.write(RECORDS_STORAGE_KEY, { ...storage.read(RECORDS_STORAGE_KEY, null), stats: { ...storage.read(RECORDS_STORAGE_KEY, null).stats, eaglePerches: { value: 40, op: 'add', at: 2, seed: 'B', presetId: null } } });
  const current = session('MIGRATE-3');
  const three = current.journal.getRecords();
  check('migration', 'version 3 loads unchanged (no second migration)', current.journal.getMigratedFrom() === null && three.perches.count === 0 && three.stats.maxAltitude.value === 15000 && three.figures.tailslide.count === 1, JSON.stringify(three.perches));
  const fresh = (() => {
    clearStorage();
    const empty = session('FRESH');
    return { migrated: empty.journal.getMigratedFrom(), stored: storage.read(RECORDS_STORAGE_KEY, null) };
  })();
  check('migration', 'a fresh profile has nothing to migrate and writes nothing', fresh.migrated === null && fresh.stored === null);
}

// ---- Hostile storage -------------------------------------------------------------------------------
function testHostile() {
  for (const value of ['records', 42, [], [1, 2], true]) {
    clearStorage();
    storage.write(RECORDS_STORAGE_KEY, value);
    const records = session('HOSTILE').journal.getRecords();
    check('hostile', `a ${Array.isArray(value) ? 'list' : typeof value} instead of the records reads empty`, Object.keys(records.stats).length === 0 && records.perches.count === 0 && Object.keys(records.figures).length === 0, JSON.stringify(records).slice(0, 120));
  }

  clearStorage();
  const manyCraft = {};
  for (let index = 0; index < 500; index++) manyCraft[`craft${index}`] = 10;
  const manySkins = {};
  for (let index = 0; index < 20; index++) manySkins[`skin${index}`] = 5;
  const worlds = [];
  for (let index = 0; index < 1000; index++) worlds.push({ seed: `W-${index}`, from: 'HOSTILE', portalId: `p${index}`, at: index });
  worlds.push({ seed: '<img src=x>', from: 'HOSTILE', portalId: 'p', at: 1 }, null, 'W-1', { seed: 'OK-1', from: 'HOSTILE', portalId: '', at: 1 });
  const stats = JSON.parse('{"__proto__": {"value": 1, "op": "add"}, "constructor": {"value": 2, "op": "add"}, "toString": {"value": 3, "op": "add"}}');
  stats.maxAltitude = { value: 1e12, op: 'max' };
  stats.closestTornado = { value: -50, op: 'min' };
  stats.stormsChased = { value: 4, op: 'max' };
  stats.bestCanyonRun = { value: Infinity, op: 'min' };
  stats.fooBar = { value: 'many', op: 'add' };
  stats.Bad = { value: 1, op: 'add' };
  stats.okStat = { value: 7, op: 'avg' };
  for (let index = 0; index < 400; index++) stats[`preset${index}`] = { value: index + 1, op: 'add' };
  storage.write(RECORDS_STORAGE_KEY, {
    version: 3,
    stats,
    achievements: 'none',
    bestLanding: { grade: 'perfect', sinkRate: 0 },
    craftTime: Object.assign(JSON.parse('{"__proto__": 50, "constructor": 9, "glider": -4, "jet": "60", "fpv": NaN}'.replace('NaN', 'null')), manyCraft),
    skinTime: { eagle: { eagle: 30, dragon: Infinity, ...manySkins }, toString: { a: 1 }, wingsuit: 'x' },
    worldsVisited: worlds,
    figures: { loop: { count: 3, bestScore: 1e9 }, roll: { count: 2, bestScore: 50 }, aileronRoll: { count: -1, bestScore: 40 }, hammerhead: { count: 2, bestScore: 'high' }, snapRoll: { count: 1e30, bestScore: 70 }, ...JSON.parse('{"__proto__": {"count": 5, "bestScore": 5}}') },
    perches: { count: 2, kinds: { peak: 4, structure: -2, tree: 1e40, cloud: 7 } },
  });
  const records = session('HOSTILE').journal.getRecords();
  check('hostile', 'prototype keys are refused everywhere (nothing is polluted)', ({}).value === undefined && ({}).count === undefined && !Object.hasOwn(records.stats, 'constructor') && !Object.hasOwn(records.stats, 'toString') && !Object.hasOwn(records.craftTime, 'constructor') && !Object.hasOwn(records.craftTime, '__proto__') && !Object.hasOwn(records.skinTime, 'toString') && Object.getPrototypeOf(records.stats) === Object.prototype);
  check('hostile', 'a stored altitude beyond any flight is dropped; known statistics never go negative', !records.stats.maxAltitude && !records.stats.closestTornado && !records.stats.bestCanyonRun, JSON.stringify({ maxAltitude: records.stats.maxAltitude, closestTornado: records.stats.closestTornado }));
  check('hostile', 'a known statistic keeps its own op; unusable values and ops are dropped', records.stats.stormsChased?.op === 'add' && !records.stats.fooBar && !records.stats.Bad && !records.stats.okStat, JSON.stringify(records.stats.stormsChased));
  check('hostile', 'statistics are capped at 200', Object.keys(records.stats).length === 200, `${Object.keys(records.stats).length}`);
  check('hostile', 'flight time per craft: craft ids with positive seconds, at most 64', Object.keys(records.craftTime).length === 64 && !('glider' in records.craftTime) && !('jet' in records.craftTime) && !('fpv' in records.craftTime), `${Object.keys(records.craftTime).length}`);
  check('hostile', 'flight time per skin: usable seconds, at most 8 skins a craft', Object.keys(records.skinTime).join() === 'eagle' && records.skinTime.eagle.eagle === 30 && !('dragon' in records.skinTime.eagle) && Object.keys(records.skinTime.eagle).length === 8, JSON.stringify(records.skinTime));
  check('hostile', 'worlds visited: usable seeds only, the newest 200', records.worldsVisited.length === 200 && records.worldsVisited[199].seed === 'W-999' && records.worldsVisited[0].seed === 'W-800', `${records.worldsVisited.length}: ${records.worldsVisited[0]?.seed} .. ${records.worldsVisited[199]?.seed}`);
  check('hostile', 'figures: known figures, scores clamped to 100, counts capped, unusable entries dropped', records.figures.loop?.bestScore === 100 && records.figures.loop.count === 3 && records.figures.snapRoll?.count === 1e9 && !records.figures.roll && !records.figures.aileronRoll && !records.figures.hammerhead && Object.keys(records.figures).length === 2, JSON.stringify(records.figures));
  check('hostile', 'perches: kinds capped and never negative, the count at least their sum', records.perches.kinds.peak === 4 && records.perches.kinds.structure === 0 && records.perches.kinds.tree === 1e9 && !('cloud' in records.perches.kinds) && records.perches.count === 1e9, JSON.stringify(records.perches));
  check('hostile', 'the rest reads empty', records.achievements.length === 0 && records.bestLanding === null);
  const world = session('HOSTILE');
  world.state.flight = { craft: 'constructor', craftState: { skin: '__proto__' } };
  fly(world, 1);
  check('hostile', 'a prototype name as the flying craft or skin is never counted', !Object.hasOwn(world.journal.getRecords().craftTime, 'constructor') && ({}).constructor === Object);
}

// ---- Allocation ------------------------------------------------------------------------------------
async function testAllocation() {
  if (typeof globalThis.gc !== 'function') {
    check('allocation', 'a frame of flight allocates nothing (run with --expose-gc to measure)', true, 'skipped: no --expose-gc');
    return;
  }
  clearStorage();
  const world = session('ALLOCATION');
  world.state.flight = { craft: 'eagle', craftState: { skin: 'dragon' } };
  world.state.player.speed = 40;
  const altitude = new Float64Array(1);
  altitude[0] = 500;
  const frame = () => {
    altitude[0] += 0.37;
    world.state.player.altitude = altitude[0];
    world.journal.update(1 / 120, 0);
  };
  for (let index = 0; index < 50000; index++) frame();
  globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const before = youngUsed();
  const frames = 100000;
  for (let index = 0; index < frames; index++) frame();
  const after = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const perFrame = (after - before) / frames;
  check('allocation', `no garbage collection during ${frames} climbing frames`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per frame', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(4)} B/frame`);
  const records = world.journal.getRecords();
  check('allocation', 'the measured frames counted (time, skin, altitude)', records.craftTime.eagle > 1200 && records.skinTime.eagle.dragon > 1200 && records.stats.maxAltitude.value > 55000, JSON.stringify({ time: records.craftTime.eagle, altitude: records.stats.maxAltitude.value }));
}

testCollection();
testFigures();
testPerches();
testAltitude();
testCraft();
testMedals();
testWorlds();
testMigration();
testHostile();
await testAllocation();
clearStorage();

check('console', 'no console errors (typed event payloads valid)', consoleErrors.length === 0, consoleErrors.join(' | '));
console.error = originalError;

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(10)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} journal checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
