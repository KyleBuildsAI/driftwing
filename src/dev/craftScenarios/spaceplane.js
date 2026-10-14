// Spaceplane scenarios for ?test=craft (Phase 3 contract k.1, spec Milestone P item 3): the climb to
// 100 km and the re-entry to 3 km, in both views, each with 0 NaN (the craft test's own criterion),
// floating-origin rebases without visible jumps and the far field without holes.
//
//   spaceplane-climb     the 'climb' placement (45 degrees, 250 m/s, full thrust) above the spawn,
//                        pulled up to 65 degrees and left on the hold: past 100 km, the apogee
//                        prediction in 100-125 km, Mach over 2, the RCS carrying the attitude in the
//                        thin air, WREN's apogee command
//   spaceplane-reentry   from 100 km on a 18 degree descent at 1100 m/s, auto re-entry armed by the
//                        assists: 40 degrees angle of attack through the heating (rho V^3), the comms
//                        blackout (WREN silent, the reentry events heating, blackout, clear), the
//                        hypersonic glide and the hand-back, then the pilot dives for home under 3 km;
//                        the attitude hold switch toggles on the way
//   spaceplane-space-and-back  both in one flight (spec Milestone P item 3 as written): the climb
//                        placement, full power past 100 km to the apogee, the engine off, auto
//                        re-entry armed by the assists past the apogee, the blackout and the glide,
//                        then home under 3 km; it ends a few seconds after (endWhen)
//
// Continuity (every frame, rebase frames counted): the craft's position relative to the camera from the
// render-frame matrices (scene.position = -origin.offset) agrees with the same vector in world
// coordinates within 1 mm, so a rebase never moves anything on screen. Far field: on every frame above
// 11 km with the far field active no selected tile is missing (farField.getStats().holes), and two
// readback probes (the step file's method: sky dome and cloud shell hidden, a magenta background, the
// camera pitched down for one render, the terrain and the far field culled for it) find ground on every
// pixel below the rendered horizon, once in the handoff band and once from space.

const CONTINUITY_TOLERANCE = 0.001;
// The width keeps a WebGPU readback row a multiple of 256 bytes.
const PROBE_SIZE = Object.freeze({ width: 256, height: 144 });
const DEG = Math.PI / 180;

/** Flight path angle (deg) from the telemetry velocity. */
function flightPath(flight) {
  return Math.atan2(flight.velocity.y, Math.max(Math.hypot(flight.velocity.x, flight.velocity.z), 0.1)) / DEG;
}

/** Scratch vectors for the continuity check, created once per run in the memo. */
function continuityScratch(api) {
  const memo = api.memo;
  if (!memo.continuity) {
    const THREE = api.ctx.THREE;
    memo.continuity = { craft: new THREE.Vector3(), camera: new THREE.Vector3(), render: new THREE.Vector3(), world: new THREE.Vector3(), worst: 0, frames: 0, rebaseFrames: 0, lastVersion: api.ctx.origin.getStats().version };
  }
  return memo.continuity;
}

/**
 * The craft's camera-relative position from the render-frame matrices against the world one; true when
 * they agree within the tolerance. Counts the frames that follow a rebase.
 */
function continuityHolds(api) {
  const scratch = continuityScratch(api);
  const { ctx } = api;
  const root = api.controller.planeMesh;
  const camera = ctx.camera;
  if (!root) return true;
  root.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);
  scratch.render.setFromMatrixPosition(root.matrixWorld).sub(scratch.camera.setFromMatrixPosition(camera.matrixWorld));
  scratch.world.copy(root.position).sub(camera.position);
  const disagreement = scratch.render.distanceTo(scratch.world);
  scratch.worst = Math.max(scratch.worst, disagreement);
  scratch.frames++;
  const version = ctx.origin.getStats().version;
  if (version !== scratch.lastVersion) {
    scratch.lastVersion = version;
    scratch.rebaseFrames++;
  }
  return disagreement <= CONTINUITY_TOLERANCE;
}

/** Counts far-field frames above 11 km and those with a selected tile missing (once it has settled). */
function watchFarField(api) {
  const memo = api.memo;
  const farField = api.ctx.systems.farField;
  if (!farField) return;
  memo.farFrames = memo.farFrames ?? 0;
  memo.holeFrames = memo.holeFrames ?? 0;
  if (api.flight.altitude < 11000) return;
  const stats = farField.getStats();
  if (!stats.active) return;
  // A start placed high up (a teleport) loads the far field first: count from its first complete frame.
  if (!memo.farSettled && stats.holes > 0) return;
  memo.farSettled = true;
  memo.farFrames++;
  if (stats.holes > 0) memo.holeFrames++;
}

/**
 * One readback probe (async; the result lands in memo[key]): the camera pitched `pitch` degrees down
 * along the craft's heading, the sky dome and the cloud shell hidden, a magenta background; counts the
 * magenta pixels whose view ray points more than a degree below the rendered horizon.
 */
function startProbe(api, key, pitch) {
  const memo = api.memo;
  if (memo[key]) return;
  memo[key] = { pending: true };
  const { ctx, state } = api;
  const THREE = ctx.THREE;
  const camera = ctx.camera;
  const sky = ctx.systems.sky;
  const target = new THREE.RenderTarget(PROBE_SIZE.width, PROBE_SIZE.height, { type: THREE.UnsignedByteType });
  const savedPosition = camera.position.clone();
  const savedQuaternion = camera.quaternion.clone();
  const shell = ctx.scene.getObjectByName('far-field-cloud-shell');
  const shellVisible = shell ? shell.visible : false;
  const background = ctx.scene.background;
  const euler = new THREE.Euler(-pitch * DEG, -state.player.heading * DEG, 0, 'YXZ');
  camera.position.copy(state.player.position);
  camera.quaternion.setFromEuler(euler);
  camera.updateMatrixWorld();
  const view = camera.quaternion.clone();
  // The terrain and the far field cull against the camera in their updates: run them for the probe pose.
  ctx.systems.terrain.update(0, 1 / 60);
  ctx.systems.farField.update(0, 1 / 60);
  if (sky && sky.dome) sky.dome.visible = false;
  if (shell) shell.visible = false;
  ctx.scene.background = new THREE.Color(1, 0, 1);
  ctx.renderer.setRenderTarget(target);
  ctx.renderer.render(ctx.scene, camera);
  ctx.renderer.setRenderTarget(null);
  if (sky && sky.dome) sky.dome.visible = true;
  if (shell) shell.visible = shellVisible;
  ctx.scene.background = background;
  camera.position.copy(savedPosition);
  camera.quaternion.copy(savedQuaternion);
  camera.updateMatrixWorld();
  const horizonY = -Math.sin(state.atmosphere.horizonDip + DEG);
  const altitude = state.player.position.y;
  const projectionInverse = camera.projectionMatrixInverse.clone();
  ctx.renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height).then((pixels) => {
    const bottomUp = ctx.backend === 'WebGL2';
    const ray = new THREE.Vector3();
    let holes = 0;
    let below = 0;
    for (let index = 0; index < target.width * target.height; index++) {
      const column = index % target.width;
      const row = (index - column) / target.width;
      const rowFromTop = bottomUp ? target.height - 1 - row : row;
      ray.set(((column + 0.5) / target.width) * 2 - 1, 1 - ((rowFromTop + 0.5) / target.height) * 2, 0.5).applyMatrix4(projectionInverse).normalize().applyQuaternion(view);
      if (ray.y >= horizonY) continue;
      below++;
      if (pixels[index * 4] > 180 && pixels[index * 4 + 2] > 180 && pixels[index * 4 + 1] < 40) holes++;
    }
    memo[key] = { pending: false, holes, below, altitude: Math.round(altitude) };
    target.dispose();
  }, (error) => {
    memo[key] = { pending: false, error: String(error && error.message ? error.message : error) };
    target.dispose();
  });
}

function probeClean(api, key) {
  const result = api.memo[key];
  return Boolean(result && result.pending === false && !result.error && result.below > 100 && result.holes === 0);
}

const continuityCheck = Object.freeze({ id: 'continuity', label: 'rebases without visible jumps: render-frame and world camera-relative positions agree within 1 mm', always: true, test: continuityHolds });

/**
 * The pilot home after the hand-back: a 30 degree dive with the speed brake, rounding out near 3 km
 * (or 1.5 km above high ground), then a shallow descent clear of the terrain. Returns the pitch input.
 */
function diveHome(api, held) {
  const altitude = api.flight.altitude;
  const agl = api.agl();
  const diving = altitude > 3800 && agl > 1500;
  const target = diving ? -30 : agl < 900 ? 6 : -4;
  if (diving) held.push('airbrake');
  return Math.min(0.6, Math.max(-0.6, (target - flightPath(api.flight)) * 0.045));
}

/**
 * The single flight of spec Milestone P item 3: the climb placement, full power at 65 degrees past
 * 100 km to the top of the arc (as the spaceplane lab's re-entry test flies it: an engine cut at 100 km
 * tops out lower and never heats past the blackout), the engine off from there, auto re-entry (armed by the assists past the apogee) through the
 * heating, the blackout and the glide, then home under 3 km. Tracks the phases in the memo.
 */
function spaceAndBackPilot(t, api) {
  watchFarField(api);
  const memo = api.memo;
  const craftState = api.craftState;
  const altitude = api.flight.altitude;
  memo.peak = Math.max(memo.peak ?? 0, altitude);
  if (memo.spaceAt === undefined && altitude >= 100000) memo.spaceAt = t;
  if (memo.spaceAt !== undefined && memo.apogeeAt === undefined && api.flight.velocity.y < 0) memo.apogeeAt = t;
  if (memo.apogeeAt !== undefined && craftState.autoReentry === true) memo.armed = true;
  if (craftState.blackout === true) memo.sawBlackout = true;
  if (craftState.reentryPhase === 'entry') memo.sawEntry = true;
  if (craftState.reentryPhase === 'glide') memo.sawGlide = true;
  if (memo.sawGlide && craftState.reentryPhase === 'off' && memo.handBackAt === undefined) memo.handBackAt = t;
  if (memo.handBackAt !== undefined && memo.downAt === undefined && (altitude < 3000 || api.agl() < 1200)) memo.downAt = t;
  if (altitude > 99000) startProbe(api, 'probeSpace', 62);
  if (memo.apogeeAt !== undefined && altitude < 12600 && altitude > 12000) startProbe(api, 'probeBand', 55);
  const held = [];
  if (memo.handBackAt !== undefined) return { throttle: 0, roll: 0, yaw: 0, pitch: diveHome(api, held), held };
  if (memo.apogeeAt !== undefined) return { throttle: 0, roll: 0, yaw: 0, pitch: 0 };
  const pitch = api.flight.pitch;
  const pull = altitude < 20000 && pitch < 64.5 ? Math.min(0.6, Math.max(0, (65 - pitch) * 0.05)) : 0;
  return { throttle: 1, roll: 0, yaw: 0, pitch: pull };
}

export default Object.freeze({
  craft: 'spaceplane',
  // The general test: a gentle stick for a craft with this much control power.
  general: Object.freeze({ stick: 0.3 }),
  scenarios: Object.freeze([
    Object.freeze({
      id: 'spaceplane-climb',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'climb', agl: 2000, clearRadius: 3000, speed: 250, pitch: 45, throttle: 1 },
      seconds: 240,
      script(t, api) {
        watchFarField(api);
        const altitude = api.flight.altitude;
        if (altitude > 12000 && altitude < 12600) startProbe(api, 'probeBand', 55);
        if (altitude > 99000) startProbe(api, 'probeSpace', 62);
        if (t > 150 && api.once('apogeeCommand')) api.memo.apogeeReply = api.controller.runCraftCommand('apogee');
        const pitch = api.flight.pitch;
        const pull = altitude < 20000 && pitch < 64.5 ? Math.min(0.6, Math.max(0, (65 - pitch) * 0.05)) : 0;
        return { throttle: 1, roll: 0, yaw: 0, pitch: pull };
      },
      checks: [
        { id: 'mach', label: 'past Mach 2', test: (api) => api.flight.mach > 2 },
        { id: 'apogee', label: 'the apogee prediction in 100-125 km above 60 km', from: 60, test: (api) => api.flight.altitude > 60000 && api.craftState.apogee >= 100000 && api.craftState.apogee <= 125000 },
        { id: 'space', label: 'climbs to 100 km', test: (api) => api.flight.altitude >= 100000 },
        { id: 'rcs', label: 'the RCS carries the attitude above 80 km (blend > 0.95)', test: (api) => api.flight.altitude > 80000 && api.craftState.rcsBlend > 0.95 },
        { id: 'rebases', label: 'the render origin rebased on the way up (10 or more)', test: (api) => api.events.count('originRebased') >= 10 },
        continuityCheck,
        { id: 'continuityRebases', label: 'the continuity check saw 10 or more rebase frames', from: 200, test: (api) => (api.memo.continuity?.rebaseFrames ?? 0) >= 10 },
        { id: 'farField', label: 'the far field is active with its tiles selected above 15 km', test: (api) => api.flight.altitude > 15000 && api.ctx.systems.farField.getStats().active && api.ctx.systems.farField.getStats().selected > 0 },
        { id: 'farFieldHoles', label: 'no far-field tile missing on any frame above 11 km', from: 220, test: (api) => api.memo.farFrames > 200 && api.memo.holeFrames === 0 },
        { id: 'probeBand', label: 'ground on every pixel below the horizon in the handoff band (readback)', test: (api) => probeClean(api, 'probeBand') },
        { id: 'probeSpace', label: 'ground on every pixel below the horizon from 100 km (readback)', test: (api) => probeClean(api, 'probeSpace') },
        { id: 'copilot', label: "WREN's apogee command answers", from: 150, test: (api) => Boolean(api.memo.apogeeReply && api.memo.apogeeReply.ok && /apogee|coming down/i.test(api.memo.apogeeReply.text)) },
      ],
    }),
    Object.freeze({
      id: 'spaceplane-reentry',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 100000, speed: 1100, pitch: -18, throttle: 0 },
      seconds: 420,
      script(t, api) {
        watchFarField(api);
        const memo = api.memo;
        const craftState = api.craftState;
        const altitude = api.flight.altitude;
        const actions = [];
        if (t > 2 && api.once('holdOn')) actions.push('craftAbilityAlt');
        if (t > 3 && api.once('holdSeen')) memo.holdOn = craftState.attitudeHold === true;
        if (t > 4 && api.once('holdOff')) actions.push('craftAbilityAlt');
        if (t > 5 && api.once('holdOffSeen')) memo.holdOff = craftState.attitudeHold === false;
        if (altitude < 60000 && altitude > 55000) startProbe(api, 'probeHigh', 60);
        if (altitude < 12600 && altitude > 12000) startProbe(api, 'probeBand', 55);
        if (craftState.blackout === true) {
          memo.sawBlackout = true;
          if (api.once('blackoutSpeech')) memo.blackoutSpeech = api.ctx.systems.copilot.speak('Spaceplane, WREN, radio check.');
        }
        if (craftState.reentryPhase === 'glide') memo.sawGlide = true;
        if (memo.sawGlide && craftState.reentryPhase === 'off' && memo.handBackAt === undefined) memo.handBackAt = t;
        if (craftState.reentryPhase === 'entry' && altitude < 70000 && craftState.dynamicPressure > 200) {
          memo.entryFrames = (memo.entryFrames ?? 0) + 1;
          if (Math.abs(api.flight.aoa - 40) > 4) memo.entryOff = (memo.entryOff ?? 0) + 1;
        }
        memo.maxLoad = Math.max(memo.maxLoad ?? 0, api.flight.gLoad);
        const held = [];
        // The pilot takes her home after the hand-back.
        const pitch = memo.handBackAt !== undefined ? diveHome(api, held) : 0;
        return { throttle: 0, roll: 0, yaw: 0, pitch, actions, held };
      },
      checks: [
        { id: 'armed', label: 'the assists arm auto re-entry on the way down', until: 5, test: (api) => api.craftState.autoReentry === true },
        { id: 'attitudeHold', label: 'the attitude hold switch toggles (Shift+Space)', from: 5, until: 8, test: (api) => api.memo.holdOn === true && api.memo.holdOff === true },
        { id: 'entryAttitude', label: '40 degrees angle of attack (+-4) through the entry below 70 km', from: 200, test: (api) => api.memo.entryFrames > 300 && (api.memo.entryOff ?? 0) <= api.memo.entryFrames * 0.05 },
        { id: 'heating', label: 'the heating builds past the blackout level (rho V^3)', test: (api) => api.craftState.heating > 0.55 },
        { id: 'blackout', label: 'the comms blackout: reentry heating, blackout and clear', test: (api) => api.memo.sawBlackout === true && api.events.count('reentry') >= 3 && api.events.last('reentry')?.phase === 'clear' && api.craftState.commsBlackout === false },
        { id: 'silent', label: 'WREN stays silent in the blackout', from: 40, test: (api) => api.memo.sawBlackout === true && api.memo.blackoutSpeech === '' },
        { id: 'glide', label: 'the hypersonic glide, then the hand-back', test: (api) => api.memo.sawGlide === true && api.memo.handBackAt !== undefined },
        { id: 'down', label: 're-enters to 3 km (or under 1.2 km above high ground)', test: (api) => api.flight.altitude < 3000 || api.agl() < 1200 },
        { id: 'load', label: 'the load stays inside 6.5 g', from: 400, test: (api) => api.memo.maxLoad <= 6.5 },
        { id: 'rebases', label: 'the render origin rebased on the way down (10 or more)', test: (api) => api.events.count('originRebased') >= 10 },
        continuityCheck,
        { id: 'continuityRebases', label: 'the continuity check saw 10 or more rebase frames', from: 300, test: (api) => (api.memo.continuity?.rebaseFrames ?? 0) >= 10 },
        { id: 'farFieldHoles', label: 'no far-field tile missing on any frame above 11 km', from: 400, test: (api) => api.memo.farFrames > 200 && api.memo.holeFrames === 0 },
        { id: 'probeHigh', label: 'ground on every pixel below the horizon at 60 km (readback)', test: (api) => probeClean(api, 'probeHigh') },
        { id: 'probeBand', label: 'ground on every pixel below the horizon in the handoff band (readback)', test: (api) => probeClean(api, 'probeBand') },
      ],
    }),
    Object.freeze({
      id: 'spaceplane-space-and-back',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'climb', agl: 2000, clearRadius: 3000, speed: 250, pitch: 45, throttle: 1 },
      seconds: 900,
      script: spaceAndBackPilot,
      // Done a few seconds after it is home under 3 km (the hypersonic glide sets the length).
      endWhen: (api) => api.memo.downAt !== undefined && api.t > api.memo.downAt + 5,
      checks: [
        { id: 'space', label: 'climbs past 100 km', test: (api) => api.memo.spaceAt !== undefined },
        { id: 'apogee', label: 'the arc tops out at 100-130 km', test: (api) => api.memo.apogeeAt !== undefined && api.memo.peak >= 100000 && api.memo.peak <= 130000 },
        { id: 'armed', label: 'the assists arm auto re-entry past the apogee', test: (api) => api.memo.armed === true },
        { id: 'entry', label: 'the entry attitude, the comms blackout and the hypersonic glide', test: (api) => api.memo.sawEntry === true && api.memo.sawBlackout === true && api.memo.sawGlide === true },
        { id: 'blackoutClear', label: 'the reentry events heating, blackout and clear', test: (api) => api.events.count('reentry') >= 3 && api.events.last('reentry')?.phase === 'clear' },
        { id: 'down', label: 're-enters to 3 km (or under 1.2 km above high ground) in the same flight', test: (api) => api.memo.downAt !== undefined },
        { id: 'rebases', label: 'the render origin rebased up and down (20 or more)', test: (api) => api.events.count('originRebased') >= 20 },
        continuityCheck,
        { id: 'continuityRebases', label: 'the continuity check saw 20 or more rebase frames', test: (api) => (api.memo.continuity?.rebaseFrames ?? 0) >= 20 },
        { id: 'farFieldHoles', label: 'no far-field tile missing on any frame above 11 km, up and down', test: (api) => api.memo.downAt !== undefined && api.memo.farFrames > 400 && api.memo.holeFrames === 0 },
        { id: 'probeSpace', label: 'ground on every pixel below the horizon from 100 km (readback)', test: (api) => probeClean(api, 'probeSpace') },
        { id: 'probeBand', label: 'ground on every pixel below the horizon in the handoff band on the way down (readback)', test: (api) => probeClean(api, 'probeBand') },
      ],
    }),
  ]),
});
