// Night-sky meshes of the celestial engine (Phase 3: the blood moon, the green flash, noctilucent
// clouds and the Milky Way core). Built once in the engine's init() and shared by every instance, like
// celestial/materials.js; an instance only takes slots in them.
//
// Two shapes, both drawn at "infinity" (on the sky shell just inside the camera's far plane, moved
// with the camera every frame), so terrain, clouds and weather volumes in front hide them through the
// depth test. They ignore fog and add light (additive blending, HDR values the bloom picks up):
//   quads    camera-facing sky quads the engine writes with writeSkyQuad (celestialEngine.js): the
//            lunar eclipse's halo and limb around the dome's moon disc, the green flash on the sun
//   spheres  instanced unit spheres (or a band of one) scaled to the shell and seen from inside: every
//            fragment turns its own view direction into the pattern's frame, so the geometry only
//            covers the sky (the noctilucent band over the sun's azimuth, the whole galactic band)
// Every pattern samples a cheap hashed value noise (a real shader function, so each program links
// with one small body; MaterialX Perlin noise made the sky dome the slowest program to link on the
// WebGL2 fallback). Nothing here is WebGPU-only.
import { GALAXY_POLE } from '../../../render/sky.js';

/** The green flash quad spans this many sun radii each way from the sun's centre. */
export const GREEN_FLASH_EXTENT = 3;
/** The noctilucent band's geometry: elevations from NOCTILUCENT_LOW to NOCTILUCENT_HIGH (rad). */
const NOCTILUCENT_LOW = -0.06;
const NOCTILUCENT_HIGH = 0.72;

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

function additiveMaterial(THREE, side) {
  return new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side });
}

/** A shader value noise in [0, 1] (trilinear over hashed lattice corners), one shared function body. */
function createValueNoise(TSL) {
  const { Fn, vec3, fract, floor, dot, mix } = TSL;
  const hash13 = Fn(([point]) => {
    const scaled = fract(point.mul(0.1031));
    const mixed = scaled.add(dot(scaled, scaled.zyx.add(31.32)));
    return fract(mixed.x.add(mixed.y).mul(mixed.z));
  });
  return Fn(([pointInput]) => {
    const point = vec3(pointInput).toVar();
    const cell = floor(point).toVar();
    const local = fract(point);
    const blend = local.mul(local).mul(local.mul(-2.0).add(3.0)).toVar();
    const corner = (x, y, z) => hash13(cell.add(vec3(x, y, z)));
    const low = mix(mix(corner(0, 0, 0), corner(1, 0, 0), blend.x), mix(corner(0, 1, 0), corner(1, 1, 0), blend.x), blend.y);
    const high = mix(mix(corner(0, 0, 1), corner(1, 0, 1), blend.x), mix(corner(0, 1, 1), corner(1, 1, 1), blend.x), blend.y);
    return mix(low, high, blend.z);
  }).setLayout({ name: 'celestialValueNoise', type: 'float', inputs: [{ name: 'pointInput', type: 'vec3' }] });
}

/**
 * The galactic band's frame in the star frame (unit THREE.Vector3s): pole (the band's normal, the sky's
 * GALAXY_POLE), core (the Milky Way core at longitude 0: the star-frame direction (0, 0.35, 1), south
 * and a little up at midnight, moved onto the band) and side (pole x core). The engine turns a
 * longitude into the core's sky direction with the same frame.
 */
export function galacticFrame(THREE) {
  const pole = new THREE.Vector3(GALAXY_POLE[0], GALAXY_POLE[1], GALAXY_POLE[2]).normalize();
  const reference = new THREE.Vector3(0, 0.35, 1).normalize();
  const core = reference.clone().addScaledVector(pole, -reference.dot(pole)).normalize();
  const side = new THREE.Vector3().crossVectors(pole, core).normalize();
  return { pole, core, side };
}

/** The sine of a view direction's height above the rendered horizon (the curvature's dip included). */
function aboveHorizon(TSL, uniforms, direction) {
  return direction.y.add(TSL.sin(uniforms.horizonDip ?? TSL.float(0)));
}

/**
 * The night-sky meshes. Returns { lunar, flash, noctilucent, galaxy, starMatrix, geometries,
 * materials, meshes, attributeLists } where each mesh record holds its InstancedMesh and its per-
 * instance attributes:
 *   lunar        look (glow, rim, rim angle rad, seed), tint (rgb, halo radius in moon radii)
 *   flash        look (rim, flash, unused, seed), tint (rgb, unused)
 *   noctilucent  look (strength, drift phase, seed, top elevation sine), tint (rgb, azimuth spread rad)
 *   galaxy       look (strength, dust, core, width), extra (core longitude rad, seed, unused x2)
 * starMatrix is the uniform the engine sets every frame exactly as the sky sets its own (a rotation
 * about the celestial pole by -dayTime turns), so the core lies on the star field's band.
 */
export function createNightSkyMeshes(THREE, TSL, { uniforms, capacity }) {
  const {
    float, vec2, vec3, uv, length, exp, pow, abs, max, min, mix, smoothstep, sin, cos, atan, dot, normalize, clamp, uniform,
    positionWorld, cameraPosition, instancedBufferAttribute,
  } = TSL;
  const noise = createValueNoise(TSL);
  const direction = normalize(positionWorld.sub(cameraPosition));
  const above = aboveHorizon(TSL, uniforms, direction);
  const geometries = [];
  const materials = [];

  // ---- The lunar eclipse: a copper halo and the bright limb on the side leaving the umbra --------
  const lunarLook = dynamicAttribute(THREE, capacity, 4);
  const lunarTint = dynamicAttribute(THREE, capacity, 4);
  const lunarLookData = instancedBufferAttribute(lunarLook);
  const lunarTintData = instancedBufferAttribute(lunarTint);
  const lunarMaterial = additiveMaterial(THREE, THREE.DoubleSide);
  {
    const point = uv().sub(0.5).mul(lunarTintData.w.mul(2));
    const radius = length(point);
    const outside = smoothstep(0.98, 1.06, radius);
    const haloFade = float(1).sub(smoothstep(lunarTintData.w.mul(0.55), lunarTintData.w, radius));
    const halo = exp(radius.sub(1).mul(-0.85)).mul(outside).mul(haloFade);
    const rimDirection = vec2(cos(lunarLookData.z), sin(lunarLookData.z));
    const inside = float(1).sub(smoothstep(0.94, 1.0, radius));
    const crescent = smoothstep(0.35, 0.95, dot(point, rimDirection)).mul(inside);
    lunarMaterial.colorNode = lunarTintData.xyz.mul(halo.mul(lunarLookData.x).mul(0.32)).add(vec3(1.0, 0.6, 0.3).mul(crescent.mul(lunarLookData.y).mul(0.55)));
    lunarMaterial.opacityNode = smoothstep(-0.003, 0.004, above);
  }
  const lunarGeometry = new THREE.PlaneGeometry(1, 1);
  const lunarMesh = instancedMesh(THREE, lunarGeometry, lunarMaterial, capacity, 'celestial-lunar-eclipse', -0.48);
  geometries.push(lunarGeometry);
  materials.push(lunarMaterial);

  // ---- The green flash: the green upper limb, the detached sliver and the flash itself ----------
  const flashLook = dynamicAttribute(THREE, capacity, 4);
  const flashTint = dynamicAttribute(THREE, capacity, 4);
  const flashLookData = instancedBufferAttribute(flashLook);
  const flashTintData = instancedBufferAttribute(flashTint);
  const flashMaterial = additiveMaterial(THREE, THREE.DoubleSide);
  {
    // Sun radii, y up (the quad's across axis is the world's up at the sun).
    const point = uv().sub(0.5).mul(GREEN_FLASH_EXTENT * 2);
    const radius = max(length(point), 0.001);
    const limb = radius.sub(1).div(0.085);
    const upper = smoothstep(0.15, 0.85, point.y.div(radius));
    const rim = exp(limb.mul(limb).negate()).mul(upper);
    // The mirage sliver: a thin strip lifted just off the top of the disc.
    const stripY = point.y.sub(1.06).div(0.07);
    const strip = exp(stripY.mul(stripY).negate()).mul(float(1).sub(smoothstep(0.3, 0.85, abs(point.x))));
    const fromTop = length(point.sub(vec2(0, 1)));
    const flash = exp(fromTop.mul(fromTop).mul(-5)).mul(2.2).add(exp(fromTop.mul(-1.3)).mul(0.5));
    const light = rim.mul(1.5).add(strip.mul(1.1)).mul(flashLookData.x).add(flash.mul(flashLookData.y));
    flashMaterial.colorNode = flashTintData.xyz.mul(light);
    // Only above the horizon line: the ocean hides the rest of the quad.
    flashMaterial.opacityNode = smoothstep(-0.0004, 0.0012, above);
  }
  const flashGeometry = new THREE.PlaneGeometry(1, 1);
  const flashMesh = instancedMesh(THREE, flashGeometry, flashMaterial, capacity, 'celestial-green-flash', -0.42);
  geometries.push(flashGeometry);
  materials.push(flashMaterial);

  // ---- Noctilucent clouds: rippled electric-blue sheets low over the sun's azimuth ---------------
  const noctilucentLook = dynamicAttribute(THREE, capacity, 4);
  const noctilucentTint = dynamicAttribute(THREE, capacity, 4);
  const noctilucentLookData = instancedBufferAttribute(noctilucentLook);
  const noctilucentTintData = instancedBufferAttribute(noctilucentTint);
  const noctilucentMaterial = additiveMaterial(THREE, THREE.BackSide);
  {
    const sun = uniforms.sunDirection;
    const sunHorizontal = normalize(vec2(sun.x, sun.z).add(vec2(0.0001, 0)));
    const viewHorizontal = normalize(vec2(direction.x, direction.z).add(vec2(0.0001, 0)));
    const azimuth = atan(viewHorizontal.x.mul(sunHorizontal.y).sub(viewHorizontal.y.mul(sunHorizontal.x)), dot(viewHorizontal, sunHorizontal));
    // A sheet ~80 km up seen from below: the plane through the view ray, so the pattern foreshortens
    // toward the horizon as a real layer does.
    const plane = vec2(direction.x, direction.z).div(max(above, 0.015));
    const towardSun = dot(plane, sunHorizontal);
    const acrossSun = plane.x.mul(sunHorizontal.y).sub(plane.y.mul(sunHorizontal.x));
    const phase = noctilucentLookData.y;
    const seed = noctilucentLookData.z;
    const base = noise(vec3(towardSun.mul(1.1), acrossSun.mul(1.1), phase.mul(0.04).add(seed)));
    const detail = noise(vec3(towardSun.mul(5.5), acrossSun.mul(5.5), seed.add(7.3)));
    const ripples = sin(towardSun.mul(11).add(acrossSun.mul(3)).add(base.mul(6)).add(phase)).mul(0.5).add(0.5);
    const billows = smoothstep(0.32, 0.9, base.add(detail.mul(0.35)));
    const density = billows.mul(mix(float(0.5), float(1), pow(ripples, 1.5)));
    const low = smoothstep(0.004, 0.05, above);
    const high = float(1).sub(smoothstep(noctilucentLookData.w.mul(0.55), noctilucentLookData.w, above));
    const sideways = float(1).sub(smoothstep(noctilucentTintData.w.mul(0.5), noctilucentTintData.w, abs(azimuth)));
    const towardGlow = mix(float(0.55), float(1), exp(azimuth.mul(azimuth).mul(-2)));
    const sheen = mix(noctilucentTintData.xyz, vec3(0.9, 0.97, 1.0), pow(density, 3).mul(0.55));
    noctilucentMaterial.colorNode = sheen.mul(density.mul(low).mul(high).mul(sideways).mul(towardGlow).mul(noctilucentLookData.x).mul(1.1));
    noctilucentMaterial.opacityNode = float(1);
  }
  const noctilucentGeometry = new THREE.SphereGeometry(1, 48, 10, 0, Math.PI * 2, Math.PI / 2 - NOCTILUCENT_HIGH, NOCTILUCENT_HIGH - NOCTILUCENT_LOW);
  const noctilucentMesh = instancedMesh(THREE, noctilucentGeometry, noctilucentMaterial, capacity, 'celestial-noctilucent', -0.7);
  geometries.push(noctilucentGeometry);
  materials.push(noctilucentMaterial);

  // ---- The Milky Way core: bulge, star clouds and dark dust lanes along the star field's band ----
  const starMatrix = uniform(new THREE.Matrix3());
  const galaxyLook = dynamicAttribute(THREE, capacity, 4);
  const galaxyExtra = dynamicAttribute(THREE, capacity, 4);
  const galaxyLookData = instancedBufferAttribute(galaxyLook);
  const galaxyExtraData = instancedBufferAttribute(galaxyExtra);
  const galaxyMaterial = additiveMaterial(THREE, THREE.BackSide);
  {
    // The band's frame in the star frame: its pole N, the core's direction C0 at longitude 0 and
    // B0 = N x C0 (galacticFrame; at midnight C0 stands about 38 degrees up in the south-east).
    const { pole, core: core0, side: side0 } = galacticFrame(THREE);
    const N = vec3(pole.x, pole.y, pole.z);
    const C0 = vec3(core0.x, core0.y, core0.z);
    const B0 = vec3(side0.x, side0.y, side0.z);
    const star = starMatrix.mul(direction);
    const longitude0 = galaxyExtraData.x;
    const coreAxis = C0.mul(cos(longitude0)).add(B0.mul(sin(longitude0)));
    const sideAxis = B0.mul(cos(longitude0)).sub(C0.mul(sin(longitude0)));
    const latitude = dot(star, N);
    const longitude = atan(dot(star, sideAxis), dot(star, coreAxis));
    const width = float(0.075).add(exp(longitude.mul(longitude).mul(-3.2)).mul(0.11)).mul(galaxyLookData.w);
    const across = latitude.div(width);
    const band = exp(across.mul(across).negate());
    const bulge = exp(longitude.div(0.3).mul(longitude.div(0.3)).add(latitude.div(0.15).mul(latitude.div(0.15))).negate());
    const seed = galaxyExtraData.y;
    const clouds = noise(star.mul(6.5).add(seed)).mul(0.65).add(noise(star.mul(15).add(seed.add(3.1))).mul(0.35));
    const grain = noise(star.mul(52).add(seed.add(9.7)));
    // The Great Rift: a dark lane wandering along the band's middle, widest toward the core, plus
    // patchy dust clouds.
    const laneCentre = sin(longitude.mul(3.1).add(seed)).mul(0.012).add(noise(star.mul(4.2).add(seed.add(5.5))).sub(0.5).mul(0.035));
    const laneAcross = latitude.sub(laneCentre).div(width.mul(0.3));
    const laneReach = smoothstep(-2.2, -0.4, longitude).mul(float(1).sub(smoothstep(0.5, 2.0, longitude)));
    const lane = exp(laneAcross.mul(laneAcross).negate()).mul(laneReach);
    // Filaments: the thin zero crossings of a noise field, so the dust reads as threads, not blobs.
    const filaments = float(1).sub(smoothstep(0.0, 0.05, abs(noise(star.mul(14).add(seed.add(12.4))).sub(0.5))));
    const patches = filaments.mul(band).mul(smoothstep(0.35, 0.7, noise(star.mul(3.3).add(seed.add(2.2)))));
    const dust = clamp(lane.mul(0.9).add(patches.mul(0.55)), 0, 0.95).mul(galaxyLookData.y);
    const light = band.mul(pow(clouds, 1.6).mul(0.85).add(0.2)).mul(grain.mul(0.5).add(0.75)).add(bulge.mul(galaxyLookData.z).mul(1.3)).mul(float(1).sub(dust));
    const colour = mix(vec3(0.6, 0.68, 1.0), vec3(1.0, 0.8, 0.58), min(bulge.mul(1.4).add(0.12), 1));
    const horizonFade = smoothstep(0.0, 0.2, above);
    galaxyMaterial.colorNode = colour.mul(light).mul(horizonFade).mul(galaxyLookData.x).mul(0.22);
    galaxyMaterial.opacityNode = float(1);
  }
  const galaxyGeometry = new THREE.SphereGeometry(1, 48, 24);
  const galaxyMesh = instancedMesh(THREE, galaxyGeometry, galaxyMaterial, capacity, 'celestial-galaxy', -0.8);
  geometries.push(galaxyGeometry);
  materials.push(galaxyMaterial);

  return {
    lunar: { mesh: lunarMesh, look: lunarLook, tint: lunarTint },
    flash: { mesh: flashMesh, look: flashLook, tint: flashTint },
    noctilucent: { mesh: noctilucentMesh, look: noctilucentLook, tint: noctilucentTint },
    galaxy: { mesh: galaxyMesh, look: galaxyLook, extra: galaxyExtra },
    starMatrix,
    geometries,
    materials,
    meshes: [lunarMesh, flashMesh, noctilucentMesh, galaxyMesh],
  };
}
