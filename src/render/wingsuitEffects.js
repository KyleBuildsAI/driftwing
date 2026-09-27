// Wingsuit effects: the parachute a wingsuit pilot flies home under. A nine-cell ram-air canopy built
// from code in the v1 craft style (flat-shaded, vertex-coloured lofts in the v1 palette) with open cell
// mouths, per-cell brake flaps along the trailing edge, a suspension-line cascade to the pilot's
// risers, brake lines to the hands, and the pilot chute with its bridle. It animates the whole
// deployment (pilot chute out, bag lift, inflation from a narrow bundle to the full arc), the brake
// deflection under the toggles, a slow luffing of the fabric and the collapse after landing.
//
// createCanopyRig(materials) returns { group, lines, update(pose) }: `group` holds the canopy parts
// and `lines` the line geometry, both added untransformed to the craft root (x span, y up, z aft), so
// everything is in the root frame. update(pose) takes { deploy (0..1), collapse (0..1),
// brakeLeft, brakeRight (0..1), risers: [left, right], hands: [left, right] (root-frame points),
// back (root-frame point: the container), time (s) }.
import * as THREE from 'three/webgpu';
import { DEG, clamp } from '../core/util.js';
import { PALETTE, createMeshBuilder, profileSection, addSolid, smooth01 } from '../craft/kit.js';

const CANOPY = Object.freeze({
  CELLS: 9,
  SPAN: 8.2,
  CHORD: 2.9,
  THICKNESS: 0.16,
  ARC_RADIUS: 7,
  LEADING_EDGE: -1.25,
  /** Canopy (top centre of the arc) above and ahead of the shoulder pivot, fully inflated. */
  HEIGHT: 6.2,
  AHEAD: -1.1,
  /** Brake flaps: the trailing 30 % of each cell; how much of a toggle each cell takes (outer first). */
  FLAP_SHARE: Object.freeze([1, 0.78, 0.52, 0.28, 0, 0.28, 0.52, 0.78, 1]),
  MAX_FLAP: 38 * DEG,
  /** Lower-surface line attachment stations (chord fractions) on every rib. */
  LINE_STATIONS: Object.freeze([0.1, 0.55]),
});

// Ram-air section (LE top -> upper -> TE -> lower -> LE bottom): a flat bottom, a rounded top and an
// open nose (the face from the last point back to the first is the cell mouth).
const CANOPY_PROFILE_CUT = [[0.02, 0.36], [0.12, 0.62], [0.35, 0.68], [0.7, 0.4], [0.7, 0.16], [0.7, -0.08], [0.35, -0.14], [0.05, -0.2]];
const FLAP_PROFILE = [[0.7, 0.4], [1, 0.02], [0.7, -0.08]];
const FLAP_HINGE = [0.7, 0.16];
const MOUTH_EDGE = 7;

/** Arc angle and position of the rib at spanwise arc length s (canopy frame, origin at the top centre). */
function ribFrame(arcLength) {
  const angle = arcLength / CANOPY.ARC_RADIUS;
  return {
    origin: [CANOPY.ARC_RADIUS * Math.sin(angle), CANOPY.ARC_RADIUS * (Math.cos(angle) - 1), CANOPY.LEADING_EDGE],
    up: [Math.sin(angle), Math.cos(angle), 0],
  };
}

function ribArcLengths() {
  const lengths = [];
  for (let rib = 0; rib <= CANOPY.CELLS; rib++) lengths.push(-CANOPY.SPAN / 2 + (rib * CANOPY.SPAN) / CANOPY.CELLS);
  return lengths;
}

function ribSection(arcLength, profile) {
  const frame = ribFrame(arcLength);
  return profileSection(profile, frame.origin, [0, 0, 1], frame.up, CANOPY.CHORD, CANOPY.THICKNESS / 0.68);
}

/** A point on a rib at [chord fraction, profile thickness units] (canopy frame). */
function ribPoint(arcLength, along, across) {
  return ribSection(arcLength, [[along, across]])[0];
}

function cellTint(cell, edge) {
  if (edge === MOUTH_EDGE) return PALETTE.charcoal;
  const lower = edge >= 4;
  const orange = cell % 2 === 0;
  if (orange) return lower ? PALETTE.orange.clone().multiplyScalar(0.86) : PALETTE.orange;
  return lower ? PALETTE.creamShade : PALETTE.cream;
}

function buildCanopyBody() {
  const builder = createMeshBuilder();
  const sections = ribArcLengths().map((arcLength) => ribSection(arcLength, CANOPY_PROFILE_CUT));
  builder.loft(sections, cellTint, { capStart: PALETTE.cream, capEnd: PALETTE.cream });
  return builder.toGeometry(null);
}

function buildFlap(cell) {
  const lengths = ribArcLengths();
  const builder = createMeshBuilder();
  const sections = [lengths[cell], lengths[cell + 1]].map((arcLength) => ribSection(arcLength, FLAP_PROFILE));
  builder.loft(sections, (segment, edge) => cellTint(cell, edge === 1 ? 5 : 0), { capStart: PALETTE.creamShade, capEnd: PALETTE.creamShade });
  const start = ribPoint(lengths[cell], FLAP_HINGE[0], FLAP_HINGE[1]);
  const end = ribPoint(lengths[cell + 1], FLAP_HINGE[0], FLAP_HINGE[1]);
  const pivot = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  const axis = new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize();
  return { geometry: builder.toGeometry(pivot), pivot, axis };
}

/** A small low-poly dome (the pilot chute) opening along +y. */
function buildPilotChute() {
  const builder = createMeshBuilder();
  const rings = [[0, 0.02], [0.18, 0.2], [0.34, 0.42], [0.42, 0.62], [0.36, 0.72]].map(([radius, height]) => {
    const ring = [];
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      ring.push([radius * Math.cos(angle), height, radius * Math.sin(angle)]);
    }
    return ring;
  });
  builder.loft(rings, (segment) => (segment === 3 ? PALETTE.cream : PALETTE.orange), { capStart: PALETTE.charcoal });
  return builder.toGeometry(null);
}

function buildBag() {
  const builder = createMeshBuilder();
  const box = (y) => [[-0.16, y, -0.22], [0.16, y, -0.22], [0.16, y, 0.22], [-0.16, y, 0.22]];
  builder.loft([box(-0.12), box(0.12)], () => PALETTE.creamShade, { capStart: PALETTE.orange, capEnd: PALETTE.orange });
  return builder.toGeometry(null);
}

/**
 * Builds the canopy rig. materials: the shared craft materials ({ body }). The line material is its
 * own (disposed with the craft mesh).
 */
export function createCanopyRig(materials) {
  const group = new THREE.Group();
  group.name = 'canopy';
  group.visible = false;

  const canopy = new THREE.Group();
  canopy.name = 'canopy-wing';
  group.add(canopy);
  addSolid(canopy, buildCanopyBody(), materials.body);
  const flaps = [];
  for (let cell = 0; cell < CANOPY.CELLS; cell++) {
    const part = buildFlap(cell);
    const pivot = new THREE.Group();
    pivot.position.set(part.pivot[0], part.pivot[1], part.pivot[2]);
    pivot.userData.axis = part.axis;
    addSolid(pivot, part.geometry, materials.body);
    canopy.add(pivot);
    flaps.push(pivot);
  }

  const pilotChute = new THREE.Group();
  pilotChute.name = 'pilot-chute';
  addSolid(pilotChute, buildPilotChute(), materials.body);
  group.add(pilotChute);
  const bag = new THREE.Group();
  bag.name = 'deployment-bag';
  addSolid(bag, buildBag(), materials.body);
  group.add(bag);

  // Line attachment points on the canopy (canopy frame) and which riser (0 left, 1 right) each goes to.
  const lengths = ribArcLengths();
  const attachments = [];
  for (const arcLength of lengths) {
    for (const station of CANOPY.LINE_STATIONS) {
      attachments.push({ point: new THREE.Vector3().fromArray(ribPoint(arcLength, station, -0.18)), side: arcLength < 0 ? 0 : 1, brake: false });
    }
  }
  // Brake lines from the trailing edge of the outer ribs to the hands.
  for (const rib of [0, 1, 2, CANOPY.CELLS - 2, CANOPY.CELLS - 1, CANOPY.CELLS]) {
    attachments.push({ point: new THREE.Vector3().fromArray(ribPoint(lengths[rib], 0.98, 0)), side: lengths[rib] < 0 ? 0 : 1, brake: true });
  }
  // Bridle: from the canopy's top centre to the pilot chute.
  const bridleAnchor = new THREE.Vector3().fromArray(ribPoint(0, 0.4, 0.68));
  const segmentCount = attachments.length + 1;
  const linePositions = new Float32Array(segmentCount * 2 * 3);
  const lineGeometry = new THREE.BufferGeometry();
  const linePositionAttribute = new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage);
  lineGeometry.setAttribute('position', linePositionAttribute);
  lineGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, -1), 12);
  const lineMaterial = new THREE.LineBasicNodeMaterial({ color: 0x4a4c55 });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = 'canopy-lines';
  lines.visible = false;

  const scratchPoint = new THREE.Vector3();
  const scratchEnd = new THREE.Vector3();
  const chutePosition = new THREE.Vector3();

  function writeSegment(index, from, to) {
    const offset = index * 6;
    linePositions[offset] = from.x;
    linePositions[offset + 1] = from.y;
    linePositions[offset + 2] = from.z;
    linePositions[offset + 3] = to.x;
    linePositions[offset + 4] = to.y;
    linePositions[offset + 5] = to.z;
  }

  return {
    group,
    lines,

    update(pose) {
      const deploy = clamp(pose.deploy, 0, 1);
      const visible = deploy > 0;
      group.visible = visible;
      lines.visible = visible;
      if (!visible) return;
      const collapse = clamp(pose.collapse, 0, 1);
      const time = pose.time;

      // Pilot chute and bag: out of the container, up and back on the bridle, then riding the canopy.
      const pilotOut = smooth01(deploy / 0.14);
      const bagLift = smooth01((deploy - 0.1) / 0.2);
      const inflation = smooth01((deploy - 0.22) / 0.72);

      // Canopy: a narrow bundle over the pilot that spreads into the full arc (the slider coming down),
      // luffing a little; after landing it sinks forward onto the ground and flattens.
      const luff = 0.015 * Math.sin(time * 2.3) + 0.01 * Math.sin(time * 3.7 + 1.1);
      const riseHeight = 1.4 + (CANOPY.HEIGHT - 1.4) * smooth01((deploy - 0.12) / 0.4);
      canopy.visible = deploy > 0.2;
      canopy.scale.set(0.12 + 0.88 * inflation, (0.35 + 0.65 * inflation) * (1 + luff) * (1 - 0.7 * collapse), 0.5 + 0.5 * inflation);
      canopy.position.set(0, riseHeight * (1 - collapse) - 1.2 * collapse, CANOPY.AHEAD * inflation - 5.5 * collapse);
      canopy.rotation.set(-0.3 * collapse + 0.05 * Math.sin(time * 1.3) * inflation * (1 - collapse), 0, 0.02 * Math.sin(time * 0.9) * (1 - collapse));
      const leftBrake = clamp(pose.brakeLeft, 0, 1);
      const rightBrake = clamp(pose.brakeRight, 0, 1);
      for (let cell = 0; cell < flaps.length; cell++) {
        const share = CANOPY.FLAP_SHARE[cell];
        const brake = cell < CANOPY.CELLS / 2 - 0.5 ? leftBrake : cell > CANOPY.CELLS / 2 ? rightBrake : 0.5 * (leftBrake + rightBrake);
        const angle = (brake * (cell === 4 ? 0.2 : share) * CANOPY.MAX_FLAP + 0.06 * Math.sin(time * 5 + cell)) * inflation * (1 - collapse);
        flaps[cell].quaternion.setFromAxisAngle(flaps[cell].userData.axis, angle);
      }
      canopy.updateMatrix();

      // Pilot chute: from the container up behind the pilot, then above and behind the canopy.
      const back = pose.back;
      chutePosition.set(back.x, back.y + 0.2 + 3.2 * pilotOut, back.z + 2.2 * pilotOut);
      if (inflation > 0) {
        scratchPoint.copy(bridleAnchor).applyMatrix4(canopy.matrix);
        scratchEnd.set(scratchPoint.x, scratchPoint.y + 1.2, scratchPoint.z + 3.4);
        chutePosition.lerp(scratchEnd, smooth01(inflation * 1.6));
      }
      pilotChute.position.copy(chutePosition);
      pilotChute.rotation.set(-1.2 * pilotOut, 0, 0);
      pilotChute.scale.setScalar(0.3 + 0.7 * pilotOut);
      pilotChute.visible = collapse < 0.9;
      // The bag rides up the lines and hangs off the bridle once the canopy is out.
      bag.visible = bagLift > 0 && collapse < 0.5;
      bag.position.set(back.x, back.y + 0.2 + (riseHeight - 0.4) * bagLift, back.z + 0.6 * bagLift);
      if (inflation > 0.6) bag.position.lerp(chutePosition, smooth01((inflation - 0.6) / 0.4) * 0.6);

      // Lines: every attachment to its riser (or hand for the brake lines), then the bridle.
      let segment = 0;
      for (const attachment of attachments) {
        scratchPoint.copy(attachment.point).applyMatrix4(canopy.matrix);
        const end = attachment.brake ? pose.hands[attachment.side] : pose.risers[attachment.side];
        // Before inflation the lines run up from the container to the bag.
        if (inflation <= 0) scratchPoint.copy(bag.position);
        writeSegment(segment++, end, scratchPoint);
      }
      scratchPoint.copy(bridleAnchor).applyMatrix4(canopy.matrix);
      if (inflation <= 0) scratchPoint.copy(back);
      writeSegment(segment, scratchPoint, pilotChute.position);
      linePositionAttribute.needsUpdate = true;
    },
  };
}
