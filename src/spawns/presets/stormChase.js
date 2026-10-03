// Preset 30: Storm chase (legendary set piece combining presets 2 and 1). A supercell builds over about
// three minutes while its wall cloud lowers and the copilot narrates; a tornado touches down under the
// rear flank, tracks across the terrain for about four minutes, then ropes out, and the storm decays
// (setPiece engine; the supercell and the tornado are the ordinary 'supercell' and 'tornado' presets,
// started through the SpawnManager with their own budgets, lures and wind). The journal's Storm Chaser
// entry keeps the closest pass: journalStat closestTornado (min), and stormsChased (add 1) when the
// player came within 5 km of the funnel.
//
// Child overrides: the supercell grows over 170 s (formSeconds) with a wall cloud whose lowering the
// build stage ramps (weatherVolume control.wallCloud), and it dissipates by itself before the
// timeline ends, so nothing is cut off in view. The children's own approach journals are silenced
// (journal: []): the set piece alone sends closestTornado and stormsChased, so a chase counts once.
export default Object.freeze({
  id: 'stormChase',
  name: 'Storm chase',
  category: 'setpiece',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 900, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['day', 'dusk']),
    altitude: null,
    weather: Object.freeze(['building', 'storm']),
    surface: 'land',
    minDistance: 7000,
    maxDistance: 12000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'setPiece',
      params: Object.freeze({
        radius: 6000,
        retrySeconds: 2,
        narration: Object.freeze({ priority: 4, ttl: 30 }),
        children: Object.freeze({
          supercell: Object.freeze({
            preset: 'supercell',
            offset: Object.freeze({ along: 0, across: 0 }),
            duration: 500,
            params: Object.freeze({
              weatherVolume: Object.freeze({
                formSeconds: 170,
                dissipateSeconds: 45,
                wallCloud: Object.freeze({ radius: 950, drop: 420, offset: -800, rotation: 8 }),
                journal: Object.freeze([]),
              }),
            }),
          }),
          tornado: Object.freeze({
            preset: 'tornado',
            from: 'supercell',
            offset: Object.freeze({ along: -800, across: 0 }),
            duration: 250,
            params: Object.freeze({ vortex: Object.freeze({ journal: Object.freeze([]) }) }),
          }),
        }),
        stages: Object.freeze([
          Object.freeze({
            id: 'build',
            duration: Object.freeze([170, 190]),
            start: Object.freeze(['supercell']),
            ramps: Object.freeze([Object.freeze({ child: 'supercell', param: 'wallCloud', from: 0.12, to: 0.55, ease: 'smooth' })]),
            narrate: Object.freeze({
              lines: Object.freeze([
                'That cell {direction} is building fast, {distance} out. This could be the one.',
                'Supercell going up {direction}. Look at the updraft tower. Let us get closer, carefully.',
                'Big storm growing {direction}, {distance} away. Watch the base for rotation.',
              ]),
              delay: 4,
            }),
            marker: 'build',
          }),
          Object.freeze({
            id: 'wallCloud',
            duration: Object.freeze([24, 30]),
            ramps: Object.freeze([Object.freeze({ child: 'supercell', param: 'wallCloud', from: 0.55, to: 1, ease: 'out' })]),
            narrate: Object.freeze({
              lines: Object.freeze([
                'The wall cloud is lowering. It is rotating. Something is coming down.',
                'See the wall cloud dropping under the rear flank? Here we go.',
              ]),
              delay: 3,
            }),
            marker: 'wallCloud',
          }),
          Object.freeze({
            id: 'touchdown',
            duration: Object.freeze([235, 250]),
            start: Object.freeze(['tornado']),
            ramps: Object.freeze([Object.freeze({ child: 'tornado', param: 'intensity', from: 0.45, to: 1.2, over: 70 })]),
            until: Object.freeze({ childEnded: 'tornado' }),
            narrate: Object.freeze({
              lines: Object.freeze([
                'Touchdown! Tornado on the ground {distance} {direction}.',
                'It is down! Tornado {direction}, {distance}. Keep well clear of the inflow.',
              ]),
              target: 'tornado',
              delay: 6,
            }),
            marker: 'touchdown',
          }),
          Object.freeze({
            id: 'ropeOut',
            duration: 20,
            set: Object.freeze([Object.freeze({ child: 'tornado', param: 'ropeOut', value: true })]),
            narrate: Object.freeze({
              lines: Object.freeze([
                'It is roping out. What a ride.',
                'Look at it thin out into a rope. It is lifting.',
              ]),
              target: 'tornado',
            }),
            marker: 'ropeOut',
          }),
          Object.freeze({
            id: 'clearing',
            duration: 60,
            narrate: Object.freeze({
              lines: Object.freeze([
                'The storm is falling apart. That one goes in the journal.',
                'And the cell is collapsing. Storm chased.',
              ]),
              delay: 10,
            }),
            marker: 'clearing',
          }),
        ]),
        records: Object.freeze([Object.freeze({ id: 'closestTornado', child: 'tornado', measure: 'closestDistance' })]),
        journal: Object.freeze([
          Object.freeze({ key: 'closestTornado', record: 'closestTornado', op: 'min' }),
          Object.freeze({ key: 'stormsChased', value: 1, op: 'add', record: 'closestTornado', max: 5000 }),
        ]),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 8000, mid: 25000, far: 60000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: null,
  journal: Object.freeze({
    title: 'Storm Chaser',
    description: 'A supercell built, its wall cloud lowered and a tornado walked across the land before roping out. The journal keeps your closest pass.',
  }),
  discovery: Object.freeze({ radius: 15000, requireInView: true }),
  callouts: Object.freeze([
    'Storm building {distance} {direction}. Want to chase it?',
    'There is a supercell organising {direction}, about {eta} out. This one looks serious.',
    'Big storm {direction}, {distance}. If we go, we keep our distance from the funnel.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([570, 600]), despawn: Object.freeze({ distance: 30000, hysteresis: 5000, outOfViewSeconds: 60 }) }),
});
