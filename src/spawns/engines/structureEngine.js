// StructureEngine ('structure', contract section 3): procedural low-poly builds from parametric
// recipes (src/spawns/engines/structure/recipes/): wind farms, rope bridges, airfields, floating
// islands, crystal spires and timed gate courses. docs/engines/structure.md lists every param.
//
// Per instance the recipe fills up to five geometries in the instance's local frame (metres from its
// anchor), each shown on a pooled mesh (pools.js explains why meshes are pooled):
//   body     solid, flat-shaded, v1 palette; casts shadows at the near tier
//   detail   small props (ropes, weeds, crates, lights), near tier only
//   decal    ground paint (runway tarmac and markings), polygon-offset over the terrain
//   glow     crystal (emissive, pulsing in the shader, brighter at night)
//   water    waterfall ribbons and streams (transparent streaks scrolling in the shader)
//   cloth    flags and banners (Phase 3): each vertex's sway value is its hang (m from the edge it is
//            tied to); the cloth swings out downwind and ripples with the WindField wind the
//            structure shows (the monastery's prayer flags, the castle's banners)
// Moving parts are shared instanced meshes built once in init(): turbine nacelles and rotors (yawed
// into the real WindField wind, spun with its speed), windsock segments (a chain hanging in the wind)
// and mist puffs (soft luminous blobs). The sway weight in the geometry lets the bridge deck, ropes,
// pennants and tree tops swing with the wind in the vertex shader.
//
// Phase 3 recipe features (all optional; a recipe that fills none of them builds exactly as before):
//   movers       context.addMover(): parts with their own geometry on pooled meshes, posed every frame
//                by the recipe's out.animate(state, env) hook (a train on its viaduct, an observatory's
//                dome and telescope, a fireball's glowing scar), with optional box colliders that
//                follow them (setPose)
//   steam        out.steam dynamic puffs on the shared mist pool, placed by the animate hook (a
//                locomotive's chimney)
//   torches      out.torches: flames on a shared instanced pool, each an ignitable (ctx.game.ignition)
//                the dragon's breath can light, optionally lit at dusk (instance.ignitableIds)
//   blocks       out.blocks: boxes on a shared instanced pool with instance colours (the labyrinth's
//                hedge walls)
//
// Generic features any recipe or preset uses:
//   stamps       structure/stamps.js structureStamps(recipe, options): the terrain stamps a recipe
//                builds on, as preset data (placement resolves them on both threads; the recipe reads
//                the resolved stamp from params.site)
//   gates       pass-under / pass-through gates (gateDetector.js): 'structure:gate' events, optional
//                achievements, crystal chimes, timed courses ('structure:course')
//   landing      runway zones grade touchdowns ('structure:landing' and a toast)
//   surfaces     landable tops registered as extra ground surfaces (src/world/groundSurfaces.js); with
//                the game's collider service the island tops are landable heightfield colliders
//   colliders    the recipes' solid parts (out.colliders, structure/colliders.js) registered with
//                ctx.game.colliders (instance.colliderIds); turbine nacelles and rotors turn with yaw
//   groundStart  engine.groundStart(preset, params, site): ground-start spots a discovered site offers
//   wind         the wind farm's wake turbulence source (removed at the far tier, where the player is
//                kilometres from it and cannot fly through the wake)
//   audio        preset.audio as a spawn voice, driven by approach, wind or a constant level
//   setParam     glow, sway, rotorSpeed and audio multipliers the set-piece engine can ramp
//
// update() allocates nothing: per-instance numbers live in typed arrays, matrices are composed into
// scratch objects made in init(), and the wind is probed a few times a second into a reused record.
import { createMeshBuilder } from './structure/meshBuilder.js';
import { PALETTE, paint } from './structure/palette.js';
import { RECIPES, RECIPE_NAMES } from './structure/recipes/index.js';
import { islandOutline, islandTopHeight } from './structure/recipes/islands.js';
import { GATE_TELEPORT_DISTANCE, createGateSet, crossGates } from './gateDetector.js';
import { createParamView, createWindSample, ownsPresetAudio } from './engineKit.js';
import { applyRigidDrop, rigidCurvatureDrop } from '../../render/curvature.js';
import { addStructureColliders, islandTopCollider, removeStructureColliders, updateTurbineColliders } from './structure/colliders.js';

const ENGINE_NAME = 'structure';
/** Structure spawns alive at once (the director's cap is the same). */
const MAX_INSTANCES = 24;
const TURBINE_CAPACITY = 256;
const SOCK_SEGMENTS = 5;
const SOCK_CAPACITY = 64 * SOCK_SEGMENTS;
const PUFF_CAPACITY = 512;
/** Reference rotor radius (m) of the shared nacelle and rotor geometry; instances scale it. */
const ROTOR_REFERENCE = 40;
/** The rotor hub sits this far ahead of the tower axis, in reference metres. */
const HUB_OFFSET = 3.6;
/** The craft's gusts show on a structure within this distance (m), fading out over as much again. */
const GUST_REACH = 3000;
/** Voice level updates: at most this many a second, and only for a change of at least AUDIO_STEP. */
const AUDIO_RATE = 10;
const AUDIO_STEP = 0.01;
/** Wind (m/s) that holds a windsock straight out. */
const SOCK_FULL_WIND = 8;
/** A touchdown this far (m) past a runway's ends or edges still counts as on it. */
const LANDING_MARGIN_ALONG = 30;
const LANDING_MARGIN_ACROSS = 8;
const LANDING_POINTS = Object.freeze({ butter: 50, smooth: 42, firm: 28, hard: 10 });
const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
/**
 * The wake gust inputs of the sample being computed: [time, sigma (m/s), phase]. Doubles cross into
 * addWakeGust through this array, not as arguments (V8 boxes a double passed to a call it does not
 * inline).
 */
const wakeGustInput = new Float64Array(3);

/**
 * Adds the wake's gusts to result.vel: smooth space-time noise (spatial wavelengths about 25-120 m)
 * of intensity wakeGustInput[1] m/s at point, so a craft in the wake feels the bumps it reads. The
 * same noise shape as the WindField sources' gusts (windSources.js).
 */
function addWakeGust(result, point) {
  const time = wakeGustInput[0];
  const sigma = wakeGustInput[1];
  const phase = wakeGustInput[2];
  const x = point.x;
  const z = point.z;
  const offsetY = phase + 2.39996;
  const offsetZ = phase + 4.79992;
  result.vel.x += sigma * (0.5 * Math.sin(time * 1.9 + x * 0.061 + phase) + 0.3 * Math.sin(time * 3.7 - z * 0.093 + phase * 1.7) + 0.2 * Math.sin(time * 6.1 + (x + z) * 0.147 + phase * 2.3));
  result.vel.y += 0.6 * sigma * (0.5 * Math.sin(time * 1.9 + z * 0.061 + offsetY) + 0.3 * Math.sin(time * 3.7 - x * 0.093 + offsetY * 1.7) + 0.2 * Math.sin(time * 6.1 + (x + z) * 0.147 + offsetY * 2.3));
  result.vel.z += sigma * (0.5 * Math.sin(time * 1.9 + (x + 311) * 0.061 + offsetZ) + 0.3 * Math.sin(time * 3.7 - (z - 173) * 0.093 + offsetZ * 1.7) + 0.2 * Math.sin(time * 6.1 + (x + z + 138) * 0.147 + offsetZ * 2.3));
}
const GEOMETRY_KINDS = Object.freeze(['body', 'detail', 'decal', 'glow', 'water', 'cloth']);

/** Visibility of each geometry kind per tier: [near, mid, far] (far: non-heavy presets only). */
const KIND_TIERS = Object.freeze({
  body: [true, true, true],
  detail: [true, false, false],
  decal: [true, true, true],
  glow: [true, true, true],
  water: [true, true, false],
  cloth: [true, true, false],
});
/** Mover materials (a mover's kind) and the pooled meshes each keeps for the session. */
const MOVER_KINDS = Object.freeze(['body', 'glow', 'decal']);
const MOVER_CAPACITY = 64;
/** A mover's pose in the animate state: local x, y, z, yaw, pitch, roll (radians), scale, visible. */
const POSE_STRIDE = 8;
/** Steam puffs: local x, y, z and radius (0 hides one) per puff in the animate state. */
const STEAM_STRIDE = 4;
const FLAME_CAPACITY = 512;
const BLOCK_CAPACITY = 4096;
/** Instanced flames and blocks are rewritten for the planet curvature only when it moved this far (m). */
const DROP_STEP = 0.25;
/** Torches lit at dusk light above this night factor and go out below DAY_FACTOR. */
const DUSK_FACTOR = 0.55;
const DAY_FACTOR = 0.2;
/** The cloth's swing (rad per m/s of wind, capped) and its ripple. */
const CLOTH_SWING = 0.11;
const CLOTH_SWING_MAX = 1.25;

export function createStructureEngine() {
  let ctx = null;
  let THREE = null;
  let materials = null;
  let meshPools = null;
  let nacelles = null;
  let rotors = null;
  let socks = null;
  let puffs = null;
  let moverPools = null;
  let flames = null;
  let blocks = null;
  let serial = 0;
  let proxies = [];
  const live = [];
  const counts = {
    instances: 0, buffers: 0, drawCalls: 0, surfaces: 0, gates: 0, landings: 0, courses: 0, turbines: 0, puffs: 0,
    movers: 0, flames: 0, litFlames: 0, blocks: 0,
  };

  // Scratch (made in init; never allocated per frame).
  let hiddenMatrix = null;
  const crossing = new Float64Array(1);
  /** A transform being written: position, then the scaled x, y and z axis columns. */
  const transform = new Float64Array(12);

  // ---- Materials --------------------------------------------------------------------------------
  function buildMaterials() {
    const {
      attribute, vertexColor, uniform, positionLocal, float, vec3, sin, cos, min, mix, pow, saturate, dot, smoothstep,
      normalView, positionViewDirection, uv, mx_noise_float, instanceIndex,
    } = ctx.TSL;
    const time = ctx.uniforms.time;
    const nightFactor = ctx.uniforms.nightFactor;
    const sunColor = ctx.uniforms.sunColor;
    const rgba = vertexColor();
    const swayWeight = attribute('sway', 'float');
    // Per object: the sway offset (m) this frame and the glow multiplier (setParam 'glow').
    const swayOffset = uniform(new THREE.Vector3()).onObjectUpdate(({ object }) => object.userData.swayOffset);
    // x = the glow multiplier (params.glow); an object, so the per-object update boxes no number.
    const objectLook = uniform(new THREE.Vector4(1, 0, 0, 0)).onObjectUpdate(({ object }) => object.userData.look);
    const objectGlow = objectLook.x;

    const solid = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.88, metalness: 0 });
    solid.colorNode = rgba.rgb;
    solid.emissiveNode = rgba.rgb.mul(rgba.a).mul(objectGlow).mul(mix(float(0.15), float(1), nightFactor));
    solid.positionNode = positionLocal.add(swayOffset.mul(swayWeight));
    solid.side = THREE.FrontSide;

    const decal = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.96, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    decal.colorNode = rgba.rgb;
    // Ground paint glows only where its vertex alpha says (a fireball's embers); the Phase 2 decals
    // paint alpha 0 and stay unlit.
    decal.emissiveNode = rgba.rgb.mul(rgba.a).mul(objectGlow);

    // Cloth: the sway attribute is each vertex's hang (m from the edge it is tied to). It swings out
    // downwind about that edge, by an angle growing with the wind speed, and ripples across the wind
    // faster in a stronger wind and harder in turbulence: x, y = the wind's unit direction, z = its
    // speed (m/s), w = its turbulence (per object, from the WindField wind the structure shows).
    const clothWind = uniform(new THREE.Vector4(1, 0, 0, 0)).onObjectUpdate(({ object }) => object.userData.clothWind);
    const hang = swayWeight;
    const swing = min(clothWind.z.mul(CLOTH_SWING), float(CLOTH_SWING_MAX));
    const lean = vec3(clothWind.x.mul(sin(swing)), float(1).sub(cos(swing)), clothWind.y.mul(sin(swing))).mul(hang);
    const ripplePhase = positionLocal.x.add(positionLocal.z).mul(0.7);
    const rippleAmount = min(clothWind.z.div(6), float(1)).mul(0.16).add(clothWind.w.mul(0.2)).add(0.03);
    const ripple = sin(time.mul(clothWind.z.mul(0.35).add(5)).add(hang.mul(3.1)).add(ripplePhase)).mul(hang).mul(rippleAmount);
    const cloth = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    cloth.colorNode = rgba.rgb;
    cloth.positionNode = positionLocal.add(lean).add(vec3(clothWind.y.negate().mul(ripple), ripple.mul(0.4), clothWind.x.mul(ripple)));

    // Torch flames: additive, flickering in size and brightness in their own phase, brighter at night.
    const flicker = sin(time.mul(13.1).add(float(instanceIndex).mul(2.3))).mul(0.22).add(sin(time.mul(7.3).add(float(instanceIndex).mul(1.1))).mul(0.16)).add(1);
    const flame = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    flame.colorNode = rgba.rgb.mul(flicker).mul(mix(float(1.1), float(2.8), nightFactor));
    flame.positionNode = positionLocal.mul(vec3(float(2).sub(flicker), flicker, float(2).sub(flicker)));

    // Crystal: the sway attribute carries each crystal's pulse phase (0..1), not a sway weight.
    const glow = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.22, metalness: 0.12 });
    const pulse = sin(time.mul(1.25).add(swayWeight.mul(TWO_PI))).mul(0.25).add(0.75);
    const facing = saturate(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 3);
    // The glow is the crystal colour squared (deeper, more saturated than its lit body), rising with
    // the vertex gain toward the tip, stronger at night where bloom picks it up.
    glow.colorNode = rgba.rgb.mul(0.75);
    glow.emissiveNode = rgba.rgb.mul(rgba.rgb).mul(rgba.a.mul(pulse).mul(objectGlow).mul(mix(float(0.9), float(2.3), nightFactor)).add(rim.mul(0.6)));

    // Falling water: streaks scrolling down the ribbon (uv.y in 30 m units), soft side edges, fading
    // out along its length (vertex alpha), lit by the sun's colour and dimmed at night.
    const water = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const ribbon = uv();
    const streaks = saturate(mx_noise_float(vec3(ribbon.x.mul(9), ribbon.y.mul(2.6).sub(time.mul(1.5)), float(0.5))).mul(0.55).add(0.55));
    const edges = smoothstep(float(0), float(0.18), ribbon.x).mul(smoothstep(float(1), float(0.82), ribbon.x));
    water.colorNode = rgba.rgb.mul(sunColor.mul(0.45).add(0.5)).mul(float(1).sub(nightFactor.mul(0.72)));
    water.opacityNode = rgba.a.mul(streaks).mul(edges).mul(0.72);

    // Mist: soft blobs, thin in the middle and gone at their silhouette, breathing slowly, lit by
    // the sun's colour and leaning toward the fog colour so they sit in the air.
    const mist = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const mistFacing = saturate(dot(normalView, positionViewDirection));
    mist.colorNode = mix(mix(vec3(0.88, 0.91, 0.95), sunColor, 0.2), ctx.uniforms.fogColor, 0.3).mul(float(1).sub(nightFactor.mul(0.72)));
    mist.opacityNode = pow(mistFacing, 2.4).mul(0.24);
    mist.positionNode = positionLocal.mul(sin(time.mul(0.6).add(float(instanceIndex).mul(1.7))).mul(0.06).add(1));

    // Moving parts (nacelles, rotors, windsocks): instance colours multiply the vertex colours.
    const moving = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
    moving.colorNode = rgba.rgb;

    return { solid, decal, glow, water, mist, moving, cloth, flame };
  }

  /** A torch flame at reference size (1 m tall): an orange teardrop around a yellow core. */
  function buildFlameGeometry() {
    const builder = createMeshBuilder();
    builder.setPaint(paint(0xff7a24)).lathe(0, 0, 0, [[0.16, 0], [0.3, 0.28], [0.2, 0.62], [0, 1]], 6, { closeBottom: true });
    builder.setPaint(paint(0xffd76a)).lathe(0, 0.06, 0, [[0.09, 0], [0.16, 0.2], [0, 0.6]], 5, { closeBottom: true, phase: 0.5 });
    return builder.toGeometry(THREE);
  }

  /** A unit box (1 m on each side, its base at y = 0) for the instanced blocks; instance colours paint it. */
  function buildBlockGeometry() {
    const builder = createMeshBuilder();
    builder.setPaint(paint(0xffffff)).box(0, 0.5, 0, 1, 1, 1);
    return builder.toGeometry(THREE);
  }

  // ---- Shared moving-part geometry ------------------------------------------------------------------
  /** The nacelle: body, spinner base and tail at reference scale, facing local -z. */
  function buildNacelleGeometry() {
    const builder = createMeshBuilder();
    builder.setPaint(PALETTE.towerWhite).box(0, 0.2, 2.6, 4.2, 4.2, 11.5);
    builder.setPaint(PALETTE.towerBand).box(0, 2.45, 4.2, 2.6, 0.5, 5);
    builder.setPaint(PALETTE.towerWhite).box(0, -1.5, 0.2, 3.4, 1.6, 3.4);
    return builder.toGeometry(THREE);
  }

  /** The rotor: a spinner and three tapered blades in the local XY plane, spinning about local z. */
  function buildRotorGeometry() {
    const builder = createMeshBuilder();
    // Spinner: lathed along +y, then turned so +y points along -z (upwind).
    builder.setTransform(0, 0, 0, 0, -Math.PI / 2, 0);
    builder.setPaint(PALETTE.towerWhite).lathe(0, -1.2, 0, [[1.9, 0], [1.6, 1.6], [0.8, 3], [0, 3.8]], 10, { closeBottom: true });
    builder.resetTransform();
    for (let blade = 0; blade < 3; blade++) {
      const angle = (blade / 3) * TWO_PI;
      const dirX = Math.sin(angle);
      const dirY = Math.cos(angle);
      // Chord direction: perpendicular to the blade in the rotor plane, pitched a little out of it.
      const chordX = -dirY;
      const chordY = dirX;
      const segments = [[1.5, 3.2, 0.7], [ROTOR_REFERENCE * 0.3, 2.9, 0.55], [ROTOR_REFERENCE * 0.75, 1.7, 0.35], [ROTOR_REFERENCE, 0.6, 0.2]];
      for (let segment = 0; segment < segments.length - 1; segment++) {
        const [r0, chord0, thick0] = segments[segment];
        const [r1, chord1, thick1] = segments[segment + 1];
        const pitch0 = 0.35 - (r0 / ROTOR_REFERENCE) * 0.25;
        const pitch1 = 0.35 - (r1 / ROTOR_REFERENCE) * 0.25;
        const corner = (r, chord, thick, pitch, sideChord, sideThick) => [
          dirX * r + chordX * chord * 0.5 * sideChord * Math.cos(pitch),
          dirY * r + chordY * chord * 0.5 * sideChord * Math.cos(pitch),
          -1.1 + chord * 0.5 * sideChord * Math.sin(pitch) + thick * 0.5 * sideThick,
        ];
        builder.setPaint(segment === segments.length - 2 ? PALETTE.towerBand : PALETTE.towerWhite);
        const a0 = corner(r0, chord0, thick0, pitch0, -1, -1);
        const b0 = corner(r0, chord0, thick0, pitch0, 1, -1);
        const c0 = corner(r0, chord0, thick0, pitch0, 1, 1);
        const d0 = corner(r0, chord0, thick0, pitch0, -1, 1);
        const a1 = corner(r1, chord1, thick1, pitch1, -1, -1);
        const b1 = corner(r1, chord1, thick1, pitch1, 1, -1);
        const c1 = corner(r1, chord1, thick1, pitch1, 1, 1);
        const d1 = corner(r1, chord1, thick1, pitch1, -1, 1);
        // Four sides of the tapered section (the material is double-sided) and the tip cap.
        builder.quad(a0, b0, b1, a1).quad(b0, c0, c1, b1).quad(c0, d0, d1, c1).quad(d0, a0, a1, d1);
        if (segment === segments.length - 2) builder.quad(a1, b1, c1, d1);
      }
    }
    return builder.toGeometry(THREE);
  }

  /** One windsock segment: a short tapered tube along local -z, unit length and radius. */
  function buildSockGeometry() {
    const builder = createMeshBuilder();
    builder.setTransform(0, 0, 0, 0, -Math.PI / 2, 0);
    builder.setPaint(PALETTE.sockWhite).lathe(0, 0, 0, [[1, 0], [0.88, 1]], 10);
    return builder.toGeometry(THREE);
  }

  /** A tiny proxy geometry with every attribute a material reads (the pipeline prewarm). */
  function proxyGeometry(withUv) {
    const builder = createMeshBuilder({ uv: withUv });
    builder.setPaint(PALETTE.concrete).box(0, 0, 0, 1, 1, 1);
    return builder.toGeometry(THREE);
  }

  // ---- Instances --------------------------------------------------------------------------------------
  function readPreset(preset, params) {
    const read = createParamView(`${ENGINE_NAME} preset "${preset.id}"`, params);
    const recipeName = read.choice('recipe', null, RECIPE_NAMES);
    if (!recipeName) read.fail('recipe', `is required: one of ${RECIPE_NAMES.join(', ')}`);
    return { read, recipe: RECIPES[recipeName], recipeName };
  }

  /** The prevailing wind's unit direction (blowing toward) from the shared uniform. */
  function windDirection() {
    const direction = ctx.uniforms.windDirection.value;
    const length = Math.hypot(direction.x, direction.y) || 1;
    return { x: direction.x / length, z: direction.y / length };
  }

  function createRecipeContext(preset, params, rng, recipeName) {
    const anchor = params.position;
    const wind = windDirection();
    const out = {
      turbines: [], socks: [], puffs: [], gates: [], surfaces: [], zones: [], courses: [], colliders: [],
      challenge: null,
      wake: null, turbineSettings: null, sway: null, audioPoint: null, windProbe: null, approach: 0, radius: 20,
      // Phase 3 (optional): movers (context.addMover), the animate hook that poses them (a module-level
      // function, one for every instance of the recipe, reading its instance's own data from
      // state.custom = animateState), dynamic steam puffs, torches (ignitables) and instanced blocks.
      movers: [], animate: null, animateState: null, steam: 0, torches: [], blocks: [],
    };
    const context = {
      presetId: preset.id,
      presetName: preset.name,
      /** The preset's challenge block (recipe challengeGates), or null. */
      challenge: preset.challenge ?? null,
      recipe: recipeName,
      params,
      site: params.site ?? null,
      heading: Number.isFinite(params.heading) ? params.heading : 0,
      rng,
      anchor,
      windX: wind.x,
      windZ: wind.z,
      waterLevel: ctx.terrain.waterLevel - anchor.y,
      ground: (x, z) => Math.max(ctx.terrain.groundHeight(anchor.x + x, anchor.z + z), ctx.terrain.waterLevel) - anchor.y,
      body: createMeshBuilder(),
      detail: createMeshBuilder(),
      decal: createMeshBuilder(),
      glow: createMeshBuilder(),
      water: createMeshBuilder({ uv: true }),
      cloth: createMeshBuilder(),
      out,
      /** Adds a gate (local metres); source names the param for error messages. */
      addGate(gate) {
        out.gates.push(gate);
      },
      /**
       * Adds a mover: a part with its own geometry (build it with the returned builder, in the mover's
       * own frame: its pose origin at 0, 0, 0, forward -z), drawn with the `kind` material ('body',
       * 'glow' or 'decal') and posed by out.animate through state.poses[index * POSE_STRIDE ...].
       * collider: null or { center: [x, y, z], halfExtents: [x, y, z], tags } (a box in the mover's
       * frame that follows its pose). Returns { builder, index }.
       */
      addMover({ name, kind = 'body', collider = null }) {
        if (!MOVER_KINDS.includes(kind)) throw new Error(`[DRIFTWING] structure preset "${preset.id}": mover "${name}" kind must be one of ${MOVER_KINDS.join(', ')}`);
        const builder = createMeshBuilder();
        out.movers.push({ name, kind, builder, collider });
        return { builder, index: out.movers.length - 1 };
      },
    };
    return context;
  }

  /**
   * A recipe's challenge course (out.challenge, a course definition in the world frame) joins the
   * challenge system (ctx.game.systems.challenges) for the instance's life; dispose unregisters it.
   */
  function registerChallenge(data, definition, preset, params) {
    if (!definition) return;
    const challenges = ctx.game?.systems?.challenges;
    if (!challenges || typeof challenges.register !== 'function') return;
    data.challengeKeys.push(challenges.register(definition, { owner: `${preset.id}:${params.seed}` }));
  }

  function unregisterChallenge(data) {
    if (data.challengeKeys.length === 0) return;
    const challenges = ctx.game?.systems?.challenges;
    for (const key of data.challengeKeys) challenges?.unregister?.(key);
    data.challengeKeys = [];
  }

  /** Extra gates any preset adds through params.gates (site frame, relative to the ground). */
  function addParamGates(context, read) {
    const gates = read.array('gates', []);
    const radians = context.heading * DEG;
    const forwardX = Math.sin(radians);
    const forwardZ = -Math.cos(radians);
    gates.forEach((gate, index) => {
      const gateRead = createParamView(`${ENGINE_NAME} preset "${context.presetId}"`, gate, `params.gates[${index}]`);
      const along = gateRead.number('along', 0);
      const across = gateRead.number('across', 0);
      const x = forwardX * along - forwardZ * across;
      const z = forwardZ * along + forwardX * across;
      const heading = (context.heading + gateRead.number('heading', 0, -360, 360)) * DEG;
      const ground = context.ground(x, z);
      context.addGate({
        id: gateRead.string('id', `gate${index}`),
        kind: gateRead.choice('kind', 'through', ['through', 'under']),
        x,
        z,
        normalX: Math.sin(heading),
        normalZ: -Math.cos(heading),
        halfWidth: gateRead.number('halfWidth', 20, 0.5, 2000),
        minY: ground + gateRead.number('bottom', 0, -500, 5000),
        maxY: ground + gateRead.number('top', 40, -500, 5000),
        achievement: gate.achievement ?? null,
        action: gateRead.choice('action', null, ['chime']),
      });
    });
  }

  function validateAchievement(read, gate, index) {
    const achievement = gate.achievement;
    if (achievement === null || achievement === undefined) return null;
    if (typeof achievement !== 'object' || typeof achievement.id !== 'string' || !achievement.id || typeof achievement.title !== 'string' || !achievement.title) {
      read.fail(`gates[${index}].achievement`, 'must be null or { id, title } with non-empty strings');
    }
    return { id: achievement.id, title: achievement.title };
  }

  /** Shows a geometry on a pooled mesh at the anchor (null geometry: nothing). */
  function showGeometry(kind, geometry, instanceData, anchor) {
    if (!geometry) return null;
    const mesh = meshPools[kind].acquire(geometry);
    if (!mesh) {
      geometry.dispose();
      throw new Error(`[DRIFTWING] structure: every ${kind} mesh is in use (${MAX_INSTANCES + 8} at once)`);
    }
    mesh.position.copy(anchor);
    mesh.userData.swayOffset = instanceData.swayOffset;
    mesh.userData.look = instanceData.look;
    mesh.userData.clothWind = instanceData.clothWind;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = kind !== 'water';
    mesh.renderOrder = kind === 'water' ? 2 : 0;
    mesh.updateMatrix();
    counts.buffers++;
    return mesh;
  }

  function releaseMeshes(data) {
    for (const kind of GEOMETRY_KINDS) {
      const mesh = data.meshes[kind];
      if (!mesh) continue;
      const geometry = mesh.geometry;
      meshPools[kind].release(mesh);
      geometry.dispose();
      counts.buffers--;
      data.meshes[kind] = null;
    }
  }

  // ---- Movers, steam, torches and blocks (Phase 3) ---------------------------------------------------
  /** Shows each mover's geometry on a pooled mesh of its kind; the animate hook poses them. */
  function showMovers(data, movers, anchor) {
    data.moverMeshes = new Array(movers.length).fill(null);
    for (let index = 0; index < movers.length; index++) {
      const mover = movers[index];
      const geometry = mover.builder.toGeometry(THREE);
      if (!geometry) throw new Error(`[DRIFTWING] structure: mover "${mover.name}" has no geometry`);
      const mesh = moverPools[mover.kind].acquire(geometry);
      if (!mesh) {
        geometry.dispose();
        throw new Error(`[DRIFTWING] structure: every ${mover.kind} mover mesh is in use (${MOVER_CAPACITY} at once)`);
      }
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = mover.kind !== 'glow';
      mesh.userData.swayOffset = data.swayOffset;
      mesh.userData.look = data.look;
      mesh.userData.clothWind = data.clothWind;
      data.moverMeshes[index] = mesh;
      data.moverKinds[index] = MOVER_KINDS.indexOf(mover.kind);
      counts.movers++;
      // A pose starts at the anchor, unrotated, full size and shown.
      data.moverPoses[index * POSE_STRIDE + 6] = 1;
      data.moverPoses[index * POSE_STRIDE + 7] = 1;
    }
  }

  function releaseMovers(data) {
    for (let index = 0; index < data.moverMeshes.length; index++) {
      const mesh = data.moverMeshes[index];
      if (!mesh) continue;
      const geometry = mesh.geometry;
      moverPools[MOVER_KINDS[data.moverKinds[index]]].release(mesh);
      mesh.matrixAutoUpdate = true;
      geometry.dispose();
      counts.movers--;
      data.moverMeshes[index] = null;
    }
  }

  /**
   * The rotation of a pose (yaw about +y as a compass heading, then pitch about local x, nose up, then
   * roll about local z, as meshBuilder.setTransform) into rotation[0..8], row-major.
   */
  function poseRotation(poses, base, rotation) {
    const cy = Math.cos(-poses[base + 3]);
    const sy = Math.sin(-poses[base + 3]);
    const cx = Math.cos(poses[base + 4]);
    const sx = Math.sin(poses[base + 4]);
    const cz = Math.cos(poses[base + 5]);
    const sz = Math.sin(poses[base + 5]);
    // Rx * Rz, then Ry in front.
    const r00 = cz;
    const r01 = -sz;
    const r10 = cx * sz;
    const r11 = cx * cz;
    const r12 = -sx;
    const r20 = sx * sz;
    const r21 = sx * cz;
    const r22 = cx;
    rotation[0] = cy * r00 + sy * r20;
    rotation[1] = cy * r01 + sy * r21;
    rotation[2] = sy * r22;
    rotation[3] = r10;
    rotation[4] = r11;
    rotation[5] = r12;
    rotation[6] = -sy * r00 + cy * r20;
    rotation[7] = -sy * r01 + cy * r21;
    rotation[8] = cy * r22;
  }

  /**
   * Writes every mover's matrix from its pose (anchor + local position, lowered by the planet curvature
   * at the anchor), and moves the colliders that follow a mover. Allocation-free.
   */
  function poseMovers(data) {
    const poses = data.moverState.poses;
    const rotation = data.moverRotation;
    const drop = rigidCurvatureDrop(ctx, data.moverAnchor[0], data.moverAnchor[2]);
    for (let index = 0; index < data.moverMeshes.length; index++) {
      const mesh = data.moverMeshes[index];
      const base = index * POSE_STRIDE;
      const shown = poses[base + 7] > 0.5 && poses[base + 6] > 0 && data.moversShown === 1;
      if (mesh.visible !== shown) mesh.visible = shown;
      poseRotation(poses, base, rotation);
      const scale = poses[base + 6];
      const elements = mesh.matrix.elements;
      elements[0] = rotation[0] * scale;
      elements[1] = rotation[3] * scale;
      elements[2] = rotation[6] * scale;
      elements[3] = 0;
      elements[4] = rotation[1] * scale;
      elements[5] = rotation[4] * scale;
      elements[6] = rotation[7] * scale;
      elements[7] = 0;
      elements[8] = rotation[2] * scale;
      elements[9] = rotation[5] * scale;
      elements[10] = rotation[8] * scale;
      elements[11] = 0;
      elements[12] = data.moverAnchor[0] + poses[base];
      elements[13] = data.moverAnchor[1] + poses[base + 1] - drop;
      elements[14] = data.moverAnchor[2] + poses[base + 2];
      elements[15] = 1;
      mesh.matrixWorldNeedsUpdate = true;
      const colliderSlot = data.moverColliderSlots[index];
      if (colliderSlot >= 0) poseMoverCollider(data, index, colliderSlot);
    }
  }

  /**
   * A mover's box collider follows its pose: the box centre (in the mover's frame) turned and moved
   * with it, the pose's quaternion. Only when the pose moved since the last write.
   */
  function poseMoverCollider(data, index, slot) {
    const colliders = colliderWorld();
    if (!colliders) return;
    const poses = data.moverState.poses;
    const base = index * POSE_STRIDE;
    const last = data.moverColliderLast;
    const lastBase = slot * 6;
    if (last[lastBase] === poses[base] && last[lastBase + 1] === poses[base + 1] && last[lastBase + 2] === poses[base + 2]
      && last[lastBase + 3] === poses[base + 3] && last[lastBase + 4] === poses[base + 4] && last[lastBase + 5] === poses[base + 5]) return;
    for (let field = 0; field < 6; field++) last[lastBase + field] = poses[base + field];
    const rotation = data.moverRotation;
    const centre = data.moverColliderCentres;
    const cx = centre[slot * 3];
    const cy = centre[slot * 3 + 1];
    const cz = centre[slot * 3 + 2];
    const pose = data.moverColliderPose;
    pose[0] = data.moverAnchor[0] + poses[base] + rotation[0] * cx + rotation[1] * cy + rotation[2] * cz;
    pose[1] = data.moverAnchor[1] + poses[base + 1] + rotation[3] * cx + rotation[4] * cy + rotation[5] * cz;
    pose[2] = data.moverAnchor[2] + poses[base + 2] + rotation[6] * cx + rotation[7] * cy + rotation[8] * cz;
    // q = qy(-yaw) * qx(pitch) * qz(roll).
    const hy = -poses[base + 3] * 0.5;
    const hx = poses[base + 4] * 0.5;
    const hz = poses[base + 5] * 0.5;
    const sy = Math.sin(hy);
    const cyq = Math.cos(hy);
    const sx = Math.sin(hx);
    const cxq = Math.cos(hx);
    const sz = Math.sin(hz);
    const czq = Math.cos(hz);
    // qx * qz first.
    const ax = sx * czq;
    const ay = -sx * sz;
    const az = cxq * sz;
    const aw = cxq * czq;
    // Then qy in front: (0, sy, 0, cy) * (ax, ay, az, aw).
    pose[3] = cyq * ax + sy * az;
    pose[4] = cyq * ay + sy * aw;
    pose[5] = cyq * az - sy * ax;
    pose[6] = cyq * aw - sy * ay;
    colliders.setPose(data.moverColliderIds[slot], pose);
  }

  /** Registers the colliders that follow movers (box specs in each mover's frame). */
  function addMoverColliders(instance, data, movers, prefix) {
    const colliders = colliderWorld();
    const withCollider = movers.filter((mover) => mover.collider);
    data.moverColliderSlots = new Int32Array(movers.length).fill(-1);
    data.moverColliderCentres = new Float64Array(withCollider.length * 3);
    data.moverColliderLast = new Float64Array(withCollider.length * 6).fill(NaN);
    data.moverColliderIds = [];
    if (!colliders || withCollider.length === 0) return;
    let slot = 0;
    movers.forEach((mover, index) => {
      if (!mover.collider) return;
      const { center, halfExtents, tags } = mover.collider;
      const id = `${prefix}:mover${index}`;
      colliders.add({
        id, owner: prefix, type: 'box',
        center: { x: data.moverAnchor[0] + center[0], y: data.moverAnchor[1] + center[1], z: data.moverAnchor[2] + center[2] },
        halfExtents: { x: halfExtents[0], y: halfExtents[1], z: halfExtents[2] },
        tags: tags ?? { surface: 'metal' },
      });
      instance.colliderIds.push(id);
      data.moverColliderIds.push(id);
      data.moverColliderCentres.set(center, slot * 3);
      data.moverColliderSlots[index] = slot;
      slot++;
    });
  }

  /** Allocates the steam puffs (on the shared mist pool), hidden until the animate hook sizes them. */
  function allocSteam(data, count) {
    if (count <= 0) return;
    data.steamSlots = allocSlots(puffs, count, 'mist');
    data.moverState.steam = new Float64Array(count * STEAM_STRIDE);
    for (let index = 0; index < count; index++) puffs.setMatrix(data.steamSlots[index], hiddenMatrix);
    puffs.flush();
    counts.puffs += count;
  }

  /** Writes the steam puffs from the animate state (radius 0 or the far tier hides one). */
  function writeSteam(data) {
    const steam = data.moverState.steam;
    const array = puffs.mesh.instanceMatrix.array;
    const drop = rigidCurvatureDrop(ctx, data.moverAnchor[0], data.moverAnchor[2]);
    for (let index = 0; index < data.steamSlots.length; index++) {
      const base = index * STEAM_STRIDE;
      const radius = data.moversShown === 1 ? steam[base + 3] : 0;
      transform[0] = data.moverAnchor[0] + steam[base];
      transform[1] = data.moverAnchor[1] + steam[base + 1] - drop;
      transform[2] = data.moverAnchor[2] + steam[base + 2];
      transform[3] = radius;
      transform[4] = 0;
      transform[5] = 0;
      transform[6] = 0;
      transform[7] = radius * 0.8;
      transform[8] = 0;
      transform[9] = 0;
      transform[10] = 0;
      transform[11] = radius;
      writeTransform(array, data.steamSlots[index] * 16, transform);
    }
    markMatrices(puffs);
  }

  /**
   * The torches: a flame slot each (hidden while unlit) and an ignitable each in the game's ignition
   * service (ids in instance.ignitableIds; onIgnite lights the flame). Without the service (the node
   * labs) the torches still light at dusk.
   */
  function addTorches(instance, data, torches, anchor, prefix) {
    const count = torches.length;
    if (count === 0) return;
    data.torchSlots = allocSlots(flames, count, 'flame');
    data.torchLocal = new Float64Array(count * 4);
    data.torchLit = new Uint8Array(count);
    data.torchAuto = new Uint8Array(count);
    data.torchIds = new Array(count).fill(null);
    counts.flames += count;
    const ignition = ctx.game && ctx.game.ignition ? ctx.game.ignition : null;
    torches.forEach((torch, index) => {
      data.torchLocal[index * 4] = torch.x;
      data.torchLocal[index * 4 + 1] = torch.y;
      data.torchLocal[index * 4 + 2] = torch.z;
      data.torchLocal[index * 4 + 3] = torch.size ?? 1;
      data.torchAuto[index] = torch.autoLight ? 1 : 0;
      flames.setMatrix(data.torchSlots[index], hiddenMatrix);
      if (!ignition) return;
      const id = `${prefix}:torch${index}`;
      ignition.add({
        id,
        position: { x: anchor.x + torch.x, y: anchor.y + torch.y + (torch.size ?? 1) * 0.4, z: anchor.z + torch.z },
        radius: Math.max(0.6, (torch.size ?? 1) * 1.2),
        onIgnite: () => setTorchLit(data, index, true),
      });
      instance.ignitableIds.push(id);
      data.torchIds[index] = id;
    });
    flames.flush();
  }

  /** Event work: a torch lights (an ignition, or dusk) or goes out (dawn). */
  function setTorchLit(data, index, lit) {
    const value = lit ? 1 : 0;
    if (data.torchLit[index] === value) return;
    data.torchLit[index] = value;
    counts.litFlames += lit ? 1 : -1;
    data.torchDrop = NaN;
  }

  /**
   * Dusk and dawn for the torches marked autoLight: lit through the ignition service (so the registry
   * agrees: a lit torch is not lit again by a flame) at dusk, put out at dawn. Event work.
   */
  function duskAndDawn(data) {
    const night = ctx.uniforms.nightFactor.value;
    const dark = night > DUSK_FACTOR ? 1 : night < DAY_FACTOR ? 0 : data.torchDark;
    if (dark === data.torchDark) return;
    data.torchDark = dark;
    const ignition = ctx.game && ctx.game.ignition ? ctx.game.ignition : null;
    for (let index = 0; index < data.torchLit.length; index++) {
      if (data.torchAuto[index] !== 1) continue;
      const id = data.torchIds[index];
      if (dark === 1) {
        if (ignition && id) ignition.ignite(id, { kind: 'dusk', craft: null, position: null });
        else setTorchLit(data, index, true);
      } else {
        if (ignition && id) ignition.extinguish(id);
        setTorchLit(data, index, false);
      }
    }
  }

  /**
   * Rewrites the torch flames (lit and shown: their place and size; otherwise hidden) when the
   * curvature drop moved by DROP_STEP or a torch changed. Allocation-free.
   */
  function writeTorches(data) {
    const drop = rigidCurvatureDrop(ctx, data.moverAnchor[0], data.moverAnchor[2]);
    const shown = data.flamesShown;
    if (Math.abs(drop - data.torchDrop) < DROP_STEP && shown === data.torchShownWritten) return;
    data.torchDrop = drop;
    data.torchShownWritten = shown;
    const array = flames.mesh.instanceMatrix.array;
    for (let index = 0; index < data.torchSlots.length; index++) {
      const base = index * 4;
      const size = shown === 1 && data.torchLit[index] === 1 ? data.torchLocal[base + 3] : 0;
      transform[0] = data.moverAnchor[0] + data.torchLocal[base];
      transform[1] = data.moverAnchor[1] + data.torchLocal[base + 1] - drop;
      transform[2] = data.moverAnchor[2] + data.torchLocal[base + 2];
      transform[3] = size;
      transform[4] = 0;
      transform[5] = 0;
      transform[6] = 0;
      transform[7] = size;
      transform[8] = 0;
      transform[9] = 0;
      transform[10] = 0;
      transform[11] = size;
      writeTransform(array, data.torchSlots[index] * 16, transform);
    }
    markMatrices(flames);
  }

  function removeTorches(instance, data) {
    const ignition = ctx.game && ctx.game.ignition ? ctx.game.ignition : null;
    if (ignition) for (const id of instance.ignitableIds) ignition.remove(id);
    instance.ignitableIds.length = 0;
    if (data.torchSlots.length > 0) {
      for (let index = 0; index < data.torchLit.length; index++) if (data.torchLit[index] === 1) counts.litFlames--;
      freeSlots(flames, data.torchSlots);
      counts.flames -= data.torchSlots.length;
      data.torchSlots = new Int32Array(0);
      data.torchLit = new Uint8Array(0);
    }
  }

  /** The instanced blocks: a slot each, coloured by its paint; written by writeBlocks. */
  function addBlocks(data, list) {
    const count = list.length;
    if (count === 0) return;
    data.blockSlots = allocSlots(blocks, count, 'block');
    data.blockLocal = new Float64Array(count * 8);
    counts.blocks += count;
    const color = new THREE.Color();
    list.forEach((block, index) => {
      data.blockLocal.set([block.x, block.y, block.z, block.sizeX, block.sizeY, block.sizeZ, Math.cos(block.yaw ?? 0), Math.sin(block.yaw ?? 0)], index * 8);
      const value = block.paint ?? PALETTE.concrete;
      blocks.setColor(data.blockSlots[index], color.setRGB(value[0], value[1], value[2]));
    });
  }

  /**
   * Rewrites the blocks (their boxes, or hidden at a tier that hides the body) when the curvature drop
   * moved by DROP_STEP or the visibility changed. Allocation-free.
   */
  function writeBlocks(data) {
    const drop = rigidCurvatureDrop(ctx, data.moverAnchor[0], data.moverAnchor[2]);
    const shown = data.blocksShown;
    if (Math.abs(drop - data.blockDrop) < DROP_STEP && shown === data.blockShownWritten) return;
    data.blockDrop = drop;
    data.blockShownWritten = shown;
    const array = blocks.mesh.instanceMatrix.array;
    const local = data.blockLocal;
    for (let index = 0; index < data.blockSlots.length; index++) {
      const base = index * 8;
      const visible = shown === 1 ? 1 : 0;
      const cosine = local[base + 6];
      const sine = local[base + 7];
      // A compass yaw as meshBuilder.box: local x turned to (cos, 0, sin), local z to (-sin, 0, cos).
      transform[0] = data.moverAnchor[0] + local[base];
      transform[1] = data.moverAnchor[1] + local[base + 1] - drop;
      transform[2] = data.moverAnchor[2] + local[base + 2];
      transform[3] = cosine * local[base + 3] * visible;
      transform[4] = 0;
      transform[5] = sine * local[base + 3] * visible;
      transform[6] = 0;
      transform[7] = local[base + 4] * visible;
      transform[8] = 0;
      transform[9] = -sine * local[base + 5] * visible;
      transform[10] = 0;
      transform[11] = cosine * local[base + 5] * visible;
      writeTransform(array, data.blockSlots[index] * 16, transform);
    }
    markMatrices(blocks);
  }

  /**
   * The recipe's animate hook for this frame: the env clock (time, step, night factor, sun elevation)
   * and the shown flag, then the hook, then the movers' matrices, colliders and steam from its state.
   */
  function runAnimate(instance, data, dt) {
    const clock = data.moverEnv.clock;
    clock[0] = ctx.time.elapsed;
    clock[1] = dt;
    clock[2] = ctx.uniforms.nightFactor.value;
    clock[3] = ctx.state.time.sunElevation;
    clock[4] = data.moversShown;
    if (data.animate !== null) data.animate(data.moverState, data.moverEnv);
    if (data.moverMeshes.length > 0) poseMovers(data);
    if (data.steamSlots.length > 0) writeSteam(data);
  }

  /**
   * env.trigger(name, options) of the animate hooks: plays a trigger on the instance's voice. One
   * function for every instance (called as a method of its env), so the hooks' call sites stay
   * monomorphic.
   */
  function triggerVoice(name, options) {
    const voice = this.data.voice;
    if (voice) voice.trigger(name, options);
  }

  /**
   * The direction (unit, world) of the brightest live sky target the celestial engine reports (a
   * comet, else a meteor radiant) into out (Float64Array(3)): 1 for a comet, 2 for a radiant, 0 for
   * none. For the animate hooks (the observatory's telescope).
   */
  function skyTarget(out) {
    const spawns = ctx.spawns;
    const celestial = spawns && spawns.registry ? spawns.registry.get('celestial') : null;
    if (!celestial || typeof celestial.skyTarget !== 'function') return 0;
    return celestial.skyTarget(out);
  }

  function freeSlots(pool, slots) {
    for (let index = 0; index < slots.length; index++) if (slots[index] >= 0) pool.free(slots[index]);
    pool.flush();
  }

  function allocSlots(pool, count, name) {
    const slots = new Int32Array(count).fill(-1);
    for (let index = 0; index < count; index++) {
      const slot = pool.alloc();
      if (slot < 0) {
        freeSlots(pool, slots);
        throw new Error(`[DRIFTWING] structure: every ${name} slot is in use`);
      }
      slots[index] = slot;
    }
    return slots;
  }

  /** The game's collider service (Phase 3), or null (the node labs run the engine without one). */
  function colliderWorld() {
    return ctx.game && ctx.game.colliders ? ctx.game.colliders : null;
  }

  function registerSurfaces(data, surfaces, anchor, instance, prefix) {
    const registry = ctx.surfaces;
    const colliders = colliderWorld();
    if ((!registry && !colliders) || surfaces.length === 0) return;
    for (let index = 0; index < surfaces.length; index++) {
      const surface = surfaces[index];
      if (colliders) {
        // A landable heightfield collider: it publishes the same exact top to the ground surfaces.
        const id = `${prefix}:top${index}`;
        colliders.add(islandTopCollider(surface, anchor, id, prefix));
        instance.colliderIds.push(id);
        data.surfaceIds.push(id);
        counts.surfaces++;
        continue;
      }
      const centreX = anchor.x + surface.x;
      const centreZ = anchor.z + surface.z;
      const topY = anchor.y + surface.topY;
      const reach = surface.radius * 1.25;
      const id = `structure:${data.serial}:${index}`;
      registry.add({
        id,
        minX: centreX - reach,
        maxX: centreX + reach,
        minZ: centreZ - reach,
        maxZ: centreZ + reach,
        top: topY + surface.dome,
        heightAt(x, z) {
          const offsetX = x - centreX;
          const offsetZ = z - centreZ;
          const outline = islandOutline(Math.atan2(offsetX, -offsetZ), surface.radius, surface.phaseA, surface.phaseB, surface.phaseC);
          const share = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) / outline;
          return share > 1 ? NaN : topY + islandTopHeight(share, surface.dome);
        },
      });
      data.surfaceIds.push(id);
      counts.surfaces++;
    }
  }

  function removeSurfaces(data) {
    const registry = ctx.surfaces;
    const colliders = colliderWorld();
    for (const id of data.surfaceIds) {
      if (colliders && colliders.remove(id)) counts.surfaces--;
      else if (registry && registry.remove(id)) counts.surfaces--;
    }
    data.surfaceIds.length = 0;
  }

  // ---- Wake turbulence (wind farms) ---------------------------------------------------------------
  function addWake(instance) {
    const data = instance.data;
    if (!data.wake || data.wakeId || !instance.id) return;
    const wake = data.wake;
    const id = `${instance.id}:wake`;
    const turbines = data.turbineCount;
    const positions = data.turbinePositions;
    const radii = data.turbineRadii;
    const state = data.wind;
    const result = data.wakeResult;
    ctx.wind.addSource({
      id,
      kind: 'structure-wake',
      bounds: data.wakeBounds,
      sample(point, time) {
        const windX = state[0];
        const windZ = state[1];
        const speed = state[2];
        if (speed < 0.5) return null;
        const unitX = windX / speed;
        const unitZ = windZ / speed;
        let velocityX = 0;
        let velocityZ = 0;
        let turbulence = 0;
        for (let index = 0; index < turbines; index++) {
          const radius = radii[index];
          const length = wake.length * radius * 2;
          const offsetX = point.x - positions[index * 3];
          const offsetY = point.y - positions[index * 3 + 1];
          const offsetZ = point.z - positions[index * 3 + 2];
          const along = offsetX * unitX + offsetZ * unitZ;
          if (along < -radius || along > length) continue;
          const across = offsetX * -unitZ + offsetZ * unitX;
          const wakeRadius = radius + wake.expansion * (along > 0 ? along : 0);
          const radialSquared = across * across + offsetY * offsetY;
          if (radialSquared > wakeRadius * wakeRadius) continue;
          const core = 1 - radialSquared / (wakeRadius * wakeRadius);
          const fade = 1 - (along > 0 ? along : 0) / length;
          const expansion = radius / wakeRadius;
          const deficit = speed * wake.deficit * expansion * expansion * core;
          velocityX -= unitX * deficit;
          velocityZ -= unitZ * deficit;
          const chop = wake.turbulence * core * fade;
          if (chop > turbulence) turbulence = chop;
        }
        if (turbulence === 0 && velocityX === 0) return null;
        result.vel.x = velocityX;
        result.vel.y = 0;
        result.vel.z = velocityZ;
        result.turbulence = turbulence;
        if (wake.gust > 0 && turbulence > 0) {
          wakeGustInput[0] = time;
          wakeGustInput[1] = turbulence * wake.gust;
          wakeGustInput[2] = positions[0] * 0.0137;
          addWakeGust(result, point);
        }
        return result;
      },
    });
    data.wakeId = id;
    instance.windSourceIds.push(id);
  }

  function removeWake(instance) {
    const data = instance.data;
    if (!data.wakeId) return;
    ctx.wind.removeSource(data.wakeId);
    const index = instance.windSourceIds.indexOf(data.wakeId);
    if (index >= 0) instance.windSourceIds.splice(index, 1);
    data.wakeId = null;
  }

  // ---- Frame work -------------------------------------------------------------------------------
  // The frame functions never pass a freshly computed number to a call V8 may not inline (it would
  // box it into a new heap number): numbers travel in typed arrays (transform, the instance's state
  // arrays) and matrices are written straight into the instanced meshes' buffers.

  /**
   * Writes a column-major 4x4 transform into array at offset from source: [px, py, pz, then the x,
   * y and z axis columns, each already scaled].
   */
  function writeTransform(array, offset, source) {
    array[offset] = source[3];
    array[offset + 1] = source[4];
    array[offset + 2] = source[5];
    array[offset + 3] = 0;
    array[offset + 4] = source[6];
    array[offset + 5] = source[7];
    array[offset + 6] = source[8];
    array[offset + 7] = 0;
    array[offset + 8] = source[9];
    array[offset + 9] = source[10];
    array[offset + 10] = source[11];
    array[offset + 11] = 0;
    array[offset + 12] = source[0];
    array[offset + 13] = source[1];
    array[offset + 14] = source[2];
    array[offset + 15] = 1;
  }

  /** Marks an instanced pool's matrices for upload after direct buffer writes. */
  function markMatrices(pool) {
    pool.mesh.instanceMatrix.needsUpdate = true;
    pool.flush();
  }

  /**
   * The wind the structure shows (data.wind: x, z, speed, -, -, turbulence), eased every frame: the
   * WindField's ambient layer at the probe point (read once at create through wind.ambientAt, then
   * scaled by the live windStrength uniform the field itself uses), plus the gusts and turbulence the
   * craft is feeling (wind.lastLayers) while it is within GUST_REACH of the structure. Nothing here
   * calls into the field per frame (its full sample allocates in its terrain and thermal lookups).
   */
  function updateWind(data, dt) {
    const state = data.wind;
    const scale = ctx.uniforms.windStrength.value / data.ambient[2];
    let targetX = data.ambient[0] * scale;
    let targetZ = data.ambient[1] * scale;
    let turbulence = 0.1;
    const layers = ctx.wind.lastLayers;
    const player = ctx.state.player.position;
    const offsetX = player.x - data.probe[0];
    const offsetZ = player.z - data.probe[2];
    const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
    if (layers && distance < GUST_REACH * 2) {
      const near = distance < GUST_REACH ? 1 : 2 - distance / GUST_REACH;
      targetX += layers.gust.x * near;
      targetZ += layers.gust.z * near;
      turbulence += (layers.turbulence - turbulence) * near;
    }
    const ease = state[4] === 1 ? Math.min(1, dt * 2) : 1;
    state[0] += (targetX - state[0]) * ease;
    state[1] += (targetZ - state[1]) * ease;
    state[2] = Math.sqrt(state[0] * state[0] + state[1] * state[1]);
    state[5] += (turbulence - state[5]) * ease;
    state[4] = 1;
  }

  function updateTurbines(data, dt) {
    const settings = data.turbineSettings;
    const state = data.wind;
    const speed = state[2];
    const turbineState = data.turbineState;
    // Upwind heading: the rotor faces where the wind comes from.
    const upwind = speed > 0.2 ? Math.atan2(-state[0], state[1]) / DEG : turbineState[0];
    let targetRpm = 0;
    if (speed >= settings.cutIn && speed <= settings.cutOut) {
      const share = Math.min(1, (speed - settings.cutIn) / (settings.ratedWind - settings.cutIn));
      targetRpm = settings.maxRpm * Math.pow(share, 0.6) * data.params.rotorSpeed;
    }
    const positions = data.turbinePositions;
    const nacelleArray = nacelles.mesh.instanceMatrix.array;
    const rotorArray = rotors.mesh.instanceMatrix.array;
    const step = settings.yawRate * dt;
    for (let index = 0; index < data.turbineCount; index++) {
      const base = index * 3;
      // Yaw: turn toward the wind at the yaw rate (shortest way round).
      let difference = ((upwind + data.turbineYawOffsets[index] - turbineState[base] + 540) % 360) - 180;
      if (difference > step) difference = step;
      else if (difference < -step) difference = -step;
      turbineState[base] += difference;
      // Spin: the rotor's inertia eases it to the target speed.
      turbineState[base + 2] += (targetRpm * data.turbineSpeedScales[index] - turbineState[base + 2]) * Math.min(1, dt * 0.25);
      turbineState[base + 1] = (turbineState[base + 1] + turbineState[base + 2] * (TWO_PI / 60) * dt) % TWO_PI;
      const yaw = turbineState[base] * DEG;
      const size = data.turbineRadii[index] / ROTOR_REFERENCE;
      // A compass yaw turns about +y by -yaw: x' = (cos, 0, sin yaw), y' = up, z' = (-sin, 0, cos yaw).
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      transform[0] = positions[base];
      transform[1] = positions[base + 1];
      transform[2] = positions[base + 2];
      transform[3] = cosYaw * size;
      transform[4] = 0;
      transform[5] = sinYaw * size;
      transform[6] = 0;
      transform[7] = size;
      transform[8] = 0;
      transform[9] = -sinYaw * size;
      transform[10] = 0;
      transform[11] = cosYaw * size;
      writeTransform(nacelleArray, data.nacelleSlots[index] * 16, transform);
      // The rotor: its hub ahead of the tower (upwind: forward = (sin, -cos yaw)), spun about z'.
      const spin = turbineState[base + 1];
      const cosSpin = Math.cos(spin);
      const sinSpin = Math.sin(spin);
      transform[0] += sinYaw * HUB_OFFSET * size;
      transform[2] -= cosYaw * HUB_OFFSET * size;
      transform[3] = cosSpin * cosYaw * size;
      transform[4] = sinSpin * size;
      transform[5] = cosSpin * sinYaw * size;
      transform[6] = -sinSpin * cosYaw * size;
      transform[7] = cosSpin * size;
      transform[8] = -sinSpin * sinYaw * size;
      writeTransform(rotorArray, data.rotorSlots[index] * 16, transform);
    }
    markMatrices(nacelles);
    markMatrices(rotors);
  }

  /** Windsocks: a chain of segments filling out and swinging downwind with the wind speed. */
  function updateSocks(data) {
    const state = data.wind;
    const speed = state[2];
    const fill = Math.min(1, speed / SOCK_FULL_WIND);
    const flowX = speed > 0.05 ? state[0] / speed : 1;
    const flowZ = speed > 0.05 ? state[1] / speed : 0;
    const elapsed = ctx.time.elapsed;
    const flutter = 0.08 + state[5] * 0.25;
    const sockArray = socks.mesh.instanceMatrix.array;
    const sockData = data.sockData;
    for (let sock = 0; sock < data.sockCount; sock++) {
      const base = sock * 5;
      let x = sockData[base];
      let y = sockData[base + 1];
      let z = sockData[base + 2];
      const length = sockData[base + 3] / SOCK_SEGMENTS;
      const radius = sockData[base + 4];
      for (let segment = 0; segment < SOCK_SEGMENTS; segment++) {
        // Each segment droops a little more than the one before, and flutters.
        const lift = Math.max(0, fill - segment * 0.06 * (1 - fill));
        const wobble = Math.sin(elapsed * (5.5 + segment) + segment * 1.3 + sock) * flutter * (0.4 + fill);
        let dirX = flowX * lift - flowZ * wobble;
        let dirY = -(1 - lift) - 0.04;
        let dirZ = flowZ * lift + flowX * wobble;
        const dirLength = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
        dirX /= dirLength;
        dirY /= dirLength;
        dirZ /= dirLength;
        // The segment's local -z runs along dir: z' = -dir, x' = up x z' (normalised), y' = z' x x'.
        let axisX = -dirZ;
        let axisZ = dirX;
        const axisLength = Math.sqrt(axisX * axisX + axisZ * axisZ);
        if (axisLength < 1e-4) {
          axisX = 1;
          axisZ = 0;
        } else {
          axisX /= axisLength;
          axisZ /= axisLength;
        }
        const segmentRadius = radius * (1 - segment * 0.1) * (0.55 + 0.45 * fill);
        transform[0] = x;
        transform[1] = y;
        transform[2] = z;
        transform[3] = axisX * segmentRadius;
        transform[4] = 0;
        transform[5] = axisZ * segmentRadius;
        // y' = z' x x' with z' = -dir and x' = (axisX, 0, axisZ).
        transform[6] = -dirY * axisZ * segmentRadius;
        transform[7] = (dirX * axisZ - dirZ * axisX) * segmentRadius;
        transform[8] = dirY * axisX * segmentRadius;
        transform[9] = -dirX * length;
        transform[10] = -dirY * length;
        transform[11] = -dirZ * length;
        writeTransform(sockArray, data.sockSlots[sock * SOCK_SEGMENTS + segment] * 16, transform);
        x += dirX * length;
        y += dirY * length;
        z += dirZ * length;
      }
    }
    markMatrices(socks);
  }

  function onGatePassed(instance, gateIndex, direction) {
    const data = instance.data;
    const gate = data.gateMeta[gateIndex];
    counts.gates++;
    if (gate.action === 'chime' && data.voice) data.voice.trigger('chime', { strength: Math.min(1, 0.4 + ctx.state.player.speed / 120), notes: 3 });
    ctx.bus.emit('structure:gate', {
      spawnId: instance.id, presetId: instance.presetId, siteId: data.siteId, gate: gate.id, kind: gate.kind, direction,
    });
    if (gate.achievement && !data.achieved[gateIndex]) {
      data.achieved[gateIndex] = 1;
      ctx.bus.emitTyped('achievement', { id: gate.achievement.id, title: gate.achievement.title });
    }
    for (const course of data.courses) {
      const member = course.gates.indexOf(gate.id);
      if (member < 0) continue;
      if (course.startGate < 0 || course.startGate === member) {
        course.startGate = member;
        course.startTime = ctx.time.elapsed;
        course.crashed = false;
        ctx.bus.emit('notify', { text: `${data.name}: run started`, kind: 'info' });
        continue;
      }
      const time = ctx.time.elapsed - course.startTime;
      const clean = !course.crashed;
      course.startGate = -1;
      if (course.clean && !clean) continue;
      counts.courses++;
      ctx.bus.emit('structure:course', { spawnId: instance.id, presetId: instance.presetId, siteId: data.siteId, course: course.id, time, clean });
      if (course.journal && clean) ctx.bus.emitTyped('journalStat', { key: course.journal, value: Math.round(time * 100) / 100, op: 'min', presetId: instance.presetId });
      ctx.bus.emit('notify', { text: `${data.name}: ${time.toFixed(1)} s`, kind: 'success' });
    }
  }

  function checkGates(instance) {
    const data = instance.data;
    const player = ctx.state.player.position;
    const previous = data.previousPlayer;
    const set = data.gates;
    if (set !== null && data.hasPrevious === 1 && player.x > set.minX - 400 && player.x < set.maxX + 400 && player.z > set.minZ - 400 && player.z < set.maxZ + 400) {
      let index = crossGates(set, previous, player, 0, crossing);
      while (index >= 0) {
        onGatePassed(instance, index, crossing[0]);
        index = crossGates(set, previous, player, index + 1, crossing);
      }
    }
    if (data.hasPrevious === 1 && data.courses.length > 0) {
      const dx = player.x - previous[0];
      const dz = player.z - previous[2];
      if (dx * dx + dz * dz > GATE_TELEPORT_DISTANCE * GATE_TELEPORT_DISTANCE) interruptCourses(data);
    }
    previous[0] = player.x;
    previous[1] = player.y;
    previous[2] = player.z;
    data.hasPrevious = 1;
  }

  /** A jump between frames (a relaunch, a reset, a craft change) leaves any running course unclean. */
  function interruptCourses(data) {
    for (const course of data.courses) if (course.startGate >= 0) course.crashed = true;
  }

  /**
   * A corridor course (course.corridor: x, z, top per path point, site frame) spoils its clean run
   * once the player climbs above the top of the path point nearest it: the run left the canyon.
   */
  function checkCorridors(instance) {
    const data = instance.data;
    const courses = data.courses;
    for (let index = 0; index < courses.length; index++) {
      const course = courses[index];
      const points = course.corridor;
      if (!points || course.startGate < 0 || course.crashed) continue;
      const player = ctx.state.player.position;
      const x = player.x - instance.anchor.x;
      const z = player.z - instance.anchor.z;
      let nearest = 0;
      let nearestSq = Infinity;
      for (let point = 0; point < points.length; point += 3) {
        const dx = points[point] - x;
        const dz = points[point + 1] - z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq < nearestSq) {
          nearestSq = distanceSq;
          nearest = point;
        }
      }
      if (player.y - instance.anchor.y > points[nearest + 2]) spoilCourse(data, course);
    }
  }

  /** Event work (once per run): the corridor run is no longer clean. */
  function spoilCourse(data, course) {
    course.crashed = true;
    if (course.clean) ctx.bus.emit('notify', { text: `${data.name}: left the canyon, the run is not clean`, kind: 'info' });
  }

  /** The cloth's wind (data.clothWind) from the eased wind the structure shows; the direction holds in a calm. */
  function updateClothWind(data) {
    const state = data.wind;
    const look = data.clothWind;
    const speed = state[2];
    if (speed > 0.1) {
      look.x = state[0] / speed;
      look.y = state[1] / speed;
    }
    look.z = speed * data.params.sway;
    look.w = state[5];
  }

  function updateSway(data) {
    const sway = data.sway;
    const state = data.wind;
    const windStrength = Math.min(1.6, 0.25 + state[2] / 8 + state[5] * 0.8);
    const amplitude = sway.amplitude * windStrength * data.params.sway;
    const phase = ctx.time.elapsed * TWO_PI * sway.frequency;
    const swing = Math.sin(phase) * amplitude;
    let dirX = sway.dirX;
    let dirZ = sway.dirZ;
    if (sway.followWind) {
      const speed = state[2];
      dirX = speed > 0.1 ? state[0] / speed : 1;
      dirZ = speed > 0.1 ? state[1] / speed : 0;
    }
    const offset = data.swayOffset;
    offset.x = dirX * swing;
    offset.y = Math.sin(phase * 2 + 0.7) * amplitude * 0.15;
    offset.z = dirZ * swing;
  }

  /**
   * Drives the voice's level (approach, wind or constant) at most AUDIO_RATE times a second and only
   * when it moved by AUDIO_STEP: the voice API takes a number, so its calls are rationed.
   */
  function updateAudio(data, dt) {
    const voice = data.voice;
    if (voice === null) return;
    const audio = data.audioState;
    audio[1] -= dt;
    if (audio[1] > 0) return;
    audio[1] = 1 / AUDIO_RATE;
    let level = data.audioLevel;
    if (data.audioMode === 'wind') level = data.wind[2] / data.audioReference;
    else if (data.audioMode === 'recipe') level = data.moverState.level[0];
    else if (data.audioMode === 'approach') {
      const player = ctx.state.player.position;
      const point = data.audioPosition;
      const dx = player.x - point.x;
      const dy = player.y - point.y;
      const dz = player.z - point.z;
      level = 1 - (Math.sqrt(dx * dx + dy * dy + dz * dz) - 40) / data.audioReference;
    }
    level *= data.params.audio;
    level = level < 0 ? 0 : level > 1 ? 1 : level;
    if (Math.abs(level - audio[0]) < AUDIO_STEP) return;
    audio[0] = level;
    voice.setIntensity(audio[0]);
  }

  // ---- Landings -----------------------------------------------------------------------------------
  function onLanded(landing) {
    for (let index = 0; index < live.length; index++) {
      const instance = live[index];
      const data = instance.data;
      for (const zone of data.zones) {
        if (!zone.graded) continue;
        const offsetX = landing.position.x - zone.x;
        const offsetZ = landing.position.z - zone.z;
        const along = offsetX * zone.dirX + offsetZ * zone.dirZ;
        const across = offsetX * -zone.dirZ + offsetZ * zone.dirX;
        if (Math.abs(along) > zone.halfLength + LANDING_MARGIN_ALONG || Math.abs(across) > zone.halfWidth + LANDING_MARGIN_ACROSS) continue;
        const heading = ctx.state.player.heading * DEG;
        const sign = Math.sin(heading) * zone.dirX - Math.cos(heading) * zone.dirZ >= 0 ? 1 : -1;
        const fromThreshold = zone.halfLength + along * sign;
        const zoneScore = fromThreshold < 150 ? Math.max(0, fromThreshold / 150) : fromThreshold <= 450 ? 1 : Math.max(0, 1 - (fromThreshold - 450) / 450);
        const centreScore = Math.max(0, 1 - Math.abs(across) / zone.halfWidth);
        const score = Math.round((LANDING_POINTS[landing.grade] ?? 0) + 25 * centreScore + 25 * zoneScore);
        const rating = score >= 90 ? 'greaser' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'rough';
        const runway = sign > 0 ? zone.numbers[0] : zone.numbers[1];
        counts.landings++;
        ctx.bus.emit('structure:landing', {
          spawnId: instance.id, presetId: instance.presetId, siteId: data.siteId, zone: zone.id, runway,
          grade: landing.grade, sinkRate: landing.sinkRate, centreline: Math.round(across * 10) / 10,
          fromThreshold: Math.round(fromThreshold), score, rating,
        });
        ctx.bus.emit('notify', {
          text: `Runway ${String(runway).padStart(2, '0')}: ${landing.grade} touchdown, ${Math.abs(across).toFixed(1)} m off the centreline, ${Math.max(0, Math.round(fromThreshold))} m past the threshold. Score ${score}.`,
          kind: score >= 70 ? 'success' : 'info',
        });
        return;
      }
    }
  }

  function onSoftCrash() {
    for (let index = 0; index < live.length; index++) {
      for (const course of live[index].data.courses) if (course.startGate >= 0) course.crashed = true;
    }
  }

  // ---- LOD --------------------------------------------------------------------------------------
  function applyVisibility(instance) {
    const data = instance.data;
    const rank = instance.tier === 'near' ? 0 : instance.tier === 'mid' ? 1 : 2;
    const hideAll = rank === 2 && instance.heavy;
    for (const kind of GEOMETRY_KINDS) {
      const mesh = data.meshes[kind];
      if (!mesh) continue;
      mesh.visible = !hideAll && KIND_TIERS[kind][rank];
      mesh.castShadow = kind === 'body' && rank === 0;
    }
    const showMoving = !hideAll;
    if (!showMoving || data.movingHidden) {
      for (let index = 0; index < data.turbineCount; index++) {
        if (!showMoving) {
          nacelles.setMatrix(data.nacelleSlots[index], hiddenMatrix);
          rotors.setMatrix(data.rotorSlots[index], hiddenMatrix);
        }
      }
      nacelles.flush();
      rotors.flush();
    }
    const showSocks = rank === 0;
    if (!showSocks) {
      for (let index = 0; index < data.sockSlots.length; index++) socks.setMatrix(data.sockSlots[index], hiddenMatrix);
      socks.flush();
    }
    const showPuffs = rank < 2;
    for (let index = 0; index < data.puffSlots.length; index++) puffs.setMatrix(data.puffSlots[index], showPuffs ? data.puffMatrices[index] : hiddenMatrix);
    puffs.flush();
    data.movingHidden = !showMoving;
    // Turbines keep turning at the mid tier and freeze (still drawn) at the far tier.
    data.animateTurbines = showMoving && rank < 2;
    data.animateSocks = showSocks;
    // Movers, steam and flames show (and animate) at the near and mid tiers; blocks follow the body.
    data.moversShown = rank < 2 ? 1 : 0;
    data.flamesShown = rank < 2 ? 1 : 0;
    data.blocksShown = !hideAll && KIND_TIERS.body[rank] ? 1 : 0;
    if (data.moversShown === 0) {
      for (let index = 0; index < data.moverMeshes.length; index++) if (data.moverMeshes[index]) data.moverMeshes[index].visible = false;
      if (data.steamSlots.length > 0) writeSteam(data);
    }
    for (let index = 0; index < data.moverMeshes.length; index++) {
      const mesh = data.moverMeshes[index];
      if (mesh) mesh.castShadow = rank === 0 && data.moverKinds[index] === 0;
    }
  }

  const engine = {
    name: ENGINE_NAME,
    budget: { instances: MAX_INSTANCES, particles: 0 },
    init(engineCtx) {
      ctx = engineCtx;
      THREE = ctx.THREE;
      hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
      materials = buildMaterials();
      const poolMaterial = { body: materials.solid, detail: materials.solid, decal: materials.decal, glow: materials.glow, water: materials.water, cloth: materials.cloth };
      meshPools = {};
      for (const kind of GEOMETRY_KINDS) {
        meshPools[kind] = ctx.pools.createMeshPool({ material: poolMaterial[kind], capacity: MAX_INSTANCES + 8, parent: ctx.scene, name: `structure-${kind}` });
      }
      nacelles = ctx.pools.createInstancedPool({ geometry: buildNacelleGeometry(), material: materials.moving, capacity: TURBINE_CAPACITY, name: 'structure-nacelles', parent: ctx.scene });
      rotors = ctx.pools.createInstancedPool({ geometry: buildRotorGeometry(), material: materials.moving, capacity: TURBINE_CAPACITY, name: 'structure-rotors', parent: ctx.scene });
      socks = ctx.pools.createInstancedPool({ geometry: buildSockGeometry(), material: materials.moving, capacity: SOCK_CAPACITY, name: 'structure-windsocks', parent: ctx.scene, colors: true });
      const puffGeometry = new THREE.IcosahedronGeometry(1, 2);
      puffs = ctx.pools.createInstancedPool({ geometry: puffGeometry, material: materials.mist, capacity: PUFF_CAPACITY, name: 'structure-mist', parent: ctx.scene });
      moverPools = {};
      for (const kind of MOVER_KINDS) {
        moverPools[kind] = ctx.pools.createMeshPool({ material: poolMaterial[kind], capacity: MOVER_CAPACITY, parent: ctx.scene, name: `structure-mover-${kind}` });
      }
      flames = ctx.pools.createInstancedPool({ geometry: buildFlameGeometry(), material: materials.flame, capacity: FLAME_CAPACITY, name: 'structure-flames', parent: ctx.scene });
      blocks = ctx.pools.createInstancedPool({ geometry: buildBlockGeometry(), material: materials.moving, capacity: BLOCK_CAPACITY, name: 'structure-blocks', parent: ctx.scene, colors: true });
      nacelles.mesh.castShadow = true;
      rotors.mesh.castShadow = true;
      blocks.mesh.castShadow = true;
      blocks.mesh.receiveShadow = true;
      puffs.mesh.renderOrder = 3;
      flames.mesh.renderOrder = 3;
      // The pipeline prewarm (behind the loading fade): one proxy per pooled material, with every
      // attribute the material reads, plus the instanced meshes themselves.
      if (typeof ctx.registerPrewarm === 'function') {
        const solidProxy = new THREE.Mesh(proxyGeometry(false), materials.solid);
        solidProxy.castShadow = true;
        solidProxy.receiveShadow = true;
        proxies = [
          solidProxy, new THREE.Mesh(proxyGeometry(false), materials.decal), new THREE.Mesh(proxyGeometry(false), materials.glow), new THREE.Mesh(proxyGeometry(true), materials.water),
          new THREE.Mesh(proxyGeometry(false), materials.cloth),
        ];
        for (const proxy of proxies) {
          proxy.userData.swayOffset = new THREE.Vector3();
          proxy.userData.look = new THREE.Vector4(1, 0, 0, 0);
          proxy.userData.clothWind = new THREE.Vector4(1, 0, 0, 0);
          ctx.registerPrewarm(proxy);
        }
        for (const pool of [nacelles, rotors, socks, puffs, flames, blocks]) ctx.registerPrewarm(pool.mesh);
      }
      if (ctx.bus && typeof ctx.bus.onTyped === 'function') {
        ctx.bus.onTyped('landed', onLanded);
        ctx.bus.onTyped('softCrash', onSoftCrash);
      }
    },

    create(preset, params, rng) {
      const { read, recipe, recipeName } = readPreset(preset, params);
      const context = createRecipeContext(preset, params, rng, recipeName);
      recipe.build(context, read);
      addParamGates(context, read);
      const out = context.out;
      const anchor = params.position;
      const serialNumber = ++serial;
      const data = {
        serial: serialNumber,
        recipe: recipeName,
        name: preset.name,
        siteId: params.site ? params.site.id : null,
        meshes: { body: null, detail: null, decal: null, glow: null, water: null },
        swayOffset: new THREE.Vector3(),
        sway: out.sway ? { ...out.sway, followWind: false } : { dirX: 1, dirZ: 0, amplitude: read.number('sway', 0.35, 0, 5), frequency: 0.3, followWind: true },
        /** Per-object shader values: x = the glow multiplier. */
        look: new THREE.Vector4(1, 0, 0, 0),
        wind: new Float64Array(6),
        /** The ambient wind at the probe point at create (x, z) and the windStrength then. */
        ambient: new Float64Array(3),
        probe: out.windProbe ?? [0, 10, 0],
        turbineCount: out.turbines.length,
        turbineSettings: out.turbineSettings,
        turbinePositions: new Float64Array(out.turbines.length * 3),
        turbineRadii: new Float64Array(out.turbines.length),
        turbineSpeedScales: new Float64Array(out.turbines.length),
        turbineYawOffsets: new Float64Array(out.turbines.length),
        turbineState: new Float64Array(out.turbines.length * 3),
        nacelleSlots: new Int32Array(0),
        rotorSlots: new Int32Array(0),
        sockCount: out.socks.length,
        sockData: new Float64Array(out.socks.length * 5),
        sockSlots: new Int32Array(0),
        puffSlots: new Int32Array(0),
        puffMatrices: [],
        gates: null,
        gateMeta: [],
        achieved: new Uint8Array(Math.max(1, out.gates.length)),
        previousPlayer: new Float64Array(3),
        hasPrevious: 0,
        courses: out.courses.map((course) => ({ ...course, startGate: -1, startTime: 0, crashed: false })),
        /** Challenge course keys registered with the challenge system (recipe challengeGates). */
        challengeKeys: [],
        zones: [],
        surfaceIds: [],
        wake: out.wake,
        wakeId: null,
        wakeBounds: null,
        wakeResult: createWindSample(),
        voice: null,
        audioMode: 'constant',
        audioLevel: 0.8,
        audioReference: 1,
        audioPosition: new THREE.Vector3(),
        /** [last level sent, seconds to the next level update]. */
        audioState: new Float64Array([-1, 0]),
        movingHidden: false,
        animateTurbines: true,
        animateSocks: true,
        turbineColliders: null,
        /** The cloth's per-object wind: unit direction x, z, speed (m/s), turbulence. */
        clothWind: new THREE.Vector4(context.windX, context.windZ, 0, 0),
        // Phase 3 recipe features (empty for the Phase 2 recipes).
        animate: typeof out.animate === 'function' ? out.animate : null,
        /** 1 when the recipe has an animate hook, movers or steam (runAnimate runs each frame). */
        animated: 0,
        moverMeshes: [],
        moverKinds: new Uint8Array(out.movers.length),
        moverPoses: new Float64Array(out.movers.length * POSE_STRIDE),
        moverAnchor: new Float64Array(3),
        moverRotation: new Float64Array(9),
        moverColliderSlots: new Int32Array(0),
        moverColliderIds: [],
        moverColliderCentres: new Float64Array(0),
        moverColliderLast: new Float64Array(0),
        moverColliderPose: new Float64Array(7),
        moverState: null,
        moverEnv: null,
        /** 1 while movers, steam, flames and blocks show (by tier); the animate hook reads it as clock[4]. */
        moversShown: 1,
        flamesShown: 1,
        blocksShown: 1,
        steamSlots: new Int32Array(0),
        torchSlots: new Int32Array(0),
        torchLocal: new Float64Array(0),
        torchLit: new Uint8Array(0),
        torchAuto: new Uint8Array(0),
        torchIds: [],
        torchDark: -1,
        torchDrop: NaN,
        torchShownWritten: -1,
        blockSlots: new Int32Array(0),
        blockLocal: new Float64Array(0),
        blockDrop: NaN,
        blockShownWritten: -1,
      };
      // The animate hook's state (what it writes) and env (what it reads), made once per instance.
      data.moverState = { poses: data.moverPoses, steam: new Float64Array(0), level: new Float64Array([0.8]), glow: new Float64Array([1]), custom: out.animateState ?? null };
      data.moverEnv = {
        /** [time (s), step (s), night factor, sun elevation (deg), shown (1 near and mid, else 0)]. */
        clock: new Float64Array(5),
        /** The wind the structure shows: [x, z, speed (m/s), -, -, turbulence]. */
        wind: data.wind,
        anchor,
        player: ctx.state.player.position,
        moonDirection: ctx.state.time.moonDirection ?? null,
        sunDirection: ctx.state.time.sunDirection ?? null,
        skyTarget,
        /** Plays a voice trigger (event work: a whistle, a bell): env.trigger(name, options). */
        trigger: triggerVoice,
        /** The instance data (the voice), for trigger. */
        data,
      };
      // Probe point and audio position in world space; the ambient wind there, once.
      data.probe = [anchor.x + data.probe[0], anchor.y + data.probe[1], anchor.z + data.probe[2]];
      const ambient = ctx.wind.ambientAt({ x: data.probe[0], y: data.probe[1], z: data.probe[2] });
      const toward = (ambient.fromDegrees + 180) * DEG;
      data.ambient[0] = Math.sin(toward) * ambient.speed;
      data.ambient[1] = -Math.cos(toward) * ambient.speed;
      data.ambient[2] = ctx.uniforms.windStrength.value || 1;
      const audioPoint = out.audioPoint ?? [0, 5, 0];
      data.audioPosition.set(anchor.x + audioPoint[0], anchor.y + audioPoint[1], anchor.z + audioPoint[2]);
      // Live params (read every frame): the set-piece engine's ramps write them directly.
      const instance = { anchor, radius: out.radius, windSourceIds: [], colliderIds: [], ignitableIds: [], lights: 0, particles: 0, data, params: { glow: 1, sway: 1, rotorSpeed: 1, audio: 1 } };
      const colliderPrefix = `${preset.id}:${params.seed}:${serialNumber}`;
      data.params = instance.params;
      try {
        // Geometry on pooled meshes.
        for (const kind of GEOMETRY_KINDS) data.meshes[kind] = showGeometry(kind, context[kind].toGeometry(THREE), data, anchor);
        // Phase 3: movers, steam, torches and blocks, all placed from the anchor.
        data.moverAnchor[0] = anchor.x;
        data.moverAnchor[1] = anchor.y;
        data.moverAnchor[2] = anchor.z;
        if (out.movers.length > 0) showMovers(data, out.movers, anchor);
        allocSteam(data, out.steam);
        addTorches(instance, data, out.torches, anchor, colliderPrefix);
        addBlocks(data, out.blocks);
        // Turbines.
        out.turbines.forEach((turbine, index) => {
          data.turbinePositions[index * 3] = anchor.x + turbine.x;
          data.turbinePositions[index * 3 + 1] = anchor.y + turbine.y;
          data.turbinePositions[index * 3 + 2] = anchor.z + turbine.z;
          data.turbineRadii[index] = turbine.rotorRadius;
          data.turbineSpeedScales[index] = turbine.speedScale;
          data.turbineYawOffsets[index] = turbine.yawOffset;
          data.turbineState[index * 3 + 1] = turbine.phase;
        });
        if (data.turbineCount > 0) {
          data.nacelleSlots = allocSlots(nacelles, data.turbineCount, 'turbine');
          data.rotorSlots = allocSlots(rotors, data.turbineCount, 'rotor');
          counts.turbines += data.turbineCount;
          // Start facing the prevailing wind.
          const wind = windDirection();
          const upwind = Math.atan2(-wind.x, wind.z) / DEG;
          for (let index = 0; index < data.turbineCount; index++) data.turbineState[index * 3] = upwind;
          let minX = Infinity;
          let maxX = -Infinity;
          let minZ = Infinity;
          let maxZ = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          const reach = data.wake ? Math.max(...out.turbines.map((turbine) => turbine.rotorRadius)) * (data.wake.length * 2 + 1) : 0;
          for (let index = 0; index < data.turbineCount; index++) {
            minX = Math.min(minX, data.turbinePositions[index * 3] - reach);
            maxX = Math.max(maxX, data.turbinePositions[index * 3] + reach);
            minZ = Math.min(minZ, data.turbinePositions[index * 3 + 2] - reach);
            maxZ = Math.max(maxZ, data.turbinePositions[index * 3 + 2] + reach);
            minY = Math.min(minY, data.turbinePositions[index * 3 + 1] - data.turbineRadii[index] * 2);
            maxY = Math.max(maxY, data.turbinePositions[index * 3 + 1] + data.turbineRadii[index] * 2);
          }
          data.wakeBounds = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
        }
        // Windsocks.
        out.socks.forEach((sock, index) => {
          data.sockData.set([anchor.x + sock.x, anchor.y + sock.y, anchor.z + sock.z, sock.length, sock.radius], index * 5);
        });
        if (data.sockCount > 0) {
          data.sockSlots = allocSlots(socks, data.sockCount * SOCK_SEGMENTS, 'windsock');
          const color = new THREE.Color();
          for (let index = 0; index < data.sockSlots.length; index++) {
            const [r, g, b] = index % 2 === 0 ? PALETTE.sockOrange : PALETTE.sockWhite;
            socks.setColor(data.sockSlots[index], color.setRGB(r, g, b));
          }
        }
        // Mist puffs (static matrices, shown at the near and mid tiers).
        if (out.puffs.length > 0) {
          data.puffSlots = allocSlots(puffs, out.puffs.length, 'mist');
          const puffPosition = new THREE.Vector3();
          const puffScale = new THREE.Vector3();
          const identity = new THREE.Quaternion();
          data.puffMatrices = out.puffs.map((puff) => new THREE.Matrix4().compose(
            puffPosition.set(anchor.x + puff.x, anchor.y + puff.y, anchor.z + puff.z),
            identity,
            puffScale.set(puff.radius, puff.radius * 0.72, puff.radius),
          ));
          counts.puffs += out.puffs.length;
        }
        // Gates.
        if (out.gates.length > 0) {
          const worldGates = out.gates.map((gate, index) => {
            data.gateMeta.push({ id: gate.id, kind: gate.kind, action: gate.action ?? null, achievement: validateAchievement(read, gate, index) });
            return { ...gate, x: anchor.x + gate.x, z: anchor.z + gate.z, minY: anchor.y + gate.minY, maxY: anchor.y + gate.maxY };
          });
          data.gates = createGateSet(worldGates);
        }
        // Landing zones (world space).
        data.zones = out.zones.map((zone) => ({ ...zone, x: anchor.x + zone.x, z: anchor.z + zone.z, y: anchor.y + zone.y }));
        registerSurfaces(data, out.surfaces, anchor, instance, colliderPrefix);
        registerChallenge(data, out.challenge, preset, params);
        // First pose of the moving parts (an instance may start at the far tier, where they freeze).
        updateWind(data, 0);
        if (data.turbineCount > 0) updateTurbines(data, 0);
        if (data.sockCount > 0) updateSocks(data);
        addStructureColliders(colliderWorld(), instance, data, out, anchor, colliderPrefix);
        addMoverColliders(instance, data, out.movers, colliderPrefix);
        // The preset's voice (engineKit's ownsPresetAudio: params.voice, else the first engine entry).
        if (ownsPresetAudio(preset, ENGINE_NAME, read.boolean('voice', null)) && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
          data.audioMode = read.choice('audioIntensity', recipe.audioIntensity, ['approach', 'wind', 'constant', 'recipe']);
          data.audioLevel = read.number('audioLevel', 0.8, 0, 1);
          data.audioReference = data.audioMode === 'wind' ? (out.turbineSettings ? out.turbineSettings.ratedWind : 10) : data.audioMode === 'approach' ? (out.approach || 1500) : 1;
          data.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: data.audioMode === 'constant' ? data.audioLevel : 0 });
          data.voice.setPosition(data.audioPosition);
        }
        // The first pose of the recipe's movers, steam, flames and blocks.
        data.animated = data.animate !== null || out.movers.length > 0 || out.steam > 0 ? 1 : 0;
        if (data.animated === 1) runAnimate(instance, data, 0);
        if (data.torchSlots.length > 0) {
          duskAndDawn(data);
          writeTorches(data);
        }
        if (data.blockSlots.length > 0) writeBlocks(data);
      } catch (error) {
        engine.dispose(instance);
        throw error;
      }
      live.push(instance);
      counts.instances++;
      return instance;
    },

    update(instance, dt) {
      const data = instance.data;
      for (let kind = 0; kind < GEOMETRY_KINDS.length; kind++) applyRigidDrop(ctx, data.meshes[GEOMETRY_KINDS[kind]], instance.anchor.y);
      data.look.x = instance.params.glow * data.moverState.glow[0];
      updateWind(data, dt);
      if (data.meshes.cloth !== null) updateClothWind(data);
      if (data.animated === 1 && data.moversShown === 1) runAnimate(instance, data, dt);
      if (data.torchSlots.length > 0) {
        duskAndDawn(data);
        writeTorches(data);
      }
      if (data.blockSlots.length > 0) writeBlocks(data);
      if (data.turbineCount > 0 && data.animateTurbines) updateTurbines(data, dt);
      if (data.turbineColliders) updateTurbineColliders(colliderWorld(), data);
      if (data.sockCount > 0 && data.animateSocks) updateSocks(data);
      if (data.meshes.body !== null || data.meshes.detail !== null) updateSway(data);
      checkGates(instance);
      if (data.courses.length > 0) checkCorridors(instance);
      updateAudio(data, dt);
    },

    setLOD(instance, tier) {
      instance.tier = tier;
      applyVisibility(instance);
      // The wake reaches a few rotor diameters downwind; at the far tier the player is kilometres away.
      if (tier === 'far') removeWake(instance);
      else addWake(instance);
    },

    dispose(instance) {
      const data = instance.data;
      const index = live.indexOf(instance);
      if (index >= 0) {
        live.splice(index, 1);
        counts.instances--;
      }
      removeWake(instance);
      removeSurfaces(data);
      removeStructureColliders(colliderWorld(), instance, data);
      unregisterChallenge(data);
      releaseMeshes(data);
      if (data.nacelleSlots.length > 0) {
        freeSlots(nacelles, data.nacelleSlots);
        freeSlots(rotors, data.rotorSlots);
        counts.turbines -= data.turbineCount;
        data.nacelleSlots = new Int32Array(0);
        data.rotorSlots = new Int32Array(0);
      }
      if (data.sockSlots.length > 0) {
        freeSlots(socks, data.sockSlots);
        data.sockSlots = new Int32Array(0);
      }
      if (data.puffSlots.length > 0) {
        freeSlots(puffs, data.puffSlots);
        counts.puffs -= data.puffSlots.length;
        data.puffSlots = new Int32Array(0);
      }
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      releaseMovers(data);
      if (data.steamSlots.length > 0) {
        freeSlots(puffs, data.steamSlots);
        counts.puffs -= data.steamSlots.length;
        data.steamSlots = new Int32Array(0);
      }
      removeTorches(instance, data);
      if (data.blockSlots.length > 0) {
        freeSlots(blocks, data.blockSlots);
        counts.blocks -= data.blockSlots.length;
        data.blockSlots = new Int32Array(0);
      }
    },

    stats() {
      let drawCalls = 0;
      for (let index = 0; index < live.length; index++) {
        const meshes = live[index].data.meshes;
        for (const kind of GEOMETRY_KINDS) if (meshes[kind] && meshes[kind].visible) drawCalls++;
      }
      for (const pool of [nacelles, rotors, socks, puffs, flames, blocks]) if (pool && pool.used > 0) drawCalls++;
      if (moverPools) for (const kind of MOVER_KINDS) drawCalls += moverPools[kind].used;
      return {
        instances: counts.instances,
        particles: 0,
        lights: 0,
        buffers: counts.buffers + counts.movers + (nacelles ? 6 : 0),
        drawCalls,
        turbines: counts.turbines,
        mistPuffs: counts.puffs,
        surfaces: counts.surfaces,
        gatesPassed: counts.gates,
        landingsGraded: counts.landings,
        coursesRun: counts.courses,
        movers: counts.movers,
        flames: counts.flames,
        litFlames: counts.litFlames,
        blocks: counts.blocks,
      };
    },

    /**
     * Sets a live param (the same numbers instance.params holds, which the set-piece engine's ramps
     * write directly): 'glow' (emissive and crystal glow multiplier), 'sway' (sway amplitude
     * multiplier), 'rotorSpeed' (turbine speed multiplier) and 'audio' (voice level multiplier).
     * Returns whether the param is known.
     */
    setParam(instance, name, value) {
      if (!Number.isFinite(value) || !Object.hasOwn(instance.params, name)) return false;
      instance.params[name] = value;
      return true;
    },

    /**
     * Ground-start spots a site offers ([{ x, z, y, heading, runwayLength }]) or null: pure, from the
     * site's resolved stamps (the spawns system asks it for discovered sites; see
     * spawns.findGroundStart).
     */
    groundStart(preset, params, site) {
      const recipe = params && RECIPES[params.recipe];
      if (!recipe || typeof recipe.groundStart !== 'function') return null;
      return recipe.groundStart(site, params);
    },

    /** Recipe names this engine builds (for the debugger and docs). */
    recipes: RECIPE_NAMES,

    /** Frees the shared pools and materials (tests and teardown). */
    teardown() {
      for (const instance of [...live]) engine.dispose(instance);
      for (const kind of GEOMETRY_KINDS) meshPools[kind].dispose();
      for (const kind of MOVER_KINDS) moverPools[kind].dispose();
      for (const pool of [nacelles, rotors, socks, puffs, flames, blocks]) pool.dispose({ keepMaterial: true });
      for (const proxy of proxies) proxy.geometry.dispose();
      proxies = [];
      for (const material of Object.values(materials)) material.dispose();
    },
  };
  return engine;
}

