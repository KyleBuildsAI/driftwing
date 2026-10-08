import { clamp } from '../core/util.js';
import { CRAFT_IDS } from '../core/settings.js';

/**
 * WREN's v2 grammar: the aircraft commands (craft, assists, views, chute, engine, relaunch,
 * calibration, switching to version one, and each craft's own commands through craftCommand) and
 * the flight questions (airspeed, landing, the craft's status), plus the strict schema of the
 * matching remote actions. Everything here is pure: the matchers turn a normalized transcript and
 * the flight-state snapshot into { speech, action }, and the executor (flightActions.js) carries the
 * actions out and reports what really happened.
 */

export const FLIGHT_ACTION_TYPES = Object.freeze([
  'setCraft', 'setAssists', 'setView', 'deployChute', 'engine', 'relaunch', 'calibrate', 'switchVersion', 'craftCommand',
]);
/** A craft command id (module copilot.commands[].id, contract h.6). */
const COMMAND_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
/** The longest string value a craftCommand carries. */
const MAX_COMMAND_VALUE_LENGTH = 48;
/** The versions switchVersion can ask for: V2 can only hand over to V1 (the shell switches back). */
export const SWITCH_VERSIONS = Object.freeze(['v1']);
export const ASSIST_CHANGES = Object.freeze(['up', 'down', 'full', 'off']);
/**
 * setView targets: 'cockpit' (the first-person view; the drone's FPV camera), the third-person
 * 'chase', 'wing' and 'flyby', and 'outside' (the craft's last third-person view).
 */
export const VIEW_TARGETS = Object.freeze(['cockpit', 'chase', 'wing', 'flyby', 'outside']);
/** Assists up / down move along this grid (0, 25, 50, 75, 100 percent). */
export const ASSIST_STEP = 0.25;

/** Spoken craft names and their synonyms, most specific first. */
const CRAFT_SYNONYMS = Object.freeze([
  ['glider', /\b(glider|sailplane|sail plane|sailer)\b/],
  ['bushplane', /\b(bush ?plane|super ?cub|cub|tail ?dragger|piper)\b/],
  ['jet', /\b(jet|fighter|fighter jet|fast jet)\b/],
  ['helicopter', /\b(helicopter|heli|helo|chopper|copter)\b/],
  ['wingsuit', /\b(wing ?suit|squirrel suit|bird ?suit)\b/],
  ['fpv', /\b(fpv|drone|quad|quadcopter|quad copter|racing drone)\b/],
]);

const CRAFT_VERB = /\b(switch|change|swap|go|fly|flying|take|use|give me|let me|i want|i'd like|get in|hop in|jump in|put (me|us) in|try|back to|to the|into the|craft|aircraft|plane)\b/;
const CRAFT_FILLER = new Set(['to', 'in', 'into', 'fly', 'flying', 'switch', 'change', 'swap', 'take', 'use', 'try', 'go', 'back', 'let', 'let\'s', 'craft', 'aircraft', 'please']);

/** Craft id named in the text, or null. */
export function findCraft(text) {
  for (const [id, pattern] of CRAFT_SYNONYMS) if (pattern.test(text)) return id;
  return null;
}

/**
 * Validates one v2 flight action (type already checked). Returns a clean copy or null; every
 * parameter is checked strictly, unknown values are refused rather than guessed.
 */
export function sanitizeFlightAction(raw) {
  const present = (value) => value !== undefined && value !== null;
  const action = { type: raw.type };
  switch (raw.type) {
    case 'setCraft': {
      const craft = typeof raw.craft === 'string' ? raw.craft.toLowerCase() : '';
      if (!CRAFT_IDS.includes(craft)) return null;
      action.craft = craft;
      return action;
    }
    case 'setAssists': {
      // Exactly one of level (0..1) or change ('up' | 'down' | 'full' | 'off').
      if (present(raw.level) === present(raw.change)) return null;
      if (present(raw.level)) {
        if (typeof raw.level !== 'number' || !Number.isFinite(raw.level) || raw.level < 0 || raw.level > 1) return null;
        action.level = Math.round(raw.level * 100) / 100;
        return action;
      }
      const change = typeof raw.change === 'string' ? raw.change.toLowerCase() : '';
      if (!ASSIST_CHANGES.includes(change)) return null;
      action.change = change;
      return action;
    }
    case 'setView': {
      const view = typeof raw.view === 'string' ? raw.view.toLowerCase() : '';
      if (!VIEW_TARGETS.includes(view)) return null;
      action.view = view;
      return action;
    }
    case 'engine':
      if (typeof raw.enabled !== 'boolean') return null;
      action.enabled = raw.enabled;
      return action;
    case 'calibrate':
      if (present(raw.calibrate) && typeof raw.calibrate !== 'boolean') return null;
      return action;
    case 'craftCommand': {
      // A craft module's own command (contract h.6): the craft it is for, the command id, and an
      // optional value (a finite number, a boolean, or a short string).
      const craft = typeof raw.craft === 'string' ? raw.craft.toLowerCase() : '';
      if (!CRAFT_IDS.includes(craft) || typeof raw.command !== 'string' || !COMMAND_PATTERN.test(raw.command)) return null;
      action.craft = craft;
      action.command = raw.command;
      if (present(raw.value)) {
        const value = raw.value;
        if (typeof value === 'number' && Number.isFinite(value)) action.value = value;
        else if (typeof value === 'boolean') action.value = value;
        else if (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_COMMAND_VALUE_LENGTH) action.value = value.trim();
        else return null;
      }
      return action;
    }
    case 'switchVersion': {
      // version is required and must name V1 exactly (case aside).
      const version = typeof raw.version === 'string' ? raw.version.toLowerCase() : '';
      if (!SWITCH_VERSIONS.includes(version)) return null;
      action.version = version;
      return action;
    }
    default:
      // deployChute and relaunch take no parameters.
      return action;
  }
}

/** Next assist level for a change, on the 25 % grid. */
export function nextAssistLevel(current, change) {
  const level = clamp(Number.isFinite(current) ? current : 1, 0, 1);
  const epsilon = 1e-6;
  switch (change) {
    case 'full': return 1;
    case 'off': return 0;
    case 'up': return clamp((Math.floor(level / ASSIST_STEP + epsilon) + 1) * ASSIST_STEP, 0, 1);
    default: return clamp((Math.ceil(level / ASSIST_STEP - epsilon) - 1) * ASSIST_STEP, 0, 1);
  }
}

// ---- Units ----------------------------------------------------------------------------------------------
const KNOTS_PER_MS = 1.943844;
const KMH_PER_MS = 3.6;
const FPM_PER_MS = 196.85;

/** A speed (m/s) in the player's units: { value, unit, text }. */
export function formatSpeed(metresPerSecond, units) {
  const aviation = units === 'aviation';
  const value = Math.round((Number.isFinite(metresPerSecond) ? metresPerSecond : 0) * (aviation ? KNOTS_PER_MS : KMH_PER_MS));
  const unit = aviation ? 'knots' : 'km/h';
  return { value, unit: aviation ? 'kt' : 'km/h', text: `${value} ${unit}` };
}

/** A sink rate (m/s) in the player's units: metres per second or feet per minute. */
export function formatSinkRate(metresPerSecond, units) {
  const sink = Math.max(0, Number.isFinite(metresPerSecond) ? metresPerSecond : 0);
  if (units === 'aviation') return `${Math.round((sink * FPM_PER_MS) / 10) * 10} feet a minute`;
  return `${sink.toFixed(1)} metres a second`;
}

const LANDING_WORDS = Object.freeze({ butter: 'Butter', smooth: 'Smooth', firm: 'Firm', hard: 'Hard' });
const LANDING_RANK = Object.freeze({ butter: 0, smooth: 1, firm: 2, hard: 3 });
const LANDING_QUIPS = Object.freeze({
  butter: ['The wheels barely noticed.', 'I only knew we were down when the rumble started.', 'Textbook. I may frame that one.'],
  smooth: ['A good, honest arrival.', 'Nicely done. The passengers would clap.', 'Smooth as you like.'],
  firm: ['You felt that one, but the gear did not mind.', 'Positive. Some call that a proper carrier landing.', 'A little firm, nothing a flare cannot fix.'],
  hard: ['That rattled my teeth, but no harm done.', 'The gear earned its pay there. Try a longer flare next time.', "Let's call that a firm arrival with character."],
});

/** Spoken airspeed report from the snapshot: indicated airspeed, plus ground speed and Mach when they matter. */
export function describeAirspeed(flight) {
  const airspeed = flight.airspeed;
  const units = flight.units === 'aviation' ? 'aviation' : 'metric';
  if (!airspeed || typeof airspeed !== 'object') {
    return `${Math.round(flight.speedKmh ?? 0)} km/h, throttle at ${Math.round((flight.throttle ?? 0) * 100)} percent.`;
  }
  const indicated = formatSpeed(airspeed.indicatedMs, units);
  const ground = formatSpeed(airspeed.groundSpeedMs, units);
  const parts = [`Indicated airspeed ${indicated.text}`];
  const difference = Math.abs(ground.value - indicated.value);
  if (difference >= Math.max(5, indicated.value * 0.08)) parts.push(`ground speed ${ground.value}`);
  if (Number.isFinite(airspeed.mach) && airspeed.mach >= 0.5) parts.push(`Mach ${airspeed.mach.toFixed(2)}`);
  let text = `${parts.join(', ')}.`;
  if (flight.capabilities?.throttle !== false) text += ` Throttle at ${Math.round((flight.throttle ?? 0) * 100)} percent.`;
  if (flight.onGround) text += " We're on the ground.";
  return text;
}

/** Spoken landing report from the snapshot's last and best landing. */
export function describeLanding(flight, pick) {
  const last = flight.lastLanding;
  const units = flight.units === 'aviation' ? 'aviation' : 'metric';
  if (!last || !(last.grade in LANDING_RANK)) {
    return "No landings yet this flight. Find a flat spot, slow down and keep the sink rate under half a metre a second for a butter.";
  }
  const sink = formatSinkRate(last.sinkRate, units);
  let text = `${LANDING_WORDS[last.grade]}: ${sink} at touchdown. ${pick(`landing-${last.grade}`, LANDING_QUIPS[last.grade])}`;
  const best = flight.bestLanding;
  const sameAsBest = best && best.grade === last.grade && best.sinkRate === last.sinkRate;
  if (best && !sameAsBest && best.grade in LANDING_RANK) {
    text += ` Your best is still a ${best.grade} landing at ${formatSinkRate(best.sinkRate, units)}.`;
  } else if (sameAsBest && flight.landingCount > 1) {
    text += ' That is your best landing yet.';
  }
  return text;
}

// ---- Matchers -------------------------------------------------------------------------------------------
/**
 * The v2 matchers for the local brain. Each is (text, flight, core) => reply | null, where text is the
 * normalized transcript, flight the snapshot and core the filler-free words. pick(key, lines) chooses a
 * phrasing without repeating the last one; helpLine() is the live help answer.
 */
export function createFlightGrammar({ pick, helpLine }) {
  /** Compiled craft-command phrases, by regex source (modules send sources; contract h.6). */
  const phraseCache = new Map();
  function phrasePattern(source) {
    let pattern = phraseCache.get(source);
    if (!pattern) {
      pattern = new RegExp(source, 'i');
      phraseCache.set(source, pattern);
    }
    return pattern;
  }

  /**
   * The active craft's own commands (flight.craftCommands: [{ id, phrases }]): the first phrase that
   * matches runs the command through craftCommand. A phrase's first capture group, when it has one,
   * is the value (a number when it reads as one).
   */
  function matchCraftCommand(text, flight) {
    const commands = Array.isArray(flight.craftCommands) ? flight.craftCommands : [];
    for (const command of commands) {
      if (!command || !Array.isArray(command.phrases)) continue;
      for (const source of command.phrases) {
        const match = phrasePattern(source).exec(text);
        if (!match) continue;
        const action = { type: 'craftCommand', craft: flight.craft, command: command.id };
        const captured = typeof match[1] === 'string' ? match[1].trim() : '';
        if (captured) {
          const number = Number(captured);
          action.value = Number.isFinite(number) ? number : captured.slice(0, MAX_COMMAND_VALUE_LENGTH);
        }
        return { speech: '', action };
      }
    }
    return null;
  }

  /** "Craft status", "systems check": the active craft's own report (module copilot.status). */
  function matchCraftStatus(text, flight) {
    if (!/\b(craft status|systems? (check|status|report)|status of the (craft|aircraft)|how('s| is) (the|our) (craft|aircraft|machine) doing)\b/.test(text)) return null;
    const status = typeof flight.craftStatus === 'string' ? flight.craftStatus.trim() : '';
    if (status) return { speech: status, action: null };
    return { speech: `All normal on ${flight.craftName ? `the ${flight.craftName.toLowerCase()}` : 'board'}. ${describeAirspeed(flight)}`, action: null };
  }

  function matchHelp(text) {
    if (!/\b(help|what can you do|what do you do|what can i (say|ask)|commands|how does (this|it) work|instructions|options|capabilities)\b/.test(text)) return null;
    return { speech: helpLine(), action: null };
  }

  function matchLanding(text, flight) {
    if (!/\b(how (was|did|about) (my|that|the|our|this) (last )?(landing|touchdown|arrival)|how did (i|we) land|landing (grade|report|score|rating)|rate (my|that|the) landing|my (best )?landings?|best landing|grade (my|that) landing)\b/.test(text)) return null;
    return { speech: describeLanding(flight, pick), action: null };
  }

  function matchCalibrate(text) {
    if (!/\b(calibrat(e|ion|ing)|re-?calibrate|set ?up (my |the )?(controls|controller|joystick|hotas|stick|throttle|pedals)|(controls|controller|joystick|hotas|bindings?) (panel|setup|wizard))\b/.test(text)) return null;
    return { speech: '', action: { type: 'calibrate' } };
  }

  function matchRelaunch(text) {
    if (!/\b(re-?launch|launch (again|us|me)|aero ?tow|tow (me|us) (up|back up)|get (me|us) a tow|tow plane|respawn|start over|(put|get) (me|us) back (in the air|up)|take (me|us) back up|reset the (flight|plane|craft))\b/.test(text)) return null;
    return { speech: '', action: { type: 'relaunch' } };
  }

  function matchChute(text) {
    const chuteWord = /\b(chute|parachute|canopy|reserve)\b/;
    if (!chuteWord.test(text)) return null;
    if (!/\b(deploy|pull|open|throw|pop|release|fire|use)\b/.test(text) && !/^(the )?(chute|parachute)( now)?$/.test(text)) return null;
    return { speech: '', action: { type: 'deployChute' } };
  }

  function matchEngine(text) {
    const engineWord = '(engine|engines|motor|motors|power plant)';
    const off = new RegExp(`\\b${engineWord}\\b.*\\b(off|out|shut ?down|stop|cut|kill|idle cut)\\b|\\b(cut|kill|stop|shut ?down|shut off|turn off|switch off)\\b.*\\b${engineWord}\\b`).test(text);
    if (off) return { speech: '', action: { type: 'engine', enabled: false } };
    const on = new RegExp(`\\b${engineWord}\\b.*\\b(on|start|restart|running|back on)\\b|\\b(start|restart|fire up|light|turn on|switch on)\\b.*\\b${engineWord}\\b`).test(text);
    if (on) return { speech: '', action: { type: 'engine', enabled: true } };
    return null;
  }

  /**
   * Views: "cockpit view" / "first person" (the FPV camera on the drone), "chase view", "wing
   * view", "flyby view", and "third person" / "outside view" (the craft's last third-person view,
   * where the first / third person swap goes).
   */
  function matchView(text, flight, core) {
    const viewWord = /\b(view|cam|camera|perspective|pov)\b/;
    const bare = core.every((word) => /^(cockpit|chase|view|cam|camera|to|back|go|switch|the|inside|outside|wing|wingtip|flyby|third|first|person)$/.test(word));
    const cockpit = /\b(cockpit|first[ -]?person|inside view|pilot'?s? (view|seat|eyes?)|in the cockpit|fpv view|pov)\b/.test(text);
    const outside = /\b(third[ -]?person|outside|external view|exterior view)\b/.test(text);
    const chase = /\b(chase|follow cam|behind the plane)\b/.test(text);
    const wing = /\b(wing ?(view|cam|camera)|wing ?tip( view| cam| camera)?)\b/.test(text);
    // "Fly by the lighthouse" is not a camera request: the flyby needs a view word or a bare phrase.
    const flyby = /\b(fly[ -]?by|flypast|fly past)\b/.test(text) && (viewWord.test(text) || bare);
    if (!cockpit && !outside && !chase && !wing && !flyby) return null;
    if (!viewWord.test(text) && !bare && !/\b(switch|go|back|change|put|swap|take)\b/.test(text)) return null;
    let view = 'cockpit';
    if (!cockpit) view = wing ? 'wing' : flyby ? 'flyby' : chase ? 'chase' : 'outside';
    return { speech: '', action: { type: 'setView', view } };
  }

  function matchAssists(text, flight, core) {
    if (!/\b(assists?|assistance|flight aids?|aids|stability aids?|helpers)\b/.test(text)) return null;
    const percent = text.match(/\b(\d{1,3})\s*(percent|per cent|pct)?\b/);
    if (percent && Number(percent[1]) <= 100 && (/\b(to|at|set|make|put)\b/.test(text) || core.length <= 3)) {
      return { speech: '', action: { type: 'setAssists', level: Number(percent[1]) / 100 } };
    }
    if (/\b(no|zero|none|off|disable|disabled|remove|kill|raw)\b/.test(text) && !/\bnot off\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'off' } };
    if (/\b(full|max|maximum|all|every|on|enable|hundred)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'full' } };
    if (/\b(up|more|increase|raise|higher|add)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'up' } };
    if (/\b(down|less|fewer|decrease|lower|reduce|drop)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'down' } };
    return { speech: describeAssistLevel(flight), action: null };
  }

  /**
   * "Switch to version one", "version one", "v1", "switch to v1", "play the original": V1, the
   * original game, through the versionToggle action (the launcher shell does the switch). Asking
   * for version two while flying it is answered, not acted on.
   */
  function matchVersion(text) {
    if (/\b(version (two|2)|v ?2)\b/.test(text) && !/\b(version (one|1)|v ?1)\b/.test(text)) {
      return { speech: pick('versionTwo', ["We're flying version two already.", 'This is version two.']), action: null };
    }
    const wanted = /\b(version (one|1)|v ?1|(play|go back to|back to|load|open|launch|start|switch to) the original( game| version| driftwing)?|original (game|version|driftwing))\b/.test(text);
    if (!wanted) return null;
    return { speech: '', action: { type: 'switchVersion', version: 'v1' } };
  }

  function matchCraft(text, flight, core) {
    const craft = findCraft(text);
    if (!craft) return null;
    const bare = core.every((word) => CRAFT_FILLER.has(word) || findCraft(word) !== null || /^(plane|bush|fighter|super|wing|suit|racing|sail)$/.test(word));
    if (!bare && !CRAFT_VERB.test(text)) return null;
    return { speech: '', action: { type: 'setCraft', craft } };
  }

  return {
    matchHelp,
    /** In priority order; they run before the v1 matchers. */
    matchers: [matchVersion, matchCraftCommand, matchCraftStatus, matchLanding, matchCalibrate, matchRelaunch, matchChute, matchEngine, matchView, matchAssists, matchCraft],
  };
}

/** "Assists are at 75 percent: ..." from the snapshot. */
export function describeAssistLevel(flight) {
  const assists = flight.assists;
  if (!assists || typeof assists !== 'object') return "I can't read the assists right now.";
  const list = Array.isArray(assists.active) && assists.active.length ? assists.active.join(', ') : 'none: raw physics';
  return `Assists are at ${assists.percent} percent: ${list}.`;
}
