// Incremental GLB swap while playing: what does model-viewer do on a src change (time, camera, visible gap)?
import puppeteer from 'puppeteer'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const srv = http.createServer((q, r) => { const p = path.join(root, q.url.split('?')[0]); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, {'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html' : 'application/octet-stream'}); r.end(d); } }); }).listen(0);
const browser = await puppeteer.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new'});
const page = await browser.newPage(); await page.setViewport({width: 480, height: 360});
await page.goto(`http://localhost:${srv.address().port}/spike-tools/viewer.html`);
const r = await page.evaluate(async () => {
  const mv = document.getElementById('mv'); const out = [];
  const load = () => new Promise(r => mv.addEventListener('load', r, {once: true}));
  const snap = (label, extra = {}) => { const o = mv.getCameraOrbit(); const d = mv.getDimensions(); out.push({label, t: +mv.currentTime.toFixed(3), paused: mv.paused, radius: +o.radius.toFixed(2), theta: +o.theta.toFixed(3), dim: [d.x, d.y, d.z].map(v => +v.toFixed(1)), dur: mv.duration, ...extra}); };
  mv.setAttribute('animation-name', 'frames'); mv.setAttribute('autoplay', '');
  mv.src = '/spike-tools/out/part-5.glb'; await load(); await new Promise(r => setTimeout(r, 400)); snap('part-5 after 400ms playing');
  // user rotates the camera
  mv.cameraOrbit = '0.7rad 1.2rad 80%'; mv.jumpCameraToGoal(); await new Promise(r => setTimeout(r, 100)); snap('user camera set');
  // gap measurement: record whether canvas ever blanks during the swap (sample the shadow canvas via toBlob is heavy) -> record 'model-visibility' events instead
  let vis = []; mv.addEventListener('model-visibility', e => vis.push([performance.now()|0, e.detail.visible]));
  for (const k of [10, 20, 30]) {
    const keepT = mv.currentTime % (k / 15); const t0 = performance.now();
    mv.src = `/spike-tools/out/part-${k}.glb`; await load(); const ms = Math.round(performance.now() - t0);
    snap(`after swap to part-${k} (load ${ms}ms, before restore)`, {keepT: +keepT.toFixed(3)});
    mv.currentTime = keepT; mv.play(); await new Promise(r => setTimeout(r, 200)); snap(`part-${k} after restoring time + 200ms`);
  }
  out.push({visEvents: vis}); return out;
});
for (const x of r) console.log(JSON.stringify(x));
await browser.close(); srv.close();
