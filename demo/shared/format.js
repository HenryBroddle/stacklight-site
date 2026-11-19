// Formatting helpers shared by the server (logs) and the browser HUD. Pure ESM.

/**
 * Human duration. compact: "45s", "12m 05s", "3h 12m", "2d 4h". clock: "0:45", "12:05", "3:12:05".
 * glance (HUD timers, docs/DECISIONS.md D4): "45s", "12m", "1h 05m", "2d 4h" — no seconds after the first
 * minute, so a TV redraws timers about once a minute.
 * @param {number} ms
 * @param {{ style?: 'compact'|'clock'|'glance' }} [opts]
 */
export function formatDuration(ms, { style = 'compact' } = {}) {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.floor(Math.abs(ms) / 1000);
  const neg = ms < 0 && total > 0; // -500 ms (clock skew) is "0s", never "-0s"
  let s = total;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  let out;
  if (style === 'clock') {
    const hh = d * 24 + h;
    out = hh ? `${hh}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  } else if (style === 'glance') {
    if (d) out = `${d}d ${h}h`;
    else if (h) out = `${h}h ${pad(m)}m`;
    else if (m) out = `${m}m`;
    else out = `${s}s`;
  } else if (d) out = `${d}d ${h}h`;
  else if (h) out = `${h}h ${pad(m)}m`;
  else if (m) out = `${m}m ${pad(s)}s`;
  else out = `${s}s`;
  return neg ? `-${out}` : out;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgo(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 10_000) return 'just now';
  return `${formatDuration(ms).split(' ')[0]} ago`;
}

/** Strip the sign of a formatted negative zero ("-0", "-0.0") — e.g. a load of -0.0001 shows "0". */
const unsignZero = (s) => (/^-0(?:\.0*)?$/.test(s) ? s.slice(1) : s);

/** Number with fixed max fraction digits and thousands separators; '—' for null/NaN/blank/non-numeric values. */
export function formatNumber(n, digits = 0) {
  const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
  if (!Number.isFinite(v)) return '—';
  return unsignZero(v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }));
}

/** Wall-clock time of an epoch-ms value ('—' outside the Date range, ±8.64e15 ms). */
export function formatClock(ms, { clock24h = false, seconds = false } = {}) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: !clock24h,
  });
}

/** Percentage 0..1 → "42%". */
export function formatPercent(fraction, digits = 0) {
  if (!Number.isFinite(fraction)) return '—';
  return `${unsignZero((fraction * 100).toFixed(digits))}%`;
}

/** Truncate long agent-provided strings for compact display (never splits a surrogate pair). */
export function truncate(s, max = 60) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (!(str.length > max)) return str;
  let cut = Math.max(0, max - 1);
  const c = str.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--; // the kept part would end with a lone high surrogate
  return `${str.slice(0, cut)}…`;
}

/** Condition/alarm one-liner: "1050 · SPINDLE OVERLOAD" (code optional). */
export function formatCondition(c) {
  if (!c) return '';
  const code = c.nativeCode ? String(c.nativeCode) : '';
  const msg = c.message ? String(c.message) : (c.type ? String(c.type).replace(/_/g, ' ') : '');
  return code && msg ? `${code} · ${msg}` : code || msg;
}
