// Layers panel (DECISIONS D5): show/hide and lock each layer (editor view state, remembered on this device), lock
// single items (saved in the layout as `locked`), and pick items from a list — the way to reach locked items.
import { h, icon } from './dom.js';
import { setLocked } from './ops.js';

const LAYERS = [
  ['machines', 'Machines', 'machine'], ['labels', 'Labels', 'label'], ['objects', 'Objects', 'object'],
  ['doors', 'Doors', 'door'], ['walls', 'Walls', 'wall'], ['rooms', 'Rooms', 'room'],
];

/**
 * @param {object} ed
 * @param {HTMLElement} container
 */
export function createLayers(ed, container) {
  const open = new Set(['machines']);
  const list = h('div', { className: 'ed-layers' });
  container.append(h('div', { className: 'ed-panel-head' }, h('p', { className: 'ed-panel-intro', text: 'Hide or lock whole layers while you work (only on this device). Lock single items to keep them from moving — that is saved with the layout.' })), list);

  const itemName = (coll, it) => (coll === 'labels' ? it.text : coll === 'walls' ? it.label || `${it.style ?? 'interior'} wall` : coll === 'doors' ? it.label || it.kind || 'door' : it.name) || it.id;

  function toggleBtn(on, icOn, icOff, labelOn, labelOff, fn) {
    const b = h('button', { type: 'button', className: `ed-icon-btn${on ? '' : ' off'}`, title: on ? labelOn : labelOff, attrs: { 'aria-pressed': String(!on), 'aria-label': on ? labelOn : labelOff } }, icon(on ? icOn : icOff));
    b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    return b;
  }

  function render() {
    const rows = [];
    // trace photo
    const bg = ed.doc.background;
    if (bg?.src) {
      const visible = bg.visible === true;
      rows.push(h('div', { className: `ed-layer${visible ? '' : ' is-hidden'}` },
        h('span'),
        h('span', { className: 'ed-layer-icon' }, icon('photo')),
        h('span', { className: 'ed-layer-name', text: 'Trace photo' }),
        h('span'),
        toggleBtn(visible, 'eye', 'eye-off', 'Hide the photo', 'Show the photo', () => ed.apply({ ...ed.doc, background: { ...bg, visible: !visible } }, { label: visible ? 'Hide photo' : 'Show photo' })),
        toggleBtn(!ed.layerLocked('background'), 'unlock', 'lock', 'Lock the photo', 'Unlock the photo', () => ed.setLayer('background', { locked: !ed.layerLocked('background') }))));
    }
    for (const [coll, label, ic] of LAYERS) {
      const items = (ed.doc[coll] ?? []).filter(Boolean);
      const hidden = ed.layerHidden(coll), locked = ed.layerLocked(coll);
      const expanded = open.has(coll);
      const head = h('div', { className: `ed-layer${hidden ? ' is-hidden' : ''}${locked ? ' is-locked' : ''}` },
        h('button', { type: 'button', className: `ed-layer-expand${expanded ? ' open' : ''}`, attrs: { 'aria-expanded': String(expanded), 'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${label}` } }, icon('chevron')),
        h('span', { className: 'ed-layer-icon' }, icon(ic)),
        h('span', { className: 'ed-layer-name', text: label }),
        h('span', { className: 'ed-layer-count', text: String(items.length) }),
        toggleBtn(!hidden, 'eye', 'eye-off', `Hide ${label.toLowerCase()}`, `Show ${label.toLowerCase()}`, () => ed.setLayer(coll, { hidden: !hidden })),
        toggleBtn(!locked, 'unlock', 'lock', `Lock ${label.toLowerCase()}`, `Unlock ${label.toLowerCase()}`, () => ed.setLayer(coll, { locked: !locked })));
      head.querySelector('.ed-layer-expand').addEventListener('click', () => { if (expanded) open.delete(coll); else open.add(coll); render(); });
      rows.push(head);
      if (expanded) {
        const ul = h('ul', { className: 'ed-layer-items' });
        for (const it of items) {
          const selected = ed.selection.includes(it.id);
          const li = h('li', { className: `ed-layer-item${selected ? ' selected' : ''}${it.locked ? ' is-locked' : ''}` },
            h('button', { type: 'button', className: 'ed-layer-pick', text: itemName(coll, it), title: `Select ${itemName(coll, it)}` }),
            coll === 'machines' ? h('span', { className: `ed-dot${it.source ? ' linked' : ''}`, title: it.source ? 'Linked' : 'Not linked' }) : null,
            toggleBtn(!it.locked, 'unlock', 'lock', 'Lock this item', 'Unlock this item', () => ed.apply(setLocked(ed.doc, [it.id], !it.locked), { label: it.locked ? 'Unlock' : 'Lock' })));
          li.querySelector('.ed-layer-pick').addEventListener('click', (ev) => {
            ed.select([it.id], ev.shiftKey ? 'toggle' : 'replace', { force: true });
            ed.revealSelection();
          });
          ul.append(li);
        }
        if (!items.length) ul.append(h('li', { className: 'ed-empty', text: 'None yet' }));
        rows.push(ul);
      }
    }
    list.replaceChildren(...rows);
  }

  return { render };
}

