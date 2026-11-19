// Lengths, areas and angles for the layout editor: parse what people type (8'6", 8.5, 102in, 2.5m) and format
// layout units as feet-inches or metres. Pure ESM (no DOM, no imports) so it is unit-tested in Node.
// Layout units are 'ft' or 'm' (docs/LAYOUTS.md); a bare number is always in layout units.

const M_PER_FT = 0.3048;
const NUM = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const FRAC = String.raw`\d+\s*\/\s*\d+`;
/** A number with an optional fraction: 8 | 8.5 | 1/2 | 8 1/2 | 8-1/2 (only inside an inch part). */
const AMOUNT = String.raw`(?:${NUM}(?:[\s-]+${FRAC})?|${FRAC})`;

const FEET_INCHES = new RegExp(String.raw`^(${AMOUNT})\s*'\s*(?:-\s*)?(?:(${AMOUNT})\s*(?:"|'')?)?$`);
const INCHES_ONLY = new RegExp(String.raw`^(${AMOUNT})\s*(?:"|'')$`);
const PLAIN = new RegExp(String.raw`^(${AMOUNT})$`);
const METRIC = new RegExp(String.raw`^(${NUM})\s*(mm|cm|m)$`);

/** "8 1/2" | "8-1/2" | "1/2" | "8.5" → number (NaN when malformed or dividing by zero). */
function amount(s) {
  const t = s.trim();
  const m = /^(?:(\d+(?:\.\d*)?|\.\d+)[\s-]+)?(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m) {
    const den = Number(m[3]);
    if (!den) return NaN;
    return (m[1] ? Number(m[1]) : 0) + Number(m[2]) / den;
  }
  return Number(t);
}

/** Normalize typographic marks and unit words to ' and ". */
function normalize(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/−/g, '-')
    .replace(/\s*(?:feet|foot|ft)\.?(?=[\s\d-]|$)/g, "'")
    .replace(/\s*(?:inches|inch|in)\.?(?=\s|$)/g, '"')
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a length typed by a person and return it in layout units.
 * Accepts 8.5 (layout units) | 8'6" | 8' 6" | 8'-6" | 8ft 6in | 8' 6 1/2" | 6-1/2" | 102in | 102" | 8' | 8.5ft
 * | 2.5m | 250cm | 2500mm, with an optional leading minus and typographic primes (8′ 6″).
 * @param {unknown} text
 * @param {'ft'|'m'} [units]  layout units
 * @returns {number|null} the length in layout units, or null when the text is not a length
 */
export function parseLength(text, units = 'ft') {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  let s = normalize(text);
  if (!s) return null;
  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1).trim(); } else if (s.startsWith('+')) s = s.slice(1).trim();
  if (!s) return null;
  const toUnits = (feet) => (units === 'm' ? feet * M_PER_FT : feet);
  let v = null;
  let m;
  if ((m = METRIC.exec(s))) {
    const metres = Number(m[1]) / (m[2] === 'mm' ? 1000 : m[2] === 'cm' ? 100 : 1);
    v = units === 'm' ? metres : metres / M_PER_FT;
  } else if ((m = FEET_INCHES.exec(s))) {
    const ft = amount(m[1]);
    const inch = m[2] ? amount(m[2]) : 0;
    v = toUnits(ft + inch / 12);
  } else if ((m = INCHES_ONLY.exec(s))) {
    v = toUnits(amount(m[1]) / 12);
  } else if ((m = PLAIN.exec(s))) {
    v = amount(m[1]);
  }
  if (v === null || !Number.isFinite(v)) return null;
  return sign * v || 0;
}

/**
 * Parse an angle in degrees ("45", "45°", "-90 deg"). Returns null when not a number.
 * @param {unknown} text
 */
export function parseAngle(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const s = text.trim().toLowerCase().replace(/−/g, '-').replace(/\s*(?:°|deg(?:rees?)?)$/, '');
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * Format a length in layout units: feet-inches for 'ft' layouts (12' 6", 6½", -2' 3") rounded to the nearest
 * half inch, or metres for 'm' layouts (2.45 m).
 * @param {number} value
 * @param {'ft'|'m'} [units]
 * @param {{ inchStep?: number, zeroInches?: boolean }} [opts]  zeroInches → "12' 0"" instead of "12'"
 * @returns {string}
 */
export function formatLength(value, units = 'ft', { inchStep = 0.5, zeroInches = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (units === 'm') {
    const t = (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
    return `${t === '-0' ? '0' : t} m`;
  }
  const step = inchStep > 0 ? inchStep : 0.5;
  const totalIn = Math.round((Math.abs(value) * 12) / step) * step;
  if (totalIn === 0) return '0"';
  const sign = value < 0 ? '-' : '';
  const ft = Math.floor((totalIn + 1e-9) / 12);
  const inch = Math.max(0, totalIn - ft * 12);
  const whole = Math.floor(inch + 1e-9);
  const frac = inch - whole;
  let inchText;
  if (Math.abs(frac - 0.5) < 1e-6) inchText = whole ? `${whole}½` : '½';
  else if (frac < 1e-6) inchText = String(whole);
  else inchText = String(Math.round(inch * 100) / 100);
  if (ft === 0) return `${sign}${inchText}"`;
  if (inch < 1e-6 && !zeroInches) return `${sign}${ft}'`;
  return `${sign}${ft}' ${inchText}"`;
}

/**
 * Format a length for an input field: same as formatLength but typeable (8' 6.5" instead of 8' 6½").
 * @param {number} value
 * @param {'ft'|'m'} [units]
 */
export function formatLengthInput(value, units = 'ft') {
  return formatLength(value, units).replace(/(\d*)½/, (_, d) => `${d || '0'}.5`);
}

/**
 * Format an area given in square layout units: "1,234 ft²" / "9.5 ft²" / "114.6 m²".
 * @param {number} area
 * @param {'ft'|'m'} [units]
 */
export function formatArea(area, units = 'ft') {
  if (typeof area !== 'number' || !Number.isFinite(area)) return '';
  const a = Math.abs(area);
  const unit = units === 'm' ? 'm²' : 'ft²';
  const digits = units === 'm' ? (a < 1000 ? 1 : 0) : a < 10 ? 1 : 0;
  const text = a.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return `${text} ${unit}`;
}

/**
 * Format an angle in degrees: "45°", "-12.5°".
 * @param {number} deg
 */
export function formatAngle(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return '';
  const r = Math.round(deg * 10) / 10;
  return `${r === 0 ? 0 : r}°`;
}

/**
 * Nudge steps for arrow keys (DECISIONS D5): grid step, Shift ×10, Alt 0.1 ft (1 cm in metric layouts).
 * @param {{ grid?: number, units?: 'ft'|'m', shift?: boolean, alt?: boolean }} o
 */
export function nudgeStep({ grid = 1, units = 'ft', shift = false, alt = false } = {}) {
  if (alt) return units === 'm' ? 0.01 : 0.1;
  const g = typeof grid === 'number' && grid > 0 && Number.isFinite(grid) ? grid : 1;
  return shift ? g * 10 : g;
}
