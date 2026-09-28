// Copilot grammar lab: runs WREN's local brain (src/copilot/copilot.js with grammar.js) headless in
// node against transcripts, and checks the remote action schema for the version switch.
//
// Tests:
//   versionOne   "switch to version one", "version one", "v1", "switch to v1", "play the original"
//                (and a few more phrasings) ask for V1 with { type: 'switchVersion', version: 'v1' };
//                asking for version two is answered without an action
//   retired      "boost", "barrel roll", "sim mode", "classic mode" and friends no longer produce the
//                retired actions (boost, barrelRoll, setMode)
//   neighbours   commands that share words still reach their own action (the bush plane, the
//                cockpit view, assists)
//   schema       the remote action switchVersion needs version 'v1' exactly (case aside); the
//                retired types are refused
//
// Usage: node tools/lab/copilot.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { Copilot } from '../../src/copilot/copilot.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

/** The smallest context the local brain reads while matching (no action is executed here). */
function createBrain() {
  const values = { copilotVoice: true, copilotChatter: true, units: 'metric' };
  const ctx = {
    settings: { get: (key) => values[key], set: (key, value) => { values[key] = value; return true; } },
    state: { spawn: { x: 0, y: 400, z: 0, heading: 0 }, player: { position: { x: 0, y: 400, z: 0 } } },
    systems: {},
  };
  return new Copilot(ctx);
}

/** A flight-state snapshot with the fields the matchers read. */
const FLIGHT = Object.freeze({
  altitude: 400, altitudeAboveGround: 300, speed: 30, speedKmh: 108, heading: 90, headingName: 'east',
  throttle: 0.5, craft: 'glider', units: 'metric', assists: { percent: 100, active: [] }, capabilities: { throttle: false },
  waypoint: null, ringCourse: { active: false }, autopilot: { enabled: false }, nearbyLandmarks: [],
});

const brain = createBrain();
function actionFor(transcript) {
  const reply = brain.interpret(FLIGHT, transcript);
  return reply.action ? reply.action : null;
}

for (const phrase of ['switch to version one', 'version one', 'v1', 'switch to v1', 'play the original', 'go back to version 1', 'play the original game', 'WREN, switch to version one please']) {
  const action = actionFor(phrase);
  check('versionOne', `"${phrase}" -> switchVersion v1`, action && action.type === 'switchVersion' && action.version === 'v1', JSON.stringify(action));
}
for (const phrase of ['switch to version two', 'v2']) {
  const reply = brain.interpret(FLIGHT, phrase);
  check('versionOne', `"${phrase}" is answered, not acted on`, !reply.action && /version two/i.test(reply.speech), `${JSON.stringify(reply.action)} "${reply.speech}"`);
}

for (const phrase of ['boost', 'punch it', 'do a barrel roll', 'barrel roll left', 'sim mode', 'classic mode', 'switch to arcade mode', 'toggle flight mode']) {
  const action = actionFor(phrase);
  check('retired', `"${phrase}" -> no retired action`, !action || !['boost', 'barrelRoll', 'setMode'].includes(action.type), JSON.stringify(action));
}

for (const [phrase, type] of [['switch to the bush plane', 'setCraft'], ['cockpit view', 'setView'], ['assists up', 'setAssists'], ['relaunch', 'relaunch']]) {
  const action = actionFor(phrase);
  check('neighbours', `"${phrase}" -> ${type}`, action && action.type === type, JSON.stringify(action));
}

const clean = Copilot.sanitizeAction({ type: 'switchVersion', version: 'V1', extra: true });
check('schema', 'switchVersion with version "V1" is accepted as v1, extra fields dropped', clean && clean.version === 'v1' && !('extra' in clean), JSON.stringify(clean));
for (const raw of [{ type: 'switchVersion' }, { type: 'switchVersion', version: 'v2' }, { type: 'switchVersion', version: 1 }, { type: 'switchVersion', version: 'version one' }]) {
  check('schema', `refused: ${JSON.stringify(raw)}`, Copilot.sanitizeAction(raw) === null, JSON.stringify(Copilot.sanitizeAction(raw)));
}
for (const type of ['boost', 'barrelRoll', 'setMode']) {
  check('schema', `retired type ${type} is refused`, Copilot.sanitizeAction({ type, mode: 'sim', direction: 'left' }) === null, JSON.stringify(Copilot.sanitizeAction({ type })));
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} copilot grammar checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
