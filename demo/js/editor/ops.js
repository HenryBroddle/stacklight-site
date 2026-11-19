// Layout document operations for the editor. Documents are treated as immutable: every operation returns a new
// layout that shares unchanged items with the old one, so undo history is cheap (DECISIONS D5: ≥ 200 steps).
// Pure ESM (no DOM, no /shared imports) — unit-tested in Node.
import { round4, bboxUnion, bboxWidth, bboxHeight, nearestOnSegment, segmentsOf, lineAngle } from './geometry.js';
import { COLLECTIONS, KIND_OF, translateItem, rotateItem, itemCenter, itemSnapBounds, isPoly } from './items.js';

/** Id prefix per collection — mirrors ID_PREFIX in src/shared/layout.js (newId). */
export const ID_PREFIX = Object.freeze({ walls: 'w', doors: 'd', rooms: 'r', objects: 'o', labels: 'l', machines: 'm' });
/** Clipboard payload type (also written to the system clipboard as JSON text). */
export const CLIPBOARD_KIND = 'machine-shop-hud/clipboard@1';
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** Every item: [collection, item, index]. */
export function* eachItem(doc) {
  for (const coll of COLLECTIONS) {
    const arr = doc?.[coll];
    if (Array.isArray(arr)) for (let i = 0; i < arr.length; i++) if (arr[i]) yield [coll, arr[i], i];
  }
}

/** Find an item by id → { coll, index, item } or null. */
export function findItem(doc, id) {
  for (const [coll, item, index] of eachItem(doc)) if (item.id === id) return { coll, index, item };
  return null;
}

/** Map id → { coll, index, item } for the whole document. */
export function indexItems(doc) {
  const map = new Map();
  for (const [coll, item, index] of eachItem(doc)) if (typeof item.id === 'string') map.set(item.id, { coll, index, item });
  return map;
}

/**
 * Id generator for one document: `next('machines')` → 'm-7', never repeating ids it handed out before or that
 * are in use (ids are unique across all collections).
 */
export function idFactory(doc) {
  const used = new Set();
  for (const [, it] of eachItem(doc)) if (typeof it.id === 'string') used.add(it.id);
  const counters = new Map();
  return {
    used,
    next(coll) {
      const prefix = own(ID_PREFIX, coll) ?? 'i';
      let n = counters.get(prefix);
      if (n === undefined) {
        n = 1;
        const re = new RegExp(`^${prefix}-(\\d+)$`);
        for (const id of used) {
          const m = re.exec(id);
          const k = m ? Number(m[1]) : NaN;
          if (Number.isSafeInteger(k) && k >= n) n = k + 1;
        }
        if (!Number.isSafeInteger(n)) n = 1;
      }
      while (used.has(`${prefix}-${n}`)) n++;
      const id = `${prefix}-${n}`;
      used.add(id);
      counters.set(prefix, n + 1);
      return id;
    },
  };
}

/** A fresh id unique within the document. */
export function newItemId(doc, coll) {
  return idFactory(doc).next(coll);
}

/** Shallow-copied document with new arrays for the touched collections. */
function withCollections(doc, colls) {
  const out = { ...doc };
  for (const c of colls) out[c] = Array.isArray(doc[c]) ? [...doc[c]] : [];
  return out;
}

/** Add items: entries = [{ coll, item }]. Items keep their ids (call idFactory first). */
export function addItems(doc, entries) {
  if (!entries.length) return doc;
  const out = withCollections(doc, new Set(entries.map((e) => e.coll)));
  for (const { coll, item } of entries) out[coll].push(item);
  return out;
}

/**
 * Replace items through `fn(item, coll)` for the given ids; `fn` returns the new item (or the same one).
 * A returned object with a different `__coll` key is moved to that collection (used by convert).
 */
export function mapItems(doc, ids, fn) {
  const want = ids instanceof Set ? ids : new Set(ids);
  if (!want.size) return doc;
  let out = null;
  for (const coll of COLLECTIONS) {
    const arr = doc[coll];
    if (!Array.isArray(arr)) continue;
    let next = null;
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (!it || !want.has(it.id)) continue;
      const nv = fn(it, coll);
      if (nv === it) continue;
      if (!next) next = [...arr];
      next[i] = nv;
    }
    if (next) {
      if (!out) out = { ...doc };
      out[coll] = next;
    }
  }
  return out ?? doc;
}

/** Shallow-merge a patch into one item; keys whose value is undefined are removed. */
export function updateItem(doc, id, patch) {
  return mapItems(doc, [id], (it) => {
    const next = { ...it };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    return JSON.stringify(next) === JSON.stringify(it) ? it : next;
  });
}

/** Remove items by id. */
export function removeItems(doc, ids) {
  const want = ids instanceof Set ? ids : new Set(ids);
  if (!want.size) return doc;
  let out = null;
  for (const coll of COLLECTIONS) {
    const arr = doc[coll];
    if (!Array.isArray(arr) || !arr.some((it) => it && want.has(it.id))) continue;
    if (!out) out = { ...doc };
    out[coll] = arr.filter((it) => !(it && want.has(it.id)));
  }
  return out ?? doc;
}

/** Top-level fields (name, width, grid, background, …); undefined removes a key. */
export function updateDoc(doc, patch) {
  const out = { ...doc };
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (COLLECTIONS.includes(k) || k === 'schema' || k === 'id') continue;
    if (v === undefined) { if (k in out) { delete out[k]; changed = true; } } else if (JSON.stringify(out[k]) !== JSON.stringify(v)) { out[k] = v; changed = true; }
  }
  return changed ? out : doc;
}

/** Move items by (dx, dy) layout units. Locked items are skipped unless `force`. */
export function moveItems(doc, ids, dx, dy, { force = false } = {}) {
  if (!dx && !dy) return doc;
  return mapItems(doc, ids, (it, coll) => (it.locked && !force ? it : translateItem(coll, it, dx, dy)));
}

/**
 * Rotate items by `deg`. One item rotates about its own centre; several about `centre` (default: the centre of
 * their combined bounds), so the group turns as a whole.
 */
export function rotateItems(doc, ids, deg, { centre = null, measure } = {}) {
  const list = [...(ids instanceof Set ? ids : new Set(ids))];
  if (!deg || !list.length) return doc;
  let c = centre;
  if (!c && list.length > 1) {
    const boxes = list.map((id) => findItem(doc, id)).filter(Boolean).map((f) => itemSnapBounds(f.coll, f.item, measure));
    const b = bboxUnion(boxes);
    c = b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : null;
  }
  return mapItems(doc, list, (it, coll) => (it.locked ? it : rotateItem(coll, it, deg, c ?? itemCenter(coll, it, measure))));
}

/** Set `locked` on items (false removes the key — the default). */
export function setLocked(doc, ids, locked) {
  return mapItems(doc, ids, (it) => {
    if (!!it.locked === !!locked) return it;
    const next = { ...it };
    if (locked) next.locked = true; else delete next.locked;
    return next;
  });
}

/** Deep copy of plain JSON data. */
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Duplicate items with fresh ids, offset by (dx, dy). The copies are added right after the originals' collection
 * ends (on top). Machine links are not copied (two tiles must not show the same controller).
 * @returns {{ doc: object, ids: string[] }}
 */
export function duplicateItems(doc, ids, { dx = 1, dy = 1 } = {}) {
  const payload = copyItems(doc, ids);
  return pasteItems(doc, payload, { dx, dy });
}

/**
 * Clipboard payload for items (deep copies, in layout order).
 * @returns {{ kind: string, units: string, items: {coll: string, item: object}[] }}
 */
export function copyItems(doc, ids) {
  const want = ids instanceof Set ? ids : new Set(ids);
  const items = [];
  for (const [coll, item] of eachItem(doc)) if (want.has(item.id)) items.push({ coll, item: clone(item) });
  return { kind: CLIPBOARD_KIND, units: doc.units ?? 'ft', items };
}

/** Parse clipboard text (JSON payload) → payload or null. */
export function parseClipboard(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isObj(data) || data.kind !== CLIPBOARD_KIND || !Array.isArray(data.items)) return null;
  const items = data.items.filter((e) => isObj(e) && COLLECTIONS.includes(e.coll) && isObj(e.item)).slice(0, 2000);
  return items.length ? { kind: CLIPBOARD_KIND, units: data.units === 'm' ? 'm' : 'ft', items } : null;
}

/**
 * Paste a clipboard payload with fresh ids, offset by (dx, dy).
 * @returns {{ doc: object, ids: string[] }}
 */
export function pasteItems(doc, payload, { dx = 0, dy = 0 } = {}) {
  if (!payload?.items?.length) return { doc, ids: [] };
  const ids = idFactory(doc);
  const entries = [];
  for (const { coll, item } of payload.items) {
    const copy = translateItem(coll, clone(item), dx, dy);
    copy.id = ids.next(coll);
    if (coll === 'machines') copy.source = null;
    delete copy.locked;
    entries.push({ coll, item: copy });
  }
  return { doc: addItems(doc, entries), ids: entries.map((e) => e.item.id) };
}

/**
 * Align items to the selection bounds: left | hcenter | right | top | vcenter | bottom. Uses each item's
 * axis-aligned snap bounds, so rotated items align by their visual extent.
 */
export function alignItems(doc, ids, mode, measure) {
  const found = [...ids].map((id) => findItem(doc, id)).filter((f) => f && !f.item.locked);
  if (found.length < 2) return doc;
  const boxes = new Map(found.map((f) => [f.item.id, itemSnapBounds(f.coll, f.item, measure)]));
  const all = bboxUnion([...boxes.values()]);
  if (!all) return doc;
  return mapItems(doc, found.map((f) => f.item.id), (it, coll) => {
    const b = boxes.get(it.id);
    if (!b) return it;
    let dx = 0, dy = 0;
    switch (mode) {
      case 'left': dx = all.minX - b.minX; break;
      case 'right': dx = all.maxX - b.maxX; break;
      case 'hcenter': dx = (all.minX + all.maxX) / 2 - (b.minX + b.maxX) / 2; break;
      case 'top': dy = all.minY - b.minY; break;
      case 'bottom': dy = all.maxY - b.maxY; break;
      case 'vcenter': dy = (all.minY + all.maxY) / 2 - (b.minY + b.maxY) / 2; break;
      default: return it;
    }
    return translateItem(coll, it, round4(dx), round4(dy));
  });
}

/**
 * Distribute ≥ 3 items so the gaps between them are equal along 'x' or 'y' (first and last stay put).
 */
export function distributeItems(doc, ids, axis, measure) {
  const found = [...ids].map((id) => findItem(doc, id)).filter((f) => f && !f.item.locked);
  if (found.length < 3) return doc;
  const lo = axis === 'y' ? 'minY' : 'minX';
  const hi = axis === 'y' ? 'maxY' : 'maxX';
  const rows = found.map((f) => ({ f, b: itemSnapBounds(f.coll, f.item, measure) })).filter((r) => r.b);
  rows.sort((a, b) => (a.b[lo] + a.b[hi]) - (b.b[lo] + b.b[hi]));
  const span = rows[rows.length - 1].b[hi] - rows[0].b[lo];
  const sizes = rows.reduce((s, r) => s + (r.b[hi] - r.b[lo]), 0);
  const gap = (span - sizes) / (rows.length - 1);
  const shift = new Map();
  let cursor = rows[0].b[lo];
  for (const r of rows) {
    shift.set(r.f.item.id, round4(cursor - r.b[lo]));
    cursor += r.b[hi] - r.b[lo] + gap;
  }
  return mapItems(doc, rows.map((r) => r.f.item.id), (it, coll) => {
    const d = shift.get(it.id) ?? 0;
    return axis === 'y' ? translateItem(coll, it, 0, d) : translateItem(coll, it, d, 0);
  });
}

/**
 * Convert a generic object into a machine or back (DECISIONS D5 "convert object ↔ machine"). The item keeps its
 * place, size, rotation, name and notes and gets a fresh id with the right prefix; machine-only fields (source,
 * thresholds, statusMap, tags) are dropped when it becomes an object.
 * @returns {{ doc: object, id: string|null }}
 */
export function convertItem(doc, id, to) {
  const f = findItem(doc, id);
  if (!f || f.coll === to || !['objects', 'machines'].includes(f.coll) || !['objects', 'machines'].includes(to)) return { doc, id: null };
  const it = f.item;
  const nid = idFactory(doc).next(to);
  const base = { id: nid, name: typeof it.name === 'string' && it.name.trim() ? it.name : to === 'machines' ? 'Machine' : 'Object', x: it.x, y: it.y, w: it.w, h: it.h };
  if (finite(it.rotation) && it.rotation) base.rotation = it.rotation;
  if (typeof it.notes === 'string' && it.notes) base.notes = it.notes;
  if (it.locked) base.locked = true;
  const item = to === 'machines' ? { ...base, kind: 'other', source: null } : { ...base, kind: 'generic' };
  const removed = removeItems(doc, [id]);
  const out = withCollections(removed, [to]);
  out[to].push(item);
  return { doc: out, id: nid };
}

/** Bring items to the top (end of their collection) or send them to the bottom. */
export function reorderItems(doc, ids, where = 'front') {
  const want = ids instanceof Set ? ids : new Set(ids);
  let out = null;
  for (const coll of COLLECTIONS) {
    const arr = doc[coll];
    if (!Array.isArray(arr) || !arr.some((it) => it && want.has(it.id))) continue;
    const moving = arr.filter((it) => it && want.has(it.id));
    const rest = arr.filter((it) => !(it && want.has(it.id)));
    if (!out) out = { ...doc };
    out[coll] = where === 'back' ? [...moving, ...rest] : [...rest, ...moving];
  }
  return out ?? doc;
}

// ---------------------------------------------------------------------------------------------
// Polylines (walls, polygon rooms)
// ---------------------------------------------------------------------------------------------

/** Minimum number of points: 2 for open walls, 3 for closed walls and rooms. */
export function minPoints(coll, it) {
  return coll === 'rooms' || it?.closed ? 3 : 2;
}

/** Move vertex `index` of a wall or polygon room to p. */
export function moveVertex(doc, id, index, p) {
  return mapItems(doc, [id], (it, coll) => {
    if (!isPoly(coll, it) || !Array.isArray(it.points) || !it.points[index]) return it;
    const points = it.points.map((q, i) => (i === index ? [round4(p[0]), round4(p[1])] : q));
    return { ...it, points };
  });
}

/** Insert a vertex after `index` (i.e. on segment index → index+1). */
export function insertVertex(doc, id, index, p) {
  return mapItems(doc, [id], (it, coll) => {
    if (!isPoly(coll, it) || !Array.isArray(it.points)) return it;
    const points = [...it.points];
    points.splice(index + 1, 0, [round4(p[0]), round4(p[1])]);
    return { ...it, points };
  });
}

/** Delete a vertex (refused when the item would have too few points). */
export function deleteVertex(doc, id, index) {
  return mapItems(doc, [id], (it, coll) => {
    if (!isPoly(coll, it) || !Array.isArray(it.points) || it.points.length <= minPoints(coll, it) || !it.points[index]) return it;
    return { ...it, points: it.points.filter((_, i) => i !== index) };
  });
}

/** Rectangular room → polygon room with the same corners (so single corners can move). */
export function roomToPolygon(doc, id) {
  return mapItems(doc, [id], (it, coll) => {
    if (coll !== 'rooms' || Array.isArray(it.points) || ![it.x, it.y, it.w, it.h].every(finite)) return it;
    const { x, y, w, h, ...rest } = it;
    return { ...rest, points: [[x, y], [round4(x + w), y], [round4(x + w), round4(y + h)], [x, round4(y + h)]] };
  });
}

// ---------------------------------------------------------------------------------------------
// Doors on walls
// ---------------------------------------------------------------------------------------------

/**
 * Nearest wall segment to p within `tol` → { x, y, rotation, wallId, segment } for placing a door on it, or null.
 * The door centre is kept at least half a door width from the segment ends when the segment is long enough.
 */
export function snapToWall(doc, p, tol, { width = 0 } = {}) {
  let best = null;
  for (const w of doc?.walls ?? []) {
    if (!Array.isArray(w?.points)) continue;
    for (const [a, b, i] of segmentsOf(w.points, !!w.closed)) {
      const r = nearestOnSegment(p, a, b);
      if (r.dist <= tol && (!best || r.dist < best.dist)) best = { ...r, a, b, wallId: w.id, segment: i };
    }
  }
  if (!best) return null;
  const len = Math.hypot(best.b[0] - best.a[0], best.b[1] - best.a[1]);
  let t = best.t;
  if (width > 0 && len > width) {
    const m = width / 2 / len;
    t = Math.min(1 - m, Math.max(m, t));
  }
  const x = best.a[0] + (best.b[0] - best.a[0]) * t;
  const y = best.a[1] + (best.b[1] - best.a[1]) * t;
  return { x: round4(x), y: round4(y), rotation: lineAngle(best.a, best.b), wallId: best.wallId, segment: best.segment, dist: best.dist };
}

// ---------------------------------------------------------------------------------------------
// Machine links (machine.source)
// ---------------------------------------------------------------------------------------------

/**
 * True when two sources point at the same device. `endpointKey` is passed in (src/shared/sources.js) so this
 * module stays dependency-free. MTConnect: same agent endpoint (or either without an agent) and same device name
 * or uuid; other protocols: same endpoint.
 */
export function sameDevice(a, b, endpointKey) {
  if (!isObj(a) || !isObj(b)) return false;
  const pa = a.protocol || 'mtconnect', pb = b.protocol || 'mtconnect';
  if (pa !== pb) return false;
  // hand-typed agent URLs may carry a trailing slash or upper-case host
  const canon = (s) => (typeof s.agent === 'string' ? { ...s, agent: s.agent.trim().replace(/\/+$/, '').replace(/^(https?:\/\/)([^/]+)/i, (_, p, h) => p.toLowerCase() + h.toLowerCase()) } : s);
  a = canon(a);
  b = canon(b);
  if (pa === 'mtconnect') {
    const ka = endpointKey(a), kb = endpointKey(b);
    if (ka && kb && ka !== kb) return false;
    const ida = a.device || a.uuid, idb = b.device || b.uuid;
    if (!ida && !idb) return !!(ka && kb && ka === kb); // both "the only device on this agent"
    if (!ida || !idb) return false;
    // names first: several Haas controls report the same uuid ("000")
    if (a.device && b.device) return a.device === b.device;
    const namesB = [b.device, b.uuid].filter(Boolean);
    return [a.device, a.uuid].filter(Boolean).some((n) => namesB.includes(n));
  }
  const ka = endpointKey(a), kb = endpointKey(b);
  return !!ka && ka === kb;
}

/** Machines (other than `exceptId`) whose source points at the same device as `source`. */
export function machinesLinkedTo(doc, source, endpointKey, exceptId = null) {
  return (doc?.machines ?? []).filter((m) => m && m.id !== exceptId && m.source && sameDevice(m.source, source, endpointKey));
}

/** Set (or clear with null) a machine's source. */
export function setSource(doc, machineId, source) {
  return mapItems(doc, [machineId], (it, coll) => (coll === 'machines' ? { ...it, source: source ? clone(source) : null } : it));
}

/** Shallow structural equality for documents (used to skip no-op history steps). */
export function sameDoc(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Collections that actually contain an item (for messages like "2 machines, 1 wall"). */
export function describeItems(doc, ids) {
  const counts = new Map();
  for (const id of ids) {
    const f = findItem(doc, id);
    if (f) counts.set(f.coll, (counts.get(f.coll) ?? 0) + 1);
  }
  const parts = [];
  for (const coll of COLLECTIONS) {
    const n = counts.get(coll);
    if (!n) continue;
    const k = KIND_OF[coll];
    parts.push(`${n} ${n === 1 ? k : `${k}s`}`);
  }
  return parts.join(', ');
}

/** True for a syntactically valid item id. */
export const isItemId = (id) => typeof id === 'string' && ID_RE.test(id);

/** Width/height of the union bounds of items (for dimension read-outs). */
export function selectionBounds(doc, ids, measure) {
  const boxes = [...ids].map((id) => findItem(doc, id)).filter(Boolean).map((f) => itemSnapBounds(f.coll, f.item, measure));
  const b = bboxUnion(boxes);
  return b ? { ...b, w: bboxWidth(b), h: bboxHeight(b) } : null;
}
