# Spawn presets

Phase 2 turns scenery into events. Every spawn in V2, from a geyser field to a total solar eclipse,
is a **preset**: a pure-data file in `src/spawns/presets/` that names the reusable engines that draw
it, the rules that decide where and when it appears, the wind it blows, the sound it makes and what
WREN and the journal say about it. Nothing about a single spawn is hard-coded anywhere else.

This page lists the 30 presets of Phase 2, read from the preset files themselves, and then shows
how to add a new one (Phase 3 adds 70 more on the same engines). The schema is enforced by
[src/spawns/schema.js](../src/spawns/schema.js); the systems that read it are described in
[architecture.md](architecture.md#spawns-ctxsystemsspawns-srcspawns); every engine param is in
[docs/engines/](#engine-reference-pages).

Units are SI: metres, m/s and seconds. Headings are compass degrees. Altitudes in filters are the
player's height above sea level; heights in engine params are metres above the spawn's anchor
unless a param says otherwise.

## How a preset becomes a spawn

There are two kinds of preset.

- **Sites** (`kind: 'site'`) are persistent places. `src/world/placement.js` rolls every site
  preset once per 2 km cell with hash(seed, cellX, cellZ, presetId) and keeps the candidates that
  pass the preset's `placement` rules (chance, biome, surface, terrain, spacing and clearance). The
  same seed always gives the same sites, in the terrain worker and on the main thread alike, and a
  site's `stamps` reshape the shared height function there. The SpawnManager creates a site's spawn
  when the camera comes within `lod.far` and removes it beyond `lod.far + despawn.hysteresis`. A
  site with an `activeState` (the volcano's eruption) starts dormant, and the director decides when
  it wakes.
- **Events** (`kind: 'event'`) are temporary happenings. `src/spawns/candidates.js` rolls
  deterministic candidates from hash(seed, cell, time bucket, presetId) using the preset's
  `candidates` block. The event director (`src/spawns/director.js`, 2 Hz) activates the best
  dormant candidate that passes the preset's `filters`, always ahead of the player and inside the
  preset's distance band, within the rarity periods, cooldowns and budgets. An event ends when its
  engine says it has (a tornado ropes out), at the end of its drawn `lifetime.duration`, or by the
  despawn rule once it is far away and out of view.

Every engine entry of a preset becomes one engine instance, created with the entry's params plus
the activation (`position`, `heading`, `site`, `startTime`, `scale`, `duration`, `seed`) and its own
seeded random generator. Heavy presets (`heavy: true`) count toward the limit of 2 heavy spawns at
once and draw a FAR **lure**, a silhouette on the horizon beyond the terrain's view distance, so the
player sees them from 30-60 km and flies toward them.

When a spawn comes within `discovery.radius` and into view, the SpawnManager emits the typed
`discovery` event: the chime plays, the glass discovery card shows the `journal` title and
description, and the journal records the find. WREN calls a spawn out with one of its `callouts`
lines as it activates (or as an undiscovered site comes into range) and offers a heading.

## The 30 presets at a glance

"Wind" says whether the preset changes the air the craft flies through. The details are in each
preset's section below.

| # | preset | id | category | kind | rarity | heavy | engines | wind |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | [Tornado](#1-tornado) | `tornado` | weather | event | rare | yes | `vortex`, `weatherVolume`, `lightEffect` | yes |
| 2 | [Supercell](#2-supercell) | `supercell` | weather | event | uncommon | yes | `weatherVolume`, `lightEffect`, `windModifier` | yes |
| 3 | [Waterspout](#3-waterspout) | `waterspout` | ocean | event | uncommon | no | `vortex`, `waterEffect`, `weatherVolume` | yes |
| 4 | [Lenticular clouds](#4-lenticular-clouds) | `lenticular` | weather | event | common | no | `weatherVolume`, `windModifier` | yes |
| 5 | [Microburst](#5-microburst) | `microburst` | weather | event | uncommon | no | `weatherVolume`, `windModifier`, `emitter` | yes |
| 6 | [Glory](#6-glory) | `glory` | weather | event | common | no | `celestial`, `weatherVolume` | slight |
| 7 | [Erupting volcano](#7-erupting-volcano) | `volcano` | geo | site | rare | yes | `emitter`, `lightEffect`, `windModifier` | yes |
| 8 | [Geyser field](#8-geyser-field) | `geyserField` | geo | site | common | no | `emitter` | yes |
| 9 | [Slot canyon](#9-slot-canyon) | `slotCanyon` | geo | site | uncommon | no | `structure` | no |
| 10 | [Mega-waterfall](#10-mega-waterfall) | `megaWaterfall` | geo | site | uncommon | no | `structure`, `emitter`, `celestial`, `waterEffect`, `windModifier` | yes |
| 11 | [Whale pod](#11-whale-pod) | `whalePod` | ocean | event | common | no | `fauna` | no |
| 12 | [Maelstrom](#12-maelstrom) | `maelstrom` | ocean | site | rare | no | `waterEffect`, `vortex` | yes |
| 13 | [Bioluminescent bay](#13-bioluminescent-bay) | `bioluminescentBay` | ocean | site | uncommon | no | `waterEffect`, `fauna` | no |
| 14 | [Starling murmuration](#14-starling-murmuration) | `starlingMurmuration` | wildlife | event | uncommon | no | `fauna` | no |
| 15 | [Geese V-formation](#15-geese-v-formation) | `geeseFormation` | wildlife | event | common | no | `fauna` | no |
| 16 | [Thermal hawks](#16-thermal-hawks) | `thermalHawks` | wildlife | event | common | no | `fauna` | thermals |
| 17 | [Fireflies](#17-fireflies) | `fireflies` | wildlife | event | common | no | `lightEffect` | no |
| 18 | [Eagle wingman](#18-eagle-wingman) | `eagleWingman` | wildlife | event | uncommon | no | `fauna` | no |
| 19 | [Wind farm](#19-wind-farm) | `windFarm` | structure | site | common | no | `structure` | yes |
| 20 | [Rope bridge](#20-rope-bridge) | `ropeBridge` | structure | site | uncommon | no | `structure` | no |
| 21 | [Abandoned airfield](#21-abandoned-airfield) | `abandonedAirfield` | structure | site | uncommon | no | `structure` | no |
| 22 | [Meteor shower](#22-meteor-shower) | `meteorShower` | celestial | event | common | no | `celestial` | no |
| 23 | [Total solar eclipse](#23-total-solar-eclipse) | `totalSolarEclipse` | celestial | event | legendary | no | `celestial` | no |
| 24 | [Comet](#24-comet) | `comet` | celestial | event | rare | yes | `celestial` | no |
| 25 | [Sky lantern festival](#25-sky-lantern-festival) | `skyLanternFestival` | celestial | event | rare | no | `emitter`, `lightEffect` | no |
| 26 | [Floating islands](#26-floating-islands) | `floatingIslands` | fantasy | site | rare | yes | `structure` | no |
| 27 | [Sky whale](#27-sky-whale) | `skyWhale` | fantasy | event | rare | yes | `fauna`, `windModifier` | yes |
| 28 | [Crystal spires](#28-crystal-spires) | `crystalSpires` | fantasy | site | uncommon | no | `structure`, `lightEffect` | no |
| 29 | [Jet stream ribbon](#29-jet-stream-ribbon) | `jetStream` | flightplay | event | uncommon | no | `emitter`, `windModifier` | yes |
| 30 | [Storm chase](#30-storm-chase) | `stormChase` | setpiece | event | legendary | no | `setPiece` | children |

In all: 11 sites and 19 events; 9 common, 12 uncommon, 7 rare and 2 legendary; 6 heavy. The
journal's collection count is found / 30 over these presets (`PRESETS` in
[src/spawns/presets/index.js](../src/spawns/presets/index.js)).

## Rarity, pacing and the budgets

- **Events and site active states** are scheduled by the director. Each rarity tier has a due time
  drawn from its period: common 150-300 s, uncommon 600-900 s, rare 1800-3600 s and legendary
  3600-7200 s of flight (`RARITY_PERIODS`). After an activation the preset waits out its cooldown:
  common 150 s, uncommon 1200 s, rare 2700 s and legendary 5400 s (`RARITY_COOLDOWNS`), or the
  preset's own `cooldown`. The same preset never runs twice in a row.
- **Pacing.** Something notable comes within 60-90 s of flight: when nothing has been seen for a
  seeded 60-70 s, the director activates the best eligible common candidate ahead, 3-8 km out (from
  75 s an uncommon one too, and from 80 s a rare one, up to 60 degrees off the heading). Dense,
  unfussy common presets keep this working everywhere: the geese (any biome, hour or weather), the
  meteor shower at night and the whale pod on coasts.
- **Sites without an active state** are always there; their `rarity` describes them (WREN's callout
  priority and the tour guide rank by it) and their `placement.chance` and `minSpacing` decide how
  often a world has one.
- **Budgets.** At most 2 heavy spawns at once (sites count only while their active state runs),
  at most 4 real lights, and per-engine instance and particle caps (each engine's `budget`, else
  `DIRECTOR_BUDGETS.engines`). Under frame-time pressure the director first defers heavy activations
  and then steps far spawns to cheaper LOD tiers, before the renderer drops resolution.
- **Declined activations.** When every engine of a director activation ends its instance at create
  (thermal hawks with no working thermal, a whale pod with no open water in reach), the SpawnManager
  refuses it with the reason `declined`. The director then counts no notable, cooldown or tier turn
  and tries the candidate again in its next bucket.

The full rules are in [architecture.md: Event director](architecture.md#event-director-srcspawnsdirectorjs).

## The presets

Each section gives what the player sees, then the preset's fields as the file sets them. The
time-of-day classes are `day` (sun up), `night` (sun more than 6 degrees down), `dawn` and `dusk`
(the low sun, -10 to 14 degrees), `golden` (-3 to 14 degrees) and `midday` (14 degrees up or more).
"Ahead" is the director's activation distance band in front of the player.

### Weather and sky

#### 1. Tornado

A funnel lowers out of a turning wall cloud under its parent storm, touches down and walks across
the land with a ring of debris, then ropes out and lifts.
[src/spawns/presets/tornado.js](../src/spawns/presets/tornado.js)

- **Kind:** event, rare, heavy. Funnel lure, 2400 m tall, with lightning flashes.
- **Engines:** `vortex` (the funnel, debris ring and Rankine wind on a seeded track at 9 m/s;
  forms over 30 s, ropes out over 45 s; owns the voice); `weatherVolume` (the parent storm tower
  with an anvil, a rotating wall cloud and a rain shaft, drifting with the funnel); `lightEffect`
  (lightning, 7 strikes a minute).
- **Filters:** meadows, dunes or pine; day, dawn or dusk; storm weather only; over land; player
  0-6000 m; 4-9 km ahead.
- **Candidates:** 9 km cells, 600 s buckets, chance 0.55.
- **Wind:** a Rankine vortex: 72 m/s tangential at the core, an inflow that pulls toward it within
  1.5 km (14 m/s), a 45 m/s updraft in the core, a sinking ring and turbulence 0.95 with 8 m/s gusts.
  It can fling a glider. The storm above adds turbulence 0.5, a 4 m/s updraft and a rain shaft
  (6 m/s downdraft, 9 m/s outflow).
- **Sound:** `tornado` (low roar and debris rattle).
- **LOD:** near 2000 m, mid 4500 m, far 45 km. **Discovery:** 5 km, in view.
- **Lifetime:** 240-360 s; despawned beyond 15 + 3 km after 30 s out of view.
- **Journal:** `closestTornado` (min, within 15 km) and `stormsChased` (+1 within 3 km).

#### 2. Supercell

A rotating thunderstorm whose anvil stands on the horizon 30+ km away, with a lowered wall cloud,
rain shafts, lightning and delayed thunder, a gust front ahead and a rear-flank downdraft.
[src/spawns/presets/supercell.js](../src/spawns/presets/supercell.js)

- **Kind:** event, uncommon, heavy. Anvil lure, 11 km tall and 17 km wide, flickering with
  lightning.
- **Engines:** `weatherVolume` (a 10.5 km tower with an anvil and an overshooting top, a wall cloud
  at the rear flank, two rain shafts, drifting at 9 m/s; forms over 45 s); `lightEffect`
  (lightning, 9 strikes a minute, thunder delayed by distance; owns the `thunder` voice);
  `windModifier` (the gust front and the rear-flank downdraft, drifting with the storm).
- **Filters:** any biome, any hour; building or storm weather; any surface; player 0-9000 m;
  8-22 km ahead.
- **Candidates:** 12 km cells, 450 s buckets, chance 0.5.
- **Wind:** a 6 m/s updraft under the base with turbulence 0.55; downdrafts of 7 and 4 m/s in the
  shafts with 11 and 6 m/s outflows; a gust front 2.8 km ahead (15 m/s outflow, 5 m/s lift along
  its edge); a rear-flank downburst (10 m/s down, 12 m/s out).
- **Sound:** `thunder` (crack and rolling rumble, delayed by distance / 343 m/s).
- **LOD:** near 6 km, mid 22 km, far 60 km. **Discovery:** 14 km, in view.
- **Lifetime:** 420-600 s; despawned beyond 30 + 5 km after 30 s out of view.
- **Journal:** `stormsChased` (+1 within 6 km).

#### 3. Waterspout

A thinner, milder vortex than the tornado, hanging from a dark cumulus over the sea, with a spray
ring churning the water at its foot and a foam wake behind it.
[src/spawns/presets/waterspout.js](../src/spawns/presets/waterspout.js)

- **Kind:** event, uncommon.
- **Engines:** `vortex` (the funnel over water, wandering at 5 m/s; owns the voice at 0.55
  intensity; its wake glows in a bioluminescent bay); `waterEffect` (the spray ring); `weatherVolume`
  (the parent cumulus with a light rain shaft).
- **Filters:** any biome; day, dawn or dusk; building or storm weather; over water; player
  0-4000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 450 s buckets, chance 0.45.
- **Wind:** a Rankine vortex: 38 m/s tangential, inflow within 550 m (7 m/s), a 20 m/s updraft,
  turbulence 0.75 with 5 m/s gusts. It lifts and spins a glider but rarely flings it.
- **Sound:** `tornado`.
- **LOD:** near 2000 m, mid 7000 m, far 22 km. **Discovery:** 3 km, in view.
- **Lifetime:** 180-300 s; despawned beyond 12 + 3 km after 20 s out of view.

#### 4. Lenticular clouds

A stack of smooth lens clouds parked over a peak in the prevailing wind, riding a standing wave.
[src/spawns/presets/lenticular.js](../src/spawns/presets/lenticular.js)

- **Kind:** event, common.
- **Anchor:** the activation moves to the highest ground within 2.5 km and turns downwind
  (`anchor: { seek: 'peak', radius: 2500, align: 'downwind' }`).
- **Engines:** `weatherVolume` (four stacked lens layers); `windModifier` (the lee wave train).
- **Filters:** snow, pine, meadows or dunes; any hour; clear, building or clearing weather; over
  land; player 0-8000 m; 3-9 km ahead.
- **Candidates:** 4.5 km cells, 480 s buckets, chance 0.5.
- **Wind:** a wave field 9 km wide with three crests 6.5 km apart: smooth lift (2.8 m/s) upwind of
  each crest and sink downwind, up to 5200 m; beneath the crests a rotor layer up to 900 m with
  turbulence 0.8 and 5 m/s of reversed flow. The lens clouds add their own gentle wave (3 m/s lift,
  2 m/s sink). A glider can climb kilometres in it.
- **Sound:** none.
- **LOD:** near 4 km, mid 14 km, far 40 km. **Discovery:** 9 km, in view.
- **Lifetime:** 600-900 s; despawned beyond 20 + 4 km after 30 s out of view.

#### 5. Microburst

A dark shower cloud lets go: its rain shaft slams a downdraft into the ground, which bursts outward
as a ring gust throwing a ring of dust across the land.
[src/spawns/presets/microburst.js](../src/spawns/presets/microburst.js)

- **Kind:** event, uncommon.
- **Engines:** `weatherVolume` (the shower cloud and its dense shaft; rain on the canopy; owns the
  voice); `windModifier` (the downburst and a sinking curtain, both starting 12 s in);
  `emitter` (the expanding dust ring on the ground).
- **Filters:** meadows, dunes, pine or snow; day, dawn or dusk; building or storm weather; over
  land; player 0-5000 m; 3-8 km ahead.
- **Candidates:** 8 km cells, 450 s buckets, chance 0.4.
- **Wind:** a downburst with a 520 m core: 18 m/s down and 18 m/s outward, its ring expanding at
  16 m/s to 3.2 km, with 4 m/s of lift at the front and turbulence 0.85; plus a curtain of 6 m/s
  sinking air. Flying through it is the windshear trap: a headwind, a violent sink, a tailwind.
- **Sound:** `waterfall` (the rain's roar, reference distance 260 m).
- **LOD:** near 2500 m, mid 9000 m, far 22 km. **Discovery:** 4 km, in view.
- **Lifetime:** 150-240 s; despawned beyond 12 + 3 km after 20 s out of view.

#### 6. Glory

Above a sea of cloud with the sun behind you, your own shadow falls on the cloud tops ringed by
the glory's coloured rings, inside a full-circle rainbow.
[src/spawns/presets/glory.js](../src/spawns/presets/glory.js)

- **Kind:** event, common.
- **Engines:** `celestial` (the glory and the 42-degree bow on every cloud, sky-anchored at the
  antisolar point, so it follows the player; sun 4-62 degrees up); `weatherVolume` (a cloud sheet
  at 700 m above sea level, 7 km across, under the flight path).
- **Filters:** meadows, pine, dunes or archipelago; day; clear, building or clearing weather; any
  surface; player 1150-6000 m; 1.5-6 km ahead.
- **Candidates:** 5 km cells, 600 s buckets, chance 0.45.
- **Wind:** only the cloud sheet's light turbulence (0.08).
- **Sound:** none.
- **LOD:** near 2500 m, mid 9000 m, far 30 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** 300-480 s; despawned beyond 12 + 3 km after 30 s out of view.

### Volcanic and geo

#### 7. Erupting volcano

An ash cone with a crater, usually quiet. When it erupts, the plume pulses kilometres high and
stands on the horizon 40 km away, lava bombs arc out and boom, the lava glow lights the plume at
night, and lightning flickers in the ash.
[src/spawns/presets/volcano.js](../src/spawns/presets/volcano.js)

- **Kind:** site, rare, heavy. Plume lure, 6 km tall with a lava glow, shown only while it erupts.
- **Active state:** the eruption lasts 240-420 s (`activeState`). The director starts it as a rare
  candidate at a placed volcano (600 s buckets, chance 0.5); dormant, the site shows a faint plume
  and a glowing lava lake.
- **Placement:** snow, pine, dunes or meadows; land; ground 30-600 m; chance 0.05 per cell; at
  least 40 km between volcanoes; 800 m clearance; scale 0.95-1.15.
- **Stamp:** `cone`, radius 1100-1400 m, 380-520 m high, a crater 170-230 m wide and 80-120 m deep,
  7-10 gullies, painted `ash`.
- **Filters (the eruption):** any biome, hour and weather; over land; player 0-9000 m; 3-30 km
  ahead.
- **Engines:** `emitter` (the ash plume, pulsing every 14 s, with an underglow, a real light and an
  immersion fog inside the column); `emitter` (lava bombs in bursts, each burst a `boom`);
  `lightEffect` (the lava lake and spatter glows, and lightning in the ash); `windModifier` (the
  preset's `wind` entry).
- **Wind:** while it erupts, an updraft column of 300 m radius rising at 10 m/s to 4500 m, with a
  sinking ring, a 2 m/s swirl and turbulence 0.75. Inside the plume the fog thickens and the world
  darkens.
- **Sound:** `volcano` (sub-bass rumble and eruption booms).
- **LOD:** near 1500 m, mid 4000 m, far 45 km. **Discovery:** 8 km, in view.
- **Lifetime:** a site; removed beyond 45 + 5 km.

#### 8. Geyser field

A flat, steaming basin where three geysers erupt on seeded, out-of-step schedules; each eruption
is a brief strong updraft column.
[src/spawns/presets/geyserField.js](../src/spawns/presets/geyserField.js)

- **Kind:** site, common.
- **Placement:** snow, pine, meadows or dunes; land; ground 20-900 m, flat relief; chance 0.14;
  at least 14 km apart; 400 m clearance. No stamp.
- **Engines:** three `emitter` geysers (steam jets every 25-75 s, each with its own updraft that
  follows the eruption, and a `burst` hiss) and one `emitter` for the basin's low steam.
- **Wind:** each eruption lifts an updraft column: 17.5, 14 and 12.6 m/s, with radii of 60, 48 and
  43 m, 400, 320 and 288 m tall, turbulence 0.65. It kicks a glider upward.
- **Sound:** `geyser` (hiss bursts).
- **LOD:** near 1500 m, mid 5000 m, far 9000 m. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 9 + 3 km.

#### 9. Slot canyon

A twisting canyon 2.4-3.6 km long with a river on its floor; cairns mark the ends, and the journal
keeps your best clean run.
[src/spawns/presets/slotCanyon.js](../src/spawns/presets/slotCanyon.js)

- **Kind:** site, uncommon.
- **Placement:** dunes, pine or meadows; land; ground from 60 m; chance 0.14; at least 16 km apart;
  400 m clearance; aligned downhill.
- **Stamp:** `carve`, 2400-3600 m long, 38-54 m wide, 80-110 m deep, twisting 200-340 m, painted
  `riverbed`.
- **Engines:** `structure` (recipe `gates`: entry and exit cairns, a timed course with a corridor
  below the rim, the river; owns the river's voice).
- **Wind:** none.
- **Sound:** `waterfall` (the river, reference distance 60 m).
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 3 km.
- **Journal:** `bestCanyonRun` (min, seconds, clean runs only: no soft crash and never above the
  rim). Either end may be the start.

#### 10. Mega-waterfall

A river spills over a 110-160 m cliff as a wide curtain into a churning plunge pool, with a mist
cloud, a daytime rainbow, a roar that carries for kilometres and sinking air at the curtain.
[src/spawns/presets/megaWaterfall.js](../src/spawns/presets/megaWaterfall.js)

- **Kind:** site, uncommon.
- **Placement:** pine, snow, meadows or archipelago; land; ground from 60 m; chance 0.035; at least
  16 km apart; 400 m clearance; aligned downhill.
- **Stamp:** `cliffStep`, 380-520 m wide, a 110-160 m drop, a pool of 55-75 m, painted `wetRock`.
- **Engines:** `structure` (recipe `waterfall`: the falling strands; owns the voice);
  `emitter` (the mist cloud at the foot); `celestial` (the rainbow in the mist); `waterEffect`
  (the plunge pool's churn); `windModifier` (the curtain).
- **Wind:** a curtain of sinking air at the cliff: 9 m/s down, 7 m/s outward over the pool, to
  180 m high and reaching 450 m out, turbulence 0.6.
- **Sound:** `waterfall` (pink-noise roar).
- **LOD:** near 1800 m, mid 6000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.

### Ocean

#### 11. Whale pod

Three to six whales cruise at the surface, spouting and diving fluke-up, now and then breaching in
full.
[src/spawns/presets/whalePod.js](../src/spawns/presets/whalePod.js)

- **Kind:** event, common.
- **Engines:** `fauna` (species `whale`, behaviour `pod`: 3-6 whales, breach chance 0.35, spouts
  every 3.5-6.5 s; a coastal candidate moves its pod to open water within 3 km, and a director activation
  that finds none is declined and retried later; their wakes and splashes glow in a bioluminescent
  bay).
- **Filters:** any biome and hour and weather; on a coast; player 0-2500 m; 3-8 km ahead.
- **Candidates:** 5 km cells, 300 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `whale` (synthesized song, calls every 14-32 s).
- **LOD:** near 2000 m, mid 4500 m, far 9000 m. **Discovery:** 1.6 km, in view.
- **Lifetime:** 240-420 s, fading out over the last 10 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.

#### 12. Maelstrom

A whirlpool sinks a spinning funnel into the sea, with foam arms and mist over its eye, under a
wide pale air vortex rising to a lowered collar of cloud.
[src/spawns/presets/maelstrom.js](../src/spawns/presets/maelstrom.js)

- **Kind:** site, rare (not heavy: at the far tier the pale column still stands on the horizon).
- **Placement:** any biome; deep water (at most -25 m); chance 0.035; at least 30 km apart;
  1500 m clearance.
- **Engines:** `waterEffect` (the whirlpool, 320 m across, five foam arms); `vortex` (the air
  column, starting mature, turning counter-clockwise; owns the voice at 0.6 intensity).
- **Wind:** a Rankine vortex: 24 m/s tangential around a 110 m core, an inflow within 2.2 km
  (8 m/s) that pulls you in at low level, a 14 m/s updraft over the eye and turbulence 0.7.
- **Sound:** `tornado` (a deep roar, reference distance 260 m).
- **LOD:** near 2500 m, mid 5000 m, far 14 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 14 + 3 km.

#### 13. Bioluminescent bay

A night bay where the surf glows blue and anything touching the water leaves a trail of light:
your craft, the whales feeding there and the jumping fish.
[src/spawns/presets/bioluminescentBay.js](../src/spawns/presets/bioluminescentBay.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago; coast; chance 0.14; at least 12 km apart; 800 m clearance.
- **Site hours:** `filters.timeOfDay: ['night']`. The site exists only at night: the SpawnManager
  creates it after dusk and removes it (reason `hours`) once dawn comes and it has been out of view
  for 10 s, so it is only discovered at night.
- **Engines:** `waterEffect` (the bioluminescent glow region, 1100 m, with the surf hiss voice);
  `waterEffect` (fish splashes, kept to the water); `fauna` (one or two whales feeding in the bay,
  their wakes glowing).
- **Wind:** none.
- **Sound:** `waterfall` at a low flow (the surf, reference distance 200 m, reverb 0.5).
- **LOD:** near 2000 m, mid 4000 m, far 9000 m. **Discovery:** 2 km, in view.
- **Lifetime:** a site in its hours; removed beyond 9 + 2 km.

### Wildlife

#### 14. Starling murmuration

Three thousand-odd starlings fold through a morphing shape at dusk; fly through and they burst
away from your path, then re-form behind you.
[src/spawns/presets/starlingMurmuration.js](../src/spawns/presets/starlingMurmuration.js)

- **Kind:** event, uncommon.
- **Engines:** `fauna` (species `starling`, behaviour `murmuration`: 2800-3600 birds 150 m above the
  ground, scattering within 85 m of the craft and recovering in 4.5 s).
- **Filters:** meadows; dusk; clear, building or clearing weather; over land; player 0-2500 m;
  3-7 km ahead.
- **Candidates:** 5 km cells, 240 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `murmuration` (wing rush, swelling as you close in; a `scatter` burst).
- **LOD:** near 2500 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** 140-220 s, fading out over the last 12 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.

#### 15. Geese V-formation

A V of nine to thirteen geese crosses the sky at about your height. Slide into the open slot at the
end of the line and the flock follows your gentle turns.
[src/spawns/presets/geeseFormation.js](../src/spawns/presets/geeseFormation.js)

- **Kind:** event, common: the director's pacing floor (dense candidates no biome, surface, hour
  or weather rules out).
- **Engines:** `fauna` (species `goose`, behaviour `formation`: altitude mode `player`, 15 m below
  you, speed 18 m/s; the slot sits 26 m behind the shorter leg, within 16 m, 10 m of height and 30
  degrees of heading).
- **Filters:** any biome, hour, weather, surface and altitude; 3-7.5 km ahead.
- **Candidates:** 3.5 km cells, 300 s buckets, chance 0.6.
- **Wind:** none.
- **Sound:** `goose` (honking in bouts).
- **LOD:** near 1500 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 300-420 s, fading out over the last 10 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.
- **Achievement:** `vFormation`, "V-Formation": hold the slot for 10 s.

#### 16. Thermal hawks

Three to six hawks circle inside the Phase 1 thermals, the visual marker for lift.
[src/spawns/presets/thermalHawks.js](../src/spawns/presets/thermalHawks.js)

- **Kind:** event, common.
- **Engines:** `fauna` (species `hawk`, behaviour `circling` in a WindField thermal within 2.6 km,
  climbing 1.4 m/s from 120 m to 1100 m; `requireThermal`: a group that finds no working thermal
  ends before it is drawn, and a director activation that ends this way is declined, so it counts
  as nothing notable and the candidate is retried later).
- **Filters:** meadows, dunes or pine; midday (the thermal hours); clear, building or clearing
  weather; over land; player 0-3000 m; 3-7.5 km ahead.
- **Candidates:** 4.5 km cells, 300 s buckets, chance 0.5.
- **Wind:** none of its own (`wind: []`). The hawks mark a real Phase 1 thermal: circle where they
  circle and the WindField's thermal carries you up with them.
- **Sound:** `raptor` (a hawk's scream every 18-45 s).
- **LOD:** near 1500 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 300-480 s, fading out over the last 10 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.

#### 17. Fireflies

Thousands of soft yellow-green lights drifting and blinking a few metres over a night meadow.
[src/spawns/presets/fireflies.js](../src/spawns/presets/fireflies.js)

- **Kind:** event, common.
- **Engines:** `lightEffect` (a swarm of 3600 blinking points within 190 m, partly in step, and a
  wider, higher scatter of 700 slower ones; all emissive points in the shared glow pool, no real
  light; hidden by day).
- **Filters:** meadows or archipelago; night; clear, building or clearing weather; over land;
  player 0-1500 m; 3-7 km ahead.
- **Candidates:** 4 km cells, 300 s buckets, chance 0.55.
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 1200 m, mid 3000 m, far 6000 m. **Discovery:** 1 km, in view.
- **Lifetime:** 240-400 s, ramping out over the last 8 s; despawned beyond 8 + 2 km after 20 s out of
  view.

#### 18. Eagle wingman

A large eagle circling at about your height joins you off the wing for about 60 s, matching your
speed within its own, then peels off with a scream.
[src/spawns/presets/eagleWingman.js](../src/spawns/presets/eagleWingman.js)

- **Kind:** event, uncommon.
- **Engines:** `fauna` (species `eagle`, behaviour `wingman`: it joins within 2.2 km, escorts for
  60 s 18 m off the wing, gives up if you outrun it by 450 m for 7 s, and peels away for 18 s).
- **Filters:** snow, pine, meadows or dunes; day; clear, building or clearing weather; over land;
  player 0-3000 m; 3-7 km ahead.
- **Candidates:** 6 km cells, 450 s buckets, chance 0.45.
- **Wind:** none.
- **Sound:** `raptor`, pitched down to 0.8 for an eagle (a scream as it joins and as it leaves).
- **LOD:** near 1500 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 300-420 s, fading out over the last 8 s if you never come; despawned beyond
  9 + 2.5 km after 20 s out of view.

### Structures

#### 19. Wind farm

One or two staggered rows of three-bladed turbines across the prevailing wind. Each nacelle yaws
into the real WindField wind, its rotor speed follows the wind speed, and the air behind it is
rough.
[src/spawns/presets/windFarm.js](../src/spawns/presets/windFarm.js)

- **Kind:** site, common.
- **Placement:** meadows or dunes; land; ground 15-700 m; chance 0.06; at least 14 km apart; 800 m
  clearance.
- **Engines:** `structure` (recipe `windFarm`: 6-10 turbines in 2 rows, hubs 74-88 m high, rotors
  36-42 m; cut-in 3 m/s, rated 11 m/s, feathered past 25 m/s).
- **Wind:** a wake behind every rotor (a WindField source of kind `structure-wake`): 40 % slower air
  and turbulence 0.75 with 4 m/s gusts in a cone widening downwind for ten rotor diameters. It
  shakes the craft and the camera.
- **Sound:** `turbine` (a rhythmic whoosh that follows the wind speed).
- **LOD:** near 2500 m, mid 7000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.

#### 20. Rope bridge

A timber-plank rope bridge, a few planks missing, swaying across a gorge. Fly under it.
[src/spawns/presets/ropeBridge.js](../src/spawns/presets/ropeBridge.js)

- **Kind:** site, uncommon.
- **Placement:** pine, meadows or snow; land; ground from 90 m; chance 0.14; at least 12 km apart;
  600 m clearance.
- **Stamp:** `gorge` with a riverbed floor and two level anchor pads (`structureStamps('ropeBridge')`).
- **Engines:** `structure` (recipe `ropeBridge`: deck 2.4 m wide, 7 % sag, 6 % planks missing; a
  pass-under gate from below the gorge floor to 2 m under the deck).
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 1200 m, mid 4000 m, far 10 km. **Discovery:** 1.5 km, in view.
- **Lifetime:** a site; removed beyond 10 + 2 km.
- **Achievement:** `threadTheNeedle`, "Thread the Needle": fly under the bridge.

#### 21. Abandoned airfield

A flattened strip with faded markings, hangar ruins, a hut, broken edge lights and a windsock that
shows the real WindField wind. Landings on the runway are graded.
[src/spawns/presets/abandonedAirfield.js](../src/spawns/presets/abandonedAirfield.js)

- **Kind:** site, uncommon.
- **Placement:** meadows, dunes or pine; land; ground 6-420 m, flat relief; chance 0.35; at least
  12 km apart; 500 m clearance.
- **Stamp:** `flatten` for a runway 1100-1400 m long and 42-52 m wide, painted `tarmac`
  (`structureStamps('airfield', ...)`).
- **Engines:** `structure` (recipe `airfield`: three hangar ruins, the hut, the windsock, edge
  lights and a fence; graded landings through `structure:landing`; ground-start spots).
- **Start on ground:** Phase 1's "Start on ground" prefers the nearest discovered airfield within
  80 km, at the runway threshold most nearly into the wind (`spawns.findGroundStart`).
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 1800 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.

### Night and celestial

#### 22. Meteor shower

Streaks fan out from a radiant among the stars, with an occasional fireball that flashes the sky
and the land.
[src/spawns/presets/meteorShower.js](../src/spawns/presets/meteorShower.js)

- **Kind:** event, common (the night's pacing floor).
- **Engines:** `celestial` (meteors, 40 a minute, fireball chance 0.07; sky-anchored, so the spawn
  rides 1500 m from the camera toward the radiant; ends at dawn when the sun passes -8 degrees).
- **Filters:** any biome; night; clear or clearing weather; any surface and altitude; 3-8 km ahead.
- **Candidates:** 3.5 km cells, 300 s buckets, chance 0.6.
- **Wind:** none.
- **Sound:** `meteor` (a faint sizzle per `streak`, a `fireball` boom).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, not needing a view (it is
  discovered as it starts overhead).
- **Lifetime:** 180-300 s; despawned beyond 20 + 3 km after 30 s out of view.

#### 23. Total solar eclipse

The moon's disc crosses the sun over about 90 s. Through totality the sky darkens, the stars come
out around the corona and every bird falls silent.
[src/spawns/presets/totalSolarEclipse.js](../src/spawns/presets/totalSolarEclipse.js)

- **Kind:** event, legendary.
- **Engines:** `celestial` (the eclipse: a 92 s crossing with 16 s of totality, the corona,
  chromosphere and Baily's beads; a priority-30 sky modifier dims the sun light, darkens and tints
  the sky and fog and dims the clouds; `quietWildlife` sends the typed `wildlifeQuiet`, so the v1
  birds settle, the bird cues stop and the fauna fall silent).
- **Filters:** any biome; day; clear, clearing or building weather; any surface and altitude;
  3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.35.
- **Wind:** none.
- **Sound:** none of its own; the world goes quiet.
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, not needing a view (the darkening
  world announces it).
- **Lifetime:** 150-170 s; despawned beyond 20 + 3 km after 30 s out of view.

#### 24. Comet

A nucleus and coma with a curved dust tail pointing away from the sun and a straight blue ion tail,
fixed among the stars for the rest of the night.
[src/spawns/presets/comet.js](../src/spawns/presets/comet.js)

- **Kind:** event, rare, heavy. Comet lure (6 km up), which only draws if the spawn reaches the FAR
  tier; as a sky-anchored spawn it stays near, and the comet itself is visible above the fog from
  anywhere.
- **Engines:** `celestial` (the comet, sky-anchored; `untilDawn`: it ends as the morning sun climbs
  past -6 degrees).
- **Filters:** any biome; dusk or night; clear, clearing or building weather; any surface and
  altitude; 3-8 km ahead.
- **Candidates:** 7 km cells, 1200 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** until dawn; 900-1200 s caps it when the clock is frozen at night.

#### 25. Sky lantern festival

Hundreds of paper lanterns rise from a lighthouse or a balloon fair and drift away on the real
wind, with the launch crowd's lights on the ground.
[src/spawns/presets/skyLanternFestival.js](../src/spawns/presets/skyLanternFestival.js)

- **Kind:** event, rare.
- **Near a landmark:** `filters.near: { landmarks: ['lighthouse', 'balloons'], radius: 4000 }`: the
  director moves each candidate onto the nearest lighthouse or balloon fair within 4 km, or rejects
  it.
- **Engines:** `emitter` (up to 640 lanterns aloft, launched over one seeded 300-360 s stretch, following the
  WindField wind through the emitter's wind grid, so they follow the breeze and other spawns' air;
  owns the voice); `lightEffect` (the crowd's lights and a warm real light at the launch).
- **Filters:** any biome; dusk or night; clear or clearing weather; any surface and altitude;
  3-8 km ahead.
- **Candidates:** 6 km cells, 900 s buckets, chance 0.5.
- **Wind:** none (the lanterns ride the wind; they do not change it).
- **Sound:** `lantern` (a soft ambient pad).
- **LOD:** near 3 km, mid 9 km, far 22 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** 570-600 s, so the last lanterns live out their 110-150 s; despawned beyond
  14 + 3 km after 25 s out of view.

### Fantasy

#### 26. Floating islands

Rock islands with trees and a meadow hang in the air over sea-stack islets; waterfalls pour off
their edges into mist, and every top is landable.
[src/spawns/presets/floatingIslands.js](../src/spawns/presets/floatingIslands.js)

- **Kind:** site, rare, heavy. Islands lure, 760 m tall and 1500 m wide, 220 m up. A site counts
  toward the heavy limit only while an active state runs, and this one has none.
- **Placement:** archipelago, meadows or pine; water; chance 0.3; at least 22 km apart; 600 m
  clearance.
- **Stamps:** two `islandBase` islets 560 m apart (`structureStamps('islands', ...)`).
- **Engines:** `structure` (recipe `islands`: 4-5 islands of 70-150 m radius, 240-420 m up, 1-2
  waterfalls each, trailing roots and mist; the tops register as landable ground surfaces; owns
  the voice).
- **Wind:** none. Craft land and park on the tops (`ctx.groundSurfaces`).
- **Sound:** `waterfall`.
- **LOD:** near 2500 m, mid 9000 m, far 40 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** a site; removed beyond 40 + 3 km.

#### 27. Sky whale

A colossal whale, sometimes with a calf, drifts through the top of the cloud layer with slow tail
beats and song. Its slipstream is a free speed and lift lane.
[src/spawns/presets/skyWhale.js](../src/spawns/presets/skyWhale.js)

- **Kind:** event, rare, heavy. Whale lure, swimming on the horizon with a tail beat.
- **Engines:** `fauna` (species `skyWhale`, behaviour `drift`: 1-2 whales 230 m long at 680 m above
  sea level, 11 m/s, bobbing; luminous spots at night; owns the voice); `windModifier` (the
  preset's `wind` entry, following the fauna part and facing its travel).
- **Filters:** any biome and hour; clear, building or clearing weather; any surface; player
  120-6000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 1200 s buckets, chance 0.4.
- **Wind:** a slipstream lane starting 90 m behind the whale, 1900 m long, 190 m wide and 95 m
  high: a 12 m/s tailwind and 3.6 m/s of lift, turbulence 0.3, fading in and out with the whale.
- **Sound:** `skyWhale` (song, calls every 22-45 s).
- **LOD:** near 3 km, mid 7 km, far 40 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** 480-720 s, fading out over the last 12 s; despawned beyond 14 + 3 km after 25 s out
  of view.

#### 28. Crystal spires

A cluster of glowing crystal spires that hum louder and higher as you close in, and chime when you
fly between two of them.
[src/spawns/presets/crystalSpires.js](../src/spawns/presets/crystalSpires.js)

- **Kind:** site, uncommon.
- **Placement:** snow, dunes, meadows or pine; land; ground from 4 m; chance 0.14; at least 16 km
  apart; 400 m clearance. No stamp.
- **Engines:** `structure` (recipe `spires`: 7-11 spires 50-125 m tall, shards, fly-through chime
  gates between neighbours within 85 m; the hum's intensity is the approach within 1.8 km; owns the
  voice); `lightEffect` (motes of light drifting among the spires, brightest at night).
- **Wind:** none.
- **Sound:** `crystal` (a harmonic hum that rises with the approach, and `chime`).
- **LOD:** near 1800 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.

### Flight-play

#### 29. Jet stream ribbon

A straight 24 km tube of fast air high above the land, drawn out in racing cirrus streaks; ride its
core for a roaring tailwind.
[src/spawns/presets/jetStream.js](../src/spawns/presets/jetStream.js)

- **Kind:** event, uncommon.
- **Engines:** `emitter` (up to 20 000 stretched cirrus wisps in a box laid along the tube, formed for one
  seeded 380-440 s stretch); `windModifier` (the preset's `wind` entry).
- **Filters:** any biome and hour; clear, building or clearing weather; any surface; player
  1200-9000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.45.
- **Wind:** a jet-stream tube along the activation heading, 2200 m above the ground, 450 m in
  radius and 24 km long: a 38 m/s tailwind in its core with shear turbulence 0.4 and 4 m/s gusts at
  its edge. It stops at 410 s and fades over 25 s with the wisps.
- **Sound:** none.
- **LOD:** near 15 km, mid 30 km, far 50 km. **Discovery:** 9 km, in view.
- **Lifetime:** 540-600 s; despawned beyond 20 + 4 km after 25 s out of view.

### Legendary set piece

#### 30. Storm chase

A supercell builds over about three minutes while its wall cloud lowers and WREN narrates; a
tornado touches down under the rear flank, tracks across the land for about four minutes, ropes out,
and the storm decays.
[src/spawns/presets/stormChase.js](../src/spawns/presets/stormChase.js)

- **Kind:** event, legendary. Not heavy itself: its children are the ordinary `supercell` and
  `tornado` presets, started through the SpawnManager with their own budgets, lures and wind.
- **Engines:** `setPiece` (children `supercell`, growing over 170 s with a ramped wall cloud, and
  `tornado`, 800 m behind the storm's centre, its own storm tower shrunk to a dark turning lowering
  on the funnel: the child's `weatherVolume` override has base 1150 m, height 600 m, radius 900 m,
  36 puffs, no anvil, overshoot or rain, and a 520 m wall cloud dropping 300 m; stages build
  170-190 s, wallCloud 24-30 s, touchdown 235-250 s, ropeOut 20 s, clearing 60 s; narration lines
  at each stage through WREN). The children's own approach journals are silenced, so a chase counts
  once, and the supercell is the only storm tower.
- **Filters:** any biome; day or dusk; building or storm weather; over land; any altitude;
  7-12 km ahead.
- **Candidates:** 9 km cells, 900 s buckets, chance 0.4.
- **Wind:** through its children: the supercell's gust front, downdrafts and updraft, then the
  tornado's Rankine vortex.
- **Sound:** through its children.
- **LOD:** near 8 km, mid 25 km, far 60 km. **Discovery:** 15 km, in view.
- **Lifetime:** 570-600 s; despawned beyond 30 + 5 km after 60 s out of view.
- **Journal:** the "Storm Chaser" entry; `closestTornado` (min, the closest pass to the funnel) and
  `stormsChased` (+1 when you came within 5 km of the funnel).

## Adding a preset

Phase 3 adds 70 presets on these same engines. A new preset needs no engine or system code unless
it needs an engine feature that does not exist yet.

### Checklist

1. **Copy a template** below into `src/spawns/presets/<id>.js`. The file name is the id. Start the
   file with a comment in the style of the existing presets: the preset number, the kind and
   rarity, an asterisk-style "affects flight" note when it has wind, what the player sees, hears and
   feels, and the `docs/engines/` pages it uses.
2. **Register it**: import it in [src/spawns/presets/index.js](../src/spawns/presets/index.js) and
   append it to `PRESETS` under the comment for its batch. The journal's collection count, the
   F9 debugger's preset list, WREN's tour guide and the map pick it up from there.
3. **Choose the engines** and their params from the [engine reference pages](#engine-reference-pages).
   Each engine entry is one part of the spawn; two entries of the same engine are two parts (the
   volcano's ash plume and lava bombs).
4. **Wind.** A `wind` entry blows only when an engine authors it: a `rankine` entry is read by the
   preset's `vortex` part; every other type (`updraft`, `downburst`, `wake`, `jetStream`,
   `slipstream`, `waveLift`, `gustFront`, `curtain`) needs a `windModifier` part, which reads every
   entry of its types when its own params give no `sources` or `type`
   (`{ engine: 'windModifier', params: { endWithDuration: false } }` for a site or for an event whose
   other part decides the ending). Other engines author their own wind from their params (a
   weather volume's `wind`, an emitter's `windSource`, the wind farm's wake, a fauna `drift`
   slipstream).
5. **Sound.** `audio.recipe` must be one of the recipes in
   [src/audio/recipes/index.js](../src/audio/recipes/index.js): `tornado`, `thunder`, `volcano`,
   `geyser`, `waterfall`, `whale`, `skyWhale`, `crystal`, `turbine`, `murmuration`, `meteor`,
   `lantern`, `discovery`, `raptor` or `goose`. A preset has one voice. Without a flag the first
   engine entry opens it; each engine has its own flag: `voice` (vortex, structure, fauna,
   waterEffect), `sound` (emitter, lightEffect) or `ownsAudio` (weatherVolume, celestial). On a
   multi-engine preset set the flags explicitly: `true` on the part that should own the voice and
   `false` on the others that could (two emitter entries first in a preset would both claim it).
6. **Copilot words.** Give at least three `callouts` lines; WREN fills `{distance}` ("9.0 km"),
   `{direction}` ("north-west"), `{name}` and `{eta}` ("about 4 minutes away") and adds "Want a
   heading?" when the line does not ask already. If players will call it by another word, add a
   synonym to `NAME_SYNONYMS` in [src/copilot/tourGuide.js](../src/copilot/tourGuide.js) (as
   "twister" maps to the tornado).
7. **Validate.** Start the dev server (`npm run dev`) and open `/v2/`: dev builds validate every
   preset at startup and throw an error naming the preset and the field. Headless:

   ```bash
   node --input-type=module -e "import { PRESETS } from './src/spawns/presets/index.js'; import { validatePresets } from './src/spawns/schema.js'; import { ENGINE_NAMES } from './src/spawns/engineRegistry.js'; validatePresets(PRESETS, { engineNames: ENGINE_NAMES }); process.stdout.write('presets valid\n');"
   ```

   Engines check their own params when the spawn is created and refuse unknown or out-of-range
   params with `[DRIFTWING] <engine> preset "<id>": param "<path>" ...`, so force-spawn it once.
8. **See it.** Press **F9** in a dev build (or a build opened with `?dev=1`), find the preset,
   choose a distance and press **Spawn**; for a site, **Nearest** teleports to the nearest placed
   one. The F9 panel also scrubs the time of day and shows the engine stats. From a script:
   `window.DRIFTWING.ctx.systems.spawns.forceSpawn('<id>', { distance: 3000 })`.
9. **Test it** on both backends (`?renderer=webgl`): screenshots at its time of day, console clean,
   discovery with the card and a journal entry, and dispose back to the GPU memory and wind-source
   baseline. The preset step files (`tools/steps/presets-*.json`) show how; a dev check that
   measures baselines must hold the game's own presets first
   (`spawns.debug.holdGamePresets()` / `releaseGamePresets()`) or count only its own spawns. A site
   with stamps also needs `node tools/lab/terrain.mjs` and
   `node tools/run-harness.mjs --test terrain --presets real`. Wind presets belong in
   `node tools/lab/preset-wind.mjs` or `tools/lab/preset-flight.mjs`, and pacing in
   `node tools/lab/director.mjs --presets real`.
10. **Document it**: add its row and section to this page and a line to the CHANGELOG.

### Template: an event

Copy this file whole. Every field is listed, required ones first; the comments say what each does.
It is a complete, valid preset: a small dust whirl over open land, with a ring of dust on the
ground and a swirling updraft.

```js
// Preset NN: New event (common event; affects flight). What the player sees, hears and feels, in
// two or three sentences. Docs: docs/engines/emitter.md, windModifier.md.
export default Object.freeze({
  // Identity. id: camelCase, unique, the same as the file name. category: weather | geo | ocean |
  // wildlife | structure | celestial | fantasy | flightplay | setpiece (the map icon and the tour
  // guide's category words follow it).
  id: 'newEvent',
  name: 'New event',
  category: 'weather',
  kind: 'event',
  // common | uncommon | rare | legendary: the director's tier (its period and default cooldown).
  rarity: 'common',
  // true: counts toward the limit of 2 heavy spawns and needs a `lure`. Keep false unless the spawn
  // is big enough to be seen from 30 km.
  heavy: false,
  // Events only: deterministic candidates. cellSize (m): one roll per cell and bucket; bucketSeconds:
  // how long a candidate stays put; chance: the probability per cell and bucket (0 < chance <= 1).
  candidates: { cellSize: 5000, bucketSeconds: 450, chance: 0.4 },
  // When and where the director may activate it. null = any. biomes: snow | pine | dunes |
  // archipelago | meadows (the biome under the candidate). timeOfDay: dawn | day | golden | dusk |
  // night | midday. altitude: the PLAYER's height above sea level (m). weather: clear | building |
  // storm | clearing (at the candidate). surface: land | water | coast | any. minDistance /
  // maxDistance: the band ahead of the player (m; default 3000-8000). Optional near:
  // { landmarks: [arch | monoliths | lighthouse | balloons], radius <= 20000 } moves the candidate
  // onto the nearest such Phase 1 landmark, or rejects it.
  filters: {
    biomes: ['meadows', 'dunes'],
    timeOfDay: ['day'],
    altitude: { min: 0, max: 4000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  },
  // One entry per part: { engine: <registry name>, params: { ... } }. Engines: vortex, emitter,
  // weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece
  // (params: docs/engines/<engine>.md). Strict engines refuse unknown params by name.
  engines: [
    {
      engine: 'emitter',
      params: {
        particles: 4000, shape: { type: 'ring', radius: 60, innerRadius: 30 }, hugGround: true, radial: 6,
        speed: [2, 5], spread: 25, gravity: 0, buoyancy: 1.5, buoyancyDecay: 15, drag: 0.3,
        turbulence: { spread: 3, wobble: 4, frequency: 0.2 }, life: [6, 10], size: [6, 30],
        colors: [0xbca47e, 0xa48c6a, 0x8f7c64], opacity: 0.45, sound: true,
      },
    },
    // Authors this preset's `wind` entries below (a windModifier part with no sources of its own).
    { engine: 'windModifier', params: {} },
  ],
  // Metres from the camera: NEAR below near, MID below mid, FAR below far; beyond far * 1.08 an event
  // ends with reason 'range'. near < mid < far.
  lod: { near: 1500, mid: 5000, far: 12000 },
  // Heavy presets only (null otherwise): the FAR silhouette. type: plume | anvil | funnel | whale |
  // islands | comet; height and width (m); color 0xRRGGBB; optional altitude (m), glow (0xRRGGBB or
  // null) and flash (0..4, lightning flicker).
  lure: null,
  // WindField sources: [] if none. 'rankine' is read by a vortex part; updraft, downburst, wake,
  // jetStream, slipstream, waveLift, gustFront and curtain by a windModifier part
  // (docs/engines/windModifier.md lists every param). An updraft's speed is `updraft`.
  wind: [{ type: 'updraft', params: { radius: 80, updraft: 6, base: 0, top: 700, sinkRing: 0.2, swirl: 4, turbulence: 0.5, gust: 3 } }],
  // The spawn voice (null if silent): a recipe from src/audio/recipes/index.js. params may set
  // intensity and override refDistance, rolloffFactor, distanceModel, size and reverb.
  audio: { recipe: 'waterfall', params: { refDistance: 120 } },
  // The discovery card and the journal entry.
  journal: { title: 'New event', description: 'One sentence the journal keeps, written for the player.' },
  // Discovered within radius (m) and, with requireInView, only when in view and not hidden by terrain.
  discovery: { radius: 2000, requireInView: true },
  // At least 3 lines. Tokens: {distance} {direction} {name} {eta}.
  callouts: [
    'Something new {distance} {direction}.',
    'Look {direction}: a {name}, {distance} out.',
    '{name} about {eta} away, {direction}.',
  ],
  // duration: [min, max] seconds (events; null for sites). despawn: beyond distance + hysteresis (m)
  // and out of view for outOfViewSeconds, the director's event is removed.
  lifetime: { duration: [180, 300], despawn: { distance: 10000, hysteresis: 2500, outOfViewSeconds: 20 } },
  // Optional: achievements an engine may award (the typed `achievement` event; the journal keeps
  // each id once, in every world). [] or omit when there are none.
  achievements: [],
  // Optional: seconds before this preset may run again (default by rarity: 150, 1200, 2700, 5400).
  cooldown: 600,
  // Optional, events only: move the activation before the engines see it. seek 'peak' (with
  // radius <= 20000) takes the highest ground nearby; align 'downwind' faces the prevailing wind.
  anchor: { align: 'downwind' },
});
```

### Template: a site

A site is placed by the world, not activated by the director. Copy this file whole; the fields it
shares with the event template mean the same.

```js
// Preset NN: New site (uncommon site). What the player sees and hears, in two or three sentences.
// Docs: docs/engines/structure.md, lightEffect.md.
export default Object.freeze({
  id: 'newSite',
  name: 'New site',
  category: 'fantasy',
  kind: 'site',
  // For a site without an active state, rarity is descriptive (callout priority, the tour guide);
  // placement.chance and minSpacing decide how common it is.
  rarity: 'uncommon',
  // A heavy site gets a FAR lure; it counts toward the heavy limit only while an active state runs.
  heavy: false,
  // Sites only: rolled once per 2 km cell with hash(seed, cellX, cellZ, id). chance: per cell after
  // the filters. minSpacing (m): between two sites of this preset. biomes: the dominant biome from
  // the terrain's own biome function (null = any). surface: land | water | coast | any. Optional
  // terrain: { minHeight, maxHeight (m above sea level), relief: peak | valley | flat | ridge | any }.
  // clearance (m): from Phase 1 landmarks and other presets' stamps. Optional align: random |
  // downhill | ridge, and scale: [min, max].
  placement: {
    chance: 0.12,
    minSpacing: 16000,
    biomes: ['snow', 'pine', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 900, relief: 'any' },
    clearance: 400,
    align: 'random',
    scale: [0.9, 1.1],
  },
  // A site uses filters only for its active state (if it has one) and for its hours: with
  // timeOfDay set, the site exists only then (the night-only bioluminescent bay). null = always.
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  // Terrain stamps (sites only): cone | carve | cliffStep | gorge | flatten | islandBase, each with
  // sizes as numbers or [min, max] ranges and an optional paint: ash | basalt | wetRock | tarmac |
  // riverbed (the size table is at the top of src/world/stamps.js). The structure recipes that need
  // a stamp build theirs with structureStamps(recipe, options) from
  // '../engines/structure/stamps.js', which is safe in the terrain worker. [] for no stamp.
  stamps: [],
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'spires', count: [5, 8], height: [40, 90], radius: [4, 8], spread: 90, tilt: 12,
        colors: [0x8fe3ff, 0xb89cff], shards: [6, 10], chimes: true, maxGap: 70, approach: 1500,
        audioIntensity: 'approach', voice: true,
      },
    },
    {
      engine: 'lightEffect',
      params: {
        glows: [{ layout: 'scatter', count: 40, radius: 100, onGround: true, height: [4, 50], size: [1.6, 3], colors: [0x9fe8ff], intensity: 3, shape: 'orb' }],
        visibility: { day: 0.1, night: 1 },
        sound: false,
      },
    },
  ],
  // A site's spawn is created within lod.far and removed beyond lod.far + despawn.hysteresis.
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: { recipe: 'crystal', params: {} },
  journal: { title: 'New site', description: 'One sentence the journal keeps, written for the player.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: [
    'Something glittering {direction}, {distance} out.',
    'There is a {name} {direction}. Worth a look.',
    'The {name} is about {eta} away, {direction}.',
  ],
  // duration must be null for a site. Only despawn.hysteresis (range) and outOfViewSeconds (a site
  // outside its hours goes once out of view this long) apply to sites.
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 } },
  // Optional, sites only: a director-driven active state, such as an eruption: { duration:
  // [min, max] seconds }. The site starts dormant (instance.active false, lure hidden) and the
  // director starts the active state as a candidate of the preset's rarity (600 s buckets, chance
  // 0.5, under `filters`). Omit for a site that is always the same.
  // activeState: { duration: [240, 420] },
});
```

### Field reference

| field | kinds | required | what | read by |
| --- | --- | --- | --- | --- |
| `id` | both | yes | camelCase (`/^[a-z][A-Za-z0-9]*$/`), unique; the file name | everything |
| `name` | both | yes | the display name (callouts, the tour guide, the F9 list) | copilot, debugger |
| `category` | both | yes | `weather`, `geo`, `ocean`, `wildlife`, `structure`, `celestial`, `fantasy`, `flightplay`, `setpiece` | journal, map icons, tour guide |
| `kind` | both | yes | `site` or `event` | placement, director, SpawnManager |
| `rarity` | both | yes | `common`, `uncommon`, `rare`, `legendary` | director, callout priority |
| `heavy` | both | yes | counts toward the heavy limit (2) and needs a `lure` | SpawnManager, director |
| `placement` | site | yes for sites, absent for events | `chance` (0 < c <= 1), `minSpacing`, `biomes`, `surface`, `clearance`; optional `terrain`, `align`, `scale` | placement.js (both threads) |
| `candidates` | event | yes for events, absent for sites | `cellSize`, `bucketSeconds`, `chance` | candidates.js, director |
| `filters` | both | yes | `biomes`, `timeOfDay`, `altitude`, `weather`, `surface`, `minDistance`, `maxDistance`, `near` | director; site hours (`timeOfDay`) |
| `stamps` | site | optional (must be empty for events) | terrain stamp specs | placement.js, stamps.js, worldgen |
| `engines` | both | yes, at least one | `[{ engine, params }]`, one part each | SpawnManager, engines |
| `lod` | both | yes | `{ near, mid, far }` m, ascending | SpawnManager |
| `lure` | heavy | yes for heavy, null otherwise | `{ type, height, width, color, altitude?, glow?, flash? }` | lure.js |
| `wind` | both | yes (may be `[]`) | `[{ type, params }]` WindField sources | vortex, windModifier |
| `audio` | both | yes (may be `null`) | `{ recipe, params? }` | the voice-owning engine part |
| `journal` | both | yes | `{ title, description }` | discovery card, journal |
| `discovery` | both | yes | `{ radius, requireInView }` | SpawnManager |
| `callouts` | both | yes, at least 3 | lines with `{distance}`, `{direction}`, `{name}`, `{eta}` | tour guide |
| `lifetime` | both | yes | `{ duration: [min, max] \| null, despawn: { distance, hysteresis, outOfViewSeconds } }` | SpawnManager, director |
| `achievements` | both | optional | `[{ id, title, description }]` | engines, journal |
| `activeState` | site | optional | `{ duration: [min, max] }`: a dormant site the director wakes | director, SpawnManager |
| `cooldown` | both | optional | seconds before it may run again | director |
| `anchor` | event | optional | `{ seek: 'peak', radius, align: 'downwind' }` | SpawnManager |

Any other top-level field is refused as a typo. A preset must be frozen
(`export default Object.freeze({ ... })`) and pure data: it may import only other pure-data modules
(the existing presets import `structureStamps` from `src/spawns/engines/structure/stamps.js`), because
the terrain worker imports the preset list to place sites and apply stamps without messaging.

### Engine reference pages

| engine | page | draws or does | used by |
| --- | --- | --- | --- |
| `vortex` | [engines/vortex.md](engines/vortex.md) | funnels, debris and spray rings, the Rankine wind | tornado, waterspout, maelstrom |
| `emitter` | [engines/emitter.md](engines/emitter.md) | GPU particles: plumes, jets, sprays, sparks, dust, mist, lanterns; optional light, glow, wind source, immersion fog | microburst, volcano, geyser field, mega-waterfall, lantern festival, jet stream |
| `weatherVolume` | [engines/weatherVolume.md](engines/weatherVolume.md) | cloud masses, rain shafts, fog banks, the weather inside them | tornado, supercell, waterspout, lenticular, microburst, glory |
| `fauna` | [engines/fauna.md](engines/fauna.md) | instanced flocks, formations, circling birds, whale pods, wingmen, drifting giants | whale pod, bay, murmuration, geese, hawks, eagle, sky whale |
| `structure` | [engines/structure.md](engines/structure.md) | procedural builds: wind farms, bridges, airfields, islands, spires, gate courses, waterfalls; stamps, gates, landings | slot canyon, mega-waterfall, wind farm, rope bridge, airfield, floating islands, crystal spires |
| `celestial` | [engines/celestial.md](engines/celestial.md) | meteors, comets, the eclipse, the glory and rainbows | glory, mega-waterfall, meteor shower, eclipse, comet |
| `waterEffect` | [engines/waterEffect.md](engines/waterEffect.md) | whirlpools, splashes, spray, bioluminescence, plunge pools | waterspout, mega-waterfall, maelstrom, bay |
| `lightEffect` | [engines/lightEffect.md](engines/lightEffect.md) | lightning, glows, swarms, beams, the real-light budget | tornado, supercell, volcano, fireflies, lantern festival, crystal spires |
| `windModifier` | [engines/windModifier.md](engines/windModifier.md) | WindField sources with no visuals | supercell, lenticular, microburst, volcano, mega-waterfall, sky whale, jet stream |
| `setPiece` | [engines/setPiece.md](engines/setPiece.md) | multi-stage timelines over other presets | storm chase |

The engine API itself (the interface, the engine ctx, the budgets) is in
[architecture.md](architecture.md#spawns-ctxsystemsspawns-srcspawns) and the lead's contract
[specs/phase2-contract.md](specs/phase2-contract.md).

### Rules that catch authors out

- **Params arrive in three layers**: the entry's own params, then a set piece's overrides
  (`activate(..., { params: { [engine]: overrides } })`), then the activation fields (`position`,
  `heading`, `site`, `startTime`, `scale`, `duration`, `seed`). A child override can change a param
  but cannot drop an engine entry.
- **Strict engines** (vortex, windModifier, emitter, lightEffect, structure, setPiece) refuse any
  param they do not know, naming it. The others validate the params they read.
- **Wind param names**: an updraft source's speed is `updraft` (not `strength`) and a slipstream's
  lane start is `behind` (not `offset`); the emitter's own `windSource` block keeps `strength`.
- **One voice per preset** (step 5 of the checklist).
- **Sky-anchored spawns** (celestial `anchor: 'sky'`) ride 1500 m from the camera, so they stay at
  the NEAR tier, and a lure on them never draws; set `discovery.requireInView: false` when the
  whole sky announces the spawn (the meteor shower, the eclipse).
- **Event endings**: an event ends with its duration unless a part says otherwise. Give the
  windModifier part `endWithDuration: false` when another part fades out on its own, and make the
  duration long enough for the last particles to live out their life (the lantern festival).
- **Site hours**: `filters.timeOfDay` on a site makes it exist only in those hours.
- **Heavy is expensive**: two heavy spawns at once is the limit, and a heavy event waits while two
  are live.
