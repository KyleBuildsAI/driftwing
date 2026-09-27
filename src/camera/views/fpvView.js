// FPV view: the camera of an FPV craft, locked to the frame at cameraRig.fpv.position (body axes)
// and tilted up by cameraRig.fpv.uptilt degrees (0-40, default 25), with the settings.fov.fpv lens.
// The craft supplies only this data. Free look adds a small offset, as a head tracker would.
import * as THREE from 'three/webgpu';

const DEG = Math.PI / 180;
const LOOK_LIMITS = Object.freeze({ yawRange: 20, maxYaw: 20, up: 12, down: 12 });
export const FPV_DEFAULT_UPTILT = 25;

/** The rig's uptilt in degrees, clamped to 0-40. */
export function fpvUptilt(rig) {
  const value = rig && rig.fpv && Number.isFinite(rig.fpv.uptilt) ? rig.fpv.uptilt : FPV_DEFAULT_UPTILT;
  return Math.min(40, Math.max(0, value));
}

export function createFpvView() {
  const mount = new THREE.Vector3();
  const tiltEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const tiltQuaternion = new THREE.Quaternion();

  return {
    id: 'fpv',
    lookLimits: LOOK_LIMITS,

    isAvailable(rig) {
      return Boolean(rig && rig.fpv && Array.isArray(rig.fpv.position) && rig.fpv.position.length === 3);
    },

    nearFor(rig) {
      return rig && rig.fpv && Number.isFinite(rig.fpv.near) ? rig.fpv.near : 0.03;
    },

    update(root, rig, look, out) {
      mount.fromArray(rig.fpv.position);
      out.position.copy(mount).applyQuaternion(root.quaternion).add(root.position);
      tiltEuler.set((fpvUptilt(rig) + look.pitch) * DEG, -look.yaw * DEG, 0, 'YXZ');
      tiltQuaternion.setFromEuler(tiltEuler);
      out.quaternion.copy(root.quaternion).multiply(tiltQuaternion);
      return true;
    },
  };
}
