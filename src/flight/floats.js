// Floats: the SimFixedWing extension (profile.extension) the seaplane flies with. It adds what the
// generic airframe and the point ground contact do not model, from the seaplane's simProfile.floats
// block: two V-bottomed floats sampled against the shared water query (the ocean's swell and every
// local water body), the amphibian wheels in them, the water rudders and the gear advisory.
//
// Each float is a row of stations along its keel (the forebody from the bow to the step, the
// afterbody from the step to the stern, the keel rising toward the bow and aft of the step at the
// sternpost angle). Every tick, at every station whose keel is under the water surface there:
//   buoyancy      rho g x the immersed section area (a V bottom up to the chines, then the float's
//                 width) x the station length, along the water's normal: the floats displace water,
//                 they are not springs
//   planing       the water's normal force on the bottom from the flow into it (strip theory: the
//                 added-mass momentum term, proportional to the forward speed times the flow into the
//                 bottom, which is inclined by the keel's own slope: the rocker meets the water at the
//                 bow, the afterbody faces away from it until the trim passes the sternpost angle).
//                 It develops with the beam Froude number (a share of it at displacement speeds: the
//                 bow wave), is strongest at the leading wetted edge, grows with the square of the
//                 speed and lifts the floats until only the forebody near the step is wet: the craft
//                 rides "on the step". Cross-flow drag and radiation damping answer heave only
//   drag          skin friction on the wetted girth, and the displacement (wave-making) drag of the
//                 immersed volume (peaking near hump.waveDragSpeed); as the planing lift empties the
//                 floats, the water resistance peaks near hump.speed (about 45 km/h) and falls well
//                 below that on the step
//   side force    the floats' keels resist sideslip (cross-flow drag and keel lift), so they track
// Porpoising: on the step, a trim attitude outside the stable band (hump.trimLow .. trimHigh; the
// attitude the pilot holds, the trim averaged over about a porpoise period) feeds a pitch-heave
// oscillation that grows while the attitude stays wrong and dies away once it is right
// (craftState.porpoise is its amplitude, 0..1). The water rudders (craftState.waterRudders, down)
// steer from the pedals and the differential toe brakes; they only bite while the sterns are wet,
// so at low speed. The amphibian wheels (the gear toggle) retract into the floats:
//   - wheels down in the water above limits.noseOverSpeed dig in: nose-over, the Phase 1 soft crash
//     (body strike 'nose-over'). craftState.noseOverWarning rises beforehand (low over water, or
//     speeding up on the water, with the gear selected down) for the copilot's callout;
//   - wheels up on land, the float keels skid (the keels are skid contacts); above
//     limits.skidCrashSpeed (20 km/h) that is a soft crash (body strike 'floats on land').
//     craftState.skidWarning rises on a low approach over land with the gear up.
// A body point (propeller, nose, wingtip, tail) dipping into the water faster than
// limits.bodyStrikeSpeed is a body strike too. The contact report is completed for the controller
// and the landing grades: afloat is onGround with surface 'water', and the first float to touch after
// a flight is a touchdown graded like one on the ground (landed with surface 'water').
//
// With the assists above 50 % the water handling assist eases in (full at 100 %): hands near neutral
// on the step it holds the middle of the stable trim band and damps the pitch, and at full power below
// the hump it holds the nose up to get over it. The pilot's own pull always wins.
//
// Ownership: the extension writes craftState onWater, onStep, porpoise, noseOverWarning,
// skidWarning, spray, trim, waterSpeed and gearPosition; the craft ability owns waterRudders and the
// copilot's gearRequest ('up' | 'down', applied and cleared here). Journal stats (journalStat):
// seaplaneWaterLandings and seaplaneLakeLandings (count, add) from the graded landings, and
// seaplaneStepSeconds (the longest run on the step, max).
//
// Allocation-free per tick: every scratch vector is created here, once per model.
import * as THREE from 'three/webgpu';
import { DEG, clamp } from '../core/util.js';
import { GRAVITY, smoothstep } from './aero.js';
import { createWaterSampleScratch, waterHeightAt, waterSampleAt } from './waterSurface.js';

/**
 * A touchdown on the water counts after this long with no float or gear contact: shorter gaps are
 * skips off the swell on the run (and bounces), part of the same run on the water.
 */
const TOUCHDOWN_AIRBORNE_SECONDS = 1;
/** Nothing touches while the centre of mass is this far (m) above the surface below it. */
const CONTACT_REACH = 9;
/** The wheels must be in the water above the nose-over speed this long (s) before they dig in. */
const NOSE_OVER_SECONDS = 0.12;
/** The gear advisory watches approaches below this height (m above the surface) and this sink rate (m/s). */
const WARNING_AGL = 150;
const WARNING_SINK = 0.8;
/** Speeding up on the water with the wheels down warns from this speed (m/s). */
const WATER_WARNING_SPEED = 2.5;
/** Water suction is limited to this share of a station's buoyancy (the flow separates; no glue). */
const SUCTION_SHARE = 0.25;
/** On the step: above this share of the hump speed with the planing lift carrying this share of the water load. */
const STEP_SPEED_SHARE = 0.85;
const STEP_LIFT_SHARE = 0.5;
/** After a reset on the ground or the water, a settle onto the floats this long (s) is not a touchdown. */
const SETTLE_SECONDS = 1;
/** The held trim (porpoising's input) averages the trim over this long (s): about a porpoise period. */
const HELD_TRIM_SECONDS = 0.8;
/** A run on the step this long (s) or longer goes to the journal. */
const STEP_RECORD_SECONDS = 3;
/** The gear selector's notices (it refuses to raise wheels that carry the craft on land). */
const GEAR_NOTICE = Object.freeze({
  up: 'Gear up: set for a water landing.',
  down: 'Gear down: set for a runway landing.',
  locked: 'The wheels carry us on land: the gear stays down.',
});

/** Smoothly saturating section lift of a water rudder blade at angle (rad; stalls past about 25 degrees). */
function rudderLift(angle, slope) {
  return slope * Math.sin(clamp(angle, -0.55, 0.55)) * (1 - 0.35 * smoothstep(0.35, 0.55, Math.abs(angle)));
}

/**
 * The immersed area (m^2) of a V-bottomed float section of `beam` (m) with deadrise angle tangent
 * `deadriseTan`, `deck` (m) deep from keel to deck, at keel depth `depth` (m). Exported for the lab.
 */
export function floatSectionArea(depth, beam, deadriseTan, deck) {
  if (!(depth > 0)) return 0;
  const chine = 0.5 * beam * deadriseTan;
  const immersed = Math.min(depth, deck);
  const area = immersed <= chine ? (immersed * immersed) / deadriseTan : 0.5 * chine * beam + (immersed - chine) * beam;
  return area;
}

/** The wetted beam (m) across the bottom at keel depth `depth`: the V up to the chines, then the full beam. */
export function floatWettedBeam(depth, beam, deadriseTan) {
  if (!(depth > 0)) return 0;
  return Math.min(beam, (2 * depth) / deadriseTan);
}

/**
 * Displacement (wave-making) drag per newton of displaced weight at speed ratio `ratio` (speed /
 * hump speed): rises with the square of the speed, peaks at the hump (value `peak`) and falls as
 * 2 / ratio^2 beyond it. Exported for the lab's towing tank.
 */
export function displacementDragShape(ratio, peak) {
  const square = ratio * ratio;
  return (peak * 2 * square) / (1 + square * square);
}

/** The float stations of one hull (relative to the mesh origin, body axes). */
function buildStations(floats) {
  const keel = floats.keel;
  const stations = [];
  const foreLength = keel.stepZ - keel.bowZ;
  const aftLength = keel.sternZ - keel.stepZ;
  const sternpost = Math.tan(keel.sternpostAngle * DEG);
  for (let index = 0; index < floats.foreStations; index++) {
    const from = keel.bowZ + (foreLength * index) / floats.foreStations;
    const to = keel.bowZ + (foreLength * (index + 1)) / floats.foreStations;
    const z = (from + to) / 2;
    const toBow = (keel.stepZ - z) / foreLength;
    // slope: the bottom's angle to the body axis (rad), facing the flow: the rocker lifts the bow.
    stations.push({ z, length: to - from, rise: keel.bowRise * toBow * toBow, slope: (2 * keel.bowRise * toBow) / foreLength, beamScale: 0.45 + 0.55 * Math.sqrt(Math.max(0, 1 - toBow * toBow)) });
  }
  for (let index = 0; index < floats.aftStations; index++) {
    const from = keel.stepZ + (aftLength * index) / floats.aftStations;
    const to = keel.stepZ + (aftLength * (index + 1)) / floats.aftStations;
    const z = (from + to) / 2;
    const toStern = (z - keel.stepZ) / aftLength;
    // Aft of the step the bottom rises at the sternpost angle: it faces away from the flow until the
    // trim exceeds that angle (then the afterbody lifts: the upper limit of stable planing).
    stations.push({ z, length: to - from, rise: keel.stepHeight + (z - keel.stepZ) * sternpost, slope: -Math.atan(sternpost), beamScale: 1 - 0.5 * toStern });
  }
  return stations;
}

/** The keel height (body y, m) of a float at body z: the forebody rocker, the step and the sternpost rise. */
export function floatKeelHeight(floats, z) {
  const keel = floats.keel;
  if (z <= keel.stepZ) {
    const toBow = clamp((keel.stepZ - z) / (keel.stepZ - keel.bowZ), 0, 1);
    return keel.stepY + keel.bowRise * toBow * toBow;
  }
  return keel.stepY + keel.stepHeight + (Math.min(z, keel.sternZ) - keel.stepZ) * Math.tan(keel.sternpostAngle * DEG);
}

/**
 * The extension factory (profile.extension): { profile, craft, bus, craftState, limits, flightData }
 * -> SimFixedWing hooks (shapeControls, contactForces, afterStep, reset, snapshot, restore, dispose)
 * and the live hydro readouts (hydro).
 */
export function createFloatsExtension({ profile, craft, bus, craftState, limits, flightData }) {
  const floats = profile.floats;
  const craftId = craft && craft.id ? craft.id : 'seaplane';
  const waterDensity = floats.waterDensity;
  const deadriseTan = Math.tan(floats.deadrise * DEG);
  const deadriseSin = Math.sin(floats.deadrise * DEG);
  const deadriseCos = Math.cos(floats.deadrise * DEG);
  const humpSpeed = floats.hump.speed;
  const noseOverSpeed = Number.isFinite(limits.noseOverSpeed) ? limits.noseOverSpeed : 4.5;
  const skidCrashSpeed = Number.isFinite(limits.skidCrashSpeed) ? limits.skidCrashSpeed : 5.6;
  const strikeSpeed = Number.isFinite(limits.bodyStrikeSpeed) ? limits.bodyStrikeSpeed : 5;
  const centerOfMass = new THREE.Vector3().fromArray(profile.centerOfMass ?? [0, 0, 0]);
  const weight = (profile.mass.empty + profile.mass.pilot + (profile.mass.fuel ?? 0)) * GRAVITY;
  const floatLength = floats.keel.sternZ - floats.keel.bowZ;
  const trimMiddle = (floats.hump.trimLow + floats.hump.trimHigh) / 2;

  // ---- Geometry (relative to the centre of mass, body axes) ---------------------------------------
  const stationTemplate = buildStations(floats);
  /** Every station of both hulls: { relative (keel point), length, slope, beam, hull }. */
  const stations = [];
  floats.hulls.forEach((hullX, hull) => {
    for (const template of stationTemplate) {
      stations.push({
        relative: new THREE.Vector3(hullX, floats.keel.stepY + template.rise, template.z).sub(centerOfMass),
        length: template.length,
        slope: template.slope,
        beam: floats.beam * template.beamScale,
        hull,
      });
    }
  });
  const sternKeel = floatKeelHeight(floats, floats.waterRudder.z);
  /** The water rudder blades (the centre of each blade, hanging below its float's stern). */
  const rudders = floats.hulls.map((hullX) => ({
    relative: new THREE.Vector3(hullX, sternKeel - floats.waterRudder.depth * 0.5, floats.waterRudder.z).sub(centerOfMass),
  }));
  const wheels = floats.wheels.map((wheel) => ({
    id: wheel.id,
    relative: new THREE.Vector3().fromArray(wheel.position).sub(centerOfMass),
    radius: wheel.radius,
    area: wheel.area,
  }));
  /** Body points that strike the water (the airframe's body contacts). */
  const strikePoints = profile.contacts.filter((contact) => contact.kind === 'body').map((contact) => ({
    id: contact.id,
    relative: new THREE.Vector3().fromArray(contact.position).sub(centerOfMass),
  }));

  // ---- State -----------------------------------------------------------------------------------------
  const hydro = {
    floating: false,
    wasFloating: false,
    airborneSeconds: TOUCHDOWN_AIRBORNE_SECONDS,
    onStep: false,
    stepSeconds: 0,
    planingLift: 0,
    buoyancy: 0,
    drag: 0,
    waterSpeed: 0,
    trim: 0,
    /** The trim averaged over about a porpoise period: the attitude held, without the oscillation. */
    heldTrim: 0,
    spray: 0,
    porpoisePhase: 0,
    porpoise: 0,
    wheelSeconds: 0,
    /** The fastest wet wheel's speed through the water (m/s). */
    wheelSpeed: 0,
    wheelsWet: false,
    overWater: false,
    onLand: false,
    waterKind: 'none',
    noseOverWarning: false,
    skidWarning: false,
    resolveGear: false,
    /** After a reset on the ground or water, the craft settles onto its floats this long (s) without a touchdown. */
    settleSeconds: 0,
  };
  const touchdown = { sinkRate: 0, part: '', groundSpeed: 0 };
  const strike = { part: '', speed: 0 };

  // ---- Scratch ----------------------------------------------------------------------------------------
  const inverseQuaternion = new THREE.Quaternion();
  const offsetWorld = new THREE.Vector3();
  const pointWorld = new THREE.Vector3();
  const spinBody = new THREE.Vector3();
  const pointVelocity = new THREE.Vector3();
  const bodyVelocity = new THREE.Vector3();
  const stationForce = new THREE.Vector3();
  const buoyancyBody = new THREE.Vector3();
  const lever = new THREE.Vector3();
  const forceSum = new THREE.Vector3();
  const sample = createWaterSampleScratch();
  /** Per hull, this tick: wet yet, and the leading wetted edge (z relative to the centre of mass). */
  const wetHull = floats.hulls.map(() => false);
  const leadingZ = new Float64Array(floats.hulls.length);

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  /** World position and the velocity relative to the water (world) of a body point (relative to the centre of mass). */
  function pointState(tick, relative) {
    offsetWorld.copy(relative).applyQuaternion(tick.quaternion);
    pointWorld.copy(tick.position).add(offsetWorld);
    spinBody.crossVectors(tick.angularVelocity, relative).applyQuaternion(tick.quaternion);
    pointVelocity.copy(tick.velocity).add(spinBody);
  }

  /** Adds a body-axes force at a body point (relative to the centre of mass) to the running sums. */
  function addBodyForce(force, relative, momentBody) {
    forceSum.add(force);
    lever.crossVectors(relative, force);
    momentBody.add(lever);
  }

  /** True when the sample is open water the floats ride on (not dry land, ice or a thin film). */
  function isOpenWater(waterSample, groundHeight) {
    return waterSample.kind !== 'none' && waterSample.material === 'water' && !waterSample.film && waterSample.height > groundHeight;
  }

  // ============================================================================================
  // GEAR SELECTOR (the gear toggle and the copilot's gearRequest)
  // ============================================================================================
  function selectGear(systems, down, quiet) {
    if (systems.gearDown === down) return;
    if (!down && hydro.onLand) {
      if (!quiet) notify(GEAR_NOTICE.locked, 'warning');
      return;
    }
    systems.gearDown = down;
    hydro.resolveGear = false;
    if (!quiet) notify(down ? GEAR_NOTICE.down : GEAR_NOTICE.up, 'info');
  }

  function shapeControls(controls, tick) {
    const systems = tick.systems;
    if (controls.actions && controls.actions.has('gearToggle')) {
      const quiet = Boolean(controls.quietActions && controls.quietActions.has('gearToggle'));
      controls.actions.delete('gearToggle');
      selectGear(systems, !systems.gearDown, quiet);
    }
    if (craftState.gearRequest === 'up' || craftState.gearRequest === 'down') {
      selectGear(systems, craftState.gearRequest === 'down', true);
      craftState.gearRequest = null;
    }
    applyWaterAssist(controls, tick);
  }

  /**
   * The water handling assist (weight 0 at 50 % assists, 1 at 100 %): on the step with the stick near
   * neutral it flies the middle of the stable trim band with pitch damping; at full power below the
   * hump it holds the nose up. A deliberate pull or push is the pilot's.
   */
  function applyWaterAssist(controls, tick) {
    if (!hydro.floating) return;
    const weight = smoothstep(0.5, 1, tick.assists);
    if (weight <= 0) return;
    const stick = Number.isFinite(controls.pitch) ? controls.pitch : 0;
    const handsOff = 1 - smoothstep(0.12, 0.3, Math.abs(stick));
    if (handsOff <= 0) return;
    const pitchRate = tick.angularVelocity.x / DEG;
    let command = 0;
    if (hydro.waterSpeed > STEP_SPEED_SHARE * humpSpeed) {
      command = clamp(0.08 * (trimMiddle - hydro.trim) - 0.025 * pitchRate, -0.6, 0.6);
    } else if (hydro.waterSpeed > 2 && tick.systems.throttle > 0.7) {
      command = clamp(0.35 + 0.08 * (floats.hump.humpTrim - hydro.trim) - 0.02 * pitchRate, 0, 0.8);
    }
    controls.pitch = clamp(stick + command * weight * handsOff, -1, 1);
  }

  // ============================================================================================
  // HYDRODYNAMICS (contactForces: after the ground contact)
  // ============================================================================================
  function contactForces(tick, forceWorld, momentBody) {
    const env = tick.env;
    const dt = tick.dt;
    const report = tick.contact;
    const systems = tick.systems;
    const position = tick.position;
    const groundBelow = env.groundHeight(position.x, position.z);
    waterSampleAt(env, position.x, position.z, sample);
    hydro.overWater = isOpenWater(sample, groundBelow);
    resolveGearAfterReset(systems);
    const surfaceBelow = Math.max(groundBelow, sample.height);
    const landGear = report.gearContacts > 0;
    hydro.wasFloating = hydro.floating;
    hydro.floating = false;
    hydro.planingLift = 0;
    hydro.buoyancy = 0;
    hydro.drag = 0;
    hydro.wheelsWet = false;
    let wetFloats = 0;
    let sinkRate = 0;
    let touchPart = '';
    if (position.y - surfaceBelow < CONTACT_REACH) {
      inverseQuaternion.copy(tick.quaternion).invert();
      forceSum.set(0, 0, 0);
      wetHull.fill(false);
      leadingZ.fill(NaN);
      let forwardSum = 0;
      let forwardWeight = 0;
      for (const station of stations) {
        pointState(tick, station.relative);
        const ground = env.groundHeight(pointWorld.x, pointWorld.z);
        waterSampleAt(env, pointWorld.x, pointWorld.z, sample);
        if (!isOpenWater(sample, ground)) continue;
        const depth = sample.height - pointWorld.y;
        if (depth <= 0) continue;
        // Relative to the water's own orbital motion, in body axes: u forward, into the bottom, sideways.
        pointVelocity.x -= sample.velocityX;
        pointVelocity.y -= sample.velocityY;
        pointVelocity.z -= sample.velocityZ;
        bodyVelocity.copy(pointVelocity).applyQuaternion(inverseQuaternion);
        const forward = -bodyVelocity.z;
        // The flow into this station's bottom, which is inclined by its keel slope (small angles).
        const intoBottom = -bodyVelocity.y + Math.max(forward, 0) * station.slope;
        const sideways = bodyVelocity.x;
        const immersed = Math.min(depth, floats.deck);
        const area = floatSectionArea(depth, station.beam, deadriseTan, floats.deck);
        const wettedBeam = floatWettedBeam(depth, station.beam, deadriseTan);
        const chine = 0.5 * station.beam * deadriseTan;
        const girth = immersed <= chine ? (2 * immersed) / deadriseSin : station.beam / deadriseCos + 2 * (immersed - chine);
        const length = station.length;

        // Buoyancy along the water's normal, at the immersed section's centroid (about 0.6 of the depth up).
        const buoyancy = waterDensity * GRAVITY * area * length;
        buoyancyBody.set(sample.normalX, sample.normalY, sample.normalZ).multiplyScalar(buoyancy).applyQuaternion(inverseQuaternion);

        // Planing: the added-mass momentum term, cross-flow drag and radiation damping on the bottom.
        // The momentum term develops with the beam Froude number (no clean planing flow at
        // displacement speeds) and is strongest at the leading wetted edge, falling off behind it
        // (planing lift grows with the square root of the wetted length, not with the length).
        if (!Number.isFinite(leadingZ[station.hull])) leadingZ[station.hull] = station.relative.z - 0.5 * length;
        const behindLeading = (station.relative.z - leadingZ[station.hull]) / floats.beam;
        const froude = Math.max(forward, 0) / Math.sqrt(GRAVITY * floats.beam);
        const development = floats.planingOnset[2] + (1 - floats.planingOnset[2]) * smoothstep(floats.planingOnset[0], floats.planingOnset[1], froude);
        const planing = (floats.planing * development) / Math.sqrt(1 + behindLeading);
        // Cross-flow drag and radiation damping answer the station's own heave into the water (not
        // the steady inflow of the forward motion at a trim, which is the planing term's).
        const heave = -(pointVelocity.x * sample.normalX + pointVelocity.y * sample.normalY + pointVelocity.z * sample.normalZ);
        const dynamicPressureArea = 0.5 * waterDensity * wettedBeam * length;
        let normal = dynamicPressureArea * (planing * 2 * Math.max(forward, 0) * intoBottom + floats.crossflow * heave * Math.abs(heave))
          + waterDensity * wettedBeam * length * floats.heaveDamping * heave;
        normal = Math.max(normal, -SUCTION_SHARE * buoyancy);

        // Skin friction on the wetted girth and the displacement drag of the immersed volume.
        const friction = 0.5 * waterDensity * floats.friction * girth * length * forward * Math.abs(forward);
        const wave = buoyancy * displacementDragShape(Math.abs(forward) / floats.hump.waveDragSpeed, floats.hump.waveDrag) * Math.sign(forward);
        // The keel resists sideslip: cross-flow drag on the side and keel lift with the forward speed.
        const sideArea = immersed * length;
        const side = -0.5 * waterDensity * sideArea * (floats.sideDrag * sideways * Math.abs(sideways) + floats.keelLift * Math.max(forward, 0) * sideways);

        stationForce.set(side, normal, friction + wave);
        addBodyForce(stationForce, station.relative, momentBody);
        lever.set(0, immersed * 0.6, 0);
        offsetWorld.copy(station.relative).add(lever);
        forceSum.add(buoyancyBody);
        lever.crossVectors(offsetWorld, buoyancyBody);
        momentBody.add(lever);

        hydro.planingLift += Math.max(normal, 0);
        hydro.buoyancy += buoyancy;
        hydro.drag += friction + wave;
        forwardSum += forward * buoyancy;
        forwardWeight += buoyancy;
        if (!wetHull[station.hull]) {
          wetHull[station.hull] = true;
          wetFloats++;
          // The first touch: the sink rate into the water at the touching station.
          const sink = -(pointVelocity.x * sample.normalX + pointVelocity.y * sample.normalY + pointVelocity.z * sample.normalZ);
          if (sink > sinkRate || touchPart === '') {
            sinkRate = Math.max(0, sink);
            touchPart = station.hull === 0 ? 'leftFloat' : 'rightFloat';
          }
        }
        hydro.waterKind = sample.kind;
      }
      if (wetFloats > 0) {
        hydro.floating = true;
        hydro.waterSpeed = forwardWeight > 0 ? forwardSum / forwardWeight : 0;
      }
      waterRudderForces(tick, momentBody);
      wheelForces(tick, momentBody);
      strikeWater(tick, report);
      porpoiseForces(tick, momentBody, dt);
      forceWorld.add(forceSum.applyQuaternion(tick.quaternion));
    } else {
      hydro.porpoise = 0;
      hydro.wheelSeconds = 0;
    }
    if (!hydro.floating) hydro.waterSpeed = 0;
    hydro.trim = flightData.pitch / DEG - floats.keelIncidence;
    hydro.heldTrim += (hydro.trim - hydro.heldTrim) * Math.min(1, dt / HELD_TRIM_SECONDS);
    completeReport(tick, report, wetFloats, sinkRate, touchPart, landGear);
    updateStep(dt);
    hydro.spray = hydro.floating ? clamp(smoothstep(2.5, 9, Math.abs(hydro.waterSpeed)) * ((hydro.planingLift + 0.4 * hydro.buoyancy * smoothstep(4, humpSpeed, Math.abs(hydro.waterSpeed))) / weight), 0, 1) : 0;
  }

  /** The water rudders (when down): side force from the pedals and the toe brakes, only where the stern is wet. */
  function waterRudderForces(tick, momentBody) {
    if (craftState.waterRudders !== true || !hydro.floating) return;
    const rudder = floats.waterRudder;
    const controls = tick.controls;
    const toe = controls ? (Number.isFinite(controls.brakeR) ? controls.brakeR : 0) - (Number.isFinite(controls.brakeL) ? controls.brakeL : 0) : 0;
    const command = clamp(tick.surfaces.rudder + toe, -1, 1);
    const deflection = command * rudder.maxDeflection * DEG;
    for (const blade of rudders) {
      pointState(tick, blade.relative);
      const ground = tick.env.groundHeight(pointWorld.x, pointWorld.z);
      waterSampleAt(tick.env, pointWorld.x, pointWorld.z, sample);
      if (!isOpenWater(sample, ground)) continue;
      const wet = clamp((sample.height - (pointWorld.y - rudder.depth * 0.5)) / rudder.depth, 0, 1);
      if (wet <= 0) continue;
      pointVelocity.x -= sample.velocityX;
      pointVelocity.y -= sample.velocityY;
      pointVelocity.z -= sample.velocityZ;
      bodyVelocity.copy(pointVelocity).applyQuaternion(inverseQuaternion);
      const forward = -bodyVelocity.z;
      const sideways = bodyVelocity.x;
      const area = rudder.area * wet;
      const pressure = 0.5 * waterDensity * area;
      // Right pedal swings the blades' trailing edges right: the water pushes the sterns left (nose right).
      const side = -pressure * (forward * Math.abs(forward) * rudderLift(deflection, rudder.liftSlope) + rudder.liftSlope * Math.max(forward, 0) * sideways * 0.5);
      const drag = pressure * forward * Math.abs(forward) * (0.03 + 1.1 * Math.sin(deflection) ** 2);
      stationForce.set(side, 0, drag);
      addBodyForce(stationForce, blade.relative, momentBody);
    }
  }

  /** The amphibian wheels in the water: drag low under the floats; above the nose-over speed they dig in. */
  function wheelForces(tick, momentBody) {
    const extension = tick.systems.gearPosition;
    if (!(extension > 0.3)) {
      hydro.wheelSeconds = 0;
      return;
    }
    let wheelSpeed = 0;
    for (const wheel of wheels) {
      pointState(tick, wheel.relative);
      const ground = tick.env.groundHeight(pointWorld.x, pointWorld.z);
      waterSampleAt(tick.env, pointWorld.x, pointWorld.z, sample);
      if (!isOpenWater(sample, ground)) continue;
      const wet = clamp((sample.height - (pointWorld.y - wheel.radius)) / (2 * wheel.radius), 0, 1);
      if (wet <= 0) continue;
      hydro.wheelsWet = true;
      pointVelocity.x -= sample.velocityX;
      pointVelocity.y -= sample.velocityY;
      pointVelocity.z -= sample.velocityZ;
      bodyVelocity.copy(pointVelocity).applyQuaternion(inverseQuaternion);
      const speed = bodyVelocity.length();
      stationForce.copy(bodyVelocity).multiplyScalar(-0.5 * waterDensity * floats.wheelDrag * wheel.area * wet * extension * speed);
      addBodyForce(stationForce, wheel.relative, momentBody);
      wheelSpeed = Math.max(wheelSpeed, Math.abs(bodyVelocity.z));
    }
    hydro.wheelSpeed = wheelSpeed;
    if (hydro.wheelsWet && wheelSpeed > noseOverSpeed) hydro.wheelSeconds += tick.dt;
    else hydro.wheelSeconds = 0;
  }

  /** Body points in the water: drag, and a body strike above limits.bodyStrikeSpeed. */
  function strikeWater(tick, report) {
    for (const point of strikePoints) {
      pointState(tick, point.relative);
      const water = waterHeightAt(tick.env, pointWorld.x, pointWorld.z);
      if (!(pointWorld.y < water) || !(water > tick.env.groundHeight(pointWorld.x, pointWorld.z))) continue;
      const speed = pointVelocity.length();
      if (speed > strikeSpeed && (!report.bodyStrike || speed > report.bodyStrike.speed)) {
        strike.part = point.id;
        strike.speed = speed;
        report.bodyStrike = strike;
      }
    }
  }

  /**
   * Porpoising: on the step, a trim outside the stable band grows a pitch-heave oscillation at the
   * profile's frequency; inside the band (or off the step) it dies away.
   */
  function porpoiseForces(tick, momentBody, dt) {
    const settings = floats.hump;
    const outside = Math.max(0, (hydro.heldTrim - settings.trimHigh) / settings.band, (settings.trimLow - hydro.heldTrim) / settings.band);
    const excess = hydro.onStep ? Math.min(outside, 1.5) : 0;
    if (excess > 0) hydro.porpoise += settings.porpoiseGrowth * excess * (1 - hydro.porpoise) * dt;
    else hydro.porpoise -= hydro.porpoise * Math.min(1, settings.porpoiseDecay * (hydro.floating ? 1 : 3) * dt);
    hydro.porpoise = clamp(hydro.porpoise, 0, 1);
    hydro.porpoisePhase = (hydro.porpoisePhase + 2 * Math.PI * settings.porpoiseFrequency * dt) % (2 * Math.PI);
    if (hydro.porpoise < 1e-4 || !hydro.floating) return;
    const load = Math.min(hydro.planingLift + hydro.buoyancy, 2 * weight);
    momentBody.x += hydro.porpoise * settings.porpoiseMoment * load * floatLength * Math.sin(hydro.porpoisePhase);
    stationForce.set(0, hydro.porpoise * settings.porpoiseHeave * load * Math.cos(hydro.porpoisePhase), 0);
    forceSum.add(stationForce);
  }

  /**
   * A reset on the water starts in the water configuration (wheels up); one on land keeps them down.
   * Decided on the first tick by the water under the centre of mass (a placement afloat may start
   * with the floats a little above the surface).
   */
  function resolveGearAfterReset(systems) {
    if (!hydro.resolveGear) return;
    hydro.resolveGear = false;
    if (!hydro.overWater) return;
    systems.gearDown = false;
    systems.gearPosition = 0;
  }

  /** Completes the controller's contact report: afloat, touchdowns, the nose-over and the skid on land. */
  function completeReport(tick, report, wetFloats, sinkRate, touchPart, landGear) {
    const systems = tick.systems;
    const velocity = tick.velocity;
    const groundSpeed = Math.hypot(velocity.x, velocity.z);
    hydro.onLand = landGear && !hydro.floating && systems.gearDown;
    if (hydro.floating) {
      report.floating = true;
      report.water = true;
      report.surface = 'water';
      report.onGround = true;
      report.contacts += wetFloats;
      report.gearContacts += wetFloats;
      if (!hydro.wasFloating && !landGear && hydro.airborneSeconds >= TOUCHDOWN_AIRBORNE_SECONDS && hydro.settleSeconds <= 0 && !report.touchdown) {
        touchdown.sinkRate = sinkRate;
        touchdown.part = touchPart;
        touchdown.groundSpeed = groundSpeed;
        report.touchdown = touchdown;
      }
    }
    hydro.airborneSeconds = hydro.floating || landGear ? 0 : hydro.airborneSeconds + tick.dt;
    hydro.settleSeconds = Math.max(0, hydro.settleSeconds - tick.dt);
    if (hydro.wheelSeconds >= NOSE_OVER_SECONDS) {
      strike.part = 'nose-over';
      strike.speed = hydro.wheelSpeed;
      report.bodyStrike = strike;
    } else if (landGear && systems.gearPosition < 0.5 && groundSpeed > skidCrashSpeed && (!report.bodyStrike || report.bodyStrike.speed < groundSpeed)) {
      strike.part = 'floats on land';
      strike.speed = groundSpeed;
      report.bodyStrike = strike;
    }
  }

  /** On the step: fast enough with the planing lift carrying most of the water load. Records the longest run. */
  function updateStep(dt) {
    const onStep = hydro.floating && Math.abs(hydro.waterSpeed) > STEP_SPEED_SHARE * humpSpeed && hydro.planingLift > STEP_LIFT_SHARE * (hydro.planingLift + hydro.buoyancy);
    if (onStep) {
      hydro.stepSeconds += dt;
    } else if (hydro.onStep) {
      if (hydro.stepSeconds >= STEP_RECORD_SECONDS) bus.emitTyped('journalStat', { key: 'seaplaneStepSeconds', value: Math.round(hydro.stepSeconds * 10) / 10, op: 'max' });
      hydro.stepSeconds = 0;
    }
    hydro.onStep = onStep;
  }

  // ============================================================================================
  // GEAR ADVISORY, CRAFT STATE, JOURNAL
  // ============================================================================================
  function afterStep(tick) {
    const systems = tick.systems;
    const airborne = !tick.contact.onGround;
    const approach = airborne && flightData.agl < WARNING_AGL && flightData.verticalSpeed < -WARNING_SINK;
    hydro.noseOverWarning = systems.gearDown && ((approach && hydro.overWater) || (hydro.floating && Math.abs(hydro.waterSpeed) > WATER_WARNING_SPEED));
    hydro.skidWarning = !systems.gearDown && approach && !hydro.overWater;
    craftState.onWater = hydro.floating;
    craftState.onStep = hydro.onStep;
    craftState.porpoise = Math.round(hydro.porpoise * 1000) / 1000;
    craftState.noseOverWarning = hydro.noseOverWarning;
    craftState.skidWarning = hydro.skidWarning;
    craftState.spray = Math.round(hydro.spray * 1000) / 1000;
    craftState.trim = Math.round(hydro.trim * 10) / 10;
    craftState.waterSpeed = Math.round(hydro.waterSpeed * 10) / 10;
    craftState.gearPosition = Math.round(systems.gearPosition * 1000) / 1000;
  }

  const unsubscribeLanded = bus.onTyped('landed', (landing) => {
    if (!landing || landing.craft !== craftId || landing.surface !== 'water') return;
    bus.emitTyped('journalStat', { key: 'seaplaneWaterLandings', value: 1, op: 'add' });
    if (hydro.waterKind === 'lake') bus.emitTyped('journalStat', { key: 'seaplaneLakeLandings', value: 1, op: 'add' });
  });

  return {
    shapeControls,
    contactForces,
    afterStep,

    reset(pose, systems) {
      // Airborne and on the water the wheels start up (the water configuration); a reset on the ground
      // starts with them down, and the first tick puts them up when that ground turns out to be water.
      const onGround = pose.onGround === true;
      systems.gearDown = onGround;
      systems.gearPosition = onGround ? 1 : 0;
      hydro.resolveGear = onGround;
      hydro.settleSeconds = onGround ? SETTLE_SECONDS : 0;
      hydro.floating = false;
      hydro.wasFloating = false;
      hydro.airborneSeconds = onGround ? 0 : TOUCHDOWN_AIRBORNE_SECONDS;
      hydro.onStep = false;
      hydro.stepSeconds = 0;
      hydro.porpoise = 0;
      hydro.porpoisePhase = 0;
      hydro.heldTrim = 0;
      hydro.wheelSeconds = 0;
      hydro.waterSpeed = 0;
      hydro.spray = 0;
      hydro.onLand = false;
      hydro.noseOverWarning = false;
      hydro.skidWarning = false;
      craftState.gearRequest = null;
    },

    snapshot() {
      return {
        floating: hydro.floating,
        airborneSeconds: hydro.airborneSeconds,
        onStep: hydro.onStep,
        stepSeconds: hydro.stepSeconds,
        porpoise: hydro.porpoise,
        porpoisePhase: hydro.porpoisePhase,
        heldTrim: hydro.heldTrim,
        wheelSeconds: hydro.wheelSeconds,
        waterSpeed: hydro.waterSpeed,
        resolveGear: hydro.resolveGear,
        settleSeconds: hydro.settleSeconds,
      };
    },

    restore(data) {
      if (!data) return;
      if (typeof data.floating === 'boolean') hydro.floating = data.floating;
      if (Number.isFinite(data.airborneSeconds)) hydro.airborneSeconds = data.airborneSeconds;
      if (typeof data.onStep === 'boolean') hydro.onStep = data.onStep;
      if (Number.isFinite(data.stepSeconds)) hydro.stepSeconds = data.stepSeconds;
      if (Number.isFinite(data.porpoise)) hydro.porpoise = data.porpoise;
      if (Number.isFinite(data.porpoisePhase)) hydro.porpoisePhase = data.porpoisePhase;
      if (Number.isFinite(data.heldTrim)) hydro.heldTrim = data.heldTrim;
      if (Number.isFinite(data.wheelSeconds)) hydro.wheelSeconds = data.wheelSeconds;
      if (Number.isFinite(data.waterSpeed)) hydro.waterSpeed = data.waterSpeed;
      if (typeof data.resolveGear === 'boolean') hydro.resolveGear = data.resolveGear;
      if (Number.isFinite(data.settleSeconds)) hydro.settleSeconds = data.settleSeconds;
    },

    /** Live hydrodynamic readouts (the lab's towing tank and the instruments' tests). */
    get hydro() {
      return hydro;
    },

    dispose() {
      unsubscribeLanded();
    },
  };
}
