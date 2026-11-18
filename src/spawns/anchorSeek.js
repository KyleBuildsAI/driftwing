// Anchor seeks (preset.anchor.seek): where the SpawnManager moves an event's activation before its
// engines see it. One search serves every seek: a coarse grid over the disc of anchor.radius around
// the activation, then the best few samples climb their score in strides halving down to a minimum,
// and the best climbed point wins. The seeks differ only in what they score:
//
//   peak       the ground height (the highest ground in reach; a lenticular's summit, the bats' crag)
//   valley     the valley depth on DRY ground (at least VALLEY_DRY_MARGIN m above the water level):
//              how far the ground rises in all but VALLEY_LOWER_ALLOWED of the VALLEY_RING_SAMPLES
//              directions of a ring VALLEY_RING_RADIUS out (the ring's third lowest ground less the
//              ground at the point). A coastal plain's lowest dry ground is its beach, whose ring holds
//              the sea and scores low; a valley floor's ring holds both its slopes and scores high, and
//              may fall away down the valley in two directions; a hollow on a mountain's flank, whose
//              ring falls away on half its sides under the summit's mass, scores low (a migration's
//              valley)
//   openWater  the share of sea in the disc OPEN_WATER_DISC around a point of the sea: the most open
//              water in reach (the hurricane's eye; the generated worlds' seas are archipelagos, so the
//              sea-iest point of reach is the open ocean the world has)
//
// A seek is a job that can run in slices: step(job, budget) spends at most budget ground probes and
// returns what it did not spend, so the SpawnManager spreads a director activation's seek over the
// frames before it (a valley seek reads about 4000 ground heights, 13-27 ms in one frame), and
// run(job) finishes one at once (a debug spawn, a test). The slices never change the answer: a job
// visits the same points in the same order however it is cut, and the answer is the one the
// unsliced search gives. A job's numbers live in typed arrays (no boxed doubles while it steps), and a
// job allocates only when it starts.

/** The peak seek: grid samples a side, climbing samples, smallest stride (m). */
const PEAK = Object.freeze({ grid: 25, climbs: 4, minStride: 8 });
/** The valley seek: a sparser grid and coarser strides (a herd's valley floor needs no metre precision). */
const VALLEY = Object.freeze({ grid: 13, climbs: 3, minStride: 40 });
/** The open-water seek: a sea's openness changes over kilometres, so a coarse grid and strides. */
const OPEN_WATER = Object.freeze({ grid: 9, climbs: 2, minStride: 500 });
const SEEK_SETTINGS = Object.freeze({ peak: PEAK, valley: VALLEY, openWater: OPEN_WATER });
/** A valley floor stands at least this far (m) above the water level: not its lake or the sea. */
export const VALLEY_DRY_MARGIN = 4;
export const VALLEY_RING_RADIUS = 450;
const VALLEY_RING_SAMPLES = 8;
/** Ring directions a valley floor may fall away in (down the valley, both ways). */
const VALLEY_LOWER_ALLOWED = 2;
/** The open-water seek's disc (m): a hurricane's eyewall reach, the sea the eye and its wall stand on. */
export const OPEN_WATER_DISC = 5000;
/** Its probe rings: ring k (1..OPEN_WATER_RINGS) at k / OPEN_WATER_RINGS of the disc, 8 k probes. */
const OPEN_WATER_RINGS = 3;
/** Probes of one open-water score: the rings plus the centre. */
const OPEN_WATER_PROBES = 1 + 4 * OPEN_WATER_RINGS * (OPEN_WATER_RINGS + 1);
const TWO_PI = Math.PI * 2;

const PHASE_GRID = 0;
const PHASE_CLIMB = 1;
const PHASE_DONE = 2;
// job.state slots.
const S_X = 0;
const S_Z = 1;
const S_RADIUS = 2;
const S_STEP = 3;
const S_INDEX = 4;
const S_COUNT = 5;
const S_CLIMB = 6;
const S_STRIDE = 7;
const S_DIRECTION = 8;
const S_MOVED = 9;
const S_CUR_X = 10;
const S_CUR_Z = 11;
const S_CUR_Y = 12;
const S_CUR_SCORE = 13;
const S_BEST_X = 14;
const S_BEST_Z = 15;
const S_BEST_Y = 16;
const S_BEST_SCORE = 17;
const S_EVAL_Y = 18;
const S_PROBES = 19;
const STATE_SIZE = 20;
// A grid sample's slots in job.samples.
const SAMPLE_SIZE = 4;

/**
 * The anchor seeks over a world ({ groundHeight(x, z), WATER_LEVEL }). Returns { start, step, run }.
 */
export function createAnchorSeeks(world) {
  const waterLevel = world.WATER_LEVEL;
  /** A valley score's ring heights, kept sorted as they are read (no allocation per probe). */
  const ringHeights = new Float64Array(VALLEY_RING_SAMPLES);

  /**
   * A new seek job: kind 'peak' | 'valley' | 'openWater' over the disc of radius around (x, z). The
   * answer, once job.phase is done: job.found (false when the disc held no valid point: no dry ground
   * for a valley, no sea for open water) and job.x, job.y, job.z (y the ground, or for open water the
   * water level; a peak's ground is never below the water level).
   */
  function start(kind, x, z, radius) {
    const settings = SEEK_SETTINGS[kind];
    if (!settings) throw new RangeError(`[DRIFTWING] anchor seek: unknown seek "${kind}"`);
    const state = new Float64Array(STATE_SIZE);
    state[S_X] = x;
    state[S_Z] = z;
    state[S_RADIUS] = radius;
    state[S_STEP] = (2 * radius) / (settings.grid - 1);
    return {
      kind,
      settings,
      phase: PHASE_GRID,
      state,
      samples: new Float64Array(settings.grid * settings.grid * SAMPLE_SIZE),
      /** The grid samples that climb, best first (stable: ties keep the grid's order). */
      climbers: new Int32Array(settings.climbs),
      found: false,
      x,
      y: 0,
      z,
    };
  }

  function inside(state, x, z) {
    const dx = x - state[S_X];
    const dz = z - state[S_Z];
    return dx * dx + dz * dz <= state[S_RADIUS] * state[S_RADIUS];
  }

  /**
   * The job's score at (x, z) (state[S_EVAL_Y] its ground, or the water level), or NaN where the seek
   * cannot stand. Counts its ground probes in state[S_PROBES].
   */
  function score(job, x, z) {
    const state = job.state;
    const ground = world.groundHeight(x, z);
    state[S_PROBES] += 1;
    state[S_EVAL_Y] = ground;
    if (job.kind === 'peak') return ground;
    if (job.kind === 'valley') {
      if (ground <= waterLevel + VALLEY_DRY_MARGIN) return NaN;
      for (let index = 0; index < VALLEY_RING_SAMPLES; index++) {
        const angle = (index / VALLEY_RING_SAMPLES) * Math.PI * 2;
        const height = world.groundHeight(x + Math.sin(angle) * VALLEY_RING_RADIUS, z - Math.cos(angle) * VALLEY_RING_RADIUS);
        let slot = index;
        while (slot > 0 && ringHeights[slot - 1] > height) {
          ringHeights[slot] = ringHeights[slot - 1];
          slot--;
        }
        ringHeights[slot] = height;
      }
      state[S_PROBES] += VALLEY_RING_SAMPLES;
      return ringHeights[VALLEY_LOWER_ALLOWED] - ground;
    }
    // openWater: the share of sea in the disc around a point of the sea.
    if (ground >= waterLevel) return NaN;
    state[S_EVAL_Y] = waterLevel;
    let sea = 1;
    for (let ring = 1; ring <= OPEN_WATER_RINGS; ring++) {
      const reach = (OPEN_WATER_DISC * ring) / OPEN_WATER_RINGS;
      const count = 8 * ring;
      for (let index = 0; index < count; index++) {
        const angle = (index / count) * TWO_PI + ring * 0.3;
        if (world.groundHeight(x + Math.sin(angle) * reach, z - Math.cos(angle) * reach) < waterLevel) sea++;
      }
    }
    state[S_PROBES] += OPEN_WATER_PROBES - 1;
    return sea / OPEN_WATER_PROBES;
  }

  /** Ends the grid: picks the climbers (best scores, stable) and the first best, or finishes empty. */
  function endGrid(job) {
    const state = job.state;
    const samples = job.samples;
    const count = state[S_COUNT];
    if (count === 0) {
      finish(job, false);
      return;
    }
    const climbs = Math.min(job.settings.climbs, count);
    for (let rank = 0; rank < climbs; rank++) {
      let pick = -1;
      for (let index = 0; index < count; index++) {
        let taken = false;
        for (let earlier = 0; earlier < rank; earlier++) if (job.climbers[earlier] === index) taken = true;
        if (taken) continue;
        if (pick < 0 || samples[index * SAMPLE_SIZE + 3] > samples[pick * SAMPLE_SIZE + 3]) pick = index;
      }
      job.climbers[rank] = pick;
    }
    const first = job.climbers[0] * SAMPLE_SIZE;
    state[S_BEST_X] = samples[first];
    state[S_BEST_Z] = samples[first + 1];
    state[S_BEST_Y] = samples[first + 2];
    state[S_BEST_SCORE] = samples[first + 3];
    state[S_CLIMB] = 0;
    job.phase = PHASE_CLIMB;
    startClimb(job);
  }

  /** Starts climber state[S_CLIMB] from its grid sample at the grid's stride. */
  function startClimb(job) {
    const state = job.state;
    const offset = job.climbers[state[S_CLIMB]] * SAMPLE_SIZE;
    state[S_CUR_X] = job.samples[offset];
    state[S_CUR_Z] = job.samples[offset + 1];
    state[S_CUR_Y] = job.samples[offset + 2];
    state[S_CUR_SCORE] = job.samples[offset + 3];
    state[S_STRIDE] = state[S_STEP];
    state[S_DIRECTION] = 0;
    state[S_MOVED] = 0;
  }

  /** Ends the current climb (a better summit becomes the best) and starts the next, or finishes. */
  function endClimb(job) {
    const state = job.state;
    if (state[S_CUR_SCORE] > state[S_BEST_SCORE]) {
      state[S_BEST_X] = state[S_CUR_X];
      state[S_BEST_Z] = state[S_CUR_Z];
      state[S_BEST_Y] = state[S_CUR_Y];
      state[S_BEST_SCORE] = state[S_CUR_SCORE];
    }
    state[S_CLIMB] += 1;
    if (state[S_CLIMB] >= Math.min(job.settings.climbs, state[S_COUNT])) finish(job, true);
    else startClimb(job);
  }

  function finish(job, found) {
    const state = job.state;
    job.phase = PHASE_DONE;
    job.found = found;
    if (found) {
      job.x = state[S_BEST_X];
      job.z = state[S_BEST_Z];
      job.y = job.kind === 'peak' ? Math.max(state[S_BEST_Y], waterLevel) : state[S_BEST_Y];
    } else if (job.kind === 'peak') {
      // A disc too small for one grid sample: the activation's own ground.
      job.found = true;
      job.y = Math.max(world.groundHeight(state[S_X], state[S_Z]), waterLevel);
    }
  }

  /** One grid sample (index state[S_INDEX]). */
  function gridStep(job) {
    const state = job.state;
    const grid = job.settings.grid;
    const index = state[S_INDEX];
    state[S_INDEX] = index + 1;
    const row = Math.floor(index / grid);
    const column = index - row * grid;
    const x = state[S_X] - state[S_RADIUS] + column * state[S_STEP];
    const z = state[S_Z] - state[S_RADIUS] + row * state[S_STEP];
    if (inside(state, x, z)) {
      const value = score(job, x, z);
      if (!Number.isNaN(value)) {
        const offset = state[S_COUNT] * SAMPLE_SIZE;
        job.samples[offset] = x;
        job.samples[offset + 1] = z;
        job.samples[offset + 2] = state[S_EVAL_Y];
        job.samples[offset + 3] = value;
        state[S_COUNT] += 1;
      }
    }
    if (state[S_INDEX] >= grid * grid) endGrid(job);
  }

  /** One climbing probe: the next of the eight directions at the current stride. */
  function climbStep(job) {
    const state = job.state;
    if (state[S_STRIDE] < job.settings.minStride) {
      endClimb(job);
      return;
    }
    if (state[S_DIRECTION] >= 8) {
      // A pass that moved repeats at this stride; a still one halves it.
      if (state[S_MOVED] === 0) state[S_STRIDE] /= 2;
      state[S_DIRECTION] = 0;
      state[S_MOVED] = 0;
      return;
    }
    const angle = (state[S_DIRECTION] / 8) * Math.PI * 2;
    state[S_DIRECTION] += 1;
    const x = state[S_CUR_X] + Math.cos(angle) * state[S_STRIDE];
    const z = state[S_CUR_Z] + Math.sin(angle) * state[S_STRIDE];
    if (!inside(state, x, z)) return;
    const value = score(job, x, z);
    if (value > state[S_CUR_SCORE]) {
      state[S_CUR_X] = x;
      state[S_CUR_Z] = z;
      state[S_CUR_Y] = state[S_EVAL_Y];
      state[S_CUR_SCORE] = value;
      state[S_MOVED] = 1;
    }
  }

  /**
   * Runs the job until it is done or it has spent budget ground probes (a step may overrun by one
   * score's probes). Returns the budget left (0 when spent).
   */
  function step(job, budget) {
    const state = job.state;
    const limit = state[S_PROBES] + budget;
    while (job.phase !== PHASE_DONE && state[S_PROBES] < limit) {
      if (job.phase === PHASE_GRID) gridStep(job);
      else climbStep(job);
    }
    return job.phase === PHASE_DONE ? Math.max(0, limit - state[S_PROBES]) : 0;
  }

  /** Finishes the job at once. */
  function run(job) {
    while (job.phase !== PHASE_DONE) {
      if (job.phase === PHASE_GRID) gridStep(job);
      else climbStep(job);
    }
    return job;
  }

  return { start, step, run };
}

/** Whether a seek job has its answer. */
export function seekDone(job) {
  return job.phase === PHASE_DONE;
}

/** Ground probes a job has spent so far. */
export function seekProbes(job) {
  return job.state[S_PROBES];
}
