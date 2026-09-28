DRIFTWING v2 - PHASE 3 of 4: 8 NEW CRAFT, 70 MORE SPAWNS, THE SYSTEMS THEY NEED

LEAD'S NOTE (added on top of the owner's text): the owner's STRUCTURE CORRECTION (SPEC-structure-fix.md) is the source of truth for every phase. Where this spec disagrees with it, the correction wins:
- V2 has no CLASSIC mode and no arcade model, so there are no arcadeProfile fields. Read "Every craft works in CLASSIC (arcade profile, v1 forgiving rules) and SIM" as: every craft works in V2's real flight model, with the assists slider as the forgiveness control.
- Read "both modes" as the first person and third person views.
- Read "v1 landmarks / v1 ring course / v1 balloons / v1 water shader" as the v1-derived features that live inside V2 (src/world/landmarks.js, src/gameplay/rings.js, src/render/water.js and so on). The frozen V1 at public/v1 is never touched.
- Branch v2-phase3 is cut from tag v2-phase2.

CONTEXT
Phases 1 and 2 are complete (tags v2-phase1, v2-phase2). Before starting, read:
- docs/architecture.md
- docs/spawns.md (includes the preset template)
- docs/controls.md
- docs/copilot-api.md
- the craft modules in src/craft/

Phase 3 completes the roster (14 craft) and the environment set (100 spawns). It adds only the systems those need. Do not build Phase 4 content: Spotify, VR, replay/ghosts, multiplayer.

RESUME PROTOCOL
This phase is large. Keep docs/phase3-progress.md updated at every commit: what's done, what's next, and any open issues. If this session ends early, a fresh session must be able to read that file and continue. At the start of any session, read it first if it exists.

GROUND RULES (unchanged)
- Follow the webgpu-build-standards skill (three@0.184.0, WebGPU-first with a good-looking WebGL2 fallback, verify loop).
- Keep the Vite project.
- 0 errors, 0 warnings, no placeholders.
- Branch v2-phase3 from v2-phase2. Commit per milestone/batch. Tag v2-phase3 at the end.
- Every craft works in CLASSIC (arcade profile, v1 forgiving rules) and SIM.
- Every spawn appears in both modes.
- Still no fail state.

MILESTONE A - FLOATING ORIGIN + STRUCTURE COLLISION
Floating origin:
- If not already present, add floating-origin rebasing.
- Keep simulation state in float64 (JS numbers).
- When the craft is more than 5 km from the render origin, rebase the render origin to the craft.
- Rebase must shift everything cleanly: terrain chunks, spawns, particles, wind debug overlay, camera, audio panners.
- Deterministic noise always samples true world coordinates.
- No visible pop on rebase.
- Required for the spaceplane and long flights.

Structure collision:
- Add a general collider system: box, cylinder, capsule, convex hull, and heightfield patch for landable tops.
- Use a mesh BVH (three-mesh-bvh) only where primitives can't fit.
- Single three.js core rule: if you add three-mesh-bvh, alias 'three' to 'three/webgpu' in the Vite config and confirm there is no duplicate-three warning.
- Colliders register with the spawn instance and dispose with it.
- Retrofit colliders onto:
  - v1 landmarks: arches, monoliths, lighthouse, balloons
  - Phase 2 structures: turbines, bridge, hangars, spires, floating islands
- Hitting any collider over craft limits triggers the Phase 1 soft crash. Never pass through.
- Perch/landing surfaces are tagged on colliders.

MILESTONE B - LOCAL WATER BODIES, REGION OVERLAYS, GROUND FAUNA, CHALLENGES
Local water bodies:
- Flat water surfaces at any elevation, clipped to a stamp basin.
- Share the v1 water shader: waves scaled down, sun glint, shoreline foam.
- Used by: crater lake, flamingo lake, salt flat, hot spring pools, oasis, dam reservoir, frozen lake (ice material variant).
- A shared water-height query covers ocean + lakes. Everything uses it: physics, seaplane, spray, bioluminescence, soft crash.

Region overlays:
- Deterministic, region-scoped overrides in the shared placement module, next to stamps, so the worker and main thread agree.
- Can override: vertex color palettes, vegetation species sets, surface materials (ice), animated tint sweeps.
- New instanced vegetation species: cherry trees, giant redwoods, bamboo, cacti, mangroves, lavender and tulip rows.
  - Wind sway in the vertex shader, driven by WindField.
  - Colliders on large trunks.

FaunaEngine additions:
- Ground mode: terrain-following herds that avoid slopes and water, with dust particles.
- Water-surface mode: dolphins, flamingos.
- A PathFollower utility for the train, the caravan, and the ghost galleon.

Challenge system:
- Start gate, checkpoint gates, finish.
- Timer with splits.
- Bronze/silver/gold thresholds.
- Best time per craft, saved locally.
- Missed-gate handling.
- Store the best run's path at 10 Hz so Phase 4 ghosts can use it.
- The v1 ring course migrates onto this system with identical behavior.

MILESTONE C - HIGH-ALTITUDE AND SPACE RENDERING (for the spaceplane)
- Air density drives the sky:
  - The sky gradient darkens toward black as density drops.
  - The sun disc sharpens.
  - Stars become visible above about 30 km, even in daylight.
  - A thin blue atmospheric limb glows at the horizon.
- Fog density scales with air density, so you can see extremely far from altitude.
- Curvature:
  - Above about 5 km, blend in vertex curvature (drop = d^2 / 2R) on terrain, water, and clouds.
  - Tunable planet radius, default 1000 km, for dramatic but bounded horizons.
- Far-field planet impostor:
  - Above about 12 km, terrain chunks hand off to low-res tiles on a curved disc out to the horizon.
  - Reuse the Phase 2 map-tile worker for these tiles.
  - Seamless blend at the handoff.
- Clouds and weather remain visible from above.
- Big spawns keep their FAR lure impostors.

MILESTONE D - CRAFT BATCH 1: AEROBATIC, SEAPLANE, TILTROTOR, PARAGLIDER
Each craft ships with:
- procedural low-poly mesh with animated moving parts
- simProfile and arcadeProfile
- HOTAS/keyboard/gamepad input profiles
- audio profile
- camera rig
- cockpit instruments
- copilot commands
- journal stats (flight time per craft)
Follow the existing craft module pattern.

7. AEROBATIC (Extra 330 style)
   - Roll rate about 400 deg/s. Symmetric airfoil: inverted flight performs like upright. +/-10G.
   - Big power-to-weight: torque roll and prop hang are possible.
   - Snap rolls: stalling one wing with rudder + elevator.
   - Knife-edge: fuselage side-force + rudder holds altitude at 90 deg bank.
   - Smoke system: toggle + color cycle. Ribbon trail mesh, sun-lit, fades over 30s.
   - Maneuver recognizer, scored for precision; each recognized figure gets a toast and a journal entry. Figures:
     - loop
     - aileron roll
     - barrel roll
     - Immelmann
     - split-S
     - Cuban eight
     - hammerhead
     - knife-edge pass
     - inverted pass
     - snap roll
     - tailslide
     - lomcevak (SIM only)
   - Audio: high-RPM prop snarl, smoke hiss.
8. SEAPLANE (amphibious bush floatplane)
   - Per-float buoyancy volumes sampled against the shared water height (ocean waves + lakes).
   - Displacement drag until a hump speed of about 45 km/h, then planing "on the step" with lower drag.
   - Porpoising if pitch attitude is wrong.
   - Water rudders on pedals at low speed. Spray particles.
   - Amphibian wheels in the floats (gear toggle):
     - Wheels down on water = nose-over soft crash, with a copilot callout beforehand.
     - Wheels up on land = skid; soft crash above 20 km/h.
   - Audio: radial engine rumble, water slap, spray.
9. TILTROTOR VTOL (Osprey style)
   - Nacelle angle 0-97 deg on the antenna axis, with detents at 0, 60, 90.
   - Hover: throttle = collective, stick = rotor cyclic + differential collective.
   - Airplane mode: conventional surfaces.
   - Wing lift builds with airspeed.
   - HUD conversion corridor showing safe nacelle angle vs airspeed.
     - Outside the corridor: wing stall or rotor overspeed warnings with real physical consequences, no damage.
   - Assist: auto-nacelle schedule.
   - Audio: proprotor thrum that changes character with nacelle angle.
10. PARAGLIDER
   - Two-body pendulum (canopy + pilot).
   - Glide about 9:1, trim about 38 km/h. Throttle axis = speed bar.
   - Toe brakes = left/right brakes: differential to steer, both to flare. Stick X = weight shift.
   - Button: big ears (descend).
   - Strong turbulence can cause asymmetric collapses. Assists prevent them or auto-recover.
   - Thermal circling with variometer audio. Relaunch from any slope.
   - Audio: canopy flutter, variometer.

MILESTONE E - CRAFT BATCH 2: BALLOON, AIRSHIP, EAGLE/DRAGON, SPACEPLANE
11. HOT AIR BALLOON
   - Lift = (rho_ambient - rho_hot) x envelope volume x g.
   - Envelope temperature state with a 20-30s thermal lag.
   - Throttle/burner button heats. A vent button dumps heat. Stick X = rotation vents (yaw).
   - Horizontal motion is essentially the WindField at your altitude.
   - HUD wind-layer column: sampled wind direction and speed per altitude band, so steering means choosing a layer.
   - Assist: altitude hold (auto-burner).
   - Basket landings bounce and drag.
   - Reuse the v1 balloon model family.
   - Audio: burner roar with flame light, basket creak, otherwise near silence.
12. AIRSHIP
   - Near-neutral buoyancy, with ballonet trim on the antenna axis.
   - Vectored props: rocker = vector angle. Low fin authority at low speed. Huge inertia and big wind drift.
   - Gondola cockpit view.
   - "Scenic cruise" autopilot: builds a waypoint chain through nearby sites via director.getNearby(). Photo-mode friendly.
   - Audio: low prop drone, envelope creak.
13. EAGLE / DRAGON (one craft, two skins chosen in the picker; separate meshes, same physics family)
   - Flapping flight: throttle axis = flap power, 0 = glide. Tuck wings to dive.
   - Soars thermals and ridge lift.
   - Perch: approach any tagged perch point slowly (peaks, structure tops, tree tops from vegetation instances). An auto-landing animation plays, then the idle camera orbits. Flap to take off.
   - craftAbility: eagle = screech; dragon = fire breath (harmless visual + light, lights lanterns and torches it touches).
   - Fauna flocks treat an eagle as a predator and scatter wider.
   - Audio: per-flap whoosh, screech; dragon wingbeats + roar + fire whoosh.
14. SUBORBITAL SPACEPLANE
   - Rocket thrust on the throttle; no fuel limit.
   - Thrust tuned so a full-power climb peaks around 100-120 km.
   - Aero authority scales with dynamic pressure. RCS blends in automatically as it drops, shown as visible thruster puffs; pedals = yaw RCS.
   - Mach, altitude, and apogee readouts.
   - Re-entry:
     - Heating proxy = rho x V^3.
     - Plasma glow shader, buffeting.
     - Short "comms blackout": the copilot goes silent, then checks in.
     - Then a hypersonic glide home.
   - Assists: attitude hold, auto re-entry at 40 deg AoA.
   - Audio: rocket roar that thins to near silence as air thins (structure-borne rumble only); re-entry roar returns with density.

Craft picker rework:
- 14 craft in groups:
  - Planes: glider, bush, aerobatic, seaplane, jet
  - Rotor: helicopter, tiltrotor, FPV drone
  - Human: wingsuit, paraglider
  - Lighter-than-air: balloon, airship
  - Creature: eagle/dragon
  - Space: spaceplane
- Number keys 1-0 map to 10 user-assignable favorites.
- HOTAS craftNext/craftPrev cycle favorites.
- Craft switching spawns each new craft in a sensible state for the situation. Examples:
  - seaplane over water = on the water or low approach
  - balloon = drifting
  - spaceplane = climbing

MILESTONE F - DIRECTOR UPDATES
- "Ahead" means along the ground-track velocity, not nose heading. This matters for the balloon, the airship, and anything drifting.
- Craft-aware weighting:
  - seaplane: favors water sites and lakes
  - eagle/dragon: favors thermals, perches, murmurations
  - spaceplane above 20 km: favors celestial events and heavy far-lure spawns
  - balloon: favors calm, slow spectacles along its drift line
- Combo scheduling: legendary presets declare preconditions and co-spawn requirements. The director arranges them deterministically.
- Global overrides with regional blending: blood moon, midnight sun.

MILESTONE G - SPAWN AUDIO + CHALLENGE UI
- Procedural audio recipes for every new preset: surf, bells/prayer flags, train whistle and chuff, caravan bells, herd rumble, dam roar, calving crack and splash, whale/dolphin calls, portal hum, wisps shimmer.
- Challenge UI in glass:
  - start prompt
  - gate arrows
  - split times
  - medal toast
  - best times in the journal

MILESTONES H-N - THE 70 PRESETS (7 batches of 10; verify + commit after each)
- Use the docs/spawns.md template.
- Reuse existing engines, recipes, and v1 models wherever the list says so.
- Every preset gets:
  - journal title + one-liner
  - 3+ copilot callouts
  - audio
  - LOD + FAR lure where heavy
  - colliders where solid
  - rarity, filters, lifetime
- Numbering continues from Phase 2's 30. (* = affects flight via WindField)

WEATHER & SKY
31. Sandstorm wall* (dunes): rolling orange wall, visibility drop, turbulence, grit streaks on canopy.
32. Snow squall* (snow biome): whiteout, heavy snow particles, gusts.
33. Hurricane eye* (heavy, rare, ocean): spiral rain bands, violent eyewall. Punch through to a calm eye with a stadium cloud wall and blue sky above.
34. Valley fog river (dawn): fog volume that flows along valley low points and pours over saddles.

VOLCANIC & GEO
35. Dirty thunderstorm (rare; volcano active + storm state): lightning inside the ash plume.
36. Lava rivers to the sea (volcano near coast): emissive flow channels in a stamp, steam explosions where they meet water.
37. Fissure eruption: line emitter along a crack stamp, a curtain of fire, glow on low clouds at night.
38. Meteor crater lake: crater stamp with a local lake.
39. Hot spring terraces: stepped stamp with turquoise steaming pools.
40. Salt flat mirror lake: thin water layer with a mirror reflection of the sky (planar or sky-reflection approximation, budgeted).

OCEAN
41. Calving glacier + iceberg field (snow meets ocean): ice-front calving event with splash and a spreading wave; drifting bergs with colliders.
42. Coral atoll: ring-island stamp, turquoise lagoon shading.
43. Reef shipwreck: wreck mesh on a shallow reef, visible through clear shallow-water shading.
44. Dolphin pod: races your shadow when you fly low over water.
45. Sea stacks and sea arches: stamps + collider arches you can fly through.
46. Rogue wave: traveling wave deformation with a spray crest across open ocean.
47. Tidal bore: estuary stamp carved below sea level; a bore wave surges inland up the channel.

WILDLIFE
48. Bats at dusk: stream pouring from a cave mouth on a mountain face.
49. Herd stampede: ground-mode herd with dust plume on plains.
50. Flamingo lake: local lake tinted pink by the flock; they take off in a wave if you buzz them.
51. Butterfly migration cloud: tiny fauna drifting with the WindField.
52. Caribou migration: long ground-mode column across tundra.

STRUCTURES
53. Cliffside monastery: prayer flags that flutter in the real WindField; bells.
54. Sea-cliff castle ruin: collider walls, a tower you can fly around.
55. Mountaintop observatory: dome opens at night; the telescope points at the comet or meteor radiant if one is active.
56. Steam train on a stone viaduct: PathFollower train, steam puffs, whistle; fly under the arches.
57. Dam with open spillway: reservoir lake behind, spray and rainbow below.
58. Desert oasis caravan: palm oasis with local water; PathFollower camel caravan.
59. Labyrinth: flattened stamp with instanced walls, readable only from above.

NIGHT & CELESTIAL
60. Fireball impact: bright fireball crosses the sky; impact flash, glowing scorched decal, and smoke on terrain (no height change).
61. Blood moon: lunar eclipse; the moon reddens and the night darkens.
62. Green flash: brief green rim on the sun at sunset when the ocean horizon is in view.
63. Noctilucent clouds: electric-blue high clouds glowing after dusk.
64. Milky Way core: procedural galactic band with dust lanes, strongest in desert biomes.
65. Moonbow: pale night rainbow at a waterfall site under a bright moon.

FANTASY
66. World tree: colossal tree taller than the mountains; collider trunk and branches, gaps to fly through the canopy, perch points.
67. Portal ring: fly through to fade into a new world.
   - New seed = hash(currentSeed, portalId).
   - Craft and state are kept. The URL hash updates.
   - Journal logs worlds visited.
68. Sleeping stone giant: mountain stamp shaped like a reclining giant with a face, readable from altitude.
69. Ghost galleon: translucent ship sailing the cloud tops at night on a PathFollower, with lantern glow.
70. Dragon racer: a dragon launches from a peak and races you through a gate route (Challenge system). If you are flying the dragon, it becomes a rival.
71. Reverse waterfall*: water flowing up off a cliff into the sky, with an updraft column.
72. Forest wisps (night, forests): lights that trail you, then drift toward the nearest undiscovered site as a guide.

FLIGHT-PLAY (Challenge system where noted)
73. Ridge lift band*: orographic cap clouds and soaring birds mark the lift along long ridgelines.
74. Wind shear line*: a sharp cloud edge where the wind abruptly changes direction and speed.
75. Thermal street*: cumulus rows aligned with the wind, chained thermals beneath.
76. Canyon gauntlet (Challenge): wide canyon with natural rock gates, splits, medals.
77. Cave tunnel (Challenge): a standalone rock-mountain mesh on a flattened stamp with a winding tunnel through it; mesh collision inside.
78. Waterfall wall* (Challenge): a long cliff of many thin falls with downdraft curtains; thread the gaps.
79. Balloon festival (Challenge): dozens of v1-style balloons as a weave course.
80. Kite-string slalom (Challenge): kites flying from a hilltop; strings are thin colliders. Touching one counts as a miss, not a crash.
81. Five-arch chain (Challenge): five v1-style stone arches in a line.

BIOME SET PIECES (region overlays)
82. Cherry blossom valley: pink canopy overlay, petal storms on gusts.
83. Autumn color wave: tint sweep spreading slowly across a forest region.
84. Lavender and tulip stripes: striped field overlays.
85. Rice terraces: stepped hillside stamp with reflective water-filled flats.
86. Redwood giants: instanced giant trunks with colliders for slalom.
87. Badlands hoodoos: instanced rock pillars with colliders.
88. Mangrove delta: roots, channels, morning mist.
89. Cactus forest with dust devils*: small vortices wandering between cacti.
90. Bamboo forest: dense sway that visibly ripples in gusts.
91. Frozen lake: ice-material local lake with crack patterns and pressure ridges.

LEGENDARY COMBOS (director combo scheduling)
92. Aurora + meteor shower on the same night over snow biomes.
93. Volcano + lightning + aurora together at a snow-biome edge.
94. Double rainbow over a whale pod.
95. Eclipse over the monolith circle (v1 landmark).
96. Comet breaking up over the ocean, fragments streaking.
97. Migration convergence: geese, butterflies, and a herd in one valley.
98. Midnight sun: in polar/snow regions, the sun skims the horizon without setting for one night cycle.
99. Crystal spires resonate during a thunderstorm, arcing light between spires.
100. Lighthouse beacons: the v1 lighthouse fires, and every lighthouse in view answers in a chain.

MILESTONE O - DISCOVERY, JOURNAL, COPILOT, CONTROLS
- Journal counts x / 100. Add:
  - flight time per craft
  - aerobatic figures flown
  - challenge medals
  - worlds visited (portals)
  - perches landed
  - max altitude (now up to space)
- New copilot grammar, each with keyboard/UI equivalents:
  - "switch to [craft]"
  - "smoke on/off"
  - "find water to land"
  - "find a perch"
  - "wind at [altitude]"
  - "start the challenge"
  - "take me to space"
  - "scenic cruise"
- RemoteCopilot flightState adds craft-specific fields:
  - nacelle angle
  - envelope temperature
  - apogee
  - onWater
  - perched
  - challenge state
- Update:
  - docs/copilot-api.md
  - docs/controls.md (a full HOTAS profile per new craft)
  - docs/spawns.md (all 100)
  - docs/architecture.md

MILESTONE P - VERIFICATION
1. Verify loop on the dev server and build:single:
   - 0 errors, 0 warnings
   - screenshots differ
   - golden-hour opening unchanged
2. ?test=spawns covers all 100 presets:
   - both backends
   - screenshot each
   - dispose returns memory and removes wind sources and colliders
3. ?test=craft runs a scripted suite for every one of the 14 craft in both modes. Beyond the general flight test, it must include:
   - recognizer detects a scripted loop and aileron roll
   - seaplane takeoff and landing on ocean AND on a lake
   - tiltrotor full conversion both ways
   - paraglider thermal climb
   - balloon reaches a target wind layer
   - airship scenic cruise visits 3 sites
   - eagle perch and takeoff
   - spaceplane climbs to 100 km and re-enters to 3 km
   Spaceplane pass criteria:
   - 0 NaN
   - floating-origin rebases occur without visible jumps (camera-relative position continuity)
   - far-field handoff with no holes
4. ?test=collision:
   - Fly at speed into every structure collider type: must soft crash, never pass through.
   - Tunnel centerline run completes.
   - Kite strings register misses.
5. ?test=determinism and ?test=terrain extended to all new stamps and region overlays.
6. Soak test: 20 minutes, 5 seeds, director live, craft switch every 2 minutes, both modes.
   Pass criteria (Phase 2):
   - 0 NaN
   - 0 terrain penetrations
   - heap growth under 75 MB
   - p99 frametime within target
   - no frame over 50 ms after warmup
7. Final report, plus a short manual checklist for Kyle:
   - one flight in each new craft
   - one challenge
   - one legendary combo forced from the F9 debugger
   - a climb to space

DELIVERABLES
- Branch v2-phase3 with a commit per milestone/batch, tag v2-phase3.
- docs/phase3-progress.md marked complete.
- All docs updated.
- CHANGELOG.md entry.
