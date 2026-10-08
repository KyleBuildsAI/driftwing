// Weather volume meshes and materials: built once in the engine's init() and shared by every volume.
//
//   createPuffMesh     ONE instanced mesh of cloud puffs for every volume: the v1 puff geometry and
//                      light response (src/render/cloudShading.js) plus a per-puff storm shade,
//                      albedo tint and glow, aerial perspective written per puff (centre.w), and the
//                      screen-door dissolve near the camera
//   createShaftMesh    instanced open cylinders: rain, snow or dust shafts as soft streaked curtains
//                      (thicker through the middle, as a column of falling water looks)
//   createLocalRain    a field of streaks wrapped around the camera, animated entirely in the vertex
//                      stage (falling, slanted by the craft's own motion), shown inside a shaft
//   createCanopyRain   drops and streaks on the canopy (a camera-attached quad, screen space), for
//                      the cockpit and FPV views
//   createVeil         the soft whiteout while the camera is inside a volume (as the v1 clouds' veil)
//
// Nothing here is WebGPU-only: both backends run the same node materials. No per-frame allocation:
// the engine writes the instance arrays in place and flags the attributes for upload.
import { NEAR_DISSOLVE_END, NEAR_DISSOLVE_START, createCloudRadiance } from '../../../render/cloudShading.js';

/** Sky colour behind a view ray: the sky's own function, or a zenith/fog blend without a sky system. */
function skyBehindNode(TSL, skyColorNode, uniforms, direction) {
  const { mix, smoothstep, saturate } = TSL;
  if (typeof skyColorNode === 'function') return skyColorNode(direction);
  return mix(uniforms.fogColor, uniforms.skyZenithColor, smoothstep(0.03, 0.6, saturate(direction.y)));
}

function dynamicAttribute(THREE, capacity, itemSize) {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

/**
 * The shared puff mesh. Per puff: shape (flat-bottom height in puff space, group base and top world
 * y, brightness), centre (group shading centre relative to the mesh anchor, haze 0..1), tint (albedo
 * rgb, storm 0..1) and glow (rgb light added after the haze, unused). Returns { mesh, anchor, shape,
 * centre, tint, glow } (the attributes) for the engine to write.
 */
export function createPuffMesh(THREE, TSL, { geometry, look, uniforms, skyColorNode, capacity }) {
  const { vec3, max, mix, smoothstep, positionLocal, instancedBufferAttribute, screenCoordinate, interleavedGradientNoise, uniform } = TSL;
  const shape = dynamicAttribute(THREE, capacity, 4);
  const centre = dynamicAttribute(THREE, capacity, 4);
  const tint = dynamicAttribute(THREE, capacity, 4);
  const glow = dynamicAttribute(THREE, capacity, 4);
  const shapeData = instancedBufferAttribute(shape);
  const centreData = instancedBufferAttribute(centre);
  const tintData = instancedBufferAttribute(tint);
  const glowData = instancedBufferAttribute(glow);
  const anchor = uniform(new THREE.Vector3());

  const material = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 1, metalness: 0, fog: false });
  material.lights = false;
  // The flat bottom is clamped in puff space, as in the v1 field (clouds.js explains why).
  material.positionNode = vec3(positionLocal.x, max(positionLocal.y, shapeData.x), positionLocal.z);
  const { radiance, viewRay, cameraDistance } = createCloudRadiance(TSL, {
    look, uniforms, shape: shapeData, centre: centreData, anchor, storm: tintData.w, tint: tintData.xyz,
  });
  const hazed = mix(radiance, skyBehindNode(TSL, skyColorNode, uniforms, viewRay), centreData.w);
  // Glow (noctilucent clouds lit from below the horizon) carries through the haze.
  material.colorNode = hazed.add(glowData.xyz.mul(centreData.w.mul(-0.5).add(1)));
  material.maskNode = interleavedGradientNoise(screenCoordinate.xy).lessThan(smoothstep(NEAR_DISSOLVE_START, NEAR_DISSOLVE_END, cameraDistance));

  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'weather-volume-puffs';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, anchor, shape, centre, tint, glow, material };
}

/**
 * Instanced rain shafts: an open unit cylinder (y 0..1) per shaft, sheared by its lean. Per shaft:
 * data (density, fall speed m/s, kind 0 rain / 1 snow / 2 dust, haze 0..1) and colour (tint rgb,
 * seed). Returns { mesh, anchor, data, colour }.
 */
export function createShaftMesh(THREE, TSL, { look, uniforms, skyColorNode, capacity }) {
  const {
    float, vec3, uv, abs, dot, normalize, mix, smoothstep, step, pow, positionWorld, cameraPosition, normalWorld,
    instancedBufferAttribute, mx_noise_float, uniform,
  } = TSL;
  const data = dynamicAttribute(THREE, capacity, 4);
  const colour = dynamicAttribute(THREE, capacity, 4);
  const shaftData = instancedBufferAttribute(data);
  const shaftColour = instancedBufferAttribute(colour);
  const anchor = uniform(new THREE.Vector3());

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const viewDirection = normalize(positionWorld.sub(cameraPosition));
  // A column of falling water is thickest through its middle: opacity follows the chord length.
  const thickness = pow(abs(dot(normalize(normalWorld), viewDirection)), 0.6);
  const around = uv().x;
  const up = uv().y;
  const fall = uniforms.time.mul(shaftData.y).div(420);
  // The streak noise runs on the WORLD height (positionWorld is render frame, src/core/origin.js).
  const worldHeight = positionWorld.y.add(uniforms.renderOrigin.y);
  const streaks = mx_noise_float(vec3(around.mul(26), worldHeight.div(420).add(fall), shaftColour.w)).mul(0.5).add(0.5);
  const fine = mx_noise_float(vec3(around.mul(90), worldHeight.div(90).add(fall.mul(4.6)), shaftColour.w.add(7))).mul(0.5).add(0.5);
  const texture = streaks.mul(0.65).add(fine.mul(0.35));
  const verticalFade = smoothstep(0, 0.06, up).mul(float(1).sub(smoothstep(0.78, 1, up)));
  const kind = shaftData.z;
  // Rain: blue-grey curtains from the shadow palette; snow: pale; dust: warm ochre in the sunlight.
  const rainColour = look.shadeColor.mul(1.55).add(look.litColor.mul(0.1));
  const snowColour = look.shadeColor.mul(1.9).add(look.litColor.mul(0.45));
  const dustColour = look.shadeColor.mul(1.2).add(look.litColor.mul(0.35)).mul(vec3(1.25, 0.95, 0.62));
  const base = mix(mix(rainColour, snowColour, step(0.5, kind)), dustColour, step(1.5, kind)).mul(shaftColour.xyz);
  const skyBehind = skyBehindNode(TSL, skyColorNode, uniforms, viewDirection);
  material.colorNode = mix(base, skyBehind, shaftData.w);
  // Double-sided: the near and far walls both draw, so each carries a little over half the column.
  material.opacityNode = shaftData.x.mul(thickness).mul(texture.mul(0.55).add(0.45)).mul(verticalFade).mul(float(1).sub(shaftData.w.mul(0.6))).mul(0.8);

  const geometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  geometry.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'weather-volume-shafts';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // After the opaque world and the lures (render order 1), before the near effects.
  mesh.renderOrder = 2;
  return { mesh, anchor, data, colour, geometry, material };
}

/**
 * Streaks falling around the camera inside a shaft: count quads whose world position is wrapped into
 * a box around the camera, so the field is world-fixed, never runs out and costs no CPU. Uniforms:
 * intensity (0..1), offset (m: the fall and the wind integrated over time, wrapped to the box),
 * relative (m/s, the fall minus the craft's velocity: the streak's direction and length on screen),
 * kind (0 rain, 1 snow, 2 dust), light (colour). Returns { mesh, uniforms }.
 */
export function createLocalRain(THREE, TSL, { count, box }) {
  const {
    float, vec3, floor, normalize, cross, length, mix, smoothstep, step, attribute, cameraPosition, uniform, max, clamp,
  } = TSL;
  const corners = new Float32Array(count * 4 * 2);
  const seeds = new Float32Array(count * 4 * 4);
  const index = new Uint32Array(count * 6);
  let state = 0x9e3779b9;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const CORNERS = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
  for (let quad = 0; quad < count; quad++) {
    const seed = [random(), random(), random(), random()];
    for (let corner = 0; corner < 4; corner++) {
      const vertex = quad * 4 + corner;
      corners[vertex * 2] = CORNERS[corner][0];
      corners[vertex * 2 + 1] = CORNERS[corner][1];
      seeds.set(seed, vertex * 4);
    }
    index.set([quad * 4, quad * 4 + 1, quad * 4 + 2, quad * 4, quad * 4 + 2, quad * 4 + 3], quad * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(corners, 2));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
  // position is required by three's bounds and draw-range code; the vertex stage ignores it.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const controls = {
    intensity: uniform(0),
    offset: uniform(new THREE.Vector3(0, 0, 0)),
    relative: uniform(new THREE.Vector3(0, -9, 0)),
    kind: uniform(0),
    light: uniform(new THREE.Color(0.6, 0.64, 0.7)),
  };
  const boxSize = vec3(box[0], box[1], box[2]);
  const seed = attribute('seed', 'vec4');
  const corner = attribute('corner', 'vec2');
  // World-fixed positions wrapped into the box around the camera (x - size * floor(x / size) wraps
  // the same way on both backends). cameraPosition is render frame, so the vertices are too: the
  // engine keeps the mesh at the render origin and folds the origin into the offset uniform.
  const moving = seed.xyz.mul(boxSize).add(controls.offset).sub(cameraPosition);
  const wrapped = moving.sub(boxSize.mul(floor(moving.div(boxSize)))).sub(boxSize.mul(0.5));
  const centre = cameraPosition.add(wrapped);
  const speed = length(controls.relative);
  const axis = normalize(controls.relative.add(vec3(0, -0.001, 0)));
  const toCamera = normalize(centre.sub(cameraPosition));
  const side = normalize(cross(axis, toCamera));
  const snow = step(0.5, controls.kind).mul(float(1).sub(step(1.5, controls.kind)));
  // Rain streaks stretch with the relative speed (a 1/30 s exposure); snowflakes stay short.
  const streakLength = mix(clamp(speed.mul(0.035), 0.5, 7), clamp(speed.mul(0.012), 0.12, 1.4), snow);
  const width = mix(float(0.018), float(0.07), snow).mul(seed.w.mul(0.6).add(0.7));
  const vertex = centre.add(axis.mul(corner.y.sub(0.5).mul(streakLength))).add(side.mul(corner.x.mul(width)));
  const distance = length(wrapped);
  const nearFade = smoothstep(1.5, 5, distance);
  const reach = Math.min(box[0], box[2]);
  const farFade = float(1).sub(smoothstep(reach * 0.3, reach * 0.5, distance));
  const tip = corner.y.mul(0.8).add(0.2);
  const presence = step(float(1).sub(controls.intensity), seed.w);

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
  material.positionNode = vertex;
  const dustTint = vec3(1.2, 0.95, 0.66);
  material.colorNode = mix(mix(controls.light.mul(1.15), controls.light.mul(1.6), snow), controls.light.mul(dustTint), step(1.5, controls.kind));
  material.opacityNode = max(controls.intensity, 0).mul(presence).mul(nearFade).mul(farFade).mul(mix(tip.mul(0.34), float(0.55), snow));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'weather-volume-local-rain';
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 5;
  return { mesh, uniforms: controls, geometry, material };
}

/**
 * Rain on the canopy (cockpit and FPV views): a camera-attached quad drawing two layers of drops in
 * screen space. Slow flight lets them bead and run down; with airspeed they streak back along the
 * flow. Uniforms: amount (0..1), flow (unit screen direction the drops run, y down), shift (the flow
 * integrated over time, in screen heights), stretch, light (colour). Returns { mesh, uniforms }.
 */
export function createCanopyRain(THREE, TSL) {
  const {
    Fn, float, vec2, vec3, screenUV, screenSize, floor, fract, dot, length, smoothstep, step, max, mix, hash, uniform, clamp, abs,
  } = TSL;
  const controls = {
    amount: uniform(0),
    flow: uniform(new THREE.Vector2(0, 1)),
    shift: uniform(new THREE.Vector2(0, 0)),
    stretch: uniform(1),
    light: uniform(new THREE.Color(0.7, 0.74, 0.8)),
  };
  const aspect = screenSize.x.div(max(screenSize.y, 1));
  const point = vec2(screenUV.x.mul(aspect), screenUV.y);

  /** One layer of drops: vec2(body, highlight) coverage at the pixel. */
  const dropLayer = Fn(([position, scale, speed, size, seedOffset, density]) => {
    const grid = position.mul(scale).sub(controls.shift.mul(speed));
    const cell = floor(grid);
    const local = fract(grid);
    const key = cell.x.add(cell.y.mul(57.31)).add(seedOffset);
    const centre = vec2(hash(key).mul(0.6).add(0.2), hash(key.add(11.3)).mul(0.6).add(0.2));
    const offset = local.sub(centre);
    const along = dot(offset, controls.flow);
    const across = dot(offset, vec2(controls.flow.y, controls.flow.x.negate()));
    const radius = hash(key.add(23.7)).mul(0.6).add(0.4).mul(size);
    const present = step(float(1).sub(controls.amount.mul(density)), hash(key.add(41.9)));
    const shape = length(vec2(along.div(controls.stretch), across));
    const body = float(1).sub(smoothstep(radius.mul(0.55), radius, shape)).mul(present);
    // The trail a running drop leaves behind it.
    const trail = float(1).sub(smoothstep(0, radius.mul(0.35), abs(across))).mul(smoothstep(0, radius.mul(6).mul(controls.stretch), along.negate())).mul(step(along, 0)).mul(present).mul(0.35);
    // A drop refracts the bright sky upside down: its lower rim catches the light.
    const shine = float(1).sub(smoothstep(0, radius.mul(0.32), length(offset.sub(vec2(radius.mul(-0.18), radius.mul(0.42)))))).mul(present);
    return vec2(max(body, trail), shine);
  });
  const moving = dropLayer(point, float(7), float(0.55), float(0.12), float(3.1), float(0.45));
  const beads = dropLayer(point, float(21), float(0.08), float(0.16), float(17.9), float(0.55));
  const body = clamp(moving.x.add(beads.x.mul(0.8)), 0, 1);
  const shine = clamp(moving.y.add(beads.y.mul(0.5)), 0, 1);

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false });
  material.colorNode = mix(controls.light.mul(0.42), controls.light.mul(1.5).add(vec3(0.04)), shine);
  material.opacityNode = controls.amount.mul(body.mul(0.3).add(shine.mul(0.34)).add(0.03));
  const geometry = new THREE.PlaneGeometry(16, 16);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'weather-volume-canopy-rain';
  mesh.position.set(0, 0, -1.2);
  mesh.frustumCulled = false;
  mesh.visible = false;
  // Over the v1 in-cloud veil (1000): the drops sit on the canopy, nearer than any cloud.
  mesh.renderOrder = 1001;
  return { mesh, uniforms: controls, geometry, material };
}

/** The in-volume veil: a camera-attached quad of the cloud colour. Returns { mesh, uniforms }. */
export function createVeil(THREE, TSL) {
  const { uniform } = TSL;
  const controls = { opacity: uniform(0), colour: uniform(new THREE.Color(1, 1, 1)) };
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false });
  material.colorNode = controls.colour;
  material.opacityNode = controls.opacity;
  const geometry = new THREE.PlaneGeometry(16, 16);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'weather-volume-veil';
  mesh.position.set(0, 0, -1.25);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 1000;
  return { mesh, uniforms: controls, geometry, material };
}
