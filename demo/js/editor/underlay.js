// Under the floor-plan SVG (same grid cell, lower z-index): the trace photo and the drawing grid.
// The photo is an <img> warped with a CSS matrix3d() onto background.corners (DECISIONS D5 4-corner fit) or onto
// its rotated x/y/width/height rectangle; the grid is two CSS gradients aligned to the layout origin. Both are
// recomputed from the SVG's screen matrix whenever the view or the document changes.
import { h } from './dom.js';
import { cssMatrix3d } from './geometry.js';

const ASSET_RE = /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/i;

/**
 * @param {object} ed  editor core
 * @param {HTMLElement} cell  element the underlay is placed in (the plan section)
 */
export function createUnderlay(ed, cell) {
  const el = h('div', { className: 'ed-underlay', attrs: { 'aria-hidden': 'true' } });
  const img = h('img', { className: 'ed-trace', alt: '', decoding: 'async', draggable: false });
  const grid = h('div', { className: 'ed-grid' });
  el.append(img, grid);
  cell.append(el);
  let src = null;
  let loaded = false;
  img.addEventListener('load', () => { loaded = true; ed.invalidate('underlay'); ed.emit('photo-loaded', { width: img.naturalWidth, height: img.naturalHeight }); });
  img.addEventListener('error', () => { loaded = false; img.hidden = true; ed.emit('photo-error', src); });

  function render() {
    const doc = ed.doc;
    const m = ed.svg.getScreenCTM?.();
    const box = el.getBoundingClientRect();
    if (!m || box.width === 0 || ed.previewing) { img.hidden = true; grid.hidden = true; return; }
    const toBox = (x, y) => [m.a * x + m.c * y + m.e - box.left, m.b * x + m.d * y + m.f - box.top];
    const k = Math.hypot(m.a, m.b);

    // grid over the drawing area
    if (ed.opts.grid && Number.isFinite(doc.width) && Number.isFinite(doc.height)) {
      const [x0, y0] = toBox(0, 0);
      const [x1, y1] = toBox(doc.width, doc.height);
      // minor lines every grid step (×2, ×5, ×10 … while they would be closer than 7 px); major lines every 10 units
      const g = ed.grid();
      let minor = g;
      for (const mult of [1, 2, 5, 10, 20, 50, 100, 200]) { minor = g * mult; if (minor * k >= 7) break; }
      let major = 10;
      while (major * k < 48) major *= 5;
      const ratio = major / minor;
      if (major <= minor || Math.abs(ratio - Math.round(ratio)) > 1e-6) major = minor * 5;
      Object.assign(grid.style, {
        left: `${x0}px`, top: `${y0}px`, width: `${Math.max(0, x1 - x0)}px`, height: `${Math.max(0, y1 - y0)}px`,
        backgroundSize: `${major * k}px ${major * k}px, ${major * k}px ${major * k}px, ${minor * k}px ${minor * k}px, ${minor * k}px ${minor * k}px`,
      });
      grid.hidden = false;
    } else grid.hidden = true;

    // trace photo
    const b = doc.background;
    const want = b && typeof b.src === 'string' && ASSET_RE.test(b.src) && !b.src.includes('..') ? `/layouts/${b.src}` : null;
    if (want !== src) {
      src = want;
      loaded = false;
      if (want) img.src = want; else img.removeAttribute('src');
    }
    const corners = want ? ed.photoCorners?.() : null;
    if (!want || !loaded || !corners || b.visible !== true || ed.layerHidden('background')) { img.hidden = true; return; }
    const w = img.naturalWidth, hgt = img.naturalHeight;
    const css = cssMatrix3d(w, hgt, corners.map(([x, y]) => toBox(x, y)));
    if (!css) { img.hidden = true; return; }
    img.style.width = `${w}px`;
    img.style.height = `${hgt}px`;
    img.style.transform = css;
    img.style.opacity = String(Number.isFinite(b.opacity) ? Math.min(1, Math.max(0, b.opacity)) : 0.35);
    img.hidden = false;
  }

  return {
    render,
    element: el,
    get photoSize() { return loaded ? { width: img.naturalWidth, height: img.naturalHeight } : null; },
    destroy() { el.remove(); },
  };
}
