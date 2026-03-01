// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { MergedOutputs } from "./openscad-worker-core.ts";
import { AbortablePromise } from "../utils.ts";
import { Source } from "../state/app-state.ts";
import { resolveUrl } from "../resource-loader.ts";

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
    xhr.open('HEAD', resolveUrl('./openscad-worker-asmjs.js'), false);
    xhr.send();
    return xhr.status === 200;
  } catch {
    return false;
  }
}

/**
 * Get the appropriate worker URL based on environment capabilities.
 * Resolves against the base URL for MCP mode (where assets are on CDN).
 */
function getWorkerUrl(): string {
  if (hasWebAssemblySupport()) {
    return resolveUrl('./openscad-worker.js');
  }
  if (hasAsmJsWorker()) {
    console.warn('[OpenSCAD] WebAssembly not supported, using asm.js fallback');
    return resolveUrl('./openscad-worker-asmjs.js');
  }
  console.error('[OpenSCAD] WebAssembly not supported and asm.js fallback not available');
  return resolveUrl('./openscad-worker.js');
}

/**
 * Create a Worker, handling cross-origin URLs (e.g. MCP sandbox at localhost:8081
 * loading worker from localhost:9100). Uses a blob URL wrapper with importScripts()
 * and overrides self.location so the worker's webpack runtime derives the correct
 * publicPath for loading WASM and other assets.
 */
function createWorker(url: string): Worker {
  try {
    const workerOrigin = new URL(url).origin;
    if (workerOrigin === location.origin) {
      return new Worker(url);
    }
  } catch {
    return new Worker(url);
  }

  // Cross-origin: create a blob wrapper that uses importScripts (allowed cross-origin
  // in classic workers) and overrides self.location so webpack's auto-detected
  // publicPath resolves to the correct origin.
  // Also override importScripts so that relative URLs (e.g. 'browserfs.min.js')
  // resolve against the worker's intended base URL, not the opaque blob: URL.
  const workerBase = new URL('./', url).href;
  const blob = new Blob([
    `Object.defineProperty(self, 'location', {\n` +
    `  value: new URL(${JSON.stringify(url)}),\n` +
    `  writable: false, configurable: true\n` +
    `});\n` +
    `(function() {\n` +
    `  var _base = ${JSON.stringify(workerBase)};\n` +
    `  function resolveUrl(u) {\n` +
    `    try { new URL(u); return u; } catch(e) {}\n` +
    `    return new URL(u, _base).href;\n` +
    `  }\n` +
    `  var _importScripts = self.importScripts.bind(self);\n` +
    `  self.importScripts = function() {\n` +
    `    return _importScripts.apply(self, Array.prototype.map.call(arguments, resolveUrl));\n` +
    `  };\n` +
    `  var _fetch = self.fetch.bind(self);\n` +
    `  self.fetch = function(resource, init) {\n` +
    `    if (typeof resource === 'string') resource = resolveUrl(resource);\n` +
    `    return _fetch(resource, init);\n` +
    `  };\n` +
    `})();\n` +
    `importScripts(${JSON.stringify(url)});\n`
  ], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
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
    const workerUrl = getWorkerUrl();
    worker = createWorker(workerUrl);
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
