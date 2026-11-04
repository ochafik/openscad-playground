// per-frame src swap vs currentTime scrub, heavy model (17.5k verts / 35k tris per frame)
import puppeteer from 'puppeteer'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const srv = http.createServer((q, r) => { const p = path.join(root, q.url.split('?')[0]); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, {'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html' : 'application/octet-stream'}); r.end(d); } }); }).listen(0);
const browser = await puppeteer.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new'});
const page = await browser.newPage(); await page.setViewport({width: 480, height: 360});
await page.goto(`http://localhost:${srv.address().port}/spike-tools/viewer.html`);
const r = await page.evaluate(async () => {
  const mv = document.getElementById('mv'); const out = {};
  const load = () => new Promise(r => mv.addEventListener('load', r, {once: true}));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // swap approach: blob URLs of 30 single-frame GLBs (like the app's data/object URLs), time from src set to load event + 1 frame
  const blobs = []; for (let i = 0; i < 30; i++) blobs.push(URL.createObjectURL(await (await fetch(`/spike-tools/out/heavy-f${i}.glb`)).blob()));
  mv.src = blobs[0]; await load(); await raf2();
  const sw = []; for (let i = 1; i < 30; i++) { const t = performance.now(); const p = load(); mv.src = blobs[i]; await p; await raf2(); sw.push(performance.now() - t); }
  out.swapMs = {median: +sw.sort((a, b) => a - b)[14].toFixed(1), p90: +sw[26].toFixed(1), max: +sw[28].toFixed(1)};
  const m0 = performance.memory.usedJSHeapSize;
  // animated GLB scrub
  const l = load(); mv.setAttribute('animation-name', 'frames'); mv.src = '/spike-tools/out/heavy-static-30.glb'; await l; mv.pause(); await raf2();
  const sc = []; for (let k = 0; k < 60; k++) { const i = (k * 7) % 30; const t = performance.now(); mv.currentTime = (i + 0.5) / 15; await raf2(); sc.push(performance.now() - t); }
  sc.sort((a, b) => a - b); out.scrubMs = {median: +sc[30].toFixed(1), p90: +sc[54].toFixed(1), max: +sc[59].toFixed(1)};
  return out;
});
console.log(JSON.stringify(r)); await browser.close(); srv.close();
