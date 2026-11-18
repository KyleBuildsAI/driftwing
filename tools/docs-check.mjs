// Docs check: the documentation against the repository, headless (node, no browser).
//
// Tests:
//   links      every relative link and image in README.md, CHANGELOG.md and docs/**/*.md points at
//              a file or folder that exists, and every #anchor (in the same page or another
//              Markdown page) matches a heading there, slugged the way GitHub slugs headings
//   presets    the table in docs/spawns.md has one row per preset, in PRESETS order, numbered with the
//              preset's spec number (the "Preset NN" in its file's first line; its place in PRESETS
//              when the line names none), with the preset's id, category, kind, rarity, heavy flag
//              and engines, its name as the link text, and "no" wind only when the file makes none;
//              every preset has its own section linked from its row; the whole preset list validates
//              against the schema with the registered engine names, and every audio recipe a preset
//              names exists; the engine reference table lists every registered engine with the exact
//              preset numbers that use it
//   sections   each preset's section in docs/spawns.md agrees with its file: the heading names it;
//              Kind (kind, rarity, heavy), Wind ("none" only without wind), Sound (the recipe, or
//              "none"), Journal (the journal title and the callout count), LOD and Discovery,
//              Lifetime (duration or "a site", the despawn distance + hysteresis), Filters (player
//              altitude and the distance band), and Candidates (events; not for a global override,
//              which is never rolled) or Placement (sites: chance and spacing)
//   templates  the two copy-paste templates in docs/spawns.md (an event and a site) are valid
//              presets: each code block is evaluated as the preset file it would become and passes
//              validatePreset with the registered engine names, and its audio recipe exists
//   wind       every param of every WindField source type (windSources.js) is documented in its
//              section: docs/engines/vortex.md "Wind params" for rankine, docs/engines/
//              windModifier.md "### <type>:" for the others
//   engines    every param name a preset gives an engine (nested names included, and a set piece's
//              per-child engine overrides on that child engine's page) is named in its
//              docs/engines/<engine>.md; every structure recipe has its section, its row in the
//              recipe table names the stamp type it reads (structure/stamps.js), and every recipe
//              default is a param of its section; every celestial component and waterEffect effect
//              has its section; every fauna behaviour, species and altitude mode, emitter particle
//              style and ground mode, and lightEffect glow shape is named on its page
//   craft      the craft table of docs/architecture.md has one row per craft with its model kind and
//              its module's instruments in order, and the instrument count is right; docs/controls.md
//              has a row per craft in "What the controls mean for each craft" and a full profile for
//              every craft after the six of Phase 1
//   scripts    every npm script in package.json is named in README.md
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
import { WIND_SOURCE_TYPES, sourceParameterNames } from '../src/spawns/engines/windSources.js';
import { RECIPES as STRUCTURE_RECIPES } from '../src/spawns/engines/structure/recipes/index.js';
import { RECIPE_STAMP_TYPES } from '../src/spawns/engines/structure/stamps.js';
import { CELESTIAL_COMPONENTS } from '../src/spawns/engines/celestial/params.js';
import { ALTITUDE_MODES, FAUNA_BEHAVIORS } from '../src/spawns/engines/faunaEngine.js';
import { SPECIES_IDS } from '../src/spawns/engines/faunaSpecies.js';
import { WATER_EFFECT_DEFAULTS } from '../src/spawns/engines/waterEffectEngine.js';
import { GROUND_MODES, PARTICLE_STYLES } from '../src/spawns/engines/particleSystem.js';
import { GLOW_SHAPES } from '../src/spawns/engines/glowPoints.js';
import { craftRegistry } from '../src/craft/index.js';
import { INSTRUMENT_IDS } from '../src/ui/instruments/index.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPAWNS_DOC = join(ROOT, 'docs', 'spawns.md');
const ARCHITECTURE_DOC = join(ROOT, 'docs', 'architecture.md');
const CONTROLS_DOC = join(ROOT, 'docs', 'controls.md');
/** The six craft of Phase 1; every craft after them has a full profile in docs/controls.md. */
const PHASE1_CRAFT = Object.freeze(['glider', 'bushplane', 'jet', 'helicopter', 'wingsuit', 'fpv']);
/** Structure params every recipe shares (the "Common params" table), never repeated per recipe. */
const COMMON_STRUCTURE_PARAMS = Object.freeze(['stamp']);
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
/**
 * The spec number of a preset: the "Preset NN" (or "preset NN") in its file's first line, else its
 * place in PRESETS (1-based). With every batch merged, PRESETS holds the spec's 100 in order, so a
 * row's number is both the file's number and its place.
 */
function presetNumber(preset, index) {
  const path = join(ROOT, 'src', 'spawns', 'presets', `${preset.id}.js`);
  const firstLine = existsSync(path) ? readFileSync(path, 'utf8').split('\n', 1)[0] : '';
  const match = /\b[Pp]reset (\d+)\b/.exec(firstLine);
  return match ? match[1] : String(index + 1);
}

/** The rows of the "The 100 presets at a glance" table: arrays of trimmed cell texts. */
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

/** Where a preset's file makes wind: its own sources, the wind engines, and non-zero engine wind params. */
function windSourcesOf(preset) {
  const sources = (preset.wind ?? []).map((source) => `wind ${source.type}`);
  const nonZero = (value) => (typeof value === 'number'
    ? value !== 0
    : value !== null && typeof value === 'object' && Object.values(value).some(nonZero));
  for (const entry of preset.engines) {
    if (entry.engine === 'windModifier' || entry.engine === 'vortex') sources.push(`engine ${entry.engine}`);
    else if (nonZero(entry.params?.wind) || nonZero(entry.params?.windSource)) sources.push(`${entry.engine} wind params`);
  }
  return sources;
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
    const [number, link, id, category, kind, rarity, heavy, engines, wind] = row;
    const expectedEngines = [...new Set(preset.engines.map((entry) => entry.engine))].map((name) => `\`${name}\``).join(', ');
    const problems = [];
    if (number !== presetNumber(preset, index) || number !== String(index + 1)) problems.push(`number ${number} (file: ${presetNumber(preset, index)}, place ${index + 1})`);
    if (id !== `\`${preset.id}\``) problems.push(`id ${id}`);
    if (category !== preset.category) problems.push(`category ${category} (file: ${preset.category})`);
    if (kind !== preset.kind) problems.push(`kind ${kind} (file: ${preset.kind})`);
    if (rarity !== preset.rarity) problems.push(`rarity ${rarity} (file: ${preset.rarity})`);
    if (heavy !== (preset.heavy ? 'yes' : 'no')) problems.push(`heavy ${heavy} (file: ${preset.heavy})`);
    if (engines !== expectedEngines) problems.push(`engines ${engines} (file: ${expectedEngines})`);
    const linkName = /^\[([^\]]+)\]/.exec(link);
    if (!linkName || linkName[1] !== preset.name) problems.push(`link text ${link} (name: ${preset.name})`);
    const sources = windSourcesOf(preset);
    if (wind === 'no' && sources.length > 0) problems.push(`wind "no" (file: ${sources.join(', ')})`);
    const anchor = /\]\(#([^)]+)\)/.exec(link);
    if (!anchor || !anchors.has(anchor[1])) problems.push(`no section for ${link}`);
    if (!text.includes(`(../src/spawns/presets/${preset.id}.js)`)) problems.push('its section does not link the preset file');
    check('presets', `row ${index + 1} matches ${preset.id}`, problems.length === 0, problems.join('; '));
  });
}

// ---- Preset sections -----------------------------------------------------------------------------
/** The lines of preset `number`'s section in docs/spawns.md: from its "#### N. " heading to the next heading. */
function presetSection(text, number) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`#### ${number}. `));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^#{1,4}\s/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end);
}

/**
 * The bullets of a section as { label, text }: a bullet starts with "- **Label:**" and runs over its
 * indented continuation lines, joined with single spaces.
 */
function sectionBullets(lines) {
  const bullets = [];
  let current = null;
  for (const line of lines) {
    const start = /^- \*\*([^*]+?):\*\*\s*(.*)$/.exec(line);
    if (start) {
      current = { label: start[1], text: start[2] };
      bullets.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`;
    } else {
      current = null;
    }
  }
  return bullets;
}

/** The first bullet whose label is `label` or starts with it ("Filters" also finds "Filters (the eruption)"). */
function bulletOf(bullets, label) {
  return bullets.find((entry) => entry.label === label || entry.label.startsWith(`${label} `)) ?? null;
}

/** A number as the docs write it: plain decimal, no trailing zeros. */
function plain(value) {
  return String(Number(value.toFixed(3)));
}

/** True when `text` holds `phrase` with no digit or decimal point glued to its start. */
function mentions(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}`).test(text);
}

/** True when `text` names the distance `metres` as "N m" or "N km". */
function mentionsDistance(text, metres) {
  return mentions(text, `${plain(metres)} m`) || mentions(text, `${plain(metres / 1000)} km`);
}

/** True when `text` names the range min-max metres as "a-b m" or "a-b km". */
function mentionsRange(text, min, max) {
  return mentions(text, `${plain(min)}-${plain(max)} m`) || mentions(text, `${plain(min / 1000)}-${plain(max / 1000)} km`);
}

/** True when `text` names "D + H" (despawn distance and hysteresis), both in m or both in km. */
function mentionsDespawn(text, distance, hysteresis) {
  return mentions(text, `${plain(distance)} + ${plain(hysteresis)} m`)
    || mentions(text, `${plain(distance / 1000)} + ${plain(hysteresis / 1000)} km`);
}

/** The Kind bullet against kind, rarity and heavy. */
function kindProblems(preset, bullets) {
  const kind = bulletOf(bullets, 'Kind');
  const match = kind && /^(site|event), (common|uncommon|rare|legendary)\b/.exec(kind.text);
  if (!match) return ['no "Kind: <kind>, <rarity>" bullet'];
  const problems = [];
  if (match[1] !== preset.kind) problems.push(`Kind says ${match[1]} (file: ${preset.kind})`);
  if (match[2] !== preset.rarity) problems.push(`Kind says ${match[2]} (file: ${preset.rarity})`);
  const saysHeavy = /^[^.;:(]*\bheavy\b/.test(kind.text);
  if (saysHeavy !== Boolean(preset.heavy)) problems.push(`Kind says ${saysHeavy ? '' : 'not '}heavy (file: heavy ${Boolean(preset.heavy)})`);
  return problems;
}

/** The Sound bullet against the audio recipe (its first code span), or "none" without audio. */
function soundProblems(preset, bullets) {
  const sound = bulletOf(bullets, 'Sound');
  if (!sound) return ['no Sound bullet'];
  if (!preset.audio) return /^none\b/.test(sound.text) ? [] : [`Sound is "${sound.text}" (file: no audio)`];
  const recipe = /`([^`]+)`/.exec(sound.text);
  return recipe && recipe[1] === preset.audio.recipe ? [] : [`Sound names ${recipe ? recipe[1] : 'no recipe'} (file: ${preset.audio.recipe})`];
}

/** The Wind bullet: it may say "none" only when the file makes no wind. */
function windProblems(preset, bullets) {
  const wind = bulletOf(bullets, 'Wind');
  if (!wind) return ['no Wind bullet'];
  const sources = windSourcesOf(preset);
  return sources.length > 0 && /^none\b/.test(wind.text) ? [`Wind says none (file: ${sources.join(', ')})`] : [];
}

/** The Journal bullet:it opens with the journal title in quotes and counts WREN's callout lines. */
function journalProblems(preset, bullets) {
  const journal = bulletOf(bullets, 'Journal');
  if (!journal) return ['no Journal bullet'];
  const problems = [];
  if (!journal.text.startsWith(`"${preset.journal.title}"`)) problems.push(`Journal does not open with "${preset.journal.title}"`);
  const count = preset.callouts.length;
  if (!mentions(journal.text, `${count} callout lines`)) problems.push(`Journal does not say "${count} callout lines"`);
  return problems;
}

/** The LOD bullet (with its Discovery) against lod and discovery. */
function lodProblems(preset, bullets) {
  const lod = bulletOf(bullets, 'LOD');
  if (!lod) return ['no LOD bullet'];
  const problems = [];
  for (const band of ['near', 'mid', 'far']) {
    if (!mentionsDistance(lod.text, preset.lod[band])) problems.push(`LOD ${band} is not ${preset.lod[band]} m`);
  }
  const discovery = /\*\*Discovery:\*\*\s*(.*)$/.exec(lod.text);
  if (!discovery || !mentionsDistance(discovery[1], preset.discovery.radius)) problems.push(`Discovery is not ${preset.discovery.radius} m`);
  else if (/\bin view\b/.test(discovery[1]) !== Boolean(preset.discovery.requireInView)) problems.push(`Discovery "in view" (file: requireInView ${preset.discovery.requireInView})`);
  return problems;
}

/** The Lifetime bullet: the drawn duration (or "a site") and the despawn distance plus hysteresis. */
function lifetimeProblems(preset, bullets) {
  const lifetime = bulletOf(bullets, 'Lifetime');
  if (!lifetime) return ['no Lifetime bullet'];
  const problems = [];
  const { duration, despawn } = preset.lifetime;
  if (duration) {
    const [min, max] = duration;
    const phrase = min === max ? `${plain(min)} s` : `${plain(min)}-${plain(max)} s`;
    if (!mentions(lifetime.text, phrase)) problems.push(`Lifetime does not say ${phrase}`);
  } else if (!/\ba site\b/.test(lifetime.text)) problems.push('Lifetime does not say "a site" (file: no duration)');
  if (despawn && !mentionsDespawn(lifetime.text, despawn.distance, despawn.hysteresis)) {
    problems.push(`Lifetime does not say beyond ${despawn.distance} + ${despawn.hysteresis} m`);
  }
  return problems;
}

/** The Filters bullet's player altitude band and "ahead" distance band. */
function filterProblems(preset, bullets) {
  const filters = bulletOf(bullets, 'Filters');
  if (!filters) return preset.kind === 'event' ? ['no Filters bullet'] : [];
  if (!preset.filters) return ['a Filters bullet without filters in the file'];
  const problems = [];
  const { altitude, minDistance, maxDistance } = preset.filters;
  if (altitude && !mentionsRange(filters.text, altitude.min, altitude.max)) problems.push(`Filters do not say player ${altitude.min}-${altitude.max} m`);
  if (Number.isFinite(minDistance) && Number.isFinite(maxDistance) && !mentionsRange(filters.text, minDistance, maxDistance)) {
    problems.push(`Filters do not say ${minDistance}-${maxDistance} m ahead`);
  }
  return problems;
}

/** The Candidates bullet (events) and the Placement bullet (sites). */
function rollProblems(preset, bullets) {
  const problems = [];
  // A global override preset is scheduled per night and never rolled, so its candidates are unused.
  if (preset.candidates && !preset.override) {
    const candidates = bulletOf(bullets, 'Candidates');
    const { cellSize, bucketSeconds, chance } = preset.candidates;
    if (!candidates) problems.push('no Candidates bullet');
    else {
      if (!mentionsDistance(candidates.text, cellSize)) problems.push(`Candidates cells are not ${cellSize} m`);
      if (!mentions(candidates.text, `${plain(bucketSeconds)} s buckets`)) problems.push(`Candidates buckets are not ${bucketSeconds} s`);
      if (!mentions(candidates.text, `chance ${plain(chance)}`)) problems.push(`Candidates chance is not ${chance}`);
    }
  }
  if (preset.placement) {
    const placement = bulletOf(bullets, 'Placement');
    const { chance, minSpacing } = preset.placement;
    if (!placement) problems.push('no Placement bullet');
    else {
      if (!mentions(placement.text, `chance ${plain(chance)}`)) problems.push(`Placement chance is not ${chance}`);
      if (minSpacing && !mentionsDistance(placement.text, minSpacing)) problems.push(`Placement spacing is not ${minSpacing} m`);
    }
  }
  return problems;
}

function testSections() {
  const text = readFileSync(SPAWNS_DOC, 'utf8');
  PRESETS.forEach((preset, index) => {
    const lines = presetSection(text, index + 1);
    if (!lines) {
      check('sections', `${index + 1}. ${preset.id}: has a section`, false, 'not found');
      return;
    }
    const bullets = sectionBullets(lines);
    const heading = /^#### \d+\. (.*)$/.exec(lines[0])[1];
    const problems = [
      ...(heading === preset.name ? [] : [`heading "${heading}" (name: "${preset.name}")`]),
      ...kindProblems(preset, bullets),
      ...windProblems(preset, bullets),
      ...soundProblems(preset, bullets),
      ...journalProblems(preset, bullets),
      ...lodProblems(preset, bullets),
      ...lifetimeProblems(preset, bullets),
      ...filterProblems(preset, bullets),
      ...rollProblems(preset, bullets),
    ];
    check('sections', `${index + 1}. ${preset.id}: its section matches the file`, problems.length === 0, problems.join('; '));
  });
}

/** The engine reference table of docs/spawns.md: one row per registered engine, "used by" exact. */
function testEngineTable() {
  const text = readFileSync(SPAWNS_DOC, 'utf8');
  const rows = new Map();
  let inTable = false;
  for (const { line } of proseLines(text)) {
    if (/^\| engine \| page \|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) break;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    rows.set(cells[0].replaceAll('`', ''), cells[cells.length - 1]);
  }
  for (const engine of ENGINE_NAMES) {
    const usedBy = [];
    PRESETS.forEach((preset, index) => {
      if (preset.engines.some((entry) => entry.engine === engine)) usedBy.push(index + 1);
    });
    const expected = usedBy.join(', ');
    const documented = rows.get(engine);
    check('presets', `engine table: ${engine} is used by presets ${expected}`, documented === expected, documented === undefined ? 'no row' : `the row says ${documented}`);
  }
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

// ---- Wind source params --------------------------------------------------------------------------
/** The text of a Markdown section: from the first heading line matching `pattern` to the next level-2 or level-3 heading. */
function sectionText(text, pattern) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^#{2,3}\s/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

function testWindParams() {
  const vortexDoc = readFileSync(join(ROOT, 'docs', 'engines', 'vortex.md'), 'utf8');
  const modifierDoc = readFileSync(join(ROOT, 'docs', 'engines', 'windModifier.md'), 'utf8');
  for (const type of WIND_SOURCE_TYPES) {
    const section = type === 'rankine'
      ? sectionText(vortexDoc, /^### Wind params$/)
      : sectionText(modifierDoc, new RegExp(`^### ${type}:`));
    if (!section) {
      check('wind', `${type}: has a doc section`, false, 'not found');
      continue;
    }
    const missing = sourceParameterNames(type).filter((name) => !section.includes(`\`${name}\``));
    check('wind', `${type}: every source param is documented`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : '');
  }
}

// ---- Engine pages --------------------------------------------------------------------------------
/** The engine page's text, read once per engine. */
const enginePages = new Map();
function enginePage(engine) {
  if (!enginePages.has(engine)) enginePages.set(engine, readFileSync(join(ROOT, 'docs', 'engines', `${engine}.md`), 'utf8'));
  return enginePages.get(engine);
}

/** Every object key in a params value, with its dotted path (array entries share their array's path). */
function paramNames(value, path, out) {
  if (Array.isArray(value)) {
    for (const item of value) paramNames(item, path, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      out.push({ key, path: childPath });
      paramNames(child, childPath, out);
    }
  }
  return out;
}

/** Whether a page names a param: the name as a whole word anywhere (tables, `{ name default }` shapes, prose). */
function namesWord(text, name) {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text);
}

/**
 * The param names of one engine entry that its page never names, as dotted paths. A set piece's
 * per-child engine overrides (children.<name>.params.<engine>) are checked on that engine's page.
 */
function undocumentedParams(engine, params) {
  const missing = [];
  const children = engine === 'setPiece' && params && params.children ? params.children : null;
  for (const { key, path } of paramNames(params, '', [])) {
    if (children && path.startsWith('children.') && path.split('.').length > 2) continue;
    if (!namesWord(enginePage(engine), key)) missing.push(`${engine} ${path}`);
  }
  if (children) {
    for (const [childName, child] of Object.entries(children)) {
      for (const [childEngine, overrides] of Object.entries(child?.params ?? {})) {
        if (!ENGINE_NAMES.includes(childEngine)) continue;
        for (const { key, path } of paramNames(overrides, '', [])) {
          if (!namesWord(enginePage(childEngine), key)) missing.push(`${childEngine} children.${childName}.params.${childEngine}.${path}`);
        }
      }
    }
  }
  return missing;
}

function testPresetParams() {
  for (const engine of ENGINE_NAMES) {
    const missing = [];
    for (const preset of PRESETS) {
      for (const entry of preset.engines) {
        if (entry.engine !== engine) continue;
        for (const item of undocumentedParams(engine, entry.params)) missing.push(`${preset.id}: ${item}`);
      }
    }
    check('engines', `${engine}: every param the presets give it is on its page`, missing.length === 0, missing.join('; '));
  }
}

/** The text of a level-2 section of a Markdown text, by its exact heading, or null. */
function levelTwoSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

function testStructureRecipes() {
  const page = enginePage('structure');
  const stampTypes = [...new Set(Object.values(RECIPE_STAMP_TYPES).filter(Boolean))];
  const rows = new Map();
  for (const { line } of proseLines(page)) {
    const match = /^\|\s*`([A-Za-z]+)`\s*\|/.exec(line);
    if (match && Object.hasOwn(STRUCTURE_RECIPES, match[1]) && !rows.has(match[1])) rows.set(match[1], line.slice(1, -1).split('|').map((cell) => cell.trim()));
  }
  for (const [name, recipe] of Object.entries(STRUCTURE_RECIPES)) {
    const section = levelTwoSection(page, name);
    check('engines', `structure recipe ${name}: has its section`, section !== null);
    const row = rows.get(name);
    const stamp = RECIPE_STAMP_TYPES[name] ?? null;
    const stampCell = row ? row[2] : '';
    const stampOk = stamp
      ? stampCell.includes(`\`${stamp}\``)
      : !stampTypes.some((type) => stampCell.includes(`\`${type}\``));
    check('engines', `structure recipe ${name}: its table row reads stamp ${stamp ?? 'none'}`, Boolean(row) && stampOk, row ? `the row says ${stampCell}` : 'no row');
    if (section === null) continue;
    const missing = Object.keys(recipe.defaults).filter((key) => !COMMON_STRUCTURE_PARAMS.includes(key) && !section.includes(`\`${key}\``));
    check('engines', `structure recipe ${name}: every default is a documented param`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : '');
  }
}

/** Whether a page names a value as code: `value` or 'value'. */
function namesValue(text, value) {
  return text.includes(`\`${value}\``) || text.includes(`'${value}'`);
}

function testEngineVocabulary() {
  const celestial = enginePage('celestial');
  for (const component of CELESTIAL_COMPONENTS) {
    check('engines', `celestial component ${component}: has its section`, new RegExp(`^### ${component}$`, 'm').test(celestial));
  }
  const water = enginePage('waterEffect');
  for (const effect of Object.keys(WATER_EFFECT_DEFAULTS).filter((key) => key !== 'common')) {
    check('engines', `waterEffect effect ${effect}: has its section`, new RegExp(`^### ${effect}$`, 'm').test(water));
  }
  const vocabularies = [
    ['fauna', 'behaviour', FAUNA_BEHAVIORS],
    ['fauna', 'species', SPECIES_IDS],
    ['fauna', 'altitude mode', ALTITUDE_MODES],
    ['emitter', 'particle style', PARTICLE_STYLES],
    ['emitter', 'ground mode', GROUND_MODES],
    ['lightEffect', 'glow shape', GLOW_SHAPES],
  ];
  for (const [engine, label, values] of vocabularies) {
    const missing = values.filter((value) => !namesValue(enginePage(engine), value));
    check('engines', `${engine}: every ${label} is named on its page`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : '');
  }
}

// ---- Craft ---------------------------------------------------------------------------------------
/** The ids in an instruments cell: each comma-separated item's first word, notes in brackets dropped. */
function instrumentIdsOf(cell) {
  return cell.replace(/\([^)]*\)/g, '').split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean);
}

/** The rows of the architecture's craft table (craft, model kind, instruments), by craft id. */
function craftTableRows(text) {
  const rows = new Map();
  let inTable = false;
  for (const { line } of proseLines(text)) {
    if (/^\| craft \| model kind \| instruments \|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) break;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    rows.set(cells[0], cells);
  }
  return rows;
}

function testCraftDocs() {
  const architecture = readFileSync(ARCHITECTURE_DOC, 'utf8');
  const rows = craftTableRows(architecture);
  const countMatch = /There are (\d+) ids/.exec(architecture);
  check('craft', `architecture: the instrument count is ${INSTRUMENT_IDS.length}`, countMatch !== null && Number(countMatch[1]) === INSTRUMENT_IDS.length, countMatch ? `it says ${countMatch[1]}` : 'no count');
  const controls = readFileSync(CONTROLS_DOC, 'utf8');
  const perCraft = levelTwoSection(controls, 'What the controls mean for each craft') ?? '';
  const profiles = levelTwoSection(controls, 'Craft profiles: the Phase 3 craft') ?? '';
  for (const { id } of craftRegistry.list()) {
    const module = craftRegistry.get(id);
    if (!module) {
      check('craft', `${id}: has a registered module`, false);
      continue;
    }
    const row = rows.get(id);
    const kindOk = Boolean(row) && row[1].split(/\s+/)[0] === module.simProfile.model;
    check('craft', `architecture: ${id} flies the ${module.simProfile.model} model`, kindOk, row ? `the row says ${row[1]}` : 'no row');
    const documented = row ? instrumentIdsOf(row[2]) : [];
    check('craft', `architecture: ${id} has its instruments in order`, documented.join(',') === module.instruments.join(','), `the row says ${documented.join(', ')}; the module has ${module.instruments.join(', ')}`);
    check('craft', `controls: ${id} has a row in "What the controls mean for each craft"`, perCraft.includes(`| ${module.name} |`));
    if (!PHASE1_CRAFT.includes(id)) {
      check('craft', `controls: ${id} has its full profile`, profiles.split(/\r?\n/).includes(`### ${module.name}`));
    }
  }
}

// ---- npm scripts ---------------------------------------------------------------------------------
function testScripts() {
  const scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const named = (name) => readme.includes(`\`npm run ${name}\``) || readme.includes(`\`${name}\``) || (name === 'test' && readme.includes('`npm test`'));
  const missing = scripts.filter((name) => !named(name));
  check('scripts', `README.md names all ${scripts.length} npm scripts`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : '');
}

testLinks();
testPresets();
testSections();
testEngineTable();
testTemplates();
testWindParams();
testPresetParams();
testStructureRecipes();
testEngineVocabulary();
testCraftDocs();
testScripts();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(9)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} docs checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
