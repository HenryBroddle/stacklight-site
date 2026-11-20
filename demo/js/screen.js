// Screen profiles (docs/DECISIONS.md D4): which layout/view/rotation/theme a display shows and the screen-pixel
// type scale derived from the TV size and design viewing distance. Opened as /?screen=floor (kiosk implied);
// URL parameters override the profile: ?kiosk=1 ?layout=<id> ?theme=dark|light|auto ?view=plan+board|plan|board
// ?rotate=0|90|180|270 ?region=<view id> ?motion=full|reduced|none ?sound=1 ?scale=1.2 ?edit=1
import { LAYOUT_ID_RE } from '/shared/contracts.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const VIEWS = Object.freeze(['plan+board', 'plan', 'board']);
const THEMES = new Set(['dark', 'light', 'auto']);
const MOTIONS = new Set(['full', 'reduced', 'none']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Reference display for the D4 type scale: 55" 16:9 at 1920 px wide (0.634 mm/px) viewed from 20 ft. */
const REF_PX_PER_MM = 1920 / ((55 * 25.4 * 16) / Math.hypot(16, 9));
const REF_DISTANCE_FT = 20;

/** D4 sizes in CSS px at k = 1. */
export const BASE_SCALE = Object.freeze({
  hero: 128, status: 56, name: 40, code: 32, floor: 24, glyph: 40, room: 28, roomMin: 13, clock: 52, label: 18,
});

function normRotate(v) {
  const n = num(v);
  if (n === null) return null;
  const r = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return r;
}
function bool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/**
 * Parse URL query options (all optional; invalid values are ignored).
 * @param {string} search  location.search
 */
export function readUrlOptions(search) {
  const p = new URLSearchParams(search || '');
  const get = (k) => (p.has(k) ? p.get(k) : null);
  const screen = get('screen');
  const layout = get('layout');
  const theme = get('theme');
  const view = get('view');
  const motion = get('motion');
  const region = get('region');
  return {
    screen: screen && NAME_RE.test(screen) ? screen : null,
    kiosk: p.has('kiosk') ? bool(get('kiosk') || '1') : null,
    layout: layout && LAYOUT_ID_RE.test(layout) ? layout : null,
    theme: theme && THEMES.has(theme) ? theme : null,
    view: view && VIEWS.includes(view.replace(' ', '+')) ? view.replace(' ', '+') : null,
    rotate: p.has('rotate') ? normRotate(get('rotate')) : null,
    region: region && NAME_RE.test(region) ? region : null,
    motion: motion && MOTIONS.has(motion) ? motion : null,
    sound: p.has('sound') ? bool(get('sound') || '1') : null,
    scale: p.has('scale') && num(get('scale')) !== null ? clamp(num(get('scale')), 0.3, 4) : null,
    margin: p.has('margin') && num(get('margin')) !== null ? clamp(num(get('margin')), 0, 10) : null,
    edit: p.has('edit') ? !!bool(get('edit') || '1') : false,
  };
}

/**
 * Merge URL options, settings.screens[name] and settings.display into one profile.
 * @param {ReturnType<typeof readUrlOptions>} url
 * @param {object} settings  public settings
 */
export function resolveScreen(url, settings) {
  const screens = own(settings, 'screens');
  const prof = url.screen && isObj(own(screens, url.screen)) ? screens[url.screen] : null;
  const display = isObj(own(settings, 'display')) ? settings.display : {};
  const kiosk = url.kiosk ?? !!prof;
  const theme = url.theme ?? (THEMES.has(own(prof, 'theme')) ? prof.theme : null) ?? (THEMES.has(display.theme) ? display.theme : 'dark');
  const profView = typeof own(prof, 'view') === 'string' && VIEWS.includes(prof.view) ? prof.view : null;
  const layoutId = url.layout ?? (typeof own(prof, 'layout') === 'string' && LAYOUT_ID_RE.test(prof.layout) ? prof.layout : null);
  const region = url.region ?? (typeof own(prof, 'region') === 'string' && NAME_RE.test(prof.region) ? prof.region : null);
  const motionSetting = own(prof, 'motion') ?? display.motion;
  return {
    name: url.screen,
    known: !!prof,
    kiosk,
    layoutId,                                   // null → the server's active layout
    view: url.view ?? profView ?? (display.showSidebar === false ? 'plan' : 'plan+board'),
    rotate: url.rotate ?? normRotate(own(prof, 'rotate')) ?? 0,
    region,
    theme,
    diagonalIn: num(own(prof, 'diagonalIn')),
    designDistanceFt: num(own(prof, 'designDistanceFt')),
    safeMarginPct: clamp(url.margin ?? num(own(prof, 'safeMarginPct')) ?? 0, 0, 10),
    sound: url.sound ?? own(prof, 'sound') === true,
    motion: url.motion ?? (MOTIONS.has(motionSetting) ? motionSetting : 'full'),
    scale: url.scale ?? (num(own(prof, 'scale')) !== null ? clamp(num(prof.scale), 0.3, 4) : 1),
    showGrid: !kiosk && display.showGrid === true,
    edit: !!url.edit && !kiosk,
  };
}

/**
 * Screen-pixel type scale (D4): fixed sizes derived from the TV diagonal and design viewing distance, never from
 * layout units. Without a profile the scale follows the viewport (1 at 1920 × 1080, or 1080 × 1920 on a monitor turned
 * on its side).
 * @param {{diagonalIn:number|null, designDistanceFt:number|null, scale:number}} profile
 * @param {{width:number, height:number, screenWidth?:number}} viewport  CSS px
 */
export function computeTypeScale(profile, viewport) {
  let k;
  if (profile.diagonalIn > 0 && profile.designDistanceFt > 0) {
    const widthMm = (profile.diagonalIn * 25.4 * 16) / Math.hypot(16, 9);
    const px = Math.max(viewport.screenWidth || 0, viewport.width);
    k = (profile.designDistanceFt / REF_DISTANCE_FT) * (px / widthMm / REF_PX_PER_MM);
  } else if (viewport.height > viewport.width && viewport.width >= 900) {
    // a monitor on its side: the same design size as 1920 × 1080, turned (1 at 1080 × 1920), not half of it
    k = Math.min(viewport.width / 1080, viewport.height / 1920);
  } else {
    k = Math.min(viewport.width / 1920, viewport.height / 1080);
  }
  k = clamp((Number.isFinite(k) ? k : 1) * (profile.scale || 1), 0.5, 4);
  const out = { k };
  for (const [key, v] of Object.entries(BASE_SCALE)) out[key] = Math.round(v * k * 10) / 10;
  return out;
}

/** Apply theme / kiosk / motion / scale to <html>. Returns the effective theme ('dark' | 'light'). */
export function applyProfile(profile, scale, root = document.documentElement) {
  let theme = profile.theme;
  if (theme === 'auto') theme = globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.dataset.theme = theme;
  root.classList.toggle('kiosk', !!profile.kiosk);
  root.dataset.view = profile.view;
  root.dataset.motion = effectiveMotion(profile);
  root.style.setProperty('--k', String(scale.k));
  // the screen's own scale, for what must stay on it inside a drawer (whose --k also carries the Text size, hud.css)
  root.style.setProperty('--k-screen', String(scale.k));
  root.style.setProperty('--safe', `${profile.safeMarginPct}vmin`);
  for (const [key, v] of Object.entries(scale)) if (key !== 'k') root.style.setProperty(`--fs-${key}`, `${v}px`);
  return theme;
}

/** 'full' | 'reduced' | 'none' honouring prefers-reduced-motion (D3). */
export function effectiveMotion(profile) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (profile.motion === 'none') return 'none';
  if (profile.motion === 'reduced' || reduced) return 'reduced';
  return 'full';
}

// ---------------------------------------------------------------------------------------------
// Plan rotation and regions
// ---------------------------------------------------------------------------------------------

const norm180 = (d) => {
  let r = ((d % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
};
const upright = (d) => {
  let r = norm180(d);
  if (r > 90) r -= 180;
  else if (r <= -90) r += 180;
  return r;
};

/**
 * A copy of the layout rotated clockwise by 90/180/270° so "up" on the TV is forward for the viewer.
 * Geometry is rotated; text stays upright (labels are flipped when they would read upside down).
 * @param {object} layout
 * @param {number} deg
 */
export function rotateLayout(layout, deg) {
  const r = normRotate(deg) ?? 0;
  if (!r || !layout) return layout;
  const W = layout.width, H = layout.height;
  const pt = ([x, y]) => (r === 90 ? [H - y, x] : r === 180 ? [W - x, H - y] : [y, W - x]);
  const vec = ([dx, dy]) => (r === 90 ? [-dy, dx] : r === 180 ? [-dx, -dy] : [dy, -dx]);
  const swap = r !== 180;
  const rect = (it) => {
    const [cx, cy] = pt([it.x + it.w / 2, it.y + it.h / 2]);
    const w = swap ? it.h : it.w, h = swap ? it.w : it.h;
    return { ...it, x: cx - w / 2, y: cy - h / 2, w, h };
  };
  const out = { ...layout, width: swap ? H : W, height: swap ? W : H, background: undefined };
  out.walls = (layout.walls ?? []).map((w) => ({ ...w, points: Array.isArray(w.points) ? w.points.map(pt) : w.points }));
  out.doors = (layout.doors ?? []).map((d) => {
    const [x, y] = pt([d.x, d.y]);
    return { ...d, x, y, rotation: norm180((d.rotation || 0) + r) };
  });
  out.rooms = (layout.rooms ?? []).map((room) => {
    const o = Array.isArray(room.points) ? { ...room, points: room.points.map(pt) } : rect(room);
    if (Array.isArray(room.labelOffset)) o.labelOffset = vec(room.labelOffset);
    return o;
  });
  out.objects = (layout.objects ?? []).map(rect);
  out.machines = (layout.machines ?? []).map(rect);
  out.labels = (layout.labels ?? []).map((l) => {
    const [x, y] = pt([l.x, l.y]);
    return { ...l, x, y, rotation: upright((l.rotation || 0) + r) };
  });
  if (Array.isArray(layout.views)) {
    out.views = layout.views.map((v) => {
      if (![v?.x, v?.y, v?.w, v?.h].every(Number.isFinite)) return v;
      return rect(v);
    });
  }
  return out;
}

/** Named crop rectangle from layout.views[] (matched by id or name), or null. */
export function findRegion(layout, region) {
  if (!region || !Array.isArray(layout?.views)) return null;
  const v = layout.views.find((x) => x && (x.id === region || x.name === region));
  if (!v || ![v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n)) || v.w <= 0 || v.h <= 0) return null;
  return { x: v.x, y: v.y, w: v.w, h: v.h };
}

// ---------------------------------------------------------------------------------------------
// Sound (D3): off by default; per-screen opt-in single soft chime at ESTOP/ALARM onset during shift,
// at most once per machine per 5 minutes. Informational only — never a siren.
// ---------------------------------------------------------------------------------------------

/**
 * @returns {{ play(machineId: string): boolean, unlock(): Promise<boolean>, readonly blocked: boolean }}
 */
export function createChime({ perMachineMs = 5 * 60_000 } = {}) {
  /** @type {AudioContext|null} */
  let ctx = null;
  let blocked = false;
  const last = new Map();
  const ensure = () => {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) { blocked = true; return null; }
    try { ctx = new AC(); } catch { blocked = true; return null; }
    return ctx;
  };
  const tone = (c, freq, start, dur, gain) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + dur + 0.05);
  };
  return {
    get blocked() { return blocked; },
    async unlock() {
      const c = ensure();
      if (!c) return false;
      try { await c.resume(); } catch { /* still blocked */ }
      blocked = c.state !== 'running';
      return !blocked;
    },
    play(machineId) {
      const now = Date.now();
      if (now - (last.get(machineId) ?? -Infinity) < perMachineMs) return false;
      const c = ensure();
      if (!c) return false;
      if (c.state !== 'running') {
        c.resume().catch(() => {});
        if (c.state !== 'running') { blocked = true; return false; }
      }
      blocked = false;
      last.set(machineId, now);
      const t = c.currentTime + 0.02;
      tone(c, 659.25, t, 0.7, 0.12);        // E5
      tone(c, 880, t + 0.32, 0.9, 0.10);    // A5 — soft two-tone chime, ~1.2 s total
      return true;
    },
  };
}
