// Stacklight public demo: maintenance (DECISIONS D18) in the visitor's browser (D17).
//
// scripts/demo-site/backend.js runs the product's own maintenance service (src/maintenance/service.js, copied into
// the demo as maintenance-service.js) with the shipped catalog. What the server keeps on disk is kept here instead:
//   createDemoMaintenanceStore  the plan and its log in localStorage (the service's store interface); a plan belongs
//                               to the recording it was made for, so a new recording starts fresh
//   createDemoLedger            the hour meters: the replayed control meters (powerOnHours, …) carried on smoothly
//                               when the recording loops or the page reloads, and the HUD's own counts of what it saw;
//                               fixed paces (a two-shift shop) give the "≈ date" forecasts at once
//   seedDemoMaintenance         a first visit's plan: each machine the catalog knows set up with its pre-ticked tasks,
//                               last done at times that give a mix of due, due soon and OK
// Nothing leaves the browser. Without browser storage (private windows) everything lasts for the page.

import { METERS, CONTROL_METER_KEYS, intervalDays, normalizeEvery, BASIS_CHAIN, METER_BASES } from '/shared/maintenance.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const DAY = 86_400_000;
const HUD_KEYS = ['hud.on', 'hud.cycle', 'hud.spindle'];
const OFF = new Set(['OFFLINE', 'UNAVAILABLE', 'UNBOUND']);
/** Hours a day each meter moves in the demo's forecasts (a two-shift shop). */
export const DEMO_PACE = Object.freeze({
  'control.powerOn': 16, 'control.operating': 10, 'control.cutting': 6, 'control.spindle': 8,
  'hud.on': 16, 'hud.cycle': 10, 'hud.spindle': 8,
});

function read(storage, key) {
  try { const v = JSON.parse(storage?.getItem(key) ?? 'null'); return isObj(v) ? v : null; } catch { return null; }
}
function write(storage, key, value) {
  try { if (value === null) storage?.removeItem(key); else storage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/**
 * The service's store (src/maintenance/store.js interface), in browser storage.
 * @param {{ storage?: Storage|null, key?: string, recording: string, now?: () => number }} o
 */
export function createDemoMaintenanceStore({ storage = null, key = 'stacklight-demo.maintenance', recording, now = Date.now }) {
  const saved = read(storage, key);
  let doc = saved && saved.recording === recording && isObj(saved.plan) && Array.isArray(saved.plan.machines)
    ? saved
    : { recording, plan: { version: 1, machines: [] }, log: [], changedByVisitor: false };
  const persist = () => write(storage, key, doc);
  return {
    planFile: 'this browser',
    get fresh() { return !doc.plan.machines.length; },
    get changedByVisitor() { return !!doc.changedByVisitor; },
    markVisitorChange() { if (!doc.changedByVisitor) { doc.changedByVisitor = true; persist(); } },
    async readPlan() { return JSON.parse(JSON.stringify(doc.plan)); },
    async writePlan(plan) { doc.plan = { version: 1, machines: JSON.parse(JSON.stringify(plan.machines)) }; persist(); },
    async readMeters() { return null; }, // the demo ledger keeps its own (createDemoLedger)
    async writeMeters() {},
    async appendLog(entry) {
      const { from: _from, ...rest } = entry;
      const e = { at: now(), ...rest };
      doc.log.push(e);
      if (doc.log.length > 500) doc.log.splice(0, doc.log.length - 500);
      persist();
      return e;
    },
    async readLog({ machineId = null, taskId = null, limit = 200 } = {}) {
      return doc.log.filter((e) => (!machineId || e.machineId === machineId) && (!taskId || e.taskId === taskId)).reverse().slice(0, limit);
    },
    idle: () => Promise.resolve(),
    /** Forget this browser's plan (the ribbon's Reset). */
    clear() { doc = { recording, plan: { version: 1, machines: [] }, log: [], changedByVisitor: false }; write(storage, key, null); },
  };
}

/**
 * Hour meters for the demo, with the MeterLedger interface the service uses (src/maintenance/meters.js).
 * @param {{ storage?: Storage|null, key?: string, recording?: string|null, now?: () => number }} [o]  a ledger saved for another
 *   recording starts again
 */
export function createDemoLedger({ storage = null, key = 'stacklight-demo.maintenance-meters', recording = null, now = Date.now } = {}) {
  /** id → { control: { [key]: { last, offset } }, hud: { 'hud.on': s, …, since, lastAt, last } } */
  const saved = read(storage, key);
  const machines = new Map(Object.entries(saved && saved.recording === recording && isObj(saved.machines) ? saved.machines : {}));
  let savedAt = 0;
  const persist = (force = false) => {
    const t = now();
    if (!force && t - savedAt < 5000) return;
    savedAt = t;
    write(storage, key, { recording, machines: Object.fromEntries(machines) });
  };
  const rec = (id) => {
    let r = machines.get(id);
    if (!r) { r = { control: {}, hud: { 'hud.on': 0, 'hud.cycle': 0, 'hud.spindle': 0, since: null, lastAt: null, last: null } }; machines.set(id, r); }
    return r;
  };
  const ledger = {
    onEvent: null,
    dirty: false,
    observe(snap) {
      if (!isObj(snap) || typeof snap.id !== 'string' || snap.id.startsWith('device:')) return;
      const t = now();
      const r = rec(snap.id);
      // the HUD's own counts: the time since the last look goes to what the machine was doing then
      const h = r.hud;
      if (h.last && finite(h.lastAt) && t > h.lastAt && t - h.lastAt <= 5 * 60_000) for (const k of HUD_KEYS) if (h.last[k]) h[k] += (t - h.lastAt) / 1000;
      const on = typeof snap.status === 'string' && !OFF.has(snap.status);
      h.last = { 'hud.on': on, 'hud.cycle': on && snap.status === 'RUNNING', 'hud.spindle': on && finite(snap.values?.spindleSpeed) && snap.values.spindleSpeed > 0 };
      h.lastAt = t;
      if (h.since === null && on) h.since = t;
      // the control's meters: a drop is the recording starting over, so the count carries on from where it was
      for (const k of CONTROL_METER_KEYS) {
        const hours = snap.values?.[METERS[k].value];
        if (!finite(hours) || hours < 0) continue;
        const v = hours * 3600;
        const c = r.control[k];
        if (!c) { r.control[k] = { last: v, offset: 0, since: t }; continue; }
        if (v < c.last - 360) c.offset += c.last - v;
        c.last = v;
      }
      persist();
    },
    tick(snaps) { for (const s of Array.isArray(snaps) ? snaps : []) ledger.observe(s); },
    shiftTime() {},
    meters(id) {
      const r = machines.get(id);
      if (!r) return {};
      const t = now();
      const out = {};
      for (const [k, c] of Object.entries(r.control)) out[k] = { total: c.last + c.offset, raw: c.last + c.offset, at: t, changedAt: t, since: c.since ?? t, stale: false };
      if (r.hud.since !== null) for (const k of HUD_KEYS) out[k] = { total: r.hud[k], at: t, since: r.hud.since };
      return out;
    },
    totals(id) {
      return Object.fromEntries(Object.entries(ledger.meters(id)).map(([k, m]) => [k, m.total]));
    },
    pace(id) {
      return Object.fromEntries(Object.keys(ledger.meters(id)).map((k) => [k, DEMO_PACE[k]]).filter(([, v]) => finite(v)));
    },
    /** The totals on an earlier day, estimated from the demo's paces (the server keeps daily samples instead). */
    totalsAt(id, at) {
      if (!finite(at)) return null;
      const days = Math.max(0, (now() - at) / DAY);
      const totals = Object.fromEntries(Object.entries(ledger.totals(id)).map(([k, v]) => [k, Math.max(0, v - (DEMO_PACE[k] ?? 0) * 3600 * days)]));
      return { at, day: new Date(at).toISOString().slice(0, 10), totals };
    },
    events() { return []; },
    toJSON() { return { format: 1, machines: [] }; },
    load() {},
    ids() { return [...machines.keys()]; },
    /** Forget the meters (the ribbon's Reset). */
    clear() { machines.clear(); write(storage, key, null); },
    flush() { persist(true); },
  };
  return ledger;
}

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * A first visit: set up every machine the catalog knows with its pre-ticked tasks, through the service's own API, and
 * mark them done at times that give a mix of due, due soon and OK (the first interval task of every other machine is
 * due, the second due soon, the rest at 40 %).
 * @param {ReturnType<import('../../src/maintenance/service.js').createMaintenanceService>} service
 * @param {{ machines: Array<{id: string}>, ledger: object, now?: () => number }} o
 */
export async function seedDemoMaintenance(service, { machines, ledger, now = Date.now }) {
  let n = 0;
  for (const lm of machines) {
    let cat;
    try { cat = service.catalogFor(lm.id); } catch { continue; }
    const picks = cat.entries.filter((e) => e.preChecked).map((e) => ({ catalogId: e.id }));
    if (!picks.length) continue;
    await service.setup(lm.id, { model: cat.model ?? null, tasks: picks });
    const view = service.overview({ machineId: lm.id }).machines[0];
    const tasks = view.tasks.filter((t) => t.kind === 'interval').sort((a, b) => String(a.catalogId).localeCompare(String(b.catalogId)));
    const meters = ledger.meters(lm.id);
    for (const [i, t] of tasks.entries()) {
      const mode = n % 2 === 0 && i === 0 ? 'due' : i === 1 ? 'soon' : 'ok';
      const every = normalizeEvery(t.every);
      const calendar = every && every.unit !== 'hour' ? every : normalizeEvery(t.orEvery);
      const days = calendar ? intervalDays(calendar) : 365;
      const ago = { due: days + Math.max(2, days * 0.06), soon: days * 0.96, ok: days * 0.4 }[mode];
      const date = localDate(now() - ago * DAY);
      const hours = every?.unit === 'hour' && METER_BASES.includes(t.basis)
        ? (BASIS_CHAIN[t.basis] ?? []).map((k) => (METERS[k].source === 'control' ? meters[k] : null)).find(Boolean)
        : null;
      try {
        if (hours) {
          const used = { due: every.value * 1.02, soon: every.value * 0.94, ok: every.value * 0.4 }[mode];
          await service.done(lm.id, t.id, { how: 'reading', reading: Math.max(0, Math.round((hours.raw / 3600 - used) * 10) / 10), date: mode === 'due' ? localDate(now() - days * 0.5 * DAY) : date });
        } else {
          await service.done(lm.id, t.id, { how: 'date', date, note: i === 0 ? 'Done by the service tech' : null });
        }
      } catch { /* a task the demo cannot date: it stays "needs a start" */ }
    }
    n++;
  }
  return n;
}
