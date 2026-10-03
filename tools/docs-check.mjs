// Docs check: the documentation against the repository, headless (node, no browser).
//
// Tests:
//   links      every relative link and image in README.md, CHANGELOG.md and docs/**/*.md points at
//              a file or folder that exists, and every #anchor (in the same page or another
//              Markdown page) matches a heading there, slugged the way GitHub slugs headings
//   presets    the table in docs/spawns.md has one row per preset, in PRESETS order, with the
//              preset's id, category, kind, rarity, heavy flag and engines; every preset has its own
//              section linked from its row; the whole preset list validates against the schema with
//              the registered engine names, and every audio recipe a preset names exists
//   templates  the two copy-paste templates in docs/spawns.md (an event and a site) are valid
//              presets: each code block is evaluated as the preset file it would become and passes
//              validatePreset with the registered engine names, and its audio recipe exists
//
// Usage: node tools/docs-check.mjs [--verbose]
// Prints one line per failed check (every check with --verbose) and exits non-zero if any fails.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from '../src/spawns/presets/index.js';
import { validatePreset, validatePresets } from '../src/spawns/schema.js';
import { ENGINE_NAMES } from '../src/spawns/engineRegistry.js';
import { RECIPES } from '../src/audio/recipes/index.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPAWNS_DOC = join(ROOT, 'docs', 'spawns.md');
const TEMPLATE_HEADINGS = Object.freeze(['### Template: an event', '### Template: a site']);

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

// ---- Markdown helpers ----------------------------------------------------------------------------
/** Every Markdown file the check covers, as absolute paths. */
function markdownFiles() {
  const files = [join(ROOT, 'README.md'), join(ROOT, 'CHANGELOG.md')];
  const walk = (folder) => {
    for (const entry of readdirSync(folder)) {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.md')) files.push(path);
    }
  };
  walk(join(ROOT, 'docs'));
  return files;
}

/** The lines of a Markdown text outside fenced code blocks, each with its 1-based line number. */
function proseLines(text) {
  const lines = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) lines.push({ line, number: index + 1 });
  });
  return lines;
}

/** GitHub's heading anchor: link targets and tags dropped, lower case, punctuation removed, each space a hyphen. */
function slugify(heading) {
  const text = heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

const anchorCache = new Map();
/** The set of heading anchors of a Markdown file, with GitHub's -1, -2 suffixes for repeats. */
function anchorsOf(path) {
  if (anchorCache.has(path)) return anchorCache.get(path);
  const anchors = new Set();
  const counts = new Map();
  for (const { line } of proseLines(readFileSync(path, 'utf8'))) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slugify(match[1]);
    const seen = counts.get(base) ?? 0;
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
    counts.set(base, seen + 1);
  }
  anchorCache.set(path, anchors);
  return anchors;
}

/** The link targets on one prose line: Markdown links and images, and HTML src / href attributes. */
function linkTargets(line) {
  const withoutCode = line.replace(/`[^`]*`/g, '');
  const targets = [];
  for (const match of withoutCode.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(match[1]);
  for (const match of withoutCode.matchAll(/\s(?:src|href)="([^"]+)"/g)) targets.push(match[1]);
  return targets;
}

// ---- Links ---------------------------------------------------------------------------------------
function testLinks() {
  let total = 0;
  for (const file of markdownFiles()) {
    const label = relative(ROOT, file).replaceAll('\\', '/');
    for (const { line, number } of proseLines(readFileSync(file, 'utf8'))) {
      for (const target of linkTargets(line)) {
        if (/^(https?:|mailto:|data:)/i.test(target)) continue;
        total++;
        const [rawPath, anchor] = target.split('#');
        const path = rawPath === '' ? file : resolve(dirname(file), decodeURIComponent(rawPath));
        if (!existsSync(path)) {
          check('links', `${label}:${number} -> ${target}`, false, 'no such file');
          continue;
        }
        if (anchor === undefined || anchor === '') {
          check('links', `${label}:${number} -> ${target}`, true);
          continue;
        }
        if (!path.endsWith('.md')) {
          check('links', `${label}:${number} -> ${target}`, false, 'an anchor on a file that is not Markdown');
          continue;
        }
        const found = anchorsOf(path).has(anchor.toLowerCase());
        check('links', `${label}:${number} -> ${target}`, found, found ? '' : `no heading "#${anchor}" in ${relative(ROOT, path)}`);
      }
    }
  }
  check('links', 'links found and checked', total > 0, `${total} relative links`);
}

// ---- Presets -------------------------------------------------------------------------------------
/** The rows of the "The 30 presets at a glance" table: arrays of trimmed cell texts. */
function presetTableRows(text) {
  const rows = [];
  let inTable = false;
  for (const { line } of proseLines(text)) {
    if (/^\| # \| preset \| id \|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) break;
    if (/^\|\s*-/.test(line)) continue;
    rows.push(line.slice(1, -1).split('|').map((cell) => cell.trim()));
  }
  return rows;
}

function testPresets() {
  let valid = true;
  let detail = '';
  try {
    validatePresets(PRESETS, { engineNames: ENGINE_NAMES });
  } catch (error) {
    valid = false;
    detail = error.message;
  }
  check('presets', `the ${PRESETS.length} presets validate with the registered engine names`, valid, detail);
  for (const preset of PRESETS) {
    if (preset.audio) check('presets', `${preset.id}: audio recipe "${preset.audio.recipe}" exists`, Object.hasOwn(RECIPES, preset.audio.recipe));
  }

  const text = readFileSync(SPAWNS_DOC, 'utf8');
  const rows = presetTableRows(text);
  check('presets', 'docs/spawns.md has one table row per preset', rows.length === PRESETS.length, `${rows.length} rows, ${PRESETS.length} presets`);
  const anchors = anchorsOf(SPAWNS_DOC);
  PRESETS.forEach((preset, index) => {
    const row = rows[index];
    if (!row) return;
    const [number, link, id, category, kind, rarity, heavy, engines] = row;
    const expectedEngines = [...new Set(preset.engines.map((entry) => entry.engine))].map((name) => `\`${name}\``).join(', ');
    const problems = [];
    if (number !== String(index + 1)) problems.push(`number ${number}`);
    if (id !== `\`${preset.id}\``) problems.push(`id ${id}`);
    if (category !== preset.category) problems.push(`category ${category} (file: ${preset.category})`);
    if (kind !== preset.kind) problems.push(`kind ${kind} (file: ${preset.kind})`);
    if (rarity !== preset.rarity) problems.push(`rarity ${rarity} (file: ${preset.rarity})`);
    if (heavy !== (preset.heavy ? 'yes' : 'no')) problems.push(`heavy ${heavy} (file: ${preset.heavy})`);
    if (engines !== expectedEngines) problems.push(`engines ${engines} (file: ${expectedEngines})`);
    const anchor = /\]\(#([^)]+)\)/.exec(link);
    if (!anchor || !anchors.has(anchor[1])) problems.push(`no section for ${link}`);
    if (!text.includes(`(../src/spawns/presets/${preset.id}.js)`)) problems.push('its section does not link the preset file');
    check('presets', `row ${index + 1} matches ${preset.id}`, problems.length === 0, problems.join('; '));
  });
}

// ---- Templates -----------------------------------------------------------------------------------
/** The first js code block after a heading line in a Markdown text, or null. */
function codeBlockAfter(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return null;
  const match = /\n```js\n([\s\S]*?)\n```/.exec(text.slice(start));
  return match ? match[1] : null;
}

/** Evaluates a preset file's source (no imports) and returns its default export. */
function evaluatePresetSource(source) {
  if (/^\s*import\s/m.test(source)) throw new Error('a template must not import anything');
  const body = source.replace(/^export default\s+/m, 'return ');
  return new Function(body)();
}

function testTemplates() {
  const text = readFileSync(SPAWNS_DOC, 'utf8');
  const kinds = [];
  for (const heading of TEMPLATE_HEADINGS) {
    const source = codeBlockAfter(text, heading);
    if (!source) {
      check('templates', `${heading}: a js code block`, false, 'not found');
      continue;
    }
    let preset = null;
    let detail = '';
    try {
      preset = validatePreset(evaluatePresetSource(source), { engineNames: ENGINE_NAMES });
    } catch (error) {
      detail = error.message;
    }
    check('templates', `${heading}: a valid preset`, preset !== null, detail);
    if (!preset) continue;
    kinds.push(preset.kind);
    check('templates', `${heading}: its id is not a real preset's`, !PRESETS.some((real) => real.id === preset.id), preset.id);
    if (preset.audio) check('templates', `${heading}: audio recipe "${preset.audio.recipe}" exists`, Object.hasOwn(RECIPES, preset.audio.recipe));
  }
  check('templates', 'one event template and one site template', kinds.includes('event') && kinds.includes('site'), kinds.join(', '));
}

testLinks();
testPresets();
testTemplates();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(9)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} docs checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
