// Machine data-source specs (layout `machine.source`) for every supported interface protocol.
// Pure ESM shared by the server (registry, validation) and the browser (editor binding form).
// See docs/ARCHITECTURE.md §13 and docs/LAYOUTS.md.
//
//   { "protocol": "mtconnect", "agent": "http://10.0.20.31:8082", "device": "VF2" }          (default protocol)
//   { "protocol": "focas",     "host": "10.0.20.32", "port": 8193, "path": 1 }               FANUC FOCAS2/Ethernet
//   { "protocol": "haas-mdc",  "host": "10.0.20.33", "port": 5051 }                          Haas Q-commands (MDC)
//   { "protocol": "opcua",     "endpoint": "opc.tcp://10.0.20.34:4840", "profile": "sinumerik", "credentialsRef": "m-5ax" }
// Optional on every protocol: "vendor" (profile id, e.g. "haas", "fanuc"), "name" (device name override),
// and the identity captured when the machine was linked (DECISIONS D6): "uuid" and "serialNumber". The registry
// verifies them on every (re)connect and shows the machine UNBOUND "Different device at <addr>" on a mismatch.

export const PROTOCOLS = Object.freeze({
  mtconnect: { label: 'MTConnect', defaultPort: 5000, description: 'MTConnect agent over HTTP (native CNC agents or cppagent)' },
  focas: { label: 'FANUC FOCAS2', defaultPort: 8193, description: 'FANUC FOCAS2 over embedded Ethernet' },
  'haas-mdc': { label: 'Haas MDC (Q-commands)', defaultPort: null, description: 'Haas Machine Data Collection Q-commands over TCP' },
  opcua: { label: 'OPC UA', defaultPort: 4840, description: 'OPC UA binary (Siemens Sinumerik, Heidenhain, umati machine tools)' },
});

export const OPCUA_PROFILES = Object.freeze(['auto', 'sinumerik', 'heidenhain', 'umati', 'okuma', 'generic']);

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:]+:[0-9A-Fa-f:.]*)$/;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const VENDOR_RE = /^[a-z0-9-]{1,30}$/;

/** Identity keys captured at bind time (DECISIONS D6) — accepted on every protocol. */
export const IDENTITY_KEYS = Object.freeze(['uuid', 'serialNumber']);

const ALLOWED = Object.freeze({
  mtconnect: ['protocol', 'agent', 'device', 'vendor', 'name', ...IDENTITY_KEYS],
  focas: ['protocol', 'host', 'port', 'path', 'vendor', 'name', ...IDENTITY_KEYS],
  'haas-mdc': ['protocol', 'host', 'port', 'vendor', 'name', ...IDENTITY_KEYS],
  opcua: ['protocol', 'endpoint', 'profile', 'credentialsRef', 'securityMode', 'vendor', 'name', ...IDENTITY_KEYS],
});

const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

const AGENT_URL_ERROR = 'agent must be an http:// or https:// URL';

/**
 * Canonical MTConnect agent base URL (DECISIONS D8): http/https only; no user info (it would be published to
 * every viewer), query or fragment; lower-case host, default port elided, no trailing slash. Device-scoped
 * base URLs such as http://h:5000/Mazak keep their (case-sensitive) path. IPv6 zone ids are unsupported.
 * @param {unknown} s
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function normalizeAgentUrl(s) {
  if (typeof s !== 'string' || !s.trim() || s.length > 500) return { ok: false, error: AGENT_URL_ERROR };
  let u;
  try { u = new URL(s.trim()); } catch { return { ok: false, error: AGENT_URL_ERROR }; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return { ok: false, error: AGENT_URL_ERROR };
  if (u.username || u.password) return { ok: false, error: 'agent URL must not contain a user name or password' };
  if (u.search || u.hash) return { ok: false, error: 'agent URL must not contain a query (?…) or fragment (#…)' };
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}
function opcUrl(s) {
  if (typeof s !== 'string' || !/^opc\.tcp:\/\//i.test(s) || s.length > 300) return false;
  try { const u = new URL(s.replace(/^opc\.tcp:/i, 'http:')); return !!u.hostname; } catch { return false; }
}

/**
 * Validate and normalize a source spec. Never throws.
 * @param {unknown} src
 * @param {string} [path]  error path prefix, e.g. 'machines[2].source'
 * @returns {{ errors: {path:string, message:string}[], source: object|null }}
 */
export function validateSource(src, path = 'source') {
  const errors = [];
  const err = (p, message) => errors.push({ path: p ? `${path}.${p}` : path, message });
  if (src === null || src === undefined) return { errors, source: null };
  if (typeof src !== 'object' || Array.isArray(src)) { err('', 'source must be an object or null'); return { errors, source: null }; }
  const s = { ...src };
  for (const k of Object.keys(s)) if (s[k] === '' || s[k] === null) delete s[k];
  if (s.protocol === undefined) s.protocol = 'mtconnect';
  if (!Object.prototype.hasOwnProperty.call(PROTOCOLS, s.protocol)) {
    err('protocol', `protocol must be one of ${Object.keys(PROTOCOLS).join(', ')}`);
    return { errors, source: null };
  }
  for (const k of Object.keys(s)) if (!ALLOWED[s.protocol].includes(k)) err(k, `"${k}" is not used by ${s.protocol} sources`);
  if (s.vendor !== undefined && (typeof s.vendor !== 'string' || !VENDOR_RE.test(s.vendor))) err('vendor', 'vendor must be a profile id like "haas" or "fanuc"');
  if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 120)) err('name', 'name must be text (max 120)');
  if (s.uuid !== undefined && (typeof s.uuid !== 'string' || s.uuid.length > 200)) err('uuid', 'uuid must be the device uuid captured when the machine was linked (max 200)');
  if (s.serialNumber !== undefined && (typeof s.serialNumber !== 'string' || s.serialNumber.length > 120)) err('serialNumber', 'serialNumber must be text (max 120)');

  switch (s.protocol) {
    case 'mtconnect':
      if (s.agent !== undefined) {
        const n = normalizeAgentUrl(s.agent);
        if (!n.ok) err('agent', n.error);
        else s.agent = n.url;
      }
      if (s.device !== undefined && (typeof s.device !== 'string' || s.device.length > 200)) err('device', 'device must be the MTConnect device name or uuid');
      if (s.agent === undefined && s.device === undefined && s.uuid === undefined) return { errors, source: null }; // empty → unbound
      break;
    case 'focas':
      if (typeof s.host !== 'string' || !HOST_RE.test(s.host)) err('host', 'host must be an IP address or host name');
      if (s.port === undefined) s.port = 8193; else if (!isPort(s.port)) err('port', 'port must be 1-65535');
      if (s.path === undefined) s.path = 1; else if (!Number.isInteger(s.path) || s.path < 1 || s.path > 10) err('path', 'path must be 1-10');
      break;
    case 'haas-mdc':
      if (typeof s.host !== 'string' || !HOST_RE.test(s.host)) err('host', 'host must be an IP address or host name');
      if (!isPort(s.port)) err('port', 'port is required (Haas Setting 143 value, or the serial bridge port)');
      break;
    case 'opcua':
      if (!opcUrl(s.endpoint)) err('endpoint', 'endpoint must look like opc.tcp://host:4840');
      if (s.profile === undefined) s.profile = 'auto'; else if (!OPCUA_PROFILES.includes(s.profile)) err('profile', `profile must be one of ${OPCUA_PROFILES.join(', ')}`);
      if (s.credentialsRef !== undefined && (typeof s.credentialsRef !== 'string' || !KEY_RE.test(s.credentialsRef))) err('credentialsRef', 'credentialsRef must be a key in config/credentials.json');
      if (s.securityMode === undefined) s.securityMode = 'None';
      else if (!['None', 'Sign', 'SignAndEncrypt'].includes(s.securityMode)) err('securityMode', 'securityMode must be None, Sign or SignAndEncrypt');
      break;
  }
  return { errors, source: errors.length ? null : s };
}

/**
 * Canonical host for keys and labels: lower case; IPv6 literals in brackets and in their shortest form
 * ("::1", "[::1]" and "[0:0:0:0:0:0:0:1]" all give "[::1]"). IPv4 and host names are only lower-cased.
 * @param {unknown} host
 */
export function canonicalHost(host) {
  let h = String(host ?? '').trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h.includes(':')) return h.toLowerCase();
  try { return new URL(`http://[${h}]/`).hostname; } catch { return `[${h.toLowerCase()}]`; }
}

/** "host:port", with an IPv6 host in brackets. */
export function formatHostPort(host, port) {
  const h = canonicalHost(host);
  return port === undefined || port === null || port === '' ? h : `${h}:${port}`;
}

/** opc.tcp://host[:port][/path] → { host (canonical), port (default 4840), path (no trailing slash) } or null. */
function opcParts(endpoint) {
  const m = /^opc\.tcp:\/\/([^/?#]*)([^?#]*)/i.exec(String(endpoint ?? '').trim());
  if (!m) return null;
  const a = /^(\[[^\]]*\]|[^:@]*)(?::(\d*))?$/.exec(m[1]);
  if (!a || !a[1]) return null;
  return { host: canonicalHost(a[1]), port: a[2] ? Number(a[2]) : PROTOCOLS.opcua.defaultPort, path: m[2].replace(/\/+$/, '') };
}

/**
 * Network address a source points at: { host (canonical), port } with each protocol's default port filled in,
 * or null when it has none (an agent-less MTConnect source).
 */
export function sourceAddress(source) {
  if (!source || typeof source !== 'object') return null;
  switch (source.protocol || 'mtconnect') {
    case 'mtconnect': {
      const n = source.agent !== undefined ? normalizeAgentUrl(source.agent) : null;
      if (!n?.ok) return null;
      const u = new URL(n.url);
      return { host: canonicalHost(u.hostname), port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80 };
    }
    case 'focas': return source.host ? { host: canonicalHost(source.host), port: Number(source.port ?? PROTOCOLS.focas.defaultPort) } : null;
    case 'haas-mdc': return source.host ? { host: canonicalHost(source.host), port: source.port === undefined || source.port === null ? null : Number(source.port) } : null;
    case 'opcua': { const o = opcParts(source.endpoint); return o ? { host: o.host, port: o.port } : null; }
    default: return null;
  }
}

/**
 * Stable connection key: one connector per key (several machines may share an MTConnect agent). The address is
 * normalised the same way for every protocol (canonicalHost, default ports filled in, MTConnect agent URLs per
 * normalizeAgentUrl, OPC UA endpoint paths without a trailing slash), so a source typed in the editor, one read
 * from a layout and one returned by discovery give the same key when they point at the same control.
 */
export function endpointKey(source) {
  if (!source) return null;
  switch (source.protocol || 'mtconnect') {
    case 'mtconnect': {
      if (!source.agent) return null; // agent-less → resolved via discovery
      const n = normalizeAgentUrl(source.agent);
      return `mtconnect:${n.ok ? n.url : source.agent}`;
    }
    case 'focas': return `focas:${canonicalHost(source.host)}:${source.port ?? PROTOCOLS.focas.defaultPort}:${source.path ?? 1}`;
    case 'haas-mdc': return `haas-mdc:${canonicalHost(source.host)}:${source.port}`;
    case 'opcua': {
      if (source.endpoint === undefined || source.endpoint === null) return null;
      const o = opcParts(source.endpoint);
      return o ? `opcua:opc.tcp://${o.host}:${o.port}${o.path}` : `opcua:${source.endpoint}`;
    }
    default: return null;
  }
}

/**
 * Looser key than endpointKey: protocol + host + port only (no FOCAS path, no OPC UA endpoint path). Used to say
 * that a discovery hit (which probes FOCAS path 1 and reports the server's own endpoint path) is on the plan.
 */
export function addressKey(source) {
  const a = sourceAddress(source);
  return a ? `${source.protocol || 'mtconnect'}:${formatHostPort(a.host, a.port)}` : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsWord = (hay, word) => new RegExp(`(^|[^a-z0-9])${escapeRe(word)}($|[^a-z0-9])`, 'i').test(hay);

/**
 * Display labels for a list of devices or discovery hits ({ name, source }), so no two read the same:
 *  - when a host is shared by more than one entry, a bare host in a label gets its port ("FANUC … · 10.0.0.5"
 *    → "FANUC … · 10.0.0.5:8193");
 *  - labels that are still equal get " · host:port" appended.
 * @param {{ name?: string|null, source?: object|null }[]} items
 * @param {string} [fallback]
 * @returns {string[]}
 */
export function deviceLabels(items, fallback = 'Device') {
  const list = Array.isArray(items) ? items : [];
  const addrs = list.map((it) => sourceAddress(it?.source));
  const perHost = new Map();
  for (const a of addrs) if (a) perHost.set(a.host, (perHost.get(a.host) ?? 0) + 1);
  const labels = list.map((it, i) => {
    let label = typeof it?.name === 'string' && it.name.trim() ? it.name.trim() : fallback;
    const a = addrs[i];
    if (a && a.port !== null && perHost.get(a.host) > 1 && !label.includes(formatHostPort(a.host, a.port))) {
      const bare = a.host.startsWith('[') ? [a.host, a.host.slice(1, -1)] : [a.host];
      for (const b of bare) {
        const re = new RegExp(`(^|[^A-Za-z0-9.:\\[])${escapeRe(b)}(?![A-Za-z0-9.:\\]])`, 'i');
        if (re.test(label)) { label = label.replace(re, (_, pre) => `${pre}${formatHostPort(a.host, a.port)}`); break; }
      }
    }
    return label;
  });
  const count = new Map();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);
  return labels.map((l, i) => {
    const a = addrs[i];
    if (count.get(l) < 2 || !a) return l;
    const where = formatHostPort(a.host, a.port);
    return l.includes(where) ? l : `${l} · ${where}`;
  });
}

/**
 * Detail parts (manufacturer, model, version …) worth showing next to a name: empty values, repeats and parts
 * already in `name` are left out, so "Model X (Model X)" or "fanuc · FANUC …" never shows a value twice.
 * @param {unknown[]} parts
 * @param {string} [name]
 * @returns {string[]}
 */
export function distinctParts(parts, name = '') {
  const out = [];
  for (const p of parts) {
    if (p === null || p === undefined || p === '') continue;
    const s = String(p).trim();
    if (!s) continue;
    if (name && containsWord(String(name), s)) continue;
    if (out.some((o) => o.toLowerCase() === s.toLowerCase() || containsWord(o, s))) continue;
    out.push(s);
  }
  return out;
}

/** Short human description, e.g. "FANUC FOCAS2 · 10.0.20.32:8193". */
export function describeSource(source) {
  if (!source) return 'Not linked';
  const p = PROTOCOLS[source.protocol || 'mtconnect']?.label ?? source.protocol;
  switch (source.protocol || 'mtconnect') {
    case 'mtconnect': return `${p} · ${source.agent ?? 'any agent'}${source.device ? ` · ${source.device}` : ''}`;
    case 'focas': return `${p} · ${source.host}:${source.port ?? 8193}${(source.path ?? 1) !== 1 ? ` · path ${source.path}` : ''}`;
    case 'haas-mdc': return `${p} · ${source.host}:${source.port}`;
    case 'opcua': return `${p} · ${source.endpoint}${source.profile && source.profile !== 'auto' ? ` · ${source.profile}` : ''}`;
    default: return p;
  }
}
