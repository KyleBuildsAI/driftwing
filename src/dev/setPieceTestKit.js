// Dev-only SetPieceEngine test kit: a timeline that orchestrates the framework's test engines
// (src/dev/spawnTestKit.js: a marker, a rising wind column with a real light, a heavy funnel lure)
// and a StructureEngine child (the crystal spires of src/dev/structureTestKit.js, whose glow it
// ramps), through every trigger kind, a tracked child, narration and records. tools/lab/setpiece.mjs
// runs it headless; tools/steps/engine-setPiece.json runs it in the game through the dev hook.
// Never part of a production build.

const TEST_FILTERS = Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null });

/** The dev timeline's engine params (every field of docs/engines/setPiece.md at least once). */
export const DEV_TIMELINE = Object.freeze({
  radius: 3000,
  narration: Object.freeze({ priority: 3, ttl: 30 }),
  children: Object.freeze({
    marker: Object.freeze({ preset: 'testMarker', offset: Object.freeze({ along: 0, across: 0 }) }),
    spires: Object.freeze({ preset: 'devSpires', offset: Object.freeze({ along: 350, across: -260 }), params: Object.freeze({ structure: Object.freeze({ count: 5 }) }) }),
    column: Object.freeze({ preset: 'testUpdraft', offset: Object.freeze({ along: 450, across: 220 }) }),
    funnel: Object.freeze({
      preset: 'testLureFunnel',
      from: 'column',
      offset: Object.freeze({ along: 500, across: 0 }),
      track: Object.freeze({ speed: 30, heading: 90, wander: 25 }),
    }),
  }),
  stages: Object.freeze([
    Object.freeze({
      id: 'gather',
      duration: [4, 6],
      start: ['marker', 'spires'],
      ramps: [Object.freeze({ child: 'spires', param: 'glow', from: 0.2, to: 2.5, ease: 'smooth' })],
      narrate: ['Something is gathering {distance} {direction}.', 'Light is gathering {distance} {direction}.'],
    }),
    Object.freeze({
      id: 'rise',
      duration: 8,
      start: ['column'],
      until: Object.freeze({ playerDistance: Object.freeze({ child: 'column', max: 120 }) }),
      narrate: Object.freeze({ lines: ['A column of air is rising {distance} {direction}.'], target: 'column', delay: 1 }),
      marker: 'column-up',
    }),
    Object.freeze({
      id: 'funnel',
      when: Object.freeze({ any: [Object.freeze({ time: 1.5 }), Object.freeze({ weather: ['storm'] })] }),
      whenTimeout: 30,
      duration: 8,
      start: ['funnel'],
      end: ['marker'],
      until: Object.freeze({ all: [Object.freeze({ childActive: 'funnel' }), Object.freeze({ altitude: Object.freeze({ min: 100000 }) })] }),
      narrate: Object.freeze({ lines: ['The funnel is walking east, {eta} out.'], target: 'funnel' }),
    }),
    Object.freeze({
      id: 'fade',
      duration: 3,
      end: ['funnel', 'column', 'spires'],
      until: Object.freeze({ all: [Object.freeze({ childEnded: 'funnel' }), Object.freeze({ childEnded: 'column' })] }),
      narrate: ['{name} is over.'],
    }),
  ]),
  records: Object.freeze([
    Object.freeze({ id: 'closestFunnel', child: 'funnel', measure: 'closestDistance' }),
    Object.freeze({ id: 'nearColumn', child: 'column', measure: 'timeWithin', radius: 800 }),
  ]),
});

/** The dev set-piece preset (valid against src/spawns/schema.js with the setPiece engine registered). */
export function createSetPieceTestPreset(params = DEV_TIMELINE, id = 'devTimeline') {
  return Object.freeze({
    id,
    name: 'Dev timeline',
    category: 'setpiece',
    kind: 'event',
    rarity: 'legendary',
    heavy: false,
    candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.1 }),
    filters: TEST_FILTERS,
    engines: Object.freeze([Object.freeze({ engine: 'setPiece', params })]),
    lod: Object.freeze({ near: 2000, mid: 6000, far: 20000 }),
    lure: null,
    wind: [],
    audio: null,
    journal: Object.freeze({ title: 'Dev timeline', description: 'A SetPieceEngine test fixture.' }),
    discovery: Object.freeze({ radius: 3000, requireInView: false }),
    callouts: Object.freeze(['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Timeline check: {name}.']),
    lifetime: Object.freeze({ duration: [120, 150], despawn: Object.freeze({ distance: 12000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  });
}

/**
 * Installs window.__dwSetPiece on a running V2 (dev server): the framework's test kit, the structure
 * kit's presets and the dev timeline through the dev hook, and a run that records every bus event the
 * timeline causes. Failed checks call console.error, so the smoke test fails.
 */
export async function installSetPieceChecks(game) {
  const { ctx, state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const results = [];
  const log = [];
  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    results.push(line);
    if (!ok) console.error(`[setPiece check] ${line}`);
    return line;
  }
  await system.debug.loadTestKit();
  const structureKit = await import('./structureTestKit.js');
  for (const preset of structureKit.createStructureTestPresets()) if (!manager.getPreset(preset.id)) system.debug.addPreset(preset);
  if (!manager.getPreset('devTimeline')) system.debug.addPreset(createSetPieceTestPreset());
  const record = (type) => (payload) => log.push({ type, time: Math.round(state.time.elapsed * 10) / 10, ...payload });
  ctx.bus.on('setPiece:stage', record('stage'));
  ctx.bus.on('setPiece:narrate', record('narrate'));
  ctx.bus.on('setPiece:ended', record('ended'));
  ctx.bus.onTyped('spawnActivated', record('activated'));
  ctx.bus.onTyped('spawnEnded', record('spawnEnded'));
  const spoken = [];
  ctx.bus.on('copilot:speech', (payload) => spoken.push(payload.text));

  const api = {
    results,
    log,
    /** Starts the dev timeline ahead of the craft and returns its id. */
    start() {
      ctx.settings.set('copilotChatter', true);
      api.id = system.forceSpawn('devTimeline', { distance: 900 });
      return check('dev timeline started ahead of the craft', Boolean(api.id), api.id);
    },
    /** The set piece's timeline state now. */
    describe() {
      const parts = manager.getParts(api.id);
      if (parts.length === 0) return null;
      return manager.registry.get('setPiece').describe(parts[0]);
    },
    /** Waits (up to `seconds`) for the timeline to end, then checks what it did. */
    async finish(seconds = 90) {
      const started = performance.now();
      while (performance.now() - started < seconds * 1000 && !log.some((entry) => entry.type === 'ended')) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const stages = log.filter((entry) => entry.type === 'stage').map((entry) => entry.stage);
      const ended = log.find((entry) => entry.type === 'ended');
      const children = log.filter((entry) => entry.type === 'activated' && entry.presetId !== 'devTimeline').map((entry) => entry.presetId);
      const childEnds = log.filter((entry) => entry.type === 'spawnEnded' && entry.presetId !== 'devTimeline').map((entry) => entry.presetId);
      const narrations = log.filter((entry) => entry.type === 'narrate').map((entry) => entry.text);
      check('the stages ran in order', stages.join() === 'gather,rise,funnel,fade', stages);
      check('children started through the spawn manager', ['testMarker', 'devSpires', 'testUpdraft', 'testLureFunnel'].every((id) => children.includes(id)), children);
      check('every child ended through the spawn manager', ['testMarker', 'devSpires', 'testUpdraft', 'testLureFunnel'].every((id) => childEnds.includes(id)), childEnds);
      check('the stages narrated', narrations.length >= 3, narrations);
      // The copilot's chatter gate paces unsolicited lines (one per 30 s): at least one is spoken.
      const fromTimeline = spoken.filter((text) => /gathering|column of air|funnel is walking|is over/.test(text));
      check('the copilot spoke a narration line with its tokens filled', fromTimeline.length >= 1 && fromTimeline.every((text) => !text.includes('{')), spoken);
      check('the timeline ended complete with its records', Boolean(ended) && ended.completed === true && Number.isFinite(ended.records.closestFunnel), ended ?? 'no end');
      check('the set piece itself ended', log.some((entry) => entry.type === 'spawnEnded' && entry.presetId === 'devTimeline' && entry.reason === 'ended'), 'devTimeline spawnEnded');
      check('no spawn or light leaked', manager.getStats().leaks.windSources === 0 && manager.getStats().leaks.lights === 0, manager.getStats().leaks);
      const failed = results.filter((line) => line.startsWith('FAIL'));
      return check('setPiece checks', failed.length === 0, `${results.length - failed.length}/${results.length} passed`);
    },
  };
  window.__dwSetPiece = api;
  return api;
}
