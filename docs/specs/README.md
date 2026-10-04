# Owner specs

These are the owner's specifications for DRIFTWING v2, kept verbatim so that any session can resume from the repository alone.

| File | What it is |
| --- | --- |
| [phase1.md](phase1.md) | Phase 1: sim core, HOTAS, wave-1 craft, cockpit, audio (tag `v2-phase1`) |
| [structure-correction.md](structure-correction.md) | The structure correction: V1 frozen, launcher shell, no CLASSIC in V2 (tag `v2-structure`) |
| [phase2.md](phase2.md) | Phase 2: event director, spawn engines, the first 30 spawns |
| [phase2-contract.md](phase2-contract.md) | The lead's system contracts for Phase 2 (preset schema, placement and stamps, engines, director) |
| [phase2-engine-api.md](phase2-engine-api.md) | The lead's engine API notes after the wave 1 integration (registration, the engine ctx, budgets), written for the engine wave |
| [phase3.md](phase3.md) | Phase 3: 8 new craft, 70 more spawns |
| [phase3-contract.md](phase3-contract.md) | The lead's system contracts for Phase 3 (floating origin, colliders, water and region overlays, fauna modes and paths, challenges, high-altitude rendering, the craft module contract, director, journal and copilot additions, test hooks), written for the parallel waves |
| [phase4.md](phase4.md) | Phase 4: music, flight recorder and clips, head tracking, VR, multiplayer |

The structure correction is the source of truth for every phase. The Phase 2-4 specs were written before it and still mention CLASSIC mode. Each of those files opens with a lead's note that explains how its wording maps onto the corrected structure:
- V2 has real physics only, with assists as the difficulty control.
- "Both modes" means the first person and third person views.
- Each phase branches from the previous phase's tag.

Progress for the phase in flight is kept in `docs/phase<N>-progress.md`.
