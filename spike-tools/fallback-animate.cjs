const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(__dirname+'/../public/openscad.fallback.js','utf8');
const g={console,performance,WebAssembly:undefined,process,setTimeout,TextDecoder,TextEncoder,Buffer,URL};
vm.createContext(g); g.self=g; g.globalThis=g;
vm.runInContext(src+';this.OpenSCAD=typeof OpenSCAD!=="undefined"?OpenSCAD:this.OpenSCAD',g);
(async()=>{
 const t=performance.now();
 const m=await g.OpenSCAD({noInitialRun:true,print:()=>{},printErr:()=>{}});
 console.log('js instantiate ms',(performance.now()-t).toFixed(0));
 m.FS.writeFile('/m.scad','$preview=true;'+fs.readFileSync(__dirname+'/models/light.scad','utf8'));
 const t1=performance.now();
 const c=m.callMain(['/m.scad','--animate','4','-o','/o.off','--backend=manifold','--export-format=off']);
 console.log('exit',c,'animate4 ms',(performance.now()-t1).toFixed(0), m.FS.readdir('/').filter(f=>/^o/.test(f)));
})().catch(e=>console.log('ERR',e));
