import puppeteer from 'puppeteer'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const srv = http.createServer((q, r) => { const p = path.join(root, q.url.split('?')[0]); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, {'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html' : 'application/octet-stream'}); r.end(d); } }); }).listen(0);
const browser = await puppeteer.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new'});
const page = await browser.newPage(); await page.setViewport({width: 480, height: 360});
await page.goto(`http://localhost:${srv.address().port}/spike-tools/viewer.html`);
for (const [name, autoplay] of [['all-noautoplay', false], ['all-autoplay', true]]) {
  await page.reload();
  await page.evaluate(async (autoplay) => { const mv = document.getElementById('mv');
    mv.setAttribute('animation-name', 'frames'); if (autoplay) mv.setAttribute('autoplay', ''); mv.src = '/spike-tools/out/light-30-all.glb';
    await new Promise(r => mv.addEventListener('load', r, {once: true})); }, autoplay);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
  await page.screenshot({path: `../shots-glb/first-${name}.png`});
}
await browser.close(); srv.close();
