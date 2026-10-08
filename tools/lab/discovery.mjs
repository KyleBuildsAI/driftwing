// Discovery lab: the discovery loop's pure parts headless (node, the storage module on its in-memory
// backend): seed links, the journal's spawn discoveries, records and achievements, and the map tiles.
//
// Tests:
//   seeds       seed normalisation; the resolution order (query, hash, saved seed, random); times of
//               day as fractions and HH:MM (?time= wins over #t=); world hashes and the shell's check;
//               share links open the shell (/?v=2#seed=...&t=...) from /v2/, /v2/index.html and file://
//   journal     a spawn discovery is recorded once with name, category, kind, seed, coordinates, time of
//               day, first-seen date and the preset's one-liner; landmark discoveries are left to the
//               landmark journal; the collection counts implemented presets (x / N) and announces
//               'journal:discovery'; a reload restores the entries and marks them discovered in the
//               spawn manager
//   records     journalStat folds 'add', 'min' and 'max'; known keys keep their own op (a mismatch is
//               reported once); bad payloads are refused; achievements are recorded once; records and
//               achievements are global (another world sees them) while discoveries stay per seed;
//               the best landing in any world is kept; flight time per craft accrues frame by frame
//               (records version 2, a version 1 record reads with none) and is saved with the
//               throttled saves
//   tiles       every field has the right size and type; the same request gives the same bytes; tiles
//               share their edges (no seams in height or colour); water is tinted by depth; bad
//               requests throw; the cache tag follows the seed and the preset placement data; the
//               cost of one 128 x 128 colour tile
//
// Usage: node tools/lab/discovery.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { performance } from 'node:perf_hooks';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { WORLD_OPTIONS } from '../../src/core/config.js';
import { storage } from '../../src/core/storage.js';
import { isWorldHash, normalizeSeed, parseDayTime, resolveSeed, resolveStartTime, shareLink, worldHash } from '../../src/core/seed.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { createMapTileGenerator, mapTileCacheTag } from '../../src/world/mapTileGen.js';
import { PRESETS } from '../../src/spawns/presets/index.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

// The journal listens for the page hiding; node has no document or window, so give it inert ones.
globalThis.document ??= { visibilityState: 'visible', addEventListener() {} };
globalThis.window ??= { addEventListener() {} };
const { RECORDS_STORAGE_KEY, createJournal } = await import('../../src/gameplay/journal.js');

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

// ---- Seeds ---------------------------------------------------------------------------------------
function testSeeds() {
  check('seeds', 'normalises to upper case with dashes', normalizeSeed(' arch 1!x ') === 'ARCH-1-X' && normalizeSeed('***') === null && normalizeSeed(42) === null, normalizeSeed(' arch 1!x '));
  const query = new URLSearchParams('seed=query');
  const hash = new URLSearchParams('seed=hash&t=0.5');
  const empty = new URLSearchParams('');
  check('seeds', 'the query wins over the hash and the saved seed', resolveSeed(query, hash, 'SAVED') === 'QUERY');
  check('seeds', 'the hash wins over the saved seed', resolveSeed(empty, hash, 'SAVED') === 'HASH');
  check('seeds', 'the saved seed comes next', resolveSeed(empty, new URLSearchParams(''), 'SAVED') === 'SAVED');
  const random = resolveSeed(empty, null, '');
  check('seeds', 'else a fresh random seed', /^[A-Z2-9]{6}$/.test(random) && random !== resolveSeed(empty, null, ''), random);
  check('seeds', 'times of day: fractions wrap, HH:MM converts, junk is refused',
    parseDayTime('0.25') === 0.25 && parseDayTime('1.5') === 0.5 && parseDayTime('-0.25') === 0.75 && parseDayTime('18:00') === 0.75 && parseDayTime('25:00') === null && parseDayTime('dusk') === null,
    [parseDayTime('0.25'), parseDayTime('18:00'), parseDayTime('-0.25')].join(', '));
  check('seeds', '?time= wins over #t=, and neither means null',
    resolveStartTime(new URLSearchParams('time=0.1'), new URLSearchParams('t=0.9')) === 0.1 && resolveStartTime(empty, new URLSearchParams('t=0.9')) === 0.9 && resolveStartTime(empty, empty) === null);
  const withTime = worldHash('ABC', 0.72345);
  check('seeds', 'world hashes carry the time to three decimals', withTime === '#seed=ABC&t=0.723' && worldHash('ABC') === '#seed=ABC', withTime);
  check('seeds', "the shell's check takes world hashes and refuses anything else",
    isWorldHash(withTime) && isWorldHash('#seed=ABC') && !isWorldHash('#seed=abc') && !isWorldHash('#seed=ABC&t=2') && !isWorldHash('#seed=ABC&x=1') && !isWorldHash({ hash: withTime }));
  let threw = false;
  try {
    worldHash('bad seed');
  } catch (error) {
    threw = /invalid seed/.test(error.message);
  }
  check('seeds', 'an invalid seed never becomes a link', threw);
  const fromDirectory = shareLink('http://127.0.0.1:5199/v2/?seed=ABC&renderer=webgl#seed=ABC', 'ABC', 0.5);
  const fromIndex = shareLink('http://127.0.0.1:5199/v2/index.html?seed=ABC', 'ABC', 0.5);
  const fromFile = shareLink('file:///C:/game/dist-single/v2/index.html', 'ABC', null);
  check('seeds', 'share links open the launcher shell with V2 at this world and time',
    fromDirectory === 'http://127.0.0.1:5199/?v=2#seed=ABC&t=0.500' && fromIndex === fromDirectory && fromFile === 'file:///C:/game/dist-single/index.html?v=2#seed=ABC',
    `${fromDirectory} | ${fromFile}`);
}

// ---- Journal -------------------------------------------------------------------------------------
const WORLD = createWorldGen('LAB', WORLD_OPTIONS);
const LAB_PRESETS = Object.freeze([
  Object.freeze({ id: 'labSite', name: 'Lab site', category: 'structure', kind: 'site', journal: { title: 'Lab site', description: 'A persistent test place.' }, engines: [], achievements: [{ id: 'labAchievement', title: 'Lab achievement', description: 'Earned in the lab.' }] }),
  Object.freeze({ id: 'labEvent', name: 'Lab event', category: 'weather', kind: 'event', journal: { title: 'Lab event', description: 'A passing test happening.' }, engines: [] }),
  Object.freeze({ id: 'labOther', name: 'Lab other', category: 'ocean', kind: 'event', journal: { title: 'Lab other', description: 'Never found.' }, engines: [] }),
]);

/** A game session in world seed: the bus, a spawn manager stand-in, the journal and what it announced. */
function session(seed) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const marked = [];
  const manager = {
    listPresets: () => [...LAB_PRESETS],
    getPreset: (id) => LAB_PRESETS.find((preset) => preset.id === id) ?? null,
    markDiscovered: (keys) => marked.push(...keys),
  };
  const state = {
    seed,
    time: { dayTime: 0.72, label: 'golden hour', elapsed: 0 },
    player: { biome: WORLD.biomeAt(0, 0), speed: 0, altitude: 0 },
  };
  const ctx = { bus, state, world: WORLD, systems: { spawns: { manager } } };
  const journal = createJournal(ctx);
  const announced = { discoveries: [], records: [], achievements: [] };
  bus.on('journal:discovery', (payload) => announced.discoveries.push(payload));
  bus.on('journal:record', (payload) => announced.records.push(payload));
  bus.on('journal:achievement', (payload) => announced.achievements.push(payload));
  return { bus, journal, marked, announced, state };
}

function testJournal() {
  const first = session('LABWORLD');
  first.bus.emitTyped('discovery', { id: 'labSite:3:-2', name: 'Lab site', kind: 'structure', position: { x: 6123.4, y: 88, z: -3001.2 }, presetId: 'labSite' });
  first.bus.emitTyped('discovery', { id: 'labSite:3:-2', name: 'Lab site', kind: 'structure', position: { x: 6123.4, y: 88, z: -3001.2 }, presetId: 'labSite' });
  first.bus.emitTyped('discovery', { id: 'arch-1', name: 'Old Arch', kind: 'arch', position: { x: 10, y: 20, z: 30 } });
  const data = first.journal.getData();
  const entry = data.spawnsFound[0];
  check('journal', 'a spawn discovery is recorded once', data.spawnsFound.length === 1, `${data.spawnsFound.length} entries`);
  check('journal', 'the entry: name, category, kind, seed, coordinates, time of day, first seen, one-liner',
    entry && entry.name === 'Lab site' && entry.category === 'structure' && entry.kind === 'site' && entry.seed === 'LABWORLD' && entry.x === 6123 && entry.z === -3001
      && entry.dayTime === 0.72 && entry.timeLabel === 'golden hour' && entry.foundAt > 0 && entry.description === 'A persistent test place.',
    JSON.stringify(entry));
  check('journal', 'landmark discoveries stay with the landmark journal', data.spawnsFound.every((item) => item.presetId !== undefined) && data.landmarksFound.length === 0);
  check('journal', 'the collection counts implemented presets', data.collection.found === 1 && data.collection.total === 3, `${data.collection.found} / ${data.collection.total}`);
  check('journal', "'journal:discovery' announces the entry and the count once", first.announced.discoveries.length === 1 && first.announced.discoveries[0].found === 1 && first.announced.discoveries[0].total === 3);

  first.bus.emitTyped('discovery', { id: 'labEvent', name: 'Lab event', kind: 'weather', position: { x: 0, y: 0, z: 0 }, presetId: 'labEvent' });
  const reloaded = session('LABWORLD');
  const restored = reloaded.journal.getData();
  check('journal', 'a reload restores the entries', restored.spawnsFound.length === 2 && restored.collection.found === 2, `${restored.spawnsFound.length} entries`);
  check('journal', 'and marks them discovered in the spawn manager', reloaded.marked.includes('labSite:3:-2') && reloaded.marked.includes('labEvent'), reloaded.marked.join(', '));
  const otherWorld = session('OTHERWORLD');
  check('journal', 'discoveries are kept per world', otherWorld.journal.getData().spawnsFound.length === 0 && otherWorld.journal.getData().collection.found === 0);
}

function testRecords() {
  storage.remove(RECORDS_STORAGE_KEY);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const world = session('RECORDS');
  const emit = (payload) => world.bus.emitTyped('journalStat', payload);
  emit({ key: 'stormsChased', value: 1, op: 'add', presetId: 'stormChase' });
  emit({ key: 'stormsChased', value: 1, op: 'add', presetId: 'stormChase' });
  emit({ key: 'closestTornado', value: 480, op: 'min', presetId: 'tornado' });
  emit({ key: 'closestTornado', value: 212.5, op: 'min', presetId: 'tornado' });
  emit({ key: 'closestTornado', value: 900, op: 'min', presetId: 'tornado' });
  emit({ key: 'bestCanyonRun', value: 101.25, op: 'max', presetId: 'slotCanyon' });
  emit({ key: 'bestCanyonRun', value: 140, op: 'min', presetId: 'slotCanyon' });
  emit({ key: 'highestJetStream', value: 9100, op: 'max' });
  emit({ key: 'highestJetStream', value: 8000, op: 'max' });
  const refusedBefore = world.announced.records.length;
  world.journal.recordStat({ key: 'Bad key', value: 1, op: 'add' });
  world.journal.recordStat({ key: 'stormsChased', value: -1, op: 'add' });
  world.journal.recordStat({ key: 'closestTornado', value: Number.NaN, op: 'min' });
  world.journal.recordStat({ key: 'fooBar', value: 1, op: 'avg' });
  console.error = originalError;
  const stats = world.journal.getRecords().stats;
  check('records', "'add' sums (storms chased)", stats.stormsChased?.value === 2, JSON.stringify(stats.stormsChased));
  check('records', "'min' keeps the lowest (closest tornado)", stats.closestTornado?.value === 212.5, JSON.stringify(stats.closestTornado));
  check('records', "a known key keeps its own op, and the mismatch is reported once", stats.bestCanyonRun?.value === 101.25 && errors.length === 1 && /bestCanyonRun/.test(errors[0]), errors.join(' | '));
  check('records', "'max' keeps the highest (any other key)", stats.highestJetStream?.value === 9100);
  check('records', 'bad payloads are refused', world.announced.records.length === refusedBefore && Object.keys(stats).length === 4, Object.keys(stats).join(', '));
  check('records', "only real changes count as improvements", world.announced.records.filter((record) => record.improved).length === 6, world.announced.records.map((record) => `${record.key}:${record.improved}`).join(' '));

  world.bus.emitTyped('achievement', { id: 'labAchievement', title: 'Lab achievement' });
  world.bus.emitTyped('achievement', { id: 'labAchievement', title: 'Lab achievement' });
  world.bus.emitTyped('achievement', { id: 'threadTheNeedle', title: 'Thread the Needle' });
  const achievements = world.journal.getRecords().achievements;
  check('records', 'achievements are recorded once each, with any id', achievements.length === 2 && world.announced.achievements.length === 2, achievements.map((entry) => entry.id).join(', '));
  check('records', 'the presets declare their achievements', world.journal.getDeclaredAchievements().some((entry) => entry.id === 'labAchievement' && entry.description === 'Earned in the lab.'));

  world.journal.recordLanding({ grade: 'firm', craft: 'glider', sinkRate: 1.8, groundSpeed: 20 });
  const other = session('ANOTHERWORLD');
  other.journal.recordLanding({ grade: 'smooth', craft: 'bushplane', sinkRate: 0.9, groundSpeed: 18 });
  other.journal.recordLanding({ grade: 'hard', craft: 'jet', sinkRate: 3, groundSpeed: 60 });
  const global = other.journal.getRecords();
  check('records', 'records and achievements are global', global.stats.stormsChased?.value === 2 && global.achievements.length === 2);
  check('records', 'the best landing in any world is kept', global.bestLanding?.grade === 'smooth' && global.bestLanding.craft === 'bushplane', JSON.stringify(global.bestLanding));
  check('records', 'while the landings of each world stay its own', other.journal.getData().landings.count === 2 && world.journal.getData().landings.count === 1);

  // Flight time per craft (records version 2): counted every frame of flight for the craft flying it.
  const stored = storage.read(RECORDS_STORAGE_KEY, null);
  storage.write(RECORDS_STORAGE_KEY, { version: 1, stats: stored.stats, achievements: stored.achievements, bestLanding: stored.bestLanding });
  const flying = session('CRAFTTIME');
  check('records', 'a version 1 record reads with no flight time per craft and keeps the rest', Object.keys(flying.journal.getRecords().craftTime).length === 0 && flying.journal.getRecords().stats.stormsChased?.value === 2, JSON.stringify(flying.journal.getRecords().craftTime));
  flying.state.flight = { craft: 'jet' };
  for (let frame = 0; frame < 120; frame++) flying.journal.update(1 / 60, 1 / 60);
  flying.state.flight.craft = 'balloon';
  for (let frame = 0; frame < 60; frame++) flying.journal.update(1 / 60, 1 / 60);
  flying.journal.update(0, 6);
  const times = flying.journal.getRecords().craftTime;
  check('records', 'flight time accrues per craft, frame by frame', Math.abs(times.jet - 2) < 0.05 && Math.abs(times.balloon - 1) < 0.05, JSON.stringify(times));
  const savedTimes = storage.read(RECORDS_STORAGE_KEY, null);
  check('records', 'the records are saved as version 2 with craftTime (throttled save)', savedTimes.version === 2 && Math.abs(savedTimes.craftTime.jet - 2) < 0.05, JSON.stringify(savedTimes.craftTime));
  const paused = session('CRAFTTIME');
  paused.state.flight = { craft: 'jet' };
  paused.journal.update(0, 1);
  check('records', 'a paused frame adds no flight time', Math.abs(paused.journal.getRecords().craftTime.jet - 2) < 0.05, JSON.stringify(paused.journal.getRecords().craftTime));
}

// ---- Tiles ---------------------------------------------------------------------------------------
function testTiles() {
  const generator = createMapTileGenerator(WORLD);
  const resolution = 64;
  const tile = generator.generate({ x: 0, z: 0, size: 4000, resolution });
  check('tiles', 'every field has its size and type',
    tile.height instanceof Float32Array && tile.height.length === resolution * resolution
      && tile.color instanceof Uint8ClampedArray && tile.color.length === resolution * resolution * 4
      && tile.biome instanceof Uint8Array && tile.biome.length === resolution * resolution && tile.biome.every((index) => index < WORLD.BIOMES.length));
  const step = 4000 / resolution;
  const sampled = WORLD.heightAt(step * 10.5, step * 20.5);
  check('tiles', 'heights are the shared height function at cell centres', Math.abs(tile.height[20 * resolution + 10] - sampled) < 1e-3, `${tile.height[20 * resolution + 10].toFixed(3)} vs ${sampled.toFixed(3)}`);
  const colourOnly = generator.generate({ x: 0, z: 0, size: 4000, resolution, fields: ['color'] });
  check('tiles', 'a request returns only the fields it asks for', Object.keys(colourOnly).join() === 'color');
  const again = createMapTileGenerator(createWorldGen('LAB', WORLD_OPTIONS)).generate({ x: 0, z: 0, size: 4000, resolution, fields: ['color'] });
  check('tiles', 'the same request gives the same bytes', Buffer.compare(Buffer.from(colourOnly.color.buffer), Buffer.from(again.color.buffer)) === 0);

  // Seams: a tile twice the resolution over the same ground holds the pair of tiles' samples.
  const left = generator.generate({ x: 0, z: 0, size: 2000, resolution: 32, fields: ['height', 'color'] });
  const right = generator.generate({ x: 2000, z: 0, size: 2000, resolution: 32, fields: ['height', 'color'] });
  const whole = generator.generate({ x: 0, z: 0, size: 4000, resolution: 64, fields: ['height', 'color'] });
  let seam = 0;
  for (let row = 0; row < 32; row++) {
    for (let column = 0; column < 32; column++) {
      seam = Math.max(seam, Math.abs(left.height[row * 32 + column] - whole.height[row * 64 + column]), Math.abs(right.height[row * 32 + column] - whole.height[row * 64 + 32 + column]));
      for (let channel = 0; channel < 4; channel++) {
        seam = Math.max(seam, Math.abs(right.color[(row * 32 + column) * 4 + channel] - whole.color[(row * 64 + 32 + column) * 4 + channel]));
      }
    }
  }
  check('tiles', 'neighbouring tiles share their edges (no seams)', seam === 0, `largest difference ${seam}`);

  const water = generator.generate({ x: -40000, z: -40000, size: 80000, resolution: 96, fields: ['height', 'color'] });
  let waterSamples = 0;
  let blueish = 0;
  for (let index = 0; index < water.height.length; index++) {
    if (water.height[index] >= WORLD.WATER_LEVEL) continue;
    waterSamples++;
    if (water.color[index * 4 + 2] > water.color[index * 4]) blueish++;
  }
  check('tiles', 'water is tinted blue by depth', waterSamples > 0 && blueish === waterSamples, `${blueish} of ${waterSamples} water samples`);

  let badRequests = 0;
  for (const request of [{ x: 0, z: 0, size: -1, resolution: 8 }, { x: 0, z: 0, size: 10, resolution: 1.5 }, { x: 'a', z: 0, size: 10, resolution: 8 }, { x: 0, z: 0, size: 10, resolution: 8, fields: ['sky'] }]) {
    try {
      generator.generate(request);
    } catch (error) {
      if (error.message.startsWith('map tile:')) badRequests++;
    }
  }
  check('tiles', 'bad requests throw', badRequests === 4, `${badRequests} of 4`);
  // The default preset list is the real one (PRESETS); its stamped sites give a different tag than no sites.
  const tag = mapTileCacheTag('lab');
  const placesSites = PRESETS.some((preset) => preset.kind === 'site');
  check('tiles', 'the cache tag follows the seed and the preset placement data',
    tag.startsWith('LAB|v') && tag !== mapTileCacheTag('LAB2') && tag !== mapTileCacheTag('LAB', [{ id: 'x', kind: 'site', placement: { chance: 1 }, stamps: [] }])
      && tag === mapTileCacheTag('LAB', PRESETS) && (tag !== mapTileCacheTag('LAB', [])) === placesSites,
    tag);

  const started = performance.now();
  generator.generate({ x: 12000, z: -8000, size: 8000, resolution: 128, fields: ['color'] });
  const elapsed = performance.now() - started;
  check('tiles', 'one 128 x 128 colour tile (worker time, off the main thread)', elapsed < 5000, `${elapsed.toFixed(0)} ms`);
}

testSeeds();
testJournal();
testRecords();
testTiles();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(9)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} discovery checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
