// Canvas interaction for the layout editor (DECISIONS D5): Pointer Events (mouse, pen, touch), selection (click,
// shift-click, window/crossing marquee), move with snapping and guides, rotation-aware resize with screen-pixel
// handles (24 px hit area), rotation in 15° steps, wall/room drawing, door/label/object/machine placement, vertex
// editing, trace-photo fitting, pinch/wheel/space-drag pan and zoom. Draws its overlay into g#layer-overlay, which
// the floor-plan renderer never touches.
import { s } from './dom.js';
import {
  round4, rotatePoint, rectCorners, bboxUnion, bboxFromPoints, bboxesIntersect, bboxContains, constrainAngle, snapAngle,
  resizeRect, handleWorld, HANDLES, nearestOnSegment, segmentsOf, polylineLength, polygonArea, rectFromCorners, normalizeDeg,
} from './geometry.js';
import {
  COLLECTIONS, isRect, isPoly, itemOutline, itemBounds, itemSnapBounds, itemCenter, itemRotation, hitItem, itemArea,
} from './items.js';
import {
  findItem, moveItems, rotateItems, duplicateItems, updateItem, moveVertex, insertVertex, addItems, idFactory, snapToWall,
  describeItems, selectionBounds, updateDoc,
} from './ops.js';
import { collectTargets, snapMove, snapPoint } from './snap.js';
import { formatLength, formatAngle, formatArea } from './units.js';
import { textWidth } from '../floorplan.js';

const UI_FONT = "Raleway, 'Segoe UI', system-ui, sans-serif";
const HIT_PX = 12;          // half of the 24 px handle hit area (mouse/pen)
const HIT_PX_TOUCH = 18;
const SNAP_PX = 8;
const DRAG_PX = 4;
const DRAG_PX_TOUCH = 8;
const MIN_SIZE = 0.25;
const PICK_ORDER = ['machines', 'labels', 'objects', 'doors', 'walls', 'rooms'];
const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const DEFAULT_SIZE = { machines: [8, 6], objects: [4, 2] };

/**
 * @param {object} ed  editor core (index.js)
 */
export function createCanvas(ed) {
  const { svg, fp } = ed;
  const overlay = fp.layers.overlay;
  const root = s('g', { class: 'ed-overlay' }, overlay);
  /** @type {{kind: string, x: number, y: number, [k: string]: any}[]} */
  let handles = [];
  let hover = null;          // { id } | { handle }
  let guides = [];           // snap guides (layout units)
  let drag = null;           // active gesture
  let drawing = null;        // { kind: 'wall'|'room', points: [], cursor }
  let ghost = null;          // placement preview { kind, ... }
  let marquee = null;        // { a, b }
  let spaceDown = false;
  let lastPointer = null;    // last pointer event info (re-run drags when modifiers change)
  const pointers = new Map(); // touch pinch: pointerId → { x, y }
  let pinch = null;
  let destroyed = false;
  let measureCache = new Map();

  // ---------------------------------------------------------------------------------------------
  // Coordinates
  // ---------------------------------------------------------------------------------------------
  const ppu = () => {
    const m = svg.getScreenCTM?.();
    return m && m.a > 0 ? m.a : fp.pxPerUnit() || 1;
  };
  const px = (v) => v / ppu();
  const toLayout = (cx, cy) => { const p = fp.toSvgPoint(cx, cy); return [p.x, p.y]; };
  const toScreen = ([x, y]) => {
    const m = svg.getScreenCTM();
    return m ? [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] : [0, 0];
  };

  /** Label text box in layout units (measured from the rendered SVG, cached). */
  function measure(l) {
    const key = `${l.text}|${l.style}|${l.size}`;
    let box = measureCache.get(key);
    if (box) return box;
    const t = fp.itemElement(l.id)?.querySelector('text');
    try {
      const b = t?.getBBox();
      if (b && b.width > 0) box = { w: b.width + 0.3, h: Math.max(b.height, 0.6) + 0.2 };
    } catch { /* not rendered yet */ }
    if (!box) return { w: Math.max(1, String(l.text ?? '').length * (l.size ?? 1) * 0.55), h: (l.size ?? 1) * 1.25 };
    if (measureCache.size > 2000) measureCache.clear();
    measureCache.set(key, box);
    return box;
  }
  ed.measure = measure;

  // ---------------------------------------------------------------------------------------------
  // View (pan / zoom) — the view box keeps the SVG element's aspect ratio so 1 px = 1 px everywhere
  // ---------------------------------------------------------------------------------------------
  function svgSize() {
    const r = svg.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }
  function getView() {
    const vb = svg.viewBox?.baseVal;
    return vb && vb.width > 0 ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height } : { x: 0, y: 0, w: 100, h: 100 };
  }
  function setView(v) {
    if (![v.x, v.y, v.w, v.h].every(Number.isFinite) || v.w <= 0 || v.h <= 0) return;
    svg.setAttribute('viewBox', `${round4(v.x)} ${round4(v.y)} ${round4(v.w)} ${round4(v.h)}`);
    ed.invalidate('view');
  }
  /** Scale (px per layout unit) → clamp to 1.5 … 300 px/ft. */
  const clampScale = (k) => Math.min(300, Math.max(1.5, k));

  /** Fit the drawing (plus everything outside it and the visible photo) into the canvas. */
  function fit(pad = 28) {
    const d = ed.doc;
    const boxes = [{ minX: 0, minY: 0, maxX: d.width, maxY: d.height }];
    for (const coll of COLLECTIONS) for (const it of d[coll] ?? []) { const b = it && itemBounds(coll, it, measure); if (b) boxes.push(b); }
    if (d.background?.visible && Number.isFinite(d.background.width)) {
      const corners = photoCorners();
      if (corners) boxes.push(bboxUnion([bboxFromPoints(corners[0], corners[2]), bboxFromPoints(corners[1], corners[3])]));
    }
    const b = bboxUnion(boxes);
    const { w, h } = svgSize();
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const k = clampScale(Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh));
    const vw = w / k, vh = h / k;
    setView({ x: (b.minX + b.maxX) / 2 - vw / 2, y: (b.minY + b.maxY) / 2 - vh / 2, w: vw, h: vh });
  }
  /** Keep the scale and centre when the canvas element changes size. */
  let lastSize = null;
  function onResize() {
    if (ed.previewing) return; // the HUD fits the plan itself in the TV preview
    const size = svgSize();
    const v = getView();
    if (lastSize && lastSize.w > 1) {
      const k = lastSize.w / v.w;
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      const nw = size.w / k, nh = size.h / k;
      setView({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
    }
    lastSize = size;
    ed.invalidate('view');
  }
  function zoomAt(factor, clientX, clientY) {
    const v = getView();
    const { w } = svgSize();
    const k0 = w / v.w;
    const k1 = clampScale(k0 * factor);
    const f = k1 / k0;
    if (Math.abs(f - 1) < 1e-6) return;
    const r = svg.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2;
    const [x, y] = toLayout(cx, cy);
    setView({ x: x - (x - v.x) / f, y: y - (y - v.y) / f, w: v.w / f, h: v.h / f });
  }
  function panBy(dxPx, dyPx) {
    const v = getView();
    const k = svgSize().w / v.w;
    setView({ ...v, x: v.x - dxPx / k, y: v.y - dyPx / k });
  }
  const zoomPercent = () => {
    // 100 % = the whole drawing fits the canvas
    const { w, h } = svgSize();
    const fitK = Math.min(w / Math.max(1, ed.doc.width * 1.08), h / Math.max(1, ed.doc.height * 1.08));
    return Math.round((ppu() / fitK) * 100);
  };

  // ---------------------------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------------------------
  const isPickable = (coll, it) => !ed.layerHidden(coll) && !ed.layerLocked(coll) && !it.locked;

  /** Topmost pickable item at layout point p. */
  function pick(p, { tolPx = 6 } = {}) {
    const tol = px(tolPx);
    for (const coll of PICK_ORDER) {
      const arr = ed.doc[coll] ?? [];
      for (let i = arr.length - 1; i >= 0; i--) {
        const it = arr[i];
        if (it && isPickable(coll, it) && hitItem(coll, it, p, coll === 'rooms' ? 0 : tol, measure)) return { coll, item: it };
      }
    }
    return null;
  }

  /** Handle under a client point (screen-px distance). */
  function pickHandle(clientX, clientY, touch = false) {
    const lim = touch ? HIT_PX_TOUCH : HIT_PX;
    let best = null;
    for (const hd of handles) {
      const [sx, sy] = toScreen([hd.x, hd.y]);
      const d = Math.hypot(sx - clientX, sy - clientY);
      const r = hd.kind === 'mid' ? lim * 0.75 : lim;
      const pr = hd.priority ?? 0, bp = best?.hd.priority ?? 0;
      if (d <= r && (!best || pr > bp || (pr === bp && d < best.d))) best = { d, hd };
    }
    return best?.hd ?? null;
  }

  /** Items inside (window) or touching (crossing) a marquee. */
  function marqueePick(a, b) {
    const box = bboxFromPoints(a, b);
    const crossing = b[0] < a[0];
    const out = [];
    for (const coll of COLLECTIONS) {
      for (const it of ed.doc[coll] ?? []) {
        if (!it || !isPickable(coll, it)) continue;
        const ib = itemBounds(coll, it, measure);
        if (!ib) continue;
        if (crossing ? bboxesIntersect(box, ib) : bboxContains(box, ib)) out.push(it.id);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Snapping helpers
  // ---------------------------------------------------------------------------------------------
  const snapOn = (ev) => ed.opts.snap && !ev?.altKey;
  const skipHidden = (coll) => ed.layerHidden(coll);
  function targetsFor(exclude = new Set(), extraPoints = []) {
    const t = collectTargets(ed.doc, { exclude, measure, skip: skipHidden });
    for (const p of extraPoints) {
      t.points.push({ p, kind: 'vertex' });
      t.xs.push({ v: p[0], lo: p[1], hi: p[1], kind: 'vertex' });
      t.ys.push({ v: p[1], lo: p[0], hi: p[0], kind: 'vertex' });
    }
    return t;
  }
  function snapAt(p, ev, targets, { segments = true } = {}) {
    if (!snapOn(ev)) return { point: p, guides: [], kind: null };
    return snapPoint(p, targets, { tol: px(SNAP_PX), grid: ed.grid(), gridSnap: true, objectSnap: true, segments });
  }

  // ---------------------------------------------------------------------------------------------
  // Pointer events
  // ---------------------------------------------------------------------------------------------
  const isTouch = (ev) => ev.pointerType === 'touch';
  const dragThreshold = (ev) => (isTouch(ev) ? DRAG_PX_TOUCH : DRAG_PX);

  function onPointerDown(ev) {
    if (destroyed || ed.busy() || ed.previewing) return;
    if (ev.button !== 0 && ev.button !== 1 && !isTouch(ev)) return;
    ev.preventDefault();
    svg.focus?.({ preventScroll: true });
    try { svg.setPointerCapture(ev.pointerId); } catch { /* capture unsupported */ }
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    lastPointer = info(ev);
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
    const p = toLayout(ev.clientX, ev.clientY);
    if (ev.button === 1 || spaceDown || ed.tool === 'pan') { startPan(ev); return; }
    switch (ed.tool) {
      case 'select': return downSelect(ev, p);
      case 'wall': return downDrawPoint(ev, p, 'wall');
      case 'room': return downRoom(ev, p);
      case 'door': return downDoor(ev, p);
      case 'label': return downLabel(ev, p);
      case 'object':
      case 'machine': return downBox(ev, p, ed.tool === 'machine' ? 'machines' : 'objects');
      case 'photo': return downPhoto(ev, p);
      default: return undefined;
    }
  }

  function onPointerMove(ev) {
    if (destroyed) return;
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    lastPointer = info(ev);
    const p = toLayout(ev.clientX, ev.clientY);
    ed.setCursor(p);
    if (pinch) { updatePinch(); return; }
    if (drag) { updateDrag(drag, lastPointer); return; }
    hoverAt(ev, p);
  }

  function onPointerUp(ev) {
    pointers.delete(ev.pointerId);
    try { svg.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    endDrag(d, info(ev));
  }

  function onPointerCancel(ev) {
    pointers.delete(ev.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    if (drag) { const d = drag; drag = null; cancelDrag(d); }
  }

  function info(ev) {
    return { clientX: ev.clientX, clientY: ev.clientY, shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, touch: isTouch(ev), button: ev.button };
  }

  function onWheel(ev) {
    if (destroyed || ed.previewing) return;
    ev.preventDefault();
    if (ev.shiftKey && !ev.ctrlKey) { panBy(-(ev.deltaY || ev.deltaX), 0); return; }
    const unit = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1;
    const dy = ev.deltaY * unit;
    const f = Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0022));
    zoomAt(f, ev.clientX, ev.clientY);
  }

  function onDblClick(ev) {
    if (destroyed || ed.busy()) return;
    const p = toLayout(ev.clientX, ev.clientY);
    if (drawing) { ev.preventDefault(); finishDrawing(); return; }
    if (ed.tool !== 'select') return;
    // double-click on a wall or polygon-room edge inserts a point; on a named thing focuses its text field
    const hit = pick(p);
    if (!hit) return;
    if (isPoly(hit.coll, hit.item) && Array.isArray(hit.item.points)) {
      let best = null;
      for (const [a, b, i] of segmentsOf(hit.item.points, hit.coll === 'rooms' || !!hit.item.closed)) {
        const r = nearestOnSegment(p, a, b);
        if (!best || r.dist < best.dist) best = { ...r, i };
      }
      if (best && best.dist <= px(10) + (hit.coll === 'walls' ? 0.5 : 0)) {
        const at = snapOn(ev) ? best.point.map((v) => round4(v)) : best.point;
        ed.apply(insertVertex(ed.doc, hit.item.id, best.i, at), { label: 'Add wall point', select: [hit.item.id] });
        ed.vertexSel = { id: hit.item.id, index: best.i + 1 };
        ed.invalidate('overlay');
        return;
      }
    }
    ed.select([hit.item.id]);
    ed.emit('focus-field', { id: hit.item.id, field: hit.coll === 'labels' ? 'text' : 'name' });
  }

  // ---------------------------------------------------------------------------------------------
  // Select tool
  // ---------------------------------------------------------------------------------------------
  function downSelect(ev, p) {
    const hd = pickHandle(ev.clientX, ev.clientY, isTouch(ev));
    if (hd) { startHandle(ev, p, hd); return; }
    const hit = pick(p, { tolPx: isTouch(ev) ? 10 : 6 });
    if (!hit) {
      ed.vertexSel = null;
      if (isTouch(ev)) { startPan(ev, { tapClears: !ev.shiftKey }); return; }
      drag = { type: 'marquee', start: p, startClient: [ev.clientX, ev.clientY], additive: ev.shiftKey, moved: false };
      return;
    }
    const id = hit.item.id;
    const selected = ed.selection.includes(id);
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
      ed.select([id], 'toggle');
      if (!ed.selection.includes(id)) return;
    } else if (!selected && hit.coll === 'rooms') {
      // big background areas: a drag that starts on an unselected room draws a selection box instead
      drag = { type: 'marquee', start: p, startClient: [ev.clientX, ev.clientY], additive: false, moved: false, clickSelects: id };
      return;
    } else if (!selected) {
      ed.select([id]);
    }
    ed.vertexSel = null;
    startMove(ev, p, { clickId: selected && !ev.shiftKey ? id : null });
  }

  function startMove(ev, p, { clickId = null } = {}) {
    let ids = ed.selection.filter((id) => { const f = findItem(ed.doc, id); return f && isPickable(f.coll, f.item); });
    if (!ids.length) return;
    drag = { type: 'move', start: p, startClient: [ev.clientX, ev.clientY], ids, clickId, moved: false, copy: ev.altKey };
  }

  function beginMove(d) {
    ed.begin();
    let base = ed.doc;
    if (d.copy) {
      const r = duplicateItems(base, d.ids, { dx: 0, dy: 0 });
      base = r.doc;
      d.ids = r.ids;
      ed.preview(base);
      ed.select(r.ids, 'replace', { silent: true });
    }
    d.base = base;
    d.box = bboxUnion(d.ids.map((id) => { const f = findItem(base, id); return f ? itemSnapBounds(f.coll, f.item, measure) : null; }));
    d.targets = targetsFor(new Set(d.ids));
    const single = d.ids.length === 1 ? findItem(base, d.ids[0]) : null;
    d.single = single;
    if (single) {
      const { coll, item } = single;
      if (coll === 'doors' || coll === 'labels') d.anchor = [item.x, item.y];
      else if (coll === 'walls' && item.points?.length) d.anchor = item.points[0];
      else if (isRect(coll, item) && Math.abs(itemRotation(coll, item) % 90) > 1e-6) d.anchor = itemCenter(coll, item);
    }
  }

  function updateMove(d, pi) {
    const p = toLayout(pi.clientX, pi.clientY);
    if (!d.moved) {
      if (Math.hypot(pi.clientX - d.startClient[0], pi.clientY - d.startClient[1]) < dragThreshold(pi)) return;
      d.moved = true;
      beginMove(d);
    }
    let dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    if (pi.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    guides = [];
    if (d.single?.coll === 'doors' && snapOn(pi)) {
      const door = d.single.item;
      const s2 = snapToWall(d.base, [door.x + dx, door.y + dy], px(14), { width: door.width });
      if (s2) {
        ed.preview(updateItem(d.base, door.id, { x: s2.x, y: s2.y, rotation: s2.rotation }));
        guides = [{ x1: s2.x, y1: s2.y, x2: s2.x, y2: s2.y, kind: 'on-wall' }];
        ed.invalidate('overlay');
        return;
      }
    }
    if (snapOn(pi) && d.box) {
      const r = snapMove(d.box, dx, dy, d.targets, { tol: px(SNAP_PX), grid: ed.grid(), anchor: d.anchor ?? null });
      if (pi.shiftKey) { if (Math.abs(p[0] - d.start[0]) > Math.abs(p[1] - d.start[1])) r.dy = 0; else r.dx = 0; }
      dx = r.dx; dy = r.dy; guides = r.guides;
    }
    ed.preview(moveItems(d.base, d.ids, dx, dy));
    d.delta = [dx, dy];
  }

  // ---------------------------------------------------------------------------------------------
  // Handles: resize, rotate, vertices, door ends, photo corners
  // ---------------------------------------------------------------------------------------------
  function startHandle(ev, p, hd) {
    drag = { type: 'handle', hd, start: p, startClient: [ev.clientX, ev.clientY], moved: false };
  }

  function beginHandle(d) {
    ed.begin();
    d.base = ed.doc;
    const { hd } = d;
    if (hd.kind === 'mid') {
      // dragging a midpoint inserts a vertex and drags it
      d.base = insertVertex(d.base, hd.id, hd.index, [hd.x, hd.y]);
      ed.preview(d.base);
      d.hd = { ...hd, kind: 'vertex', index: hd.index + 1 };
      ed.vertexSel = { id: hd.id, index: hd.index + 1 };
    }
    if (d.hd.kind === 'vertex') {
      const f = findItem(d.base, d.hd.id);
      const own = f.item.points.filter((_, i) => i !== d.hd.index);
      d.targets = targetsFor(new Set([d.hd.id]), own);
      ed.vertexSel = { id: d.hd.id, index: d.hd.index };
    } else if (d.hd.kind === 'resize') {
      d.targets = targetsFor(new Set([d.hd.id]));
    } else if (d.hd.kind === 'rotate') {
      const ids = d.hd.ids;
      const boxes = ids.map((id) => findItem(d.base, id)).filter(Boolean);
      if (ids.length === 1 && boxes[0]) {
        d.centre = itemCenter(boxes[0].coll, boxes[0].item, measure);
        d.baseRot = itemRotation(boxes[0].coll, boxes[0].item);
      } else {
        const b = bboxUnion(boxes.map((f) => itemSnapBounds(f.coll, f.item, measure)));
        d.centre = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
        d.baseRot = 0;
      }
      d.startAngle = Math.atan2(d.start[1] - d.centre[1], d.start[0] - d.centre[0]);
    } else if (d.hd.kind === 'photo-corner' || d.hd.kind === 'photo-rotate' || d.hd.kind === 'photo-scale') {
      d.corners = photoCorners();
      d.centre = d.corners ? [(d.corners[0][0] + d.corners[2][0]) / 2, (d.corners[0][1] + d.corners[2][1]) / 2] : [0, 0];
      d.startAngle = Math.atan2(d.start[1] - d.centre[1], d.start[0] - d.centre[0]);
    }
  }

  function updateHandle(d, pi) {
    if (!d.moved) {
      if (Math.hypot(pi.clientX - d.startClient[0], pi.clientY - d.startClient[1]) < dragThreshold(pi) * 0.5) return;
      d.moved = true;
      beginHandle(d);
    }
    const p = toLayout(pi.clientX, pi.clientY);
    const hd = d.hd;
    guides = [];
    if (hd.kind === 'resize') {
      const f = findItem(d.base, hd.id);
      if (!f) return;
      const it = f.item;
      const rot = itemRotation(f.coll, it);
      const axisAligned = Math.abs(rot % 90) < 1e-6;
      let q = p;
      if (snapOn(pi) && axisAligned) {
        const sp = snapAt(p, pi, d.targets, { segments: false });
        q = sp.point;
        const worldX = Math.abs(rot % 180) < 1e-6; // local x ↔ world x
        const wantX = (hd.handle.includes('e') || hd.handle.includes('w')) ? (worldX ? 'x' : 'y') : null;
        const wantY = (hd.handle.includes('n') || hd.handle.includes('s')) ? (worldX ? 'y' : 'x') : null;
        guides = sp.guides.filter((g) => g.kind === wantX || g.kind === wantY);
      }
      const r = resizeRect({ x: it.x, y: it.y, w: it.w, h: it.h, rotation: rot }, hd.handle, q, {
        keepAspect: pi.shiftKey, min: MIN_SIZE, step: snapOn(pi) && !axisAligned ? ed.grid() : 0,
      });
      ed.preview(updateItem(d.base, hd.id, r));
    } else if (hd.kind === 'rotate') {
      const a = (Math.atan2(p[1] - d.centre[1], p[0] - d.centre[0]) - d.startAngle) * (180 / Math.PI);
      let total = d.baseRot + a;
      if (!pi.shiftKey) total = snapAngle(total, 15);
      const delta = normalizeDeg(total - d.baseRot);
      d.angle = normalizeDeg(total);
      ed.preview(rotateItems(d.base, hd.ids, delta, { centre: hd.ids.length > 1 ? d.centre : null, measure }));
    } else if (hd.kind === 'vertex') {
      const f = findItem(d.base, hd.id);
      if (!f) return;
      let q = p;
      const pts = f.item.points;
      const prev = pts[hd.index - 1] ?? (f.coll === 'rooms' || f.item.closed ? pts[pts.length - 1] : null);
      if (pi.shiftKey && prev) q = constrainAngle(prev, p, 45);
      else {
        const sp = snapAt(p, pi, d.targets);
        q = sp.point;
        guides = sp.guides;
      }
      ed.preview(moveVertex(d.base, hd.id, hd.index, q));
    } else if (hd.kind === 'door-end') {
      const f = findItem(d.base, hd.id);
      if (!f) return;
      const door = f.item;
      const rad = ((door.rotation || 0) * Math.PI) / 180;
      const ux = Math.cos(rad), uy = Math.sin(rad);
      const sign = hd.end === 'b' ? 1 : -1;
      const fixed = [door.x - sign * ux * door.width / 2, door.y - sign * uy * door.width / 2];
      let len = (p[0] - fixed[0]) * ux * sign + (p[1] - fixed[1]) * uy * sign;
      if (snapOn(pi)) len = Math.round(len / Math.min(0.5, ed.grid())) * Math.min(0.5, ed.grid());
      len = Math.max(1, len);
      ed.preview(updateItem(d.base, hd.id, { width: round4(len), x: round4(fixed[0] + sign * ux * len / 2), y: round4(fixed[1] + sign * uy * len / 2) }));
    } else if (hd.kind === 'photo-corner' && d.corners) {
      const corners = d.corners.map((c, i) => (i === hd.index ? [round4(p[0]), round4(p[1])] : c));
      ed.preview(setPhoto(d.base, corners, true));
    } else if (hd.kind === 'photo-scale' && d.corners) {
      // uniform scale about the opposite corner
      const o = d.corners[(hd.index + 2) % 4];
      const c0 = d.corners[hd.index];
      const d0 = Math.hypot(c0[0] - o[0], c0[1] - o[1]);
      const proj = ((p[0] - o[0]) * (c0[0] - o[0]) + (p[1] - o[1]) * (c0[1] - o[1])) / (d0 || 1);
      const k = Math.max(0.02, proj / (d0 || 1));
      const corners = d.corners.map((c) => [round4(o[0] + (c[0] - o[0]) * k), round4(o[1] + (c[1] - o[1]) * k)]);
      d.scale = k;
      ed.preview(setPhoto(d.base, corners, !!d.base.background?.corners));
    } else if (hd.kind === 'photo-rotate' && d.corners) {
      let a = (Math.atan2(p[1] - d.centre[1], p[0] - d.centre[0]) - d.startAngle) * (180 / Math.PI);
      const base = rectFromCorners(d.corners).rotation;
      if (!pi.shiftKey) a = snapAngle(base + a, 1) - base;
      d.angle = normalizeDeg(base + a);
      const corners = d.corners.map((c) => rotatePoint(c, d.centre, a).map(round4));
      ed.preview(setPhoto(d.base, corners, !!d.base.background?.corners));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Drawing tools
  // ---------------------------------------------------------------------------------------------
  function drawSnap(p, ev) {
    const pts = drawing?.points ?? [];
    const last = pts[pts.length - 1];
    if (ev?.shiftKey && last) return { point: constrainAngle(last, p, 45), guides: [] };
    const t = targetsFor(new Set(), pts);
    return snapAt(p, ev, t);
  }

  function downDrawPoint(ev, p, kind) {
    const sp = drawSnap(p, ev);
    const q = sp.point;
    if (!drawing) {
      drawing = { kind, points: [q], cursor: q };
      ed.emit('drawing', drawing);
      ed.invalidate('overlay');
      return;
    }
    const pts = drawing.points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const tolUnits = px(isTouch(ev) ? HIT_PX_TOUCH : HIT_PX);
    if (pts.length >= 3 && Math.hypot(q[0] - first[0], q[1] - first[1]) <= tolUnits) { finishDrawing({ close: true }); return; }
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) return; // double-click second press
    pts.push(q);
    drawing.cursor = q;
    ed.emit('drawing', drawing);
    ed.invalidate('overlay');
  }

  function finishDrawing({ close = false } = {}) {
    if (!drawing) return;
    const d = drawing;
    drawing = null;
    guides = [];
    ed.emit('drawing', null);
    const pts = dedupe(d.points);
    const ids = idFactory(ed.doc);
    if (d.kind === 'wall' && pts.length >= 2) {
      const closed = close && pts.length >= 3;
      const style = ed.doc.walls?.length ? ed.lastWallStyle ?? 'interior' : 'exterior';
      const wall = { id: ids.next('walls'), points: pts, style, ...(closed ? { closed: true } : {}) };
      ed.apply(addItems(ed.doc, [{ coll: 'walls', item: wall }]), { label: `Draw wall (${formatLength(polylineLength(pts, closed), ed.units())})`, select: [wall.id] });
    } else if (d.kind === 'room' && pts.length >= 3) {
      const room = { id: ids.next('rooms'), name: nextName('rooms', 'Room'), kind: 'other', points: pts };
      ed.apply(addItems(ed.doc, [{ coll: 'rooms', item: room }]), { label: 'Draw room', select: [room.id] });
      ed.setTool('select');
      ed.emit('focus-field', { id: room.id, field: 'name' });
    } else {
      ed.invalidate('overlay');
    }
  }

  function cancelDrawing() {
    if (!drawing) return false;
    drawing = null;
    guides = [];
    ed.emit('drawing', null);
    ed.invalidate('overlay');
    return true;
  }

  function undoDrawingPoint() {
    if (!drawing) return false;
    drawing.points.pop();
    if (!drawing.points.length) return cancelDrawing();
    ed.invalidate('overlay');
    return true;
  }

  const dedupe = (pts) => pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-6);

  function nextName(coll, base) {
    const names = new Set((ed.doc[coll] ?? []).map((it) => it?.name));
    let n = (ed.doc[coll] ?? []).length + 1;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  function downRoom(ev, p) {
    if (drawing?.kind === 'room') { downDrawPoint(ev, p, 'room'); return; }
    const sp = drawSnap(p, ev);
    drag = { type: 'room', start: sp.point, startRaw: p, startClient: [ev.clientX, ev.clientY], moved: false, end: sp.point };
  }

  function downBox(ev, p, coll) {
    const sp = drawSnap(p, ev);
    drag = { type: 'box', coll, start: sp.point, startClient: [ev.clientX, ev.clientY], moved: false, end: sp.point };
  }

  function updateBox(d, pi) {
    const p = toLayout(pi.clientX, pi.clientY);
    if (!d.moved && Math.hypot(pi.clientX - d.startClient[0], pi.clientY - d.startClient[1]) < dragThreshold(pi)) return;
    d.moved = true;
    let q = drawSnap(p, pi);
    guides = q.guides;
    q = q.point;
    if (pi.shiftKey) { // square
      const side = Math.max(Math.abs(q[0] - d.start[0]), Math.abs(q[1] - d.start[1]));
      q = [d.start[0] + Math.sign(q[0] - d.start[0] || 1) * side, d.start[1] + Math.sign(q[1] - d.start[1] || 1) * side];
    }
    d.end = q;
    ed.invalidate('overlay');
  }

  function endBox(d) {
    const ids = idFactory(ed.doc);
    let x, y, w, hh;
    if (d.moved) {
      x = Math.min(d.start[0], d.end[0]); y = Math.min(d.start[1], d.end[1]);
      w = Math.abs(d.end[0] - d.start[0]); hh = Math.abs(d.end[1] - d.start[1]);
      if (w < MIN_SIZE * 2 || hh < MIN_SIZE * 2) { ed.invalidate('overlay'); return; }
    } else if (d.type === 'room') {
      // a click (no drag) with the room tool starts a polygon room
      drawing = { kind: 'room', points: [d.start], cursor: d.start };
      ed.emit('drawing', drawing);
      ed.invalidate('overlay');
      return;
    } else {
      [w, hh] = DEFAULT_SIZE[d.coll];
      x = round4(d.start[0] - w / 2); y = round4(d.start[1] - hh / 2);
    }
    [x, y, w, hh] = [x, y, w, hh].map(round4);
    let item;
    if (d.type === 'room') item = { id: ids.next('rooms'), name: nextName('rooms', 'Room'), kind: 'other', x, y, w, h: hh };
    else if (d.coll === 'machines') item = { id: ids.next('machines'), name: nextName('machines', 'Machine'), kind: 'other', x, y, w, h: hh, rotation: 0, source: null };
    else item = { id: ids.next('objects'), name: nextName('objects', 'Object'), kind: 'generic', x, y, w, h: hh, rotation: 0 };
    const coll = d.type === 'room' ? 'rooms' : d.coll;
    ed.apply(addItems(ed.doc, [{ coll, item }]), { label: `Add ${coll === 'rooms' ? 'room' : coll === 'machines' ? 'machine' : 'object'}`, select: [item.id] });
    ed.setTool('select');
    ed.emit('focus-field', { id: item.id, field: 'name' });
  }

  function doorGhost(p, ev) {
    const width = ed.lastDoorWidth ?? 3;
    const onWall = snapOn(ev) ? snapToWall(ed.doc, p, px(18), { width }) : null;
    if (onWall) return { x: onWall.x, y: onWall.y, rotation: onWall.rotation, width, wallId: onWall.wallId };
    const q = snapAt(p, ev, targetsFor()).point;
    return { x: q[0], y: q[1], rotation: 0, width, wallId: null };
  }

  function downDoor(ev, p) {
    const g = doorGhost(p, ev);
    const id = idFactory(ed.doc).next('doors');
    const door = { id, x: g.x, y: g.y, width: g.width, rotation: g.rotation, kind: 'door', swing: 'left' };
    ed.apply(addItems(ed.doc, [{ coll: 'doors', item: door }]), { label: 'Add door', select: [id] });
    if (!g.wallId) ed.toast('Door placed off a wall — drag it onto a wall to snap it', { kind: 'info' });
    ed.setTool('select');
  }

  function downLabel(ev, p) {
    const q = snapAt(p, ev, targetsFor()).point;
    const id = idFactory(ed.doc).next('labels');
    const label = { id, text: 'Label', x: q[0], y: q[1], style: 'note' };
    ed.apply(addItems(ed.doc, [{ coll: 'labels', item: label }]), { label: 'Add label', select: [id] });
    ed.setTool('select');
    ed.emit('focus-field', { id, field: 'text' });
  }

  // ---------------------------------------------------------------------------------------------
  // Trace photo (background): move, uniform scale, rotate, 4-corner fit, 2-point calibration
  // ---------------------------------------------------------------------------------------------
  /** Corners (TL, TR, BR, BL) of the photo in layout units, or null. */
  function photoCorners(doc = ed.doc) {
    const b = doc.background;
    if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
    if (Array.isArray(b.corners) && b.corners.length === 4) return b.corners.map((c) => [c[0], c[1]]);
    return rectCorners({ x: b.x, y: b.y, w: b.width, h: b.height, rotation: b.rotation || 0 });
  }
  ed.photoCorners = photoCorners;

  /** Document with the photo placed at `corners`; `distort` keeps them as a 4-corner fit. */
  function setPhoto(doc, corners, distort) {
    const r = rectFromCorners(corners);
    const patch = { ...doc.background, x: r.x, y: r.y, width: Math.max(0.01, r.width), height: Math.max(0.01, r.height), rotation: r.rotation };
    if (distort) patch.corners = corners.map((c) => [round4(c[0]), round4(c[1])]);
    else delete patch.corners;
    if (!patch.rotation) delete patch.rotation;
    return updateDoc(doc, { background: patch });
  }
  ed.setPhoto = setPhoto;

  function downPhoto(ev, p) {
    const corners = photoCorners();
    if (!corners) { ed.toast('Add a trace photo first (Properties → Trace photo)', { kind: 'info' }); return; }
    if (ed.photoMode === 'calibrate') {
      const pins = ed.calibration ?? [];
      if (pins.length >= 2) pins.length = 0;
      pins.push([round4(p[0]), round4(p[1])]);
      ed.calibration = pins;
      ed.emit('calibration', pins);
      ed.invalidate('overlay');
      return;
    }
    const hd = pickHandle(ev.clientX, ev.clientY, isTouch(ev));
    if (hd) { startHandle(ev, p, hd); return; }
    const inside = corners && pointInQuad(p, corners);
    if (!inside) { if (isTouch(ev)) startPan(ev); return; }
    drag = { type: 'photo-move', start: p, startClient: [ev.clientX, ev.clientY], moved: false };
  }

  function pointInQuad(p, q) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function updatePhotoMove(d, pi) {
    if (!d.moved) {
      if (Math.hypot(pi.clientX - d.startClient[0], pi.clientY - d.startClient[1]) < dragThreshold(pi)) return;
      d.moved = true;
      ed.begin();
      d.base = ed.doc;
      d.corners = photoCorners();
    }
    const p = toLayout(pi.clientX, pi.clientY);
    const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    const corners = d.corners.map((c) => [round4(c[0] + dx), round4(c[1] + dy)]);
    ed.preview(setPhoto(d.base, corners, !!d.base.background?.corners));
  }

  // ---------------------------------------------------------------------------------------------
  // Pan and pinch
  // ---------------------------------------------------------------------------------------------
  function startPan(ev, { tapClears = false } = {}) {
    drag = { type: 'pan', last: [ev.clientX, ev.clientY], startClient: [ev.clientX, ev.clientY], moved: false, tapClears };
    svg.classList.add('ed-panning');
  }

  function startPinch() {
    if (drag) { const d = drag; drag = null; cancelDrag(d); }
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(b.x - a.x, b.y - a.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  }

  function updatePinch() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
    if (pinch.dist > 10) zoomAt(dist / pinch.dist, mid[0], mid[1]);
    pinch = { dist, mid };
  }

  // ---------------------------------------------------------------------------------------------
  // Drag dispatch
  // ---------------------------------------------------------------------------------------------
  function updateDrag(d, pi) {
    switch (d.type) {
      case 'move': updateMove(d, pi); break;
      case 'handle': updateHandle(d, pi); break;
      case 'marquee': {
        const p = toLayout(pi.clientX, pi.clientY);
        if (!d.moved && Math.hypot(pi.clientX - d.startClient[0], pi.clientY - d.startClient[1]) < dragThreshold(pi)) return;
        d.moved = true;
        marquee = { a: d.start, b: p };
        break;
      }
      case 'room':
      case 'box': updateBox(d, pi); break;
      case 'pan': {
        const dx = pi.clientX - d.last[0], dy = pi.clientY - d.last[1];
        if (!d.moved && Math.hypot(pi.clientX - d.startClient[0], pi.clientY - d.startClient[1]) < dragThreshold(pi)) return;
        d.moved = true;
        d.last = [pi.clientX, pi.clientY];
        panBy(dx, dy);
        break;
      }
      case 'photo-move': updatePhotoMove(d, pi); break;
      default: break;
    }
    ed.invalidate('overlay');
  }

  function endDrag(d, pi) {
    svg.classList.remove('ed-panning');
    switch (d.type) {
      case 'move':
        if (d.moved) ed.commit(d.copy ? `Copy ${describeItems(ed.doc, d.ids)}` : `Move ${describeItems(ed.doc, d.ids)}`, { select: d.ids });
        else if (d.clickId) ed.select([d.clickId]);
        break;
      case 'handle':
        if (d.moved) {
          const hd = d.hd;
          const label = hd.kind === 'resize' ? 'Resize' : hd.kind === 'rotate' ? 'Rotate' : hd.kind === 'vertex' ? 'Move point' : hd.kind === 'door-end' ? 'Resize door' : 'Fit photo';
          ed.commit(label);
        } else if (d.hd.kind === 'vertex' || d.hd.kind === 'mid') {
          ed.vertexSel = d.hd.kind === 'vertex' ? { id: d.hd.id, index: d.hd.index } : null;
        }
        break;
      case 'marquee':
        if (d.moved && marquee) {
          const ids = marqueePick(marquee.a, marquee.b);
          ed.select(ids, d.additive ? 'add' : 'replace');
        } else if (d.clickSelects) {
          ed.select([d.clickSelects]);
        } else if (!d.additive) ed.select([]);
        marquee = null;
        break;
      case 'room':
      case 'box': endBox(d); break;
      case 'pan': if (!d.moved && d.tapClears) ed.select([]); break;
      case 'photo-move': if (d.moved) ed.commit('Move photo'); break;
      default: break;
    }
    guides = [];
    hoverAt(pi, toLayout(pi.clientX, pi.clientY));
    ed.invalidate('overlay');
  }

  function cancelDrag(d) {
    svg.classList.remove('ed-panning');
    if (d.moved && ['move', 'handle', 'photo-move'].includes(d.type)) ed.cancel();
    marquee = null;
    guides = [];
    ed.invalidate('overlay');
  }

  /** Esc: cancel the current gesture / drawing. Returns true when something was cancelled. */
  function cancelGesture() {
    if (drag) { const d = drag; drag = null; cancelDrag(d); return true; }
    return cancelDrawing();
  }

  /** Forget hover state, guides and placement ghosts (tool changes). */
  function resetTransient() {
    guides = [];
    ghost = null;
    hover = null;
    marquee = null;
    ed.invalidate('overlay');
  }
  ed.on('tool', resetTransient);

  // ---------------------------------------------------------------------------------------------
  // Hover & cursor
  // ---------------------------------------------------------------------------------------------
  function hoverAt(ev, p) {
    let cursor = '';
    let nextHover = null;
    ghost = null;
    if (spaceDown || ed.tool === 'pan') cursor = 'grab';
    else if (ed.tool === 'select' || ed.tool === 'photo') {
      const hd = pickHandle(ev.clientX, ev.clientY, ev.touch ?? isTouch(ev));
      if (hd) {
        nextHover = { handle: hd };
        cursor = cursorFor(hd);
      } else if (ed.tool === 'select') {
        const hit = pick(p);
        if (hit) { nextHover = { id: hit.item.id }; cursor = 'move'; }
      } else if (ed.photoMode === 'calibrate') cursor = 'crosshair';
      else {
        const c = photoCorners();
        if (c && pointInQuad(p, c)) cursor = 'move';
      }
    } else {
      cursor = 'crosshair';
      if (ed.tool === 'wall' || (ed.tool === 'room' && drawing)) {
        if (drawing) {
          const sp = drawSnap(p, ev);
          drawing.cursor = sp.point;
          guides = sp.guides;
        } else {
          const sp = snapAt(p, ev, targetsFor());
          ghost = { kind: 'point', p: sp.point };
          guides = sp.guides;
        }
      } else if (ed.tool === 'door') {
        ghost = { kind: 'door', ...doorGhost(p, ev) };
      } else {
        const sp = snapAt(p, ev, targetsFor());
        ghost = { kind: 'point', p: sp.point };
        guides = sp.guides;
      }
    }
    if (JSON.stringify(nextHover) !== JSON.stringify(hover) || ghost || drawing || ed.tool !== 'select') {
      hover = nextHover;
      ed.invalidate('overlay');
    }
    svg.style.cursor = cursor;
  }

  function cursorFor(hd) {
    if (hd.kind === 'rotate' || hd.kind === 'photo-rotate') return 'grab';
    if (hd.kind === 'vertex' || hd.kind === 'mid' || hd.kind === 'photo-corner') return 'crosshair';
    if (hd.kind === 'resize' || hd.kind === 'door-end' || hd.kind === 'photo-scale') {
      const base = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 }[hd.handle ?? 'e'] ?? 0;
      const a = (((base + (hd.rotation || 0)) % 180) + 180) % 180;
      return CURSORS[Math.round(a / 45) % 4];
    }
    return 'pointer';
  }

  // ---------------------------------------------------------------------------------------------
  // Overlay rendering
  // ---------------------------------------------------------------------------------------------
  function renderOverlay() {
    if (destroyed) return;
    root.replaceChildren();
    handles = [];
    if (ed.previewing) return;
    const sel = ed.selection.map((id) => findItem(ed.doc, id)).filter(Boolean);
    const gHover = s('g', { class: 'ed-hover' }, root);
    const gSel = s('g', { class: 'ed-sel' }, root);
    const gGuides = s('g', { class: 'ed-guides' }, root);
    const gDraw = s('g', { class: 'ed-draw' }, root);
    const gHandles = s('g', { class: 'ed-handles' }, root);
    const gDims = s('g', { class: 'ed-dims' }, root);

    // hover outline
    if (hover?.id && !ed.selection.includes(hover.id) && !drag) {
      const f = findItem(ed.doc, hover.id);
      if (f) outline(gHover, f.coll, f.item, 'ed-hover-outline');
    }

    // photo frame (photo tool)
    if (ed.tool === 'photo') renderPhotoFrame(gSel, gHandles, gDims);

    // selection
    const linkTarget = ed.linkHover ?? null;
    if (linkTarget) { const f = findItem(ed.doc, linkTarget); if (f) outline(gSel, f.coll, f.item, 'ed-link-target'); }
    for (const f of sel) outline(gSel, f.coll, f.item, f.item.locked || ed.layerLocked(f.coll) ? 'ed-sel-outline ed-locked' : 'ed-sel-outline');
    const editable = sel.filter((f) => !f.item.locked && !ed.layerLocked(f.coll) && !ed.layerHidden(f.coll));
    const showHandles = ed.tool === 'select' && !(drag?.type === 'move' && drag.moved);
    if (editable.length === 1 && showHandles) singleHandles(gSel, gHandles, editable[0]);
    else if (editable.length > 1) {
      const b = bboxUnion(editable.map((f) => itemSnapBounds(f.coll, f.item, measure)));
      if (b) {
        const pad = px(6);
        const frame = [[b.minX - pad, b.minY - pad], [b.maxX + pad, b.minY - pad], [b.maxX + pad, b.maxY + pad], [b.minX - pad, b.maxY + pad]];
        s('polygon', { points: pts(frame), class: 'ed-group-frame' }, gSel);
        if (showHandles) addRotateHandle(gSel, gHandles, [(b.minX + b.maxX) / 2, b.minY - pad], 0, editable.map((f) => f.item.id));
      }
    }

    // dimensions of the selection
    if (sel.length && !drawing && (ed.tool === 'select')) selectionDims(gDims, editable.length ? editable : sel);

    // drawing previews
    if (drawing) renderDrawing(gDraw, gHandles, gDims);
    if (drag?.type === 'box' || drag?.type === 'room') {
      if (drag.moved) {
        const b = bboxFromPoints(drag.start, drag.end);
        s('rect', { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, class: drag.coll === 'machines' ? 'ed-draw-shape ed-draw-machine' : 'ed-draw-shape' }, gDraw);
        const wTxt = formatLength(b.maxX - b.minX, ed.units()), hTxt = formatLength(b.maxY - b.minY, ed.units());
        const extra = drag.type === 'room' ? ` · ${formatArea((b.maxX - b.minX) * (b.maxY - b.minY), ed.units())}` : '';
        pill(gDims, [(b.minX + b.maxX) / 2, b.maxY], `${wTxt} × ${hTxt}${extra}`, { dy: 16 });
      }
    }
    if (ghost && !drag) renderGhost(gDraw);

    // guides
    for (const g of guides) {
      if (g.kind === 'point' || g.kind === 'on-wall') {
        s('circle', { cx: g.x1, cy: g.y1, r: px(6), class: 'ed-guide-point' }, gGuides);
      } else {
        s('line', { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: 'ed-guide' }, gGuides);
      }
    }

    // marquee
    if (marquee) {
      const b = bboxFromPoints(marquee.a, marquee.b);
      const crossing = marquee.b[0] < marquee.a[0];
      s('rect', { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, class: crossing ? 'ed-marquee ed-crossing' : 'ed-marquee' }, root);
    }

    // calibration pins
    if (ed.tool === 'photo' && ed.photoMode === 'calibrate' && ed.calibration?.length) {
      const pins = ed.calibration;
      if (pins.length === 2) s('line', { x1: pins[0][0], y1: pins[0][1], x2: pins[1][0], y2: pins[1][1], class: 'ed-calib-line' }, gDraw);
      pins.forEach((p, i) => {
        s('circle', { cx: p[0], cy: p[1], r: px(7), class: 'ed-pin' }, gHandles);
        pill(gDims, p, i === 0 ? 'A' : 'B', { dy: -18 });
      });
      if (pins.length === 2) pill(gDims, [(pins[0][0] + pins[1][0]) / 2, (pins[0][1] + pins[1][1]) / 2], `now ${formatLength(Math.hypot(pins[1][0] - pins[0][0], pins[1][1] - pins[0][1]), ed.units())}`, { dy: 18 });
    }
  }

  const pts = (list) => list.map((p) => `${round4(p[0])},${round4(p[1])}`).join(' ');

  function outline(g, coll, it, cls) {
    const o = itemOutline(coll, it, measure);
    if (!o) return;
    if (coll === 'walls') {
      s(it.closed ? 'polygon' : 'polyline', { points: pts(o), class: `${cls} ed-wall-outline`, 'stroke-width': px(3) + (it.thickness ?? 0.4) }, g);
      s(it.closed ? 'polygon' : 'polyline', { points: pts(o), class: `${cls} ed-wall-core` }, g);
    } else s('polygon', { points: pts(o), class: cls }, g);
  }

  function handleRect(g, p, cls = 'ed-handle', size = 9) {
    const hs = px(size);
    return s('rect', { x: p[0] - hs / 2, y: p[1] - hs / 2, width: hs, height: hs, class: cls }, g);
  }

  function addRotateHandle(gSel, gHandles, anchor, rot, ids) {
    // the knob sits 26 px "above" the anchor in the item's rotated frame
    const off = px(26);
    const rad = ((rot - 90) * Math.PI) / 180;
    const knob = [anchor[0] + Math.cos(rad) * off, anchor[1] + Math.sin(rad) * off];
    s('line', { x1: anchor[0], y1: anchor[1], x2: knob[0], y2: knob[1], class: 'ed-rot-stem' }, gSel);
    s('circle', { cx: knob[0], cy: knob[1], r: px(6), class: 'ed-handle ed-rot-handle' }, gHandles);
    handles.push({ kind: 'rotate', x: knob[0], y: knob[1], ids, priority: 1 });
  }

  function singleHandles(gSel, gHandles, f) {
    const { coll, item } = f;
    if (isRect(coll, item)) {
      const rot = itemRotation(coll, item);
      for (const hName of HANDLES) {
        const p = handleWorld({ ...item, rotation: rot }, hName);
        handleRect(gHandles, p, `ed-handle ed-handle-${hName.length === 2 ? 'corner' : 'edge'}`, hName.length === 2 ? 10 : 8).setAttribute('transform', rot ? `rotate(${rot} ${p[0]} ${p[1]})` : '');
        handles.push({ kind: 'resize', handle: hName, id: item.id, x: p[0], y: p[1], rotation: rot });
      }
      if (coll !== 'rooms') addRotateHandle(gSel, gHandles, handleWorld({ ...item, rotation: rot }, 'n'), rot, [item.id]);
    } else if (isPoly(coll, item) && Array.isArray(item.points)) {
      const closed = coll === 'rooms' || !!item.closed;
      for (const [a, b, i] of segmentsOf(item.points, closed)) {
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) * ppu() < 36) continue;
        s('circle', { cx: m[0], cy: m[1], r: px(4.5), class: 'ed-mid-handle' }, gHandles);
        handles.push({ kind: 'mid', id: item.id, index: i, x: m[0], y: m[1] });
      }
      item.points.forEach((p, i) => {
        const active = ed.vertexSel?.id === item.id && ed.vertexSel.index === i;
        s('circle', { cx: p[0], cy: p[1], r: px(active ? 7 : 5.5), class: active ? 'ed-handle ed-vertex ed-vertex-active' : 'ed-handle ed-vertex' }, gHandles);
        handles.push({ kind: 'vertex', id: item.id, index: i, x: p[0], y: p[1], priority: 2 });
      });
    } else if (coll === 'doors') {
      const rad = ((item.rotation || 0) * Math.PI) / 180;
      const ux = Math.cos(rad), uy = Math.sin(rad);
      for (const end of ['a', 'b']) {
        const sg = end === 'b' ? 1 : -1;
        const p = [item.x + sg * ux * item.width / 2, item.y + sg * uy * item.width / 2];
        handleRect(gHandles, p, 'ed-handle ed-handle-edge', 9);
        handles.push({ kind: 'door-end', end, id: item.id, x: p[0], y: p[1], handle: 'e', rotation: item.rotation || 0 });
      }
      addRotateHandle(gSel, gHandles, [item.x + uy * 0.6, item.y - ux * 0.6], item.rotation || 0, [item.id]);
    } else if (coll === 'labels') {
      const o = itemOutline(coll, item, measure);
      if (o) addRotateHandle(gSel, gHandles, [(o[0][0] + o[1][0]) / 2, (o[0][1] + o[1][1]) / 2], item.rotation || 0, [item.id]);
    }
  }

  function selectionDims(g, list) {
    const u = ed.units();
    if (drag?.type === 'handle' && drag.moved && drag.hd.kind === 'rotate') {
      const c = drag.centre;
      pill(g, c, formatAngle(drag.angle ?? 0), { dy: 0, strong: true });
      return;
    }
    if (list.length === 1) {
      const { coll, item } = list[0];
      const b = itemBounds(coll, item, measure);
      if (!b) return;
      let text = null;
      if (isRect(coll, item)) {
        text = `${formatLength(item.w, u)} × ${formatLength(item.h, u)}`;
        if (coll === 'rooms') text += ` · ${formatArea(itemArea(coll, item), u)}`;
      } else if (coll === 'rooms') text = formatArea(itemArea(coll, item), u);
      else if (coll === 'walls') {
        if (drag?.type === 'handle' && drag.hd.kind === 'vertex') {
          const f = findItem(ed.doc, drag.hd.id);
          const p = f?.item.points[drag.hd.index];
          const prev = f?.item.points[drag.hd.index - 1];
          if (p && prev) { pill(g, p, formatLength(Math.hypot(p[0] - prev[0], p[1] - prev[1]), u), { dy: -20 }); }
        }
        text = formatLength(polylineLength(item.points, !!item.closed), u);
      } else if (coll === 'doors') text = `${formatLength(item.width, u)} ${item.kind === 'rollup' ? 'roll-up' : item.kind ?? 'door'}`;
      if (drag?.type === 'move' && drag.moved) {
        const c = itemCenter(coll, item, measure);
        text = `${coll === 'labels' || coll === 'doors' ? '' : `${text ?? ''}  `}x ${formatLength(isRect(coll, item) ? item.x : c[0], u)}  y ${formatLength(isRect(coll, item) ? item.y : c[1], u)}`.trim();
      }
      if (text) pill(g, [(b.minX + b.maxX) / 2, b.maxY], text, { dy: 18, strong: !!drag?.moved });
      return;
    }
    const sb = selectionBounds(ed.doc, list.map((f) => f.item.id), measure);
    if (sb) pill(g, [(sb.minX + sb.maxX) / 2, sb.maxY], `${list.length} items · ${formatLength(sb.w, u)} × ${formatLength(sb.h, u)}`, { dy: 22 });
  }

  /** Dimension pill: screen-px text centred at a layout point, offset dy px. */
  function pill(g, p, text, { dy = 0, strong = false } = {}) {
    const k = ppu();
    const fs = 12.5;
    const w = textWidth(text, 600, UI_FONT) * fs + 14;
    const hgt = fs + 9;
    const grp = s('g', { class: strong ? 'ed-pill ed-pill-strong' : 'ed-pill', transform: `translate(${round4(p[0])} ${round4(p[1])}) scale(${round4(1 / k)}) translate(0 ${dy})` }, g);
    s('rect', { x: -w / 2, y: -hgt / 2, width: w, height: hgt, rx: hgt / 2 }, grp);
    const t = s('text', { x: 0, y: 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': fs, 'font-family': UI_FONT, 'font-weight': 600 }, grp);
    t.textContent = text;
  }

  function renderDrawing(gDraw, gHandles, gDims) {
    const d = drawing;
    const u = ed.units();
    const all = [...d.points, d.cursor ?? d.points[d.points.length - 1]];
    if (d.kind === 'wall') {
      s('polyline', { points: pts(all), class: 'ed-draw-wall', 'stroke-width': ed.doc.walls?.length ? 0.4 : 0.75 }, gDraw);
    } else {
      s('polygon', { points: pts(all), class: 'ed-draw-shape' }, gDraw);
      if (all.length >= 3) pill(gDims, centroid(all), formatArea(polygonArea(all), u), { strong: true });
    }
    d.points.forEach((p, i) => s('circle', { cx: p[0], cy: p[1], r: px(i === 0 && d.points.length >= 3 ? 7 : 4.5), class: i === 0 && d.points.length >= 3 ? 'ed-draw-start' : 'ed-draw-vertex' }, gHandles));
    const last = d.points[d.points.length - 1];
    const c = d.cursor;
    if (c && last && (c[0] !== last[0] || c[1] !== last[1])) {
      const len = Math.hypot(c[0] - last[0], c[1] - last[1]);
      const ang = normalizeDeg((Math.atan2(c[1] - last[1], c[0] - last[0]) * 180) / Math.PI);
      pill(gDims, [(c[0] + last[0]) / 2, (c[1] + last[1]) / 2], `${formatLength(len, u)} · ${formatAngle(-ang)}`, { dy: -18, strong: true });
    }
  }

  function centroid(list) {
    const n = list.length;
    return [list.reduce((a, p) => a + p[0], 0) / n, list.reduce((a, p) => a + p[1], 0) / n];
  }

  function renderGhost(g) {
    if (ghost.kind === 'point') {
      const p = ghost.p;
      const r = px(5);
      s('path', { d: `M${p[0] - r * 2} ${p[1]} H${p[0] + r * 2} M${p[0]} ${p[1] - r * 2} V${p[1] + r * 2}`, class: 'ed-ghost-cross' }, g);
    } else if (ghost.kind === 'door') {
      const corners = rectCorners({ x: ghost.x - ghost.width / 2, y: ghost.y - 0.45, w: ghost.width, h: 0.9, rotation: ghost.rotation });
      s('polygon', { points: pts(corners), class: ghost.wallId ? 'ed-ghost-door on-wall' : 'ed-ghost-door' }, g);
    }
  }

  function renderPhotoFrame(gSel, gHandles, gDims) {
    const c = photoCorners();
    if (!c) return;
    s('polygon', { points: pts(c), class: 'ed-photo-frame' }, gSel);
    if (ed.photoMode === 'calibrate') return;
    const distort = ed.photoMode === 'corners';
    c.forEach((p, i) => {
      if (distort) {
        s('circle', { cx: p[0], cy: p[1], r: px(8), class: 'ed-handle ed-photo-corner' }, gHandles);
        handles.push({ kind: 'photo-corner', index: i, x: p[0], y: p[1], priority: 2 });
      } else {
        handleRect(gHandles, p, 'ed-handle ed-handle-corner', 11);
        handles.push({ kind: 'photo-scale', index: i, x: p[0], y: p[1], handle: ['nw', 'ne', 'se', 'sw'][i], rotation: rectFromCorners(c).rotation });
      }
    });
    if (!distort) {
      const top = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
      const rot = rectFromCorners(c).rotation;
      const off = px(30);
      const rad = ((rot - 90) * Math.PI) / 180;
      const knob = [top[0] + Math.cos(rad) * off, top[1] + Math.sin(rad) * off];
      s('line', { x1: top[0], y1: top[1], x2: knob[0], y2: knob[1], class: 'ed-rot-stem' }, gSel);
      s('circle', { cx: knob[0], cy: knob[1], r: px(7), class: 'ed-handle ed-rot-handle' }, gHandles);
      handles.push({ kind: 'photo-rotate', x: knob[0], y: knob[1], priority: 1 });
      if (drag?.type === 'handle' && drag.hd.kind === 'photo-rotate' && drag.moved) pill(gDims, knob, formatAngle(drag.angle ?? 0), { dy: -20, strong: true });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Keyboard helpers used by index.js
  // ---------------------------------------------------------------------------------------------
  function setSpace(down) {
    spaceDown = down;
    svg.style.cursor = down ? 'grab' : '';
  }
  /** Re-run the active drag when Shift/Alt change mid-gesture. */
  function modifiersChanged(ev) {
    if (!lastPointer) return;
    lastPointer = { ...lastPointer, shiftKey: ev.shiftKey, altKey: ev.altKey };
    if (drag) updateDrag(drag, lastPointer);
    else if (drawing || ghost) hoverAt(lastPointer, toLayout(lastPointer.clientX, lastPointer.clientY));
  }

  // ---------------------------------------------------------------------------------------------
  // Device drag-and-drop target (Devices panel → machine tile)
  // ---------------------------------------------------------------------------------------------
  /** Machine under a client point (for linking by drag), or null. */
  function machineAt(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    const p = toLayout(clientX, clientY);
    const arr = ed.doc.machines ?? [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] && hitItem('machines', arr[i], p, px(6))) return arr[i];
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------
  svg.setAttribute('tabindex', '-1');
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('lostpointercapture', (ev) => { if (drag && pointers.has(ev.pointerId)) onPointerCancel(ev); });
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDblClick);
  const leave = () => { if (!drag) { hover = null; ghost = null; ed.setCursor(null); ed.invalidate('overlay'); } };
  svg.addEventListener('pointerleave', leave);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onResize()) : null;
  ro?.observe(svg);
  const mo = new MutationObserver(() => ed.invalidate('view'));
  mo.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });

  return {
    renderOverlay,
    fit,
    zoomAt,
    zoomBy: (f) => zoomAt(f),
    panBy,
    getView,
    setView,
    zoomPercent,
    ppu,
    toScreen,
    toLayout,
    machineAt,
    measure,
    photoCorners,
    setPhoto,
    cancelGesture,
    finishDrawing,
    undoDrawingPoint,
    get drawing() { return drawing; },
    get dragging() { return !!drag; },
    setSpace,
    modifiersChanged,
    clearMeasureCache() { measureCache = new Map(); },
    destroy() {
      destroyed = true;
      ro?.disconnect();
      mo.disconnect();
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', onPointerUp);
      svg.removeEventListener('pointercancel', onPointerCancel);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('dblclick', onDblClick);
      svg.removeEventListener('pointerleave', leave);
      svg.removeAttribute('tabindex');
      svg.style.cursor = '';
      svg.classList.remove('ed-panning');
      root.remove();
    },
  };
}
