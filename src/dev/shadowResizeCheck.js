// Shadow map resize check (tools/steps/shadow-resize.json, dev server only): drives the perf
// governor's real degrade path (quality 'auto', a simulated frame load) until it lowers the shadow
// map from 2048 to 1024, then switches craft and views, resizes at night (shadows not live), at dawn
// and back up, and checks the sun's shadow render target follows every time. The step file runs
// under tools/smoke-test.mjs, which fails on any console warning, so a destroyed shadow depth
// texture used in a submit (the WebGPU warning the resize could leave) fails the run.
//
// Every check reports through check(): a failure is a console.error (which fails the run).

const CRAFT_TOUR = Object.freeze(['jet', 'glider', 'bushplane', 'helicopter', 'jet']);

/** Installs window.__dwShadow for the step file. game: window.DRIFTWING. */
export function installShadowResizeCheck(game) {
  const { ctx } = game;
  const { settings, bus } = ctx;
  const sky = ctx.systems.sky;
  const camera = ctx.systems.camera;
  const qualityLog = [];
  const unsubscribe = bus.on('quality:changed', (quality) => qualityLog.push({ name: quality.name, reason: quality.reason, shadow: quality.shadowMapSize }));
  const results = [];

  function check(name, passed, detail) {
    results.push({ name, passed: Boolean(passed), detail });
    const line = `[shadow check] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`;
    if (!passed) console.error(line);
    return line;
  }

  function wait(ms) {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms));
  }

  /** Waits until at least count frames have rendered. */
  async function frames(count) {
    const start = game.state.frame;
    const deadline = performance.now() + 30000;
    while (game.state.frame - start < count && performance.now() < deadline) await wait(16);
  }

  /** Polls until test() holds or timeoutMs passes; returns whether it held. */
  async function until(test, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (test()) return true;
      await wait(100);
    }
    return test();
  }

  const shadow = () => sky.getShadowState();

  return {
    /** Starting state: the shadow pass has run at the boot quality's size. */
    async setup() {
      settings.set('dynamicResolution', false);
      settings.set('quality', 'high');
      await frames(20);
      const state = shadow();
      return check('setup', state.target === 2048,`backend ${ctx.backend}, quality ${ctx.quality.name}, shadow ${JSON.stringify(state)}`);
    },

    /** The governor's own degrade path, down to a 1024 shadow map, under a simulated load. */
    async degradeByGovernor() {
      const before = shadow();
      qualityLog.length = 0;
      settings.set('quality', 'auto');
      ctx.perf.simulateLoad({ baseMs: 45, scaledMs: 0 });
      const reached = await until(() => game.state.perf.qualityIndex <= 1, 40000);
      ctx.perf.simulateLoad(null);
      await frames(30);
      const after = shadow();
      const degrades = qualityLog.filter((entry) => entry.reason === 'auto-degrade');
      return check('governor degrade', reached && degrades.length >= 2 && after.size === 1024 && after.target === 1024 && after.resizes > before.resizes,
        `${degrades.map((entry) => `${entry.name} (${entry.shadow})`).join(' -> ')}; shadow ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    },

    /** Craft switches and view swaps on the degraded quality (where the warning burst was seen). */
    async craftTour() {
      const visited = [];
      for (const craft of CRAFT_TOUR) {
        if (!ctx.craftRegistry.has(craft)) continue;
        settings.set('craft', craft);
        await frames(45);
        camera.toggleFirstThirdPerson();
        await frames(30);
        visited.push(`${craft} ${camera.isFirstPerson() ? 'first' : 'third'}`);
      }
      const state = shadow();
      return check('craft and view tour', state.target === 1024 && visited.length >= 4, `${visited.join(', ')}; shadow ${JSON.stringify(state)}`);
    },

    /** A resize at night (shadows not live: the map does not re-render by itself), then dawn. */
    async nightResize() {
      settings.set('quality', 'high');
      await frames(20);
      const day = shadow();
      sky.setDayTime(0.0, { transition: 0 });
      await frames(20);
      const night = shadow();
      settings.set('quality', 'low');
      await frames(30);
      const resized = shadow();
      sky.setDayTime(0.35, { transition: 0 });
      await frames(30);
      const dawn = shadow();
      return check('night resize', day.target === 2048 && night.autoUpdate === false && resized.target === 1024 && dawn.autoUpdate === true && dawn.target === 1024,
        `day ${JSON.stringify(day)}, night ${JSON.stringify(night)}, resized at night ${JSON.stringify(resized)}, dawn ${JSON.stringify(dawn)}`);
    },

    /** Back up to the boot quality (a grow), with a craft switch right after. */
    async restore() {
      settings.set('quality', 'high');
      settings.set('craft', 'glider');
      await frames(60);
      const state = shadow();
      unsubscribe();
      const failed = results.filter((entry) => !entry.passed).length;
      return check('restore', state.target === 2048 && failed === 0, `shadow ${JSON.stringify(state)}; ${results.length - failed}/${results.length} earlier checks passed`);
    },
  };
}
