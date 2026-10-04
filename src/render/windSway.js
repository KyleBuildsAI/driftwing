/**
 * WIND SWAY: the WindField's near-ground wind as a small texture the vegetation shader sways by
 * (contract section d.4).
 *
 * A 64 x 64 texture of 32 m cells covers a 2 km square around the streaming focus, laid toroidally
 * over the world (texel = world cell modulo 64, RepeatWrapping), re-centred on 32 m steps. Each texel
 * holds the wind at 10 m above the ground there, from wind.probe (allocation-free, into one sample
 * object): the horizontal wind (R, G: -25..25 m/s) and the turbulence and gusts (B: 0..1). A few rows
 * are refreshed per frame (the whole square every ROWS / ROWS_PER_FRAME frames), so a spawn's wind
 * source (a dust devil, a gust front, a microburst) visibly ripples the vegetation it reaches.
 *
 * swaySample(worldXZ) -> vec3(wind x, wind z, gust): the wind in units of the calm prevailing wind at
 * 10 m (so the calm ambient gives exactly windDirection x windStrength, the Phase 1 sway), and the
 * gust share. Outside the square it falls back to the global windDirection / windStrength uniforms.
 * Bytes (RGBA8, linear filtering) work the same on WebGPU and WebGL2.
 */
const SIZE = 64;
const CELL = 32;
const SPAN = SIZE * CELL;
const ROWS_PER_FRAME = 2;
const WIND_RANGE = 25;
const PROBE_AGL = 10;

export function createWindSway(ctx) {
  const { THREE: T, TSL, uniforms, world, state } = ctx;
  const { Fn, texture, vec2, vec3, max, abs, step, mix, uniform } = TSL;
  const wind = ctx.wind;
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let index = 0; index < SIZE * SIZE; index++) {
    bytes[index * 4] = 128;
    bytes[index * 4 + 1] = 128;
    bytes[index * 4 + 2] = 0;
    bytes[index * 4 + 3] = 255;
  }
  const swayTexture = new T.DataTexture(bytes, SIZE, SIZE, T.RGBAFormat, T.UnsignedByteType);
  swayTexture.name = 'wind-sway';
  swayTexture.wrapS = T.RepeatWrapping;
  swayTexture.wrapT = T.RepeatWrapping;
  swayTexture.magFilter = T.LinearFilter;
  swayTexture.minFilter = T.LinearFilter;
  swayTexture.generateMipmaps = false;
  swayTexture.needsUpdate = true;

  // The window centre (world xz, on the 32 m lattice) and the calm wind at 10 m per unit windStrength.
  const centre = uniform(new T.Vector2(NaN, NaN));
  const reference = uniform(1);
  // Not ready until the whole square was filled once: before that the global uniforms sway everything.
  const ready = uniform(0);
  const probePoint = new T.Vector3();
  const sample = { vel: new T.Vector3(), turbulence: 0 };
  const cursor = new Int32Array([0, 0]);
  const window = new Float64Array([NaN, NaN]);

  /** The calm ambient wind at 10 m above the ground at (x, z) per unit windStrength (m/s). */
  function measureReference(x, z) {
    if (typeof wind?.ambientAt !== 'function') return;
    const ambient = wind.ambientAt({ x, y: world.groundHeight(x, z) + PROBE_AGL, z });
    const strength = uniforms.windStrength.value;
    if (ambient && Number.isFinite(ambient.speed) && ambient.speed > 0.05 && strength > 0.05) reference.value = ambient.speed / strength;
  }

  function writeCell(cellX, cellZ) {
    const x = (cellX + 0.5) * CELL;
    const z = (cellZ + 0.5) * CELL;
    probePoint.set(x, world.groundHeight(x, z) + PROBE_AGL, z);
    wind.probe(probePoint, state.time.elapsed, sample);
    const column = ((cellX % SIZE) + SIZE) % SIZE;
    const row = ((cellZ % SIZE) + SIZE) % SIZE;
    const offset = (row * SIZE + column) * 4;
    const windX = Math.min(Math.max(sample.vel.x / WIND_RANGE, -1), 1);
    const windZ = Math.min(Math.max(sample.vel.z / WIND_RANGE, -1), 1);
    bytes[offset] = Math.round((windX * 0.5 + 0.5) * 255);
    bytes[offset + 1] = Math.round((windZ * 0.5 + 0.5) * 255);
    bytes[offset + 2] = Math.round(Math.min(Math.max(sample.turbulence, 0), 1) * 255);
  }

  /** The vegetation sway's wind at a world-space xz node: vec3(wind x, wind z, gust), see above. */
  const swaySample = Fn(([worldXZ]) => {
    const texel = texture(swayTexture, worldXZ.div(SPAN));
    const decoded = texel.rg.mul(2).sub(1).mul(WIND_RANGE).div(max(reference, 0.05));
    const offset = abs(worldXZ.sub(centre));
    // A margin of four cells: the focus moves on while a sweep refreshes the square.
    const inside = step(max(offset.x, offset.y), SPAN / 2 - 4 * CELL).mul(ready);
    const fallback = vec3(uniforms.windDirection.x.mul(uniforms.windStrength), uniforms.windDirection.y.mul(uniforms.windStrength), 0);
    return mix(fallback, vec3(decoded, texel.b), inside);
  });

  return {
    swaySample: (worldXZ) => swaySample(vec2(worldXZ)),
    texture: swayTexture,
    /** Every frame: re-centres on the focus (world xz) and refreshes a few rows from the WindField. */
    update(focusX, focusZ) {
      if (!wind || typeof wind.probe !== 'function') return;
      const centreX = Math.round(focusX / CELL) * CELL;
      const centreZ = Math.round(focusZ / CELL) * CELL;
      if (centreX !== window[0] || centreZ !== window[1]) {
        if (!(window[0] === window[0])) measureReference(focusX, focusZ);
        window[0] = centreX;
        window[1] = centreZ;
      }
      const firstCellX = Math.round(window[0] / CELL) - SIZE / 2;
      const firstCellZ = Math.round(window[1] / CELL) - SIZE / 2;
      for (let pass = 0; pass < ROWS_PER_FRAME; pass++) {
        const rowIndex = cursor[0];
        for (let column = 0; column < SIZE; column++) writeCell(firstCellX + column, firstCellZ + rowIndex);
        cursor[0] = (rowIndex + 1) % SIZE;
        if (cursor[0] === 0) {
          cursor[1]++;
          centre.value.set(window[0], window[1]);
          ready.value = 1;
        }
      }
      swayTexture.needsUpdate = true;
    },
    getStats() {
      return { sweeps: cursor[1], ready: ready.value === 1, reference: Math.round(reference.value * 100) / 100 };
    },
    dispose() {
      swayTexture.dispose();
    },
  };
}
