// Layout validation, normalization and geometry helpers (pure ESM; shared by the server and the
// browser editor). The format is specified in docs/LAYOUTS.md.
import {
  LAYOUT_SCHEMA, ITEM_ID_RE, LAYOUT_ID_RE, LAYOUT_COLLECTIONS, WALL_STYLES, LABEL_STYLES,
} from './contracts.js';
import { validateSource } from './sources.js';

export const LIMITS = Object.freeze({ maxExtent: 5000, maxItems: 5000, name: 120, text: 200, notes: 2000, url: 500, device: 200 });

const KNOWN_KEYS = Object.freeze({
  top: new Set(['schema', 'id', 'name', 'description', 'units', 'width', 'height', 'grid', 'background', 'views', ...LAYOUT_COLLECTIONS]),
  background: new Set(['src', 'x', 'y', 'width', 'height', 'opacity', 'visible', 'rotation', 'corners']),
  walls: new Set(['id', 'points', 'closed', 'style', 'thickness', 'label', 'locked']),
  doors: new Set(['id', 'x', 'y', 'width', 'rotation', 'kind', 'swing', 'label', 'locked']),
  rooms: new Set(['id', 'name', 'kind', 'x', 'y', 'w', 'h', 'points', 'showLabel', 'labelOffset', 'locked']),
  objects: new Set(['id', 'name', 'kind', 'x', 'y', 'w', 'h', 'rotation', 'showLabel', 'notes', 'locked', 'hud']),
  labels: new Set(['id', 'text', 'x', 'y', 'style', 'size', 'rotation', 'locked', 'hud']),
  machines: new Set(['id', 'name', 'kind', 'x', 'y', 'w', 'h', 'rotation', 'source', 'notes', 'tags', 'locked', 'thresholds', 'statusMap']),
  views: new Set(['id', 'name', 'x', 'y', 'w', 'h']),
});

/** Background images: raster formats only (DECISIONS D9) — never SVG/HTML, which could run script in the HUD origin. */
export const BACKGROUND_SRC_RE = /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/i;
/** Per-machine attention threshold overrides (DECISIONS D3); values in minutes, null = never for this machine. */
export const THRESHOLD_KEYS = Object.freeze(['pausedWarnMinutes', 'idleWarnMinutes', 'setupWarnMinutes', 'offlineWarnMinutes', 'downWarnMinutes']);
/** Statuses a machine `statusMap` may map to (DECISIONS D1). */
export const STATUS_MAP_TARGETS = Object.freeze(['ESTOP', 'ALARM', 'PAUSED', 'SETUP', 'IDLE', 'RUNNING']);
/** statusMap keys: a bare value (STOPPED), a namespaced extension literal (x:BURN, DECISIONS D1a) or either one
 *  scoped to a data item type as 'TYPE:VALUE' (EXECUTION:STOPPED, EXECUTION:x:BURN). Case-insensitive, as
 *  src/machines/status.js normalizeStatusMap understands them. */
const STATUS_MAP_KEY_RE = /^(?:(EXECUTION|CONTROLLER_MODE|FUNCTIONAL_MODE):)?(?:([A-Z][A-Z0-9.-]{0,15}):)?[A-Z][A-Z0-9_]{0,39}$/i;
/** A namespace prefix that is really a DataItem type (PROGRAM:STOPPED) is a typo for an unsupported TYPE:VALUE key,
 *  not an extension literal; DataItem types with an underscore are already excluded by the namespace pattern. */
const STATUS_MAP_NOT_NAMESPACES = new Set(['EXECUTION', 'PROGRAM', 'AVAILABILITY', 'MESSAGE', 'LINE', 'BLOCK', 'ALARM', 'USER', 'CONDITION', 'SYSTEM']);
const statusMapKeyOk = (k) => {
  const m = STATUS_MAP_KEY_RE.exec(k);
  return !!m && !(m[2] && STATUS_MAP_NOT_NAMESPACES.has(m[2].toUpperCase()));
};
const MAX_VIEWS = 50;

const ID_PREFIX = Object.freeze({ walls: 'w', doors: 'd', rooms: 'r', objects: 'o', labels: 'l', machines: 'm' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Round to 4 decimals. Values too large to scale (|v| > ~1e304) are kept as-is; -0 becomes 0. */
const round = (v) => {
  const r = Math.round(v * 10000) / 10000;
  return Number.isFinite(r) ? r || 0 : v;
};
/** Own-property lookup that is safe for any key (non-strings, "constructor", "__proto__", …). */
const own = (table, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

/** Keys that never occur in layouts and are classic prototype-pollution gadgets: rejected at any depth. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Ids that collide with Object.prototype members — ids become object keys in the server and the browser. */
const RESERVED_IDS = new Set([...FORBIDDEN_KEYS, 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toString',
  'toLocaleString', 'valueOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const MAX_NESTING = 64;
const MAX_VALUES = 2_000_000; // far above any 2 MB layout file

/**
 * Walk the input the way JSON.stringify sees it (own enumerable keys) before anything copies it:
 * reports prototype-pollution keys and absurd nesting, and bounds the total size so cycles or shared
 * sub-trees cannot make serialization run away. May throw (getters, proxies) — the caller catches.
 */
function checkShape(root, err) {
  let budget = MAX_VALUES;
  const walk = (v, path, depth) => {
    if (--budget < 0) return false;
    if (v === null || typeof v !== 'object') return true;
    if (depth > MAX_NESTING) { err(path, `Nested more than ${MAX_NESTING} levels deep`); return false; }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (!walk(v[i], `${path}[${i}]`, depth + 1)) return false;
      return true;
    }
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      if (FORBIDDEN_KEYS.has(k)) err(p, `Property name "${k}" is not allowed`);
      else if (!walk(v[k], p, depth + 1)) return false;
    }
    return true;
  };
  if (!walk(root, '', 0) && budget < 0) err('', `Layout is too large (more than ${MAX_VALUES} values)`);
}

/**
 * Validate and normalize a layout. Never throws.
 * @param {unknown} input
 * @param {{ expectedId?: string }} [opts]
 * @returns {{ ok: boolean, errors: {path:string, message:string}[], warnings: {path:string, message:string}[], layout: object|null }}
 */
export function validateLayout(input, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const fail = (message) => ({ ok: false, errors: [{ path: '', message }], warnings, layout: null });

  if (!isObj(input)) return fail('Layout must be a JSON object');
  // Validate a JSON round-trip copy: it is exactly what would be saved and the input is never mutated.
  // Cycles, BigInts, throwing getters or absurd nesting become errors instead of exceptions.
  /** @type {any} */
  let L;
  try {
    checkShape(input, err);
    if (errors.length) return { ok: false, errors, warnings, layout: null };
    L = JSON.parse(JSON.stringify(input));
  } catch {
    return fail('Layout must be plain JSON data (no circular references, BigInt values or failing getters)');
  }
  if (!isObj(L)) return fail('Layout must be a JSON object');
  const expectedId = opts?.expectedId;

  // --- top level -------------------------------------------------------------------------------
  if (L.schema === undefined) { warn('schema', `Missing "schema"; assuming ${LAYOUT_SCHEMA}`); L.schema = LAYOUT_SCHEMA; }
  else if (L.schema !== LAYOUT_SCHEMA) {
    const shown = typeof L.schema === 'string' ? `"${L.schema.slice(0, 80)}"` : String(JSON.stringify(L.schema)).slice(0, 80);
    err('schema', `Unsupported schema ${shown} (expected ${LAYOUT_SCHEMA})`);
  }

  if (typeof L.id !== 'string' || !LAYOUT_ID_RE.test(L.id)) err('id', 'Layout id must use lowercase letters, digits and dashes (max 64)');
  else if (RESERVED_IDS.has(L.id)) err('id', `Layout id "${L.id}" is reserved`);
  else if (expectedId && L.id !== expectedId) err('id', `Layout id "${L.id}" does not match "${expectedId}"`);

  checkString(L, 'name', 'name', LIMITS.name, true, err);
  if (L.description !== undefined) checkString(L, 'description', 'description', LIMITS.notes, false, err);
  if (L.units === undefined) L.units = 'ft';
  else if (L.units !== 'ft' && L.units !== 'm') err('units', 'units must be "ft" or "m"');
  for (const k of ['width', 'height']) {
    const v = isNum(L[k]) ? round(L[k]) : NaN; // check the rounded value: 0.00001 must not become 0
    if (!(v > 0) || v > LIMITS.maxExtent) err(k, `${k} must be a number between 0 and ${LIMITS.maxExtent}`);
    else L[k] = v;
  }
  if (L.grid === undefined) L.grid = 1;
  else if (!isNum(L.grid) || L.grid <= 0 || L.grid > 1000) err('grid', 'grid must be a positive number');

  if (L.background !== undefined && L.background !== null) {
    const b = L.background;
    if (!isObj(b)) err('background', 'background must be an object');
    else {
      if (typeof b.src !== 'string' || !BACKGROUND_SRC_RE.test(b.src) || b.src.includes('..')) {
        err('background.src', 'background.src must be an image (.png, .jpg, .jpeg, .webp or .gif) in layouts/assets/, e.g. "assets/sketch.jpg"');
      }
      for (const k of ['x', 'y']) if (!isNum(b[k])) err(`background.${k}`, `${k} must be a number`);
      for (const k of ['width', 'height']) if (!isNum(b[k]) || b[k] <= 0) err(`background.${k}`, `${k} must be a positive number`);
      if (b.opacity === undefined) b.opacity = 0.35;
      else if (!isNum(b.opacity) || b.opacity < 0 || b.opacity > 1) err('background.opacity', 'opacity must be between 0 and 1');
      if (b.visible === undefined) b.visible = false;
      else if (typeof b.visible !== 'boolean') err('background.visible', 'visible must be true or false');
      if (b.rotation !== undefined) checkRotation(b, 'background', err);
      if (b.corners !== undefined && b.corners !== null) {
        // 4-corner fit (TL, TR, BR, BL in layout units), rendered with a CSS matrix3d (DECISIONS D5).
        if (!Array.isArray(b.corners) || b.corners.length !== 4 || !b.corners.every(checkPoint)) {
          err('background.corners', 'corners must be four [x, y] points (top-left, top-right, bottom-right, bottom-left)');
        } else b.corners = b.corners.map(([x, y]) => [round(x), round(y)]);
      }
      unknownKeys(b, KNOWN_KEYS.background, 'background', warn);
    }
  }
  unknownKeys(L, KNOWN_KEYS.top, '', warn);
  if (L.views !== undefined) checkViews(L, err, warn);

  // --- collections -----------------------------------------------------------------------------
  const ids = new Set();
  let total = 0;
  for (const coll of LAYOUT_COLLECTIONS) {
    if (L[coll] === undefined) { L[coll] = []; continue; }
    if (!Array.isArray(L[coll])) { err(coll, `${coll} must be an array`); L[coll] = []; continue; }
    total += L[coll].length;
    L[coll].forEach((item, i) => {
      const p = `${coll}[${i}]`;
      if (!isObj(item)) { err(p, 'item must be an object'); return; }
      if (typeof item.id !== 'string' || !ITEM_ID_RE.test(item.id)) err(`${p}.id`, 'id must be 1-64 letters, digits, "_", "." or "-"');
      else if (RESERVED_IDS.has(item.id)) err(`${p}.id`, `id "${item.id}" is reserved`);
      else if (ids.has(item.id)) err(`${p}.id`, `duplicate id "${item.id}"`);
      else ids.add(item.id);
      ITEM_VALIDATORS[coll](item, p, err, warn);
      if (item.locked !== undefined && typeof item.locked !== 'boolean') err(`${p}.locked`, 'locked must be true or false');
      unknownKeys(item, KNOWN_KEYS[coll], p, warn);
      if (isNum(L.width) && isNum(L.height)) {
        const bb = itemBBox(coll, item);
        if (bb && (bb.maxX < -1 || bb.maxY < -1 || bb.minX > L.width + 1 || bb.minY > L.height + 1)) {
          const label = [item.name, item.text, item.id].find((v) => typeof v === 'string') ?? '';
          warn(p, `"${label}" lies outside the drawing area`);
        }
      }
    });
  }
  if (total > LIMITS.maxItems) err('', `Too many items (${total} > ${LIMITS.maxItems})`);

  return { ok: errors.length === 0, errors, warnings, layout: errors.length ? null : L };
}

function checkString(obj, key, path, max, required, err) {
  const v = obj[key];
  if (v === undefined || v === null) { if (required) err(path, `${key} is required`); return; }
  if (typeof v !== 'string') { err(path, `${key} must be text`); return; }
  if (required && !v.trim()) err(path, `${key} must not be empty`);
  if (v.length > max) err(path, `${key} is longer than ${max} characters`);
}

function unknownKeys(obj, known, path, warn) {
  for (const k of Object.keys(obj)) if (!known.has(k)) warn(path ? `${path}.${k}` : k, `Unknown property "${k}" (kept as-is)`);
}

function checkPoint(pt) {
  return Array.isArray(pt) && pt.length === 2 && isNum(pt[0]) && isNum(pt[1]);
}

function checkXY(item, p, err) {
  for (const k of ['x', 'y']) {
    if (!isNum(item[k])) err(`${p}.${k}`, `${k} must be a number`);
    else item[k] = round(item[k]);
  }
}

function checkRect(item, p, err) {
  checkXY(item, p, err);
  for (const k of ['w', 'h']) {
    const v = isNum(item[k]) ? round(item[k]) : NaN; // check the rounded value: 0.00001 must not become 0
    if (!(v > 0) || v > LIMITS.maxExtent) err(`${p}.${k}`, `${k} must be a positive number`);
    else item[k] = v;
  }
}

function checkRotation(item, p, err) {
  if (item.rotation === undefined) item.rotation = 0;
  else if (!isNum(item.rotation)) err(`${p}.rotation`, 'rotation must be a number of degrees');
  else {
    // Round BEFORE normalizing to (-180, 180], so e.g. -179.99999 → 180 rather than -180.
    let r = ((round(item.rotation) % 360) + 360) % 360;
    if (r > 180) r -= 360;
    item.rotation = round(r);
  }
}

function checkKind(item, p, def, err) {
  if (item.kind === undefined) item.kind = def;
  else if (typeof item.kind !== 'string' || !/^[a-z0-9-]{1,40}$/.test(item.kind)) err(`${p}.kind`, 'kind must be lowercase letters, digits or dashes');
  else if (RESERVED_IDS.has(item.kind)) err(`${p}.kind`, `kind "${item.kind}" is reserved`); // MACHINE_KINDS[kind] etc.
}

function checkBool(item, key, p, def, err) {
  if (item[key] === undefined) item[key] = def;
  else if (typeof item[key] !== 'boolean') err(`${p}.${key}`, `${key} must be true or false`);
}

/** Optional boolean without a default (absent keeps files small; readers apply the documented default). */
function checkOptionalBool(item, key, p, err) {
  if (item[key] !== undefined && typeof item[key] !== 'boolean') err(`${p}.${key}`, `${key} must be true or false`);
}

/** Top-level `views`: named crop rectangles for screen profiles (DECISIONS D4). */
function checkViews(L, err, warn) {
  if (!Array.isArray(L.views)) { err('views', 'views must be a list of named rectangles'); return; }
  if (L.views.length > MAX_VIEWS) err('views', `At most ${MAX_VIEWS} views`);
  const ids = new Set();
  L.views.forEach((v, i) => {
    const p = `views[${i}]`;
    if (!isObj(v)) { err(p, 'view must be an object'); return; }
    if (typeof v.id !== 'string' || !ITEM_ID_RE.test(v.id)) err(`${p}.id`, 'id must be 1-64 letters, digits, "_", "." or "-"');
    else if (RESERVED_IDS.has(v.id)) err(`${p}.id`, `id "${v.id}" is reserved`);
    else if (ids.has(v.id)) err(`${p}.id`, `duplicate view id "${v.id}"`);
    else ids.add(v.id);
    checkString(v, 'name', `${p}.name`, LIMITS.name, true, err);
    checkRect(v, p, err);
    unknownKeys(v, KNOWN_KEYS.views, p, warn);
  });
}

/** Machine `thresholds` (minutes; null = never) — per-machine attention overrides (DECISIONS D3). */
function checkThresholds(item, p, err, warn) {
  const t = item.thresholds;
  if (t === undefined || t === null) { if (t === null) delete item.thresholds; return; }
  if (!isObj(t)) { err(`${p}.thresholds`, 'thresholds must be an object like {"pausedWarnMinutes": 5}'); return; }
  for (const k of Object.keys(t)) {
    if (!THRESHOLD_KEYS.includes(k)) { warn(`${p}.thresholds.${k}`, `Unknown threshold "${k}" (kept as-is)`); continue; }
    const v = t[k];
    if (v !== null && (!isNum(v) || v < 0 || v > 100000)) err(`${p}.thresholds.${k}`, `${k} must be a number of minutes (0-100000) or null`);
  }
}

/** Machine `statusMap`, e.g. {"STOPPED": "PAUSED"} for adapters that report M00 as STOPPED, or a key scoped to one
 *  type such as {"EXECUTION:STOPPED": "PAUSED"} (DECISIONS D1). */
function checkStatusMap(item, p, err) {
  const m = item.statusMap;
  if (m === undefined || m === null) { if (m === null) delete item.statusMap; return; }
  if (!isObj(m)) { err(`${p}.statusMap`, 'statusMap must be an object like {"STOPPED": "PAUSED"}'); return; }
  const keys = Object.keys(m);
  if (keys.length > 32) err(`${p}.statusMap`, 'statusMap has more than 32 entries');
  for (const k of keys) {
    if (!statusMapKeyOk(k)) err(`${p}.statusMap.${k.slice(0, 40)}`, 'statusMap keys are MTConnect values like STOPPED or extension literals like x:BURN, optionally as TYPE:VALUE like EXECUTION:STOPPED (TYPE = EXECUTION, CONTROLLER_MODE or FUNCTIONAL_MODE)');
    else if (typeof m[k] !== 'string' || !STATUS_MAP_TARGETS.includes(m[k])) err(`${p}.statusMap.${k}`, `must map to one of ${STATUS_MAP_TARGETS.join(', ')}`);
  }
}

const ITEM_VALIDATORS = {
  walls(item, p, err) {
    if (!Array.isArray(item.points) || item.points.length < 2 || !item.points.every(checkPoint)) {
      err(`${p}.points`, 'points must be a list of at least two [x, y] pairs');
    } else item.points = item.points.map(([x, y]) => [round(x), round(y)]);
    checkBool(item, 'closed', p, false, err);
    if (item.style === undefined) item.style = 'interior';
    else if (typeof item.style !== 'string' || !/^[a-z-]{1,30}$/.test(item.style) || RESERVED_IDS.has(item.style)) err(`${p}.style`, 'style must be exterior, interior, partition or former');
    if (item.thickness === undefined) item.thickness = own(WALL_STYLES, item.style)?.defaultThickness ?? 0.4;
    else if (!isNum(item.thickness) || item.thickness <= 0 || item.thickness > 20) err(`${p}.thickness`, 'thickness must be a positive number');
    if (item.label !== undefined) checkString(item, 'label', `${p}.label`, LIMITS.name, false, err);
  },
  doors(item, p, err) {
    checkXY(item, p, err);
    if (!isNum(item.width) || item.width <= 0 || item.width > 1000) err(`${p}.width`, 'width must be a positive number');
    checkRotation(item, p, err);
    checkKind(item, p, 'door', err);
    if (item.swing === undefined) item.swing = item.kind === 'door' || item.kind === 'double' ? 'left' : 'none';
    else if (!['left', 'right', 'none'].includes(item.swing)) err(`${p}.swing`, 'swing must be left, right or none');
    if (item.label !== undefined) checkString(item, 'label', `${p}.label`, LIMITS.name, false, err);
  },
  rooms(item, p, err) {
    checkString(item, 'name', `${p}.name`, LIMITS.name, true, err);
    checkKind(item, p, 'other', err);
    if (item.points !== undefined) {
      if (!Array.isArray(item.points) || item.points.length < 3 || !item.points.every(checkPoint)) {
        err(`${p}.points`, 'points must be a list of at least three [x, y] pairs');
      } else item.points = item.points.map(([x, y]) => [round(x), round(y)]);
    } else checkRect(item, p, err);
    checkBool(item, 'showLabel', p, true, err);
    if (item.labelOffset !== undefined && !checkPoint(item.labelOffset)) err(`${p}.labelOffset`, 'labelOffset must be [dx, dy]');
  },
  objects(item, p, err) {
    checkString(item, 'name', `${p}.name`, LIMITS.name, true, err);
    checkKind(item, p, 'generic', err);
    checkRect(item, p, err);
    checkRotation(item, p, err);
    checkBool(item, 'showLabel', p, true, err);
    if (item.notes !== undefined) checkString(item, 'notes', `${p}.notes`, LIMITS.notes, false, err);
    checkOptionalBool(item, 'hud', p, err);
  },
  labels(item, p, err) {
    checkString(item, 'text', `${p}.text`, LIMITS.text, true, err);
    checkXY(item, p, err);
    if (item.style === undefined) item.style = 'note';
    else if (typeof item.style !== 'string' || !/^[a-z-]{1,30}$/.test(item.style) || RESERVED_IDS.has(item.style)) err(`${p}.style`, 'style must be title, room, note or dim');
    if (item.size === undefined) item.size = own(LABEL_STYLES, item.style)?.size ?? 1;
    else if (!isNum(item.size) || item.size <= 0 || item.size > 100) err(`${p}.size`, 'size must be a positive number');
    checkRotation(item, p, err);
    checkOptionalBool(item, 'hud', p, err);
  },
  machines(item, p, err, warn) {
    checkString(item, 'name', `${p}.name`, LIMITS.name, true, err);
    checkKind(item, p, 'other', err);
    checkRect(item, p, err);
    checkRotation(item, p, err);
    if (item.source === undefined || item.source === null) item.source = null;
    else {
      // Every protocol (MTConnect, FOCAS, Haas MDC, OPC UA) + identity keys: src/shared/sources.js.
      const r = validateSource(item.source, `${p}.source`);
      for (const e of r.errors) err(e.path, e.message);
      item.source = r.errors.length ? item.source : r.source;
    }
    checkThresholds(item, p, err, warn);
    checkStatusMap(item, p, err);
    if (item.notes !== undefined) checkString(item, 'notes', `${p}.notes`, LIMITS.notes, false, err);
    if (item.tags !== undefined) {
      if (!Array.isArray(item.tags) || item.tags.length > 20 || !item.tags.every((t) => typeof t === 'string' && t.length <= 40)) {
        err(`${p}.tags`, 'tags must be a list of up to 20 short strings');
      }
    }
  },
};

export function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------------------------

/** A new, empty, valid layout. */
export function emptyLayout({ id = 'new-layout', name = 'New layout', width = 80, height = 60, units = 'ft' } = {}) {
  return {
    schema: LAYOUT_SCHEMA, id, name, units, width, height, grid: 1,
    walls: [{ id: 'w-exterior', points: [[0, 0], [width, 0], [width, height], [0, height]], closed: true, style: 'exterior', thickness: WALL_STYLES.exterior.defaultThickness }],
    doors: [], rooms: [], objects: [], labels: [], machines: [],
  };
}

/** Iterate every item: yields [collection, item, index]. */
export function* allItems(layout) {
  for (const coll of LAYOUT_COLLECTIONS) {
    const arr = layout?.[coll];
    if (Array.isArray(arr)) for (let i = 0; i < arr.length; i++) yield [coll, arr[i], i];
  }
}

/** Find an item by id → { collection, index, item } or null. */
export function findItem(layout, id) {
  for (const [collection, item, index] of allItems(layout)) if (item?.id === id) return { collection, index, item };
  return null;
}

/** A fresh id unique within the layout, e.g. newId(layout, 'machines') → 'm-7'. */
export function newId(layout, collection) {
  const prefix = own(ID_PREFIX, collection) ?? 'i';
  const used = new Set([...allItems(layout)].map(([, it]) => it?.id));
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let n = 1;
  for (const id of used) {
    const m = typeof id === 'string' ? id.match(re) : null;
    const k = m ? Number(m[1]) : NaN;
    if (Number.isSafeInteger(k) && k >= n) n = k + 1;
  }
  if (!Number.isSafeInteger(n)) n = 1; // e.g. "m-9007199254740991" in use: fall back to the first free number
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

// ---------------------------------------------------------------------------------------------
// Geometry (layout units; y down; rotation clockwise in degrees)
// ---------------------------------------------------------------------------------------------

export function rotatePoint([x, y], [cx, cy], deg) {
  if (!deg) return [x, y];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export function rectCenter(it) {
  return [it.x + it.w / 2, it.y + it.h / 2];
}

/** Corners of a (possibly rotated) rect item in order TL, TR, BR, BL. */
export function rectCorners(it) {
  const c = rectCenter(it);
  return [[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]]
    .map((p) => rotatePoint(p, c, it.rotation || 0));
}

function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Axis-aligned bounding box of any layout item (null if geometry is invalid). */
export function itemBBox(collection, it) {
  try {
    if (collection === 'walls') return Array.isArray(it.points) ? bboxOf(it.points) : null;
    if (collection === 'rooms' && Array.isArray(it.points)) return bboxOf(it.points);
    if (collection === 'labels') return isNum(it.x) && isNum(it.y) ? { minX: it.x, minY: it.y, maxX: it.x, maxY: it.y } : null;
    if (collection === 'doors') {
      if (!isNum(it.x) || !isNum(it.y) || !isNum(it.width)) return null;
      const h = it.width / 2;
      return bboxOf([rotatePoint([it.x - h, it.y], [it.x, it.y], it.rotation || 0), rotatePoint([it.x + h, it.y], [it.x, it.y], it.rotation || 0)]);
    }
    if (![it.x, it.y, it.w, it.h].every(isNum)) return null;
    return bboxOf(rectCorners(it));
  } catch {
    return null;
  }
}

/** Snap a value to the grid. */
export function snap(v, grid) {
  return Number.isFinite(grid) && grid > 0 ? Math.round(v / grid) * grid : v;
}
