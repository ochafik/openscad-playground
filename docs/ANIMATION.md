# Animation (`$t`)

A model that reads OpenSCAD's animation variable `$t` (0 <= `$t` < 1) gets a play/pause button and a time slider, in the
web app's footer, in the embed toolbar (next to Render, with the slider along the bottom of the viewer) and in the MCP
app. Play loops the animation; the slider scrubs it; the gear next to `$t=...` sets the loop (**steps** = frames per loop,
**fps**; the popover also shows the resulting duration).

```scad
rotate([0, 0, $t * 360]) cube([20, 8, 8]);
```

## How it works

- **Detection** (`src/state/animation-detect.ts`): `$t` as a whole identifier (not `$tx`, `$t2`...) in the active file or in
  the project files it `include`s / `use`s (transitively), with comments and string literals ignored. Library files that
  are only mounted from the library archives are not scanned, so a `$t` used only inside a library does not show the
  controls. A false positive (say, a top-level `$t = 0.5;`) just shows controls.
- **Frames**: frame `i` of `steps` is `$t = i / steps`, rendered as a *preview* (`-D '$t=<t>'`, fast, the same render as
  edits trigger) in its own job slot (a small pool of them, see Performance), and converted to GLB for the viewer like any render.
  A normal render (an edit, F5, customizer) also uses the current `$t`, and Render (F6) renders the *current frame* in full.
- **Cache** (`src/state/animation-cache.ts`): LRU keyed by (hash of sources + customizer values + features, `t`), capped at
  240 frames / 96 MB. Frames at equal times are shared when the number of steps changes. Evicted frames release their
  object URLs.
- **Playback** (`src/state/animation.ts`, `AnimationController`, unit tested with a fake clock): while playing, frames are
  rendered ahead of the displayed one, nearest first; playback never advances onto a frame that is not ready, so the
  first lap runs at the render speed and the following laps at the set fps. Playback starts moving once the current
  frame and three frames spread over the loop are rendered (the *key frames*, rendered first; not on the JS engine). The displayed model is swapped only when the next frame is
  ready *and* the viewer reported the previous one loaded; the viewer keeps the old frame on screen meanwhile (no fade,
  no flicker) and skips the per-frame thumbnail.
- **Camera**: model-viewer re-frames and re-centers on every model it loads, which made a moving part look like the whole
  scene was zooming and jumping. While frames swap in the camera is therefore *locked* to explicit numbers (radius,
  target, field of view; nothing left on `auto`), taken just before the first frame swaps in. When playback starts
  moving, the lock is widened **once** to the bounding sphere of the key frames (bounds come from the frames' vertices,
  `animation-bounds.ts`), so an orbiting part is not clipped, and is never touched again while playing or scrubbing. A
  camera the user set (orbit, zoom) is kept as is; a normal render (edit, Render) frames the new model afresh.
  Known small gap: after a mouse-wheel zoom model-viewer reads the field of view back a degree or so off the value the
  zoom left, so that case settles with a one-time ~1-2 degree field-of-view change.
- **Scrubbing** shows the nearest cached frame at once, and renders the requested one on demand once the slider rested
  for 120 ms. Scrubbing pauses.
- **Invalidation and priority**: any change to what frames depend on (source, included files, customizer values,
  features, active file) drops the cache and pauses. Normal renders have priority: the running frame render is killed
  when one starts, background rendering resumes when it ends; Render (F6) also pauses. Nothing is rendered in a hidden tab.
- **JavaScript engine (wasm2js)**: much slower, so the defaults are 8 steps at 4 fps and only the next frame is
  rendered ahead (30 steps at 15 fps otherwise).

## Persistence and the MCP app

- Loop settings changed by the user are part of the share link (`view.animation = {steps, fps}`); playing and the current
  time are not (a link never autoplays).
- The MCP app keeps `{steps, fps, t}` in its view state (survives remounts), reports the animation in `get_viewer_state`
  and, only while the model animates, in the model-context update (`Animation: $t=0.37 (frame 12 of 30, 15 fps, playing)`);
  the context is refreshed on play/pause and when a frame settles, not on every frame.
- Tool: `set_view_options` takes `animation: {playing?, t?, steps?, fps?}`. `t` pauses and returns once that frame is
  displayed, so a following `screenshot` shows it.

Limits: all frames of a loop that does not fit the cache are re-rendered on every lap (still correct, just slower); the
camera is framed on the key frames, so a part that leaves their bounds between them can still be clipped.

## Performance

Frames are independent OpenSCAD runs: **OpenSCAD's geometry cache is not shared between frames.** Each frame needs a
fresh worker (an Emscripten module cannot run twice) and the cache lives in the process, so nothing survives; and
several `$t` values cannot be rendered into separate outputs by one invocation (one run, one output file; a wrapper
`.scad` that lays all frames out as one model would give one mesh, not N frames, and would re-evaluate every part
anyway as `$t` changes the arguments). Sharing geometry would need a persistent engine instance that can render
repeatedly (a build change, see below), so it is not attempted here. What is per frame, measured in headless Chrome on an
18-core Apple machine with a local server, 30 steps, preview mode (ms per frame, one worker; `[anim-perf]` console lines
carry the breakdown, `OpenSCADTimings` in `openscad-runner.ts`):

| model | worker boot | engine instantiate | archives mount | OpenSCAD (parse + eval + render + export) | OFF to GLB + data URL | frame total |
|---|---|---|---|---|---|---|
| `rotate($t*360) cube` | 38 | 10 | 0 | 4 | 1 | 53 |
| difference / minkowski + 1 moving cube | 41 | 9 | 0 | 83 | 4 | 135 |
| BOSL2 `include` + 1 moving part | 41 | 10 | 6 | 378 | 2 | 436 |
| same, `include <BOSL2/std.scad>; cube(1);` only | 40 | 10 | 6 | 190 | 1 | 212 |
| `text()` + `linear_extrude` | 40 | 10 | 10 | 192 | 1 | 253 |

First lap (30 frames rendered, from pressing Play), before and after:

| model | sequential, cold workers (before) | + next worker pre-booted | + pool of 4 (default here, min(4, cores-1)) |
|---|---|---|---|
| cube | 1.9 s | 1.1 s | 0.53 s |
| CSG | 4.7 s | 3.3 s | 1.1 s |
| BOSL2 | 14.4 s | 12.8 s | 3.75 s |
| text | 8.3 s | 6.9 s | 2.1 s |

What the data says:

- OpenSCAD's own run dominates (parse of the libraries is half of the BOSL2 frame; the static part is re-evaluated each
  frame). Worker boot (~40 ms) matters only for trivial models.
- **Parallel workers** are the big win (about 3x with 4); each is a separate engine instance (tens of MB), so the pool is
  `min(4, cores - 1)`, 2 on devices reporting <= 4 GB, 1 on <= 2 GB and on the JS engine (wasm2js). `?animationWorkers=N`
  overrides it. Normal renders keep priority: every frame render is killed when one starts, as before; each pool slot
  has its own supersede slot (`renderAnimationFrameInSlot`).
- **Pre-booting** the next worker moves its ~40 ms start-up off the critical path (`warmNext`; idle ones are dropped after
  15 s).
- **Archives**: mounting is 0-12 ms with a warm HTTP cache (the zips are fetched through the browser cache, BrowserFS reads
  them lazily), so caching unzipped trees across frames would save nothing measurable; not done. On a cold network the first
  frame pays the download once for all workers.
- **Export format**: preview frames already use OFF (cheaper than STL) and the OFF to GLB conversion is 1-8 ms; per-frame
  thumbnails are already skipped. Nothing left to trim there.
- **Order**: playback cannot show a frame it has not got, so rendering the lap sequentially from the current frame is the
  fastest way to the first visible lap; the key frames are rendered first only to frame the camera, at the cost of up to
  one extra render before motion starts.
- Not verified here: real GPUs (the viewer was software rendered in headless Chrome, so viewer-side per-frame cost is
  unmeasured), Safari / Firefox, low-core and low-memory phones (the pool heuristic is untested there), memory growth with
  4 engines on very large models.

