// Bench: N fresh instances with -D$t (current per-frame-worker approach, engine only) vs one --animate N invocation.
import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
const wasm = fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url));
const module = await WebAssembly.compile(wasm);
const mk = () => OpenSCAD({noInitialRun:true, instantiateWasm:(i,ok)=>{WebAssembly.instantiate(module,i).then(inst=>ok(inst,module));return {};}, print:()=>{}, printErr:()=>{}});
const N = +process.argv[3] || 30;
const file = process.argv[2];
const scad = '$preview=true;\n' + fs.readFileSync(file, 'utf8');
await (async()=>{const w=await mk(); w.FS.writeFile('/m.scad','cube(1);'); w.callMain(['/m.scad','-o','/o.off','--backend=manifold','--export-format=off']);})(); // warm
let t0 = performance.now(); let per = [];
for (let i = 0; i < N; i++) { const s = performance.now(); const m = await mk(); m.FS.writeFile('/m.scad', scad); m.callMain(['/m.scad','-o','/o.off','--backend=manifold','--export-format=off', `-D$t=${i/N}`]); per.push(performance.now()-s); }
const fresh = performance.now() - t0;
t0 = performance.now(); const s0 = performance.now();
const m = await mk(); m.FS.writeFile('/m.scad', scad);
const times=[]; const log=[]; let last=performance.now();
const oc=m.FS.close; m.FS.close=(st)=>{const p=st.path; oc(st); if(/o\d+\.off$/.test(p)){const n=performance.now(); times.push(n-last); last=n;}};
m.callMain(['/m.scad','--animate',String(N),'-o','/o.off','--backend=manifold','--export-format=off']);
const anim = performance.now() - t0;
const sz = m.FS.stat('/o00000.off').size;
console.log(`${file.split('/').pop()} N=${N} frame=${(sz/1024).toFixed(0)}KB  fresh-per-frame total ${fresh.toFixed(0)}ms (first ${per[0].toFixed(0)}, median ${per.sort((a,b)=>a-b)[N>>1].toFixed(0)})  | --animate total ${anim.toFixed(0)}ms (first ${times[0].toFixed(0)}, median ${times.slice().sort((a,b)=>a-b)[N>>1].toFixed(0)})  speedup x${(fresh/anim).toFixed(2)}`);
