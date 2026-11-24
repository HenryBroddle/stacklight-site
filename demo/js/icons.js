// Status and UI icons drawn with createElementNS (never innerHTML). Every status glyph has a distinct
// silhouette so it reads without colour (docs/DECISIONS.md D2): octagon (E-STOP), triangle-! (ALARM),
// double bar (PAUSED), wrench (SETUP), hollow circle (IDLE), filled circle with play (RUNNING — never a bare
// triangle), plug with slash (no data), broken link (not linked).
// Geometry is defined on a 24 × 24 grid; strokes scale with the icon.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Regular octagon with a flat top, as a path. */
function octagonPath(cx, cy, r) {
  const pts = [];
  for (let k = 0; k < 8; k++) {
    const a = ((-112.5 + k * 45) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}
const circlePath = (cx, cy, r) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;

/**
 * Shape lists: f = filled path (evenodd, cut-outs show the tile colour), s = stroked path (width w),
 * c = stroked circle, sc = filled circle.
 * @type {Record<string, Array<{f?:string, s?:string, w?:number, c?:number[], sc?:number[]}>>}
 */
const ICONS = {
  // E-STOP: solid octagon with a bar cut out (stop-sign silhouette).
  octagon: [{ f: `${octagonPath(12, 12, 11.2)} M6.4 10.1 H17.6 V13.9 H6.4 Z` }],
  // ALARM: solid triangle with "!" cut out.
  triangle: [{ f: `M12 1.6 L23.2 21.6 H0.8 Z M10.75 8 H13.25 L12.85 14.9 H11.15 Z ${circlePath(12, 18.1, 1.45)}` }],
  // PAUSED: double bar.
  pause: [{ f: 'M5 3.5 h5 v17 h-5 Z M14 3.5 h5 v17 h-5 Z' }],
  // SETUP: open-end wrench.
  wrench: [{ s: 'M19.7 7.9 A3.9 3.9 0 1 1 16.1 4.3', w: 3.4 }, { s: 'M5.4 18.6 L13.2 10.8', w: 3.8 }],
  // IDLE: hollow circle.
  circle: [{ c: [12, 12, 8.3], w: 3.2 }],
  // RUNNING: solid circle with a play triangle cut out.
  play: [{ f: `${circlePath(12, 12, 11.2)} M9.3 6.7 L18 12 L9.3 17.3 Z` }],
  // OFFLINE / NO DATA: plug outline with a slash.
  unplugged: [
    { s: 'M7.5 9.3 h9 v4.6 a4.5 4.5 0 0 1 -9 0 Z', w: 2 },
    { f: 'M9 3.6 h2 v5 h-2 Z M13 3.6 h2 v5 h-2 Z' },
    { s: 'M12 18.4 V22', w: 2 },
    { s: 'M3 3 L21 21', w: 2.4 },
  ],
  // NOT LINKED: broken chain.
  'link-off': [
    { s: 'M10 8.6 H6.4 a3.4 3.4 0 0 0 0 6.8 H10', w: 2.3 },
    { s: 'M14 8.6 H17.6 a3.4 3.4 0 0 1 0 6.8 H14', w: 2.3 },
    { s: 'M12 2.8 V5.6 M12 18.4 V21.2 M7.6 4.2 L8.9 6.3 M16.4 19.8 L15.1 17.7', w: 1.8 },
  ],
  // OUT OF SERVICE: circle with a slash.
  ban: [{ c: [12, 12, 9], w: 2.8 }, { s: 'M5.7 5.7 L18.3 18.3', w: 2.8 }],
  // CONNECTING: three dots.
  dots: [{ sc: [5, 12, 2.3] }, { sc: [12, 12, 2.3] }, { sc: [19, 12, 2.3] }],
  // UI
  close: [{ s: 'M5.5 5.5 L18.5 18.5 M18.5 5.5 L5.5 18.5', w: 2.4 }],
  search: [{ c: [10.4, 10.4, 6.4], w: 2.4 }, { s: 'M15.2 15.2 L20.6 20.6', w: 2.8 }],
  pencil: [{ s: 'M4.2 19.8 L5.1 15.6 L15.8 4.9 L19.1 8.2 L8.4 18.9 Z M13.6 7.1 L16.9 10.4', w: 2 }],
  sun: [{ c: [12, 12, 4.2], w: 2.2 }, { s: 'M12 1.8 V4.4 M12 19.6 V22.2 M1.8 12 H4.4 M19.6 12 H22.2 M4.8 4.8 L6.6 6.6 M17.4 17.4 L19.2 19.2 M4.8 19.2 L6.6 17.4 M17.4 6.6 L19.2 4.8', w: 2 }],
  moon: [{ f: 'M20.4 14.6 A8.8 8.8 0 1 1 9.4 3.6 A7 7 0 0 0 20.4 14.6 Z' }],
  volume: [{ f: 'M3 9 h4 l5 -4.5 v15 l-5 -4.5 h-4 Z' }, { s: 'M15.5 8.5 a5 5 0 0 1 0 7 M18.3 5.7 a9 9 0 0 1 0 12.6', w: 2 }],
  'volume-off': [{ f: 'M3 9 h4 l5 -4.5 v15 l-5 -4.5 h-4 Z' }, { s: 'M15.5 9.2 L21 14.8 M21 9.2 L15.5 14.8', w: 2.2 }],
  info: [{ c: [12, 12, 9.6], w: 2.2 }, { f: 'M11 10.4 h2 v7 h-2 Z' }, { sc: [12, 7.4, 1.35] }],
  layers: [{ s: 'M12 3.5 L21 8.2 L12 12.9 L3 8.2 Z M3 12.4 L12 17.1 L21 12.4 M3 16.4 L12 21.1 L21 16.4', w: 1.9 }],
  refresh: [{ s: 'M19.5 12 a7.5 7.5 0 1 1 -2.2 -5.3', w: 2.3 }, { f: 'M14.6 3.9 L20.6 4 L19.9 9.9 Z' }],
  check: [{ s: 'M4.5 12.5 L9.8 17.8 L19.5 6.5', w: 2.6 }],
  key: [{ c: [8, 15.8, 4.4], w: 2.2 }, { s: 'M11.2 12.6 L20.4 3.4 M17.2 6.6 L19.6 9 M14.6 9.2 L16.6 11.2', w: 2.2 }],
  link: [{ s: 'M10.6 13.4 a3.6 3.6 0 0 0 5.1 0 l3.2 -3.2 a3.6 3.6 0 0 0 -5.1 -5.1 l-1.2 1.2 M13.4 10.6 a3.6 3.6 0 0 0 -5.1 0 l-3.2 3.2 a3.6 3.6 0 0 0 5.1 5.1 l1.2 -1.2', w: 2 }],
  // Run report: clipboard with rows.
  report: [{ s: 'M7.5 4.5 H5.5 V21 H18.5 V4.5 H16.5', w: 2 }, { s: 'M8.5 3 H15.5 V6.5 H8.5 Z', w: 1.9 }, { s: 'M8.5 11 H15.5 M8.5 14.5 H15.5 M8.5 18 H12.5', w: 2 }],
  download: [{ s: 'M12 3.5 V15 M7 10.5 L12 15.5 L17 10.5', w: 2.3 }, { s: 'M4.5 16.5 V20.5 H19.5 V16.5', w: 2.2 }],
  // program transfer (public/js/programsPanel.js, DECISIONS D16)
  upload: [{ s: 'M12 15.5 V4 M7 8.5 L12 3.5 L17 8.5', w: 2.3 }, { s: 'M4.5 16.5 V20.5 H19.5 V16.5', w: 2.2 }],
  trash: [{ s: 'M4 6.5 H20 M9.5 6.5 V4 H14.5 V6.5 M6.5 6.5 L7.5 20.5 H16.5 L17.5 6.5 M10 10.5 V16.5 M14 10.5 V16.5', w: 2 }],
  clock: [{ c: [12, 12, 9], w: 2.2 }, { s: 'M12 7 V12 L15.5 14', w: 2.2 }],
  lock: [{ s: 'M7.5 11 V7.5 A4.5 4.5 0 0 1 16.5 7.5 V11', w: 2.2 }, { f: 'M5 11 H19 V21 H5 Z' }],
  file: [{ s: 'M14 3 H6.5 V21 H17.5 V6.5 Z M14 3 V6.5 H17.5', w: 2 }],
  folder: [{ s: 'M3 6.5 V18.5 H21 V8.5 H11.5 L9.5 6 H3 Z', w: 2 }],
  'folder-plus': [{ s: 'M3 6.5 V18.5 H21 V8.5 H11.5 L9.5 6 H3 Z', w: 2 }, { s: 'M12 11 V16.5 M9.25 13.75 H14.75', w: 2 }],
  up: [{ s: 'M12 19.5 V5 M6 11 L12 5 L18 11', w: 2.3 }],
  sliders: [{ s: 'M4 7 H20 M4 17 H20', w: 2 }, { sc: [9, 7, 2.6] }, { sc: [15, 17, 2.6] }],
  // Text size: a large and a small A.
  'text-size': [{ s: 'M2.5 20 L8.5 4 L14.5 20 M4.8 14.2 H12.2', w: 2.2 }, { s: 'M14.5 20 L18 11.2 L21.5 20 M15.7 17 H20.3', w: 1.9 }],
  // Maintenance (public/js/maintenancePanel.js, DECISIONS D18): an oil can with a drop (the wrench is SETUP). The task
  // pills use the glyphs below, none of them a status silhouette: flag (due), clock (due soon), hourglass (needs a
  // start), gauge (not counting), check (OK), bell (on alarm), info (as needed), switch (off).
  oilcan: [
    { f: 'M2.8 11.6 H12.6 L16.2 14.6 V19.4 H2.8 Z' },
    { f: 'M6 8.6 H9.8 V11.6 H6 Z' },
    { s: 'M15.6 15 L21.2 10.2', w: 2.2 },
    { f: 'M21 12.6 C21.9 13.8 22.5 14.7 22.5 15.4 A1.5 1.5 0 0 1 19.5 15.4 C19.5 14.7 20.1 13.8 21 12.6 Z' },
  ],
  flag: [{ s: 'M5 21.5 V3', w: 2.2 }, { f: 'M6.1 3.8 H19.2 L15.8 8.4 L19.2 13 H6.1 Z' }],
  bell: [{ s: 'M6.2 16.8 V11 A5.8 5.8 0 0 1 17.8 11 V16.8 L19.4 18.6 H4.6 Z', w: 2 }, { s: 'M10 21 A2 2 0 0 0 14 21 M12 3 V5.2', w: 2 }],
  hourglass: [{ s: 'M6 3.5 H18 M6 20.5 H18', w: 2.2 }, { s: 'M7.6 3.5 V6.6 L12 12 L16.4 6.6 V3.5 M7.6 20.5 V17.4 L12 12 L16.4 17.4 V20.5', w: 1.9 }, { f: 'M9.3 19.3 L12 16.1 L14.7 19.3 Z' }],
  gauge: [{ s: 'M4.2 17.5 A8.6 8.6 0 1 1 19.8 17.5', w: 2.2 }, { s: 'M12 13.9 L16.2 9.2', w: 2.2 }, { sc: [12, 13.9, 1.9] }],
  'toggle-off': [{ s: 'M8 7 H16 A5 5 0 0 1 16 17 H8 A5 5 0 0 1 8 7 Z', w: 2 }, { sc: [8.3, 12, 2.6] }],
  external: [{ s: 'M13.5 4.5 H19.5 V10.5 M19.5 4.5 L11.5 12.5', w: 2.1 }, { s: 'M17.5 13.5 V19.5 H4.5 V6.5 H10.5', w: 2.1 }],
  plus: [{ s: 'M12 5 V19 M5 12 H19', w: 2.4 }],
  chevron: [{ s: 'M9 5.5 L15.5 12 L9 18.5', w: 2.4 }],
};

/** All icon names. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

function shapeElements(name, color) {
  const shapes = ICONS[name] ?? ICONS.dots;
  const out = [];
  for (const sh of shapes) {
    let el;
    if (sh.f) {
      el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', sh.f);
      el.setAttribute('fill', color);
      el.setAttribute('fill-rule', 'evenodd');
    } else if (sh.s) {
      el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', sh.s);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', color);
      el.setAttribute('stroke-width', String(sh.w ?? 2));
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
    } else if (sh.c) {
      el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', String(sh.c[0]));
      el.setAttribute('cy', String(sh.c[1]));
      el.setAttribute('r', String(sh.c[2]));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', color);
      el.setAttribute('stroke-width', String(sh.w ?? 2));
    } else if (sh.sc) {
      el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', String(sh.sc[0]));
      el.setAttribute('cy', String(sh.sc[1]));
      el.setAttribute('r', String(sh.sc[2]));
      el.setAttribute('fill', color);
    }
    if (el) out.push(el);
  }
  return out;
}

/**
 * Standalone inline <svg> for HTML (board, chips, buttons).
 * @param {string} name
 * @param {{ size?: number|string, color?: string, className?: string, title?: string }} [opts]
 * @returns {SVGSVGElement}
 */
export function iconSvg(name, { size = 24, color = 'currentColor', className = '', title } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (size !== null) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  svg.setAttribute('class', `icon icon-${name}${className ? ` ${className}` : ''}`);
  svg.setAttribute('focusable', 'false');
  if (title) {
    svg.setAttribute('role', 'img');
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = title;
    svg.append(t);
  } else svg.setAttribute('aria-hidden', 'true');
  svg.append(...shapeElements(name, color));
  return svg;
}

/**
 * Icon as a <g> for use inside another SVG, top-left at (x, y), `size` user units square.
 * @param {string} name
 * @param {{ size?: number, color?: string, x?: number, y?: number }} [opts]
 * @returns {SVGGElement}
 */
export function iconGroup(name, { size = 24, color = 'currentColor', x = 0, y = 0 } = {}) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', `icon icon-${name}`);
  g.setAttribute('transform', `translate(${round(x)} ${round(y)}) scale(${round(size / 24, 5)})`);
  g.append(...shapeElements(name, color));
  return g;
}

const round = (v, d = 3) => Number(v.toFixed(d));
