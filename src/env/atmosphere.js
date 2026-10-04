// Atmosphere: the ONE air density model (re-exported from flight/telemetry.js, the model the physics
// flies in) and the render inputs it drives from the camera altitude: the sky darkening toward black,
// the daylight stars, the blue limb, the sharpening sun, the fog density, the horizon distance and the
// curvature blend (contract g.1). Pure and DOM-free: the sky system calls skyState() once per frame
// into state.atmosphere, and tools/lab/atmosphere.mjs checks every number against its formula.
//
// Every render input is a smooth function of the optical depth to space in scale heights,
// -ln(rho / rho0) = altitude / 8500 m, so "air density drives the sky" literally: each input starts
// at exactly 0 below 3 km (the golden-hour opening stays pixel-identical) and settles by the
// altitude where the air above it is thin enough:
//
//   skyDarkness     0 below 3.8 km, 0.5 at 20 km, black sky by 35 km
//   sunSharpness    0 below 4.3 km, full at 34 km (the disc sharpens, the Mie glow narrows)
//   limb            0 below 7.7 km, full at 28 km (the thin blue band at the horizon)
//   starVisibility  0 below 24.6 km, 0.4 at 30 km, 0.9 at 35 km, full at 37.4 km (stars by day)
//   hazeBlend       0 below 6 km, 1 at 9 km: the Phase 1 fog hands over to the column haze
//   farField        0 below 6 km, 1 at 6.5 km: the far-field planet tiles draw
//   handoff         0 below 11 km, 1 at 13 km: the terrain chunks hand the whole ground to the far field
//   curvature       0 below 5 km, 1 at 8 km: the vertex curvature blend (render/curvature.js)
//
// The horizon distance is sqrt(2 R h + h^2) for the planet radius R (render/curvature.js
// DEFAULT_PLANET_RADIUS, the setting planetRadiusKm). The render curvature is the parabola
// drop = d^2 / 2R, whose horizon seen from h lies at the tangent distance sqrt(2 R h) at the dip
// angle atan(sqrt(2 h / R)) below the horizontal (the parabola's acos(R / (R + h)), within 0.7 degrees
// of it at 120 km over a 1000 km planet), so the sky's limb sits exactly on the rendered planet edge.
import { airDensity, SEA_LEVEL_DENSITY, DENSITY_SCALE_HEIGHT, speedOfSound } from '../flight/telemetry.js';
import { DEFAULT_PLANET_RADIUS } from '../render/curvature.js';

export { airDensity, SEA_LEVEL_DENSITY, speedOfSound };

/** The far plane and the far field never reach beyond this (m): the WebGL2 depth range (contract g.2). */
export const MAX_VIEW_DISTANCE = 600000;
/** Below this camera altitude (m) every render input is exactly neutral. */
export const ATMOSPHERE_NEUTRAL_BELOW = 3000;
/** Curvature blend band (m, camera altitude MSL). */
export const CURVATURE_START = 5000;
export const CURVATURE_FULL = 8000;
/** The far-field tiles fade in over this band (m). */
export const FAR_FIELD_START = 6000;
export const FAR_FIELD_FULL = 6500;
/** The Phase 1 fog hands over to the column haze over this band (m). */
export const HAZE_START = 6000;
export const HAZE_FULL = 9000;
/** The terrain chunks hand the whole ground to the far field over this band (m, contract g.4). */
export const HANDOFF_START = 11000;
export const HANDOFF_FULL = 13000;

// Optical depth bands (scale heights, -ln(rho / rho0)) of the render inputs; see the file header.
const DARKNESS_BAND = Object.freeze([0.45, 4.2]);
const SHARPNESS_BAND = Object.freeze([0.5, 4.0]);
const LIMB_BAND = Object.freeze([0.9, 3.3]);
const STAR_BAND = Object.freeze([2.9, 4.4]);
/** The view distance reaches past the tangent point by this share, so the rim is never cut. */
const VIEW_MARGIN = 1.03;

function smoothUnit(value) {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

function smoothRange(edge0, edge1, value) {
  return smoothUnit((value - edge0) / (edge1 - edge0));
}

/** rho / rho0: the exponential model the physics flies in (1 at sea level, 0.0001 at 78 km). */
export function densityRatio(altitude) {
  return Math.exp(-Math.max(altitude, -500) / DENSITY_SCALE_HEIGHT);
}

/** The optical depth to space in scale heights at altitude: -ln(densityRatio), never below 0. */
export function scaleHeightsAbove(altitude) {
  return Math.max(0, altitude) / DENSITY_SCALE_HEIGHT;
}

/** Horizon distance (m) from altitude h over a planet of radius R: sqrt(2 R h + h^2). */
export function horizonDistance(altitude, radius = DEFAULT_PLANET_RADIUS) {
  const height = Math.max(0, altitude);
  return Math.sqrt(2 * radius * height + height * height);
}

/** Dip (rad) of the rendered horizon below the horizontal from altitude h: atan(sqrt(2 h / R)). */
export function horizonDip(altitude, radius = DEFAULT_PLANET_RADIUS) {
  return Math.atan(Math.sqrt((2 * Math.max(0, altitude)) / radius));
}

/** A fresh state.atmosphere record (every field neutral, as at sea level). */
export function createAtmosphereState() {
  return {
    altitude: 0,
    density: SEA_LEVEL_DENSITY,
    densityRatio: 1,
    skyDarkness: 0,
    starVisibility: 0,
    limb: 0,
    sunSharpness: 0,
    fogScale: 1,
    horizonDistance: 0,
    curvature: 0,
    viewDistance: 0,
    // Additive to contract g.1 (documented in the progress file):
    /** Dip (rad) of the rendered horizon below the horizontal. */
    horizonDip: 0,
    /** 0..1: the Phase 1 fog hands over to the column haze. */
    hazeBlend: 0,
    /** 0..1: the far-field planet tiles draw. */
    farField: 0,
    /** 0..1: the terrain chunks hand the whole ground to the far field. */
    handoff: 0,
    /** The planet radius (m) these values were computed for. */
    planetRadius: DEFAULT_PLANET_RADIUS,
  };
}

/**
 * The render inputs at a camera altitude (m MSL) over a planet of radius planetRadius (m), written
 * into out (a createAtmosphereState() record) and returned. Allocation-free.
 * viewDistance is the camera-to-horizon distance the far plane and the far field must reach (0 below
 * the far-field band, where the sky keeps its Phase 1 far plane), at most MAX_VIEW_DISTANCE.
 */
export function skyState(altitude, out, planetRadius = DEFAULT_PLANET_RADIUS) {
  const height = Number.isFinite(altitude) ? altitude : 0;
  const ratio = densityRatio(height);
  const depth = scaleHeightsAbove(height);
  const neutral = height < ATMOSPHERE_NEUTRAL_BELOW;
  out.altitude = height;
  out.density = SEA_LEVEL_DENSITY * ratio;
  out.densityRatio = ratio;
  out.planetRadius = planetRadius;
  out.skyDarkness = neutral ? 0 : smoothRange(DARKNESS_BAND[0], DARKNESS_BAND[1], depth);
  out.sunSharpness = neutral ? 0 : smoothRange(SHARPNESS_BAND[0], SHARPNESS_BAND[1], depth);
  out.limb = neutral ? 0 : smoothRange(LIMB_BAND[0], LIMB_BAND[1], depth);
  out.starVisibility = neutral ? 0 : smoothRange(STAR_BAND[0], STAR_BAND[1], depth);
  out.hazeBlend = smoothRange(HAZE_START, HAZE_FULL, height);
  out.farField = smoothRange(FAR_FIELD_START, FAR_FIELD_FULL, height);
  out.handoff = smoothRange(HANDOFF_START, HANDOFF_FULL, height);
  out.curvature = smoothRange(CURVATURE_START, CURVATURE_FULL, height);
  // The column haze's density at the camera follows the air: 1 at the ground, rho / rho0 above the
  // haze band (the Phase 1 fog keeps its own density below it).
  out.fogScale = out.hazeBlend > 0 ? 1 + (ratio - 1) * out.hazeBlend : 1;
  const horizon = horizonDistance(height, planetRadius);
  out.horizonDistance = horizon;
  out.horizonDip = neutral ? 0 : horizonDip(height, planetRadius);
  if (out.farField > 0) {
    // The tangent point of the rendered (parabolic) ground lies sqrt(2 R h) out and 2h below the
    // camera; reach a little past it.
    const tangent = Math.sqrt(2 * planetRadius * Math.max(0, height));
    const reach = Math.sqrt(tangent * tangent + 4 * height * height) * VIEW_MARGIN;
    out.viewDistance = Math.min(MAX_VIEW_DISTANCE, Math.max(reach, horizon));
  } else {
    out.viewDistance = 0;
  }
  return out;
}
