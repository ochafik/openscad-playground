import OpenSCAD from '../src/wasm/openscad.js'; import fs from 'node:fs';
const [model, N] = process.argv.slice(2); let mem;
const m = await OpenSCAD({noInitialRun: true, instantiateWasm: (i, ok) => { WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)), i).then(r => { mem = Object.values(r.instance.exports).find(v => v instanceof WebAssembly.Memory); ok(r.instance, r.module); }); return {}; }, print: () => {}, printErr: () => {}});
const before = mem.buffer.byteLength / 1048576;
m.FS.writeFile('/m.scad', '$preview=true;\n' + fs.readFileSync(model, 'utf8'));
let outBytes = 0; const oc = m.FS.close; m.FS.close = st => { const p = st.path; oc(st); if (/^\/o\d+\.off$/.test(p)) { outBytes += m.FS.stat(p).size; m.FS.unlink(p); } };
m.callMain(['/m.scad', '--animate', N, '-o', '/o.off', '--backend=manifold', '--export-format=off']);

console.log(`${model.split('/').pop()} N=${N}: wasm memory ${before.toFixed(0)} -> ${(mem.buffer.byteLength / 1048576).toFixed(0)} MB; OFF files in MEMFS ${(outBytes / 1048576).toFixed(1)} MB`);
