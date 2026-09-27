// Ground contact for SIM craft. Every contact point of a craft profile (wheels, skids and body points
// in body axes: x right, y up, z aft, m) is tested against the SHARED deterministic height function
// (env.groundHeight, the one the terrain mesh is built from, so contact works where no chunk is
// loaded) and the water level. A touching point pushes back with a spring-damper along the ground
// normal; wheels roll (rolling resistance, brakes, side grip, steering), skids and body points slide.
//
// Each evaluate() fills a report the flight controller reads after the tick:
//   onGround     any point touching dry ground (or water for craft that float)
//   touchdown    { sinkRate, part, groundSpeed } on the first gear contact after being airborne
//   bodyStrike   { part, speed } for the fastest non-gear point touching this tick
//   water        a point in the water (a soft crash for craft that cannot float)
//   penetration  the deepest point below the surface (m)
import * as THREE from 'three/webgpu';
import { DEG, clamp } from '../core/util.js';

const DEFAULTS = Object.freeze({
  WHEEL: Object.freeze({ spring: 40000, damping: 3000, rollingFriction: 0.04, sideFriction: 0.8, brakeFriction: 0.55, steerAngle: 28 }),
  SKID: Object.freeze({ spring: 40000, damping: 3000, friction: 0.45 }),
  BODY: Object.freeze({ spring: 90000, damping: 6000, friction: 0.6 }),
});
/**
 * Speeds (m/s) below which Coulomb friction turns viscous, which keeps a resting craft stable at
 * 120 Hz. The rolling band is narrow so rolling resistance and brakes hold like static friction
 * (idle thrust does not creep a parked craft).
 */
const ROLLING_SLIP = 0.03;
const SIDE_SLIP = 0.8;
const SLIDE_SLIP = 0.35;
/** A touchdown counts after this long without any gear contact (shorter gaps are bounces). */
const TOUCHDOWN_AIRBORNE_SECONDS = 0.25;
const NORMAL_PROBE = 0.6;
const MAX_NORMAL_FORCE_G = 40;
/** Water acts as a surface for floating craft, with this much drag. */
const WATER_FRICTION = 0.35;
/** Tail-wheel steering fades out between these ground speeds (m/s); above it the wheel only castors. */
const STEERING_FADE = Object.freeze({ START: 6, END: 22, MIN_SHARE: 0.2 });

/** Normalizes one profile contact into the evaluator's form (position relative to the centre of mass). */
function prepareContact(definition, centerOfMass) {
  const kind = definition.kind === 'wheel' || definition.kind === 'skid' ? definition.kind : 'body';
  const defaults = kind === 'wheel' ? DEFAULTS.WHEEL : kind === 'skid' ? DEFAULTS.SKID : DEFAULTS.BODY;
  const local = new THREE.Vector3().fromArray(definition.position);
  return {
    id: definition.id,
    kind,
    gear: definition.gear === true && kind !== 'body',
    retracts: definition.retracts === true,
    local,
    relative: local.clone().sub(centerOfMass),
    spring: Number.isFinite(definition.spring) ? definition.spring : defaults.spring,
    damping: Number.isFinite(definition.damping) ? definition.damping : defaults.damping,
    friction: Number.isFinite(definition.friction) ? definition.friction : defaults.friction ?? 0.5,
    rollingFriction: Number.isFinite(definition.rollingFriction) ? definition.rollingFriction : DEFAULTS.WHEEL.rollingFriction,
    sideFriction: Number.isFinite(definition.sideFriction) ? definition.sideFriction : DEFAULTS.WHEEL.sideFriction,
    brakeFriction: Number.isFinite(definition.brakeFriction) ? definition.brakeFriction : DEFAULTS.WHEEL.brakeFriction,
    brakes: definition.brake === true,
    steerable: definition.steerable === true,
    steerAngle: (Number.isFinite(definition.steerAngle) ? definition.steerAngle : DEFAULTS.WHEEL.steerAngle) * DEG,
    /** Rotation sign about body up for a right (positive) steering input: aft wheels turn the other way. */
    steerSign: local.z > centerOfMass.z ? 1 : -1,
    /** -1 left, 1 right, 0 on the centreline: which toe brake acts on it. */
    side: local.x < -0.1 ? -1 : local.x > 0.1 ? 1 : 0,
    touching: false,
    compression: 0,
  };
}

/**
 * Creates the contact evaluator for one craft. options: { centerOfMass (THREE.Vector3, body axes),
 * floats (water is a surface), mass (kg, bounds the normal force) }.
 */
export function createGroundContact(definitions, { centerOfMass, floats = false, mass = 1000 }) {
  const contacts = definitions.map((definition) => prepareContact(definition, centerOfMass));
  const boundingRadius = contacts.reduce((radius, contact) => Math.max(radius, contact.relative.length()), 1);
  const maxNormalForce = MAX_NORMAL_FORCE_G * mass * 9.81;

  const report = {
    onGround: false,
    touchdown: null,
    bodyStrike: null,
    water: false,
    penetration: 0,
    contacts: 0,
    gearContacts: 0,
    /** Ground speed of the fastest rolling wheel, for the mesh's wheel animation (m/s). */
    wheelSpeed: 0,
  };
  const touchdown = { sinkRate: 0, part: '', groundSpeed: 0 };
  const strike = { part: '', speed: 0 };
  let airborneSeconds = 0;

  const worldPoint = new THREE.Vector3();
  const offsetWorld = new THREE.Vector3();
  const pointVelocity = new THREE.Vector3();
  const spinVelocity = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const lateral = new THREE.Vector3();
  const tangential = new THREE.Vector3();
  const force = new THREE.Vector3();
  const bodyForce = new THREE.Vector3();
  const torque = new THREE.Vector3();
  const inverseQuaternion = new THREE.Quaternion();
  const steerQuaternion = new THREE.Quaternion();
  const BODY_UP = new THREE.Vector3(0, 1, 0);

  /** Ground normal from the shared height function's gradient around (x, z). */
  function groundNormal(env, x, z, target) {
    const east = env.groundHeight(x + NORMAL_PROBE, z);
    const west = env.groundHeight(x - NORMAL_PROBE, z);
    const south = env.groundHeight(x, z + NORMAL_PROBE);
    const north = env.groundHeight(x, z - NORMAL_PROBE);
    return target.set((west - east) / (2 * NORMAL_PROBE), 1, (north - south) / (2 * NORMAL_PROBE)).normalize();
  }

  function clearReport() {
    report.onGround = false;
    report.touchdown = null;
    report.bodyStrike = null;
    report.water = false;
    report.penetration = 0;
    report.contacts = 0;
    report.gearContacts = 0;
    report.wheelSpeed = 0;
    for (const contact of contacts) {
      contact.touching = false;
      contact.compression = 0;
    }
  }

  /**
   * Adds the contact forces for one tick. body: { position (centre of mass, world), velocity (world),
   * quaternion (body to world), angularVelocity (body) }. inputs: { brakeLeft, brakeRight (0..1),
   * steering (-1..1, tail-wheel / nose-wheel), gearDown (retractable gear extended) }. env: the tick
   * environment ({ groundHeight(x, z), waterLevel }). Adds the world force to forceWorld and the
   * body-axes moment about the centre of mass to momentBody. Returns the report.
   */
  function evaluate(body, inputs, env, dt, forceWorld, momentBody) {
    clearReport();
    const position = body.position;
    const surfaceBelow = Math.max(env.groundHeight(position.x, position.z), env.waterLevel);
    // Broad phase: nothing can touch while the centre of mass is well clear of the ground below it
    // (twice the craft's reach covers slopes up to 45 degrees under a wingtip).
    if (position.y - surfaceBelow > boundingRadius * 2 + 3) {
      airborneSeconds += dt;
      return report;
    }
    inverseQuaternion.copy(body.quaternion).invert();
    let gearTouching = false;
    let fastestStrike = -1;
    for (const contact of contacts) {
      if (contact.retracts && !inputs.gearDown) continue;
      offsetWorld.copy(contact.relative).applyQuaternion(body.quaternion);
      worldPoint.copy(position).add(offsetWorld);
      const ground = env.groundHeight(worldPoint.x, worldPoint.z);
      const overWater = ground < env.waterLevel;
      if (overWater && worldPoint.y < env.waterLevel) report.water = true;
      if (overWater && !floats) {
        if (worldPoint.y >= ground) continue;
      }
      const surface = overWater && floats ? env.waterLevel : ground;
      const depth = surface - worldPoint.y;
      if (depth <= 0) continue;

      if (overWater && floats) normal.set(0, 1, 0);
      else groundNormal(env, worldPoint.x, worldPoint.z, normal);
      const penetration = depth * normal.y;
      spinVelocity.crossVectors(body.angularVelocity, contact.relative).applyQuaternion(body.quaternion);
      pointVelocity.copy(body.velocity).add(spinVelocity);
      const normalSpeed = pointVelocity.dot(normal);
      let normalForce = contact.spring * penetration - contact.damping * normalSpeed;
      normalForce = clamp(normalForce, 0, maxNormalForce);
      force.copy(normal).multiplyScalar(normalForce);

      tangential.copy(pointVelocity).addScaledVector(normal, -normalSpeed);
      if (contact.kind === 'wheel' && !(overWater && floats)) {
        // Wheel frame: the body's nose direction (steered for a steerable wheel) laid onto the ground.
        forward.set(0, 0, -1);
        if (contact.steerable && inputs.steering !== 0) {
          // Right rudder points a nose wheel right and a tail wheel left (the tail swings left).
          const groundSpeed = tangential.length();
          const fade = 1 - (1 - STEERING_FADE.MIN_SHARE) * clamp((groundSpeed - STEERING_FADE.START) / (STEERING_FADE.END - STEERING_FADE.START), 0, 1);
          steerQuaternion.setFromAxisAngle(BODY_UP, contact.steerSign * inputs.steering * contact.steerAngle * fade);
          forward.applyQuaternion(steerQuaternion);
        }
        forward.applyQuaternion(body.quaternion);
        forward.addScaledVector(normal, -forward.dot(normal));
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();
        lateral.crossVectors(normal, forward);
        const rolling = tangential.dot(forward);
        const sliding = tangential.dot(lateral);
        const brake = contact.brakes ? (contact.side < 0 ? inputs.brakeLeft : contact.side > 0 ? inputs.brakeRight : Math.max(inputs.brakeLeft, inputs.brakeRight)) : 0;
        const longitudinalGrip = contact.rollingFriction + contact.brakeFriction * clamp(brake, 0, 1);
        let longitudinal = -longitudinalGrip * normalForce * clamp(rolling / ROLLING_SLIP, -1, 1);
        let side = -contact.sideFriction * normalForce * clamp(sliding / SIDE_SLIP, -1, 1);
        // Friction circle: braking and cornering share the tyre's grip.
        const limit = Math.max(contact.sideFriction, longitudinalGrip) * normalForce;
        const total = Math.hypot(longitudinal, side);
        if (total > limit && total > 0) {
          longitudinal *= limit / total;
          side *= limit / total;
        }
        force.addScaledVector(forward, longitudinal).addScaledVector(lateral, side);
        report.wheelSpeed = Math.max(report.wheelSpeed, Math.abs(rolling));
      } else {
        const friction = overWater && floats ? WATER_FRICTION : contact.friction;
        const slideSpeed = tangential.length();
        if (slideSpeed > 1e-6) force.addScaledVector(tangential, (-friction * normalForce * Math.min(1, slideSpeed / SLIDE_SLIP)) / slideSpeed);
      }

      forceWorld.add(force);
      bodyForce.copy(force).applyQuaternion(inverseQuaternion);
      torque.crossVectors(contact.relative, bodyForce);
      momentBody.add(torque);

      contact.touching = true;
      contact.compression = penetration;
      report.contacts++;
      report.onGround = true;
      report.penetration = Math.max(report.penetration, penetration);
      if (contact.gear) {
        report.gearContacts++;
        if (!gearTouching) {
          gearTouching = true;
          if (airborneSeconds >= TOUCHDOWN_AIRBORNE_SECONDS) {
            touchdown.sinkRate = Math.max(0, -body.velocity.dot(normal));
            touchdown.part = contact.id;
            touchdown.groundSpeed = Math.hypot(body.velocity.x, body.velocity.z);
            report.touchdown = touchdown;
          }
        }
      } else {
        const speed = pointVelocity.length();
        if (speed > fastestStrike) {
          fastestStrike = speed;
          strike.part = contact.id;
          strike.speed = speed;
          report.bodyStrike = strike;
        }
      }
    }
    airborneSeconds = gearTouching ? 0 : airborneSeconds + dt;
    return report;
  }

  return {
    contacts,
    boundingRadius,
    report,
    evaluate,

    /** Seconds since any gear last touched. */
    get airborneSeconds() {
      return airborneSeconds;
    },

    /** After a teleport: resting on the gear (no touchdown will be reported) or airborne. */
    reset(onGround) {
      clearReport();
      airborneSeconds = onGround ? 0 : TOUCHDOWN_AIRBORNE_SECONDS;
    },

    snapshot() {
      return { airborneSeconds };
    },

    restore(data) {
      if (data && Number.isFinite(data.airborneSeconds)) airborneSeconds = data.airborneSeconds;
    },
  };
}
