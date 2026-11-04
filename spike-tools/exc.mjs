import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
const log=[];
const inst = await OpenSCAD({noInitialRun:true,noExitRuntime:true,
  instantiateWasm:(i,ok)=>{WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)),i).then(r=>{globalThis.__inst=r.instance;ok(r.instance,r.module)});return {};},
  print:t=>log.push(t),printErr:t=>log.push(t)});
inst.FS.writeFile('/m.scad','cube(5);');
console.log(inst.callMain(['/m.scad','-o','/a.off','--backend=manifold','--export-format=off']), log.slice(-3));
log.length=0;
let e; try{ inst.callMain(['/m.scad','-o','/b.off','--backend=manifold','--export-format=off']) }catch(x){e=x}
console.log('exc',e, log);
const mem = Object.values(globalThis.__inst.exports).find(v=>v instanceof WebAssembly.Memory);
const u8=new Uint8Array(mem.buffer);
const dv=new DataView(mem.buffer);
// scan around ptr for pointers to strings
for(let off=-32; off<=32; off+=4){ const w=dv.getUint32(e+off,true); let s=''; if(w>0&&w<u8.length-64){for(let k=w;k<w+60&&u8[k]>=32&&u8[k]<127;k++)s+=String.fromCharCode(u8[k]);} console.log(off,w,s) }
const str=(p)=>{let s='';for(let k=p;k<p+80&&k<u8.length&&u8[k]>=32&&u8[k]<127;k++)s+=String.fromCharCode(u8[k]);return s};
for(let off=-96; off<=0; off+=4){ const w=dv.getUint32(e+off,true); if(w>1000&&w<u8.length-8){ const n=dv.getUint32(w+4,true); if(n>1000&&n<u8.length) { const s=str(n); if(/^[0-9SN]/.test(s)) console.log('type@',off,s)} } }
// try dumping the what() string: for std::runtime_error the msg is at ptr+4 -> refcounted string
for(let off=0; off<=16; off+=4){const w=dv.getUint32(e+off,true); if(w>1000&&w<u8.length) console.log('str@',off,str(w))}
console.log('mem pages after', mem.buffer.byteLength/65536, 'MB', mem.buffer.byteLength/1048576);
