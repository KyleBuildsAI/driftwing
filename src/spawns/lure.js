// FAR lures: horizon silhouettes of heavy spawns (contract section 4), the core of the discovery
// loop. A volcano plume, a supercell anvil or a sky whale 30 km away is far beyond the terrain's view
// distance (a few km) and the fog; its lure still stands on the horizon so the player sees it and
// flies toward it.
//
// One InstancedMesh of camera-facing quads draws every lure in one call. Each quad's fragment shader
// draws its silhouette procedurally from preset.lure: plume, anvil, funnel, whale, islands or comet,
// with soft, slowly billowing edges.
//
// Placement: a lure at true distance d beyond the projection limit (PROJECT_SHARE of the fog's far
// distance) is drawn at the limit instead, scaled by limit / d, so it keeps its exact direction and
// angular size while staying inside the camera's far plane and the sky dome. Terrain nearer than the
// limit still hides it through the depth test (a ridge in front hides the plume's foot); the terrain
// behind the limit is nearly fully fogged and the lure draws over it, which is exactly "above the fog".
//
// Look: the material ignores fog (fog: false). Its shading comes from the sky itself: ambient from the
// sky's zenith radiance, the sun's colour on the sunward side, a silver lining when the sun is behind
// it, and an aerial-perspective blend toward the sky colour in its own direction (the same sky
// function the fog uses), so golden hour, midday and night tint it correctly. Emissive parts (lava
// glow, lightning, a comet) are added after the haze so they carry at night.
//
// Render order 1: after the water (render order -1) and the opaque world, before the near effects
// (trails, rings, bursts: 3 and up), which must draw over it.
//
// Zero allocations per frame: slot data lives in typed arrays and the instance matrices and
// attributes are written in place. Each slot keeps a reference to its spawn's anchor (moved in place
// by its engine) and fades its own weight, so the per-frame path passes no doubles across calls (V8
// boxes a double passed to or returned from a call it does not inline) and uses Math.sqrt, not
// Math.hypot (which allocates its argument list).
import { LURE_TYPES } from './schema.js';

const DEFAULT_CAPACITY = 16;
/** Lures farther than this share of the fog's far distance are drawn at it (scaled to keep their size on screen). */
const PROJECT_SHARE = 0.92;
/** Aerial perspective: the share of sky colour at the fog's far distance and at HAZE_FULL_DISTANCE beyond it. */
const HAZE_NEAR = 0.28;
const HAZE_FAR = 0.62;
const HAZE_FULL_DISTANCE = 40000;
const RENDER_ORDER = 1;
/** Seconds a lure takes to fade fully in or out. */
const FADE_SECONDS = 1.2;
const SHAPE_INDEX = Object.freeze(Object.fromEntries(LURE_TYPES.map((type, index) => [type, index])));
/** Default emissive glow per silhouette (0xRRGGBB, or null): lava light under a plume. */
const DEFAULT_GLOW = Object.freeze({ plume: 0xff6a2a });
/** Default lightning flash strength per silhouette (0..4). */
const DEFAULT_FLASH = Object.freeze({ anvil: 1.4 });

/**
 * Builds the silhouette material. Inputs per instance: lureShape (shape, seed, weight, haze),
 * lureTint (linear rgb, whale facing), lureGlow (linear glow rgb, flash strength).
 */
function createLureMaterial({ THREE, TSL, uniforms, skyColorNode, shapeAttribute, tintAttribute, glowAttribute }) {
  const {
    Fn, If, float, vec2, vec3, vec4, uv, abs, max, min, mix, pow, sqrt, exp, sin, floor, dot, normalize,
    smoothstep, saturate, clamp, hash, mx_noise_float, positionWorld, cameraPosition, instancedDynamicBufferAttribute,
  } = TSL;
  const lureShape = instancedDynamicBufferAttribute(shapeAttribute, 'vec4');
  const lureTint = instancedDynamicBufferAttribute(tintAttribute, 'vec4');
  const lureGlow = instancedDynamicBufferAttribute(glowAttribute, 'vec4');
  const time = uniforms.time;
  const skyColor = skyColorNode ?? (() => uniforms.fogColor);

  /** 1 inside a soft band below edge (value < edge), fading over width. */
  const inside = (edge, value, width) => smoothstep(0, width, edge.sub(value));

  // Each shape returns vec3(mask 0..1, shade 0..1.2, emissive 0..).
  const plume = Fn(([x, y, seed]) => {
    const billow = mx_noise_float(vec3(x.mul(2.3), y.mul(5).sub(time.mul(0.05)), seed)).mul(0.13);
    const column = mix(0.12, 0.4, pow(y, 0.9));
    const columnMask = inside(column.add(billow), abs(x), 0.06).mul(float(1).sub(smoothstep(0.72, 0.88, y)));
    const headDistance = x.div(0.92).mul(x.div(0.92)).add(y.sub(0.8).div(0.2).mul(y.sub(0.8).div(0.2)));
    const headMask = smoothstep(0, 0.35, float(1).sub(headDistance).add(billow.mul(2.2)));
    const mask = max(columnMask, headMask).mul(smoothstep(0, 0.025, y));
    const shade = mix(0.5, 1.05, y).add(billow);
    const pulse = sin(time.mul(1.7).add(seed.mul(9.1))).mul(0.25).add(0.75);
    const emissive = exp(y.mul(-7)).mul(pulse).mul(inside(column.mul(0.8), abs(x), 0.05));
    return vec3(mask, shade, emissive);
  });

  const anvil = Fn(([x, y, seed, flash]) => {
    const billow = mx_noise_float(vec3(x.mul(2.6), y.mul(4).sub(time.mul(0.02)), seed)).mul(0.1);
    const tower = mix(0.2, 0.3, y).add(billow);
    const towerMask = inside(tower, abs(x), 0.05).mul(smoothstep(0.1, 0.14, y)).mul(float(1).sub(smoothstep(0.8, 0.86, y)));
    const underside = x.mul(x).mul(0.1).add(0.74);
    const top = float(0.95).sub(x.mul(x).mul(0.06));
    const anvilMask = inside(float(1), abs(x).sub(billow), 0.06).mul(smoothstep(0, 0.035, y.sub(underside).add(billow.mul(0.3)))).mul(smoothstep(0, 0.02, top.sub(y)));
    const overshoot = smoothstep(0, 0.3, float(1).sub(x.div(0.1).mul(x.div(0.1)).add(y.sub(0.95).div(0.06).mul(y.sub(0.95).div(0.06)))));
    const streaks = sin(x.mul(70).add(seed.mul(40))).mul(0.12).add(0.34);
    const rain = inside(float(0.17).add(billow.mul(0.5)), abs(x), 0.05).mul(float(1).sub(smoothstep(0.1, 0.14, y))).mul(streaks);
    const mask = max(max(towerMask, anvilMask), max(overshoot, rain));
    const shade = mix(0.42, 1.05, smoothstep(0.08, 0.92, y)).add(billow);
    const strike = floor(time.mul(4.3).add(seed.mul(17)));
    const flashOn = smoothstep(0.93, 0.95, hash(strike)).mul(hash(strike.add(3.1)).mul(0.6).add(0.4));
    const emissive = flashOn.mul(flash).mul(mx_noise_float(vec3(x.mul(3), y.mul(3), strike)).mul(0.4).add(0.6)).mul(towerMask.add(anvilMask.mul(0.5)));
    return vec3(mask, shade, emissive);
  });

  const funnel = Fn(([x, y, seed]) => {
    const billow = mx_noise_float(vec3(x.mul(3), y.mul(6).sub(time.mul(0.3)), seed)).mul(0.08);
    const sway = sin(y.mul(3.1).add(time.mul(0.35)).add(seed.mul(6.28))).mul(0.07).mul(float(1).sub(y));
    const halfWidth = pow(y.div(0.86), 2.4).mul(0.3).add(0.035);
    const funnelMask = inside(halfWidth.add(billow.mul(y)), abs(x.sub(sway)), 0.03).mul(float(1).sub(smoothstep(0.86, 0.9, y)));
    const wallDistance = x.mul(x).add(y.sub(0.93).div(0.09).mul(y.sub(0.93).div(0.09)));
    const wall = smoothstep(0, 0.3, float(1).sub(wallDistance).add(billow.mul(3)));
    const debrisDistance = x.sub(sway).div(0.15).mul(x.sub(sway).div(0.15)).add(y.sub(0.03).div(0.05).mul(y.sub(0.03).div(0.05)));
    const debris = smoothstep(0, 0.6, float(1).sub(debrisDistance).add(billow.mul(4))).mul(0.6);
    const mask = max(max(funnelMask, wall), debris);
    return vec3(mask, mix(0.55, 0.85, y).add(billow), float(0));
  });

  const whale = Fn(([x, y, seed, facing]) => {
    const along = x.mul(facing);
    const centre = sin(time.mul(0.5).add(seed.mul(5))).mul(0.03).add(0.5);
    const bodyAlong = along.sub(0.1).div(0.8);
    const bodyHalf = sqrt(max(float(1).sub(bodyAlong.mul(bodyAlong)), 0)).mul(bodyAlong.mul(0.15).add(1)).mul(0.2);
    const body = inside(bodyHalf, abs(y.sub(centre)), 0.02);
    const beat = sin(time.mul(0.6).add(seed.mul(3))).mul(0.07);
    const stock = inside(float(0.045), abs(y.sub(centre).sub(beat.mul(clamp(along.add(0.7).mul(-2), 0, 1)))), 0.015).mul(smoothstep(-0.95, -0.9, along)).mul(float(1).sub(smoothstep(-0.72, -0.68, along)));
    const flukeReach = clamp(float(-0.84).sub(along).div(0.15), 0, 1);
    const flukes = inside(flukeReach.mul(0.22), abs(y.sub(centre).sub(beat)), 0.015).mul(smoothstep(-1, -0.97, along)).mul(float(1).sub(smoothstep(-0.86, -0.83, along)));
    const finY = y.sub(centre.sub(0.15));
    const fin = inside(float(0.06), abs(along.sub(0.33).add(finY.mul(0.9))), 0.02).mul(smoothstep(-0.14, -0.11, finY)).mul(float(1).sub(smoothstep(-0.01, 0.01, finY)));
    const mask = max(max(body, stock), max(flukes, fin));
    const belly = smoothstep(-0.18, 0.12, y.sub(centre));
    const spots = smoothstep(0.55, 0.8, mx_noise_float(vec3(x.mul(18), y.mul(18), seed))).mul(body);
    return vec3(mask, mix(1.1, 0.62, belly), spots.mul(0.5));
  });

  const islands = Fn(([x, y, seed]) => {
    const mask = float(0).toVar();
    const shade = float(0.8).toVar();
    const layout = [[-0.56, 0.6, 0.3, 0.42], [0.08, 0.8, 0.38, 0.55], [0.62, 0.48, 0.24, 0.34]];
    for (let index = 0; index < layout.length; index++) {
      const [baseX, baseTop, halfWidth, depth] = layout[index];
      const centreX = hash(seed.add(index * 7.3)).sub(0.5).mul(0.1).add(baseX);
      const across = x.sub(centreX).div(halfWidth);
      const profile = max(float(1).sub(across.mul(across)), 0);
      const trees = max(mx_noise_float(vec3(x.mul(26), seed, index)), 0).mul(0.05).mul(profile);
      const topY = profile.mul(0.03).add(baseTop).add(trees);
      const rock = mx_noise_float(vec3(x.mul(8), seed, index + 11)).mul(0.1).add(0.9);
      const bottomY = float(baseTop).sub(pow(profile, 0.8).mul(depth).mul(rock));
      const island = inside(float(1), abs(across), 0.08).mul(smoothstep(0, 0.012, topY.sub(y))).mul(smoothstep(0, 0.012, y.sub(bottomY)));
      mask.assign(max(mask, island));
      If(island.greaterThan(0.01), () => {
        shade.assign(mix(0.55, 1.05, smoothstep(bottomY, topY, y)));
      });
      // A thin waterfall pours off the edge of each island and frays into mist.
      const fallX = centreX + halfWidth * 0.62;
      const fall = inside(float(0.009), abs(x.sub(fallX)), 0.006).mul(smoothstep(baseTop - 0.4, baseTop - 0.02, y)).mul(float(1).sub(smoothstep(baseTop - 0.02, baseTop, y))).mul(0.55);
      mask.assign(max(mask, fall));
    }
    return vec3(mask, shade, float(0));
  });

  const comet = Fn(([x, y]) => {
    const along = x.add(0.8).div(1.8);
    const across = y.sub(0.5).mul(2);
    const halfWidth = along.mul(0.9).add(0.06);
    const tail = inside(float(1), abs(across).div(halfWidth), 0.6).mul(pow(saturate(float(1).sub(along)), 1.5)).mul(smoothstep(-0.02, 0.02, along));
    const head = exp(x.add(0.8).mul(x.add(0.8)).mul(-60).sub(y.sub(0.5).mul(y.sub(0.5)).mul(60)));
    const mask = saturate(max(tail.mul(0.75), head));
    return vec3(mask, float(0), head.mul(3).add(tail.mul(0.9)));
  });

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const shapeIndex = lureShape.x;
    const seed = lureShape.y;
    const weight = lureShape.z;
    const haze = lureShape.w;
    const facing = lureTint.w;
    const x = uv().x.mul(2).sub(1);
    const y = uv().y;
    const result = vec3(0).toVar();
    If(shapeIndex.lessThan(0.5), () => {
      result.assign(plume(x, y, seed));
    }).ElseIf(shapeIndex.lessThan(1.5), () => {
      result.assign(anvil(x, y, seed, lureGlow.w));
    }).ElseIf(shapeIndex.lessThan(2.5), () => {
      result.assign(funnel(x, y, seed));
    }).ElseIf(shapeIndex.lessThan(3.5), () => {
      result.assign(whale(x, y, seed, facing));
    }).ElseIf(shapeIndex.lessThan(4.5), () => {
      result.assign(islands(x, y, seed));
    }).Else(() => {
      result.assign(comet(x, y));
    });
    const mask = result.x;
    const shade = result.y;
    const emissive = result.z;

    // Sky-lit mass: zenith ambient, the sun on the sunward side, a silver lining against the sun.
    const viewDirection = normalize(positionWorld.sub(cameraPosition));
    const behind = skyColor(viewDirection);
    const ambient = skyColor(vec3(0, 1, 0));
    const right = normalize(vec3(viewDirection.z.negate(), 0, viewDirection.x));
    const bulge = normalize(right.mul(x.mul(0.8)).add(vec3(0, 1, 0).mul(y.sub(0.45).mul(0.9))).sub(viewDirection.mul(0.7)));
    const sunward = saturate(dot(bulge, uniforms.sunDirection).mul(0.6).add(0.4));
    const rim = pow(saturate(dot(viewDirection, uniforms.sunDirection)), 6).mul(mask.mul(float(1).sub(mask)).mul(4));
    const lit = lureTint.rgb.mul(ambient.mul(1.5).add(uniforms.sunColor.mul(sunward.mul(1.1).add(0.15)))).mul(shade).add(uniforms.sunColor.mul(rim.mul(0.9)));
    const hazed = mix(lit, behind, haze);
    // A self-luminous lure (shade 0, the comet) shows only its light over the sky behind it.
    const body = mix(behind, hazed, min(shade.mul(4), 1));
    const glowStrength = mix(0.35, 1.6, uniforms.nightFactor).mul(float(1).sub(haze.mul(0.5)));
    const color = body.add(lureGlow.rgb.mul(emissive).mul(glowStrength).mul(2.2));
    return vec4(color, saturate(mask.mul(weight)));
  })();
  return material;
}

/**
 * Creates the lure system. sky: the sky system (its skyColorNode tints the lures; without it the fog
 * colour stands in). Returns { mesh, acquire, setVisible, setHeading, weightOf, release, update,
 * getStats, dispose }.
 */
export function createLureSystem({ THREE, TSL, scene, camera, sky, uniforms, capacity = DEFAULT_CAPACITY }) {
  const shapeData = new Float32Array(capacity * 4);
  const tintData = new Float32Array(capacity * 4);
  const glowData = new Float32Array(capacity * 4);
  const shapeAttribute = new THREE.InstancedBufferAttribute(shapeData, 4).setUsage(THREE.DynamicDrawUsage);
  const tintAttribute = new THREE.InstancedBufferAttribute(tintData, 4).setUsage(THREE.DynamicDrawUsage);
  const glowAttribute = new THREE.InstancedBufferAttribute(glowData, 4).setUsage(THREE.DynamicDrawUsage);

  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const skyColorNode = sky && typeof sky.skyColorNode === 'function' ? (direction) => sky.skyColorNode(direction) : null;
  const material = createLureMaterial({ THREE, TSL, uniforms, skyColorNode, shapeAttribute, tintAttribute, glowAttribute });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'spawn-lures';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const matrices = mesh.instanceMatrix.array;
  matrices.fill(0);
  mesh.count = 0;
  mesh.visible = false;
  scene.add(mesh);

  // Slot state.
  const active = new Uint8Array(capacity);
  const shape = new Uint8Array(capacity);
  const width = new Float32Array(capacity);
  const height = new Float32Array(capacity);
  const altitude = new Float32Array(capacity);
  const anchors = new Array(capacity).fill(null);
  const heading = new Float32Array(capacity);
  const visible = new Uint8Array(capacity);
  const weight = new Float32Array(capacity);
  const distance = new Float32Array(capacity);
  // This frame's camera position, projection limit and fog far distance (read by writeSlot).
  const view = new Float64Array(5);
  const scratchColor = new THREE.Color();
  const stats = { active: 0, drawn: 0, projected: 0, capacity };
  let highWater = 0;

  function clearSlot(slot) {
    const offset = slot * 16;
    for (let index = 0; index < 16; index++) matrices[offset + index] = 0;
    shapeData[slot * 4 + 2] = 0;
  }

  function writeColor(target, offset, hex) {
    scratchColor.set(hex);
    target[offset] = scratchColor.r;
    target[offset + 1] = scratchColor.g;
    target[offset + 2] = scratchColor.b;
  }

  /** Writes a slot's matrix and per-frame attributes for this frame's view. */
  function writeSlot(slot) {
    const cameraX = view[0];
    const cameraY = view[1];
    const cameraZ = view[2];
    const limit = view[3];
    const fogFar = view[4];
    const sunDirection = uniforms.sunDirection.value;
    const anchor = anchors[slot];
    const baseX = anchor.x;
    const baseY = anchor.y + altitude[slot];
    const baseZ = anchor.z;
    const deltaX = baseX - cameraX;
    const deltaY = baseY - cameraY;
    const deltaZ = baseZ - cameraZ;
    const trueDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
    distance[slot] = trueDistance;
    const offset = slot * 16;
    if (!(trueDistance > 1) || weight[slot] <= 0.001) {
      clearSlot(slot);
      return false;
    }
    const scale = trueDistance > limit ? limit / trueDistance : 1;
    if (scale < 1) stats.projected++;
    let positionX = cameraX + deltaX * scale;
    let positionY = cameraY + deltaY * scale;
    let positionZ = cameraZ + deltaZ * scale;
    const quadWidth = width[slot] * scale;
    const quadHeight = height[slot] * scale;
    // Toward the camera, unit length.
    const towardX = -deltaX / trueDistance;
    const towardY = -deltaY / trueDistance;
    const towardZ = -deltaZ / trueDistance;
    let rightX;
    let rightY;
    let rightZ;
    let upX;
    let upY;
    let upZ;
    let normalX;
    let normalY;
    let normalZ;
    if (shape[slot] === SHAPE_INDEX.comet) {
      // Spherical billboard with the tail pointing away from the sun, centred on the anchor.
      let tailX = -sunDirection.x;
      let tailY = -sunDirection.y;
      let tailZ = -sunDirection.z;
      const along = tailX * towardX + tailY * towardY + tailZ * towardZ;
      tailX -= towardX * along;
      tailY -= towardY * along;
      tailZ -= towardZ * along;
      let length = Math.sqrt(tailX * tailX + tailY * tailY + tailZ * tailZ);
      if (length < 1e-4) {
        tailX = towardZ;
        tailY = 0;
        tailZ = -towardX;
        length = Math.sqrt(tailX * tailX + tailZ * tailZ) || 1;
      }
      rightX = tailX / length;
      rightY = tailY / length;
      rightZ = tailZ / length;
      upX = towardY * rightZ - towardZ * rightY;
      upY = towardZ * rightX - towardX * rightZ;
      upZ = towardX * rightY - towardY * rightX;
      normalX = towardX;
      normalY = towardY;
      normalZ = towardZ;
      positionX -= upX * quadHeight * 0.5;
      positionY -= upY * quadHeight * 0.5;
      positionZ -= upZ * quadHeight * 0.5;
    } else {
      // Cylindrical billboard: stands upright, turns about the vertical to face the camera.
      const horizontal = Math.sqrt(towardX * towardX + towardZ * towardZ) || 1;
      normalX = towardX / horizontal;
      normalY = 0;
      normalZ = towardZ / horizontal;
      rightX = normalZ;
      rightY = 0;
      rightZ = -normalX;
      upX = 0;
      upY = 1;
      upZ = 0;
    }
    matrices[offset] = rightX * quadWidth;
    matrices[offset + 1] = rightY * quadWidth;
    matrices[offset + 2] = rightZ * quadWidth;
    matrices[offset + 3] = 0;
    matrices[offset + 4] = upX * quadHeight;
    matrices[offset + 5] = upY * quadHeight;
    matrices[offset + 6] = upZ * quadHeight;
    matrices[offset + 7] = 0;
    matrices[offset + 8] = normalX;
    matrices[offset + 9] = normalY;
    matrices[offset + 10] = normalZ;
    matrices[offset + 11] = 0;
    matrices[offset + 12] = positionX;
    matrices[offset + 13] = positionY;
    matrices[offset + 14] = positionZ;
    matrices[offset + 15] = 1;
    const beyondFog = Math.min(1, Math.max(0, trueDistance - fogFar) / HAZE_FULL_DISTANCE);
    shapeData[slot * 4 + 2] = weight[slot];
    shapeData[slot * 4 + 3] = HAZE_NEAR + (HAZE_FAR - HAZE_NEAR) * beyondFog * beyondFog * (3 - 2 * beyondFog);
    // The whale swims toward its heading: face the quad's right when the heading points that way.
    const headingRadians = heading[slot];
    tintData[slot * 4 + 3] = Math.sin(headingRadians) * rightX - Math.cos(headingRadians) * rightZ >= 0 ? 1 : -1;
    return true;
  }

  return {
    mesh,
    capacity,
    /**
     * Takes a slot for a lure description ({ type, height, width, color, altitude?, glow?, flash? },
     * preset.lure), a seed (varies the silhouette), the spawn's anchor (a Vector3 its engine moves in
     * place) and its heading (compass radians). The lure starts hidden: setVisible(slot, true) fades it
     * in. Returns the slot, or -1 when all are taken.
     */
    acquire(lure, seed, anchor, headingRadians = 0) {
      if (!lure || !(lure.type in SHAPE_INDEX)) throw new TypeError(`[DRIFTWING] lure type must be one of ${LURE_TYPES.join(', ')}`);
      let slot = -1;
      for (let index = 0; index < capacity; index++) {
        if (!active[index]) {
          slot = index;
          break;
        }
      }
      if (slot < 0) return -1;
      active[slot] = 1;
      anchors[slot] = anchor;
      visible[slot] = 0;
      shape[slot] = SHAPE_INDEX[lure.type];
      width[slot] = lure.width;
      height[slot] = lure.height;
      altitude[slot] = lure.altitude ?? 0;
      weight[slot] = 0;
      heading[slot] = headingRadians;
      shapeData[slot * 4] = shape[slot];
      shapeData[slot * 4 + 1] = ((seed >>> 0) % 997) / 997 * 50;
      shapeData[slot * 4 + 2] = 0;
      writeColor(tintData, slot * 4, lure.color);
      tintData[slot * 4 + 3] = 1;
      // A comet is its own light: without an explicit glow it shines in its own colour.
      const glow = lure.glow !== undefined ? lure.glow : DEFAULT_GLOW[lure.type] ?? (lure.type === 'comet' ? lure.color : null);
      if (glow === null) {
        glowData[slot * 4] = 0;
        glowData[slot * 4 + 1] = 0;
        glowData[slot * 4 + 2] = 0;
      } else {
        writeColor(glowData, slot * 4, glow);
      }
      glowData[slot * 4 + 3] = lure.flash ?? DEFAULT_FLASH[lure.type] ?? 0;
      if (slot + 1 > highWater) highWater = slot + 1;
      tintAttribute.needsUpdate = true;
      glowAttribute.needsUpdate = true;
      return slot;
    },
    /** Fades the lure in (true: its spawn is at the FAR tier) or out, over FADE_SECONDS. */
    setVisible(slot, show) {
      if (slot >= 0 && slot < capacity && active[slot]) visible[slot] = show ? 1 : 0;
    },
    /** The direction the silhouette faces (the whale swims toward it), compass radians. */
    setHeading(slot, headingRadians) {
      if (slot >= 0 && slot < capacity && active[slot]) heading[slot] = headingRadians;
    },
    /** A slot's current fade weight, 0..1. */
    weightOf(slot) {
      return slot >= 0 && slot < capacity && active[slot] ? weight[slot] : 0;
    },
    release(slot) {
      if (!(slot >= 0 && slot < capacity) || !active[slot]) return;
      active[slot] = 0;
      anchors[slot] = null;
      visible[slot] = 0;
      weight[slot] = 0;
      clearSlot(slot);
      while (highWater > 0 && !active[highWater - 1]) highWater--;
    },
    /** Fades and writes every active lure for the current camera; once per frame. */
    update(realDt) {
      stats.active = 0;
      stats.drawn = 0;
      stats.projected = 0;
      if (highWater === 0) {
        if (mesh.visible) {
          mesh.visible = false;
          mesh.count = 0;
        }
        return;
      }
      const cameraElements = camera.matrixWorld.elements;
      view[0] = cameraElements[12];
      view[1] = cameraElements[13];
      view[2] = cameraElements[14];
      view[4] = scene.fog ? scene.fog.far : camera.far * 0.5;
      view[3] = view[4] * PROJECT_SHARE;
      const step = realDt / FADE_SECONDS;
      for (let slot = 0; slot < highWater; slot++) {
        if (!active[slot]) continue;
        stats.active++;
        weight[slot] = visible[slot] ? Math.min(1, weight[slot] + step) : Math.max(0, weight[slot] - step);
        if (writeSlot(slot)) stats.drawn++;
      }
      mesh.count = highWater;
      mesh.visible = stats.drawn > 0;
      mesh.instanceMatrix.needsUpdate = true;
      shapeAttribute.needsUpdate = true;
      tintAttribute.needsUpdate = true;
    },
    /** True distance (m) of a slot's lure from the camera at the last update. */
    distanceOf(slot) {
      return slot >= 0 && slot < capacity ? distance[slot] : Infinity;
    },
    getStats() {
      return { ...stats, highWater };
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
