// Status → colours, icons, words and the per-machine view model shared by the floor-plan tiles, the board and
// the detail drawer. Colours come from STATUS_META (docs/DECISIONS.md D2); attention from /shared/attention.js
// (D3); tile content and timers follow D4.
import { STATUS_META, STATUS_FAMILIES, ATTENTION_RING, HAZARD_COLORS, MACHINE_KINDS, DEBOUNCED_UNAVAILABLE_REASONS } from '/shared/contracts.js';
import { formatDuration, truncate } from '/shared/format.js';
import { attentionOf, isOutOfService } from '/shared/attention.js';

/** Non-status colours per theme. The floor plan is greys only (ISA-101); status hues are reserved for machines. */
export const THEME = Object.freeze({
  dark: Object.freeze({
    bg: '#0b0c0d', surface: '#16191b', text: '#f0f0f0', muted: '#a3a9ad',
    ring: ATTENTION_RING.dark, ringInk: '#0b0f14',
    wall: '#8b96a5', former: '#5d6672', door: '#8b96a5', roomFill: 'rgba(255,255,255,0.03)', roomStroke: 'rgba(255,255,255,0.06)',
    roomName: '#7d8896', object: '#4f5964', objectFill: 'rgba(255,255,255,0.025)', objectLabel: '#77818d', label: '#8792a0',
    neutralFill: '#2b3137', neutralInk: '#dfe4e9', neutralBorder: '#77818d',
    hatch: 'rgba(255,255,255,0.20)', staleHatch: 'rgba(255,255,255,0.28)', hairline: 'rgba(255,255,255,0.35)', grid: 'rgba(255,255,255,0.05)',
  }),
  light: Object.freeze({
    bg: '#f4f6f8', surface: '#ffffff', text: '#0b0f14', muted: '#4b5563',
    ring: ATTENTION_RING.light, ringInk: '#ffffff',
    wall: '#5b6573', former: '#9aa3ae', door: '#5b6573', roomFill: 'rgba(0,0,0,0.03)', roomStroke: 'rgba(0,0,0,0.05)',
    roomName: '#6b7280', object: '#a2abb6', objectFill: 'rgba(0,0,0,0.02)', objectLabel: '#6b7280', label: '#5b6573',
    neutralFill: '#e3e7ec', neutralInk: '#1f2937', neutralBorder: '#6b7280',
    hatch: 'rgba(11,15,20,0.16)', staleHatch: 'rgba(11,15,20,0.24)', hairline: 'rgba(255,255,255,0.40)', grid: 'rgba(0,0,0,0.05)',
  }),
});

export const HAZARD = HAZARD_COLORS;
const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** STATUS_META entry for a status; unknown values are treated as "no data" (never sorted ahead of E-STOP). */
export function metaOf(status) {
  return own(STATUS_META, status) ?? STATUS_META.UNAVAILABLE;
}

/** Theme-specific paint for a status: { fill, ink, border, borderColor, pattern, outline }. */
export function paletteFor(status, theme = 'dark') {
  const m = metaOf(status);
  const light = theme === 'light';
  return {
    fill: light ? m.fillLight : m.fill,
    ink: light ? m.inkLight : m.ink,
    border: m.border,
    borderColor: (light ? m.borderColorLight : m.borderColor) ?? null,
    pattern: m.pattern,
    outline: !!(light && m.outlineLight),
    icon: m.icon,
    word: m.word,
    family: m.family,
  };
}

/** Theme tokens (falls back to dark). */
export function themeColors(theme) {
  return theme === 'light' ? THEME.light : THEME.dark;
}

export function kindLabel(kind) {
  return own(MACHINE_KINDS, kind)?.label ?? 'Machine';
}

// ---------------------------------------------------------------------------------------------
// Time display
// ---------------------------------------------------------------------------------------------

const dtfCache = new Map();
function dtf(opts, timeZone) {
  const key = JSON.stringify([opts, timeZone ?? '']);
  let f = dtfCache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { ...opts, ...(timeZone ? { timeZone } : {}) }); } catch { f = new Intl.DateTimeFormat('en-US', opts); }
    dtfCache.set(key, f);
  }
  return f;
}

/** Wall-clock time "4:12 PM" / "16:12" in the display time zone. */
export function formatTimeOfDay(ms, { clock24h = false, timeZone } = {}) {
  if (!finite(ms) || Math.abs(ms) > 8.64e15) return '—';
  return dtf({ hour: 'numeric', minute: '2-digit', hour12: !clock24h }, timeZone).format(ms);
}

/** "4:12 PM" today, "Fri 4:12 PM" within ±6 days, else "Nov 3, 4:12 PM" — for "since …" / "until …" texts. */
export function formatSinceClock(ms, now, { clock24h = false, timeZone } = {}) {
  if (!finite(ms) || Math.abs(ms) > 8.64e15) return '—';
  const day = (t) => dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone).format(t);
  const time = formatTimeOfDay(ms, { clock24h, timeZone });
  if (finite(now) && day(ms) === day(now)) return time;
  if (finite(now) && Math.abs(now - ms) < 6 * 86_400_000) return `${dtf({ weekday: 'short' }, timeZone).format(ms)} ${time}`;
  return `${dtf({ month: 'short', day: 'numeric' }, timeZone).format(ms)}, ${time}`;
}

/** Glance duration with "≥" for lower-bound anchors; elapsed time is clamped to ≥ 0 (clock skew). */
export function glance(ms, lowerBound = false) {
  const t = formatDuration(Math.max(0, ms), { style: 'glance' });
  return lowerBound ? `≥ ${t}` : t;
}

// ---------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------

const TO_MM_PER_MIN = Object.freeze({
  'MILLIMETER/SECOND': 60, 'MILLIMETER/MINUTE': 1, 'INCH/MINUTE': 25.4, 'INCH/SECOND': 25.4 * 60, 'FOOT/MINUTE': 304.8,
});

/**
 * Feed rate for display. MTConnect reports PATH_FEEDRATE in MILLIMETER/SECOND; `target` is
 * settings.display.feedUnits ('in/min' default for a US shop, or 'mm/min').
 * @returns {{ value: number|null, text: string, units: string }}
 */
export function convertFeed(value, units, target = 'in/min') {
  const v = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const unitLabel = target === 'mm/min' ? 'mm/min' : 'in/min';
  if (!Number.isFinite(v)) return { value: null, text: '—', units: unitLabel };
  const factor = own(TO_MM_PER_MIN, String(units || 'MILLIMETER/SECOND').toUpperCase()) ?? 60;
  const mmPerMin = v * factor;
  const out = unitLabel === 'mm/min' ? mmPerMin : mmPerMin / 25.4;
  const digits = unitLabel === 'mm/min' ? 0 : out < 100 ? 1 : 0;
  const text = out.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  return { value: out, text: /^-0(\.0+)?$/.test(text) ? text.slice(1) : text, units: unitLabel };
}

// ---------------------------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------------------------

const ESTOP_CONDITION = /emergency|e-?\s?stop/i;
const SHORT_REASON_STATUSES = new Set(['PAUSED', 'IDLE', 'SETUP']);

/** First-out (oldest) FAULT — E-stop conditions suppressed while the status is ESTOP (D4). */
export function firstOutFault(snapshot) {
  const list = Array.isArray(snapshot?.conditions) ? snapshot.conditions : [];
  let faults = list.filter((c) => c && c.level === 'FAULT');
  if (snapshot?.status === 'ESTOP') {
    faults = faults.filter((c) => !(ESTOP_CONDITION.test(String(c.message ?? '')) || c.type === 'EMERGENCY_STOP'));
  }
  if (!faults.length) return null;
  const sorted = [...faults].sort((a, b) => (finite(a.since) ? a.since : Infinity) - (finite(b.since) ? b.since : Infinity));
  const first = sorted[0];
  const message = first.message ? String(first.message) : first.type ? String(first.type).replace(/_/g, ' ') : '';
  return { code: first.nativeCode ? String(first.nativeCode) : '', message, more: sorted.length - 1, condition: first };
}

/**
 * Snapshot for a layout machine that the server has not reported yet.
 * @param {object} lm layout machine
 */
export function placeholderSnapshot(lm) {
  const linked = !!lm?.source;
  return {
    id: lm?.id, name: lm?.name, kind: lm?.kind ?? 'other',
    status: linked ? 'OFFLINE' : 'UNBOUND', reason: linked ? 'Waiting for the server' : 'Not linked to a network device',
    connection: linked ? 'connecting' : 'unbound', connectionError: null,
    since: null, stoppedSince: null, lastRunningAt: null, sinceIsLowerBound: false, stoppedSinceIsLowerBound: false,
    badge: null, service: null, values: {}, conditions: [], device: null, binding: null, updatedAt: null, placeholder: true,
  };
}

/**
 * Everything a tile, a board row or the drawer needs to draw one machine.
 * @param {object|null} snapshot  MachineSnapshot (null → placeholder from the layout machine)
 * @param {object|null} lm        layout machine (name, kind, thresholds, source)
 * @param {{ settings?: object, now: number, theme?: string }} ctx   now = server-clock ms
 */
export function machineView(snapshot, lm, ctx) {
  const snap = snapshot ?? placeholderSnapshot(lm);
  const settings = ctx.settings ?? {};
  const display = settings.display ?? {};
  const theme = ctx.theme === 'light' ? 'light' : 'dark';
  const T = themeColors(theme);
  const now = ctx.now;
  // D1 folds the legacy STOPPED into IDLE; anything unknown is drawn as "no data", never as a healthy state
  const rawStatus = snap.status === 'STOPPED' ? 'IDLE' : snap.status;
  const status = own(STATUS_META, rawStatus) ? rawStatus : 'UNAVAILABLE';
  const pal = paletteFor(status, theme);
  const clockOpts = { clock24h: !!display.clock24h, timeZone: typeof display.timeZone === 'string' ? display.timeZone : undefined };

  const outOfService = isOutOfService(snap, now);
  const connecting = !outOfService && snap.connection === 'connecting' && (status === 'OFFLINE' || status === 'UNAVAILABLE');
  const variant = outOfService ? 'service' : status === 'UNBOUND' ? 'unbound' : connecting ? 'connecting' : 'status';
  const attention = attentionOf(snap, settings, now, lm ?? undefined);

  const vm = {
    id: snap.id ?? lm?.id,
    name: lm?.name ?? snap.name ?? snap.id ?? '',
    kind: lm?.kind ?? snap.kind ?? 'other',
    status, variant, theme,
    word: pal.word, icon: pal.icon, family: pal.family,
    fill: pal.fill, ink: pal.ink, border: pal.border, borderColor: pal.borderColor, pattern: pal.pattern, outline: pal.outline,
    reason: null, fullReason: snap.reason ? String(snap.reason) : '',
    timer: null, down: null, fault: null, program: null, note: null,
    badge: status === 'ALARM' || status === 'ESTOP' ? null : snap.badge === 'fault' || snap.badge === 'warning' ? snap.badge : null,
    attention, inShift: attention.inShift,
    sinceAge: finite(snap.since) && finite(now) ? Math.max(0, now - snap.since) : null,
    counted: variant === 'status' || variant === 'connecting', // linked and not out of service → in RUNNING n/N
    snapshot: snap,
  };

  if (variant === 'service') {
    Object.assign(vm, { word: 'OUT OF SERVICE', icon: 'ban', family: null, fill: T.neutralFill, ink: T.neutralInk, border: 'solid', borderColor: T.neutralBorder, pattern: 'hatch', outline: false, badge: null });
    const until = snap.service?.until;
    vm.timer = { text: finite(until) ? `until ${formatSinceClock(until, now, clockOpts)}` : 'until further notice', lowerBound: false, overdue: false, mode: 'until' };
    vm.note = snap.service?.note ? truncate(String(snap.service.note), 60) : null;
    return vm;
  }
  if (variant === 'unbound') {
    vm.reason = null;
    return vm;
  }
  if (variant === 'connecting') {
    Object.assign(vm, { word: 'CONNECTING…', icon: 'dots', family: null, fill: T.neutralFill, ink: T.neutralInk, border: 'dashed', borderColor: T.neutralBorder, pattern: null, outline: false, badge: null });
    return vm;
  }

  // Short reason line (D1): FEED HOLD / M00 STOP; READY / CYCLE COMPLETE; MANUAL / MDI …
  const r = vm.fullReason.trim();
  if (SHORT_REASON_STATUSES.has(status) && r && r.length <= 22) vm.reason = r.toUpperCase();
  else if (status === 'RUNNING' && /wait/i.test(r)) vm.reason = 'WAITING';

  // Timers (D4): primary = time in status; secondary "down 42m" when the stop started ≥ 1 min earlier.
  if (finite(snap.since)) {
    if (!attention.inShift) {
      vm.timer = { text: `since ${formatSinceClock(snap.since, now, clockOpts)}`, lowerBound: !!snap.sinceIsLowerBound, overdue: false, mode: 'since' };
    } else {
      const overdue = attention.level > 0 && (attention.rule === 'status' || attention.rule === 'down' || attention.level > 1);
      vm.timer = { text: glance(now - snap.since, !!snap.sinceIsLowerBound), lowerBound: !!snap.sinceIsLowerBound, overdue, mode: 'elapsed' };
      if (status !== 'RUNNING' && finite(snap.stoppedSince) && snap.since - snap.stoppedSince >= 60_000) {
        vm.down = { text: `down ${glance(now - snap.stoppedSince, !!snap.stoppedSinceIsLowerBound)}`, lowerBound: !!snap.stoppedSinceIsLowerBound };
      }
    }
  }

  // Fault line (ALARM/ESTOP, or a fault active while running).
  const fault = firstOutFault(snap);
  if (fault && (status === 'ALARM' || status === 'ESTOP' || snap.badge === 'fault')) vm.fault = fault;
  else if (status === 'ALARM' && r) vm.fault = { code: '', message: r, more: 0, condition: null };

  // Program comment + part count (RUNNING / PAUSED).
  if (status === 'RUNNING' || status === 'PAUSED') {
    const v = snap.values ?? {};
    const name = v.programComment ? String(v.programComment) : v.program ? String(v.program) : '';
    const pcs = typeof v.partCount === 'number' && Number.isFinite(v.partCount) ? `${v.partCount.toLocaleString('en-US')} pcs` : '';
    const text = [name ? truncate(name, 22) : '', pcs].filter(Boolean).join(' · ');
    vm.program = text || null;
  }
  return vm;
}

/** True when an E-STOP onset pulse should run (during shift, within display.estopPulseSeconds of onset). */
export function estopPulseActive(vm, settings) {
  if (vm.status !== 'ESTOP' || vm.variant !== 'status' || !vm.inShift) return false;
  const secs = Number(settings?.display?.estopPulseSeconds);
  const limit = (Number.isFinite(secs) && secs >= 0 ? secs : 60) * 1000;
  return vm.sinceAge !== null && vm.sinceAge < limit;
}

// ---------------------------------------------------------------------------------------------
// Board helpers
// ---------------------------------------------------------------------------------------------

/**
 * Urgency for the attention list: ESTOP > ALARM > overdue (by overdue ratio) > PAUSED > no data >
 * fault while running > SETUP > IDLE > RUNNING > out of service / connecting > not linked.
 * @returns {[number, number]} [rank, tie-breaker] — lower sorts first
 */
export function urgencyKey(vm) {
  if (vm.variant === 'unbound') return [10, 0];
  if (vm.variant === 'service' || vm.variant === 'connecting') return [9, 0];
  if (vm.status === 'ESTOP') return [0, -(vm.sinceAge ?? 0)];
  if (vm.status === 'ALARM') return [1, -(vm.sinceAge ?? 0)];
  if (vm.attention.level > 0) return [2, -vm.attention.overdueRatio];
  const rank = { PAUSED: 3, OFFLINE: 4, UNAVAILABLE: 4, SETUP: 6, IDLE: 7, RUNNING: 8 }[vm.status] ?? 4;
  if (vm.status === 'RUNNING' && vm.badge === 'fault') return [5, 0];
  return [rank, -(vm.sinceAge ?? 0)];
}

export function compareVm(a, b) {
  const ka = urgencyKey(a);
  const kb = urgencyKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || String(a.name).localeCompare(String(b.name));
}

/**
 * Counts for the board: RUNNING n/N (N excludes not-linked and out-of-service machines) and the fixed family
 * chips (D4). `connecting` machines count in N but in no chip.
 */
export function familyCounts(vms) {
  const counts = Object.fromEntries(STATUS_FAMILIES.map((f) => [f.id, 0]));
  let running = 0, total = 0, unbound = 0, service = 0, attention = 0;
  for (const vm of vms) {
    if (vm.variant === 'unbound') { unbound++; continue; }
    if (vm.variant === 'service') { service++; continue; }
    total++;
    if (vm.attention.level > 0) attention++;
    if (vm.variant !== 'status') continue;
    if (vm.status === 'RUNNING') running++;
    else if (vm.family && Object.prototype.hasOwnProperty.call(counts, vm.family)) counts[vm.family]++;
  }
  return { families: counts, running, total, unbound, service, attention };
}

/** Fixed chip definitions with their representative status for colour/icon. */
export const CHIPS = Object.freeze(STATUS_FAMILIES.map((f) => ({ ...f, status: f.statuses[0] })));

/**
 * Secondary facts for a phone card (board rows on a narrow screen): the program line and the readings the control
 * actually reports (parts, tool, spindle, load, feed). Values a control does not report are left out, not shown "—".
 * @param {object|null} snap  MachineSnapshot
 * @param {object} [settings]
 * @returns {{ program: string, readings: string }}
 */
export function machineFacts(snap, settings = {}) {
  const v = snap && snap.status !== 'OFFLINE' && snap.status !== 'UNBOUND' ? (snap.values ?? {}) : {};
  const text = (x) => (x === null || x === undefined || (typeof x === 'string' && !x.trim()) ? '' : String(x));
  const program = [text(v.program), text(v.programComment)].filter(Boolean).join(' · ');
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const fmt = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const out = [];
  if (num(v.partCount) !== null) out.push(`${fmt(v.partCount)} pcs`);
  if (text(v.toolNumber)) out.push(`T${text(v.toolNumber)}`);
  // spindle, load and feed only while in cycle or turning: "0 rpm · load 0% · 0.0 in/min" on a stopped machine is noise
  const live = (x) => x !== null && (x !== 0 || snap?.status === 'RUNNING' || snap?.status === 'PAUSED');
  if (live(num(v.spindleSpeed))) out.push(`${fmt(v.spindleSpeed)} rpm`);
  if (live(num(v.spindleLoad))) out.push(`load ${fmt(v.spindleLoad)}%`);
  const units = settings?.display?.feedUnits === 'mm/min' ? 'mm/min' : 'in/min';
  const feed = convertFeed(v.feedrate, v.feedrateUnits, units);
  if (live(feed.value)) out.push(`${feed.text} ${feed.units}`);
  return { program, readings: out.join(' · ') };
}

/** One-line detail for board rows and the drawer header: fault › reason › program. */
export function detailLine(vm) {
  if (vm.variant === 'service') return vm.note ?? '';
  if (vm.variant === 'unbound') return '';
  if (vm.variant === 'connecting') return 'Waiting for the first data…';
  const parts = [];
  if (vm.fault) parts.push(`${vm.fault.code ? `${vm.fault.code} ` : ''}${vm.fault.message}${vm.fault.more ? ` +${vm.fault.more}` : ''}`);
  else if (vm.reason) parts.push(vm.reason);
  else if ((vm.status === 'OFFLINE' || vm.status === 'UNAVAILABLE') && vm.fullReason) parts.push(vm.fullReason);
  if (vm.program) parts.push(vm.program);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Display debounce (D1): RUNNING → PAUSED/IDLE/SETUP is drawn only after display.minStateSeconds
// ---------------------------------------------------------------------------------------------

const DEBOUNCED = new Set(['PAUSED', 'IDLE', 'SETUP']);
/** RUNNING → X changes the debounce holds: PAUSED/IDLE/SETUP, and UNAVAILABLE "Execution state unknown" (D1a), which
 *  replaced IDLE for an unknown EXECUTION word. Adapter, availability and OFFLINE changes stay immediate. */
const debounced = (snap) => DEBOUNCED.has(snap.status)
  || (snap.status === 'UNAVAILABLE' && DEBOUNCED_UNAVAILABLE_REASONS.includes(snap.reason));

/**
 * Keeps showing RUNNING for a short stop until it has lasted `minStateMs`; the timer is backdated to the true
 * `since` when it finally shows. ESTOP, ALARM, OFFLINE and other UNAVAILABLE reasons show immediately. Idempotent with a server that
 * already debounces (its `since` is then older than minStateMs).
 */
export function createDisplayDebounce() {
  /** @type {Map<string, object>} id → snapshot currently shown */
  const shown = new Map();
  return {
    /**
     * @param {string} id
     * @param {object} snap raw snapshot
     * @param {number} now server ms
     * @param {number} minStateMs
     * @returns {{ snap: object, holdUntil: number|null }}
     */
    apply(id, snap, now, minStateMs) {
      const prev = shown.get(id);
      if (prev && prev.status === 'RUNNING' && snap && debounced(snap) && minStateMs > 0
        && finite(snap.since) && finite(now) && now - snap.since < minStateMs && !isOutOfService(snap, now)) {
        return { snap: prev, holdUntil: snap.since + minStateMs };
      }
      shown.set(id, snap);
      return { snap, holdUntil: null };
    },
    forget(id) { shown.delete(id); },
    clear() { shown.clear(); },
  };
}
