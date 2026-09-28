# V1 known issues

V1 is `index.html` from the git tag `v1-final`, frozen byte-for-byte at `public/v1/index.html`
(SHA-256 in `tests/v1.sha256`, checked by `npm run test:v1`). It is never edited, linted or fixed,
so anything it prints to the console is its original behaviour and is recorded here instead.

## Console output

**None under normal conditions.** V1 printed no console errors, no console warnings and no other
console messages, and no request failed, on either backend, both on its own and inside the
launcher shell.

| date | how V1 was loaded | backend | errors | warnings | other messages |
| --- | --- | --- | --- | --- | --- |
| 2026-09-27 | standalone, `public/v1/index.html` served by `tools/serve.mjs` | WebGPU | 0 | 0 | 0 |
| 2026-09-27 | standalone, same, `?renderer=webgl` | WebGL2 | 0 | 0 | 0 |
| 2026-09-27 | in the shell, `/?v=1` on the Vite dev server | WebGPU | 0 | 0 | 0 |
| 2026-09-27 | in the shell, `/?v=1&renderer=webgl` on the Vite dev server | WebGL2 | 0 | 0 | 0 |
| 2026-09-27 | in the shell, switched to and from V2 (`tools/shell-check.mjs`, dev server and `dist-single/`, both backends) | both | 0 | 0 | 0 |

Test commands (headless Chrome; the smoke test flies 10 s and fails on any console error or
warning, the shell check records V1's console separately):

```
node tools/smoke-test.mjs --file public/v1/index.html --seconds 10 --out <dir>
node tools/smoke-test.mjs --file public/v1/index.html --query renderer=webgl --seconds 10 --out <dir>
node tools/smoke-test.mjs --url http://127.0.0.1:<port>/ --query v=1 --seconds 10 --out <dir>
node tools/smoke-test.mjs --url http://127.0.0.1:<port>/ --query "v=1&renderer=webgl" --seconds 10 --out <dir>
node tools/shell-check.mjs --url http://127.0.0.1:<port>/ [--backend webgl] --out <dir>
```

## When the GPU cannot create a WebGPU device

Observed on 2026-09-27 while another program kept the shared test machine's GPU at 99 % load: the
browser found a WebGPU adapter but could not create a device. Chrome then warns (its own message,
from any page):

```
Failed to create device:
D3D12 create command queue failed with E_OUTOFMEMORY (0x8007000E)
```

V1 decides on WebGPU before that failure is known, so it builds its renderer for WebGPU (with a
reversed depth buffer) and three.js falls back to WebGL2 underneath. In that state three.js warns
once, and Chrome warns on every frame, and the 3D view stays black while the HUD works:

```
THREE.WebGPURenderer: WebGPU is not available, running under WebGL2 backend.
[.WebGL-...] GL_INVALID_OPERATION: glBlitFramebuffer: Depth/stencil buffer format combination not allowed for blit.
```

This is V1's original behaviour (the same code path runs standalone) and it is left alone. Once
the GPU could create devices again, every run above was clean. `?v=1&renderer=webgl` avoids the
state entirely, since V1 then builds its renderer for WebGL2 from the start.

V1 also loads three.js r184 from its own CDN importmap (jsDelivr, with integrity hashes), so it
needs an internet connection; offline, those module requests fail and V1 cannot start.
