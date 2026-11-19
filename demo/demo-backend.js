// Stacklight public demo: the HUD server, replayed in the visitor's browser (DECISIONS D17).
//
// scripts/demo-site.mjs builds the demo page from the real board (public/, unchanged apart from paths) and copies this
// file next to it as demo-backend.js. The page is <html data-demo="1">, and this module is its first module script,
// so it runs before the board starts. It answers the board's /api/* requests and its /api/events stream from
// recording.json: a recording of the real product running the showcase shop (an invented shop, simulated machines;
// never a customer's). The recording plays as if it began when the page opened: every timestamp is shifted to the
// visitor's clock, and it loops. Machine timelines and the run list grow from the replayed changes.
// Two features work against the visitor's own browser: the layout editor (saves go to localStorage, layouts.js) and
// program transfer on the FANUC machines (simulated Data Servers in memory, dataServer.js). Nothing leaves the
// browser; every other change is refused (403 DEMO_READ_ONLY).
//
// Recording format 1 (written by `node scripts/demo-site.mjs record`):
//   { format: 1, t0, duration, bootId, version,
//     state,                    GET /api/state at t0 (layout metadata, machines, settings, …)
//     layout, layoutEtag,       GET /api/layouts/<id>
//     history: { id: … },       GET /api/machines/<id>/history?hours=12 at t0
//     runs: [ … ],              GET /api/runs (everything kept) at t0
//     devices: [ … ],           GET /api/devices (the editor's link panel; optional)
//     events: [ [ms after t0, 'm', machineId, delta] | [ms after t0, 'e', eventName, data] … ] }
// A machine delta maps dotted paths to new values ({ "values.spindleSpeed": 9500 }); { "$del": 1 } removes one.

import { createDemoDataServer, sampleProgram, DemoProgramError } from './dataServer.js';
import { createDemoLayouts, DemoLayoutError } from './layouts.js';

export const RECORDING_FORMAT = 1;
const EPOCH_MIN = 1e12; // millisecond timestamps (2001–2286); no other number in the data comes near
const EPOCH_MAX = 1e13;
const STATUSES = ['ESTOP', 'ALARM', 'PAUSED', 'SETUP', 'IDLE', 'RUNNING', 'UNAVAILABLE', 'OFFLINE'];
const MIN_LOOP_MS = 60_000;
const BURST = 150; // more events due at once (a tab back from the background) → one snapshot instead
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Copy of `v` with every millisecond timestamp moved by `delta`. */
export function shiftTimes(v, delta) {
  if (typeof v === 'number') return v >= EPOCH_MIN && v < EPOCH_MAX ? v + delta : v;
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta));
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = shiftTimes(x, delta);
    return o;
  }
  return v;
}

/** Leaf paths of an object: nested objects are walked, arrays and empty objects are leaves. */
function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && Object.keys(v).length) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

/** What changed from `prev` to `next`, as a delta for applyDelta(). */
export function diff(prev, next) {
  const a = flatten(prev);
  const b = flatten(next);
  const d = {};
  for (const [p, v] of Object.entries(b)) if (!(p in a) || JSON.stringify(a[p]) !== JSON.stringify(v)) d[p] = v;
  for (const p of Object.keys(a)) if (!(p in b)) d[p] = { $del: 1 };
  return d;
}

/** `obj` with a delta applied (a new object; removals first, then values). */
export function applyDelta(obj, delta) {
  const out = clone(obj);
  const entries = Object.entries(delta);
  for (const [path, v] of entries) {
    if (!(isObj(v) && v.$del === 1 && Object.keys(v).length === 1)) continue;
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) { o = isObj(o) ? o[k] : undefined; }
    if (isObj(o)) delete o[keys[keys.length - 1]];
  }
  for (const [path, v] of entries) {
    if (isObj(v) && v.$del === 1 && Object.keys(v).length === 1) continue;
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) {
      if (!isObj(o[k])) o[k] = {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = clone(v);
  }
  return out;
}

/**
 * The replay: what the HUD server would answer at a given wall-clock time. Iteration k of the loop starts at
 * startWall + k × duration and shows the recording shifted by that much, so a page that opens at startWall sees the
 * recording's first moment as "now". Pure (time is passed in), so it is unit-tested in Node.
 * @param {object} rec  a format-1 recording
 * @param {{ startWall: number }} o
 */
export function createReplay(rec, { startWall }) {
  if (rec?.format !== RECORDING_FORMAT) throw new Error('unsupported demo recording');
  const L = Math.max(MIN_LOOP_MS, finite(rec.duration) ? rec.duration : 0);
  const events = Array.isArray(rec.events) ? rec.events : [];
  let k = null;
  let W = 0;        // wall time this iteration started
  let shift = 0;    // added to recorded timestamps in this iteration
  let cursor = 0;   // next event
  let base = null;  // shifted recording state
  let machines = new Map();
  let runs = new Map();
  let histories = new Map();
  let changes = new Map(); // machine id → [{ t, status, reason, prev }] seen in this iteration

  function reset(iter) {
    k = iter;
    W = startWall + iter * L;
    shift = W - rec.t0;
    cursor = 0;
    base = shiftTimes(rec.state, shift);
    machines = new Map((Array.isArray(base.machines) ? base.machines : []).map((m) => [m.id, m]));
    runs = new Map(shiftTimes(Array.isArray(rec.runs) ? rec.runs : [], shift).map((r) => [r.id, r]));
    histories = new Map(Object.entries(isObj(rec.history) ? rec.history : {}).map(([id, h]) => [id, shiftTimes(h, shift)]));
    changes = new Map();
  }

  /**
   * Bring the replay to wall time `now`. → { events: [{ name, data }], resync } where resync means the loop
   * restarted (or the clock jumped) and clients need a full snapshot.
   */
  function sync(now) {
    const iter = Math.floor((now - startWall) / L);
    let resync = false;
    if (iter !== k) { reset(iter); resync = true; }
    const pos = now - W;
    const out = [];
    while (cursor < events.length && events[cursor][0] <= pos) {
      const [dt, type, a, b] = events[cursor++];
      const t = rec.t0 + dt + shift;
      if (type === 'm') {
        const prev = machines.get(a);
        if (!prev) continue;
        const m = applyDelta(prev, shiftTimes(b, shift));
        machines.set(a, m);
        if (m.status !== prev.status) {
          const list = changes.get(a) ?? [];
          const last = list.length ? list[list.length - 1].t : W;
          list.push({ t: Math.min(t, Math.max(last, finite(m.since) ? m.since : t)), status: m.status, reason: m.reason ?? null, prev: prev.status ?? null });
          changes.set(a, list);
        }
        out.push({ name: 'machine', data: { serverTime: t, id: a, layoutId: base.layoutId, machine: m } });
      } else if (type === 'e' && typeof a === 'string') {
        const data = shiftTimes(b, shift);
        if (a === 'runs' && isObj(data?.run) && typeof data.run.id === 'string') runs.set(data.run.id, data.run);
        out.push({ name: a, data: isObj(data) ? { ...data, serverTime: t } : data });
      }
    }
    return { events: out, resync };
  }

  /** GET /api/state (and the SSE 'snapshot'). */
  function state(now) {
    return {
      ...base,
      serverTime: now,
      live: true,
      machines: [...machines.values()],
      agents: (Array.isArray(base.agents) ? base.agents : []).map((a) => ({ ...a, lastSuccessAt: now })),
    };
  }

  /** GET /api/machines/:id/history?hours=h: the recorded timeline, extended by this iteration's changes. */
  function history(id, hours, now) {
    const h = histories.get(id);
    if (!h) return null;
    const from = now - hours * 3_600_000;
    const segs = (Array.isArray(h.timeline) ? h.timeline : []).map((s) => ({ ...s }));
    if (!segs.length) {
      // nothing recorded yet for this machine: its status in the recorded state, since then
      const m0 = (Array.isArray(base.machines) ? base.machines : []).find((m) => m?.id === id);
      if (m0?.status) segs.push({ status: m0.status, reason: m0.reason ?? null, from: finite(m0.since) ? Math.min(m0.since, W) : W, to: W });
    }
    let cur = segs.length ? segs[segs.length - 1] : null;
    const extra = [];
    for (const c of changes.get(id) ?? []) {
      extra.push({ t: c.t, machineId: id, kind: 'status', status: c.status, reason: c.reason, prev: c.prev });
      if (cur && cur.status === c.status) continue;
      if (cur) cur.to = Math.max(cur.from, c.t);
      cur = { status: c.status, reason: c.reason, from: c.t, to: now };
      segs.push(cur);
    }
    if (cur) cur.to = Math.max(cur.from, now);
    const timeline = segs.filter((s) => finite(s.from) && finite(s.to) && s.to > from).map((s) => ({ ...s, from: Math.max(s.from, from) }));
    const utilization = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const s of timeline) utilization[s.status] = (utilization[s.status] ?? 0) + (s.to - s.from);
    const evs = [...extra.reverse(), ...(Array.isArray(h.events) ? h.events : [])].filter((e) => finite(e?.t) && e.t >= from && e.t <= now);
    return { serverTime: now, id, hours, from, to: now, enabled: true, timeline, utilization, events: evs };
  }

  /** GET /api/runs?from&to&machine (the server's rule: started before `to` and still going at `from`). */
  function runList({ from, to, machine }, now) {
    const f = finite(from) ? from : now - 86_400_000;
    const t = finite(to) ? to : now;
    const list = [];
    for (const r of runs.values()) {
      if (machine && r.machineId !== machine) continue;
      if (!finite(r.start) || r.start > now) continue;
      const end = finite(r.end) ? r.end : Math.max(now, r.start);
      if (r.start < t && end >= f) list.push(finite(r.end) ? r : { ...r, lastAt: now });
    }
    list.sort((a, b) => b.start - a.start || String(a.machineId).localeCompare(String(b.machineId)));
    return { serverTime: now, from: f, to: t, machineId: machine || null, enabled: true, runs: list, truncated: false };
  }

  reset(0);
  return {
    sync, state, history, runs: runList,
    /** A machine's current snapshot in the replay, or null. */
    machine: (id) => machines.get(id) ?? null,
    /** GET /api/devices: the recorded devices, each with the live status of the machine it is bound to. */
    devices() {
      return (Array.isArray(rec.devices) ? rec.devices : []).map((d) => {
        const m = machines.get(Array.isArray(d.boundTo) && d.boundTo.length ? d.boundTo[0] : d.snapshotId);
        const s = shiftTimes(d, shift);
        return m ? { ...s, status: m.status ?? null, reason: m.reason ?? null, connection: m.connection ?? null, program: m.values?.program ?? null, programComment: m.values?.programComment ?? null, since: m.since ?? null, updatedAt: m.updatedAt ?? null } : s;
      });
    },
    get loopMs() { return L; },
    get iteration() { return k; },
  };
}

// ---------------------------------------------------------------------------------------------
// Program transfer: the FANUC machines' simulated Data Servers
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;
/** Other programs in each simulated folder (besides the ones the machine runs in the recording). */
const EXTRA_PROGRAMS = {
  mill: [['O1001', 'BASE PLATE OP1 6061'], ['O2210', 'MOTOR MOUNT OP1 6061'], ['O2211', 'MOTOR MOUNT OP2 6061'], ['O9001', 'SPINDLE WARM UP'], ['O9100', 'PROBE WORK OFFSET']],
  wire: [['O1905', 'CAM PLATE START HOLES 416SS'], ['O1908', 'PUNCH INSERT D2'], ['O1910', 'GEAR SEGMENT 17-4'], ['O9000', 'WIRE THREAD TEST']],
};

/**
 * Seeds for the simulated Data Servers: every FANUC (FOCAS) machine of the recorded layout, with the programs it runs
 * in the recording, a few others, and two History entries (a send and a replace that can be put back).
 */
export function programSeeds(rec, { now }) {
  const out = [];
  for (const lm of Array.isArray(rec?.layout?.machines) ? rec.layout.machines : []) {
    if (lm?.source?.protocol !== 'focas' || typeof lm.id !== 'string') continue;
    const kind = /edm|wire/i.test(`${lm.kind ?? ''} ${lm.name ?? ''}`) ? 'wire' : 'mill';
    const seen = new Map();
    let cur = (rec.state?.machines ?? []).find((m) => m?.id === lm.id)?.values ?? {};
    const note = (v) => { if (typeof v.program === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.program) && !seen.has(v.program)) seen.set(v.program, v.programComment ?? null); };
    note(cur);
    for (const e of Array.isArray(rec.events) ? rec.events : []) {
      if (e[1] !== 'm' || e[2] !== lm.id) continue;
      const d = e[3] ?? {};
      if ('values.program' in d || 'values.programComment' in d) {
        cur = { ...cur, ...('values.program' in d ? { program: d['values.program'] } : {}), ...('values.programComment' in d ? { programComment: d['values.programComment'] } : {}) };
        note(cur);
      }
    }
    const files = [...seen].map(([name, comment], i) => ({ name, text: sampleProgram(name, comment ?? 'PART', { kind, lines: 320 + i * 40 }), modified: now - (2 + i) * DAY - 5_400_000 }));
    const extras = EXTRA_PROGRAMS[kind].filter(([n]) => !seen.has(n))
      .map(([name, comment], i) => ({ name, comment, text: sampleProgram(name, comment, { kind, lines: 90 + i * 70 }), modified: now - (4 + i * 6) * DAY - i * 7_200_000 }));
    files.push(...extras.map(({ name, text, modified }) => ({ name, text, modified })));
    const history = [];
    if (extras.length >= 2) {
      const older = sampleProgram(extras[1].name, `${extras[1].comment} REV A`, { kind, lines: 80 });
      history.push(
        { id: `seed-${lm.id}-1`, at: now - 3 * DAY, action: 'sent', name: extras[0].name, size: extras[0].text.length, result: 'checked' },
        { id: `seed-${lm.id}-2`, at: now - 26 * 3_600_000, action: 'replaced', name: extras[1].name, size: extras[1].text.length, result: 'checked', keptSize: older.length, keptModified: now - 12 * DAY, kept: older },
      );
      extras[1].modified = now - 26 * 3_600_000;
      files.find((f) => f.name === extras[1].name).modified = extras[1].modified;
    }
    out.push({ id: lm.id, name: typeof lm.name === 'string' ? lm.name : lm.id, host: lm.source.host ?? null, files, history });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// In the browser: stand in for fetch('/api/…') and EventSource('/api/events')
// ---------------------------------------------------------------------------------------------

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});
const RUNNING_EXECUTIONS = new Set(['ACTIVE', 'INTERRUPTED', 'FEED_HOLD', 'OPTIONAL_STOP', 'PROGRAM_STOPPED', 'WAIT']);

/** localStorage when the browser allows it (private windows and blocked site data: none, so saves last for the page). */
function safeStorage(win) {
  try {
    const s = win.localStorage;
    const k = '__stacklight_demo_probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch { return null; }
}

/**
 * Install the demo backend in a window. The recording loads once; requests wait for it.
 * @param {Window} win
 * @param {{ recordingUrl?: string|URL, validateLayout?: Function }} [o]  validateLayout: src/shared/layout.js's (loaded
 *   from the page's /shared/ when not given)
 */
export function install(win, { recordingUrl = new URL('recording.json', import.meta.url), validateLayout = null } = {}) {
  const realFetch = win.fetch.bind(win);
  const assetBase = new URL('.', recordingUrl).pathname; // where the demo's brand/ folder is served
  const sources = new Set();
  let replay = null;
  let rec = null;
  let layouts = null;
  let programs = null;
  let programMachines = {};
  let lastPing = 0;
  let pending = [];      // events the replay moved past, not yet sent to the open streams
  let resyncDue = false; // the loop restarted: send a full snapshot instead

  const ready = realFetch(String(recordingUrl), { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`recording: HTTP ${r.status}`); return r.json(); })
    .then(async (data) => {
      rec = data;
      // brand files are served next to the demo, not at the site root
      const b = rec.state?.settings?.branding;
      if (isObj(b)) for (const key of ['logo', 'icon']) if (typeof b[key] === 'string') b[key] = assetBase + b[key].replace(/^\/+/, '');
      const validate = validateLayout ?? (await import('/shared/layout.js')).validateLayout;
      layouts = createDemoLayouts({ base: rec.layout, baseEtag: rec.layoutEtag ?? '"recorded"', storage: safeStorage(win), validate, updatedAt: Date.now() });
      replay = createReplay(rec, { startWall: Date.now() });
      const seeds = programSeeds(rec, { now: Date.now() });
      programMachines = Object.fromEntries(seeds.map((m) => [m.id, { enabled: true }]));
      programs = createDemoDataServer({ machines: seeds, getUse: programUse });
      win.setInterval(tick, 250);
      showReset();
      return true;
    });
  ready.catch((e) => win.console?.error?.('[demo] the recording could not be loaded', e));

  /** What a machine is running or has selected, as the HUD's live status says (src/programs/service.js machineUse). */
  function programUse(id) {
    const m = replay?.machine(id);
    if (!m || m.connection !== 'connected') return { known: false, running: false, program: null };
    const v = m.values ?? {};
    return { known: true, running: m.status === 'RUNNING' || RUNNING_EXECUTIONS.has(v.execution), program: typeof v.program === 'string' ? v.program : null };
  }

  /** GET /api/state, as this browser sees it: its own layout, program transfer on the FANUCs, editing without a token. */
  function state(now) {
    const s = replay.state(now);
    const cur = layouts.current();
    return {
      ...s,
      localEdit: true,
      layout: { ...(s.layout ?? {}), id: layouts.id, name: cur.layout.name ?? null, etag: cur.etag, updatedAt: cur.updatedAt, errors: null },
      settings: { ...(s.settings ?? {}), programs: { enabled: true, machines: programMachines } },
    };
  }

  function showReset() {
    const el = win.document?.querySelector?.('.demo-reset');
    if (el) el.hidden = !layouts?.custom;
  }

  function broadcast(name, data) {
    for (const s of sources) s._emit(name, data);
  }

  /** Move the replay to `now`, keeping what it passed for the next broadcast. */
  function advance(now) {
    const { events, resync } = replay.sync(now);
    if (resync) { resyncDue = true; pending = []; }
    pending.push(...events);
    if (pending.length > BURST) { resyncDue = true; pending = []; }
  }

  function tick() {
    try {
      const now = Date.now();
      advance(now);
      const due = pending;
      pending = [];
      if (resyncDue) { resyncDue = false; broadcast('snapshot', state(now)); }
      else for (const ev of due) broadcast(ev.name, ev.data);
      if (now - lastPing >= 15_000) {
        lastPing = now;
        broadcast('ping', { serverTime: now, bootId: rec.bootId, version: rec.version });
      }
    } catch (e) {
      win.console?.error?.('[demo] replay failed', e);
    }
  }

  /** A saved layout: tell every open board, as the server does. */
  function layoutChanged(reason, etag, now) {
    broadcast('layout', { serverTime: now, id: layouts.id, reason, etag, active: true });
    showReset();
  }

  const refuse = (now, message) => json(403, { serverTime: now, ok: false, error: 'DEMO_READ_ONLY', message });
  const failure = (now, e) => json(e.status, { serverTime: now, ok: false, error: e.code, message: e.message, ...(isObj(e.extra) ? e.extra : {}) });
  const bodyBytes = async (init) => (init?.body == null ? new Uint8Array() : new Uint8Array(await new Response(init.body).arrayBuffer()));
  async function bodyJson(init) {
    const t = new TextDecoder().decode(await bodyBytes(init));
    try { return t ? JSON.parse(t) : null; } catch { return undefined; }
  }

  async function answer(url, method, init) {
    try { await ready; } catch { return json(503, { ok: false, error: 'DEMO_UNAVAILABLE', message: 'The demo could not load. Reload the page to try again.' }); }
    const now = Date.now();
    advance(now); // the next tick broadcasts what this moved past
    const p = url.pathname;
    const read = method === 'GET' || method === 'HEAD';
    const dec = (v) => decodeURIComponent(v);
    try {
      if (method === 'POST' && p === '/api/client-log') return new Response(null, { status: 204 });

      // --- the board ------------------------------------------------------------------------
      if (read && p === '/api/state') return json(200, state(now));
      if (read && p === '/api/health') {
        return json(200, { serverTime: now, ok: true, version: rec.version, bootId: rec.bootId, uptimeMs: now - (rec.state?.serverTime ?? now) + 3_600_000, sseClients: sources.size, layoutId: layouts.id });
      }
      if (read && p === '/api/runs') {
        const q = url.searchParams;
        const num = (k) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : undefined);
        return json(200, replay.runs({ from: num('from'), to: num('to'), machine: q.get('machine') || null }, now));
      }
      let m = /^\/api\/machines\/([^/]+)\/history$/.exec(p);
      if (read && m) {
        const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 12));
        const h = replay.history(dec(m[1]), hours, now);
        return h ? json(200, h) : json(404, { serverTime: now, ok: false, error: 'NOT_FOUND', message: 'No such machine' });
      }
      if (read && p === '/api/discovery') return json(200, { status: { running: false, available: false }, result: null, full: false });
      if (read && p === '/api/settings') return json(200, { settings: state(now).settings });
      if (read && p === '/api/devices') return json(200, { devices: replay.devices() });

      // --- the layout editor: this browser's own copy ---------------------------------------
      if (read && p === '/api/layouts') return json(200, layouts.list());
      m = /^\/api\/layouts\/([^/]+)$/.exec(p);
      if (m && read) {
        const l = layouts.get(dec(m[1]));
        return json(200, l.layout, { ETag: l.etag, 'X-Layout-Updated-At': String(l.updatedAt), 'X-Layout-Valid-On-Disk': 'true' });
      }
      if (m && method === 'PUT') {
        const body = await bodyJson(init);
        if (body === undefined) return json(400, { serverTime: now, ok: false, error: 'BAD_JSON', message: 'The body is not JSON' });
        const r = layouts.save(dec(m[1]), body, { ifMatch: new Headers(init?.headers ?? {}).get('If-Match') });
        if (r.changed) layoutChanged('saved', r.etag, now);
        return json(200, { ok: true, ...r }, { ETag: r.etag });
      }
      if (m && method === 'DELETE') return refuse(now, 'The demo keeps one layout.');
      if (p === '/api/layouts' && method === 'POST') {
        const r = layouts.create(await bodyJson(init));
        if (r.changed) layoutChanged('saved', r.etag, now);
        return json(201, { ok: true, ...r }, { ETag: r.etag });
      }
      m = /^\/api\/layouts\/([^/]+)\/activate$/.exec(p);
      if (m && method === 'POST') { layouts.get(dec(m[1])); return json(200, { ok: true, activeLayout: layouts.id }); }
      m = /^\/api\/layouts\/([^/]+)\/versions$/.exec(p);
      if (m && read) return json(200, { id: layouts.id, versions: layouts.versions(dec(m[1])) });
      m = /^\/api\/layouts\/([^/]+)\/versions\/([^/]+)$/.exec(p);
      if (m && read) return json(200, layouts.readVersion(dec(m[1]), dec(m[2])));
      m = /^\/api\/layouts\/([^/]+)\/versions\/([^/]+)\/restore$/.exec(p);
      if (m && method === 'POST') {
        const r = layouts.restore(dec(m[1]), dec(m[2]), { ifMatch: new Headers(init?.headers ?? {}).get('If-Match') });
        if (r.changed) layoutChanged('restored', r.etag, now);
        return json(200, { ok: true, ...r }, { ETag: r.etag });
      }
      if (p === '/api/assets' || p.startsWith('/api/assets/')) {
        if (read) return json(200, { assets: [] });
        return refuse(now, 'Floor-plan photos are not part of the demo: everything here stays in your browser. In your shop, the HUD keeps them on its own computer.');
      }
      if (p.startsWith('/api/connectors')) return refuse(now, 'Linking machines on a network is not part of the demo. In your shop, the HUD finds and tests them on your network.');

      // --- program transfer: simulated Data Servers ------------------------------------------
      if (read && p === '/api/programs') return json(200, programs.overview());
      if (p.startsWith('/api/programs/')) return refuse(now, 'Program transfer setup is not part of the demo.');
      m = /^\/api\/machines\/([^/]+)\/programs$/.exec(p);
      if (m && read) return json(200, programs.list(dec(m[1])));
      m = /^\/api\/machines\/([^/]+)\/programs-first-lines$/.exec(p);
      if (m && read) return json(200, { serverTime: now, ...programs.firstLines(dec(m[1])) });
      m = /^\/api\/machines\/([^/]+)\/programs-history$/.exec(p);
      if (m && read) return json(200, { id: dec(m[1]), entries: programs.history(dec(m[1])) });
      m = /^\/api\/machines\/([^/]+)\/programs-history\/([^/]+)\/put-back$/.exec(p);
      if (m && method === 'POST') return json(200, programs.putBack(dec(m[1]), dec(m[2])));
      m = /^\/api\/machines\/([^/]+)\/programs\/([^/]+)$/.exec(p);
      if (m) {
        const id = dec(m[1]);
        const name = dec(m[2]);
        if (method === 'GET') {
          const r = programs.download(id, name);
          return new Response(r.data, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${r.name}"`, 'Cache-Control': 'no-store' } });
        }
        if (method === 'PUT') {
          const replace = ['1', 'true', 'yes'].includes(String(url.searchParams.get('replace') ?? '').toLowerCase());
          const r = programs.upload(id, name, await bodyBytes(init), { replace });
          return json(r.action === 'sent' ? 201 : 200, r);
        }
        if (method === 'DELETE') return json(200, programs.remove(id, name));
      }

      if (!read) return refuse(now, 'This is a demo, so that cannot be changed here.');
      return json(404, { serverTime: now, ok: false, error: 'NOT_IN_DEMO', message: 'Not part of the demo' });
    } catch (e) {
      if (e instanceof DemoProgramError || e instanceof DemoLayoutError) return failure(now, e);
      throw e;
    }
  }

  win.fetch = (input, init = {}) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const url = new URL(raw, win.location.href);
    if (url.origin !== win.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = String(init?.method ?? (typeof input === 'object' && typeof input?.method === 'string' ? input.method : 'GET')).toUpperCase();
    return answer(url, method, init).catch((e) => {
      win.console?.error?.('[demo] request failed', url.pathname, e);
      return json(500, { ok: false, error: 'DEMO_ERROR', message: 'The demo could not answer that.' });
    });
  };

  class DemoEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.withCredentials = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      ready.then(() => win.setTimeout(() => this._open(), 30), () => win.setTimeout(() => this._fail(), 30));
    }
    _open() {
      if (this.readyState === 2) return;
      this.readyState = 1;
      sources.add(this);
      const ev = new Event('open');
      this.dispatchEvent(ev);
      this.onopen?.(ev);
      const now = Date.now();
      advance(now);
      this._emit('snapshot', state(now));
    }
    _fail() {
      this.readyState = 2;
      const ev = new Event('error');
      this.dispatchEvent(ev);
      this.onerror?.(ev);
    }
    _emit(name, data) {
      if (this.readyState !== 1) return;
      const ev = new MessageEvent(name, { data: JSON.stringify(data) });
      this.dispatchEvent(ev);
      if (name === 'message') this.onmessage?.(ev);
    }
    close() {
      this.readyState = 2;
      sources.delete(this);
    }
  }
  win.EventSource = DemoEventSource;

  /** The ribbon's "Reset": drop this browser's layout and start the demo again. */
  win.__stacklightDemo = {
    async reset() {
      try { await ready; layouts.reset(); } catch { /* nothing stored */ }
      win.location.reload();
    },
  };
  return { ready };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.documentElement?.dataset?.demo === '1') install(window);
