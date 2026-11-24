// Program runs (docs/DECISIONS.md D12): the shapes, words and arithmetic shared by the server (src/machines/runs.js,
// src/server/api.js), the HUD's run report (public/js/runsPanel.js) and the static demo. Pure ESM, no I/O.
//
// A run is one execution of a program on one machine: it starts when the machine goes into cycle (RUNNING, or
// PAUSED part-way through a program) in an automatic mode, and ends at the program end (M30/M02, or the part counter
// counting up), when the program is reset or changed, or when the HUD loses the machine for too long. Feed holds,
// M00/M01 stops and alarms the program resumes from stay inside the run.
//
// Run (what GET /api/runs returns and what <dataDir>/runs/YYYY-MM.jsonl stores):
//   { id, machineId, machineName, program, programComment,
//     start, startIsLowerBound, end (null while open), lastAt,
//     runMs, pausedMs, stoppedMs,                 // time in cycle / paused / in alarm, E-stop or without data
//     partsStart, partsEnd, parts,                 // part counter at both ends and the count added (null = no counter)
//     pauses, alarms,                              // times the run paused / stopped on an alarm or E-stop
//     outcome, endReason,                          // 'open' | 'completed' | 'aborted' | 'unknown' and why it ended
//     invalid: null | { reason: 'scrap'|'test'|'other', note, at },
//     calls: [{ program, calls, ms, last }],       // programs the run called (D21), in first-call order
//     callsMore: null | { calls, ms },             // calls of programs beyond MAX_CALLED_PROGRAMS (counted, not named)
//     loader: null | string }                      // the loader program (a pallet main) that loaded it (D22)
//
// Called programs (D21): what the control executed besides the run's own program, from the "active program" it
// reports — the shop's subprograms (M98/M198/G65 calls) and machine macros (isMacroProgram: tool and pallet changes,
// probing). Per program: calls (a lower bound, src/machines/programCalls.js), ms = the time it was executing itself
// (a subprogram's time leaves out the macros it called), last = when it was last called.

export const RUN_OUTCOMES = Object.freeze({
  OPEN: 'open',             // still running (or paused/stopped and may resume)
  COMPLETED: 'completed',   // program end seen, or the part counter counted up
  ABORTED: 'aborted',       // reset, changed or stopped before its end on a machine whose part counter works
  UNKNOWN: 'unknown',       // ended without a completion signal the HUD can trust (no working counter, data lost)
});

/** Report words for each outcome. */
export const OUTCOME_LABELS = Object.freeze({
  open: 'In progress',
  completed: 'Completed',
  aborted: 'Aborted',
  unknown: 'Ended',
});

/** Why a run was invalidated (POST /api/runs/:id/invalidate { reason }). */
export const INVALID_REASONS = Object.freeze({
  scrap: 'Bad parts',
  test: 'Test run',
  other: 'Other',
});

/** Run ids: <YYYYMM of the start, local time>-<start, base 36>-<random, base 36>. The month names the file. */
export const RUN_ID_RE = /^(\d{4})(\d{2})-[0-9a-z]{1,12}-[0-9a-z]{1,10}$/;

/** Longest note kept with an invalidation. */
export const INVALID_NOTE_MAX = 200;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Loader programs (D22): a pallet main such as O0001 loads the part program of each pallet. On a machine where a
// program is set as a loader (settings runs.machines.<id>.loaders), the loader is never a run: each program it
// loads is (src/machines/programCalls.js LoadTracker).
// ---------------------------------------------------------------------------------------------

/** Most loader programs per machine. */
export const MAX_LOADERS = 10;

/**
 * A program name compared as the controls write it: case and a trailing ".NC" ignored, and an O-number without its
 * leading zeros ("O0001", "O1", "1" and "O00000001.NC" are one program).
 */
export function programId(name) {
  if (typeof name !== 'string') return '';
  const s = name.trim().replace(/\.NC$/i, '');
  const m = /^O?0*(\d{1,9})$/i.exec(s);
  return m ? `O${m[1]}` : s.toUpperCase();
}

/** True when `program` is one of the loader programs listed (`loaders`: names as entered). */
export function isLoaderProgram(loaders, program) {
  const id = programId(program);
  return !!id && Array.isArray(loaders) && loaders.some((l) => programId(l) === id);
}

/** The loader programs set for a machine in the (public) settings. */
export function loadersOf(settings, machineId) {
  const l = settings?.runs?.machines?.[machineId]?.loaders;
  return Array.isArray(l) ? l.filter((x) => typeof x === 'string' && x.trim()) : [];
}

// ---------------------------------------------------------------------------------------------
// Called programs (D21)
// ---------------------------------------------------------------------------------------------

/** Programs a run itemizes in `calls`; calls of any further program only add to `callsMore`. */
export const MAX_CALLED_PROGRAMS = 40;

/**
 * A machine macro rather than one of the shop's programs: O8000–O9999 (four digits), the numbers FANUC sets aside
 * for the machine builder's macros, which M, G and T codes call (tool changes, pallet changes, probing cycles).
 * The shop's eight-digit programs (O80001000, O90002000) are not macros.
 */
export function isMacroProgram(name) {
  return typeof name === 'string' && /^O?0*[89]\d{3}(\.NC)?$/i.test(name.trim());
}

const count = (v) => (finite(v) && v >= 0 ? Math.round(v) : 0);

/** One stored called-program entry with every field in range, or null. */
export function normalizeCall(c) {
  if (!isObj(c) || typeof c.program !== 'string' || !c.program.trim()) return null;
  return {
    program: c.program.trim().slice(0, 200),
    calls: count(c.calls),
    ms: count(c.ms),
    last: finite(c.last) ? c.last : null,
  };
}

/** A run's `calls`, cleaned (at most MAX_CALLED_PROGRAMS, one entry per program). */
export function normalizeCalls(v) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(v) ? v : []) {
    const n = normalizeCall(c);
    if (!n || seen.has(n.program)) continue;
    seen.add(n.program);
    out.push(n);
    if (out.length >= MAX_CALLED_PROGRAMS) break;
  }
  return out;
}

/** A run's `callsMore`, cleaned (null when there were none). */
export function normalizeCallsMore(v) {
  return isObj(v) && count(v.calls) > 0 ? { calls: count(v.calls), ms: count(v.ms) } : null;
}

/**
 * A run's called programs, split: the shop's subprograms in first-call order, and machine macros with the most
 * time first, with their totals.
 */
export function callsOf(run) {
  const list = normalizeCalls(run?.calls);
  const subs = list.filter((c) => !isMacroProgram(c.program));
  const macros = list.filter((c) => isMacroProgram(c.program)).sort((a, b) => b.ms - a.ms || a.program.localeCompare(b.program));
  return {
    subs,
    macros,
    macroCalls: macros.reduce((s, c) => s + c.calls, 0),
    macroMs: macros.reduce((s, c) => s + c.ms, 0),
    more: normalizeCallsMore(run?.callsMore),
  };
}

/** True when the run called `program` (any called program, macros included). */
export function runCalled(run, program) {
  return Array.isArray(run?.calls) && run.calls.some((c) => c?.program === program);
}

/** Key a called-program summary is grouped by (never equal to a programKey: machine ids never start with \u0001). */
export function callKey(machineId, program) {
  return `\u0001${machineId ?? ''}\u0000${program ?? ''}`;
}

/** The machine id and program of a callKey, or null for any other key. */
export function parseCallKey(key) {
  if (typeof key !== 'string' || !key.startsWith('\u0001')) return null;
  const i = key.indexOf('\u0000');
  return i < 0 ? null : { machineId: key.slice(1, i), program: key.slice(i + 1) };
}

/**
 * The shop's subprograms that valid runs called: one row per machine and program, newest call first.
 * @param {object[]} runs
 * @returns {CallSummary[]}
 *
 * @typedef {Object} CallSummary
 * @property {string} key              callKey(machineId, program)
 * @property {string} program
 * @property {string} machineId
 * @property {string} machineName
 * @property {string[]} callers        the programs whose runs called it
 * @property {number} runs             valid runs that called it
 * @property {number} calls            at least this many calls
 * @property {number} ms               time it was executing (open runs: up to when they were read)
 * @property {number|null} last        newest call
 */
export function summarizeCalls(runs) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!isObj(r) || !isValidRun(r)) continue;
    for (const c of callsOf(r).subs) {
      const key = callKey(r.machineId, c.program);
      let g = groups.get(key);
      if (!g) {
        g = { key, program: c.program, machineId: r.machineId ?? '', machineName: r.machineName ?? r.machineId ?? '', callers: [], runs: 0, calls: 0, ms: 0, last: null };
        groups.set(key, g);
      }
      if (r.program && !g.callers.includes(r.program)) g.callers.push(r.program);
      g.runs++;
      g.calls += c.calls;
      g.ms += c.ms;
      const last = c.last ?? r.start;
      if (finite(last) && (g.last === null || last > g.last)) g.last = last;
    }
  }
  return [...groups.values()].sort((a, b) => (b.last ?? -Infinity) - (a.last ?? -Infinity) || a.program.localeCompare(b.program));
}

/** "O1234 x2 (36.0 min); O5678 x1 (0.8 min)" for the CSV. */
function callsCsv(list) {
  return list.map((c) => `${c.program} x${c.calls} (${(c.ms / 60000).toFixed(1)} min)`).join('; ');
}

/** True when the run counts in the report totals (not invalidated). */
export function isValidRun(run) {
  return isObj(run) && !run.invalid;
}

/** Elapsed time of a run: end − start, or now − start while it is open. */
export function runDuration(run, now = Date.now()) {
  if (!isObj(run) || !finite(run.start)) return null;
  const end = finite(run.end) ? run.end : finite(now) ? Math.max(now, run.start) : run.start;
  return Math.max(0, end - run.start);
}

/**
 * Parts a run added for the report: the counter difference when the machine has one, else null.
 * @returns {number|null}
 */
export function runParts(run) {
  return isObj(run) && finite(run.parts) && run.parts >= 0 ? run.parts : null;
}

/** Key a program summary is grouped by: the same program name on two machines is two programs. */
export function programKey(run) {
  return `${run?.machineId ?? ''}\u0000${run?.program ?? ''}`;
}

/**
 * Totals per program (per machine) and for the whole selection.
 * @param {object[]} runs
 * @param {{ now?: number }} [opts]
 * @returns {{ total: Summary, programs: ProgramSummary[] }}
 *
 * @typedef {Object} Summary
 * @property {number} runs          valid runs (open ones included)
 * @property {number} open          valid runs still in progress
 * @property {number} completed     valid completed runs
 * @property {number} aborted       valid aborted runs
 * @property {number} unknown       valid runs that ended without a completion signal
 * @property {number} invalid       invalidated runs (not in any other total)
 * @property {number} parts         parts from valid runs
 * @property {number} partsInvalid  parts from invalidated runs
 * @property {number} uncounted     valid ended runs with no part count (the machine reports none)
 * @property {number} timeMs        elapsed time of valid runs
 * @property {number} runMs         of which in cycle
 * @property {number} pausedMs      of which paused
 * @property {number} stoppedMs     of which stopped (alarm, E-stop, no data)
 * @property {number|null} avgCycleMs  mean elapsed time of valid completed runs
 * @property {number|null} minCycleMs  shortest valid completed run
 * @property {number|null} lastStart   newest run start (invalidated runs included)
 *
 * @typedef {Summary & { key: string, program: string|null, programComment: string|null, machineId: string, machineName: string }} ProgramSummary
 */
export function summarizeRuns(runs, { now = Date.now() } = {}) {
  const blank = () => ({
    runs: 0, open: 0, completed: 0, aborted: 0, unknown: 0, invalid: 0, parts: 0, partsInvalid: 0, uncounted: 0,
    timeMs: 0, runMs: 0, pausedMs: 0, stoppedMs: 0, avgCycleMs: null, minCycleMs: null, lastStart: null,
    _cycleSum: 0, _cycleN: 0,
  });
  const total = blank();
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!isObj(r) || !finite(r.start)) continue;
    const key = programKey(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, program: r.program ?? null, programComment: r.programComment ?? null, machineId: r.machineId ?? '', machineName: r.machineName ?? r.machineId ?? '', ...blank() };
      groups.set(key, g);
    }
    if (!g.programComment && r.programComment) g.programComment = r.programComment;
    for (const s of [g, total]) add(s, r, now);
  }
  const done = (s) => {
    s.avgCycleMs = s._cycleN ? Math.round(s._cycleSum / s._cycleN) : null;
    delete s._cycleSum;
    delete s._cycleN;
    return s;
  };
  const programs = [...groups.values()].map(done).sort((a, b) => (b.lastStart ?? -Infinity) - (a.lastStart ?? -Infinity) || String(a.program).localeCompare(String(b.program)));
  return { total: done(total), programs };
}

function add(s, r, now) {
  const parts = runParts(r);
  if (s.lastStart === null || r.start > s.lastStart) s.lastStart = r.start;
  if (!isValidRun(r)) {
    s.invalid++;
    if (parts !== null) s.partsInvalid += parts;
    return;
  }
  s.runs++;
  const outcome = Object.values(RUN_OUTCOMES).includes(r.outcome) ? r.outcome : RUN_OUTCOMES.UNKNOWN;
  s[outcome]++;
  if (parts !== null) s.parts += parts;
  else if (outcome !== RUN_OUTCOMES.OPEN) s.uncounted++;
  const dur = runDuration(r, now) ?? 0;
  s.timeMs += dur;
  s.runMs += finite(r.runMs) ? r.runMs : 0;
  s.pausedMs += finite(r.pausedMs) ? r.pausedMs : 0;
  s.stoppedMs += finite(r.stoppedMs) ? r.stoppedMs : 0;
  if (outcome === RUN_OUTCOMES.COMPLETED && finite(r.end)) {
    s._cycleSum += dur;
    s._cycleN++;
    if (s.minCycleMs === null || dur < s.minCycleMs) s.minCycleMs = dur;
  }
}

/** Runs that overlap [from, to) (open runs reach `now`). */
export function runsInRange(runs, from, to, now = Date.now()) {
  return (Array.isArray(runs) ? runs : []).filter((r) => {
    if (!isObj(r) || !finite(r.start)) return false;
    const end = finite(r.end) ? r.end : Math.max(now, r.start);
    return r.start < to && end >= from;
  });
}

/** Newest first; ties by machine id. */
export function sortRuns(runs) {
  return [...runs].sort((a, b) => b.start - a.start || String(a.machineId).localeCompare(String(b.machineId)));
}

/**
 * Validate an invalidation request body. Returns { ok: true, value: { reason, note } } or { ok: false, message }.
 * @param {any} body  { reason: 'scrap'|'test'|'other', note?: string }
 */
export function parseInvalidation(body) {
  if (!isObj(body)) return { ok: false, message: 'Body must be {"reason": "scrap" | "test" | "other", "note": "…"}' };
  for (const k of Object.keys(body)) if (k !== 'reason' && k !== 'note') return { ok: false, message: `Unknown field "${String(k).slice(0, 40)}"` };
  if (!Object.hasOwn(INVALID_REASONS, body.reason)) return { ok: false, message: 'reason must be "scrap", "test" or "other"' };
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return { ok: false, message: 'note must be text' };
  // control characters out, whitespace collapsed, length capped
  const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, INVALID_NOTE_MAX) : '';
  if (body.reason === 'other' && !note) return { ok: false, message: 'Say why in the note when the reason is "other"' };
  return { ok: true, value: { reason: body.reason, note } };
}

// ---------------------------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------------------------

/** One CSV field (RFC 4180), with spreadsheet formula injection neutralized. */
export function csvField(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const isoOrEmpty = (ms) => (finite(ms) ? new Date(ms).toISOString() : '');
const minutes = (ms) => (finite(ms) ? (ms / 60000).toFixed(2) : '');

/** Column header and value per run (one CSV row per run). */
export const RUN_CSV_COLUMNS = Object.freeze([
  ['Run ID', (r) => r.id],
  ['Machine', (r) => r.machineName ?? r.machineId],
  ['Machine ID', (r) => r.machineId],
  ['Program', (r) => r.program],
  ['Program comment', (r) => r.programComment],
  ['Start (UTC)', (r) => isoOrEmpty(r.start)],
  ['Start is a lower bound', (r) => (r.startIsLowerBound ? 'yes' : 'no')],
  ['End (UTC)', (r) => isoOrEmpty(r.end)],
  ['Elapsed (min)', (r, now) => minutes(runDuration(r, now))],
  ['In cycle (min)', (r) => minutes(r.runMs)],
  ['Paused (min)', (r) => minutes(r.pausedMs)],
  ['Stopped (min)', (r) => minutes(r.stoppedMs)],
  ['Parts', (r) => runParts(r)],
  ['Part counter at start', (r) => r.partsStart],
  ['Part counter at end', (r) => r.partsEnd],
  ['Outcome', (r) => OUTCOME_LABELS[r.outcome] ?? r.outcome],
  ['End reason', (r) => r.endReason],
  ['Valid', (r) => (r.invalid ? 'no' : 'yes')],
  ['Invalid reason', (r) => (r.invalid ? INVALID_REASONS[r.invalid.reason] ?? r.invalid.reason : '')],
  ['Invalid note', (r) => (r.invalid ? r.invalid.note : '')],
  ['Invalidated at (UTC)', (r) => (r.invalid ? isoOrEmpty(r.invalid.at) : '')],
  ['Called programs', (r) => callsCsv(callsOf(r).subs)],
  ['Macros called', (r) => callsCsv(callsOf(r).macros)],
  ['Loaded by', (r) => r.loader ?? ''],
]);

/** CSV text (CRLF rows, header first) of runs. */
export function runsToCsv(runs, { now = Date.now() } = {}) {
  const lines = [RUN_CSV_COLUMNS.map(([h]) => csvField(h)).join(',')];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!isObj(r)) continue;
    lines.push(RUN_CSV_COLUMNS.map(([, f]) => csvField(f(r, now))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
