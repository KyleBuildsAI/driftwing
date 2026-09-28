# Phase 2 progress

Spec: [docs/specs/phase2.md](specs/phase2.md). Contracts: [docs/specs/phase2-contract.md](specs/phase2-contract.md).
Branch: `v2-phase2`, cut from tag `v2-structure`. Read this file first when resuming.

## Plan

| Wave | Work | Branches | Status |
| --- | --- | --- | --- |
| 1 | Milestone A placement and terrain stamps, Milestone B engine framework and F9 debugger, Milestone C director and regional weather, Milestone D spawn audio | `p2/placement`, `p2/framework`, `p2/director`, `p2/audio` | in progress |
| 2 | The ten engines: vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece | `p2/engines-*` | next |
| 3 | Milestone E presets 1-10, 11-20, 21-30 (verified and committed per batch) | `p2/presets-*` | planned |
| 4 | Milestone F discovery loop: journal, copilot tour guide, world map, seed links | `p2/discovery`, `p2/copilot` | planned |
| 5 | Milestone G verification: ?test=spawns, ?test=determinism, ?test=terrain, 10-minute soak; docs/spawns.md with the preset template, architecture, controls, copilot API, CHANGELOG; review and fixes; tag `v2-phase2` | `p2/verify` | planned |

## Decisions

- **No CLASSIC mode (the structure correction wins).** Spawns apply their full WindField forces in V2; the assists are the safety net. "Both modes" in the soak test means the first person and third person views.
- **Map key.** M opens the world map (mapToggle). The mic toggle moves to Shift+M.
- **Machine load.** Tests run immediately, whatever the machine's load. The hard criteria must pass. Frame spikes are reported with the harness's load evidence, never hidden.

## Done

- Branch `v2-phase2` created from `v2-structure`; the owner specs and the Phase 2 contracts are in docs/specs/.

## Next

- Merge wave 1 and verify, then start wave 2 (engines).

## Open issues

- None yet.
