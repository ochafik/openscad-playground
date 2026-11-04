/**
 * Unit tests for animation support: `$t` detection (src/state/animation-detect.ts), the frame cache
 * (animation-cache.ts) and the playback controller (animation.ts) driven by a fake renderer and a fake clock.
 * Run with: npm test.
 */
import assert from "node:assert/strict";
import { projectUsesAnimationTime, stripCommentsAndStrings, usesAnimationTime } from "../src/state/animation-detect.ts";
import { boundsOfVertices, refit, radiusOf, unionBounds, centerOf } from "../src/state/animation-bounds.ts";
import { FrameCache, frameKey, projectKey } from "../src/state/animation-cache.ts";
import {
  AnimationController, animationPoolSize, clampSettings, frameAt, nearestCached, normalizeStoredSettings, SEEK_DEBOUNCE_MS, LOAD_TIMEOUT_MS,
  type AnimationFrame, type AnimationHost, type AnimationSettings, type AnimationTimers,
} from "../src/state/animation.ts";
import { AbortablePromise, SupersededError } from "../src/utils.ts";

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ─── Fake clock ─────────────────────────────────────────────────────────

class FakeClock implements AnimationTimers {
  time = 1000;
  private seq = 0;
  private timers = new Map<number, { at: number; f: () => void }>();
  now() { return this.time; }
  setTimeout(f: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.time + ms, f }); return id; }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  /** Advance the clock, firing due timers in order. */
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].f();
      await flush();
    }
    this.time = end;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// ─── Fake host ──────────────────────────────────────────────────────────

interface TestFrame extends AnimationFrame { t: number; released?: boolean }

function makeHost(clock: FakeClock, settings: AnimationSettings = { steps: 4, fps: 10 }, pool: { size: number, keyframes?: number } = { size: 1 }) {
  const log = {
    rendered: [] as number[], shown: [] as number[], released: [] as number[], published: [] as any[], errors: [] as unknown[],
    killed: 0, busy: false, hidden: false, slots: [] as number[],
  };
  const pending: Array<{ t: number; resolve: () => void; fail: (e: unknown) => void }> = [];
  const host: AnimationHost<TestFrame> = {
    settings: () => settings,
    concurrency: () => pool.size,
    renderFrame: (t, slot) => {
      log.rendered.push(t);
      log.slots.push(slot);
      return AbortablePromise<TestFrame>((resolve, reject) => {
        const entry = { t, resolve: () => resolve({ t, bytes: 10, url: `frame:${t}` }), fail: reject };
        pending.push(entry);
        return () => { log.killed++; pending.splice(pending.indexOf(entry), 1); reject(new SupersededError()); };
      });
    },
    show: (f, i) => log.shown.push(i),
    release: f => log.released.push(f.t),
    busy: () => log.busy,
    hidden: () => log.hidden,
    publish: s => log.published.push(s),
    keyframes: () => pool.keyframes ?? 0,
    error: e => log.errors.push(e),
    lookahead: () => 8,
  };
  /** Complete the oldest pending render. */
  const finish = async (which = 0) => { pending.splice(which, 1)[0].resolve(); await flush(); await clock.advance(0); };
  const finishAll = async () => { while (pending.length) await finish(); };
  return { host, log, pending, finish, finishAll, settings, pool };
}

async function main() {
  console.log("animation tests");

  // ─── Detection ────────────────────────────────────────────────────────
  await test("detects $t as a whole identifier in code", () => {
    assert.ok(usesAnimationTime("rotate([0, 0, $t * 360]) cube(5);"));
    assert.ok(usesAnimationTime("a=$t;"));
    assert.ok(usesAnimationTime("x = sin($t*360);"));
    assert.ok(!usesAnimationTime("cube(5);"));
    assert.ok(!usesAnimationTime("$fn = 32; sphere(3, $fn=12);"));
    assert.ok(!usesAnimationTime("a = $tx + $t2 + $total;"), "other special variables are not $t");
  });
  await test("ignores comments and strings", () => {
    assert.ok(!usesAnimationTime("// animate with $t\ncube(1);"));
    assert.ok(!usesAnimationTime("/* $t\n $t */ cube(1);"));
    assert.ok(!usesAnimationTime('echo("time is $t"); cube(1);'));
    assert.ok(!usesAnimationTime('echo("quote \\" $t"); cube(1);'));
    assert.ok(usesAnimationTime('echo("x"); // c\ncube($t);'), "code after a comment/string still counts");
    assert.ok(usesAnimationTime('/* a */ /* b */ s = "x"; rotate($t);'));
    assert.equal(stripCommentsAndStrings("a/*x\ny*/b").split("\n").length, 2, "newlines are kept");
  });
  await test("follows include/use of project files, not libraries", () => {
    const src = (path: string, content: string) => ({ path, content });
    const sources = [
      src("/main.scad", "include <lib/anim.scad>\nuse </other.scad>\nspin();"),
      src("/lib/anim.scad", "module spin() { rotate($t*360) cube(2); }"),
      src("/other.scad", "module x() {}"),
    ];
    assert.ok(projectUsesAnimationTime(sources, "/main.scad"));
    assert.ok(!projectUsesAnimationTime(sources, "/other.scad"), "only files reachable from the active one");
    assert.ok(!projectUsesAnimationTime([src("/main.scad", "include <MCAD/boxes.scad>\ncube(1);")], "/main.scad"), "unknown (library) files are skipped");
    assert.ok(!projectUsesAnimationTime([src("/main.scad", "// include <lib.scad>\ncube(1);"), src("/lib.scad", "$t")], "/main.scad"), "commented include");
    assert.ok(projectUsesAnimationTime([src("/a/main.scad", "include <../b.scad>"), src("/b.scad", "x=$t;")], "/a/main.scad"), "relative to the including file");
    assert.ok(!projectUsesAnimationTime([{ path: "/model.stl", content: "$t" }], "/model.stl"), "not a .scad");
  });
  await test("include cycles terminate", () => {
    const sources = [{ path: "/a.scad", content: "include <b.scad>" }, { path: "/b.scad", content: "include <a.scad>" }];
    assert.ok(!projectUsesAnimationTime(sources, "/a.scad"));
  });

  // ─── Cache ────────────────────────────────────────────────────────────
  await test("frame cache: LRU by entries and bytes, eviction callback", () => {
    const evicted: string[] = [];
    const cache = new FrameCache<{ bytes: number }>({ maxEntries: 3, maxBytes: 100, onEvict: k => evicted.push(k) });
    cache.set("a", { bytes: 10 }); cache.set("b", { bytes: 10 }); cache.set("c", { bytes: 10 });
    cache.get("a"); // a is now the most recently used
    cache.set("d", { bytes: 10 });
    assert.deepEqual(evicted, ["b"]);
    assert.deepEqual(cache.keys(), ["c", "a", "d"]);
    cache.set("e", { bytes: 95 }); // over the byte budget: evict until it fits
    assert.deepEqual(cache.keys(), ["e"]);
    assert.equal(cache.bytes, 95);
    cache.set("e", { bytes: 5 }); // replacing releases the old value
    assert.equal(evicted.filter(k => k === "e").length, 1);
    assert.equal(cache.bytes, 5);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });
  await test("an oversized frame is still kept (it has to be shown)", () => {
    const cache = new FrameCache<{ bytes: number }>({ maxEntries: 10, maxBytes: 10 });
    cache.set("big", { bytes: 1000 });
    assert.ok(cache.has("big"));
  });
  await test("keys: depend on sources, customizer values, features and t; not on the order of vars", () => {
    const p = { activePath: "/a.scad", sources: [{ path: "/a.scad", content: "cube($t);" }], vars: { x: 1, y: 2 }, features: ["lazy-union"] };
    const k = projectKey(p);
    assert.equal(projectKey({ ...p, vars: { y: 2, x: 1 } }), k);
    assert.notEqual(projectKey({ ...p, vars: { x: 1, y: 3 } }), k);
    assert.notEqual(projectKey({ ...p, sources: [{ path: "/a.scad", content: "cube($t*2);" }] }), k);
    assert.notEqual(projectKey({ ...p, features: [] }), k);
    assert.equal(frameKey(k, 0.5), frameKey(k, 2 / 4));
    assert.notEqual(frameKey(k, 0.5), frameKey(k, 0.25));
  });

  // ─── Settings helpers ─────────────────────────────────────────────────
  await test("settings are clamped; stored ones keep only valid fields", () => {
    assert.deepEqual(clampSettings({ steps: 1000, fps: 0 }), { steps: 360, fps: 1 });
    assert.deepEqual(clampSettings({ steps: 12.4 }), { steps: 12, fps: 15 });
    assert.deepEqual(clampSettings(undefined, { steps: 8, fps: 4 }), { steps: 8, fps: 4 });
    assert.deepEqual(normalizeStoredSettings({ steps: 20, fps: "x" }), { steps: 20 });
    assert.equal(normalizeStoredSettings({ steps: "a" }), undefined);
    assert.equal(normalizeStoredSettings(null), undefined);
  });
  await test("frameAt / nearestCached wrap around the loop", () => {
    assert.equal(frameAt(0.37, 30), 11);
    assert.equal(frameAt(0.999, 30), 0, "rounds up onto the loop start");
    assert.equal(frameAt(-0.1, 10), 9);
    const cached = new Set([0, 7]);
    assert.equal(nearestCached(9, 10, i => cached.has(i)), 0, "forward across the wrap");
    assert.equal(nearestCached(5, 10, i => cached.has(i)), 7);
    assert.equal(nearestCached(3, 10, () => false), undefined);
  });

  // ─── Controller ───────────────────────────────────────────────────────
  const setup = (settings?: AnimationSettings, poolSize = 1, keyframes = 0) => {
    const clock = new FakeClock();
    const h = makeHost(clock, settings, { size: poolSize, keyframes });
    const c = new AnimationController<TestFrame>(h.host, clock);
    c.invalidate("proj");
    return { clock, c, ...h };
  };

  await test("play renders ahead progressively and loops over cached frames at the set fps", async () => {
    const { c, clock, finish, log, pending } = setup();
    c.play();
    await flush();
    assert.deepEqual(log.rendered, [0.25], "renders the frame after the current one first");
    assert.deepEqual(log.shown, [], "nothing to show until it is ready");
    await finish(); // frame 1 ready -> shown, then the look-ahead continues
    assert.deepEqual(log.shown, [1]);
    await clock.advance(1); // the viewer has not reported the load yet: no advance
    c.notifyLoaded();
    await finish(); // frame 2
    await finish(); // frame 3
    await finish(); // frame 0
    assert.equal(pending.length, 0, "all four frames of the loop rendered once");
    assert.deepEqual(log.rendered, [0.25, 0.5, 0.75, 0]);
    // From here on frames are served from the cache, one per 1/fps, each only after the previous one loaded.
    for (let i = 0; i < 6; i++) { await clock.advance(100); c.notifyLoaded(); }
    assert.equal(log.rendered.length, 4, "no re-render in later laps");
    const seq = log.shown;
    for (let i = 1; i < seq.length; i++) assert.equal(seq[i], (seq[i - 1] + 1) % 4, `frame ${seq[i]} follows ${seq[i - 1]}`);
    assert.ok(seq.length >= 6);
    c.dispose();
  });
  await test("playback waits for the viewer's load report (bounded by a timeout), and does not outrun the fps", async () => {
    const { c, clock, finishAll, log } = setup();
    c.play(); await clock.advance(0);
    for (let i = 0; i < 4; i++) await finishAll();
    const n = log.shown.length;
    await clock.advance(500);
    assert.equal(log.shown.length, n, "stuck on the unloaded frame");
    await clock.advance(LOAD_TIMEOUT_MS);
    assert.ok(log.shown.length > n, "the load timeout releases playback");
    c.dispose();
  });
  await test("a changed project invalidates: stops playing, drops frames and kills the render", async () => {
    const { clock, c, finishAll, log, pending } = setup();
    c.play(); await clock.advance(0);
    await finishAll();
    assert.ok(c.cache.size > 0);
    c.invalidate("proj");
    assert.ok(c.isPlaying, "same key: nothing happens");
    c.invalidate("proj2");
    assert.ok(!c.isPlaying);
    assert.equal(c.cache.size, 0);
    assert.equal(log.released.length > 0, true, "frames released");
    assert.equal(pending.length, 0, "in-flight render killed");
    assert.equal(log.published.at(-1).playing, false);
    c.dispose();
  });
  await test("a late frame from an invalidated project is discarded and released", async () => {
    const clock = new FakeClock();
    const h = makeHost(clock);
    const c = new AnimationController<TestFrame>(h.host, clock);
    c.invalidate("a");
    c.play(); await clock.advance(0);
    const entry = h.pending[0];
    c.invalidate("b"); // kills (removes from pending) but the render resolves anyway
    entry.resolve(); await flush();
    assert.equal(c.cache.size, 0);
    c.dispose();
  });
  await test("normal renders have priority: the frame render is killed, and background work resumes afterwards", async () => {
    const { clock, c, log, finish, pending } = setup();
    c.play(); await clock.advance(0);
    assert.equal(pending.length, 1);
    log.busy = true;
    c.yieldToRender();
    assert.equal(pending.length, 0, "killed");
    c.resume();
    assert.equal(pending.length, 0, "does not start while a normal render is busy");
    log.busy = false;
    c.resume();
    await flush();
    assert.equal(pending.length, 1, "restarted once idle");
    await finish();
    c.dispose();
  });
  await test("seek: shows a cached frame at once, otherwise the nearest one while the frame renders (debounced)", async () => {
    const { c, clock, log, finish, finishAll, pending } = setup({ steps: 10, fps: 10 });
    c.seek(3); // nothing cached at all
    assert.deepEqual(log.shown, []);
    assert.equal(pending.length, 0, "debounced");
    await clock.advance(SEEK_DEBOUNCE_MS + 1);
    assert.deepEqual(log.rendered, [0.3]);
    await finish();
    assert.deepEqual(log.shown, [3]);
    // seek far away: the stand-in is the nearest cached frame
    c.seek(5);
    assert.deepEqual(log.shown, [3, 3].slice(0, 1), "same frame url: not shown again");
    c.seek(4); // rapid scrubbing: only the resting position is rendered
    await clock.advance(SEEK_DEBOUNCE_MS + 1);
    assert.deepEqual(log.rendered, [0.3, 0.4]);
    assert.equal(pending.length, 1);
    await finishAll();
    assert.equal(log.shown.at(-1), 4);
    c.seek(3);
    assert.equal(log.shown.at(-1), 3, "cached: immediate");
    assert.equal(c.currentFrame, 3);
    assert.ok(!c.isPlaying);
    c.dispose();
  });
  await test("seeking pauses playback; an obsolete look-ahead render is replaced by the requested frame", async () => {
    const { c, clock, log, pending } = setup({ steps: 10, fps: 10 });
    c.play(); await clock.advance(0);
    assert.deepEqual(log.rendered, [0.1]);
    c.seek(7);
    assert.ok(!c.isPlaying);
    assert.equal(pending.length, 0, "look-ahead killed");
    await clock.advance(SEEK_DEBOUNCE_MS + 1);
    assert.deepEqual(log.rendered, [0.1, 0.7]);
    c.dispose();
  });
  await test("changing the steps keeps the animation time and the cache is shared by equal times", async () => {
    const { c, settings, clock, log, finish } = setup({ steps: 4, fps: 10 });
    c.seek(2); await clock.advance(SEEK_DEBOUNCE_MS + 1); await finish(); // t = 0.5 cached
    const t = c.t;
    settings.steps = 8;
    c.retime(t);
    assert.equal(c.currentFrame, 4);
    assert.equal(log.rendered.length, 1, "t=0.5 was already rendered: no new render");
    c.dispose();
  });
  await test("a render error stops playback and is reported", async () => {
    const { clock, c, pending, log } = setup();
    c.play(); await clock.advance(0);
    pending[0].fail(new Error("boom")); await flush();
    assert.ok(!c.isPlaying);
    assert.equal(log.errors.length, 1);
    c.dispose();
  });
  await test("hidden pages neither advance nor render ahead", async () => {
    const { c, clock, log, pending } = setup();
    log.hidden = true;
    c.play(); await clock.advance(0);
    await clock.advance(2000);
    assert.equal(pending.length, 0);
    assert.deepEqual(log.shown, []);
    c.dispose();
  });
  await test("the cache cap evicts old frames and releases them", async () => {
    const clock = new FakeClock();
    const h = makeHost(clock, { steps: 6, fps: 10 });
    const c = new AnimationController<TestFrame>(h.host, clock, { maxEntries: 3 });
    c.invalidate("p");
    c.play(); await clock.advance(0);
    for (let i = 0; i < 6; i++) { await h.finishAll(); await clock.advance(100); c.notifyLoaded(); }
    assert.ok(c.cache.size <= 3);
    assert.ok(h.log.released.length > 0);
    c.dispose();
  });


  // ─── Frame worker pool ────────────────────────────────────────────────
  await test("pool size: leave a core, cap at 4, one for the JS engine and small devices", () => {
    assert.equal(animationPoolSize({ cores: 16 }), 4);
    assert.equal(animationPoolSize({ cores: 4 }), 3);
    assert.equal(animationPoolSize({ cores: 2 }), 1);
    assert.equal(animationPoolSize({ cores: 1 }), 1);
    assert.equal(animationPoolSize({}), 1);
    assert.equal(animationPoolSize({ cores: 16, slowEngine: true }), 1);
    assert.equal(animationPoolSize({ cores: 16, memoryGb: 2 }), 1);
    assert.equal(animationPoolSize({ cores: 16, memoryGb: 4 }), 2);
    assert.equal(animationPoolSize({ cores: 16, memoryGb: 8 }), 4);
  });
  await test("pool: renders the nearest frames in parallel, each in its own slot, never more than the pool size", async () => {
    const { c, clock, log, pending, finish } = setup({ steps: 10, fps: 10 }, 3);
    c.play(); await flush();
    assert.deepEqual(log.rendered, [0.1, 0.2, 0.3], "next three frames, in order");
    assert.deepEqual(log.slots, [0, 1, 2]);
    await finish(1); // frame 2 completes first: its slot is reused by the next frame
    assert.equal(pending.length, 3);
    assert.deepEqual(log.rendered, [0.1, 0.2, 0.3, 0.4]);
    assert.equal(log.slots[3], 1, "the freed slot is reused");
    assert.deepEqual(log.shown, [], "frame 1 is not ready yet: out-of-order completions are not shown early");
    await finish(0); // frame 1
    assert.deepEqual(log.shown, [1]);
    assert.ok(pending.length <= 3);
    await clock.advance(0);
    c.dispose();
  });
  await test("pool: playback order is kept when frames complete out of order", async () => {
    const { c, clock, log, pending } = setup({ steps: 6, fps: 10 }, 3);
    c.play(); await flush();
    while (pending.length) { pending.pop()!.resolve(); await flush(); await clock.advance(0); } // (newest first)
    for (let i = 0; i < 12; i++) { await clock.advance(100); c.notifyLoaded(); }
    const seq = log.shown;
    assert.ok(seq.length > 3);
    for (let i = 1; i < seq.length; i++) assert.equal(seq[i], (seq[i - 1] + 1) % 6, `frame ${seq[i]} follows ${seq[i - 1]}`);
    c.dispose();
  });
  await test("pool: a scrub kills the look-ahead but keeps its target, an edit kills all", async () => {
    const { c, clock, log, pending } = setup({ steps: 10, fps: 10 }, 3);
    c.play(); await flush();
    assert.equal(pending.length, 3);
    c.seek(7); // pauses: look-ahead renders are dropped, the target is rendered after the debounce
    assert.equal(log.killed, 3);
    await clock.advance(SEEK_DEBOUNCE_MS + 1);
    assert.equal(pending.length, 1);
    assert.equal(log.rendered[log.rendered.length - 1], 0.7);
    c.play(); await flush();
    assert.ok(pending.length > 1 && pending.length <= 3);
    const running = pending.length, before = log.killed;
    c.invalidate("other"); // an edit
    assert.equal(log.killed - before, running);
    assert.equal(pending.length, 0);
    assert.ok(!c.hasInflight);
    c.dispose();
  });
  await test("pool: a normal render yields every running frame and resumes afterwards", async () => {
    const { c, clock, log, pending } = setup({ steps: 10, fps: 10 }, 2);
    c.play(); await flush();
    assert.equal(pending.length, 2);
    log.busy = true; c.yieldToRender();
    assert.equal(pending.length, 0);
    await clock.advance(500);
    assert.equal(pending.length, 0, "no new render while busy");
    log.busy = false; c.resume(); await flush();
    assert.equal(pending.length, 2);
    c.dispose();
  });
  await test("pool: a failing frame stops everything", async () => {
    const { c, log, pending } = setup({ steps: 10, fps: 10 }, 3);
    c.play(); await flush();
    pending[1].fail(new Error("boom")); await flush();
    assert.ok(!c.isPlaying);
    assert.equal(log.errors.length, 1);
    assert.equal(log.killed, 2, "the other renders were killed");
    c.dispose();
  });


  // ─── Key frames (camera framing) ──────────────────────────────────────
  await test("priming: motion starts once the current frame and the key frames are rendered, key frames first", async () => {
    const { c, clock, log, pending, finish } = setup({ steps: 12, fps: 10 }, 2, 4);
    c.play(); await flush();
    assert.deepEqual(log.rendered, [0, 0.25], "current frame and the first key frame");
    assert.ok(log.published.every(p => !p.primed));
    await finish(0); await finish(0);
    assert.deepEqual(log.rendered.slice(2, 4), [0.5, 0.75], "the other key frames");
    assert.deepEqual(log.shown, [], "not moving yet");
    await finish(0);
    assert.deepEqual(log.shown, [], "one key frame missing");
    await finish(0);
    assert.ok(log.published.some(p => p.primed), "primed once all four are there");
    assert.deepEqual(log.shown, [], "primed, but the next frame is still being rendered");
    await finish(0);
    assert.equal(log.shown[0], 1, "then playback starts at the next frame");
    c.dispose();
  });
  await test("priming: is not repeated after a pause, but is after an edit", async () => {
    const { c, clock, log, pending, finishAll } = setup({ steps: 8, fps: 10 }, 2, 4);
    c.play(); await flush();
    await finishAll(); await clock.advance(0); c.notifyLoaded();
    assert.ok(log.published.some(p => p.primed));
    c.pause(); c.play(); await flush();
    await clock.advance(0);
    assert.ok(log.published[log.published.length - 1].primed);
    c.invalidate("other");
    assert.ok(!log.published[log.published.length - 1].primed);
    c.dispose();
  });
  await test("bounds: union, radius and refit (orbiting part)", () => {
    const ring = (angle: number) => {
      const a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      const cube = [15, 23].flatMap(x => [0, 8].flatMap(y => [-0, 8].map(z => ({ x: x * c - y * s, y: x * s + y * c, z }))));
      const sphere = [-6, 6].flatMap(x => [-6, 6].flatMap(y => [-6, 6].map(z => ({ x, y, z }))));
      return boundsOfVertices([...cube, ...sphere])!;
    };
    const b0 = ring(0);
    const u = unionBounds([0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(ring))!;
    assert.ok(u.min[0] < b0.min[0] && u.max[1] > b0.max[1]);
    assert.ok(radiusOf(u) > radiusOf(b0));
    const fit = refit(b0, u)!;
    assert.ok(fit.scale > 1.2 && fit.scale < 3, `scale ${fit.scale}`);
    assert.ok(Math.abs(fit.shift[0] - (centerOf(u)[0] - centerOf(b0)[0])) < 1e-9);
    assert.equal(refit(b0, b0), undefined, "nothing to do when the union is the frame itself");
    assert.equal(boundsOfVertices([]), undefined);
  });

  console.log(`${passed} animation tests passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
