import OpenSCAD from '../src/wasm/openscad.js'; import fs from 'node:fs';
import { parseOff } from '../src/io/import_off.ts'; import { exportAnimatedGlb } from '../src/io/export_glb_animated.ts';
const N = 30, fps = 15;
const wasm = fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url));
const m: any = await OpenSCAD({noInitialRun: true, instantiateWasm: (i: any, ok: any) => { WebAssembly.instantiate(wasm, i).then(r => ok(r.instance, r.module)); return {}; }, print: () => {}, printErr: () => {}});
m.FS.writeFile('/m.scad', '$preview=true;\n' + fs.readFileSync(new URL('./models/light.scad', import.meta.url), 'utf8'));
m.callMain(['/m.scad', '--animate', String(N), '-o', '/o.off', '--backend=manifold', '--export-format=off']);
const frames = Array.from({length: N}, (_, i) => parseOff(new TextDecoder().decode(m.FS.readFile(`/o${String(i).padStart(5, '0')}.off`))));
for (const k of [5, 10, 20, 30]) { const t = performance.now(); const g = await exportAnimatedGlb(frames.slice(0, k), {fps, restPose: 'all'}); fs.writeFileSync(new URL(`./out/part-${k}.glb`, import.meta.url), g); console.log(k, 'frames', g.length, 'B', (performance.now() - t).toFixed(0), 'ms'); }
