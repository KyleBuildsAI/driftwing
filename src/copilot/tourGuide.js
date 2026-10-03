import { clamp, compassName, bearingTo } from '../core/util.js';

/**
 * WREN's tour guide (Phase 2, Milestone F): the discovery grammar ("what's nearby", "take me to the
 * [name or category]", "find a thermal", "chase the storm", "next discovery"), the matching remote
 * actions, the proactive callouts ("Supercell building 9 km north-west. Want a heading?") with the
 * "yes" that places a waypoint, and the flight-state fields a remote brain reads (nearby[],
 * activeEvents[], weather, callouts).
 *
 * Everything reads the spawns system through its public API: the director's getNearby(radiusKm),
 * the SpawnManager's getActive / getPreset / listPresets / isDiscovered / getSiteFeed, and the typed
 * spawnActivated / spawnEnded events. The grammar half (createTourGrammar, resolveTarget,
 * calloutBlockReason, isLandingPhase, fillCallout) is pure, so tools/lab/copilot.mjs runs it in node.
 */

/** The tour-guide action types (docs/copilot-api.md, "v2 tour-guide actions"). */
export const TOUR_ACTION_TYPES = Object.freeze(['nearby', 'goTo', 'findThermal', 'chaseStorm', 'nextDiscovery']);
/** The preset categories (contract section 1). */
export const SPAWN_CATEGORIES = Object.freeze(['weather', 'geo', 'ocean', 'wildlife', 'structure', 'celestial', 'fantasy', 'flightplay', 'setpiece']);
/** getNearby states: a live spawn, a director candidate, an undiscovered site, a discovered site. */
export const NEARBY_STATES = Object.freeze(['active', 'dormant', 'site', 'discovered']);
export const MAX_TARGET_LENGTH = 48;
const MAX_ID_LENGTH = 96;

/** The callout rules: rate limit, height floor, the "yes" window and the pacing around other lines. */
export const CALLOUT_RULES = Object.freeze({
  /** At most one callout per this many seconds (real time). */
  minGapSeconds: 45,
  /** Never below this height above the ground or the water (m). */
  minAgl: 150,
  /** How long a "yes" (spoken, typed or the chip) still accepts the offer (s). */
  offerSeconds: 20,
  /** Quiet after any other WREN line before a callout may start (s). */
  quietAfterLine: 4,
  /** A callout that could not be spoken yet waits this long for the rules to allow it (s). */
  pendingSeconds: 120,
  /** Spawns closer or further than this are not called out (m). */
  minDistance: 400,
  maxDistance: 40000,
  /** Landing: low and descending, or on approach with flaps out (m, m/s). */
  lowAgl: 300,
  lowSink: -1.5,
  approachAgl: 500,
  approachSink: -0.5,
});

/** Search radii (km): what's nearby, and the destinations of goTo / chaseStorm / nextDiscovery. */
export const NEARBY_RADIUS_KM = 15;
export const SEARCH_RADIUS_KM = 40;
/**
 * Sites and director candidates are searched within this radius (km) at most: live spawns count out
 * to SEARCH_RADIUS_KM, but the site search reads the placement grid cell by cell.
 */
export const SITE_SEARCH_KM = 20;
/** At most this many entries in the snapshot's nearby[] and activeEvents[]. */
const SNAPSHOT_NEARBY_LIMIT = 10;
const SNAPSHOT_EVENTS_LIMIT = 10;
/** Thermals: weakest core worth flying to (m/s), the ring searched when none is close (m). */
const THERMAL_MIN_STRENGTH = 0.8;
const THERMAL_RING_RADIUS = 4500;
const THERMAL_RING_SAMPLES = 8;
/** Below this sun elevation (deg) thermals are too weak to work (the WindField's solar factor). */
const LOW_SUN_ELEVATION = 15;
/** A known (discovered) site wins over an unknown one unless the unknown one is this much closer. */
const DISCOVERED_PREFERENCE = 2;
/** Landmarks the next-discovery search may fall back to (m). */
const LANDMARK_SEARCH_RADIUS = 12000;
/** How often the callout queue is looked at (s). */
const CALLOUT_CHECK_SECONDS = 0.25;
const RARITY_PRIORITY = Object.freeze({ common: 0, uncommon: 1, rare: 2, legendary: 3 });

// ---- Words -------------------------------------------------------------------------------------------------
/** Spoken synonyms rewritten to the words the preset names use (twister -> tornado). */
const NAME_SYNONYMS = Object.freeze([
  [/\b(twisters?|funnel clouds?)\b/g, 'tornado'],
  [/\b(thunder ?storms?|storm cells?|anvil clouds?|anvils?)\b/g, 'supercell'],
  [/\b(whirlpools?)\b/g, 'maelstrom'],
  [/\b(eruptions?|lava|volcanoes)\b/g, 'volcano'],
  [/\b(hot springs?)\b/g, 'geyser'],
  [/\b(falls|cascades?)\b/g, 'waterfall'],
  [/\b(glowing (water|bay|sea|surf)|bioluminescence)\b/g, 'bioluminescent'],
  [/\b(starlings?)\b/g, 'starling murmuration'],
  [/\b(goose)\b/g, 'geese'],
  [/\b(wind ?turbines?|turbines?|windmills?)\b/g, 'wind farm turbine'],
  [/\b(runways?|air ?strips?|airports?|landing strips?)\b/g, 'airfield'],
  [/\b(shooting stars?|meteorites?)\b/g, 'meteor'],
  [/\b(lens clouds?|ufo clouds?|lenticulars?)\b/g, 'lenticular'],
  [/\b(rainbows?)\b/g, 'glory rainbow'],
  [/\b(spouts?)\b/g, 'waterspout'],
]);

/**
 * Category words for "take me to the [category]". A bare "ocean" stays the v1 biome search, so the
 * ocean category needs "sea life", "marine" or "ocean events".
 */
const CATEGORY_WORDS = Object.freeze([
  ['weather', /\b(weather( events?)?)\b/],
  ['geo', /\b(geo|geolog(y|ical)|volcanic|geothermal)\b/],
  ['ocean', /\b(sea life|marine( life)?|ocean (life|events?|sights?))\b/],
  ['wildlife', /\b(wildlife|animals?|birds?|creatures?|fauna)\b/],
  ['structure', /\b(structures?|buildings?|man-?made)\b/],
  ['celestial', /\b(celestial|sky shows?|space|astronomy)\b/],
  ['fantasy', /\b(fantasy|magic(al)?|mythical)\b/],
  ['flightplay', /\b(flight ?play)\b/],
  ['setpiece', /\b(set ?pieces?|spectacles?)\b/],
]);

/** Spoken category hints, for places WREN guides to without naming them (next discovery). */
const CATEGORY_HINTS = Object.freeze({
  weather: 'some weather',
  geo: 'something geological',
  ocean: 'something out on the water',
  wildlife: 'wildlife',
  structure: 'a structure',
  celestial: 'something in the sky',
  fantasy: 'something strange',
  flightplay: 'something to fly',
  setpiece: 'something big',
  landmark: 'a landmark',
});

/**
 * Name words too common to pick a preset on their own: "take me to the jet" is the craft, "wind"
 * and "sky" and "storm" belong to several things, and "islands" is the v1 archipelago search.
 */
const WEAK_WORDS = new Set([
  'test', 'jet', 'wind', 'sky', 'stream', 'field', 'total', 'full', 'circle', 'abandoned', 'shower', 'festival',
  'run', 'slot', 'mega', 'erupting', 'thermal', 'storm', 'chase', 'cloud', 'bay', 'pod', 'farm', 'island', 'v',
  'formation', 'solar', 'set', 'piece', 'site', 'the', 'of', 'and', 'a', 'an',
]);

/** Filler around a spoken target ("the nearest volcano please" -> "volcano"). */
const TARGET_FILLER = /\b(the|a|an|some|nearest|closest|next|please|pls|wren|now|there|right|for me|for us|on autopilot|with the autopilot|and fly( us| me)?( there)?|you fly|autopilot)\b/g;

/** Singular stem of a word, so "canyons", "spires" and "fireflies" meet their preset names. */
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lower-case words of a name or id: "Rope bridge" and "ropeBridge" both give rope, bridge. */
function nameWords(text) {
  return String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(stem);
}

function applySynonyms(text) {
  let result = ` ${String(text ?? '').toLowerCase()} `;
  for (const [pattern, replacement] of NAME_SYNONYMS) result = result.replace(pattern, replacement);
  return result.trim();
}

/** A preset's searchable words: its name, its journal title and its id. */
function catalogEntry(preset) {
  const words = new Set([...nameWords(preset.name), ...nameWords(preset.journal?.title), ...nameWords(preset.id)]);
  return { id: preset.id, name: preset.name, category: preset.category, kind: preset.kind, words, phrase: nameWords(preset.name).join(' ') };
}

/** The searchable catalog of a preset list. */
export function presetCatalog(presets) {
  const list = Array.isArray(presets) ? presets : [];
  return list.filter((preset) => preset && typeof preset.id === 'string' && typeof preset.name === 'string').map(catalogEntry);
}

/**
 * What a spoken target names: { presetIds } (the best-matching presets by name, journal title, id
 * and synonyms), or { category }, or null. A name needs one distinctive word, two common ones
 * ("jet stream") or the whole name.
 */
export function resolveTarget(target, presets) {
  const text = applySynonyms(target);
  const words = nameWords(text);
  const tokens = new Set(words);
  if (tokens.size === 0) return null;
  const spoken = ` ${words.join(' ')} `;
  let best = 0;
  let ids = [];
  for (const entry of presetCatalog(presets)) {
    let score = 0;
    for (const word of entry.words) {
      if (!tokens.has(word)) continue;
      score += WEAK_WORDS.has(word) ? 1 : 2;
    }
    if (entry.phrase && spoken.includes(` ${entry.phrase} `)) score += 3;
    if (score < 2) continue;
    if (score > best) {
      best = score;
      ids = [entry.id];
    } else if (score === best) {
      ids.push(entry.id);
    }
  }
  if (ids.length) return { presetIds: ids, category: null };
  for (const [category, pattern] of CATEGORY_WORDS) if (pattern.test(text)) return { presetIds: null, category };
  return null;
}

/** The target phrase of a spoken request, without filler ("the nearest rope bridge please" -> "rope bridge"). */
export function cleanTarget(phrase) {
  return String(phrase ?? '').replace(TARGET_FILLER, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TARGET_LENGTH);
}

/** Whether a preset is a storm (the storm chase looks for these): storm weather, or a storm name. */
export function isStormPreset(preset) {
  if (!preset) return false;
  const weather = preset.filters && Array.isArray(preset.filters.weather) ? preset.filters.weather : [];
  if (weather.includes('storm')) return true;
  return /(supercell|tornado|storm|thunder|microburst|waterspout|lightning)/i.test(`${preset.id} ${preset.name}`);
}

/** The preset id inside a nearby id: a site id, a candidate id, a spawn id or a debug site id. */
export function presetIdFromKey(key) {
  const parts = String(key ?? '').split(':');
  if ((parts[0] === 'spawn' || parts[0] === 'debug') && parts.length > 1) return presetIdFromKey(parts.slice(1).join(':'));
  return parts[0];
}

// ---- Speech helpers -------------------------------------------------------------------------------------------
/** "9.0 km", "600 metres". */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return 'some distance';
  if (metres < 950) return `${Math.max(10, Math.round(metres / 10) * 10)} metres`;
  const kilometres = metres / 1000;
  return `${kilometres < 9.95 ? kilometres.toFixed(1) : Math.round(kilometres)} km`;
}

/** "about 4 minutes away", "under a minute away", or '' when we are not moving. */
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'under a minute away';
  const minutes = Math.round(seconds / 60);
  if (minutes >= 90) return `about ${Math.round(minutes / 60)} hours away`;
  return minutes === 1 ? 'about a minute away' : `about ${minutes} minutes away`;
}

/** A compass heading as three digits: 7 -> "007". */
export function headingDigits(bearing) {
  return String(Math.round(((bearing % 360) + 360) % 360) % 360).padStart(3, '0');
}

/**
 * A preset callout line with its tokens filled: {distance} ("9.0 km"), {direction} ("north-west"),
 * {name} and {eta}. A line without a question gets "Want a heading?" so a "yes" has something to answer.
 */
export function fillCallout(line, { distance, bearing, name, etaSeconds }) {
  const eta = formatEta(etaSeconds) || 'a little way off';
  const text = String(line ?? '')
    .replace(/\{distance\}/g, formatDistance(distance))
    .replace(/\{direction\}/g, compassName(bearing))
    .replace(/\{name\}/g, name)
    .replace(/\{eta\}/g, eta)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return /\?\s*$/.test(text) ? text : `${text} Want a heading?`;
}

/**
 * Landing, for the callout rules: on the ground, gear down (retractable gear), low and descending,
 * or on approach (flaps out, low, sinking). telemetry is state.flight.
 */
export function isLandingPhase(telemetry) {
  if (!telemetry) return false;
  if (telemetry.onGround) return true;
  const gear = telemetry.gear ?? {};
  if (gear.retractable && gear.down) return true;
  const agl = Number.isFinite(telemetry.agl) ? telemetry.agl : Infinity;
  const sink = Number.isFinite(telemetry.verticalSpeed) ? telemetry.verticalSpeed : 0;
  if (agl < CALLOUT_RULES.lowAgl && sink < CALLOUT_RULES.lowSink) return true;
  return (telemetry.flaps ?? 0) > 0.05 && agl < CALLOUT_RULES.approachAgl && sink < CALLOUT_RULES.approachSink;
}

/**
 * Why a callout may not start now, or null when it may. input: { enabled, ready, photoMode, crash,
 * now, lastCalloutAt, agl, landing, busy, offerOpen }.
 */
export function calloutBlockReason(input) {
  if (!input.enabled) return 'disabled';
  if (!input.ready) return 'notReady';
  if (input.photoMode) return 'photoMode';
  if (input.crash) return 'crash';
  if (input.now - input.lastCalloutAt < CALLOUT_RULES.minGapSeconds) return 'rateLimit';
  if (!(input.agl >= CALLOUT_RULES.minAgl)) return 'lowAltitude';
  if (input.landing) return 'landing';
  if (input.busy) return 'talking';
  if (input.offerOpen) return 'offerOpen';
  return null;
}

/** A "yes" to an open offer, and the words that may follow it ("yes please, take us there"). */
const AFFIRMATIVE = /^(yes please|yes|yeah|yea|yep|yup|sure thing|sure|ok|okay|please|affirmative|do it|go on|go ahead|why not|absolutely|definitely|sounds good|let'?s go|let'?s do it|heading please|give me a heading|take (us|me) there|fly (us|me) there|show me)\b/;
const NEGATIVE = /^(no thanks|no thank you|no|nope|nah|not now|negative|skip( it)?|maybe later|later|never ?mind|cancel( that)?|pass)\b/;
const OFFER_FILLER = new Set([
  'please', 'wren', 'thanks', 'thank', 'you', 'heading', 'a', 'the', 'give', 'me', 'us', 'go', "let's", 'lets', 'take', 'fly', 'there',
  'autopilot', 'on', 'and', 'do', 'it', 'sure', 'yes', 'ok', 'okay', 'show', 'way', 'lead', 'set', 'waypoint', 'marker', 'mark',
]);
const OFFER_AUTOPILOT = /\b(autopilot|fly (us|me) there|take (us|me) there|you fly)\b/;

/**
 * 'yes' | 'no' | null for a normalized reply while an offer is open. Only a bare answer counts: a
 * "yes" followed by another request ("yes, switch to the jet") is left to the grammar.
 */
export function offerAnswer(text) {
  const reply = String(text ?? '').trim();
  const negative = reply.match(NEGATIVE);
  const affirmative = negative ? null : reply.match(AFFIRMATIVE);
  const match = negative ?? affirmative;
  if (!match) return null;
  const rest = reply.slice(match[0].length).split(' ').filter(Boolean);
  if (!rest.every((word) => OFFER_FILLER.has(word))) return null;
  return negative ? 'no' : 'yes';
}

// ---- Grammar -------------------------------------------------------------------------------------------------
/**
 * The tour-guide matchers for the local brain, (text, flight, core) => reply | null like the others.
 * listPresets() gives the presets the names are matched against (the SpawnManager's list).
 */
export function createTourGrammar({ listPresets }) {
  const presets = () => {
    const list = typeof listPresets === 'function' ? listPresets() : null;
    return Array.isArray(list) ? list : [];
  };
  const wantsAutopilot = (text) => /\b(autopilot|auto pilot|fly (me|us)|you fly|on auto|and fly|take (the )?controls|steer us)\b/.test(text);

  /** "Guide help": the tour-guide commands and their chips. */
  function matchGuideHelp(text) {
    const guideWord = /\b(guide|tour|explor(e|ing)|discover(y|ies)?|sightseeing|callouts?)\b/;
    const helpWord = /\b(help|commands|what can (you|i) (do|say|ask)|how does (it|this|that) work)\b/;
    if (!guideWord.test(text) || !helpWord.test(text)) return null;
    return {
      speech: "Tour guide: 'what's nearby', 'take me to the rope bridge' (any name, or a kind like wildlife or weather), 'find a thermal', 'chase the storm', 'next discovery'. Add 'on autopilot' and I'll fly us there. When I call something out, say 'yes' for a heading. The Guide chips in the command bar do the same, and 'callouts off' stops the callouts.",
      action: null,
    };
  }

  function matchNearby(text) {
    const asked = /\b(what'?s|what is|what else is|is there anything|anything|something) (nearby|near by|near us|near here|around( here| us)?|close by|out there|in range|interesting (nearby|around( here)?))\b/.test(text)
      || /^(what'?s )?nearby( please)?$/.test(text)
      || /\bnearby (events?|sites?|spawns?|things?|sights?)\b/.test(text)
      || /\bwhat can (you|we) see (nearby|around)\b/.test(text);
    if (!asked) return null;
    return { speech: '', action: { type: 'nearby' } };
  }

  function matchThermal(text) {
    if (/\bridge lift\b/.test(text)) return null;
    const lift = /\b(thermals?|updrafts?|rising air|some lift|find lift|lift nearby)\b/.test(text);
    if (!lift) return null;
    const asked = /\b(find|where'?s|where is|where are|locate|any|nearest|closest|show me|take (me|us)|get (me|us)|need|looking for|head (for|to)|go to|fly (me |us )?to|guide (me|us))\b/.test(text)
      || /^(a |the )?(thermals?|updrafts?)( please)?$/.test(text);
    if (!asked) return null;
    return { speech: '', action: { type: 'findThermal', autopilot: wantsAutopilot(text) } };
  }

  function matchStorm(text) {
    const stormWord = /\b(storms?|thunder ?storms?|supercells?|tornado(es)?|twisters?|lightning)\b/.test(text);
    const chase = /\bstorm ?chas(e|er|ing)\b/.test(text) || (/\b(chase|chasing|track|hunt)\b/.test(text) && stormWord);
    const find = /\b(find|where'?s|where is|any|nearest|closest|take (me|us) to|show me|head (for|to)|fly (me |us )?to|go to|get (me|us) to)\b/.test(text)
      && /\b(storms?|thunder ?storms?)\b/.test(text);
    if (!chase && !find) return null;
    return { speech: '', action: { type: 'chaseStorm', autopilot: wantsAutopilot(text) } };
  }

  function matchNextDiscovery(text) {
    const asked = /\bnext (discovery|find|site|sight|thing to (find|discover|see))\b/.test(text)
      || /\b(something|somewhere|anything) (new|we haven'?t (seen|found|been|discovered))\b/.test(text)
      || /\bundiscovered\b/.test(text)
      || /\bnew discover(y|ies)\b/.test(text)
      || /\bwhat haven'?t (we|i) (found|seen|discovered)\b/.test(text)
      || /\bnot in the journal\b/.test(text);
    if (!asked) return null;
    return { speech: '', action: { type: 'nextDiscovery', autopilot: wantsAutopilot(text) } };
  }

  /**
   * "Take me to the [name or category]" and friends ("fly to", "head for", "find the", "where's
   * the"). It answers only when the words name a spawn preset, a synonym of one or a category, so
   * "take me to the mountains" and "find the lighthouse" still reach the v1 find.
   */
  function matchGoTo(text) {
    const match = text.match(/\b(take (me|us)( over)? to|fly (me |us )?(over )?to|head (to|for|over to|towards?)|go (over )?to|navigate to|bring (me|us) to|guide (me|us) to|steer (for|to|towards?)|lead (me|us) to|get (me|us) to|point (me|us) (to|at)|find|locate|where'?s|where is|where are|show me|visit)\b(.*)$/);
    if (!match) return null;
    const target = cleanTarget(match[match.length - 1]);
    if (!target || !resolveTarget(target, presets())) return null;
    return { speech: '', action: { type: 'goTo', name: target, autopilot: wantsAutopilot(text) } };
  }

  /**
   * Last resort, after every other matcher: "take me to the [something WREN does not know]" gets an
   * honest answer instead of "I didn't catch that".
   */
  function matchUnknownPlace(text) {
    const match = text.match(/\b(take (me|us) to|fly (me |us )?to|guide (me|us) to|head (to|for)|navigate to|where'?s|where is)\b(.*)$/);
    if (!match) return null;
    const target = cleanTarget(match[match.length - 1]);
    if (!target || /\b(waypoint|marker|beacon|home|there|here|it)\b/.test(target) || /\d/.test(target)) return null;
    return { speech: `I don't know anything called ${target} around here. Ask me what's nearby and I'll list what I can find.`, action: null };
  }

  return {
    /** Runs before the general help. */
    matchHelp: matchGuideHelp,
    /** Runs after every other matcher. */
    matchUnknownPlace,
    /** In priority order: they run after help and before the aircraft and v1 matchers. */
    matchers: [matchThermal, matchStorm, matchNextDiscovery, matchNearby, matchGoTo],
  };
}

/** Validates one tour-guide action (type already checked). Returns a clean copy or null. */
export function sanitizeTourAction(raw) {
  const present = (value) => value !== undefined && value !== null;
  const action = { type: raw.type };
  if (raw.type !== 'nearby' && present(raw.autopilot)) {
    if (typeof raw.autopilot !== 'boolean') return null;
    action.autopilot = raw.autopilot;
  }
  if (raw.type !== 'goTo') return action;
  // Exactly one of name (a preset name, synonym or category) or id (from nearby[] or activeEvents[]).
  if (present(raw.name) === present(raw.id)) return null;
  if (present(raw.name)) {
    if (typeof raw.name !== 'string') return null;
    const name = String(raw.name).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TARGET_LENGTH);
    if (!name) return null;
    action.name = name;
    return action;
  }
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > MAX_ID_LENGTH) return null;
  action.id = raw.id.trim();
  return action;
}

// ---- The tour guide in the running game ------------------------------------------------------------------------
/**
 * Creates the tour guide. helpers: { succeed(text, informative), fail(text), pick(key, lines),
 * placeWaypoint(x, z, label) -> placed | null, engageFollow() -> boolean, say(text, source),
 * isBusy() -> boolean (WREN is answering, listening or speaking), directionPhrase(bearing, heading) }.
 * Returns { handlers, handleReply, snapshotFields, gatherEntries, update, getOffer, getStats }.
 */
export function createTourGuide(ctx, helpers) {
  const { bus, state, settings } = ctx;
  const { succeed, fail, pick, placeWaypoint, engageFollow, say, isBusy, directionPhrase } = helpers;
  const pending = [];
  const calledOut = new Set();
  let offer = null;
  let lastCalloutAt = -Infinity;
  let calloutTimer = 0;
  let lastBlock = null;
  let callouts = 0;
  let offersAccepted = 0;
  let readFailed = false;

  const now = () => state.time.realElapsed;
  const player = () => state.player;

  function spawnsSystem() {
    const spawns = ctx.systems.spawns;
    return spawns && !spawns.failed && spawns.manager ? spawns : null;
  }

  function listPresets() {
    const spawns = spawnsSystem();
    return spawns ? spawns.manager.listPresets() : [];
  }

  function reportReadFailure(error) {
    if (readFailed) return;
    readFailed = true;
    console.error('[DRIFTWING] WREN could not read the spawns for the tour guide', error);
  }

  /** Distance, bearing and ETA from the craft to (x, z). */
  function measure(x, z, target) {
    const position = player().position;
    const speed = player().speed;
    target.distance = Math.hypot(x - position.x, z - position.z);
    target.bearing = bearingTo(position.x, position.z, x, z);
    target.etaSeconds = speed > 1 ? Math.round(target.distance / speed) : null;
    return target;
  }

  function stateOfRecord(record) {
    if (record.kind === 'event') return 'active';
    if (record.active && record.source === 'site') return 'active';
    return record.discovered ? 'discovered' : 'site';
  }

  /**
   * Everything the guide knows within radiusKm, nearest first: the director's getNearby (live
   * spawns, dormant candidates, sites) merged with the SpawnManager's live spawns (debug spawns and
   * site instances included). Entry: { id, spawnId, presetId, name, category, kind, state,
   * discovered, distance, bearing, etaSeconds, x, z }.
   */
  function gatherEntries(radiusKm) {
    const spawns = spawnsSystem();
    if (!spawns) return [];
    const manager = spawns.manager;
    const radius = radiusKm * 1000;
    const position = player().position;
    const entries = new Map();
    let nearby = [];
    let active = [];
    try {
      nearby = spawns.director ? spawns.director.getNearby(Math.min(radiusKm, SITE_SEARCH_KM)) : [];
      active = manager.getActive();
    } catch (error) {
      reportReadFailure(error);
      return [];
    }
    let sites = null;
    if (nearby.some((entry) => entry.state === 'site' || entry.state === 'discovered')) {
      const feed = manager.getSiteFeed();
      if (feed && typeof feed.sitesNear === 'function') sites = new Map(feed.sitesNear(position.x, position.z, Math.min(radius, SITE_SEARCH_KM * 1000)).map((site) => [site.id, site]));
    }
    for (const entry of nearby) {
      const presetId = presetIdFromKey(entry.id);
      const preset = manager.getPreset(presetId);
      const site = sites ? sites.get(entry.id) : null;
      const radians = (entry.bearing * Math.PI) / 180;
      const x = site ? site.x : position.x + Math.sin(radians) * entry.distance;
      const z = site ? site.z : position.z - Math.cos(radians) * entry.distance;
      const discovered = entry.state === 'discovered' || (entry.state === 'active' && manager.isDiscovered(entry.id));
      entries.set(entry.id, {
        id: entry.id,
        spawnId: null,
        presetId,
        name: entry.name,
        category: entry.category,
        kind: preset ? preset.kind : 'event',
        state: entry.state,
        discovered,
        distance: entry.distance,
        bearing: entry.bearing,
        etaSeconds: entry.etaSeconds,
        x,
        z,
      });
    }
    for (const record of active) {
      const measured = measure(record.position.x, record.position.z, {});
      if (measured.distance > radius) continue;
      const key = record.siteId ?? record.id;
      const known = entries.get(key) ?? entries.get(record.id);
      const entry = known ?? { id: key, presetId: record.presetId, name: record.name, category: record.category };
      entry.spawnId = record.id;
      entry.kind = record.kind;
      entry.state = known && known.state === 'active' ? 'active' : stateOfRecord(record);
      entry.discovered = record.discovered;
      entry.distance = Math.round(measured.distance);
      entry.bearing = Math.round(measured.bearing) % 360;
      entry.etaSeconds = measured.etaSeconds;
      entry.x = record.position.x;
      entry.z = record.position.z;
      if (!known) entries.set(key, entry);
    }
    return [...entries.values()].sort((first, second) => first.distance - second.distance);
  }

  /** A waypoint on an entry, and the spoken result. */
  function guideTo(entry, label, lead, autopilotWanted, note = '') {
    const placed = placeWaypoint(entry.x, entry.z, label);
    if (!placed) return fail("I found it, but couldn't place the beacon.");
    const measured = measure(entry.x, entry.z, {});
    const autopilot = autopilotWanted === true && engageFollow();
    let text = `${lead} ${formatDistance(measured.distance)} ${directionPhrase(measured.bearing, player().heading)}, heading ${headingDigits(measured.bearing)}.`;
    if (note) text += ` ${note}`;
    text += autopilot ? ' Waypoint set, autopilot engaged.' : ' Waypoint set.';
    return succeed(text, true);
  }

  function stateWords(entry) {
    if (entry.state === 'active') {
      const eta = entry.kind === 'event' ? formatEta(entry.etaSeconds) : '';
      return entry.kind === 'event' ? `happening now${eta ? `, ${eta}` : ''}` : 'active now';
    }
    return entry.discovered ? 'in the journal' : 'not in the journal yet';
  }

  function nearestLandmark(radius) {
    const landmarks = ctx.systems.landmarks;
    const list = typeof landmarks?.getNearby === 'function' ? landmarks.getNearby(radius) : [];
    return Array.isArray(list) ? list.filter((site) => Number.isFinite(site.x) && Number.isFinite(site.z)) : [];
  }

  // ---- Actions ------------------------------------------------------------------------------------------------
  const handlers = {
    /** "What's nearby": the closest few with distance, direction and state. */
    nearby() {
      const entries = gatherEntries(NEARBY_RADIUS_KM).filter((entry) => entry.state !== 'dormant');
      if (entries.length === 0) {
        const landmark = nearestLandmark(6000)[0];
        const landmarkText = landmark ? ` ${landmark.name} is ${formatDistance(landmark.distance)} ${directionPhrase(landmark.bearing, player().heading)}.` : '';
        return succeed(`Nothing on my list within ${NEARBY_RADIUS_KM} km right now.${landmarkText} I'll call out anything that turns up.`, true);
      }
      const top = entries.slice(0, 3).map((entry) => `${entry.name}, ${formatDistance(entry.distance)} ${directionPhrase(entry.bearing, player().heading)}, ${stateWords(entry)}`);
      const list = top.length === 1 ? top[0] : `${top.slice(0, -1).join('; ')}; and ${top[top.length - 1]}`;
      const more = entries.length > 3 ? ` ${entries.length - 3} more further out.` : '';
      return succeed(`Nearby: ${list}.${more}`, true);
    },

    /** "Take me to the [name or category]": a waypoint on the best match, the autopilot if asked. */
    goTo(action) {
      const entries = gatherEntries(SEARCH_RADIUS_KM).filter((entry) => entry.state !== 'dormant');
      let matches;
      let wanted;
      if (action.id) {
        matches = entries.filter((entry) => entry.id === action.id || entry.spawnId === action.id);
        wanted = 'that one';
        if (matches.length === 0) return fail("I can't find that one any more. Ask me what's nearby for a fresh list.");
      } else {
        const resolved = resolveTarget(action.name, listPresets());
        if (!resolved) return fail(`I don't know anything called ${action.name}. Ask me what's nearby and I'll list what's around.`);
        matches = entries.filter((entry) => (resolved.presetIds ? resolved.presetIds.includes(entry.presetId) : entry.category === resolved.category));
        wanted = resolved.presetIds ? (listPresets().find((preset) => preset.id === resolved.presetIds[0])?.name ?? action.name) : `${resolved.category} sights`;
        if (matches.length === 0) {
          const preset = resolved.presetIds ? listPresets().find((candidate) => candidate.id === resolved.presetIds[0]) : null;
          const tail = preset && preset.kind === 'event'
            ? " It isn't happening anywhere near us right now. I'll call it out if it starts."
            : ' Keep exploring and I will call it out when one is in range.';
          return fail(`No ${wanted.toLowerCase()} near us that I know of.${tail}`);
        }
      }
      const nearest = matches[0];
      const known = matches.find((entry) => entry.discovered);
      const choice = known && known.distance <= nearest.distance * DISCOVERED_PREFERENCE ? known : nearest;
      const note = choice.discovered ? '' : "It's not in the journal yet.";
      return guideTo(choice, choice.name, `${choice.name}:`, action.autopilot, note);
    },

    /** "Find a thermal": the nearest working thermal from the WindField, at our height. */
    findThermal(action) {
      const wind = ctx.wind;
      if (typeof wind?.nearestThermal !== 'function') return fail("I can't read the air right now.");
      const position = player().position;
      let thermal = wind.nearestThermal(position, THERMAL_MIN_STRENGTH);
      if (!thermal) {
        // Nothing within a cell or two: look around a wider ring and keep the closest to us.
        let bestDistance = Infinity;
        for (let sample = 0; sample < THERMAL_RING_SAMPLES; sample++) {
          const angle = (sample / THERMAL_RING_SAMPLES) * Math.PI * 2;
          const probe = { x: position.x + Math.sin(angle) * THERMAL_RING_RADIUS, y: position.y, z: position.z - Math.cos(angle) * THERMAL_RING_RADIUS };
          const found = wind.nearestThermal(probe, THERMAL_MIN_STRENGTH);
          if (!found) continue;
          const distance = Math.hypot(found.x - position.x, found.z - position.z);
          if (distance < bestDistance) {
            bestDistance = distance;
            thermal = { ...found, distance };
          }
        }
      }
      if (!thermal) {
        if (state.time.nightFactor > 0.5) return fail('No thermals working near us. They need sun on the ground, so try again in daylight.');
        if (state.time.sunElevation < LOW_SUN_ELEVATION) {
          return fail("No working thermals near us: the sun's too low to drive them. Ridge lift on a windward slope is the better bet until it climbs.");
        }
        return fail("No working thermals within about 7 km. Sunny slopes and dry ground are the best bet; let's look further on.");
      }
      // The column leans downwind as it rises: aim for where it is at our height.
      const rise = clamp((position.y - thermal.ground) / Math.max(1, thermal.top - thermal.ground), 0, 1);
      const capX = Number.isFinite(thermal.capX) ? thermal.capX : thermal.x;
      const capZ = Number.isFinite(thermal.capZ) ? thermal.capZ : thermal.z;
      const x = thermal.x + (capX - thermal.x) * rise;
      const z = thermal.z + (capZ - thermal.z) * rise;
      const strength = `${thermal.strength.toFixed(1)} metres a second`;
      const top = Math.round(thermal.top / 10) * 10;
      if (Math.hypot(x - position.x, z - position.z) < thermal.radius) {
        return succeed(`We're in one now: about ${strength} up, working to about ${top} metres. Circle tight and stay in it.`, true);
      }
      return guideTo({ x, z }, 'Thermal', 'Thermal', action.autopilot, `About ${strength} up, topping out near ${top} metres.`);
    },

    /** "Chase the storm": the nearest active storm, else a storm candidate, else the honest weather. */
    chaseStorm(action) {
      const spawns = spawnsSystem();
      const stormy = (entry) => isStormPreset(spawns ? spawns.manager.getPreset(entry.presetId) : null);
      const entries = gatherEntries(SEARCH_RADIUS_KM).filter(stormy);
      const active = entries.find((entry) => entry.state === 'active');
      if (active) {
        return guideTo(active, active.name, `${active.name}, happening now:`, action.autopilot, 'Keep your distance from the core; the air gets rough.');
      }
      const candidate = entries.find((entry) => entry.state === 'dormant');
      if (candidate) {
        return guideTo(candidate, `Possible ${candidate.name}`.slice(0, MAX_TARGET_LENGTH), `Nothing's active yet, but a ${candidate.name.toLowerCase()} could build`, action.autopilot, "I've marked it; no promises.");
      }
      const weather = ctx.systems.weather?.getState?.();
      const sky = weather?.state === 'building'
        ? ' The weather is building here though, so watch the horizon.'
        : weather?.state === 'storm' ? ' The sky is stormy here, but nothing is organised enough to chase.' : ' The sky is quiet here.';
      return fail(`No storms active within ${SEARCH_RADIUS_KM} km.${sky}`);
    },

    /**
     * "Next discovery": the nearest undiscovered live spawn or site the director knows of (never a
     * dormant candidate), else the nearest landmark not in the journal. Guided to, not named.
     */
    nextDiscovery(action) {
      const options = gatherEntries(SEARCH_RADIUS_KM)
        .filter((entry) => !entry.discovered && (entry.state === 'active' || entry.state === 'site') && entry.distance > CALLOUT_RULES.minDistance)
        .map((entry) => ({ x: entry.x, z: entry.z, distance: entry.distance, category: entry.category }));
      for (const landmark of nearestLandmark(LANDMARK_SEARCH_RADIUS)) {
        if (!landmark.discovered && landmark.distance > CALLOUT_RULES.minDistance) options.push({ x: landmark.x, z: landmark.z, distance: landmark.distance, category: 'landmark' });
      }
      if (options.length === 0) return fail(`Everything I know of nearby is already in the journal. Pick a direction and let's find new country.`);
      options.sort((first, second) => first.distance - second.distance);
      const next = options[0];
      const hint = CATEGORY_HINTS[next.category] ?? 'something new';
      return guideTo(next, 'Next discovery', `Something new, ${hint}:`, action.autopilot);
    },
  };

  // ---- Offers ----------------------------------------------------------------------------------------------------
  function setOffer(next) {
    offer = next;
    bus.emit('copilot:offer', offer ? { active: true, name: offer.name, presetId: offer.presetId, expiresIn: CALLOUT_RULES.offerSeconds } : { active: false });
  }

  /** Where an offer's target is now: its live spawn's anchor, or where it was when offered. */
  function offerPosition() {
    const spawns = spawnsSystem();
    const live = spawns && offer.spawnId ? spawns.manager.getInstance(offer.spawnId) : null;
    return live ? live.position : offer;
  }

  /**
   * Answers a "yes" or a "no" to an open callout offer, whatever brain is active. Returns
   * { speech, action: null, ok } or null when the text is not an answer (or no offer is open).
   */
  function handleReply(text) {
    if (!offer) return null;
    if (now() > offer.expiresAt) {
      setOffer(null);
      return null;
    }
    const answer = offerAnswer(text);
    if (!answer) return null;
    const target = offer;
    if (answer === 'no') {
      setOffer(null);
      return { speech: pick('offerDeclined', ['No problem.', "Fair enough. It's there if you change your mind.", 'Right you are.']), action: null, ok: true };
    }
    const position = offerPosition();
    setOffer(null);
    offersAccepted++;
    const result = guideTo({ x: position.x, z: position.z }, target.name, `Heading ${headingDigits(measure(position.x, position.z, {}).bearing)} for the ${target.name.toLowerCase()},`, OFFER_AUTOPILOT.test(text));
    const speech = result.text.replace(/, heading \d{3}\./, '.');
    return { speech, action: null, ok: result.ok };
  }

  // ---- Callouts -----------------------------------------------------------------------------------------------------
  function queueCallout(payload) {
    const spawns = spawnsSystem();
    if (!spawns || !payload) return;
    const preset = spawns.manager.getPreset(payload.presetId);
    if (!preset || !Array.isArray(preset.callouts) || preset.callouts.length === 0) return;
    const record = spawns.manager.getInstance(payload.id);
    const key = record && record.siteId ? record.siteId : payload.id;
    if (calledOut.has(key)) return;
    // A site already in the journal is no news; a new site coming into range is.
    if (payload.kind === 'site' && spawns.manager.isDiscovered(key)) return;
    const priority = (RARITY_PRIORITY[preset.rarity] ?? 0) + (preset.heavy ? 2 : 0) + (preset.kind === 'event' ? 1 : 0);
    pending.push({ spawnId: payload.id, presetId: payload.presetId, key, priority, queuedAt: now() });
    if (pending.length > 8) {
      pending.sort((first, second) => second.priority - first.priority || second.queuedAt - first.queuedAt);
      pending.length = 8;
    }
  }

  function dropPending(spawnId) {
    for (let index = pending.length - 1; index >= 0; index--) if (pending[index].spawnId === spawnId) pending.splice(index, 1);
  }

  bus.onTyped('spawnActivated', queueCallout);
  bus.onTyped('spawnEnded', ({ id }) => {
    dropPending(id);
    // An event is keyed by its spawn id, which never comes back once the spawn ends. Sites are keyed
    // by their site id (never a spawn id), so a site called out once stays called out.
    calledOut.delete(id);
    if (offer && offer.spawnId === id) setOffer(null);
  });

  /** The callout rules' inputs, refilled on every check (no allocation while spawns wait). */
  const gate = { enabled: false, ready: false, photoMode: false, crash: false, now: 0, lastCalloutAt: -Infinity, agl: 0, landing: false, busy: false, offerOpen: false };
  function blockReason() {
    gate.enabled = settings.get('copilotCallouts') === true;
    gate.ready = state.ready === true;
    gate.photoMode = state.photoMode === true;
    gate.crash = Boolean(state.flight.crash?.active);
    gate.now = now();
    gate.lastCalloutAt = lastCalloutAt;
    gate.agl = state.flight.agl;
    gate.landing = isLandingPhase(state.flight);
    gate.busy = isBusy(CALLOUT_RULES.quietAfterLine);
    gate.offerOpen = Boolean(offer);
    return calloutBlockReason(gate);
  }

  /** Speaks the best waiting callout when the rules allow one. */
  function tryCallout() {
    const spawns = spawnsSystem();
    if (!spawns) return;
    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index];
      if (now() - item.queuedAt > CALLOUT_RULES.pendingSeconds || !spawns.manager.getInstance(item.spawnId)) pending.splice(index, 1);
    }
    if (pending.length === 0) return;
    lastBlock = blockReason();
    if (lastBlock) return;
    pending.sort((first, second) => first.priority - second.priority || first.queuedAt - second.queuedAt);
    while (pending.length) {
      const item = pending.pop();
      const record = spawns.manager.getInstance(item.spawnId);
      const preset = spawns.manager.getPreset(item.presetId);
      if (!record || !preset) continue;
      const measured = measure(record.position.x, record.position.z, {});
      calledOut.add(item.key);
      if (measured.distance < CALLOUT_RULES.minDistance || measured.distance > CALLOUT_RULES.maxDistance) continue;
      const line = fillCallout(pick(`callout-${preset.id}`, preset.callouts), { distance: measured.distance, bearing: measured.bearing, name: preset.name, etaSeconds: measured.etaSeconds });
      if (!line) continue;
      lastCalloutAt = now();
      callouts++;
      say(line, 'local');
      bus.emit('copilot:callout', { text: line, presetId: preset.id, spawnId: item.spawnId });
      setOffer({ spawnId: item.spawnId, presetId: preset.id, name: preset.name, x: record.position.x, z: record.position.z, expiresAt: now() + CALLOUT_RULES.offerSeconds });
      return;
    }
  }

  bus.on('settings:changed', ({ key, value }) => {
    if (key !== 'copilotCallouts' || value !== false) return;
    pending.length = 0;
    if (offer) setOffer(null);
  });

  // ---- Snapshot -------------------------------------------------------------------------------------------------------
  /** The remote brain's tour-guide fields: nearby[], activeEvents[], weather and callouts. */
  function snapshotFields() {
    const entries = gatherEntries(NEARBY_RADIUS_KM);
    const nearby = entries.slice(0, SNAPSHOT_NEARBY_LIMIT).map((entry) => ({
      id: entry.id,
      presetId: entry.presetId,
      name: entry.name,
      category: entry.category,
      kind: entry.kind,
      distance: Math.round(entry.distance),
      bearing: Math.round(entry.bearing) % 360,
      state: entry.state,
      etaSeconds: entry.etaSeconds,
      discovered: entry.discovered,
    }));
    const activeEvents = [];
    const spawns = spawnsSystem();
    let records = [];
    try {
      records = spawns ? spawns.manager.getActive() : [];
    } catch (error) {
      reportReadFailure(error);
    }
    for (const record of records) {
      if (record.kind !== 'event' && !(record.active && record.source === 'site')) continue;
      const measured = measure(record.position.x, record.position.z, {});
      if (measured.distance > SEARCH_RADIUS_KM * 1000) continue;
      activeEvents.push({
        id: record.id,
        presetId: record.presetId,
        name: record.name,
        category: record.category,
        kind: record.kind,
        distance: Math.round(measured.distance),
        bearing: Math.round(measured.bearing) % 360,
        state: 'active',
        etaSeconds: measured.etaSeconds,
        discovered: record.discovered,
      });
    }
    activeEvents.sort((first, second) => first.distance - second.distance);
    activeEvents.length = Math.min(activeEvents.length, SNAPSHOT_EVENTS_LIMIT);
    const weather = ctx.systems.weather?.getState?.();
    let openOffer = null;
    if (offer && now() <= offer.expiresAt) {
      const position = offerPosition();
      const measured = measure(position.x, position.z, {});
      openOffer = {
        name: offer.name,
        presetId: offer.presetId,
        distance: Math.round(measured.distance),
        bearing: Math.round(measured.bearing) % 360,
        expiresIn: Math.max(0, Math.round((offer.expiresAt - now()) * 10) / 10),
      };
    }
    return {
      nearby,
      activeEvents,
      weather: weather && typeof weather.state === 'string' ? { state: weather.state, storminess: weather.storminess } : null,
      callouts: { enabled: settings.get('copilotCallouts') === true, offer: openOffer },
    };
  }

  return {
    handlers,
    handleReply,
    snapshotFields,
    gatherEntries,
    listPresets,
    update(realDt) {
      if (offer && now() > offer.expiresAt) setOffer(null);
      calloutTimer -= realDt;
      if (calloutTimer > 0) return;
      calloutTimer = CALLOUT_CHECK_SECONDS;
      tryCallout();
    },
    getOffer: () => (offer ? { name: offer.name, presetId: offer.presetId, expiresIn: Math.max(0, offer.expiresAt - now()) } : null),
    /** Destinations for the guide chips: live events and discovered sites (never undiscovered ones). */
    listDestinations(limit = 2) {
      return gatherEntries(NEARBY_RADIUS_KM)
        .filter((entry) => entry.distance > CALLOUT_RULES.minDistance && ((entry.state === 'active' && entry.kind === 'event') || entry.discovered))
        .slice(0, limit)
        .map((entry) => ({ name: entry.name, presetId: entry.presetId }));
    },
    getStats() {
      return {
        pendingCallouts: pending.length,
        callouts,
        lastCalloutAt: Number.isFinite(lastCalloutAt) ? lastCalloutAt : null,
        lastBlock,
        offer: offer ? { name: offer.name, presetId: offer.presetId, expiresIn: Math.round(Math.max(0, offer.expiresAt - now()) * 10) / 10 } : null,
        offersAccepted,
        calledOut: calledOut.size,
      };
    },
  };
}
