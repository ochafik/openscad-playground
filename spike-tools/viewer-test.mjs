// Loads an animated GLB in the real <model-viewer> (public/model-viewer.min.js) and checks playback, scrubbing,
// looping, bounds stability and memory. usage: node viewer-test.mjs <glb name in spike-tools/out> <fps> <frames> [shots-dir]
import puppeteer from 'puppeteer';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const [glb, fpsS, nS, shots] = process.argv.slice(2); const fps = +fpsS, N = +nS;
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, {'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html' : p.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream'}); r.end(d); } }); }).listen(0);
const port = srv.address().port;
const browser = await puppeteer.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--enable-unsafe-swiftshader', '--use-angle=metal', '--ignore-gpu-blocklist']});
const page = await browser.newPage(); await page.setViewport({width: 480, height: 360});
page.on('pageerror', e => console.log('pageerror', e.message)); page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); });
await page.goto(`http://localhost:${port}/spike-tools/viewer.html`);
const gl = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('GL renderer:', gl);
const res = await page.evaluate(async (glb) => {
  const mv = document.getElementById('mv'); const out = {};
  const mem0 = performance.memory?.usedJSHeapSize;
  const t0 = performance.now();
  const loaded = new Promise(r => mv.addEventListener('load', r, {once: true}));
  mv.setAttribute('animation-name', 'frames');
  mv.src = `/spike-tools/out/${glb}`;
  await loaded; out.loadMs = Math.round(performance.now() - t0);
  out.memDeltaMB = +((performance.memory.usedJSHeapSize - mem0) / 1e6).toFixed(1);
  out.available = mv.availableAnimations; out.duration = mv.duration; {const d=mv.getDimensions(); out.dim=[d.x,d.y,d.z].map(v=>+v.toFixed(2));}
  {const c=mv.getBoundingBoxCenter(); out.center=[c.x,c.y,c.z].map(v=>+v.toFixed(2));}
  out.paused0 = mv.paused;
  return out;
}, glb);
console.log(JSON.stringify(res));
const probe = await page.evaluate(async (fps, N) => {
  const mv = document.getElementById('mv'); const o = {};
  // 1. scrub: set currentTime and read back; wait for a render each
  mv.pause(); const rows = [];
  for (const i of [0, 1, Math.floor(N / 2), N - 1]) { mv.currentTime = (i + 0.5) / fps; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); rows.push([i, +mv.currentTime.toFixed(4)]); }
  o.scrub = rows;
  // 2. playback rate and loop: play, sample for 2 loops (cap 6s)
  mv.currentTime = 0; mv.play({repetitions: Infinity}); const t0 = performance.now(); let last = -1, wraps = 0, maxT = 0, samples = 0;
  const limit = Math.min(2.2 * mv.duration * 1000, 6000);
  await new Promise(res => { const tick = () => { const c = mv.currentTime; if (c < last - 1e-6) wraps++; last = c; maxT = Math.max(maxT, c); samples++; (performance.now() - t0 < limit) ? requestAnimationFrame(tick) : res(); }; tick(); });
  const el = (performance.now() - t0) / 1000;
  o.play = {elapsedS: +el.toFixed(2), wraps, expectedWraps: Math.floor(el / mv.duration), maxT: +maxT.toFixed(3), duration: +mv.duration.toFixed(3), samples, avgFps: +(samples / el).toFixed(1)};
  const d=mv.getDimensions(); const c=mv.getBoundingBoxCenter(); o.dimAfterPlay=[d.x,d.y,d.z].map(v=>+v.toFixed(2)); o.centerAfterPlay=[c.x,c.y,c.z].map(v=>+v.toFixed(2));
  mv.pause(); return o;
}, fps, N);
console.log(JSON.stringify(probe));
if (shots) { fs.mkdirSync(shots, {recursive: true});
  for (const i of [0, Math.floor(N / 4), Math.floor(N / 2), Math.floor(3 * N / 4)]) {
    await page.evaluate(async (t) => { const mv = document.getElementById('mv'); mv.pause(); mv.currentTime = t; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, (i + 0.5) / fps);
    await page.screenshot({path: `${shots}/${glb.replace('.glb', '')}-f${String(i).padStart(3, '0')}.png`}); }
}
await browser.close(); srv.close();
