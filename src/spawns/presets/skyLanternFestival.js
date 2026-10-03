// Preset 25: Sky lantern festival (rare event, night). Hundreds of paper lanterns rise from a
// lighthouse or a balloon fair and drift away on the real WindField wind (emitter engine, lantern
// style; its wind grid samples the field, so they follow the breeze and other spawns' air), with the
// launch crowd's lights on the ground and a warm real light at the launch (lightEffect engine). The
// director's filters.near moves each candidate onto the nearest lighthouse or balloon fair.
//
// Ending without lanterns vanishing mid-air: the launches run for one seeded 5-6 minute stretch (a
// single long schedule cycle), and the event's duration leaves the last lanterns their full life
// before the spawn ends.
export default Object.freeze({
  id: 'skyLanternFestival',
  name: 'Sky lantern festival',
  category: 'celestial',
  kind: 'event',
  rarity: 'rare',
  heavy: false,
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 900, chance: 0.5 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['dusk', 'night']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'any',
    minDistance: 3000,
    maxDistance: 8000,
    near: Object.freeze({ landmarks: Object.freeze(['lighthouse', 'balloons']), radius: 4000 }),
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 640,
        style: 'lantern',
        shape: Object.freeze({ type: 'disc', radius: 220 }),
        hugGround: true,
        offset: Object.freeze([0, 3, 0]),
        speed: Object.freeze([0.4, 0.9]),
        spread: 10,
        gravity: 0,
        buoyancy: 1.25,
        drag: 0.35,
        windFollow: 0.75,
        turbulence: Object.freeze({ wobble: 3, frequency: 0.08 }),
        life: Object.freeze([110, 150]),
        size: Object.freeze([4.2, 3.4]),
        sizeJitter: 0.15,
        colors: Object.freeze([0xffb45a, 0xff9a40, 0xff7a30]),
        emissive: 1.7,
        fadeIn: 0.02,
        fadeOut: 4,
        nightBoost: 0.6,
        fog: 0.45,
        schedule: Object.freeze({ period: Object.freeze([86400, 86400]), active: Object.freeze([300, 360]), rampUp: 20, rampDown: 40, idle: 0, startActive: true }),
        field: Object.freeze({ extent: 3000, height: 900 }),
        lod: Object.freeze({ near: 1, mid: 0.6, far: 0.3 }),
        sound: true,
      }),
    }),
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        glows: Object.freeze([
          Object.freeze({ layout: 'scatter', count: 48, radius: 150, onGround: true, height: Object.freeze([1, 2]), size: Object.freeze([4, 7]), colors: Object.freeze([0xffb45a, 0xffc070]), intensity: 2, flicker: 0.2 }),
          Object.freeze({ layout: 'scatter', count: 14, radius: 90, onGround: true, height: Object.freeze([0.5, 1.5]), size: Object.freeze([10, 16]), colors: Object.freeze([0xff9a40]), intensity: 1.4, flicker: 0.35 }),
        ]),
        light: Object.freeze({ color: 0xffa050, intensity: 6e4, range: 500, offset: Object.freeze([0, 15, 0]), flicker: 0.15, night: 1 }),
        visibility: Object.freeze({ day: 0.2, night: 1 }),
        sound: false,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 9000, far: 22000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'lantern', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Sky lantern festival',
    description: 'Hundreds of paper lanterns lifting from the shore into the night, drifting wherever the wind carried them.',
  }),
  discovery: Object.freeze({ radius: 4500, requireInView: true }),
  callouts: Object.freeze([
    'Lights rising {direction}, {distance} out. It is a lantern festival.',
    'Sky lanterns going up {direction}. Fly downwind of the launch and they will drift past us.',
    'Look at that, {direction}: hundreds of lanterns on the breeze. About {eta} away.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([570, 600]), despawn: Object.freeze({ distance: 14000, hysteresis: 3000, outOfViewSeconds: 25 }) }),
});
