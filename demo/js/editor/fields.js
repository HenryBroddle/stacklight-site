// Form fields for the Properties panel. Each field reads its value through get() and writes through set(value);
// update() refreshes it from the document unless the person is typing in it. Length fields accept 8'6", 8.5,
// 102in, 2.5m … (units.js) and show what they understood; Arrow Up/Down step by the grid (Shift ×10).
import { h } from './dom.js';
import { parseLength, parseAngle, formatLengthInput, formatLength } from './units.js';

let uid = 0;
const nextId = (p) => `ed-f-${p}-${++uid}`;

function wrap(label, control, { hint, wide = false, className = '' } = {}) {
  const id = control.id || nextId('c');
  control.id = id;
  const lab = h('label', { className: 'ed-field-label', htmlFor: id, text: label });
  const hintEl = hint ? h('span', { className: 'ed-field-hint', text: hint }) : null;
  return h('div', { className: `ed-field${wide ? ' ed-field-wide' : ''} ${className}`.trim() }, lab, control, hintEl);
}

/**
 * Text field. `live` commits on every keystroke (coalesced into one undo step by the caller's key).
 * @param {{ label: string, get: () => string, set: (v: string, o: {final: boolean}) => void, placeholder?: string,
 *           multiline?: boolean, maxLength?: number, hint?: string, wide?: boolean, mono?: boolean }} o
 */
export function textField({ label, get, set, placeholder = '', multiline = false, maxLength = 200, hint, wide = true, mono = false, name }) {
  const input = multiline
    ? h('textarea', { className: 'ed-input ed-textarea', rows: 3, placeholder, maxLength, spellcheck: true })
    : h('input', { className: `ed-input${mono ? ' ed-mono' : ''}`, type: 'text', placeholder, maxLength, spellcheck: false, autocomplete: 'off' });
  if (name) input.dataset.field = name;
  input.addEventListener('input', () => set(input.value, { final: false }));
  input.addEventListener('change', () => set(input.value, { final: true }));
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !multiline) input.blur(); if (ev.key === 'Escape') input.blur(); });
  const el = wrap(label, input, { hint, wide });
  return {
    el, input,
    update() { if (document.activeElement !== input) input.value = get() ?? ''; },
    focus(select = true) { input.focus(); if (select) input.select(); },
  };
}

/**
 * Length field (layout units).
 * @param {{ label: string, get: () => number, set: (v: number) => void, units: () => string, step?: () => number,
 *           min?: number, max?: number, hint?: string, wide?: boolean, name?: string }} o
 */
export function lengthField({ label, get, set, units, step = () => 1, min = -Infinity, max = Infinity, hint, wide = false, name }) {
  const input = h('input', { className: 'ed-input ed-num', type: 'text', inputMode: 'decimal', spellcheck: false, autocomplete: 'off' });
  if (name) input.dataset.field = name;
  const echo = h('span', { className: 'ed-field-echo', attrs: { 'aria-live': 'polite' } });
  const el = wrap(label, input, { hint, wide, className: 'ed-field-length' });
  el.append(echo);
  const show = () => { input.value = Number.isFinite(get()) ? formatLengthInput(get(), units()) : ''; };
  const commit = () => {
    const v = parseLength(input.value, units());
    if (v === null) { echo.textContent = 'Not a length'; el.classList.add('ed-invalid'); return false; }
    if (v < min || v > max) { echo.textContent = v < min ? `At least ${formatLength(min, units())}` : `At most ${formatLength(max, units())}`; el.classList.add('ed-invalid'); return false; }
    el.classList.remove('ed-invalid');
    echo.textContent = '';
    if (Math.abs(v - get()) > 1e-9) set(Math.round(v * 10000) / 10000);
    show();
    return true;
  };
  input.addEventListener('input', () => {
    const v = parseLength(input.value, units());
    el.classList.toggle('ed-invalid', v === null && input.value.trim() !== '');
    echo.textContent = v === null ? (input.value.trim() ? 'Try 8\'6", 8.5 or 102in' : '') : `= ${formatLength(v, units())}`;
  });
  input.addEventListener('change', () => { if (!commit()) setTimeout(() => { if (document.activeElement !== input) { show(); el.classList.remove('ed-invalid'); echo.textContent = ''; } }, 1500); });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => { if (!el.classList.contains('ed-invalid')) echo.textContent = ''; });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); if (commit()) input.blur(); }
    else if (ev.key === 'Escape') { show(); echo.textContent = ''; el.classList.remove('ed-invalid'); input.blur(); }
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const cur = parseLength(input.value, units()) ?? get();
      const d = (ev.key === 'ArrowUp' ? 1 : -1) * step() * (ev.shiftKey ? 10 : 1);
      const v = Math.min(max, Math.max(min, Math.round((cur + d) * 10000) / 10000));
      set(v);
      input.value = formatLengthInput(v, units());
      input.select();
    }
  });
  return { el, input, update() { if (document.activeElement !== input) show(); }, focus() { input.focus(); input.select(); } };
}

/** Angle field in degrees (normalized by the caller). */
export function angleField({ label, get, set, hint, name }) {
  const input = h('input', { className: 'ed-input ed-num', type: 'text', inputMode: 'decimal', spellcheck: false, autocomplete: 'off' });
  if (name) input.dataset.field = name;
  const el = wrap(label, input, { hint, className: 'ed-field-angle' });
  el.append(h('span', { className: 'ed-field-unit', text: '°' }));
  const show = () => { const v = get(); input.value = Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0'; };
  const commit = () => {
    const v = parseAngle(input.value);
    if (v === null) { el.classList.add('ed-invalid'); return; }
    el.classList.remove('ed-invalid');
    if (Math.abs(v - get()) > 1e-9) set(v);
    show();
  };
  input.addEventListener('change', commit);
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); input.blur(); }
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const v = (parseAngle(input.value) ?? get()) + (ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 15 : 1);
      set(v);
      show();
      input.select();
    }
  });
  return { el, input, update() { if (document.activeElement !== input) show(); }, focus() { input.focus(); } };
}

/**
 * Select field. options = [[value, label], …]; unknown current values are shown as an extra option.
 */
export function selectField({ label, options, get, set, wide = false, hint, name }) {
  const sel = h('select', { className: 'ed-input ed-select' });
  if (name) sel.dataset.field = name;
  const fill = () => {
    const cur = get();
    const opts = [...options];
    if (cur !== undefined && cur !== null && !opts.some(([v]) => v === cur)) opts.push([cur, String(cur)]);
    sel.replaceChildren(...opts.map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = cur ?? '';
  };
  fill();
  sel.addEventListener('change', () => set(sel.value));
  return { el: wrap(label, sel, { wide, hint }), input: sel, update() { if (document.activeElement !== sel) fill(); } };
}

/** Checkbox. */
export function checkField({ label, get, set, hint, name }) {
  const box = h('input', { type: 'checkbox' });
  if (name) box.dataset.field = name;
  box.addEventListener('change', () => set(box.checked));
  const el = h('label', { className: 'ed-check' }, box, h('span', { text: label }), hint ? h('span', { className: 'ed-field-hint', text: hint }) : null);
  return { el, input: box, update() { box.checked = !!get(); } };
}

/** Range slider 0–1 shown as a percentage. */
export function rangeField({ label, get, set, min = 0, max = 1, step = 0.05, format = (v) => `${Math.round(v * 100)}%` }) {
  const input = h('input', { type: 'range', className: 'ed-range', min, max, step });
  const out = h('output', { className: 'ed-range-out' });
  input.addEventListener('input', () => { out.textContent = format(Number(input.value)); set(Number(input.value), { final: false }); });
  input.addEventListener('change', () => set(Number(input.value), { final: true }));
  const el = wrap(label, input, { wide: true, className: 'ed-field-range' });
  el.append(out);
  return { el, input, update() { if (document.activeElement !== input) { input.value = String(get()); out.textContent = format(get()); } } };
}

/** Read-only value. */
export function readout({ label, get, big = false }) {
  const v = h('div', { className: big ? 'ed-readout ed-readout-big' : 'ed-readout' });
  const el = h('div', { className: 'ed-field ed-field-wide' }, h('span', { className: 'ed-field-label', text: label }), v);
  return { el, update() { v.textContent = get() ?? '—'; } };
}

/** Collapsible section with a heading. */
export function section(title, { open = true, className = '', badge } = {}, ...children) {
  const body = h('div', { className: 'ed-section-body' }, ...children);
  const head = h('summary', { className: 'ed-section-head' }, h('span', { text: title }), badge ? h('span', { className: 'ed-badge', text: badge }) : null);
  const d = h('details', { className: `ed-section ${className}`.trim(), open }, head, body);
  return d;
}

/** Two fields side by side. */
export const pair = (a, b) => h('div', { className: 'ed-pair' }, a.el ?? a, b.el ?? b);
