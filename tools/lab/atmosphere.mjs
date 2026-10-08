// Atmosphere lab: src/env/atmosphere.js and the CPU half of src/render/curvature.js, headless (node).
// Every number the sky, the fog, the curvature and the far field read is checked against its formula
// (contract g.7).
//
// Tests:
//   density      densityRatio is exp(-h / 8500) (the physics' own model: airDensity / 1.225), 1e-4 near
//                78 km, and the record's density and ratio agree
//   neutral      below 3 km every render input is exactly neutral (darkness, stars, limb, sharpness,
//                curvature, haze, far field, handoff 0; fog scale 1; no view distance; no dip), so the
//                golden-hour opening cannot change
//   inputs       darkness, sun sharpness, limb and stars equal their smoothstep of the optical depth at
//                sampled altitudes, rise monotonically, and reach the spec's marks: stars visible at 35 km
//                (above 0.85) and from about 30 km, a black sky by 35 km, half dark near 20 km, the limb
//                present at 15 km
//   bands        curvature 0 at 5 km and 1 at 8 km, the far field from 6 km, the haze band 6-9 km, the
//                terrain handoff 11-13 km
//   horizon      horizon distance sqrt(2 R h + h^2) (458 km from 100 km over 1000 km, 357 km from
//                10 km over 6371 km), the dip atan(sqrt(2 h / R)) within 1 degree of acos(R / (R + h)),
//                the view distance past the rendered tangent point and never beyond 600 km
//   curvature    curvatureDrop is (dx^2 + dz^2) / 2R; the rigid drop is 0 at curvatureAmount 0 and
//                scales with it; applyRigidDrop keeps its base, updates frozen matrices only on a
//                change; the planetRadiusKm setting clamps to 200..6371 km
//   allocation   skyState and rigidCurvatureDrop allocate nothing per call over 100 000 calls (the
//                sampling heap profiler, garbage the collector took included; under 1 KB in all, the
//                optimising compiler's one-off work)
//
// Usage: node tools/lab/atmosphere.mjs [--verbose]
// Prints one line per failed check (every check with --verbose) and exits non-zero if any fails.
import { Session } from 'node:inspector/promises';
import {
  airDensity, SEA_LEVEL_DENSITY, densityRatio, scaleHeightsAbove, horizonDistance, horizonDip, skyState,
  createAtmosphereState, MAX_VIEW_DISTANCE,
} from '../../src/env/atmosphere.js';
import {
  DEFAULT_PLANET_RADIUS, PLANET_RADIUS_KM, applyRigidDrop, curvatureDrop, planetRadiusFromSetting, rigidCurvatureDrop,
} from '../../src/render/curvature.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const SCALE_HEIGHT = 8500;
const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}
function near(value, expected, tolerance) {
  return Math.abs(value - expected) <= tolerance;
}
function smooth(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

function testDensity() {
  let worst = 0;
  for (let altitude = 0; altitude <= 150000; altitude += 2500) {
    worst = Math.max(worst, Math.abs(densityRatio(altitude) - Math.exp(-altitude / SCALE_HEIGHT)));
    worst = Math.max(worst, Math.abs(airDensity(altitude) / SEA_LEVEL_DENSITY - densityRatio(altitude)));
  }
  check('density', 'densityRatio = exp(-h / 8500) = airDensity / 1.225 from 0 to 150 km', worst < 1e-15, `worst ${worst}`);
  check('density', 'rho / rho0 is 1e-4 near 78 km', near(densityRatio(78000), 1e-4, 2e-5), `${densityRatio(78000).toExponential(3)} at 78 km`);
  const record = skyState(42000, createAtmosphereState());
  check('density', 'the record holds rho and rho / rho0 of its altitude', near(record.density, airDensity(42000), 1e-15) && near(record.densityRatio, densityRatio(42000), 1e-15), `rho ${record.density.toExponential(3)}`);
  check('density', 'optical depth in scale heights is h / 8500', near(scaleHeightsAbove(17000), 2, 1e-12) && scaleHeightsAbove(-200) === 0, `${scaleHeightsAbove(17000)}`);
}

function testNeutral() {
  const record = createAtmosphereState();
  let dirty = '';
  for (const altitude of [-200, 0, 150, 500, 1200, 2000, 2999]) {
    skyState(altitude, record);
    const values = [record.skyDarkness, record.starVisibility, record.limb, record.sunSharpness, record.curvature, record.hazeBlend, record.farField, record.handoff, record.viewDistance, record.horizonDip];
    if (values.some((value) => value !== 0) || record.fogScale !== 1) dirty += ` ${altitude} m: ${values.join(',')} fog ${record.fogScale};`;
  }
  check('neutral', 'below 3 km every render input is exactly neutral', dirty === '', dirty || 'all exactly 0, fog scale exactly 1');
}

function testInputs() {
  const record = createAtmosphereState();
  const bands = { skyDarkness: [0.45, 4.2], sunSharpness: [0.5, 4.0], limb: [0.9, 3.3], starVisibility: [2.9, 4.4] };
  let worst = 0;
  let monotonic = true;
  const previous = { skyDarkness: 0, sunSharpness: 0, limb: 0, starVisibility: 0 };
  for (let altitude = 3000; altitude <= 120000; altitude += 500) {
    skyState(altitude, record);
    for (const [field, [low, high]] of Object.entries(bands)) {
      worst = Math.max(worst, Math.abs(record[field] - smooth(low, high, altitude / SCALE_HEIGHT)));
      if (record[field] < previous[field]) monotonic = false;
      previous[field] = record[field];
    }
  }
  check('inputs', 'darkness, sharpness, limb and stars are their smoothstep of the optical depth', worst < 1e-12, `worst ${worst}`);
  check('inputs', 'every input rises monotonically with altitude', monotonic);
  const at = (altitude) => ({ ...skyState(altitude, createAtmosphereState()) });
  const at20 = at(20000);
  const at30 = at(30000);
  const at35 = at(35000);
  const at15 = at(15000);
  check('inputs', 'stars are visible by day at 35 km', at35.starVisibility > 0.85, `${round(at35.starVisibility, 3)}`);
  check('inputs', 'stars come in from about 30 km', at30.starVisibility > 0.25 && at(25000).starVisibility < 0.02, `25 km ${round(at(25000).starVisibility, 3)}, 30 km ${round(at30.starVisibility, 3)}`);
  check('inputs', 'the sky is black by 35 km and about half dark at 20 km', at35.skyDarkness > 0.98 && near(at20.skyDarkness, 0.5, 0.06), `20 km ${round(at20.skyDarkness, 3)}, 35 km ${round(at35.skyDarkness, 3)}`);
  check('inputs', 'the limb glows at 15 km and is full by 30 km', at15.limb > 0.2 && at30.limb === 1, `15 km ${round(at15.limb, 3)}, 30 km ${round(at30.limb, 3)}`);
  check('inputs', 'the sun disc is sharp by 35 km', at35.sunSharpness === 1, `${at35.sunSharpness}`);
  check('inputs', 'the fog density follows rho / rho0 above the haze band', near(at35.fogScale, densityRatio(35000), 1e-15) && at(7500).fogScale > densityRatio(7500), `35 km ${at35.fogScale.toExponential(3)}`);
}

function testBands() {
  const record = createAtmosphereState();
  const value = (altitude, field) => skyState(altitude, record)[field];
  check('bands', 'curvature is 0 at 5 km, 0.5 at 6.5 km and 1 at 8 km', value(5000, 'curvature') === 0 && near(value(6500, 'curvature'), 0.5, 1e-12) && value(8000, 'curvature') === 1);
  check('bands', 'the far field draws from 6 km (full at 6.5 km)', value(5999, 'farField') === 0 && value(6500, 'farField') === 1 && value(6250, 'farField') > 0);
  check('bands', 'the haze hands over from 6 to 9 km', value(6000, 'hazeBlend') === 0 && near(value(7500, 'hazeBlend'), 0.5, 1e-12) && value(9000, 'hazeBlend') === 1);
  check('bands', 'the terrain hands the ground to the far field from 11 to 13 km', value(11000, 'handoff') === 0 && near(value(12000, 'handoff'), 0.5, 1e-12) && value(13000, 'handoff') === 1);
}

function testHorizon() {
  const fromSpace = horizonDistance(100000, 1_000_000);
  const earth = horizonDistance(10000, 6_371_000);
  check('horizon', 'sqrt(2 R h + h^2): 458.3 km from 100 km over 1000 km', near(fromSpace, Math.sqrt(2 * 1e6 * 1e5 + 1e10), 1e-6) && near(fromSpace, 458258, 1), `${Math.round(fromSpace)} m`);
  check('horizon', 'sqrt(2 R h + h^2): 357.1 km from 10 km over 6371 km', near(earth, 357099, 1), `${Math.round(earth)} m`);
  let worstDip = 0;
  for (const altitude of [5000, 12000, 35000, 100000, 120000]) {
    const dip = horizonDip(altitude, DEFAULT_PLANET_RADIUS);
    const exact = Math.acos(DEFAULT_PLANET_RADIUS / (DEFAULT_PLANET_RADIUS + altitude));
    worstDip = Math.max(worstDip, Math.abs(dip - exact));
    if (!near(dip, Math.atan(Math.sqrt((2 * altitude) / DEFAULT_PLANET_RADIUS)), 1e-15)) worstDip = Infinity;
  }
  check('horizon', 'the dip is atan(sqrt(2h / R)), within 1 degree of acos(R / (R + h)) up to 120 km', worstDip < Math.PI / 180, `worst ${round(worstDip * 180 / Math.PI, 3)} deg`);
  const record = createAtmosphereState();
  let viewOk = true;
  let detail = '';
  for (const [altitude, radius] of [[8000, 1e6], [15000, 1e6], [35000, 1e6], [100000, 1e6], [120000, 1e6], [120000, 6.371e6], [35000, 2e5]]) {
    skyState(altitude, record, radius);
    const tangent = Math.sqrt(2 * radius * altitude);
    const reach = Math.sqrt(tangent * tangent + 4 * altitude * altitude);
    const ok = record.viewDistance <= MAX_VIEW_DISTANCE && (record.viewDistance >= reach || record.viewDistance === MAX_VIEW_DISTANCE) && record.horizonDistance === horizonDistance(altitude, radius);
    if (!ok) viewOk = false;
    detail += ` ${altitude / 1000} km/R ${radius / 1000} km: ${Math.round(record.viewDistance / 1000)} km;`;
  }
  check('horizon', 'the view distance reaches past the rendered tangent point, at most 600 km', viewOk, detail.trim());
}

function testCurvature() {
  check('curvature', 'curvatureDrop = (dx^2 + dz^2) / 2R: 50 m at 10 km over 1000 km', curvatureDrop(6000, 8000, 1e6) === 50 && curvatureDrop(0, 0, 1e6) === 0);
  const camera = { position: { x: 1000, y: 30000, z: -2000 } };
  const uniforms = { curvatureAmount: { value: 0 }, planetRadius: { value: 1e6 } };
  const fakeCtx = { camera, uniforms };
  const flat = rigidCurvatureDrop(fakeCtx, 21000, -2000);
  uniforms.curvatureAmount.value = 0.5;
  const half = rigidCurvatureDrop(fakeCtx, 21000, -2000);
  check('curvature', 'the rigid drop is 0 while curvatureAmount is 0 and scales with it', flat === 0 && near(half, 100, 1e-9), `0 -> ${flat}, 0.5 -> ${half}`);
  let matrixUpdates = 0;
  const object = { position: { x: 21000, y: 640, z: -2000 }, userData: {}, matrixAutoUpdate: false, updateMatrix() { matrixUpdates++; } };
  applyRigidDrop(fakeCtx, object);
  const lowered = object.position.y;
  applyRigidDrop(fakeCtx, object);
  uniforms.curvatureAmount.value = 0;
  applyRigidDrop(fakeCtx, object);
  check('curvature', 'applyRigidDrop lowers from the kept base and restores it exactly', near(lowered, 540, 1e-9) && object.position.y === 640 && object.userData.curvatureBaseY === 640, `${lowered} then ${object.position.y}`);
  check('curvature', 'a frozen matrix updates only when the drop changes', matrixUpdates === 2, `${matrixUpdates} updates over 3 calls`);
  uniforms.curvatureAmount.value = 1;
  applyRigidDrop(fakeCtx, object, 700);
  check('curvature', 'an explicit base wins', near(object.position.y, 500, 1e-9), `${object.position.y}`);
  check('curvature', 'planetRadiusKm clamps to 200..6371 km (default 1000 km)', planetRadiusFromSetting(50) === 200000 && planetRadiusFromSetting(9000) === 6371000 && planetRadiusFromSetting(undefined) === 1e6 && PLANET_RADIUS_KM.default * 1000 === DEFAULT_PLANET_RADIUS);
}

async function testAllocation() {
  const record = createAtmosphereState();
  const camera = { position: { x: 0, y: 50000, z: 0 } };
  const fakeCtx = { camera, uniforms: { curvatureAmount: { value: 1 }, planetRadius: { value: 1e6 } } };
  let sink = 0;
  const run = (count) => {
    for (let index = 0; index < count; index++) {
      skyState(2000 + (index % 1500) * 80, record, 1e6 + (index % 7) * 1000);
      sink += record.viewDistance + rigidCurvatureDrop(fakeCtx, index, -index);
    }
  };
  run(200000);
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  run(100000);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  let bytes = 0;
  const sites = [];
  const visit = (node) => {
    const url = node.callFrame.url || '';
    if (url.includes('atmosphere.js') || url.includes('curvature.js')) {
      bytes += node.selfSize;
      if (node.selfSize > 0) sites.push(`${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber + 1}`);
    }
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  // A per-call allocation is at least one heap number (12 bytes), 1.2 MB over the run; a few dozen
  // bytes are V8's one-off tier-up work (a re-optimised function boxes numbers for a moment).
  check('allocation', 'skyState and rigidCurvatureDrop allocate nothing per call over 100 000 calls', bytes < 1000 && Number.isFinite(sink), `${bytes} bytes sampled in the modules${sites.length ? ` at ${sites.join(', ')}` : ''}`);
}

testDensity();
testNeutral();
testInputs();
testBands();
testHorizon();
testCurvature();
await testAllocation();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (!result.pass || VERBOSE) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} atmosphere checks\n`);
process.exitCode = failed === 0 ? 0 : 1;
