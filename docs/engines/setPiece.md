# setPiece engine

Scripted multi-stage timelines that orchestrate the other engines through the SpawnManager: the
legendary storm chase, and in Phase 3 many combos. The code is in
`src/spawns/engines/setPieceEngine.js`; the copilot side is the `setPiece:narrate` handler in
`src/copilot/flightChatter.js`.

Preset authors use this page as the reference. A set piece is an ordinary preset (usually an event,
`category: 'setpiece'`) whose engine entry is `{ engine: 'setPiece', params: { children, stages,
records?, journal?, ... } }`. The timeline is data in the preset. Every duration, narration line and
child seed is drawn from the spawn's seeded random generator when the set piece is created, so the
same seed plays the same timeline. A bad field throws an error that names the preset and the path,
for example `[DRIFTWING] setPiece preset "stormChase" params.stages[2].start[0]: names no child:
"tornadp"`, and the SpawnManager refuses that activation. `validateTimeline(preset, params,
presetIds)` runs the same checks without a game (labs and preset tests).

## How it runs

- **Children** are the spawns the timeline may start: another preset each (a supercell, a
  tornado). A stage starts a child through `ctx.spawns.activate` with the set piece's own source,
  so every budget, the heavy limit, LOD, lures, discovery and dispose hold for it exactly as for a
  spawn the director started. A child a budget refuses (the heavy limit, say) waits and is retried
  every `retrySeconds` while its stage runs. A debug set piece (the F9 debugger, `forceSpawn`)
  starts its children as debug spawns, which pass the budgets.
- **Stages** run in order. A stage may wait for a start condition (`when`); a `whenTimeout` skips it
  if the condition never holds. On entry it ends children (`end`), starts children (`start`), sets
  child values (`set`) and narrates (`narrate`). It then runs for its `duration` unless its `until`
  condition fires first. While it runs, its `ramps` ease child params from `from` to `to`.
- **Ending.** After the last stage the set piece ends every child still running, emits
  `setPiece:ended`, sends its journal statistics and sets `instance.ended`; the manager removes it.
  A set piece removed early (despawned, ended in the debugger) still ends its children and reports
  its records with `completed: false`.
- Children are ended by setting their instances' `ended` flag, which the manager honours on its next
  update. A child that ends by itself (a tornado that roped out) is noticed through `spawnEnded`.
- The set piece has no geometry, wind or lights of its own. Its `update()` allocates nothing between
  stage changes.

The frame: the set piece's anchor and compass `heading` come from the activation (the director
places it ahead of the player). `along` is forward on the heading, `across` to its right, `up` above
the ground.

## Parameters

### Top level

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `children` | object | | required | `{ key: child }`, at least one; see [Children](#children) |
| `stages` | array | | required | at least one; see [Stages](#stages) |
| `records` | array | | `[]` | see [Records](#records) |
| `journal` | array | | `[]` | see [Journal statistics](#journal-statistics) |
| `retrySeconds` | s | 0.1..60 | 2 | between attempts to start a refused child |
| `radius` | m | 10..100000 | 4000 | the instance radius (the manager's discovery and LOD read the anchor) |
| `narration.priority` | | 0..10 | 3 | the chatter priority of every line |
| `narration.ttl` | s | 1..600 | 25 | a line not spoken within this is dropped |

### Children

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `preset` | preset id | | required | any registered preset except the set piece itself |
| `offset.along`, `offset.across` | m | | 0 | from the set piece's anchor, or from child `from`'s anchor |
| `offset.up` | m | -2000..20000 | 0 | above the ground (or the sea) at that point |
| `from` | child key | | null | place relative to another child (a tornado under the supercell) |
| `heading` | deg | -360..360 | 0 | added to the set piece's heading for the child's activation |
| `params` | `{ [engine]: { ... } }` | | null | per-activation engine params merged over the child preset's own (a smaller cluster, a lower cloud base); strict engines still validate them |
| `duration` | s | 1..86400 | the rest of the timeline + 60 s | the child event's lifetime (a vortex ropes out timed to end with it) |
| `track` | object or null | | null | a steady drift across the terrain, see below |
| `track.speed` | m/s | 0..200 | 10 | |
| `track.heading` | deg | -360..360 | 0 | relative to the child's heading |
| `track.wander` | deg | 0..90 | 0 | a slow seeded weave either side of the track |
| `track.followGround` | bool | | true | ease the anchor to the ground (or sea) + `up`, sampled twice a second |

`track` moves the child's anchors in place, which suits engines that draw at their anchor (the
framework's test engines, a structure, a light). An engine that tracks by itself (the vortex engine
precomputes its own path) should be given its own track params instead.

### Stages

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `id` | | unique | `stage<index>` | in `setPiece:stage` and `describe()` |
| `duration` | s | 0..86400, or `[min, max]` | none | seeded per spawn; a stage needs a `duration` or an `until` |
| `when` | condition | | null | wait for it before the stage starts (a `time` condition here counts the seconds waited; the stage's own clock starts at entry) |
| `whenTimeout` | s | >= 0 | never | skip the stage if `when` has not held by then |
| `until` | condition | | null | end the stage early |
| `start` | child keys | | `[]` | started on entry |
| `end` | child keys | | `[]` | ended on entry (before `start`) |
| `set` | array | | `[]` | `{ child, param, value }` written once on entry; `value` a number or true / false |
| `ramps` | array | | `[]` | see below |
| `narrate` | lines, or `{ lines, target?, delay? }` | | null | one line is drawn per spawn |
| `narrate.target` | child key | | the stage's first started child | `{distance}` and `{direction}` point at it |
| `narrate.delay` | s | 0..3600 | 0 | into the stage |
| `marker` | string | | null | passed through in `setPiece:stage` (for tests and other listeners) |

A ramp:

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `child` | child key | | required | |
| `param` | name | | required | the child's live param (see below) |
| `from`, `to` | | | 0, 1 | |
| `ease` | | `linear`, `smooth`, `in`, `out` | `smooth` | |
| `over` | s | 0.01..86400 | the stage duration (60 s for an open-ended stage) | the ramp holds `to` after it |

Ramps and `set` values reach a child in this order, per engine instance of the child preset:

1. `instance.params[param]` when the instance has a live params record with that field (the
   structure engine: `glow`, `sway`, `rotorSpeed`, `audio`), written every frame;
2. `instance.control[param]` when it has a control record with that field (the vortex engine:
   `intensity` 0..1.5, `ropeOut` true / false);
3. the engine's optional `setParam(instance, param, value)`, at most 10 times a second for a ramp.

A param no part of the child takes is counted in `describe().unsupportedRamps`; it is not an error,
so a timeline can address a combo whose engines differ in what they expose.

### Conditions

A condition is one of the objects below, or `{ any: [conditions] }` / `{ all: [conditions] }`.

| condition | holds when |
| --- | --- |
| `{ time: s }` or `{ time: [min, max] }` | the stage clock has reached the seeded value: seconds since the stage started (in `until`), or since it began waiting (in `when`) |
| `{ playerDistance: { min?, max?, child? } }` | the player's horizontal distance (m) to the child's anchor (else the set piece's anchor) lies within [min, max]; false while the child is not running |
| `{ altitude: { min?, max?, agl? } }` | the player's altitude (m, MSL; above the ground with `agl: true`) lies within [min, max] |
| `{ weather: state }` or `{ weather: [states] }` | the regional weather at the player (`clear`, `building`, `storm`, `clearing`: read from the weather system when the set piece is created, then followed through the typed `weatherChanged`) is one of them |
| `{ childActive: key }` | the child is running |
| `{ childEnded: key }` | the child has ended (by itself, by a stage or by its budget) |

### Records

Measured every frame while the target child (or the set piece) exists, reported when the set piece
ends.

| field | unit | default | notes |
| --- | --- | --- | --- |
| `id` | | required | the key in `setPiece:ended` `records` |
| `child` | child key | the set piece | |
| `measure` | `closestDistance`, `timeWithin` | `closestDistance` | the closest the player came (m, 3D), or the seconds spent within `radius` |
| `radius` | m | 1000 | for `timeWithin` |

### Journal statistics

Sent as the typed `journalStat` `{ key, value, op, presetId }` when the set piece ends. The journal
(`src/gameplay/journal.js`) keeps the global records; `stormsChased`, `closestTornado` and
`bestCanyonRun` are the ones it names, and any other camelCase key is kept with its op.

| field | unit | default | notes |
| --- | --- | --- | --- |
| `key` | camelCase, up to 40 characters | required | |
| `op` | `min`, `max`, `add` | `add` | how the journal folds it |
| `record` | record id | none | send only when this record measured something (finite) no greater than `max` |
| `value` | number | the record's value | required without `record` |
| `max` | the record's unit | no limit | |

A statistic with a `record` is sent whenever the set piece ends (a closest pass counts even if the
player left early); one without a `record` is sent only when the timeline completed.

## Narration

A stage's line is emitted as `setPiece:narrate` `{ id, presetId, name, stage, text, position,
priority, ttl }`. The copilot's flight chatter fills the tokens from where the player is when the
line is offered and passes it through the v1 chatter gate, so `settings.copilotChatter`, photo mode
and the pacing (one unsolicited line per 30 s, quiet 10 s after any line) still hold:

| token | becomes |
| --- | --- |
| `{distance}` | the distance to the target, in the copilot's distance phrasing |
| `{direction}` | the direction from the player's heading ("straight ahead", "to the northeast", "behind us, to the south") |
| `{name}` | the set piece preset's name |
| `{eta}` | the time to the target at the current ground speed ("2 minutes") |

## Events

| event | kind | payload |
| --- | --- | --- |
| `setPiece:stage` | bus | `{ id, presetId, stage, index, marker }` |
| `setPiece:narrate` | bus | `{ id, presetId, name, stage, text, position, priority, ttl }` |
| `setPiece:ended` | bus | `{ id, presetId, completed, stagesRun, records }` |
| `journalStat` | typed | `{ key, value, op, presetId }` |
| `spawnActivated`, `spawnEnded` | typed | from the SpawnManager, for the set piece and each child |

## Example: the legendary storm chase

The supercell builds for about 3 minutes while the wall cloud lowers and the copilot narrates; a
tornado touches down, tracks for about 4 minutes and ropes out; the journal keeps the closest pass.
The child presets (`supercell` on the weatherVolume engine, `tornado` on the vortex engine) are
ordinary presets of their own; the set piece only places and times them.

```js
engines: [{
  engine: 'setPiece',
  params: {
    narration: { priority: 4, ttl: 30 },
    children: {
      supercell: { preset: 'supercell', offset: { along: 0 } },
      tornado: { preset: 'tornado', from: 'supercell', offset: { along: -600, across: 400 }, duration: 250 },
    },
    stages: [
      {
        id: 'build',
        duration: [170, 190],
        start: ['supercell'],
        narrate: ['That supercell {direction} is building fast, {distance} out.', 'Big storm growing {direction}. Keep your distance.'],
      },
      {
        id: 'wallCloud',
        duration: 25,
        narrate: { lines: ['The wall cloud is lowering. Something is coming down.'], delay: 5 },
      },
      {
        id: 'touchdown',
        duration: [230, 250],
        start: ['tornado'],
        ramps: [{ child: 'tornado', param: 'intensity', from: 0.4, to: 1.2, over: 60 }],
        until: { childEnded: 'tornado' },
        narrate: { lines: ['Touchdown! Tornado on the ground {distance} {direction}.'], target: 'tornado' },
      },
      {
        id: 'ropeOut',
        duration: 20,
        set: [{ child: 'tornado', param: 'ropeOut', value: true }],
        narrate: { lines: ['It is roping out. What a ride.'], target: 'tornado' },
      },
      { id: 'clearing', duration: 30, end: ['supercell'] },
    ],
    records: [{ id: 'closestTornado', child: 'tornado', measure: 'closestDistance' }],
    journal: [
      { key: 'closestTornado', record: 'closestTornado', op: 'min' },
      { key: 'stormsChased', value: 1, op: 'add', record: 'closestTornado', max: 5000 },
    ],
  },
}],
```

Weather-gated set pieces add `when: { weather: 'storm' }` (with a `whenTimeout`) to their first stage;
proximity beats use `until: { playerDistance: { child: 'tornado', max: 800 } }`.

## Stats and inspection

`stats()` returns `{ instances, particles: 0, lights: 0, buffers: 0, drawCalls: 0, children,
stagesEntered, narrations, refusedChildren, rampCalls }`. `engine.describe(instance)` returns the
timeline state: `{ stage, running, stageTime, stagesRun, finished, children: [{ key, presetId, id,
status: idle | waiting | active | ended }], records, refusals, unsupportedRamps, weather }`.

## Budget and cost

The director's cap is one set piece at a time (`DIRECTOR_BUDGETS.engines.setPiece`: 1 instance,
0 particles). The set piece's own cost is small: `tools/lab/setpiece.mjs` measures about 0.2 us per
`update()` with three live children, a ramp, a tracked child, two records and three conditions, and
0.04 B per frame of young-generation growth (no garbage collection in 100 000 frames). Its children
cost what their engines cost.

## Testing

- `node --expose-gc tools/lab/setpiece.mjs`: validation, the dev timeline end to end (stages,
  children through the manager, ramps, `set`, tracking, narration, records, journal statistics),
  every trigger kind, budgets and retries, a vortex-style control record, determinism, early
  dispose, the copilot's token filling, cost and allocation.
- `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-setPiece.json`:
  the dev timeline in the live game through the dev hook, orchestrating the framework's test engines
  and a structure child: stages in order, children started and ended through the manager, the
  copilot speaking a narration line, records, and GPU memory and wind sources back to their level
  after the run; add `--query renderer=webgl` for WebGL2.
- The dev timeline is `DEV_TIMELINE` in `src/dev/setPieceTestKit.js` (dev only).
