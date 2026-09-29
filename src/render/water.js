import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG } from '../core/config.js';
import { MathUtils, DEG, clamp, damp } from '../core/util.js';
import { createWaterEffects } from './waterEffects.js';

/**
 * WATER: an 8 km wave grid that follows the camera.
 *
 * - Geometry: a tensor-product grid, 4 m spacing in the central 384 m square and
 *   geometrically widening cells out to +-4 km. Every vertex sits on the 4 m
 *   lattice and the mesh is snapped to 4 m steps, so the swell never swims.
 * - Waves: 4 Gerstner swells displace the vertices (faded where the grid gets
 *   coarse) and 6 short detail waves only shape the per-pixel analytic normal.
 *   Every wave vector is quantised to whole cycles over a 4096 m tile, so the
 *   shader works on wrapped coordinates and stays precise hundreds of km out.
 * - Shading: body colour deep -> turquoise by crest height and view angle,
 *   Fresnel sky reflection (the sky module's own radiance for the reflected ray,
 *   i.e. its horizon / zenith palette and sun glow; the skyHorizonColor /
 *   skyZenithColor gradient is the fallback), an HDR sun glint
 *   whose lobe widens with distance as the detail waves fade (the long streak
 *   toward a low sun), a cool moon glint at night, back-lit crest glow, and
 *   cloud-shadow darkening from ctx.textures.cloudShadow.
 * - Local effects (Phase 2, waterEffects.js): whirlpool funnels, ripple rings, foam and
 *   bioluminescent trails, added to the displacement, the normal, the colour and the emission. With
 *   none active every added term is exactly zero, so the ocean renders as in Phase 1.
 */
export function createWaterSystem(ctx) {
  const { THREE: T, scene, camera, state, uniforms, textures } = ctx;
  const {
    Fn, uniform, float, vec2, vec3, vec4, positionLocal, positionGeometry, positionView, positionWorld,
    cameraViewMatrix, varying, sin, cos, fract, dot, normalize, mix, smoothstep, saturate, pow, max, min,
    reflect, length, texture, step, oneMinus, sqrt, cameraPosition, mx_noise_vec3,
  } = TSL;

  const TWO_PI = Math.PI * 2;
  const GRID_HALF_EXTENT = 4000;
  const GRID_STEP = 4;
  const INNER_CELLS = 48;
  const HALF_SEGMENTS = 110;
  const WAVE_TILE = 4096;
  const GRAVITY = 9.81;
  const WAVE_SPEED_SCALE = 0.9;
  const DEPTH_SINK_PER_SQUARE_METRE = 6e-8;
  const MAX_DEPTH_SINK = 3;
  const BASE_OPACITY = 0.8;
  const GRAZING_OPACITY = 0.97;
  const NEAR_GLINT_EXPONENT = 520;
  const SUN_GLINT_STRENGTH = 0.75;
  const MOON_GLINT_STRENGTH = 0.22;
  const SUBSURFACE_STRENGTH = 0.5;
  const SUN_HALO_STRENGTH = 0.45;
  const DETAIL_PHASE_WARP = 2.6;
  // The rippled surface scatters part of the mirrored sky: a slightly dimmer reflection keeps the glint dominant.
  const SKY_REFLECTION_GAIN = 0.8;

  // Swell waves displace the geometry; angles are degrees relative to the wind.
  const SWELL_SPECS = [
    { angle: 0, wavelength: 84, amplitude: 0.26, steepness: 1.6 },
    { angle: -31, wavelength: 51, amplitude: 0.19, steepness: 1.8 },
    { angle: 27, wavelength: 33, amplitude: 0.13, steepness: 2.0 },
    { angle: -9, wavelength: 21, amplitude: 0.08, steepness: 2.2 },
  ];
  // Detail waves only shape the normal; slope = wave number x amplitude. Irregular angles and
  // wavelength ratios keep the interference from reading as a grid.
  const DETAIL_SPECS = [
    { angle: 22, wavelength: 14.3, slope: 0.06 },
    { angle: -31, wavelength: 10.4, slope: 0.066 },
    { angle: 6, wavelength: 7.6, slope: 0.072 },
    { angle: -12, wavelength: 5.7, slope: 0.072 },
    { angle: 47, wavelength: 4.4, slope: 0.066 },
    { angle: -58, wavelength: 3.5, slope: 0.062 },
    { angle: 104, wavelength: 2.8, slope: 0.048 },
    { angle: -117, wavelength: 2.2, slope: 0.044 },
    { angle: 31, wavelength: 1.7, slope: 0.04 },
  ];

  // ---- Grid geometry ----------------------------------------------------------------
  /** Axis coordinates 0..HALF_SEGMENTS: uniform inner cells, then geometric growth, all on the 4 m lattice. */
  function buildAxisCoordinates() {
    const outerSteps = HALF_SEGMENTS - INNER_CELLS;
    const outerExtent = GRID_HALF_EXTENT - INNER_CELLS * GRID_STEP;
    let low = 1.0001;
    let high = 1.5;
    for (let iteration = 0; iteration < 60; iteration++) {
      const ratio = (low + high) / 2;
      const extent = (GRID_STEP * ratio * (Math.pow(ratio, outerSteps) - 1)) / (ratio - 1);
      if (extent > outerExtent) high = ratio;
      else low = ratio;
    }
    const growth = (low + high) / 2;
    const coordinates = new Float64Array(HALF_SEGMENTS + 1);
    let position = 0;
    let spacing = GRID_STEP;
    for (let index = 1; index <= HALF_SEGMENTS; index++) {
      if (index > INNER_CELLS) spacing *= growth;
      position += spacing;
      coordinates[index] = Math.round(position / GRID_STEP) * GRID_STEP;
    }
    return coordinates;
  }

  function buildGridGeometry(axis) {
    const side = HALF_SEGMENTS * 2 + 1;
    const values = new Float64Array(side);
    for (let index = 0; index < side; index++) {
      const offset = index - HALF_SEGMENTS;
      values[index] = Math.sign(offset) * axis[Math.abs(offset)];
    }
    const positions = new Float32Array(side * side * 3);
    const normals = new Float32Array(side * side * 3);
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        const vertex = (row * side + column) * 3;
        positions[vertex] = values[column];
        positions[vertex + 2] = values[row];
        normals[vertex + 1] = 1;
      }
    }
    const segments = side - 1;
    const indices = new Uint32Array(segments * segments * 6);
    let cursor = 0;
    for (let row = 0; row < segments; row++) {
      for (let column = 0; column < segments; column++) {
        const a = row * side + column;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        // Counter-clockwise seen from above (+y): [v(i,j), v(i,j+1), v(i+1,j)] and [v(i+1,j), v(i,j+1), v(i+1,j+1)].
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
    geometry.setIndex(new T.BufferAttribute(indices, 1));
    geometry.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), GRID_HALF_EXTENT * Math.SQRT2 + 8);
    return geometry;
  }

  /** Distance from the grid centre (Chebyshev) where cell spacing first exceeds maxSpacing. */
  function gridRadiusForSpacing(axis, maxSpacing) {
    for (let index = 1; index <= HALF_SEGMENTS; index++) {
      if (axis[index] - axis[index - 1] > maxSpacing) return axis[index - 1];
    }
    return GRID_HALF_EXTENT;
  }

  // ---- Wave set (quantised to the tile so wrapped coordinates stay seamless) ----------
  const windVector = uniforms.windDirection.value;
  const windAngle = Math.atan2(windVector.y, windVector.x);
  const axisCoordinates = buildAxisCoordinates();

  function quantiseWave(angleDegrees, wavelength) {
    const angle = windAngle + angleDegrees * DEG;
    const cyclesX = Math.round((WAVE_TILE * Math.cos(angle)) / wavelength);
    const cyclesZ = Math.round((WAVE_TILE * Math.sin(angle)) / wavelength);
    const frequencyX = cyclesX / WAVE_TILE;
    const frequencyZ = cyclesZ / WAVE_TILE;
    const frequency = Math.hypot(frequencyX, frequencyZ);
    const waveNumber = TWO_PI * frequency;
    return {
      frequencyX,
      frequencyZ,
      directionX: frequencyX / frequency,
      directionZ: frequencyZ / frequency,
      waveNumber,
      wavelength: 1 / frequency,
      angularSpeed: Math.sqrt(GRAVITY * waveNumber) * WAVE_SPEED_SCALE,
    };
  }

  const waves = [];
  SWELL_SPECS.forEach((spec, index) => {
    const wave = quantiseWave(spec.angle, spec.wavelength);
    const coarseRadius = gridRadiusForSpacing(axisCoordinates, wave.wavelength / 4);
    waves.push({
      ...wave,
      swell: true,
      amplitude: spec.amplitude,
      steepness: spec.steepness,
      vertexFadeStart: coarseRadius * 0.6,
      vertexFadeEnd: coarseRadius,
      shadeFadeStart: wave.wavelength * 40,
      shadeFadeEnd: wave.wavelength * 140,
      slopeVariance: 0.5 * Math.pow(wave.waveNumber * spec.amplitude, 2),
      phaseSeed: (index * 0.618034) % 1,
    });
  });
  DETAIL_SPECS.forEach((spec, index) => {
    const wave = quantiseWave(spec.angle, spec.wavelength);
    waves.push({
      ...wave,
      swell: false,
      amplitude: spec.slope / wave.waveNumber,
      steepness: 0,
      vertexFadeStart: 0,
      vertexFadeEnd: 0,
      shadeFadeStart: wave.wavelength * 18,
      shadeFadeEnd: wave.wavelength * 70,
      slopeVariance: 0.5 * spec.slope * spec.slope,
      warpWeight: 0.8 + 0.45 * ((index * 0.381966) % 1),
      phaseSeed: ((index + SWELL_SPECS.length) * 0.618034) % 1,
    });
  });

  // ---- Uniforms (created once, updated by value) ---------------------------------------
  const waveOrigin = uniform(new T.Vector2());
  const cameraOffset = uniform(new T.Vector2());
  const swellScale = uniform(1);
  const timeCycleUniforms = [uniform(new T.Vector4()), uniform(new T.Vector4()), uniform(new T.Vector4()), uniform(new T.Vector4())];
  const sunGlintStrength = uniform(0);
  const moonGlintStrength = uniform(0);
  const subsurfaceStrength = uniform(0);
  const sunHaloStrength = uniform(0);
  const deepColor = uniform(new T.Color(0x1f5a73));
  const shallowColor = uniform(new T.Color(0x3aa3a0));
  const moonGlintColor = uniform(new T.Color(0.62, 0.72, 1.0));
  const COMPONENT_NAMES = ['x', 'y', 'z', 'w'];

  function timeCycles(waveIndex) {
    return timeCycleUniforms[waveIndex >> 2][COMPONENT_NAMES[waveIndex & 3]];
  }
  function wavePhase(param, wave, waveIndex) {
    return fract(dot(param, vec2(wave.frequencyX, wave.frequencyZ)).sub(timeCycles(waveIndex))).mul(TWO_PI);
  }

  // Local effects layer: spawns write into it (ctx.systems.water.effects, the engine ctx's `water`).
  const effects = createWaterEffects(ctx);

  // ---- Vertex stage: Gerstner swell in wrapped world space ------------------------------
  const material = new T.MeshStandardNodeMaterial({
    roughness: 0.12,
    metalness: 0,
    transparent: true,
    depthWrite: true,
  });

  material.positionNode = Fn(() => {
    const local = positionLocal;
    const param = local.xz.add(waveOrigin);
    const gridRadius = max(local.x.abs(), local.z.abs());
    const offset = vec3(0, 0, 0).toVar();
    waves.forEach((wave, index) => {
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
    const sink = min(cameraDistance.mul(cameraDistance).mul(DEPTH_SINK_PER_SQUARE_METRE), MAX_DEPTH_SINK);
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
  const surfaceNoise = mx_noise_vec3(vec3(positionWorld.xz.mul(1 / 58), uniforms.time.mul(0.04)));
  const gust = saturate(surfaceNoise.x.mul(0.9).add(0.55));
  const detailScale = mix(float(0.35), float(1.3), gust);
  const crestWarpA = surfaceNoise.y.mul(DETAIL_PHASE_WARP);
  const crestWarpB = surfaceNoise.z.mul(DETAIL_PHASE_WARP);
  // Far away the long swell would read as regular stripes in the reflection: soften its slope.
  const swellSlopeScale = mix(float(1), float(0.5), smoothstep(250, 2200, footprintDistance));

  const surface = Fn(() => {
    const slopeX = float(0).toVar();
    const slopeZ = float(0).toVar();
    const crestLift = float(0).toVar();
    const height = float(0).toVar();
    waves.forEach((wave, index) => {
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
  waves.forEach((wave) => {
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

  const shadowUV = positionWorld.xz.sub(uniforms.cloudShadowCenter).div(uniforms.cloudShadowWorldSize).add(0.5);
  const insideShadowMap = step(0, shadowUV.x).mul(step(shadowUV.x, 1)).mul(step(0, shadowUV.y)).mul(step(shadowUV.y, 1));
  const cloudShadow = texture(textures.cloudShadow, shadowUV).r.mul(insideShadowMap);

  const sunAlignment = max(dot(reflectedWorld, uniforms.sunDirection), 0.0001);
  // Reflect the sky dome's own radiance (the same function the dome and fog use, sun glow included), so
  // the water always mirrors the sky above it; rays bent below the horizon reflect the horizon itself.
  const skyColorNode = ctx.systems.sky?.skyColorNode;
  const reflectedRay = normalize(vec3(reflectedWorld.x, max(reflectedWorld.y, 0.015), reflectedWorld.z));
  const reflectedSky = typeof skyColorNode === 'function'
    ? skyColorNode(reflectedRay).mul(SKY_REFLECTION_GAIN)
    : mix(uniforms.skyHorizonColor, uniforms.skyZenithColor, smoothstep(0.02, 0.6, saturate(reflectedWorld.y)))
      .add(uniforms.sunColor.mul(pow(sunAlignment, 10).mul(sunHaloStrength)));

  const glintVariance = unresolvedVariance.add(1 / (4 * NEAR_GLINT_EXPONENT));
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
    .add(effects.nodes.glowColor.mul(effectSurface.w.mul(2.4)));
  material.opacityNode = mix(mix(float(BASE_OPACITY), float(GRAZING_OPACITY), fresnel), float(1), foam);

  const mesh = new T.Mesh(buildGridGeometry(axisCoordinates), material);
  mesh.name = 'water';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  scene.add(mesh);

  // ---- Per-frame -----------------------------------------------------------------------
  function positiveModulo(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
  }

  function followCamera(referenceX, referenceZ) {
    const anchorX = Math.round(referenceX / GRID_STEP) * GRID_STEP;
    const anchorZ = Math.round(referenceZ / GRID_STEP) * GRID_STEP;
    mesh.position.set(anchorX, CONFIG.WATER_LEVEL, anchorZ);
    waveOrigin.value.set(positiveModulo(anchorX, WAVE_TILE), positiveModulo(anchorZ, WAVE_TILE));
    cameraOffset.value.set(referenceX - anchorX, referenceZ - anchorZ);
  }

  function advanceWaves(elapsed) {
    for (let index = 0; index < waves.length; index++) {
      const wave = waves[index];
      const cycles = (wave.angularSpeed * elapsed) / TWO_PI + wave.phaseSeed;
      timeCycleUniforms[index >> 2].value.setComponent(index & 3, cycles - Math.floor(cycles));
    }
  }

  function updateLighting(realDt) {
    const time = state.time;
    const sunVisibility = MathUtils.smoothstep(time.sunDirection.y, -0.03, 0.04);
    const moonVisibility = MathUtils.smoothstep(time.moonDirection.y, 0, 0.08);
    sunGlintStrength.value = SUN_GLINT_STRENGTH * sunVisibility * (1 - 0.9 * time.nightFactor);
    moonGlintStrength.value = MOON_GLINT_STRENGTH * moonVisibility * time.nightFactor;
    subsurfaceStrength.value = SUBSURFACE_STRENGTH * sunVisibility * (0.35 + 0.65 * time.goldenFactor);
    sunHaloStrength.value = SUN_HALO_STRENGTH * sunVisibility * (0.35 + 0.65 * time.goldenFactor);
    const windTarget = clamp(0.75 + 0.35 * uniforms.windStrength.value, 0.7, 1.2);
    swellScale.value = damp(swellScale.value, windTarget, 0.5, realDt);
  }

  followCamera(state.player.position.x, state.player.position.z);
  advanceWaves(state.time.elapsed);
  updateLighting(1);

  return {
    mesh,
    /** The local effects layer (waterEffects.js): the spawns' water API. */
    effects,
    update(dt, realDt) {
      followCamera(camera.position.x, camera.position.z);
      advanceWaves(state.time.elapsed);
      updateLighting(realDt);
      effects.update(dt, realDt, mesh.position.x, mesh.position.z, camera.position);
    },
    getStats() {
      return { effects: effects.stats() };
    },
  };
}
