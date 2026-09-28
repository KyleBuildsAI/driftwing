import { assistWeights } from '../flight/assists.js';
import { nextAssistLevel } from './grammar.js';
import { craftCapabilities } from './flightState.js';

/**
 * Executor for WREN's v2 aircraft actions. Every handler changes things only through the public
 * channels (settings for craft and assists; 'input:action' events with source 'copilot' for
 * views, engine and chute; the flight controller's relaunch(); 'ui:openControls' for calibration)
 * and then reports what actually happened: it reads the outcome back, waiting a few frames where the
 * change lands on a later physics tick or camera update, and never claims a change it cannot see.
 */

/** How long to wait for an outcome that lands on a later frame (real seconds). */
const OUTCOME_TIMEOUT_SECONDS = 1.2;
const VIEW_ACTIONS = Object.freeze({ cockpit: 'viewForward', chase: 'viewBack' });
/** Views that count as "cockpit" for a craft: the FPV drone's first-person view is its cockpit. */
const FIRST_PERSON_VIEWS = new Set(['cockpit', 'fpv']);

/**
 * Resolves conditions that become true on a later frame: wait(check, seconds) resolves true as soon
 * as check() holds (tested now and on every update()), or false after the timeout. The timeout runs
 * on a wall-clock timer so a hidden tab cannot leave a question hanging.
 */
export function createOutcomeWaiter() {
  const waiters = new Set();

  function settle(waiter, value) {
    if (!waiters.has(waiter)) return;
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  return {
    wait(check, seconds = OUTCOME_TIMEOUT_SECONDS) {
      return new Promise((resolve) => {
        const waiter = { check, resolve, timer: 0 };
        waiters.add(waiter);
        waiter.timer = setTimeout(() => settle(waiter, false), seconds * 1000);
        if (check()) settle(waiter, true);
      });
    },
    update() {
      for (const waiter of [...waiters]) {
        if (waiter.check()) settle(waiter, true);
      }
    },
    get pending() {
      return waiters.size;
    },
  };
}

/** True when anything subscribes to an untyped bus event (the UI owner of 'ui:openControls'). */
function hasListeners(bus, type) {
  const listeners = bus.listeners instanceof Map ? bus.listeners.get(type) : null;
  return Boolean(listeners && listeners.size > 0);
}

/** "the bush plane", "the FPV drone": a catalog name as a noun phrase. */
function craftPhrase(registry, id) {
  const entry = registry?.catalog?.find((candidate) => candidate.id === id);
  const name = entry ? entry.name : id;
  return `the ${/^[A-Z]{2,}/.test(name) ? name : name.toLowerCase()}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a, b and c". */
function listPhrase(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Handlers for the v2 action types. helpers: { succeed(text, informative), fail(text), pick(key,
 * lines), waiter, noteCopilotChange(kind), getView() }. Each returns { ok, text, informative } or a
 * promise of it.
 */
export function createFlightActionHandlers(ctx, helpers) {
  const { bus, settings, state } = ctx;
  const registry = ctx.craftRegistry;
  const { succeed, fail, pick, waiter, noteCopilotChange, getView } = helpers;
  const flight = () => ctx.systems.flight;
  const craftName = (id) => craftPhrase(registry, id);

  /** One press and release of an input action, published like any device would. */
  function emitInputAction(id) {
    bus.emit('input:action', { id, phase: 'press', source: 'copilot', device: 'copilot' });
    bus.emit('input:action', { id, phase: 'release', source: 'copilot', device: 'copilot' });
  }

  function installedCraft() {
    return registry?.list ? registry.list().filter((entry) => entry.available).map((entry) => craftName(entry.id)) : [];
  }

  function activeModule() {
    const system = flight();
    return typeof system?.getCraftModule === 'function' ? system.getCraftModule() : null;
  }

  /** What the assists do at a level, with partial ones marked. */
  function assistSummary(level, modelKind) {
    const weights = assistWeights(level, modelKind);
    const names = { coordination: 'auto-coordination', autoTrim: 'auto-trim', stallWarning: 'stall warning', aoaLimiter: 'AoA limiter', gLimiter: 'G limiter', autoLevel: 'auto-level', pathHold: 'flight-path hold', bankProtection: 'bank protection', pitchProtection: 'pitch protection', overspeedProtection: 'overspeed protection', autoHover: 'auto-hover', headingHold: 'heading hold', angleMode: 'angle mode', altitudeHold: 'altitude hold' };
    const full = [];
    const partial = [];
    for (const [key, weight] of Object.entries(weights)) {
      if (!(weight > 0)) continue;
      const name = names[key] ?? key;
      if (weight >= 0.99) full.push(name);
      else partial.push(name);
    }
    if (full.length === 0 && partial.length === 0) return 'raw physics, nothing between you and the air. Stalls and spins are yours to fly';
    let text = full.length ? listPhrase(full) : '';
    if (partial.length) text += `${text ? ', with ' : ''}${listPhrase(partial)} at part strength`;
    return text;
  }

  return {
    setCraft(action) {
      const system = flight();
      if (typeof system?.getCraft !== 'function') return fail("The flight controller isn't answering right now.");
      const target = action.craft;
      const current = system.getCraft();
      if (current === target) return succeed(`We're already flying ${craftName(target)}.`);
      if (!registry?.has?.(target)) {
        const available = installedCraft();
        const offer = available.length ? ` Right now we can fly ${listPhrase(available)}.` : '';
        return fail(pick('craftMissing', [
          `${capitalize(craftName(target))} isn't in this hangar yet.${offer}`,
          `Sorry, ${craftName(target)} hasn't arrived in this build.${offer}`,
        ]));
      }
      noteCopilotChange('craft');
      settings.set('craft', target);
      const now = system.getCraft();
      if (now !== target) return fail(`${capitalize(craftName(target))} didn't take, so we're still in ${craftName(now)}.`);
      return succeed(pick(`craft-${target}`, [`${capitalize(craftName(target))} it is.`, `Switched to ${craftName(target)}.`]));
    },

    setAssists(action) {
      const system = flight();
      const craft = typeof system?.getCraft === 'function' ? system.getCraft() : state.flight.craft;
      const current = settings.get('assists')?.[craft];
      const before = Number.isFinite(current) ? current : 1;
      const next = action.change ? nextAssistLevel(before, action.change) : action.level;
      const percent = Math.round(next * 100);
      const module = activeModule();
      const modelKind = module?.simProfile?.model ?? 'fixedWing';
      if (Math.abs(next - before) < 0.005) {
        const edge = action.change === 'up' ? ' That is the maximum.' : action.change === 'down' ? ' That is as low as they go.' : '';
        return succeed(`Assists are already at ${percent} percent for ${craftName(craft)}.${edge}`, true);
      }
      if (!settings.update('assists', { [craft]: next })) return fail("I couldn't change the assists just now.");
      let text = `Assists at ${percent} percent for ${craftName(craft)}: ${assistSummary(next, modelKind)}.`;
      if (system?.isAssistOverridden?.()) text += ' A controller is disconnected, so the hands-off hold keeps them at 100 percent for now.';
      return succeed(text, true);
    },

    async setView(action) {
      const wanted = action.view;
      const current = getView();
      const matches = (view) => (wanted === 'cockpit' ? FIRST_PERSON_VIEWS.has(view) : view === wanted);
      if (current && matches(current.view)) return succeed(wanted === 'cockpit' ? "We're already in the cockpit view." : "We're already in the chase view.");
      const serialBefore = current ? current.serial : 0;
      emitInputAction(VIEW_ACTIONS[wanted]);
      const switched = await waiter.wait(() => {
        const view = getView();
        return Boolean(view && view.serial !== serialBefore && matches(view.view));
      });
      if (!switched) return fail(`The camera didn't move to the ${wanted} view. That view isn't available here.`);
      const view = getView().view;
      if (wanted === 'cockpit') return succeed(view === 'fpv' ? 'FPV camera.' : pick('viewCockpit', ['Cockpit view.', 'In the cockpit. Instruments are live.']));
      return succeed(pick('viewChase', ['Chase view.', 'Back outside, chase view.']));
    },

    async deployChute() {
      const module = activeModule();
      const craft = flight()?.getCraft?.() ?? state.flight.craft;
      if (!craftCapabilities(module).chute) return fail(pick('noChute', [`No chute on ${craftName(craft)}.`, `${capitalize(craftName(craft))} doesn't carry a parachute.`]));
      const canopyOpen = () => Boolean(state.flight.craftState && state.flight.craftState.canopy);
      if (canopyOpen()) return succeed('The canopy is already open.');
      emitInputAction('chuteDeploy');
      if (await waiter.wait(canopyOpen)) return succeed(pick('chuteOpen', ['Canopy open. Steer with the stick and flare before the ground.', 'Chute out, nice and square.']));
      return fail("I pulled the handle, but there's no canopy yet.");
    },

    async engine(action) {
      const system = flight();
      const module = activeModule();
      const craft = system?.getCraft?.() ?? state.flight.craft;
      if (!craftCapabilities(module).engine) {
        return fail(pick('noEngine', [`${capitalize(craftName(craft))} has no engine. We fly on lift alone.`, `No engine on ${craftName(craft)}; the sky does the work.`]));
      }
      const running = () => state.flight.engineOn !== false;
      const word = action.enabled ? 'running' : 'off';
      if (running() === action.enabled) return succeed(`The engine's already ${word}.`);
      emitInputAction('engineToggle');
      const done = await waiter.wait(() => running() === action.enabled);
      if (!done) return fail(`The engine didn't respond. It's still ${running() ? 'running' : 'off'}.`);
      if (action.enabled) return succeed(pick('engineOn', ['Engine running.', "She's caught. Engine running."]));
      return succeed(pick('engineOff', ['Engine off. Best glide speed now, and pick a field.', 'Engine off. Quiet, isn\'t it?']));
    },

    relaunch() {
      const system = flight();
      if (typeof system?.relaunch !== 'function') return fail("I can't relaunch right now.");
      const module = activeModule();
      const method = module?.spawn?.relaunch ?? 'airstart';
      if (system.isTowing?.()) return fail("We're already on tow.");
      if (state.flight.crash?.active) return fail("Hang on, we're resetting already.");
      const agl = state.flight.agl;
      if (!system.relaunch()) {
        if (method === 'aerotow' && Number.isFinite(agl) && agl >= 900) return fail("We're already above tow height, no tow needed.");
        return fail("I couldn't relaunch just now.");
      }
      if (method === 'aerotow') return succeed(pick('relaunchTow', ['Hooking up to the tow plane. It will pull us to 1000 metres and let go.', 'Tow plane is on the way. Release at 1000 metres.']));
      if (method === 'peak') return succeed('Off to the nearest high peak.');
      return succeed(pick('relaunchAir', ['Back in the air, 300 metres up.', 'Airstart. We are 300 metres up again.']));
    },

    calibrate() {
      if (!hasListeners(bus, 'ui:openControls')) {
        return fail('The controls panel is not available in this build, so I cannot open the calibration wizard.');
      }
      bus.emit('ui:openControls', { calibrate: true });
      const devices = typeof ctx.systems.input?.getDevices === 'function' ? ctx.systems.input.getDevices() : [];
      if (!Array.isArray(devices) || devices.length === 0) {
        return succeed('Opening the controls panel. Press any button on your stick and throttle so I can see them, then we calibrate.');
      }
      return succeed('Opening the calibration wizard. Center everything first, and keep your feet off the pedals.');
    },
  };
}

/**
 * The live key for an action on the keyboard (rebinding aware), or the fallback label.
 */
export function keyFor(ctx, actionId, fallback) {
  const input = ctx.systems.input;
  const bindings = input?.bindings;
  if (typeof bindings?.getRefs !== 'function' || typeof input.describeRef !== 'function') return fallback;
  try {
    const craft = typeof ctx.systems.flight?.getCraft === 'function' ? ctx.systems.flight.getCraft() : null;
    const refs = bindings.getRefs('keyboard', actionId, craft);
    if (!Array.isArray(refs) || refs.length === 0) return fallback;
    return input.describeRef(refs[0], 'keyboard');
  } catch (error) {
    console.error(`[DRIFTWING] WREN could not read the binding for ${actionId}`, error);
    return fallback;
  }
}

/** The "what can you do" answer, with the keys and UI that do the same thing. */
export function helpLine(ctx, pick) {
  const key = (actionId, fallback) => keyFor(ctx, actionId, fallback);
  const flying = `Aircraft: 'switch to the bush plane' (1-6, picker), 'assists up' (settings), 'cockpit view' (${key('viewForward', 'Num 8')}), 'engine off' (${key('engineToggle', 'Z')}), 'deploy chute' (${key('chuteDeploy', 'U')}), 'relaunch' (${key('relaunch', 'Backspace')}), 'calibrate controls' (${key('controlsPanel', '.')}), 'airspeed', 'how was my landing'. Hold ${key('copilotPTT', '`')} to talk.`;
  return pick('help', [
    `I find places, set waypoints, fly the autopilot, change the time and run ring courses. ${flying}`,
    `Try 'find mountains', 'set a waypoint' or 'make it dusk'. ${flying}`,
  ]);
}
