// Maintenance drawer (docs/DECISIONS.md D18): what each machine needs and when, from its builder's published documents.
// - List: every machine's tasks (or one machine's), grouped Due, Due soon and Needs a start; OK, On alarm, As needed,
//   Not counting and Off start collapsed. A row has its pill (word + icon in outline and ink, never a status colour, D2),
//   the machine, the title, how far along it is, the document it comes from, and Done….
// - A row opens to the action, the interval, what the document says (quote, page), where the count stands, when it was
//   last done, Edit, and its last log entries. One machine's view starts with its model, hour meters and documents.
// - Set up (one machine): pick the model, tick the catalog's tasks and adjust their intervals, add the shop's own tasks.
// - openDoneDialog(): Done now / on a date / at a meter reading / not sure (count from now); the machine drawer uses it too.
// Data comes from GET /api/maintenance only while the drawer is open; an SSE 'maintenance' event refetches that machine.
// Writes need the edit token (api.js asks for it on a 401). Every string is rendered with textContent.
import { formatNumber, truncate } from '/shared/format.js';
import {
  STATE_LABELS, BASIS_LABELS, BASIS_CHAIN, METERS, CONTROL_METER_KEYS, METER_BASES, MAINT_UNITS, CALENDAR_UNITS, INTERVAL_MAX,
  NOTE_MAX, TITLE_MAX, ACTION_MAX, LINK_MAX, CODES_MAX, describeInterval, formatEvery, compareTaskRows, alarmCodes, safeUrl, normalizeEvery,
} from '/shared/maintenance.js';
import { iconSvg } from './icons.js';

const DAY = 86_400_000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => typeof v === 'string' && v.trim() !== '';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A count the server may send as a number or as the list of ids. */
const countOf = (v) => (Array.isArray(v) ? v.length : finite(v) ? v : 0);

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function button(label, cls, icon) {
  const b = h('button', `btn ${cls ?? ''}`.trim());
  b.type = 'button';
  if (icon) b.append(iconSvg(icon, { size: null }));
  if (label) b.append(h('span', null, label));
  return b;
}
let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

/** List groups in order: the first three open, the rest collapsed until opened. */
export const GROUPS = Object.freeze([
  { state: 'due', open: true }, { state: 'soon', open: true }, { state: 'start', open: true },
  { state: 'ok', open: false }, { state: 'watch', open: false }, { state: 'asneeded', open: false },
  { state: 'nohours', open: false }, { state: 'off', open: false },
]);
/** Pill glyphs: none of them is a machine-status silhouette (icons.js). */
export const STATE_ICONS = Object.freeze({ due: 'flag', soon: 'clock', start: 'hourglass', nohours: 'gauge', ok: 'check', watch: 'bell', asneeded: 'info', off: 'toggle-off' });
const UNIT_WORDS = Object.freeze({ hour: 'hours', day: 'days', week: 'weeks', month: 'months', year: 'years' });
const HUD_METER_KEYS = Object.freeze(['hud.on', 'hud.cycle', 'hud.spindle']);
/** The meters line names the operating hours first (most hour tasks count them). */
const METERS_LINE_ORDER = Object.freeze(['control.operating', 'control.powerOn', 'control.cutting', 'control.spindle']);
const LOG_WORDS = Object.freeze({
  setup: 'Set up', add: 'Added', edit: 'Changed', remove: 'Removed', start: 'Counting from now', triggered: 'Alarm came up',
  'meter-reset': 'Meter reset', 'meter-preset': 'Meter preset', 'meter-relink': 'Meter relinked',
});
const DONE_WORDS = Object.freeze({ now: 'Marked done', date: 'Recorded as done on a date', reading: 'Recorded from a meter reading', start: 'Counting from now (not sure when it was last done)' });
const FIELD_WORDS = Object.freeze({ title: 'title', action: 'description', basis: 'which hours', every: 'interval', orEvery: 'second limit', alarm: 'alarm codes', link: 'link', enabled: 'on/off' });

/** The task's state, or 'ok' for anything unknown. */
const stateOf = (task) => (STATE_LABELS[task?.status?.state] ? task.status.state : 'ok');

// ---------------------------------------------------------------------------------------------
// Words (pure: test/unit/maintenance-panel.test.js)
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
const okMs = (ms) => finite(ms) && Math.abs(ms) <= 8.64e15;

/** 'YYYY-MM-DD' of `ms` on the display's calendar (the Done dialog's "today"). */
export function localDateKey(ms, timeZone) {
  const p = Object.fromEntries(dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Dec 3"; "Dec 3, 2027" when it is not the year of `now`. */
export function shortDate(ms, now, { timeZone } = {}) {
  if (!okMs(ms)) return '—';
  const year = (t) => dtf({ year: 'numeric' }, timeZone).format(t);
  const same = !okMs(now) || year(ms) === year(now);
  return dtf(same ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }, timeZone).format(ms);
}

/** "today, 3:12 PM" or "Nov 3, 3:12 PM". */
export function dateTime(ms, now, { clock24h = false, timeZone } = {}) {
  if (!okMs(ms)) return '—';
  const time = dtf({ hour: 'numeric', minute: '2-digit', hour12: !clock24h }, timeZone).format(ms);
  const today = okMs(now) && localDateKey(ms, timeZone) === localDateKey(now, timeZone);
  return `${today ? 'today' : shortDate(ms, now, { timeZone })}, ${time}`;
}

/** Hours for reading: "0.4", "87", "1,587". */
export function formatHours(h) {
  if (!finite(h)) return '—';
  return formatNumber(h, Math.abs(h) < 9.95 ? 1 : 0);
}

/**
 * The row's progress text: "Overdue by 32 h", "Overdue by 3 days", "87 h left · ≈ Dec 3", "Due Dec 19",
 * "BAT · Battery low since Nov 3", "Watching for BAT, DS0307", "Needs a start".
 * @param {object} task  a task of GET /api/maintenance (with `status`)
 * @param {{ now: number, timeZone?: string }} o
 */
export function progressText(task, { now, timeZone } = {}) {
  const s = isObj(task?.status) ? task.status : {};
  const o = { timeZone };
  switch (stateOf(task)) {
    case 'due': {
      if (isObj(s.triggered)) {
        const what = [s.triggered.code, s.triggered.message].filter(str).join(' · ') || 'Its alarm came up';
        return finite(s.triggered.at) ? `${what} since ${shortDate(s.triggered.at, now, o)}` : what;
      }
      if (s.unit === 'hour' && finite(s.remaining)) return -s.remaining >= 0.05 ? `Overdue by ${formatHours(-s.remaining)} h` : 'Due now';
      if (finite(s.dueAt) && finite(now)) {
        const days = Math.floor((now - s.dueAt) / DAY);
        return days >= 1 ? `Overdue by ${plural(days, 'day')}` : 'Due today';
      }
      return 'Due';
    }
    case 'soon':
    case 'ok': {
      if (s.unit === 'hour' && finite(s.remaining)) return `${formatHours(Math.max(0, s.remaining))} h left${finite(s.dueAt) ? ` · ≈ ${shortDate(s.dueAt, now, o)}` : ''}`;
      if (finite(s.dueAt)) return `Due ${shortDate(s.dueAt, now, o)}`;
      return stateOf(task) === 'soon' ? 'Due soon' : 'OK';
    }
    case 'start': return 'Needs a start';
    case 'nohours': return `Not counting: no ${BASIS_LABELS[task?.basis] ?? 'hours'} from this machine`;
    case 'watch': {
      const codes = alarmCodes(task?.alarm);
      return codes.length ? `Watching for ${codes.join(', ')}` : 'Watching for its alarm';
    }
    case 'asneeded': return 'As needed';
    case 'off': return 'Turned off';
    default: return '';
  }
}

/**
 * The row's document link: "Manual p. 112" for a page of a linked document, else its title; a document with no public
 * copy is cited (number and page) without a link; a task of the shop's own shows its own link. `url` is http(s) or null.
 * @returns {{ label: string, url: string|null, title: string } | null}
 */
export function docLinkInfo(task) {
  const src = isObj(task?.source) ? task.source : null;
  if (src) {
    const url = safeUrl(src.url);
    const title = [src.title, src.number, src.edition, src.locator].filter(str).join(' · ');
    if (url) {
      const page = /#page=(\d+)/.exec(url)?.[1];
      return { label: page ? `Manual p. ${page}` : (str(src.title) ? src.title : 'Document'), url, title };
    }
    const cite = [src.number, src.locator].filter(str).join(', ');
    return { label: cite || (str(src.title) ? src.title : 'Document'), url: null, title };
  }
  const own = safeUrl(task?.link);
  return own ? { label: 'Link', url: own, title: own } : null;
}

/**
 * "Done today, 3:12 PM", "Done Nov 9 — new filter", "Done Oct 1, by the hour meter reading", "Counting from …",
 * "Not marked done yet". `last.estimated` says the count starts from when it was entered, not from the work itself.
 */
export function lastDoneText(task, { now, timeZone, clock24h } = {}) {
  const l = task?.last;
  if (!isObj(l) || !finite(l.at)) return 'Not marked done yet';
  const day = shortDate(l.at, now, { timeZone });
  const when = dateTime(l.at, now, { timeZone, clock24h });
  let t;
  if (l.how === 'start') t = `Counting from ${when} (when it was last done was not known)`;
  else if (l.how === 'date') t = `Done ${day}${l.estimated ? ' (its hours count from when it was entered)' : ''}`;
  else if (l.how === 'reading') t = l.estimated ? 'Done by the hour meter reading (no date given)' : `Done ${day}, by the hour meter reading`;
  else t = `Done ${when}`;
  return str(l.note) ? `${t} — ${l.note}` : t;
}

/** The machine drawer's Hours row: "Power-on 24,247 · Operating 21,319 · Cutting 15,617 h", or null without any. */
export function hoursText(values) {
  const v = isObj(values) ? values : {};
  const parts = CONTROL_METER_KEYS.map((k) => METERS[k]).filter((m) => finite(v[m.value])).map((m) => `${m.label} ${formatNumber(v[m.value])}`);
  return parts.length ? `${parts.join(' · ')} h` : null;
}

/** "Operating 21,319 h · Power-on 24,247 h (control) · HUD 31 h since Nov 19" ('' without meters). */
export function metersLine(machine, { now, timeZone } = {}) {
  const m = isObj(machine?.meters) ? machine.meters : {};
  const hours = (x) => (finite(x?.hours) ? x.hours : null);
  const control = METERS_LINE_ORDER.filter((k) => hours(m[k]) !== null)
    .map((k) => `${METERS[k].label} ${formatNumber(hours(m[k]))} h${m[k].stale ? ' (not answering)' : ''}`);
  const parts = [];
  if (control.length) parts.push(`${control.join(' · ')} (control)`);
  const hud = HUD_METER_KEYS.find((k) => hours(m[k]) !== null);
  if (hud) {
    const what = hud === 'hud.on' ? '' : ` ${METERS[hud].label.toLowerCase()}`;
    parts.push(`HUD ${formatHours(hours(m[hud]))} h${what}${finite(m[hud].since) ? ` since ${shortDate(m[hud].since, now, { timeZone })}` : ''}`);
  }
  return parts.join(' · ');
}

/** "Counted by the HUD since Nov 19" for a machine whose control gives no hours; null otherwise. */
export function hudCountNote(machine, { now, timeZone } = {}) {
  const m = isObj(machine?.meters) ? machine.meters : {};
  if (CONTROL_METER_KEYS.some((k) => isObj(m[k]))) return null;
  const since = HUD_METER_KEYS.map((k) => m[k]?.since).find(finite);
  return finite(since) ? `Counted by the HUD since ${shortDate(since, now, { timeZone })}` : null;
}

/** "2 due · 1 due soon · 5 need a start", or "Nothing due". */
export function countsText(c) {
  if (!isObj(c)) return '';
  const n = (k) => (finite(c[k]) ? c[k] : 0);
  const parts = [];
  if (n('due')) parts.push(`${n('due')} due`);
  if (n('soon')) parts.push(`${n('soon')} due soon`);
  if (n('start')) parts.push(`${n('start')} need${n('start') === 1 ? 's' : ''} a start`);
  if (n('nohours')) parts.push(`${n('nohours')} not counting`);
  return parts.length ? parts.join(' · ') : 'Nothing due';
}

/**
 * The control meter a "Meter read … h" answer is about: the task's own meter when it is the control's, else the first
 * control meter of its basis the machine has. Null when the option does not apply (not an hours task, no such meter).
 */
export function readingMeter(task, machine) {
  if (task?.kind !== 'interval' || normalizeEvery(task.every)?.unit !== 'hour' || !BASIS_CHAIN[task.basis]) return null;
  const meters = isObj(machine?.meters) ? machine.meters : {};
  const own = task.status?.meter;
  if (own && METERS[own]?.source === 'control' && isObj(meters[own])) return own;
  return BASIS_CHAIN[task.basis].find((k) => METERS[k]?.source === 'control' && isObj(meters[k])) ?? null;
}

/** Where a task's document puts it: related model, general practice, the control's documents, the shop's own. */
export function scopeNote(task) {
  switch (task?.scope) {
    case 'related': return `From the ${str(task.source?.title) ? task.source.title : 'manual of a related model'}: check your own manual.`;
    case 'general': return 'General trade practice, not from the machine’s builder.';
    case 'control': return 'From the control’s documents: it applies to every machine with this control.';
    case 'custom': return 'Added by the shop.';
    default: return null;
  }
}

/** The lines that say where a task's count stands and why (its expanded row). */
export function whyLines(task, machine, { now, timeZone, clock24h } = {}) {
  const s = isObj(task?.status) ? task.status : {};
  const o = { timeZone };
  const meters = isObj(machine?.meters) ? machine.meters : {};
  const out = [];
  if (isObj(s.triggered)) {
    const t = s.triggered;
    out.push(`${[t.code, t.message].filter(str).join(' · ') || 'Its alarm'} came up ${dateTime(t.at, now, { timeZone, clock24h })}.`);
    if (finite(s.deadline)) out.push(`${s.deadline > now ? 'Do it by' : 'It was to be done by'} ${shortDate(s.deadline, now, o)}.`);
    out.push('It stays due until it is marked done.');
    return out;
  }
  switch (stateOf(task)) {
    case 'start': out.push('Not marked done here yet: say when it was last done with Done…, or count it from now.'); break;
    case 'nohours': out.push(`No ${BASIS_LABELS[task?.basis] ?? 'hours'} from this machine yet: it is not linked, or its control has not answered yet.`); break;
    case 'watch': {
      const codes = alarmCodes(task?.alarm);
      out.push(`It comes due when the control raises ${codes.length ? codes.join(' or ') : 'its alarm'}.`);
      if (machine?.alarmCodes === false) out.push('This machine’s connection does not report alarm numbers, so the HUD cannot see this alarm: watch the control.');
      break;
    }
    case 'asneeded': out.push('Listed with its document; it never comes due by itself.'); break;
    case 'off': out.push('Turned off: kept with its history, but it never comes due. Edit turns it on again.'); break;
    default: {
      if (s.unit === 'hour' && finite(s.every)) {
        const m = s.meter ? METERS[s.meter] : null;
        const whose = !m ? 'Hours' : m.source === 'control' ? `The control’s ${m.label.toLowerCase()} hours` : `Hours the HUD counted (${m.label.toLowerCase()})`;
        const used = finite(s.used) ? `${formatHours(s.used)} of ${formatHours(s.every)} h used` : `every ${formatHours(s.every)} h`;
        const left = finite(s.remaining) ? (s.remaining > 0 ? `${formatHours(s.remaining)} h left` : `${formatHours(-s.remaining)} h over`) : null;
        out.push(`${whose}: ${[used, left].filter(Boolean).join(', ')}.`);
        if (finite(s.dueAt) && s.estimated) out.push(`≈ due ${shortDate(s.dueAt, now, o)} at the recent pace.`);
      } else if (s.unit === 'day' && finite(s.dueAt)) {
        out.push(s.dueAt > now ? `Due ${shortDate(s.dueAt, now, o)}, in ${plural(Math.ceil((s.dueAt - now) / DAY), 'day')}.` : `Due since ${shortDate(s.dueAt, now, o)}.`);
      }
      if (s.by === 'orEvery' && normalizeEvery(task?.orEvery)) out.push(`The calendar limit (${formatEvery(task.orEvery)}) comes first.`);
      if (s.hudOnly) {
        const since = s.meter ? meters[s.meter]?.since : null;
        out.push(`Counted by the HUD${finite(since) ? ` since ${shortDate(since, now, o)}` : ''}; time the HUD was off is not counted.`);
      } else if (s.approx && s.meter && METERS[s.meter]) {
        out.push(`No ${BASIS_LABELS[task?.basis] ?? 'hours'} meter: counting ${METERS[s.meter].label.toLowerCase()} hours (due sooner, never later).`);
      }
    }
  }
  return out;
}

/**
 * One log line (GET /api/maintenance/log entry): "Marked done — new filter", "Recorded as done on Nov 9",
 * "Recorded from a meter reading (Operating 21,001 h)", "Alarm came up: BAT · Battery low", "Changed: interval".
 */
export function logText(e, { now, timeZone } = {}) {
  if (!isObj(e)) return '';
  let t;
  if (e.action === 'done' || (e.action === 'start' && e.how === 'start')) {
    if (e.how === 'date' && finite(e.doneAt)) t = `Recorded as done on ${shortDate(e.doneAt, now, { timeZone })}`;
    else if (e.how === 'reading') {
      const r = Object.entries(isObj(e.readings) ? e.readings : {}).filter(([k, v]) => METERS[k] && finite(v)).map(([k, v]) => `${METERS[k].label} ${formatNumber(v)} h`);
      t = `${DONE_WORDS.reading}${r.length ? ` (${r.join(', ')})` : ''}`;
    } else t = DONE_WORDS[e.how] ?? DONE_WORDS.now;
  } else if (e.action === 'triggered') {
    const what = [e.code, e.message].filter(str).join(' · ');
    t = what ? `${LOG_WORDS.triggered}: ${what}` : LOG_WORDS.triggered;
  } else if (e.action === 'edit' && Array.isArray(e.fields) && e.fields.length) {
    t = `${LOG_WORDS.edit}: ${e.fields.map((f) => FIELD_WORDS[f] ?? String(f)).join(', ')}`;
  } else t = LOG_WORDS[e.action] ?? String(e.action ?? '');
  return str(e.note) ? `${t} — ${e.note}` : t;
}

// ---------------------------------------------------------------------------------------------
// Elements shared with the machine drawer (detail.js)
// ---------------------------------------------------------------------------------------------

/** A state pill: word and glyph, outline and ink. */
export function statePill(state) {
  const s = STATE_LABELS[state] ? state : 'ok';
  const p = h('span', `mt-pill mt-${s}`);
  p.append(iconSvg(STATE_ICONS[s], { size: null }), h('span', null, STATE_LABELS[s]));
  return p;
}

/** A link that opens in a new tab; plain text unless `url` is http(s). */
function linkEl(url, label, cls = 'mt-link') {
  const u = safeUrl(url);
  if (!u) return h('span', null, label);
  const a = h('a', cls, label);
  a.href = u;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.append(iconSvg('external', { size: null }));
  return a;
}

/** The row's document: a link ("Manual p. 112") or, with no public copy, the citation as text. */
export function docLinkEl(task) {
  const info = docLinkInfo(task);
  if (!info) return null;
  if (!info.url) {
    const s = h('span', 'mt-doc mt-cite-only', info.label);
    s.title = `${info.title}${info.title ? ' · ' : ''}no public copy from the publisher: cited, not linked`;
    return s;
  }
  const a = linkEl(info.url, info.label, 'mt-doc');
  if (info.title) a.title = info.title;
  return a;
}

/**
 * One task's summary: pill, title, (machine,) progress, document and Done….
 * @param {object} task
 * @param {object} machine
 * @param {{ now: number, timeZone?: string, showMachine?: boolean, expanded?: boolean|null, onToggle?: Function|null,
 *           onDone?: Function|null, focusKey?: string|null }} o  focusKey: marks its buttons so a redraw keeps their focus
 */
export function taskSummary(task, machine, { now, timeZone, showMachine = false, expanded = null, onToggle = null, onDone = null, focusKey = null } = {}) {
  const row = h('div', 'mt-row-main');
  const state = stateOf(task);
  const name = str(task?.title) ? task.title : 'Untitled task';
  let title;
  if (onToggle) {
    title = h('button', 'mt-title', name);
    title.type = 'button';
    title.setAttribute('aria-expanded', String(!!expanded));
    if (focusKey) title.dataset.focus = `title:${focusKey}`;
    title.addEventListener('click', onToggle);
  } else title = h('div', 'mt-title', name);
  const meta = h('div', 'mt-meta');
  if (showMachine && str(machine?.name)) meta.append(h('span', 'mt-mach', machine.name));
  meta.append(h('span', 'mt-progress', progressText(task, { now, timeZone })));
  const doc = docLinkEl(task);
  if (doc) meta.append(doc);
  const act = h('div', 'mt-act');
  if (onDone && state !== 'off') {
    const b = button('Done…', 'btn-small mt-done-btn', 'check');
    b.title = `Mark “${name}” done`;
    if (focusKey) b.dataset.focus = `done:${focusKey}`;
    b.addEventListener('click', onDone);
    act.append(b);
  }
  row.append(statePill(state), title, meta, act);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

/** A modal question; resolves true for `confirm`, false for Cancel or Escape. */
function confirmDialog({ heading, icon = 'oilcan', lines = [], confirm = 'OK' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'token-dialog mt-dialog';
    const form = h('form', 'token-form');
    form.method = 'dialog';
    const h2 = h('h2', null, heading);
    h2.prepend(iconSvg(icon, { size: null }));
    form.append(h2);
    for (const l of lines) form.append(h('p', null, l));
    const row = h('div', 'dialog-actions');
    const no = h('button', 'btn', 'Cancel');
    no.type = 'button';
    const yes = h('button', 'btn btn-primary', confirm);
    yes.type = 'button';
    row.append(no, yes);
    form.append(row);
    dlg.append(form);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* closed */ }
      dlg.remove();
      resolve(v);
    };
    no.addEventListener('click', () => finish(false));
    yes.addEventListener('click', () => finish(true));
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(false); });
    // Escape closes this dialog only, not the drawer behind it
    dlg.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') ev.stopPropagation(); });
    document.body.append(dlg);
    dlg.showModal();
    yes.focus();
  });
}

/**
 * Done… for one task (both drawers). The four answers: done now (the default), done on a date (today or earlier),
 * the control's hour meter read N h at the last service (hours tasks whose machine has that control meter), and
 * "Not sure — count from now" (the default for a task that has no start yet). Resolves the server's answer
 * ({ ok, task, warning? }) once saved, or null when cancelled.
 * @param {object} task  a task of GET /api/maintenance
 * @param {object} machine  its machine (id, name, meters)
 * @param {{ api: object, toast?: Function, getContext?: () => ({ now: number, settings: object }) }} deps
 */
export function openDoneDialog(task, machine, { api, toast = () => {}, getContext } = {}) {
  return new Promise((resolve) => {
    const c = getContext?.() ?? {};
    const tz = typeof c.settings?.display?.timeZone === 'string' && c.settings.display.timeZone ? c.settings.display.timeZone : undefined;
    const now = finite(c.now) ? c.now : Date.now();
    const today = localDateKey(now, tz);
    const title = str(task?.title) ? task.title : 'this task';

    const dlg = document.createElement('dialog');
    dlg.className = 'token-dialog mt-dialog mt-done-dialog';
    const form = h('form', 'token-form mt-done');
    form.method = 'dialog';
    const h2 = h('h2', null, 'Mark done');
    h2.prepend(iconSvg('oilcan', { size: null }));
    const what = h('p', 'mt-done-what');
    what.append(h('strong', null, title));
    if (str(machine?.name)) what.append(h('span', 'muted', ` · ${machine.name}`));
    const interval = task?.interval || describeInterval(task);
    form.append(h2, what);
    if (interval) form.append(h('p', 'muted mt-done-iv', interval));

    const opts = h('div', 'mt-opts');
    opts.setAttribute('role', 'radiogroup');
    opts.setAttribute('aria-label', 'When was it done?');
    const group = nextId('mt-how');
    /** One answer: its radio, its words and any inputs that go with it (typing in them picks the answer). */
    const option = (value, words, extras = []) => {
      const row = h('div', 'mt-opt');
      const radio = h('input');
      radio.type = 'radio';
      radio.name = group;
      radio.value = value;
      radio.id = nextId('mt-opt');
      const lab = h('label', null, words);
      lab.htmlFor = radio.id;
      row.append(radio, lab, ...extras);
      for (const x of extras) for (const input of x.matches?.('input') ? [x] : x.querySelectorAll?.('input') ?? []) {
        input.addEventListener('focus', () => { radio.checked = true; });
        input.addEventListener('input', () => { radio.checked = true; });
      }
      opts.append(row);
      return { row, radio };
    };
    const dateInput = (value, label) => {
      const d = h('input', 'mt-input mt-date');
      d.type = 'date';
      d.max = today;
      if (value) d.value = value;
      d.setAttribute('aria-label', label);
      return d;
    };

    const optNow = option('now', 'Done now');
    const onDate = dateInput(today, 'The date it was done');
    option('date', 'Done on', [onDate]);
    // "Meter read [ ] h at the last service" (the service sticker): hours tasks whose machine has that control meter
    const meterKey = readingMeter(task, machine);
    let readingIn = null;
    let readingDate = null;
    if (meterKey) {
      readingIn = h('input', 'mt-input mt-num mt-reading');
      readingIn.type = 'number';
      readingIn.min = '0';
      readingIn.max = '1000000';
      readingIn.step = 'any';
      readingIn.inputMode = 'decimal';
      readingIn.setAttribute('aria-label', 'Hours on the meter at the last service');
      readingDate = dateInput('', 'The date of that service (optional)');
      const raw = machine?.meters?.[meterKey]?.raw;
      const label = METERS[meterKey].label.toLowerCase();
      const more = h('div', 'mt-opt-sub');
      more.append(h('span', 'muted', 'on'), readingDate, h('span', 'muted', '(optional)'),
        h('div', 'muted small mt-hint', finite(raw)
          ? `The control’s ${label} meter reads ${formatNumber(raw)} h now.`
          : `The hours the control’s ${label} meter showed then.`));
      option('reading', 'Meter read', [readingIn, h('span', null, 'h at the last service'), more]);
    }
    const optStart = option('start', 'Not sure — count from now');
    (stateOf(task) === 'start' ? optStart : optNow).radio.checked = true;

    const note = h('input', 'mt-input mt-note-in');
    note.type = 'text';
    note.maxLength = NOTE_MAX;
    note.placeholder = 'Note (optional): what was done, by whom';
    note.setAttribute('aria-label', 'Note');
    const error = h('p', 'mt-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const actions = h('div', 'dialog-actions');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const save = h('button', 'btn btn-primary', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(opts, note, error, actions);
    dlg.append(form);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* closed */ }
      dlg.remove();
      resolve(v);
    };
    const fail = (msg, focus) => {
      error.textContent = msg;
      error.hidden = false;
      focus?.focus();
    };
    cancel.addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(null); });
    dlg.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') ev.stopPropagation(); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (save.disabled) return;
      error.hidden = true;
      const how = form.querySelector(`input[name="${group}"]:checked`)?.value ?? 'now';
      const body = { how };
      if (how === 'date') {
        if (!onDate.value) { fail('Pick the date it was done.', onDate); return; }
        if (onDate.value > today) { fail('The date cannot be in the future.', onDate); return; }
        body.date = onDate.value;
      }
      if (how === 'reading') {
        const r = Number(readingIn.value);
        if (readingIn.value.trim() === '' || !Number.isFinite(r) || r < 0 || r > 1_000_000) { fail('Type the hours the meter showed at the last service.', readingIn); return; }
        body.reading = r;
        if (readingDate.value) {
          if (readingDate.value > today) { fail('The date cannot be in the future.', readingDate); return; }
          body.date = readingDate.value;
        }
      }
      const n = note.value.trim();
      if (n) body.note = n.slice(0, NOTE_MAX);
      save.disabled = true;
      try {
        const r = await api.maintenance.done(machine.id, task.id, body);
        toast(how === 'start' ? `“${title}” counts from now` : `Marked done: ${title}`, { kind: 'ok' });
        if (str(r?.warning)) toast(r.warning, { kind: 'info', timeoutMs: 12_000 });
        finish(r ?? { ok: true });
      } catch (e) {
        save.disabled = false;
        fail(e?.status === 401 ? 'Changes need the edit token.' : `Not saved: ${e?.message ?? e}`);
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    (stateOf(task) === 'start' ? optStart : optNow).radio.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------------------------

/**
 * @param {HTMLElement} el  drawer container (an <aside>)
 * @param {{ api: object, getContext: () => ({ settings: object, now: number, theme: string, kiosk: boolean }),
 *           getMachines?: () => Array<{ id: string, name: string }>, toast?: Function, onClose?: Function,
 *           readOnly?: () => boolean, onCounts?: (counts: object) => void }} deps
 *   readOnly: no writes (a preview); onCounts: all machines' counts after a load (the top bar badge)
 */
export function createMaintenancePanel(el, deps) {
  const { api, getContext, toast = () => {} } = deps;
  const st = {
    view: 'list', machine: '', data: null, error: null, loading: false,
    expanded: new Set(), openGroups: new Set(), docsOpen: new Set(), editKey: null, editForm: null, logs: new Map(),
    catalog: null, catalogError: null, catalogLoading: false, ticks: new Set(), edits: new Map(), modelPick: null,
    addOpen: false, addForm: null, saving: false,
    /** machines that changed (SSE) while another one was shown: refetched when they are shown */
    behind: new Set(),
  };
  let loadSeq = 0;
  let catalogSeq = 0;
  /** machine id → refetch in flight ({ again } when another event came meanwhile) */
  const machineJobs = new Map();

  el.replaceChildren();
  el.classList.add('drawer', 'maintenance');
  el.hidden = true;
  el.setAttribute('aria-label', 'Maintenance');
  const head = h('header', 'drawer-head plain mt-head');
  const over = h('div', 'mt-over', 'Maintenance');
  const title = h('h2', 'd-name', 'All machines');
  const sub = h('div', 'd-sub');
  const close = button(null, 'btn-icon drawer-close', 'close');
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close maintenance');
  head.append(over, title, sub, close);
  const toolbar = h('div', 'mt-toolbar');
  const filter = h('select', 'runs-select mt-filter');
  filter.setAttribute('aria-label', 'Machine');
  const back = button('Back to the list', 'btn-quiet mt-back', 'chevron');
  const status = h('span', 'muted mt-status');
  toolbar.append(filter, back, status);
  const body = h('div', 'drawer-body mt-body');
  el.append(head, toolbar, body);

  const ctx = () => getContext();
  const clockOpts = () => {
    const d = ctx().settings?.display ?? {};
    return { clock24h: !!d.clock24h, timeZone: typeof d.timeZone === 'string' && d.timeZone ? d.timeZone : undefined };
  };
  const fmtOpts = () => ({ now: ctx().now, ...clockOpts() });
  const readOnly = () => !!ctx().kiosk || !!deps.readOnly?.();
  const canWrite = () => !readOnly() && st.data?.enabled !== false && st.data?.available !== false;
  const machinesOf = () => (Array.isArray(st.data?.machines) ? st.data.machines.filter((m) => isObj(m) && typeof m.id === 'string') : []);
  const machineById = (id) => machinesOf().find((m) => m.id === id) ?? null;
  const machineName = (id) => machineById(id)?.name || (deps.getMachines?.() ?? []).find((m) => m?.id === id)?.name || id || '';

  // ---- loading ---------------------------------------------------------------------------

  async function load() {
    const seq = ++loadSeq;
    st.loading = true;
    renderHead();
    try {
      const d = await api.maintenance.get();
      if (seq !== loadSeq) return;
      st.data = isObj(d) ? d : null;
      st.error = null;
      st.behind.clear();
      if (isObj(d?.counts)) deps.onCounts?.(d.counts);
    } catch (e) {
      if (seq !== loadSeq) return;
      st.error = e;
    } finally {
      if (seq === loadSeq) { st.loading = false; render(); }
    }
  }

  /** Refetch one machine (after a write or an SSE event) and put it in place; the counts follow. */
  async function refreshMachine(id) {
    if (!Array.isArray(st.data?.machines) || typeof id !== 'string') { load(); return; }
    const running = machineJobs.get(id);
    if (running) { running.again = true; return; }
    const job = { again: false };
    machineJobs.set(id, job);
    let reload = false;
    try {
      do {
        job.again = false;
        const seq = loadSeq;
        const d = await api.maintenance.get({ machine: id });
        const m = Array.isArray(d?.machines) ? d.machines.find((x) => isObj(x) && x.id === id) : null;
        if (seq !== loadSeq || !Array.isArray(st.data?.machines)) break; // a full load started meanwhile: it has newer data
        const i = st.data.machines.findIndex((x) => isObj(x) && x.id === id);
        if (!m || i < 0) { reload = true; break; } // the machines changed (layout): load them all
        st.data.machines[i] = m;
        st.data.counts = sumCounts(st.data.machines);
        deps.onCounts?.(st.data.counts);
      } while (job.again);
    } catch { /* the next event or the minute refresh tries again */ } finally {
      machineJobs.delete(id);
    }
    if (reload) { load(); return; }
    // its log changed too: reload it for an open row, else forget it (the next row opened fetches it)
    if ([...st.expanded].some((k) => k.startsWith(`${id}/`))) loadLog(id, true); else st.logs.delete(id);
    if (!el.hidden && st.view === 'list') render();
  }

  function sumCounts(machines) {
    const out = {};
    for (const m of machines) for (const [k, v] of Object.entries(isObj(m?.counts) ? m.counts : {})) if (finite(v)) out[k] = (out[k] ?? 0) + v;
    return out;
  }

  async function loadLog(id, force = false) {
    const cur = st.logs.get(id);
    if (cur?.loading) { if (force) cur.again = true; return; }
    if (!force && cur?.entries && Date.now() - cur.at < 60_000) return;
    const rec = { entries: cur?.entries ?? null, error: null, loading: true, at: cur?.at ?? 0, again: false };
    st.logs.set(id, rec);
    try {
      const r = await api.maintenance.log({ machine: id, limit: 500 });
      rec.entries = Array.isArray(r?.entries) ? r.entries.filter(isObj) : [];
    } catch (e) { rec.error = e; }
    rec.loading = false;
    rec.at = Date.now();
    if (!el.hidden && st.view === 'list') render();
    if (rec.again) loadLog(id, true);
  }

  // ---- actions ---------------------------------------------------------------------------

  async function markDone(task, machine) {
    const r = await openDoneDialog(task, machine, { api, toast, getContext });
    if (r) refreshMachine(machine.id);
  }

  async function startAll(m, n) {
    const yes = await confirmDialog({
      heading: 'Count all from now?', icon: 'hourglass', confirm: 'Count from now',
      lines: [
        `${plural(n, 'task')} on ${m.name || m.id} ${n === 1 ? 'has' : 'have'} no start yet. ${n === 1 ? 'It counts' : 'They count'} from now.`,
        'When you know when one was last done, use its Done… instead: its next due date is then right.',
      ],
    });
    if (!yes) return;
    try {
      const r = await api.maintenance.start(m.id);
      const k = countOf(r?.started);
      toast(k ? `${plural(k, 'task')} on ${m.name || m.id} count${k === 1 ? 's' : ''} from now` : 'Nothing needed a start', { kind: 'ok' });
    } catch (e) {
      toast(`Could not start the count: ${e.message}`, { kind: 'error' });
    }
    refreshMachine(m.id);
  }

  // ---- rendering: the list ---------------------------------------------------------------

  function syncFilter() {
    const list = st.data
      ? machinesOf().map((m) => ({ id: m.id, name: m.name || m.id }))
      : (deps.getMachines?.() ?? []).filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, name: m.name || m.id }));
    if (st.machine && !list.some((m) => m.id === st.machine)) list.push({ id: st.machine, name: machineName(st.machine) });
    const sig = list.map((m) => `${m.id}\u0001${m.name}`).join('\u0000');
    if (filter.dataset.sig !== sig) {
      filter.dataset.sig = sig;
      filter.replaceChildren(new Option('All machines', ''), ...list.map((m) => new Option(m.name, m.id)));
    }
    filter.value = st.machine;
  }

  function renderHead() {
    syncFilter();
    const setup = st.view === 'setup';
    over.textContent = setup ? 'Maintenance · Set up' : 'Maintenance';
    title.textContent = st.machine ? machineName(st.machine) : 'All machines';
    sub.textContent = setup
      ? 'Tick what this machine needs and adjust the intervals. Nothing changes until you save.'
      : st.data && st.data.enabled !== false ? countsText(st.machine ? machineById(st.machine)?.counts : st.data.counts) : '';
    filter.hidden = setup;
    back.hidden = !setup;
    status.textContent = (setup ? st.catalogLoading : st.loading) ? 'Loading…' : '';
  }

  function render() {
    if (el.hidden) return;
    if (st.view === 'setup') { renderHead(); return; } // the setup view redraws itself (it holds the ticks and edits)
    renderHead();
    const parts = [];
    const d = st.data;
    const o = fmtOpts();
    if (!d) {
      parts.push(st.error ? problem(st.error, load) : h('p', 'muted mt-msg', 'Loading…'));
    } else if (d.enabled === false) {
      parts.push(h('p', 'muted mt-msg', 'Maintenance is turned off on this HUD (settings: maintenance.enabled).'));
    } else {
      if (st.error) parts.push(h('p', 'error', `Could not refresh: ${st.error.message}`));
      if (d.available === false) parts.push(h('p', 'mt-notice', 'The maintenance plan on the HUD PC could not be read, so nothing can be changed here until it is fixed. The file is left as it was; the HUD’s log says why.'));
      const all = machinesOf();
      const shown = st.machine ? all.filter((m) => m.id === st.machine) : all;
      if (st.machine && !shown.length) parts.push(h('p', 'muted mt-msg', `${machineName(st.machine)} is not on the active layout.`));
      if (st.machine && shown.length) parts.push(machineHeader(shown[0], o));
      const rows = [];
      for (const m of shown) {
        for (const t of Array.isArray(m.tasks) ? m.tasks : []) if (isObj(t) && typeof t.id === 'string') rows.push({ task: t, machine: m, status: t.status, title: t.title });
      }
      rows.sort(compareTaskRows);
      for (const g of GROUPS) {
        const list = rows.filter((r) => stateOf(r.task) === g.state);
        if (list.length) parts.push(groupSection(g, list, o));
      }
      if (shown.length && !rows.length) {
        parts.push(h('p', 'muted mt-msg', st.machine
          ? 'No maintenance tasks for this machine yet. Set up lists the tasks its builder publishes; the shop can add its own too.'
          : 'No maintenance tasks yet. Set up a machine to list the tasks its builder publishes.'));
      }
      if (!st.machine) { const ns = notSetUp(all); if (ns) parts.push(ns); }
    }
    swapBody(parts);
  }

  /**
   * Swap the body's content, keeping focus, the caret and the scroll position: forms survive as the same elements, and
   * a redrawn control (marked data-focus) takes the focus of the one it replaces.
   */
  function swapBody(parts) {
    const active = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.dataset.focus ?? null;
    let sel = null;
    try { if (active && typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd]; } catch { /* no caret */ }
    const scroll = body.scrollTop;
    body.replaceChildren(...parts);
    body.scrollTop = scroll;
    if (active && active.isConnected && document.activeElement !== active) {
      active.focus({ preventScroll: true });
      if (sel) { try { active.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
    } else if (active && !active.isConnected && focusKey) {
      body.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    }
  }

  function problem(e, retry) {
    const box = h('div', 'prog-problem mt-problem');
    const msg = e?.status === 404 ? 'This HUD server has no maintenance board.'
      : e?.code === 'MAINTENANCE_DISABLED' ? 'Maintenance is turned off on this HUD.'
        : `Could not load maintenance: ${e?.message ?? e}`;
    box.append(h('p', null, msg));
    if (retry && e?.status !== 404) {
      const row = h('div', 'dialog-actions');
      const b = button('Try again', null, 'refresh');
      b.addEventListener('click', () => retry());
      row.append(b);
      box.append(row);
    }
    return box;
  }

  function notSetUp(all) {
    const list = all.filter((m) => !m.setUp);
    if (!list.length || !canWrite()) return null;
    const p = h('div', 'mt-notset');
    p.append(h('span', 'muted', 'Not set up yet:'));
    for (const m of list) {
      const b = button(m.name || m.id, 'btn-small btn-quiet', 'sliders');
      b.title = `Set up maintenance for ${m.name || m.id}`;
      b.addEventListener('click', () => showSetup(m.id));
      p.append(b);
    }
    return p;
  }

  function groupSection(g, list, o) {
    const sec = h('section', `mt-group mt-group-${g.state}`);
    sec.dataset.state = g.state;
    const open = g.open || st.openGroups.has(g.state);
    const hd = h('h3', 'mt-group-head');
    if (g.open) hd.append(h('span', null, STATE_LABELS[g.state]));
    else {
      const t = h('button', 'mt-group-toggle');
      t.type = 'button';
      t.dataset.focus = `group:${g.state}`;
      t.setAttribute('aria-expanded', String(open));
      t.append(iconSvg('chevron', { size: null }), h('span', null, STATE_LABELS[g.state]));
      t.addEventListener('click', () => {
        if (st.openGroups.has(g.state)) st.openGroups.delete(g.state); else st.openGroups.add(g.state);
        render();
      });
      hd.append(t);
    }
    hd.append(h('span', 'count', String(list.length)));
    sec.append(hd);
    if (open) {
      const ul = h('ul', 'mt-list');
      for (const r of list) ul.append(taskRow(r, o));
      sec.append(ul);
    }
    return sec;
  }

  function taskRow({ task, machine }, o) {
    const key = `${machine.id}/${task.id}`;
    const open = st.expanded.has(key);
    const li = h('li', `mt-row${open ? ' open' : ''}`);
    li.dataset.task = task.id;
    li.dataset.machine = machine.id;
    li.append(taskSummary(task, machine, {
      focusKey: key,
      ...o,
      showMachine: !st.machine,
      expanded: open,
      onToggle: () => {
        if (st.expanded.has(key)) {
          st.expanded.delete(key);
          if (st.editKey === key) { st.editKey = null; st.editForm = null; }
        } else {
          st.expanded.add(key);
          loadLog(machine.id);
        }
        render();
      },
      onDone: canWrite() ? () => markDone(task, machine) : null,
    }));
    if (open) li.append(rowDetails(task, machine, key, o));
    return li;
  }

  function kv(pairs) {
    const d = h('dl', 'kv mt-kv');
    for (const [k, v] of pairs) {
      if (v === null || v === undefined || v === '') continue;
      const dd = h('dd');
      if (v instanceof Node) dd.append(v); else dd.textContent = String(v);
      d.append(h('dt', null, k), dd);
    }
    return d;
  }

  function rowDetails(task, machine, key, o) {
    const box = h('div', 'mt-more');
    const src = isObj(task.source) ? task.source : null;
    if (str(task.action)) box.append(h('p', 'mt-action', task.action));
    const pairs = [['Interval', task.interval || describeInterval(task)]];
    if (str(src?.asStated)) pairs.push(['The manual says', src.asStated]);
    if (str(task.ifEquipped)) pairs.push(['If equipped', task.ifEquipped]);
    const why = whyLines(task, machine, o);
    if (why.length) {
      const f = document.createDocumentFragment();
      for (const l of why) f.append(h('div', null, l));
      pairs.push(['Progress', f]);
    }
    const last = h('span', 'mt-last', lastDoneText(task, o));
    pairs.push(['Last done', last]);
    if (safeUrl(task.link)) pairs.push(['Link', linkEl(task.link, task.link)]);
    box.append(kv(pairs));
    if (src) box.append(quoteBlock(src));
    const scope = scopeNote(task);
    if (scope) box.append(h('p', 'note mt-scope', scope));
    box.append(logBlock(machine.id, task.id, o));
    if (canWrite()) {
      if (st.editKey === key) box.append(editForm(task, machine, key));
      else {
        const b = button('Edit…', 'btn-small btn-quiet mt-edit-btn', 'pencil');
        b.dataset.focus = `edit:${key}`;
        b.addEventListener('click', () => { st.editKey = key; st.editForm = null; render(); });
        box.append(b);
      }
    }
    return box;
  }

  function quoteBlock(src) {
    const fig = h('figure', 'mt-quote');
    if (str(src.quote)) fig.append(h('blockquote', null, `“${src.quote}”`));
    const cap = h('figcaption', 'mt-cite');
    cap.append(h('span', null, [src.publisher, src.title, src.number, src.edition, src.locator].filter(str).join(' · ')));
    if (str(src.host)) cap.append(h('span', null, ` · copy hosted by ${src.host}`));
    const url = safeUrl(src.url);
    if (url) cap.append(h('span', null, ' · '), linkEl(url, 'Open the document'));
    else cap.append(h('span', null, ' · no public copy from the publisher: cited, not linked'));
    fig.append(cap);
    if (str(src.appliesTo)) fig.append(h('div', 'mt-cite', `Applies to: ${src.appliesTo}`));
    if (str(src.note)) fig.append(h('div', 'mt-cite', src.note));
    if (str(src.checked)) fig.append(h('div', 'mt-cite', `Checked against the document on ${src.checked}`));
    return fig;
  }

  function logBlock(machineId, taskId, o) {
    const wrap = h('div', 'mt-logwrap');
    wrap.append(h('h4', 'mt-h4', 'Recent history'));
    const lg = st.logs.get(machineId);
    if (!lg || (!lg.entries && lg.loading)) { wrap.append(h('p', 'muted small', 'Loading…')); return wrap; }
    if (!lg.entries) { wrap.append(h('p', 'muted small', 'History unavailable')); return wrap; }
    const list = lg.entries.filter((e) => e.taskId === taskId).slice(0, 5);
    if (!list.length) { wrap.append(h('p', 'muted small', 'Nothing yet.')); return wrap; }
    const ul = h('ul', 'mt-log');
    for (const e of list) ul.append(h('li', null, `${dateTime(e.at, o.now, o)} · ${logText(e, o)}`));
    wrap.append(ul);
    return wrap;
  }

  function machineHeader(m, o) {
    const box = h('section', 'mt-machine');
    const model = h('p', 'mt-model');
    if (str(m.model?.label)) model.append(h('strong', null, m.model.label));
    else model.append(h('span', 'muted', str(m.suggested?.label) ? `Model not chosen yet · suggested: ${m.suggested.label}` : 'Model not chosen yet'));
    if (str(m.control?.label)) model.append(h('span', 'muted', ` · ${m.control.label}`));
    box.append(model);
    if (str(m.note)) box.append(h('p', 'mt-note', m.note));
    if (isObj(m.service)) {
      const p = h('p', 'mt-service');
      p.append(h('span', 'muted', 'Service: '), safeUrl(m.service.url) ? linkEl(m.service.url, m.service.title || 'Service page') : h('span', null, m.service.title || ''));
      if (str(m.service.publisher)) p.append(h('span', 'muted', ` · ${m.service.publisher}`));
      box.append(p);
    }
    const facts = (Array.isArray(m.facts) ? m.facts : []).filter((f) => isObj(f) && str(f.label) && f.value !== null && f.value !== undefined);
    if (facts.length) {
      box.append(kv(facts.map((f) => {
        const frag = document.createDocumentFragment();
        frag.append(h('span', null, String(f.value)));
        if (str(f.source)) frag.append(h('span', 'muted small', ` · ${f.source}`));
        return [f.label, frag];
      })));
    }
    const meters = metersLine(m, o);
    box.append(h('p', 'mt-meters', meters ? `Hours: ${meters}` : 'No hour meters yet: hours tasks count once the machine is linked and reporting.'));
    const tasks = (Array.isArray(m.tasks) ? m.tasks : []).filter(isObj);
    if (m.alarmCodes === false && tasks.some((t) => alarmCodes(t.alarm).length)) {
      box.append(h('p', 'note', 'This machine’s connection does not report alarm numbers, so tasks on an alarm cannot come due by themselves.'));
    }
    if (m.setUp && countOf(m.newSuggestions) > 0) box.append(h('p', 'mt-new', `${plural(countOf(m.newSuggestions), 'new suggestion')} in Set up`));
    if (canWrite()) {
      const row = h('div', 'mt-buttons');
      const setup = button('Set up…', 'btn-accent mt-setup-btn', 'sliders');
      setup.title = 'Choose the model and the tasks from its documents; add the shop’s own';
      setup.addEventListener('click', () => showSetup(m.id));
      row.append(setup);
      const starts = countOf(m.counts?.start) || tasks.filter((t) => stateOf(t) === 'start').length;
      if (starts > 0) {
        const b = button('Count all from now', 'mt-start-btn', 'hourglass');
        b.title = 'Every task without a start counts from now';
        b.addEventListener('click', () => startAll(m, starts));
        row.append(b);
      }
      box.append(row);
    }
    const docs = (Array.isArray(m.documents) ? m.documents : []).filter(isObj);
    if (docs.length) box.append(documentsBlock(m.id, docs));
    return box;
  }

  function documentsBlock(id, docs) {
    const det = h('details', 'mt-docs');
    det.open = st.docsOpen.has(id);
    det.addEventListener('toggle', () => { if (det.open) st.docsOpen.add(id); else st.docsOpen.delete(id); });
    det.append(h('summary', null, `Documents (${docs.length})`));
    const ul = h('ul', 'mt-doclist');
    for (const d of docs) {
      const li = h('li');
      const url = safeUrl(d.url);
      li.append(url ? linkEl(url, d.title || 'Document') : h('strong', null, d.title || 'Document'));
      const meta = [d.publisher, d.number, d.edition, str(d.host) ? `copy hosted by ${d.host}` : null, url ? null : 'cited, not linked'].filter(str).join(' · ');
      if (meta) li.append(h('div', 'muted small', meta));
      if (str(d.appliesTo)) li.append(h('div', 'muted small', `Applies to: ${d.appliesTo}`));
      if (str(d.note)) li.append(h('div', 'muted small', d.note));
      ul.append(li);
    }
    det.append(ul);
    return det;
  }

  // ---- forms -----------------------------------------------------------------------------

  function field(label, control) {
    const f = h('div', 'mt-field');
    f.append(h('span', 'mt-field-label', label), control);
    return f;
  }
  function textInput(value, { type = 'text', maxLength, label, placeholder } = {}) {
    const i = h('input', 'mt-input');
    i.type = type;
    if (maxLength) i.maxLength = maxLength;
    if (placeholder) i.placeholder = placeholder;
    i.value = value ?? '';
    if (label) i.setAttribute('aria-label', label);
    return i;
  }
  function numInput(value, label) {
    const i = h('input', 'mt-input mt-num');
    i.type = 'number';
    i.min = '1';
    i.step = '1';
    i.inputMode = 'numeric';
    i.value = value === null || value === undefined ? '' : String(value);
    i.setAttribute('aria-label', label);
    return i;
  }
  function select(options, value, label) {
    const s = h('select', 'mt-input mt-select');
    for (const [v, text] of options) s.append(new Option(text, v));
    s.value = value;
    s.setAttribute('aria-label', label);
    return s;
  }

  /** A whole number of `unit`s in range, or the message to show. */
  function readEvery(text, unit, what = 'The interval') {
    const n = Number(String(text ?? '').trim());
    const max = INTERVAL_MAX[unit];
    if (!MAINT_UNITS.includes(unit) || String(text ?? '').trim() === '' || !Number.isInteger(n) || n < 1 || n > max) {
      return { ok: false, message: `${what} must be a whole number from 1 to ${formatNumber(max ?? 1)} ${UNIT_WORDS[unit] ?? ''}`.trim() };
    }
    return { ok: true, value: { value: n, unit } };
  }
  const sameEvery = (a, b) => {
    const x = normalizeEvery(a);
    const y = normalizeEvery(b);
    return (x?.value ?? null) === (y?.value ?? null) && (x?.unit ?? null) === (y?.unit ?? null);
  };

  /**
   * The interval inputs of a task: every [n] [unit] (of [which] hours) [or every [n] [calendar unit]] for a schedule,
   * the codes [and "within"] for an alarm. read() → { ok, value: { every, basis, orEvery } | { alarm } | {} }.
   */
  function intervalInputs(init = {}) {
    let kind = init.kind ?? 'interval';
    const box = h('div', 'mt-iv');
    const every = normalizeEvery(init.every);
    const evVal = numInput(every?.value ?? '', 'Interval');
    const evUnit = select(MAINT_UNITS.map((u) => [u, UNIT_WORDS[u]]), every?.unit ?? 'hour', 'Interval unit');
    const basisSel = select(METER_BASES.map((b) => [b, BASIS_LABELS[b]]), METER_BASES.includes(init.basis) ? init.basis : 'operating', 'Which hours');
    const basisPart = h('span', 'mt-iv-part');
    basisPart.append(h('span', null, 'of'), basisSel);
    const evRow = h('div', 'mt-iv-row');
    evRow.append(h('span', null, 'Every'), evVal, evUnit, basisPart);
    const orEvery = normalizeEvery(init.orEvery);
    const orVal = numInput(orEvery?.value ?? '', 'Second limit (optional)');
    const orUnit = select(CALENDAR_UNITS.map((u) => [u, UNIT_WORDS[u]]), orEvery?.unit ?? 'year', 'Second limit unit');
    const orRow = h('div', 'mt-iv-row');
    orRow.append(h('span', null, 'or every'), orVal, orUnit, h('span', 'muted small', 'whichever comes first (optional)'));
    const codes = textInput(alarmCodes(init.alarm).join(', '), { label: 'Alarm codes', placeholder: 'e.g. BAT, DS0307' });
    const alRow = h('div', 'mt-iv-row');
    alRow.append(h('span', null, 'Alarm codes'), codes);
    const within = normalizeEvery(init.alarm?.within);
    const wVal = numInput(within?.value ?? '', 'Do it within (optional)');
    const wUnit = select(CALENDAR_UNITS.map((u) => [u, UNIT_WORDS[u]]), within?.unit ?? 'week', 'Within unit');
    const wRow = h('div', 'mt-iv-row');
    wRow.append(h('span', null, 'do it within'), wVal, wUnit, h('span', 'muted small', '(optional)'));
    box.append(evRow, orRow, alRow, wRow);
    const sync = () => {
      const hours = evUnit.value === 'hour';
      evRow.hidden = kind !== 'interval';
      basisPart.hidden = !hours;
      orRow.hidden = kind !== 'interval' || !hours;
      alRow.hidden = kind !== 'alarm';
      wRow.hidden = kind !== 'alarm';
    };
    evUnit.addEventListener('change', sync);
    sync();
    return {
      el: box,
      setKind(k) { kind = k; sync(); },
      read() {
        if (kind === 'interval') {
          const e = readEvery(evVal.value, evUnit.value);
          if (!e.ok) { evVal.focus(); return e; }
          const hours = e.value.unit === 'hour';
          let second = null;
          if (hours && orVal.value.trim() !== '') {
            const o = readEvery(orVal.value, orUnit.value, 'The second limit');
            if (!o.ok) { orVal.focus(); return o; }
            second = o.value;
          }
          return { ok: true, value: { every: e.value, basis: hours ? basisSel.value : 'calendar', orEvery: second } };
        }
        if (kind === 'alarm') {
          const list = [...new Set(codes.value.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
          if (!list.length || list.length > CODES_MAX) { codes.focus(); return { ok: false, message: `List 1 to ${CODES_MAX} alarm codes, e.g. BAT, DS0307` }; }
          let w = null;
          if (wVal.value.trim() !== '') {
            const r = readEvery(wVal.value, wUnit.value, '“Within”');
            if (!r.ok) { wVal.focus(); return r; }
            w = r.value;
          }
          return { ok: true, value: { alarm: { codes: list, within: w } } };
        }
        return { ok: true, value: {} };
      },
    };
  }

  /** The fields of a task an Edit changes (only those; a catalog alarm's message rules stay unless its codes change). */
  function intervalChanges(task, v) {
    const out = {};
    if (task.kind === 'interval') {
      if (!sameEvery(task.every, v.every)) out.every = v.every;
      if ((task.basis ?? null) !== v.basis) out.basis = v.basis;
      if (!sameEvery(task.orEvery, v.orEvery)) out.orEvery = v.orEvery;
    } else if (task.kind === 'alarm' && v.alarm) {
      const before = [...alarmCodes(task.alarm)].sort().join(',');
      const after = [...v.alarm.codes].sort().join(',');
      if (before !== after || !sameEvery(task.alarm?.within, v.alarm.within)) out.alarm = v.alarm;
    }
    return out;
  }

  /** Edit (title, interval, link, on/off, delete); kept across re-renders so typing survives live updates. */
  function editForm(task, machine, key) {
    if (st.editForm && st.editKey === key) return st.editForm;
    const f = h('form', 'mt-form mt-edit');
    f.append(h('h4', 'mt-h4', 'Edit this task'));
    const titleIn = textInput(task.title ?? '', { maxLength: TITLE_MAX, label: 'Title' });
    f.append(field('Title', titleIn));
    const iv = intervalInputs(task);
    if (task.kind === 'interval' || task.kind === 'alarm') f.append(field(task.kind === 'alarm' ? 'Alarm' : 'Interval', iv.el));
    const linkIn = textInput(task.link ?? '', { type: 'url', maxLength: LINK_MAX, label: 'Link', placeholder: 'https://… (optional)' });
    f.append(field('Link', linkIn));
    const onLab = h('label', 'check mt-check');
    const on = h('input');
    on.type = 'checkbox';
    on.checked = task.enabled !== false;
    onLab.append(on, h('span', null, 'On: it counts and comes due (off keeps it, with its history)'));
    f.append(onLab);
    const actions = h('div', 'dialog-actions mt-edit-actions');
    const del = button('Delete…', 'btn-quiet mt-delete', 'trash');
    const cancel = button('Cancel', null);
    const save = h('button', 'btn btn-primary', 'Save');
    save.type = 'submit';
    actions.append(del, cancel, save);
    f.append(actions);
    const closeForm = () => { st.editKey = null; st.editForm = null; render(); };
    cancel.addEventListener('click', closeForm);
    f.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeForm(); } });
    del.addEventListener('click', async () => {
      const yes = await confirmDialog({
        heading: `Delete “${task.title}”?`, icon: 'trash', confirm: 'Delete',
        lines: [`It leaves ${machine.name || machine.id}’s list; the log keeps what was done.`, 'To stop it coming due but keep it, turn it off instead.'],
      });
      if (!yes) return;
      try {
        await api.maintenance.removeTask(machine.id, task.id);
        toast(`Deleted “${task.title}”`, { kind: 'ok' });
        st.editKey = null;
        st.editForm = null;
        st.expanded.delete(key);
        refreshMachine(machine.id);
      } catch (e) { toast(`Could not delete: ${e.message}`, { kind: 'error' }); }
    });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const changes = {};
      const t = titleIn.value.trim();
      if (!t) { toast('The title cannot be empty', { kind: 'error' }); titleIn.focus(); return; }
      if (t !== task.title) changes.title = t;
      if (task.kind === 'interval' || task.kind === 'alarm') {
        const r = iv.read();
        if (!r.ok) { toast(r.message, { kind: 'error' }); return; }
        Object.assign(changes, intervalChanges(task, r.value));
      }
      const l = linkIn.value.trim();
      if (l !== (task.link ?? '')) {
        if (l && !safeUrl(l)) { toast('The link must be an http:// or https:// address', { kind: 'error' }); linkIn.focus(); return; }
        changes.link = l || null;
      }
      if (on.checked !== (task.enabled !== false)) changes.enabled = on.checked;
      if (!Object.keys(changes).length) { closeForm(); return; }
      save.disabled = true;
      try {
        await api.maintenance.editTask(machine.id, task.id, changes);
        toast(`Saved “${t}”`, { kind: 'ok' });
        st.editKey = null;
        st.editForm = null;
        refreshMachine(machine.id);
      } catch (e) {
        toast(`Could not save: ${e.message}`, { kind: 'error', timeoutMs: 8000 });
      } finally {
        save.disabled = false;
        render();
      }
    });
    st.editForm = f;
    requestAnimationFrame(() => titleIn.focus({ preventScroll: true }));
    return f;
  }

  // ---- Set up ----------------------------------------------------------------------------

  function showSetup(id) {
    if (readOnly() || !id) return;
    st.machine = id;
    st.view = 'setup';
    st.catalog = null;
    st.catalogError = null;
    st.ticks = new Set();
    st.edits = new Map();
    st.modelPick = null;
    st.addOpen = false;
    st.addForm = null;
    st.editKey = null;
    st.editForm = null;
    renderSetup();
    body.scrollTop = 0;
    loadCatalog();
  }

  function showList() {
    st.view = 'list';
    st.catalog = null;
    st.addOpen = false;
    st.addForm = null;
    render();
    body.scrollTop = 0;
    load();
  }

  async function loadCatalog(model) {
    const seq = ++catalogSeq;
    const id = st.machine;
    st.catalogLoading = true;
    renderSetup();
    try {
      const c = await api.maintenance.catalog(id, { model });
      if (seq !== catalogSeq || st.view !== 'setup' || st.machine !== id) return;
      st.catalog = isObj(c) ? c : null;
      st.catalogError = null;
      st.ticks = new Set((Array.isArray(st.catalog?.entries) ? st.catalog.entries : []).filter((e) => isObj(e) && e.preChecked).map((e) => e.id));
      st.edits = new Map();
    } catch (e) {
      if (seq !== catalogSeq) return;
      st.catalogError = e;
    } finally {
      if (seq === catalogSeq) { st.catalogLoading = false; renderSetup(); }
    }
  }

  const entriesOf = (c) => (Array.isArray(c?.entries) ? c.entries.filter((e) => isObj(e) && typeof e.id === 'string') : []);
  /** The checklist: the catalog's entries ("None of these" shows only a no-model answer's, never another model's). */
  const setupEntries = () => (st.modelPick === '' && st.catalog?.model ? [] : entriesOf(st.catalog));

  function renderSetup() {
    if (el.hidden || st.view !== 'setup') return;
    renderHead();
    const parts = [];
    const c = st.catalog;
    if (st.catalogError) parts.push(problem(st.catalogError, () => loadCatalog(st.modelPick ?? undefined)));
    else if (!c) parts.push(h('p', 'muted mt-msg', 'Loading the catalog…'));
    else {
      const wrap = h('div', 'mt-setup');
      if (str(c.about)) wrap.append(h('p', 'muted mt-about', c.about));
      const none = st.modelPick === '';
      const pick = h('select', 'mt-input mt-model-pick');
      pick.setAttribute('aria-label', 'Model');
      pick.append(new Option(c.model || none ? 'None of these' : 'Choose the model…', ''));
      for (const mo of (Array.isArray(c.models) ? c.models : []).filter((x) => isObj(x) && typeof x.id === 'string')) {
        pick.append(new Option(`${mo.label ?? mo.id}${mo.id === c.suggested ? ' (suggested)' : ''}`, mo.id));
      }
      pick.value = none ? '' : (c.model ?? '');
      pick.disabled = st.catalogLoading || st.saving;
      // '' asks the catalog for no model: only the control's own tasks (when the HUD knows the control)
      pick.addEventListener('change', () => { st.modelPick = pick.value; loadCatalog(pick.value); });
      wrap.append(field('Model', pick));
      if (str(c.control?.label)) wrap.append(h('p', 'muted small', `Control: ${c.control.label}`));
      if (!none) {
        if (str(c.note)) wrap.append(h('p', 'mt-note', c.note));
        if (isObj(c.service) && safeUrl(c.service.url)) {
          const p = h('p', 'mt-service');
          p.append(h('span', 'muted', 'Service: '), linkEl(c.service.url, c.service.title || 'Service page'));
          if (str(c.service.publisher)) p.append(h('span', 'muted', ` · ${c.service.publisher}`));
          wrap.append(p);
        }
      }
      const entries = setupEntries();
      if (none) wrap.append(h('p', 'note', entries.length ? 'No model: only the control’s tasks are offered.' : 'No model: no tasks from the catalog. Add the shop’s own tasks below.'));
      if (!entries.length) {
        if (!none) wrap.append(h('p', 'note', c.model ? 'The catalog has no tasks for this model yet. Add the shop’s own below.' : 'Pick the model to see the tasks its builder publishes.'));
      } else {
        const reviewed = new Set(Array.isArray(c.reviewed) ? c.reviewed : []);
        wrap.append(h('h3', 'mt-h3', `Tasks from the documents (${entries.length})`));
        const ul = h('ul', 'mt-entries');
        for (const e of entries) ul.append(entryRow(e, reviewed));
        wrap.append(ul);
      }
      const saveRow = h('div', 'mt-save-row');
      const save = button(st.saving ? 'Saving…' : 'Save', 'btn-primary mt-save', 'check');
      save.disabled = st.saving || st.catalogLoading;
      save.addEventListener('click', () => saveSetup());
      saveRow.append(save, h('span', 'muted small', 'Ticked tasks are added or turned on; unticked ones are turned off and kept. The shop’s own tasks are not changed.'));
      wrap.append(saveRow);
      wrap.append(h('h3', 'mt-h3', 'The shop’s own tasks'));
      if (st.addOpen) wrap.append(addTaskForm());
      else {
        const add = button('Add a task…', 'btn-quiet mt-add-btn', 'plus');
        add.addEventListener('click', () => { st.addOpen = true; renderSetup(); st.addForm?.querySelector('input')?.focus(); });
        wrap.append(add);
      }
      parts.push(wrap);
    }
    swapBody(parts);
  }

  function entryRow(e, reviewed) {
    const li = h('li', `mt-entry${st.ticks.has(e.id) ? ' on' : ''}`);
    li.dataset.entry = e.id;
    const box = h('input', 'mt-tick');
    box.type = 'checkbox';
    box.id = nextId('mt-entry');
    box.checked = st.ticks.has(e.id);
    box.addEventListener('change', () => {
      if (box.checked) st.ticks.add(e.id); else st.ticks.delete(e.id);
      li.classList.toggle('on', box.checked);
    });
    const main = h('div', 'mt-entry-main');
    const top = h('div', 'mt-entry-top');
    const lab = h('label', 'mt-entry-title', e.title || e.id);
    lab.htmlFor = box.id;
    top.append(lab);
    if (e.added && e.enabled !== false) top.append(h('span', 'mt-tag', 'On the list'));
    else if (e.added) top.append(h('span', 'mt-tag', 'Turned off'));
    else if (!reviewed.has(e.id)) top.append(h('span', 'mt-tag mt-tag-new', 'New'));
    main.append(top, entryInterval(e));
    if (str(e.action)) {
      const a = h('p', 'muted small mt-entry-action', truncate(e.action, 220));
      if (e.action.length > 220) a.title = e.action;
      main.append(a);
    }
    const scope = scopeNote(e);
    if (scope) main.append(h('p', 'note mt-scope', scope));
    if (str(e.ifEquipped)) main.append(h('p', 'note', `If equipped: ${e.ifEquipped}`));
    const doc = docLinkEl(e);
    if (doc) {
      const p = h('p', 'mt-entry-doc');
      p.append(doc);
      main.append(p);
    }
    li.append(box, main);
    return li;
  }

  /** An entry's interval: editable for schedules (value, the unit for calendar ones, the second limit), else its words. */
  function entryInterval(e) {
    const wrap = h('div', 'mt-iv');
    const every = normalizeEvery(e.every);
    if (e.kind !== 'interval' || !every) {
      wrap.append(h('span', 'muted', e.interval || describeInterval(e)));
      return wrap;
    }
    const ed = st.edits.get(e.id) ?? {};
    const calendar = every.unit !== 'hour';
    const row = h('div', 'mt-iv-row');
    const val = numInput(ed.every?.value ?? every.value, `Interval of ${e.title}`);
    const unit = calendar ? select(CALENDAR_UNITS.map((u) => [u, UNIT_WORDS[u]]), ed.every?.unit ?? every.unit, `Interval unit of ${e.title}`) : null;
    row.append(h('span', null, 'Every'), val, unit ?? h('span', null, `h (${BASIS_LABELS[e.basis] ?? 'hours'})`));
    wrap.append(row);
    const second = normalizeEvery(e.orEvery);
    let orVal = null;
    let orUnit = null;
    if (second) {
      const row2 = h('div', 'mt-iv-row');
      orVal = numInput(ed.orEvery?.value ?? second.value, `Second limit of ${e.title}`);
      orUnit = select(CALENDAR_UNITS.map((u) => [u, UNIT_WORDS[u]]), ed.orEvery?.unit ?? second.unit, `Second limit unit of ${e.title}`);
      row2.append(h('span', null, 'or every'), orVal, orUnit, h('span', 'muted small', 'whichever comes first'));
      wrap.append(row2);
    }
    const note = () => {
      st.edits.set(e.id, {
        every: { value: val.value, unit: unit ? unit.value : 'hour' },
        ...(orVal ? { orEvery: { value: orVal.value, unit: orUnit.value } } : {}),
      });
    };
    for (const x of [val, unit, orVal, orUnit]) if (x) { x.addEventListener('input', note); x.addEventListener('change', note); }
    if (str(e.source?.asStated)) wrap.append(h('div', 'muted small', `The document says: ${e.source.asStated}`));
    return wrap;
  }

  async function saveSetup() {
    const c = st.catalog;
    if (!c || st.saving || st.catalogLoading) return;
    const id = st.machine;
    const none = st.modelPick === '';
    const entries = setupEntries();
    const tasks = [];
    for (const e of entries) {
      if (!st.ticks.has(e.id)) continue;
      const t = { catalogId: e.id };
      const ed = st.edits.get(e.id);
      if (ed && e.kind === 'interval' && normalizeEvery(e.every)) {
        const ev = readEvery(ed.every?.value, ed.every?.unit ?? e.every.unit, `${e.title}: the interval`);
        if (!ev.ok) { toast(ev.message, { kind: 'error', timeoutMs: 8000 }); focusEntry(e.id); return; }
        if (!sameEvery(ev.value, e.every)) t.every = ev.value;
        if (ed.orEvery && normalizeEvery(e.orEvery)) {
          if (String(ed.orEvery.value ?? '').trim() === '') t.orEvery = null;
          else {
            const ov = readEvery(ed.orEvery.value, ed.orEvery.unit, `${e.title}: the second limit`);
            if (!ov.ok) { toast(ov.message, { kind: 'error', timeoutMs: 8000 }); focusEntry(e.id); return; }
            if (!sameEvery(ov.value, e.orEvery)) t.orEvery = ov.value;
          }
        }
      }
      tasks.push(t);
    }
    // the server turns off every catalog task of this machine that is not ticked: say which before it does
    const picked = new Set(tasks.map((t) => t.catalogId));
    const current = machineById(id)?.tasks;
    const off = Array.isArray(current)
      ? current.filter((t) => isObj(t) && t.catalogId && t.enabled !== false && !picked.has(t.catalogId))
      : entriesOf(c).filter((e) => e.added && e.enabled !== false && !picked.has(e.id));
    if (off.length) {
      const names = off.slice(0, 4).map((e) => `“${e.title}”`).join(', ');
      const yes = await confirmDialog({
        heading: `Turn off ${plural(off.length, 'task')}?`, icon: 'toggle-off', confirm: 'Save and turn off',
        lines: [`${names}${off.length > 4 ? ` and ${off.length - 4} more` : ''}.`, 'They are kept with their history; tick them again to turn them back on.'],
      });
      if (!yes) return;
    }
    st.saving = true;
    renderSetup();
    try {
      const r = await api.maintenance.setup(id, { model: none ? null : (c.model ?? null), tasks });
      const said = [[countOf(r?.added), 'added'], [countOf(r?.enabled), 'turned on'], [countOf(r?.disabled), 'turned off'], [countOf(r?.edited), 'changed']]
        .filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
      toast(`${machineName(id)}: ${said.length ? said.join(', ') : 'saved, nothing changed'}`, { kind: 'ok' });
      st.saving = false;
      if (st.view === 'setup' && st.machine === id) showList();
    } catch (e) {
      st.saving = false;
      toast(`Could not save: ${e.message}`, { kind: 'error', timeoutMs: 8000 });
      renderSetup();
    }
  }

  function focusEntry(entryId) {
    const li = [...body.querySelectorAll('.mt-entry')].find((x) => x.dataset.entry === entryId);
    li?.scrollIntoView({ block: 'center' });
    li?.querySelector('input.mt-num')?.focus({ preventScroll: true });
  }

  /** "Add a task": the shop's own task (title, kind, interval or alarm codes, link, description). */
  function addTaskForm() {
    if (st.addForm) return st.addForm;
    const f = h('form', 'mt-form mt-add');
    const titleIn = textInput('', { maxLength: TITLE_MAX, label: 'Title', placeholder: 'e.g. Clean the chip conveyor' });
    const kindSel = select([['interval', 'On a schedule'], ['alarm', 'When an alarm comes up'], ['as-needed', 'As needed (never due)']], 'interval', 'Kind');
    const iv = intervalInputs({ kind: 'interval', basis: 'operating' });
    const whenField = field('When', iv.el);
    kindSel.addEventListener('change', () => { iv.setKind(kindSel.value); whenField.hidden = kindSel.value === 'as-needed'; });
    const linkIn = textInput('', { type: 'url', maxLength: LINK_MAX, label: 'Link', placeholder: 'https://… (optional)' });
    const desc = h('textarea', 'mt-input mt-desc');
    desc.maxLength = ACTION_MAX;
    desc.rows = 3;
    desc.placeholder = 'What to do (optional)';
    desc.setAttribute('aria-label', 'Description');
    const actions = h('div', 'dialog-actions');
    const cancel = button('Cancel', null);
    const ok = h('button', 'btn btn-primary', 'Add task');
    ok.type = 'submit';
    actions.append(cancel, ok);
    f.append(field('Title', titleIn), field('Kind', kindSel), whenField, field('Link', linkIn), field('Description', desc), actions);
    const closeForm = () => { st.addOpen = false; st.addForm = null; renderSetup(); };
    cancel.addEventListener('click', closeForm);
    f.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeForm(); } });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = st.machine;
      const t = titleIn.value.trim();
      if (!t) { toast('Give the task a title', { kind: 'error' }); titleIn.focus(); return; }
      const kind = kindSel.value;
      const bodyOut = { title: t, kind };
      const r = iv.read();
      if (!r.ok) { toast(r.message, { kind: 'error' }); return; }
      if (kind === 'interval') {
        bodyOut.every = r.value.every;
        bodyOut.basis = r.value.basis;
        if (r.value.orEvery) bodyOut.orEvery = r.value.orEvery;
      } else if (kind === 'alarm') bodyOut.alarm = r.value.alarm;
      const l = linkIn.value.trim();
      if (l) {
        if (!safeUrl(l)) { toast('The link must be an http:// or https:// address', { kind: 'error' }); linkIn.focus(); return; }
        bodyOut.link = l;
      }
      const a = desc.value.trim();
      if (a) bodyOut.action = a;
      ok.disabled = true;
      try {
        await api.maintenance.addTask(id, bodyOut);
        toast(`Added “${t}” to ${machineName(id)}`, { kind: 'ok' });
        st.addOpen = false;
        st.addForm = null;
        renderSetup();
        load();
      } catch (e) {
        toast(`Could not add the task: ${e.message}`, { kind: 'error', timeoutMs: 8000 });
      } finally { ok.disabled = false; }
    });
    st.addForm = f;
    return f;
  }

  // ---- wiring ----------------------------------------------------------------------------

  filter.addEventListener('change', () => {
    st.machine = filter.value;
    st.editKey = null;
    st.editForm = null;
    render();
    body.scrollTop = 0;
    // machines that changed while hidden: fetch the ones shown now
    for (const id of [...st.behind]) if (!st.machine || id === st.machine) { st.behind.delete(id); refreshMachine(id); }
  });
  back.addEventListener('click', () => showList());
  close.addEventListener('click', () => hide());
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });

  function hide() {
    if (el.hidden) return;
    el.hidden = true;
    st.editKey = null;
    st.editForm = null;
    st.addOpen = false;
    st.addForm = null;
    deps.onClose?.();
  }

  /**
   * Open the drawer: all machines, or one (`machine`); `view: 'setup'` opens that machine's Set up.
   * @param {{ machine?: string, view?: 'list'|'setup' }} [opts]
   */
  function open(opts = {}) {
    if (ctx().kiosk) return;
    st.machine = typeof opts.machine === 'string' ? opts.machine : '';
    st.editKey = null;
    st.editForm = null;
    el.hidden = false;
    if (opts.view === 'setup' && st.machine && !readOnly()) {
      showSetup(st.machine);
      load();
    } else {
      st.view = 'list';
      render();
      body.scrollTop = 0;
      load();
    }
    close.focus({ preventScroll: true });
  }

  // the statuses move as the hours and days go by: refetch once a minute while the list is open and idle
  const timer = setInterval(() => {
    if (el.hidden || st.view !== 'list' || st.editKey || document.querySelector('dialog.mt-dialog[open]')) return;
    load();
  }, 60_000);

  return {
    open,
    close: hide,
    toggle() { if (el.hidden) open(); else hide(); },
    get isOpen() { return !el.hidden; },
    /**
     * SSE 'maintenance' { machineId, counts, total }: refetch that machine while the drawer shows it (all machines, or
     * that one); another machine's change waits until it is shown. Nothing while the drawer is closed.
     */
    onEvent(data) {
      if (el.hidden || !isObj(data)) return;
      const id = typeof data.machineId === 'string' ? data.machineId : null;
      if (!id) load();
      else if (st.machine && st.machine !== id) st.behind.add(id);
      else refreshMachine(id);
    },
    destroy() { clearInterval(timer); el.replaceChildren(); },
  };
}
