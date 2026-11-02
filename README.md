# Three.js r187: concurrent `compileAsync()` calls reject

Two overlapping `WebGPURenderer.compileAsync()` calls on a warmed scene both
resolve in **0.186.0**. In **0.187.0**, one rejects with:

```text
TypeError: Cannot destructure property 'useFrameBufferTarget' of 'this._precompilationState' as it is null.
```

Expected: both calls resolve. Sequential calls succeed in both versions.

## Reproduce

Requires Node.js/npm, Python 3, and a WebGPU-capable browser. From the repository root:

```sh
npm ci --prefix r186
npm ci --prefix r187
python3 -m http.server 8000 --bind 127.0.0.1
```

Open both pages and confirm the displayed backend is `WebGPU`:

| Page | Three.js | Concurrent calls |
| --- | --- | --- |
| http://127.0.0.1:8000/r186/ | 0.186.0 | 2 fulfilled, 0 rejected |
| http://127.0.0.1:8000/r187/ | 0.187.0 | 1 fulfilled, 1 rejected |

The pages show the loaded revision, result counts, and rejection stack.
[r186/index.html](r186/index.html) and [r187/index.html](r187/index.html) are
identical; only their pinned dependencies differ. Each creates one scene with
one box and a `MeshBasicNodeMaterial`, then runs:

```js
await renderer.init();
await renderer.compileAsync(scene, camera); // Warm caches.
const results = await Promise.allSettled([
  renderer.compileAsync(scene, camera),
  renderer.compileAsync(scene, camera)
]);
```

Keep the warm-up for reliable reproduction. Workaround: await each compile
before starting the next.

## Automated verification

After installing both repro dependencies above, with Node.js 20+:

```sh
npm ci
npx playwright install chromium
npm test
```

Alternatively, use an installed Chromium with `BROWSER_PATH=/usr/bin/chromium npm test`.
The verifier starts its own server and enables WebGPU on SwiftShader.

Verified on Linux, Chromium **154.0.8037.57**, WebGPU/SwiftShader: **10/10 runs
per version** matched the table above. Concurrent compilation of individual
warmed meshes also failed only in r187; sequential compilation passed in both.
[verification.json](verification.json) contains browser flags, counts, and error
stacks pointing to `_finishPreCompile()`. The verifier checks the exact error
and requires the WebGPU backend.
