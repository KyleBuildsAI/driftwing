// Engine spatialisation: where the craft's own sound comes from, and its doppler shift.
//
// The engine synth feeds input, which crossfades between three routes:
//   external  - an HRTF PannerNode at the craft, the AudioListener at the camera (chase, wing,
//               flyby and photo views)
//   interior  - centred and low-passed (cockpit view of a closed cockpit)
//   direct    - centred and unfiltered (craft whose profile says spatial: false, such as v1's glider
//               hum, which v1 never positioned)
// PannerNode no longer applies doppler, so the shift is computed here from the relative radial
// velocity of craft and camera and handed back as a pitch factor the synth applies to its
// oscillators and playback rates.
import { clamp } from '../core/util.js';
import { glide } from './synthKit.js';

const SPEED_OF_SOUND = 343;
const REFERENCE_DISTANCE = 18;
const TELEPORT_SPEED = 1500;
const DOPPLER_RANGE = [0.5, 2.2];
const ROUTE_TIME_CONSTANT = 0.12;

/** deps: { context, destination, THREE }. */
export function createSpatializer({ context, destination, THREE }) {
  const input = context.createGain();
  const directGain = context.createGain();
  const externalGain = context.createGain();
  externalGain.gain.value = 0;
  const interiorGain = context.createGain();
  interiorGain.gain.value = 0;
  const interiorFilter = context.createBiquadFilter();
  interiorFilter.type = 'lowpass';
  interiorFilter.frequency.value = 900;
  interiorFilter.Q.value = 0.7;
  const panner = new PannerNode(context, {
    panningModel: 'HRTF',
    distanceModel: 'inverse',
    refDistance: REFERENCE_DISTANCE,
    maxDistance: 20000,
    rolloffFactor: 1,
  });
  input.connect(directGain);
  directGain.connect(destination);
  input.connect(externalGain);
  externalGain.connect(panner);
  panner.connect(destination);
  input.connect(interiorGain);
  interiorGain.connect(interiorFilter);
  interiorFilter.connect(destination);

  const listener = context.listener;
  const hasListenerParams = Boolean(listener.positionX);
  const listenerPosition = new THREE.Vector3();
  const lastListenerPosition = new THREE.Vector3();
  const listenerVelocity = new THREE.Vector3();
  const listenerForward = new THREE.Vector3();
  const listenerUp = new THREE.Vector3();
  const listenerQuaternion = new THREE.Quaternion();
  const toSource = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  let hasLastListener = false;
  let lastUpdateTime = 0;
  let route = 'direct';
  let doppler = 1;
  let distance = 0;

  function placeListener(time, timeConstant) {
    if (hasListenerParams) {
      glide(listener.positionX, listenerPosition.x, time, timeConstant);
      glide(listener.positionY, listenerPosition.y, time, timeConstant);
      glide(listener.positionZ, listenerPosition.z, time, timeConstant);
      glide(listener.forwardX, listenerForward.x, time, timeConstant);
      glide(listener.forwardY, listenerForward.y, time, timeConstant);
      glide(listener.forwardZ, listenerForward.z, time, timeConstant);
      glide(listener.upX, listenerUp.x, time, timeConstant);
      glide(listener.upY, listenerUp.y, time, timeConstant);
      glide(listener.upZ, listenerUp.z, time, timeConstant);
    } else {
      listener.setPosition(listenerPosition.x, listenerPosition.y, listenerPosition.z);
      listener.setOrientation(listenerForward.x, listenerForward.y, listenerForward.z, listenerUp.x, listenerUp.y, listenerUp.z);
    }
  }

  function placeSource(position, time, timeConstant) {
    glide(panner.positionX, position.x, time, timeConstant);
    glide(panner.positionY, position.y, time, timeConstant);
    glide(panner.positionZ, position.z, time, timeConstant);
  }

  /** Camera velocity from successive positions; a jump faster than any craft is a relocation. */
  function trackListenerVelocity(realTime) {
    const elapsed = realTime - lastUpdateTime;
    lastUpdateTime = realTime;
    if (!hasLastListener || !(elapsed > 0)) {
      hasLastListener = true;
      lastListenerPosition.copy(listenerPosition);
      listenerVelocity.set(0, 0, 0);
      return;
    }
    scratch.copy(listenerPosition).sub(lastListenerPosition).divideScalar(elapsed);
    lastListenerPosition.copy(listenerPosition);
    if (scratch.length() > TELEPORT_SPEED) listenerVelocity.set(0, 0, 0);
    else listenerVelocity.lerp(scratch, 0.5);
  }

  /** f' = f (c + v_listener toward source) / (c - v_source toward listener), clamped and smoothed. */
  function computeDoppler(sourcePosition, sourceVelocity) {
    toSource.copy(sourcePosition).sub(listenerPosition);
    distance = toSource.length();
    if (distance < 0.5) return 1;
    toSource.divideScalar(distance);
    const listenerTowardSource = listenerVelocity.dot(toSource);
    const sourceTowardListener = -sourceVelocity.dot(toSource);
    const denominator = Math.max(SPEED_OF_SOUND - sourceTowardListener, SPEED_OF_SOUND * 0.25);
    return clamp((SPEED_OF_SOUND + listenerTowardSource) / denominator, DOPPLER_RANGE[0], DOPPLER_RANGE[1]);
  }

  return {
    input,

    /**
     * frame fields used: time, realTime, interval, interior, profile, flight (position, velocity),
     * paused, camera. Returns the doppler pitch factor for this update.
     */
    update(frame) {
      const { time, interval, profile, flight, camera } = frame;
      const nextRoute = frame.interior && profile.interiorCutoff > 0 ? 'interior' : frame.interior || profile.spatial === false ? 'direct' : 'external';
      route = nextRoute;
      glide(directGain.gain, route === 'direct' ? 1 : 0, time, ROUTE_TIME_CONSTANT);
      glide(externalGain.gain, route === 'external' ? 1 : 0, time, ROUTE_TIME_CONSTANT);
      glide(interiorGain.gain, route === 'interior' ? 1 : 0, time, ROUTE_TIME_CONSTANT);
      if (route === 'interior') glide(interiorFilter.frequency, profile.interiorCutoff, time, ROUTE_TIME_CONSTANT);

      camera.updateWorldMatrix(true, false);
      camera.getWorldPosition(listenerPosition);
      camera.getWorldQuaternion(listenerQuaternion);
      listenerForward.set(0, 0, -1).applyQuaternion(listenerQuaternion);
      listenerUp.set(0, 1, 0).applyQuaternion(listenerQuaternion);
      trackListenerVelocity(frame.realTime);
      const positionConstant = interval / 3;
      placeListener(time, positionConstant);
      placeSource(flight.position, time, positionConstant);

      let target = 1;
      if (route === 'external') {
        scratch.copy(flight.velocity);
        if (frame.paused || !Number.isFinite(scratch.x + scratch.y + scratch.z)) scratch.set(0, 0, 0);
        target = computeDoppler(flight.position, scratch);
      } else {
        distance = 0;
      }
      doppler += (target - doppler) * 0.45;
      return doppler;
    },

    describe() {
      return {
        route,
        doppler,
        distance,
        panningModel: panner.panningModel,
        gains: { direct: directGain.gain.value, external: externalGain.gain.value, interior: interiorGain.gain.value },
        source: { x: panner.positionX.value, y: panner.positionY.value, z: panner.positionZ.value },
        listenerVelocity: { x: listenerVelocity.x, y: listenerVelocity.y, z: listenerVelocity.z },
      };
    },
  };
}
