// The craft test's scenario sets (?test=craft, src/dev/craftTest.js; Phase 3 contract k.1), one file
// per craft: src/dev/craftScenarios/<craft>.js default-exports
//
//   { craft, general?, scenarios: [scenario] }
//
//   general     optional tuning of the general flight test every registered craft flies in both
//               views: { start?, stick?, throttle?, seconds? } (craftTest.js, generalSpec)
//   scenario    { id, views: ['first', 'third'], seed?, world?: 'game' | 'waters', time?, assists?,
//                 start: { at?: 'here' | 'spawn' | 'ocean' | 'lake' | 'thermal' | 'slope' | 'perch' | { x, y?, z },
//                          mode?: 'air' | 'ground' | 'water' | 'hover' | 'drift' | 'climb' | 'perch',
//                          heading?, agl?, speed?, pitch?, throttle?, craftState?, flatSpot? },
//                 seconds, script?(t, api) -> controls, checks: [{ id, label?, from?, until?, always?, test(api) }],
//                 allowCrash? }
//
// A craft's scenarios run only while its module is registered, so a set can land with its craft. A
// new craft adds its file and one import line plus one list line below, in catalog order.
import glider from './glider.js';
import bushplane from './bushplane.js';
import jet from './jet.js';
import helicopter from './helicopter.js';
import wingsuit from './wingsuit.js';
import fpv from './fpv.js';

export const CRAFT_SCENARIO_SETS = Object.freeze([
  glider,
  bushplane,
  jet,
  helicopter,
  wingsuit,
  fpv,
]);
