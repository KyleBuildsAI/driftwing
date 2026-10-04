// FPV view: the camera of an FPV craft, locked to the frame at cameraRig.fpv.position (body axes)
// and tilted up by the player's settings.fpv.uptilt (0-40 degrees; the rig's own uptilt, default 25,
// when no setting is given), with the settings.fov.fpv lens. A rig that names the camera's pivot and
// lens distance (cameraRig.fpv.pivot, lensDistance) has its lens swing with the tilt, as the mesh's
// camera cage does. Free look adds a small offset, as a head tracker would.
import * as THREE from 'three/webgpu';

const DEG = Math.PI / 180;
const LOOK_LIMITS = Object.freeze({ yawRange: 20, maxYaw: 20, up: 12, down: 12 });
export const FPV_DEFAULT_UPTILT = 25;
export const FPV_MAX_UPTILT = 40;

function clampUptilt(value) {
  return Math.min(FPV_MAX_UPTILT, Math.max(0, value));
}

/** The uptilt in degrees (0-40): the setting when it is a number, else the rig's, else the default. */
export function fpvUptilt(rig, settingUptilt = null) {
  if (Number.isFinite(settingUptilt)) return clampUptilt(settingUptilt);
  const value = rig && rig.fpv && Number.isFinite(rig.fpv.uptilt) ? rig.fpv.uptilt : FPV_DEFAULT_UPTILT;
  return clampUptilt(value);
}

/**
 * The lens position (body axes) at an uptilt: lensDistance ahead of the pivot along the tilted
 * optical axis when the rig names both, else the rig's fixed position.
 */
export function fpvLensPosition(rig, uptiltDegrees, out = new THREE.Vector3()) {
  const fpv = rig.fpv;
  if (Array.isArray(fpv.pivot) && fpv.pivot.length === 3 && Number.isFinite(fpv.lensDistance)) {
    const tilt = uptiltDegrees * DEG;
    return out.set(fpv.pivot[0], fpv.pivot[1] + fpv.lensDistance * Math.sin(tilt), fpv.pivot[2] - fpv.lensDistance * Math.cos(tilt));
  }
  return out.fromArray(fpv.position);
}

/**
 * settings / bus (optional): the settings store and event bus; settings.fpv.uptilt is read once and
 * then followed on 'settings:changed'.
 */
export function createFpvView({ settings = null, bus = null } = {}) {
  const mount = new THREE.Vector3();
  const tiltEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const tiltQuaternion = new THREE.Quaternion();
  const initial = settings && typeof settings.get === 'function' ? settings.get('fpv') : null;
  let settingUptilt = initial && Number.isFinite(initial.uptilt) ? initial.uptilt : null;
  if (bus) {
    bus.on('settings:changed', (change) => {
      if (change && change.key === 'fpv' && change.value && Number.isFinite(change.value.uptilt)) settingUptilt = change.value.uptilt;
    });
  }

  return {
    id: 'fpv',
    lookLimits: LOOK_LIMITS,

    isAvailable(rig) {
      return Boolean(rig && rig.fpv && Array.isArray(rig.fpv.position) && rig.fpv.position.length === 3);
    },

    nearFor(rig) {
      return rig && rig.fpv && Number.isFinite(rig.fpv.near) ? rig.fpv.near : 0.03;
    },

    /** The uptilt this view flies with for a rig (degrees). */
    uptilt(rig) {
      return fpvUptilt(rig, settingUptilt);
    },

    update(root, rig, look, out) {
      const uptilt = fpvUptilt(rig, settingUptilt);
      fpvLensPosition(rig, uptilt, mount);
      out.position.copy(mount).applyQuaternion(root.quaternion).add(root.position);
      tiltEuler.set((uptilt + look.pitch) * DEG, -look.yaw * DEG, 0, 'YXZ');
      tiltQuaternion.setFromEuler(tiltEuler);
      out.quaternion.copy(root.quaternion).multiply(tiltQuaternion);
      return true;
    },
  };
}
