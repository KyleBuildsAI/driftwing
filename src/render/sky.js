import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG } from '../core/config.js';
import { DEG, clamp, damp } from '../core/util.js';
import { sunDirectionForDayTime, moonDirectionForDayTime, dayTimeForSunElevation } from '../core/sun.js';

/**
 * SKY / ATMOSPHERE: owns the time of day and everything the sky does with it.
 * - Day cycle with a time warp (golden hours linger, nights pass quicker), presets and smooth transitions.
 * - Sky dome shader: sun-elevation keyed gradient, azimuth-tinted horizon, Mie glow, HDR sun disc, radial
 *   god rays, moon with phase shading, twinkling star field + milky way, aurora curtains over snow.
 * - Fog: scene.fog is mutated (colour/near/far) and scene.fogNode colours distant geometry with the SAME
 *   sky function used by the dome, so fully fogged geometry dissolves exactly into the sky behind it.
 * - Lights: shadow-casting sun that follows the player with texel snapping, cool moon light, hemisphere fill.
 * - Grade (exposure, warmth, night desaturation), camera.far and all shared sky uniforms / state.time fields.
 * - Sky modifiers (Phase 2): addModifier(id, { priority }) lets the regional weather and the celestial
 *   events darken, tint and fog the sky. They act on the CPU-side palette and lights only (no shader
 *   change), and with no modifier weighing in the sky runs exactly the Phase 1 path.
 */
export function createSkySystem(ctx) {
  const { scene, camera, renderer, state, uniforms, settings, bus, CONFIG: config } = ctx;
  const {
    Fn, If, Loop, uniform, float, int, vec2, vec3, positionWorldDirection, positionView, cameraViewMatrix, cameraPosition,
    dot, pow, exp, exp2, mix, smoothstep, saturate, sin, cos, abs, fract, floor, sqrt, length, clamp: clampNode, step, max,
    fog, hash, screenCoordinate,
  } = TSL;

  // ---- Tunables -----------------------------------------------------------------------------------
  const SUN_ANGULAR_RADIUS = 0.0175;
  const MOON_ANGULAR_RADIUS = 0.024;
  const STAR_CELL_SCALE = 96;
  const AURORA_LAYERS = 20;
  const SHADOW_EXTENT = 320;
  // Shadow box depth along the light: sized each frame to the receivers the camera can see (see
  // updateShadowDepth). The up-sun reach always covers tall casters whose shadows fall into the box.
  const SHADOW_MAX_REACH = 1500;
  const SHADOW_MIN_DOWN_SUN = 260;
  const SHADOW_CASTER_HEIGHT = 140;
  const SHADOW_BIAS_METERS = 0.37;
  const LIGHT_DISTANCE = SHADOW_MAX_REACH;
  const MIN_LIGHT_ELEVATION = 2.5 * DEG;
  const FOG_VERTICAL_SCALE = 0.35;
  // Fog: near never closes in below this; the haze thins with the height of the view ray above the
  // ground under the glider, so looking down from altitude stays clear while the world edge (a
  // separate, height-independent term) always melts into the sky.
  const FOG_NEAR_FLOOR = 450;
  const FOG_SCALE_HEIGHT = 230;
  const FOG_HIGH_DENSITY = 0.3;
  const FOG_EDGE_START = 0.7;
  const DOME_RADIUS_FRACTION = 0.82;
  const CAMERA_FAR_MARGIN = 2500;
  // High altitude: from this height above the ground to the next
  // the far plane reaches down to the terrain below, and the haze counts vertical distance less, so the
  // loaded terrain fades into haze at its rim instead of ending. Below it nothing changes.
  const HIGH_ALTITUDE_START = 3000;
  const HIGH_ALTITUDE_FULL = 6000;
  const HIGH_FOG_VERTICAL_SCALE = 0.16;
  const FAR_STEP = 100;
  // Sky modifiers: the share of a fog density change that also moves the fog's far edge.
  const FOG_DENSITY_FAR_SHARE = 0.5;
  // Clock speed by sun elevation (relative; normalised so a full loop still lasts dayLength). The
  // golden band (-3..14 deg) runs slowest, so the golden-hour start keeps ~60 s of low warm sun
  // before sunset; blue hour runs a little faster and night fastest.
  const WARP_GOLDEN_RATE = 0.16;
  const WARP_TWILIGHT_RATE = 0.55;
  const WARP_DAY_RATE = 1;
  const WARP_NIGHT_RATE = 2;
  const WARP_GOLDEN_LOW = -3;
  const WARP_GOLDEN_HIGH = 14;
  const WARP_EDGE = 4;
  const DEFAULT_TRANSITION_SECONDS = 2.5;
  const CELESTIAL_POLE = new THREE.Vector3(0, Math.sin(52 * DEG), -Math.cos(52 * DEG)).normalize();
  const GALAXY_NORMAL = new THREE.Vector3(0.62, 0.31, -0.72).normalize();
  const AURORA_FILL = new THREE.Color(0x4fd6a8);

  // ---- Keyframes by sun elevation (degrees). Hex values are sRGB; converted to linear once. ----------
  function colorKeys(entries) {
    return entries.map(([elevation, hex]) => ({ elevation, color: new THREE.Color(hex) }));
  }
  function scalarKeys(entries) {
    return entries.map(([elevation, value]) => ({ elevation, value }));
  }
  const KEYS = {
    zenith: colorKeys([[-18, 0x0b1026], [-6, 0x1d2a52], [0, 0x3a4f86], [8, 0x4f6fa8], [17, 0x4876b9], [30, 0x3d7cc9]]),
    horizon: colorKeys([[-18, 0x1a2140], [-6, 0x6a5a86], [0, 0xf39a5b], [8, 0xf2c48e], [16, 0xf1d9b0], [23, 0xd3dde3], [30, 0xb9d6ee]]),
    antiHorizon: colorKeys([[-18, 0x151b38], [-6, 0x4a4775], [-1, 0x8d7797], [3, 0xb99aa3], [8, 0xd7bba8], [20, 0xbdd3e8], [30, 0xb9d6ee]]),
    groundHaze: colorKeys([[-18, 0x141a33], [-6, 0x47426c], [0, 0xa27d74], [8, 0xc4a489], [17, 0xc3b39c], [30, 0xa3bccf]]),
    glow: colorKeys([[-12, 0x3a2a55], [-6, 0x8c4c6c], [-2, 0xe0664a], [1, 0xff7a2a], [6, 0xff9444], [12, 0xffb468], [25, 0xffe2c0], [45, 0xfff4e4]]),
    light: colorKeys([[-4, 0xff6a5a], [-1, 0xff7448], [1, 0xff8a45], [4, 0xffa35a], [9, 0xffbf7c], [16, 0xffd6a6], [28, 0xffead0], [45, 0xfff4e6]]),
    // Night fill is a muted blue-grey (moonlit sky), not a saturated blue: saturated fill turns the
    // flower and grass palettes neon once exposure lifts them.
    hemisphereSky: colorKeys([[-18, 0x7080a4], [-9, 0x7682a8], [-4, 0x8d88a6], [0, 0x9d90aa], [8, 0xa6b4d8], [30, 0xc4d8f0]]),
    hemisphereGround: colorKeys([[-18, 0x1d2029], [-6, 0x2f2c38], [0, 0x6a4a3a], [8, 0x7a5a40], [30, 0x6f6450]]),
    glowStrength: scalarKeys([[-14, 0], [-7, 0.22], [-2, 0.7], [1, 0.9], [8, 0.65], [20, 0.4], [40, 0.26]]),
    horizonFalloff: scalarKeys([[-18, 2.6], [-6, 2.6], [0, 3.0], [8, 3.6], [20, 5.0], [40, 6.0]]),
    sunIntensity: scalarKeys([[-4, 0], [-1, 0.25], [0.5, 0.9], [3, 1.7], [8, 2.4], [16, 2.9], [30, 3.1], [50, 3.1]]),
    discIntensity: scalarKeys([[-2, 4], [2, 9], [8, 14], [20, 20], [45, 24]]),
    hemisphereIntensity: scalarKeys([[-18, 1.55], [-10, 1.6], [-5, 1.9], [-1, 2.1], [4, 2.0], [10, 2.0], [30, 2.1]]),
    moonIntensity: scalarKeys([[-18, 0.62], [-10, 0.5], [-4, 0.2], [0, 0]]),
    exposure: scalarKeys([[-18, 1.3], [-8, 1.25], [-2, 1.12], [4, 1.02], [10, 1.0], [30, 0.95], [50, 0.93]]),
    warmth: scalarKeys([[-18, 0.2], [-8, 0.3], [-2, 0.75], [4, 1.0], [12, 0.95], [25, 0.65], [45, 0.5]]),
    // Post saturation: scotopic vision drains colour at night; golden hour and day keep the rich grade.
    saturation: scalarKeys([[-16, 0.7], [-9, 0.76], [-4, 0.9], [0, 1.02], [4, 1.06]]),
  };

  function smoothUnit(value) {
    const t = value < 0 ? 0 : value > 1 ? 1 : value;
    return t * t * (3 - 2 * t);
  }
  function smoothRange(edge0, edge1, value) {
    return smoothUnit((value - edge0) / (edge1 - edge0));
  }
  function sampleColor(keys, elevation, target) {
    if (elevation <= keys[0].elevation) return target.copy(keys[0].color);
    for (let index = 1; index < keys.length; index++) {
      const upper = keys[index];
      if (elevation <= upper.elevation) {
        const lower = keys[index - 1];
        const t = smoothUnit((elevation - lower.elevation) / (upper.elevation - lower.elevation));
        return target.copy(lower.color).lerp(upper.color, t);
      }
    }
    return target.copy(keys[keys.length - 1].color);
  }
  function sampleScalar(keys, elevation) {
    if (elevation <= keys[0].elevation) return keys[0].value;
    for (let index = 1; index < keys.length; index++) {
      const upper = keys[index];
      if (elevation <= upper.elevation) {
        const lower = keys[index - 1];
        const t = smoothUnit((elevation - lower.elevation) / (upper.elevation - lower.elevation));
        return lower.value + (upper.value - lower.value) * t;
      }
    }
    return keys[keys.length - 1].value;
  }

  // ---- Display-referred palette -> scene radiance (inverse of three's ACES filmic fit) -------------
  // The palette hexes are art-directed on-screen colours. Running them through the inverse tone curve
  // keeps the displayed sky on palette instead of letting the ACES shoulder wash it out to cream.
  const ACES_INPUT_INVERSE = new THREE.Matrix3()
    .set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777)
    .invert();
  const ACES_OUTPUT_INVERSE = new THREE.Matrix3()
    .set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602)
    .invert();
  const toneScratch = new THREE.Vector3();
  function inverseFilmicFit(value) {
    const target = value < 0 ? 0 : value > 0.97 ? 0.97 : value;
    const a = 1 - 0.983729 * target;
    const b = 0.0245786 - 0.432951 * target;
    const c = -(0.000090537 + 0.238081 * target);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }
  function displayToRadiance(source, target) {
    toneScratch.set(source.r, source.g, source.b).applyMatrix3(ACES_OUTPUT_INVERSE);
    toneScratch.set(inverseFilmicFit(toneScratch.x), inverseFilmicFit(toneScratch.y), inverseFilmicFit(toneScratch.z));
    toneScratch.applyMatrix3(ACES_INPUT_INVERSE).multiplyScalar(0.6);
    return target.setRGB(Math.max(0, toneScratch.x), Math.max(0, toneScratch.y), Math.max(0, toneScratch.z));
  }

  // ---- Time model ----------------------------------------------------------------------------------
  function wrapUnit(value) {
    return ((value % 1) + 1) % 1;
  }
  function elevationForDayTime(value) {
    return Math.sin((value - 0.25) * Math.PI * 2) * config.SUN_MAX_ELEVATION_DEG;
  }
  /** Relative speed of the clock: golden hours linger, nights pass a little quicker. */
  function warpRate(elevation) {
    const outside = elevation >= 0 ? WARP_DAY_RATE : WARP_NIGHT_RATE;
    const aboveGoldenFloor = smoothRange(WARP_GOLDEN_LOW - WARP_EDGE, WARP_GOLDEN_LOW, elevation);
    const golden = aboveGoldenFloor * (1 - smoothRange(WARP_GOLDEN_HIGH, WARP_GOLDEN_HIGH + WARP_EDGE, elevation));
    const rate = outside + (WARP_GOLDEN_RATE - outside) * golden;
    const twilight = smoothRange(-14, -10, elevation) * (1 - aboveGoldenFloor);
    return rate + (WARP_TWILIGHT_RATE - rate) * twilight;
  }
  /** Integral of 1 / rate over one loop: scales the warp so a full loop still lasts dayLength seconds. */
  const WARP_NORMALISATION = (() => {
    const samples = 2048;
    let total = 0;
    for (let index = 0; index < samples; index++) total += 1 / warpRate(elevationForDayTime((index + 0.5) / samples));
    return total / samples;
  })();

  function isMorning(value) {
    return value < 0.5;
  }
  function labelFor(elevation, value) {
    if (elevation < -10) return 'night';
    if (elevation < -4) return 'blue hour';
    if (elevation < 0) return isMorning(value) ? 'dawn' : 'dusk';
    if (elevation < 14) return 'golden hour';
    if (elevation < 52) return isMorning(value) ? 'morning' : 'afternoon';
    return 'midday';
  }

  const PRESETS = {
    dawn: dayTimeForSunElevation(-2.5, false),
    sunrise: dayTimeForSunElevation(1.5, false),
    morning: dayTimeForSunElevation(22, false),
    noon: 0.5,
    golden: dayTimeForSunElevation(8, true),
    sunset: dayTimeForSunElevation(0.8, true),
    dusk: dayTimeForSunElevation(-3, true),
    night: dayTimeForSunElevation(-30, true),
    midnight: 0,
  };
  const PRESET_ALIASES = {
    day: 'noon',
    midday: 'noon',
    goldenhour: 'golden',
    evening: 'golden',
    twilight: 'dusk',
    bluehour: 'dusk',
    sundown: 'sunset',
    daybreak: 'dawn',
  };
  function resolvePreset(name) {
    if (typeof name !== 'string') return null;
    const key = name.toLowerCase().replace(/[\s_-]+/g, '');
    if (key in PRESETS) return key;
    if (key in PRESET_ALIASES) return PRESET_ALIASES[key];
    return null;
  }

  // ---- Shader uniforms owned by the sky (shared ones live in ctx.uniforms) ---------------------------
  const sky = {
    zenith: uniform(new THREE.Color()),
    horizon: uniform(new THREE.Color()),
    antiHorizon: uniform(new THREE.Color()),
    groundHaze: uniform(new THREE.Color()),
    glowColor: uniform(new THREE.Color()),
    glowStrength: uniform(1),
    aureoleStrength: uniform(1),
    horizonFalloff: uniform(2.4),
    sunDiscColor: uniform(new THREE.Color()),
    sunRight: uniform(new THREE.Vector3(1, 0, 0)),
    sunUp: uniform(new THREE.Vector3(0, 1, 0)),
    rayStrength: uniform(0),
    moonRight: uniform(new THREE.Vector3(1, 0, 0)),
    moonUp: uniform(new THREE.Vector3(0, 1, 0)),
    moonStrength: uniform(0),
    moonGlowColor: uniform(new THREE.Color(0x8fa6d8)),
    starStrength: uniform(0),
    starRotation: uniform(new THREE.Matrix3()),
    auroraStrength: uniform(0),
    fogLayerBase: uniform(0),
    auroraGlow: uniform(new THREE.Color(0, 0, 0)),
    fogNear: uniform(400),
    fogFar: uniform(2400),
    fogVerticalScale: uniform(FOG_VERTICAL_SCALE),
  };

  const auroraLayerCount = uniform(AURORA_LAYERS, 'int');

  // ---- TSL helpers ---------------------------------------------------------------------------------
  /** Dave Hoskins' sine-free hashes (float based, stable for moderate cell coordinates). */
  const hash13 = Fn(([point]) => {
    const scaled = fract(point.mul(0.1031));
    const mixed = scaled.add(dot(scaled, scaled.zyx.add(31.32)));
    return fract(mixed.x.add(mixed.y).mul(mixed.z));
  });
  const hash33 = Fn(([point]) => {
    const scaled = fract(point.mul(vec3(0.1031, 0.103, 0.0973)));
    const mixed = scaled.add(dot(scaled, scaled.yxz.add(33.33)));
    return fract(mixed.xxy.add(mixed.yxx).mul(mixed.zyx));
  });

  /**
   * Cheap value noise in [-0.75, 0.75] (trilinear over hashed lattice corners). A real shader function
   * (layout), so every call site shares one small body: the MaterialX Perlin noise it replaces made the
   * sky dome the slowest program to link on the WebGL2 fallback.
   */
  const valueNoise3 = Fn(([pointInput]) => {
    const point = vec3(pointInput).toVar();
    const cell = floor(point).toVar();
    const local = fract(point);
    const blend = local.mul(local).mul(local.mul(-2.0).add(3.0)).toVar();
    const corner = (x, y, z) => hash13(cell.add(vec3(x, y, z)));
    const low = mix(mix(corner(0, 0, 0), corner(1, 0, 0), blend.x), mix(corner(0, 1, 0), corner(1, 1, 0), blend.x), blend.y);
    const high = mix(mix(corner(0, 0, 1), corner(1, 0, 1), blend.x), mix(corner(0, 1, 1), corner(1, 1, 1), blend.x), blend.y);
    return mix(low, high, blend.z).mul(1.5).sub(0.75);
  }).setLayout({ name: 'skyValueNoise', type: 'float', inputs: [{ name: 'pointInput', type: 'vec3' }] });

  /**
   * Base sky radiance for a unit world direction: gradient keyed by sun elevation, azimuth-tinted horizon,
   * haze below the horizon, Mie glow around the sun and a soft moon halo. No disc, stars or aurora: this is
   * also the fog colour, so anything fully fogged becomes exactly the sky behind it.
   */
  const skyBase = Fn(([direction]) => {
    const up = direction.y;
    const sunDot = dot(direction, uniforms.sunDirection);
    const sunward = smoothstep(-0.85, 0.6, sunDot);
    const horizonHere = mix(sky.antiHorizon, sky.horizon, sunward);
    const horizonWeight = pow(float(1).sub(saturate(up)), sky.horizonFalloff);
    const aboveColor = mix(sky.zenith, horizonHere, horizonWeight);
    const groundHere = mix(horizonHere, sky.groundHaze, 0.6);
    const baseColor = mix(aboveColor, groundHere, smoothstep(0.0, 0.3, up.negate()));
    const sunClose = saturate(sunDot);
    const horizonBoost = mix(0.45, 1.0, exp(abs(up).mul(-5.0)));
    const aureole = pow(sunClose, 400.0).mul(sky.aureoleStrength);
    const glowShape = pow(sunClose, 4.0).mul(0.12).add(pow(sunClose, 24.0).mul(0.55)).add(aureole);
    const glow = sky.glowColor.mul(glowShape.mul(horizonBoost).mul(sky.glowStrength));
    const moonClose = saturate(dot(direction, uniforms.moonDirection));
    const moonHalo = pow(moonClose, 14.0).mul(0.05).add(pow(moonClose, 240.0).mul(0.22));
    const auroraAmbient = sky.auroraGlow.mul(horizonBoost.mul(smoothstep(-0.25, 0.1, up)));
    return baseColor.add(glow).add(sky.moonGlowColor.mul(moonHalo.mul(sky.moonStrength))).add(auroraAmbient);
  });

  /** 1 below low, 0 above high (smoothstep with reversed edges is undefined in GLSL/WGSL). */
  function fadeOut(low, high, value) {
    return float(1).sub(smoothstep(low, high, value));
  }

  /** Filament noise for aurora curtains (after nimitz' triangle noise), 3 octaves. */
  function triangleWave(value) {
    return clampNode(abs(fract(value).sub(0.5)), 0.01, 0.49);
  }
  function triangleWave2(point) {
    return vec2(triangleWave(point.x).add(triangleWave(point.y)), triangleWave(point.y.add(triangleWave(point.x))));
  }
  function rotate2(point, cosine, sine) {
    return vec2(point.x.mul(cosine).add(point.y.mul(sine)), point.y.mul(cosine).sub(point.x.mul(sine)));
  }
  const auroraNoise = Fn(([planePoint, spinCos, spinSin]) => {
    const warpAngle = planePoint.x.mul(0.06);
    const point = rotate2(planePoint, cos(warpAngle), sin(warpAngle)).toVar();
    const basePoint = vec2(point).toVar();
    const accumulated = float(0).toVar();
    let weight = 1.8;
    let damping = 2.5;
    for (let octave = 0; octave < 3; octave++) {
      const offset = rotate2(triangleWave2(basePoint.mul(1.85)).mul(0.75), spinCos, spinSin);
      point.subAssign(offset.div(damping));
      basePoint.mulAssign(1.3);
      damping *= 0.45;
      weight *= 0.42;
      point.mulAssign(accumulated.sub(1.0).mul(0.02).add(1.21));
      accumulated.addAssign(triangleWave(point.x.add(triangleWave(point.y))).mul(weight));
      point.assign(rotate2(point, 0.95534, 0.29552).negate());
    }
    return clampNode(float(1).div(pow(accumulated.mul(29.0), 1.3)), 0.0, 0.55);
  });

  const skyDomeColor = Fn(() => {
    const direction = positionWorldDirection;
    const up = direction.y;
    const radiance = skyBase(direction).toVar();
    const time = uniforms.time;

    // HDR sun disc with limb darkening, sinking behind the horizon line.
    const sunOffset = length(direction.sub(uniforms.sunDirection));
    const disc = fadeOut(SUN_ANGULAR_RADIUS * 0.8, SUN_ANGULAR_RADIUS, sunOffset);
    const limb = sqrt(saturate(float(1).sub(pow(sunOffset.div(SUN_ANGULAR_RADIUS), 2.0)))).mul(0.4).add(0.6);
    radiance.addAssign(sky.sunDiscColor.mul(disc.mul(limb).mul(smoothstep(-0.003, 0.004, up))));

    // Radial god rays: irregular shafts fanning out of the sun, slowly evolving, only in the sky. The
    // pattern is noise sampled on a circle around the sun (no angular seam); bright shafts lift the
    // sky and the gaps between them dim it slightly, like sunlight broken by distant clouds.
    If(sky.rayStrength.greaterThan(0.001), () => {
      const planar = vec2(dot(direction, sky.sunRight), dot(direction, sky.sunUp));
      const radial = planar.div(max(length(planar), 0.0001));
      const drift = time.mul(0.012);
      const coarse = valueNoise3(vec3(radial.mul(4.0), drift));
      const fine = valueNoise3(vec3(radial.mul(11.0), drift.mul(1.7).add(4.2)));
      const beams = smoothstep(-0.2, 0.5, coarse.mul(0.65).add(fine.mul(0.35)));
      const falloff = exp(sunOffset.mul(-2.4)).mul(smoothstep(0.025, 0.2, sunOffset));
      const skyMask = smoothstep(-0.004, 0.06, up).mul(fadeOut(0.16, 0.62, up));
      const shaft = beams.sub(0.42).mul(falloff).mul(skyMask);
      radiance.mulAssign(float(1).add(shaft.mul(sky.rayStrength)));
      radiance.addAssign(sky.glowColor.mul(max(shaft, 0.0).mul(sky.rayStrength).mul(0.3)));
    });

    // Moon: lit hemisphere shading from the real sun direction, soft maria, earthshine floor.
    const moonCover = float(0).toVar();
    const moonOffset = length(direction.sub(uniforms.moonDirection));
    If(sky.moonStrength.greaterThan(0.001).and(moonOffset.lessThan(MOON_ANGULAR_RADIUS * 1.05)), () => {
      const localX = dot(direction, sky.moonRight).div(MOON_ANGULAR_RADIUS);
      const localY = dot(direction, sky.moonUp).div(MOON_ANGULAR_RADIUS);
      const radiusSq = localX.mul(localX).add(localY.mul(localY));
      const facing = sqrt(saturate(float(1).sub(radiusSq)));
      const surfaceNormal = sky.moonRight.mul(localX).add(sky.moonUp.mul(localY)).sub(uniforms.moonDirection.mul(facing));
      const lit = max(saturate(dot(surfaceNormal, uniforms.sunDirection).mul(0.9).add(0.1)), 0.05);
      const maria = smoothstep(-0.35, 0.45, valueNoise3(vec3(localX.mul(2.3), localY.mul(2.3), 7.1)));
      const albedo = mix(0.58, 1.0, maria);
      const inside = fadeOut(MOON_ANGULAR_RADIUS * 0.9, MOON_ANGULAR_RADIUS, moonOffset).mul(smoothstep(-0.003, 0.004, up));
      moonCover.assign(inside);
      const moonColor = vec3(1.0, 0.97, 0.9).mul(1.35);
      radiance.addAssign(moonColor.mul(albedo.mul(lit).mul(inside).mul(sky.moonStrength)));
    });

    // Stars: one candidate per direction cell, twinkling, denser along a faint milky way band.
    If(sky.starStrength.greaterThan(0.001).and(up.greaterThan(-0.02)), () => {
      const starDirection = sky.starRotation.mul(direction);
      const cellPosition = starDirection.mul(STAR_CELL_SCALE);
      const cell = floor(cellPosition);
      const local = cellPosition.sub(cell);
      const jitter = hash33(cell);
      const pick = hash13(cell.add(vec3(17.13, 3.71, 29.97)));
      const bandDistance = dot(starDirection, vec3(GALAXY_NORMAL.x, GALAXY_NORMAL.y, GALAXY_NORMAL.z));
      const band = exp(bandDistance.mul(bandDistance).mul(-20.0));
      const present = step(mix(0.9, 0.8, band), pick);
      const brightness = pow(fract(pick.mul(37.77)), 6.0).mul(3.2).add(0.35);
      const size = mix(0.1, 0.2, fract(pick.mul(113.1)));
      const distanceToStar = length(local.sub(jitter.mul(0.6).add(0.2)));
      const core = pow(saturate(float(1).sub(distanceToStar.div(size))), 1.6);
      const twinkleDepth = mix(0.55, 0.2, saturate(up.mul(2.5)));
      const twinkle = sin(time.mul(jitter.x.mul(3.0).add(1.4)).add(jitter.y.mul(6.2832))).mul(twinkleDepth).add(float(1).sub(twinkleDepth));
      const tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.68), jitter.z);
      const horizonFade = smoothstep(0.0, 0.24, up).mul(float(1).sub(moonCover));
      const stars = tint.mul(core.mul(brightness).mul(twinkle).mul(present));
      const milkyNoise = valueNoise3(starDirection.mul(4.5)).mul(0.5).add(0.5);
      const milkyWay = vec3(0.05, 0.055, 0.085).mul(band.mul(milkyNoise.mul(milkyNoise)).mul(1.6));
      radiance.addAssign(stars.add(milkyWay).mul(horizonFade.mul(sky.starStrength)));
    });

    // Aurora curtains: layered filament noise projected on a sky plane, green lower edges fading to magenta.
    If(sky.auroraStrength.greaterThan(0.002).and(up.greaterThan(0.0)), () => {
      const accumulated = vec3(0).toVar();
      const average = vec3(0).toVar();
      const spinAngle = time.mul(0.06);
      const spinCos = cos(spinAngle).toVar();
      const spinSin = sin(spinAngle).toVar();
      const pixel = floor(screenCoordinate.xy);
      const dither = hash(pixel.x.add(pixel.y.mul(4099.0))).toVar();
      const perspective = up.mul(2.0).add(0.4);
      const planeDirection = direction.zx.mul(1.6).div(perspective).toVar();
      const layerStride = 49 / (AURORA_LAYERS - 1);
      // A real shader loop with a uniform bound: the compiler cannot unroll it, so the program links
      // with one layer body instead of AURORA_LAYERS inlined copies.
      Loop({ start: int(0), end: auroraLayerCount, type: 'int', condition: '<' }, ({ i }) => {
        const equivalent = float(i).mul(layerStride);
        const heightCurve = pow(equivalent, 1.4);
        const layerStep = pow(equivalent.add(layerStride), 1.4).sub(heightCurve).mul(0.002);
        const distanceAlong = heightCurve.mul(0.002).add(0.8).add(dither.mul(layerStep).mul(0.5));
        const density = auroraNoise(planeDirection.mul(distanceAlong), spinCos, spinSin);
        const hue = sin(vec3(1 - 2.15, 1 + 0.5, 1 - 1.2).add(equivalent.mul(0.043))).mul(0.5).add(0.5);
        average.assign(mix(average, hue.mul(density), 0.5));
        const weight = exp2(equivalent.mul(-0.052).sub(2.5)).mul(smoothstep(0.0, 5.0, equivalent.add(layerStride * 0.5))).mul(layerStride);
        accumulated.addAssign(average.mul(weight));
      });
      // The curtains hang along a slowly drifting east-west arc across the northern sky.
      const northReach = direction.z.negate().mul(float(1.05).div(perspective));
      const arcOffset = northReach.sub(sin(time.mul(0.013)).mul(0.25).add(1.15)).div(0.7);
      const arc = mix(0.1, 1.0, exp(arcOffset.mul(arcOffset).negate()));
      // Fade to nothing at the horizon line so the curtains never end in a hard edge over the haze.
      const horizonFade = smoothstep(0.0, 0.14, up);
      const curtains = smoothstep(0.05, 1.6, accumulated.mul(1.8));
      // The night grade drains saturation; push the curtains' chroma up first so they stay green/magenta.
      const curtainLuma = dot(curtains, vec3(0.2126, 0.7152, 0.0722));
      const vivid = max(mix(vec3(curtainLuma), curtains, 1.45), 0.0);
      radiance.addAssign(vivid.mul(horizonFade.mul(arc).mul(sky.auroraStrength).mul(0.72)));
    });

    return radiance;
  })();

  // ---- Dome ------------------------------------------------------------------------------------------
  const domeMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  domeMaterial.colorNode = skyDomeColor;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMaterial);
  dome.name = 'sky-dome';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  dome.castShadow = false;
  dome.receiveShadow = false;
  scene.add(dome);

  // ---- Fog: same sky function, horizontally weighted distance so the world edge always melts away ----
  const viewDirectionWorld = positionView.transformDirection(cameraViewMatrix);
  const worldOffset = viewDirectionWorld.mul(length(positionView));
  /**
   * The haze (0..1) of a point worldOffset metres from the camera (a world-oriented vec3 node). It
   * builds the nodes inline, so the scene fog and the effects that draw their own fog (the spawn
   * particles, whose vertex shaders place them) share one formula.
   */
  function fogAmount(offset) {
    const hazeDistance = length(vec3(offset.x, offset.y.mul(sky.fogVerticalScale), offset.z));
    // Low haze is densest near the ground under the glider: attenuate it by the view ray's mid height
    // so looking down from altitude stays clear. The edge term ignores height, so the world edge always
    // melts into the sky.
    const fragmentHeight = cameraPosition.y.add(offset.y);
    const rayMidHeight = cameraPosition.y.add(fragmentHeight).mul(0.5).sub(sky.fogLayerBase);
    const layerDensity = mix(float(FOG_HIGH_DENSITY), float(1), exp(max(rayMidHeight, 0.0).div(FOG_SCALE_HEIGHT).negate()));
    const layerHaze = smoothstep(sky.fogNear, sky.fogFar, hazeDistance);
    const edgeHaze = smoothstep(sky.fogFar.mul(FOG_EDGE_START), sky.fogFar, hazeDistance);
    return max(layerHaze.mul(layerHaze).mul(layerDensity), edgeHaze.mul(edgeHaze));
  }
  scene.fogNode = fog(skyBase(viewDirectionWorld), fogAmount(worldOffset));
  const backgroundColor = new THREE.Color();
  scene.background = backgroundColor;

  // ---- Lights ------------------------------------------------------------------------------------------
  const lightTarget = new THREE.Object3D();
  lightTarget.name = 'sky-light-target';
  scene.add(lightTarget);

  const sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
  sunLight.name = 'sun';
  sunLight.target = lightTarget;
  sunLight.castShadow = true;
  sunLight.shadow.radius = 3;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = LIGHT_DISTANCE + SHADOW_MIN_DOWN_SUN;
  sunLight.shadow.camera.left = -SHADOW_EXTENT;
  sunLight.shadow.camera.right = SHADOW_EXTENT;
  sunLight.shadow.camera.top = SHADOW_EXTENT;
  sunLight.shadow.camera.bottom = -SHADOW_EXTENT;
  sunLight.shadow.camera.updateProjectionMatrix();
  scene.add(sunLight);

  const moonLight = new THREE.DirectionalLight(0xb6c5ec, 0);
  moonLight.name = 'moon';
  moonLight.target = lightTarget;
  moonLight.castShadow = false;
  scene.add(moonLight);

  const hemisphereLight = new THREE.HemisphereLight(0xc4d8f0, 0x6f6450, 1);
  hemisphereLight.name = 'sky-fill';
  scene.add(hemisphereLight);

  function applyShadowQuality() {
    const size = ctx.quality.shadowMapSize || 2048;
    if (sunLight.shadow.mapSize.x !== size) sunLight.shadow.mapSize.set(size, size);
    const texel = (2 * SHADOW_EXTENT) / size;
    sunLight.shadow.bias = -SHADOW_BIAS_METERS / (sunLight.shadow.camera.far - sunLight.shadow.camera.near);
    sunLight.shadow.normalBias = texel * 1.4;
  }
  applyShadowQuality();

  // ---- Mutable state -------------------------------------------------------------------------------------
  let dayTime = wrapUnit(Number.isFinite(state.time.dayTime) ? state.time.dayTime : dayTimeForSunElevation(config.START_SUN_ELEVATION_DEG, true));
  const transition = { active: false, from: 0, delta: 0, elapsed: 0, duration: 0 };
  let lastLabel = '';
  let suppressLabelEvent = false;
  let smoothedSnow = state.player.biome?.weights?.[0] ?? 0;
  let smoothedHighPine = 0;
  const lastPlayerPosition = state.player.position.clone();
  let fogNearCurrent = -1;
  let fogFarCurrent = -1;
  let appliedFar = 0;
  let appliedExposure = -1;
  let shadowsLive = true;

  const scratch = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    anti: new THREE.Color(),
    ground: new THREE.Color(),
    lightColor: new THREE.Color(),
    lightDirection: new THREE.Vector3(),
    moonLightDirection: new THREE.Vector3(),
    focus: new THREE.Vector3(),
    worldUp: new THREE.Vector3(0, 1, 0),
    origin: new THREE.Vector3(0, 0, 0),
    lightRotation: new THREE.Matrix4(),
    lightRotationInverse: new THREE.Matrix4(),
    celestial: new THREE.Matrix4(),
    cameraForward: new THREE.Vector3(),
  };

  // ---- Sky modifiers ----------------------------------------------------------------------------------
  // A modifier holds target values and a weight (0..1). Each frame they are folded in priority order
  // (lowest first, so a higher priority lands on top): the multipliers (sunIntensity, ambient,
  // fogDensity) multiply, darkness and overcast combine like stacked filters, stars takes the
  // maximum, flash takes the maximum (with the colour of the strongest flash), and the two tint
  // colours composite over each other by their amounts. Every value is first eased from neutral by
  // its modifier's weight. The tints keep the luminance of the colour
  // they tint (a storm greys a golden sky without lighting up a night one); darkness does the
  // darkening. flash is the one brightening: a lightning strike ADDS its colour to the sky palette
  // (and so to the fog colour) and lifts the hemisphere light for an instant. A modifier at weight 0
  // or at neutral values changes nothing, and when nothing weighs in, no modifier code touches a
  // colour at all.
  const MODIFIER_NEUTRAL = Object.freeze({ sunIntensity: 1, ambient: 1, fogColorAmount: 0, fogDensity: 1, skyTintAmount: 0, darkness: 0, stars: 0, overcast: 0, flash: 0 });
  const MODIFIER_SCALAR_FIELDS = Object.keys(MODIFIER_NEUTRAL);
  const MODIFIER_LIMITS = Object.freeze({
    sunIntensity: [0, 4], ambient: [0, 4], fogColorAmount: [0, 1], fogDensity: [0.25, 8], skyTintAmount: [0, 1], darkness: [0, 1], stars: [0, 1], overcast: [0, 1],
    flash: [0, 1],
  });
  /** A full flash (1) adds this much of its colour to the sky palette (display-referred), per key. */
  const FLASH_SKY_GAIN = Object.freeze({ zenith: 0.35, horizon: 0.55, anti: 0.45, ground: 0.4 });
  /** A full flash multiplies the hemisphere light by 1 + this. */
  const FLASH_AMBIENT_GAIN = 3;
  const modifierList = [];
  const modifierIds = new Set();
  let modifierSerial = 0;
  const combined = {
    active: false,
    sunIntensity: 1, ambient: 1, fogDensity: 1, darkness: 0, stars: 0, overcast: 0,
    fogColor: new THREE.Color(), fogColorAmount: 0,
    skyTint: new THREE.Color(), skyTintAmount: 0,
    flash: 0, flashColor: new THREE.Color(),
  };
  const tintScratch = new THREE.Color();

  function luminance(color) {
    return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  }
  /** Mixes target toward tint by amount, the tint rescaled to target's luminance. */
  function applyTint(target, tint, amount) {
    const tintLuminance = luminance(tint);
    if (amount <= 0 || tintLuminance <= 1e-6) return target;
    tintScratch.copy(tint).multiplyScalar(luminance(target) / tintLuminance);
    return target.lerp(tintScratch, amount);
  }
  /** Tint and darkness of the combined modifiers on a display-referred sky colour. */
  function modifySkyColor(target) {
    applyTint(target, combined.skyTint, combined.skyTintAmount);
    return target.multiplyScalar(1 - combined.darkness);
  }
  /** Adds the combined flash's colour to a display-referred sky colour, scaled by gain. */
  function addFlash(target, gain) {
    const amount = combined.flash * gain;
    const color = combined.flashColor;
    target.setRGB(target.r + color.r * amount, target.g + color.g * amount, target.b + color.b * amount);
  }
  /** Over-composites a tint colour of amount onto the running (color, amount) of the combined record. */
  function compositeTint(colorKey, amountKey, color, amount) {
    if (amount <= 0) return;
    const below = combined[amountKey];
    const total = amount + below * (1 - amount);
    const keep = (below * (1 - amount)) / total;
    const add = amount / total;
    const target = combined[colorKey];
    target.setRGB(target.r * keep + color.r * add, target.g * keep + color.g * add, target.b * keep + color.b * add);
    combined[amountKey] = total;
  }

  function resolveModifiers() {
    combined.sunIntensity = 1;
    combined.ambient = 1;
    combined.fogDensity = 1;
    combined.darkness = 0;
    combined.stars = 0;
    combined.overcast = 0;
    combined.fogColorAmount = 0;
    combined.skyTintAmount = 0;
    combined.fogColor.setRGB(0, 0, 0);
    combined.skyTint.setRGB(0, 0, 0);
    combined.flash = 0;
    let active = false;
    for (let index = 0; index < modifierList.length; index++) {
      const modifier = modifierList[index];
      const weight = modifier.weight;
      if (!(weight > 0)) continue;
      const values = modifier.values;
      combined.sunIntensity *= 1 + (values.sunIntensity - 1) * weight;
      combined.ambient *= 1 + (values.ambient - 1) * weight;
      combined.fogDensity *= 1 + (values.fogDensity - 1) * weight;
      combined.darkness = 1 - (1 - combined.darkness) * (1 - values.darkness * weight);
      combined.overcast = 1 - (1 - combined.overcast) * (1 - values.overcast * weight);
      combined.stars = Math.max(combined.stars, values.stars * weight);
      if (values.flash * weight > combined.flash) {
        combined.flash = values.flash * weight;
        combined.flashColor.copy(modifier.flashColor);
      }
      compositeTint('fogColor', 'fogColorAmount', modifier.fogColor, values.fogColorAmount * weight);
      compositeTint('skyTint', 'skyTintAmount', modifier.skyTint, values.skyTintAmount * weight);
      active = true;
    }
    // Neutral values weigh nothing: the sky then keeps its untouched Phase 1 path.
    combined.active = active && (
      combined.sunIntensity !== 1 || combined.ambient !== 1 || combined.fogDensity !== 1 || combined.darkness !== 0
      || combined.stars !== 0 || combined.overcast !== 0 || combined.fogColorAmount !== 0 || combined.skyTintAmount !== 0
      || combined.flash !== 0
    );
  }

  function readColor(value, target, field, id) {
    if (value && typeof value === 'object' && Number.isFinite(value.r) && Number.isFinite(value.g) && Number.isFinite(value.b)) return target.copy(value);
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return target.setHex(value);
    throw new TypeError(`sky modifier "${id}": ${field} must be a THREE.Color or a 0xRRGGBB number`);
  }

  /**
   * Adds a sky modifier. Returns a handle: set(values) updates any of { sunIntensity, ambient,
   * fogColor, fogColorAmount, fogDensity, skyTint, skyTintAmount, darkness, stars, overcast, flash,
   * flashColor, weight }
   * (fields left out keep their value; colours are a THREE.Color or 0xRRGGBB), and remove() takes it
   * away. sunIntensity, ambient and fogDensity are multipliers (1 = unchanged); darkness dims the sky
   * and every light; overcast hides the sun disc, god rays, moon and stars behind cloud; stars raises
   * the star field (an eclipse); flash (0..1) adds flashColor (default a cold white) to the sky and
   * the ambient light for a lightning strike; weight (default 1) eases the whole modifier in and out.
   */
  function addModifier(id, { priority = 0 } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('sky.addModifier expects a string id');
    if (!Number.isFinite(priority)) throw new TypeError(`sky modifier "${id}": priority must be a finite number`);
    if (modifierIds.has(id)) throw new Error(`sky modifier "${id}" already exists`);
    const modifier = {
      id,
      priority,
      order: modifierSerial++,
      weight: 1,
      values: { ...MODIFIER_NEUTRAL },
      fogColor: new THREE.Color(1, 1, 1),
      skyTint: new THREE.Color(1, 1, 1),
      flashColor: new THREE.Color(0.82, 0.88, 1),
    };
    modifierIds.add(id);
    modifierList.push(modifier);
    modifierList.sort((first, second) => first.priority - second.priority || first.order - second.order);
    let removed = false;
    return {
      id,
      set(values) {
        if (removed) throw new Error(`sky modifier "${id}" was removed`);
        if (!values || typeof values !== 'object') throw new TypeError(`sky modifier "${id}": set() expects an object`);
        for (let index = 0; index < MODIFIER_SCALAR_FIELDS.length; index++) {
          const field = MODIFIER_SCALAR_FIELDS[index];
          const value = values[field];
          if (value === undefined) continue;
          if (!Number.isFinite(value)) throw new TypeError(`sky modifier "${id}": ${field} must be a finite number`);
          // Indexed reads, not destructuring: set() runs every frame for an easing modifier, and an
          // array pattern can allocate an iterator.
          const limits = MODIFIER_LIMITS[field];
          modifier.values[field] = clamp(value, limits[0], limits[1]);
        }
        if (values.weight !== undefined) {
          if (!Number.isFinite(values.weight)) throw new TypeError(`sky modifier "${id}": weight must be a finite number`);
          modifier.weight = clamp(values.weight, 0, 1);
        }
        if (values.fogColor !== undefined) readColor(values.fogColor, modifier.fogColor, 'fogColor', id);
        if (values.skyTint !== undefined) readColor(values.skyTint, modifier.skyTint, 'skyTint', id);
        if (values.flashColor !== undefined) readColor(values.flashColor, modifier.flashColor, 'flashColor', id);
        return this;
      },
      remove() {
        if (removed) return false;
        removed = true;
        modifierIds.delete(id);
        modifierList.splice(modifierList.indexOf(modifier), 1);
        return true;
      },
    };
  }

  // ---- Per-frame pieces ----------------------------------------------------------------------------------
  function advanceTime(dt, realDt) {
    if (transition.active) {
      transition.elapsed += realDt;
      const progress = Math.min(1, transition.elapsed / transition.duration);
      const eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      dayTime = wrapUnit(transition.from + transition.delta * eased);
      if (progress >= 1) {
        transition.active = false;
        suppressLabelEvent = true;
      }
      return;
    }
    if (!(dt > 0) || settings.get('timeFrozen')) return;
    const dayLength = clamp(Number(settings.get('dayLength')) || config.DAY_LENGTH_DEFAULT, 30, 7200);
    const rate = warpRate(elevationForDayTime(dayTime));
    dayTime = wrapUnit(dayTime + (dt * rate * WARP_NORMALISATION) / dayLength);
  }

  function updateCelestialState() {
    const time = state.time;
    time.dayTime = dayTime;
    sunDirectionForDayTime(dayTime, time.sunDirection);
    moonDirectionForDayTime(dayTime, time.moonDirection);
    const elevation = Math.asin(clamp(time.sunDirection.y, -1, 1)) / DEG;
    time.sunElevation = elevation;
    time.nightFactor = 1 - smoothRange(-11, 1, elevation);
    time.goldenFactor = smoothRange(-4, 0, elevation) * (1 - smoothRange(14, 25, elevation));
    time.label = labelFor(elevation, dayTime);
    uniforms.sunDirection.value.copy(time.sunDirection);
    uniforms.moonDirection.value.copy(time.moonDirection);
    uniforms.nightFactor.value = time.nightFactor;
    uniforms.goldenFactor.value = time.goldenFactor;
  }

  function setBasis(direction, rightUniform, upUniform) {
    const right = rightUniform.value.crossVectors(direction, scratch.worldUp);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    upUniform.value.crossVectors(right, direction).normalize();
  }

  function updateSkyColors(elevation) {
    const time = state.time;
    const altitudeDarkening = 1 - 0.18 * smoothRange(300, config.MAX_ALTITUDE, state.player.position.y);
    sampleColor(KEYS.zenith, elevation, scratch.zenith).multiplyScalar(altitudeDarkening);
    sampleColor(KEYS.horizon, elevation, scratch.horizon);
    sampleColor(KEYS.antiHorizon, elevation, scratch.anti);
    sampleColor(KEYS.groundHaze, elevation, scratch.ground);
    if (combined.active) {
      // The dome, the fog node and the fog colour all derive from these four, so tinting them here
      // tints the whole sky and the haze alike.
      modifySkyColor(scratch.zenith);
      modifySkyColor(scratch.horizon);
      modifySkyColor(scratch.anti);
      modifySkyColor(scratch.ground);
      if (combined.flash > 0) {
        addFlash(scratch.zenith, FLASH_SKY_GAIN.zenith);
        addFlash(scratch.horizon, FLASH_SKY_GAIN.horizon);
        addFlash(scratch.anti, FLASH_SKY_GAIN.anti);
        addFlash(scratch.ground, FLASH_SKY_GAIN.ground);
      }
    }
    uniforms.skyZenithColor.value.copy(scratch.zenith);
    uniforms.skyHorizonColor.value.copy(scratch.horizon);
    displayToRadiance(scratch.zenith, sky.zenith.value);
    displayToRadiance(scratch.horizon, sky.horizon.value);
    displayToRadiance(scratch.anti, sky.antiHorizon.value);
    displayToRadiance(scratch.ground, sky.groundHaze.value);
    sampleColor(KEYS.glow, elevation, sky.glowColor.value);
    sky.glowStrength.value = sampleScalar(KEYS.glowStrength, elevation);
    if (combined.active) sky.glowStrength.value *= Math.min(combined.sunIntensity, 1.3) * (1 - combined.overcast) * (1 - combined.darkness);
    // The tight aureole belongs to the visible disc; after sunset only the broad afterglow remains.
    sky.aureoleStrength.value = 1.1 * smoothRange(-2.5, 0.8, elevation);
    sky.horizonFalloff.value = sampleScalar(KEYS.horizonFalloff, elevation);

    // Fog colour for everyone else: the azimuth-averaged horizon leaning a little toward the ground haze.
    uniforms.fogColor.value.copy(scratch.horizon).lerp(scratch.anti, 0.45).lerp(scratch.ground, 0.25);
    if (combined.active) applyTint(uniforms.fogColor.value, combined.fogColor, combined.fogColorAmount);
    scene.fog.color.copy(uniforms.fogColor.value);
    backgroundColor.copy(uniforms.fogColor.value);

    const sunVisibility = smoothRange(-3.5, 0.5, elevation);
    sampleColor(KEYS.light, elevation, scratch.lightColor);
    const discIntensity = sampleScalar(KEYS.discIntensity, elevation);
    sky.sunDiscColor.value.copy(scratch.lightColor).multiplyScalar(discIntensity * sunVisibility);
    uniforms.sunColor.value.copy(scratch.lightColor).multiplyScalar(sunVisibility);
    sky.rayStrength.value = time.goldenFactor * sunVisibility * 0.38;
    setBasis(time.sunDirection, sky.sunRight, sky.sunUp);

    const moonAbove = smoothRange(-0.04, 0.06, time.moonDirection.y);
    sky.moonStrength.value = (0.12 + 0.88 * time.nightFactor) * moonAbove;
    setBasis(time.moonDirection, sky.moonRight, sky.moonUp);
    sky.starStrength.value = 1 - smoothRange(-13, -4, elevation);
    if (combined.active) {
      const clouded = 1 - combined.overcast;
      const lit = combined.sunIntensity * (1 - combined.darkness);
      // The disc fades faster than the light: even thin cloud hides its edge.
      sky.sunDiscColor.value.multiplyScalar(lit * clouded * clouded);
      uniforms.sunColor.value.multiplyScalar(lit);
      sky.rayStrength.value *= Math.min(combined.sunIntensity, 1.5) * clouded;
      sky.moonStrength.value *= clouded;
      sky.starStrength.value = Math.max(sky.starStrength.value * clouded, combined.stars);
    }

    scratch.celestial.makeRotationAxis(CELESTIAL_POLE, -dayTime * Math.PI * 2);
    sky.starRotation.value.setFromMatrix4(scratch.celestial);
  }

  function updateAurora(realDt) {
    const weights = state.player.biome?.weights;
    const snowWeight = weights ? clamp(weights[0] || 0, 0, 1) : 0;
    const pineWeight = weights ? clamp(weights[1] || 0, 0, 1) : 0;
    const highPine = pineWeight * smoothRange(500, 1400, state.player.position.y) * 0.3;
    const jumped = lastPlayerPosition.distanceToSquared(state.player.position) > 1500 * 1500;
    lastPlayerPosition.copy(state.player.position);
    // Teleports and world resets snap straight to the new place instead of fading for seconds.
    smoothedSnow = jumped ? snowWeight : damp(smoothedSnow, snowWeight, 0.5, realDt);
    smoothedHighPine = jumped ? highPine : damp(smoothedHighPine, highPine, 0.5, realDt);
    const presence = clamp(smoothRange(0.15, 0.75, smoothedSnow) + smoothedHighPine, 0, 1);
    const darkSky = 1 - smoothRange(-14, -7, state.time.sunElevation);
    sky.auroraStrength.value = darkSky * presence;
    if (combined.active) sky.auroraStrength.value *= 1 - combined.overcast;
    sky.auroraGlow.value.setRGB(0.004, 0.02, 0.013).multiplyScalar(sky.auroraStrength.value);
  }

  function updateFog(realDt) {
    const viewDistance = (ctx.quality.viewRings || 10) * config.CHUNK_SIZE;
    const elevation = state.time.sunElevation;
    const lowSun = smoothRange(-5, 0, elevation) * (1 - smoothRange(8, 17, elevation));
    const haze = Math.max(lowSun, state.time.nightFactor * 0.8);
    // Above the low haze layer the air clears up; the far edge stays put so the world edge never shows.
    const agl = Number.isFinite(state.player.agl) ? state.player.agl : 0;
    const clearAir = 0.1 * smoothRange(250, 1400, agl);
    const groundBelow = Math.max(Number.isFinite(state.player.groundHeight) ? state.player.groundHeight : 0, config.WATER_LEVEL);
    // High altitude: the fog's far edge follows the rim of the loaded terrain seen from above.
    const cameraHeight = Math.max(0, camera.position.y - groundBelow);
    const high = smoothRange(HIGH_ALTITUDE_START, HIGH_ALTITUDE_FULL, cameraHeight);
    const verticalScale = FOG_VERTICAL_SCALE + (HIGH_FOG_VERTICAL_SCALE - FOG_VERTICAL_SCALE) * high;
    sky.fogVerticalScale.value = verticalScale;
    let targetFar = high > 0 ? Math.hypot(viewDistance * 0.95, verticalScale * cameraHeight * high) : viewDistance * 0.95;
    let targetNear = Math.min(Math.max(FOG_NEAR_FLOOR, viewDistance * (0.3 - 0.15 * haze + clearAir)), targetFar * 0.8);
    if (combined.active && combined.fogDensity !== 1) {
      // Denser air closes the haze in: the near edge moves with the density, the far edge half as much.
      targetFar /= 1 + (combined.fogDensity - 1) * FOG_DENSITY_FAR_SHARE;
      targetNear = Math.min(targetNear / combined.fogDensity, targetFar * 0.8);
    }
    sky.fogLayerBase.value = sky.fogLayerBase.value === 0 ? groundBelow : damp(sky.fogLayerBase.value, groundBelow, 0.6, realDt);
    if (fogFarCurrent < 0) {
      fogFarCurrent = targetFar;
      fogNearCurrent = targetNear;
    } else {
      fogFarCurrent = damp(fogFarCurrent, targetFar, 1.2, realDt);
      fogNearCurrent = damp(fogNearCurrent, targetNear, 1.2, realDt);
    }
    sky.fogNear.value = fogNearCurrent;
    sky.fogFar.value = fogFarCurrent;
    scene.fog.near = fogNearCurrent;
    scene.fog.far = fogFarCurrent;
    // The far plane reaches the ground below and the terrain's rim from high up (100 m steps).
    const desiredFar = high > 0 ? Math.ceil((viewDistance + CAMERA_FAR_MARGIN + cameraHeight * high) / FAR_STEP) * FAR_STEP : Math.round(viewDistance + CAMERA_FAR_MARGIN);
    if (desiredFar !== appliedFar) {
      appliedFar = desiredFar;
      camera.far = desiredFar;
      camera.updateProjectionMatrix();
    }
  }

  function updateGrade(elevation) {
    const exposure = sampleScalar(KEYS.exposure, elevation);
    if (Math.abs(exposure - appliedExposure) > 0.0005) {
      appliedExposure = exposure;
      renderer.toneMappingExposure = exposure;
    }
    const controls = ctx.post?.controls;
    if (!controls) return;
    if (controls.warmth) controls.warmth.value = sampleScalar(KEYS.warmth, elevation);
    if (controls.saturation) controls.saturation.value = sampleScalar(KEYS.saturation, elevation);
  }

  function updateLights(elevation) {
    const time = state.time;
    const sunVisibility = smoothRange(-4, 0.5, elevation);
    sampleColor(KEYS.light, elevation, sunLight.color);
    sunLight.intensity = sampleScalar(KEYS.sunIntensity, elevation) * sunVisibility;
    const liveShadows = elevation > -4.5;
    if (liveShadows !== shadowsLive) {
      shadowsLive = liveShadows;
      sunLight.shadow.autoUpdate = liveShadows;
      if (liveShadows) sunLight.shadow.needsUpdate = true;
    }

    const moonAbove = smoothRange(0.0, 0.25, time.moonDirection.y);
    moonLight.intensity = sampleScalar(KEYS.moonIntensity, elevation) * moonAbove;

    sampleColor(KEYS.hemisphereSky, elevation, hemisphereLight.color).lerp(AURORA_FILL, 0.16 * sky.auroraStrength.value);
    sampleColor(KEYS.hemisphereGround, elevation, hemisphereLight.groundColor);
    hemisphereLight.intensity = sampleScalar(KEYS.hemisphereIntensity, elevation);
    if (combined.active) {
      const dim = 1 - combined.darkness;
      sunLight.intensity *= combined.sunIntensity * dim;
      moonLight.intensity *= (1 - combined.overcast) * dim;
      hemisphereLight.intensity *= combined.ambient * dim * (1 + combined.flash * FLASH_AMBIENT_GAIN);
    }
  }

  /** Light direction never drops below a grazing angle: the last light rakes the peaks instead of the underside. */
  function clampedLightDirection(source, target) {
    target.copy(source);
    const minY = Math.sin(MIN_LIGHT_ELEVATION);
    if (target.y < minY) {
      const horizontal = Math.hypot(target.x, target.z) || 1;
      const scale = Math.cos(MIN_LIGHT_ELEVATION) / horizontal;
      target.set(target.x * scale, minY, target.z * scale);
    }
    return target.normalize();
  }

  /** Shadow focus: a little ahead of the glider, pulled down toward the ground it flies over. */
  function shadowFocus(target) {
    const player = state.player;
    if (state.photoMode) {
      // The free camera may roam away from the glider: keep shadows where the photographer looks.
      const forward = camera.getWorldDirection(scratch.cameraForward);
      const ground = Math.max(ctx.world.groundHeight(camera.position.x, camera.position.z), config.WATER_LEVEL);
      const height = Math.max(0, camera.position.y - ground);
      return target.set(camera.position.x + forward.x * 90, camera.position.y - Math.min(height, 420) * 0.72, camera.position.z + forward.z * 90);
    }
    const forwardLength = Math.hypot(player.forward.x, player.forward.z) || 1;
    const agl = Number.isFinite(player.agl) ? Math.max(0, player.agl) : 0;
    return target.set(
      player.position.x + (player.forward.x / forwardLength) * 70,
      player.position.y - Math.min(agl, 420) * 0.72,
      player.position.z + (player.forward.z / forwardLength) * 70,
    );
  }

  function updateLightFrame() {
    const lightDirection = clampedLightDirection(state.time.sunDirection, scratch.lightDirection);
    const focus = shadowFocus(scratch.focus);
    // Snap the focus to whole shadow texels in light space so the shadow map never shimmers.
    scratch.lightRotation.lookAt(lightDirection, scratch.origin, scratch.worldUp);
    scratch.lightRotationInverse.copy(scratch.lightRotation).transpose();
    focus.applyMatrix4(scratch.lightRotationInverse);
    const texel = (2 * SHADOW_EXTENT) / sunLight.shadow.mapSize.x;
    focus.x = Math.round(focus.x / texel) * texel;
    focus.y = Math.round(focus.y / texel) * texel;
    focus.applyMatrix4(scratch.lightRotation);
    lightTarget.position.copy(focus);
    sunLight.position.copy(focus).addScaledVector(lightDirection, LIGHT_DISTANCE);
    updateShadowDepth(lightDirection, focus);
    const moonDirection = scratch.moonLightDirection.copy(state.time.moonDirection);
    if (moonDirection.y < 0.05) moonDirection.y = 0.05;
    moonDirection.normalize();
    moonLight.position.copy(focus).addScaledVector(moonDirection, LIGHT_DISTANCE);
  }

  /**
   * Shadow box depth: the up-sun reach is fixed (tall casters), the down-sun reach only extends as far
   * as the ground below the focus needs at the current sun angle, instead of a fixed 3 km slab.
   */
  function updateShadowDepth(lightDirection, focus) {
    const shadowCamera = sunLight.shadow.camera;
    const sinElevation = Math.max(lightDirection.y, 0.08);
    const ground = Math.max(ctx.world.groundHeight(focus.x, focus.z), config.WATER_LEVEL);
    const drop = Math.max(0, focus.y - ground) + SHADOW_CASTER_HEIGHT;
    const downSun = clamp(drop / sinElevation, SHADOW_MIN_DOWN_SUN, SHADOW_MAX_REACH);
    const far = Math.round(LIGHT_DISTANCE + downSun);
    if (Math.abs(far - shadowCamera.far) < 12) return;
    shadowCamera.far = far;
    shadowCamera.updateProjectionMatrix();
    sunLight.shadow.bias = -SHADOW_BIAS_METERS / (far - shadowCamera.near);
  }

  function updateDome() {
    dome.position.copy(camera.position);
    dome.scale.setScalar(camera.far * DOME_RADIUS_FRACTION);
  }

  function emitLabelChange() {
    const label = state.time.label;
    if (label === lastLabel) return;
    const previous = lastLabel;
    lastLabel = label;
    if (previous === '' || transition.active || suppressLabelEvent) return;
    bus.emit('time:changed', { dayTime, label, preset: null, reason: 'cycle' });
  }

  function refresh(realDt) {
    resolveModifiers();
    updateCelestialState();
    const elevation = state.time.sunElevation;
    updateSkyColors(elevation);
    updateAurora(realDt);
    updateFog(realDt);
    updateGrade(elevation);
    updateLights(elevation);
    updateLightFrame();
    updateDome();
  }

  bus.on('quality:changed', () => applyShadowQuality());

  refresh(0);
  lastLabel = state.time.label;

  // ---- Public API --------------------------------------------------------------------------------------------
  function setDayTime(value, options = {}) {
    const requested = Number(value);
    if (!Number.isFinite(requested)) return false;
    const target = wrapUnit(requested);
    const rawDuration = options && options.transition !== undefined ? Number(options.transition) : DEFAULT_TRANSITION_SECONDS;
    const duration = Number.isFinite(rawDuration) ? clamp(rawDuration, 0, 30) : DEFAULT_TRANSITION_SECONDS;
    const delta = wrapUnit(target - dayTime);
    if (duration <= 0 || delta < 1e-5 || delta > 1 - 1e-5) {
      transition.active = false;
      dayTime = target;
      refresh(0);
    } else {
      transition.active = true;
      transition.from = dayTime;
      transition.delta = delta;
      transition.elapsed = 0;
      transition.duration = duration;
    }
    const label = labelFor(elevationForDayTime(target), target);
    lastLabel = transition.active ? lastLabel : label;
    bus.emit('time:changed', { dayTime: target, label, preset: options?.preset ?? null, reason: 'request', transition: transition.active ? duration : 0 });
    return true;
  }

  return {
    sunLight,
    moonLight,
    hemisphereLight,
    dome,
    update(dt, realDt) {
      advanceTime(dt, realDt);
      refresh(realDt);
      emitLabelChange();
      suppressLabelEvent = false;
    },
    setDayTime,
    setPreset(name) {
      const key = resolvePreset(name);
      if (!key) return false;
      return setDayTime(PRESETS[key], { transition: DEFAULT_TRANSITION_SECONDS, preset: key });
    },
    getPresets() {
      return Object.keys(PRESETS);
    },
    getDayTime() {
      return dayTime;
    },
    getTimeLabel() {
      return state.time.label;
    },
    getClockString() {
      const minutes = Math.floor(wrapUnit(dayTime) * 1440) % 1440;
      const hours = Math.floor(minutes / 60);
      return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    },
    getSunElevation() {
      return state.time.sunElevation;
    },
    setDayLength(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value <= 0) return false;
      return settings.set('dayLength', Math.round(clamp(value, 30, 7200)));
    },
    isTransitioning() {
      return transition.active;
    },
    /** TSL node: base sky radiance for a unit world direction node (the same colour the fog uses). */
    skyColorNode(directionNode) {
      return skyBase(directionNode);
    },
    /**
     * TSL node: the scene fog's haze (0..1) for a point offsetNode metres from the camera (a world
     * vec3), for effects that apply their own fog. Mix toward skyColorNode of its direction.
     */
    fogAmountNode(offsetNode) {
      return fogAmount(offsetNode);
    },
    addModifier,
    /** The modifiers folded together as of the last frame, for the debugger and tests (a copy). */
    getModifierState() {
      return {
        active: combined.active,
        count: modifierList.length,
        ids: modifierList.map((modifier) => modifier.id),
        sunIntensity: combined.sunIntensity,
        ambient: combined.ambient,
        fogDensity: combined.fogDensity,
        darkness: combined.darkness,
        overcast: combined.overcast,
        stars: combined.stars,
        fogColor: `#${combined.fogColor.getHexString()}`,
        fogColorAmount: combined.fogColorAmount,
        skyTint: `#${combined.skyTint.getHexString()}`,
        skyTintAmount: combined.skyTintAmount,
        flash: combined.flash,
        flashColor: `#${combined.flashColor.getHexString()}`,
      };
    },
  };
}
