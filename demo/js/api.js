// REST + SSE client for the HUD and the editor (docs/ARCHITECTURE.md §8, §11; DECISIONS D4, D5, D9, D18).
// - Same-origin only; every mutation sends Content-Type: application/json and, when one is stored, the edit
//   token as `Authorization: Bearer …` (never in a URL).
// - The token lives in sessionStorage unless "remember on this device" is chosen (then localStorage too).
// - connectEvents() wraps EventSource: named events, server-clock offset, manual re-creation of a CLOSED
//   EventSource with backoff, and a silence check (half-open connections).

const TOKEN_KEY = 'machine-shop-hud.edit-token';
let memoryToken = null; // when storage is unavailable (private mode, blocked site data)
/** @type {((info: {status:number, path:string, message?:string}) => Promise<string|null>)|null} */
let tokenProvider = null;

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, body?: any, errors?: any[], path?: string }} [info]
   */
  constructor(message, { status = 0, body = null, errors = null, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.errors = errors;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------
// Edit token
// ---------------------------------------------------------------------------------------------

function storageGet(store, key) {
  try { return globalThis[store]?.getItem(key) ?? null; } catch { return null; }
}
function storageSet(store, key, value) {
  try {
    if (value === null) globalThis[store]?.removeItem(key);
    else globalThis[store]?.setItem(key, value);
    return true;
  } catch { return false; }
}

/** Current edit token (session first, then "remembered"), or null. */
export function getEditToken() {
  return storageGet('sessionStorage', TOKEN_KEY) ?? storageGet('localStorage', TOKEN_KEY) ?? memoryToken;
}

/**
 * Store (or clear with null) the edit token.
 * @param {string|null} token
 * @param {{ remember?: boolean }} [opts]  remember → also kept in localStorage on this device
 */
export function setEditToken(token, { remember = false } = {}) {
  const t = typeof token === 'string' && token.trim() ? token.trim() : null;
  memoryToken = t;
  storageSet('sessionStorage', TOKEN_KEY, t);
  storageSet('localStorage', TOKEN_KEY, t && remember ? t : null);
}

/**
 * Called when a mutation is answered 401: resolve to a new token (it is stored and the request retried once)
 * or null to give up. The HUD installs a prompt here.
 */
export function setTokenProvider(fn) {
  tokenProvider = typeof fn === 'function' ? fn : null;
}

// ---------------------------------------------------------------------------------------------
// fetchJson
// ---------------------------------------------------------------------------------------------

/**
 * JSON request to the HUD server.
 * @param {string} path  absolute same-origin path, e.g. '/api/state'
 * @param {{ method?: string, body?: any, headers?: Record<string,string>, signal?: AbortSignal,
 *           timeoutMs?: number, meta?: boolean, auth?: boolean, askToken?: boolean, retryAuth?: boolean }} [opts]
 *   meta → resolve to { data, status, etag, headers } instead of the parsed body
 *   auth → send the token on a GET too (mutations always send it when one is stored)
 *   askToken → a 401 on a GET asks for the token once too (reads that need it, e.g. program transfer)
 * @returns {Promise<any>}
 */
export async function fetchJson(path, opts = {}) {
  const { method = 'GET', body, headers = {}, signal, timeoutMs = 15000, meta = false, auth = false, askToken = false, retryAuth = true } = opts;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new ApiError('Only same-origin paths are allowed', { path });
  const m = method.toUpperCase();
  const mutation = m !== 'GET' && m !== 'HEAD';
  const h = { Accept: 'application/json', ...headers };
  let payload;
  if (mutation) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body === undefined ? {} : body);
  }
  const token = getEditToken();
  if (token && (mutation || auth)) h.Authorization = `Bearer ${token}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  let text = '';
  try {
    res = await fetch(path, { method: m, headers: h, body: payload, signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    text = await res.text();
  } catch (e) {
    const timedOut = ctl.signal.reason?.name === 'TimeoutError';
    throw new ApiError(timedOut ? `Request timed out (${path})` : `Network error (${path})`, { status: 0, path });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (res.status === 401 && (mutation || askToken) && retryAuth && tokenProvider) {
    const next = await tokenProvider({ status: 401, path, message: data?.error ?? data?.message });
    if (next) return fetchJson(path, { ...opts, retryAuth: false });
  }
  if (!res.ok) {
    // server error bodies are { ok: false, error: CODE, message } — show the human message
    const msg = (data && (data.message || data.error)) || `${res.status} ${res.statusText || 'error'}`;
    const err = new ApiError(String(msg), { status: res.status, body: data, errors: Array.isArray(data?.errors) ? data.errors : null, path });
    err.code = typeof data?.error === 'string' ? data.error : null;
    throw err;
  }
  if (meta) return { data, status: res.status, etag: res.headers.get('ETag'), headers: res.headers };
  return data;
}

const enc = (s) => encodeURIComponent(String(s));

/** Query string for the per-view endpoints: ?layout=<id>&screen=<name> (both optional). */
export function viewQuery({ layout, screen } = {}) {
  const p = new URLSearchParams();
  if (layout) p.set('layout', layout);
  if (screen) p.set('screen', screen);
  const q = p.toString();
  return q ? `?${q}` : '';
}

/**
 * GET /api/state[?layout=&screen=] → { serverTime, bootId, version, layoutId, activeLayout, live, layout, screen,
 * machines, unassigned, agents, settings, discovery, tokenHelp }. `layoutId` is the layout the server resolved for this
 * view; `tokenHelp` says where this install shows the edit token (D14).
 * @param {{ layout?: string, screen?: string }} [view]
 */
export function getState(view = {}, opts) {
  return fetchJson(`/api/state${viewQuery(view)}`, opts);
}

/** GET /api/health → { ok, version, uptimeMs, bootId? } (rejects unless 200). */
export function health(opts) {
  return fetchJson('/api/health', { timeoutMs: 5000, ...opts });
}

// ---------------------------------------------------------------------------------------------
// Layouts (ETag / If-Match conflict detection, D5/D10)
// ---------------------------------------------------------------------------------------------

const etags = new Map();

export const layouts = {
  /** → [{ id, name, updatedAt, active }] */
  list: () => fetchJson('/api/layouts'),
  /** → layout JSON (its ETag is remembered for save) */
  async get(id) {
    const r = await fetchJson(`/api/layouts/${enc(id)}`, { meta: true });
    if (r.etag) etags.set(id, r.etag);
    return r.data;
  },
  /** ETag of the last get/save of this layout, or null. */
  etag: (id) => etags.get(id) ?? null,
  /**
   * PUT with If-Match (the remembered ETag unless `ifMatch` is given; `ifMatch: null` sends none).
   * 412/409 → ApiError with status 412/409 (the file changed underneath); 400 → ApiError with `errors`.
   */
  async save(id, layout, { ifMatch } = {}) {
    const tag = ifMatch === undefined ? etags.get(id) : ifMatch;
    const r = await fetchJson(`/api/layouts/${enc(id)}`, { method: 'PUT', body: layout, headers: tag ? { 'If-Match': tag } : {}, meta: true });
    if (r.etag) etags.set(id, r.etag);
    return r.data;
  },
  async create(layout) {
    const r = await fetchJson('/api/layouts', { method: 'POST', body: layout, meta: true });
    if (r.etag && layout?.id) etags.set(layout.id, r.etag);
    return r.data;
  },
  remove: (id) => fetchJson(`/api/layouts/${enc(id)}`, { method: 'DELETE' }),
  activate: (id) => fetchJson(`/api/layouts/${enc(id)}/activate`, { method: 'POST' }),
  versions: (id) => fetchJson(`/api/layouts/${enc(id)}/versions`),
  restore: (id, version) => fetchJson(`/api/layouts/${enc(id)}/versions/${enc(version)}/restore`, { method: 'POST' }),
};

// ---------------------------------------------------------------------------------------------
// Discovery, machines, settings, connectors
// ---------------------------------------------------------------------------------------------

export const discovery = {
  /** → { status: { running, progress, … }, result: DiscoveryResult|null, full } */
  get: () => fetchJson('/api/discovery'),
  /** Start a scan (token). `opts` = { cidrs?, ports? } → 202 + progress over SSE 'discovery'. */
  scan: (opts = {}) => fetchJson('/api/discovery/scan', { method: 'POST', body: opts }),
  /** Cancel a running scan (token). */
  cancel: () => fetchJson('/api/discovery/scan', { method: 'DELETE' }),
};

/** GET /api/machines/:id/history?hours=12 → { timeline, utilization, events } */
export function machineHistory(id, hours = 12) {
  const h = Math.min(168, Math.max(1, Number(hours) || 12));
  return fetchJson(`/api/machines/${enc(id)}/history?hours=${h}`);
}

/** Planned downtime (D1): POST { until?, note } marks out of service; DELETE returns it to service (token). */
export const machineService = {
  set: (id, { until = null, note = '' } = {}) => fetchJson(`/api/machines/${enc(id)}/service`, { method: 'POST', body: { until, note } }),
  clear: (id) => fetchJson(`/api/machines/${enc(id)}/service`, { method: 'DELETE' }),
};

/** Program runs (DECISIONS D12): list a period, invalidate (bad parts, test run …) or count again (token). */
export const runs = {
  /** GET /api/runs?from&to&machine → { from, to, enabled, runs, truncated }; `to` omitted = up to now */
  list: ({ from, to, machine } = {}) => {
    const q = new URLSearchParams();
    if (Number.isFinite(from)) q.set('from', String(Math.floor(from)));
    if (Number.isFinite(to)) q.set('to', String(Math.floor(to)));
    if (machine) q.set('machine', machine);
    const s = q.toString();
    return fetchJson(`/api/runs${s ? `?${s}` : ''}`, { timeoutMs: 30000 });
  },
  invalidate: (id, { reason, note = '' }) => fetchJson(`/api/runs/${enc(id)}/invalidate`, { method: 'POST', body: { reason, note } }),
  restore: (id) => fetchJson(`/api/runs/${enc(id)}/invalidate`, { method: 'DELETE' }),
};

export const settings = {
  get: () => fetchJson('/api/settings'),
  save: (patch) => fetchJson('/api/settings', { method: 'PUT', body: patch }),
};

export const connectors = {
  list: () => fetchJson('/api/connectors'),
  /** Test connection for a candidate source (token): → { device, snapshot } */
  test: (source) => fetchJson('/api/connectors/test', { method: 'POST', body: { source }, timeoutMs: 30000 }),
};

// ---------------------------------------------------------------------------------------------
// Program transfer (DECISIONS D16): shop network only, the edit token for everything
// ---------------------------------------------------------------------------------------------

/**
 * Request with a raw body or answer (program uploads and downloads), with the edit token; a 401 asks for the
 * token once, like fetchJson. Resolves the Response (status 2xx) or throws ApiError with `code` and `body`.
 */
async function fetchRaw(path, { method = 'GET', body, headers = {}, timeoutMs = 300000, retryAuth = true } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new ApiError('Only same-origin paths are allowed', { path });
  const h = { ...headers };
  const token = getEditToken();
  if (token) h.Authorization = `Bearer ${token}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(path, { method, headers: h, body, signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    } catch {
      throw new ApiError(ctl.signal.reason?.name === 'TimeoutError' ? `Request timed out (${path})` : `Network error (${path})`, { status: 0, path });
    }
    if (res.ok) return res;
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { data = null; }
    if (res.status === 401 && retryAuth && tokenProvider) {
      const next = await tokenProvider({ status: 401, path, message: data?.error ?? data?.message });
      if (next) return fetchRaw(path, { method, body, headers, timeoutMs, retryAuth: false });
    }
    const err = new ApiError(String((data && (data.message || data.error)) || `${res.status} ${res.statusText || 'error'}`), { status: res.status, body: data, path });
    err.code = typeof data?.error === 'string' ? data.error : null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const programs = {
  /** Setup: { enabled, maxUploadMB, machines: [{ id, name, enabled, host, linkedHost, port, folder, loginSaved }] } */
  overview: () => fetchJson('/api/programs', { auth: true, askToken: true }),
  /** { machine, status: { known, running, program }, files: [{ name, size, modified, comment, firstLine, inUse }], firstLinesPending, maxUploadMB } */
  list: (id) => fetchJson(`/api/machines/${enc(id)}/programs`, { auth: true, askToken: true, timeoutMs: 60000 }),
  history: (id) => fetchJson(`/api/machines/${enc(id)}/programs-history`, { auth: true, askToken: true }),
  /** Read the next first lines: { lines: { name: line }, pending } */
  firstLines: (id) => fetchJson(`/api/machines/${enc(id)}/programs-first-lines`, { auth: true, timeoutMs: 60000 }),
  /** Send one program (Blob/ArrayBuffer). 409 EXISTS → ask, then again with replace. */
  async upload(id, name, data, { replace = false } = {}) {
    const res = await fetchRaw(`/api/machines/${enc(id)}/programs/${enc(name)}${replace ? '?replace=1' : ''}`, {
      method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
    });
    return res.json();
  },
  /** Download one program → Blob. */
  async download(id, name) {
    return (await fetchRaw(`/api/machines/${enc(id)}/programs/${enc(name)}`)).blob();
  },
  remove: (id, name) => fetchJson(`/api/machines/${enc(id)}/programs/${enc(name)}`, { method: 'DELETE', timeoutMs: 300000 }),
  putBack: (id, entryId) => fetchJson(`/api/machines/${enc(id)}/programs-history/${enc(entryId)}/put-back`, { method: 'POST', timeoutMs: 300000 }),
  saveLogin: (id, username, password) => fetchJson(`/api/programs/machines/${enc(id)}/login`, { method: 'PUT', body: { username, password } }),
  forgetLogin: (id) => fetchJson(`/api/programs/machines/${enc(id)}/login`, { method: 'DELETE' }),
  test: (id) => fetchJson(`/api/programs/machines/${enc(id)}/test`, { method: 'POST', timeoutMs: 60000 }),
};

// ---------------------------------------------------------------------------------------------
// Maintenance (DECISIONS D18): reads are open; writes need the edit token (or the HUD PC's own browser)
// ---------------------------------------------------------------------------------------------

const machinePath = (id) => `/api/maintenance/machines/${enc(id)}`;

export const maintenance = {
  /**
   * GET /api/maintenance[?machine=] → { enabled, available, catalogVersion, soonPercent, now, counts,
   * machines: [{ id, name, setUp, model, suggested, control, note, service, facts, meters, pace, counts, documents, tasks }] }
   */
  get: ({ machine } = {}) => fetchJson(`/api/maintenance${machine ? `?machine=${enc(machine)}` : ''}`),
  /**
   * Set up: GET /api/maintenance/catalog?machine=[&model=] → { version, about, models, suggested, model, control, note,
   * service, facts, reviewed, entries }. `model` undefined: the machine's chosen model, else the suggestion; '': none.
   */
  catalog: (machine, { model } = {}) => {
    const q = new URLSearchParams({ machine: String(machine) });
    if (typeof model === 'string') q.set('model', model);
    return fetchJson(`/api/maintenance/catalog?${q}`);
  },
  /** Save Set up: { model, tasks: [{ catalogId, every?, orEvery? }] } → { ok, added, enabled, disabled, machine } */
  setup: (machine, body) => fetchJson(machinePath(machine), { method: 'PUT', body }),
  /** A task of the shop's own: { title, action?, kind?, basis?, every?, orEvery?, alarm?: { codes, within? }, link? } → { ok, task } */
  addTask: (machine, task) => fetchJson(`${machinePath(machine)}/tasks`, { method: 'POST', body: task }),
  /** Change a task: { title?, action?, basis?, every?, orEvery?, alarm?, link?, enabled? } → { ok, task } */
  editTask: (machine, task, changes) => fetchJson(`${machinePath(machine)}/tasks/${enc(task)}`, { method: 'PUT', body: changes }),
  removeTask: (machine, task) => fetchJson(`${machinePath(machine)}/tasks/${enc(task)}`, { method: 'DELETE' }),
  /** Done…: { how: 'now'|'date'|'reading'|'start', date?: 'YYYY-MM-DD', reading?: hours, note? } → { ok, task, warning? } */
  done: (machine, task, body) => fetchJson(`${machinePath(machine)}/tasks/${enc(task)}/done`, { method: 'POST', body }),
  /** Count all from now: every enabled task without a start → { ok, started } */
  start: (machine) => fetchJson(`${machinePath(machine)}/start`, { method: 'POST', body: {} }),
  /** GET /api/maintenance/log?machine=&limit= → { entries: [{ at, machineId, taskId, action, title, how, note }] }, newest first */
  log: ({ machine, limit } = {}) => {
    const q = new URLSearchParams();
    if (machine) q.set('machine', machine);
    if (Number.isFinite(limit)) q.set('limit', String(Math.floor(limit)));
    const s = q.toString();
    return fetchJson(`/api/maintenance/log${s ? `?${s}` : ''}`);
  },
};

// ---------------------------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------------------------

const KNOWN_EVENTS = ['snapshot', 'machine', 'machines', 'unassigned', 'agents', 'layout', 'layouts', 'discovery', 'ping', 'settings', 'service', 'runs', 'maintenance', 'hello', 'shutdown'];

/**
 * Connect to /api/events (pass `url: '/api/events' + viewQuery(view)` for a screen or layout view).
 * `handlers` maps event names to callbacks `(data, name)`; extra keys:
 * `open()`, `error({ readyState })`, `any(name, data)`. Every message updates the server-clock offset from
 * its `serverTime` (the max of the last 10 samples ≈ the lowest-latency estimate; reset on a clock step).
 * @param {Record<string, Function>} handlers
 * @param {{ url?: string, maxBackoffMs?: number, silenceMs?: number }} [opts]
 */
export function connectEvents(handlers = {}, { url = '/api/events', maxBackoffMs = 30000, silenceMs = 45000 } = {}) {
  /** @type {EventSource|null} */
  let es = null;
  let closed = false;
  let backoff = 1000;
  let retryTimer = null;
  let samples = [];
  let serverOffsetMs = 0;
  let lastMessageAt = performance.now();  // last real message (staleness: an open socket alone proves nothing)
  let lastActivityAt = performance.now(); // last message or (re)open — paces silence-triggered reconnects
  let lastMessageWall = 0;
  let opened = false;

  const names = new Set([...KNOWN_EVENTS, ...Object.keys(handlers).filter((k) => !['open', 'error', 'any', 'message'].includes(k))]);

  function noteServerTime(serverTime, rttMs = 0) {
    if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
    const sample = serverTime + Math.max(0, rttMs) / 2 - Date.now();
    if (samples.length && Math.abs(sample - serverOffsetMs) > 2000) samples = []; // a clock stepped
    samples.push(sample);
    if (samples.length > 10) samples.shift();
    serverOffsetMs = Math.max(...samples);
  }

  function deliver(name, ev) {
    lastMessageAt = performance.now();
    lastActivityAt = lastMessageAt;
    lastMessageWall = Date.now();
    let data = null;
    if (ev.data) {
      try { data = JSON.parse(ev.data); } catch { data = null; }
    }
    if (data && typeof data === 'object') noteServerTime(data.serverTime);
    try {
      handlers.any?.(name, data);
      handlers[name]?.(data, name);
    } catch (e) {
      console.error(`[events] ${name} handler failed`, e);
    }
  }

  function open() {
    if (closed) return;
    try { es = new EventSource(url); } catch { scheduleReopen(); return; }
    opened = false;
    es.onopen = () => {
      opened = true;
      backoff = 1000;
      lastActivityAt = performance.now();
      handlers.open?.();
    };
    es.onerror = () => {
      opened = false;
      const state = es?.readyState;
      handlers.error?.({ readyState: state });
      // The browser retries CONNECTING by itself; a CLOSED EventSource (HTTP error, wrong type) never comes back.
      if (state === EventSource.CLOSED) scheduleReopen();
    };
    es.onmessage = (ev) => deliver('message', ev);
    for (const n of names) es.addEventListener(n, (ev) => deliver(n, ev));
  }

  function teardown() {
    if (es) {
      es.onopen = es.onerror = es.onmessage = null;
      es.close();
      es = null;
    }
    opened = false;
  }

  function scheduleReopen() {
    if (closed) return;
    teardown();
    clearTimeout(retryTimer);
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
    backoff = Math.min(maxBackoffMs, backoff * 2);
    retryTimer = setTimeout(open, delay);
  }

  // Half-open connections (Wi-Fi drop, sleeping proxy) look OPEN but deliver nothing: the server pings every
  // 15 s, so silence for `silenceMs` means re-create the EventSource.
  const silenceTimer = setInterval(() => {
    if (!closed && es && performance.now() - lastActivityAt > silenceMs) {
      lastActivityAt = performance.now();
      scheduleReopen();
    }
  }, 5000);

  open();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(silenceTimer);
      teardown();
    },
    /** Drop the current connection and reconnect now. */
    reconnect() {
      if (closed) return;
      backoff = 1000;
      lastActivityAt = performance.now();
      teardown();
      clearTimeout(retryTimer);
      open();
    },
    noteServerTime,
    /** Server-clock now (ms). */
    now: () => Date.now() + serverOffsetMs,
    get serverOffsetMs() { return serverOffsetMs; },
    get connected() { return opened; },
    /** performance.now() of the last message (monotonic). */
    get lastMessageAt() { return lastMessageAt; },
    /** Date.now() of the last message, 0 before the first one. */
    get lastMessageWall() { return lastMessageWall; },
    get readyState() { return es ? es.readyState : 2; },
  };
}
