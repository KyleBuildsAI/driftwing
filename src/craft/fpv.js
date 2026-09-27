// FPV DRONE: a 5-inch freestyle / racing quad, built from code in the v1 glider's style (flat-shaded,
// vertex-coloured lofts in the v1 palette). Carbon X frame on a bottom plate with a top plate on
// standoffs, four motors with orange bells and three-blade props whose blur discs follow each motor's
// speed, a battery on top under an orange strap, the FPV camera in an orange TPU cage tilted up at the
// camera's uptilt, a rear antenna and LED strips under the rear arms that show the flight mode (teal
// angle, orange rate, red blink when disarmed).
// CLASSIC flies it with v1's forgiving arcade rules at quad speeds (arcadeProfile.hover describes the
// hover handling); SIM flies SimQuad (src/flight/SimQuad.js): thrust-to-weight 8:1, about 150 km/h
// flat out, Betaflight rates (670 deg/s at full stick, expo 0.3), angle mode and altitude hold.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { DEG, clamp } from '../core/util.js';
import {
  PALETTE, createMeshBuilder, getCraftMaterials, addSolid, createPropDisc, disposeCraftMesh,
} from './kit.js';
import { DEFAULT_QUAD_RATES, QUAD_VISUAL_PROP_SPEED } from '../flight/SimQuad.js';

const { uniform } = TSL;

// ============================================================================================
// CLASSIC: v1's arcade rules at quad speeds. `hover` describes the hovering handling for the arcade
// model's hover extension (m/s, degrees): full forward stick flies at maxSpeed, full throttle climbs
// at climbRate, the stick yaws at yawRate and tilts up to bankLimit / pitchLimit.
// ============================================================================================
const arcadeProfile = Object.freeze({
  // m/s: a lazy 30 km/h, cruise about 80 km/h, flat out about 140 km/h, boosted about 170 km/h.
  SPEED: Object.freeze({ MIN: 8, STALL: 10, CRUISE: 22, MAX: 39, BOOST_MAX: 47 }),
  GRAVITY: 9.81,
  // Snappy: plenty of drag and thrust per m/s, so the throttle bites at once.
  DRAG_COEFFICIENT: 0.012,
  THROTTLE_SPEED_EXPONENT: 1,
  THROTTLE_RATE: 1.4,
  INDUCED_DRAG: 0.2,
  INDUCED_MAX_EXTRA_G: 4,
  MAX_PITCH_RATE: 120 * DEG,
  MAX_ROLL_RATE: 240 * DEG,
  MAX_YAW_RATE: 90 * DEG,
  MAX_BANK: 70 * DEG,
  BANK_GAIN: 4.5,
  FINE_BANK_SCALE: 0.5,
  YAW_BANK: 14 * DEG,
  PITCH_LIMIT_START: 55 * DEG,
  PITCH_LIMIT_RANGE: 25 * DEG,
  TURN_GAIN: 2.4,
  MAX_TURN_RATE: 110 * DEG,
  BANK_NOSE_DROP: 3 * DEG,
  BANK_SETTLE_PITCH: 3 * DEG,
  FINE_CONTROL_SCALE: 0.45,
  AUTO_LEVEL_DELAY: 0.8,
  STALL_EXIT_MARGIN: 2,
  STALL_NOSE_TARGET: -12 * DEG,
  HIGH_SPEED_PITCH_START: 32,
  CUSHION_HEIGHT: 8,
  IMPACT_WARNING_SECONDS: 1.8,
  IMPACT_FULL_SECONDS: 0.5,
  CUSHION_PULL_RATE: 90 * DEG,
  GUARD_PROBE_SECONDS: Object.freeze([0.8, 1.6, 2.6]),
  GUARD_MARGIN: 8,
  GUARD_MIN_SPEED: 8,
  GUARD_EVADE_GRADIENT: Math.tan(35 * DEG),
  GUARD_EVADE_BANK: 60 * DEG,
  CEILING_BAND: 260,
  BOOST_DURATION: 1.6,
  BOOST_COOLDOWN: 5,
  BARREL_ROLL_DURATION: 0.7,
  BARREL_ROLL_RADIUS: 0.4,
  AUTOPILOT: Object.freeze({
    MAX_BANK: 35 * DEG,
    MAX_PITCH: 10 * DEG,
    TERRAIN_PITCH: 15 * DEG,
    CLEARANCE: 50,
    RING_CLEARANCE: 25,
    MIN_ALTITUDE: 40,
    CRUISE_THROTTLE: 0.55,
    OVERRIDE_INPUT: 0.35,
    OVERRIDE_SECONDS: 0.25,
    TERRAIN_MAX_PITCH: 25 * DEG,
    LOOKAHEAD_DISTANCES: Object.freeze([0, 30, 60, 100, 160, 240, 340, 480]),
    PATH_LOOKAHEAD_DISTANCES: Object.freeze([50, 120, 220]),
    WAYPOINT_STEERING: Object.freeze({ BANK_PER_DEGREE: 1.4, MAX_BANK: 35 * DEG, DAMPING: 2, MAX_ROLL_RATE: 60 * DEG }),
    RING_STEERING: Object.freeze({ BANK_PER_DEGREE: 2.2, MAX_BANK: 45 * DEG, DAMPING: 3.2, MAX_ROLL_RATE: 80 * DEG }),
    RING_MAX_PITCH: 15 * DEG,
    RING_MIN_TIME_TO_RING: 1,
    RING_VERTICAL_SPEED_GAIN: 0.03,
    RING_LOOKAHEAD_MARGIN: 80,
    RING_TRACK_LEAD_SECONDS: 1.8,
    RING_TRACK_LEAD_MIN: 30,
    RING_TRACK_LEAD_MAX: 70,
  }),
  LOAD: Object.freeze({ PULL_SHARE: 0.25, KNEE: 4, CAP: 6, MIN: -1.5, SMOOTHING: 7, MIN_BANK_COS: 0.2, BARREL_ROLL_EXTRA: 1 }),
  SURFACE_TURN_SHARE: 0.2,
  hover: Object.freeze({ maxSpeed: 30, climbRate: 10, yawRate: 180, bankLimit: 45, pitchLimit: 45 }),
});

// ============================================================================================
// SIM: a 5-inch quad for SimQuad (src/flight/SimQuad.js). Targets first, then the physical
// parameters that meet them, then the contact points. Positions are body axes relative to the mesh
// origin (x right, y up, z aft; m). tools/lab/fpv.mjs measures the targets in flight.
// ============================================================================================
/** Motor centres (x, z) on the X frame: a 225 mm diagonal, a touch longer than wide. */
const MOTOR_X = 0.08;
const MOTOR_Z = 0.078;
const PROP_RADIUS = 0.0635;
const PROP_Y = 0.028;

const simProfile = Object.freeze({
  model: 'quad',
  targets: Object.freeze({
    thrustToWeight: 8,
    hoverThrottle: 0.32, // share of throttle stick at sea level
    topSpeed: 41.7, // m/s = 150 km/h, level flight at full throttle
    maxRate: 670, // deg/s at full stick (Betaflight rates)
  }),
  mass: 0.65, // kg all-up: frame, four 2207 motors, 6S 1100 mAh pack, camera, VTX
  thrustToWeight: 8,
  // kg m^2 about body x (pitch), y (yaw) and z (roll).
  inertia: Object.freeze({ pitch: 0.0021, yaw: 0.0036, roll: 0.0018 }),
  // The battery on top lifts the centre of mass above the frame plate.
  centerOfMass: Object.freeze([0, 0.016, 0]),
  // Betaflight motor order (props in): 1 rear right CW, 2 front right CCW, 3 rear left CCW, 4 front left CW.
  motors: Object.freeze([
    Object.freeze({ id: 'rearRight', position: Object.freeze([MOTOR_X, PROP_Y, MOTOR_Z]), spin: 'cw' }),
    Object.freeze({ id: 'frontRight', position: Object.freeze([MOTOR_X, PROP_Y, -MOTOR_Z]), spin: 'ccw' }),
    Object.freeze({ id: 'rearLeft', position: Object.freeze([-MOTOR_X, PROP_Y, MOTOR_Z]), spin: 'ccw' }),
    Object.freeze({ id: 'frontLeft', position: Object.freeze([-MOTOR_X, PROP_Y, -MOTOR_Z]), spin: 'cw' }),
  ]),
  motor: Object.freeze({
    // Dynamic idle: the share of full motor speed an armed motor never drops below.
    idle: 0.055,
    maxRpm: 31000, // loaded, on 6S
    spoolUpSeconds: 0.022,
    spoolDownSeconds: 0.03,
    propDiameter: 0.127, // 5 inch, 4.3 inch pitch
    // Prop drag torque per newton of thrust (m): what yaws the frame.
    torqueRatio: 0.016,
    // Axial inflow (m/s) at which a prop at full speed stops biting (pitch x rev/s), and how hard the
    // thrust falls toward it; bounds on the resulting thrust factor.
    pitchSpeed: 56,
    inflowLapse: 0.42,
    inflowMin: 0.3,
    inflowMax: 1.1,
  }),
  aero: Object.freeze({
    // Drag area (Cd x A, m^2) along body x (side), y (top: props and plates) and z (front).
    dragArea: Object.freeze([0.014, 0.028, 0.012]),
    // Rotor in-plane drag (N per m/s of air across the discs) at full motor speed.
    rotorDrag: 0.06,
    // N m s about x, y, z.
    rotationalDamping: Object.freeze([0.0025, 0.002, 0.0025]),
    // Prop wash: descending into the wake between onset and full times the hover inflow (about 7 m/s),
    // fading out with in-plane speed up to clearSpeed; costs up to `loss` of the thrust and shakes the
    // frame with up to `shake` N m.
    propWash: Object.freeze({ onset: 0.35, full: 1.2, clearSpeed: 9, loss: 0.25, shake: 0.05 }),
    turbulenceShake: 0.012,
  }),
  // The flight controller's tune.
  controller: Object.freeze({
    // Rate loop: angular acceleration (rad/s^2) per rad/s of error (p), per rad of accumulated error
    // (i), per rad/s^2 of measured change (d), and the share of the setpoint's change fed forward.
    // I-term relax: the I-term stops learning while the setpoint moves faster than relaxThreshold
    // (deg/s away from its relaxSeconds low-pass), so flips and rolls do not wind it up.
    rate: Object.freeze({ p: 42, i: 70, d: 0.45, feedForward: 1, integralLimit: 60, accelerationLimit: 2600, relaxSeconds: 0.011, relaxThreshold: 40 }),
    // Angle mode: tilt limit (deg), level-loop strength (1/s) and the rate it may command (deg/s).
    angleLimit: 55,
    angleStrength: 8,
    angleRateLimit: 400,
    // Turtle mode: motor speed of the reversed side.
    turtlePower: 0.5,
    // Altitude hold (angle mode): throttle deadband around the centre, climb and descent at full
    // deflection (m/s), how far the stick must move before it takes over from the hold after hold
    // engages, altitude and climb-rate gains, and a gentle final descent near the ground.
    altitudeHold: Object.freeze({
      deadband: 0.1,
      maxClimb: 6,
      maxDescent: 4,
      latchMove: 0.04,
      positionGain: 1.2,
      velocityGain: 3.2,
      integralGain: 2.5,
      integralLimit: 4,
      accelerationLimit: 12,
      landingDescent: 1,
      landingHeight: 4,
    }),
  }),
  // Four feet under the motors (gear: a quad lands on them) and body points: battery top, antenna
  // and the prop tips (the front tip covers the camera, which sits inside the frame). Springs are soft for a 650 g craft so light touches bounce.
  contacts: Object.freeze([
    Object.freeze({ id: 'footRearRight', kind: 'skid', gear: true, position: Object.freeze([MOTOR_X, -0.009, MOTOR_Z]), spring: 1200, damping: 8, friction: 0.6 }),
    Object.freeze({ id: 'footFrontRight', kind: 'skid', gear: true, position: Object.freeze([MOTOR_X, -0.009, -MOTOR_Z]), spring: 1200, damping: 8, friction: 0.6 }),
    Object.freeze({ id: 'footRearLeft', kind: 'skid', gear: true, position: Object.freeze([-MOTOR_X, -0.009, MOTOR_Z]), spring: 1200, damping: 8, friction: 0.6 }),
    Object.freeze({ id: 'footFrontLeft', kind: 'skid', gear: true, position: Object.freeze([-MOTOR_X, -0.009, -MOTOR_Z]), spring: 1200, damping: 8, friction: 0.6 }),
    Object.freeze({ id: 'batteryFrontLeft', kind: 'body', gear: false, position: Object.freeze([-0.019, 0.07, -0.038]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'batteryFrontRight', kind: 'body', gear: false, position: Object.freeze([0.019, 0.07, -0.038]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'batteryRearLeft', kind: 'body', gear: false, position: Object.freeze([-0.019, 0.07, 0.038]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'batteryRearRight', kind: 'body', gear: false, position: Object.freeze([0.019, 0.07, 0.038]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'antenna', kind: 'body', gear: false, position: Object.freeze([0, 0.08, 0.1]), spring: 600, damping: 3, friction: 0.5 }),
    Object.freeze({ id: 'propFront', kind: 'body', gear: false, position: Object.freeze([0, PROP_Y, -MOTOR_Z - PROP_RADIUS]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'propRear', kind: 'body', gear: false, position: Object.freeze([0, PROP_Y, MOTOR_Z + PROP_RADIUS]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'propLeft', kind: 'body', gear: false, position: Object.freeze([-MOTOR_X - PROP_RADIUS, PROP_Y, 0]), spring: 900, damping: 5, friction: 0.5 }),
    Object.freeze({ id: 'propRight', kind: 'body', gear: false, position: Object.freeze([MOTOR_X + PROP_RADIUS, PROP_Y, 0]), spring: 900, damping: 5, friction: 0.5 }),
  ]),
});

// ============================================================================================
// MESH (local frame: nose -z, up +y, origin at the centre of the frame's bottom plate)
// ============================================================================================
/**
 * FPV camera: the cage pivots on its side-plate bolt (body axes) and tilts up by UPTILT; the lens sits
 * LENS_DISTANCE ahead of the bolt along the tilted optical axis. The camera view reads cameraRig.fpv
 * (the lens position and the same uptilt), so the view and the model always agree.
 */
const FPV_CAMERA = (() => {
  const pivot = Object.freeze([0, 0.015, -0.047]);
  const uptilt = 25;
  const lensDistance = 0.0182;
  const lens = Object.freeze([0, pivot[1] + lensDistance * Math.sin(uptilt * DEG), pivot[2] - lensDistance * Math.cos(uptilt * DEG)]);
  return Object.freeze({ PIVOT: pivot, UPTILT: uptilt, POSITION: lens, NEAR: 0.02 });
})();
const PLATE = Object.freeze({ BOTTOM: -0.004, TOP: 0, TOP_PLATE_Y: 0.028, TOP_PLATE_THICKNESS: 0.003 });
const BATTERY = Object.freeze({ HALF_X: 0.018, BOTTOM: 0.031, TOP: 0.066, HALF_Z: 0.037 });
const MOTOR = Object.freeze({ BASE_RADIUS: 0.0135, BELL_RADIUS: 0.0142, BASE_TOP: 0.006, BELL_TOP: 0.019 });
const CARBON = new THREE.Color(0x24262d);

/** A closed ring of `sides` points around the y axis at height y (radius, centred on x/z). */
function yRing(centerX, y, centerZ, radius, sides, startDegrees = 0) {
  const ring = [];
  for (let index = 0; index < sides; index++) {
    const angle = (startDegrees + (index * 360) / sides) * DEG;
    ring.push([centerX + radius * Math.cos(angle), y, centerZ + radius * Math.sin(angle)]);
  }
  return ring;
}

/** An axis-aligned box from two corners. */
function buildBox(builder, min, max, tint, capTint = tint) {
  const ring = (y) => [[min[0], y, min[2]], [max[0], y, min[2]], [max[0], y, max[2]], [min[0], y, max[2]]];
  builder.loft([ring(min[1]), ring(max[1])], () => tint, { capStart: capTint, capEnd: capTint });
}

/** A vertical cylinder (axis along y) from y0 to y1. */
function buildCylinder(builder, centerX, centerZ, y0, y1, radius, sides, tint, capTint = tint) {
  builder.loft([yRing(centerX, y0, centerZ, radius, sides), yRing(centerX, y1, centerZ, radius, sides)], () => tint, { capStart: capTint, capEnd: capTint });
}

/** A straight faceted bar from a to b with a rectangular section (half width along widthAxis). */
function buildBar(builder, from, to, halfWidth, halfDepth, tint, widthAxis = [1, 0, 0]) {
  const direction = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize();
  const width = new THREE.Vector3(widthAxis[0], widthAxis[1], widthAxis[2]);
  width.addScaledVector(direction, -width.dot(direction)).normalize();
  const depth = new THREE.Vector3().crossVectors(direction, width).normalize();
  const ring = (point) => [[halfWidth, halfDepth], [-halfWidth, halfDepth], [-halfWidth, -halfDepth], [halfWidth, -halfDepth]].map(([along, across]) => [
    point[0] + width.x * along + depth.x * across,
    point[1] + width.y * along + depth.y * across,
    point[2] + width.z * along + depth.z * across,
  ]);
  builder.loft([ring(from), ring(to)], () => tint, { capStart: tint, capEnd: tint });
}

/**
 * The unibody X: a central plate and four arms that widen toward round motor pads. Each arm is one
 * loft from the plate to the pad (plan-view outline swept down by the plate thickness).
 */
function buildFrame(builder) {
  // Central plate: an octagon, charcoal carbon.
  const plate = (y) => [[-0.024, y, -0.042], [0.024, y, -0.042], [0.03, y, -0.03], [0.03, y, 0.03], [0.024, y, 0.042], [-0.024, y, 0.042], [-0.03, y, 0.03], [-0.03, y, -0.03]];
  builder.loft([plate(PLATE.BOTTOM), plate(PLATE.TOP)], () => CARBON, { capStart: CARBON, capEnd: CARBON });
  for (const sideX of [1, -1]) {
    for (const sideZ of [1, -1]) {
      const root = [0.018 * sideX, 0, 0.026 * sideZ];
      const tip = [MOTOR_X * sideX, 0, MOTOR_Z * sideZ];
      buildBar(builder, [root[0], (PLATE.BOTTOM + PLATE.TOP) / 2, root[2]], [tip[0], (PLATE.BOTTOM + PLATE.TOP) / 2, tip[2]], 0.0072, (PLATE.TOP - PLATE.BOTTOM) / 2, CARBON, [0, 1, 0]);
      // Motor pad.
      buildCylinder(builder, tip[0], tip[2], PLATE.BOTTOM, PLATE.TOP, 0.0145, 10, CARBON);
    }
  }
  // Top plate on four standoffs.
  const topPlate = (y) => [[-0.02, y, -0.046], [0.02, y, -0.046], [0.022, y, -0.04], [0.022, y, 0.04], [0.02, y, 0.046], [-0.02, y, 0.046], [-0.022, y, 0.04], [-0.022, y, -0.04]];
  builder.loft([topPlate(PLATE.TOP_PLATE_Y), topPlate(PLATE.TOP_PLATE_Y + PLATE.TOP_PLATE_THICKNESS)], () => CARBON, { capStart: CARBON, capEnd: CARBON });
  for (const sideX of [1, -1]) {
    for (const sideZ of [1, -1]) buildCylinder(builder, 0.017 * sideX, 0.034 * sideZ, PLATE.TOP, PLATE.TOP_PLATE_Y, 0.0025, 6, PALETTE.charcoal);
  }
  // Flight-controller stack between the plates, the VTX peeking out at the back.
  buildBox(builder, [-0.015, 0.003, -0.015], [0.015, 0.012, 0.015], PALETTE.charcoal);
  buildBox(builder, [-0.012, 0.014, 0.012], [0.012, 0.02, 0.036], PALETTE.charcoal, PALETTE.orange);
}

/** Battery pack on the top plate: cream wrap with an orange label band, charcoal ends. */
function buildBattery(builder) {
  const { HALF_X, BOTTOM, TOP, HALF_Z } = BATTERY;
  const stations = [-HALF_Z, -HALF_Z + 0.004, -0.008, 0.008, HALF_Z - 0.004, HALF_Z];
  const ring = (z) => [[-HALF_X, BOTTOM, z], [HALF_X, BOTTOM, z], [HALF_X, TOP - 0.004, z], [HALF_X - 0.004, TOP, z], [-HALF_X + 0.004, TOP, z], [-HALF_X, TOP - 0.004, z]];
  builder.loft(stations.map(ring), (segment, edge) => {
    if (segment === 0 || segment === stations.length - 2) return PALETTE.charcoal;
    if (segment === 2) return PALETTE.orange;
    return edge === 0 ? PALETTE.creamShade : PALETTE.cream;
  }, { capStart: PALETTE.charcoal, capEnd: PALETTE.charcoal });
  // Balance lead and XT60 at the back.
  buildBox(builder, [-0.006, BOTTOM + 0.004, HALF_Z], [0.006, BOTTOM + 0.012, HALF_Z + 0.012], PALETTE.creamShade, PALETTE.orange);
}

/** The orange battery strap: over the pack and down both sides to the top plate. */
function buildStrap(builder) {
  const halfWidth = 0.009;
  const lift = 0.0015;
  const outline = [
    [-BATTERY.HALF_X - lift, PLATE.TOP_PLATE_Y], [-BATTERY.HALF_X - lift, BATTERY.TOP - 0.004], [-BATTERY.HALF_X + 0.004, BATTERY.TOP + lift],
    [BATTERY.HALF_X - 0.004, BATTERY.TOP + lift], [BATTERY.HALF_X + lift, BATTERY.TOP - 0.004], [BATTERY.HALF_X + lift, PLATE.TOP_PLATE_Y],
  ];
  for (let index = 0; index < outline.length - 1; index++) {
    const [x0, y0] = outline[index];
    const [x1, y1] = outline[index + 1];
    buildBar(builder, [x0, y0, 0], [x1, y1, 0], halfWidth, 0.0012, PALETTE.orange, [0, 0, 1]);
  }
}

/** Antenna: an orange TPU mount at the back with a charcoal lead and a cream cap, raked up and aft. */
function buildAntenna(builder) {
  buildBox(builder, [-0.008, PLATE.TOP_PLATE_Y + PLATE.TOP_PLATE_THICKNESS, 0.04], [0.008, PLATE.TOP_PLATE_Y + 0.014, 0.052], PALETTE.orange);
  buildBar(builder, [0, 0.04, 0.048], [0, 0.07, 0.092], 0.0018, 0.0018, PALETTE.charcoal);
  buildBar(builder, [0, 0.07, 0.092], [0, 0.079, 0.106], 0.0045, 0.0045, PALETTE.cream);
}

/** Motor: charcoal stator base, orange bell with cooling slots suggested by facets, cream shaft nut. */
function buildMotor(builder, centerX, centerZ) {
  buildCylinder(builder, centerX, centerZ, PLATE.TOP, MOTOR.BASE_TOP, MOTOR.BASE_RADIUS, 10, PALETTE.charcoal);
  const sections = [
    yRing(centerX, MOTOR.BASE_TOP, centerZ, MOTOR.BELL_RADIUS, 10),
    yRing(centerX, MOTOR.BELL_TOP - 0.003, centerZ, MOTOR.BELL_RADIUS, 10),
    yRing(centerX, MOTOR.BELL_TOP, centerZ, MOTOR.BELL_RADIUS - 0.003, 10),
  ];
  builder.loft(sections, (segment) => (segment === 0 ? PALETTE.orange : PALETTE.creamShade), { capStart: PALETTE.charcoal, capEnd: PALETTE.orange });
  // Screws under the motor: the foot the quad lands on.
  buildCylinder(builder, centerX, centerZ, PLATE.BOTTOM - 0.005, PLATE.BOTTOM, 0.008, 8, PALETTE.charcoal);
}

/** Three-blade prop around the local y axis (hub at the origin), twisted for its spin direction. */
function buildProp(spin) {
  const builder = createMeshBuilder();
  buildCylinder(builder, 0, 0, -0.003, 0.004, 0.0065, 8, PALETTE.charcoal, PALETTE.cream);
  const stations = [[0.008, 0.009, 24], [0.022, 0.015, 20], [0.04, 0.014, 15], [0.055, 0.01, 12], [PROP_RADIUS, 0.005, 10]];
  const thickness = 0.0012;
  for (let blade = 0; blade < 3; blade++) {
    const angle = (blade * 120 + 15) * DEG;
    const radialX = Math.cos(angle);
    const radialZ = Math.sin(angle);
    // Tangential direction of travel for this spin (CW seen from above is -angle).
    const travelX = -radialZ * -spin;
    const travelZ = radialX * -spin;
    const sections = stations.map(([radius, chord, pitchDegrees]) => {
      const pitch = pitchDegrees * DEG;
      const chordX = travelX * Math.cos(pitch);
      const chordY = Math.sin(pitch);
      const chordZ = travelZ * Math.cos(pitch);
      const acrossX = -travelX * Math.sin(pitch);
      const acrossY = Math.cos(pitch);
      const acrossZ = -travelZ * Math.sin(pitch);
      const centerX = radialX * radius;
      const centerZ = radialZ * radius;
      return [
        [centerX + chordX * chord * 0.5, chordY * chord * 0.5, centerZ + chordZ * chord * 0.5],
        [centerX + acrossX * thickness, acrossY * thickness, centerZ + acrossZ * thickness],
        [centerX - chordX * chord * 0.5, -chordY * chord * 0.5, centerZ - chordZ * chord * 0.5],
        [centerX - acrossX * thickness, -acrossY * thickness, centerZ - acrossZ * thickness],
      ];
    });
    builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
  }
  return builder.toGeometry(null);
}

/**
 * The FPV camera in its TPU cage (a group so it can carry the uptilt): orange side plates, a charcoal
 * camera body and the lens barrel. Local frame: lens along -z, pivot at the side-plate bolt.
 */
function buildCameraParts() {
  const cage = createMeshBuilder();
  for (const side of [1, -1]) buildBox(cage, [0.0105 * side - 0.0015, -0.011, -0.012], [0.0105 * side + 0.0015, 0.011, 0.012], PALETTE.orange);
  buildBox(cage, [-0.0095, -0.0095, -0.009], [0.0095, 0.0095, 0.011], PALETTE.charcoal);
  // Lens barrel.
  const barrel = [0, 1, 2].map((step) => {
    const ring = [];
    const z = -0.009 - step * 0.004;
    const radius = step === 2 ? 0.0055 : 0.007;
    for (let index = 0; index < 10; index++) {
      const angle = (index / 10) * Math.PI * 2;
      ring.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
    return ring;
  });
  cage.loft(barrel, () => PALETTE.charcoal, {});
  const glass = createMeshBuilder();
  const lens = [];
  for (let index = 0; index < 10; index++) {
    const angle = (index / 10) * Math.PI * 2;
    lens.push([0.0052 * Math.cos(angle), 0.0052 * Math.sin(angle), -0.0172]);
  }
  glass.loft([lens, lens.map((point) => [point[0] * 0.6, point[1] * 0.6, -0.0178])], () => PALETTE.charcoal, { capEnd: PALETTE.charcoal });
  return { cage: cage.toGeometry(null), lens: glass.toGeometry(null) };
}

/** LED strip material: an HDR colour (bloom gives it a halo) driven by uniforms. */
function createLedMaterial(colorUniform, intensityUniform) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = colorUniform.mul(intensityUniform);
  return material;
}

const LED_COLORS = Object.freeze({ angle: new THREE.Color(0x3fd6c6), rate: new THREE.Color(0xe0703a), disarmed: new THREE.Color(0xff3524), classic: new THREE.Color(0xffc98a) });
const MOTOR_LAYOUT = simProfile.motors.map((motor) => ({
  id: motor.id,
  x: motor.position[0],
  z: motor.position[2],
  side: motor.position[0] >= 0 ? 1 : -1,
  front: motor.position[2] <= 0 ? 1 : -1,
  spin: motor.spin === 'ccw' ? -1 : 1,
}));
const IDLE = simProfile.motor.idle;
/** Visual prop speed (rad/s) for a motor speed (0..1): kit prop discs blur from about 8 rad/s. */
const visualPropSpeed = (motorSpeed) => (motorSpeed > 0.01 ? 4 + 28 * motorSpeed : 0);
/** Above this motor speed the blades are a blur: only the disc shows (as in real FPV footage). */
const BLADE_BLUR_SPEED = 0.2;

/**
 * Builds the quad. update(visual, dt) spins each prop at its motor's speed: in SIM visual.propSpeed
 * is the mean motor speed (times QUAD_VISUAL_PROP_SPEED, negative in turtle mode) and visual.aileron
 * / elevator / rudder are the roll, pitch and yaw motor patterns (SimQuad writeSurfaces); in CLASSIC
 * the motors follow the throttle with the stick's differential. LEDs show the flight mode.
 */
function buildMesh(ctx) {
  const materials = getCraftMaterials(ctx);
  const bodyMaterial = materials.body;
  const root = new THREE.Group();
  root.name = 'fpv';

  const airframe = createMeshBuilder();
  buildFrame(airframe);
  buildBattery(airframe);
  buildStrap(airframe);
  buildAntenna(airframe);
  for (const motor of MOTOR_LAYOUT) buildMotor(airframe, motor.x, motor.z);
  addSolid(root, airframe.toGeometry(null), bodyMaterial);

  // Camera cage, tilted up at the FPV camera's uptilt, between the plates at the front.
  const cameraParts = buildCameraParts();
  const cameraPivot = new THREE.Group();
  cameraPivot.position.set(FPV_CAMERA.PIVOT[0], FPV_CAMERA.PIVOT[1], FPV_CAMERA.PIVOT[2]);
  cameraPivot.rotation.x = FPV_CAMERA.UPTILT * DEG;
  addSolid(cameraPivot, cameraParts.cage, bodyMaterial);
  addSolid(cameraPivot, cameraParts.lens, materials.canopy);
  root.add(cameraPivot);

  // Props with blur discs, one group per motor.
  const propGeometry = { cw: buildProp(1), ccw: buildProp(-1) };
  const props = MOTOR_LAYOUT.map((motor) => {
    const group = new THREE.Group();
    group.position.set(motor.x, PROP_Y, motor.z);
    const blades = addSolid(group, motor.spin > 0 ? propGeometry.cw : propGeometry.ccw, bodyMaterial);
    const disc = createPropDisc(PROP_RADIUS);
    disc.mesh.rotation.x = -Math.PI / 2;
    disc.mesh.position.y = 0.0015;
    group.add(disc.mesh);
    root.add(group);
    return { ...motor, group, blades, disc, angle: (motor.front * 0.7 + motor.side * 0.4 + 1.2) % (Math.PI * 2), speed: 0 };
  });

  // LED strips under the rear arms.
  const ledColor = uniform(new THREE.Color().copy(LED_COLORS.angle));
  const ledIntensity = uniform(2.4);
  const ledMaterial = createLedMaterial(ledColor, ledIntensity);
  const ledBuilder = createMeshBuilder();
  for (const side of [1, -1]) buildBar(ledBuilder, [0.024 * side, PLATE.BOTTOM - 0.0012, 0.034], [0.06 * side, PLATE.BOTTOM - 0.0012, 0.058], 0.0032, 0.001, PALETTE.cream, [0, 1, 0]);
  const leds = new THREE.Mesh(ledBuilder.toGeometry(null), ledMaterial);
  root.add(leds);

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'eye';
  eyeAnchor.position.set(FPV_CAMERA.POSITION[0], FPV_CAMERA.POSITION[1], FPV_CAMERA.POSITION[2]);
  root.add(eyeAnchor);

  const flightState = ctx.state && ctx.state.flight ? ctx.state.flight : null;
  const motorSpeeds = MOTOR_LAYOUT.map(() => 0);

  /** Each motor's speed (0..1) from the visual: SimQuad's patterns in SIM, throttle and stick in CLASSIC. */
  function readMotorSpeeds(visual) {
    const running = visual.engineOn !== false;
    const simPatterns = Number.isFinite(visual.propSpeed);
    const mean = simPatterns ? Math.abs(visual.propSpeed) / QUAD_VISUAL_PROP_SPEED : running ? IDLE + (1 - IDLE) * (0.25 + 0.5 * clamp(Number.isFinite(visual.throttle) ? visual.throttle : 0, 0, 1)) + (visual.boost ? 0.15 : 0) : 0;
    const spread = simPatterns ? 0.5 : 0.08;
    const roll = clamp(Number.isFinite(visual.aileron) ? visual.aileron : 0, -1, 1) * spread;
    const pitch = clamp(Number.isFinite(visual.elevator) ? visual.elevator : 0, -1, 1) * spread;
    const yaw = clamp(Number.isFinite(visual.rudder) ? visual.rudder : 0, -1, 1) * spread;
    for (let index = 0; index < MOTOR_LAYOUT.length; index++) {
      const motor = MOTOR_LAYOUT[index];
      // In CLASSIC the stick is a request: right roll speeds up the left motors, pitch up the front ones.
      const commanded = simPatterns
        ? mean + roll * motor.side + pitch * motor.front + yaw * motor.spin
        : mean - roll * motor.side + pitch * motor.front - yaw * motor.spin;
      motorSpeeds[index] = running || simPatterns ? clamp(commanded, 0, 1) : 0;
    }
    return simPatterns && visual.propSpeed < 0 ? -1 : 1;
  }

  function updateLeds(visual) {
    const time = visual.time && Number.isFinite(visual.time.elapsed) ? visual.time.elapsed : 0;
    const night = visual.time && Number.isFinite(visual.time.nightFactor) ? clamp(visual.time.nightFactor, 0, 1) : 0;
    if (visual.engineOn === false) {
      ledColor.value.copy(LED_COLORS.disarmed);
      ledIntensity.value = (Math.sin(time * 6) > 0 ? 2.6 : 0.3) * (1 + night);
      return;
    }
    const sim = flightState && flightState.mode === 'sim';
    const mode = sim && flightState.craftState ? flightState.craftState.droneMode : null;
    ledColor.value.copy(mode === 'rate' ? LED_COLORS.rate : mode === 'angle' ? LED_COLORS.angle : LED_COLORS.classic);
    ledIntensity.value = (2 + 0.5 * Math.sin(time * 2.4)) * (1 + 1.2 * night);
  }

  return {
    root,
    // "Wingtips": the outer edges of the side props (contrail points and the wing-cam fallback).
    wingtips: [new THREE.Vector3(-MOTOR_X - PROP_RADIUS, PROP_Y, 0), new THREE.Vector3(MOTOR_X + PROP_RADIUS, PROP_Y, 0)],
    eyeAnchor,
    /** Local attachment points: the tail of the frame (smoke, trails). */
    anchors: {
      smoke: new THREE.Vector3(0, 0.02, 0.06),
      tail: new THREE.Vector3(0, 0.02, 0.06),
    },

    update(visual, dt) {
      const direction = readMotorSpeeds(visual);
      for (let index = 0; index < props.length; index++) {
        const prop = props[index];
        const speed = visualPropSpeed(motorSpeeds[index]);
        prop.speed = dt > 0 ? speed : prop.speed;
        // CW seen from above turns about -y.
        prop.angle = (prop.angle - prop.spin * direction * prop.speed * dt) % (Math.PI * 2);
        if (!Number.isFinite(prop.angle)) prop.angle = 0;
        prop.group.rotation.y = prop.angle;
        prop.blades.visible = motorSpeeds[index] < BLADE_BLUR_SPEED;
        prop.disc.setSpeed(prop.speed);
      }
      updateLeds(visual);
    },

    dispose() {
      disposeCraftMesh(root, ctx);
    },
  };
}

// ============================================================================================
// ABILITY: flight mode toggle (rate / angle) at any assist level, or turtle mode when the quad lies
// upside down on the ground (the motors on one side spin backwards and roll it back over).
// ============================================================================================
const upScratch = new THREE.Vector3();

function isUpsideDown(quaternion) {
  if (!quaternion) return false;
  upScratch.set(0, 1, 0).applyQuaternion(quaternion);
  return upScratch.y < -0.3;
}

const craftAbility = Object.freeze({
  label: 'Rate / angle mode (turtle when upside down)',
  modes: Object.freeze(['sim']),
  initialState: () => ({ droneMode: 'angle', altitudeHold: true, modeOverride: null, assistLevel: null, turtle: false }),
  run(flight) {
    const craftState = flight.craftState;
    const telemetry = flight.telemetry;
    if (telemetry && telemetry.onGround && isUpsideDown(telemetry.quaternion)) {
      craftState.turtle = true;
      flight.notify('Turtle mode: flipping back over.');
      return true;
    }
    const next = craftState.droneMode === 'rate' ? 'angle' : 'rate';
    craftState.modeOverride = next;
    craftState.droneMode = next;
    if (next === 'rate') craftState.altitudeHold = false;
    flight.notify(next === 'angle' ? 'Angle mode: self-levelling.' : 'Rate mode: full acro.');
    return true;
  },
});

export default Object.freeze({
  id: 'fpv',
  name: 'FPV drone',
  buildMesh,
  arcadeProfile,
  simProfile,
  /**
   * ControlState mapping: the throttle axis is thrust (in acro a centred stick is NOT a hover: it
   * climbs hard); in angle mode with altitude hold it asks for a climb rate around the centre. The
   * HOTAS antenna zooms the FPV lens. rates: Betaflight RC rate, super rate and expo per axis
   * (defaults 670 deg/s at full stick, expo 0.3).
   */
  inputProfile: Object.freeze({
    throttle: 'thrust',
    antenna: 'zoom',
    rates: Object.freeze({ roll: DEFAULT_QUAD_RATES, pitch: DEFAULT_QUAD_RATES, yaw: DEFAULT_QUAD_RATES }),
  }),
  audioProfile: Object.freeze({ engine: 'drone', motors: 4, idleHz: 170, maxHz: 820, airflowSpeed: 42, classicAirflowSpeed: 45, touchdown: 'body', callouts: false }),
  cameraRig: Object.freeze({
    eye: FPV_CAMERA.POSITION,
    // Close behind and aimed low: the chase camera keeps 3 m above the ground, so a short look-ahead
    // keeps a landed quad in frame.
    chase: Object.freeze({ distance: 3, height: 0.6, lookAhead: 2 }),
    wing: Object.freeze({ position: Object.freeze([0.2, 0.09, 0.32]), target: Object.freeze([0, 0.02, -0.3]) }),
    // The first-person slot becomes the FPV camera: locked to the frame, tilted up, settings.fov.fpv.
    fpv: Object.freeze({ position: FPV_CAMERA.POSITION, uptilt: FPV_CAMERA.UPTILT, near: FPV_CAMERA.NEAR }),
  }),
  instruments: Object.freeze(['throttle', 'droneMode', 'airspeed', 'altitude', 'attitude', 'heading', 'vsi']),
  abilities: Object.freeze({ craftAbility }),
  // Spawns hovering at the hover throttle; relaunch is an airstart; takes off from a small flat spot.
  spawn: Object.freeze({ cruise: 20, cruiseThrottle: 0.32, hover: true, relaunch: 'airstart', canStartOnGround: true }),
  // A quad has no structural G limit worth flying to; hard hits and prop strikes end the flight.
  limits: Object.freeze({ vne: 48, gLimit: 12, crashSinkRate: 6.5, bodyStrikeSpeed: 6, floats: false }),
});
