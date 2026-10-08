// Typed game events: the stable contract later phases subscribe to (the event director, replay,
// multiplayer and the copilot all listen here instead of reaching into systems).
//
// Every typed event has a payload shape. In development builds (and with ?debug=1) each emit is
// checked against its shape so a producer that drifts is caught at the source. Untyped events
// (the v1 'namespace:verb' ones) pass through the same EventBus unchanged.

/** Field types understood by the validator. */
const FIELD_CHECKS = Object.freeze({
  string: (value) => typeof value === 'string',
  number: (value) => Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  object: (value) => value !== null && typeof value === 'object',
  vector3: (value) => value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z),
  /** Any value except undefined (identifiers whose form belongs to their producer). */
  defined: (value) => value !== undefined,
});

export const LANDING_GRADES = Object.freeze(['butter', 'smooth', 'firm', 'hard']);
/** How a spawn exists: a persistent place, or a temporary happening. */
export const SPAWN_KINDS = Object.freeze(['site', 'event']);
/** The regional weather cycle, in order (src/spawns/weather.js). */
export const WEATHER_STATES = Object.freeze(['clear', 'building', 'storm', 'clearing']);
/** How a journalStat value folds into its record. */
export const JOURNAL_STAT_OPS = Object.freeze(['min', 'max', 'add']);

/**
 * Event name -> payload fields. A field is a FIELD_CHECKS type name, an array of allowed values, or
 * an object { type, optional: true }.
 */
export const EVENT_TYPES = Object.freeze({
  /** A different craft is now flying. */
  craftChanged: { craft: 'string', previous: 'string' },
  /**
   * Touchdown graded by sink rate (m/s, positive down) and side load. surface (optional, 'ground' when
   * absent): what it touched down on; a floating craft's touchdown on water is graded the same way.
   */
  landed: { grade: LANDING_GRADES, craft: 'string', sinkRate: 'number', groundSpeed: 'number', position: 'vector3', surface: { type: ['ground', 'water', 'structure', 'perch'], optional: true } },
  /** Terrain or water impact handled by fade and respawn. */
  softCrash: { craft: 'string', reason: 'string', impactSpeed: 'number', position: 'vector3' },
  /**
   * The craft touched a solid collider (src/world/colliders.js): speed is the impact speed into the
   * surface (m/s, relative to a moving collider), crashed whether it was over the craft's
   * bodyStrikeSpeed (a soft crash 'structure strike' follows), surface the collider's surface tag.
   */
  colliderHit: { id: 'string', owner: 'string', craft: 'string', speed: 'number', normal: 'vector3', position: 'vector3', crashed: 'boolean', surface: 'string' },
  /** The craft entered a sensor collider (a kite string): a miss for a challenge, never a crash. */
  colliderSensor: { id: 'string', owner: 'string', tag: 'string', craft: 'string', position: 'vector3' },
  /**
   * First sight of a landmark or a spawn in this world. For spawns, kind is the preset category, id
   * is the site id (sites) or the preset id (events), and presetId names the preset.
   */
  discovery: { id: 'string', name: 'string', kind: 'string', position: 'vector3', presetId: { type: 'string', optional: true } },
  /** A wind source joined or left the WindField (Phase 2 spawns publish these). */
  windSourceAdded: { id: 'string', kind: 'string', position: 'vector3', radius: 'number' },
  windSourceRemoved: { id: 'string', kind: 'string' },
  /** Camera view changed. */
  viewChanged: { view: 'string', craft: 'string' },
  /** An input device connected or disconnected (identified by vendor/product, never slot). */
  deviceConnected: { deviceKey: 'string', kind: 'string', name: 'string' },
  deviceDisconnected: { deviceKey: 'string', kind: 'string', name: 'string' },
  /** The craft was put back into the air by a relaunch (aerotow, peak launch, respawn). */
  relaunched: { craft: 'string', method: 'string', position: 'vector3' },
  /**
   * The floating render origin moved (src/core/origin.js): offset is its new WORLD position, previous
   * the old one and delta = offset - previous (m, multiples of 4096 on every axis). The payload object
   * is reused, so a listener copies what it keeps.
   */
  originRebased: { offset: 'vector3', previous: 'vector3', delta: 'vector3', version: 'number' },
  /** A spawn instance was created (a site came within range, or the director or debugger started one). */
  spawnActivated: { id: 'string', presetId: 'string', category: 'string', kind: SPAWN_KINDS, position: 'vector3' },
  /** A spawn instance was disposed; reason says why (ended, expired, despawn, range, debug, replaced, ...). */
  spawnEnded: { id: 'string', presetId: 'string', reason: 'string' },
  /**
   * The regional weather where the player flies changed state (src/spawns/weather.js). It fires only on
   * a real change, so previous is always a state; region is the weather cell id "rx:rz".
   */
  weatherChanged: { state: WEATHER_STATES, previous: WEATHER_STATES, region: 'string' },
  /** An achievement was earned (V-formation, Thread the Needle, ...). */
  achievement: { id: 'string', title: 'string' },
  /**
   * A challenge run started (src/gameplay/challenges.js): its clock runs from the start-gate crossing
   * (or from now for an immediate start). id is the course key `${seed}:${courseId}`; gates counts them.
   */
  challengeStarted: { id: 'string', name: 'string', craft: 'string', gates: 'number', presetId: { type: 'string', optional: true } },
  /**
   * A challenge gate was passed or missed. time is the run time (s) at the crossing; split (passed
   * checkpoints and the finish) adds the penalties so far; delta compares it with this craft's best split.
   */
  challengeGate: { id: 'string', index: 'number', role: ['start', 'checkpoint', 'finish'], time: 'number', split: { type: 'number', optional: true }, delta: { type: 'number', optional: true }, missed: 'boolean' },
  /**
   * A challenge run crossed its finish. time includes the penalties; best is this craft's best time
   * after the run (null when none is stored); valid is false for a void run (no best is stored).
   */
  challengeFinished: { id: 'string', craft: 'string', time: 'number', medal: ['gold', 'silver', 'bronze', 'none'], best: 'defined', improved: 'boolean', missed: 'number', penalties: 'number', valid: 'boolean' },
  /** A challenge run ended without a finish (cancelled, abandoned, crash, timeLimit, replaced, removed). */
  challengeCancelled: { id: 'string', reason: 'string' },
  /**
   * A journal statistic from a preset or an engine (src/gameplay/journal.js keeps the global records).
   * op says how value folds into the record: 'add' sums (stormsChased, value 1), 'min' keeps the
   * lowest (closestTornado in metres, bestCanyonRun in seconds for clean runs only), 'max' the highest.
   */
  journalStat: { key: 'string', value: 'number', op: JOURNAL_STAT_OPS, presetId: { type: 'string', optional: true } },
  /**
   * Wildlife falls silent or wakes again (a total solar eclipse). source names the holder (a spawn
   * id); quiet true starts its hold, false ends it. Birds settle and fauna stop calling while any
   * source holds quiet; the v1 birds and the audio cues listen.
   */
  wildlifeQuiet: { source: 'string', quiet: 'boolean' },
});

function describeFailure(type, payload) {
  const shape = EVENT_TYPES[type];
  if (payload === null || typeof payload !== 'object') return 'payload is not an object';
  for (const [field, rule] of Object.entries(shape)) {
    const spec = Array.isArray(rule) || typeof rule === 'string' ? { type: rule } : rule;
    const value = payload[field];
    if (value === undefined && spec.optional) continue;
    const valid = Array.isArray(spec.type) ? spec.type.includes(value) : FIELD_CHECKS[spec.type](value);
    if (!valid) return `field "${field}" is ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * Adds typed emit/on helpers to an EventBus. validate turns payload checks on (dev builds and
 * ?debug=1); a bad payload is reported once per event type and still delivered.
 */
export function attachTypedEvents(bus, { validate = false } = {}) {
  const reported = new Set();
  bus.emitTyped = (type, payload) => {
    if (!(type in EVENT_TYPES)) throw new Error(`[DRIFTWING] unknown typed event "${type}"`);
    if (validate) {
      const failure = describeFailure(type, payload);
      if (failure && !reported.has(type)) {
        reported.add(type);
        console.error(`[DRIFTWING] event "${type}" payload invalid: ${failure}`);
      }
    }
    bus.emit(type, payload);
  };
  bus.onTyped = (type, listener) => {
    if (!(type in EVENT_TYPES)) throw new Error(`[DRIFTWING] unknown typed event "${type}"`);
    return bus.on(type, listener);
  };

  // v1 landmarks announce 'landmark:discovered'; republish it as the typed 'discovery'.
  bus.on('landmark:discovered', ({ site, name, type }) => {
    const position = { x: site.x, y: Math.max(site.plateauHeight, 0), z: site.z };
    bus.emitTyped('discovery', { id: site.id, name, kind: type, position });
  });
  return bus;
}
