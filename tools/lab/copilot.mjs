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
//
// Usage: node tools/lab/copilot.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { Copilot } from '../../src/copilot/copilot.js';
import {
  CALLOUT_RULES, calloutBlockReason, createTourGuide, fillCallout, isLandingPhase, offerAnswer, resolveTarget,
} from '../../src/copilot/tourGuide.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';

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
]) {
  const action = actionFor(phrase);
  check('phase1', `"${phrase}" -> ${JSON.stringify(expected)}`, same(action, expected), JSON.stringify(action));
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
    time: { realElapsed: 100, elapsed: 100, nightFactor: 0 },
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
  check('callouts', 'find a thermal: none -> an honest answer', !noThermal.ok && /No working thermals/.test(noThermal.text), noThermal.text);
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

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} copilot grammar checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
