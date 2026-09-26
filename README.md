# DRIFTWING

An ambient infinite-flight exploration game in a single `index.html`. You pilot a low-poly glider over an
endless procedural world at golden hour. There is no fail state, no fuel and no enemies. An AI copilot named
WREN rides along: talk to it or type to it, and it can set waypoints, fly the plane, change the time of day
or lay out a ring course.

- **Engine:** three.js r184 with `WebGPURenderer` and an automatic WebGL2 fallback, loaded from a CDN import map.
  There is no build step. (r184 is pinned on purpose; bump it deliberately after checking the three.js migration
  notes, since the WebGPU and TSL APIs change between releases.)
- **World:** chunked heightmap terrain generated in Web Workers from seeded simplex noise. It blends five biomes
  (snow peaks, pine valleys, dune sea, archipelago, flower meadows) and uses ring LOD with skirts and pooled
  meshes. Worlds are fully deterministic from the seed shown in the UI, so a seed can be shared.
- **Atmosphere:** a day and night cycle that lingers at golden hour, a sky dome with sun, moon, stars, aurora
  and god rays, and fog that always matches the sky. Instanced drifting clouds cast shadows. Water has
  animated waves and sun glint, and the terrain draws foam at the shoreline. Boid bird flocks, wingtip
  contrails and wind streaks fill in the rest.
- **Landmarks:** stone arches, monolith circles, lighthouses on lone islands and drifting hot-air balloons, all
  logged to a per-seed discovery journal.

## Running it

**Play online:** <https://kylebuildsai.github.io/driftwing/> (GitHub Pages). Share a world by copying the URL; it
always carries the seed, for example <https://kylebuildsai.github.io/driftwing/?seed=K7Q2ZD>.

To run it locally instead:

The game is one self-contained file: double-click `index.html` to play. It needs an internet connection the
first time to fetch three.js from the jsDelivr CDN. Browsers with WebGPU use it; the rest fall back to WebGL2
automatically. It was tested in Chrome on Windows on both backends and from `file://`.

For microphone input the Web Speech API needs a secure origin: the online version (HTTPS) works, and locally you
can serve it over `http://localhost`:

```bash
npm run serve
```

Then open <http://localhost:8080/>. The server has no dependencies; `node tools/serve.mjs 8080` works without
`npm install`.

### URL parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `seed` | `?seed=K7Q2ZD` | Fly a specific world (letters, digits and dashes). The URL always carries the current seed, so you can share it. |
| `time` | `?time=0.02` | Start at a day time from 0 to 1 (0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset). |
| `renderer` | `?renderer=webgl` | Force the WebGL2 fallback. |
| `debug` | `?debug=1` | Show the FPS / backend / draw-call badge. |
| `touch` | `?touch=1` | Force the on-screen touch controls. |

## Controls

| Action | Keyboard / mouse | Touch |
| --- | --- | --- |
| Pitch and bank | Mouse (click the view to capture it, `Esc` releases), or drag with the left button; arrow keys; `A` / `D` bank. Banking turns the glider; let go and the wings level. | Left joystick |
| Throttle | `W` / `S`, mouse wheel | Right slider |
| Boost (on cooldown) | `Space` | Boost button |
| Barrel roll | Double-tap `A` or `D` | Roll buttons |
| Rudder / fine control | `Q` / `E`, hold `Shift` | |
| Ask WREN (command bar) | `C`, `Enter` or `/` | Chat button |
| Microphone | `M` or the mic button | Mic button |
| Photo mode | `P` (then `WASD` / `Q` `E` to move, mouse to look, wheel to zoom, `K` to capture) | |
| Journal / Help | `J` / `H` | Menu |
| Cycle time of day | `T` | |
| Ring course (start / cancel) | `R` | |
| Waypoint ahead / clear | `G` / `X` | |
| Autopilot toggle | `O` | |
| Copilot voice on/off | `V` | |
| FPS badge / hide HUD | `I` / `Tab` | |

The HUD fades out after three seconds without input and comes back on any input.

Settings (gear icon) cover the day length (2 to 30 minutes, or frozen), quality (auto, or a fixed preset from
minimal to ultra), mouse sensitivity, inverted pitch, WREN's voice and chatter, the remote copilot, volume, an FPS
badge and HUD auto-hide. On auto quality the game lowers view distance and resolution before frames start to drop,
and raises them again when there is headroom.

## WREN, the copilot

WREN's default brain is a local keyword grammar. It needs no network access. Speak with the mic button (Web
Speech API; Chrome and Edge) or type into the command bar. Every command is also available from the quick
chips, so voice is never required. Things to try:

- "Where am I?", "How high are we?", "What time is it?"
- "Find mountains", "Find the ocean", "Find the desert", "Find a landmark", "Take us there"
- "Set a waypoint", "Clear the waypoint", "Autopilot on", "Head west", "Climb", "Descend"
- "Make it night", "Dawn", "Golden hour"
- "Barrel roll", "Ring course", "Cancel the course", "Photo mode", "Journal"

WREN answers with speech synthesis (after your first click or key press, as browsers require) and a subtitle.

### Remote copilot brain

`RemoteCopilot` POSTs `{ flightState, transcript }` to a configurable endpoint and expects `{ speech, action }`
back. If no valid reply arrives within 800 ms, it falls back to the local grammar. A reference server is
included:

```bash
npm run copilot-server
```

Then open Settings in the game, turn on **Remote copilot** and keep the endpoint `http://localhost:3000/copilot`.
If port 3000 is reserved on your machine (common on Windows with Hyper-V or WSL), run the server on another
port, for example `PORT=3300 npm run copilot-server`, and set the endpoint to `http://localhost:3300/copilot`.
The server answers from its own rules. If `ANTHROPIC_API_KEY` is set in its environment, it asks Claude first
(model from `COPILOT_MODEL`, default `claude-haiku-4-5-20251001` for latency). The key is read only from the
environment and never sent to the browser. The server only answers the game's own origins (`file://` pages and
`localhost` / `127.0.0.1` on any port); add others with `ALLOWED_ORIGINS`, so an unrelated website cannot spend
your key through it. `COPILOT_TEST_DELAY=1` enables the `?delay=ms` test aid for exercising the 800 ms fallback.
See the header of `tools/copilot-server.mjs` for all options.

## Testing

```bash
npm install
npm test
```

`npm test` runs `tools/smoke-test.mjs`. It loads the game in your local Chrome or Edge through puppeteer-core
(set `CHROME_PATH` if the browser is elsewhere), fails on any console error or warning, and saves two
screenshots taken a few seconds apart to prove the render loop is live. Useful flags:

```bash
node tools/smoke-test.mjs --query "seed=K7Q2ZD&renderer=webgl" --seconds 12
node tools/smoke-test.mjs --steps '[{"press":"KeyP"},{"wait":800},{"shot":"photo"}]'
```

`window.DRIFTWING` exposes `ready`, `backend`, `frame`, `getStats()` and the game context for scripted checks.

## How it is built

`index.html` holds all CSS, markup and one module script:

1. **Core.** Config, the deterministic world generator (`createWorldGen`: seeded simplex noise, climate and
   biome weights, heights, face colours, vegetation scatter, landmark sites), shared state, the event bus,
   settings, the spawn finder, the post-processing stack, the performance governor and the main loop.
2. **Systems.** Terrain, sky, water, clouds, birds, effects, input, flight, camera, landmarks, journal,
   waypoints, rings, audio, copilot and UI. Each is created by a `create*System(ctx)` factory and updated
   in a fixed order each frame.

three.js is pinned to r184 and every module fetched from the CDN is checked against a SHA-384 hash in the import
map's `integrity` block, so a tampered or changed file is refused.

The terrain Web Worker is created from a Blob URL. Its source is `createWorldGen.toString()` plus the
worker's mesh builder, so the worker and the main thread share one implementation of the world. The main
thread uses the same generator for the exact ground height under the glider, which keeps the aircraft from
falling through chunks that have not loaded yet.

Safety guards: `dt` is clamped against tab-blur spikes, the attitude is checked for NaN, the altitude is
clamped to terrain and water, the worker queue is bounded and stale jobs are dropped, and the performance
governor reduces view distance and resolution before the frame rate drops.

## Known limitations

- The first click or key press unlocks audio. Creating the browser's AudioContext can take around 0.1 s on some
  machines, so a single frame may stutter at that moment.
- On some GPUs the very first ring course causes one short hitch as the driver prepares it. Every shader the game
  uses is compiled behind the loading fade, but first-draw work inside the driver can still show once.
- The WebGL2 fallback takes a few seconds longer to start than WebGPU, because WebGL compiles its shaders
  synchronously.
- Voice input uses the Web Speech API, which works in Chrome and Edge and needs microphone permission. Some browsers
  refuse the microphone on `file://`; use `npm run serve` if the mic is blocked. Typing to WREN always works.
- three.js loads from the jsDelivr CDN, so the first launch needs a network connection.

## Project layout

```
index.html               the game
tools/serve.mjs          zero-dependency static server (npm run serve)
tools/smoke-test.mjs     headless console + screenshot check (npm test)
tools/copilot-server.mjs reference remote brain for WREN (npm run copilot-server)
package.json             scripts and the puppeteer-core dev dependency
```

No binary assets: everything, including the glider, trees, landmarks and sounds, is generated in code.
