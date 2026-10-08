// The shared water material (contract section c.4): the v1-derived ocean shader, moved out of
// water.js unchanged for kind 'ocean', and its local-water variants for lakes ('lake') and frozen
// lakes ('ice').
//
// - Ocean: Gerstner swell displaced in wrapped world space on the camera-following grid, per-pixel
//   detail normals, Fresnel sky reflection (the sky dome's own radiance), an HDR sun glint whose lobe
//   widens with distance, a moon glint, back-lit crest glow, cloud shadows and the local effects
//   layer (waterEffects.js). See water.js for the grid.
// - Lake: the same wave table and the same sky, glint and cloud-shadow shading on a flat surface,
//   with the waves scaled down (per body), shoreline foam from the basin depth baked into the mesh,
//   the craft's foam trail from the effects layer's trail buffer, an optional body tint and the
//   salt-flat sky mirror. The mesh carries its outline: fragments outside the basin are discarded.
// - Ice: an opaque frozen surface: pressure ridges and cracks from noise, white rime, a dull
//   specular (roughness), on the same clipped meshes.
// Lake and ice materials are shared by every body: per-body values (tint, wave scale, glint, foam,
// mirror) are per-object uniforms read from mesh.userData.water, so a new body never compiles a new
// pipeline. Both backends (WebGPU, WebGL2) build the same node graphs.
//
// World positions: every absolute world-space read goes through worldXZ(), so the render origin's
// offset (a floating origin) is added in one place.

/** Shading constants of the ocean (Phase 1 / 2 values). */
const OCEAN_LOOK = Object.freeze({
  DEPTH_SINK_PER_SQUARE_METRE: 6e-8,
  MAX_DEPTH_SINK: 3,
  BASE_OPACITY: 0.8,
  GRAZING_OPACITY: 0.97,
  NEAR_GLINT_EXPONENT: 520,
  SUN_GLINT_STRENGTH: 0.75,
  MOON_GLINT_STRENGTH: 0.22,
  SUBSURFACE_STRENGTH: 0.5,
  SUN_HALO_STRENGTH: 0.45,
  DETAIL_PHASE_WARP: 2.6,
  SKY_REFLECTION_GAIN: 0.8,
});
const TWO_PI = Math.PI * 2;
const COMPONENT_NAMES = ['x', 'y', 'z', 'w'];
/** Lake bodies: base opacity, and the depth (m) over which the water fades in from its shore. */
const LAKE_OPACITY = 0.72;
const LAKE_SHORE_FADE = 0.45;
/** Lake shoreline foam band (m of water depth). */
const LAKE_FOAM_DEPTH = 1.3;

/**
 * The wave clock shared by every water material: one cycle count per wave of the table (13 waves in
 * four vec4 uniforms), advanced from the flight clock. advance(elapsed) once per frame.
 */
export function createWaveClock(ctx, waves) {
  const { THREE: T, TSL } = ctx;
  const { uniform } = TSL;
  const all = [...waves.swell, ...waves.detail];
  const uniforms = [];
  for (let index = 0; index < Math.ceil(all.length / 4); index++) uniforms.push(uniform(new T.Vector4()));
  return {
    waves: all,
    /** The node of wave index's cycle count (0..1). */
    cycles(index) {
      return uniforms[index >> 2][COMPONENT_NAMES[index & 3]];
    },
    advance(elapsed) {
      for (let index = 0; index < all.length; index++) {
        const wave = all[index];
        const cycles = (wave.angularSpeed * elapsed) / TWO_PI + wave.phaseSeed;
        uniforms[index >> 2].value.setComponent(index & 3, cycles - Math.floor(cycles));
      }
    },
  };
}

/**
 * Lighting terms shared by every water material, from the time of day: the sun and moon glint, the
 * subsurface crest glow and the sky halo strengths. update(time) once per frame (state.time).
 */
export function createWaterLighting(ctx) {
  const { TSL } = ctx;
  const { uniform } = TSL;
  const smoothstep = (value, low, high) => {
    const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const lighting = {
    sunGlintStrength: uniform(0),
    moonGlintStrength: uniform(0),
    subsurfaceStrength: uniform(0),
    sunHaloStrength: uniform(0),
    update(time) {
      const sunVisibility = smoothstep(time.sunDirection.y, -0.03, 0.04);
      const moonVisibility = smoothstep(time.moonDirection.y, 0, 0.08);
      lighting.sunGlintStrength.value = OCEAN_LOOK.SUN_GLINT_STRENGTH * sunVisibility * (1 - 0.9 * time.nightFactor);
      lighting.moonGlintStrength.value = OCEAN_LOOK.MOON_GLINT_STRENGTH * moonVisibility * time.nightFactor;
      lighting.subsurfaceStrength.value = OCEAN_LOOK.SUBSURFACE_STRENGTH * sunVisibility * (0.35 + 0.65 * time.goldenFactor);
      lighting.sunHaloStrength.value = OCEAN_LOOK.SUN_HALO_STRENGTH * sunVisibility * (0.35 + 0.65 * time.goldenFactor);
    },
  };
  return lighting;
}

/**
 * Creates a water material.
 *   kind 'ocean': options { waves (the query's table), axis (the grid's axis coordinates),
 *                 gridHalfExtent, effects (the water effects layer), clock (createWaveClock),
 *                 lighting (createWaterLighting) }. Returns { kind, material, swellScale (uniform),
 *                 waveOrigin (uniform vec2), cameraOffset (uniform vec2) }.
 *   kind 'lake' | 'ice': options { waves, effects, clock, lighting, swellScale (the ocean's uniform) }.
 *                 Returns { kind, material }. The mesh needs the attribute `waterShore` (vec2: water
 *                 depth to the basin ground, signed distance inside the outline in m) and
 *                 userData.water = { tint: Color, params: Vector4 (waves, glint, foam, mirror) }.
 */
export function createWaterMaterial(ctx, options) {
  if (options.kind === 'ocean') return createOceanMaterial(ctx, options);
  if (options.kind === 'lake') return createLakeMaterial(ctx, options);
  if (options.kind === 'ice') return createIceMaterial(ctx, options);
  throw new Error(`[DRIFTWING] createWaterMaterial: unknown kind "${options.kind}"`);
}

/** The fragment's world-space xz (positionWorld; the one place a render origin offset would apply). */
function worldXZ(TSL) {
  return TSL.positionWorld.xz;
}

/** Cloud cover over the fragment (0..1) from the shared cloud-shadow texture, 0 outside it. */
function cloudShadowNode(ctx) {
  const { TSL, uniforms, textures } = ctx;
  const { texture, step } = TSL;
  const shadowUV = worldXZ(TSL).sub(uniforms.cloudShadowCenter).div(uniforms.cloudShadowWorldSize).add(0.5);
  const insideShadowMap = step(0, shadowUV.x).mul(step(shadowUV.x, 1)).mul(step(0, shadowUV.y)).mul(step(shadowUV.y, 1));
  return texture(textures.cloudShadow, shadowUV).r.mul(insideShadowMap);
}

/** The sky radiance reflected along reflectedWorld (the sky dome's own function, or the gradient). */
function reflectedSkyNode(ctx, reflectedWorld, sunHaloStrength) {
  const { TSL, uniforms } = ctx;
  const { normalize, vec3, max, mix, smoothstep, saturate, dot, pow } = TSL;
  const skyColorNode = ctx.systems.sky?.skyColorNode;
  const sunAlignment = max(dot(reflectedWorld, uniforms.sunDirection), 0.0001);
  const reflectedRay = normalize(vec3(reflectedWorld.x, max(reflectedWorld.y, 0.015), reflectedWorld.z));
  return typeof skyColorNode === 'function'
    ? skyColorNode(reflectedRay).mul(OCEAN_LOOK.SKY_REFLECTION_GAIN)
    : mix(uniforms.skyHorizonColor, uniforms.skyZenithColor, smoothstep(0.02, 0.6, saturate(reflectedWorld.y)))
      .add(uniforms.sunColor.mul(pow(sunAlignment, 10).mul(sunHaloStrength)));
}

function createOceanMaterial(ctx, { waves, axis, gridHalfExtent, effects, clock, lighting }) {
  const { THREE: T, TSL, uniforms } = ctx;
  const {
    Fn, uniform, float, vec2, vec3, vec4, positionLocal, positionGeometry, positionView, positionWorld,
    cameraViewMatrix, varying, sin, cos, fract, dot, normalize, mix, smoothstep, saturate, pow, max, min,
    reflect, length, oneMinus, sqrt, cameraPosition, mx_noise_vec3,
  } = TSL;
  const halfSegments = axis.length - 1;

  /** Distance from the grid centre (Chebyshev) where cell spacing first exceeds maxSpacing. */
  function gridRadiusForSpacing(maxSpacing) {
    for (let index = 1; index <= halfSegments; index++) {
      if (axis[index] - axis[index - 1] > maxSpacing) return axis[index - 1];
    }
    return gridHalfExtent;
  }

  // The wave table with the grid's fades: swell displaces the geometry (faded where the grid gets
  // coarse), detail waves only shape the normal.
  const table = [];
  waves.swell.forEach((wave) => {
    const coarseRadius = gridRadiusForSpacing(wave.wavelength / 4);
    table.push({
      ...wave,
      swell: true,
      vertexFadeStart: coarseRadius * 0.6,
      vertexFadeEnd: coarseRadius,
      shadeFadeStart: wave.wavelength * 40,
      shadeFadeEnd: wave.wavelength * 140,
      slopeVariance: 0.5 * Math.pow(wave.waveNumber * wave.amplitude, 2),
    });
  });
  waves.detail.forEach((wave, index) => {
    table.push({
      ...wave,
      swell: false,
      vertexFadeStart: 0,
      vertexFadeEnd: 0,
      shadeFadeStart: wave.wavelength * 18,
      shadeFadeEnd: wave.wavelength * 70,
      slopeVariance: 0.5 * wave.slope * wave.slope,
      warpWeight: 0.8 + 0.45 * ((index * 0.381966) % 1),
    });
  });

  // ---- Uniforms (created once, updated by value) ---------------------------------------
  const waveOrigin = uniform(new T.Vector2());
  const cameraOffset = uniform(new T.Vector2());
  const swellScale = uniform(1);
  const { sunGlintStrength, moonGlintStrength, subsurfaceStrength, sunHaloStrength } = lighting;
  const deepColor = uniform(new T.Color(0x1f5a73));
  const shallowColor = uniform(new T.Color(0x3aa3a0));
  const moonGlintColor = uniform(new T.Color(0.62, 0.72, 1.0));

  function wavePhase(param, wave, waveIndex) {
    return fract(dot(param, vec2(wave.frequencyX, wave.frequencyZ)).sub(clock.cycles(waveIndex))).mul(TWO_PI);
  }

  // ---- Vertex stage: Gerstner swell in wrapped world space ------------------------------
  const material = new T.MeshStandardNodeMaterial({
    roughness: 0.12,
    metalness: 0,
    transparent: true,
    depthWrite: true,
  });
  material.name = 'water-ocean';

  material.positionNode = Fn(() => {
    const local = positionLocal;
    const param = local.xz.add(waveOrigin);
    const gridRadius = max(local.x.abs(), local.z.abs());
    const offset = vec3(0, 0, 0).toVar();
    table.forEach((wave, index) => {
      if (!wave.swell) return;
      const fade = oneMinus(smoothstep(wave.vertexFadeStart, wave.vertexFadeEnd, gridRadius));
      const amplitude = fade.mul(swellScale).mul(wave.amplitude);
      const theta = wavePhase(param, wave, index);
      const horizontal = cos(theta).mul(amplitude).mul(wave.steepness);
      offset.addAssign(vec3(horizontal.mul(wave.directionX), sin(theta).mul(amplitude), horizontal.mul(wave.directionZ)));
    });
    // Far water sinks a little (quadratic in distance, like depth-buffer error) so flat
    // shallows never z-fight with it on 24-bit depth.
    const cameraDistance = length(local.xz.sub(cameraOffset));
    const sink = min(cameraDistance.mul(cameraDistance).mul(OCEAN_LOOK.DEPTH_SINK_PER_SQUARE_METRE), OCEAN_LOOK.MAX_DEPTH_SINK);
    return local.add(offset).add(vec3(0, effects.nodes.displacement(local.xz), 0)).sub(vec3(0, sink, 0));
  })();

  // ---- Fragment stage: analytic normal at the undisplaced surface parameter -------------
  const surfaceParam = varying(positionGeometry.xz.add(waveOrigin));
  const viewDistance = length(positionView);
  // Grazing views squeeze many waves into one pixel: fade detail by the stretched pixel footprint.
  const viewSteepness = saturate(cameraPosition.y.sub(positionWorld.y).div(max(viewDistance, 1)));
  const footprintDistance = viewDistance.div(sqrt(max(viewSteepness, 0.06)));
  // One low-frequency noise sample (3 channels): slow "cat's paw" gust patches that modulate the
  // short waves, and two phase-warp fields that bend their crests so they never form a lattice.
  const surfaceNoise = mx_noise_vec3(vec3(worldXZ(TSL).mul(1 / 58), uniforms.time.mul(0.04)));
  const gust = saturate(surfaceNoise.x.mul(0.9).add(0.55));
  const detailScale = mix(float(0.35), float(1.3), gust);
  const crestWarpA = surfaceNoise.y.mul(OCEAN_LOOK.DETAIL_PHASE_WARP);
  const crestWarpB = surfaceNoise.z.mul(OCEAN_LOOK.DETAIL_PHASE_WARP);
  // Far away the long swell would read as regular stripes in the reflection: soften its slope.
  const swellSlopeScale = mix(float(1), float(0.5), smoothstep(250, 2200, footprintDistance));

  const surface = Fn(() => {
    const slopeX = float(0).toVar();
    const slopeZ = float(0).toVar();
    const crestLift = float(0).toVar();
    const height = float(0).toVar();
    table.forEach((wave, index) => {
      const fade = oneMinus(smoothstep(wave.shadeFadeStart, wave.shadeFadeEnd, footprintDistance));
      const amplitude = fade.mul(wave.swell ? swellScale : detailScale).mul(wave.amplitude);
      const warp = wave.swell ? null : (index % 2 === 0 ? crestWarpA : crestWarpB).mul(wave.warpWeight);
      const theta = warp ? wavePhase(surfaceParam, wave, index).add(warp) : wavePhase(surfaceParam, wave, index);
      const sine = sin(theta);
      const slopeAmplitude = wave.swell ? amplitude.mul(swellSlopeScale) : amplitude;
      const slope = cos(theta).mul(slopeAmplitude).mul(wave.waveNumber);
      slopeX.addAssign(slope.mul(wave.directionX));
      slopeZ.addAssign(slope.mul(wave.directionZ));
      height.addAssign(sine.mul(amplitude));
      if (wave.swell) crestLift.addAssign(sine.mul(slopeAmplitude).mul(wave.waveNumber * wave.steepness));
    });
    // Unnormalised: the local effects add their slopes before the normalisation below.
    return vec4(slopeX.negate(), oneMinus(crestLift), slopeZ.negate(), height);
  })();

  // Slope variance of the detail that faded out: widens the glint lobe with distance.
  let unresolvedVariance = float(0);
  table.forEach((wave) => {
    const hidden = smoothstep(wave.shadeFadeStart, wave.shadeFadeEnd, footprintDistance).mul(wave.slopeVariance);
    unresolvedVariance = unresolvedVariance.add(wave.swell ? hidden : hidden.mul(detailScale).mul(detailScale));
  });

  const waveHeight = surface.w;
  // Local effects: vec4(slope x, slope z, foam, glow), all exactly zero while nothing is active.
  const effectSurface = effects.nodes.surface(waveHeight);
  const foam = effectSurface.z;
  const surfaceNormal = normalize(surface.xyz.sub(vec3(effectSurface.x, 0, effectSurface.y)));
  const surfaceNormalView = cameraViewMatrix.transformDirection(surfaceNormal);
  material.normalNode = surfaceNormalView;

  const viewDirection = normalize(positionView.negate());
  const cosView = saturate(dot(surfaceNormalView, viewDirection));
  const fresnel = float(0.02).add(pow(oneMinus(cosView), 5).mul(0.98));
  const reflectedWorld = reflect(viewDirection.negate(), surfaceNormalView).transformDirection(cameraViewMatrix);

  const cloudShadow = cloudShadowNode(ctx);

  const sunAlignment = max(dot(reflectedWorld, uniforms.sunDirection), 0.0001);
  // Reflect the sky dome's own radiance (the same function the dome and fog use, sun glow included), so
  // the water always mirrors the sky above it; rays bent below the horizon reflect the horizon itself.
  const reflectedSky = reflectedSkyNode(ctx, reflectedWorld, sunHaloStrength);

  const glintVariance = unresolvedVariance.add(1 / (4 * OCEAN_LOOK.NEAR_GLINT_EXPONENT));
  const glintExponent = float(0.25).div(glintVariance);
  const glintFresnel = max(fresnel, 0.08);
  const sunGlint = uniforms.sunColor
    .mul(pow(sunAlignment, glintExponent).mul(glintExponent.add(2).mul(1 / TWO_PI)))
    .mul(glintFresnel.mul(sunGlintStrength).mul(oneMinus(cloudShadow.mul(0.85))));
  const moonExponent = glintExponent.mul(0.35);
  const moonAlignment = max(dot(reflectedWorld, uniforms.moonDirection), 0.0001);
  const moonGlint = moonGlintColor.mul(pow(moonAlignment, moonExponent).mul(moonExponent.add(2).mul(1 / TWO_PI)))
    .mul(glintFresnel.mul(moonGlintStrength));

  const crest = saturate(waveHeight.mul(1.1).add(0.45));
  const sunView = cameraViewMatrix.transformDirection(uniforms.sunDirection);
  const towardSun = saturate(dot(viewDirection.negate(), sunView));
  const subsurface = shallowColor.mul(uniforms.sunColor)
    .mul(pow(towardSun, 5).mul(crest.mul(crest)).mul(subsurfaceStrength).mul(oneMinus(cloudShadow.mul(0.8))));

  const bodyColor = mix(deepColor, shallowColor, saturate(crest.mul(0.45).add(cosView.mul(0.35))));
  const waterAlbedo = bodyColor.mul(oneMinus(fresnel)).mul(oneMinus(cloudShadow.mul(0.55))).mul(oneMinus(effects.nodes.darken()));
  // Foam is lit like the land (diffuse), and hides the mirror, the glints and the subsurface glow.
  material.colorNode = mix(waterAlbedo, effects.nodes.foamColor.mul(0.82), foam);
  material.emissiveNode = reflectedSky.mul(fresnel).mul(oneMinus(cloudShadow.mul(0.3)))
    .add(sunGlint)
    .add(moonGlint)
    .add(subsurface)
    .mul(oneMinus(foam.mul(0.85)))
    .add(effects.nodes.glowColor.mul(effectSurface.w.mul(1.35)));
  material.opacityNode = mix(mix(float(OCEAN_LOOK.BASE_OPACITY), float(OCEAN_LOOK.GRAZING_OPACITY), fresnel), float(1), foam);

  return { kind: 'ocean', material, swellScale, waveOrigin, cameraOffset };
}

/** Per-object uniforms of a local water body (mesh.userData.water): its tint and its params. */
function bodyUniforms(ctx) {
  const { THREE: T, TSL } = ctx;
  const { uniform } = TSL;
  const fallbackTint = new T.Color(0x2f8f9a);
  const fallbackParams = new T.Vector4(0.25, 1, 1, 0);
  return {
    tint: uniform(new T.Color(0x2f8f9a)).onObjectUpdate(({ object }) => object.userData.water?.tint ?? fallbackTint),
    params: uniform(new T.Vector4(0.25, 1, 1, 0)).onObjectUpdate(({ object }) => object.userData.water?.params ?? fallbackParams),
  };
}

function createLakeMaterial(ctx, { waves, effects, clock, lighting, swellScale }) {
  const { THREE: T, TSL, uniforms } = ctx;
  const {
    Fn, float, vec2, vec3, sin, cos, fract, dot, normalize, mix, smoothstep, saturate, pow, max, attribute,
    reflect, length, oneMinus, positionView, cameraViewMatrix, mx_noise_float, mx_noise_vec3, mod,
  } = TSL;
  const body = bodyUniforms(ctx);
  const waveScale = body.params.x;
  const glintScale = body.params.y;
  const foamScale = body.params.z;
  const mirror = body.params.w;
  const shore = attribute('waterShore', 'vec2');
  const depth = shore.x;
  const inside = shore.y;

  const material = new T.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0, transparent: true, depthWrite: true });
  material.name = 'water-lake';

  // Waves scaled down: the swell (per body, times the ocean's swell scale) and the detail ripples
  // only shape the normal; the surface itself stays flat (the physics treats lakes as flat too).
  const wrapped = mod(worldXZ(TSL), 4096);
  const viewDistance = length(positionView);
  const ripple = mx_noise_vec3(vec3(worldXZ(TSL).mul(1 / 41), uniforms.time.mul(0.05)));
  const gust = saturate(ripple.x.mul(0.9).add(0.5));
  const calm = oneMinus(mirror.mul(0.9));
  const all = [...waves.swell, ...waves.detail];
  const slopes = Fn(() => {
    const slopeX = float(0).toVar();
    const slopeZ = float(0).toVar();
    all.forEach((wave, index) => {
      const swell = index < waves.swell.length;
      const fadeEnd = wave.wavelength * (swell ? 120 : 60);
      const fade = oneMinus(smoothstep(fadeEnd * 0.25, fadeEnd, viewDistance));
      const amplitude = swell ? swellScale.mul(waveScale).mul(wave.amplitude) : waveScale.mul(gust).mul(wave.amplitude * 1.6);
      const warp = swell ? float(0) : (index % 2 === 0 ? ripple.y : ripple.z).mul(2.2);
      const theta = fract(dot(wrapped, vec2(wave.frequencyX, wave.frequencyZ)).sub(clock.cycles(index))).mul(TWO_PI).add(warp);
      const slope = cos(theta).mul(amplitude).mul(wave.waveNumber).mul(fade).mul(calm);
      slopeX.addAssign(slope.mul(wave.directionX));
      slopeZ.addAssign(slope.mul(wave.directionZ));
    });
    return vec2(slopeX, slopeZ);
  })();
  // The craft's foam trail (the effects layer's trail buffer) and a lacy shoreline band.
  const trailFoam = effects.nodes.trailFoam(worldXZ(TSL));
  const lace = mx_noise_float(vec3(worldXZ(TSL).mul(0.32), uniforms.time.mul(0.22)));
  const shoreBand = oneMinus(smoothstep(0, LAKE_FOAM_DEPTH, depth)).mul(smoothstep(0.02, 0.18, depth));
  const surge = sin(uniforms.time.mul(0.9).add(lace.mul(2.4))).mul(0.25).add(0.75);
  const foam = saturate(shoreBand.mul(smoothstep(-0.3, 0.35, lace)).mul(surge).mul(foamScale).add(trailFoam.mul(0.8)));
  const surfaceNormal = normalize(vec3(slopes.x.negate(), 1, slopes.y.negate()));
  const normalView = cameraViewMatrix.transformDirection(surfaceNormal);
  material.normalNode = normalView;

  const viewDirection = normalize(positionView.negate());
  const cosView = saturate(dot(normalView, viewDirection));
  const fresnel = mix(float(0.02).add(pow(oneMinus(cosView), 5).mul(0.98)), float(0.9), mirror);
  const reflectedWorld = reflect(viewDirection.negate(), normalView).transformDirection(cameraViewMatrix);
  const cloudShadow = cloudShadowNode(ctx);
  const reflectedSky = reflectedSkyNode(ctx, reflectedWorld, lighting.sunHaloStrength);
  const sunAlignment = max(dot(reflectedWorld, uniforms.sunDirection), 0.0001);
  const glintExponent = mix(float(140), float(900), mirror);
  const sunGlint = uniforms.sunColor
    .mul(pow(sunAlignment, glintExponent).mul(glintExponent.add(2).mul(1 / TWO_PI)))
    .mul(max(fresnel, 0.08).mul(lighting.sunGlintStrength).mul(glintScale).mul(oneMinus(cloudShadow.mul(0.85))));
  const moonAlignment = max(dot(reflectedWorld, uniforms.moonDirection), 0.0001);
  const moonGlint = vec3(0.62, 0.72, 1.0).mul(pow(moonAlignment, glintExponent.mul(0.35)).mul(glintExponent.mul(0.35).add(2).mul(1 / TWO_PI)))
    .mul(max(fresnel, 0.08).mul(lighting.moonGlintStrength).mul(glintScale));

  // Body colour: the tint, deeper and darker toward the middle, lighter over the shallows.
  const deep = body.tint.mul(0.55);
  const shallow = body.tint.mul(1.25).add(vec3(0.04, 0.06, 0.05));
  const bodyColor = mix(shallow, deep, smoothstep(0.5, 9, depth));
  const albedo = bodyColor.mul(oneMinus(fresnel)).mul(oneMinus(cloudShadow.mul(0.55)));
  material.colorNode = mix(albedo, vec3(0.86, 0.88, 0.86), foam);
  material.emissiveNode = reflectedSky.mul(fresnel).mul(oneMinus(cloudShadow.mul(0.3))).add(sunGlint).add(moonGlint).mul(oneMinus(foam.mul(0.85)));
  // Fades in from the shore; outside the outline it is discarded.
  const shoreFade = smoothstep(0, LAKE_SHORE_FADE, depth.add(mirror.mul(LAKE_SHORE_FADE)));
  material.opacityNode = mix(mix(float(LAKE_OPACITY), float(0.97), fresnel), float(1), foam).mul(shoreFade).mul(smoothstep(-0.5, 0.5, inside));
  material.alphaTestNode = float(0.01);
  return { kind: 'lake', material };
}

function createIceMaterial(ctx, { lighting }) {
  const { THREE: T, TSL } = ctx;
  const {
    float, vec3, normalize, mix, smoothstep, saturate, pow, max, dot, abs, attribute, oneMinus, reflect,
    positionView, cameraViewMatrix, mx_noise_float,
  } = TSL;
  const body = bodyUniforms(ctx);
  const shore = attribute('waterShore', 'vec2');
  const inside = shore.y;
  const depth = shore.x;
  const xz = worldXZ(TSL);

  const material = new T.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0 });
  material.name = 'water-ice';
  // Rime and snow patches, long pressure ridges (stretched noise), and a web of thin cracks.
  const patches = mx_noise_float(vec3(xz.mul(0.018), 0.5));
  const rime = smoothstep(-0.15, 0.45, patches.add(mx_noise_float(vec3(xz.mul(0.09), 2.1)).mul(0.35)));
  const ridgeNoise = mx_noise_float(vec3(xz.x.mul(0.006), xz.y.mul(0.03), 7.3));
  const ridges = oneMinus(smoothstep(0.0, 0.06, abs(ridgeNoise)));
  const crackA = oneMinus(smoothstep(0.0, 0.025, abs(mx_noise_float(vec3(xz.mul(0.045), 11.7)))));
  const crackB = oneMinus(smoothstep(0.0, 0.02, abs(mx_noise_float(vec3(xz.mul(0.11), 23.1)))));
  const cracks = saturate(crackA.add(crackB.mul(0.6)));
  const clearIce = mix(vec3(0.42, 0.62, 0.74), body.tint.mul(0.9), 0.35);
  const rimeColor = vec3(0.86, 0.91, 0.95);
  const base = mix(clearIce, rimeColor, rime.mul(0.8));
  const shoreSnow = oneMinus(smoothstep(0.1, 1.2, depth));
  material.colorNode = mix(mix(base, vec3(0.93, 0.95, 0.97), ridges.mul(0.7)), vec3(0.18, 0.28, 0.36), cracks.mul(0.75)).mul(0.92).add(vec3(0.05).mul(shoreSnow));
  // Ridges are rougher and catch the light; the clear ice between is smoother (a dull specular).
  material.roughnessNode = mix(float(0.32), float(0.7), max(rime.mul(0.6), ridges));
  // A faint sky sheen on the clear ice at grazing angles.
  const viewDirection = normalize(positionView.negate());
  const up = cameraViewMatrix.transformDirection(vec3(0, 1, 0));
  const fresnel = pow(oneMinus(saturate(dot(up, viewDirection))), 5).mul(0.6).mul(oneMinus(rime));
  const reflectedWorld = reflect(viewDirection.negate(), up).transformDirection(cameraViewMatrix);
  material.emissiveNode = reflectedSkyNode(ctx, reflectedWorld, lighting.sunHaloStrength).mul(fresnel).mul(0.35);
  material.opacityNode = smoothstep(-0.5, 0.5, inside);
  material.alphaTestNode = float(0.5);
  return { kind: 'ice', material };
}
