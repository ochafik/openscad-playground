// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

/// <reference lib="webworker" />
import UZIP from "uzip";
import { loadOpenSCAD } from "./openscad-loader.ts";
import { RenderEngine, WasmUnavailableError } from "./wasm-support.ts";

import { createEditorFS, symlinkLibraries } from "../fs/filesystem.ts";
import { OpenSCADInvocation, OpenSCADInvocationCallback, OpenSCADInvocationResults } from "./openscad-runner.ts";
import { deployedArchiveNames } from "../fs/zip-archives.ts";
import { fetchSource } from "../utils.ts";

importScripts("browserfs.min.js");

declare const self: DedicatedWorkerGlobalScope;

export type MergedOutputs = {stdout?: string, stderr?: string, error?: string}[];

function callback(payload: OpenSCADInvocationCallback) {
  self.postMessage(payload);
}

// Unpacks each library zip directly into the Emscripten in-memory FS, instead
// of going through BrowserFS's EmscriptenFS bridge. The bridge doesn't run
// under wasm2js — it throws "Cannot read properties of undefined (reading
// 'fs')" because the wasm2js build's FS-node internals are shaped slightly
// differently from the WASM build's. FS.writeFile/mkdir are part of
// EXPORTED_RUNTIME_METHODS in both builds, so this path works uniformly; we
// reach for it for wasm2js, and could swap the WASM path over too in future.
async function unpackArchivesIntoFS(FS: any, archives: string[], root: string) {
  await Promise.all(archives.map(async (name) => {
    const url = `./libraries/${name}.zip`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      console.warn(`[wasm2js] Failed to fetch ${url}:`, e);
      return;
    }
    if (!resp.ok) {
      console.warn(`[wasm2js] Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
      return;
    }
    const buf = await resp.arrayBuffer();
    let files: { [path: string]: Uint8Array };
    try {
      files = UZIP.parse(buf);
    } catch (e) {
      console.warn(`[wasm2js] Failed to parse ${url}:`, e);
      return;
    }
    const archiveRoot = `${root}/${name}`;
    try { FS.mkdir(archiveRoot); } catch (e) { /* already exists */ }
    for (const relPath in files) {
      if (relPath.endsWith('/')) continue; // skip directory entries
      const parts = relPath.split('/');
      let dir = archiveRoot;
      for (let i = 0; i < parts.length - 1; i++) {
        dir += '/' + parts[i];
        try { FS.mkdir(dir); } catch (e) { /* already exists */ }
      }
      FS.writeFile(`${archiveRoot}/${relPath}`, files[relPath]);
    }
  }));
}

self.addEventListener('message', async (e: MessageEvent<OpenSCADInvocation>) => {
  const {
    mountArchives,
    inputs,
    args,
    outputPaths,
    forceEngine,
  } = e.data;

  const mergedOutputs: MergedOutputs = [];
  // Stays undefined until loadOpenSCAD() succeeds, so a failure before then
  // (e.g. WasmUnavailableError) is not mislabelled as the 'wasm' engine.
  let engine: RenderEngine | undefined;
  let instance: any;
  const start = performance.now();
  try {
    // Tries the WebAssembly build first; on any instantiation failure (and
    // unless forced to 'wasm'), falls back to the wasm2js JS build.
    const loaded = await loadOpenSCAD({
      noInitialRun: true,
      'print': (text: string) => {
        console.debug('stdout: ' + text);
        callback({stdout: text})
        mergedOutputs.push({ stdout: text })
      },
      'printErr': (text: string) => {
        console.debug('stderr: ' + text);
        callback({stderr: text})
        mergedOutputs.push({ stderr: text })
      },
    }, forceEngine);
    engine = loaded.engine;
    instance = loaded.instance;

    if (mountArchives) {
      if (engine === 'wasm2js') {
        // See unpackArchivesIntoFS: avoid BrowserFS's bridge, write files
        // straight into the Emscripten FS so libraries + fonts work in
        // compatibility mode too.
        instance.FS.mkdir('/libraries');
        await unpackArchivesIntoFS(instance.FS, deployedArchiveNames, '/libraries');
        await symlinkLibraries(deployedArchiveNames, instance.FS, '/libraries', '/');
      } else {
        // This will mount lots of libraries' ZIP archives under /libraries/<name> -> <name>.zip
        await createEditorFS({prefix: '', allowPersistence: false});

        instance.FS.mkdir('/libraries');

        // https://github.com/emscripten-core/emscripten/issues/10061
        const BFS = new BrowserFS.EmscriptenFS(
          instance.FS,
          instance.PATH ?? {
            join2: (a: string, b: string) => `${a}/${b}`,
            join: (...args: string[]) => args.join('/'),
          },
          instance.ERRNO_CODES ?? {}
        );

        instance.FS.mount(BFS, {root: '/'}, '/libraries');

        await symlinkLibraries(deployedArchiveNames, instance.FS, '/libraries', "/");
      }
    }

    // Fonts are seemingly resolved from $(cwd)/fonts
    instance.FS.chdir("/");

    instance.FS.mkdir('/locale');

    if (inputs) {
      for (const source of inputs) {
        try {
          console.log(`Writing ${source.path}`);
          if (source.content == null && source.path != null && source.url == null) {
            if (!instance.FS.isFile(source.path)) {
              console.error(`File ${source.path} does not exist!`);
            }
          } else {
            instance.FS.writeFile(source.path, await fetchSource(instance.FS, source));
          }
        } catch (e) {
          console.trace(e);
          throw new Error(`Error while trying to write ${source.path}: ${e}`);
        }
      }
    }

    console.log('Invoking OpenSCAD with: ', args)
    let exitCode;
    try {
      exitCode = instance.callMain(args);
    } catch(e){
      if(typeof e === "number" && instance.formatException){
        // The number was a raw C++ exception
        // See https://github.com/emscripten-core/emscripten/pull/16343
        e = instance.formatException(e);
      }
      throw new Error(`OpenSCAD invocation failed: ${e}`);
    }
    const end = performance.now();
    const elapsedMillis = end - start;

    const outputs: [string, string][] = [];
    for (const path of (outputPaths ?? [])) {
      try {
        const content = instance.FS.readFile(path);
        outputs.push([path, content]);
      } catch (e) {
        console.trace(e);
        throw new Error(`Failed to read output file ${path}: ${e}`);
      }
    }
    const result: OpenSCADInvocationResults = {
      outputs,
      mergedOutputs,
      exitCode,
      elapsedMillis,
      engine,
    }

    console.debug(result);
    callback({result});
  } catch (e) {
    const end = performance.now();
    const elapsedMillis = end - start;

    console.trace(e);
    // WasmUnavailableError carries a message meant to be shown to the user;
    // for any other error fall back to its default stringification.
    const error = e instanceof WasmUnavailableError ? e.userMessage : `${e}`;
    mergedOutputs.push({ error });
    callback({
      result: {
        exitCode: undefined,
        error,
        mergedOutputs,
        elapsedMillis,
        engine,
      }
    });
  }
});
