// Maintenance board (docs/DECISIONS.md D18): the shapes, words and arithmetic shared by the server
// (src/maintenance/*, src/server/api.js) and the HUD (public/js/maintenancePanel.js, public/js/detail.js). Pure ESM, no I/O.
//
// A task is one maintenance item on one machine (<dataDir>/maintenance/plan.json):
//   { id, catalogId, title, action, kind, basis, every, orEvery, alarm, link, source, scope, ifEquipped, enabled,
//     createdAt, updatedAt, last, triggered }
//   kind 'interval'  : due every `every` (hours of a meter, or calendar days/weeks/months/years), or `orEvery` if sooner
//        'alarm'     : due when the machine raises one of `alarm.match` (FANUC BAT, DS0307…), until it is marked done
//        'as-needed' : listed with its document, never due
//   alarm     : { match: [{ code, text?, notText? }], within } — any kind may have one; it makes the task due when seen
//   last      : { at, how: 'now'|'date'|'reading'|'start', totals: { [meterKey]: seconds }, note, estimated } | null
//   triggered : { at, code, message } — the alarm that made the task due (kept until it is marked done)
//
// Hours come from meters (METERS). A control meter is the control's own hour meter (FANUC parameters 6750-6754, Haas
// ?Q300/?Q301, MTConnect EQUIPMENT_TIMER); the HUD's own meters count the time it saw the machine connected, in cycle or
// with the spindle turning. src/maintenance/meters.js turns all of them into totals that never go down (a reset or preset
// meter is bridged), in seconds; a task counts on the first meter of its basis' chain (BASIS_CHAIN) that has a reading at
// its last baseline and now. Each substitute counts at least as many hours as the meter it stands in for, so a task
// comes due early, never late — except the HUD's own meters, which miss the time the HUD was not running (said so).

export const MAINT_UNITS = Object.freeze(['hour', 'day', 'week', 'month', 'year']);
export const CALENDAR_UNITS = Object.freeze(['day', 'week', 'month', 'year']);
export const METER_BASES = Object.freeze(['operating', 'cutting', 'power-on', 'spindle']);
export const BASES = Object.freeze([...METER_BASES, 'calendar']);
export const TASK_KINDS = Object.freeze(['interval', 'alarm', 'as-needed']);
export const TASK_SCOPES = Object.freeze(['model', 'control', 'related', 'general', 'custom']);

/** Meter keys → what they count. `control` meters come from the control, `hud` meters from the HUD's own observation. */
export const METERS = Object.freeze({
  'control.powerOn': Object.freeze({ source: 'control', label: 'Power-on', value: 'powerOnHours' }),
  'control.operating': Object.freeze({ source: 'control', label: 'Operating', value: 'operatingHours' }),
  'control.cutting': Object.freeze({ source: 'control', label: 'Cutting', value: 'cuttingHours' }),
  'control.spindle': Object.freeze({ source: 'control', label: 'Spindle', value: 'spindleHours' }),
  'hud.on': Object.freeze({ source: 'hud', label: 'On', value: null }),
  'hud.cycle': Object.freeze({ source: 'hud', label: 'In cycle', value: null }),
  'hud.spindle': Object.freeze({ source: 'hud', label: 'Spindle turning', value: null }),
});
export const METER_KEYS = Object.freeze(Object.keys(METERS));
export const CONTROL_METER_KEYS = Object.freeze(METER_KEYS.filter((k) => METERS[k].source === 'control'));

/**
 * Which meter a task of each basis counts on, best first. Every later entry counts at least as many hours as the
 * earlier ones would (cutting ≤ operating ≤ in cycle ≤ on ≈ power-on), so a substitute brings a task due early. A
 * control meter that stopped answering for a day of the machine being on is stale and skipped.
 */
export const BASIS_CHAIN = Object.freeze({
  operating: Object.freeze(['control.operating', 'hud.cycle']),
  cutting: Object.freeze(['control.cutting', 'control.operating', 'hud.cycle']),
  'power-on': Object.freeze(['control.powerOn', 'hud.on']),
  spindle: Object.freeze(['control.spindle', 'hud.spindle', 'control.powerOn', 'hud.on']),
});

/** Task states, most urgent first (TASK_STATE_ORDER sorts lists). */
export const TASK_STATES = Object.freeze({
  DUE: 'due',             // the interval is used up, or an alarm asked for it
  SOON: 'soon',           // at most settings.maintenance.soonPercent of the interval left
  START: 'start',         // never done: the shop has to say when it was last done, or start counting now
  NO_HOURS: 'nohours',    // an hours task on a machine with no meter of that kind (not linked, or no reading yet)
  OK: 'ok',
  WATCH: 'watch',         // an alarm task whose alarm is not active
  AS_NEEDED: 'asneeded',  // listed with its document, never due
  OFF: 'off',             // turned off in Set up (kept with its history)
});
export const TASK_STATE_ORDER = Object.freeze({ due: 0, soon: 1, start: 2, nohours: 3, ok: 4, watch: 5, asneeded: 6, off: 7 });

export const STATE_LABELS = Object.freeze({
  due: 'Due', soon: 'Due soon', start: 'Needs a start', nohours: 'Not counting', ok: 'OK', watch: 'On alarm', asneeded: 'As needed', off: 'Off',
});

/** How a task was last marked (POST …/done { how }). */
export const DONE_HOW = Object.freeze(['now', 'date', 'reading', 'start']);

export const BASIS_LABELS = Object.freeze({
  operating: 'operating hours', cutting: 'cutting hours', 'power-on': 'power-on hours', spindle: 'spindle hours', calendar: 'calendar',
});

/** Task ids: t-<time, base 36>-<random, base 36>. */
export const MAINT_TASK_ID_RE = /^t-[0-9a-z]{1,12}-[0-9a-z]{1,8}$/;
export const NOTE_MAX = 200;
export const TITLE_MAX = 120;
export const ACTION_MAX = 2000;
export const LINK_MAX = 2048;
export const CODES_MAX = 24;
export const CODE_MAX = 24;
export const TASKS_PER_MACHINE_MAX = 300;
/** Largest interval per unit (a typo guard, not a policy). */
export const INTERVAL_MAX = Object.freeze({ hour: 100_000, day: 3650, week: 520, month: 240, year: 20 });
/** How far back "done on" may go. */
export const DONE_BACK_MAX_DAYS = 5 * 366;

const HOUR = 3_600_000;
const DAY = 86_400_000;
export { DAY as DAY_MS };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ------------------------------------------------------------------------------------------------------------------
// Intervals and calendar arithmetic (local time of the computer that runs it: the HUD PC on the server)
// ------------------------------------------------------------------------------------------------------------------

/** { value, unit } with a whole value in range, else null. */
export function normalizeEvery(e) {
  if (!isObj(e)) return null;
  const unit = e.unit;
  const value = e.value;
  if (!MAINT_UNITS.includes(unit) || !Number.isInteger(value) || value < 1 || value > INTERVAL_MAX[unit]) return null;
  return { value, unit };
}

/** Local midnight that starts the day of `ms`. */
export function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * `ms` plus an interval: hours exactly; days and weeks as local calendar days (the same wall time across DST);
 * months and years as calendar months, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb).
 */
export function addInterval(ms, every) {
  const e = normalizeEvery(every);
  if (!e || !finite(ms)) return null;
  if (e.unit === 'hour') return ms + e.value * HOUR;
  const d = new Date(ms);
  if (e.unit === 'day' || e.unit === 'week') {
    d.setDate(d.getDate() + e.value * (e.unit === 'week' ? 7 : 1));
    return d.getTime();
  }
  const months = e.unit === 'year' ? 12 * e.value : e.value;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

/** Nominal length of a calendar interval in days (for the "due soon" window). */
export function intervalDays(every) {
  const e = normalizeEvery(every);
  if (!e) return null;
  return { hour: e.value / 24, day: e.value, week: 7 * e.value, month: 30.44 * e.value, year: 365.25 * e.value }[e.unit];
}

/** "every 2,000 h", "every 6 months", "every week", "daily". */
export function formatEvery(every, basis = null) {
  const e = normalizeEvery(every);
  if (!e) return '';
  if (e.unit === 'hour') {
    const n = e.value.toLocaleString('en-US');
    const what = basis && basis !== 'calendar' ? BASIS_LABELS[basis] ?? 'hours' : 'hours';
    return `every ${n} ${e.value === 1 ? what.replace(/s$/, '') : what}`;
  }
  if (e.value === 1) return { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[e.unit];
  return `every ${e.value} ${e.unit}s`;
}

/** The interval words of a task: "every 2,000 operating hours or yearly, whichever comes first". */
export function describeInterval(task) {
  if (!isObj(task)) return '';
  if (task.kind === 'as-needed') return 'as needed';
  if (task.kind === 'alarm') {
    const codes = alarmCodes(task.alarm);
    const within = normalizeEvery(task.alarm?.within);
    return `on alarm${codes.length ? ` ${codes.join(', ')}` : ''}${within ? `, within ${formatEvery(within).replace(/^every /, '').replace(/^(daily|weekly|monthly|yearly)$/, (w) => ({ daily: '1 day', weekly: '1 week', monthly: '1 month', yearly: '1 year' })[w])}` : ''}`;
  }
  const a = formatEvery(task.every, task.basis);
  const b = task.orEvery ? formatEvery(task.orEvery, task.basis) : '';
  return b ? `${a} or ${b.replace(/^every /, '')}, whichever comes first` : a;
}

// ------------------------------------------------------------------------------------------------------------------
// Alarm matching
// ------------------------------------------------------------------------------------------------------------------

/** The distinct codes an alarm task listens for. */
export function alarmCodes(alarm) {
  const out = [];
  for (const m of Array.isArray(alarm?.match) ? alarm.match : []) {
    const c = typeof m?.code === 'string' ? m.code.trim().toUpperCase() : '';
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * True when an active condition is one of the task's alarms: the code equal (ignoring case), and for a rule with
 * `text` the message containing it, with `notText` the message not containing it (FANUC's BAT flag is raised for the
 * memory battery and for the absolute-position batteries alike; the message tells them apart).
 * @param {{ match: Array<{code: string, text?: string, notText?: string}> }} alarm
 * @param {{ nativeCode?: string|null, message?: string|null }} condition
 */
export function alarmMatches(alarm, condition) {
  const code = typeof condition?.nativeCode === 'string' ? condition.nativeCode.trim().toUpperCase() : '';
  if (!code) return false;
  const msg = String(condition?.message ?? '').toLowerCase();
  for (const m of Array.isArray(alarm?.match) ? alarm.match : []) {
    if (typeof m?.code !== 'string' || m.code.trim().toUpperCase() !== code) continue;
    if (typeof m.text === 'string' && m.text && !msg.includes(m.text.toLowerCase())) continue;
    if (typeof m.notText === 'string' && m.notText && msg.includes(m.notText.toLowerCase())) continue;
    return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------------------------
// Due computation
// ------------------------------------------------------------------------------------------------------------------

/**
 * Where a task stands now. Pure: the caller passes the machine's meter totals and paces.
 *
 * @param {object} task
 * @param {{ now: number, meters?: Record<string, {total: number, at?: number|null, stale?: boolean}>,
 *           pace?: Record<string, number>, soonPercent?: number }} ctx
 *   meters: ledger totals in seconds per meter key (stale: skip it); pace: hours per calendar day per meter key
 * @returns {{ state: string, meter: string|null, approx: boolean, hudOnly: boolean, used: number|null,
 *             remaining: number|null, every: number|null, unit: 'hour'|'day'|null, fraction: number|null,
 *             dueAt: number|null, estimated: boolean, triggered: object|null, deadline: number|null, by: 'every'|'orEvery'|null }}
 *   used/remaining/every are hours for meter intervals and days for calendar ones; dueAt is the calendar due date or
 *   the estimated date of an hours task (estimated: true) when the pace is known.
 */
export function taskStatus(task, { now, meters = {}, pace = {}, soonPercent = 10 } = {}) {
  const base = { state: TASK_STATES.OK, meter: null, approx: false, hudOnly: false, used: null, remaining: null, every: null, unit: null, fraction: null, dueAt: null, estimated: false, triggered: null, deadline: null, by: null };
  if (!isObj(task)) return { ...base, state: TASK_STATES.AS_NEEDED };
  if (task.enabled === false) return { ...base, state: TASK_STATES.OFF };
  const trig = isObj(task.triggered) && finite(task.triggered.at) ? task.triggered : null;
  if (trig) {
    const within = normalizeEvery(task.alarm?.within);
    return { ...base, state: TASK_STATES.DUE, triggered: trig, deadline: within ? addInterval(trig.at, within) : null, by: 'alarm' };
  }
  if (task.kind === 'as-needed') return { ...base, state: TASK_STATES.AS_NEEDED };
  if (task.kind === 'alarm') return { ...base, state: TASK_STATES.WATCH };
  const soon = Math.min(50, Math.max(0, finite(soonPercent) ? soonPercent : 10)) / 100;
  const parts = [['every', task.every], ['orEvery', task.orEvery]]
    .filter(([, e]) => normalizeEvery(e))
    .map(([by, e]) => ({ by, ...intervalStatus(task, normalizeEvery(e), by === 'orEvery' ? 'calendar' : task.basis, { now, meters, pace, soon }) }));
  if (!parts.length) return { ...base, state: TASK_STATES.AS_NEEDED };
  if (!isObj(task.last) || !finite(task.last.at)) return { ...base, ...pick(parts[0]), state: TASK_STATES.START };
  // whichever comes first: the most urgent part; among equally urgent ones the earlier due date (a calendar date, or
  // an hours forecast), and without dates the larger share used
  const known = parts.filter((p) => p.state !== TASK_STATES.NO_HOURS);
  const pool = known.length ? known : parts;
  pool.sort((a, b) => {
    const s = (TASK_STATE_ORDER[a.state] ?? 9) - (TASK_STATE_ORDER[b.state] ?? 9);
    if (s) return s;
    if (finite(a.dueAt) && finite(b.dueAt) && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    return (b.fraction ?? -1) - (a.fraction ?? -1);
  });
  return { ...base, ...pick(pool[0]) };
}

function pick(p) {
  const { by, state, meter, approx, hudOnly, used, remaining, every, unit, fraction, dueAt, estimated } = p;
  return { by, state, meter, approx, hudOnly, used, remaining, every, unit, fraction, dueAt, estimated };
}

function intervalStatus(task, every, basis, { now, meters, pace, soon }) {
  const last = isObj(task.last) && finite(task.last.at) ? task.last : null;
  if (every.unit !== 'hour' || basis === 'calendar' || !METER_BASES.includes(basis)) {
    // calendar: due from the start of the day the interval ends (a daily check done at 07:15 is due all of the next day)
    const days = intervalDays(every);
    if (!last) return { state: TASK_STATES.START, meter: null, approx: false, hudOnly: false, used: null, remaining: null, every: days, unit: 'day', fraction: null, dueAt: null, estimated: false };
    const dueAt = startOfDay(addInterval(last.at, every));
    const remainingDays = (dueAt - now) / DAY;
    const usedDays = Math.max(0, (now - last.at) / DAY);
    const soonDays = Math.floor(days * soon);
    const state = now >= dueAt ? TASK_STATES.DUE : soonDays >= 1 && remainingDays <= soonDays ? TASK_STATES.SOON : TASK_STATES.OK;
    return { state, meter: null, approx: false, hudOnly: false, used: usedDays, remaining: remainingDays, every: days, unit: 'day', fraction: Math.min(1, usedDays / days), dueAt, estimated: false };
  }
  const chain = BASIS_CHAIN[basis] ?? [];
  const hours = every.value;
  for (const key of chain) {
    const cur = meters?.[key];
    const atLast = last?.totals?.[key];
    if (!isObj(cur) || !finite(cur.total) || cur.stale) continue;
    if (last && !finite(atLast)) continue;
    // a total below the baseline means the meter history was lost (meters.json): this meter cannot say, try the next
    if (last && cur.total < atLast - 60) continue;
    const hudOnly = METERS[key]?.source === 'hud';
    const approx = key !== chain[0] || hudOnly;
    if (!last) return { state: TASK_STATES.START, meter: key, approx, hudOnly, used: null, remaining: null, every: hours, unit: 'hour', fraction: null, dueAt: null, estimated: false };
    const used = Math.max(0, (cur.total - atLast) / 3600);
    const remaining = hours - used;
    const state = remaining <= 0 ? TASK_STATES.DUE : remaining <= hours * soon ? TASK_STATES.SOON : TASK_STATES.OK;
    const rate = pace?.[key];
    const dueAt = remaining > 0 && finite(rate) && rate > 0 ? now + (remaining / rate) * DAY : null;
    return { state, meter: key, approx, hudOnly, used, remaining, every: hours, unit: 'hour', fraction: Math.min(1, used / hours), dueAt, estimated: dueAt !== null };
  }
  return { state: last ? TASK_STATES.NO_HOURS : TASK_STATES.START, meter: null, approx: false, hudOnly: false, used: null, remaining: null, every: hours, unit: 'hour', fraction: null, dueAt: null, estimated: false };
}

/** Counts per state over task statuses: { due, soon, start, … } plus `attention` (due + soon). */
export function countStates(statuses) {
  const counts = { due: 0, soon: 0, start: 0, nohours: 0, ok: 0, watch: 0, asneeded: 0, off: 0 };
  for (const s of statuses) if (s && counts[s.state] !== undefined) counts[s.state] += 1;
  return { ...counts, attention: counts.due + counts.soon };
}

/** Sort key for task rows: state, then the least left, then the title. */
export function compareTaskRows(a, b) {
  const o = (TASK_STATE_ORDER[a.status?.state] ?? 9) - (TASK_STATE_ORDER[b.status?.state] ?? 9);
  if (o) return o;
  const fa = a.status?.fraction ?? -1;
  const fb = b.status?.fraction ?? -1;
  if (fa !== fb) return fb - fa;
  const da = a.status?.dueAt ?? Infinity;
  const db = b.status?.dueAt ?? Infinity;
  if (da !== db) return da - db;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''));
}

// ------------------------------------------------------------------------------------------------------------------
// The catalog (src/maintenance/catalog.json): validation and matching
// ------------------------------------------------------------------------------------------------------------------

/** http(s) URL without credentials, at most LINK_MAX characters; anything else → null. */
export function safeUrl(s) {
  if (typeof s !== 'string' || !s || s.length > LINK_MAX) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

function validMatchRules(rules, path, errors) {
  if (!Array.isArray(rules) || !rules.length || rules.length > CODES_MAX) { errors.push({ path, message: 'alarm.match must list 1-24 rules' }); return null; }
  const out = [];
  for (const [i, r] of rules.entries()) {
    const code = typeof r?.code === 'string' ? r.code.trim() : '';
    if (!code || code.length > CODE_MAX || /[\u0000-\u001f]/.test(code)) { errors.push({ path: `${path}[${i}].code`, message: 'invalid alarm code' }); return null; }
    const rule = { code };
    if (r.text !== undefined) { if (typeof r.text !== 'string' || !r.text.trim()) { errors.push({ path: `${path}[${i}].text`, message: 'text must be a non-empty string' }); return null; } rule.text = r.text.trim(); }
    if (r.notText !== undefined) { if (typeof r.notText !== 'string' || !r.notText.trim()) { errors.push({ path: `${path}[${i}].notText`, message: 'notText must be a non-empty string' }); return null; } rule.notText = r.notText.trim(); }
    out.push(rule);
  }
  return out;
}

/**
 * Check the shipped catalog. Bad sources, models and tasks are dropped with an error each; the rest is returned frozen.
 * @returns {{ ok: boolean, errors: Array<{path: string, message: string}>, catalog: object }}
 */
export function validateCatalog(doc) {
  const errors = [];
  const empty = { format: 1, version: null, about: '', sources: [], controls: [], models: [], tasks: [] };
  if (!isObj(doc) || doc.format !== 1) return { ok: false, errors: [{ path: '', message: 'not a format 1 maintenance catalog' }], catalog: deepFreeze(empty) };
  const sources = [];
  const sourceIds = new Set();
  for (const [i, s] of (Array.isArray(doc.sources) ? doc.sources : []).entries()) {
    const p = `sources[${i}]`;
    if (!isObj(s) || typeof s.id !== 'string' || !s.id || sourceIds.has(s.id)) { errors.push({ path: p, message: 'source needs a unique id' }); continue; }
    if (typeof s.title !== 'string' || !s.title || typeof s.publisher !== 'string' || !s.publisher) { errors.push({ path: p, message: 'source needs a title and a publisher' }); continue; }
    if (s.url !== undefined && s.url !== null && !safeUrl(s.url)) { errors.push({ path: `${p}.url`, message: 'url must be http(s)' }); continue; }
    if (s.pageUrl !== undefined && s.pageUrl !== null && !safeUrl(s.pageUrl)) { errors.push({ path: `${p}.pageUrl`, message: 'pageUrl must be http(s)' }); continue; }
    sourceIds.add(s.id);
    sources.push({ ...s, url: s.url ? safeUrl(s.url) : null, ...(s.pageUrl ? { pageUrl: safeUrl(s.pageUrl) } : {}) });
  }
  const controls = [];
  const controlIds = new Set();
  for (const [i, c] of (Array.isArray(doc.controls) ? doc.controls : []).entries()) {
    const p = `controls[${i}]`;
    if (!isObj(c) || typeof c.id !== 'string' || !c.id || controlIds.has(c.id) || typeof c.label !== 'string') { errors.push({ path: p, message: 'control needs a unique id and a label' }); continue; }
    if (!compiles(c.match?.manufacturer) || !compiles(c.match?.model) || (c.match?.notModel !== undefined && !compiles(c.match.notModel))) { errors.push({ path: `${p}.match`, message: 'match patterns must be valid regular expressions' }); continue; }
    controlIds.add(c.id);
    controls.push(c);
  }
  const models = [];
  const modelIds = new Set();
  for (const [i, m] of (Array.isArray(doc.models) ? doc.models : []).entries()) {
    const p = `models[${i}]`;
    if (!isObj(m) || typeof m.id !== 'string' || !m.id || modelIds.has(m.id) || typeof m.label !== 'string') { errors.push({ path: p, message: 'model needs a unique id and a label' }); continue; }
    if (!compiles(m.match?.make) || !compiles(m.match?.model)) { errors.push({ path: `${p}.match`, message: 'match patterns must be valid regular expressions' }); continue; }
    if (m.control !== null && m.control !== undefined && !controlIds.has(m.control)) { errors.push({ path: `${p}.control`, message: `unknown control ${m.control}` }); continue; }
    if (m.service !== undefined && !sourceIds.has(m.service)) { errors.push({ path: `${p}.service`, message: `unknown source ${m.service}` }); continue; }
    modelIds.add(m.id);
    models.push(m);
  }
  const tasks = [];
  const taskIds = new Set();
  for (const [i, t] of (Array.isArray(doc.tasks) ? doc.tasks : []).entries()) {
    const p = `tasks[${i}]`;
    const e = [];
    if (!isObj(t) || typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9./-]{1,80}$/.test(t.id) || taskIds.has(t.id)) { errors.push({ path: p, message: 'task needs a unique id (lowercase letters, digits, . / -)' }); continue; }
    if (!Array.isArray(t.for) || !t.for.length || !t.for.every((f) => typeof f === 'string' && ((f.startsWith('model:') && modelIds.has(f.slice(6))) || (f.startsWith('control:') && controlIds.has(f.slice(8)))))) e.push({ path: `${p}.for`, message: 'for must name known models or controls' });
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > TITLE_MAX) e.push({ path: `${p}.title`, message: `title must be 1-${TITLE_MAX} characters` });
    if (typeof t.action !== 'string' || t.action.length > ACTION_MAX) e.push({ path: `${p}.action`, message: `action must be at most ${ACTION_MAX} characters` });
    if (!TASK_KINDS.includes(t.kind)) e.push({ path: `${p}.kind`, message: 'unknown kind' });
    if (t.kind === 'interval') {
      if (!BASES.includes(t.basis)) e.push({ path: `${p}.basis`, message: 'unknown basis' });
      const every = normalizeEvery(t.every);
      if (!every) e.push({ path: `${p}.every`, message: 'every needs a whole value and a unit' });
      else if ((t.basis === 'calendar') !== CALENDAR_UNITS.includes(every.unit)) e.push({ path: `${p}.every`, message: 'calendar tasks count days, weeks, months or years; meter tasks count hours' });
      if (t.orEvery !== undefined && t.orEvery !== null && (!normalizeEvery(t.orEvery) || !CALENDAR_UNITS.includes(t.orEvery.unit) || t.basis === 'calendar')) e.push({ path: `${p}.orEvery`, message: 'orEvery is a calendar limit on an hours task' });
    }
    let match = null;
    if (t.kind === 'alarm') {
      match = validMatchRules(t.alarm?.match, `${p}.alarm.match`, e);
      if (t.alarm?.within !== null && t.alarm?.within !== undefined && !normalizeEvery(t.alarm.within)) e.push({ path: `${p}.alarm.within`, message: 'within must be an interval or null' });
    }
    if (typeof t.suggest !== 'boolean') e.push({ path: `${p}.suggest`, message: 'suggest must be true or false' });
    if (!TASK_SCOPES.includes(t.scope) || t.scope === 'custom') e.push({ path: `${p}.scope`, message: 'unknown scope' });
    const s = t.source;
    if (!isObj(s) || !sourceIds.has(s.ref)) e.push({ path: `${p}.source.ref`, message: 'unknown source' });
    else {
      if (typeof s.locator !== 'string' || !s.locator) e.push({ path: `${p}.source.locator`, message: 'a locator (page or section) is required' });
      if (typeof s.quote !== 'string' || !s.quote || s.quote.length > 800) e.push({ path: `${p}.source.quote`, message: 'a quote of at most 800 characters is required' });
      if (s.page !== undefined && (!Number.isInteger(s.page) || s.page < 1 || s.page > 5000)) e.push({ path: `${p}.source.page`, message: 'page must be a PDF page number' });
      if (s.url !== undefined && !safeUrl(s.url)) e.push({ path: `${p}.source.url`, message: 'url must be http(s)' });
    }
    if (!isObj(t.checked) || !['confirmed', 'corrected'].includes(t.checked.result)) e.push({ path: `${p}.checked`, message: 'only checked tasks ship' });
    if (e.length) { errors.push(...e); continue; }
    taskIds.add(t.id);
    tasks.push({ ...t, ...(match ? { alarm: { match, within: normalizeEvery(t.alarm.within) } } : {}) });
  }
  const catalog = { format: 1, version: typeof doc.version === 'string' ? doc.version : null, about: typeof doc.about === 'string' ? doc.about : '', sources, controls, models, tasks };
  return { ok: errors.length === 0, errors, catalog: deepFreeze(catalog) };
}

function compiles(p) {
  if (typeof p !== 'string' || !p) return false;
  try { new RegExp(p, 'i'); return true; } catch { return false; }
}
const re = (p) => new RegExp(p, 'i');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Score each catalog model against a machine: make words in its name or notes or the control's maker (+2), the model
 * pattern in its name, notes or the control's model (+3), the machine kind (+1, or −2 when both are known and differ).
 * @param {object} catalog
 * @param {{ name?: string, notes?: string, kind?: string, manufacturer?: string|null, model?: string|null }} machine
 * @returns {Array<{ id: string, label: string, score: number }>}  best first, positive scores only
 */
export function scoreModels(catalog, machine) {
  const text = [machine?.name, machine?.notes].filter((x) => typeof x === 'string').join(' \n ');
  const dev = [machine?.manufacturer, machine?.model].filter((x) => typeof x === 'string').join(' ');
  const out = [];
  for (const m of catalog?.models ?? []) {
    let score = 0;
    if (re(m.match.make).test(text) || re(m.match.make).test(dev)) score += 2;
    if (re(m.match.model).test(text) || re(m.match.model).test(dev)) score += 3;
    if (machine?.kind && Array.isArray(m.kinds) && m.kinds.length && machine.kind !== 'unknown' && machine.kind !== 'other') score += m.kinds.includes(machine.kind) ? 1 : -2;
    if (score > 0) out.push({ id: m.id, label: m.label, score });
  }
  return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** The catalog model to suggest: a score of at least 4 and 2 ahead of the next; else null. Nothing is applied without a click. */
export function suggestModel(catalog, machine) {
  const [a, b] = scoreModels(catalog, machine);
  if (!a || a.score < 4 || (b && a.score - b.score < 2)) return null;
  return a.id;
}

/** The catalog control family of a machine: its model's control, else the control's maker and model (FOCAS reports "Series 31i-B (M)"), else its notes. */
export function controlFor(catalog, machine, modelId = null) {
  const model = modelId ? (catalog?.models ?? []).find((m) => m.id === modelId) : null;
  if (model?.control) return model.control;
  for (const c of catalog?.controls ?? []) {
    const not = c.match.notModel ? re(c.match.notModel) : null;
    const devOk = typeof machine?.manufacturer === 'string' && re(c.match.manufacturer).test(machine.manufacturer)
      && typeof machine?.model === 'string' && re(c.match.model).test(machine.model) && !(not && not.test(machine.model));
    if (devOk) return c.id;
    const text = [machine?.name, machine?.notes].filter((x) => typeof x === 'string').join(' \n ');
    if (!machine?.model && re(c.match.manufacturer).test(text) && re(c.match.model).test(text) && !(not && not.test(text))) return c.id;
  }
  return null;
}

/** Catalog tasks for a machine with this model and control, model tasks first. */
export function catalogTasksFor(catalog, { modelId = null, controlId = null } = {}) {
  const keys = [modelId ? `model:${modelId}` : null, controlId ? `control:${controlId}` : null].filter(Boolean);
  if (!keys.length) return [];
  const tasks = (catalog?.tasks ?? []).filter((t) => t.for.some((f) => keys.includes(f)));
  return tasks.sort((a, b) => (a.for.includes(`model:${modelId}`) ? 0 : 1) - (b.for.includes(`model:${modelId}`) ? 0 : 1));
}

/** The link to open a task's document: the task's own page URL, or the source's URL at the PDF page. Null when the source is cited, not linked. */
export function sourceLink(catalog, task) {
  const ref = task?.source?.ref;
  const src = (catalog?.sources ?? []).find((s) => s.id === ref);
  if (task?.source?.url) return safeUrl(task.source.url);
  if (!src?.url) return null;
  return src.kind === 'pdf' && Number.isInteger(task?.source?.page) ? `${src.url}#page=${task.source.page}` : src.url;
}

/**
 * The document reference a board task keeps (copied when the task is added, so a later catalog never changes a plan):
 * { title, number, edition, publisher, host, url, locator, quote, asStated, scope, appliesTo, note, checked, accessed }.
 */
export function taskSourceFromCatalog(catalog, task) {
  const src = (catalog?.sources ?? []).find((s) => s.id === task?.source?.ref);
  if (!src) return null;
  return {
    id: src.id, title: src.title, number: src.number ?? null, edition: src.edition ?? null, publisher: src.publisher,
    host: src.host ?? null, url: sourceLink(catalog, task), locator: task.source.locator, quote: task.source.quote,
    asStated: task.source.asStated ?? null, appliesTo: src.appliesTo ?? null, note: src.note ?? null,
    checked: task.checked?.on ?? null, accessed: src.accessed ?? null,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Request bodies
// ------------------------------------------------------------------------------------------------------------------

const TASK_FIELDS = new Set(['title', 'action', 'kind', 'basis', 'every', 'orEvery', 'alarm', 'link', 'enabled']);

/**
 * A custom task, or the changes to a task (`partial`). Unknown fields are refused; text is cleaned and capped.
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function parseTaskInput(body, { partial = false } = {}) {
  if (!isObj(body)) return { ok: false, message: 'Expected a JSON object' };
  for (const k of Object.keys(body)) if (!TASK_FIELDS.has(k)) return { ok: false, message: `Unknown field "${k}"` };
  const v = {};
  if (body.title !== undefined || !partial) {
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') return { ok: false, message: 'The title must be text' };
    const t = clean(body.title, TITLE_MAX + 1);
    if (!t || t.length > TITLE_MAX) return { ok: false, message: `The title must be 1-${TITLE_MAX} characters` };
    v.title = t;
  }
  if (body.action !== undefined) {
    if (body.action !== null && typeof body.action !== 'string') return { ok: false, message: 'action must be text' };
    const a = String(body.action ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
    if (a.length > ACTION_MAX) return { ok: false, message: `The description must be at most ${ACTION_MAX} characters` };
    v.action = a;
  }
  if (body.kind !== undefined || !partial) {
    const kind = body.kind ?? 'interval';
    if (!TASK_KINDS.includes(kind)) return { ok: false, message: 'kind must be interval, alarm or as-needed' };
    v.kind = kind;
  }
  if (body.basis !== undefined) {
    if (!BASES.includes(body.basis)) return { ok: false, message: 'basis must be operating, cutting, power-on, spindle or calendar' };
    v.basis = body.basis;
  }
  if (body.every !== undefined) {
    if (body.every === null) v.every = null;
    else { const e = normalizeEvery(body.every); if (!e) return { ok: false, message: 'every needs a whole number and a unit (hour, day, week, month, year) in range' }; v.every = e; }
  }
  if (body.orEvery !== undefined) {
    if (body.orEvery === null) v.orEvery = null;
    else { const e = normalizeEvery(body.orEvery); if (!e || !CALENDAR_UNITS.includes(e.unit)) return { ok: false, message: 'orEvery must be a calendar interval (days, weeks, months or years)' }; v.orEvery = e; }
  }
  if (body.alarm !== undefined) {
    if (body.alarm === null) v.alarm = null;
    else {
      if (!isObj(body.alarm)) return { ok: false, message: 'alarm must be an object' };
      for (const k of Object.keys(body.alarm)) if (!['codes', 'within'].includes(k)) return { ok: false, message: `Unknown field "alarm.${k}"` };
      const raw = Array.isArray(body.alarm.codes) ? body.alarm.codes : typeof body.alarm.codes === 'string' ? body.alarm.codes.split(/[\s,;]+/) : null;
      const codes = (raw ?? []).map((c) => clean(c, CODE_MAX + 1)).filter(Boolean);
      if (!codes.length || codes.length > CODES_MAX || codes.some((c) => c.length > CODE_MAX || /\s/.test(c))) return { ok: false, message: `List 1-${CODES_MAX} alarm codes (e.g. BAT, DS0307)` };
      let within = null;
      if (body.alarm.within !== undefined && body.alarm.within !== null) { within = normalizeEvery(body.alarm.within); if (!within || !CALENDAR_UNITS.includes(within.unit)) return { ok: false, message: 'alarm.within must be a calendar interval' }; }
      v.alarm = { match: [...new Set(codes.map((c) => c.toUpperCase()))].map((code) => ({ code })), within };
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { ok: false, message: 'enabled must be true or false' };
    if (!partial) return { ok: false, message: 'A new task is always on' };
    v.enabled = body.enabled;
  }
  if (body.link !== undefined) {
    if (body.link === null || body.link === '') v.link = null;
    else { const u = safeUrl(typeof body.link === 'string' ? body.link.trim() : ''); if (!u) return { ok: false, message: 'The link must be an http:// or https:// address' }; v.link = u; }
  }
  if (!partial) {
    if (v.kind === 'interval') {
      if (!v.every) return { ok: false, message: 'An interval task needs an interval' };
      v.basis ??= v.every.unit === 'hour' ? 'operating' : 'calendar';
    }
    if (v.kind === 'alarm' && !v.alarm) return { ok: false, message: 'An alarm task needs alarm codes' };
  }
  return { ok: true, value: v };
}

/** Check an interval task's basis and units together (after a partial edit has been merged). */
export function checkTaskShape(t) {
  if (t.kind === 'interval') {
    const every = normalizeEvery(t.every);
    if (!every) return 'An interval task needs an interval';
    if (!BASES.includes(t.basis)) return 'Unknown basis';
    if ((t.basis === 'calendar') !== CALENDAR_UNITS.includes(every.unit)) return t.basis === 'calendar' ? 'A calendar task counts days, weeks, months or years' : 'An hours task counts hours';
    if (t.orEvery && (t.basis === 'calendar' || !CALENDAR_UNITS.includes(t.orEvery.unit))) return 'The second limit is a calendar limit on an hours task';
  }
  if (t.kind === 'alarm' && !alarmCodes(t.alarm).length) return 'An alarm task needs alarm codes';
  return null;
}

/** 'YYYY-MM-DD' of a local date → local noon of that day (ms), or null. */
export function localNoon(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === 'string' ? date : '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getTime();
}

/**
 * POST …/tasks/:task/done: { how?, date?, reading?, note? }
 *   how 'now' (default)  done now
 *       'date'           done on `date` ('YYYY-MM-DD', the HUD PC's calendar; today back to five years)
 *       'reading'        the control's hour meter read `reading` h at the last service (the sticker), on `date` if given
 *       'start'          "Not sure — count from now"
 * @returns {{ ok: true, value: { how, at, reading, note, dated } } | { ok: false, message: string }}
 */
export function parseDoneBody(body, { now }) {
  const b = body === null || body === undefined ? {} : body;
  if (!isObj(b)) return { ok: false, message: 'Expected a JSON object' };
  for (const k of Object.keys(b)) if (!['how', 'date', 'reading', 'note'].includes(k)) return { ok: false, message: `Unknown field "${k}"` };
  const how = b.how ?? 'now';
  if (!DONE_HOW.includes(how)) return { ok: false, message: 'how must be now, date, reading or start' };
  let at = now;
  let dated = false;
  if (b.date !== undefined && b.date !== null && b.date !== '') {
    if (how !== 'date' && how !== 'reading') return { ok: false, message: 'A date goes with how "date" or "reading"' };
    const noon = localNoon(b.date);
    if (noon === null) return { ok: false, message: 'date must be YYYY-MM-DD' };
    if (startOfDay(noon) > startOfDay(now)) return { ok: false, message: 'The date cannot be in the future' };
    if (noon < now - DONE_BACK_MAX_DAYS * DAY) return { ok: false, message: 'The date can be at most five years back' };
    at = Math.min(noon, now);
    dated = true;
  } else if (how === 'date') return { ok: false, message: 'Give the date it was done' };
  let reading = null;
  if (how === 'reading') {
    if (!finite(b.reading) || b.reading < 0 || b.reading > 1_000_000) return { ok: false, message: 'reading must be the meter\u2019s hours' };
    reading = b.reading;
  } else if (b.reading !== undefined && b.reading !== null) return { ok: false, message: 'A reading goes with how "reading"' };
  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return { ok: false, message: 'note must be text' };
  const note = clean(b.note, NOTE_MAX + 1);
  if (note.length > NOTE_MAX) return { ok: false, message: `The note must be at most ${NOTE_MAX} characters` };
  return { ok: true, value: { how, at, reading, note: note || null, dated } };
}

/**
 * PUT /api/maintenance/machines/:id (Set up): { model, tasks: [{ catalogId, every?, orEvery? }] }
 * @returns {{ ok: true, value: { model: string|null, tasks: Array<{catalogId: string, every?: object, orEvery?: object|null}> } } | { ok: false, message: string }}
 */
export function parseSetupBody(body) {
  if (!isObj(body)) return { ok: false, message: 'Expected a JSON object' };
  for (const k of Object.keys(body)) if (!['model', 'tasks'].includes(k)) return { ok: false, message: `Unknown field "${k}"` };
  const model = body.model ?? null;
  if (model !== null && (typeof model !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(model))) return { ok: false, message: 'model must be a catalog model id or null' };
  if (!Array.isArray(body.tasks) || body.tasks.length > TASKS_PER_MACHINE_MAX) return { ok: false, message: 'tasks must be a list' };
  const tasks = [];
  const seen = new Set();
  for (const t of body.tasks) {
    if (!isObj(t)) return { ok: false, message: 'Each task must be an object' };
    for (const k of Object.keys(t)) if (!['catalogId', 'every', 'orEvery'].includes(k)) return { ok: false, message: `Unknown field "tasks[].${k}"` };
    if (typeof t.catalogId !== 'string' || !/^[a-z0-9][a-z0-9./-]{1,80}$/.test(t.catalogId)) return { ok: false, message: 'catalogId must be a catalog task id' };
    if (seen.has(t.catalogId)) continue;
    seen.add(t.catalogId);
    const v = { catalogId: t.catalogId };
    if (t.every !== undefined) { const e = normalizeEvery(t.every); if (!e) return { ok: false, message: `${t.catalogId}: every needs a whole number and a unit in range` }; v.every = e; }
    if (t.orEvery !== undefined) {
      if (t.orEvery === null) v.orEvery = null;
      else { const e = normalizeEvery(t.orEvery); if (!e || !CALENDAR_UNITS.includes(e.unit)) return { ok: false, message: `${t.catalogId}: the second limit must be days, weeks, months or years` }; v.orEvery = e; }
    }
    tasks.push(v);
  }
  return { ok: true, value: { model, tasks } };
}
