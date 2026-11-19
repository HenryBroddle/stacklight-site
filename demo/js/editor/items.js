// Per-item geometry for every layout collection (docs/LAYOUTS.md): bounds, selection outlines, hit tests,
// translation and rotation. Items are never mutated — every change returns a new object. Pure ESM.
import {
  round4, rotatePoint, rectCorners, rectCenter, bboxOfPoints, pointInPolygon, distToPolyline, pointInRect, normalizeDeg,
  polygonArea, bboxCenter,
} from './geometry.js';

/** Layout collections in render order (bottom → top) — mirrors LAYOUT_COLLECTIONS in src/shared/contracts.js. */
export const COLLECTIONS = Object.freeze(['rooms', 'walls', 'doors', 'objects', 'labels', 'machines']);
/** data-kind of each collection — mirrors ITEM_KIND_BY_COLLECTION. */
export const KIND_OF = Object.freeze({ rooms: 'room', walls: 'wall', doors: 'door', objects: 'object', labels: 'label', machines: 'machine' });
export const COLLECTION_OF = Object.freeze(Object.fromEntries(Object.entries(KIND_OF).map(([c, k]) => [k, c])));
/** Default wall thickness by style — mirrors WALL_STYLES in src/shared/contracts.js. */
export const WALL_THICKNESS = Object.freeze({ exterior: 0.75, interior: 0.4, partition: 0.25, former: 0.2 });
/** Default label size by style — mirrors LABEL_STYLES in src/shared/contracts.js. */
export const LABEL_SIZE = Object.freeze({ title: 2.2, room: 1.4, note: 1.0, dim: 0.9 });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isPts = (pts, min) => Array.isArray(pts) && pts.length >= min && pts.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** True for items stored as {x, y, w, h}: machines, objects and rectangular rooms. */
export function isRect(coll, it) {
  if (coll === 'machines' || coll === 'objects') return true;
  return coll === 'rooms' && !Array.isArray(it?.points);
}

/** True when an item is a polygon/polyline (walls, polygon rooms). */
export function isPoly(coll, it) {
  return coll === 'walls' || (coll === 'rooms' && Array.isArray(it?.points));
}

export function wallThickness(w) {
  if (finite(w?.thickness) && w.thickness > 0) return w.thickness;
  return own(WALL_THICKNESS, w?.style ?? 'interior') ?? 0.4;
}

export function labelSize(l) {
  if (finite(l?.size) && l.size > 0) return l.size;
  return own(LABEL_SIZE, l?.style ?? 'note') ?? 1;
}

/**
 * Estimated label text box (layout units) when the DOM cannot measure it: 0.56 em per character.
 * @returns {{ w: number, h: number }}
 */
export function estimateLabelBox(l) {
  const size = labelSize(l);
  const text = typeof l?.text === 'string' ? l.text : '';
  const display = l?.style === 'title' || l?.style === 'room';
  return { w: Math.max(size, text.length * size * (display ? 0.6 : 0.52)), h: size * 1.2 };
}

/**
 * Outline polygon of an item in layout units (what the selection frame follows).
 * @param {string} coll
 * @param {object} it
 * @param {(label: object) => {w:number, h:number}} [measure]  label text box (local, unrotated)
 * @returns {number[][]|null}
 */
export function itemOutline(coll, it, measure = estimateLabelBox) {
  if (!it) return null;
  switch (coll) {
    case 'machines':
    case 'objects':
      return [it.x, it.y, it.w, it.h].every(finite) ? rectCorners(it) : null;
    case 'rooms':
      if (Array.isArray(it.points)) return isPts(it.points, 3) ? it.points.map((p) => [p[0], p[1]]) : null;
      return [it.x, it.y, it.w, it.h].every(finite) ? rectCorners({ ...it, rotation: 0 }) : null;
    case 'walls':
      return isPts(it.points, 2) ? it.points.map((p) => [p[0], p[1]]) : null;
    case 'doors': {
      if (![it.x, it.y, it.width].every(finite)) return null;
      return rectCorners({ x: it.x - it.width / 2, y: it.y - 0.6, w: it.width, h: 1.2, rotation: it.rotation || 0 });
    }
    case 'labels': {
      if (![it.x, it.y].every(finite)) return null;
      const box = measure(it) ?? estimateLabelBox(it);
      return rectCorners({ x: it.x - box.w / 2, y: it.y - box.h / 2, w: box.w, h: box.h, rotation: it.rotation || 0 });
    }
    default:
      return null;
  }
}

/** Axis-aligned bounds of an item (walls include half their thickness). */
export function itemBounds(coll, it, measure = estimateLabelBox) {
  const pts = itemOutline(coll, it, measure);
  const b = pts ? bboxOfPoints(pts) : null;
  if (b && coll === 'walls') {
    const t = wallThickness(it) / 2;
    return { minX: b.minX - t, minY: b.minY - t, maxX: b.maxX + t, maxY: b.maxY + t };
  }
  return b;
}

/** Bounds used for snapping and alignment: wall centre lines, not their thickness. */
export function itemSnapBounds(coll, it, measure = estimateLabelBox) {
  const pts = itemOutline(coll, it, measure);
  return pts ? bboxOfPoints(pts) : null;
}

/** Centre of an item (rect centre, door/label anchor, bbox centre for polylines). */
export function itemCenter(coll, it, measure = estimateLabelBox) {
  if (isRect(coll, it)) return rectCenter(it);
  if (coll === 'doors' || coll === 'labels') return [it.x, it.y];
  const b = itemBounds(coll, it, measure);
  return b ? bboxCenter(b) : [0, 0];
}

/** Item rotation in degrees (0 for collections without rotation). */
export function itemRotation(coll, it) {
  return coll === 'rooms' || coll === 'walls' ? 0 : finite(it?.rotation) ? it.rotation : 0;
}

/**
 * Hit test: is layout point p on the item? `tol` (layout units) widens thin things (walls, doors, outlines).
 * Rooms are hit inside their area; everything else on its body.
 */
export function hitItem(coll, it, p, tol = 0, measure = estimateLabelBox) {
  switch (coll) {
    case 'machines':
    case 'objects':
      return [it.x, it.y, it.w, it.h].every(finite) && pointInRect(p, it, tol * 0.5);
    case 'rooms':
      if (Array.isArray(it.points)) return isPts(it.points, 3) && (pointInPolygon(p, it.points) || distToPolyline(p, it.points, true) <= tol * 0.5);
      return [it.x, it.y, it.w, it.h].every(finite) && pointInRect(p, { ...it, rotation: 0 }, tol * 0.5);
    case 'walls':
      return isPts(it.points, 2) && distToPolyline(p, it.points, !!it.closed) <= wallThickness(it) / 2 + tol;
    case 'doors':
    case 'labels': {
      const o = itemOutline(coll, it, measure);
      return !!o && (pointInPolygon(p, o) || distToPolyline(p, o, true) <= tol * 0.5);
    }
    default:
      return false;
  }
}

/** Area in square layout units (rooms: polygon or rectangle; rect items: w × h). */
export function itemArea(coll, it) {
  if (coll === 'rooms' && Array.isArray(it.points)) return polygonArea(it.points);
  if (isRect(coll, it)) return finite(it.w) && finite(it.h) ? it.w * it.h : 0;
  return 0;
}

const movePts = (pts, dx, dy) => pts.map((p) => [round4(p[0] + dx), round4(p[1] + dy)]);

/** Item moved by (dx, dy). */
export function translateItem(coll, it, dx, dy) {
  if (!dx && !dy) return it;
  if (isPoly(coll, it)) return Array.isArray(it.points) ? { ...it, points: movePts(it.points, dx, dy) } : it;
  if (!finite(it.x) || !finite(it.y)) return it;
  return { ...it, x: round4(it.x + dx), y: round4(it.y + dy) };
}

/**
 * Item rotated by `deg` about `centre` (default: its own centre). Rect items and doors/labels gain rotation;
 * polylines rotate their points; a rectangular room stays a rectangle for multiples of 90° (sides swap) and
 * becomes a polygon otherwise.
 * @returns {object}
 */
export function rotateItem(coll, it, deg, centre = null) {
  if (!deg) return it;
  const c = centre ?? itemCenter(coll, it);
  if (isPoly(coll, it)) {
    return Array.isArray(it.points) ? { ...it, points: it.points.map((p) => rotatePoint(p, c, deg).map(round4)) } : it;
  }
  if (coll === 'rooms') {
    const quarter = Math.abs(deg % 90) < 1e-9;
    if (quarter) {
      const [ox, oy] = rotatePoint(rectCenter(it), c, deg);
      const odd = Math.abs(Math.round(deg / 90)) % 2 === 1;
      const w = odd ? it.h : it.w, h = odd ? it.w : it.h;
      return { ...it, x: round4(ox - w / 2), y: round4(oy - h / 2), w, h };
    }
    const { x, y, w, h, ...rest } = it;
    return { ...rest, points: rectCorners({ x, y, w, h, rotation: 0 }).map((p) => rotatePoint(p, c, deg).map(round4)) };
  }
  if (coll === 'doors' || coll === 'labels') {
    const [nx, ny] = rotatePoint([it.x, it.y], c, deg);
    return { ...it, x: round4(nx), y: round4(ny), rotation: normalizeDeg((it.rotation || 0) + deg) };
  }
  const [ox, oy] = rotatePoint(rectCenter(it), c, deg);
  return { ...it, x: round4(ox - it.w / 2), y: round4(oy - it.h / 2), rotation: normalizeDeg((it.rotation || 0) + deg) };
}

/** Item with its rotation set to an absolute angle (about its own centre). */
export function setItemRotation(coll, it, deg) {
  const cur = itemRotation(coll, it);
  return rotateItem(coll, it, normalizeDeg(deg - cur));
}
