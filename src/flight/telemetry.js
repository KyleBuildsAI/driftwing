// Flight telemetry: state.flight, the one read-only description of the craft every other system
// (HUD, instruments, audio, camera, copilot, test harness, and later replay and multiplayer) reads.
// The flight controller writes it once per rendered frame from the interpolated pose. All values
// are SI (m, m/s, kg) unless the field name says otherwise; angles are degrees.
import * as THREE from 'three/webgpu';

export const SPEED_OF_SOUND_SEA_LEVEL = 340.3;
export const SEA_LEVEL_DENSITY = 1.225;
export const DENSITY_SCALE_HEIGHT = 8500;

/** Air density (kg/m^3) at altitude h metres: rho = 1.225 * exp(-h / 8500). */
export function airDensity(altitude) {
  return SEA_LEVEL_DENSITY * Math.exp(-Math.max(altitude, -500) / DENSITY_SCALE_HEIGHT);
}

/** Speed of sound (m/s) with the standard-atmosphere lapse to the tropopause (11 km). */
export function speedOfSound(altitude) {
  const temperature = 288.15 - 0.0065 * Math.min(Math.max(altitude, 0), 11000);
  return Math.sqrt(1.4 * 287.05 * temperature);
}

export function createFlightTelemetry() {
  return {
    mode: 'classic',
    craft: 'glider',
    /** Fixed physics ticks run so far (SIM) and the interpolation fraction of this frame. */
    tick: 0,
    alpha: 0,

    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    airVelocity: new THREE.Vector3(),
    wind: new THREE.Vector3(),
    turbulence: 0,
    quaternion: new THREE.Quaternion(),
    /** Body rates in rad/s about the craft axes (x right, y up, -z forward): x nose up +, y nose left +, z right wing up +. */
    angularVelocity: new THREE.Vector3(),

    airspeed: 0,
    indicatedAirspeed: 0,
    groundSpeed: 0,
    mach: 0,
    altitude: 0,
    agl: 0,
    radarAltitude: 0,
    verticalSpeed: 0,
    /** Total-energy variometer (m/s): climb rate corrected for speed changes (gliders). */
    vario: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    aoa: 0,
    sideslip: 0,
    gLoad: 1,
    glideRatio: 0,

    throttle: 0,
    afterburner: false,
    engineOn: true,
    /** Engine or motor speed, 0..1 of rated. */
    rpm: 0,
    /** Helicopter rotor speed, 1 = governed. */
    rotorRpm: 0,
    /** Helicopter main-rotor torque, 1 = rated. */
    torque: 0,
    flaps: 0,
    flapNotch: 0,
    gear: { retractable: false, down: true, transit: 0 },
    airbrake: 0,
    brakes: 0,
    /** SIM: the parking brake holds the wheels at idle after a ground start (parkingBrake.js). */
    parkingBrake: false,
    trim: 0,

    onGround: false,
    contacts: 0,
    stall: { warning: false, stalled: false, buffet: 0 },
    /** Airspeed above the craft's Vne (SIM): flutter shakes the airframe until it slows down. */
    overspeed: false,
    assists: 1,
    activeAssists: [],
    autopilot: { enabled: false, heading: 0, altitude: 0, speed: 0 },
    lastLanding: null,
    bestLanding: null,
    crash: { active: false, reason: '', progress: 0 },
    /** Craft-specific state (for example chute, drone flight mode, afterburner detent). */
    craftState: {},
  };
}
