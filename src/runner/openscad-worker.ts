// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import OpenSCAD from "../wasm/openscad.js";

import { createEditorFS, getParentDir, symlinkLibraries } from "../fs/filesystem";
import { OpenSCADInvocation, OpenSCADInvocationCallback, OpenSCADInvocationResults } from "./openscad-runner";
import { deployedArchiveNames, zipArchives } from "../fs/zip-archives";
import { fetchSource } from "../utils.js";
import { stderr } from "process";
declare var BrowserFS: BrowserFSInterface

importScripts("browserfs.min.js");

export type MergedOutputs = {stdout?: string, stderr?: string, error?: string}[];

function callback(payload: OpenSCADInvocationCallback) {
  postMessage(payload);
}

addEventListener('message', async (e) => {

  const {
    mountArchives,
    inputs,
    args,
    outputPaths,
    wasmMemory,
  } = e.data as OpenSCADInvocation;

  const mergedOutputs: MergedOutputs = [];
  let instance: any;
  const start = performance.now();
  try {
    instance = await OpenSCAD({
      wasmMemory,
      buffer: wasmMemory && wasmMemory.buffer,
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
      'ENV': {
        'OPENSCADPATH': '/libraries',
      },
    });

    if (mountArchives) {
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

    // Fonts are seemingly resolved from $(cwd)/fonts
    instance.FS.chdir("/");
      
    // const walkFolder = (path: string, indent = '') => {
    //   console.log("Walking " + path);
    //   instance.FS.readdir(path)?.forEach((f: string) => {
    //     if (f.startsWith('.')) {
    //       return;
    //     }
    //     const ii = indent + '  ';
    //     const p = `${path != '/' ? path + '/' : '/'}${f}`;
    //     console.log(`${ii}${p}`);
    //     walkFolder(p, ii);
    //   });
    // };
    // walkFolder('/libraries');

    if (inputs) {
      for (const source of inputs) {
        try {
          instance.FS.writeFile(source.path, await fetchSource(source));
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
        // console.trace(`Failed to read output file ${path}`, e);
      }
    }
    const result: OpenSCADInvocationResults = {
      outputs,
      mergedOutputs,
      exitCode,
      elapsedMillis,
    }

    console.debug(result);

    callback({result});
  } catch (e) { 
    const end = performance.now();
    const elapsedMillis = end - start;

    console.trace(e);//, e instanceof Error ? e.stack : '');
    const error = `${e}`;
    mergedOutputs.push({ error });
    // callback({stderr: error})
    callback({
      result: {
        exitCode: undefined,
        error,
        mergedOutputs,
        elapsedMillis,
      }
    });
  }
});
