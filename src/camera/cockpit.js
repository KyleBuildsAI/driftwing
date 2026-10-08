// COCKPIT: the low-poly interior seen from the cockpit view, generated from a craft's
// cameraRig.cockpit descriptor, plus the instrument panel whose face is a CanvasTexture the camera
// system redraws at 30 Hz.
//
// Descriptor (all optional; lengths in metres relative to the eye point, body axes: x right, y up,
// -z forward):
//   style       'canopy' (sailplane tub, canopy rim and rear bow), 'cabin' (enclosed cabin: walls,
//               windshield pillars, door frames, roof rails), 'bubble' (helicopter bubble: low sill,
//               spine and door bows), 'open' (open cockpit: padded coaming, small windscreen frame),
//               'custom' (the craft draws its own: build below) or 'none' (no geometry, no panel:
//               wingsuit, FPV)
//   build       style 'custom' only: build(builder, spec, THREE) draws the interior (a gondola, a
//               basket, a harness, a rider's view of the creature) into the shared flat-shaded mesh
//               builder (createMeshBuilder, frame relative to the eye) and may return
//               { objects?: Object3D[], dispose?() }: extra objects (a burner flame, a lamp) added to
//               the cockpit group; their geometries and materials are disposed with it, then dispose()
//               runs. The instrument panel (panel.layout) is still built, with its housing.
//   width       inner width at the shoulders (default 0.64)
//   sill        sill / window-line height (default -0.14)
//   floor       floor height (default -0.62)
//   front, back tub extent along z (defaults -0.95 and 0.55)
//   roof        cabin roof / canopy bow height (default 0.26)
//   panel       { width, center: [x, y, z], tilt (deg, face toward the eye by default), layout:
//               [[ids], [ids]] rows (default: the craft's instruments in two rows) }
//   frameColor  canopy frame / pillar / coaming colour (default the v1 charcoal)
//   stick       draw a control stick that follows the pilot's input (default true except bubble,
//               custom and none)
//   near        camera near plane in this cockpit (default 0.08)
// Craft mesh parts that would clip the eye set userData.hideInCockpit = true in buildMesh.
import * as THREE from 'three/webgpu';
import { PALETTE, createMeshBuilder } from '../craft/kit.js';

export const COCKPIT_STYLES = Object.freeze(['canopy', 'cabin', 'bubble', 'open', 'none', 'custom']);

const DEG = Math.PI / 180;
const DEFAULTS = Object.freeze({
  style: 'canopy',
  width: 0.64,
  sill: -0.14,
  floor: -0.62,
  front: -0.95,
  back: 0.55,
  roof: 0.26,
  frameColor: 0x2c2f38,
  near: 0.08,
});
const DEFAULT_PANEL = Object.freeze({ width: 0.58, center: Object.freeze([0, -0.2, -0.62]) });
const PANEL_PAINT = '#24262c';
const CELL = 200;
const CELL_GAP = 10;
const CANVAS_PAD = 18;

const TINT = Object.freeze({
  wall: new THREE.Color(0xd9c7aa),
  wallLow: new THREE.Color(0xb9a68a),
  floor: new THREE.Color(0x3a3c44),
  panel: new THREE.Color(0x24262c),
  glare: new THREE.Color(0x1d1f24),
  seat: new THREE.Color(0x4a4d57),
  grip: new THREE.Color(0x1a1b1f),
  cushion: PALETTE.orange,
});

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** The descriptor with every default filled in; null when the craft has no first-person eye. */
export function resolveCockpitDescriptor(rig) {
  if (!rig || !Array.isArray(rig.eye)) return null;
  const source = rig.cockpit || {};
  let style = COCKPIT_STYLES.includes(source.style) ? source.style : source.style === undefined ? 'none' : DEFAULTS.style;
  // The registry refuses a custom cockpit without build(); a descriptor built by hand falls back to none.
  if (style === 'custom' && typeof source.build !== 'function') style = 'none';
  const panelSource = source.panel || {};
  const center = Array.isArray(panelSource.center) && panelSource.center.length === 3 && panelSource.center.every(Number.isFinite)
    ? panelSource.center
    : DEFAULT_PANEL.center;
  const autoTilt = Math.atan2(-center[1], -center[2]) / DEG;
  return {
    style,
    width: finite(source.width, DEFAULTS.width),
    sill: finite(source.sill, DEFAULTS.sill),
    floor: finite(source.floor, DEFAULTS.floor),
    front: finite(source.front, DEFAULTS.front),
    back: finite(source.back, DEFAULTS.back),
    roof: finite(source.roof, DEFAULTS.roof),
    frameColor: new THREE.Color(Number.isFinite(source.frameColor) ? source.frameColor : DEFAULTS.frameColor),
    stick: source.stick !== undefined ? Boolean(source.stick) : style !== 'bubble' && style !== 'none' && style !== 'custom',
    near: finite(source.near, DEFAULTS.near),
    build: style === 'custom' ? source.build : null,
    panel: {
      width: finite(panelSource.width, DEFAULT_PANEL.width),
      center,
      tilt: finite(panelSource.tilt, autoTilt),
      layout: Array.isArray(panelSource.layout) ? panelSource.layout : null,
    },
  };
}

// ---- Geometry helpers ---------------------------------------------------------------------------
// The eye is the origin: an interior face points toward the eye when its "inside" reference point
// is the face centroid pushed away from the eye (2 x centroid).
function awayFromEye(points) {
  const centre = [0, 0, 0];
  for (const point of points) {
    centre[0] += point[0] / points.length;
    centre[1] += point[1] / points.length;
    centre[2] += point[2] / points.length;
  }
  return [centre[0] * 2, centre[1] * 2, centre[2] * 2];
}

/** A quad facing the eye. */
function interiorQuad(builder, a, b, c, d, tint) {
  builder.quad(a, b, c, d, tint, awayFromEye([a, b, c, d]));
}

/** A square-section bar from `from` to `to` (outward-facing, so it reads from every side). */
function bar(builder, from, to, thickness, tint) {
  const axis = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (axis.lengthSq() < 1e-8) return;
  axis.normalize();
  const helper = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side = new THREE.Vector3().crossVectors(axis, helper).normalize().multiplyScalar(thickness / 2);
  const up = new THREE.Vector3().crossVectors(side, axis).normalize().multiplyScalar(thickness / 2);
  const corner = (origin, sideSign, upSign) => [
    origin[0] + side.x * sideSign + up.x * upSign,
    origin[1] + side.y * sideSign + up.y * upSign,
    origin[2] + side.z * sideSign + up.z * upSign,
  ];
  const start = [corner(from, -1, -1), corner(from, 1, -1), corner(from, 1, 1), corner(from, -1, 1)];
  const end = [corner(to, -1, -1), corner(to, 1, -1), corner(to, 1, 1), corner(to, -1, 1)];
  const middle = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
  for (let index = 0; index < 4; index++) {
    const next = (index + 1) % 4;
    builder.quad(start[index], start[next], end[next], end[index], tint, middle);
  }
  builder.quad(start[0], start[1], start[2], start[3], tint, middle);
  builder.quad(end[0], end[1], end[2], end[3], tint, middle);
}

/** Bars along a polyline. */
function polyline(builder, points, thickness, tint) {
  for (let index = 0; index < points.length - 1; index++) bar(builder, points[index], points[index + 1], thickness, tint);
}

/** Points on a bow (half ellipse) across the cockpit at z, from the left sill over the top to the right. */
function bow(z, halfWidth, baseY, topY, segments = 8) {
  const points = [];
  for (let index = 0; index <= segments; index++) {
    const angle = Math.PI - (index / segments) * Math.PI;
    points.push([Math.cos(angle) * halfWidth, baseY + Math.sin(angle) * (topY - baseY), z]);
  }
  return points;
}

/** A box given its centre, size and a rotation about x (radians), faces outward. */
function box(builder, centre, size, rotationX, tint) {
  const [halfX, halfY, halfZ] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const cos = Math.cos(rotationX);
  const sin = Math.sin(rotationX);
  const point = (x, y, z) => [centre[0] + x, centre[1] + y * cos - z * sin, centre[2] + y * sin + z * cos];
  const corners = [
    point(-halfX, -halfY, -halfZ), point(halfX, -halfY, -halfZ), point(halfX, halfY, -halfZ), point(-halfX, halfY, -halfZ),
    point(-halfX, -halfY, halfZ), point(halfX, -halfY, halfZ), point(halfX, halfY, halfZ), point(-halfX, halfY, halfZ),
  ];
  const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  for (const [a, b, c, d] of faces) builder.quad(corners[a], corners[b], corners[c], corners[d], tint, centre);
}

// ---- Shell ----------------------------------------------------------------------------------------
/**
 * The tub: U-shaped sections from the front bulkhead to the rear, walls up to the sill, the floor,
 * and the rear bulkhead (up to wallTop, which the cabin raises to the roof).
 */
function buildTub(builder, spec, { wallTop = spec.sill, taperFront = 0.78 } = {}) {
  const half = spec.width / 2;
  const stations = [spec.front, spec.front * 0.55, 0, spec.back];
  const sections = stations.map((z) => {
    const taper = z < 0 ? 1 - (1 - taperFront) * Math.min(1, z / spec.front) : 1;
    const width = half * taper;
    return [
      [-width, spec.sill, z],
      [-width * 0.97, spec.sill - (spec.sill - spec.floor) * 0.55, z],
      [-width * 0.72, spec.floor, z],
      [width * 0.72, spec.floor, z],
      [width * 0.97, spec.sill - (spec.sill - spec.floor) * 0.55, z],
      [width, spec.sill, z],
    ];
  });
  for (let segment = 0; segment < sections.length - 1; segment++) {
    for (let edge = 0; edge < 5; edge++) {
      const tint = edge === 2 ? TINT.floor : edge === 1 || edge === 3 ? TINT.wallLow : TINT.wall;
      interiorQuad(builder, sections[segment][edge], sections[segment][edge + 1], sections[segment + 1][edge + 1], sections[segment + 1][edge], tint);
    }
  }
  // Rear bulkhead, from the floor up to wallTop.
  const rear = sections[sections.length - 1];
  const top = Math.max(wallTop, spec.sill);
  interiorQuad(builder, [-half, top, spec.back], [half, top, spec.back], rear[5], rear[0], TINT.wall);
  interiorQuad(builder, rear[0], rear[5], rear[3], rear[2], TINT.wallLow);
  interiorQuad(builder, rear[0], rear[2], rear[1], rear[1], TINT.wallLow);
  interiorQuad(builder, rear[5], rear[4], rear[3], rear[3], TINT.wallLow);
  // Front bulkhead (footwell) under the panel.
  const front = sections[0];
  interiorQuad(builder, front[1], front[2], front[3], front[4], TINT.floor);
  interiorQuad(builder, front[0], front[1], front[4], front[5], TINT.floor);
  return sections;
}

function buildSeat(builder, spec) {
  const half = spec.width / 2;
  const seatY = spec.floor + (spec.sill - spec.floor) * 0.35;
  box(builder, [0, seatY, 0.18], [half * 1.1, 0.06, 0.42], 0, TINT.seat);
  // Shoulder-high back: looking over the shoulder shows the rear bow and the tail, not a headrest.
  box(builder, [0, seatY + 0.2, 0.4], [half * 1.1, 0.36, 0.07], -0.25, TINT.seat);
  box(builder, [0, seatY + 0.045, 0.16], [half * 0.9, 0.035, 0.34], 0, TINT.cushion);
}

function buildSillRails(builder, spec, tint, thickness = 0.045) {
  const half = spec.width / 2;
  for (const side of [-1, 1]) {
    bar(builder, [side * half * 0.8, spec.sill, spec.front * 0.95], [side * half, spec.sill, 0], thickness, tint);
    bar(builder, [side * half, spec.sill, 0], [side * half, spec.sill, spec.back], thickness, tint);
  }
}

/** Panel housing and glareshield. Returns the panel face transform { center, rotationX, width, height }. */
function buildPanelHousing(builder, spec, faceHeight) {
  const panel = spec.panel;
  const tilt = panel.tilt * DEG;
  const [x, y, z] = panel.center;
  const housing = [panel.width + 0.05, faceHeight + 0.05, 0.08];
  // The housing sits just behind the face along the face normal (0, sin tilt, cos tilt).
  const normal = [0, Math.sin(tilt), Math.cos(tilt)];
  const back = 0.042;
  box(builder, [x - normal[0] * back, y - normal[1] * back, z - normal[2] * back], housing, -tilt, TINT.panel);
  // Glareshield: a hood from the top of the housing toward the pilot.
  const up = [0, Math.cos(tilt), -Math.sin(tilt)];
  const topY = y + up[1] * (faceHeight / 2 + 0.025);
  const topZ = z + up[2] * (faceHeight / 2 + 0.025);
  const halfWidth = panel.width / 2 + 0.05;
  const lipY = topY + 0.03;
  const lipZ = topZ + 0.13;
  const rearY = topY + 0.01;
  const rearZ = topZ - 0.07;
  builder.quad([-halfWidth, rearY, rearZ], [halfWidth, rearY, rearZ], [halfWidth, lipY, lipZ], [-halfWidth, lipY, lipZ], TINT.glare, [0, -1, topZ]);
  builder.quad([-halfWidth, lipY - 0.02, lipZ], [halfWidth, lipY - 0.02, lipZ], [halfWidth, lipY, lipZ], [-halfWidth, lipY, lipZ], TINT.glare, [0, lipY - 0.01, lipZ - 1]);
  // Side cheeks, facing inward (the pilot sees their inner side).
  for (const side of [-1, 1]) {
    builder.triangle([side * halfWidth, lipY, lipZ], [side * halfWidth, rearY, rearZ], [side * halfWidth, y - faceHeight / 2, z], TINT.glare, [side * halfWidth * 3, y, z]);
  }
  return { lipY, lipZ, halfWidth, topY, topZ };
}

function buildCanopyFrame(builder, spec, glare, tint) {
  const half = spec.width / 2;
  // Rear bow behind the pilot's head and the low front bow where the canopy meets the nose.
  polyline(builder, bow(spec.back * 0.62, half * 1.02, spec.sill, spec.roof + 0.04), 0.04, tint);
  polyline(builder, bow(glare.lipZ - 0.34, glare.halfWidth * 1.15, spec.sill - 0.02, glare.lipY + 0.05, 6), 0.035, tint);
}

function buildCabinFrame(builder, spec, glare, tint) {
  const half = spec.width / 2;
  const roofFront = Math.max(glare.lipZ + 0.18, -0.34);
  const roofBack = spec.back;
  for (const side of [-1, 1]) {
    // Windshield pillar from the glareshield corner up to the roof header.
    bar(builder, [side * glare.halfWidth, glare.lipY, glare.lipZ - 0.06], [side * half * 0.96, spec.roof, roofFront], 0.05, tint);
    // Door frame: front post, sill, rear post, roof rail.
    bar(builder, [side * half, spec.sill, roofFront + 0.1], [side * half * 0.96, spec.roof, roofFront], 0.04, tint);
    bar(builder, [side * half, spec.sill, spec.back * 0.72], [side * half, spec.roof, spec.back * 0.72], 0.05, tint);
    bar(builder, [side * half * 0.96, spec.roof, roofFront], [side * half, spec.roof, roofBack], 0.05, tint);
    // Upper side panels between the roof rail and the header (cabin headliner edges).
    interiorQuad(builder, [side * half, spec.roof - 0.06, spec.back * 0.72], [side * half, spec.roof - 0.06, roofBack], [side * half, spec.roof, roofBack], [side * half, spec.roof, spec.back * 0.72], TINT.wall);
    interiorQuad(builder, [side * half, spec.sill, spec.back * 0.72], [side * half, spec.sill, roofBack], [side * half, spec.roof - 0.06, roofBack], [side * half, spec.roof - 0.06, spec.back * 0.72], TINT.wall);
  }
  // Roof headers (the skylight between them shows the wing above).
  bar(builder, [-half * 0.96, spec.roof, roofFront], [half * 0.96, spec.roof, roofFront], 0.06, tint);
  bar(builder, [-half, spec.roof, roofBack], [half, spec.roof, roofBack], 0.06, tint);
  bar(builder, [-half, spec.roof, (roofFront + roofBack) / 2], [half, spec.roof, (roofFront + roofBack) / 2], 0.035, tint);
}

function buildBubbleFrame(builder, spec, tint) {
  const half = spec.width / 2;
  // Centre spine from just ahead of the head to the rear (the bubble ahead stays clear), and the
  // door bows on each side.
  polyline(builder, [[0, spec.roof, -0.32], [0, spec.roof + 0.06, -0.05], [0, spec.roof + 0.04, spec.back * 0.8]], 0.04, tint);
  polyline(builder, bow(spec.back * 0.2, half * 1.05, spec.sill, spec.roof + 0.05), 0.045, tint);
  polyline(builder, bow(spec.back * 0.9, half * 1.05, spec.sill, spec.roof + 0.03), 0.045, tint);
}

function buildOpenFrame(builder, spec, glare, tint) {
  const half = spec.width / 2;
  // Padded coaming along the sides and behind the pilot (the glareshield closes it at the front),
  // and a small windscreen frame ahead of the glareshield.
  for (const side of [-1, 1]) {
    polyline(builder, [[side * glare.halfWidth, glare.lipY - 0.02, glare.lipZ + 0.02], [side * half, spec.sill, glare.lipZ + 0.2], [side * half, spec.sill, spec.back]], 0.07, TINT.seat);
  }
  bar(builder, [-half, spec.sill, spec.back], [half, spec.sill, spec.back], 0.07, TINT.seat);
  polyline(builder, bow(glare.lipZ - 0.1, glare.halfWidth * 0.85, glare.lipY - 0.01, glare.lipY + 0.16, 5), 0.025, tint);
}

/**
 * A control stick on a pivot at the floor between the pilot's knees, short enough that the grip stays
 * below the line of sight to the panel; animate(pitch, roll) swings it.
 */
function buildStick(spec, material) {
  const pivot = new THREE.Group();
  pivot.position.set(0, spec.floor + 0.02, -0.14);
  const builder = createMeshBuilder();
  const length = Math.max(0.16, (spec.sill - spec.floor) * 0.4);
  bar(builder, [0, 0, 0], [0, length, 0], 0.025, TINT.grip);
  box(builder, [0, length + 0.05, 0], [0.04, 0.11, 0.045], 0.2, TINT.grip);
  box(builder, [0, length + 0.1, -0.01], [0.012, 0.02, 0.012], 0, TINT.cushion);
  box(builder, [0, 0.01, 0], [0.12, 0.02, 0.12], 0, TINT.floor);
  const mesh = new THREE.Mesh(builder.toGeometry(null), material);
  pivot.add(mesh);
  return {
    object: pivot,
    /** pitch and roll in -1..1 (pull back = nose up +, right +). */
    animate(pitch, roll) {
      pivot.rotation.set(pitch * 14 * DEG, 0, -roll * 14 * DEG, 'XZY');
    },
  };
}

// ---- Panel texture ----------------------------------------------------------------------------------
/** Rows of instrument ids: the descriptor layout (known ids only) or the craft order in two rows. */
export function panelRows(ids, layout) {
  if (layout) {
    const known = new Set(ids);
    const rows = layout.map((row) => (Array.isArray(row) ? row.filter((id) => known.has(id)) : [])).filter((row) => row.length > 0);
    const placed = new Set(rows.flat());
    const missing = ids.filter((id) => !placed.has(id));
    if (missing.length > 0) rows.push(missing);
    if (rows.length > 0) return rows;
  }
  if (ids.length <= 4) return ids.length > 0 ? [ids.slice()] : [];
  const firstRow = Math.ceil(ids.length / 2);
  return [ids.slice(0, firstRow), ids.slice(firstRow)];
}

function createPanelCanvas(rows) {
  const columns = Math.max(...rows.map((row) => row.length));
  const width = CANVAS_PAD * 2 + columns * CELL + (columns - 1) * CELL_GAP;
  const height = CANVAS_PAD * 2 + rows.length * CELL + (rows.length - 1) * CELL_GAP;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable for the instrument panel');
  const cells = [];
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.length * CELL + (row.length - 1) * CELL_GAP;
    const startX = (width - rowWidth) / 2;
    row.forEach((id, columnIndex) => {
      cells.push({ id, x: startX + columnIndex * (CELL + CELL_GAP), y: CANVAS_PAD + rowIndex * (CELL + CELL_GAP), size: CELL });
    });
  });
  return { canvas, context, cells, width, height };
}

/**
 * Builds the cockpit for a resolved descriptor. instrumentIds are the craft's known instruments.
 * Returns { group (place it at the eye in the craft root), panel ({ canvas, texture, cells,
 * redraw(instrumentSet) } or null), stick (or null), near, dispose() }.
 */
export function buildCockpit(spec, instrumentIds) {
  const group = new THREE.Group();
  group.name = 'cockpit';
  if (!spec || spec.style === 'none') {
    return { group, panel: null, stick: null, near: spec ? spec.near : DEFAULTS.near, dispose() { group.removeFromParent(); } };
  }
  const shellMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.78, metalness: 0 });
  const disposables = [shellMaterial];

  const rows = panelRows(instrumentIds, spec.panel.layout);
  let panelSurface = null;
  let faceHeight = spec.panel.width * 0.4;
  if (rows.length > 0) {
    panelSurface = createPanelCanvas(rows);
    faceHeight = (spec.panel.width * panelSurface.height) / panelSurface.width;
  }

  const builder = createMeshBuilder();
  const glare = rows.length > 0 || spec.style !== 'custom' ? buildPanelHousing(builder, spec, faceHeight) : null;
  const extraObjects = [];
  let customDispose = null;
  if (spec.style === 'custom') {
    const result = spec.build(builder, spec, THREE);
    if (result && Array.isArray(result.objects)) extraObjects.push(...result.objects);
    if (result && typeof result.dispose === 'function') customDispose = result.dispose;
  } else {
    const tubOptions = spec.style === 'cabin' ? { wallTop: spec.roof, taperFront: 0.92 } : spec.style === 'bubble' ? { taperFront: 0.9 } : {};
    buildTub(builder, spec, tubOptions);
    buildSeat(builder, spec);
  }
  if (spec.style === 'canopy') {
    buildSillRails(builder, spec, spec.frameColor);
    buildCanopyFrame(builder, spec, glare, spec.frameColor);
  } else if (spec.style === 'cabin') {
    buildSillRails(builder, spec, spec.frameColor, 0.05);
    buildCabinFrame(builder, spec, glare, spec.frameColor);
  } else if (spec.style === 'bubble') {
    buildSillRails(builder, spec, spec.frameColor, 0.04);
    buildBubbleFrame(builder, spec, spec.frameColor);
  } else if (spec.style === 'open') {
    buildOpenFrame(builder, spec, glare, spec.frameColor);
  }
  const shellGeometry = builder.toGeometry(null);
  disposables.push(shellGeometry);
  const shell = new THREE.Mesh(shellGeometry, shellMaterial);
  shell.name = 'cockpit-shell';
  group.add(shell);
  for (const object of extraObjects) {
    group.add(object);
    object.traverse((node) => {
      if (node.geometry) disposables.push(node.geometry);
      const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      for (const material of materials) disposables.push(material);
    });
  }

  let stick = null;
  if (spec.stick) {
    stick = buildStick(spec, shellMaterial);
    group.add(stick.object);
    stick.object.traverse((node) => {
      if (node.geometry) disposables.push(node.geometry);
    });
  }

  let panel = null;
  if (panelSurface) {
    const texture = new THREE.CanvasTexture(panelSurface.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    const faceMaterial = new THREE.MeshBasicNodeMaterial({ map: texture });
    const faceGeometry = new THREE.PlaneGeometry(spec.panel.width, faceHeight);
    const face = new THREE.Mesh(faceGeometry, faceMaterial);
    face.name = 'instrument-panel';
    face.position.set(spec.panel.center[0], spec.panel.center[1], spec.panel.center[2]);
    face.rotation.x = -spec.panel.tilt * DEG;
    group.add(face);
    disposables.push(texture, faceMaterial, faceGeometry);
    const { context, cells, width, height } = panelSurface;
    panel = {
      canvas: panelSurface.canvas,
      texture,
      cells,
      mesh: face,
      /** Repaints every gauge into the canvas and marks the texture for upload. */
      redraw(instrumentSet) {
        context.fillStyle = PANEL_PAINT;
        context.fillRect(0, 0, width, height);
        context.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        context.lineWidth = 4;
        context.strokeRect(2, 2, width - 4, height - 4);
        for (const cell of cells) instrumentSet.draw(cell.id, context, cell.x, cell.y, cell.size, 'panel');
        texture.needsUpdate = true;
      },
    };
  }

  group.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = false;
    node.receiveShadow = false;
  });

  return {
    group,
    panel,
    stick,
    near: spec.near,
    dispose() {
      group.removeFromParent();
      for (const item of disposables) item.dispose();
      if (customDispose) customDispose();
    },
  };
}
