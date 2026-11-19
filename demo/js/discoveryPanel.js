// Basic discovery panel (view mode): the last DiscoveryResult — MTConnect agents and their devices, other
// protocol hits (FANUC FOCAS, OPC UA, Haas MDC), SHDR adapters, errors — plus live devices that are not on the
// plan, and a Scan button (edit token, docs/DECISIONS.md D8/D9). Every device that is not on the plan has a
// "Link…" button: pick its machine (the likely one is suggested) and the layout is saved (edit token, D14). The
// editor's Devices panel does the same by drag and drop. Every string is rendered with textContent.
import { PROTOCOLS, endpointKey, addressKey, deviceLabels, distinctParts, formatHostPort } from '/shared/sources.js';
import { iconSvg } from './icons.js';
import { rankMachines, pickMachine, linkToMachine } from './linkPicker.js';
import { formatSinceClock, paletteFor } from './statusStyle.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (...vals) => vals.find(finite) ?? null;

/** { phase, done, total, network, … } (server) → { done, total, message } for the progress bar. */
function normalizeProgress(p) {
  const total = num(p.total, p.hosts);
  let done = num(p.done, p.scanned, p.hostsScanned);
  if (done === null && finite(p.percent) && total) done = Math.round((p.percent / 100) * total);
  const bits = [];
  if (typeof p.network === 'string' && p.network) bits.push(p.network);
  if (finite(p.found) && p.found > 0) bits.push(`${p.found} found`);
  if (typeof p.message === 'string' && p.message) bits.push(p.message);
  return { phase: typeof p.phase === 'string' ? p.phase : '', done, total, message: bits.join(' · ') };
}
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/**
 * Summary line of the last scan: "Last scan 3:14 PM · 2.4 s · 1 host" (null before any scan finished).
 * @param {{ finishedAt?: number, durationMs?: number, hostsScanned?: number }} r  DiscoveryResult
 * @param {number} now  server-clock ms
 * @param {{ clock24h?: boolean, timeZone?: string }} [clockOpts]
 */
export function lastScanLine(r, now, clockOpts = {}) {
  if (!r || !finite(r.finishedAt)) return null;
  const dur = finite(r.durationMs) ? ` · ${(r.durationMs / 1000).toFixed(1)} s` : '';
  const hosts = finite(r.hostsScanned) ? ` · ${r.hostsScanned} ${r.hostsScanned === 1 ? 'host' : 'hosts'}` : '';
  return `Last scan ${formatSinceClock(r.finishedAt, now, clockOpts)}${dur}${hosts}`;
}
const arr = (v) => (Array.isArray(v) ? v : []);

/** Source spec of a discovery hit: its own `source`, else one built from its endpoint or host and port. */
export function hitSource(x) {
  if (!x || typeof x !== 'object') return null;
  if (x.source && typeof x.source === 'object') return { protocol: x.protocol, ...x.source };
  if (x.endpoint) return { protocol: x.protocol, endpoint: str(x.endpoint) };
  if (!x.host) return null;
  const port = x.port !== undefined && x.port !== null && x.port !== '' ? Number(x.port) : undefined;
  if (x.protocol === 'opcua') return { protocol: 'opcua', endpoint: `opc.tcp://${formatHostPort(str(x.host), port)}` };
  return { protocol: x.protocol, host: str(x.host), ...(port !== undefined ? { port } : {}) };
}

/**
 * Index of the machines on the plan for "On plan" hints. Both sides go through src/shared/sources.js endpointKey
 * (exact) and addressKey (protocol + host + port), so every protocol, IPv6 literals and default ports match
 * however the address was written.
 * @param {object[]} machines  layout machines
 */
export function buildPlanIndex(machines) {
  const idx = new Map();
  const put = (k, name) => { if (k && !idx.has(k)) idx.set(k, name); };
  for (const m of arr(machines)) {
    const s = m?.source;
    if (!s || typeof s !== 'object') continue;
    const p = s.protocol || 'mtconnect';
    if (p === 'mtconnect') {
      const ek = endpointKey(s) ?? '*';
      for (const id of [s.device, s.uuid].filter(Boolean).map(str)) {
        put(`dev:${ek}|${id}`, m.name);
        if (!endpointKey(s)) put(`name:${id}`, m.name); // agent-less: resolved by device name/uuid on any agent
      }
      if (!s.device && !s.uuid && endpointKey(s)) put(`agent:${ek}`, m.name);
    } else {
      put(`ep:${endpointKey(s)}`, m.name);
      put(`addr:${addressKey(s)}`, m.name);
    }
  }
  return idx;
}

/**
 * Machine name on the plan for a discovered source, or undefined.
 * @param {Map<string, string>} idx  buildPlanIndex result
 * @param {object|null} src  { protocol, … } (MTConnect: agent + device/uuid of one device)
 */
export function planLookup(idx, src) {
  if (!src || typeof src !== 'object') return undefined;
  const p = src.protocol || 'mtconnect';
  if (p === 'mtconnect') {
    const ek = endpointKey({ ...src, protocol: 'mtconnect' });
    const ids = [src.device, src.uuid].filter(Boolean).map(str);
    for (const id of ids) { const n = idx.get(`dev:${ek}|${id}`); if (n !== undefined) return n; }
    for (const id of ids) { const n = idx.get(`name:${id}`); if (n !== undefined) return n; }
    return ek ? idx.get(`agent:${ek}`) : undefined;
  }
  return idx.get(`ep:${endpointKey(src)}`) ?? idx.get(`addr:${addressKey(src)}`);
}

/** Index of live devices not on the plan by endpoint and address (the scan rows borrow their kind and source). */
function liveIndex(unassigned) {
  const idx = new Map();
  for (const s of arr(unassigned)) {
    const src = s?.binding?.source;
    if (!src || typeof src !== 'object') continue;
    const ek = endpointKey(src), ak = addressKey(src);
    if (ek && !idx.has(`ep:${ek}`)) idx.set(`ep:${ek}`, s);
    if (ak && !idx.has(`addr:${ak}`)) idx.set(`addr:${ak}`, s);
  }
  return (src) => (src && typeof src === 'object' ? idx.get(`ep:${endpointKey(src)}`) ?? idx.get(`addr:${addressKey(src)}`) : undefined);
}

/**
 * @param {HTMLElement} el  drawer container
 * @param {{ api: object, getContext: () => ({ now: number, settings: object, theme: string, kiosk: boolean }),
 *           getLayout: () => object|null, getUnassigned: () => object[], toast?: Function, onClose?: Function,
 *           readOnly?: () => boolean }} deps
 */
export function createDiscoveryPanel(el, deps) {
  const { api, getContext, getLayout, getUnassigned, toast, onClose, readOnly } = deps;
  let linking = false;
  let result = null;
  let loadError = null;
  let progress = null; // { done, total, phase, message }
  let scanning = false;

  el.replaceChildren();
  el.classList.add('drawer', 'discovery');
  el.hidden = true;
  el.setAttribute('aria-label', 'Discovery');
  const head = h('header', 'drawer-head plain');
  const title = h('h2', 'd-name', 'Discovery');
  const sub = h('div', 'd-sub', 'Machines and agents found on the network');
  const close = h('button', 'btn btn-icon drawer-close');
  close.type = 'button';
  close.title = 'Close';
  close.append(iconSvg('close', { size: null }));
  head.append(title, sub, close);
  const toolbar = h('div', 'disc-toolbar');
  const scanBtn = h('button', 'btn btn-primary');
  scanBtn.type = 'button';
  scanBtn.append(iconSvg('search', { size: null }), h('span', null, 'Scan now'));
  const cancelBtn = h('button', 'btn', 'Cancel scan');
  cancelBtn.type = 'button';
  cancelBtn.hidden = true;
  const refreshBtn = h('button', 'btn btn-quiet');
  refreshBtn.type = 'button';
  refreshBtn.append(iconSvg('refresh', { size: null }), h('span', null, 'Reload'));
  const prog = h('div', 'disc-progress');
  const progBar = h('span', 'disc-progress-bar');
  const progText = h('span', 'disc-progress-text');
  prog.append(progBar, progText);
  prog.hidden = true;
  toolbar.append(scanBtn, cancelBtn, refreshBtn, prog);
  const body = h('div', 'drawer-body');
  el.append(head, toolbar, body);

  close.addEventListener('click', () => hide());
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
  refreshBtn.addEventListener('click', () => load());
  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    try {
      await api.discovery.scan({});
      scanning = true;
      progress = { phase: 'started', done: null, total: null, message: '' };
      toast?.('Scan started', { kind: 'info' });
    } catch (e) {
      toast?.(e?.status === 409 ? 'A scan is already running' : `Scan failed to start: ${e.message}`, { kind: 'error' });
      if (e?.status === 409) scanning = true;
    } finally {
      scanBtn.disabled = false;
      render();
    }
  });
  cancelBtn.addEventListener('click', async () => {
    try { await api.discovery.cancel(); toast?.('Scan cancelled'); } catch (e) { toast?.(`Could not cancel: ${e.message}`, { kind: 'error' }); }
  });

  /** Server status { running, progress, … } (GET /api/discovery, /api/state.discovery). */
  function applyStatus(st) {
    if (!st || typeof st !== 'object') return;
    scanning = !!st.running;
    if (scanning) progress = normalizeProgress(st.progress ?? {});
    else progress = null;
  }

  async function load() {
    try {
      const r = await api.discovery.get();
      // { status, result, full } from the HUD server; a bare DiscoveryResult is accepted too
      if (r && typeof r === 'object' && ('result' in r || 'status' in r)) {
        result = r.result && typeof r.result === 'object' ? r.result : null;
        applyStatus(r.status);
      } else result = r;
      loadError = null;
    } catch (e) {
      loadError = e?.status === 404 ? null : e.message;
      if (e?.status === 404) result = null;
    }
    render();
  }

  function hide() {
    if (el.hidden) return;
    el.hidden = true;
    onClose?.();
  }

  /** Machines on the plan, keyed the way discovery hits are looked up (planLookup). */
  function planIndex() {
    return buildPlanIndex(getLayout()?.machines);
  }

  function section(titleText, count, ...children) {
    const s = h('section', 'd-section');
    const t = h('h3', null, titleText);
    if (count !== null && count !== undefined) t.append(h('span', 'count', String(count)));
    s.append(t, ...children);
    return s;
  }

  function onPlanTag(name) {
    return name ? h('span', 'tag tag-linked', `On plan: ${name}`) : h('span', 'tag', 'Not on plan');
  }

  /**
   * "Link…" for a device that is not on the plan (none on TVs or in preview).
   * @param {{ name: string, info?: string, vendor?: string|null, model?: string|null, protocol?: string|null,
   *           kind?: string|null, source: object|null }} device
   */
  function linkButton(device) {
    if (!device?.source || getContext().kiosk || readOnly?.()) return null;
    const b = h('button', 'btn btn-small disc-link');
    b.type = 'button';
    b.title = 'Link this device to its machine on the plan';
    b.append(iconSvg('link', { size: null }), h('span', null, 'Link…'));
    b.addEventListener('click', () => startLink(device));
    return b;
  }

  async function startLink(device) {
    if (linking) return;
    const layout = getLayout();
    const layoutId = typeof layout?.id === 'string' ? layout.id : null;
    if (!layoutId) { toast?.('No layout is shown, so there is nothing to link to.', { kind: 'error' }); return; }
    linking = true;
    try {
      const machine = await pickMachine({ deviceName: device.name, deviceInfo: device.info, ranked: rankMachines(device, layout.machines) });
      if (!machine) return;
      await linkToMachine({ api, layoutId, machineId: machine.id, source: device.source });
      toast?.(`${machine.name || machine.id} is linked to ${device.name}. Its tile goes live in a few seconds.`, { kind: 'ok', timeoutMs: 8000 });
    } catch (e) {
      toast?.(e?.status === 401 ? 'Not linked: changing the plan needs the edit token.' : `Not linked: ${e?.message ?? e}`, { kind: 'error', timeoutMs: 10000 });
    } finally {
      linking = false;
      render();
    }
  }

  function render() {
    if (el.hidden) return;
    const ctx = getContext();
    const clockOpts = { clock24h: !!ctx.settings?.display?.clock24h, timeZone: ctx.settings?.display?.timeZone };
    scanBtn.hidden = ctx.kiosk;
    cancelBtn.hidden = !scanning || ctx.kiosk;
    prog.hidden = !scanning;
    if (scanning && progress) {
      const pct = finite(progress.total) && progress.total > 0 && finite(progress.done) ? Math.min(1, progress.done / progress.total) : null;
      progBar.style.width = pct === null ? '30%' : `${Math.round(pct * 100)}%`;
      prog.classList.toggle('indeterminate', pct === null);
      progText.textContent = pct === null ? `Scanning…${progress.message ? ` ${progress.message}` : ''}` : `${Math.round(pct * 100)}% · ${progress.done}/${progress.total} hosts${progress.message ? ` · ${progress.message}` : ''}`;
    }
    const parts = [];
    if (loadError) parts.push(h('p', 'error', `Could not load discovery results: ${loadError}`));
    const r = result && typeof result === 'object' ? result : null;
    const idx = planIndex();
    const liveFor = liveIndex(getUnassigned());

    // summary
    if (r) {
      const nets = arr(r.networks).map((n) => `${str(n.cidr)}${n.truncated ? ' (truncated)' : ''}`).filter(Boolean);
      const lines = [];
      const last = lastScanLine(r, ctx.now, clockOpts);
      if (last) lines.push(last);
      if (nets.length) lines.push(`Networks: ${nets.join(', ')}`);
      if (arr(r.ports).length) lines.push(`Ports: ${arr(r.ports).join(', ')}`);
      const box = h('div', 'disc-summary');
      for (const l of lines) box.append(h('p', null, l));
      for (const w of arr(r.warnings).slice(0, 5)) box.append(h('p', 'warn', typeof w === 'string' ? w : str(w?.message ?? JSON.stringify(w))));
      parts.push(box);
    } else if (!loadError) {
      parts.push(h('p', 'muted', 'No scan results yet. MTConnect has no discovery protocol, so the HUD scans the configured networks for agents and controls (one brief, read-only connection per host).'));
    }

    // MTConnect agents
    const agents = arr(r?.agents);
    if (agents.length) {
      const list = h('ul', 'disc-list');
      for (const a of agents) {
        const li = h('li', 'disc-agent');
        const top = h('div', 'disc-row');
        top.append(h('span', 'proto', 'MTConnect'), h('span', 'mono', str(a.baseUrl || `${str(a.host)}:${str(a.port)}`)));
        const meta = [a.sender, a.version ? `v${a.version}` : ''].filter(Boolean).join(' · ');
        if (meta) top.append(h('span', 'muted', meta));
        li.append(top);
        const devs = h('ul', 'disc-devices');
        for (const d of arr(a.devices)) {
          const dl = h('li', 'disc-device');
          const own = { protocol: 'mtconnect', agent: a.baseUrl || undefined, device: d.name, uuid: d.uuid };
          const onPlan = planLookup(idx, own);
          const dname = str(d.name) || str(d.uuid) || 'Device';
          dl.append(h('span', 'disc-name', dname));
          const info = [d.manufacturer, d.model, d.serialNumber ? `S/N ${d.serialNumber}` : '', d.inferredKind && d.inferredKind !== 'unknown' ? d.inferredKind : ''].filter(Boolean).join(' · ');
          if (info) dl.append(h('span', 'muted', info));
          dl.append(onPlanTag(onPlan));
          if (!onPlan) {
            const src = d.source && typeof d.source === 'object' ? { protocol: 'mtconnect', ...d.source } : a.baseUrl && d.name ? { protocol: 'mtconnect', agent: str(a.baseUrl), device: str(d.name) } : null;
            const live = liveFor(src);
            const btn = linkButton({ name: dname, info, vendor: d.manufacturer ?? a.vendor ?? null, model: d.model ?? null, protocol: 'mtconnect', kind: d.inferredKind ?? live?.kind ?? null, source: live?.binding?.source ?? src });
            if (btn) dl.append(btn);
          }
          devs.append(dl);
        }
        if (!arr(a.devices).length) devs.append(h('li', 'muted', 'No devices reported'));
        li.append(devs);
        list.append(li);
      }
      parts.push(section('MTConnect agents', agents.length, list));
    }

    // Other protocols (FOCAS, OPC UA, Haas MDC …): any array of fingerprint hits
    const hits = [...arr(r?.hits), ...arr(r?.endpoints), ...arr(r?.controls)].filter((x) => x && typeof x === 'object' && x.protocol && x.protocol !== 'mtconnect');
    if (hits.length) {
      const list = h('ul', 'disc-list');
      const hitSources = hits.map(hitSource);
      const names = deviceLabels(hits.map((x, i) => ({ name: str(x.name) || null, source: hitSources[i] })), '');
      hits.forEach((x, i) => {
        const li = h('li', 'disc-agent');
        const top = h('div', 'disc-row');
        const label = Object.prototype.hasOwnProperty.call(PROTOCOLS, x.protocol) ? PROTOCOLS[x.protocol].label : str(x.protocol);
        const where = x.endpoint ? str(x.endpoint) : hitSources[i]?.endpoint ? str(hitSources[i].endpoint) : `${str(x.host)}${x.port ? `:${x.port}` : ''}`;
        top.append(h('span', 'proto', label), h('span', 'mono', where));
        li.append(top);
        const name = names[i];
        const info = distinctParts([x.manufacturer || x.vendor, x.model, x.serial ? `S/N ${x.serial}` : '', x.version].map(str), name).join(' · ');
        const row = h('div', 'disc-device');
        if (name) row.append(h('span', 'disc-name', name));
        if (info || !name) row.append(h('span', 'muted', info || 'Control found'));
        const onPlan = planLookup(idx, hitSources[i]);
        row.append(onPlanTag(onPlan));
        if (!onPlan) {
          const live = liveFor(hitSources[i]);
          const btn = linkButton({ name: name || where, info, vendor: x.manufacturer || x.vendor || null, model: x.model ?? null, protocol: x.protocol, kind: live?.kind ?? null, source: live?.binding?.source ?? hitSources[i] });
          if (btn) row.append(btn);
        }
        li.append(row);
        list.append(li);
      });
      parts.push(section('Other controls', hits.length, list));
    }

    // SHDR adapters
    const adapters = arr(r?.adapters);
    if (adapters.length) {
      const list = h('ul', 'disc-list compact');
      for (const a of adapters) list.append(h('li', 'mono', `${str(a.host)}:${str(a.port)}${a.banner ? ` — ${str(a.banner).slice(0, 80)}` : ''}`));
      parts.push(section('SHDR adapters (raw, not polled)', adapters.length, list));
    }

    // Live devices not on the plan
    const un = arr(getUnassigned());
    if (un.length) {
      const list = h('ul', 'disc-list');
      const unNames = deviceLabels(un.map((s) => ({ name: str(s.name || s.id), source: s.binding?.source ?? null })));
      un.forEach((s, i) => {
        const li = h('li', 'disc-live');
        const pal = paletteFor(s.status, ctx.theme);
        const chip = h('span', 'status-chip');
        chip.style.setProperty('--fill', pal.fill ?? 'transparent');
        chip.style.setProperty('--ink', pal.ink);
        chip.append(iconSvg(pal.icon, { size: null }), h('span', null, pal.word));
        li.append(chip, h('span', 'disc-name', unNames[i]));
        const info = distinctParts([s.device?.manufacturer, s.device?.model, s.values?.programComment || s.values?.program, s.binding?.agent].map(str), unNames[i]).join(' · ');
        if (info) li.append(h('span', 'muted', info));
        const src = s.binding?.source;
        const btn = linkButton({
          name: unNames[i], info: distinctParts([s.device?.manufacturer, s.device?.model, s.binding?.address].map(str), unNames[i]).join(' · '),
          vendor: s.device?.manufacturer ?? src?.vendor ?? null, model: s.device?.model ?? null, protocol: src?.protocol ?? s.binding?.protocol ?? null,
          kind: s.kind ?? s.device?.inferredKind ?? null, source: src && typeof src === 'object' ? src : null,
        });
        if (btn) li.append(btn);
        list.append(li);
      });
      parts.push(section('Live devices not on the plan', un.length, list, h('p', 'hint', 'Press Link… and pick the machine on the plan. Not sure which is which? Press Feed Hold on a machine and watch which device turns amber.')));
    }

    // Errors
    const errors = arr(r?.errors);
    if (errors.length) {
      const det = h('details', 'disc-errors');
      det.append(h('summary', null, `${errors.length} host${errors.length === 1 ? '' : 's'} answered with errors`));
      const list = h('ul', 'disc-list compact');
      for (const e of errors.slice(0, 50)) list.append(h('li', 'mono', `${str(e.target)} — ${str(e.error)}`));
      det.append(list);
      parts.push(det);
    }
    body.replaceChildren(...parts);
  }

  return {
    async open() {
      el.hidden = false;
      render();
      await load();
      close.focus({ preventScroll: true });
    },
    close: hide,
    toggle() { if (el.hidden) this.open(); else hide(); },
    get isOpen() { return !el.hidden; },
    /**
     * SSE 'discovery' payloads: progress ({ phase, done, total, message }) or a finished result
     * ({ result } or a DiscoveryResult with `agents`).
     */
    onEvent(data) {
      if (!data || typeof data !== 'object') return;
      const phase = str(data.phase || data.state || data.status);
      const res = data.result && typeof data.result === 'object' ? data.result : Array.isArray(data.agents) && finite(data.finishedAt) ? data : null;
      if (/^cancel/i.test(phase)) {
        scanning = false;
        progress = null;
        if (res) result = res;
        toast?.('Scan cancelled');
      } else if (/^(error|fail)/i.test(phase)) {
        scanning = false;
        progress = null;
        toast?.(`Scan failed${data.message || data.error ? `: ${str(data.message || data.error)}` : ''}`, { kind: 'error' });
      } else if (res || /^(done|finish|complete)/i.test(phase)) {
        scanning = false;
        progress = null;
        if (res) result = res; else load();
      } else {
        scanning = true;
        progress = normalizeProgress(data.progress && typeof data.progress === 'object' ? { phase, ...data.progress } : data);
      }
      render();
    },
    /** Discovery status from GET /api/state (`discovery`). */
    onStatus(st) { applyStatus(st); render(); },
    refresh() { render(); },
  };
}
