DRIFTWING - STRUCTURE CORRECTION (run before Phase 2)

INTENT (source of truth for every phase)
DRIFTWING is TWO separate games behind one toggle.

V1: the original single-prompt game, FROZEN.
- It is index.html from tag v1-final, byte-for-byte.
- Never ported, modified, upgraded, reformatted, or maintained.

V2: the new game.
- Real flight physics only.
- Freely switchable between first person (cockpit) and third person (chase, wing, flyby).
- Contains every Phase 1-4 addition.

There is NO CLASSIC mode inside V2. The CLASSIC|SIM mode built in Phase 1 misread this intent. Remove it.

STEP 0 - SAFETY
- Commit the current state.
- Create branch v2-structure-fix.
- Commit after each step below.

STEP 1 - FREEZE V1
1. Extract the original with: git show v1-final:index.html
2. Place it at public/v1/index.html. Vite serves public/ without processing it.
3. Store its SHA-256 in tests/v1.sha256. Add a test that fails if the file ever changes.
4. V1 keeps its own CDN importmap and its own three.js version. Do not fix, lint, or touch anything in it.
5. If V1 shows console errors in its original form, that is original behavior. Record them in docs/v1-known-issues.md. Do not edit the file.
6. Remove the Phase 1 port of V1 behavior from V2 (ArcadeModel and anything arcade-only). V1 lives only in public/v1/.

STEP 2 - LAUNCHER SHELL (the toggle)
Layout:
- The root page (/) becomes a minimal shell:
  - a full-window iframe
  - a small glass pill in the top-left: [ V1 | V2 ]
- V1 loads /v1/. V2 loads /v2/ (move the Vite app to that base path).

Switching:
- Only one game runs at a time.
- Sequence: fade out, set the old iframe to about:blank (frees GPU, audio, gamepads), load the other game, fade in.
- Focus the iframe after every switch so keyboard and mouse go to the game.

Persistence:
- Remember the last version in the shell's own localStorage key driftwing.shell.lastVersion.
- Open that version next launch. First launch defaults to V2.

Iframe permissions, allow list:
- gamepad
- microphone
- camera
- fullscreen
- autoplay
- xr-spatial-tracking
- encrypted-media
- clipboard-write

Pill behavior:
- Small, auto-hides after inactivity, reappears when the mouse nears the top-left.
- Check V1's HUD layout; if the pill overlaps anything, nudge it clear.

Switching from inside the games:
- V2 can request a switch via postMessage to the shell (validate origin). Make it a bindable action, versionToggle, available on keyboard and HOTAS.
- V1 switches only by clicking the pill, because V1 is untouched.

URLs:
- /?v=1 and /?v=2 open a specific game.
- The shell forwards any #hash (seed and room links) to V2.

Storage isolation:
- All V2 storage (IndexedDB names, localStorage keys) is prefixed driftwing-v2.
- V2 never reads or writes V1's keys.

STEP 3 - REMOVE CLASSIC FROM V2
Delete:
- the CLASSIC|SIM toggle and the modeToggle action
- ArcadeModel and arcade profiles
- the double-tap barrel-roll macro and the space-bar boost
- the "HOTAS detected - switch to SIM?" toast
- mode fields in settings, journal, and the copilot schema

Migrate saved settings so the old mode key is dropped cleanly.

Assists and flight model:
- V2 always runs the real flight model.
- The assists slider (0-100%) is the only difficulty control.
- Defaults: 100% for keyboard/mouse. The first time a HOTAS is detected, switch to 50%. After that, the user's own choice always wins.

Copilot:
- Remove "sim mode" and "classic mode".
- Add "switch to version one" (triggers versionToggle).

Everything else from Phase 1 stays.

STEP 4 - FIRST / THIRD PERSON IN V2
Views:
- First person: cockpit.
- Third person: chase, wing, flyby.
- First launch defaults to third-person chase (the golden-hour opening shot).
- Remember the last view per craft.

Controls:
- Key C cycles views.
- New bindable action viewToggle1P3P swaps instantly between cockpit and the last third-person view.
- Stick hat keeps its snaps: up = cockpit, down = chase, left/right = look.

HUD:
- Third person: glass HUD with airspeed, altitude, heading, a mini attitude indicator, throttle, and a stall/AoA warning. Optional instrument overlay.
- First person: cockpit panel instruments, with the glass HUD optional.

Physics:
- Identical in every view. Changing view never changes flight behavior.

Chase cam:
- Lag, bank-follow, and FOV-with-speed, plus a velocity-vector marker so sideslip and angle of attack are readable from outside.

STEP 5 - BUILD, DOCS, TESTS
build:single now outputs dist-single/ with:
- the shell index.html
- v1/index.html, copied untouched
- v2/index.html as a single file

Docs:
- Update docs/architecture.md, docs/controls.md, docs/copilot-api.md, and README for the two-game structure.

Tests:
1. V1 checksum passes.
2. Shell:
   - switch both directions 20 times; only one iframe is ever live
   - GPU/heap memory returns to baseline
   - focus lands in the game
   - hash forwarding works
   - postMessage rejects foreign origins
3. V2: re-run the Phase 1 harness for every craft, in both first and third person.
4. Zero errors and warnings in the shell and V2. V1 is judged only against its original behavior.

Tag v2-structure when done.
