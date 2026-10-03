# Phase 2 progress

Spec: [docs/specs/phase2.md](specs/phase2.md). Contracts: [docs/specs/phase2-contract.md](specs/phase2-contract.md).
Branch: `v2-phase2`, cut from tag `v2-structure`. Read this file first when resuming.

## Plan

| Wave | Work | Branches | Status |
| --- | --- | --- | --- |
| 1 | Milestone A placement and terrain stamps, Milestone B engine framework and F9 debugger, Milestone C director and regional weather, Milestone D spawn audio | `p2/placement`, `p2/framework`, `p2/director`, `p2/audio` | done |
| 2 | The ten engines: vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece | `p2/engines-*` | done |
| 3 | Milestone E presets 1-10, 11-20, 21-30 (verified and committed per batch) | `p2/presets-*` | next |
| 4 | Milestone F discovery loop: journal, copilot tour guide, world map, seed links | `p2/discovery`, `p2/copilot-guide` | done |
| 5 | Milestone G verification: ?test=spawns, ?test=determinism, ?test=terrain, 10-minute soak; docs/spawns.md with the preset template, architecture, controls, copilot API, CHANGELOG; review and fixes; tag `v2-phase2` | `p2/verify` | planned |

## Decisions

- **No CLASSIC mode (the structure correction wins).** Spawns apply their full WindField forces in V2; the assists are the safety net. "Both modes" in the soak test means the first person and third person views.
- **Map key.** M opens the world map (mapToggle). The mic toggle moves to Shift+M.
- **Machine load (owner's rule).** Ignore PC load entirely: never wait for quiet, never build load tooling, never chase spikes the busy machine causes. Run each test once and report its numbers. Correctness criteria still hold.
- **One director name.** `createGameDirector(ctx, options)` (src/spawns/director.js) wires the director to the game; `createDirector(options)` is its headless core for the lab. The spawns system creates the game director itself when it starts and exposes it as `ctx.systems.spawns.director`; there is no `attachDirector`.
- **The director ticks itself.** The spawns system calls `director.update()` every frame and the director ticks at 2 Hz on the flight clock (`DIRECTOR_TICK_SECONDS`), so its activation log depends only on the seed and the flown path.
- **One budget view.** The SpawnManager's `budgets` (heavy limit 2, real-light cap 4, per-engine caps from `engine.budget`, else `DIRECTOR_BUDGETS.engines`) is both the engines' `ctx.budgets` and the director's budgets.
- **Dev presets bypass the director.** `spawns.forceSpawn` goes through `director.forceSpawn` for the director's own presets (`PRESETS`), and straight through the manager for presets added with `debug.addPreset`, so dev test presets are never scheduled by the director.
- **Shedding only when it helps.** The director's load shedder refuses a level with nothing to take away (no heavy candidates and no live spawns), so with no content the governor behaves exactly as in Phase 1.

## Done

- Branch `v2-phase2` created from `v2-structure`; the owner specs and the Phase 2 contracts are in docs/specs/.
- **Wave 1 merged** (each with `git merge --no-ff`):
  - `f524f20` chore: merge placement and terrain stamps (Milestone A)
  - `19f1f4c` chore: merge spawn audio (Milestone D)
  - `0657a32` chore: merge spawn engine framework and f9 debugger (Milestone B)
  - `2d6c16e` chore: merge event director and regional weather (Milestone C)
  - Conflicts resolved: one `weatherChanged` in src/core/events.js (`state` and `previous` enums, `region` the string `"rx:rz"`; the weather system never emits `previous: null`), the framework's spawn and achievement events kept; src/main.js keeps the terrain dev test and world options, `SPAWN_ENGINE_FACTORIES`, and the weather, spawns and spawnDebugger factories and update order; src/spawns/presets/index.js; docs/architecture.md.
- **Wave 1 wiring:**
  - `36fda6e` feat: the SpawnManager honours the director's `opts.duration`, gains `setLodBias(bias)` / `getLodBias()` / `spawnCount()`, and exposes the shared budget view.
  - `e13c93d` feat: the spawns system creates and drives the director (placement feed, discovered check, budgets, `getNearby` for the copilot).
  - `ad3ad89` feat: the F9 debugger's Director section shows the real `getState()` and `getNearby()`.
  - `7d4956f` test: tools/steps/director-game.json runs beside the live director.
  - `5642867` docs: architecture for the wiring.
  - Already joined by the merges: the placement feed reaches the manager as `world.placement`; a typed `discovery` with a `presetId` plays the audio discovery chime (once).
- **Verified on the integrated tree:**
  - `npm run build`, `npm run build:single` (V1 SHA-256 matches; no dev test kit or fixtures in the bundle), `npm run test:v1` 2/2.
  - Labs: flight 82/82, fpv 87/87, helicopter 46/46, jet 57/57, wingsuit 37/37, input 34/34, settings 28/28, storage 54/54, copilot 56/56, copilot-server 8/8, terrain 162/162, spawns 88/88, director 47/47 (24 h), audio 177/177 on both backends.
  - `tools/spawn-check.mjs` 53/53 on WebGPU and WebGL2.
  - `node tools/run-harness.mjs --test terrain`: PASS on both backends (0 cracks, 483 worker chunks identical, collision 0.00001 m, 0/0 console, site-list hash 990ea5d1c3b00efe).
  - Reduced flight harness (seeds INTEG-A and INTEG-B, glider and jet, both views, 45 s): hard criteria pass on both backends (0 NaN, 0 penetrations, 0/0 console, heap growth at most 21.3 MB, 24/24 scripted checks). Frames over 50 ms: 8 on WebGPU and 3 on WebGL2, every one main-thread work with 0 systems time and 0 GC, while 43-90 % of the machine's CPU was other processes'.
  - Smokes, 0 errors and 0 warnings: built V2 and the shell on both backends, built V2 with `?dev=1` (the director in the F9 panel), the dev server's weather-sky and director-game steps on both backends.
  - Live director check on the dev server, both backends: the test engines through the dev hook, the F9 Spawn button and `forceSpawn` fire `spawnActivated`, the End buttons fire `spawnEnded`, `getState()` ticks at 2 Hz on the flight clock, the shedder drives the manager's LOD bias (1, 0.7, 0.5 and back), the weather state machine follows clear -> building -> storm -> clearing at the player and forced states emit `weatherChanged` with the `"rx:rz"` region.

## Done (Milestone F)

- Discovery loop merged from `p2/discovery`:
  - the journal records spawn discoveries and journalStat/achievement records;
  - the glass discovery card;
  - the world map on M, with worker map tiles (src/world/mapTileGen.js and mapTiles.worker.js, reusable for Phase 3's far field);
  - seed links (`/?v=2#seed=X&t=`), the seed setting and Copy link;
  - the mic moved to Shift+M.
- Copilot tour guide merged from `p2/copilot-guide`:
  - src/copilot/tourGuide.js: nearby, go-to, find a thermal, chase the storm and next discovery;
  - proactive callouts, with the setting copilotCallouts;
  - remote flightState nearby[] and activeEvents[];
  - docs/copilot-api.md.
- Verified on the merged tree: labs discovery 39/39, copilot 225/225, settings, input, storage, spawns and director all pass; build:single; built V2 smoke on WebGPU and WebGL2 with 0 errors and 0 warnings.

## Done (wave 2: the ten engines, Milestone B)

- **Merged** into `v2-phase2` in this order, each with `git merge --no-ff`:
  - `8170e35` chore: merge the vortex and windModifier engines (Milestone B)
  - `84fbbc9` chore: merge the emitter and lightEffect engines (Milestone B)
  - `b0fb587` chore: merge the weatherVolume and celestial engines (Milestone B)
  - `4594d13` chore: merge the fauna and waterEffect engines (Milestone B)
  - `a07cc73` chore: merge the structure and setPiece engines (Milestone B)
  - Conflicts were resolved so that both sides survive:
    - src/main.js: one import and one `SPAWN_ENGINE_FACTORIES` line per engine, in ENGINE_NAMES order (vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece).
    - src/spawns/spawnManager.js: four branches had each added `registerPrewarm`. One is kept (a function or null), next to `water`, `surfaces` and `weatherState`.
    - src/core/events.js: both `journalStat` and `wildlifeQuiet` are kept.
    - tools/spawn-check.mjs: the stricter debugger row check is kept (one row per engine). A new check confirms that the ten game engines are registered once each, in ENGINE_NAMES order.
    - docs/architecture.md: every engine row, section and test row is kept. Duplicates are folded together: the sky modifier priorities, the engine ctx paragraph and the achievement event row.
  - sky.js, clouds.js, the audio hooks and the copilot hooks merged without conflicts.
- **Wiring** (committed on `v2-phase2`):
  - `7b55af8` feat: the fauna engine honours `wildlifeQuiet`. While any source holds it, the fauna make no calls, breach calls or scatter cries, and their voice is eased out. `stats().quiet` reports the state.
  - `b8df207` refactor: each shared engine helper now has one implementation, in `src/spawns/engines/engineKit.js`:
    - `createWindSample`, used by every engine's wind source (windSources.js, weatherVolume, structure and fauna);
    - the param readers: `params.js` is folded into engineKit as `createParamView` (reads by name), built on `createParamReader` (reads by value). Every engine that uses them reports a bad param as `[DRIFTWING] <engine> preset "<id>": param "<path>" <problem>`;
    - `roll` and `rollInteger`, plus `smoothstep` for windSources.js.
  - `66340d1` feat: a vortex over open water writes a foam and excitation trail into the water effects layer every 0.25 s. A waterspout therefore leaves a wake, which glows in a bioluminescent bay.
  - `8e9af26` docs: the engine factories register once each, in ENGINE_NAMES order.
  - `243a4d8` feat: one voice per preset, through engineKit's `ownsPresetAudio`. An entry's `voice`, `sound` or `ownsAudio` flag decides. Without a flag, the preset's first engine entry opens `preset.audio`. Before this change, five engines opened the voice by default and the waterEffect engine never did.
  - `4bbebb3` fix: the terrain fixture volcano and waterfall carried emitter params from before the engine existed (`kind`). The real emitter refused them, which failed ?test=sites.
  - `64b3207` test: spawn-check now waits for the GPU counters to settle before taking its memory baseline. Terrain chunks that landed during cycle 1 were read as a leak on WebGPU.
  - `f007d6c` test: the sites checks expect all six fixtures, now that the emitter is registered.
- **Verified on the integrated tree** (each test run once, per the owner's rule):
  - `npm run build` and `npm run build:single` succeed. The V1 SHA-256 matches, and no dev kit is in the bundle. `npm run test:v1` passes 2/2.
  - Labs:
    - flight 82/82, fpv 87/87, helicopter 46/46, jet 57/57, wingsuit 37/37;
    - input 34/34, settings 28/28, storage 54/54, copilot 225/225, copilot-server 17/17, discovery 39/39;
    - terrain 162/162, spawns 88/88, director 47/47;
    - structure 67/67, setpiece 47/47, wind-engines 55/55;
    - audio 177/177 on both backends.
  - `tools/spawn-check.mjs`: 55/55 on WebGPU and 55/55 on WebGL2. The first run, before `64b3207`, gave 52/54 on WebGPU (cycle 1 memory) and 54/54 on WebGL2.
  - Every engine step file ran on both backends against a dev server on port 5263, with 0 errors and 0 warnings each time:
    - vortex 9, windModifier 9, emitter 13, lightEffect 13, weatherVolume 19 and celestial 11 checks;
    - fauna 11 (`seed=ENGINEFAUNA`) and waterEffect 9 (`seed=ENGINEWATER`);
    - structure 20; structure-sites 9/9 (`test=sites`, passing after `4bbebb3` and `f007d6c`); setPiece 10/10.
  - An integration step file (kept in the scratchpad, not in the repo) passed 4/4 on both backends. It checks three things:
    - the waterspout writes its wake into the water layer;
    - the fauna fall quiet while `wildlifeQuiet` holds;
    - the wind sources return to baseline after dispose.
  - `node tools/run-harness.mjs --test terrain`: PASS on both backends. 0 cracks, 483 worker chunks identical, collision 0.00001 m, 0/0 console, site-list hash 990ea5d1c3b00efe.
  - Reduced flight harness (INTEG-A and INTEG-B, glider and jet, both views, 45 s), on both backends:
    - Passed: 0 NaN, 0/0 console, scripts 24/24, 0 frames over 50 ms, and heap growth of at most 22.7 MB (WebGPU) and 22.1 MB (WebGL2).
    - Failed: one penetration on each backend, both in the same run (see Open issues).
  - Smokes of built V2 and of the shell on both backends: 0 errors and 0 warnings.

## Done (Milestone E batch 3: presets 21-30, branch `p2/presets-21-30`)

- **The ten presets**, pure data in src/spawns/presets/, registered in spec order (21-30):
  - `abandonedAirfield` (site, structure airfield on a flatten stamp): windsock on the real wind, graded landings, ground-start spots ("Start on ground" prefers the nearest discovered airfield).
  - `meteorShower` (common night event, celestial meteors, sky-anchored): the dense night candidate grid (3.5 km cells, chance 0.6); ends at dawn.
  - `totalSolarEclipse` (legendary day event, celestial eclipse): about 92 s crossing, 16 s totality, the wildlife falls quiet.
  - `comet` (rare heavy night event, celestial comet, sky-anchored): lasts the rest of the night (`untilDawn`), comet lure declared.
  - `skyLanternFestival` (rare night event, emitter lanterns on the WindField plus lightEffect launch lights): gathered at lighthouses and balloon fairs (`filters.near`).
  - `floatingIslands` (rare heavy site, structure islands over two islandBase stamps): waterfalls into mist, landable tops, islands lure.
  - `skyWhale`* (rare heavy event, fauna drift plus a windModifier slipstream from the preset's `wind`): a speed and lift lane; whale lure.
  - `crystalSpires` (site, structure spires plus lightEffect motes): approach-driven hum, chimes between spires.
  - `jetStream`* (uncommon event, windModifier jetStream plus emitter cirrus wisps along the same axis): a 38 m/s tailwind 2200 m up.
  - `stormChase` (legendary set piece over the batch 1 `supercell` and `tornado` presets): build with a lowering wall cloud, touchdown, rope-out; journalStat closestTornado (min) and stormsChased (add, within 5 km).
- **Contract additions (additive, generic):**
  - schema `filters.near: { landmarks: [arch | monoliths | lighthouse | balloons], radius (m, up to 20 km) }`, read by the director: a candidate moves onto the nearest Phase 1 landmark of those types (through `world.landmarkSitesNear`, which `createGameDirector` now passes in `terrain`), or is rejected as `near`. `LANDMARK_TYPES` exported from schema.js.
  - celestial instance params `untilDawn` (bool) and `dawnElevation` (deg, default -6): the event ends at the first dawn after a night it has seen (docs/engines/celestial.md).
  - weatherVolume `instance.control.wallCloud` (0..1, default 1): a set piece lowers the wall cloud (docs/engines/weatherVolume.md).
  - fauna param `fadeOut` (s, default 0): an event's agents shrink away before its duration and the group ends itself (docs/engines/fauna.md).
- **Tests added or retargeted:**
  - tools/lab/terrain.mjs: the Phase 1 digests now hold for the world WITHOUT site presets; with the real (stamped) presets every sample outside every stamp's bounds must be bit-identical to it (the first stamped presets changed the digests on purpose).
  - tools/lab/discovery.mjs: the tile cache tag check follows the real presets.
  - tools/lab/director.mjs: `--presets real` measures pacing on the game's own presets; a new `near` check proves the landmark filter (it caught a stale distance on moved candidates, fixed in director.js).
  - tools/lab/preset-wind.mjs (new): the SIM glider and jet flown through the real jet stream and sky whale air.
  - src/dev/presetChecks.js and tools/steps/presets-21-30.json (new): every preset force-spawned at its time and weather, framed, discovered (event, journal entry, card), and disposed back to its memory, wind and sky baselines; the real stamped sites with the site-list hash, ground start, a graded landing, the eclipse at totality, the comet's dawn, the storm chase's stages and journal statistics. Set-piece children missing from the tree get dev stand-ins (only in that case).
  - ?test=terrain gains `&presets=real` (`run-harness.mjs --test terrain --presets real`): seams, worker parity and collision around the real presets' stamps.
  - tools/spawn-check.mjs: its memory accounting and lure counts allow for the game's own live site spawns.
- **Merge notes:** stormChase names the presets `supercell` and `tornado` (batch 1). In this branch alone the director can pick stormChase only in building or storm weather and refuses it until those presets exist; the browser checks add stand-ins. The pacing check with only this batch's presets fails by design during the day (no day common event here); batch 2's geese and batch 1's commons cover it after the merge (run `node tools/lab/director.mjs --presets real` on the merged tree).

## Current state (resume from here)

- `v2-phase2` holds Phase 1 and Milestones A, B (all ten engines), C, D and F. All wave 2 work is merged and committed locally. Nothing is pushed; the owner pushes.
- The five `p2/engines-*` branches and their `.claude/worktrees/p2-e-*` worktrees can be removed once the owner is happy with them. Unlink each worktree's node_modules junction first.
- **Next: Milestone E.** Launch `.claude/orchestration/p2-presets.js`, which starts three batch engineers (presets 1-10, 11-20 and 21-30), each in a fresh worktree from `v2-phase2`. Merge each batch and verify it the same way as above.
- The preset engineers' references:
  - docs/engines/<name>.md, the reference for every param;
  - the preset authoring notes below;
  - docs/specs/phase2-engine-api.md.
- After Milestone E comes Milestone G:
  - ?test=spawns, ?test=determinism and ?test=terrain;
  - the 10-minute soak (5 seeds, both views);
  - docs/spawns.md with the preset template, plus the architecture, controls and copilot docs and the CHANGELOG;
  - a review round, then the `v2-phase2` tag.
- Then Phase 3 (docs/specs/phase3.md, with its own docs/phase3-progress.md), then Phase 4.

**Preset authoring notes (contract additions from wave 2):**
- **How an engines entry reaches create().** The entry `{ engine, params }` arrives as `engine.create(preset, params, rng)`. The `params` object is built in three layers:
  - the entry's own params;
  - then the overrides from `activate(..., { params: { [engine]: overrides } })` (a set piece child's `params`);
  - then the activation fields: `position` (a new Vector3), `heading`, `site`, `startTime`, `scale`, `duration` and `seed`.
- Each entry gets its own seeded rng.
- Strict engines refuse an unknown param and name it: vortex, windModifier, emitter, lightEffect, structure and setPiece.
- **Renamed wind params.** An updraft's speed is `updraft` (not `strength`), and a slipstream's lane start is `behind` (not `offset`). The emitter's own `windSource` block is separate and keeps its own names: its updraft speed is still `strength`.
- **One voice per preset.** On a multi-engine preset, set `voice`, `sound` or `ownsAudio` explicitly when the first entry should not own `preset.audio`.
- **Live control for set pieces:**
  - vortex: `instance.control.{ intensity, ropeOut }`;
  - windModifier: `control.{ strength, strengths[i] }`;
  - structure: `instance.params.{ glow, sway, rotorSpeed, audio }` and `setParam`.
- **Events:**
  - typed `wildlifeQuiet { source, quiet }`, emitted by the celestial eclipse; the v1 birds, the audio cues and the fauna listen;
  - `fauna:formation`, `fauna:scatter` and `fauna:call`;
  - `structure:gate`, `structure:course` and `structure:landing`;
  - `setPiece:stage`, `setPiece:narrate` and `setPiece:ended`;
  - typed `achievement` and `journalStat`, with the journal keys `stormsChased`, `closestTornado` and `bestCanyonRun`.
- **Engine ctx additions:**
  - `registerPrewarm` (or null);
  - `water`: the water effects layer, or null;
  - `surfaces`: the extra ground surfaces;
  - `weatherState()`: call it at create only.
- **Sky and cloud additions:**
  - the uniforms `cloudGlory` and `cloudBow`, and `sky.getModifierLevels()`;
  - the sky modifier priorities: weather 10, weatherVolume 15, emitter immersion 20, lightning flash 30, eclipse 30.
- **Other APIs:**
  - `spawns.findGroundStart(x, z)` and the optional engine hook `groundStart(preset, params, site)`;
  - `structureStamps(recipe, options)`, which builds preset stamps that are safe in the terrain worker;
  - `createGateSet` and `crossGates`, in src/spawns/engines/gateDetector.js.

**Standing rules:**
- The structure correction is the source of truth (no CLASSIC mode in V2).
- Ignore PC load entirely: run each test once and report its numbers.
- Before any `git worktree remove`, unlink the worktree's node_modules junction first.
- Push with full refspecs (`refs/heads/...`), because branch and tag names repeat.
- Never edit source files while a browser run is using the dev server: Vite reloads the page in the middle of the run.

## Open issues

- **Wave 2 reports, for the preset wave and Milestone G:**
  - Emitter on WebGPU: its frame update measured 0.5-5.4 B/frame across runs; WebGL2 measured 0-0.2. This looks like V8 re-optimisation.
    - tools/engine-alloc.mjs's pass limit went from 0.1 to 1 B/frame. That is a change of policy, and the lead should review it.
    - Event paths (a strike, bursts, eruption triggers, wind-grid probes, voice levels) allocate a few hundred bytes per event before V8 optimises them. They are reported separately (`--events`).
  - Water effects layer on WebGPU: 0.098 heap samples per frame against the 0.1 limit, all from splash events.
  - Allocations in shared code outside the engines:
    - each WindField terrain probe allocates about 10 KB in worldgen's noise (the emitter rations its probes to about 2 KB/frame);
    - the fauna's terrain queries allocate about 345 B/frame;
    - the WindField allocates about 184 B per 3 samples with sources present, against 146 B in calm air;
    - three's compute dispatch allocates 0.3-0.65 KB/frame on WebGPU;
    - sky.js `set()` allocates about 12 B/frame while a flash or an immersion eases.
  - In the running game, a fractional number written to a THREE.Vector3, a Color or a shared `{ x, y, z }` literal is boxed. engineKit's `createWindSample` and typed arrays avoid it, and new engine code must as well.
  - Fauna cost: an 8000-starling murmuration costs 6-7 ms of engine CPU per frame. Use 2500-4000 starlings per preset.
  - Per-instance GPU frame time cannot be measured headless (vsync-paced frames on the busy machine). The engine docs give draw calls and triangles instead.
  - The engine audio (the tornado and turbine voices, the cockpit rattle, thunder, the whale calls) is verified by measured levels only. A listening pass by Kyle is worthwhile.
  - The node labs' allocation checks measure node's tiering, not Chrome's. A Float64Array value passed to a call V8 does not inline gets boxed. The set-piece lab catches this about half the time, and every time with `--no-maglev`.
  - The vortex, windModifier, weatherVolume, celestial, fauna and waterEffect engines still validate params with their own local readers, so their message wording differs slightly from the engineKit format. Folding them into `createParamView` is a Milestone G cleanup. Every one of them names the field.
  - Dev fixtures: spawnTestKit's testUpdraft and terrainFixtures' `wind` entries use `strength` / `speed`. No windModifier part reads them, so nothing refuses them today.
  - The in-game waterspout check forces `surface: 'water'` over the test seed's mountains. The wake check (scratchpad) proved the write path, and the lab covers the land and water blend.
  - The debug airfield without a flatten stamp can extend over water. Real airfield presets use the stamp.
  - spawn-check on WebGPU needed the settle wait (`64b3207`). Its first cycle saw 6 late geometries (terrain chunks) before it.

- **Pacing needs dense common content.** With the lab's stub presets 1.1-1.6 % of droughts run past 90 s (night, inland). The real presets need at least one "anywhere, anytime" common event dense enough (for example cellSize 3500, chance 0.6).
- **Storm clouds.** Since wave 2 the v1 cloud field follows the sky modifiers (`cloudShading.js`): darker blue-grey undersides in a storm and dimmed by an eclipse. Storm cloud masses come from the weatherVolume engine. A very faint sun disc (about 1 %) can still show under storm overcast.
- **Stamped presets change the terrain digests.** tools/lab/terrain.mjs guards Phase 1 bit-identity only while `PRESETS` places no stamps; when the first stamped preset lands, retarget that test or record new digests deliberately.
- **First query of a stamped cell** resolves placement once (3-10 ms on the loaded machine), in the worker for chunks and on the main thread for the first collision query there.
- **Real lights cost shading while they exist.** The light pool holds only the lights engines declare (`budget.lights`, capped at 4). Meshes on shared materials must be pooled (`createMeshPool` / `createInstancedPool`), or three r184 keeps each disposed mesh alive (about 8 KB each).
- **Occlusion rays allocate a little** (worldgen noise, 0.02-0.03 B/frame after warm-up); the spawn code itself measures about 0.02 B/frame.
- **Audio recipes are verified by measurement only**, not by listening; a listening pass by Kyle is worthwhile. Inverse-law recipes stay above the audibility floor to about 60 km (presets cull at lod.far). V8 boxes doubles passed to AudioParams (about 40-60 KB/s with 10 voices), which code cannot avoid.
- **The audio lab's trigger-dynamics check is randomised.** The thunder strike uses `Math.random`, so "thunder trigger stands out" (> 6 dB) measured 5.7 dB once on WebGPU during integration and 7.7-9.5 dB in the three runs after it. Seeding the recipe randomness for offline renders would make it deterministic.
- **Lure silhouettes** are tuned on the test presets; the real heavy presets should check theirs against horizon screenshots.
- **performance.memory** heap figures exist only in Chrome and are coarse.
- **Golden-frame comparisons across runs** are not pixel-exact (vegetation sway, birds, cloud drift); the exact proof is the same-frame A/B in tools/steps/golden-frame.json.
- **Full harness matrix.** Only reduced flight harnesses were run in waves 1 and 2. The full 36-run matrix is for Milestone G.
- **Penetration at a high-speed terrain strike (hard criterion; for Milestone G).** In the wave 2 integration harness, the same run failed on both backends: INTEG-A, jet, first person, run 4 of 8.
  - The scripted jet hit terrain at about 44.5 s and 286 m/s, and the soft crash fired.
  - At that strike it penetrated 8.96 m (WebGPU) and 13.56 m (WebGL2), for 37 frames each.
  - The same run flown alone passed with no crash.
  - The wave 2 base (478cda7, the same harness and seeds, WebGPU) had no penetration. Its jet crashed softly at 226-227 m/s in runs 3 and 7.
  - The engine branches change nothing in flight while no spawn and no extra ground surface exists. The harness flies no spawns, and a same-seed frame comparison of base and integrated builds is identical (233 against 234 draw calls, 181 fps).
  - The flown path depends on the run order and the frame timing. The p2/engines-structure-setpiece engineer reproduced the same class of penetration on the base (STRUCT-A, jet, third person, 250 m/s, 1.21 m deep).
  - The Phase 1 contact code lets a strike above about 250 m/s sink in before the soft crash takes over. That belongs to the flight-model or harness owner, in the Milestone G matrix.
  - Other soft crashes (not a hard criterion): 2 on WebGPU and 1 on WebGL2 in the same harness, all jet strikes.
