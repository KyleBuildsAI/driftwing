# DRIFTWING controls

Every named action can be rebound on every device (keyboard included) in the controls panel
(`.` or the `controlsPanel` action). Bindings are a global profile plus optional per-craft
overrides; they, and each controller's calibration, are saved in the browser's IndexedDB for
`http://127.0.0.1:5199` and survive restarts. Export / import in the panel moves them as JSON.

> **Keep pedals centered and feet off when plugging in.** The toe brakes are read as released
> in whatever position they rest when the throttle first appears, until the calibration wizard
> has learned them.

## Modes and layers

- **CLASSIC** plays exactly like v1: v1's keys, the mouse stick springs back to centre, Space
  boosts and a double-tap on A or D barrel-rolls.
- **SIM** keeps every v1 key that does not collide and adds a SIM layer: G is the landing gear
  (the waypoint moves to N), C cycles the view (Enter and / still open the command bar), Space is
  the craft ability, W / S move the throttle lever, and the mouse becomes a free virtual stick.
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

UI keys (not rebindable, same in both modes unless noted): **M** talk to WREN (mic on / off),
**Enter** or **/** type to WREN (**C** as well in CLASSIC), **H** or **?** help, **Esc** close /
leave photo mode, **X** clear waypoint, **K** capture a photo, **I** fps and stats, **Shift+V**
WREN voice on / off, **Tab** hide or show the HUD. If you bind one of these keys to an action, the
action wins and the panel warns about the conflict.

In photo mode only photo mode, time of day, push-to-talk and the UI keys above work; WASD, Q / E,
the arrows, Shift, the mouse and the wheel drive the free camera (v1).

## Mouse

| input | CLASSIC | SIM |
| --- | --- | --- |
| Click the view | captures the mouse (pointer lock); drag instead where capture is blocked | same |
| Move (captured) | virtual stick that springs back to centre | virtual stick that stays put: its offset from the screen centre is the stick deflection |
| Drag (not captured) | drag-to-steer, springs back on release | same |
| Wheel | throttle target in 5% steps | throttle lever in 5% steps |
| Right-drag | free look; release returns to centre | same |
| Middle click | recenter view | recenter view |

## Touch

On-screen joystick (pitch / roll), throttle slider and the boost button (craft ability in SIM),
exactly as v1.

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

The browser sees two devices: the **T.16000M stick** and the **TWCS throttle** (the TFRP pedals
plug into the TWCS and appear as its axes). Devices are recognised by the USB vendor / product id
in the browser's gamepad id (Thrustmaster `044f`; T.16000M `b10a`, TWCS `b687`, TFRP `b679`, to
be confirmed on the real hardware: run with `?debug=1` and the ids the browser reports are logged
once to the console) or by the names "T.16000M" / "TWCS", never by slot order.

Browsers only show a controller after one of its buttons is pressed on the page: the controls
panel says "Press any button on your stick and throttle" until both have appeared.

Button numbers below are Windows' 1-based numbers (the Gamepad API index is one less). They are
the best published layout; if your hardware reports them differently, rebind in the controls panel.

### Stick (T.16000M)

| input | action |
| --- | --- |
| X / Y | roll / pitch (helicopter: cyclic) |
| Twist | rudder, only until the pedals move (setting "Twist yaw": auto / on / off) |
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
| Throttle | throttle (helicopter: collective; drone: thrust); direction learned in calibration; the afterburner detent is at the "Afterburner detent" setting (95%) |
| Pedal rudder | yaw (helicopter: anti-torque); disables twist yaw once moved |
| Left / right toe brake | wheel brakes (both), differential ground steering, airbrake in the air |
| Rocker | pitch trim (spring-centred: hold it to move the trim) |
| Antenna slider | flaps with notch hysteresis on fixed-wing; FOV zoom on helicopter, drone and wingsuit |
| Mini-stick | free look (absolute angle; releasing returns to centre) |
| Mini-stick click (1) | recenter view |
| Button 2 | airbrake (hold) |
| Button 3 | cycle view |
| Button 4 | relaunch |
| Button 5 | engine on / off |
| Button 6 | deploy parachute |
| Button 7 | controls panel |
| Throttle hat | unbound (reserved for music controls) |

TFRP pedals on their own USB lead (normally they come through the TWCS) default to rudder and toe
brakes the same way.

## Calibration wizard

Open the controls panel and choose **Calibrate**. With the pedal note above in mind:

1. **Center everything**: let go of the stick, centre the mini-stick, rocker and twist, feet off
   the pedals. The wizard records each axis centre and finds hats that report as an axis.
2. **Move each axis lock to lock**: stick in a full circle, twist both ways, throttle, rocker,
   antenna, mini-stick and pedals. Each axis ticks off once it has covered its range.
3. **Throttle full forward**: push the throttle (and the stick's slider) fully forward and hold;
   this teaches which end is idle and which is full.
4. **Pedals**: full left, full right, then each toe brake all the way, pressing Next while holding
   each position (rudder direction and brake travel are learned).
5. **Press each hat direction**: up, up-right, right ... up-left, releasing between presses. The
   wizard learns whether each hat reports as one axis or as buttons, and the value or button
   combination of every direction and of centre; nothing is hard-coded.

Save stores the result under the device's id; it is restored whenever that device is plugged in
again, in any slot.

## Per-axis tuning

Every controller axis goes through: calibration (centre, range, direction) -> invert -> centre
deadzone -> edge saturation -> expo curve -> light low-pass smoothing. Each binding can override
invert, deadzone, saturation, expo and smoothing.

## Actions

`copilotPTT, craftAbility, boost, waypointNearest, waypointAhead, photoMode, viewCycle,
viewForward, viewBack, viewLeft, viewRight, recenterView, craftNext, craftPrev, craftSelect1-6,
modeToggle, gearToggle, flapsUp, flapsDown, airbrake, autopilotToggle, timeForward, timeBack,
ringCourse, journal, settings, controlsPanel, relaunch, engineToggle, chuteDeploy`. Each press and
release is published as `input:action { id, phase, source, device }`.
