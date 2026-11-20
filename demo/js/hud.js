// HUD chrome: top bar (logo, shop name, ≥ 48 px clock, LIVE/STALE indicator, actions), the stale banner,
// toasts and the edit-token prompt. Branding per docs/BRANDING.md: charcoal bar with a sage rule; the sage accent
// is chrome only (never a status). Text is always set with textContent.
import { tokenWhere } from './tokenHelp.js';
import { iconSvg } from './icons.js';
import { formatTimeOfDay } from './statusStyle.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*\.(?:png|jpe?g|webp|gif|svg)$/i;
const HEX = /^#[0-9a-f]{3,8}$/i;

function button(icon, label, cls) {
  const b = h('button', `btn ${cls ?? ''}`.trim());
  b.type = 'button';
  b.append(iconSvg(icon, { size: null }), h('span', 'btn-label', label));
  b.title = label;
  return b;
}

/**
 * @param {HTMLElement} el
 * @param {{ onDiscovery?: Function, onRuns?: Function, onMaintenance?: Function, onEdit?: Function, onTheme?: Function, onSound?: Function,
 *           onLayoutPick?: Function, onTextSize?: (step: -1|0|1) => number }} [actions]  onTextSize: smaller (-1), reset (0) or larger (1); returns the new size
 */
export function createTopBar(el, actions = {}) {
  el.replaceChildren();
  el.classList.add('topbar');
  const brand = h('div', 'brand');
  const logo = h('img', 'logo');
  logo.alt = '';
  logo.decoding = 'async';
  logo.addEventListener('error', () => { logo.hidden = true; });
  const brandText = h('div', 'brand-text');
  const shopName = h('div', 'shop-name', 'Machine Shop');
  const subtitle = h('div', 'subtitle', 'Shop Floor');
  brandText.append(shopName, subtitle);
  brand.append(logo, brandText);

  const center = h('div', 'topbar-center');
  const preview = h('div', 'preview-badge');
  preview.hidden = true;
  center.append(preview);

  const right = h('div', 'topbar-right');
  const live = h('div', 'live');
  live.setAttribute('role', 'status');
  const liveDot = h('span', 'live-dot');
  const liveText = h('span', 'live-text', 'CONNECTING');
  live.append(liveDot, liveText);
  const clock = h('div', 'clock');
  const clockTime = h('span', 'clock-time', '--:--');
  const clockSuffix = h('span', 'clock-suffix');
  const clockDate = h('span', 'clock-date');
  clock.append(clockTime, clockSuffix, clockDate);
  const nav = h('nav', 'actions');
  nav.setAttribute('aria-label', 'HUD actions');
  const btnSound = button('volume-off', 'Sound off', 'btn-sound');
  btnSound.hidden = true;
  // Drawer text size (shop feedback, 2026-11-19: "Need font control. Hard to read and cramped."): the drawers and the
  // dialogs they open, never the board, the plan or this bar; kept per browser by app.js
  const btnText = button('text-size', 'Text', 'btn-text');
  btnText.title = 'Text size in the drawers on this screen';
  btnText.setAttribute('aria-haspopup', 'true');
  btnText.setAttribute('aria-expanded', 'false');
  btnText.hidden = !actions.onTextSize;
  const textMenu = h('div', 'text-menu');
  textMenu.hidden = true;
  textMenu.setAttribute('role', 'group');
  textMenu.setAttribute('aria-label', 'Drawer text size');
  const textDown = h('button', 'btn btn-quiet text-step', 'A−');
  textDown.type = 'button';
  textDown.setAttribute('aria-label', 'Smaller text');
  const textValue = h('span', 'text-value', '100%');
  const textUp = h('button', 'btn btn-quiet text-step', 'A+');
  textUp.type = 'button';
  textUp.setAttribute('aria-label', 'Larger text');
  const textReset = h('button', 'btn btn-quiet btn-small', 'Reset');
  textReset.type = 'button';
  textMenu.append(textDown, textValue, textUp, textReset);
  const btnTheme = button('sun', 'Light', 'btn-theme');
  const btnRuns = button('report', 'Runs', 'btn-runs');
  btnRuns.title = 'Run report: program runs, cycle times and part counts';
  btnRuns.hidden = !actions.onRuns;
  // Maintenance (D18): hidden until app.js says the server has it on (never on a TV, in a preview or the public demo);
  // the badge counts the tasks due, in neutral ink (never a status colour)
  const btnMaintenance = button('oilcan', 'Maintenance', 'btn-maintenance');
  const maintBadge = h('span', 'btn-badge');
  maintBadge.hidden = true;
  btnMaintenance.append(maintBadge);
  btnMaintenance.hidden = true;
  const maintTitle = (due) => (due ? `Maintenance: ${due} task${due === 1 ? '' : 's'} due` : 'Maintenance: what each machine needs and when, from its manuals');
  btnMaintenance.title = maintTitle(0);
  const btnDiscovery = button('search', 'Discovery', 'btn-discovery');
  const btnEdit = button('pencil', 'Edit layout', 'btn-edit');
  nav.append(btnSound, btnText, btnTheme, btnRuns, btnMaintenance, btnDiscovery, btnEdit);
  right.append(live, clock, nav);
  el.append(brand, center, right);
  document.body.append(textMenu);

  const closeTextMenu = () => {
    if (textMenu.hidden) return;
    textMenu.hidden = true;
    btnText.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onTextKey, true);
  };
  function onOutside(ev) { if (!textMenu.contains(ev.target) && !btnText.contains(ev.target)) closeTextMenu(); }
  function onTextKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeTextMenu(); btnText.focus(); } }
  btnText.addEventListener('click', () => {
    if (!textMenu.hidden) { closeTextMenu(); return; }
    const r = btnText.getBoundingClientRect();
    textMenu.style.top = `${Math.round(r.bottom + 6)}px`;
    textMenu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    textMenu.hidden = false;
    btnText.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onTextKey, true);
    textUp.focus();
  });
  const step = (n) => { const v = actions.onTextSize?.(n); if (typeof v === 'number') showTextSize(v); };
  textDown.addEventListener('click', () => step(-1));
  textUp.addEventListener('click', () => step(1));
  textReset.addEventListener('click', () => step(0));
  function showTextSize(v) {
    const pct = `${Math.round(v * 100)}%`;
    textValue.textContent = pct;
    btnText.title = `Text size on this screen: ${pct}`;
  }

  btnRuns.addEventListener('click', () => actions.onRuns?.());
  btnMaintenance.addEventListener('click', () => actions.onMaintenance?.());
  btnDiscovery.addEventListener('click', () => actions.onDiscovery?.());
  btnEdit.addEventListener('click', () => actions.onEdit?.());
  btnTheme.addEventListener('click', () => actions.onTheme?.());
  btnSound.addEventListener('click', () => actions.onSound?.());

  let lastClock = '';
  return {
    /** Shop name, subtitle, logo and accent from settings (shopName, branding.*). */
    setBranding(settings = {}) {
      const b = settings.branding && typeof settings.branding === 'object' ? settings.branding : {};
      shopName.textContent = typeof settings.shopName === 'string' && settings.shopName.trim() ? settings.shopName : 'Machine Shop';
      subtitle.textContent = typeof b.subtitle === 'string' ? b.subtitle : 'Shop Floor';
      const src = typeof b.logo === 'string' && SAFE_PATH.test(b.logo) ? b.logo : '/brand/stacklight-mark-light.svg';
      if (logo.getAttribute('src') !== src) { logo.hidden = false; logo.src = src; }
      if (typeof b.accent === 'string' && HEX.test(b.accent)) document.documentElement.style.setProperty('--accent-brand', b.accent);
      else document.documentElement.style.removeProperty('--accent-brand');
      const icon = typeof b.icon === 'string' && SAFE_PATH.test(b.icon) ? b.icon : null;
      const link = document.querySelector('link[rel="icon"]');
      if (icon && link && link.getAttribute('href') !== icon) link.setAttribute('href', icon);
      document.title = `${shopName.textContent} — ${subtitle.textContent}`;
    },
    /** Layout name in the subtitle; `preview` shows a PREVIEW badge (read-only ?layout=). */
    setLayoutInfo({ name, preview: isPreview = false, subtitleText } = {}) {
      if (subtitleText !== undefined) subtitle.textContent = subtitleText;
      preview.hidden = !isPreview;
      preview.textContent = isPreview ? `PREVIEW · ${name ?? ''}`.trim() : '';
    },
    /** @param {number} ms server-clock now */
    setClock(ms, { clock24h = false, timeZone } = {}) {
      const text = formatTimeOfDay(ms, { clock24h, timeZone });
      if (text === lastClock) return;
      lastClock = text;
      const m = /^(.*?)(?:\s?([AP]M))?$/.exec(text);
      clockTime.textContent = m ? m[1] : text;
      clockSuffix.textContent = m?.[2] ?? '';
      try {
        clockDate.textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(ms);
      } catch {
        clockDate.textContent = new Date(ms).toDateString();
      }
    },
    /** 'live' | 'stale' | 'connecting' */
    setLive(state, title = '') {
      live.dataset.state = state;
      liveText.textContent = state === 'live' ? 'LIVE' : state === 'stale' ? 'STALE' : 'CONNECTING';
      live.title = title;
    },
    setTheme(theme) {
      const dark = theme !== 'light';
      btnTheme.replaceChildren(iconSvg(dark ? 'sun' : 'moon', { size: null }), h('span', 'btn-label', dark ? 'Light' : 'Dark'));
      btnTheme.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
    },
    /** state: null (hidden) | 'on' | 'off' | 'blocked' */
    setSound(state) {
      btnSound.hidden = !state;
      if (!state) return;
      const on = state === 'on';
      btnSound.replaceChildren(iconSvg(on ? 'volume' : 'volume-off', { size: null }), h('span', 'btn-label', on ? 'Sound on' : state === 'blocked' ? 'Enable sound' : 'Sound off'));
      btnSound.classList.toggle('attn', state === 'blocked');
    },
    setEditable(enabled) {
      btnEdit.hidden = !enabled;
    },
    /** Hide the Discovery button (the public demo has nothing to discover). */
    setDiscoveryAvailable(available) {
      btnDiscovery.hidden = !available;
    },
    /** Show the text size (a multiplier, 1 = 100 %). */
    setTextSize(v) { if (typeof v === 'number') showTextSize(v); },
    /** Hide the Runs button when the server has the run report turned off. */
    setRunsAvailable(available) {
      btnRuns.hidden = !available || !actions.onRuns;
    },
    /**
     * Maintenance (D18): `available` false hides the button (feature off, older server, kiosk, preview, public demo);
     * `due` is the number of tasks due, shown as a badge (hidden at 0).
     */
    setMaintenance({ available = false, due = 0 } = {}) {
      btnMaintenance.hidden = !available || !actions.onMaintenance;
      const n = Number.isFinite(due) && due > 0 ? Math.floor(due) : 0;
      const text = n > 99 ? '99+' : n ? String(n) : '';
      if (maintBadge.textContent !== text) maintBadge.textContent = text;
      maintBadge.hidden = !n;
      btnMaintenance.title = maintTitle(n);
    },
    element: el,
  };
}

/** Full-width "DISPLAY DISCONNECTED — data as of hh:mm" banner (D4). */
export function createBanner(el) {
  el.replaceChildren();
  el.classList.add('banner');
  el.hidden = true;
  el.setAttribute('role', 'alert');
  const icon = iconSvg('unplugged', { size: null });
  const text = h('span', 'banner-text');
  const sub = h('span', 'banner-sub');
  el.append(icon, text, sub);
  return {
    show(main, detail = '') {
      text.textContent = main;
      sub.textContent = detail;
      el.hidden = false;
      document.documentElement.classList.add('has-banner');
    },
    hide() {
      el.hidden = true;
      document.documentElement.classList.remove('has-banner');
    },
  };
}

let toastHost = null;
/**
 * Small notification (non-kiosk). kind: 'info' | 'ok' | 'error'.
 * @param {string} message
 * @param {{ kind?: string, timeoutMs?: number }} [opts]
 */
export function toast(message, { kind = 'info', timeoutMs = 5000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', 'toasts');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const t = h('div', `toast toast-${kind}`);
  t.append(iconSvg(kind === 'error' ? 'triangle' : kind === 'ok' ? 'check' : 'info', { size: null }), h('span', null, String(message)));
  toastHost.append(t);
  const remove = () => t.remove();
  setTimeout(remove, timeoutMs);
  t.addEventListener('click', remove);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
}

/**
 * Ask for the edit token (D9). Resolves { token, remember } or null when cancelled.
 * @param {{ reason?: string, help?: object|null }} [opts]  help: GET /api/state tokenHelp (where to find the token)
 */
export function promptForToken({ reason = '', help = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'token-dialog';
    const form = h('form', 'token-form');
    form.method = 'dialog';
    const title = h('h2', null, 'Edit token required');
    title.prepend(iconSvg('key', { size: null }));
    const p = h('p', 'muted', `${reason || 'Changes need the edit token.'} ${tokenWhere(help)}`);
    const input = h('input', 'token-input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Paste the edit token';
    input.setAttribute('aria-label', 'Edit token');
    const rememberLabel = h('label', 'check');
    const remember = h('input');
    remember.type = 'checkbox';
    rememberLabel.append(remember, h('span', null, 'Remember on this device'));
    const row = h('div', 'dialog-actions');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const ok = h('button', 'btn btn-primary', 'Continue');
    ok.type = 'submit';
    row.append(cancel, ok);
    form.append(title, p, input, rememberLabel, row);
    dlg.append(form);
    document.body.append(dlg);
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* already closed */ }
      dlg.remove();
      resolve(val);
    };
    cancel.addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', () => finish(null));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const token = input.value.trim();
      finish(token ? { token, remember: remember.checked } : null);
    });
    dlg.showModal();
    input.focus();
  });
}
