// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { MergedOutputs } from "./openscad-worker.ts";
import { AbortablePromise } from "../utils.ts";
import { Source } from "../state/app-state.ts";
import { getForcedEngine, type RenderEngine } from "./wasm-support.ts";

export type OpenSCADInvocation = {
  mountArchives: boolean,
  inputs?: Source[],
  args: string[],
  outputPaths?: string[],
  // Testing override: pin the engine instead of auto-detecting (see ?wasmEngine).
  forceEngine?: RenderEngine,
}

export type OpenSCADInvocationResults = {
  exitCode?: number,
  error?: string,
  outputs?: [string, string][],
  mergedOutputs: MergedOutputs,
  elapsedMillis: number,
  // Which engine ran this invocation (the WASM build or the wasm2js fallback);
  // undefined if the invocation failed before an engine could be loaded.
  engine?: RenderEngine,
};

export type ProcessStreams = {stderr: string} | {stdout: string}
export type OpenSCADInvocationCallback = {result: OpenSCADInvocationResults} | ProcessStreams;

export function spawnOpenSCAD(
  invocation: OpenSCADInvocation, 
  streamsCallback: (ps: ProcessStreams) => void
): AbortablePromise<OpenSCADInvocationResults> {
  let worker: Worker | null;
  let rejection: (err: any) => void;

  function terminate() {
    if (!worker) {
      return;
    }
    worker.terminate();
    worker = null;
  }
    
  return AbortablePromise<OpenSCADInvocationResults>((resolve: (result: OpenSCADInvocationResults) => void, reject: (error: any) => void) => {
    worker = new Worker('./openscad-worker.js');//, { type: 'module' });
    rejection = reject;
    worker.onmessage = (e: MessageEvent<OpenSCADInvocationCallback>) => {
      if ('result' in e.data) {
        resolve(e.data.result);
        terminate();
      } else {
        streamsCallback(e.data);
      }
    }
    // Forward the optional ?wasmEngine= testing override to the worker (its own
    // location has no query string, so it cannot read the parameter itself).
    worker.postMessage({ ...invocation, forceEngine: invocation.forceEngine ?? getForcedEngine() })
    
    return () => {
      terminate();
    };
  });
}
