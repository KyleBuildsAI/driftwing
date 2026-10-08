// Planet curvature (contract g.3): visual only. Physics, colliders, water, wind and placement stay
// flat; from 5 km camera altitude the renderer lowers everything by the drop of its horizontal
// distance to the camera, drop = d^2 / 2R, blended in by uniforms.curvatureAmount (0 below 5 km, 1 by
// 8 km; the sky system writes it from state.atmosphere.curvature). R is the setting planetRadiusKm
// (Graphics tab, 200..6371 km, default 1000 km for dramatic but bounded horizons), in
// uniforms.planetRadius (m).
//
// Two ways in:
//   - vertex curvature (TSL): curvedPositionNode(ctx) as a material's positionNode for meshes whose
//     model matrix only translates (terrain chunks, far-field tiles, the water grids), or
//     curvatureDropNode(ctx, worldPosition) for anything else;
//   - the rigid drop (CPU): discrete objects placed each frame (landmarks, structure instances, fauna
//     groups, lures, cloud clusters) lower their root by rigidCurvatureDrop(ctx, x, z), or with
//     applyRigidDrop(ctx, object, baseY), while curvatureAmount > 0.
// With curvatureAmount 0 both are exact identities (y - 0), so nothing moves below 5 km.
//
// The CPU half is pure (no three.js import): the labs import it in node.

export const DEFAULT_PLANET_RADIUS = 1_000_000;
/** The planetRadiusKm setting: range and default (km). */
export const PLANET_RADIUS_KM = Object.freeze({ min: 200, max: 6371, default: 1000 });

/** Clamps a planetRadiusKm setting value to its range and returns the radius in metres. */
export function planetRadiusFromSetting(kilometres) {
  const value = Number.isFinite(kilometres) ? kilometres : PLANET_RADIUS_KM.default;
  return Math.min(PLANET_RADIUS_KM.max, Math.max(PLANET_RADIUS_KM.min, value)) * 1000;
}

/** The curvature drop (m) of a point dx, dz metres (horizontal) from the camera: (dx^2 + dz^2) / 2R. */
export function curvatureDrop(dx, dz, radius) {
  return (dx * dx + dz * dz) / (2 * radius);
}

/**
 * The rigid drop (m) for a discrete object at world (worldX, worldZ) this frame: curvatureDrop of its
 * horizontal distance to the camera times uniforms.curvatureAmount; exactly 0 while that is 0.
 * ctx is the game ctx or a spawn engine's ctx (uniforms.curvatureAmount, uniforms.planetRadius,
 * camera). A ctx whose uniforms carry no curvature blend (the node labs' engine contexts) renders a
 * flat world: the drop is 0. Allocation-free.
 */
export function rigidCurvatureDrop(ctx, worldX, worldZ) {
  const blend = ctx.uniforms.curvatureAmount;
  const amount = blend === undefined ? 0 : blend.value;
  if (!(amount > 0)) return 0;
  const camera = ctx.camera.position;
  return curvatureDrop(worldX - camera.x, worldZ - camera.z, ctx.uniforms.planetRadius.value) * amount;
}

/**
 * Lowers a discrete object (its position is world, its parent the scene) by its rigid drop: y =
 * baseY - drop. Without baseY the object's y when first seen is kept in userData.curvatureBaseY and
 * used as the base (objects nothing else moves vertically, such as the landmark groups). Updates the
 * local matrix of an object with matrixAutoUpdate off, and only when the drop changed. A null object
 * is skipped. Allocation-free after the first call per object.
 */
export function applyRigidDrop(ctx, object, baseY) {
  if (!object) return;
  const data = object.userData;
  let base = baseY;
  if (!Number.isFinite(base)) {
    if (!Number.isFinite(data.curvatureBaseY)) data.curvatureBaseY = object.position.y;
    base = data.curvatureBaseY;
  }
  const drop = rigidCurvatureDrop(ctx, object.position.x, object.position.z);
  const target = base - drop;
  if (object.position.y === target) return;
  object.position.y = target;
  if (!object.matrixAutoUpdate) object.updateMatrix();
}

/**
 * TSL: the curvature drop (m, a float node) of a render-frame world position node: its horizontal
 * distance to cameraPosition, squared, over 2R, times curvatureAmount.
 */
export function curvatureDropNode(ctx, worldPositionNode) {
  const { cameraPosition } = ctx.TSL;
  const uniforms = ctx.uniforms;
  const offsetX = worldPositionNode.x.sub(cameraPosition.x);
  const offsetZ = worldPositionNode.z.sub(cameraPosition.z);
  return offsetX.mul(offsetX).add(offsetZ.mul(offsetZ)).div(uniforms.planetRadius.mul(2)).mul(uniforms.curvatureAmount);
}

/**
 * TSL: positionLocal (or positionLocalNode) lowered by the curvature drop of its horizontal render
 * distance to the camera, for a material's positionNode. Only for meshes whose model matrix
 * translates (no rotation or scale), so local y is world y.
 */
export function curvedPositionNode(ctx, positionLocalNode = null) {
  const { vec3, vec4, positionLocal, modelWorldMatrix } = ctx.TSL;
  const local = positionLocalNode ?? positionLocal;
  const world = modelWorldMatrix.mul(vec4(local, 1)).xyz;
  return vec3(local.x, local.y.sub(curvatureDropNode(ctx, world)), local.z);
}
