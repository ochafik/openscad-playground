/**
 * Bounds of animation frames, to frame the camera once for a whole loop (DOM-free, unit tested).
 *
 * A frame's bounds are its axis-aligned box plus its extreme vertex in 26 directions, which is enough to get a tight
 * bounding sphere of a set of frames (moving parts) without keeping every vertex.
 */

export type Vec3 = [number, number, number];

export interface Bounds {
  min: Vec3;
  max: Vec3;
  /** Extreme vertices (support points) in the 26 axis / diagonal directions. */
  support: Vec3[];
}

const DIRECTIONS: Vec3[] = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
  if (x || y || z) DIRECTIONS.push([x, y, z]);
}

export function boundsOfVertices(vertices: Iterable<{ x: number, y: number, z: number }>): Bounds | undefined {
  const best = DIRECTIONS.map(() => -Infinity);
  const support: Vec3[] = DIRECTIONS.map(() => [0, 0, 0]);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const {x, y, z} of vertices) {
    any = true;
    if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
    for (let i = 0; i < DIRECTIONS.length; i++) {
      const d = DIRECTIONS[i];
      const dot = d[0] * x + d[1] * y + d[2] * z;
      if (dot > best[i]) { best[i] = dot; support[i] = [x, y, z]; }
    }
  }
  return any ? { min, max, support } : undefined;
}

export function unionBounds(all: Iterable<Bounds | undefined>): Bounds | undefined {
  let out: Bounds | undefined;
  for (const b of all) {
    if (!b) continue;
    out = !out ? b : {
      min: [Math.min(out.min[0], b.min[0]), Math.min(out.min[1], b.min[1]), Math.min(out.min[2], b.min[2])],
      max: [Math.max(out.max[0], b.max[0]), Math.max(out.max[1], b.max[1]), Math.max(out.max[2], b.max[2])],
      support: [...out.support, ...b.support],
    };
  }
  return out;
}

export const centerOf = (b: Bounds): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

/** Radius of the sphere around the box center that holds every support point (~ the bounding sphere). */
export function radiusOf(b: Bounds): number {
  const c = centerOf(b);
  let r = 0;
  for (const p of b.support) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  return r;
}

/** The viewer shows Z-up models Y-up (`orientation="0deg -90deg 0deg"`): model (x, y, z) is at viewer (x, z, -y). */
export const toViewerSpace = ([x, y, z]: Vec3): Vec3 => [x, z, -y];

/**
 * How to change a camera framing `from` (a model's bounds) so that it frames `to` (a set of models, `from` included)
 * just as well: the radius is multiplied by `scale` (>= 1: never zooms in) and the target moved by `shift`, in viewer space.
 * Undefined when nothing needs to change.
 */
export function refit(from: Bounds, to: Bounds, margin = 1.04): { scale: number, shift: Vec3 } | undefined {
  const r0 = radiusOf(from);
  if (!(r0 > 0)) return undefined;
  const grow = radiusOf(to) / r0;
  const scale = grow > 1.001 ? grow * margin : 1;
  const c0 = centerOf(from), c1 = centerOf(to);
  const shift = toViewerSpace([c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]]);
  if (scale < 1.02 && Math.hypot(...shift) < r0 * 0.02) return undefined;
  return { scale, shift };
}
