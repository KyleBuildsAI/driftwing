import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG } from '../core/config.js';
import { DEG, clamp, damp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, isFiniteVector, isFiniteQuaternion } from '../core/util.js';

/**
 * FLIGHT: arcade flight model with soul (bank-to-turn handling with coordinated turns,
 * energy trade in climbs and dives, soft stall, boost with cooldown, auto-level, ground
 * cushion, soft ceiling, terrain-aware autopilot with manual override, canned barrel
 * roll; the stick alone can never leave the glider inverted) plus the low-poly
 * motor-glider: animated ailerons / elevator / rudder, spinning prop, nav lights and strobe.
 * Owns the state.player motion fields (position, quaternion, velocity, speed, throttle,
 * heading / pitch / roll, forward / up / right, yawRate, gForce, stalled, boost, barrelRoll,
 * autopilot); core clamps the result afterwards. Non-finite state (shared or internal) is
 * repaired at the start of every step, keeping the last good pose, so the glider never freezes.
 */
export function createFlightSystem(ctx) {
  const { THREE: T, TSL: tsl, scene, state, input, bus, world, uniforms } = ctx;
  const { uniform, color, float, uv, length, saturate, pow, smoothstep, mix, dot, normalize, normalView, positionView, cameraViewMatrix } = tsl;
  const player = state.player;
  const SPEED = CONFIG.SPEED;

  // ---- Tuning ------------------------------------------------------------------------
  const GRAVITY = 9.81;
  const DRAG_COEFFICIENT = 0.0011;
  const THROTTLE_SPEED_EXPONENT = 1.3; // terminal speed = MAX * throttle^1.3 -> 62 m/s at 55 %
  const THROTTLE_RATE = 0.42;
  const INDUCED_DRAG = 0.5;
  const INDUCED_MAX_EXTRA_G = 3;
  const MAX_PITCH_RATE = 70 * DEG;
  const MAX_ROLL_RATE = 130 * DEG;
  const MAX_YAW_RATE = 18 * DEG;
  // Bank-to-turn: the roll axis commands a bank ANGLE (full input = MAX_BANK); releasing it
  // rolls back to level in about a second. Only the canned barrel roll goes past MAX_BANK.
  const MAX_BANK = 72 * DEG;
  const BANK_GAIN = 3.4;
  const FINE_BANK_SCALE = 0.55;
  const YAW_BANK = 10 * DEG;
  // Soft attitude limit: pitch input fades out between 50 and 78 degrees of nose elevation,
  // so the stick alone can never loop the glider onto its back.
  const PITCH_LIMIT_START = 50 * DEG;
  const PITCH_LIMIT_RANGE = 28 * DEG;
  const TURN_GAIN = 1.6;
  const MAX_TURN_RATE = 38 * DEG;
  const BANK_NOSE_DROP = 4 * DEG;
  const BANK_SETTLE_PITCH = 4 * DEG;
  const FINE_CONTROL_SCALE = 0.45;
  const AUTO_LEVEL_DELAY = 1.2;
  const STALL_EXIT_MARGIN = 4;
  const STALL_NOSE_TARGET = -20 * DEG;
  const CUSHION_HEIGHT = 25;
  const IMPACT_WARNING_SECONDS = 2.5;
  const IMPACT_FULL_SECONDS = 0.7;
  const CUSHION_PULL_RATE = 60 * DEG;
  const GUARD_PROBE_SECONDS = Object.freeze([1.1, 2.2, 3.4]);
  const GUARD_MARGIN = 18;
  const GUARD_EVADE_GRADIENT = Math.tan(28 * DEG);
  const GUARD_EVADE_BANK = 55 * DEG;
  const CEILING_BAND = 260;
  const BOOST_DURATION = 2.2;
  const BOOST_COOLDOWN = 6;
  const BARREL_ROLL_DURATION = 1.1;
  const BARREL_ROLL_RADIUS = 1.8;
  const STROBE_PERIOD = 1.3;
  const AUTOPILOT = Object.freeze({
    MAX_BANK: 30 * DEG,
    MAX_PITCH: 8 * DEG,
    TERRAIN_PITCH: 12 * DEG,
    CLEARANCE: 120,
    RING_CLEARANCE: 45,
    MIN_ALTITUDE: 60,
    CRUISE_THROTTLE: 0.55,
    OVERRIDE_INPUT: 0.35,
    OVERRIDE_SECONDS: 0.25,
    TERRAIN_MAX_PITCH: 20 * DEG,
    LOOKAHEAD_DISTANCES: Object.freeze([0, 90, 180, 300, 450, 650, 900, 1300]),
    PATH_LOOKAHEAD_DISTANCES: Object.freeze([150, 350, 650]),
    // Heading hold / waypoint following: calm, wide turns.
    WAYPOINT_STEERING: Object.freeze({ BANK_PER_DEGREE: 1.2, MAX_BANK: 30 * DEG, DAMPING: 2.2, MAX_ROLL_RATE: 45 * DEG }),
    // Ring following threads 16 m rings: firmer banking toward a point on the ring's axis
    // (cross-track correction), altitude timed to arrive at the ring's height, and terrain
    // sampled only up to just past the ring (the course guarantees clearance there).
    RING_STEERING: Object.freeze({ BANK_PER_DEGREE: 2.0, MAX_BANK: 40 * DEG, DAMPING: 3.5, MAX_ROLL_RATE: 60 * DEG }),
    RING_MAX_PITCH: 12 * DEG,
    RING_MIN_TIME_TO_RING: 1.5,
    RING_VERTICAL_SPEED_GAIN: 0.015,
    RING_LOOKAHEAD_MARGIN: 150,
    RING_TRACK_LEAD_SECONDS: 2.4,
    RING_TRACK_LEAD_MIN: 100,
    RING_TRACK_LEAD_MAX: 200,
  });
  // Load factor shown to fx / audio: ~1/cos(bank) in a level turn plus a modest share of
  // the pitch-rate pull, soft-capped (the arcade turn and pitch rates would read ~9 g).
  const LOAD = Object.freeze({ PULL_SHARE: 0.2, KNEE: 3.5, CAP: 5, MIN: -1, SMOOTHING: 5, MIN_BANK_COS: 0.2, BARREL_ROLL_EXTRA: 0.8 });

  const WORLD_UP = new T.Vector3(0, 1, 0);
  const LOCAL_RIGHT = new T.Vector3(1, 0, 0);
  const LOCAL_UP = new T.Vector3(0, 1, 0);
  const LOCAL_FORWARD = new T.Vector3(0, 0, -1);

  // ---- Simulation state ------------------------------------------------------------------
  const attitude = player.quaternion.clone();
  const pathDirection = player.forward.clone().normalize();
  const bodyForward = new T.Vector3();
  const bodyUp = new T.Vector3();
  const bodyRight = new T.Vector3();
  const horizontalRight = new T.Vector3();
  const rollOffset = new T.Quaternion();
  const corkscrewOffset = new T.Vector3();
  const scratchQuaternion = new T.Quaternion();
  const scratchVector = new T.Vector3();
  const wobbleQuaternion = new T.Quaternion();
  const wobbleEuler = new T.Euler(0, 0, 0, 'YXZ');

  const rates = { pitch: 0, roll: 0, yaw: 0, worldPitch: 0, turn: 0 };
  const frame = { pitch: 0, bank: 0, horizontalLength: 1, liftFactor: 1 };
  const assist = { cushion: 0, proximity: 0, urgency: 0, risingTerrain: 0, ceiling: 0, evade: 0, evadeDirection: 0 };
  const barrel = { active: false, direction: 0, elapsed: 0, angle: 0 };
  const autopilotState = {
    overrideSeconds: 0,
    commandedBank: 0,
    throttleOverride: false,
    rollRate: 0,
    worldPitchRate: 0,
    throttle: AUTOPILOT.CRUISE_THROTTLE,
  };
  const LOOKAHEAD_SAMPLE_COUNT = AUTOPILOT.LOOKAHEAD_DISTANCES.length + AUTOPILOT.PATH_LOOKAHEAD_DISTANCES.length;
  const lookahead = {
    x: NaN,
    z: NaN,
    heading: NaN,
    age: Infinity,
    heights: new Float64Array(LOOKAHEAD_SAMPLE_COUNT),
    distances: new Float64Array(LOOKAHEAD_SAMPLE_COUNT),
    count: 0,
    limit: Infinity,
    floor: 0,
    gradient: 0,
  };
  const autopilotTarget = {
    heading: 0,
    altitude: 0,
    clearance: 0,
    ring: false,
    ringDistance: 0,
    lookaheadHeading: 0,
    lookaheadLimit: Infinity,
  };
  let speed = player.speed;
  let stalled = false;
  let idleSeconds = 0;
  let pitchIdleSeconds = 0;
  let throttleGoal = null;
  let lastThrottleTarget = input.throttleTarget;
  let previousHeading = player.heading;
  let lastFiniteHeading = Number.isFinite(player.heading) ? player.heading : 0;
  const lastFinitePosition = player.position.clone();
  let smoothedYawRate = 0;
  let smoothedGForce = 1;
  let propAngle = 0;
  const controlSurfaces = { aileron: 0, elevator: 0, rudder: 0 };

  player.boost.cooldownTotal = BOOST_COOLDOWN;

  // ---- Small math helpers ------------------------------------------------------------------
  function smooth01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function wrapSignedDegrees(degrees) {
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
  }
  function wrapSignedRadians(radians) {
    return Math.atan2(Math.sin(radians), Math.cos(radians));
  }
  function easeRollProgress(progress) {
    return 0.35 * progress + 0.65 * (0.5 - 0.5 * Math.cos(Math.PI * progress));
  }

  // ============================================================================================
  // GLIDER MODEL (built from code, flat-shaded, vertex-coloured, local frame: nose -z, up +y)
  // ============================================================================================
  const PALETTE = {
    cream: new T.Color(0xf1e4cf),
    creamShade: new T.Color(0xe6d4b8),
    orange: new T.Color(0xe0703a),
    charcoal: new T.Color(0x2c2f38),
  };

  function createMeshBuilder() {
    const positions = [];
    const colors = [];
    const edgeB = new T.Vector3();
    const edgeC = new T.Vector3();
    const faceNormal = new T.Vector3();
    const outward = new T.Vector3();

    function pushVertex(point, tint) {
      positions.push(point[0], point[1], point[2]);
      colors.push(tint.r, tint.g, tint.b);
    }
    /** Adds a triangle wound so its normal points away from `inside`. */
    function triangle(a, b, c, tint, inside) {
      edgeB.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      edgeC.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      faceNormal.crossVectors(edgeB, edgeC);
      if (faceNormal.lengthSq() < 1e-12) return;
      outward.set(
        (a[0] + b[0] + c[0]) / 3 - inside[0],
        (a[1] + b[1] + c[1]) / 3 - inside[1],
        (a[2] + b[2] + c[2]) / 3 - inside[2],
      );
      pushVertex(a, tint);
      if (faceNormal.dot(outward) < 0) {
        pushVertex(c, tint);
        pushVertex(b, tint);
      } else {
        pushVertex(b, tint);
        pushVertex(c, tint);
      }
    }
    function quad(a, b, c, d, tint, inside) {
      triangle(a, b, c, tint, inside);
      triangle(a, c, d, tint, inside);
    }
    function centroidOf(points) {
      const centre = [0, 0, 0];
      for (const point of points) {
        centre[0] += point[0];
        centre[1] += point[1];
        centre[2] += point[2];
      }
      return centre.map((value) => value / points.length);
    }
    function fanCap(section, centre, insideReference, tint) {
      for (let index = 0; index < section.length; index++) {
        triangle(centre, section[index], section[(index + 1) % section.length], tint, insideReference);
      }
    }
    /** Skins consecutive cross-sections (equal point counts) into quads; optional end caps. */
    function loft(sections, tintAt, options = {}) {
      const closed = options.closed !== false;
      const count = sections[0].length;
      const centres = sections.map(centroidOf);
      for (let segment = 0; segment < sections.length - 1; segment++) {
        const inside = [
          (centres[segment][0] + centres[segment + 1][0]) / 2,
          (centres[segment][1] + centres[segment + 1][1]) / 2,
          (centres[segment][2] + centres[segment + 1][2]) / 2,
        ];
        const edgeCount = closed ? count : count - 1;
        for (let edge = 0; edge < edgeCount; edge++) {
          const next = (edge + 1) % count;
          quad(sections[segment][edge], sections[segment][next], sections[segment + 1][next], sections[segment + 1][edge], tintAt(segment, edge), inside);
        }
      }
      const last = sections.length - 1;
      if (options.capStart) fanCap(sections[0], centres[0], centres[1], options.capStart);
      if (options.capEnd) fanCap(sections[last], centres[last], centres[last - 1], options.capEnd);
    }
    function toGeometry(pivot) {
      const geometry = new T.BufferGeometry();
      const positionArray = new Float32Array(positions);
      if (pivot) {
        for (let index = 0; index < positionArray.length; index += 3) {
          positionArray[index] -= pivot[0];
          positionArray[index + 1] -= pivot[1];
          positionArray[index + 2] -= pivot[2];
        }
      }
      geometry.setAttribute('position', new T.BufferAttribute(positionArray, 3));
      geometry.setAttribute('color', new T.BufferAttribute(new Float32Array(colors), 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return geometry;
    }
    return { triangle, quad, loft, toGeometry };
  }

  // Airfoils as [chord fraction, thickness fraction]; loops run LE -> upper -> TE -> lower.
  const WING_PROFILE = [[0, 0], [0.07, 0.52], [0.3, 0.62], [0.72, 0.3], [1, 0], [0.72, -0.1], [0.3, -0.3], [0.07, -0.24]];
  const WING_PROFILE_CUT = [[0, 0], [0.07, 0.52], [0.3, 0.62], [0.72, 0.3], [0.72, 0.1], [0.72, -0.1], [0.3, -0.3], [0.07, -0.24]];
  const AILERON_PROFILE = [[0.735, 0.29], [1, 0], [0.735, -0.1]];
  const AILERON_HINGE = [0.735, 0.095];
  const TAIL_PROFILE_CUT = [[0, 0], [0.07, 0.45], [0.3, 0.5], [0.7, 0.3], [0.7, 0], [0.7, -0.3], [0.3, -0.5], [0.07, -0.45]];
  const TAIL_SURFACE_PROFILE = [[0.715, 0.29], [1, 0], [0.715, -0.29]];
  const TAIL_HINGE_FRACTION = 0.715;

  function profileSection(profile, leadingEdge, chordDirection, thicknessDirection, chord, thickness) {
    return profile.map(([along, across]) => [
      leadingEdge[0] + chordDirection[0] * along * chord + thicknessDirection[0] * across * thickness * chord,
      leadingEdge[1] + chordDirection[1] * along * chord + thicknessDirection[1] * across * thickness * chord,
      leadingEdge[2] + chordDirection[2] * along * chord + thicknessDirection[2] * across * thickness * chord,
    ]);
  }
  function piecewise(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let index = 1; index < points.length; index++) {
      if (x <= points[index][0]) {
        const [x0, y0] = points[index - 1];
        const [x1, y1] = points[index];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return points[points.length - 1][1];
  }
  function mirrorPoint(point, side) {
    return [point[0] * side, point[1], point[2]];
  }

  // Wing planform (right half; x spanwise). LE and chord are linear across the aileron span,
  // so the aileron hinge line is straight.
  const WING_CHORD = [[0.25, 1.18], [3.3, 0.98], [4.4, 0.88], [7.35, 0.46]];
  const WING_TIP_X = 7.35;
  const DIHEDRAL_SLOPE = Math.tan(3.2 * DEG);
  const wingChord = (x) => piecewise(WING_CHORD, x);
  const wingLeadingEdge = (x) => -0.48 + 0.041 * (x - 0.25);
  const wingHeight = (x) => 0.3 + (x - 0.25) * DIHEDRAL_SLOPE;
  const wingThickness = (x) => 0.15 - (0.04 * (x - 0.25)) / (WING_TIP_X - 0.25);
  function wingSection(x, profile) {
    return profileSection(profile, [x, wingHeight(x), wingLeadingEdge(x)], [0, 0, 1], [0, 1, 0], wingChord(x), wingThickness(x));
  }
  function aileronHingePoint(x) {
    const chord = wingChord(x);
    return [x, wingHeight(x) + AILERON_HINGE[1] * wingThickness(x) * chord, wingLeadingEdge(x) + AILERON_HINGE[0] * chord];
  }

  function buildWingHalf(builder, side) {
    const mirror = (section) => section.map((point) => mirrorPoint(point, side));
    const lowerEdge = (edge) => edge >= 4;
    const inboard = [0.25, 0.9, 3.3, 4.4].map((x) => mirror(wingSection(x, WING_PROFILE)));
    builder.loft(inboard, (segment, edge) => (lowerEdge(edge) ? PALETTE.creamShade : PALETTE.cream), { capEnd: PALETTE.cream });
    const outboard = [4.4, 5.9, 6.5, WING_TIP_X].map((x) => mirror(wingSection(x, WING_PROFILE_CUT)));
    builder.loft(outboard, (segment, edge) => {
      if (segment === 1) return PALETTE.orange;
      return lowerEdge(edge) ? PALETTE.creamShade : PALETTE.cream;
    }, { capEnd: PALETTE.cream });
    // Upturned winglet: sections rotate from horizontal to near-vertical, sweeping back.
    const tipY = wingHeight(WING_TIP_X);
    const winglet = [
      { x: WING_TIP_X, y: tipY, le: wingLeadingEdge(WING_TIP_X), chord: wingChord(WING_TIP_X), thickness: wingThickness(WING_TIP_X), cant: 0 },
      { x: 7.47, y: tipY + 0.1, le: -0.14, chord: 0.4, thickness: 0.1, cant: 40 },
      { x: 7.56, y: tipY + 0.36, le: -0.02, chord: 0.31, thickness: 0.1, cant: 76 },
      { x: 7.6, y: tipY + 0.62, le: 0.08, chord: 0.22, thickness: 0.1, cant: 84 },
    ].map((station) => mirror(profileSection(
      WING_PROFILE,
      [station.x, station.y, station.le],
      [0, 0, 1],
      [-Math.sin(station.cant * DEG), Math.cos(station.cant * DEG), 0],
      station.chord,
      station.thickness,
    )));
    builder.loft(winglet, () => PALETTE.orange, { capEnd: PALETTE.orange });
  }

  function buildAileron(side) {
    const builder = createMeshBuilder();
    const stations = [4.45, 5.9, 6.5, 7.32];
    const sections = stations.map((x) => profileSection(AILERON_PROFILE, [x, wingHeight(x), wingLeadingEdge(x)], [0, 0, 1], [0, 1, 0], wingChord(x), wingThickness(x))
      .map((point) => mirrorPoint(point, side)));
    builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.cream });
    const hingeStart = mirrorPoint(aileronHingePoint(stations[0]), side);
    const hingeEnd = mirrorPoint(aileronHingePoint(stations[stations.length - 1]), side);
    const axis = new T.Vector3(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1], hingeEnd[2] - hingeStart[2]).normalize();
    return { geometry: builder.toGeometry(hingeStart), pivot: hingeStart, axis };
  }

  // Fuselage stations: [z, centre y, half width, half height].
  const FUSELAGE = [
    [-2.62, -0.02, 0.26, 0.27],
    [-2.3, 0.0, 0.42, 0.45],
    [-1.6, 0.02, 0.5, 0.55],
    [-0.6, 0.05, 0.52, 0.58],
    [0.4, 0.08, 0.46, 0.52],
    [1.4, 0.14, 0.32, 0.37],
    [2.6, 0.22, 0.2, 0.25],
    [3.8, 0.3, 0.14, 0.19],
    [4.78, 0.34, 0.08, 0.11],
  ];
  const FUSELAGE_SIDES = 12;
  function fuselageAt(z) {
    const column = (index) => FUSELAGE.map((station) => [station[0], station[index]]);
    return { centreY: piecewise(column(1), z), halfWidth: piecewise(column(2), z), halfHeight: piecewise(column(3), z) };
  }
  function buildFuselage(builder) {
    const sections = FUSELAGE.map(([z, centreY, halfWidth, halfHeight]) => {
      const ring = [];
      for (let index = 0; index < FUSELAGE_SIDES; index++) {
        const angle = (15 + index * 30) * DEG;
        ring.push([halfWidth * Math.cos(angle), centreY + halfHeight * Math.sin(angle), z]);
      }
      return ring;
    });
    builder.loft(sections, (segment, face) => {
      if (segment === 0) return PALETTE.orange;
      if (segment === 1 && face >= 1 && face <= 3) return PALETTE.charcoal;
      if ((face === 11 || face === 5) && segment <= 6) return PALETTE.orange;
      if (face >= 7 && face <= 9) return PALETTE.creamShade;
      return PALETTE.cream;
    }, { capStart: PALETTE.charcoal, capEnd: PALETTE.cream });
  }

  function buildCanopyGeometry() {
    const builder = createMeshBuilder();
    const stations = [[-1.95, 0.06, 0.012], [-1.65, 0.24, 0.12], [-1.2, 0.32, 0.22], [-0.6, 0.34, 0.25], [-0.05, 0.3, 0.19], [0.35, 0.2, 0.1], [0.6, 0.07, 0.02]];
    const sections = stations.map(([z, halfWidth, bubble]) => {
      const body = fuselageAt(z);
      const surfaceAt = (x) => body.centreY + body.halfHeight * Math.sqrt(Math.max(0, 1 - (x / body.halfWidth) ** 2)) - 0.025;
      const topY = body.centreY + body.halfHeight + bubble;
      const arc = [];
      for (let index = 0; index <= 6; index++) {
        const angle = Math.PI - (index / 6) * Math.PI;
        const x = halfWidth * Math.cos(angle);
        arc.push([x, surfaceAt(x) + (topY - surfaceAt(0)) * Math.sin(angle), z]);
      }
      return arc;
    });
    builder.loft(sections, () => PALETTE.charcoal, { closed: false });
    return builder.toGeometry(null);
  }

  // Tail: vertical fin (y spanwise) and T-tail stabilizer (x spanwise) with straight hinge lines.
  const finLeadingEdge = (y) => 3.15 + ((4.02 - 3.15) * (y - 0.3)) / 1.4;
  const finChord = (y) => 1.45 + ((0.78 - 1.45) * (y - 0.3)) / 1.4;
  const FIN_THICKNESS = 0.11;
  const STAB_Y = 1.72;
  const STAB_HINGE_Z = 4.52;
  const STAB_HALF_SPAN = 1.55;
  const stabChord = (x) => 0.8 - ((0.8 - 0.46) * Math.abs(x)) / STAB_HALF_SPAN;
  const stabLeadingEdge = (x) => STAB_HINGE_Z - TAIL_HINGE_FRACTION * stabChord(x);
  const STAB_THICKNESS = 0.1;

  function buildTail(builder) {
    const finSections = [0.3, 1.3, 1.7].map((y) => profileSection(TAIL_PROFILE_CUT, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN_THICKNESS));
    builder.loft(finSections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capEnd: PALETTE.orange });
    const stabSections = [-STAB_HALF_SPAN, -1.2, 0, 1.2, STAB_HALF_SPAN].map((x) => profileSection(TAIL_PROFILE_CUT, [x, STAB_Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB_THICKNESS));
    builder.loft(stabSections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  }
  function buildRudder() {
    const builder = createMeshBuilder();
    const heights = [0.32, 1.3, 1.67];
    const sections = heights.map((y) => profileSection(TAIL_SURFACE_PROFILE, [0, y, finLeadingEdge(y)], [0, 0, 1], [1, 0, 0], finChord(y), FIN_THICKNESS));
    builder.loft(sections, (segment) => (segment === 1 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.cream, capEnd: PALETTE.orange });
    const hinge = (y) => [0, y, finLeadingEdge(y) + TAIL_HINGE_FRACTION * finChord(y)];
    const start = hinge(heights[0]);
    const end = hinge(heights[heights.length - 1]);
    const axis = new T.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize();
    return { geometry: builder.toGeometry(start), pivot: start, axis };
  }
  function buildElevator() {
    const builder = createMeshBuilder();
    const stations = [-1.53, -1.2, 0, 1.2, 1.53];
    const sections = stations.map((x) => profileSection(TAIL_SURFACE_PROFILE, [x, STAB_Y, stabLeadingEdge(x)], [0, 0, 1], [0, 1, 0], stabChord(x), STAB_THICKNESS));
    builder.loft(sections, (segment) => (segment === 0 || segment === 3 ? PALETTE.orange : PALETTE.cream), { capStart: PALETTE.orange, capEnd: PALETTE.orange });
    const pivot = [0, STAB_Y, STAB_HINGE_Z];
    return { geometry: builder.toGeometry(pivot), pivot, axis: new T.Vector3(1, 0, 0) };
  }

  // Propeller: faceted spinner + two twisted blades with orange tips (rotates about local z).
  const PROP_PIVOT = [0, -0.02, -2.62];
  const PROP_PLANE_Z = -0.16;
  function buildPropeller() {
    const builder = createMeshBuilder();
    const spinner = [[0, 0.255], [-0.16, 0.24], [-0.3, 0.17], [-0.4, 0.075], [-0.45, 0.0]].map(([z, radius]) => {
      const ring = [];
      for (let index = 0; index < 8; index++) {
        const angle = (index / 8) * Math.PI * 2;
        ring.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
      }
      return ring;
    });
    builder.loft(spinner, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capStart: PALETTE.charcoal });
    const bladeStations = [[0.12, 0.12, 48], [0.35, 0.15, 32], [0.62, 0.12, 22], [0.8, 0.09, 18], [0.91, 0.055, 16]];
    const bladeThickness = 0.022;
    for (const direction of [1, -1]) {
      const sections = bladeStations.map(([radius, width, pitchDegrees]) => {
        const pitch = pitchDegrees * DEG;
        const chord = [Math.cos(pitch) * direction, 0, -Math.sin(pitch)];
        const across = [Math.sin(pitch) * direction, 0, Math.cos(pitch)];
        const centre = [0, radius * direction, PROP_PLANE_Z];
        return [
          [centre[0] + chord[0] * width * 0.5, centre[1], centre[2] + chord[2] * width * 0.5],
          [centre[0] + across[0] * bladeThickness, centre[1], centre[2] + across[2] * bladeThickness],
          [centre[0] - chord[0] * width * 0.5, centre[1], centre[2] - chord[2] * width * 0.5],
          [centre[0] - across[0] * bladeThickness, centre[1], centre[2] - across[2] * bladeThickness],
        ];
      });
      builder.loft(sections, (segment) => (segment === 3 ? PALETTE.orange : PALETTE.charcoal), { capEnd: PALETTE.orange });
    }
    return builder.toGeometry(null);
  }

  // ---- Materials --------------------------------------------------------------------------
  const bodyMaterial = new T.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0 });
  const canopyMaterial = new T.MeshStandardNodeMaterial({ color: 0x1d2c3a, flatShading: true, roughness: 0.36, metalness: 0.05 });
  const viewDirection = normalize(positionView.negate());
  const facing = saturate(dot(normalView, viewDirection));
  {
    // Warm sun rim when the glider is backlit (flying into a low sun): key-art edge glow.
    const sunInView = cameraViewMatrix.transformDirection(uniforms.sunDirection);
    const backlit = pow(saturate(dot(viewDirection.negate(), sunInView)), float(2));
    const rim = pow(float(1).sub(facing), float(3));
    const sunAboveHorizon = smoothstep(float(-0.04), float(0.08), uniforms.sunDirection.y);
    bodyMaterial.emissiveNode = uniforms.sunColor.mul(rim.mul(backlit).mul(sunAboveHorizon).mul(0.55));
  }
  {
    const rim = pow(float(1).sub(facing), float(2.5));
    const skyTint = mix(uniforms.skyZenithColor, uniforms.skyHorizonColor, float(0.6));
    canopyMaterial.emissiveNode = skyTint.mul(rim.mul(0.45).add(0.025)).mul(float(1).sub(uniforms.nightFactor.mul(0.75)));
  }
  // Nav lights: a tiny HDR bulb (bloom adds a soft halo) plus a small additive glow sprite
  // whose energy sits in a tight core (~0.3 m) with a faint tail to the sprite edge.
  const navIntensity = uniform(2.2);
  const strobeIntensity = uniform(0.5);
  const glowStrength = uniform(0.1);
  const strobeGlowStrength = uniform(0);
  const discOpacity = uniform(0.1);
  const NAV_GLOW = Object.freeze({ DAY_SCALE: 0.9, NIGHT_SCALE: 1.8, STROBE_SCALE: 1.7 });
  const STROBE_FLASH_SECONDS = 0.09;

  function createNavMaterial(hex, intensityNode) {
    const material = new T.MeshBasicNodeMaterial();
    material.colorNode = color(hex).mul(intensityNode);
    return material;
  }
  function createGlowMaterial(hex, strengthNode) {
    const material = new T.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: T.AdditiveBlending });
    const radial = saturate(float(1).sub(length(uv().sub(0.5)).mul(2)));
    const core = pow(radial, float(6));
    const tail = pow(radial, float(2)).mul(0.12);
    material.colorNode = color(hex);
    material.opacityNode = core.add(tail).mul(strengthNode);
    return material;
  }
  const discMaterial = new T.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: T.DoubleSide, forceSinglePass: true });
  {
    const radius = length(uv().sub(0.5)).mul(2);
    const band = smoothstep(float(0.2), float(0.32), radius).mul(float(1).sub(smoothstep(float(0.9), float(1), radius)));
    discMaterial.colorNode = color(0x3a3d46);
    discMaterial.opacityNode = band.mul(radius.mul(0.5).add(0.5)).mul(discOpacity);
  }

  // ---- Assembly --------------------------------------------------------------------------------
  const planeMesh = new T.Group();
  planeMesh.name = 'glider';

  function addSolid(parent, geometry, material) {
    const mesh = new T.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function addPivot(part) {
    const pivot = new T.Group();
    pivot.position.set(part.pivot[0], part.pivot[1], part.pivot[2]);
    pivot.userData.axis = part.axis;
    addSolid(pivot, part.geometry, bodyMaterial);
    planeMesh.add(pivot);
    return pivot;
  }

  const airframeBuilder = createMeshBuilder();
  buildFuselage(airframeBuilder);
  buildWingHalf(airframeBuilder, 1);
  buildWingHalf(airframeBuilder, -1);
  buildTail(airframeBuilder);
  addSolid(planeMesh, airframeBuilder.toGeometry(null), bodyMaterial);
  addSolid(planeMesh, buildCanopyGeometry(), canopyMaterial);
  const aileronRight = addPivot(buildAileron(1));
  const aileronLeft = addPivot(buildAileron(-1));
  const elevator = addPivot(buildElevator());
  const rudder = addPivot(buildRudder());

  const propeller = new T.Group();
  propeller.position.set(PROP_PIVOT[0], PROP_PIVOT[1], PROP_PIVOT[2]);
  addSolid(propeller, buildPropeller(), bodyMaterial);
  const propDisc = new T.Mesh(new T.CircleGeometry(0.93, 32), discMaterial);
  propDisc.position.z = PROP_PLANE_Z - 0.03;
  propDisc.renderOrder = 2;
  propeller.add(propDisc);
  planeMesh.add(propeller);

  const tipY = wingHeight(WING_TIP_X);
  const tipLeadingEdge = wingLeadingEdge(WING_TIP_X);
  const navLightSpecs = [
    { hex: 0xff3524, position: [-7.4, tipY + 0.02, tipLeadingEdge + 0.08], glow: [-7.5, tipY + 0.03, tipLeadingEdge + 0.02], intensity: navIntensity, strength: glowStrength },
    { hex: 0x2dff7a, position: [7.4, tipY + 0.02, tipLeadingEdge + 0.08], glow: [7.5, tipY + 0.03, tipLeadingEdge + 0.02], intensity: navIntensity, strength: glowStrength },
    { hex: 0xfff4e6, position: [0, STAB_Y + 0.08, 4.36], glow: [0, STAB_Y + 0.16, 4.36], intensity: strobeIntensity, strength: strobeGlowStrength },
  ];
  const bulbGeometry = new T.OctahedronGeometry(0.075, 0);
  const glowSprites = navLightSpecs.map((spec) => {
    const bulb = new T.Mesh(bulbGeometry, createNavMaterial(spec.hex, spec.intensity));
    bulb.position.set(spec.position[0], spec.position[1], spec.position[2]);
    planeMesh.add(bulb);
    const sprite = new T.Sprite(createGlowMaterial(spec.hex, spec.strength));
    sprite.position.set(spec.glow[0], spec.glow[1], spec.glow[2]);
    sprite.renderOrder = 6;
    planeMesh.add(sprite);
    return sprite;
  });

  const WINGTIP_LOCAL = [new T.Vector3(-7.45, tipY + 0.05, 0.26), new T.Vector3(7.45, tipY + 0.05, 0.26)];
  const wingtips = [new T.Vector3(), new T.Vector3()];
  scene.add(planeMesh);

  // ============================================================================================
  // FLIGHT MODEL
  // ============================================================================================
  /**
   * Reads the shared pose back (core may have clamped it). A non-finite or zero-length shared
   * quaternion keeps last frame's attitude; if that is unusable too, the wings are levelled on
   * the last finite heading. Any non-finite integrator resets the transient flight state.
   */
  function syncFromState() {
    if (isFiniteVector(player.position)) lastFinitePosition.copy(player.position);
    else player.position.copy(lastFinitePosition);
    if (Number.isFinite(player.heading)) lastFiniteHeading = player.heading;
    const sharedAttitudeValid = isFiniteQuaternion(player.quaternion);
    if (!barrel.active && sharedAttitudeValid) attitude.copy(player.quaternion);
    let attitudeRebuilt = false;
    if (!isFiniteQuaternion(attitude)) {
      if (sharedAttitudeValid) attitude.copy(player.quaternion);
      else attitude.setFromAxisAngle(WORLD_UP, -lastFiniteHeading * DEG);
      attitudeRebuilt = true;
    }
    attitude.normalize();
    if (Number.isFinite(player.speed)) speed = clamp(player.speed, SPEED.MIN, SPEED.BOOST_MAX);
    else if (!Number.isFinite(speed)) speed = SPEED.CRUISE;
    const velocityLength = player.velocity.length();
    if (velocityLength > 1 && Number.isFinite(velocityLength)) pathDirection.copy(player.velocity).divideScalar(velocityLength);
    else pathDirection.set(0, 0, -1).applyQuaternion(attitude);
    if (attitudeRebuilt || !internalsAreFinite()) resetInternals(lastFiniteHeading);
  }

  /** NaN or Infinity in any integrator makes the sum non-finite (one check per frame). */
  function internalsAreFinite() {
    const sum = rates.pitch + rates.roll + rates.yaw + rates.worldPitch + rates.turn
      + speed + pathDirection.x + pathDirection.y + pathDirection.z
      + assist.cushion + assist.proximity + assist.urgency + assist.risingTerrain + assist.ceiling + assist.evade + assist.evadeDirection
      + autopilotState.commandedBank + autopilotState.rollRate + autopilotState.worldPitchRate + autopilotState.throttle + autopilotState.overrideSeconds
      + controlSurfaces.aileron + controlSurfaces.elevator + controlSurfaces.rudder
      + barrel.elapsed + barrel.angle + corkscrewOffset.x + corkscrewOffset.y + corkscrewOffset.z
      + smoothedYawRate + smoothedGForce + previousHeading + propAngle + idleSeconds + pitchIdleSeconds;
    return Number.isFinite(sum);
  }

  /** Clears rates, smoothers, assists and the canned roll; keeps attitude, speed and position. */
  function resetInternals(heading) {
    rates.pitch = 0;
    rates.roll = 0;
    rates.yaw = 0;
    rates.worldPitch = 0;
    rates.turn = 0;
    assist.cushion = 0;
    assist.proximity = 0;
    assist.urgency = 0;
    assist.risingTerrain = 0;
    assist.ceiling = 0;
    assist.evade = 0;
    assist.evadeDirection = 0;
    barrel.active = false;
    barrel.elapsed = 0;
    barrel.angle = 0;
    player.barrelRoll.active = false;
    player.barrelRoll.progress = 0;
    autopilotState.commandedBank = 0;
    autopilotState.rollRate = 0;
    autopilotState.worldPitchRate = 0;
    autopilotState.overrideSeconds = 0;
    if (!Number.isFinite(autopilotState.throttle)) autopilotState.throttle = AUTOPILOT.CRUISE_THROTTLE;
    if (!Number.isFinite(player.throttle)) player.throttle = AUTOPILOT.CRUISE_THROTTLE;
    controlSurfaces.aileron = 0;
    controlSurfaces.elevator = 0;
    controlSurfaces.rudder = 0;
    corkscrewOffset.set(0, 0, 0);
    if (!Number.isFinite(propAngle)) propAngle = 0;
    stalled = false;
    idleSeconds = 0;
    pitchIdleSeconds = 0;
    smoothedYawRate = 0;
    smoothedGForce = 1;
    lookahead.age = Infinity;
    previousHeading = heading;
  }

  /** Stick axes as finite values in [-1, 1] (a bad input value reads as centred). */
  function axisValue(value) {
    return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  function computeAttitudeFrame() {
    bodyForward.set(0, 0, -1).applyQuaternion(attitude);
    bodyUp.set(0, 1, 0).applyQuaternion(attitude);
    bodyRight.set(1, 0, 0).applyQuaternion(attitude);
    frame.pitch = Math.asin(clamp(bodyForward.y, -1, 1));
    frame.bank = Math.atan2(-bodyRight.y, bodyUp.y);
    frame.horizontalLength = Math.hypot(bodyForward.x, bodyForward.z);
    if (frame.horizontalLength > 1e-4) horizontalRight.set(-bodyForward.z / frame.horizontalLength, 0, bodyForward.x / frame.horizontalLength);
    else horizontalRight.copy(bodyRight);
    frame.liftFactor = smooth01((speed - SPEED.MIN) / (SPEED.CRUISE * 0.8 - SPEED.MIN));
  }

  function updateThrottle(step) {
    if (input.throttleTarget !== lastThrottleTarget) {
      lastThrottleTarget = input.throttleTarget;
      if (input.throttleTarget !== null && Number.isFinite(input.throttleTarget)) {
        throttleGoal = clamp(input.throttleTarget, 0, 1);
        autopilotState.throttleOverride = true;
      }
    }
    let throttle = Number.isFinite(player.throttle) ? player.throttle : AUTOPILOT.CRUISE_THROTTLE;
    const throttleDelta = axisValue(input.throttleDelta);
    if (throttleDelta !== 0) {
      throttleGoal = null;
      throttle += throttleDelta * THROTTLE_RATE * step;
      autopilotState.throttleOverride = true;
    } else if (throttleGoal !== null) {
      throttle = damp(throttle, throttleGoal, 5, step);
      if (Math.abs(throttle - throttleGoal) < 0.003) {
        throttle = throttleGoal;
        throttleGoal = null;
      }
    } else if (player.autopilot.enabled && !autopilotState.throttleOverride) {
      throttle = damp(throttle, autopilotState.throttle, 0.8, step);
    }
    player.throttle = clamp(throttle, 0, 1);
  }

  function updateBoost(step) {
    const boostState = player.boost;
    if (boostState.active) {
      boostState.remaining = Math.max(0, boostState.remaining - step);
      if (boostState.remaining <= 0) boostState.active = false;
    } else if (boostState.cooldown > 0) {
      boostState.cooldown = Math.max(0, boostState.cooldown - step);
    }
  }

  function updateStall() {
    if (!stalled && speed < SPEED.STALL) {
      stalled = true;
      bus.emit('stall', {});
    } else if (stalled && speed > SPEED.STALL + STALL_EXIT_MARGIN) {
      stalled = false;
    }
  }

  /**
   * Ground / water guard and the soft ceiling (no crash state, ever).
   * - `urgency` rises as the time to reach the surface drops below 2.5 s, or as the climb
   *   gradient needed to clear terrain 1-3.4 s ahead exceeds the current path gradient;
   *   it drives a firm nose-up pull and blocks further nose-down input.
   * - `proximity` flattens the path in the last 25 m.
   * - `evade` banks toward the lower side when the terrain ahead is too steep to out-climb.
   */
  function updateTerrainAssist(step) {
    const position = player.position;
    const groundHere = groundFloor(position.x, position.z);
    const clearanceHere = position.y - groundHere;
    const horizontalLength = Math.hypot(pathDirection.x, pathDirection.z);
    const headingX = horizontalLength > 1e-3 ? pathDirection.x / horizontalLength : bodyForward.x;
    const headingZ = horizontalLength > 1e-3 ? pathDirection.z / horizontalLength : bodyForward.z;
    const horizontalSpeed = Math.max(speed * horizontalLength, 20);
    let requiredGradient = -Infinity;
    let highestAhead = groundHere;
    for (const seconds of GUARD_PROBE_SECONDS) {
      const distance = horizontalSpeed * seconds;
      const ground = groundFloor(position.x + headingX * distance, position.z + headingZ * distance);
      highestAhead = Math.max(highestAhead, ground);
      requiredGradient = Math.max(requiredGradient, (ground + GUARD_MARGIN - position.y) / distance);
    }
    const pathGradient = pathDirection.y / Math.max(horizontalLength, 0.05);
    const terrainUrgency = clamp((requiredGradient - pathGradient) / 0.35, 0, 1);
    const descentRate = -pathDirection.y * speed;
    const timeToGround = descentRate > 0.5 ? Math.max(0, clearanceHere) / descentRate : Infinity;
    const descentUrgency = clamp(1 - (timeToGround - IMPACT_FULL_SECONDS) / (IMPACT_WARNING_SECONDS - IMPACT_FULL_SECONDS), 0, 1);
    assist.urgency = Math.max(descentUrgency, terrainUrgency);
    const descending = pathDirection.y < 0.02;
    assist.proximity = clamp(1 - clearanceHere / CUSHION_HEIGHT, 0, 1) * (descending ? 1 : 0.3);
    assist.cushion = Math.max(assist.urgency, assist.proximity);
    assist.risingTerrain = highestAhead > groundHere + 1 ? clamp(1 - (position.y - highestAhead) / CUSHION_HEIGHT, 0, 1) : 0;

    const evadeTarget = smooth01((requiredGradient - GUARD_EVADE_GRADIENT) / 0.35);
    if (evadeTarget > 0.05 && assist.evadeDirection === 0) assist.evadeDirection = chooseEvadeSide(position, headingX, headingZ, horizontalSpeed);
    assist.evade = damp(assist.evade, evadeTarget, 4, step);
    if (assist.evade < 0.02 && evadeTarget === 0) {
      assist.evade = 0;
      assist.evadeDirection = 0;
    }
    const ceilingStart = CONFIG.MAX_ALTITUDE - CEILING_BAND;
    assist.ceiling = smooth01((position.y - ceilingStart) / CEILING_BAND);
  }

  function groundFloor(x, z) {
    return Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  }

  /** +1 = bank right, -1 = bank left: whichever side is lower ~2 s ahead (current bank breaks ties). */
  function chooseEvadeSide(position, headingX, headingZ, horizontalSpeed) {
    const distance = horizontalSpeed * 2;
    const diagonal = Math.SQRT1_2;
    const rightX = headingX * diagonal - headingZ * diagonal;
    const rightZ = headingZ * diagonal + headingX * diagonal;
    const leftX = headingX * diagonal + headingZ * diagonal;
    const leftZ = headingZ * diagonal - headingX * diagonal;
    const rightGround = groundFloor(position.x + rightX * distance, position.z + rightZ * distance);
    const leftGround = groundFloor(position.x + leftX * distance, position.z + leftZ * distance);
    if (Math.abs(rightGround - leftGround) < 8) return frame.bank < 0 ? -1 : 1;
    return rightGround < leftGround ? 1 : -1;
  }

  /**
   * Samples world.heightAt along `headingDegrees` and the current path (cached), ignoring
   * points farther than `maxDistance` (ring following stops just past the ring).
   */
  function refreshLookahead(headingDegrees, maxDistance) {
    const position = player.position;
    const moved = Math.hypot(position.x - lookahead.x, position.z - lookahead.z);
    const turned = Math.abs(wrapSignedDegrees(headingDegrees - lookahead.heading));
    const limitChanged = Number.isFinite(maxDistance) !== Number.isFinite(lookahead.limit)
      || (Number.isFinite(maxDistance) && Math.abs(lookahead.limit - moved - maxDistance) > 40);
    if (moved < 80 && turned < 6 && lookahead.age <= 0.6 && !limitChanged) return;
    const directionX = Math.sin(headingDegrees * DEG);
    const directionZ = -Math.cos(headingDegrees * DEG);
    let sample = 0;
    for (const distance of AUTOPILOT.LOOKAHEAD_DISTANCES) {
      if (distance > maxDistance) break;
      lookahead.heights[sample] = world.heightAt(position.x + directionX * distance, position.z + directionZ * distance);
      lookahead.distances[sample] = distance;
      sample++;
    }
    // Also along the current flight path, which differs from the target heading mid-turn.
    const pathLength = Math.max(Math.hypot(pathDirection.x, pathDirection.z), 1e-3);
    for (const distance of AUTOPILOT.PATH_LOOKAHEAD_DISTANCES) {
      if (distance > maxDistance) break;
      lookahead.heights[sample] = world.heightAt(position.x + (pathDirection.x / pathLength) * distance, position.z + (pathDirection.z / pathLength) * distance);
      lookahead.distances[sample] = distance;
      sample++;
    }
    lookahead.count = sample;
    lookahead.limit = maxDistance;
    lookahead.x = position.x;
    lookahead.z = position.z;
    lookahead.heading = headingDegrees;
    lookahead.age = 0;
  }

  /** Required floor altitude and the steepest climb gradient needed to clear it. */
  function evaluateTerrainClearance(clearance) {
    const altitude = player.position.y;
    let floor = CONFIG.WATER_LEVEL + clearance;
    let gradient = -Infinity;
    for (let sample = 0; sample < lookahead.count; sample++) {
      const needed = Math.max(lookahead.heights[sample], CONFIG.WATER_LEVEL) + clearance;
      floor = Math.max(floor, needed);
      const distance = lookahead.distances[sample];
      if (distance > 50) gradient = Math.max(gradient, (needed - altitude) / distance);
    }
    lookahead.floor = floor;
    lookahead.gradient = gradient;
  }

  /**
   * Ring target: steer for a point on the ring's axis a couple of seconds ahead of the
   * glider's projection onto that axis (cross-track correction), so the glider arrives on
   * the axis instead of merely pointing at the centre. Terrain is sampled on the direct
   * line to the ring and at most RING_LOOKAHEAD_MARGIN past it.
   */
  function aimAtRing(target, ringPosition, ringNormal) {
    const position = player.position;
    const toRingX = ringPosition.x - position.x;
    const toRingZ = ringPosition.z - position.z;
    const distance = Math.hypot(toRingX, toRingZ);
    target.ring = true;
    target.ringDistance = distance;
    target.heading = headingFromVector(toRingX, toRingZ);
    target.lookaheadHeading = target.heading;
    target.lookaheadLimit = distance + AUTOPILOT.RING_LOOKAHEAD_MARGIN;
    target.clearance = AUTOPILOT.RING_CLEARANCE;
    if (Number.isFinite(ringPosition.y)) target.altitude = ringPosition.y;
    const axisLength = ringNormal ? Math.hypot(ringNormal.x, ringNormal.z) : 0;
    if (!(axisLength > 0.2)) return;
    const axisX = ringNormal.x / axisLength;
    const axisZ = ringNormal.z / axisLength;
    const alongAxis = toRingX * axisX + toRingZ * axisZ;
    const lead = clamp(speed * AUTOPILOT.RING_TRACK_LEAD_SECONDS, AUTOPILOT.RING_TRACK_LEAD_MIN, AUTOPILOT.RING_TRACK_LEAD_MAX);
    target.heading = headingFromVector(toRingX + axisX * (lead - alongAxis), toRingZ + axisZ * (lead - alongAxis));
  }

  function resolveAutopilotTarget(autopilot) {
    const target = autopilotTarget;
    target.heading = autopilot.heading;
    target.altitude = autopilot.altitude;
    target.clearance = AUTOPILOT.CLEARANCE;
    target.ring = false;
    target.ringDistance = 0;
    target.lookaheadLimit = Infinity;
    if (autopilot.followWaypoint) {
      const course = state.ringCourse;
      const ringPosition = course && course.active ? course.nextRingPosition : null;
      const waypoint = state.waypoint;
      if (ringPosition && Number.isFinite(ringPosition.x) && Number.isFinite(ringPosition.z)) {
        aimAtRing(target, ringPosition, course.nextRingNormal);
      } else if (waypoint && Number.isFinite(waypoint.x) && Number.isFinite(waypoint.z)) {
        target.heading = bearingTo(player.position.x, player.position.z, waypoint.x, waypoint.z);
      }
      autopilot.heading = target.heading;
    }
    if (!target.ring) target.lookaheadHeading = target.heading;
    return target;
  }

  function computeAutopilot(step) {
    const target = resolveAutopilotTarget(player.autopilot);
    lookahead.age += step;
    refreshLookahead(target.lookaheadHeading, target.lookaheadLimit);
    evaluateTerrainClearance(target.clearance);
    const terrainLimited = lookahead.floor > target.altitude + 5;
    updateAutopilotBank(target, step);
    const altitudeError = updateAutopilotPitch(target, Math.max(target.altitude, lookahead.floor), terrainLimited);
    const climbing = (altitudeError > 40 && terrainLimited) || lookahead.gradient > 0.08 ? 0.3 : 0;
    autopilotState.throttle = clamp(AUTOPILOT.CRUISE_THROTTLE + (SPEED.CRUISE - speed) * 0.02 + climbing, 0.3, 0.95);
  }

  function updateAutopilotBank(target, step) {
    const steering = target.ring ? AUTOPILOT.RING_STEERING : AUTOPILOT.WAYPOINT_STEERING;
    const headingError = wrapSignedDegrees(target.heading - player.heading);
    const desiredBank = clamp(headingError * steering.BANK_PER_DEGREE * DEG, -steering.MAX_BANK, steering.MAX_BANK);
    autopilotState.commandedBank = damp(autopilotState.commandedBank, desiredBank, steering.DAMPING, step);
    autopilotState.rollRate = clamp(wrapSignedRadians(autopilotState.commandedBank - frame.bank) * 2.8, -steering.MAX_ROLL_RATE, steering.MAX_ROLL_RATE);
  }

  /**
   * Pitch toward the desired altitude. Following a ring, the vertical speed is fed forward so
   * the glider reaches the ring's height as it arrives (time to ring >= 1.5 s), up to 12 deg,
   * and the model's nose drop in banks is cancelled so turns do not sag under the ring.
   * Returns the altitude error (m).
   */
  function updateAutopilotPitch(target, desiredAltitude, terrainLimited) {
    const altitudeError = desiredAltitude - player.position.y;
    const ringTracking = target.ring && !terrainLimited;
    let pitchLimit = AUTOPILOT.MAX_PITCH;
    if (terrainLimited && altitudeError > 0) pitchLimit = AUTOPILOT.TERRAIN_PITCH;
    else if (ringTracking) pitchLimit = AUTOPILOT.RING_MAX_PITCH;
    const maxVerticalSpeed = speed * Math.sin(pitchLimit);
    const closureRate = ringTracking ? 1 / Math.max(target.ringDistance / Math.max(speed, 1), AUTOPILOT.RING_MIN_TIME_TO_RING) : 0.12;
    const desiredVerticalSpeed = clamp(altitudeError * closureRate, -maxVerticalSpeed, maxVerticalSpeed);
    const verticalSpeed = pathDirection.y * speed;
    const verticalSpeedGain = ringTracking ? AUTOPILOT.RING_VERTICAL_SPEED_GAIN : 0.006;
    const verticalTrim = ringTracking ? 0.06 : 0.05;
    let desiredPitch = clamp(
      Math.asin(clamp(desiredVerticalSpeed / Math.max(speed, 1), -1, 1)) + clamp((desiredVerticalSpeed - verticalSpeed) * verticalSpeedGain, -verticalTrim, verticalTrim),
      -pitchLimit,
      pitchLimit,
    );
    // Rising terrain ahead: climb at the gradient it needs (with margin), up to 20 degrees.
    const terrainClimb = lookahead.gradient > 0;
    if (terrainClimb) {
      const terrainPitch = Math.min(Math.atan(lookahead.gradient * 1.25), AUTOPILOT.TERRAIN_MAX_PITCH);
      if (terrainPitch > desiredPitch) desiredPitch = terrainPitch;
    }
    const pitchGain = terrainClimb || ringTracking ? 3 : 2.2;
    let worldPitchRate = clamp((desiredPitch - frame.pitch) * pitchGain, -25 * DEG, 25 * DEG);
    if (ringTracking) worldPitchRate += BANK_NOSE_DROP * Math.sin(frame.bank) ** 2;
    autopilotState.worldPitchRate = worldPitchRate;
    return altitudeError;
  }

  function updateAutopilotOverride(step) {
    if (!player.autopilot.enabled) {
      autopilotState.overrideSeconds = 0;
      return;
    }
    const manual = Math.max(Math.abs(input.pitch), Math.abs(input.roll), Math.abs(input.yaw));
    if (manual > AUTOPILOT.OVERRIDE_INPUT) {
      autopilotState.overrideSeconds += step;
      if (autopilotState.overrideSeconds >= AUTOPILOT.OVERRIDE_SECONDS) setAutopilot({ enabled: false, reason: 'manual override' });
    } else {
      autopilotState.overrideSeconds = 0;
    }
  }

  function coordinatedTurnRate() {
    const bankSin = -bodyRight.y;
    const bankCos = bodyUp.y;
    const rate = (TURN_GAIN * GRAVITY * bankSin) / (Math.max(speed, SPEED.MIN) * Math.max(Math.abs(bankCos), 0.3));
    return clamp(rate * (0.5 + 0.5 * frame.liftFactor), -MAX_TURN_RATE, MAX_TURN_RATE);
  }

  /**
   * Bank-to-turn: roll / yaw input sets a target bank (eased by the rate limit and the rate
   * damping); zero input means wings level. Near vertical the bank angle is undefined, so
   * the stick blends over to a plain roll rate there.
   */
  function manualBankRollRate(rollCommand, yawCommand, authority, verticalWeight) {
    const bankLimit = MAX_BANK * (input.fineControl ? FINE_BANK_SCALE : 1);
    const targetBank = clamp(rollCommand * bankLimit + yawCommand * YAW_BANK, -MAX_BANK, MAX_BANK);
    const rateLimit = MAX_ROLL_RATE * authority;
    const holdRate = clamp(wrapSignedRadians(targetBank - frame.bank) * BANK_GAIN, -rateLimit, rateLimit);
    return holdRate * verticalWeight + rollCommand * rateLimit * (1 - verticalWeight);
  }

  function updateRotation(step) {
    const autopilotActive = player.autopilot.enabled;
    let pitchCommand = 0;
    let rollCommand = 0;
    let yawCommand = 0;
    if (autopilotActive) computeAutopilot(step);
    else {
      pitchCommand = axisValue(input.pitch);
      // Near the surface the pilot cannot push the nose further down: there is no crash state.
      if (pitchCommand < 0) pitchCommand *= 1 - assist.cushion;
      rollCommand = barrel.active ? 0 : axisValue(input.roll);
      yawCommand = axisValue(input.yaw);
    }
    const hasInput = Math.abs(pitchCommand) > 0.05 || Math.abs(rollCommand) > 0.05 || Math.abs(yawCommand) > 0.05;
    idleSeconds = hasInput || barrel.active ? 0 : idleSeconds + step;
    pitchIdleSeconds = Math.abs(pitchCommand) > 0.05 || barrel.active ? 0 : pitchIdleSeconds + step;

    let authority = 0.45 + 0.55 * frame.liftFactor;
    if (stalled) authority *= 0.55;
    if (input.fineControl) authority *= FINE_CONTROL_SCALE;
    const highSpeedPitch = 1 - 0.42 * smooth01((speed - 70) / (SPEED.MAX - 70));
    // Nose elevation changes by pitchRate * cos(bank): taper only input that steepens the attitude.
    const steepening = pitchCommand !== 0 && Math.sign(pitchCommand * Math.cos(frame.bank)) === Math.sign(frame.pitch);
    const pitchTaper = steepening ? 1 - smooth01((Math.abs(frame.pitch) - PITCH_LIMIT_START) / PITCH_LIMIT_RANGE) : 1;

    const targetPitchRate = pitchCommand * MAX_PITCH_RATE * authority * highSpeedPitch * pitchTaper;
    const targetYawRate = yawCommand * MAX_YAW_RATE * authority;
    let targetRollRate = 0;
    let worldPitchRate = 0;
    const verticalWeight = Math.min(1, frame.horizontalLength * 2);

    if (barrel.active) {
      // The canned roll overlays the base attitude, which simply holds its bank meanwhile.
      if (autopilotActive) worldPitchRate += autopilotState.worldPitchRate;
    } else if (autopilotActive) {
      targetRollRate = autopilotState.rollRate;
      worldPitchRate += autopilotState.worldPitchRate;
    } else {
      targetRollRate = manualBankRollRate(rollCommand, yawCommand, authority, verticalWeight);
    }

    if (assist.evade > 0 && !barrel.active) {
      const evadeRollRate = clamp(wrapSignedRadians(assist.evadeDirection * GUARD_EVADE_BANK - frame.bank) * 3, -90 * DEG, 90 * DEG);
      targetRollRate = targetRollRate * (1 - assist.evade) + evadeRollRate * assist.evade;
    }

    // Gentle pitch auto-level once the pitch axis has been idle for AUTO_LEVEL_DELAY: the nose
    // settles level, or a touch nose-down in a bank (a slow, calm descending turn).
    const bankSin = Math.sin(frame.bank);
    let levelBlend = 0;
    if (!autopilotActive && !barrel.active) {
      levelBlend = smooth01((pitchIdleSeconds - AUTO_LEVEL_DELAY) / 0.8) * verticalWeight;
      const settlePitch = -BANK_SETTLE_PITCH * bankSin * bankSin;
      worldPitchRate += clamp((settlePitch - frame.pitch) * 0.7, -15 * DEG, 15 * DEG) * levelBlend;
    }
    if (Math.abs(frame.bank) < 100 * DEG) worldPitchRate -= BANK_NOSE_DROP * bankSin * bankSin * verticalWeight * (1 - levelBlend);
    if (stalled) worldPitchRate += clamp((STALL_NOSE_TARGET - frame.pitch) * 1.8, -40 * DEG, 0);
    if (assist.cushion > 0 && frame.pitch < 12 * DEG) {
      worldPitchRate += assist.cushion * CUSHION_PULL_RATE * clamp((12 * DEG - frame.pitch) / (20 * DEG), 0.25, 1);
    }
    if (assist.ceiling > 0 && frame.pitch > -5 * DEG) worldPitchRate -= assist.ceiling * 30 * DEG;

    rates.pitch = damp(rates.pitch, targetPitchRate, 10, step);
    rates.roll = damp(rates.roll, targetRollRate, 12, step);
    rates.yaw = damp(rates.yaw, targetYawRate, 4, step);
    rates.worldPitch = damp(rates.worldPitch, worldPitchRate, 6, step);
    rates.turn = coordinatedTurnRate();

    if (rates.pitch !== 0) attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_RIGHT, rates.pitch * step));
    if (rates.roll !== 0) attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_FORWARD, rates.roll * step));
    if (rates.yaw !== 0) attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_UP, -rates.yaw * step));
    if (rates.worldPitch !== 0) attitude.premultiply(scratchQuaternion.setFromAxisAngle(horizontalRight, rates.worldPitch * step));
    if (rates.turn !== 0) attitude.premultiply(scratchQuaternion.setFromAxisAngle(WORLD_UP, -rates.turn * step));
    attitude.normalize();
  }

  function updateEnergy(step) {
    const terminalSpeed = SPEED.MAX * Math.pow(player.throttle, THROTTLE_SPEED_EXPONENT);
    let thrust = DRAG_COEFFICIENT * terminalSpeed * terminalSpeed;
    if (player.boost.active) thrust = Math.max(thrust, DRAG_COEFFICIENT * SPEED.BOOST_MAX * SPEED.BOOST_MAX);
    thrust *= 1 - 0.6 * assist.ceiling;
    const drag = DRAG_COEFFICIENT * speed * speed;
    const induced = INDUCED_DRAG * clamp(smoothedGForce - 1, 0, INDUCED_MAX_EXTRA_G);
    const gravityAlongPath = GRAVITY * pathDirection.y;
    speed += (thrust - drag - induced - gravityAlongPath) * step;
    if (!player.boost.active && speed > SPEED.MAX) speed = damp(speed, SPEED.MAX, 1.4, step);
    speed = clamp(speed, SPEED.MIN, SPEED.BOOST_MAX);
  }

  function updatePath(step) {
    bodyForward.set(0, 0, -1).applyQuaternion(attitude);
    const alignRate = 1.2 + 4.6 * frame.liftFactor;
    pathDirection.lerp(bodyForward, 1 - Math.exp(-alignRate * step));
    const mush = (1 - frame.liftFactor) * (1 - frame.liftFactor);
    pathDirection.y -= mush * 0.55 * step;
    pathDirection.normalize();
    if (assist.proximity > 0 || assist.risingTerrain > 0) {
      if (pathDirection.y < 0) pathDirection.y *= Math.exp(-assist.proximity * 7 * step);
      if (assist.risingTerrain > 0) pathDirection.y = Math.min(0.35, pathDirection.y + assist.risingTerrain * 0.9 * step);
      pathDirection.normalize();
    }
    if (assist.ceiling > 0 && pathDirection.y > 0) {
      pathDirection.y *= Math.exp(-assist.ceiling * 3 * step);
      pathDirection.normalize();
    }
  }

  function updateBarrelRoll(step) {
    if (!barrel.active) {
      barrel.angle = 0;
      player.barrelRoll.active = false;
      player.barrelRoll.progress = 0;
      return;
    }
    barrel.elapsed += step;
    const progress = Math.min(1, barrel.elapsed / BARREL_ROLL_DURATION);
    barrel.angle = Math.PI * 2 * easeRollProgress(progress) * barrel.direction;
    player.barrelRoll.progress = progress;
    if (progress >= 1) {
      barrel.active = false;
      barrel.angle = 0;
      player.barrelRoll.active = false;
      player.barrelRoll.progress = 1;
    }
  }

  function writeDerivedState(step) {
    player.quaternion.copy(attitude);
    if (barrel.active && barrel.angle !== 0) player.quaternion.multiply(rollOffset.setFromAxisAngle(LOCAL_FORWARD, barrel.angle));
    player.forward.set(0, 0, -1).applyQuaternion(player.quaternion);
    player.up.set(0, 1, 0).applyQuaternion(player.quaternion);
    player.right.set(1, 0, 0).applyQuaternion(player.quaternion);
    player.speed = speed;
    player.velocity.copy(pathDirection).multiplyScalar(speed);
    const horizontal = Math.hypot(player.forward.x, player.forward.z);
    if (horizontal > 0.05) player.heading = headingFromVector(player.forward.x, player.forward.z);
    else if (!Number.isFinite(player.heading)) player.heading = lastFiniteHeading;
    if (Number.isFinite(player.heading)) lastFiniteHeading = player.heading;
    player.pitch = Math.asin(clamp(player.forward.y, -1, 1)) / DEG;
    player.roll = Math.atan2(-player.right.y, player.up.y) / DEG;
    player.verticalSpeed = player.velocity.y;
    player.stalled = stalled;
    if (step > 0) {
      const headingChange = wrapSignedDegrees(player.heading - previousHeading) / step;
      smoothedYawRate = damp(smoothedYawRate, headingChange, 10, step);
      const loadFactor = computeLoadFactor();
      if (Number.isFinite(loadFactor)) smoothedGForce = damp(smoothedGForce, loadFactor, LOAD.SMOOTHING, step);
    }
    player.yawRate = smoothedYawRate;
    player.gForce = smoothedGForce;
    previousHeading = player.heading;
  }

  /**
   * Plausible load factor for this arcade model: cos(path pitch) / cos(bank) for the turn
   * (the model's exaggerated turn gain does not inflate it), plus a modest share of the
   * pitch-rate pull (v * q / g), both weaker on a slow wing, soft-capped toward LOAD.CAP.
   */
  function computeLoadFactor() {
    const liftShare = 0.35 + 0.65 * frame.liftFactor;
    const bankCos = Math.max(Math.abs(Math.cos(frame.bank)), LOAD.MIN_BANK_COS);
    const pathPitchCos = Math.sqrt(Math.max(0, 1 - pathDirection.y * pathDirection.y));
    const turnLoad = 1 + (pathPitchCos / bankCos - 1) * liftShare;
    const pitchRate = rates.pitch + rates.worldPitch * Math.cos(frame.bank);
    const pullLoad = ((speed * pitchRate) / GRAVITY) * LOAD.PULL_SHARE * liftShare;
    const rollLoad = barrel.active ? LOAD.BARREL_ROLL_EXTRA * Math.sin(Math.PI * player.barrelRoll.progress) : 0;
    const load = turnLoad + pullLoad + rollLoad;
    if (load <= LOAD.KNEE) return Math.max(load, LOAD.MIN);
    const headroom = LOAD.CAP - LOAD.KNEE;
    return LOAD.KNEE + headroom * Math.tanh((load - LOAD.KNEE) / headroom);
  }

  // ---- Visual animation ----------------------------------------------------------------------
  function animateModel(step) {
    const elevatorTarget = clamp(rates.pitch / MAX_PITCH_RATE + (rates.worldPitch / MAX_PITCH_RATE) * 0.6, -1, 1);
    const aileronTarget = barrel.active ? barrel.direction : clamp((rates.roll / MAX_ROLL_RATE) * 1.3, -1, 1);
    const rudderTarget = clamp(rates.yaw / MAX_YAW_RATE + (rates.turn / MAX_TURN_RATE) * 0.3, -1, 1);
    controlSurfaces.elevator = damp(controlSurfaces.elevator, elevatorTarget, 12, step);
    controlSurfaces.aileron = damp(controlSurfaces.aileron, aileronTarget, 12, step);
    controlSurfaces.rudder = damp(controlSurfaces.rudder, rudderTarget, 10, step);
    // Right aileron trailing edge rises for a right roll; the left hinge axis is mirrored,
    // so the same signed angle lowers the left aileron.
    const aileronAngle = -controlSurfaces.aileron * 20 * DEG;
    aileronRight.quaternion.setFromAxisAngle(aileronRight.userData.axis, aileronAngle);
    aileronLeft.quaternion.setFromAxisAngle(aileronLeft.userData.axis, aileronAngle);
    elevator.quaternion.setFromAxisAngle(elevator.userData.axis, -controlSurfaces.elevator * 18 * DEG);
    rudder.quaternion.setFromAxisAngle(rudder.userData.axis, controlSurfaces.rudder * 22 * DEG);

    const propSpeed = 5 + 23 * player.throttle + (player.boost.active ? 8 : 0);
    propAngle = (propAngle + propSpeed * step) % (Math.PI * 2);
    propeller.rotation.z = propAngle;
    discOpacity.value = 0.05 + 0.3 * smooth01((propSpeed - 8) / 24);

    animateNavLights();

    const elapsed = state.time.elapsed;
    const turbulence = 0.35 + 0.65 * clamp(player.inCloud ?? 0, 0, 1) + 0.4 * smooth01((speed - SPEED.CRUISE) / (SPEED.MAX - SPEED.CRUISE));
    wobbleEuler.set(
      (Math.sin(elapsed * 1.31) * 0.6 + Math.sin(elapsed * 2.73 + 1.2) * 0.4) * 0.3 * DEG * turbulence,
      Math.sin(elapsed * 0.97 + 0.4) * 0.15 * DEG * turbulence,
      (Math.sin(elapsed * 1.07 + 2.1) * 0.6 + Math.sin(elapsed * 2.21) * 0.4) * 0.55 * DEG * turbulence,
      'YXZ',
    );
    wobbleQuaternion.setFromEuler(wobbleEuler);

    if (barrel.active) {
      const theta = Math.abs(barrel.angle);
      bodyUp.set(0, 1, 0).applyQuaternion(attitude);
      bodyRight.set(1, 0, 0).applyQuaternion(attitude);
      corkscrewOffset.copy(bodyUp).multiplyScalar(Math.sin(theta) * BARREL_ROLL_RADIUS)
        .addScaledVector(bodyRight, barrel.direction * (1 - Math.cos(theta)) * BARREL_ROLL_RADIUS);
    } else {
      corkscrewOffset.set(0, 0, 0);
    }
  }

  /** Small points of light: brighter and slightly wider glow from dusk on; strobe = short blink. */
  function animateNavLights() {
    const night = clamp(state.time.nightFactor ?? 0, 0, 1);
    const dusk = Math.max(night, 1 - smooth01(((state.time.sunElevation ?? 30) + 2) / 10));
    navIntensity.value = 2.2 + 2.8 * dusk;
    glowStrength.value = 0.12 + 0.5 * dusk;
    const glowScale = NAV_GLOW.DAY_SCALE + (NAV_GLOW.NIGHT_SCALE - NAV_GLOW.DAY_SCALE) * dusk;
    glowSprites[0].scale.setScalar(glowScale);
    glowSprites[1].scale.setScalar(glowScale);
    const strobePhase = state.time.elapsed % STROBE_PERIOD;
    const flash = strobePhase < STROBE_FLASH_SECONDS ? (1 - strobePhase / STROBE_FLASH_SECONDS) ** 2 : 0;
    strobeIntensity.value = 0.5 + flash * (3.5 + 4.5 * dusk);
    strobeGlowStrength.value = flash * (0.25 + 0.55 * dusk);
    glowSprites[2].visible = flash > 0;
    glowSprites[2].scale.setScalar(NAV_GLOW.STROBE_SCALE);
  }

  /** Places the model at the (possibly safety-clamped) player pose. Camera calls this too. */
  function syncVisual() {
    planeMesh.position.copy(player.position).add(corkscrewOffset);
    planeMesh.quaternion.copy(player.quaternion).multiply(wobbleQuaternion);
  }

  // ---- Public actions -----------------------------------------------------------------------------
  function boost() {
    const boostState = player.boost;
    if (state.photoMode || boostState.active || boostState.cooldown > 0) return false;
    boostState.active = true;
    boostState.remaining = BOOST_DURATION;
    boostState.cooldown = BOOST_COOLDOWN;
    boostState.cooldownTotal = BOOST_COOLDOWN;
    bus.emit('boost', {});
    return true;
  }

  function barrelRoll(direction) {
    if (barrel.active || state.photoMode) return false;
    const rollDirection = direction === 'left' || direction < 0 ? -1 : 1;
    attitude.copy(player.quaternion);
    barrel.active = true;
    barrel.direction = rollDirection;
    barrel.elapsed = 0;
    barrel.angle = 0;
    player.barrelRoll.active = true;
    player.barrelRoll.direction = rollDirection;
    player.barrelRoll.progress = 0;
    bus.emit('barrelroll', { direction: rollDirection });
    return true;
  }

  function setAutopilot(options = {}) {
    const autopilot = player.autopilot;
    const wasEnabled = autopilot.enabled;
    if (typeof options.enabled === 'boolean') autopilot.enabled = options.enabled;
    const engaging = autopilot.enabled && !wasEnabled;
    if (Number.isFinite(options.heading)) autopilot.heading = wrapDegrees(options.heading);
    else if (engaging) autopilot.heading = player.heading;
    if (Number.isFinite(options.altitude)) autopilot.altitude = clamp(options.altitude, AUTOPILOT.MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    else if (engaging) autopilot.altitude = clamp(player.position.y, AUTOPILOT.MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    if (typeof options.followWaypoint === 'boolean') autopilot.followWaypoint = options.followWaypoint;
    if (engaging) {
      autopilotState.throttleOverride = false;
      autopilotState.overrideSeconds = 0;
      autopilotState.commandedBank = frame.bank;
      lookahead.age = Infinity;
    }
    const reason = typeof options.reason === 'string' && options.reason ? options.reason : 'command';
    bus.emit('autopilot:changed', {
      enabled: autopilot.enabled,
      heading: autopilot.heading,
      altitude: autopilot.altitude,
      followWaypoint: autopilot.followWaypoint,
      reason,
    });
    return { ...autopilot };
  }

  function getWingtips() {
    for (let index = 0; index < 2; index++) {
      wingtips[index].copy(WINGTIP_LOCAL[index]).applyQuaternion(planeMesh.quaternion).add(planeMesh.position);
    }
    return wingtips;
  }

  /** Level flight at cruise from (x, y, z); also core's recovery path after a non-finite pose. */
  function resetTo(target = {}) {
    const { x, y, z } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    let heading = lastFiniteHeading;
    if (Number.isFinite(target.heading)) heading = wrapDegrees(target.heading);
    else if (Number.isFinite(player.heading)) heading = player.heading;
    player.position.set(x, y, z);
    lastFinitePosition.set(x, y, z);
    attitude.setFromAxisAngle(WORLD_UP, -heading * DEG);
    vectorFromHeading(heading, pathDirection);
    speed = SPEED.CRUISE;
    resetInternals(heading);
    player.boost.active = false;
    player.boost.remaining = 0;
    player.boost.cooldown = 0;
    player.heading = heading;
    lastFiniteHeading = heading;
    if (player.autopilot.enabled) {
      player.autopilot.heading = heading;
      player.autopilot.altitude = clamp(y, AUTOPILOT.MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    }
    computeAttitudeFrame();
    writeDerivedState(0);
    syncVisual();
    ctx.systems.camera?.snap?.();
    return true;
  }

  computeAttitudeFrame();
  writeDerivedState(0);
  syncVisual();

  return {
    planeMesh,

    update(dt) {
      if (!(dt > 0)) return;
      const step = Math.min(dt, 0.05);
      syncFromState();
      updateThrottle(step);
      if (input.boost) boost();
      updateBoost(step);
      updateAutopilotOverride(step);
      computeAttitudeFrame();
      updateStall();
      updateTerrainAssist(step);
      updateRotation(step);
      updateEnergy(step);
      updatePath(step);
      player.position.addScaledVector(pathDirection, speed * step);
      if (isFiniteVector(player.position)) lastFinitePosition.copy(player.position);
      updateBarrelRoll(step);
      writeDerivedState(step);
      animateModel(step);
      syncVisual();
    },

    setAutopilot,
    barrelRoll,
    boost,
    getWingtips,
    resetTo,
    syncVisual,

    /** Attitude without the canned barrel-roll offset (keeps the chase camera steady). */
    getBaseQuaternion() {
      return attitude;
    },

    getStats() {
      let triangles = 0;
      planeMesh.traverse((object) => {
        if (!object.isMesh) return;
        const geometry = object.geometry;
        triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
      });
      return {
        triangles,
        stalled,
        cushion: Math.round(assist.cushion * 100) / 100,
        idleSeconds: Math.round(idleSeconds * 10) / 10,
        baseBank: Math.round(frame.bank / DEG),
        turnRate: Math.round((rates.turn / DEG) * 10) / 10,
        barrelRoll: barrel.active,
      };
    },
  };
}
