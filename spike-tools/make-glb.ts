// usage: tsx make-glb.ts model.scad N fps out.glb [restPose]
import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
import { parseOff } from '../src/io/import_off.ts';
import { exportAnimatedGlb } from '../src/io/export_glb_animated.ts';
import { exportGlb } from '../src/io/export_glb.ts';
const [model, nS, fpsS, out, rest] = process.argv.slice(2);
const N = +nS, fps = +fpsS;
const wasm = fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url));
const m: any = await OpenSCAD({noInitialRun: true, instantiateWasm: (i: any, ok: any) => { WebAssembly.instantiate(wasm, i).then(r => ok(r.instance, r.module)); return {}; }, print: () => {}, printErr: () => {}});
m.FS.writeFile('/m.scad', '$preview=true;\n' + fs.readFileSync(model, 'utf8'));
let t = performance.now();
m.callMain(['/m.scad', '--animate', String(N), '-o', '/o.off', '--backend=manifold', '--export-format=off']);
const tRender = performance.now() - t;
t = performance.now();
const frames = [];
let offBytes = 0;
for (let i = 0; i < N; i++) { const txt = new TextDecoder().decode(m.FS.readFile(`/o${String(i).padStart(5, '0')}.off`)); offBytes += txt.length; frames.push(parseOff(txt)); }
const tParse = performance.now() - t;
t = performance.now();
const glb = await exportAnimatedGlb(frames, {fps, restPose: (rest as any) ?? 'first'});
const tGlb = performance.now() - t;
fs.writeFileSync(out, glb);
const single = await exportGlb(frames[0]);
console.log(JSON.stringify({model: model.split('/').pop(), N, fps, renderMs: Math.round(tRender), parseMs: Math.round(tParse), glbBuildMs: Math.round(tGlb), offTotalMB: +(offBytes/1e6).toFixed(1), animGlbMB: +(glb.length/1e6).toFixed(2), singleGlbKB: Math.round(single.size/1024), vertsPerFrame: frames[0].vertices.length, trisPerFrame: frames[0].faces.length}));
