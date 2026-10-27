// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

/// <reference lib="webworker" />

/**
 * Web Worker entry point for the asm.js variant of OpenSCAD.
 * This is an optional fallback for environments that don't support WebAssembly.
 *
 * To enable it, place (or symlink) an asm.js build of OpenSCAD at
 * src/asmjs/openscad.js, then run `npm run build` — webpack detects the file
 * and emits openscad-worker-asmjs.js alongside the regular WASM worker, and
 * the runner falls back to it at runtime when WebAssembly is unavailable.
 *
 * The asm.js variant is ~2-3x larger and ~5-10x slower than WASM,
 * but works in older browsers without WebAssembly support.
 */
// @ts-ignore — optional build artifact: present only when an asm.js build
// of OpenSCAD has been placed at src/asmjs/openscad.js (webpack only builds
// this worker in that case).
import OpenSCAD from "../asmjs/openscad.js";
import { installWorkerHandler } from "./openscad-worker-core.ts";

export type { MergedOutputs } from "./openscad-worker-core.ts";

importScripts("browserfs.min.js");

installWorkerHandler(OpenSCAD);
