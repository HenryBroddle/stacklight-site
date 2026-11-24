// Board sidebar (docs/DECISIONS.md D4): "RUNNING 4/6" headline in green, fixed-order family chips (dimmed at
// zero), one row per machine in layout order (≤ 8 machines) or an attention-only list above 8. Rows carry the
// same attention ring as tiles; they re-sort only on status/attention changes, never on timer ticks. A small
// "recent changes" feed is shown outside kiosk mode.
import { iconSvg } from './icons.js';
import { CHIPS, familyCounts, compareVm, detailLine, paletteFor, formatTimeOfDay } from './statusStyle.js';
import { boardSubline, attentionRows, keepsDetail } from './boardModel.js';
import { setOverrideLabel, overrideSizingText } from './overrideLabel.js';

const MAX_ALL_ROWS = 8;
const DENSITIES = ['roomy', 'normal', 'snug', 'cozy', 'compact', 'tight'];

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function setText(node, text) {
  const t = text ?? '';
  if (node.textContent !== t) node.textContent = t;
}

/**
 * @param {HTMLElement} headEl   container for the headline + chips
 * @param {HTMLElement} rowsEl   container for the rows (scroll area)
 * @param {{ onSelect?: (id: string) => void }} [opts]
 */
export function createBoard(headEl, rowsEl, { onSelect } = {}) {
  let kiosk = false;
  let compact = false; // phone-sized screen: rows are cards (data-density="phone")
  let theme = 'dark';
  let clockOpts = {};
  let lastOrderKey = '';
  let order = [];
  let liveIds = null; // rows of the attention-only list at the last live update (kept while the display is stale)
  let lastStructure = '';
  const rows = new Map(); // id → { li, parts, sig }
  const feed = [];

  // ----- head ------------------------------------------------------------------------------------
  headEl.replaceChildren();
  headEl.classList.add('board-head');
  const hero = h('div', 'hero');
  const heroCount = h('div', 'hero-count');
  const heroN = h('span', 'hero-n', '0');
  const heroOf = h('span', 'hero-of', '/0');
  heroCount.append(heroN, heroOf);
  const heroText = h('div', 'hero-text');
  const heroLabel = h('div', 'hero-label');
  const heroIcon = h('span', 'hero-icon-wrap');
  const heroWord = h('span', 'hero-word', 'RUNNING');
  heroIcon.append(iconSvg('play', { size: null, className: 'hero-icon' }));
  heroLabel.append(heroIcon, heroWord);
  let heroIconName = 'play';
  const heroSub = h('div', 'hero-sub');
  heroText.append(heroLabel, heroSub);
  hero.append(heroCount, heroText);
  const chipsEl = h('div', 'chips');
  const chipEls = new Map();
  for (const c of CHIPS) {
    const chip = h('div', `chip chip-${c.id}`);
    chip.dataset.family = c.id;
    const n = h('span', 'chip-n', '0');
    const label = h('span', 'chip-label', c.label);
    const icon = h('span', 'chip-icon');
    chip.append(icon, n, label);
    chipsEl.append(chip);
    chipEls.set(c.id, { chip, n, icon, status: c.status });
  }
  headEl.append(hero, chipsEl);

  // ----- rows ------------------------------------------------------------------------------------
  rowsEl.replaceChildren();
  rowsEl.classList.add('board-rows');
  const list = h('ol', 'rows');
  list.setAttribute('aria-label', 'Machines');
  const empty = h('div', 'all-clear');
  const feedWrap = h('section', 'feed');
  const feedTitle = h('h3', 'feed-title', 'Recent changes');
  const feedList = h('ol', 'feed-list');
  feedWrap.append(feedTitle, feedList);
  rowsEl.append(list, empty, feedWrap);

  list.addEventListener('click', (ev) => {
    const li = ev.target instanceof Element ? ev.target.closest('li[data-id]') : null;
    if (li && !kiosk) onSelect?.(li.dataset.id);
  });
  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const li = ev.target instanceof Element ? ev.target.closest('li[data-id]') : null;
    if (li && !kiosk) { ev.preventDefault(); onSelect?.(li.dataset.id); }
  });

  function paintChips(counts) {
    for (const c of CHIPS) {
      const e = chipEls.get(c.id);
      const n = counts.families[c.id] ?? 0;
      setText(e.n, String(n));
      e.chip.classList.toggle('zero', n === 0);
      const pal = paletteFor(e.status, theme);
      const key = `${theme}|${n > 0}`;
      if (e.key !== key) {
        e.key = key;
        e.chip.style.setProperty('--fill', pal.fill ?? 'transparent');
        e.chip.style.setProperty('--ink', pal.ink);
        e.chip.style.setProperty('--border', pal.borderColor ?? pal.fill ?? 'currentColor');
        e.icon.replaceChildren(iconSvg(pal.icon, { size: null }));
      }
      e.chip.title = `${c.label}: ${n}`;
    }
  }

  function rowFor(vm) {
    let r = rows.get(vm.id);
    if (!r) {
      const li = h('li', 'row');
      li.dataset.id = vm.id;
      const bar = h('span', 'row-bar');
      const badge = h('span', 'row-badge');
      const badgeIcon = h('span', 'row-icon');
      const word = h('span', 'row-word');
      // an active warning (D19): a yellow "!" beside the status word
      const warn = h('span', 'warn-mark', '!');
      warn.hidden = true;
      warn.title = 'Warning on the machine';
      badge.append(badgeIcon, word, warn);
      const timer = h('span', 'row-timer');
      const timerText = h('span', 'row-timer-text');
      timer.append(timerText);
      // the override label on boards with no second line (D25): its own grid item over the flexible name column, left
      // of the timer, so it never widens the columns the rows share
      const ovrTop = h('span', 'row-ovr row-ovr-top');
      ovrTop.hidden = true;
      const name = h('span', 'row-name');
      const detail = h('span', 'row-detail');
      // the second line's right end: "down 42m", and overrides away from 100 % while in cycle (D25)
      const down = h('span', 'row-down');
      const downText = h('span', 'row-down-text');
      const ovr = h('span', 'row-ovr');
      ovr.hidden = true;
      down.append(downText, ovr);
      // phone cards only (data-density="phone"): program, readings and today's runs, one line each
      const facts = h('span', 'row-facts');
      const factProgram = h('span', 'fact fact-program');
      const factReadings = h('span', 'fact fact-readings');
      const factToday = h('span', 'fact fact-today');
      facts.append(factProgram, factReadings, factToday);
      li.append(bar, badge, timer, name, ovrTop, detail, down, facts);
      r = { li, parts: { bar, badge, badgeIcon, word, warn, timer, timerText, name, detail, down, downText, ovr, ovrTop, facts, factProgram, factReadings, factToday }, sig: '', icon: '' };
      rows.set(vm.id, r);
    }
    return r;
  }

  function paintRow(r, vm) {
    const { li, parts } = r;
    // phone cards show the program on a line of its own, so the detail keeps only the fault or reason
    const detail = compact ? detailLine({ ...vm, program: null }) : detailLine(vm);
    const ovr = (vm.overrides ?? []).map((o) => o.text);
    const motion = document.documentElement.dataset.motion ?? 'full';
    const sig = JSON.stringify([vm.status, vm.variant, vm.word, vm.fill, vm.ink, vm.icon, vm.attention.level, vm.timer, vm.down, vm.name, detail, kiosk, theme, compact, vm.facts, vm.today, vm.badge, ovr, motion]);
    if (sig === r.sig) return;
    r.sig = sig;
    li.className = `row st-${vm.status} v-${vm.variant} att-${vm.attention.level}${vm.timer?.overdue ? ' overdue' : ''}${detail || vm.down || ovr.length ? ' has-detail' : ''}${keepsDetail(vm, detail) ? ' keep-detail' : ''}`;
    li.style.setProperty('--fill', vm.fill ?? 'transparent');
    li.style.setProperty('--ink', vm.ink);
    li.style.setProperty('--border', vm.borderColor ?? vm.fill ?? 'transparent');
    if (r.icon !== `${vm.icon}`) {
      r.icon = vm.icon;
      parts.badgeIcon.replaceChildren(iconSvg(vm.icon, { size: null }));
    }
    setText(parts.word, vm.variant === 'service' ? 'OUT OF SERVICE' : vm.word);
    parts.warn.hidden = vm.badge !== 'warning';
    setText(parts.name, vm.name);
    const timerText = vm.timer ? (vm.timer.overdue ? `! ${vm.timer.text}` : vm.timer.text) : '';
    setText(parts.timerText, timerText);
    parts.timer.hidden = !timerText;
    parts.timer.classList.toggle('timer-text', !!vm.timer && vm.timer.mode !== 'elapsed');
    setText(parts.detail, detail);
    setText(parts.downText, vm.down?.text ?? '');
    parts.downText.hidden = !vm.down;
    // overrides (D25): one label, stepping through them (overrideLabel.js), sized for its longest text. It sits at the
    // end of the second line, or beside the timer on boards with no second line (CSS shows one of the two).
    for (const el of [parts.ovr, parts.ovrTop]) {
      setOverrideLabel(el, ovr);
      el.hidden = !ovr.length;
      // every text it steps through, laid out invisibly (CSS ::after): the label is as wide as the widest, always
      el.dataset.size = motion === 'full' ? ovr.join('\n') : overrideSizingText(ovr, motion);
      el.title = ovr.length ? `Overrides: ${ovr.join(' · ')}` : '';
    }
    parts.down.hidden = !vm.down && !ovr.length;
    const facts = compact && vm.variant !== 'unbound' ? vm.facts ?? {} : {};
    setText(parts.factProgram, facts.program ?? '');
    setText(parts.factReadings, facts.readings ?? '');
    setText(parts.factToday, compact ? vm.today ?? '' : '');
    parts.factProgram.hidden = !facts.program;
    parts.factReadings.hidden = !facts.readings;
    parts.factToday.hidden = !(compact && vm.today);
    parts.facts.hidden = parts.factProgram.hidden && parts.factReadings.hidden && parts.factToday.hidden;
    if (!kiosk) {
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
    } else {
      li.removeAttribute('tabindex');
      li.removeAttribute('role');
    }
    li.setAttribute('aria-label', [vm.name, vm.word, vm.badge === 'warning' ? 'warning' : '', vm.timer?.text, detailLine(vm), ovr.length ? `overrides ${ovr.join(', ')}` : '', vm.attention.level ? `needs attention: ${vm.attention.reason}` : ''].filter(Boolean).join(', '));
  }

  /**
   * @param {object[]} vms   machine view models in layout order (statusStyle.machineView)
   * @param {{ kiosk?: boolean, theme?: string, clock24h?: boolean, timeZone?: string, stale?: boolean, asOf?: number, compact?: boolean }} [ctx]
   *   stale: the display lost its server link; asOf = server time of the last data (the headline says so)
   *   compact: a phone-sized screen — rows become cards with the program, readings and today's runs
   *   (vm.facts = { program, readings }, vm.today = text, see app.js)
   */
  function update(vms, ctx = {}) {
    const stale = !!ctx.stale;
    kiosk = !!ctx.kiosk;
    compact = !!ctx.compact && !kiosk;
    theme = ctx.theme === 'light' ? 'light' : 'dark';
    clockOpts = { clock24h: !!ctx.clock24h, timeZone: ctx.timeZone };
    const counts = familyCounts(vms);
    const run = paletteFor('RUNNING', theme).fill;
    headEl.style.setProperty('--run', run);
    rowsEl.style.setProperty('--run', run);
    // headline: "RUNNING n/N" (N = linked machines not out of service)
    const none = counts.total === 0;
    setText(heroN, none ? '' : String(counts.running));
    setText(heroOf, none ? '' : `/${counts.total}`);
    heroCount.hidden = none;
    hero.classList.toggle('none-linked', none);
    setText(heroWord, none ? 'NO MACHINES LINKED' : 'RUNNING');
    const wantIcon = none ? 'link-off' : 'play';
    if (wantIcon !== heroIconName) { heroIconName = wantIcon; heroIcon.replaceChildren(iconSvg(wantIcon, { size: null, className: 'hero-icon' })); }
    setText(heroSub, boardSubline(counts, {
      machines: vms.length, kiosk, stale, outsideShift: vms.some((vm) => vm.attention?.inShift === false),
      asOfText: stale && Number.isFinite(ctx.asOf) ? formatTimeOfDay(ctx.asOf, clockOpts) : '',
    }));
    paintChips(counts);

    // rows
    const showAll = vms.length <= MAX_ALL_ROWS;
    let shown = showAll ? vms : attentionRows(vms, { stale, frozenIds: liveIds });
    if (!showAll) {
      if (!stale) liveIds = shown.map((vm) => vm.id);
      const orderKey = shown.map((vm) => `${vm.id}:${vm.status}:${vm.attention.level}`).sort().join('|');
      // while stale the attention levels were reset: keep the last live order rather than re-sorting on them
      if (orderKey !== lastOrderKey && !(stale && shown.every((vm) => order.includes(vm.id)))) {
        lastOrderKey = orderKey;
        order = [...shown].sort(compareVm).map((vm) => vm.id);
      }
      const byId = new Map(shown.map((vm) => [vm.id, vm]));
      shown = order.map((id) => byId.get(id)).filter(Boolean);
    }
    const ids = new Set(shown.map((vm) => vm.id));
    for (const [id, r] of rows) if (!ids.has(id)) { r.li.remove(); rows.delete(id); }
    let prev = null;
    for (const vm of shown) {
      const r = rowFor(vm);
      paintRow(r, vm);
      const anchor = prev ? prev.nextSibling : list.firstChild;
      if (r.li !== anchor) list.insertBefore(r.li, anchor);
      prev = r.li;
    }
    list.classList.toggle('attention-only', !showAll);
    if (!showAll && !shown.length) {
      setText(empty, counts.total ? `All clear · ${counts.running}/${counts.total} running` : '');
      empty.hidden = !counts.total;
    } else empty.hidden = true;

    feedWrap.hidden = kiosk || !feed.length;
    // timers switch between "≥ 3m" and "since 4:12 PM" at shift edges: that changes the room left for names
    const structure = `${shown.length}|${showAll}|${kiosk}|${compact}|${feed.length > 0}|${shown.map((v) => (v.down ? 1 : 0) + (keepsDetail(v, detailLine(v)) ? 2 : 0) + (v.timer?.mode === 'since' ? 4 : 0)).join('')}|${shown.map((v) => v.name).join('\u0000')}`;
    if (structure !== lastStructure) {
      lastStructure = structure;
      fitDensity();
    }
  }

  /**
   * Pick the roomiest row density that fits without scrolling. A density whose one-line rows would cut a machine
   * name ("Robodrill D21Li…" next to a wide status word and timer) is tried again with the names on a line of their
   * own (data-names="line"), so long names are never cut to a couple of letters. Nothing fits: the tightest rows.
   */
  function fitDensity() {
    const container = rowsEl;
    if (compact) { container.dataset.density = 'phone'; container.dataset.names = 'inline'; return; } // the page scrolls
    const heightFits = () => container.scrollHeight <= container.clientHeight + 1;
    const namesFit = () => [...container.querySelectorAll('.row-name')].every((n) => n.scrollWidth <= n.clientWidth + 1);
    for (const d of DENSITIES) {
      container.dataset.density = d;
      for (const names of d === 'roomy' ? ['line'] : ['inline', 'line']) {
        container.dataset.names = names;
        if (heightFits() && (names === 'line' || namesFit())) return;
      }
    }
    container.dataset.density = DENSITIES.at(-1);
    container.dataset.names = 'inline';
  }

  /**
   * Add a line to the "recent changes" feed (non-kiosk). Keeps the last 4, newest first.
   * @param {{ t: number, name: string, status: string, word: string }} ev  t = when this screen showed the change
   */
  function addEvent(ev) {
    feed.unshift(ev);
    feed.length = Math.min(feed.length, 4);
    feedList.replaceChildren(...feed.map((e) => {
      const li = h('li', `feed-item st-${e.status}`);
      const pal = paletteFor(e.status, theme);
      li.style.setProperty('--fill', pal.fill ?? 'transparent');
      li.append(h('span', 'feed-time', formatTimeOfDay(e.t, clockOpts)), h('span', 'feed-dot'), h('span', 'feed-name', e.name), h('span', 'feed-word', e.word));
      return li;
    }));
    feedWrap.hidden = kiosk || !feed.length;
    lastStructure = '';
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitDensity()) : null;
  ro?.observe(rowsEl);

  return {
    update,
    addEvent,
    /** Re-run the density fit (after a type-scale or layout change). */
    refit() { lastStructure = ''; fitDensity(); },
    destroy() { ro?.disconnect(); headEl.replaceChildren(); rowsEl.replaceChildren(); rows.clear(); },
  };
}
