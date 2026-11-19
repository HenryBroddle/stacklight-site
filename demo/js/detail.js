// Machine detail drawer: status, reason and timers; active conditions (level, code, message, component, since);
// values (mode, program, parts, spindle, feed converted to settings.display.feedUnits, overrides, tool); device
// info (vendor/model/serial/protocol via describeSource); a 12-hour timeline from /api/machines/:id/history; today's
// program runs from /api/runs (D12) with a link to the run report; and the out-of-service toggle (token, docs/
// DECISIONS.md D1). Everything is rendered with textContent.
import { describeSource } from '/shared/sources.js';
import { formatDuration, formatNumber, formatPercent } from '/shared/format.js';
import { summarizeRuns } from '/shared/runs.js';
import { errorClassText } from '/shared/contracts.js';
import { iconSvg } from './icons.js';
import { convertFeed, formatSinceClock, formatTimeOfDay, glance, kindLabel, paletteFor } from './statusStyle.js';

const HOUR = 3_600_000;

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const titleCase = (s) => (typeof s === 'string' && s ? s.toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : '—');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const val = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** The drawer's word for MachineSnapshot.connection; 'degraded' = failing within the offline grace, status kept. */
function connectionStateText(connection) {
  return connection === 'degraded' ? 'Connected, retrying' : titleCase(connection);
}

/** Human connection error ("Connection refused (CONNECT_REFUSED)"); tolerates older servers that sent only the class. */
function connectionErrorText(snap) {
  const text = typeof snap?.connectionError === 'string' ? snap.connectionError : '';
  const cls = typeof snap?.connectionErrorClass === 'string' ? snap.connectionErrorClass : '';
  if (!text) return cls ? errorClassText(cls) : '';
  return cls && cls !== text ? `${text} (${cls})` : text;
}

function dl(pairs) {
  const d = h('dl', 'kv');
  for (const [k, v, cls] of pairs) {
    if (v === undefined) continue;
    const dt = h('dt', null, k);
    const dd = h('dd', cls ?? null);
    if (v instanceof Node) dd.append(v); else dd.textContent = val(v);
    d.append(dt, dd);
  }
  return d;
}

/**
 * @param {HTMLElement} el  drawer container (an <aside>)
 * @param {{ api: object, getMachine: (id: string) => ({ vm: object, snapshot: object|null, layoutMachine: object|null }|null),
 *           getContext: () => ({ settings: object, now: number, theme: string, kiosk: boolean }),
 *           onClose?: Function, toast?: Function, readOnly?: () => boolean, programsMode?: () => 'full'|'use'|'off', onRunReport?: (id: string) => void,
 *           onPrograms?: (id: string, opts?: { view?: 'list'|'setup' }) => void }} deps
 */
export function createDetail(el, deps) {
  const { api, getMachine, getContext, onClose, toast } = deps;
  let currentId = null;
  let history = null;
  let historyFor = null;
  let historyAt = 0;
  let historyLoading = false;
  let lastSig = '';
  let serviceFormOpen = false;
  /** @type {HTMLFormElement|null} */
  let serviceForm = null;
  /** Today's runs of the open machine: { runs, enabled } | { error } | null (loading) */
  let runsToday = null;
  let runsFor = null;
  let runsAt = 0;
  let runsLoading = false;

  el.replaceChildren();
  el.classList.add('drawer', 'detail');
  el.hidden = true;
  el.setAttribute('aria-label', 'Machine details');
  const head = h('header', 'drawer-head');
  const statusBadge = h('div', 'd-badge');
  const nameEl = h('h2', 'd-name');
  const subEl = h('div', 'd-sub');
  const close = h('button', 'btn btn-icon drawer-close');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close details');
  close.append(iconSvg('close', { size: null }));
  head.append(statusBadge, nameEl, subEl, close);
  const body = h('div', 'drawer-body');
  el.append(head, body);
  close.addEventListener('click', () => api_close());
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') api_close(); });

  function api_close() {
    if (el.hidden) return;
    el.hidden = true;
    currentId = null;
    serviceFormOpen = false;
    serviceForm = null;
    onClose?.();
  }

  async function loadHistory(id, force = false) {
    if (historyLoading || (!force && historyFor === id && Date.now() - historyAt < 60_000)) return;
    historyLoading = true;
    try {
      const r = await api.machineHistory(id, 12);
      if (currentId === id) { history = r; historyFor = id; historyAt = Date.now(); lastSig = ''; render(); }
    } catch (e) {
      if (currentId === id) { history = { error: e?.status === 404 ? 'No history recorded yet' : 'History unavailable' }; historyFor = id; historyAt = Date.now(); lastSig = ''; render(); }
    } finally {
      historyLoading = false;
    }
  }

  async function loadRuns(id, force = false) {
    if (!deps.onRunReport || runsLoading || (!force && runsFor === id && Date.now() - runsAt < 60_000)) return;
    const runsOn = getContext().settings?.runs;
    if (!runsOn || runsOn.enabled === false) return;
    runsLoading = true;
    const d = new Date(getContext().now);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    try {
      const r = await api.runs.list({ from, machine: id });
      if (currentId === id) { runsToday = { runs: Array.isArray(r?.runs) ? r.runs : [], enabled: r?.enabled !== false, from }; runsFor = id; runsAt = Date.now(); lastSig = ''; render(); }
    } catch (e) {
      if (currentId === id) { runsToday = { error: 'Runs unavailable' }; runsFor = id; runsAt = Date.now(); lastSig = ''; render(); }
    } finally {
      runsLoading = false;
    }
  }

  function runsSection(ctx, clockOpts) {
    const runsOn = ctx.settings?.runs;
    if (!deps.onRunReport || !runsOn || runsOn.enabled === false) return null;
    const s = h('section', 'd-section runs-today');
    const t = h('h3', null, 'Runs today');
    s.append(t);
    if (!runsToday || runsFor !== currentId) { s.append(h('p', 'muted', 'Loading…')); return s; }
    if (runsToday.error) { s.append(h('p', 'muted', runsToday.error)); return s; }
    const list = runsToday.runs.filter((r) => r && (r.end === null || r.end >= runsToday.from));
    const { total } = summarizeRuns(list, { now: ctx.now });
    const open = list.find((r) => r.outcome === 'open' && !r.invalid) ?? list.find((r) => r.outcome === 'open');
    const runsText = total.runs || total.invalid
      ? `${formatNumber(total.runs)}${total.completed !== total.runs ? ` (${formatNumber(total.completed)} completed)` : ''}${total.invalid ? ` · ${formatNumber(total.invalid)} invalidated` : ''}`
      : 'None yet';
    s.append(dl([
      ['Runs', runsText],
      ['Parts', total.runs ? (total.parts || !total.uncounted ? formatNumber(total.parts) : '— (no part count)') : '—'],
      ['Average cycle', total.avgCycleMs === null ? '—' : formatDuration(total.avgCycleMs)],
      ['Current run', open ? `${open.program ?? 'Program'} · ${glance(ctx.now - open.start, !!open.startIsLowerBound)} · since ${formatSinceClock(open.start, ctx.now, clockOpts)}` : 'None'],
    ]));
    const btn = h('button', 'btn btn-quiet');
    btn.type = 'button';
    btn.append(iconSvg('report', { size: null }), h('span', null, 'Run report'));
    btn.addEventListener('click', () => deps.onRunReport?.(currentId));
    s.append(btn);
    return s;
  }

  /**
   * Programs (D16): open the machine's Data Server explorer, or set transfer up (FANUC machines, editors only).
   * deps.programsMode(): 'full' (default), 'use' (the explorer, never setup: the public demo) or 'off'.
   */
  function programsSection(ctx, lm) {
    const mode = deps.programsMode?.() ?? (deps.readOnly?.() ? 'off' : 'full');
    if (!deps.onPrograms || ctx.kiosk || mode === 'off') return null;
    const p = ctx.settings?.programs;
    const on = !!(p?.enabled && p.machines?.[currentId]?.enabled);
    if (!on && (mode !== 'full' || lm?.source?.protocol !== 'focas')) return null;
    const s = h('section', 'd-section programs-section');
    s.append(h('h3', null, 'Programs'));
    s.append(h('p', 'muted', on ? 'Send, download and delete programs on this machine\u2019s Data Server.' : 'Program transfer is not set up for this machine.'));
    const btn = h('button', 'btn btn-quiet');
    btn.type = 'button';
    btn.append(iconSvg(on ? 'file' : 'sliders', { size: null }), h('span', null, on ? 'Programs' : 'Set up…'));
    btn.addEventListener('click', () => deps.onPrograms(currentId, on ? undefined : { view: 'setup' }));
    s.append(btn);
    return s;
  }

  function section(title, ...children) {
    const s = h('section', 'd-section');
    if (title) s.append(h('h3', null, title));
    s.append(...children);
    return s;
  }

  function render() {
    if (!currentId) return;
    const m = getMachine(currentId);
    if (!m) { api_close(); return; }
    const ctx = getContext();
    const { vm, snapshot: snap, layoutMachine: lm } = m;
    const display = ctx.settings?.display ?? {};
    const clockOpts = { clock24h: !!display.clock24h, timeZone: typeof display.timeZone === 'string' ? display.timeZone : undefined };
    const sig = JSON.stringify([vm.status, vm.variant, vm.timer, vm.down, vm.attention, snap?.values, snap?.conditions, snap?.service, snap?.connection, snap?.connectionError, snap?.connectionErrorClass, snap?.device, lm, historyAt, runsAt, ctx.theme, serviceFormOpen, ctx.settings?.programs, Math.floor(ctx.now / 30_000)]);
    if (sig === lastSig) return;
    lastSig = sig;

    // header
    const pal = vm.variant === 'status' ? paletteFor(vm.status, ctx.theme) : { fill: vm.fill, ink: vm.ink };
    head.style.setProperty('--fill', pal.fill ?? 'transparent');
    head.style.setProperty('--ink', pal.ink);
    head.className = `drawer-head st-${vm.status} v-${vm.variant}`;
    statusBadge.replaceChildren(iconSvg(vm.icon, { size: null }), h('span', null, vm.word));
    nameEl.textContent = vm.name;
    subEl.textContent = [kindLabel(vm.kind), lm?.source ? describeSource(lm.source) : 'Not linked'].join(' · ');

    const parts = [];
    // --- status
    const statusPairs = [];
    statusPairs.push(['Status', [vm.word, snap?.reason && snap.reason.toUpperCase() !== vm.word ? snap.reason : null].filter(Boolean).join(' — ')]);
    if (finite(snap?.since)) {
      const t = `${glance(ctx.now - snap.since, !!snap.sinceIsLowerBound)} · since ${formatSinceClock(snap.since, ctx.now, clockOpts)}`;
      statusPairs.push(['In this status', t]);
    }
    if (finite(snap?.stoppedSince) && vm.status !== 'RUNNING') {
      statusPairs.push(['Stopped for', `${glance(ctx.now - snap.stoppedSince, !!snap.stoppedSinceIsLowerBound)} · since ${formatSinceClock(snap.stoppedSince, ctx.now, clockOpts)}`]);
    }
    if (finite(snap?.lastRunningAt) && vm.status !== 'RUNNING') statusPairs.push(['Last running', formatSinceClock(snap.lastRunningAt, ctx.now, clockOpts)]);
    if (vm.attention.level > 0) statusPairs.push(['Needs attention', vm.attention.reason, 'attn']);
    else if (!vm.inShift) statusPairs.push(['Shift', 'Outside shift hours — no attention alerts']);
    const lowerBound = snap?.sinceIsLowerBound || snap?.stoppedSinceIsLowerBound;
    const statusSec = section(null, dl(statusPairs));
    if (lowerBound) statusSec.append(h('p', 'note', '≥ — the HUD started (or the agent restarted) while the machine was already in this state, so the exact start is unknown.'));
    parts.push(statusSec);

    // --- out of service
    parts.push(serviceSection(snap, lm, ctx, clockOpts));

    // --- conditions
    const conds = Array.isArray(snap?.conditions) ? snap.conditions : [];
    if (conds.length) {
      const table = h('table', 'conds');
      const thead = h('thead');
      const hr = h('tr');
      for (const c of ['Level', 'Code', 'Message', 'Component', 'Since']) hr.append(h('th', null, c));
      thead.append(hr);
      const tbody = h('tbody');
      const sorted = [...conds].sort((a, b) => (a.level === b.level ? (a.since ?? 0) - (b.since ?? 0) : a.level === 'FAULT' ? -1 : 1));
      for (const c of sorted) {
        const tr = h('tr', `cond-${String(c.level).toLowerCase()}`);
        const lvl = h('td');
        lvl.append(h('span', `lvl lvl-${String(c.level).toLowerCase()}`, c.level === 'FAULT' ? 'FAULT' : c.level === 'WARNING' ? 'WARNING' : val(c.level)));
        tr.append(lvl, h('td', 'code', val(c.nativeCode)), h('td', 'msg', c.message || (c.type ? titleCase(c.type) : '—')),
          h('td', null, val(c.componentName)), h('td', 'since', finite(c.since) ? glance(ctx.now - c.since) : '—'));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      parts.push(section('Active alarms & warnings', table));
    } else if (vm.variant === 'status') {
      parts.push(section('Active alarms & warnings', h('p', 'muted', 'None')));
    }

    // --- values
    const v = snap?.values ?? {};
    if (vm.variant === 'status' || vm.variant === 'service') {
      const feed = convertFeed(v.feedrate, v.feedrateUnits, display.feedUnits === 'mm/min' ? 'mm/min' : 'in/min');
      const pct = (x) => (finite(x) ? `${formatNumber(x)}%` : '—');
      const progText = [v.program, v.programComment].filter((x) => x !== null && x !== undefined && x !== '').join(' — ');
      // PROGRAM (MAIN) first; the ACTIVE (sub)program as a second line only when it differs (profile §7.8).
      const activeDiffers = typeof v.activeProgram === 'string' && v.activeProgram !== '' && v.activeProgram !== v.program;
      let prog = progText;
      if (activeDiffers) {
        prog = document.createDocumentFragment();
        prog.append(h('div', null, progText || '—'), h('div', 'muted', `Active: ${v.activeProgram}`));
      }
      parts.push(section('Machine', dl([
        ['Mode', titleCase(v.controllerMode)],
        ['Execution', titleCase(v.execution)],
        ['Program', prog || '—'],
        ['Line', v.line],
        ['Parts', finite(v.partCount) ? formatNumber(v.partCount) : v.partCount],
        ['Tool', v.toolNumber],
        ['Spindle', finite(v.spindleSpeed) ? `${formatNumber(v.spindleSpeed)} rpm` : v.spindleSpeed],
        ['Spindle load', finite(v.spindleLoad) ? `${formatNumber(v.spindleLoad)}%` : v.spindleLoad],
        ['Feed', feed.value === null ? '—' : `${feed.text} ${feed.units}`],
        ['Overrides', `Feed ${pct(v.feedOverride)} · Rapid ${pct(v.rapidOverride)} · Spindle ${pct(v.spindleOverride)}`],
        ['E-stop', titleCase(v.emergencyStop)],
        ['Availability', titleCase(v.availability)],
        ...(v.functionalMode ? [['Functional mode', titleCase(v.functionalMode)]] : []),
        ...(v.message ? [['Message', v.message]] : []),
      ])));
    }

    // --- program transfer (D16)
    const programs = programsSection(ctx, lm);
    if (programs) parts.push(programs);

    // --- runs today, timeline
    const runs = runsSection(ctx, clockOpts);
    if (runs) parts.push(runs);
    parts.push(timelineSection(ctx, clockOpts));

    // --- device
    const dev = snap?.device ?? null;
    const b = snap?.binding ?? null;
    const axes = dev?.axes ? [...(dev.axes.linear ?? []), ...(dev.axes.rotary ?? [])].join(' ') : '';
    parts.push(section('Device', dl([
      ['Connection', lm?.source ? describeSource(lm.source) : 'Not linked to a network device'],
      ['State', snap ? [connectionStateText(snap.connection), connectionErrorText(snap)].filter((x) => x && x !== '—').join(' — ') : '—'],
      ['Vendor', dev?.manufacturer ?? lm?.source?.vendor ?? '—'],
      ['Model', dev?.model],
      ['Serial', dev?.serialNumber],
      ['Device', b?.deviceName ?? dev?.name],
      ['UUID', dev?.uuid ?? b?.deviceUuid, 'mono'],
      ['MTConnect', dev?.mtconnectVersion],
      ['Detected kind', dev?.inferredKind ? `${dev.inferredKind}${axes ? ` (${axes})` : ''}` : undefined],
      ['Updated', finite(snap?.updatedAt) ? formatSinceClock(snap.updatedAt, ctx.now, clockOpts) : '—'],
    ])));
    if (typeof lm?.notes === 'string' && lm.notes.trim()) parts.push(section('Notes', h('p', 'notes', lm.notes)));
    parts.push(h('p', 'disclaimer', 'Informational display — not a safety system. Always check the machine itself.'));
    const active = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : null;
    const sel = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = body.scrollTop;
    body.replaceChildren(...parts);
    body.scrollTop = scroll;
    if (active && active.isConnected && document.activeElement !== active) {
      active.focus({ preventScroll: true });
      if (sel) { try { active.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
    }
  }

  function serviceSection(snap, lm, ctx, clockOpts) {
    const s = h('section', 'd-section service');
    const svc = snap?.service;
    const active = svc && (svc.until === null || svc.until === undefined || svc.until > ctx.now);
    const readOnly = ctx.kiosk || deps.readOnly?.();
    if (active) {
      s.append(h('h3', null, 'Out of service'));
      s.append(h('p', null, `${svc.until ? `Until ${formatSinceClock(svc.until, ctx.now, clockOpts)}` : 'Until further notice'}${svc.note ? ` — ${svc.note}` : ''}`));
      if (!readOnly) {
        const btn = h('button', 'btn', 'Return to service');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await api.machineService.clear(currentId); toast?.('Returned to service', { kind: 'ok' }); }
          catch (e) { toast?.(`Could not update: ${e.message}`, { kind: 'error' }); }
          finally { btn.disabled = false; }
        });
        s.append(btn);
      }
      return s;
    }
    if (readOnly || vm_isUnbound(snap, lm)) return s;
    if (!serviceFormOpen) {
      serviceForm = null;
      const btn = h('button', 'btn btn-quiet');
      btn.type = 'button';
      btn.append(iconSvg('ban', { size: null }), h('span', null, 'Mark out of service…'));
      btn.addEventListener('click', () => { serviceFormOpen = true; lastSig = ''; render(); });
      s.append(btn);
      return s;
    }
    s.append(serviceFormElement());
    return s;
  }

  /** The out-of-service form persists across re-renders so typed text and focus survive live updates. */
  function serviceFormElement() {
    if (serviceForm) return serviceForm;
    const form = h('form', 'service-form');
    form.append(h('h3', null, 'Mark out of service'));
    const note = h('input');
    note.type = 'text';
    note.maxLength = 200;
    note.placeholder = 'Reason (e.g. waiting on spindle rebuild)';
    note.setAttribute('aria-label', 'Reason');
    const untilLabel = h('label', 'field');
    const until = h('input');
    until.type = 'datetime-local';
    untilLabel.append(h('span', null, 'Until (optional)'), until);
    const actions = h('div', 'dialog-actions');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = h('button', 'btn btn-primary', 'Mark out of service');
    ok.type = 'submit';
    actions.append(cancel, ok);
    form.append(note, untilLabel, actions);
    const id = currentId;
    cancel.addEventListener('click', () => { serviceFormOpen = false; serviceForm = null; lastSig = ''; render(); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const untilMs = until.value ? new Date(until.value).getTime() : null;
      if (untilMs !== null && !(untilMs > Date.now())) { toast?.('"Until" must be in the future', { kind: 'error' }); return; }
      ok.disabled = true;
      try {
        await api.machineService.set(id, { until: untilMs, note: note.value.trim() });
        if (currentId === id) { serviceFormOpen = false; serviceForm = null; lastSig = ''; render(); }
        toast?.('Marked out of service', { kind: 'ok' });
      } catch (e) {
        toast?.(`Could not update: ${e.message}`, { kind: 'error' });
      } finally { ok.disabled = false; }
    });
    serviceForm = form;
    setTimeout(() => note.focus(), 0);
    return form;
  }
  const vm_isUnbound = (snap, lm) => (snap?.status ?? (lm?.source ? 'OFFLINE' : 'UNBOUND')) === 'UNBOUND';

  function timelineSection(ctx, clockOpts) {
    const s = h('section', 'd-section timeline');
    s.append(h('h3', null, 'Last 12 hours'));
    if (!history || historyFor !== currentId) { s.append(h('p', 'muted', 'Loading…')); return s; }
    if (history.error) { s.append(h('p', 'muted', history.error)); return s; }
    const to = ctx.now;
    const from = to - 12 * HOUR;
    const bar = h('div', 'tl-bar');
    bar.setAttribute('role', 'img');
    const segs = Array.isArray(history.timeline) ? history.timeline : [];
    let runMs = 0, knownMs = 0;
    for (const seg of segs) {
      const a = Math.max(from, finite(seg?.from) ? seg.from : from);
      const b = Math.min(to, finite(seg?.to) ? seg.to : to);
      if (!(b > a)) continue;
      const st = typeof seg.status === 'string' ? seg.status : 'UNAVAILABLE';
      const pal = paletteFor(st, ctx.theme);
      const d = h('span', `tl-seg st-${st}`);
      d.style.left = `${((a - from) / (to - from)) * 100}%`;
      d.style.width = `${((b - a) / (to - from)) * 100}%`;
      d.style.setProperty('--fill', pal.fill ?? 'transparent');
      d.title = `${pal.word} · ${formatTimeOfDay(a, clockOpts)}–${formatTimeOfDay(b, clockOpts)}${seg.reason ? ` · ${seg.reason}` : ''}`;
      bar.append(d);
      if (st !== 'UNBOUND') { knownMs += b - a; if (st === 'RUNNING') runMs += b - a; }
    }
    const axis = h('div', 'tl-axis');
    // ticks on whole hours, every 2 h; labels too close to the ends are skipped
    const first = new Date(from);
    first.setMinutes(0, 0, 0);
    if (first.getTime() < from) first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t <= to; t += HOUR) {
      if (new Date(t).getHours() % 2 !== 0) continue;
      const pos = (t - from) / (to - from);
      if (pos < 0.04 || pos > 0.96) continue;
      const tick = h('span', 'tl-tick', formatTimeOfDay(t, clockOpts).replace(':00', ''));
      tick.style.left = `${pos * 100}%`;
      axis.append(tick);
    }
    const nowTick = h('span', 'tl-tick tl-now', 'now');
    nowTick.style.left = '100%';
    axis.append(nowTick);
    let util = null;
    const u = history.utilization;
    if (u && typeof u === 'object' && finite(u.RUNNING)) {
      const total = Object.entries(u).reduce((acc, [k, ms]) => (k !== 'UNBOUND' && finite(ms) ? acc + ms : acc), 0);
      util = total > 0 ? u.RUNNING / total : null;
    } else if (knownMs > 0) util = runMs / knownMs;
    bar.setAttribute('aria-label', util === null ? 'Status timeline' : `Running ${formatPercent(util)} of the last 12 hours`);
    s.append(bar, axis);
    s.append(h('p', 'tl-util', util === null ? 'No status history in this window' : `Running ${formatPercent(util)} of the last 12 hours`));
    return s;
  }

  const timer = setInterval(() => {
    if (!currentId || el.hidden) return;
    render();
    loadHistory(currentId);
    loadRuns(currentId);
  }, 1000);

  return {
    /** Open the drawer for a machine id. */
    open(id) {
      if (getContext().kiosk) return;
      currentId = id;
      serviceFormOpen = false;
      serviceForm = null;
      lastSig = '';
      el.hidden = false;
      if (historyFor !== id) history = null;
      if (runsFor !== id) runsToday = null;
      render();
      loadHistory(id, true);
      loadRuns(id, true);
      close.focus({ preventScroll: true });
    },
    close: api_close,
    /** Re-render if anything changed (called on machine updates). */
    refresh() { if (currentId) render(); },
    /** SSE 'runs' { run }: keep today's runs of the open machine current. */
    onRunEvent(data) {
      const run = data?.run;
      if (!currentId || !runsToday?.runs || !run || run.machineId !== currentId) return;
      const i = runsToday.runs.findIndex((r) => r.id === run.id);
      if (i >= 0) runsToday.runs[i] = run; else runsToday.runs.push(run);
      runsAt = Date.now();
      lastSig = '';
      render();
    },
    get currentId() { return currentId; },
    get isOpen() { return !el.hidden; },
    destroy() { clearInterval(timer); el.replaceChildren(); },
  };
}

