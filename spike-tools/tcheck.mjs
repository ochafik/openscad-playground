import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
const mk=async()=>OpenSCAD({noInitialRun:true,instantiateWasm:(i,ok)=>{WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)),i).then(r=>ok(r.instance,r.module));return {};},print:()=>{},printErr:()=>{}});
const scad='rotate([0,0,$t*360]) cube([10,4,4]); echo($t);'; 
const a=await mk(); a.FS.writeFile('/m.scad',scad); a.callMain(['/m.scad','--animate','8','-o','/o.off','--backend=manifold','--export-format=off']);
for (const i of [0,3,7]) { const b=await mk(); b.FS.writeFile('/m.scad',scad); b.callMain(['/m.scad','-o','/o.off','--backend=manifold','--export-format=off',`-D$t=${i/8}`]);
 console.log(i, Buffer.from(a.FS.readFile(`/o0000${i}.off`)).equals(Buffer.from(b.FS.readFile('/o.off')))); }
// svg 2D
const c=await mk(); c.FS.writeFile('/m.scad','rotate($t*360) square(5);'); c.callMain(['/m.scad','--animate','3','-o','/o.svg','--backend=manifold']); console.log(c.FS.readdir('/').filter(f=>/^o/.test(f)));
// time for trivial model per fresh instance
let t=performance.now(); const d=await mk(); d.FS.writeFile('/m.scad','cube(5);'); d.callMain(['/m.scad','-o','/o.off','--backend=manifold','--export-format=off']); console.log('fresh instance+cube ms',(performance.now()-t).toFixed(0));
