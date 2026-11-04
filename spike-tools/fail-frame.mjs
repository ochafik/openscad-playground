import OpenSCAD from '../src/wasm/openscad.js'; import fs from 'node:fs';
const log=[]; const m = await OpenSCAD({noInitialRun: true, instantiateWasm: (i, ok) => { WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)), i).then(r => ok(r.instance, r.module)); return {}; }, print: t=>log.push(t), printErr: t=>log.push(t)});
m.FS.writeFile('/m.scad','assert($t<0.5, "too late"); cube(5+$t*10);');
const rc = m.callMain(['/m.scad','--animate','6','-o','/o.off','--backend=manifold','--export-format=off']);
console.log('rc',rc, m.FS.readdir('/').filter(f=>/^o/.test(f)), log.filter(l=>/ERROR|assert|too late/i.test(l)).slice(0,3));
