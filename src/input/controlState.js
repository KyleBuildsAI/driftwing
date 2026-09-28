// ControlState: the one device-independent description of what the pilot is asking for.
//
// Every input source (keyboard, mouse virtual stick, touch, gamepad, HOTAS) contributes to the
// same ControlState; flight models, cameras and UI read only this. Axes are normalized:
//   roll, pitch, yaw         -1..1   (right, nose up, nose right positive)
//   throttle, collective      0..1
//   brakeL, brakeR            0..1
//   flaps                     0..1   (axis-commanded setting; craft quantize to their notches)
//   trim                     -1..1   (pitch trim position, nose up positive)
//   lookX, lookY             -1..1   (free-look deflection as a fraction of the view's maximum look
//                                     angle, right / up positive; 0 = centred, releasing returns to 0)
//   antenna                   0..1   (HOTAS antenna slider; the craft inputProfile turns it into
//                                     flaps with notch hysteresis or FOV zoom)
// plus afterburnerDetent (0.8..1, from settings) and afterburner (throttle at or past the detent).
// Discrete actions arrive as a Set of action ids that fired since the flight controller last
// consumed them; the flight controller clears it.

export const AXES = Object.freeze(['roll', 'pitch', 'yaw', 'throttle', 'collective', 'brakeL', 'brakeR', 'flaps', 'trim', 'lookX', 'lookY', 'antenna']);

/**
 * Every rebindable discrete action, with the label shown in the controls panel. Order is the order
 * the panel lists them in.
 */
export const ACTIONS = Object.freeze({
  copilotPTT: 'Copilot push-to-talk',
  craftAbility: 'Craft ability',
  waypointNearest: 'Waypoint to nearest landmark',
  waypointAhead: 'Waypoint ahead',
  photoMode: 'Photo mode',
  viewCycle: 'Cycle view',
  viewForward: 'View forward (cockpit)',
  viewBack: 'View back (chase)',
  viewLeft: 'Look left 90 deg',
  viewRight: 'Look right 90 deg',
  recenterView: 'Recenter view',
  craftNext: 'Next craft',
  craftPrev: 'Previous craft',
  craftSelect1: 'Glider',
  craftSelect2: 'Bush plane',
  craftSelect3: 'Jet',
  craftSelect4: 'Helicopter',
  craftSelect5: 'Wingsuit',
  craftSelect6: 'FPV drone',
  gearToggle: 'Landing gear',
  flapsUp: 'Flaps up',
  flapsDown: 'Flaps down',
  airbrake: 'Airbrake / spoilers',
  autopilotToggle: 'Autopilot',
  timeForward: 'Time of day forward',
  timeBack: 'Time of day back',
  ringCourse: 'Ring course',
  journal: 'Journal',
  settings: 'Settings',
  controlsPanel: 'Controls panel',
  relaunch: 'Relaunch',
  engineToggle: 'Engine on / off',
  chuteDeploy: 'Deploy parachute',
  versionToggle: 'Switch to V1 (the original game)',
});
export const ACTION_IDS = Object.freeze(Object.keys(ACTIONS));

export function createControlState() {
  return {
    roll: 0,
    pitch: 0,
    yaw: 0,
    throttle: 0.5,
    collective: 0.5,
    brakeL: 0,
    brakeR: 0,
    flaps: 0,
    trim: 0,
    lookX: 0,
    lookY: 0,
    antenna: 0,
    /** Throttle position of the afterburner detent (settings.afterburnerDetent). */
    afterburnerDetent: 0.95,
    /** True while the throttle sits at or beyond the afterburner detent. */
    afterburner: false,
    /** Action ids pressed since the flight controller last consumed them. */
    actions: new Set(),
    /** Action ids currently held (for hold-type actions such as airbrake and PTT). */
    held: new Set(),
    /** Which source last moved each axis: 'keyboard' | 'mouse' | 'touch' | 'gamepad' | 'hotas'. */
    sources: {},
    /**
     * The controller (deviceKey) that last moved each axis, or null when a keyboard, mouse or touch
     * source did (the hot-plug hold engages only for the device that was really flying).
     */
    sourceDevices: {},
  };
}

/** Copies axis values and action sets from source into target (used for tick snapshots). */
export function copyControlState(target, source) {
  for (const axis of AXES) target[axis] = source[axis];
  target.afterburnerDetent = source.afterburnerDetent;
  target.afterburner = source.afterburner;
  target.actions.clear();
  for (const action of source.actions) target.actions.add(action);
  target.held.clear();
  for (const action of source.held) target.held.add(action);
  Object.assign(target.sources, source.sources);
  Object.assign(target.sourceDevices, source.sourceDevices);
  return target;
}
