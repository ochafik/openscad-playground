// SPIKE (docs/ANIMATION_DESIGN.md, idea B): assemble the per-frame meshes of an animation into ONE glTF.
//
// glTF cannot swap arbitrary geometry per frame through animation channels (morph targets need identical topology,
// which CSG output does not have). Technique: one node per frame, plus ONE animation with a STEP-interpolated `scale`
// channel per node (1 while the frame is shown, 0 otherwise). Exactly one frame has a non-zero scale at any time.
// Works in every glTF 2.0 viewer that plays animations (no extension needed).
import { Document, NodeIO, Accessor, Primitive, Material } from '@gltf-transform/core';
import { KHRLightsPunctual, Light as LightDef } from '@gltf-transform/extensions';
import { Color, DEFAULT_FACE_COLOR, Face, IndexedPolyhedron } from './common';
import { getGeom } from './export_glb';

export interface AnimatedGlbOptions {
    fps: number;
    /** Rest pose: 'first' = only frame 0 has scale 1 (static viewers show a poster frame; model-viewer frames frame 0),
     *  'all' = every frame has scale 1 (bounds = union of all frames; static viewers show them overlapped). */
    restPose?: 'first' | 'all';
    /** Add the two directional lights the app's static GLBs carry. */
    lights?: boolean;
    animationName?: string;
}

/** Cheap structural hash, so frames with identical geometry (periodic animations) share one mesh. */
function hashFrame(f: IndexedPolyhedron): string {
    let h = 2166136261 >>> 0;
    const mix = (x: number) => { h = Math.imul(h ^ (x | 0), 16777619) >>> 0; };
    for (const v of f.vertices) { mix(Math.round(v.x * 1e4)); mix(Math.round(v.y * 1e4)); mix(Math.round(v.z * 1e4)); }
    for (const fc of f.faces) { mix(fc.vertices[0]); mix(fc.vertices[1]); mix(fc.vertices[2]); mix(fc.colorIndex); }
    return `${f.vertices.length}/${f.faces.length}/${h}`;
}

export function buildAnimatedGlbDocument(frames: IndexedPolyhedron[], opts: AnimatedGlbOptions): Document {
    const {fps, restPose = 'first', lights = true, animationName = 'frames'} = opts;
    const n = frames.length;
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene();
    if (lights) {
        const lightExt = doc.createExtension(KHRLightsPunctual);
        for (const rot of [[-0.3250576, -0.3250576, 0, 0.8880739], [0.6279631, 0.6279631, 0, 0.4597009]] as const) {
            scene.addChild(doc.createNode()
                .setExtension('KHR_lights_punctual', lightExt.createLight().setType(LightDef.Type.DIRECTIONAL).setIntensity(1).setColor([1, 1, 1]))
                .setRotation([...rot]));
        }
    }

    const materials = new Map<string, Material>();
    const materialFor = (c: Color) => {
        const key = c.join(',');
        let m = materials.get(key);
        if (!m) materials.set(key, m = doc.createMaterial().setDoubleSided(true).setAlphaMode(c[3] < 1 ? 'BLEND' : 'OPAQUE')
            .setMetallicFactor(0).setRoughnessFactor(0.8).setBaseColorFactor(c));
        return m;
    };

    const meshByHash = new Map<string, ReturnType<Document['createMesh']>>();
    const nodes = frames.map((data, i) => {
        const key = hashFrame(data);
        let mesh = meshByHash.get(key);
        if (!mesh) {
            mesh = doc.createMesh(`frame_mesh_${i}`);
            const byColor = new Map<number, Face[]>();
            for (const face of data.faces) { let l = byColor.get(face.colorIndex); if (!l) byColor.set(face.colorIndex, l = []); l.push(face); }
            for (const [ci, faces] of byColor) {
                const g = getGeom({vertices: data.vertices, faces, colors: data.colors});
                mesh.addPrimitive(doc.createPrimitive().setMode(Primitive.Mode.TRIANGLES)
                    .setMaterial(materialFor(data.colors[ci] ?? DEFAULT_FACE_COLOR))
                    .setAttribute('POSITION', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(g.positions))
                    .setIndices(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(g.indices)));
            }
            meshByHash.set(key, mesh);
        }
        const node = doc.createNode(`frame_${String(i).padStart(4, '0')}`).setMesh(mesh);
        const rest = restPose === 'all' || i === 0 ? 1 : 0;
        node.setScale([rest, rest, rest]);
        scene.addChild(node);
        return node;
    });

    const anim = doc.createAnimation(animationName);
    const dt = 1 / fps;
    const f32 = (a: number[]) => new Float32Array(a);
    nodes.forEach((node, i) => {
        // [0 -> hidden, i*dt -> shown, (i+1)*dt -> hidden]; STEP holds each value until the next key.
        const times: number[] = [], vals: number[] = [];
        const push = (t: number, v: number) => { times.push(t); vals.push(v, v, v); };
        if (i === 0) push(0, 1); else { push(0, 0); push(i * dt, 1); }
        push((i + 1) * dt, 0);
        if (i + 1 < n) push(n * dt, 0); // every channel spans the whole loop, so the duration is exactly n/fps
        const sampler = doc.createAnimationSampler().setInterpolation('STEP')
            .setInput(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(f32(times)).setBuffer(buffer))
            .setOutput(doc.createAccessor().setType(Accessor.Type.VEC3).setArray(f32(vals)).setBuffer(buffer));
        anim.addSampler(sampler);
        anim.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('scale').setSampler(sampler));
    });
    return doc;
}

export async function exportAnimatedGlb(frames: IndexedPolyhedron[], opts: AnimatedGlbOptions): Promise<Uint8Array> {
    const doc = buildAnimatedGlbDocument(frames, opts);
    const exts = opts.lights === false ? [] : [KHRLightsPunctual];
    return await new NodeIO().registerExtensions(exts).writeBinary(doc);
}
