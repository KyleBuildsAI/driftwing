// A course rival (Phase 3, preset 70 the dragon racer): a creature that races a structure's challenge
// course. The recipe hands the structure engine out.rival = { points (local xyz: the racing line from
// the creature's perch through the course), name, scale, paceTime, rivalTime, achievement }; the
// engine makes one of these per instance (createCourseRival) instead of registering the course itself.
//
// The racing line is a PathFollower path (src/world/pathFollower.js) with two followers in 'once' mode,
// both timed from the run's start (the challenge system's live elapsed time):
//   pace    reaches the finish gate in paceTime: the creature leads any craft round the course
//   rival   reaches it in rivalTime: when the player flies the dragon skin the course is registered
//           with this follower as its `rival` (contract f.1), so the challenge HUD shows the gap; the
//           creature roars and breathes fire as it launches, and beating it to the finish earns the
//           recipe's achievement
// The course is registered once and registered again (same key: the records stay) whenever the
// player's craft changes between dragon and not, but never while a run on it is armed or running.
//
// The creature: the dragon craft's own mesh (src/craft/eagleMeshes.js buildDragonMesh, its shared
// craft materials) scaled up, driven through the same visual state the craft writes: perched on its
// crag (wings folded, the head looking about), flapping as it climbs, tucking as it dives, banking into
// its turns. After a run (finished, cancelled or done) it flies back to its perch on a return path made
// at that moment (an event; the frame update allocates nothing). The model is the structure engine's
// one shared rival model (createRivalModel, built and prewarmed in its init, so a create neither
// builds geometry nor compiles a pipeline); the rival borrows it and hides it again on dispose.
// Without it (the node labs, or a second rival while one holds it) the course still registers and
// races, unseen.
import { createPath, createPathFollower } from '../../../world/pathFollower.js';
import { FEET, buildDragonMesh } from '../../../craft/eagleMeshes.js';
import { applyRigidDrop } from '../../../render/curvature.js';

const DEG = Math.PI / 180;
/** The flight back to the perch after a run (m/s), and how high it arcs over the straight line (m). */
const RETURN_SPEED = 24;
const RETURN_ARC = 60;
/** Seconds of fire breath as the rival launches. */
const LAUNCH_FIRE = 1.6;
/** Bank (rad) per turn rate (rad/s), and its limit. */
const BANK_GAIN = 0.9;
const BANK_LIMIT = 1.05;
const MODE_PERCHED = 0;
const MODE_RACING = 1;
const MODE_RETURNING = 2;

/** True when the player flies the dragon skin of the eagle craft. */
function playerIsDragon(state) {
  const flight = state.flight;
  return Boolean(flight && flight.craft === 'eagle' && flight.craftState && flight.craftState.skin === 'dragon');
}

/**
 * The shared rival model: the dragon craft's mesh, hidden, in the scene (the engine builds it once in
 * init and registers it for the pipeline prewarm). game: the game context (its uniforms and craft
 * materials). Returns the mesh ({ root, update(visual, dt), dispose() }) or null without a game context.
 */
export function createRivalModel(game, scene) {
  if (!game || !game.uniforms) return null;
  const model = buildDragonMesh(game);
  model.root.name = 'structure-rival';
  model.root.visible = false;
  scene.add(model.root);
  return model;
}

/**
 * The rival of one structure instance. ctx: the engine context; THREE: the engine's three; anchor:
 * the instance anchor (world); spec: out.rival; definition: out.challenge (world, unregistered);
 * owner: the registration owner; model: the shared rival model to fly, or null; onRoar(): the launch
 * roar (the engine sends the voice trigger).
 * Returns { courseKey, position (world, live), update(dt), setVisible(visible), dispose(), describe() }.
 */
export function createCourseRival(ctx, THREE, { anchor, spec, definition, owner, model = null, onRoar }) {
  const challenges = ctx.game?.systems?.challenges ?? null;
  const local = spec.points;
  if (!Array.isArray(local) || local.length < 6 || local.length % 3 !== 0) throw new Error(`[DRIFTWING] structure rival "${definition.id}": out.rival.points must hold at least two xyz points`);
  const points = new Float64Array(local.length);
  for (let index = 0; index < local.length; index += 3) {
    points[index] = anchor.x + local[index];
    points[index + 1] = anchor.y + local[index + 1];
    points[index + 2] = anchor.z + local[index + 2];
  }
  const path = createPath({ points, closed: false, smoothing: 'catmullRom', samplesPerSegment: 16 });
  const finish = definition.gates[definition.gates.length - 1].center;
  const finishAlong = path.nearestDistance(finish.x, finish.y, finish.z);
  const paceFollower = createPathFollower({ path, speed: finishAlong / spec.paceTime, mode: 'once' });
  const rivalFollower = createPathFollower({ path, speed: finishAlong / spec.rivalTime, mode: 'once' });
  const courseRival = { follower: rivalFollower, path, name: spec.name };
  const perch = new THREE.Vector3(points[0], points[1] - 2, points[2]);
  const perchHeading = Math.atan2(points[3] - points[0], -(points[5] - points[2])) / DEG;

  let courseKey = null;
  let registeredRival = false;
  /** The run being raced: whether it is against the rival follower (the player is a dragon). */
  let raceRival = false;
  let mode = MODE_PERCHED;
  let follower = paceFollower;
  let returnFollower = null;
  let returnStart = 0;
  let fire = 0;
  let launches = 0;
  let beaten = 0;
  const time = new Float64Array(1);
  const at = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, heading: 0, distance: 0, speed: 0, done: false };
  const position = new THREE.Vector3().copy(perch);
  let heading = perchHeading;
  let bank = 0;

  function register(withRival) {
    if (!challenges || typeof challenges.register !== 'function') return;
    courseKey = challenges.register(withRival ? { ...definition, rival: courseRival } : definition, { owner });
    registeredRival = withRival;
  }
  register(playerIsDragon(ctx.state));

  // ---- The creature ---------------------------------------------------------------------------------
  let visible = true;
  const visual = {
    craftState: { flapPhase: 0, flapAmplitude: 0, wingTuck: 0, landing: 0, perched: true, perchedSeconds: 0, screechCount: 0, roarCount: 0, fireIntensity: 0 },
    time: ctx.time,
    aileron: 0,
    elevator: 0,
    rudder: 0,
    onGround: false,
  };
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  if (model) {
    model.root.scale.setScalar(spec.scale);
    model.root.visible = true;
  }

  const offFinished = ctx.bus && typeof ctx.bus.onTyped === 'function'
    ? ctx.bus.onTyped('challengeFinished', (payload) => {
      if (payload.id !== courseKey || !raceRival || !payload.valid || !(payload.time < spec.rivalTime)) return;
      beaten++;
      if (spec.achievement) ctx.bus.emitTyped('achievement', { id: spec.achievement.id, title: spec.achievement.title });
    })
    : null;

  /** Leaves the race (finished, cancelled, or the line run out): a return path from here to the perch. */
  function startReturn() {
    const midX = (position.x + perch.x) / 2;
    const midZ = (position.z + perch.z) / 2;
    const midY = Math.max(position.y, perch.y) + RETURN_ARC;
    const returnPath = createPath({ points: new Float64Array([position.x, position.y, position.z, midX, midY, midZ, perch.x, perch.y + 2, perch.z]), closed: false, smoothing: 'catmullRom' });
    returnFollower = createPathFollower({ path: returnPath, speed: RETURN_SPEED, mode: 'once' });
    returnStart = ctx.time.elapsed;
    mode = MODE_RETURNING;
  }

  function launch() {
    raceRival = registeredRival;
    follower = raceRival ? rivalFollower : paceFollower;
    mode = MODE_RACING;
    launches++;
    if (raceRival) {
      visual.craftState.roarCount++;
      fire = LAUNCH_FIRE;
      if (typeof onRoar === 'function') onRoar();
    }
  }

  /** Flies the model along `at` (a follower sample) this frame. */
  function fly(dt) {
    const craftState = visual.craftState;
    position.set(at.x, at.y, at.z);
    const nextHeading = at.heading;
    let turn = nextHeading - heading;
    turn -= Math.round(turn / 360) * 360;
    heading = nextHeading;
    const turnRate = dt > 0 ? (turn * DEG) / dt : 0;
    const targetBank = Math.max(-BANK_LIMIT, Math.min(BANK_LIMIT, -turnRate * BANK_GAIN));
    bank += (targetBank - bank) * Math.min(1, dt * 3);
    const climb = at.ty;
    craftState.perched = false;
    craftState.perchedSeconds = 0;
    craftState.wingTuck = climb < -0.2 ? Math.min(0.6, (-climb - 0.2) * 2) : 0;
    craftState.flapAmplitude = Math.max(0.15, Math.min(1, 0.4 + climb * 2.5));
    craftState.flapPhase = (craftState.flapPhase + dt * (1 + 0.7 * craftState.flapAmplitude)) % 1;
    visual.elevator = Math.max(-1, Math.min(1, climb * 2));
    visual.aileron = Math.max(-1, Math.min(1, -bank));
    euler.set(Math.asin(Math.max(-1, Math.min(1, climb))), -heading * DEG, bank, 'YXZ');
  }

  function sit(dt) {
    const craftState = visual.craftState;
    position.set(perch.x, perch.y + FEET * spec.scale, perch.z);
    heading = perchHeading;
    bank = 0;
    craftState.perched = true;
    craftState.perchedSeconds += dt;
    craftState.flapAmplitude = 0;
    craftState.wingTuck = 1;
    visual.elevator = 0;
    visual.aileron = 0;
    euler.set(0, -perchHeading * DEG, 0, 'YXZ');
  }

  return {
    get courseKey() {
      return courseKey;
    },
    position,

    update(dt) {
      const live = challenges && typeof challenges.getState === 'function' ? challenges.getState() : null;
      const ours = live !== null && courseKey !== null && live.courseKey === courseKey;
      const running = ours && live.phase === 'running';
      // Between runs the course follows the player's craft: a rival only for a dragon.
      if (!ours || live.phase === null || live.phase === 'finished') {
        const dragon = playerIsDragon(ctx.state);
        if (dragon !== registeredRival && courseKey !== null) register(dragon);
      }
      // A run starting while it flies home launches it again from the line's start (its perch).
      if (mode !== MODE_RACING && running) launch();
      if (mode === MODE_RACING) {
        time[0] = running ? live.elapsed : 0;
        if (running) follower.atFrom(time, 0, at);
        if (!running || at.done) startReturn();
        else fly(dt);
      }
      if (mode === MODE_RETURNING) {
        time[0] = ctx.time.elapsed - returnStart;
        returnFollower.atFrom(time, 0, at);
        if (at.done) {
          mode = MODE_PERCHED;
          returnFollower = null;
        } else {
          fly(dt);
        }
      }
      if (mode === MODE_PERCHED) sit(dt);
      fire = Math.max(0, fire - dt);
      visual.craftState.fireIntensity = fire > 0 ? Math.min(1, fire / 0.4) : 0;
      if (!model) return;
      model.root.position.copy(position);
      model.root.quaternion.setFromEuler(euler);
      applyRigidDrop(ctx, model.root, position.y);
      model.update(visual, dt);
    },

    setVisible(show) {
      visible = show;
      if (model) model.root.visible = show;
    },

    dispose() {
      if (offFinished) offFinished();
      if (model) {
        model.root.visible = false;
        visual.craftState.fireIntensity = 0;
        // One more pose with the fire out returns the borrowed light.
        model.update(visual, 0);
      }
    },

    describe() {
      return { mode: ['perched', 'racing', 'returning'][mode], rival: registeredRival, launches, beaten, finishAlong, model: model !== null, visible };
    },
  };
}
