import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
const log=[];
const t00=performance.now();
const inst = await OpenSCAD({noInitialRun:true,
  instantiateWasm:(i,ok)=>{WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)),i).then(r=>ok(r.instance,r.module));return {};},
  print:t=>log.push(t),printErr:t=>log.push(t)});
console.log('instantiate ms', (performance.now()-t00).toFixed(0));
inst.FS.writeFile('/m.scad', fs.readFileSync(new URL('./heavy.scad', import.meta.url)));
const t0=performance.now();
const oc=inst.FS.close; inst.FS.close=(st)=>{const p=st.path, w=st.flags&3; oc(st); if(/out\d+\.off$/.test(p)&&w) console.log('closed',p,(performance.now()-t0).toFixed(0)+'ms size',inst.FS.stat(p).size)};
inst.callMain(['/m.scad','--animate','4','-o','/out.off','--backend=manifold','--export-format=off']);
// equality check frame 2 (t=0.5) vs -D$t=0.5
const a=inst.FS.readFile('/out00002.off');

const inst2=null;
