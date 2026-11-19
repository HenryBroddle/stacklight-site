// Name callouts for machine tiles that cannot show their whole name (pure geometry, no DOM, no imports;
// unit-tested in test/unit/callouts.test.js). DECISIONS D4 keeps the tile's own content priority (a narrow tile
// shows its glyph, not a cut name like "3-Axi…"); the plan still has to say which machine is which at TV distance,
// so the full name goes on a plate next to the tile with a short leader line. Plates never cover a machine tile or
// its attention-ring band, never cover each other, stay inside the visible view box and avoid room/object names
// where they can. A plate also keeps clearly closer to its own tile than to any other, so it is not read as a
// neighbour's name, and stays inside the plan outline whenever any allowed spot there exists. A plate keeps its
// spot relative to its tile (same side, same slide) across redraws and small zoom changes while that spot is still
// allowed, so plates do not jump when, say, the stale banner shrinks the plan. Everything is in one coordinate
// system (the floor plan uses layout units).

/** @typedef {[number, number]} Pt */
/** @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Box */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Corners of a w × h rectangle at (x, y) rotated by `deg` about its centre (clockwise in SVG's y-down space). */
export function tilePolygon({ x, y, w, h, rotation = 0 }) {
  const cx = x + w / 2, cy = y + h / 2;
  const t = ((finite(rotation) ? rotation : 0) * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => [cx + dx * c - dy * s, cy + dx * s + dy * c]);
}

export function polygonBox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

const grow = (b, m) => ({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });
const boxesOverlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
/** Gap between two boxes (0 when they touch or overlap). */
const boxGap = (a, b) => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
const overlapArea = (a, b) => Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));

/** Separating-axis test: does the convex polygon `poly` overlap the axis-aligned box `b` (open intervals)? */
export function polygonHitsBox(poly, b) {
  const pb = polygonBox(poly);
  if (!boxesOverlap(pb, b)) return false;
  const corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const nx = y1 - y2, ny = x2 - x1; // edge normal
    if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12) continue;
    const proj = (p) => p[0] * nx + p[1] * ny;
    let pMin = Infinity, pMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of poly) { const v = proj(p); pMin = Math.min(pMin, v); pMax = Math.max(pMax, v); }
    for (const p of corners) { const v = proj(p); bMin = Math.min(bMin, v); bMax = Math.max(bMax, v); }
    if (pMax <= bMin || bMax <= pMin) return false;
  }
  return true;
}

/** Polygon grown outwards by `m` (each corner pushed along its diagonal; exact for rectangles). */
function growPolygon(poly, m) {
  if (!(m > 0)) return poly;
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length; cy /= poly.length;
  const n = poly.length;
  return poly.map(([x, y], i) => {
    // offset point = corner + m·(unit normal of the previous edge + unit normal of the next edge)
    const [px, py] = poly[(i - 1 + n) % n];
    const [qx, qy] = poly[(i + 1) % n];
    const nrm = (ax, ay, bx, by) => {
      let nx = by - ay, ny = -(bx - ax);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      // point it away from the centre
      if (nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      return [nx, ny];
    };
    const [n1x, n1y] = nrm(px, py, x, y);
    const [n2x, n2y] = nrm(x, y, qx, qy);
    return [x + m * (n1x + n2x), y + m * (n1y + n2y)];
  });
}

/** Closest point to `p` on the boundary of polygon `poly`. */
export function nearestOnPolygon(poly, [px, py]) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
    const qx = x1 + t * dx, qy = y1 + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < bestD) { bestD = d; best = [qx, qy]; }
  }
  return best;
}

/** Leader line from the edge of plate box `b` towards point `to` (the tile edge). */
export function leaderLine(b, to) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const dx = to[0] - cx, dy = to[1] - cy;
  const hw = (b.maxX - b.minX) / 2, hh = (b.maxY - b.minY) / 2;
  const t = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
  const from = t < 1 ? [cx + dx * t, cy + dy * t] : [cx, cy];
  return { from, to: [to[0], to[1]] };
}

const SIDE_COST = Object.freeze({ top: 0, bottom: 0.25, right: 0.45, left: 0.45 });
/** Cost of a plate that sits almost as close to another machine as to its own one (scaled by how close). */
const AMBIGUOUS_COST = 3;
/** A plate outside the plan outline: only when no allowed spot inside exists. */
const OUTSIDE_COST = 50;
/** A plate at least as close to another machine as to its own one reads as that machine's name: last resort. */
const CONFUSED_COST = 100;
/** How much worse (in cost) the previous spot may be than the best one and still be kept. */
const KEEP_SLACK = 0.5;
const EPS = 1e-6;

/**
 * Place name plates.
 * @param {{ id: string, poly: Pt[], sizes: { w: number, h: number }[] }[]} requests
 *   tiles that need a callout, in priority order; `sizes` = plate sizes to try, preferred first
 * @param {{ tiles: Pt[][], soft?: { box: Box, weight?: number }[], bounds: Box, margin: number, gap: number,
 *           prefer?: Box|null, prev?: Map<string, { box: Box, size: number, pos: number }> }} env
 *   tiles = every machine footprint (hard obstacles, grown by `margin` = attention-ring band);
 *   soft = room/object names and outlines (penalised by covered fraction × weight); bounds = visible area;
 *   gap = clearance between plates; prefer = plan outline (a plate leaves it only when no allowed spot inside
 *   exists); prev = last placements (their spot is kept while still valid and not clearly worse, so plates do not jump)
 * @returns {Map<string, { box: Box, size: number, pos: number, spot: string, leader: { from: Pt, to: Pt } }>}
 *   size = index into `sizes`; pos = positional cost; spot = side and slide relative to the tile
 *   (pass the map back as `prev`)
 */
export function placeCallouts(requests, { tiles, soft = [], bounds, margin, gap, prefer = null, prev = null }) {
  const out = new Map();
  const hard = tiles.map((p) => growPolygon(p, margin));
  const placed = [];
  const valid = (b) => b.minX >= bounds.minX && b.maxX <= bounds.maxX && b.minY >= bounds.minY && b.maxY <= bounds.maxY
    && !hard.some((p) => polygonHitsBox(p, b))
    && !placed.some((q) => boxesOverlap(grow(q, gap), b));
  const softCost = (b) => {
    const area = (b.maxX - b.minX) * (b.maxY - b.minY) || 1;
    let c = 0;
    for (const s of soft) c += (overlapArea(b, s.box) / Math.min(area, Math.max(1e-9, (s.box.maxX - s.box.minX) * (s.box.maxY - s.box.minY)))) * (s.weight ?? 1);
    if (prefer) {
      c += (1 - overlapArea(b, prefer) / area) * 0.6;
      const inside = b.minX >= prefer.minX - EPS && b.maxX <= prefer.maxX + EPS && b.minY >= prefer.minY - EPS && b.maxY <= prefer.maxY + EPS;
      if (!inside) c += OUTSIDE_COST;
    }
    return c;
  };
  for (const req of requests) {
    if (!Array.isArray(req.poly) || req.poly.length < 3 || !req.sizes?.length) continue;
    const tb = polygonBox(req.poly);
    const tcx = (tb.minX + tb.maxX) / 2, tcy = (tb.minY + tb.maxY) / 2;
    const near = (a, b) => Math.abs(a.minX - b.minX) < 1e-6 && Math.abs(a.minY - b.minY) < 1e-6 && Math.abs(a.maxX - b.maxX) < 1e-6 && Math.abs(a.maxY - b.maxY) < 1e-6;
    const others = tiles.map(polygonBox).filter((b) => !near(b, tb));
    // a plate must be clearly closer to its own tile than to any other one, or the name reads as the neighbour's
    const ambiguity = (b) => {
      const own = boxGap(b, tb), h = b.maxY - b.minY;
      let worst = 0;
      let confused = false;
      for (const o of others) {
        const g = boxGap(b, o);
        if (g <= own + EPS) confused = true;
        worst = Math.max(worst, Math.min(1, Math.max(0, (own + h - g) / h)));
      }
      return worst * AMBIGUOUS_COST + (confused ? CONFUSED_COST : 0);
    };
    const costOf = (b) => softCost(b) + ambiguity(b);
    const old = prev?.get(req.id);
    let best = null;
    let same = null; // the previous spot (same side and slide, same plate size), if still valid
    const consider = (b, pos, size, spot) => {
      const isOld = !!old && old.spot === spot && old.size === size;
      if (!isOld && best && pos >= best.cost) return;
      const cost = pos + costOf(b);
      if (isOld && valid(b)) same = { box: b, cost, pos, size, spot };
      if (best && cost >= best.cost) return;
      if (!valid(b)) return;
      best = { box: b, cost, pos, size, spot };
    };
    req.sizes.forEach(({ w, h }, si) => {
      const steps = [0, 0.8, 1.8, 3]; // extra distance (in plate heights) beyond the ring band
      steps.forEach((k, di) => {
        const d = margin + gap + k * h;
        const base = si * 2 + di * 1.2;
        // top / bottom: slide the plate along the edge (centred first)
        const xs = [tcx, tb.minX + w / 2, tb.maxX - w / 2, tb.minX - w / 2 + h, tb.maxX + w / 2 - h, tcx - w * 0.75, tcx + w * 0.75];
        xs.forEach((cx, xi) => {
          const slide = xi === 0 ? 0 : 0.3 + Math.abs(cx - tcx) / Math.max(w, 1e-9) * 0.4;
          const top = { minX: cx - w / 2, maxX: cx + w / 2, maxY: tb.minY - d, minY: tb.minY - d - h };
          const bottom = { minX: cx - w / 2, maxX: cx + w / 2, minY: tb.maxY + d, maxY: tb.maxY + d + h };
          for (const [side, b] of [['top', top], ['bottom', bottom]]) consider(b, base + SIDE_COST[side] + slide, si, `${side}:${xi}:${di}`);
        });
        // left / right: centred vertically, then sliding along the edge
        const ys = [tcy, tb.minY + h / 2, tb.maxY - h / 2, tcy - h * 1.5, tcy + h * 1.5];
        ys.forEach((cy, yi) => {
          const slide = yi === 0 ? 0 : 0.3 + Math.abs(cy - tcy) / Math.max(h, 1e-9) * 0.1;
          const left = { maxX: tb.minX - d, minX: tb.minX - d - w, minY: cy - h / 2, maxY: cy + h / 2 };
          const right = { minX: tb.maxX + d, maxX: tb.maxX + d + w, minY: cy - h / 2, maxY: cy + h / 2 };
          for (const [side, b] of [['left', left], ['right', right]]) consider(b, base + SIDE_COST[side] + slide, si, `${side}:${yi}:${di}`);
        });
      });
    });
    // keep the previous spot while it is still valid and not clearly worse (no jumping plates): the same side and
    // slide relative to the tile (survives zoom and view changes, e.g. the stale banner shrinking the plan), else
    // the very same box (a placement passed in without a spot)
    if (same && best && same.cost <= best.cost + KEEP_SLACK) best = same;
    else if (old?.box && !old.spot && best && old.size === best.size && finite(old.pos)) {
      const ob = old.box;
      const sameSize = Math.abs((ob.maxX - ob.minX) - (best.box.maxX - best.box.minX)) < EPS && Math.abs((ob.maxY - ob.minY) - (best.box.maxY - best.box.minY)) < EPS;
      const oldCost = old.pos + costOf(ob);
      if (sameSize && oldCost <= best.cost + KEEP_SLACK && valid(ob)) best = { box: ob, cost: oldCost, pos: old.pos, size: old.size, spot: null };
    }
    if (!best) continue;
    placed.push(best.box);
    const b = best.box;
    const to = nearestOnPolygon(req.poly, [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
    out.set(req.id, { box: b, size: best.size, pos: best.pos, spot: best.spot, leader: leaderLine(b, to) });
  }
  return out;
}
