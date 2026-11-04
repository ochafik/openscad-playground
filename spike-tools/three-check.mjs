// Independent check with three.js' GLTFLoader + AnimationMixer (not model-viewer): exactly one frame has non-zero scale at each time.
import * as THREE from 'three'; import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'; import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
const clip = gltf.animations[0]; console.log('three', THREE.REVISION, 'clip', clip.name, 'duration', clip.duration, 'tracks', clip.tracks.length);
const frames = []; gltf.scene.traverse(o => { if (o.name.startsWith('frame_') && !o.isMesh) frames.push(o); });
const mixer = new THREE.AnimationMixer(gltf.scene); const action = mixer.clipAction(clip); action.play();
const fps = +process.argv[3]; let bad = 0;
for (let i = 0; i < frames.length; i++) { mixer.setTime((i + 0.5) / fps); const vis = frames.map((f, k) => f.scale.x !== 0 ? k : -1).filter(k => k >= 0); if (vis.length !== 1 || vis[0] !== i) { bad++; console.log('frame', i, 'visible', vis); } }
// wrap
mixer.setTime(clip.duration * 1.25); const vis = frames.map((f, k) => f.scale.x !== 0 ? k : -1).filter(k => k >= 0); console.log('after wrap (1.25 loops) visible', vis, 'expected', Math.floor(0.25 * frames.length));
console.log('mismatches', bad, 'of', frames.length);
