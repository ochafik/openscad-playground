import OpenSCAD from '../src/wasm/openscad.js'; import fs from 'node:fs';
import { parseOff } from '../src/io/import_off.ts'; import { exportGlb } from '../src/io/export_glb.ts';
const N = 30;
const wasm = fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url));
const m: any = await OpenSCAD({noInitialRun: true, instantiateWasm: (i: any, ok: any) => { WebAssembly.instantiate(wasm, i).then(r => ok(r.instance, r.module)); return {}; }, print: () => {}, printErr: () => {}});
m.FS.writeFile('/m.scad', '$preview=true;\n' + fs.readFileSync(new URL('./models/heavy-static.scad', import.meta.url), 'utf8'));
m.callMain(['/m.scad', '--animate', String(N), '-o', '/o.off', '--backend=manifold', '--export-format=off']);
for (let i = 0; i < N; i++) { const b = await exportGlb(parseOff(new TextDecoder().decode(m.FS.readFile(`/o${String(i).padStart(5, '0')}.off`)))); fs.writeFileSync(new URL(`./out/heavy-f${i}.glb`, import.meta.url), Buffer.from(await b.arrayBuffer())); }
