// CelestialEngine (registry name 'celestial', contract section 3): sky-dome additions that drive the
// v1 sky, fog and light. Presets: the meteor shower, the total solar eclipse (legendary), the comet,
// the glory with its full-circle rainbow and the waterfall's daytime rainbow; Phase 3 adds the blood
// moon, the green flash, the Milky Way core, the moonbow and aurora combinations on the same
// components (src/spawns/engines/celestial/params.js; docs/engines/celestial.md for preset authors).
//
// Components (any combination per preset):
//   meteors  streaks from a radiant (fixed among the stars, turning with them), a seeded Poisson
//            stream at `rate` per minute, fireballs that flash the sky and the land; the 'meteor'
//            voice sizzles with the bright ones
//   comet    nucleus, coma, a curved dust tail pointing away from the sun and a straight ion tail,
//            fixed among the stars
//   eclipse  the moon's disc crossing the sun over crossingSeconds, slowing through totality; the
//            corona, the chromosphere and Baily's beads; a sky modifier (priority 30, above the
//            weather) dims the sun and the ambient light, darkens and tints the sky and the fog and
//            brings the stars out, so the world really darkens; the typed wildlifeQuiet event hushes
//            the birds and the fauna through totality
//   glory    drives the shared cloud optics uniforms (cloudGlory, cloudBow): the glory's coloured
//            rings and the full-circle rainbow shine on every cloud around the antisolar point, which
//            is where the craft's own shadow falls on the cloud tops below it
//   rainbow  a rainbow (or a moonbow) inside a sphere of mist, lit by the sun or the moon behind the
//            viewer (the waterfall's mist)
//   sky      a static sky modifier eased in and out with the instance
//
// Positions come from the sky's own sun and moon directions (state.time, src/core/sun.js) and the
// star field's rotation about the celestial pole (src/render/sky.js), so the eclipse sits exactly on
// the sun disc the dome draws and a comet or radiant stays among the stars.
//
// Anchor: 'sky' (the default without a rainbow) keeps the spawn's anchor anchorDistance metres from
// the camera toward the component's direction (the sun, the comet, the radiant, the antisolar point),
// so the spawn is always near, discovered when the player looks at it; 'world' keeps it where it was
// activated (a rainbow in a waterfall's mist; a heavy comet preset whose lure shows from far away:
// its sky objects then fade out at the FAR tier while the lure takes over).
//
// Shared GPU resources are built once in init(); an instance owns only slots in them, so dispose()
// returns GPU memory exactly. No allocation per frame: typed arrays, reused scratch vectors and
// persistent update ranges.
import { CELESTIAL_POLE_ELEVATION_DEG, SUN_ANGULAR_RADIUS } from '../../render/sky.js';
import { resolveCelestialParams } from './celestial/params.js';
import { ownsPresetAudio } from './engineKit.js';
import { CORONA_EXTENT, createCometMesh, createEclipseMeshes, createMeteorMesh, createRainbowMesh } from './celestial/materials.js';

const METEOR_CAPACITY = 48;
const METEOR_STRIDE = 16;
const COMET_CAPACITY = 3;
const ECLIPSE_CAPACITY = 2;
const RAINBOW_CAPACITY = 3;
/** Sky objects sit on this share of the camera's far plane (outside the dome, inside the far plane). */
const SKY_SHELL_SHARE = 0.96;
const MODIFIER_PRIORITY = 30;
const DEG = Math.PI / 180;
/** Separation (sun radii) at which the moon first touches the sun, times this, is where the crossing starts. */
const CROSSING_REACH = 2.3;
const METEOR_WIDTH = 0.0022;
const FIREBALL_WIDTH = 0.006;
const FLASH_DECAY = 3.2;
const QUIET_ON = 0.6;
const QUIET_OFF = 0.35;
const TWO_PI = Math.PI * 2;

function smooth(value, edge0, edge1) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Share (0..1) of a unit disc left uncovered by a disc of radius moonRadius at centre distance d. */
function uncoveredShare(distance, moonRadius) {
  const sunRadius = 1;
  if (distance >= sunRadius + moonRadius) return 1;
  if (distance <= Math.abs(moonRadius - sunRadius)) return moonRadius >= sunRadius ? 0 : 1 - (moonRadius * moonRadius);
  const r1 = sunRadius * sunRadius;
  const r2 = moonRadius * moonRadius;
  const angleSun = Math.acos(Math.min(1, Math.max(-1, (distance * distance + r1 - r2) / (2 * distance * sunRadius))));
  const angleMoon = Math.acos(Math.min(1, Math.max(-1, (distance * distance + r2 - r1) / (2 * distance * moonRadius))));
  const overlap = r1 * angleSun + r2 * angleMoon - 0.5 * Math.sqrt(Math.max(0, (-distance + sunRadius + moonRadius) * (distance + sunRadius - moonRadius) * (distance - sunRadius + moonRadius) * (distance + sunRadius + moonRadius)));
  return 1 - overlap / Math.PI;
}

export function createCelestialEngine() {
  let ctx = null;
  let THREE = null;
  let meteors = null;
  let comets = null;
  let eclipses = null;
  let rainbows = null;
  const live = [];
  let serial = 0;
  let frameStamp = -1;
  let cometCursor = 0;
  let eclipseCursor = 0;
  let rainbowCursor = 0;
  let activeMeteors = 0;
  let gloryFrame = 0;
  let bowFrame = 0;
  let buffersOwned = 0;
  const meteorPool = new Float32Array(METEOR_CAPACITY * METEOR_STRIDE);
  // Persistent update range per attribute (three clears the list after each upload; the objects are reused).
  const ranges = new Map();
  // The attribute lists each mesh flushes, built in init().
  const lists = { meteors: null, comets: null, disc: null, corona: null, rainbows: null, none: [] };
  const frame = { cameraX: 0, cameraY: 0, cameraZ: 0, shell: 4000, rotation: 0, overcast: 0, sunElevation: 0, dt: 0 };
  let scratch = null;

  // ---- Directions -------------------------------------------------------------------------------
  /** Compass azimuth and elevation (degrees) to a unit vector (+x east, -z north). */
  function directionFrom(azimuth, elevation, target) {
    const cosine = Math.cos(elevation * DEG);
    return target.set(Math.sin(azimuth * DEG) * cosine, Math.sin(elevation * DEG), -Math.cos(azimuth * DEG) * cosine);
  }

  /** The star field's rotation for the current time (the sky turns the stars by -dayTime * 2 pi about the pole). */
  function starRotation(target) {
    return target.setFromAxisAngle(scratch.pole, -ctx.state.time.dayTime * TWO_PI);
  }

  /** A direction given for now, stored as the star-fixed direction it has at dayTime 0. */
  function toStarFrame(direction, target) {
    starRotation(scratch.quaternion).invert();
    return target.copy(direction).applyQuaternion(scratch.quaternion);
  }

  /** Two unit vectors perpendicular to axis (and each other) into u and v. */
  function basisAround(axis, u, v) {
    u.set(0, 1, 0);
    if (Math.abs(axis.y) > 0.95) u.set(1, 0, 0);
    u.crossVectors(axis, u).normalize();
    v.crossVectors(axis, u).normalize();
  }

  // ---- Frame bookkeeping ------------------------------------------------------------------------
  function beginFrame(stamp, dt) {
    frameStamp = stamp;
    frame.dt = dt;
    const camera = ctx.camera;
    frame.cameraX = camera.position.x;
    frame.cameraY = camera.position.y;
    frame.cameraZ = camera.position.z;
    frame.shell = camera.far * SKY_SHELL_SHARE;
    frame.sunElevation = ctx.state.time.sunElevation;
    const levels = typeof ctx.sky?.getModifierLevels === 'function' ? ctx.sky.getModifierLevels() : null;
    frame.overcast = levels && levels.active ? levels.overcast : 0;
    ctx.uniforms.cloudGlory.value = gloryFrame;
    ctx.uniforms.cloudBow.value = bowFrame;
    gloryFrame = 0;
    bowFrame = 0;
    cometCursor = 0;
    eclipseCursor = 0;
    rainbowCursor = 0;
    meteors.mesh.position.copy(camera.position);
    comets.mesh.position.copy(camera.position);
    eclipses.disc.position.copy(camera.position);
    eclipses.corona.position.copy(camera.position);
    rainbows.mesh.position.set(Math.round(frame.cameraX / 2048) * 2048, 0, Math.round(frame.cameraZ / 2048) * 2048);
    rainbows.anchor.value.copy(rainbows.mesh.position);
    advanceMeteors(dt);
  }

  function flag(attribute, count, itemSize) {
    let range = ranges.get(attribute);
    if (!range) {
      range = { start: 0, count: 0 };
      ranges.set(attribute, range);
    }
    range.count = count * itemSize;
    if (attribute.updateRanges.length === 0) attribute.updateRanges.push(range);
    attribute.needsUpdate = true;
  }

  function flushMesh(mesh, count, attributes) {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return;
    flag(mesh.instanceMatrix, count, 16);
    for (let index = 0; index < attributes.length; index++) flag(attributes[index], count, 4);
  }

  /** Writes a camera-facing sky quad: x axis along `along` (length rad), y across (width rad), at direction dir. */
  function writeSkyQuad(array, slot, direction, along, alongAngle, acrossAngle, centreShift) {
    const shell = frame.shell;
    const across = scratch.across.crossVectors(direction, along).normalize();
    const out = slot * 16;
    const length = alongAngle * shell;
    const width = acrossAngle * shell;
    array[out] = along.x * length;
    array[out + 1] = along.y * length;
    array[out + 2] = along.z * length;
    array[out + 3] = 0;
    array[out + 4] = across.x * width;
    array[out + 5] = across.y * width;
    array[out + 6] = across.z * width;
    array[out + 7] = 0;
    array[out + 8] = direction.x;
    array[out + 9] = direction.y;
    array[out + 10] = direction.z;
    array[out + 11] = 0;
    array[out + 12] = (direction.x + along.x * centreShift) * shell;
    array[out + 13] = (direction.y + along.y * centreShift) * shell;
    array[out + 14] = (direction.z + along.z * centreShift) * shell;
    array[out + 15] = 1;
  }

  // ---- Meteors ------------------------------------------------------------------------------------
  /** Night visibility of faint sky objects (0 by day, 1 in a dark sky), dimmed by overcast. */
  function darkSky(daylight) {
    const dark = daylight ? 1 : smooth(-frame.sunElevation, 3, 12);
    return dark * (1 - 0.92 * frame.overcast);
  }

  function spawnMeteor(instance) {
    const data = instance.data;
    const params = data.params.meteors;
    let slot = -1;
    for (let index = 0; index < METEOR_CAPACITY; index++) {
      if (meteorPool[index * METEOR_STRIDE] === 0) {
        slot = index;
        break;
      }
    }
    if (slot < 0 || data.meteorsActive >= params.maxActive) return;
    const rng = data.rng;
    // The radiant now (the star-fixed direction turned with the sky), and a start point around it.
    const radiant = scratch.radiant.copy(data.radiant).applyQuaternion(starRotation(scratch.quaternion));
    basisAround(radiant, scratch.u, scratch.v);
    const around = rng() * TWO_PI;
    const offset = (8 + rng() * (params.spread - 8)) * DEG;
    const perpendicular = scratch.w.copy(scratch.u).multiplyScalar(Math.cos(around)).addScaledVector(scratch.v, Math.sin(around));
    // Start points below the horizon are skipped (the meteor would burn out unseen).
    const startY = radiant.y * Math.cos(offset) + perpendicular.y * Math.sin(offset);
    if (startY < 0.12) return;
    const fireball = rng() < params.fireballChance;
    const length = (params.length[0] + rng() * (params.length[1] - params.length[0])) * DEG * (fireball ? 1.6 : 1);
    const speed = params.speed * DEG * (0.75 + 0.5 * rng());
    const life = fireball ? 1.6 + rng() * 1.4 : 0.45 + rng() * 0.8;
    const record = slot * METEOR_STRIDE;
    meteorPool[record] = 1;
    meteorPool[record + 1] = 0;
    meteorPool[record + 2] = life;
    meteorPool[record + 3] = perpendicular.x;
    meteorPool[record + 4] = perpendicular.y;
    meteorPool[record + 5] = perpendicular.z;
    meteorPool[record + 6] = radiant.x;
    meteorPool[record + 7] = radiant.y;
    meteorPool[record + 8] = radiant.z;
    meteorPool[record + 9] = offset;
    meteorPool[record + 10] = speed;
    meteorPool[record + 11] = length;
    meteorPool[record + 12] = params.brightness * (fireball ? 2.2 : 0.35 + 0.75 * rng() * rng());
    meteorPool[record + 13] = fireball ? 1 : 0;
    meteorPool[record + 14] = data.owner;
    meteorPool[record + 15] = rng();
    data.meteorsActive++;
    data.meteorsSpawned++;
    if (data.voice) {
      const bright = meteorPool[record + 12] * data.visibility;
      if (fireball) {
        data.triggerOptions.strength = Math.min(1.5, bright * 0.6);
        data.triggerOptions.duration = life;
        data.voice.trigger('fireball', data.triggerOptions);
      } else if (bright > 0.6) {
        data.triggerOptions.strength = Math.min(1, bright);
        data.triggerOptions.duration = life;
        data.voice.trigger('streak', data.triggerOptions);
      }
    }
    if (fireball) data.flash = Math.max(data.flash, params.fireballFlash * data.visibility);
  }

  function ownerOf(owner) {
    for (let index = 0; index < live.length; index++) if (live[index].data.owner === owner) return live[index];
    return null;
  }

  /** Ages every meteor, frees the burnt-out ones and writes the rest (all owners) into the mesh. */
  function advanceMeteors(dt) {
    const matrices = meteors.mesh.instanceMatrix.array;
    const looks = meteors.look.array;
    const heads = meteors.head.array;
    const trails = meteors.trail.array;
    let count = 0;
    for (let slot = 0; slot < METEOR_CAPACITY; slot++) {
      const record = slot * METEOR_STRIDE;
      if (meteorPool[record] === 0) continue;
      const owner = ownerOf(meteorPool[record + 14]);
      const age = meteorPool[record + 1] + dt;
      meteorPool[record + 1] = age;
      if (!owner || age >= meteorPool[record + 2]) {
        meteorPool[record] = 0;
        if (owner) owner.data.meteorsActive--;
        continue;
      }
      const data = owner.data;
      const params = data.params.meteors;
      const speed = meteorPool[record + 10];
      const headAngle = meteorPool[record + 9] + speed * age;
      const trailAngle = Math.min(meteorPool[record + 11], speed * age + 0.002);
      const tailAngle = headAngle - trailAngle;
      const radiant = scratch.radiant.set(meteorPool[record + 6], meteorPool[record + 7], meteorPool[record + 8]);
      const perpendicular = scratch.w.set(meteorPool[record + 3], meteorPool[record + 4], meteorPool[record + 5]);
      const head = scratch.head.copy(radiant).multiplyScalar(Math.cos(headAngle)).addScaledVector(perpendicular, Math.sin(headAngle));
      const tail = scratch.tail.copy(radiant).multiplyScalar(Math.cos(tailAngle)).addScaledVector(perpendicular, Math.sin(tailAngle));
      const middle = scratch.middle.copy(head).add(tail).normalize();
      const along = scratch.along.copy(head).sub(tail).normalize();
      const fireball = meteorPool[record + 13];
      writeSkyQuad(matrices, count, middle, along, trailAngle, fireball > 0 ? FIREBALL_WIDTH : METEOR_WIDTH, 0);
      const fraction = age / meteorPool[record + 2];
      const fade = smooth(age, 0, 0.08) * (1 - smooth(fraction, 0.62, 1));
      const out = count * 4;
      looks[out] = meteorPool[record + 12] * fade * data.visibility * data.presence;
      looks[out + 1] = fireball;
      looks[out + 2] = 0;
      looks[out + 3] = meteorPool[record + 15];
      heads[out] = data.meteorHead.r;
      heads[out + 1] = data.meteorHead.g;
      heads[out + 2] = data.meteorHead.b;
      trails[out] = data.meteorTrail.r;
      trails[out + 1] = data.meteorTrail.g;
      trails[out + 2] = data.meteorTrail.b;
      count++;
      if (params === null) meteorPool[record] = 0;
    }
    activeMeteors = count;
    flushMesh(meteors.mesh, count, lists.meteors);
  }

  function updateMeteors(instance, dt) {
    const data = instance.data;
    const params = data.params.meteors;
    data.visibility = darkSky(params.daylight);
    if (dt <= 0) return;
    data.meteorTimer -= dt;
    while (data.meteorTimer <= 0) {
      // Poisson arrivals at `rate` per minute (the seeded generator keeps the stream reproducible).
      data.meteorTimer += -Math.log(1 - data.rng() * 0.999999) * (60 / params.rate);
      if (data.visibility * data.presence > 0.05) spawnMeteor(instance);
    }
    data.flash *= Math.exp(-FLASH_DECAY * dt);
    if (data.voice) data.voice.setIntensity(data.visibility * data.presence * Math.min(1, params.rate / 30));
  }

  // ---- Comet --------------------------------------------------------------------------------------
  function updateComet(instance, direction) {
    const data = instance.data;
    const params = data.params.comet;
    if (cometCursor >= COMET_CAPACITY) return;
    // The dust tail points away from the sun along the sky: the anti-sun direction projected on the
    // comet's tangent plane.
    const sun = ctx.state.time.sunDirection;
    const away = scratch.along.copy(sun).multiplyScalar(-1);
    away.addScaledVector(direction, -away.dot(direction));
    if (away.lengthSq() < 1e-8) basisAround(direction, away, scratch.v);
    away.normalize();
    const visibility = (1 - smooth(frame.sunElevation, -8, 3)) * (1 - 0.92 * frame.overcast);
    const length = params.tailLength * DEG;
    const width = params.tailWidth * DEG;
    const slot = cometCursor;
    writeSkyQuad(comets.mesh.instanceMatrix.array, slot, direction, away, length, width, length * 0.5);
    const out = slot * 4;
    const looks = comets.look.array;
    looks[out] = params.brightness * visibility * data.presence * data.tierVisibility;
    looks[out + 1] = params.curvature;
    looks[out + 2] = params.ionTail;
    looks[out + 3] = data.seedValue;
    const dust = comets.dust.array;
    dust[out] = data.cometDust.r;
    dust[out + 1] = data.cometDust.g;
    dust[out + 2] = data.cometDust.b;
    dust[out + 3] = Math.min(0.4, (params.headSize * DEG) / length);
    const ion = comets.ion.array;
    ion[out] = data.cometIon.r;
    ion[out + 1] = data.cometIon.g;
    ion[out + 2] = data.cometIon.b;
    ion[out + 3] = width / length;
    cometCursor++;
    flushMesh(comets.mesh, cometCursor, lists.comets);
  }

  // ---- Eclipse ------------------------------------------------------------------------------------
  function updateEclipse(instance) {
    const data = instance.data;
    const params = data.params.eclipse;
    const sun = ctx.state.time.sunDirection;
    // Progress through the crossing: -1 first contact side, 0 mid-eclipse, 1 the far side.
    const lead = ((data.duration ?? params.crossingSeconds / 0.8) - params.crossingSeconds) * 0.5;
    const u = (data.age - lead) / params.crossingSeconds * 2 - 1;
    const magnitude = Math.abs(u);
    // Slow through totality: separation = reach * |u|^power, so totality lasts totalitySeconds.
    const separation = magnitude <= 1 ? CROSSING_REACH * Math.pow(magnitude, data.eclipsePower) : CROSSING_REACH * magnitude;
    const along = Math.sign(u) * separation;
    basisAround(sun, scratch.u, scratch.v);
    const pathX = Math.cos(data.pathAngle) * along - Math.sin(data.pathAngle) * params.offset;
    const pathY = Math.sin(data.pathAngle) * along + Math.cos(data.pathAngle) * params.offset;
    const distance = Math.sqrt(pathX * pathX + pathY * pathY);
    const uncovered = uncoveredShare(distance, params.moonScale);
    const dim = Math.pow(1 - uncovered, 3);
    const totality = 1 - smooth(uncovered, 0, 0.02);
    data.eclipseUncovered = uncovered;
    data.eclipseTotality = totality;
    // The moon disc, over the sun (sun-radius units in the sun's tangent basis).
    const moonDirection = scratch.middle.copy(sun).addScaledVector(scratch.u, pathX * SUN_ANGULAR_RADIUS).addScaledVector(scratch.v, pathY * SUN_ANGULAR_RADIUS).normalize();
    if (eclipseCursor < ECLIPSE_CAPACITY) {
      const slot = eclipseCursor;
      const moonSize = SUN_ANGULAR_RADIUS * params.moonScale * 2;
      writeSkyQuad(eclipses.disc.instanceMatrix.array, slot, moonDirection, scratch.u, moonSize, moonSize, 0);
      eclipses.shade.array[slot * 4] = smooth(1 - uncovered, 0.93, 1);
      // The corona quad, centred on the sun, spanning CORONA_EXTENT sun radii each way.
      const coronaSize = SUN_ANGULAR_RADIUS * CORONA_EXTENT * 2;
      writeSkyQuad(eclipses.corona.instanceMatrix.array, slot, sun, scratch.u, coronaSize, coronaSize, 0);
      const state = eclipses.state.array;
      const moon = eclipses.moon.array;
      const out = slot * 4;
      // Baily's beads: the last sliver of sun shows on the limb facing away from the moon's centre.
      const beads = uncovered > 0 && uncovered < 0.03 ? Math.sin((uncovered / 0.03) * Math.PI) : 0;
      state[out] = totality * data.presence;
      state[out + 1] = beads * data.presence;
      state[out + 2] = Math.atan2(-pathY, -pathX);
      state[out + 3] = params.moonScale;
      moon[out] = pathX;
      moon[out + 1] = pathY;
      moon[out + 2] = data.seedValue;
      moon[out + 3] = params.corona;
      eclipseCursor++;
      flushMesh(eclipses.disc, eclipseCursor, lists.disc);
      flushMesh(eclipses.corona, eclipseCursor, lists.corona);
    }
    // The world darkens: only while the sun is up (an eclipse below the horizon changes nothing).
    const sunUp = smooth(frame.sunElevation, -1.5, 3);
    const weight = sunUp * data.presence;
    const values = data.modifierValues;
    values.sunIntensity = Math.max(0.004, uncovered);
    values.ambient = 1 - 0.72 * dim;
    values.darkness = params.darkness * dim;
    values.stars = Math.min(1, params.stars * (0.3 * dim + 0.7 * totality));
    values.skyTintAmount = 0.55 * dim;
    values.fogColorAmount = 0.5 * dim;
    data.eclipseWeight = weight;
    if (params.quietWildlife) {
      if (!data.quiet && dim * weight > QUIET_ON) setQuiet(instance, true);
      else if (data.quiet && dim * weight < QUIET_OFF) setQuiet(instance, false);
    }
  }

  /**
   * untilDawn: an event that lasts the rest of the night (a comet). Once the instance has seen the sun
   * below dawnElevation, the sun climbing back past it ends the night: the event's duration is cut to
   * its fadeOut from now, so it fades out and ends like any other. A spawn started in daylight waits
   * for a night first.
   */
  function watchForDawn(data, params) {
    if (frame.sunElevation < params.dawnElevation) {
      data.sawNight = true;
      return;
    }
    if (!data.sawNight) return;
    data.dawnReached = true;
    const remaining = data.age + params.fadeOut;
    data.duration = data.duration === null ? remaining : Math.min(data.duration, remaining);
  }

  function setQuiet(instance, quiet) {
    const data = instance.data;
    if (data.quiet === quiet) return;
    data.quiet = quiet;
    ctx.bus.emitTyped('wildlifeQuiet', { source: data.id, quiet });
  }

  // ---- Glory and rainbow --------------------------------------------------------------------------
  function updateGlory(instance) {
    const params = instance.data.params.glory;
    const sunUp = smooth(frame.sunElevation, params.minSunElevation, params.minSunElevation + 5) * (1 - smooth(frame.sunElevation, params.maxSunElevation - 5, params.maxSunElevation));
    const weight = sunUp * instance.data.presence * instance.data.tierVisibility * (1 - frame.overcast);
    gloryFrame = Math.max(gloryFrame, params.strength * weight);
    bowFrame = Math.max(bowFrame, params.bow * weight);
  }

  function updateRainbow(instance) {
    const data = instance.data;
    const params = data.params.rainbow;
    if (rainbowCursor >= RAINBOW_CAPACITY) return;
    const light = params.light === 'moon' ? ctx.state.time.moonDirection : ctx.state.time.sunDirection;
    // The light must be up and behind the viewer; the bow stands 42 degrees from the antisolar point.
    const lightUp = smooth(light.y, 0.01, 0.08);
    const presence = data.presence * data.tierVisibility * lightUp * (params.light === 'moon' ? ctx.state.time.nightFactor : 1) * (1 - 0.9 * frame.overcast);
    const slot = rainbowCursor;
    const anchor = instance.anchor;
    const centreX = anchor.x + params.offsetX * data.rightX + params.offsetZ * data.forwardX;
    const centreZ = anchor.z + params.offsetX * data.rightZ + params.offsetZ * data.forwardZ;
    const centreY = anchor.y + params.height;
    const matrices = rainbows.mesh.instanceMatrix.array;
    const out = slot * 16;
    const origin = rainbows.mesh.position;
    matrices.fill(0, out, out + 16);
    matrices[out] = params.radius;
    matrices[out + 5] = params.radius;
    matrices[out + 10] = params.radius;
    matrices[out + 12] = centreX - origin.x;
    matrices[out + 13] = centreY - origin.y;
    matrices[out + 14] = centreZ - origin.z;
    matrices[out + 15] = 1;
    const volume = rainbows.volume.array;
    const bow = rainbows.bow.array;
    const attribute = slot * 4;
    volume[attribute] = centreX - origin.x;
    volume[attribute + 1] = centreY - origin.y;
    volume[attribute + 2] = centreZ - origin.z;
    volume[attribute + 3] = params.radius;
    bow[attribute] = params.strength * presence;
    bow[attribute + 1] = params.secondary;
    bow[attribute + 2] = params.light === 'moon' ? 1 : 0;
    bow[attribute + 3] = 0;
    rainbowCursor++;
    flushMesh(rainbows.mesh, rainbowCursor, lists.rainbows);
  }

  // ---- Modifier -----------------------------------------------------------------------------------
  /** Folds the eclipse, the fireball flash and the static sky component into the instance's modifier. */
  function applyModifier(instance) {
    const data = instance.data;
    if (!data.modifier) return;
    const params = data.params;
    const values = data.modifierValues;
    let weight = 0;
    if (params.eclipse) {
      weight = data.eclipseWeight;
    } else {
      values.sunIntensity = 1;
      values.ambient = 1;
      values.darkness = 0;
      values.stars = 0;
      values.skyTintAmount = 0;
      values.fogColorAmount = 0;
    }
    if (params.sky) {
      const sky = params.sky;
      const when = sky.when === 'always' ? 1 : sky.when === 'night' ? ctx.state.time.nightFactor : 1 - ctx.state.time.nightFactor;
      const staticWeight = data.presence * when;
      const skyValues = sky.values;
      // The static values ease in with the instance, on top of an eclipse if both are present.
      if (skyValues.sunIntensity !== undefined) values.sunIntensity *= 1 + (skyValues.sunIntensity - 1) * staticWeight;
      if (skyValues.ambient !== undefined) values.ambient *= 1 + (skyValues.ambient - 1) * staticWeight;
      if (skyValues.darkness !== undefined) values.darkness = Math.max(values.darkness, skyValues.darkness * staticWeight);
      if (skyValues.stars !== undefined) values.stars = Math.max(values.stars, skyValues.stars * staticWeight);
      if (skyValues.overcast !== undefined) values.overcast = skyValues.overcast * staticWeight;
      if (skyValues.fogDensity !== undefined) values.fogDensity = 1 + (skyValues.fogDensity - 1) * staticWeight;
      if (skyValues.skyTintAmount !== undefined) values.skyTintAmount = Math.max(values.skyTintAmount, skyValues.skyTintAmount * staticWeight);
      if (skyValues.fogColorAmount !== undefined) values.fogColorAmount = Math.max(values.fogColorAmount, skyValues.fogColorAmount * staticWeight);
      weight = Math.max(weight, staticWeight > 0 ? 1 : 0);
    }
    if (data.flash > 0.002) {
      // A fireball lights the land and the sky for a moment (greenish white).
      values.ambient *= 1 + 1.6 * data.flash;
      values.skyTintAmount = Math.max(values.skyTintAmount, 0.18 * data.flash);
      weight = Math.max(weight, 1);
    }
    values.weight = Math.min(1, weight);
    data.modifier.set(values);
  }

  // ---- Engine interface ---------------------------------------------------------------------------
  return {
    name: 'celestial',
    budget: { instances: 3, particles: 6000 },

    init(engineCtx) {
      ctx = engineCtx;
      THREE = ctx.THREE;
      const TSL = ctx.TSL;
      const skyColorNode = typeof ctx.sky?.skyColorNode === 'function' ? ctx.sky.skyColorNode : null;
      if (!ctx.uniforms.cloudGlory || !ctx.uniforms.cloudBow) throw new Error('the celestial engine needs the cloud optics uniforms (uniforms.cloudGlory, uniforms.cloudBow)');
      meteors = createMeteorMesh(THREE, TSL, { capacity: METEOR_CAPACITY });
      comets = createCometMesh(THREE, TSL, { uniforms: ctx.uniforms, capacity: COMET_CAPACITY });
      eclipses = createEclipseMeshes(THREE, TSL, { skyColorNode, uniforms: ctx.uniforms, capacity: ECLIPSE_CAPACITY });
      rainbows = createRainbowMesh(THREE, TSL, { uniforms: ctx.uniforms, capacity: RAINBOW_CAPACITY });
      ctx.scene.add(meteors.mesh, comets.mesh, eclipses.disc, eclipses.corona, rainbows.mesh);
      // Drawn once behind the loading fade, so the first meteor, comet, eclipse or rainbow costs no
      // pipeline build and its geometry is counted in the memory baseline from the start.
      for (const mesh of [meteors.mesh, comets.mesh, eclipses.disc, eclipses.corona, rainbows.mesh]) ctx.registerPrewarm?.(mesh);
      lists.meteors = [meteors.look, meteors.head, meteors.trail];
      lists.comets = [comets.look, comets.dust, comets.ion];
      lists.disc = [eclipses.shade];
      lists.corona = [eclipses.state, eclipses.moon];
      lists.rainbows = [rainbows.volume, rainbows.bow];
      // Instance matrices and attributes: meteors 4, comets 4, disc 2, corona 3, rainbows 3.
      buffersOwned = 16;
      scratch = {
        pole: new THREE.Vector3(0, Math.sin(CELESTIAL_POLE_ELEVATION_DEG * DEG), -Math.cos(CELESTIAL_POLE_ELEVATION_DEG * DEG)).normalize(),
        quaternion: new THREE.Quaternion(),
        radiant: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        u: new THREE.Vector3(),
        v: new THREE.Vector3(),
        w: new THREE.Vector3(),
        head: new THREE.Vector3(),
        tail: new THREE.Vector3(),
        middle: new THREE.Vector3(),
        along: new THREE.Vector3(),
        across: new THREE.Vector3(),
      };
    },

    create(preset, params, rng) {
      const duration = Number.isFinite(params.duration) ? params.duration : null;
      const resolved = resolveCelestialParams(params, duration);
      const heading = Number.isFinite(params.heading) ? params.heading * DEG : 0;
      const id = `celestial-${serial++}`;
      const owner = serial;
      const data = {
        id,
        owner,
        params: resolved,
        rng,
        seedValue: rng() * 97,
        startTime: Number.isFinite(params.startTime) ? params.startTime : ctx.time.elapsed,
        duration,
        age: 0,
        sawNight: false,
        dawnReached: false,
        presence: resolved.fadeIn > 0 ? 0 : 1,
        tierVisibility: 1,
        tier: 'near',
        forwardX: Math.sin(heading),
        forwardZ: -Math.cos(heading),
        rightX: Math.cos(heading),
        rightZ: Math.sin(heading),
        radiant: null,
        cometDirection: null,
        meteorTimer: 0,
        meteorsActive: 0,
        meteorsSpawned: 0,
        visibility: 0,
        flash: 0,
        meteorHead: null,
        meteorTrail: null,
        cometDust: null,
        cometIon: null,
        eclipsePower: 2,
        pathAngle: 0,
        eclipseUncovered: 1,
        eclipseTotality: 0,
        eclipseWeight: 0,
        quiet: false,
        modifier: null,
        modifierValues: null,
        voice: null,
        triggerOptions: { strength: 1, duration: 1 },
        writtenFrame: -1,
      };
      if (resolved.meteors) {
        const meteorParams = resolved.meteors;
        const radiantNow = meteorParams.radiant
          ? directionFrom(meteorParams.radiant.azimuth, meteorParams.radiant.elevation, new THREE.Vector3())
          : directionFrom(rng() * 360, 30 + rng() * 40, new THREE.Vector3());
        data.radiant = toStarFrame(radiantNow, new THREE.Vector3());
        data.meteorTimer = rng() * (60 / meteorParams.rate);
        data.meteorHead = new THREE.Color(meteorParams.color);
        data.meteorTrail = new THREE.Color(meteorParams.trail);
      }
      if (resolved.comet) {
        const comet = resolved.comet;
        let now;
        if (comet.position) now = directionFrom(comet.position.azimuth, comet.position.elevation, new THREE.Vector3());
        else {
          // Seeded and circumpolar: 18-32 degrees from the pole, so it stays up all night.
          const u = new THREE.Vector3();
          const v = new THREE.Vector3();
          basisAround(scratch.pole, u, v);
          const around = rng() * TWO_PI;
          const offset = (18 + rng() * 14) * DEG;
          now = scratch.pole.clone().multiplyScalar(Math.cos(offset)).addScaledVector(u.multiplyScalar(Math.cos(around)).addScaledVector(v, Math.sin(around)), Math.sin(offset)).normalize();
          now.applyQuaternion(starRotation(new THREE.Quaternion()));
        }
        data.cometDirection = comet.sidereal ? toStarFrame(now, new THREE.Vector3()) : now;
        data.cometDust = new THREE.Color(comet.color);
        data.cometIon = new THREE.Color(comet.ionColor);
      }
      if (resolved.eclipse) {
        const eclipse = resolved.eclipse;
        const totalityShare = Math.min(0.9, eclipse.totalitySeconds / eclipse.crossingSeconds);
        const totalGap = Math.max(0.005, eclipse.moonScale - 1);
        data.eclipsePower = Math.max(1, Math.log(totalGap / CROSSING_REACH) / Math.log(totalityShare));
        data.pathAngle = eclipse.pathAngle !== null ? eclipse.pathAngle * DEG : (rng() * 2 - 1) * 0.6;
      }
      const anchor = params.position;
      const instance = { anchor, radius: 800, windSourceIds: [], lights: 0, particles: 0, tier: 'near', heavy: preset.heavy === true, data };
      if (resolved.rainbow) instance.radius = resolved.rainbow.radius + resolved.rainbow.height;
      // The couplings can refuse (an unknown audio recipe throws): the manager never receives this
      // instance then, so whatever was registered here is removed before the error goes on.
      try {
        if (resolved.eclipse || resolved.sky || resolved.meteors) {
          data.modifier = ctx.sky && typeof ctx.sky.addModifier === 'function' ? ctx.sky.addModifier(`${id}:celestial`, { priority: MODIFIER_PRIORITY }) : null;
          data.modifierValues = {
            weight: 0, sunIntensity: 1, ambient: 1, fogDensity: 1, darkness: 0, stars: 0, overcast: 0,
            skyTint: new THREE.Color(resolved.sky && resolved.sky.values.skyTint !== undefined ? resolved.sky.values.skyTint : resolved.meteors && !resolved.eclipse ? 0xcff7e2 : 0x1b2350),
            skyTintAmount: 0,
            fogColor: new THREE.Color(resolved.sky && resolved.sky.values.fogColor !== undefined ? resolved.sky.values.fogColor : 0x4a3a4c),
            fogColorAmount: 0,
          };
          if (data.modifier) data.modifier.set(data.modifierValues);
        }
        if (ownsPresetAudio(preset, 'celestial', params.ownsAudio) && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
          data.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: 0 });
          data.voice.setPosition(anchor);
        }
      } catch (error) {
        if (data.modifier) {
          data.modifier.remove();
          data.modifier = null;
        }
        if (data.voice) {
          data.voice.dispose();
          data.voice = null;
        }
        throw error;
      }
      live.push(instance);
      return instance;
    },

    update(instance, dt, engineCtx) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const stamp = engineCtx.state.frame;
      if (stamp !== frameStamp) beginFrame(stamp, step);
      const data = instance.data;
      if (data.writtenFrame === stamp) return;
      data.writtenFrame = stamp;
      const params = data.params;
      data.age = ctx.time.elapsed - data.startTime;
      if (params.untilDawn && !data.dawnReached) watchForDawn(data, params);
      // Presence: fades in, and out before the end of an event (the eclipse's crossing is its own).
      let presence = params.fadeIn > 0 ? Math.min(1, data.age / params.fadeIn) : 1;
      if (data.duration !== null && params.fadeOut > 0) presence = Math.min(presence, Math.max(0, (data.duration - data.age) / params.fadeOut));
      data.presence = presence;
      const farTarget = data.tier === 'far' && params.anchor === 'world' ? 0 : 1;
      data.tierVisibility += (farTarget - data.tierVisibility) * Math.min(1, step / 1.2);
      if (step === 0 && data.writtenFrame === stamp && data.tierVisibility !== farTarget && data.age <= 0) data.tierVisibility = farTarget;
      if (data.duration !== null && data.age >= data.duration) instance.ended = true;

      // The spawn's own direction in the sky (for a 'sky' anchor), and each component.
      const direction = scratch.direction;
      direction.set(0, 1, 0);
      if (params.meteors) {
        updateMeteors(instance, step);
        direction.copy(data.radiant).applyQuaternion(starRotation(scratch.quaternion));
      }
      if (params.comet) {
        const comet = scratch.head.copy(data.cometDirection);
        if (params.comet.sidereal) comet.applyQuaternion(starRotation(scratch.quaternion));
        updateComet(instance, comet);
        direction.copy(comet);
      }
      if (params.glory) {
        updateGlory(instance);
        direction.copy(ctx.state.time.sunDirection).multiplyScalar(-1);
      }
      if (params.eclipse) {
        updateEclipse(instance);
        direction.copy(ctx.state.time.sunDirection);
      }
      if (params.rainbow) updateRainbow(instance);
      applyModifier(instance);
      if (params.anchor === 'sky') {
        instance.anchor.set(frame.cameraX + direction.x * params.anchorDistance, frame.cameraY + direction.y * params.anchorDistance, frame.cameraZ + direction.z * params.anchorDistance);
      }
      if (data.voice) data.voice.setPosition(instance.anchor);
      instance.particles = data.meteorsActive;
    },

    setLOD(instance, tier) {
      instance.tier = tier;
      instance.data.tier = tier;
      if (instance.data.writtenFrame === -1) instance.data.tierVisibility = tier === 'far' && instance.data.params.anchor === 'world' ? 0 : 1;
    },

    dispose(instance) {
      const data = instance.data;
      if (data.quiet) setQuiet(instance, false);
      if (data.modifier) {
        data.modifier.remove();
        data.modifier = null;
      }
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      for (let slot = 0; slot < METEOR_CAPACITY; slot++) {
        if (meteorPool[slot * METEOR_STRIDE + 14] === data.owner) meteorPool[slot * METEOR_STRIDE] = 0;
      }
      data.meteorsActive = 0;
      const index = live.indexOf(instance);
      if (index >= 0) live.splice(index, 1);
      if (live.length === 0) {
        // Nothing left: every sky object hides and the clouds lose their optics at once.
        flushMesh(meteors.mesh, 0, lists.none);
        flushMesh(comets.mesh, 0, lists.none);
        flushMesh(eclipses.disc, 0, lists.none);
        flushMesh(eclipses.corona, 0, lists.none);
        flushMesh(rainbows.mesh, 0, lists.none);
        activeMeteors = 0;
        gloryFrame = 0;
        bowFrame = 0;
        ctx.uniforms.cloudGlory.value = 0;
        ctx.uniforms.cloudBow.value = 0;
      }
    },

    stats() {
      const visible = (mesh) => (mesh && mesh.visible ? 1 : 0);
      const drawCalls = meteors ? visible(meteors.mesh) + visible(comets.mesh) + visible(eclipses.disc) + visible(eclipses.corona) + visible(rainbows.mesh) : 0;
      return { instances: live.length, particles: activeMeteors, lights: 0, buffers: buffersOwned, drawCalls };
    },

    /** Dev and tests: the state of one instance's components. */
    describe(instance) {
      const data = instance.data;
      return {
        presence: data.presence,
        duration: data.duration,
        dawnReached: data.dawnReached,
        meteorsActive: data.meteorsActive,
        meteorsSpawned: data.meteorsSpawned,
        visibility: data.visibility,
        flash: data.flash,
        eclipse: data.params.eclipse ? { uncovered: data.eclipseUncovered, totality: data.eclipseTotality, weight: data.eclipseWeight, quiet: data.quiet } : null,
        glory: { cloudGlory: ctx.uniforms.cloudGlory.value, cloudBow: ctx.uniforms.cloudBow.value },
        anchor: { x: instance.anchor.x, y: instance.anchor.y, z: instance.anchor.z },
      };
    },
  };
}
