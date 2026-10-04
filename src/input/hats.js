// Hat switch decoding from what the calibration wizard learned.
//
// Browsers report an 8-way hat in one of two forms:
//   axis form:    one axis with a discrete value per direction and an out-of-range value when
//                 centred (Chrome on Windows),
//   button form:  four buttons, diagonals pressing two at once.
// Nothing here assumes particular values: the wizard records the value (axis form) or the set of
// pressed buttons (button form) for the centre and each of the eight directions, and decoding
// matches live readings against those recordings.

export const HAT_DIRECTIONS = Object.freeze(['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft']);

export const HAT_DIRECTION_LABELS = Object.freeze({
  up: 'up',
  upRight: 'up-right',
  right: 'right',
  downRight: 'down-right',
  down: 'down',
  downLeft: 'down-left',
  left: 'left',
  upLeft: 'up-left',
});

/** Smallest allowed match window for axis-form hats (raw units). */
const MIN_AXIS_TOLERANCE = 0.02;

/** Values an axis-form hat has learned, centre included, as [name, value] pairs. */
function learnedAxisValues(hat) {
  const entries = [];
  if (Number.isFinite(hat.center)) entries.push(['center', hat.center]);
  for (const direction of HAT_DIRECTIONS) {
    const value = hat.values?.[direction];
    if (Number.isFinite(value)) entries.push([direction, value]);
  }
  return entries;
}

/** Half the smallest gap between learned values: readings closer than that belong to one entry. */
function axisTolerance(entries) {
  let smallest = Infinity;
  for (let first = 0; first < entries.length; first++) {
    for (let second = first + 1; second < entries.length; second++) {
      smallest = Math.min(smallest, Math.abs(entries[first][1] - entries[second][1]));
    }
  }
  return Number.isFinite(smallest) ? Math.max(MIN_AXIS_TOLERANCE, smallest / 2) : MIN_AXIS_TOLERANCE;
}

/** Sorted, comma-joined button indices: the key a button-form combination is stored under. */
export function buttonSignature(indices) {
  return [...indices].sort((first, second) => first - second).join(',');
}

/**
 * Prepares a learned hat for fast decoding (tolerance and signature lookup computed once).
 * hat: { form: 'axis', axis, center, values: { up: v, ... } }
 *   or { form: 'buttons', buttons: [indices], combos: { up: [indices], ... } }
 */
export function compileHat(hat) {
  if (!hat || (hat.form !== 'axis' && hat.form !== 'buttons')) return null;
  if (hat.form === 'axis') {
    const entries = learnedAxisValues(hat);
    if (!Number.isInteger(hat.axis) || entries.length < 2) return null;
    return { form: 'axis', axis: hat.axis, entries, tolerance: axisTolerance(entries), directions: entries.filter(([name]) => name !== 'center').length };
  }
  const bySignature = new Map();
  const members = new Set(Array.isArray(hat.buttons) ? hat.buttons.filter(Number.isInteger) : []);
  for (const direction of HAT_DIRECTIONS) {
    const combo = hat.combos?.[direction];
    if (!Array.isArray(combo) || combo.length === 0) continue;
    for (const index of combo) members.add(index);
    bySignature.set(buttonSignature(combo), direction);
  }
  if (bySignature.size === 0) return null;
  return { form: 'buttons', buttons: [...members].sort((first, second) => first - second), bySignature, directions: bySignature.size };
}

/**
 * Decodes a compiled hat from live readings. axes: raw axis values; buttonPressed(index) -> bool.
 * Returns a HAT_DIRECTIONS entry, or null when centred or when the reading matches nothing learned.
 */
export function decodeHat(compiled, axes, buttonPressed) {
  if (!compiled) return null;
  if (compiled.form === 'axis') {
    const value = axes[compiled.axis];
    if (!Number.isFinite(value)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const [name, learned] of compiled.entries) {
      const distance = Math.abs(value - learned);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = name;
      }
    }
    if (best === null || best === 'center' || bestDistance > compiled.tolerance) return null;
    return best;
  }
  const pressed = compiled.buttons.filter((index) => buttonPressed(index));
  if (pressed.length === 0) return null;
  return compiled.bySignature.get(buttonSignature(pressed)) ?? null;
}
