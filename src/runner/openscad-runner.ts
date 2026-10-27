// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { MergedOutputs } from "./openscad-worker-core.ts";
import { AbortablePromise } from "../utils.ts";
import { Source } from "../state/app-state.ts";

export type OpenSCADInvocation = {
  mountArchives: boolean,
  inputs?: Source[],
  args: string[],
  outputPaths?: string[],
}

export type OpenSCADInvocationResults = {
  exitCode?: number,
  error?: string,
  outputs?: [string, string][],
  mergedOutputs: MergedOutputs,
  elapsedMillis: number,
};

export type ProcessStreams = {stderr: string} | {stdout: string}
export type OpenSCADInvocationCallback = {result: OpenSCADInvocationResults} | ProcessStreams;

/**
 * Detect whether WebAssembly is supported in this environment.
 */
function hasWebAssemblySupport(): boolean {
  try {
    return typeof WebAssembly === 'object'
      && typeof WebAssembly.instantiate === 'function';
  } catch {
    return false;
  }
}

/**
 * Check if the asm.js worker bundle exists (was built).
 */
function hasAsmJsWorker(): boolean {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('HEAD', './openscad-worker-asmjs.js', false);
    xhr.send();
    return xhr.status === 200;
  } catch {
    return false;
  }
}

/**
 * Get the appropriate worker URL based on environment capabilities:
 * the WASM worker by default, the asm.js fallback where WebAssembly
 * is unavailable (and the optional asm.js bundle was built).
 */
function getWorkerUrl(): string {
  if (hasWebAssemblySupport()) {
    return './openscad-worker.js';
  }
  if (hasAsmJsWorker()) {
    console.warn('[OpenSCAD] WebAssembly not supported, using asm.js fallback');
    return './openscad-worker-asmjs.js';
  }
  console.error('[OpenSCAD] WebAssembly not supported and asm.js fallback not available');
  return './openscad-worker.js';
}

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
    worker = new Worker(getWorkerUrl());//, { type: 'module' });
    rejection = reject;
    worker.onmessage = (e: MessageEvent<OpenSCADInvocationCallback>) => {
      if ('result' in e.data) {
        resolve(e.data.result);
        terminate();
      } else {
        streamsCallback(e.data);
      }
    }
    worker.postMessage(invocation)
    
    return () => {
      terminate();
    };
  });
}
