// EAGLE / DRAGON: the flapping creature (contract h.1, model kind 'flapper'), one craft with two skins
// chosen in the picker: a bald eagle and a small dragon (src/craft/eagleMeshes.js), separate meshes on
// the same frame and the same physics (src/flight/SimFlapper.js).
//
// The throttle axis is flap power (0 = glide); pushing the stick hard or holding the tuck (Shift+Space)
// folds the wings into a stoop; it soars thermals and ridge lift with the flap power at zero. Fly
// slowly at a perch (a peak, a structure top, a tree top) and the auto-landing sets it down; on the
// perch the chase camera orbits slowly, and flap power raised takes off. craftAbility (Space): the
// eagle screeches; the dragon breathes fire while held (a harmless flame and a borrowed light that
// lights lanterns and torches through ctx.ignition). Fauna flocks treat it as a predator
// (faunaThreat 2.5). There is no fail state beyond the Phase 1 soft crash.
import { bearingTo, compassName, damp } from '../core/util.js';
import { PALETTE } from './kit.js';
import { DRAGON_MOUTH, EYES, FEET, FIRE_ANGLE, FIRE_DROOP, FIRE_LENGTH, buildDragonMesh, buildEagleMesh } from './eagleMeshes.js';

// ============================================================================================
// SIM: SimFlapper (src/flight/SimFlapper.js). Targets first, then the parameters that meet them.
// Body axes relative to the mesh origin (the centre of mass): x right, y up, z aft; angles in
// degrees. tools/lab/eagle.mjs measures the targets.
// ============================================================================================
const simProfile = Object.freeze({
  model: 'flapper',
  targets: Object.freeze({
    glideRatio: 12, // best glide, flap power 0
    glideSpeed: 12.6, // m/s = 45 km/h, neutral stick
    minSink: 1, // m/s at the slow end of the glide (about 35 km/h)
    stallSpeed: 8.2, // m/s, wings out, no flapping
    climbRate: 2.5, // m/s at full flap power and a neutral stick
    stoopSpeed: 60, // m/s = 216 km/h, wings tucked, straight down
    perchSeconds: 3, // the auto-landing from the capture radius
  }),
  mass: 4.6, // a big female bald eagle
  // kg m^2 about body x (pitch), y (yaw) and z (roll): 2.1 m of wings on a short body.
  inertia: Object.freeze({ pitch: 0.12, yaw: 0.4, roll: 0.3 }),
  // The arm and hand wings together: cambered (zero lift at -3.9 degrees), high lift with the alula and
  // slotted primaries; best glide about 12 : 1.
  wing: Object.freeze({
    area: 0.7,
    span: 2.1,
    chord: 0.34,
    clAlpha: 4.6, // per rad (AR 6.3)
    clMax: 1.6,
    clMin: -0.6,
    alphaCritical: 16,
    postStallDrop: 0.35,
    stallDropWidth: 4,
    stallBlendWidth: 16,
    cd0: 0.021,
    oswald: 0.82,
    sideArea: 0.1,
    sideForceSlope: 1.2,
  }),
  // Head, body and tucked legs (CD x area, m^2).
  body: Object.freeze({ dragArea: 0.004 }),
  // Folded wings: the area and span shares left at full tuck, their profile drag, the trim angle of
  // attack of the stoop, and how fast they fold (full travel per second fraction).
  tuck: Object.freeze({ area: 0.35, span: 0.42, cd0: 0.04, trimAoa: -3.4, rate: 2.2 }),
  // The wingbeat: muscle power (W) at full flap power, its efficiency, the speed below which thrust
  // stops growing, the beat frequency range (Hz), the stroke-plane tilt (deg, slow -> fast) and the
  // speed of the fast tilt, the extra maximum lift when slow, the control pressure it keeps (Pa), and
  // how fast the flap power follows the throttle (1/s).
  flap: Object.freeze({
    power: 220,
    efficiency: 0.8,
    referenceSpeed: 4,
    frequency: Object.freeze([2.2, 3.6]),
    strokeTilt: Object.freeze([45, 6]),
    tiltSpeed: 12,
    liftBoost: 0.45,
    boostSpeed: 14,
    controlPressure: 45,
    spool: 4,
  }),
  // Body and tail set the trim angle of attack: neutral glides at the best glide, full pull reaches
  // the slow, high-lift end before the stall, full push flies fast.
  pitch: Object.freeze({ trimAoa: 4.3, pullRange: 9.7, pushRange: 4.3, stiffness: 0.55, damping: 9, stallBreak: 0.2 }),
  roll: Object.freeze({ authority: 0.05, damping: 0.5, dihedral: 0.06, tuckLoss: 0.7 }),
  yaw: Object.freeze({ weathervane: 0.05, damping: 0.25, authority: 0.02, adverse: 0.004 }),
  // The perch (SimFlapper, "PERCH"): the feet below the centre of mass, the capture box (m: radius,
  // above and below the bird's feet) and speed, the landing's length (s) and flare (deg), the takeoff
  // gate (throttle) and hop, the stand and peak rules.
  perch: Object.freeze({
    feet: FEET,
    captureRadius: 14,
    captureAbove: 14,
    captureBelow: 3,
    captureSpeed: 11.5,
    underRadius: 4,
    aheadCosine: 0.15,
    landSeconds: Object.freeze([0.9, 2.8]),
    flare: 28,
    takeoffThrottle: 0.2,
    takeoffRaise: 0.15,
    takeoffSpeed: 4.5,
    takeoffUp: 2.6,
    takeoffPitch: 14,
    takeoffRise: 0.12,
    retakeSeconds: 4,
    settleSpeed: 2.5,
    standRadius: 3,
    restSnap: 0.5,
    peakStep: 3,
    peakSteps: 12,
    peakRings: Object.freeze([22, 45]),
    peakTolerance: 0.6,
    peakProminence: 3,
    turnRate: 70,
  }),
  // The feet are the gear (skids that grip); beak, chest, tail and wingtips are the body.
  contacts: Object.freeze([
    Object.freeze({ id: 'leftFoot', kind: 'skid', gear: true, position: Object.freeze([-0.05, -FEET, 0.04]), spring: 2500, damping: 110, friction: 0.9 }),
    Object.freeze({ id: 'rightFoot', kind: 'skid', gear: true, position: Object.freeze([0.05, -FEET, 0.04]), spring: 2500, damping: 110, friction: 0.9 }),
    Object.freeze({ id: 'chest', kind: 'body', gear: false, position: Object.freeze([0, -0.1, -0.1]), spring: 4000, damping: 160, friction: 0.6 }),
    Object.freeze({ id: 'beak', kind: 'body', gear: false, position: Object.freeze([0, 0.03, -0.49]), spring: 4000, damping: 160, friction: 0.6 }),
    Object.freeze({ id: 'tail', kind: 'body', gear: false, position: Object.freeze([0, 0.02, 0.52]), spring: 4000, damping: 160, friction: 0.6 }),
    Object.freeze({ id: 'leftWingtip', kind: 'body', gear: false, position: Object.freeze([-1.05, 0.06, 0.08]), spring: 4000, damping: 160, friction: 0.6 }),
    Object.freeze({ id: 'rightWingtip', kind: 'body', gear: false, position: Object.freeze([1.05, 0.06, 0.08]), spring: 4000, damping: 160, friction: 0.6 }),
  ]),
});

// Structure collision probes (contract b.4): every probe clears the feet by a centimetre, so the bird
// can stand on a perch point without touching the collider under it.
const collision = Object.freeze({
  probes: Object.freeze([
    Object.freeze({ id: 'body', position: Object.freeze([0, 0, -0.04]), radius: 0.15 }),
    Object.freeze({ id: 'head', position: Object.freeze([0, 0.05, -0.36]), radius: 0.08 }),
    Object.freeze({ id: 'tail', position: Object.freeze([0, 0.02, 0.42]), radius: 0.08 }),
    Object.freeze({ id: 'leftWing', position: Object.freeze([-0.5, 0.04, 0.03]), radius: 0.1 }),
    Object.freeze({ id: 'rightWing', position: Object.freeze([0.5, 0.04, 0.03]), radius: 0.1 }),
    Object.freeze({ id: 'leftTip', position: Object.freeze([-0.98, 0.06, 0.08]), radius: 0.08 }),
    Object.freeze({ id: 'rightTip', position: Object.freeze([0.98, 0.06, 0.08]), radius: 0.08 }),
    Object.freeze({ id: 'feet', position: Object.freeze([0, -0.17, 0.04]), radius: 0.07, gear: true }),
  ]),
});

// ============================================================================================
// SKINS, VIEWS AND THE CAMERA
// ============================================================================================
const SKINS = Object.freeze({
  default: 'eagle',
  list: Object.freeze([
    Object.freeze({
      id: 'eagle',
      name: 'Eagle',
      silhouette: Object.freeze([
        { mode: 'fill', d: 'M32 6 L35 10 L35 21 L46 17 L58 19 L63 25 L56 25 L59 28 L51 27 L53 30 L44 30 L36 32 L36 42 L42 52 L32 49 L22 52 L28 42 L28 32 L20 30 L11 30 L13 27 L5 28 L8 25 L1 25 L6 19 L18 17 L29 21 L29 10 Z' },
      ]),
    }),
    Object.freeze({
      id: 'dragon',
      name: 'Dragon',
      silhouette: Object.freeze([
        { mode: 'fill', d: 'M32 3 L35 8 L35 20 L44 14 L62 12 L56 20 L60 22 L52 25 L55 28 L44 29 L36 33 L35 44 L37 52 L33 60 L31 60 L29 52 L29 44 L28 33 L20 29 L9 28 L12 25 L4 22 L8 20 L2 12 L20 14 L29 20 L29 8 Z' },
        { mode: 'stroke', d: 'M30 6 L26 2 M34 6 L38 2' },
      ]),
    }),
  ]),
});

/**
 * The skin the meshes were last built for: the first-person eye, the cockpit drawing and the chase
 * framing follow it (the controller rebuilds the mesh, then the cockpit, on a skin change).
 */
const view = { skin: 'eagle' };
/** The first-person eye (body axes): the eagle's head or the dragon's brow, set by buildMesh. */
const EYE = [...EYES.eagle];

/**
 * The chase framing (read by the chase camera every frame): a little wider for the dragon's tail, and
 * on a perch an orbit (orbitYaw, degrees) that starts after a moment and eases back on takeoff.
 */
const chaseFraming = { orbit: 0, orbitRate: 0, perchedSeconds: 0, perched: false };
const ORBIT = Object.freeze({ DELAY: 1.5, RATE: 11, EASE_IN: 0.35, RETURN: 2.2 });
const chaseRig = Object.freeze({
  get distance() {
    return view.skin === 'dragon' ? 6 : 5.4;
  },
  get height() {
    return 1.3;
  },
  get lookAhead() {
    return 7;
  },
  /** The idle camera: degrees of orbit round the craft added to the chase view (cameraManager). */
  get orbitYaw() {
    return chaseFraming.orbit;
  },
});

/** Advances the perch orbit (once a frame, from the mesh update). */
function updateChaseOrbit(craftState, dt) {
  const perched = craftState.perched === true;
  const seconds = Number(craftState.perchedSeconds) || 0;
  if (perched && seconds > ORBIT.DELAY) {
    chaseFraming.orbitRate = damp(chaseFraming.orbitRate, ORBIT.RATE, ORBIT.EASE_IN, dt);
    chaseFraming.orbit = (chaseFraming.orbit + chaseFraming.orbitRate * dt) % 360;
  } else {
    chaseFraming.orbitRate = 0;
    // Back behind the craft by the shorter way round.
    const signed = ((chaseFraming.orbit + 540) % 360) - 180;
    chaseFraming.orbit = Math.abs(signed) < 0.05 ? 0 : damp(signed, 0, ORBIT.RETURN, dt);
  }
}

function buildMesh(ctx, { skin } = {}) {
  const chosen = skin === 'dragon' ? 'dragon' : 'eagle';
  view.skin = chosen;
  for (let index = 0; index < 3; index++) EYE[index] = EYES[chosen][index];
  chaseFraming.orbit = 0;
  chaseFraming.orbitRate = 0;
  const mesh = chosen === 'dragon' ? buildDragonMesh(ctx) : buildEagleMesh(ctx);
  const update = mesh.update;
  mesh.update = (visual, dt) => {
    update(visual, dt);
    if (visual.craftState) updateChaseOrbit(visual.craftState, Math.max(0, Math.min(dt, 0.05)));
  };
  return mesh;
}

/**
 * The creature's first-person view (cockpit style 'custom', drawn relative to the eye): the eagle sees
 * its hooked beak below the line of sight and its brows at the top corners; the dragon its snout
 * ridge, nostrils and brow horns. Its own head is hidden in this view (hideInCockpit). No panel: the
 * glass HUD carries the instruments, as for the wingsuit.
 */
function buildCreatureView(builder) {
  if (view.skin === 'dragon') {
    const ridge = [[-0.04, -0.035, -0.04], [0.04, -0.035, -0.04], [0.026, -0.07, -0.2], [-0.026, -0.07, -0.2]];
    builder.quad(ridge[0], ridge[1], ridge[2], ridge[3], PALETTE.orange, [0, -0.2, -0.12]);
    builder.triangle([-0.026, -0.07, -0.2], [0.026, -0.07, -0.2], [0, -0.085, -0.235], PALETTE.orange, [0, -0.2, -0.2]);
    for (const side of [-1, 1]) {
      builder.triangle([side * 0.012, -0.072, -0.205], [side * 0.022, -0.068, -0.2], [side * 0.016, -0.06, -0.215], PALETTE.charcoal, [side * 0.016, -0.2, -0.2]);
      builder.triangle([side * 0.03, 0.035, -0.035], [side * 0.075, 0.04, -0.02], [side * 0.05, 0.075, 0.0], PALETTE.charcoal, [side * 0.05, 0.2, -0.02]);
    }
    return null;
  }
  const beak = [[-0.018, -0.03, -0.05], [0.018, -0.03, -0.05], [0.01, -0.05, -0.12], [-0.01, -0.05, -0.12]];
  builder.quad(beak[0], beak[1], beak[2], beak[3], PALETTE.orange, [0, -0.2, -0.09]);
  builder.triangle([-0.01, -0.05, -0.12], [0.01, -0.05, -0.12], [0, -0.075, -0.135], PALETTE.orange, [0, -0.2, -0.13]);
  for (const side of [-1, 1]) {
    builder.triangle([side * 0.022, 0.024, -0.03], [side * 0.06, 0.02, -0.01], [side * 0.034, 0.04, -0.005], PALETTE.cream, [side * 0.04, 0.2, -0.02]);
  }
  return null;
}

// ============================================================================================
// ABILITIES
// craftAbility: the eagle screeches (Space, or the copilot); the dragon breathes fire while held (a
// press alone gives a short burst), lighting whatever ctx.ignition holds in the flame's cone (cut
// short by a solid collider in the way). It also keeps the nearest perch for the instrument and
// releases the copilot's perch approach once perched (or when the pilot takes the stick back).
// craftAbilityAlt: tuck the wings while held (Shift+Space); the copilot's "tuck" latches it.
// ============================================================================================
const FIRE = Object.freeze({ BURST: 0.6, COMMAND_BURST: 3, RISE: 7, FALL: 3.5, IGNITE_LEVEL: 0.45, REACH_MARGIN: 3 });
const NEAREST_PERCH = Object.freeze({ INTERVAL: 1, RADIUS: 300 });
/**
 * The copilot's perch search widens ring by ring (m) and stops at the first that finds one: the
 * vegetation perch provider scatters every 128 m cell a search covers (cached), so it stays small.
 */
const PERCH_COMMAND_RADII = Object.freeze([200, 600, 1500]);

/** Scratch for the ability updates (one craft flies at a time): no allocation per frame. */
const scratch = {
  ignition: null,
  lit: 0,
  source: { kind: 'dragonFire', craft: 'eagle', position: { x: 0, y: 0, z: 0 } },
  origin: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: 0 },
  hit: { t: 0, distance: 0, normal: { x: 0, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 }, velocity: null, id: '', owner: '', tags: null },
  nearest: { found: false, x: 0, y: 0, z: 0, kind: '', id: '', distance: Infinity },
  from: { x: 0, z: 0 },
  nearestTimer: 0,
};

function lightIgnitable(id, lit) {
  if (lit || !scratch.ignition) return;
  if (scratch.ignition.ignite(id, scratch.source)) scratch.lit++;
}

function visitNearestPerch(x, y, z, kind, sourceId) {
  const distance = Math.hypot(x - scratch.from.x, z - scratch.from.z);
  if (distance >= scratch.nearest.distance) return;
  scratch.nearest.found = true;
  scratch.nearest.x = x;
  scratch.nearest.y = y;
  scratch.nearest.z = z;
  scratch.nearest.kind = kind;
  scratch.nearest.id = typeof sourceId === 'string' ? sourceId : '';
  scratch.nearest.distance = distance;
}

/** The nearest perch point within radius of the bird (colliders.perchesNear), into scratch.nearest. */
function findNearestPerch(api, radius) {
  scratch.nearest.found = false;
  scratch.nearest.distance = Infinity;
  const position = api.player.position;
  scratch.from.x = position.x;
  scratch.from.z = position.z;
  if (api.colliders && typeof api.colliders.perchesNear === 'function') api.colliders.perchesNear(position.x, position.y, position.z, radius, visitNearestPerch);
  return scratch.nearest.found;
}

/** A body-axes point of the craft in the world (the player pose), into out. */
function worldPoint(api, local, out) {
  const quaternion = api.player.quaternion;
  const position = api.player.position;
  // Rotate local by the quaternion (q v q*), written out so nothing allocates.
  const x = local[0];
  const y = local[1];
  const z = local[2];
  const qx = quaternion.x;
  const qy = quaternion.y;
  const qz = quaternion.z;
  const qw = quaternion.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  out.x = position.x + ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out.y = position.y + iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out.z = position.z + iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return out;
}

const FIRE_AXIS = Object.freeze([0, -Math.sin(FIRE_DROOP), -Math.cos(FIRE_DROOP)]);
const fireAxisPoint = [0, 0, 0];

/** The dragon's flame this frame: the intensity ramp, and lighting what it touches. */
function updateFire(api, dt) {
  const craftState = api.craftState;
  const dragon = api.skin === 'dragon';
  const held = dragon && api.isHeld('craftAbility') && craftState.perched !== true;
  craftState.fireBurst = Math.max(0, (Number(craftState.fireBurst) || 0) - dt);
  const burning = dragon && (held || craftState.fireBurst > 0);
  const level = Number(craftState.fireIntensity) || 0;
  const next = burning ? Math.min(1, level + FIRE.RISE * dt) : Math.max(0, level - FIRE.FALL * dt);
  if (burning && !craftState.fire) craftState.roarCount = (Number(craftState.roarCount) || 0) + 1;
  craftState.fire = burning;
  craftState.fireIntensity = next;
  if (next < FIRE.IGNITE_LEVEL || !api.ignition) return;
  // The flame's cone from the mouth along the drooped body axis, cut short by a solid in the way.
  worldPoint(api, DRAGON_MOUTH, scratch.origin);
  fireAxisPoint[0] = DRAGON_MOUTH[0] + FIRE_AXIS[0];
  fireAxisPoint[1] = DRAGON_MOUTH[1] + FIRE_AXIS[1];
  fireAxisPoint[2] = DRAGON_MOUTH[2] + FIRE_AXIS[2];
  worldPoint(api, fireAxisPoint, scratch.direction);
  scratch.direction.x -= scratch.origin.x;
  scratch.direction.y -= scratch.origin.y;
  scratch.direction.z -= scratch.origin.z;
  let reach = FIRE_LENGTH * next + FIRE.REACH_MARGIN;
  if (api.colliders && typeof api.colliders.raycast === 'function' && api.colliders.raycast(scratch.origin, scratch.direction, reach, null, scratch.hit)) reach = Math.max(0.5, scratch.hit.distance);
  scratch.ignition = api.ignition;
  scratch.lit = 0;
  scratch.source.position.x = scratch.origin.x;
  scratch.source.position.y = scratch.origin.y;
  scratch.source.position.z = scratch.origin.z;
  api.ignition.cone(scratch.origin, scratch.direction, reach, FIRE_ANGLE, lightIgnitable);
  if (scratch.lit > 0) {
    craftState.lanternsLit = (Number(craftState.lanternsLit) || 0) + scratch.lit;
    api.notify(scratch.lit === 1 ? 'Lit one!' : `Lit ${scratch.lit}!`);
  }
}

/** Keeps the nearest perch for the instrument (once a second), into the craft state's own object. */
function updateNearestPerch(api, dt) {
  scratch.nearestTimer -= dt;
  if (scratch.nearestTimer > 0) return;
  scratch.nearestTimer = NEAREST_PERCH.INTERVAL;
  const record = api.craftState.nearestPerch;
  if (!record) return;
  record.found = findNearestPerch(api, NEAREST_PERCH.RADIUS);
  if (!record.found) return;
  const position = api.player.position;
  record.distance = scratch.nearest.distance;
  record.bearing = bearingTo(position.x, position.z, scratch.nearest.x, scratch.nearest.z);
  record.height = scratch.nearest.y - (position.y - FEET);
  record.kind = scratch.nearest.kind;
}

/** The copilot's perch approach ends once perched, or when the pilot takes the autopilot off. */
function updatePerchApproach(api) {
  const craftState = api.craftState;
  if (!craftState.perchTarget) return;
  if (craftState.perched === true) {
    craftState.perchTarget = null;
    if (api.player.autopilot && api.player.autopilot.enabled) api.setAutopilot({ enabled: false, reason: 'perched' });
  } else if (!(api.player.autopilot && api.player.autopilot.enabled)) {
    craftState.perchTarget = null;
  }
}

const craftAbility = Object.freeze({
  label: 'Screech / fire breath',
  initialState: () => ({
    perched: false,
    perchId: null,
    perchKind: null,
    flapPower: 0,
    wingTuck: 0,
    landing: 0,
    perchedSeconds: 0,
    flapPhase: 0,
    flapAmplitude: 0,
    flapCount: 0,
    flapFrequency: 0,
    soarGain: 0,
    screechCount: 0,
    roarCount: 0,
    fire: false,
    fireIntensity: 0,
    fireBurst: 0,
    lanternsLit: 0,
    takeoffRequest: false,
    perchTarget: null,
    nearestPerch: { found: false, distance: 0, bearing: 0, height: 0, kind: '' },
  }),
  run(api) {
    if (api.skin === 'dragon') {
      if (api.craftState.perched === true) {
        api.craftState.roarCount = (Number(api.craftState.roarCount) || 0) + 1;
        return true;
      }
      api.craftState.fireBurst = Math.max(Number(api.craftState.fireBurst) || 0, FIRE.BURST);
      return true;
    }
    api.craftState.screechCount = (Number(api.craftState.screechCount) || 0) + 1;
    return true;
  },
  update(api, dt) {
    updateFire(api, dt);
    updateNearestPerch(api, dt);
    updatePerchApproach(api);
  },
});

const craftAbilityAlt = Object.freeze({
  label: 'Tuck wings (hold)',
  initialState: () => ({ tuckRequest: false, tuckLatched: false }),
  update(api) {
    const craftState = api.craftState;
    if (craftState.perched === true) craftState.tuckLatched = false;
    craftState.tuckRequest = api.isHeld('craftAbilityAlt') || craftState.tuckLatched === true;
  },
});

// ============================================================================================
// COPILOT (contract h.6): WREN's craftCommand; phrases are regex sources, no capture groups.
// ============================================================================================
const PERCH_NAMES = Object.freeze({ peak: 'a peak', structure: 'a ledge', tree: 'a tree top' });

const copilot = Object.freeze({
  commands: Object.freeze([
    Object.freeze({
      id: 'findPerch',
      phrases: Object.freeze(['\\b(?:find|land on|go to|take (?:me|us) to) (?:a |the )?(?:nearest |closest )?perch\\b', '\\bperch (?:somewhere|now|please)\\b']),
      run(api) {
        const craftState = api.craftState;
        if (craftState.perched === true) return 'We are perched already. Raise the flap power to fly.';
        if (!PERCH_COMMAND_RADII.some((radius) => findNearestPerch(api, radius))) return 'No perch within a kilometre and a half. Try near the trees or the rocks.';
        const target = scratch.nearest;
        craftState.perchTarget = { x: target.x, y: target.y, z: target.z, kind: target.kind, id: target.id };
        const position = api.player.position;
        const bearing = bearingTo(position.x, position.z, target.x, target.z);
        api.setAutopilot({ enabled: true, heading: bearing, speed: 12, reason: 'copilot' });
        return `Found ${PERCH_NAMES[target.kind] ?? 'a perch'} ${Math.round(target.distance)} metres ${compassName(bearing)}. Bringing us in.`;
      },
    }),
    Object.freeze({
      id: 'takeOff',
      phrases: Object.freeze(['\\b(?:take ?off|lift ?off|fly away|launch)\\b']),
      run(api) {
        if (api.craftState.perched !== true) return 'We are flying already.';
        api.craftState.takeoffRequest = true;
        return 'Off we go.';
      },
    }),
    Object.freeze({
      id: 'screech',
      phrases: Object.freeze(['\\b(?:screech|roar|call out|cry out)\\b']),
      run(api) {
        if (api.skin === 'dragon') {
          api.craftState.roarCount = (Number(api.craftState.roarCount) || 0) + 1;
          return 'Roar!';
        }
        api.craftState.screechCount = (Number(api.craftState.screechCount) || 0) + 1;
        return 'Kee-eee!';
      },
    }),
    Object.freeze({
      id: 'fireBreath',
      phrases: Object.freeze(['\\b(?:breathe fire|fire breath|flame on|light it up)\\b']),
      run(api) {
        if (api.skin !== 'dragon') return 'Eagles do not breathe fire. Pick the dragon skin for that.';
        if (api.craftState.perched === true) return 'Not on the perch. Take off first.';
        api.craftState.fireBurst = FIRE.COMMAND_BURST;
        return 'Flame on.';
      },
    }),
    Object.freeze({
      id: 'tuck',
      phrases: Object.freeze(['\\b(?:tuck(?: (?:the|your) wings)?|stoop)\\b']),
      run(api) {
        if (api.craftState.perched === true) return 'Tuck when we are in the air.';
        api.craftState.tuckLatched = api.craftState.tuckLatched !== true;
        return api.craftState.tuckLatched ? 'Wings tucked. Stooping.' : 'Wings out.';
      },
    }),
    Object.freeze({
      id: 'glide',
      phrases: Object.freeze(['\\b(?:glide|stop flapping|wings out)\\b']),
      run(api) {
        api.craftState.tuckLatched = false;
        api.systems.input?.presetThrottle?.(0);
        return 'Gliding. Look for rising air.';
      },
    }),
  ]),
  status(craftState, telemetry) {
    const skin = craftState.skin === 'dragon' ? 'dragon' : 'eagle';
    if (craftState.perched === true) {
      const where = craftState.perchKind === 'ground' || !craftState.perchKind ? 'on the ground' : `on ${PERCH_NAMES[craftState.perchKind]}`;
      return `The ${skin} is perched ${where}. Raise the flap power to take off.`;
    }
    const speed = Math.round((Number(telemetry.airspeed) || 0) * 3.6);
    const power = Math.round((Number(craftState.flapPower) || 0) * 100);
    const climb = Number(telemetry.vario) || 0;
    const mode = (Number(craftState.wingTuck) || 0) > 0.5 ? 'stooping, wings tucked' : power < 3 ? 'gliding' : `flapping at ${power} percent`;
    const air = power < 3 && climb > 0.3 ? `, climbing ${climb.toFixed(1)} metres a second in rising air` : '';
    return `The ${skin} is ${mode} at ${speed} kilometres an hour${air}.`;
  },
});

// ============================================================================================
// PLACEMENT AFTER A CRAFT SWITCH (contract h.4): perched when on a perch (or landed), else gliding.
// ============================================================================================
const SITUATE = Object.freeze({ PERCH_RADIUS: 25, PERCH_BELOW: 20, SLOW: 15, LOW_AGL: 60, LIFT_AGL: 25, LOW_FLAP: 0.6 });
const situateSearch = { found: false, x: 0, y: 0, z: 0, distance: Infinity, fromX: 0, fromY: 0, fromZ: 0 };

function visitSituatePerch(x, y, z) {
  if (situateSearch.fromY - y > SITUATE.PERCH_BELOW || y - situateSearch.fromY > 3) return;
  const distance = Math.hypot(x - situateSearch.fromX, z - situateSearch.fromZ);
  if (distance >= situateSearch.distance) return;
  situateSearch.found = true;
  situateSearch.x = x;
  situateSearch.y = y;
  situateSearch.z = z;
  situateSearch.distance = distance;
}

function situate(situation, api) {
  const position = situation.position;
  // Landed (and not afloat): stand on the ground there.
  if (situation.wasOnGround && !situation.wasOnWater && situation.agl < 4) {
    return { mode: 'perch', position: { x: position.x, y: situation.surfaceHeight, z: position.z }, heading: situation.heading };
  }
  // Slow near a perch: perch on it.
  if (situation.groundSpeed < SITUATE.SLOW) {
    situateSearch.found = false;
    situateSearch.distance = Infinity;
    situateSearch.fromX = position.x;
    situateSearch.fromY = position.y;
    situateSearch.fromZ = position.z;
    api.perchesNear(position.x, position.y, position.z, SITUATE.PERCH_RADIUS + SITUATE.PERCH_BELOW, visitSituatePerch);
    if (situateSearch.found && situateSearch.distance <= SITUATE.PERCH_RADIUS) {
      return { mode: 'perch', position: { x: situateSearch.x, y: situateSearch.y, z: situateSearch.z }, heading: situation.heading };
    }
  }
  // Gliding at the old craft's place (low down: flapping, lifted clear by the controller).
  const low = situation.agl < SITUATE.LOW_AGL;
  const placement = { mode: 'air', heading: situation.trackHeading, throttle: low ? SITUATE.LOW_FLAP : 0 };
  if (situation.agl >= SITUATE.LIFT_AGL) placement.position = { x: position.x, y: position.y, z: position.z };
  return placement;
}

export default Object.freeze({
  id: 'eagle',
  name: 'Eagle / Dragon',
  buildMesh,
  skins: SKINS,
  simProfile,
  collision,
  /**
   * ControlState mapping: the throttle axis is flap power (0 = glide); the stick twists the wings
   * (roll) and pitches body and tail; the pedals twist the tail. The toe brakes and flaps do nothing.
   */
  inputProfile: Object.freeze({ throttle: 'flapPower', antenna: 'zoom', toeBrakes: 'none', flapNotches: 0 }),
  /**
   * Per-craft default bindings: the tuck takes the buttons the gear would use (gamepad X, T.16000M
   * base button 5) and the airbrake key B; Shift+Space and TWCS button 10 keep the second ability.
   */
  bindings: Object.freeze({
    keyboard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([{ type: 'key', code: 'Space', shift: true }, { type: 'key', code: 'KeyB' }]), airbrake: Object.freeze([]) }) }),
    standard: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([{ type: 'button', index: 2 }]), gearToggle: Object.freeze([]) }) }),
    t16000m: Object.freeze({ actions: Object.freeze({ craftAbilityAlt: Object.freeze([{ type: 'button', index: 4 }]), gearToggle: Object.freeze([]) }) }),
  }),
  audioProfile: Object.freeze({ engine: 'creature', airflowSpeed: 30, interiorCutoff: 0, touchdown: 'body', callouts: false, stallHorn: false, varioLift: 0.3, varioSink: -2.5 }),
  capabilities: Object.freeze({ engine: false, chute: false, perch: true, smoke: false, water: false, space: false }),
  cameraRig: Object.freeze({
    // First person from the head (hidden in that view): the beak or the snout below the line of sight.
    eye: EYE,
    chase: chaseRig,
    // On the right wing's shoulder looking back across the body.
    wing: Object.freeze({ position: Object.freeze([0.75, 0.3, 0.25]), target: Object.freeze([0, 0.05, -0.2]) }),
    fpv: null,
    cockpit: Object.freeze({ style: 'custom', near: 0.02, build: buildCreatureView, panel: Object.freeze({ layout: Object.freeze([]) }) }),
  }),
  instruments: Object.freeze(['airspeed', 'altitude', 'heading', 'vsi', 'vario', 'perch']),
  abilities: Object.freeze({ craftAbility, craftAbilityAlt }),
  spawn: Object.freeze({ cruise: 12.5, cruiseThrottle: 0.28, hover: false, relaunch: 'airstart', canStartOnGround: true }),
  // A soft landing on its feet; anything harder on the body (or a wing into the ground) is the soft crash.
  limits: Object.freeze({ vne: 85, gLimit: 6, crashSinkRate: 4.5, bodyStrikeSpeed: 7, floats: false, ceiling: 9000, waterLanding: null }),
  situate,
  copilot,
  journal: Object.freeze({
    stats: Object.freeze([
      Object.freeze({ key: 'eaglePerches', label: 'Perches landed', unit: 'count', op: 'add' }),
      Object.freeze({ key: 'eagleBestSoar', label: 'Best soaring climb', unit: 'metres', op: 'max' }),
      Object.freeze({ key: 'dragonLanternsLit', label: 'Lanterns lit by dragon fire', unit: 'count', op: 'add' }),
    ]),
  }),
  // Contract i.2: thermals, perches and murmurations ahead weigh more for a creature.
  directorProfile: Object.freeze({ favor: Object.freeze({ tags: Object.freeze({ thermal: 1.8, perch: 1.5, murmuration: 1.8 }), categories: Object.freeze({ wildlife: 1.4 }) }) }),
  // Fauna flocks scatter wider from a raptor (contract e.1).
  faunaThreat: 2.5,
});

