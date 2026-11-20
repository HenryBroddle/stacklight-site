// Stacklight quote: the price list and the arithmetic, shared by the configurator page (quote/index.html) and the
// script that turns a quote request into a draft Stripe invoice (scripts/quote-invoice.mjs in the product repo).
// Prices match the landing page's price section; each line names the Stripe price it is billed with (lookup key).
// Amounts are in cents.

export const QUOTE_FORMAT = 1;
export const MAX_MACHINES = 200;

export const PRICES = Object.freeze({
  license: { cents: 60000, label: 'Stacklight shop license', per: 'per machine, once', lookup: 'license_once_list' },
  monthly: { cents: 3000, label: 'Stacklight monthly plan', per: 'per machine, per month, for 24 months', lookup: 'plan_monthly_list', months: 24 },
  box: { cents: 60000, label: 'The box, ready to run', per: 'once', lookup: 'box' },
  programTransfer: { cents: 15000, label: 'Program transfer', per: 'per FANUC machine, once', lookup: 'program_transfer' },
  maintenance: { cents: 10000, label: 'Maintenance board', per: 'per machine, once', lookup: 'maintenance_board' },
  updatesYear: { cents: 12000, label: 'Updates and help after the first year', per: 'per machine, per year, optional', lookup: 'updates_yearly' },
});

/** Makes, and how far Stacklight is with each (the landing page's "Your machines" section). */
export const MAKES = Object.freeze([
  { id: 'fanuc', name: 'FANUC', status: 'ok', note: 'Confirmed: running in a production shop.' },
  { id: 'haas', name: 'Haas', status: 'now', note: 'Verifying now. Newer controls connect over the network; older ones use a small adapter.' },
  { id: 'okuma', name: 'Okuma', status: 'now', note: 'Verifying now. OSP-P300 and newer, through MTConnect.' },
  { id: 'mazak', name: 'Mazak', status: 'soon', note: 'On the way. Smooth and Matrix 2 controls, through MTConnect.' },
  { id: 'siemens', name: 'Siemens', status: 'soon', note: 'On the way. SINUMERIK controls, through OPC UA.' },
  { id: 'heidenhain', name: 'Heidenhain', status: 'soon', note: 'On the way, through MTConnect or OPC UA.' },
  { id: 'brother', name: 'Brother', status: 'soon', note: 'On the way, through MTConnect or OPC UA.' },
  { id: 'other', name: 'Other or not sure', status: 'ask', note: 'We check it with you before you buy.' },
]);
const MAKE_IDS = new Set(MAKES.map((m) => m.id));
export const makeById = (id) => MAKES.find((m) => m.id === id) ?? MAKES[MAKES.length - 1];

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

/**
 * A quote request, cleaned: anything unknown is dropped, text is trimmed and capped.
 * @returns {{ ok: true, quote: object } | { ok: false, error: string }}
 */
export function normalizeQuote(q) {
  if (!q || typeof q !== 'object') return { ok: false, error: 'not a quote' };
  const plan = q.plan === 'monthly' ? 'monthly' : q.plan === 'buy' ? 'buy' : null;
  if (!plan) return { ok: false, error: 'choose how to pay' };
  const machines = (Array.isArray(q.machines) ? q.machines : []).slice(0, 50).map((m) => ({
    make: MAKE_IDS.has(m?.make) ? m.make : 'other',
    model: text(m?.model, 80),
    count: int(m?.count, 1, MAX_MACHINES),
  })).filter((m) => m.count);
  const total = machines.reduce((n, m) => n + m.count, 0);
  if (!total) return { ok: false, error: 'add at least one machine' };
  if (total > MAX_MACHINES) return { ok: false, error: `at most ${MAX_MACHINES} machines` };
  const fanuc = machines.filter((m) => m.make === 'fanuc').reduce((n, m) => n + m.count, 0);
  const shop = q.shop && typeof q.shop === 'object' ? q.shop : {};
  return {
    ok: true,
    quote: {
      v: QUOTE_FORMAT,
      plan,
      machines,
      programTransfer: !!q.programTransfer && fanuc > 0,
      maintenance: !!q.maintenance,
      shop: {
        company: text(shop.company, 120), name: text(shop.name, 120), email: text(shop.email, 160), phone: text(shop.phone, 40),
        city: text(shop.city, 80), state: text(shop.state, 40), zip: text(shop.zip, 12),
      },
      notes: text(q.notes, 1500),
    },
  };
}

/**
 * The quote's lines and totals (cents). One-time lines are due on the first invoice; with the monthly plan the
 * licenses are billed monthly instead.
 */
export function priceQuote(quote) {
  const n = quote.machines.reduce((s, m) => s + m.count, 0);
  const fanuc = quote.machines.filter((m) => m.make === 'fanuc').reduce((s, m) => s + m.count, 0);
  const lines = [];
  const add = (key, qty, extra = {}) => {
    const p = PRICES[key];
    lines.push({ key, lookup: p.lookup, label: p.label, per: p.per, qty, unitCents: p.cents, totalCents: p.cents * qty, ...extra });
  };
  if (quote.plan === 'buy') add('license', n, { when: 'once' });
  add('box', 1, { when: 'once' });
  if (quote.programTransfer && fanuc) add('programTransfer', fanuc, { when: 'once' });
  if (quote.maintenance) add('maintenance', n, { when: 'once' });
  const onceCents = lines.reduce((s, l) => s + l.totalCents, 0);
  const monthly = quote.plan === 'monthly'
    ? { key: 'monthly', lookup: PRICES.monthly.lookup, label: PRICES.monthly.label, qty: n, unitCents: PRICES.monthly.cents, totalCents: PRICES.monthly.cents * n, months: PRICES.monthly.months }
    : null;
  return {
    machines: n, fanuc, lines, onceCents, monthly,
    afterFirstYearCents: PRICES.updatesYear.cents * n, // optional, the year after the included one
  };
}

export const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

// ---- the quote code: the request in a form the invoice script reads back (base64url of compact JSON) ----

const b64url = {
  encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

/** The quote as one line of text, "SLQ1-…" (the notes stay in the readable part of the request). */
export function encodeQuote(quote) {
  const { notes: _notes, ...rest } = quote;
  return `SLQ${QUOTE_FORMAT}-${b64url.encode(JSON.stringify(rest))}`;
}

/** Find and read a quote code anywhere in a text (an email pasted whole). */
export function decodeQuote(textIn) {
  const m = /SLQ1-([A-Za-z0-9_-]{10,6000})/.exec(String(textIn ?? ''));
  if (!m) return { ok: false, error: 'no quote code (SLQ1-…) in the text' };
  let raw;
  try { raw = JSON.parse(b64url.decode(m[1])); } catch { return { ok: false, error: 'the quote code is damaged' }; }
  return normalizeQuote(raw);
}

/** The request as an email: a readable summary, then the code. */
export function quoteEmail(quote, { to = 'hello@stacklight.shop', date = new Date() } = {}) {
  const p = priceQuote(quote);
  const s = quote.shop;
  const subject = `Quote request: ${s.company || s.name || 'a shop'}${s.city ? `, ${s.city}` : ''}`;
  const L = [];
  L.push(`Shop: ${s.company || '-'}`, `Contact: ${s.name || '-'}`, `Email: ${s.email || '-'}`, `Phone: ${s.phone || '-'}`, `Location: ${[s.city, s.state, s.zip].filter(Boolean).join(', ') || '-'}`, '');
  L.push(`Machines (${p.machines}):`);
  for (const m of quote.machines) L.push(`- ${m.count} x ${makeById(m.make).name}${m.model ? ` ${m.model}` : ''}`);
  L.push('', quote.plan === 'buy' ? 'Paying: own it, once' : `Paying: monthly, ${PRICES.monthly.months} payments`);
  for (const l of p.lines) L.push(`${l.label}: ${l.qty} x ${dollars(l.unitCents)} = ${dollars(l.totalCents)}`);
  L.push(`Due once: ${dollars(p.onceCents)}`);
  if (p.monthly) L.push(`Monthly: ${p.monthly.qty} x ${dollars(p.monthly.unitCents)} = ${dollars(p.monthly.totalCents)} a month for ${p.monthly.months} months`);
  L.push('Prices before sales tax.');
  if (quote.notes) L.push('', 'Notes:', quote.notes);
  L.push('', `Quote code (for our records): ${encodeQuote(quote)}`, `Built on stacklight.shop/quote/ on ${date.toISOString().slice(0, 10)}.`);
  const body = L.join('\n');
  return { to, subject, body, mailto: `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}
