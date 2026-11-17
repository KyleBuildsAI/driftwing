# DRIFTWING controls

Every named action can be rebound on every device, the keyboard included, in the controls panel
(`.` or the `controlsPanel` action). Bindings are a global profile plus optional per-craft
overrides. They, and each controller's calibration, are saved in V2's own IndexedDB database
(`driftwing-v2`) for `http://127.0.0.1:5199` and survive restarts. V1, the original game, keeps its
own settings and never sees these. **Export** / **Import** in the panel move them as
JSON. The defaults below come from `src/input/defaultBindings.js`; the help panel (`H`) lists the
live keyboard bindings, so it follows any rebinds.

> **Keep pedals centered and feet off when plugging in.** Until the calibration wizard has learned
> them, the toe brakes read as released in whatever position they rest when the throttle first
> appears.

## One flight model, one key layer

V2 always flies the real flight model; the assists slider in Settings (0-100 % per craft) is the
only difficulty control. There is one keyboard layer. It keeps v1's keys where they do not collide
and changes these:

- G is the landing gear (the waypoint moves to N);
- C cycles the view (Enter and / open the command bar);
- V swaps between first and third person; v1's V (WREN voice on / off) is **Shift+V**;
- M opens the world map; v1's M (talk to WREN) is **Shift+M**;
- Space is the craft ability;
- W / S move the throttle lever;
- the captured mouse is a free virtual stick.

## Views

Every craft can be flown from outside or from the pilot's seat, and the view never changes how it
flies: the same inputs give the same flight in every view.

- **First person** is the pilot's seat: the cockpit with its instrument panel, the seaplane's and
  the tiltrotor's cabins, the airship's gondola, the balloon's basket and the paraglider's harness
  (each with a small panel). On the FPV drone it is the drone's FPV camera, on the wingsuit the view
  from the helmet, and on the eagle / dragon the view from the creature's head over its beak or
  snout.
- **Third person** is the chase camera (the v1 camera: it lags a little, follows part of the bank
  and widens with speed), the wing camera and the flyby camera.
- **C** (`viewCycle`) steps through chase, cockpit, wing and flyby.
- **V** (`viewToggle1P3P`) swaps at once between the cockpit and the last third-person view you
  used on that craft.
- Numpad 8 / Numpad 2 (the stick hat up / down) jump to the cockpit / the chase view, and
  Numpad 4 / 6 (hat left / right) look 90 degrees to the side.
- Each craft remembers its own view. The first launch opens in the chase view.
- `viewToggle1P3P` is bindable like every action. Its defaults are **V**, the gamepad **View**
  button and **TWCS button 8**.

Outside views show the glass HUD: airspeed, altitude and vertical speed, the compass heading, a
small attitude indicator, the throttle, and a stall / AoA warning (a low-rotor-rpm warning on the
helicopter). The flight path marker, a circle with wings, sits where the craft is really going
through the air; the gold nose mark next to it is where the nose points. Sideslip moves the marker
sideways from the nose mark, and angle of attack moves it down. In the cockpit the instrument panel
does the job and the glass HUD is off unless you turn it on (Settings, Flight: "Glass HUD in the
cockpit"); the FPV camera, the wingsuit and the eagle / dragon keep the glass HUD, since they
have no panel. Units follow the Units setting.

## Switching to V1

DRIFTWING is two games behind the launcher at `http://127.0.0.1:5199`: V1, the original, and V2,
this game. The **V1 | V2** pill in the top-left corner switches in both directions. It hides after
a few seconds; move the pointer to the top-left corner to bring it back. From V2 you can also press
**F8** (the bindable `versionToggle` action), press **T.16000M base button 10**, or ask WREN to
"switch to version one". V1 is the untouched original, so from V1 the pill is the only way back.
`/?v=1` and `/?v=2` open a game directly.

## Keyboard

| action | key |
| --- | --- |
| Pitch (nose up / down) | Up / Down arrows |
| Roll | A / D, Left / Right arrows |
| Rudder (yaw) | Q / E |
| Throttle | W / S move the lever (50% per second) |
| Craft ability | Space |
| Second craft ability (craftAbilityAlt; the aerobatic's smoke colour, the balloon's vent, the eagle's tuck, the spaceplane's attitude hold; B too on the balloon and the eagle) | Shift+Space |
| Pitch trim | Home / End (40% per second) |
| Waypoint 1.5 km ahead | N |
| Waypoint to the nearest landmark | Shift+N |
| Landing gear | G |
| Flaps down / up | F / Shift+F |
| Airbrake / spoilers (hold; wheel brakes on the ground) | B |
| Cycle view | C |
| First / third person (cockpit and the last outside view) | V |
| View forward (cockpit) / back (chase) | Numpad 8 / Numpad 2 |
| Look left / right 90 deg | Numpad 4 / Numpad 6 |
| Recenter view | Numpad 5 |
| Craft favorites 1-10 (craftSelect1-10; by default glider, bush plane, jet, helicopter, wingsuit, FPV drone, aerobatic, seaplane, eagle, spaceplane; assign them in the craft picker's roster: the grid button at the end of the picker, or right-click a craft, then drag a craft onto a number or pick its key) | 1-9, 0 |
| Next / previous favorite (skips empty slots and craft not installed yet) | ] / [ |
| Autopilot | O |
| Time of day forward / back | T / Shift+T |
| Ring course | R |
| Start / cancel the nearest challenge (challengeStart; no gamepad or HOTAS default) | Y |
| Journal | J |
| World map (mapToggle) | M |
| Photo mode | P |
| Settings | , (comma) |
| Controls panel | . (period) |
| Switch to V1 (versionToggle; in the launcher shell it asks the shell, at /v2/ it opens /?v=1) | F8 |
| Relaunch | Backspace |
| Engine on / off | Z |
| Deploy parachute | U |
| Copilot push-to-talk (hold) | ` (backquote) |

UI keys are not rebindable:

- **Shift+M**: talk to WREN (mic on / off).
- **Enter** or **/**: type to WREN.
- **H** or **?**: help.
- **Esc**: close a panel or leave photo mode.
- **X**: clear the waypoint.
- **K**: capture a photo.
- **I**: fps and stats.
- **Shift+V**: WREN voice on / off.
- **Tab**: hide or show the HUD.

WREN's tour guide has no keys of its own: its commands are the "Guide" chips in the command bar
(Enter or **/**): What's nearby, To [a nearby event or discovered site], Find a thermal, Find water,
Find a perch (on the eagle), To space (on the spaceplane), Chase the storm and Next discovery, plus
**Yes, heading** / **No thanks** while a callout offer is open. Say or type the same phrases, or
"guide help" for the list. [Copilot phrases](#copilot-phrases-and-their-keyboard-and-ui-equivalents)
below pairs the cross-craft phrases with their keys, and docs/copilot-api.md has them all.

If you bind one of these keys to an action, the action wins and the panel warns about the conflict.

Developer keys (dev builds only; never player features):

- **F9**: the spawn debugger (dev builds, or a production build opened with `?dev=1`). F9 opens it
  and moves the keyboard focus into it, so keys typed there stay in the panel; F9 or **Esc** closes
  it and hands the focus back. While it is closed it listens to F9 alone and never takes a flight
  key. It lists the presets with filters, force-spawns any of them ahead of the craft, teleports to
  the nearest site of a preset, scrubs the time of day, and shows the director's state, the active
  spawns, the engine stats and the wind overlay switch.
- **L**: drop or remove the debug updraft (dev builds and `?debug=1`).

In photo mode only photo mode, time of day, push-to-talk and the UI keys above work. WASD, Q / E,
the arrows, Shift, the mouse and the wheel drive the free camera (v1).

## What the controls mean for each craft

The same ControlState drives every craft; each craft's input profile decides what an axis means.

| craft | throttle axis | Space (craft ability) | Shift+Space (second ability) | other notes |
| --- | --- | --- | --- | --- |
| Glider | none (no engine) | dump water ballast | none | the airbrake and both toe brakes open the spoilers in the air; toe brakes brake the wheel on the ground |
| Bush plane | throttle | smoke trail | none | 3 flap notches; toe brakes are wheel brakes, the rudder steers the tail wheel |
| Jet | throttle, with the afterburner past the detent | afterburner (pushes the lever through the detent; pulling back cancels) | none | G raises and lowers the gear; 2 flap notches; the keyboard lever stops at the detent, a HOTAS lever passes it with a click |
| Helicopter | collective | hover hold (locks position, height and heading; the stick moves the hold point) | none | at 100 % assists the lever is a climb / descend command around its centre; Z cuts the engine for autorotation practice |
| Wingsuit | none | deploy the parachute (U does too) | none | under the canopy, stick roll, the rudder pedals and the toe brakes are the steering toggles; pull back to flare |
| FPV drone | thrust | rate / angle mode (turtle mode when it lies upside down) | none | Z arms and disarms; at high assists the throttle asks for a climb rate around its centre (altitude hold) |
| Aerobatic | throttle | display smoke on / off | the next smoke colour (white, red, blue, yellow, green, orange; gamepad X, T.16000M base button 5) | fixed gear and no flaps; toe brakes are wheel brakes and the rudder steers the tail wheel; no attitude protection at any assist level. WREN names and scores the figures you fly: loop, aileron roll, barrel roll, Immelmann, split-S, Cuban eight, hammerhead, knife-edge pass, inverted pass, snap roll, tailslide and, at assists of 25 % or less, the lomcevak. Start each from straight and level flight and finish level |
| Seaplane | throttle | water rudders up / down (TWCS button 6 too) | none | G raises and lowers the amphibian wheels, on the water as well (up for water, down for a runway: wheels down in the water nose it over, wheels up on land skid the floats, and WREN warns on the approach); on the water the pedals and the differential toe brakes steer the water rudders; 3 flap notches; above 50 % assists the water assist holds the planing trim |
| Tiltrotor | thrust control lever (the proprotors' collective) | auto-nacelle schedule on / off (keeps the nacelles inside the conversion corridor) | none | F / Page Up tilt the nacelles up one detent (0, 60, 90, then the 97 degree stop), Shift+F / Page Down tilt them forward one (gamepad D-pad down / up, T.16000M flap buttons); the TWCS antenna sets the angle directly (0 airplane mode to full at 97, detents at 0, 60 and 90). In the hover the stick is cyclic and differential collective and the pedals differential cyclic; in airplane mode the flaperons, elevator and rudders. On the wheels the nacelles stop at 60 degrees. At 100 % assists the lever is a climb / descend command around its centre in the hover; G raises the gear |
| Paraglider | speed bar (0 = hands-up trim) | big ears while held (TWCS button 5 too) | none | the toe brakes are the left and right brakes, and the pedals or Q / E a differential pair; the stick pulled back (Up arrow) pulls both brakes and pushed forward (Down arrow) the speed bar; stick X shifts your weight; B (the airbrake) latches the big ears in or out. No engine, flaps, gear or reserve: those keys say so. On the ground push forward (or say "launch") to inflate the wing and run; after a water landing the pilot is carried to a launch slope after 3 s. Gamepad: LT / RT are the brakes and RB / LB move the speed bar |
| Hot air balloon | burner valve (a lever left open by another craft lights nothing until you move it) | full burner while held (a tap burns 1.2 s) | parachute vent while held (a tap vents 1 s; B too; gamepad B; TWCS button 2; T.16000M base button 5) | stick X and the pedals turn the basket with the rotation vents; the envelope answers a burn in 20-30 s. The wind-layer column on the HUD shows the wind at nine heights from 40 m to 2 km above the ground: climb or sink to the layer that goes your way. At 100 % assists the auto-burner holds the height where you leave the burner and vent alone and protects the envelope's red line (50 %: the protection and rotation damping only). O flies the autopilot's altitude. On the ground a held vent deflates the envelope and the burner inflates it again |
| Airship | both props | scenic cruise on / off (the autopilot tours the next three sites nearby and plans more; the stick or O hands the controls back) | none | the stick's Y axis works the elevators; stick X and the pedals work the rudders, the props' differential thrust and the stern thruster (an airship cannot roll); Home / End (the rocker) swivel both pods from 45 degrees down through forward to 120 up (gamepad B up, X down); F / Shift+F held (the antenna, or the flap buttons held) fill or empty the ballonets: full is heavy, half neutral, empty light, and the blowers take their time. Z starts and stops the engines |
| Eagle / Dragon | flap power (0 = glide) | eagle: screech; dragon: fire breath while held (a press gives a short burst) | tuck the wings while held (B too; gamepad X; T.16000M base button 5; TWCS button 10) | the stick twists the wings and pitches body and tail, the pedals twist the tail; push hard or hold the tuck to fold the wings into a stoop. Fly slowly (under about 43 km/h) at a tree top, a ledge or a peak and it lands there by itself; on the perch the stick or pedals turn it on the spot and raising the flap power takes off. The skin is chosen in the picker |
| Spaceplane | rocket thrust (no idle: 0 is the engine off) | auto re-entry arm / disarm (40 degrees nose up, belly first, on the way down) | attitude hold on / off (hands off holds the attitude at any assist level; gamepad L3; T.16000M base button 14) | the stick and pedals fly the elevons and the rudder in the air and fire the RCS jets as the air thins; B opens the split rudder as a speed brake; G cycles the gear; toe brakes are wheel brakes. From 50 % assists the stick commands body rates and auto re-entry arms itself on a descent from space |

Each craft's full set of keys, gamepad buttons and HOTAS inputs is in
[Craft profiles](#craft-profiles-the-phase-3-craft) below.

## World map

**M** (the bindable `mapToggle` action; TWCS button 9; the map button in the top bar, or Map in the
touch menu) opens the world map over the flight, which carries on behind it. It shows the terrain in
shaded relief, the sites and landmarks you have discovered (never the ones you have not), this
flight's trail, your craft and its heading, and the waypoint.

| input | on the map |
| --- | --- |
| Click or tap | set the waypoint there (on a site's icon: at the site, named after it) |
| Drag | pan |
| Wheel, pinch, + / − buttons | zoom |
| Arrow keys (map focused) | pan |
| + / − (map focused) | zoom |
| 0 (map focused), the follow button | follow the craft again |
| Enter (map focused) | set the waypoint at the centre |
| M, Esc | close the map |

The map keys stay in the map while it has the focus; every other key still flies the craft. The
standard gamepad and the T.16000M have no free button, so bind `mapToggle` there in the controls
panel if you want it.

## Discoveries, the journal and seed links

Spawns need no input of their own: fly toward something on the horizon and it is yours. When a
spawn comes within its discovery range and into view, a chime plays and a glass card shows its
name, category and one-liner. Nothing else changes; there is nothing to press.

- **J** (`journal`) opens the journal: this world's discoveries (found / 100), and the records
  shared by every world: storms chased, the closest tornado, the best canyon run and landing, the
  highest altitude, the flight time per craft, the aerobatic figures, the challenges' best times and
  medals per course and craft, the worlds visited and the perches, plus the achievements.
- **WREN's tour guide** answers the Guide chips in the command bar (above), and when it calls a
  spawn out, "yes" (or the **Yes, heading** chip) places a waypoint on it. **X** clears a waypoint.
- **Copy link** copies a link to this world at this time of day (`/?v=2#seed=ABC&t=0.723`), which
  opens in the launcher with V2. It is on the seed chip in the HUD, on the world map, in Settings
  (General, World) and in the menu. Settings, General, World also takes a seed ("Fly a specific seed"):
  **Fly** reloads into that world. The world you fly is remembered for next time.

## Copilot phrases and their keyboard and UI equivalents

WREN understands these across every craft (say them with push-to-talk, or type them after Enter or
**/**). Each has a key, a button or a chip that does the same thing:

| phrase | what WREN does | keyboard / UI equivalent |
| --- | --- | --- |
| "switch to [craft]" | switches craft: any of the 14 by name, and the skins by name ("dragon") | favorites 1-9 and 0, `]` / `[`, the craft picker |
| "smoke on" / "smoke off" | the aerobatic's (and the bush plane's) display smoke | Space on the aerobatic and the bush plane; Shift+Space cycles the aerobatic's colour |
| "find water to land" | a waypoint to the nearest landable water (a lake, or the ocean's coast) | the Guide chip "Find water", the world map |
| "find a perch" | a waypoint to the nearest perch | the Guide chip "Find a perch" (on the eagle) |
| "wind at [altitude]" | the wind at that height, spoken | the balloon's wind-layer column on the HUD |
| "start the challenge" | starts the nearest challenge course | Y, the start prompt |
| "take me to space" | the spaceplane's climb-to-space autopilot (it switches to the spaceplane first, after a confirm) | the Guide chip "To space" on the spaceplane |
| "scenic cruise" | the airship's scenic cruise | Space on the airship |

Each craft also has its own commands (the seaplane's "water rudders down", the tiltrotor's
"nacelles to 60", the balloon's "burn for 5 seconds", the eagle's "take off" and so on), and
"systems check" or "craft status" reads the craft's state aloud; docs/copilot-api.md lists them.

## Mouse

| input | action |
| --- | --- |
| Click the view | captures the mouse (pointer lock); drag instead where capture is blocked |
| Move (captured) | virtual stick that stays put: its offset from the screen centre is the stick deflection (a gold dot shows it) |
| Drag (not captured) | drag-to-steer, springs back on release |
| Wheel | throttle lever in 5% steps |
| Right-drag | free look; release returns to centre |
| Middle click | recenter view |

## Touch

The on-screen virtual stick (left side: roll and pitch, with v1's mild expo) and the throttle
slider (right side) write the same ControlState as every other device, so every craft flies on a
phone. The mic talks to WREN and the menu opens the settings, where the Controls tab leads to the
controls panel.

## Standard gamepad (Xbox-style, "standard" mapping)

| input | action |
| --- | --- |
| Left stick | roll / pitch (pull back = nose up) |
| RB / LB | rudder right / left |
| RT / LT | throttle up / down (60% per second, analog) |
| Right stick | free look (returns to centre) |
| R3 (right stick click) | recenter view |
| A | craft ability |
| B | airbrake (hold) |
| X | landing gear |
| Y | cycle view |
| D-pad up / down | flaps up / down |
| D-pad left / right | previous / next favorite |
| View (back) | first / third person |
| Menu (start) | settings |
| L3 (left stick click) | waypoint to nearest landmark |

Every button is taken, so the second craft ability (`craftAbilityAlt`), the ten favorites
(`craftSelect1-10`) and the challenge start (`challengeStart`) have no global gamepad default: bind
them in the controls panel. The D-pad cycles the favorites. Some craft lend a button they have no
use for: the aerobatic and the eagle put their second ability on X (the gear), the balloon on B
(the airbrake) and the spaceplane on L3 (the landmark waypoint); the airship swivels its pods on B
and X; the paraglider's triggers are its brakes and its bumpers the speed bar
([Craft profiles](#craft-profiles-the-phase-3-craft)).

## HOTAS: Thrustmaster T.16000M FCS Flight Pack

The browser sees two devices: the **T.16000M stick** and the **TWCS throttle**. The TFRP pedals
plug into the TWCS and appear as its axes. Devices are recognised by the USB vendor / product id
in the browser's gamepad id, or by the names "T.16000M" / "TWCS", and never by slot order. The ids
are Thrustmaster `044f` with T.16000M `b10a`, TWCS `b687` and TFRP `b679`. These are the published
ids and still need confirming on real hardware: run with `?debug=1` and the ids the browser
reports are logged once to the console.

Browsers only show a controller after one of its buttons is pressed on the page. Until both have
appeared, the controls panel says "Press any button on your stick and throttle".

Button numbers below are Windows' 1-based numbers (the Gamepad API index is one less). They are
the best published layout. If your hardware reports them differently, rebind in the controls panel.

### Stick (T.16000M)

| input | action |
| --- | --- |
| X / Y | roll / pitch (helicopter: cyclic) |
| Twist | rudder, only until the pedals move (setting "Stick twist yaw": auto / on / off) |
| Throttle slider | throttle, ignored while a TWCS is connected |
| Trigger (1, hold) | copilot push-to-talk |
| Head button 2 | craft ability |
| Head button 3 | waypoint to nearest landmark |
| Head button 4 | photo mode |
| Hat up / down | view forward (cockpit) / chase |
| Hat left / right | look left / right 90 deg |
| Base 5 / 6 / 7 | landing gear / flaps up / flaps down |
| Base 8 / 9 | previous / next favorite |
| Base 10 | switch to V1 (versionToggle) |
| Base 11 | autopilot |
| Base 12 / 13 | time of day forward / back |
| Base 14 | ring course |
| Base 15 | journal |
| Base 16 | settings |

### Throttle (TWCS) and pedals (TFRP)

| input | action |
| --- | --- |
| Throttle | throttle (helicopter: collective; drone: thrust; and per craft: the tiltrotor's thrust lever, the paraglider's speed bar, the balloon's burner, the eagle's flap power, the spaceplane's rocket). Its direction is learned in calibration. The afterburner detent sits at the "Afterburner detent" setting (95% by default) |
| Pedal rudder | yaw (helicopter: anti-torque); disables twist yaw once moved |
| Left / right toe brake | wheel brakes (both), differential ground steering, airbrake in the air |
| Rocker | pitch trim (spring-centred: hold it to move the trim); the pod vector on the airship; the trimmers on the paraglider |
| Antenna slider | flaps with notch hysteresis on fixed-wing craft; FOV zoom (up to 3x) on the helicopter, drone, wingsuit, paraglider and eagle; the nacelle angle on the tiltrotor (takes over when it moves); the ballonet trim on the airship |
| Mini-stick | free look (absolute angle; releasing returns to centre) |
| Mini-stick click (1) | recenter view |
| Button 2 | airbrake (hold) |
| Button 3 | cycle view |
| Button 4 | relaunch |
| Button 5 | engine on / off |
| Button 6 | deploy parachute |
| Button 7 | controls panel |
| Button 8 | first / third person |
| Button 9 | world map |
| Button 10 | second craft ability (craftAbilityAlt) |
| Throttle hat | unbound (reserved for music controls in a later phase) |

TFRP pedals on their own USB lead (normally they come through the TWCS) default to rudder and toe
brakes in the same way.

### Unplugging mid-flight

If a controller that is flying the craft disconnects in flight, the assists take over hands-off at
100 %: wings level, heading and altitude held, with a toast. Control comes back when that device
reconnects, or as soon as another device holds the stick past about a third of its travel for a
quarter of a second.

## Craft profiles: the Phase 3 craft

The eight craft of Phase 3 keep the global bindings above and change only what each one needs:
their input profile gives the shared axes a meaning (`inputProfile` in each `src/craft/<id>.js`),
and a few override single buttons for that craft alone (the module's `bindings`, which sit between
your own bindings and the device defaults). A rebind in the controls panel can be global or for one
craft. Every table lists the full T.16000M FCS profile (stick, TWCS throttle and TFRP pedals) with
the keyboard and standard gamepad equivalents; "none" means the input does nothing on that craft.
The view, photo, map, journal, settings, favorites, time-of-day, waypoint, autopilot, relaunch and
copilot inputs are the same on every craft (the HOTAS tables above).

### Aerobatic

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Ailerons / elevator | stick X / Y | A / D or Left / Right, Up / Down | left stick |
| Rudder (the tail wheel on the ground) | pedals (the twist until they move) | Q / E | RB / LB |
| Engine power | TWCS throttle | W / S | RT / LT |
| Pitch trim | rocker | Home / End | none |
| Wheel brakes (differential steering) | toe brakes | B (both, hold) | B (both, hold) |
| Display smoke on / off | head button 2 | Space | A |
| Next smoke colour | TWCS button 10, stick base button 5 (the gear's button on other craft) | Shift+Space | X (the gear's button on other craft) |
| Engine on / off | TWCS button 5 | Z | none |
| Antenna, flaps and gear | none: no flaps, fixed gear | none | none |

### Seaplane

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Ailerons / elevator | stick X / Y | A / D or Left / Right, Up / Down | left stick |
| Rudder; on the water the water rudders (when down) | pedals (the twist until they move) | Q / E | RB / LB |
| On the water: differential water-rudder steering; on land: the main-wheel brakes | toe brakes | B (both, hold) | B (both, hold) |
| Engine power | TWCS throttle | W / S | RT / LT |
| Pitch trim | rocker | Home / End | none |
| Flaps, 3 notches | antenna (notches with hysteresis), stick base buttons 6 (up) / 7 (down) | Shift+F / F | D-pad up / down |
| Amphibian wheels up / down (on the water too) | stick base button 5 | G | X |
| Water rudders up / down | head button 2, TWCS button 6 (the parachute's button on other craft) | Space | A |
| Engine on / off | TWCS button 5 | Z | none |

### Tiltrotor

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Hover: cyclic and differential collective; airplane mode: flaperons and elevator | stick X / Y | A / D or Left / Right, Up / Down | left stick |
| Hover: differential cyclic; airplane mode: rudders | pedals (the twist until they move) | Q / E | RB / LB |
| Thrust control lever (the proprotors' collective) | TWCS throttle | W / S | RT / LT |
| Nacelle angle (0 airplane mode to the 97 degree stop; detents at 0, 60 and 90) | antenna (sets the angle directly) | none | none |
| Nacelles up / forward one detent | stick base buttons 7 (up) / 6 (forward) | F or Page Up / Shift+F or Page Down | D-pad down / up |
| Auto-nacelle schedule on / off | head button 2 | Space | A |
| Pitch trim | rocker | Home / End | none |
| Wheel brakes | toe brakes | B (both, hold) | B (both, hold) |
| Gear | stick base button 5 | G | X |
| Engines on / off | TWCS button 5 | Z | none |

### Paraglider

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Weight shift | stick X | A / D or Left / Right | left stick X |
| Both brakes (pulled back) / the speed bar (pushed forward); on the ground, pushed forward to launch | stick Y | Up / Down | left stick Y |
| Left / right brake | toe brakes; the pedals as a differential pair (the twist until they move) | Q / E (a differential pair) | LT / RT |
| Speed bar | TWCS throttle; the rocker pushed forward releases the trimmers (more bar) | W / S; End releases the trimmers | RB / LB |
| Big ears (held) | head button 2, TWCS button 5 (the engine's button on other craft) | Space | A |
| Big ears latched in / out | TWCS button 2 (the airbrake) | B | B |
| Lens zoom (up to 3x) | antenna | none | none |
| Flaps, gear, engine, reserve | none (WREN says why) | none | none |

### Hot air balloon

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Burner valve | TWCS throttle (the stick's slider without a TWCS) | W / S | RT / LT |
| Full burner (held; a tap burns 1.2 s) | head button 2 | Space | A |
| Parachute vent (held; a tap vents 1 s) | TWCS button 10, TWCS button 2 (the airbrake), stick base button 5 (the gear) | Shift+Space, B | B |
| Rotation vents (turn the basket) | stick X and the pedals (the twist until they move) | A / D or Left / Right, Q / E | left stick X, RB / LB |
| Stick Y, toe brakes, rocker, antenna, flaps | none | none | none |

### Airship

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Elevators | stick Y | Up / Down | left stick Y |
| Rudders, differential thrust and the stern thruster | stick X and the pedals (the twist until they move) | A / D or Left / Right, Q / E | left stick X, RB / LB |
| Both props | TWCS throttle | W / S | RT / LT |
| Pod vector, 45 degrees down to 120 up (moves the angle; it snaps at the stops) | rocker | Home (up) / End (down) | B (up) / X (down) |
| Ballonet trim: fill (heavy) / empty (light), half is neutral | antenna, or stick base buttons 7 (fill) / 6 (empty) held | F (fill) / Shift+F (empty) held | D-pad down (fill) / up (empty) held |
| Scenic cruise on / off | head button 2 | Space | A |
| Engines on / off | TWCS button 5 | Z | none |
| Toe brakes, gear, airbrake | none | none | none |

### Eagle / Dragon

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Wing twist (roll) | stick X | A / D or Left / Right | left stick X |
| Body and tail pitch; pushed hard, the stoop | stick Y | Up / Down | left stick Y |
| Tail twist (yaw); on a perch, turn on the spot | pedals (the twist until they move) | Q / E | RB / LB |
| Flap power (0 = glide; raised on a perch, take off) | TWCS throttle | W / S | RT / LT |
| Eagle: screech; dragon: fire breath (held) | head button 2 | Space | A |
| Tuck the wings (held) | TWCS button 10, stick base button 5 (the gear) | Shift+Space, B | X (the gear) |
| Lens zoom (up to 3x) | antenna | none | none |
| Toe brakes, rocker, flaps, gear | none (WREN says why for the flaps and gear) | none | none |

### Spaceplane

| control | T.16000M FCS | keyboard | gamepad |
| --- | --- | --- | --- |
| Elevons; the pitch and roll jets as the air thins | stick X / Y | A / D or Left / Right, Up / Down | left stick |
| Rudder; the yaw jets as the air thins | pedals (the twist until they move) | Q / E | RB / LB |
| Rocket thrust (no idle: 0 is the engine off) | TWCS throttle | W / S | RT / LT |
| Pitch trim | rocker | Home / End | none |
| Speed brake (the split rudder, held) | TWCS button 2; both toe brakes in the air | B | B |
| Wheel brakes (on the ground) | toe brakes | B (both, hold) | B (both, hold) |
| Gear | stick base button 5 | G | X |
| Auto re-entry arm / disarm | head button 2 | Space | A |
| Attitude hold on / off | TWCS button 10, stick base button 14 (the ring course's button on other craft) | Shift+Space | L3 (the landmark waypoint's button on other craft) |
| Engine on / off | TWCS button 5 | Z | none |

## Calibration wizard

Open the controls panel and choose **Calibrate** (or ask WREN to "calibrate controls"). With the
pedal note above in mind:

1. **Center everything**: let go of the stick, centre the mini-stick, rocker and twist, and keep
   your feet off the pedals. The wizard records each axis centre and finds hats that report as an
   axis.
2. **Move each axis lock to lock**: the stick in a full circle, the twist both ways, then the
   throttle, rocker, antenna, mini-stick and pedals. Each axis ticks off once it has covered its
   range.
3. **Throttle full forward**: push the throttle (and the stick's slider) fully forward and hold.
   This teaches which end is idle and which is full.
4. **Pedals**: full left, full right, then each toe brake all the way, pressing Next while holding
   each position. The rudder direction and brake travel are learned.
5. **Press each hat direction**: up, up-right, right ... up-left, releasing between presses. The
   wizard learns whether each hat reports as one axis or as buttons, and the value or button
   combination of every direction and of centre; nothing is hard-coded.

Back, Skip and Cancel work at every step. **Save calibration** stores the result under the
device's id, and it is restored whenever that device is plugged in again, in any slot.

## Per-axis tuning

Every controller axis goes through this pipeline:

1. calibration (centre, range, direction);
2. invert;
3. centre deadzone;
4. edge saturation;
5. expo curve;
6. light low-pass smoothing.

Each binding can override invert, deadzone, saturation, expo and smoothing (**Tune** in the
binding list shows the live response curve). The "Invert pitch" setting applies to the keyboard,
mouse and touch, as in v1; controllers use the per-binding invert instead.

A controller keeps its bindings and calibration when the browser gives it a different slot, even
mid-flight. Devices are matched by id, and a slot change is not a disconnect.

## Related settings

Settings (`,`) hold the input options that are not bindings:

- **Flight tab**: the assists slider for the current craft (100 % by default; the first HOTAS you
  connect sets 50 % on every craft whose assists you have not set yourself, once, with a toast),
  start on the ground, units and the HUD options: the glass HUD in the cockpit (off by default),
  the flight path marker (on by default), the instrument overlay, landing callouts and hiding the
  HUD when idle. It also holds the FPV drone's camera and stick settings (`settings.fpv`):
  - camera uptilt, 0-40 deg (default 25);
  - stick expo, 0-1 (default 0.3);
  - maximum rate in deg/s (default 670).
  They apply to the FPV drone only and take effect live.
- **Graphics tab**: the field of view per view, including the FPV lens (90-150 deg, default 120).
- **Controls tab**:
  - mouse sensitivity and invert pitch;
  - "Stick twist yaw" (auto / on / off);
  - the afterburner detent (80-100 %);
  - buttons that open the controls panel and the calibration wizard.
- **General tab**: day length and freezing time; WREN's voice, chatter, tour-guide callouts (on
  by default) and remote brain;
  the world (Copy link, and a seed field that reloads into another world); the developer status
  badge and wind arrows.

## HOTAS hardware checklist

A short checklist for the first session with the real T.16000M FCS Flight Pack:

1. **Plug in.** The pedals go into the TWCS's RJ12 port. Keep the pedals centred and your feet
   off them. Plug the TWCS and the stick into USB, then start `start-driftwing.bat`.
2. **Read the real ids.** Open `http://127.0.0.1:5199/?debug=1`, press a button on each device and
   open the browser console (F12). One `[DRIFTWING] gamepad seen: id=...` line per device shows
   the vendor, product, axis and button counts. If the product ids differ from `b10a` / `b687`,
   note them: devices are still found by name, but the known-devices table should be updated.
3. **Calibrate.** Open the controls panel (`.`, or TWCS button 7), wait for both status chips, and
   run the calibration wizard to the end. Check that the results screen shows both hats with 8 of
   8 directions learned, then Save.
4. **Fly each craft once** (the favorites 1-9 and 0, the craft picker, or stick base 8 / 9):
   - glider: spoilers on both toe brakes, trim on the rocker;
   - bush plane: flap notches on the antenna, and a take-off with toe-brake steering (turn on
     "Start on the ground");
   - jet: gear on base 5, and the afterburner detent;
   - helicopter: collective on the throttle, anti-torque on the pedals, hover hold on head
     button 2;
   - wingsuit: pull the chute (TWCS button 6) and steer the canopy with the pedals and toe brakes;
   - FPV drone: thrust on the throttle, and head button 2 for rate / angle mode;
   - aerobatic: a loop and an aileron roll with the smoke on (head button 2) and a colour change
     (TWCS button 10);
   - seaplane: water rudders on TWCS button 6, the toe brakes steering on the water, the wheels on
     base 5;
   - tiltrotor: the nacelles on the antenna through 0, 60 and 90, and the flap buttons stepping them;
   - paraglider: the brakes on the toe brakes, the speed bar on the throttle, big ears on TWCS
     button 5;
   - balloon: the burner on the throttle and head button 2, the vent on TWCS button 10 or 2;
   - airship: the pods on the rocker, the ballonets on the antenna;
   - eagle: flap power on the throttle, the tuck on TWCS button 10, a perch and a take-off;
   - spaceplane: full thrust to space, attitude hold on TWCS button 10, auto re-entry on head
     button 2.
5. **What to look for:**
   - **Hat snaps**: stick hat up gives the cockpit, down the chase view, left / right look 90 deg,
     with no stuck or phantom directions at centre. TWCS button 8 swaps between the cockpit and
     the last outside view.
   - **Twist hand-off to the pedals**: the twist yaws until the pedals first move, then only the
     pedals do.
   - **Afterburner detent click**: past the detent (95 %) you hear a click, the throttle gauge
     shows the AB lamp and the flame lights; back below it goes out.
   - **Hot-plug assists hold**: unplug the stick mid-flight. You get a toast, and the craft
     holds wings level and altitude. Replug it (press a button) and control returns with a
     "reconnected" toast.
   - The throttle reads 0 % at idle and 100 % fully forward, and no axis drifts at rest (bars at
     0 % in the controls panel).

## Actions

`copilotPTT, craftAbility, craftAbilityAlt, waypointNearest, waypointAhead, photoMode, viewCycle, viewToggle1P3P,
viewForward, viewBack, viewLeft, viewRight, recenterView, craftNext, craftPrev, craftSelect1-10,
gearToggle, flapsUp, flapsDown, airbrake, autopilotToggle, timeForward, timeBack, ringCourse, challengeStart,
journal, mapToggle, settings, controlsPanel, relaunch, engineToggle, chuteDeploy, versionToggle`. Each press
and release is published as `input:action { id, phase, source, device }`.

## For developers: the input system API

`ctx.systems.input` (src/input/InputManager.js) is what the controls panel, calibration wizard,
dev badge and touch controls build on:

| member | what |
| --- | --- |
| `getDevices()` | connected controllers: `{ deviceKey, kind, name, profile, vendor, product, known, confirmed, slot, id, axisCount, buttonCount, bindingDevice, hotas, calibrated, needsCalibration }` |
| `getConnectionState()` | `{ supported, devices, hotas: { stick, throttle, pedals, complete }, prompt, pedalNote }`; `prompt` is "Press any button on your stick and throttle" until both are seen |
| `readDevice(deviceKey)` | live readings for the panel: every axis (`raw`, calibrated `value`, `range`, `hat`), button (`pressed`, `value`) and hat (`learned`, decoded `direction`) with the device's own labels |
| `readKeyboard()`, `getStick()` | held key codes; the mouse virtual stick `{ x, y, locked, dragging, mode: 'spring' \| 'free', fullDeflectionPixels }` |
| `centerStick()` | puts the mouse virtual stick back to centre |
| `touch` | the on-screen controls: `setStick(x, y)` / `releaseStick()` (x right, y up, -1..1), `setThrottle(value)` / `releaseThrottle()` (0..1), `readStick()` |
| `getLastActivity()` | `performance.now()` of the last player input on any device (the HUD's auto-hide) |
| `getThrottleReading()`, `getTwistState()` | throttle with `afterburnerDetent` / `afterburner`; twist-yaw setting and pedal state |
| `bindings` | the binding store: `getRefs`, `sourceOf` ('craft' \| 'global' \| 'default'), `getEffective`, `getDefaultRefs`, `bind`, `unbind`, `updateRef` (axis tuning), `releaseInputs` (the "Replace" answer to a conflict), `clearOverride`, `resetToDefaults`, `findConflicts`, `conflictsFor`, `findAllConflicts`, `listDevices`, `exportJSON`, `importJSON`, `onChange` |
| `describeRef(ref, bindingDevice)` | short label of a binding ("Shift+F", "Trigger", "Hat 1 up") |
| `listen({ target, device })`, `bindByListening({ target, craft, device, replace })`, `cancelListen()`, `getListenState()`, `onListenChange()` | bind by listening: the next key, mouse button, controller button, learned hat direction or axis moved past half travel; Escape cancels. `device` may be one binding device, an array of them, or null |
| `startCalibration({ deviceKeys })`, `getCalibrationWizard()` | the wizard step machine: `getState()`, `next()`, `skip()`, `back()`, `cancel()`, `finish()`, `onChange()` |
| `calibration` | per-device records: `get`, `save`, `reset`, `keys`, `onChange` (stored as `driftwing-v2.input.calibration.<deviceKey>`) |
| `consumesKey(event)` | true when a keydown belongs to an input action (the UI leaves it alone) |
| `isPointerLocked()`, `readPhotoControls()` | pointer-lock state; the photo-mode free-camera input |
| `mock` | with `?test=hotas` or `?test=hotplug`: the scriptable mock devices from `src/dev/mockGamepads.js` (`plug`, `unplug`, `moveToSlot`, `setAxis`, `press`, `release`, `setButton`, `setHat`, `restAxes`, `get`, `list`) |

Fixed-wing models turn `ControlState.antenna` into flap notches with hysteresis (one notch
width at every notch); craft whose `inputProfile.antenna` is `'zoom'` use it for the lens instead.
