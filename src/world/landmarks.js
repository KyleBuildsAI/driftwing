import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp, damp, bearingTo } from '../core/util.js';
import { CONFIG } from '../core/config.js';

/**
 * LANDMARKS: procedural set pieces on the world generator's landmark sites.
 * - arch: a natural stone arch with wavy strata and snow / moss / sand caps;
 *   flying through the opening emits `landmark:threaded`.
 * - monoliths: a circle of standing stones with trilithons, an altar, a heel
 *   stone and carved runes that glow at night.
 * - lighthouse: a banded tower with a glowing lantern and rotating beam (plus a
 *   flash toward the viewer), keeper's cottage, rocks, a dock and a rowboat.
 * - balloons: a fair of striped hot-air balloons drifting with the wind whose
 *   burners fire now and then, lighting the envelope from inside.
 * Geometry is built in each landmark's local space (precision-safe far from the
 * origin), one site per frame, and disposed once it falls out of range.
 */
export function createLandmarkSystem(ctx) {
  const { TSL: nodes, scene, camera, world, state, bus, uniforms } = ctx;
  const {
    uniform, vertexColor, float, vec3, sin, smoothstep, pow, abs, dot, saturate, distance,
    positionLocal, positionWorld, cameraPosition, normalView, positionViewDirection,
  } = nodes;

  // ---- Tunables --------------------------------------------------------------------
  const SCAN_INTERVAL_SECONDS = 1;
  const BUILD_MARGIN = 600;
  const DISPOSE_MARGIN = 800;
  const FIND_RADII = [3000, 6000, 12000];
  const DISCOVERY_RADIUS = Object.freeze({ arch: 160, monoliths: 180, lighthouse: 260, balloons: 200 });
  const THREAD_RANGE = 700;
  const THREAD_COOLDOWN_SECONDS = 4;
  const TELEPORT_DISTANCE = 400;
  const BEAM_LENGTH = 250;
  const BEAM_RADIUS = 21;
  const BEAM_TURN_RATE = 0.52;
  const LANTERN_HEIGHT = 36.6;
  const ENVELOPE_HEIGHT = 22;
  const RUNE_HALF_WIDTH = 0.18;
  const RUNE_HALF_DEPTH = 0.2;
  // Height above or below a ground landmark counts half, so flying over one at a
  // sensible altitude (up to about twice the radius) still discovers it.
  const DISCOVERY_VERTICAL_WEIGHT = 0.5;
  const TWO_PI = Math.PI * 2;
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

  // ---- Small math helpers ------------------------------------------------------------
  function lerp(from, to, amount) {
    return from + (to - from) * amount;
  }
  function smooth01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }
  /** Deterministic mulberry32 stream for one site (salt separates concerns). */
  function createRandom(site, salt) {
    let seedState = Math.floor(world.hash2(site.cellX, site.cellZ, 700 + salt) * 4294967296) | 0;
    return function nextRandom() {
      seedState = (seedState + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pickFrom(list, random) {
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  }
  function shuffled(list, random) {
    const copy = list.slice();
    for (let index = copy.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      const held = copy[index];
      copy[index] = copy[swapIndex];
      copy[swapIndex] = held;
    }
    return copy;
  }

  // ---- Colliders (Phase 3 contract b.8) ---------------------------------------------------------------
  // Every landmark lists its colliders while it is built, in its own local frame (the group's position
  // and its rotation about +y), and buildNext registers them with ctx.colliders (owner
  // 'landmark:<siteId>'); removeInstance removes them with the geometry. The shapes follow the rock
  // and the stone as built: arches are box legs and capsule ribs that keep the opening clear, standing
  // stones and lintels are boxes (lintels landable perches), boulders are hulls of their own vertices,
  // the lighthouse is stacked cylinders, and every balloon is two hulls and a basket box that move
  // with it. Props under 2 m tall (paving, path stones, edge rubble below the turf) carry none.
  const colliderWorld = ctx.colliders ?? null;
  const colliderScratch = new THREE.Vector3();
  const colliderBasis = new THREE.Matrix4();
  const colliderTurn = new THREE.Quaternion();

  /**
   * A landmark's collider list in its local frame. add*(part, ...) take local THREE.Vector3 points;
   * specs holds world collider specs (ids 'landmark:<siteId>:<part><n>').
   */
  function createColliderSet(site, originX, originY, originZ, yaw) {
    const origin = new THREE.Vector3(originX, originY, originZ);
    const turn = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
    const owner = `landmark:${site.id}`;
    const specs = [];
    let serial = 0;
    const toWorld = (local) => {
      colliderScratch.copy(local).applyQuaternion(turn).add(origin);
      return { x: colliderScratch.x, y: colliderScratch.y, z: colliderScratch.z };
    };
    const quaternionLiteral = (quaternion) => ({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
    const push = (part, spec) => {
      spec.id = `${owner}:${part}${serial++}`;
      spec.owner = owner;
      specs.push(spec);
      return spec;
    };
    return {
      specs,
      owner,
      toWorld,
      /** An oriented box: local centre, half extents and local rotation (null: the landmark's own). */
      box(part, center, halfX, halfY, halfZ, quaternion, tags) {
        colliderTurn.copy(turn);
        if (quaternion) colliderTurn.multiply(quaternion);
        return push(part, { type: 'box', center: toWorld(center), halfExtents: { x: halfX, y: halfY, z: halfZ }, quaternion: quaternionLiteral(colliderTurn), tags });
      },
      /** A box from its local centre and three local unit axes (a right-handed set), as builder.box. */
      boxAxes(part, center, axisX, axisY, axisZ, halfX, halfY, halfZ, tags) {
        colliderBasis.makeBasis(axisX, axisY, axisZ);
        const local = new THREE.Quaternion().setFromRotationMatrix(colliderBasis);
        return this.box(part, center, halfX, halfY, halfZ, local, tags);
      },
      /** An upright cylinder (axis local +y). */
      cylinder(part, center, radius, halfHeight, tags) {
        return push(part, { type: 'cylinder', center: toWorld(center), radius, halfHeight, quaternion: quaternionLiteral(turn), tags });
      },
      capsule(part, a, b, radius, tags) {
        return push(part, { type: 'capsule', a: toWorld(a), b: toWorld(b), radius, tags });
      },
      /** A hull of local points (at most 64); moving: points stay local to a centre the owner updates. */
      hull(part, points, tags) {
        const flat = new Float64Array(points.length * 3);
        points.forEach((point, index) => {
          const world = toWorld(point);
          flat[index * 3] = world.x;
          flat[index * 3 + 1] = world.y;
          flat[index * 3 + 2] = world.z;
        });
        return push(part, { type: 'hull', points: flat, tags });
      },
      /** A hull that moves: points (local to the moving centre), placed later with setPose. */
      movingHull(part, points, center, tags) {
        const flat = new Float64Array(points.length * 3);
        points.forEach((point, index) => flat.set([point.x, point.y, point.z], index * 3));
        return push(part, { type: 'hull', points: flat, center: toWorld(center), quaternion: quaternionLiteral(turn), tags });
      },
    };
  }

  /** Registers a built landmark's colliders; on a failure removes the ones added and rethrows. */
  function registerColliders(set) {
    const ids = [];
    if (!colliderWorld || !set) return ids;
    try {
      for (const spec of set.specs) ids.push(colliderWorld.add(spec));
    } catch (error) {
      for (const id of ids) colliderWorld.remove(id);
      throw error;
    }
    return ids;
  }

  function removeColliders(instance) {
    if (!colliderWorld || !instance.colliderIds) return;
    for (const id of instance.colliderIds) colliderWorld.remove(id);
    instance.colliderIds.length = 0;
  }

  // ---- Colours (vertex colours are LINEAR; alpha = emissive gain) ---------------------
  const colorScratch = new THREE.Color();
  function linear(hex, alpha = 0) {
    colorScratch.set(hex);
    return [colorScratch.r, colorScratch.g, colorScratch.b, alpha];
  }
  const paintOut = [0, 0, 0, 0];
  function scaled(base, factor) {
    paintOut[0] = base[0] * factor;
    paintOut[1] = base[1] * factor;
    paintOut[2] = base[2] * factor;
    paintOut[3] = base[3];
    return paintOut;
  }
  function blended(base, other, amount, factor) {
    paintOut[0] = lerp(base[0], other[0], amount) * factor;
    paintOut[1] = lerp(base[1], other[1], amount) * factor;
    paintOut[2] = lerp(base[2], other[2], amount) * factor;
    paintOut[3] = lerp(base[3], other[3], amount);
    return paintOut;
  }

  const ARCH_STYLES = {
    dunes: { bands: [0xb4553a, 0xbf5e3c, 0xc96a44, 0xd27d4f, 0xdc9460, 0xcb7048, 0xb85a3b, 0xa9492f], cap: 0xe8c48c, capFrom: 0.5, capAmount: 0.75 },
    snow: { bands: [0x7e838c, 0x8e929a, 0x737882, 0x9ea2a8, 0x868a90], cap: 0xf1f5fa, capFrom: -1, capAmount: 0.95 },
    pine: { bands: [0x7a7f78, 0x8b8f86, 0x6f746e, 0x979a90, 0x80857c], cap: 0x5f7d43, capFrom: 0.2, capAmount: 0.85 },
    archipelago: { bands: [0xd0a660, 0xc2934a, 0xdeb877, 0xb48344, 0xd6ad6c], cap: 0x5f9150, capFrom: 0.3, capAmount: 0.85 },
    meadows: { bands: [0xd6ad66, 0xc69850, 0xe2bf80, 0xba8a4a, 0xdab372], cap: 0x86ad55, capFrom: 0.3, capAmount: 0.85 },
  };
  for (const style of Object.values(ARCH_STYLES)) {
    style.bands = style.bands.map((hex) => linear(hex));
    style.cap = linear(style.cap);
  }

  const STONE_STYLES = {
    snow: { bases: [0x858b96, 0x7a808c, 0x929aa4], cap: 0xf1f5fa, lichen: 0xa4b0a0 },
    pine: { bases: [0x7f857c, 0x737a70, 0x8c9186], cap: 0x5d7b44, lichen: 0x8fa35a },
    dunes: { bases: [0xc89a62, 0xb98a52, 0xd4a970], cap: 0xe3c48f, lichen: 0xa8703e },
    archipelago: { bases: [0x55575e, 0x4a4c53, 0x62636a], cap: 0x5f8f4c, lichen: 0xc98b3c },
    meadows: { bases: [0xbdb6a5, 0xb0a998, 0xcac3b1], cap: 0x86a856, lichen: 0xcdb85a },
  };
  for (const style of Object.values(STONE_STYLES)) {
    style.bases = style.bases.map((hex) => linear(hex));
    style.cap = linear(style.cap);
    style.lichen = linear(style.lichen);
  }

  // Emissive-gain colours: dark by day, glowing at night (alpha x nightGlow).
  const RUNE_COLOR = [0.05, 0.2, 0.18, 9];
  const WINDOW_COLOR = [0.07, 0.045, 0.018, 13];
  const LANTERN_GLASS = [0.95, 0.72, 0.38, 1.3];
  const TOWER_WHITE = linear(0xf2efe8);
  const TOWER_RED = linear(0xb8322a);
  const PLINTH_STONE = linear(0x8d8a85);
  const IRON = linear(0x2c2f38);
  const LANTERN_BASE = linear(0x6e2a24);
  const ROOF_RED = linear(0xa52d25);
  const DOOR_WOOD = linear(0x5b3a26);
  const COTTAGE_WALL = linear(0xece4d4);
  const COTTAGE_ROOFS = [linear(0xb04a32), linear(0x4f5866), linear(0x8a4b3a)];
  const CHIMNEY_STONE = linear(0x8c8577);
  const EAVE_SHADE = linear(0x3a3430);
  const SHORE_ROCKS = [linear(0x5d5a57), linear(0x6d6862), linear(0x4f4c4a)];
  const SUN_BLEACHED = linear(0xd9d6cc);
  const PATH_STONE = linear(0xa39c8e);
  const PLANKS = [linear(0x8a6a4a), linear(0x7a5c3f), linear(0x957453)];
  const DOCK_POST = linear(0x4e3b2a);
  const BOAT_HULL = linear(0xb33a2e);
  const BOAT_TRIM = linear(0xf1e4cf);
  const BOAT_WOOD = linear(0x6e5238);
  const WICKER = linear(0x8b5a2b);
  const WICKER_RIM = linear(0x4f3219);
  const ROPE = linear(0x3b2a1c);
  const BURNER_METAL = linear(0x3a3a40);
  const SKIRT_FABRIC = linear(0x2c2f38, 0.6);
  const MOUTH_INTERIOR = [0.12, 0.05, 0.02, 14];
  const BALLOON_PALETTES = [
    [0xe0703a, 0xf1e4cf, 0x2c2f38],
    [0xd9483b, 0xf6d44c, 0x2f6db3],
    [0x2a9d8f, 0xe9c46a, 0xf4a261],
    [0x6a4c93, 0xf2c94c, 0xf1e4cf],
    [0x3a7ca5, 0xf1e4cf, 0xe0703a],
    [0xc0392b, 0xf5e6c8, 0x3f8f5a],
    [0xe58fa6, 0xf7f1e3, 0x5fb3b6],
    [0xf28c28, 0x5b3f8c, 0xf6e7c1],
  ].map((palette) => palette.map((hex) => linear(hex)));
  const BALLOON_PATTERNS = ['gores', 'spiral', 'harlequin', 'bands', 'crown', 'sunburst'];
  // Unit envelope profile from the mouth (bottom) to the crown: [radius, height].
  const BALLOON_PROFILE = [
    [0.125, -0.05], [0.13, 0], [0.19, 0.07], [0.3, 0.19], [0.41, 0.32], [0.49, 0.46],
    [0.53, 0.6], [0.52, 0.72], [0.46, 0.83], [0.36, 0.91], [0.22, 0.97], [0, 1],
  ];
  // Tower band boundaries (metres); odd bands are red.
  const LIGHTHOUSE_BANDS = [
    [1.6, 8.5, 12.5, 19.5, 23.5, 33.8],
    [1.6, 11, 15, 25, 29, 33.8],
    [1.6, 7, 9.5, 15, 17.5, 23, 25.5, 33.8],
  ];

  // Runic glyphs in glyph units (about 1 wide, 1.6 tall): [x0, y0, x1, y1] strokes.
  const RUNE_GLYPHS = [
    [[0, 0, 0, 1.6], [0, 1.0, 0.55, 1.45], [0, 0.55, 0.55, 1.0]],
    [[0, 0, 0, 1.6], [0, 1.6, -0.5, 1.1], [0, 1.6, 0.5, 1.1]],
    [[0, 0, 0, 1.6], [0, 0.95, -0.5, 1.5], [0, 0.95, 0.5, 1.5]],
    [[-0.45, 0, -0.45, 1.6], [0.45, 0, 0.45, 1.6], [-0.45, 1.6, 0.45, 0], [-0.45, 0, 0.45, 1.6]],
    [[0, 0.3, 0.5, 0.8], [0.5, 0.8, 0, 1.3], [0, 1.3, -0.5, 0.8], [-0.5, 0.8, 0, 0.3]],
    [[-0.4, 1.6, 0.4, 1.05], [0.4, 1.05, -0.4, 0.55], [-0.4, 0.55, 0.4, 0]],
    [[-0.5, 0, 0.5, 1.6], [0.5, 0, -0.5, 1.6]],
    [[0, 0, 0, 1.6], [0, 1.6, 0.5, 1.15]],
    [[-0.35, 0, -0.35, 1.6], [0.35, 0, 0.35, 1.6], [-0.35, 1.0, 0.35, 0.6]],
    [[0.4, 1.6, -0.3, 0.8], [-0.3, 0.8, 0.4, 0]],
    [[0, 0, 0, 1.6], [0, 1.6, 0.45, 1.3], [0.45, 1.3, 0, 1.0]],
  ];

  // ---- Names ------------------------------------------------------------------------------
  const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen'];
  const ARCH_ADJECTIVES = {
    dunes: ['Ember', 'Saffron', 'Cinder', 'Mirage', 'Copper', 'Rust', 'Scarab', 'Amber', 'Sunfire', 'Ochre'],
    snow: ['Frost', 'Glacier', 'Rime', 'Silver', 'Winter', 'Hoarfrost', 'Snowcrown', 'Icefall'],
    pine: ['Moss', 'Fern', 'Raven', 'Elder', 'Timber', 'Owl', 'Lichen', 'Resin'],
    archipelago: ['Coral', 'Tide', 'Gull', 'Salt', 'Heron', 'Pearl', 'Driftwood', 'Surf'],
    meadows: ['Clover', 'Honey', 'Lark', 'Thistle', 'Bramble', 'Poppy', 'Linden', 'Barley'],
  };
  const ARCH_FORMS = ['Arch', 'Gate', 'Span', 'Bridge', 'Window'];
  const ARCH_POSSESSIVES = ["Giant's", "Needle's", "Falcon's", "Moon's", "Sleeper's", "Weaver's", "Wanderer's"];
  const ARCH_PHRASES = ['Quiet Winds', 'Long Shadows', 'the Setting Sun', 'Seven Echoes', 'the Low Moon', 'Held Breath', 'Returning Birds'];
  const MONOLITH_COUNTED = ['Winds', 'Sisters', 'Watchers', 'Stars', 'Kings', 'Lanterns', 'Songs'];
  const MONOLITH_ADJECTIVES = ['Whispering', 'Sleeping', 'Singing', 'Listening', 'Dreaming', 'Silent', 'Patient', 'Wandering'];
  const MONOLITH_NOUNS = ['Moon', 'Starfall', 'Solstice', 'Raven', 'Ember', 'Frost', 'Tide', 'Lantern', 'Hollow', 'Dusk'];
  const LIGHTHOUSE_NOUNS = ['Gull', 'Tern', 'Heron', 'Cormorant', 'Puffin', 'Storm', 'Kestrel', 'Seal', 'Moonwatch', 'Driftwood', 'Salt', 'Curlew', 'Osprey', 'Petrel'];
  const LIGHTHOUSE_FORMS = ['Point Light', 'Rock Light', 'Head Lighthouse', 'Isle Light', 'Point Lighthouse'];
  const LIGHTHOUSE_ADJECTIVES = ['Patient', 'Faithful', 'Watchful', 'Steadfast', 'Lonely', 'Old'];
  const BALLOON_ADJECTIVES = ['Drifting', 'Wandering', 'Dreaming', 'Painted', 'Gentle', 'Idle', 'Floating'];
  const BALLOON_NOUNS = ['Skylark', 'Dandelion', 'Summer', 'Harvest', 'Marigold', 'Thistledown', 'Honeycomb', 'Kite'];
  const BALLOON_PHRASES = ['Slow Skies', 'Warm Air', 'Paper Suns', 'Soft Winds'];

  function countForSite(site) {
    if (site.type === 'monoliths') return 9 + Math.floor(world.hash2(site.cellX, site.cellZ, 731) * 5);
    if (site.type === 'balloons') return 3 + Math.floor(world.hash2(site.cellX, site.cellZ, 732) * 3);
    return 1;
  }

  function nameForSite(site, count) {
    const random = createRandom(site, 3);
    const roll = random();
    const numberWord = NUMBER_WORDS[count] || String(count);
    switch (site.type) {
      case 'arch': {
        const adjective = pickFrom(ARCH_ADJECTIVES[site.biomeKey] || ARCH_ADJECTIVES.meadows, random);
        if (roll < 0.5) return `${adjective} ${pickFrom(ARCH_FORMS, random)}`;
        if (roll < 0.7) return `The ${pickFrom(ARCH_POSSESSIVES, random)} Eye`;
        if (roll < 0.86) return `Arch of ${pickFrom(ARCH_PHRASES, random)}`;
        return `The ${pickFrom(ARCH_POSSESSIVES, random)} ${pickFrom(ARCH_FORMS, random)}`;
      }
      case 'monoliths':
        if (roll < 0.4) return `Circle of ${numberWord} ${pickFrom(MONOLITH_COUNTED, random)}`;
        if (roll < 0.6) return `The ${numberWord} ${pickFrom(MONOLITH_COUNTED, random)}`;
        if (roll < 0.8) return `The ${pickFrom(MONOLITH_ADJECTIVES, random)} Stones`;
        return `${pickFrom(MONOLITH_NOUNS, random)} Henge`;
      case 'lighthouse':
        if (roll < 0.8) return `${pickFrom(LIGHTHOUSE_NOUNS, random)} ${pickFrom(LIGHTHOUSE_FORMS, random)}`;
        return `The ${pickFrom(LIGHTHOUSE_ADJECTIVES, random)} Lamp`;
      default:
        if (roll < 0.55) return `The ${pickFrom(BALLOON_ADJECTIVES, random)} ${numberWord}`;
        if (roll < 0.8) return `${pickFrom(BALLOON_NOUNS, random)} Balloon Fair`;
        return `Festival of ${pickFrom(BALLOON_PHRASES, random)}`;
    }
  }

  const descriptorCache = new Map();
  /** Cheap, cached per-site facts shared by building and queries. */
  function describe(site) {
    let descriptor = descriptorCache.get(site.id);
    if (descriptor === undefined) {
      const count = countForSite(site);
      descriptor = { id: site.id, type: site.type, count, name: nameForSite(site, count) };
      if (descriptorCache.size > 4096) descriptorCache.clear();
      descriptorCache.set(site.id, descriptor);
    }
    return descriptor;
  }

  // ---- Materials (shared; per-frame changes only through uniform values) ----------------
  const nightGlow = uniform(0.05);
  const beamStrength = uniform(0.1);
  const glowFadeNear = uniform(1500);
  const glowFadeFar = uniform(3200);
  const burnGlow = uniform(0).onObjectUpdate(({ object }) => object.userData.burnGlow);
  const objectGlow = uniform(1).onObjectUpdate(({ object }) => object.userData.glow);
  const vertexRgba = vertexColor();
  const shimmer = sin(uniforms.time.mul(1.3).add(positionLocal.y.mul(0.8)).add(positionLocal.x.mul(0.37))).mul(0.1).add(0.9);
  const viewFacing = saturate(dot(normalView, positionViewDirection));
  const distanceFade = float(1).sub(smoothstep(glowFadeNear, glowFadeFar, distance(positionWorld, cameraPosition)));

  const solidMaterial = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.9, metalness: 0 });
  solidMaterial.colorNode = vertexRgba.rgb;
  solidMaterial.emissiveNode = vertexRgba.rgb.mul(vertexRgba.a).mul(nightGlow).mul(shimmer);

  const balloonMaterial = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.72, metalness: 0 });
  balloonMaterial.colorNode = vertexRgba.rgb;
  // Burner light glows warm through the fabric (strongest near the mouth).
  balloonMaterial.emissiveNode = vertexRgba.rgb.mul(vec3(1.0, 0.72, 0.42)).mul(vertexRgba.a).mul(burnGlow);

  const glowMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  glowMaterial.colorNode = vertexRgba.rgb;
  glowMaterial.opacityNode = pow(viewFacing, 1.8).mul(objectGlow).mul(distanceFade);

  const beamAlong = saturate(positionLocal.x.div(BEAM_LENGTH));
  const beamProfile = pow(float(1).sub(beamAlong), 1.7).mul(smoothstep(0, 0.03, beamAlong));
  const beamMaterial = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  beamMaterial.colorNode = vec3(1.25, 1.0, 0.68);
  beamMaterial.opacityNode = beamProfile.mul(pow(abs(dot(normalView, positionViewDirection)), 1.4)).mul(beamStrength).mul(distanceFade);

  // ---- Shared geometries ---------------------------------------------------------------
  function addGradientColors(geometry, bottomColor, topColor, height) {
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 4);
    for (let index = 0; index < positions.count; index++) {
      const amount = clamp(positions.getY(index) / height, 0, 1);
      for (let channel = 0; channel < 4; channel++) colors[index * 4 + channel] = lerp(bottomColor[channel], topColor[channel], amount);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    return geometry;
  }
  const beamGeometry = new THREE.ConeGeometry(BEAM_RADIUS, BEAM_LENGTH, 28, 1, true);
  beamGeometry.translate(0, -BEAM_LENGTH / 2, 0);
  beamGeometry.rotateZ(Math.PI / 2);
  const haloGeometry = addGradientColors(new THREE.IcosahedronGeometry(1, 2), [2.2, 1.7, 1.0, 1], [2.2, 1.7, 1.0, 1], 1);
  const runeLightGeometry = addGradientColors(new THREE.IcosahedronGeometry(1, 2), [0.25, 1.1, 0.95, 1], [0.25, 1.1, 0.95, 1], 1);
  // Landmark meshes are built lazily as sites come into range; register one proxy per material
  // (same attribute layout: position, normal, RGBA colour) so core compiles them during the fade.
  function registerLandmarkPrewarm() {
    const solidProxy = new THREE.Mesh(haloGeometry, solidMaterial);
    const balloonProxy = new THREE.Mesh(haloGeometry, balloonMaterial);
    for (const proxy of [solidProxy, balloonProxy]) {
      proxy.castShadow = true;
      proxy.receiveShadow = true;
    }
    for (const proxy of [solidProxy, balloonProxy, new THREE.Mesh(runeLightGeometry, glowMaterial), new THREE.Mesh(beamGeometry, beamMaterial)]) {
      ctx.registerPrewarm?.(proxy);
    }
  }
  registerLandmarkPrewarm();
  const flameGeometry = addGradientColors(
    new THREE.LatheGeometry([0, 0.32, 0.5, 0.42, 0.24, 0].map((radius, index) => new THREE.Vector2(radius, [0, 0.3, 0.9, 1.7, 2.5, 3.3][index])), 10),
    [3.0, 2.4, 1.3, 1],
    [2.4, 0.7, 0.12, 1],
    3.3,
  );

  // ---- Geometry builder: flat-shaded, vertex-coloured triangle soup --------------------
  function createIcosphere(detail) {
    const golden = (1 + Math.sqrt(5)) / 2;
    const vertices = [
      [-1, golden, 0], [1, golden, 0], [-1, -golden, 0], [1, -golden, 0], [0, -1, golden], [0, 1, golden],
      [0, -1, -golden], [0, 1, -golden], [golden, 0, -1], [golden, 0, 1], [-golden, 0, -1], [-golden, 0, 1],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());
    let faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for (let level = 0; level < detail; level++) {
      const midpoints = new Map();
      const midpoint = (indexA, indexB) => {
        const key = indexA < indexB ? indexA * 4096 + indexB : indexB * 4096 + indexA;
        let index = midpoints.get(key);
        if (index === undefined) {
          index = vertices.length;
          vertices.push(new THREE.Vector3().addVectors(vertices[indexA], vertices[indexB]).normalize());
          midpoints.set(key, index);
        }
        return index;
      };
      faces = faces.flatMap(([indexA, indexB, indexC]) => {
        const ab = midpoint(indexA, indexB);
        const bc = midpoint(indexB, indexC);
        const ca = midpoint(indexC, indexA);
        return [[indexA, ab, ca], [indexB, bc, ab], [indexC, ca, bc], [ab, bc, ca]];
      });
    }
    return { vertices, faces };
  }
  const icosphereCoarse = createIcosphere(0);
  const icosphereFine = createIcosphere(1);
  const BOX_FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];

  function createBuilder() {
    const positions = [];
    const normals = [];
    const colors = [];
    const transform = new THREE.Matrix4();
    let transformActive = false;
    const vertexA = new THREE.Vector3();
    const vertexB = new THREE.Vector3();
    const vertexC = new THREE.Vector3();
    const edgeB = new THREE.Vector3();
    const edgeC = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();
    const reference = new THREE.Vector3();
    const swap = new THREE.Vector3();
    const axisPoint = new THREE.Vector3();
    const quadColor = [0, 0, 0, 0];
    const boxCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
    // Face info handed to paint callbacks (final, landmark-local coordinates).
    const face = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ring: 0, index: 0 };

    /** Adds one triangle; flips it so its normal points away from outwardFrom. */
    function triangle(pointA, pointB, pointC, paint, outwardFrom) {
      vertexA.copy(pointA);
      vertexB.copy(pointB);
      vertexC.copy(pointC);
      if (transformActive) {
        vertexA.applyMatrix4(transform);
        vertexB.applyMatrix4(transform);
        vertexC.applyMatrix4(transform);
      }
      edgeB.subVectors(vertexB, vertexA);
      edgeC.subVectors(vertexC, vertexA);
      faceNormal.crossVectors(edgeB, edgeC);
      const length = faceNormal.length();
      if (!(length > 1e-9)) return null;
      faceNormal.multiplyScalar(1 / length);
      face.x = (vertexA.x + vertexB.x + vertexC.x) / 3;
      face.y = (vertexA.y + vertexB.y + vertexC.y) / 3;
      face.z = (vertexA.z + vertexB.z + vertexC.z) / 3;
      if (outwardFrom) {
        reference.copy(outwardFrom);
        if (transformActive) reference.applyMatrix4(transform);
        const outward = (face.x - reference.x) * faceNormal.x + (face.y - reference.y) * faceNormal.y + (face.z - reference.z) * faceNormal.z;
        if (outward < 0) {
          swap.copy(vertexB);
          vertexB.copy(vertexC);
          vertexC.copy(swap);
          faceNormal.negate();
        }
      }
      face.nx = faceNormal.x;
      face.ny = faceNormal.y;
      face.nz = faceNormal.z;
      const color = typeof paint === 'function' ? paint(face) : paint;
      positions.push(vertexA.x, vertexA.y, vertexA.z, vertexB.x, vertexB.y, vertexB.z, vertexC.x, vertexC.y, vertexC.z);
      for (let corner = 0; corner < 3; corner++) {
        normals.push(faceNormal.x, faceNormal.y, faceNormal.z);
        colors.push(color[0], color[1], color[2], color[3]);
      }
      return color;
    }

    /** Two triangles sharing one colour (so flat quads read as one facet). */
    function quad(pointA, pointB, pointC, pointD, paint, outwardFrom) {
      const color = triangle(pointA, pointB, pointC, paint, outwardFrom);
      if (color === null) {
        triangle(pointA, pointC, pointD, paint, outwardFrom);
        return;
      }
      quadColor[0] = color[0];
      quadColor[1] = color[1];
      quadColor[2] = color[2];
      quadColor[3] = color[3];
      triangle(pointA, pointC, pointD, quadColor, outwardFrom);
    }

    function centroidOf(ring) {
      const center = new THREE.Vector3();
      for (const point of ring) center.add(point);
      return center.multiplyScalar(1 / ring.length);
    }

    function fan(ring, center, paint, inside) {
      for (let index = 0; index < ring.length; index++) {
        face.index = index;
        triangle(center, ring[index], ring[(index + 1) % ring.length], paint, inside);
      }
    }

    /** Skins consecutive rings (equal point counts) into a closed tube. */
    function loft(rings, paint, options = {}) {
      const centers = rings.map(centroidOf);
      const pointCount = rings[0].length;
      for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex++) {
        axisPoint.addVectors(centers[ringIndex], centers[ringIndex + 1]).multiplyScalar(0.5);
        const lower = rings[ringIndex];
        const upper = rings[ringIndex + 1];
        for (let index = 0; index < pointCount; index++) {
          const next = (index + 1) % pointCount;
          face.ring = ringIndex;
          face.index = index;
          quad(lower[index], lower[next], upper[next], upper[index], paint, axisPoint);
        }
      }
      if (options.capStart) {
        face.ring = -1;
        fan(rings[0], centers[0], paint, centers[1]);
      }
      if (options.capEnd) {
        const last = rings.length - 1;
        face.ring = rings.length;
        fan(rings[last], centers[last], paint, centers[last - 1]);
      }
      face.ring = 0;
    }

    function box(center, axisX, axisY, axisZ, halfX, halfY, halfZ, paint) {
      for (let corner = 0; corner < 8; corner++) {
        boxCorners[corner]
          .copy(center)
          .addScaledVector(axisX, corner & 4 ? halfX : -halfX)
          .addScaledVector(axisY, corner & 2 ? halfY : -halfY)
          .addScaledVector(axisZ, corner & 1 ? halfZ : -halfZ);
      }
      for (const [first, second, third, fourth] of BOX_FACES) {
        quad(boxCorners[first], boxCorners[second], boxCorners[third], boxCorners[fourth], paint, center);
      }
    }

    /** Jittered, squashed icosphere boulder. */
    function rock(center, radius, random, paint, options = {}) {
      const shape = radius > 3.5 ? icosphereFine : icosphereCoarse;
      const squash = options.squash ?? 0.72;
      const jitter = options.jitter ?? 0.24;
      const yaw = random() * TWO_PI;
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const points = shape.vertices.map((vertex) => {
        const scale = radius * (1 - jitter + 2 * jitter * random());
        const rotatedX = vertex.x * cosYaw - vertex.z * sinYaw;
        const rotatedZ = vertex.x * sinYaw + vertex.z * cosYaw;
        return new THREE.Vector3(center.x + rotatedX * scale, center.y + vertex.y * scale * squash, center.z + rotatedZ * scale);
      });
      for (const [indexA, indexB, indexC] of shape.faces) triangle(points[indexA], points[indexB], points[indexC], paint, center);
      // The vertices (builder space, before any transform): a boulder's collider hull.
      return points;
    }

    function build() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
      geometry.computeBoundingSphere();
      return geometry;
    }

    return {
      triangle,
      quad,
      fan,
      loft,
      box,
      rock,
      build,
      setTransform(matrix) {
        transform.copy(matrix);
        transformActive = true;
      },
      clearTransform() {
        transformActive = false;
      },
    };
  }

  function circleRing(centerX, centerY, centerZ, radius, segments, phase = 0) {
    const ring = [];
    for (let index = 0; index < segments; index++) {
      const angle = phase + (index / segments) * TWO_PI;
      ring.push(new THREE.Vector3(centerX + Math.cos(angle) * radius, centerY, centerZ + Math.sin(angle) * radius));
    }
    return ring;
  }

  const strokeStart = new THREE.Vector3();
  const strokeEnd = new THREE.Vector3();
  const strokeAlong = new THREE.Vector3();
  const strokeAcross = new THREE.Vector3();
  const strokeCenter = new THREE.Vector3();
  /** Raised rune strokes on a plane (origin, right, up) with outward normal. */
  function carveGlyph(builder, glyph, origin, right, up, normal, scale) {
    for (const [startX, startY, endX, endY] of glyph) {
      strokeStart.copy(origin).addScaledVector(right, startX * scale).addScaledVector(up, startY * scale);
      strokeEnd.copy(origin).addScaledVector(right, endX * scale).addScaledVector(up, endY * scale);
      strokeAlong.subVectors(strokeEnd, strokeStart);
      const length = strokeAlong.length();
      if (length < 1e-4) continue;
      strokeAlong.multiplyScalar(1 / length);
      strokeAcross.crossVectors(normal, strokeAlong).normalize();
      strokeCenter.addVectors(strokeStart, strokeEnd).multiplyScalar(0.5);
      builder.box(strokeCenter, strokeAlong, strokeAcross, normal, length * 0.5 + RUNE_HALF_WIDTH, RUNE_HALF_WIDTH, RUNE_HALF_DEPTH, RUNE_COLOR);
    }
  }

  function solidMesh(geometry, material = solidMaterial) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
  function freeze(object) {
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  }
  /** Discovery distance to a ground landmark's focus point (height counts half). */
  function focusDistance(focus) {
    return (player) => {
      const dx = player.x - focus.x;
      const dy = (player.y - focus.y) * DISCOVERY_VERTICAL_WEIGHT;
      const dz = player.z - focus.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
  }

  // ---- Arch --------------------------------------------------------------------------------
  const FOOT_SAMPLES = [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]];
  const ARCH_RING_POINTS = 12;
  const ARCH_STEPS = 30;

  /** Seeded proportions of one arch: span, height, leg and top sections, lean. */
  function createArchShape(site) {
    const random = createRandom(site, 11);
    const style = ARCH_STYLES[site.biomeKey] || ARCH_STYLES.meadows;
    const span = 60 + 50 * site.variant;
    const height = clamp(0.45 * span + 16 + 22 * random(), 45, 80);
    const halfSpan = span * 0.5;
    const legThickness = [20 + 8 * random(), 20 + 8 * random()];
    const topThickness = 11 + 5 * random();
    const legDepth = 22 + 8 * random();
    const topDepth = 13 + 6 * random();
    const lean = (random() - 0.5) * 0.1;
    const skew = (random() - 0.5) * 0.16 * halfSpan;
    const wobble = (random() - 0.5) * 6;
    return { site, random, style, span, height, halfSpan, legThickness, topThickness, legDepth, topDepth, lean, skew, wobble };
  }

  /** Lowest and highest ground under one foot for a trial orientation. */
  function archFootRange(arch, sideIndex, cosAngle, sinAngle) {
    const { site, halfSpan, legThickness, legDepth } = arch;
    const centerX = (sideIndex === 0 ? -1 : 1) * halfSpan;
    let min = Infinity;
    let max = -Infinity;
    for (const [offsetX, offsetZ] of FOOT_SAMPLES) {
      const localX = centerX + offsetX * legThickness[sideIndex] * 0.5;
      const localZ = offsetZ * legDepth * 0.5;
      const ground = world.groundHeight(site.x + localX * cosAngle + localZ * sinAngle, site.z - localX * sinAngle + localZ * cosAngle);
      min = Math.min(min, ground);
      max = Math.max(max, ground);
    }
    return { min, max };
  }

  /** Turns the span (deterministically) so both feet stand on similar ground. */
  function chooseArchRotation(arch) {
    const { site } = arch;
    let rotation = site.rotation;
    let feet = null;
    let bestScore = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      const trial = site.rotation + (candidate * Math.PI) / 8;
      const cosTrial = Math.cos(trial);
      const sinTrial = Math.sin(trial);
      const trialFeet = [archFootRange(arch, 0, cosTrial, sinTrial), archFootRange(arch, 1, cosTrial, sinTrial)];
      const imbalance = Math.abs(trialFeet[0].min + trialFeet[0].max - trialFeet[1].min - trialFeet[1].max) * 0.5;
      const unevenness = trialFeet[0].max - trialFeet[0].min + trialFeet[1].max - trialFeet[1].min;
      const score = imbalance + 0.3 * unevenness;
      if (score < bestScore) {
        bestScore = score;
        rotation = trial;
        feet = trialFeet;
      }
    }
    return { rotation, feet };
  }

  /** Base height, buried leg bottoms and local-to-world helpers for the chosen rotation. */
  function seatArch(arch, orientation) {
    const { site, height } = arch;
    const { rotation, feet } = orientation;
    const cosRotation = Math.cos(rotation);
    const sinRotation = Math.sin(rotation);
    const worldX = (localX, localZ) => site.x + localX * cosRotation + localZ * sinRotation;
    const worldZ = (localX, localZ) => site.z - localX * sinRotation + localZ * cosRotation;
    const centerGround = world.groundHeight(site.x, site.z);
    const baseY = Math.max(feet[0].max, feet[1].max, centerGround - height * 0.3) - 0.5;
    const bottoms = [feet[0].min - baseY - 15, feet[1].min - baseY - 15];
    return { rotation, cosRotation, sinRotation, worldX, worldZ, baseY, bottoms };
  }

  function archLegFrame(arch, sideIndex, fraction) {
    const side = sideIndex === 0 ? -1 : 1;
    const y = arch.bottoms[sideIndex] * fraction;
    return {
      x: side * (arch.halfSpan + 2.5 * fraction), y, z: arch.lean * y, nx: side, ny: 0,
      thickness: arch.legThickness[sideIndex] * (1 + 0.45 * fraction),
      depth: arch.legDepth * (1 + 0.35 * fraction),
    };
  }

  /** One frame of the half-ellipse, thinning from the legs toward the crown. */
  function archSpanFrame(arch, step) {
    const { random, height, halfSpan, legThickness, topThickness, legDepth, topDepth, lean, skew, wobble } = arch;
    const stepJitter = step > 0 && step < ARCH_STEPS ? (random() - 0.5) * 0.45 : 0;
    const angle = ((step + stepJitter) / ARCH_STEPS) * Math.PI;
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    const normalX = -height * cosAngle;
    const normalY = halfSpan * sinAngle;
    const normalLength = Math.hypot(normalX, normalY);
    const legBlend = lerp(legThickness[0], legThickness[1], step / ARCH_STEPS);
    const y = height * sinAngle;
    return {
      x: -halfSpan * cosAngle + skew * sinAngle,
      y,
      z: lean * y + wobble * Math.sin(2 * angle) * 0.5,
      nx: normalX / normalLength,
      ny: normalY / normalLength,
      thickness: topThickness + (legBlend - topThickness) * Math.pow(1 - sinAngle, 0.9),
      depth: topDepth + (legDepth - topDepth) * Math.pow(1 - sinAngle, 0.8),
    };
  }

  /** Centre-line frames: left leg (bottom-up), the half-ellipse, right leg (top-down). */
  function buildArchFrames(arch) {
    const frames = [];
    for (const fraction of [1, 0.6, 0.25]) frames.push(archLegFrame(arch, 0, fraction));
    for (let step = 0; step <= ARCH_STEPS; step++) frames.push(archSpanFrame(arch, step));
    for (const fraction of [0.25, 0.6, 1]) frames.push(archLegFrame(arch, 1, fraction));
    return frames;
  }

  /**
   * Lumpy cross-sections: a coarse random field every 3 frames, eased, plus gentle
   * bulges of the centre line so the span never reads as a tube. Also returns the
   * inner outline (x, y pairs) used to detect threading.
   */
  function buildArchRings(arch, frames) {
    const { random } = arch;
    const fieldStride = ARCH_RING_POINTS + 2;
    const coarseRows = Math.ceil(frames.length / 3) + 2;
    const field = Array.from({ length: coarseRows * fieldStride }, () => random() * 2 - 1);
    const fieldAt = (frameIndex, pointIndex) => {
      const row = Math.floor(frameIndex / 3);
      const blend = smooth01((frameIndex % 3) / 3);
      return lerp(field[row * fieldStride + pointIndex], field[(row + 1) * fieldStride + pointIndex], blend);
    };
    const innerOutline = [];
    const rings = frames.map((frame, frameIndex) => {
      const ring = [];
      const bulge = 2.2 * fieldAt(frameIndex, ARCH_RING_POINTS);
      const girth = 1 + 0.2 * fieldAt(frameIndex, ARCH_RING_POINTS + 1);
      frame.thickness *= girth;
      frame.depth *= 2 - girth;
      frame.x += frame.nx * bulge;
      frame.y += frame.ny * bulge;
      for (let pointIndex = 0; pointIndex < ARCH_RING_POINTS; pointIndex++) {
        const angle = (pointIndex / ARCH_RING_POINTS) * TWO_PI;
        const jitter = 1 + 0.24 * fieldAt(frameIndex, pointIndex) + 0.08 * (random() * 2 - 1);
        const radial = Math.cos(angle) * frame.thickness * 0.5 * jitter;
        const lateral = Math.sin(angle) * frame.depth * 0.5 * jitter;
        ring.push(new THREE.Vector3(frame.x + frame.nx * radial, frame.y + frame.ny * radial, frame.z + lateral));
      }
      const inner = ring[ARCH_RING_POINTS / 2];
      innerOutline.push(inner.x, inner.y);
      return ring;
    });
    return { rings, innerOutline };
  }

  /** Strata: wide, gently dipping bands (subtle for granite), caps on top faces. */
  function createArchPaint(arch) {
    const { site, random, style, height } = arch;
    const bandHeight = style.capFrom < 0 || site.biomeKey === 'pine' ? 11 + 6 * random() : 6.5 + 5 * random();
    const bandPhase = random() * 20;
    const bandDip = (random() - 0.5) * 0.16;
    const capFromY = style.capFrom < 0 ? -Infinity : height * style.capFrom;
    const capThreshold = style.capFrom < 0 ? 0.3 : 0.45;
    const bandCount = style.bands.length;
    return (face) => {
      const wave = 1.8 * Math.sin(face.x * 0.04 + face.z * 0.03 + bandPhase);
      const band = Math.floor((face.y + bandPhase + wave + face.x * bandDip) / bandHeight);
      const base = style.bands[((band % bandCount) + bandCount) % bandCount];
      let factor = 0.95 + 0.09 * random();
      if (face.ny > capThreshold && face.y > capFromY) {
        const capAmount = style.capAmount * smooth01((face.ny - capThreshold) / 0.3);
        return blended(base, style.cap, capAmount, lerp(factor, 1, capAmount));
      }
      if (face.ny < -0.45) factor *= 0.74;
      if (face.y < 3) factor *= 0.9;
      return scaled(base, factor);
    };
  }

  /**
   * Weathered rock masses along the outer flanks break the silhouette (kept off the
   * inner edge so the opening matches the threading outline).
   */
  function addArchMasses(builder, arch, frames, paintRock, rocks) {
    const { random } = arch;
    const massCenter = new THREE.Vector3();
    for (let frameIndex = 2; frameIndex < frames.length - 2; frameIndex += 3) {
      const frame = frames[frameIndex];
      if (frame.y < -2) continue;
      const around = (random() - 0.5) * 3.6;
      const reach = 0.2 + 0.16 * random();
      const radial = Math.cos(around) * frame.thickness * reach;
      const lateral = Math.sin(around) * frame.depth * reach;
      massCenter.set(frame.x + frame.nx * radial, frame.y + frame.ny * radial, frame.z + lateral);
      const radius = Math.min(frame.thickness, frame.depth) * (0.34 + 0.14 * random());
      rocks.push(builder.rock(massCenter, radius, random, paintRock, { squash: 0.55 + 0.25 * random(), jitter: 0.28 }));
    }
  }

  /** Massive boulders merged into the feet and outer flanks, then loose rubble. */
  function addArchRubble(builder, arch, paintRock, rocks) {
    const { random, halfSpan, legThickness, legDepth, baseY, worldX, worldZ } = arch;
    const rubbleCenter = new THREE.Vector3();
    const addRubble = (localX, localZ, radius, buryFraction) => {
      const ground = world.groundHeight(worldX(localX, localZ), worldZ(localX, localZ)) - baseY;
      rubbleCenter.set(localX, ground + radius * (0.35 - buryFraction), localZ);
      rocks.push(builder.rock(rubbleCenter, radius, random, paintRock, { squash: 0.8, jitter: 0.26 }));
    };
    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const side = sideIndex === 0 ? -1 : 1;
      const footX = side * (halfSpan + 2);
      for (let index = 0; index < 3; index++) {
        const radius = legThickness[sideIndex] * (0.38 + 0.18 * random());
        addRubble(footX + side * radius * (0.35 + 0.4 * random()), (index - 1) * legDepth * 0.45, radius, 0.35);
      }
      const rubbleCount = 4 + Math.floor(random() * 3);
      for (let index = 0; index < rubbleCount; index++) {
        const angle = random() * TWO_PI;
        const reach = legThickness[sideIndex] * (0.9 + 0.8 * random());
        addRubble(footX + Math.cos(angle) * reach, Math.sin(angle) * reach * 1.1, 2 + 3.5 * random() ** 1.5, 0.2);
      }
    }
    for (let index = 0; index < 3; index++) {
      addRubble((random() - 0.5) * halfSpan * 0.9, (random() - 0.5) * legDepth * 2.2, 2 + 3 * random(), 0.25);
    }
  }

  /** Wraps the arch geometry in its placed group with discovery and threading data. */
  function createArchInstance(arch, geometry, innerOutline) {
    const { site, baseY, rotation, height, topThickness, skew, span, worldX, worldZ } = arch;
    const mesh = solidMesh(geometry);
    const group = new THREE.Group();
    group.position.set(site.x, baseY, site.z);
    group.rotation.y = rotation;
    group.add(mesh);
    freeze(mesh);
    freeze(group);
    const focus = new THREE.Vector3(site.x, baseY + height * 0.45, site.z);
    const innerHeight = height - topThickness * 0.5;
    const aimLocalX = skew * 0.8;
    return {
      group,
      geometries: [geometry],
      triangles: geometry.attributes.position.count / 3,
      measure: focusDistance(focus),
      animate: null,
      balloons: null,
      thread: {
        polygon: Float64Array.from(innerOutline),
        baseY,
        cos: arch.cosRotation,
        sin: arch.sinRotation,
        lastTime: -Infinity,
        // Centre of the opening in world space (useful for guidance and tests).
        aim: { x: worldX(aimLocalX, 0), y: baseY + innerHeight * 0.42, z: worldZ(aimLocalX, 0) },
        span,
        height,
      },
    };
  }

  /**
   * The arch's colliders, from the rings as built: per segment between two frames, a cross-section
   * from the ring points (radial and lateral extents around the frame's centre line). Steep segments
   * (the legs) are oriented boxes; the rest of the span is rows of capsules (ribs) across its depth.
   * Every piece keeps its inner face at the ring's innermost point, so the opening stays clear and
   * landmark:threaded is unchanged.
   */
  function addArchColliders(set, frames, rings, rocks) {
    const sections = frames.map((frame, index) => {
      let radialMin = Infinity;
      let radialMax = -Infinity;
      let lateralMin = Infinity;
      let lateralMax = -Infinity;
      for (const point of rings[index]) {
        const radial = (point.x - frame.x) * frame.nx + (point.y - frame.y) * frame.ny;
        const lateral = point.z - frame.z;
        radialMin = Math.min(radialMin, radial);
        radialMax = Math.max(radialMax, radial);
        lateralMin = Math.min(lateralMin, lateral);
        lateralMax = Math.max(lateralMax, lateral);
      }
      return { radialMin, radialMax, lateralMin, lateralMax };
    });
    const zAxis = new THREE.Vector3(0, 0, 1);
    const tags = { surface: 'stone' };
    for (let index = 0; index < frames.length - 1; index++) {
      const first = frames[index];
      const second = frames[index + 1];
      const sectionA = sections[index];
      const sectionB = sections[index + 1];
      const radius = Math.max(sectionA.radialMax - sectionA.radialMin, sectionB.radialMax - sectionB.radialMin) * 0.5;
      // The axis sits one radius out from each end's innermost point.
      const axisA = sectionA.radialMin + radius;
      const axisB = sectionB.radialMin + radius;
      const width = Math.max(sectionA.lateralMax - sectionA.lateralMin, sectionB.lateralMax - sectionB.lateralMin);
      const lateralA = (sectionA.lateralMin + sectionA.lateralMax) * 0.5;
      const lateralB = (sectionB.lateralMin + sectionB.lateralMax) * 0.5;
      const ax = first.x + first.nx * axisA;
      const ay = first.y + first.ny * axisA;
      const bx = second.x + second.nx * axisB;
      const by = second.y + second.ny * axisB;
      const dx = bx - ax;
      const dy = by - ay;
      if (Math.abs(dy) > 2 * Math.abs(dx)) {
        const length = Math.hypot(dx, dy);
        const along = new THREE.Vector3(dx / length, dy / length, 0);
        const radial = new THREE.Vector3(-along.y, along.x, 0);
        const center = new THREE.Vector3((ax + bx) * 0.5, (ay + by) * 0.5, (first.z + lateralA + second.z + lateralB) * 0.5);
        set.boxAxes('leg', center, along, radial, zAxis, length * 0.5 + radius * 0.5, radius, width * 0.5, tags);
        continue;
      }
      const rows = Math.max(1, Math.ceil(width / (2 * radius)));
      const spread = Math.max(0, width * 0.5 - radius);
      for (let row = 0; row < rows; row++) {
        const offset = rows === 1 ? 0 : -spread + (2 * spread * row) / (rows - 1);
        set.capsule('rib', new THREE.Vector3(ax, ay, first.z + lateralA + offset), new THREE.Vector3(bx, by, second.z + lateralB + offset), radius, tags);
      }
    }
    for (const points of rocks) set.hull('rock', points, tags);
  }

  function buildArch(site) {
    const arch = createArchShape(site);
    Object.assign(arch, seatArch(arch, chooseArchRotation(arch)));
    const frames = buildArchFrames(arch);
    const { rings, innerOutline } = buildArchRings(arch, frames);
    const paintRock = createArchPaint(arch);
    const builder = createBuilder();
    builder.loft(rings, paintRock, { capStart: true, capEnd: true });
    const rocks = [];
    addArchMasses(builder, arch, frames, paintRock, rocks);
    addArchRubble(builder, arch, paintRock, rocks);
    const instance = createArchInstance(arch, builder.build(), innerOutline);
    instance.colliders = createColliderSet(site, site.x, arch.baseY, site.z, arch.rotation);
    addArchColliders(instance.colliders, frames, rings, rocks);
    return instance;
  }

  // ---- Monolith circle ---------------------------------------------------------------------
  function stoneRing(halfWidth, halfDepth, y, random, jitter, twist) {
    const cosTwist = Math.cos(twist);
    const sinTwist = Math.sin(twist);
    const chamfer = Math.min(halfWidth, halfDepth) * 0.45;
    const outline = [
      [halfWidth, -halfDepth + chamfer], [halfWidth, halfDepth - chamfer],
      [halfWidth - chamfer, halfDepth], [-halfWidth + chamfer, halfDepth],
      [-halfWidth, halfDepth - chamfer], [-halfWidth, -halfDepth + chamfer],
      [-halfWidth + chamfer, -halfDepth], [halfWidth - chamfer, -halfDepth],
    ];
    return outline.map(([x, z], index) => {
      const onInnerFace = index === 2 || index === 3;
      const jitterX = (random() * 2 - 1) * jitter;
      const jitterZ = (random() * 2 - 1) * (onInnerFace ? 0.03 : jitter);
      const jitterY = (random() * 2 - 1) * jitter * 0.8;
      const pointX = x + jitterX;
      const pointZ = z + jitterZ;
      return new THREE.Vector3(pointX * cosTwist - pointZ * sinTwist, y + jitterY, pointX * sinTwist + pointZ * cosTwist);
    });
  }

  /** Standing stone in stone space (+z faces the circle centre). Returns depth(y). */
  function addStandingStone(builder, random, spec, paint) {
    const { width, depth, height, sink, flatTop } = spec;
    const levels = [-sink, height * 0.36, height * 0.72, height];
    const widthTaper = [1.08, 1.0, 0.93, flatTop ? 0.92 : 0.8];
    const depthTaper = [1.05, 1.0, 0.95, flatTop ? 0.92 : 0.86];
    let twist = 0;
    const rings = levels.map((y, level) => {
      if (level > 0) twist += (random() - 0.5) * 0.09;
      return stoneRing(width * 0.5 * widthTaper[level], depth * 0.5 * depthTaper[level], y, random, level === 0 ? 0.05 : 0.2, twist);
    });
    builder.loft(rings, paint, { capStart: true, capEnd: flatTop });
    if (!flatTop) {
      const peak = new THREE.Vector3((random() - 0.5) * width * 0.25, height + 0.3 + 0.6 * random(), (random() - 0.5) * depth * 0.2);
      builder.fan(rings[rings.length - 1], peak, paint, new THREE.Vector3(0, height * 0.6, 0));
    }
    return (y) => {
      for (let level = 0; level < levels.length - 1; level++) {
        if (y <= levels[level + 1]) {
          const amount = (y - levels[level]) / (levels[level + 1] - levels[level]);
          return depth * 0.5 * lerp(depthTaper[level], depthTaper[level + 1], amount);
        }
      }
      return depth * 0.5 * depthTaper[depthTaper.length - 1];
    };
  }

  // Scratch transform for placing stones (landmarks are built one at a time).
  const stonePosition = new THREE.Vector3();
  const stoneQuaternion = new THREE.Quaternion();
  const stoneEuler = new THREE.Euler();
  const stoneMatrix = new THREE.Matrix4();
  const runeOrigin = new THREE.Vector3();

  function yawToCenter(localX, localZ) {
    return Math.atan2(-localX, -localZ);
  }

  /** Per-build state shared by the monolith helpers; stoneBase tints paintStone. */
  function createStoneCircle(site, descriptor) {
    const random = createRandom(site, 23);
    const style = STONE_STYLES[site.biomeKey] || STONE_STYLES.meadows;
    const baseY = world.groundHeight(site.x, site.z);
    const circle = {
      site,
      random,
      style,
      count: descriptor.count,
      radius: 28 + 12 * site.variant,
      baseY,
      localGround: (localX, localZ) => world.groundHeight(site.x + localX, site.z + localZ) - baseY,
      builder: createBuilder(),
      stoneBase: style.bases[0],
      paintStone: null,
      colliders: createColliderSet(site, site.x, baseY, site.z, 0),
    };
    circle.paintStone = (face) => {
      let factor = 0.9 + 0.16 * random();
      if (face.ny > 0.62) return blended(circle.stoneBase, style.cap, 0.85, 0.96 + 0.06 * random());
      if (face.ny < -0.3) factor *= 0.74;
      if (face.y < 1.2) factor *= 0.86;
      if (random() < 0.12) return blended(circle.stoneBase, style.lichen, 0.5, factor);
      return scaled(circle.stoneBase, factor);
    };
    return circle;
  }

  /** One or two glyphs up the inner face of a standing stone (stone space). */
  function carveStoneRunes(circle, spec, depthAt) {
    const glyphScale = clamp(spec.width * 0.3, 0.95, 1.3);
    const glyphCount = spec.height > 14 ? 2 : 1;
    let glyphY = spec.height * 0.4;
    for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex++) {
      runeOrigin.set(0, glyphY, depthAt(glyphY + 0.8 * glyphScale));
      carveGlyph(circle.builder, pickFrom(RUNE_GLYPHS, circle.random), runeOrigin, X_AXIS, Y_AXIS, Z_AXIS, glyphScale);
      glyphY += 1.6 * glyphScale + 1.0;
    }
  }

  /**
   * The collider of the stone just built with stoneMatrix: a box from below its sunk base to its top
   * (its peak for a pointed stone), as wide and deep as its base. Tall stones are perches.
   */
  function addStoneCollider(circle, spec) {
    const top = spec.height + (spec.flatTop ? 0 : 0.9);
    const center = new THREE.Vector3(0, (top - spec.sink) * 0.5, 0).applyMatrix4(stoneMatrix);
    const tags = { surface: 'stone', perch: spec.height > 12 && spec.sink > 1 };
    circle.colliders.box('stone', center, spec.width * 0.54, (top + spec.sink) * 0.5, spec.depth * 0.525, stoneQuaternion, tags);
  }

  /** Stands a stone on the ground at (localX, localZ), leaning and facing yaw. */
  function placeStone(circle, localX, localZ, yaw, leanForward, leanSide, spec, runes) {
    const { builder, random, style } = circle;
    circle.stoneBase = pickFrom(style.bases, random);
    stonePosition.set(localX, circle.localGround(localX, localZ) + (spec.lift || 0), localZ);
    stoneQuaternion.setFromEuler(stoneEuler.set(leanForward, yaw, leanSide, 'YXZ'));
    stoneMatrix.compose(stonePosition, stoneQuaternion, UNIT_SCALE);
    builder.setTransform(stoneMatrix);
    const depthAt = addStandingStone(builder, random, spec, circle.paintStone);
    if (runes) carveStoneRunes(circle, spec, depthAt);
    builder.clearTransform();
    addStoneCollider(circle, spec);
  }

  /** Which ring slots hold trilithons or a fallen stone, and where the tall side faces. */
  function planStoneSlots(circle) {
    const { random, count } = circle;
    const pairCount = count >= 11 ? 3 : 2;
    const slotCount = count - pairCount;
    const firstPair = Math.floor(random() * slotCount);
    const pairSlots = new Set();
    for (let pair = 0; pair < pairCount; pair++) pairSlots.add((firstPair + Math.floor((pair * slotCount) / pairCount)) % slotCount);
    let fallenSlot = -1;
    if (random() < 0.65) {
      const candidate = (firstPair + Math.floor(slotCount / (2 * pairCount))) % slotCount;
      if (!pairSlots.has(candidate)) fallenSlot = candidate;
    }
    const tallSide = random() * TWO_PI;
    return { slotCount, pairSlots, fallenSlot, tallSide };
  }

  /** Trilithon: two close uprights of equal height capped by a lintel. */
  function addTrilithon(circle, spot) {
    const { builder, random, style } = circle;
    const { angle, tallness, centerX, centerZ, yaw } = spot;
    const width = 3.9 + 1.2 * random();
    const depth = 2.4 + 0.8 * random();
    const pairHeight = 12 + 9 * Math.max(tallness, 0.35) * (0.8 + 0.2 * random());
    const gap = 2.4 + 0.8 * random();
    const tangentX = -Math.sin(angle);
    const tangentZ = Math.cos(angle);
    const offset = (gap + width) * 0.5;
    const uprights = [-1, 1].map((sign) => ({ x: centerX + tangentX * offset * sign, z: centerZ + tangentZ * offset * sign }));
    const grounds = uprights.map((upright) => circle.localGround(upright.x, upright.z));
    const top = Math.max(grounds[0], grounds[1]) + pairHeight;
    uprights.forEach((upright, index) => {
      const uprightHeight = top - grounds[index];
      placeStone(circle, upright.x, upright.z, yaw, 0, 0, { width, depth, height: uprightHeight, sink: 2.5, flatTop: true }, index === 0);
    });
    circle.stoneBase = pickFrom(style.bases, random);
    const along = new THREE.Vector3(tangentX, 0, tangentZ);
    const inward = new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle));
    const lintelCenter = new THREE.Vector3(centerX, top + 0.85, centerZ);
    builder.box(lintelCenter, along, Y_AXIS, inward, offset + width * 0.5 + 0.35, 0.85, depth * 0.46, circle.paintStone);
    circle.colliders.boxAxes('lintel', lintelCenter, along, Y_AXIS, inward, offset + width * 0.5 + 0.35, 0.85, depth * 0.46, { surface: 'stone', landable: true, perch: true });
    runeOrigin.copy(lintelCenter).addScaledVector(inward, depth * 0.46).addScaledVector(Y_AXIS, -0.62);
    carveGlyph(builder, RUNE_GLYPHS[4], runeOrigin, along.clone().negate(), new THREE.Vector3(0, 0.78, 0), inward, 1);
  }

  /** A broken stone lying outward where it fell. */
  function addFallenStone(circle, spot) {
    const { builder, random, style } = circle;
    const { angle, centerX, centerZ, yaw } = spot;
    const width = 3.6 + 1.4 * random();
    const depth = 2.2 + 0.8 * random();
    const length = 9 + 6 * random();
    const outwardYaw = yaw + Math.PI;
    const lie = (distanceOut, pieceLength, pieceYaw, flatTop) => {
      const pieceX = centerX + Math.cos(angle) * distanceOut;
      const pieceZ = centerZ + Math.sin(angle) * distanceOut;
      circle.stoneBase = pickFrom(style.bases, random);
      stonePosition.set(pieceX, circle.localGround(pieceX, pieceZ) + depth * 0.32, pieceZ);
      stoneQuaternion.setFromEuler(stoneEuler.set(Math.PI / 2 - 0.05, pieceYaw, (random() - 0.5) * 0.2, 'YXZ'));
      stoneMatrix.compose(stonePosition, stoneQuaternion, UNIT_SCALE);
      builder.setTransform(stoneMatrix);
      const pieceSpec = { width, depth, height: pieceLength, sink: 0.4, flatTop };
      addStandingStone(builder, random, pieceSpec, circle.paintStone);
      builder.clearTransform();
      addStoneCollider(circle, pieceSpec);
    };
    lie(0, length * 0.55, outwardYaw, true);
    lie(length * 0.55 + 1.2, length * 0.4, outwardYaw + (random() - 0.5) * 0.4, false);
  }

  /** A single rune-carved standing stone, taller toward the circle's tall side. */
  function addUprightStone(circle, spot) {
    const { random } = circle;
    const height = 8 + 14 * clamp(0.55 * spot.tallness + 0.45 * random(), 0, 1);
    const width = 3.4 + 2.2 * random() + height * 0.06;
    const depth = 2.0 + 1.2 * random();
    const leanForward = (random() - 0.5) * 0.08 + (random() < 0.15 ? 0.14 : 0);
    placeStone(circle, spot.centerX, spot.centerZ, spot.yaw, leanForward, (random() - 0.5) * 0.07, { width, depth, height, sink: 2.2 }, true);
  }

  /** The ring itself: trilithons, at most one fallen stone and single uprights. */
  function addRingStones(circle, plan) {
    const { site, random, radius } = circle;
    for (let slot = 0; slot < plan.slotCount; slot++) {
      const angle = site.rotation + (slot / plan.slotCount) * TWO_PI + (random() - 0.5) * 0.1;
      const tallness = 0.5 + 0.5 * Math.cos(angle - plan.tallSide);
      const ringRadius = radius + (random() - 0.5) * 2.4;
      const centerX = Math.cos(angle) * ringRadius;
      const centerZ = Math.sin(angle) * ringRadius;
      const spot = { angle, tallness, centerX, centerZ, yaw: yawToCenter(centerX, centerZ) };
      if (plan.pairSlots.has(slot)) addTrilithon(circle, spot);
      else if (slot === plan.fallenSlot) addFallenStone(circle, spot);
      else addUprightStone(circle, spot);
    }
  }

  /** Heel stone outside the circle, aligned with the site's axis. */
  function addHeelStone(circle) {
    const heelAngle = circle.site.rotation + Math.PI * 0.5;
    const heelRadius = circle.radius + 16 + 6 * circle.random();
    const heelX = Math.cos(heelAngle) * heelRadius;
    const heelZ = Math.sin(heelAngle) * heelRadius;
    placeStone(circle, heelX, heelZ, yawToCenter(heelX, heelZ), 0.14, 0.05, { width: 3.2, depth: 2.2, height: 6 + 3 * circle.random(), sink: 2 }, false);
  }

  /** Central altar on a plinth with runes laid into its top; returns its ground height. */
  function addAltar(circle) {
    const { site, builder, random, style, paintStone } = circle;
    const axisX = new THREE.Vector3(Math.cos(site.rotation), 0, -Math.sin(site.rotation));
    const axisZ = new THREE.Vector3(Math.sin(site.rotation), 0, Math.cos(site.rotation));
    const altarGround = circle.localGround(0, 0);
    circle.stoneBase = style.bases[1];
    builder.box(new THREE.Vector3(0, altarGround + 0.1, 0), axisX, Y_AXIS, axisZ, 3.3, 0.5, 2.4, paintStone);
    builder.box(new THREE.Vector3(0, altarGround + 1.05, 0), axisX, Y_AXIS, axisZ, 2.2, 0.5, 1.35, paintStone);
    circle.colliders.boxAxes('plinth', new THREE.Vector3(0, altarGround + 0.1, 0), axisX, Y_AXIS, axisZ, 3.3, 0.5, 2.4, { surface: 'stone' });
    circle.colliders.boxAxes('altar', new THREE.Vector3(0, altarGround + 1.05, 0), axisX, Y_AXIS, axisZ, 2.2, 0.5, 1.35, { surface: 'stone', landable: true });
    runeOrigin.set(0, altarGround + 1.55, 0).addScaledVector(axisZ, -0.62);
    carveGlyph(builder, pickFrom(RUNE_GLYPHS, random), runeOrigin.clone().addScaledVector(axisX, -1.1), axisX, axisZ, Y_AXIS, 0.75);
    carveGlyph(builder, RUNE_GLYPHS[4], runeOrigin, axisX, axisZ, Y_AXIS, 0.75);
    carveGlyph(builder, pickFrom(RUNE_GLYPHS, random), runeOrigin.clone().addScaledVector(axisX, 1.1), axisX, axisZ, Y_AXIS, 0.75);
    return altarGround;
  }

  /** Paving ring around the altar. */
  function addAltarPaving(circle) {
    const { site, builder, random, style } = circle;
    const pavingCount = 14;
    for (let index = 0; index < pavingCount; index++) {
      const angle = site.rotation + (index / pavingCount) * TWO_PI + (random() - 0.5) * 0.08;
      const pavingRadius = 7.6 + (random() - 0.5) * 0.6;
      const pavingX = Math.cos(angle) * pavingRadius;
      const pavingZ = Math.sin(angle) * pavingRadius;
      circle.stoneBase = pickFrom(style.bases, random);
      builder.box(
        new THREE.Vector3(pavingX, circle.localGround(pavingX, pavingZ) + 0.02, pavingZ),
        new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle)),
        Y_AXIS,
        new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)),
        1.35,
        0.22,
        0.85,
        circle.paintStone,
      );
    }
  }

  /** A few weathered boulders beyond the ring. */
  function addOuterBoulders(circle) {
    const { builder, random, style, radius } = circle;
    for (let index = 0; index < 5; index++) {
      const angle = random() * TWO_PI;
      const boulderRadius = radius + 8 + 18 * random();
      const boulderX = Math.cos(angle) * boulderRadius;
      const boulderZ = Math.sin(angle) * boulderRadius;
      const size = 1.2 + 1.8 * random();
      circle.stoneBase = pickFrom(style.bases, random);
      circle.colliders.hull('boulder', builder.rock(new THREE.Vector3(boulderX, circle.localGround(boulderX, boulderZ) + size * 0.15, boulderZ), size, random, circle.paintStone), { surface: 'stone' });
    }
  }

  /** Wraps the circle's geometry in its group with a rune-light that pulses at night. */
  function createMonolithInstance(circle, altarGround) {
    const { site, baseY, random } = circle;
    const geometry = circle.builder.build();
    const mesh = solidMesh(geometry);
    const group = new THREE.Group();
    group.position.set(site.x, baseY, site.z);
    group.add(mesh);
    freeze(mesh);
    // A soft teal rune-light hovering over the altar after dark.
    const runeLight = new THREE.Mesh(runeLightGeometry, glowMaterial);
    runeLight.position.set(0, altarGround + 3.0, 0);
    runeLight.scale.set(2.6, 1.4, 2.6);
    runeLight.userData.glow = 0;
    runeLight.visible = false;
    freeze(runeLight);
    group.add(runeLight);
    freeze(group);
    const pulsePhase = random() * TWO_PI;
    function animate(dt, time) {
      const glow = nightness * (0.5 + 0.12 * Math.sin(time * 0.8 + pulsePhase));
      runeLight.userData.glow = glow;
      runeLight.visible = glow > 0.01;
    }
    return {
      group,
      geometries: [geometry],
      triangles: geometry.attributes.position.count / 3,
      measure: focusDistance(new THREE.Vector3(site.x, baseY + 8, site.z)),
      animate,
      balloons: null,
      thread: null,
      colliders: circle.colliders,
    };
  }

  function buildMonoliths(site, descriptor) {
    const circle = createStoneCircle(site, descriptor);
    addRingStones(circle, planStoneSlots(circle));
    addHeelStone(circle);
    const altarGround = addAltar(circle);
    addAltarPaving(circle);
    addOuterBoulders(circle);
    return createMonolithInstance(circle, altarGround);
  }

  // ---- Lighthouse ------------------------------------------------------------------------------
  function buildBoatGeometry() {
    const builder = createBuilder();
    const stations = [[-2.1, 0.06, 0.52], [-1.2, 0.6, 0.5], [0, 0.78, 0.48], [1.3, 0.62, 0.46], [2.2, 0.05, 0.56]];
    const rings = stations.map(([along, halfWidth, top]) => [
      new THREE.Vector3(along, top, -halfWidth),
      new THREE.Vector3(along, 0.05, -halfWidth * 0.85),
      new THREE.Vector3(along, -0.25, 0),
      new THREE.Vector3(along, 0.05, halfWidth * 0.85),
      new THREE.Vector3(along, top, halfWidth),
    ]);
    const paintBoat = (face) => {
      if (face.ny > 0.85) return BOAT_WOOD;
      if (face.y > 0.3) return BOAT_TRIM;
      return BOAT_HULL;
    };
    builder.loft(rings, paintBoat, { capStart: true, capEnd: true });
    return builder.build();
  }

  function towerRadiusAt(y) {
    return lerp(4.3, 2.95, (y - 1.6) / 32.2);
  }
  function towerFacetAngle(facet) {
    return ((facet + 0.5) / 16) * TWO_PI;
  }
  function towerBandAt(scheme, y) {
    let band = 0;
    for (let index = 1; index < scheme.length - 1; index++) if (y > scheme[index]) band = index;
    return band;
  }
  /** Distance along a bearing from the site to the first ground below 0.6 m, or null. */
  function findShoreDistance(site, angle, from, to, step) {
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    for (let reach = from; reach <= to; reach += step) {
      if (world.groundHeight(site.x + cosAngle * reach, site.z + sinAngle * reach) < 0.6) return reach;
    }
    return null;
  }

  /** Per-build state shared by the lighthouse helpers. */
  function createLighthouseContext(site) {
    const random = createRandom(site, 37);
    const builder = createBuilder();
    const baseY = world.groundHeight(site.x, site.z);
    const scheme = pickFrom(LIGHTHOUSE_BANDS, random);
    return {
      site,
      random,
      builder,
      baseY,
      localGround: (localX, localZ) => world.groundHeight(site.x + localX, site.z + localZ) - baseY,
      scheme,
      cottageAngle: site.rotation + 0.9 + random() * 0.6,
      colliders: createColliderSet(site, site.x, baseY, site.z, 0),
    };
  }

  /** Plinth and banded tower. */
  function buildLighthouseTower(light) {
    const { builder, random, scheme } = light;
    builder.loft([circleRing(0, -1.8, 0, 5.8, 8, Math.PI / 8), circleRing(0, 1.6, 0, 5.3, 8, Math.PI / 8)], () => scaled(PLINTH_STONE, 0.9 + 0.14 * random()), { capStart: true, capEnd: true });
    const paintTower = (face) => {
      if (Math.abs(face.ny) > 0.7) return TOWER_WHITE;
      return scaled(towerBandAt(scheme, face.y) % 2 === 0 ? TOWER_WHITE : TOWER_RED, 0.97 + 0.05 * random());
    };
    builder.loft(scheme.map((y) => circleRing(0, y, 0, towerRadiusAt(y), 16)), paintTower, { capEnd: true });
    addLighthouseColliders(light);
  }

  /**
   * The plinth, the tapering tower as three stacked cylinders (each as wide as its foot), the gallery
   * with its railing (perch points on the deck) and the lantern room up to the finial.
   */
  function addLighthouseColliders(light) {
    const set = light.colliders;
    const tags = { surface: 'stone' };
    set.cylinder('plinth', new THREE.Vector3(0, -0.1, 0), 5.8, 1.7, tags);
    const towerTop = 33.8;
    const towerFoot = 1.6;
    for (let piece = 0; piece < 3; piece++) {
      const bottom = towerFoot + ((towerTop - towerFoot) * piece) / 3;
      const top = towerFoot + ((towerTop - towerFoot) * (piece + 1)) / 3;
      set.cylinder('tower', new THREE.Vector3(0, (bottom + top) * 0.5, 0), towerRadiusAt(bottom), (top - bottom) * 0.5, tags);
    }
    const perches = [0, 1, 2, 3].map((quarter) => set.toWorld(new THREE.Vector3(Math.cos(quarter * Math.PI * 0.5 + 0.4) * 4.2, 34.35, Math.sin(quarter * Math.PI * 0.5 + 0.4) * 4.2)));
    set.cylinder('gallery', new THREE.Vector3(0, 34.85, 0), 5.1, 1.15, { surface: 'metal', perch: perches });
    set.cylinder('lantern', new THREE.Vector3(0, 38.1, 0), 2.85, 3.8, { surface: 'metal' });
  }

  /** Door toward the cottage and small windows up the tower. */
  function addTowerOpenings(light) {
    const doorFacet = Math.round((((light.cottageAngle / TWO_PI) * 16 - 0.5) % 16 + 16) % 16);
    const facetBox = (facet, y, halfWidth, halfHeight, paint) => {
      const angle = towerFacetAngle(facet);
      const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
      const apothem = towerRadiusAt(y) * Math.cos(Math.PI / 16);
      light.builder.box(outward.clone().multiplyScalar(apothem + 0.04).setY(y), tangent, Y_AXIS, outward, halfWidth, halfHeight, 0.22, paint);
    };
    facetBox(doorFacet, 2.75, 0.72, 1.15, DOOR_WOOD);
    facetBox(doorFacet + 5, 11.2, 0.38, 0.6, WINDOW_COLOR);
    facetBox(doorFacet + 10, 18.6, 0.36, 0.58, WINDOW_COLOR);
    facetBox(doorFacet + 3, 26.4, 0.34, 0.55, WINDOW_COLOR);
  }

  /** Gallery deck with a post-and-rail railing. */
  function buildLighthouseGallery(builder) {
    builder.loft([circleRing(0, 33.7, 0, 5.1, 16), circleRing(0, 34.35, 0, 5.1, 16)], IRON, { capStart: true, capEnd: true });
    const posts = [];
    for (let index = 0; index < 16; index++) {
      const angle = (index / 16) * TWO_PI;
      posts.push(new THREE.Vector3(Math.cos(angle) * 4.85, 34.9, Math.sin(angle) * 4.85));
      builder.box(posts[index], X_AXIS, Y_AXIS, Z_AXIS, 0.07, 0.55, 0.07, IRON);
    }
    for (let index = 0; index < 16; index++) {
      const start = posts[index];
      const end = posts[(index + 1) % 16];
      const along = new THREE.Vector3().subVectors(end, start);
      const halfLength = along.length() * 0.5 + 0.06;
      along.normalize();
      const across = new THREE.Vector3().crossVectors(Y_AXIS, along);
      builder.box(new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5).setY(35.45), along, Y_AXIS, across, halfLength, 0.05, 0.05, IRON);
    }
  }

  /** Lantern room: base wall, glowing glass, mullions, roof and finial. */
  function buildLanternRoom(light) {
    const { builder, random } = light;
    const octagonPhase = Math.PI / 8;
    builder.loft([circleRing(0, 34.35, 0, 2.55, 8, octagonPhase), circleRing(0, 35.2, 0, 2.55, 8, octagonPhase)], LANTERN_BASE, { capEnd: true });
    builder.loft([circleRing(0, 35.2, 0, 2.3, 8, octagonPhase), circleRing(0, 38.0, 0, 2.3, 8, octagonPhase)], LANTERN_GLASS);
    for (let index = 0; index < 8; index++) {
      const angle = octagonPhase + (index / 8) * TWO_PI;
      builder.box(new THREE.Vector3(Math.cos(angle) * 2.34, 36.6, Math.sin(angle) * 2.34), X_AXIS, Y_AXIS, Z_AXIS, 0.08, 1.4, 0.08, IRON);
    }
    const roofRim = [circleRing(0, 38.0, 0, 2.85, 8, octagonPhase), circleRing(0, 38.35, 0, 2.85, 8, octagonPhase)];
    builder.loft(roofRim, ROOF_RED, { capStart: true });
    builder.fan(roofRim[1], new THREE.Vector3(0, 40.8, 0), ROOF_RED, new THREE.Vector3(0, 38.6, 0));
    builder.box(new THREE.Vector3(0, 41.3, 0), X_AXIS, Y_AXIS, Z_AXIS, 0.05, 0.6, 0.05, IRON);
    builder.rock(new THREE.Vector3(0, 41.0, 0), 0.34, random, IRON, { squash: 1, jitter: 0.04 });
  }

  /** Keeper's cottage with a gabled roof, chimney, door and warm windows. */
  function buildKeeperCottage(light) {
    const { builder, random, cottageAngle } = light;
    const cottageDistance = 15 + 3 * random();
    const cottageX = Math.cos(cottageAngle) * cottageDistance;
    const cottageZ = Math.sin(cottageAngle) * cottageDistance;
    const cottageMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(cottageX, light.localGround(cottageX, cottageZ), cottageZ),
      // Long side tangential, front door (+z) facing the tower.
      new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -cottageAngle - Math.PI / 2),
      UNIT_SCALE,
    );
    const roofColor = pickFrom(COTTAGE_ROOFS, random);
    builder.setTransform(cottageMatrix);
    builder.box(new THREE.Vector3(0, 1.4, 0), X_AXIS, Y_AXIS, Z_AXIS, 4.2, 2.2, 2.7, COTTAGE_WALL);
    const roofCenter = new THREE.Vector3(0, 4.3, 0);
    const eaves = [new THREE.Vector3(-4.4, 3.5, 3.2), new THREE.Vector3(4.4, 3.5, 3.2), new THREE.Vector3(4.4, 3.5, -3.2), new THREE.Vector3(-4.4, 3.5, -3.2)];
    const ridge = [new THREE.Vector3(-4.4, 6.1, 0), new THREE.Vector3(4.4, 6.1, 0)];
    builder.quad(eaves[0], eaves[1], ridge[1], ridge[0], roofColor, roofCenter);
    builder.quad(eaves[2], eaves[3], ridge[0], ridge[1], roofColor, roofCenter);
    builder.quad(eaves[0], eaves[3], eaves[2], eaves[1], EAVE_SHADE, roofCenter);
    builder.triangle(eaves[0], ridge[0], eaves[3], COTTAGE_WALL, roofCenter);
    builder.triangle(eaves[1], eaves[2], ridge[1], COTTAGE_WALL, roofCenter);
    builder.box(new THREE.Vector3(2.6, 5.6, -1.0), X_AXIS, Y_AXIS, Z_AXIS, 0.45, 1.3, 0.45, CHIMNEY_STONE);
    builder.box(new THREE.Vector3(0.2, 0.95, 2.72), X_AXIS, Y_AXIS, Z_AXIS, 0.55, 1.05, 0.08, DOOR_WOOD);
    for (const [windowX, windowZ, facing] of [[-2.5, 2.72, Z_AXIS], [2.6, 2.72, Z_AXIS], [-1.8, -2.72, Z_AXIS], [1.9, -2.72, Z_AXIS]]) {
      builder.box(new THREE.Vector3(windowX, 1.75, windowZ), X_AXIS, Y_AXIS, facing, 0.5, 0.55, 0.08, WINDOW_COLOR);
    }
    builder.box(new THREE.Vector3(-4.22, 1.75, 0), Z_AXIS, Y_AXIS, X_AXIS, 0.5, 0.55, 0.08, WINDOW_COLOR);
    builder.clearTransform();
    // Colliders: the walls, the gabled roof (a hull of its eaves and ridge) and the chimney.
    const cottageTurn = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -cottageAngle - Math.PI / 2);
    const set = light.colliders;
    set.box('cottage', new THREE.Vector3(0, 1.4, 0).applyMatrix4(cottageMatrix), 4.2, 2.2, 2.7, cottageTurn, { surface: 'stone' });
    set.hull('roof', [...eaves, ...ridge].map((point) => point.clone().applyMatrix4(cottageMatrix)), { surface: 'wood' });
    set.box('chimney', new THREE.Vector3(2.6, 5.6, -1.0).applyMatrix4(cottageMatrix), 0.45, 1.3, 0.45, cottageTurn, { surface: 'stone' });
  }

  /** Boulder clusters where the island meets the sea, leaving a gap for the dock. */
  function buildShoreRocks(light, dockAngle, dockShore) {
    const { site, builder, random, baseY } = light;
    let rockBase = SHORE_ROCKS[0];
    const paintShoreRock = (face) => {
      if (face.ny > 0.75 && random() < 0.3) return blended(rockBase, SUN_BLEACHED, 0.6, 1);
      return scaled(rockBase, 0.88 + 0.2 * random());
    };
    for (let index = 0; index < 13; index++) {
      const angle = site.rotation + (index / 13) * TWO_PI + (random() - 0.5) * 0.35;
      const angularGap = Math.abs(Math.atan2(Math.sin(angle - dockAngle), Math.cos(angle - dockAngle)));
      if (dockShore !== null && angularGap < 0.3) continue;
      const shore = findShoreDistance(site, angle, 36, 160, 4);
      if (shore === null) continue;
      const clusterSize = 1 + Math.floor(random() * 3);
      for (let member = 0; member < clusterSize; member++) {
        const reach = shore + (random() - 0.45) * 9;
        const memberAngle = angle + (random() - 0.5) * 0.12;
        const rockX = Math.cos(memberAngle) * reach;
        const rockZ = Math.sin(memberAngle) * reach;
        const size = 1.4 + 3.6 * random() ** 2;
        rockBase = pickFrom(SHORE_ROCKS, random);
        light.colliders.hull('rock', builder.rock(new THREE.Vector3(rockX, Math.max(light.localGround(rockX, rockZ), -1.4 - baseY) + size * 0.3, rockZ), size, random, paintShoreRock), { surface: 'stone' });
      }
    }
  }

  /** Plank deck out over the water on posts that reach the sea bed. */
  function addDockDeck(light, dock) {
    const { builder, random, baseY } = light;
    const { direction, across, deckTop, start, end } = dock;
    const point = new THREE.Vector3();
    for (let reach = start, plank = 0; reach < end; reach += 0.62, plank++) {
      point.copy(direction).multiplyScalar(reach + 0.28).setY(deckTop - 0.12);
      builder.box(point, across, Y_AXIS, direction, 1.45, 0.12, 0.27, scaled(PLANKS[plank % PLANKS.length], 0.92 + 0.14 * random()));
    }
    // The deck as one landable box (its posts stand under it, down to the sea bed).
    const deckCenter = direction.clone().multiplyScalar((start + end) * 0.5 + 0.28).setY(deckTop - 0.12);
    light.colliders.boxAxes('dock', deckCenter, across, Y_AXIS, direction.clone().negate(), 1.6, 0.12, (end - start) * 0.5 + 0.3, { surface: 'wood', landable: true });
    for (let reach = start + 0.6; reach <= end + 0.01; reach += 3) {
      for (const side of [-1, 1]) {
        const postX = direction.x * reach + across.x * side * 1.35;
        const postZ = direction.z * reach + across.z * side * 1.35;
        const bottom = Math.max(light.localGround(postX, postZ), -4 - baseY);
        const top = deckTop + 0.45;
        if (top - bottom < 0.8) continue;
        builder.box(new THREE.Vector3(postX, (top + bottom) * 0.5, postZ), X_AXIS, Y_AXIS, Z_AXIS, 0.16, (top - bottom) * 0.5, 0.16, DOCK_POST);
      }
    }
  }

  /** Stepping-stone path from the tower down to the dock. */
  function addDockPath(light, dock) {
    const { builder, random } = light;
    const { direction, across } = dock;
    for (let reach = 7; reach < dock.shore - 6; reach += 2.6) {
      const lateral = (random() - 0.5) * 0.8;
      const stoneX = direction.x * reach + across.x * lateral;
      const stoneZ = direction.z * reach + across.z * lateral;
      builder.rock(new THREE.Vector3(stoneX, light.localGround(stoneX, stoneZ) + 0.02, stoneZ), 0.75, random, () => scaled(PATH_STONE, 0.9 + 0.15 * random()), { squash: 0.22, jitter: 0.12 });
    }
  }

  /** Rowboat moored beside the dock end (its own geometry, bobbed by animate). */
  function createRowboat(light, dock) {
    const { direction, across } = dock;
    const geometry = buildBoatGeometry();
    const boat = solidMesh(geometry);
    const boatReach = dock.shore + 11;
    boat.position.set(direction.x * boatReach + across.x * 3.3, 0.25 - light.baseY, direction.z * boatReach + across.z * 3.3);
    boat.rotation.y = -dock.angle;
    boat.userData.baseY = boat.position.y;
    // Its collider covers the bobbing (0.12 m) and the rocking.
    light.colliders.box('boat', new THREE.Vector3(boat.position.x, boat.position.y + 0.25, boat.position.z), 2.3, 0.65, 0.75, boat.quaternion, { surface: 'wood' });
    return { boat, geometry };
  }

  /** Dock, path and rowboat on the shore facing dockAngle; returns the boat parts. */
  function buildDock(light, dockAngle, dockShore) {
    const dock = {
      angle: dockAngle,
      shore: dockShore,
      direction: new THREE.Vector3(Math.cos(dockAngle), 0, Math.sin(dockAngle)),
      across: new THREE.Vector3(-Math.sin(dockAngle), 0, Math.cos(dockAngle)),
      deckTop: 1.7 - light.baseY,
      start: dockShore - 6,
      end: dockShore + 18,
    };
    addDockDeck(light, dock);
    addDockPath(light, dock);
    return createRowboat(light, dock);
  }

  /** Twin beams on a pivot at lantern height, plus the lantern halo. */
  function createLighthouseBeam() {
    const pivot = new THREE.Group();
    pivot.position.set(0, LANTERN_HEIGHT, 0);
    const beamForward = new THREE.Mesh(beamGeometry, beamMaterial);
    beamForward.rotation.set(0, 0, -0.035);
    const beamBackward = new THREE.Mesh(beamGeometry, beamMaterial);
    beamBackward.rotation.set(0, Math.PI, -0.035);
    pivot.add(beamForward, beamBackward);
    const halo = new THREE.Mesh(haloGeometry, glowMaterial);
    halo.position.set(0, LANTERN_HEIGHT, 0);
    halo.scale.setScalar(3.4);
    halo.userData.glow = 0;
    freeze(halo);
    return { pivot, halo };
  }

  /** Turns the beam, flashes the halo toward the viewer and bobs the boat. */
  function createLighthouseAnimation(light, lamp, boat, beamPhase) {
    const { site } = light;
    const { pivot, halo } = lamp;
    const lanternY = light.baseY + LANTERN_HEIGHT;
    return function animate(dt, time) {
      const beamAngle = beamPhase + time * BEAM_TURN_RATE;
      pivot.rotation.y = beamAngle;
      const toCameraX = camera.position.x - site.x;
      const toCameraY = camera.position.y - lanternY;
      const toCameraZ = camera.position.z - site.z;
      const length = Math.sqrt(toCameraX * toCameraX + toCameraY * toCameraY + toCameraZ * toCameraZ) || 1;
      const alignment = Math.abs((Math.cos(beamAngle) * toCameraX - Math.sin(beamAngle) * toCameraZ) / length);
      halo.userData.glow = beamStrength.value * (0.8 + 5 * alignment ** 48);
      if (boat) {
        boat.position.y = boat.userData.baseY + 0.12 * Math.sin(time * 1.3 + beamPhase);
        boat.rotation.x = 0.05 * Math.sin(time * 0.9 + beamPhase);
      }
    };
  }

  /** Wraps the lighthouse geometry, boat and lamp in the placed group. */
  function createLighthouseInstance(light, dock) {
    const { site, baseY } = light;
    const boat = dock ? dock.boat : null;
    const geometry = light.builder.build();
    const geometries = dock ? [geometry, dock.geometry] : [geometry];
    const mesh = solidMesh(geometry);
    const group = new THREE.Group();
    group.position.set(site.x, baseY, site.z);
    group.add(mesh);
    freeze(mesh);
    if (boat) group.add(boat);
    const lamp = createLighthouseBeam();
    group.add(lamp.pivot, lamp.halo);
    freeze(group);
    const animate = createLighthouseAnimation(light, lamp, boat, light.random() * TWO_PI);
    let triangles = 0;
    for (const item of geometries) triangles += item.attributes.position.count / 3;
    return {
      group,
      geometries,
      triangles,
      measure: focusDistance(new THREE.Vector3(site.x, baseY + 20, site.z)),
      animate,
      balloons: null,
      thread: null,
      colliders: light.colliders,
    };
  }

  function buildLighthouse(site) {
    const light = createLighthouseContext(site);
    buildLighthouseTower(light);
    addTowerOpenings(light);
    buildLighthouseGallery(light.builder);
    buildLanternRoom(light);
    buildKeeperCottage(light);
    // Shoreline: boulders around the island and a dock with a path down to it.
    const dockAngle = site.rotation + Math.PI + (light.random() - 0.5) * 0.9;
    const dockShore = findShoreDistance(site, dockAngle, 30, 160, 2);
    buildShoreRocks(light, dockAngle, dockShore);
    const dock = dockShore === null ? null : buildDock(light, dockAngle, dockShore);
    return createLighthouseInstance(light, dock);
  }

  // ---- Balloons ---------------------------------------------------------------------------------
  function balloonPatternIndex(pattern, row, segment) {
    switch (pattern) {
      case 'gores': return row >= 8 ? 2 : segment % 2;
      case 'spiral': return (segment + row) % 4 < 2 ? 0 : 1;
      case 'harlequin': return row >= 8 ? 2 : (segment + row) % 2;
      case 'bands': return row >= 8 ? 2 : (row >= 5 && row <= 6) || row <= 1 ? 1 : 0;
      case 'crown': return row >= 7 ? (segment % 2 === 0 ? 2 : 1) : row === 5 ? 2 : 0;
      default: return row >= 8 ? 1 : segment % 4 === 0 ? 2 : segment % 4 === 2 ? 1 : 0;
    }
  }

  /** Patterned envelope; the gores glow most near the mouth when the burner fires. */
  function addBalloonEnvelope(builder, random, palette, pattern, height) {
    const segments = 16;
    const rows = BALLOON_PROFILE.length - 2;
    const rings = BALLOON_PROFILE.map(([radius, y]) => circleRing(0, y * height, 0, radius * height, segments));
    const paintEnvelope = (face) => {
      if (face.ring < 0) return MOUTH_INTERIOR;
      if (face.ring === 0) return SKIRT_FABRIC;
      const row = face.ring - 1;
      const base = palette[balloonPatternIndex(pattern, row, face.index)];
      const glowGain = 0.25 + 1.1 * Math.pow(1 - row / rows, 1.4);
      paintOut[0] = base[0] * (0.97 + 0.06 * random());
      paintOut[1] = base[1] * (0.97 + 0.06 * random());
      paintOut[2] = base[2] * (0.97 + 0.06 * random());
      paintOut[3] = glowGain;
      return paintOut;
    };
    builder.loft(rings, paintEnvelope, { capStart: true });
  }

  function addBalloonBasket(builder, basketTop) {
    builder.box(new THREE.Vector3(0, basketTop - 0.65, 0), X_AXIS, Y_AXIS, Z_AXIS, 0.8, 0.65, 0.8, WICKER);
    builder.box(new THREE.Vector3(0, basketTop - 0.02, 0), X_AXIS, Y_AXIS, Z_AXIS, 0.88, 0.1, 0.88, WICKER_RIM);
  }

  function addBalloonBurner(builder, burnerY) {
    builder.box(new THREE.Vector3(0, burnerY, 0), X_AXIS, Y_AXIS, Z_AXIS, 0.36, 0.28, 0.36, BURNER_METAL);
  }

  /** A thin square-section box from one point to another (ropes and struts). */
  function addRiggingLine(builder, from, to, halfWidth, paint) {
    const along = new THREE.Vector3().subVectors(to, from);
    const halfLength = along.length() * 0.5;
    along.normalize();
    const side = new THREE.Vector3().crossVectors(along, Math.abs(along.y) > 0.9 ? X_AXIS : Y_AXIS).normalize();
    const third = new THREE.Vector3().crossVectors(along, side);
    builder.box(new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5), along, side, third, halfLength, halfWidth, halfWidth, paint);
  }

  /** From each basket corner: a rope up to the envelope mouth and a strut to the burner. */
  function addBalloonRigging(builder, basketTop, burnerY, mouthRadius) {
    const lineStart = new THREE.Vector3();
    const lineEnd = new THREE.Vector3();
    for (let corner = 0; corner < 4; corner++) {
      const cornerX = corner & 1 ? 0.78 : -0.78;
      const cornerZ = corner & 2 ? 0.78 : -0.78;
      const angle = Math.atan2(cornerZ, cornerX);
      lineStart.set(cornerX, basketTop, cornerZ);
      lineEnd.set(Math.cos(angle) * mouthRadius, 0, Math.sin(angle) * mouthRadius);
      addRiggingLine(builder, lineStart, lineEnd, 0.05, ROPE);
      lineEnd.set(cornerX * 0.4, burnerY, cornerZ * 0.4);
      addRiggingLine(builder, lineStart, lineEnd, 0.04, BURNER_METAL);
    }
  }

  function buildBalloonGeometry(random, palette, pattern, scale) {
    const builder = createBuilder();
    const height = ENVELOPE_HEIGHT * scale;
    addBalloonEnvelope(builder, random, palette, pattern, height);
    const basketTop = -7.6 * scale;
    addBalloonBasket(builder, basketTop);
    const burnerY = -5.6 * scale;
    addBalloonBurner(builder, burnerY);
    addBalloonRigging(builder, basketTop, burnerY, BALLOON_PROFILE[1][0] * height);
    return builder.build();
  }

  /** Balloon mesh with its (hidden until lit) burner flame. */
  function createBalloonMesh(geometry, scale) {
    const mesh = solidMesh(geometry, balloonMaterial);
    mesh.userData.burnGlow = 0;
    const flame = new THREE.Mesh(flameGeometry, glowMaterial);
    flame.position.set(0, -5.35 * scale, 0);
    flame.visible = false;
    flame.userData.glow = 0;
    mesh.add(flame);
    return { mesh, flame };
  }

  /**
   * One balloon's colliders, local to its mesh: the envelope as two hulls (the profile's rings below
   * and above its widest one, on circumscribed octagons; the lower one reaches down to the basket rim,
   * so the rigging and the burner are inside it) and the basket as a box. They move with the balloon
   * (setPose every frame, with its drift velocity).
   */
  function addBalloonColliders(set, balloon, scale) {
    const height = ENVELOPE_HEIGHT * scale;
    const basketTop = -7.6 * scale;
    const octagon = 1 / Math.cos(Math.PI / 8);
    const ringPoints = (first, last) => {
      const points = [];
      for (let row = first; row <= last; row++) {
        const [radius, y] = BALLOON_PROFILE[row];
        if (radius === 0) {
          points.push(new THREE.Vector3(0, y * height, 0));
          continue;
        }
        for (let side = 0; side < 8; side++) {
          const angle = (side / 8) * TWO_PI;
          points.push(new THREE.Vector3(Math.cos(angle) * radius * height * octagon, y * height, Math.sin(angle) * radius * height * octagon));
        }
      }
      return points;
    };
    const lower = ringPoints(0, 6);
    for (let corner = 0; corner < 4; corner++) lower.push(new THREE.Vector3(corner & 1 ? 0.88 : -0.88, basketTop, corner & 2 ? 0.88 : -0.88));
    const where = balloon.mesh.position;
    const tags = { surface: 'cloth' };
    balloon.colliderIds = [
      set.movingHull('envelope', lower, where, tags).id,
      set.movingHull('crown', ringPoints(6, BALLOON_PROFILE.length - 1), where, tags).id,
      set.box('basket', new THREE.Vector3(where.x, where.y + basketTop - 0.65, where.z), 0.9, 0.75, 0.9, null, { surface: 'wood' }).id,
    ];
    balloon.basketOffset = new THREE.Vector3(0, basketTop - 0.65, 0);
    balloon.pose = new Float64Array(7);
    balloon.basketPose = new Float64Array(7);
    balloon.colliderVelocity = new Float64Array(3);
    balloon.lastCenter = new Float64Array([NaN, NaN, NaN]);
  }

  const balloonOffset = new THREE.Vector3();
  /** Moves a balloon's colliders to its mesh (world: the fair's site plus the mesh's offset). */
  function updateBalloonColliders(site, balloon, dt) {
    if (!colliderWorld || !balloon.colliderIds) return;
    const mesh = balloon.mesh;
    const pose = balloon.pose;
    const velocity = balloon.colliderVelocity;
    const last = balloon.lastCenter;
    pose[0] = site.x + mesh.position.x;
    pose[1] = mesh.position.y;
    pose[2] = site.z + mesh.position.z;
    pose[3] = mesh.quaternion.x;
    pose[4] = mesh.quaternion.y;
    pose[5] = mesh.quaternion.z;
    pose[6] = mesh.quaternion.w;
    for (let axis = 0; axis < 3; axis++) {
      velocity[axis] = dt > 0 && last[axis] === last[axis] ? (pose[axis] - last[axis]) / dt : 0;
      last[axis] = pose[axis];
    }
    colliderWorld.setPose(balloon.colliderIds[0], pose, velocity);
    colliderWorld.setPose(balloon.colliderIds[1], pose, velocity);
    balloonOffset.copy(balloon.basketOffset).applyQuaternion(mesh.quaternion);
    const basket = balloon.basketPose;
    basket[0] = pose[0] + balloonOffset.x;
    basket[1] = pose[1] + balloonOffset.y;
    basket[2] = pose[2] + balloonOffset.z;
    basket[3] = pose[3];
    basket[4] = pose[4];
    basket[5] = pose[5];
    basket[6] = pose[6];
    colliderWorld.setPose(balloon.colliderIds[2], basket, velocity);
  }

  /** Seeded drift, height and burner timing for one balloon of the fair. */
  function createBalloonState(fair, index, mesh, flame, scale) {
    const { site, random, count, heightOrder } = fair;
    const angle = (index / count) * TWO_PI + random() * 0.8;
    const ringRadius = 50 + 110 * random();
    return {
      mesh,
      flame,
      scale,
      baseX: Math.cos(angle) * ringRadius,
      baseZ: Math.sin(angle) * ringRadius,
      alongAmplitude: 180 + 220 * random(),
      acrossAmplitude: 90 + 140 * random(),
      alongFrequency: 0.004 + 0.004 * random(),
      acrossFrequency: 0.003 + 0.004 * random(),
      alongPhase: random() * TWO_PI,
      acrossPhase: random() * TWO_PI,
      heightAboveGround: 120 + (count > 1 ? (200 * heightOrder[index]) / (count - 1) : 100) + (random() - 0.5) * 8,
      bobPhase: random() * TWO_PI,
      swayPhase: random() * TWO_PI,
      spinPhase: random() * TWO_PI,
      spinRate: (random() - 0.5) * 0.04,
      altitude: NaN,
      groundUnder: Math.max(site.groundHeight, CONFIG.WATER_LEVEL),
      groundTimer: 0,
      burnTimer: 1 + 9 * random(),
      burning: false,
      burnLevel: 0,
      flickerPhase: random() * TWO_PI,
    };
  }

  /** Moves one balloon along its wind-aligned drift, easing toward its height over the ground. */
  function driftBalloon(site, balloon, index, wind, dt, time) {
    const along = balloon.alongAmplitude * Math.sin(balloon.alongFrequency * time + balloon.alongPhase);
    const across = balloon.acrossAmplitude * Math.sin(balloon.acrossFrequency * time + balloon.acrossPhase);
    const localX = balloon.baseX + wind.x * along - wind.y * across;
    const localZ = balloon.baseZ + wind.y * along + wind.x * across;
    balloon.groundTimer -= dt;
    if (balloon.groundTimer <= 0 || !Number.isFinite(balloon.altitude)) {
      balloon.groundTimer = 0.5 + 0.05 * index;
      balloon.groundUnder = Math.max(world.groundHeight(site.x + localX, site.z + localZ), CONFIG.WATER_LEVEL);
    }
    const target = balloon.groundUnder + balloon.heightAboveGround + 7 * Math.sin(0.23 * time + balloon.bobPhase) + 2.5 * Math.sin(0.61 * time + balloon.swayPhase);
    balloon.altitude = Number.isFinite(balloon.altitude) ? damp(balloon.altitude, target, 0.35, dt) : target;
    balloon.mesh.position.set(localX, balloon.altitude, localZ);
    balloon.mesh.rotation.set(
      0.025 * Math.sin(0.41 * time + balloon.swayPhase),
      balloon.spinPhase + balloon.spinRate * time,
      0.025 * Math.sin(0.33 * time + balloon.bobPhase),
    );
  }

  /** Toggles the burner now and then; the flame and envelope glow follow its level. */
  function updateBalloonBurner(balloon, dt, time) {
    if (dt > 0) {
      balloon.burnTimer -= dt;
      if (balloon.burnTimer <= 0) {
        balloon.burning = !balloon.burning;
        balloon.burnTimer = balloon.burning ? 1.2 + 2.2 * Math.random() : 5 + 11 * Math.random();
      }
      balloon.burnLevel = damp(balloon.burnLevel, balloon.burning ? 1 : 0, 9, dt);
    }
    const flicker = 0.75 + 0.25 * Math.sin(time * 31 + balloon.flickerPhase) * Math.sin(time * 17.3);
    const level = balloon.burnLevel;
    balloon.flame.visible = level > 0.02;
    balloon.flame.scale.set((0.8 + 0.3 * flicker) * balloon.scale, Math.max(0.01, (0.6 + 0.6 * flicker) * level) * balloon.scale, (0.8 + 0.3 * flicker) * balloon.scale);
    balloon.flame.userData.glow = level * (0.9 + 0.4 * flicker);
    balloon.mesh.userData.burnGlow = level * (0.3 + 0.35 * flicker) * (0.3 + 1.25 * nightness);
  }

  function createBalloonAnimation(site, balloons) {
    const wind = uniforms.windDirection.value;
    return function animate(dt, time) {
      for (let index = 0; index < balloons.length; index++) {
        driftBalloon(site, balloons[index], index, wind, dt, time);
        updateBalloonBurner(balloons[index], dt, time);
        updateBalloonColliders(site, balloons[index], dt);
      }
    };
  }

  /** Discovery distance: the nearest balloon (aimed a little above its basket). */
  function createBalloonMeasure(site, balloons) {
    return function measure(player) {
      let nearest = Infinity;
      for (const balloon of balloons) {
        const dx = site.x + balloon.mesh.position.x - player.x;
        const dy = balloon.mesh.position.y + 8 - player.y;
        const dz = site.z + balloon.mesh.position.z - player.z;
        nearest = Math.min(nearest, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      return nearest;
    };
  }

  function buildBalloons(site, descriptor) {
    const random = createRandom(site, 53);
    const count = descriptor.count;
    const group = new THREE.Group();
    group.position.set(site.x, 0, site.z);
    const palettes = shuffled(BALLOON_PALETTES, random);
    const patterns = shuffled(BALLOON_PATTERNS, random);
    const heightOrder = shuffled(Array.from({ length: count }, (unused, index) => index), random);
    const fair = { site, random, count, heightOrder };
    const balloons = [];
    const geometries = [];
    let triangles = 0;
    for (let index = 0; index < count; index++) {
      const scale = 0.88 + 0.24 * random();
      const geometry = buildBalloonGeometry(random, palettes[index % palettes.length], patterns[index % patterns.length], scale);
      geometries.push(geometry);
      triangles += geometry.attributes.position.count / 3;
      const { mesh, flame } = createBalloonMesh(geometry, scale);
      group.add(mesh);
      balloons.push(createBalloonState(fair, index, mesh, flame, scale));
    }
    const animate = createBalloonAnimation(site, balloons);
    animate(0, state.time.elapsed);
    // Colliders from the first pose (the fair's group sits at the site, unturned).
    const colliders = createColliderSet(site, site.x, 0, site.z, 0);
    balloons.forEach((balloon) => addBalloonColliders(colliders, balloon, balloon.scale));
    return { group, geometries, triangles, measure: createBalloonMeasure(site, balloons), animate, balloons, thread: null, colliders };
  }

  const BUILDERS = { arch: buildArch, monoliths: buildMonoliths, lighthouse: buildLighthouse, balloons: buildBalloons };

  // ---- Streaming, discovery and threading ----------------------------------------------------
  const instances = new Map();
  const activeInstances = [];
  const buildQueue = [];
  const queuedIds = new Set();
  const failedIds = new Set();
  const discoveredIds = new Set();
  const previousPosition = new THREE.Vector3().copy(state.player.position);
  let scanTimer = 0;
  let nightness = 0;
  let inRangeCount = 0;
  let lastBuildMs = 0;

  function viewDistance() {
    return (ctx.quality.viewRings || 8) * CONFIG.CHUNK_SIZE;
  }
  function isFound(id) {
    const journal = ctx.systems.journal;
    return discoveredIds.has(id) || Boolean(journal && typeof journal.hasFound === 'function' && journal.hasFound(id));
  }

  function removeInstance(index) {
    const instance = activeInstances[index];
    activeInstances.splice(index, 1);
    instances.delete(instance.site.id);
    scene.remove(instance.group);
    removeColliders(instance);
    for (const geometry of instance.geometries) geometry.dispose();
  }

  function scanSites() {
    const player = state.player.position;
    const buildRadius = viewDistance() + BUILD_MARGIN;
    const disposeRadius = buildRadius + DISPOSE_MARGIN;
    const sites = world.landmarkSitesNear(player.x, player.z, buildRadius);
    inRangeCount = sites.length;
    for (const site of sites) {
      if (instances.has(site.id) || queuedIds.has(site.id) || failedIds.has(site.id)) continue;
      queuedIds.add(site.id);
      buildQueue.push(site);
    }
    for (let index = activeInstances.length - 1; index >= 0; index--) {
      const site = activeInstances[index].site;
      if (Math.hypot(site.x - player.x, site.z - player.z) > disposeRadius) removeInstance(index);
    }
    for (let index = buildQueue.length - 1; index >= 0; index--) {
      const site = buildQueue[index];
      if (Math.hypot(site.x - player.x, site.z - player.z) > buildRadius) {
        queuedIds.delete(site.id);
        buildQueue.splice(index, 1);
      }
    }
    buildQueue.sort((first, second) => Math.hypot(first.x - player.x, first.z - player.z) - Math.hypot(second.x - player.x, second.z - player.z));
  }

  function buildNext() {
    if (buildQueue.length === 0) return;
    const site = buildQueue.shift();
    queuedIds.delete(site.id);
    if (instances.has(site.id)) return;
    const descriptor = describe(site);
    const started = performance.now();
    let instance;
    try {
      instance = BUILDERS[site.type](site, descriptor);
      instance.colliderIds = registerColliders(instance.colliders);
    } catch (error) {
      failedIds.add(site.id);
      console.error(`[DRIFTWING] landmark ${site.id} (${site.type}) failed to build`, error);
      return;
    }
    lastBuildMs = performance.now() - started;
    instance.site = site;
    instance.descriptor = descriptor;
    instance.discovered = isFound(site.id);
    scene.add(instance.group);
    instances.set(site.id, instance);
    activeInstances.push(instance);
  }

  function discover(instance) {
    if (instance.discovered) return;
    instance.discovered = true;
    const { site, descriptor } = instance;
    if (discoveredIds.has(site.id)) return;
    discoveredIds.add(site.id);
    const journal = ctx.systems.journal;
    const recorded = journal && typeof journal.recordLandmark === 'function' ? journal.recordLandmark(site, descriptor.name) : true;
    if (recorded === false) return;
    bus.emit('landmark:discovered', { site, name: descriptor.name, type: site.type });
  }

  function insidePolygon(polygon, x, y) {
    let inside = false;
    const count = polygon.length / 2;
    for (let index = 0, previous = count - 1; index < count; previous = index++) {
      const currentX = polygon[index * 2];
      const currentY = polygon[index * 2 + 1];
      const previousX = polygon[previous * 2];
      const previousY = polygon[previous * 2 + 1];
      if (currentY > y !== previousY > y && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX) inside = !inside;
    }
    return inside;
  }

  /** Did the segment from the previous to the current position pass through the opening? */
  function checkThread(instance, player, time) {
    const thread = instance.thread;
    const site = instance.site;
    const currentX = player.x - site.x;
    const currentZ = player.z - site.z;
    if (Math.abs(currentX) > THREAD_RANGE || Math.abs(currentZ) > THREAD_RANGE) return;
    if (time - thread.lastTime < THREAD_COOLDOWN_SECONDS) return;
    const previousX = previousPosition.x - site.x;
    const previousZ = previousPosition.z - site.z;
    const currentLocalZ = currentX * thread.sin + currentZ * thread.cos;
    const previousLocalZ = previousX * thread.sin + previousZ * thread.cos;
    if (currentLocalZ >= 0 === previousLocalZ >= 0) return;
    const blend = previousLocalZ / (previousLocalZ - currentLocalZ);
    const crossingX = lerp(previousX * thread.cos - previousZ * thread.sin, currentX * thread.cos - currentZ * thread.sin, blend);
    const crossingY = lerp(previousPosition.y, player.y, blend) - thread.baseY;
    if (!insidePolygon(thread.polygon, crossingX, crossingY)) return;
    thread.lastTime = time;
    discover(instance);
    bus.emit('landmark:threaded', { site, name: instance.descriptor.name });
  }

  function updateLighting() {
    const elevation = Number.isFinite(state.time.sunElevation) ? state.time.sunElevation : 10;
    nightness = smooth01((6 - elevation) / 16);
    nightGlow.value = 0.05 + 2.4 * nightness;
    beamStrength.value = 0.05 + 0.55 * smooth01((14 - elevation) / 22);
    const fog = scene.fog;
    const far = fog && Number.isFinite(fog.far) ? fog.far : viewDistance();
    glowFadeNear.value = far * 0.6;
    glowFadeFar.value = far * 1.35 + 400;
  }

  // ---- Queries -----------------------------------------------------------------------------------
  const TYPE_ALIASES = {
    arch: 'arch', arches: 'arch',
    monolith: 'monoliths', monoliths: 'monoliths', stones: 'monoliths', circle: 'monoliths',
    lighthouse: 'lighthouse', lighthouses: 'lighthouse',
    balloon: 'balloons', balloons: 'balloons',
  };
  const ANY_TYPE = new Set(['', 'any', 'landmark', 'landmarks']);

  function toEntry(site, originX, originZ) {
    const descriptor = describe(site);
    return {
      id: site.id,
      type: site.type,
      name: descriptor.name,
      x: Math.round(site.x),
      z: Math.round(site.z),
      distance: Math.round(Math.hypot(site.x - originX, site.z - originZ)),
      bearing: Math.round(bearingTo(originX, originZ, site.x, site.z)) % 360,
      discovered: isFound(site.id),
    };
  }

  function getNearby(radius = 6000) {
    const player = state.player.position;
    const searchRadius = Number.isFinite(radius) && radius > 0 ? Math.min(radius, 40000) : 6000;
    return world
      .landmarkSitesNear(player.x, player.z, searchRadius)
      .map((site) => toEntry(site, player.x, player.z))
      .sort((first, second) => first.distance - second.distance);
  }

  /**
   * Nearest landmark of a type ('arch' | 'monoliths' | 'lighthouse' | 'balloons',
   * or any when omitted / 'landmark'), preferring ones not yet discovered.
   */
  function findNearest(type) {
    const key = type === undefined || type === null ? '' : String(type).trim().toLowerCase();
    const wanted = ANY_TYPE.has(key) ? null : TYPE_ALIASES[key];
    if (wanted === undefined) return null;
    const player = state.player.position;
    let nearest = null;
    let nearestDistance = Infinity;
    let nearestNew = null;
    let nearestNewDistance = Infinity;
    for (const radius of FIND_RADII) {
      for (const site of world.landmarkSitesNear(player.x, player.z, radius)) {
        if (wanted && site.type !== wanted) continue;
        const siteDistance = Math.hypot(site.x - player.x, site.z - player.z);
        if (siteDistance < nearestDistance) {
          nearest = site;
          nearestDistance = siteDistance;
        }
        if (siteDistance < nearestNewDistance && !isFound(site.id)) {
          nearestNew = site;
          nearestNewDistance = siteDistance;
        }
      }
      if (nearestNew) break;
    }
    const chosen = nearestNew || nearest;
    return chosen ? toEntry(chosen, player.x, player.z) : null;
  }

  return {
    update(dt, realDt) {
      scanTimer -= realDt;
      if (scanTimer <= 0) {
        scanTimer = SCAN_INTERVAL_SECONDS;
        scanSites();
      }
      buildNext();
      updateLighting();
      const player = state.player.position;
      const time = state.time.elapsed;
      const moved = previousPosition.distanceTo(player);
      const canThread = dt > 0 && moved > 0 && moved < TELEPORT_DISTANCE;
      for (let index = 0; index < activeInstances.length; index++) {
        const instance = activeInstances[index];
        if (instance.animate) instance.animate(dt, time);
        if (!instance.discovered && instance.measure(player) <= DISCOVERY_RADIUS[instance.site.type]) discover(instance);
        if (instance.thread && canThread) checkThread(instance, player, time);
      }
      previousPosition.copy(player);
    },

    getNearby,
    findNearest,

    getStats() {
      let triangles = 0;
      let geometries = 0;
      let balloons = 0;
      let discovered = 0;
      for (const instance of activeInstances) {
        triangles += instance.triangles;
        geometries += instance.geometries.length;
        if (instance.balloons) balloons += instance.balloons.length;
        if (instance.discovered) discovered++;
      }
      return {
        inRange: inRangeCount,
        built: activeInstances.length,
        pending: buildQueue.length,
        geometries,
        triangles,
        balloons,
        discoveredBuilt: discovered,
        lastBuildMs: Math.round(lastBuildMs * 10) / 10,
      };
    },

    /** Debug/testing view of the built landmarks (ids, names, key heights). */
    getBuilt() {
      return activeInstances.map((instance) => ({
        id: instance.site.id,
        type: instance.site.type,
        name: instance.descriptor.name,
        x: Math.round(instance.site.x),
        z: Math.round(instance.site.z),
        baseY: Math.round(instance.group.position.y * 10) / 10,
        rotation: Math.round(instance.group.rotation.y * 1000) / 1000,
        discovered: instance.discovered,
        aim: instance.thread ? { ...instance.thread.aim, span: Math.round(instance.thread.span), height: Math.round(instance.thread.height) } : null,
        balloons: instance.balloons
          ? instance.balloons.map((balloon) => ({
            x: Math.round(instance.site.x + balloon.mesh.position.x),
            y: Math.round(balloon.mesh.position.y),
            z: Math.round(instance.site.z + balloon.mesh.position.z),
          }))
          : null,
      }));
    },

    dispose() {
      for (let index = activeInstances.length - 1; index >= 0; index--) removeInstance(index);
      buildQueue.length = 0;
      queuedIds.clear();
      for (const material of [solidMaterial, balloonMaterial, glowMaterial, beamMaterial]) material.dispose();
      for (const geometry of [beamGeometry, haloGeometry, runeLightGeometry, flameGeometry]) geometry.dispose();
    },
  };
}
