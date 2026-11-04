// Spike A: can callMain run repeatedly on one OpenSCAD wasm instance? Does the geometry cache persist?
import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
const noExit = process.argv.includes('--noexit');
const heavy = process.argv.includes('--heavy');
const log = [];
const inst = await OpenSCAD({
  noInitialRun: true,
  noExitRuntime: noExit,
  instantiateWasm: (imports, ok) => { WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)), imports).then(r => ok(r.instance, r.module)); return {}; },
  print: t => log.push(t), printErr: t => log.push(t),
});
// static heavy part: many-sphere hull/difference; moving part: small cube rotating with $t
const scad = `$preview=true;
module heavy(){ difference(){ union(){ for(i=[0:40]) translate([i*2,0,0]) sphere(r=6,$fn=48); } for(i=[0:40]) translate([i*2+1,0,0]) rotate([90,0,0]) cylinder(r=2,h=30,center=true,$fn=48); } }
heavy();
translate([0,0,20]) rotate([0,0,$t*360]) cube([10,4,4]);
`;
inst.FS.writeFile('/m.scad', scad);
const frames = [0, 0.1, 0.2, 0.3];
for (const [k, t] of frames.entries()) {
  log.length = 0;
  const t0 = performance.now();
  let code, err;
  try { code = inst.callMain(['/m.scad', '-o', `/out${k}.off`, '--backend=manifold', '--export-format=off', `-D$t=${t}`]); } catch (e) { err = e; }
  const dt = performance.now() - t0;
  const exists = (() => { try { return inst.FS.readFile(`/out${k}.off`).length; } catch { return null; } })();
  console.log(`call ${k} t=${t}: ${dt.toFixed(0)} ms code=${code} err=${err} outBytes=${exists}`);
  console.log('  log:', log.filter(l => /cache|Simple|Total|Vertices|Facets|rendering|ERROR|WARN|abort/i.test(l)).join(' | ').slice(0, 400));
}
