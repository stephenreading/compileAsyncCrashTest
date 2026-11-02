# Concurrent `compileAsync` regression in Three.js r187

Two standalone repro projects compare **0.186.0** and **0.187.0** on
`WebGPURenderer`. Their HTML is identical; only their pinned Three.js dependency
differs. Each uses one box, one basic node material, one scene, and two concurrent
calls after a successful warm-up. No lights, custom node graphs, rendering loop,
build tool, or timing delays are needed.

## Run the repros

From the repository root:

```sh
npm ci --prefix r186
npm ci --prefix r187
python3 -m http.server 8000 --bind 127.0.0.1
```

Open these URLs in a browser with WebGPU enabled:

- [r186](http://127.0.0.1:8000/r186/): **2 fulfilled, 0 rejected**.
- [r187](http://127.0.0.1:8000/r187/): **1 fulfilled, 1 rejected**.

Each page displays the loaded revision, actual backend, counts, and error stack.
Confirm `backend` is `WebGPU`. A WebGL fallback is not verification of this report.
Dependencies are served locally; neither repro needs network access after install.
Each folder can also be installed and served independently.

The essential sequence is:

```js
await renderer.init();
await renderer.compileAsync(scene, camera); // Warm caches.
const results = await Promise.allSettled([
  renderer.compileAsync(scene, camera),
  renderer.compileAsync(scene, camera)
]);
```

The rejection in r187 is:

```text
TypeError: Cannot destructure property 'useFrameBufferTarget' of 'this._precompilationState' as it is null.
```

Expected: both calls resolve, as in r186. The original report used 20 distinct
physical node materials and compiled individual warmed meshes. One basic mesh
and two calls suffice. Keep the warm-up: removing it made the failure intermittent
during minimization.

## Repeatable verification

The root package is optional and only runs the browser verifier (Node.js 20+).
After installing both repro dependencies above:

```sh
npm ci
npx playwright install chromium
npm test
```

To use an existing Chromium instead of downloading one:

```sh
BROWSER_PATH=/usr/bin/chromium npm test
```

The verifier starts its own local server and uses headless Chromium with WebGPU
on SwiftShader. It requires the WebGPU backend, checks the exact error and
`_finishPreCompile` stack frame, and rejects unexpected browser errors. Each case
runs 10 times per version. Every iteration opens a fresh page; controls use new
renderers so the failed compile cannot contaminate them.

Verified on Linux with Chromium **154.0.8037.57**, Node **24.19.0**, and the
SwiftShader WebGPU adapter:

| Case (two calls after warm-up) | r186 | r187 | Matching runs per version |
| --- | --- | --- | --- |
| Minimal: same one-mesh scene concurrently | 2 fulfilled | 1 fulfilled, 1 rejected | 10/10 |
| Report pattern: individual meshes concurrently, two meshes | 2 fulfilled | 1 fulfilled, 1 rejected | 10/10 |
| Control: same one-mesh scene sequentially | 2 fulfilled | 2 fulfilled | 10/10 |

`verification.json` records the environment, browser flags, matched run counts,
and representative results with full error stacks. `npm test` rewrites it only
after all assertions pass. This verifies the regression in this environment;
other browsers and hardware were not tested.

## Likely cause and workaround

r187 keeps active compilation state in a shared renderer field,
`_precompilationState`. Concurrent calls can interleave around the awaited node
build, allowing one call to clear the state before another calls
`_finishPreCompile()`. The observed rejection originates in that method. The
minimal repro does not require exhausting the scheduler's time budget.

Await each compile before starting the next as a workaround. This PR demonstrates
the regression; it does not change Three.js internals.
