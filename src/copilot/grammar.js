import { clamp } from '../core/util.js';
import { CRAFT_IDS, FLIGHT_MODES } from '../core/settings.js';

/**
 * WREN's v2 grammar: the aircraft commands (craft, CLASSIC | SIM, assists, views, chute, engine,
 * relaunch, calibration) and the flight questions (airspeed, landing), plus the strict schema of the
 * matching remote actions. Everything here is pure: the matchers turn a normalized transcript and
 * the flight-state snapshot into { speech, action }, and the executor (flightActions.js) carries the
 * actions out and reports what really happened.
 */

export const FLIGHT_ACTION_TYPES = Object.freeze([
  'setCraft', 'setMode', 'setAssists', 'setView', 'deployChute', 'engine', 'relaunch', 'calibrate',
]);
export const ASSIST_CHANGES = Object.freeze(['up', 'down', 'full', 'off']);
export const VIEW_TARGETS = Object.freeze(['cockpit', 'chase']);
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
    case 'setMode': {
      const mode = typeof raw.mode === 'string' ? raw.mode.toLowerCase() : '';
      if (!FLIGHT_MODES.includes(mode)) return null;
      action.mode = mode;
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
    if (flight.mode !== 'sim') return "No landings yet. CLASSIC never touches down; say 'sim mode', find a flat meadow and ease her on.";
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

  function matchView(text, flight, core) {
    const viewWord = /\b(view|cam|camera|perspective|pov)\b/;
    const cockpit = /\b(cockpit|first[ -]?person|inside view|pilot'?s? (view|seat|eyes?)|in the cockpit|fpv view|pov)\b/.test(text);
    const chase = /\b(chase|third[ -]?person|outside view|external view|follow cam|behind the plane)\b/.test(text);
    if (!cockpit && !chase) return null;
    const bare = core.every((word) => /^(cockpit|chase|view|cam|camera|to|back|go|switch|the|inside|outside)$/.test(word));
    if (!viewWord.test(text) && !bare && !/\b(switch|go|back|change|put)\b/.test(text)) return null;
    if (chase && !cockpit) return { speech: '', action: { type: 'setView', view: 'chase' } };
    return { speech: '', action: { type: 'setView', view: 'cockpit' } };
  }

  function matchMode(text, flight, core) {
    const simWord = /\b(sim|simulation|simulator|realistic|real physics)\b/;
    const classicWord = /\b(classic|arcade|v1|casual)\b/;
    const modeWord = /\b(mode|flight|physics|model|flying)\b/;
    const verb = /\b(switch|go|change|put|set|turn on|enable|use|back to|to)\b/;
    const short = core.length <= 3;
    const sim = simWord.test(text) && (modeWord.test(text) || verb.test(text) || short);
    const classic = classicWord.test(text) && (modeWord.test(text) || verb.test(text) || short);
    if (sim && !classic) return { speech: '', action: { type: 'setMode', mode: 'sim' } };
    if (classic && !sim) return { speech: '', action: { type: 'setMode', mode: 'classic' } };
    if (/\b(toggle|switch|change|swap|other) (the )?(flight )?modes?\b/.test(text)) {
      return { speech: '', action: { type: 'setMode', mode: flight.mode === 'sim' ? 'classic' : 'sim' } };
    }
    return null;
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
    matchers: [matchLanding, matchCalibrate, matchRelaunch, matchChute, matchEngine, matchView, matchMode, matchAssists, matchCraft],
  };
}

/** "Assists are at 75 percent: ..." from the snapshot. */
export function describeAssistLevel(flight) {
  const assists = flight.assists;
  if (!assists || typeof assists !== 'object') return "I can't read the assists right now.";
  const list = Array.isArray(assists.active) && assists.active.length ? assists.active.join(', ') : 'none: raw physics';
  const note = flight.mode === 'sim' ? '' : " They apply in SIM mode; say 'sim mode' to feel them.";
  return `Assists are at ${assists.percent} percent: ${list}.${note}`;
}
