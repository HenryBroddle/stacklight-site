// Snapping for the layout editor (DECISIONS D5): grid, object edges and centres, wall endpoints/vertices and
// wall segments, with guide lines to draw. Tolerances are in layout units (the caller converts screen px with the
// current zoom). Pure ESM — unit-tested in Node.
import { nearestOnSegment, segmentsOf, round4 } from './geometry.js';
import { COLLECTIONS, itemSnapBounds, isPoly } from './items.js';

/**
 * @typedef {{ v: number, lo: number, hi: number, kind: string }} LineTarget   a vertical (x) or horizontal (y) line
 * @typedef {{ p: number[], kind: string }} PointTarget
 * @typedef {{ a: number[], b: number[], id: string }} SegmentTarget
 * @typedef {{ xs: LineTarget[], ys: LineTarget[], points: PointTarget[], segments: SegmentTarget[] }} Targets
 * @typedef {{ x1: number, y1: number, x2: number, y2: number, kind?: string }} Guide
 */

/**
 * Collect snap targets from a document.
 * @param {object} doc
 * @param {{ exclude?: Set<string>, measure?: Function, bounds?: boolean, skip?: (coll: string, item: object) => boolean }} [o]
 *   exclude: ids being moved; skip: e.g. hidden layers; bounds: include the drawing area edges
 * @returns {Targets}
 */
export function collectTargets(doc, { exclude = new Set(), measure, bounds = true, skip = null } = {}) {
  const xs = [], ys = [], points = [], segments = [];
  const addBox = (b, kind) => {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    for (const v of [b.minX, cx, b.maxX]) xs.push({ v, lo: b.minY, hi: b.maxY, kind: v === cx ? `${kind}-center` : kind });
    for (const v of [b.minY, cy, b.maxY]) ys.push({ v, lo: b.minX, hi: b.maxX, kind: v === cy ? `${kind}-center` : kind });
  };
  for (const coll of COLLECTIONS) {
    for (const it of doc?.[coll] ?? []) {
      if (!it || exclude.has(it.id) || skip?.(coll, it)) continue;
      if (isPoly(coll, it)) {
        if (!Array.isArray(it.points)) continue;
        for (const p of it.points) {
          if (!Array.isArray(p)) continue;
          points.push({ p, kind: coll === 'walls' ? 'wall-vertex' : 'room-vertex' });
          xs.push({ v: p[0], lo: p[1], hi: p[1], kind: 'vertex' });
          ys.push({ v: p[1], lo: p[0], hi: p[0], kind: 'vertex' });
        }
        if (coll === 'walls') for (const [a, b] of segmentsOf(it.points, !!it.closed)) segments.push({ a, b, id: it.id });
        continue;
      }
      if (coll === 'labels') continue; // labels are notes, not geometry
      const b = itemSnapBounds(coll, it, measure);
      if (b) addBox(b, coll === 'doors' ? 'door' : 'edge');
      if (coll === 'doors' && Number.isFinite(it.x)) points.push({ p: [it.x, it.y], kind: 'door' });
    }
  }
  if (bounds && Number.isFinite(doc?.width) && Number.isFinite(doc?.height)) {
    xs.push({ v: 0, lo: 0, hi: doc.height, kind: 'bounds' }, { v: doc.width, lo: 0, hi: doc.height, kind: 'bounds' });
    ys.push({ v: 0, lo: 0, hi: doc.width, kind: 'bounds' }, { v: doc.height, lo: 0, hi: doc.width, kind: 'bounds' });
  }
  return { xs, ys, points, segments };
}

const gridRound = (v, g) => (g > 0 ? round4(Math.round(v / g) * g) : v);

/** Best line target for any of `values` within tol → { corr, target, value } or null. */
function bestLine(values, lines, tol) {
  let best = null;
  for (const value of values) {
    for (const t of lines) {
      const d = t.v - value;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.corr) - 1e-9)) best = { corr: d, target: t, value };
    }
  }
  return best;
}

/**
 * Snap a moving bounding box. Object targets win over the grid; the grid moves `anchor` (default: the box's
 * top-left) onto grid lines.
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} box   box at the start of the drag
 * @param {number} dx  raw drag delta
 * @param {number} dy
 * @param {Targets} targets
 * @param {{ tol: number, grid?: number, gridSnap?: boolean, objectSnap?: boolean, anchor?: number[] }} o
 * @returns {{ dx: number, dy: number, guides: Guide[], snapX: string|null, snapY: string|null }}
 */
export function snapMove(box, dx, dy, targets, { tol, grid = 0, gridSnap = true, objectSnap = true, anchor = null }) {
  const guides = [];
  const moved = { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy };
  let snapX = null, snapY = null;
  const bx = objectSnap ? bestLine([moved.minX, (moved.minX + moved.maxX) / 2, moved.maxX], targets.xs, tol) : null;
  const by = objectSnap ? bestLine([moved.minY, (moved.minY + moved.maxY) / 2, moved.maxY], targets.ys, tol) : null;
  if (bx) { dx += bx.corr; snapX = bx.target.kind; }
  else if (gridSnap && grid > 0) { const ax = (anchor ? anchor[0] : box.minX) + dx; dx += gridRound(ax, grid) - ax; snapX = 'grid'; }
  if (by) { dy += by.corr; snapY = by.target.kind; }
  else if (gridSnap && grid > 0) { const ay = (anchor ? anchor[1] : box.minY) + dy; dy += gridRound(ay, grid) - ay; snapY = 'grid'; }
  const final = { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy };
  if (bx) {
    const x = bx.target.v;
    guides.push({ x1: x, y1: Math.min(final.minY, bx.target.lo), x2: x, y2: Math.max(final.maxY, bx.target.hi), kind: 'x' });
  }
  if (by) {
    const y = by.target.v;
    guides.push({ x1: Math.min(final.minX, by.target.lo), y1: y, x2: Math.max(final.maxX, by.target.hi), y2: y, kind: 'y' });
  }
  return { dx: round4(dx), dy: round4(dy), guides, snapX, snapY };
}

/**
 * Snap one point (wall drawing, vertex drag, resize handles, placing items).
 * Order: vertices/door centres (2-D distance) → wall segments → x/y alignment with vertices and edges → grid.
 * @param {number[]} p
 * @param {Targets} targets
 * @param {{ tol: number, grid?: number, gridSnap?: boolean, objectSnap?: boolean, segments?: boolean }} o
 * @returns {{ point: number[], guides: Guide[], kind: string|null }}
 */
export function snapPoint(p, targets, { tol, grid = 0, gridSnap = true, objectSnap = true, segments = true }) {
  const guides = [];
  if (objectSnap) {
    let best = null;
    for (const t of targets.points) {
      const d = Math.hypot(t.p[0] - p[0], t.p[1] - p[1]);
      if (d <= tol && (!best || d < best.d)) best = { d, t };
    }
    if (best) return { point: [best.t.p[0], best.t.p[1]], guides: [{ x1: best.t.p[0], y1: best.t.p[1], x2: best.t.p[0], y2: best.t.p[1], kind: 'point' }], kind: best.t.kind };
    if (segments) {
      let seg = null;
      for (const s of targets.segments) {
        const r = nearestOnSegment(p, s.a, s.b);
        if (r.dist <= tol * 0.75 && (!seg || r.dist < seg.dist)) seg = r;
      }
      if (seg) return { point: [round4(seg.point[0]), round4(seg.point[1])], guides: [{ x1: seg.point[0], y1: seg.point[1], x2: seg.point[0], y2: seg.point[1], kind: 'on-wall' }], kind: 'segment' };
    }
  }
  let [x, y] = p;
  let kind = null;
  const bx = objectSnap ? bestLine([x], targets.xs, tol) : null;
  const by = objectSnap ? bestLine([y], targets.ys, tol) : null;
  if (bx) { x = bx.target.v; kind = 'align'; } else if (gridSnap && grid > 0) { x = gridRound(x, grid); kind = kind ?? 'grid'; }
  if (by) { y = by.target.v; kind = 'align'; } else if (gridSnap && grid > 0) { y = gridRound(y, grid); kind = kind ?? 'grid'; }
  if (bx) guides.push({ x1: x, y1: Math.min(y, bx.target.lo), x2: x, y2: Math.max(y, bx.target.hi), kind: 'x' });
  if (by) guides.push({ x1: Math.min(x, by.target.lo), y1: y, x2: Math.max(x, by.target.hi), y2: y, kind: 'y' });
  return { point: [round4(x), round4(y)], guides, kind };
}
