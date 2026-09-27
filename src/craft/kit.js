// Craft modelling kit: the procedural mesh tools v1 built its glider with (flat-shaded,
// vertex-coloured lofts in the v1 palette), the materials every craft shares (sunlit body with a
// warm backlit rim, tinted glass), nav lights with a strobe and the prop disc. Craft modules only
// describe their shapes; everything here is the v1 code, moved.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { DEG, clamp } from '../core/util.js';

const { uniform, color, float, uv, length, saturate, pow, smoothstep, mix, dot, normalize, normalView, positionView, cameraViewMatrix } = TSL;

export const PALETTE = Object.freeze({
  cream: new THREE.Color(0xf1e4cf),
  creamShade: new THREE.Color(0xe6d4b8),
  orange: new THREE.Color(0xe0703a),
  charcoal: new THREE.Color(0x2c2f38),
});

export function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Collects flat-shaded, vertex-coloured triangles; local frame: nose -z, up +y. */
export function createMeshBuilder() {
  const positions = [];
  const colors = [];
  const edgeB = new THREE.Vector3();
  const edgeC = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const outward = new THREE.Vector3();

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
    const geometry = new THREE.BufferGeometry();
    const positionArray = new Float32Array(positions);
    if (pivot) {
      for (let index = 0; index < positionArray.length; index += 3) {
        positionArray[index] -= pivot[0];
        positionArray[index + 1] -= pivot[1];
        positionArray[index + 2] -= pivot[2];
      }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
  return { triangle, quad, loft, toGeometry };
}

/** Airfoil / section points from [along, across] pairs scaled by chord and thickness. */
export function profileSection(profile, leadingEdge, chordDirection, thicknessDirection, chord, thickness) {
  return profile.map(([along, across]) => [
    leadingEdge[0] + chordDirection[0] * along * chord + thicknessDirection[0] * across * thickness * chord,
    leadingEdge[1] + chordDirection[1] * along * chord + thicknessDirection[1] * across * thickness * chord,
    leadingEdge[2] + chordDirection[2] * along * chord + thicknessDirection[2] * across * thickness * chord,
  ]);
}

/** Linear interpolation through [x, y] points (clamped at both ends). */
export function piecewise(points, x) {
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

export function mirrorPoint(point, side) {
  return [point[0] * side, point[1], point[2]];
}

/** Ring of points around the z axis at z (elliptical, `sides` corners starting at startDegrees). */
export function ellipseRing(z, centreY, halfWidth, halfHeight, sides, startDegrees = 0) {
  const ring = [];
  for (let index = 0; index < sides; index++) {
    const angle = (startDegrees + (index * 360) / sides) * DEG;
    ring.push([halfWidth * Math.cos(angle), centreY + halfHeight * Math.sin(angle), z]);
  }
  return ring;
}

// ---- Shared materials (one set per game context, so every craft reuses the compiled pipelines) ----
const sharedMaterials = new WeakMap();

/**
 * Body: vertex colours with a warm sun rim when backlit (flying into a low sun: key-art edge glow).
 * Canopy: tinted glass that picks up the sky at grazing angles and dims at night.
 */
export function getCraftMaterials(ctx) {
  const cached = sharedMaterials.get(ctx);
  if (cached) return cached;
  const uniforms = ctx.uniforms;
  const bodyMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0 });
  const canopyMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x1d2c3a, flatShading: true, roughness: 0.36, metalness: 0.05 });
  const viewDirection = normalize(positionView.negate());
  const facing = saturate(dot(normalView, viewDirection));
  {
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
  const materials = { body: bodyMaterial, canopy: canopyMaterial };
  sharedMaterials.set(ctx, materials);
  return materials;
}

export function addSolid(parent, geometry, material) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** A control surface part { geometry, pivot, axis } mounted on a pivot group at its hinge. */
export function addPivot(root, part, material) {
  const pivot = new THREE.Group();
  pivot.position.set(part.pivot[0], part.pivot[1], part.pivot[2]);
  pivot.userData.axis = part.axis;
  addSolid(pivot, part.geometry, material);
  root.add(pivot);
  return pivot;
}

// ---- Prop disc: a soft blurred band that thickens with prop speed -------------------------------
export function createPropDisc(radius) {
  const opacity = uniform(0.1);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const distance = length(uv().sub(0.5)).mul(2);
  const band = smoothstep(float(0.2), float(0.32), distance).mul(float(1).sub(smoothstep(float(0.9), float(1), distance)));
  material.colorNode = color(0x3a3d46);
  material.opacityNode = band.mul(distance.mul(0.5).add(0.5)).mul(opacity);
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), material);
  mesh.renderOrder = 2;
  return {
    mesh,
    /** v1 blur: faint at idle, a soft band at speed; hidden while the prop is stopped. */
    setSpeed(propSpeed) {
      opacity.value = propSpeed > 0 ? 0.05 + 0.3 * smooth01((propSpeed - 8) / 24) : 0;
    },
  };
}

// ---- Nav lights: a tiny HDR bulb (bloom adds a soft halo) plus a small additive glow sprite whose
// energy sits in a tight core (~0.3 m) with a faint tail to the sprite edge. ------------------------
const NAV_GLOW = Object.freeze({ DAY_SCALE: 0.9, NIGHT_SCALE: 1.8, STROBE_SCALE: 1.7 });
const STROBE_FLASH_SECONDS = 0.09;
const STROBE_PERIOD = 1.3;

function createNavMaterial(hex, intensityNode) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = color(hex).mul(intensityNode);
  return material;
}
function createGlowMaterial(hex, strengthNode) {
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const radial = saturate(float(1).sub(length(uv().sub(0.5)).mul(2)));
  const core = pow(radial, float(6));
  const tail = pow(radial, float(2)).mul(0.12);
  material.colorNode = color(hex);
  material.opacityNode = core.add(tail).mul(strengthNode);
  return material;
}

/**
 * Adds red (left tip), green (right tip) and a white tail strobe to root. Each spec is
 * { position: [x, y, z], glow: [x, y, z] }. animate(time) reads { elapsed, nightFactor, sunElevation }.
 */
export function createNavLights(root, specs) {
  const navIntensity = uniform(2.2);
  const strobeIntensity = uniform(0.5);
  const glowStrength = uniform(0.1);
  const strobeGlowStrength = uniform(0);
  const lights = [
    { hex: 0xff3524, spec: specs.red, intensity: navIntensity, strength: glowStrength },
    { hex: 0x2dff7a, spec: specs.green, intensity: navIntensity, strength: glowStrength },
    { hex: 0xfff4e6, spec: specs.strobe, intensity: strobeIntensity, strength: strobeGlowStrength },
  ];
  const bulbGeometry = new THREE.OctahedronGeometry(0.075, 0);
  const glowSprites = lights.map((light) => {
    const bulb = new THREE.Mesh(bulbGeometry, createNavMaterial(light.hex, light.intensity));
    bulb.position.set(light.spec.position[0], light.spec.position[1], light.spec.position[2]);
    root.add(bulb);
    const sprite = new THREE.Sprite(createGlowMaterial(light.hex, light.strength));
    sprite.position.set(light.spec.glow[0], light.spec.glow[1], light.spec.glow[2]);
    sprite.renderOrder = 6;
    root.add(sprite);
    return sprite;
  });

  return {
    /** Small points of light: brighter and slightly wider glow from dusk on; strobe = short blink. */
    animate(time) {
      const night = clamp(time.nightFactor ?? 0, 0, 1);
      const dusk = Math.max(night, 1 - smooth01(((time.sunElevation ?? 30) + 2) / 10));
      navIntensity.value = 2.2 + 2.8 * dusk;
      glowStrength.value = 0.12 + 0.5 * dusk;
      const glowScale = NAV_GLOW.DAY_SCALE + (NAV_GLOW.NIGHT_SCALE - NAV_GLOW.DAY_SCALE) * dusk;
      glowSprites[0].scale.setScalar(glowScale);
      glowSprites[1].scale.setScalar(glowScale);
      const strobePhase = time.elapsed % STROBE_PERIOD;
      const flash = strobePhase < STROBE_FLASH_SECONDS ? (1 - strobePhase / STROBE_FLASH_SECONDS) ** 2 : 0;
      strobeIntensity.value = 0.5 + flash * (3.5 + 4.5 * dusk);
      strobeGlowStrength.value = flash * (0.25 + 0.55 * dusk);
      glowSprites[2].visible = flash > 0;
      glowSprites[2].scale.setScalar(NAV_GLOW.STROBE_SCALE);
    },
  };
}

/**
 * Disposes every geometry under root and every material except the shared body / canopy ones,
 * then detaches root from its parent. Sprites are skipped for geometry: three.js shares one quad
 * geometry between every Sprite in the scene.
 */
export function disposeCraftMesh(root, ctx) {
  const shared = getCraftMaterials(ctx);
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry && !object.isSprite) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of objectMaterials) {
      if (material !== shared.body && material !== shared.canopy) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.removeFromParent();
}

/** Triangle count of every mesh under root (stats and budgets). */
export function countTriangles(root) {
  let triangles = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = object.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  });
  return triangles;
}
