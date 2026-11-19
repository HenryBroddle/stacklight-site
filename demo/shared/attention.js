// Attention ("needs someone at the machine") — docs/DECISIONS.md D3. Pure ESM shared by the server and the
// browser HUD (served at /shared/attention.js). No Node or DOM APIs; Intl is used only for an optional time zone.
//
// One hue-independent cue: level 1 = single ring, level 2 = double ring (2× the threshold). Tiles never change
// hue with time. Rules (during shift hours only):
//   ESTOP, ALARM                → immediately (level ≥ 1)
//   PAUSED                      → after thresholds.pausedWarnMinutes  (default 3)   measured on `since`
//   IDLE                        → after thresholds.idleWarnMinutes    (default 15)  measured on `since`
//   SETUP                       → after thresholds.setupWarnMinutes   (default 120) measured on `since`
//   OFFLINE, UNAVAILABLE        → after thresholds.offlineWarnMinutes (default 10)  measured on `since`
//   any stop (not RUNNING)      → after thresholds.downWarnMinutes    (default 30)  measured on `stoppedSince`
//                                 (while in SETUP the down limit is max(down, setup))
// Never: RUNNING, UNBOUND, machines out of service (snapshot.service), machines still "Connecting…" and anything
// outside shift hours (settings.shifts). Only in-shift time counts: anchors older than the start of the current
// shift period are clamped to it, so on Monday at 06:00 machines idle since Friday ring at 06:15, not at once.

/** Default thresholds in minutes (D3). */
export const DEFAULT_THRESHOLDS = Object.freeze({
  pausedWarnMinutes: 3,
  idleWarnMinutes: 15,
  setupWarnMinutes: 120,
  offlineWarnMinutes: 10,
  downWarnMinutes: 30,
});

/** Default shift schedule (D3) when settings.shifts is absent. */
export const DEFAULT_SHIFTS = Object.freeze([Object.freeze({ days: 'Mon-Fri', start: '06:00', end: '18:00' })]);

const MINUTE = 60_000;
const DAY_MINUTES = 1440;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const STATUS_RULE = Object.freeze({
  PAUSED: { key: 'pausedWarnMinutes', label: 'Paused' },
  IDLE: { key: 'idleWarnMinutes', label: 'Idle' },
  SETUP: { key: 'setupWarnMinutes', label: 'In setup' },
  OFFLINE: { key: 'offlineWarnMinutes', label: 'Offline' },
  UNAVAILABLE: { key: 'offlineWarnMinutes', label: 'No data' },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Merge default, shop-wide and per-machine thresholds (minutes).
 * A value of `null`, `false` or a negative number disables that rule; `0` means "immediately";
 * anything else that is not a finite number is ignored (the less specific value is kept).
 * @param {object} [settings]          public settings (uses settings.thresholds)
 * @param {object} [machineOverrides]  the layout machine's `thresholds` object, or the layout machine itself
 * @returns {{pausedWarnMinutes:number|null, idleWarnMinutes:number|null, setupWarnMinutes:number|null,
 *            offlineWarnMinutes:number|null, downWarnMinutes:number|null}}
 */
export function resolveThresholds(settings, machineOverrides) {
  const out = { ...DEFAULT_THRESHOLDS };
  const layers = [own(settings, 'thresholds')];
  const mo = isObj(machineOverrides) && isObj(own(machineOverrides, 'thresholds')) ? machineOverrides.thresholds : machineOverrides;
  layers.push(mo);
  for (const layer of layers) {
    if (!isObj(layer)) continue;
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      const v = own(layer, key);
      if (v === undefined) continue;
      if (v === null || v === false || (finite(v) && v < 0)) out[key] = null;
      else if (finite(v)) out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shift hours
// ---------------------------------------------------------------------------------------------

/**
 * Parse a day specification into a Set of weekday numbers (0 = Sunday … 6 = Saturday).
 * Accepts "Mon-Fri", "Mon–Fri", "Fri-Mon" (wraps), "Mon,Wed,Fri", "Sat", "Monday", "daily", "*", "weekdays",
 * "weekends", or an array of names / numbers. Returns null when nothing valid is found.
 * @param {string|Array<string|number>} spec
 * @returns {Set<number>|null}
 */
export function parseDays(spec) {
  const days = new Set();
  const dayIndex = (s) => {
    if (typeof s === 'number') return Number.isInteger(s) && s >= 0 && s <= 7 ? s % 7 : -1;
    const t = String(s).trim().toLowerCase().slice(0, 3);
    return DAY_NAMES.indexOf(t);
  };
  const addPart = (part) => {
    if (typeof part === 'number') { const d = dayIndex(part); if (d >= 0) days.add(d); return; }
    if (typeof part !== 'string') return;
    const p = part.trim().toLowerCase();
    if (!p) return;
    if (p === '*' || p === 'daily' || p === 'all' || p === 'every day' || p === 'everyday') { for (let d = 0; d < 7; d++) days.add(d); return; }
    if (p === 'weekdays') { for (let d = 1; d <= 5; d++) days.add(d); return; }
    if (p === 'weekends' || p === 'weekend') { days.add(0); days.add(6); return; }
    const range = p.split(/\s*[-–—]\s*|\s+to\s+/);
    if (range.length === 2) {
      const a = dayIndex(range[0]);
      const b = dayIndex(range[1]);
      if (a < 0 || b < 0) return;
      for (let d = a, n = 0; n < 7; d = (d + 1) % 7, n++) { days.add(d); if (d === b) break; }
      return;
    }
    const d = dayIndex(p);
    if (d >= 0) days.add(d);
  };
  if (Array.isArray(spec)) spec.forEach(addPart);
  else if (typeof spec === 'string') spec.split(/[,;/]|\s+and\s+/).forEach(addPart);
  else if (typeof spec === 'number') addPart(spec);
  return days.size ? days : null;
}

/**
 * "06:00" / "6:00" / "18:30" / "24:00" / "6:00 PM" → minutes after midnight (NaN when invalid).
 * @param {string} s
 */
export function parseTimeOfDay(s) {
  if (typeof s !== 'string') return NaN;
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*$/i.exec(s);
  if (!m) return NaN;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return NaN;
  if (m[3]) {
    if (h < 1 || h > 12) return NaN;
    const pm = /^p/i.test(m[3]);
    h = (h % 12) + (pm ? 12 : 0);
  } else if (m[2] === undefined) return NaN; // a bare "6" is ambiguous
  const total = h * 60 + min;
  return total >= 0 && total <= DAY_MINUTES ? total : NaN;
}

const formatterCache = new Map();
function zonedFormatter(timeZone) {
  if (formatterCache.has(timeZone)) return formatterCache.get(timeZone);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  } catch { f = null; } // invalid IANA name → local time
  if (formatterCache.size > 32) formatterCache.clear();
  formatterCache.set(timeZone, f);
  return f;
}

/**
 * Weekday (0 = Sunday) and minutes after midnight of an epoch-ms instant, in `timeZone` (IANA) when given and
 * valid, else in the runtime's local time zone.
 * @param {number} ms
 * @param {string} [timeZone]
 * @returns {{ weekday: number, minutes: number }}
 */
export function localTimeParts(ms, timeZone) {
  if (typeof timeZone === 'string' && timeZone) {
    const f = zonedFormatter(timeZone);
    if (f) {
      try {
        const parts = f.formatToParts(ms);
        const get = (t) => parts.find((p) => p.type === t)?.value;
        const weekday = DAY_NAMES.indexOf(String(get('weekday')).toLowerCase().slice(0, 3));
        const h = Number(get('hour')) % 24;
        const min = Number(get('minute'));
        const sec = new Date(ms).getUTCSeconds() + (ms % 1000) / 1000; // zone offsets are whole minutes in practice
        if (weekday >= 0 && Number.isFinite(h) && Number.isFinite(min)) return { weekday, minutes: h * 60 + min + sec / 60 };
      } catch { /* fall through to local time */ }
    }
  }
  const d = new Date(ms);
  return { weekday: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000 };
}

/**
 * Normalize a shift list. `undefined`/`null` → DEFAULT_SHIFTS. `[]`, "always", "24/7" or a list without any valid
 * entry → null (no schedule: always in shift — failing open keeps attention working when the config is broken).
 * @param {unknown} shifts
 * @returns {{days:Set<number>, start:number, end:number}[]|null}
 */
export function normalizeShifts(shifts) {
  let list = shifts;
  if (list === undefined || list === null) list = DEFAULT_SHIFTS;
  if (typeof list === 'string' || !Array.isArray(list)) return null;
  const out = [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const days = parseDays(own(s, 'days') ?? 'daily');
    const start = parseTimeOfDay(own(s, 'start'));
    const end = parseTimeOfDay(own(s, 'end'));
    if (!days || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ days, start, end });
  }
  return out.length ? out : null;
}

/**
 * True when `now` falls inside one of the shifts. A shift whose end is not after its start runs past midnight
 * (it belongs to the day it starts on); start === end means 24 hours from start.
 * @param {unknown} shifts       settings.shifts
 * @param {number} now           epoch ms
 * @param {string} [timeZone]    IANA zone (settings.display.timeZone); default = runtime local time
 */
export function isInShift(shifts, now, timeZone) {
  const list = normalizeShifts(shifts);
  if (!list) return true;
  if (!finite(now)) return true;
  return shiftStartContaining(list, now, timeZone) !== null;
}

/** Start (epoch ms) of the earliest-starting normalized shift that contains `t`, or null. */
function shiftStartContaining(list, t, timeZone) {
  const { weekday, minutes } = localTimeParts(t, timeZone);
  const prev = (weekday + 6) % 7;
  let back = null; // minutes elapsed since the shift started
  for (const { days, start, end } of list) {
    let b = null;
    if (end > start) {
      if (days.has(weekday) && minutes >= start && minutes < end) b = minutes - start;
    } else if (days.has(weekday) && minutes >= start) {
      b = minutes - start; // overnight shift (or 24 h when start === end), first part
    } else if (days.has(prev) && minutes < end) {
      b = minutes + DAY_MINUTES - start; // overnight shift that began yesterday
    }
    if (b !== null && (back === null || b > back)) back = b;
  }
  return back === null ? null : t - Math.round(back * MINUTE);
}

/**
 * Start (epoch ms) of the shift period containing `now`, following back-to-back shifts (e.g. 06:00-14:00 then
 * 14:00-22:00 → 06:00). null when outside shift hours or when there is no schedule.
 * Attention timers count only in-shift time, so idle machines don't all ring the moment Monday's shift starts.
 * @param {unknown} shifts
 * @param {number} now
 * @param {string} [timeZone]
 */
export function currentShiftStart(shifts, now, timeZone) {
  const list = normalizeShifts(shifts);
  if (!list || !finite(now)) return null;
  let start = shiftStartContaining(list, now, timeZone);
  if (start === null) return null;
  for (let i = 0; i < 14; i++) {
    const earlier = shiftStartContaining(list, start - MINUTE, timeZone);
    if (earlier === null || earlier >= start) break;
    start = earlier;
  }
  return start;
}

// ---------------------------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------------------------

/** "3m", "2h", "1h 30m" — compact minutes for reason texts. */
function formatMinutes(min) {
  if (!(min >= 1)) return min > 0 ? `${Math.round(min * 60)}s` : '0m';
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function levelOf(ratio) {
  return ratio >= 2 ? 2 : ratio >= 1 ? 1 : 0;
}

/** True while a planned-downtime record is in force at `now`. */
export function isOutOfService(snapshot, now) {
  const s = snapshot?.service;
  if (!isObj(s)) return false;
  const until = s.until;
  if (until === null || until === undefined) return true;
  return !(finite(until) && finite(now) && until <= now);
}

/**
 * Attention level for one machine snapshot (D3).
 * @param {object} snapshot          MachineSnapshot (status, since, stoppedSince, service, connection, …)
 * @param {object} [settings]        public settings: thresholds, shifts, display.timeZone
 * @param {number} now               server-clock epoch ms
 * @param {object} [machineOverrides] layout machine `thresholds` (or the layout machine itself)
 * @returns {{ level: 0|1|2, reason: string, overdueRatio: number, rule: string|null,
 *            thresholdMs: number|null, elapsedMs: number|null, inShift: boolean }}
 */
export function attentionOf(snapshot, settings, now, machineOverrides) {
  const none = (reason, inShift = true) => ({ level: 0, reason, overdueRatio: 0, rule: null, thresholdMs: null, elapsedMs: null, inShift });
  if (!isObj(snapshot)) return none('No data');
  const status = snapshot.status;
  if (status === 'UNBOUND') return none('Not linked');
  if (!finite(now)) return none('No clock');
  if (isOutOfService(snapshot, now)) return none('Out of service');
  if (snapshot.connection === 'connecting' && (status === 'OFFLINE' || status === 'UNAVAILABLE')) return none('Connecting');

  const tzSetting = own(own(settings, 'display'), 'timeZone') ?? own(settings, 'timeZone');
  const tz = typeof tzSetting === 'string' ? tzSetting : undefined;
  const shifts = own(settings, 'shifts');
  if (!isInShift(shifts, now, tz)) return none('Outside shift hours', false);
  const inShift = true;
  // Only in-shift time counts toward thresholds (null = no schedule → no clamp).
  const shiftStart = currentShiftStart(shifts, now, tz);

  const th = resolveThresholds(settings, machineOverrides);
  const elapsed = (t) => (finite(t) ? Math.max(0, now - (shiftStart !== null ? Math.max(t, shiftStart) : t)) : null);
  /** @type {{level:number, ratio:number, rule:string, reason:string, thresholdMs:number|null, elapsedMs:number|null}[]} */
  const hits = [];
  const sinceMs = elapsed(snapshot.since);

  if (status === 'ESTOP' || status === 'ALARM') {
    hits.push({ level: 1, ratio: 1, rule: status === 'ESTOP' ? 'estop' : 'alarm', reason: status === 'ESTOP' ? 'E-stop' : 'Alarm', thresholdMs: 0, elapsedMs: sinceMs });
  } else if (Object.prototype.hasOwnProperty.call(STATUS_RULE, status)) {
    const { key, label } = STATUS_RULE[status];
    const min = th[key];
    if (min !== null && sinceMs !== null) {
      const thresholdMs = min * MINUTE;
      const ratio = thresholdMs > 0 ? sinceMs / thresholdMs : 1;
      hits.push({ level: thresholdMs > 0 ? levelOf(ratio) : 1, ratio, rule: 'status', reason: `${label} over ${formatMinutes(min)}`, thresholdMs, elapsedMs: sinceMs });
    }
  }

  // The down rule catches long stops hidden by status changes (ALARM → IDLE → ALARM resets `since`, not
  // `stoppedSince`). Setup work is planned: while in SETUP the down limit is at least setupWarnMinutes, and a
  // disabled setup rule disables it too.
  let downMin = th.downWarnMinutes;
  if (status === 'SETUP') downMin = th.setupWarnMinutes === null || downMin === null ? null : Math.max(downMin, th.setupWarnMinutes);
  if (status !== 'RUNNING' && downMin !== null) {
    const downMs = elapsed(snapshot.stoppedSince);
    if (downMs !== null) {
      const thresholdMs = downMin * MINUTE;
      const ratio = thresholdMs > 0 ? downMs / thresholdMs : 1;
      hits.push({ level: thresholdMs > 0 ? levelOf(ratio) : 1, ratio, rule: 'down', reason: `Down over ${formatMinutes(downMin)}`, thresholdMs, elapsedMs: downMs });
    }
  }

  if (status === 'ESTOP' || status === 'ALARM') {
    // Immediate, and escalates to a double ring when the stop outlasts 2× downWarnMinutes.
    const base = hits[0];
    const down = hits.find((h) => h.rule === 'down');
    const level = Math.max(1, down ? down.level : 0);
    return { level, reason: base.reason, overdueRatio: Math.max(1, down ? down.ratio : 0), rule: base.rule, thresholdMs: base.thresholdMs, elapsedMs: base.elapsedMs, inShift };
  }

  let best = null;
  for (const h of hits) {
    if (!best || h.level > best.level || (h.level === best.level && h.ratio > best.ratio)) best = h;
  }
  if (!best) return none(status === 'RUNNING' ? 'Running' : 'No threshold');
  const overdueRatio = Number.isFinite(best.ratio) ? best.ratio : 0;
  if (best.level === 0) return { level: 0, reason: '', overdueRatio, rule: null, thresholdMs: best.thresholdMs, elapsedMs: best.elapsedMs, inShift };
  return { level: /** @type {0|1|2} */ (best.level), reason: best.reason, overdueRatio, rule: best.rule, thresholdMs: best.thresholdMs, elapsedMs: best.elapsedMs, inShift };
}
