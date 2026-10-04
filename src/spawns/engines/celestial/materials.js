// Celestial meshes and materials: built once in the engine's init() and shared by every instance.
//
// Sky objects (meteors, comets, the eclipse's moon disc and corona) are camera-facing quads on a
// shell just inside the camera's far plane, moved with the camera every frame, so they sit at
// "infinity" like the dome: terrain, clouds and weather volumes in front of them hide them through
// the depth test. They ignore fog and add light (additive blending, HDR values the bloom picks up),
// except the moon disc, which paints the sky's own colour over the sun (the dome's sky function, so
// the sunlight scattered in front of the moon stays) and turns black at totality.
//
// The rainbow volume is an instanced sphere of mist drawn from inside and out (back faces): each
// fragment measures its view ray's chord through the sphere and lights it with the rainbow's bands at
// its angle from the antisolar point (cloudShading.js shares the bands with the clouds' bow).
//
// Every mesh is an InstancedMesh with a small capacity; the engine writes the instance buffers in
// place each frame. Nothing here is WebGPU-only.
import { antisolarDegrees, bowLightNode } from '../../../render/cloudShading.js';

function dynamicAttribute(THREE, capacity, itemSize) {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function instancedMesh(THREE, geometry, material, capacity, name, renderOrder) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = renderOrder;
  return mesh;
}

function additiveMaterial(THREE) {
  return new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
}

/**
 * Meteor streaks. Per instance: look (brightness incl. fade, fireball 0..1, width ratio, seed), head
 * (rgb) and trail (rgb). The quad runs from the tail (uv.x 0) to the head (uv.x 1).
 */
export function createMeteorMesh(THREE, TSL, { capacity }) {
  const { float, vec3, uv, abs, exp, pow, mix, smoothstep, instancedBufferAttribute } = TSL;
  const look = dynamicAttribute(THREE, capacity, 4);
  const head = dynamicAttribute(THREE, capacity, 4);
  const trail = dynamicAttribute(THREE, capacity, 4);
  const lookData = instancedBufferAttribute(look);
  const headData = instancedBufferAttribute(head);
  const trailData = instancedBufferAttribute(trail);
  const material = additiveMaterial(THREE);
  const along = uv().x;
  const across = abs(uv().y.sub(0.5)).mul(2);
  // Thin at the tail, full at the head; a fireball's head is a wider, hotter ball.
  const width = mix(float(0.12), float(1), pow(along, 1.4));
  const scaled = across.div(width);
  const core = exp(scaled.mul(scaled).mul(-5));
  const headDistance = float(1).sub(along).mul(mix(float(9), float(5), lookData.y));
  const headGlow = exp(headDistance.mul(headDistance).negate()).mul(exp(across.mul(across).mul(-2.5)));
  const intensity = core.mul(pow(along, 2)).mul(0.9).add(headGlow.mul(mix(float(1.6), float(3.2), lookData.y))).mul(lookData.x);
  const colour = mix(trailData.xyz, headData.xyz, smoothstep(0.55, 1, along));
  material.colorNode = colour.mul(mix(float(1), float(1.6), lookData.y));
  material.opacityNode = intensity;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = instancedMesh(THREE, geometry, material, capacity, 'celestial-meteors', -0.5);
  return { mesh, look, head, trail, geometry, material };
}

/**
 * Comets. Per instance: look (brightness incl. visibility, curvature, ion tail, seed), dust (rgb,
 * head size as a share of the tail length) and ion (rgb, width / length). The quad runs from the
 * head (uv.x 0) along the tail (uv.x 1).
 */
export function createCometMesh(THREE, TSL, { uniforms, capacity }) {
  const { float, vec2, vec3, uv, exp, pow, max, length, smoothstep, mx_noise_float, instancedBufferAttribute } = TSL;
  const look = dynamicAttribute(THREE, capacity, 4);
  const dust = dynamicAttribute(THREE, capacity, 4);
  const ion = dynamicAttribute(THREE, capacity, 4);
  const lookData = instancedBufferAttribute(look);
  const dustData = instancedBufferAttribute(dust);
  const ionData = instancedBufferAttribute(ion);
  const material = additiveMaterial(THREE);
  const along = uv().x;
  // Across in tail-length units (the quad is aspect times as wide as long).
  const across = uv().y.sub(0.5).mul(ionData.w);
  const headSize = dustData.w;
  const toHead = length(vec2(along.sub(headSize.mul(0.9)), across));
  const comaRadius = toHead.div(headSize);
  const coma = exp(comaRadius.mul(comaRadius).mul(-2.2));
  const nucleusRadius = toHead.div(headSize.mul(0.12));
  const nucleus = exp(nucleusRadius.mul(nucleusRadius).negate());
  // The dust tail bends away from the orbit and widens; the ion tail stays straight and narrow.
  const bend = lookData.y.mul(along.mul(along)).mul(0.22);
  const dustWidth = headSize.mul(0.6).add(along.mul(0.24));
  const dustOffset = across.sub(bend).div(dustWidth);
  const fromHead = smoothstep(0, headSize.mul(1.5), along);
  const dustTail = exp(dustOffset.mul(dustOffset).mul(-2)).mul(pow(max(float(1).sub(along), 0), 1.4)).mul(fromHead);
  const ionWidth = headSize.mul(0.18).add(along.mul(0.018));
  const ionOffset = across.div(ionWidth);
  const rays = mx_noise_float(vec3(along.mul(9).sub(uniforms.time.mul(0.04)), across.mul(40), lookData.w)).mul(0.35).add(0.75);
  const ionTail = exp(ionOffset.mul(ionOffset).mul(-2)).mul(pow(max(float(1).sub(along), 0), 0.8)).mul(fromHead).mul(rays).mul(lookData.z);
  const light = dustData.xyz.mul(dustTail.mul(0.55).add(coma.mul(1.3))).add(ionData.xyz.mul(ionTail.mul(0.7))).add(vec3(1, 0.98, 0.95).mul(nucleus.mul(3)));
  material.colorNode = light;
  material.opacityNode = lookData.x;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = instancedMesh(THREE, geometry, material, capacity, 'celestial-comets', -0.5);
  return { mesh, look, dust, ion, geometry, material };
}

/**
 * The eclipse: the moon disc (a round quad painting the sky behind it, black at totality) and the
 * corona quad centred on the sun. Disc per instance: shade (blackness, unused x3). Corona per
 * instance: state (totality, bead strength, bead angle rad, moon scale), moon (offset x, y from the
 * sun centre in sun radii, seed, corona strength). The corona quad spans CORONA_EXTENT sun radii each
 * way.
 */
export const CORONA_EXTENT = 9;
export function createEclipseMeshes(THREE, TSL, { skyColorNode, uniforms, capacity }) {
  const {
    float, vec2, vec3, uv, length, exp, pow, max, cos, sin, atan, smoothstep, normalize, mix, mx_noise_float,
    positionWorld, cameraPosition, instancedBufferAttribute,
  } = TSL;
  const shade = dynamicAttribute(THREE, capacity, 4);
  const shadeData = instancedBufferAttribute(shade);
  const discMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const viewDirection = normalize(positionWorld.sub(cameraPosition));
  const skyBehind = typeof skyColorNode === 'function' ? skyColorNode(viewDirection) : uniforms.fogColor;
  const radius = length(uv().sub(0.5)).mul(2);
  discMaterial.colorNode = mix(skyBehind, vec3(0.004, 0.005, 0.008), shadeData.x);
  discMaterial.opacityNode = float(1).sub(smoothstep(0.96, 1, radius));
  const discGeometry = new THREE.PlaneGeometry(1, 1);
  const disc = instancedMesh(THREE, discGeometry, discMaterial, capacity, 'celestial-eclipse-moon', -0.45);

  const state = dynamicAttribute(THREE, capacity, 4);
  const moon = dynamicAttribute(THREE, capacity, 4);
  const stateData = instancedBufferAttribute(state);
  const moonData = instancedBufferAttribute(moon);
  const coronaMaterial = additiveMaterial(THREE);
  const point = uv().sub(0.5).mul(CORONA_EXTENT * 2);
  const fromSun = max(length(point), 0.001);
  const fromMoon = length(point.sub(moonData.xy)).div(stateData.w);
  const angle = atan(point.y, point.x);
  const streamers = mx_noise_float(vec3(cos(angle).mul(2.6), sin(angle).mul(2.6), moonData.z)).mul(0.5).add(0.5);
  const fine = mx_noise_float(vec3(cos(angle).mul(9), sin(angle).mul(9), moonData.z.add(5))).mul(0.5).add(0.5);
  const rays = pow(streamers, 2.2).mul(1.4).add(pow(fine, 3).mul(0.5)).add(0.35);
  const outside = smoothstep(1, 1.015, fromMoon);
  const falloff = pow(max(fromSun, 1), -2.6).mul(rays).add(pow(max(fromSun, 1), -6).mul(1.2));
  const edgeFade = float(1).sub(smoothstep(CORONA_EXTENT * 0.6, CORONA_EXTENT, fromSun));
  const corona = falloff.mul(outside).mul(stateData.x).mul(moonData.w).mul(edgeFade);
  // The chromosphere's thin pink rim, right at the moon's limb.
  const rim = fromMoon.sub(1).div(0.02);
  const chromosphere = exp(rim.mul(rim).negate()).mul(stateData.x).mul(outside.mul(0.6).add(0.4));
  // Baily's beads and the diamond ring: the last sliver of sun on the limb at second and third contact.
  const beadPoint = moonData.xy.add(vec2(cos(stateData.z), sin(stateData.z)).mul(stateData.w));
  const toBead = length(point.sub(beadPoint));
  const beadCore = toBead.div(0.16);
  const bead = exp(beadCore.mul(beadCore).negate()).mul(6).add(exp(toBead.div(1.1).negate()).mul(0.9)).mul(stateData.y);
  coronaMaterial.colorNode = vec3(1, 0.96, 0.9).mul(corona.mul(2.2)).add(vec3(1, 0.32, 0.42).mul(chromosphere.mul(1.6))).add(vec3(1, 0.98, 0.94).mul(bead));
  coronaMaterial.opacityNode = float(1);
  const coronaGeometry = new THREE.PlaneGeometry(1, 1);
  const coronaMesh = instancedMesh(THREE, coronaGeometry, coronaMaterial, capacity, 'celestial-eclipse-corona', -0.4);
  return { disc, shade, corona: coronaMesh, state, moon, discGeometry, coronaGeometry, discMaterial, coronaMaterial };
}

/**
 * Rainbow volumes: an instanced unit sphere per volume. Per instance: volume (centre relative to the
 * mesh anchor, radius) and bow (strength incl. fades, secondary, light 0 sun / 1 moon, unused). The
 * mesh anchor uniform follows the mesh position.
 */
export function createRainbowMesh(THREE, TSL, { uniforms, capacity }) {
  const {
    vec3, dot, sqrt, max, pow, step, normalize, mix, saturate, positionWorld, cameraPosition, instancedBufferAttribute, uniform,
  } = TSL;
  const volume = dynamicAttribute(THREE, capacity, 4);
  const bow = dynamicAttribute(THREE, capacity, 4);
  const volumeData = instancedBufferAttribute(volume);
  const bowData = instancedBufferAttribute(bow);
  const anchor = uniform(new THREE.Vector3());
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.BackSide });
  const direction = normalize(positionWorld.sub(cameraPosition));
  const centre = volumeData.xyz.add(anchor);
  const radius = volumeData.w;
  const offset = cameraPosition.sub(centre);
  const b = dot(offset, direction);
  const c = dot(offset, offset).sub(radius.mul(radius));
  const h = b.mul(b).sub(c);
  const root = sqrt(max(h, 0));
  const near = max(b.negate().sub(root), 0);
  const far = b.negate().add(root);
  const chord = max(far.sub(near), 0).mul(step(0, h));
  // Denser toward the middle of the mist.
  const density = pow(saturate(chord.div(radius.mul(2))), 0.8);
  const moonLight = bowData.z;
  const light = mix(uniforms.sunDirection, uniforms.moonDirection, moonLight);
  const degrees = antisolarDegrees(TSL, direction, light);
  const bands = bowLightNode(TSL, degrees, bowData.y);
  // A moonbow is faint and nearly white to the eye.
  const luma = dot(bands, vec3(0.2126, 0.7152, 0.0722));
  const colours = mix(bands, vec3(luma), moonLight.mul(0.6));
  const sunLight = uniforms.sunColor;
  const lightColour = mix(sunLight, vec3(0.5, 0.56, 0.68).mul(uniforms.nightFactor.mul(0.35)), moonLight);
  material.colorNode = colours.mul(lightColour).mul(0.55);
  material.opacityNode = density.mul(bowData.x);
  const geometry = new THREE.SphereGeometry(1, 32, 20);
  const mesh = instancedMesh(THREE, geometry, material, capacity, 'celestial-rainbows', 2);
  return { mesh, volume, bow, anchor, geometry, material };
}
