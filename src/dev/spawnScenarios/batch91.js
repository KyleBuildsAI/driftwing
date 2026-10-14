// How ?test=spawns shows presets 91-100 (the frozen lake and the legendary combos), in spec order.
// Dev builds only; src/dev/spawnScenarios.js holds the field reference. Phase 3 fields used here:
//   combo     true: the preset is a combo, started with its members through the director's debug path
//             on the anchor's spot (they end together); stages can wait for the members
//   override  true: a global override, scheduled on the current night (the sky bends) while its own
//             preset is shown; the forced night is released after
//   sites     preset ids whose nearest REAL site is stood up before the baseline (the combo's place);
//             wake: true turns the first one's active state on (the erupting volcano)
//   siteOf    with anchor 'site': the preset whose real site the anchor is (the combo's place)
//   anchor 'landmark' with landmark: the nearest landmark of that type to the start
//   dayTime   the clock itself (0 = midnight), set after the sun elevation (the midnight sun)
//   view.direction  { azimuth, elevation } for the 'sky' and 'sun' views: a fixed part of the sky

export const BATCH91_SCENARIOS = Object.freeze([
  {
    id: 'frozenLake', why: 'a clear late afternoon, low sun across the ice and its ridges', sun: 14, weather: 'clear',
    anchor: 'site', distance: 1400, altitude: 220, runSeconds: 4,
    view: { distance: 380, height: 70, bearing: 200, lift: 0 },
  },
  {
    id: 'auroraMeteorShower', why: 'a clear night: the aurora at full, meteors through it', sun: -30, weather: 'clear',
    anchor: 'sky', distance: 0, altitude: 300, runSeconds: 6, combo: true, stage: 'comboMembers',
    view: { mode: 'sky', direction: { azimuth: 0, elevation: 28 }, fov: 80 },
  },
  {
    id: 'volcanoAurora', why: 'night at an erupting volcano: lightning in the ash under the aurora', sun: -28, weather: 'clear',
    anchor: 'site', siteOf: 'volcano', sites: ['volcano'], wake: true, distance: 7000, altitude: 900, runSeconds: 8, combo: true,
    view: { distance: 6500, height: 900, bearing: 200, lift: 1500, fov: 70 },
  },
  {
    id: 'doubleRainbowWhales', why: 'a low sun behind the craft, a shower at sea, the whale pod below', sun: 8, weather: 'clearing',
    anchor: 'coast', distance: 2200, altitude: 220, heading: 'downSun', runSeconds: 8, combo: true, stage: 'comboMembers',
    view: { mode: 'player', look: 'antisolar', distance: 60, height: 30, bearing: 180, fov: 85 },
  },
  {
    id: 'eclipseMonoliths', why: 'a clear morning at a stone circle, framed at totality', sun: 35, morning: true, weather: 'clear',
    anchor: 'landmark', landmark: 'monoliths', distance: 900, altitude: 160, runSeconds: 4, combo: true, stage: 'memberTotality',
    view: { distance: 170, height: 45, bearing: 200, lift: 8, fov: 70 },
  },
  {
    id: 'cometBreakup', why: 'a clear night over the open sea, the comet low ahead', sun: -30, weather: 'clear',
    anchor: 'water', distance: 800, altitude: 400, runSeconds: 4, combo: true, stage: 'breakup',
    view: { mode: 'sky', fov: 75 },
  },
  {
    id: 'migrationConvergence', why: 'a clear afternoon over a meadow valley', sun: 22, weather: 'clear',
    anchor: 'land', distance: 1800, altitude: 260, runSeconds: 8, combo: true, stage: 'comboMembers',
    view: { distance: 900, height: 160, bearing: 200, lift: 40, fov: 70 },
  },
  {
    id: 'midnightSun', why: 'midnight over the snow: the sun skims the northern horizon', sun: -20, dayTime: 0, weather: 'clear',
    anchor: 'sky', distance: 0, altitude: 500, runSeconds: 4, override: true, stage: 'override',
    view: { mode: 'sun', fov: 75 },
  },
  {
    id: 'resonatingSpires', why: 'a storm over the crystal spires at dusk, arcs between the tips', sun: -5, weather: 'storm',
    anchor: 'site', siteOf: 'crystalSpires', sites: ['crystalSpires'], distance: 1400, altitude: 200, runSeconds: 6, combo: true, stage: 'arcs',
    view: { distance: 420, height: 80, bearing: 200, lift: 50 },
  },
  {
    id: 'lighthouseBeacons', why: 'night on the coast: the first lighthouse fires and the others answer', sun: -18, weather: 'clear',
    anchor: 'landmark', landmark: 'lighthouse', distance: 2600, altitude: 320, runSeconds: 4, combo: true, stage: 'chain',
    view: { distance: 2600, height: 420, bearing: 200, lift: 40, fov: 75 },
  },
]);
