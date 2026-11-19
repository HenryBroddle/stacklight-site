// SVG floor-plan renderer shared by the HUD (view mode) and the layout editor (edit mode).
// Contract: docs/ARCHITECTURE.md §11 — createFloorplan(svg, { onMachineClick, onBackgroundClick }) →
//   { setLayout, updateMachines(snapshotsById, serverOffsetMs, nowFn), setMode, fit, layers, toSvgPoint, destroy }
// Stable structure the editor relies on: <svg viewBox="…"> → g#layer-background, g#layer-rooms, g#layer-walls,
// g#layer-doors, g#layer-objects, g#layer-labels, g#layer-machines, g#layer-overlay; every item group carries
// data-id and data-kind (wall|door|room|object|label|machine). Layout units map 1:1 to SVG user units.
// Machine tiles follow docs/DECISIONS.md D2–D4: status fill + ink, hazard frame for E-STOP, hatch for no data /
// out of service, attention ring (double at 2×), screen-pixel type scale with the drop-lines rule, text kept
// horizontal on rotated tiles. A tile that cannot show its whole name gets a name plate beside it with a leader
// line (g.callouts at the end of g#layer-machines, see callouts.js; desk-sized and inert in the editor, where the
// machine name also comes before the status glyph in the tile). All agent/layout strings are set
// with textContent (never innerHTML).
import { LABEL_STYLES } from '/shared/contracts.js';
import { itemBBox } from '/shared/layout.js';
import { machineView, themeColors, estopPulseActive, HAZARD } from './statusStyle.js';
import { iconGroup } from './icons.js';
import { BASE_SCALE, rotateLayout, findRegion } from './screen.js';
import { photoMesh, fmt } from './photoWarp.js';
import { tileLinesWithoutWord, compactSinceTexts } from './tileContent.js';
import { placeCallouts, tilePolygon } from './callouts.js';
import { doorSwingPaths } from './doors.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const LAYER_NAMES = Object.freeze(['background', 'rooms', 'walls', 'doors', 'objects', 'labels', 'machines', 'overlay']);
const COLLECTION_KIND = Object.freeze({ walls: 'wall', doors: 'door', rooms: 'room', objects: 'object', labels: 'label', machines: 'machine' });
const ASSET_RE = /^assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif)$/i;
const WALL_THICKNESS = Object.freeze({ exterior: 0.75, interior: 0.4, partition: 0.25, former: 0.2 });
const FONT_DISPLAY = "Oswald, 'Arial Narrow', 'Roboto Condensed', sans-serif";
const FONT_BODY = "Raleway, 'Segoe UI', system-ui, sans-serif";
let instanceCounter = 0;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r4 = (v) => Math.round(v * 10000) / 10000;

function el(name, attrs = {}, parent = null) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, typeof v === 'number' ? String(r4(v)) : String(v));
  if (parent) parent.append(e);
  return e;
}

// ---------------------------------------------------------------------------------------------
// Text measurement (canvas, cached) — widths are linear in font size, so we measure at 100 px.
// ---------------------------------------------------------------------------------------------

const measureCanvas = document.createElement('canvas');
const mctx = measureCanvas.getContext('2d');
const widthCache = new Map();
/** Width in px of `text` at 1 px font size for a CSS font "weight family". */
export function textWidth(text, weight = 500, family = FONT_DISPLAY) {
  const key = `${weight}|${family}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    mctx.font = `${weight} 100px ${family}`;
    w = mctx.measureText(text).width / 100;
    if (widthCache.size > 5000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}
/** Clear cached widths (call after web fonts finish loading). */
export function resetTextMetrics() {
  widthCache.clear();
}

/** Longest prefix of `text` + '…' that fits `maxW` px at `size` (or '' when not even 2 characters fit). */
function truncateToWidth(text, maxW, size, weight, family = FONT_DISPLAY) {
  if (textWidth(text, weight, family) * size <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0, hi = chars.length - 1, best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = `${chars.slice(0, mid).join('').trimEnd()}…`;
    if (textWidth(cand, weight, family) * size <= maxW) { best = cand; lo = mid + 1; } else hi = mid - 1;
  }
  return Array.from(best).length >= 3 ? best : '';
}

/** Greedy word wrap into at most `maxLines` lines of width ≤ maxW (last line truncated). */
function wrapToWidth(text, maxW, size, weight, maxLines = 2, family = FONT_DISPLAY) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const cand = cur ? `${cur} ${words[i]}` : words[i];
    if (textWidth(cand, weight, family) * size <= maxW || !cur) cur = cand;
    else {
      lines.push(cur);
      cur = words[i];
      if (lines.length === maxLines - 1) { cur = words.slice(i).join(' '); break; }
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines).map((l, i, arr) => (i === arr.length - 1 ? truncateToWidth(l, maxW, size, weight, family) : l));
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/**
 * Width available for a horizontal, centred block of height `blockH` inside a w × h rectangle rotated by `deg`
 * (all px). ≤ 0 when the block does not fit at all.
 */
export function inscribedWidth(w, h, deg, blockH) {
  const t = (((deg % 180) + 180) % 180) * (Math.PI / 180);
  const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const p = w / 2, q = h / 2, b = blockH / 2;
  const lim = (num, den) => (den < 1e-6 ? (num >= 0 ? Infinity : -Infinity) : num / den);
  const a = Math.min(lim(p - b * s, c), lim(q - b * c, s));
  return Number.isFinite(a) ? 2 * a : -1;
}

/** Horizontal room interval at height y around x for a polygon (for auto-fitting room names). */
function polygonSpanAt(points, x, y) {
  const xs = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
  }
  xs.sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i += 2) if (x >= xs[i] && x <= xs[i + 1]) return [xs[i], xs[i + 1]];
  return null;
}

function bboxOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

const validPoints = (pts, min) => Array.isArray(pts) && pts.length >= min && pts.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));
const validRect = (it) => [it?.x, it?.y, it?.w, it?.h].every(finite) && it.w > 0 && it.h > 0;

// ---------------------------------------------------------------------------------------------
// Tile content layout (screen px), docs/DECISIONS.md D4: a fixed type scale; lines in priority order
// (icon, status word, timer, name, reason, fault, down, program). Low-priority lines are dropped bottom-up
// before the core lines (icon, word, timer) shrink; nothing goes below the floor size; a line that cannot fit
// even alone (after alternatives, wrapping or truncation) is skipped.
// ---------------------------------------------------------------------------------------------

const LINE_GAP = 0.16;
const LINE_HEIGHT = 1.12;
const CORE_PRIO = 2;          // icon 0, word 1, timer 2
const NON_CORE_MIN_SCALE = 0.72;
const EDITOR_NAME_MIN = 11;   // px: smallest machine name on an editor tile (a desk screen, read up close)
const EDITOR_PLATE_SIZE = 14; // px: name plate text in the editor
const PHONE_PLATE_SIZES = [13, 11]; // px: name plate text on a phone-sized plan (opts.compact)

/**
 * Plate text for a phone-sized plan: the first word of a machine's name ("Robodrill" for "Robodrill D21LiB5") when
 * no other machine's name starts with it, else the whole name.
 * @param {string[]} names
 * @returns {Map<string, string>} name → plate text
 */
export function shortMachineNames(names) {
  const first = (n) => String(n).trim().split(/\s+/)[0] ?? '';
  const counts = new Map();
  for (const n of names) { const f = first(n).toLowerCase(); counts.set(f, (counts.get(f) ?? 0) + 1); }
  const out = new Map();
  for (const n of names) {
    const f = first(n);
    out.set(n, f.length >= 3 && f !== String(n).trim() && counts.get(f.toLowerCase()) === 1 ? f : String(n));
  }
  return out;
}

function lineHeight(l) {
  return l.kind === 'icon' ? l.size : l.size * LINE_HEIGHT * (l.rows?.length || 1);
}
function blockHeight(lines) {
  let h = 0;
  lines.forEach((l, i) => {
    h += lineHeight(l);
    if (i < lines.length - 1) h += l.size * LINE_GAP;
  });
  return h;
}

/**
 * Size one line for an available width. Mutates `l` (size, text, rows). Returns false when it cannot fit.
 * Order of attempts: preferred text shrunk down to `min`; alternative texts; wrapping; truncation.
 */
function sizeLine(l, target, availW) {
  l.rows = null;
  l.text = l.fullText;
  if (l.kind === 'icon') {
    l.size = Math.min(target, availW);
    return l.size >= l.min - 0.01;
  }
  const texts = [l.fullText, ...(l.alts ?? [])];
  for (const t of texts) {
    const unit = l.measure(t);
    const size = Math.min(target, unit > 0 ? availW / unit : target);
    if (size >= l.min - 0.01) { l.size = size; l.text = t; return true; }
  }
  // wrapping that keeps the whole text; then shorter forms (lateAlts, e.g. "since 3:14p"); then cut text
  const wrapAt = (whole) => {
    for (let s = target; s >= l.min - 0.01; s -= Math.max(0.5, s * 0.05)) {
      const rows = wrapToWidth(l.fullText, availW, s, l.weight, l.wrap);
      if (whole && rows.join(' ') !== l.fullText.split(/\s+/).filter(Boolean).join(' ')) continue;
      if (rows.length && rows.every((row) => row && textWidth(row, l.weight) * s <= availW + 0.5)) { l.rows = rows; l.size = s; return true; }
    }
    return false;
  };
  if (l.wrap && wrapAt(true)) return true;
  for (const t of l.lateAlts ?? []) {
    const unit = l.measure(t);
    const size = Math.min(target, unit > 0 ? availW / unit : target);
    if (size >= l.min - 0.01) { l.size = size; l.text = t; return true; }
  }
  // a clock time cut to "since 3:5…" is misleading: a timer with shorter forms is dropped instead
  if (l.wrap && !l.lateAlts?.length && wrapAt(false)) return true;
  if (l.truncate) {
    const t = truncateToWidth(l.fullText, availW, l.min, l.weight);
    if (t) { l.text = t; l.size = l.min; return true; }
  }
  return false;
}

/** Try a set of lines at uniform scale `s` (each line ≥ its min). Returns sized copies or null. */
function trySet(set, s, boxW, boxH, deg) {
  const lines = set.map((c) => ({ ...c, size: Math.max(c.min, c.pref * s) }));
  // two passes: width-capping shrinks lines, which lowers the block and (for rotated tiles) widens the box
  for (let pass = 0; pass < 2; pass++) {
    const H = blockHeight(lines);
    if (H > boxH + 0.5) return null;
    const availW = inscribedWidth(boxW, boxH, deg, H);
    if (availW <= 4) return null;
    for (const l of lines) if (!sizeLine(l, Math.max(l.min, l.pref * s), availW)) return null;
  }
  const H = blockHeight(lines);
  return H <= boxH + 0.5 && inscribedWidth(boxW, boxH, deg, H) > 4 ? { lines, height: H } : null;
}

/**
 * Fit priority-ordered candidate lines into a w × h box rotated by `deg` (px).
 * @returns {{ lines: object[], height: number }}
 */
function fitLines(cands, boxW, boxH, deg) {
  // skip lines that cannot fit even alone at their minimum size
  const usable = [...cands].sort((a, b) => a.prio - b.prio).filter((c) => trySet([c], 0, boxW, boxH, deg));
  for (let k = usable.length; k >= 1; k--) {
    const set = usable.slice(0, k);
    const minScale = set.some((l) => l.prio > CORE_PRIO) ? NON_CORE_MIN_SCALE : 0;
    let best = trySet(set, 1, boxW, boxH, deg);
    if (!best) {
      let lo = minScale, hi = 1;
      const atMin = trySet(set, lo, boxW, boxH, deg);
      if (atMin) {
        best = atMin;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          const r = trySet(set, mid, boxW, boxH, deg);
          if (r) { best = r; lo = mid; } else hi = mid;
        }
      }
    }
    if (best) return best;
  }
  return { lines: [], height: 0 };
}

// ---------------------------------------------------------------------------------------------
// createFloorplan
// ---------------------------------------------------------------------------------------------

/**
 * @param {SVGSVGElement} svg
 * @param {{ onMachineClick?: (id: string, ev: Event) => void, onBackgroundClick?: (ev: Event) => void,
 *           theme?: 'dark'|'light', settings?: object, kiosk?: boolean, scale?: object, showGrid?: boolean,
 *           rotation?: number, region?: string|null, motion?: 'full'|'reduced'|'none' }} [options]
 */
export function createFloorplan(svg, options = {}) {
  const uid = `fp${++instanceCounter}`;
  const opts = {
    theme: 'dark', settings: {}, kiosk: false, compact: false, scale: { k: 1, ...BASE_SCALE }, showGrid: false, rotation: 0, region: null, motion: 'full',
    ...options,
  };
  let handlers = { onMachineClick: options.onMachineClick ?? null, onBackgroundClick: options.onBackgroundClick ?? null };
  let mode = 'view';
  let rawLayout = null;
  let layout = null;              // rendered (possibly rotated) layout
  let extents = { x: 0, y: 0, w: 100, h: 100 };
  let snapshots = new Map();
  let serverOffsetMs = 0;
  let nowFn = () => Date.now();
  let stale = false;
  let frozenNow = null;
  let ppu = 1;
  let destroyed = false;
  const itemCache = new Map();   // id → { json, g, coll }
  const tiles = new Map();       // machine id → { sig, status, g }
  const labelFits = [];          // px-sized room/object names, re-laid out on zoom
  let calloutSig = null;         // inputs of the last name-plate placement
  let calloutPlaced = new Map(); // machine id → last placement (kept while valid, so plates do not jump)
  let calloutEpoch = 0;          // bumped when the view box, zoom or static layers change
  let currentFit = null;         // fitter created by the item being rendered

  // ----- skeleton --------------------------------------------------------------------------------
  svg.classList.add('floorplan');
  if (!svg.getAttribute('preserveAspectRatio')) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  let defs = svg.querySelector(':scope > defs');
  if (!defs) {
    defs = el('defs');
    svg.prepend(defs);
  }
  /** @type {Record<string, SVGGElement>} */
  const layers = {};
  for (const name of LAYER_NAMES) {
    let g = svg.querySelector(`:scope > g#layer-${name}`);
    if (!g) g = el('g', { id: `layer-${name}`, class: `layer layer-${name}` }, svg);
    layers[name] = g;
  }
  const patterns = {
    hazard: el('pattern', { id: `${uid}-hazard`, patternUnits: 'userSpaceOnUse', width: 1, height: 1, patternTransform: 'rotate(45)' }, defs),
    hatch: el('pattern', { id: `${uid}-hatch`, patternUnits: 'userSpaceOnUse', width: 1, height: 1, patternTransform: 'rotate(45)' }, defs),
    stale: el('pattern', { id: `${uid}-stale`, patternUnits: 'userSpaceOnUse', width: 1, height: 1, patternTransform: 'rotate(-45)' }, defs),
    grid: el('pattern', { id: `${uid}-grid`, patternUnits: 'userSpaceOnUse', width: 1, height: 1 }, defs),
  };
  const doorMask = el('mask', { id: `${uid}-doorcuts`, maskUnits: 'userSpaceOnUse' }, defs);
  layers.walls.setAttribute('mask', `url(#${uid}-doorcuts)`);

  function updatePatterns() {
    const T = themeColors(opts.theme);
    const k = opts.scale.k || 1;
    const px = (v) => v / ppu;
    const hz = px(18 * k);
    setPattern(patterns.hazard, hz, [['rect', { x: 0, y: 0, width: hz, height: hz, fill: HAZARD.yellow }], ['rect', { x: 0, y: 0, width: hz / 2, height: hz, fill: HAZARD.black }]]);
    const ht = px(11 * k);
    setPattern(patterns.hatch, ht, [['rect', { x: 0, y: 0, width: px(2.2 * k), height: ht, fill: T.hatch }]]);
    const st = px(14 * k);
    setPattern(patterns.stale, st, [['rect', { x: 0, y: 0, width: px(3 * k), height: st, fill: T.staleHatch }]]);
    const g = finite(layout?.grid) && layout.grid > 0 ? layout.grid : 1;
    let step = g;
    while (step * ppu < 8) step *= 2;
    setPattern(patterns.grid, step, [['path', { d: `M${step} 0 H0 V${step}`, fill: 'none', stroke: T.grid, 'stroke-width': px(1) }]]);
  }
  function setPattern(p, size, children) {
    p.setAttribute('width', String(r4(size)));
    p.setAttribute('height', String(r4(size)));
    p.replaceChildren(...children.map(([n, a]) => el(n, a)));
  }

  // ----- view box / scale ------------------------------------------------------------------------
  function computeExtents() {
    if (!layout) return { x: 0, y: 0, w: 100, h: 100 };
    const W = layout.width, H = layout.height;
    const m = Math.max(2, 0.04 * Math.max(W, H));
    return { x: -m, y: -m, w: W + 2 * m, h: H + 2 * m };
  }
  /** Reset the view box to the whole layout (or a region rect in layout units). */
  function fit(rect) {
    let r = rect;
    if (!r && opts.region && layout) {
      const reg = findRegion(layout, opts.region);
      if (reg) { const m = Math.max(0.5, 0.02 * Math.max(reg.w, reg.h)); r = { x: reg.x - m, y: reg.y - m, w: reg.w + 2 * m, h: reg.h + 2 * m }; }
    }
    if (!r) r = extents;
    svg.setAttribute('viewBox', `${r4(r.x)} ${r4(r.y)} ${r4(r.w)} ${r4(r.h)}`);
    relayout();
  }
  function getViewBox() {
    const vb = svg.viewBox?.baseVal;
    return vb && vb.width > 0 ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height } : { ...extents };
  }
  function setViewBox(r) {
    if (![r?.x, r?.y, r?.w, r?.h].every(finite) || r.w <= 0 || r.h <= 0) return;
    svg.setAttribute('viewBox', `${r4(r.x)} ${r4(r.y)} ${r4(r.w)} ${r4(r.h)}`);
    relayout();
  }
  function measurePpu() {
    const m = svg.getScreenCTM?.();
    if (m && m.a > 0) return Math.hypot(m.a, m.b);
    const rect = svg.getBoundingClientRect();
    const vb = getViewBox();
    return rect.width > 0 && vb.w > 0 ? Math.min(rect.width / vb.w, rect.height / vb.h) : 1;
  }

  let relayoutQueued = false;
  function relayout() {
    if (destroyed) return;
    const next = measurePpu();
    ppu = next > 0 && Number.isFinite(next) ? next : 1;
    updatePatterns();
    for (const fn of labelFits) fn();
    for (const t of tiles.values()) t.sig = null;
    calloutEpoch++;
    renderMachines();
  }
  function queueRelayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => { relayoutQueued = false; relayout(); });
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(queueRelayout) : null;
  ro?.observe(svg);
  const mo = new MutationObserver(queueRelayout);
  mo.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });

  // ----- static layers ---------------------------------------------------------------------------
  function hudHidden(it) {
    return mode === 'view' && it.hud === false;
  }

  function setLayout(next, { refit } = {}) {
    if (!next || !finite(next.width) || !finite(next.height) || next.width <= 0 || next.height <= 0) return;
    const prevDims = layout ? `${layout.width}x${layout.height}|${opts.rotation}|${opts.region}` : null;
    rawLayout = next;
    layout = opts.rotation ? rotateLayout(next, opts.rotation) : next;
    extents = computeExtents();
    renderStatic();
    syncMachineGroups();
    const dims = `${layout.width}x${layout.height}|${opts.rotation}|${opts.region}`;
    if (refit || prevDims !== dims || !svg.getAttribute('viewBox')) fit();
    else relayout();
  }

  function renderStatic() {
    labelFits.length = 0;
    const seen = new Set();
    for (const coll of ['rooms', 'walls', 'doors', 'objects', 'labels']) {
      const layer = layers[coll];
      const items = Array.isArray(layout[coll]) ? layout[coll] : [];
      let prev = null;
      for (const it of items) {
        if (!it || typeof it.id !== 'string') continue;
        seen.add(it.id);
        const json = `${mode}|${opts.theme}|${opts.kiosk}|${JSON.stringify(it)}`;
        let entry = itemCache.get(it.id);
        if (!entry || entry.json !== json || entry.coll !== coll) {
          currentFit = null;
          const g = renderItem(coll, it);
          if (entry?.g?.isConnected) entry.g.replaceWith(g);
          entry = { json, g, coll, fitFn: currentFit };
          itemCache.set(it.id, entry);
        }
        if (entry.fitFn) labelFits.push(entry.fitFn);
        // keep document order = layout order
        const anchor = prev ? prev.nextSibling : layer.firstChild;
        if (entry.g !== anchor) layer.insertBefore(entry.g, anchor);
        prev = entry.g;
      }
    }
    for (const [id, entry] of itemCache) {
      if (!seen.has(id)) { entry.g.remove(); itemCache.delete(id); }
    }
    renderBackground();
    renderDoorMask();
  }

  function itemGroup(coll, it, extraClass = '') {
    const g = el('g', { 'data-id': it.id, 'data-kind': COLLECTION_KIND[coll], class: `item ${COLLECTION_KIND[coll]}${extraClass ? ` ${extraClass}` : ''}` });
    if (hudHidden(it)) g.setAttribute('display', 'none');
    if (it.hud === false) g.classList.add('hud-off');
    return g;
  }

  function renderItem(coll, it) {
    const T = themeColors(opts.theme);
    const kindClass = typeof it.kind === 'string' ? `${COLLECTION_KIND[coll]}-${it.kind}` : '';
    switch (coll) {
      case 'walls': {
        const style = typeof it.style === 'string' ? it.style : 'interior';
        const g = itemGroup(coll, it, `wall-${style}`);
        if (!validPoints(it.points, 2)) return g;
        const th = finite(it.thickness) && it.thickness > 0 ? it.thickness : Object.hasOwn(WALL_THICKNESS, style) ? WALL_THICKNESS[style] : 0.4;
        const pts = it.points.map(([x, y]) => `${r4(x)},${r4(y)}`).join(' ');
        const former = style === 'former';
        el(it.closed ? 'polygon' : 'polyline', {
          points: pts, fill: 'none', stroke: former ? T.former : T.wall, 'stroke-width': th,
          'stroke-linejoin': 'miter', 'stroke-linecap': former ? 'butt' : 'square',
          'stroke-dasharray': former ? `${r4(th * 4)} ${r4(th * 3)}` : null,
        }, g);
        if (typeof it.label === 'string' && it.label.trim()) wallLabel(g, it, T);
        return g;
      }
      case 'doors': return renderDoor(it, T);
      case 'rooms': return renderRoom(it, T);
      case 'objects': return renderObject(it, T, kindClass);
      case 'labels': return renderLabel(it, T);
      default: return itemGroup(coll, it);
    }
  }

  function wallLabel(g, it, T) {
    // label along the longest segment, kept upright, in layout units (it is part of the drawing)
    let best = null;
    for (let i = 0; i + 1 < it.points.length; i++) {
      const [a, b] = [it.points[i], it.points[i + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!best || len > best.len) best = { a, b, len };
    }
    if (!best || best.len < 3) return;
    let ang = (Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0]) * 180) / Math.PI;
    if (ang >= 90) ang -= 180; else if (ang < -90) ang += 180; // vertical walls read bottom-to-top
    const mx = (best.a[0] + best.b[0]) / 2, my = (best.a[1] + best.b[1]) / 2;
    const t = el('text', {
      x: 0, y: -0.55, transform: `translate(${r4(mx)} ${r4(my)}) rotate(${r4(ang)})`, 'text-anchor': 'middle',
      'font-size': 0.85, fill: T.label, 'font-family': FONT_BODY, 'font-weight': 600, class: 'wall-label', 'letter-spacing': 0.04,
    }, g);
    t.textContent = it.label;
  }

  function renderDoor(d, T) {
    const g = itemGroup('doors', d, `door-${typeof d.kind === 'string' ? d.kind : 'door'}`);
    if (![d.x, d.y, d.width].every(finite) || d.width <= 0) return g;
    const w = d.width;
    const rot = finite(d.rotation) ? d.rotation : 0;
    g.setAttribute('transform', `translate(${r4(d.x)} ${r4(d.y)}) rotate(${r4(rot)})`);
    const kind = d.kind ?? 'door';
    const line = { stroke: T.door, 'stroke-width': 1.6, fill: 'none', 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round' };
    // invisible hit area covering the opening (editor selection)
    el('rect', { x: -w / 2, y: -0.6, width: w, height: 1.2, fill: 'transparent', class: 'door-hit' }, g);
    // jambs
    el('path', { d: `M${r4(-w / 2)} -0.45 V0.45 M${r4(w / 2)} -0.45 V0.45`, ...line }, g);
    // inward direction: +y local unless the layout centre lies on the other side
    const rad = (rot * Math.PI) / 180;
    const ny = { x: -Math.sin(rad), y: Math.cos(rad) };
    const toC = layout ? { x: layout.width / 2 - d.x, y: layout.height / 2 - d.y } : { x: 0, y: 1 };
    const inward = ny.x * toC.x + ny.y * toC.y >= 0 ? 1 : -1;
    // leaves drawn open at 90°, each with its swing arc centred on its hinge (doors.js)
    const swingPaths = doorSwingPaths({ width: w, kind, swing: d.swing, inward });
    if (swingPaths) {
      el('path', { d: swingPaths.leaves, ...line }, g);
      el('path', { d: swingPaths.arcs, ...line, 'stroke-dasharray': '4 3', opacity: 0.7 }, g);
    } else if (kind === 'rollup') {
      el('path', { d: `M${r4(-w / 2)} 0 H${r4(w / 2)}`, ...line, 'stroke-dasharray': '6 4' }, g);
    } else if (kind === 'entrance') {
      // arrow from outside pointing in (like the sketch's arrow at the main door)
      const len = Math.max(2.4, w * 0.9);
      const y0 = -inward * (len + 0.4), y1 = -inward * 0.5;
      const head = Math.min(1.1, w * 0.32);
      el('path', { d: `M0 ${r4(y0)} V${r4(y1)}`, stroke: T.wall, 'stroke-width': 0.32, 'stroke-linecap': 'round', fill: 'none' }, g);
      el('path', { d: `M${r4(-head)} ${r4(y1 - inward * head)} L0 ${r4(y1)} L${r4(head)} ${r4(y1 - inward * head)}`, stroke: T.wall, 'stroke-width': 0.32, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }, g);
    }
    return g;
  }

  function renderDoorMask() {
    const m = Math.max(extents.w, extents.h);
    const children = [el('rect', { x: extents.x - m, y: extents.y - m, width: extents.w + 2 * m, height: extents.h + 2 * m, fill: '#fff' })];
    for (const d of layout.doors ?? []) {
      if (![d?.x, d?.y, d?.width].every(finite) || d.width <= 0) continue;
      children.push(el('rect', {
        x: -d.width / 2, y: -1.1, width: d.width, height: 2.2, fill: '#000',
        transform: `translate(${r4(d.x)} ${r4(d.y)}) rotate(${r4(finite(d.rotation) ? d.rotation : 0)})`,
      }));
    }
    doorMask.setAttribute('x', String(r4(extents.x - m)));
    doorMask.setAttribute('y', String(r4(extents.y - m)));
    doorMask.setAttribute('width', String(r4(extents.w + 2 * m)));
    doorMask.setAttribute('height', String(r4(extents.h + 2 * m)));
    doorMask.replaceChildren(...children);
  }

  /**
   * Nudge a room name (centre cx,cy; size w×h in layout units) off machine tiles and their attention rings,
   * staying inside the room. Returns the nearest clear centre, or the original one.
   */
  function clearOfMachines(cx, cy, w, h, bb, poly) {
    const k = opts.scale.k || 1;
    const m = ((3 + 7 + 4 + 7 + 4) * k) / ppu; // double ring + breathing room
    const boxes = [];
    for (const mc of layout?.machines ?? []) {
      const b = validRect(mc) ? itemBBox('machines', mc) : null;
      if (b) boxes.push({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });
    }
    const hits = (x, y) => boxes.some((b) => x - w / 2 < b.maxX && x + w / 2 > b.minX && y - h / 2 < b.maxY && y + h / 2 > b.minY);
    const inside = (x, y) => x - w / 2 >= bb.minX && x + w / 2 <= bb.maxX && y - h / 2 >= bb.minY && y + h / 2 <= bb.maxY
      && [[x - w / 2, y], [x + w / 2, y], [x, y - h / 2], [x, y + h / 2], [x, y]].every(([px, py]) => {
        // inside the (possibly L-shaped) room: probe slightly inwards so points on an edge still count
        const sp = polygonSpanAt(poly, px + (px < x ? 0.01 : px > x ? -0.01 : 0), py + (py < y ? 0.01 : py > y ? -0.01 : 0));
        return !!sp;
      });
    if (!hits(cx, cy)) return [cx, cy];
    const step = 0.25;
    const maxR = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    for (let r = step; r <= maxR; r += step) {
      let best = null;
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
        const x = cx + dx, y = cy + dy;
        if (inside(x, y) && !hits(x, y)) { best = [x, y]; break; }
      }
      if (best) return best;
    }
    return [cx, cy];
  }

  function renderRoom(room, T) {
    const g = itemGroup('rooms', room, `room-${typeof room.kind === 'string' ? room.kind : 'other'}`);
    let bb;
    let poly = null;
    if (validPoints(room.points, 3)) {
      poly = room.points;
      el('polygon', { points: room.points.map(([x, y]) => `${r4(x)},${r4(y)}`).join(' '), fill: T.roomFill, stroke: T.roomStroke, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }, g);
      bb = bboxOfPoints(room.points);
    } else if (validRect(room)) {
      el('rect', { x: room.x, y: room.y, width: room.w, height: room.h, fill: T.roomFill, stroke: T.roomStroke, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }, g);
      bb = { minX: room.x, minY: room.y, maxX: room.x + room.w, maxY: room.y + room.h };
      poly = [[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.maxX, bb.maxY], [bb.minX, bb.maxY]];
    } else return g;
    if (room.showLabel === false || typeof room.name !== 'string' || !room.name.trim()) return g;
    const off = Array.isArray(room.labelOffset) && finite(room.labelOffset[0]) && finite(room.labelOffset[1]) ? room.labelOffset : [0, 0];
    const cx = (bb.minX + bb.maxX) / 2 + off[0];
    const cy = (bb.minY + bb.maxY) / 2 + off[1];
    const span = polygonSpanAt(poly, cx, cy) ?? [bb.minX, bb.maxX];
    const halfW = Math.max(0, Math.min(cx - span[0], span[1] - cx));
    const holder = el('g', { class: 'room-label', 'pointer-events': 'none' }, g);
    const text = room.name.toUpperCase();
    const fitFn = () => {
      holder.replaceChildren();
      const s = opts.scale;
      const spacing = 0.08;
      const rowUnit = (r) => textWidth(r, 500) + spacing * Math.max(0, r.length - 1);
      // one line, or two lines split where the halves are most balanced ("SHIPPING /" + "RECEIVING")
      const options = [[text]];
      const words = text.split(' ');
      if (words.length > 1) {
        let best = null;
        for (let i = 1; i < words.length; i++) {
          const rows = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
          const w = Math.max(...rows.map(rowUnit));
          if (!best || w < best.w) best = { rows, w };
        }
        options.push(best.rows);
      }
      let chosen = null;
      for (const rows of options) {
        const unit = Math.max(...rows.map(rowUnit));
        const size = Math.min(s.room, (halfW * 2 * ppu * 0.88) / unit, ((bb.maxY - bb.minY) * ppu * 0.5) / (rows.length * 1.15));
        if (size >= s.roomMin) { chosen = { rows, size, unit }; break; }
      }
      if (!chosen) return;
      const { rows, size, unit } = chosen;
      const w = (unit * size) / ppu, hgt = (rows.length * 1.15 * size) / ppu;
      const [lx, ly] = clearOfMachines(cx, cy, w, hgt, bb, poly);
      holder.setAttribute('transform', `translate(${r4(lx)} ${r4(ly)}) scale(${r4(1 / ppu)})`);
      rows.forEach((row, i) => {
        const t = el('text', {
          x: 0, y: (i - (rows.length - 1) / 2) * size * 1.15, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size,
          'font-family': FONT_DISPLAY, 'font-weight': 500, 'letter-spacing': `${r4(size * spacing)}`, fill: T.roomName,
        }, holder);
        t.textContent = row;
      });
    };
    currentFit = fitFn;
    fitFn();
    return g;
  }

  function renderObject(o, T, kindClass) {
    const g = itemGroup('objects', o, kindClass);
    if (!validRect(o)) return g;
    const rot = finite(o.rotation) ? o.rotation : 0;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const body = el('g', { transform: rot ? `rotate(${r4(rot)} ${r4(cx)} ${r4(cy)})` : null }, g);
    const rr = Math.min(0.35, Math.min(o.w, o.h) * 0.12);
    el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, rx: rr, fill: T.objectFill, stroke: T.object, 'stroke-width': 1.75, 'vector-effect': 'non-scaling-stroke' }, body);
    if (o.kind === 'stairs') {
      const vertical = o.h >= o.w;
      const n = Math.max(3, Math.floor((vertical ? o.h : o.w) / 1));
      const d = [];
      for (let i = 1; i < n; i++) {
        const t = i / n;
        d.push(vertical ? `M${r4(o.x)} ${r4(o.y + o.h * t)} H${r4(o.x + o.w)}` : `M${r4(o.x + o.w * t)} ${r4(o.y)} V${r4(o.y + o.h)}`);
      }
      el('path', { d: d.join(' '), stroke: T.object, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', fill: 'none' }, body);
    } else if (o.kind === 'compressor') {
      el('circle', { cx, cy, r: Math.min(o.w, o.h) * 0.32, fill: 'none', stroke: T.object, 'stroke-width': 1.25, 'vector-effect': 'non-scaling-stroke' }, body);
    }
    if (o.showLabel === false || typeof o.name !== 'string' || !o.name.trim()) return g;
    const holder = el('g', { class: 'object-label', 'pointer-events': 'none' }, g);
    const text = o.name;
    const fitFn = () => {
      holder.replaceChildren();
      const s = opts.scale;
      const pref = Math.max(s.roomMin, s.label);
      const boxW = o.w * ppu * 0.86, boxH = o.h * ppu * 0.86;
      const unit = textWidth(text, 500, FONT_BODY);
      const availW = inscribedWidth(boxW, boxH, rot, pref * 1.2);
      let size = Math.min(pref, availW / unit, boxH * 0.6);
      let shown = text;
      if (!(size >= s.roomMin)) {
        // try two words per line? keep it simple: truncate at the minimum size
        size = s.roomMin;
        const aw = inscribedWidth(boxW, boxH, rot, size * 1.2);
        shown = aw > 0 ? truncateToWidth(text, aw, size, 500, FONT_BODY) : '';
        if (!shown) return; // too small: labels are hidden rather than overflowing
      }
      holder.setAttribute('transform', `translate(${r4(cx)} ${r4(cy)}) scale(${r4(1 / ppu)})`);
      const t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size, 'font-family': FONT_BODY, 'font-weight': 500, fill: T.objectLabel }, holder);
      t.textContent = shown;
    };
    currentFit = fitFn;
    fitFn();
    return g;
  }

  function renderLabel(l, T) {
    const style = typeof l.style === 'string' ? l.style : 'note';
    const g = itemGroup('labels', l, `label-${style}`);
    if (![l.x, l.y].every(finite) || typeof l.text !== 'string') return g;
    const size = finite(l.size) && l.size > 0 ? l.size : (LABEL_STYLES[style]?.size ?? 1);
    const rot = finite(l.rotation) ? l.rotation : 0;
    g.setAttribute('transform', `translate(${r4(l.x)} ${r4(l.y)})${rot ? ` rotate(${r4(rot)})` : ''}`);
    const display = style === 'title' || style === 'room';
    const t = el('text', {
      x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size,
      'font-family': display ? FONT_DISPLAY : FONT_BODY, 'font-weight': style === 'title' ? 600 : display ? 500 : 500,
      'font-style': style === 'note' ? 'italic' : null, fill: style === 'dim' || style === 'note' ? T.roomName : T.label,
      'letter-spacing': display ? r4(size * 0.06) : null,
    }, g);
    t.textContent = display ? l.text.toUpperCase() : l.text;
    return g;
  }

  function renderBackground() {
    layers.background.replaceChildren();
    if (opts.showGrid && !opts.kiosk && layout) {
      el('rect', { x: 0, y: 0, width: layout.width, height: layout.height, fill: `url(#${uid}-grid)`, class: 'grid', 'pointer-events': 'none' }, layers.background);
    }
    const b = layout?.background;
    if (!b || b.visible !== true || opts.kiosk || typeof b.src !== 'string' || !ASSET_RE.test(b.src)) return;
    if (![b.x, b.y, b.width, b.height].every(finite) || b.width <= 0 || b.height <= 0) return;
    const opacity = finite(b.opacity) ? Math.min(1, Math.max(0, b.opacity)) : 0.35;
    const href = `/layouts/${b.src}`;
    // 4-corner fit (D5): the same projective map as the editor's CSS matrix3d(), drawn as an SVG triangle mesh
    // (photoWarp.js). Unusable corners fall back to the rotated rectangle below.
    const mesh = b.corners != null ? photoMesh(b.corners) : null;
    if (mesh) {
      const g = el('g', { class: 'trace-image', opacity, 'pointer-events': 'none' }, layers.background);
      const defs = mesh.some((p) => p.clip) ? el('defs', {}, g) : null;
      mesh.forEach((piece, i) => {
        let clip = null;
        if (piece.clip && defs) {
          clip = `${uid}-bg-${i}`;
          const cp = el('clipPath', { id: clip, clipPathUnits: 'userSpaceOnUse' }, defs);
          el('polygon', { points: piece.clip.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ') }, cp);
        }
        el('image', {
          href, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none',
          transform: `matrix(${piece.matrix.map(fmt).join(' ')})`, 'clip-path': clip ? `url(#${clip})` : null,
        }, g);
      });
      return;
    }
    const rot = finite(b.rotation) ? b.rotation : 0;
    el('image', {
      href, x: b.x, y: b.y, width: b.width, height: b.height, preserveAspectRatio: 'none',
      opacity, class: 'trace-image', 'pointer-events': 'none',
      transform: rot ? `rotate(${r4(rot)} ${r4(b.x + b.width / 2)} ${r4(b.y + b.height / 2)})` : null,
    }, layers.background);
  }

  // ----- machines --------------------------------------------------------------------------------
  function syncMachineGroups() {
    const seen = new Set();
    let prev = null;
    for (const m of layout.machines ?? []) {
      if (!m || typeof m.id !== 'string') continue;
      seen.add(m.id);
      let t = tiles.get(m.id);
      if (!t) {
        const g = el('g', { 'data-id': m.id, 'data-kind': 'machine', class: 'item machine' });
        t = { g, sig: null, status: null, onsetSeen: null };
        tiles.set(m.id, t);
      }
      t.machine = m;
      t.sig = null;
      const anchor = prev ? prev.nextSibling : layers.machines.firstChild;
      if (t.g !== anchor) layers.machines.insertBefore(t.g, anchor);
      prev = t.g;
    }
    for (const [id, t] of tiles) if (!seen.has(id)) { t.g.remove(); tiles.delete(id); }
    calloutEpoch++;
  }

  function currentNow() {
    if (stale && finite(frozenNow)) return frozenNow;
    const n = nowFn();
    return (finite(n) ? n : Date.now()) + serverOffsetMs;
  }

  function renderMachines() {
    if (!layout || destroyed) return;
    renderTiles();
    renderCallouts();
  }

  function renderTiles() {
    const now = currentNow();
    for (const t of tiles.values()) {
      const snap = snapshots.get(t.machine.id) ?? null;
      let vm = machineView(snap, t.machine, { settings: opts.settings, now, theme: opts.theme });
      if (stale) vm = { ...vm, attention: { ...vm.attention, level: 0 }, timer: vm.timer ? { ...vm.timer, overdue: false } : null };
      const pulse = opts.motion === 'full' && !stale && estopPulseActive(vm, opts.settings);
      const sig = JSON.stringify([
        vm.status, vm.variant, vm.word, vm.fill, vm.ink, vm.icon, vm.reason, vm.timer, vm.down, vm.fault && [vm.fault.code, vm.fault.message, vm.fault.more],
        vm.program, vm.note, vm.badge, vm.attention.level, vm.name, pulse, stale, mode, opts.theme, r4(ppu), opts.scale.k, JSON.stringify(t.machine),
      ]);
      if (sig === t.sig) continue;
      const onset = t.status !== null && t.status !== vm.status;
      t.sig = sig;
      drawTile(t, vm, { pulse, ripple: onset && vm.status === 'ALARM' && vm.inShift && opts.motion === 'full' && !stale && (vm.sinceAge ?? Infinity) < 10_000 });
      t.status = vm.status;
    }
  }

  function drawTile(t, vm, { pulse, ripple }) {
    const m = t.machine;
    const g = t.g;
    const T = themeColors(opts.theme);
    const s = opts.scale;
    const k = s.k || 1;
    g.replaceChildren();
    g.setAttribute('class', `item machine st-${vm.status} v-${vm.variant} att-${vm.attention.level}`);
    g.dataset.status = vm.status;
    t.name = vm.name ? String(vm.name) : '';
    t.nameInTile = false;
    if (!validRect(m)) return;
    const px = (v) => v / ppu;
    const rot = finite(m.rotation) ? m.rotation : 0;
    const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
    const body = el('g', { class: 'tile-body', transform: rot ? `rotate(${r4(rot)} ${r4(cx)} ${r4(cy)})` : null }, g);
    const corner = px(5 * k);

    // attention ring(s) — outside the footprint with a gap (D3)
    if (vm.attention.level > 0 && !stale) {
      const rw = 7 * k, gap = 3 * k;
      for (let i = 0; i < vm.attention.level; i++) {
        const d = px(gap + rw / 2 + i * (rw + 4 * k));
        el('rect', { x: m.x - d, y: m.y - d, width: m.w + 2 * d, height: m.h + 2 * d, rx: corner + d, fill: 'none', stroke: T.ring, 'stroke-width': px(rw), class: `ring ring-${i + 1}` }, body);
      }
    }
    if (ripple) {
      const rp = el('rect', { x: m.x, y: m.y, width: m.w, height: m.h, rx: corner, fill: 'none', stroke: T.ring, 'stroke-width': px(6 * k), class: 'ripple' }, body);
      rp.addEventListener('animationend', () => rp.remove(), { once: true });
      setTimeout(() => rp.remove(), 4000);
    }

    // fill + border
    const unbound = vm.variant === 'unbound';
    const dashed = vm.border === 'dashed';
    const borderColor = vm.outline ? '#0b0f14' : vm.borderColor ?? (opts.theme === 'light' ? 'rgba(11,15,20,0.35)' : 'rgba(0,0,0,0.35)');
    el('rect', {
      x: m.x, y: m.y, width: m.w, height: m.h, rx: corner,
      fill: unbound ? (opts.theme === 'light' ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.02)') : vm.fill,
      stroke: borderColor, 'stroke-width': px((dashed ? 2.5 : vm.outline ? 2 : 1.5) * k),
      'stroke-dasharray': dashed ? `${r4(px(10 * k))} ${r4(px(6 * k))}` : null, class: 'tile-fill', 'pointer-events': 'all',
    }, body);
    let inset = 0;
    if (vm.pattern === 'hazard' && vm.variant === 'status') {
      const band = Math.max(6, Math.min(14 * k, (Math.min(m.w, m.h) * ppu) / 7));
      inset = band;
      const i = px(band / 2);
      el('rect', {
        x: m.x + i, y: m.y + i, width: Math.max(0, m.w - 2 * i), height: Math.max(0, m.h - 2 * i), rx: Math.max(0, corner - i),
        fill: 'none', stroke: `url(#${uid}-hazard)`, 'stroke-width': px(band), class: `hazard${pulse ? ' pulse' : ''}`,
      }, body);
    } else if (vm.pattern === 'hatch' && !unbound) {
      el('rect', { x: m.x, y: m.y, width: m.w, height: m.h, rx: corner, fill: `url(#${uid}-hatch)`, class: 'hatch', 'pointer-events': 'none' }, body);
    } else if (!unbound && opts.theme === 'dark') {
      const i = px(1.5 * k);
      el('rect', { x: m.x + i, y: m.y + i, width: Math.max(0, m.w - 2 * i), height: Math.max(0, m.h - 2 * i), rx: Math.max(0, corner - i), fill: 'none', stroke: T.hairline, 'stroke-width': px(1.5 * k), class: 'hairline', 'pointer-events': 'none' }, body);
    }
    el('rect', { x: m.x, y: m.y, width: m.w, height: m.h, rx: corner, fill: `url(#${uid}-stale)`, class: 'stale-hatch', 'pointer-events': 'none' }, body);

    // content in screen px, centred, unrotated
    const content = el('g', { class: 'tile-content', transform: `translate(${r4(cx)} ${r4(cy)}) scale(${r4(1 / ppu)})`, 'pointer-events': 'none' }, g);
    const pad = inset + 6 * k;
    const boxW = Math.max(0, m.w * ppu - 2 * pad);
    const boxH = Math.max(0, m.h * ppu - 2 * pad);
    const shown = layoutContent(content, vm, boxW, boxH, rot, T);
    const nameLine = shown.find((l) => l.key === 'name');
    t.name = vm.name ? String(vm.name) : '';
    // whole name in the tile: on one line, or (editor) wrapped into rows that still hold every word
    t.nameInTile = !!nameLine && nameLine.text === nameLine.fullText
      && (!nameLine.rows || nameLine.rows.join(' ') === nameLine.fullText.split(/\s+/).filter(Boolean).join(' '));

    // condition badge (warning / fault while running) at the top-right corner
    if (vm.badge && vm.variant === 'status' && Math.min(m.w, m.h) * ppu >= 3.2 * s.floor) {
      const r = Math.max(12, 15 * k);
      const rad = (rot * Math.PI) / 180;
      const ox = (m.w * ppu) / 2 - r * 0.15, oy = -(m.h * ppu) / 2 + r * 0.15;
      const bx = ox * Math.cos(rad) - oy * Math.sin(rad), by = ox * Math.sin(rad) + oy * Math.cos(rad);
      const badge = el('g', { class: `badge badge-${vm.badge}`, transform: `translate(${r4(cx)} ${r4(cy)}) scale(${r4(1 / ppu)}) translate(${r4(bx)} ${r4(by)})`, 'pointer-events': 'none' }, g);
      el('circle', { cx: 0, cy: 0, r, fill: T.ring, stroke: T.bg, 'stroke-width': 2 * k }, badge);
      badge.append(iconGroup('triangle', { size: r * 1.15, color: T.ringInk, x: -r * 0.575, y: -r * 0.62 }));
    }

    // accessibility
    if (!opts.kiosk && mode === 'view') {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
    } else {
      g.removeAttribute('tabindex');
      g.removeAttribute('role');
    }
    const label = [vm.name, vm.word, vm.reason, vm.timer?.text, vm.fault ? `${vm.fault.code} ${vm.fault.message}` : null, vm.attention.level ? `Needs attention: ${vm.attention.reason}` : null]
      .filter(Boolean).join(', ');
    g.setAttribute('aria-label', label);
    let title = g.querySelector(':scope > title');
    if (!title) title = el('title', {}, g);
    title.textContent = label;
  }

  /** Lay out and draw the tile content; returns the lines drawn. */
  function layoutContent(content, vm, boxW, boxH, rot, T) {
    if (boxW < 8 || boxH < 8) return [];
    const s = opts.scale;
    const ink = vm.ink;
    const cands = [];
    const add = (c) => {
      const weight = c.weight ?? 500;
      cands.push({ truncate: false, wrap: 0, ...c, weight, fullText: c.text ?? '', measure: c.measure ?? ((t) => textWidth(t, weight)) });
    };
    const unbound = vm.variant === 'unbound';
    // In view mode a name that does not fit whole is left out ("4-Axi…" does not say which machine): the name
    // plate beside the tile carries it instead (renderCallouts). The editor still cuts it, as a fallback where no
    // plate fits.
    const cutName = mode !== 'view';
    // priority (D4): icon 0, word 1, timer 2, name 3, reason 4, fault 5, down 6, program 7. In the editor the name
    // is what makes each tile identifiable while it is being placed and linked, so there it comes first (before the
    // glyph: a linked 8' x 8' EDM still reads "EDM"), may shrink below the TV floor to a desk-legible size (the
    // editor is used up close) and may wrap to two rows ("3-Axis" / "B") before it is cut ("3-A…" does not say
    // which one). A tile too small even for that gets a desk-sized plate (renderCallouts).
    const namePrio = (viewPrio) => (mode === 'view' ? viewPrio : -0.5);
    const nameMin = mode === 'view' ? s.floor : Math.min(s.floor, EDITOR_NAME_MIN);
    const nameWrap = mode === 'view' ? 0 : 2;
    add({ kind: 'icon', key: 'icon', prio: 0, order: 1, pref: s.status * 0.9, min: s.floor });
    let timerText = null;
    const pillPad = vm.timer?.overdue ? 0.84 : 0;
    // timer box: digits normalised to "0" so the width (and the layout) does not jitter as time passes
    const timerUnit = (t) => textWidth(t.replace(/\d/g, '0'), 500) + pillPad;
    if (unbound) {
      add({ kind: 'text', key: 'name', prio: namePrio(1), order: 0, text: vm.name, pref: s.name, min: nameMin, wrap: nameWrap, truncate: cutName });
      add({ kind: 'text', key: 'word', prio: 2, order: 2, text: vm.word, pref: s.code * 0.8, min: Math.min(s.floor, s.code * 0.8) });
    } else {
      const wordWrap = vm.word.split(' ').length > 2; // "OUT OF SERVICE" may wrap
      add({ kind: 'text', key: 'word', prio: 1, order: 2, text: vm.word, pref: s.status, min: s.floor, weight: 600, wrap: wordWrap ? 2 : 0 });
      if (vm.timer) {
        timerText = vm.timer.overdue ? `! ${vm.timer.text}` : vm.timer.text;
        const alts = vm.timer.overdue ? [vm.timer.text.replace('≥ ', '≥')] : vm.timer.lowerBound ? [vm.timer.text.replace('≥ ', '≥')] : [];
        // a running counter is glanceable (status size); "since Fri 4:12 PM" / "until Mon 6 AM" is a note (code size)
        const counter = vm.timer.mode === 'elapsed';
        add({ kind: 'timer', key: 'timer', prio: 2, order: 4, text: timerText, alts, lateAlts: counter ? [] : compactSinceTexts(timerText), pref: counter ? s.status * 0.88 : s.code, min: s.floor, measure: timerUnit, wrap: counter ? 0 : 2 });
      }
      if (vm.name) add({ kind: 'text', key: 'name', prio: namePrio(3), order: 0, text: vm.name, pref: s.name, min: nameMin, wrap: nameWrap, truncate: cutName });
      if (vm.reason) add({ kind: 'text', key: 'reason', prio: 4, order: 3, text: vm.reason, pref: s.code, min: s.floor, truncate: true });
      if (vm.fault) {
        const ftext = `${vm.fault.code ? `${vm.fault.code} ` : ''}${vm.fault.message}${vm.fault.more ? ` +${vm.fault.more}` : ''}`;
        add({ kind: 'fault', key: 'fault', prio: 5, order: 6, text: ftext, pref: s.code, min: s.floor, wrap: 2, truncate: true });
      }
      if (vm.down) add({ kind: 'text', key: 'down', prio: 6, order: 5, text: vm.down.text, pref: s.code, min: s.floor, weight: 400 });
      if (vm.program) add({ kind: 'text', key: 'program', prio: 7, order: 7, text: vm.program, pref: s.code * 0.9, min: s.floor, weight: 400, truncate: true });
      if (vm.note) add({ kind: 'text', key: 'note', prio: 7, order: 7, text: vm.note, pref: s.code * 0.9, min: s.floor, weight: 400, truncate: true });
    }
    // Arrangements: B = icon stacked above the word; A = icon inline with the word; C = icon, word and timer on
    // one line (wide tiles). The arrangement that keeps the most (priority-weighted) content wins.
    const iconCand = cands.find((c) => c.key === 'icon');
    const wordCand = cands.find((c) => c.key === 'word');
    const timerCand = cands.find((c) => c.key === 'timer');
    const variants = [fitLines(cands, boxW, boxH, rot)];
    if (wordCand && !unbound && !wordCand.wrap) {
      const inlineWord = { ...wordCand, inlineIcon: true, measure: (t) => textWidth(t, 600) + 1.15 };
      variants.push(fitLines(cands.filter((c) => c !== iconCand).map((c) => (c === wordCand ? inlineWord : c)), boxW, boxH, rot));
      if (timerCand && !timerCand.wrap && boxW > boxH * 1.3) {
        const tt = timerCand.fullText;
        const merged = { ...wordCand, inlineIcon: true, inlineTimer: tt, measure: (t) => textWidth(t, 600) + 1.15 + 0.4 + timerUnit(tt) * 0.88 };
        variants.push(fitLines(cands.filter((c) => c !== iconCand && c !== timerCand).map((c) => (c === wordCand ? merged : c)), boxW, boxH, rot));
      }
    }
    const score = (res) => {
      const keys = new Set(res.lines.map((l) => l.key));
      const has = (k) => keys.has(k) || (k === 'icon' && res.lines.some((l) => l.inlineIcon)) || (k === 'timer' && res.lines.some((l) => l.inlineTimer));
      let sc = 0;
      for (const c of cands) if (has(c.key)) sc += 1000 / (1 + c.prio);
      const w = res.lines.find((l) => l.key === 'word');
      return sc + (w ? w.size : 0) + res.lines.reduce((a, l) => a + l.size * 0.05, 0);
    };
    let best = variants.reduce((a, b) => (score(b) > score(a) ? b : a));
    let lines = best.lines;
    // No status word fits (D4): the glyph stands in for it and the name/timer that fit stay; only a tile too small
    // for its name falls back to fill, ring and a ≥ 40 px glyph.
    if (!lines.some((l) => l.key === 'word') && !unbound) {
      lines = tileLinesWithoutWord(lines, { glyph: s.glyph, floor: s.floor, boxW, boxH, keepName: mode !== 'view' });
      best = { lines, height: blockHeight(lines) };
    }
    lines.sort((a, b) => a.order - b.order);
    let y = -blockHeight(lines) / 2;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind === 'icon') {
        content.append(iconGroup(vm.icon, { size: l.size, color: ink, x: -l.size / 2, y }));
        y += l.size;
      } else {
        const rows = l.rows ?? [l.text];
        for (const row of rows) {
          const base = y + l.size * LINE_HEIGHT * 0.5;
          if (l.inlineIcon) {
            const iconSize = l.size * 0.92;
            const gap = l.size * 0.23;
            const tw = textWidth(row, 600) * l.size;
            const timerSize = l.size * 0.88;
            const timerW = l.inlineTimer ? textWidth(l.inlineTimer, 500) * timerSize + (vm.timer?.overdue ? timerSize * 0.84 : 0) : 0;
            const timerGap = l.inlineTimer ? l.size * 0.4 : 0;
            const x0 = -(iconSize + gap + tw + timerGap + timerW) / 2;
            content.append(iconGroup(vm.icon, { size: iconSize, color: ink, x: x0, y: base - iconSize / 2 }));
            textEl(content, row, x0 + iconSize + gap, base, l.size, 600, ink, 'start', 'word');
            if (l.inlineTimer) drawTimer(content, vm, l.inlineTimer, base, timerSize, T, ink, x0 + iconSize + gap + tw + timerGap + timerW / 2);
          } else if (l.kind === 'timer') {
            drawTimer(content, vm, row, base, l.size, T, ink, 0);
          } else if (l.kind === 'fault' && vm.fault?.code && row === rows[0] && row.startsWith(vm.fault.code)) {
            const t = textEl(content, '', 0, base, l.size, 500, ink, 'middle', 'fault');
            const code = el('tspan', { 'font-weight': 700 }, t);
            code.textContent = vm.fault.code;
            const rest = el('tspan', {}, t);
            rest.textContent = row.slice(vm.fault.code.length);
          } else {
            textEl(content, row, 0, base, l.size, l.weight ?? 500, ink, 'middle', l.key);
          }
          y += l.size * LINE_HEIGHT;
        }
      }
      if (i < lines.length - 1) y += l.size * LINE_GAP;
    }
    return lines;
  }

  function textEl(parent, text, x, y, size, weight, fill, anchor, cls) {
    const t = el('text', {
      x, y, 'font-size': size, 'font-family': FONT_DISPLAY, 'font-weight': weight, fill, 'text-anchor': anchor,
      'dominant-baseline': 'central', class: `t-${cls}`,
    }, parent);
    if (text) t.textContent = text;
    return t;
  }

  function drawTimer(parent, vm, text, base, size, T, ink, cx = 0) {
    const overdue = vm.timer?.overdue;
    if (!overdue) {
      textEl(parent, text, cx, base, size, 500, ink, 'middle', 'timer');
      return;
    }
    const w = textWidth(text, 600) * size;
    const padX = size * 0.4;
    const h = size * 1.12;
    el('rect', { x: cx - w / 2 - padX, y: base - h / 2, width: w + 2 * padX, height: h, rx: h / 2, fill: T.ring, class: 'timer-pill' }, parent);
    textEl(parent, text, cx, base, size, 600, T.ringInk, 'middle', 'timer overdue');
  }

  // ----- name callouts ---------------------------------------------------------------------------
  // A tile too small for its whole name (D4: glyph only) still has to say which machine it is from across the
  // shop: its name goes on a plate beside it, joined by a short leader line. Plates keep clear of every tile's
  // attention-ring band and of each other, stay in the visible view box and avoid room/object names.
  let calloutLayer = null;
  function clientBoxToLayout(r) {
    const m = svg.getScreenCTM?.();
    if (!m || !(r.width > 0) || !(r.height > 0)) return null;
    const inv = m.inverse();
    const a = new DOMPoint(r.left, r.top).matrixTransform(inv);
    const b = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }
  function softObstacles() {
    const out = [];
    const add = (node, weight) => {
      const b = node.isConnected ? clientBoxToLayout(node.getBoundingClientRect()) : null;
      if (b) out.push({ box: b, weight });
    };
    for (const n of svg.querySelectorAll('.layer-rooms .room-label, .layer-objects .object-label, .layer-labels text, .layer-walls .wall-label')) add(n, 1.5);
    for (const n of svg.querySelectorAll('.layer-objects .item:not(.hud-off) > g > rect')) add(n, 0.35);
    return out;
  }
  function renderCallouts() {
    // the editor shows plates too (for tiles too small for even a desk-sized name), but they never take input
    const want = !!layout;
    const interactive = mode === 'view' && !opts.kiosk;
    if (!want) {
      calloutLayer?.replaceChildren();
      calloutSig = null;
      return;
    }
    if (!calloutLayer || !calloutLayer.isConnected) {
      calloutLayer = el('g', { class: 'callouts', 'pointer-events': 'none' }, layers.machines);
      calloutSig = null;
    } else if (calloutLayer !== layers.machines.lastChild) layers.machines.append(calloutLayer);
    const s = opts.scale;
    const k = s.k || 1;
    // TV plates use the machine-name size; the editor's are desk-sized, so they do not crowd the plan being edited;
    // on a phone the plan is a few hundred pixels wide, so plates are small and carry the short name ("Robodrill")
    const phone = mode === 'view' && !!opts.compact;
    const sizes = phone ? PHONE_PLATE_SIZES : mode === 'view' ? [s.name, Math.max(s.floor, s.name * 0.8)] : [EDITOR_PLATE_SIZE, EDITOR_NAME_MIN];
    const maxW = phone ? 160 : 520 * k;
    const short = phone ? shortMachineNames([...tiles.values()].map((t) => t.name).filter(Boolean)) : null;
    const requests = [];
    const polys = [];
    for (const t of tiles.values()) {
      const m = t.machine;
      if (!validRect(m)) continue;
      const poly = tilePolygon({ x: m.x, y: m.y, w: m.w, h: m.h, rotation: finite(m.rotation) ? m.rotation : 0 });
      polys.push(poly);
      if (t.nameInTile || !t.name) continue;
      const label = short?.get(t.name) ?? t.name;
      const texts = sizes.map((size) => {
        const full = textWidth(label, 500) * size;
        return full <= maxW ? label : truncateToWidth(label, maxW, size, 500);
      });
      requests.push({
        id: m.id, poly, texts,
        sizes: sizes.map((size, i) => ({ w: (textWidth(texts[i], 500) * size + 0.7 * size) / ppu, h: (size * 1.3) / ppu })),
      });
    }
    // small tiles first: they have the fewest good spots
    requests.sort((a, b) => area(a.poly) - area(b.poly) || (a.id < b.id ? -1 : 1));
    const vb = getViewBox();
    const sig = JSON.stringify([calloutEpoch, r4(ppu), opts.theme, opts.kiosk, phone, mode, s.name, s.floor, k, requests.map((r) => [r.id, r.texts, r.poly.map((p) => p.map(r4))])]);
    if (sig === calloutSig) return;
    calloutSig = sig;
    const inset = (4 * k) / ppu;
    const placed = placeCallouts(requests, {
      tiles: polys,
      soft: softObstacles(),
      bounds: { minX: vb.x + inset, minY: vb.y + inset, maxX: vb.x + vb.w - inset, maxY: vb.y + vb.h - inset },
      margin: (phone ? 6 : (3 + 7 + 4 + 7 + 2) * k) / ppu,
      gap: (phone ? 3 : 6 * k) / ppu,
      prefer: planOutline(),
      prev: calloutPlaced,
    });
    calloutPlaced = placed;
    const T = themeColors(opts.theme);
    calloutLayer.replaceChildren();
    for (const req of requests) {
      const p = placed.get(req.id);
      if (!p) continue;
      const size = sizes[p.size];
      const text = req.texts[p.size];
      const g = el('g', { class: 'callout', 'data-callout-for': req.id, 'aria-hidden': 'true' }, calloutLayer);
      const { from, to } = p.leader;
      const lw = phone ? 1.25 : 2.5 * k;
      el('line', { x1: from[0], y1: from[1], x2: to[0], y2: to[1], stroke: T.neutralBorder, 'stroke-width': lw / ppu, 'stroke-linecap': 'round', class: 'callout-leader' }, g);
      el('circle', { cx: to[0], cy: to[1], r: (phone ? 2 : 4 * k) / ppu, fill: T.neutralBorder, class: 'callout-dot' }, g);
      const w = (p.box.maxX - p.box.minX) * ppu, h = (p.box.maxY - p.box.minY) * ppu;
      const plate = el('g', { transform: `translate(${r4(p.box.minX)} ${r4(p.box.minY)}) scale(${r4(1 / ppu)})` }, g);
      el('rect', { x: 0, y: 0, width: w, height: h, rx: h * 0.16, fill: T.bg, 'fill-opacity': 0.9, stroke: T.neutralBorder, 'stroke-width': phone ? 1 : 2 * k, class: 'callout-plate', 'pointer-events': interactive ? 'all' : null }, plate);
      textEl(plate, text, w / 2, h / 2, size, 500, T.text, 'middle', 'callout');
    }
  }
  /** The plan's outline for plates: the drawing, less half the exterior wall (a plate is not put over that wall). */
  function planOutline() {
    let edge = 0;
    for (const w of layout.walls ?? []) {
      if (w?.style !== 'exterior') continue;
      edge = Math.max(edge, (finite(w.thickness) && w.thickness > 0 ? w.thickness : WALL_THICKNESS.exterior) / 2);
    }
    edge = Math.min(edge, layout.width / 4, layout.height / 4);
    return { minX: edge, minY: edge, maxX: layout.width - edge, maxY: layout.height - edge };
  }
  function area(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  // ----- events ----------------------------------------------------------------------------------
  function onClick(ev) {
    if (mode !== 'view') return;
    const target = ev.target instanceof Element ? ev.target.closest('[data-kind="machine"], [data-callout-for]') : null;
    if (target && svg.contains(target)) handlers.onMachineClick?.(target.getAttribute('data-id') ?? target.getAttribute('data-callout-for'), ev);
    else handlers.onBackgroundClick?.(ev);
  }
  function onKey(ev) {
    if (mode !== 'view' || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    const target = ev.target instanceof Element ? ev.target.closest('[data-kind="machine"]') : null;
    if (target) { ev.preventDefault(); handlers.onMachineClick?.(target.getAttribute('data-id'), ev); }
  }
  svg.addEventListener('click', onClick);
  svg.addEventListener('keydown', onKey);

  const tick = setInterval(() => { if (!stale) renderMachines(); }, 1000);

  // ----- public API ------------------------------------------------------------------------------
  const api = {
    layers,
    /** Replace the layout (re-renders only changed items; keeps the view box unless the extents changed). */
    setLayout,
    /**
     * @param {Map<string, object>|Record<string, object>} snapshotsById  MachineSnapshot by layout machine id
     * @param {number} [offsetMs]  server-clock offset (server − client)
     * @param {() => number} [now]  client clock (default Date.now)
     */
    updateMachines(snapshotsById, offsetMs = serverOffsetMs, now = nowFn) {
      snapshots = snapshotsById instanceof Map ? new Map(snapshotsById) : new Map(Object.entries(snapshotsById ?? {}));
      serverOffsetMs = finite(offsetMs) ? offsetMs : 0;
      if (typeof now === 'function') nowFn = now;
      renderMachines();
    },
    /** 'view' (HUD: hud:false items hidden, machine clicks) or 'edit' (everything shown, editor handles input). */
    setMode(next) {
      const m = next === 'edit' ? 'edit' : 'view';
      if (m === mode) return;
      mode = m;
      svg.classList.toggle('mode-edit', mode === 'edit');
      svg.classList.toggle('mode-view', mode === 'view');
      if (layout) { renderStatic(); syncMachineGroups(); relayout(); }
    },
    getMode: () => mode,
    fit,
    getViewBox,
    setViewBox,
    /** Screen px per layout unit at the current zoom. */
    pxPerUnit: () => ppu,
    /** Client coordinates → layout units (accounts for the current view box). */
    toSvgPoint(clientX, clientY) {
      const m = svg.getScreenCTM();
      if (!m) return { x: NaN, y: NaN };
      const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    },
    /** Re-measure and redraw screen-px text (after a manual view box change or a font load). */
    relayout,
    /** Theme, settings, kiosk, type scale, grid, rotation (view only), region, motion. */
    setOptions(next = {}) {
      const before = JSON.stringify([opts.theme, opts.kiosk, opts.showGrid, opts.rotation, opts.region]);
      if ('compact' in next && !!next.compact !== !!opts.compact) calloutSig = null; // plates change size and text
      Object.assign(opts, next);
      const after = JSON.stringify([opts.theme, opts.kiosk, opts.showGrid, opts.rotation, opts.region]);
      if (rawLayout && before !== after) setLayout(rawLayout, { refit: true });
      else relayout();
    },
    getOptions: () => ({ ...opts }),
    /** Stale watchdog: grey + hatch all tiles, hide rings, freeze timers at `frozenServerNow`. */
    setStale(isStale, frozenServerNow = null) {
      stale = !!isStale;
      frozenNow = stale ? (finite(frozenServerNow) ? frozenServerNow : currentNow()) : null;
      svg.classList.toggle('stale', stale);
      for (const t of tiles.values()) t.sig = null;
      renderMachines();
    },
    setHandlers(next = {}) { handlers = { ...handlers, ...next }; },
    getLayout: () => rawLayout,
    /** The rendered (possibly rotated) layout. */
    getRenderedLayout: () => layout,
    itemElement: (id) => (tiles.get(id)?.g ?? itemCache.get(id)?.g ?? null),
    destroy() {
      destroyed = true;
      clearInterval(tick);
      ro?.disconnect();
      mo.disconnect();
      svg.removeEventListener('click', onClick);
      svg.removeEventListener('keydown', onKey);
      for (const g of Object.values(layers)) g.replaceChildren();
      for (const p of Object.values(patterns)) p.remove();
      doorMask.remove();
      tiles.clear();
      itemCache.clear();
    },
  };
  svg.classList.add('mode-view');
  return api;
}
