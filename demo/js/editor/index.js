// Layout editor ("trace and link", docs/DECISIONS.md D5). Loaded lazily by public/js/app.js when someone clicks
// "Edit layout" or opens /?edit=1: mountEditor(ctx) builds the editor around the shared floor-plan SVG and returns
// { destroy }. ctx = { floorplan, api, svg, host, planHost, layoutId, layout, getState, getSnapshots, serverNow,
// subscribe, setLayout, requestToken, toast, exit }.
//
// Modules: canvas.js (pointer gestures + overlay), underlay.js (trace photo + grid), properties.js, devices.js,
// layers.js, versions.js (side panel), dialogs.js, photo.js; pure logic in geometry/items/ops/snap/history/units/
// checklist.js (unit-tested in test/unit/editor-*.test.js).
import { validateLayout, emptyLayout } from '/shared/layout.js';
import { LAYOUT_ID_RE } from '/shared/contracts.js';
import { h, icon, kbd, store, when } from './dom.js';
import { UndoStack } from './history.js';
import { createCanvas } from './canvas.js';
import { createUnderlay } from './underlay.js';
import { createProperties, uploadPhoto } from './properties.js';
import { createDevices, openLinkDialog } from './devices.js';
import { createLayers } from './layers.js';
import { createVersions } from './versions.js';
import { openDialog, confirmDialog, promptDialog, tokenDialog, conflictDialog, shortcutsDialog } from './dialogs.js';
import { isWindowsKit } from '../tokenHelp.js';
import {
  findItem, removeItems, moveItems, rotateItems, duplicateItems, copyItems, pasteItems, parseClipboard, alignItems,
  distributeItems, setLocked, updateItem, deleteVertex, sameDoc, describeItems, minPoints,
} from './ops.js';
import { COLLECTIONS, itemBounds } from './items.js';
import { bboxUnion } from './geometry.js';
import { nudgeStep } from './units.js';

const LAYER_KEY = 'machine-shop-hud.editor.layers';
const PREFS_KEY = 'machine-shop-hud.editor.prefs';
const DRAFT_PREFIX = 'machine-shop-hud.editor.draft.';
const TOOLS = [
  ['select', 'Select', 'select', 'V'], ['pan', 'Pan', 'hand', 'H'], ['wall', 'Wall', 'wall', 'W'], ['room', 'Room', 'room', 'R'],
  ['door', 'Door', 'door', 'D'], ['label', 'Label', 'label', 'T'], ['object', 'Object', 'object', 'O'], ['machine', 'Machine', 'machine', 'M'],
  ['photo', 'Photo', 'photo', 'P'],
];
const TOOL_KEYS = Object.fromEntries(TOOLS.map(([id, , , k]) => [k.toLowerCase(), id]));
const HINTS = {
  select: 'Click to select · Shift-click adds · drag empty space to box-select (right-to-left touches) · Alt-drag copies',
  selectSome: 'Drag to move · arrows nudge (Shift ×10, Alt 0.1 ft) · [ ] rotate · Delete removes · Alt: no snapping',
  pan: 'Drag to pan · wheel or pinch to zoom',
  wall: 'Click to start a wall · it snaps to corners, walls and the grid (hold Alt for none)',
  wallDrawing: 'Click to add a corner · Enter or double-click finishes · click the first point to close · Shift: 0/45/90° · Backspace removes a point · Esc cancels',
  room: 'Drag a rectangle, or click corner points for any shape',
  roomDrawing: 'Click to add a corner · Enter or double-click finishes · Backspace removes a point · Esc cancels',
  door: 'Click on a wall to add a door — it lines up with the wall · F flips the swing',
  label: 'Click where the label should go',
  object: 'Drag to draw a bench, rack or other object — or click for a 4 × 2 ft one',
  machine: 'Drag to draw a machine footprint — or click for an 8 × 6 ft one',
  photo: 'Fit the trace photo: drag it, its corners or the round knob — or use 4 corners / 2 points in the panel',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTyping = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !(el.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'button'].includes(el.type));

function loadCss() {
  if (document.querySelector('link[data-editor-css]')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: 'css/editor.css' });
    link.dataset.editorCss = '1';
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    document.head.append(link);
    setTimeout(resolve, 3000);
  });
}

/**
 * Mount the editor. Resolves to { destroy() } once the layout is loaded.
 * @param {object} ctx  editor context from public/js/app.js
 */
export async function mountEditor(ctx) {
  await loadCss();
  const { api, svg, host, planHost } = ctx;
  const fp = ctx.floorplan;
  const root = document.documentElement;
  const cleanups = [];
  const listen = (target, ev, fn, o) => { target.addEventListener(ev, fn, o); cleanups.push(() => target.removeEventListener(ev, fn, o)); };

  // ---------------------------------------------------------------------------------------------
  // Core state
  // ---------------------------------------------------------------------------------------------
  const listeners = new Map();
  const prefs = { snap: true, grid: true, tab: 'properties', ...(store.getJson(PREFS_KEY) ?? {}) };
  const layerState = store.getJson(LAYER_KEY) ?? {};

  /** The editor core shared by every module. */
  const ed = {
    ctx, api, fp, svg,
    layoutId: ctx.layoutId,
    doc: null,
    selection: [],
    tool: 'select',
    opts: { snap: prefs.snap !== false, grid: prefs.grid !== false },
    history: new UndoStack({ limit: 500 }),
    previewing: false,
    dirty: false,
    everSaved: true,
    problems: [],
    vertexSel: null,
    linkHover: null,
    photoMode: 'move',
    calibration: [],
    lastWallStyle: null,
    lastDoorWidth: 3,
    canvas: null,
    devices: null,
    units: () => (ed.doc?.units === 'm' ? 'm' : 'ft'),
    grid: () => (Number.isFinite(ed.doc?.grid) && ed.doc.grid > 0 ? ed.doc.grid : 1),
    theme: () => (root.dataset.theme === 'light' ? 'light' : 'dark'),
    serverNow: () => (typeof ctx.serverNow === 'function' ? ctx.serverNow() : Date.now()),
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    emit(name, data) {
      for (const fn of listeners.get(name) ?? []) { try { fn(data); } catch (e) { console.error(e); } }
    },
    toast: (msg, o) => ctx.toast?.(msg, o),
    measure: null,
  };

  // ---------------------------------------------------------------------------------------------
  // Load the layout (fresh from the server, for its ETag)
  // ---------------------------------------------------------------------------------------------
  let etag = null;
  let savedCanonical = null;
  let savedLayout = null;
  async function fetchLayout(id) {
    const layout = await api.layouts.get(id);
    if (!isObj(layout)) throw new Error('empty layout');
    return { layout, etag: api.layouts.etag(id) };
  }
  if (!ed.layoutId) {
    const activeId = ctx.getState?.().activeLayout ?? ctx.getState?.().settings?.activeLayout;
    ed.layoutId = typeof activeId === 'string' && LAYOUT_ID_RE.test(activeId) ? activeId : 'main-shop';
  }
  try {
    const r = await fetchLayout(ed.layoutId);
    ed.doc = r.layout;
    etag = r.etag;
  } catch (e) {
    if (e?.status !== 404 && isObj(ctx.layout)) {
      ed.doc = structuredClone(ctx.layout);
      ctx.toast?.(`Could not reload the layout (${e.message}); editing the copy on screen`, { kind: 'error' });
    } else {
      // no layout on the server yet: start a new one with this id (created on first save)
      ed.doc = emptyLayout({ id: ed.layoutId, name: 'Main Shop', width: 80, height: 60 });
      ed.everSaved = false;
    }
  }
  savedLayout = ed.everSaved ? ed.doc : null;
  savedCanonical = ed.everSaved ? canonical(ed.doc) : null;

  function canonical(doc) {
    const v = validateLayout(doc, { expectedId: ed.layoutId });
    return v.ok ? JSON.stringify(v.layout) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // DOM: action bar, tool rail, status bar (plan section) and the side panel (editor host)
  // ---------------------------------------------------------------------------------------------
  root.classList.add('ed-active');
  planHost.classList.add('ed-plan');
  const actionbar = h('div', { className: 'ed-actionbar', attrs: { role: 'toolbar', 'aria-label': 'Layout editor' } });
  const rail = h('nav', { className: 'ed-rail', attrs: { 'aria-label': 'Drawing tools' } });
  const statusbar = h('div', { className: 'ed-statusbar' });
  const previewBar = h('div', { className: 'ed-preview-bar', hidden: true });
  const busy = h('div', { className: 'ed-busy', hidden: true, attrs: { role: 'status' } });
  const banner = h('div', { className: 'ed-banner', hidden: true, attrs: { role: 'alert' } });
  planHost.append(actionbar, banner, rail, statusbar, previewBar, busy);
  const underlay = createUnderlay(ed, planHost);

  // action bar
  const titleEl = h('div', { className: 'ed-title' });
  const titleName = h('span', { className: 'ed-title-name' });
  const liveBadge = h('span', { className: 'ed-live-badge' });
  const saveState = h('span', { className: 'ed-save-state', attrs: { 'aria-live': 'polite' } });
  titleEl.append(h('span', { className: 'ed-title-kicker', text: 'Editing' }), titleName, liveBadge, saveState);
  const mkBtn = (ic, label, title, fn, cls = '') => {
    const b = h('button', { type: 'button', className: `ed-btn ${cls}`.trim(), title }, icon(ic), h('span', { className: 'ed-btn-label', text: label }));
    b.addEventListener('click', fn);
    return b;
  };
  const undoBtn = mkBtn('undo', 'Undo', `Undo (${kbd('Mod+Z')})`, () => cmd('undo'), 'ed-collapse');
  const redoBtn = mkBtn('redo', 'Redo', `Redo (${kbd('Mod+Shift+Z')})`, () => cmd('redo'), 'ed-collapse');
  const helpBtn = mkBtn('help', 'Shortcuts', 'Keyboard shortcuts (?)', () => shortcutsDialog(), 'ed-collapse ed-btn-quiet');
  const previewBtn = mkBtn('tv', 'Preview as TV', 'See the layout as the shop TV shows it', () => cmd('preview'));
  const liveBtn = mkBtn('broadcast', 'Make live', 'Show this layout on the shop TVs', () => cmd('make-live'));
  const saveBtn = mkBtn('save', 'Save', `Save (${kbd('Mod+S')})`, () => cmd('save'), 'ed-btn-primary');
  const doneBtn = mkBtn('done', 'Done', 'Close the editor', () => cmd('done'));
  saveBtn.dataset.action = 'save';
  liveBtn.dataset.action = 'make-live';
  previewBtn.dataset.action = 'preview';
  doneBtn.dataset.action = 'done';
  undoBtn.dataset.action = 'undo';
  redoBtn.dataset.action = 'redo';
  actionbar.append(titleEl, h('div', { className: 'ed-actionbar-group' }, undoBtn, redoBtn), h('div', { className: 'ed-spacer' }), helpBtn, previewBtn, liveBtn, saveBtn, doneBtn);

  // tool rail (icon + label, never icon-only)
  const toolBtns = new Map();
  for (const [id, label, ic, key] of TOOLS) {
    const b = h('button', { type: 'button', className: 'ed-tool', title: `${label} (${key})`, attrs: { 'aria-pressed': 'false' } }, icon(ic), h('span', { text: label }));
    b.dataset.tool = id;
    b.addEventListener('click', () => ed.setTool(id));
    toolBtns.set(id, b);
    rail.append(b);
    if (id === 'pan' || id === 'machine') rail.append(h('span', { className: 'ed-rail-sep', attrs: { 'aria-hidden': 'true' } }));
  }

  // status bar
  const gridBtn = h('button', { type: 'button', className: 'ed-toggle', title: 'Show or hide the grid (G)' }, icon('grid'), h('span', { className: 'ed-toggle-label' }));
  const snapBtn = h('button', { type: 'button', className: 'ed-toggle', title: 'Snap to the grid, edges, centres and wall corners (S). Hold Alt to drag freely.' }, icon('magnet'), h('span', { text: 'Snap' }));
  gridBtn.addEventListener('click', () => cmd('toggle-grid'));
  snapBtn.addEventListener('click', () => cmd('toggle-snap'));
  const coords = h('span', { className: 'ed-coords ed-mono' });
  const hint = h('span', { className: 'ed-hint' });
  const zoomOut = h('button', { type: 'button', className: 'ed-icon-btn', title: 'Zoom out (−)', attrs: { 'aria-label': 'Zoom out' } }, icon('minus'));
  const zoomLabel = h('span', { className: 'ed-zoom ed-mono' });
  const zoomIn = h('button', { type: 'button', className: 'ed-icon-btn', title: 'Zoom in (+)', attrs: { 'aria-label': 'Zoom in' } }, icon('plus'));
  const fitBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-small', title: 'Fit the drawing to the window (Shift+1)' }, icon('fit'), h('span', { text: 'Fit' }));
  fitBtn.dataset.action = 'fit';
  zoomOut.addEventListener('click', () => cmd('zoom-out'));
  zoomIn.addEventListener('click', () => cmd('zoom-in'));
  fitBtn.addEventListener('click', () => cmd('fit'));
  statusbar.append(gridBtn, snapBtn, h('span', { className: 'ed-sb-sep' }), coords, hint, h('span', { className: 'ed-spacer' }), zoomOut, zoomLabel, zoomIn, fitBtn);

  // preview bar
  const backBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-primary', dataset: { action: 'end-preview' } }, icon('select'), h('span', { text: 'Back to editing' }));
  backBtn.addEventListener('click', () => cmd('preview'));
  previewBar.append(h('span', { className: 'ed-preview-text' }, icon('tv'), h('span', { text: 'TV preview — unsaved changes included' })), backBtn);

  // side panel
  host.replaceChildren();
  const side = h('div', { className: 'ed-side' });
  const tabs = h('div', { className: 'ed-tabs', attrs: { role: 'tablist', 'aria-label': 'Editor panels' } });
  const panels = {};
  const tabBtns = {};
  const tokenNote = h('div', { className: 'ed-token-note', hidden: true });
  for (const [id, label] of [['properties', 'Properties'], ['devices', 'Devices'], ['layers', 'Layers'], ['history', 'History']]) {
    const t = h('button', { type: 'button', className: 'ed-tab', id: `ed-tab-${id}`, attrs: { role: 'tab', 'aria-controls': `ed-panel-${id}`, 'aria-selected': 'false' } }, h('span', { text: label }));
    if (id === 'devices') t.append(h('span', { className: 'ed-tab-count', hidden: true }));
    t.addEventListener('click', () => setTab(id));
    tabBtns[id] = t;
    tabs.append(t);
    panels[id] = h('div', { className: 'ed-tabpanel', id: `ed-panel-${id}`, hidden: true, attrs: { role: 'tabpanel', 'aria-labelledby': `ed-tab-${id}` } });
  }
  side.append(tabs, tokenNote, ...Object.values(panels));
  host.append(side);

  // ---------------------------------------------------------------------------------------------
  // Modules
  // ---------------------------------------------------------------------------------------------
  const canvas = createCanvas(ed);
  ed.canvas = canvas;
  canvas.isOverCanvas = (x, y) => { const r = svg.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const properties = createProperties(ed, panels.properties);
  const devices = createDevices(ed, panels.devices);
  ed.devices = devices;
  const layers = createLayers(ed, panels.layers);
  const versions = createVersions(ed, panels.history);

  // ---------------------------------------------------------------------------------------------
  // Rendering (coalesced to one animation frame)
  // ---------------------------------------------------------------------------------------------
  const dirtyParts = new Set();
  let frame = 0;
  let destroyed = false;
  ed.invalidate = (...parts) => {
    for (const p of parts) dirtyParts.add(p);
    if (!frame && !destroyed) frame = requestAnimationFrame(flush);
  };
  function flush() {
    frame = 0;
    if (destroyed) return;
    const parts = new Set(dirtyParts);
    dirtyParts.clear();
    const docChanged = parts.has('doc');
    if (docChanged) renderDoc();
    canvas.renderOverlay();
    if (docChanged || parts.has('view') || parts.has('underlay')) underlay.render();
    if (docChanged || parts.has('selection') || parts.has('panels') || parts.has('tool')) {
      if (!panels.properties.hidden) properties.render();
      if (!panels.layers.hidden) layers.render();
      if (!panels.history.hidden && (docChanged || parts.has('panels'))) versions.renderSession();
      if (!panels.devices.hidden && (docChanged || parts.has('selection'))) devices.render();
    }
    renderChrome();
  }

  function renderDoc() {
    const d = ed.doc;
    // the editor draws the trace photo itself (underlay.js), so the renderer never shows its own copy
    const view = d.background ? { ...d, background: { ...d.background, visible: false } } : d;
    fp.setLayout(view);
    ctx.setLayout?.(d);
    for (const coll of COLLECTIONS) fp.layers[coll].style.display = ed.layerHidden(coll) ? 'none' : '';
    canvas.clearMeasureCache?.();
  }

  function renderChrome() {
    titleName.textContent = ed.doc.name || ed.layoutId;
    titleName.title = `${ed.doc.name} (${ed.layoutId}.json)`;
    const live = ed.isLive();
    liveBadge.textContent = live ? 'Live on TV' : 'Not live';
    liveBadge.className = `ed-live-badge${live ? ' live' : ''}`;
    liveBtn.hidden = live;
    const state = saving ? 'Saving…' : ed.problems.length && ed.dirty ? `${ed.problems.length} problem${ed.problems.length === 1 ? '' : 's'}` : ed.dirty ? 'Unsaved changes' : ed.everSaved ? 'All changes saved' : 'Not saved yet';
    saveState.textContent = state;
    saveState.className = `ed-save-state${ed.dirty ? ' dirty' : ''}${ed.problems.length && ed.dirty ? ' problems' : ''}`;
    saveBtn.disabled = saving || (!ed.dirty && ed.everSaved);
    undoBtn.disabled = !ed.history.canUndo;
    redoBtn.disabled = !ed.history.canRedo;
    undoBtn.title = ed.history.canUndo ? `Undo ${ed.history.undoLabel} (${kbd('Mod+Z')})` : 'Nothing to undo';
    redoBtn.title = ed.history.canRedo ? `Redo ${ed.history.redoLabel} (${kbd('Mod+Shift+Z')})` : 'Nothing to redo';
    for (const [id, b] of toolBtns) {
      b.setAttribute('aria-pressed', String(id === ed.tool));
      b.classList.toggle('active', id === ed.tool);
    }
    gridBtn.classList.toggle('on', ed.opts.grid);
    gridBtn.setAttribute('aria-pressed', String(ed.opts.grid));
    gridBtn.querySelector('.ed-toggle-label').textContent = `Grid ${formatGrid()}`;
    snapBtn.classList.toggle('on', ed.opts.snap);
    snapBtn.setAttribute('aria-pressed', String(ed.opts.snap));
    zoomLabel.textContent = `${canvas.zoomPercent()}%`;
    const drawing = canvas.drawing;
    const key = drawing ? `${drawing.kind}Drawing` : ed.tool === 'select' && ed.selection.length ? 'selectSome' : ed.tool;
    hint.textContent = HINTS[key] ?? '';
    tokenNote.hidden = !!api.getEditToken() || ctx.getState?.()?.localEdit === true;
  }
  const formatGrid = () => {
    const g = ed.grid();
    if (ed.units() === 'm') return g < 1 ? `${Math.round(g * 100)} cm` : `${g} m`;
    return g < 1 ? `${Math.round(g * 12)}"` : `${g}'`;
  };

  let cursorFrame = 0;
  let cursorPoint = null;
  ed.setCursor = (p) => {
    cursorPoint = p;
    if (cursorFrame) return;
    cursorFrame = requestAnimationFrame(() => {
      cursorFrame = 0;
      const u = ed.units();
      coords.textContent = cursorPoint ? `x ${fmtCoord(cursorPoint[0], u)}   y ${fmtCoord(cursorPoint[1], u)}` : '';
    });
  };
  const fmtCoord = (v, u) => (u === 'm' ? `${v.toFixed(2)} m` : `${(Math.round(v * 2) / 2).toFixed(1)}'`);

  // ---------------------------------------------------------------------------------------------
  // Document changes, selection, tools, layers
  // ---------------------------------------------------------------------------------------------
  let gestureBase = null;
  let gestureSel = null;
  ed.begin = () => { if (!gestureBase) { gestureBase = ed.doc; gestureSel = [...ed.selection]; } };
  ed.preview = (doc) => { ed.doc = doc; ed.invalidate('doc'); };
  ed.commit = (label, { select } = {}) => {
    if (!gestureBase) return;
    const before = gestureBase;
    gestureBase = null;
    if (select) setSelection(select);
    if (before !== ed.doc && !sameDoc(before, ed.doc)) {
      ed.history.record(before, ed.doc, { label, selBefore: gestureSel, selAfter: ed.selection });
      changed();
    } else { ed.doc = before; ed.invalidate('doc'); }
  };
  ed.cancel = () => {
    if (!gestureBase) return;
    ed.doc = gestureBase;
    setSelection(gestureSel);
    gestureBase = null;
    ed.invalidate('doc');
  };
  /** Apply a finished change as one undo step. */
  ed.apply = (doc, { label = 'Change', select, coalesceKey = null } = {}) => {
    if (!doc || doc === ed.doc) return false;
    const before = ed.doc;
    const selBefore = [...ed.selection];
    ed.doc = doc;
    if (select) setSelection(select);
    ed.history.record(before, doc, { label, selBefore, selAfter: ed.selection, coalesceKey });
    changed();
    return true;
  };

  let dirtyTimer = null;
  function changed() {
    // ed.dirty must never lag a change: Done, beforeunload and teardown read it at once (a stale `false` there
    // closed the editor without asking and kept no draft). This cheap structural estimate is exact for edits and
    // for undo back to the opened document; checkDirty() refines it (validation, canonical form) once edits pause.
    ed.dirty = !ed.everSaved || !savedLayout || !sameDoc(ed.doc, savedLayout);
    ed.invalidate('doc', 'panels');
    ed.emit('change', ed.doc);
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(checkDirty, 200);
  }
  /** Run a pending (debounced) dirty check now, so callers that act on ed.dirty / ed.problems see exact values. */
  function flushDirty() {
    if (dirtyTimer === null) return;
    clearTimeout(dirtyTimer);
    checkDirty();
  }
  function checkDirty() {
    dirtyTimer = null;
    if (destroyed) return;
    const v = validateLayout(ed.doc, { expectedId: ed.layoutId });
    ed.problems = v.ok ? [] : v.errors;
    const canon = v.ok ? JSON.stringify(v.layout) : null;
    ed.dirty = !ed.everSaved || canon === null || canon !== savedCanonical;
    saveDraft();
    ed.invalidate('panels');
  }

  function setSelection(ids) {
    const exists = new Set();
    for (const id of ids ?? []) if (findItem(ed.doc, id)) exists.add(id);
    const next = [...exists];
    if (JSON.stringify(next) === JSON.stringify(ed.selection)) return;
    ed.selection = next;
    if (ed.vertexSel && !next.includes(ed.vertexSel.id)) ed.vertexSel = null;
    ed.emit('selection', next);
    ed.invalidate('selection');
  }
  ed.select = (ids, mode = 'replace', { silent = false } = {}) => {
    let next;
    if (mode === 'add') next = [...new Set([...ed.selection, ...ids])];
    else if (mode === 'toggle') { next = [...ed.selection]; for (const id of ids) { const i = next.indexOf(id); if (i >= 0) next.splice(i, 1); else next.push(id); } }
    else if (mode === 'remove') next = ed.selection.filter((id) => !ids.includes(id));
    else next = [...ids];
    setSelection(next);
    void silent;
  };
  ed.selectedMachine = () => {
    if (ed.selection.length !== 1) return null;
    const f = findItem(ed.doc, ed.selection[0]);
    return f?.coll === 'machines' ? f.item : null;
  };
  ed.tileStatus = (id) => fp.itemElement(id)?.dataset?.status ?? null;
  ed.isLive = () => (ctx.getState?.().activeLayout ?? null) === ed.layoutId;

  ed.setTool = (tool) => {
    if (!TOOLS.some(([id]) => id === tool)) return;
    if (tool === ed.tool) return;
    canvas.cancelGesture();
    ed.tool = tool;
    if (tool === 'photo') {
      ed.photoMode = 'move';
      ed.calibration = [];
      setTab('properties');
      if (!ed.doc.background?.src) ed.toast('Upload a photo first', { kind: 'info' });
      else {
        if (ed.doc.background.visible !== true) ed.apply({ ...ed.doc, background: { ...ed.doc.background, visible: true } }, { label: 'Show photo' });
        // bring the whole photo into view so its corners can be reached
        const c = ed.photoCorners?.();
        const v = canvas.getView();
        if (c && c.some(([x, y]) => x < v.x || y < v.y || x > v.x + v.w || y > v.y + v.h)) requestAnimationFrame(() => canvas.fit(48));
      }
    }
    root.dataset.edTool = tool;
    ed.emit('tool', tool);
    ed.invalidate('tool', 'overlay');
  };

  ed.layerHidden = (coll) => !!layerState[coll]?.hidden;
  ed.layerLocked = (coll) => !!layerState[coll]?.locked;
  ed.setLayer = (coll, patch) => {
    layerState[coll] = { ...(layerState[coll] ?? {}), ...patch };
    store.set(LAYER_KEY, JSON.stringify(layerState));
    if (patch.hidden || patch.locked) setSelection(ed.selection.filter((id) => findItem(ed.doc, id)?.coll !== coll));
    ed.invalidate('doc', 'panels');
  };

  ed.revealSelection = () => {
    const b = bboxUnion(ed.selection.map((id) => findItem(ed.doc, id)).filter(Boolean).map((f) => itemBounds(f.coll, f.item, ed.measure)));
    if (!b) return;
    const v = canvas.getView();
    if (b.minX >= v.x && b.maxX <= v.x + v.w && b.minY >= v.y && b.maxY <= v.y + v.h) return;
    canvas.setView({ ...v, x: (b.minX + b.maxX) / 2 - v.w / 2, y: (b.minY + b.maxY) / 2 - v.h / 2 });
  };

  let busyCount = 0;
  ed.busy = () => !!document.querySelector('dialog[open]') || busyCount > 0;
  ed.setBusyText = (text) => {
    busy.hidden = !text;
    busy.replaceChildren(text ? h('span', { className: 'ed-spinner', attrs: { 'aria-hidden': 'true' } }) : '', text ? h('span', { text }) : '');
    busyCount = text ? 1 : 0;
  };
  ed.setDraggingDevice = (on) => root.classList.toggle('ed-linking', !!on);

  // ---------------------------------------------------------------------------------------------
  // Edit token (D9): this editor's prompt explains where the token lives
  // ---------------------------------------------------------------------------------------------
  ed.requestToken = async (reason) => {
    const r = await tokenDialog({ api, reason, help: ctx.getState?.()?.tokenHelp ?? null });
    if (!r) return null;
    api.setEditToken(r.token, { remember: r.remember });
    ed.invalidate('panels');
    return r.token;
  };
  api.setTokenProvider(async (info) => ed.requestToken(info?.status === 401 && api.getEditToken() ? 'The server did not accept the stored edit token. Paste it again.' : info?.message && info.status !== 401 ? info.message : 'Saving needs the edit token.'));
  cleanups.push(() => api.setTokenProvider((info) => ctx.requestToken?.(info?.status === 401 ? undefined : info?.message) ?? null));
  const tokenBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-small', dataset: { action: 'token' } }, icon('key'), h('span', { text: 'Enter token' }));
  tokenBtn.addEventListener('click', () => ed.requestToken());
  tokenNote.append(icon('key'), h('span', { text: isWindowsKit(ctx.getState?.()?.tokenHelp) ? 'Saving needs the edit token (double-click “Show edit token” on the HUD computer).' : 'Saving needs the edit token (run npm run token on the server).' }), tokenBtn);

  // ---------------------------------------------------------------------------------------------
  // Commands (toolbar, shortcuts, panels)
  // ---------------------------------------------------------------------------------------------
  let clipboard = null;
  let pasteCount = 0;
  const editableIds = () => ed.selection.filter((id) => { const f = findItem(ed.doc, id); return f && !f.item.locked && !ed.layerLocked(f.coll); });

  async function cmd(name, arg) {
    if (destroyed) return undefined;
    switch (name) {
      case 'undo': case 'redo': {
        if (canvas.dragging) return undefined;
        if (canvas.drawing) { if (name === 'undo') canvas.undoDrawingPoint(); return undefined; }
        const r = name === 'undo' ? ed.history.undo() : ed.history.redo();
        if (!r) return undefined;
        ed.doc = r.doc;
        setSelection(r.selection);
        changed();
        ed.toast(`${name === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`, { kind: 'info', timeoutMs: 1800 });
        return undefined;
      }
      case 'save': return save();
      case 'delete': {
        if (ed.vertexSel) {
          const f = findItem(ed.doc, ed.vertexSel.id);
          if (f && f.item.points?.length > minPoints(f.coll, f.item)) {
            ed.apply(deleteVertex(ed.doc, ed.vertexSel.id, ed.vertexSel.index), { label: 'Delete point' });
            ed.vertexSel = null;
            return undefined;
          }
        }
        const ids = editableIds();
        if (!ids.length) { if (ed.selection.length) ed.toast('Locked items cannot be deleted — unlock them first', { kind: 'info' }); return undefined; }
        ed.apply(removeItems(ed.doc, ids), { label: `Delete ${describeItems(ed.doc, ids)}`, select: [] });
        return undefined;
      }
      case 'duplicate': {
        const ids = editableIds();
        if (!ids.length) return undefined;
        const g = Math.max(1, ed.grid());
        const r = duplicateItems(ed.doc, ids, { dx: g, dy: g });
        ed.apply(r.doc, { label: `Duplicate ${describeItems(ed.doc, ids)}`, select: r.ids });
        return undefined;
      }
      case 'select-all': {
        const ids = [];
        for (const coll of COLLECTIONS) {
          if (ed.layerHidden(coll) || ed.layerLocked(coll)) continue;
          for (const it of ed.doc[coll] ?? []) if (it && !it.locked) ids.push(it.id);
        }
        ed.select(ids);
        return undefined;
      }
      case 'lock': {
        if (!ed.selection.length) return undefined;
        const items = ed.selection.map((id) => findItem(ed.doc, id)).filter(Boolean);
        const lock = !items.every((f) => f.item.locked);
        ed.apply(setLocked(ed.doc, ed.selection, lock), { label: lock ? 'Lock' : 'Unlock' });
        ed.toast(lock ? 'Locked — unlock it from the Properties or Layers panel' : 'Unlocked', { kind: 'info', timeoutMs: 2500 });
        return undefined;
      }
      case 'rotate': {
        const ids = editableIds();
        if (!ids.length) return undefined;
        ed.apply(rotateItems(ed.doc, ids, arg, { measure: ed.measure }), { label: `Rotate ${arg > 0 ? '+' : ''}${arg}°`, coalesceKey: `rotate:${ids.join(',')}` });
        return undefined;
      }
      case 'align': ed.apply(alignItems(ed.doc, editableIds(), arg, ed.measure), { label: `Align ${arg}` }); return undefined;
      case 'distribute': ed.apply(distributeItems(ed.doc, editableIds(), arg, ed.measure), { label: 'Distribute' }); return undefined;
      case 'flip': {
        const doors = editableIds().map((id) => findItem(ed.doc, id)).filter((f) => f?.coll === 'doors');
        if (!doors.length) return undefined;
        let doc = ed.doc;
        for (const f of doors) {
          const cur = f.item.swing ?? (['door', 'double'].includes(f.item.kind ?? 'door') ? 'left' : 'none');
          doc = updateItem(doc, f.item.id, { swing: cur === 'left' ? 'right' : cur === 'right' ? 'left' : 'left' });
        }
        ed.apply(doc, { label: 'Flip door swing' });
        return undefined;
      }
      case 'nudge': {
        const ids = editableIds();
        if (!ids.length) return undefined;
        ed.apply(moveItems(ed.doc, ids, arg[0], arg[1]), { label: `Nudge ${describeItems(ed.doc, ids)}`, coalesceKey: `nudge:${ids.join(',')}` });
        return undefined;
      }
      case 'copy': case 'cut': return copyOrCut(name === 'cut');
      case 'paste': {
        const payload = arg ?? clipboard;
        if (!payload?.items?.length) return undefined;
        pasteCount++;
        const g = Math.max(1, ed.grid()) * pasteCount;
        const r = pasteItems(ed.doc, payload, { dx: g, dy: g });
        ed.apply(r.doc, { label: `Paste ${r.ids.length} item${r.ids.length === 1 ? '' : 's'}`, select: r.ids });
        if (payload.units && payload.units !== ed.units()) ed.toast(`Pasted from a layout in ${payload.units === 'm' ? 'metres' : 'feet'} — sizes were not converted`, { kind: 'info' });
        return undefined;
      }
      case 'fit': canvas.fit(); return undefined;
      case 'zoom-in': canvas.zoomBy(1.25); return undefined;
      case 'zoom-out': canvas.zoomBy(0.8); return undefined;
      case 'toggle-grid': ed.opts.grid = !ed.opts.grid; savePrefs(); ed.invalidate('underlay'); return undefined;
      case 'toggle-snap': ed.opts.snap = !ed.opts.snap; savePrefs(); ed.toast(ed.opts.snap ? 'Snapping on' : 'Snapping off — Alt does the same while dragging', { kind: 'info', timeoutMs: 1800 }); ed.invalidate('panels'); return undefined;
      case 'preview': return togglePreview();
      case 'make-live': return makeLive();
      case 'done': return done();
      case 'upload-photo': return uploadPhoto(ed, arg);
      case 'pick-photo': photoInput.click(); return undefined;
      case 'checklist': return checklist(arg);
      default: return undefined;
    }
  }
  ed.cmd = cmd;

  const savePrefs = () => store.set(PREFS_KEY, JSON.stringify({ snap: ed.opts.snap, grid: ed.opts.grid, tab: currentTab }));
  const photoInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/*', hidden: true });
  photoInput.addEventListener('change', () => { const f = photoInput.files?.[0]; photoInput.value = ''; if (f) cmd('upload-photo', f); });
  side.append(photoInput);

  function checklist(action) {
    switch (action) {
      case 'photo': return cmd('pick-photo');
      case 'wall': return ed.setTool('wall');
      case 'room': return ed.setTool('room');
      case 'machine': return ed.setTool('machine');
      case 'link': {
        const m = (ed.doc.machines ?? []).find((x) => x && !x.source);
        if (m) { ed.select([m.id]); ed.revealSelection(); }
        setTab('devices');
        return undefined;
      }
      case 'save': return save();
      case 'live': return makeLive();
      default: return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------------------------
  let currentTab = null;
  function setTab(id) {
    if (!panels[id] || id === currentTab) return;
    currentTab = id;
    for (const [k, p] of Object.entries(panels)) {
      p.hidden = k !== id;
      tabBtns[k].setAttribute('aria-selected', String(k === id));
      tabBtns[k].tabIndex = k === id ? 0 : -1;
    }
    devices.setVisible(id === 'devices');
    if (id === 'history') { versions.load(); versions.render(); }
    if (id === 'layers') layers.render();
    if (id === 'properties') properties.render();
    if (id === 'devices') devices.render();
    savePrefs();
  }
  ed.setTab = setTab;
  listen(tabs, 'keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const ids = Object.keys(panels);
    const i = ids.indexOf(currentTab);
    const next = ids[(i + (ev.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    setTab(next);
    tabBtns[next].focus();
  });
  ed.on('devices-count', ({ unlinked }) => {
    const c = tabBtns.devices.querySelector('.ed-tab-count');
    c.hidden = !unlinked;
    c.textContent = String(unlinked);
    c.title = `${unlinked} device${unlinked === 1 ? '' : 's'} not linked`;
  });
  ed.on('focus-field', ({ field }) => { setTab('properties'); requestAnimationFrame(() => properties.focusField(field)); });
  ed.on('calibration', () => ed.invalidate('panels'));

  // ---------------------------------------------------------------------------------------------
  // Save, conflicts, drafts
  // ---------------------------------------------------------------------------------------------
  let saving = false;
  let pendingExternal = null;
  const myEtags = new Set();

  async function save({ ifMatch } = {}) {
    if (saving || destroyed) return false;
    if (canvas.dragging) return false;
    if (canvas.drawing) canvas.finishDrawing();
    const v = validateLayout(ed.doc, { expectedId: ed.layoutId });
    if (!v.ok) { showProblems(v.errors); return false; }
    // the HUD computer itself (D9 amendment) and the public demo save without one; a 401 still asks
    if (!api.getEditToken() && ctx.getState?.()?.localEdit !== true) {
      const t = await ed.requestToken('Saving needs the edit token.');
      if (!t) return false;
    }
    saving = true;
    renderChrome();
    try {
      let r;
      if (!ed.everSaved) r = await api.layouts.create(v.layout);
      else r = await api.layouts.save(ed.layoutId, v.layout, ifMatch !== undefined ? { ifMatch } : {});
      etag = api.layouts.etag(ed.layoutId) ?? r?.etag ?? etag;
      if (etag) myEtags.add(etag);
      savedLayout = isObj(r?.layout) ? r.layout : v.layout;
      savedCanonical = JSON.stringify(savedLayout);
      ed.everSaved = true;
      ed.dirty = canonical(ed.doc) !== savedCanonical;
      clearDraft();
      hideBanner();
      ed.toast(`Saved ${ed.doc.name}`, { kind: 'ok', timeoutMs: 2500 });
      ed.emit('saved', savedLayout);
      if (!panels.history.hidden) versions.load();
      return true;
    } catch (e) {
      if (e?.status === 412 || e?.status === 409) return resolveConflict(e);
      if (e?.status === 400 && Array.isArray(e.errors)) { showProblems(e.errors); return false; }
      if (e?.status === 401) { ed.toast('Not saved: the edit token is needed', { kind: 'error' }); return false; }
      if (e?.status === 428) { ed.toast('Not saved: reload the layout first', { kind: 'error' }); return false; }
      ed.toast(`Not saved: ${e?.message ?? e}. Your changes are kept on this device.`, { kind: 'error', timeoutMs: 8000 });
      return false;
    } finally {
      saving = false;
      ed.invalidate('panels');
      if (pendingExternal) { const p = pendingExternal; pendingExternal = null; onLayoutEvent(p); }
    }
  }

  async function resolveConflict(e) {
    const body = isObj(e.body) ? e.body : {};
    const choice = await conflictDialog({ updatedAt: body.updatedAt ?? null, name: `“${ed.doc.name}”` });
    if (choice === 'overwrite') return save({ ifMatch: body.etag ?? '*' });
    if (choice === 'reload') { await reloadFromServer({ label: 'Load the saved version' }); return false; }
    if (choice === 'copy') return saveAsCopy();
    return false;
  }

  async function reloadFromServer({ label = 'Reload from the server' } = {}) {
    try {
      const r = await fetchLayout(ed.layoutId);
      etag = r.etag;
      savedLayout = r.layout;
      savedCanonical = canonical(r.layout);
      ed.everSaved = true;
      if (sameDoc(ed.doc, r.layout)) checkDirty();
      else ed.apply(r.layout, { label, select: ed.selection });
      hideBanner();
      ed.toast('Loaded the saved version — Undo brings your changes back', { kind: 'info' });
    } catch (err) {
      ed.toast(`Could not reload: ${err.message}`, { kind: 'error' });
    }
  }

  async function saveAsCopy() {
    const name = await promptDialog({
      title: 'Save as a new layout', label: 'Name of the copy', value: `${ed.doc.name} (copy)`, ok: 'Save copy', icon: 'save',
      parse: (t) => (t.trim() ? { value: t.trim().slice(0, 120) } : { error: 'Give the copy a name' }),
    });
    if (!name) return false;
    const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'layout';
    for (let n = 1; n < 50; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!LAYOUT_ID_RE.test(id)) continue;
      const copy = { ...ed.doc, id, name };
      const v = validateLayout(copy, { expectedId: id });
      if (!v.ok) { showProblems(v.errors); return false; }
      try {
        const r = await api.layouts.create(v.layout);
        ed.layoutId = id;
        etag = api.layouts.etag(id) ?? r?.etag ?? null;
        if (etag) myEtags.add(etag);
        savedLayout = isObj(r?.layout) ? r.layout : v.layout;
        savedCanonical = JSON.stringify(savedLayout);
        ed.everSaved = true;
        ed.doc = { ...ed.doc, id };
        changed();
        clearDraft();
        ed.toast(`Saved as “${name}” (${id}). Use Make live to show it on the TVs.`, { kind: 'ok', timeoutMs: 7000 });
        return true;
      } catch (err) {
        if (err?.status === 409) continue;
        ed.toast(`Could not save the copy: ${err.message}`, { kind: 'error' });
        return false;
      }
    }
    return false;
  }

  function showProblems(errors) {
    const list = h('ul', { className: 'ed-problems' }, ...errors.slice(0, 12).map((er) => {
      const m = /^(\w+)\[(\d+)\]/.exec(er.path ?? '');
      const it = m ? ed.doc[m[1]]?.[Number(m[2])] : null;
      const li = h('li', {}, h('strong', { text: it ? `${it.name ?? it.text ?? it.label ?? it.id}: ` : er.path ? `${er.path}: ` : '' }), h('span', { text: er.message }));
      if (it?.id) {
        const b = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-quiet', text: 'Show' });
        b.addEventListener('click', () => { ed.select([it.id]); ed.revealSelection(); document.querySelector('dialog[open]')?.close(); });
        li.append(b);
      }
      return li;
    }));
    openDialog({ title: 'Fix these before saving', icon: 'warning', body: [h('p', { text: 'The layout has problems the server would refuse:' }), list], actions: [{ label: 'OK', value: true, primary: true }] });
  }

  const draftKey = () => `${DRAFT_PREFIX}${ed.layoutId}`;
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (destroyed) return;
      if (ed.dirty) store.set(draftKey(), JSON.stringify({ v: 1, layoutId: ed.layoutId, etag, savedAt: Date.now(), doc: ed.doc }));
      else store.remove(draftKey());
    }, 600);
  }
  function clearDraft() { clearTimeout(draftTimer); store.remove(draftKey()); }

  async function offerDraft() {
    const d = store.getJson(draftKey());
    if (!d || !isObj(d.doc) || d.layoutId !== ed.layoutId) return;
    if (canonical(d.doc) !== null && canonical(d.doc) === savedCanonical) { clearDraft(); return; }
    const changedSince = d.etag && etag && d.etag !== etag;
    const choice = await openDialog({
      title: 'Unsaved changes found', icon: 'clock',
      body: [
        h('p', { text: `This device has changes to “${ed.doc.name}” from ${when(d.savedAt)} that were never saved.` }),
        changedSince ? h('p', { className: 'ed-callout', text: 'The layout has been saved elsewhere since then. Restoring and saving would replace that version (it stays in the version history).' }) : null,
      ],
      actions: [{ label: 'Discard them', value: 'discard', danger: true }, { label: 'Restore my changes', value: 'restore', primary: true }],
      dismissible: false,
    });
    if (choice === 'restore') {
      ed.apply({ ...d.doc, id: ed.layoutId }, { label: 'Restore unsaved draft' });
      ed.toast('Draft restored — Save to keep it', { kind: 'ok' });
    } else clearDraft();
  }

  // external changes (someone else saved, or the file changed on disk)
  function showBanner(text, actions) {
    banner.replaceChildren(icon('warning'), h('span', { className: 'ed-banner-text', text }), ...actions.map(([label, fn, primary]) => {
      const b = h('button', { type: 'button', className: `ed-btn ed-btn-small${primary ? ' ed-btn-primary' : ''}`, text: label });
      b.addEventListener('click', fn);
      return b;
    }));
    banner.hidden = false;
  }
  function hideBanner() { banner.hidden = true; banner.replaceChildren(); }

  function onLayoutEvent(data) {
    if (!isObj(data) || data.id !== ed.layoutId) {
      if (data?.reason === 'activated') ed.invalidate('panels');
      return;
    }
    if (data.reason === 'activated') { ed.invalidate('panels'); return; }
    if (saving) { pendingExternal = data; return; }
    if (data.reason === 'invalid') return;
    if (data.reason === 'deleted' || data.reason === 'removed') {
      showBanner('This layout was deleted on the server. Saving will fail — save it as a copy instead.', [['Save as a copy', () => saveAsCopy(), true]]);
      return;
    }
    if (!data.etag || data.etag === etag || myEtags.has(data.etag)) return;
    if (!ed.dirty) { reloadFromServer({ label: 'Update from the server' }); return; }
    showBanner('Someone else saved this layout (or the file changed on disk) while you were editing.', [
      ['Load their version', () => reloadFromServer({ label: 'Load the saved version' }), false],
      ['Keep editing mine', () => hideBanner(), true],
    ]);
  }
  const unsub = ctx.subscribe?.((name, data) => {
    if (name === 'layout') onLayoutEvent(data);
    else if (name === 'settings' || name === 'snapshot') ed.invalidate('panels');
  });
  if (unsub) cleanups.push(unsub);

  // ---------------------------------------------------------------------------------------------
  // Make live, preview, exit
  // ---------------------------------------------------------------------------------------------
  async function makeLive() {
    if (ed.dirty || !ed.everSaved) {
      const ok = await confirmDialog({ title: 'Save and make live?', message: 'The TVs show the saved layout, so your changes are saved first.', ok: 'Save and make live' });
      if (!ok || !(await save())) return;
    }
    try {
      await api.layouts.activate(ed.layoutId);
      ed.toast(`“${ed.doc.name}” is now live on the shop TVs`, { kind: 'ok' });
    } catch (e) {
      ed.toast(`Could not make it live: ${e.message}`, { kind: 'error' });
    }
    ed.invalidate('panels');
  }
  let savedView = null;
  function togglePreview() {
    ed.previewing = !ed.previewing;
    root.classList.toggle('ed-preview', ed.previewing);
    previewBar.hidden = !ed.previewing;
    if (ed.previewing) {
      canvas.cancelGesture();
      savedView = canvas.getView();
      fp.setMode('view');
      fp.fit();
      requestAnimationFrame(() => { if (ed.previewing) fp.fit(); });
    } else {
      fp.setMode('edit');
      if (savedView) canvas.setView(savedView);
    }
    ed.invalidate('doc', 'view');
    dispatchEvent(new Event('resize')); // let the HUD re-measure its board for the preview
  }

  async function done() {
    if (canvas.drawing) canvas.finishDrawing();
    flushDirty();
    if (ed.dirty) {
      const choice = await openDialog({
        title: 'Save your changes?', icon: 'save',
        body: [h('p', { text: `“${ed.doc.name}” has unsaved changes.` }), h('p', { className: 'ed-muted', text: 'Discarded changes are gone (a local draft is not kept).' })],
        actions: [{ label: 'Keep editing', value: null }, { label: 'Discard changes', value: 'discard', danger: true }, { label: 'Save and close', value: 'save', primary: true }],
      });
      if (!choice) return;
      if (choice === 'save' && !(await save())) return;
      if (choice === 'discard') { clearDraft(); ed.dirty = false; }
    }
    const layout = savedLayout ?? undefined;
    await ctx.exit?.({ layout });
  }

  // ---------------------------------------------------------------------------------------------
  // Keyboard, clipboard, drag-and-drop of photos, leaving the page
  // ---------------------------------------------------------------------------------------------
  listen(document, 'keydown', (ev) => {
    if (destroyed || ev.defaultPrevented) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key;
    if (document.querySelector('dialog[open]')) return;
    if (mod && key.toLowerCase() === 's') { ev.preventDefault(); cmd('save'); return; }
    if (isTyping(ev.target)) return;
    if (ed.previewing) { if (key === 'Escape') { ev.preventDefault(); cmd('preview'); } return; }
    if (key === 'Shift' || key === 'Alt') { canvas.modifiersChanged(ev); if (key === 'Alt') ev.preventDefault(); return; }
    if (key === ' ') { ev.preventDefault(); if (!ev.repeat) canvas.setSpace(true); return; }
    if (mod) {
      const k = key.toLowerCase();
      if (k === 'z') { ev.preventDefault(); cmd(ev.shiftKey ? 'redo' : 'undo'); }
      else if (k === 'y') { ev.preventDefault(); cmd('redo'); }
      else if (k === 'd') { ev.preventDefault(); cmd('duplicate'); }
      else if (k === 'a') { ev.preventDefault(); cmd('select-all'); }
      else if (k === 'l') { ev.preventDefault(); cmd('lock'); }
      // clipboard: the native copy/cut/paste events (below) also reach the system clipboard; these fall back to
      // the editor's own clipboard when no native event follows (some browsers, remote desktops)
      else if (k === 'c') { if (ed.selection.length) copyOrCut(false); }
      else if (k === 'x') { if (ed.selection.length) { copyOrCut(false); clearTimeout(pendingCut); pendingCut = setTimeout(() => { pendingCut = null; const ids = editableIds(); if (ids.length) ed.apply(removeItems(ed.doc, ids), { label: `Cut ${describeItems(ed.doc, ids)}`, select: [] }); }, 80); } }
      else if (k === 'v') { clearTimeout(pendingPaste); pendingPaste = setTimeout(() => { pendingPaste = null; cmd('paste'); }, 80); }
      else if (k === '0') { ev.preventDefault(); cmd('fit'); }
      else if (k === '=' || k === '+') { ev.preventDefault(); cmd('zoom-in'); }
      else if (k === '-') { ev.preventDefault(); cmd('zoom-out'); }
      return;
    }
    if (key.startsWith('Arrow')) {
      if (!ed.selection.length) return;
      ev.preventDefault();
      const stepv = nudgeStep({ grid: ed.grid(), units: ed.units(), shift: ev.shiftKey, alt: ev.altKey });
      const d = { ArrowLeft: [-stepv, 0], ArrowRight: [stepv, 0], ArrowUp: [0, -stepv], ArrowDown: [0, stepv] }[key];
      cmd('nudge', d);
      return;
    }
    switch (key) {
      case 'Escape':
        ev.preventDefault();
        if (canvas.cancelGesture()) return;
        if (ed.tool !== 'select') { ed.setTool('select'); return; }
        if (ed.vertexSel) { ed.vertexSel = null; ed.invalidate('overlay'); return; }
        ed.select([]);
        return;
      case 'Enter': if (canvas.drawing) { ev.preventDefault(); canvas.finishDrawing(); } return;
      case 'Delete': case 'Backspace':
        ev.preventDefault();
        if (canvas.drawing) { canvas.undoDrawingPoint(); return; }
        cmd('delete');
        return;
      case '[': case ']': case '{': case '}': {
        ev.preventDefault();
        const sign = key === '[' || key === '{' ? -1 : 1;
        cmd('rotate', sign * (ev.shiftKey ? 90 : 15));
        return;
      }
      case '?': ev.preventDefault(); shortcutsDialog(); return;
      case '+': case '=': ev.preventDefault(); cmd('zoom-in'); return;
      case '-': case '_': ev.preventDefault(); cmd('zoom-out'); return;
      case '0': case '!': ev.preventDefault(); cmd('fit'); return;
      default: break;
    }
    const k = key.toLowerCase();
    if (k === 'f' && !ev.shiftKey) { ev.preventDefault(); cmd('flip'); return; }
    if (k === 'g') { ev.preventDefault(); cmd('toggle-grid'); return; }
    if (k === 's') { ev.preventDefault(); cmd('toggle-snap'); return; }
    if (TOOL_KEYS[k] && !ev.altKey) { ev.preventDefault(); ed.setTool(TOOL_KEYS[k]); }
  });
  listen(document, 'keyup', (ev) => {
    if (ev.key === ' ') canvas.setSpace(false);
    if (ev.key === 'Shift' || ev.key === 'Alt') canvas.modifiersChanged(ev);
  });
  listen(window, 'blur', () => canvas.setSpace(false));

  listen(document, 'copy', (ev) => {
    if (destroyed || isTyping(ev.target) || ed.previewing || !ed.selection.length) return;
    const payload = copyOrCut(false);
    if (!payload) return;
    ev.clipboardData?.setData('text/plain', JSON.stringify(payload));
    ev.preventDefault();
  });
  let pendingCut = null;
  let pendingPaste = null;
  cleanups.push(() => { clearTimeout(pendingCut); clearTimeout(pendingPaste); });
  listen(document, 'cut', (ev) => {
    if (destroyed || isTyping(ev.target) || ed.previewing || !ed.selection.length) return;
    clearTimeout(pendingCut);
    pendingCut = null;
    const payload = copyOrCut(true);
    if (!payload) return;
    ev.clipboardData?.setData('text/plain', JSON.stringify(payload));
    ev.preventDefault();
  });
  listen(document, 'paste', (ev) => {
    if (destroyed || isTyping(ev.target) || ed.previewing) return;
    clearTimeout(pendingPaste);
    pendingPaste = null;
    const text = ev.clipboardData?.getData('text/plain');
    const payload = parseClipboard(text) ?? null;
    if (payload) { ev.preventDefault(); cmd('paste', payload); return; }
    const file = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) { ev.preventDefault(); cmd('upload-photo', file); return; }
    if (clipboard) { ev.preventDefault(); cmd('paste'); }
  });
  /** Copy (or cut) the selection into the editor clipboard; returns the payload or null. Synchronous. */
  function copyOrCut(cut) {
    const ids = cut ? editableIds() : ed.selection;
    if (!ids.length) return null;
    clipboard = copyItems(ed.doc, ids);
    pasteCount = 0;
    if (cut) ed.apply(removeItems(ed.doc, ids), { label: `Cut ${describeItems(ed.doc, ids)}`, select: [] });
    return clipboard;
  }

  listen(planHost, 'dragover', (ev) => { if ([...(ev.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) { ev.preventDefault(); planHost.classList.add('ed-dropping'); } });
  listen(planHost, 'dragleave', () => planHost.classList.remove('ed-dropping'));
  listen(planHost, 'drop', (ev) => {
    planHost.classList.remove('ed-dropping');
    const file = [...(ev.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    ev.preventDefault();
    cmd('upload-photo', file);
  });

  listen(window, 'beforeunload', (ev) => {
    flushDirty();
    if (!ed.dirty) return;
    saveDraftNow();
    ev.preventDefault();
    ev.returnValue = '';
  });
  function saveDraftNow() {
    if (ed.dirty) store.set(draftKey(), JSON.stringify({ v: 1, layoutId: ed.layoutId, etag, savedAt: Date.now(), doc: ed.doc }));
  }

  // keep the 1 Hz bits fresh (live badge, devices tab count, "changed 4 s ago")
  const tick = setInterval(() => ed.invalidate('panels'), 5000);

  // ---------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------
  svg.classList.add('ed-canvas');
  root.dataset.edTool = 'select';
  setTab(prefs.tab && panels[prefs.tab] ? prefs.tab : 'properties');
  renderDoc();
  await new Promise((r) => requestAnimationFrame(r));
  canvas.fit();
  ed.invalidate('doc', 'view', 'panels');
  checkDirty();
  if (!ed.everSaved) ed.toast(`Layout “${ed.layoutId}” does not exist yet — draw it and Save to create it`, { kind: 'info', timeoutMs: 8000 });
  offerDraft();
  if (new URLSearchParams(location.search).get('debug') === '1') globalThis.__editor = ed;

  // ---------------------------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------------------------
  function destroy() {
    if (destroyed) return;
    flushDirty();
    if (ed.dirty) saveDraftNow();
    destroyed = true;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(cursorFrame);
    clearInterval(tick);
    clearTimeout(dirtyTimer);
    clearTimeout(draftTimer);
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
    if (ed.previewing) { ed.previewing = false; root.classList.remove('ed-preview'); }
    devices.destroy();
    canvas.destroy();
    underlay.destroy();
    for (const el of [actionbar, rail, statusbar, previewBar, busy, banner]) el.remove();
    host.replaceChildren();
    planHost.classList.remove('ed-plan', 'ed-dropping');
    root.classList.remove('ed-active', 'ed-linking');
    delete root.dataset.edTool;
    svg.classList.remove('ed-canvas');
    for (const coll of COLLECTIONS) fp.layers[coll].style.display = '';
    if (globalThis.__editor === ed) delete globalThis.__editor;
    for (const d of document.querySelectorAll('dialog.ed-dialog')) d.remove();
    document.querySelector('.ed-drag-ghost')?.remove();
  }

  return { destroy, editor: ed };
}

export default mountEditor;
