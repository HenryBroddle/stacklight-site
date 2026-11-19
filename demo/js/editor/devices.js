// Devices panel (DECISIONS D5/D6): every device and endpoint the server knows on every protocol, with a live
// status chip, program comment, "changed 4 s ago", vendor/model/serial and protocol + address; recently changed
// first. Drag a device onto a machine tile (Pointer Events: mouse, pen and touch) or use "Link…" to bind it; the
// stored source carries the identity captured now (uuid, serialNumber). "Test connection" asks the server
// (POST /api/connectors/test). Linking a device that another machine already uses asks first.
import { PROTOCOLS, OPCUA_PROFILES, validateSource, endpointKey, describeSource, deviceLabels, distinctParts } from '/shared/sources.js';
import { paletteFor } from '../statusStyle.js';
import { iconSvg } from '../icons.js';
import { h, icon, ago } from './dom.js';
import { openDialog } from './dialogs.js';
import { findItem, machinesLinkedTo, sameDevice, setSource } from './ops.js';

const POLL_MS = 3000;
const PROTOCOL_SHORT = Object.freeze({ mtconnect: 'MTConnect', focas: 'FOCAS', 'haas-mdc': 'Haas MDC', opcua: 'OPC UA' });

/** Friendly text for the server's fixed error classes. */
export const ERROR_TEXT = Object.freeze({
  CONNECT_REFUSED: 'Nothing is listening at that address and port. Check the port number and that the machine’s data service is switched on.',
  TIMEOUT: 'No answer in time. Check the IP address, the network cable and that the machine is switched on.',
  UNREACHABLE: 'The HUD server cannot reach that address (different network or VLAN?).',
  DNS: 'The host name could not be found.',
  NOT_MTCONNECT: 'Something answered, but it is not a machine data service of this type (wrong port or protocol?).',
  ADDRESS_NOT_ALLOWED: 'The server’s address policy blocks this address (settings: security.allowedCidrs / allowLoopbackAgents).',
  TLS: 'The secure (TLS) connection failed.',
  PARSE: 'The answer could not be read.',
  PROTOCOL: 'The device answered with something unexpected.',
  TOO_LARGE: 'The answer was too large.',
  REDIRECT: 'The agent redirected to another address (not allowed).',
  CONNECTION_RESET: 'The device closed the connection.',
  AUTH: 'The login was rejected (check config/credentials.json).',
  UNSUPPORTED: 'This protocol is not available on this server.',
  BUSY: 'Another connection test is running — try again in a few seconds.',
  INVALID_SOURCE: 'The address is not complete or not valid.',
  ERROR: 'The connection failed.',
});

const errorText = (cls) => ERROR_TEXT[cls] ?? (String(cls || '').startsWith('HTTP_') ? `The agent answered with HTTP ${String(cls).slice(5)}.` : ERROR_TEXT.ERROR);

/** Status chip (status hue + icon + word, D2) for a device or snapshot status. */
export function statusChip(status, theme, { small = false } = {}) {
  const st = status || 'UNAVAILABLE';
  const p = paletteFor(st, theme);
  const chip = h('span', { className: `ed-chip-status${small ? ' small' : ''}${p.fill ? '' : ' hollow'}` });
  chip.style.setProperty('--fill', p.fill ?? 'transparent');
  chip.style.setProperty('--ink', p.ink);
  chip.style.setProperty('--border', p.borderColor ?? 'transparent');
  if (p.border === 'dashed') chip.classList.add('dashed');
  chip.append(iconSvg(p.icon, { size: null }), h('span', { text: p.word }));
  return chip;
}

/** One-line identity: "Haas · VF-2 · S/N 1002", without what the device's name already says. */
export function identityLine(d) {
  return distinctParts([d.manufacturer, d.model, d.serialNumber ? `S/N ${d.serialNumber}` : null], d.displayName ?? d.name ?? '').join(' · ');
}

/**
 * Give each device a `displayName` that no other device in the list shares (sources.js deviceLabels): two FOCAS
 * controls behind one host read "FANUC … · 127.0.0.1:18193" and "… :18194", not the same name twice.
 * @param {object[]} list  GET /api/devices devices (mutated)
 */
export function labelDevices(list) {
  const labels = deviceLabels(list.map((d) => ({ name: d.name ?? d.uuid ?? null, source: d.source ?? null })));
  list.forEach((d, i) => { d.displayName = labels[i]; });
  return list;
}

/**
 * @param {object} ed  editor core
 * @param {HTMLElement} container  tab panel
 */
export function createDevices(ed, container) {
  let devices = [];          // from GET /api/devices
  let loadedAt = 0;
  let error = null;
  let filter = 'all';
  let query = '';
  let pollTimer = null;
  let tickTimer = null;
  let refreshQueued = null;
  let scan = { running: false, text: '' };
  let visible = false;
  let destroyed = false;
  let dragging = false;     // a card is being dragged: keep the list still
  let pressing = false;     // a pointer is down in the list: do not touch it
  let hovering = false;     // the pointer is over the list: keep the order (cards must not jump away)
  let renderPending = false;
  let order = [];           // card keys in the order shown
  /** @type {Map<string, { li: HTMLLIElement, sig: string|null, d: object|null }>} */
  const cards = new Map();

  const search = h('input', { className: 'ed-input ed-search', type: 'search', placeholder: 'Search name, model, address, program…', attrs: { 'aria-label': 'Search devices' } });
  const chips = h('div', { className: 'ed-filter', attrs: { role: 'radiogroup', 'aria-label': 'Filter' } });
  const scanBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-small' }, icon('search'), h('span', { text: 'Scan network' }));
  const reloadBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-small ed-btn-quiet', title: 'Reload the list' }, icon('refresh'), h('span', { className: 'ed-sr', text: 'Reload' }));
  const scanStatus = h('div', { className: 'ed-scan-status', attrs: { role: 'status' } });
  const intro = h('p', { className: 'ed-panel-intro', text: 'Machines the HUD can see on the network. Drag one onto a machine on the plan to link it.' });
  const list = h('ul', { className: 'ed-devices', attrs: { 'aria-label': 'Devices' } });
  container.append(
    h('div', { className: 'ed-panel-head' }, intro, h('div', { className: 'ed-row' }, search, reloadBtn), h('div', { className: 'ed-row ed-row-between' }, chips, scanBtn), scanStatus),
    list,
  );

  for (const [id, label] of [['all', 'All'], ['unlinked', 'Not linked'], ['linked', 'Linked']]) {
    const b = h('button', { type: 'button', className: 'ed-chip', text: label, attrs: { role: 'radio', 'aria-checked': String(id === filter) } });
    b.dataset.filter = id;
    b.addEventListener('click', () => { filter = id; for (const c of chips.children) c.setAttribute('aria-checked', String(c.dataset.filter === filter)); render(); });
    chips.append(b);
  }
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  list.addEventListener('pointerenter', () => { hovering = true; });
  list.addEventListener('pointerleave', () => { hovering = false; if (!pressing && !dragging) render(); });
  list.addEventListener('pointerdown', () => { pressing = true; });
  const release = () => { if (!pressing) return; pressing = false; if (renderPending) setTimeout(render, 0); };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  reloadBtn.addEventListener('click', () => load());
  scanBtn.addEventListener('click', () => (scan.running ? cancelScan() : startScan()));

  async function load() {
    try {
      const r = await ed.api.fetchJson('/api/devices', { timeoutMs: 8000 });
      devices = labelDevices(Array.isArray(r?.devices) ? r.devices.filter((d) => d && typeof d === 'object') : []);
      error = null;
      loadedAt = Date.now();
    } catch (e) {
      error = e.message;
    }
    render();
    ed.emit('devices', devices);
  }

  /** Server endpoints that have no device yet (unreachable FOCAS/OPC UA/Haas/agents). */
  function endpointsWithoutDevices() {
    const agents = ed.ctx.getState?.().agents ?? [];
    const withDevices = new Set(devices.map((d) => d.endpointKey));
    return agents.filter((a) => a && typeof a.key === 'string' && !withDevices.has(a.key) && !(a.devices > 0));
  }

  const linkedIn = (src) => (src ? machinesLinkedTo(ed.doc, src, endpointKey) : []);

  function rows() {
    const out = devices.map((d) => ({ kind: 'device', d, linked: linkedIn(d.source) }));
    for (const a of endpointsWithoutDevices()) out.push({ kind: 'endpoint', a, linked: [] });
    const q = query;
    return out
      .filter((r) => {
        if (filter === 'linked' && !r.linked.length) return false;
        if (filter === 'unlinked' && r.linked.length) return false;
        if (!q) return true;
        const hay = r.kind === 'device'
          ? [r.d.displayName, r.d.name, r.d.manufacturer, r.d.model, r.d.serialNumber, r.d.address, r.d.protocol, r.d.program, r.d.programComment, r.d.uuid, ...r.linked.map((m) => m.name)]
          : [r.a.endpoint, r.a.address, r.a.protocol];
        return hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
      })
      .sort((x, y) => {
        if (x.kind !== y.kind) return x.kind === 'device' ? -1 : 1;
        if (x.kind === 'endpoint') return String(x.a.address).localeCompare(String(y.a.address));
        const sx = Number.isFinite(x.d.since) ? x.d.since : -Infinity, sy = Number.isFinite(y.d.since) ? y.d.since : -Infinity;
        return sy - sx || String(x.d.displayName).localeCompare(String(y.d.displayName));
      });
  }

  const cardKey = (r) => (r.kind === 'device' ? `d:${r.d.key ?? r.d.name}` : `e:${r.a.key}`);

  /**
   * Cards are updated in place: an element is only rebuilt when what it shows changed, the list is only re-ordered
   * when the pointer is not over it, and nothing changes while a pointer is pressed (clicks and drags stay put).
   */
  function render() {
    if (destroyed) return;
    if (dragging || pressing) { renderPending = true; return; }
    renderPending = false;
    const theme = ed.theme();
    let all = rows();
    const sel = ed.selectedMachine();
    if (hovering && order.length) {
      const idx = new Map(order.map((k, i) => [k, i]));
      all = [...all].sort((a, b) => (idx.get(cardKey(a)) ?? 1e9) - (idx.get(cardKey(b)) ?? 1e9));
    }
    const nodes = [];
    const keys = new Set();
    for (const r of all) {
      const key = cardKey(r);
      keys.add(key);
      const sig = JSON.stringify(r.kind === 'device'
        ? [r.d.status, r.d.since, r.d.displayName, r.d.manufacturer, r.d.model, r.d.serialNumber, r.d.address, r.d.protocol, r.d.program, r.d.programComment, r.linked.map((m) => [m.id, m.name]), theme, sel?.id ?? null, sel?.name ?? null]
        : [r.a.status, r.a.connection, r.a.error, r.a.endpoint, r.a.address, theme]);
      let c = cards.get(key);
      if (!c) {
        c = { li: h('li'), sig: null, d: null };
        cards.set(key, c);
        if (r.kind === 'device') makeDraggable(c.li, () => c.d);
      }
      c.d = r.kind === 'device' ? r.d : null;
      if (c.sig !== sig) {
        c.sig = sig;
        if (r.kind === 'device') fillDevice(c.li, r.d, r.linked, theme, sel); else fillEndpoint(c.li, r.a, theme);
      }
      nodes.push(c.li);
    }
    for (const k of [...cards.keys()]) if (!keys.has(k)) cards.delete(k);
    if (!nodes.length) {
      const empty = devices.length || endpointsWithoutDevices().length
        ? 'No devices match.'
        : error ? `Could not load devices: ${error}` : loadedAt ? 'The server has not found any devices yet. Add machine addresses in the settings (agents) or scan the network.' : 'Loading devices…';
      nodes.push(h('li', { className: 'ed-empty', text: empty }));
    }
    const same = nodes.length === list.children.length && nodes.every((n, i) => list.children[i] === n);
    if (!same) list.replaceChildren(...nodes);
    order = [...keys];
    const unlinked = devices.filter((d) => !linkedIn(d.source).length).length;
    ed.emit('devices-count', { total: devices.length, unlinked });
  }

  function fillDevice(li, d, linked, theme, selMachine) {
    li.className = `ed-device${linked.length ? ' is-linked' : ''}`;
    li.setAttribute('aria-label', `${d.displayName ?? 'Device'}${linked.length ? `, linked to ${linked.map((m) => m.name).join(', ')}` : ''}`);
    li.replaceChildren();
    li.dataset.key = d.key ?? '';
    const top = h('div', { className: 'ed-device-top' }, statusChip(d.status, theme, { small: true }), h('span', { className: 'ed-device-ago', text: Number.isFinite(d.since) ? `changed ${ago(d.since, ed.serverNow())}` : '' }));
    const name = h('div', { className: 'ed-device-name', text: d.displayName ?? d.name ?? d.uuid ?? 'Device' });
    const ident = identityLine(d);
    const meta = h('div', { className: 'ed-device-meta' }, h('span', { className: 'ed-proto', text: PROTOCOL_SHORT[d.protocol] ?? d.protocol ?? '?' }), h('span', { className: 'ed-mono', text: d.address ?? '' }));
    li.append(top, name);
    if (ident) li.append(h('div', { className: 'ed-device-ident', text: ident }));
    li.append(meta);
    const prog = d.programComment || d.program;
    if (prog) li.append(h('div', { className: 'ed-device-prog', text: d.programComment && d.program ? `${d.program} · ${d.programComment}` : prog }));
    const foot = h('div', { className: 'ed-device-foot' });
    if (linked.length) foot.append(h('span', { className: 'ed-linked-tag' }, icon('link'), h('span', { text: linked.map((m) => m.name).join(', ') })));
    else foot.append(h('span', { className: 'ed-drag-hint', text: 'Drag onto a machine' }));
    if (selMachine && !linked.some((m) => m.id === selMachine.id)) {
      const b = h('button', { type: 'button', className: `ed-btn ed-btn-small${linked.length ? ' ed-btn-quiet' : ' ed-btn-primary'}`, title: `Link this device to ${selMachine.name}${linked.length ? ` (it is linked to ${linked.map((m) => m.name).join(', ')})` : ''}` }, icon('link'), h('span', { text: `Link to ${truncate(selMachine.name, 18)}` }));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); linkDevice(selMachine.id, d); });
      foot.append(b);
    }
    li.append(foot);
  }

  function fillEndpoint(li, a, theme) {
    li.className = 'ed-device ed-endpoint';
    const status = a.connection === 'error' || a.status === 'error' ? 'OFFLINE' : 'UNAVAILABLE';
    li.replaceChildren(
      h('div', { className: 'ed-device-top' }, statusChip(status, theme, { small: true }), h('span', { className: 'ed-device-ago', text: a.status === 'connecting' ? 'connecting…' : '' })),
      h('div', { className: 'ed-device-name', text: a.endpoint ?? a.key }),
      h('div', { className: 'ed-device-meta' }, h('span', { className: 'ed-proto', text: PROTOCOL_SHORT[a.protocol] ?? a.protocol ?? '?' }), h('span', { className: 'ed-mono', text: a.address ?? '' })),
      h('div', { className: 'ed-device-ident', text: a.error ? errorText(a.error) : 'No device has answered at this address yet.' }),
    );
  }

  const truncate = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));

  // ---------------------------------------------------------------------------------------------
  // Drag a device card onto a machine tile
  // ---------------------------------------------------------------------------------------------
  function makeDraggable(li, getDevice) {
    li.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button')) return;
      const d = getDevice();
      if (!d) return;
      const start = [ev.clientX, ev.clientY];
      let ghost = null;
      let target = null;
      const pid = ev.pointerId;
      try { li.setPointerCapture(pid); } catch { /* ignore */ }
      const move = (e) => {
        if (e.pointerId !== pid) return;
        if (!ghost) {
          if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) < 6) return;
          ghost = h('div', { className: 'ed-drag-ghost' }, statusChip(d.status, ed.theme(), { small: true }), h('span', { text: d.displayName ?? d.name ?? 'Device' }));
          document.body.append(ghost);
          li.classList.add('is-dragging');
          dragging = true;
          ed.setDraggingDevice(true);
        }
        ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
        const m = ed.canvas.machineAt(e.clientX, e.clientY);
        const id = m?.id ?? null;
        if (id !== target) {
          target = id;
          ed.linkHover = id;
          ghost.classList.toggle('over', !!id);
          ghost.lastChild.textContent = id ? `Link ${d.displayName ?? d.name ?? 'device'} → ${m.name}` : d.displayName ?? d.name ?? 'Device';
          ed.invalidate('overlay');
        }
      };
      const up = (e) => {
        if (e.pointerId !== pid) return;
        li.removeEventListener('pointermove', move);
        li.removeEventListener('pointerup', up);
        li.removeEventListener('pointercancel', up);
        try { li.releasePointerCapture(pid); } catch { /* ignore */ }
        li.classList.remove('is-dragging');
        dragging = false;
        ed.setDraggingDevice(false);
        ghost?.remove();
        ed.linkHover = null;
        ed.invalidate('overlay');
        if (!ghost) return; // a click, not a drag
        if (renderPending) setTimeout(render, 0);
        if (e.type === 'pointerup' && target) linkDevice(target, d);
        else if (e.type === 'pointerup' && ed.canvas.isOverCanvas?.(e.clientX, e.clientY)) ed.toast('Drop the device onto a machine to link it', { kind: 'info' });
      };
      li.addEventListener('pointermove', move);
      li.addEventListener('pointerup', up);
      li.addEventListener('pointercancel', up);
    });
  }

  /**
   * Link a machine to a device (or a typed source). Warns when another machine already uses the device.
   * @returns {Promise<boolean>}
   */
  async function linkDevice(machineId, device, { source = null } = {}) {
    const f = findItem(ed.doc, machineId);
    if (!f || f.coll !== 'machines') return false;
    const src = source ?? device?.source;
    const v = validateSource(src);
    if (!v.source) { ed.toast(`Cannot link: ${v.errors[0]?.message ?? 'invalid address'}`, { kind: 'error' }); return false; }
    const others = machinesLinkedTo(ed.doc, v.source, endpointKey, machineId);
    let doc = ed.doc;
    if (others.length) {
      const names = others.map((m) => `“${m.name}”`).join(', ');
      const choice = await openDialog({
        title: 'Device already linked', icon: 'warning',
        body: [h('p', { text: `${device?.displayName ?? device?.name ?? describeSource(v.source)} is already linked to ${names}. Two tiles showing one machine would confuse the floor.` })],
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Link both', value: 'both' },
          { label: `Move the link to “${f.item.name}”`, value: 'move', primary: true },
        ],
      });
      if (!choice) return false;
      if (choice === 'move') for (const m of others) doc = setSource(doc, m.id, null);
    }
    doc = setSource(doc, machineId, v.source);
    ed.apply(doc, { label: `Link ${f.item.name}`, select: [machineId] });
    ed.toast(`${f.item.name} → ${device?.displayName ?? device?.name ?? describeSource(v.source)}`, { kind: 'ok' });
    render();
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Network scan (D8: token, cancellable; progress over SSE 'discovery')
  // ---------------------------------------------------------------------------------------------
  async function startScan() {
    scanBtn.disabled = true;
    try {
      await ed.api.discovery.scan({});
      scan = { running: true, text: 'Scanning the network…' };
    } catch (e) {
      if (e?.status === 409) scan = { running: true, text: 'A scan is already running…' };
      else ed.toast(`The scan did not start: ${e.message}`, { kind: 'error' });
    } finally {
      scanBtn.disabled = false;
      renderScan();
    }
  }
  async function cancelScan() {
    try { await ed.api.discovery.cancel(); } catch (e) { ed.toast(`Could not cancel: ${e.message}`, { kind: 'error' }); }
  }
  function renderScan() {
    scanBtn.replaceChildren(icon(scan.running ? 'close' : 'search'), h('span', { text: scan.running ? 'Cancel scan' : 'Scan network' }));
    scanStatus.textContent = scan.text;
    scanStatus.hidden = !scan.text;
  }
  function onDiscovery(data) {
    if (!data || typeof data !== 'object') return;
    const p = data.progress ?? {};
    if (data.phase === 'started') scan = { running: true, text: 'Scanning the network…' };
    else if (data.phase === 'progress') {
      const done = p.done ?? p.scanned ?? p.hostsScanned, total = p.total ?? p.hosts;
      scan = { running: true, text: Number.isFinite(done) && Number.isFinite(total) ? `Scanning… ${done} of ${total} addresses` : 'Scanning the network…' };
    } else if (['finished', 'cancelled', 'failed'].includes(data.phase)) {
      const found = Array.isArray(data.result?.agents) ? data.result.agents.length : null;
      scan = { running: false, text: data.phase === 'finished' ? `Scan finished${found !== null ? ` — ${found} agent${found === 1 ? '' : 's'} found` : ''}` : data.phase === 'cancelled' ? 'Scan cancelled' : 'Scan failed' };
      setTimeout(() => { if (!scan.running) { scan.text = ''; renderScan(); } }, 8000);
      queueRefresh(1500);
    }
    renderScan();
  }

  function queueRefresh(delay = 800) {
    if (refreshQueued) return;
    refreshQueued = setTimeout(() => { refreshQueued = null; if (visible) load(); }, delay);
  }

  const unsubscribe = ed.ctx.subscribe?.((name, data) => {
    if (name === 'discovery') onDiscovery(data);
    else if (name === 'machine' || name === 'unassigned' || name === 'agents') queueRefresh(1000);
  }) ?? (() => {});

  function setVisible(v) {
    visible = v;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    if (v) {
      load();
      pollTimer = setInterval(() => load(), POLL_MS);
      tickTimer = setInterval(() => {
        for (const li of list.querySelectorAll('.ed-device[data-key]')) {
          const d = devices.find((x) => x.key === li.dataset.key);
          const el = li.querySelector('.ed-device-ago');
          if (d && el && Number.isFinite(d.since)) el.textContent = `changed ${ago(d.since, ed.serverNow())}`;
        }
      }, 1000);
    }
  }

  renderScan();
  load();

  return {
    render,
    load,
    setVisible,
    linkDevice,
    /** Device whose source matches a machine source (live status for the Properties panel). */
    deviceFor(source) {
      return source ? devices.find((d) => d.source && sameDevice(d.source, source, endpointKey)) ?? null : null;
    },
    get devices() { return devices; },
    destroy() {
      destroyed = true;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      clearTimeout(refreshQueued);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      unsubscribe();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Link dialog: pick a discovered device or type an address; test the connection first
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} ed
 * @param {object} machine  layout machine
 * @param {ReturnType<typeof createDevices>} devicesPanel
 */
export async function openLinkDialog(ed, machine, devicesPanel) {
  const theme = ed.theme();
  const current = machine.source ?? null;
  const tabs = h('div', { className: 'ed-tabs ed-tabs-inline', attrs: { role: 'tablist' } });
  const pickPane = h('div', { className: 'ed-link-pane' });
  const manualPane = h('div', { className: 'ed-link-pane', hidden: true });
  let closeFn = null;

  const mkTab = (label, pane, other, selected) => {
    const t = h('button', { type: 'button', className: 'ed-tab', text: label, attrs: { role: 'tab', 'aria-selected': String(selected) } });
    t.addEventListener('click', () => {
      for (const x of tabs.children) x.setAttribute('aria-selected', String(x === t));
      pane.hidden = false;
      other.hidden = true;
    });
    return t;
  };
  tabs.append(mkTab('Discovered devices', pickPane, manualPane, true), mkTab('Enter an address', manualPane, pickPane, false));

  // --- discovered devices
  const pickList = h('ul', { className: 'ed-devices ed-devices-pick' });
  // devices nobody uses yet first, then recently changed first
  const linkedElsewhere = (d) => machinesLinkedTo(ed.doc, d.source, endpointKey, machine.id).length > 0;
  const devs = [...devicesPanel.devices].sort((a, b) => (linkedElsewhere(a) - linkedElsewhere(b)) || (b.since ?? 0) - (a.since ?? 0));
  for (const d of devs) {
    const others = machinesLinkedTo(ed.doc, d.source, endpointKey, machine.id);
    const isCurrent = current && sameDevice(current, d.source, endpointKey);
    const li = h('li', { className: `ed-device ed-device-pick${isCurrent ? ' is-current' : ''}` },
      h('div', { className: 'ed-device-top' }, statusChip(d.status, theme, { small: true }), h('span', { className: 'ed-device-ago', text: Number.isFinite(d.since) ? `changed ${ago(d.since, ed.serverNow())}` : '' })),
      h('div', { className: 'ed-device-name', text: d.displayName ?? d.name ?? 'Device' }),
      identityLine(d) ? h('div', { className: 'ed-device-ident', text: identityLine(d) }) : null,
      h('div', { className: 'ed-device-meta' }, h('span', { className: 'ed-proto', text: PROTOCOL_SHORT[d.protocol] ?? d.protocol }), h('span', { className: 'ed-mono', text: d.address ?? '' })),
      others.length ? h('div', { className: 'ed-warn-line' }, icon('warning'), h('span', { text: `Already linked to ${others.map((m) => m.name).join(', ')}` })) : null);
    const btn = h('button', { type: 'button', className: `ed-btn ed-btn-small ed-pick-action${isCurrent || others.length ? '' : ' ed-btn-primary'}`, disabled: !!isCurrent },
      isCurrent ? icon('check') : icon('link'), h('span', { text: isCurrent ? 'Linked' : others.length ? 'Link anyway' : 'Link' }));
    btn.addEventListener('click', async () => {
      closeFn?.(null);
      await devicesPanel.linkDevice(machine.id, d);
    });
    li.append(btn);
    pickList.append(li);
  }
  if (!devs.length) pickList.append(h('li', { className: 'ed-empty', text: 'No devices discovered yet. Use “Enter an address”, or scan the network from the Devices tab.' }));
  pickPane.append(pickList);

  // --- manual address
  const proto = h('select', { className: 'ed-input ed-select' }, ...Object.entries(PROTOCOLS).map(([k, p]) => h('option', { value: k, text: p.label })));
  proto.value = current?.protocol ?? 'mtconnect';
  const inputs = {
    agent: h('input', { className: 'ed-input ed-mono', type: 'text', placeholder: 'http://10.0.20.31:8082', spellcheck: false, value: current?.agent ?? '' }),
    device: h('input', { className: 'ed-input ed-mono', type: 'text', placeholder: 'VF2 (optional)', spellcheck: false, value: current?.device ?? '' }),
    host: h('input', { className: 'ed-input ed-mono', type: 'text', placeholder: '10.0.20.32', spellcheck: false, value: current?.host ?? '' }),
    port: h('input', { className: 'ed-input ed-mono', type: 'text', inputMode: 'numeric', placeholder: '8193', value: current?.port ?? '' }),
    path: h('input', { className: 'ed-input ed-mono', type: 'text', inputMode: 'numeric', placeholder: '1', value: current?.path ?? '' }),
    endpoint: h('input', { className: 'ed-input ed-mono', type: 'text', placeholder: 'opc.tcp://10.0.20.34:4840', spellcheck: false, value: current?.endpoint ?? '' }),
    profile: h('select', { className: 'ed-input ed-select' }, ...OPCUA_PROFILES.map((p) => h('option', { value: p, text: p }))),
    credentialsRef: h('input', { className: 'ed-input ed-mono', type: 'text', placeholder: 'key in config/credentials.json (optional)', spellcheck: false, value: current?.credentialsRef ?? '' }),
  };
  inputs.profile.value = current?.profile ?? 'auto';
  const field = (label, el, hint) => h('label', { className: 'ed-field ed-field-wide' }, h('span', { className: 'ed-field-label', text: label }), el, hint ? h('span', { className: 'ed-field-hint', text: hint }) : null);
  const rowsByProto = {
    mtconnect: [field('Agent URL', inputs.agent, 'Haas NGC: port 8082 · cppagent: 5000'), field('Device name', inputs.device, 'Needed when the agent serves several machines')],
    focas: [field('Host', inputs.host), field('Port', inputs.port, 'FANUC default 8193'), field('Path', inputs.path, '1 unless the control has several paths')],
    'haas-mdc': [field('Host', inputs.host), field('Port', inputs.port, 'Haas Setting 143, or the serial bridge port')],
    opcua: [field('Endpoint', inputs.endpoint), field('Profile', inputs.profile), field('Credentials key', inputs.credentialsRef, 'Passwords stay in config/credentials.json, never in the layout')],
  };
  const formRows = h('div', { className: 'ed-form' });
  const result = h('div', { className: 'ed-test-result', attrs: { role: 'status' } });
  let tested = null; // last successful test result for this exact source
  const showRows = () => { formRows.replaceChildren(...rowsByProto[proto.value]); tested = null; result.replaceChildren(); };
  proto.addEventListener('change', showRows);
  showRows();

  const readSource = () => {
    const p = proto.value;
    const num = (v) => (String(v).trim() === '' ? undefined : Number(v));
    let src;
    if (p === 'mtconnect') src = { protocol: p, agent: inputs.agent.value.trim() || undefined, device: inputs.device.value.trim() || undefined };
    else if (p === 'focas') src = { protocol: p, host: inputs.host.value.trim(), port: num(inputs.port.value), path: num(inputs.path.value) };
    else if (p === 'haas-mdc') src = { protocol: p, host: inputs.host.value.trim(), port: num(inputs.port.value) };
    else src = { protocol: p, endpoint: inputs.endpoint.value.trim(), profile: inputs.profile.value, credentialsRef: inputs.credentialsRef.value.trim() || undefined };
    for (const k of Object.keys(src)) if (src[k] === undefined) delete src[k];
    return validateSource(src);
  };

  const testBtn = h('button', { type: 'button', className: 'ed-btn' }, icon('plug'), h('span', { text: 'Test connection' }));
  const useBtn = h('button', { type: 'button', className: 'ed-btn ed-btn-primary' }, icon('link'), h('span', { text: 'Link this address' }));
  testBtn.addEventListener('click', async () => {
    const v = readSource();
    if (!v.source) { result.replaceChildren(resultLine(false, v.errors.map((e) => e.message).join(' · ') || 'Fill in the address first')); return; }
    testBtn.disabled = true;
    result.replaceChildren(h('p', { className: 'ed-muted', text: 'Connecting… (up to 10 s)' }));
    const r = await runTest(ed, v.source);
    testBtn.disabled = false;
    tested = r.ok ? r : null;
    result.replaceChildren(renderTest(r, theme));
  });
  useBtn.addEventListener('click', async () => {
    const v = readSource();
    if (!v.source) { result.replaceChildren(resultLine(false, v.errors.map((e) => e.message).join(' · ') || 'Fill in the address first')); return; }
    // keep the identity the test captured (D6) when it found exactly this device
    const src = tested?.device?.source && sameDevice(tested.device.source, v.source, endpointKey) ? { ...v.source, ...pickIdentity(tested.device.source) } : v.source;
    closeFn?.(null);
    await devicesPanel.linkDevice(machine.id, tested?.device ?? null, { source: src });
  });
  manualPane.append(field('Protocol', proto), formRows, h('div', { className: 'ed-row' }, testBtn, useBtn), result);

  await openDialog({
    title: `Link “${machine.name}” to a device`, icon: 'link', className: 'ed-dialog-wide ed-dialog-link',
    body: [current ? h('p', { className: 'ed-muted', text: `Currently: ${describeSource(current)}` }) : null, tabs, pickPane, manualPane],
    actions: [{ label: 'Close', value: null }],
    onOpen(_dlg, close) { closeFn = close; },
  });
}

const pickIdentity = (s) => Object.fromEntries(['uuid', 'serialNumber', 'vendor', 'device'].filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));

function resultLine(ok, text) {
  return h('p', { className: ok ? 'ed-test-ok' : 'ed-test-fail' }, icon(ok ? 'check' : 'warning'), h('span', { text }));
}

/** POST /api/connectors/test → result (never throws). */
export async function runTest(ed, source) {
  try {
    return await ed.api.connectors.test(source);
  } catch (e) {
    const cls = e?.code || (e?.status === 403 ? 'ADDRESS_NOT_ALLOWED' : e?.status === 429 ? 'BUSY' : 'ERROR');
    return { ok: false, errorClass: cls, message: e?.message };
  }
}

/** Render a test result: connected device, live status, identity check. */
export function renderTest(r, theme) {
  if (!r?.ok) return h('div', {}, resultLine(false, `Could not connect: ${errorText(r?.errorClass)}${r?.errorClass ? ` (${r.errorClass})` : ''}`));
  const out = h('div', {});
  const what = [r.agent?.sender, r.agent?.version ? `v${r.agent.version}` : null].filter(Boolean).join(' ');
  out.append(resultLine(true, `Connected${Number.isFinite(r.latencyMs) ? ` in ${r.latencyMs} ms` : ''}${what ? ` — ${what}` : ''}${r.reused ? ' (already being monitored)' : ''}`));
  if (r.device) {
    out.append(h('div', { className: 'ed-test-device' },
      r.snapshot ? statusChip(r.snapshot.status, theme, { small: true }) : null,
      h('strong', { text: r.device.name ?? 'Device' }),
      identityLine(r.device) ? h('span', { className: 'ed-muted', text: identityLine(r.device) }) : null));
  } else if (Array.isArray(r.devices) && r.devices.length > 1) {
    out.append(h('p', { className: 'ed-muted', text: `This agent serves ${r.devices.length} machines: ${r.devices.map((d) => d.name).join(', ')}. Enter the device name.` }));
  }
  if (r.identityMismatch) out.append(resultLine(false, 'A different machine answers at this address than the one linked before (uuid/serial changed).'));
  if (r.warning) out.append(h('p', { className: 'ed-muted', text: `Note: ${errorText(r.warning)}` }));
  return out;
}
