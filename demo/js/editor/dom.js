// Small DOM helpers and the editor's icon set. Every string goes in with textContent (never innerHTML).
// Icons follow public/js/icons.js: shapes on a 24 × 24 grid drawn with createElementNS.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element. `props` may hold className, text, title, type, attrs {…}, dataset {…}, style {…},
 * on {event: fn}, and any other DOM property (value, checked, disabled, hidden, htmlFor, …).
 * @param {string} tag
 * @param {object} [props]
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null) continue;
    if (k === 'className') e.className = v;
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av !== undefined && av !== null && av !== false) e.setAttribute(a, av === true ? '' : String(av)); }
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style') Object.assign(e.style, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else e[k] = v;
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

/** SVG element with attributes (numbers rounded to 3 decimals). */
export function s(name, attrs = {}, parent = null) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    e.setAttribute(k, typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));
  }
  if (parent) parent.append(e);
  return e;
}

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

/** f = filled path, s = stroked path (w = width), c = stroked circle [cx, cy, r], sc = filled circle, r = stroked rect [x,y,w,h,rx]. */
const ICONS = {
  select: [{ f: 'M5 2.8 L18.6 13.4 L12.4 14.2 L15.9 21 L13.1 22.3 L9.7 15.5 L5 19.6 Z' }],
  hand: [{ s: 'M8 12.5 V5.2 a1.6 1.6 0 0 1 3.2 0 V11 M11.2 10.6 V3.8 a1.6 1.6 0 0 1 3.2 0 V11 M14.4 10.8 V5.4 a1.6 1.6 0 0 1 3.2 0 V14 c0 4.2 -2.6 7 -6.3 7 c-2.6 0 -4.1 -1.3 -5.5 -3.4 L3.6 13.8 a1.6 1.6 0 0 1 2.6 -1.8 L8 14', w: 1.7 }],
  wall: [{ s: 'M3 20 V8 H13 V4 H21', w: 3.2 }, { sc: [3, 20, 1.9] }, { sc: [21, 4, 1.9] }],
  room: [{ r: [3.5, 4.5, 17, 15, 1.2], w: 1.8 }, { f: 'M3.5 4.5 h17 v4 h-17 Z', o: 0.35 }, { s: 'M7.5 13.2 h9 M7.5 16 h5', w: 1.6 }],
  door: [{ s: 'M3 20.5 H21', w: 1.8 }, { s: 'M5 20.5 V6.5', w: 2.2 }, { s: 'M5 6.5 A14 14 0 0 1 19 20.5', w: 1.6, dash: '2.4 2' }],
  label: [{ s: 'M5 5.5 H19 M12 5.5 V20', w: 2.6 }, { s: 'M9 20 H15', w: 1.8 }],
  object: [{ r: [3.5, 6.5, 17, 11, 1.5], w: 1.9 }, { s: 'M3.5 10.5 H20.5', w: 1.4 }],
  machine: [{ r: [3, 5, 18, 14, 2], w: 1.9 }, { sc: [9, 12, 2.6] }, { s: 'M14 9.5 h4 M14 12 h4 M14 14.5 h2.5', w: 1.6 }],
  photo: [{ r: [3, 5, 18, 14, 1.6], w: 1.9 }, { sc: [8.5, 9.8, 1.7] }, { s: 'M3.6 17.5 L9.5 12.6 L13 15.6 L16 13 L20.4 17', w: 1.8 }],
  undo: [{ s: 'M9 14.5 L4 9.5 L9 4.5', w: 2.2 }, { s: 'M4.5 9.5 H14 a5.5 5.5 0 0 1 0 11 H9', w: 2.2 }],
  redo: [{ s: 'M15 14.5 L20 9.5 L15 4.5', w: 2.2 }, { s: 'M19.5 9.5 H10 a5.5 5.5 0 0 0 0 11 H15', w: 2.2 }],
  duplicate: [{ r: [8.5, 8.5, 12, 12, 2], w: 1.9 }, { s: 'M15.5 5 V5.2 a1.7 1.7 0 0 0 -1.7 -1.7 H5.2 A1.7 1.7 0 0 0 3.5 5.2 V13.8 a1.7 1.7 0 0 0 1.7 1.7 H5.5', w: 1.9 }],
  trash: [{ s: 'M4 6.5 H20 M9.5 6.5 V4 H14.5 V6.5 M6.2 6.5 L7.2 20.5 H16.8 L17.8 6.5 M10 10 V17 M14 10 V17', w: 1.8 }],
  rotate: [{ s: 'M19.5 12 a7.5 7.5 0 1 1 -2.2 -5.3', w: 2.1 }, { f: 'M14.6 3.9 L20.6 4 L19.9 9.9 Z' }],
  grid: [{ s: 'M3.5 3.5 H20.5 V20.5 H3.5 Z M9.2 3.5 V20.5 M14.8 3.5 V20.5 M3.5 9.2 H20.5 M3.5 14.8 H20.5', w: 1.5 }],
  magnet: [{ s: 'M6 4 V12 a6 6 0 0 0 12 0 V4', w: 3.2 }, { s: 'M3.6 6.6 H8.4 M15.6 6.6 H20.4', w: 1.6 }],
  fit: [{ s: 'M3.5 8.5 V3.5 H8.5 M15.5 3.5 H20.5 V8.5 M20.5 15.5 V20.5 H15.5 M8.5 20.5 H3.5 V15.5', w: 2 }, { r: [8, 8, 8, 8, 1], w: 1.6 }],
  plus: [{ s: 'M12 5 V19 M5 12 H19', w: 2.2 }],
  minus: [{ s: 'M5 12 H19', w: 2.2 }],
  eye: [{ s: 'M2.5 12 C5 7.2 8.4 5 12 5 s7 2.2 9.5 7 C19 16.8 15.6 19 12 19 S5 16.8 2.5 12 Z', w: 1.8 }, { c: [12, 12, 3.2], w: 1.8 }],
  'eye-off': [{ s: 'M2.5 12 C5 7.2 8.4 5 12 5 s7 2.2 9.5 7 C19 16.8 15.6 19 12 19 S5 16.8 2.5 12 Z', w: 1.8, o: 0.55 }, { s: 'M4 4 L20 20', w: 2 }],
  lock: [{ r: [5, 10.5, 14, 10, 1.6], w: 1.9 }, { s: 'M8.2 10.5 V7.6 a3.8 3.8 0 0 1 7.6 0 V10.5', w: 1.9 }],
  unlock: [{ r: [5, 10.5, 14, 10, 1.6], w: 1.9 }, { s: 'M8.2 10.5 V7.6 a3.8 3.8 0 0 1 7.3 -1.5', w: 1.9 }],
  link: [{ s: 'M10.6 13.4 a3.6 3.6 0 0 0 5.1 0 l3.2 -3.2 a3.6 3.6 0 0 0 -5.1 -5.1 l-1.2 1.2 M13.4 10.6 a3.6 3.6 0 0 0 -5.1 0 l-3.2 3.2 a3.6 3.6 0 0 0 5.1 5.1 l1.2 -1.2', w: 2 }],
  upload: [{ s: 'M12 15.5 V4 M7.5 8.5 L12 4 L16.5 8.5 M4 15 V19.5 H20 V15', w: 2 }],
  save: [{ s: 'M4 4 H16.5 L20 7.5 V20 H4 Z M8 4 V9 H15 V4 M7.5 20 V14 H16.5 V20', w: 1.8 }],
  tv: [{ r: [2.5, 4, 19, 13, 1.6], w: 1.9 }, { s: 'M8 21 H16 M12 17 V21', w: 1.9 }],
  broadcast: [{ sc: [12, 12, 2.4] }, { s: 'M8.2 15.8 a5.4 5.4 0 0 1 0 -7.6 M15.8 8.2 a5.4 5.4 0 0 1 0 7.6 M5.3 18.7 a9.5 9.5 0 0 1 0 -13.4 M18.7 5.3 a9.5 9.5 0 0 1 0 13.4', w: 1.8 }],
  done: [{ s: 'M4.5 12.5 L9.8 17.8 L19.5 6.5', w: 2.4 }],
  help: [{ c: [12, 12, 9.4], w: 1.9 }, { s: 'M9.4 9.4 a2.7 2.7 0 1 1 3.7 2.5 c-0.8 0.3 -1.1 0.9 -1.1 1.7 V14.6', w: 1.9 }, { sc: [12, 17.4, 1.2] }],
  warning: [{ f: 'M12 2.5 L22.5 20.5 H1.5 Z M11 9 H13 L12.7 14.8 H11.3 Z M12 16.2 a1.25 1.25 0 1 1 0 2.5 a1.25 1.25 0 1 1 0 -2.5 Z' }],
  clock: [{ c: [12, 12, 9.2], w: 1.9 }, { s: 'M12 7 V12 L15.4 14', w: 1.9 }],
  chevron: [{ s: 'M9 6 L15 12 L9 18', w: 2.2 }],
  'chevron-down': [{ s: 'M6 9 L12 15 L18 9', w: 2.2 }],
  'align-left': [{ s: 'M4 3.5 V20.5', w: 2 }, { r: [7, 6, 12, 4, 1], w: 1.6 }, { r: [7, 14, 7, 4, 1], w: 1.6 }],
  'align-hcenter': [{ s: 'M12 3.5 V20.5', w: 2 }, { r: [5, 6, 14, 4, 1], w: 1.6 }, { r: [8, 14, 8, 4, 1], w: 1.6 }],
  'align-right': [{ s: 'M20 3.5 V20.5', w: 2 }, { r: [5, 6, 12, 4, 1], w: 1.6 }, { r: [10, 14, 7, 4, 1], w: 1.6 }],
  'align-top': [{ s: 'M3.5 4 H20.5', w: 2 }, { r: [6, 7, 4, 12, 1], w: 1.6 }, { r: [14, 7, 4, 7, 1], w: 1.6 }],
  'align-vcenter': [{ s: 'M3.5 12 H20.5', w: 2 }, { r: [6, 5, 4, 14, 1], w: 1.6 }, { r: [14, 8, 4, 8, 1], w: 1.6 }],
  'align-bottom': [{ s: 'M3.5 20 H20.5', w: 2 }, { r: [6, 5, 4, 12, 1], w: 1.6 }, { r: [14, 10, 4, 7, 1], w: 1.6 }],
  'dist-h': [{ s: 'M3.5 4 V20 M20.5 4 V20', w: 1.8 }, { r: [9.5, 7, 5, 10, 1], w: 1.6 }],
  'dist-v': [{ s: 'M4 3.5 H20 M4 20.5 H20', w: 1.8 }, { r: [7, 9.5, 10, 5, 1], w: 1.6 }],
  flip: [{ s: 'M12 3 V21', w: 1.6, dash: '2 2' }, { s: 'M9 7 L4 12 L9 17 Z M15 7 L20 12 L15 17 Z', w: 1.7 }],
  convert: [{ s: 'M4 8.5 H18 L14.5 5 M20 15.5 H6 L9.5 19', w: 2 }],
  search: [{ c: [10.4, 10.4, 6.4], w: 2.2 }, { s: 'M15.2 15.2 L20.6 20.6', w: 2.6 }],
  close: [{ s: 'M6 6 L18 18 M18 6 L6 18', w: 2.2 }],
  key: [{ c: [8, 15.8, 4.4], w: 2.1 }, { s: 'M11.2 12.6 L20.4 3.4 M17.2 6.6 L19.6 9 M14.6 9.2 L16.6 11.2', w: 2.1 }],
  layers: [{ s: 'M12 3.5 L21 8.2 L12 12.9 L3 8.2 Z M3 12.4 L12 17.1 L21 12.4 M3 16.4 L12 21.1 L21 16.4', w: 1.8 }],
  sliders: [{ s: 'M4 7 H20 M4 17 H20', w: 1.8 }, { c: [9, 7, 2.4], w: 1.8 }, { c: [15, 17, 2.4], w: 1.8 }],
  plug: [{ s: 'M7.5 9.3 h9 v4.6 a4.5 4.5 0 0 1 -9 0 Z', w: 1.9 }, { f: 'M9 3.6 h2 v5 h-2 Z M13 3.6 h2 v5 h-2 Z' }, { s: 'M12 18.4 V22', w: 1.9 }],
  pin: [{ s: 'M12 21.5 C7 15.8 5 12.4 5 9.5 a7 7 0 0 1 14 0 c0 2.9 -2 6.3 -7 12 Z', w: 1.9 }, { c: [12, 9.5, 2.4], w: 1.8 }],
  ruler: [{ s: 'M3.5 15.5 L15.5 3.5 L20.5 8.5 L8.5 20.5 Z M7.5 11.5 L9.5 13.5 M10.5 8.5 L12.5 10.5 M13.5 5.5 L15.5 7.5', w: 1.7 }],
  corners: [{ s: 'M4.5 6 L19 4 L20 19.5 L5.5 18 Z', w: 1.6, dash: '2.5 2' }, { sc: [4.5, 6, 2] }, { sc: [19, 4, 2] }, { sc: [20, 19.5, 2] }, { sc: [5.5, 18, 2] }],
  move: [{ s: 'M12 3 V21 M3 12 H21 M12 3 L9.5 5.5 M12 3 L14.5 5.5 M12 21 L9.5 18.5 M12 21 L14.5 18.5 M3 12 L5.5 9.5 M3 12 L5.5 14.5 M21 12 L18.5 9.5 M21 12 L18.5 14.5', w: 1.8 }],
  refresh: [{ s: 'M19.5 12 a7.5 7.5 0 1 1 -2.2 -5.3', w: 2.1 }, { f: 'M14.6 3.9 L20.6 4 L19.9 9.9 Z' }],
  check: [{ s: 'M4.5 12.5 L9.8 17.8 L19.5 6.5', w: 2.6 }],
  dot: [{ sc: [12, 12, 4] }],
  external: [{ s: 'M13.5 4 H20 V10.5 M20 4 L11 13 M17 14 V20 H4 V7 H10', w: 1.9 }],
};

/**
 * Inline <svg> icon for editor chrome.
 * @param {string} name
 * @param {{ size?: number|null, className?: string, title?: string }} [o]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = null, className = '', title } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (size) { svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size)); }
  svg.setAttribute('class', `ed-icon icon-${name}${className ? ` ${className}` : ''}`);
  svg.setAttribute('focusable', 'false');
  if (title) {
    svg.setAttribute('role', 'img');
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = title;
    svg.append(t);
  } else svg.setAttribute('aria-hidden', 'true');
  for (const sh of ICONS[name] ?? ICONS.dot) {
    let el;
    if (sh.f) el = s('path', { d: sh.f, fill: 'currentColor', 'fill-rule': 'evenodd', opacity: sh.o });
    else if (sh.s) el = s('path', { d: sh.s, fill: 'none', stroke: 'currentColor', 'stroke-width': sh.w ?? 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': sh.dash, opacity: sh.o });
    else if (sh.c) el = s('circle', { cx: sh.c[0], cy: sh.c[1], r: sh.c[2], fill: 'none', stroke: 'currentColor', 'stroke-width': sh.w ?? 2 });
    else if (sh.sc) el = s('circle', { cx: sh.sc[0], cy: sh.sc[1], r: sh.sc[2], fill: 'currentColor' });
    else if (sh.r) el = s('rect', { x: sh.r[0], y: sh.r[1], width: sh.r[2], height: sh.r[3], rx: sh.r[4] ?? 0, fill: 'none', stroke: 'currentColor', 'stroke-width': sh.w ?? 2 });
    if (el) svg.append(el);
  }
  return svg;
}

/**
 * Labelled button (icon + text). `kbd` adds the shortcut to the tooltip.
 * @param {{ icon?: string, label: string, title?: string, kbd?: string, className?: string, onClick?: Function, hideLabel?: boolean }} o
 */
export function button({ icon: ic, label, title, kbd, className = '', onClick, hideLabel = false }) {
  const b = h('button', { type: 'button', className: `ed-btn ${className}`.trim() });
  if (ic) b.append(icon(ic));
  const span = h('span', { className: hideLabel ? 'ed-sr' : 'ed-btn-label', text: label });
  b.append(span);
  const tip = title ?? label;
  b.title = kbd ? `${tip} (${kbd})` : tip;
  if (hideLabel) b.setAttribute('aria-label', label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Keyboard shortcut label for the current platform: "Ctrl+Z" or "⌘Z". */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';
export const kbd = (combo) => combo.replace('Mod+', MOD).replace('Shift+', IS_MAC ? '⇧' : 'Shift+').replace('Alt+', IS_MAC ? '⌥' : 'Alt+');

/** "4 s ago", "3 min ago", "2 h ago". */
export function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

/** Local time "3:42 PM" (or "Fri 3:42 PM" / "Nov 3, 3:42 PM" when not today). */
export function when(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(now - ms) < 6 * 86_400_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Storage that never throws (private mode, blocked site data). */
export const store = {
  get(key) { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ } },
  getJson(key) { const v = this.get(key); if (!v) return null; try { return JSON.parse(v); } catch { return null; } },
};
