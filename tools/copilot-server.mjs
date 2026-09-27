#!/usr/bin/env node
// DRIFTWING reference copilot brain for WREN: a zero-dependency Node HTTP server.
//
//   node tools/copilot-server.mjs        (or: npm run copilot-server)
//
// Environment:
//   PORT=3000                      listen port
//   HOST=...                       listen address (default: both loopbacks, 127.0.0.1 and ::1)
//   ANTHROPIC_API_KEY=...          optional: ask Claude first, fall back to the built-in rules
//   COPILOT_MODEL=...              optional model id (default claude-haiku-4-5, chosen for latency)
//   COPILOT_CLAUDE_BUDGET_MS=700   optional: time allowed for Claude before the rules answer instead
//   COPILOT_WARMUP=0               optional: skip the start-up request that primes the JSON-schema cache
//   ANTHROPIC_BASE_URL=...         optional: alternative API base URL (e.g. a local proxy)
//
// In the game: open Settings, turn on "Remote copilot" and keep the endpoint
// http://localhost:3000/copilot. The game allows 800 ms per request and falls
// back to its own local grammar on timeout, network error or an invalid reply.
//
// Protocol (the full contract, with every flightState field and action, is docs/copilot-api.md):
//   POST /copilot  body {flightState, transcript}  ->  {speech, action}
//   GET  /health   -> {ok, brain, model, actions}
//   Testing aid (only with COPILOT_TEST_DELAY=1): POST /copilot?delay=1500 waits 1.5 s
//   before answering, which exercises the game's timeout + local fallback path.
//
// Security: only the game's own origins may call it (file:// pages send Origin "null",
// plus http(s)://localhost, 127.0.0.1 and [::1] on any port). Add more with
// ALLOWED_ORIGINS=https://example.com,https://other.example. Other origins get 403, so
// an unrelated website cannot spend your Claude key through this server.
import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const HOST = process.env.HOST || '';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const API_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODEL = process.env.COPILOT_MODEL || 'claude-haiku-4-5';
const CLAUDE_BUDGET_MS = clamp(Number.parseInt(process.env.COPILOT_CLAUDE_BUDGET_MS ?? '700', 10) || 700, 100, 10000);
const WARMUP = process.env.COPILOT_WARMUP !== '0';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEST_DELAY_MS = 5000;
const TEST_DELAY_ENABLED = process.env.COPILOT_TEST_DELAY === '1';
const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_SPEECH_LENGTH = 400;
const MAX_LABEL_LENGTH = 48;

// ---- Shared action schema (mirrors Copilot.sanitizeAction in the game) --------------------
const ACTION_TYPES = [
  'waypoint', 'clearWaypoint', 'autopilot', 'time', 'ringCourse', 'cancelRingCourse',
  'barrelRoll', 'boost', 'find', 'describe', 'photoMode', 'journal', 'none',
  'setCraft', 'setMode', 'setAssists', 'setView', 'deployChute', 'engine', 'relaunch', 'calibrate',
];
const FIND_TARGETS = [
  'mountains', 'snow', 'ocean', 'archipelago', 'islands', 'desert', 'dunes', 'forest', 'pine',
  'meadows', 'flowers', 'landmark', 'arch', 'monoliths', 'lighthouse', 'balloons',
];
const TIME_PRESETS = ['dawn', 'sunrise', 'morning', 'noon', 'golden', 'sunset', 'dusk', 'night', 'midnight'];
const CRAFT_IDS = ['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv'];
const FLIGHT_MODES = ['classic', 'sim'];
const ASSIST_CHANGES = ['up', 'down', 'full', 'off'];
const VIEWS = ['cockpit', 'chase'];

const ACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    x: { type: 'number' },
    z: { type: 'number' },
    bearing: { type: 'number' },
    distance: { type: 'number' },
    label: { type: 'string' },
    enabled: { type: 'boolean' },
    heading: { type: 'number' },
    altitude: { type: 'number' },
    followWaypoint: { type: 'boolean' },
    preset: { type: 'string', enum: TIME_PRESETS },
    dayTime: { type: 'number' },
    count: { type: 'integer' },
    direction: { type: 'string', enum: ['left', 'right'] },
    target: { type: 'string', enum: FIND_TARGETS },
    autopilot: { type: 'boolean' },
    craft: { type: 'string', enum: CRAFT_IDS },
    mode: { type: 'string', enum: FLIGHT_MODES },
    level: { type: 'number' },
    change: { type: 'string', enum: ASSIST_CHANGES },
    view: { type: 'string', enum: VIEWS },
  },
  required: ['type'],
  additionalProperties: false,
};
const REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    speech: { type: 'string' },
    action: { anyOf: [ACTION_JSON_SCHEMA, { type: 'null' }] },
  },
  required: ['speech', 'action'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are WREN, the calm, warm AI copilot riding along in DRIFTWING, an ambient flight game where the pilot glides a small aircraft over an endless low-poly world (Snow Peaks, Pine Valleys, Dune Sea, Archipelago, Flower Meadows) with landmarks (stone arches, standing-stone circles, lighthouses, hot-air balloons). There is no danger and no fail state.

Each user message is JSON: {"flightState": {...}, "transcript": "what the pilot said"}. Reply with JSON {"speech": string, "action": object or null}.

speech: one or two short sentences, at most 25 words, calm and friendly, plain text, no emoji, in the pilot's units (flightState.units: "metric" is metres and km/h, "aviation" is feet and knots). When your action is "describe", "find", "waypoint" or "journal", the game appends the precise facts after your speech, so keep speech to a brief lead-in (or an empty string) instead of guessing numbers.

action: at most one, or null for pure conversation. Types:
- {"type":"find","target":one of ${FIND_TARGETS.join('/')},"autopilot":true if the pilot wants to go there} finds the nearest such place and sets a waypoint.
- {"type":"waypoint","bearing":deg,"distance":m,"label":text,"autopilot":bool} relative marker (bearing 0 = north, 90 = east; default ahead 1500 m), or absolute with "x","z".
- {"type":"clearWaypoint"}
- {"type":"autopilot","enabled":bool,"heading":deg,"altitude":m,"followWaypoint":bool}; "take us there" means enabled true with followWaypoint true; climb/descend means altitude = current altitude +/- 200.
- {"type":"time","preset":one of ${TIME_PRESETS.join('/')}}
- {"type":"ringCourse","count":3-24} starts a fly-through ring course; {"type":"cancelRingCourse"} stops it.
- {"type":"barrelRoll","direction":"left" or "right"}, {"type":"boost"}
- {"type":"describe"} for where-am-I questions, {"type":"photoMode","enabled":bool}, {"type":"journal"}, {"type":"none"}.
Aircraft actions (the game reports whether each one worked, so keep speech to a short lead-in or an empty string):
- {"type":"setCraft","craft":one of ${CRAFT_IDS.join('/')}} (sailplane = glider, cub or taildragger = bushplane, fighter = jet, heli or chopper = helicopter, drone or quad = fpv). flightState.availableCraft lists what is installed.
- {"type":"setMode","mode":"classic" or "sim"}: CLASSIC is the forgiving arcade flight, SIM the real flight model.
- {"type":"setAssists","change":"up"/"down"/"full"/"off"} or {"type":"setAssists","level":0..1}: SIM flight assists for the current craft; up and down move 25 percent.
- {"type":"setView","view":"cockpit" or "chase"}, {"type":"deployChute"}, {"type":"engine","enabled":bool}, {"type":"relaunch"} (aerotow for the glider), {"type":"calibrate"} (opens the controls panel's calibration wizard).
Use flightState to answer questions about altitude, speed, heading, time and nearby landmarks. For airspeed use flightState.airspeed (indicated, in flightState.units: knots for "aviation", km/h for "metric"); for landings use flightState.lastLanding and bestLanding (grade butter/smooth/firm/hard, sinkRate m/s); flightState.windAtCraft.fromName is where the wind blows from. There are no penalties: after a soft crash the craft is simply back in the air. When you mention where we are, use flightState.place (what the ground below actually looks like, e.g. "the foothills of the Snow Peaks"); the biome name alone can be misleading. If the request is unclear, reply kindly with a couple of example commands and action null.`;

// ---- Small helpers ----------------------------------------------------------------------------------
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function compassName(heading) {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(wrapDegrees(heading) / 45) % 8];
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const wordEnd = cut.lastIndexOf(' ');
  return `${cut.slice(0, wordEnd > 0 ? wordEnd : maxLength - 3).trim()}...`;
}

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

function log(message) {
  process.stdout.write(`[copilot-server ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

// ---- Validation (never trust the model, or the client) ---------------------------------------------
function sanitizeAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!ACTION_TYPES.includes(raw.type)) return null;
  const present = (value) => value !== undefined && value !== null;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const action = { type: raw.type };
  const copyNumber = (key, transform) => {
    if (!present(raw[key])) return true;
    if (!finite(raw[key])) return false;
    action[key] = transform(raw[key]);
    return true;
  };
  const copyBoolean = (key) => {
    if (!present(raw[key])) return true;
    if (typeof raw[key] !== 'boolean') return false;
    action[key] = raw[key];
    return true;
  };
  switch (raw.type) {
    case 'waypoint': {
      if (present(raw.x) !== present(raw.z)) return null;
      const valid = copyNumber('x', (value) => clamp(value, -1e7, 1e7))
        && copyNumber('z', (value) => clamp(value, -1e7, 1e7))
        && copyNumber('bearing', wrapDegrees)
        && copyNumber('distance', (value) => clamp(value, 50, 40000))
        && copyBoolean('autopilot');
      if (!valid) return null;
      if (present(raw.label)) {
        if (typeof raw.label !== 'string') return null;
        const label = cleanText(raw.label, MAX_LABEL_LENGTH);
        if (label) action.label = label;
      }
      return action;
    }
    case 'autopilot':
      if (typeof raw.enabled !== 'boolean') return null;
      action.enabled = raw.enabled;
      return copyNumber('heading', wrapDegrees) && copyNumber('altitude', (value) => clamp(value, 40, 2600)) && copyBoolean('followWaypoint') ? action : null;
    case 'time':
      if (present(raw.preset)) {
        if (!TIME_PRESETS.includes(raw.preset)) return null;
        action.preset = raw.preset;
        return action;
      }
      return present(raw.dayTime) && copyNumber('dayTime', (value) => ((value % 1) + 1) % 1) ? action : null;
    case 'ringCourse':
      return copyNumber('count', (value) => clamp(Math.round(value), 3, 24)) ? action : null;
    case 'barrelRoll':
      if (present(raw.direction)) {
        if (raw.direction !== 'left' && raw.direction !== 'right') return null;
        action.direction = raw.direction;
      }
      return action;
    case 'find':
      if (!FIND_TARGETS.includes(raw.target)) return null;
      action.target = raw.target;
      return copyBoolean('autopilot') ? action : null;
    case 'photoMode':
      return copyBoolean('enabled') ? action : null;
    case 'setCraft':
      if (!CRAFT_IDS.includes(raw.craft)) return null;
      action.craft = raw.craft;
      return action;
    case 'setMode':
      if (!FLIGHT_MODES.includes(raw.mode)) return null;
      action.mode = raw.mode;
      return action;
    case 'setAssists':
      // Exactly one of level (0..1) or change.
      if (present(raw.level) === present(raw.change)) return null;
      if (present(raw.level)) {
        if (!finite(raw.level) || raw.level < 0 || raw.level > 1) return null;
        action.level = Math.round(raw.level * 100) / 100;
        return action;
      }
      if (!ASSIST_CHANGES.includes(raw.change)) return null;
      action.change = raw.change;
      return action;
    case 'setView':
      if (!VIEWS.includes(raw.view)) return null;
      action.view = raw.view;
      return action;
    case 'engine':
      if (typeof raw.enabled !== 'boolean') return null;
      action.enabled = raw.enabled;
      return action;
    default:
      return action;
  }
}

function sanitizeReply(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const speech = typeof raw.speech === 'string' ? cleanText(raw.speech, MAX_SPEECH_LENGTH) : '';
  let action = null;
  if (raw.action !== undefined && raw.action !== null) {
    action = sanitizeAction(raw.action);
    if (!action) return null;
  }
  if (!speech && (!action || action.type === 'none')) return null;
  return { speech, action };
}

// ---- Rule brain -----------------------------------------------------------------------------------------
const TARGET_RULES = [
  ['lighthouse', /\blight ?houses?\b/],
  ['balloons', /\bballoons?\b/],
  ['monoliths', /\b(monoliths?|standing stones?|stone circles?)\b/],
  ['arch', /\barch(es)?\b/],
  ['landmark', /\b(landmarks?|something interesting|points? of interest)\b/],
  ['snow', /\b(snow|snowy|ice|glaciers?)\b/],
  ['mountains', /\b(mountains?|peaks?|summits?|ridges?)\b/],
  ['archipelago', /\b(archipelago|islands?|reefs?|beach(es)?|lagoons?)\b/],
  ['ocean', /\b(ocean|sea|water|coast)\b/],
  ['dunes', /\b(dunes?|desert|sand)\b/],
  ['pine', /\b(forests?|woods|pines?|trees|valleys?)\b/],
  ['meadows', /\b(meadows?|flowers?|fields?|grassland)\b/],
];
const TIME_RULES = [
  ['midnight', /\bmidnight\b/],
  ['golden', /\bgolden( hour)?\b/],
  ['dusk', /\b(dusk|twilight|blue hour)\b/],
  ['sunset', /\b(sunset|evening)\b/],
  ['sunrise', /\bsunrise\b/],
  ['dawn', /\b(dawn|first light)\b/],
  ['morning', /\bmorning\b/],
  ['night', /\bnight\b/],
  ['noon', /\b(noon|midday|daytime|day)\b/],
];
const CARDINALS = { north: 0, 'north-east': 45, northeast: 45, east: 90, 'south-east': 135, southeast: 135, south: 180, 'south-west': 225, southwest: 225, west: 270, 'north-west': 315, northwest: 315 };

function matchFirst(rules, text) {
  for (const [name, pattern] of rules) if (pattern.test(text)) return name;
  return null;
}

function parseCardinal(text) {
  const match = text.match(/\b(north|south)[\s-]?(east|west)\b|\b(north|east|south|west)\b/);
  if (!match) return null;
  const key = match[3] ?? `${match[1]}${match[2]}`;
  return CARDINALS[key] ?? null;
}

function parseDistance(text) {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|k|m|met(?:er|re)s?)\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return /^k/.test(match[2]) ? value * 1000 : value;
}

const CRAFT_RULES = [
  ['glider', /\b(glider|sailplane)\b/],
  ['bushplane', /\b(bush ?plane|cub|tail ?dragger)\b/],
  ['jet', /\b(jet|fighter)\b/],
  ['helicopter', /\b(helicopter|heli|chopper)\b/],
  ['wingsuit', /\bwing ?suit\b/],
  ['fpv', /\b(fpv|drone|quad)\b/],
];

/** Speed in the pilot's units from flightState.airspeed (m/s fields). */
function speedText(metresPerSecond, units) {
  const value = Number.isFinite(metresPerSecond) ? metresPerSecond : 0;
  return units === 'aviation' ? `${Math.round(value * 1.943844)} knots` : `${Math.round(value * 3.6)} km/h`;
}

/** The v2 aircraft rules: craft, mode, assists, views, chute, engine, relaunch, calibration, airspeed, landings. */
function aircraftRule(text, flight) {
  if (/\b(how was my landing|landing (grade|report)|how did i land|best landing)\b/.test(text)) {
    const last = flight.lastLanding;
    if (!last || typeof last.grade !== 'string') return { speech: 'No landings yet. Find a flat field and ease her on.', action: null };
    const best = flight.bestLanding && flight.bestLanding.grade ? ` Best so far: ${flight.bestLanding.grade}.` : '';
    const sink = Number.isFinite(Number(last.sinkRate)) ? Number(last.sinkRate) : 0;
    const sinkText = flight.units === 'aviation' ? `${Math.round((sink * 196.85) / 10) * 10} feet a minute` : `${sink.toFixed(1)} metres a second`;
    return { speech: `A ${last.grade} landing, ${sinkText} at touchdown.${best}`, action: null };
  }
  if (/\b(air ?speed|how fast|ground ?speed|mach)\b/.test(text) && flight.airspeed && typeof flight.airspeed === 'object') {
    const units = flight.units === 'aviation' ? 'aviation' : 'metric';
    const mach = Number(flight.airspeed.mach) >= 0.5 ? `, Mach ${Number(flight.airspeed.mach).toFixed(2)}` : '';
    return { speech: `Indicated ${speedText(flight.airspeed.indicatedMs, units)}, ground speed ${speedText(flight.airspeed.groundSpeedMs, units)}${mach}.`, action: null };
  }
  if (/\bcalibrat(e|ion)\b/.test(text)) return { speech: '', action: { type: 'calibrate' } };
  if (/\b(re-?launch|aero ?tow|tow me up|respawn)\b/.test(text)) return { speech: '', action: { type: 'relaunch' } };
  if (/\b(chute|parachute)\b/.test(text)) return { speech: '', action: { type: 'deployChute' } };
  if (/\b(engine|motor)s?\b.*\b(off|cut|kill|stop)\b|\b(cut|kill|stop|shut ?down)\b.*\b(engine|motor)s?\b/.test(text)) return { speech: '', action: { type: 'engine', enabled: false } };
  if (/\b(engine|motor)s?\b.*\b(on|start)\b|\b(start|restart)\b.*\b(engine|motor)s?\b/.test(text)) return { speech: '', action: { type: 'engine', enabled: true } };
  if (/\b(cockpit|first person)\b/.test(text)) return { speech: '', action: { type: 'setView', view: 'cockpit' } };
  if (/\bchase (view|cam|camera)\b|^chase$/.test(text)) return { speech: '', action: { type: 'setView', view: 'chase' } };
  if (/\b(sim|simulation)( mode)?\b/.test(text) && !/\bclassic\b/.test(text)) return { speech: '', action: { type: 'setMode', mode: 'sim' } };
  if (/\b(classic|arcade)( mode)?\b/.test(text)) return { speech: '', action: { type: 'setMode', mode: 'classic' } };
  if (/\bassists?\b/.test(text)) {
    const percent = text.match(/\b(\d{1,3})\s*(percent)?\b/);
    if (percent && Number(percent[1]) <= 100) return { speech: '', action: { type: 'setAssists', level: Number(percent[1]) / 100 } };
    if (/\b(off|none|no|zero)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'off' } };
    if (/\b(full|max|all)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'full' } };
    if (/\b(up|more|increase)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'up' } };
    if (/\b(down|less|decrease|lower)\b/.test(text)) return { speech: '', action: { type: 'setAssists', change: 'down' } };
    const level = flight.assists && Number.isFinite(flight.assists.percent) ? `${flight.assists.percent} percent` : 'unknown';
    return { speech: `Assists are at ${level}.`, action: null };
  }
  const craft = matchFirst(CRAFT_RULES, text);
  if (craft && /\b(switch|change|fly|take|use|try|give me|to the)\b|^\S+$/.test(text)) return { speech: '', action: { type: 'setCraft', craft } };
  return null;
}

function ruleReply(flightState, transcript) {
  const text = String(transcript || '').toLowerCase().replace(/[^a-z0-9.\-'\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const flight = flightState && typeof flightState === 'object' ? flightState : {};
  const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
  const altitude = Number.isFinite(flight.altitude) ? flight.altitude : 400;
  const hasTarget = Boolean(flight.waypoint) || Boolean(flight.ringCourse?.active);

  if (!text) return { speech: "I'm here whenever you need me.", action: null };
  if (/\b(help|what can you do|commands)\b/.test(text)) {
    return { speech: "From the ground station I can find places, set waypoints, fly the autopilot, change the time and lay out ring courses, and switch craft, SIM or CLASSIC, assists, views, the engine, the chute and relaunch.", action: null };
  }
  const aircraft = aircraftRule(text, flight);
  if (aircraft) return aircraft;
  if (/\b(cancel|stop|end|quit)\b.*\b(course|rings?|race)\b/.test(text)) return { speech: 'Course called off.', action: { type: 'cancelRingCourse' } };
  if (/\bauto ?pilot\b.*\b(off|disengage|stop)\b|\b(disengage|stop|turn off)\b.*\bauto ?pilot\b|\bi have (the )?controls?\b/.test(text)) {
    return { speech: 'Autopilot off. Your aircraft.', action: { type: 'autopilot', enabled: false } };
  }
  if (/\b(clear|remove|delete|cancel)\b.*\b(waypoint|marker|beacon)\b/.test(text)) return { speech: 'Beacon cleared.', action: { type: 'clearWaypoint' } };
  if (/\b(exit|leave|close)\b.*\bphoto\b/.test(text)) return { speech: 'Back to flying.', action: { type: 'photoMode', enabled: false } };
  if (/\b(photo|screenshot|picture)\b/.test(text)) return { speech: 'Photo mode. Take your time.', action: { type: 'photoMode', enabled: true } };
  if (/\b(journal|discoveries|logbook)\b/.test(text)) return { speech: '', action: { type: 'journal' } };
  if (/\b(ring course|rings|race|course)\b/.test(text) && !/\bof course\b/.test(text)) {
    const count = text.match(/\b(\d{1,2})\s*rings?\b/);
    const action = { type: 'ringCourse' };
    if (count) action.count = clamp(Number(count[1]), 3, 24);
    return { speech: pick(['A fresh course, just for you.', 'Rings are up.']), action };
  }
  if (/\b(barrel ?roll|do a roll|flip|loop)\b/.test(text)) {
    const action = { type: 'barrelRoll' };
    if (/\bleft\b/.test(text)) action.direction = 'left';
    if (/\bright\b/.test(text)) action.direction = 'right';
    return { speech: pick(['Hang on.', 'Here we go.']), action };
  }
  if (/\b(boost|faster|speed up|punch it)\b/.test(text)) return { speech: 'Boosting.', action: { type: 'boost' } };

  const target = matchFirst(TARGET_RULES, text);
  if (target) {
    const autopilot = /\b(take (me|us)|fly|head|go to|navigate|bring (me|us)|and go)\b/.test(text);
    return { speech: pick(['Searching.', 'Let me have a look.', '']), action: { type: 'find', target, autopilot } };
  }
  if (/\b(take (us|me) there|fly there|go there|fly to the (waypoint|marker|beacon)|follow the (waypoint|marker|beacon))\b/.test(text)) {
    if (!hasTarget) return { speech: "There's no waypoint yet. Ask me to find something first.", action: null };
    return { speech: 'Autopilot on, heading for the marker.', action: { type: 'autopilot', enabled: true, followWaypoint: true } };
  }
  if (/\b(set|drop|place|mark|add)\b.*\b(waypoint|marker|beacon)\b|\bmark (this|here)\b/.test(text)) {
    const action = { type: 'waypoint', distance: parseDistance(text) ?? 1500, bearing: parseCardinal(text) ?? heading };
    return { speech: '', action };
  }
  const cardinal = parseCardinal(text);
  if (cardinal !== null && /\b(head|turn|fly|go|steer)\b/.test(text)) {
    return { speech: `Turning ${compassName(cardinal)}.`, action: { type: 'autopilot', enabled: true, heading: cardinal, followWaypoint: false } };
  }
  if (/\b(climb|go up|higher|ascend)\b/.test(text)) {
    const target = Math.round(clamp(altitude + 200, 60, 2500));
    return { speech: `Climbing to ${target} metres.`, action: { type: 'autopilot', enabled: true, altitude: target, heading, followWaypoint: false } };
  }
  if (/\b(descend|go down|lower|dive)\b/.test(text)) {
    const target = Math.round(clamp(altitude - 200, 60, 2500));
    return { speech: `Descending to ${target} metres.`, action: { type: 'autopilot', enabled: true, altitude: target, heading, followWaypoint: false } };
  }
  if (/\bauto ?pilot\b|\b(take the controls|you fly)\b/.test(text)) {
    return { speech: 'Autopilot on. Relax.', action: { type: 'autopilot', enabled: true, followWaypoint: hasTarget, heading, altitude: Math.round(altitude) } };
  }
  if (/\b(where am i|where are we|status|describe|look around)\b/.test(text)) return { speech: "Here's the picture.", action: { type: 'describe' } };
  const preset = matchFirst(TIME_RULES, text);
  if (preset && /\b(make|set|switch|change|skip|go|bring)\b|^\S+( hour)?$/.test(text)) {
    return { speech: pick([`Setting the sky to ${preset === 'golden' ? 'golden hour' : preset}.`, 'Changing the light for you.']), action: { type: 'time', preset } };
  }
  if (/\b(hi|hello|hey)\b/.test(text)) return { speech: 'Hello from the ground station. The air looks lovely.', action: null };
  if (/\b(thanks|thank you|cheers)\b/.test(text)) return { speech: 'Any time.', action: null };
  return { speech: "I didn't catch that. Try 'where am I', 'find mountains' or 'ring course'.", action: null };
}

// ---- Claude brain (optional) ------------------------------------------------------------------------------
function summarizeFlightState(flight) {
  const state = flight && typeof flight === 'object' ? flight : {};
  const nearby = Array.isArray(state.nearbyLandmarks) ? state.nearbyLandmarks.slice(0, 3) : [];
  const journal = state.journal && typeof state.journal === 'object' ? state.journal : null;
  return {
    altitude: state.altitude,
    altitudeAboveGround: state.altitudeAboveGround,
    speedKmh: state.speedKmh,
    heading: state.heading,
    headingName: state.headingName,
    biome: state.biome?.name,
    place: typeof state.place === 'string' ? state.place.slice(0, 120) : undefined,
    overWater: typeof state.overWater === 'boolean' ? state.overWater : undefined,
    timeLabel: state.timeLabel,
    dayTime: state.dayTime,
    isNight: state.isNight,
    autopilot: state.autopilot ? { enabled: state.autopilot.enabled, followWaypoint: state.autopilot.followWaypoint } : null,
    waypoint: state.waypoint ?? null,
    ringCourse: state.ringCourse?.active
      ? { active: true, total: state.ringCourse.total, passed: state.ringCourse.passed, nextIndex: state.ringCourse.nextIndex }
      : { active: false },
    nearbyLandmarks: nearby.map((site) => ({ name: site.name, type: site.type, distance: site.distance, bearing: site.bearing, discovered: site.discovered })),
    journal: journal
      ? {
          landmarksFound: Array.isArray(journal.landmarksFound) ? journal.landmarksFound.length : 0,
          biomesVisited: Array.isArray(journal.biomesVisited) ? journal.biomesVisited.length : 0,
        }
      : null,
    // v2 aircraft fields (docs/copilot-api.md).
    mode: state.mode,
    craft: state.craft,
    availableCraft: Array.isArray(state.availableCraft) ? state.availableCraft.slice(0, 12) : undefined,
    units: state.units,
    view: state.view,
    capabilities: state.capabilities,
    assists: state.assists ? { percent: state.assists.percent, active: state.assists.active, appliesInMode: state.assists.appliesInMode } : undefined,
    airspeed: state.airspeed,
    aoa: state.aoa,
    gLoad: state.gLoad,
    agl: state.agl,
    windAtCraft: state.windAtCraft ? { speed: state.windAtCraft.speed, fromName: state.windAtCraft.fromName, vertical: state.windAtCraft.vertical } : undefined,
    gear: state.gear,
    flaps: state.flaps,
    onGround: state.onGround,
    engineOn: state.engineOn,
    lastLanding: state.lastLanding,
    bestLanding: state.bestLanding,
  };
}

async function askClaude(flightState, transcript, budgetMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ flightState: summarizeFlightState(flightState), transcript }) }],
        output_config: { format: { type: 'json_schema', schema: REPLY_JSON_SCHEMA } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new Error(`Claude API HTTP ${response.status}${errorBody?.error?.type ? ` (${errorBody.error.type})` : ''}`);
    }
    const message = await response.json();
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') throw new Error(`stop_reason ${message.stop_reason}`);
    const textBlock = Array.isArray(message.content) ? message.content.find((block) => block.type === 'text') : null;
    if (!textBlock || typeof textBlock.text !== 'string') throw new Error('no text block in the reply');
    const reply = sanitizeReply(JSON.parse(textBlock.text));
    if (!reply) throw new Error('reply failed validation');
    return reply;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`no answer within ${budgetMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---- HTTP ---------------------------------------------------------------------------------------------------
function isAllowedOrigin(origin) {
  return origin === 'null' || LOCAL_ORIGIN_PATTERN.test(origin) || EXTRA_ALLOWED_ORIGINS.includes(origin);
}

/** CORS for the game's own origins only. Returns false when the request must be refused. */
function applyCors(request, response) {
  const origin = request.headers.origin;
  response.setHeader('Vary', 'Origin');
  if (origin === undefined) return true;
  if (!isAllowedOrigin(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
  if (request.headers['access-control-request-private-network'] === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return true;
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  response.end(body);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        rejectBody(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        rejectBody(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    request.on('error', rejectBody);
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function handleCopilot(request, response, url) {
  const started = Date.now();
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error.status === 413) {
      // Answer first, then drop the rest of the upload.
      response.once('finish', () => request.destroy());
      sendJson(response, 413, { error: error.message }, { Connection: 'close' });
      return;
    }
    sendJson(response, 400, { error: error.message });
    return;
  }
  const transcript = typeof body?.transcript === 'string' ? body.transcript.slice(0, 500) : '';
  const flightState = body?.flightState && typeof body.flightState === 'object' ? body.flightState : {};
  const delay = TEST_DELAY_ENABLED ? clamp(Number(url.searchParams.get('delay')) || 0, 0, MAX_TEST_DELAY_MS) : 0;
  if (delay > 0) await sleep(delay);

  let reply = null;
  let brain = 'rules';
  if (API_KEY && transcript) {
    try {
      reply = await askClaude(flightState, transcript, CLAUDE_BUDGET_MS);
      brain = 'claude';
    } catch (error) {
      log(`Claude unavailable, using rules: ${error.message}`);
    }
  }
  if (!reply) reply = sanitizeReply(ruleReply(flightState, transcript)) ?? { speech: "I'm here.", action: null };
  if (!response.writableEnded && !response.destroyed) sendJson(response, 200, reply);
  const flying = typeof flightState.mode === 'string' && typeof flightState.craft === 'string' ? ` [${flightState.craft}, ${flightState.mode}]` : '';
  log(`POST /copilot${flying} -> ${brain}${reply.action ? ` ${reply.action.type}` : ''} in ${Date.now() - started} ms${delay ? ` (test delay ${delay} ms)` : ''}`);
}

function handleRequest(request, response) {
  if (!applyCors(request, response)) {
    sendJson(response, 403, { error: 'origin not allowed' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === '/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, brain: API_KEY ? 'claude+rules' : 'rules', model: API_KEY ? MODEL : null, actions: ACTION_TYPES });
    return;
  }
  if (url.pathname !== '/copilot') {
    sendJson(response, 404, { error: 'not found; POST /copilot or GET /health' });
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'use POST' });
    return;
  }
  handleCopilot(request, response, url).catch((error) => {
    log(`request failed: ${error.message}`);
    if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
  });
}

function reportListenFailure(error) {
  const retry = `Start it with another port (for example PORT=3300) and set the same endpoint in the game's settings.`;
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${PORT} is already in use. ${retry}
`);
  } else if (error.code === 'EACCES') {
    process.stderr.write(`Port ${PORT} is not available to this user. On Windows it may sit in a reserved range (see: netsh interface ipv4 show excludedportrange protocol=tcp). ${retry}
`);
  } else {
    process.stderr.write(`copilot-server failed: ${error.message}
`);
  }
  process.exit(1);
}

/**
 * Browsers resolve "localhost" to both ::1 and 127.0.0.1. Listening on only one
 * loopback address can cost a failed connection attempt per request, which eats
 * into the game's 800 ms budget, so by default both loopbacks are bound.
 */
function listen(host, required) {
  return new Promise((resolveListen) => {
    const server = createServer(handleRequest);
    server.once('error', (error) => {
      if (required) reportListenFailure(error);
      log(`not listening on ${host} (${error.code || error.message}); continuing without it`);
      resolveListen(null);
    });
    server.listen(PORT, host, () => resolveListen(server));
  });
}

const servers = (await Promise.all(
  process.env.HOST ? [listen(HOST, true)] : [listen('127.0.0.1', true), listen('::1', false)],
)).filter(Boolean);
log(`WREN copilot brain listening on http://localhost:${PORT}/copilot (${API_KEY ? `Claude ${MODEL} + rules` : 'rules only; set ANTHROPIC_API_KEY to use Claude'})`);
if (API_KEY && WARMUP) {
  askClaude({}, 'hello', 8000)
    .then(() => log('Claude warm-up done (response schema cached).'))
    .catch((error) => log(`Claude warm-up skipped: ${error.message}`));
}

function shutdown() {
  let open = servers.length;
  for (const server of servers) server.close(() => { open -= 1; if (open === 0) process.exit(0); });
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
