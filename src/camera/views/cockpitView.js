// Cockpit view: the pilot's eye (cameraRig.eye, body axes relative to the craft root) with head
// pan / tilt from free look, a small lean toward the side the pilot looks at, and the craft's
// cockpit (canopy frame, panel, stick) built from cameraRig.cockpit and parented to the craft root
// so it moves exactly with the airframe.
import * as THREE from 'three/webgpu';
import { resolveCockpitDescriptor, buildCockpit } from '../cockpit.js';

const DEG = Math.PI / 180;
/** Head movement: full free-look deflection turns the head 135 degrees; snaps add 90. */
const LOOK_LIMITS = Object.freeze({ yawRange: 135, maxYaw: 160, up: 70, down: 50 });
const LEAN = Object.freeze({ side: 0.09, forward: 0.04, up: 0.03 });

export function createCockpitView() {
  let cockpit = null;
  let builtFor = null;
  let spec = null;
  const eye = new THREE.Vector3();
  const headEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const headQuaternion = new THREE.Quaternion();

  function disposeCockpit() {
    if (cockpit) cockpit.dispose();
    cockpit = null;
    builtFor = null;
  }

  return {
    id: 'cockpit',
    lookLimits: LOOK_LIMITS,

    /** A craft has a cockpit view when it has an eye point and is not an FPV craft. */
    isAvailable(rig) {
      return Boolean(rig && Array.isArray(rig.eye) && rig.eye.length === 3 && !(rig.fpv && Array.isArray(rig.fpv.position)));
    },

    /**
     * (Re)builds the cockpit for the craft whose mesh root is `root` (once per root and instrument
     * list) and returns it. The group sits at the eye inside the craft root, hidden until shown.
     */
    prepare(root, rig, instrumentIds) {
      const key = `${root.uuid}|${instrumentIds.join(',')}`;
      if (cockpit && builtFor === key) return cockpit;
      disposeCockpit();
      spec = resolveCockpitDescriptor(rig);
      cockpit = buildCockpit(spec, instrumentIds);
      cockpit.group.position.fromArray(rig.eye);
      cockpit.group.visible = false;
      root.add(cockpit.group);
      builtFor = key;
      return cockpit;
    },

    get cockpit() {
      return cockpit;
    },

    get near() {
      return cockpit ? cockpit.near : 0.08;
    },

    setVisible(visible) {
      if (cockpit) cockpit.group.visible = visible;
    },

    /** Swings the stick from the pilot's pitch / roll (-1..1). */
    animateStick(pitch, roll) {
      if (cockpit && cockpit.stick) cockpit.stick.animate(pitch, roll);
    },

    /** Writes the eye pose into out { position, quaternion }. look: { yaw, pitch } in degrees. */
    update(root, rig, look, out) {
      eye.fromArray(rig.eye);
      // Lean: a little toward the side the pilot looks at and forward when looking down.
      const sideShare = Math.sin(Math.min(Math.abs(look.yaw), 90) * DEG) * Math.sign(look.yaw);
      eye.x += LEAN.side * sideShare;
      eye.z -= LEAN.forward * Math.max(0, -look.pitch) / LOOK_LIMITS.down;
      eye.y += LEAN.up * Math.abs(sideShare);
      out.position.copy(eye).applyQuaternion(root.quaternion).add(root.position);
      headEuler.set(look.pitch * DEG, -look.yaw * DEG, 0, 'YXZ');
      headQuaternion.setFromEuler(headEuler);
      out.quaternion.copy(root.quaternion).multiply(headQuaternion);
    },

    dispose: disposeCockpit,
  };
}
