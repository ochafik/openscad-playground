// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

/// <reference lib="webworker" />

/**
 * Web Worker entry point for the asm.js variant of OpenSCAD.
 * This is an optional fallback for environments that don't support WebAssembly.
 *
 * To build the asm.js variant:
 *   make asmjs
 *   npm run build
 *
 * The asm.js variant is ~2-3x larger and ~5-10x slower than WASM,
 * but works in older browsers without WebAssembly support.
 */
import OpenSCAD from "../asmjs/openscad.js";
import { installWorkerHandler } from "./openscad-worker-core.ts";

export type { MergedOutputs } from "./openscad-worker-core.ts";

importScripts("browserfs.min.js");

installWorkerHandler(OpenSCAD);
