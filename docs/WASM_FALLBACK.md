# WebAssembly &amp; the JavaScript (wasm2js) fallback

The OpenSCAD playground runs OpenSCAD itself as a WebAssembly module. On a small
but real set of devices WebAssembly is **disabled**, and the playground used to
fail opaquely there. This document explains the problem, what is and is not
possible, and the fallback that the playground now implements.

## TL;DR

- **Classic asm.js is gone.** Emscripten removed it in 2.0 (Aug 2020). The
  modern equivalent of a "JavaScript fallback" is **wasm2js** — a Binaryen pass
  that translates the linked `.wasm` into plain JavaScript.
- **Emscripten *can* dual-target** (`-sWASM=2` emits both a `.wasm` and a
  `.wasm.js`), **but the automatic fallback is not free for this app.** The
  auto-detection ships only in Emscripten's generated **HTML shell**; the
  playground loads the `MODULARIZE`/`EXPORT_ES6` glue itself inside a Web
  Worker, so it must do the detection and routing in app code. It now does.
- The playground **detects WebAssembly at runtime** and, when it is disabled,
  loads an optional pure-JavaScript build (`openscad.fallback.js`) instead.
  If that build is not deployed, it shows a clear message instead of crashing.
- The fallback build is **large (~25–35 MB of JS) and several times slower**
  than WebAssembly. It is therefore an *optional, separately-built artifact*,
  not part of the default deployment.

## Why is WebAssembly ever unavailable?

| Cause | What happens | Does the JS fallback help? |
|---|---|---|
| **iOS/macOS Lockdown Mode** | WebAssembly *and* the JIT are disabled. | Runs, but interpreted-only — slow. "Usable" for small models at best. |
| **Strict CSP** (no `wasm-unsafe-eval`) | WASM compilation throws; plain JS still runs. | **Yes — best case.** wasm2js is ordinary JS (no `eval`), so it passes. |
| **Enterprise / MDM / hardened browsers** | WASM blocked by policy; JS+JIT usually fine. | **Yes**, at the normal ~2–5× wasm2js penalty. |
| **Very old browsers** | No `WebAssembly` global at all. | Mechanically yes; in practice this audience is ~0% and the SPA won't load anyway. |

## What the playground implements

Runtime detection + a pluggable loader, entirely in app code:

| Piece | File | Role |
|---|---|---|
| Capability probe | `src/runner/wasm-support.ts` | `detectWasmSupport()` synchronously compiles an 8-byte module; `probeRenderEngine()` resolves `wasm` / `wasm2js` / `none`. |
| Engine loader | `src/runner/openscad-loader.ts` | In the worker: uses the WASM build, or `importScripts()`-loads `openscad.fallback.js` when WASM is unavailable. |
| Worker wiring | `src/runner/openscad-worker.ts` | Calls the loader; reports the `engine` used and a `wasmFallbackUnavailable` flag. |
| UI notice | `src/components/WasmStatusBanner.tsx` | Shows "compatibility mode" (wasm2js) or "rendering unavailable" (none). Renders nothing when WASM works. |
| Build wiring | `Makefile`, `webpack.config.js` | `WASM_FALLBACK_BUILD_URL` fetches the artifact into `public/`; it is excluded from the service-worker precache. |

The fallback file `openscad.fallback.js` is served next to the app, so the
worker's `importScripts('openscad.fallback.js')` and the page's `fetch()` probe
resolve to the same URL. When it is absent, everything still builds and runs —
WASM users are unaffected and non-WASM users get the explanatory banner.

**Testing:** append `?wasmEngine=wasm2js` to the playground URL to force the JS
fallback path on a WASM-capable browser (or `?wasmEngine=wasm` to force the
normal build) — the easiest way to exercise the fallback without disabling
WebAssembly. With no `openscad.fallback.js` deployed, `?wasmEngine=wasm2js`
exercises the graceful "rendering unavailable" path instead.

## Producing the `openscad.fallback.js` artifact

OpenSCAD's WebAssembly build is **not** part of this repo — it is produced by
OpenSCAD's CI from `openscad/openscad` (link flags) using the dependency images
from `openscad/openscad-wasm`. A wasm2js build is the same build re-linked with
`-sWASM=0`. The existing `openscad.wasm` **cannot** be converted in place — the
WASM=1 glue and the wasm2js ABI differ; the JS must be produced at link time.

### Option A — `make wasm-fallback` (Docker)

```sh
make wasm-fallback        # runs scripts/build-wasm-fallback.sh
npm run build             # picks up public/openscad.fallback.js
```

This clones OpenSCAD, builds it inside the published `openscad/wasm-base-release`
dependency image, and writes `public/openscad.fallback.js`. It is a heavy build
(CGAL/Boost/GMP); expect tens of minutes and several GB.

### Option B — host it and point the build at it

```sh
WASM_FALLBACK_BUILD_URL=https://example.com/openscad.fallback.js make public
npm run build
```

### The link flags that matter

Relative to OpenSCAD's normal `web` Emscripten build:

| Flag | Normal build | Fallback build | Why |
|---|---|---|---|
| `-sWASM` | `1` (default) | `0` | Emit wasm2js (pure JS) instead of WebAssembly. |
| `-sSINGLE_FILE` | unset | `1` | One self-contained `.js`; no `.wasm` / `.mem` sidecar. |
| `-sWASM_BIGINT` | on (emcc 4.x default) | `0` | wasm2js rejects `WASM_BIGINT` at link time. |
| `-sEXPORT_ES6` | `1` | `0` | A classic script (global `OpenSCAD` factory) can be `importScripts()`-loaded in the worker. |
| `-sMODULARIZE` / `-sEXPORT_NAME` | `1` / `OpenSCAD` | same, pinned explicitly | The loader reads `self.OpenSCAD`; the recipe pins these rather than inheriting them. |
| `-sMAXIMUM_MEMORY` | `4GB` | `2GB` | wasm2js cannot use a >2 GB address space. |
| `-sABORT_ON_WASM_EXCEPTIONS` | set | dropped | Meaningless with no `.wasm`. |
| `-fexceptions` / `-fwasm-exceptions` | `-fexceptions` | `-fexceptions` (any `-fwasm-exceptions` rewritten) | JS-based exceptions survive wasm2js; native wasm exception handling does not. |
| `-sSUPPORT_LONGJMP` | wasm-based | `emscripten` | Pinned to JS-based `setjmp`/`longjmp` so no `WebAssembly.Tag` is needed. |
| threads | single-threaded | unchanged | OpenSCAD's WASM build is already single-threaded — required for wasm2js. |

`scripts/build-wasm-fallback.sh` applies exactly these. See that script for the
authoritative recipe.

## Trade-offs &amp; caveats

- **Size:** the wasm2js JS is roughly 1.5–3× the gzipped `.wasm` — on the order
  of 25–35 MB uncompressed. It is excluded from the service-worker precache and
  fetched only on demand, so WASM users never download it.
- **Speed:** typically ~2–5× slower than WebAssembly where a JIT is available;
  far slower under iOS Lockdown Mode (interpreter only). Complex models may take
  a long time. The UI warns the user.
- **Maintenance:** the fallback is a *separate build configuration* and must be
  rebuilt and re-hosted alongside each OpenSCAD WASM bump. It is intentionally
  optional — ship it only if WASM-disabled environments are part of your
  audience.

## References

- Emscripten Settings Reference — `WASM`, `WASM_BIGINT`:
  https://emscripten.org/docs/tools_reference/settings_reference.html
- Emscripten — Building to WebAssembly (`WASM=0`):
  https://emscripten.org/docs/compiling/WebAssembly.html
- V8 blog — Emscripten and the LLVM WebAssembly backend (asm.js removal,
  wasm2js): https://v8.dev/blog/emscripten-llvm-wasm
- emscripten#11357 — WASM=2 auto-fallback lives in the HTML shell only:
  https://github.com/emscripten-core/emscripten/issues/11357
- openscad-wasm — upstream WASM build:
  https://github.com/openscad/openscad-wasm
