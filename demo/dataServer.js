// Stacklight public demo: program transfer (DECISIONS D16) against simulated FANUC Data Servers, in the visitor's
// browser (scripts/demo-site/backend.js routes /api/programs* and /api/machines/:id/programs* here).
//
// The same rules and answers as src/programs/service.js: names are checked; an existing program is replaced only when
// asked (409 EXISTS); the program a machine is running or has selected is never replaced or deleted (423 IN_USE);
// the machine's copy is kept before every replace and delete, and History can put it back once. Files are seeded
// with programs the showcase machines run plus a few others, live in memory only and reset when the page reloads.
// Downloads come back with CR LF lines, as an ASCII transfer gives them.

/** Program names the HUD sends: letters, digits, dot, dash, underscore; no path (src/programs/store.js). */
export const PROGRAM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_UPLOAD_MB = 100;
const UNDOABLE = new Set(['replaced', 'deleted', 'putback', 'moved', 'copied']);
const enc = new TextEncoder();
const dec = new TextDecoder('latin1');

export class DemoProgramError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * A program's name for the running-program lock, as src/programs/service.js: no folder, no ".NC", upper case, and an
 * O-number without its leading zeros (programId in src/shared/runs.js), so "O1" is "O0001".
 */
export function normalizeProgramName(n) {
  const base = String(n ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const s = base.trim().replace(/\.NC$/i, '');
  const m = /^O?0*(\d{1,9})$/i.exec(s);
  return m ? `O${m[1]}` : s.toUpperCase();
}

const text = (data) => dec.decode(data.subarray(0, 4096));

/** Comment of a FANUC program: the first "( … )" on its header line (src/programs/store.js). */
export function programComment(data) {
  const lines = text(data).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  while (lines.length && /^%/.test(lines[0])) lines.shift();
  const m = /\(([^()\r\n]{1,120})\)/.exec(lines[0] ?? '');
  const c = m ? m[1].replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return c || null;
}

/** First line that is not blank or only "%" (src/programs/store.js programFirstLine). */
export function programFirstLine(data) {
  for (const raw of text(data).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line && line !== '%') return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  return '';
}

/** A believable FANUC mill or wire program for the demo folders (deterministic for a given name). */
export function sampleProgram(name, comment, { kind = 'mill', lines = 120 } = {}) {
  let seed = 0;
  for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const n = (v) => v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.');
  const out = ['%', `${name} (${comment})`];
  if (kind === 'wire') {
    out.push('(WIRE 0.25 BRASS)', 'G90 G92 X0. Y0.', 'M60', 'G41 D1');
    for (let i = 0; i < lines; i++) out.push(`G01 X${n(rnd() * 3 - 1.5)} Y${n(rnd() * 3 - 1.5)}`);
    out.push('G40', 'M50', 'M30', '%');
  } else {
    out.push('G20 G90 G40 G80 G17', 'T1 M06', `S${6000 + Math.floor(rnd() * 40) * 100} M03`, 'G54 G00 X0. Y0.', 'G43 H01 Z1.', 'M08');
    for (let i = 0; i < lines; i++) {
      out.push(i % 9 === 0
        ? `G00 X${n(rnd() * 8)} Y${n(rnd() * 6)}`
        : `G01 X${n(rnd() * 8)} Y${n(rnd() * 6)} Z${n(-rnd() * 0.5)} F${(20 + Math.floor(rnd() * 60))}.`);
    }
    out.push('G00 Z1.', 'M09', 'G91 G28 Z0.', 'M30', '%');
  }
  return `${out.join('\n')}\n`;
}

/** A folder the explorer opens (src/programs/store.js isFolderName) and one it makes (NEW_FOLDER_RE). */
const isFolderName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 64 && n.trim() === n
  && !/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(n) && !/^\.+$/.test(n);
const NEW_FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_FOLDER_DEPTH = 8;
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });
const folderNode = (modified) => ({ files: new Map(), folders: new Map(), modified });

/**
 * @param {{ now?: () => number,
 *           machines: Array<{ id: string, name: string, host?: string, files: Array<{ name: string, text: string, modified: number, dir?: string }>,
 *                             history?: Array<object> }>,
 *           getUse: (id: string) => { known: boolean, running: boolean, program: string|null } }} o
 *   a file's `dir` ('BACKUP', 'A/B') seeds it in that folder
 */
export function createDemoDataServer({ now = Date.now, machines, getUse }) {
  const servers = new Map();
  let seq = 0;
  for (const m of machines) {
    const root = folderNode(now());
    for (const f of m.files) {
      let at = root;
      for (const part of String(f.dir ?? '').split('/').filter(Boolean)) {
        if (!at.folders.has(part)) at.folders.set(part, folderNode(f.modified));
        at = at.folders.get(part);
      }
      at.files.set(f.name, { data: enc.encode(f.text), modified: f.modified });
    }
    const kept = new Map();
    const history = [];
    for (const e of m.history ?? []) {
      const entry = { ...e };
      if (e.kept) { const keptId = `seed-${++seq}`; kept.set(keptId, enc.encode(e.kept)); entry.keptId = keptId; delete entry.kept; }
      history.unshift(entry);
    }
    servers.set(m.id, { id: m.id, name: m.name, host: m.host ?? null, root, kept, history });
  }
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;

  function server(id) {
    const s = servers.get(id);
    if (!s) throw new DemoProgramError(404, 'NOT_FOUND', 'No such machine on the active layout');
    return s;
  }
  function checkName(name) {
    if (typeof name !== 'string' || !PROGRAM_NAME_RE.test(name) || /^\.+$/.test(name)) {
      throw new DemoProgramError(400, 'BAD_NAME', 'Program names may use letters, digits, dot, dash and underscore (max 64), with no spaces or folders');
    }
  }
  /** 'A/B' or ['A', 'B'] → folder names (as src/programs/service.js parseDir). */
  function parseDir(dir) {
    const parts = Array.isArray(dir) ? dir : typeof dir === 'string' ? dir.split('/').filter((x) => x !== '') : [];
    if (parts.length > MAX_FOLDER_DEPTH || !parts.every(isFolderName)) throw new DemoProgramError(400, 'BAD_FOLDER', `Invalid folder (up to ${MAX_FOLDER_DEPTH} levels of names without slashes)`);
    return parts;
  }
  /** The folder at `dir`, or FOLDER_NOT_FOUND. */
  function folderAt(s, dir) {
    let at = s.root;
    for (let i = 0; i < dir.length; i++) {
      at = at.folders.get(dir[i]);
      if (!at) throw new DemoProgramError(404, 'FOLDER_NOT_FOUND', `The folder ${dir.slice(0, i + 1).join(' › ')} is not on ${s.name} any more. Refresh the list.`, { dir: dir.slice(0, i + 1) });
    }
    return at;
  }
  const label = (s, dir) => (dir.length ? `${s.name} › ${dir.join(' › ')}` : s.name);
  const dirField = (dir) => (dir.length ? { dir: dir.join('/') } : {});
  const find = (f, name) => f.files.get(name) ? name : [...f.files.keys()].find((k) => k.toUpperCase() === name.toUpperCase()) ?? null;
  /** The listed program a write lands on: that name, else the same program under another spelling (as service.js). */
  const existingFor = (f, name) => find(f, name) ?? [...f.files.keys()].find((k) => normalizeProgramName(k) === normalizeProgramName(name)) ?? null;
  function use(id) {
    const u = getUse(id) ?? {};
    const names = new Set([u.program].filter((x) => typeof x === 'string' && x).map(normalizeProgramName));
    return { known: !!u.known, running: !!u.running, program: u.program ?? null, names };
  }
  function checkNotInUse(s, name, verb) {
    const u = use(s.id);
    if (!u.known) {
      throw new DemoProgramError(409, 'STATUS_UNKNOWN', `The HUD has no live status from ${s.name}, so it cannot tell which program is in use. Programs can only be ${verb === 'delete' ? 'deleted' : 'replaced'} while the HUD sees the machine.`, { verb });
    }
    if (u.names.has(normalizeProgramName(name))) {
      const now2 = { delete: 'deletes', replace: 'replaces', move: 'moves' }[verb] ?? 'changes';
      throw new DemoProgramError(423, 'IN_USE', `${name} is ${u.running ? 'running' : 'selected'} on ${s.name}. The HUD never ${now2} a program that is running or selected.`, { name, running: u.running, verb });
    }
    return u;
  }
  function keep(s, data) {
    const keptId = `k${++seq}`;
    s.kept.set(keptId, data);
    return keptId;
  }
  function append(s, entry) {
    const e = { id: `h${Date.now().toString(36)}-${++seq}`, at: now(), from: null, ...entry };
    s.history.unshift(e);
    if (s.history.length > 200) s.history.length = 200;
    return e;
  }

  return {
    /** GET /api/programs (setup is not part of the demo, but the answer is complete). */
    overview() {
      return {
        enabled: true, maxUploadMB: MAX_UPLOAD_MB,
        machines: [...servers.values()].map((s) => ({ id: s.id, name: s.name, protocol: 'focas', enabled: true, host: s.host, linkedHost: s.host, port: 21, folder: null, loginSaved: true, credentialsRef: null, transferMode: 'ascii' })),
      };
    },
    has: (id) => servers.has(id),

    list(id, { dir: dirIn = [] } = {}) {
      const s = server(id);
      const dir = parseDir(dirIn);
      const at = folderAt(s, dir);
      const u = use(id);
      const files = [...at.files.entries()].map(([name, f]) => ({
        name, size: f.data.length, modified: f.modified, comment: programComment(f.data), firstLine: programFirstLine(f.data),
        inUse: u.known && u.names.has(normalizeProgramName(name)),
      })).sort(byName);
      const folders = [...at.folders.entries()].map(([name, f]) => ({ name, modified: f.modified })).sort(byName);
      return {
        machine: { id, name: s.name, host: s.host, port: 21, folder: null },
        dir, folders, canGoDeeper: dir.length < MAX_FOLDER_DEPTH,
        status: { known: u.known, running: u.running, program: u.program },
        files, firstLinesPending: 0, maxUploadMB: MAX_UPLOAD_MB,
      };
    },

    firstLines(id) { server(id); return { lines: {}, pending: 0 }; },

    /** The program as an ASCII transfer gives it (CR LF lines). */
    download(id, name, { dir: dirIn = [] } = {}) {
      const s = server(id);
      checkName(name);
      const dir = parseDir(dirIn);
      const at = folderAt(s, dir);
      const key = find(at, name);
      if (!key) throw new DemoProgramError(404, 'NOT_FOUND', 'That program is not on the machine any more. Refresh the list.');
      const data = enc.encode(dec.decode(at.files.get(key).data).replace(/\r?\n/g, '\r\n'));
      append(s, { action: 'downloaded', name: key, ...dirField(dir), size: data.length, result: 'done' });
      return { data, name: key };
    },

    upload(id, name, data, { replace = false, dir: dirIn = [] } = {}) {
      const s = server(id);
      checkName(name);
      const dir = parseDir(dirIn);
      if (!(data instanceof Uint8Array) || !data.length) throw new DemoProgramError(400, 'EMPTY', 'The file is empty');
      if (data.length > maxBytes) throw new DemoProgramError(413, 'TOO_LARGE', `Programs larger than ${MAX_UPLOAD_MB} MB are not sent`);
      if (data.includes(0)) throw new DemoProgramError(415, 'NOT_A_PROGRAM', 'This file contains binary data, so it is not an NC program');
      const at = folderAt(s, dir);
      const key = existingFor(at, name);
      let u = use(id);
      let keptId = null;
      let old = null;
      if (key) {
        old = at.files.get(key);
        if (!replace) {
          throw new DemoProgramError(409, 'EXISTS', `${key} is already in ${label(s, dir)}`, { name: key, size: old.data.length, modified: old.modified, running: u.known && u.running, program: u.program });
        }
        u = checkNotInUse(s, key, 'replace');
        keptId = keep(s, old.data);
      }
      const target = key ?? name;
      // an ASCII transfer: the control keeps LF line ends
      const stored = enc.encode(dec.decode(data).replace(/\r\n?/g, '\n'));
      at.files.set(target, { data: stored, modified: now() });
      const entry = append(s, {
        action: key ? 'replaced' : 'sent', name: target, ...dirField(dir), size: data.length, result: 'checked',
        ...(keptId ? { keptId, keptSize: old.data.length, keptModified: old.modified } : {}),
      });
      return { ok: true, action: key ? 'replaced' : 'sent', name: target, dir, size: data.length, keptId, entryId: entry.id, comment: programComment(stored), running: u.known && u.running };
    },

    remove(id, name, { dir: dirIn = [] } = {}) {
      const s = server(id);
      checkName(name);
      const dir = parseDir(dirIn);
      const at = folderAt(s, dir);
      const key = find(at, name);
      if (!key) throw new DemoProgramError(404, 'NOT_FOUND', `${name} is not in ${label(s, dir)}. Refresh the list.`);
      checkNotInUse(s, key, 'delete');
      const old = at.files.get(key);
      const keptId = keep(s, old.data);
      at.files.delete(key);
      const entry = append(s, { action: 'deleted', name: key, ...dirField(dir), size: old.data.length, keptId, keptSize: old.data.length, keptModified: old.modified, result: 'done' });
      return { ok: true, action: 'deleted', name: key, dir, keptId, entryId: entry.id };
    },

    /** Copy (or move) a program into another folder (src/programs/service.js copy). */
    copy(id, name, { dir: dirIn = [], toDir: toDirIn, move = false, replace = false } = {}) {
      const s = server(id);
      checkName(name);
      const dir = parseDir(dirIn);
      if (toDirIn == null) throw new DemoProgramError(400, 'BAD_FOLDER', 'Choose a folder');
      const toDir = parseDir(toDirIn);
      if (dir.join('/') === toDir.join('/')) throw new DemoProgramError(400, 'SAME_FOLDER', `${name} is already in ${label(s, dir)}`);
      const src = folderAt(s, dir);
      const dst = folderAt(s, toDir);
      const key = find(src, name);
      if (!key) throw new DemoProgramError(404, 'NOT_FOUND', `${name} is not in ${label(s, dir)}. Refresh the list.`);
      if (move) checkNotInUse(s, key, 'move');
      const f = src.files.get(key);
      const there = existingFor(dst, key);
      let keptId = null;
      let old = null;
      if (there) {
        old = dst.files.get(there);
        if (!replace) {
          const u = use(id);
          throw new DemoProgramError(409, 'EXISTS', `${there} is already in ${label(s, toDir)}`, { name: there, size: old.data.length, modified: old.modified, running: u.known && u.running, program: u.program, toDir });
        }
        checkNotInUse(s, there, 'replace');
        keptId = keep(s, old.data);
      }
      dst.files.set(there ?? key, { data: f.data, modified: now() });
      if (!move) {
        const entry = append(s, { action: 'copied', name: key, dir: toDir.join('/'), fromDir: dir.join('/'), size: f.data.length, result: 'checked', ...(keptId ? { keptId, keptSize: old.data.length, keptModified: old.modified } : {}) });
        return { ok: true, action: 'copied', name: key, dir, toDir, entryId: entry.id, keptId };
      }
      if (keptId) append(s, { action: 'replaced', name: key, ...dirField(toDir), size: f.data.length, result: 'checked', keptId, keptSize: old.data.length, keptModified: old.modified });
      const origId = keep(s, f.data);
      src.files.delete(key);
      const entry = append(s, { action: 'moved', name: key, dir: dir.join('/'), toDir: toDir.join('/'), size: f.data.length, result: 'checked', keptId: origId, keptSize: f.data.length, keptModified: f.modified });
      return { ok: true, action: 'moved', name: key, dir, toDir, entryId: entry.id, keptId: origId };
    },

    makeFolder(id, name, { dir: dirIn = [] } = {}) {
      const s = server(id);
      const dir = parseDir(dirIn);
      if (typeof name !== 'string' || !NEW_FOLDER_RE.test(name) || /^\.+$/.test(name)) {
        throw new DemoProgramError(400, 'BAD_FOLDER_NAME', 'Folder names may use letters, digits, dot, dash and underscore (up to 32), with no spaces');
      }
      if (dir.length >= MAX_FOLDER_DEPTH) throw new DemoProgramError(400, 'TOO_DEEP', `Folders go at most ${MAX_FOLDER_DEPTH} levels deep here`);
      const at = folderAt(s, dir);
      const clash = [...at.folders.keys(), ...at.files.keys()].find((k) => k.toUpperCase() === name.toUpperCase());
      if (clash) throw new DemoProgramError(409, 'FOLDER_EXISTS', `${label(s, dir)} already has ${clash}`);
      at.folders.set(name, folderNode(now()));
      const entry = append(s, { action: 'folder-made', name, ...dirField(dir), result: 'done' });
      return { ok: true, action: 'folder-made', name, dir, entryId: entry.id };
    },

    removeFolder(id, name, { dir: dirIn = [] } = {}) {
      const s = server(id);
      const dir = parseDir(dirIn);
      const at = folderAt(s, dir);
      const f = at.folders.get(name);
      if (!f) throw new DemoProgramError(404, 'FOLDER_NOT_FOUND', `The folder ${name} is not in ${label(s, dir)} any more. Refresh the list.`);
      const count = f.files.size + f.folders.size;
      if (count) throw new DemoProgramError(409, 'FOLDER_NOT_EMPTY', `${name} is not empty (${count} item${count === 1 ? '' : 's'}). Only empty folders are deleted: move or delete what is in it first.`, { count });
      at.folders.delete(name);
      const entry = append(s, { action: 'folder-deleted', name, ...dirField(dir), result: 'done' });
      return { ok: true, action: 'folder-deleted', name, dir, entryId: entry.id };
    },

    history(id) {
      const s = server(id);
      const restored = new Set(s.history.filter((e) => e.action === 'putback' && e.restores).map((e) => e.restores));
      return s.history.map((e) => ({
        id: e.id, at: e.at, action: e.action, name: e.name, dir: typeof e.dir === 'string' && e.dir ? e.dir.split('/') : [],
        ...(typeof e.toDir === 'string' ? { toDir: e.toDir ? e.toDir.split('/') : [] } : {}),
        ...(typeof e.fromDir === 'string' ? { fromDir: e.fromDir ? e.fromDir.split('/') : [] } : {}),
        size: e.size ?? null, from: e.from ?? null, result: e.result, error: e.error ?? null,
        keptModified: e.keptModified ?? null, keptSize: e.keptSize ?? null, restores: e.restores ?? null, restoredModified: e.restoredModified ?? null,
        canPutBack: UNDOABLE.has(e.action) && !!e.keptId && s.kept.has(e.keptId) && !restored.has(e.id),
      }));
    },

    putBack(id, entryId) {
      const s = server(id);
      const e = s.history.find((x) => x.id === entryId);
      if (!e || !UNDOABLE.has(e.action) || !e.keptId) throw new DemoProgramError(404, 'NOT_FOUND', 'Nothing to put back for this entry');
      if (s.history.some((x) => x.action === 'putback' && x.restores === e.id)) throw new DemoProgramError(409, 'ALREADY_PUT_BACK', 'This copy has already been put back');
      const data = s.kept.get(e.keptId);
      if (!data) throw new DemoProgramError(410, 'KEPT_COPY_GONE', 'The kept copy is no longer on the HUD PC');
      // back into the folder it came from
      const dir = parseDir(typeof e.dir === 'string' ? e.dir : []);
      const at = folderAt(s, dir);
      const key = existingFor(at, e.name);
      let keptId = null;
      let cur = null;
      if (key) {
        checkNotInUse(s, key, 'replace');
        cur = at.files.get(key);
        keptId = keep(s, cur.data);
      }
      at.files.set(key ?? e.name, { data, modified: now() });
      const entry = append(s, {
        action: 'putback', name: e.name, ...dirField(dir), size: data.length, restores: e.id, result: 'checked',
        ...(keptId ? { keptId, keptSize: cur.data.length, keptModified: cur.modified } : {}), restoredModified: e.keptModified ?? null,
      });
      return { ok: true, action: 'putback', name: e.name, dir, size: data.length, entryId: entry.id, keptId };
    },
  };
}
