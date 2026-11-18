import { bearingTo, compassName, headingFromVector, wrapDegrees } from '../core/util.js';
import { NEGATED_REQUEST, formatSpeed } from './grammar.js';
import { formatDistance, headingDigits, offerAnswer } from './tourGuide.js';

/**
 * WREN's cross-craft guide (Phase 3, Milestone O, contract j.2): the phrases that work whatever craft
 * is flying and the keyboard / UI each one stands for.
 *
 *   "find water to land"   a waypoint on the nearest landable water: a local lake (waterQuery.bodiesNear)
 *                          or the open sea past the coast (the Guide chip "Find water", the world map)
 *   "find a perch"         a waypoint on the nearest perch (colliders.perchesNear): tree tops and the
 *                          tops of structures; the eagle also flies its own approach when one is close
 *                          (the Guide chip "Find a perch" on the eagle)
 *   "wind at [altitude]"   the wind from the WindField (ctx.wind.probe) at that height over the craft:
 *                          metres, feet, kilometres, thousands and flight levels (the balloon's
 *                          wind-layer column on the HUD)
 *   "start the challenge"  challengeStart on the course whose start prompt is showing; else the nearest
 *                          course's start gate as a waypoint (Y, the start prompt)
 *   "take me to space"     the spaceplane's climb to space (craftCommand climbToSpace); from any other
 *                          craft WREN asks first, and a "yes" switches to the spaceplane and climbs
 *                          (the Guide chip "To space" on the spaceplane)
 *   "scenic cruise"        the airship's scenic cruise (craftCommand scenicCruise); from another craft,
 *                          the same yes / no offer to switch (Space on the airship)
 *   "smoke on / off"       the craft's smoke: the aerobatic's smoke command, the bush plane's smoke
 *                          ability, and a plain answer on a craft without smoke (Space; Shift+Space cycles
 *                          the aerobatic's colour)
 *
 * The grammar half (createCraftGuideGrammar, parseAltitude, sanitizeCraftGuideAction) is pure, so
 * tools/lab/copilot.mjs runs it in node. Where the active craft has the command itself (smoke on the
 * aerobatic, scenic cruise on the airship) the grammar answers with that craftCommand, so a remote
 * brain and the local one meet the same action.
 */

/** The cross-craft action types (docs/copilot-api.md, "v2 cross-craft actions"). */
export const CRAFT_GUIDE_ACTION_TYPES = Object.freeze(['findWater', 'findPerch', 'windAt', 'challengeStart', 'challengeCancel', 'toSpace', 'scenicCruise', 'smoke']);
/** The highest altitude "wind at" answers for (m): the spaceplane's ceiling. */
export const MAX_WIND_ALTITUDE = 150000;
/** The confirm offer ("Switch to the spaceplane and climb to space?") lapses after this (s). */
export const CONFIRM_SECONDS = 15;

const FEET = 0.3048;
/** Landable water: local lakes searched within this (m), the open sea within OCEAN_RADIUS. */
const LAKE_RADIUS = 20000;
const OCEAN_RADIUS = 20000;
const OCEAN_STEP = 500;
/** A lake needs this much water across (m) to land on; the sea this much beyond the shoreline point. */
const MIN_LAKE_SPAN = 300;
const MIN_LAKE_DEPTH = 0.5;
const SEA_RUNWAY = 400;
const SEA_MIN_DEPTH = 2;
/** Over landable water already within this (m): nothing to guide to. */
const OVER_WATER = 150;
/** Perches searched in widening rings (m) around the ground under the craft. */
const PERCH_RADII = Object.freeze([400, 1200, 2500]);
/** The eagle's own perch approach (craftCommand findPerch) reaches this far (m). */
const EAGLE_APPROACH = 300;
/** Challenge courses beyond their start prompt are offered as a waypoint within this (m). */
const COURSE_SEARCH = 20000;
/** Wind above the ground at least (m) when the asked height is under the ground here. */
const WIND_FLOOR = 10;

// ---- Words ---------------------------------------------------------------------------------------------------
const ONES = Object.freeze({
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
const TENS = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const UNIT_FEET = /^(feet|foot|ft)$/;
const UNIT_METRES = /^(m|metres?|meters?|mtrs?)$/;
const UNIT_KILOMETRES = /^(km|kms|kilomet(?:re|er)s?|klicks?|clicks?)$/;
/** A wind question: the wind word, then "at" (or "up at", "aloft at", "at an altitude of") and a height. */
const WIND_WORD = /\b(winds?|wind speed|wind direction)\b/;
/** Each "at" (or "around", "near", "at an altitude of") after the wind word starts a possible height. */
const WIND_AT = /\b(?:at|around|near)\s+(?:an? (?:altitude|height|level) of\s+)?/g;
const WIND_HERE = /^(what'?s|what is|whats|how'?s|how is) the wind( like| doing)?( here| now| right now| out there| at the moment)?$|^(wind (check|report)|current wind|wind here)$/;
/** Ways of saying no to something (a negative phrase must never start the thing it names). */
const NEGATION = /\b(stop|abort|cancel|end|quit|enough|no more|don'?t|do not|never ?mind|turn off|switch off|kill)\b/;
/** A question about a thing ("is the smoke on?") is not a request to switch it. */
const QUESTION = /^(is|are|was|were|what|what'?s|how|why|where|when|do|does|did|can i see)\b/;
const FIND_VERB = /\b(find|locate|search for|look for|looking for|where'?s|where is|where are|nearest|closest|need|show me|take (me|us) to|guide (me|us) to|get (me|us) to|head (for|to)|any)\b/;
/** What the cross-craft phrases are about: a negated request naming one of them does nothing. */
const GUIDE_SUBJECT = /\b(smoke|challenges?|space|karman line|scenic|sightseeing|perch(es)?|water to land|landable water|somewhere wet)\b/;
const AUTOPILOT_WORDS = /\b(autopilot|auto pilot|fly (me|us) there|you fly|on auto|and fly|take (me|us) there|steer us)\b/;

/**
 * A spoken number at tokens[start]: digits ("2000", "1.5", "10k", "1 500" from "1,500"), number words
 * ("three", "fifteen hundred", "two thousand five hundred", "one and a half", "half a", "two point
 * five"), and "10 thousand". Returns { value, next } or null.
 */
export function parseSpokenNumber(tokens, start) {
  let index = start;
  const first = tokens[index];
  if (first === undefined) return null;
  const digits = /^(\d+(?:\.\d+)?)(k)?$/.exec(first);
  if (digits) {
    let value = Number(digits[1]);
    index++;
    // Digit groups split by the normalizer ("1,500" -> "1 500"): a short integer, then groups of three.
    if (!digits[2] && /^\d{1,3}$/.test(first)) {
      while (/^\d{3}$/.test(tokens[index] ?? '')) {
        value = value * 1000 + Number(tokens[index]);
        index++;
      }
    }
    if (digits[2]) value *= 1000;
    if (tokens[index] === 'thousand') {
      value *= 1000;
      index++;
    } else if (tokens[index] === 'hundred') {
      value *= 100;
      index++;
    }
    return { value, next: index };
  }
  let total = 0;
  let group = 0;
  let any = false;
  while (index < tokens.length) {
    const word = tokens[index];
    const next = tokens[index + 1] ?? '';
    // Words used: how many tokens this one takes (0 ends the number).
    let used = 1;
    if (word in ONES) group += ONES[word];
    else if (word in TENS) group += TENS[word];
    else if (word === 'hundred') group = (group || 1) * 100;
    else if (word === 'thousand') {
      total += (group || 1) * 1000;
      group = 0;
    } else if (word === 'a' && !any && (next === 'hundred' || next === 'thousand')) {
      // "a hundred", "a thousand": the multiplier counts it as one.
      used = 1;
    } else if (word === 'half' && !any) {
      // "half a kilometre"
      group = 0.5;
      if (next === 'a' || next === 'an') used = 2;
    } else if (word === 'and' && any && next === 'a' && tokens[index + 2] === 'half') {
      // "one and a half"
      group += 0.5;
      used = 3;
    } else if (word === 'and' && any && (next in ONES || next in TENS)) {
      // "two thousand and fifty": a connector.
      used = 1;
    } else if (word === 'point' && any && next in ONES) {
      group += ONES[next] / 10;
      used = 2;
    } else used = 0;
    if (used === 0) break;
    any = true;
    index += used;
  }
  if (!any) return null;
  const value = total + group;
  return Number.isFinite(value) && value > 0 ? { value, next: index } : null;
}

/**
 * The height a "wind at ..." question names: { metres, reference: 'msl' | 'agl', unit, value } or null.
 * A number with no unit is in the pilot's units (feet for aviation, metres for metric); "flight level
 * 100" is 10 000 feet; "above the ground" (or AGL) measures from the ground under the craft.
 */
export function parseAltitude(phrase, units = 'metric') {
  const text = String(phrase ?? '').trim();
  if (!text) return null;
  const tokens = text.split(' ');
  const reference = /\b(above (the )?(ground|terrain|surface)|agl|off the ground)\b/.test(text) ? 'agl' : 'msl';
  const level = /^(?:flight level|fl)\s*(\d{2,3})\b/.exec(text) || /^fl(\d{2,3})\b/.exec(text);
  if (level) {
    const value = Number(level[1]) * 100;
    return { metres: value * FEET, reference: 'msl', unit: 'feet', value };
  }
  const number = parseSpokenNumber(tokens, 0);
  if (!number) return null;
  const unitWord = tokens[number.next] ?? '';
  let unit;
  if (UNIT_FEET.test(unitWord)) unit = 'feet';
  else if (UNIT_METRES.test(unitWord)) unit = 'metres';
  else if (UNIT_KILOMETRES.test(unitWord)) unit = 'km';
  else if (unitWord === '' || /^(above|agl|up|please|wren|over|msl|altitude|height|and|now|then|for)$/.test(unitWord)) unit = units === 'aviation' ? 'feet' : 'metres';
  else return null;
  const metres = unit === 'feet' ? number.value * FEET : unit === 'km' ? number.value * 1000 : number.value;
  if (!(metres >= 0) || metres > MAX_WIND_ALTITUDE) return null;
  return { metres, reference, unit, value: number.value };
}

/** "2,000" for speech and subtitles. */
function grouped(value) {
  return Math.round(value).toLocaleString('en-US');
}

/** A height for speech in the units asked: "2,000 feet", "3 km", "1,500 metres". */
export function describeHeight(metres, unit) {
  if (unit === 'feet') return `${grouped(metres / FEET)} feet`;
  if (unit === 'km' || metres >= 10000) {
    const kilometres = metres / 1000;
    return `${Number.isInteger(Math.round(kilometres * 10) / 10) ? Math.round(kilometres) : kilometres.toFixed(1)} km`;
  }
  return `${grouped(metres)} metres`;
}

/** A wind for speech: "from the south-west, 220 degrees, at 15 knots", or calm. */
export function describeWind(vx, vz, units) {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.5) return 'calm';
  const from = wrapDegrees(headingFromVector(vx, vz) + 180);
  return `from the ${compassName(from)}, ${headingDigits(from)} degrees, at ${formatSpeed(speed, units).text}`;
}

// ---- Grammar ---------------------------------------------------------------------------------------------------
/**
 * The cross-craft matchers for the local brain, (text, flight, core) => reply | null like the others.
 * They run before the tour guide's ("take me to space" is not the celestial category) and the craft's
 * own commands ("find a perch" is the waypoint search on every craft).
 */
export function createCraftGuideGrammar() {
  const commandsOf = (flight) => (Array.isArray(flight.craftCommands) ? flight.craftCommands : []);
  const hasCommand = (flight, id) => commandsOf(flight).some((command) => command && command.id === id);
  const wantsAutopilot = (text) => AUTOPILOT_WORDS.test(text);

  /** "Craft help": the cross-craft phrases and their keys and chips. */
  function matchCraftHelp(text) {
    if (!/\b(craft|aircraft|cross[- ]craft|flying|pilot)\b/.test(text) || !/\b(help|commands|what can (you|i) (do|say|ask))\b/.test(text)) return null;
    if (/\bguide\b/.test(text)) return null;
    return {
      speech: "Craft commands: 'switch to the stunt plane' (keys 1-0, [ and ], the picker; 'the dragon' picks the eagle's skin), 'smoke on' (Space), 'find water to land' and 'find a perch' (Guide chips), 'wind at 2000 feet' (the balloon's wind column), 'start the challenge' (Y), 'take me to space' (the To space chip), 'scenic cruise' (Space on the airship).",
      action: null,
    };
  }

  /** "Don't start the challenge", "do not take me to space": answered, nothing started or stopped. */
  function matchNegated(text) {
    if (!NEGATED_REQUEST.test(text) || !GUIDE_SUBJECT.test(text)) return null;
    return { speech: "All right, I'll leave that be.", action: null };
  }

  /** "Take me to space", "climb to space"; "abort the climb" stops it. */
  function matchToSpace(text) {
    const space = /\b(?:(?:in)?to|reach|make it to|get to) (?:outer |the edge of )?space\b|\bkarman line\b|\bspace ?flight\b|^space( please)?$/;
    if (!space.test(text) && !/\b(abort|cancel|stop) (the )?(space climb|climb to space)\b/.test(text)) return null;
    if (/\b(what|how|when|why|is|are) .*\bspace\b/.test(text) && !/\b(take|fly|get|climb|go|launch|send|bring)\b/.test(text)) return null;
    const stop = NEGATION.test(text);
    if (!stop && !/\b(take|fly|get|climb|go|launch|send|bring|blast|rocket|head|let'?s|want|reach|make it|up|space ?flight)\b|^space( please)?$/.test(text)) return null;
    return { speech: '', action: stop ? { type: 'toSpace', enabled: false } : { type: 'toSpace' } };
  }

  /** "Scenic cruise", "start a scenic tour", "scenic cruise off". */
  function matchScenicCruise(text, flight) {
    if (!/\b(scenic|sightseeing) (cruise|tour|flight|route|trip)\b/.test(text)) return null;
    if (QUESTION.test(text)) {
      // "Is the scenic cruise on?": answered from the airship's state, never switched.
      const cruise = flight.craftState && flight.craftState.scenicCruise;
      if (!cruise || typeof cruise.active !== 'boolean') return { speech: "The scenic cruise is the airship's autopilot. Say 'scenic cruise' to start one.", action: null };
      return { speech: cruise.active ? 'The scenic cruise is on.' : "The scenic cruise is off. Say 'scenic cruise' to start one.", action: null };
    }
    const off = /\b(off|stop|end|cancel|abort|enough|quit)\b/.test(text);
    if (hasCommand(flight, 'scenicCruise')) return { speech: '', action: { type: 'craftCommand', craft: flight.craft, command: 'scenicCruise', value: off ? 'stop' : 'start' } };
    return { speech: '', action: off ? { type: 'scenicCruise', enabled: false } : { type: 'scenicCruise', enabled: true } };
  }

  /** "Smoke on", "turn the smoke off", "start the smoke"; not "is that smoke?" or "smoke on the water". */
  function matchSmoke(text, flight) {
    if (!/\bsmoke\b/.test(text) || /\bcolou?r\b/.test(text)) return null;
    if (QUESTION.test(text) || /\bsmoke on the\b/.test(text)) {
      // "Is the smoke on?", "smoke on the water": answered, never switched (the craft's own phrase would).
      if (!/\bsmoke (on|off)\b/.test(text)) return null;
      const smoke = flight.craftState && typeof flight.craftState.smoke === 'boolean' ? flight.craftState.smoke : null;
      return { speech: smoke === null ? "Say 'smoke on' or 'smoke off' when you want it." : `The smoke is ${smoke ? 'on' : 'off'}.`, action: null };
    }
    const off = /\b(smoke off|(stop|turn off|switch off|kill|cut|end|no more|enough)( the| our)? smoke|turn (the )?smoke off|switch (the )?smoke off)\b/.test(text);
    const on = !off && /\b(smoke on|smoke trails? on|(start|turn on|switch on|light|pop|lay|make|give me|fire up|let'?s (have|see))( the| our| some)? smoke( trails?)?|turn (the )?smoke on|switch (the )?smoke on|smoke (please|now))\b|^smoke$/.test(text);
    if (!on && !off) return null;
    if (hasCommand(flight, 'smoke')) return { speech: '', action: { type: 'craftCommand', craft: flight.craft, command: 'smoke', value: on ? 'on' : 'off' } };
    return { speech: '', action: { type: 'smoke', enabled: on } };
  }

  /** "Find water to land", "where can we land on water", "find a lake to land on", the bare "find water". */
  function matchFindWater(text) {
    const water = /\b(water|lake|lakes|pond|reservoir|sea|ocean|somewhere wet)\b/;
    const land = /\b(land|landing|touch ?down|splash ?down|set down|alight|put down)\b/;
    const bare = /^(find|locate|search for|look for|nearest|show me) (some |the |a |any )?(landable )?water( please)?$/.test(text) || /\blandable water\b/.test(text);
    const toLand = water.test(text) && land.test(text) && (FIND_VERB.test(text) || /\bwhere (can|do|should) (we|i)\b/.test(text) || /\bwater to land\b/.test(text));
    if (!bare && !toLand) return null;
    if (/\b(how|why|can'?t|cannot)\b.*\b(deep|cold|wet)\b/.test(text)) return null;
    return { speech: '', action: { type: 'findWater', autopilot: wantsAutopilot(text) } };
  }

  /** "Find a perch", "nearest perch", "where can I perch"; not "are we perched". */
  function matchFindPerch(text) {
    if (!/\bperch(es)?\b/.test(text) && !/\bsomewhere to perch\b|\bwhere (can|do|should) (we|i) perch\b/.test(text)) return null;
    if (/\b(am|are|is) (i|we|it) perched\b|\bperched\?\b/.test(text)) return null;
    if (!FIND_VERB.test(text) && !/^(a |the )?perch( please)?$/.test(text) && !/\b(somewhere to|where (can|do|should) (we|i)) perch\b/.test(text) && !/\bland on (a|the) (nearest |closest )?perch\b/.test(text)) return null;
    return { speech: '', action: { type: 'findPerch', autopilot: wantsAutopilot(text) } };
  }

  /** "Wind at 2000 feet", "what's the wind at three kilometres", "winds at 1,500 m", "what's the wind". */
  function matchWindAt(text, flight) {
    if (WIND_HERE.test(text)) return { speech: '', action: { type: 'windAt' } };
    const wind = WIND_WORD.exec(text);
    if (!wind) return null;
    const pilotUnits = flight.units === 'aviation' ? 'aviation' : 'metric';
    let height = null;
    WIND_AT.lastIndex = wind.index;
    for (let match = WIND_AT.exec(text); match && !height; match = WIND_AT.exec(text)) height = parseAltitude(text.slice(match.index + match[0].length), pilotUnits);
    if (!height) return null;
    const action = { type: 'windAt', altitude: Math.round(height.metres * 10) / 10, unit: height.unit };
    if (height.reference === 'agl') action.reference = 'agl';
    return { speech: '', action };
  }

  /** "Start the challenge", "let's race the challenge", "cancel the challenge". */
  function matchChallenge(text) {
    if (!/\bchallenges?\b/.test(text)) return null;
    if (/\b(cancel|stop|abort|quit|end|abandon|forget|drop|give up)\b/.test(text)) return { speech: '', action: { type: 'challengeCancel' } };
    const start = /\b(start|begin|run|fly|race|try|do|take on|go for|arm|let'?s go|ready)\b/.test(text) || /^(the |a )?challenge( please| now)?$/.test(text);
    if (!start || /\b(how|what|which|best|record|results?|score|time was)\b/.test(text)) return null;
    return { speech: '', action: { type: 'challengeStart' } };
  }

  return {
    /** Runs before the general help. */
    matchHelp: matchCraftHelp,
    /** In priority order: they run before the tour guide's, the craft's own and the v1 matchers. */
    matchers: [matchNegated, matchToSpace, matchScenicCruise, matchSmoke, matchFindWater, matchFindPerch, matchWindAt, matchChallenge],
  };
}

/** Validates one cross-craft action (type already checked). Returns a clean copy or null. */
export function sanitizeCraftGuideAction(raw) {
  const present = (value) => value !== undefined && value !== null;
  const action = { type: raw.type };
  switch (raw.type) {
    case 'findWater':
    case 'findPerch':
      if (present(raw.autopilot)) {
        if (typeof raw.autopilot !== 'boolean') return null;
        action.autopilot = raw.autopilot;
      }
      return action;
    case 'windAt': {
      // altitude (m) is optional: without it, the wind where we fly. reference 'msl' (default) | 'agl';
      // unit 'metres' | 'feet' | 'km' is how WREN says the height back.
      if (present(raw.altitude)) {
        if (typeof raw.altitude !== 'number' || !Number.isFinite(raw.altitude) || raw.altitude < 0 || raw.altitude > MAX_WIND_ALTITUDE) return null;
        action.altitude = raw.altitude;
      }
      if (present(raw.reference)) {
        if (raw.reference !== 'msl' && raw.reference !== 'agl') return null;
        action.reference = raw.reference;
      }
      if (present(raw.unit)) {
        if (!['metres', 'feet', 'km'].includes(raw.unit)) return null;
        action.unit = raw.unit;
      }
      return action;
    }
    case 'toSpace':
    case 'scenicCruise':
    case 'smoke':
      if (present(raw.enabled)) {
        if (typeof raw.enabled !== 'boolean') return null;
        action.enabled = raw.enabled;
      }
      return action;
    default:
      // challengeStart and challengeCancel take no parameters.
      return action;
  }
}

// ---- The guide in the running game -----------------------------------------------------------------------------
/**
 * Creates the cross-craft guide. helpers: { succeed(text, informative), fail(text), pick(key, lines),
 * placeWaypoint(x, z, label) -> placed | null, engageFollow() -> boolean, directionPhrase(bearing,
 * heading), waiter ({ wait(check, seconds) }), setCraft(action) -> result (the flight action) }.
 * Returns { handlers, handleReply, snapshotFields, hasConfirm, getConfirm, update, getStats }.
 */
export function createCraftGuide(ctx, helpers) {
  const { bus, state, settings, world } = ctx;
  const { succeed, fail, placeWaypoint, engageFollow, directionPhrase, waiter, setCraft } = helpers;
  const registry = ctx.craftRegistry;
  const windPoint = new ctx.THREE.Vector3();
  const windSample = { vel: new ctx.THREE.Vector3(), turbulence: 0 };
  const waterSample = {};
  const nearestPerch = { found: false, x: 0, y: 0, z: 0, kind: '', distance: Infinity, fromX: 0, fromZ: 0 };
  let confirm = null;
  const counters = { waters: 0, perches: 0, winds: 0, challenges: 0, confirmsOpened: 0, confirmsAccepted: 0, confirmsDeclined: 0, confirmsLapsed: 0 };

  const now = () => state.time.realElapsed;
  const player = () => state.player;
  const flight = () => ctx.systems.flight;
  const units = () => (settings.get('units') === 'aviation' ? 'aviation' : 'metric');

  function activeCraft() {
    const system = flight();
    return typeof system?.getCraft === 'function' ? system.getCraft() : state.flight.craft;
  }

  function activeModule() {
    const system = flight();
    return typeof system?.getCraftModule === 'function' ? system.getCraftModule() : registry?.get?.(activeCraft()) ?? null;
  }

  /** "the bush plane", or the skin's name for a craft flying in one. */
  function craftPhrase(id) {
    const system = flight();
    const module = registry?.get?.(id) ?? null;
    if (id === activeCraft() && module?.skins && typeof system?.getSkin === 'function') {
      const skin = module.skins.list.find((entry) => entry.id === system.getSkin());
      if (skin) return `the ${skin.name.toLowerCase()}`;
    }
    // A craft with skins, not flying now, goes by its default skin ("the eagle", not "the eagle / dragon").
    const fallback = module?.skins ? module.skins.list.find((entry) => entry.id === module.skins.default) : null;
    const entry = registry?.entry?.(id) ?? null;
    const name = fallback ? fallback.name : entry ? entry.name : id;
    return `the ${/^[A-Z]{2,}/.test(name) ? name : name.toLowerCase()}`;
  }

  /** "the seaplane, the balloon and the paraglider": the installed craft that pass test(module). */
  function craftWith(test) {
    const names = [];
    for (const entry of registry?.list ? registry.list() : []) {
      const module = entry.available ? registry.get(entry.id) : null;
      if (module && test(module)) names.push(craftPhrase(entry.id));
    }
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  const landsOnWater = (module) => Boolean(module && (module.capabilities?.water === true || module.limits?.waterLanding || module.limits?.floats === true));
  const perches = (module) => Boolean(module && module.capabilities?.perch === true);
  /** Smoke: declared, or a craft whose own state carries a smoke switch (the bush plane). */
  function hasSmoke(module, craftState) {
    if (typeof module?.capabilities?.smoke === 'boolean') return module.capabilities.smoke;
    return Boolean(craftState && typeof craftState.smoke === 'boolean');
  }
  const smokeCraft = (module) => hasSmoke(module, typeof module?.abilities?.craftAbility?.initialState === 'function' ? module.abilities.craftAbility.initialState() : null);

  function measure(x, z) {
    const position = player().position;
    const distance = Math.hypot(x - position.x, z - position.z);
    const bearing = bearingTo(position.x, position.z, x, z);
    return { distance, bearing, phrase: `${formatDistance(distance)} ${directionPhrase(bearing, player().heading)}, heading ${headingDigits(bearing)}` };
  }

  /** Places the beacon and says where it is; the autopilot follows when asked. */
  function guideTo(x, z, label, lead, autopilotWanted, note = '') {
    const placed = placeWaypoint(x, z, label);
    if (!placed) return fail("I found it, but couldn't place the beacon.");
    const target = measure(x, z);
    const autopilot = autopilotWanted === true && engageFollow();
    let text = `${lead} ${target.phrase}.`;
    if (note) text += ` ${note}`;
    text += autopilot ? ' Waypoint set, autopilot engaged.' : ' Waypoint set.';
    return succeed(text, true);
  }

  // ---- Water -------------------------------------------------------------------------------------------------
  function presetName(presetId) {
    const preset = presetId ? ctx.systems.spawns?.manager?.getPreset?.(presetId) : null;
    return preset && typeof preset.name === 'string' ? preset.name : null;
  }

  /** The nearest local lake big and deep enough to land on: { x, z, distance, name } or null. */
  function nearestLake(x, z) {
    const query = ctx.waterQuery;
    if (typeof query?.bodiesNear !== 'function') return null;
    let best = null;
    query.bodiesNear(x, z, LAKE_RADIUS, (record) => {
      if (record.material !== 'water' || record.kind === 'thin') return;
      const bounds = record.bounds;
      if (Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) < MIN_LAKE_SPAN) return;
      query.sample(record.x, record.z, state.time.elapsed, waterSample);
      if (waterSample.kind !== 'lake' || !(waterSample.depth >= MIN_LAKE_DEPTH)) return;
      const distance = Math.hypot(record.x - x, record.z - z);
      if (best && distance >= best.distance) return;
      best = { x: record.x, z: record.z, distance, name: presetName(record.presetId), kind: record.kind };
    });
    return best;
  }

  /**
   * The nearest open sea with room to land: rings out from (x, z) to `limit`, a sea point whose ray
   * stays deep sea SEA_RUNWAY further out. Returns { x, z, distance } (the point past the shore) or null.
   */
  function nearestSea(x, z, limit) {
    const query = ctx.waterQuery;
    if (typeof query?.isOcean !== 'function') return null;
    const deep = (pointX, pointZ) => query.isOcean(pointX, pointZ) && query.groundHeight(pointX, pointZ) < query.seaLevel - SEA_MIN_DEPTH;
    if (deep(x, z)) return { x, z, distance: 0 };
    for (let radius = OCEAN_STEP; radius <= limit; radius += OCEAN_STEP) {
      const samples = Math.max(12, Math.ceil((2 * Math.PI * radius) / OCEAN_STEP));
      for (let sample = 0; sample < samples; sample++) {
        const angle = (sample / samples) * Math.PI * 2;
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        const pointX = x + sin * radius;
        const pointZ = z - cos * radius;
        if (!deep(pointX, pointZ) || !deep(pointX + sin * SEA_RUNWAY, pointZ - cos * SEA_RUNWAY)) continue;
        return { x: pointX + sin * SEA_RUNWAY * 0.5, z: pointZ - cos * SEA_RUNWAY * 0.5, distance: radius + SEA_RUNWAY * 0.5 };
      }
    }
    return null;
  }

  // ---- Perches ------------------------------------------------------------------------------------------------
  function visitPerch(x, y, z, kind) {
    const distance = Math.hypot(x - nearestPerch.fromX, z - nearestPerch.fromZ);
    if (distance >= nearestPerch.distance) return;
    nearestPerch.found = true;
    nearestPerch.x = x;
    nearestPerch.y = y;
    nearestPerch.z = z;
    nearestPerch.kind = kind;
    nearestPerch.distance = distance;
  }

  /** The nearest perch in widening rings around the ground under the craft, into nearestPerch. */
  function findNearestPerch() {
    const colliders = ctx.colliders;
    nearestPerch.found = false;
    nearestPerch.distance = Infinity;
    if (typeof colliders?.perchesNear !== 'function') return false;
    const position = player().position;
    nearestPerch.fromX = position.x;
    nearestPerch.fromZ = position.z;
    const ground = world.groundHeight(position.x, position.z);
    for (const radius of PERCH_RADII) {
      colliders.perchesNear(position.x, ground, position.z, radius, visitPerch);
      if (nearestPerch.found && nearestPerch.distance <= radius) return true;
    }
    return nearestPerch.found;
  }

  const PERCH_WORDS = Object.freeze({ tree: 'a tree top', structure: 'a ledge on a structure', peak: 'a rocky peak' });
  const PERCH_LABELS = Object.freeze({ tree: 'Tree-top perch', structure: 'Ledge perch', peak: 'Peak perch' });

  // ---- Confirm offers (a yes / no before a craft switch) -------------------------------------------------------
  function setConfirm(next) {
    confirm = next;
    bus.emit('copilot:confirm', confirm ? { active: true, kind: confirm.kind, craft: confirm.craft, question: confirm.question, expiresIn: CONFIRM_SECONDS } : { active: false });
  }

  function openConfirm(kind, craft, command, value, question) {
    counters.confirmsOpened++;
    setConfirm({ kind, craft, command, value, question, expiresAt: now() + CONFIRM_SECONDS });
    return succeed(question);
  }

  /** After the switch: the command on the new craft, once the controller flies it. */
  async function switchAndRun(offer) {
    const switched = setCraft({ type: 'setCraft', craft: offer.craft });
    if (!switched.ok) return switched;
    const flying = await waiter.wait(() => state.flight.craft === offer.craft && !(state.flight.crash && state.flight.crash.active), 2);
    if (!flying) return fail(`${switched.text} It isn't flying yet, so ask me again in a moment.`);
    const system = flight();
    const result = system.runCraftCommand(offer.command, offer.value);
    if (!result.ok) return fail(`${switched.text} ${result.text}`);
    return succeed(`${switched.text} ${result.text}`);
  }

  /**
   * Answers a "yes" or a "no" to an open confirm offer, whatever brain is active. Returns a promise of
   * { speech, ok } or null when the text is not an answer (or no offer is open).
   */
  function handleReply(text) {
    if (!confirm) return null;
    if (now() > confirm.expiresAt) {
      counters.confirmsLapsed++;
      setConfirm(null);
      return null;
    }
    const answer = offerAnswer(text);
    if (!answer) return null;
    const offer = confirm;
    setConfirm(null);
    if (answer === 'no') {
      counters.confirmsDeclined++;
      return Promise.resolve({ speech: `Staying in ${craftPhrase(activeCraft())}, then.`, ok: true });
    }
    counters.confirmsAccepted++;
    return switchAndRun(offer).then((result) => ({ speech: result.text, ok: result.ok }));
  }

  // ---- Handlers -------------------------------------------------------------------------------------------------
  const handlers = {
    /** "Find water to land": the nearest lake big enough or the open sea, whichever is closer. */
    findWater(action) {
      counters.waters++;
      const position = player().position;
      const lake = nearestLake(position.x, position.z);
      const sea = nearestSea(position.x, position.z, lake ? Math.min(lake.distance, OCEAN_RADIUS) : OCEAN_RADIUS);
      const module = activeModule();
      const note = landsOnWater(module) ? '' : `${craftPhrase(activeCraft()).replace(/^t/, 'T')} can't land on water, mind: ${craftWith(landsOnWater)} can.`;
      const choice = sea && (!lake || sea.distance < lake.distance) ? { ...sea, kind: 'sea' } : lake;
      if (!choice) return fail(`No landable water within ${Math.round(LAKE_RADIUS / 1000)} km. Lakes sit in basins and valleys, and the sea is past the coast; let's look further on.`);
      if (choice.distance < OVER_WATER) {
        return succeed(`We're over landable water right now: ${choice.kind === 'sea' ? 'the open sea' : `the ${choice.name ? choice.name.toLowerCase() : 'lake'}`} below us.${note ? ` ${note}` : ''}`, true);
      }
      const label = choice.kind === 'sea' ? 'Open sea' : choice.name || 'Lake';
      const lead = choice.kind === 'sea' ? 'Nearest landable water: the open sea,' : `Nearest landable water: ${choice.name ? `the ${choice.name.toLowerCase()}` : 'a lake'},`;
      return guideTo(choice.x, choice.z, label, lead, action.autopilot, note);
    },

    /** "Find a perch": the nearest tree top or structure top; the eagle flies in itself when it is close. */
    findPerch(action) {
      counters.perches++;
      const craft = activeCraft();
      const module = activeModule();
      if (craft === 'eagle' && state.flight.craftState?.perched === true) return succeed('We are perched already. Raise the flap power to fly.');
      if (!findNearestPerch()) return fail(`No perch within ${formatDistance(PERCH_RADII[PERCH_RADII.length - 1])}. Perches are tree tops and the tops of tall structures; fly over the forest and ask again.`);
      const perch = { ...nearestPerch };
      const height = Math.round(perch.y - world.groundHeight(perch.x, perch.z));
      const label = PERCH_LABELS[perch.kind] ?? 'Perch';
      const what = PERCH_WORDS[perch.kind] ?? 'a perch';
      if (perches(module) && perch.distance <= EAGLE_APPROACH && typeof flight()?.runCraftCommand === 'function') {
        // Close enough for the eagle's own approach (its craftCommand findPerch flies it in).
        const result = flight().runCraftCommand('findPerch');
        if (result.ok && state.flight.craftState?.perchTarget) {
          placeWaypoint(perch.x, perch.z, label);
          return succeed(result.text, true);
        }
      }
      const note = perches(module) ? `It is ${height} metres up; come in slow and the eagle lands on it.` : `It is ${height} metres up; only ${craftWith(perches)} can perch there.`;
      return guideTo(perch.x, perch.z, label, `Nearest perch: ${what},`, action.autopilot, note);
    },

    /** "Wind at [altitude]": the WindField over the craft at that height (or here without one). */
    windAt(action) {
      counters.winds++;
      const field = ctx.wind;
      if (typeof field?.probe !== 'function') return fail("I can't read the wind right now.");
      const position = player().position;
      const pilotUnits = units();
      const ground = Math.max(world.groundHeight(position.x, position.z), Number.isFinite(world.WATER_LEVEL) ? world.WATER_LEVEL : -Infinity);
      const here = state.flight.wind;
      const hereText = here ? describeWind(here.x, here.z, pilotUnits) : null;
      if (!Number.isFinite(action.altitude)) {
        if (!hereText) return fail("I can't read the wind right now.");
        return succeed(`Wind here, at ${describeHeight(position.y, pilotUnits === 'aviation' ? 'feet' : 'metres')}: ${hereText}.`, true);
      }
      const unit = action.unit ?? (pilotUnits === 'aviation' ? 'feet' : 'metres');
      let altitude = action.reference === 'agl' ? ground + action.altitude : action.altitude;
      const asked = `${describeHeight(action.altitude, unit)}${action.reference === 'agl' ? ' above the ground' : ''}`;
      let lead = `At ${asked}`;
      if (altitude < ground + WIND_FLOOR) {
        altitude = ground + WIND_FLOOR;
        lead = `${describeHeight(action.altitude, unit).replace(/^./, (letter) => letter.toUpperCase())} is under the ground here (it rises to ${describeHeight(ground, unit)}), so just above it`;
      }
      windPoint.set(position.x, altitude, position.z);
      field.probe(windPoint, state.time.elapsed, windSample);
      const vel = windSample.vel;
      let text = `${lead}: wind ${describeWind(vel.x, vel.z, pilotUnits)}.`;
      if (Math.abs(vel.y) >= 0.5) text += ` ${vel.y > 0 ? 'Rising' : 'Sinking'} air, ${Math.abs(vel.y).toFixed(1)} metres a second.`;
      if (hereText && Math.abs(altitude - position.y) > 100) text += ` Here it's ${hereText}.`;
      if (activeCraft() === 'balloon') text += ' The wind column on the HUD shows every layer.';
      return succeed(text, true);
    },

    /** "Start the challenge": the course whose start prompt is up; else a waypoint to the nearest start gate. */
    challengeStart() {
      counters.challenges++;
      const challenges = ctx.systems.challenges;
      if (typeof challenges?.start !== 'function') return fail("Challenges aren't running here.");
      const live = state.challenge ?? null;
      if (live && live.active && (live.phase === 'armed' || live.phase === 'running')) {
        return succeed(live.phase === 'armed' ? `${live.name} is armed: fly through the start gate.` : `We're on ${live.name} already: gate ${live.gateIndex + 1} of ${live.gatesTotal}.`);
      }
      const prompt = live && live.prompt ? live.prompt : null;
      if (prompt) {
        if (!challenges.start(prompt.courseKey, { source: 'copilot' })) return fail(`${prompt.name} isn't there any more.`);
        const best = typeof challenges.getBest === 'function' ? challenges.getBest(prompt.courseKey, activeCraft()) : null;
        const bestText = best ? ` Your best in ${craftPhrase(activeCraft())}: ${best.time.toFixed(1)} seconds${best.medal && best.medal !== 'none' ? `, ${best.medal}` : ''}.` : '';
        const armedNow = state.challenge && state.challenge.phase === 'running' ? 'The clock is running.' : `The start gate is ${formatDistance(prompt.distance)} ${directionPhrase(prompt.bearing, player().heading)}; fly through it to start the clock.`;
        return succeed(`${prompt.name}, armed. ${armedNow}${bestText}`);
      }
      const nearest = typeof challenges.nearest === 'function' ? challenges.nearest(COURSE_SEARCH) : null;
      if (!nearest) return fail(`No challenge course within ${Math.round(COURSE_SEARCH / 1000)} km. They come with sites like the canyon gauntlet and the kite slalom; I'll call one out when it's near.`);
      const position = player().position;
      const radians = (nearest.bearing * Math.PI) / 180;
      const x = position.x + Math.sin(radians) * nearest.distance;
      const z = position.z - Math.cos(radians) * nearest.distance;
      return guideTo(x, z, nearest.name, `No course close enough to start. The nearest, ${nearest.name}, is`, false, 'Fly to its start gate and ask again, or press Y at the prompt.');
    },

    challengeCancel() {
      const challenges = ctx.systems.challenges;
      const live = state.challenge ?? null;
      if (!live || !live.active || (live.phase !== 'armed' && live.phase !== 'running')) return fail("There's no challenge running.");
      // state.challenge is cleared in place by the cancel, so the name is read first.
      const name = typeof live.name === 'string' && live.name ? live.name : 'The challenge';
      if (typeof challenges?.cancel !== 'function' || !challenges.cancel('cancelled')) return fail("I couldn't call the challenge off.");
      return succeed(`${name} cancelled.`);
    },

    /** "Take me to space": the spaceplane's climb; from another craft, a yes / no offer to switch first. */
    toSpace(action) {
      const system = flight();
      if (typeof system?.runCraftCommand !== 'function') return fail("The flight controller isn't answering right now.");
      const inSpaceplane = activeCraft() === 'spaceplane';
      if (action.enabled === false) {
        if (!inSpaceplane) return fail("We're not climbing to space.");
        const stopped = system.runCraftCommand('climbToSpace', 'abort');
        return stopped.ok ? succeed(stopped.text) : fail(stopped.text);
      }
      if (inSpaceplane) {
        const result = system.runCraftCommand('climbToSpace');
        return result.ok ? succeed(result.text) : fail(result.text);
      }
      if (!registry?.has?.('spaceplane')) return fail("Space needs the spaceplane, and it isn't in this hangar.");
      return openConfirm('toSpace', 'spaceplane', 'climbToSpace', undefined, `That's a job for the spaceplane. Switch from ${craftPhrase(activeCraft())} to the spaceplane and climb to space? Yes or no.`);
    },

    /** "Scenic cruise": the airship's; from another craft, a yes / no offer to switch first. */
    scenicCruise(action) {
      const system = flight();
      if (typeof system?.runCraftCommand !== 'function') return fail("The flight controller isn't answering right now.");
      const wanted = action.enabled !== false;
      if (activeCraft() === 'airship') {
        const result = system.runCraftCommand('scenicCruise', wanted ? 'start' : 'stop');
        return result.ok ? succeed(result.text) : fail(result.text);
      }
      if (!wanted) return fail("There's no scenic cruise running: that's the airship's autopilot.");
      if (!registry?.has?.('airship')) return fail("The scenic cruise is the airship's, and it isn't in this hangar.");
      return openConfirm('scenicCruise', 'airship', 'scenicCruise', 'start', `The scenic cruise is the airship's autopilot. Switch to the airship and start one? Yes or no.`);
    },

    /** "Smoke on / off": the craft's own smoke command, else its smoke ability, else a plain answer. */
    async smoke(action) {
      const system = flight();
      const module = activeModule();
      const craftState = state.flight.craftState;
      const on = action.enabled !== false;
      const word = on ? 'on' : 'off';
      const commands = module?.copilot?.commands ?? [];
      if (commands.some((command) => command.id === 'smoke') && typeof system?.runCraftCommand === 'function') {
        const result = system.runCraftCommand('smoke', word);
        return result.ok ? succeed(result.text) : fail(result.text);
      }
      if (!hasSmoke(module, craftState)) {
        const carriers = craftWith(smokeCraft);
        return fail(`No smoke system on ${craftPhrase(activeCraft())}.${carriers ? ` ${carriers.replace(/^t/, 'T')} carry smoke.` : ''}`);
      }
      if (craftState.smoke === on) return succeed(`The smoke's already ${word}.`);
      if (typeof system?.runAbility !== 'function' || !system.runAbility('craftAbility')) return fail("The smoke didn't answer.");
      const done = await waiter.wait(() => state.flight.craftState?.smoke === on);
      return done ? succeed(on ? 'Smoke on.' : 'Smoke off.') : fail(`The smoke is still ${on ? 'off' : 'on'}.`);
    },
  };

  bus.onTyped('craftChanged', () => {
    // An offer to switch to a craft we are now flying (the picker got there first) is moot.
    if (confirm && confirm.craft === activeCraft()) setConfirm(null);
  });

  return {
    handlers,
    handleReply,
    /** The remote brain's field: the open confirm offer, or null. */
    snapshotFields() {
      const open = confirm && now() <= confirm.expiresAt ? confirm : null;
      return { confirm: open ? { kind: open.kind, craft: open.craft, question: open.question, expiresIn: Math.max(0, Math.round((open.expiresAt - now()) * 10) / 10) } : null };
    },
    /** Whether a yes / no offer is open (no allocation: the callout gate asks every frame). */
    hasConfirm: () => confirm !== null,
    getConfirm: () => (confirm ? { kind: confirm.kind, craft: confirm.craft, question: confirm.question, expiresIn: Math.max(0, confirm.expiresAt - now()) } : null),
    update() {
      if (confirm && now() > confirm.expiresAt) {
        counters.confirmsLapsed++;
        setConfirm(null);
      }
    },
    getStats() {
      return { ...counters, confirm: confirm ? { kind: confirm.kind, craft: confirm.craft, expiresIn: Math.round(Math.max(0, confirm.expiresAt - now()) * 10) / 10 } : null };
    },
  };
}
