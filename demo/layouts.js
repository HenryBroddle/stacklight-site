// Stacklight public demo: the layout editor's saves, kept in the visitor's own browser (DECISIONS D17).
//
// scripts/demo-site/backend.js routes /api/layouts* here. The demo has one layout, the recorded showcase shop.
// Saving checks the layout with the product's own rules (src/shared/layout.js validateLayout, passed in) and keeps
// it in localStorage, with the last saved versions for the editor's History. Nothing leaves the browser. A stored
// layout belongs to the recording it was made from (its ETag), so a new recording on the site starts fresh. reset()
// goes back to the recorded layout.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_VERSIONS = 20;

export class DemoLayoutError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** FNV-1a of the JSON text, as 8 hex digits. */
export function layoutHash(layout) {
  let h = 0x811c9dc5;
  const s = JSON.stringify(layout);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 20261119-132105123 (sorts by time), like the server's version names. */
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

/**
 * @param {{ base: object, baseEtag: string, storage?: Storage|null, key?: string,
 *           validate: (doc: object, o: { expectedId: string }) => { ok: boolean, errors: object[], warnings?: object[], layout: object|null },
 *           now?: () => number, updatedAt?: number }} o
 */
export function createDemoLayouts({ base, baseEtag, storage = null, key = 'stacklight-demo.layout', validate, now = Date.now, updatedAt = null }) {
  const id = base?.id;
  if (typeof id !== 'string') throw new Error('the recording has no layout');
  let saved = load();

  function load() {
    try {
      const v = JSON.parse(storage?.getItem(key) ?? 'null');
      return isObj(v) && v.baseEtag === baseEtag && isObj(v.layout) && v.layout.id === id ? v : null;
    } catch { return null; }
  }
  function persist() {
    try {
      if (saved) storage?.setItem(key, JSON.stringify(saved));
      else storage?.removeItem(key);
      return true;
    } catch { return false; } // private window or full storage: kept for this page only
  }
  function current() {
    return saved
      ? { layout: saved.layout, etag: saved.etag, updatedAt: saved.savedAt }
      : { layout: base, etag: baseEtag, updatedAt: updatedAt ?? now() };
  }
  function check(layoutId) {
    if (layoutId !== id) throw new DemoLayoutError(404, 'NOT_FOUND', `Layout "${layoutId}" not found (the demo has one layout)`);
  }

  /** Store a checked layout; the one it replaces goes to the versions. */
  function put(doc, { ifMatch, reason }) {
    const cur = current();
    if (ifMatch && ifMatch !== cur.etag) {
      throw new DemoLayoutError(412, 'PRECONDITION_FAILED', 'The layout was saved in another tab since you opened it. Reload to see it.', { etag: cur.etag });
    }
    const v = validate(doc, { expectedId: id });
    if (!v.ok) throw new DemoLayoutError(400, 'INVALID', 'The layout has problems the server would refuse', { errors: v.errors });
    const hash = layoutHash(v.layout);
    const etag = `"demo-${hash}"`;
    if (etag === cur.etag) return { id, layout: structuredClone(v.layout), etag, warnings: v.warnings ?? [], updatedAt: cur.updatedAt, changed: false };
    const t = now();
    const versions = [{ version: `${stamp(cur.updatedAt)}-${layoutHash(cur.layout)}`, savedAt: cur.updatedAt, layout: cur.layout }, ...(saved?.versions ?? [])].slice(0, MAX_VERSIONS);
    saved = { baseEtag, layout: v.layout, etag, savedAt: t, versions, reason };
    const stored = persist();
    return { id, layout: structuredClone(v.layout), etag, warnings: v.warnings ?? [], updatedAt: t, changed: true, stored };
  }

  return {
    id,
    /** True when this browser has its own saved layout. */
    get custom() { return !!saved; },
    current,
    list() {
      const c = current();
      return {
        activeLayout: id,
        layouts: [{ id, name: c.layout.name ?? null, updatedAt: c.updatedAt, valid: true, loaded: true, etag: c.etag, warnings: 0, active: true, screens: [], live: true }],
        diagnostics: [],
      };
    },
    get(layoutId) { check(layoutId); return current(); },
    save(layoutId, doc, { ifMatch } = {}) { check(layoutId); return put(doc, { ifMatch, reason: 'saved' }); },
    /** POST /api/layouts: the demo keeps its one layout, so only that id is accepted. */
    create(doc) {
      if (!isObj(doc) || doc.id !== id) throw new DemoLayoutError(403, 'DEMO_ONE_LAYOUT', 'The demo keeps one layout. Edit this one instead.');
      return put(doc, { reason: 'saved' });
    },
    versions(layoutId) {
      check(layoutId);
      return (saved?.versions ?? []).map((v) => ({ version: v.version, savedAt: v.savedAt, hash: v.version.split('-').pop(), deleted: false, bytes: JSON.stringify(v.layout).length }));
    },
    readVersion(layoutId, version) {
      check(layoutId);
      const v = (saved?.versions ?? []).find((x) => x.version === version);
      if (!v) throw new DemoLayoutError(404, 'NOT_FOUND', 'No such version');
      return { id, version, layout: v.layout, valid: true, errors: [] };
    },
    restore(layoutId, version, { ifMatch } = {}) {
      check(layoutId);
      const v = (saved?.versions ?? []).find((x) => x.version === version);
      if (!v) throw new DemoLayoutError(404, 'NOT_FOUND', 'No such version');
      return put(v.layout, { ifMatch, reason: 'restored' });
    },
    /** Back to the recorded layout (the visitor's saves are dropped). */
    reset() { saved = null; persist(); return current(); },
  };
}
