// The airship's scenic cruise: an autopilot tour through the sites around the craft.
//
// Starting it gathers the places worth seeing nearby: the event director's getNearby() (live spawns,
// dormant candidates and sites; exact site positions from the SpawnManager's site feed) and the
// v1-derived landmarks. It chains the next few (SCENIC_CRUISE.SITES) by distance and turn, aims each
// leg at a viewing point beside its site (the site passes the gondola's left windows rather than
// under the keel), picks one cruise altitude that clears the highest ground along the chain (below
// the airship's pressure height), and lays a smooth Catmull-Rom path through it (the PathFollower
// path, src/world/pathFollower.js). The airship autopilot then chases a point a little ahead along
// that path, crabbing into the wind so the ground track stays on it, and slows to a photo pace while
// photo mode is open: no beacon, no banking, no sudden turns, so it is made for photographs. Passing
// a site counts it as visited (a toast, the journal stat airshipCruiseSites) and the next leg
// starts; after the last one the cruise plans the next chain from where it is, skipping what it has
// seen. Moving the stick (the autopilot's manual override) or the autopilot key ends it.
//
// The live state is craftState.scenicCruise (contract h.3): { active, index, waypoints [{ id, name,
// x, z, aimX, aimZ }], visited, target { x, z }, altitude, speed, legs }. The path and the visited ids
// stay private, per craft state.
import { createPath } from '../world/pathFollower.js';

export const SCENIC_CRUISE = Object.freeze({
  /** Where sites are searched (km) and how many make one chain. */
  SEARCH_KM: 9,
  SITES: 3,
  /** A site closer than this to the chain's last point is skipped (it is already in view, m). */
  MIN_LEG: 700,
  /** Sites closer together than this are one place (a director site and its landmark twin, m). */
  MERGE_DISTANCE: 350,
  /** The viewing point sits this far to the right of the approach line, so the site passes on the left (m). */
  VIEW_OFFSET: 260,
  /** A site counts as visited within this horizontal distance (m), or once the path passes its viewing point. */
  VISIT_RADIUS: 650,
  /** The autopilot chases the path point this far ahead of the craft's progress (m). */
  LOOKAHEAD: 420,
  /** The progress along the path only moves forward, by at most this much per update (m): no shortcuts across a loop. */
  PROGRESS_WINDOW: 1500,
  /** Cruise altitude: this much above the highest ground near the chain (m, to the envelope's centre). */
  CLEARANCE: 170,
  /** Never closer than this to the pressure height (m): above it the airship turns heavy. */
  PRESSURE_MARGIN: 120,
  /** The ground is sampled along each leg every ALTITUDE_STEP metres, ALTITUDE_WIDTH to either side. */
  ALTITUDE_STEP: 150,
  ALTITUDE_WIDTH: 300,
  /** Each degree the chain turns costs as much as this many metres when the next site is chosen. */
  TURN_COST: 6,
  /** The cruise speed (m/s, airspeed); the autopilot slows to a photo pace in photo mode. */
  SPEED: 20,
  /** Path smoothing (points per leg). */
  PATH_SAMPLES: 16,
});

/**
 * Folds a journal statistic (journal.stats of the airship module) through the journal system; the
 * ability api has no event bus, and the journal is absent in the node labs.
 */
function recordStat(api, key, value, op) {
  const journal = api.systems ? api.systems.journal : null;
  if (journal && typeof journal.recordStat === 'function') journal.recordStat({ key, value, op });
}

/** Private runtime per craft state: { path, progress, distances, visitedIds, carrot }. */
const runtimes = new WeakMap();

/** The public cruise state a craft starts with (craftState.scenicCruise). */
export function createCruiseState() {
  return { active: false, index: 0, waypoints: [], visited: 0, legs: 0, target: { x: 0, z: 0 }, altitude: NaN, speed: SCENIC_CRUISE.SPEED, startedAt: 0 };
}

/**
 * The places worth seeing within radiusKm of (x, z): the director's nearby entries (positions from
 * the site feed when it knows them, else from the entry's distance and bearing) and the landmarks,
 * minus the ids in `skip`, one entry per place. Entry: { id, name, x, z }.
 */
export function gatherCruiseSites(systems, x, z, radiusKm, skip) {
  const sites = [];
  const spawns = systems ? systems.spawns : null;
  const director = spawns ? spawns.director : null;
  let nearby = [];
  if (director && typeof director.getNearby === 'function') nearby = director.getNearby(radiusKm);
  else if (spawns && typeof spawns.getNearby === 'function') nearby = spawns.getNearby(radiusKm);
  let feed = null;
  const manager = spawns ? spawns.manager : null;
  if (manager && typeof manager.getSiteFeed === 'function') {
    const siteFeed = manager.getSiteFeed();
    if (siteFeed && typeof siteFeed.sitesNear === 'function') feed = new Map(siteFeed.sitesNear(x, z, radiusKm * 1000).map((site) => [site.id, site]));
  }
  for (const entry of nearby) {
    if (!entry || typeof entry.id !== 'string' || skip.has(entry.id)) continue;
    const site = feed ? feed.get(entry.id) : null;
    const radians = (entry.bearing * Math.PI) / 180;
    const siteX = site ? site.x : Number.isFinite(entry.x) ? entry.x : x + Math.sin(radians) * entry.distance;
    const siteZ = site ? site.z : Number.isFinite(entry.z) ? entry.z : z - Math.cos(radians) * entry.distance;
    if (Number.isFinite(siteX) && Number.isFinite(siteZ)) sites.push({ id: entry.id, name: entry.name || 'site', x: siteX, z: siteZ });
  }
  const landmarks = systems ? systems.landmarks : null;
  if (landmarks && typeof landmarks.getNearby === 'function') {
    for (const entry of landmarks.getNearby(radiusKm * 1000)) {
      if (!entry || typeof entry.id !== 'string' || skip.has(entry.id)) continue;
      if (Number.isFinite(entry.x) && Number.isFinite(entry.z)) sites.push({ id: entry.id, name: entry.name || 'landmark', x: entry.x, z: entry.z });
    }
  }
  const merged = [];
  for (const site of sites) {
    if (!merged.some((other) => Math.hypot(other.x - site.x, other.z - site.z) < SCENIC_CRUISE.MERGE_DISTANCE)) merged.push(site);
  }
  return merged;
}

/** The viewing point beside a site, approached from (fromX, fromZ): VIEW_OFFSET to the right of the line. */
function viewingPoint(site, fromX, fromZ) {
  const dx = site.x - fromX;
  const dz = site.z - fromZ;
  const length = Math.hypot(dx, dz) || 1;
  // Right of the travel direction (x east, z south): (-dz, dx) / length.
  return { x: site.x - (dz / length) * SCENIC_CRUISE.VIEW_OFFSET, z: site.z + (dx / length) * SCENIC_CRUISE.VIEW_OFFSET };
}

/** The highest surface near the straight leg from (ax, az) to (bx, bz). */
function highestAlong(surfaceHeight, ax, az, bx, bz) {
  const length = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(length / SCENIC_CRUISE.ALTITUDE_STEP));
  const sideX = length > 0 ? -(bz - az) / length : 0;
  const sideZ = length > 0 ? (bx - ax) / length : 0;
  let highest = -Infinity;
  for (let step = 0; step <= steps; step++) {
    const share = step / steps;
    const x = ax + (bx - ax) * share;
    const z = az + (bz - az) * share;
    for (let side = -1; side <= 1; side++) {
      highest = Math.max(highest, surfaceHeight(x + sideX * side * SCENIC_CRUISE.ALTITUDE_WIDTH, z + sideZ * side * SCENIC_CRUISE.ALTITUDE_WIDTH));
    }
  }
  return highest;
}

/**
 * Plans a chain from (x, z) heading `heading` (deg) through up to SITES of `sites`: greedy on
 * distance plus TURN_COST per degree of turn, every leg at least MIN_LEG, every leg's ground clear
 * below `ceiling` (the pressure height minus its margin). Returns { waypoints, altitude } (waypoints
 * empty when nothing fits).
 */
export function planCruise(sites, { x, z, heading, surfaceHeight, ceiling, floor = -Infinity }) {
  const waypoints = [];
  const used = new Set();
  let fromX = x;
  let fromZ = z;
  let direction = heading;
  let highest = surfaceHeight(x, z);
  while (waypoints.length < SCENIC_CRUISE.SITES) {
    let best = null;
    let bestCost = Infinity;
    for (const site of sites) {
      if (used.has(site.id)) continue;
      const distance = Math.hypot(site.x - fromX, site.z - fromZ);
      if (distance < SCENIC_CRUISE.MIN_LEG) continue;
      const bearing = (Math.atan2(site.x - fromX, -(site.z - fromZ)) * 180) / Math.PI;
      const turn = Math.abs(((((bearing - direction + 180) % 360) + 360) % 360) - 180);
      const cost = distance + turn * SCENIC_CRUISE.TURN_COST;
      if (cost >= bestCost) continue;
      const aim = viewingPoint(site, fromX, fromZ);
      const legHighest = highestAlong(surfaceHeight, fromX, fromZ, aim.x, aim.z);
      if (Math.max(legHighest, highest) + SCENIC_CRUISE.CLEARANCE > ceiling) continue;
      best = { site, aim, legHighest, bearing };
      bestCost = cost;
    }
    if (!best) break;
    used.add(best.site.id);
    highest = Math.max(highest, best.legHighest);
    waypoints.push({ id: best.site.id, name: best.site.name, x: best.site.x, z: best.site.z, aimX: best.aim.x, aimZ: best.aim.z });
    direction = best.bearing;
    fromX = best.aim.x;
    fromZ = best.aim.z;
  }
  const altitude = Math.min(ceiling, Math.max(floor, highest + SCENIC_CRUISE.CLEARANCE));
  return { waypoints, altitude };
}

/** Lays the path (start, then each viewing point) and the distance of each viewing point along it. */
function layPath(runtime, startX, startZ, plan) {
  const points = new Float64Array((plan.waypoints.length + 1) * 3);
  points[0] = startX;
  points[1] = plan.altitude;
  points[2] = startZ;
  plan.waypoints.forEach((waypoint, index) => {
    points[(index + 1) * 3] = waypoint.aimX;
    points[(index + 1) * 3 + 1] = plan.altitude;
    points[(index + 1) * 3 + 2] = waypoint.aimZ;
  });
  runtime.path = createPath({ points, smoothing: 'catmullRom', samplesPerSegment: SCENIC_CRUISE.PATH_SAMPLES });
  runtime.progress = 0;
  runtime.distances = plan.waypoints.map((waypoint) => runtime.path.nearestDistance(waypoint.aimX, plan.altitude, waypoint.aimZ));
}

/** The pressure height the cruise stays under, from the craft state (the model keeps it). */
function cruiseCeiling(api) {
  const pressureHeight = api.craftState.pressureHeight;
  const height = Number.isFinite(pressureHeight) ? pressureHeight : 2400;
  return height - SCENIC_CRUISE.PRESSURE_MARGIN;
}

/**
 * Plans the next chain from the craft's position into the cruise state and the runtime. Returns the
 * number of waypoints planned (0 when no site in range fits).
 */
function planFromHere(api, cruise, runtime) {
  const position = api.player.position;
  let sites;
  try {
    sites = gatherCruiseSites(api.systems, position.x, position.z, SCENIC_CRUISE.SEARCH_KM, runtime.visitedIds);
  } catch (error) {
    console.error('[DRIFTWING] the scenic cruise could not read the nearby sites', error);
    return 0;
  }
  const surfaceHeight = (x, z) => {
    const ground = api.world.groundHeight(x, z);
    const water = api.waterQuery && typeof api.waterQuery.heightAt === 'function' ? api.waterQuery.heightAt(x, z) : -Infinity;
    return Math.max(ground, Number.isFinite(water) ? water : -Infinity);
  };
  const plan = planCruise(sites, { x: position.x, z: position.z, heading: api.telemetry.heading, surfaceHeight, ceiling: cruiseCeiling(api) });
  if (plan.waypoints.length === 0) return 0;
  layPath(runtime, position.x, position.z, plan);
  cruise.waypoints = plan.waypoints;
  cruise.index = 0;
  cruise.altitude = Math.round(plan.altitude);
  cruise.legs++;
  return plan.waypoints.length;
}

function describeChain(waypoints) {
  const names = waypoints.map((waypoint) => waypoint.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Starts the cruise: plans a chain and engages the autopilot. Returns the reply / toast text. */
export function startCruise(api) {
  const craftState = api.craftState;
  const cruise = craftState.scenicCruise;
  const runtime = { path: null, progress: 0, distances: [], visitedIds: new Set(), carrot: { x: 0, y: 0, z: 0 } };
  if (api.telemetry.onGround) return 'Lift off first: the scenic cruise starts in the air.';
  if (planFromHere(api, cruise, runtime) === 0) return 'Nothing to see within reach from here. Try somewhere else.';
  runtimes.set(craftState, runtime);
  cruise.active = true;
  cruise.visited = 0;
  cruise.startedAt = api.state.time.elapsed;
  cruise.speed = SCENIC_CRUISE.SPEED;
  updateTarget(api, cruise, runtime);
  api.setAutopilot({ enabled: true, followWaypoint: false, altitude: cruise.altitude, speed: cruise.speed, heading: api.telemetry.heading, reason: 'scenic cruise' });
  return `Scenic cruise: ${describeChain(cruise.waypoints)}. Sit back.`;
}

/** Ends the cruise; with `releaseAutopilot` the autopilot goes off too. Returns the reply / toast text. */
export function stopCruise(api, releaseAutopilot, text = 'Scenic cruise off.') {
  const cruise = api.craftState.scenicCruise;
  const wasActive = cruise.active;
  cruise.active = false;
  runtimes.delete(api.craftState);
  if (wasActive) recordStat(api, 'airshipLongestCruise', Math.round(api.state.time.elapsed - cruise.startedAt), 'max');
  if (wasActive && api.player.autopilot.enabled) {
    // Released, or left holding the heading and height the cruise had reached.
    if (releaseAutopilot) api.setAutopilot({ enabled: false, reason: 'scenic cruise' });
    else api.setAutopilot({ heading: api.telemetry.heading, altitude: api.player.position.y, reason: 'scenic cruise' });
  }
  return text;
}

/** Moves the progress along the path forward and puts the chase point LOOKAHEAD ahead of it. */
function updateTarget(api, cruise, runtime) {
  const position = api.player.position;
  const nearest = runtime.path.nearestDistance(position.x, cruise.altitude, position.z);
  if (nearest > runtime.progress && nearest < runtime.progress + SCENIC_CRUISE.PROGRESS_WINDOW) runtime.progress = nearest;
  runtime.path.sampleAt(Math.min(runtime.progress + SCENIC_CRUISE.LOOKAHEAD, runtime.path.length), runtime.carrot);
  // Past the last viewing point the chase point would stop: carry it on along the last leg.
  const remaining = runtime.progress + SCENIC_CRUISE.LOOKAHEAD - runtime.path.length;
  if (remaining > 0) {
    const last = cruise.waypoints[cruise.waypoints.length - 1];
    const from = cruise.waypoints.length > 1 ? cruise.waypoints[cruise.waypoints.length - 2] : null;
    const dx = last.aimX - (from ? from.aimX : position.x);
    const dz = last.aimZ - (from ? from.aimZ : position.z);
    const length = Math.hypot(dx, dz) || 1;
    runtime.carrot.x += (dx / length) * remaining;
    runtime.carrot.z += (dz / length) * remaining;
  }
  cruise.target.x = runtime.carrot.x;
  cruise.target.z = runtime.carrot.z;
}

/**
 * Every frame while the cruise flies: ends it when the autopilot was taken away, counts the sites
 * passed, plans the next chain after the last, and moves the chase point.
 */
export function updateCruise(api) {
  const craftState = api.craftState;
  const cruise = craftState.scenicCruise;
  if (!cruise || !cruise.active) return;
  const runtime = runtimes.get(craftState);
  if (!runtime || !runtime.path) {
    stopCruise(api, false);
    return;
  }
  if (!api.player.autopilot.enabled) {
    api.notify(stopCruise(api, false, 'Scenic cruise off: you have the controls.'));
    return;
  }
  updateTarget(api, cruise, runtime);
  const waypoint = cruise.waypoints[cruise.index];
  if (!waypoint) return;
  const position = api.player.position;
  const offX = position.x - waypoint.x;
  const offZ = position.z - waypoint.z;
  const near = offX * offX + offZ * offZ < SCENIC_CRUISE.VISIT_RADIUS * SCENIC_CRUISE.VISIT_RADIUS;
  const passed = runtime.progress >= runtime.distances[cruise.index] - 1;
  if (!near && !passed) return;
  runtime.visitedIds.add(waypoint.id);
  cruise.visited++;
  cruise.index++;
  recordStat(api, 'airshipCruiseSites', 1, 'add');
  if (cruise.index < cruise.waypoints.length) {
    api.notify(`Scenic cruise: the ${waypoint.name} off the left windows. Next, the ${cruise.waypoints[cruise.index].name}.`);
    return;
  }
  const planned = planFromHere(api, cruise, runtime);
  if (planned === 0) {
    api.notify(stopCruise(api, false, `Scenic cruise: the ${waypoint.name}, and that's everything in reach. The autopilot holds this heading.`));
    return;
  }
  updateTarget(api, cruise, runtime);
  api.notify(`Scenic cruise: the ${waypoint.name}. On to the ${describeChain(cruise.waypoints)}.`);
}
