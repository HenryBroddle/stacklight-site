// Program transfer drawer (docs/DECISIONS.md D16): a File Explorer for one machine's Data Server.
//   - drag files in from the PC (or "Send files…" on phones and tablets) to send them; files dropped on a machine's
//     tile, name plate or board row come here too (dropFiles; public/js/fileDrop.js), with one "Send … to …?" first;
//   - right-click a program (or its ⋯ button) to download it or delete it;
//   - History lists every change, with Put back for replaced and deleted programs;
//   - Setup turns transfer on, per machine, and saves each Data Server's login on the HUD PC.
// The only questions are "Replace …?" and "Delete …?"; a program in use shows a lock. Every check runs again on the
// HUD PC (src/programs/service.js); this panel asks and explains. Shop network and edit token only.
// Every string is rendered with textContent.
import { iconSvg } from './icons.js';
import { programId } from '/shared/runs.js';

/** Names the HUD sends (the server checks the same). */
export const PROGRAM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function button(label, cls, icon) {
  const b = h('button', `btn ${cls ?? ''}`.trim());
  b.type = 'button';
  if (icon) b.append(iconSvg(icon, { size: null }));
  if (label) b.append(h('span', null, label));
  return b;
}

/** 186 KB, 1.4 MB. */
/**
 * What the Preview column shows for a program's first line (shop feedback, 2026-11-19: "display what's in ( ) on the
 * first line"): the text inside its first parentheses, e.g. "BRACKET LH OP2" from "O00001732(BRACKET LH OP2)". A comment cut off by the 160-character limit still shows. Without
 * parentheses: the line minus its program number or <name>, or '' when nothing else is on it.
 * @param {string|null|undefined} line
 */
export function previewFromFirstLine(line) {
  if (typeof line !== 'string') return '';
  const text = line.replace(/…$/, '').trim();
  const m = /\(([^()]*)\)/.exec(text) ?? /\(([^()]*)$/.exec(text);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  return text.replace(/^(?:[OoNn:]\d+|<[^>]*>)\s*/, '').trim();
}

export function formatBytes(n) {
  if (!finite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Today 7:40 AM", "Nov 14, 10:05 AM", "Nov 14, 2025". */
export function formatModified(ms, now, { clock24h = false, timeZone } = {}) {
  if (!finite(ms)) return '—';
  const tz = typeof timeZone === 'string' ? { timeZone } : {};
  const day = (t) => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', ...tz }).format(t);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: !clock24h, ...tz }).format(ms);
  if (finite(now) && day(ms) === day(now)) return `Today ${time}`;
  const year = (t) => new Intl.DateTimeFormat('en-US', { year: 'numeric', ...tz }).format(t);
  if (finite(now) && year(ms) !== year(now)) return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tz }).format(ms);
  return `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...tz }).format(ms)}, ${time}`;
}

/** How each machine reports to the HUD (Setup); program transfer itself is FTP, set per machine. */
const PROTOCOL_LABELS = Object.freeze({ focas: 'FANUC', mtconnect: 'MTConnect', opcua: 'OPC UA', 'haas-mdc': 'Haas MDC' });
const ACTION_TEXT = Object.freeze({
  sent: 'Sent', replaced: 'Replaced', downloaded: 'Downloaded', deleted: 'Deleted', putback: 'Put back',
  'folder-made': 'Made the folder', 'folder-deleted': 'Deleted the folder', copied: 'Copied', moved: 'Moved',
});
/** A folder path in History: "MAIN › PART-A", or "the top folder". */
const dirText = (d) => (Array.isArray(d) && d.length ? d.join(' › ') : 'the top folder');
/** Folder names the HUD makes (src/programs/store.js NEW_FOLDER_RE). */
export const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const RESULT_TEXT = Object.freeze({ checked: 'Read back and checked', done: 'Done', failed: 'Check failed' });

/** One History line: { title, meta } (meta without the time, which the caller formats). */
export function historyText(e) {
  if (!isObj(e)) return { title: '', meta: '' };
  const name = typeof e.name === 'string' ? e.name : '';
  let title = `${ACTION_TEXT[e.action] ?? e.action ?? ''} ${name}`.trim();
  if (e.action === 'sent') title += ' (new)';
  if (e.action === 'putback' && finite(e.restoredModified)) title += ' (an earlier copy)';
  const dir = Array.isArray(e.dir) ? e.dir.filter((x) => typeof x === 'string' && x) : [];
  if (e.action === 'moved') title += ` to ${dirText(e.toDir)}, from ${dirText(dir)}`;
  else if (e.action === 'copied') title += ` to ${dirText(dir)}, from ${dirText(e.fromDir)}`;
  else if (dir.length) title += ` in ${dir.join(' › ')}`;
  const from = typeof e.from === 'string' && e.from ? (['127.0.0.1', '::1'].includes(e.from) ? 'the HUD PC' : e.from) : null;
  const meta = [from ? `from ${from}` : null, RESULT_TEXT[e.result] ?? null].filter(Boolean).join(' · ');
  return { title, meta };
}

/**
 * @param {HTMLElement} el  drawer container (an <aside>)
 * @param {{ api: object, getContext: () => ({ settings: object, now: number, kiosk: boolean }),
 *           getMachines: () => object[], requestToken: () => Promise<string|null>, toast?: Function, demo?: boolean }} deps
 *   demo: the public demo (simulated Data Servers, no setup)
 */
export function createProgramsPanel(el, deps) {
  const { api, getContext, toast = () => {} } = deps;
  /** The public demo: simulated Data Servers in the visitor's browser, no setup. */
  const demo = deps.demo === true;
  const st = {
    id: null, view: 'list', data: null, error: null, loading: false, menuFor: null, sending: null,
    /** where a right-click opened the menu ({ x, y } in the window), or null: beside the row's ⋯ button */
    menuAt: null,
    fresh: new Set(), historyOpen: false, history: null, historyError: null, overview: null, setupError: null, loginFor: null,
    linesLeft: 0, asking: false,
    /** The open folder: names below the machine's folder ([] = its own folder). */
    dir: [],
  };
  let loadSeq = 0;
  let linesSeq = 0;
  /** First-line cells of the rendered list, by program name (filled in as lines are read). */
  let lineCells = new Map();

  el.replaceChildren();
  el.classList.add('drawer', 'programs');
  el.hidden = true;
  el.setAttribute('aria-label', 'Programs');

  const head = h('header', 'drawer-head plain prog-head');
  const over = h('div', 'prog-over', 'Programs');
  const title = h('h2', 'd-name');
  const sub = h('div', 'd-sub');
  const pickWrap = h('label', 'prog-pick');
  const pick = h('select', 'runs-select');
  pick.setAttribute('aria-label', 'Machine');
  pickWrap.append(h('span', 'muted', 'Machine'), pick);
  const close = button(null, 'btn-icon drawer-close', 'close');
  close.setAttribute('aria-label', 'Close programs');
  head.append(over, title, sub, pickWrap, close);

  const toolbar = h('div', 'prog-toolbar');
  const sendBtn = button('Send files…', 'btn-accent', 'upload');
  // beside the path bar: a folder is made where you are
  const folderBtn = button('New folder', 'btn-small prog-new-folder', 'folder-plus');
  const refreshBtn = button('Refresh', null, 'refresh');
  const historyBtn = button('History', null, 'clock');
  const setupBtn = button('Setup', 'btn-quiet', 'sliders');
  const summary = h('span', 'prog-summary muted');
  const fileInput = h('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  toolbar.append(sendBtn, refreshBtn, historyBtn, setupBtn, summary, fileInput);

  const body = h('div', 'drawer-body prog-body');
  const historyEl = h('section', 'prog-history');
  historyEl.hidden = true;
  historyEl.setAttribute('aria-label', 'History');
  el.append(head, toolbar, body, historyEl);

  const ctx = () => getContext();
  const clockOpts = () => ({ clock24h: !!ctx().settings?.display?.clock24h, timeZone: ctx().settings?.display?.timeZone ?? undefined });
  const machineName = (id = st.id) => {
    const m = deps.getMachines().find((x) => x?.id === id);
    return typeof m?.name === 'string' && m.name ? m.name : id ?? '';
  };
  /** "Wire EDM › MAIN › PART-A": where a send goes. */
  const where = (dir = st.dir) => [machineName(), ...dir].join(' › ');
  const enabledIds = () => {
    const p = ctx().settings?.programs;
    return p?.enabled ? Object.keys(p.machines ?? {}).filter((k) => p.machines[k]?.enabled) : [];
  };

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------
  async function load() {
    if (!st.id) return;
    const seq = ++loadSeq;
    linesSeq++;
    st.linesLeft = 0;
    st.loading = true;
    render();
    try {
      const data = await api.programs.list(st.id, st.dir);
      if (seq !== loadSeq) return;
      st.data = data;
      st.error = null;
    } catch (e) {
      if (seq !== loadSeq) return;
      if (e?.code === 'FOLDER_NOT_FOUND' && st.dir.length) {
        // the folder went away (deleted on the control): back to the machine's own folder
        toast(e.message, { kind: 'error', timeoutMs: 8000 });
        st.dir = [];
        st.loading = false;
        return load();
      }
      st.data = null;
      st.error = e;
    } finally {
      if (seq === loadSeq) { st.loading = false; render(); }
    }
    if (seq === loadSeq && st.data?.firstLinesPending > 0 && !st.data?.previews?.paused) readFirstLines();
  }

  /** Why previews are not being read right now (the list's summary line). */
  const PREVIEW_WAIT = Object.freeze({
    running: 'previews are read when the machine is not running',
    'status-unknown': 'previews wait until the HUD sees the machine',
    'recent-change': 'previews resume shortly',
  });

  /**
   * What a program's Preview cell shows: its first line with "..." after it (more follows; three periods, because
   * the HUD font draws "…" too small to see), "Reading…" while it is being read, else the comment the HUD knows.
   */
  const lineText = (f) => {
    if (typeof f.firstLine === 'string') {
      const p = previewFromFirstLine(f.firstLine);
      return p ? `${p} ...` : '';
    }
    return st.linesLeft > 0 ? 'Reading…' : f.comment ?? '';
  };
  function paintLine(f) {
    const td = lineCells.get(f.name);
    if (!td) return;
    td.textContent = lineText(f);
    td.title = f.firstLine ?? '';
  }

  /** Read the first lines the HUD has not seen yet, a batch at a time, while this list stays open. */
  async function readFirstLines() {
    const seq = ++linesSeq;
    const id = st.id;
    const dir = [...st.dir];
    st.linesLeft = st.data?.firstLinesPending ?? 0;
    const current = () => seq === linesSeq && st.id === id && st.dir.join('/') === dir.join('/') && !!st.data && !el.hidden && st.view === 'list';
    while (st.linesLeft > 0 && current()) {
      if (st.sending || st.asking) break; // never alongside a send or while a question is open (one session per machine)
      let r;
      try { r = await api.programs.firstLines(id, dir); } catch { break; }
      if (!current()) return;
      const lines = r?.lines ?? {};
      for (const f of st.data.files) {
        if (Object.hasOwn(lines, f.name)) { f.firstLine = lines[f.name]; paintLine(f); }
      }
      st.linesLeft = Number(r?.pending) || 0;
      if (r?.paused && st.data) st.data.previews = { ...(st.data.previews ?? {}), paused: r.paused };
      renderHead();
      if (r?.paused || !Object.keys(lines).length) break; // paused, or no progress: stop rather than ask again
    }
    if (seq !== linesSeq) return;
    st.linesLeft = 0;
    if (st.data) for (const f of st.data.files) paintLine(f);
    if (!el.hidden) renderHead();
  }

  async function loadHistory() {
    if (!st.id) return;
    try {
      st.history = (await api.programs.history(st.id))?.entries ?? [];
      st.historyError = null;
    } catch (e) { st.historyError = e; }
    renderHistory();
  }

  async function loadOverview() {
    try {
      st.overview = await api.programs.overview();
      st.setupError = null;
    } catch (e) { st.setupError = e; }
    render();
  }

  // ---------------------------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------------------------
  /** Modal question; resolves the chosen action's value (null on Escape). */
  function modal({ heading, icon, lines = [], warn = null, actions }) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'token-dialog prog-dialog';
      const form = h('form', 'token-form');
      form.method = 'dialog';
      const h2 = h('h2', null, heading);
      if (icon) h2.prepend(iconSvg(icon, { size: null }));
      form.append(h2);
      for (const l of lines) form.append(h('p', null, l));
      if (warn) form.append(h('p', 'prog-warn', warn));
      const row = h('div', 'dialog-actions');
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { dlg.close(); } catch { /* closed */ }
        dlg.remove();
        resolve(v);
      };
      for (const a of actions) {
        const b = h('button', `btn${a.primary ? ' btn-primary' : ''}`, a.label);
        b.type = 'button';
        b.addEventListener('click', () => finish(a.value));
        row.append(b);
      }
      form.append(row);
      dlg.append(form);
      dlg.addEventListener('cancel', () => finish(null));
      document.body.append(dlg);
      dlg.showModal();
      row.querySelector('.btn-primary')?.focus();
    });
  }

  const runningWarning = (running, program, name) => (running && program && programId(program) !== programId(String(name))
    ? `${machineName()} is running ${program}. If ${program} calls ${name}, wait until the run ends.` : null);

  function lockedDialog(name, message) {
    return modal({
      heading: `${name} is in use`, icon: 'lock',
      lines: [message || `${name} is running or selected on ${machineName()}. Nothing was changed.`, 'Try again after the run, once another program is selected.'],
      actions: [{ label: 'OK', primary: true, value: true }],
    });
  }
  function problemDialog(heading, message) {
    return modal({ heading, icon: 'info', lines: [message], actions: [{ label: 'OK', primary: true, value: true }] });
  }

  // ---------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------
  /** Send files into a folder (the open one, or a folder row or path part they were dropped on). */
  async function sendFiles(files, dir = st.dir) {
    if (!st.data || st.sending) return;
    const maxBytes = (st.data.maxUploadMB ?? 100) * 1024 * 1024;
    for (const f of files) {
      if (!PROGRAM_NAME_RE.test(f.name) || /^\.+$/.test(f.name)) { toast(`${f.name}: program names may use letters, digits, dot, dash and underscore (max 64), with no spaces`, { kind: 'error', timeoutMs: 8000 }); continue; }
      if (!f.size) { toast(`${f.name} is empty`, { kind: 'error' }); continue; }
      if (f.size > maxBytes) { toast(`${f.name} is larger than ${st.data.maxUploadMB ?? 100} MB`, { kind: 'error' }); continue; }
      await sendOne(f.name, f, false, dir);
    }
    await load();
    if (st.historyOpen) loadHistory();
  }

  async function sendOne(name, blob, replace, dir = st.dir) {
    st.sending = { name, phase: replace ? 'Keeping the machine’s copy, sending, reading it back…' : 'Sending, then reading it back…' };
    render();
    let again = false;
    try {
      const r = await api.programs.upload(st.id, name, blob, { replace, dir });
      if (dir.join('/') === st.dir.join('/')) st.fresh.add(String(r.name).toUpperCase());
      toast(`${r.action === 'replaced' ? 'Replaced' : 'Sent'} ${r.name} on ${where(dir)} · read back and checked${r.note ? ' (the Data Server stored it in its own text format; see History)' : ''}`, { kind: 'ok', timeoutMs: r.note ? 9000 : undefined });
    } catch (e) {
      st.sending = null;
      render();
      if (e?.code === 'EXISTS') {
        const b = e.body ?? {};
        st.asking = true;
        const yes = await modal({
          heading: `Replace ${b.name ?? name}?`, icon: 'upload',
          lines: [`${where(dir)} already has ${b.name ?? name} (${formatBytes(b.size)}, ${formatModified(b.modified, ctx().now, clockOpts())}). The HUD keeps that copy before replacing it, so you can put it back from History.`],
          warn: runningWarning(b.running, b.program, b.name ?? name),
          actions: [{ label: 'Cancel', value: false }, { label: 'Replace', primary: true, value: true }],
        }).finally(() => { st.asking = false; });
        again = !!yes;
      } else if (e?.code === 'IN_USE') await lockedDialog(name, e.message);
      else if (e?.code === 'STATUS_UNKNOWN') await problemDialog(`${name} was not replaced`, e.message);
      else toast(`${name}: ${e?.message ?? 'not sent'}`, { kind: 'error', timeoutMs: e?.code === 'VERIFY_FAILED' ? 20000 : 10000 });
    } finally {
      st.sending = null;
      render();
    }
    if (again) await sendOne(name, blob, true, dir);
  }

  async function download(f) {
    closeMenu();
    try {
      const blob = await api.programs.download(st.id, f.name, { dir: st.dir });
      const url = URL.createObjectURL(blob);
      const a = h('a');
      a.href = url;
      a.download = f.name;
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast(`${f.name} saved to this computer's Downloads`, { kind: 'ok' });
      if (st.historyOpen) loadHistory();
    } catch (e) { toast(`${f.name}: ${e?.message ?? 'not downloaded'}`, { kind: 'error', timeoutMs: 10000 }); }
  }

  async function remove(f) {
    closeMenu();
    if (f.inUse) { await lockedDialog(f.name); return; }
    const s = st.data?.status ?? {};
    const yes = await modal({
      heading: `Delete ${f.name} from ${where()}?`, icon: 'trash',
      lines: [`${previewFromFirstLine(f.firstLine) || f.comment ? `${previewFromFirstLine(f.firstLine) || f.comment}. ` : ''}The HUD keeps a copy on the HUD PC first, so you can put it back from History.`],
      warn: runningWarning(s.running, s.program, f.name),
      actions: [{ label: 'Cancel', value: false }, { label: 'Delete', primary: true, value: true }],
    });
    if (!yes) return;
    try {
      await api.programs.remove(st.id, f.name, { dir: st.dir });
      toast(`Deleted ${f.name} · a copy is kept on the HUD PC`, { kind: 'ok' });
    } catch (e) {
      if (e?.code === 'IN_USE') await lockedDialog(f.name, e.message);
      else if (e?.code === 'STATUS_UNKNOWN') await problemDialog(`${f.name} was not deleted`, e.message);
      else toast(`${f.name}: ${e?.message ?? 'not deleted'}`, { kind: 'error', timeoutMs: 10000 });
    }
    await load();
    if (st.historyOpen) loadHistory();
  }

  async function putBack(entry) {
    const when = formatModified(entry.at, ctx().now, clockOpts());
    const yes = await modal({
      heading: `Put back ${entry.name}?`, icon: 'refresh',
      lines: [`This puts back the copy of ${entry.name} the HUD kept ${when}, into ${where(Array.isArray(entry.dir) ? entry.dir : [])}. If there is a newer ${entry.name} there, that one is kept first, so this can be undone too.`],
      actions: [{ label: 'Cancel', value: false }, { label: 'Put back', primary: true, value: true }],
    });
    if (!yes) return;
    try {
      await api.programs.putBack(st.id, entry.id);
      st.fresh.add(String(entry.name).toUpperCase());
      toast(`Put back ${entry.name} · read back and checked`, { kind: 'ok' });
    } catch (e) {
      if (e?.code === 'IN_USE') await lockedDialog(entry.name, e.message);
      else if (e?.code === 'STATUS_UNKNOWN') await problemDialog(`${entry.name} was not put back`, e.message);
      else toast(`${entry.name}: ${e?.message ?? 'not put back'}`, { kind: 'error', timeoutMs: 10000 });
    }
    await Promise.all([load(), loadHistory()]);
  }

  // ---------------------------------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------------------------------
  /** Open a folder (a path below the machine's folder). */
  function goTo(dir) {
    closeMenu();
    st.dir = dir;
    st.data = null;
    st.error = null;
    render();
    st.listLoad = load();
    return st.listLoad;
  }

  /** Ask for a new folder's name; resolves the name or null. */
  function askFolderName() {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'token-dialog prog-dialog';
      const form = h('form', 'token-form');
      const h2 = h('h2', null, 'New folder');
      h2.prepend(iconSvg('folder-plus', { size: null }));
      const label = h('label', 'prog-field');
      label.append(h('span', null, `In ${where()}`));
      const input = h('input');
      input.maxLength = 32;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Folder name');
      label.append(input);
      const hint = h('p', 'muted small', 'Letters, digits, dot, dash and underscore, up to 32, with no spaces.');
      const row = h('div', 'dialog-actions');
      const cancel = h('button', 'btn', 'Cancel');
      cancel.type = 'button';
      const make = h('button', 'btn btn-primary', 'Make the folder');
      make.type = 'submit';
      make.disabled = true;
      row.append(cancel, make);
      form.append(h2, label, hint, row);
      dlg.append(form);
      let done = false;
      const finish = (v) => { if (done) return; done = true; try { dlg.close(); } catch { /* closed */ } dlg.remove(); resolve(v); };
      input.addEventListener('input', () => {
        const v = input.value.trim();
        const ok = FOLDER_NAME_RE.test(v) && !/^\.+$/.test(v);
        make.disabled = !ok;
        hint.classList.toggle('prog-warn', !!v && !ok);
      });
      form.addEventListener('submit', (ev) => { ev.preventDefault(); if (!make.disabled) finish(input.value.trim()); });
      cancel.addEventListener('click', () => finish(null));
      dlg.addEventListener('cancel', () => finish(null));
      document.body.append(dlg);
      dlg.showModal();
      input.focus();
    });
  }

  async function makeFolder() {
    if (!st.data || st.sending) return;
    st.asking = true;
    const name = await askFolderName().finally(() => { st.asking = false; });
    if (!name) return;
    try {
      await api.programs.makeFolder(st.id, name, { dir: st.dir });
      toast(`Made the folder ${name} in ${where()}`, { kind: 'ok' });
    } catch (e) {
      if (['FOLDERS_NOT_SUPPORTED', 'FOLDER_EXISTS'].includes(e?.code)) await problemDialog(`${name} was not made`, e.message);
      else toast(`${name}: ${e?.message ?? 'not made'}`, { kind: 'error', timeoutMs: 10000 });
    }
    await load();
    if (st.historyOpen) loadHistory();
  }

  async function removeFolder(folder) {
    closeMenu();
    const yes = await modal({
      heading: `Delete the folder ${folder.name} from ${where()}?`, icon: 'trash',
      lines: ['Only an empty folder is deleted. If it has programs or folders in it, nothing is deleted.'],
      actions: [{ label: 'Cancel', value: false }, { label: 'Delete the folder', primary: true, value: true }],
    });
    if (!yes) return;
    try {
      await api.programs.removeFolder(st.id, folder.name, { dir: st.dir });
      toast(`Deleted the folder ${folder.name}`, { kind: 'ok' });
    } catch (e) {
      if (['FOLDER_NOT_EMPTY', 'FOLDERS_NOT_SUPPORTED'].includes(e?.code)) await problemDialog(`${folder.name} was not deleted`, e.message);
      else toast(`${folder.name}: ${e?.message ?? 'not deleted'}`, { kind: 'error', timeoutMs: 10000 });
    }
    await load();
    if (st.historyOpen) loadHistory();
  }

  // ---------------------------------------------------------------------------------------------
  // Copy and move between folders (a program row dragged onto a folder, or its ⋯ menu)
  // ---------------------------------------------------------------------------------------------
  /** Copy (move: false) or move a program from the open folder into `toDir`, asking before a replace. */
  async function copyTo(f, toDir, move, replace = false) {
    if (st.sending) return;
    const verb = move ? 'Moving' : 'Copying';
    st.sending = { name: f.name, phase: `${verb} to ${where(toDir)}, then reading it back…` };
    render();
    let again = false;
    try {
      const r = await api.programs.copy(st.id, f.name, { dir: st.dir, toDir, move, replace });
      toast(`${move ? 'Moved' : 'Copied'} ${r.name} to ${where(toDir)} · read back and checked${move ? ' · the original is kept on the HUD PC' : ''}`, { kind: 'ok' });
    } catch (e) {
      st.sending = null;
      render();
      if (e?.code === 'EXISTS') {
        const b = e.body ?? {};
        st.asking = true;
        again = !!(await modal({
          heading: `Replace ${b.name ?? f.name} in ${where(toDir)}?`, icon: 'upload',
          lines: [`${where(toDir)} already has ${b.name ?? f.name} (${formatBytes(b.size)}, ${formatModified(b.modified, ctx().now, clockOpts())}). The HUD keeps that copy before replacing it, so you can put it back from History.`],
          warn: runningWarning(b.running, b.program, b.name ?? f.name),
          actions: [{ label: 'Cancel', value: false }, { label: 'Replace', primary: true, value: true }],
        }).finally(() => { st.asking = false; }));
      } else if (e?.code === 'IN_USE') await lockedDialog(f.name, e.message);
      else if (e?.code === 'STATUS_UNKNOWN') await problemDialog(`${f.name} was not ${move ? 'moved' : 'copied'}`, e.message);
      else toast(`${f.name}: ${e?.message ?? `not ${move ? 'moved' : 'copied'}`}`, { kind: 'error', timeoutMs: 12000 });
    } finally {
      st.sending = null;
      render();
    }
    if (again) { await copyTo(f, toDir, move, true); return; }
    await load();
    if (st.historyOpen) loadHistory();
  }

  /** A program dropped on a folder: copy or move it there? */
  async function askCopyOrMove(f, toDir) {
    st.asking = true;
    const choice = await modal({
      heading: `Copy or move ${f.name} to ${where(toDir)}?`, icon: 'folder',
      lines: [f.inUse
        ? `${f.name} is in use, so it can be copied but not moved.`
        : 'Move puts it there and deletes it here. The HUD keeps a copy of the original, so a move can be put back from History.'],
      actions: [{ label: 'Cancel', value: null }, { label: 'Copy', value: 'copy', primary: !!f.inUse }, ...(f.inUse ? [] : [{ label: 'Move', value: 'move', primary: true }])],
    }).finally(() => { st.asking = false; });
    if (choice === 'copy' || choice === 'move') await copyTo(f, toDir, choice === 'move');
  }

  /** Pick a folder on this machine (menu: Copy to folder…, Move to folder…). Resolves a path or null. */
  function pickFolder({ heading, action, exclude }) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'token-dialog prog-dialog prog-picker';
      const form = h('div', 'token-form');
      const h2 = h('h2', null, heading);
      h2.prepend(iconSvg('folder', { size: null }));
      const pathEl = h('div', 'prog-picker-path');
      const listEl = h('div', 'prog-picker-list');
      const note = h('p', 'muted small');
      const row = h('div', 'dialog-actions');
      const cancel = h('button', 'btn', 'Cancel');
      cancel.type = 'button';
      const ok = h('button', 'btn btn-primary', action);
      ok.type = 'button';
      row.append(cancel, ok);
      form.append(h2, pathEl, listEl, note, row);
      dlg.append(form);
      let at = [];
      let done = false;
      const finish = (v) => { if (done) return; done = true; try { dlg.close(); } catch { /* closed */ } dlg.remove(); resolve(v); };
      async function show(dir) {
        at = dir;
        pathEl.replaceChildren(h('span', null, where(dir)));
        listEl.replaceChildren(h('p', 'muted small', 'Reading the folders…'));
        const same = dir.join('/') === exclude.join('/');
        ok.disabled = true;
        note.textContent = '';
        let data;
        try { data = await api.programs.list(st.id, dir); } catch (e) { listEl.replaceChildren(h('p', 'prog-warn small', e?.message ?? 'Could not read the folders.')); return; }
        if (done || at !== dir) return;
        listEl.replaceChildren();
        if (dir.length) {
          const up = button(`Up to ${dir.length > 1 ? dir[dir.length - 2] : machineName()}`, 'prog-picker-item', 'up');
          up.addEventListener('click', () => show(dir.slice(0, -1)));
          listEl.append(up);
        }
        for (const f of data.folders ?? []) {
          const b = button(f.name, 'prog-picker-item', 'folder');
          b.addEventListener('click', () => show([...dir, f.name]));
          listEl.append(b);
        }
        if (!dir.length && !(data.folders ?? []).length) listEl.append(h('p', 'muted small', 'No folders here yet. Make one with New folder first.'));
        ok.disabled = same;
        note.textContent = same ? 'This is where it is now: pick another folder.' : `${action} into ${where(dir)}.`;
      }
      cancel.addEventListener('click', () => finish(null));
      ok.addEventListener('click', () => { if (!ok.disabled) finish(at); });
      dlg.addEventListener('cancel', () => finish(null));
      document.body.append(dlg);
      dlg.showModal();
      show([]);
    });
  }

  async function copyFromMenu(f, move) {
    closeMenu();
    if (move && f.inUse) { await lockedDialog(f.name); return; }
    st.asking = true;
    const toDir = await pickFolder({ heading: `${move ? 'Move' : 'Copy'} ${f.name} to…`, action: move ? 'Move here' : 'Copy here', exclude: st.dir })
      .finally(() => { st.asking = false; });
    if (toDir) await copyTo(f, toDir, move);
  }

  /**
   * A drop target that stands for a folder (a folder row, the Up row, a part of the path bar): files from the PC are
   * sent into it, a program dragged from the list is copied or moved into it.
   */
  const PROGRAM_DRAG = 'application/x-stacklight-program';
  const isProgramDrag = (ev) => [...(ev.dataTransfer?.types ?? [])].includes(PROGRAM_DRAG);
  function dropTarget(node, dirOf) {
    const over = (ev) => {
      const files = hasFiles(ev);
      if ((!files && !isProgramDrag(ev)) || !st.data || st.sending) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = files ? 'copy' : 'move';
      node.classList.add('drop-into');
      body.classList.remove('dragging');
    };
    node.addEventListener('dragenter', over);
    node.addEventListener('dragover', over);
    node.addEventListener('dragleave', (ev) => { if (!node.contains(ev.relatedTarget)) node.classList.remove('drop-into'); });
    node.addEventListener('drop', (ev) => {
      node.classList.remove('drop-into');
      body.classList.remove('dragging');
      if (!st.data || st.sending) return;
      const toDir = dirOf();
      if (hasFiles(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        sendFiles([...ev.dataTransfer.files], toDir);
        return;
      }
      if (!isProgramDrag(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      let src = null;
      try { src = JSON.parse(ev.dataTransfer.getData(PROGRAM_DRAG)); } catch { return; }
      if (!src || src.id !== st.id || src.dir !== st.dir.join('/')) return;
      if (toDir.join('/') === st.dir.join('/')) return;
      const f = st.data.files.find((x) => x.name === src.name);
      if (f) askCopyOrMove(f, toDir);
    });
    return node;
  }

  // ---------------------------------------------------------------------------------------------
  // Menu (right-click or ⋯)
  // ---------------------------------------------------------------------------------------------
  // The open menu is drawn on the drawer itself, not in the scrolling list, and kept inside the drawer: a wide list
  // (long program names) scrolls sideways, and a menu inside it would be cut off at the drawer's edge.
  /** @type {{ menu: HTMLElement, anchor: HTMLElement }|null} the menu the current render built, and its ⋯ button */
  let menuBuilt = null;
  /** @type {HTMLElement|null} */
  let menuEl = null;
  let menuScroll = 0;
  /** Open (or, from ⋯, toggle) a row's menu; a right-click opens it at the pointer. */
  function openMenu(name, at = null) {
    if (!at && st.menuFor === name) { closeMenu(); return; }
    st.menuFor = name;
    st.menuAt = at;
    render();
    menuEl?.querySelector('button')?.focus({ preventScroll: true });
  }
  function closeMenu() {
    if (st.menuFor === null) return;
    st.menuFor = null;
    st.menuAt = null;
    render();
  }
  /** A right-click's position, or null for one from the keyboard (the menu then opens beside the ⋯ button). */
  const pointOf = (ev) => (ev.clientX || ev.clientY ? { x: ev.clientX, y: ev.clientY } : null);
  /** The menu a row built: Escape closes it and puts the focus back on that row's ⋯ button. */
  function offerMenu(menu, anchor, label) {
    menu.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      closeMenu();
      [...body.querySelectorAll('.prog-more')].find((b) => b.getAttribute('aria-label') === label)?.focus();
    });
    menuBuilt = { menu, anchor };
  }
  /** After a render: put the menu on the drawer, beside its ⋯ button or at the pointer, inside the drawer's edges. */
  function placeMenu() {
    menuEl?.remove();
    menuEl = null;
    const built = menuBuilt;
    menuBuilt = null;
    if (!built || st.menuFor === null || el.hidden) return;
    const { menu, anchor } = built;
    menu.classList.add('floating');
    menu.style.left = '0px';
    menu.style.top = '0px';
    el.append(menu);
    menuEl = menu;
    menuScroll = body.scrollTop;
    const pad = 8;
    const box = el.getBoundingClientRect();
    const minX = Math.max(box.left, 0) + pad;
    const maxX = Math.min(box.right, window.innerWidth) - pad;
    const minY = Math.max(box.top, 0) + pad;
    const maxY = Math.min(box.bottom, window.innerHeight) - pad;
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    let x;
    let y;
    if (st.menuAt) {
      x = st.menuAt.x + w > maxX ? st.menuAt.x - w : st.menuAt.x;
      y = st.menuAt.y + hgt > maxY ? st.menuAt.y - hgt : st.menuAt.y;
    } else {
      const r = anchor.getBoundingClientRect();
      x = Math.min(r.right, maxX) - w;
      y = r.bottom + hgt - 4 > maxY ? r.top - hgt + 4 : r.bottom - 4;
    }
    menu.style.left = `${Math.round(Math.max(minX, Math.min(x, maxX - w)))}px`;
    menu.style.top = `${Math.round(Math.max(minY, Math.min(y, maxY - hgt)))}px`;
  }
  // scrolling the list moves the row away from its menu: close it (a re-render keeps the scroll, so it stays open)
  body.addEventListener('scroll', () => { if (menuEl && Math.abs(body.scrollTop - menuScroll) > 24) closeMenu(); }, { passive: true });
  window.addEventListener('resize', () => closeMenu());
  const onDocClick = (ev) => {
    if (st.menuFor !== null && !ev.target.closest?.('.prog-menu, .prog-more')) closeMenu();
  };

  // ---------------------------------------------------------------------------------------------
  // Drag and drop (files from the PC)
  // ---------------------------------------------------------------------------------------------
  const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
  body.addEventListener('dragenter', (ev) => {
    if (!hasFiles(ev) || st.view !== 'list' || !st.data) return;
    ev.preventDefault();
    body.classList.add('dragging');
  });
  body.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev) || st.view !== 'list' || !st.data) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    body.classList.add('dragging');
  });
  body.addEventListener('dragleave', (ev) => {
    if (!body.contains(ev.relatedTarget)) body.classList.remove('dragging');
  });
  body.addEventListener('drop', (ev) => {
    body.classList.remove('dragging');
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    if (st.view === 'list' && st.data) sendFiles([...ev.dataTransfer.files]);
  });
  // A file dropped beside the list must not make the browser open it (and leave the HUD).
  const blockStrayDrop = (ev) => {
    if (!hasFiles(ev) || body.contains(ev.target)) return;
    ev.preventDefault();
    if (ev.type === 'dragover') ev.dataTransfer.dropEffect = 'none';
  };

  // ---------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------
  function renderHead() {
    title.textContent = st.view === 'setup' ? 'Program transfer setup' : machineName();
    over.textContent = st.view === 'setup' ? 'Programs' : 'Programs';
    const d = st.data;
    sub.textContent = st.view === 'setup'
      ? 'Off until turned on, then machine by machine · shop network only'
      : [d?.machine ? `Data Server · ${d.machine.host}${d.machine.port !== 21 ? `:${d.machine.port}` : ''}` : 'Data Server', 'shop network only'].join(' · ');
    const ids = [...new Set([...enabledIds(), ...(st.id ? [st.id] : [])])];
    pick.replaceChildren(...ids.map((id) => {
      const o = h('option', null, machineName(id));
      o.value = id;
      return o;
    }));
    pick.value = st.id ?? '';
    pickWrap.hidden = st.view === 'setup' || ids.length < 2;
    const listReady = st.view === 'list' && !!st.data;
    sendBtn.hidden = st.view !== 'list';
    sendBtn.disabled = !listReady || !!st.sending;
    folderBtn.hidden = st.view !== 'list';
    folderBtn.disabled = !listReady || !!st.sending || d?.canGoDeeper === false;
    refreshBtn.hidden = st.view !== 'list';
    refreshBtn.disabled = st.loading;
    historyBtn.hidden = st.view !== 'list' || !st.id;
    setupBtn.querySelector('span').textContent = st.view === 'setup' ? 'Back to programs' : 'Setup';
    setupBtn.hidden = demo || (st.view === 'setup' && !st.id);
    const waiting = d?.previews?.paused && (d.firstLinesPending ?? 0) > 0 ? PREVIEW_WAIT[d.previews.paused] ?? '' : '';
    const nFolders = d?.folders?.length ?? 0;
    summary.textContent = listReady
      ? `${d.files.length} program${d.files.length === 1 ? '' : 's'}${nFolders ? ` · ${nFolders} folder${nFolders === 1 ? '' : 's'}` : ''}${st.loading ? ' · reading…' : st.linesLeft > 0 ? ` · reading previews, ${st.linesLeft} to go` : waiting ? ` · ${waiting}` : ''}`
      : (st.loading ? 'Reading the Data Server…' : '');
  }

  function render() {
    if (el.hidden) return;
    menuBuilt = null;
    try {
      renderList();
    } finally {
      placeMenu();
    }
  }

  function renderList() {
    renderHead();
    if (st.view === 'setup') { renderSetup(); return; }
    body.replaceChildren();
    if (!st.data) {
      body.append(st.error ? errorView(st.error) : h('p', 'muted prog-msg', 'Reading the machine’s Data Server…'));
      return;
    }
    const d = st.data;
    if (d.status?.known === false) body.append(h('p', 'prog-status', 'The HUD has no live status from this machine right now, so programs can be sent but not replaced or deleted.'));
    else if (d.status?.running && d.status.program) body.append(h('p', 'prog-status', `Running ${d.status.program}. It stays locked while it runs or is selected.`));
    body.append(pathBar());
    if (st.sending) {
      const row = h('div', 'prog-sending');
      row.append(iconSvg('upload', { size: null }), h('strong', null, st.sending.name), h('span', null, st.sending.phase));
      body.append(row);
    }
    const table = h('table', 'prog-table');
    const thead = h('thead');
    const hr = h('tr');
    for (const [label, cls] of [['Name', null], ['Preview', null], ['Size', 'num'], ['Modified', null], ['', 'act']]) {
      const th = h('th', cls, label);
      if (!label) th.append(h('span', 'sr-only', 'Actions'));
      hr.append(th);
    }
    thead.append(hr);
    const tbody = h('tbody');
    lineCells = new Map();
    if (st.dir.length) tbody.append(upRow());
    for (const f of d.folders ?? []) tbody.append(folderRow(f));
    for (const f of d.files) tbody.append(fileRow(f));
    table.append(thead, tbody);
    if (d.files.length || d.folders?.length || st.dir.length) body.append(table);
    if (!d.files.length && !d.folders?.length) body.append(h('p', 'muted prog-msg', st.dir.length ? 'This folder is empty.' : 'No programs on this Data Server yet.'));
    const drop = h('div', 'prog-drop');
    drop.append(iconSvg('download', { size: null }), h('span', 'prog-drop-idle', `Drag files here from your PC to send them to ${where()}`), h('span', 'prog-drop-active', `Drop to send to ${where()}`));
    body.append(drop);
    body.append(h('p', 'note', demo
      ? 'Demo: this Data Server is simulated in your browser. Nothing is sent anywhere, and the programs reset when you reload. In a shop it works only on the shop network, and the HUD never selects or starts a program.'
      : 'Works only on the shop network. The HUD never selects or starts a program, and never touches parameters, offsets or macros.'));
  }

  /** Machine › folder › folder: each part opens that folder. */
  function pathBar() {
    const nav = h('nav', 'prog-path');
    nav.setAttribute('aria-label', 'Folder');
    const parts = [machineName(), ...st.dir];
    parts.forEach((label, i) => {
      if (i) nav.append(h('span', 'prog-path-sep', '›'));
      if (i === parts.length - 1) {
        const cur = h('span', 'prog-path-here', label);
        cur.setAttribute('aria-current', 'location');
        nav.append(i === 0 ? withIcon(cur) : cur);
      } else {
        const b = h('button', 'prog-path-part', label);
        b.type = 'button';
        b.addEventListener('click', () => goTo(st.dir.slice(0, i)));
        dropTarget(b, () => st.dir.slice(0, i));
        nav.append(i === 0 ? withIcon(b) : b);
      }
    });
    nav.append(folderBtn);
    return nav;
  }
  function withIcon(node) {
    node.prepend(iconSvg('folder', { size: null }));
    return node;
  }

  function upRow() {
    const tr = h('tr', 'prog-folder-row prog-up');
    const name = h('td', 'prog-name');
    const parent = st.dir.length > 1 ? st.dir[st.dir.length - 2] : machineName();
    name.append(iconSvg('up', { size: null }), h('span', null, `Up to ${parent}`));
    tr.append(name, h('td', 'prog-line muted'), h('td', 'num'), h('td'), h('td', 'act'));
    tr.tabIndex = 0;
    tr.addEventListener('click', () => goTo(st.dir.slice(0, -1)));
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') goTo(st.dir.slice(0, -1)); });
    return dropTarget(tr, () => st.dir.slice(0, -1));
  }

  function folderRow(f) {
    const key = `folder:${f.name}`;
    const tr = h('tr', `prog-folder-row${st.menuFor === key ? ' menu-open' : ''}`);
    tr.dataset.folder = f.name;
    const name = h('td', 'prog-name');
    name.append(iconSvg('folder', { size: null }), h('span', null, f.name));
    const tdAct = h('td', 'act');
    const more = button(null, 'btn-icon prog-more', 'dots');
    more.setAttribute('aria-label', `More actions for the folder ${f.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(st.menuFor === key));
    more.addEventListener('click', (ev) => { ev.stopPropagation(); openMenu(key); });
    tdAct.append(more);
    if (st.menuFor === key) {
      const menu = h('div', 'prog-menu');
      menu.setAttribute('role', 'menu');
      const open = button('Open', 'prog-menu-item', 'folder');
      open.setAttribute('role', 'menuitem');
      open.addEventListener('click', (ev) => { ev.stopPropagation(); goTo([...st.dir, f.name]); });
      const del = button('Delete the folder (if empty)…', 'prog-menu-item', 'trash');
      del.setAttribute('role', 'menuitem');
      del.addEventListener('click', (ev) => { ev.stopPropagation(); removeFolder(f); });
      menu.append(open, del);
      offerMenu(menu, more, more.getAttribute('aria-label'));
    }
    tr.append(name, h('td', 'prog-line muted', 'Folder'), h('td', 'num'), h('td', 'muted nowrap', formatModified(f.modified, ctx().now, clockOpts())), tdAct);
    tr.tabIndex = 0;
    const canGo = st.data?.canGoDeeper !== false;
    tr.addEventListener('click', (ev) => { if (canGo && !ev.target.closest?.('.act')) goTo([...st.dir, f.name]); });
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && canGo && ev.target === tr) goTo([...st.dir, f.name]); });
    tr.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openMenu(key, pointOf(ev)); });
    return dropTarget(tr, () => [...st.dir, f.name]);
  }

  function fileRow(f) {
    const tr = h('tr', `prog-row${f.inUse ? ' in-use' : ''}${st.menuFor === f.name ? ' menu-open' : ''}`);
    const name = h('td', 'prog-name');
    name.append(iconSvg(f.inUse ? 'lock' : 'file', { size: null }), h('span', null, f.name));
    const tdAct = h('td', 'act');
    const tags = h('span', 'prog-tags');
    if (f.inUse) tags.append(h('span', 'prog-tag in-use', 'IN USE'));
    if (st.fresh.has(String(f.name).toUpperCase())) tags.append(h('span', 'prog-tag fresh', 'Just sent · checked'));
    const more = button(null, 'btn-icon prog-more', 'dots');
    more.setAttribute('aria-label', `More actions for ${f.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(st.menuFor === f.name));
    more.addEventListener('click', (ev) => { ev.stopPropagation(); openMenu(f.name); });
    tdAct.append(tags, more);
    if (st.menuFor === f.name) {
      const menu = h('div', 'prog-menu');
      menu.setAttribute('role', 'menu');
      const dl = button('Download to this PC', 'prog-menu-item', 'download');
      dl.setAttribute('role', 'menuitem');
      dl.addEventListener('click', () => download(f));
      const cp = button('Copy to folder…', 'prog-menu-item', 'folder');
      cp.setAttribute('role', 'menuitem');
      cp.addEventListener('click', () => copyFromMenu(f, false));
      const mv = button(f.inUse ? 'Move: in use' : 'Move to folder…', `prog-menu-item${f.inUse ? ' muted' : ''}`, f.inUse ? 'lock' : 'folder');
      mv.setAttribute('role', 'menuitem');
      mv.addEventListener('click', () => copyFromMenu(f, true));
      const del = button(f.inUse ? 'Delete: in use' : 'Delete from the machine…', `prog-menu-item${f.inUse ? ' muted' : ''}`, f.inUse ? 'lock' : 'trash');
      del.setAttribute('role', 'menuitem');
      del.addEventListener('click', () => remove(f));
      menu.append(dl, cp, mv, del);
      offerMenu(menu, more, more.getAttribute('aria-label'));
    }
    // drag onto a folder (row, Up row or path bar) to copy or move it there
    tr.draggable = !st.sending;
    tr.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData(PROGRAM_DRAG, JSON.stringify({ id: st.id, dir: st.dir.join('/'), name: f.name }));
      ev.dataTransfer.setData('text/plain', f.name);
      ev.dataTransfer.effectAllowed = 'copyMove';
      body.classList.add('dragging-program');
    });
    tr.addEventListener('dragend', () => { body.classList.remove('dragging-program'); for (const n of el.querySelectorAll('.drop-into')) n.classList.remove('drop-into'); });
    const line = h('td', 'prog-cmt prog-line muted');
    lineCells.set(f.name, line);
    paintLine(f);
    tr.append(name, line, h('td', 'num', formatBytes(f.size)), h('td', 'muted nowrap', formatModified(f.modified, ctx().now, clockOpts())), tdAct);
    tr.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openMenu(f.name, pointOf(ev)); });
    return tr;
  }

  function errorView(e) {
    const box = h('div', 'prog-problem');
    const code = e?.code ?? (e?.status === 401 ? 'TOKEN_REQUIRED' : null);
    const msg = {
      TOKEN_REQUIRED: 'Programs need the edit token.',
      TOKEN_INVALID: 'Programs need the edit token.',
      OUTSIDE_SHOP_NETWORK: 'Program transfer works only from computers and phones on the shop network.',
      PROGRAMS_OFF: 'Program transfer is turned off on this HUD.',
    }[code] ?? e?.message ?? 'The programs could not be read.';
    box.append(h('p', null, msg));
    const row = h('div', 'dialog-actions');
    if (code === 'TOKEN_REQUIRED' || code === 'TOKEN_INVALID') {
      const b = button('Enter the edit token', 'btn-primary', 'key');
      b.addEventListener('click', async () => { if (await deps.requestToken()) load(); });
      row.append(b);
    } else if (code !== 'OUTSIDE_SHOP_NETWORK') {
      if (!['PROGRAMS_OFF', 'NOT_ENABLED', 'LOGIN_NEEDED', 'NO_ADDRESS'].includes(code)) {
        const retry = button('Try again', null, 'refresh');
        retry.addEventListener('click', () => load());
        row.append(retry);
      }
      const setup = button('Setup', 'btn-primary', 'sliders');
      setup.addEventListener('click', () => showSetup());
      row.append(setup);
    }
    if (row.children.length) box.append(row);
    return box;
  }

  function renderHistory() {
    historyEl.hidden = !st.historyOpen || el.hidden;
    if (historyEl.hidden) return;
    historyEl.replaceChildren();
    const hd = h('header', 'drawer-head plain');
    const x = button(null, 'btn-icon drawer-close', 'close');
    x.setAttribute('aria-label', 'Close history');
    x.addEventListener('click', () => { st.historyOpen = false; renderHistory(); historyBtn.focus(); });
    hd.append(h('div', 'prog-over', 'History'), h('h2', 'd-name', machineName()), h('div', 'd-sub', 'Every send, download and delete. Replaced and deleted programs are kept on the HUD PC.'), x);
    const list = h('div', 'drawer-body prog-history-list');
    if (st.historyError) list.append(h('p', 'muted', st.historyError.message));
    else if (!st.history) list.append(h('p', 'muted', 'Loading…'));
    else if (!st.history.length) list.append(h('p', 'muted', 'Nothing yet.'));
    else {
      for (const e of st.history) {
        const row = h('div', `prog-hist${e.result === 'failed' ? ' failed' : ''}`);
        const t = historyText(e);
        const text = h('div', 'prog-hist-text');
        text.append(h('div', 'prog-hist-title', t.title), h('div', 'muted small', [formatModified(e.at, ctx().now, clockOpts()), t.meta].filter(Boolean).join(' · ')));
        // what the read-back check found: how a failed copy differed, or how the Data Server reformatted a good one
        const found = e.result === 'failed' ? [e.difference, e.removed ? 'Removed from the machine.' : null].filter(Boolean).join(' ') : e.note ? `Checked: the Data Server stored it in its own text format. ${e.note}` : '';
        if (found) text.append(h('div', 'small prog-hist-check', found));
        row.append(text);
        if (e.canPutBack) {
          const b = button('Put back', 'btn-accent btn-small', 'refresh');
          b.addEventListener('click', () => putBack(e));
          row.append(b);
        }
        list.append(row);
      }
    }
    historyEl.append(hd, list);
  }

  // ---------------------------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------------------------
  function switchButton(on, label, onToggle) {
    const b = h('button', `prog-switch${on ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', label);
    b.append(h('span', 'prog-knob'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await onToggle(!on); } catch (e) { toast(e?.message ?? 'Not saved', { kind: 'error' }); }
      await loadOverview();
    });
    return b;
  }

  function renderSetup() {
    body.replaceChildren();
    if (st.setupError) { body.append(errorView(st.setupError)); return; }
    const o = st.overview;
    if (!o) { body.append(h('p', 'muted prog-msg', 'Loading…')); return; }
    const master = h('div', 'prog-setting');
    const mt = h('div', 'prog-setting-text');
    mt.append(h('div', 'prog-setting-title', 'Allow program transfer'), h('div', 'muted small', 'Off on a new install. Turn it on here, then machine by machine. Monitoring works the same either way.'));
    master.append(mt, switchButton(o.enabled, 'Allow program transfer', (v) => api.settings.save({ programs: { enabled: v } })));
    body.append(master);

    const table = h('table', 'prog-table prog-setup-table');
    const hr = h('tr');
    for (const label of ['Machine', 'Data Server address', 'Login', '', 'Transfer']) hr.append(h('th', null, label));
    const thead = h('thead');
    thead.append(hr);
    const tbody = h('tbody');
    for (const m of o.machines) tbody.append(...setupRows(m, o.enabled));
    table.append(thead, tbody);
    body.append(h('h3', 'prog-h3', 'Machines'), table);
    body.append(h('p', 'note', 'Each FANUC’s Data Server login is set on the control. Logins stay on the HUD PC: never in layouts, logs or support bundles. Program transfer works only on the shop network.'));
  }

  function setupRows(m, masterOn) {
    const tr = h('tr');
    const nameTd = h('td');
    nameTd.append(h('strong', null, m.name), h('div', 'muted small', PROTOCOL_LABELS[m.protocol] ?? m.protocol ?? 'not linked'));
    const addrTd = h('td', 'prog-addr');
    const host = h('input', 'runs-select');
    host.value = m.host ?? '';
    host.placeholder = m.linkedHost ?? 'IP address';
    host.setAttribute('aria-label', `Data Server address for ${m.name}`);
    const port = h('input', 'runs-select prog-port');
    port.type = 'number';
    port.min = '1';
    port.max = '65535';
    port.value = String(m.port ?? 21);
    port.setAttribute('aria-label', `FTP port for ${m.name}`);
    const save = button('Save', 'btn-small');
    save.addEventListener('click', async () => {
      const p = Number(port.value);
      if (!Number.isInteger(p) || p < 1 || p > 65535) { toast('The port must be a number from 1 to 65535', { kind: 'error' }); return; }
      try {
        await api.settings.save({ programs: { machines: { [m.id]: { host: host.value.trim() || null, port: p } } } });
        toast(`Saved the address for ${m.name}`, { kind: 'ok' });
      } catch (e) { toast(e?.message ?? 'Not saved', { kind: 'error' }); }
      loadOverview();
    });
    // ASCII (default): the control turns line endings into its own end of block; some Data Servers need it
    const mode = h('select', 'runs-select prog-mode');
    for (const [v, label] of [['ascii', 'ASCII'], ['binary', 'Binary']]) {
      const opt = h('option', null, label);
      opt.value = v;
      mode.append(opt);
    }
    mode.value = m.transferMode === 'binary' ? 'binary' : 'ascii';
    mode.title = 'ASCII: the control converts line endings (FileZilla does the same). Binary: files go byte for byte.';
    mode.setAttribute('aria-label', `Transfer type for ${m.name}`);
    mode.addEventListener('change', async () => {
      try {
        await api.settings.save({ programs: { machines: { [m.id]: { transferMode: mode.value } } } });
        toast(`${m.name}: ${mode.value === 'binary' ? 'binary' : 'ASCII'} transfers`, { kind: 'ok' });
      } catch (e) { toast(e?.message ?? 'Not saved', { kind: 'error' }); }
      loadOverview();
    });
    // first-line previews: only while the machine is not running (default), any time, or off
    const prev = h('select', 'runs-select prog-mode');
    for (const [v, label] of [['idle', 'Previews when idle'], ['always', 'Previews any time'], ['off', 'No previews']]) {
      const opt = h('option', null, label);
      opt.value = v;
      prev.append(opt);
    }
    prev.value = ['always', 'off'].includes(m.previews) ? m.previews : 'idle';
    prev.title = 'Previews read each program once from the Data Server. "When idle" reads only while the machine is not running.';
    prev.setAttribute('aria-label', `Previews for ${m.name}`);
    prev.addEventListener('change', async () => {
      try {
        await api.settings.save({ programs: { machines: { [m.id]: { previews: prev.value } } } });
        toast(`${m.name}: ${prev.options[prev.selectedIndex].textContent.toLowerCase()}`, { kind: 'ok' });
      } catch (e) { toast(e?.message ?? 'Not saved', { kind: 'error' }); }
      loadOverview();
    });
    addrTd.append(host, port, mode, prev, save);
    const loginTd = h('td');
    if (m.loginSaved) {
      loginTd.append(h('span', 'prog-saved', 'Saved'));
      const change = button('Change', 'btn-small btn-quiet');
      change.addEventListener('click', () => { st.loginFor = m.id; render(); });
      const forget = button('Forget', 'btn-small btn-quiet');
      forget.addEventListener('click', async () => {
        try { await api.programs.forgetLogin(m.id); toast(`Forgot the login for ${m.name}`, { kind: 'ok' }); } catch (e) { toast(e?.message ?? 'Not changed', { kind: 'error' }); }
        loadOverview();
      });
      loginTd.append(change, forget);
    } else {
      const enter = button('Enter login…', 'btn-small btn-accent');
      enter.addEventListener('click', () => { st.loginFor = m.id; render(); });
      loginTd.append(enter);
    }
    const testTd = h('td');
    const test = button('Test', 'btn-small', 'refresh');
    test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        const r = await api.programs.test(m.id);
        toast(`${m.name}: logged in to ${r.host} · ${r.programs} program${r.programs === 1 ? '' : 's'} listed, nothing changed`, { kind: 'ok', timeoutMs: 8000 });
      } catch (e) { toast(`${m.name}: ${e?.message ?? 'test failed'}`, { kind: 'error', timeoutMs: 10000 }); } finally { test.disabled = false; }
    });
    testTd.append(test);
    const swTd = h('td', 'act');
    swTd.append(switchButton(m.enabled, `Program transfer on ${m.name}`, (v) => api.settings.save({ programs: { machines: { [m.id]: { enabled: v } } } })));
    if (!masterOn) swTd.title = 'Turn on "Allow program transfer" too';
    tr.append(nameTd, addrTd, loginTd, testTd, swTd);
    const rows = [tr];
    if (st.loginFor === m.id) rows.push(loginRow(m));
    return rows;
  }

  function loginRow(m) {
    const tr = h('tr', 'prog-login-row');
    const td = h('td');
    td.colSpan = 5;
    const form = h('form', 'prog-login');
    const user = h('input', 'runs-select');
    user.autocomplete = 'off';
    user.placeholder = 'User name';
    user.setAttribute('aria-label', `Data Server user name for ${m.name}`);
    const pass = h('input', 'runs-select');
    pass.type = 'password';
    pass.autocomplete = 'new-password';
    pass.placeholder = 'Password';
    pass.setAttribute('aria-label', `Data Server password for ${m.name}`);
    const ok = h('button', 'btn btn-primary btn-small', 'Save login');
    ok.type = 'submit';
    const cancel = button('Cancel', 'btn-small');
    cancel.addEventListener('click', () => { st.loginFor = null; render(); });
    form.append(h('span', 'muted small', `Login for ${m.name}'s Data Server, as set on the control`), user, pass, ok, cancel);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!user.value.trim()) { user.focus(); return; }
      ok.disabled = true;
      try {
        await api.programs.saveLogin(m.id, user.value.trim(), pass.value);
        toast(`Saved the login for ${m.name}`, { kind: 'ok' });
        st.loginFor = null;
      } catch (e) { toast(e?.message ?? 'Not saved', { kind: 'error' }); } finally { ok.disabled = false; }
      loadOverview();
    });
    td.append(form);
    tr.append(td);
    setTimeout(() => user.focus(), 0);
    return tr;
  }

  function showSetup() {
    st.view = 'setup';
    st.historyOpen = false;
    st.menuFor = null;
    renderHistory();
    render();
    loadOverview();
  }
  function showList() {
    st.view = 'list';
    render();
    st.listLoad = load();
  }

  // ---------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------
  close.addEventListener('click', () => api_close());
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (st.menuFor !== null) { closeMenu(); return; }
    if (st.historyOpen) { st.historyOpen = false; renderHistory(); return; }
    api_close();
  });
  pick.addEventListener('change', () => { st.id = pick.value; st.dir = []; st.data = null; st.error = null; st.fresh.clear(); st.history = null; render(); load(); if (st.historyOpen) loadHistory(); });
  folderBtn.addEventListener('click', () => makeFolder());
  sendBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) sendFiles(files);
  });
  refreshBtn.addEventListener('click', () => { load(); if (st.historyOpen) loadHistory(); });
  historyBtn.addEventListener('click', () => {
    st.historyOpen = !st.historyOpen;
    renderHistory();
    if (st.historyOpen) loadHistory();
  });
  setupBtn.addEventListener('click', () => (st.view === 'setup' ? showList() : showSetup()));

  function api_close() {
    if (el.hidden) return;
    el.hidden = true;
    historyEl.hidden = true;
    st.menuFor = null;
    st.menuAt = null;
    menuEl?.remove();
    menuEl = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('dragover', blockStrayDrop);
    document.removeEventListener('drop', blockStrayDrop);
    deps.onClose?.();
  }

  const panel = {
    /** Open for a machine (view 'list', or 'setup' to set transfer up). */
    open(id, { view = 'list' } = {}) {
      if (ctx().kiosk) return;
      const changed = id !== st.id;
      st.id = id ?? st.id ?? enabledIds()[0] ?? null;
      if (changed) { st.data = null; st.error = null; st.dir = []; st.fresh.clear(); st.history = null; st.historyOpen = false; }
      el.hidden = false;
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('dragover', blockStrayDrop);
      document.addEventListener('drop', blockStrayDrop);
      if (!demo && (view === 'setup' || !st.id)) showSetup(); else showList();
      renderHistory();
      close.focus({ preventScroll: true });
    },
    close: api_close,
    /** Settings changed (SSE): the setup view and the machine list follow. */
    onSettings() { if (!el.hidden) { if (st.view === 'setup') loadOverview(); else render(); } },
    get isOpen() { return !el.hidden; },
    get currentId() { return st.id; },
    /**
     * Files dropped on a machine on the dashboard (its tile, name plate or board row): open its explorer, ask once
     * which machine they go to (a tile is easy to miss by one), then send them exactly as a drop in this panel would:
     * the name and size checks, "Replace …?" for a name the machine has, read back and check. Resolves when done.
     * @param {string} id @param {File[]|FileList} files
     */
    async dropFiles(id, files) {
      const list = [...(files ?? [])].filter((f) => f && typeof f.name === 'string');
      if (ctx().kiosk || !id || !list.length) return;
      panel.open(id);
      await st.listLoad;
      // the explorer says why when it cannot list this machine (shop network only, the token, setup)
      if (el.hidden || st.id !== id || st.view !== 'list' || !st.data) return;
      if (st.sending || st.asking) { toast(`Wait until ${machineName()} has finished the current send`, { kind: 'error' }); return; }
      const shown = list.slice(0, 6).map((f) => `${f.name} (${formatBytes(f.size)})`);
      st.asking = true;
      const yes = await modal({
        heading: list.length === 1 ? `Send ${list[0].name} to ${where()}?` : `Send ${list.length} files to ${where()}?`,
        icon: 'upload',
        lines: [...shown, ...(list.length > 6 ? [`and ${list.length - 6} more`] : []),
          'Each one is read back and checked. If the machine already has a program by that name, the HUD asks before replacing it.'],
        actions: [{ label: 'Cancel', value: false }, { label: 'Send', primary: true, value: true }],
      }).finally(() => { st.asking = false; });
      if (yes && !el.hidden && st.id === id) await sendFiles(list);
    },
  };
  return panel;
}
