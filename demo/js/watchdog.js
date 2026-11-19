// Stale-data watchdog (docs/DECISIONS.md D4) — a frozen TV must never show a false "all running".
// - The server pings every 15 s; no SSE message for `staleAfterMs` (40 s) → stale: the HUD shows
//   "DISPLAY DISCONNECTED — data as of hh:mm", greys and hatches every tile and freezes the timers.
// - The EventSource itself is re-created by api.connectEvents(); here we only nudge it when stale.
// - Reloads happen only after GET /api/health answers 200 (never navigate to an error page):
//   after `reloadAfterStaleMs` (5 min) of staleness, when the server's bootId/version changes (new
//   frontend deployed), and nightly at settings.display.reloadAt ("03:00", local time).
// Staleness uses the monotonic clock (performance.now), so wall-clock steps cannot fake freshness.

/**
 * @param {{ events: { lastMessageAt: number, lastMessageWall: number, reconnect: Function },
 *           health: () => Promise<any>, onStale: (stale: boolean, asOfWallMs: number) => void,
 *           reload?: () => void, staleAfterMs?: number, reloadAfterStaleMs?: number, healthPollMs?: number,
 *           perfNow?: () => number, wallNow?: () => number }} o
 */
export function createWatchdog(o) {
  const {
    events, health, onStale, reload = () => globalThis.location.reload(),
    staleAfterMs = 40_000, reloadAfterStaleMs = 5 * 60_000, healthPollMs = 15_000,
    perfNow = () => performance.now(), wallNow = () => Date.now(),
  } = o;
  let stale = false;
  let staleSince = 0;
  let identity = null;          // { bootId, version } first seen
  let pendingReason = null;     // why a reload is wanted
  let lastHealthTry = -Infinity;
  let healthBusy = false;
  let reloadAt = null;          // "HH:MM"
  let nextNightly = null;       // wall ms
  let lastNudge = 0;
  let destroyed = false;

  function scheduleNightly() {
    nextNightly = null;
    if (!reloadAt) return;
    const m = /^(\d{1,2}):(\d{2})$/.exec(reloadAt);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return;
    const d = new Date(wallNow());
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= wallNow() + 60_000) d.setDate(d.getDate() + 1);
    nextNightly = d.getTime();
  }

  async function reloadWhenHealthy() {
    if (healthBusy || destroyed) return;
    const t = perfNow();
    if (t - lastHealthTry < healthPollMs) return;
    lastHealthTry = t;
    healthBusy = true;
    try {
      const r = await health();
      if (r && r.ok !== false && !destroyed) reload();
    } catch {
      // server not back yet: keep showing the banner and try again later
    } finally {
      healthBusy = false;
    }
  }

  function check() {
    if (destroyed) return;
    const silence = perfNow() - events.lastMessageAt;
    if (!stale && silence > staleAfterMs) {
      stale = true;
      staleSince = perfNow();
      onStale(true, events.lastMessageWall);
      events.reconnect();
      lastNudge = perfNow();
    } else if (stale && silence <= staleAfterMs) {
      stale = false;
      onStale(false, events.lastMessageWall);
    }
    if (stale) {
      if (perfNow() - lastNudge > 30_000) { lastNudge = perfNow(); events.reconnect(); }
      if (perfNow() - staleSince >= reloadAfterStaleMs) pendingReason = pendingReason ?? 'stale';
    }
    if (nextNightly !== null && wallNow() >= nextNightly) {
      pendingReason = pendingReason ?? 'nightly';
      nextNightly = null;
    }
    if (pendingReason) reloadWhenHealthy();
  }

  const timer = setInterval(check, 1000);
  const onVisible = () => { if (!document.hidden) check(); };
  document.addEventListener('visibilitychange', onVisible);

  return {
    /** Server identity from a snapshot/ping/health payload; a change of bootId or version triggers a reload. */
    noteIdentity(payload) {
      if (!payload || typeof payload !== 'object') return;
      const bootId = typeof payload.bootId === 'string' || typeof payload.bootId === 'number' ? String(payload.bootId) : null;
      const version = typeof payload.version === 'string' ? payload.version : null;
      if (!bootId && !version) return;
      if (!identity) { identity = { bootId, version }; return; }
      if ((bootId && identity.bootId && bootId !== identity.bootId) || (version && identity.version && version !== identity.version)) {
        pendingReason = 'server-changed';
        lastHealthTry = -Infinity;
        check();
      }
      identity = { bootId: bootId ?? identity.bootId, version: version ?? identity.version };
    },
    /** settings.display.reloadAt ("HH:MM" local) — null disables the nightly reload. */
    setReloadAt(hhmm) {
      const v = typeof hhmm === 'string' ? hhmm.trim() : null;
      if (v === reloadAt) return;
      reloadAt = v;
      scheduleNightly();
    },
    check,
    get stale() { return stale; },
    get pendingReason() { return pendingReason; },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
