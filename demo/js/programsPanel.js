// Program transfer drawer (docs/DECISIONS.md D16): a File Explorer for one machine's Data Server.
//   - drag files in from the PC (or "Send files…" on phones and tablets) to send them;
//   - right-click a program (or its ⋯ button) to download it or delete it;
//   - History lists every change, with Put back for replaced and deleted programs;
//   - Setup turns transfer on, per machine, and saves each Data Server's login on the HUD PC.
// The only questions are "Replace …?" and "Delete …?"; a program in use shows a lock. Every check runs again on the
// HUD PC (src/programs/service.js); this panel asks and explains. Shop network and edit token only.
// Every string is rendered with textContent.
import { iconSvg } from './icons.js';

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
const ACTION_TEXT = Object.freeze({ sent: 'Sent', replaced: 'Replaced', downloaded: 'Downloaded', deleted: 'Deleted', putback: 'Put back' });
const RESULT_TEXT = Object.freeze({ checked: 'Read back and checked', done: 'Done', failed: 'Check failed' });

/** One History line: { title, meta } (meta without the time, which the caller formats). */
export function historyText(e) {
  if (!isObj(e)) return { title: '', meta: '' };
  const name = typeof e.name === 'string' ? e.name : '';
  let title = `${ACTION_TEXT[e.action] ?? e.action ?? ''} ${name}`.trim();
  if (e.action === 'sent') title += ' (new)';
  if (e.action === 'putback' && finite(e.restoredModified)) title += ' (an earlier copy)';
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
    fresh: new Set(), historyOpen: false, history: null, historyError: null, overview: null, setupError: null, loginFor: null,
    linesLeft: 0, asking: false,
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
      const data = await api.programs.list(st.id);
      if (seq !== loadSeq) return;
      st.data = data;
      st.error = null;
    } catch (e) {
      if (seq !== loadSeq) return;
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
    st.linesLeft = st.data?.firstLinesPending ?? 0;
    const current = () => seq === linesSeq && st.id === id && !!st.data && !el.hidden && st.view === 'list';
    while (st.linesLeft > 0 && current()) {
      if (st.sending || st.asking) break; // never alongside a send or while a question is open (one session per machine)
      let r;
      try { r = await api.programs.firstLines(id); } catch { break; }
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

  const runningWarning = (running, program, name) => (running && program && program.toUpperCase() !== String(name).toUpperCase()
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
  async function sendFiles(files) {
    if (!st.data || st.sending) return;
    const maxBytes = (st.data.maxUploadMB ?? 100) * 1024 * 1024;
    for (const f of files) {
      if (!PROGRAM_NAME_RE.test(f.name) || /^\.+$/.test(f.name)) { toast(`${f.name}: program names may use letters, digits, dot, dash and underscore (max 64), with no spaces`, { kind: 'error', timeoutMs: 8000 }); continue; }
      if (!f.size) { toast(`${f.name} is empty`, { kind: 'error' }); continue; }
      if (f.size > maxBytes) { toast(`${f.name} is larger than ${st.data.maxUploadMB ?? 100} MB`, { kind: 'error' }); continue; }
      await sendOne(f.name, f, false);
    }
    await load();
    if (st.historyOpen) loadHistory();
  }

  async function sendOne(name, blob, replace) {
    st.sending = { name, phase: replace ? 'Keeping the machine’s copy, sending, reading it back…' : 'Sending, then reading it back…' };
    render();
    let again = false;
    try {
      const r = await api.programs.upload(st.id, name, blob, { replace });
      st.fresh.add(String(r.name).toUpperCase());
      toast(`${r.action === 'replaced' ? 'Replaced' : 'Sent'} ${r.name} on ${machineName()} · read back and checked${r.note ? ' (the Data Server stored it in its own text format; see History)' : ''}`, { kind: 'ok', timeoutMs: r.note ? 9000 : undefined });
    } catch (e) {
      st.sending = null;
      render();
      if (e?.code === 'EXISTS') {
        const b = e.body ?? {};
        st.asking = true;
        const yes = await modal({
          heading: `Replace ${b.name ?? name}?`, icon: 'upload',
          lines: [`${machineName()} already has ${b.name ?? name} (${formatBytes(b.size)}, ${formatModified(b.modified, ctx().now, clockOpts())}). The HUD keeps that copy before replacing it, so you can put it back from History.`],
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
    if (again) await sendOne(name, blob, true);
  }

  async function download(f) {
    closeMenu();
    try {
      const blob = await api.programs.download(st.id, f.name);
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
      heading: `Delete ${f.name} from ${machineName()}?`, icon: 'trash',
      lines: [`${previewFromFirstLine(f.firstLine) || f.comment ? `${previewFromFirstLine(f.firstLine) || f.comment}. ` : ''}The HUD keeps a copy on the HUD PC first, so you can put it back from History.`],
      warn: runningWarning(s.running, s.program, f.name),
      actions: [{ label: 'Cancel', value: false }, { label: 'Delete', primary: true, value: true }],
    });
    if (!yes) return;
    try {
      await api.programs.remove(st.id, f.name);
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
      lines: [`This puts back the copy of ${entry.name} the HUD kept ${when}. If ${machineName()} has a newer ${entry.name}, that one is kept first, so this can be undone too.`],
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
  // Menu (right-click or ⋯)
  // ---------------------------------------------------------------------------------------------
  function openMenu(name) {
    st.menuFor = st.menuFor === name ? null : name;
    render();
    body.querySelector('.prog-menu button')?.focus();
  }
  function closeMenu() {
    if (st.menuFor === null) return;
    st.menuFor = null;
    render();
  }
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
    refreshBtn.hidden = st.view !== 'list';
    refreshBtn.disabled = st.loading;
    historyBtn.hidden = st.view !== 'list' || !st.id;
    setupBtn.querySelector('span').textContent = st.view === 'setup' ? 'Back to programs' : 'Setup';
    setupBtn.hidden = demo || (st.view === 'setup' && !st.id);
    const waiting = d?.previews?.paused && (d.firstLinesPending ?? 0) > 0 ? PREVIEW_WAIT[d.previews.paused] ?? '' : '';
    summary.textContent = listReady
      ? `${d.files.length} program${d.files.length === 1 ? '' : 's'}${st.loading ? ' · reading…' : st.linesLeft > 0 ? ` · reading previews, ${st.linesLeft} to go` : waiting ? ` · ${waiting}` : ''}`
      : (st.loading ? 'Reading the Data Server…' : '');
  }

  function render() {
    if (el.hidden) return;
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
    for (const f of d.files) tbody.append(fileRow(f));
    table.append(thead, tbody);
    if (d.files.length) body.append(table);
    else body.append(h('p', 'muted prog-msg', 'No programs on this Data Server yet.'));
    const drop = h('div', 'prog-drop');
    drop.append(iconSvg('download', { size: null }), h('span', 'prog-drop-idle', `Drag files here from your PC to send them to ${machineName()}`), h('span', 'prog-drop-active', `Drop to send to ${machineName()}`));
    body.append(drop);
    body.append(h('p', 'note', demo
      ? 'Demo: this Data Server is simulated in your browser. Nothing is sent anywhere, and the programs reset when you reload. In a shop it works only on the shop network, and the HUD never selects or starts a program.'
      : 'Works only on the shop network. The HUD never selects or starts a program, and never touches parameters, offsets or macros.'));
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
      const del = button(f.inUse ? 'Delete: in use' : 'Delete from the machine…', `prog-menu-item${f.inUse ? ' muted' : ''}`, f.inUse ? 'lock' : 'trash');
      del.setAttribute('role', 'menuitem');
      del.addEventListener('click', () => remove(f));
      menu.append(dl, del);
      menu.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); more.focus(); } });
      tdAct.append(menu);
    }
    const line = h('td', 'prog-cmt prog-line muted');
    lineCells.set(f.name, line);
    paintLine(f);
    tr.append(name, line, h('td', 'num', formatBytes(f.size)), h('td', 'muted nowrap', formatModified(f.modified, ctx().now, clockOpts())), tdAct);
    tr.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openMenu(f.name); });
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
    load();
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
  pick.addEventListener('change', () => { st.id = pick.value; st.data = null; st.error = null; st.fresh.clear(); st.history = null; render(); load(); if (st.historyOpen) loadHistory(); });
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
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('dragover', blockStrayDrop);
    document.removeEventListener('drop', blockStrayDrop);
    deps.onClose?.();
  }

  return {
    /** Open for a machine (view 'list', or 'setup' to set transfer up). */
    open(id, { view = 'list' } = {}) {
      if (ctx().kiosk) return;
      const changed = id !== st.id;
      st.id = id ?? st.id ?? enabledIds()[0] ?? null;
      if (changed) { st.data = null; st.error = null; st.fresh.clear(); st.history = null; st.historyOpen = false; }
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
  };
}
