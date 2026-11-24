// Run report (view mode, docs/DECISIONS.md D12): program runs from GET /api/runs for a period (today, yesterday,
// 7 or 30 days) and a machine — totals, one row per program (runs, parts, average and best cycle, time) and the runs
// themselves, newest first, with Invalidate… / Count again (edit token) and a CSV download of what is shown.
// Called programs (D21): each run lists the subprograms it called and its machine macros; the shop's subprograms
// also get a row of their own in the Programs table ("called from …"), and the program search finds them.
// Loader programs (D22): a program that loads others (a pallet main) can be set as a loader for its machine from here
// (edit token); its loads are then the runs ("loaded by O0001") and its own runs are left out of the report.
// Live: SSE 'runs' events update the list while the panel is open. Every string is rendered with textContent.
import { formatDuration, formatNumber } from '/shared/format.js';
import {
  summarizeRuns, runsToCsv, runDuration, runParts, sortRuns, OUTCOME_LABELS, INVALID_REASONS, INVALID_NOTE_MAX, programKey,
  callsOf, summarizeCalls, runCalled, parseCallKey, isLoaderProgram, loadersOf, programId,
} from '/shared/runs.js';
import { iconSvg } from './icons.js';
import { formatTimeOfDay, formatSinceClock, paletteFor } from './statusStyle.js';

const PAGE = 100;
const TOP_PROGRAMS = 10;
/** Called programs named on a run's line before "+N more" (the full list is in the line's tooltip). */
const CALLS_SHOWN = 3;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
  b.append(h('span', null, label));
  return b;
}

/** Periods the report offers. */
export const RUN_RANGES = Object.freeze([
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]);

/** Local midnight of the day `days` before the one `ms` falls in (DST-safe). */
function midnight(ms, days = 0) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime();
}

/**
 * [from, to) of a period in this browser's local time; `to` null = up to now (open-ended, live).
 * @param {string} id  'today' | 'yesterday' | '7d' | '30d'
 * @param {number} now
 */
export function rangeBounds(id, now) {
  switch (id) {
    case 'today': return { from: midnight(now), to: null };
    case 'yesterday': return { from: midnight(now, 1), to: midnight(now) };
    case '30d': return { from: midnight(now, 29), to: null };
    default: return { from: midnight(now, 6), to: null };
  }
}

/** Column names on the cells, for the card layout on narrow screens (CSS shows them there only). */
function labelCells(tr, labels) {
  labels.forEach((l, i) => { if (l && tr.cells[i]) tr.cells[i].dataset.label = l; });
}

/** "3h 12m", "12m 05s"; '—' for null. */
const dur = (ms) => (finite(ms) ? formatDuration(ms) : '—');

/**
 * @param {HTMLElement} el  drawer container
 * @param {{ api: object, getContext: () => ({ now: number, settings: object, theme: string, kiosk: boolean }),
 *           getMachines: () => Array<{ id: string, name: string }>, toast?: Function, onClose?: Function,
 *           readOnly?: () => boolean }} deps  readOnly: no Invalidate… / Count again (the public demo)
 */
export function createRunsPanel(el, deps) {
  const { api, getContext, getMachines, toast, onClose, readOnly } = deps;
  let range = '7d';
  let machine = '';
  let program = null;   // programKey (or callKey) of the selected program row
  let search = '';
  let shown = PAGE;
  let allPrograms = false;
  /** @type {object[]} */
  let runs = [];
  let bounds = null;
  let enabled = true;
  let truncated = false;
  let loading = false;
  let loadError = null;
  let loadSeq = 0;
  /** SSE run updates that arrive while a load is in flight (applied after it, so they are not lost) */
  let pendingEvents = [];
  let formFor = null;
  /** the selected program's "loads other programs" question is open (D22) */
  let loaderAsk = false;
  let loaderSaving = false;
  /** @type {HTMLFormElement|null} */
  let form = null;
  let renderQueued = false;

  el.replaceChildren();
  el.classList.add('drawer', 'runs');
  el.hidden = true;
  el.setAttribute('aria-label', 'Run report');
  const head = h('header', 'drawer-head plain');
  const title = h('h2', 'd-name', 'Run report');
  const sub = h('div', 'd-sub', 'One run is one program cycle on one machine, start to end. Invalidated runs are not counted.');
  const close = h('button', 'btn btn-icon drawer-close');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close the run report');
  close.append(iconSvg('close', { size: null }));
  head.append(title, sub, close);

  const toolbar = h('div', 'runs-toolbar');
  const seg = h('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Period');
  const rangeBtns = RUN_RANGES.map((r) => {
    const b = h('button', 'seg-btn', r.label);
    b.type = 'button';
    b.dataset.range = r.id;
    b.addEventListener('click', () => { if (range !== r.id) { range = r.id; program = null; shown = PAGE; allPrograms = false; load(); } });
    seg.append(b);
    return b;
  });
  const machineSel = h('select', 'runs-select');
  machineSel.setAttribute('aria-label', 'Machine');
  machineSel.addEventListener('change', () => { machine = machineSel.value; program = null; shown = PAGE; load(); });
  const searchInput = h('input', 'runs-search');
  searchInput.type = 'search';
  searchInput.placeholder = 'Find a program';
  searchInput.setAttribute('aria-label', 'Find a program');
  searchInput.addEventListener('input', () => { search = searchInput.value.trim().toLowerCase(); shown = PAGE; queueRender(); });
  const csvBtn = button('CSV', 'btn-quiet', 'download');
  csvBtn.title = 'Download the runs shown as a spreadsheet (CSV)';
  csvBtn.addEventListener('click', downloadCsv);
  const reloadBtn = button('Reload', 'btn-quiet', 'refresh');
  reloadBtn.addEventListener('click', () => load());
  toolbar.append(seg, machineSel, searchInput, csvBtn, reloadBtn);
  const body = h('div', 'drawer-body runs-body');
  el.append(head, toolbar, body);

  close.addEventListener('click', () => hide());
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !formFor) hide(); });

  function clockOpts() {
    const d = getContext().settings?.display ?? {};
    return { clock24h: !!d.clock24h, timeZone: typeof d.timeZone === 'string' ? d.timeZone : undefined };
  }

  function hide() {
    if (el.hidden) return;
    el.hidden = true;
    formFor = null;
    form = null;
    onClose?.();
  }

  async function load() {
    const seq = ++loadSeq;
    const now = getContext().now;
    bounds = rangeBounds(range, now);
    loading = true;
    render();
    try {
      const r = await api.runs.list({ from: bounds.from, to: bounds.to ?? undefined, machine: machine || undefined });
      if (seq !== loadSeq) return;
      enabled = r?.enabled !== false;
      runs = Array.isArray(r?.runs) ? r.runs.filter(isObj) : [];
      for (const run of pendingEvents) upsert(run);
      truncated = !!r?.truncated;
      loadError = null;
    } catch (e) {
      if (seq !== loadSeq) return;
      loadError = e?.message ?? String(e);
    } finally {
      if (seq === loadSeq) { loading = false; pendingEvents = []; render(); }
    }
  }

  function inView(run) {
    if (!bounds || !finite(run?.start)) return false;
    if (machine && run.machineId !== machine) return false;
    const end = finite(run.end) ? run.end : getContext().now;
    return run.start < (bounds.to ?? Infinity) && end >= bounds.from;
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // ---- invalidation ------------------------------------------------------------------------

  function invalidForm(run) {
    if (form && formFor === run.id) return form;
    const f = h('form', 'inv-form');
    const legend = h('div', 'inv-title', `Invalidate this run of ${run.program ?? 'the program'}? It stays in the list but is not counted in runs, parts or times.`);
    const reasons = h('div', 'inv-reasons');
    reasons.setAttribute('role', 'radiogroup');
    reasons.setAttribute('aria-label', 'Reason');
    let first = null;
    for (const [value, label] of Object.entries(INVALID_REASONS)) {
      const lab = h('label', 'inv-reason');
      const input = h('input');
      input.type = 'radio';
      input.name = `inv-${run.id}`;
      input.value = value;
      if (!first) { first = input; input.checked = true; }
      lab.append(input, h('span', null, label));
      reasons.append(lab);
    }
    const note = h('input', 'inv-note');
    note.type = 'text';
    note.maxLength = INVALID_NOTE_MAX;
    note.placeholder = 'Note (what was wrong, who checked it)';
    note.setAttribute('aria-label', 'Note');
    const actions = h('div', 'dialog-actions');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = h('button', 'btn btn-primary', 'Invalidate run');
    ok.type = 'submit';
    actions.append(cancel, ok);
    f.append(legend, reasons, note, actions);
    cancel.addEventListener('click', () => { formFor = null; form = null; render(); });
    f.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); formFor = null; form = null; render(); } });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reason = f.querySelector('input[type="radio"]:checked')?.value ?? 'scrap';
      if (reason === 'other' && !note.value.trim()) { toast?.('Say why in the note', { kind: 'error' }); note.focus(); return; }
      ok.disabled = true;
      try {
        const r = await api.runs.invalidate(run.id, { reason, note: note.value.trim() });
        if (isObj(r?.run)) upsert(r.run);
        formFor = null;
        form = null;
        toast?.('Run invalidated — not counted in the totals', { kind: 'ok' });
      } catch (e) {
        toast?.(`Could not invalidate the run: ${e.message}`, { kind: 'error' });
      } finally {
        ok.disabled = false;
        render();
      }
    });
    form = f;
    formFor = run.id;
    requestAnimationFrame(() => first?.focus({ preventScroll: true }));
    return f;
  }

  async function restore(run) {
    try {
      const r = await api.runs.restore(run.id);
      if (isObj(r?.run)) upsert(r.run);
      toast?.('Run counted again', { kind: 'ok' });
    } catch (e) {
      toast?.(`Could not change the run: ${e.message}`, { kind: 'error' });
    }
    render();
  }

  function upsert(run) {
    const i = runs.findIndex((r) => r.id === run.id);
    if (i >= 0) runs[i] = run;
    else if (inView(run)) runs.push(run);
  }

  // ---- CSV ---------------------------------------------------------------------------------

  function downloadCsv() {
    const list = visibleRuns();
    if (!list.length) { toast?.('No runs to download', { kind: 'info' }); return; }
    const csv = runsToCsv(list, { now: getContext().now });
    const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const name = `runs-${day(bounds?.from ?? getContext().now)}-to-${day(bounds?.to ? bounds.to - 1 : getContext().now)}.csv`;
    try {
      const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
      const a = h('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast?.(`Could not create the file: ${e.message}`, { kind: 'error' });
    }
  }

  // ---- rendering ---------------------------------------------------------------------------

  /** Runs after the program search and the selected program row, newest first. */
  /** A run of a program that is now a loader on its machine (D22): not a run of its own, so not in the report. */
  function isLoaderRun(r) {
    return !r.loader && isLoaderProgram(loadersOf(getContext().settings, r.machineId), r.program);
  }

  function filtered() {
    let list = runs.filter((r) => inView(r) && !isLoaderRun(r));
    // the program, its comment and every program it called (subprograms and macros)
    if (search) list = list.filter((r) => `${r.program ?? ''} ${r.programComment ?? ''} ${Array.isArray(r.calls) ? r.calls.map((c) => c?.program ?? '').join(' ') : ''}`.toLowerCase().includes(search));
    return sortRuns(list);
  }
  function visibleRuns() {
    const list = filtered();
    if (!program) return list;
    const call = parseCallKey(program);
    return call ? list.filter((r) => r.machineId === call.machineId && runCalled(r, call.program)) : list.filter((r) => programKey(r) === program);
  }

  function syncToolbar() {
    for (const b of rangeBtns) b.setAttribute('aria-pressed', String(b.dataset.range === range));
    const machines = (getMachines?.() ?? []).filter((m) => m && typeof m.id === 'string');
    if (machine && !machines.some((m) => m.id === machine)) machines.push({ id: machine, name: machine }); // no longer on the plan
    const want = machines.map((m) => `${m.id}\u0001${m.name}`).join('\u0000');
    if (machineSel.dataset.sig !== want) {
      machineSel.dataset.sig = want;
      const opts = [new Option('All machines', '')];
      for (const m of machines) opts.push(new Option(m.name || m.id, m.id));
      machineSel.replaceChildren(...opts);
    }
    machineSel.value = machine;
  }

  function stat(label, value, note) {
    const s = h('div', 'stat');
    s.append(h('div', 'stat-value', value), h('div', 'stat-label', label));
    if (note) s.append(h('div', 'stat-note', note));
    return s;
  }

  function periodText(now, co) {
    if (!bounds) return '';
    const day = (ms) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(co.timeZone ? { timeZone: co.timeZone } : {}) }).format(ms);
    const to = bounds.to ?? now;
    const a = day(bounds.from);
    const b = day(to - 1);
    return a === b ? `${a}${bounds.to ? '' : `, until ${formatTimeOfDay(now, co)}`}` : `${a} – ${b}${bounds.to ? '' : ` ${formatTimeOfDay(now, co)}`}`;
  }

  function render() {
    if (el.hidden) return;
    const ctx = getContext();
    const now = ctx.now;
    const co = clockOpts();
    syncToolbar();
    csvBtn.disabled = !runs.length;
    const parts = [];
    if (!enabled) {
      parts.push(h('p', 'muted', 'The run report is turned off on this HUD server (settings: runs.enabled).'));
      body.replaceChildren(...parts);
      return;
    }
    if (loadError) parts.push(h('p', 'error', `Could not load runs: ${loadError}`));

    const list = filtered();
    const { total, programs: mains } = summarizeRuns(list, { now });
    // the shop's subprograms the runs called get rows of their own, next to the runs that called them (D21)
    const programs = [...mains, ...summarizeCalls(list).map((c) => ({ ...c, called: true, lastStart: c.last }))]
      .sort((a, b) => (b.lastStart ?? -Infinity) - (a.lastStart ?? -Infinity) || String(a.program).localeCompare(String(b.program)));
    const period = h('p', 'runs-period');
    period.append(h('span', null, periodText(now, co)));
    if (machine) period.append(h('span', 'tag', (getMachines?.() ?? []).find((m) => m.id === machine)?.name ?? machine));
    if (loading) period.append(h('span', 'muted', 'Loading…'));
    if (truncated) period.append(h('span', 'warn', 'Too many runs: only the newest 25,000 are counted — pick a shorter period or one machine.'));
    parts.push(period);

    // totals
    const stats = h('div', 'runs-stats');
    stats.append(
      stat('Runs', formatNumber(total.runs), total.open ? `${total.open} in progress` : null),
      stat('Parts', formatNumber(total.parts), total.uncounted ? `${total.uncounted} run${total.uncounted === 1 ? '' : 's'} without a count` : null),
      stat('In cycle', dur(total.runMs), total.timeMs ? `of ${dur(total.timeMs)} in runs` : null),
      stat('Invalidated', formatNumber(total.invalid), total.partsInvalid ? `${formatNumber(total.partsInvalid)} part${total.partsInvalid === 1 ? '' : 's'} not counted` : null),
    );
    parts.push(stats);

    // programs
    const ps = h('section', 'd-section');
    const ph = h('h3', null, 'Programs');
    ph.append(h('span', 'count', String(programs.length)));
    ps.append(ph);
    const lp = loaderLine();
    if (lp) ps.append(lp);
    if (!programs.length) {
      ps.append(h('p', 'muted', loading ? 'Loading…' : search ? 'No program matches.' : 'No runs in this period. A run is recorded when a machine runs a program in automatic mode; the HUD only knows the runs it has seen while it was running.'));
    } else {
      const wrap = h('div', 'table-wrap');
      const t = h('table', 'runs-table programs');
      const thead = h('thead');
      const hr = h('tr');
      for (const [c, cls] of [['Program'], ['Machine'], ['Runs', 'num'], ['Parts', 'num'], ['Avg cycle', 'num'], ['Best', 'num'], ['Time in runs', 'num'], ['Last run']]) hr.append(h('th', cls ?? null, c));
      thead.append(hr);
      const tb = h('tbody');
      const top = allPrograms || search ? programs : programs.slice(0, TOP_PROGRAMS);
      if (program && !top.some((p) => p.key === program)) { const sel = programs.find((p) => p.key === program); if (sel) top.push(sel); }
      for (const p of top) {
        if (p.called) { tb.append(calledRow(p, now, co)); continue; }
        const tr = h('tr', `prog-row${program === p.key ? ' selected' : ''}`);
        tr.tabIndex = 0;
        tr.setAttribute('aria-selected', String(program === p.key));
        tr.title = program === p.key ? 'Show all programs' : 'Show only the runs of this program';
        const name = h('td', 'prog');
        name.append(h('div', 'prog-name', p.program ?? '(no program name)'));
        if (p.programComment) name.append(h('div', 'muted prog-cmt', p.programComment));
        const runsCell = h('td', 'num', formatNumber(p.runs));
        if (p.invalid) runsCell.append(h('div', 'muted small', `+${p.invalid} invalid`));
        if (p.open) runsCell.append(h('div', 'muted small', `${p.open} in progress`));
        const none = p.runs === 0; // every run of it invalidated
        const partsCell = h('td', 'num', none || (p.uncounted && !p.parts) ? '—' : formatNumber(p.parts));
        tr.append(name, h('td', 'mach', p.machineName), runsCell, partsCell, h('td', 'num', dur(p.avgCycleMs)), h('td', 'num', dur(p.minCycleMs)),
          h('td', 'num', none ? '—' : dur(p.timeMs)), h('td', 'nowrap', p.lastStart === null ? '—' : formatSinceClock(p.lastStart, now, co)));
        labelCells(tr, ['', '', 'Runs', 'Parts', 'Avg cycle', 'Best', 'Time in runs', 'Last run']);
        const toggle = () => { program = program === p.key ? null : p.key; loaderAsk = false; shown = PAGE; render(); };
        tr.addEventListener('click', toggle);
        tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
        tb.append(tr);
      }
      t.append(thead, tb);
      wrap.append(t);
      ps.append(wrap);
      if (!search && programs.length > TOP_PROGRAMS) {
        const more = button(allPrograms ? `Show the ${TOP_PROGRAMS} most recent` : `Show all ${programs.length} programs`, 'btn-quiet');
        more.addEventListener('click', () => { allPrograms = !allPrograms; render(); });
        ps.append(more);
      }
    }
    parts.push(ps);

    // runs
    const rs = h('section', 'd-section');
    const vis = visibleRuns();
    const rh = h('h3', null, 'Runs');
    rh.append(h('span', 'count', String(vis.length)));
    let ask = null;
    if (program) {
      const sel = programs.find((p) => p.key === program);
      const all = button(`${sel?.program ?? 'Program'} · show all`, 'btn-quiet btn-chip', 'close');
      all.title = 'Show the runs of every program';
      all.addEventListener('click', () => { program = null; loaderAsk = false; render(); });
      rh.append(all);
      ask = loaderOffer(sel, vis);
      if (ask?.button) rh.append(ask.button);
    }
    rs.append(rh);
    if (ask?.form) rs.append(ask.form);
    if (vis.length) {
      const wrap = h('div', 'table-wrap');
      const t = h('table', 'runs-table runs-list');
      const thead = h('thead');
      const hr = h('tr');
      for (const [c, cls] of [['Started'], ['Machine'], ['Program'], ['Elapsed', 'num'], ['Parts', 'num'], ['Outcome'], ['', 'act']]) hr.append(h('th', cls ?? null, c));
      thead.append(hr);
      const tb = h('tbody');
      for (const r of vis.slice(0, shown)) {
        tb.append(runRow(r, now, co, ctx));
        if (formFor === r.id) {
          const fr = h('tr', 'inv-form-row');
          const td = h('td');
          td.colSpan = 7;
          td.append(invalidForm(r));
          fr.append(td);
          tb.append(fr);
        }
      }
      t.append(thead, tb);
      wrap.append(t);
      rs.append(wrap);
      if (vis.length > shown) {
        const more = button(`Show ${Math.min(PAGE, vis.length - shown)} more of ${vis.length - shown}`, 'btn-quiet');
        more.addEventListener('click', () => { shown += PAGE; render(); });
        rs.append(more);
      }
      rs.append(h('p', 'hint', 'Elapsed = start to end. The bar splits it into in cycle, paused (feed hold, M00/M01) and stopped (alarm, E-stop, no data). "≥" = the HUD started while the program was already running. Parts come from the machine’s part counter.'));
      rs.append(h('p', 'hint', 'Called = subprograms the program called (M98, M198, G65). Macros = the machine’s own macros, O8000–O9999 (tool and pallet changes, probing). Each shows how many times it was called and how long it ran itself; a subprogram’s time leaves out the macros it called. A call shorter than about a second can be missed, and the same subprogram called again with only macros in between counts once.'));
    } else if (programs.length) {
      rs.append(h('p', 'muted', 'No runs.'));
    }
    parts.push(rs);

    // keep focus and scroll across re-renders (forms survive as the same elements)
    const active = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : null;
    const scroll = body.scrollTop;
    body.replaceChildren(...parts);
    body.scrollTop = scroll;
    if (active && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  // ---- loader programs (D22) -----------------------------------------------------------------

  const canEdit = () => !getContext().kiosk && !readOnly?.();
  const machineName = (id) => (getMachines?.() ?? []).find((m) => m.id === id)?.name ?? id;

  /** Save a machine's loader programs (the whole list). */
  async function saveLoaders(machineId, list, done) {
    loaderSaving = true;
    render();
    try {
      await api.settings.save({ runs: { machines: { [machineId]: { loaders: list } } } });
      done();
    } catch (e) {
      toast?.(`Not saved: ${e.message}`, { kind: 'error' });
    } finally {
      loaderSaving = false;
      render();
    }
  }

  /** "O0001 loads programs on HMC: …" for every loader set on the machines in view, each with an undo. */
  function loaderLine() {
    const settings = getContext().settings;
    const ids = machine ? [machine] : Object.keys(settings?.runs?.machines ?? {});
    const items = ids.flatMap((id) => loadersOf(settings, id).map((p) => ({ id, p })));
    if (!items.length) return null;
    const box = h('div', 'runs-loaders');
    for (const { id, p } of items) {
      const hidden = runs.filter((r) => r.machineId === id && !r.loader && inView(r) && programId(r.program) === programId(p)).length;
      const line = h('p', 'muted small');
      line.append(h('strong', null, p), ` loads programs on ${machineName(id)}: each program it loads is a run, and ${p} itself is not counted${hidden ? ` (${hidden} earlier run${hidden === 1 ? '' : 's'} of it left out)` : ''}.`);
      if (canEdit()) {
        const undo = button(`Count ${p} as a program again`, 'btn-quiet btn-small');
        undo.disabled = loaderSaving;
        undo.addEventListener('click', () => saveLoaders(id, loadersOf(settings, id).filter((x) => programId(x) !== programId(p)), () => toast?.(`${p} is counted as a program again`, { kind: 'ok' })));
        line.append(' ', undo);
      }
      box.append(line);
    }
    return box;
  }

  /** For the selected program row: "O0001 loads other programs…" and its question (not for a loader already). */
  function loaderOffer(sel, vis) {
    if (!sel || sel.called || !sel.program || !canEdit()) return null;
    const machineId = sel.machineId;
    const settings = getContext().settings;
    if (isLoaderProgram(loadersOf(settings, machineId), sel.program) || vis.some((r) => r.loader)) return null;
    const b = button(`${sel.program} loads other programs…`, 'btn-quiet btn-chip');
    b.title = 'A pallet program that loads the part programs: count the programs it loads instead of it';
    b.setAttribute('aria-expanded', String(loaderAsk));
    b.addEventListener('click', () => { loaderAsk = !loaderAsk; render(); });
    if (!loaderAsk) return { button: b };
    const f = h('div', 'inv-form loader-form');
    f.append(h('div', 'inv-title', `Is ${sel.program} a program that loads others on ${machineName(machineId)}, such as a pallet program?`),
      h('p', 'muted small', `From now on each program it loads is a run, from when it starts to when it finishes, and ${sel.program} itself is not counted. Its earlier runs are left out of the report.`));
    const actions = h('div', 'dialog-actions');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { loaderAsk = false; render(); });
    const ok = h('button', 'btn btn-primary', `Yes, ${sel.program} loads programs`);
    ok.type = 'button';
    ok.disabled = loaderSaving;
    ok.addEventListener('click', () => saveLoaders(machineId, [...loadersOf(settings, machineId), sel.program], () => {
      loaderAsk = false;
      program = null;
      toast?.(`${sel.program} is a loader on ${machineName(machineId)}: the programs it loads are the runs`, { kind: 'ok' });
    }));
    actions.append(cancel, ok);
    f.append(actions);
    return { button: b, form: f };
  }

  /** "O1234 ×2 (36m 05s)" */
  function callText(c) {
    return `${c.program}${c.calls > 1 ? ` ×${formatNumber(c.calls)}` : ''} (${dur(c.ms)})`;
  }

  /** One line under a run's program: "Called: O1234 ×2 (36m 05s) · O5678 (45s) · +2 more". */
  function callsLine(label, list, cls, extra) {
    const items = list.slice(0, CALLS_SHOWN).map(callText);
    if (list.length > CALLS_SHOWN) items.push(`+${list.length - CALLS_SHOWN} more`);
    if (extra) items.push(extra);
    const d = h('div', `${cls} small`, `${label}: ${items.join(' · ')}`);
    d.title = [...list.map(callText), ...(extra ? [extra] : [])].join('\n');
    return d;
  }

  /**
   * A Programs row for a subprogram the runs called (D21): the runs that called it and its calls, the time it ran
   * itself; no parts or cycle times of its own (those belong to the runs that called it).
   */
  function calledRow(p, now, co) {
    const tr = h('tr', `prog-row call-row${program === p.key ? ' selected' : ''}`);
    tr.tabIndex = 0;
    tr.setAttribute('aria-selected', String(program === p.key));
    tr.title = program === p.key ? 'Show all programs' : 'Show only the runs that called this program';
    const name = h('td', 'prog');
    name.append(h('div', 'prog-name', p.program), h('div', 'muted prog-cmt', `called from ${p.callers.join(', ') || 'another program'}`));
    const runsCell = h('td', 'num', formatNumber(p.runs));
    runsCell.append(h('div', 'muted small', `${formatNumber(p.calls)} call${p.calls === 1 ? '' : 's'}`));
    tr.append(name, h('td', 'mach', p.machineName), runsCell, h('td', 'num', '—'), h('td', 'num', '—'), h('td', 'num', '—'),
      h('td', 'num', dur(p.ms)), h('td', 'nowrap', p.last === null ? '—' : formatSinceClock(p.last, now, co)));
    labelCells(tr, ['', '', 'Runs', 'Parts', 'Avg cycle', 'Best', 'Time running it', 'Last call']);
    const toggle = () => { program = program === p.key ? null : p.key; shown = PAGE; render(); };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    return tr;
  }

  function runRow(r, now, co, ctx) {
    const tr = h('tr', `run-row o-${r.outcome}${r.invalid ? ' invalid' : ''}`);
    const started = h('td', 'nowrap', `${r.startIsLowerBound ? '≥ ' : ''}${formatSinceClock(r.start, now, co)}`);
    if (r.startIsLowerBound) started.title = 'The HUD started while this program was already running: the real start is earlier';
    const prog = h('td', 'prog');
    prog.append(h('div', 'prog-name', r.program ?? '(no program name)'));
    if (r.programComment) prog.append(h('div', 'muted prog-cmt', r.programComment));
    if (r.loader) prog.append(h('div', 'muted prog-cmt prog-loaded', `loaded by ${r.loader}`));
    const cl = callsOf(r);
    const moreText = cl.more ? `+${formatNumber(cl.more.calls)} more call${cl.more.calls === 1 ? '' : 's'}` : null;
    if (cl.subs.length) prog.append(callsLine('Called', cl.subs, 'prog-calls', cl.macros.length ? null : moreText));
    if (cl.macros.length) prog.append(callsLine(`Macros ${dur(cl.macroMs)}`, cl.macros, 'prog-macros muted', moreText));

    const elapsed = runDuration(r, now);
    const el2 = h('td', 'num');
    el2.append(h('div', null, dur(elapsed)));
    const sum = (r.runMs ?? 0) + (r.pausedMs ?? 0) + (r.stoppedMs ?? 0);
    if (sum > 0) {
      const bar = h('div', 'split');
      bar.setAttribute('role', 'img');
      const label = `In cycle ${dur(r.runMs)} · paused ${dur(r.pausedMs)} · stopped ${dur(r.stoppedMs)}`;
      bar.setAttribute('aria-label', label);
      bar.title = label;
      for (const [k, st] of [['runMs', 'RUNNING'], ['pausedMs', 'PAUSED'], ['stoppedMs', 'OFFLINE']]) {
        const w = (r[k] ?? 0) / sum;
        if (w <= 0) continue;
        const s = h('span', `split-${st}`);
        s.style.width = `${(w * 100).toFixed(2)}%`;
        if (st !== 'OFFLINE') s.style.background = paletteFor(st, ctx.theme).fill ?? '';
        bar.append(s);
      }
      el2.append(bar);
    }

    const p = runParts(r);
    const partsCell = h('td', 'num', p === null ? '—' : formatNumber(p));
    if (p === null && r.outcome !== 'open') partsCell.title = 'This machine reports no part count';

    const out = h('td', 'outcome');
    const chip = h('span', `oc oc-${r.outcome}`);
    chip.append(iconSvg({ completed: 'check', aborted: 'close', open: 'play', unknown: 'info' }[r.outcome] ?? 'info', { size: null }), h('span', null, OUTCOME_LABELS[r.outcome] ?? r.outcome));
    out.append(chip);
    const why = r.outcome === 'open' ? `since ${formatTimeOfDay(r.start, co)}` : r.endReason;
    if (why) out.append(h('div', 'muted small', why));
    if (r.invalid) {
      const tag = h('div', 'inv-tag');
      tag.append(iconSvg('ban', { size: null }), h('span', null, `Invalid · ${INVALID_REASONS[r.invalid.reason] ?? r.invalid.reason}${r.invalid.note ? ` — ${r.invalid.note}` : ''}`));
      out.append(tag);
    }

    const act = h('td', 'act');
    if (!ctx.kiosk && !readOnly?.()) {
      if (r.invalid) {
        const b = button('Count again', 'btn-quiet btn-small');
        b.title = 'Make this run valid again';
        b.addEventListener('click', () => restore(r));
        act.append(b);
      } else if (formFor !== r.id) {
        const b = button('Invalidate…', 'btn-quiet btn-small', 'ban');
        b.title = 'Bad parts, a test run …: keep the run but stop counting it';
        b.addEventListener('click', () => { formFor = r.id; form = null; render(); });
        act.append(b);
      }
    }
    tr.append(started, h('td', 'mach', r.machineName ?? r.machineId), prog, el2, partsCell, out, act);
    labelCells(tr, ['', '', '', 'Elapsed', 'Parts', '', '']);
    return tr;
  }

  // open runs: their elapsed time grows
  const timer = setInterval(() => {
    if (el.hidden || formFor) return;
    if (runs.some((r) => r.outcome === 'open')) render();
  }, 15_000);

  return {
    /**
     * Open the report, optionally for one machine.
     * @param {{ machine?: string }} [opts]
     */
    async open(opts = {}) {
      if (typeof opts.machine === 'string') { machine = opts.machine; program = null; }
      el.hidden = false;
      shown = PAGE;
      render();
      await load();
      close.focus({ preventScroll: true });
    },
    close: hide,
    toggle() { if (el.hidden) this.open(); else hide(); },
    get isOpen() { return !el.hidden; },
    /** SSE 'runs': { run } */
    onEvent(data) {
      if (el.hidden || !isObj(data?.run)) return;
      if (loading) pendingEvents.push(data.run);
      upsert(data.run);
      queueRender();
    },
    refresh() { if (!el.hidden) queueRender(); },
    destroy() { clearInterval(timer); el.replaceChildren(); },
  };
}
