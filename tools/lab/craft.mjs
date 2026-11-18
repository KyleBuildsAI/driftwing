// Craft framework lab: the wave 2 craft framework (contract h.9) headless in node, through the real
// FlightController, craft registry, binding store, copilot action handler and journal.
//
// The controller flies a lab registry over the real catalog with the real glider and bush plane and
// one lab-only test craft built on the bush plane's airframe (registered as "aerobatic" in this node
// process only; it never reaches the game) that exercises every optional module field.
//
// Tests:
//   catalog     14 catalog craft in six groups, every id in exactly one group in the contract's order,
//               CRAFT_IDS in catalog order, the Phase 1 hotkeys kept, every game module registers
//   validation  the registry refuses each broken optional field with a readable message: an unknown
//               ability slot, an inputProfile value, a water landing, a custom cockpit without build,
//               skins whose default is not listed, a copilot phrase that is not a regex, a journal op,
//               a director weight, a collision probe, a capability that is not a boolean
//   favorites   the number keys pick the favorites; an empty slot and a craft without a module answer
//               with a notice and keep the craft; craftNext / craftPrev skip both and wrap; with no
//               flyable favorite they fall back to the catalog order
//   situate     the hook gets the situation (previous craft, height, track, ground and water flags,
//               wind) and its placement is applied: air, climb (45 degrees at full power, the lever
//               preset), hover, drift (moving with the air), ground, water (afloat) and water over dry
//               ground (flies); a placement's craftState is merged; a hook that throws or returns an
//               unknown mode logs one error and falls back to the Phase 1 rules; startAt applies a
//               placement and refuses a bad one
//   carry       (the portal ring, preset 67) flight.captureFlight is plain data and flight.resumeFlight
//               puts a fresh boot back in that flight: a tiltrotor in airplane mode keeps its nacelles,
//               airspeed and throttle, a slow one hovers, a balloon drifts on its hot envelope, a
//               climbing glider keeps its pitch and ballast; another craft's or nested state is not
//               taken; a broken carry is refused
//   abilities   Space and Shift+Space run craftAbility / craftAbilityAlt with the ability api (isHeld,
//               controls, setCraftState, colliders, waterQuery, wind, skin); both updates run every
//               frame; coloured smoke ('smokeColor') emits puffs
//   commands    runCraftCommand runs a module's copilot command and returns its reply; an unknown
//               command and a command that throws answer { ok: false } (the throw logs once); the
//               copilot's craftCommand handler refuses a command for another craft
//   skins       the mesh is built with the stored skin (the default without one); a skin change
//               rebuilds the mesh only (same model, same pose) and sets craftState.skin
//   state       state.flight.ceiling follows limits.ceiling; visual.craftState reaches the mesh;
//               env.windField is the WindField; a basket water landing does not soft crash
//   bindings    a craft module's default bindings apply to that craft only, the player's overrides
//               win, an invalid module reference is dropped with one error
//   journal     a craft module's journal.stats keys are known stats (their op wins)
//   roster      (wave 2 integration) all 14 catalog craft fly; every Phase 3 module places itself
//               (situate); the director's profile lookup knows every craft id and the required
//               profiles of contract i.2 hold on the real modules; faunaThreatOf; pinned HUD tiles
//
// Usage: node tools/lab/craft.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CRAFT_CATALOG, CRAFT_GROUPS, DEFAULT_FAUNA_THREAT, createCraftRegistry, faunaThreatOf, craftRegistry as gameRegistry } from '../../src/craft/registry.js';
import { CRAFT_WEIGHT_RANGE, DEFAULT_DIRECTOR_PROFILES, craftWeight } from '../../src/spawns/director.js';
import '../../src/craft/index.js';
import glider from '../../src/craft/glider.js';
import bushplane from '../../src/craft/bushplane.js';
import { flightModels } from '../../src/flight/models.js';
import { createFlightController } from '../../src/flight/FlightController.js';
import { createControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { createBindingStore } from '../../src/input/bindings.js';
import { createFlightActionHandlers } from '../../src/copilot/flightActions.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { CRAFT_IDS, DEFAULT_CRAFT_FAVORITES } from '../../src/core/settings.js';
import { CONFIG } from '../../src/core/config.js';
import { DEG, vectorFromHeading } from '../../src/core/util.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

/** Captures console.error while fn runs (the controller reports module bugs there); returns the lines. */
function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const GROUND = 200;
/** East of this x the ground lies under the sea (CONFIG.WATER_LEVEL): the water placements fly there. */
const SEA_EAST_OF = 4000;
const FRAME = 1 / 60;

// ---- The lab-only test craft ----------------------------------------------------------------------
const lab = {
  situateMode: 'climb',
  lastSituation: null,
  lastSkin: undefined,
  lastVisualState: null,
  abilityRuns: { craftAbility: 0, craftAbilityAlt: 0 },
  abilityUpdates: { craftAbility: 0, craftAbilityAlt: 0 },
  heldSeen: false,
  apiSeen: null,
};

/** The placements situate answers with, by lab.situateMode. */
const PLACEMENTS = {
  climb: () => ({ mode: 'climb', speed: 70, craftState: { armed: true } }),
  hover: (situation) => ({ mode: 'hover', position: { x: situation.position.x, y: situation.position.y, z: situation.position.z } }),
  drift: () => ({ mode: 'drift' }),
  ground: () => ({ mode: 'ground' }),
  water: () => ({ mode: 'water', position: { x: SEA_EAST_OF + 2000, y: 0, z: 0 }, heading: 90 }),
  dryWater: () => ({ mode: 'water', position: { x: 0, y: 900, z: 0 }, heading: 90 }),
  stateOnly: () => ({ craftState: { stateOnly: true } }),
  throws: () => { throw new Error('lab situate failure'); },
  unknown: () => ({ mode: 'teleport' }),
  none: () => null,
};

const testCraft = Object.freeze({
  ...bushplane,
  id: 'aerobatic',
  name: 'Lab test craft',
  buildMesh(ctx, options) {
    lab.lastSkin = options ? options.skin : undefined;
    const mesh = bushplane.buildMesh(ctx, options);
    const update = mesh.update;
    mesh.update = (visual, dt) => {
      lab.lastVisualState = visual.craftState;
      update(visual, dt);
    };
    return mesh;
  },
  skins: Object.freeze({ default: 'red', list: Object.freeze([{ id: 'red', name: 'Red' }, { id: 'blue', name: 'Blue' }]) }),
  abilities: Object.freeze({
    craftAbility: Object.freeze({
      label: 'Smoke',
      initialState: () => ({ smoke: false, smokeColor: 2 }),
      run(api) {
        lab.abilityRuns.craftAbility++;
        api.setCraftState('smoke', !api.craftState.smoke);
        lab.apiSeen = {
          controls: Boolean(api.controls && 'roll' in api.controls),
          colliders: 'colliders' in api,
          waterQuery: 'waterQuery' in api,
          wind: Boolean(api.wind && typeof api.wind.sample === 'function'),
          skin: api.skin,
          module: api.module && api.module.id,
        };
        return true;
      },
      update(api, dt) {
        lab.abilityUpdates.craftAbility++;
        if (api.isHeld('craftAbility')) lab.heldSeen = true;
        if (api.craftState.smoke) api.emitTrail('smokeColor', 'smoke', dt);
      },
    }),
    craftAbilityAlt: Object.freeze({
      label: 'Colour cycle',
      initialState: () => ({ cycles: 0 }),
      run(api) {
        lab.abilityRuns.craftAbilityAlt++;
        api.setCraftState('cycles', api.craftState.cycles + 1);
        return true;
      },
      update() {
        lab.abilityUpdates.craftAbilityAlt++;
      },
    }),
  }),
  situate(situation) {
    lab.lastSituation = situation;
    return PLACEMENTS[lab.situateMode](situation);
  },
  copilot: Object.freeze({
    commands: Object.freeze([
      Object.freeze({ id: 'smoke', phrases: Object.freeze(['\\bsmoke (on|off)\\b']), run: (api, value) => { api.setCraftState('smoke', value === 'on'); return `Smoke ${value}.`; } }),
      Object.freeze({ id: 'broken', phrases: Object.freeze(['\\bbreak it\\b']), run: () => { throw new Error('lab command failure'); } }),
    ]),
    status: (craftState) => `Smoke ${craftState.smoke ? 'on' : 'off'}.`,
  }),
  journal: Object.freeze({ stats: Object.freeze([{ key: 'labBestScore', label: 'Best lab score', unit: 'points', op: 'max' }]) }),
  limits: Object.freeze({ ...bushplane.limits, ceiling: 20000, waterLanding: 'basket' }),
  bindings: Object.freeze({
    keyboard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([{ type: 'key', code: 'KeyK', shift: false }]), gearToggle: Object.freeze([{ type: 'key', code: 'Bad Code!' }]) }) }),
  }),
});

// ---- Rig ----------------------------------------------------------------------------------------------
function ensureDocumentStandIn() {
  if (typeof globalThis.document !== 'undefined') return;
  const element = { style: {}, setAttribute() {} };
  globalThis.document = { body: { appendChild() {} }, getElementById: () => null, createElement: () => element };
}

function createRig({ craft = 'glider', favorites = DEFAULT_CRAFT_FAVORITES.slice(), wind = null, skins = {}, modules = [] } = {}) {
  ensureDocumentStandIn();
  const registry = createCraftRegistry();
  registry.register(glider);
  registry.register(bushplane);
  registry.register(testCraft);
  // Real game modules a test flies besides the lab's three (the portal carry: tiltrotor, balloon).
  for (const id of modules) registry.register(gameRegistry.get(id));
  const world = {
    groundHeight: (x) => (x > SEA_EAST_OF ? CONFIG.WATER_LEVEL - 40 : GROUND),
    heightAt: (x) => (x > SEA_EAST_OF ? CONFIG.WATER_LEVEL - 40 : GROUND),
    WATER_LEVEL: CONFIG.WATER_LEVEL,
  };
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], softCrash: [], skin: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('softCrash', (payload) => events.softCrash.push(payload));
  bus.on('craft:skinChanged', (payload) => events.skin.push(payload));
  const heading = 30;
  const altitude = 1500;
  const player = {
    position: new THREE.Vector3(0, altitude, 0),
    velocity: vectorFromHeading(heading).multiplyScalar(40),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG),
    forward: vectorFromHeading(heading),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    speed: 40, throttle: 0.5, heading, pitch: 0, roll: 0, yawRate: 0, verticalSpeed: 0, gForce: 1,
    altitude, groundHeight: GROUND, agl: altitude - GROUND, stalled: false,
    autopilot: { enabled: false, heading, altitude, followWaypoint: false }, inCloud: 0,
  };
  const state = {
    frame: 0, paused: false, photoMode: false, seed: 'CRAFT-LAB',
    time: { elapsed: 0, realElapsed: 0, frameDt: 0, nightFactor: 0, sunElevation: 30, dayTime: 0.45 },
    player, flight: createFlightTelemetry(), waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const settingsValues = { craft, startOnGround: false, assists: Object.fromEntries(CRAFT_IDS.map((id) => [id, 1])), craftFavorites: favorites, craftSkins: { ...skins } };
  const controls = createControlState();
  const { uniform } = TSL;
  const presets = [];
  const windField = {
    sample(pos, t, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
      if (wind) out.vel.copy(wind);
      else out.vel.set(0, 0, 0);
      out.turbulence = 0;
      return out;
    },
    ambientAt: () => ({ speed: 0, fromDegrees: 0 }),
    lastLayers: { gust: new THREE.Vector3() },
  };
  const ctx = {
    THREE, TSL, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50000), state, controls, bus, world,
    uniforms: { time: uniform(0), sunDirection: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)), skyHorizonColor: uniform(new THREE.Color(1, 1, 1)), skyZenithColor: uniform(new THREE.Color(1, 1, 1)), nightFactor: uniform(0) },
    craftRegistry: registry,
    flightModels,
    settings: {
      get: (key) => {
        const value = settingsValues[key];
        if (Array.isArray(value)) return value.slice();
        return value && typeof value === 'object' ? { ...value } : value;
      },
      set(key, value) {
        settingsValues[key] = value;
        bus.emit('settings:changed', { key, value, settings: { ...settingsValues } });
        return true;
      },
      update(key, patch) {
        settingsValues[key] = { ...settingsValues[key], ...patch };
        bus.emit('settings:changed', { key, value: settingsValues[key], settings: { ...settingsValues } });
        return true;
      },
    },
    wind: windField,
    systems: { camera: { snap() {} }, input: { presetThrottle: (value) => { presets.push(value); controls.throttle = value; return true; } } },
    registerPrewarm() {},
  };
  const flight = createFlightController(ctx);
  ctx.systems.flight = flight;
  const rig = { flight, state, controls, settings: ctx.settings, settingsValues, events, bus, presets, ctx, registry };
  rig.frame = () => {
    state.frame++;
    state.time.elapsed += FRAME;
    state.time.frameDt = FRAME;
    flight.update(FRAME, FRAME);
    flight.publishTelemetry(FRAME);
  };
  rig.run = (seconds) => {
    for (let frame = 0; frame < Math.round(seconds / FRAME); frame++) rig.frame();
  };
  rig.press = (id) => {
    controls.actions.add(id);
    rig.frame();
  };
  return rig;
}

// ---- catalog ------------------------------------------------------------------------------------------
function testCatalog() {
  const ids = CRAFT_CATALOG.map((entry) => entry.id);
  check('catalog', '14 catalog craft, the Phase 1 six first', ids.length === 14 && ['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv'].every((id, index) => ids[index] === id), ids.join(', '));
  check('catalog', 'CRAFT_IDS is the catalog in order', ids.join() === CRAFT_IDS.join(), CRAFT_IDS.join(', '));
  const grouped = Object.values(CRAFT_GROUPS).flat();
  check('catalog', 'every craft in exactly one group', grouped.length === ids.length && ids.every((id) => grouped.filter((entry) => entry === id).length === 1), grouped.join(', '));
  const expected = { planes: 'glider,bushplane,aerobatic,seaplane,jet', rotor: 'helicopter,tiltrotor,fpv', human: 'wingsuit,paraglider', lighterThanAir: 'balloon,airship', creature: 'eagle', space: 'spaceplane' };
  check('catalog', 'the six groups of contract h.1, in order', Object.entries(expected).every(([group, list], index) => Object.keys(CRAFT_GROUPS)[index] === group && CRAFT_GROUPS[group].join() === list), JSON.stringify(CRAFT_GROUPS));
  check('catalog', 'every entry names its group and has a silhouette', CRAFT_CATALOG.every((entry) => CRAFT_GROUPS[entry.group].includes(entry.id) && entry.silhouette.length > 0 && entry.silhouette.every((part) => typeof part.d === 'string' && /^M/.test(part.d))));
  check('catalog', 'the Phase 1 hotkeys stay (informational), the new craft have none', CRAFT_CATALOG.slice(0, 6).every((entry, index) => entry.hotkey === `Digit${index + 1}`) && CRAFT_CATALOG.slice(6).every((entry) => entry.hotkey === null));
  // The Phase 1 six always fly; each Phase 3 craft is available exactly when its module has registered.
  const available = gameRegistry.list().filter((entry) => entry.available).map((entry) => entry.id);
  check('catalog', 'the six game modules register; a new craft is available once its module does', ['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv'].every((id) => available.includes(id)) && gameRegistry.list().every((entry) => entry.available === gameRegistry.has(entry.id)), available.join(', '));
  const groups = gameRegistry.groups();
  check('catalog', 'registry.groups() lists the groups with availability', groups.length === 6 && groups[0].label === 'Planes' && groups[0].craft.map((entry) => entry.id).join() === 'glider,bushplane,aerobatic,seaplane,jet' && groups.every((group) => group.craft.every((entry) => entry.available === gameRegistry.has(entry.id))), JSON.stringify(groups[0].craft.map((entry) => `${entry.id}:${entry.available}`)));
}

// ---- validation -----------------------------------------------------------------------------------------
function testValidation() {
  const attempt = (patch) => {
    const registry = createCraftRegistry();
    try {
      registry.register({ ...bushplane, id: 'aerobatic', ...patch });
      return 'accepted';
    } catch (error) {
      return error.message;
    }
  };
  check('validation', 'the lab test craft (every optional field) registers', attempt(testCraft) === 'accepted', attempt(testCraft));
  const cases = [
    ['an unknown ability slot', { abilities: { craftAbility: bushplane.abilities.craftAbility, craftAbilityThird: { run() {} } } }, /abilities/],
    ['an inputProfile value', { inputProfile: { ...bushplane.inputProfile, throttle: 'warp' } }, /inputProfile\.throttle/],
    ['a water landing', { limits: { ...bushplane.limits, waterLanding: 'splash' } }, /waterLanding/],
    ['a custom cockpit without build', { cameraRig: { ...bushplane.cameraRig, cockpit: { style: 'custom' } } }, /cockpit\.build/],
    ['skins whose default is not listed', { skins: { default: 'gold', list: [{ id: 'red', name: 'Red' }] } }, /skins\.default/],
    ['a copilot phrase that is not a regex', { copilot: { commands: [{ id: 'smoke', phrases: ['(unclosed'], run() {} }] } }, /not a valid regex/],
    ['a journal op', { journal: { stats: [{ key: 'labStat', label: 'Lab', unit: 'count', op: 'average' }] } }, /journal\.stats\.labStat\.op/],
    ['a director weight', { directorProfile: { favor: { tags: { water: -1 } } } }, /directorProfile\.favor\.tags\.water/],
    ['a director tag outside PRESET_TAGS', { directorProfile: { above: [{ altitude: 20000, favor: { tags: { heavy: 2 } } }] } }, /directorProfile\.above\[0\]\.favor\.tags\.heavy/],
    ['a director category outside PRESET_CATEGORIES', { directorProfile: { favor: { categories: { scenic: 2 } } } }, /directorProfile\.favor\.categories\.scenic/],
    ['a pinned HUD tile the craft does not carry', { hud: { instruments: ['nacelle'] } }, /hud\.instruments\.nacelle/],
    ['a collision probe', { collision: { probes: [{ id: 'nose', position: [0, 0], radius: 0.4 }] } }, /collision\.probes/],
    ['a capability that is not a boolean', { capabilities: { smoke: 'yes' } }, /capabilities\.smoke/],
    ['a situate that is not a function', { situate: { mode: 'air' } }, /situate/],
    ['a ceiling that is not positive', { limits: { ...bushplane.limits, ceiling: -5 } }, /limits\.ceiling/],
  ];
  for (const [label, patch, pattern] of cases) {
    const message = attempt(patch);
    check('validation', `refused: ${label}`, message !== 'accepted' && pattern.test(message) && message.startsWith('craft "aerobatic"'), message);
  }
}

// ---- favorites ------------------------------------------------------------------------------------------
function testFavorites() {
  const rig = createRig({ craft: 'glider', favorites: ['glider', null, 'jet', 'bushplane', 'aerobatic', null, null, null, null, null] });
  rig.press('craftSelect4');
  check('favorites', 'key 4 picks the craft in favorite slot 4', rig.flight.getCraft() === 'bushplane', rig.flight.getCraft());
  rig.events.notify.length = 0;
  rig.press('craftSelect2');
  check('favorites', 'an empty slot answers with a notice and keeps the craft', rig.flight.getCraft() === 'bushplane' && rig.events.notify.some((text) => /Favorite 2 is empty/.test(text)), rig.events.notify.join(' | '));
  rig.events.notify.length = 0;
  rig.press('craftSelect3');
  check('favorites', 'a favorite without its module answers with a notice', rig.flight.getCraft() === 'bushplane' && rig.events.notify.some((text) => /isn't ready to fly yet/.test(text)), rig.events.notify.join(' | '));
  rig.press('craftSelect1');
  rig.press('craftNext');
  check('favorites', 'craftNext skips the empty slot and the missing jet', rig.flight.getCraft() === 'bushplane', rig.flight.getCraft());
  rig.press('craftNext');
  check('favorites', 'craftNext reaches the next flyable favorite', rig.flight.getCraft() === 'aerobatic', rig.flight.getCraft());
  rig.press('craftNext');
  check('favorites', 'craftNext wraps past the empty slots to slot 1', rig.flight.getCraft() === 'glider', rig.flight.getCraft());
  rig.press('craftPrev');
  check('favorites', 'craftPrev wraps backwards', rig.flight.getCraft() === 'aerobatic', rig.flight.getCraft());
  rig.press('craftSelect10');
  check('favorites', 'key 0 (craftSelect10) is the tenth slot', rig.events.notify.some((text) => /Favorite 10 is empty/.test(text)));

  const empty = createRig({ craft: 'glider', favorites: [null, null, null, null, null, null, null, null, null, null] });
  empty.press('craftNext');
  check('favorites', 'with no flyable favorite, craftNext follows the catalog', empty.flight.getCraft() === 'bushplane', empty.flight.getCraft());
}

// ---- situate --------------------------------------------------------------------------------------------
function switchTo(rig, id, mode) {
  lab.situateMode = mode;
  rig.settings.set('craft', id);
  rig.frame();
}

function testSituate() {
  const rig = createRig({ craft: 'glider', wind: new THREE.Vector3(6, 0, 0) });
  rig.run(1);
  rig.presets.length = 0;
  switchTo(rig, 'aerobatic', 'climb');
  const situation = lab.lastSituation;
  check('situate', 'the situation: previous craft, height, flags, wind, track', situation && situation.previousCraft === 'glider' && Math.abs(situation.agl - (situation.position.y - GROUND)) < 1e-6 && situation.wasOnGround === false && situation.overWater === false && Math.abs(situation.wind.vel.x - 6) < 1e-9 && Number.isFinite(situation.trackHeading) && Number.isFinite(situation.groundSpeed), JSON.stringify(situation && { previousCraft: situation.previousCraft, agl: situation.agl, wind: situation.wind.vel, track: situation.trackHeading }));
  const velocity = rig.flight.getModel().state.velocity;
  check('situate', 'climb: climbing steeply at the given speed', velocity.y > 30 && rig.state.flight.craftState.armed === true, `vy ${velocity.y.toFixed(1)} m/s, speed ${velocity.length().toFixed(1)}`);
  check('situate', 'climb: full power, the soft lever preset', rig.presets.length === 1 && rig.presets[0] === 1, JSON.stringify(rig.presets));
  rig.run(3);
  check('situate', 'no soft crash after the switch', rig.events.softCrash.length === 0, JSON.stringify(rig.events.softCrash));

  switchTo(rig, 'glider', 'climb');
  const before = rig.flight.getModel().state.position.clone();
  switchTo(rig, 'aerobatic', 'hover');
  const hover = rig.flight.getModel().state;
  check('situate', 'hover: at the given place, no ground speed', hover.position.distanceTo(before) < 5 && Math.hypot(hover.velocity.x, hover.velocity.z) < 3, `moved ${hover.position.distanceTo(before).toFixed(2)} m, ${Math.hypot(hover.velocity.x, hover.velocity.z).toFixed(2)} m/s`);
  switchTo(rig, 'glider', 'climb');
  switchTo(rig, 'aerobatic', 'drift');
  const drift = rig.flight.getModel().state.velocity;
  check('situate', 'drift: moving with the air (6 m/s east)', Math.abs(drift.x - 6) < 1.5 && Math.abs(drift.z) < 1.5, `${drift.x.toFixed(2)}, ${drift.z.toFixed(2)}`);
  switchTo(rig, 'glider', 'climb');
  switchTo(rig, 'aerobatic', 'ground');
  check('situate', 'ground: standing on its gear', rig.flight.getModel().contact.onGround === true || Math.abs(rig.flight.getModel().state.position.y - GROUND) < 3, `y ${rig.flight.getModel().state.position.y.toFixed(2)}`);
  switchTo(rig, 'glider', 'climb');
  switchTo(rig, 'aerobatic', 'water');
  const afloat = rig.flight.getModel().state.position;
  check('situate', 'water: afloat on the sea at the given place', afloat.x > SEA_EAST_OF && Math.abs(afloat.y - CONFIG.WATER_LEVEL) < 3, `${afloat.x.toFixed(0)}, ${afloat.y.toFixed(2)}`);
  rig.run(2);
  check('situate', 'a basket water landing does not soft crash', rig.events.softCrash.length === 0 && rig.state.flight.onWater === true, `${rig.events.softCrash.map((crash) => crash.reason).join(', ')} onWater ${rig.state.flight.onWater}`);
  switchTo(rig, 'glider', 'climb');
  const mode = rig.flight.startAt({ mode: 'water', position: { x: 0, y: 900, z: 0 } });
  check('situate', 'water over dry ground flies instead (startAt reports air)', mode === 'air' && rig.flight.getModel().state.position.y > GROUND + 100, `${mode}, y ${rig.flight.getModel().state.position.y.toFixed(0)}`);
  switchTo(rig, 'aerobatic', 'stateOnly');
  check('situate', 'a placement without a mode keeps the Phase 1 rules and adds its craftState', rig.state.flight.craftState.stateOnly === true && rig.flight.getModel().state.velocity.length() > 30, `speed ${rig.flight.getModel().state.velocity.length().toFixed(1)}`);
  switchTo(rig, 'glider', 'climb');
  const thrown = captureErrors(() => switchTo(rig, 'aerobatic', 'throws'));
  check('situate', 'a hook that throws logs one error and the Phase 1 rules place the craft', thrown.length === 1 && /situate\(\) failed/.test(thrown[0]) && rig.flight.getCraft() === 'aerobatic' && rig.flight.getModel().state.velocity.length() > 30, thrown.join(' | '));
  switchTo(rig, 'glider', 'climb');
  const unknown = captureErrors(() => switchTo(rig, 'aerobatic', 'unknown'));
  check('situate', 'an unknown mode logs one error and falls back', unknown.length === 1 && /unknown mode "teleport"/.test(unknown[0]), unknown.join(' | '));
  let refused = '';
  try {
    rig.flight.startAt({ mode: 'air', heading: 'north' });
  } catch (error) {
    refused = error.message;
  }
  check('situate', 'startAt refuses a placement it cannot use', /heading that is not a number/.test(refused), refused);
  const stats = rig.flight.getStats();
  check('situate', 'getStats counts the calls, errors and placements', stats.situateCalls >= 8 && stats.situateErrors === 2 && stats.placements >= 6, JSON.stringify({ calls: stats.situateCalls, errors: stats.situateErrors, placements: stats.placements }));
}

// ---- carry: a flight resumed in another world (the portal ring, preset 67) ------------------------------
/** Flies a placement in a fresh rig for `seconds`, captures the flight, and resumes it in another fresh rig. */
function carryFlight(craft, placement, seconds, { wind = null, edit = null } = {}) {
  const before = createRig({ craft, modules: ['tiltrotor', 'balloon'], wind });
  before.flight.startAt(placement);
  if (edit) edit(before.state.flight.craftState);
  before.run(seconds);
  const carry = JSON.parse(JSON.stringify(before.flight.captureFlight()));
  const after = createRig({ craft, modules: ['tiltrotor', 'balloon'], wind });
  after.run(0.2);
  after.presets.length = 0;
  const mode = after.flight.resumeFlight(carry);
  return { before, after, carry, mode };
}

function testCarry() {
  // A tiltrotor in airplane mode at 110 m/s: it arrives in airplane mode, nacelles forward, at speed.
  const airplane = carryFlight('tiltrotor', { mode: 'air', position: { x: 0, y: 1500, z: 0 }, heading: 30, speed: 110, throttle: 0.62, craftState: { nacelleAngle: 0, nacelleTarget: 0, nacelleCommand: 0, mode: 'airplane' } }, 2);
  const airplaneState = airplane.after.state.flight.craftState;
  check('carry', 'captureFlight is plain data: the craft, its pose, throttle and own plain state (no nested records)', airplane.carry.craft === 'tiltrotor' && Number.isFinite(airplane.carry.pitch) && Number.isFinite(airplane.carry.throttle)
    && Number.isFinite(airplane.carry.craftState.nacelleAngle) && airplane.carry.craftState.corridor === undefined, JSON.stringify(airplane.carry.craftState));
  check('carry', 'tiltrotor in airplane mode: resumed in the air with its nacelles forward (not the boot hover angle)', airplane.mode === 'air' && Math.abs(airplaneState.nacelleAngle - airplane.carry.craftState.nacelleAngle) < 1 && airplaneState.nacelleAngle < 20,
    `mode ${airplane.mode}, nacelles ${airplane.carry.craftState.nacelleAngle.toFixed(1)} -> ${airplaneState.nacelleAngle.toFixed(1)} deg`);
  airplane.after.run(0.5);
  const airplaneSpeed = airplane.after.state.player.speed;
  check('carry', 'tiltrotor in airplane mode: at its carried airspeed and throttle', Math.abs(airplaneSpeed - airplane.carry.speed) < 8 && airplane.after.presets.length === 1 && Math.abs(airplane.after.presets[0] - airplane.carry.throttle) < 1e-9,
    `${airplane.carry.speed.toFixed(1)} -> ${airplaneSpeed.toFixed(1)} m/s, lever ${JSON.stringify(airplane.after.presets)} for ${airplane.carry.throttle.toFixed(3)}`);
  // A tiltrotor hovering at 8 m/s: its situate hook makes it hover.
  const hover = carryFlight('tiltrotor', { mode: 'hover', position: { x: 0, y: 900, z: 0 }, heading: 120, speed: 8, craftState: { nacelleAngle: 90, nacelleTarget: 90 } }, 1);
  check('carry', 'tiltrotor hovering: resumed in a hover (its situate hook), nacelles up', hover.mode === 'hover' && hover.after.state.flight.craftState.nacelleAngle > 80, `mode ${hover.mode}, nacelles ${hover.after.state.flight.craftState.nacelleAngle.toFixed(1)} deg`);
  // A balloon climbing on a hot envelope: it drifts with the air and keeps its envelope's heat.
  const balloon = carryFlight('balloon', { mode: 'drift', position: { x: 0, y: 1200, z: 0 }, heading: 0, craftState: { envelopeTemperature: 105 } }, 1, { wind: new THREE.Vector3(3, 0, 0) });
  const carriedHeat = balloon.carry.craftState.envelopeTemperature;
  balloon.after.run(0.5);
  const heat = balloon.after.state.flight.craftState.envelopeTemperature;
  const climb = balloon.after.flight.getModel().state.velocity.y;
  check('carry', 'balloon on a hot envelope: drifts (its situate hook) and keeps its heat, still climbing', balloon.mode === 'drift' && carriedHeat > 95 && Math.abs(heat - carriedHeat) < 3 && climb > 0,
    `mode ${balloon.mode}, envelope ${carriedHeat.toFixed(1)} -> ${heat.toFixed(1)} C, vy ${climb.toFixed(2)} m/s`);
  // A glider in a 20 degree climb: the attitude comes through, and its own state.
  const climbing = carryFlight('glider', { mode: 'air', position: { x: 0, y: 1500, z: 0 }, heading: 200, speed: 45, pitch: 20 }, 0.1, { edit: (craftState) => { craftState.ballast = 0.35; } });
  const pitch = climbing.after.state.player.pitch;
  check('carry', 'glider climbing: resumed at its carried pitch with its own state (ballast)', climbing.mode === 'air' && Math.abs(pitch - climbing.carry.pitch) < 2 && climbing.carry.pitch > 12 && climbing.after.state.flight.craftState.ballast === 0.35,
    `pitch ${climbing.carry.pitch.toFixed(1)} -> ${pitch.toFixed(1)} deg, ballast ${climbing.after.state.flight.craftState.ballast}`);
  // Another craft's state is not taken over, and a broken carry is refused.
  const foreign = createRig({ craft: 'glider' });
  foreign.flight.resumeFlight({ position: { x: 0, y: 1500, z: 0 }, heading: 10, speed: 40, craftState: { nacelleAngle: 30, ballast: 0.5, corridor: { min: 0 } } });
  const foreignState = foreign.state.flight.craftState;
  check('carry', "only the craft's own plain fields are taken (another craft's and nested ones are not)", foreignState.ballast === 0.5 && foreignState.nacelleAngle === undefined && foreignState.corridor === undefined, JSON.stringify(foreignState));
  let refused = '';
  try {
    foreign.flight.resumeFlight({ position: { x: 0, y: 'high', z: 0 }, heading: 10 });
  } catch (error) {
    refused = error.message;
  }
  check('carry', 'resumeFlight refuses a carry it cannot use', /resumeFlight: a position that is not/.test(refused), refused);
}

// ---- a fresh start of the craft already installed (the craft test, before each run) ---------------------
function testResetCraftState() {
  const rig = createRig({ craft: 'balloon', modules: ['balloon'], wind: new THREE.Vector3(4, 0, 0) });
  rig.flight.startAt({ mode: 'drift', position: { x: 0, y: 1200, z: 0 }, heading: 0 });
  rig.run(3);
  const craftState = rig.state.flight.craftState;
  const column = craftState.windColumn;
  craftState.burnTimer = 5;
  craftState.ventTimer = 2;
  craftState.windColumnTimer = 0.5;
  // The lab's air has no WindField to sample: the column is marked primed as a run leaves it.
  for (const band of column) band.primed = true;
  const primed = column.every((band) => band.primed);
  rig.flight.resetCraftState();
  const after = rig.state.flight.craftState;
  check('reset', 'resetCraftState: the same object, the abilities\' fields back at their start (timers, a fresh unprimed wind column)', after === craftState && primed && after.windColumn !== column && after.windColumn.every((band) => !band.primed) && after.burnTimer === 0 && after.ventTimer === 0 && after.windColumnTimer === 0,
    `primed before ${primed}, burn ${after.burnTimer}, vent ${after.ventTimer}, column ${after.windColumn === column ? 'kept' : 'fresh'}`);
  const skinned = createRig({ craft: 'aerobatic', skins: { aerobatic: 'blue' } });
  skinned.state.flight.craftState.smoke = true;
  skinned.flight.resetCraftState();
  check('reset', 'resetCraftState keeps the skin', skinned.state.flight.craftState.skin === 'blue' && skinned.state.flight.craftState.smoke === false, `skin ${skinned.state.flight.craftState.skin}, smoke ${skinned.state.flight.craftState.smoke}`);
}

// ---- abilities, commands, skins, state ---------------------------------------------------------------
function testAbilitiesAndCommands() {
  const rig = createRig({ craft: 'aerobatic', skins: { aerobatic: 'blue' } });
  check('skins', 'the mesh is built with the stored skin', lab.lastSkin === 'blue' && rig.flight.getSkin() === 'blue' && rig.state.flight.craftState.skin === 'blue', `${lab.lastSkin} / ${rig.flight.getSkin()}`);
  lab.situateMode = 'none';
  rig.run(0.5);
  const updatesBefore = { ...lab.abilityUpdates };
  rig.controls.held.add('craftAbility');
  rig.press('craftAbility');
  rig.controls.held.delete('craftAbility');
  rig.press('craftAbilityAlt');
  rig.run(1);
  check('abilities', 'Space runs craftAbility with the ability api', lab.abilityRuns.craftAbility === 1 && rig.state.flight.craftState.smoke === true && lab.apiSeen && lab.apiSeen.controls && lab.apiSeen.colliders && lab.apiSeen.waterQuery && lab.apiSeen.wind && lab.apiSeen.skin === 'blue' && lab.apiSeen.module === 'aerobatic', JSON.stringify(lab.apiSeen));
  check('abilities', 'Shift+Space runs craftAbilityAlt; both initial states merged', lab.abilityRuns.craftAbilityAlt === 1 && rig.state.flight.craftState.cycles === 1 && rig.state.flight.craftState.smokeColor === 2, JSON.stringify(rig.state.flight.craftState));
  check('abilities', 'both slots update every frame; isHeld sees the held key', lab.abilityUpdates.craftAbility - updatesBefore.craftAbility >= 60 && lab.abilityUpdates.craftAbilityAlt - updatesBefore.craftAbilityAlt >= 60 && lab.heldSeen, JSON.stringify(lab.abilityUpdates));
  check('abilities', "coloured smoke ('smokeColor') emits puffs", rig.flight.getStats().trailParticles > 20, `${rig.flight.getStats().trailParticles} puffs`);
  check('state', 'visual.craftState reaches the mesh (read only, the live craft state)', lab.lastVisualState !== null && lab.lastVisualState === rig.state.flight.craftState);
  check('state', 'state.flight.ceiling follows limits.ceiling', rig.state.flight.ceiling === 20000 && rig.flight.getCeiling() === 20000, String(rig.state.flight.ceiling));

  const reply = rig.flight.runCraftCommand('smoke', 'off');
  check('commands', 'runCraftCommand runs the command and returns its reply', reply.ok && reply.text === 'Smoke off.' && rig.state.flight.craftState.smoke === false, JSON.stringify(reply));
  check('commands', 'getCraftCommands lists the ids and phrases; getCraftStatus speaks', rig.flight.getCraftCommands().map((command) => command.id).join() === 'smoke,broken' && rig.flight.getCraftStatus() === 'Smoke off.', rig.flight.getCraftStatus());
  const missing = rig.flight.runCraftCommand('scenicCruise');
  check('commands', 'an unknown command answers { ok: false }', missing.ok === false && /no scenicCruise command/.test(missing.text), missing.text);
  let broken = null;
  const errors = captureErrors(() => { broken = rig.flight.runCraftCommand('broken'); });
  check('commands', 'a command that throws answers { ok: false } and logs once', broken.ok === false && errors.length === 1 && /copilot command "broken" failed/.test(errors[0]), errors.join(' | '));
  const handlers = createFlightActionHandlers({ bus: rig.bus, settings: rig.settings, state: rig.state, craftRegistry: rig.registry, systems: rig.ctx.systems }, {
    succeed: (text) => ({ ok: true, text }), fail: (text) => ({ ok: false, text }), pick: (key, lines) => lines[0], waiter: null, noteCopilotChange() {}, getView: () => null,
  });
  const spoken = handlers.craftCommand({ type: 'craftCommand', craft: 'aerobatic', command: 'smoke', value: 'on' });
  check('commands', "the copilot's craftCommand handler speaks the reply", spoken.ok && spoken.text === 'Smoke on.', JSON.stringify(spoken));
  const other = handlers.craftCommand({ type: 'craftCommand', craft: 'seaplane', command: 'waterRudders' });
  check('commands', 'a command for another craft is refused', other.ok === false && /for the seaplane/.test(other.text), other.text);

  const model = rig.flight.getModel();
  const position = rig.flight.getModel().state.position.clone();
  rig.settings.update('craftSkins', { aerobatic: 'red' });
  rig.frame();
  check('skins', 'a skin change rebuilds the mesh only: same model, same place', lab.lastSkin === 'red' && rig.flight.getModel() === model && rig.flight.getModel().state.position.distanceTo(position) < 5 && rig.state.flight.craftState.skin === 'red' && rig.events.skin.length === 1, `${lab.lastSkin}, moved ${rig.flight.getModel().state.position.distanceTo(position).toFixed(2)} m`);
  rig.settings.update('craftSkins', { aerobatic: 'chrome' });
  rig.frame();
  check('skins', 'an unknown skin id flies the default skin', rig.flight.getSkin() === 'red' && rig.events.skin.length === 1, rig.flight.getSkin());
}

// ---- bindings -------------------------------------------------------------------------------------------
function testBindings() {
  const storage = { read: (key, fallback) => fallback, write: () => true };
  const errors = [];
  let store = null;
  const captured = captureErrors(() => {
    store = createBindingStore({ storage, craftDefaults: (craft) => (craft === 'aerobatic' ? testCraft.bindings : null) });
    const own = store.getRefs('keyboard', 'craftAbilityAlt', 'aerobatic');
    const others = store.getRefs('keyboard', 'craftAbilityAlt', 'glider');
    check('bindings', "a module's default binding applies to its craft only", own.length === 1 && own[0].code === 'KeyK' && others.length === 1 && others[0].code === 'Space' && others[0].shift === true, `${JSON.stringify(own)} / ${JSON.stringify(others)}`);
    store.getRefs('keyboard', 'gearToggle', 'aerobatic');
  });
  errors.push(...captured);
  check('bindings', 'an invalid module reference is dropped with one error', errors.length === 1 && /craft "aerobatic" default binding for gearToggle/.test(errors[0]) && store.getRefs('keyboard', 'gearToggle', 'aerobatic').length === 0, errors.join(' | '));
  store.bind({ device: 'keyboard', target: 'craftAbilityAlt', ref: { type: 'key', code: 'KeyL' } });
  const overridden = store.getRefs('keyboard', 'craftAbilityAlt', 'aerobatic');
  check('bindings', "the player's global binding wins over the module default", overridden.length === 1 && overridden[0].code === 'KeyL', JSON.stringify(overridden));
  check('bindings', 'getDefaultRefs reports the craft default', store.getDefaultRefs('keyboard', 'craftAbilityAlt', 'aerobatic')[0]?.code === 'KeyK');
}

// ---- journal --------------------------------------------------------------------------------------------
async function testJournal() {
  globalThis.window ??= { addEventListener() {} };
  const { journalStatInfo, JOURNAL_STATS } = await import('../../src/gameplay/journal.js');
  check('journal', 'an unregistered key is unknown; the game keys are known', journalStatInfo('labBestScore') === null && journalStatInfo('stormsChased') === JOURNAL_STATS.stormsChased);
  // The game registry knows the test craft's stats once it registers (this node process only).
  gameRegistry.register(testCraft);
  const info = journalStatInfo('labBestScore');
  check('journal', "a craft module's journal.stats keys are known stats", info && info.op === 'max' && info.unit === 'points' && info.label === 'Best lab score' && info.craft === 'aerobatic', JSON.stringify(info));
}

// ---- roster (wave 2 integration) ------------------------------------------------------------------------
function testRoster() {
  const missing = CRAFT_CATALOG.filter((entry) => !gameRegistry.has(entry.id)).map((entry) => entry.id);
  check('roster', 'all 14 catalog craft have their module', missing.length === 0, missing.join(', ') || 'none missing');
  const phaseThree = CRAFT_CATALOG.slice(6).map((entry) => gameRegistry.get(entry.id)).filter(Boolean);
  check('roster', 'every Phase 3 module places itself after a switch (situate)', phaseThree.length === 8 && phaseThree.every((module) => typeof module.situate === 'function'), phaseThree.filter((module) => typeof module.situate !== 'function').map((module) => module.id).join(', '));
  // The game's lookup (createGameDirector): the module's own profile, else the director's default.
  const profileFor = (id) => gameRegistry.get(id)?.directorProfile ?? DEFAULT_DIRECTOR_PROFILES[id] ?? null;
  const weight = (id, preset, altitude = 500) => craftWeight(preset, profileFor(id), altitude);
  const tagged = (...tags) => ({ tags, category: 'geo' });
  const probes = [tagged('water'), tagged('celestial', 'farLure'), { tags: [], category: 'wildlife' }];
  const inRange = CRAFT_CATALOG.every((entry) => probes.every((preset) => {
    const value = weight(entry.id, preset, 30000);
    return value >= CRAFT_WEIGHT_RANGE.min && value <= CRAFT_WEIGHT_RANGE.max;
  }));
  check('roster', 'the director weighs every craft id inside CRAFT_WEIGHT_RANGE', inRange);
  const required = [
    ['seaplane favours water and lakes', ['water', 'lake'].every((tag) => weight('seaplane', tagged(tag)) > 1)],
    ['the eagle favours thermals, perches and murmurations', ['thermal', 'perch', 'murmuration'].every((tag) => weight('eagle', tagged(tag)) > 1)],
    ['the balloon favours calm, slow spectacles', ['calm', 'slow', 'spectacle'].every((tag) => weight('balloon', tagged(tag)) > 1)],
    ['the airship favours calm, slow spectacles', ['calm', 'slow', 'spectacle'].every((tag) => weight('airship', tagged(tag)) > 1)],
    ['the spaceplane is neutral below 20 km', weight('spaceplane', tagged('celestial'), 5000) === 1 && weight('spaceplane', { tags: [], category: 'wildlife' }, 5000) === 1],
    ['the spaceplane favours celestial and far-lure spawns above 20 km', weight('spaceplane', tagged('celestial'), 25000) > 1 && weight('spaceplane', tagged('farLure'), 25000) > 1],
    ['the spaceplane drops ground-only small spawns above 20 km', ['wildlife', 'structure', 'flightplay'].every((category) => weight('spaceplane', { tags: [], category }, 25000) < 1)],
  ];
  for (const [label, pass] of required) check('roster', `contract i.2: ${label}`, pass);
  check('roster', 'faunaThreatOf: the eagle 2.5, a craft without one the default', faunaThreatOf(gameRegistry.get('eagle')) === 2.5 && faunaThreatOf(gameRegistry.get('glider')) === DEFAULT_FAUNA_THREAT && faunaThreatOf(null) === DEFAULT_FAUNA_THREAT);
  const pinned = CRAFT_CATALOG.map((entry) => gameRegistry.get(entry.id)).filter((module) => module && module.hud);
  check('roster', 'pinned HUD tiles (hud.instruments): the tiltrotor and the balloon, each a carried instrument', pinned.map((module) => module.id).sort().join() === 'balloon,tiltrotor' && pinned.every((module) => module.hud.instruments.every((id) => module.instruments.includes(id))), pinned.map((module) => `${module.id}: ${module.hud.instruments.join('+')}`).join(', '));
}

testCatalog();
testRoster();
testValidation();
testFavorites();
testSituate();
testCarry();
testResetCraftState();
testAbilitiesAndCommands();
testBindings();
await testJournal();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} craft framework checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
