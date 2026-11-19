// Link a device the HUD found to a machine on the plan, straight from the Discovery drawer (DECISIONS D14): suggest
// the machine whose plan entry fits the device (maker, protocol, control family, model, axis count), let the user
// pick, then save the layout with If-Match. On a 401 the API client's token provider asks for the edit token. The
// suggestion is only ever pre-sorted and labelled; nothing is linked without a click.
import { validateSource, describeSource } from '/shared/sources.js';
import { iconSvg } from './icons.js';

const PROTOCOL_WORDS = Object.freeze({
  focas: /\bfocas/i,
  mtconnect: /\bmtconnect/i,
  'haas-mdc': /\b(mdc|q-commands?)\b/i,
  opcua: /\bopc[ -]?ua\b/i,
});

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

/**
 * Words in a control or machine model that a plan entry may repeat: the FANUC family ("Series 31i-B (M)" → "31i")
 * and model-like tokens with letters and digits ("MB-4000H", "VF-2", "31i-b", "osp-p300m").
 * @param {string} model
 * @returns {{ family: string|null, tokens: string[] }}
 */
export function modelTokens(model) {
  const m = lower(model);
  const family = /\b(\d{1,2}i)(?![a-z])/.exec(m)?.[1] ?? null;
  const tokens = [...new Set(m.split(/[\s(),/]+/).map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => t.length >= 3 && /[a-z]/.test(t) && /\d/.test(t)))];
  return { family, tokens };
}

/**
 * How well a found device fits a machine on the plan. Evidence from the machine's name and notes: its maker (+2),
 * its protocol (+1), the control family such as "31i" (+1), a model token such as "MB-4000H" (+2 each, at most 4);
 * and the kind: +2 when the axis count/kind agrees (a FANUC wire control reports "edm"; the plan says "wire-edm"),
 * −2 when both are known and differ.
 * @param {{ vendor?: string|null, model?: string|null, protocol?: string|null, kind?: string|null }} device
 * @param {{ name?: string, notes?: string, kind?: string }} machine
 */
export function matchScore(device, machine) {
  const text = `${lower(machine?.name)} ${lower(machine?.notes)}`;
  let score = 0;
  const vendor = lower(device?.vendor).trim();
  if (vendor && text.includes(vendor)) score += 2;
  const pw = PROTOCOL_WORDS[device?.protocol];
  if (pw && pw.test(text)) score += 1;
  const { family, tokens } = modelTokens(device?.model);
  if (family && new RegExp(`\\b${family}(?![a-z])`).test(text)) score += 1;
  score += Math.min(4, tokens.filter((t) => text.includes(t)).length * 2);
  const dk = lower(device?.kind), mk = lower(machine?.kind);
  const known = (k) => k && k !== 'unknown' && k !== 'other';
  if (known(dk) && known(mk)) score += kindsAgree(dk, mk) ? 2 : -2;
  return score;
}

/** Same kind, or a generic "edm" (what a FANUC wire control reports) against a wire or sinker EDM on the plan. */
function kindsAgree(a, b) {
  return a === b || (a === 'edm' && b.endsWith('-edm')) || (b === 'edm' && a.endsWith('-edm'));
}

/**
 * Plan machines in picker order: the suggestion first (a clear best match among machines not linked yet: score ≥ 3
 * and at least 2 ahead of the runner-up), then machines not linked yet, then linked ones, each group in plan order.
 * @param {object} device  see matchScore
 * @param {object[]} machines  layout machines
 * @returns {{ machine: object, linked: boolean, suggested: boolean, score: number }[]}
 */
export function rankMachines(device, machines) {
  const rows = (Array.isArray(machines) ? machines : [])
    .filter((m) => m && typeof m.id === 'string')
    .map((m, i) => ({ machine: m, linked: !!(m.source && typeof m.source === 'object'), suggested: false, score: matchScore(device, m), i }));
  const free = rows.filter((r) => !r.linked).sort((a, b) => b.score - a.score);
  if (free.length && free[0].score >= 3 && (free.length === 1 || free[0].score - free[1].score >= 2)) free[0].suggested = true;
  const order = (r) => (r.suggested ? 0 : r.linked ? 2 : 1);
  return rows.sort((a, b) => order(a) - order(b) || a.i - b.i).map(({ i, ...r }) => r);
}

/** Copy of a layout document with one machine's source set (other machines untouched). */
export function withSource(doc, machineId, source) {
  return { ...doc, machines: (doc?.machines ?? []).map((m) => (m?.id === machineId ? { ...m, source } : m)) };
}

/**
 * Save the link: a fresh copy of the layout (its ETag), the machine's source replaced, PUT with If-Match; one retry
 * when someone saved in between (412). Throws ApiError (401 when no valid edit token was given).
 * @returns {Promise<object>} the source as saved
 */
export async function linkToMachine({ api, layoutId, machineId, source }) {
  const v = validateSource(source);
  if (!v.source) throw new Error(v.errors?.[0]?.message ?? 'the device address is not valid');
  for (let attempt = 0; ; attempt++) {
    const doc = await api.layouts.get(layoutId);
    if (!doc?.machines?.some((m) => m?.id === machineId)) throw new Error('that machine is no longer on the plan');
    try {
      await api.layouts.save(layoutId, withSource(doc, machineId, v.source));
      return v.source;
    } catch (e) {
      if (e?.status === 412 && attempt === 0) continue;
      throw e;
    }
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const KIND_WORDS = Object.freeze({ 'wire-edm': 'wire EDM', 'sinker-edm': 'sinker EDM', 'mill-turn': 'mill-turn' });

/**
 * "Which machine is this?" Resolves the chosen layout machine, or null when cancelled.
 * @param {{ deviceName: string, deviceInfo?: string, ranked: ReturnType<typeof rankMachines> }} o
 */
export function pickMachine({ deviceName, deviceInfo = '', ranked }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'token-dialog link-dialog');
    const title = el('h2', null, 'Which machine is this?');
    title.prepend(iconSvg('link', { size: null }));
    const who = el('p', 'link-device');
    who.append(el('strong', null, deviceName));
    if (deviceInfo) who.append(el('span', 'muted', ` · ${deviceInfo}`));
    const list = el('ul', 'link-choices');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* already closed */ }
      dlg.remove();
      resolve(val);
    };
    for (const r of ranked) {
      const m = r.machine;
      const b = el('button', `link-choice${r.suggested ? ' suggested' : ''}`);
      b.type = 'button';
      const name = el('span', 'link-choice-name', m.name || m.id);
      const kind = m.kind && m.kind !== 'unknown' ? el('span', 'muted', KIND_WORDS[m.kind] ?? m.kind) : null;
      const tag = r.suggested ? el('span', 'tag tag-linked', 'Suggested')
        : r.linked ? el('span', 'tag', `Linked to ${describeSource(m.source)} · replace`)
          : el('span', 'tag', 'Not linked');
      b.append(name, ...(kind ? [kind] : []), tag);
      b.addEventListener('click', () => finish(m));
      const li = el('li');
      li.append(b);
      list.append(li);
    }
    if (!ranked.length) list.append(el('li', 'muted', 'There are no machines on the plan yet. Add them with Edit layout first.'));
    const hint = el('p', 'muted link-hint', 'Not sure? Press Feed Hold on the machine and watch which device in the Discovery list turns amber.');
    const row = el('div', 'dialog-actions');
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => finish(null));
    row.append(cancel);
    dlg.addEventListener('cancel', () => finish(null));
    dlg.append(title, who, list, hint, row);
    document.body.append(dlg);
    dlg.showModal();
    (list.querySelector('.link-choice.suggested') ?? list.querySelector('.link-choice') ?? cancel).focus();
  });
}
