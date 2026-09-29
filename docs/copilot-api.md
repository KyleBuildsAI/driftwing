# WREN remote copilot API

DRIFTWING's copilot, WREN, answers with a built-in local grammar by default. You can replace that
brain with your own HTTP endpoint, for example one backed by a language model. This page is the
contract for that endpoint: what the game sends, what it accepts back, how every action is
checked, and what happens when something goes wrong.

`tools/copilot-server.mjs` is a working reference brain. It uses rules, and Claude too when
`ANTHROPIC_API_KEY` is set. Start it with `npm run copilot-server`.

This page describes V2's WREN. V1, the frozen original game behind the same launcher, keeps its
own WREN and its own remote-brain setting, with the contract it shipped with in v1.0.0. The "v1"
fields and actions below are the ones V2 inherited from it.

## Turning it on

1. Run your endpoint, for example `npm run copilot-server`. It listens on `http://localhost:3000/copilot`.
2. In the game, open Settings (`,`), turn on **Remote copilot**, and set the endpoint URL.

The endpoint must be `http:` or `https:`. It is saved in the `remoteEndpoint` setting, and
`remoteCopilot` switches it on or off. When remote is off, or while it is failing, the local
grammar answers.

## The request

Each thing the pilot says or types becomes one request:

```
POST <endpoint>
Content-Type: application/json

{ "flightState": { ... }, "transcript": "switch to the bush plane" }
```

- `transcript`: the pilot's words, cleaned of control characters and at most 300 characters. It
  can be a voice transcript, so expect lower case, missing punctuation and misheard words.
- `flightState`: a snapshot of the flight at that moment. Every field is listed below.

A few settings commands never go to the endpoint: "voice off", "voice on", "be quiet" and "talk
to me more" ("be quiet" also turns the tour-guide callouts off, "talk to me more" turns them back
on), and "callouts off" / "callouts on". The game handles them locally.

The answer to an open callout offer never goes to the endpoint either. While an offer is open
(`flightState.callouts.offer` is not `null`), a bare "yes" ("yes", "yeah", "sure", "ok", "yes please,
take us there", ...) places the waypoint and a bare "no" ("no", "no thanks", "not now", ...)
declines, whatever brain is active. A "yes" followed by another request ("yes, switch to the jet")
is not an answer and goes to the brain as usual. See [Proactive callouts](#proactive-callouts).

### Timeouts and failures

| rule | value |
| --- | --- |
| time budget per request | 800 ms, then the request is aborted |
| on timeout, network error, non-2xx status, invalid JSON or a reply that fails validation | the local grammar answers this request instead (`source: 'local-fallback'`), and the pilot sees one "Remote copilot unavailable" notice until the endpoint answers again |
| after 3 failures in a row | the game stops calling the endpoint for 20 s and answers locally |
| caching | requests are sent with `cache: 'no-store'` |

Aim for answers well inside 800 ms. The reference server gives Claude 700 ms
(`COPILOT_CLAUDE_BUDGET_MS`) and then falls back to its own rules.

### CORS and origins

The game page calls your endpoint from the browser, so the endpoint must allow CORS:

- It must answer the `OPTIONS` preflight with `Access-Control-Allow-Origin: <the page origin>`,
  `Access-Control-Allow-Methods: POST, OPTIONS` and `Access-Control-Allow-Headers: Content-Type`.
- The page is V2 at `/v2/`, which shares its origin with the launcher shell that runs it. The
  origins are `http://127.0.0.1:5199` (the dev server and `npm run serve:single`), the origin of
  any other local server that hosts `dist-single/`, and `null` when `dist-single/v2/index.html` is
  opened directly from a file.
  Sandboxed iframes and `data:` documents on any website also send `null`, so treat it as
  untrusted.
- If the endpoint is on the loopback address and the page is not, Chrome also sends
  `Access-Control-Request-Private-Network: true`. Answer it with
  `Access-Control-Allow-Private-Network: true`.
- Allow only origins you trust. The reference server accepts `http(s)://localhost`,
  `127.0.0.1` and `[::1]` on any port. Add more with
  `ALLOWED_ORIGINS=https://a.example,https://b.example`. It refuses `null` unless you start it
  with `ALLOW_FILE_ORIGIN=1` (only needed when the game is opened from a file). Every other origin
  gets `403`, so an unrelated website cannot spend your model key.
- Keep request bodies small. The reference server refuses bodies over 64 KiB with `413`.

## The response

Reply with status `200` and a JSON object:

```json
{ "speech": "Switching over.", "action": { "type": "setCraft", "craft": "bushplane" } }
```

| field | type | rules |
| --- | --- | --- |
| `speech` | string, or omitted / `null` | what WREN says. Control characters are removed, whitespace is collapsed, and it is cut to 400 characters at a sentence or word boundary. Any other type makes the reply invalid |
| `action` | object, or omitted / `null` | at most one action, validated as below. An invalid action makes the whole reply invalid, and the local grammar answers instead |

A reply needs some speech, or an action other than `none`. `{ "speech": "", "action": null }` is
invalid.

### What the pilot hears

The game runs the action and composes the final line:

- **The action failed** (for example there is no chute on the glider, or the switch to version one
  was asked for from a page that is not the DRIFTWING launcher): WREN says the game's own explanation. Your speech is dropped, so the pilot never hears a
  success you could not confirm.
- **An informative action succeeded** (`describe`, `find`, `waypoint`, `journal`, `ringCourse`,
  `setAssists`, and the tour-guide actions `nearby`, `goTo`, `findThermal`, `chaseStorm`,
  `nextDiscovery`): your speech comes first, then the game's precise facts (distances, headings,
  the new assist level and what it does). Keep your speech to a short lead-in, or leave it empty.
  A tour-guide action that finds nothing ("No storms active within 40 km.") counts as failed, so
  your speech is dropped and the pilot hears the honest answer.
- **Any other action succeeded**: your speech is used. If it is empty, WREN says the game's own
  confirmation. For aircraft actions an empty speech is usually best, because the game reports the
  real outcome ("Engine off.", "We're already flying the bush plane.").

The line appears as a subtitle, is spoken if voice is on, and is published on the bus as
`copilot:speech { text, source }` with source `remote`, `local` or `local-fallback`.

## flightState

Units are SI unless a field says otherwise: metres, m/s, degrees and seconds. Headings and
bearings are compass degrees (0 north, 90 east). World axes are +x east, +y up and -z north.
Numbers are rounded as shown, and a value that cannot be read is sent as `0` or `null`.

### v1 fields

| field | type | meaning |
| --- | --- | --- |
| `seed` | string | world seed |
| `position` | `{ x, y, z }` m, integers | craft position |
| `altitude` | m, integer | height above sea level |
| `altitudeAboveGround` | m, integer | height above the ground or the sea surface (same as `agl`) |
| `speed` | m/s, integer | airspeed along the flight path |
| `speedKmh` | km/h, integer | `speed` in km/h |
| `heading` | deg, integer | compass heading |
| `headingName` | string | `north`, `north-east`, ... |
| `pitch`, `roll` | deg, integers | attitude |
| `throttle` | 0..1 | throttle lever |
| `verticalSpeed` | m/s, 1 decimal | climb (+) or sink (-) |
| `biome` | `{ key, name }` | dominant biome below: `snow`, `pine`, `dunes`, `archipelago`, `meadows` |
| `place` | string | what the ground ahead actually looks like, for example "the foothills of the Snow Peaks". Use this rather than the biome name |
| `overWater` | boolean | over the sea |
| `dayTime` | 0..1 | time of day (0.5 is noon) |
| `timeLabel` | string | for example `golden hour` or `night` |
| `isNight` | boolean | |
| `autopilot` | `{ enabled, heading, altitude, followWaypoint, speed? }` | autopilot state |
| `waypoint` | `{ x, z, label, distance, bearing }` or `null` | active waypoint (distance in m) |
| `ringCourse` | `{ active, total, passed, streak, bestStreak, elapsed, nextIndex, nextRingDistance?, ... }` | ring course |
| `nearbyLandmarks` | up to 5 `{ name, type, x, z, distance, bearing, discovered }` | landmarks within 6 km |
| `journal` | object or `null` | `{ landmarksFound: [...], biomesVisited: [...], distanceFlown, ... }` |

### v2 fields

| field | type | meaning |
| --- | --- | --- |
| `craft` | string | active craft id: `glider`, `bushplane`, `jet`, `helicopter`, `wingsuit` or `fpv` |
| `craftName` | string | display name, for example `Bush plane` |
| `availableCraft` | string[] | the craft installed in this build (all six in Phase 1). `setCraft` to anything else is refused |
| `units` | `'metric'` \| `'aviation'` | the pilot's units. Metric is km/h and metres; aviation is knots and feet. Speak in them |
| `view` | string or `null` | last camera view the game reported (`chase`, `cockpit`, `wing`, `flyby`, `fpv`). `null` until the first view change |
| `capabilities` | `{ engine, chute, flaps, throttle }` booleans | what the craft has |
| `assists` | object | flight assists for the active craft (the only difficulty control; every craft flies the real flight model), below |
| `assists.level` | 0..1, 2 decimals | effective level (1 while the hands-off hold of a disconnected controller is active) |
| `assists.percent` | integer 0..100 | `level` as a percentage |
| `assists.configured` | 0..1 | the level the pilot set for this craft |
| `assists.overridden` | boolean | the hands-off hold is forcing 100 % |
| `assists.active` | string[] | the assists active at this level, for example `["auto-coordination", "auto-trim", "stall warning"]` |
| `airspeed` | object | speeds, below |
| `airspeed.trueMs` | m/s, 1 decimal | true airspeed, relative to the air mass |
| `airspeed.indicatedMs` | m/s, 1 decimal | indicated airspeed (true airspeed x sqrt(rho / 1.225)). Quote this as "airspeed" |
| `airspeed.groundSpeedMs` | m/s, 1 decimal | horizontal ground speed |
| `airspeed.mach` | 3 decimals | Mach number |
| `airspeed.unit` | `'km/h'` \| `'kt'` | display unit for `units` |
| `airspeed.indicated`, `airspeed.groundSpeed` | integers | the two speeds in `airspeed.unit` |
| `aoa` | deg, 1 decimal | angle of attack |
| `gLoad` | g, 2 decimals | load factor (1 in level flight) |
| `agl` | m, integer | height above the ground or the sea surface |
| `windAtCraft` | object | the air motion at the craft, from the wind field (ambient wind, ridge lift, thermals, gusts) |
| `windAtCraft.x`, `.y`, `.z` | m/s, 2 decimals | wind vector (world axes; +y is rising air) |
| `windAtCraft.speed` | m/s, 1 decimal | horizontal wind speed |
| `windAtCraft.fromDegrees` | deg or `null` | compass direction the wind blows FROM (`null` in calm air) |
| `windAtCraft.fromName` | string or `null` | the same as a compass name, for example `south-west` |
| `windAtCraft.vertical` | m/s, 2 decimals | rising (+) or sinking (-) air: lift for gliders |
| `windAtCraft.turbulence` | 0..1 | turbulence intensity |
| `gear` | `{ retractable, down }` booleans | landing gear |
| `flaps` | `{ position: 0..1, notch: integer }` | flaps |
| `onGround` | boolean | wheels or skids on the ground |
| `engineOn` | boolean | engine or motors running |
| `stall` | `{ warning, stalled }` booleans | stall warning and stall |
| `lastLandingGrade` | `'butter'` \| `'smooth'` \| `'firm'` \| `'hard'` \| `null` | grade of the last landing this session |
| `lastLanding` | `{ grade, sinkRate, groundSpeed, craft }` or `null` | sink rate at touchdown in m/s (2 decimals), ground speed in m/s |
| `bestLanding` | same shape or `null` | best landing this session: best grade first, then the lowest sink rate |
| `landingCount` | integer | graded landings this session |

Landing grades come from the sink rate at touchdown: butter up to 0.5 m/s (100 fpm), smooth up
to 1.2 m/s, firm up to 2.2 m/s, and hard above that. Beyond the craft's limit it is a soft crash:
a short fade and a respawn 300 m up, with no penalty.

### v2 tour-guide fields

The spawns (Phase 2 sites and events: storms, volcanoes, whales, bridges, ...) around the craft, from
the event director's `getNearby(radiusKm)` merged with the spawn manager's live spawns.

| field | type | meaning |
| --- | --- | --- |
| `nearby` | array, up to 10, nearest first | everything the director knows within 15 km: live spawns, dormant candidates and sites. `[]` before the spawns start |
| `nearby[].id` | string | the site id (`<presetId>:<cellX>:<cellZ>`), the candidate id (`<presetId>:<cellX>:<cellZ>:<bucket>`) or the live spawn id (`spawn:<presetId>:<serial>`). Pass it to `goTo` as `id` |
| `nearby[].presetId` | string | the preset, for example `tornado`, `ropeBridge` |
| `nearby[].name` | string | display name, for example `Rope bridge` |
| `nearby[].category` | string | `weather`, `geo`, `ocean`, `wildlife`, `structure`, `celestial`, `fantasy`, `flightplay` or `setpiece` |
| `nearby[].kind` | `'site'` \| `'event'` | a persistent place or a temporary happening |
| `nearby[].distance` | m, integer | horizontal distance from the craft |
| `nearby[].bearing` | deg, integer | compass bearing from the craft |
| `nearby[].state` | `'active'` \| `'dormant'` \| `'site'` \| `'discovered'` | `active`: happening now (a live event, or a site in its active state such as an erupting volcano). `dormant`: a candidate the director could start here, only a possibility; never tell the pilot it is there. `site`: a place not in the journal yet. `discovered`: a place in the journal |
| `nearby[].etaSeconds` | s, integer, or `null` | at the current ground speed; `null` when nearly stopped |
| `nearby[].discovered` | boolean | in the journal |
| `activeEvents` | array, up to 10, nearest first | the live events within 40 km (and sites in their active state), same fields as `nearby[]` with `state: 'active'`; `id` is the live spawn id |
| `weather` | `{ state, storminess }` or `null` | the regional weather where we fly: `state` is `clear`, `building`, `storm` or `clearing`; `storminess` 0..1 |
| `callouts` | `{ enabled, offer }` | `enabled`: the pilot's tour-guide callouts setting. `offer`: the open callout offer or `null`, below |
| `callouts.offer` | `{ name, presetId, distance, bearing, expiresIn }` or `null` | the spawn WREN just called out and offered a heading to; `expiresIn` in seconds. The game answers a "yes" or "no" to it itself |

Undiscovered sites are never drawn on the world map, but WREN (and your brain) may name them and
guide the pilot to them.

New fields are only ever added. Ignore fields you do not know.

## Actions

Every action is an object with a `type`. Parameters must have exactly the type shown. A present
but invalid parameter, or an unknown `type`, makes the reply invalid and the local grammar answers
instead. Optional parameters may be omitted or `null`. Extra unknown keys are ignored.

### v1 actions

| type | parameters | validation and effect |
| --- | --- | --- |
| `waypoint` | `x`, `z` (numbers, both or neither, abs <= 1e7); `bearing` (number, wrapped to 0..360); `distance` (number, clamped 50..40000 m); `label` (string, cleaned, max 48 chars); `autopilot` (boolean) | places the waypoint beacon at `x, z`, or `distance` along `bearing` (default: 1500 m along the heading). `autopilot: true` also engages the autopilot to follow it |
| `clearWaypoint` | none | removes the waypoint |
| `autopilot` | `enabled` (boolean, required); `heading` (number, wrapped); `altitude` (number, clamped 40..2600 m); `followWaypoint` (boolean) | autopilot on or off. `followWaypoint` follows the waypoint or the next ring. It flies through the flight model |
| `time` | `preset` (one of `dawn sunrise morning noon golden sunset dusk night midnight`) or `dayTime` (number, wrapped to 0..1) | moves the clock |
| `ringCourse` | `count` (number, rounded, clamped 3..24; default 10) | starts a ring course |
| `cancelRingCourse` | none | stops the course |
| `find` | `target` (one of `mountains snow ocean archipelago islands desert dunes forest pine meadows flowers landmark arch monoliths lighthouse balloons`); `autopilot` (boolean) | finds the nearest such place, sets a waypoint and reports it |
| `describe` | none | the game describes where we are |
| `photoMode` | `enabled` (boolean; omitted toggles) | photo mode on or off |
| `journal` | none | opens the journal and summarizes it |
| `none` | none | no action (needs speech) |

### v2 aircraft actions

| type | parameters | validation | effect and outcome |
| --- | --- | --- | --- |
| `setCraft` | `craft`: `glider` \| `bushplane` \| `jet` \| `helicopter` \| `wingsuit` \| `fpv` (case-insensitive) | any other value is invalid | writes the `craft` setting. The flight controller applies it or refuses it. A craft that is not in `availableCraft` is refused with a friendly line that names the installed craft |
| `setAssists` | exactly one of: `level` (number 0..1, rounded to 0.01) or `change` (`up` \| `down` \| `full` \| `off`) | both or neither, a level outside 0..1, or an unknown change is invalid | sets the assists of the active craft. `up` and `down` move to the next 25 % step, `full` is 100 % and `off` is 0 %. WREN reports the new level and what is active ("auto-coordination, auto-trim and stall warning, with AoA limiter at part strength"). It counts as the pilot's own choice, so the one-time HOTAS default (50 %) leaves that craft alone |
| `setView` | `view`: `cockpit` \| `chase` \| `wing` \| `flyby` \| `outside` | any other value is invalid | `cockpit` (first person), `chase` and `outside` (the craft's last third-person view: chase, wing or flyby) send the `viewForward`, `viewBack` or `viewToggle1P3P` input action (`input:action`, source `copilot`); `wing` and `flyby` set the active craft's entry in `settings.views`. WREN then waits up to 1.2 s for the camera to confirm the change. On the FPV drone the first-person view is its FPV camera (`view: 'fpv'`), which counts as the cockpit. Asking for the view already on screen is answered without an action. If the camera does not switch, WREN says so |
| `deployChute` | none | | refused with "No chute on the ..." when the craft has no chute. Otherwise sends `chuteDeploy` and confirms only when the canopy is open (`craftState.canopy`) |
| `engine` | `enabled` (boolean, required) | a missing or non-boolean value is invalid | refused on craft without an engine. If the engine is already in that state, WREN says so. Otherwise sends `engineToggle` and confirms only when `engineOn` changes (up to 1.2 s) |
| `relaunch` | none | | the craft's relaunch: aerotow to 1000 m above the ground for the glider (refused from 950 m above the ground, or while on tow), a dive from the nearest high peak for the wingsuit, or an airstart 300 m up for the others (the helicopter and the drone come back hovering). Refused during a soft-crash reset |
| `calibrate` | `calibrate` (boolean, optional; the wizard always opens) | a non-boolean value is invalid | opens the controls panel with the calibration wizard (`ui:openControls { calibrate: true }`). It is refused honestly when this build has no controls panel |
| `switchVersion` | `version`: `v1` (required, case-insensitive) | a missing version or any other value (`v2` included) is invalid | switches to version one, the original DRIFTWING, by sending the `versionToggle` input action (source `copilot`). Inside the launcher shell (`/`) the shell switches; V2 opened on its own at `/v2/` opens the shell with `?v=1`. On a page that is not the launcher it is refused ("Switching to version one works from the DRIFTWING launcher page."). The confirmation is spoken as the switch starts; this game is version two, so there is nothing to switch back to from here |

### v2 tour-guide actions

Each places the waypoint beacon itself and reports the distance, the direction and the heading to
fly. `autopilot` (boolean, optional) also engages the autopilot to follow the waypoint; send it only
when the pilot asked you to fly there. A present but non-boolean `autopilot` is invalid.

| type | parameters | validation | effect and outcome |
| --- | --- | --- | --- |
| `nearby` | none (`autopilot` is ignored) | | "what's nearby": WREN names the closest three spawns within 15 km with distance, direction and state ("Rope bridge, 3.0 km to the east, in the journal"), leaving out dormant candidates, and how many more there are. With none, it says so and names the nearest landmark |
| `goTo` | exactly one of: `name` (string, cleaned, at most 48 chars: a preset name, a synonym such as "twister" or "whirlpool", or a category word such as "wildlife" or "buildings") or `id` (string, at most 96 chars: an `id` from `nearby` or `activeEvents`); `autopilot` | both or neither, an empty or non-string name, or an empty or too-long id is invalid | "take me to the ...": a waypoint on the best match within 40 km, labelled with its name. A discovered site wins over an undiscovered one unless the undiscovered one is less than half as far. Dormant candidates are never targets. It fails honestly when the name is unknown ("I don't know anything called ...") or nothing matching is near ("No tornado within 40 km that I know of. It isn't happening anywhere near us right now.") |
| `findThermal` | `autopilot` | | "find a thermal": the nearest working thermal from the WindField (at least 0.8 m/s, searched out to about 7 km), aimed at where the leaning column is at our height, with its strength and top. Inside one already, WREN says so and places nothing. None working (or night), it says so |
| `chaseStorm` | `autopilot` | | "chase the storm": the nearest active storm (a preset that needs storm weather or is a supercell, tornado, microburst, waterspout or storm) within 40 km; else the nearest storm candidate, marked "Possible ..." and spoken as a possibility; else it fails honestly with the regional weather ("No storms active within 40 km. The weather is building here though ...") |
| `nextDiscovery` | `autopilot` | | "next discovery": the nearest live spawn or site not in the journal (never a dormant candidate), else the nearest undiscovered landmark. The waypoint is labelled "Next discovery" and WREN gives only a hint ("Something new, a structure: ..."), so the discovery stays a surprise. With nothing left, it says everything near is already in the journal |

Everything the local grammar says maps onto these same actions, so a remote brain can do
everything the local one can.

## Proactive callouts

With the **Tour-guide callouts** setting on (the default; Settings, Copilot; "callouts off" and "callouts
on" by voice), WREN calls out spawns as they appear: a live event starting (`spawnActivated`, kind
`event`) or a site not yet in the journal coming into range (`spawnActivated`, kind `site`). It
speaks one of the preset's callout lines with its tokens filled, `{distance}` ("9.0 km"),
`{direction}` ("north-west"), `{name}` and `{eta}` ("about 4 minutes away"), and ends with "Want a
heading?" when the line does not already ask:

> "Supercell building 9.0 km north-west. Want a heading?"

A bare "yes" (spoken, typed, or the **Yes, heading** chip) within 20 s places a waypoint on the
spawn, where it is now, and WREN answers with the heading and the distance ("Heading 315 for the
supercell, 9.0 km to the north-west. Waypoint set."). "Yes, take us there" also engages the
autopilot. "No" (or the **No thanks** chip) declines. After 20 s the offer lapses.

The rules:

| rule | value |
| --- | --- |
| rate | at most one callout per 45 s |
| height | never below 150 m above the ground or the water |
| landing | never while landing: on the ground, retractable gear down, below 300 m and sinking faster than 1.5 m/s, or on approach (flaps out below 500 m while sinking) |
| no overlap | never while WREN answers a question, listens, speaks, within 4 s of any other line, or while an offer is still open; the callout waits (up to 120 s, while the spawn lives) and is spoken when the rules allow |
| once | each site and each live event is called out at most once; spawns nearer than 400 m or further than 40 km are not called out |
| priority | when several wait, the rarest (heavy and events first) is spoken |

Callouts also stay quiet in photo mode and during a soft-crash reset. Each is published on the bus
as `copilot:callout { text, presetId, spawnId }` and the offer as `copilot:offer { active, name?,
presetId?, expiresIn? }`.

## Errors your endpoint can return

| response | game behaviour |
| --- | --- |
| `200` with a valid reply | used |
| `200` with an invalid reply (wrong types, unknown action, empty) | local answer, counted as a failure |
| `4xx` / `5xx` | local answer, counted as a failure |
| no answer within 800 ms | aborted, local answer, counted as a failure |

The reference server answers `400` for a bad JSON body, `403` for a refused origin, `404` for an
unknown path, `405` for anything but POST on `/copilot`, and `413` for a body over 64 KiB.
`GET /health` returns `{ ok, brain, model, actions }`.

## Examples

Switch craft (the game confirms or refuses):

```json
request  { "transcript": "let's take the cub", "flightState": { "craft": "glider", "availableCraft": ["glider", "bushplane", "jet", "helicopter", "wingsuit", "fpv"], "...": "..." } }
response { "speech": "", "action": { "type": "setCraft", "craft": "bushplane" } }
heard    "Bush plane it is."
```

An action the craft cannot do (your speech is dropped, and the game's explanation is spoken):

```json
response { "speech": "Chute's out!", "action": { "type": "deployChute" } }
heard    "No chute on the glider."
```

A `setCraft` to a craft that is not in `availableCraft` is refused the same way ("... isn't in
this hangar yet. Right now we can fly ..."). Every Phase 1 build installs all six craft, so this
only happens in a build that registers fewer.

Assists, with a lead-in (informative, so both parts are spoken):

```json
response { "speech": "Easing off the training wheels.", "action": { "type": "setAssists", "change": "down" } }
heard    "Easing off the training wheels. Assists at 75 percent for the bush plane: auto-coordination, auto-trim and stall warning, with AoA limiter, G limiter, auto-level, flight-path hold, bank protection, pitch protection and overspeed protection at part strength."
```

Version one (the game switches as soon as it confirms):

```json
response { "speech": "", "action": { "type": "switchVersion", "version": "v1" } }
heard    "Switching to version one, the original game."
```

A question the endpoint answers from flightState:

```json
request  { "transcript": "how was my landing", "flightState": { "units": "aviation", "lastLanding": { "grade": "butter", "sinkRate": 0.31, "groundSpeed": 16, "craft": "bushplane" }, "...": "..." } }
response { "speech": "A butter landing, 60 feet a minute at touchdown.", "action": null }
```

Engine off:

```json
response { "speech": "", "action": { "type": "engine", "enabled": false } }
heard    "Engine off. Best glide speed now, and pick a field."
```

What's nearby (informative, so the game's list follows your lead-in):

```json
request  { "transcript": "what's around here", "flightState": { "nearby": [{ "id": "ropeBridge:12:-4", "presetId": "ropeBridge", "name": "Rope bridge", "category": "structure", "kind": "site", "distance": 3000, "bearing": 90, "state": "discovered", "etaSeconds": 75, "discovered": true }], "...": "..." } }
response { "speech": "Let me look.", "action": { "type": "nearby" } }
heard    "Let me look. Nearby: Rope bridge, 3.0 km to the east, in the journal."
```

Take me to a live event by its id, and fly there:

```json
request  { "transcript": "fly us to that supercell", "flightState": { "activeEvents": [{ "id": "spawn:supercell:7", "presetId": "supercell", "name": "Supercell", "distance": 9000, "bearing": 315, "state": "active", "...": "..." }], "...": "..." } }
response { "speech": "", "action": { "type": "goTo", "id": "spawn:supercell:7", "autopilot": true } }
heard    "Supercell: 9.0 km to the north-west, heading 315. It's not in the journal yet. Waypoint set, autopilot engaged."
```

Chase the storm when none is active (a failed action, so your speech is dropped):

```json
response { "speech": "Storm dead ahead!", "action": { "type": "chaseStorm" } }
heard    "No storms active within 40 km. The weather is building here though, so watch the horizon."
```

Invalid replies (each makes the game answer locally):

```json
{ "speech": "ok", "action": { "type": "setAssists", "level": 0.5, "change": "up" } }
{ "speech": "ok", "action": { "type": "setCraft", "craft": "blimp" } }
{ "speech": "ok", "action": { "type": "engine", "enabled": "off" } }
{ "speech": "ok", "action": { "type": "goTo", "name": "volcano", "id": "eruptingVolcano:3:1" } }
{ "speech": "ok", "action": { "type": "findThermal", "autopilot": "yes" } }
{ "speech": 42 }
{ "speech": "", "action": null }
```

## Keyboard and UI equivalents

Every aircraft command also has a key or control, and WREN lists them when asked "what can you
do". The keys shown are the defaults, and WREN reads the live bindings:

| command | equivalent |
| --- | --- |
| switch to [craft] | keys 1-6, `[` / `]`, the craft picker |
| switch to version one ("version one", "v1", "play the original") | F8, T.16000M base button 10, the launcher's V1 \| V2 pill |
| assists up / down / full / off | the assists slider in Settings (`,`) |
| cockpit view / chase view | Numpad 8 / Numpad 2, the stick hat up / down |
| third person / outside view (the last outside view), cockpit from outside | V, gamepad View, TWCS button 8 (`viewToggle1P3P`) |
| wing view / flyby view | C cycles chase, cockpit, wing and flyby (`viewCycle`) |
| deploy chute | U |
| engine off / on | Z |
| relaunch | Backspace |
| calibrate controls | `.` (controls panel) |
| push-to-talk | hold `` ` `` or the HOTAS trigger (the `copilotPTT` action); M or the mic button toggles the mic |

The command bar also shows an "Aircraft" row of quick chips for these commands.

The tour guide has a "Guide" row in the command bar (Enter or `/` opens it), and "guide help" lists
its phrases:

| command | equivalent |
| --- | --- |
| what's nearby ("what is nearby", "anything interesting nearby", "what's around here") | the **What's nearby** chip |
| take me to the [name or category] ("fly us to the volcano", "head for the wind turbines", "where is the airfield"; add "on autopilot" to be flown there) | a **To [name]** chip for the two nearest live events or discovered sites (never an undiscovered one) |
| find a thermal ("any thermals nearby", "find some lift") | the **Find a thermal** chip |
| chase the storm ("storm chasing", "any storms around", "chase the tornado") | the **Chase the storm** chip |
| next discovery ("find something new", "something we haven't seen") | the **Next discovery** chip |
| yes / no to a callout | the **Yes, heading** and **No thanks** chips, shown while the offer is open |
| callouts on / off | the **Tour-guide callouts** switch in Settings (`,`), Copilot |
