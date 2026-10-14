// Recipe 'observatory' (preset 55, the mountaintop observatory): a white telescope building on a level
// pad cut into a summit (the flatten stamp): a drum under a silver dome, a smaller second dome, a
// control building and an antenna mast with a dish, red lamps lit at night. The big dome is alive (the
// engine's movers, posed by this recipe's animate hook): at dusk its shutter slides back over the
// dome, the dome turns its slit toward the target and the telescope inside rises to it; at dawn it
// parks and closes. The target is a comet when one is in the sky, else a meteor shower's radiant (the
// celestial engine's skyTarget), else the moon when it is well up, else a slow survey of the sky.
// The voice (the `observatory` recipe) follows the motors; the shutter's latch clunks. The buildings
// are solid, the dome top and the mast perches, the control building's roof landable.
// Without a flatten stamp (a debug spawn) it stands on a stone plinth on the ground.
import { PALETTE } from '../palette.js';
import { findStamp, frameFromHeading } from '../common.js';
import { paint, shade } from '../meshBuilder.js';
import { roll } from '../../engineKit.js';
import { localBox, localCapsule, localCylinder, localHull, ringPoints } from '../colliders.js';
import { createSiteFrame } from '../heritage.js';

export const OBSERVATORY_DEFAULTS = Object.freeze({
  stamp: 0,
  radius: [8, 10],
  drum: [7, 9],
  slewRate: 3,
  openSeconds: 22,
});

const DEG = Math.PI / 180;
const WHITE = paint(0xf3f1ec);
const DOME = paint(0xd9dde2);
const DOME_SHADE = paint(0xb9bec6);
const STEEL = paint(0x5b6068);
const TUBE = paint(0xe8e6e0);
const RED_LAMP = paint(0xff3324, 3.2);
const DOME_SIDES = 32;
const DOME_RINGS = 7;
/** The slit's half width (m), and how far past the zenith it runs (as a share of the radius, along +z). */
const SLIT_HALF = 1.7;
const SLIT_BACK = 0.3;
/** The shutter slides this far back (rad) when open: the slit is open from the horizon to 72 degrees. */
const SHUTTER_TRAVEL = 1.25;
/** The telescope's elevation limits (deg): above the pad wall, under the open shutter. */
const MIN_ELEVATION = 12;
const MAX_ELEVATION = 70;
/** The dome opens above this night factor and closes below the lower one. */
const OPEN_NIGHT = 0.45;
const CLOSE_NIGHT = 0.25;

export function buildObservatory(context, read) {
  const { rng, body, detail, out } = context;
  const radius = roll(read.range('radius', OBSERVATORY_DEFAULTS.radius, 4, 20), rng);
  const drumHeight = roll(read.range('drum', OBSERVATORY_DEFAULTS.drum, 3, 20), rng);
  const slewRate = read.number('slewRate', OBSERVATORY_DEFAULTS.slewRate, 0.2, 30) * DEG;
  const openSeconds = read.number('openSeconds', OBSERVATORY_DEFAULTS.openSeconds, 2, 300);
  const stamp = findStamp(context.site, 'flatten', read.number('stamp', 0, 0, 16));
  let frame;
  let padY;
  if (stamp) {
    frame = createSiteFrame(stamp.x - context.anchor.x, stamp.z - context.anchor.z, stamp.dirX, stamp.dirZ);
    padY = stamp.y - context.anchor.y;
  } else {
    const heading = frameFromHeading(context.heading);
    frame = createSiteFrame(0, 0, heading.forwardX, heading.forwardZ);
    let high = -Infinity;
    for (const [a, c] of [[0, 0], [-30, -22], [-30, 22], [30, -22], [30, 22]]) high = Math.max(high, context.ground(frame.x(a, c), frame.z(a, c)));
    padY = high + 0.6;
    body.setPaint(shade(PALETTE.concreteDark, 0.95)).box(0, padY - 6, 0, 52, 12, 72, frame.yaw);
    out.colliders.push(localBox('plinth', 0, padY - 6, 0, 52, 12, 72, frame.yaw, { surface: 'stone', landable: true }));
  }
  const yaw = frame.yaw;
  const at = (along, across) => [frame.x(along, across), frame.z(along, across)];

  // ---- The main drum and the dome's centre ----
  const [domeX, domeZ] = at(-6, 0);
  body.setPaint(WHITE).lathe(domeX, padY - 1, domeZ, [[radius + 0.3, 0], [radius + 0.3, 0.9], [radius, 1.2], [radius, drumHeight + 1]], DOME_SIDES, { closeTop: true });
  // A door and a ring of small windows.
  const [doorX, doorZ] = at(-6 + radius + 0.02, 0);
  body.setPaint(STEEL).box(doorX, padY + 1.3, doorZ, 1.8, 2.6, 0.3, yaw);
  for (let index = 0; index < 8; index++) {
    const angle = (index / 8) * Math.PI * 2 + 0.2;
    body.setPaint(paint(0x2c3138)).box(domeX + Math.sin(angle) * (radius + 0.03), padY + drumHeight * 0.65, domeZ - Math.cos(angle) * (radius + 0.03), 0.9, 0.7, 0.2, angle);
  }
  const domeCentreY = padY + drumHeight;
  // The catwalk ring at the dome's foot and red lamps on it.
  detail.setPaint(STEEL).lathe(domeX, domeCentreY - 0.35, domeZ, [[radius + 0.9, 0], [radius + 0.9, 0.12]], DOME_SIDES, { closeTop: true, closeBottom: true });
  for (let index = 0; index < 4; index++) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
    body.setPaint(RED_LAMP).box(domeX + Math.sin(angle) * (radius + 0.85), domeCentreY + 0.05, domeZ - Math.cos(angle) * (radius + 0.85), 0.3, 0.3, 0.3);
  }
  out.colliders.push(localCylinder('drum', domeX, padY - 1, domeZ, radius + 0.35, drumHeight + 1, { surface: 'stone' }));
  const domePoints = [];
  for (const [share, height] of [[1, 0], [0.92, 0.4], [0.7, 0.72], [0.38, 0.93]]) domePoints.push(...ringPoints(domeX, domeCentreY + height * radius, domeZ, radius * share + 0.3, 8));
  domePoints.push([domeX, domeCentreY + radius + 0.3, domeZ]);
  out.colliders.push(localHull('dome', domePoints, { surface: 'metal', perch: { x: domeX, y: domeCentreY + radius + 0.4, z: domeZ } }));

  // ---- The pier under the telescope (inside the drum) ----
  const pivotY = domeCentreY + 0.6;
  body.setPaint(STEEL).prism(domeX, domeCentreY - 1, domeZ, 8, 1.1, 0.8, 1.6);

  // ---- The movers: the dome, its shutter and the telescope ----
  const dome = context.addMover({ name: 'dome', kind: 'body' });
  buildDomeShell(dome.builder, radius, false);
  const shutter = context.addMover({ name: 'shutter', kind: 'body' });
  buildDomeShell(shutter.builder, radius + 0.12, true);
  const telescope = context.addMover({ name: 'telescope', kind: 'body' });
  buildTelescope(telescope.builder, radius);

  // ---- The second dome, the control building and the mast ----
  const [smallX, smallZ] = at(16, -12);
  const smallRadius = radius * 0.45;
  body.setPaint(WHITE).prism(smallX, padY - 0.6, smallZ, 18, smallRadius, smallRadius, 4.6);
  body.setPaint(DOME).lathe(smallX, padY + 4, smallZ, [[smallRadius + 0.15, 0], [smallRadius * 0.92, smallRadius * 0.4], [smallRadius * 0.7, smallRadius * 0.72], [smallRadius * 0.38, smallRadius * 0.93], [0, smallRadius + 0.15]], 18, { closeBottom: true });
  out.colliders.push(localCylinder('smallDrum', smallX, padY - 0.6, smallZ, smallRadius + 0.1, 4.6 + smallRadius * 0.9, { surface: 'metal', perch: { x: smallX, y: padY + 4.2 + smallRadius, z: smallZ } }));
  const [houseX, houseZ] = at(17, 10);
  body.setPaint(WHITE).box(houseX, padY + 2, houseZ, 9, 4.6, 14, yaw);
  body.setPaint(shade(STEEL, 1.2)).box(houseX, padY + 4.45, houseZ, 9.6, 0.35, 14.6, yaw);
  for (let index = 0; index < 3; index++) {
    const [wx, wz] = at(17 - 4.5 + index * 4.5, 10 - 4.53);
    body.setPaint(paint(0x2c3138)).box(wx, padY + 2.4, wz, 1.6, 1.2, 0.2, yaw + Math.PI / 2);
  }
  out.colliders.push(localBox('control', houseX, padY + 2.2, houseZ, 9.6, 4.9, 14.6, yaw, { surface: 'stone', landable: true, perch: { x: houseX, y: padY + 4.7, z: houseZ } }));
  const [mastX, mastZ] = at(26, 2);
  const mastHeight = roll([16, 22], rng);
  detail.setPaint(STEEL);
  for (let index = 0; index < 3; index++) {
    const angle = (index / 3) * Math.PI * 2;
    detail.beam(mastX + Math.sin(angle) * 0.7, padY, mastZ - Math.cos(angle) * 0.7, mastX + Math.sin(angle) * 0.15, padY + mastHeight, mastZ - Math.cos(angle) * 0.15, 0.12, 0.12);
  }
  body.setPaint(STEEL).prism(mastX, padY, mastZ, 6, 0.35, 0.12, mastHeight);
  body.setPaint(RED_LAMP).box(mastX, padY + mastHeight + 0.2, mastZ, 0.45, 0.45, 0.45);
  out.colliders.push(localCapsule('mast', mastX, padY, mastZ, mastX, padY + mastHeight, mastZ, 0.8, { surface: 'metal', perch: { x: mastX, y: padY + mastHeight + 0.6, z: mastZ } }));
  // The dish on its own short tower beside the mast.
  const [dishX, dishZ] = at(25, 14);
  body.setPaint(STEEL).prism(dishX, padY, dishZ, 8, 0.6, 0.45, 5);
  body.setTransform(dishX, padY + 5.6, dishZ, yaw + 0.7, 0.9, 0);
  body.setPaint(WHITE).lathe(0, 0, 0, [[0.2, 0], [1.5, 0.35], [2.6, 0.9], [2.8, 1.05]], 14, { closeBottom: true });
  body.resetTransform();
  out.colliders.push(localCapsule('dish', dishX, padY, dishZ, dishX, padY + 6.6, dishZ, 2.4, { surface: 'metal' }));
  // A low wall around the pad.
  const halfAlong = stamp ? stamp.length / 2 + stamp.margin * 0.6 : 34;
  const halfAcross = stamp ? stamp.width / 2 + stamp.margin * 0.6 : 24;
  for (const [a0, c0, a1, c1] of [[-halfAlong, -halfAcross, halfAlong, -halfAcross], [halfAlong, -halfAcross, halfAlong, halfAcross], [halfAlong, halfAcross, -halfAlong, halfAcross], [-halfAlong, halfAcross, -halfAlong, -halfAcross]]) {
    const [x0, z0] = at(a0, c0);
    const [x1, z1] = at(a1, c1);
    detail.setPaint(PALETTE.concreteDark).beam(x0, padY + 0.45, z0, x1, padY + 0.45, z1, 0.5, 0.9);
  }

  // ---- The animate hook: the dome follows the target at night ----
  out.animate = animateObservatory;
  out.animateState = {
    /** [dome yaw, shutter open 0..1, telescope elevation (rad), open flag]. */
    motion: new Float64Array([rng() * Math.PI * 2, 0, MAX_ELEVATION * DEG, 0]),
    target: new Float64Array(3),
    /** [dome x, centre y, z, pivot y, survey azimuth, slew rate (rad/s), seconds to open, mover indices dome, shutter, telescope]. */
    config: new Float64Array([domeX, domeCentreY, domeZ, pivotY, 0, slewRate, openSeconds, dome.index, shutter.index, telescope.index]),
  };
  out.animateState.config[4] = out.animateState.motion[0];
  out.audioPoint = [domeX, domeCentreY, domeZ];
  out.radius = Math.max(out.radius, 60);
}

/**
 * The observatory's animate hook (one function for every observatory; its instance's numbers in
 * state.custom): opens at dusk and closes at dawn (the latch clunks), turns the dome's slit to the
 * target and raises the telescope to it, and drives the voice with the motors' work. Allocation-free.
 */
function animateObservatory(state, env) {
  const custom = state.custom;
  const motion = custom.motion;
  const target = custom.target;
  const config = custom.config;
  const clock = env.clock;
  const dt = clock[1];
  const night = clock[2];
  const slewRate = config[5];
  // The target azimuth and elevation (rad): a comet or a radiant, else the moon well up, else a survey.
  let azimuth = config[4] + clock[0] * 0.0015;
  let elevation = 55 * DEG;
  if (env.skyTarget(target) > 0) {
    azimuth = Math.atan2(target[0], -target[2]);
    elevation = Math.asin(Math.min(1, Math.max(-1, target[1])));
  } else if (env.moonDirection !== null && env.moonDirection.y > 0.2) {
    azimuth = Math.atan2(env.moonDirection.x, -env.moonDirection.z);
    elevation = Math.asin(Math.min(1, env.moonDirection.y));
  }
  if (elevation < MIN_ELEVATION * DEG) elevation = MIN_ELEVATION * DEG;
  else if (elevation > MAX_ELEVATION * DEG) elevation = MAX_ELEVATION * DEG;
  // Open at dusk, closed at dawn.
  const wasOpen = motion[3];
  const wantOpen = night > OPEN_NIGHT ? 1 : night < CLOSE_NIGHT ? 0 : wasOpen;
  if (wantOpen !== wasOpen) latch(motion, env, wantOpen);
  const openStep = dt / config[6];
  const shutterBefore = motion[1];
  motion[1] = wantOpen === 1 ? Math.min(1, motion[1] + openStep) : Math.max(0, motion[1] - openStep);
  // Slew the dome (the shortest way round) and the telescope; parked by day, pointing up.
  let turn = azimuth - motion[0];
  turn -= Math.PI * 2 * Math.floor((turn + Math.PI) / (Math.PI * 2));
  const yawStep = slewRate * dt;
  let yawMove = 0;
  if (wantOpen === 1) yawMove = turn > yawStep ? yawStep : turn < -yawStep ? -yawStep : turn;
  motion[0] += yawMove;
  const wantElevation = wantOpen === 1 && motion[1] > 0.6 ? elevation : MAX_ELEVATION * DEG;
  const elevationStep = slewRate * 0.7 * dt;
  const lift = wantElevation - motion[2];
  motion[2] += lift > elevationStep ? elevationStep : lift < -elevationStep ? -elevationStep : lift;
  // The voice: a hum, louder while a motor runs.
  let work = 0.12;
  if (dt > 0 && Math.abs(yawMove) > 1e-5) work += 0.5;
  if (motion[1] !== shutterBefore) work += 0.4;
  state.level[0] = work;
  const poses = state.poses;
  let base = config[7] * 8;
  poses[base] = config[0];
  poses[base + 1] = config[1];
  poses[base + 2] = config[2];
  poses[base + 3] = motion[0];
  base = config[8] * 8;
  poses[base] = config[0];
  poses[base + 1] = config[1];
  poses[base + 2] = config[2];
  poses[base + 3] = motion[0];
  poses[base + 4] = motion[1] * SHUTTER_TRAVEL;
  base = config[9] * 8;
  poses[base] = config[0];
  poses[base + 1] = config[3];
  poses[base + 2] = config[2];
  poses[base + 3] = motion[0];
  poses[base + 4] = motion[2];
}

/** Event work: the shutter's latch as it starts to open or close. */
function latch(motion, env, open) {
  motion[3] = open;
  env.trigger('clunk');
}

/**
 * The dome in its own frame (its centre at the origin, the slit facing -z): a hemisphere of
 * latitude rings with the slit band cut out (from the horizon in front over the zenith); or, for the
 * shutter, only that band (slightly larger, so it rides outside the dome).
 */
function buildDomeShell(builder, radius, shutterOnly) {
  const vertex = (ring, side) => {
    const latitude = (ring / DOME_RINGS) * (Math.PI / 2);
    const longitude = (side / DOME_SIDES) * Math.PI * 2;
    const flat = Math.cos(latitude) * radius;
    return [Math.sin(longitude) * flat, Math.sin(latitude) * radius, -Math.cos(longitude) * flat];
  };
  for (let ring = 0; ring < DOME_RINGS; ring++) {
    for (let side = 0; side < DOME_SIDES; side++) {
      const a = vertex(ring, side);
      const b = vertex(ring + 1, side);
      const c = vertex(ring + 1, side + 1);
      const d = vertex(ring, side + 1);
      const centreX = (a[0] + b[0] + c[0] + d[0]) / 4;
      const centreZ = (a[2] + b[2] + c[2] + d[2]) / 4;
      const inSlit = Math.abs(centreX) < SLIT_HALF && centreZ < radius * SLIT_BACK;
      if (inSlit !== shutterOnly) continue;
      builder.setPaint(ring % 2 === 0 ? DOME : DOME_SHADE);
      // Counter-clockwise seen from outside.
      if (ring === DOME_RINGS - 1) builder.triangle(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
      else builder.quad(a, b, c, d);
    }
  }
  if (!shutterOnly) {
    // The slit's inner walls: dark, so the open slit reads from outside.
    builder.setPaint(paint(0x1c1f24)).lathe(0, -0.2, 0, [[radius - 0.25, 0], [radius - 0.25, 0.25]], DOME_SIDES, { closeTop: true });
  }
}

/**
 * The telescope in its own frame (the pivot at the origin, the tube along -z): a white truss tube
 * with a dark aperture, a counterweight behind the pivot and the fork's cross axis.
 */
function buildTelescope(builder, domeRadius) {
  const length = Math.min(domeRadius * 0.8, 7.5);
  const tube = Math.min(0.9, domeRadius * 0.1);
  // A lathe along local +y turned to -z (a tilt of -90 degrees about local x).
  builder.setTransform(0, 0, 0, 0, -Math.PI / 2, 0);
  builder.setPaint(TUBE).lathe(0, -length * 0.3, 0, [[tube * 1.1, 0], [tube, length * 0.25], [tube * 0.95, length]], 12, { closeBottom: true });
  builder.setPaint(paint(0x101215)).lathe(0, length * 0.7 - 0.02, 0, [[tube * 0.85, 0], [tube * 0.85, 0.05]], 12, { closeTop: true });
  builder.setPaint(STEEL).lathe(0, -length * 0.45, 0, [[tube * 1.3, 0], [tube * 1.3, length * 0.12]], 10, { closeBottom: true, closeTop: true });
  builder.resetTransform();
  builder.setPaint(STEEL).box(0, 0, 0, tube * 3.4, tube * 0.5, tube * 0.8);
}
