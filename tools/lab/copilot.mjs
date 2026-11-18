// Copilot grammar lab: runs WREN's local brain (src/copilot/copilot.js with grammar.js) headless in
// node against transcripts, and checks the remote action schema for the version switch and views.
//
// Tests:
//   versionOne   "switch to version one", "version one", "v1", "switch to v1", "play the original"
//                (and a few more phrasings) ask for V1 with { type: 'switchVersion', version: 'v1' };
//                asking for version two is answered without an action
//   retired      "boost", "barrel roll", "sim mode", "classic mode" and friends no longer produce the
//                retired actions (boost, barrelRoll, setMode)
//   neighbours   commands that share words still reach their own action (the bush plane, the
//                cockpit view, assists, the wingsuit)
//   views        "cockpit view" / "first person", "chase view", "wing view", "flyby camera", and
//                "third person" / "outside view" (the last third-person view) ask for their view;
//                "fly by the lighthouse" is not a camera request
//   schema       the remote action switchVersion needs version 'v1' exactly (case aside); setView
//                takes the five view targets and nothing else; the retired types are refused
//   guide        the tour-guide phrases: "what's nearby", "take me to the [name, synonym or
//                category]" (with and without the autopilot), "find a thermal", "chase the storm",
//                "next discovery", "guide help", and the callouts on / off settings
//   phase1       the Phase 1 grammar still wins where the words overlap: "take me to the mountains",
//                "find the lighthouse", "take me to the islands", "switch to the jet", "where am I",
//                "switch to version one"
//   resolve      resolveTarget: names, journal titles, synonyms (twister, whirlpool, turbines),
//                categories, and the common words that must not pick a preset alone
//   rules        the callout rules as pure functions: the 45 s rate limit, the 150 m AGL floor,
//                landing (gear down, low and descending, on approach, on the ground), talking,
//                an open offer; token filling; "yes" / "no" answers
//   callouts     the tour guide on a mock game: a spawnActivated callout is spoken with the preset's
//                line, a second one waits for the rate limit, nothing below 150 m AGL, while landing
//                or while WREN talks; "yes" places a waypoint on the spawn, "no" declines, a late
//                "yes" does nothing; the actions (nearby, goTo, findThermal, chaseStorm,
//                nextDiscovery) place the right waypoints and say honestly when nothing is there
//   remote       the remote schema: the five new action types and their parameters, and the
//                snapshot's nearby[], activeEvents[], weather and callouts fields
//   craftCommands  a craft's own phrases (flight.craftCommands) become craftCommand actions, with the
//                first capture group as the value; "systems check" speaks the craft's status; the
//                craftCommand schema (craft, camelCase command, a number, boolean or short string)
//   Milestone O, the cross-craft grammar (contract j.2), each phrase with its variants and negatives:
//   craftSwitch  "switch to [craft]" for all 14 ids, their display names and synonyms (stunt plane,
//                float plane, hot air balloon, blimp, zeppelin, rocket plane, ...), skins by name ("the
//                dragon"); "give me extra power" and "find the balloons" switch nothing; setCraft's skin
//   smoke        "smoke on / off" and friends: the aerobatic's own smoke command, the cross-craft smoke
//                action elsewhere; questions and "smoke on the water" switch nothing
//   water, perch "find water to land" (and the bare "find water"), "find a perch" (before the eagle's
//                own approach command); "find the ocean", "land on the water", "are we perched" are not
//   wind         "wind at [altitude]" in metres, feet, km, thousands, words, digit groups and flight
//                levels, in the pilot's units without one; "wind at the summit" and "wind at 10 knots"
//                are not; parseAltitude and describeWind
//   challenge    "start the challenge" and "cancel the challenge" (a cancel never starts); the ring
//                course keeps its words
//   space        "take me to space" and friends; "abort the climb" stops (never starts); questions
//                about space and the celestial tour category are not
//   scenic       "scenic cruise": the airship's command on the airship, the cross-craft action elsewhere
//   negated      a craft named as a thing out there ("fly over the balloon festival", "follow the jet")
//                switches nothing; "don't switch to the jet", "do not start the challenge" and the
//                other negated requests are answered and act on nothing; "never mind, ..." still acts
//   help         "craft help" lists every phrase with its key or chip in one line
//   remote       the schema of the eight cross-craft actions; the flightState fields onWater, craftState
//                (only the h.3 fields, rounded, bounded) and challenge, JSON-safe and small
//   executor     the cross-craft guide on a mock game: the nearest landable lake or sea, perches (the
//                eagle's own approach when close), the wind at a height in the pilot's units (under the
//                ground, without a height), challenges (armed at the prompt, else a waypoint; cancel),
//                the yes / no offer before a switch (yes switches and runs, no declines, it lapses after
//                15 s), the scenic cruise and smoke across craft, setCraft with a skin
//
// Usage: node tools/lab/copilot.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { Copilot } from '../../src/copilot/copilot.js';
import {
  CALLOUT_RULES, calloutBlockReason, createTourGuide, fillCallout, isLandingPhase, offerAnswer, resolveTarget,
} from '../../src/copilot/tourGuide.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import * as THREE from 'three/webgpu';
import { CONFIRM_SECONDS, createCraftGuide, describeWind, parseAltitude } from '../../src/copilot/craftGuide.js';
import { CRAFT_STATE_FIELDS, buildFlightFields, challengeSnapshot, craftStateSnapshot } from '../../src/copilot/flightState.js';
import { createFlightActionHandlers } from '../../src/copilot/flightActions.js';
import { craftRegistry } from '../../src/craft/index.js';
import { CRAFT_IDS } from '../../src/core/settings.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

/** A preset fixture with the fields the tour guide reads (contract section 1 shape, trimmed). */
function fixturePreset(id, name, category, kind, extra = {}) {
  return {
    id,
    name,
    category,
    kind,
    rarity: extra.rarity ?? 'common',
    heavy: extra.heavy ?? false,
    filters: { weather: extra.weather ?? null },
    journal: { title: extra.title ?? name, description: `${name}.` },
    callouts: extra.callouts ?? [`${name} {distance} {direction}.`, `{name} ahead, {eta}.`, `There's a ${name.toLowerCase()} out there.`],
  };
}

/** Presets named like the Phase 2 spec's, so the grammar is checked against realistic names. */
const PRESETS = Object.freeze([
  fixturePreset('tornado', 'Tornado', 'weather', 'event', { rarity: 'rare', heavy: true, weather: ['storm'] }),
  fixturePreset('supercell', 'Supercell', 'weather', 'event', { rarity: 'uncommon', heavy: true, weather: ['building', 'storm'], callouts: ['Supercell building {distance} {direction}. Want a heading?', '{name} towering {direction}.', 'Anvil cloud {distance} out.'] }),
  fixturePreset('eruptingVolcano', 'Erupting volcano', 'geo', 'site', { rarity: 'rare', heavy: true }),
  fixturePreset('maelstrom', 'Maelstrom', 'ocean', 'site', { rarity: 'rare' }),
  fixturePreset('whalePod', 'Whale pod', 'ocean', 'event'),
  fixturePreset('geeseFormation', 'Geese V-formation', 'wildlife', 'event'),
  fixturePreset('windFarm', 'Wind farm', 'structure', 'site'),
  fixturePreset('ropeBridge', 'Rope bridge', 'structure', 'site'),
  fixturePreset('abandonedAirfield', 'Abandoned airfield', 'structure', 'site'),
  fixturePreset('jetStream', 'Jet stream ribbon', 'flightplay', 'event'),
  fixturePreset('floatingIslands', 'Floating islands', 'fantasy', 'site', { heavy: true }),
  fixturePreset('skyWhale', 'Sky whale', 'fantasy', 'event', { heavy: true }),
  fixturePreset('thermalHawks', 'Thermal hawks', 'wildlife', 'event'),
]);
const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

/** The smallest context the local brain reads while matching (no action is executed here). */
function createBrain() {
  const values = { copilotVoice: true, copilotChatter: true, copilotCallouts: true, units: 'metric' };
  const ctx = {
    settings: { get: (key) => values[key], set: (key, value) => { values[key] = value; return true; } },
    state: { spawn: { x: 0, y: 400, z: 0, heading: 0 }, player: { position: { x: 0, y: 400, z: 0 } } },
    systems: { spawns: { manager: { listPresets: () => PRESETS } } },
  };
  const brain = new Copilot(ctx);
  brain.settingValues = values;
  return brain;
}

/** A flight-state snapshot with the fields the matchers read. */
const FLIGHT = Object.freeze({
  altitude: 400, altitudeAboveGround: 300, speed: 30, speedKmh: 108, heading: 90, headingName: 'east',
  throttle: 0.5, craft: 'glider', units: 'metric', assists: { percent: 100, active: [] }, capabilities: { throttle: false },
  waypoint: null, ringCourse: { active: false }, autopilot: { enabled: false }, nearbyLandmarks: [],
});

const brain = createBrain();
function actionFor(transcript) {
  const reply = brain.interpret(FLIGHT, transcript);
  return reply.action ? reply.action : null;
}

for (const phrase of ['switch to version one', 'version one', 'v1', 'switch to v1', 'play the original', 'go back to version 1', 'play the original game', 'WREN, switch to version one please']) {
  const action = actionFor(phrase);
  check('versionOne', `"${phrase}" -> switchVersion v1`, action && action.type === 'switchVersion' && action.version === 'v1', JSON.stringify(action));
}
for (const phrase of ['switch to version two', 'v2']) {
  const reply = brain.interpret(FLIGHT, phrase);
  check('versionOne', `"${phrase}" is answered, not acted on`, !reply.action && /version two/i.test(reply.speech), `${JSON.stringify(reply.action)} "${reply.speech}"`);
}

for (const phrase of ['boost', 'punch it', 'do a barrel roll', 'barrel roll left', 'sim mode', 'classic mode', 'switch to arcade mode', 'toggle flight mode']) {
  const action = actionFor(phrase);
  check('retired', `"${phrase}" -> no retired action`, !action || !['boost', 'barrelRoll', 'setMode'].includes(action.type), JSON.stringify(action));
}

for (const [phrase, type] of [['switch to the bush plane', 'setCraft'], ['cockpit view', 'setView'], ['assists up', 'setAssists'], ['relaunch', 'relaunch'], ['switch to the wingsuit', 'setCraft']]) {
  const action = actionFor(phrase);
  check('neighbours', `"${phrase}" -> ${type}`, action && action.type === type, JSON.stringify(action));
}

for (const [phrase, view] of [
  ['cockpit view', 'cockpit'], ['first person', 'cockpit'], ['switch to first person view', 'cockpit'], ['chase view', 'chase'], ['chase cam', 'chase'],
  ['wing view', 'wing'], ['switch to the wingtip camera', 'wing'], ['flyby camera', 'flyby'], ['fly by view', 'flyby'],
  ['third person', 'outside'], ['go to third person', 'outside'], ['outside view', 'outside'], ['take me outside', 'outside'],
]) {
  const action = actionFor(phrase);
  check('views', `"${phrase}" -> setView ${view}`, action && action.type === 'setView' && action.view === view, JSON.stringify(action));
}
for (const phrase of ['fly by the lighthouse', "let's fly by the mountains"]) {
  const action = actionFor(phrase);
  check('views', `"${phrase}" is not a camera request`, !action || action.type !== 'setView', JSON.stringify(action));
}

const clean = Copilot.sanitizeAction({ type: 'switchVersion', version: 'V1', extra: true });
check('schema', 'switchVersion with version "V1" is accepted as v1, extra fields dropped', clean && clean.version === 'v1' && !('extra' in clean), JSON.stringify(clean));
for (const raw of [{ type: 'switchVersion' }, { type: 'switchVersion', version: 'v2' }, { type: 'switchVersion', version: 1 }, { type: 'switchVersion', version: 'version one' }]) {
  check('schema', `refused: ${JSON.stringify(raw)}`, Copilot.sanitizeAction(raw) === null, JSON.stringify(Copilot.sanitizeAction(raw)));
}
for (const view of ['cockpit', 'chase', 'wing', 'flyby', 'outside', 'OUTSIDE']) {
  const cleanView = Copilot.sanitizeAction({ type: 'setView', view });
  check('schema', `setView "${view}" is accepted`, cleanView && cleanView.view === view.toLowerCase(), JSON.stringify(cleanView));
}
for (const raw of [{ type: 'setView', view: 'fpv' }, { type: 'setView', view: 'thirdPerson' }, { type: 'setView' }, { type: 'setView', view: 2 }]) {
  check('schema', `refused: ${JSON.stringify(raw)}`, Copilot.sanitizeAction(raw) === null, JSON.stringify(Copilot.sanitizeAction(raw)));
}
for (const type of ['boost', 'barrelRoll', 'setMode']) {
  check('schema', `retired type ${type} is refused`, Copilot.sanitizeAction({ type, mode: 'sim', direction: 'left' }) === null, JSON.stringify(Copilot.sanitizeAction({ type })));
}

// ---- guide: the tour-guide phrases -----------------------------------------------------------------------
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
for (const [phrase, expected] of [
  ["what's nearby", { type: 'nearby' }],
  ['what is nearby', { type: 'nearby' }],
  ['WREN, anything interesting nearby?', { type: 'nearby' }],
  ["what's around here", { type: 'nearby' }],
  ['nearby', { type: 'nearby' }],
  ['take me to the rope bridge', { type: 'goTo', name: 'rope bridge', autopilot: false }],
  ['take us to the nearest volcano please', { type: 'goTo', name: 'volcano', autopilot: false }],
  ['fly us to the volcano', { type: 'goTo', name: 'volcano', autopilot: true }],
  ['take me to the twister on autopilot', { type: 'goTo', name: 'twister', autopilot: true }],
  ['head for the wind turbines', { type: 'goTo', name: 'wind turbines', autopilot: false }],
  ['take me to the wildlife', { type: 'goTo', name: 'wildlife', autopilot: false }],
  ['where is the airfield', { type: 'goTo', name: 'airfield', autopilot: false }],
  ['take me to the jet stream', { type: 'goTo', name: 'jet stream', autopilot: false }],
  ['guide me to the floating islands', { type: 'goTo', name: 'floating islands', autopilot: false }],
  ['find a thermal', { type: 'findThermal', autopilot: false }],
  ['any thermals nearby', { type: 'findThermal', autopilot: false }],
  ['thermal', { type: 'findThermal', autopilot: false }],
  ['find some lift and fly us there', { type: 'findThermal', autopilot: true }],
  ['chase the storm', { type: 'chaseStorm', autopilot: false }],
  ["let's go storm chasing", { type: 'chaseStorm', autopilot: false }],
  ['any storms around', { type: 'chaseStorm', autopilot: false }],
  ['chase the tornado on autopilot', { type: 'chaseStorm', autopilot: true }],
  ['next discovery', { type: 'nextDiscovery', autopilot: false }],
  ['find something new', { type: 'nextDiscovery', autopilot: false }],
  ["show me something we haven't seen", { type: 'nextDiscovery', autopilot: false }],
]) {
  const action = actionFor(phrase);
  check('guide', `"${phrase}" -> ${JSON.stringify(expected)}`, same(action, expected), JSON.stringify(action));
}
const guideHelp = brain.interpret(FLIGHT, 'guide help');
check('guide', '"guide help" lists the tour-guide commands', !guideHelp.action && /what's nearby/.test(guideHelp.speech) && /chase the storm/.test(guideHelp.speech) && guideHelp.speech.length <= Copilot.MAX_SPEECH_LENGTH, guideHelp.speech);
const generalHelp = brain.interpret(FLIGHT, 'what can you do');
check('guide', '"what can you do" points at the guide help and fits one line', /guide help/.test(generalHelp.speech) && generalHelp.speech.length <= Copilot.MAX_SPEECH_LENGTH, `${generalHelp.speech.length} chars`);
for (const [phrase, value] of [['callouts off', false], ['turn on the callouts', true], ['be quiet', false], ['talk to me more', true]]) {
  const reply = brain.interpret(FLIGHT, phrase);
  check('guide', `"${phrase}" sets copilotCallouts ${value}`, !reply.action && brain.settingValues.copilotCallouts === value && reply.speech, `${brain.settingValues.copilotCallouts} "${reply.speech}"`);
}

{
  const unknown = brain.interpret(FLIGHT, 'take me to the purple castle');
  check('guide', 'an unknown place gets an honest answer, not "didn\'t catch that"', !unknown.action && /don't know anything called purple castle/.test(unknown.speech), unknown.speech);
  const bare = new Copilot({ settings: { get: () => true, set: () => true }, state: { spawn: null, player: { position: { x: 0, y: 0, z: 0 } } }, systems: {} });
  const noPresets = bare.interpret(FLIGHT, 'take me to the rope bridge');
  check('guide', 'before any presets exist, "take me to the rope bridge" is answered honestly', !noPresets.action && /don't know anything called rope bridge/.test(noPresets.speech), noPresets.speech);
  const stillNearby = bare.interpret(FLIGHT, "what's nearby");
  check('guide', 'before any presets exist, "what\'s nearby" still asks the guide', stillNearby.action && stillNearby.action.type === 'nearby', JSON.stringify(stillNearby.action));
}

// ---- phase1: the Phase 1 grammar keeps its phrases -----------------------------------------------------------
for (const [phrase, expected] of [
  ['take me to the mountains', { type: 'find', target: 'mountains', autopilot: true }],
  ['find the lighthouse', { type: 'find', target: 'lighthouse', autopilot: false }],
  ['take me to the islands', { type: 'find', target: 'archipelago', autopilot: true }],
  ['find the ocean', { type: 'find', target: 'ocean', autopilot: false }],
  ['find a landmark', { type: 'find', target: 'landmark', autopilot: false }],
  ['switch to the jet', { type: 'setCraft', craft: 'jet' }],
  ['where am i', { type: 'describe' }],
  ['switch to version one', { type: 'switchVersion', version: 'v1' }],
  ['cockpit view', { type: 'setView', view: 'cockpit' }],
  ['make it dusk', { type: 'time', preset: 'dusk' }],
  ['take us home', { type: 'waypoint', x: 0, z: 0, label: 'Home', autopilot: true }],
  ['head to 270', { type: 'autopilot', enabled: true, heading: 270, followWaypoint: false }],
]) {
  const action = actionFor(phrase);
  check('phase1', `"${phrase}" -> ${JSON.stringify(expected)}`, same(action, expected), JSON.stringify(action));
}
{
  const withWaypoint = { ...FLIGHT, waypoint: { x: 100, z: -2000, label: 'Waypoint', distance: 2000, bearing: 3 } };
  const follow = brain.interpret(withWaypoint, 'take us to the waypoint');
  check('phase1', '"take us to the waypoint" still follows the waypoint', same(follow.action, { type: 'autopilot', enabled: true, followWaypoint: true }), JSON.stringify(follow.action));
}

// ---- resolve: names, synonyms, categories --------------------------------------------------------------------
for (const [target, expected] of [
  ['rope bridge', ['ropeBridge']],
  ['twister', ['tornado']],
  ['thunderstorm', ['supercell']],
  ['whirlpool', ['maelstrom']],
  ['wind turbines', ['windFarm']],
  ['runway', ['abandonedAirfield']],
  ['geese', ['geeseFormation']],
  ['whales', ['whalePod', 'skyWhale']],
  ['sky whale', ['skyWhale']],
  ['jet stream', ['jetStream']],
  ['erupting volcano', ['eruptingVolcano']],
]) {
  const resolved = resolveTarget(target, PRESETS);
  check('resolve', `"${target}" -> ${expected.join(', ')}`, resolved && same([...(resolved.presetIds ?? [])].sort(), [...expected].sort()), JSON.stringify(resolved));
}
for (const [target, category] of [['wildlife', 'wildlife'], ['birds', 'wildlife'], ['buildings', 'structure'], ['weather', 'weather'], ['sea life', 'ocean']]) {
  const resolved = resolveTarget(target, PRESETS);
  check('resolve', `"${target}" -> category ${category}`, resolved && resolved.category === category && resolved.presetIds === null, JSON.stringify(resolved));
}
for (const target of ['jet', 'islands', 'mountains', 'lighthouse', 'ocean', 'storm', 'thermal', 'the']) {
  check('resolve', `"${target}" picks no preset`, resolveTarget(target, PRESETS) === null, JSON.stringify(resolveTarget(target, PRESETS)));
}

// ---- rules: the callout rules as pure functions ---------------------------------------------------------------
const OPEN_GATE = Object.freeze({ enabled: true, ready: true, photoMode: false, crash: false, now: 100, lastCalloutAt: -Infinity, agl: 600, landing: false, busy: false, offerOpen: false });
for (const [name, change, expected] of [
  ['all clear', {}, null],
  ['disabled', { enabled: false }, 'disabled'],
  ['photo mode', { photoMode: true }, 'photoMode'],
  ['44 s after the last callout', { lastCalloutAt: 56 }, 'rateLimit'],
  ['45 s after the last callout', { lastCalloutAt: 55 }, null],
  ['149 m AGL', { agl: 149 }, 'lowAltitude'],
  ['150 m AGL', { agl: 150 }, null],
  ['landing', { landing: true }, 'landing'],
  ['WREN talking', { busy: true }, 'talking'],
  ['an offer still open', { offerOpen: true }, 'offerOpen'],
  ['soft crash', { crash: true }, 'crash'],
]) {
  const reason = calloutBlockReason({ ...OPEN_GATE, ...change });
  check('rules', `gate: ${name} -> ${expected ?? 'allowed'}`, reason === expected, String(reason));
}
check('rules', 'the rate limit is 45 s and the floor 150 m AGL', CALLOUT_RULES.minGapSeconds === 45 && CALLOUT_RULES.minAgl === 150, JSON.stringify(CALLOUT_RULES));
const CRUISE = Object.freeze({ onGround: false, gear: { retractable: false, down: true }, agl: 600, verticalSpeed: -0.5, flaps: 0 });
for (const [name, change, expected] of [
  ['cruising (fixed gear)', {}, false],
  ['on the ground', { onGround: true }, true],
  ['retractable gear down', { gear: { retractable: true, down: true } }, true],
  ['retractable gear up', { gear: { retractable: true, down: false } }, false],
  ['low and descending', { agl: 250, verticalSpeed: -2.5 }, true],
  ['low and level', { agl: 250, verticalSpeed: 0 }, false],
  ['on approach with flaps', { agl: 420, verticalSpeed: -1, flaps: 0.5 }, true],
  ['flaps out, high', { agl: 900, verticalSpeed: -1, flaps: 0.5 }, false],
]) {
  check('rules', `landing: ${name} -> ${expected}`, isLandingPhase({ ...CRUISE, ...change }) === expected, '');
}
const filled = fillCallout('Supercell building {distance} {direction}.', { distance: 9000, bearing: 315, name: 'Supercell', etaSeconds: 240 });
check('rules', 'tokens {distance} {direction} filled, a heading offered', filled === 'Supercell building 9.0 km north-west. Want a heading?', filled);
const filledEta = fillCallout('{name} ahead, {eta}. Want a heading?', { distance: 3000, bearing: 10, name: 'Sky whale', etaSeconds: 185 });
check('rules', 'tokens {name} {eta} filled, no second question', filledEta === 'Sky whale ahead, about 3 minutes away. Want a heading?', filledEta);
for (const [reply, expected] of [
  ['yes', 'yes'], ['yeah', 'yes'], ['yes please', 'yes'], ['sure', 'yes'], ['ok', 'yes'], ['okay', 'yes'], ['yes take us there', 'yes'],
  ['go ahead', 'yes'], ['give me a heading', 'yes'], ['no', 'no'], ['no thanks', 'no'], ['nope', 'no'], ['not now', 'no'],
  ['yes switch to the jet', null], ['okay make it dusk', null], ['nothing', null], ['northwest', null], ['', null],
]) {
  check('rules', `answer "${reply}" -> ${expected}`, offerAnswer(reply) === expected, String(offerAnswer(reply)));
}

// ---- callouts and actions on a mock game ---------------------------------------------------------------------------
/** A mock game: the typed bus, the state WREN reads, a SpawnManager and director over plain records. */
function createMockGame({ agl = 600 } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const values = { copilotCallouts: true };
  const state = {
    ready: true,
    photoMode: false,
    time: { realElapsed: 100, elapsed: 100, nightFactor: 0, sunElevation: 40 },
    player: { position: { x: 0, y: 700, z: 0 }, heading: 0, speed: 40 },
    flight: { agl, verticalSpeed: 0, flaps: 0, onGround: false, gear: { retractable: false, down: true }, crash: { active: false } },
  };
  const records = new Map();
  const discovered = new Set();
  const sites = [];
  const directorEntries = [];
  const landmarks = [];
  let serial = 0;
  let thermal = null;
  let weatherState = 'clear';
  const manager = {
    listPresets: () => PRESETS,
    getPreset: (id) => PRESET_BY_ID.get(id) ?? null,
    getActive: () => [...records.values()].map((record) => ({ ...record, discovered: discovered.has(record.siteId ?? record.presetId) })),
    getInstance: (id) => (records.has(id) ? { ...records.get(id) } : null),
    isDiscovered: (key) => discovered.has(key),
    getSiteFeed: () => ({ sitesNear: (x, z, radius) => sites.filter((site) => Math.hypot(site.x - x, site.z - z) <= radius) }),
  };
  const director = {
    getNearby(radiusKm) {
      const position = state.player.position;
      return directorEntries
        .map((entry) => {
          const distance = Math.hypot(entry.x - position.x, entry.z - position.z);
          const bearing = Math.round(((Math.atan2(entry.x - position.x, -(entry.z - position.z)) * 180) / Math.PI + 360) % 360) % 360;
          const info = PRESET_BY_ID.get(entry.presetId);
          const nearbyState = entry.state === 'site' && discovered.has(entry.id) ? 'discovered' : entry.state;
          return { id: entry.id, name: info.name, category: info.category, distance: Math.round(distance), bearing, state: nearbyState, etaSeconds: Math.round(distance / state.player.speed) };
        })
        .filter((entry) => entry.distance <= radiusKm * 1000)
        .sort((first, second) => first.distance - second.distance);
    },
  };
  const spoken = [];
  const waypoints = [];
  const busy = { value: false };
  let follows = 0;
  const ctx = {
    bus,
    state,
    settings: { get: (key) => values[key], set: (key, value) => { values[key] = value; bus.emit('settings:changed', { key, value }); return true; } },
    systems: {
      spawns: { manager, director },
      landmarks: { getNearby: () => landmarks },
      weather: { getState: () => ({ state: weatherState, storminess: weatherState === 'storm' ? 0.8 : 0 }) },
    },
    wind: { nearestThermal: (position) => (thermal && Math.hypot(thermal.x - position.x, thermal.z - position.z) < 3000 ? { ...thermal, distance: Math.hypot(thermal.x - position.x, thermal.z - position.z) } : null) },
  };
  const guide = createTourGuide(ctx, {
    succeed: (text, informative = false) => ({ ok: true, text, informative }),
    fail: (text) => ({ ok: false, text, informative: false }),
    pick: (key, lines) => lines[0],
    placeWaypoint: (x, z, label) => {
      waypoints.push({ x, z, label });
      return { label };
    },
    engageFollow: () => {
      follows++;
      return true;
    },
    say: (text) => spoken.push(text),
    isBusy: () => busy.value,
    directionPhrase: Copilot.directionPhrase,
  });
  return {
    guide,
    state,
    values,
    spoken,
    waypoints,
    busy,
    discovered,
    get follows() { return follows; },
    setThermal(next) { thermal = next; },
    setWeather(next) { weatherState = next; },
    addLandmark(landmark) { landmarks.push(landmark); },
    /** A live spawn at (x, z); sites take a site id and are listed by the director too. */
    spawn(presetId, x, z, { siteId = null, source = 'debug', active = true } = {}) {
      const preset = PRESET_BY_ID.get(presetId);
      const id = siteId ? `spawn:${siteId}` : `spawn:${presetId}:${++serial}`;
      records.set(id, { id, presetId, name: preset.name, category: preset.category, kind: preset.kind, source, siteId, active, position: { x, y: 0, z } });
      if (siteId) {
        sites.push({ id: siteId, presetId, x, z });
        directorEntries.push({ id: siteId, presetId, x, z, state: 'site' });
      }
      bus.emitTyped('spawnActivated', { id, presetId, category: preset.category, kind: preset.kind, position: { x, y: 0, z } });
      return id;
    },
    /** A site the director knows but no spawn is created for yet. */
    site(presetId, x, z, siteId) {
      sites.push({ id: siteId, presetId, x, z });
      directorEntries.push({ id: siteId, presetId, x, z, state: 'site' });
    },
    candidate(presetId, x, z) {
      directorEntries.push({ id: `${presetId}:1:2:3`, presetId, x, z, state: 'dormant' });
    },
    end(id) {
      const record = records.get(id);
      records.delete(id);
      bus.emitTyped('spawnEnded', { id, presetId: record.presetId, reason: 'test' });
    },
    advance(seconds) {
      for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.25) {
        state.time.realElapsed += 0.25;
        guide.update(0.25);
      }
    },
  };
}

const NW = Math.SQRT1_2 * 9000;
{
  const game = createMockGame();
  const supercell = game.spawn('supercell', -NW, -NW);
  game.advance(1);
  check('callouts', 'spawnActivated -> the preset line with {distance} {direction}', game.spoken[0] === 'Supercell building 9.0 km north-west. Want a heading?', JSON.stringify(game.spoken));
  check('callouts', 'the callout leaves an offer open', game.guide.getOffer()?.name === 'Supercell', JSON.stringify(game.guide.getOffer()));
  const yes = game.guide.handleReply('yes');
  const waypoint = game.waypoints[0];
  check('callouts', '"yes" places a waypoint on the spawn', yes && yes.ok && waypoint && Math.abs(waypoint.x + NW) < 1 && Math.abs(waypoint.z + NW) < 1 && waypoint.label === 'Supercell' && game.follows === 0, JSON.stringify({ yes, waypoint }));
  check('callouts', '"yes" speaks the heading and distance', /^Heading 315 for the supercell, 9\.0 km to the north-west\. Waypoint set\.$/.test(yes?.speech ?? ''), yes?.speech);
  check('callouts', 'the offer closes after the answer', game.guide.getOffer() === null && game.guide.handleReply('yes') === null, JSON.stringify(game.guide.getOffer()));

  game.spawn('whalePod', 2000, -3000);
  game.advance(10);
  check('callouts', 'a second callout waits for the 45 s rate limit', game.spoken.length === 1 && game.guide.getStats().lastBlock === 'rateLimit', JSON.stringify(game.guide.getStats()));
  game.advance(36);
  check('callouts', 'it is spoken once 45 s have passed', game.spoken.length === 2 && /^Whale pod 3\.6 km north-east\. Want a heading\?$/.test(game.spoken[1]), JSON.stringify(game.spoken));
  const no = game.guide.handleReply('no thanks');
  check('callouts', '"no" declines without a waypoint', no && no.ok && game.waypoints.length === 1 && game.guide.getOffer() === null, JSON.stringify(no));

  game.state.flight.agl = 120;
  game.advance(50);
  game.spawn('tornado', 0, -5000);
  game.advance(2);
  check('callouts', 'nothing below 150 m AGL', game.spoken.length === 2 && game.guide.getStats().lastBlock === 'lowAltitude', JSON.stringify(game.guide.getStats()));
  game.state.flight.agl = 600;
  game.state.flight.gear = { retractable: true, down: true };
  game.advance(2);
  check('callouts', 'nothing while landing (gear down)', game.spoken.length === 2 && game.guide.getStats().lastBlock === 'landing', JSON.stringify(game.guide.getStats()));
  game.state.flight.gear = { retractable: true, down: false };
  game.busy.value = true;
  game.advance(2);
  check('callouts', 'never over another line (WREN answering or speaking)', game.spoken.length === 2 && game.guide.getStats().lastBlock === 'talking', JSON.stringify(game.guide.getStats()));
  game.busy.value = false;
  game.advance(1);
  check('callouts', 'the waiting callout is spoken when the rules allow', game.spoken.length === 3 && /^Tornado 5\.0 km north\./.test(game.spoken[2]), JSON.stringify(game.spoken));
  game.advance(CALLOUT_RULES.offerSeconds + 1);
  check('callouts', 'a "yes" after the offer window does nothing', game.guide.getOffer() === null && game.guide.handleReply('yes') === null && game.waypoints.length === 1, JSON.stringify(game.waypoints));

  game.end(supercell);
  game.values.copilotCallouts = false;
  game.advance(50);
  game.spawn('skyWhale', 3000, 0);
  game.advance(2);
  check('callouts', 'nothing with the callouts setting off', game.spoken.length === 3 && game.guide.getStats().lastBlock === 'disabled', JSON.stringify(game.guide.getStats()));
}
{
  const game = createMockGame();
  game.discovered.add('ropeBridge:1:1');
  game.spawn('ropeBridge', 3000, 0, { siteId: 'ropeBridge:1:1', source: 'site', active: false });
  game.advance(1);
  check('callouts', 'a discovered site coming into range is not called out', game.spoken.length === 0, JSON.stringify(game.spoken));
  game.spawn('windFarm', 0, 6000, { siteId: 'windFarm:0:3', source: 'site', active: false });
  game.advance(1);
  check('callouts', 'an undiscovered site coming into range is', game.spoken.length === 1 && /^Wind farm 6\.0 km south\./.test(game.spoken[0]), JSON.stringify(game.spoken));
  const yes = game.guide.handleReply('yes take us there');
  check('callouts', '"yes, take us there" also engages the autopilot', yes && yes.ok && game.follows === 1 && /autopilot engaged/.test(yes.speech), yes?.speech);
}

{
  // calledOut forgets an event once it ends (its key, the spawn id, never returns) and keeps a site.
  const game = createMockGame();
  const supercell = game.spawn('supercell', -NW, -NW);
  game.advance(1);
  game.guide.handleReply('no');
  const site = game.spawn('windFarm', 0, 6000, { siteId: 'windFarm:0:3', source: 'site', active: false });
  game.advance(CALLOUT_RULES.minGapSeconds + 1);
  const calledBefore = game.guide.getStats().calledOut;
  game.end(supercell);
  game.end(site);
  const calledAfter = game.guide.getStats().calledOut;
  check('callouts', 'an ended event leaves the called-out set; a site stays in it', game.spoken.length === 2 && calledBefore === 2 && calledAfter === 1, `${game.spoken.length} spoken; called out ${calledBefore} -> ${calledAfter}`);
}

// Actions.
{
  const game = createMockGame();
  game.discovered.add('ropeBridge:1:0');
  game.site('ropeBridge', 3000, 0, 'ropeBridge:1:0');
  game.site('ropeBridge', 0, 2000, 'ropeBridge:0:1');
  game.candidate('tornado', 0, -6000);
  game.spawn('geeseFormation', -1500, -1500);
  const nearby = game.guide.handlers.nearby();
  check('callouts', 'nearby: the closest few with distance, direction and state, no dormant candidates', nearby.ok && /Geese V-formation, 2\.1 km to the north-west, happening now/.test(nearby.text) && /Rope bridge, 3\.0 km to the east, in the journal/.test(nearby.text) && /not in the journal yet/.test(nearby.text) && !/Tornado/.test(nearby.text), nearby.text);
  const known = game.guide.handlers.goTo({ type: 'goTo', name: 'rope bridge' });
  const knownWaypoint = game.waypoints.at(-1);
  check('callouts', 'goTo prefers the discovered site when it is not much further', known.ok && knownWaypoint.x === 3000 && knownWaypoint.z === 0 && knownWaypoint.label === 'Rope bridge' && /heading 090/.test(known.text), `${known.text} ${JSON.stringify(knownWaypoint)}`);
  game.site('ropeBridge', 0, 900, 'ropeBridge:0:0');
  const unknown = game.guide.handlers.goTo({ type: 'goTo', name: 'rope bridge', autopilot: true });
  check('callouts', 'goTo takes a much closer undiscovered site, and engages the autopilot when asked', unknown.ok && game.waypoints.at(-1).z === 900 && game.follows === 1 && /not in the journal yet/.test(unknown.text) && /autopilot engaged/.test(unknown.text), unknown.text);
  const category = game.guide.handlers.goTo({ type: 'goTo', name: 'wildlife' });
  check('callouts', 'goTo a category guides to its nearest member', category.ok && game.waypoints.at(-1).label === 'Geese V-formation', category.text);
  const dormant = game.guide.handlers.goTo({ type: 'goTo', name: 'twister' });
  check('callouts', 'goTo never guides to a dormant candidate, and says the event is not happening', !dormant.ok && /isn't happening anywhere near us/.test(dormant.text), dormant.text);
  const byId = game.guide.handlers.goTo({ type: 'goTo', id: 'ropeBridge:0:1' });
  check('callouts', 'goTo by id (from nearby[])', byId.ok && game.waypoints.at(-1).z === 2000, byId.text);
  const unknownName = game.guide.handlers.goTo({ type: 'goTo', name: 'lighthouse' });
  check('callouts', 'goTo an unknown name fails honestly', !unknownName.ok && /don't know anything called lighthouse/.test(unknownName.text), unknownName.text);

  const next = game.guide.handlers.nextDiscovery({ type: 'nextDiscovery' });
  check('callouts', 'next discovery: the nearest undiscovered site, unnamed', next.ok && game.waypoints.at(-1).label === 'Next discovery' && game.waypoints.at(-1).z === 900 && /a structure/.test(next.text) && !/Rope bridge/.test(next.text), next.text);

  const candidateStorm = game.guide.handlers.chaseStorm({ type: 'chaseStorm' });
  check('callouts', 'chase the storm: only a candidate -> marked honestly as a possibility', candidateStorm.ok && game.waypoints.at(-1).label === 'Possible Tornado' && /Nothing's active yet/.test(candidateStorm.text), candidateStorm.text);
  const supercell = game.spawn('supercell', -NW, -NW);
  const activeStorm = game.guide.handlers.chaseStorm({ type: 'chaseStorm', autopilot: true });
  check('callouts', 'chase the storm: the active storm wins', activeStorm.ok && game.waypoints.at(-1).label === 'Supercell' && /happening now/.test(activeStorm.text), activeStorm.text);
  game.end(supercell);

  game.setThermal({ x: 1200, z: 0, ground: 200, top: 1600, radius: 150, strength: 2.4, capX: 1340, capZ: 0 });
  const thermal = game.guide.handlers.findThermal({ type: 'findThermal' });
  const thermalWaypoint = game.waypoints.at(-1);
  check('callouts', 'find a thermal: a waypoint where the column is at our height', thermal.ok && thermalWaypoint.label === 'Thermal' && Math.abs(thermalWaypoint.x - 1250) < 1 && /2\.4 metres a second/.test(thermal.text), `${thermal.text} ${JSON.stringify(thermalWaypoint)}`);
  game.state.player.position.x = 1245;
  const inside = game.guide.handlers.findThermal({ type: 'findThermal' });
  check('callouts', "find a thermal: inside one -> say so, no waypoint", inside.ok && /We're in one now/.test(inside.text) && game.waypoints.at(-1) === thermalWaypoint, inside.text);
  game.state.player.position.x = 0;
  game.setThermal(null);
  const noThermal = game.guide.handlers.findThermal({ type: 'findThermal' });
  check('callouts', 'find a thermal: none -> an honest answer', !noThermal.ok && /No working thermals within/.test(noThermal.text), noThermal.text);
  game.state.time.sunElevation = 6;
  const lowSun = game.guide.handlers.findThermal({ type: 'findThermal' });
  check('callouts', 'find a thermal: none with a low sun -> says the sun is too low', !lowSun.ok && /sun's too low/.test(lowSun.text), lowSun.text);
  game.state.time.sunElevation = 40;
}
{
  const game = createMockGame();
  game.setWeather('building');
  const noStorm = game.guide.handlers.chaseStorm({ type: 'chaseStorm' });
  check('callouts', 'chase the storm: none active -> says so with the weather', !noStorm.ok && /No storms active/.test(noStorm.text) && /building/.test(noStorm.text), noStorm.text);
  game.addLandmark({ name: 'Stone arch', type: 'arch', x: 0, z: -4000, distance: 4000, bearing: 0, discovered: false });
  const landmark = game.guide.handlers.nextDiscovery({ type: 'nextDiscovery' });
  check('callouts', 'next discovery falls back to an undiscovered landmark', landmark.ok && game.waypoints.at(-1).z === -4000 && /a landmark/.test(landmark.text), landmark.text);
  const empty = game.guide.handlers.nearby();
  check('callouts', "nearby with nothing around says so and names the nearest landmark", empty.ok && /Nothing on my list/.test(empty.text) && /Stone arch/.test(empty.text), empty.text);
}

// ---- remote: the new actions and the snapshot fields -------------------------------------------------------------
for (const [raw, expected] of [
  [{ type: 'nearby' }, { type: 'nearby' }],
  [{ type: 'nearby', autopilot: true }, { type: 'nearby' }],
  [{ type: 'goTo', name: '  Rope   bridge ' }, { type: 'goTo', name: 'Rope bridge' }],
  [{ type: 'goTo', id: 'spawn:tornado:3', autopilot: true }, { type: 'goTo', autopilot: true, id: 'spawn:tornado:3' }],
  [{ type: 'findThermal', autopilot: false }, { type: 'findThermal', autopilot: false }],
  [{ type: 'chaseStorm' }, { type: 'chaseStorm' }],
  [{ type: 'nextDiscovery', autopilot: true }, { type: 'nextDiscovery', autopilot: true }],
]) {
  const clean = Copilot.sanitizeAction(raw);
  check('remote', `accepted: ${JSON.stringify(raw)}`, same(clean, expected), JSON.stringify(clean));
}
for (const raw of [
  { type: 'goTo' }, { type: 'goTo', name: 'bridge', id: 'ropeBridge:1:1' }, { type: 'goTo', name: 3 }, { type: 'goTo', name: '   ' },
  { type: 'goTo', id: '' }, { type: 'goTo', id: 'x'.repeat(97) }, { type: 'goTo', name: 'volcano', autopilot: 'yes' },
  { type: 'findThermal', autopilot: 1 }, { type: 'chaseStorm', autopilot: 'true' }, { type: 'nextDiscovery', autopilot: null, extra: 1 }, { type: 'tourGuide' },
]) {
  const clean = Copilot.sanitizeAction(raw);
  const expectRefused = !(raw.type === 'nextDiscovery');
  check('remote', `${expectRefused ? 'refused' : 'accepted (null autopilot = omitted)'}: ${JSON.stringify(raw)}`, expectRefused ? clean === null : same(clean, { type: 'nextDiscovery' }), JSON.stringify(clean));
}
const reply = Copilot.sanitizeReply({ speech: 'Here you go.', action: { type: 'goTo', name: 'volcano', autopilot: true } });
check('remote', 'a reply with a goTo action validates', reply && reply.action.type === 'goTo' && reply.action.autopilot === true, JSON.stringify(reply));
{
  const game = createMockGame();
  game.site('ropeBridge', 3000, 0, 'ropeBridge:1:0');
  game.candidate('tornado', 0, -6000);
  const event = game.spawn('supercell', -NW, -NW);
  game.advance(1);
  const fields = game.guide.snapshotFields();
  const nearbyKeys = ['id', 'presetId', 'name', 'category', 'kind', 'distance', 'bearing', 'state', 'etaSeconds', 'discovered'];
  check('remote', 'nearby[]: every entry has the documented fields', fields.nearby.length === 3 && fields.nearby.every((entry) => same(Object.keys(entry), nearbyKeys)), JSON.stringify(fields.nearby));
  check('remote', 'nearby[]: states from getNearby, nearest first', same(fields.nearby.map((entry) => entry.state), ['site', 'dormant', 'active']) && fields.nearby[0].distance === 3000 && fields.nearby[0].bearing === 90, JSON.stringify(fields.nearby.map((entry) => [entry.state, entry.distance])));
  check('remote', 'activeEvents[]: the live event only, with id, presetId, name, category, distance, bearing and state', fields.activeEvents.length === 1 && fields.activeEvents[0].id === event && fields.activeEvents[0].presetId === 'supercell' && fields.activeEvents[0].state === 'active' && fields.activeEvents[0].bearing === 315 && same(Object.keys(fields.activeEvents[0]), nearbyKeys), JSON.stringify(fields.activeEvents));
  check('remote', 'weather and callouts fields', fields.weather.state === 'clear' && fields.callouts.enabled === true && fields.callouts.offer && fields.callouts.offer.name === 'Supercell' && fields.callouts.offer.expiresIn > 0, JSON.stringify({ weather: fields.weather, callouts: fields.callouts }));
  check('remote', 'the snapshot fields survive JSON (what the endpoint receives)', same(JSON.parse(JSON.stringify(fields)), fields), '');
}

// ---- craftCommands: each craft's own commands through craftCommand (contract h.6) ---------------------------
{
  const commandFlight = {
    ...FLIGHT,
    craft: 'bushplane',
    craftName: 'Bush plane',
    craftCommands: [
      { id: 'smoke', phrases: ['\\bsmoke (on|off)\\b'] },
      { id: 'altitudeHold', phrases: ['\\bhold (\\d+)( m| metres| meters)?\\b'] },
      { id: 'trimCheck', phrases: ['\\btrim check\\b'] },
    ],
    craftStatus: 'Smoke is off, oil pressure in the green.',
  };
  const commandFor = (transcript) => brain.interpret(commandFlight, transcript);
  const smoke = commandFor('smoke on').action;
  check('craftCommands', '"smoke on" -> craftCommand smoke, value "on" (the capture group)', smoke && smoke.type === 'craftCommand' && smoke.craft === 'bushplane' && smoke.command === 'smoke' && smoke.value === 'on', JSON.stringify(smoke));
  const hold = commandFor('WREN, hold 1200 metres').action;
  check('craftCommands', 'a numeric capture becomes a number value', hold && hold.command === 'altitudeHold' && hold.value === 1200, JSON.stringify(hold));
  const trim = commandFor('run a trim check').action;
  check('craftCommands', 'a phrase without a capture carries no value', trim && trim.command === 'trimCheck' && !('value' in trim), JSON.stringify(trim));
  check('craftCommands', 'without craft commands in the snapshot the phrase is not a craft command', actionFor('trim check')?.type !== 'craftCommand', JSON.stringify(actionFor('trim check')));
  const craftSwitch = commandFor('switch to the jet').action;
  check('craftCommands', 'the shared grammar still answers around them', craftSwitch && craftSwitch.type === 'setCraft' && craftSwitch.craft === 'jet', JSON.stringify(craftSwitch));
  const status = commandFor('systems check');
  check('craftCommands', '"systems check" speaks the craft\'s own status', status.action === null && status.speech === 'Smoke is off, oil pressure in the green.', status.speech);
  const plainStatus = brain.interpret({ ...FLIGHT, craftName: 'Glider', airspeed: { indicatedMs: 30, groundSpeedMs: 30, mach: 0.09 } }, 'craft status');
  check('craftCommands', 'a craft without its own status gets the general one', plainStatus.action === null && /glider/i.test(plainStatus.speech), plainStatus.speech);
  const cleanCommand = Copilot.sanitizeAction({ type: 'craftCommand', craft: 'Seaplane', command: 'waterRudders', value: true, extra: 1 });
  check('craftCommands', 'schema: craft (any case), a camelCase command and a boolean value; extra fields dropped', cleanCommand && cleanCommand.craft === 'seaplane' && cleanCommand.command === 'waterRudders' && cleanCommand.value === true && !('extra' in cleanCommand), JSON.stringify(cleanCommand));
  for (const raw of [
    { type: 'craftCommand', craft: 'zeppelin', command: 'smoke' },
    { type: 'craftCommand', craft: 'aerobatic', command: 'Smoke On' },
    { type: 'craftCommand', craft: 'aerobatic' },
    { type: 'craftCommand', craft: 'aerobatic', command: 'smoke', value: { colour: 'red' } },
    { type: 'craftCommand', craft: 'aerobatic', command: 'smoke', value: Number.NaN },
    { type: 'craftCommand', craft: 'aerobatic', command: 'smoke', value: 'x'.repeat(49) },
  ]) {
    check('craftCommands', `schema refused: ${JSON.stringify(raw).slice(0, 90)}`, Copilot.sanitizeAction(raw) === null, JSON.stringify(Copilot.sanitizeAction(raw)));
  }
}

// ---- Milestone O: the cross-craft grammar (contract j.2) ----------------------------------------------------
/** The snapshot of another craft: the module's own commands as the flight controller lists them. */
function flightIn(craft, patch = {}) {
  const module = craftRegistry.get(craft);
  const craftCommands = module && module.copilot && module.copilot.commands ? module.copilot.commands.map((command) => ({ id: command.id, phrases: command.phrases.slice() })) : [];
  return { ...FLIGHT, craft, craftCommands, ...patch };
}
const actionIn = (flight, transcript) => brain.interpret(flight, transcript).action;

// switch to [craft]: every catalog id, its display name and the natural synonyms; skins by name.
{
  for (const id of CRAFT_IDS) {
    const action = actionFor(`switch to the ${id}`);
    check('craftSwitch', `"switch to the ${id}" -> setCraft ${id}`, action && action.type === 'setCraft' && action.craft === id, JSON.stringify(action));
    const name = craftRegistry.entry(id).name.toLowerCase().split(' / ')[0];
    const byName = actionFor(`switch to the ${name}`);
    check('craftSwitch', `"switch to the ${name}" (display name) -> setCraft ${id}`, byName && byName.type === 'setCraft' && byName.craft === id, JSON.stringify(byName));
  }
  for (const [phrase, craft, skin] of [
    ['switch to the stunt plane', 'aerobatic', null], ['fly the extra 330', 'aerobatic', null], ['aerobatic plane please', 'aerobatic', null],
    ['switch to the float plane', 'seaplane', null], ['give me the floatplane', 'seaplane', null], ['let me fly the sea plane', 'seaplane', null], ['amphibian', 'seaplane', null],
    ['switch to the osprey', 'tiltrotor', null], ['tilt rotor', 'tiltrotor', null], ['take the vtol', 'tiltrotor', null],
    ['switch to the para glider', 'paraglider', null], ["let's go paragliding", 'paraglider', null],
    ['switch to the hot air balloon', 'balloon', null], ['hot-air balloon please', 'balloon', null], ['i want the balloon', 'balloon', null],
    ['switch to the blimp', 'airship', null], ['zeppelin', 'airship', null], ['fly the dirigible', 'airship', null],
    ['switch to the rocket plane', 'spaceplane', null], ['take the space plane', 'spaceplane', null], ['rocket ship please', 'spaceplane', null],
    ['switch to the dragon', 'eagle', 'dragon'], ['let me be the dragon', 'eagle', 'dragon'], ['switch to the eagle', 'eagle', 'eagle'], ['fly the bird', 'eagle', null],
    ['switch to the glider', 'glider', null], ['sailplane', 'glider', null], ['switch to the bird suit', 'wingsuit', null], ['switch to the cub', 'bushplane', null],
  ]) {
    const action = actionFor(phrase);
    const ok = action && action.type === 'setCraft' && action.craft === craft && (skin ? action.skin === skin : !('skin' in action));
    check('craftSwitch', `"${phrase}" -> setCraft ${craft}${skin ? ` (skin ${skin})` : ''}`, ok, JSON.stringify(action));
  }
  for (const [phrase, type] of [['give me extra power', null], ['find the balloons', 'find'], ['take me to the jet stream', 'goTo'], ['what birds live here', null]]) {
    const action = actionFor(phrase);
    check('craftSwitch', `"${phrase}" is not a craft switch`, !action || (action.type !== 'setCraft' && (type === null || action.type === type)), JSON.stringify(action));
  }
  const skinned = Copilot.sanitizeAction({ type: 'setCraft', craft: 'Eagle', skin: 'dragon' });
  check('craftSwitch', 'schema: setCraft takes an optional skin id', skinned && skinned.craft === 'eagle' && skinned.skin === 'dragon', JSON.stringify(skinned));
  for (const raw of [{ type: 'setCraft', craft: 'eagle', skin: 'Red Dragon' }, { type: 'setCraft', craft: 'eagle', skin: 3 }, { type: 'setCraft', craft: 'blimp' }]) {
    check('craftSwitch', `schema refused: ${JSON.stringify(raw)}`, Copilot.sanitizeAction(raw) === null, JSON.stringify(Copilot.sanitizeAction(raw)));
  }
}

// smoke on / off: the aerobatic's own command, the cross-craft action elsewhere; never on questions.
{
  const aerobatic = flightIn('aerobatic');
  for (const [phrase, value] of [['smoke on', 'on'], ['smoke off', 'off'], ['turn the smoke on', 'on'], ['turn on the smoke', 'on'], ['start the smoke', 'on'], ['stop the smoke', 'off'], ['kill the smoke', 'off'], ['smoke please', 'on'], ['smoke', 'on']]) {
    const action = actionIn(aerobatic, phrase);
    check('smoke', `aerobatic: "${phrase}" -> craftCommand smoke ${value}`, action && action.type === 'craftCommand' && action.craft === 'aerobatic' && action.command === 'smoke' && action.value === value, JSON.stringify(action));
  }
  for (const [phrase, enabled] of [['smoke on', true], ['smoke off', false], ['turn the smoke on please', true], ['switch the smoke off', false]]) {
    const action = actionIn(flightIn('bushplane'), phrase);
    check('smoke', `bush plane: "${phrase}" -> smoke ${enabled}`, same(action, { type: 'smoke', enabled }), JSON.stringify(action));
  }
  const glider = actionFor('smoke on');
  check('smoke', 'glider: "smoke on" -> smoke true (the executor answers that it has none)', same(glider, { type: 'smoke', enabled: true }), JSON.stringify(glider));
  const colour = actionIn(aerobatic, 'red smoke');
  check('smoke', 'aerobatic: "red smoke" stays the colour command', colour && colour.command === 'smokeColor' && colour.value === 'red', JSON.stringify(colour));
  for (const phrase of ['is that smoke', 'is the smoke on', 'smoke on the water', 'what colour is the smoke', 'i see smoke over there']) {
    const action = actionIn(aerobatic, phrase);
    check('smoke', `"${phrase}" switches no smoke`, !action || !(action.type === 'smoke' || (action.type === 'craftCommand' && action.command === 'smoke')), JSON.stringify(action));
  }
}

// find water to land.
{
  for (const [phrase, autopilot] of [['find water to land', false], ['find water', false], ['find some water please', false], ['where can we land on water', false], ['find a lake to land on', false], ['nearest water to land on', false], ['find water to land and fly us there', true], ['find landable water on autopilot', true], ['show me water to land', false]]) {
    const action = actionFor(phrase);
    check('water', `"${phrase}" -> findWater${autopilot ? ' (autopilot)' : ''}`, same(action, { type: 'findWater', autopilot }), JSON.stringify(action));
  }
  for (const [phrase, type] of [['find the ocean', 'find'], ['land on the water', null], ['how deep is the water', null], ['take me to the sea', 'find']]) {
    const action = actionFor(phrase);
    check('water', `"${phrase}" is not findWater`, !action || (action.type !== 'findWater' && (type === null || action.type === type)), JSON.stringify(action));
  }
}

// find a perch: the waypoint search on every craft, before the eagle's own approach command.
{
  for (const phrase of ['find a perch', 'find me a perch', 'nearest perch', 'where can we perch', 'perch', 'take us to the nearest perch', 'land on the nearest perch']) {
    const action = actionIn(flightIn('eagle'), phrase);
    check('perch', `eagle: "${phrase}" -> findPerch`, action && action.type === 'findPerch', JSON.stringify(action));
  }
  check('perch', 'glider: "find a perch" -> findPerch', actionFor('find a perch')?.type === 'findPerch', JSON.stringify(actionFor('find a perch')));
  check('perch', '"find a perch and fly us there" engages the autopilot', actionFor('find a perch and fly us there')?.autopilot === true, JSON.stringify(actionFor('find a perch and fly us there')));
  for (const phrase of ['are we perched', 'perch now', 'perch somewhere']) {
    const action = actionIn(flightIn('eagle'), phrase);
    check('perch', `eagle: "${phrase}" is not the waypoint search`, !action || action.type !== 'findPerch', JSON.stringify(action));
  }
}

// wind at [altitude]: metres, feet, kilometres, thousands, words, flight levels, the pilot's units.
{
  for (const [phrase, metres, unit, aviation] of [
    ['wind at 2000 feet', 609.6, 'feet', false], ['wind at three kilometres', 3000, 'km', false], ['wind at 1,500 m', 1500, 'metres', false],
    ["what's the wind at 3000 metres", 3000, 'metres', false], ["what's the wind like at fifteen hundred feet", 457.2, 'feet', false],
    ['winds aloft at flight level 100', 3048, 'feet', false], ['wind at 2.5 km', 2500, 'km', false], ['wind at two thousand five hundred feet', 762, 'feet', false],
    ['wind at 10k feet', 3048, 'feet', false], ['wind at 2000', 2000, 'metres', false], ['wind at 2000', 609.6, 'feet', true],
    ['what is the wind doing up at 4 km', 4000, 'km', false], ['wind near the coast at 800 m', 800, 'metres', false], ['wind at an altitude of 1200 metres', 1200, 'metres', false],
  ]) {
    const action = actionIn({ ...FLIGHT, units: aviation ? 'aviation' : 'metric' }, phrase);
    check('wind', `"${phrase}"${aviation ? ' (aviation units)' : ''} -> windAt ${metres} m (${unit})`, action && action.type === 'windAt' && Math.abs(action.altitude - metres) < 0.2 && action.unit === unit && !('reference' in action), JSON.stringify(action));
  }
  const agl = actionFor('wind at 500 metres above the ground');
  check('wind', '"wind at 500 metres above the ground" -> windAt 500 agl', agl && agl.type === 'windAt' && agl.altitude === 500 && agl.reference === 'agl', JSON.stringify(agl));
  const here = actionFor("what's the wind");
  check('wind', '"what\'s the wind" -> windAt here (no altitude)', same(here, { type: 'windAt' }), JSON.stringify(here));
  for (const phrase of ['wind at the summit', 'wind at 10 knots', 'turn into the wind', 'wind layers']) {
    const action = actionFor(phrase);
    check('wind', `"${phrase}" is not a wind-at question`, !action || action.type !== 'windAt', JSON.stringify(action));
  }
  const balloonLayers = actionIn(flightIn('balloon'), 'wind layers');
  check('wind', 'balloon: "wind layers" stays the balloon\'s wind report', balloonLayers && balloonLayers.command === 'windReport', JSON.stringify(balloonLayers));
  for (const [phrase, expected] of [['2000 feet', 609.6], ['three kilometres', 3000], ['one and a half km', 1500], ['half a kilometre', 500], ['a thousand feet', 304.8], ['two thousand and fifty feet', 624.84], ['fl100', 3048], ['two point five km', 2500]]) {
    const parsed = parseAltitude(phrase, 'metric');
    check('wind', `parseAltitude("${phrase}") = ${expected} m`, parsed && Math.abs(parsed.metres - expected) < 0.01, JSON.stringify(parsed));
  }
  check('wind', 'parseAltitude refuses a speed and a height past the ceiling', parseAltitude('12 knots') === null && parseAltitude('200 km') === null, JSON.stringify([parseAltitude('12 knots'), parseAltitude('200 km')]));
  check('wind', 'describeWind: from-direction and speed in the pilot units', describeWind(5, 0, 'metric') === 'from the west, 270 degrees, at 18 km/h' && describeWind(0, 5, 'aviation') === 'from the north, 000 degrees, at 10 knots' && describeWind(0.1, 0.1, 'metric') === 'calm', `${describeWind(5, 0, 'metric')} | ${describeWind(0, 5, 'aviation')}`);
}

// start the challenge.
{
  for (const phrase of ['start the challenge', "let's start the challenge", 'challenge', 'race the challenge', 'begin the challenge course', "i'm ready for the challenge"]) {
    check('challenge', `"${phrase}" -> challengeStart`, same(actionFor(phrase), { type: 'challengeStart' }), JSON.stringify(actionFor(phrase)));
  }
  for (const phrase of ['cancel the challenge', 'stop the challenge', 'abandon the challenge']) {
    check('challenge', `"${phrase}" -> challengeCancel (never a start)`, same(actionFor(phrase), { type: 'challengeCancel' }), JSON.stringify(actionFor(phrase)));
  }
  for (const phrase of ["what's my best challenge time", 'how did the challenge go']) {
    const action = actionFor(phrase);
    check('challenge', `"${phrase}" starts nothing`, !action || (action.type !== 'challengeStart' && action.type !== 'ringCourse'), JSON.stringify(action));
  }
  check('challenge', '"ring course" is still the v1 ring course', actionFor('ring course')?.type === 'ringCourse', JSON.stringify(actionFor('ring course')));
}

// take me to space.
{
  for (const phrase of ['take me to space', 'take us to space please', 'fly me into space', 'climb to space', "let's go to space", 'i want to go to space', 'space flight', 'get us to space']) {
    check('space', `"${phrase}" -> toSpace`, same(actionFor(phrase), { type: 'toSpace' }), JSON.stringify(actionFor(phrase)));
  }
  for (const phrase of ['abort the climb to space', 'stop climbing to space', 'cancel the space climb']) {
    check('space', `"${phrase}" -> toSpace off (never a start)`, same(actionFor(phrase), { type: 'toSpace', enabled: false }), JSON.stringify(actionFor(phrase)));
  }
  for (const phrase of ['what is space like', 'how high is space', 'take me to the celestial events', 'switch to the space plane']) {
    const action = actionFor(phrase);
    check('space', `"${phrase}" is not a climb to space`, !action || action.type !== 'toSpace', JSON.stringify(action));
  }
  check('space', '"take me to the celestial events" stays the tour guide', actionFor('take me to the celestial events')?.type === 'goTo', JSON.stringify(actionFor('take me to the celestial events')));
}

// scenic cruise: the airship's command on the airship, the cross-craft action elsewhere.
{
  const airship = flightIn('airship');
  for (const [phrase, value] of [['scenic cruise', 'start'], ['start a scenic tour', 'start'], ['scenic cruise off', 'stop'], ['stop the scenic cruise', 'stop']]) {
    const action = actionIn(airship, phrase);
    check('scenic', `airship: "${phrase}" -> craftCommand scenicCruise ${value}`, action && action.type === 'craftCommand' && action.command === 'scenicCruise' && action.value === value, JSON.stringify(action));
  }
  check('scenic', 'glider: "scenic cruise" -> scenicCruise on', same(actionFor('scenic cruise'), { type: 'scenicCruise', enabled: true }), JSON.stringify(actionFor('scenic cruise')));
  check('scenic', 'glider: "end the scenic cruise" -> scenicCruise off', same(actionFor('end the scenic cruise'), { type: 'scenicCruise', enabled: false }), JSON.stringify(actionFor('end the scenic cruise')));
  const asked = brain.interpret({ ...airship, craftState: { scenicCruise: { active: false, index: 0, waypoints: [] } } }, 'is the scenic cruise on');
  check('scenic', 'airship: "is the scenic cruise on" is answered from its state and starts nothing', asked.action === null && /scenic cruise is off/.test(asked.speech), JSON.stringify(asked));
  const smokeAsked = brain.interpret({ ...flightIn('aerobatic'), craftState: { smoke: true } }, 'is the smoke on');
  check('smoke', 'aerobatic: "is the smoke on" is answered from its state', smokeAsked.action === null && smokeAsked.speech === 'The smoke is on.', JSON.stringify(smokeAsked));
}

// negated and place phrases: a craft named as a thing out there, or a request said with "don't", starts nothing.
{
  for (const phrase of ['fly over the balloon festival', 'fly toward the dragon', 'follow the jet', 'fly near the eagle nest', 'watch the airship']) {
    const action = actionFor(phrase);
    check('negated', `"${phrase}" is not a craft switch`, !action || action.type !== 'setCraft', JSON.stringify(action));
  }
  for (const phrase of ["don't switch to the jet", 'do not take me to space', "don't start the challenge", 'do not start the scenic cruise', "don't turn the smoke on", 'dont find a perch', 'never take me to space', "don't find water to land"]) {
    const reply = brain.interpret(FLIGHT, phrase);
    check('negated', `"${phrase}" is answered and acts on nothing`, reply.action === null && reply.speech.length > 0, `${JSON.stringify(reply.action)} "${reply.speech}"`);
  }
  const later = actionFor('never mind, switch to the jet');
  check('negated', '"never mind, switch to the jet" still switches', later && later.type === 'setCraft' && later.craft === 'jet', JSON.stringify(later));
  const aerobaticNo = actionIn(flightIn('aerobatic'), "don't turn the smoke on");
  check('negated', 'aerobatic: "don\'t turn the smoke on" runs no smoke command', aerobaticNo === null, JSON.stringify(aerobaticNo));
}

// help: every phrase is listed.
{
  const help = brain.interpret(FLIGHT, 'craft help');
  const listed = ['switch to', 'dragon', 'smoke on', 'find water to land', 'find a perch', 'wind at', 'start the challenge', 'take me to space', 'scenic cruise'].every((phrase) => help.speech.includes(phrase));
  check('help', '"craft help" lists every cross-craft phrase with its key or chip, in one line', !help.action && listed && help.speech.length <= Copilot.MAX_SPEECH_LENGTH && /\bY\b/.test(help.speech) && /Space/.test(help.speech), `${help.speech.length} chars`);
  check('help', '"what can you do" points at the craft help', /craft help/.test(brain.interpret(FLIGHT, 'what can you do').speech), brain.interpret(FLIGHT, 'what can you do').speech.slice(0, 80));
}

// The remote schema of the cross-craft actions.
{
  for (const [raw, expected] of [
    [{ type: 'findWater' }, { type: 'findWater' }], [{ type: 'findWater', autopilot: true }, { type: 'findWater', autopilot: true }],
    [{ type: 'findPerch', autopilot: false }, { type: 'findPerch', autopilot: false }],
    [{ type: 'windAt', altitude: 609.6, unit: 'feet' }, { type: 'windAt', altitude: 609.6, unit: 'feet' }], [{ type: 'windAt' }, { type: 'windAt' }],
    [{ type: 'windAt', altitude: 300, reference: 'agl' }, { type: 'windAt', altitude: 300, reference: 'agl' }],
    [{ type: 'challengeStart', extra: 1 }, { type: 'challengeStart' }], [{ type: 'challengeCancel' }, { type: 'challengeCancel' }],
    [{ type: 'toSpace' }, { type: 'toSpace' }], [{ type: 'toSpace', enabled: false }, { type: 'toSpace', enabled: false }],
    [{ type: 'scenicCruise', enabled: true }, { type: 'scenicCruise', enabled: true }], [{ type: 'smoke', enabled: false }, { type: 'smoke', enabled: false }],
  ]) {
    check('remote', `accepted: ${JSON.stringify(raw)}`, same(Copilot.sanitizeAction(raw), expected), JSON.stringify(Copilot.sanitizeAction(raw)));
  }
  for (const raw of [
    { type: 'findWater', autopilot: 'yes' }, { type: 'findPerch', autopilot: 1 }, { type: 'windAt', altitude: -5 }, { type: 'windAt', altitude: 200000 },
    { type: 'windAt', altitude: '3000' }, { type: 'windAt', altitude: Number.NaN }, { type: 'windAt', reference: 'ground' }, { type: 'windAt', unit: 'yards' },
    { type: 'toSpace', enabled: 'true' }, { type: 'scenicCruise', enabled: 1 }, { type: 'smoke', enabled: 'on' }, { type: 'goToSpace' },
  ]) {
    check('remote', `refused: ${JSON.stringify(raw)}`, Copilot.sanitizeAction(raw) === null, JSON.stringify(Copilot.sanitizeAction(raw)));
  }
  const reply = Copilot.sanitizeReply({ speech: '', action: { type: 'windAt', altitude: 3000 } });
  check('remote', 'a reply with only a windAt action validates', reply && reply.action.altitude === 3000, JSON.stringify(reply));
}

// The remote flightState: onWater, craftState (the h.3 fields, rounded and bounded), challenge.
{
  const balloonState = {
    envelopeTemperature: 98.123456, ambientTemperature: 14.987, burner: 0.3333, vent: 0, altitudeHold: null, inflation: 1, ventTimer: 2.5,
    windColumn: Array.from({ length: 20 }, (unused, index) => ({ altitude: 100 * index + 0.123, agl: 40, fromDegrees: 270.456, towardDegrees: 90, speed: 4.5678, vx: 1, vz: 2, primed: true })),
  };
  const balloon = craftStateSnapshot('balloon', balloonState);
  check('remote', 'craftState: only the h.3 fields of the craft', same(Object.keys(balloon), ['envelopeTemperature', 'ambientTemperature', 'burner', 'vent', 'altitudeHold', 'windColumn']), JSON.stringify(Object.keys(balloon)));
  check('remote', 'craftState: numbers rounded to 2 decimals, lists cut to 12, nested records to their fields', balloon.envelopeTemperature === 98.12 && balloon.windColumn.length === 12 && same(Object.keys(balloon.windColumn[0]), ['altitude', 'fromDegrees', 'speed']) && balloon.windColumn[1].speed === 4.57, JSON.stringify(balloon.windColumn[1]));
  const cruise = craftStateSnapshot('airship', { ballonet: 0.5, vectorAngle: 12.345, scenicCruise: { active: true, index: 1, waypoints: [{ name: 'Rope bridge with a very long name that goes on and on and on', x: 123.456, z: -9.87, id: 'secret' }], visited: 0, target: { x: 1, z: 2 } } });
  check('remote', 'craftState: the scenic cruise as plain data (names cut to 48 characters)', cruise.scenicCruise.active === true && cruise.scenicCruise.waypoints[0].name.length === 48 && !('id' in cruise.scenicCruise.waypoints[0]) && !('target' in cruise.scenicCruise), JSON.stringify(cruise));
  const spaceplane = craftStateSnapshot('spaceplane', { apogee: 104523.789, dynamicPressure: 1234.5678, rcsBlend: 1, heating: 0, blackout: false, attitudeHold: false, autoReentry: true, spaceClimb: 'coast', spaceClimbPeak: 90000, rcsPitch: 0.4 });
  check('remote', 'craftState: the spaceplane\'s apogee and climb to space', spaceplane.apogee === 104523.79 && spaceplane.spaceClimb === 'coast' && !('rcsPitch' in spaceplane), JSON.stringify(spaceplane));
  const tiltrotor = craftStateSnapshot('tiltrotor', { nacelleAngle: 61.2345, nacelleTarget: 60, autoNacelle: true, corridor: { min: 40, max: 97, state: 'ok', debug: 1 }, proprotorRpm: 333 });
  check('remote', 'craftState: the nacelle angle and the corridor', tiltrotor.nacelleAngle === 61.23 && same(tiltrotor.corridor, { min: 40, max: 97, state: 'ok' }) && !('proprotorRpm' in tiltrotor), JSON.stringify(tiltrotor));
  check('remote', 'craftState: every craft id has a field list, and an unknown craft gives {}', CRAFT_IDS.every((id) => Array.isArray(CRAFT_STATE_FIELDS[id])) && same(craftStateSnapshot('zeppelin', { a: 1 }), {}), '');
  const challenge = challengeSnapshot({ active: true, courseKey: 'SEED:canyon', name: 'Canyon Gauntlet', phase: 'running', elapsed: 12.345, gateIndex: 2, gatesTotal: 8, nextGate: { x: 1, y: 2, z: 3, nx: 0, ny: 0, nz: 1, distance: 412.6, bearing: 45.4 }, missed: 0, penalties: 0, lastSplit: { index: 1, time: 8.123, delta: -0.456 }, medalPace: 'gold', best: 61.2, rival: null, prompt: null });
  check('remote', 'challenge: state.challenge as plain data', challenge.name === 'Canyon Gauntlet' && challenge.elapsed === 12.3 && same(challenge.nextGate, { distance: 413, bearing: 45 }) && challenge.lastSplit.delta === -0.5 && !('courseKey' in challenge), JSON.stringify(challenge));
  check('remote', 'challenge: null with no course near or running; the prompt alone when one is near', challengeSnapshot({ active: false, prompt: null }) === null && challengeSnapshot({ active: false, prompt: { courseKey: 'k', name: 'Kite slalom', distance: 800.4, bearing: 10 } }).prompt.distance === 800, '');
  // buildFlightFields on a mock game (the remote request body).
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const telemetry = { craft: 'balloon', wind: { x: 1, y: 0, z: -2 }, gear: {}, onWater: true, craftState: balloonState, indicatedAirspeed: 5, groundSpeed: 5 };
  const ctx = {
    bus,
    state: { flight: telemetry, challenge: { active: false, prompt: { courseKey: 'k', name: 'Kite slalom', distance: 900, bearing: 90 } } },
    settings: { get: (key) => (key === 'assists' ? { balloon: 1 } : key === 'units' ? 'metric' : undefined) },
    craftRegistry,
    systems: { flight: { getCraft: () => 'balloon', getCraftModule: () => craftRegistry.get('balloon'), getCraftCommands: () => [], getCraftStatus: () => '' } },
  };
  const fields = buildFlightFields(ctx, { view: 'chase', landingCount: 0 });
  check('remote', 'flightState: onWater, craftState and challenge, and craftCommands kept', fields.onWater === true && fields.craftState.envelopeTemperature === 98.12 && fields.challenge.prompt.name === 'Kite slalom' && Array.isArray(fields.craftCommands), JSON.stringify({ onWater: fields.onWater, challenge: fields.challenge }));
  const size = JSON.stringify(fields).length;
  check('remote', 'flightState: survives JSON and stays small (under 4 KB with a full wind column)', same(JSON.parse(JSON.stringify(fields)), fields) && size < 4096, `${size} bytes`);
}

// ---- the cross-craft guide on a mock game (the executor) --------------------------------------------------------
function createCraftGame({ craft = 'glider', units = 'metric' } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const state = {
    ready: true,
    time: { realElapsed: 100, elapsed: 100 },
    player: { position: { x: 0, y: 900, z: 0 }, heading: 0, speed: 40 },
    flight: { craft, craftState: {}, wind: { x: 3, y: 0, z: 0 }, crash: { active: false }, onGround: false },
    challenge: { active: false, prompt: null },
  };
  const values = { units, craftSkins: {} };
  const waypoints = [];
  const commands = [];
  const abilities = [];
  let follows = 0;
  const lakes = [];
  let seaFrom = Infinity;
  const perchPoints = [];
  const courses = [];
  const started = [];
  const flight = {
    current: craft,
    skin: 'eagle',
    getCraft() { return this.current; },
    getCraftModule() { return craftRegistry.get(this.current); },
    getSkin() { return this.skin; },
    runCraftCommand(command, value) {
      commands.push({ craft: this.current, command, value });
      if (command === 'findPerch') {
        state.flight.craftState.perchTarget = { x: 1, y: 2, z: 3 };
        return { ok: true, text: 'Found a tree top. Bringing us in.' };
      }
      return { ok: true, text: `${command} ${value ?? ''}`.trim() };
    },
    runAbility(slot) {
      abilities.push(slot);
      state.flight.craftState.smoke = !state.flight.craftState.smoke;
      return true;
    },
  };
  const ctx = {
    THREE,
    bus,
    state,
    settings: { get: (key) => values[key], set: (key, value) => { values[key] = value; return true; }, update: (key, patch) => { values[key] = { ...values[key], ...patch }; return true; } },
    world: { groundHeight: () => 200, WATER_LEVEL: 0 },
    craftRegistry,
    waterQuery: {
      seaLevel: 0,
      bodiesNear(x, z, radius, visit) { for (const lake of lakes) if (Math.hypot(lake.x - x, lake.z - z) <= radius) visit(lake); },
      sample(x, z, t, out) {
        const lake = lakes.find((candidate) => candidate.x === x && candidate.z === z);
        out.kind = lake ? 'lake' : 'none';
        out.depth = lake ? lake.depth : 0;
        return out;
      },
      isOcean: (x) => x >= seaFrom,
      groundHeight: (x) => (x >= seaFrom ? -20 : 200),
    },
    colliders: { perchesNear(x, y, z, radius, visit) { for (const perch of perchPoints) if (Math.hypot(perch.x - x, perch.z - z) <= radius) visit(perch.x, perch.y, perch.z, perch.kind, perch.id); } },
    wind: {
      probe(point, t, out) {
        // The wind veers with height: from the west at the ground, from the north-west at 3 km.
        const share = Math.min(1, point.y / 3000);
        out.vel.set(5 + 5 * share, point.y > 2500 ? 0.8 : 0, 5 * share);
        out.turbulence = 0;
        return out;
      },
    },
    systems: {
      flight,
      spawns: { manager: { getPreset: (id) => (id === 'flamingoLake' ? { id, name: 'Flamingo lake' } : null) } },
      challenges: {
        start(courseKey, options) { started.push({ courseKey, source: options.source }); state.challenge.active = true; state.challenge.phase = 'armed'; state.challenge.name = 'Canyon Gauntlet'; return true; },
        // Cleared in place, as the challenges system writes state.challenge.
        cancel() { if (!state.challenge.active) return false; state.challenge.active = false; state.challenge.phase = null; state.challenge.name = null; return true; },
        nearest: (radius) => courses.find((course) => course.distance <= radius) ?? null,
        getBest: () => ({ time: 72.4, medal: 'silver' }),
      },
    },
  };
  const waiterChecks = [];
  const guide = createCraftGuide(ctx, {
    succeed: (text, informative = false) => ({ ok: true, text, informative }),
    fail: (text) => ({ ok: false, text, informative: false }),
    pick: (key, lines) => lines[0],
    placeWaypoint: (x, z, label) => {
      waypoints.push({ x, z, label });
      return { label };
    },
    engageFollow: () => {
      follows++;
      return true;
    },
    directionPhrase: Copilot.directionPhrase,
    waiter: { wait: (check) => { waiterChecks.push(check); return Promise.resolve(Boolean(check())); } },
    setCraft: (action) => {
      flight.current = action.craft;
      state.flight.craft = action.craft;
      state.flight.craftState = {};
      return { ok: true, text: `${action.craft} it is.` };
    },
  });
  return {
    guide, state, values, waypoints, commands, abilities, flight, started, courses,
    get follows() { return follows; },
    addLake(lake) { lakes.push(lake); },
    setSea(x) { seaFrom = x; },
    addPerch(perch) { perchPoints.push(perch); },
    advance(seconds) {
      state.time.realElapsed += seconds;
      guide.update();
    },
  };
}

{
  // find water: the nearer of a lake big enough and the open sea; a pond too small or a frozen lake never.
  const game = createCraftGame({ craft: 'jet' });
  game.addLake({ x: 0, z: -3000, presetId: 'flamingoLake', material: 'water', kind: 'lake', bounds: { minX: -400, maxX: 400, minZ: -3400, maxZ: -2600 }, depth: 4 });
  game.addLake({ x: 900, z: 0, presetId: null, material: 'water', kind: 'lake', bounds: { minX: 850, maxX: 950, minZ: -50, maxZ: 50 }, depth: 2 });
  game.addLake({ x: 0, z: 1500, presetId: null, material: 'ice', kind: 'lake', bounds: { minX: -500, maxX: 500, minZ: 1000, maxZ: 2000 }, depth: 3 });
  game.setSea(8000);
  const lake = game.guide.handlers.findWater({ type: 'findWater' });
  check('executor', 'findWater: the nearest lake big enough (not the pond, not the ice), named, with distance and heading', lake.ok && same(game.waypoints.at(-1), { x: 0, z: -3000, label: 'Flamingo lake' }) && /the flamingo lake, 3\.0 km straight ahead, heading 000/.test(lake.text), lake.text);
  check('executor', "findWater: on a craft that can't land on water, it says which can", /can't land on water/.test(lake.text) && /the seaplane/.test(lake.text) && /balloon/.test(lake.text) && /paraglider/.test(lake.text), lake.text);
  game.setSea(1000);
  const sea = game.guide.handlers.findWater({ type: 'findWater', autopilot: true });
  check('executor', 'findWater: the open sea past the shore when it is nearer, with the autopilot when asked', sea.ok && game.waypoints.at(-1).label === 'Open sea' && game.waypoints.at(-1).x > 1000 && game.follows === 1 && /autopilot engaged/.test(sea.text), `${sea.text} ${JSON.stringify(game.waypoints.at(-1))}`);
  const seaplane = createCraftGame({ craft: 'seaplane' });
  seaplane.setSea(-Infinity);
  const over = seaplane.guide.handlers.findWater({ type: 'findWater' });
  check('executor', 'findWater: over the sea already -> says so, no waypoint, no warning for the seaplane', over.ok && seaplane.waypoints.length === 0 && /right now/.test(over.text) && !/can't land/.test(over.text), over.text);
  const dry = createCraftGame({ craft: 'seaplane' });
  const none = dry.guide.handlers.findWater({ type: 'findWater' });
  check('executor', 'findWater: none within 20 km -> an honest answer', !none.ok && /No landable water/.test(none.text), none.text);
}
{
  // find a perch: the nearest tree top; the eagle flies its own approach when one is close.
  const game = createCraftGame({ craft: 'glider' });
  game.addPerch({ x: 1500, y: 236, z: 0, kind: 'tree', id: 'perch:pine:1' });
  game.addPerch({ x: -2000, y: 300, z: 0, kind: 'structure', id: 'tower' });
  const far = game.guide.handlers.findPerch({ type: 'findPerch' });
  check('executor', 'findPerch: the nearest perch, its height, and only the eagle perches', far.ok && same(game.waypoints.at(-1), { x: 1500, z: 0, label: 'Tree-top perch' }) && /a tree top, 1\.5 km to the east, heading 090/.test(far.text) && /36 metres up/.test(far.text) && /the eagle/.test(far.text), far.text);
  const eagle = createCraftGame({ craft: 'eagle' });
  eagle.addPerch({ x: 120, y: 236, z: 0, kind: 'tree', id: 'perch:pine:2' });
  const close = eagle.guide.handlers.findPerch({ type: 'findPerch' });
  check('executor', "findPerch: the eagle close to one runs its own approach (craftCommand findPerch) and marks it", close.ok && eagle.commands.at(-1)?.command === 'findPerch' && eagle.waypoints.length === 1 && /Bringing us in/.test(close.text), close.text);
  const nothing = createCraftGame({ craft: 'eagle' }).guide.handlers.findPerch({ type: 'findPerch' });
  check('executor', 'findPerch: none within 2.5 km -> an honest answer', !nothing.ok && /No perch within/.test(nothing.text), nothing.text);
}
{
  // wind at: the WindField over the craft at the height asked, in the pilot's units.
  const game = createCraftGame({ craft: 'balloon' });
  const high = game.guide.handlers.windAt({ type: 'windAt', altitude: 3000, unit: 'km' });
  check('executor', 'windAt 3 km: from the north-west with its speed, rising air, and the wind here', high.ok && /^At 3 km: wind from the north-west, 297 degrees, at 40 km\/h\. Rising air, 0\.8 metres a second\. Here it's from the west/.test(high.text) && /wind column on the HUD/.test(high.text), high.text);
  const feet = createCraftGame({ craft: 'glider', units: 'aviation' }).guide.handlers.windAt({ type: 'windAt', altitude: 609.6, unit: 'feet' });
  check('executor', 'windAt 2,000 feet in aviation units: knots', feet.ok && /^At 2,000 feet: wind from the west/.test(feet.text) && /knots/.test(feet.text), feet.text);
  const under = createCraftGame({ craft: 'glider' }).guide.handlers.windAt({ type: 'windAt', altitude: 100, unit: 'metres' });
  check('executor', 'windAt under the ground here: says so and gives the wind just above it', under.ok && /^100 metres is under the ground here/.test(under.text), under.text);
  const here = createCraftGame({ craft: 'glider' }).guide.handlers.windAt({ type: 'windAt' });
  check('executor', 'windAt without a height: the wind where we fly', here.ok && /^Wind here, at 900 metres: from the west, 270 degrees, at 11 km\/h\.$/.test(here.text), here.text);
}
{
  // start the challenge: the course at the start prompt; else a waypoint to the nearest; cancel.
  const game = createCraftGame({ craft: 'jet' });
  const none = game.guide.handlers.challengeStart();
  check('executor', 'challengeStart: no course near -> an honest answer', !none.ok && /No challenge course within 20 km/.test(none.text), none.text);
  game.courses.push({ courseKey: 'SEED:canyon', name: 'Canyon Gauntlet', distance: 6200, bearing: 270 });
  const far = game.guide.handlers.challengeStart();
  check('executor', 'challengeStart: beyond the prompt -> a waypoint to the nearest start gate, nothing started', far.ok && game.started.length === 0 && game.waypoints.at(-1).label === 'Canyon Gauntlet' && Math.abs(game.waypoints.at(-1).x + 6200) < 1 && /6\.2 km to the west/.test(far.text), far.text);
  game.state.challenge.prompt = { courseKey: 'SEED:canyon', name: 'Canyon Gauntlet', distance: 820, bearing: 45 };
  const armed = game.guide.handlers.challengeStart();
  check('executor', 'challengeStart: at the prompt -> start(courseKey, source copilot), the gate and the best time spoken', armed.ok && same(game.started, [{ courseKey: 'SEED:canyon', source: 'copilot' }]) && /^Canyon Gauntlet, armed\. The start gate is 820 metres to the north-east/.test(armed.text) && /72\.4 seconds, silver/.test(armed.text), armed.text);
  const again = game.guide.handlers.challengeStart();
  check('executor', 'challengeStart: armed already -> says so, starts nothing more', again.ok && game.started.length === 1 && /armed/.test(again.text), again.text);
  const cancelled = game.guide.handlers.challengeCancel();
  const noRun = game.guide.handlers.challengeCancel();
  check('executor', 'challengeCancel: cancels the run by name, then says none is running', cancelled.ok && cancelled.text === 'Canyon Gauntlet cancelled.' && !noRun.ok && /no challenge running/.test(noRun.text), `${cancelled.text} | ${noRun.text}`);
}
{
  // take me to space: the confirm offer, "yes" switches and climbs, "no" declines, and it lapses.
  const game = createCraftGame({ craft: 'glider' });
  const offer = game.guide.handlers.toSpace({ type: 'toSpace' });
  check('executor', 'toSpace from the glider: asks first, switches nothing', offer.ok && /Switch from the glider to the spaceplane and climb to space\? Yes or no\./.test(offer.text) && game.flight.current === 'glider' && game.guide.getConfirm()?.kind === 'toSpace' && game.guide.hasConfirm(), offer.text);
  check('executor', 'toSpace: the snapshot carries the open offer', game.guide.snapshotFields().confirm?.craft === 'spaceplane' && game.guide.snapshotFields().confirm.expiresIn === CONFIRM_SECONDS, JSON.stringify(game.guide.snapshotFields()));
  check('executor', 'toSpace: another request is not an answer', game.guide.handleReply('make it dusk') === null && game.guide.getConfirm() !== null, '');
  const yes = await game.guide.handleReply('yes');
  check('executor', '"yes" switches to the spaceplane, then runs climbToSpace', yes.ok && game.flight.current === 'spaceplane' && same(game.commands.at(-1), { craft: 'spaceplane', command: 'climbToSpace', value: undefined }) && game.guide.getConfirm() === null && !game.guide.hasConfirm(), `${yes.speech} ${JSON.stringify(game.commands)}`);
  const direct = game.guide.handlers.toSpace({ type: 'toSpace' });
  check('executor', 'toSpace in the spaceplane runs the climb at once', direct.ok && game.commands.length === 2 && game.guide.getConfirm() === null, direct.text);
  const abort = game.guide.handlers.toSpace({ type: 'toSpace', enabled: false });
  check('executor', 'toSpace off in the spaceplane aborts the climb', abort.ok && same(game.commands.at(-1), { craft: 'spaceplane', command: 'climbToSpace', value: 'abort' }), JSON.stringify(game.commands.at(-1)));
  const declined = createCraftGame({ craft: 'jet' });
  declined.guide.handlers.toSpace({ type: 'toSpace' });
  const no = await declined.guide.handleReply('no thanks');
  check('executor', '"no" declines: still the jet, nothing run', no.ok && /Staying in the jet/.test(no.speech) && declined.flight.current === 'jet' && declined.commands.length === 0, no.speech);
  const lapsed = createCraftGame({ craft: 'jet' });
  lapsed.guide.handlers.toSpace({ type: 'toSpace' });
  lapsed.advance(CONFIRM_SECONDS + 1);
  check('executor', `the offer lapses after ${CONFIRM_SECONDS} s; a late "yes" does nothing`, lapsed.guide.getConfirm() === null && lapsed.guide.handleReply('yes') === null && lapsed.flight.current === 'jet', JSON.stringify(lapsed.guide.getStats()));
  const notClimbing = createCraftGame({ craft: 'jet' }).guide.handlers.toSpace({ type: 'toSpace', enabled: false });
  check('executor', 'toSpace off from another craft: nothing to stop', !notClimbing.ok && /not climbing/.test(notClimbing.text), notClimbing.text);
}
{
  // scenic cruise and smoke across craft.
  const game = createCraftGame({ craft: 'glider' });
  const offer = game.guide.handlers.scenicCruise({ type: 'scenicCruise', enabled: true });
  const yes = await game.guide.handleReply('yes please');
  check('executor', 'scenicCruise from the glider: offers the airship; "yes" switches and starts the cruise', offer.ok && /airship/.test(offer.text) && yes.ok && game.flight.current === 'airship' && same(game.commands.at(-1), { craft: 'airship', command: 'scenicCruise', value: 'start' }), `${offer.text} | ${yes.speech}`);
  const stop = game.guide.handlers.scenicCruise({ type: 'scenicCruise', enabled: false });
  check('executor', 'scenicCruise off on the airship stops it', stop.ok && same(game.commands.at(-1), { craft: 'airship', command: 'scenicCruise', value: 'stop' }), JSON.stringify(game.commands.at(-1)));
  const bush = createCraftGame({ craft: 'bushplane' });
  bush.state.flight.craftState = { smoke: false };
  const on = await bush.guide.handlers.smoke({ type: 'smoke', enabled: true });
  const already = await bush.guide.handlers.smoke({ type: 'smoke', enabled: true });
  const off = await bush.guide.handlers.smoke({ type: 'smoke', enabled: false });
  check('executor', 'smoke on the bush plane: its smoke ability, once; "already on" the second time', on.ok && on.text === 'Smoke on.' && /already on/.test(already.text) && off.text === 'Smoke off.' && bush.abilities.length === 2, `${on.text} | ${already.text} | ${off.text}`);
  const aerobatic = createCraftGame({ craft: 'aerobatic' });
  await aerobatic.guide.handlers.smoke({ type: 'smoke', enabled: true });
  check('executor', 'smoke on the aerobatic: its smoke command', same(aerobatic.commands.at(-1), { craft: 'aerobatic', command: 'smoke', value: 'on' }), JSON.stringify(aerobatic.commands));
  const noSmoke = await createCraftGame({ craft: 'glider' }).guide.handlers.smoke({ type: 'smoke', enabled: true });
  check('executor', 'smoke on the glider: no smoke system, and which craft carry it', !noSmoke.ok && /No smoke system on the glider/.test(noSmoke.text) && /bush plane/i.test(noSmoke.text) && /aerobatic/.test(noSmoke.text), noSmoke.text);
}
{
  // setCraft with a skin: "the dragon" through the craftSkins setting.
  const game = createCraftGame({ craft: 'eagle' });
  const flightSystem = game.flight;
  const ctx = {
    bus: attachTypedEvents(new EventBus(), { validate: true }),
    state: game.state,
    craftRegistry,
    settings: {
      values: { craftSkins: { eagle: '' } },
      get(key) { return this.values[key]; },
      set(key, value) { this.values[key] = value; if (key === 'craft') flightSystem.current = value; return true; },
      update(key, patch) { this.values[key] = { ...this.values[key], ...patch }; if (key === 'craftSkins' && patch.eagle) flightSystem.skin = patch.eagle; return true; },
    },
    systems: { flight: flightSystem },
  };
  const handlers = createFlightActionHandlers(ctx, {
    succeed: (text, informative = false) => ({ ok: true, text, informative }),
    fail: (text) => ({ ok: false, text }),
    pick: (key, lines) => lines[0],
    waiter: { wait: () => Promise.resolve(true) },
    noteCopilotChange: () => {},
    getView: () => null,
  });
  const dragon = handlers.setCraft({ type: 'setCraft', craft: 'eagle', skin: 'dragon' });
  check('executor', 'setCraft eagle + dragon while flying the eagle: the skin changes', dragon.ok && dragon.text === 'The dragon it is.' && ctx.settings.values.craftSkins.eagle === 'dragon' && flightSystem.skin === 'dragon', dragon.text);
  const same2 = handlers.setCraft({ type: 'setCraft', craft: 'eagle', skin: 'dragon' });
  check('executor', 'setCraft to the skin already flying says so', same2.ok && same2.text === "We're already flying the dragon.", same2.text);
  const bad = handlers.setCraft({ type: 'setCraft', craft: 'eagle', skin: 'phoenix' });
  check('executor', 'setCraft with a skin the craft does not have is refused', !bad.ok && /^No phoenix skin for that one: it comes as the eagle or the dragon.$/.test(bad.text), bad.text);
  flightSystem.current = 'jet';
  const back = handlers.setCraft({ type: 'setCraft', craft: 'eagle', skin: 'eagle' });
  check('executor', 'setCraft eagle + eagle from the jet: the skin first, then the craft', back.ok && flightSystem.current === 'eagle' && flightSystem.skin === 'eagle' && back.text === 'The eagle it is.', back.text);
  // Without a skin, a craft with skins is named by the one the setting picks, never "the eagle / dragon".
  ctx.settings.update('craftSkins', { eagle: 'dragon' });
  flightSystem.current = 'jet';
  const plain = handlers.setCraft({ type: 'setCraft', craft: 'eagle' });
  check('executor', 'setCraft eagle (no skin) is named by the chosen skin', plain.ok && flightSystem.current === 'eagle' && /^(The dragon it is\.|Switched to the dragon\.)$/.test(plain.text), plain.text);
  flightSystem.current = 'jet';
  const missing = handlers.setCraft({ type: 'setCraft', craft: 'eagle', skin: 'gold' });
  check('executor', 'a missing skin is refused with the skins the craft has', !missing.ok && missing.text === 'No gold skin for that one: it comes as the eagle or the dragon.', missing.text);
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(13)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} copilot grammar checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
