// Settings lab: runs src/core/settings.js and src/flight/assistDefaults.js headless (node, the
// storage module on its in-memory backend) and checks the settings record's migrations and the
// one-time HOTAS assist default.
//
// Tests:
//   firstRun        no stored record: the current version, the chase view on every craft (the
//                   golden-hour opening shot), the glass HUD off in the cockpit and the flight path
//                   marker on, assists at 100 % on every craft, none set by the player, the HOTAS
//                   default not applied
//   migrateV3       a Phase 1 era record (version 3, with the CLASSIC | SIM mode, the per-mode views
//                   and the HOTAS prompt answer) loses those keys, keeps everything else, takes the
//                   SIM view as every craft's view, and marks craft whose assists were moved off
//                   100 % as set by the player
//   migrateV4       a version 4 record (one remembered view) seeds every craft's view from it; a
//                   first-person view leaves the third-person memory on chase, a third-person one
//                   seeds it too; the old key is gone
//   viewsPerCraft   a view chosen for one craft leaves the others alone and survives a reload
//   playerChange    an assists change made outside assistDefaults marks that craft as set by the
//                   player (the slider, WREN)
//   hotasDefault    a gamepad changes nothing; the first HOTAS device sets 50 % on every craft the
//                   player never set, with one toast; a second HOTAS device and a later reload with a
//                   re-plugged HOTAS change nothing and show no toast; the player's choices stay
//
// Usage: node tools/lab/settings.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { CRAFT_IDS, SETTINGS_VERSION, createSettings } from '../../src/core/settings.js';
import { storage } from '../../src/core/storage.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { HOTAS_ASSIST_LEVEL, HOTAS_ASSIST_TOAST, createAssistDefaults } from '../../src/flight/assistDefaults.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const SETTINGS_KEY = 'driftwing-v2.settings';
const STICK = Object.freeze({ deviceKey: '044f-b10a', kind: 'hotas-stick', name: 'T.16000M' });
const THROTTLE = Object.freeze({ deviceKey: '044f-b687', kind: 'hotas-throttle', name: 'TWCS Throttle' });
const GAMEPAD = Object.freeze({ deviceKey: '045e-02ea', kind: 'gamepad', name: 'Xbox controller' });

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

/** A fresh game session over whatever the storage cache holds (a page load). */
function boot() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const notices = [];
  bus.on('notify', (payload) => notices.push(payload.text));
  const settings = createSettings(bus);
  const assistDefaults = createAssistDefaults({ bus, settings });
  return { bus, settings, assistDefaults, notices };
}

function levels(settings) {
  return CRAFT_IDS.map((id) => `${id} ${Math.round(settings.get('assists')[id] * 100)}%`).join(', ');
}

function assistsEqual(settings, expected) {
  const assists = settings.get('assists');
  return CRAFT_IDS.every((id) => Math.abs(assists[id] - expected[id]) < 1e-9);
}

function hotasToasts(notices) {
  return notices.filter((text) => text === HOTAS_ASSIST_TOAST).length;
}

/** True when every craft's value in an object setting is `expected`. */
function everyCraft(value, expected) {
  return Boolean(value) && CRAFT_IDS.every((id) => value[id] === expected);
}

function testFirstRun() {
  storage.remove(SETTINGS_KEY);
  const { settings } = boot();
  const stored = storage.read(SETTINGS_KEY, null);
  check('firstRun', 'the record is written in the current version', stored?.version === SETTINGS_VERSION, `version ${stored?.version}`);
  check('firstRun', 'every craft starts in the chase view', everyCraft(settings.get('views'), 'chase') && everyCraft(settings.get('thirdPersonViews'), 'chase'), JSON.stringify(settings.get('views')));
  const hud = settings.get('hud');
  check('firstRun', 'the glass HUD is off in the cockpit, the flight path marker on', hud.cockpitGlass === false && hud.flightPathMarker === true && hud.overlay === false, JSON.stringify(hud));
  check('firstRun', 'assists 100 % on every craft', CRAFT_IDS.every((id) => settings.get('assists')[id] === 1), levels(settings));
  check('firstRun', 'no craft set by the player, the HOTAS default not applied', CRAFT_IDS.every((id) => settings.get('assistsSetByPlayer')[id] === false) && settings.get('hotasAssistsApplied') === false, JSON.stringify(settings.get('assistsSetByPlayer')));
  const all = settings.all();
  check('firstRun', 'no mode, single view or HOTAS prompt keys', !('mode' in all) && !('view' in all) && !('hotasPrompt' in all), Object.keys(all).join(', '));
}

function testMigrateV3() {
  storage.write(SETTINGS_KEY, {
    version: 3,
    mode: 'sim',
    craft: 'jet',
    views: { classic: 'chase', sim: 'wing' },
    hotasPrompt: 'always',
    assists: { glider: 1, bushplane: 1, jet: 0.5, helicopter: 0.75, wingsuit: 1, fpv: 1 },
    units: 'aviation',
    fpv: { uptilt: 30, expo: 0.4, rate: 800 },
  });
  const { settings } = boot();
  const stored = storage.read(SETTINGS_KEY, null);
  check('migrateV3', `the record is saved as version ${SETTINGS_VERSION}`, stored?.version === SETTINGS_VERSION, `version ${stored?.version}`);
  check('migrateV3', 'mode, the per-mode views, view and hotasPrompt are gone from the stored record', !('mode' in stored) && !('view' in stored) && !('hotasPrompt' in stored) && !('classic' in stored.views) && !('sim' in stored.views), Object.keys(stored).join(', '));
  check('migrateV3', "the SIM view becomes every craft's view and third-person view", everyCraft(settings.get('views'), 'wing') && everyCraft(settings.get('thirdPersonViews'), 'wing'), JSON.stringify(settings.get('views')));
  check('migrateV3', 'everything else is kept', settings.get('craft') === 'jet' && settings.get('units') === 'aviation' && settings.get('fpv').uptilt === 30 && settings.get('assists').jet === 0.5 && settings.get('assists').helicopter === 0.75, `craft ${settings.get('craft')}, units ${settings.get('units')}, ${levels(settings)}`);
  const setByPlayer = settings.get('assistsSetByPlayer');
  check('migrateV3', 'craft with assists off 100 % count as set by the player', setByPlayer.jet === true && setByPlayer.helicopter === true && ['glider', 'bushplane', 'wingsuit', 'fpv'].every((id) => setByPlayer[id] === false), JSON.stringify(setByPlayer));
  check('migrateV3', 'the HOTAS default is still to come', settings.get('hotasAssistsApplied') === false, String(settings.get('hotasAssistsApplied')));
}

function testMigrateV4() {
  storage.write(SETTINGS_KEY, { version: 4, craft: 'helicopter', view: 'cockpit', units: 'aviation', hud: { overlay: true, landingCallouts: true } });
  const first = boot();
  const stored = storage.read(SETTINGS_KEY, null);
  check('migrateV4', `the record is saved as version ${SETTINGS_VERSION} without the old view key`, stored?.version === SETTINGS_VERSION && !('view' in stored), Object.keys(stored).join(', '));
  check('migrateV4', 'the cockpit view seeds every craft', everyCraft(first.settings.get('views'), 'cockpit'), JSON.stringify(first.settings.get('views')));
  check('migrateV4', 'the third-person memory stays on chase', everyCraft(first.settings.get('thirdPersonViews'), 'chase'), JSON.stringify(first.settings.get('thirdPersonViews')));
  const hud = first.settings.get('hud');
  check('migrateV4', 'the HUD keeps its fields and gains the new ones at their defaults', hud.overlay === true && hud.landingCallouts === true && hud.cockpitGlass === false && hud.flightPathMarker === true, JSON.stringify(hud));

  storage.write(SETTINGS_KEY, { version: 4, view: 'flyby' });
  const second = boot();
  check('migrateV4', 'a third-person view seeds both memories', everyCraft(second.settings.get('views'), 'flyby') && everyCraft(second.settings.get('thirdPersonViews'), 'flyby'), JSON.stringify(second.settings.get('thirdPersonViews')));
}

function testViewsPerCraft() {
  storage.remove(SETTINGS_KEY);
  const first = boot();
  first.settings.update('views', { jet: 'cockpit' });
  first.settings.update('thirdPersonViews', { glider: 'wing' });
  const reloaded = boot();
  const views = reloaded.settings.get('views');
  check('viewsPerCraft', 'one craft\'s view leaves the others on chase and survives a reload', views.jet === 'cockpit' && CRAFT_IDS.filter((id) => id !== 'jet').every((id) => views[id] === 'chase'), JSON.stringify(views));
  check('viewsPerCraft', 'the third-person memory is per craft too', reloaded.settings.get('thirdPersonViews').glider === 'wing' && reloaded.settings.get('thirdPersonViews').jet === 'chase', JSON.stringify(reloaded.settings.get('thirdPersonViews')));
  check('viewsPerCraft', 'a first-person slot is refused as a third-person view', reloaded.settings.update('thirdPersonViews', { jet: 'cockpit' }) === false && reloaded.settings.get('thirdPersonViews').jet === 'chase', JSON.stringify(reloaded.settings.get('thirdPersonViews')));
}

function testPlayerChangeAndHotasDefault() {
  storage.remove(SETTINGS_KEY);
  const first = boot();
  first.settings.update('assists', { bushplane: 0.8 });
  const marked = first.settings.get('assistsSetByPlayer');
  check('playerChange', 'an assists change marks only that craft', marked.bushplane === true && CRAFT_IDS.filter((id) => id !== 'bushplane').every((id) => marked[id] === false), JSON.stringify(marked));

  first.bus.emitTyped('deviceConnected', GAMEPAD);
  check('hotasDefault', 'a gamepad changes nothing', hotasToasts(first.notices) === 0 && first.settings.get('hotasAssistsApplied') === false && first.settings.get('assists').glider === 1, levels(first.settings));

  first.bus.emitTyped('deviceConnected', STICK);
  const expected = Object.fromEntries(CRAFT_IDS.map((id) => [id, id === 'bushplane' ? 0.8 : HOTAS_ASSIST_LEVEL]));
  check('hotasDefault', `the first HOTAS: ${HOTAS_ASSIST_LEVEL * 100} % on every craft the player did not set`, assistsEqual(first.settings, expected), levels(first.settings));
  check('hotasDefault', 'one toast, and the flag is set', hotasToasts(first.notices) === 1 && first.settings.get('hotasAssistsApplied') === true, `${hotasToasts(first.notices)} toast(s)`);
  check('hotasDefault', 'the default does not mark craft as set by the player', CRAFT_IDS.filter((id) => id !== 'bushplane').every((id) => first.settings.get('assistsSetByPlayer')[id] === false), JSON.stringify(first.settings.get('assistsSetByPlayer')));

  first.bus.emitTyped('deviceConnected', THROTTLE);
  check('hotasDefault', 'a second HOTAS device changes nothing', hotasToasts(first.notices) === 1 && assistsEqual(first.settings, expected), levels(first.settings));

  first.settings.update('assists', { glider: 0.7 });
  const reloaded = boot();
  reloaded.bus.emitTyped('deviceConnected', STICK);
  const afterReload = { ...expected, glider: 0.7 };
  check('hotasDefault', 'after a reload a re-plugged HOTAS changes nothing and shows no toast', hotasToasts(reloaded.notices) === 0 && assistsEqual(reloaded.settings, afterReload), levels(reloaded.settings));
  check('hotasDefault', "the player's choices stay theirs", reloaded.settings.get('assistsSetByPlayer').glider === true && reloaded.settings.get('assistsSetByPlayer').bushplane === true, JSON.stringify(reloaded.settings.get('assistsSetByPlayer')));
}

testFirstRun();
testMigrateV3();
testMigrateV4();
testViewsPerCraft();
testPlayerChangeAndHotasDefault();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(13)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} settings checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
