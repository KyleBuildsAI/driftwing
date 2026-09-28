// Spawn voices (Phase 2): the procedural sound of spawns, from a tornado's roar to a crystal's hum,
// on the environment bus. audio.spawnVoice(), audio.thunder() and audio.discoveryChime() are built
// here (see AudioEngine.js); the recipes that make each sound are in recipes/.
//
// A voice is a logical sound source: a recipe, a position, an intensity. It exists from the moment
// a spawn engine asks for it, even before the AudioContext does. Every parameter update the voices
// are measured from the listener (the camera, through the craft spatializer in spatial.js) and
// ranked by their audibility (the recipe's level at that intensity times the distance gain). The
// loudest, up to the voice budget, are REALIZED: their recipe's nodes are built and faded in. The
// rest are VIRTUAL: silent and without nodes, until they rise into the budget again. A voice culled
// by the budget or fading below audibility fades out and releases every node; the hysteresis
// (REALIZED_BONUS) keeps two voices of nearly equal loudness from trading places.
//
// A realized voice:
//   recipe nodes --> fade (scaffold output) --> air absorption low-pass --+--> gain --> PannerNode --+
//                                                                         +--> spread gain ---------+--> spawn submix
//                                                                         +--> reverb send (environment)
//   spawn submix --> interior low-pass (closed cockpits) --> environment bus
// - The PannerNode applies the recipe's distance model (inverse, exponential or linear, with a
//   reference distance and rolloff tuned per recipe: a tornado carries for kilometres, a geyser or a
//   crystal only nearby). The same law ranks the voices, so the budget hears what the player hears.
// - Air absorption: a low-pass that closes with distance (2.4e6 / distance Hz, at least 300 Hz), so
//   far sources lose their highs, as in real air.
// - Size: inside a large source (a tornado, a waterfall, a lantern festival) the sound surrounds
//   the listener; the spread gain crossfades part of it to an unpanned path.
// - Doppler: the recipe's sources and filters are detuned by one signal (cents) computed with the
//   craft spatializer's dopplerFactor() from the listener's cut-aware velocity (a camera cut is not
//   motion) and the source's velocity (given to setPosition, or derived from successive positions,
//   a jump faster than TELEPORT_SPEED being a relocation).
// - The reverb send falls with the square root of the distance gain, so far sources sound wetter.
//
// Thunder: audio.thunder({ position, intensity }) queues a strike in a pool of pending fronts.
// Every update the front's radius (343 m/s times the time since the strike) is compared with the
// listener's current distance; when the gap will close within the next update, the strike is
// scheduled at the exact moment, solving for the listener's radial speed. A listener flying toward
// or away from the storm during the delay hears it when the front really reaches them.
//
// Nothing here allocates in the per-update path: vectors are reused, voices are ranked by an
// insertion sort in a reused array, the thunder queue is a fixed pool. Nodes are created only when
// a voice is realized, a trigger fires a one-shot, or a strike arrives.
import { clamp } from '../core/util.js';
import { playDiscoveryChime } from './recipes/discovery.js';
import { RECIPES, RECIPE_NAMES } from './recipes/index.js';
import { THUNDER_SPATIAL, playThunderStrike } from './recipes/thunder.js';
import { SPEED_OF_SOUND, dopplerFactor } from './spatial.js';
import { createScaffold, glide, holdAt, smoothstep } from './synthKit.js';

export const DEFAULT_VOICE_BUDGET = 10;
export const MAX_VOICE_BUDGET = 32;
/** Audibility (approximate RMS at the listener) below which a voice is not worth its nodes. */
export const AUDIBLE_FLOOR = 0.0004;
const REALIZED_BONUS = 1.5;
const TELEPORT_SPEED = 1500;
const FADE_IN = 0.4;
const FADE_OUT = 0.3;
const TRIGGER_LEAD = 0.01;
const DOPPLER_SMOOTHING = 0.45;
const ABSORPTION_METRE_HERTZ = 2.4e6;
const MIN_ABSORPTION_CUTOFF = 300;
const SPREAD_LEVEL = 0.45;
const SEND_LEVEL = 0.4;
const DEFAULT_MAX_DISTANCE = 100000;
const THUNDER_SLOTS = 8;
const THUNDER_RECORDS = 8;
const MAX_THUNDER_PLAYING = 4;
export const MAX_THUNDER_DISTANCE = 30000;
const THUNDER_LOOKAHEAD = 1.5;
const DISTANCE_MODELS = new Set(['inverse', 'exponential', 'linear']);
const EMPTY_OPTIONS = Object.freeze({});

// ---- Pure helpers (also used by the offline renders and the audio lab) ------------------------------

/** The distance gain of a spatial tuning at distance (the Web Audio PannerNode formulas). */
export function distanceGain(spatial, distance) {
  const reference = spatial.refDistance;
  const rolloff = spatial.rolloffFactor;
  const clamped = Math.max(Number.isFinite(distance) ? distance : Infinity, reference);
  if (spatial.distanceModel === 'exponential') return Math.pow(clamped / reference, -rolloff);
  if (spatial.distanceModel === 'linear') {
    const maximum = spatial.maxDistance;
    return 1 - (Math.min(rolloff, 1) * (Math.min(clamped, maximum) - reference)) / (maximum - reference);
  }
  return reference / (reference + rolloff * (clamped - reference));
}

/** The air-absorption low-pass cutoff (Hz) at distance (m). */
export function absorptionCutoff(distance, nyquist) {
  return clamp(ABSORPTION_METRE_HERTZ / Math.max(distance, 1), MIN_ABSORPTION_CUTOFF, nyquist);
}

/**
 * Seconds until a sound front emitted elapsed seconds ago reaches a listener now distance metres
 * from its origin and closing on it at closingSpeed m/s (negative when flying away). 0 when the
 * front has already passed.
 */
export function frontArrival(elapsed, distance, closingSpeed) {
  const gap = distance - SPEED_OF_SOUND * elapsed;
  if (gap <= 0) return 0;
  return gap / Math.max(SPEED_OF_SOUND + closingSpeed, SPEED_OF_SOUND * 0.25);
}

/** The recipe's spatial tuning with a preset's audio.params overrides applied. */
export function resolveSpatial(base, params) {
  const pick = (key, fallback, min, max) => (params && Number.isFinite(params[key]) ? clamp(params[key], min, max) : fallback);
  const distanceModel = params && DISTANCE_MODELS.has(params.distanceModel) ? params.distanceModel : base.distanceModel;
  return Object.freeze({
    distanceModel,
    refDistance: pick('refDistance', base.refDistance, 1, 50000),
    rolloffFactor: pick('rolloffFactor', base.rolloffFactor, 0, 10),
    maxDistance: pick('maxDistance', base.maxDistance ?? DEFAULT_MAX_DISTANCE, 10, 1e6),
    panningModel: base.panningModel,
    size: pick('size', base.size, 0, 20000),
    reverb: pick('reverb', base.reverb, 0, 1),
  });
}

/**
 * Builds a voice's node graph in any BaseAudioContext (the live one, or an OfflineAudioContext for
 * the auditions). env: { context, noise, destination, send (or null), nyquist, trackOneShot };
 * voice: { recipe, params, spatial, position, intensity }. Returns the realized voice.
 */
export function buildVoiceGraph(env, voice, time) {
  const { context } = env;
  const spatial = voice.spatial;
  const absorption = new BiquadFilterNode(context, { type: 'lowpass', frequency: env.nyquist, Q: 0.5 });
  const scaffold = createScaffold(context, absorption);
  scaffold.add(absorption);
  const panGain = scaffold.gain(1);
  const panner = scaffold.add(new PannerNode(context, {
    panningModel: spatial.panningModel,
    distanceModel: spatial.distanceModel,
    refDistance: spatial.refDistance,
    rolloffFactor: spatial.distanceModel === 'linear' ? Math.min(spatial.rolloffFactor, 1) : spatial.rolloffFactor,
    maxDistance: spatial.maxDistance,
    positionX: voice.position.x,
    positionY: voice.position.y,
    positionZ: voice.position.z,
  }));
  absorption.connect(panGain);
  panGain.connect(panner);
  panner.connect(env.destination);
  const spreadGain = scaffold.gain(0);
  absorption.connect(spreadGain);
  spreadGain.connect(env.destination);
  let send = null;
  if (env.send && spatial.reverb > 0) {
    send = scaffold.gain(0);
    absorption.connect(send);
    send.connect(env.send);
  }
  const doppler = scaffold.add(new ConstantSourceNode(context, { offset: 0 }));
  const kit = {
    context,
    noise: env.noise,
    scaffold,
    out: scaffold.output,
    pitched(node) {
      doppler.connect(node.detune);
      return node;
    },
    trackOneShot: env.trackOneShot,
  };
  let synth;
  try {
    synth = voice.recipe.build(kit, voice.params);
  } catch (error) {
    // Release whatever the recipe built before it failed.
    scaffold.start(time);
    scaffold.stop(time, 0);
    throw error;
  }
  scaffold.start(time);
  synth.setIntensity(voice.intensity, time, true);
  scaffold.output.gain.setTargetAtTime(1, time, FADE_IN / 3);
  return {
    scaffold,
    absorption,
    panner,
    panGain,
    spreadGain,
    send,
    doppler,
    synth,
    nodeCount: scaffold.nodeCount,
    appliedIntensity: voice.intensity,
  };
}

/**
 * Applies a voice's placement to its realized graph: panner position, air absorption, spread,
 * reverb send and doppler (cents).
 */
export function applyPlacement(realized, placement, time, timeConstant) {
  const { position } = placement;
  glide(realized.panner.positionX, position.x, time, timeConstant);
  glide(realized.panner.positionY, position.y, time, timeConstant);
  glide(realized.panner.positionZ, position.z, time, timeConstant);
  glide(realized.absorption.frequency, placement.cutoff, time, 0.15);
  glide(realized.panGain.gain, 1 - 0.6 * placement.spread, time, 0.2);
  glide(realized.spreadGain.gain, SPREAD_LEVEL * placement.spread * placement.gain, time, 0.2);
  if (realized.send) glide(realized.send.gain, SEND_LEVEL * placement.spatial.reverb * Math.sqrt(placement.gain), time, 0.2);
  glide(realized.doppler.offset, 1200 * Math.log2(placement.doppler), time, timeConstant);
}

/** How much of a voice surrounds the listener (0..1): 1 well inside a large source. */
export function spreadAt(size, distance) {
  return size > 0 ? 1 - smoothstep(size * 0.5, size * 2, distance) : 0;
}

/** A recipe definition by name, or a clear error naming the known ones. */
export function recipeByName(name) {
  const recipe = Object.prototype.hasOwnProperty.call(RECIPES, name) ? RECIPES[name] : null;
  if (!recipe) throw new Error(`audio.spawnVoice: unknown recipe "${name}" (known: ${RECIPE_NAMES.join(', ')})`);
  return recipe;
}

// ---- The voice manager --------------------------------------------------------------------------------

/** deps: { THREE, onIssue(error) }. */
export function createSpawnVoices({ THREE, onIssue }) {
  const voices = [];
  const ranked = [];
  let rankedCount = 0;
  const counters = {
    created: 0,
    disposed: 0,
    realizations: 0,
    culled: 0,
    faded: 0,
    buildFailures: 0,
    nodesLive: 0,
    oneShotNodesLive: 0,
    triggers: 0,
    thunderQueued: 0,
    thunderPlayed: 0,
    thunderDropped: 0,
  };
  let env = null;
  let listener = null;
  let submix = null;
  let interiorFilter = null;
  let budget = DEFAULT_VOICE_BUDGET;
  let nextId = 1;
  let lastUpdateRealTime = null;
  let interiorActive = false;

  const right = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const strikePosition = new THREE.Vector3();

  const thunderSlots = [];
  for (let index = 0; index < THUNDER_SLOTS; index++) {
    thunderSlots.push({ active: false, x: 0, y: 0, z: 0, intensity: 0, emitTime: 0, distanceAtEmit: 0 });
  }
  const thunderRecords = [];
  for (let index = 0; index < THUNDER_RECORDS; index++) {
    thunderRecords.push({
      used: false, emitTime: 0, arrivalTime: 0, distanceAtEmit: 0, distanceAtSchedule: 0, closingSpeed: 0,
      measuredDistance: NaN, measuredAt: NaN, intensity: 0, x: 0, y: 0, z: 0,
    });
  }
  let recordCursor = 0;
  const playingThunder = [];
  for (let index = 0; index < MAX_THUNDER_PLAYING; index++) playingThunder.push({ active: false, output: null, stopTime: 0, loudness: 0 });

  function trackOneShot(nodes, endSource) {
    counters.oneShotNodesLive += nodes.length;
    endSource.onended = () => {
      for (const node of nodes) node.disconnect();
      counters.oneShotNodesLive -= nodes.length;
    };
  }

  // ---- Voices ---------------------------------------------------------------------------------------
  function createVoice(recipe, params) {
    const spatial = resolveSpatial(recipe.spatial, params);
    const voice = {
      id: nextId++,
      recipe,
      params,
      spatial,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      lastPosition: new THREE.Vector3(),
      hasPosition: false,
      hasLastPosition: false,
      velocityGiven: false,
      intensity: clamp(params && Number.isFinite(params.intensity) ? params.intensity : 1, 0, 1),
      disposed: false,
      failed: false,
      realized: null,
      distance: Infinity,
      gain: 0,
      audibility: 0,
      score: 0,
      doppler: 1,
      cutoff: 20000,
      spread: 0,
      follow: null,
      handle: null,
    };
    voice.handle = createHandle(voice);
    voices.push(voice);
    counters.created++;
    return voice;
  }

  function createHandle(voice) {
    return Object.freeze({
      id: voice.id,
      recipe: voice.recipe.name,

      /** World position (m); velocity (m/s) is optional and otherwise derived from the motion. */
      setPosition(position, velocity) {
        if (voice.disposed || !position || !Number.isFinite(position.x + position.y + position.z)) return;
        voice.position.set(position.x, position.y, position.z);
        voice.hasPosition = true;
        if (velocity && Number.isFinite(velocity.x + velocity.y + velocity.z)) {
          voice.velocity.set(velocity.x, velocity.y, velocity.z);
          voice.velocityGiven = true;
        } else {
          voice.velocityGiven = false;
        }
      },

      /** 0..1; what it means is the recipe's (strength, flow, activity, approach, wind speed). */
      setIntensity(value) {
        if (voice.disposed || !Number.isFinite(value)) return;
        voice.intensity = clamp(value, 0, 1);
      },

      /** Fires a recipe trigger (see the recipe's triggers). Returns whether it sounded. */
      trigger(name, options) {
        if (voice.disposed) return false;
        if (voice.recipe.strikes && name === 'strike') return strikeFromVoice(voice, options ?? EMPTY_OPTIONS);
        if (!voice.realized || !env) return false;
        const fired = voice.realized.synth.trigger(name, options ?? EMPTY_OPTIONS, env.context.currentTime + TRIGGER_LEAD) === true;
        if (fired) counters.triggers++;
        return fired;
      },

      /** Fades the voice out and releases every node. The handle is inert afterwards. */
      dispose() {
        disposeVoice(voice);
      },

      /** Whether the voice has nodes right now (it is within the budget and audible). */
      get realized() {
        return voice.realized !== null;
      },

      get disposed() {
        return voice.disposed;
      },

      describe() {
        return describeVoice(voice);
      },
    });
  }

  function disposeVoice(voice) {
    if (voice.disposed) return;
    voice.disposed = true;
    if (voice.realized) release(voice, env ? env.context.currentTime : 0, 'disposed');
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    counters.disposed++;
  }

  function realize(voice, time) {
    try {
      voice.realized = buildVoiceGraph(env, voice, time);
    } catch (error) {
      voice.failed = true;
      counters.buildFailures++;
      onIssue(error);
      console.error(`[DRIFTWING] spawn voice "${voice.recipe.name}" failed to build; it stays silent`, error);
      return;
    }
    counters.nodesLive += voice.realized.nodeCount;
    counters.realizations++;
    applyPlacement(voice.realized, voice, time, 0.01);
  }

  function release(voice, time, reason) {
    const realized = voice.realized;
    voice.realized = null;
    const count = realized.nodeCount;
    realized.scaffold.stop(time, FADE_OUT, () => {
      counters.nodesLive -= count;
    });
    if (reason === 'budget') counters.culled++;
    else if (reason === 'inaudible') counters.faded++;
  }

  /**
   * The point distance metres from the listener at bearing (radians, 0 ahead, positive to the
   * right) and elevation (radians, positive up), in the listener's frame. Writes target.
   */
  function pointFromListener(distance, bearing, elevation, target) {
    const forward = listener.listenerForward;
    const up = listener.listenerUp;
    right.crossVectors(forward, up);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    else right.normalize();
    direction.copy(forward).multiplyScalar(Math.cos(bearing)).addScaledVector(right, Math.sin(bearing));
    direction.multiplyScalar(Math.cos(elevation)).addScaledVector(up, Math.sin(elevation));
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1);
    else direction.normalize();
    return target.copy(listener.listenerPosition).addScaledVector(direction, distance);
  }

  /** Audition voices ride with the listener at a fixed distance and bearing. */
  function placeFollower(voice) {
    const follow = voice.follow;
    pointFromListener(follow.distance, follow.bearing, follow.elevation, voice.position);
    voice.velocity.copy(listener.listenerVelocity);
    voice.hasPosition = true;
    voice.velocityGiven = true;
  }

  function measure(voice, elapsed) {
    if (voice.follow) placeFollower(voice);
    if (!voice.hasPosition || voice.failed) {
      voice.distance = Infinity;
      voice.gain = 0;
      voice.audibility = 0;
      voice.score = 0;
      return;
    }
    if (!voice.velocityGiven) {
      if (voice.hasLastPosition && elapsed > 0) {
        voice.velocity.copy(voice.position).sub(voice.lastPosition).divideScalar(elapsed);
        if (voice.velocity.lengthSq() > TELEPORT_SPEED * TELEPORT_SPEED) voice.velocity.set(0, 0, 0);
      } else {
        voice.velocity.set(0, 0, 0);
      }
    }
    voice.lastPosition.copy(voice.position);
    voice.hasLastPosition = true;
    const listenerPosition = listener.listenerPosition;
    voice.distance = voice.position.distanceTo(listenerPosition);
    voice.gain = distanceGain(voice.spatial, voice.distance);
    const recipe = voice.recipe;
    voice.audibility = recipe.level * (recipe.floor + (1 - recipe.floor) * voice.intensity) * voice.gain;
    voice.score = voice.audibility * (voice.realized ? REALIZED_BONUS : 1);
    voice.cutoff = absorptionCutoff(voice.distance, env.nyquist);
    voice.spread = spreadAt(voice.spatial.size, voice.distance);
    const target = dopplerFactor(listenerPosition, listener.listenerVelocity, voice.position, voice.velocity);
    voice.doppler += (target - voice.doppler) * DOPPLER_SMOOTHING;
  }

  /**
   * Sorts the voices by score, loudest first, into the reused ranked array (insertion sort). The
   * array only grows (when there are more voices than ever before) and is never truncated, so its
   * storage is reused; rankedCount says how many entries are current.
   */
  function rank() {
    while (ranked.length < voices.length) ranked.push(null);
    rankedCount = voices.length;
    for (let index = 0; index < rankedCount; index++) {
      const voice = voices[index];
      let slot = index;
      while (slot > 0 && ranked[slot - 1].score < voice.score) {
        ranked[slot] = ranked[slot - 1];
        slot--;
      }
      ranked[slot] = voice;
    }
    for (let index = rankedCount; index < ranked.length; index++) ranked[index] = null;
  }

  function updateVoices(time, interval, elapsed) {
    for (let index = 0; index < voices.length; index++) measure(voices[index], elapsed);
    rank();
    // Release first, so the budget is never exceeded while voices trade places.
    for (let index = 0; index < rankedCount; index++) {
      const voice = ranked[index];
      const keep = index < budget && voice.score >= AUDIBLE_FLOOR;
      if (!keep && voice.realized) release(voice, time, index >= budget ? 'budget' : 'inaudible');
    }
    for (let index = 0; index < rankedCount && index < budget; index++) {
      const voice = ranked[index];
      if (!voice.realized && voice.score >= AUDIBLE_FLOOR) realize(voice, time);
    }
    const timeConstant = interval / 3;
    for (let index = 0; index < voices.length; index++) {
      const voice = voices[index];
      const realized = voice.realized;
      if (!realized) continue;
      applyPlacement(realized, voice, time, timeConstant);
      if (realized.appliedIntensity !== voice.intensity) {
        realized.appliedIntensity = voice.intensity;
        realized.synth.setIntensity(voice.intensity, time, false);
      }
      if (realized.synth.update) realized.synth.update(time, interval);
    }
  }

  function updateInterior(frame, time) {
    const inside = frame.interior === true && frame.profile && frame.profile.interiorCutoff > 0;
    if (inside) glide(interiorFilter.frequency, frame.profile.interiorCutoff * 1.5, time, 0.12);
    else if (interiorActive) glide(interiorFilter.frequency, env.nyquist, time, 0.12);
    interiorActive = inside;
  }

  // ---- Thunder ----------------------------------------------------------------------------------------
  function strikeFromVoice(voice, options) {
    const position = options.position;
    if (position && Number.isFinite(position.x + position.y + position.z)) {
      strikePosition.set(position.x, position.y, position.z);
    } else if (voice.hasPosition) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * voice.spatial.size;
      strikePosition.set(voice.position.x + Math.cos(angle) * radius, voice.position.y, voice.position.z + Math.sin(angle) * radius);
    } else {
      return false;
    }
    const intensity = Number.isFinite(options.intensity) ? options.intensity : Math.max(voice.intensity, 0.3);
    return queueThunder(strikePosition, intensity);
  }

  function listenerDistance(x, y, z) {
    const position = listener.listenerPosition;
    const dx = x - position.x;
    const dy = y - position.y;
    const dz = z - position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function queueThunder(position, intensityValue) {
    if (!env) return false;
    const intensity = clamp(intensityValue, 0, 1.5);
    if (!(intensity > 0)) return false;
    const distance = listenerDistance(position.x, position.y, position.z);
    if (distance > MAX_THUNDER_DISTANCE) return false;
    let slot = null;
    for (let index = 0; index < thunderSlots.length; index++) {
      if (!thunderSlots[index].active) {
        slot = thunderSlots[index];
        break;
      }
    }
    if (!slot) {
      // Every slot is waiting: the farthest pending strike gives way to a nearer one.
      let farthest = thunderSlots[0];
      for (let index = 1; index < thunderSlots.length; index++) {
        if (thunderSlots[index].distanceAtEmit > farthest.distanceAtEmit) farthest = thunderSlots[index];
      }
      counters.thunderDropped++;
      if (farthest.distanceAtEmit <= distance) return false;
      slot = farthest;
    }
    slot.active = true;
    slot.x = position.x;
    slot.y = position.y;
    slot.z = position.z;
    slot.intensity = intensity;
    slot.emitTime = env.context.currentTime;
    slot.distanceAtEmit = distance;
    counters.thunderQueued++;
    return true;
  }

  /** A free playing slot, or the quietest one if the new strike is louder (it is faded out). */
  function claimPlayingSlot(time, loudness) {
    let quietest = null;
    for (let index = 0; index < playingThunder.length; index++) {
      const playing = playingThunder[index];
      if (playing.active && playing.stopTime <= time) playing.active = false;
      if (!playing.active) return playing;
      if (!quietest || playing.loudness < quietest.loudness) quietest = playing;
    }
    if (quietest.loudness >= loudness) return null;
    holdAt(quietest.output.gain, time);
    quietest.output.gain.setTargetAtTime(0, time, 0.08);
    return quietest;
  }

  function playThunder(slot, arrival, distance, closingSpeed, distanceAtSchedule) {
    const loudness = slot.intensity * distanceGain(THUNDER_SPATIAL, distance);
    const playing = claimPlayingSlot(arrival, loudness);
    if (!playing) {
      counters.thunderDropped++;
      return;
    }
    const strike = playThunderStrike({
      context: env.context,
      noise: env.noise,
      destination: submix,
      send: env.send,
      cutoff: absorptionCutoff(distance, env.nyquist),
      trackOneShot,
    }, { time: arrival, x: slot.x, y: slot.y, z: slot.z, distance, intensity: slot.intensity });
    playing.active = true;
    playing.output = strike.output;
    playing.stopTime = strike.stopTime;
    playing.loudness = loudness;
    counters.thunderPlayed++;
    const record = thunderRecords[recordCursor];
    recordCursor = (recordCursor + 1) % THUNDER_RECORDS;
    record.used = true;
    record.emitTime = slot.emitTime;
    record.arrivalTime = arrival;
    record.distanceAtEmit = slot.distanceAtEmit;
    record.distanceAtSchedule = distanceAtSchedule;
    record.closingSpeed = closingSpeed;
    record.measuredDistance = NaN;
    record.measuredAt = NaN;
    record.intensity = slot.intensity;
    record.x = slot.x;
    record.y = slot.y;
    record.z = slot.z;
  }

  function updateThunder(time, interval) {
    const velocity = listener.listenerVelocity;
    const position = listener.listenerPosition;
    for (let index = 0; index < thunderSlots.length; index++) {
      const slot = thunderSlots[index];
      if (!slot.active) continue;
      const distance = listenerDistance(slot.x, slot.y, slot.z);
      const closingSpeed = distance > 0.5
        ? (velocity.x * (slot.x - position.x) + velocity.y * (slot.y - position.y) + velocity.z * (slot.z - position.z)) / distance
        : 0;
      const wait = frontArrival(time - slot.emitTime, distance, closingSpeed);
      if (wait > interval * THUNDER_LOOKAHEAD) continue;
      slot.active = false;
      playThunder(slot, time + wait, Math.max(distance - closingSpeed * wait, 0), closingSpeed, distance);
    }
    // The listener's distance at the first update after each arrival (for the auditions and tests).
    for (let index = 0; index < thunderRecords.length; index++) {
      const record = thunderRecords[index];
      if (!record.used || !Number.isNaN(record.measuredAt) || time < record.arrivalTime) continue;
      record.measuredDistance = listenerDistance(record.x, record.y, record.z);
      record.measuredAt = time;
    }
  }

  // ---- Discovery chime --------------------------------------------------------------------------------
  function discoveryChime(options) {
    if (!env) return false;
    const context = env.context;
    const busName = options && options.bus === 'environment' ? 'environment' : 'ui';
    let pan = options && Number.isFinite(options.pan) ? clamp(options.pan, -1, 1) : 0;
    const position = options && options.position;
    if (position && Number.isFinite(position.x + position.y + position.z)) {
      direction.set(position.x, position.y, position.z).sub(listener.listenerPosition);
      const distance = direction.length();
      right.crossVectors(listener.listenerForward, listener.listenerUp);
      if (distance > 1 && right.lengthSq() > 1e-8) pan = clamp(direction.dot(right.normalize()) / distance, -1, 1) * 0.75;
    }
    const panner = new StereoPannerNode(context, { pan });
    panner.connect(env.mixer.input(busName));
    const send = new GainNode(context, { gain: 0.55 });
    panner.connect(send);
    send.connect(env.mixer.send(busName));
    const time = context.currentTime + 0.012;
    playDiscoveryChime({
      context,
      destination: panner,
      trackOneShot: (nodes, endSource) => trackOneShot([...nodes, panner, send], endSource),
    }, { time, volume: options && Number.isFinite(options.volume) ? options.volume : 0.5 });
    return true;
  }

  // ---- Diagnostics ------------------------------------------------------------------------------------
  function describeVoice(voice) {
    const realized = voice.realized;
    return {
      id: voice.id,
      recipe: voice.recipe.name,
      realized: realized !== null,
      disposed: voice.disposed,
      failed: voice.failed,
      intensity: voice.intensity,
      position: { x: voice.position.x, y: voice.position.y, z: voice.position.z },
      distance: voice.distance,
      distanceGain: voice.gain,
      audibility: voice.audibility,
      doppler: voice.doppler,
      cutoff: voice.cutoff,
      spread: voice.spread,
      spatial: { ...voice.spatial },
      nodes: realized ? realized.nodeCount : 0,
      panner: realized ? { x: realized.panner.positionX.value, y: realized.panner.positionY.value, z: realized.panner.positionZ.value } : null,
      dopplerCents: realized ? realized.doppler.offset.value : 0,
      synth: realized ? realized.synth.describe() : null,
    };
  }

  function describeThunderRecord(record) {
    const delay = record.arrivalTime - record.emitTime;
    // Where the front was when the listener's distance was measured, against that distance.
    const frontError = Number.isNaN(record.measuredAt)
      ? null
      : record.measuredDistance + record.closingSpeed * (record.measuredAt - record.arrivalTime) - SPEED_OF_SOUND * delay;
    return {
      emitTime: record.emitTime,
      arrivalTime: record.arrivalTime,
      delay,
      staticDelay: record.distanceAtEmit / SPEED_OF_SOUND,
      distanceAtEmit: record.distanceAtEmit,
      frontRadius: SPEED_OF_SOUND * delay,
      closingSpeed: record.closingSpeed,
      measuredDistance: Number.isNaN(record.measuredDistance) ? null : record.measuredDistance,
      measuredAt: Number.isNaN(record.measuredAt) ? null : record.measuredAt,
      frontError,
      intensity: record.intensity,
    };
  }

  function describe() {
    let realizedCount = 0;
    for (let index = 0; index < voices.length; index++) if (voices[index].realized) realizedCount++;
    let pending = 0;
    for (let index = 0; index < thunderSlots.length; index++) if (thunderSlots[index].active) pending++;
    let playing = 0;
    const time = env ? env.context.currentTime : 0;
    for (let index = 0; index < playingThunder.length; index++) if (playingThunder[index].active && playingThunder[index].stopTime > time) playing++;
    return {
      voices: voices.length,
      realized: realizedCount,
      virtual: voices.length - realizedCount,
      budget,
      ...counters,
      thunderPending: pending,
      thunderPlaying: playing,
      interior: interiorActive,
    };
  }

  /** The recorded strikes, oldest first (the last THUNDER_RECORDS). */
  function thunderLog() {
    const log = [];
    for (let offset = 0; offset < THUNDER_RECORDS; offset++) {
      const record = thunderRecords[(recordCursor + offset) % THUNDER_RECORDS];
      if (record.used) log.push(describeThunderRecord(record));
    }
    return log;
  }

  return {
    recipes: RECIPE_NAMES,

    /** Connects to the audio graph once the AudioContext exists (buildGraph in AudioEngine.js). */
    attach({ context, noise, mixer, spatializer }) {
      const nyquist = context.sampleRate / 2;
      submix = context.createGain();
      interiorFilter = new BiquadFilterNode(context, { type: 'lowpass', frequency: nyquist, Q: 0.6 });
      submix.connect(interiorFilter);
      interiorFilter.connect(mixer.input('environment'));
      env = { context, noise, mixer, destination: submix, send: mixer.send('environment'), nyquist, trackOneShot };
      listener = spatializer;
      lastUpdateRealTime = null;
    },

    /** Called at the parameter interval after the spatializer has placed the listener. */
    update(frame) {
      if (!env) return;
      const elapsed = lastUpdateRealTime === null ? 0 : frame.realTime - lastUpdateRealTime;
      lastUpdateRealTime = frame.realTime;
      updateInterior(frame, frame.time);
      updateVoices(frame.time, frame.interval, elapsed);
      updateThunder(frame.time, frame.interval);
    },

    spawnVoice(recipeName, params) {
      const recipe = recipeByName(recipeName);
      return createVoice(recipe, params && typeof params === 'object' ? params : EMPTY_OPTIONS).handle;
    },

    thunder(options) {
      const position = options && options.position;
      if (!position || !Number.isFinite(position.x + position.y + position.z)) return false;
      if (!listener) return false;
      return queueThunder(position, options && Number.isFinite(options.intensity) ? options.intensity : 1);
    },

    discoveryChime,

    /** Audition: a voice that rides with the listener at distance (m), bearing and elevation (deg). */
    audition(recipeName, options) {
      const recipe = recipeByName(recipeName);
      const params = options && options.params && typeof options.params === 'object' ? options.params : EMPTY_OPTIONS;
      const voice = createVoice(recipe, params);
      voice.follow = { distance: 0, bearing: 0, elevation: 0 };
      this.setAuditionPlacement(voice.handle, options);
      if (options && Number.isFinite(options.intensity)) voice.intensity = clamp(options.intensity, 0, 1);
      return voice.handle;
    },

    /** Moves an audition voice: { distance, bearing, elevation } (m, degrees; bearing 0 = ahead). */
    setAuditionPlacement(handle, options) {
      const voice = voices.find((candidate) => candidate.handle === handle);
      if (!voice || !voice.follow) return false;
      const follow = voice.follow;
      if (options && Number.isFinite(options.distance)) follow.distance = Math.max(0, options.distance);
      if (options && Number.isFinite(options.bearing)) follow.bearing = (options.bearing * Math.PI) / 180;
      if (options && Number.isFinite(options.elevation)) follow.elevation = (options.elevation * Math.PI) / 180;
      return true;
    },

    /**
     * Audition: a strike from the point distance metres from the listener at bearing and elevation
     * (degrees), fixed in the world from now on. Returns whether it was queued.
     */
    thunderFromListener(options) {
      if (!listener) return false;
      const distance = options && Number.isFinite(options.distance) ? Math.max(options.distance, 0) : 1000;
      const bearing = options && Number.isFinite(options.bearing) ? (options.bearing * Math.PI) / 180 : 0;
      const elevation = options && Number.isFinite(options.elevation) ? (options.elevation * Math.PI) / 180 : 0;
      pointFromListener(distance, bearing, elevation, strikePosition);
      return queueThunder(strikePosition, options && Number.isFinite(options.intensity) ? options.intensity : 1);
    },

    /** Every live voice's handle. */
    handles() {
      return voices.map((voice) => voice.handle);
    },

    setBudget(value) {
      budget = Math.round(clamp(Number.isFinite(value) ? value : DEFAULT_VOICE_BUDGET, 1, MAX_VOICE_BUDGET));
      return budget;
    },

    describe,
    describeVoices() {
      return voices.map(describeVoice);
    },
    thunderLog,
  };
}
