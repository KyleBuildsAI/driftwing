import { CONFIG } from '../core/config.js';
import { oceanSwellScale } from '../world/waterQuery.js';
import { createWaterEffects } from './waterEffects.js';
import { createWaterLighting, createWaterMaterial, createWaveClock } from './waterMaterial.js';

/**
 * WATER: an 8 km wave grid that follows the camera.
 *
 * - Geometry: a tensor-product grid, 4 m spacing in the central 384 m square and
 *   geometrically widening cells out to +-4 km. Every vertex sits on the 4 m
 *   lattice and the mesh is snapped to 4 m steps, so the swell never swims.
 * - Waves and shading: the ocean water material (waterMaterial.js) on the shared wave table of the
 *   water query (ctx.waterQuery.waves: 4 Gerstner swells that displace the vertices and 9 detail
 *   waves that only shape the normal, every wave vector quantised to whole cycles over a 4096 m tile
 *   so the shader works on wrapped coordinates and stays precise hundreds of km out). The swell
 *   scale follows the flight clock through the same function the physics reads (oceanSwellScale),
 *   so a crest is drawn where a float meets it.
 * - Local effects (Phase 2, waterEffects.js): whirlpool funnels, ripple rings, foam and
 *   bioluminescent trails, added to the displacement, the normal, the colour and the emission. With
 *   none active every added term is exactly zero, so the ocean renders as in Phase 1. The layer is
 *   attached to the water query, so the funnels lower the queried surface too.
 * - The wave clock and the water lighting are shared with the local water bodies (waterBodies.js).
 */
export function createWaterSystem(ctx) {
  const { THREE: T, scene, camera, state } = ctx;

  const GRID_HALF_EXTENT = 4000;
  const GRID_STEP = 4;
  const INNER_CELLS = 48;
  const HALF_SEGMENTS = 110;
  const WAVE_TILE = 4096;

  // ---- Grid geometry ----------------------------------------------------------------
  /** Axis coordinates 0..HALF_SEGMENTS: uniform inner cells, then geometric growth, all on the 4 m lattice. */
  function buildAxisCoordinates() {
    const outerSteps = HALF_SEGMENTS - INNER_CELLS;
    const outerExtent = GRID_HALF_EXTENT - INNER_CELLS * GRID_STEP;
    let low = 1.0001;
    let high = 1.5;
    for (let iteration = 0; iteration < 60; iteration++) {
      const ratio = (low + high) / 2;
      const extent = (GRID_STEP * ratio * (Math.pow(ratio, outerSteps) - 1)) / (ratio - 1);
      if (extent > outerExtent) high = ratio;
      else low = ratio;
    }
    const growth = (low + high) / 2;
    const coordinates = new Float64Array(HALF_SEGMENTS + 1);
    let position = 0;
    let spacing = GRID_STEP;
    for (let index = 1; index <= HALF_SEGMENTS; index++) {
      if (index > INNER_CELLS) spacing *= growth;
      position += spacing;
      coordinates[index] = Math.round(position / GRID_STEP) * GRID_STEP;
    }
    return coordinates;
  }

  function buildGridGeometry(axis) {
    const side = HALF_SEGMENTS * 2 + 1;
    const values = new Float64Array(side);
    for (let index = 0; index < side; index++) {
      const offset = index - HALF_SEGMENTS;
      values[index] = Math.sign(offset) * axis[Math.abs(offset)];
    }
    const positions = new Float32Array(side * side * 3);
    const normals = new Float32Array(side * side * 3);
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        const vertex = (row * side + column) * 3;
        positions[vertex] = values[column];
        positions[vertex + 2] = values[row];
        normals[vertex + 1] = 1;
      }
    }
    const segments = side - 1;
    const indices = new Uint32Array(segments * segments * 6);
    let cursor = 0;
    for (let row = 0; row < segments; row++) {
      for (let column = 0; column < segments; column++) {
        const a = row * side + column;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        // Counter-clockwise seen from above (+y): [v(i,j), v(i,j+1), v(i+1,j)] and [v(i+1,j), v(i,j+1), v(i+1,j+1)].
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
    geometry.setIndex(new T.BufferAttribute(indices, 1));
    geometry.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), GRID_HALF_EXTENT * Math.SQRT2 + 8);
    return geometry;
  }

  const axisCoordinates = buildAxisCoordinates();
  const waves = ctx.waterQuery.waves;

  // Local effects layer: spawns write into it (ctx.systems.water.effects, the engine ctx's `water`).
  const effects = createWaterEffects(ctx);
  ctx.waterQuery.attachEffects(effects);
  const clock = createWaveClock(ctx, waves);
  const lighting = createWaterLighting(ctx);
  const ocean = createWaterMaterial(ctx, { kind: 'ocean', waves, axis: axisCoordinates, gridHalfExtent: GRID_HALF_EXTENT, effects, clock, lighting });

  const mesh = new T.Mesh(buildGridGeometry(axisCoordinates), ocean.material);
  mesh.name = 'water';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  scene.add(mesh);

  // ---- Per-frame -----------------------------------------------------------------------
  function positiveModulo(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
  }

  function followCamera(referenceX, referenceZ) {
    const anchorX = Math.round(referenceX / GRID_STEP) * GRID_STEP;
    const anchorZ = Math.round(referenceZ / GRID_STEP) * GRID_STEP;
    mesh.position.set(anchorX, CONFIG.WATER_LEVEL, anchorZ);
    ocean.waveOrigin.value.set(positiveModulo(anchorX, WAVE_TILE), positiveModulo(anchorZ, WAVE_TILE));
    ocean.cameraOffset.value.set(referenceX - anchorX, referenceZ - anchorZ);
  }

  function advance(elapsed) {
    clock.advance(elapsed);
    ocean.swellScale.value = oceanSwellScale(elapsed);
  }

  followCamera(state.player.position.x, state.player.position.z);
  advance(state.time.elapsed);
  lighting.update(state.time);

  return {
    mesh,
    /** The local effects layer (waterEffects.js): the spawns' water API. */
    effects,
    /** The wave clock, the lighting and the ocean's swell scale uniform, shared with waterBodies.js. */
    clock,
    lighting,
    swellScale: ocean.swellScale,
    update(dt, realDt) {
      followCamera(camera.position.x, camera.position.z);
      advance(state.time.elapsed);
      lighting.update(state.time);
      effects.update(dt, realDt, mesh.position, camera.position);
    },
    getStats() {
      return { effects: effects.stats(), query: ctx.waterQuery.getStats() };
    },
  };
}
