import { MathUtils } from '../core/util.js';

/**
 * CLOUD SHADING: the parts of the v1 cumulus look that every cloud in the game shares. The v1 cloud
 * field (clouds.js) and the weather volumes (spawns/engines/weatherVolumeEngine.js) both draw
 * instanced icosahedron puffs with this geometry, this palette and this light response, so a storm
 * tower, a fog bank or a lens cloud sits in the same sky as the drifting cumulus.
 *
 * - buildCloudPuffGeometry: the flat-shaded icosahedron puff (detail 1) with a gentle deterministic
 *   radial jitter.
 * - createCloudLook: the CPU-side palette (sunlit tops, shadow sides, bounce, moonlight, rim), keyed
 *   by the sun elevation, as TSL uniforms. update() also answers the sky modifiers: a storm's
 *   overcast turns the undersides a darker blue-grey and dims the sunlit tops, an eclipse's darkness
 *   dims everything. With no modifier weighing in, update() takes exactly the v1 path.
 * - createCloudRadiance: the stylised light response of one puff (soft normals from a cluster-wide
 *   ellipsoid, wrapped sun, crevices, base occlusion, silver linings, limb darkening), plus the cloud
 *   optics the celestial engine drives through the shared uniforms cloudGlory and cloudBow: the glory
 *   (coloured rings around the craft's own shadow) and the full-circle rainbow, both centred on the
 *   antisolar point. Weather volumes add a per-puff storm shade, an albedo tint and a glow.
 *
 * Instanced inputs of the radiance: shape (x flat-bottom height in puff space, y group base world y,
 * z group top world y, w brightness) and centre (xyz group shading centre relative to the mesh
 * anchor, w haze), exactly as the v1 field writes them.
 */

/** Shading shape: how much the cluster-wide ellipsoid normal softens the facets, and its flattening. */
export const SOFT_NORMAL_WEIGHT = 0.62;
export const CLUSTER_NORMAL_LIFT = 2.4;
export const BASE_OCCLUSION = 0.58;
/** Lower half of every puff sits in the crevices between its neighbours: sunlight reaches it less. */
export const CREVICE_OCCLUSION = 0.52;
export const LIT_GAIN = 1.2;
export const PUFF_JITTER = 0.07;
/** Surfaces this close to the camera (m) dissolve with a screen-space dither. */
export const NEAR_DISSOLVE_START = 16;
export const NEAR_DISSOLVE_END = 70;

/** Storm response of the palette (overcast 1): how much the undersides turn to the storm shade. */
const STORM_SHADE_SHARE = 0.85;
const STORM_SHADE_SCALE = 0.36;
/** Per-channel shift of the storm shade toward blue-grey. */
const STORM_TINT = Object.freeze([0.8, 0.92, 1.12]);
/** How much of the sun's dimming (sunIntensity, darkness) reaches the sunlit tops. */
const SUN_DIM_SHARE = 0.85;
/** Per-puff storm: share of the sunlit term it takes away. */
const STORM_LIT_LOSS = 0.62;

/** Glory and rainbow geometry (degrees from the antisolar point). */
const GLORY_CORE_DEGREES = 1.1;
const GLORY_REACH_DEGREES = 7.5;
const GLORY_PERIODS = Object.freeze([2.45, 2.1, 1.8]);
const BOW_PRIMARY = Object.freeze([42.2, 41.4, 40.6]);
const BOW_SECONDARY = Object.freeze([50.4, 51.5, 52.7]);
const BOW_WIDTH = 0.75;
const BOW_SECONDARY_WIDTH = 1.05;
/** Radius (m) of the soft shadow the craft casts at the centre of the glory. */
const CRAFT_SHADOW_RADIUS = 7;

/**
 * Icosahedron puff (radius 1, detail 1) with a gentle deterministic radial jitter; shared positions
 * move together, so the facets stay closed. hash2(x, z, salt) is the world's hash.
 */
export function buildCloudPuffGeometry(THREE, hash2) {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const positions = geometry.getAttribute('position');
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const hashValue = hash2(Math.round(x * 1000 + z * 37), Math.round(y * 1000), 470);
    const scale = 1 + PUFF_JITTER * (hashValue * 2 - 1);
    positions.setXYZ(index, x * scale, y * scale, z * scale);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The cloud palette as TSL uniforms (linear scene radiance), keyed by the sun elevation:
 * litColor, shadeColor, bounceColor, moonColor, rimColor, silverStrength and stormShadeColor.
 * update(state, uniforms, levels) recomputes them; levels is the sky's folded modifier record
 * (sky.getModifierLevels()) or null.
 */
export function createCloudLook(THREE, TSL) {
  const { uniform } = TSL;
  const look = {
    litColor: uniform(new THREE.Color(1, 1, 1)),
    shadeColor: uniform(new THREE.Color(0.3, 0.33, 0.42)),
    bounceColor: uniform(new THREE.Color(0, 0, 0)),
    moonColor: uniform(new THREE.Color(0, 0, 0)),
    rimColor: uniform(new THREE.Color(0, 0, 0)),
    silverStrength: uniform(1),
    stormShadeColor: uniform(new THREE.Color(0.1, 0.11, 0.14)),
  };

  function paletteKeys(entries) {
    return entries.map(([elevation, red, green, blue]) => ({ elevation, color: new THREE.Color().setRGB(red, green, blue) }));
  }
  // Shadow sides: cool blue-grey by day, lavender-slate at twilight, dim navy under the moon.
  const SHADE_KEYS = paletteKeys([
    [-18, 0.02, 0.024, 0.042],
    [-9, 0.03, 0.034, 0.058],
    [-3, 0.075, 0.07, 0.11],
    [2, 0.14, 0.14, 0.19],
    [8, 0.18, 0.2, 0.27],
    [18, 0.29, 0.33, 0.41],
    [35, 0.42, 0.47, 0.56],
  ]);
  const WHITE = new THREE.Color(1, 1, 1);
  const MOONLIGHT = new THREE.Color(0.05, 0.06, 0.085);
  const scratch = { warm: new THREE.Color(), color: new THREE.Color() };

  function samplePalette(keys, elevation, target) {
    if (elevation <= keys[0].elevation) return target.copy(keys[0].color);
    for (let index = 1; index < keys.length; index++) {
      const upper = keys[index];
      if (elevation <= upper.elevation) {
        const lower = keys[index - 1];
        const t = MathUtils.smoothstep(elevation, lower.elevation, upper.elevation);
        return target.copy(lower.color).lerp(upper.color, t);
      }
    }
    return target.copy(keys[keys.length - 1].color);
  }

  /** The storm shade: the day's shadow colour, darker and bluer-grey (per-puff storms mix toward it). */
  function updateStormShade() {
    const shade = look.shadeColor.value;
    look.stormShadeColor.value.setRGB(
      shade.r * STORM_SHADE_SCALE * STORM_TINT[0],
      shade.g * STORM_SHADE_SCALE * STORM_TINT[1],
      shade.b * STORM_SHADE_SCALE * STORM_TINT[2],
    );
  }

  /**
   * The sky modifiers on the palette: overcast mixes the undersides toward the storm shade and takes
   * the silver linings and the bounce away, the sun's dimming (sunIntensity, darkness) reaches the
   * sunlit tops, and ambient and darkness scale the shadow sides.
   */
  function applyModifiers(levels) {
    const overcast = levels.overcast;
    const dim = 1 - levels.darkness;
    const sunFactor = Math.min(Math.max(levels.sunIntensity, 0), 1.2) * dim;
    look.litColor.value.multiplyScalar(1 + (sunFactor - 1) * SUN_DIM_SHARE);
    look.shadeColor.value.lerp(look.stormShadeColor.value, STORM_SHADE_SHARE * overcast).multiplyScalar(Math.min(levels.ambient, 1.5) * dim);
    look.bounceColor.value.multiplyScalar((1 - overcast) * dim);
    look.rimColor.value.multiplyScalar((1 - 0.75 * overcast) * dim);
    look.moonColor.value.multiplyScalar((1 - overcast) * dim);
    look.silverStrength.value *= 1 - 0.6 * overcast;
  }

  look.update = function update(state, uniforms, levels) {
    const time = state.time;
    const elevation = time.sunElevation;
    const sunVisibility = MathUtils.smoothstep(time.sunDirection.y, -0.03, 0.05);
    const dayness = MathUtils.smoothstep(elevation, 10, 32);
    const sunColor = uniforms.sunColor.value;
    const peak = Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4);
    // Sunlit tops: golden-white at golden hour, clean white by day.
    scratch.warm.setRGB(sunColor.r / peak, sunColor.g / peak, sunColor.b / peak);
    look.litColor.value.copy(scratch.warm).lerp(WHITE, 0.4 + 0.45 * dayness).multiplyScalar((LIT_GAIN - 0.18 * dayness) * sunVisibility);
    samplePalette(SHADE_KEYS, elevation, look.shadeColor.value);
    // A little of the sky's own tint in the shadow sides keeps them coherent with the dome.
    look.shadeColor.value.lerp(scratch.color.copy(uniforms.skyZenithColor.value).multiplyScalar(0.9), 0.12);
    // Warm light bounced up from the lit landscape under the flat bases.
    look.bounceColor.value.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.07 * (1 - time.nightFactor));
    // Afterglow: around sunset and sunrise the undersides take the pink horizon light instead of
    // turning slate grey, so twilight clouds read as lit cumulus rather than storm blobs.
    const afterglow = MathUtils.smoothstep(elevation, -7, -2) * (1 - MathUtils.smoothstep(elevation, 2, 6));
    if (afterglow > 0) {
      look.shadeColor.value.lerp(scratch.color.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.42), 0.5 * afterglow);
      look.bounceColor.value.add(scratch.color.copy(uniforms.skyHorizonColor.value).multiplyScalar(0.1 * afterglow));
    }
    const moonAbove = MathUtils.smoothstep(time.moonDirection.y, 0, 0.12);
    look.moonColor.value.copy(MOONLIGHT).multiplyScalar(time.nightFactor * moonAbove);
    look.rimColor.value.copy(sunColor).multiplyScalar(0.3 + 0.85 * time.goldenFactor);
    look.silverStrength.value = 1.1 + 0.9 * time.goldenFactor;
    updateStormShade();
    // No modifier weighing in: the palette is exactly v1's.
    if (levels && levels.active) applyModifiers(levels);
  };

  return look;
}

/** Degrees (TSL float) between a unit view ray and the point opposite a light direction. */
export function antisolarDegrees(TSL, viewRay, lightDirection) {
  const { dot, acos, clamp } = TSL;
  return acos(clamp(dot(viewRay, lightDirection.negate()), -1, 1)).mul(180 / Math.PI);
}

/**
 * The glory's light at degrees from the antisolar point (TSL vec3): a bright bluish core and coloured
 * rings (red outermost), fading out by about 7 degrees.
 */
export function gloryLightNode(TSL, degrees) {
  const { vec3, exp, cos, pow, smoothstep, oneMinus } = TSL;
  const envelope = exp(degrees.div(-2.8)).mul(oneMinus(smoothstep(GLORY_REACH_DEGREES * 0.6, GLORY_REACH_DEGREES, degrees)));
  const ring = (period) => pow(cos(degrees.mul((2 * Math.PI) / period)).mul(0.5).add(0.5), 3);
  const rings = vec3(ring(GLORY_PERIODS[0]), ring(GLORY_PERIODS[1]), ring(GLORY_PERIODS[2])).mul(envelope).mul(0.85);
  const scaled = degrees.div(GLORY_CORE_DEGREES);
  const core = exp(scaled.mul(scaled).negate());
  return rings.add(vec3(0.85, 0.93, 1.0).mul(core.mul(1.3)));
}

/**
 * The rainbow's light at degrees from the antisolar point (TSL vec3): the primary bow (red outside,
 * violet inside), the brighter sky inside it and, scaled by secondary, the fainter secondary bow with
 * its colours reversed.
 */
export function bowLightNode(TSL, degrees, secondary = 0.3) {
  const { vec3, exp, smoothstep, oneMinus } = TSL;
  const band = (centre, width) => {
    const scaled = degrees.sub(centre).div(width);
    return exp(scaled.mul(scaled).negate());
  };
  const primary = vec3(band(BOW_PRIMARY[0], BOW_WIDTH), band(BOW_PRIMARY[1], BOW_WIDTH), band(BOW_PRIMARY[2], BOW_WIDTH));
  const outer = vec3(band(BOW_SECONDARY[0], BOW_SECONDARY_WIDTH), band(BOW_SECONDARY[1], BOW_SECONDARY_WIDTH), band(BOW_SECONDARY[2], BOW_SECONDARY_WIDTH));
  const inside = oneMinus(smoothstep(24, 40.5, degrees)).mul(smoothstep(8, 20, degrees)).mul(0.1);
  return primary.mul(0.9).add(outer.mul(secondary)).add(vec3(inside));
}

/**
 * The glory and the full-circle rainbow around the antisolar point (TSL), as light added to a cloud
 * surface, plus the soft shadow of the craft at the centre. Returns { light, shadow }: radiance is
 * radiance * shadow + light. With glory and bow at 0, light is 0 and shadow is 1.
 */
function createCloudOptics(TSL, { viewRay, sunDirection, glory, bow, lit, sunKey, cameraDistance }) {
  const { float, smoothstep, saturate, max, oneMinus } = TSL;
  const degrees = antisolarDegrees(TSL, viewRay, sunDirection);
  const light = gloryLightNode(TSL, degrees).mul(glory).add(bowLightNode(TSL, degrees).mul(bow)).mul(lit).mul(sunKey.mul(0.45).add(0.55));
  // The craft's shadow: a soft dark spot whose angular size shrinks with the distance to the cloud.
  const shadowDegrees = float(CRAFT_SHADOW_RADIUS * (180 / Math.PI)).div(max(cameraDistance, 1));
  const spot = oneMinus(smoothstep(shadowDegrees.mul(0.5), shadowDegrees.mul(1.6), degrees));
  const shadow = oneMinus(spot.mul(saturate(glory)).mul(0.55));
  return { light, shadow };
}

/**
 * The light response of a cloud puff (TSL). inputs: look (createCloudLook), uniforms (the shared ones:
 * sunDirection, moonDirection, cloudGlory, cloudBow), shape and centre (instanced nodes, see the
 * header), anchor (uniform Vector3: the mesh anchor), and for weather volumes optional storm (0..1),
 * tint (albedo multiplier, vec3) and glow (added light, vec3) nodes. Returns { radiance, viewRay,
 * cameraDistance }.
 */
export function createCloudRadiance(TSL, { look, uniforms, shape, centre, anchor, storm = null, tint = null, glow = null }) {
  const {
    float, vec3, positionGeometry, positionView, positionWorld, normalWorld, cameraViewMatrix,
    mix, smoothstep, saturate, pow, max, dot, normalize, length, oneMinus,
  } = TSL;
  const shadeColor = storm ? mix(look.shadeColor, look.stormShadeColor, storm) : look.shadeColor;
  const litColor = storm ? look.litColor.mul(oneMinus(storm.mul(STORM_LIT_LOSS))) : look.litColor;
  const bounceColor = storm ? look.bounceColor.mul(oneMinus(storm)) : look.bounceColor;
  const rimColor = storm ? look.rimColor.mul(oneMinus(storm.mul(0.7))) : look.rimColor;
  const { moonColor, silverStrength } = look;

  const heightFraction = saturate(positionWorld.y.sub(shape.y).div(max(shape.z.sub(shape.y), 1)));
  const fromCentre = positionWorld.sub(anchor).sub(centre.xyz);
  const clusterNormal = normalize(fromCentre.mul(vec3(1, CLUSTER_NORMAL_LIFT, 1)));
  const shadingNormal = normalize(mix(normalWorld, clusterNormal, SOFT_NORMAL_WEIGHT));
  const viewRay = positionView.transformDirection(cameraViewMatrix);
  const facing = saturate(dot(shadingNormal, viewRay.negate()));
  const rim = pow(oneMinus(facing), 3);
  const sunDot = dot(shadingNormal, uniforms.sunDirection);
  const sunKey = pow(saturate(sunDot.mul(0.62).add(0.38)), 1.6);
  const moonKey = saturate(dot(shadingNormal, uniforms.moonDirection).mul(0.55).add(0.45));
  const occlusion = mix(float(BASE_OCCLUSION), float(1), smoothstep(0, 0.65, heightFraction));
  const underside = saturate(shadingNormal.y.negate());
  // Brightness variation stays off the shared flat base, where overlapping puffs are coplanar.
  const brightness = mix(float(1), shape.w, smoothstep(0, 0.12, heightFraction));
  // Crevices: the puff-local height (raw geometry, before the base clamp) shades each puff's lower
  // half, so every heap reads as its own rounded bump. Kept off the shared flat base (coplanar puffs).
  const crevice = mix(float(1), mix(float(CREVICE_OCCLUSION), float(1), smoothstep(-0.55, 0.7, positionGeometry.y)), smoothstep(0, 0.15, heightFraction));
  const towardSun = saturate(dot(viewRay, uniforms.sunDirection));
  const backLight = pow(towardSun, 3).mul(0.45).add(pow(towardSun, 16).mul(0.9));
  const towardMoon = saturate(dot(viewRay, uniforms.moonDirection));
  const bodyLight = shadeColor.mul(occlusion).mul(mix(float(0.85), float(1), crevice))
    .add(litColor.mul(sunKey).mul(mix(occlusion, float(1), 0.35)).mul(crevice))
    .add(moonColor.mul(moonKey).mul(occlusion).mul(crevice))
    .add(bounceColor.mul(underside))
    // Light scattered forward through the cloud body when looking toward the sun.
    .add(rimColor.mul(pow(towardSun, 4).mul(0.16)));
  const rimLight = rimColor.mul(rim.mul(saturate(sunDot.mul(0.7).add(0.35))))
    .add(rimColor.mul(backLight.mul(rim.mul(0.8).add(0.2)).mul(silverStrength)))
    .add(moonColor.mul(rim.mul(moonKey.add(pow(towardMoon, 4).mul(1.6))).mul(1.4)));
  // Limb darkening on each puff's own facets outlines the heaps even when the sun is behind the viewer.
  const limb = mix(float(0.84), float(1), smoothstep(0, 0.45, saturate(dot(normalWorld, viewRay.negate()))));
  const albedoLight = tint ? bodyLight.mul(tint) : bodyLight;
  const cameraDistance = length(positionView);
  const optics = createCloudOptics(TSL, {
    viewRay, sunDirection: uniforms.sunDirection, glory: uniforms.cloudGlory, bow: uniforms.cloudBow, lit: litColor, sunKey, cameraDistance,
  });
  let radiance = albedoLight.mul(brightness).mul(limb).add(rimLight).mul(optics.shadow).add(optics.light);
  if (glow) radiance = radiance.add(glow);
  return { radiance, viewRay, cameraDistance };
}
