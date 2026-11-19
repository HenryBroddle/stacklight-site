// Plane geometry for the layout editor (layout units; x right, y down; rotation clockwise in degrees, about the
// rectangle centre — docs/LAYOUTS.md). Pure ESM with no imports so it is unit-tested in Node.

/** Round to 4 decimals (the validator's precision); -0 becomes 0. */
export const round4 = (v) => Math.round(v * 1e4) / 1e4 || 0;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const RAD = Math.PI / 180;

/** Normalize degrees to (-180, 180]. */
export function normalizeDeg(deg) {
  let r = ((deg % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return round4(r);
}

/** Round an angle to the nearest multiple of `step` degrees. */
export function snapAngle(deg, step = 15) {
  return step > 0 ? Math.round(deg / step) * step : deg;
}

/** Rotate point p about c by deg (clockwise on screen, because y points down). */
export function rotatePoint(p, c, deg) {
  if (!deg) return [p[0], p[1]];
  const r = deg * RAD;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
}

/** Centre of an {x, y, w, h} rectangle. */
export function rectCenter(r) {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

/** Corners (TL, TR, BR, BL) of a possibly rotated {x, y, w, h, rotation} rectangle. */
export function rectCorners(r) {
  const c = rectCenter(r);
  const deg = finite(r.rotation) ? r.rotation : 0;
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map((p) => rotatePoint(p, c, deg));
}

/** Axis-aligned bounds of points → { minX, minY, maxX, maxY } or null. */
export function bboxOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points ?? []) {
    if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) continue;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Union of bounding boxes (nulls ignored). */
export function bboxUnion(...boxes) {
  let out = null;
  for (const b of boxes.flat()) {
    if (!b) continue;
    out = out ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) } : { ...b };
  }
  return out;
}

export const bboxWidth = (b) => b.maxX - b.minX;
export const bboxHeight = (b) => b.maxY - b.minY;
export const bboxCenter = (b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/** True when two bounding boxes overlap or touch. */
export function bboxesIntersect(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** True when `inner` lies entirely inside `outer`. */
export function bboxContains(outer, inner) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

/** Bounding box spanned by two corner points (any order). */
export function bboxFromPoints(a, b) {
  return { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Closest point on segment ab to p.
 * @returns {{ point: number[], t: number, dist: number }}
 */
export function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + t * dx, a[1] + t * dy];
  return { point, t, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

/** Segments of a polyline ([[a, b, index], …]); `closed` adds the closing segment. */
export function segmentsOf(points, closed = false) {
  const out = [];
  if (!Array.isArray(points)) return out;
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i], points[i + 1], i]);
  if (closed && points.length > 2) out.push([points[points.length - 1], points[0], points.length - 1]);
  return out;
}

/** Distance from p to a polyline (Infinity for fewer than 2 points). */
export function distToPolyline(p, points, closed = false) {
  let best = Infinity;
  for (const [a, b] of segmentsOf(points, closed)) best = Math.min(best, nearestOnSegment(p, a, b).dist);
  return best;
}

/** Total length of a polyline. */
export function polylineLength(points, closed = false) {
  let len = 0;
  for (const [a, b] of segmentsOf(points, closed)) len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  return len;
}

/** Area of a simple polygon (shoelace, always ≥ 0). */
export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) s += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  return Math.abs(s) / 2;
}

/** Point expressed in a rectangle's local frame: origin at the centre, axes along the (rotated) sides. */
export function toLocal(p, r) {
  const c = rectCenter(r);
  const q = rotatePoint(p, c, -(finite(r.rotation) ? r.rotation : 0));
  return [q[0] - c[0], q[1] - c[1]];
}

/** True when p lies inside the (possibly rotated) rectangle, grown by `pad` on every side. */
export function pointInRect(p, r, pad = 0) {
  const [lx, ly] = toLocal(p, r);
  return Math.abs(lx) <= r.w / 2 + pad && Math.abs(ly) <= r.h / 2 + pad;
}

/**
 * Constrain `to` so the direction from `from` is a multiple of `stepDeg` (Shift while drawing walls: 0/45/90°).
 * The length along the chosen direction is the projection of the original vector.
 */
export function constrainAngle(from, to, stepDeg = 45) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return [to[0], to[1]];
  const ang = snapAngle(Math.atan2(dy, dx) / RAD, stepDeg) * RAD;
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const proj = dx * ux + dy * uy;
  return [round4(from[0] + ux * proj), round4(from[1] + uy * proj)];
}

/** Angle of the segment a→b in degrees, folded into (-90, 90] (doors and labels read the same both ways). */
export function lineAngle(a, b) {
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  else if (deg <= -90) deg += 180;
  return round4(deg);
}

export const HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

/** Local position of a resize handle on a w × h rectangle centred at the origin. */
export function handleLocal(handle, w, h) {
  const x = handle.includes('w') ? -w / 2 : handle.includes('e') ? w / 2 : 0;
  const y = handle.includes('n') ? -h / 2 : handle.includes('s') ? h / 2 : 0;
  return [x, y];
}

/** World position of a resize handle of a (possibly rotated) rectangle. */
export function handleWorld(r, handle) {
  const c = rectCenter(r);
  const [lx, ly] = handleLocal(handle, r.w, r.h);
  return rotatePoint([c[0] + lx, c[1] + ly], c, finite(r.rotation) ? r.rotation : 0);
}

/**
 * Rotation-aware resize: drag `handle` of rectangle `r` to world point `p`. The opposite side or corner stays
 * fixed in world space; the rotation is unchanged.
 * @param {{x:number, y:number, w:number, h:number, rotation?:number}} r
 * @param {string} handle  n, s, e, w, ne, nw, se, sw
 * @param {number[]} p     pointer in layout units
 * @param {{ keepAspect?: boolean, min?: number, step?: number }} [o]
 *        keepAspect (corner handles) keeps w:h; min = smallest side; step rounds the new sides to a multiple
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function resizeRect(r, handle, p, { keepAspect = false, min = 0.1, step = 0 } = {}) {
  const c = rectCenter(r);
  const rot = finite(r.rotation) ? r.rotation : 0;
  const [lx, ly] = toLocal(p, r);
  let left = -r.w / 2, right = r.w / 2, top = -r.h / 2, bottom = r.h / 2;
  const E = handle.includes('e'), W = handle.includes('w'), N = handle.includes('n'), S = handle.includes('s');
  if (E) right = Math.max(lx, left + min);
  if (W) left = Math.min(lx, right - min);
  if (S) bottom = Math.max(ly, top + min);
  if (N) top = Math.min(ly, bottom - min);
  let w = right - left, h = bottom - top;
  if (step > 0) {
    if (E || W) w = Math.max(step, Math.round(w / step) * step);
    if (N || S) h = Math.max(step, Math.round(h / step) * step);
  }
  if (keepAspect && (E || W) && (N || S) && r.w > 0 && r.h > 0) {
    const s = Math.max(w / r.w, h / r.h);
    w = Math.max(min, r.w * s);
    h = Math.max(min, r.h * s);
  }
  if (E) right = left + w; else if (W) left = right - w;
  if (S) bottom = top + h; else if (N) top = bottom - h;
  const mid = rotatePoint([c[0] + (left + right) / 2, c[1] + (top + bottom) / 2], c, rot);
  return { x: round4(mid[0] - w / 2), y: round4(mid[1] - h / 2), w: round4(w), h: round4(h) };
}

/**
 * Projective transform (3×3, row-major, h[8] = 1) mapping four source points onto four destination points.
 * @param {number[][]} src  4 points
 * @param {number[][]} dst  4 points
 * @returns {number[]|null} null when the points are degenerate
 */
export function homography(src, dst) {
  if (!Array.isArray(src) || !Array.isArray(dst) || src.length !== 4 || dst.length !== 4) return null;
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Apply a homography to a point. */
export function applyHomography(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * CSS matrix3d() that maps a w × h element (transform-origin 0 0) onto the quad `dst` (TL, TR, BR, BL), all in px.
 * @returns {string|null}
 */
export function cssMatrix3d(w, h, dst) {
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], dst);
  if (!H || !H.every(Number.isFinite)) return null;
  const m = [H[0], H[3], 0, H[6], H[1], H[4], 0, H[7], 0, 0, 1, 0, H[2], H[5], 0, H[8]];
  return `matrix3d(${m.map((v) => (Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(12)))).join(',')})`;
}

/**
 * Best rotated rectangle for four corners (TL, TR, BR, BL): centre = mean, rotation = mean of the top and bottom
 * edge angles, sides = mean opposite lengths. Used to keep background x/y/width/height in step with a 4-corner fit.
 * @returns {{ x: number, y: number, width: number, height: number, rotation: number }}
 */
export function rectFromCorners(corners) {
  const [tl, tr, br, bl] = corners;
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const a1 = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
  const a2 = Math.atan2(br[1] - bl[1], br[0] - bl[0]);
  const rot = Math.atan2(Math.sin(a1) + Math.sin(a2), Math.cos(a1) + Math.cos(a2)) / RAD;
  const width = (Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) + Math.hypot(br[0] - bl[0], br[1] - bl[1])) / 2;
  const height = (Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) + Math.hypot(br[0] - tr[0], br[1] - tr[1])) / 2;
  return { x: round4(cx - width / 2), y: round4(cy - height / 2), width: round4(width), height: round4(height), rotation: normalizeDeg(rot) };
}

/** Scale a point about an origin. */
export function scaleAbout(p, origin, k) {
  return [origin[0] + (p[0] - origin[0]) * k, origin[1] + (p[1] - origin[1]) * k];
}
