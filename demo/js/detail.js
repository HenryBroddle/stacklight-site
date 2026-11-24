// Machine detail drawer: status, reason and timers; active conditions (level, code, message, component, since);
// values (mode, program, parts, spindle, feed converted to settings.display.feedUnits, overrides, tool, the control's
// hour meters); device info (vendor/model/serial/protocol via describeSource); a 12-hour timeline from
// /api/machines/:id/history; today's program runs from /api/runs (D12) with a link to the run report; the machine's
// maintenance tasks that need doing (D18) with Done…; and the out-of-service toggle (token, docs/DECISIONS.md D1).
// Everything is rendered with textContent.
import { describeSource } from '/shared/sources.js';
import { formatDuration, formatNumber, formatPercent } from '/shared/format.js';
import { summarizeRuns } from '/shared/runs.js';
import { errorClassText } from '/shared/contracts.js';
import { compareTaskRows } from '/shared/maintenance.js';
import { iconSvg } from './icons.js';
import { convertFeed, formatSinceClock, formatTimeOfDay, glance, kindLabel, paletteFor, MESSAGE_ADDRESS_RE, messageLabels, messageLabel } from './statusStyle.js';
import { hoursText, hudCountNote, openDoneDialog, progressText, taskSummary } from './maintenancePanel.js';

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
 *           onPrograms?: (id: string, opts?: { view?: 'list'|'setup' }) => void,
 *           maintenance?: () => boolean, onMaintenance?: (id: string, opts?: { view?: 'list'|'setup' }) => void }} deps
 *   maintenance(): the Maintenance section shows (D18: the server has it on; not on a TV or in a preview)
 *   maintenanceReadOnly(): no maintenance writes here (default: readOnly; the demo allows them, D17)
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
  /** A warning-mark switch save is in flight (D19). */
  let warnSaving = false;
  /** @type {HTMLFormElement|null} */
  let serviceForm = null;
  /** Today's runs of the open machine: { runs, enabled } | { error } | null (loading) */
  let runsToday = null;
  let runsFor = null;
  let runsAt = 0;
  let runsLoading = false;
  /** Maintenance of the open machine (D18): { machine, available } | { error } | { hidden } | null (loading) */
  let maint = null;
  let maintFor = null;
  let maintAt = 0;
  let maintLoading = false;
  let maintAgain = false;

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

  /** The Maintenance section shows (D18): the app says the feature is on here, and never on a TV. */
  const maintOn = () => !!deps.onMaintenance && !getContext().kiosk && !!deps.maintenance?.();

  /** This machine's maintenance (GET /api/maintenance?machine=), at most once a minute unless forced (a write, an SSE event). */
  async function loadMaint(id, force = false) {
    if (!maintOn()) return;
    if (maintLoading) { if (force) maintAgain = true; return; }
    if (!force && maintFor === id && Date.now() - maintAt < 60_000) return;
    maintLoading = true;
    const settle = (value) => {
      if (currentId !== id) return;
      maint = value;
      maintFor = id;
      maintAt = Date.now();
      lastSig = '';
      render();
    };
    try {
      const r = await api.maintenance.get({ machine: id });
      const m = Array.isArray(r?.machines) ? r.machines.find((x) => x && x.id === id) : null;
      settle(r?.enabled === false || !m ? { hidden: true } : { machine: m, available: r?.available !== false });
    } catch (e) {
      // 404: an older server, or a machine that is not on the active layout; 503: turned off or unreadable
      settle(e?.status === 404 || e?.status === 503 ? { hidden: true } : { error: 'Maintenance unavailable' });
    } finally {
      maintLoading = false;
      if (maintAgain) { maintAgain = false; if (currentId) loadMaint(currentId, true); }
    }
  }

  /**
   * Maintenance (D18): up to three tasks that need doing (due, due soon, then needing a start), each with Done…, and
   * the way to all of them; "Set up maintenance…" when the machine has none.
   */
  function maintenanceSection(ctx, clockOpts) {
    if (!maintOn() || (maintFor === currentId && maint?.hidden)) return null;
    const s = h('section', 'd-section maint-section');
    s.append(h('h3', null, 'Maintenance'));
    if (!maint || maintFor !== currentId) { s.append(h('p', 'muted', 'Loading…')); return s; }
    if (maint.error) { s.append(h('p', 'muted', maint.error)); return s; }
    const m = maint.machine;
    const id = currentId;
    const o = { now: ctx.now, timeZone: clockOpts.timeZone, clock24h: clockOpts.clock24h };
    const tasks = (Array.isArray(m.tasks) ? m.tasks : []).filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
    const canWrite = maint.available && !(deps.maintenanceReadOnly ?? deps.readOnly)?.();
    if (!tasks.length) {
      s.append(h('p', 'muted', m.setUp ? 'No maintenance tasks for this machine.' : 'No maintenance tasks yet: Set up lists the ones its builder publishes.'));
      if (canWrite) {
        const b = h('button', 'btn btn-quiet mt-setup-link');
        b.type = 'button';
        b.append(iconSvg('sliders', { size: null }), h('span', null, 'Set up maintenance…'));
        b.addEventListener('click', () => deps.onMaintenance(id, { view: 'setup' }));
        s.append(b);
      }
      return s;
    }
    const top = tasks.filter((t) => ['due', 'soon', 'start'].includes(t.status?.state)).sort(compareTaskRows).slice(0, 3);
    if (top.length) {
      const ul = h('ul', 'mt-list');
      for (const t of top) {
        const li = h('li', 'mt-row');
        li.dataset.task = t.id;
        li.append(taskSummary(t, m, { ...o, onDone: canWrite ? () => maintDone(t, m) : null }));
        ul.append(li);
      }
      s.append(ul);
    } else {
      const next = tasks.filter((t) => t.status?.state === 'ok').sort(compareTaskRows)[0];
      s.append(h('p', 'mt-next', next ? `Nothing due. Next: ${next.title} · ${progressText(next, o)}` : 'Nothing due.'));
    }
    const hud = hudCountNote(m, o);
    if (hud) s.append(h('p', 'note', hud));
    const all = h('button', 'btn btn-quiet mt-all');
    all.type = 'button';
    all.append(iconSvg('oilcan', { size: null }), h('span', null, `All ${tasks.length} task${tasks.length === 1 ? '' : 's'}`));
    all.addEventListener('click', () => deps.onMaintenance(id));
    s.append(all);
    return s;
  }

  async function maintDone(task, machine) {
    const r = await openDoneDialog(task, machine, { api, toast, getContext });
    if (r && currentId === machine.id) loadMaint(machine.id, true);
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
    const sig = JSON.stringify([vm.status, vm.variant, vm.timer, vm.down, vm.attention, snap?.values, snap?.conditions, snap?.service, snap?.connection, snap?.connectionError, snap?.connectionErrorClass, snap?.device, lm, historyAt, runsAt, maintAt, maintOn(), ctx.theme, serviceFormOpen, ctx.settings?.programs, vm.badge, vm.warningsHidden, vm.overridesHidden, warnSaving, messageLabels(ctx.settings, vm.id), Math.floor(ctx.now / 30_000)]);
    if (sig === lastSig) return;
    lastSig = sig;

    // header
    const pal = vm.variant === 'status' ? paletteFor(vm.status, ctx.theme) : { fill: vm.fill, ink: vm.ink };
    head.style.setProperty('--fill', pal.fill ?? 'transparent');
    head.style.setProperty('--ink', pal.ink);
    head.className = `drawer-head st-${vm.status} v-${vm.variant}`;
    statusBadge.replaceChildren(iconSvg(vm.icon, { size: null }), h('span', null, vm.word));
    if (vm.badge === 'warning') {
      const mark = h('span', 'warn-mark', '!');
      mark.title = 'Warning on the machine';
      statusBadge.append(mark);
    }
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
        // a FANUC message (an A-area code): the name the shop gave it, and a way to name it (D19 amendment)
        const isMessage = c.level === 'WARNING' && MESSAGE_ADDRESS_RE.test(String(c.nativeCode ?? ''));
        const named = isMessage ? messageLabel(ctx.settings, vm.id, c.nativeCode) : null;
        const msg = h('td', 'msg', named ?? (c.message || (c.type ? titleCase(c.type) : '—')));
        if (isMessage && canName(ctx)) {
          const b = h('button', 'btn btn-quiet btn-small msg-name-btn', named ? 'Rename' : 'Name it');
          b.type = 'button';
          b.title = named ? `Change the name for ${c.nativeCode}` : `Give ${c.nativeCode} a name: what the control's screen says`;
          b.addEventListener('click', () => editMessageName(vm, ctx, c.nativeCode));
          msg.append(' ', b);
        }
        tr.append(lvl, h('td', 'code', val(c.nativeCode)), msg,
          h('td', null, val(c.componentName)), h('td', 'since', finite(c.since) ? glance(ctx.now - c.since) : '—'));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      const sec = section('Active alarms & warnings', table);
      const sw = warningSwitch(vm, ctx);
      if (sw) sec.append(sw);
      const names = messageNames(vm, ctx, lm);
      if (names) sec.append(names);
      parts.push(sec);
    } else if (vm.variant === 'status') {
      const sec = section('Active alarms & warnings', h('p', 'muted', 'None'));
      const sw = warningSwitch(vm, ctx);
      if (sw) sec.append(sw);
      const names = messageNames(vm, ctx, lm);
      if (names) sec.append(names);
      parts.push(sec);
    }

    // --- maintenance (D18)
    const maintSec = maintenanceSection(ctx, clockOpts);
    if (maintSec) parts.push(maintSec);

    // --- values
    const v = snap?.values ?? {};
    if (vm.variant === 'status' || vm.variant === 'service') {
      const feed = convertFeed(v.feedrate, v.feedrateUnits, display.feedUnits === 'mm/min' ? 'mm/min' : 'in/min');
      const pct = (x) => (finite(x) ? `${formatNumber(x)}%` : '—');
      const progText = [v.program, v.programComment].filter((x) => x !== null && x !== undefined && x !== '').join(' — ');
      // PROGRAM (MAIN) first; the ACTIVE (sub)program as a second line only when it differs (profile §7.8): the
      // subprogram or macro the main called, executing now (D21)
      const activeDiffers = typeof v.activeProgram === 'string' && v.activeProgram !== '' && v.activeProgram !== v.program;
      let prog = progText;
      if (activeDiffers) {
        prog = document.createDocumentFragment();
        prog.append(h('div', null, progText || '—'), h('div', 'muted', `Now in: ${v.activeProgram}`));
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
        // the control's own hour meters (D18), with or without the maintenance board
        ...(hoursText(v) ? [['Hours', hoursText(v)]] : []),
        ...(v.functionalMode ? [['Functional mode', titleCase(v.functionalMode)]] : []),
        ...(v.message ? [['Message', v.message]] : []),
      ]), ...[overrideSwitch(vm, ctx, v)].filter(Boolean)));
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

  /**
   * This machine's overrides on the board and plan (D25: the board row's label, the tile's chart): on by default; off
   * for a machine that always runs with an override set (a rapid kept at 25 %), where they would say nothing new.
   * Only for machines that report overrides.
   */
  function overrideSwitch(vm, ctx, v) {
    if (ctx.kiosk || deps.readOnly?.() || !vm.id) return null;
    const reports = ['feedOverride', 'rapidOverride', 'spindleOverride'].some((k) => finite(v?.[k]));
    if (!reports && !vm.overridesHidden) return null;
    const on = !vm.overridesHidden;
    const row = h('div', 'prog-setting warn-setting');
    const text = h('div', 'prog-setting-text');
    text.append(h('div', 'prog-setting-title', 'Overrides on the board and plan'),
      h('div', 'muted small', on
        ? 'On: while this machine runs with its feed, rapid or spindle override away from 100 %, its board row says so and its tile shows the bars.'
        : 'Off: this machine\u2019s overrides show only here.'));
    const b = h('button', `prog-switch${on ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `Overrides on the board and plan for ${vm.name}`);
    b.append(h('span', 'prog-knob'));
    b.disabled = warnSaving;
    const id = vm.id;
    b.addEventListener('click', async () => {
      warnSaving = true;
      b.disabled = true;
      try {
        await api.settings.save({ overrides: { machines: { [id]: { show: !on } } } });
        toast?.(on ? 'Overrides off the board and plan for this machine' : 'Overrides on the board and plan for this machine', { kind: 'ok' });
      } catch (e) {
        const why = e?.errors?.[0]?.message ?? e?.body?.errors?.[0]?.message;
        toast?.(`Not saved: ${e?.message ?? 'error'}${why ? ` (${why})` : ''}`, { kind: 'error', timeoutMs: why ? 9000 : undefined });
      } finally {
        warnSaving = false;
        lastSig = '';
        render();
      }
    });
    row.append(text, b);
    return row;
  }

  /**
   * Per machine (D19): whether an active warning puts the yellow mark on this machine's tile and board row. For the
   * machines that always have a notice up that nobody needs to act on. Faults and alarms are never hidden.
   */
  function warningSwitch(vm, ctx) {
    if (ctx.kiosk || deps.readOnly?.() || !vm.id) return null;
    const on = !vm.warningsHidden;
    const row = h('div', 'prog-setting warn-setting');
    const text = h('div', 'prog-setting-text');
    text.append(h('div', 'prog-setting-title', 'Warning mark on the board'),
      h('div', 'muted small', on
        ? 'On: a warning on this machine puts a yellow ! on its tile and board row.'
        : 'Off: this machine\u2019s warnings stay in this list but put no mark on the board. Alarms always show.'));
    const b = h('button', `prog-switch${on ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `Warning mark on the board for ${vm.name}`);
    b.append(h('span', 'prog-knob'));
    b.disabled = warnSaving;
    const id = vm.id;
    b.addEventListener('click', async () => {
      warnSaving = true;
      b.disabled = true;
      try {
        // only the switch: the machine's message names stay as they are
        await api.settings.save({ warnings: { machines: { [id]: { show: !on } } } });
        toast?.(on ? 'Warning mark off for this machine' : 'Warning mark on for this machine', { kind: 'ok' });
      } catch (e) {
        // the server's own reason, e.g. a HUD still running older code that does not know this setting yet
        const why = e?.errors?.[0]?.message ?? e?.body?.errors?.[0]?.message;
        toast?.(`Not saved: ${e?.message ?? 'error'}${why ? ` (${why})` : ''}`, { kind: 'error', timeoutMs: why ? 9000 : undefined });
      } finally {
        warnSaving = false;
        lastSig = '';
        render();
      }
    });
    row.append(text, b);
    return row;
  }

  /** Message names are edited where the warning switch is: on a PC, not a TV or a preview. */
  const canName = (ctx) => !ctx.kiosk && !deps.readOnly?.();

  /**
   * Names for this machine's FANUC messages (D19 amendment). A FANUC shows a message's text on its own screen only;
   * the HUD sees its address (A14.2). Most last under a minute, so names can be added for any address here, not only
   * while the message is up. FANUC machines, or any machine that already has names.
   */
  function messageNames(vm, ctx, lm) {
    if (!canName(ctx) || !vm.id) return null;
    const labels = messageLabels(ctx.settings, vm.id);
    const keys = Object.keys(labels).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (lm?.source?.protocol !== 'focas' && !keys.length) return null;
    const box = h('div', 'msg-names');
    box.append(h('div', 'prog-setting-title', 'Message names'),
      h('p', 'muted small', 'FANUC messages show as a code like A14.2. Write down what the control\u2019s screen says for each one, and every screen shows that instead.'));
    if (keys.length) {
      const list = h('div', 'msg-names-list');
      for (const k of keys) {
        const row = h('div', 'msg-names-row');
        const edit = h('button', 'btn btn-quiet btn-small', 'Edit');
        edit.type = 'button';
        edit.addEventListener('click', () => editMessageName(vm, ctx, k));
        const del = h('button', 'btn btn-quiet btn-small', 'Remove');
        del.type = 'button';
        del.addEventListener('click', () => saveMessageNames(vm, ctx, (l) => { delete l[k]; }, `Removed the name for ${k}`));
        row.append(h('span', 'code', k), h('span', 'msg-names-text', labels[k]), edit, del);
        list.append(row);
      }
      box.append(list);
    }
    const add = h('button', 'btn btn-quiet btn-small', keys.length ? 'Add another name' : 'Add a name');
    add.type = 'button';
    add.addEventListener('click', () => editMessageName(vm, ctx, null));
    box.append(add);
    return box;
  }

  /** Change this machine's names (a function edits a copy) and save them; every screen follows. */
  async function saveMessageNames(vm, ctx, change, okText) {
    const next = { ...messageLabels(ctx.settings, vm.id) };
    change(next);
    try {
      await api.settings.save({ warnings: { machines: { [vm.id]: { labels: next } } } });
      if (okText) toast?.(okText, { kind: 'ok' });
    } catch (e) {
      const why = e?.errors?.[0]?.message ?? e?.body?.errors?.[0]?.message;
      toast?.(`Not saved: ${e?.message ?? 'error'}${why ? ` (${why})` : ''}`, { kind: 'error', timeoutMs: 9000 });
    }
  }

  /** Ask for a message's address and name (address fixed when given). */
  function editMessageName(vm, ctx, address) {
    const labels = messageLabels(ctx.settings, vm.id);
    const dlg = document.createElement('dialog');
    dlg.className = 'token-dialog prog-dialog';
    const form = h('form', 'token-form');
    form.append(h('h2', null, address ? `Name ${address} on ${vm.name}` : `Name a message on ${vm.name}`));
    const addr = h('input');
    addr.value = address ?? '';
    addr.placeholder = 'A14.2';
    addr.maxLength = 7;
    addr.autocomplete = 'off';
    addr.spellcheck = false;
    addr.readOnly = !!address;
    const name = h('input');
    name.value = address ? labels[address] ?? '' : '';
    name.placeholder = 'What the control\u2019s screen says, e.g. TOOL LIFE EXPIRED';
    name.maxLength = 60;
    name.autocomplete = 'off';
    const la = h('label', 'prog-field');
    la.append(h('span', null, 'Code (as the HUD shows it)'), addr);
    const ln = h('label', 'prog-field');
    ln.append(h('span', null, 'Name'), name);
    const hint = h('p', 'muted small', 'Up to 60 characters. Leave the name empty to remove it.');
    const row = h('div', 'dialog-actions');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const save = h('button', 'btn btn-primary', 'Save');
    save.type = 'submit';
    row.append(cancel, save);
    form.append(la, ln, hint, row);
    dlg.append(form);
    const valid = () => MESSAGE_ADDRESS_RE.test(addr.value.trim().toUpperCase());
    const check = () => { save.disabled = !valid(); hint.classList.toggle('prog-warn', !!addr.value.trim() && !valid()); };
    addr.addEventListener('input', check);
    check();
    const finish = () => { try { dlg.close(); } catch { /* closed */ } dlg.remove(); };
    cancel.addEventListener('click', finish);
    dlg.addEventListener('cancel', finish);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!valid()) return;
      const k = addr.value.trim().toUpperCase();
      const v = name.value.replace(/\s+/g, ' ').trim();
      finish();
      await saveMessageNames(vm, ctx, (l) => { if (v) l[k] = v; else delete l[k]; }, v ? `${k} on ${vm.name} is now \u201c${v}\u201d` : `Removed the name for ${k}`);
    });
    document.body.append(dlg);
    dlg.showModal();
    (address ? name : addr).focus();
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
    loadMaint(currentId);
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
      if (maintFor !== id) maint = null;
      render();
      loadHistory(id, true);
      loadRuns(id, true);
      loadMaint(id, true);
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
    /** SSE 'maintenance' { machineId, counts, total }: refetch the open machine's tasks when they changed. */
    onMaintenanceEvent(data) {
      if (!currentId || el.hidden || (typeof data?.machineId === 'string' && data.machineId !== currentId)) return;
      loadMaint(currentId, true);
    },
    get currentId() { return currentId; },
    get isOpen() { return !el.hidden; },
    destroy() { clearInterval(timer); el.replaceChildren(); },
  };
}

