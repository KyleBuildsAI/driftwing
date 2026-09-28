DRIFTWING v2 - PHASE 2 of 4: EVENT DIRECTOR, SPAWN ENGINES, FIRST 30 ENVIRONMENT SPAWNS

LEAD'S NOTE (added on top of the owner's text; the owner's STRUCTURE CORRECTION, SPEC-structure-fix.md, is the source of truth for every phase): V2 has no CLASSIC mode. Read "CLASSIC and SIM" as V2 with full wind forces (the assists are the safety net). Read "both modes" as first person and third person views. Branch v2-phase2 is cut from tag v2-structure. Map key M: the mic toggle moves to Shift+M.

CONTEXT
Phase 1 is complete (tag v2-phase1). Before starting, read these files:
- docs/architecture.md
- docs/controls.md
- docs/copilot-api.md
- src/env/WindField.js

Phase 2 turns scenery into events. It adds:
- deterministic site placement with terrain stamps
- ten reusable spawn engines
- a pacing director
- a data-driven preset system
- the first 30 environment spawns
- the discovery loop (journal, copilot guide, world map, seed links)

Phase 3 will add 70 more presets and 8 craft on these same engines, so everything here must be generic and data-driven. Do not build Phase 3 or 4 content (Spotify, VR, replay, multiplayer).

GROUND RULES (unchanged from Phase 1)
- Follow the webgpu-build-standards skill: three@0.184.0, WebGPU-first, a WebGL2 fallback that still looks right, and the verify loop. Keep the Vite project.
- Zero console errors AND warnings. No placeholders. Commit per milestone on branch v2-phase2 (from v2-phase1). Tag v2-phase2 at the end.
- Every spawn appears in both CLASSIC and SIM.
  - SIM gets full wind forces.
  - CLASSIC gets scaled, capped forces so v1's never-tumble promise holds.
- Still no fail state. Anything that throws you into terrain ends in the Phase 1 soft crash.
- Anything WebGPU-only (TSL compute particles, storage buffers) needs a WebGL2 path that still looks good.

MILESTONE A - DETERMINISTIC PLACEMENT + TERRAIN STAMPS
There are two kinds of spawn:
1. SITES: persistent places (volcano, canyon, waterfall, wind farm, bridge, airfield, floating islands, crystal spires, geyser field, bioluminescent bay, maelstrom).
   - Placed on a 2 km grid by hash(seed, cellX, cellZ, presetId).
   - Filtered by the SAME biome function the terrain uses, with min-spacing rules per preset.
   - Same seed = same sites, every time.
2. EVENTS: temporary happenings (storms, flocks, celestial events, whales, sky whale).
   - Candidates are deterministic from hash(seed, cell, worldTimeBucket).
   - The director decides which dormant candidate to activate (Milestone C).

Placement code lives in ONE shared module imported by both the terrain worker and the main thread, so they agree on site locations without messaging.

Terrain stamps:
- Sites can modify terrain height deterministically:
  - volcano cone + crater
  - slot canyon carve
  - waterfall cliff step
  - gorge for the bridge
  - flattened airfield strip
  - island bases
- Stamps apply INSIDE the shared height function with smooth falloff. That way terrain meshes, every LOD ring, skirts/stitching, and Phase 1 ground collision all agree.
- Look stamps up through a spatial hash. Height sampling must stay within 10% of its Phase 1 cost.
- Stamp-aware vertex colors:
  - ash/basalt on volcanoes
  - wet dark rock at waterfalls
  - worn tarmac on the airfield

MILESTONE B - SPAWN ENGINE FRAMEWORK + DEV DEBUGGER
Engine interface:
  init(ctx)
  create(preset, params, rng) -> instance
  update(instance, dt, ctx)
  setLOD(instance, tier)
  dispose(instance)
  stats()

ctx provides:
- scene, camera, backend flag
- WindField, AudioEngine
- the shared height function
- time of day
- the event bus
- a perf governor

Engine rules:
- Pool everything. Zero per-frame allocations inside update. dispose() must return GPU memory (this is tested).
- LOD tiers: FAR, MID, NEAR.
- FAR = "lure" impostors. Heavy spawns (volcano plume, supercell anvil, tornado, sky whale, floating islands, comet) render a far silhouette that shows above the fog, beyond terrain view distance, so the player sees it on the horizon and flies toward it. This is the core of the discovery loop.

The ten engines:
1. VortexEngine
   - funnel mesh
   - debris particle ring
   - WindField vortex source (Rankine core, inflow, updraft)
   - Used by: tornado, waterspout, maelstrom.
2. EmitterEngine
   - GPU particle emitters: plumes, jets, sprays, sparks, rising lanterns
   - ballistic and wind-driven motion
   - can couple to lights
3. WeatherVolumeEngine
   - cloud masses (instanced soft puffs matching v1 clouds)
   - rain shafts, fog banks
   - local visibility reduction
   - rain streaks on the canopy in cockpit view
4. FaunaEngine
   - instanced boids with per-preset rules: flocking, formation, circling, breaching, fly-alongside
   - scatter near the player
   - wing flap animated in the vertex shader
5. StructureEngine
   - procedural low-poly builds from parametric recipes (turbines, bridges, runways, hangars, islands, spires)
   - registers terrain stamps
6. CelestialEngine
   - sky-dome additions: meteors, comet, eclipse moon disc + corona, glory/rainbow rings
   - drives v1 sky, fog, and sun light, so an eclipse actually darkens the world
7. WaterEffectEngine
   - local water deformation and shading: whirlpool, breach splashes, foam
   - bioluminescent trails when anything touches the water
8. LightEffectEngine
   - lightning flashes that light the scene and clouds
   - glows, fireflies, lantern light
   - strict budget of real lights; everything else is emissive + bloom
9. WindModifierEngine
   - WindField source authoring: updraft plume, downburst, wake turbulence, jet-stream tube, slipstream
   - turbulence drives camera shake and cockpit rattle audio
10. SetPieceEngine
   - scripted multi-stage timelines that orchestrate the other engines
   - stages, triggers, durations, copilot narration hooks

Spawn debugger (dev-only, key F9; hidden in build:single unless ?dev=1):
- list presets with filters
- force-spawn any preset ahead of the craft
- teleport to the nearest site of a type
- scrub time of day
- show director state: drought timer, budgets, heavy count, candidates
- show engine stats: instances, particles, lights, buffers
- toggle the WindField overlay

MILESTONE C - EVENT DIRECTOR
- Runs twice per second.
- Inputs: player position, heading, speed, biome, time of day, regional weather state, active spawns, perf headroom.
- Pacing: something notable (a new site in view, or an event) within 60-90s of flight.
  - On a drought, activate the best dormant deterministic candidate AHEAD of the player's heading, 3-8 km out. Never behind.
- Rarity weights:
  - common: every few minutes
  - uncommon: every 10-15 min
  - rare: every 30-60 min
  - legendary: every 1-2 hours of flight
  - Per-preset cooldowns. No same event type back-to-back.
- Budgets:
  - max 2 HEAVY spawns active
  - per-engine particle and instance caps
  - max real lights
  - If the perf governor reports missed frame targets, defer heavy activations BEFORE dynamic resolution drops.
- Filters per preset: biome, time of day, altitude band, weather state, over water vs over land, min distance from player.
- Lifetimes:
  - Events end naturally (tornado ropes out and lifts, storms dissipate).
  - Out-of-range, out-of-view spawns despawn with hysteresis.
- Regional weather state machine: clear -> building -> storm -> clearing.
  - Storm presets depend on it.
  - Sky and fog colors reflect it.
- API:
  - getNearby(radiusKm) -> [{ id, name, category, distance, bearing, state, etaSeconds }]
  - bus events: spawnActivated, spawnEnded, discovery

MILESTONE D - SPAWN AUDIO SUPPORT
Procedural recipes on the environment bus, spatialized and distance-attenuated:
- tornado: low roar + debris rattle
- thunder: crack + rolling rumble, delayed by distance / 343 m/s
- volcano: sub-bass rumble + eruption booms
- geysers: hiss bursts
- waterfall: pink-noise roar
- whales and sky whale: synthesized song
- crystal spires: harmonic hum + chimes
- wind turbines: rhythmic whoosh
- murmuration: wing rush
- meteors: faint sizzle
- lanterns: soft ambient pad
- discovery chime

MILESTONE E - THE 30 PRESETS (build in three batches of 10; verify + commit after each)
Each preset is a data file in src/spawns/presets/ containing:
- id, name, category
- engines + params
- kind (site/event), rarity, filters, heavy flag
- LOD distances
- wind sources
- audio recipe
- journal title + one-line description
- 3+ copilot callout lines
- lifetime/despawn rule
(* = affects flight via WindField)

WEATHER & SKY
1. Tornado* (heavy, rare)
   - Funnel descends from a wall cloud, debris ring, rope-out ending.
   - Inflow pull within 1.5 km, violent updraft core, heavy turbulence.
   - SIM can fling you. CLASSIC caps it to dramatic shake and pull.
2. Supercell* (heavy, uncommon)
   - Anvil visible 30+ km away, rain shaft, lightning with delayed thunder.
   - Gust front and downdrafts.
3. Waterspout* (uncommon, ocean)
   - Thinner vortex with a spray ring on the water. Milder than the tornado.
4. Lenticular clouds* (common, over peaks when windy)
   - Stacked lens clouds.
   - Smooth wave lift downwind, rotor turbulence beneath.
5. Microburst* (uncommon)
   - Rain shaft that slams down a downdraft with an outward gust.
   - Dust ring on the ground.
6. Glory + full-circle rainbow (common, day)
   - Appears when above the cloud layer with the sun behind you: a rainbow ring around your own shadow on the clouds.

VOLCANIC & GEO
7. Erupting volcano* (heavy site; active state is rare)
   - Cone + crater stamp.
   - Pulsing ash plume visible 40 km away, lava bombs.
   - Lava glow lights the plume at night.
   - Ash turbulence and low visibility inside the plume.
8. Geyser field* (site, common)
   - Seeded eruption schedule; each eruption is a brief strong updraft column with steam.
9. Slot canyon run (site)
   - Carved canyon 2-4 km long with twisting walls and a river floor.
   - Journal records best clean run time.
10. Mega-waterfall* (site)
   - Cliff-step stamp, massive fall.
   - Mist cloud with a daytime rainbow.
   - Downdraft curtain and roar.

OCEAN
11. Whale pod (event, common near coasts)
   - 3-6 whales surfacing and spouting, with occasional full breaches.
12. Maelstrom* (site, rare)
   - Spiraling whirlpool with foam arms and a vortex in the air above.
13. Bioluminescent bay (site, night only)
   - Glowing surf. Anything touching the water leaves blue trails: your craft, whales, spray.

WILDLIFE
14. Starling murmuration (event, dusk, meadows/farmland)
   - Thousands of birds morphing shape; they scatter and re-form as you fly through.
15. Geese V-formation (event, common)
   - Hold the slot position for 10s to earn an achievement.
   - The flock follows your gentle turns.
16. Thermal hawks* (common, day)
   - Hawks circling inside the Phase 1 thermals, the visual marker for lift.
17. Fireflies (night, meadows)
   - Thousands of drifting soft lights near the ground.
18. Eagle wingman (uncommon)
   - A large eagle joins off your wing for about 60s, matches speed within limits, and peels off with a call.

STRUCTURES
19. Wind farm* (site)
   - Turbines yaw into the ambient wind; blade speed follows wind speed.
   - Wake turbulence downwind.
20. Rope bridge (site)
   - Spans a gorge stamp. Flying under it logs a "Thread the Needle" achievement.
21. Abandoned airfield (site)
   - Flattened strip, faded markings, hangar ruins.
   - Windsock showing the real WindField wind.
   - Landings here are graded. Phase 1's "Start on ground" option prefers the nearest discovered airfield.

NIGHT & CELESTIAL
22. Meteor shower (event, night)
   - Streaks from a radiant point, occasional fireball with a brief flash.
23. Total solar eclipse (legendary, day)
   - Moon disc crosses the sun over about 90s.
   - Sky darkens, stars appear, corona, wildlife goes quiet.
   - Drives sun light, sky, and fog.
24. Comet (rare, lasts one full night)
   - Nucleus with a dust tail pointing away from the sun.
25. Sky lantern festival (rare, night, near settlements or the lighthouse)
   - Hundreds of lanterns rising and drifting on the WindField.

FANTASY
26. Floating islands (heavy site, rare)
   - Rock islands with trees; waterfalls pour off the edges into mist.
   - Landable tops.
27. Sky whale* (heavy event, rare)
   - Colossal whale drifting through the cloud layer with slow tail beats and song.
   - Its slipstream is a free speed and lift lane.
28. Crystal spires (site)
   - Glowing spires that hum; pitch rises as you approach.
   - Chimes when you fly between them.

FLIGHT-PLAY
29. Jet stream ribbon* (uncommon, high altitude)
   - Visible streak tube with a strong tailwind along it.

LEGENDARY SET PIECE
30. Storm chase (legendary; SetPiece combining 2 + 1)
   - Supercell builds over about 3 min and the wall cloud lowers while the copilot narrates.
   - Tornado touches down, tracks across terrain for about 4 min, then ropes out.
   - Journal "Storm Chaser" entry records your closest distance.

MILESTONE F - DISCOVERY LOOP: JOURNAL, COPILOT GUIDE, MAP, SEED LINKS
Discovery:
- Triggers when a spawn is inside its discovery radius and in view.
- Plays a chime and shows a glass toast with the name and one-liner.
- Journal entry records: name, category, seed, coordinates, time of day, first-seen date.
- Journal count covers implemented presets only (x / 30).

Journal stats to add:
- storms chased
- closest tornado distance
- best canyon run
- best landing (from Phase 1)
- achievements: V-formation, Thread the Needle, etc.

Copilot tour guide:
- New grammar with keyboard/UI equivalents:
  - "what's nearby"
  - "take me to the [name or category]"
  - "find a thermal"
  - "chase the storm"
  - "next discovery"
- Proactive callouts (setting, default on):
  - Example: "Supercell building 9 km northwest. Want a heading?" A "yes" places a waypoint.
  - Max one per 45s.
  - Never below 150 m AGL or during landing.
  - Never talks over itself.
- RemoteCopilot flightState adds:
  - nearby[] from director.getNearby()
  - activeEvents[]
- Update docs/copilot-api.md.

World map (key M, bindable action mapToggle):
- Tiles generated in a worker from the shared height + biome functions at low resolution, cached.
- Shows: discovered sites as category icons, player position/heading, this flight's trail, the current waypoint.
- Click to set a waypoint. Undiscovered sites never appear.

Seed links:
- URL hash #seed=XXXX with optional &t=timeOfDay.
- Glass "Copy link" button.
- Seed entry field in settings (applying it reloads into that world).
- The current seed persists in settings.

MILESTONE G - VERIFICATION
1. Verify loop on the dev server AND build:single:
   - 0 errors, 0 warnings
   - screenshots differ
   - golden-hour opening unchanged
2. ?test=spawns:
   - Scripted flight force-spawns each of the 30 presets ahead of the craft, on WebGPU and on forced WebGL2.
   - Screenshot each one.
   - Check: console clean, fps, and that dispose() returns heap/GPU memory to baseline within tolerance and removes its wind sources.
3. ?test=determinism:
   - Same seed + same scripted path, run twice.
   - Must produce an identical site-list hash and an identical event activation log.
4. ?test=terrain:
   - Near every stamp, at every LOD, compare chunk-edge vertex heights (no cracks).
   - Collision height vs rendered mesh height must match within 0.5 m.
5. Extend the Phase 1 ?test=1 harness into a 10-minute soak:
   - 5 seeds, director live, both modes.
   - Pass criteria:
     - 0 NaN
     - 0 terrain penetrations
     - heap growth under 75 MB
     - p99 frametime within target
     - no frame over 50 ms after warmup
6. Final report, then a short manual checklist for Kyle:
   - fly toward the first horizon lure
   - chase a storm
   - join the geese
   - land at the airfield
   - use the map and Copy link

DELIVERABLES
- Branch v2-phase2 with a commit per milestone, tag v2-phase2.
- docs/spawns.md covering:
  - every preset with its engines, filters, rarity, and wind effect
  - a copy-paste template for adding a new preset (Phase 3 depends on this)
- docs/architecture.md updated: placement, stamps, engines, director.
- docs/copilot-api.md and docs/controls.md updated.
- CHANGELOG.md entry.
