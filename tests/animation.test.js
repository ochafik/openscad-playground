// Animation ($t) support: controls, frame rendering, looping, scrubbing, invalidation, settings, embed.
// See docs/ANIMATION.md.

const longTimeout = 120000;

const isProd = process.env.NODE_ENV === 'production';
const baseUrl = process.env.E2E_BASE_URL ?? (isProd ? 'http://localhost:3000/dist/' : 'http://localhost:4000/');

const messages = [];
beforeAll(async () => {
  page.on('console', (msg) => messages.push({ type: msg.type(), text: msg.text(), location: msg.location() }));
});
beforeEach(async () => {
  await page.goto('about:blank');
  messages.length = 0;
});
afterEach(async () => {
  const errors = messages.filter(m => m.type === 'error' && !m.text.includes('InterVariable.woff'));
  expect(errors.map(m => m.text)).toEqual([]);
});

const SPIN = 'rotate([0, 0, $t * 360]) cube([10, 5, 5]);';

/** Open the app with this source and (optionally) loop settings, through a share-link style fragment. */
async function load(src, { animation, query = '', path = '/playground.scad' } = {}) {
  const state = {
    params: { activePath: path, sources: [{ path, content: src }], features: [], exportFormat2D: 'svg', exportFormat3D: 'stl' },
    view: { layout: { mode: 'multi', editor: true, viewer: true, customizer: false }, color: '#f9d72c', ...(animation ? { animation } : {}) },
  };
  await page.goto(baseUrl); // same-origin page to run the compressor in
  const fragment = await page.evaluate(async (json) => {
    const bytes = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  }, JSON.stringify(state));
  messages.length = 0;
  await page.goto(`${baseUrl}${query}#${fragment}`);
  await page.reload();
  await page.waitForSelector('model-viewer.main-viewer');
}

const PLAY = 'button[aria-label="Play animation"]';
const PAUSE = 'button[aria-label="Pause animation"]';
const SLIDER = 'input[aria-label="Animation time"]';

const label = () => page.$eval('[data-testid=animation-time]', e => e.textContent);
const modelSrc = () => page.$eval('model-viewer.main-viewer', v => v.src);

/** Position bounds of the displayed model (read from the GLB the viewer was given). */
async function bounds() {
  const bytes = await page.evaluate(async () => {
    const src = document.querySelector('model-viewer.main-viewer').src;
    return Array.from(new Uint8Array(await (await fetch(src)).arrayBuffer()));
  });
  const buf = Buffer.from(bytes);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
  const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  return { min: pos.min.map(round), max: pos.max.map(round) };
}
const round = (x) => Math.round(x * 100) / 100;

/** Wait until the label shows this time and the viewer has the matching model. */
async function waitForTime(text) {
  await page.waitForFunction((t) => document.querySelector('[data-testid=animation-time]')?.textContent === t, { timeout: 60000 }, text);
}
async function setSlider(frame) {
  await page.$eval(SLIDER, (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, frame);
}
/** The model GLB changes after a swap: wait for the viewer to show something other than `previous`. */
const waitForModelChange = (previous) => page.waitForFunction((p) => document.querySelector('model-viewer.main-viewer').src !== p, { timeout: 60000 }, previous);

describe('animation', () => {
  test('a model without $t has no animation controls', async () => {
    for (const src of ['cube(5);', '// $t is not used here\ncube(5);', 'echo("$t"); cube(5); /* $t */ s = $fn;']) {
      await load(src);
      await page.waitForFunction(() => document.querySelector('model-viewer.main-viewer')?.src !== '', { timeout: 60000 });
      await page.waitForSelector('button[title="Settings menu"]');
      expect(await page.$(PLAY)).toBeNull();
      expect(await page.$(SLIDER)).toBeNull();
    }
  }, longTimeout * 2);

  test('a $t model gets play/pause, a slider and the time; the slider shows the model at that time', async () => {
    await load(SPIN, { animation: { steps: 4, fps: 20 } });
    await page.waitForSelector(PLAY, { timeout: 60000 });
    await page.waitForSelector(SLIDER);
    expect(await page.$eval(SLIDER, e => [e.min, e.max])).toEqual(['0', '3']);
    expect(await label()).toBe('$t=0.00');
    // t = 0: the cube as modelled, [0,10] x [0,5].
    await page.waitForFunction(() => document.querySelector('model-viewer.main-viewer').src.startsWith('data:'), { timeout: 60000 });
    expect(await bounds()).toEqual({ min: [0, 0, 0], max: [10, 5, 5] });
    // Scrub to t = 0.25: rotated by 90 degrees about z (x in [-5,0], y in [0,10]), rendered on demand.
    const before = await modelSrc();
    await setSlider(1);
    await waitForTime('$t=0.25');
    await waitForModelChange(before);
    expect(await bounds()).toEqual({ min: [-5, 0, 0], max: [0, 10, 5] });
    // And t = 0.5: x in [-10,0], y in [-5,0].
    const before2 = await modelSrc();
    await setSlider(2);
    await waitForTime('$t=0.50');
    await waitForModelChange(before2);
    expect(await bounds()).toEqual({ min: [-10, -5, 0], max: [0, 0, 5] });
    // Scrubbing does not play.
    expect(await page.$(PLAY)).not.toBeNull();
  }, longTimeout);

  test('play renders distinct frames progressively, loops, and pause stops', async () => {
    await load(SPIN, { animation: { steps: 4, fps: 20 } });
    await page.waitForSelector(PLAY, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('model-viewer.main-viewer').src.startsWith('data:'), { timeout: 60000 });
    // (the first model fades in over half a second)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('model-viewer.main-viewer')).opacity === '1', { timeout: 30000 });
    await page.click(PLAY);
    await page.waitForSelector(PAUSE);
    const times = [];
    const srcs = new Set();
    const opacities = [];
    const deadline = Date.now() + 90000;
    // Sample until the loop has wrapped around twice (3 -> 0 twice).
    let wraps = 0;
    while (wraps < 2 && Date.now() < deadline) {
      const [t, src, opacity] = await page.evaluate(() => [
        document.querySelector('[data-testid=animation-time]').textContent,
        document.querySelector('model-viewer.main-viewer').src,
        getComputedStyle(document.querySelector('model-viewer.main-viewer')).opacity,
      ]);
      if (times.at(-1) !== t) {
        if (times.at(-1) === '$t=0.75' && t === '$t=0.00') wraps++;
        times.push(t);
      }
      srcs.add(src);
      opacities.push(Number(opacity));
      await new Promise(r => setTimeout(r, 25));
    }
    expect(wraps).toBe(2);
    // Frames advance in order, one at a time.
    const order = ['$t=0.00', '$t=0.25', '$t=0.50', '$t=0.75'];
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBe(order[(order.indexOf(times[i - 1]) + 1) % 4]);
    }
    expect(srcs.size).toBeGreaterThanOrEqual(4); // four distinct models (data URLs), so the viewer really changed
    // No flicker: the viewer never fades out while frames swap.
    expect(Math.min(...opacities)).toBeGreaterThan(0.99);
    // Pause.
    await page.click(PAUSE);
    await page.waitForSelector(PLAY);
    const stopped = await label();
    await new Promise(r => setTimeout(r, 800));
    expect(await label()).toBe(stopped);
  }, longTimeout * 2);

  test('an edit pauses and invalidates the frames: the new model is shown at the current time', async () => {
    await load(SPIN, { animation: { steps: 4, fps: 20 } });
    await page.waitForSelector(PLAY, { timeout: 60000 });
    await page.click(PLAY);
    await page.waitForSelector(PAUSE);
    await waitForTime('$t=0.25');
    await page.waitForFunction(() => !!window.monaco, { timeout: 30000 });
    await page.evaluate(() => window.monaco.editor.getModels()[0].setValue('rotate([0, 0, $t * 360]) cube([20, 5, 5]);'));
    await page.waitForSelector(PLAY, { timeout: 5000 }); // paused right away
    // The model that eventually shows is the edited one, at a time of the loop (never an old frame).
    await page.waitForFunction(async () => {
      const v = document.querySelector('model-viewer.main-viewer');
      const buf = new Uint8Array(await (await fetch(v.src)).arrayBuffer());
      const len = new DataView(buf.buffer).getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(buf.slice(20, 20 + len)));
      const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
      return Math.max(...pos.max.slice(0, 2).map(Math.abs), ...pos.min.slice(0, 2).map(Math.abs)) >= 19.5;
    }, { timeout: 60000, polling: 500 });
    const paused = await label();
    await new Promise(r => setTimeout(r, 1000));
    expect(await label()).toBe(paused);
    expect(await page.$(PLAY)).not.toBeNull();
    // The settings popover counts rendered frames: it was reset by the edit.
    await page.click('button[aria-label="Animation settings"]');
    await page.waitForSelector('[role=dialog][aria-label="Animation settings"]');
    expect(await page.$eval('[role=dialog][aria-label="Animation settings"]', e => e.textContent)).toMatch(/\b[0-3]\/4 frames rendered/);
  }, longTimeout);

  test('Render (full) pauses playback and renders the current frame', async () => {
    await load(SPIN, { animation: { steps: 4, fps: 20 } });
    await page.waitForSelector(PLAY, { timeout: 60000 });
    await page.click(PLAY);
    await page.waitForSelector(PAUSE);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Render'), { timeout: 30000 });
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Render').click());
    await page.waitForSelector(PLAY, { timeout: 10000 });
    const t = await label();
    // The final render completes (the button turns into the export button) and the time did not move.
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => /Rendering|Render$/.test(b.textContent.trim())), { timeout: 60000 });
    expect(await label()).toBe(t);
  }, longTimeout);

  test('settings: steps and fps change the loop and survive a reload (they are part of the link)', async () => {
    await load(SPIN);
    await page.waitForSelector(SLIDER, { timeout: 60000 });
    expect(await page.$eval(SLIDER, e => e.max)).toBe('29'); // 30 steps by default
    await page.click('button[aria-label="Animation settings"]');
    const dialog = '[role=dialog][aria-label="Animation settings"]';
    await page.waitForSelector(dialog);
    for (const [field, value] of [['steps', '8'], ['fps', '4']]) {
      const input = `input[aria-label="Animation ${field}"]`;
      await page.click(input);
      await page.$eval(input, e => e.select());
      await page.keyboard.type(value);
      await page.keyboard.press('Enter');
    }
    await page.waitForFunction((s) => document.querySelector(s)?.max === '7', {}, SLIDER);
    expect(await page.$eval(dialog, e => e.textContent)).toContain('Loop: 2.0 s (8 frames)');
    await new Promise(r => setTimeout(r, 1500)); // the link is updated asynchronously
    await page.reload();
    await page.waitForSelector(SLIDER, { timeout: 60000 });
    expect(await page.$eval(SLIDER, e => e.max)).toBe('7');
  }, longTimeout);

  test('the JavaScript engine (wasm2js) defaults to a short loop', async () => {
    // Only the defaults: the (very slow) engine is not needed for the controls to show.
    await load(SPIN, { query: '?wasmEngine=wasm2js' });
    await page.waitForSelector(SLIDER, { timeout: 60000 });
    expect(await page.$eval(SLIDER, e => e.max)).toBe('7');
    messages.length = 0; // a missing fallback build is reported as a banner/console error, not what is tested
  }, longTimeout);

  test('embed: the toolbar carries Play next to Render, the slider sits along the bottom', async () => {
    await load(SPIN, { animation: { steps: 4, fps: 20 }, query: '?embed=1' });
    await page.waitForSelector(`[role=toolbar] ${PLAY}`, { timeout: 60000 });
    const labels = await page.$$eval('[role=toolbar][aria-label="Viewer actions"] [aria-label]', els => els.map(e => e.getAttribute('aria-label')));
    const renderAt = labels.findIndex(l => l === 'Render' || l === 'Rendering…'); // (busy while the first preview renders)
    expect(renderAt).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Play animation')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Play animation')).toBeLessThan(renderAt);
    const box = await page.$eval(SLIDER, e => { const r = e.getBoundingClientRect(); return { bottom: r.bottom, h: innerHeight, w: r.width }; });
    expect(box.bottom).toBeGreaterThan(box.h - 60);
    expect(box.w).toBeGreaterThan(60);
    await page.waitForFunction(() => document.querySelector('model-viewer.main-viewer').src.startsWith('data:'), { timeout: 60000 });
    await page.click(`[role=toolbar] ${PLAY}`);
    await page.waitForSelector(`[role=toolbar] ${PAUSE}`);
    await page.waitForFunction(() => document.querySelector('[data-testid=animation-time]').textContent === '$t=0.50', { timeout: 90000 });
    // Embed without $t: no animation controls, Render stays.
    await load('cube(3);', { query: '?embed=1' });
    await page.waitForSelector('[role=toolbar] [aria-label="Render"]', { timeout: 60000 });
    expect(await page.$(PLAY)).toBeNull();
  }, longTimeout * 2);

  test('a framed page (the MCP app is one) gets the animation controls too', async () => {
    const url = `${baseUrl}#src=${encodeURIComponent(SPIN)}`;
    await page.goto(`${baseUrl}manifest.json`);
    await page.evaluate((u) => { document.body.innerHTML = `<iframe style="width:900px;height:500px" src="${u}"></iframe>`; }, url);
    const frame = await (await page.waitForSelector('iframe')).contentFrame();
    await frame.waitForSelector(`[role=toolbar] ${PLAY}`, { timeout: 60000 });
    await frame.waitForSelector('[role=toolbar] [aria-label="Render"]');
    await frame.click(`[role=toolbar] ${PLAY}`);
    await frame.waitForSelector(`[role=toolbar] ${PAUSE}`);
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].location?.url?.endsWith('/favicon.ico')) messages.splice(i, 1);
  }, longTimeout);

  describe('camera', () => {
    // A part orbiting a fixed sphere: the bounds of the model change with $t, the sphere must not move on screen.
    const ORBIT = 'rotate([0,0,$t*360]) translate([15,0,0]) cube(8); sphere(6);';

    /** model-viewer's camera (and the attributes that would make it re-frame), plus the displayed model. */
    const camera = () => page.evaluate(() => {
      const v = document.querySelector('model-viewer.main-viewer');
      const o = v.getCameraOrbit(), t = v.getCameraTarget();
      return { radius: o.radius, theta: o.theta, phi: o.phi, target: [t.x, t.y, t.z], fov: v.getFieldOfView(), src: v.src.slice(-40) };
    });
    const sameCamera = (a, b, eps = 1e-3) => {
      for (const k of ['radius', 'theta', 'phi', 'fov']) expect(Math.abs(a[k] - b[k])).toBeLessThan(eps);
      a.target.forEach((x, i) => expect(Math.abs(x - b.target[i])).toBeLessThan(eps));
    };
    const settle = async () => {
      await page.waitForFunction(() => document.querySelector('model-viewer.main-viewer')?.loaded, { timeout: 60000 });
      await new Promise(r => setTimeout(r, 1000)); // (the first model fades in; the camera glides to its goal)
    };
    /** Samples the camera on every animation frame of the page for `ms`. */
    const sampleCamera = (ms) => page.evaluate((ms) => new Promise(resolve => {
      const v = document.querySelector('model-viewer.main-viewer');
      const out = [];
      const end = performance.now() + ms;
      const f = () => {
        const o = v.getCameraOrbit(), t = v.getCameraTarget();
        out.push({ radius: o.radius, theta: o.theta, phi: o.phi, target: [t.x, t.y, t.z], fov: v.getFieldOfView(), src: v.src.length + ':' + [...v.src].filter((_, i) => i % 29 === 0).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) });
        performance.now() < end ? requestAnimationFrame(f) : resolve(out);
      };
      f();
    }), ms);

    test('playing never re-frames: radius, target and field of view are identical on every frame', async () => {
      await load(ORBIT, { animation: { steps: 12, fps: 10 } });
      await page.waitForSelector(PLAY, { timeout: 60000 });
      await settle();
      const before = await camera();
      await page.click(PLAY);
      await page.waitForSelector(PAUSE);
      // Wait until the loop has played once all the way (every frame rendered and shown), then sample a full lap.
      await waitForTime('$t=0.92');
      await waitForTime('$t=0.00');
      const samples = await sampleCamera(1500); // 15 frames at 10 fps: a lap and more
      expect(new Set(samples.map(c => c.src)).size).toBeGreaterThanOrEqual(10);
      for (const c of samples) sameCamera(c, samples[0]);
      // The framing was widened once, before moving, to hold the whole orbit (the loop's bounding sphere is bigger than the first frame's).
      expect(samples[0].radius).toBeGreaterThan(before.radius * 1.2);
      // ... and centered on the orbit: x and z of the target are ~0 (the model is shown Y-up).
      expect(Math.abs(samples[0].target[0])).toBeLessThan(1);
      expect(Math.abs(samples[0].target[2])).toBeLessThan(1);
      await page.click(PAUSE);
    }, longTimeout * 2);

    test('model-viewer is never left to auto-frame a swapped model', async () => {
      await load(ORBIT, { animation: { steps: 8, fps: 10 } });
      await page.waitForSelector(PLAY, { timeout: 60000 });
      await settle();
      await page.click(PLAY);
      await waitForTime('$t=0.50');
      const attrs = () => page.evaluate(() => {
        const v = document.querySelector('model-viewer.main-viewer');
        return { orbit: v.cameraOrbit, target: v.cameraTarget, fov: v.fieldOfView, min: v.minCameraOrbit, max: v.maxCameraOrbit };
      });
      const during = await attrs();
      // Explicit numbers (a radius or target left on 'auto' would be re-fit by model-viewer when the model changes).
      expect(during.orbit).not.toMatch(/auto/);
      expect(during.target).not.toMatch(/auto/);
      expect(during.fov).not.toMatch(/auto/);
      // And the camera does not move when the model is swapped for another frame, scrubbing included.
      await page.click(PAUSE);
      const paused = await camera();
      for (const f of [0, 3, 5, 7]) {
        await setSlider(f);
        await page.waitForFunction((f) => Math.abs(parseFloat(document.querySelector('[data-testid=animation-time]')?.textContent.slice(3)) - f / 8) < 0.01, { timeout: 60000 }, f);
        await new Promise(r => setTimeout(r, 400));
        sameCamera(await camera(), paused);
      }
    }, longTimeout * 2);

    test('a camera the user set is kept by playback and scrubbing', async () => {
      await load(ORBIT, { animation: { steps: 8, fps: 10 } });
      await page.waitForSelector(PLAY, { timeout: 60000 });
      await settle();
      // Zoom in and orbit with the mouse.
      const box = await (await page.$('model-viewer.main-viewer')).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -150 });
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 8 });
      await page.mouse.up();
      await new Promise(r => setTimeout(r, 1200));
      const user = await camera();
      await page.click(PLAY);
      await waitForTime('$t=0.50');
      const samples = await sampleCamera(800);
      // (model-viewer's wheel zoom narrows the field of view too, and the widened limits make it settle up to a degree away from where the zoom left it: radius, target and angles are exact, the field of view is only checked within a few degrees)
      for (const c of samples) { sameCamera({ ...c, fov: user.fov }, user, 0.05); expect(Math.abs(c.fov - samples[0].fov)).toBeLessThan(1); }
      expect(Math.abs(samples[0].fov - user.fov)).toBeLessThan(3);
      await page.click(PAUSE);
      await setSlider(1);
      await page.waitForFunction(() => /^\$t=0\.1[23]$/.test(document.querySelector('[data-testid=animation-time]')?.textContent), { timeout: 60000 });
      await new Promise(r => setTimeout(r, 400));
      const scrubbed = await camera();
      sameCamera({ ...scrubbed, fov: user.fov }, user, 0.05);
      expect(Math.abs(scrubbed.fov - samples[0].fov)).toBeLessThan(1);
    }, longTimeout * 2);
  });
});
