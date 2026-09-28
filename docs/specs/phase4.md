DRIFTWING v2 - PHASE 4 of 4: MUSIC, FLIGHT RECORDER + CLIPS, HEAD TRACKING, VR, MULTIPLAYER

LEAD'S NOTE (added on top of the owner's text): the owner's STRUCTURE CORRECTION (SPEC-structure-fix.md) is the source of truth for every phase.
- V2 has no CLASSIC mode. Where this spec says "mode" in recorded or restored state (for example "craft and mode", or the VR state snapshot), record the camera view (first or third person) instead.
- Branch v2-phase4 is cut from tag v2-phase3.
- "Merge to main and tag v2.0" changes what GitHub Pages serves: Pages builds from main at /, which today is the v1 page. The owner decides the Pages deploy (for example a GitHub Actions deploy of dist-single) before the merge.

CONTEXT
Phases 1-3 are complete (tags v2-phase1, v2-phase2, v2-phase3).
Read these first: docs/architecture.md, docs/controls.md, docs/copilot-api.md, docs/spawns.md.
This phase adds platform features only. No new craft or spawns.

RESUME PROTOCOL
- Keep docs/phase4-progress.md updated at every commit: done, next, open issues.
- At the start of any session, read it first if it exists, and continue from where it says.

GROUND RULES (unchanged, plus these)
- Follow the webgpu-build-standards skill.
- Keep Vite.
- 0 errors, 0 warnings.
- No placeholders.
- Branch v2-phase4 from v2-phase3. Commit after every milestone.
- Every feature that needs an account, hardware, or a permission is optional and OFF by default: Spotify, webcam, VR, multiplayer. With all of them off, the game must behave exactly like Phase 3.
- Anything the user must do outside the game (Spotify dashboard, Docker, Tailscale) gets a walkthrough:
  - plain language
  - numbered
  - one action per step
  - starting from where to click
- No secrets in code. PKCE only.
- Facts about Spotify, WebXR, and browser APIs changed repeatedly in 2025-2026. Verify each against current official docs before coding. If anything below conflicts with the docs, follow the docs and note the difference in the progress file.

MILESTONE A - MUSIC FOUNDATION + LOCAL FILES MODE
MusicSource interface:
- connect, play, pause, next, prev, setVolume, getNowPlaying, onTrackChange
- Two implementations: LocalFilesSource and SpotifySource.

Local files:
- Pick a music folder with the File System Access API.
- Persist the folder handle in IndexedDB so the library survives restarts.
- On reload, if Chrome asks for permission again, show a one-click re-grant with a one-line reason.
- Scan mp3, m4a, flac, ogg, wav.
- Read tags (title, artist, album art).
- Shuffle, repeat, short crossfades.
- Local audio routes through the Phase 1 music bus (Web Audio), so it can be analyzed, ducked, and included in clips.

Beat-reactive visuals (local files only):
- Detection: AnalyserNode feeding spectral-flux onset detection, a BPM estimate, band energies (sub, low, mid, high), and drop detection (energy surge after a build).
- Tasteful targets:
  - aurora brightness and flow
  - lantern and firefly glow
  - crystal spire hum
  - a subtle bloom lift
  - cloud-lightning flicker during storms
- Visualizer intensity setting: Off / Subtle / Full. Default Subtle.
- Never touches physics.

Mood routing (works with both sources, OFF by default):
- The user assigns a playlist or folder to each mood: golden hour, day, night, storm, space (above 20 km), challenge.
- Switching happens at track end with a crossfade.
- Optional setting: switch immediately.

Media Session API:
- Keyboard media keys and the OS media overlay show now-playing and control whichever source is active.

MILESTONE B - SPOTIFY
Facts to design around (verify first):
- Web Playback SDK:
  - Makes DRIFTWING a Spotify Connect device that plays audio in-page.
  - Requires Spotify Premium.
- Development Mode:
  - The app owner must have Premium.
  - Max 5 allowlisted users (dashboard > User Management).
  - Extended quota is out of scope.
- Redirect URIs:
  - Use http://127.0.0.1:5199/callback. localhost is rejected.
  - Also add the hosted multiplayer HTTPS origin's /callback (Milestone G).
- Auth:
  - Authorization Code with PKCE. No client secret anywhere.
  - Refresh tokens expire 6 months after consent.
- February 2026 endpoint changes:
  - Playlist contents come from GET /playlists/{id}/items, and only for the user's OWN playlists. Other playlists return metadata only.
  - Search returns at most 10 results.
  - Library writes go through /me/library.
  - Audio features and audio analysis are unavailable.
- HTTP 429 responses:
  - reason QUOTA_EXCEEDED = dev-mode quota, shared per developer account.
  - Otherwise = normal rate limiting with Retry-After.
  - Handle both.

Setup wizard (Settings > Music > Spotify, in-game, numbered):
1. Open developer.spotify.com/dashboard.
2. Create an app.
3. Paste the redirect URI(s) exactly (provide copy buttons).
4. Enable Web API and Web Playback SDK.
5. Copy the Client ID.
6. Paste it into DRIFTWING.
7. Click Connect.
- The Client ID is stored in settings (it is public under PKCE).

Scopes:
- Request exactly what the current Web Playback SDK and the endpoints used below require. Nothing extra.

Tokens:
- Store in IndexedDB.
- Auto-refresh before expiry.
- Settings shows "Connected - re-login needed by about [date]".
- When a refresh fails, show a clear one-click Reconnect toast. Never fail silently.

Player:
- Create an SDK device named "DRIFTWING".
- On connect, offer two choices:
  - "Play in DRIFTWING" (transfer playback into the page)
  - "Remote-control my Spotify app" (Connect remote, no in-page audio)
- Handle browser autoplay rules (activate the SDK element on a user gesture).
- Prefer SDK player_state_changed events over REST polling to save quota.

UI:
- Glass now-playing card: art, title, artist, progress, controls. Follows the UI auto-hide.
- Library panel:
  - my playlists (GET /me/playlists)
  - liked songs (GET /me/tracks)
  - recently played
  - search (10 results)

Controls:
- Throttle hat left/right = previous/next. Up/down = volume. (This is the Phase 1 reservation.)
- Media keys via Media Session.

Ducking:
- Spotify audio is DRM-protected and never enters the Web Audio graph.
- Duck it under copilot speech with smoothed SDK setVolume ramps, then restore.

Copilot grammar (each with a keyboard/UI equivalent):
- "play [my playlist name]"
- "play liked songs"
- "play [artist or track]" (via search)
- "skip", "previous", "pause", "resume"
- "volume up", "volume down"
- "what's playing"

Terms and privacy:
- Do NOT send Spotify metadata to RemoteCopilot by default. Spotify's developer terms restrict feeding Spotify content into AI models.
- Allow it only through a clearly labeled opt-in setting.
- The local keyword copilot may read titles aloud.

Graceful fallback:
- For users without Premium or not allowlisted, the Spotify panel says so plainly and points to Local Files mode.
- Nothing else breaks.

MILESTONE C - FLIGHT RECORDER, REPLAY, GHOSTS
Recorder:
- Always-on ring buffer at 30 Hz. Default length 10 minutes, configurable up to 60.
- Records per sample:
  - position (float64)
  - orientation (quantized quaternion)
  - velocity
  - ControlState
  - craft and mode
  - camera view
  - craft states: gear, flaps, nacelle, smoke color, chute, perched
- Also records an event log:
  - director activations with full params
  - spawn ends
  - time of day and weather states
  - discoveries
  - soft crashes
  - challenge gates
  - portal seed changes
- Memory is bounded and compressed.

Replay reconstruction:
- World rebuilds from the seed.
- Spawns come from the logged activations. Never re-run the director.
- Time of day comes from the log.

Saving:
- Save flight (UI button and bindable action saveFlight): the buffer or the whole session, stored in IndexedDB.
- Journal "Flights" tab shows: thumbnail, date, duration, craft, seed, discoveries.
- Export and import .driftwing files (gzip via CompressionStream).

Replay viewer:
- Timeline with event markers, scrub, 0.25x to 4x speed, pause.
- Photo mode works inside replays.
- Cameras:
  - Auto Director: cuts between flyby, tower, chase, orbit, low ground cam, drone follow, and cockpit. Cuts on events. Never occluded by terrain.
  - Manual free cam.

Instant replay (setting):
- After a soft crash, play a 6-second flyby replay before the respawn.

Ghosts:
- New challenge best runs record at 30 Hz. Upsample Phase 3's 10 Hz bests with a spline.
- Race your ghost: translucent craft plus trail, live split deltas.
- Import a friend's .driftwing file to race their ghost on the same seed.

MILESTONE D - CLIP EXPORT
"Clip last 30s" (bindable action clipLast30):
- Grabs that window from the recorder and opens the export dialog.
- The flight keeps going.

Path 1 - Cinematic (default):
- Offline, frame-exact render of the replay at a fixed timestep.
- Options: 1080p / 1440p / 4K, 30 or 60 fps, Auto Director or a chosen camera.
- Video: WebCodecs VideoEncoder, H.264 with VP9 fallback, muxed to MP4 with a maintained muxer library (verify the current package).
- Audio: render the procedural game audio offline in an OfflineAudioContext, driven by the recorded state timeline. If that can't be made clean, fall back to a real-time 1x audio capture pass and mux it in.
- Progress bar and cancel. Runs while the game is paused.

Path 2 - Live capture:
- canvas.captureStream plus MediaRecorder. MP4 if supported, otherwise WebM.
- Audio from a MediaStreamDestination on the master bus.

Audio rules:
- Clips include game audio and Local Files music.
- Spotify audio is never included (DRM, and not ours to redistribute). The export dialog says so in one line.

Output:
- Download, plus a saved clip list in the journal.

MILESTONE E - WEBCAM HEAD TRACKING (TrackIR-style)
Settings > Head tracking (OFF by default):
- enable
- preview window
- per-axis sensitivity curves
- deadzone
- One Euro smoothing
- invert options
- recenter (bindable action recenterHead, plus a keyboard key)

Tracking:
- MediaPipe Face Landmarker (tasks-vision, GPU delegate) at about 30 fps.
- Off the main thread where possible.
- Derive head yaw, pitch, and roll plus small translation.

Mapping:
- Amplified look in cockpit view. Default: about 15 deg of head yaw = 90 deg of view.
- Lean in/out = small zoom.
- Limited 6DoF peek.
- Mini-stick free look overrides head tracking while deflected.

Privacy:
- Frames never leave the device and are never recorded.
- Camera-active indicator in the UI.
- Auto-disabled in VR.

MILESTONE F - VR (WebXR)
Hard fact: three.js XR currently works ONLY on WebGPURenderer's WebGL2 backend.

Entry and exit flow:
1. A glass "VR" button (plus a keyboard key) snapshots full state to sessionStorage: seed, craft, mode, position, velocity, attitude, time of day, active spawn log, music state.
2. The page reloads with ?xr=1, booting with forceWebGL: true.
3. State restores.
4. A big "Enter VR" button appears. XR needs a real user gesture: click or keyboard.
5. Exiting VR does the same handoff back to the WebGPU backend.
- The handoff must feel like a quick fade, not a restart.

Target platform:
- Chrome or Edge on Windows 11 with any OpenXR runtime: SteamVR, Meta Horizon Link, or Virtual Desktop VDXR.
- Detect navigator.xr. If it's missing, explain in plain language what to install or enable.

Seated cockpit experience:
- Cockpit is the default view.
- World scale: 1 unit = 1 m.
- Recenter: bindable action recenterVR.
- AudioListener follows the headset.
- HOTAS stays the primary input. Verify the Gamepad API keeps polling during the XR session.

Comfort settings (sensible defaults):
- No camera shake in VR. Convey buffet through audio and subtle panel vibration.
- Optional tunnel vignette during fast rotation.
- Optional horizon-lock.
- G-effects limited to vignette.
- "Comfort chase" view: tethered and horizon-stable.
- View changes use fades.

VR UI:
- Cockpit instruments already exist as CanvasTextures.
- Glass UI becomes world-space panels: copilot subtitles and toasts.
- A kneeboard on the virtual lap with tabs for map, journal, music, and controls. Toggle via HOTAS (action kneeboardToggle).
- Use XR quad or cylinder layers for crisp text if available, textured planes otherwise.
- Optional XR controller laser pointer for panels.

Performance:
- Hit the headset refresh rate (72 / 90 / 120).
- Auto-tune framebufferScaleFactor. Enable foveation.
- Lower director budgets in VR: max 1 heavy spawn, cheaper particles.
- Post stack: test it in XR. If too costly or broken, use a light path: tonemapping plus fog, cheap or no bloom.
- Multiview: test it. If you see right-eye projection errors or flicker, disable it.

Spectator view:
- If a smoothed desktop chase view is feasible without dropping below headset refresh, add it.
- Otherwise document why not.

Automated testing:
- ?test=vr uses a WebXR emulation runtime (e.g. Meta's IWER) to verify:
  - session start
  - state handoff both ways
  - frame loop
  - panels
  - mocked HOTAS input during the XR session

MILESTONE G - MULTIPLAYER WINGMAN (2-6 players)
Architecture decision: WebSocket relay server, NOT WebRTC peer-to-peer.
- It works through every home router with no TURN server.
- It's trivial to host.
- Bandwidth is tiny.

server/ (Node, in this repo):
- Rooms:
  - 6-character code, max 6 players.
  - Room creator is host. Migrate host if they leave.
- Authority:
  - The shared world clock (time of day + director time buckets).
  - The room seed.
- Relay:
  - Player state at 20 Hz, plus event messages.
  - Validate message schema and size, rate-limit, drop garbage.
  - No accounts, no persistence.
- Serves the build:single client on the same origin, so friends open one link.
- Includes a Dockerfile, a docker-compose.yml (restart: unless-stopped), and a healthcheck.

Client:
- World sync:
  - The host's director is authoritative for EVENTS. Activations are broadcast with full params, so everyone sees the same tornado.
  - Sites are already deterministic.
- Remote players:
  - 100 ms interpolation buffer plus short extrapolation.
  - Correct craft model and live states (smoke, lights, rotors, chute).
  - Name tag with distance, subtle trails.
  - Players pass through each other: no collisions, no fail state. Close passes play a whoosh.
- Features:
  - Optional formation slot marker off a friend's wing.
  - Shared challenges: race mode with countdown, synchronized start, results board.
- Copilot:
  - "where are my wingmen"
  - "take me to [name]"
  - Discovery callouts, e.g. "[name] found a waterspout 4 km east".
- Join flow:
  - Glass Multiplayer panel (action multiplayerPanel) with Create room (shows code and link) and Join (enter code).
  - #room=CODE in the URL auto-joins.
- Portals: only the host can change the seed; everyone follows with a fade.

README section "Fly with friends" (plain language, numbered, one action per step):
1. Run it locally to test (npm run server).
2. Run it on the TrueNAS server with Docker Compose.
3. Expose it publicly over HTTPS with Tailscale Funnel, set up so it survives reboots, and share the https link.
Notes to include:
- Friends need Chrome or Edge with WebGPU. A HOTAS is optional for them.
- The hosted site is a different origin from 127.0.0.1, so settings and bindings don't carry over. Use Controls > Export/Import.
- Add the hosted /callback to the Spotify app.
- Allowlist friends in Spotify User Management. Spotify requires Premium and has a 5-user cap.

MILESTONE H - CONTROLS, COPILOT, DOCS
New bindable actions:
- musicPrev, musicNext, musicVolUp, musicVolDown (default: throttle hat)
- musicPlayPause
- saveFlight
- clipLast30
- recenterHead
- recenterVR
- kneeboardToggle
- multiplayerPanel

RemoteCopilot flightState additions:
- music: { source, playing }. No Spotify metadata unless the user opted in.
- multiplayer: { room, players[] with name, craft, distance, bearing }
- replay state

Docs to update:
- docs/controls.md
- docs/copilot-api.md
- docs/architecture.md
- README: music setup, VR setup, multiplayer hosting

MILESTONE I - VERIFICATION
1. Verify loop on the dev server, build:single, and the server-hosted build:
   - 0 errors, 0 warnings
   - screenshots differ
   - golden-hour opening unchanged with all Phase 4 features off
2. ?test=music:
   - Use generated test tones only. No copyrighted audio.
   - BPM detection within tolerance on a synthetic 128 BPM track.
   - Ducking works.
   - Mood switching works.
   - Spotify: mocked SDK and mocked Web API must verify UI and recovery for:
     - 429 QUOTA_EXCEEDED
     - 401 followed by a refresh
     - refresh failure
   - Never call real Spotify in automated tests.
3. ?test=replay:
   - Record 3 minutes of scripted flight with forced spawns, then replay.
   - Craft path must match within 0.1 m.
   - Spawn activations must match the log exactly.
   - Then save, export, import, and replay again.
4. ?test=clip:
   - A cinematic 10-second 1080p60 export produces a playable MP4 with audio.
   - Live capture produces a file.
   - Memory returns to baseline.
5. ?test=headtrack:
   - A synthetic landmark stream verifies mapping, smoothing, and recenter.
6. ?test=vr: as described in Milestone F.
7. ?test=mp: start the server plus 3 headless clients and verify:
   - room create and join
   - clock sync
   - host event broadcast (every client sees the same tornado)
   - smooth interpolation
   - host migration
   - portal seed change
   - malformed messages are rejected
8. 20-minute soak with the recorder on, local music playing, and multiplayer with 2 bot clients. Phase 3 pass criteria apply.
9. Final report, then a short manual checklist for Kyle:
   - connect Spotify
   - control music from the HOTAS hat
   - save a flight, replay it, and export a cinematic clip
   - try head tracking
   - enter VR and fly in the headset
   - host a room and have one friend join

DELIVERABLES
- Branch v2-phase4, commit per milestone, tag v2-phase4.
- Merge to main and tag v2.0.
- server/ with Docker files.
- All docs updated.
- docs/phase4-progress.md marked complete.
- CHANGELOG.md with a v2.0 summary.
