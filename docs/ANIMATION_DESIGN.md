# Animation: two ideas evaluated (spike)

Branch `spike/animated-glb` (based on `feat/animation`). Prototype code is in `spike-tools/` (benchmarks and browser
harnesses, run with Node 24 + the shipped `src/wasm/openscad.{js,wasm}` and the vendored `public/model-viewer.min.js`
= model-viewer 3.3.3) and `src/io/export_glb_animated.ts`. Nothing is wired into the app. All numbers: Apple M5 Max,
Chrome (real Metal GPU) / Node 24, wasm build, `--backend=manifold`, preview (`$preview=true`), single run each (no
repetitions, so treat as +-10-20%).

## Summary / recommendation

| | verdict |
|---|---|
| **A. one OpenSCAD instance, many outputs** | **Yes, but via a single `--animate N` invocation, not repeated `callMain`.** Repeated `callMain` is impossible with the shipped build (and with any sane flag change). `--animate` works with `off`/`svg`, shares OpenSCAD's geometry cache and parsed sources across frames, and gave 1.3x (everything depends on `$t`) to 4.7x (heavy static part) less engine time for 30 frames. Frames can be streamed out as they finish. Main risk: wasm heap grows ~0.1-12 MB per frame (needs a budget and a fallback to the per-frame path). |
| **B. one animated GLB** | **Yes, as the *download* (cheap, validated, ~0.5 day) and as optional *native playback of a completed loop*. Not as the first-lap/progressive mechanism.** Native playback is exact, loops, scrubs in one frame, and the camera framing is stable. Cost: all N frames live on the GPU at once, ~N x vertex work, and incremental rebuilds while rendering re-zoom the camera and reset the clip time. |
| Both | Recommended order: A (biggest win), B-download, then B-playback behind a triangle budget. ~1 week total, see the sketch. |

## A. Keeping OpenSCAD alive

### What the shipped build does (tested: `spike-tools/multi-callmain.mjs`, `exc.mjs`)

The glue (`src/wasm/openscad.js`) is `MODULARIZE` with `callMain` exported, `noInitialRun` honoured, `ALLOW_MEMORY_GROWTH`
on (heap grew to 3.2 GB in one test), no `EXIT_RUNTIME`. `callMain` ends with `exitJS(ret, true)`:

* **Default:** the first `callMain` works; every later call throws `program has already aborted!` (`ABORT=true` after
  the implicit `exitRuntime`). Nothing is rendered.
* **With `Module.noExitRuntime = true`** (no rebuild needed): the second call is not aborted, but runs ~620 ms, grows the
  heap to 3.2 GB and throws a raw C++ `std::bad_alloc` (decoded by reading the exception's typeinfo in wasm memory; the
  glue has no `getExceptionMessage`). No output. Same for calls 3, 4. So OpenSCAD's `main()` is not re-entrant: it
  tears down `Builtins::instance(true)` at the end, keeps globals (`commandline_commands += ...`, `parser_init` once,
  `chdir`) and does not reset them (`src/openscad.cc` at the pinned `b38f688`, read via the web, not built locally).
  I did not pin down which global produces the bad allocation. Making it re-entrant would mean patching OpenSCAD's
  `main` (a fork) and rebuilding via `openscad/wasm-base-release` (see `scripts/build-wasm-fallback.sh`), which is
  not a build-flag change. Not worth it, see below.

### What does work: one invocation, many frames (`animate-flag.mjs`, `progressive.mjs`, `tcheck.mjs`, `bench.mjs`)

`openscad in.scad --animate N -o out.off --backend=manifold --export-format=off` writes `out00000.off ... out{N-1}.off`
in one process (OpenSCAD's `--animate` is documented for images, but the code just inserts a 5-digit frame number
before the extension, so any format works; confirmed for `off` and `svg`, also on the wasm2js `openscad.fallback.js`).

* **Identical output:** frames 0, 3, 7 of 8 are byte-identical to `-D'$t=i/8'` runs, so frame `i` = `$t = i/N` exactly
  as the app computes it today.
* **State is shared across frames:** `Geometries in cache` goes 88, 90, 92, ... and frame 0 of the heavy model takes
  1.5 s while later frames take 0.2-0.3 s. The source is parsed once.
* **Progressive output:** wrapping `instance.FS.close` (the glue has no `FS.trackingDelegate`) fires when each
  `outNNNNN.off` is closed, i.e. while `callMain` is still running, so the worker can read it and `postMessage` it
  immediately (4 frames of the heavy model were observed at 1.68/1.91/2.16/2.38 s after start). The worker is blocked
  but `postMessage` does not need it to be free. (Not tested inside an actual Worker, only the hook in Node.)

Engine-only benchmark, N = 30 (Node, wasm module compiled once; "per-frame" = what the app does today, a fresh
instance per frame with `-D$t`; includes instantiation but NOT worker spawn, library mounting, OFF->GLB, data URLs, so
real-world savings should be at least this):

| model (tris/frame) | per-frame fresh instances | one `--animate 30` | speed-up | frame 1 / median later frame |
|---|---|---|---|---|
| light (1k) | 619 ms | 381 ms | 1.6x | 12 / 12 ms |
| medium, static plate + moving ball (4k) | 2186 ms | 1408 ms | 1.6x | 121 / 38 ms |
| heavy, static 41-sphere CSG + moving cube (35k) | 41 963 ms | 8 859 ms | **4.7x** | 1160 / 249 ms |
| everything depends on `$t` (twisted extrude) (0.7k) | 2666 ms | 2090 ms | 1.3x | 17 / 65 ms |

(Only subtrees that are identical between frames hit the cache; the root union with the moving part is recomputed every
frame, which is the 249 ms floor in the heavy case.)

### Risks / limits of A

1. **Memory.** OpenSCAD keeps per-frame geometry (cache + polyhedra), wasm memory never shrinks: heavy model (35k tris):
   1 frame 69 MB, 30 frames 429 MB, 90 frames 1.1 GB (~12 MB/frame, ~340 B/tri); medium (4k tris) 120 frames 120 MB
   (0.7 MB/frame); light (1k) 120 frames 28 MB. Unlinking the OFF files from MEMFS does not help. Needs a budget
   (first frame's triangle count x N, e.g. <= 300 MB), else fall back to per-frame workers (or chunks of fresh
   instances: there is no start-frame option, so chunking would need a `$t` remap in the source, not attractive).
2. **Failure:** on the first frame that errors (`assert($t < .5)` test) OpenSCAD returns 1 and stops: frames after it
   are not produced. The per-frame path can still render the others, the batch cannot. Keep per-frame for the
   on-demand scrub and as the error fallback.
3. **Cancellation/priority** still means killing the worker (loses the cache); a normal render started meanwhile
   kills it as today. All frames come from one job slot, so the controller's "render ahead, one at a time" logic
   becomes "one producer, frames pushed".
4. Frame count is fixed for the invocation; changing `steps` restarts it (today partial reuse of equal `t` is possible).
5. Log output of N frames is interleaved in one stream (needs per-frame separation if per-frame logs are shown).

### Implementation sketch (A), ~2-3 days
* `OpenSCADInvocation` gets `animate?: {frames: number, outputStem: string}`; `runInvocation` adds
  `--animate N`, wraps `FS.close` and posts `{frame: {index, bytes}}` messages (transfer the buffer), then the usual result.
* `renderAnimationFrame` -> `renderAnimationBatch(args, onFrame)`; `Model.renderFrameJob` consumers: the controller
  gets frames pushed instead of calling `renderFrame(t)` repeatedly (keep `renderFrame` for scrub-on-demand/fallback).
* Budget + fallback; jest for the controller with a fake batch producer; e2e with a heavy-static example.
* wasm2js: works (tested `--animate 4`, 279 ms); keep its small defaults.

## B. One animated GLB

### Technique (prototype: `src/io/export_glb_animated.ts`, 130 lines)

One node per frame (`frame_0000...`), meshes de-duplicated by hash (periodic animations share a mesh), one animation
with a STEP-interpolated `scale` channel per node: `[0 -> 0, i/fps -> 1, (i+1)/fps -> 0]` (+ one key at `N/fps` so
the clip duration is exactly `N/fps`). Only core glTF 2.0 + the `KHR_lights_punctual` the static GLBs already carry.
Option `restPose`: `'first'` (only frame 0 has scale 1) or `'all'` (all scale 1).

`KHR_node_visibility`/`KHR_animation_pointer` would be cleaner (hidden nodes would not be drawn) but the vendored
model-viewer's three.js (r163) has no support for them (no `KHR_animation_pointer`/`node_visibility` in the bundle);
not used.

### Verified
* **gltf-validator** (npm, installed outside the repo): 0 errors / 0 warnings / 0 infos on 5 GLBs (light 30/120, medium 60,
  dynamic 60, heavy 30). (It caught a real bug in my first version: samplers not attached to the animation.)
* **three.js r170 `GLTFLoader` + `AnimationMixer`** (not model-viewer; `spike-tools/three-check.mjs`): at the middle of
  every frame interval exactly that frame has non-zero scale, 0 mismatches for 30/60 frames, correct after a loop wrap.
* **Real `<model-viewer>` 3.3.3** (`viewer-test.mjs`): `availableAnimations = ['frames']`, `duration = N/fps` exactly (2 s,
  4 s), `currentTime` scrubbing shows the right frame (screenshots of a rotating cube), `play()` loops
  (wraps = expected over 2 loops, `maxT` = duration), rAF at 60 fps with up to 30 heavy frames loaded.
* **Framing:** model-viewer computes the bounding box once at load (unchanged during playback: the dimensions were
  identical before and after playing). With `restPose:'first'` it is frame 0's box (the rotating cube leaves the view,
  clipped in a screenshot); with `'all'` it is the **union of all frames** (43 x 15 x 43 vs 25 x 15 x 13 for the test
  model): stable framing, no re-zoom, no camera lock needed. The first rendered image with `'all'` is frame 0 only (no
  overlapped frames flash, with or without `autoplay`). So: use `'all'` for the in-app GLB and `'first'` for the
  download (viewers that ignore animations then show a poster frame).

### Cost (heap = `performance.memory` delta after `load`, includes three.js CPU copies)

| model | frames @ fps | GLB size | build time | load in viewer | JS heap delta |
|---|---|---|---|---|---|
| light | 30 @ 15 | 0.56 MB | 17 ms | 56 ms | 5 MB |
| light | 120 @ 30 | 2.2 MB | 43 ms | 450 ms (cold) | 14 MB |
| medium (4k tris) | 60 @ 15 | 5.8 MB | 69 ms | 175 ms | 29 MB |
| twisted extrude | 60 @ 30 | 8.5 MB | 97 ms | 92 ms | 40 MB |
| heavy (35k tris) | 30 @ 15 | 19.7 MB | 209 ms | 151 ms | 83 MB |

GLB size ~ sum of the single-frame GLBs (static parts are duplicated per frame: the CSG result is a single mesh, there
is nothing to share). GPU memory ~ same as the GLB payload (positions + indices, ~0.63 MB/frame for 35k tris), all
resident at once; 120 heavy frames would be ~75 MB GPU and ~330 MB JS heap (extrapolated, not run).
Hidden frames have scale 0 but are still submitted to the GPU (N x vertex work per frame); I could not measure that
cost (no GPU timers; the M5 Max holds 60 fps with 30 x 35k tris, which says nothing about phones/integrated GPUs).

### Compared with the current per-frame `src` swap (heavy frames, 35k tris, same page, `latency-test.mjs`)

| | per-frame swap | animated GLB |
|---|---|---|
| scrub / advance latency | 67 ms (src set -> load -> 2 rAF) (= ~34 ms over the 33 ms floor, so 30 fps playback of heavy frames is not reachable; 15 fps is) | 33 ms (= the 2-rAF floor), exact timing from the animation clock, no per-frame handshake |
| smoothness | depends on load events, keeps previous frame to avoid flicker | native, constant rate |
| first lap / progressive | yes, each frame usable as soon as rendered | only after the last frame, or by re-assembling: see below |
| camera | re-frames per frame, needs `applyCameraLock` | fixed union bounds, no lock |
| memory | one frame on the GPU; N blobs/data URLs in JS (cache cap 96 MB) | N frames on the GPU and in the viewer's JS heap (+ the GLB blob) |
| export value | none | one file, plays in any glTF viewer that plays animations |

### Incremental rebuilds during the first lap (`swap-test.mjs`)
Re-assembling `part-5 -> part-10 -> part-20 -> part-30` and swapping `src` (30-ish ms load each, model-viewer keeps the
old model until the new one is loaded): user orbit angles are kept, **but** (1) the clip time resets to ~0.03 s (must be
restored with `currentTime` after `load`, a 1-frame jump is possible), (2) the orbit radius re-frames as the union bounds
grow (51.9 -> 62.6 -> 71.9 -> 70.5), so a camera lock is still needed, (3) a partial clip loops at its own end, so the
controller still has to implement "do not run past the last ready frame". I did not check pixel-level flicker during the
swap (no `model-visibility` events fired; only API state was recorded). Net: not worth it for progressive display.
Use per-frame swap (already built) for the first lap, then switch to the assembled GLB when the loop is complete.

### Value as a download
Validates cleanly and plays in three.js and model-viewer. **Not verified:** Blender (not installed here; its glTF importer
does import node TRS animation channels and STEP interpolation as far as I know), Windows 3D Viewer, macOS Quick Look,
Sketchfab, `<model-viewer>` newer than 3.3.3. Viewers without animation support show `restPose` frame 0 only (the reason for
`'first'` in downloads). 120 heavy frames would be a ~75 MB file; consider a frame/size cap or a "decimate frames" option.

### Implementation sketch (B), ~0.5 day (download) + ~2 days (native playback)
* Download: "Download animated GLB" next to the existing GLB export, enabled when all N frames are cached
  (`parseOff` each cached OFF, `exportAnimatedGlb(frames, {fps, restPose:'first'})`, ~0.1-0.3 s, do it in a worker for big loops).
* Native playback: add a second player behind the `AnimationHost` interface: set `src` to the assembled GLB once all
  frames are ready (`restPose:'all'`), set `animation-name`, drive play/pause/slider through `mv.play/pause/currentTime`,
  restore `currentTime` after load. Triangle budget (e.g. total tris <= 1-2 M and GLB <= 64 MB), otherwise stay on per-frame swap.
  Keep per-frame blobs only if scrub-before-complete is needed; drop them after assembly to avoid doubling memory.

## Could not verify
* Real-browser worker behaviour of A (hook + `postMessage` while `callMain` runs): only the Node hook was run.
* Gain on library-heavy models (BOSL2 etc.): expected larger (parse + mount once) but not measured.
* GPU cost of hidden-by-scale frames on weak GPUs; wasm heap ceiling in mobile browsers.
* Blender/QuickLook/other viewers; why exactly the second `callMain` hits `bad_alloc` (OpenSCAD global state).
* Pixel-level flicker during `src` swap of rebuilt GLBs; single measurements without repetition.
* I did not touch the production code paths (the one change is exporting `getGeom`/`createPrimitive` from `export_glb.ts`).
