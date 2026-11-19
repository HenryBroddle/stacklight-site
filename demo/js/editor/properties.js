// Properties panel: fields for the selection (machine, object, room, wall, door, label, several items) or, with
// nothing selected, the layout itself, the trace photo and the getting-started checklist (DECISIONS D5).
import { MACHINE_KINDS, OBJECT_KINDS, ROOM_KINDS, DOOR_KINDS, WALL_STYLES, LABEL_STYLES } from '/shared/contracts.js';
import { describeSource, endpointKey } from '/shared/sources.js';
import { h, icon, kbd } from './dom.js';
import { textField, lengthField, angleField, selectField, checkField, rangeField, readout, section, pair } from './fields.js';
import { formatLength, formatArea, parseLength } from './units.js';
import { normalizeDeg, polylineLength, rectFromCorners, scaleAbout, round4 } from './geometry.js';
import { itemArea, wallThickness, labelSize } from './items.js';
import {
  findItem, updateItem, updateDoc, describeItems, roomToPolygon, convertItem, setSource, machinesLinkedTo,
} from './ops.js';
import { gettingStarted } from './checklist.js';
import { statusChip, identityLine, openLinkDialog, runTest, renderTest } from './devices.js';
import { promptDialog, confirmDialog } from './dialogs.js';
import { prepareImage, uploadImage, initialPlacement } from './photo.js';

const opts = (table) => Object.entries(table).map(([k, v]) => [k, v.label]);
const THRESHOLDS = [['pausedWarnMinutes', 'Paused'], ['idleWarnMinutes', 'Idle'], ['setupWarnMinutes', 'Setup'], ['offlineWarnMinutes', 'Offline'], ['downWarnMinutes', 'Any stop']];
const TYPE_LABEL = { machines: 'Machine', objects: 'Object', rooms: 'Room', walls: 'Wall', doors: 'Door', labels: 'Label' };
const TYPE_ICON = { machines: 'machine', objects: 'object', rooms: 'room', walls: 'wall', doors: 'door', labels: 'label' };

/**
 * @param {object} ed  editor core
 * @param {HTMLElement} container
 */
export function createProperties(ed, container) {
  let sig = null;
  let fields = [];
  let extras = [];   // functions run on update (live read-outs)
  const body = h('div', { className: 'ed-props' });
  container.append(body);

  const u = () => ed.units();
  const step = () => ed.grid();

  /** Field helpers bound to one item id. */
  function bind(id) {
    const item = () => findItem(ed.doc, id)?.item ?? {};
    const setter = (key, label, { coalesce = false } = {}) => (v, o = {}) => {
      const next = updateItem(ed.doc, id, { [key]: v });
      if (next === ed.doc) return;
      ed.apply(next, { label, coalesceKey: coalesce ? `${key}:${id}` : null });
      if (o.final) ed.history.seal();
    };
    return { item, setter };
  }

  function render() {
    const sel = ed.selection.map((id) => findItem(ed.doc, id)).filter(Boolean);
    const nextSig = JSON.stringify([sel.map((f) => [f.item.id, f.coll, f.coll === 'rooms' ? Array.isArray(f.item.points) : 0, f.item.locked ? 1 : 0, f.coll === 'machines' ? !!f.item.source : 0]), ed.tool === 'photo', !!ed.doc.background?.src, ed.photoMode]);
    if (nextSig === sig) { update(); return; }
    sig = nextSig;
    fields = [];
    extras = [];
    let content;
    if (ed.tool === 'photo') content = photoPanel(true);
    else if (!sel.length) content = layoutPanel();
    else if (sel.length === 1) content = itemPanel(sel[0]);
    else content = multiPanel(sel);
    body.replaceChildren(...[content].flat());
    update();
  }

  function update() {
    for (const f of fields) f.update();
    for (const fn of extras) fn();
  }

  const add = (f) => { fields.push(f); return f; };

  // ---------------------------------------------------------------------------------------------
  // Header with type, lock badge and quick actions
  // ---------------------------------------------------------------------------------------------
  function header(f, title) {
    const locked = f.item.locked || ed.layerLocked(f.coll);
    const head = h('div', { className: 'ed-props-head' },
      h('div', { className: 'ed-props-type' }, icon(TYPE_ICON[f.coll]), h('span', { text: TYPE_LABEL[f.coll] })),
      h('div', { className: 'ed-props-title', text: title }),
      locked ? h('span', { className: 'ed-badge ed-badge-lock' }, icon('lock'), h('span', { text: ed.layerLocked(f.coll) && !f.item.locked ? 'Layer locked' : 'Locked' })) : null);
    return head;
  }

  function actions(f, { convert = null } = {}) {
    const id = f.item.id;
    const row = h('div', { className: 'ed-actions' });
    const btn = (ic, label, fn, cls = '', k) => {
      const b = h('button', { type: 'button', className: `ed-btn ed-btn-small ${cls}`.trim(), title: k ? `${label} (${kbd(k)})` : label }, icon(ic), h('span', { text: label }));
      b.addEventListener('click', fn);
      row.append(b);
    };
    btn(f.item.locked ? 'unlock' : 'lock', f.item.locked ? 'Unlock' : 'Lock', () => ed.cmd('lock'), '', 'Mod+L');
    btn('duplicate', 'Duplicate', () => ed.cmd('duplicate'), '', 'Mod+D');
    if (convert) btn('convert', convert === 'machines' ? 'Make it a machine' : 'Make it an object', () => {
      const r = convertItem(ed.doc, id, convert);
      if (r.id) ed.apply(r.doc, { label: convert === 'machines' ? 'Convert to machine' : 'Convert to object', select: [r.id] });
    });
    btn('trash', 'Delete', () => ed.cmd('delete'), 'ed-btn-danger-quiet', 'Del');
    return row;
  }

  // ---------------------------------------------------------------------------------------------
  // Item panels
  // ---------------------------------------------------------------------------------------------
  function itemPanel(f) {
    switch (f.coll) {
      case 'machines': return machinePanel(f);
      case 'objects': return objectPanel(f);
      case 'rooms': return roomPanel(f);
      case 'walls': return wallPanel(f);
      case 'doors': return doorPanel(f);
      case 'labels': return labelPanel(f);
      default: return h('p', { text: 'Unknown item' });
    }
  }

  function geometryFields(id, { rotation = true } = {}) {
    const { item, setter } = bind(id);
    const x = add(lengthField({ label: 'X', name: 'x', get: () => item().x, set: setter('x', 'Move'), units: u, step }));
    const y = add(lengthField({ label: 'Y', name: 'y', get: () => item().y, set: setter('y', 'Move'), units: u, step }));
    const w = add(lengthField({ label: 'Width', name: 'w', get: () => item().w, set: (v) => resizeKeepCentre(id, { w: v }), units: u, step, min: 0.1, max: 5000 }));
    const hh = add(lengthField({ label: 'Depth', name: 'h', get: () => item().h, set: (v) => resizeKeepCentre(id, { h: v }), units: u, step, min: 0.1, max: 5000 }));
    const out = [pair(x, y), pair(w, hh)];
    if (rotation) {
      const rot = add(angleField({ label: 'Rotation', name: 'rotation', get: () => item().rotation ?? 0, set: (v) => setRotation(id, v) }));
      const r90 = h('button', { type: 'button', className: 'ed-btn ed-btn-small', title: `Rotate 90° (${kbd('Shift+]')})` }, icon('rotate'), h('span', { text: '90°' }));
      r90.addEventListener('click', () => ed.cmd('rotate', 90));
      out.push(h('div', { className: 'ed-pair ed-pair-rot' }, rot.el, r90));
    }
    return out;
  }

  /** Width/depth typed in a field: keep the centre (rotation-safe). */
  function resizeKeepCentre(id, patch) {
    const f = findItem(ed.doc, id);
    if (!f) return;
    const it = f.item;
    const w = patch.w ?? it.w, hh = patch.h ?? it.h;
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    ed.apply(updateItem(ed.doc, id, { w, h: hh, x: round4(cx - w / 2), y: round4(cy - hh / 2) }), { label: 'Resize' });
  }

  function setRotation(id, deg) {
    const f = findItem(ed.doc, id);
    if (!f) return;
    ed.apply(updateItem(ed.doc, id, { rotation: normalizeDeg(deg) }), { label: 'Rotate' });
  }

  function nameField(id, label = 'Name') {
    const { item, setter } = bind(id);
    return add(textField({ label, name: 'name', get: () => item().name, set: setter('name', 'Rename', { coalesce: true }), maxLength: 120 }));
  }

  function notesField(id) {
    const { item, setter } = bind(id);
    return add(textField({ label: 'Notes', name: 'notes', multiline: true, maxLength: 2000, placeholder: 'Only shown in the editor and the detail drawer', get: () => item().notes ?? '', set: (v, o) => setter('notes', 'Edit notes', { coalesce: true })(v || undefined, o) }));
  }

  function machinePanel(f) {
    const id = f.item.id;
    const { item, setter } = bind(id);
    const nodes = [header(f, f.item.name)];
    nodes.push(nameField(id).el);
    nodes.push(add(selectField({ label: 'Kind', name: 'kind', options: opts(MACHINE_KINDS), get: () => item().kind ?? 'other', set: setter('kind', 'Change kind'), wide: true })).el);
    nodes.push(linkSection(id));
    nodes.push(section('Position and size', { open: true }, ...geometryFields(id)));
    nodes.push(section('Notes', { open: !!f.item.notes }, notesField(id).el));
    nodes.push(thresholdSection(id));
    nodes.push(actions(f, { convert: 'objects' }));
    return nodes;
  }

  function linkSection(id) {
    const box = h('div', { className: 'ed-link-box' });
    const refresh = () => {
      const m = findItem(ed.doc, id)?.item;
      if (!m) return;
      const src = m.source;
      const dev = src ? ed.devices?.deviceFor(src) : null;
      const kids = [];
      if (!src) {
        kids.push(h('div', { className: 'ed-link-state' }, statusChip('UNBOUND', ed.theme(), { small: true }), h('span', { className: 'ed-muted', text: 'Not linked to a controller yet' })));
        kids.push(h('p', { className: 'ed-hint-line', text: 'Drag a device from the Devices tab onto this machine, or:' }));
      } else {
        kids.push(h('div', { className: 'ed-link-state' }, statusChip(dev?.status ?? ed.tileStatus(id) ?? 'UNAVAILABLE', ed.theme(), { small: true }), h('strong', { text: dev?.name ?? src.device ?? src.host ?? 'Linked device' })));
        if (dev && identityLine(dev)) kids.push(h('div', { className: 'ed-muted', text: identityLine(dev) }));
        kids.push(h('div', { className: 'ed-link-src ed-mono', text: describeSource(src) }));
        if (src.uuid || src.serialNumber) kids.push(h('div', { className: 'ed-link-id', text: [src.serialNumber ? `Serial ${src.serialNumber}` : null, src.uuid ? `uuid ${src.uuid}` : null].filter(Boolean).join(' · ') }));
        if (dev?.programComment || dev?.program) kids.push(h('div', { className: 'ed-device-prog', text: [dev.program, dev.programComment].filter(Boolean).join(' · ') }));
        if (!dev) kids.push(h('p', { className: 'ed-hint-line', text: 'The server does not see this device right now (saved but offline, or not saved yet).' }));
        const others = machinesLinkedTo(ed.doc, src, endpointKey, id);
        if (others.length) kids.push(h('div', { className: 'ed-warn-line' }, icon('warning'), h('span', { text: `Also linked to ${others.map((o) => o.name).join(', ')}` })));
      }
      const row = h('div', { className: 'ed-actions' });
      const linkBtn = h('button', { type: 'button', className: `ed-btn ed-btn-small${src ? '' : ' ed-btn-primary'}`, dataset: { action: 'link' } }, icon('link'), h('span', { text: src ? 'Change link…' : 'Link…' }));
      linkBtn.addEventListener('click', () => openLinkDialog(ed, findItem(ed.doc, id).item, ed.devices));
      row.append(linkBtn);
      if (src) {
        const testBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-small', dataset: { action: 'test' } }, icon('plug'), h('span', { text: 'Test connection' }));
        const result = h('div', { className: 'ed-test-result', attrs: { role: 'status' } });
        testBtn.addEventListener('click', async () => {
          testBtn.disabled = true;
          result.replaceChildren(h('p', { className: 'ed-muted', text: 'Connecting…' }));
          const r = await runTest(ed, findItem(ed.doc, id)?.item.source);
          testBtn.disabled = false;
          result.replaceChildren(renderTest(r, ed.theme()));
        });
        const unlink = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-quiet' }, h('span', { text: 'Unlink' }));
        unlink.addEventListener('click', () => ed.apply(setSource(ed.doc, id, null), { label: 'Unlink machine' }));
        row.append(testBtn, unlink);
        kids.push(row, result);
      } else kids.push(row);
      box.replaceChildren(...kids);
    };
    refresh();
    let last = '';
    extras.push(() => {
      const m = findItem(ed.doc, id)?.item;
      const dev = m?.source ? ed.devices?.deviceFor(m.source) : null;
      const key = JSON.stringify([m?.source, dev?.status, dev?.programComment, dev?.name]);
      if (key !== last) { last = key; refresh(); }
    });
    return section('Link to controller', { open: true, className: 'ed-section-link' }, box);
  }

  function thresholdSection(id) {
    const { item } = bind(id);
    const rows = THRESHOLDS.map(([key, label]) => {
      const input = h('input', { className: 'ed-input ed-num', type: 'text', inputMode: 'numeric', placeholder: 'default', attrs: { 'aria-label': `${label} minutes` } });
      const sync = () => { if (document.activeElement !== input) { const v = item().thresholds?.[key]; input.value = v === null ? 'never' : v === undefined ? '' : String(v); } };
      input.addEventListener('change', () => {
        const t = { ...(item().thresholds ?? {}) };
        const raw = input.value.trim().toLowerCase();
        if (raw === '') delete t[key];
        else if (raw === 'never' || raw === 'off') t[key] = null;
        else if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) <= 100000) t[key] = Number(raw);
        else { sync(); return; }
        ed.apply(updateItem(ed.doc, id, { thresholds: Object.keys(t).length ? t : undefined }), { label: 'Change attention threshold' });
      });
      fields.push({ update: sync });
      return h('label', { className: 'ed-field' }, h('span', { className: 'ed-field-label', text: label }), input);
    });
    return section('Attention after (minutes)', { open: false }, h('p', { className: 'ed-muted', text: 'Leave empty to use the shop defaults; "never" turns the ring off for this machine.' }), h('div', { className: 'ed-grid-3' }, ...rows));
  }

  function objectPanel(f) {
    const id = f.item.id;
    const { item, setter } = bind(id);
    return [
      header(f, f.item.name),
      nameField(id).el,
      add(selectField({ label: 'Kind', name: 'kind', options: opts(OBJECT_KINDS), get: () => item().kind ?? 'generic', set: setter('kind', 'Change kind'), wide: true })).el,
      section('Position and size', { open: true }, ...geometryFields(id)),
      section('Display', { open: true },
        add(checkField({ label: 'Show its name on the plan', get: () => item().showLabel !== false, set: (v) => setter('showLabel', 'Toggle name')(v ? undefined : false) })).el,
        add(checkField({ label: 'Show on the TV', hint: 'Off = editor-only note', get: () => item().hud !== false, set: (v) => setter('hud', 'Toggle TV')(v ? undefined : false) })).el),
      section('Notes', { open: !!f.item.notes }, notesField(id).el),
      actions(f, { convert: 'machines' }),
    ];
  }

  function roomPanel(f) {
    const id = f.item.id;
    const { item, setter } = bind(id);
    const poly = Array.isArray(f.item.points);
    const area = add(readout({ label: 'Area', big: true, get: () => formatArea(itemArea('rooms', item()), u()) }));
    const nodes = [
      header(f, f.item.name),
      nameField(id).el,
      add(selectField({ label: 'Kind', name: 'kind', options: opts(ROOM_KINDS), get: () => item().kind ?? 'other', set: setter('kind', 'Change kind'), wide: true })).el,
      area.el,
    ];
    if (poly) {
      const n = add(readout({ label: 'Shape', get: () => `${item().points?.length ?? 0} corners — drag corners, double-click an edge to add one` }));
      nodes.push(n.el);
    } else {
      const { item: it, setter: set2 } = bind(id);
      const x = add(lengthField({ label: 'X', name: 'x', get: () => it().x, set: set2('x', 'Move'), units: u, step }));
      const y = add(lengthField({ label: 'Y', name: 'y', get: () => it().y, set: set2('y', 'Move'), units: u, step }));
      const w = add(lengthField({ label: 'Width', name: 'w', get: () => it().w, set: set2('w', 'Resize'), units: u, step, min: 0.1 }));
      const hh = add(lengthField({ label: 'Depth', name: 'h', get: () => it().h, set: set2('h', 'Resize'), units: u, step, min: 0.1 }));
      const toPoly = h('button', { type: 'button', className: 'ed-btn ed-btn-small' }, icon('corners'), h('span', { text: 'Make it any shape (L, T…)' }));
      toPoly.addEventListener('click', () => ed.apply(roomToPolygon(ed.doc, id), { label: 'Room to polygon' }));
      nodes.push(section('Position and size', { open: true }, pair(x, y), pair(w, hh), toPoly));
    }
    nodes.push(section('Display', { open: true },
      add(checkField({ label: 'Show the room name', get: () => item().showLabel !== false, set: (v) => setter('showLabel', 'Toggle name')(v ? undefined : false) })).el));
    nodes.push(actions(f));
    return nodes;
  }

  function wallPanel(f) {
    const id = f.item.id;
    const { item, setter } = bind(id);
    const len = add(readout({ label: 'Length', big: true, get: () => formatLength(polylineLength(item().points ?? [], !!item().closed), u()) }));
    return [
      header(f, f.item.label || WALL_STYLES[f.item.style]?.label || 'Wall'),
      add(selectField({ label: 'Style', name: 'style', options: opts(WALL_STYLES), get: () => item().style ?? 'interior', set: (v) => { ed.lastWallStyle = v; ed.apply(updateItem(ed.doc, id, { style: v, thickness: WALL_STYLES[v]?.defaultThickness }), { label: 'Change wall style' }); }, wide: true })).el,
      add(lengthField({ label: 'Thickness', name: 'thickness', get: () => wallThickness(item()), set: setter('thickness', 'Change thickness'), units: u, step: () => 0.05, min: 0.05, max: 20 })).el,
      len.el,
      add(checkField({ label: 'Closed loop (last point joins the first)', get: () => !!item().closed, set: (v) => { if (v && (item().points?.length ?? 0) < 3) { ed.toast('A closed wall needs at least 3 points', { kind: 'error' }); render(); return; } setter('closed', 'Toggle closed')(v ? true : undefined); } })).el,
      add(textField({ label: 'Label along the wall', name: 'label', placeholder: 'Optional', get: () => item().label ?? '', set: (v, o) => setter('label', 'Edit label', { coalesce: true })(v || undefined, o), maxLength: 120 })).el,
      h('p', { className: 'ed-hint-line', text: 'Drag the round handles to move corners. Drag a small + to add a corner, or double-click the wall. Select a corner and press Delete to remove it.' }),
      actions(f),
    ];
  }

  function doorPanel(f) {
    const id = f.item.id;
    const { item, setter } = bind(id);
    const flip = h('button', { type: 'button', className: 'ed-btn ed-btn-small', title: 'Flip the swing (F)' }, icon('flip'), h('span', { text: 'Flip swing' }));
    flip.addEventListener('click', () => ed.cmd('flip'));
    return [
      header(f, f.item.label || DOOR_KINDS[f.item.kind ?? 'door']?.label || 'Door'),
      add(selectField({ label: 'Kind', name: 'kind', options: opts(DOOR_KINDS), get: () => item().kind ?? 'door', set: (v) => ed.apply(updateItem(ed.doc, id, { kind: v, swing: v === 'door' || v === 'double' ? item().swing ?? 'left' : 'none' }), { label: 'Change door kind' }), wide: true })).el,
      add(lengthField({ label: 'Opening width', name: 'width', get: () => item().width, set: (v) => { ed.lastDoorWidth = v; setter('width', 'Resize door')(v); }, units: u, step: () => 0.5, min: 0.5, max: 100, wide: true })).el,
      h('div', { className: 'ed-pair' },
        add(selectField({ label: 'Swing', name: 'swing', options: [['left', 'Left hinge'], ['right', 'Right hinge'], ['none', 'No swing']], get: () => item().swing ?? (['door', 'double'].includes(item().kind ?? 'door') ? 'left' : 'none'), set: setter('swing', 'Change swing') })).el,
        flip),
      section('Position', { open: true },
        pair(add(lengthField({ label: 'X (centre)', name: 'x', get: () => item().x, set: setter('x', 'Move'), units: u, step })), add(lengthField({ label: 'Y (centre)', name: 'y', get: () => item().y, set: setter('y', 'Move'), units: u, step }))),
        add(angleField({ label: 'Rotation', name: 'rotation', get: () => item().rotation ?? 0, set: (v) => setRotation(id, v) })).el,
        h('p', { className: 'ed-hint-line', text: 'Drag a door onto a wall and it lines up with it.' })),
      add(textField({ label: 'Label', name: 'label', placeholder: 'e.g. Main entrance', get: () => item().label ?? '', set: (v, o) => setter('label', 'Edit label', { coalesce: true })(v || undefined, o), maxLength: 120 })).el,
      actions(f),
    ];
  }

  function labelPanel(f) {
    const id = f.item.id;
    const { item, setter } = bind(id);
    return [
      header(f, f.item.text),
      add(textField({ label: 'Text', name: 'text', get: () => item().text, set: (v, o) => { if (!v.trim()) return; setter('text', 'Edit label', { coalesce: true })(v, o); }, maxLength: 200 })).el,
      h('div', { className: 'ed-pair' },
        add(selectField({ label: 'Style', name: 'style', options: opts(LABEL_STYLES), get: () => item().style ?? 'note', set: (v) => ed.apply(updateItem(ed.doc, id, { style: v, size: LABEL_STYLES[v]?.size }), { label: 'Change label style' }) })).el,
        add(lengthField({ label: 'Text height', name: 'size', get: () => labelSize(item()), set: setter('size', 'Resize label'), units: u, step: () => 0.1, min: 0.1, max: 100 })).el),
      section('Position', { open: true },
        pair(add(lengthField({ label: 'X (centre)', name: 'x', get: () => item().x, set: setter('x', 'Move'), units: u, step })), add(lengthField({ label: 'Y (centre)', name: 'y', get: () => item().y, set: setter('y', 'Move'), units: u, step }))),
        add(angleField({ label: 'Rotation', name: 'rotation', get: () => item().rotation ?? 0, set: (v) => setRotation(id, v) })).el),
      add(checkField({ label: 'Show on the TV', hint: 'Off = editor-only note', get: () => item().hud !== false, set: (v) => setter('hud', 'Toggle TV')(v ? undefined : false) })).el,
      actions(f),
    ];
  }

  function multiPanel(sel) {
    const ids = sel.map((f) => f.item.id);
    const btn = (ic, label, fn, k) => {
      const b = h('button', { type: 'button', className: 'ed-btn ed-btn-icon-label', title: k ? `${label} (${kbd(k)})` : label }, icon(ic), h('span', { text: label }));
      b.addEventListener('click', fn);
      return b;
    };
    const align = (mode) => () => ed.cmd('align', mode);
    const allLocked = sel.every((f) => f.item.locked);
    return [
      h('div', { className: 'ed-props-head' }, h('div', { className: 'ed-props-type' }, icon('select'), h('span', { text: 'Selection' })), h('div', { className: 'ed-props-title', text: `${sel.length} items` }), h('div', { className: 'ed-muted', text: describeItems(ed.doc, ids) })),
      section('Align', { open: true }, h('div', { className: 'ed-btn-grid' },
        btn('align-left', 'Left', align('left')), btn('align-hcenter', 'Centre', align('hcenter')), btn('align-right', 'Right', align('right')),
        btn('align-top', 'Top', align('top')), btn('align-vcenter', 'Middle', align('vcenter')), btn('align-bottom', 'Bottom', align('bottom')))),
      section('Distribute evenly', { open: true }, h('div', { className: 'ed-btn-grid ed-btn-grid-2' },
        btn('dist-h', 'Across', () => ed.cmd('distribute', 'x')), btn('dist-v', 'Down', () => ed.cmd('distribute', 'y'))),
      sel.length < 3 ? h('p', { className: 'ed-hint-line', text: 'Select 3 or more items to space them evenly.' }) : null),
      section('Arrange', { open: true }, h('div', { className: 'ed-btn-grid' },
        btn('rotate', 'Rotate 90°', () => ed.cmd('rotate', 90), 'Shift+]'),
        btn(allLocked ? 'unlock' : 'lock', allLocked ? 'Unlock' : 'Lock', () => ed.cmd('lock'), 'Mod+L'),
        btn('duplicate', 'Duplicate', () => ed.cmd('duplicate'), 'Mod+D'),
        btn('trash', 'Delete', () => ed.cmd('delete'), 'Del'))),
    ];
  }

  // ---------------------------------------------------------------------------------------------
  // Nothing selected: the layout, the trace photo and the checklist
  // ---------------------------------------------------------------------------------------------
  function layoutPanel() {
    const d = () => ed.doc;
    const setTop = (key, label, { coalesce = false } = {}) => (v, o = {}) => {
      const next = updateDoc(ed.doc, { [key]: v });
      if (next === ed.doc) return;
      ed.apply(next, { label, coalesceKey: coalesce ? `doc:${key}` : null });
      if (o.final) ed.history.seal();
    };
    const nodes = [];
    nodes.push(checklistCard());
    nodes.push(section('Layout', { open: true },
      add(textField({ label: 'Name', name: 'layout-name', get: () => d().name, set: (v, o) => { if (v.trim()) setTop('name', 'Rename layout', { coalesce: true })(v, o); }, maxLength: 120 })).el,
      pair(
        add(lengthField({ label: 'Drawing width', name: 'width', get: () => d().width, set: setTop('width', 'Resize drawing'), units: u, step, min: 1, max: 5000 })),
        add(lengthField({ label: 'Drawing depth', name: 'height', get: () => d().height, set: setTop('height', 'Resize drawing'), units: u, step, min: 1, max: 5000 }))),
      pair(
        add(selectField({ label: 'Grid / snap step', name: 'grid', options: u() === 'm' ? [[0.05, '5 cm'], [0.1, '10 cm'], [0.25, '25 cm'], [0.5, '50 cm'], [1, '1 m']] : [[0.25, '3"'], [0.5, '6"'], [1, "1'"], [2, "2'"], [5, "5'"]], get: () => d().grid ?? 1, set: (v) => setTop('grid', 'Change grid')(Number(v)) })),
        add(selectField({ label: 'Units', name: 'units', options: [['ft', 'Feet'], ['m', 'Metres']], get: () => d().units ?? 'ft', set: async (v) => {
          if (v === (d().units ?? 'ft')) return;
          const ok = await confirmDialog({ title: 'Change units?', message: 'Numbers keep their values: 88 ft becomes 88 m. Use this only to fix a layout that was started in the wrong unit.', ok: 'Change units' });
          if (ok) setTop('units', 'Change units')(v); else render();
        } }))),
      add(textField({ label: 'Description', name: 'description', multiline: true, maxLength: 2000, placeholder: 'Optional notes about this layout', get: () => d().description ?? '', set: (v, o) => setTop('description', 'Edit description', { coalesce: true })(v || undefined, o) })).el));
    nodes.push(photoPanel(false));
    nodes.push(h('p', { className: 'ed-hint-line ed-center', text: 'Select something on the plan to edit it. Press ? for keyboard shortcuts.' }));
    return nodes;
  }

  function checklistCard() {
    const card = h('div', { className: 'ed-checklist' });
    let last = '';
    const refresh = () => {
      const c = gettingStarted(ed.doc, { dirty: ed.dirty, everSaved: ed.everSaved, live: ed.isLive() });
      const key = JSON.stringify(c.steps.map((st) => [st.done, st.detail]));
      if (key === last) return;
      last = key;
      const head = h('div', { className: 'ed-checklist-head' }, h('span', { className: 'ed-checklist-title', text: c.complete ? 'All set' : 'Getting started' }), h('span', { className: 'ed-checklist-count', text: `${c.done} of ${c.total}` }));
      const bar = h('div', { className: 'ed-progress' }, h('span', { style: { width: `${Math.round((c.done / c.total) * 100)}%` } }));
      const list = h('ol', { className: 'ed-check-steps' }, ...c.steps.map((st) => {
        const li = h('li', { className: `ed-check-step${st.done ? ' done' : ''}${st.optional ? ' optional' : ''}` },
          h('span', { className: 'ed-check-mark' }, st.done ? icon('check') : null),
          h('div', { className: 'ed-check-text' }, h('div', { className: 'ed-check-step-title', text: st.title }), h('div', { className: 'ed-check-detail', text: st.detail })));
        if (!st.done) {
          const go = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-quiet', text: actionLabel(st.action) });
          go.addEventListener('click', () => ed.cmd('checklist', st.action));
          li.append(go);
        }
        return li;
      }));
      card.replaceChildren(head, bar, list);
      card.classList.toggle('complete', c.complete);
    };
    refresh();
    extras.push(refresh);
    return card;
  }

  const actionLabel = (a) => ({ photo: 'Add', wall: 'Draw', room: 'Draw', machine: 'Place', link: 'Link', save: 'Save', live: 'Make live' })[a] ?? 'Go';

  // ---------------------------------------------------------------------------------------------
  // Trace photo
  // ---------------------------------------------------------------------------------------------
  function photoPanel(active) {
    const b = () => ed.doc.background;
    const has = !!b()?.src;
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/*', hidden: true });
    fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) ed.cmd('upload-photo', file); });
    const upload = h('button', { type: 'button', className: `ed-btn ed-btn-small${has ? '' : ' ed-btn-primary'}`, dataset: { action: 'upload-photo' } }, icon('upload'), h('span', { text: has ? 'Replace photo…' : 'Upload a photo…' }));
    upload.addEventListener('click', () => fileInput.click());
    const kids = [fileInput];
    if (!has) {
      kids.push(h('p', { className: 'ed-muted', text: 'A phone photo of a paper sketch or an old drawing. Line it up, then trace walls and machines over it. Location data and camera details are removed before upload.' }), upload);
      return section('Trace photo', { open: true, className: 'ed-section-photo' }, ...kids);
    }
    const setBg = (patch, label, o = {}) => {
      const next = updateDoc(ed.doc, { background: { ...b(), ...patch } });
      if (next !== ed.doc) ed.apply(next, { label, coalesceKey: o.coalesce ? 'photo-opacity' : null });
      if (o.final) ed.history.seal();
    };
    kids.push(add(checkField({ label: 'Show the photo', hint: 'Also shown behind the plan on desktop HUD views (never on TVs)', get: () => b()?.visible === true, set: (v) => setBg({ visible: v }, v ? 'Show photo' : 'Hide photo') })).el);
    kids.push(add(rangeField({ label: 'Opacity', get: () => b()?.opacity ?? 0.35, set: (v, o) => setBg({ opacity: Math.round(v * 100) / 100 }, 'Photo opacity', { coalesce: true, final: o.final }) })).el);
    if (!active) {
      const adjust = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-primary', dataset: { action: 'fit-photo' } }, icon('photo'), h('span', { text: 'Fit photo…' }));
      adjust.addEventListener('click', () => ed.setTool('photo'));
      kids.push(h('div', { className: 'ed-actions' }, adjust, upload));
      return section('Trace photo', { open: true, className: 'ed-section-photo' }, ...kids);
    }
    // photo tool active: fitting modes
    const modes = h('div', { className: 'ed-seg', attrs: { role: 'radiogroup', 'aria-label': 'Fit mode' } });
    for (const [id, label, ic] of [['move', 'Move & scale', 'move'], ['corners', '4 corners', 'corners'], ['calibrate', '2 points', 'ruler']]) {
      const m = h('button', { type: 'button', className: 'ed-seg-btn', attrs: { role: 'radio', 'aria-checked': String((ed.photoMode ?? 'move') === id) } }, icon(ic), h('span', { text: label }));
      m.addEventListener('click', () => { ed.photoMode = id; ed.calibration = []; ed.emit('photo-mode', id); ed.invalidate('overlay'); render(); });
      modes.append(m);
    }
    const help = {
      move: 'Drag the photo to move it, a corner to scale it, the round knob to turn it (Shift: free angle).',
      corners: 'Drag each corner of the photo onto the matching corner of your building. This straightens photos taken at an angle.',
      calibrate: 'Click two points on the photo whose real distance you know (for example both ends of a wall), then type that distance.',
    }[ed.photoMode ?? 'move'];
    const head = h('div', { className: 'ed-props-head' }, h('div', { className: 'ed-props-type' }, icon('photo'), h('span', { text: 'Trace photo' })), h('div', { className: 'ed-props-title', text: 'Fit the photo' }));
    const nodes = [head, modes, h('p', { className: 'ed-hint-line', text: help })];
    if (ed.photoMode === 'calibrate') nodes.push(calibrationBox());
    const reset = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-quiet' }, h('span', { text: 'Undo the 4-corner fit' }));
    reset.addEventListener('click', () => {
      const r = rectFromCorners(ed.photoCorners());
      const { corners, ...rest } = b();
      void corners;
      ed.apply(updateDoc(ed.doc, { background: { ...rest, x: r.x, y: r.y, width: r.width, height: r.height, ...(r.rotation ? { rotation: r.rotation } : { rotation: undefined }) } }), { label: 'Reset photo fit' });
    });
    if (Array.isArray(b()?.corners)) nodes.push(reset);
    const remove = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-danger-quiet' }, icon('trash'), h('span', { text: 'Remove photo' }));
    remove.addEventListener('click', () => { ed.apply(updateDoc(ed.doc, { background: undefined }), { label: 'Remove photo' }); ed.setTool('select'); });
    const done = h('button', { type: 'button', className: 'ed-btn ed-btn-primary', dataset: { action: 'photo-done' } }, icon('done'), h('span', { text: 'Done fitting' }));
    done.addEventListener('click', () => ed.setTool('select'));
    nodes.push(section('Photo', { open: true }, ...kids), h('div', { className: 'ed-actions' }, done, upload, remove));
    return nodes;
  }

  function calibrationBox() {
    const box = h('div', { className: 'ed-calib' });
    const refresh = () => {
      const pins = ed.calibration ?? [];
      if (pins.length < 2) {
        box.replaceChildren(h('p', { className: 'ed-callout', text: pins.length ? 'Now click the second point (B).' : 'Click the first point (A) on the photo.' }));
        return;
      }
      const cur = Math.hypot(pins[1][0] - pins[0][0], pins[1][1] - pins[0][1]);
      const input = h('input', { className: 'ed-input ed-num', type: 'text', placeholder: "e.g. 88' or 26.8m", attrs: { 'aria-label': 'Real distance' }, dataset: { field: 'calibrate' } });
      const apply = h('button', { type: 'button', className: 'ed-btn ed-btn-primary ed-btn-small', text: 'Scale photo' });
      const go = () => {
        const real = parseLength(input.value, u());
        if (!real || real <= 0) { input.classList.add('ed-invalid'); input.focus(); return; }
        const k = real / cur;
        const corners = ed.photoCorners().map((c) => scaleAbout(c, pins[0], k).map(round4));
        ed.apply(ed.setPhoto(ed.doc, corners, Array.isArray(ed.doc.background?.corners)), { label: 'Calibrate photo scale' });
        ed.calibration = [];
        ed.photoMode = 'move';
        ed.toast(`Photo scaled ×${Math.round(k * 1000) / 1000} — now drag it into place`, { kind: 'ok' });
        render();
      };
      apply.addEventListener('click', go);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
      box.replaceChildren(
        h('p', { className: 'ed-muted', text: `A to B on the photo is ${formatLength(cur, u())} right now. Its real length is:` }),
        h('div', { className: 'ed-row' }, input, apply));
      setTimeout(() => input.focus(), 0);
    };
    refresh();
    const off = ed.on('calibration', refresh);
    extras.push(() => { if (!box.isConnected) off(); });
    return box;
  }

  /** Focus a named field of the current panel (after placing an item or double-clicking it). */
  function focusField(name) {
    render();
    const el = body.querySelector(`[data-field="${name}"]`);
    if (el) { el.focus(); el.select?.(); el.scrollIntoView?.({ block: 'nearest' }); }
  }

  return { render, update, focusField, element: body };
}

/** Upload flow used by the panel, the checklist and drag-and-drop of a file onto the canvas. */
export async function uploadPhoto(ed, file) {
  try {
    ed.setBusyText('Preparing the photo…');
    const prepared = await prepareImage(file);
    ed.setBusyText('Uploading the photo…');
    const r = await uploadImage(ed.api, prepared, { requestToken: (reason) => ed.requestToken(reason), localEdit: ed.ctx?.getState?.()?.localEdit === true });
    const prev = ed.doc.background;
    const place = prev?.src ? { x: prev.x, y: prev.y, width: prev.width, height: prev.width * (r.height / r.width) } : initialPlacement(ed.doc, r.width, r.height);
    const bg = { src: r.src, ...place, opacity: prev?.opacity ?? 0.5, visible: true };
    ed.apply(updateDoc(ed.doc, { background: bg }), { label: prev?.src ? 'Replace photo' : 'Add photo' });
    ed.setTool('photo');
    ed.toast(r.existed ? 'Photo already on the server — reused' : 'Photo uploaded. Now line it up with the plan.', { kind: 'ok' });
  } catch (e) {
    if (!e?.cancelled) ed.toast(e.message || 'Upload failed', { kind: 'error' });
  } finally {
    ed.setBusyText(null);
  }
}

