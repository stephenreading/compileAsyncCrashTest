import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep, extname } from 'node:path';
import { chromium } from 'playwright';

const root = dirname(fileURLToPath(import.meta.url));
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname === '/favicon.ico') return response.writeHead(204).end();
  const file = resolve(root, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
  if (!file.startsWith(root + sep)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    const type = extname(file) === '.html' ? 'text/html' : 'application/javascript';
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const args = ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'];
let browser;

function check(result, revision, concurrent) {
  assert.equal(result.revision, revision);
  assert.equal(result.backend, 'WebGPU', 'WebGL fallback does not verify the reported WebGPU bug');
  const rejected = concurrent && revision === '187' ? 1 : 0;
  assert.equal(result.fulfilled, 2 - rejected);
  assert.equal(result.rejected.length, rejected);
  for (const error of result.rejected) {
    assert.equal(error.name, 'TypeError');
    assert.equal(error.message, "Cannot destructure property 'useFrameBufferTarget' of 'this._precompilationState' as it is null.");
    assert.match(error.stack, /_finishPreCompile/);
  }
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
    args
  });
  const report = {
    verifiedAt: new Date().toISOString(),
    browser: await browser.version(),
    platform: process.platform,
    node: process.version,
    args,
    runsPerCase: 10,
    versions: []
  };
  for (const revision of ['186', '187']) {
    const cases = Object.fromEntries(['minimal', 'warmedMeshes', 'sequential'].map(name => [name, { matchedRuns: 0 }]));
    const record = (name, result) => {
      cases[name].matchedRuns++;
      cases[name].example ??= result;
    };
    for (let run = 0; run < report.runsPerCase; run++) {
      const page = await browser.newPage();
      try {
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
        await page.goto(`${origin}/r${revision}/`);
        await page.waitForFunction(() => window.reproResult, null, { timeout: 30_000 });
        const minimal = await page.evaluate(() => window.reproResult);
        check(minimal, revision, true);
        record('minimal', minimal);

        // Independent renderers: a failed concurrent compile must not contaminate controls.
        for (const mode of ['warmedMeshes', 'sequential']) {
          const result = await page.evaluate(async mode => {
            const THREE = await import('three/webgpu');
            const renderer = new THREE.WebGPURenderer();
            await renderer.init();
            try {
              const scene = new THREE.Scene();
              const camera = new THREE.PerspectiveCamera();
              const geometry = new THREE.BoxGeometry();
              scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial()));
              let results;
              if (mode === 'warmedMeshes') {
                scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial()));
                await renderer.compileAsync(scene, camera);
                results = await Promise.allSettled(scene.children.map(mesh => renderer.compileAsync(mesh, camera, scene)));
              } else {
                await renderer.compileAsync(scene, camera);
                results = [];
                for (let i = 0; i < 2; i++) {
                  results.push(...await Promise.allSettled([renderer.compileAsync(scene, camera)]));
                }
              }
              return {
                revision: THREE.REVISION,
                backend: renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL fallback',
                fulfilled: results.filter(r => r.status === 'fulfilled').length,
                rejected: results.filter(r => r.status === 'rejected').map(r => ({
                  name: r.reason.name, message: r.reason.message, stack: r.reason.stack
                }))
              };
            } finally {
              renderer.dispose();
            }
          }, mode);
          check(result, revision, mode !== 'sequential');
          record(mode, result);
        }
        assert.deepEqual(errors, [], 'Unexpected browser errors');
        if (!report.adapter) {
          report.adapter = await page.evaluate(async () => {
            const adapter = await navigator.gpu.requestAdapter();
            const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
            return { vendor, architecture, device, description, isFallbackAdapter };
          });
        }
      } finally {
        await page.close();
      }
    }
    report.versions.push({ revision, cases });
    console.log(`r${revision}: all 10 runs matched for minimal, warmed meshes, and sequential control`);
  }
  await writeFile(new URL('./verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log('Verified WebGPU regression; evidence saved to verification.json');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
