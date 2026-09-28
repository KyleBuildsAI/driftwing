# V1 known issues

V1 is `index.html` from the git tag `v1-final`, frozen byte-for-byte at `public/v1/index.html`
(SHA-256 in `tests/v1.sha256`, checked by `npm run test:v1`). It is never edited, linted or fixed,
so anything it prints to the console is its original behaviour and is recorded here instead.

## Console output

**None.** V1 printed no console errors, no console warnings and no other console messages, and no
request failed, on either backend.

| date | how V1 was loaded | backend | errors | warnings | other messages |
| --- | --- | --- | --- | --- | --- |
| 2026-09-27 | standalone, `public/v1/index.html` served by `tools/serve.mjs` | WebGPU | 0 | 0 | 0 |
| 2026-09-27 | standalone, same, `?renderer=webgl` | WebGL2 | 0 | 0 | 0 |

Test commands (headless Chrome, 10 s of flight each, fails on any console error or warning):

```
node tools/smoke-test.mjs --file public/v1/index.html --seconds 10 --out <dir>
node tools/smoke-test.mjs --file public/v1/index.html --query renderer=webgl --seconds 10 --out <dir>
```

V1 loads three.js r184 from its own CDN importmap (jsDelivr, with integrity hashes), so it needs an
internet connection; offline, those module requests fail and V1 cannot start. That is also original
behaviour.
