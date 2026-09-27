// Device identification for Gamepad API devices (standard gamepads and Thrustmaster HOTAS).
//
// Devices are identified by the USB vendor / product id that the browser embeds in gamepad.id,
// never by slot index (slot order changes across reboots and plug order). Chrome formats the id as
// "Name (Vendor: 044f Product: b10a)" or "Name (STANDARD GAMEPAD Vendor: 045e Product: 02ea)";
// Firefox-style strings are "044f-b10a-Name". When no ids can be parsed the name substrings
// "T.16000M" / "TWCS" / "TFRP" still identify the Thrustmaster devices.
//
// Axis indices follow Chrome's HID usage order (X 0, Y 1, Z 2, Rx 3, Ry 4, Rz 5, Slider 6,
// Dial 7) and are the best published knowledge. Every index and button number is only a default:
// bindings override them and the calibration wizard learns ranges and hats on the real hardware.

export const THRUSTMASTER_VENDOR = '044f';

/**
 * Known devices by vendor / product id. The product ids are the published ones and are marked
 * confirmed: false until they have been observed on real hardware (run with ?debug=1 to log the
 * ids the browser reports).
 */
export const KNOWN_DEVICES = Object.freeze([
  Object.freeze({ vendor: THRUSTMASTER_VENDOR, product: 'b10a', profile: 't16000m', confirmed: false }),
  Object.freeze({ vendor: THRUSTMASTER_VENDOR, product: 'b687', profile: 'twcs', confirmed: false }),
  Object.freeze({ vendor: THRUSTMASTER_VENDOR, product: 'b679', profile: 'tfrp', confirmed: false }),
]);

/** Name fallbacks, checked in order when the vendor / product ids are missing or unknown. */
const NAME_FALLBACKS = Object.freeze([
  { pattern: /T\.?\s?16000\s?M/i, profile: 't16000m' },
  { pattern: /TWCS/i, profile: 'twcs' },
  { pattern: /TFRP|T\.?\s?Flight\s+Rudder/i, profile: 'tfrp' },
]);

/**
 * Device profiles: the kind reported in events, a display name, the named axes (index, label,
 * range) and the hats. range is 'bipolar' (-1..1, centred) or 'unipolar' (0..1). restIsIdle marks
 * axes whose resting position when the device first appears is taken as their idle end until the
 * calibration wizard has run (toe brakes: "keep your feet off the pedals when plugging in").
 * idleRaw is the raw end assumed idle before calibration for axes that do not rest (throttles).
 * Hats have form 'auto': the calibration wizard learns whether a hat reports as one axis or as
 * buttons, and which values or button sets are its eight directions and centre.
 */
export const DEVICE_PROFILES = Object.freeze({
  t16000m: Object.freeze({
    kind: 'hotas-stick',
    name: 'T.16000M stick',
    axes: Object.freeze([
      { index: 0, label: 'Stick X', range: 'bipolar' },
      { index: 1, label: 'Stick Y', range: 'bipolar' },
      { index: 5, label: 'Twist', range: 'bipolar' },
      { index: 6, label: 'Throttle slider', range: 'unipolar', idleRaw: 1 },
    ]),
    buttonCount: 16,
    buttonLabels: Object.freeze(['Trigger', 'Head bottom', 'Head left', 'Head right', 'Base L1', 'Base L2', 'Base L3', 'Base L4', 'Base L5', 'Base L6', 'Base R1', 'Base R2', 'Base R3', 'Base R4', 'Base R5', 'Base R6']),
    hats: Object.freeze([{ label: 'Stick hat', form: 'auto' }]),
  }),
  twcs: Object.freeze({
    kind: 'hotas-throttle',
    name: 'TWCS throttle',
    axes: Object.freeze([
      { index: 0, label: 'Mini-stick X', range: 'bipolar' },
      { index: 1, label: 'Mini-stick Y', range: 'bipolar' },
      { index: 2, label: 'Throttle', range: 'unipolar', idleRaw: 1 },
      { index: 3, label: 'Left toe brake', range: 'unipolar', restIsIdle: true },
      { index: 4, label: 'Right toe brake', range: 'unipolar', restIsIdle: true },
      { index: 5, label: 'Rocker', range: 'bipolar' },
      { index: 6, label: 'Antenna', range: 'unipolar', idleRaw: 1 },
      { index: 7, label: 'Rudder', range: 'bipolar' },
    ]),
    buttonCount: 14,
    buttonLabels: Object.freeze(['Mini-stick click', 'Thumb', 'Button 3', 'Button 4', 'Button 5', 'Button 6', 'Button 7', 'Button 8', 'Button 9', 'Button 10', 'Button 11', 'Button 12', 'Button 13', 'Button 14']),
    hats: Object.freeze([{ label: 'Throttle hat', form: 'auto' }]),
  }),
  tfrp: Object.freeze({
    kind: 'hotas-pedals',
    name: 'TFRP rudder pedals',
    axes: Object.freeze([
      { index: 0, label: 'Left toe brake', range: 'unipolar', restIsIdle: true },
      { index: 1, label: 'Right toe brake', range: 'unipolar', restIsIdle: true },
      { index: 5, label: 'Rudder', range: 'bipolar' },
    ]),
    buttonCount: 0,
    buttonLabels: Object.freeze([]),
    hats: Object.freeze([]),
  }),
  standard: Object.freeze({
    kind: 'gamepad',
    name: 'Gamepad',
    axes: Object.freeze([
      { index: 0, label: 'Left stick X', range: 'bipolar' },
      { index: 1, label: 'Left stick Y', range: 'bipolar' },
      { index: 2, label: 'Right stick X', range: 'bipolar' },
      { index: 3, label: 'Right stick Y', range: 'bipolar' },
    ]),
    buttonCount: 17,
    buttonLabels: Object.freeze(['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Guide']),
    hats: Object.freeze([]),
  }),
  generic: Object.freeze({
    kind: 'gamepad',
    name: 'Game controller',
    axes: Object.freeze([]),
    buttonCount: 0,
    buttonLabels: Object.freeze([]),
    hats: Object.freeze([]),
  }),
});

/** Device kinds that are part of a HOTAS setup. */
export const HOTAS_KINDS = Object.freeze(['hotas-stick', 'hotas-throttle', 'hotas-pedals']);

function normalizeHexId(value) {
  return value.toLowerCase().padStart(4, '0');
}

/**
 * Parses vendor / product ids and a readable name out of a gamepad.id string.
 * Returns { vendor, product, name } with vendor / product as 4-digit lower-case hex or null.
 */
export function parseGamepadId(id) {
  const text = String(id ?? '').trim();
  const chromeMatch = /Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})/i.exec(text);
  if (chromeMatch) {
    const name = text.replace(/\s*\((?:[^()]*\s)?Vendor:[^)]*\)\s*$/i, '').trim();
    return { vendor: normalizeHexId(chromeMatch[1]), product: normalizeHexId(chromeMatch[2]), name: name || text };
  }
  const prefixMatch = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.*)$/i.exec(text);
  if (prefixMatch) {
    return { vendor: normalizeHexId(prefixMatch[1]), product: normalizeHexId(prefixMatch[2]), name: prefixMatch[3].trim() || text };
  }
  return { vendor: null, product: null, name: text };
}

/** Stable text key for a device without parseable ids (the id string, lightly sanitized). */
function nameKey(name) {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `name-${cleaned || 'unknown'}`;
}

/**
 * Identifies a Gamepad object. Returns { baseKey, profile, kind, name, vendor, product, known,
 * confirmed, standard }. baseKey is 'vvvv-pppp' when ids are known, otherwise a name key; the
 * device registry appends '#2', '#3' for identical devices plugged at the same time.
 */
export function identifyGamepad(gamepad) {
  const parsed = parseGamepadId(gamepad.id);
  const known = parsed.vendor ? KNOWN_DEVICES.find((entry) => entry.vendor === parsed.vendor && entry.product === parsed.product) : null;
  let profileId = known ? known.profile : null;
  if (!profileId) profileId = NAME_FALLBACKS.find((entry) => entry.pattern.test(parsed.name))?.profile ?? null;
  const standard = gamepad.mapping === 'standard';
  if (!profileId) profileId = standard ? 'standard' : 'generic';
  const profile = DEVICE_PROFILES[profileId];
  const baseKey = parsed.vendor ? `${parsed.vendor}-${parsed.product}` : nameKey(parsed.name);
  return {
    baseKey,
    profile: profileId,
    kind: profile.kind,
    name: HOTAS_KINDS.includes(profile.kind) ? profile.name : (parsed.name || profile.name),
    vendor: parsed.vendor,
    product: parsed.product,
    known: Boolean(known) || profileId === 't16000m' || profileId === 'twcs' || profileId === 'tfrp',
    confirmed: Boolean(known && known.confirmed),
    standard,
  };
}

/** The binding namespace a device uses: every standard gamepad shares 'gamepad'; others use their key. */
export function bindingDeviceFor(device) {
  return device.profile === 'standard' ? 'gamepad' : device.deviceKey;
}
