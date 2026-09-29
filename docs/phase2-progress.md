# Phase 2 progress

Spec: [docs/specs/phase2.md](specs/phase2.md). Contracts: [docs/specs/phase2-contract.md](specs/phase2-contract.md).
Branch: `v2-phase2`, cut from tag `v2-structure`. Read this file first when resuming.

## Plan

| Wave | Work | Branches | Status |
| --- | --- | --- | --- |
| 1 | Milestone A placement and terrain stamps, Milestone B engine framework and F9 debugger, Milestone C director and regional weather, Milestone D spawn audio | `p2/placement`, `p2/framework`, `p2/director`, `p2/audio` | done |
| 2 | The ten engines: vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece | `p2/engines-*` | in progress |
| 3 | Milestone E presets 1-10, 11-20, 21-30 (verified and committed per batch) | `p2/presets-*` | planned |
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

## Next

- Wave 2: the ten engines on `p2/engines-*`, registered through `SPAWN_ENGINE_FACTORIES` in src/main.js and tested with preset-like objects through `ctx.systems.spawns.debug` (see docs/architecture.md, "Spawns").

## Open issues

- **Pacing needs dense common content.** With the lab's stub presets 1.1-1.6 % of droughts run past 90 s (night, inland). The real presets need at least one "anywhere, anytime" common event dense enough (for example cellSize 3500, chance 0.6).
- **Storm clouds.** The v1 cloud field stays sun-lit white in a storm (clouds.js normalises the sun colour); storm cloud masses are for the weatherVolume engine. A very faint sun disc (about 1 %) can show under storm overcast.
- **Stamped presets change the terrain digests.** tools/lab/terrain.mjs guards Phase 1 bit-identity only while `PRESETS` places no stamps; when the first stamped preset lands, retarget that test or record new digests deliberately.
- **First query of a stamped cell** resolves placement once (3-10 ms on the loaded machine), in the worker for chunks and on the main thread for the first collision query there.
- **Real lights cost shading while they exist.** The light pool holds only the lights engines declare (`budget.lights`, capped at 4). Meshes on shared materials must be pooled (`createMeshPool` / `createInstancedPool`), or three r184 keeps each disposed mesh alive (about 8 KB each).
- **Occlusion rays allocate a little** (worldgen noise, 0.02-0.03 B/frame after warm-up); the spawn code itself measures about 0.02 B/frame.
- **Audio recipes are verified by measurement only**, not by listening; a listening pass by Kyle is worthwhile. Inverse-law recipes stay above the audibility floor to about 60 km (presets cull at lod.far). V8 boxes doubles passed to AudioParams (about 40-60 KB/s with 10 voices), which code cannot avoid.
- **The audio lab's trigger-dynamics check is randomised.** The thunder strike uses `Math.random`, so "thunder trigger stands out" (> 6 dB) measured 5.7 dB once on WebGPU during integration and 7.7-9.5 dB in the three runs after it. Seeding the recipe randomness for offline renders would make it deterministic.
- **Lure silhouettes** are tuned on the test presets; the real heavy presets should check theirs against horizon screenshots.
- **performance.memory** heap figures exist only in Chrome and are coarse.
- **Golden-frame comparisons across runs** are not pixel-exact (vegetation sway, birds, cloud drift); the exact proof is the same-frame A/B in tools/steps/golden-frame.json.
- **Full harness matrix.** Only reduced flight harnesses were run in wave 1; the full 36-run matrix is for Milestone G.
- **One soft crash in the integration harness.** WebGPU run 3 (INTEG-A, jet, third person) had a "noseTip strike" at 0.98 s and 227 m/s; the same run on WebGL2 had none. It is not a hard criterion (the soft crash is the designed outcome of a terrain strike), there are no presets yet, and the spawn code changes nothing in flight; worth watching in the Milestone G matrix.
