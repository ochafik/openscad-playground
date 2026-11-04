// Spike A2: single invocation, --animate N with a non-image export (off), manifold backend.
import OpenSCAD from '../src/wasm/openscad.js';
import fs from 'node:fs';
const N = +process.argv[2] || 6;
const mode = process.argv[3] || 'animate';   // animate | loopD
const log = [];
const inst = await OpenSCAD({
  noInitialRun: true,
  instantiateWasm: (i, ok) => { WebAssembly.instantiate(fs.readFileSync(new URL('../src/wasm/openscad.wasm', import.meta.url)), i).then(r => ok(r.instance, r.module)); return {}; },
  print: t => log.push(t), printErr: t => log.push(t),
});
const scad = fs.readFileSync(process.argv[4] || new URL('./heavy.scad', import.meta.url), 'utf8');
inst.FS.writeFile('/m.scad', scad);
const t0 = performance.now();
const code = inst.callMain(mode === 'animate'
  ? ['/m.scad', '--animate', String(N), '-o', '/out.off', '--backend=manifold', '--export-format=off']
  : ['/m.scad', '-o', '/out.off', '--backend=manifold', '--export-format=off', '-D$t=0']);
const dt = performance.now() - t0;
console.log(`mode=${mode} N=${N} exit=${code} total ${dt.toFixed(0)} ms`);
console.log(inst.FS.readdir('/').filter(f => /out/.test(f)).map(f => f + ':' + inst.FS.stat('/' + f).size).join(' '));
console.log(log.filter(l => /cache|rendering time|ERROR|WARN|animate|Vertices|Facets/i.test(l)).join('\n'));
