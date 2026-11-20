// Maintenance board service (DECISIONS D18): the shop's tasks per machine, their due status from the meter ledger and
// the calendar, alarm triggers, Set up from the catalog, Done, and the log. Storage: src/maintenance/store.js; meters:
// src/maintenance/meters.js; due arithmetic and catalog matching: src/shared/maintenance.js (shared with the browser).
//
// Fed like the run report: observe(snap) on every registry 'machine' event of the active layout, tick(snapshots) every
// 60 s, shiftTime() on a clock step. It emits 'change' { machineId, counts, total } after a write, an alarm trigger, or
// a state change found by the tick, at most once per machine every CHANGE_MIN_MS. The ledger counts even when the
// feature is off, so turning it on later still finds the HUD's hours.
// No Node-only imports: the public demo (D17) runs this same service in the visitor's browser, with a store kept in
// browser storage (scripts/demo-site/maintenance.js).
import {
  taskStatus, countStates, compareTaskRows, describeInterval, alarmMatches, suggestModel, controlFor, catalogTasksFor,
  taskSourceFromCatalog, sourceLink, parseTaskInput, parseDoneBody, parseSetupBody, checkTaskShape, BASIS_CHAIN, METERS,
  METER_BASES, MAINT_TASK_ID_RE, TASKS_PER_MACHINE_MAX, normalizeEvery, CALENDAR_UNITS,
} from '/shared/maintenance.js';

export const CHANGE_MIN_MS = 10_000;
export const METERS_SAVE_MS = 5 * 60_000;
/** Protocols whose conditions carry the control's alarm numbers (Haas MDC reports only "an alarm is on"). */
const ALARM_CODE_PROTOCOLS = new Set(['focas', 'mtconnect', 'opcua']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;

export class MaintenanceError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** t-<time, base 36>-<random, base 36> */
export function newTaskId(now) {
  const r = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  return `t-${Math.max(0, Math.floor(now)).toString(36).slice(-12)}-${r.toString(36).slice(0, 8)}`;
}

/**
 * @param {{ getSettings: () => object, listMachines: () => object[], getSnapshot: (id: string) => object|null,
 *           store: ReturnType<import('./store.js').createMaintenanceStore>, ledger: import('./meters.js').MeterLedger,
 *           catalog: object, now?: () => number, logger?: object }} deps
 */
export function createMaintenanceService({ getSettings, listMachines, getSnapshot, store, ledger, catalog, now = Date.now, logger = null }) {
  /** 'change' listeners (a minimal emitter, so this runs in a browser too) */
  const listeners = new Set();
  const events = {
    on: (name, fn) => { if (name === 'change' && typeof fn === 'function') listeners.add(fn); },
    off: (name, fn) => { if (name === 'change') listeners.delete(fn); },
    emit: (name, e) => { if (name === 'change') for (const fn of [...listeners]) { try { fn(e); } catch (err) { logger?.warn?.('maintenance change listener failed', { err }); } } },
  };
  /** @type {{ version: 1, machines: object[] }|null} */
  let plan = null;
  let planError = null;
  let lastMetersSave = now();
  let closed = false;
  /** machineId → signature of its task states (for 'change' on the tick) */
  const lastSig = new Map();
  /** machineId → { at, timer } */
  const throttle = new Map();
  let planWrite = Promise.resolve();

  const settings = () => getSettings()?.maintenance ?? { enabled: true, dueSoonPercent: 10 };
  const enabled = () => settings().enabled !== false;
  const soonPercent = () => (finite(settings().dueSoonPercent) ? settings().dueSoonPercent : 10);
  const machines = () => (listMachines() ?? []).filter((m) => isObj(m) && typeof m.id === 'string');
  const layoutMachine = (id) => machines().find((m) => m.id === id) ?? null;
  const planEntry = (id) => plan?.machines.find((m) => m.id === id) ?? null;

  ledger.onEvent = (e) => {
    const hours = (s) => (finite(s) ? round2(s / 3600) : null);
    store.appendLog({ machineId: e.machineId, action: `meter-${e.kind}`, meter: e.meter, before: hours(e.from), after: hours(e.to), added: hours(e.added ?? 0) })
      .catch((err) => logger?.warn?.('cannot write the maintenance log', { err }));
  };

  async function init() {
    try {
      plan = await store.readPlan();
      planError = null;
    } catch (e) {
      if (e?.code !== 'MAINTENANCE_UNAVAILABLE') throw e; // the store's PlanUnavailableError
      plan = null;
      planError = e;
      logger?.error?.('maintenance plan unavailable; fix or remove the file (it is left untouched)', { file: store.planFile, err: e.message });
    }
    const saved = await store.readMeters();
    if (saved) ledger.load(saved);
    return { available: !!plan };
  }

  // --------------------------------------------------------------------------------------------------------------
  // Machines and the catalog
  // --------------------------------------------------------------------------------------------------------------
  function machineInfo(lm, snap) {
    return {
      name: lm?.name ?? '', notes: typeof lm?.notes === 'string' ? lm.notes : '', kind: lm?.kind ?? null,
      manufacturer: snap?.device?.manufacturer ?? lm?.source?.vendor ?? null, model: snap?.device?.model ?? null,
    };
  }
  const modelById = (id) => (catalog.models ?? []).find((m) => m.id === id) ?? null;
  const controlById = (id) => (catalog.controls ?? []).find((c) => c.id === id) ?? null;
  const sourceById = (id) => (catalog.sources ?? []).find((s) => s.id === id) ?? null;

  /** The model and control a machine's tasks come from: its chosen model, else the suggestion (shown, not applied). */
  function resolveModel(lm, snap, entry, modelOverride = undefined) {
    const info = machineInfo(lm, snap);
    const suggested = suggestModel(catalog, info);
    const chosen = entry?.model && modelById(entry.model) ? entry.model : null;
    const modelId = modelOverride !== undefined ? (modelOverride && modelById(modelOverride) ? modelOverride : null) : chosen ?? suggested;
    const controlId = controlFor(catalog, info, modelId);
    return { info, suggested, chosen, modelId, controlId };
  }

  function documentsFor(entries, model) {
    const ids = [];
    for (const e of entries) if (!ids.includes(e.source.ref)) ids.push(e.source.ref);
    if (model?.service && !ids.includes(model.service)) ids.push(model.service);
    return ids.map(sourceById).filter(Boolean).map((s) => ({
      title: s.title, number: s.number ?? null, edition: s.edition ?? null, publisher: s.publisher, host: s.host ?? null,
      url: s.url ?? s.pageUrl ?? null, appliesTo: s.appliesTo ?? null, note: s.note ?? null,
    }));
  }

  function modelExtras(model) {
    if (!model) return { note: null, service: null, facts: [] };
    const svc = model.service ? sourceById(model.service) : null;
    return {
      note: model.note ?? null,
      service: svc ? { title: svc.title, publisher: svc.publisher, url: svc.url ?? null } : null,
      facts: (model.facts ?? []).map((f) => {
        const s = sourceById(f.source);
        return { label: f.label, value: f.value, source: s ? `${s.publisher}, ${s.title}` : null, url: s?.url ?? null };
      }),
    };
  }

  // --------------------------------------------------------------------------------------------------------------
  // Views
  // --------------------------------------------------------------------------------------------------------------
  function meterView(id) {
    const out = {};
    for (const [key, m] of Object.entries(ledger.meters(id))) {
      const control = METERS[key]?.source === 'control';
      out[key] = control
        ? { hours: round2(m.total / 3600), raw: round2(m.raw / 3600), at: m.at, stale: !!m.stale, since: m.since, source: 'control' }
        : { hours: round2(m.total / 3600), at: m.at, since: m.since, source: 'hud' };
    }
    return out;
  }

  function publicTask(t) {
    const { last, ...rest } = t;
    return { ...rest, last: last ? { at: last.at, how: last.how, note: last.note ?? null, estimated: !!last.estimated } : null };
  }

  function statusCtx(id, t) {
    return { now: t, meters: ledger.meters(id), pace: ledger.pace(id), soonPercent: soonPercent() };
  }

  function taskRows(id, entry, t) {
    const ctx = statusCtx(id, t);
    return (entry?.tasks ?? []).map((task) => ({ ...publicTask(task), interval: describeInterval(task), status: taskStatus(task, ctx) })).sort(compareTaskRows);
  }

  function machineView(lm, t) {
    const snap = getSnapshot(lm.id);
    const entry = planEntry(lm.id);
    const { suggested, chosen, controlId, modelId } = resolveModel(lm, snap, entry);
    const offered = catalogTasksFor(catalog, { modelId, controlId });
    const known = new Set([...(entry?.tasks ?? []).map((x) => x.catalogId).filter(Boolean), ...(entry?.reviewed ?? [])]);
    const tasks = plan ? taskRows(lm.id, entry, t) : [];
    const model = chosen ? modelById(chosen) : null;
    const control = controlId ? controlById(controlId) : null;
    return {
      id: lm.id, name: lm.name ?? lm.id, kind: lm.kind ?? null,
      setUp: !!entry && (entry.reviewed.length > 0 || entry.tasks.length > 0),
      model: model ? { id: model.id, label: model.label } : null,
      suggested: suggested ? { id: suggested, label: modelById(suggested)?.label ?? suggested } : null,
      control: control ? { id: control.id, label: control.label } : null,
      ...modelExtras(modelById(modelId)),
      newSuggestions: offered.filter((e) => !known.has(e.id)).length,
      alarmCodes: ALARM_CODE_PROTOCOLS.has(lm.source?.protocol),
      meters: meterView(lm.id),
      pace: Object.fromEntries(Object.entries(ledger.pace(lm.id)).map(([k, v]) => [k, round2(v)])),
      counts: countStates(tasks.map((x) => x.status)),
      documents: documentsFor(offered, modelById(modelId)),
      tasks,
    };
  }

  function zeroCounts() { return countStates([]); }

  /** GET /api/maintenance */
  function overview({ machineId = null } = {}) {
    const t = now();
    const base = { enabled: enabled(), available: !!plan, catalogVersion: catalog.version ?? null, soonPercent: soonPercent(), now: t };
    if (!enabled()) return { ...base, counts: zeroCounts(), machines: [] };
    let list = machines();
    if (machineId !== null) {
      list = list.filter((m) => m.id === machineId);
      if (!list.length) throw new MaintenanceError(404, 'NOT_FOUND', 'No such machine on the active layout');
    }
    const views = list.map((lm) => machineView(lm, t));
    const counts = zeroCounts();
    for (const v of views) for (const k of Object.keys(counts)) counts[k] += v.counts[k] ?? 0;
    return { ...base, counts, machines: views };
  }

  /** Counts over every machine of the active layout (GET /api/state, the top-bar badge). */
  function counts() {
    if (!enabled() || !plan) return zeroCounts();
    const t = now();
    const all = [];
    for (const lm of machines()) {
      const ctx = statusCtx(lm.id, t);
      for (const task of planEntry(lm.id)?.tasks ?? []) all.push(taskStatus(task, ctx));
    }
    return countStates(all);
  }

  function machineCounts(id, t = now()) {
    const ctx = statusCtx(id, t);
    return countStates((planEntry(id)?.tasks ?? []).map((task) => taskStatus(task, ctx)));
  }

  /** GET /api/maintenance/catalog?machine=&model= */
  function catalogFor(machineId, { model } = {}) {
    const lm = requireMachine(machineId);
    const snap = getSnapshot(machineId);
    const entry = planEntry(machineId);
    if (model !== undefined && model !== null && !modelById(model)) throw new MaintenanceError(400, 'INVALID', `Unknown model "${String(model).slice(0, 64)}"`);
    const { suggested, modelId, controlId } = resolveModel(lm, snap, entry, model === undefined ? undefined : model);
    const reviewed = entry?.reviewed ?? [];
    const byCatalogId = new Map((entry?.tasks ?? []).filter((x) => x.catalogId).map((x) => [x.catalogId, x]));
    const entries = catalogTasksFor(catalog, { modelId, controlId }).map((e) => {
      const task = byCatalogId.get(e.id) ?? null;
      const added = !!task;
      return {
        id: e.id, title: e.title, action: e.action, kind: e.kind, basis: e.basis ?? null, every: task?.every ?? e.every ?? null,
        orEvery: task ? task.orEvery ?? null : e.orEvery ?? null, alarm: e.alarm ?? null, interval: describeInterval(task ?? e),
        scope: e.scope, ifEquipped: e.ifEquipped ?? null, suggest: e.suggest, source: taskSourceFromCatalog(catalog, e),
        added, enabled: added ? task.enabled !== false : false, taskId: task?.id ?? null,
        preChecked: added ? task.enabled !== false : !reviewed.includes(e.id) && e.suggest,
      };
    });
    const control = controlId ? controlById(controlId) : null;
    return {
      version: catalog.version ?? null, about: catalog.about ?? '',
      models: (catalog.models ?? []).map((m) => ({ id: m.id, label: m.label, make: m.make ?? null })),
      suggested, model: modelId, control: control ? { id: control.id, label: control.label } : null,
      ...modelExtras(modelById(modelId)),
      reviewed: [...reviewed],
      entries,
    };
  }

  // --------------------------------------------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------------------------------------------
  function requireMachine(id) {
    const lm = layoutMachine(id);
    if (!lm) throw new MaintenanceError(404, 'NOT_FOUND', 'No such machine on the active layout');
    return lm;
  }
  function requireWritable() {
    if (!enabled()) throw new MaintenanceError(503, 'MAINTENANCE_DISABLED', 'Maintenance is turned off on this HUD (settings maintenance.enabled)');
    if (!plan) throw new MaintenanceError(503, 'MAINTENANCE_UNAVAILABLE', `The maintenance plan cannot be read (${planError?.message ?? 'unknown error'}); nothing was changed`);
  }
  /** The machine's plan entry, or a new one that is added to the plan only by commitEntry() (after the checks). */
  function entryFor(id) {
    return planEntry(id) ?? { id, model: null, reviewed: [], tasks: [] };
  }
  function commitEntry(e) {
    if (!plan.machines.includes(e)) plan.machines.push(e);
  }
  function dropIfEmpty(e) {
    if (!e.tasks.length && !e.reviewed.length && e.model === null) {
      const i = plan.machines.indexOf(e);
      if (i >= 0) plan.machines.splice(i, 1);
    }
  }
  function findTask(machineId, taskId) {
    if (typeof taskId !== 'string' || !MAINT_TASK_ID_RE.test(taskId)) throw new MaintenanceError(400, 'BAD_ID', 'Invalid task id');
    const task = planEntry(machineId)?.tasks.find((x) => x.id === taskId);
    if (!task) throw new MaintenanceError(404, 'NOT_FOUND', 'No such task');
    return task;
  }
  /** Save the plan (one write at a time); a failed write leaves the HUD's copy and reports 500. */
  function savePlan() {
    const snapshot = JSON.parse(JSON.stringify(plan));
    const run = planWrite.then(() => store.writePlan(snapshot));
    planWrite = run.catch(() => {});
    return run;
  }
  const log = (entry) => store.appendLog(entry).catch((err) => logger?.warn?.('cannot write the maintenance log', { err }));

  function taskFromCatalog(entry, override, t) {
    const task = {
      id: newTaskId(t), catalogId: entry.id, title: entry.title, action: entry.action, kind: entry.kind,
      basis: entry.kind === 'interval' ? entry.basis : null,
      every: entry.kind === 'interval' ? override?.every ?? entry.every : null,
      orEvery: entry.kind === 'interval' ? (override && 'orEvery' in override ? override.orEvery : entry.orEvery ?? null) : null,
      alarm: entry.alarm ?? null, link: null, source: taskSourceFromCatalog(catalog, entry), scope: entry.scope,
      ifEquipped: entry.ifEquipped ?? null, enabled: true, createdAt: t, updatedAt: t, last: null, triggered: null,
    };
    const problem = checkTaskShape(task);
    if (problem) throw new MaintenanceError(400, 'INVALID', `${entry.title}: ${problem}`);
    return task;
  }

  /** PUT /api/maintenance/machines/:id — Set up from the catalog. */
  async function setup(machineId, body, { from = null } = {}) {
    requireWritable();
    const lm = requireMachine(machineId);
    const parsed = parseSetupBody(body);
    if (!parsed.ok) throw new MaintenanceError(400, 'INVALID', parsed.message);
    const { model, tasks: picks } = parsed.value;
    if (model !== null && !modelById(model)) throw new MaintenanceError(400, 'INVALID', `Unknown model "${model}"`);
    const snap = getSnapshot(machineId);
    const entry = entryFor(machineId);
    const controlId = controlFor(catalog, machineInfo(lm, snap), model);
    const offered = catalogTasksFor(catalog, { modelId: model, controlId });
    const offeredById = new Map(offered.map((e) => [e.id, e]));
    for (const p of picks) if (!offeredById.has(p.catalogId)) throw new MaintenanceError(400, 'INVALID', `"${p.catalogId}" is not offered for this machine`);
    const t = now();
    let added = 0;
    let turnedOn = 0;
    let turnedOff = 0;
    let edited = 0;
    const picked = new Set(picks.map((p) => p.catalogId));
    const next = entry.tasks.map((x) => ({ ...x }));
    for (const pick of picks) {
      // intervals apply to interval tasks only: an alarm or as-needed entry ignores them
      const p = offeredById.get(pick.catalogId).kind === 'interval' ? pick : { catalogId: pick.catalogId };
      const existing = next.find((x) => x.catalogId === p.catalogId);
      if (!existing) {
        if (next.length >= TASKS_PER_MACHINE_MAX) throw new MaintenanceError(400, 'INVALID', `At most ${TASKS_PER_MACHINE_MAX} tasks per machine`);
        next.push(taskFromCatalog(offeredById.get(p.catalogId), p, t));
        added++;
        continue;
      }
      let changed = false;
      if (existing.enabled === false) { existing.enabled = true; turnedOn++; changed = true; }
      if (p.every && JSON.stringify(p.every) !== JSON.stringify(existing.every)) { existing.every = p.every; changed = true; edited++; }
      if ('orEvery' in p && JSON.stringify(p.orEvery ?? null) !== JSON.stringify(existing.orEvery ?? null)) { existing.orEvery = p.orEvery; changed = true; edited++; }
      if (changed) {
        const problem = checkTaskShape(existing);
        if (problem) throw new MaintenanceError(400, 'INVALID', `${existing.title}: ${problem}`);
        existing.updatedAt = t;
      }
    }
    for (const x of next) {
      if (x.catalogId && !picked.has(x.catalogId) && x.enabled !== false) { x.enabled = false; x.updatedAt = t; turnedOff++; }
    }
    const reviewed = [...new Set([...entry.reviewed, ...offered.map((e) => e.id)])];
    const modelChanged = entry.model !== model;
    const reviewedChanged = reviewed.length !== entry.reviewed.length;
    const changed = added || turnedOn || turnedOff || edited || modelChanged || reviewedChanged;
    if (changed) {
      const before = { ...entry, tasks: entry.tasks };
      entry.tasks = next;
      entry.model = model;
      entry.reviewed = reviewed;
      commitEntry(entry);
      try { await savePlan(); } catch (e) { Object.assign(entry, before); dropIfEmpty(entry); throw e; }
      log({ machineId, action: 'setup', model, added, enabled: turnedOn, disabled: turnedOff, edited, from });
      emitChange(machineId, { force: true });
    }
    return { ok: true, added, enabled: turnedOn, disabled: turnedOff, edited, machine: machineView(lm, now()) };
  }

  /** POST /api/maintenance/machines/:id/tasks — a task of the shop's own. */
  async function addTask(machineId, body, { from = null } = {}) {
    requireWritable();
    requireMachine(machineId);
    const parsed = parseTaskInput(body);
    if (!parsed.ok) throw new MaintenanceError(400, 'INVALID', parsed.message);
    const v = parsed.value;
    const t = now();
    const task = {
      id: newTaskId(t), catalogId: null, title: v.title, action: v.action ?? '', kind: v.kind,
      basis: v.kind === 'interval' ? v.basis : null, every: v.kind === 'interval' ? v.every : null,
      orEvery: v.kind === 'interval' ? v.orEvery ?? null : null, alarm: v.alarm ?? null, link: v.link ?? null, source: null,
      scope: 'custom', ifEquipped: null, enabled: true, createdAt: t, updatedAt: t, last: null, triggered: null,
    };
    const problem = checkTaskShape(task);
    if (problem) throw new MaintenanceError(400, 'INVALID', problem);
    const entry = entryFor(machineId);
    if (entry.tasks.length >= TASKS_PER_MACHINE_MAX) throw new MaintenanceError(400, 'INVALID', `At most ${TASKS_PER_MACHINE_MAX} tasks per machine`);
    entry.tasks.push(task);
    commitEntry(entry);
    try { await savePlan(); } catch (e) { entry.tasks.pop(); dropIfEmpty(entry); throw e; }
    log({ machineId, taskId: task.id, action: 'add', title: task.title, from });
    emitChange(machineId, { force: true });
    return { ok: true, task: rowFor(machineId, task) };
  }

  /** PUT /api/maintenance/machines/:id/tasks/:task — change a task (the baseline is kept). */
  async function editTask(machineId, taskId, body, { from = null } = {}) {
    requireWritable();
    requireMachine(machineId);
    const task = findTask(machineId, taskId);
    if (isObj(body) && body.kind !== undefined && body.kind !== task.kind) throw new MaintenanceError(400, 'INVALID', 'A task’s kind cannot change: add a new task instead');
    const parsed = parseTaskInput(isObj(body) ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'kind')) : body, { partial: true });
    if (!parsed.ok) throw new MaintenanceError(400, 'INVALID', parsed.message);
    const v = parsed.value;
    const merged = { ...task, ...v };
    if (task.kind !== 'interval') { merged.every = null; merged.orEvery = null; merged.basis = null; }
    if (merged.kind === 'interval' && v.every && !v.basis && (merged.basis === 'calendar') !== CALENDAR_UNITS.includes(v.every.unit)) {
      merged.basis = v.every.unit === 'hour' ? (METER_BASES.includes(task.basis) ? task.basis : 'operating') : 'calendar';
    }
    const problem = checkTaskShape(merged);
    if (problem) throw new MaintenanceError(400, 'INVALID', problem);
    const fields = Object.keys(v).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(task[k]));
    if (!fields.length) return { ok: true, task: rowFor(machineId, task) };
    const before = { ...task };
    Object.assign(task, merged, { updatedAt: now() });
    try { await savePlan(); } catch (e) { Object.assign(task, before); throw e; }
    log({ machineId, taskId, action: 'edit', title: task.title, fields, from });
    emitChange(machineId, { force: true });
    return { ok: true, task: rowFor(machineId, task) };
  }

  /** DELETE /api/maintenance/machines/:id/tasks/:task */
  async function removeTask(machineId, taskId, { from = null } = {}) {
    requireWritable();
    requireMachine(machineId);
    const task = findTask(machineId, taskId);
    const entry = planEntry(machineId);
    const i = entry.tasks.indexOf(task);
    entry.tasks.splice(i, 1);
    try { await savePlan(); } catch (e) { entry.tasks.splice(i, 0, task); throw e; }
    log({ machineId, taskId, action: 'remove', title: task.title, from });
    emitChange(machineId, { force: true });
    return { ok: true };
  }

  /** The control meter an hours task counts on, when the machine has one (for a "reading" Done). */
  function controlSourceFor(machineId, task) {
    if (task.kind !== 'interval' || !METER_BASES.includes(task.basis)) return null;
    const meters = ledger.meters(machineId);
    for (const key of BASIS_CHAIN[task.basis] ?? []) {
      if (METERS[key]?.source !== 'control') continue;
      const m = meters[key];
      if (m && finite(m.total) && !m.stale) return { key, ...m };
    }
    return null;
  }

  /** POST /api/maintenance/machines/:id/tasks/:task/done */
  async function done(machineId, taskId, body, { from = null } = {}) {
    requireWritable();
    requireMachine(machineId);
    const task = findTask(machineId, taskId);
    const t = now();
    const parsed = parseDoneBody(body, { now: t });
    if (!parsed.ok) throw new MaintenanceError(400, 'INVALID', parsed.message);
    const { how, at, reading, note, dated } = parsed.value;
    const hoursTask = task.kind === 'interval' && METER_BASES.includes(task.basis) && normalizeEvery(task.every)?.unit === 'hour';
    let totals = ledger.totals(machineId);
    let estimated = how === 'start';
    let warning = null;
    if (how === 'date' && hoursTask) {
      // that day's totals; a sample without any meter of the task's basis is no help (count from now, and say so)
      const s = ledger.totalsAt(machineId, at);
      const usable = s && (BASIS_CHAIN[task.basis] ?? []).some((k) => finite(s.totals[k]));
      if (usable) totals = s.totals;
      else { estimated = true; warning = 'The HUD has no hours for that date yet: the hours count from now.'; }
    }
    if (how === 'reading') {
      const src = controlSourceFor(machineId, task);
      if (!src) throw new MaintenanceError(409, 'NO_METER', 'This machine has no control hour meter for this task: mark it done now or on a date instead');
      const rawH = src.raw / 3600;
      if (reading > rawH + 0.01) throw new MaintenanceError(400, 'INVALID', `The reading is higher than the meter shows now (${Math.floor(rawH * 10) / 10} h)`);
      totals = { [src.key]: src.total - (src.raw - Math.min(reading * 3600, src.raw)) };
      estimated = !dated;
    }
    const before = { last: task.last, triggered: task.triggered, updatedAt: task.updatedAt };
    task.last = { at, how, totals, note, estimated };
    task.triggered = null;
    task.updatedAt = t;
    try { await savePlan(); } catch (e) { Object.assign(task, before); throw e; }
    const hours = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round2(v / 3600)]));
    log({ machineId, taskId, action: how === 'start' ? 'start' : 'done', title: task.title, how, doneAt: at, note, readings: hours, from });
    emitChange(machineId, { force: true });
    return { ok: true, task: rowFor(machineId, task), ...(warning ? { warning } : {}) };
  }

  /** POST /api/maintenance/machines/:id/start — every enabled task without a start counts from now. */
  async function startAll(machineId, { from = null } = {}) {
    requireWritable();
    requireMachine(machineId);
    const entry = planEntry(machineId);
    const t = now();
    const totals = ledger.totals(machineId);
    const todo = (entry?.tasks ?? []).filter((x) => x.enabled !== false && !x.last && x.kind === 'interval');
    if (!todo.length) return { ok: true, started: 0 };
    for (const x of todo) { x.last = { at: t, how: 'start', totals: { ...totals }, note: null, estimated: true }; x.updatedAt = t; }
    try { await savePlan(); } catch (e) { for (const x of todo) x.last = null; throw e; }
    log({ machineId, action: 'start', count: todo.length, from });
    emitChange(machineId, { force: true });
    return { ok: true, started: todo.length };
  }

  function rowFor(machineId, task) {
    return { ...publicTask(task), interval: describeInterval(task), status: taskStatus(task, statusCtx(machineId, now())) };
  }

  /** GET /api/maintenance/log */
  async function readLog({ machineId = null, taskId = null, limit = 200 } = {}) {
    return store.readLog({ machineId, taskId, limit: Math.max(1, Math.min(500, limit)) });
  }

  // --------------------------------------------------------------------------------------------------------------
  // Live input
  // --------------------------------------------------------------------------------------------------------------
  /** One snapshot of the active layout: meters, and alarm triggers. */
  function observe(snap) {
    if (closed) return;
    ledger.observe(snap);
    if (!plan || !enabled() || !isObj(snap) || typeof snap.id !== 'string') return;
    const conds = Array.isArray(snap.conditions) ? snap.conditions : [];
    if (!conds.length) return;
    const entry = planEntry(snap.id);
    if (!entry) return;
    const t = now();
    let fired = 0;
    for (const task of entry.tasks) {
      if (task.enabled === false || task.triggered || !Array.isArray(task.alarm?.match) || !task.alarm.match.length) continue;
      const after = task.last?.at ?? 0;
      const c = conds.find((x) => alarmMatches(task.alarm, x) && (finite(x.since) ? x.since : t) > after);
      if (!c) continue;
      task.triggered = { at: finite(c.since) ? c.since : t, code: String(c.nativeCode).slice(0, 24), message: String(c.message ?? '').slice(0, 200) || null };
      task.updatedAt = t;
      fired++;
      log({ machineId: snap.id, taskId: task.id, action: 'triggered', title: task.title, code: task.triggered.code, message: task.triggered.message });
    }
    if (fired) {
      savePlan().catch((err) => logger?.error?.('cannot save the maintenance plan', { err }));
      emitChange(snap.id, { force: true });
    }
  }

  /** The 60 s tick: meters, state changes, the periodic meters save. */
  function tick(snapshots) {
    if (closed) return;
    ledger.tick(snapshots);
    const t = now();
    if (plan && enabled()) {
      for (const lm of machines()) {
        const ctx = statusCtx(lm.id, t);
        const sig = (planEntry(lm.id)?.tasks ?? []).map((x) => `${x.id}:${taskStatus(x, ctx).state}`).join(',');
        if (lastSig.has(lm.id) && lastSig.get(lm.id) !== sig) emitChange(lm.id);
        lastSig.set(lm.id, sig);
      }
    }
    if (ledger.dirty && t - lastMetersSave >= METERS_SAVE_MS) saveMeters();
  }

  function saveMeters() {
    lastMetersSave = now();
    ledger.dirty = false;
    return store.writeMeters(ledger.toJSON()).catch((err) => { ledger.dirty = true; logger?.warn?.('cannot save maintenance meters', { err }); });
  }

  function shiftTime(deltaMs) { ledger.shiftTime(deltaMs); }

  function emitChange(machineId, { force = false } = {}) {
    if (closed) return;
    const t = now();
    const th = throttle.get(machineId) ?? { at: -Infinity, timer: null };
    throttle.set(machineId, th);
    const send = () => {
      th.timer = null;
      th.at = now();
      const ctx = statusCtx(machineId, th.at);
      lastSig.set(machineId, (planEntry(machineId)?.tasks ?? []).map((x) => `${x.id}:${taskStatus(x, ctx).state}`).join(','));
      events.emit('change', { machineId, counts: machineCounts(machineId, th.at), total: counts() });
    };
    if (force || t - th.at >= CHANGE_MIN_MS) {
      if (th.timer) { clearTimeout(th.timer); th.timer = null; }
      send();
      return;
    }
    if (!th.timer) {
      th.timer = setTimeout(send, CHANGE_MIN_MS - (t - th.at));
      th.timer.unref?.();
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const th of throttle.values()) if (th.timer) clearTimeout(th.timer);
    if (ledger.dirty) await saveMeters();
    await planWrite;
    await store.idle();
  }

  return {
    init, observe, tick, shiftTime, overview, counts, catalogFor, setup, addTask, editTask, removeTask, done, startAll,
    log: readLog, close,
    get available() { return !!plan; },
    get enabled() { return enabled(); },
    on: (name, fn) => events.on(name, fn), off: (name, fn) => events.off(name, fn),
    /** test hook */ _plan: () => plan, _ledger: ledger, sourceLink: (task) => sourceLink(catalog, task),
  };
}
