// WeatherVolumeEngine (registry name 'weatherVolume', contract section 3): cloud masses of instanced
// soft puffs in the v1 cloud look, rain shafts, fog banks and the weather felt from inside them.
// Presets: the supercell (anvil, rain shaft, wall cloud), lenticular clouds, the microburst's rain
// shaft, the storm chase, the waterfall's mist cloud and fog banks; Phase 3 adds sandstorm walls,
// snow squalls, hurricane rain bands, valley fog rivers and noctilucent clouds on the same params.
// docs/engines/weatherVolume.md documents every param (units, ranges, defaults) for preset authors.
//
// Shared GPU resources, all built once in init() (dispose(instance) therefore returns GPU memory
// exactly: a volume owns no geometry, texture or material of its own):
//   - ONE instanced puff mesh for every volume, with the v1 puff geometry and light response
//     (src/render/cloudShading.js): each frame the live volumes append their visible puffs to it;
//   - one instanced mesh of rain shafts;
//   - a field of rain, snow or dust streaks around the camera, animated in the vertex stage;
//   - rain drops on the canopy in the cockpit and FPV views;
//   - the soft whiteout veil while the camera is inside a volume.
//
// Far away: every puff and shaft beyond the fog's far distance is pulled toward the camera along its
// own sight line (distance compression), keeping its direction and angular size, so a 20 km anvil
// fits inside the camera's far plane and still reads at its true size on the horizon. The mapping is
// monotonic, so the puffs keep their order in depth. Aerial perspective is computed from the true
// distance per puff (haze.near / haze.far, closing in with the sky's fog density). At the FAR tier
// the lure (src/spawns/lure.js) of a heavy preset takes over and the volume fades out (farMode
// 'auto'); other volumes keep their core puffs as a coarse mass.
//
// Inside a volume the engine closes the world in through one sky modifier ('weatherVolume', priority
// 15: above the regional weather, below an eclipse) weighted by how deep the camera is, shows the
// veil, and inside a rain or snow shaft drives the local streaks and, in first-person views, the
// canopy rain. With no volume alive the modifier is removed and every mesh hidden, so the sky runs
// its untouched path.
//
// Wind: a volume registers one WindField source (id `weather-<n>:weather`) sampling its parts:
// turbulence inside the mass, an updraft under a tower's base, downdrafts and a ground outflow in the
// rain shafts, and a lens form's wave lift, sink and rotor. The source is removed when the volume
// steps to the FAR tier (the player is then beyond lod.mid, well outside its reach; presets keep
// lod.mid larger than the volume's radius plus its outflow) and added back when it returns, and it is
// removed on dispose. A drifting volume re-indexes its bounds only after moving WIND_REINDEX_METRES.
//
// Audio: the volume plays preset.audio when it owns the preset's voice (its entry is the first in
// preset.engines, or its params set ownsAudio: true), at the anchor, with the growth as intensity.
//
// No allocation per frame: puffs, groups and shafts live in typed arrays laid out at create, the
// instance buffers are written in place with persistent update ranges, and the wind sample and the
// scratch values are reused.
import { buildCloudPuffGeometry, createCloudLook } from '../../render/cloudShading.js';
import { GROUP_STRIDE, PUFF_STRIDE, SHAFT_STRIDE, layoutWeatherVolume, resolveWeatherParams } from './weatherVolume/forms.js';
import { createCanopyRain, createLocalRain, createPuffMesh, createShaftMesh, createVeil } from './weatherVolume/materials.js';
import { createApproachJournal, createWindSample, ownsPresetAudio } from './engineKit.js';

const PUFF_CAPACITY = 3072;
const SHAFT_CAPACITY = 32;
const LOCAL_RAIN_STREAKS = 2400;
const LOCAL_RAIN_BOX = Object.freeze([70, 46, 70]);
/** Mesh anchors snap to this grid around the camera (float32-safe instance offsets). */
const ANCHOR_STEP = 2048;
/** Seconds a level (core, body, detail) takes to fade in or out when the tier changes. */
const LEVEL_FADE_SECONDS = 1.5;
/** Distance compression: starts at this share of the fog's far distance, ends at this share of the camera's far plane. */
const COMPRESS_START_SHARE = 0.92;
const COMPRESS_END_SHARE = 0.93;
const MIN_COMPRESS_START = 800;
const MODIFIER_ID = 'weatherVolume';
const MODIFIER_PRIORITY = 15;
/** Seconds (damping rate) for the camera's inside, rain and canopy levels to follow. */
const INSIDE_RATE = 2.5;
const RAIN_RATE = 1.6;
const VEIL_MAX_OPACITY = 0.6;
const WIND_REINDEX_METRES = 300;
const WIND_OUTFLOW_REACH = 3;
const WIND_OUTFLOW_HEIGHT = 350;
const GROUND_REFRESH_SECONDS = 2;
const FIRST_PERSON_DISTANCE = 3.5;
const FIRST_PERSON_VIEWS = Object.freeze(['cockpit', 'fpv']);
/** Canopy drops: airspeed (m/s) at which they stop running down and start streaking back. */
const CANOPY_HOLD_SPEED = 22;
const CANOPY_STREAK_SPEED = 55;
const GLOW_SCALE = 0.6;

function smooth(value, edge0, edge1) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent approach of value to target at rate (1/s) over dt. */
function approach(value, target, rate, dt) {
  return target + (value - target) * Math.exp(-rate * dt);
}

export function createWeatherVolumeEngine() {
  let ctx = null;
  let THREE = null;
  let look = null;
  let puffs = null;
  let shafts = null;
  let localRain = null;
  let canopy = null;
  let veil = null;
  let modifier = null;
  let puffGeometry = null;
  const live = [];
  let serial = 0;
  let frameStamp = -1;
  let puffCursor = 0;
  let shaftCursor = 0;
  let lastFrameDt = 1 / 60;
  let knownView = null;
  let buffersOwned = 0;
  // Persistent update ranges (three clears the list after each upload; the objects are reused).
  const ranges = { matrix: { start: 0, count: 0 }, shape: { start: 0, count: 0 }, centre: { start: 0, count: 0 }, tint: { start: 0, count: 0 }, glow: { start: 0, count: 0 }, shaftMatrix: { start: 0, count: 0 }, shaftData: { start: 0, count: 0 }, shaftColour: { start: 0, count: 0 } };
  // Frame state shared by the volumes' updates.
  const frame = {
    cameraX: 0, cameraY: 0, cameraZ: 0, anchorX: 0, anchorZ: 0,
    compressStart: 2000, compressEnd: 5000, fogScale: 1,
    sunElevation: 0, nightFactor: 0,
  };
  // What the camera met last frame (the strongest volume), applied at the start of the next.
  const met = { inside: 0, rain: 0, canopy: 0, rainKind: 0, rainFall: 9, fogDensity: 1, fogDarkness: 0, fogColor: null, tint: null };
  const shown = { inside: 0, rain: 0, canopy: 0, rainKind: 0, rainFall: 9, fogDensity: 1, fogDarkness: 0, fogColor: null };
  const modifierValues = { weight: 0, fogDensity: 1, fogColor: null, fogColorAmount: 0, darkness: 0, sunIntensity: 1, ambient: 1 };
  const canopyFlow = { x: 0, y: 1 };
  const scratchColor = { value: null };

  // ---- Frame bookkeeping ------------------------------------------------------------------------
  function isFirstPerson() {
    if (knownView !== null) return FIRST_PERSON_VIEWS.includes(knownView);
    const player = ctx.state.player.position;
    const camera = ctx.camera.position;
    const dx = camera.x - player.x;
    const dy = camera.y - player.y;
    const dz = camera.z - player.z;
    return dx * dx + dy * dy + dz * dz < FIRST_PERSON_DISTANCE * FIRST_PERSON_DISTANCE;
  }

  /** Once per frame, before the first volume writes: shared look, anchors, compression, and last frame's weather at the camera. */
  function beginFrame(stamp) {
    frameStamp = stamp;
    const frameDt = ctx.state.time.frameDt;
    lastFrameDt = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, 0.1) : lastFrameDt;
    const levels = typeof ctx.sky?.getModifierLevels === 'function' ? ctx.sky.getModifierLevels() : null;
    look.update(ctx.state, ctx.uniforms, levels);
    const camera = ctx.camera;
    frame.cameraX = camera.position.x;
    frame.cameraY = camera.position.y;
    frame.cameraZ = camera.position.z;
    frame.anchorX = Math.round(frame.cameraX / ANCHOR_STEP) * ANCHOR_STEP;
    frame.anchorZ = Math.round(frame.cameraZ / ANCHOR_STEP) * ANCHOR_STEP;
    puffs.mesh.position.set(frame.anchorX, 0, frame.anchorZ);
    puffs.anchor.value.set(frame.anchorX, 0, frame.anchorZ);
    shafts.mesh.position.set(frame.anchorX, 0, frame.anchorZ);
    const fogFar = ctx.scene.fog ? ctx.scene.fog.far : camera.far * 0.5;
    frame.compressStart = Math.max(MIN_COMPRESS_START, fogFar * COMPRESS_START_SHARE);
    frame.compressEnd = Math.max(frame.compressStart + 200, camera.far * COMPRESS_END_SHARE);
    frame.fogScale = levels && levels.active ? Math.max(0.25, levels.fogDensity) : 1;
    frame.sunElevation = ctx.state.time.sunElevation;
    frame.nightFactor = ctx.state.time.nightFactor;
    applyCameraWeather(lastFrameDt);
    met.inside = 0;
    met.rain = 0;
    met.canopy = 0;
    puffCursor = 0;
    shaftCursor = 0;
  }

  /** Eases the inside, rain and canopy levels toward what the camera met, and drives the modifier and overlays. */
  function applyCameraWeather(dt) {
    shown.inside = approach(shown.inside, met.inside, INSIDE_RATE, dt);
    shown.rain = approach(shown.rain, met.rain, RAIN_RATE, dt);
    shown.canopy = approach(shown.canopy, met.canopy * (isFirstPerson() ? 1 : 0), RAIN_RATE, dt);
    if (met.inside > 0.001 || met.rain > 0.001) {
      shown.fogDensity = met.fogDensity;
      shown.fogDarkness = met.fogDarkness;
      shown.fogColor.copy(met.fogColor);
      shown.rainKind = met.rainKind;
      shown.rainFall = met.rainFall;
    }
    if (shown.inside < 1e-4 && met.inside === 0) shown.inside = 0;
    if (shown.rain < 1e-4 && met.rain === 0) shown.rain = 0;
    if (shown.canopy < 1e-4 && met.canopy === 0) shown.canopy = 0;
    const weight = Math.max(shown.inside, shown.rain * 0.7);
    if (modifier) {
      modifierValues.weight = weight;
      modifierValues.fogDensity = shown.fogDensity;
      modifierValues.fogColorAmount = 0.75;
      modifierValues.darkness = shown.fogDarkness;
      modifierValues.sunIntensity = 1 - 0.45 * shown.inside;
      modifier.set(modifierValues);
    }
    // The veil: the cloud's own colour, like the v1 field's.
    const veilOpacity = shown.inside * VEIL_MAX_OPACITY;
    veil.mesh.visible = veilOpacity > 0.004;
    veil.uniforms.opacity.value = veilOpacity;
    if (veil.mesh.visible) {
      veil.uniforms.colour.value.copy(look.shadeColor.value).multiplyScalar(1.35);
      scratchColor.value.copy(look.litColor.value).multiplyScalar(0.35);
      veil.uniforms.colour.value.add(scratchColor.value).multiply(met.tint);
    }
    updateLocalRain(dt);
    updateCanopy(dt);
  }

  function updateLocalRain(dt) {
    const uniforms = localRain.uniforms;
    localRain.mesh.visible = shown.rain > 0.01;
    uniforms.intensity.value = shown.rain;
    if (!localRain.mesh.visible) return;
    const kind = shown.rainKind;
    uniforms.kind.value = kind;
    const wind = ctx.uniforms.windDirection.value;
    const drift = kind === 2 ? 9 : 2.5;
    const offset = uniforms.offset.value;
    offset.x = (offset.x + wind.x * drift * dt) % LOCAL_RAIN_BOX[0];
    offset.y = (offset.y - shown.rainFall * dt) % LOCAL_RAIN_BOX[1];
    offset.z = (offset.z + wind.y * drift * dt) % LOCAL_RAIN_BOX[2];
    const velocity = ctx.state.player.velocity;
    uniforms.relative.value.set(wind.x * drift - velocity.x, -shown.rainFall - velocity.y, wind.y * drift - velocity.z);
    // Lit like the rain curtains: the shadow palette plus a little sun.
    uniforms.light.value.copy(look.shadeColor.value).multiplyScalar(1.6);
    scratchColor.value.copy(look.litColor.value).multiplyScalar(0.18);
    uniforms.light.value.add(scratchColor.value);
  }

  function updateCanopy(dt) {
    const uniforms = canopy.uniforms;
    canopy.mesh.visible = shown.canopy > 0.01;
    uniforms.amount.value = shown.canopy;
    if (!canopy.mesh.visible) return;
    const speed = ctx.state.player.speed;
    const airspeed = Number.isFinite(speed) ? speed : 0;
    // Slow: drops run down the canopy (screen y is down); fast: they are blown back up and stretch.
    const blown = smooth(airspeed, CANOPY_HOLD_SPEED, CANOPY_STREAK_SPEED);
    const rundown = 1 - smooth(airspeed, 0, CANOPY_HOLD_SPEED);
    canopyFlow.y = blown > rundown ? -1 : 1;
    uniforms.flow.value.set(0, canopyFlow.y);
    const rate = blown > rundown ? 0.08 + 0.9 * blown : 0.05 * rundown;
    const shift = uniforms.shift.value;
    shift.y = (shift.y + canopyFlow.y * rate * dt) % 64;
    uniforms.stretch.value = 1 + 3.5 * blown;
    uniforms.light.value.copy(ctx.uniforms.fogColor.value).multiplyScalar(0.9);
    scratchColor.value.copy(look.litColor.value).multiplyScalar(0.25);
    uniforms.light.value.add(scratchColor.value);
  }

  /** Marks the written instance ranges of an attribute for upload (persistent range, no allocation). */
  function flagRange(attribute, range, count, itemSize) {
    range.start = 0;
    range.count = count * itemSize;
    if (attribute.updateRanges.length === 0) attribute.updateRanges.push(range);
    attribute.needsUpdate = true;
  }

  function flushPuffs() {
    puffs.mesh.count = puffCursor;
    puffs.mesh.visible = puffCursor > 0;
    if (puffCursor === 0) return;
    flagRange(puffs.mesh.instanceMatrix, ranges.matrix, puffCursor, 16);
    flagRange(puffs.shape, ranges.shape, puffCursor, 4);
    flagRange(puffs.centre, ranges.centre, puffCursor, 4);
    flagRange(puffs.tint, ranges.tint, puffCursor, 4);
    flagRange(puffs.glow, ranges.glow, puffCursor, 4);
  }

  function flushShafts() {
    shafts.mesh.count = shaftCursor;
    shafts.mesh.visible = shaftCursor > 0;
    if (shaftCursor === 0) return;
    flagRange(shafts.mesh.instanceMatrix, ranges.shaftMatrix, shaftCursor, 16);
    flagRange(shafts.data, ranges.shaftData, shaftCursor, 4);
    flagRange(shafts.colour, ranges.shaftColour, shaftCursor, 4);
  }

  // ---- Wind -------------------------------------------------------------------------------------
  /** The instance's WindField source: sample() reads its live state and writes one reused record. */
  function createWindSource(instance) {
    const data = instance.data;
    const params = data.params;
    const layout = data.layout;
    const wind = params.wind;
    const result = createWindSample();
    const anchor = instance.anchor;
    const updraftRadius = params.radius * 0.6;
    return {
      id: `${data.id}:weather`,
      kind: 'weather-volume',
      bounds: data.windBounds,
      sample(position) {
        result.vel.x = 0;
        result.vel.y = 0;
        result.vel.z = 0;
        result.turbulence = 0;
        const offsetX = position.x - anchor.x;
        const offsetZ = position.z - anchor.z;
        const localX = offsetX * data.rightX + offsetZ * data.rightZ;
        const localZ = offsetX * data.forwardX + offsetZ * data.forwardZ;
        const y = position.y - data.baseAltitude;
        const presence = data.growth;
        const reach = layout.reach;
        const radiusSquared = localX * localX + localZ * localZ;
        // Turbulence inside the mass.
        if (wind.turbulence > 0 && y > layout.bottom && y < layout.top && radiusSquared < reach * reach) {
          result.turbulence = wind.turbulence * presence * Math.sqrt(1 - radiusSquared / (reach * reach));
        }
        // The updraft feeding a tower, under its base.
        const baseHeight = data.baseAltitude - data.groundY;
        if (wind.updraft > 0 && y < 0 && y > -baseHeight && radiusSquared < updraftRadius * updraftRadius) {
          const core = 1 - radiusSquared / (updraftRadius * updraftRadius);
          result.vel.y += wind.updraft * presence * core * smooth(-y, 0, baseHeight * 0.2) * smooth(y + baseHeight, 0, baseHeight * 0.25);
        }
        // Rain shafts: the downdraft inside, the outflow spreading along the ground.
        const shafts = layout.shafts;
        for (let index = 0; index < layout.shaftCount; index++) {
          const offset = index * SHAFT_STRIDE;
          const shaftRadius = shafts[offset + 2];
          const ground = data.shaftGround[index];
          const top = data.baseAltitude + shafts[offset + 3];
          const height = Math.max(1, top - ground);
          const along = Math.min(1, Math.max(0, (position.y - ground) / height));
          const footX = shafts[offset];
          const footZ = shafts[offset + 1] + shafts[offset + 7] * (1 - along);
          const dx = localX - footX;
          const dz = localZ - footZ;
          const distance = Math.sqrt(dx * dx + dz * dz);
          const downdraft = shafts[offset + 8] > 0 ? shafts[offset + 8] : wind.downdraft;
          const outflow = shafts[offset + 9] > 0 ? shafts[offset + 9] : wind.outflow;
          if (distance < shaftRadius && position.y < top) {
            const core = 1 - (distance * distance) / (shaftRadius * shaftRadius);
            result.vel.y -= downdraft * presence * core * smooth(along, 0, 0.25);
            result.turbulence = Math.max(result.turbulence, shafts[offset + 4] * 0.4 * presence);
          }
          const aboveGround = position.y - ground;
          if (outflow > 0 && distance > 1 && distance < shaftRadius * WIND_OUTFLOW_REACH && aboveGround < WIND_OUTFLOW_HEIGHT) {
            const ring = distance / shaftRadius;
            const strength = outflow * presence * Math.sin(Math.min(1, ring / WIND_OUTFLOW_REACH) * Math.PI) * (1 - Math.max(0, aboveGround) / WIND_OUTFLOW_HEIGHT);
            const directionX = dx / distance;
            const directionZ = dz / distance;
            result.vel.x += (directionX * data.rightX + directionZ * data.forwardX) * strength;
            result.vel.z += (directionX * data.rightZ + directionZ * data.forwardZ) * strength;
            result.turbulence = Math.max(result.turbulence, 0.35 * strength / Math.max(1, outflow));
          }
        }
        // A lens cloud's standing wave: lift upwind of it, sink downwind, rotor turbulence beneath.
        const wave = wind.wave;
        if (wave) {
          const span = params.radius * 1.5;
          const across = Math.abs(localX) / params.radius;
          if (Math.abs(localZ) < span && across < 1.2 && y > -baseHeight && y < layout.top + 600) {
            const phase = Math.sin((Math.abs(localZ) / span) * Math.PI);
            const strength = (localZ < 0 ? wave.lift : -wave.sink) * phase * Math.max(0, 1 - across * across) * presence;
            result.vel.y += strength * smooth(y + baseHeight, 0, baseHeight * 0.5);
            if (y < 0) result.turbulence = Math.max(result.turbulence, wave.rotor * presence * (localZ > 0 ? 1 : 0.3) * Math.max(0, 1 - across));
          }
        }
        return result;
      },
    };
  }

  /** Recomputes the (reused) wind bounds around the volume's current anchor. */
  function writeWindBounds(instance) {
    const data = instance.data;
    const layout = data.layout;
    let reach = layout.reach;
    for (let index = 0; index < layout.shaftCount; index++) {
      const offset = index * SHAFT_STRIDE;
      const shaftReach = Math.sqrt(layout.shafts[offset] ** 2 + layout.shafts[offset + 1] ** 2) + layout.shafts[offset + 2] * WIND_OUTFLOW_REACH + Math.abs(layout.shafts[offset + 7]);
      reach = Math.max(reach, shaftReach);
    }
    if (data.params.wind.wave) reach = Math.max(reach, data.params.radius * 1.8);
    reach += WIND_REINDEX_METRES;
    const bounds = data.windBounds;
    bounds.min.x = instance.anchor.x - reach;
    bounds.min.z = instance.anchor.z - reach;
    bounds.max.x = instance.anchor.x + reach;
    bounds.max.z = instance.anchor.z + reach;
    bounds.min.y = Math.min(data.groundY, data.baseAltitude + layout.bottom) - 100;
    bounds.max.y = data.baseAltitude + layout.top + 700;
    data.windIndexedX = instance.anchor.x;
    data.windIndexedZ = instance.anchor.z;
  }

  function hasWind(params) {
    const wind = params.wind;
    return wind.turbulence > 0 || wind.updraft > 0 || wind.downdraft > 0 || wind.outflow > 0 || wind.wave !== null || params.rain.some((shaft) => shaft.downdraft > 0 || shaft.outflow > 0);
  }

  function addWind(instance) {
    const data = instance.data;
    if (data.windActive || !data.windSource) return;
    writeWindBounds(instance);
    ctx.wind.addSource(data.windSource);
    data.windActive = true;
  }

  function removeWind(instance) {
    const data = instance.data;
    if (!data.windActive) return;
    ctx.wind.removeSource(data.windSource.id);
    data.windActive = false;
  }

  // ---- Per-frame volume update ------------------------------------------------------------------
  function advanceLifecycle(instance, dt) {
    const data = instance.data;
    const params = data.params;
    const age = ctx.time.elapsed - data.startTime;
    data.age = age;
    if (data.duration !== null && age > data.duration - params.dissipateSeconds) data.ending = true;
    if (data.ending) {
      data.growth = params.dissipateSeconds > 0 ? Math.max(0, data.growth - dt / params.dissipateSeconds) : 0;
      if (data.growth <= 0 && data.duration !== null) instance.ended = true;
    } else {
      data.growth = params.formSeconds > 0 ? Math.min(1, data.growth + dt / params.formSeconds) : 1;
    }
    if (data.driftSpeed > 0 && dt > 0) {
      instance.anchor.x += data.driftX * dt;
      instance.anchor.z += data.driftZ * dt;
    }
    const weights = data.levelWeights;
    const targets = data.levelTargets;
    const step = dt / LEVEL_FADE_SECONDS;
    for (let level = 0; level < 3; level++) {
      const target = targets[level];
      weights[level] = weights[level] < target ? Math.min(target, weights[level] + step) : Math.max(target, weights[level] - step);
    }
  }

  function refreshGlow(data) {
    const glow = data.params.glow;
    if (!glow) return;
    let factor = 1;
    if (glow.when === 'night') factor = frame.nightFactor;
    else if (glow.when === 'twilight') factor = smooth(-frame.sunElevation, 1.5, 5) * (1 - smooth(-frame.sunElevation, 13, 18));
    const scale = glow.strength * factor * GLOW_SCALE;
    data.glowNow.r = data.glowColor.r * scale;
    data.glowNow.g = data.glowColor.g * scale;
    data.glowNow.b = data.glowColor.b * scale;
  }

  /** Writes the volume's visible puffs after the cursor and measures how deep the camera is inside. */
  function writePuffs(instance) {
    const data = instance.data;
    const params = data.params;
    const layout = data.layout;
    const source = layout.puffs;
    const groups = layout.groups;
    const weights = data.levelWeights;
    const anchor = instance.anchor;
    const matrices = puffs.mesh.instanceMatrix.array;
    const shapes = puffs.shape.array;
    const centres = puffs.centre.array;
    const tints = puffs.tint.array;
    const glows = puffs.glow.array;
    const cameraX = frame.cameraX;
    const cameraY = frame.cameraY;
    const cameraZ = frame.cameraZ;
    const start = frame.compressStart;
    const span = frame.compressEnd - frame.compressStart;
    const hazeNear = params.haze.near / frame.fogScale;
    const hazeFar = Math.max(hazeNear + 1, params.haze.far / frame.fogScale);
    const hazeMax = params.haze.max;
    const age = data.age;
    const billow = params.billow;
    const growth = data.growth;
    // The wall cloud hangs control.wallCloud of its full drop below the base (a set piece lowers it).
    const wallGroup = layout.wallGroup;
    const wallControl = instance.control.wallCloud;
    const wallLower = wallControl > 0 ? (wallControl < 1 ? wallControl : 1) : 0;
    // Coarse far mass: the core puffs swell a little while the body is hidden.
    const coreSwell = 1 + 0.25 * (1 - weights[1]);
    const checkInside = data.cameraNear;
    let nearest = Infinity;
    let written = 0;
    for (let puff = 0; puff < layout.puffCount; puff++) {
      if (puffCursor >= PUFF_CAPACITY) break;
      const offset = puff * PUFF_STRIDE;
      const level = source[offset + 9];
      const levelWeight = weights[level];
      if (levelWeight < 0.02) continue;
      const threshold = source[offset + 7];
      const appear = smooth(growth, threshold, threshold + 0.3);
      if (appear < 0.04) continue;
      const group = source[offset + 8] * GROUP_STRIDE;
      const follow = groups[group + 8] === 1;
      const spin = groups[group + 7];
      const rise = groups[group + 9];
      const drop = source[offset + 8] === wallGroup ? wallLower : 1;
      let x = source[offset];
      let y = source[offset + 1] * drop;
      let z = source[offset + 2];
      let radius = source[offset + 3];
      const phase = source[offset + 10];
      let size = appear * (level === 0 ? coreSwell : 1);
      if (spin !== 0) {
        const angle = spin * age;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const relativeX = x - groups[group + 2];
        const relativeZ = z - groups[group + 4];
        x = groups[group + 2] + relativeX * cosine - relativeZ * sine;
        z = groups[group + 4] + relativeX * sine + relativeZ * cosine;
      }
      if (rise > 0) {
        // The mist cycle: each puff climbs the column, swelling and spreading, and fades at the top.
        const height = groups[group + 1] - groups[group];
        const cycle = y / height + (age * rise) / height;
        const fraction = cycle - Math.floor(cycle);
        y = groups[group] + fraction * height;
        const spread = 1 + 0.7 * fraction;
        x *= spread;
        z *= spread;
        size *= (0.55 + 0.75 * fraction) * smooth(fraction, 0, 0.12) * (1 - smooth(fraction, 0.72, 1));
        if (size < 0.04) continue;
      }
      if (billow > 0) {
        radius *= 1 + billow * 0.06 * Math.sin(age * 0.4 + phase);
        y += billow * radius * 0.03 * Math.sin(age * 0.3 + phase * 1.3);
      }
      const ground = follow ? source[offset + 11] + data.followLift : data.baseAltitude;
      const worldX = anchor.x + x * data.rightX + z * data.forwardX;
      const worldZ = anchor.z + x * data.rightZ + z * data.forwardZ;
      const worldY = ground + y;
      const halfHeight = radius * source[offset + 4] * size;
      const scaledRadius = radius * size;
      if (checkInside) {
        const dx = (cameraX - worldX) / scaledRadius;
        const dy = (cameraY - worldY) / halfHeight;
        const dz = (cameraZ - worldZ) / scaledRadius;
        const measure = dx * dx + dy * dy + dz * dz;
        if (measure < nearest) nearest = measure;
      }
      // Distance compression toward the camera beyond the fog (see the header).
      const toX = worldX - cameraX;
      const toY = worldY - cameraY;
      const toZ = worldZ - cameraZ;
      const distance = Math.sqrt(toX * toX + toY * toY + toZ * toZ);
      let k = 1;
      if (distance > start) k = (start + span * (1 - Math.exp(-(distance - start) / span))) / distance;
      const baseY = ground + groups[group] * drop;
      const topY = ground + groups[group + 1] * drop;
      const centreX = anchor.x + groups[group + 2] * data.rightX + groups[group + 4] * data.forwardX;
      const centreZ = anchor.z + groups[group + 2] * data.rightZ + groups[group + 4] * data.forwardZ;
      const centreY = ground + groups[group + 3] * drop;
      const out = puffCursor * 16;
      const horizontal = scaledRadius * k;
      const cosine = data.puffCos[puff];
      const sine = data.puffSin[puff];
      matrices[out] = cosine * horizontal;
      matrices[out + 1] = 0;
      matrices[out + 2] = -sine * horizontal;
      matrices[out + 3] = 0;
      matrices[out + 4] = 0;
      matrices[out + 5] = halfHeight * k;
      matrices[out + 6] = 0;
      matrices[out + 7] = 0;
      matrices[out + 8] = sine * horizontal;
      matrices[out + 9] = 0;
      matrices[out + 10] = cosine * horizontal;
      matrices[out + 11] = 0;
      matrices[out + 12] = cameraX + toX * k - frame.anchorX;
      matrices[out + 13] = cameraY + toY * k;
      matrices[out + 14] = cameraZ + toZ * k - frame.anchorZ;
      matrices[out + 15] = 1;
      const attribute = puffCursor * 4;
      shapes[attribute] = groups[group + 6] === 1 ? (baseY - worldY) / halfHeight : -2;
      shapes[attribute + 1] = cameraY + (baseY - cameraY) * k;
      shapes[attribute + 2] = cameraY + (topY - cameraY) * k;
      shapes[attribute + 3] = source[offset + 6];
      centres[attribute] = cameraX + (centreX - cameraX) * k - frame.anchorX;
      centres[attribute + 1] = cameraY + (centreY - cameraY) * k;
      centres[attribute + 2] = cameraZ + (centreZ - cameraZ) * k - frame.anchorZ;
      const haze = hazeMax * smooth(distance, hazeNear, hazeFar);
      const fade = Math.max(1 - smooth(appear, 0, 0.35), 1 - levelWeight);
      centres[attribute + 3] = haze > fade ? haze : fade;
      tints[attribute] = data.tint.r;
      tints[attribute + 1] = data.tint.g;
      tints[attribute + 2] = data.tint.b;
      tints[attribute + 3] = groups[group + 5];
      glows[attribute] = data.glowNow.r;
      glows[attribute + 1] = data.glowNow.g;
      glows[attribute + 2] = data.glowNow.b;
      glows[attribute + 3] = 0;
      puffCursor++;
      written++;
    }
    data.puffsDrawn = written;
    data.inside = nearest === Infinity ? 0 : 1 - smooth(Math.sqrt(nearest), 0.72, 1.12);
  }

  /** Writes the volume's rain shafts and measures the rain at the camera. */
  function writeShafts(instance, dt) {
    const data = instance.data;
    const layout = data.layout;
    if (layout.shaftCount === 0) return;
    const visibility = data.levelWeights[1] * smooth(data.growth, 0.25, 0.7);
    data.groundTimer -= dt;
    if (data.driftSpeed > 0 && data.groundTimer <= 0) {
      data.groundTimer = GROUND_REFRESH_SECONDS;
      sampleShaftGround(instance);
    }
    const anchor = instance.anchor;
    const source = layout.shafts;
    const matrices = shafts.mesh.instanceMatrix.array;
    const shaftData = shafts.data.array;
    const colours = shafts.colour.array;
    const params = data.params;
    const start = frame.compressStart;
    const span = frame.compressEnd - frame.compressStart;
    const hazeNear = params.haze.near / frame.fogScale;
    const hazeFar = Math.max(hazeNear + 1, params.haze.far / frame.fogScale);
    for (let index = 0; index < layout.shaftCount; index++) {
      const offset = index * SHAFT_STRIDE;
      const ground = data.shaftGround[index];
      const top = data.baseAltitude + source[offset + 3];
      if (top <= ground + 5) continue;
      const radius = source[offset + 2];
      const lean = source[offset + 7];
      const footX = anchor.x + source[offset] * data.rightX + (source[offset + 1] + lean) * data.forwardX;
      const footZ = anchor.z + source[offset] * data.rightZ + (source[offset + 1] + lean) * data.forwardZ;
      const height = top - ground;
      const density = source[offset + 4];
      // The rain at the camera (inside the column, below the cloud base).
      if (data.cameraNear && frame.cameraY < top) {
        const along = Math.min(1, Math.max(0, (frame.cameraY - ground) / height));
        const axisX = footX - lean * along * data.forwardX;
        const axisZ = footZ - lean * along * data.forwardZ;
        const dx = frame.cameraX - axisX;
        const dz = frame.cameraZ - axisZ;
        const inside = (1 - smooth(Math.sqrt(dx * dx + dz * dz) / radius, 0.7, 1)) * density * visibility * (1 - smooth(frame.cameraY, top - 60, top));
        if (inside > data.rain) {
          data.rain = inside;
          data.rainKind = source[offset + 6];
          data.rainFall = source[offset + 5];
        }
      }
      if (visibility < 0.02 || shaftCursor >= SHAFT_CAPACITY) continue;
      const midX = footX - lean * 0.5 * data.forwardX - frame.cameraX;
      const midY = ground + height * 0.5 - frame.cameraY;
      const midZ = footZ - lean * 0.5 * data.forwardZ - frame.cameraZ;
      const distance = Math.sqrt(midX * midX + midY * midY + midZ * midZ);
      let k = 1;
      if (distance > start) k = (start + span * (1 - Math.exp(-(distance - start) / span))) / distance;
      const out = shaftCursor * 16;
      const scaledRadius = radius * k;
      matrices[out] = scaledRadius;
      matrices[out + 1] = 0;
      matrices[out + 2] = 0;
      matrices[out + 3] = 0;
      matrices[out + 4] = -lean * data.forwardX * k;
      matrices[out + 5] = height * k;
      matrices[out + 6] = -lean * data.forwardZ * k;
      matrices[out + 7] = 0;
      matrices[out + 8] = 0;
      matrices[out + 9] = 0;
      matrices[out + 10] = scaledRadius;
      matrices[out + 11] = 0;
      matrices[out + 12] = frame.cameraX + (footX - frame.cameraX) * k - frame.anchorX;
      matrices[out + 13] = frame.cameraY + (ground - frame.cameraY) * k;
      matrices[out + 14] = frame.cameraZ + (footZ - frame.cameraZ) * k - frame.anchorZ;
      matrices[out + 15] = 1;
      const attribute = shaftCursor * 4;
      shaftData[attribute] = density * visibility;
      shaftData[attribute + 1] = source[offset + 5];
      shaftData[attribute + 2] = source[offset + 6];
      shaftData[attribute + 3] = params.haze.max * smooth(distance / k, hazeNear, hazeFar);
      colours[attribute] = data.tint.r;
      colours[attribute + 1] = data.tint.g;
      colours[attribute + 2] = data.tint.b;
      colours[attribute + 3] = data.shaftSeed + index * 3.7;
      shaftCursor++;
      data.shaftsDrawn++;
    }
  }

  function sampleShaftGround(instance) {
    const data = instance.data;
    const layout = data.layout;
    const anchor = instance.anchor;
    for (let index = 0; index < layout.shaftCount; index++) {
      const offset = index * SHAFT_STRIDE;
      const x = anchor.x + layout.shafts[offset] * data.rightX + (layout.shafts[offset + 1] + layout.shafts[offset + 7]) * data.forwardX;
      const z = anchor.z + layout.shafts[offset] * data.rightZ + (layout.shafts[offset + 1] + layout.shafts[offset + 7]) * data.forwardZ;
      data.shaftGround[index] = Math.max(ctx.terrain.heightAt(x, z), ctx.terrain.waterLevel);
    }
  }

  /** Records what this volume does to the camera, when it beats the strongest so far this frame. */
  /**
   * Approach journal (params.journal): the player's closest horizontal distance to the volume's
   * anchor (a storm's core) while the volume stands grown.
   */
  function observeApproach(instance, engineCtx) {
    const player = engineCtx.state.player.position;
    const dx = player.x - instance.anchor.x;
    const dz = player.z - instance.anchor.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const closest = instance.data.journal.closest;
    if (distance < closest[0]) closest[0] = distance;
  }

  function reportCamera(instance) {
    const data = instance.data;
    const params = data.params;
    const inside = data.inside * data.growth;
    const canopyRain = Math.max(data.rainKind === 2 ? 0 : data.rain, inside * params.canopyRain);
    if (inside > met.inside || data.rain > met.rain) {
      met.fogDensity = params.insideFog.density;
      met.fogDarkness = params.insideFog.darkness;
      met.fogColor.copy(data.fogColor);
      met.tint.copy(data.tint);
    }
    if (inside > met.inside) met.inside = inside;
    if (data.rain > met.rain) {
      met.rain = data.rain;
      met.rainKind = data.rainKind;
      met.rainFall = data.rainFall;
    }
    if (canopyRain > met.canopy) met.canopy = canopyRain;
  }

  function levelTargetsFor(instance, tier) {
    const targets = instance.data.levelTargets;
    if (tier === 'near') {
      targets[0] = 1;
      targets[1] = 1;
      targets[2] = 1;
      return;
    }
    if (tier === 'mid') {
      targets[0] = 1;
      targets[1] = 1;
      targets[2] = 0;
      return;
    }
    const farMode = instance.data.params.farMode;
    const hide = farMode === 'hide' || (farMode === 'auto' && instance.heavy);
    targets[0] = hide ? 0 : 1;
    targets[1] = 0;
    targets[2] = 0;
  }

  // ---- Engine interface -------------------------------------------------------------------------
  return {
    name: 'weatherVolume',
    budget: { instances: 6, particles: 30000 },

    init(engineCtx) {
      ctx = engineCtx;
      THREE = ctx.THREE;
      const TSL = ctx.TSL;
      look = createCloudLook(THREE, TSL);
      const skyColorNode = typeof ctx.sky?.skyColorNode === 'function' ? ctx.sky.skyColorNode : null;
      // The shared puff shape, jittered by a fixed hash so it never depends on the world seed.
      puffGeometry = buildCloudPuffGeometry(THREE, (x, z, salt) => {
        const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
        return value - Math.floor(value);
      });
      puffs = createPuffMesh(THREE, TSL, { geometry: puffGeometry, look, uniforms: ctx.uniforms, skyColorNode, capacity: PUFF_CAPACITY });
      shafts = createShaftMesh(THREE, TSL, { look, uniforms: ctx.uniforms, skyColorNode, capacity: SHAFT_CAPACITY });
      localRain = createLocalRain(THREE, TSL, { count: LOCAL_RAIN_STREAKS, box: LOCAL_RAIN_BOX });
      canopy = createCanopyRain(THREE, TSL);
      veil = createVeil(THREE, TSL);
      ctx.scene.add(puffs.mesh);
      ctx.scene.add(shafts.mesh);
      ctx.scene.add(localRain.mesh);
      ctx.camera.add(canopy.mesh);
      ctx.camera.add(veil.mesh);
      // Drawn once behind the loading fade: the first storm, shower or fog bank costs no pipeline
      // build, and the lazily counted overlay geometries are in the memory baseline from the start.
      for (const mesh of [puffs.mesh, shafts.mesh, localRain.mesh, canopy.mesh, veil.mesh]) ctx.registerPrewarm?.(mesh);
      // Instance buffers (5 puff, 3 shaft), the streak field's 4 and the two overlay quads' 4 each.
      buffersOwned = 5 + 3 + 4 + 8;
      met.fogColor = new THREE.Color();
      met.tint = new THREE.Color(1, 1, 1);
      shown.fogColor = new THREE.Color();
      modifierValues.fogColor = shown.fogColor;
      scratchColor.value = new THREE.Color();
      ctx.bus.onTyped('viewChanged', ({ view }) => {
        knownView = view;
      });
    },

    create(preset, params, rng) {
      const resolved = resolveWeatherParams(params, { event: params.duration !== null && params.duration !== undefined });
      const heading = Number.isFinite(params.heading) ? params.heading : 0;
      const headingRadians = (heading * Math.PI) / 180;
      const forwardX = Math.sin(headingRadians);
      const forwardZ = -Math.cos(headingRadians);
      const rightX = -forwardZ;
      const rightZ = forwardX;
      const anchor = params.position;
      const terrain = ctx.terrain;
      const groundAt = (x, z) => Math.max(terrain.heightAt(x, z), terrain.waterLevel);
      const groundY = groundAt(anchor.x, anchor.z);
      let baseAltitude = resolved.base;
      if (resolved.baseMode === 'agl') baseAltitude += groundY;
      else if (resolved.baseMode === 'anchor') baseAltitude += anchor.y;
      const layout = layoutWeatherVolume(resolved, rng, groundAt, { x: anchor.x, z: anchor.z, rightX, rightZ, forwardX, forwardZ });
      const puffCos = new Float32Array(layout.puffCount);
      const puffSin = new Float32Array(layout.puffCount);
      for (let puff = 0; puff < layout.puffCount; puff++) {
        const yaw = layout.puffs[puff * PUFF_STRIDE + 5];
        puffCos[puff] = Math.cos(yaw);
        puffSin[puff] = Math.sin(yaw);
      }
      const driftHeading = resolved.drift && resolved.drift.heading !== null ? (resolved.drift.heading * Math.PI) / 180 : headingRadians;
      const driftSpeed = resolved.drift ? resolved.drift.speed : 0;
      const glowColor = resolved.glow ? new THREE.Color(resolved.glow.color) : null;
      const id = `weather-${serial++}`;
      const data = {
        id,
        params: resolved,
        layout,
        puffCos,
        puffSin,
        rightX, rightZ, forwardX, forwardZ,
        groundY,
        baseAltitude,
        // Ground-following groups sit this far above each puff's own ground.
        followLift: resolved.baseMode === 'agl' ? resolved.base : 0,
        startTime: Number.isFinite(params.startTime) ? params.startTime : ctx.time.elapsed,
        duration: Number.isFinite(params.duration) ? params.duration : null,
        age: 0,
        growth: resolved.formSeconds > 0 ? 0 : 1,
        ending: false,
        driftSpeed,
        driftX: Math.sin(driftHeading) * driftSpeed,
        driftZ: -Math.cos(driftHeading) * driftSpeed,
        levelWeights: new Float32Array(3),
        levelTargets: new Float32Array(3),
        shaftGround: new Float32Array(Math.max(1, layout.shaftCount)),
        shaftSeed: rng() * 97,
        groundTimer: GROUND_REFRESH_SECONDS,
        tint: new THREE.Color(resolved.tint),
        fogColor: new THREE.Color(resolved.insideFog.color),
        glowColor,
        glowNow: { r: 0, g: 0, b: 0 },
        windSource: null,
        windActive: false,
        windBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        windIndexedX: anchor.x,
        windIndexedZ: anchor.z,
        voice: null,
        cameraNear: false,
        inside: 0,
        rain: 0,
        rainKind: 0,
        rainFall: 9,
        puffsDrawn: 0,
        shaftsDrawn: 0,
        writtenFrame: -1,
        presetId: preset.id,
        journal: createApproachJournal(`weatherVolume preset "${preset.id}"`, params.journal),
      };
      const instance = {
        anchor,
        radius: Math.max(layout.reach, resolved.radius),
        windSourceIds: [],
        lights: 0,
        particles: 0,
        heavy: preset.heavy === true,
        tier: 'near',
        // Live values a set piece's ramps write (docs/engines/weatherVolume.md): the wall cloud's
        // lowering, 0 (tucked under the base) to 1 (its full drop, the default).
        control: { wallCloud: 1 },
        data,
      };
      sampleShaftGround(instance);
      if (hasWind(resolved)) {
        data.windSource = createWindSource(instance);
        instance.windSourceIds.push(data.windSource.id);
      }
      if (ownsPresetAudio(preset, 'weatherVolume', params.ownsAudio) && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
        data.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: data.growth });
        data.voice.setPosition(anchor);
      }
      if (!modifier && ctx.sky && typeof ctx.sky.addModifier === 'function') {
        modifier = ctx.sky.addModifier(MODIFIER_ID, { priority: MODIFIER_PRIORITY });
        modifier.set({ weight: 0 });
      }
      live.push(instance);
      return instance;
    },

    update(instance, dt, engineCtx) {
      const stamp = engineCtx.state.frame;
      if (stamp !== frameStamp) beginFrame(stamp);
      const data = instance.data;
      if (data.writtenFrame === stamp) return;
      data.writtenFrame = stamp;
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      advanceLifecycle(instance, step);
      refreshGlow(data);
      // The camera can only be inside (or under the rain of) a volume within its reach.
      const dx = frame.cameraX - instance.anchor.x;
      const dz = frame.cameraZ - instance.anchor.z;
      const reach = instance.radius + 200;
      data.cameraNear = instance.tier !== 'far' && dx * dx + dz * dz < reach * reach;
      data.rain = 0;
      data.shaftsDrawn = 0;
      writePuffs(instance);
      writeShafts(instance, step);
      flushPuffs();
      flushShafts();
      reportCamera(instance);
      instance.particles = data.puffsDrawn + data.shaftsDrawn;
      if (data.windActive) {
        const movedX = instance.anchor.x - data.windIndexedX;
        const movedZ = instance.anchor.z - data.windIndexedZ;
        if (movedX * movedX + movedZ * movedZ > WIND_REINDEX_METRES * WIND_REINDEX_METRES) {
          writeWindBounds(instance);
          ctx.wind.setSourceBounds(data.windSource.id, data.windBounds);
        }
      }
      if (data.voice) {
        data.voice.setPosition(instance.anchor);
        data.voice.setIntensity(data.growth);
      }
      if (data.journal && data.growth > 0.5) observeApproach(instance, engineCtx);
    },

    setLOD(instance, tier) {
      instance.tier = tier;
      levelTargetsFor(instance, tier);
      const data = instance.data;
      // First placement: start at the tier's look (a volume appearing at mid shows no detail puffs).
      if (data.writtenFrame === -1) data.levelWeights.set(data.levelTargets);
      if (tier === 'far') removeWind(instance);
      else addWind(instance);
    },

    dispose(instance) {
      const data = instance.data;
      if (data.journal) data.journal.finish(ctx.bus, data.presetId);
      removeWind(instance);
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      const index = live.indexOf(instance);
      if (index >= 0) live.splice(index, 1);
      if (live.length === 0) {
        // Nothing left: hide every shared mesh and hand the sky back its untouched path.
        puffCursor = 0;
        shaftCursor = 0;
        flushPuffs();
        flushShafts();
        met.inside = 0;
        met.rain = 0;
        met.canopy = 0;
        shown.inside = 0;
        shown.rain = 0;
        shown.canopy = 0;
        veil.mesh.visible = false;
        localRain.mesh.visible = false;
        canopy.mesh.visible = false;
        if (modifier) {
          modifier.remove();
          modifier = null;
        }
      }
    },

    stats() {
      let particles = 0;
      for (let index = 0; index < live.length; index++) particles += live[index].particles;
      const drawCalls = (puffs && puffs.mesh.visible ? 1 : 0) + (shafts && shafts.mesh.visible ? 1 : 0)
        + (localRain && localRain.mesh.visible ? 1 : 0) + (canopy && canopy.mesh.visible ? 1 : 0) + (veil && veil.mesh.visible ? 1 : 0);
      return { instances: live.length, particles, lights: 0, buffers: buffersOwned, drawCalls };
    },

    /** Dev and tests: the camera's weather as the engine last applied it. */
    getCameraWeather() {
      return { inside: shown.inside, rain: shown.rain, canopy: shown.canopy, rainKind: shown.rainKind, firstPerson: ctx ? isFirstPerson() : false, modifier: modifier !== null };
    },
  };
}
