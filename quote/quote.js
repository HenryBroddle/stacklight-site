// The quote configurator (quote/index.html). Everything stays in this page until the visitor sends the email
// themselves; a draft of the form is kept in this browser only.
import { MAKES, PRICES, makeById, normalizeQuote, priceQuote, quoteEmail, dollars } from './pricing.js';

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'stacklight.quote-draft';
const rowsEl = $('machines');
const tpl = $('machine-row');
const ICON = { ok: '#i-ok', now: '#i-now', soon: '#i-soon', ask: '#i-ask' };
const FIELDS = ['company', 'name', 'email', 'phone', 'city', 'state', 'zip', 'notes'];

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function addRow({ make = 'fanuc', model = '', count = 1 } = {}) {
  const row = tpl.content.firstElementChild.cloneNode(true);
  const sel = row.querySelector('select');
  for (const m of MAKES) {
    const o = h('option', null, m.name);
    o.value = m.id;
    sel.append(o);
  }
  sel.value = make;
  row.querySelector('.q-model input').value = model;
  row.querySelector('.q-count input').value = String(count);
  row.querySelector('.q-remove').addEventListener('click', () => { row.remove(); update(); });
  rowsEl.append(row);
  update();
  return row;
}

function readQuote() {
  const machines = [...rowsEl.querySelectorAll('.q-machine')].map((r) => ({
    make: r.querySelector('select').value,
    model: r.querySelector('.q-model input').value,
    count: Number.parseInt(r.querySelector('.q-count input').value, 10),
  }));
  const shop = Object.fromEntries(FIELDS.filter((f) => f !== 'notes').map((f) => [f, $(f).value]));
  return {
    plan: document.querySelector('input[name="plan"]:checked')?.value,
    machines, programTransfer: $('pt').checked, maintenance: $('mb').checked, shop, notes: $('notes').value,
  };
}

function line(label, detail, amount, cls = '') {
  const row = h('div', `q-sline ${cls}`.trim());
  const left = h('span');
  left.append(h('span', 'q-sl', label));
  if (detail) left.append(h('span', 'q-sd muted', detail));
  row.append(left, h('span', 'q-sa', amount));
  return row;
}

let current = null;

function update() {
  // each machine line says how far Stacklight is with that make
  const rows = [...rowsEl.querySelectorAll('.q-machine')];
  for (const r of rows) {
    const m = makeById(r.querySelector('select').value);
    const st = r.querySelector('.q-status');
    st.className = `q-status q-${m.status}`;
    st.querySelector('use').setAttribute('href', ICON[m.status]);
    st.querySelector('span').textContent = m.note;
    r.querySelector('.q-remove').hidden = rows.length < 2;
  }
  const raw = readQuote();
  const norm = normalizeQuote(raw);
  const sum = $('summary');
  sum.replaceChildren();
  const fanuc = raw.machines.filter((m) => m.make === 'fanuc' && Number.isInteger(m.count) && m.count > 0).reduce((s, m) => s + m.count, 0);
  $('pt').disabled = fanuc === 0;
  if (fanuc === 0) $('pt').checked = false;
  $('pt-line').classList.toggle('q-off', fanuc === 0);
  $('pt-why').textContent = fanuc === 0 ? 'For FANUC machines: add one above.' : '';
  if (!norm.ok) {
    current = null;
    sum.append(h('p', 'muted', norm.error === 'add at least one machine' ? 'Add your machines to see the price.' : `To see the price: ${norm.error}.`));
  } else {
    const q = norm.quote;
    const p = priceQuote(q);
    $('pt-amt').textContent = fanuc ? `${fanuc} × ${dollars(PRICES.programTransfer.cents)} = ${dollars(fanuc * PRICES.programTransfer.cents)}` : '$150 a FANUC machine';
    $('mb-amt').textContent = `${p.machines} × ${dollars(PRICES.maintenance.cents)} = ${dollars(p.machines * PRICES.maintenance.cents)}`;
    sum.append(h('p', 'q-count-line', `${p.machines} machine${p.machines === 1 ? '' : 's'}`));
    for (const l of p.lines) sum.append(line(l.label, l.qty > 1 || l.key !== 'box' ? `${l.qty} × ${dollars(l.unitCents)}` : null, dollars(l.totalCents)));
    sum.append(line('Due once', null, dollars(p.onceCents), 'q-total'));
    if (p.monthly) {
      sum.append(line('Then monthly', `${p.monthly.qty} × ${dollars(p.monthly.unitCents)}, ${p.monthly.months} payments`, `${dollars(p.monthly.totalCents)}/mo`, 'q-total'));
      sum.append(h('p', 'muted q-after', `After 24 payments it's yours. Updates and help after that: optional, ${dollars(PRICES.updatesYear.cents)} a machine a year.`));
    } else {
      sum.append(h('p', 'muted q-after', `After the first year, updates and help are optional: ${dollars(p.afterFirstYearCents)} a year for ${p.machines} machine${p.machines === 1 ? '' : 's'}. Let it lapse and the board keeps running.`));
    }
    current = q;
  }
  // ready to send: a price, and an email to answer
  const email = $('email').value.trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const ready = !!current && emailOk;
  const missing = $('missing');
  missing.hidden = ready;
  missing.textContent = !current ? 'Add your machines to send the request.' : !emailOk ? 'Add your email so we can reply.' : '';
  const send = $('send');
  send.setAttribute('aria-disabled', String(!ready));
  send.classList.toggle('q-disabled', !ready);
  send.href = ready ? quoteEmail(current).mailto : '#';
  $('copy').disabled = !ready;
  saveDraft(raw);
}

function saveDraft(raw) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(raw)); } catch { /* a convenience only */ }
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { return null; }
}

// wiring
$('add-machine').addEventListener('click', () => {
  const used = new Set([...rowsEl.querySelectorAll('select')].map((s) => s.value));
  const next = MAKES.find((m) => !used.has(m.id))?.id ?? 'other';
  addRow({ make: next }).querySelector('select').focus();
});
$('q').addEventListener('input', update);
$('q').addEventListener('change', update);
$('q').addEventListener('submit', (e) => e.preventDefault());
$('send').addEventListener('click', (e) => { if ($('send').getAttribute('aria-disabled') === 'true') e.preventDefault(); });
$('copy').addEventListener('click', async () => {
  if (!current) return;
  const m = quoteEmail(current);
  const textOut = `To: ${m.to}\nSubject: ${m.subject}\n\n${m.body}`;
  try { await navigator.clipboard.writeText(textOut); } catch {
    const ta = h('textarea');
    ta.value = textOut;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* shown below anyway */ }
    ta.remove();
  }
  $('copied').hidden = false;
  setTimeout(() => { $('copied').hidden = true; }, 6000);
});

// start: the draft from this browser, or one FANUC machine
const draft = loadDraft();
if (draft && Array.isArray(draft.machines) && draft.machines.length) {
  for (const m of draft.machines.slice(0, 50)) addRow({ make: m.make, model: m.model ?? '', count: Number.isInteger(m.count) && m.count > 0 ? m.count : 1 });
  const plan = document.querySelector(`input[name="plan"][value="${draft.plan === 'monthly' ? 'monthly' : 'buy'}"]`);
  if (plan) plan.checked = true;
  $('pt').checked = !!draft.programTransfer;
  $('mb').checked = !!draft.maintenance;
  for (const f of FIELDS) if (typeof (f === 'notes' ? draft.notes : draft.shop?.[f]) === 'string') $(f).value = f === 'notes' ? draft.notes : draft.shop[f];
} else {
  addRow();
}
update();
