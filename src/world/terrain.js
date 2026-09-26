import TerrainWorker from './terrain.worker.js?worker&inline';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp } from '../core/util.js';
import { CONFIG } from '../core/config.js';
import { createChunkBuilder } from './chunkBuilder.js';

/**
 * TERRAIN: the infinite streamed world surface.
 * - Square chunks (CONFIG.CHUNK_SIZE) are generated in Web Workers (terrain.worker.js,
 *   which imports the same world generator and chunk builder as the main thread) with
 *   transferable buffers that are recycled in both directions. A time-sliced main-thread builder takes over
 *   when Workers are unavailable.
 * - Chebyshev LOD rings around the player's chunk and a velocity look-ahead
 *   chunk (union of both), each with hysteresis; replacement meshes swap in
 *   atomically, the previous mesh stays until then (never a hole).
 * - Pooled fixed-size meshes refilled in place; skirts hide T-junction gaps.
 * - Worker-side vegetation scatter shown as pooled per-chunk InstancedMeshes.
 * - Terrain material: vertex colours, per-face normals, cloud shadows on the
 *   sun term only, a soft underwater depth gradient (faceted lighting and colour
 *   steps eased out below the waterline) and an animated shoreline foam band.
 */
export function createTerrainSystem(ctx) {
  const { scene, camera, world, state, bus, uniforms } = ctx;
  const {
    Fn, vec2, vec3, vec4, color, uniform, texture, attribute, positionWorld, positionGeometry,
    vertexColor, smoothstep, mix, sin, cos, mod, saturate, min, abs, dot, oneMinus, modelWorldMatrix,
    screenCoordinate, fract, floor, exp, normalize, normalView, cameraViewMatrix, fwidth, cameraPosition,
  } = TSL;

  // ---- Tuning --------------------------------------------------------------------------
  const CHUNK_SIZE = CONFIG.CHUNK_SIZE;
  const LOD_RESOLUTIONS = Array.from(CONFIG.LOD_RESOLUTIONS);
  const LOD_RING_LIMITS = Array.from(CONFIG.LOD_RING_LIMITS);
  const LOD_COUNT = LOD_RESOLUTIONS.length;
  const SKIRT_DEPTH = CONFIG.SKIRT_DEPTH;
  // Coarser lattices deviate further from the finer neighbour's edge (measured worst cases in steep
  // peaks: ~20 m for LOD0|1, ~43 m for LOD2|3), so skirts deepen with the LOD step: 36, 54, 81, 121 m.
  const SKIRT_DEPTHS = LOD_RESOLUTIONS.map((resolution, lod) => SKIRT_DEPTH * Math.pow(1.5, lod));
  const CENTER_HYSTERESIS = 44;
  const LOOKAHEAD_SECONDS = 1.5;
  const LOOKAHEAD_SMOOTHING = 2.2;
  const TELEPORT_DISTANCE = 900;
  const MAX_JOBS_PER_WORKER = 2;
  const APPLY_BUDGET_MS = 2.5;
  const STARTUP_APPLY_BUDGET_MS = 24;
  const UPLOAD_BYTES_PER_FRAME = 3.5 * 1024 * 1024;
  const STARTUP_UPLOAD_BYTES_PER_FRAME = 48 * 1024 * 1024;
  const MAIN_THREAD_BUDGET_MS = 4;
  const MAIN_THREAD_STARTUP_BUDGET_MS = 12;
  const REPLAN_INTERVAL = 0.3;
  const WORKER_READY_TIMEOUT = 6;
  const BUFFER_POOL_LIMIT = 12;
  const FLOWER_RINGS = 2;
  const NEW_VEGETATION_MESHES_PER_FRAME = 6;
  const VEGETATION = world.VEGETATION;
  const VEGETATION_TYPE_COUNT = 6;
  const SCATTER_MAX_INSTANCES = 640;
  const SCATTER_HEADER_FLOATS = VEGETATION_TYPE_COUNT * 6;
  const SCATTER_INSTANCE_FLOATS = 10;
  const SCATTER_FLOATS = SCATTER_HEADER_FLOATS + SCATTER_MAX_INSTANCES * SCATTER_INSTANCE_FLOATS;
  const SCATTER_SCALE_OFFSET = SCATTER_HEADER_FLOATS + SCATTER_MAX_INSTANCES * 4;
  const SCATTER_TINT_OFFSET = SCATTER_SCALE_OFFSET + SCATTER_MAX_INSTANCES * 3;
  const WARMUP_FRAMES = 3;
  const JOB_MESH = 0;
  const JOB_SCATTER = 1;
  const WRAP_PERIOD = 4096;
  const LOD_FADE_SECONDS = 0.7;
  const MAX_FADING_CHUNKS = 64;
  const VEGETATION_GROW_SECONDS = 0.9;
  // Vegetation casts sun shadows only inside the LOD0 rings (the shadow box is +-320 m anyway;
  // farther chunks only added shadow-pass draws down-sun of the view).
  const VEGETATION_SHADOW_RINGS = LOD_RING_LIMITS[0];
  // Shoreline foam fades out with view distance (and with the scene fog) so far coasts never
  // keep a crisp white rim through the haze.
  const FOAM_FADE_NEAR = 350;
  const FOAM_FADE_FAR = 1300;

  const builderConfig = {
    chunkSize: CHUNK_SIZE,
    lodResolutions: LOD_RESOLUTIONS,
    skirtDepths: SKIRT_DEPTHS,
    maxInstances: SCATTER_MAX_INSTANCES,
    headerFloats: SCATTER_HEADER_FLOATS,
    vegetationTypes: VEGETATION_TYPE_COUNT,
  };

  function lodVertexCount(lod) {
    const resolution = LOD_RESOLUTIONS[lod];
    return resolution * resolution * 6 + resolution * 24;
  }

  // ==========================================================================================
  // MATERIALS
  // ==========================================================================================
  const cloudShadowTexture = ctx.textures.cloudShadow;
  /** Cloud cover over this fragment (0..1), faded to 0 at the texture border. */
  const cloudCover = Fn(() => {
    const cloudUv = positionWorld.xz.sub(uniforms.cloudShadowCenter).div(uniforms.cloudShadowWorldSize).add(0.5);
    const cover = texture(cloudShadowTexture, cloudUv).r;
    const edgeDistance = min(min(cloudUv.x, cloudUv.y), min(oneMinus(cloudUv.x), oneMinus(cloudUv.y)));
    return cover.mul(smoothstep(0.0, 0.035, edgeDistance));
  })();
  /** Cloud shadows dim the direct sun term (the shadow node of the shadow-casting sun) by up to 55%... */
  const cloudShadowReceiver = Fn(([shadow]) => shadow.mul(oneMinus(cloudCover.mul(0.55))));
  /** ...and the albedo by up to 10%, so the skylit part under a cloud reads slightly cooler too. */
  const cloudAlbedoDim = oneMinus(cloudCover.mul(0.1));

  const FOAM_WAVE = (Math.PI * 2) / WRAP_PERIOD;
  /** Periodic (4096 m) sum of sines in [-1, 1]: seamless across the wrap. Terms: [kx, kz, speed, weight]. */
  function createPeriodicNoise(terms) {
    return Fn(([point, seconds]) => {
      let total = null;
      for (const [waveX, waveZ, speed, weight] of terms) {
        const term = sin(dot(point, vec2(waveX * FOAM_WAVE, waveZ * FOAM_WAVE)).add(seconds.mul(speed))).mul(weight);
        total = total === null ? term : total.add(term);
      }
      return total;
    });
  }
  // Large-scale variation along the coast (wavelengths ~15-110 m).
  const foamBreakup = createPeriodicNoise([
    [37, 11, 0.31, 0.34], [-19, 53, -0.23, 0.26], [89, 97, 0.47, 0.18], [-151, 64, -0.61, 0.13], [263, -211, 0.83, 0.09],
  ]);
  // Fine lace (wavelengths ~3.5-6 m) that tears the foam into drifting holes and strands.
  const foamLace = createPeriodicNoise([[640, 410, 0.9, 0.4], [-520, 780, -0.7, 0.35], [1130, -290, 1.3, 0.25]]);

  const deepWaterColor = color(0x1a4a60);
  const shallowWaterColor = color(0x5cc6b8);
  const foamColor = color(0xfff6ea);

  // Scene fog range, copied from `scene.fog` each frame (the sky module animates it).
  const foamFogNear = uniform(400);
  const foamFogFar = uniform(2400);

  /**
   * Shoreline foam amount (0..1) where the ground is within ~[-0.4, +1.4] m of the water level:
   * a swash line that surges up the beach and recedes (phase varies along the coast), plus a
   * lacy froth ribbon hugging the mean waterline, both torn by drifting noise.
   * Anti-aliased against the pixel footprint: the metre-scale lace is replaced by its mean once
   * a pixel covers more ground than it can resolve, and every height edge is widened by the
   * height one pixel spans (a box filter), so a band thinner than a pixel turns into a faint soft
   * line rather than dashes along the facets. Distance and fog fade it out entirely.
   */
  const shoreFoam = Fn(() => {
    const seconds = uniforms.time;
    const heightAboveWater = positionWorld.y.sub(uniforms.waterLevel);
    const heightStep = fwidth(heightAboveWater).mul(0.75);
    const groundStep = fwidth(positionWorld.xz).length();
    const wrapped = mod(positionWorld.xz, WRAP_PERIOD);
    const breakup = foamBreakup(wrapped, seconds);
    const laceDetail = oneMinus(smoothstep(0.35, 1.1, groundStep));
    const lace = foamLace(wrapped, seconds).mul(laceDetail).add(breakup.mul(0.3));
    const band = smoothstep(heightStep.negate().sub(0.4), heightStep, heightAboveWater)
      .mul(oneMinus(smoothstep(heightStep.negate().add(1.1), heightStep.add(1.4), heightAboveWater)));
    const surge = sin(seconds.mul(0.85).add(breakup.mul(2.6))).mul(0.5).add(0.5);
    const swashFront = mix(-0.1, 1.05, surge.mul(surge));
    const belowFront = swashFront.sub(heightAboveWater);
    const swash = smoothstep(heightStep.negate().sub(0.02), heightStep.add(0.06), belowFront)
      .mul(oneMinus(smoothstep(0.1, heightStep.add(0.6), belowFront)));
    const swashLace = smoothstep(-0.45, 0.25, lace.add(0.2));
    // The froth ribbon is ~0.8 m of height wide: once a pixel spans more, it dims toward its average.
    const frothCoverage = oneMinus(smoothstep(0.15, 1.6, heightStep).mul(0.7));
    const froth = oneMinus(smoothstep(0.05, heightStep.add(0.42), abs(heightAboveWater.sub(0.14))))
      .mul(smoothstep(-0.55, 0.1, lace))
      .mul(frothCoverage);
    const pulse = sin(seconds.mul(0.7).add(breakup.mul(1.9))).mul(0.15).add(0.85);
    const viewDistance = positionWorld.sub(cameraPosition).length();
    const distanceFade = oneMinus(smoothstep(FOAM_FADE_NEAR, FOAM_FADE_FAR, viewDistance));
    const fogFade = oneMinus(smoothstep(foamFogNear, foamFogFar, viewDistance));
    return saturate(swash.mul(swashLace).add(froth.mul(0.85))).mul(band).mul(pulse).mul(distanceFade).mul(fogFade);
  })();

  /**
   * Underwater look. Seen through the semi-transparent water, flat-shaded seabed facets would read
   * as a harsh stair-step pattern (per-face lighting and palette steps along the depth contours).
   * Below the waterline the face colour is pulled toward a smooth depth colour (turquoise shallows
   * -> deep blue, ~85% by 12 m) and the lighting normal is eased toward straight up, so the seabed
   * shades as one soft gradient. The first ~3 m keep the sandy turquoise lift of the reef flats.
   */
  const seabedDepth = uniforms.waterLevel.sub(positionWorld.y).max(0.0);
  const seabedDepthColor = mix(shallowWaterColor.mul(0.82), deepWaterColor, smoothstep(1.5, 12.0, seabedDepth));
  const seabedFade = oneMinus(exp(seabedDepth.sub(0.8).max(0.0).div(-5.5))).mul(0.95);
  const seabedCalm = smoothstep(0.2, 2.5, seabedDepth).mul(0.92);
  const worldUpView = cameraViewMatrix.transformDirection(vec3(0, 1, 0));
  const terrainNormalNode = normalize(mix(normalView, worldUpView, seabedCalm));

  const terrainColorNode = Fn(() => {
    const base = vertexColor().rgb;
    const heightAboveWater = positionWorld.y.sub(uniforms.waterLevel);
    const depth = seabedDepth;
    const wetSand = oneMinus(smoothstep(0.15, 1.6, heightAboveWater)).mul(smoothstep(-0.3, 0.0, heightAboveWater));
    const dried = base.mul(oneMinus(wetSand.mul(0.34)));
    const shallowLift = smoothstep(0.0, 0.35, depth).mul(oneMinus(smoothstep(1.1, 3.0, depth)));
    const lifted = mix(dried, shallowWaterColor.mul(dried.add(0.35)), shallowLift.mul(0.55));
    const submerged = mix(lifted, seabedDepthColor, seabedFade);
    return vec4(mix(submerged, foamColor, shoreFoam.mul(0.94)).mul(cloudAlbedoDim), 1.0);
  })();
  // Foam catches a little light of its own so it still reads on coasts facing away from the sun.
  const terrainEmissiveNode = foamColor.mul(shoreFoam).mul(oneMinus(uniforms.nightFactor.mul(0.75)).mul(0.2));

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  material.colorNode = terrainColorNode;
  material.normalNode = terrainNormalNode;
  material.emissiveNode = terrainEmissiveNode;
  material.receivedShadowNode = cloudShadowReceiver;
  material.name = 'terrain';

  // LOD cross-fade: while a chunk swaps LOD, the outgoing and incoming meshes both draw with this
  // variant and discard complementary halves of a screen-space dither (interleaved gradient noise),
  // so every pixel shows exactly one of them and the swap dissolves instead of popping.
  const lodFadeOpacity = uniform(1).onObjectUpdate(({ object }) => object.userData.fadeOpacity);
  const lodFadeFlip = uniform(0).onObjectUpdate(({ object }) => object.userData.fadeFlip);
  const lodFadeThreshold = Fn(() => {
    const pixel = floor(screenCoordinate.xy);
    const noise = fract(fract(dot(pixel, vec2(0.06711056, 0.00583715))).mul(52.9829189));
    return mix(noise, oneMinus(noise), lodFadeFlip);
  })();
  const fadeMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  fadeMaterial.colorNode = terrainColorNode;
  fadeMaterial.normalNode = terrainNormalNode;
  fadeMaterial.emissiveNode = terrainEmissiveNode;
  fadeMaterial.receivedShadowNode = cloudShadowReceiver;
  fadeMaterial.opacityNode = lodFadeOpacity;
  fadeMaterial.alphaTestNode = lodFadeThreshold;
  fadeMaterial.name = 'terrain-lod-fade';

  // Vegetation is GPU-instanced through per-instance geometry attributes (placement, scale, tint)
  // on pooled per-chunk meshes: every mesh of a type then shares ONE node build. (An InstancedMesh
  // puts its uuid into the render-object cache key, so each pooled InstancedMesh would compile its
  // own material on first sight: measured 7-10 ms per mesh, i.e. streaming hitches.)
  // Vertex colour alpha marks the tintable parts (foliage, petals, rock).
  const vegetationColorNode = Fn(() => {
    const vertex = vertexColor();
    const instanceTint = attribute('vegetationTint', 'vec3');
    return vec4(vertex.rgb.mul(mix(vec3(1.0), instanceTint, vertex.a)).mul(cloudAlbedoDim), 1.0);
  })();
  const vegetationFadeRadius = uniform(600);
  const flowerFadeRadius = uniform(460);
  const vegetationFadeBand = uniform(220);
  // Streaming focus (the player, or the free camera in photo mode): vegetation fades around it.
  const vegetationFocus = uniform(new THREE.Vector3());
  // Seconds on the terrain's own wall clock (keeps running in photo mode) for the grow-in.
  let terrainClock = 0;
  // Per chunk mesh: 0 -> 1 over VEGETATION_GROW_SECONDS after its scatter first appears, so
  // vegetation that arrives near the viewer (boot, teleport, late jobs) grows in instead of popping.
  const vegetationGrowth = uniform(1).onObjectUpdate(({ object }) => {
    return clamp((terrainClock - object.userData.bornAt) / VEGETATION_GROW_SECONDS, 0, 1);
  });

  function createVegetationPositionNode(swayStrength, fadeRadius) {
    return Fn(() => {
      const placement = attribute('vegetationPlacement', 'vec4');
      const stretch = attribute('vegetationScale', 'vec3');
      const baseWorld = modelWorldMatrix.mul(vec4(placement.xyz, 1.0)).xyz;
      const distanceToFocus = baseWorld.sub(vegetationFocus).length();
      const distanceGrow = oneMinus(smoothstep(fadeRadius.sub(vegetationFadeBand), fadeRadius, distanceToFocus));
      const timeGrow = smoothstep(0.0, 1.0, vegetationGrowth);
      const grow = min(distanceGrow, timeGrow);
      const shape = positionGeometry.mul(stretch).mul(grow.mul(0.4).add(0.6));
      const cosine = cos(placement.w);
      const sine = sin(placement.w);
      const rotated = vec3(
        cosine.mul(shape.x).add(sine.mul(shape.z)),
        shape.y,
        sine.negate().mul(shape.x).add(cosine.mul(shape.z)),
      );
      const local = rotated.add(placement.xyz).toVar();
      const heightInModel = positionGeometry.y.max(0.0);
      const sunk = local.sub(vec3(0.0, heightInModel.mul(stretch.y).mul(1.15).mul(oneMinus(grow)), 0.0));
      if (swayStrength <= 0) return sunk;
      const wrapped = mod(baseWorld.xz, WRAP_PERIOD);
      const phase = uniforms.time.mul(1.25).add(wrapped.x.mul(0.043)).add(wrapped.y.mul(0.037));
      const gust = sin(phase).mul(0.7).add(sin(phase.mul(2.3).add(1.7)).mul(0.3)).add(0.55);
      const sway = gust.mul(heightInModel.mul(heightInModel)).mul(swayStrength).mul(uniforms.windStrength);
      return sunk.add(vec3(uniforms.windDirection.x.mul(sway), 0.0, uniforms.windDirection.y.mul(sway)));
    })();
  }

  const VEGETATION_LOOK = [
    { roughness: 0.9, sway: 0.0016, doubleSided: false },
    { roughness: 0.85, sway: 0.0024, doubleSided: false },
    { roughness: 0.8, sway: 0.0035, doubleSided: true },
    { roughness: 0.95, sway: 0, doubleSided: false },
    { roughness: 0.75, sway: 0, doubleSided: false },
    { roughness: 0.8, sway: 0.03, doubleSided: false },
  ];
  const vegetationMaterials = VEGETATION_LOOK.map((look, type) => {
    const vegetationMaterial = new THREE.MeshStandardNodeMaterial({
      roughness: look.roughness,
      metalness: 0,
      flatShading: true,
      side: look.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (look.doubleSided) vegetationMaterial.shadowSide = THREE.DoubleSide;
    vegetationMaterial.colorNode = vegetationColorNode;
    vegetationMaterial.positionNode = createVegetationPositionNode(
      look.sway,
      type === VEGETATION.FLOWERS ? flowerFadeRadius : vegetationFadeRadius,
    );
    vegetationMaterial.receivedShadowNode = cloudShadowReceiver;
    vegetationMaterial.name = `vegetation-${type}`;
    return vegetationMaterial;
  });

  // ==========================================================================================
  // VEGETATION GEOMETRY (built once, flat-shaded, colour alpha = tint mask)
  // ==========================================================================================
  function pseudoRandom(seed) {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  }
  function linearColor(hex) {
    const converted = new THREE.Color(hex);
    return [converted.r, converted.g, converted.b];
  }
  function addVectors(first, second) { return [first[0] + second[0], first[1] + second[1], first[2] + second[2]]; }
  function scaleVector(vector, factor) { return [vector[0] * factor, vector[1] * factor, vector[2] * factor]; }
  function crossVectors(first, second) {
    return [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ];
  }
  function normalizeVector(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  function createShapeBuilder() {
    const positions = [];
    const colors = [];
    function pushVertex(point, rgb, shade, mask) {
      positions.push(point[0], point[1], point[2]);
      colors.push(Math.min(1, rgb[0] * shade), Math.min(1, rgb[1] * shade), Math.min(1, rgb[2] * shade), mask);
    }
    return {
      /** Adds a triangle wound so its normal agrees with the hint direction. */
      triangle(first, second, third, rgb, shades, mask, hint) {
        const normal = crossVectors(
          [second[0] - first[0], second[1] - first[1], second[2] - first[2]],
          [third[0] - first[0], third[1] - first[1], third[2] - first[2]],
        );
        const agrees = normal[0] * hint[0] + normal[1] * hint[1] + normal[2] * hint[2] >= 0;
        pushVertex(first, rgb, shades[0], mask);
        if (agrees) {
          pushVertex(second, rgb, shades[1], mask);
          pushVertex(third, rgb, shades[2], mask);
        } else {
          pushVertex(third, rgb, shades[2], mask);
          pushVertex(second, rgb, shades[1], mask);
        }
      },
      toGeometry() {
        const count = positions.length / 3;
        const positionArray = new Float32Array(positions);
        const normalArray = new Float32Array(count * 3);
        for (let vertex = 0; vertex < count; vertex += 3) {
          const offset = vertex * 3;
          const normal = normalizeVector(crossVectors(
            [positionArray[offset + 3] - positionArray[offset], positionArray[offset + 4] - positionArray[offset + 1], positionArray[offset + 5] - positionArray[offset + 2]],
            [positionArray[offset + 6] - positionArray[offset], positionArray[offset + 7] - positionArray[offset + 1], positionArray[offset + 8] - positionArray[offset + 2]],
          ));
          for (let corner = 0; corner < 3; corner++) normalArray.set(normal, offset + corner * 3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 4));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return geometry;
      },
    };
  }

  function addFrustum(shape, options) {
    const { start, end, radiusStart, radiusEnd, sides, rgb, shadeStart, shadeEnd, mask } = options;
    const rotation = options.rotation ?? 0;
    const ribShade = options.ribShade ?? 0;
    const axis = normalizeVector([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
    const reference = Math.abs(axis[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const across = normalizeVector(crossVectors(axis, reference));
    const around = crossVectors(axis, across);
    const directions = [];
    for (let side = 0; side < sides; side++) {
      const angle = rotation + (side / sides) * Math.PI * 2;
      directions.push(addVectors(scaleVector(across, Math.cos(angle)), scaleVector(around, Math.sin(angle))));
    }
    const ringStart = directions.map((direction) => addVectors(start, scaleVector(direction, radiusStart)));
    const ringEnd = directions.map((direction) => addVectors(end, scaleVector(direction, radiusEnd)));
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const hint = addVectors(directions[side], directions[next]);
      const rib = ribShade > 0 && side % 2 === 1 ? 1 - ribShade : 1;
      shape.triangle(ringStart[side], ringStart[next], ringEnd[next], rgb, [shadeStart * rib, shadeStart * rib, shadeEnd * rib], mask, hint);
      shape.triangle(ringStart[side], ringEnd[next], ringEnd[side], rgb, [shadeStart * rib, shadeEnd * rib, shadeEnd * rib], mask, hint);
    }
    if (options.capHeight > 0) {
      const tip = addVectors(end, scaleVector(axis, options.capHeight));
      for (let side = 0; side < sides; side++) {
        const next = (side + 1) % sides;
        const hint = addVectors(axis, scaleVector(addVectors(directions[side], directions[next]), 0.5));
        const rib = ribShade > 0 && side % 2 === 1 ? 1 - ribShade : 1;
        shape.triangle(ringEnd[side], ringEnd[next], tip, rgb, [shadeEnd * rib, shadeEnd * rib, shadeEnd * 1.05], mask, hint);
      }
    }
  }

  function addCone(shape, options) {
    const { baseY, apexY, radius, sides, rotation, jitter, seed, rgb, baseShade, apexShade, mask, undersideShade } = options;
    const ring = [];
    for (let side = 0; side < sides; side++) {
      const angle = rotation + (side / sides) * Math.PI * 2;
      const wobble = 1 + (pseudoRandom(seed + side * 7.3) - 0.5) * 2 * jitter;
      const droop = (pseudoRandom(seed + side * 3.1 + 11) - 0.5) * 0.6;
      ring.push([Math.cos(angle) * radius * wobble, baseY + droop, Math.sin(angle) * radius * wobble]);
    }
    const apex = [(pseudoRandom(seed + 91) - 0.5) * 0.24, apexY, (pseudoRandom(seed + 57) - 0.5) * 0.24];
    for (let side = 0; side < sides; side++) {
      const current = ring[side];
      const next = ring[(side + 1) % sides];
      const hint = [current[0] + next[0], radius * 0.4, current[2] + next[2]];
      shape.triangle(current, next, apex, rgb, [baseShade, baseShade, apexShade], mask, hint);
    }
    if (undersideShade > 0) {
      const center = [0, baseY + 0.9, 0];
      for (let side = 0; side < sides; side++) {
        shape.triangle(ring[side], ring[(side + 1) % sides], center, rgb, [undersideShade, undersideShade, undersideShade * 0.8], mask, [0, -1, 0]);
      }
    }
  }

  const polyhedronSources = {
    icosahedron: new THREE.IcosahedronGeometry(1, 0),
    dodecahedron: new THREE.DodecahedronGeometry(1, 0),
    octahedron: new THREE.OctahedronGeometry(1, 0),
  };
  const polyhedronPositions = {};
  for (const [name, source] of Object.entries(polyhedronSources)) {
    polyhedronPositions[name] = Array.from(source.getAttribute('position').array);
    source.dispose();
  }

  function addBlob(shape, options) {
    const { center, radius, jitter, seed, rgb, bottomShade, topShade, mask } = options;
    const squash = options.squash ?? 1;
    const source = polyhedronPositions[options.base ?? 'icosahedron'];
    const wobbleCache = new Map();
    const wobbleFor = (x, y, z) => {
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
      let wobble = wobbleCache.get(key);
      if (wobble === undefined) {
        wobble = 1 + (pseudoRandom(seed + wobbleCache.size * 13.37 + x * 3.1 + y * 5.7 + z * 2.3) - 0.5) * 2 * jitter;
        wobbleCache.set(key, wobble);
      }
      return wobble;
    };
    for (let offset = 0; offset < source.length; offset += 9) {
      const corners = [];
      const shades = [];
      for (let corner = 0; corner < 3; corner++) {
        const x = source[offset + corner * 3];
        const y = source[offset + corner * 3 + 1];
        const z = source[offset + corner * 3 + 2];
        const wobble = wobbleFor(x, y, z);
        corners.push([center[0] + x * radius * wobble, center[1] + y * radius * squash * wobble, center[2] + z * radius * wobble]);
        shades.push(bottomShade + (topShade - bottomShade) * (y * 0.5 + 0.5));
      }
      const centroid = scaleVector(addVectors(addVectors(corners[0], corners[1]), corners[2]), 1 / 3);
      shape.triangle(corners[0], corners[1], corners[2], rgb, shades, mask, [centroid[0] - center[0], centroid[1] - center[1], centroid[2] - center[2]]);
    }
  }

  function addFrond(shape, options) {
    const { origin, angle, length, lift, droop, width, segments, rgb, mask } = options;
    const directionX = Math.cos(angle);
    const directionZ = Math.sin(angle);
    const sideX = -directionZ;
    const sideZ = directionX;
    const mids = [];
    const lefts = [];
    const rights = [];
    const widths = [];
    for (let index = 0; index <= segments; index++) {
      const along = (length * index) / segments;
      const mid = [origin[0] + directionX * along, origin[1] + lift * along - droop * along * along, origin[2] + directionZ * along];
      const halfWidth = width * Math.pow(Math.sin((Math.PI * index) / segments), 0.65);
      const fold = halfWidth * 0.45;
      mids.push(mid);
      widths.push(halfWidth);
      lefts.push([mid[0] + sideX * halfWidth, mid[1] - fold, mid[2] + sideZ * halfWidth]);
      rights.push([mid[0] - sideX * halfWidth, mid[1] - fold, mid[2] - sideZ * halfWidth]);
    }
    const up = [0, 1, 0];
    for (let index = 0; index < segments; index++) {
      const shadeNear = 0.62 + 0.38 * (index / segments);
      const shadeFar = 0.62 + 0.38 * ((index + 1) / segments);
      for (const edges of [lefts, rights]) {
        if (widths[index + 1] > 1e-4) {
          shape.triangle(mids[index], mids[index + 1], edges[index + 1], rgb, [shadeNear, shadeFar, shadeFar * 0.92], mask, up);
        }
        if (widths[index] > 1e-4) {
          const far = widths[index + 1] > 1e-4 ? edges[index + 1] : mids[index + 1];
          shape.triangle(mids[index], far, edges[index], rgb, [shadeNear, shadeFar * 0.92, shadeNear * 0.92], mask, up);
        }
      }
    }
  }

  const WHITE = [1, 1, 1];

  function buildPineGeometry() {
    const shape = createShapeBuilder();
    addFrustum(shape, {
      start: [0, -1.6, 0], end: [0, 3.0, 0], radiusStart: 0.42, radiusEnd: 0.24, sides: 5,
      rgb: linearColor(0x6a4a34), shadeStart: 0.7, shadeEnd: 1, mask: 0,
    });
    const tiers = [
      { baseY: 1.9, apexY: 7.2, radius: 3.1, shade: 0.6 },
      { baseY: 4.5, apexY: 9.6, radius: 2.45, shade: 0.68 },
      { baseY: 7.0, apexY: 12.1, radius: 1.7, shade: 0.76 },
    ];
    tiers.forEach((tier, index) => {
      addCone(shape, {
        baseY: tier.baseY, apexY: tier.apexY, radius: tier.radius, sides: 7, rotation: index * 0.55,
        jitter: 0.12, seed: index * 17 + 3, rgb: WHITE, baseShade: tier.shade, apexShade: 1, mask: 1,
        undersideShade: index === 0 ? 0.42 : 0,
      });
    });
    return shape.toGeometry();
  }

  function buildBroadleafGeometry() {
    const shape = createShapeBuilder();
    const bark = linearColor(0x6e5039);
    addFrustum(shape, {
      start: [0, -1.6, 0], end: [0.12, 3.9, 0.06], radiusStart: 0.44, radiusEnd: 0.28, sides: 5, rgb: bark,
      shadeStart: 0.68, shadeEnd: 1, mask: 0,
    });
    addFrustum(shape, {
      start: [0.1, 3.3, 0.05], end: [1.25, 5.0, 0.7], radiusStart: 0.2, radiusEnd: 0.1, sides: 4, rgb: bark,
      shadeStart: 0.9, shadeEnd: 1, mask: 0,
    });
    addFrustum(shape, {
      start: [0.1, 3.6, 0.05], end: [-1.05, 5.2, -0.75], radiusStart: 0.18, radiusEnd: 0.09, sides: 4,
      rgb: bark, shadeStart: 0.9, shadeEnd: 1, mask: 0,
    });
    const blobs = [
      [0.1, 6.4, 0, 2.8],
      [1.55, 5.6, 0.95, 2.0],
      [-1.35, 5.8, -0.95, 2.15],
      [0.35, 7.9, -0.35, 1.75],
    ];
    blobs.forEach(([x, y, z, radius], index) => {
      addBlob(shape, {
        center: [x, y, z], radius, squash: 0.86, jitter: 0.14, seed: 40 + index * 9,
        rgb: WHITE, bottomShade: 0.52, topShade: 1, mask: 1,
      });
    });
    return shape.toGeometry();
  }

  function buildPalmGeometry() {
    const shape = createShapeBuilder();
    const trunkLight = linearColor(0x8c6c4a);
    const trunkDark = linearColor(0x6c5036);
    const segments = 6;
    const trunkPoint = (t) => [2.0 * t * t, -1.4 + 11.0 * t, 0];
    for (let segment = 0; segment < segments; segment++) {
      const t0 = segment / segments;
      const t1 = (segment + 1) / segments;
      addFrustum(shape, {
        start: trunkPoint(t0), end: trunkPoint(t1), radiusStart: 0.36 - 0.13 * t0, radiusEnd: (0.36 - 0.13 * t1) * 0.9,
        sides: 5, rgb: segment % 2 === 0 ? trunkLight : trunkDark, shadeStart: 0.78, shadeEnd: 1, mask: 0, rotation: segment * 0.4,
      });
    }
    const top = trunkPoint(1);
    addBlob(shape, {
      center: [top[0], top[1] + 0.1, top[2]], radius: 0.55, squash: 0.8, jitter: 0.1, seed: 5, rgb: WHITE,
      bottomShade: 0.45, topShade: 0.75, mask: 1,
    });
    const frondCount = 7;
    for (let frond = 0; frond < frondCount; frond++) {
      addFrond(shape, {
        origin: [top[0], top[1] + 0.2, top[2]],
        angle: (frond / frondCount) * Math.PI * 2 + (pseudoRandom(frond + 3) - 0.5) * 0.35,
        length: 4.3 + pseudoRandom(frond + 19) * 0.9,
        lift: 0.85,
        droop: 0.3 + pseudoRandom(frond + 7) * 0.06,
        width: 0.72,
        segments: 4,
        rgb: WHITE,
        mask: 1,
      });
    }
    const coconut = linearColor(0x5b3d24);
    for (let nut = 0; nut < 3; nut++) {
      const angle = nut * 2.1 + 0.4;
      addBlob(shape, {
        center: [top[0] + Math.cos(angle) * 0.38, top[1] - 0.42, top[2] + Math.sin(angle) * 0.38],
        radius: 0.26, jitter: 0.05, seed: 70 + nut, rgb: coconut, bottomShade: 0.7, topShade: 1, mask: 0, base: 'octahedron',
      });
    }
    return shape.toGeometry();
  }

  function buildRockGeometry() {
    const shape = createShapeBuilder();
    addBlob(shape, {
      center: [0, 0.35, 0], radius: 1.5, squash: 0.72, jitter: 0.16, seed: 11, rgb: WHITE, bottomShade: 0.55,
      topShade: 1, mask: 1, base: 'dodecahedron',
    });
    addBlob(shape, {
      center: [1.35, 0.05, 0.7], radius: 0.62, squash: 0.75, jitter: 0.18, seed: 29, rgb: WHITE,
      bottomShade: 0.55, topShade: 0.95, mask: 1,
    });
    return shape.toGeometry();
  }

  function buildCactusGeometry() {
    const shape = createShapeBuilder();
    const rib = 0.16;
    addFrustum(shape, {
      start: [0, -1.4, 0], end: [0, 5.3, 0], radiusStart: 0.56, radiusEnd: 0.5, sides: 8,
      rgb: WHITE, shadeStart: 0.74, shadeEnd: 1, mask: 1, ribShade: rib, capHeight: 0.55,
    });
    addFrustum(shape, {
      start: [0.3, 2.3, 0], end: [1.3, 2.36, 0], radiusStart: 0.32, radiusEnd: 0.3, sides: 6, rgb: WHITE,
      shadeStart: 0.85, shadeEnd: 0.9, mask: 1, ribShade: rib,
    });
    addFrustum(shape, {
      start: [1.3, 2.05, 0], end: [1.3, 4.4, 0], radiusStart: 0.3, radiusEnd: 0.27, sides: 6, rgb: WHITE,
      shadeStart: 0.82, shadeEnd: 1, mask: 1, ribShade: rib, capHeight: 0.34,
    });
    const armAngle = 3.55;
    const armX = Math.cos(armAngle);
    const armZ = Math.sin(armAngle);
    addFrustum(shape, {
      start: [armX * 0.3, 3.1, armZ * 0.3], end: [armX * 1.05, 3.15, armZ * 1.05], radiusStart: 0.29,
      radiusEnd: 0.27, sides: 6, rgb: WHITE, shadeStart: 0.85, shadeEnd: 0.9, mask: 1, ribShade: rib,
    });
    addFrustum(shape, {
      start: [armX * 1.05, 2.86, armZ * 1.05], end: [armX * 1.05, 4.75, armZ * 1.05], radiusStart: 0.27,
      radiusEnd: 0.24, sides: 6, rgb: WHITE, shadeStart: 0.82, shadeEnd: 1, mask: 1, ribShade: rib,
      capHeight: 0.3,
    });
    const blossom = linearColor(0xf2a0b8);
    for (let petal = 0; petal < 3; petal++) {
      const angle = petal * 2.09;
      addBlob(shape, {
        center: [Math.cos(angle) * 0.2, 5.78, Math.sin(angle) * 0.2], radius: 0.14, jitter: 0.05, seed: 90 + petal,
        rgb: blossom, bottomShade: 0.85, topShade: 1, mask: 0, base: 'octahedron',
      });
    }
    return shape.toGeometry();
  }

  function buildFlowerGeometry() {
    const shape = createShapeBuilder();
    const leaf = linearColor(0x5a8a3e);
    const bushes = [[0, 0.32, 0, 0.72], [0.72, 0.22, 0.38, 0.52], [-0.58, 0.25, -0.46, 0.56]];
    bushes.forEach(([x, y, z, radius], index) => {
      addBlob(shape, {
        center: [x, y, z], radius, squash: 0.72, jitter: 0.15, seed: 120 + index * 5, rgb: leaf,
        bottomShade: 0.55, topShade: 1, mask: 0,
      });
    });
    const petals = [[0.05, 0.84, 0.12], [-0.32, 0.78, -0.2], [0.36, 0.76, -0.2], [0.8, 0.56, 0.46], [-0.62, 0.62, -0.52], [0.62, 0.52, 0.12]];
    petals.forEach(([x, y, z], index) => {
      addBlob(shape, {
        center: [x, y, z], radius: 0.2, squash: 0.7, jitter: 0.08, seed: 150 + index, rgb: WHITE,
        bottomShade: 0.82, topShade: 1, mask: 1, base: 'octahedron',
      });
    });
    return shape.toGeometry();
  }

  const vegetationGeometries = [];
  vegetationGeometries[VEGETATION.PINE] = buildPineGeometry();
  vegetationGeometries[VEGETATION.BROADLEAF] = buildBroadleafGeometry();
  vegetationGeometries[VEGETATION.PALM] = buildPalmGeometry();
  vegetationGeometries[VEGETATION.ROCK] = buildRockGeometry();
  vegetationGeometries[VEGETATION.CACTUS] = buildCactusGeometry();
  vegetationGeometries[VEGETATION.FLOWERS] = buildFlowerGeometry();
  const vegetationExtents = vegetationGeometries.map((geometry) => {
    const box = geometry.boundingBox;
    return {
      top: box.max.y,
      bottom: box.min.y,
      radius: Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)),
    };
  });

  // ==========================================================================================
  // SCENE GRAPH + POOLS
  // ==========================================================================================
  const group = new THREE.Group();
  group.name = 'terrain';
  scene.add(group);

  const meshPools = Array.from({ length: LOD_COUNT }, () => []);
  const meshTotals = new Array(LOD_COUNT).fill(0);
  const vegetationPools = Array.from({ length: VEGETATION_TYPE_COUNT }, () => []);
  const vegetationTotals = new Array(VEGETATION_TYPE_COUNT).fill(0);
  const bufferPools = Array.from({ length: LOD_COUNT }, () => ({ position: [], normal: [], color: [] }));
  const scatterBufferPool = [];

  function createChunkMesh(lod) {
    const floats = lodVertexCount(lod) * 3;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(floats), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(floats), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(floats), 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK_SIZE / 2, 0, CHUNK_SIZE / 2), CHUNK_SIZE);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `terrain-lod${lod}`;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = lod <= 1;
    mesh.visible = false;
    mesh.userData.terrainLod = lod;
    mesh.userData.fadeOpacity = 1;
    mesh.userData.fadeFlip = 0;
    group.add(mesh);
    meshTotals[lod]++;
    return mesh;
  }
  function acquireChunkMesh(lod) {
    return meshPools[lod].pop() || createChunkMesh(lod);
  }
  function releaseChunkMesh(mesh) {
    mesh.visible = false;
    mesh.material = material;
    mesh.userData.fadeOpacity = 1;
    meshPools[mesh.userData.terrainLod].push(mesh);
  }

  /** Pooled per-chunk instanced mesh: shared base attributes + fixed-capacity instance attributes. */
  function createVegetationMesh(type) {
    const base = vegetationGeometries[type];
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('normal', base.getAttribute('normal'));
    geometry.setAttribute('color', base.getAttribute('color'));
    geometry.setAttribute('vegetationPlacement', new THREE.InstancedBufferAttribute(new Float32Array(SCATTER_MAX_INSTANCES * 4), 4));
    geometry.setAttribute('vegetationScale', new THREE.InstancedBufferAttribute(new Float32Array(SCATTER_MAX_INSTANCES * 3), 3));
    geometry.setAttribute('vegetationTint', new THREE.InstancedBufferAttribute(new Float32Array(SCATTER_MAX_INSTANCES * 3).fill(1), 3));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK_SIZE / 2, 0, CHUNK_SIZE / 2), CHUNK_SIZE);
    const mesh = new THREE.Mesh(geometry, vegetationMaterials[type]);
    mesh.name = `vegetation-${type}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = type !== VEGETATION.FLOWERS;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.userData.vegetationType = type;
    mesh.userData.bornAt = -1e9;
    group.add(mesh);
    vegetationTotals[type]++;
    return mesh;
  }

  // ==========================================================================================
  // STREAMING STATE
  // ==========================================================================================
  const chunks = new Map();
  const chunkRecordPool = [];
  const queue = [];
  let queueHead = 0;
  const jobPool = [];
  const readyResults = [];
  let planStamp = 0;
  let queueDirty = true;
  let qualityDirty = true;
  let replanTimer = 0;
  let vegetationInstances = 0;
  let buildMsAverage = 0;
  let buildSamples = 0;
  let newVegetationMeshesThisFrame = 0;
  let uploadBytesThisFrame = 0;
  const createdAtMs = performance.now();
  let firstReadyAtMs = -1;

  const playerCenter = { cx: 0, cz: 0, valid: false };
  const lookCenter = { cx: 0, cz: 0, valid: false };
  const focus = { x: 0, z: 0, dirX: 0, dirZ: 0 };
  const smoothedVelocity = new THREE.Vector3();
  const lastFocus = new THREE.Vector3(NaN, 0, NaN);
  const settingsView = { viewRings: 8, vegetationRings: 2, vegetationDensity: 1 };

  function chunkKey(chunkX, chunkZ) {
    return (chunkX + 32768) * 65536 + (chunkZ + 32768);
  }
  function lodForRing(ring) {
    for (let lod = 0; lod < LOD_RING_LIMITS.length; lod++) if (ring <= LOD_RING_LIMITS[lod]) return lod;
    return LOD_COUNT - 1;
  }
  function acquireChunkRecord(chunkX, chunkZ, key) {
    const record = chunkRecordPool.pop() || {
      key: 0, cx: 0, cz: 0, ring: 0, desiredLod: 0, displayedLod: -1, mesh: null, inflightMask: 0, stamp: 0,
      wantsVegetation: false, vegetationDensity: -1, vegetationInflight: false, vegetationMeshes: [],
      vegetationShown: false, fadeMesh: null, fadeProgress: 0,
    };
    record.key = key;
    record.cx = chunkX;
    record.cz = chunkZ;
    record.ring = 0;
    record.desiredLod = 0;
    record.displayedLod = -1;
    record.mesh = null;
    record.inflightMask = 0;
    record.stamp = 0;
    record.wantsVegetation = false;
    record.vegetationDensity = -1;
    record.vegetationInflight = false;
    record.vegetationMeshes.length = 0;
    record.vegetationShown = false;
    record.fadeMesh = null;
    record.fadeProgress = 0;
    return record;
  }
  function acquireJob(chunk, kind, lod) {
    const job = jobPool.pop() || { chunk: null, kind: 0, lod: 0, priority: 0 };
    job.chunk = chunk;
    job.kind = kind;
    job.lod = lod;
    job.priority = 0;
    return job;
  }
  function releaseJob(job) {
    job.chunk = null;
    jobPool.push(job);
  }
  const compareJobs = (first, second) => first.priority - second.priority;

  function readQuality() {
    const quality = ctx.quality || {};
    settingsView.viewRings = clamp(Math.round(quality.viewRings || 8), 2, 16);
    settingsView.vegetationRings = clamp(Math.round(quality.vegetationRings ?? 2), 0, 4);
    settingsView.vegetationDensity = clamp(Number(quality.vegetationDensity ?? 1), 0, 1);
    const vegetationReach = Math.max(120, settingsView.vegetationRings * CHUNK_SIZE - 48);
    vegetationFadeRadius.value = vegetationReach;
    flowerFadeRadius.value = Math.min(vegetationReach, FLOWER_RINGS * CHUNK_SIZE - 48);
    vegetationFadeBand.value = Math.min(220, vegetationReach * 0.45);
  }

  function computePriority(chunk, kind, lod) {
    const offsetX = (chunk.cx + 0.5) * CHUNK_SIZE - focus.x;
    const offsetZ = (chunk.cz + 0.5) * CHUNK_SIZE - focus.z;
    const distanceMetres = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
    const distance = distanceMetres / CHUNK_SIZE;
    const ahead = distanceMetres > 1 ? (offsetX * focus.dirX + offsetZ * focus.dirZ) / distanceMetres : 0;
    let priority = distance - ahead * 0.9;
    if (kind === JOB_MESH) {
      if (lod === 0) priority -= 1000;
      else if (chunk.displayedLod < 0) priority -= 500;
    } else {
      priority += chunk.ring <= 1 ? -400 : 1.5;
    }
    return priority;
  }

  // ---- Focus + ring centres (hysteresis) --------------------------------------------------------
  function updateCenter(center, x, z) {
    const minX = center.cx * CHUNK_SIZE - CENTER_HYSTERESIS;
    const maxX = (center.cx + 1) * CHUNK_SIZE + CENTER_HYSTERESIS;
    const minZ = center.cz * CHUNK_SIZE - CENTER_HYSTERESIS;
    const maxZ = (center.cz + 1) * CHUNK_SIZE + CENTER_HYSTERESIS;
    if (center.valid && x >= minX && x <= maxX && z >= minZ && z <= maxZ) return false;
    const nextX = Math.floor(x / CHUNK_SIZE);
    const nextZ = Math.floor(z / CHUNK_SIZE);
    const changed = !center.valid || nextX !== center.cx || nextZ !== center.cz;
    center.cx = nextX;
    center.cz = nextZ;
    center.valid = true;
    return changed;
  }

  function updateFocus(dt, realDt) {
    const source = state.photoMode ? camera.position : state.player.position;
    const velocity = state.player.velocity;
    const jumped = !Number.isFinite(lastFocus.x) || Math.hypot(source.x - lastFocus.x, source.z - lastFocus.z) > TELEPORT_DISTANCE;
    if (state.photoMode || !(dt > 0)) {
      smoothedVelocity.multiplyScalar(Math.max(0, 1 - realDt * LOOKAHEAD_SMOOTHING));
    } else if (jumped) {
      smoothedVelocity.set(velocity.x, 0, velocity.z);
    } else {
      const blend = 1 - Math.exp(-LOOKAHEAD_SMOOTHING * realDt);
      smoothedVelocity.x += (velocity.x - smoothedVelocity.x) * blend;
      smoothedVelocity.z += (velocity.z - smoothedVelocity.z) * blend;
    }
    if (!Number.isFinite(smoothedVelocity.x) || !Number.isFinite(smoothedVelocity.z)) smoothedVelocity.set(0, 0, 0);
    lastFocus.copy(source);
    vegetationFocus.value.copy(source);
    focus.x = source.x + smoothedVelocity.x * LOOKAHEAD_SECONDS;
    focus.z = source.z + smoothedVelocity.z * LOOKAHEAD_SECONDS;
    const speed = Math.hypot(smoothedVelocity.x, smoothedVelocity.z);
    focus.dirX = speed > 1 ? smoothedVelocity.x / speed : 0;
    focus.dirZ = speed > 1 ? smoothedVelocity.z / speed : 0;
    const playerMoved = updateCenter(playerCenter, source.x, source.z);
    const lookMoved = updateCenter(lookCenter, focus.x, focus.z);
    return playerMoved || lookMoved || jumped;
  }

  // ---- Planning -------------------------------------------------------------------------------------
  function plan() {
    planStamp++;
    const viewRings = settingsView.viewRings;
    const vegetationRings = settingsView.vegetationRings;
    const minX = Math.min(playerCenter.cx, lookCenter.cx) - viewRings;
    const maxX = Math.max(playerCenter.cx, lookCenter.cx) + viewRings;
    const minZ = Math.min(playerCenter.cz, lookCenter.cz) - viewRings;
    const maxZ = Math.max(playerCenter.cz, lookCenter.cz) + viewRings;
    for (let chunkZ = minZ; chunkZ <= maxZ; chunkZ++) {
      for (let chunkX = minX; chunkX <= maxX; chunkX++) {
        const ring = Math.min(
          Math.max(Math.abs(chunkX - playerCenter.cx), Math.abs(chunkZ - playerCenter.cz)),
          Math.max(Math.abs(chunkX - lookCenter.cx), Math.abs(chunkZ - lookCenter.cz)),
        );
        if (ring > viewRings) continue;
        const key = chunkKey(chunkX, chunkZ);
        let chunk = chunks.get(key);
        if (chunk === undefined) {
          chunk = acquireChunkRecord(chunkX, chunkZ, key);
          chunks.set(key, chunk);
        }
        chunk.ring = ring;
        chunk.desiredLod = lodForRing(ring);
        chunk.wantsVegetation = ring <= vegetationRings && settingsView.vegetationDensity > 0;
        chunk.stamp = planStamp;
      }
    }
    for (const chunk of chunks.values()) {
      if (chunk.stamp !== planStamp) {
        removeChunk(chunk);
        continue;
      }
      if (!chunk.wantsVegetation && chunk.vegetationMeshes.length > 0) releaseVegetation(chunk);
      refreshVegetationVisibility(chunk);
    }
    rebuildQueue();
  }

  function rebuildQueue() {
    for (let index = queueHead; index < queue.length; index++) releaseJob(queue[index]);
    queue.length = 0;
    queueHead = 0;
    const density = settingsView.vegetationDensity;
    for (const chunk of chunks.values()) {
      if (chunk.displayedLod !== chunk.desiredLod && (chunk.inflightMask & (1 << chunk.desiredLod)) === 0) {
        queue.push(acquireJob(chunk, JOB_MESH, chunk.desiredLod));
      }
      if (chunk.wantsVegetation && chunk.vegetationDensity !== density && !chunk.vegetationInflight) {
        queue.push(acquireJob(chunk, JOB_SCATTER, 0));
      }
    }
    for (let index = 0; index < queue.length; index++) {
      const job = queue[index];
      job.priority = computePriority(job.chunk, job.kind, job.lod);
    }
    queue.sort(compareJobs);
    queueDirty = false;
  }

  function jobStillNeeded(job) {
    const chunk = job.chunk;
    if (chunk === null || chunks.get(chunk.key) !== chunk) return false;
    if (job.kind === JOB_MESH) {
      return chunk.desiredLod === job.lod && chunk.displayedLod !== job.lod && (chunk.inflightMask & (1 << job.lod)) === 0;
    }
    return chunk.wantsVegetation && chunk.vegetationDensity !== settingsView.vegetationDensity && !chunk.vegetationInflight;
  }
  /** Next job worth running (stale ones are skipped and recycled), without removing it. */
  function peekJob() {
    while (queueHead < queue.length) {
      const job = queue[queueHead];
      if (jobStillNeeded(job)) return job;
      releaseJob(job);
      queueHead++;
    }
    return null;
  }
  function popJob() {
    const job = peekJob();
    if (job !== null) queueHead++;
    return job;
  }

  function removeChunk(chunk) {
    chunks.delete(chunk.key);
    finishLodFade(chunk);
    if (chunk.mesh) releaseChunkMesh(chunk.mesh);
    chunk.mesh = null;
    chunk.displayedLod = -1;
    releaseVegetation(chunk);
    chunkRecordPool.push(chunk);
  }

  // ---- Vegetation bookkeeping -------------------------------------------------------------------------
  function releaseVegetation(chunk) {
    for (const mesh of chunk.vegetationMeshes) {
      vegetationInstances -= mesh.geometry.instanceCount;
      mesh.visible = false;
      mesh.geometry.instanceCount = 0;
      vegetationPools[mesh.userData.vegetationType].push(mesh);
    }
    chunk.vegetationMeshes.length = 0;
    chunk.vegetationDensity = -1;
  }
  function refreshVegetationVisibility(chunk) {
    const terrainShown = chunk.displayedLod >= 0;
    const castsShadow = chunk.ring <= VEGETATION_SHADOW_RINGS;
    for (const mesh of chunk.vegetationMeshes) {
      const isFlower = mesh.userData.vegetationType === VEGETATION.FLOWERS;
      mesh.visible = terrainShown && (!isFlower || chunk.ring <= FLOWER_RINGS);
      mesh.castShadow = castsShadow && !isFlower;
    }
  }

  // ---- LOD cross-fade -------------------------------------------------------------------------------------
  const fadingChunks = [];
  function beginLodFade(chunk, incoming) {
    finishLodFade(chunk);
    const outgoing = chunk.mesh;
    outgoing.material = fadeMaterial;
    outgoing.userData.fadeOpacity = 1;
    outgoing.userData.fadeFlip = 1;
    incoming.material = fadeMaterial;
    incoming.userData.fadeOpacity = 0;
    incoming.userData.fadeFlip = 0;
    chunk.fadeMesh = outgoing;
    chunk.fadeProgress = 0;
    fadingChunks.push(chunk);
  }
  function finishLodFade(chunk) {
    if (chunk.fadeMesh === null) return;
    const index = fadingChunks.indexOf(chunk);
    if (index >= 0) {
      fadingChunks[index] = fadingChunks[fadingChunks.length - 1];
      fadingChunks.pop();
    }
    releaseChunkMesh(chunk.fadeMesh);
    chunk.fadeMesh = null;
    if (chunk.mesh !== null) {
      chunk.mesh.material = material;
      chunk.mesh.userData.fadeOpacity = 1;
    }
  }
  function updateLodFades(realDt) {
    for (let index = fadingChunks.length - 1; index >= 0; index--) {
      const chunk = fadingChunks[index];
      chunk.fadeProgress += realDt / LOD_FADE_SECONDS;
      if (chunk.fadeProgress >= 1) {
        finishLodFade(chunk);
        continue;
      }
      const eased = chunk.fadeProgress * chunk.fadeProgress * (3 - 2 * chunk.fadeProgress);
      chunk.mesh.userData.fadeOpacity = eased;
      chunk.fadeMesh.userData.fadeOpacity = 1 - eased;
    }
  }

  // ---- Buffers ----------------------------------------------------------------------------------------------
  function recycleMeshBuffers(result) {
    const pool = bufferPools[result.lod];
    if (pool && pool.position.length < BUFFER_POOL_LIMIT && result.position instanceof ArrayBuffer && result.position.byteLength > 0) {
      pool.position.push(result.position);
      pool.normal.push(result.normal);
      pool.color.push(result.color);
    }
    result.position = null;
    result.normal = null;
    result.color = null;
  }
  function recycleScatterBuffer(result) {
    if (scatterBufferPool.length < BUFFER_POOL_LIMIT && result.data instanceof ArrayBuffer && result.data.byteLength > 0) {
      scatterBufferPool.push(result.data);
    }
    result.data = null;
  }
  function takeFloatBuffer(stack, floats) {
    const buffer = stack.pop();
    return buffer && buffer.byteLength === floats * 4 ? buffer : null;
  }

  // ---- Applying finished work ---------------------------------------------------------------------------
  function resultPriority(result) {
    const chunk = chunks.get(result.key);
    if (chunk === undefined) return -Infinity;
    return computePriority(chunk, result.type === 'mesh' ? JOB_MESH : JOB_SCATTER, result.lod);
  }

  function applyMeshResult(result) {
    const chunk = chunks.get(result.key);
    const lod = result.lod;
    if (chunk === undefined) {
      recycleMeshBuffers(result);
      return;
    }
    chunk.inflightMask &= ~(1 << lod);
    const wanted = lod === chunk.desiredLod || chunk.displayedLod < 0;
    if (!wanted || lod === chunk.displayedLod) {
      recycleMeshBuffers(result);
      if (chunk.displayedLod !== chunk.desiredLod) queueDirty = true;
      return;
    }
    const mesh = acquireChunkMesh(lod);
    const geometry = mesh.geometry;
    const positionAttribute = geometry.attributes.position;
    const normalAttribute = geometry.attributes.normal;
    const colorAttribute = geometry.attributes.color;
    positionAttribute.array.set(new Float32Array(result.position));
    normalAttribute.array.set(new Float32Array(result.normal));
    colorAttribute.array.set(new Float32Array(result.color));
    positionAttribute.needsUpdate = true;
    normalAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    uploadBytesThisFrame += result.position.byteLength * 3;
    const minY = Number.isFinite(result.minY) ? result.minY : -SKIRT_DEPTHS[lod];
    const maxY = Number.isFinite(result.maxY) ? result.maxY : 0;
    const halfHeight = (maxY - minY) / 2;
    geometry.boundingSphere.center.set(CHUNK_SIZE / 2, (minY + maxY) / 2, CHUNK_SIZE / 2);
    geometry.boundingSphere.radius = Math.sqrt(CHUNK_SIZE * CHUNK_SIZE * 0.5 + halfHeight * halfHeight) + 1;
    mesh.position.set(chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE);
    mesh.updateMatrix();
    mesh.visible = true;
    if (chunk.mesh !== null && chunk.displayedLod >= 0 && state.ready && fadingChunks.length < MAX_FADING_CHUNKS) {
      beginLodFade(chunk, mesh);
    } else {
      finishLodFade(chunk);
      if (chunk.mesh !== null) releaseChunkMesh(chunk.mesh);
    }
    chunk.mesh = mesh;
    chunk.displayedLod = lod;
    refreshVegetationVisibility(chunk);
    recycleMeshBuffers(result);
    if (chunk.displayedLod !== chunk.desiredLod && (chunk.inflightMask & (1 << chunk.desiredLod)) === 0) queueDirty = true;
  }

  function scatterNeedsNewMeshes(data) {
    let needed = 0;
    for (let type = 0; type < VEGETATION_TYPE_COUNT; type++) {
      if (data[type * 6] > 0 && vegetationPools[type].length === 0) needed++;
    }
    return needed;
  }

  function copyInstanceAttribute(attribute, source, sourceOffset, itemSize, count) {
    attribute.array.set(source.subarray(sourceOffset, sourceOffset + count * itemSize));
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * itemSize);
    attribute.needsUpdate = true;
  }

  function applyScatterResult(result) {
    const chunk = chunks.get(result.key);
    if (chunk === undefined) {
      recycleScatterBuffer(result);
      return true;
    }
    if (!chunk.wantsVegetation || result.density !== settingsView.vegetationDensity) {
      chunk.vegetationInflight = false;
      recycleScatterBuffer(result);
      if (chunk.wantsVegetation) queueDirty = true;
      return true;
    }
    const data = new Float32Array(result.data);
    const needed = scatterNeedsNewMeshes(data);
    if (needed > 0 && newVegetationMeshesThisFrame + needed > NEW_VEGETATION_MESHES_PER_FRAME && newVegetationMeshesThisFrame > 0) {
      return false;
    }
    chunk.vegetationInflight = false;
    releaseVegetation(chunk);
    for (let type = 0; type < VEGETATION_TYPE_COUNT; type++) {
      const header = type * 6;
      const count = Math.min(data[header] | 0, SCATTER_MAX_INSTANCES);
      if (count <= 0) continue;
      const start = data[header + 1] | 0;
      let mesh = vegetationPools[type].pop();
      if (mesh === undefined) {
        mesh = createVegetationMesh(type);
        newVegetationMeshesThisFrame++;
      }
      const geometry = mesh.geometry;
      copyInstanceAttribute(geometry.attributes.vegetationPlacement, data, SCATTER_HEADER_FLOATS + start * 4, 4, count);
      copyInstanceAttribute(geometry.attributes.vegetationScale, data, SCATTER_SCALE_OFFSET + start * 3, 3, count);
      copyInstanceAttribute(geometry.attributes.vegetationTint, data, SCATTER_TINT_OFFSET + start * 3, 3, count);
      geometry.instanceCount = count;
      const extents = vegetationExtents[type];
      const minBase = data[header + 2];
      const maxBase = data[header + 3];
      const maxScaleY = data[header + 4];
      const maxScaleXZ = data[header + 5];
      const top = maxBase + extents.top * maxScaleY;
      const bottom = minBase + extents.bottom * maxScaleY;
      const halfHeight = (top - bottom) / 2 + 1;
      const halfWidth = CHUNK_SIZE / 2 + extents.radius * maxScaleXZ + 1;
      geometry.boundingSphere.center.set(CHUNK_SIZE / 2, (top + bottom) / 2, CHUNK_SIZE / 2);
      geometry.boundingSphere.radius = Math.sqrt(2 * halfWidth * halfWidth + halfHeight * halfHeight);
      mesh.position.set(chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE);
      mesh.updateMatrix();
      mesh.userData.bornAt = chunk.vegetationShown ? -1e9 : terrainClock;
      chunk.vegetationMeshes.push(mesh);
      vegetationInstances += count;
    }
    chunk.vegetationDensity = result.density;
    chunk.vegetationShown = true;
    refreshVegetationVisibility(chunk);
    recycleScatterBuffer(result);
    return true;
  }

  function applyReadyResults(budgetMs, uploadLimit) {
    const started = performance.now();
    let deferred = null;
    while (readyResults.length > 0) {
      let bestIndex = 0;
      let bestPriority = Infinity;
      for (let index = 0; index < readyResults.length; index++) {
        const priority = resultPriority(readyResults[index]);
        if (priority < bestPriority) {
          bestPriority = priority;
          bestIndex = index;
        }
      }
      const result = readyResults[bestIndex];
      readyResults[bestIndex] = readyResults[readyResults.length - 1];
      readyResults.pop();
      if (result.type === 'mesh') {
        applyMeshResult(result);
      } else if (!applyScatterResult(result)) {
        if (deferred === null) deferred = [];
        deferred.push(result);
      }
      if (performance.now() - started >= budgetMs || uploadBytesThisFrame >= uploadLimit) break;
    }
    if (deferred !== null) for (const result of deferred) readyResults.push(result);
  }

  function recordBuildTime(milliseconds) {
    if (!Number.isFinite(milliseconds)) return;
    buildSamples++;
    const weight = buildSamples < 20 ? 1 / buildSamples : 0.05;
    buildMsAverage += (milliseconds - buildMsAverage) * weight;
  }

  // ==========================================================================================
  // WORKERS
  // ==========================================================================================
  const workerRecords = [];
  let mode = 'workers';
  let workerFailureReported = false;
  let workerWaitSeconds = 0;
  let workersReady = false;
  let nextJobId = 1;
  const mainThread = { builder: null, active: null };

  function stopWorkers() {
    for (const record of workerRecords) {
      record.worker.onmessage = null;
      record.worker.onerror = null;
      record.worker.onmessageerror = null;
      record.worker.terminate();
    }
    workerRecords.length = 0;
  }

  function switchToMainThread() {
    stopWorkers();
    mode = 'main-thread';
    mainThread.builder = createChunkBuilder(world, builderConfig);
    for (const chunk of chunks.values()) {
      chunk.inflightMask = 0;
      chunk.vegetationInflight = false;
    }
    for (const result of readyResults) {
      const chunk = chunks.get(result.key);
      if (chunk === undefined) continue;
      if (result.type === 'mesh') chunk.inflightMask |= 1 << result.lod;
      else chunk.vegetationInflight = true;
    }
    queueDirty = true;
  }

  /** Losing the workers is a genuine environment failure (e.g. a CSP without blob: workers): say so once. */
  function reportWorkerFailure(detail) {
    if (workerFailureReported) return;
    workerFailureReported = true;
    console.error('[DRIFTWING] terrain worker failed; continuing with main-thread generation', detail);
  }

  function handleWorkerFailure(detail) {
    if (mode !== 'workers') return;
    reportWorkerFailure(detail);
    switchToMainThread();
  }

  function handleWorkerMessage(record, message) {
    if (mode !== 'workers' || message === null || typeof message !== 'object') return;
    if (message.type === 'ready') {
      record.ready = true;
      if (!workersReady && workerRecords.every((candidate) => candidate.ready)) workersReady = true;
      return;
    }
    if (message.type === 'error') {
      handleWorkerFailure(`${message.message}\n${message.stack}`);
      return;
    }
    if (message.type === 'mesh' || message.type === 'scatter') {
      record.inFlight = Math.max(0, record.inFlight - 1);
      recordBuildTime(message.buildMs);
      readyResults.push(message);
      dispatchToWorkers();
    }
  }

  function startWorkers() {
    if (typeof Worker !== 'function') {
      reportWorkerFailure('this browser has no Worker support');
      return false;
    }
    const concurrency = navigator.hardwareConcurrency || 4;
    const count = concurrency >= 8 ? 3 : 2;
    try {
      for (let index = 0; index < count; index++) {
        const worker = new TerrainWorker({ name: `driftwing-terrain-${index + 1}` });
        const record = { worker, inFlight: 0, ready: false };
        worker.onmessage = (event) => handleWorkerMessage(record, event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          handleWorkerFailure(event.message || 'terrain worker error event');
        };
        worker.onmessageerror = () => handleWorkerFailure('terrain worker message could not be deserialised');
        worker.postMessage({ type: 'init', seed: world.seed, options: ctx.worldOptions, config: builderConfig });
        workerRecords.push(record);
      }
      return true;
    } catch (error) {
      stopWorkers();
      reportWorkerFailure(error);
      return false;
    }
  }

  function sendJob(record, job) {
    const chunk = job.chunk;
    record.inFlight++;
    if (job.kind === JOB_MESH) {
      const floats = lodVertexCount(job.lod) * 3;
      const pool = bufferPools[job.lod];
      const message = {
        type: 'mesh', id: nextJobId++, key: chunk.key, cx: chunk.cx, cz: chunk.cz, lod: job.lod,
        position: takeFloatBuffer(pool.position, floats),
        normal: takeFloatBuffer(pool.normal, floats),
        color: takeFloatBuffer(pool.color, floats),
        minY: 0, maxY: 0, buildMs: 0,
      };
      chunk.inflightMask |= 1 << job.lod;
      const transfer = [];
      if (message.position) transfer.push(message.position);
      if (message.normal) transfer.push(message.normal);
      if (message.color) transfer.push(message.color);
      record.worker.postMessage(message, transfer);
    } else {
      const message = {
        type: 'scatter', id: nextJobId++, key: chunk.key, cx: chunk.cx, cz: chunk.cz, lod: 0,
        density: settingsView.vegetationDensity, floats: SCATTER_FLOATS,
        data: takeFloatBuffer(scatterBufferPool, SCATTER_FLOATS), buildMs: 0,
      };
      chunk.vegetationInflight = true;
      record.worker.postMessage(message, message.data ? [message.data] : []);
    }
  }

  function dispatchToWorkers() {
    for (;;) {
      let target = null;
      for (const record of workerRecords) {
        if (record.inFlight < MAX_JOBS_PER_WORKER && (target === null || record.inFlight < target.inFlight)) target = record;
      }
      if (target === null) return;
      const job = popJob();
      if (job === null) return;
      sendJob(target, job);
      releaseJob(job);
    }
  }

  // ---- Main-thread fallback (time-sliced) ---------------------------------------------------------------
  function allocateFloatBuffer(stack, floats) {
    return takeFloatBuffer(stack, floats) || new ArrayBuffer(floats * 4);
  }
  function startMainThreadJob(job) {
    const chunk = job.chunk;
    const started = performance.now();
    if (job.kind === JOB_MESH) {
      const floats = lodVertexCount(job.lod) * 3;
      const pool = bufferPools[job.lod];
      const result = {
        type: 'mesh', key: chunk.key, cx: chunk.cx, cz: chunk.cz, lod: job.lod,
        position: allocateFloatBuffer(pool.position, floats),
        normal: allocateFloatBuffer(pool.normal, floats),
        color: allocateFloatBuffer(pool.color, floats),
        minY: 0, maxY: 0, buildMs: 0,
      };
      const output = {
        positions: new Float32Array(result.position),
        normals: new Float32Array(result.normal),
        colors: new Float32Array(result.color),
        minY: 0, maxY: 0, vertexCount: 0,
      };
      chunk.inflightMask |= 1 << job.lod;
      return {
        result, output, started, steps: mainThread.builder.buildMesh(result, output),
        finish() {
          result.minY = output.minY;
          result.maxY = output.maxY;
        },
      };
    }
    const result = {
      type: 'scatter', key: chunk.key, cx: chunk.cx, cz: chunk.cz, lod: 0,
      density: settingsView.vegetationDensity, floats: SCATTER_FLOATS,
      data: allocateFloatBuffer(scatterBufferPool, SCATTER_FLOATS), buildMs: 0,
    };
    chunk.vegetationInflight = true;
    return { result, output: null, started, steps: mainThread.builder.buildScatter(result, new Float32Array(result.data)), finish() {} };
  }

  function runMainThreadJobs(budgetMs) {
    const started = performance.now();
    for (;;) {
      if (mainThread.active === null) {
        const job = peekJob();
        if (job === null) return;
        const elapsed = performance.now() - started;
        if (job.kind === JOB_SCATTER && elapsed > budgetMs * 0.25) return;
        queueHead++;
        mainThread.active = startMainThreadJob(job);
        releaseJob(job);
      }
      const active = mainThread.active;
      let progress = active.steps.next();
      while (!progress.done && performance.now() - started < budgetMs) progress = active.steps.next();
      if (!progress.done) return;
      active.finish();
      active.result.buildMs = performance.now() - active.started;
      recordBuildTime(active.result.buildMs);
      readyResults.push(active.result);
      mainThread.active = null;
      if (performance.now() - started >= budgetMs) return;
    }
  }

  if (!startWorkers()) switchToMainThread();

  // ---- Shader warm-up: one mesh per vegetation type is drawn (far below the ground, culling off)
  // during the loading fade so each type's shared material builds before the first frame shows.
  // Two empty (degenerate) shadow-casting chunk meshes do the same for the terrain material and its
  // LOD-fade variant, so the first streamed chunks and the first LOD swap never wait on a compile.
  const warmupMeshes = [];
  const terrainWarmupMeshes = [acquireChunkMesh(1), acquireChunkMesh(1)];
  terrainWarmupMeshes[1].material = fadeMaterial;
  terrainWarmupMeshes[1].userData.fadeOpacity = 0.5;
  for (const mesh of terrainWarmupMeshes) {
    mesh.frustumCulled = false;
    mesh.visible = true;
  }
  let warmupFramesLeft = WARMUP_FRAMES;
  for (let type = 0; type < VEGETATION_TYPE_COUNT; type++) {
    const mesh = createVegetationMesh(type);
    const geometry = mesh.geometry;
    geometry.attributes.vegetationPlacement.array[1] = -2500;
    geometry.attributes.vegetationScale.array.fill(1, 0, 3);
    geometry.instanceCount = 1;
    mesh.frustumCulled = false;
    mesh.position.set(Math.floor(state.player.position.x / CHUNK_SIZE) * CHUNK_SIZE, 0, Math.floor(state.player.position.z / CHUNK_SIZE) * CHUNK_SIZE);
    mesh.updateMatrix();
    mesh.visible = true;
    warmupMeshes.push(mesh);
  }
  function finishWarmup() {
    for (const mesh of warmupMeshes) {
      mesh.visible = false;
      mesh.frustumCulled = true;
      mesh.geometry.instanceCount = 0;
      vegetationPools[mesh.userData.vegetationType].push(mesh);
    }
    warmupMeshes.length = 0;
    for (const mesh of terrainWarmupMeshes) {
      mesh.frustumCulled = true;
      releaseChunkMesh(mesh);
    }
    terrainWarmupMeshes.length = 0;
  }

  // ==========================================================================================
  // EVENTS + API
  // ==========================================================================================
  const unsubscribeQuality = bus.on('quality:changed', () => {
    qualityDirty = true;
  });

  const statsFrustum = new THREE.Frustum();
  const statsMatrix = new THREE.Matrix4();

  function countFrustumVisible() {
    camera.updateMatrixWorld();
    statsMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    statsFrustum.setFromProjectionMatrix(statsMatrix, camera.coordinateSystem, camera.reversedDepth);
    let visible = 0;
    for (const chunk of chunks.values()) {
      if (chunk.mesh && chunk.mesh.visible) {
        chunk.mesh.updateMatrixWorld();
        if (statsFrustum.intersectsObject(chunk.mesh)) visible++;
      }
    }
    return visible;
  }

  return {
    material,

    update(dt, realDt) {
      newVegetationMeshesThisFrame = 0;
      uploadBytesThisFrame = 0;
      terrainClock += realDt;
      if (warmupFramesLeft > 0) {
        warmupFramesLeft--;
        if (warmupFramesLeft === 0) finishWarmup();
      }
      if (qualityDirty) readQuality();
      if (scene.fog) {
        foamFogNear.value = scene.fog.near;
        foamFogFar.value = Math.max(scene.fog.far, scene.fog.near + 1);
      }
      const centerChanged = updateFocus(dt, realDt);
      replanTimer -= realDt;
      if (centerChanged || qualityDirty) {
        qualityDirty = false;
        replanTimer = REPLAN_INTERVAL;
        plan();
      } else if (queueDirty || (replanTimer <= 0 && queueHead < queue.length)) {
        replanTimer = REPLAN_INTERVAL;
        rebuildQueue();
      }
      if (mode === 'workers') {
        dispatchToWorkers();
        if (!workersReady) {
          workerWaitSeconds += realDt;
          if (workerWaitSeconds > WORKER_READY_TIMEOUT) handleWorkerFailure(`terrain workers did not start within ${WORKER_READY_TIMEOUT} s`);
        }
      }
      if (mode === 'main-thread') runMainThreadJobs(state.ready ? MAIN_THREAD_BUDGET_MS : MAIN_THREAD_STARTUP_BUDGET_MS);
      // Before the loading fade clears nothing is on screen, so finished chunks apply in bulk.
      if (state.ready) applyReadyResults(APPLY_BUDGET_MS, UPLOAD_BYTES_PER_FRAME);
      else applyReadyResults(STARTUP_APPLY_BUDGET_MS, STARTUP_UPLOAD_BYTES_PER_FRAME);
      updateLodFades(realDt);
    },

    isReadyAround(x, z) {
      if (warmupFramesLeft > 0) return false;
      const centerX = Math.floor(x / CHUNK_SIZE);
      const centerZ = Math.floor(z / CHUNK_SIZE);
      for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const chunk = chunks.get(chunkKey(centerX + offsetX, centerZ + offsetZ));
          if (chunk === undefined || chunk.displayedLod !== 0 || !chunk.mesh || !chunk.mesh.visible) return false;
        }
      }
      if (firstReadyAtMs < 0) firstReadyAtMs = performance.now();
      return true;
    },

    getStats() {
      const lodCounts = new Array(LOD_COUNT).fill(0);
      let displayed = 0;
      for (const chunk of chunks.values()) {
        if (chunk.displayedLod >= 0) {
          lodCounts[chunk.displayedLod]++;
          displayed++;
        }
      }
      let pooled = 0;
      for (const pool of meshPools) pooled += pool.length;
      let vegetationPooled = 0;
      for (const pool of vegetationPools) vegetationPooled += pool.length;
      let inFlight = 0;
      for (const record of workerRecords) inFlight += record.inFlight;
      if (mainThread.active !== null) inFlight++;
      return {
        chunks: displayed,
        tracked: chunks.size,
        visible: countFrustumVisible(),
        pending: Math.max(0, queue.length - queueHead) + readyResults.length,
        queued: Math.max(0, queue.length - queueHead),
        awaitingUpload: readyResults.length,
        inFlight,
        pooled,
        fading: fadingChunks.length,
        lodCounts,
        meshesCreated: meshTotals.slice(),
        vegetation: vegetationInstances,
        vegetationMeshes: vegetationTotals.reduce((sum, value) => sum + value, 0) - vegetationPooled,
        vegetationPooled,
        workers: workerRecords.length,
        mode,
        avgBuildMs: Math.round(buildMsAverage * 100) / 100,
        viewRings: settingsView.viewRings,
        readyAtMs: firstReadyAtMs < 0 ? null : Math.round(firstReadyAtMs),
        readyAfterCreateMs: firstReadyAtMs < 0 ? null : Math.round(firstReadyAtMs - createdAtMs),
      };
    },

    dispose() {
      unsubscribeQuality();
      stopWorkers();
      scene.remove(group);
      for (const pool of meshPools) pool.length = 0;
      for (const pool of vegetationPools) pool.length = 0;
      for (const child of group.children) {
        if (child.geometry) child.geometry.dispose();
      }
      group.clear();
      for (const geometry of vegetationGeometries) geometry.dispose();
      for (const vegetationMaterial of vegetationMaterials) vegetationMaterial.dispose();
      material.dispose();
      fadeMaterial.dispose();
      chunks.clear();
      fadingChunks.length = 0;
      readyResults.length = 0;
      queue.length = 0;
    },
  };
}
