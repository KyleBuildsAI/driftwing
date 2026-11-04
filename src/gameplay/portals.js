// PORTALS (preset 67, the portal ring): flying through a ring's membrane takes the player into the
// next world. The structure engine sends the bus event 'structure:portal' { portalId, ... } when a gate
// with action 'portal' is crossed; this system then:
//   1. derives the world it leads to: new seed = portalSeed(currentSeed, portalId) (src/core/seed.js),
//      deterministic, so a portal always opens onto the same world from the same world;
//   2. keeps the flight for the arrival: the craft (and its skin and every setting, which persist on
//      their own), the position over the ground, the height above it, the heading and the airspeed,
//      in sessionStorage (PORTAL_ARRIVAL_KEY), and the time of day in the world link;
//   3. sends the typed 'worldVisited' { seed, previous, portalId } (the journal records the world at
//      once) and fades the screen into the portal's light;
//   4. opens the new world through the seed links (src/ui/seedLinks.js): the URL hash and query update
//      (#seed=NEW&t=...), inside the launcher shell through its bridge, and the page reloads.
// On the new world's first frame (bus 'game:ready') a pending arrival for this seed puts the craft
// back exactly as it left (flight.startAt), the light fades out and a toast names the world.
//
// No per-frame work: the fades are CSS transitions and the reload a single timer. Errors are explicit:
// storage the browser refuses still lets the player through, with a notice that the flight could not
// be carried.
import { portalSeed } from '../core/seed.js';

/** sessionStorage key of the flight carried through a portal (read once by the next world). */
export const PORTAL_ARRIVAL_KEY = 'driftwing-v2.portalArrival';
/** The fade into the portal's light before the reload (ms). */
const TRAVEL_FADE_MS = 1400;
/** The fade out of it on arrival (ms). */
const ARRIVAL_FADE_MS = 1800;
/** An arrival older than this (ms) is stale (a tab restored later) and ignored. */
const ARRIVAL_MAX_AGE_MS = 10 * 60 * 1000;
const SEED_PATTERN = /^[A-Z0-9-]{1,24}$/;
const FADE_LIGHT = 'radial-gradient(circle at 50% 50%, #fbf6ff 0%, #b9a6ff 30%, #5a3fb8 68%, #160d33 100%)';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createPortalSystem(ctx) {
  const { bus, state } = ctx;
  const counters = { travels: 0, arrivals: 0, carryFailures: 0 };
  let travel = null;
  let arrived = null;

  /** The full-screen light the player passes through (above the HUD, below nothing). */
  const overlay = document.createElement('div');
  overlay.className = 'portal-fade';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = `position:fixed;inset:0;z-index:9000;pointer-events:none;background:${FADE_LIGHT};opacity:0;transition:opacity ${TRAVEL_FADE_MS}ms ease-in;`;
  document.body.append(overlay);

  function notify(text, kind) {
    bus.emit('notify', { text, kind });
  }

  /** The flight to carry: where the craft is over the ground, how high above it, its heading and speed. */
  function captureFlight(destination, portalId) {
    const player = state.player;
    const agl = isFiniteNumber(player.agl) ? player.agl : 120;
    const speed = isFiniteNumber(player.speed) ? player.speed : 0;
    return {
      seed: destination,
      from: state.seed,
      portalId,
      craft: ctx.systems.flight && typeof ctx.systems.flight.getCraft === 'function' ? ctx.systems.flight.getCraft() : ctx.settings.get('craft'),
      x: player.position.x,
      z: player.position.z,
      agl: Math.max(0, agl),
      heading: isFiniteNumber(player.heading) ? player.heading : 0,
      speed,
      onGround: agl < 3 && speed < 15,
      at: Date.now(),
    };
  }

  /** Writes the carried flight; false (and a notice) when the browser refuses session storage. */
  function storeArrival(carry) {
    try {
      window.sessionStorage.setItem(PORTAL_ARRIVAL_KEY, JSON.stringify(carry));
      return true;
    } catch (error) {
      counters.carryFailures++;
      notify(`This browser would not keep your flight for the portal (${error.name}): you will start the new world from its usual spot.`, 'warning');
      return false;
    }
  }

  /** The arrival waiting for this world (removed as it is read), or null. */
  function takeArrival() {
    let text = null;
    try {
      text = window.sessionStorage.getItem(PORTAL_ARRIVAL_KEY);
      if (text !== null) window.sessionStorage.removeItem(PORTAL_ARRIVAL_KEY);
    } catch (error) {
      counters.carryFailures++;
      notify(`This browser would not hand over the flight from the portal (${error.name}).`, 'warning');
      return null;
    }
    if (text === null) return null;
    let carry = null;
    try {
      carry = JSON.parse(text);
    } catch (error) {
      counters.carryFailures++;
      notify('The flight carried through the portal could not be read, so the new world starts from its usual spot.', 'warning');
      return null;
    }
    const valid = carry && typeof carry === 'object' && SEED_PATTERN.test(carry.seed ?? '') && SEED_PATTERN.test(carry.from ?? '')
      && ['x', 'z', 'agl', 'heading', 'speed', 'at'].every((field) => isFiniteNumber(carry[field]));
    if (!valid || carry.seed !== state.seed || Date.now() - carry.at > ARRIVAL_MAX_AGE_MS) return null;
    return carry;
  }

  /**
   * Goes through the portal portalId: the next world's seed, the carried flight, worldVisited, the fade
   * and the reload. Returns { seed, previous, portalId, carried } or null when a crossing is already
   * under way.
   */
  function travelThrough(portalId) {
    if (travel !== null || typeof portalId !== 'string' || portalId.length === 0) return null;
    const seed = portalSeed(state.seed, portalId);
    const carry = captureFlight(seed, portalId);
    const carried = storeArrival(carry);
    travel = { seed, previous: state.seed, portalId, carried, startedAt: performance.now() };
    counters.travels++;
    bus.emitTyped('worldVisited', { seed, previous: state.seed, portalId });
    notify(`Through the portal: world ${seed}.`, 'info');
    overlay.style.transition = `opacity ${TRAVEL_FADE_MS}ms ease-in`;
    overlay.style.opacity = '1';
    const dayTime = state.time.dayTime;
    window.setTimeout(() => {
      const seedLinks = ctx.systems.ui && ctx.systems.ui.seedLinks;
      if (!seedLinks || typeof seedLinks.openWorld !== 'function' || !seedLinks.openWorld(seed, dayTime)) {
        console.error(`[DRIFTWING] portal: could not open world ${seed}`);
        overlay.style.opacity = '0';
        travel = null;
      }
    }, TRAVEL_FADE_MS);
    return { seed, previous: travel.previous, portalId, carried };
  }

  /** The new world's first frame: put the craft back as it left the old one, then fade the light out. */
  function arrive() {
    const carry = pending;
    pending = null;
    if (!carry) return;
    const flight = ctx.systems.flight;
    const ground = Math.max(ctx.world.groundHeight(carry.x, carry.z), ctx.world.WATER_LEVEL);
    try {
      flight.startAt({
        mode: carry.onGround ? 'ground' : 'air',
        position: { x: carry.x, y: ground + Math.max(carry.onGround ? 0 : 30, carry.agl), z: carry.z },
        heading: carry.heading,
        speed: carry.speed,
      });
    } catch (error) {
      console.error('[DRIFTWING] portal: the craft could not be placed on arrival', error);
    }
    counters.arrivals++;
    arrived = { seed: carry.seed, from: carry.from, portalId: carry.portalId, craft: carry.craft };
    notify(`World ${carry.seed}: you came through the portal from world ${carry.from}.`, 'success');
    overlay.style.transition = `opacity ${ARRIVAL_FADE_MS}ms ease-out`;
    overlay.style.opacity = '0';
  }

  // An arrival for this world: the light is up from the first frame and fades once the world is ready.
  let pending = takeArrival();
  if (pending) {
    overlay.style.transition = 'none';
    overlay.style.opacity = '1';
  }
  bus.on('structure:portal', (payload) => {
    if (payload && typeof payload.portalId === 'string') travelThrough(payload.portalId);
  });
  bus.on('game:ready', arrive);

  return {
    /** Goes through a portal (also the debugger's and the tests' way in): see travelThrough. */
    travel: travelThrough,
    /** The world this portal id leads to from the current world (no travel). */
    destination(portalId) {
      return portalSeed(state.seed, portalId);
    },
    getState() {
      return {
        travelling: travel ? { ...travel } : null,
        arrived: arrived ? { ...arrived } : null,
        pending: pending ? { seed: pending.seed, from: pending.from } : null,
        ...counters,
      };
    },
    dispose() {
      overlay.remove();
    },
  };
}
