/**
 * WIND SWAY: the WindField's near-ground wind as a small texture the vegetation shader sways by
 * (contract section d.4).
 *
 * A 64 x 64 texture of 32 m cells covers a 2 km square around the streaming focus, laid toroidally
 * over the world (texel = world cell modulo 64, RepeatWrapping), re-centred on 32 m steps. Each texel
 * holds the wind at 10 m above the terrain there, from wind.probe (allocation-free, into one sample
 * object): the horizontal wind (R, G: -25..25 m/s) and the turbulence and gusts (B: 0..1). CELLS_PER_FRAME
 * texels are refreshed per frame (a full WindField probe costs about 10 us, so the whole square takes
 * 128 frames, about two seconds, for about 0.3 ms a frame), so a spawn's wind source (a dust devil, a
 * gust front, a microburst) visibly ripples the vegetation it reaches.
 *
 * swaySample(worldXZ) -> vec3(wind x, wind z, gust): the wind in units of the calm prevailing wind at
 * 10 m (so the calm ambient gives exactly windDirection x windStrength, the Phase 1 sway), and the
 * gust share. Outside the square (shrunk by the focus's drift during a sweep) it falls back to the
 * global windDirection / windStrength uniforms.
 * Bytes (RGBA8, linear filtering) work the same on WebGPU and WebGL2.
 */
const SIZE = 64;
const CELL = 32;
const SPAN = SIZE * CELL;
const CELLS_PER_FRAME = 32;
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

  // The window centre (world xz, on the 32 m lattice) at the end of the last sweep, the half-size of
  // the square every texel of that sweep agrees on (see update), and the calm wind at 10 m per unit
  // windStrength.
  const centre = uniform(new T.Vector2(0, 0));
  const validHalf = uniform(0);
  const reference = uniform(1);
  // Not ready until the whole square was filled once: before that the global uniforms sway everything.
  const ready = uniform(0);
  const probePoint = new T.Vector3();
  const sample = { vel: new T.Vector3(), turbulence: 0 };
  const cursor = new Int32Array([0, 0]);
  const window = new Float64Array([NaN, NaN]);
  /** The window at the start of the sweep in progress. */
  const sweepStart = new Float64Array([NaN, NaN]);

  /** The calm ambient wind at 10 m above the ground at (x, z) per unit windStrength (m/s). */
  function measureReference(x, z) {
    if (typeof wind?.ambientAt !== 'function') return;
    const ambient = wind.ambientAt({ x, y: world.heightAt(x, z) + PROBE_AGL, z });
    const strength = uniforms.windStrength.value;
    if (ambient && Number.isFinite(ambient.speed) && ambient.speed > 0.05 && strength > 0.05) reference.value = ambient.speed / strength;
  }

  function writeCell(cellX, cellZ) {
    const x = (cellX + 0.5) * CELL;
    const z = (cellZ + 0.5) * CELL;
    // worldgen's heightAt (not the triangulated groundHeight): close enough 10 m up, at a quarter of the cost.
    probePoint.set(x, world.heightAt(x, z) + PROBE_AGL, z);
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
    const inside = step(max(offset.x, offset.y), validHalf).mul(ready);
    const fallback = vec3(uniforms.windDirection.x.mul(uniforms.windStrength), uniforms.windDirection.y.mul(uniforms.windStrength), 0);
    return mix(fallback, vec3(decoded, texel.b), inside);
  });

  return {
    swaySample: (worldXZ) => swaySample(vec2(worldXZ)),
    texture: swayTexture,
    /** Every frame: re-centres on the focus (world xz) and refreshes CELLS_PER_FRAME texels from the WindField. */
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
      for (let pass = 0; pass < CELLS_PER_FRAME; pass++) {
        const cell = cursor[0];
        if (cell === 0) {
          sweepStart[0] = window[0];
          sweepStart[1] = window[1];
        }
        writeCell(firstCellX + (cell % SIZE), firstCellZ + Math.floor(cell / SIZE));
        cursor[0] = (cell + 1) % (SIZE * SIZE);
        if (cursor[0] === 0) {
          cursor[1]++;
          // The window moved with the focus during the sweep, so a texel holds the cell of the window
          // it was written in: only cells inside every window of the sweep are right. That square
          // shrinks by the drift, less a margin of four cells.
          const drift = Math.max(Math.abs(window[0] - sweepStart[0]), Math.abs(window[1] - sweepStart[1]));
          centre.value.set(window[0], window[1]);
          validHalf.value = Math.max(0, SPAN / 2 - 4 * CELL - drift);
          ready.value = 1;
        }
      }
      swayTexture.needsUpdate = true;
    },
    getStats() {
      return { sweeps: cursor[1], ready: ready.value === 1, validHalf: validHalf.value, reference: Math.round(reference.value * 100) / 100 };
    },
    dispose() {
      swayTexture.dispose();
    },
  };
}
