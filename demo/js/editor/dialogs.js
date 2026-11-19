// Modal dialogs for the editor: generic, confirm, prompt, edit token (DECISIONS D9), save conflict (D5/D10) and the
// keyboard shortcut sheet. Built on <dialog>.showModal() (focus trap + Esc); text via textContent only.
import { h, icon, kbd } from './dom.js';
import { isWindowsKit, kitFolder } from '../tokenHelp.js';

/**
 * Open a modal dialog. Resolves with the clicked action's value, or null when dismissed.
 * @param {{ title: string, icon?: string, body?: Node|Node[]|string, actions?: {label: string, value: any, primary?: boolean,
 *           danger?: boolean, icon?: string}[], className?: string, dismissible?: boolean, onOpen?: (dlg: HTMLDialogElement, close: Function) => void,
 *           form?: (close: Function) => void }} o
 * @returns {Promise<any>}
 */
export function openDialog({ title, icon: ic, body, actions = [{ label: 'OK', value: true, primary: true }], className = '', dismissible = true, onOpen }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { className: `ed-dialog ${className}`.trim() });
    const head = h('header', { className: 'ed-dialog-head' }, ic ? icon(ic) : null, h('h2', { text: title }));
    const content = h('div', { className: 'ed-dialog-body' });
    if (typeof body === 'string') content.append(h('p', { text: body }));
    else if (Array.isArray(body)) content.append(...body.filter(Boolean));
    else if (body) content.append(body);
    const foot = h('footer', { className: 'ed-dialog-actions' });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* closed */ }
      dlg.remove();
      resolve(value);
    };
    for (const a of actions) {
      const b = h('button', { type: 'button', className: `ed-btn${a.primary ? ' ed-btn-primary' : ''}${a.danger ? ' ed-btn-danger' : ''}` });
      if (a.icon) b.append(icon(a.icon));
      b.append(h('span', { text: a.label }));
      b.addEventListener('click', () => close(typeof a.value === 'function' ? a.value() : a.value));
      if (a.id) b.dataset.action = a.id;
      foot.append(b);
    }
    dlg.append(head, content, foot);
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); if (dismissible) close(null); });
    if (dismissible) {
      dlg.addEventListener('pointerdown', (ev) => { if (ev.target === dlg) { const r = dlg.getBoundingClientRect(); if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close(null); } });
    }
    document.body.append(dlg);
    dlg.showModal();
    const primary = foot.querySelector('.ed-btn-primary');
    onOpen?.(dlg, close);
    if (!dlg.contains(document.activeElement) || document.activeElement === dlg) primary?.focus();
  });
}

/** Yes/no question. Resolves true/false. */
export async function confirmDialog({ title, message, ok = 'OK', cancel = 'Cancel', danger = false, icon: ic = danger ? 'warning' : 'help' }) {
  const body = Array.isArray(message) ? message.map((m) => (typeof m === 'string' ? h('p', { text: m }) : m)) : h('p', { text: message });
  const r = await openDialog({ title, icon: ic, body, actions: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }] });
  return r === true;
}

/**
 * Ask for a value. `parse(text)` returns { value } or { error }. Resolves the value or null.
 * @param {{ title: string, label: string, value?: string, placeholder?: string, hint?: string, ok?: string, parse?: (t: string) => ({value?: any, error?: string}) }} o
 */
export function promptDialog({ title, label, value = '', placeholder = '', hint = '', ok = 'OK', parse = (t) => ({ value: t }), icon: ic }) {
  const input = h('input', { className: 'ed-input', type: 'text', value, placeholder, spellcheck: false, autocomplete: 'off' });
  const err = h('p', { className: 'ed-field-error', attrs: { role: 'alert' } });
  const field = h('label', { className: 'ed-field' }, h('span', { className: 'ed-field-label', text: label }), input);
  let result = null;
  const check = () => {
    const r = parse(input.value);
    err.textContent = r.error ?? '';
    result = r.error ? null : r.value;
    return !r.error;
  };
  return openDialog({
    title, icon: ic,
    body: [field, hint ? h('p', { className: 'ed-muted', text: hint }) : null, err],
    actions: [{ label: 'Cancel', value: null }, { label: ok, value: () => (check() ? { ok: result } : { retry: true }), primary: true }],
    onOpen(dlg, close) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (check()) close({ ok: result }); } });
      // keep the dialog open while the input is invalid
      dlg.querySelector('.ed-btn-primary')?.addEventListener('click', (ev) => { if (!check()) { ev.stopImmediatePropagation(); input.focus(); } }, { capture: true });
    },
  }).then((r) => (r && typeof r === 'object' && 'ok' in r ? r.ok : null));
}

/**
 * Edit token prompt (DECISIONS D9) explaining where the token lives. Verifies the token with the server before
 * accepting it. Resolves { token, remember } or null.
 * @param {{ api: object, reason?: string, help?: object|null }} o  help: GET /api/state tokenHelp (kit or npm)
 */
export function tokenDialog({ api, reason = '', help = null }) {
  const input = h('input', { className: 'ed-input ed-mono', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Paste the edit token', attrs: { 'aria-label': 'Edit token' } });
  const show = h('button', { type: 'button', className: 'ed-btn ed-btn-quiet ed-btn-small', text: 'Show' });
  show.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? 'Show' : 'Hide'; });
  const remember = h('input', { type: 'checkbox' });
  const err = h('p', { className: 'ed-field-error', attrs: { role: 'alert' } });
  const code = (t) => h('code', { className: 'ed-code', text: t });
  const body = [
    reason ? h('p', { className: 'ed-callout', text: reason }) : null,
    h('p', { text: 'Saving the floor plan, uploading photos and testing connections need the HUD’s edit token — a long secret the server creates the first time it starts.' }),
    isWindowsKit(help)
      ? h('ol', { className: 'ed-steps' },
        h('li', {}, 'On the computer that runs the HUD, open the folder ', code(kitFolder(help)), '.'),
        h('li', {}, 'Double-click “Show edit token”.'),
        h('li', {}, 'Copy the token it shows and paste it here.'))
      : h('ol', { className: 'ed-steps' },
        h('li', {}, 'On the computer that runs the HUD server, open a terminal in the Machine Shop HUD folder.'),
        h('li', {}, 'Run ', code('npm run token'), ' (for the demo: ', code('npm run token -- --config config/settings.demo.json'), ').'),
        h('li', {}, 'Copy the printed token and paste it here.')),
    h('p', { className: 'ed-muted', text: isWindowsKit(help)
      ? 'The black HUD window also shows the token the first time it starts. This browser keeps it only for this tab unless you tick “Remember on this device”.'
      : 'The token is stored in the server’s data folder (file "edit-token") or set with the SHOP_HUD_EDIT_TOKEN environment variable. This browser keeps it only for this tab unless you tick “Remember on this device”.' }),
    h('div', { className: 'ed-token-row' }, input, show),
    h('label', { className: 'ed-check' }, remember, h('span', { text: 'Remember on this device' })),
    err,
  ];
  let verified = null;
  return openDialog({
    title: 'Edit token required', icon: 'key', className: 'ed-dialog-token', body,
    actions: [{ label: 'Cancel', value: null }, { label: 'Use token', value: () => verified, primary: true, id: 'use-token' }],
    onOpen(dlg, close) {
      input.focus();
      const ok = dlg.querySelector('[data-action="use-token"]');
      const submit = async (ev) => {
        ev?.preventDefault();
        ev?.stopImmediatePropagation();
        const t = input.value.trim();
        if (!t) { err.textContent = 'Paste the token first.'; input.focus(); return; }
        ok.disabled = true;
        err.textContent = '';
        try {
          const r = await api.fetchJson('/api/settings', { headers: { Authorization: `Bearer ${t}` }, timeoutMs: 8000 });
          // tokenValid (servers since D14); older servers: editable only comes back for a valid token
          if (r && typeof r === 'object' && (r.tokenValid === true || (r.tokenValid === undefined && 'editable' in r))) {
            verified = { token: t, remember: remember.checked };
            close(verified);
            return;
          }
          err.textContent = isWindowsKit(help)
            ? 'The server did not accept this token. Check for missing characters, or show it again with “Show edit token”.'
            : 'The server did not accept this token. Check for missing characters, or print it again with npm run token.';
        } catch (e) {
          err.textContent = `Could not check the token: ${e.message}`;
        } finally {
          ok.disabled = false;
        }
        input.focus();
        input.select();
      };
      ok.addEventListener('click', submit, { capture: true });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(ev); });
    },
  });
}

/**
 * Save conflict (412/409): someone else changed the layout since it was loaded.
 * Resolves 'reload' | 'overwrite' | 'copy' | null.
 * @param {{ updatedAt?: number|null, name?: string }} o
 */
export function conflictDialog({ updatedAt = null, name = 'this layout' } = {}) {
  const t = Number.isFinite(updatedAt) ? new Date(updatedAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  return openDialog({
    title: 'Layout changed elsewhere', icon: 'warning', className: 'ed-dialog-conflict',
    body: [
      h('p', { text: `${name} was saved by someone else${t ? ` (${t})` : ''} or edited on disk after you opened it. Saving now would replace their changes.` }),
      h('ul', { className: 'ed-choices' },
        h('li', {}, h('strong', { text: 'Load their version' }), ' — your changes stay in Undo, so you can step back to them.'),
        h('li', {}, h('strong', { text: 'Save mine as a copy' }), ' — keeps both: yours becomes a new layout.'),
        h('li', {}, h('strong', { text: 'Overwrite' }), ' — replace their version with yours (theirs stays in the version history).')),
    ],
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Save mine as a copy', value: 'copy' },
      { label: 'Overwrite', value: 'overwrite', danger: true, id: 'overwrite' },
      { label: 'Load their version', value: 'reload', primary: true, id: 'reload' },
    ],
  });
}

const SHORTCUTS = [
  ['Tools', [
    ['V', 'Select / move'], ['H or Space-drag', 'Pan'], ['W', 'Draw walls'], ['R', 'Room (drag a rectangle or click points)'], ['D', 'Door'],
    ['T', 'Label'], ['O', 'Object'], ['M', 'Machine'], ['P', 'Trace photo'], ['Esc', 'Back to Select / cancel'],
  ]],
  ['Edit', [
    ['Mod+Z', 'Undo'], ['Mod+Shift+Z / Mod+Y', 'Redo'], ['Mod+D', 'Duplicate'], ['Alt-drag', 'Drag a copy'], ['Mod+C / Mod+X / Mod+V', 'Copy / cut / paste'],
    ['Delete', 'Delete selection (or the selected wall point)'], ['Mod+A', 'Select all'], ['Mod+L', 'Lock / unlock'], ['F', 'Flip door swing'],
    ['[ / ]', 'Rotate −15° / +15° (Shift: 90°)'], ['Mod+S', 'Save'],
  ]],
  ['Move and size', [
    ['Arrows', 'Nudge by one grid step'], ['Shift+Arrows', 'Nudge ×10'], ['Alt+Arrows', 'Nudge 0.1 ft'], ['Shift while dragging', 'Straight lines / keep proportions / free rotation'],
    ['Alt while dragging', 'No snapping'], ['Double-click a wall', 'Add a point'], ['Enter / double-click', 'Finish a wall or room'],
  ]],
  ['View', [
    ['Wheel / pinch', 'Zoom'], ['Space-drag / middle-drag / two fingers', 'Pan'], ['Shift+1 or 0', 'Fit to screen'], ['+ / −', 'Zoom in / out'],
    ['G', 'Show / hide grid'], ['S', 'Snapping on / off'], ['?', 'This sheet'],
  ]],
];

/** Keyboard shortcut sheet ('?'). */
export function shortcutsDialog() {
  const cols = SHORTCUTS.map(([group, rows]) => h('section', { className: 'ed-keys-group' },
    h('h3', { text: group }),
    h('dl', { className: 'ed-keys' }, ...rows.flatMap(([k, what]) => [h('dt', {}, ...k.split(' / ').flatMap((part, i) => [i ? ' / ' : null, h('kbd', { text: kbd(part) })])), h('dd', { text: what })]))));
  return openDialog({ title: 'Keyboard shortcuts', icon: 'help', className: 'ed-dialog-wide', body: h('div', { className: 'ed-keys-grid' }, ...cols), actions: [{ label: 'Close', value: true, primary: true }] });
}
