# The aerobatic craft

An Extra 330 class unlimited-category monoplane (Phase 3 spec, Milestone D item 7; contract h). This page
is the craft's reference until Milestone O folds it into [architecture.md](architecture.md),
[controls.md](controls.md) and [copilot-api.md](copilot-api.md).

| part | file |
| --- | --- |
| module (mesh, profile, abilities, copilot, journal, bindings, `situate`) | `src/craft/aerobatic.js` |
| model kind `aerobatic` (SimFixedWing) and its assists | `src/flight/aerobaticAssists.js` |
| extension `aerobaticAero` (autorotation, figure judging) | `src/flight/aerobaticAero.js` |
| manoeuvre recognizer (pure) | `src/flight/maneuverRecognizer.js` |
| smoke ribbon | `src/render/smokeRibbon.js` |
| audio family `aerobaticProp` | `src/audio/engines/aerobaticProp.js` |
| instruments `smoke`, `figure` | `src/ui/instruments/smoke.js`, `figure.js` |
| lab | `node --expose-gc tools/lab/aerobatic.mjs` |
| `?test=craft` scenarios | `src/dev/craftScenarios/aerobatic.js` |

## Flight model

SimFixedWing flies the airframe under its own model kind, `aerobatic`, so it gets its own assists (like
the jet). Measured by the lab:

| target | value |
| --- | --- |
| stall speed, power off | 30.5 m/s upright, the same inverted (symmetric section, zero incidence) |
| roll rate, full aileron at 80 m/s | about 400 deg/s both ways |
| cruise at 75 % power | 85 m/s; full power stays under Vne (113 m/s) |
| climb, full power at 55 m/s | about 16 m/s |
| load envelope | +9.6 / -8.7 g at the edge of the stall at 100 m/s (gLimit 10) |
| prop hang | static thrust over weight (about 1.1 : 1 at 1500 m): climbs from a standstill on the prop and torque-rolls left |
| snap roll | a sharp pull with full rudder at 68 m/s stalls one wing: about 400 deg/s of autorotation, stopped by forward stick and opposite rudder |
| knife-edge | 90 degrees of bank held on the rudder at 85 m/s within 20 m of height, about 20 degrees of sideslip |

The two wing panels a side resolve the spanwise stall too coarsely to reverse the roll damping the way a
stalled wing does, so the extension adds that reversal past the critical angle of attack
(`simProfile.autorotation`); it vanishes as soon as the angle of attack is back under the stall.

## Assists

No attitude protection at any level: loops, rolls and inverted flight stay possible at 100 %.

| level | assists |
| --- | --- |
| 0 -> 50 % | auto-coordination and a yaw damper (both yield to the pedals), auto-trim (follows a gentle stick in near-level flight; hands off near wings level it holds the flight path within +-5 degrees), stall warning |
| 50 -> 100 % | AoA limiter (both signs), G limiter (+8.5 / -6 g), auto-level when every axis is hands off (an inverted craft rolls back upright), overspeed protection (power back near Vne) |
| 0 % | raw physics: snap rolls, spins, tumbles |

The limiters set an elevator ceiling from the steady elevator that holds each limit (per rad of angle of
attack and per unit of pitch rate over airspeed, with the load per rad measured in flight), damped by the
rate toward the limit, so the servo's lag cannot set up a hunt.

## Figures

The recognizer runs on the 120 Hz flight clock inside the extension. A figure is everything flown between
two stretches of straight, wings-level upright flight (0.5 s before, 0.75 s after); it is classified from
the integrated body rotations (pitch, roll, yaw), the order of its markers (vertical up, vertical down,
inverted at the horizon, tailslide, snap autorotation, tumble) and the heading and height change, then
scored 0-100 for precision. The knife-edge and inverted passes are held states (3 s or more).

| figure | recognized when | scored on |
| --- | --- | --- |
| loop | 290-430 degrees of pitch, up then over the top then down, no net roll, out on the entry heading | heading and height at the exit, roundness (height against length), roll drift |
| aileron roll | one to three full rolls, nose near the horizon, under 4 s plus 2 s a roll | heading and height held, nose on the horizon, an even roll rate, a crisp stop |
| barrel roll | a full roll with 90-450 degrees of pitch, inverted on the way, positive g, entry heading | heading, height, the roll's stop, positive g |
| Immelmann | half a loop up then half a roll, out reversed and higher | reversal, the half roll, the half loop |
| split-S | half a roll to inverted then half a loop down, out reversed and lower | the same |
| Cuban eight | two loops' worth of pitch with two half rolls (two tops), entry heading | heading, height, symmetry of the two lobes |
| hammerhead | up and down vertical lines with a 120-degree or more yaw pivot between, out reversed | vertical lines, a slow pivot, roll drift |
| knife-edge pass | 3 s or more at 72-108 degrees of bank, height held (nose up to 32 degrees) | height, heading, bank, length |
| inverted pass | 3 s or more upside down, height held | height, heading, bank, length |
| snap roll | a stalled autorotation of 250-470 degrees in under 5 s, no vertical | heading, height, the stop |
| tailslide | a vertical line up, sinking tail first for 0.4 s, then down | the vertical line, the slide, the exit heading |
| lomcevak | a stalled tumble of fast pitch and yaw (360 degrees or more of them), only at assists of 25 % or less | height lost, rotation |

Each figure emits the typed event `figureFlown { figure, score, craft, position }`, a toast
("Loop: 86 points") and a `journalStat` with the figure's best score (`aerobaticLoop`,
`aerobaticAileronRoll`, ... op `max`, unit `points`; the module's `journal.stats`). `state.flight.craftState`
carries `figureInProgress` (the recognizer's live guess) and `lastFigure { figure, score }`.

## Smoke

Space switches the smoke, Shift+Space cycles its colour through `SMOKE_COLORS` (white, red, blue, yellow,
green, orange). The ribbon is one pooled mesh of 1024 samples (a ring) laid from the pipe under the tail:
sunlit, facing the camera, drifting with the wind and widening as it fades over 30 s; its float32 positions
are relative to an anchor that follows the craft every 2 km. Puffs stream at the nozzle on top of it. The
audio adds a smoke hiss over the prop snarl.

## Controls

| action | keyboard | gamepad (standard) | T.16000M | TWCS |
| --- | --- | --- | --- | --- |
| smoke on / off (`craftAbility`) | Space | A (button 0) | button 1 | |
| smoke colour (`craftAbilityAlt`) | Shift+Space | X (button 2, the gear button: fixed gear) | button 4 (the gear button) | button 10 |

The craft's `bindings` unbind `gearToggle` on the gamepad and the T.16000M (fixed gear) and give those
buttons the colour cycle. Every other control is the fixed-wing default.

## Copilot

| command | phrases (examples) | reply |
| --- | --- | --- |
| `smoke` | "smoke on", "stop the smoke" | "Smoke on, white." |
| `smokeColor` | "red smoke", "smoke colour blue", "next colour" | "Smoke colour red." |
| `lastFigure` | "how was that loop", "my last figure", "figure score" | the figure, its score and a verdict |
| `figures` | "what figures can I fly", "list the figures" | the twelve figures |

"Systems check" speaks the smoke, the last figure, a figure in progress and the load factor.

## Placement after a switch (`situate`)

On the ground (the nearest flat spot) when the previous craft stood on dry ground; otherwise flying on at
55-85 m/s on the old heading, climbing 10 degrees at full power when under 150 m.
