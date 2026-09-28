# DRIFTWING controls

Every named action can be rebound on every device, the keyboard included, in the controls panel
(`.` or the `controlsPanel` action). Bindings are a global profile plus optional per-craft
overrides. They, and each controller's calibration, are saved in the browser's IndexedDB for
`http://127.0.0.1:5199` and survive restarts. **Export** / **Import** in the panel move them as
JSON. The defaults below come from `src/input/defaultBindings.js`; the help panel (`H`) lists the
live keyboard bindings for the mode you are flying, so it follows any rebinds.

> **Keep pedals centered and feet off when plugging in.** Until the calibration wizard has learned
> them, the toe brakes read as released in whatever position they rest when the throttle first
> appears.

## Modes and layers

- **CLASSIC** plays exactly like v1: v1's keys, a mouse stick that springs back to centre, Space
  to boost and a double-tap on A or D to barrel-roll.
- **SIM** keeps every v1 key that does not collide and adds a SIM layer:
  - G is the landing gear (the waypoint moves to N);
  - C cycles the view (Enter and / still open the command bar);
  - Space is the craft ability;
  - W / S move the throttle lever;
  - the mouse becomes a free virtual stick.
- **V** switches CLASSIC / SIM in both modes. v1's V (WREN voice on / off) is now **Shift+V**.

## Keyboard

| action | CLASSIC | SIM |
| --- | --- | --- |
| Pitch (nose up / down) | Up / Down arrows | Up / Down arrows |
| Roll | A / D, Left / Right arrows | A / D, Left / Right arrows |
| Barrel roll | double-tap A or D | (off in SIM) |
| Rudder (yaw) | Q / E | Q / E |
| Throttle | W / S (v1 throttle up / down) | W / S move the lever (50% per second) |
| Fine control | hold Shift | hold Shift |
| Boost | Space | (off in SIM) |
| Craft ability | | Space |
| Pitch trim | Home / End | Home / End (40% per second) |
| Waypoint 1.5 km ahead | G | N |
| Waypoint to the nearest landmark | Shift+N | Shift+N |
| Landing gear | | G |
| Flaps down / up | F / Shift+F | F / Shift+F |
| Airbrake / spoilers (hold; wheel brakes on the ground) | B | B |
| Cycle view | | C |
| View forward (cockpit) / back (chase) | Numpad 8 / Numpad 2 | Numpad 8 / Numpad 2 |
| Look left / right 90 deg | Numpad 4 / Numpad 6 | Numpad 4 / Numpad 6 |
| Recenter view | Numpad 5 | Numpad 5 |
| Craft 1-6 (glider, bush plane, jet, helicopter, wingsuit, FPV drone) | 1-6 | 1-6 |
| Next / previous craft | ] / [ | ] / [ |
| CLASSIC / SIM | V | V |
| Autopilot | O | O |
| Time of day forward / back | T / Shift+T | T / Shift+T |
| Ring course | R | R |
| Journal | J | J |
| Photo mode | P | P |
| Settings | , (comma) | , (comma) |
| Controls panel | . (period) | . (period) |
| Relaunch | Backspace | Backspace |
| Engine on / off | Z | Z |
| Deploy parachute | U | U |
| Copilot push-to-talk (hold) | ` (backquote) | ` (backquote) |

UI keys are not rebindable and work the same in both modes unless noted:

- **M**: talk to WREN (mic on / off).
- **Enter** or **/**: type to WREN (**C** as well in CLASSIC).
- **H** or **?**: help.
- **Esc**: close a panel or leave photo mode.
- **X**: clear the waypoint.
- **K**: capture a photo.
- **I**: fps and stats.
- **Shift+V**: WREN voice on / off.
- **Tab**: hide or show the HUD.

If you bind one of these keys to an action, the action wins and the panel warns about the conflict.

In photo mode only photo mode, time of day, push-to-talk and the UI keys above work. WASD, Q / E,
the arrows, Shift, the mouse and the wheel drive the free camera (v1).

## What the controls mean for each craft

The same ControlState drives every craft; each craft's input profile decides what an axis means.

| craft | throttle axis | Space (SIM craft ability) | other notes |
| --- | --- | --- | --- |
| Glider | none in SIM (no engine; CLASSIC keeps v1's throttle) | dump water ballast | the airbrake and both toe brakes open the spoilers in the air; toe brakes brake the wheel on the ground |
| Bush plane | throttle | smoke trail | 3 flap notches; toe brakes are wheel brakes, the rudder steers the tail wheel |
| Jet | throttle, with the afterburner past the detent | afterburner (pushes the lever through the detent; pulling back cancels) | G raises and lowers the gear; 2 flap notches; the keyboard lever stops at the detent, a HOTAS lever passes it with a click |
| Helicopter | collective | hover hold (locks position, height and heading; the stick moves the hold point) | at 100 % assists the lever is a climb / descend command around its centre; Z cuts the engine for autorotation practice |
| Wingsuit | none | deploy the parachute (U does too) | under the canopy, stick roll, the rudder pedals and the toe brakes are the steering toggles; pull back to flare |
| FPV drone | thrust | rate / angle mode (turtle mode when it lies upside down) | Z arms and disarms; at high assists the throttle asks for a climb rate around its centre (altitude hold) |

In CLASSIC every craft flies v1's forgiving rules at its own speeds. The helicopter and the drone
hover there: throttle 0.5 holds the height, more climbs and less descends.

## Mouse

| input | CLASSIC | SIM |
| --- | --- | --- |
| Click the view | captures the mouse (pointer lock); drag instead where capture is blocked | same |
| Move (captured) | virtual stick that springs back to centre | virtual stick that stays put: its offset from the screen centre is the stick deflection (a gold dot shows it) |
| Drag (not captured) | drag-to-steer, springs back on release | same |
| Wheel | throttle target in 5% steps | throttle lever in 5% steps |
| Right-drag | free look; release returns to centre | same |
| Middle click | recenter view | recenter view |

## Touch

The on-screen joystick (pitch / roll), throttle slider, and boost and barrel-roll buttons work
exactly as in v1. The boost and barrel-roll buttons are CLASSIC only: SIM hides them, since it
disables boost and the barrel roll everywhere. The menu opens the settings, where the Controls tab
leads to the controls panel.

## Standard gamepad (Xbox-style, "standard" mapping)

| input | action |
| --- | --- |
| Left stick | roll / pitch (pull back = nose up) |
| RB / LB | rudder right / left |
| RT / LT | throttle up / down (60% per second, analog) |
| Right stick | free look (returns to centre) |
| R3 (right stick click) | recenter view |
| A | boost (CLASSIC) / craft ability (SIM) |
| B | airbrake (hold) |
| X | landing gear |
| Y | cycle view |
| D-pad up / down | flaps up / down |
| D-pad left / right | previous / next craft |
| View (back) | CLASSIC / SIM |
| Menu (start) | settings |
| L3 (left stick click) | waypoint to nearest landmark |

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
| Head button 2 | craft ability (SIM) / boost (CLASSIC) |
| Head button 3 | waypoint to nearest landmark |
| Head button 4 | photo mode |
| Hat up / down | view forward (cockpit) / chase |
| Hat left / right | look left / right 90 deg |
| Base 5 / 6 / 7 | landing gear / flaps up / flaps down |
| Base 8 / 9 | previous / next craft |
| Base 10 | CLASSIC / SIM |
| Base 11 | autopilot |
| Base 12 / 13 | time of day forward / back |
| Base 14 | ring course |
| Base 15 | journal |
| Base 16 | settings |

### Throttle (TWCS) and pedals (TFRP)

| input | action |
| --- | --- |
| Throttle | throttle (helicopter: collective; drone: thrust). Its direction is learned in calibration. The afterburner detent sits at the "Afterburner detent" setting (95% by default) |
| Pedal rudder | yaw (helicopter: anti-torque); disables twist yaw once moved |
| Left / right toe brake | wheel brakes (both), differential ground steering, airbrake in the air |
| Rocker | pitch trim (spring-centred: hold it to move the trim) |
| Antenna slider | flaps with notch hysteresis on fixed-wing craft; FOV zoom (up to 3x) on the helicopter, drone and wingsuit |
| Mini-stick | free look (absolute angle; releasing returns to centre) |
| Mini-stick click (1) | recenter view |
| Button 2 | airbrake (hold) |
| Button 3 | cycle view |
| Button 4 | relaunch |
| Button 5 | engine on / off |
| Button 6 | deploy parachute |
| Button 7 | controls panel |
| Throttle hat | unbound (reserved for music controls in a later phase) |

TFRP pedals on their own USB lead (normally they come through the TWCS) default to rudder and toe
brakes in the same way.

### Unplugging mid-flight

If a controller that is flying the craft disconnects in SIM, the assists take over hands-off at
100 %: wings level, heading and altitude held, with a toast. Control comes back when that device
reconnects, or as soon as another device holds the stick past about a third of its travel for a
quarter of a second.

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

- **Flight tab**: the assists slider for the current craft, start on the ground, units and the HUD
  options. It also holds the FPV drone's camera and stick settings (`settings.fpv`):
  - camera uptilt, 0-40 deg (default 25);
  - stick expo, 0-1 (default 0.3);
  - maximum rate in deg/s (default 670).
  They apply to the FPV drone only and take effect live.
- **Graphics tab**: the field of view per view, including the FPV lens (90-150 deg, default 120).
- **Controls tab**:
  - mouse sensitivity and invert pitch;
  - "Stick twist yaw" (auto / on / off);
  - the afterburner detent (80-100 %);
  - what to do when a HOTAS connects in CLASSIC (ask / always switch to SIM / never);
  - buttons that open the controls panel and the calibration wizard.

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
4. **Fly each craft once** in SIM (keys 1-6, or stick base 8 / 9):
   - glider: spoilers on both toe brakes, trim on the rocker;
   - bush plane: flap notches on the antenna, and a take-off with toe-brake steering (turn on
     "Start on the ground");
   - jet: gear on base 5, and the afterburner detent;
   - helicopter: collective on the throttle, anti-torque on the pedals, hover hold on head
     button 2;
   - wingsuit: pull the chute (TWCS button 6) and steer the canopy with the pedals and toe brakes;
   - FPV drone: thrust on the throttle, and head button 2 for rate / angle mode.
5. **What to look for:**
   - **Hat snaps**: stick hat up gives the cockpit, down the chase view, left / right look 90 deg,
     with no stuck or phantom directions at centre.
   - **Twist hand-off to the pedals**: the twist yaws until the pedals first move, then only the
     pedals do.
   - **Afterburner detent click**: past the detent (95 %) you hear a click, the throttle gauge
     shows the AB lamp and the flame lights; back below it goes out.
   - **Hot-plug assists hold**: unplug the stick in SIM mid-flight. You get a toast, and the craft
     holds wings level and altitude. Replug it (press a button) and control returns with a
     "reconnected" toast.
   - The throttle reads 0 % at idle and 100 % fully forward, and no axis drifts at rest (bars at
     0 % in the controls panel).

## Actions

`copilotPTT, craftAbility, boost, waypointNearest, waypointAhead, photoMode, viewCycle,
viewForward, viewBack, viewLeft, viewRight, recenterView, craftNext, craftPrev, craftSelect1-6,
modeToggle, gearToggle, flapsUp, flapsDown, airbrake, autopilotToggle, timeForward, timeBack,
ringCourse, journal, settings, controlsPanel, relaunch, engineToggle, chuteDeploy`. Each press and
release is published as `input:action { id, phase, source, device }`.

## For developers: the input system API

`ctx.systems.input` (src/input/InputManager.js) is what the controls panel, calibration wizard,
dev badge and HOTAS prompt build on:

| member | what |
| --- | --- |
| `getDevices()` | connected controllers: `{ deviceKey, kind, name, profile, vendor, product, known, confirmed, slot, id, axisCount, buttonCount, bindingDevice, hotas, calibrated, needsCalibration }` |
| `getConnectionState()` | `{ supported, devices, hotas: { stick, throttle, pedals, complete }, prompt, pedalNote }`; `prompt` is "Press any button on your stick and throttle" until both are seen |
| `readDevice(deviceKey)` | live readings for the panel: every axis (`raw`, calibrated `value`, `range`, `hat`), button (`pressed`, `value`) and hat (`learned`, decoded `direction`) with the device's own labels |
| `readKeyboard()`, `getStick()` | held key codes; the mouse virtual stick `{ x, y, locked, dragging, mode: 'spring' \| 'free', fullDeflectionPixels }` |
| `centerStick()` | puts the mouse virtual stick back to centre |
| `getThrottleReading()`, `getTwistState()` | throttle with `afterburnerDetent` / `afterburner`; twist-yaw setting and pedal state |
| `bindings` | the binding store: `getRefs`, `sourceOf` ('craft' \| 'global' \| 'default'), `getEffective`, `getDefaultRefs`, `bind`, `unbind`, `updateRef` (axis tuning), `releaseInputs` (the "Replace" answer to a conflict), `clearOverride`, `resetToDefaults`, `findConflicts`, `conflictsFor`, `findAllConflicts`, `listDevices`, `exportJSON`, `importJSON`, `onChange` |
| `describeRef(ref, bindingDevice)` | short label of a binding ("Shift+F", "Trigger", "Hat 1 up") |
| `listen({ target, device })`, `bindByListening({ target, craft, device, replace })`, `cancelListen()`, `getListenState()`, `onListenChange()` | bind by listening: the next key, mouse button, controller button, learned hat direction or axis moved past half travel; Escape cancels. `device` may be one binding device, an array of them, or null |
| `startCalibration({ deviceKeys })`, `getCalibrationWizard()` | the wizard step machine: `getState()`, `next()`, `skip()`, `back()`, `cancel()`, `finish()`, `onChange()` |
| `calibration` | per-device records: `get`, `save`, `reset`, `keys`, `onChange` (stored as `input.calibration.<deviceKey>`) |
| `consumesKey(event)` | true when a keydown belongs to an input action (the UI leaves it alone) |
| `isPointerLocked()`, `readPhotoControls()` | pointer-lock state; the photo-mode free-camera input |
| `mock` | with `?test=hotas`: the scriptable mock devices from `src/dev/mockGamepads.js` (`plug`, `unplug`, `moveToSlot`, `setAxis`, `press`, `release`, `setButton`, `setHat`, `restAxes`, `get`, `list`) |

Fixed-wing SIM models turn `ControlState.antenna` into flap notches with hysteresis (one notch
width at every notch); craft whose `inputProfile.antenna` is `'zoom'` use it for the lens instead.
