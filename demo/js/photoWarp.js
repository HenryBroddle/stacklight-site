// Trace-photo 4-corner fit for the SVG floor plan (DECISIONS D5 `background.corners`). The editor warps an <img>
// with CSS matrix3d() (public/js/editor/underlay.js); SVG transforms are affine only, so the HUD draws the same
// projective map as a mesh: the unit square is cut into n × n cells, two triangles each, and every triangle is the
// photo under the affine map that matches the projective map at its three corners. Clip triangles are dilated a
// little so the pieces overlap (no hairline seams; the caller applies opacity to the whole group).
// Pure ESM, no imports and no DOM, so it is unit-tested in Node.

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Four [x, y] points (top-left, top-right, bottom-right, bottom-left) or null.
 * @param {unknown} corners
 * @returns {number[][]|null}
 */
export function quadOf(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  if (!corners.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]))) return null;
  return corners.map((p) => [p[0], p[1]]);
}

/**
 * Projective map of the unit square onto a quad (Heckbert's square-to-quad): (0,0)→TL, (1,0)→TR, (1,1)→BR, (0,1)→BL.
 * @param {number[][]} q  TL, TR, BR, BL
 * @returns {{ a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number,
 *             map: (u: number, v: number) => number[], affine: boolean }|null}  null when degenerate
 */
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  const span = Math.max(1e-9, Math.abs(x1 - x0) + Math.abs(y1 - y0) + Math.abs(x3 - x0) + Math.abs(y3 - y0));
  const affine = Math.abs(dx3) <= span * 1e-9 && Math.abs(dy3) <= span * 1e-9;
  if (!affine) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  if (Math.abs(a * e - b * d) < 1e-12 && affine) return null;
  const map = (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
  // A fold (a corner dragged across the opposite side) puts w ≤ 0 somewhere inside the square.
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) if (!(g * u + h * v + 1 > 1e-9)) return null;
  return { a, b, c, d, e, f, g, h, map, affine };
}

/**
 * Affine [a, b, c, d, e, f] (SVG matrix order: x' = a x + c y + e, y' = b x + d y + f) taking triangle s onto t.
 * @returns {number[]|null}
 */
export function affineFromTriangles(s, t) {
  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const [[u0, v0], [u1, v1], [u2, v2]] = t;
  const sx1 = x1 - x0, sy1 = y1 - y0, sx2 = x2 - x0, sy2 = y2 - y0;
  const det = sx1 * sy2 - sx2 * sy1;
  if (Math.abs(det) < 1e-15) return null;
  const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
  const a = (du1 * sy2 - du2 * sy1) / det;
  const c = (sx1 * du2 - sx2 * du1) / det;
  const b = (dv1 * sy2 - dv2 * sy1) / det;
  const d = (sx1 * dv2 - sx2 * dv1) / det;
  return [a, b, c, d, u0 - a * x0 - c * y0, v0 - b * x0 - d * y0];
}

/**
 * Pieces to draw a unit-square image (x 0, y 0, width 1, height 1, preserveAspectRatio none) onto `corners`.
 * An affine fit (parallelogram) is one piece without a clip; otherwise 2 · n² triangles.
 * @param {unknown} corners  TL, TR, BR, BL in layout units
 * @param {{ n?: number, dilate?: number }} [o]  n: cells per side (default 8); dilate: clip growth about each
 *                                               triangle's centroid (default 0.03 = 3 %)
 * @returns {{ matrix: number[], clip: number[][]|null }[]|null}  null when the corners are unusable
 */
export function photoMesh(corners, { n = 8, dilate = 0.03 } = {}) {
  const q = quadOf(corners);
  const P = q && squareToQuad(q);
  if (!P) return null;
  if (P.affine) return [{ matrix: [P.a, P.d, P.b, P.e, P.c, P.f], clip: null }];
  const cells = Math.max(1, Math.min(32, Math.round(n)));
  const out = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const u0 = i / cells, u1 = (i + 1) / cells, v0 = j / cells, v1 = (j + 1) / cells;
      for (const tri of [[[u0, v0], [u1, v0], [u1, v1]], [[u0, v0], [u1, v1], [u0, v1]]]) {
        const m = affineFromTriangles(tri, tri.map(([u, v]) => P.map(u, v)));
        if (!m || !m.every(finite)) return null;
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
        const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        out.push({ matrix: m, clip: tri.map(([u, v]) => [cx + (u - cx) * (1 + dilate), cy + (v - cy) * (1 + dilate)]) });
      }
    }
  }
  return out;
}

/** Compact number for SVG attributes (8 significant digits, no -0). */
export function fmt(v) {
  return String(Number(v.toPrecision(8)) || 0);
}
