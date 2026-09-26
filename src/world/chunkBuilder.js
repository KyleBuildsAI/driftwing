// Builds terrain chunk meshes and vegetation scatter from the world generator. Runs inside the
// terrain worker, and on the main thread as a time-sliced fallback when workers are unavailable.
export function createChunkBuilder(worldGen, config) {
  const chunkSize = config.chunkSize;
  const resolutions = config.lodResolutions;
  const skirtDepths = config.skirtDepths;
  const maxInstances = config.maxInstances;
  const headerFloats = config.headerFloats;
  const typeCount = config.vegetationTypes;
  const kinds = worldGen.VEGETATION;
  const heightScratch = resolutions.map((resolution) => new Float64Array((resolution + 1) * (resolution + 1)));
  const edgeScratch = resolutions.map((resolution) => new Float32Array(resolution * 12));
  const faceColorOut = new Float32Array(3);
  const typeCounts = new Int32Array(typeCount);
  const typeCursor = new Int32Array(typeCount);
  const climateScratch = { temperature: 0, moisture: 0 };
  const weightScratch = new Float64Array(5);
  const tint = new Float64Array(3);
  const scale = new Float64Array(4);
  const SKIRT_SHADE = 0.8;

  function srgbToLinear(channel) {
    return channel < 0.04045 ? channel * 0.0773993808 : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
  }
  function hexToLinearTriplet(hex) {
    return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
  }
  // Foliage / rock tints per vegetation type, per biome (snow, pine, dunes, archipelago, meadows).
  const TINTS = [
    [[0x2b4a42, 0x33554a, 0x55746b], [0x2d5733, 0x386638, 0x284c30, 0x42703c], [0x55653a], [0x356a3c], [0x3b6838, 0x47743f]],
    [[0x5b6f45, 0x687a48], [0x4d7837, 0x5b873e, 0xb3822e], [0x78883f], [0x2c7639, 0x3b8b45, 0x24663a, 0x4f9a48], [0x6c983c, 0x83a642, 0xa3ae48, 0xd08738, 0xc49a3c]],
    [[0x4c8a3a], [0x4c8a3a], [0x6a8c3e, 0x7a9442], [0x4a8c38, 0x62a046, 0x3b7632, 0x74a84c], [0x5a9440]],
    [[0x767a86, 0x8a8a92, 0x676b78], [0x777163, 0x6a7658, 0x847e6e], [0xab6547, 0xbb8550, 0x965842], [0x847868, 0x978c78], [0x969084, 0xa69c88]],
    [[0x4d7845], [0x4d7845], [0x4b7843, 0x5c8849, 0x69904f], [0x5c8849], [0x5c8849]],
    [[0xe58fa6], [0xe58fa6], [0xe58fa6], [0xe58fa6], [0xe58fa6]],
  ].map((perBiome) => perBiome.map((variants) => variants.map(hexToLinearTriplet)));
  const FLOWER_TINTS = [0xe58fa6, 0xf2c94c, 0xa58fd8, 0xf2a7bd, 0xf6efe2].map(hexToLinearTriplet);
  const SINK = [0.25, 0.25, 0.25, 0, 0.2, 0.05];

  function vertexCount(lod) {
    const resolution = resolutions[lod];
    return resolution * resolution * 6 + resolution * 24;
  }

  function writeVertex(positions, normals, colors, vertex, x, y, z, normalX, normalY, normalZ, red, green, blue) {
    const offset = vertex * 3;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    normals[offset] = normalX;
    normals[offset + 1] = normalY;
    normals[offset + 2] = normalZ;
    colors[offset] = red;
    colors[offset + 1] = green;
    colors[offset + 2] = blue;
  }

  /** One flat-shaded lattice triangle; its colour stays in faceColorOut for the skirts. */
  function emitFace(output, vertex, ax, ay, az, bx, by, bz, cx, cy, cz, originX, originZ, quadI, quadJ, triangleIndex) {
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    let normalX = e1y * e2z - e1z * e2y;
    let normalY = e1z * e2x - e1x * e2z;
    let normalZ = e1x * e2y - e1y * e2x;
    const inverseLength = 1 / Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
    normalX *= inverseLength;
    normalY *= inverseLength;
    normalZ *= inverseLength;
    const faceHash = worldGen.hash2(quadI, quadJ, 11 + triangleIndex);
    worldGen.faceColor(
      (ax + bx + cx) / 3 + originX,
      (az + bz + cz) / 3 + originZ,
      (ay + by + cy) / 3,
      1 - normalY,
      normalX,
      normalZ,
      faceHash,
      faceColorOut,
      0,
    );
    const red = faceColorOut[0];
    const green = faceColorOut[1];
    const blue = faceColorOut[2];
    writeVertex(output.positions, output.normals, output.colors, vertex, ax, ay, az, normalX, normalY, normalZ, red, green, blue);
    writeVertex(output.positions, output.normals, output.colors, vertex + 1, bx, by, bz, normalX, normalY, normalZ, red, green, blue);
    writeVertex(output.positions, output.normals, output.colors, vertex + 2, cx, cy, cz, normalX, normalY, normalZ, red, green, blue);
    return vertex + 3;
  }

  function storeEdgeColor(edges, slot) {
    edges[slot * 3] = faceColorOut[0] * SKIRT_SHADE;
    edges[slot * 3 + 1] = faceColorOut[1] * SKIRT_SHADE;
    edges[slot * 3 + 2] = faceColorOut[2] * SKIRT_SHADE;
  }

  /** Vertical skirt quad hanging below edge segment a-b, facing outward. */
  function emitSkirt(output, vertex, skirtDepth, ax, ay, az, bx, by, bz, outwardX, outwardZ, edges, slot) {
    const red = edges[slot * 3];
    const green = edges[slot * 3 + 1];
    const blue = edges[slot * 3 + 2];
    const lowA = ay - skirtDepth;
    const lowB = by - skirtDepth;
    const facesOutward = (bz - az) * outwardX - (bx - ax) * outwardZ > 0;
    const { positions, normals, colors } = output;
    if (facesOutward) {
      writeVertex(positions, normals, colors, vertex, ax, ay, az, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 1, bx, by, bz, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 2, ax, lowA, az, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 3, bx, by, bz, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 4, bx, lowB, bz, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 5, ax, lowA, az, outwardX, 0, outwardZ, red, green, blue);
    } else {
      writeVertex(positions, normals, colors, vertex, bx, by, bz, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 1, ax, ay, az, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 2, bx, lowB, bz, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 3, ax, ay, az, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 4, ax, lowA, az, outwardX, 0, outwardZ, red, green, blue);
      writeVertex(positions, normals, colors, vertex + 5, bx, lowB, bz, outwardX, 0, outwardZ, red, green, blue);
    }
    return vertex + 6;
  }

  /**
   * Flat-shaded chunk mesh (non-indexed, LOCAL coordinates). Triangulation matches
   * worldGen.groundHeight: quad (i,j) -> [v(i,j), v(i,j+1), v(i+1,j)], [v(i+1,j), v(i,j+1), v(i+1,j+1)].
   * Yields once per lattice row so the main-thread fallback can time-slice it.
   */
  function* buildMesh(job, output) {
    const resolution = resolutions[job.lod];
    const step = chunkSize / resolution;
    const side = resolution + 1;
    const originX = job.cx * chunkSize;
    const originZ = job.cz * chunkSize;
    const heights = heightScratch[job.lod];
    const edges = edgeScratch[job.lod];
    const skirtDepth = skirtDepths[job.lod];
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 0; j <= resolution; j++) {
      for (let i = 0; i <= resolution; i++) {
        const height = worldGen.heightAt(originX + i * step, originZ + j * step);
        heights[j * side + i] = height;
        if (height < minY) minY = height;
        if (height > maxY) maxY = height;
      }
      yield;
    }
    const quadBaseI = job.cx * resolution;
    const quadBaseJ = job.cz * resolution;
    let vertex = 0;
    for (let j = 0; j < resolution; j++) {
      const z0 = j * step;
      const z1 = z0 + step;
      for (let i = 0; i < resolution; i++) {
        const x0 = i * step;
        const x1 = x0 + step;
        const h00 = heights[j * side + i];
        const h10 = heights[j * side + i + 1];
        const h01 = heights[(j + 1) * side + i];
        const h11 = heights[(j + 1) * side + i + 1];
        vertex = emitFace(output, vertex, x0, h00, z0, x0, h01, z1, x1, h10, z0, originX, originZ, quadBaseI + i, quadBaseJ + j, 0);
        if (j === 0) storeEdgeColor(edges, i);
        if (i === 0) storeEdgeColor(edges, resolution + j);
        vertex = emitFace(output, vertex, x1, h10, z0, x0, h01, z1, x1, h11, z1, originX, originZ, quadBaseI + i, quadBaseJ + j, 1);
        if (j === resolution - 1) storeEdgeColor(edges, 2 * resolution + i);
        if (i === resolution - 1) storeEdgeColor(edges, 3 * resolution + j);
      }
      yield;
    }
    for (let i = 0; i < resolution; i++) {
      vertex = emitSkirt(output, vertex, skirtDepth, i * step, heights[i], 0, (i + 1) * step, heights[i + 1], 0, 0, -1, edges, i);
    }
    for (let j = 0; j < resolution; j++) {
      vertex = emitSkirt(
        output, vertex, skirtDepth,
        0, heights[j * side], j * step,
        0, heights[(j + 1) * side], (j + 1) * step,
        -1, 0, edges, resolution + j,
      );
    }
    for (let i = 0; i < resolution; i++) {
      const row = resolution * side;
      vertex = emitSkirt(
        output, vertex, skirtDepth,
        i * step, heights[row + i], chunkSize,
        (i + 1) * step, heights[row + i + 1], chunkSize,
        0, 1, edges, 2 * resolution + i,
      );
    }
    for (let j = 0; j < resolution; j++) {
      vertex = emitSkirt(
        output, vertex, skirtDepth,
        chunkSize, heights[j * side + resolution], j * step,
        chunkSize, heights[(j + 1) * side + resolution], (j + 1) * step,
        1, 0, edges, 3 * resolution + j,
      );
    }
    output.minY = minY - skirtDepth;
    output.maxY = maxY;
    output.vertexCount = vertex;
  }

  function computeScale(type, baseScale, variant) {
    const detail = variant * 7.31 - Math.floor(variant * 7.31);
    const detailB = variant * 3.17 - Math.floor(variant * 3.17);
    let scaleX = baseScale;
    let scaleY = baseScale;
    let scaleZ = baseScale;
    if (type === kinds.PINE) {
      scaleY = baseScale * (0.9 + 0.25 * detail);
    } else if (type === kinds.BROADLEAF) {
      scaleX = baseScale * (0.9 + 0.2 * detail);
      scaleZ = scaleX;
      scaleY = baseScale * (0.92 + 0.16 * detailB);
    } else if (type === kinds.PALM) {
      scaleY = baseScale * (0.94 + 0.14 * detail);
    } else if (type === kinds.ROCK) {
      scaleX = baseScale * (0.8 + 0.45 * detail);
      scaleY = baseScale * (0.62 + 0.4 * detailB);
      scaleZ = baseScale * (0.8 + 0.45 * (1 - detail));
    } else if (type === kinds.FLOWERS) {
      scaleY = baseScale * (0.85 + 0.3 * detail);
    }
    scale[0] = scaleX;
    scale[1] = scaleY;
    scale[2] = scaleZ;
    scale[3] = detailB;
  }

  function computeTint(type, variant, worldX, worldZ) {
    if (type === kinds.FLOWERS) {
      const cellPick = worldGen.hash2(Math.floor(worldX / 60), Math.floor(worldZ / 60), 7);
      const detail = variant * 5.19 - Math.floor(variant * 5.19);
      const index = variant < 0.72 ? Math.min(2, Math.floor(cellPick * 3)) : 3 + Math.min(1, Math.floor(detail * 2));
      const flower = FLOWER_TINTS[index];
      tint[0] = flower[0];
      tint[1] = flower[1];
      tint[2] = flower[2];
      return;
    }
    worldGen.climate(worldX, worldZ, climateScratch);
    worldGen.biomeWeights(climateScratch.temperature, climateScratch.moisture, weightScratch);
    let red = 0;
    let green = 0;
    let blue = 0;
    let total = 0;
    const perBiome = TINTS[type];
    for (let biome = 0; biome < 5; biome++) {
      const weight = weightScratch[biome];
      if (weight < 0.02) continue;
      const variants = perBiome[biome];
      const choice = variants[Math.min(variants.length - 1, Math.floor(variant * variants.length))];
      red += choice[0] * weight;
      green += choice[1] * weight;
      blue += choice[2] * weight;
      total += weight;
    }
    const normaliser = total > 0 ? 1 / total : 1;
    tint[0] = red * normaliser;
    tint[1] = green * normaliser;
    tint[2] = blue * normaliser;
  }

  /**
   * Vegetation for a chunk, grouped by type. Regions: header (per type: count, start, minY,
   * maxY, maxScaleY, maxScaleXZ), placements (x, y, z LOCAL to the chunk origin, rotation Y),
   * scales (x, y, z) and linear colour tints (r, g, b).
   */
  function* buildScatter(job, output) {
    const raw = worldGen.scatterChunk(job.cx, job.cz, job.density);
    yield;
    const stride = worldGen.SCATTER_STRIDE;
    const total = Math.min(Math.floor(raw.length / stride), maxInstances);
    typeCounts.fill(0);
    for (let index = 0; index < total; index++) {
      const type = raw[index * stride + 5] | 0;
      if (type >= 0 && type < typeCount) typeCounts[type]++;
    }
    let start = 0;
    for (let type = 0; type < typeCount; type++) {
      const header = type * 6;
      output[header] = typeCounts[type];
      output[header + 1] = start;
      output[header + 2] = 1e9;
      output[header + 3] = -1e9;
      output[header + 4] = 0;
      output[header + 5] = 0;
      typeCursor[type] = start;
      start += typeCounts[type];
    }
    const scaleOffset = headerFloats + maxInstances * 4;
    const tintOffset = scaleOffset + maxInstances * 3;
    const originX = job.cx * chunkSize;
    const originZ = job.cz * chunkSize;
    for (let index = 0; index < total; index++) {
      const base = index * stride;
      const type = raw[base + 5] | 0;
      if (type < 0 || type >= typeCount) continue;
      const localX = raw[base];
      const groundY = raw[base + 1];
      const localZ = raw[base + 2];
      const variant = raw[base + 6];
      const slot = typeCursor[type]++;
      computeScale(type, raw[base + 3], variant);
      const baseY = groundY - SINK[type] * scale[1];
      const placement = headerFloats + slot * 4;
      output[placement] = localX;
      output[placement + 1] = baseY;
      output[placement + 2] = localZ;
      output[placement + 3] = raw[base + 4];
      const scaleSlot = scaleOffset + slot * 3;
      output[scaleSlot] = scale[0];
      output[scaleSlot + 1] = scale[1];
      output[scaleSlot + 2] = scale[2];
      computeTint(type, variant, originX + localX, originZ + localZ);
      const brightness = 0.88 + 0.24 * scale[3];
      const tintSlot = tintOffset + slot * 3;
      output[tintSlot] = tint[0] * brightness;
      output[tintSlot + 1] = tint[1] * brightness;
      output[tintSlot + 2] = tint[2] * brightness;
      const header = type * 6;
      if (baseY < output[header + 2]) output[header + 2] = baseY;
      if (baseY > output[header + 3]) output[header + 3] = baseY;
      if (scale[1] > output[header + 4]) output[header + 4] = scale[1];
      const horizontal = scale[0] > scale[2] ? scale[0] : scale[2];
      if (horizontal > output[header + 5]) output[header + 5] = horizontal;
    }
  }

  return { vertexCount, buildMesh, buildScatter };
}
