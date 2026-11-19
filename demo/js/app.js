// HUD bootstrap and composition root: loads state + layout, applies the screen profile, wires the floor plan,
// board, top bar, detail drawer, discovery panel, stale watchdog and SSE, and routes between view and edit mode.
// Edit mode lazy-loads ./editor/index.js and calls its mountEditor(ctx) (or createEditor/startEditor/default).
//
// Views: /?screen=<name> (kiosk implied) and /?layout=<id> are passed to /api/state and /api/events, so the
// server resolves which layout this display shows and streams that layout's machines.
import * as api from './api.js';
import { createFloorplan, resetTextMetrics } from './floorplan.js';
import { createBoard } from './board.js';
import { createTopBar, createBanner, toast, promptForToken } from './hud.js';
import { createDetail } from './detail.js';
import { createDiscoveryPanel } from './discoveryPanel.js';
import { createRunsPanel } from './runsPanel.js';
import { createProgramsPanel } from './programsPanel.js';
import { createWatchdog } from './watchdog.js';
import { createErrorReporter } from './errorReport.js';
import { readUrlOptions, resolveScreen, computeTypeScale, applyProfile, effectiveMotion, createChime } from './screen.js';
import { machineView, machineFacts, createDisplayDebounce, formatTimeOfDay } from './statusStyle.js';
import { summarizeRuns } from '/shared/runs.js';
import { formatDuration } from '/shared/format.js';
import { endpointKey } from '/shared/sources.js';

const THEME_KEY = 'machine-shop-hud.theme';
const $ = (id) => document.getElementById(id);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const url = readUrlOptions(location.search);
// The public demo (stacklight.shop/demo, built by scripts/demo-site.mjs) marks its page <html data-demo="1">: a
// simulated shop replayed in the browser, so nothing can be edited, discovered or changed there.
const DEMO = document.documentElement.dataset.demo === '1';
// Script errors, rejected promises, disconnects and reloads go to the server log (D13); first thing, to catch boot errors.
const reporter = createErrorReporter({
  screen: () => { try { return state.profile?.name ?? url.screen ?? null; } catch { return url.screen ?? null; } },
});
const els = {
  root: document.documentElement,
  topbar: $('topbar'), banner: $('banner'), main: $('main'), plan: $('plan'), svg: $('floorplan'),
  planMessage: $('plan-message'), head: $('board-head'), rows: $('board-rows'), editorHost: $('editor-host'),
  detail: $('detail'), discovery: $('discovery'), runs: $('runs'), programs: $('programs'),
};

/** Mutable app state (single composition root — no other module holds global state). */
const state = {
  view: { layout: url.layout ?? undefined, screen: url.screen ?? undefined }, // query for /api/state + /api/events
  settings: {},
  activeLayout: null,      // the server's active layout
  dataLayoutId: null,      // layout the machine snapshots belong to (server-resolved for this view)
  live: true,              // the server monitors dataLayoutId
  shownLayoutId: null,     // layout displayed here
  layout: null,            // raw layout object displayed
  machines: new Map(),     // id → snapshot (dataLayoutId)
  unassigned: [],
  agents: [],
  profile: null,
  scale: null,
  theme: 'dark',
  stale: false,
  staleAsOf: 0,
  editing: false,
  compact: false,          // phone-sized layout (class "stacked"): machine cards with secondary facts
  booted: false,
  lastSettingsJson: '',
  prevDisplayed: new Map(), // id → status last displayed (onsets, feed)
};

let events = null;
let floorplan = null;
let board = null;
let topbar = null;
let banner = null;
let detail = null;
let discovery = null;
let runsPanel = null;
let programsPanel = null;
let watchdog = null;
let chime = null;
let editor = null;
const debounce = createDisplayDebounce();
const editorListeners = new Set();

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/** Server-clock now; frozen at the last message while the display is stale. */
function serverNow() {
  if (state.stale && finite(state.staleAsOf) && state.staleAsOf > 0) return state.staleAsOf + (events?.serverOffsetMs ?? 0);
  return Date.now() + (events?.serverOffsetMs ?? 0);
}
const display = () => (isObj(state.settings.display) ? state.settings.display : {});
const clockOpts = () => ({ clock24h: !!display().clock24h, timeZone: typeof display().timeZone === 'string' ? display().timeZone : undefined });

// ---------------------------------------------------------------------------------------------
// Profile, theme and geometry
// ---------------------------------------------------------------------------------------------

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function applyScreen() {
  const profile = resolveScreen(url, state.settings);
  if (!profile.kiosk && !url.theme) {
    const t = storedTheme();
    if (t === 'dark' || t === 'light') profile.theme = t;
  }
  state.profile = profile;
  const viewport = { width: window.innerWidth, height: window.innerHeight, screenWidth: window.screen?.width ?? 0 };
  state.scale = computeTypeScale(profile, viewport);
  state.theme = applyProfile(profile, state.scale);
  topbar?.setTheme(state.theme);
  topbar?.setEditable(canEdit());
  if (floorplan) {
    floorplan.setOptions({
      theme: state.theme, settings: state.settings, kiosk: profile.kiosk, scale: state.scale, showGrid: profile.showGrid,
      rotation: state.editing ? 0 : profile.rotate, region: state.editing ? null : profile.region, motion: effectiveMotion(profile),
    });
  }
  if (profile.sound && !chime) chime = createChime();
  topbar?.setSound(profile.sound ? (chime?.blocked ? 'blocked' : 'on') : null);
  watchdog?.setReloadAt(typeof display().reloadAt === 'string' ? display().reloadAt : null);
  layoutGeometry();
}

/** Size the sidebar so the plan keeps its aspect ratio (whatever the plan's proportions, D4). */
function layoutGeometry() {
  if (!state.scale) return;
  const k = state.scale.k;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // narrow portrait screens and phones on their side scroll one column: summary, plan, then machine cards
  const stacked = !state.profile?.kiosk && ((vw < 900 && vw < vh * 1.15) || (vh < 500 && vw < 1100));
  els.root.classList.toggle('stacked', stacked);
  if (stacked !== state.compact) {
    state.compact = stacked;
    floorplan?.setOptions({ compact: stacked });
    if (stacked) refreshTodayRuns();
    queueRender();
  }
  if (stacked) { els.root.style.removeProperty('--board-w'); return; }
  const safe = (state.profile.safeMarginPct / 100) * Math.min(vw, vh);
  const topH = els.topbar.getBoundingClientRect().height || 96 * k;
  const gap = 16 * k;
  const planH = vh - 2 * safe - topH - 2 * gap;
  const vb = floorplan?.getViewBox() ?? { w: 88, h: 68 };
  const aspect = vb.w > 0 && vb.h > 0 ? vb.w / vb.h : 1.3;
  const planW = planH * aspect;
  const avail = vw - 2 * safe - 3 * gap;
  const min = Math.min(avail * 0.5, 470 * k);
  const max = avail * 0.46;
  const w = Math.max(min, Math.min(max, avail - planW));
  els.root.style.setProperty('--board-w', `${Math.round(w)}px`);
}

/** A read-only look at another layout (?layout=<id> that is not the active one). */
function isPreview() {
  return !!(url.layout && state.activeLayout && url.layout !== state.activeLayout);
}
function canEdit() {
  return !DEMO && !!state.profile && !state.profile.kiosk && !isPreview() && !smallScreen();
}
/** Read-only views: a preview of another layout, or the public demo. */
function readOnlyView() {
  return DEMO || isPreview();
}
/** A phone (either way round): no layout editing there — the editor needs room and a pointer. */
function smallScreen() {
  return Math.min(window.innerWidth, window.innerHeight) < 600;
}
/** Layout this display should show. */
function wantedLayout() {
  return url.layout ?? state.profile?.layoutId ?? state.dataLayoutId ?? state.activeLayout ?? (typeof state.settings.activeLayout === 'string' ? state.settings.activeLayout : null);
}

// ---------------------------------------------------------------------------------------------
// Snapshots → layout machines
// ---------------------------------------------------------------------------------------------

function sourceMatches(source, snap) {
  const b = snap?.binding;
  if (!source || !b) return false;
  const proto = source.protocol || 'mtconnect';
  if (proto === 'mtconnect') {
    if (source.agent && b.agent && source.agent.replace(/\/+$/, '') !== String(b.agent).replace(/\/+$/, '')) return false;
    if (!source.device) return !!(source.agent && b.agent);
    return [b.device, b.deviceName, b.deviceUuid].includes(source.device);
  }
  const key = endpointKey(source);
  return !!key && (b.key === key || b.endpointKey === key);
}

/** Snapshot per machine id of the displayed layout. */
function snapshotsForLayout() {
  const out = new Map();
  const machines = Array.isArray(state.layout?.machines) ? state.layout.machines : [];
  if (state.dataLayoutId === state.shownLayoutId && state.live && !state.editing) {
    for (const m of machines) if (m && state.machines.has(m.id)) out.set(m.id, state.machines.get(m.id));
    return out;
  }
  // A layout the server does not monitor, or one being edited (its links may not be saved yet): match by binding
  // against everything the server does see.
  const all = [...state.machines.values(), ...state.unassigned];
  for (const m of machines) {
    if (!m?.source) continue;
    const snap = all.find((s) => sourceMatches(m.source, s));
    out.set(m.id, snap ? { ...snap, id: m.id, name: m.name } : {
      id: m.id, name: m.name, kind: m.kind, status: 'UNAVAILABLE', reason: state.editing ? 'Not connected yet — save to start monitoring' : 'Not monitored — this layout is not active',
      connection: 'connected', since: null, stoppedSince: null, conditions: [], values: {}, badge: null, service: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering loop (1 Hz + on every message)
// ---------------------------------------------------------------------------------------------

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  if (!state.booted || !state.layout) return;
  const now = serverNow();
  const minStateMs = Math.max(0, Number(display().minStateSeconds ?? 5)) * 1000;
  const raw = snapshotsForLayout();
  const shown = new Map();
  for (const [id, snap] of raw) shown.set(id, state.stale ? snap : debounce.apply(id, snap, now, minStateMs).snap);
  const offset = events?.serverOffsetMs ?? 0;
  floorplan.updateMachines(shown, offset, () => (state.stale ? now - offset : Date.now()));

  const machines = Array.isArray(state.layout.machines) ? state.layout.machines : [];
  const ctx = { settings: state.settings, now, theme: state.theme };
  let vms = machines.filter((m) => m && typeof m.id === 'string').map((m) => machineView(shown.get(m.id) ?? null, m, ctx));
  if (state.stale) vms = vms.map(withoutAttention); // data may be out of date: no rings, no overdue pills
  if (state.compact) vms = vms.map((vm) => ({ ...vm, facts: machineFacts(shown.get(vm.id) ?? null, state.settings), today: todayText(vm.id) }));
  board.update(vms, { kiosk: state.profile.kiosk, theme: state.theme, ...clockOpts(), stale: state.stale, asOf: now, compact: state.compact });
  topbar.setClock(now, clockOpts());
  detail?.refresh();
  noteTransitions(vms, now);
}

// ---------------------------------------------------------------------------------------------
// Today's runs per machine (phone cards; DECISIONS D12)
// ---------------------------------------------------------------------------------------------

const today = { runs: new Map(), from: 0, at: 0, loading: false, summary: new Map() };

function localMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Load today's runs (phone cards only; at most once a minute, and again when the day changes). */
async function refreshTodayRuns(force = false) {
  if (!state.compact || today.loading || !runsEnabled()) return;
  const from = localMidnight(serverNow());
  if (!force && from === today.from && Date.now() - today.at < 60_000) return;
  today.loading = true;
  try {
    const r = await api.runs.list({ from });
    today.runs = new Map((Array.isArray(r?.runs) ? r.runs : []).filter(isObj).map((run) => [run.id, run]));
    today.from = from;
    today.at = Date.now();
    summarizeToday();
  } catch { /* the cards just show no run line */ } finally {
    today.loading = false;
  }
}
function runsEnabled() {
  return isObj(state.settings.runs) && state.settings.runs.enabled !== false;
}
function summarizeToday() {
  const byMachine = new Map();
  for (const run of today.runs.values()) {
    if (!byMachine.has(run.machineId)) byMachine.set(run.machineId, []);
    byMachine.get(run.machineId).push(run);
  }
  today.summary = new Map([...byMachine].map(([id, list]) => [id, summarizeRuns(list, { now: serverNow() }).total]));
  queueRender();
}
/** "Today 23 runs · 22 pcs · avg 11m 59s" for a machine's card, or '' before the first run. */
function todayText(id) {
  const t = today.summary.get(id);
  if (!t || !(t.runs || t.invalid)) return runsEnabled() && today.at ? 'Today: no runs yet' : '';
  return [`Today ${t.runs} run${t.runs === 1 ? '' : 's'}`, t.parts || !t.uncounted ? `${t.parts.toLocaleString('en-US')} pcs` : '',
    t.avgCycleMs !== null ? `avg ${formatDuration(t.avgCycleMs)}` : ''].filter(Boolean).join(' · ');
}
/** SSE 'runs': keep the phone cards' totals current. */
function noteRun(run) {
  if (!state.compact || !isObj(run) || typeof run.id !== 'string' || !today.at) return;
  if ((run.end ?? serverNow()) < today.from) return;
  today.runs.set(run.id, run);
  summarizeToday();
}

/** A view model with its attention cues removed (stale display). */
function withoutAttention(vm) {
  return { ...vm, attention: { ...vm.attention, level: 0 }, timer: vm.timer ? { ...vm.timer, overdue: false } : null };
}

function noteTransitions(vms, now) {
  for (const vm of vms) {
    const prev = state.prevDisplayed.get(vm.id);
    state.prevDisplayed.set(vm.id, vm.status);
    if (prev === undefined || prev === vm.status || state.stale) continue;
    // the feed is in the order this screen saw the changes, so it is timed by that too: `since` can be dated back
    // (an OFFLINE change starts at the last exchange, DECISIONS O5) and would put the list out of time order
    if (!state.profile.kiosk) board.addEvent({ t: now, name: vm.name, status: vm.status, word: vm.word });
    const onset = (vm.status === 'ESTOP' || vm.status === 'ALARM') && prev !== 'ESTOP' && prev !== 'ALARM';
    if (onset && chime && state.profile.sound && vm.inShift && (vm.sinceAge ?? Infinity) < 60_000) {
      chime.play(vm.id);
      topbar.setSound(chime.blocked ? 'blocked' : 'on');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** Full state from GET /api/state or an SSE 'snapshot'. */
function applyState(s) {
  if (!isObj(s)) return;
  if (isObj(s.settings)) {
    let settings = s.settings;
    // the server also sends the resolved screen profile; make sure resolveScreen() can find it
    if (isObj(s.screen) && typeof s.screen.name === 'string' && !isObj(settings.screens?.[s.screen.name])) {
      settings = { ...settings, screens: { ...(isObj(settings.screens) ? settings.screens : {}), [s.screen.name]: s.screen } };
    }
    applySettings(settings);
  }
  if (typeof s.activeLayout === 'string') state.activeLayout = s.activeLayout;
  else if (typeof s.layoutId === 'string' && !url.layout && !url.screen) state.activeLayout = s.layoutId;
  if (typeof s.layoutId === 'string') state.dataLayoutId = s.layoutId;
  state.live = s.live !== false;
  if (Array.isArray(s.machines)) state.machines = new Map(s.machines.filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]));
  if (Array.isArray(s.unassigned)) state.unassigned = s.unassigned.filter(isObj);
  if (Array.isArray(s.agents)) state.agents = s.agents;
  if (isObj(s.tokenHelp)) state.tokenHelp = s.tokenHelp;
  if (typeof s.localEdit === 'boolean') state.localEdit = s.localEdit; // only GET /api/state carries it (D9 amendment)
  watchdog?.noteIdentity(s);
  if (isObj(s.discovery)) discovery?.onStatus(s.discovery);
  const want = wantedLayout();
  if (state.booted && want && want !== state.shownLayoutId && !state.editing) loadLayout(want);
  topbar?.setEditable(canEdit());
  queueRender();
}

function applySettings(settings) {
  const json = JSON.stringify(settings);
  if (json === state.lastSettingsJson) return;
  state.lastSettingsJson = json;
  state.settings = settings;
  topbar?.setBranding(settings);
  topbar?.setRunsAvailable(isObj(settings.runs) && settings.runs.enabled !== false);
  if (!state.booted) return;
  applyScreen();
  updateSubtitle();
}

let layoutLoading = null;
async function loadLayout(id) {
  if (layoutLoading === id) return;
  layoutLoading = id;
  try {
    const layout = await api.layouts.get(id);
    if (!isObj(layout)) throw new Error('empty layout');
    if (!state.editing) setDisplayedLayout(id, layout);
  } catch (e) {
    const fallback = state.activeLayout ?? state.dataLayoutId;
    if (fallback && id !== fallback) {
      if (!state.profile?.kiosk) toast(`Layout "${id}" could not be loaded (${e.message}); showing "${fallback}"`, { kind: 'error' });
      layoutLoading = null;
      if (state.shownLayoutId !== fallback) await loadLayout(fallback);
    } else if (!state.layout) {
      showPlanMessage(`Could not load the layout "${id}": ${e.message}`);
    }
  } finally {
    if (layoutLoading === id) layoutLoading = null;
  }
}

function setDisplayedLayout(id, layout) {
  state.shownLayoutId = id;
  state.layout = layout;
  debounce.clear();
  hidePlanMessage();
  if (!state.editing) floorplan.setLayout(layout, { refit: true });
  updateSubtitle();
  topbar.setEditable(canEdit());
  layoutGeometry();
  queueRender();
}

function updateSubtitle() {
  if (!topbar) return;
  const b = isObj(state.settings.branding) ? state.settings.branding : {};
  const sub = typeof b.subtitle === 'string' ? b.subtitle : 'Shop Floor';
  const name = typeof state.layout?.name === 'string' ? state.layout.name : '';
  topbar.setLayoutInfo({ name, preview: isPreview(), subtitleText: name && !state.profile?.kiosk ? `${sub} · ${name}` : sub });
}

function showPlanMessage(text) {
  els.planMessage.textContent = text;
  els.planMessage.hidden = false;
}
function hidePlanMessage() {
  els.planMessage.hidden = true;
}

function machinePayload(data) {
  if (!isObj(data)) return [];
  if (Array.isArray(data.machines)) return data.machines;
  if (isObj(data.machine)) return [data.machine];
  if (isObj(data.snapshot)) return [data.snapshot];
  if (typeof data.id === 'string' && typeof data.status === 'string') return [data];
  return [];
}

/** Follows the server's active layout (no ?layout= and no screen profile layout). */
const followsActive = () => !url.layout && !state.profile?.layoutId;

function connect() {
  const fwd = (name, data) => { for (const fn of editorListeners) { try { fn(name, data); } catch (e) { console.error(e); } } };
  events = api.connectEvents({
    open() { topbar.setLive(state.stale ? 'stale' : 'live'); },
    error() { if (!state.stale) topbar.setLive('connecting', 'Reconnecting to the HUD server…'); },
    any(name, data) {
      fwd(name, data);
      if (!state.stale && name !== 'shutdown') topbar.setLive('live');
    },
    snapshot(data) { applyState(data); },
    machine(data) {
      // machine events are broadcast for every live layout (active + screens): keep only ours
      if (isObj(data) && typeof data.layoutId === 'string' && state.dataLayoutId && data.layoutId !== state.dataLayoutId) return;
      for (const snap of machinePayload(data)) {
        if (!isObj(snap) || typeof snap.id !== 'string') continue;
        if (snap.id.startsWith('device:') || data?.unassigned === true) {
          const i = state.unassigned.findIndex((u) => u.id === snap.id);
          if (i >= 0) state.unassigned[i] = snap; else state.unassigned.push(snap);
        } else state.machines.set(snap.id, snap);
      }
      queueRender();
    },
    machines(data) { this.machine(data); },
    unassigned(data) {
      const list = Array.isArray(data) ? data : Array.isArray(data?.unassigned) ? data.unassigned : Array.isArray(data?.devices) ? data.devices : null;
      if (list) state.unassigned = list.filter(isObj);
      discovery?.refresh();
      queueRender();
    },
    agents(data) {
      const list = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : null;
      if (list) state.agents = list;
    },
    layout(data) {
      if (!isObj(data)) return;
      const id = typeof data.id === 'string' ? data.id : null;
      if (data.reason === 'invalid' || (Array.isArray(data.errors) && data.errors.length)) {
        if (!state.profile.kiosk && id === state.shownLayoutId) toast(`Layout "${id}" has errors on disk; still showing the last good version`, { kind: 'error' });
        return;
      }
      if (data.reason === 'activated' && id) {
        state.activeLayout = id;
        // the SSE view was resolved at connect time: reconnect for a snapshot of the new active layout
        if (followsActive() && !state.editing) events.reconnect();
        updateSubtitle();
        topbar.setEditable(canEdit());
        return;
      }
      if (typeof data.activeLayout === 'string') state.activeLayout = data.activeLayout;
      if (id && id === state.shownLayoutId && !state.editing && data.reason !== 'deleted') loadLayout(id);
    },
    discovery(data) { discovery?.onEvent(data); },
    runs(data) { runsPanel?.onEvent(data); detail?.onRunEvent?.(data); noteRun(data?.run); },
    settings(data) { if (isObj(data?.settings)) { applySettings(data.settings); programsPanel?.onSettings(); } },
    ping(data) { watchdog?.noteIdentity(data); },
    hello(data) { watchdog?.noteIdentity(data); },
    shutdown() { if (!state.stale) topbar.setLive('connecting', 'The HUD server is restarting…'); },
  }, { url: `/api/events${api.viewQuery(state.view)}` });
}

// ---------------------------------------------------------------------------------------------
// Edit mode (editor module owned by the editor engineer: public/js/editor/index.js)
// ---------------------------------------------------------------------------------------------

async function enterEditMode() {
  if (state.editing) return;
  if (!canEdit()) {
    if (smallScreen() && state.profile && !state.profile.kiosk) toast('Layout editing needs a larger screen — use a PC or a tablet', { kind: 'info' });
    return;
  }
  let mod;
  try {
    mod = await import('./editor/index.js');
  } catch (e) {
    console.error(e);
    toast('The layout editor is not available in this build', { kind: 'error' });
    return;
  }
  const start = mod.mountEditor ?? mod.createEditor ?? mod.startEditor ?? mod.default;
  if (typeof start !== 'function') { toast('The layout editor failed to load', { kind: 'error' }); return; }
  detail.close();
  discovery.close();
  runsPanel?.close();
  programsPanel?.close();
  state.editing = true;
  els.root.classList.add('editing');
  els.editorHost.hidden = false;
  floorplan.setOptions({ rotation: 0, region: null });
  floorplan.setMode('edit');
  try {
    editor = await start(editorContext());
  } catch (e) {
    console.error(e);
    toast(`The layout editor failed to start: ${e.message}`, { kind: 'error' });
    exitEditMode();
  }
}

async function exitEditMode({ layout } = {}) {
  if (!state.editing) return;
  try { await editor?.destroy?.(); } catch (e) { console.error(e); }
  editor = null;
  state.editing = false;
  els.root.classList.remove('editing');
  els.editorHost.replaceChildren();
  els.editorHost.hidden = true;
  floorplan.setMode('view');
  floorplan.setOptions({ rotation: state.profile.rotate, region: state.profile.region });
  if (isObj(layout)) setDisplayedLayout(typeof layout.id === 'string' ? layout.id : state.shownLayoutId, layout);
  else await loadLayout(state.shownLayoutId ?? wantedLayout());
  // a layout made live while editing: the SSE view was resolved for the previous one, so follow the new one
  if (followsActive() && state.activeLayout && state.activeLayout !== state.dataLayoutId) events?.reconnect();
  if (url.edit) {
    const p = new URLSearchParams(location.search);
    p.delete('edit');
    history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}${location.hash}`);
  }
}

function editorContext() {
  return {
    floorplan,
    api,
    svg: els.svg,
    host: els.editorHost,
    planHost: els.plan,
    layoutId: state.shownLayoutId,
    layout: structuredClone(state.layout),
    getState: () => ({
      settings: state.settings, activeLayout: state.activeLayout, layoutId: state.dataLayoutId, machines: [...state.machines.values()],
      unassigned: [...state.unassigned], agents: [...state.agents], serverOffsetMs: events?.serverOffsetMs ?? 0,
    }),
    getSnapshots: () => new Map(state.machines),
    serverNow,
    /** fn(eventName, data) for every SSE event; returns an unsubscribe function. */
    subscribe(fn) { editorListeners.add(fn); return () => editorListeners.delete(fn); },
    /** Keep live tiles mapped while editing (call with the edited layout after each change). */
    setLayout(layout) { if (isObj(layout)) { state.layout = layout; queueRender(); } },
    requestToken: (reason) => tokenProvider({ status: 0, path: '', message: reason }),
    toast,
    exit: (opts) => exitEditMode(opts),
  };
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function tokenProvider(info) {
  const r = await promptForToken({ reason: info?.message && info.status !== 401 ? info.message : undefined, help: state.tokenHelp });
  if (!r) return null;
  api.setEditToken(r.token, { remember: r.remember });
  return r.token;
}

function toggleTheme() {
  const next = state.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* per-viewer convenience only */ }
  applyScreen();
  queueRender();
}

async function fetchInitialState() {
  let delay = 2000;
  for (;;) {
    const t0 = performance.now();
    try {
      const s = await api.getState(state.view);
      return { s, rtt: performance.now() - t0 };
    } catch (e) {
      if (e?.status === 404 && e.code === 'UNKNOWN_SCREEN' && state.view.screen) {
        toast(`Unknown screen profile "${state.view.screen}" — showing the default view`, { kind: 'error', timeoutMs: 10000 });
        state.view = { layout: state.view.layout };
        continue;
      }
      if (e?.status === 404 && state.view.layout) {
        toast(`Layout "${state.view.layout}" not found — showing the active layout`, { kind: 'error', timeoutMs: 10000 });
        state.view = { screen: state.view.screen };
        continue;
      }
      showPlanMessage(`Connecting to the HUD server… (${e.message})`);
      topbar.setLive('connecting', e.message);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(15000, delay * 1.5);
    }
  }
}

async function boot() {
  api.setTokenProvider(tokenProvider);
  topbar = createTopBar(els.topbar, {
    onDiscovery: () => { detail.close(); runsPanel?.close(); programsPanel?.close(); discovery.toggle(); },
    onRuns: () => { detail.close(); discovery.close(); programsPanel?.close(); runsPanel?.toggle(); },
    onEdit: () => enterEditMode(),
    onTheme: toggleTheme,
    onSound: async () => { if (chime) { await chime.unlock(); topbar.setSound(chime.blocked ? 'blocked' : 'on'); } },
  });
  banner = createBanner(els.banner);
  topbar.setDiscoveryAvailable(!DEMO);
  topbar.setLive('connecting');
  // provisional profile so the boot screen is styled
  state.profile = resolveScreen(url, {});
  state.scale = computeTypeScale(state.profile, { width: innerWidth, height: innerHeight, screenWidth: screen?.width ?? 0 });
  state.theme = applyProfile(state.profile, state.scale);
  showPlanMessage('Connecting to the HUD server…');

  const fontsReady = document.fonts?.load
    ? Promise.allSettled([document.fonts.load('500 40px Oswald'), document.fonts.load('600 40px Oswald'), document.fonts.load('500 20px Raleway')])
    : Promise.resolve();

  const { s, rtt } = await fetchInitialState();
  await fontsReady;
  resetTextMetrics();

  floorplan = createFloorplan(els.svg, {
    compact: state.compact,
    onMachineClick: (id) => { if (!state.profile.kiosk) { discovery.close(); runsPanel.close(); programsPanel.close(); detail.open(id); } },
    onBackgroundClick: () => detail.close(),
  });
  board = createBoard(els.head, els.rows, { onSelect: (id) => { discovery.close(); runsPanel.close(); programsPanel.close(); detail.open(id); } });
  detail = createDetail(els.detail, {
    api,
    getMachine: (id) => {
      const lm = state.layout?.machines?.find((m) => m?.id === id) ?? null;
      if (!lm) return null;
      const snap = snapshotsForLayout().get(id) ?? null;
      return { vm: machineView(snap, lm, { settings: state.settings, now: serverNow(), theme: state.theme }), snapshot: snap, layoutMachine: lm };
    },
    getContext: () => ({ settings: state.settings, now: serverNow(), theme: state.theme, kiosk: !!state.profile.kiosk }),
    readOnly: readOnlyView,
    onRunReport: (id) => { detail.close(); discovery.close(); runsPanel.open({ machine: id }); },
    // program transfer (D16): the Programs drawer for this machine, or its setup
    onPrograms: (id, opts) => { detail.close(); discovery.close(); runsPanel.close(); programsPanel.open(id, opts); },
    toast,
  });
  discovery = createDiscoveryPanel(els.discovery, {
    api,
    getContext: () => ({ settings: state.settings, now: serverNow(), theme: state.theme, kiosk: !!state.profile.kiosk }),
    getLayout: () => state.layout,
    getUnassigned: () => state.unassigned,
    readOnly: readOnlyView,
    toast,
  });
  runsPanel = createRunsPanel(els.runs, {
    api,
    getContext: () => ({ settings: state.settings, now: serverNow(), theme: state.theme, kiosk: !!state.profile.kiosk }),
    getMachines: () => (Array.isArray(state.layout?.machines) ? state.layout.machines : [])
      .filter((m) => m && typeof m.id === 'string' && m.source)
      .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id })),
    readOnly: readOnlyView,
    toast,
  });

  programsPanel = createProgramsPanel(els.programs, {
    api,
    getContext: () => ({ settings: state.settings, now: serverNow(), theme: state.theme, kiosk: !!state.profile.kiosk }),
    getMachines: () => (Array.isArray(state.layout?.machines) ? state.layout.machines : []).filter((m) => m && typeof m.id === 'string'),
    requestToken: () => tokenProvider({ status: 0, path: '', message: 'Programs need the edit token.' }),
    toast,
  });

  connect();
  events.noteServerTime(s?.serverTime, rtt);
  state.booted = true;
  state.lastSettingsJson = '';
  applyState(s);
  if (!isObj(s?.settings)) applyScreen();
  let staleSince = null;
  watchdog = createWatchdog({
    events,
    health: () => api.health(),
    reload: () => {
      reporter.report('reload', { reason: watchdog?.pendingReason ?? 'unknown' });
      location.reload();
    },
    onStale(stale, asOfWall) {
      if (stale && staleSince === null) staleSince = performance.now();
      else if (!stale && staleSince !== null) {
        reporter.report('stale', { staleS: Math.round((performance.now() - staleSince) / 1000), reason: 'reconnected' });
        staleSince = null;
      }
      state.stale = stale;
      state.staleAsOf = asOfWall || Date.now();
      els.root.classList.toggle('is-stale', stale);
      floorplan.setStale(stale, serverNow());
      if (stale) {
        const asOf = formatTimeOfDay(serverNow(), clockOpts());
        banner.show(`DISPLAY DISCONNECTED — DATA AS OF ${asOf}`, 'Reconnecting… machine status shown here may be out of date');
        topbar.setLive('stale', `No data since ${asOf}`);
      } else {
        banner.hide();
        topbar.setLive('live');
      }
      layoutGeometry();
      queueRender();
    },
  });
  watchdog.noteIdentity(s);
  watchdog.setReloadAt(typeof display().reloadAt === 'string' ? display().reloadAt : null);
  // ?debug=1: read-only diagnostics handle for the console / integration tests
  if (new URLSearchParams(location.search).get('debug') === '1') {
    globalThis.__hud = Object.freeze({ state, get events() { return events; }, get watchdog() { return watchdog; }, get floorplan() { return floorplan; }, serverNow });
  }

  const want = wantedLayout();
  if (!want) showPlanMessage('No active layout is configured on the server.');
  else if (want !== state.shownLayoutId) await loadLayout(want);
  updateSubtitle();

  setInterval(render, 1000);
  setInterval(() => { refreshTodayRuns(); }, 15_000); // phone cards: today's runs (a no-op elsewhere)
  refreshTodayRuns(true);
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { applyScreen(); board.refit(); queueRender(); }, 120);
  });
  globalThis.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (state.profile.theme === 'auto') applyScreen(); });
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => applyScreen());
  document.fonts?.addEventListener?.('loadingdone', () => { resetTextMetrics(); floorplan.relayout(); board.refit(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { detail.close(); discovery.close(); runsPanel.close(); programsPanel.close(); }
  });
  if (state.profile.edit) enterEditMode();
}

boot().catch((e) => {
  console.error(e);
  showPlanMessage(`The display failed to start: ${e?.message ?? e}`);
});
