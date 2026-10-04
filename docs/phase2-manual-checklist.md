# Phase 2 manual checklist

What the automated tests cannot judge: how the new spawns sound, and whether they read well on
screen. Every item below says how to reach it. Tick it, or note what is wrong next to it.

## Setup

- Start the game with `npm run dev` and open <http://127.0.0.1:5199/?v=2>, or open a production
  build with `?dev=1` added. Both give the F9 spawn debugger.
- **F9** opens the debugger. Each preset row has **Spawn** (force-spawn ahead of the craft at the
  "Spawn ahead at" distance, past the budgets) and, for sites, **Nearest** (teleport to the nearest
  placed site). It also has a time-of-day scrubber and an End button for each live spawn.
- **T** / **Shift+T** step the time of day. `?time=0.6` starts in the afternoon and `?time=0.02` at
  night.
- To force the weather, open the console (F12; dev server or `?debug=1`) and run
  `DRIFTWING.ctx.systems.weather.forceState('storm')`. Run `forceState(null)` to hand it back.
- Add `&renderer=webgl` to any URL for the WebGL2 pass. Do each visual item once on each backend
  if there is time.

## 1. Listening pass on the spawn audio

These recipes were verified by measured levels only. Wear headphones and listen for anything
harsh, clipped, too quiet, too loud next to the wind, or badly placed left and right.

- [ ] Audition each recipe on its own in the console (dev server or `?debug=1`):
  `const a = DRIFTWING.ctx.systems.audio.debug.spawn; const id = a.play('tornado', { distance: 300 });`.
  Then `a.place(id, { distance: 3000, bearing: 90 })` moves it, `a.intensity(id, 0.5)` sets the
  level and `a.stopAll()` stops it. The recipes are `tornado`, `thunder`, `volcano`, `geyser`,
  `waterfall`, `whale`, `skyWhale`, `crystal`, `turbine`, `murmuration`, `meteor`, `lantern`,
  `discovery`, `raptor` and `goose`.
- [ ] `raptor` and `goose` are new in Phase 2. With the voice playing, trigger a call with
  `a.trigger(id, 'call')`. The hawk should sound like a hawk, the eagle
  (`a.play('raptor', { distance: 300, params: { pitch: 0.8 } })`) like an eagle, and the geese
  should honk in bouts.
- [ ] In flight, use F9 Spawn on each of these and fly past it: tornado (roar and debris rattle),
  supercell (thunder arrives distance / 343 m/s after the flash), volcano (rumble and booms; see
  below), geyserField, megaWaterfall, whalePod, skyWhale, crystalSpires (the
  fly-through chime), windFarm (turbines), starlingMurmuration, meteorShower (at night: a sizzle
  per streak, a boom on a fireball), skyLanternFestival, thermalHawks, eagleWingman,
  geeseFormation.
- [ ] Volcano eruption: F9 Nearest on volcano, then in the console run
  `const m = DRIFTWING.ctx.systems.spawns.manager; m.setSiteActive(m.getActive().find((r) => r.presetId === 'volcano').id, true);`.
  The eruption should rumble and boom, and its plume lure should appear from far away.
- [ ] Inside the cockpit view (V), fly close to a tornado. The turbulence rattle should be felt
  and not shrill.
- [ ] Discovery chime: fly into a new spawn's range with it in view. The chime should play once,
  with the glass card.

## 2. Presets that look faint or need framing judgment

- [ ] **Storm chase funnel.** At 2.6 km the funnel read only as a faint column in the storm haze.
  Is it a tornado from a sensible chase distance? (See section 3.)
- [ ] **Supercell rain shafts.** They are subtle at range. F9 Spawn supercell, then view it from
  5-10 km.
- [ ] **Glory** and **mega-waterfall rainbow.** These only show with the sun behind the viewer. For
  the glory, use F9 Spawn glory with the sun 4-62 degrees up (`?time=0.35`). It lays its own cloud
  sheet, so fly above it with the sun at your back. For the rainbow, use Nearest on megaWaterfall
  and approach with the sun behind you.
- [ ] **Horizon lures** (beyond the terrain's view distance, 30-60 km). F9 Spawn at the largest
  distance, or Nearest and then fly away. Does each silhouette read as what it is? Check the
  tornado funnel, the supercell anvil, the volcano plume (only while it erupts), the sky whale, the
  floating islands and the comet. The comet's lure does not draw (it is sky-anchored), which is a
  known issue.
- [ ] **Waterspout.** It is mild by design. Does it still look like a waterspout?
- [ ] **Lenticular clouds, jet stream ribbon, total solar eclipse.** The eclipse is legendary: use
  F9 Spawn totalSolarEclipse at midday (`?time=0.5`). The world should darken and the birds go
  quiet.
- [ ] **Bioluminescent bay** (night only) and **fireflies** (dusk and night): use F9 Nearest or
  Spawn at `?time=0.02`. Is the glow visible without looking like a bug?

## 3. Storm chase touchdown

- [ ] At `?time=0.6`, force the weather to storm (Setup), then F9 Spawn **stormChase** at a far
  distance (it activates 7-12 km ahead in play).
- [ ] The supercell should build over about 3 minutes and the wall cloud should lower, with WREN
  narrating each stage.
- [ ] Touchdown comes about 4 minutes in (stage times: build 170-190 s, wall cloud 24-30 s,
  touchdown 235-250 s). There should be one storm tower, with no second anvil at touchdown, and
  the funnel should be clearly visible under the rear flank.
- [ ] Fly within a few hundred metres. The wind should push hard (the assists are the safety net)
  and the sound should build.
- [ ] Afterwards, the journal (**J**) should count one storm chased and record the closest
  tornado distance.

## 4. The two views (first and third person)

- [ ] **V** swaps between the cockpit and the last outside view; **C** cycles chase, cockpit, wing
  and flyby. On each craft (**1-6**), the flight should feel the same in both views.
- [ ] In the cockpit view, spawns, lures and weather should still read: the instrument panel stays
  clear and the glass HUD stays off unless enabled in Settings.
- [ ] Geese V-formation in both views: F9 Spawn geeseFormation and fly into the slot at the end of
  the V. Hold it for 10 s. The V-Formation achievement should appear in the journal.

## 5. Map and journal

- [ ] **M** opens the world map. Discovered sites and landmarks show, undiscovered ones never do,
  and the flight trail and heading are drawn. Click to set a waypoint and drag to pan. Use the
  wheel or + / − to zoom, 0 to follow the craft, and M or Esc to close.
- [ ] **J** opens the journal: this world's discoveries (found / 30), the records (storms chased,
  closest tornado, best canyon run, best landing) and the achievements.
- [ ] Land at the abandoned airfield (F9 Nearest abandonedAirfield, then land on the strip). The
  graded landing should reach the journal's best landing.

## 6. Seed links

- [ ] **Copy link** (on the seed chip in the HUD, on the map, or in Settings > General > World)
  copies a link like `/?v=2#seed=ABC&t=0.723`. Open it in a new tab. It should launch V2 in the
  same world at the same time of day, inside the launcher.
- [ ] Settings > General > World > "Fly a specific seed": enter `TERRAIN-REAL-8` and press **Fly**.
  That world has every stamped site type within 40 km of the spawn. Reload: the game should
  remember the world.
- [ ] Open <http://127.0.0.1:5199/#seed=K7Q2ZD&t=0.300>. The launcher should pass both values on
  to V2.

## 7. A normal flight with nothing forced

- [ ] Fly 10 minutes on a fresh seed without F9. Something notable should come within the first
  60-90 s, ahead of you and never behind. A WREN callout should offer a heading ("Yes, heading"
  sets the waypoint). Fly toward the first horizon lure you see.
