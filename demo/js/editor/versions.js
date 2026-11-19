// History panel: this session's undo steps and the server's saved versions (GET /api/layouts/:id/versions).
// Restoring loads the old version into the editor as one undoable change; Save then makes it current (the version
// it replaces is backed up by the server, so nothing is lost).
import { h, icon, when } from './dom.js';
import { confirmDialog } from './dialogs.js';

const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/**
 * @param {object} ed
 * @param {HTMLElement} container
 */
export function createVersions(ed, container) {
  let versions = null;
  let error = null;
  let loading = false;
  const session = h('ol', { className: 'ed-history' });
  const saved = h('ul', { className: 'ed-versions' });
  const reload = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-quiet', title: 'Reload versions' }, icon('refresh'), h('span', { className: 'ed-sr', text: 'Reload' }));
  reload.addEventListener('click', () => load());
  container.append(
    h('section', { className: 'ed-hist-block' }, h('h3', { className: 'ed-h3', text: 'This session' }), h('p', { className: 'ed-panel-intro', text: 'Every change can be undone (Ctrl/⌘+Z), up to 500 steps.' }), session),
    h('section', { className: 'ed-hist-block' }, h('div', { className: 'ed-row ed-row-between' }, h('h3', { className: 'ed-h3', text: 'Saved versions' }), reload),
      h('p', { className: 'ed-panel-intro', text: 'The server keeps the last 50 saved versions of this layout.' }), saved),
  );

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const r = await ed.api.layouts.versions(ed.layoutId);
      versions = Array.isArray(r?.versions) ? r.versions : [];
      error = null;
    } catch (e) {
      error = e?.status === 404 ? null : e.message;
      versions = versions ?? [];
    } finally {
      loading = false;
    }
    render();
  }

  function renderSession() {
    const steps = ed.history.labels(30);
    const kids = steps.map((s, i) => h('li', { className: i === 0 ? 'latest' : '' }, h('span', { text: s.label }), h('time', { text: when(s.time) })));
    kids.push(h('li', { className: 'origin' }, h('span', { text: ed.everSaved ? 'Opened the layout' : 'New layout' })));
    if (ed.history.canRedo) kids.unshift(h('li', { className: 'redo' }, h('span', { text: `Redo available: ${ed.history.redoLabel}` })));
    session.replaceChildren(...kids);
  }

  function render() {
    renderSession();
    if (!versions) { saved.replaceChildren(h('li', { className: 'ed-empty', text: 'Loading…' })); return; }
    if (error) { saved.replaceChildren(h('li', { className: 'ed-empty', text: `Could not load versions: ${error}` })); return; }
    if (!versions.length) { saved.replaceChildren(h('li', { className: 'ed-empty', text: 'No earlier versions yet — they appear after the first save.' })); return; }
    saved.replaceChildren(...versions.map((v) => {
      const li = h('li', { className: `ed-version${v.deleted ? ' deleted' : ''}` },
        icon('clock'),
        h('div', { className: 'ed-version-text' }, h('div', { className: 'ed-version-when', text: when(v.savedAt) }), h('div', { className: 'ed-muted', text: `${v.deleted ? 'Deleted copy · ' : ''}${kb(v.bytes ?? 0)} · ${String(v.hash ?? '').slice(0, 7)}` })));
      const btn = h('button', { type: 'button', className: 'ed-btn ed-btn-small', text: 'Restore…' });
      btn.addEventListener('click', () => restore(v));
      li.append(btn);
      return li;
    }));
  }

  async function restore(v) {
    const ok = await confirmDialog({
      title: 'Restore this version?',
      message: [`The layout as saved ${when(v.savedAt)} replaces the drawing in the editor.`, 'Check it, then Save to make it the current version. Undo brings back what you have now.'],
      ok: 'Load this version',
    });
    if (!ok) return;
    try {
      const r = await ed.api.fetchJson(`/api/layouts/${encodeURIComponent(ed.layoutId)}/versions/${encodeURIComponent(v.version)}`);
      const layout = r?.layout;
      if (!layout || typeof layout !== 'object') throw new Error('empty version');
      ed.apply({ ...layout, id: ed.layoutId }, { label: `Restore version from ${when(v.savedAt)}`, select: [] });
      if (r.valid === false) ed.toast('That version has problems under today’s rules — fix them before saving', { kind: 'error' });
      else ed.toast('Version loaded — Save to make it current', { kind: 'ok' });
    } catch (e) {
      ed.toast(`Could not load that version: ${e.message}`, { kind: 'error' });
    }
  }

  return { render, load, renderSession };
}
