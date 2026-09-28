// CAMERA SYSTEM (ctx.systems.camera): owns the views, free look, per-view lenses, photo mode and the
// cockpit instruments.
//
// Views: 'chase' (the v1 rig in chase.js, unchanged), 'cockpit' (the craft's eye point with its
// cockpit and instrument panel), 'wing' (rigid wingtip mount), 'flyby' (fixed camera ahead on the
// flight path) and 'fpv' (the frame-locked camera of an FPV craft, which takes the first-person slot
// when the craft's cameraRig.fpv exists). settings.views remembers the player's view per mode
// (CLASSIC defaults to chase, SIM to cockpit; the first-person slot is stored as 'cockpit') and a
// mode switch moves to that mode's view. Every change, and the start, emits the typed viewChanged.
//
// Input: the camera owns viewCycle, viewForward (first person), viewBack (chase), viewLeft /
// viewRight (look 90 degrees, press again to look ahead) and recenterView, from 'input:action'
// presses of any source. Free look is ControlState lookX / lookY (absolute deflection: right-drag,
// gamepad right stick, HOTAS mini-stick; releasing returns to centre) plus the 90 degree snaps:
// head pan / tilt in the cockpit, an orbit around the craft in chase, a small offset elsewhere. The
// look angles follow their targets through an exponential ease, so nothing pops.
//
// Lenses: settings.fov per view, live on settings:changed; the chase keeps v1's speed stretch
// around its base FOV. When the craft's inputProfile maps the HOTAS antenna to 'zoom',
// ControlState.antenna narrows the lens (up to 3x). Near planes are per view (cockpit 8 cm) and the
// v1 near plane comes back for chase and photo mode.
//
// Photo mode (v1) runs in chase.js from any view: it starts at the current camera pose, and on exit
// the camera returns to the view it came from (chase: v1's return flight; other views: the same
// eased 0.9 s return, done here).
//
// Instruments: one 30 Hz clock drives the instrument memories, the cockpit panel texture (while the
// cockpit is on screen) and the optional glass HUD overlay (settings.hud.overlay).
import * as THREE from 'three/webgpu';
import { CONFIG } from '../core/config.js';
import { VIEW_IDS } from '../core/settings.js';
import { clamp, isFiniteVector, isFiniteQuaternion } from '../core/util.js';
import { createCameraRig } from './chase.js';
import { createCockpitView } from './views/cockpitView.js';
import { createWingView } from './views/wingView.js';
import { createFlybyView } from './views/flybyView.js';
import { createFpvView } from './views/fpvView.js';
import { createInstrumentSet } from '../ui/instruments/index.js';
import { createInstrumentHud } from '../ui/instrumentHud.js';
import { createStickReticle } from '../ui/stickReticle.js';

const DEG = Math.PI / 180;
/** Cycle order of the view slots; 'cockpit' is the first-person slot (cockpit or FPV camera). */
const VIEW_ORDER = Object.freeze(['chase', 'cockpit', 'wing', 'flyby']);
const INSTRUMENT_INTERVAL = 1 / 30;
const LOOK_LAMBDA = 9;
const SNAP_DEGREES = 90;
const RETURN_SECONDS = 0.9;
/** Chase orbit: full deflection swings the camera round to the craft's nose. */
const CHASE_LOOK = Object.freeze({ yawRange: 180, maxYaw: 180, up: 55, down: 40 });
const CHASE_ORBIT_CLEARANCE = 3;
/** Narrow screens: first-person lenses widen so at least this horizontal FOV stays visible. */
const MIN_HORIZONTAL_FOV = 62;
const MAX_WIDENED_FOV = 115;
/** Antenna zoom: at full antenna the lens is ZOOM_MAX times narrower (in tan(fov / 2)). */
const ZOOM_MAX = 3;
const REDRAW_HISTORY = 31;

export function createCameraSystem(ctx) {
  const { camera, state, settings, bus, world } = ctx;
  const player = state.player;
  const chaseRig = createCameraRig(ctx);
  const views = {
    cockpit: createCockpitView(),
    wing: createWingView(),
    flyby: createFlybyView(ctx),
    fpv: createFpvView({ settings, bus }),
  };
  const instruments = createInstrumentSet(ctx);
  const hud = createInstrumentHud(ctx, instruments);
  const reticle = createStickReticle(ctx);

  let view = 'chase';
  let photo = false;
  // A view change during photo mode (a voice mode or craft switch) skips enterView; photo exit runs it.
  let enterPendingAfterPhoto = false;
  let fovSettings = readFovSettings();
  const look = { yaw: 0, pitch: 0, snapYaw: 0 };
  const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: CONFIG.CAMERA.FOV_BASE, near: CONFIG.CAMERA.NEAR };
  const returnFlight = { active: false, elapsed: 0, fromPosition: new THREE.Vector3(), fromQuaternion: new THREE.Quaternion(), fromFov: CONFIG.CAMERA.FOV_BASE };
  const orbit = {
    pivot: new THREE.Vector3(),
    offset: new THREE.Vector3(),
    right: new THREE.Vector3(),
    yaw: new THREE.Quaternion(),
    pitch: new THREE.Quaternion(),
    rotation: new THREE.Quaternion(),
  };
  const worldUp = new THREE.Vector3(0, 1, 0);
  const meshInfo = { wingtips: [new THREE.Vector3(), new THREE.Vector3()] };
  const inverseRoot = new THREE.Quaternion();
  let attachedRoot = null;
  const hiddenParts = [];
  let partsHiddenOn = null;
  let instrumentClock = 0;
  let instrumentElapsed = 0;
  let zoomTan = 1;
  const redrawTimes = [];
  // panelDrawMs / hudDrawMs: smoothed CPU time of one 30 Hz repaint.
  const counters = { panelRedraws: 0, hudTicks: 0, instrumentTicks: 0, viewChanges: 0, returnFlights: 0, panelDrawMs: 0, hudDrawMs: 0 };

  // ---- Context helpers ------------------------------------------------------------------------------
  function flightSystem() {
    return ctx.systems.flight || null;
  }
  function currentMode() {
    const flight = flightSystem();
    return flight && typeof flight.getMode === 'function' ? flight.getMode() : 'classic';
  }
  function currentCraft() {
    const flight = flightSystem();
    return flight && typeof flight.getCraft === 'function' ? flight.getCraft() : 'glider';
  }
  function currentRig() {
    const flight = flightSystem();
    return flight && typeof flight.getCameraRig === 'function' ? flight.getCameraRig() : null;
  }
  function currentRoot() {
    const flight = flightSystem();
    return flight ? flight.planeMesh : null;
  }
  function craftModule() {
    const flight = flightSystem();
    return flight && typeof flight.getCraftModule === 'function' ? flight.getCraftModule() : null;
  }
  function readFovSettings() {
    const fov = settings.get('fov');
    return fov && typeof fov === 'object' ? fov : { chase: CONFIG.CAMERA.FOV_BASE, cockpit: 74, wing: 68, flyby: 50, fpv: 120 };
  }

  /** Local wingtips (body axes) of the active mesh, for craft without wing-cam data. */
  function refreshMeshInfo(root) {
    const flight = flightSystem();
    if (!flight || typeof flight.getWingtips !== 'function' || !root) return;
    const tips = flight.getWingtips();
    inverseRoot.copy(root.quaternion).invert();
    for (let index = 0; index < 2; index++) meshInfo.wingtips[index].copy(tips[index]).sub(root.position).applyQuaternion(inverseRoot);
  }

  // ---- Views and slots --------------------------------------------------------------------------------
  /** The first-person view of the active craft: 'fpv', 'cockpit' or null. */
  function firstPersonView(rig) {
    if (views.fpv.isAvailable(rig)) return 'fpv';
    if (views.cockpit.isAvailable(rig)) return 'cockpit';
    return null;
  }

  /** The view a settings slot resolves to for the active craft (unavailable slots fall back to chase). */
  function resolveSlot(slot) {
    const rig = currentRig();
    if (slot === 'cockpit') return firstPersonView(rig) || 'chase';
    if (slot === 'wing') {
      if (!(rig && rig.wing)) refreshMeshInfo(currentRoot());
      return views.wing.isAvailable(rig, meshInfo) ? 'wing' : 'chase';
    }
    if (slot === 'flyby') return 'flyby';
    return 'chase';
  }

  function slotOf(viewId) {
    return viewId === 'fpv' ? 'cockpit' : viewId;
  }

  /** The slots the active craft can use, in cycle order. */
  function availableSlots() {
    return VIEW_ORDER.filter((slot) => resolveSlot(slot) !== 'chase' || slot === 'chase');
  }

  function viewModule(viewId) {
    return views[viewId] || null;
  }

  function emitViewChanged() {
    bus.emitTyped('viewChanged', { view, craft: currentCraft(), mode: currentMode() });
  }

  // ---- Craft parts hidden in the cockpit ----------------------------------------------------------------
  function hideCockpitParts(root) {
    if (!root || partsHiddenOn === root) return;
    restoreCockpitParts();
    partsHiddenOn = root;
    root.traverse((node) => {
      if (!node.userData || node.userData.hideInCockpit !== true) return;
      hiddenParts.push({ node, visible: node.visible });
      node.visible = false;
    });
  }

  function restoreCockpitParts() {
    for (const part of hiddenParts) part.node.visible = part.visible;
    hiddenParts.length = 0;
    partsHiddenOn = null;
  }

  /** Shows the cockpit interior (and hides the clipping parts) or the plain exterior. */
  function setInterior(active) {
    const root = currentRoot();
    const rig = currentRig();
    if (active && root && rig) {
      instruments.refresh();
      views.cockpit.prepare(root, rig, instruments.ids);
      views.cockpit.setVisible(true);
      hideCockpitParts(root);
    } else {
      views.cockpit.setVisible(false);
      restoreCockpitParts();
    }
  }

  /** Follows a new craft mesh (craft change): rebuilds the cockpit on it and re-checks the view. */
  function syncRoot() {
    const root = currentRoot();
    if (root === attachedRoot) return false;
    restoreCockpitParts();
    views.cockpit.dispose();
    attachedRoot = root;
    views.flyby.reset();
    instruments.refresh();
    return true;
  }

  // ---- Lenses ------------------------------------------------------------------------------------------
  function viewFov(viewId) {
    const base = fovSettings[viewId === 'fpv' ? 'fpv' : viewId];
    let fov = Number.isFinite(base) ? base : CONFIG.CAMERA.FOV_BASE;
    if (viewId === 'cockpit' || viewId === 'wing' || viewId === 'fpv') fov = widenForNarrowScreens(fov);
    if (zoomTan !== 1) fov = (2 * Math.atan(Math.tan((fov * DEG) / 2) * zoomTan)) / DEG;
    return fov;
  }

  function widenForNarrowScreens(fov) {
    const aspect = camera.aspect;
    if (!(aspect > 0)) return fov;
    const horizontalTan = Math.tan((fov * DEG) / 2) * aspect;
    const minimumTan = Math.tan((MIN_HORIZONTAL_FOV * DEG) / 2);
    if (horizontalTan >= minimumTan) return fov;
    return Math.min(MAX_WIDENED_FOV, (2 * Math.atan(minimumTan / aspect)) / DEG);
  }

  function viewNear(viewId) {
    if (viewId === 'cockpit') return views.cockpit.near;
    if (viewId === 'fpv') return views.fpv.nearFor(currentRig());
    if (viewId === 'wing') return views.wing.near;
    return CONFIG.CAMERA.NEAR;
  }

  /** Applies a lens for a non-chase view (no portrait lens shift). */
  function applyLens(fov, near) {
    if (camera.view && camera.view.enabled) camera.clearViewOffset();
    if (Math.abs(camera.fov - fov) > 0.005 || camera.near !== near) {
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }

  function restoreChaseLens() {
    if (camera.near !== CONFIG.CAMERA.NEAR) {
      camera.near = CONFIG.CAMERA.NEAR;
      camera.updateProjectionMatrix();
    }
    chaseRig.invalidateProjection();
  }

  /** Antenna zoom for craft whose inputProfile maps the antenna to 'zoom'. */
  function updateZoom() {
    const craft = craftModule();
    const zooms = Boolean(craft && craft.inputProfile && craft.inputProfile.antenna === 'zoom');
    const antenna = zooms && Number.isFinite(ctx.controls.antenna) ? clamp(ctx.controls.antenna, 0, 1) : 0;
    zoomTan = 1 / (1 + (ZOOM_MAX - 1) * antenna);
    chaseRig.setZoom(zoomTan);
  }

  // ---- View switching ------------------------------------------------------------------------------------
  function enterView(next) {
    if (next === 'chase') {
      restoreChaseLens();
      chaseRig.setDetached(false);
    } else {
      chaseRig.setDetached(true);
    }
    setInterior(next === 'cockpit');
    if (next === 'flyby') views.flyby.reset();
  }

  /**
   * Switches to the view a slot resolves to. remember: store it as this mode's view in
   * settings.views. force: re-enter even when unchanged (craft change).
   */
  function setView(slot, { remember = true, force = false } = {}) {
    if (!VIEW_IDS.includes(slot)) return false;
    const next = resolveSlot(slot);
    const changed = next !== view;
    if (changed || force) {
      returnFlight.active = false;
      look.yaw = 0;
      look.pitch = 0;
      look.snapYaw = 0;
      view = next;
      if (!photo) enterView(next);
      else enterPendingAfterPhoto = true;
      counters.viewChanges++;
      emitViewChanged();
    }
    if (remember) {
      const mode = currentMode();
      const stored = settings.get('views');
      if (stored && stored[mode] !== slotOf(next)) settings.update('views', { [mode]: slotOf(next) });
    }
    return true;
  }

  function cycleView(direction = 1) {
    const slots = availableSlots();
    const index = slots.indexOf(slotOf(view));
    const next = slots[(index + (direction < 0 ? slots.length - 1 : 1) + slots.length) % slots.length];
    return setView(next);
  }

  function modeView() {
    const stored = settings.get('views');
    const mode = currentMode();
    return stored && VIEW_IDS.includes(stored[mode]) ? stored[mode] : mode === 'sim' ? 'cockpit' : 'chase';
  }

  // ---- Input actions --------------------------------------------------------------------------------------
  function toggleSnap(direction) {
    const target = direction * SNAP_DEGREES;
    look.snapYaw = look.snapYaw === target ? 0 : target;
  }

  function performAction(id) {
    if (photo) return;
    if (id === 'viewCycle') cycleView(1);
    else if (id === 'viewForward') {
      if (slotOf(view) === 'cockpit') look.snapYaw = 0;
      else setView('cockpit');
    } else if (id === 'viewBack') {
      if (view === 'chase') look.snapYaw = 0;
      else setView('chase');
    } else if (id === 'viewLeft') toggleSnap(-1);
    else if (id === 'viewRight') toggleSnap(1);
    else if (id === 'recenterView') look.snapYaw = 0;
  }

  const CAMERA_ACTIONS = new Set(['viewCycle', 'viewForward', 'viewBack', 'viewLeft', 'viewRight', 'recenterView']);
  bus.on('input:action', (action) => {
    if (!action || action.phase !== 'press' || !CAMERA_ACTIONS.has(action.id)) return;
    performAction(action.id);
  });

  bus.onTyped('modeChanged', () => {
    setView(modeView(), { remember: false });
  });
  bus.onTyped('craftChanged', () => {
    syncRoot();
    setView(slotOf(view), { remember: false, force: true });
  });
  bus.onTyped('softCrash', () => instruments.reset());
  bus.on('settings:changed', ({ key, value }) => {
    if (key === 'fov') fovSettings = readFovSettings();
    else if (key === 'views' && value) {
      const wanted = value[currentMode()];
      if (VIEW_IDS.includes(wanted) && wanted !== slotOf(view)) setView(wanted, { remember: false });
    }
  });

  // ---- Free look ------------------------------------------------------------------------------------------
  function lookLimits() {
    if (view === 'chase') return CHASE_LOOK;
    return viewModule(view).lookLimits;
  }

  function updateLook(realDt) {
    const limits = lookLimits();
    const controls = ctx.controls;
    const lookX = Number.isFinite(controls.lookX) ? clamp(controls.lookX, -1, 1) : 0;
    const lookY = Number.isFinite(controls.lookY) ? clamp(controls.lookY, -1, 1) : 0;
    const targetYaw = clamp(look.snapYaw + lookX * limits.yawRange, -limits.maxYaw, limits.maxYaw);
    const targetPitch = lookY >= 0 ? lookY * limits.up : lookY * limits.down;
    const blend = 1 - Math.exp(-LOOK_LAMBDA * Math.min(Math.max(realDt, 0), 0.1));
    look.yaw += (targetYaw - look.yaw) * blend;
    look.pitch += (targetPitch - look.pitch) * blend;
    if (Math.abs(look.yaw) < 1e-4 && targetYaw === 0) look.yaw = 0;
    if (Math.abs(look.pitch) < 1e-4 && targetPitch === 0) look.pitch = 0;
  }

  /** Chase free look: orbits the v1 chase pose around the craft (identity when centred). */
  function applyChaseOrbit() {
    if (look.yaw === 0 && look.pitch === 0) return;
    // Only on top of a pose the rig wrote this frame (it keeps the last good frame on bad data).
    if (!camera.position.equals(chaseRig.getPose().position)) return;
    const root = currentRoot();
    orbit.pivot.copy(root ? root.position : player.position);
    orbit.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    orbit.pitch.setFromAxisAngle(orbit.right, look.pitch * DEG);
    orbit.yaw.setFromAxisAngle(worldUp, -look.yaw * DEG);
    orbit.rotation.copy(orbit.yaw).multiply(orbit.pitch);
    orbit.offset.copy(camera.position).sub(orbit.pivot).applyQuaternion(orbit.rotation);
    camera.position.copy(orbit.pivot).add(orbit.offset);
    camera.quaternion.premultiply(orbit.rotation);
    const floor = Math.max(world.groundHeight(camera.position.x, camera.position.z), CONFIG.WATER_LEVEL) + CHASE_ORBIT_CLEARANCE;
    if (camera.position.y < floor) camera.position.y = floor;
  }

  // ---- Per-view pose ---------------------------------------------------------------------------------------
  /** Fills `pose` for a non-chase view; false when the view cannot be computed this frame. */
  function computeViewPose(viewId, realDt) {
    const root = currentRoot();
    const rig = currentRig();
    if (!root) return false;
    const module = viewModule(viewId);
    let ok;
    if (viewId === 'wing') {
      if (!(rig && rig.wing)) refreshMeshInfo(root);
      ok = module.update(root, rig, look, pose, meshInfo);
    } else if (viewId === 'flyby') {
      ok = module.update(root, rig, look, pose, meshInfo, realDt, player);
    } else {
      ok = module.update(root, rig, look, pose) !== false;
    }
    if (!ok || !isFiniteVector(pose.position) || !isFiniteQuaternion(pose.quaternion)) return false;
    pose.fov = viewFov(viewId);
    pose.near = viewNear(viewId);
    return true;
  }

  function easeInOutCubic(progress) {
    return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  }

  /** The eased return from the photo camera to a non-chase view. */
  function applyReturnFlight(realDt) {
    returnFlight.elapsed += Math.min(Math.max(realDt, 0), 0.05);
    const blend = easeInOutCubic(clamp(returnFlight.elapsed / RETURN_SECONDS, 0, 1));
    camera.position.lerpVectors(returnFlight.fromPosition, pose.position, blend);
    camera.quaternion.slerpQuaternions(returnFlight.fromQuaternion, pose.quaternion, blend);
    applyLens(returnFlight.fromFov + (pose.fov - returnFlight.fromFov) * blend, CONFIG.CAMERA.NEAR);
    if (blend >= 1) {
      returnFlight.active = false;
      setInterior(view === 'cockpit');
    }
  }

  // ---- Photo mode ---------------------------------------------------------------------------------------------
  function setPhotoMode(active) {
    const next = Boolean(active);
    if (next === photo) return;
    photo = next;
    if (photo) {
      enterPendingAfterPhoto = false;
      returnFlight.active = false;
      setInterior(false);
      restoreChaseLens();
      chaseRig.setPhotoMode(true);
      return;
    }
    const viewChangedInPhoto = enterPendingAfterPhoto;
    enterPendingAfterPhoto = false;
    if (view === 'chase') {
      // Re-attaches the rig when chase was chosen during photo mode, so its return flight ends on
      // the live chase camera instead of a detached rig that no longer writes the camera.
      if (viewChangedInPhoto) enterView('chase');
      chaseRig.setPhotoMode(false);
      return;
    }
    if (viewChangedInPhoto && view === 'flyby') views.flyby.reset();
    returnFlight.fromPosition.copy(camera.position);
    returnFlight.fromQuaternion.copy(camera.quaternion);
    returnFlight.fromFov = camera.fov;
    returnFlight.elapsed = 0;
    returnFlight.active = true;
    counters.returnFlights++;
    chaseRig.setPhotoMode(false, { handoff: true });
    chaseRig.setDetached(true);
  }

  // ---- Instruments -----------------------------------------------------------------------------------------------
  function stickDeflection() {
    const flight = flightSystem();
    const model = flight && currentMode() === 'sim' && typeof flight.getModel === 'function' ? flight.getModel() : null;
    const surfaces = model && model.surfaces;
    const controls = ctx.controls;
    const pitch = surfaces && Number.isFinite(surfaces.elevator) ? surfaces.elevator : controls.pitch;
    const roll = surfaces && Number.isFinite(surfaces.aileron) ? surfaces.aileron : controls.roll;
    return [clamp(Number.isFinite(pitch) ? pitch : 0, -1, 1), clamp(Number.isFinite(roll) ? roll : 0, -1, 1)];
  }

  function noteRedraw() {
    redrawTimes.push(performance.now());
    if (redrawTimes.length > REDRAW_HISTORY) redrawTimes.shift();
  }

  function measuredRedrawHz() {
    if (redrawTimes.length < 2) return 0;
    const span = (redrawTimes[redrawTimes.length - 1] - redrawTimes[0]) / 1000;
    return span > 0 ? (redrawTimes.length - 1) / span : 0;
  }

  /** The 30 Hz instrument clock: memories, the cockpit panel (when on screen) and the HUD overlay. */
  function updateInstruments(realDt) {
    const step = Math.min(Math.max(realDt, 0), 0.1);
    instrumentClock += step;
    instrumentElapsed += step;
    let tick = false;
    if (instrumentClock >= INSTRUMENT_INTERVAL) {
      instrumentClock -= INSTRUMENT_INTERVAL;
      // A long frame never queues a burst of catch-up redraws.
      if (instrumentClock > INSTRUMENT_INTERVAL) instrumentClock = 0;
      tick = true;
      instruments.update(instrumentElapsed);
      instrumentElapsed = 0;
      counters.instrumentTicks++;
      noteRedraw();
    }
    const cockpitOnScreen = view === 'cockpit' && !photo && !returnFlight.active;
    const cockpit = views.cockpit.cockpit;
    if (tick && cockpitOnScreen && cockpit && cockpit.panel) {
      const started = performance.now();
      cockpit.panel.redraw(instruments);
      counters.panelDrawMs += (performance.now() - started - counters.panelDrawMs) * 0.1;
      counters.panelRedraws++;
    }
    const hudStarted = performance.now();
    hud.update(realDt, tick && !photo);
    if (tick && hud.visible && !photo) counters.hudDrawMs += (performance.now() - hudStarted - counters.hudDrawMs) * 0.1;
    if (tick && hud.visible && !photo) counters.hudTicks++;
  }

  // ---- Frame update ---------------------------------------------------------------------------------------------
  function update(dt, realDt) {
    chaseRig.update(dt, realDt);
    if (syncRoot()) setView(slotOf(view), { remember: false, force: true });
    updateZoom();
    updateInstruments(realDt);
    reticle.update();
    if (photo) return;
    updateLook(realDt);
    if (view === 'chase') {
      if (chaseRig.getMode() === 'chase') applyChaseOrbit();
      return;
    }
    if (!computeViewPose(view, realDt)) return;
    if (returnFlight.active) {
      applyReturnFlight(realDt);
      return;
    }
    camera.position.copy(pose.position);
    camera.quaternion.copy(pose.quaternion);
    applyLens(pose.fov, pose.near);
    if (view === 'cockpit') {
      // Keeps the cockpit in step with the craft's instrument list (it rebuilds only on a change).
      setInterior(true);
      const [pitch, roll] = stickDeflection();
      views.cockpit.animateStick(pitch, roll);
    }
  }

  // ---- Start -------------------------------------------------------------------------------------------------------
  attachedRoot = currentRoot();
  view = resolveSlot(modeView());
  if (view !== 'chase') enterView(view);
  emitViewChanged();

  // Dev hooks only (dev builds, ?debug=1, ?test): the cockpit of any craft can be previewed with
  // another descriptor, so craft engineers can check a style before writing it into their craft.
  const params = new URLSearchParams(window.location.search);
  const debugHooks = import.meta.env.DEV || params.get('debug') === '1' || params.has('test');

  return {
    update,
    setPhotoMode,

    shake(amount) {
      chaseRig.shake(amount);
    },

    /** Re-seat the cameras immediately (teleports / resets). */
    snap() {
      chaseRig.snap();
      views.flyby.reset();
    },

    /** v1 camera mode: 'chase' | 'photo' | 'returning' (photo-mode state of the rig). */
    getMode() {
      return chaseRig.getMode();
    },

    setFreeCameraPose(options) {
      return chaseRig.setFreeCameraPose(options);
    },

    /** The active view: 'chase' | 'cockpit' | 'wing' | 'flyby' | 'fpv'. */
    getView() {
      return view;
    },

    /** Switches view by slot ('chase' | 'cockpit' | 'wing' | 'flyby'; 'cockpit' is first person). */
    setView(slot) {
      return setView(slot);
    },

    cycleView,

    /** The slots the active craft offers, in cycle order. */
    listViews() {
      return availableSlots();
    },

    getLook() {
      return { yaw: look.yaw, pitch: look.pitch, snapYaw: look.snapYaw };
    },

    getStats() {
      const cockpit = views.cockpit.cockpit;
      return {
        view,
        slot: slotOf(view),
        views: availableSlots(),
        photo,
        returning: returnFlight.active || chaseRig.getMode() === 'returning',
        look: { yaw: Math.round(look.yaw * 100) / 100, pitch: Math.round(look.pitch * 100) / 100, snapYaw: look.snapYaw },
        fov: Math.round(camera.fov * 100) / 100,
        near: camera.near,
        zoom: Math.round((1 / zoomTan) * 100) / 100,
        fpvUptilt: views.fpv.isAvailable(currentRig()) ? views.fpv.uptilt(currentRig()) : null,
        hiddenParts: hiddenParts.length,
        cockpit: cockpit
          ? {
              visible: cockpit.group.visible,
              panel: cockpit.panel ? { width: cockpit.panel.canvas.width, height: cockpit.panel.canvas.height, cells: cockpit.panel.cells.map((cell) => cell.id) } : null,
              stick: Boolean(cockpit.stick),
            }
          : null,
        instruments: {
          ids: [...instruments.ids],
          unknown: [...instruments.unknownIds],
          ticks: counters.instrumentTicks,
          panelRedraws: counters.panelRedraws,
          hudRedraws: counters.hudTicks,
          redrawHz: Math.round(measuredRedrawHz() * 10) / 10,
          panelDrawMs: Math.round(counters.panelDrawMs * 100) / 100,
          hudDrawMs: Math.round(counters.hudDrawMs * 100) / 100,
          units: instruments.source.units.system,
        },
        hud: hud.getStats(),
        reticle: reticle.getStats(),
        flyby: { placements: views.flyby.placements, position: { x: views.flyby.cameraPosition.x, y: views.flyby.cameraPosition.y, z: views.flyby.cameraPosition.z } },
        viewChanges: counters.viewChanges,
        returnFlights: counters.returnFlights,
      };
    },

    debug: debugHooks
      ? {
          /** Rebuilds the cockpit of the active craft from `descriptor` (null restores the craft's own). */
          previewCockpit(descriptor) {
            const rig = currentRig();
            const root = currentRoot();
            if (!rig || !root) return false;
            restoreCockpitParts();
            views.cockpit.dispose();
            const previewRig = descriptor ? { ...rig, cockpit: descriptor } : rig;
            views.cockpit.prepare(root, previewRig, instruments.ids);
            if (view === 'cockpit' && !photo) setInterior(true);
            return true;
          },
        }
      : null,
  };
}
