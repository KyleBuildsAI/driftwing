// Wing cam: rigidly mounted on or near the wingtip looking along the craft (cameraRig.wing
// { position, target } in body axes), so the airframe stays still in frame while the world moves.
// Craft without wing data get a mount derived from their right wingtip. Free look adds a small
// offset only.
import * as THREE from 'three/webgpu';

const DEG = Math.PI / 180;
const LOOK_LIMITS = Object.freeze({ yawRange: 22, maxYaw: 22, up: 14, down: 14 });

export function createWingView() {
  const mount = new THREE.Vector3();
  const target = new THREE.Vector3();
  const lookMatrix = new THREE.Matrix4();
  const localQuaternion = new THREE.Quaternion();
  const offsetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const offsetQuaternion = new THREE.Quaternion();
  const bodyUp = new THREE.Vector3(0, 1, 0);

  /** Fills mount / target (body axes) from the rig, or from the mesh's right wingtip. */
  function resolveMount(rig, mesh) {
    const wing = rig && rig.wing;
    if (wing && Array.isArray(wing.position) && Array.isArray(wing.target)) {
      mount.fromArray(wing.position);
      target.fromArray(wing.target);
      return true;
    }
    const tips = mesh && mesh.wingtips;
    const tip = tips && tips[1];
    if (!tip) return false;
    mount.set(tip.x * 0.5, tip.y + 0.7, tip.z + 1.6);
    target.set(0, tip.y * 0.5, -2);
    return true;
  }

  return {
    id: 'wing',
    lookLimits: LOOK_LIMITS,
    near: 0.2,

    isAvailable(rig, mesh) {
      return resolveMount(rig, mesh);
    },

    update(root, rig, look, out, mesh) {
      if (!resolveMount(rig, mesh)) return false;
      lookMatrix.lookAt(mount, target, bodyUp);
      localQuaternion.setFromRotationMatrix(lookMatrix);
      offsetEuler.set(look.pitch * DEG, -look.yaw * DEG, 0, 'YXZ');
      offsetQuaternion.setFromEuler(offsetEuler);
      out.position.copy(mount).applyQuaternion(root.quaternion).add(root.position);
      out.quaternion.copy(root.quaternion).multiply(localQuaternion).multiply(offsetQuaternion);
      return true;
    },
  };
}
