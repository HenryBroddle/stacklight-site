// Browser problems into the server log (docs/DECISIONS.md D13): uncaught script errors, unhandled promise
// rejections, and the watchdog's display disconnects and reloads go to POST /api/client-log, so a TV that misbehaves
// leaves a trace in the log files that can be sent for support. Best effort: never throws, never retries, at most
// `max` reports per page load, each distinct problem once.

/**
 * @param {{ endpoint?: string, screen?: () => (string|null), max?: number, post?: (url: string, body: string) => void,
 *           target?: EventTarget, perfNow?: () => number }} [o]
 * @returns {{ report: (kind: 'error'|'rejection'|'stale'|'reload', data?: object) => void, readonly sent: number }}
 */
export function createErrorReporter({
  endpoint = '/api/client-log', screen = () => null, max = 20, post = defaultPost, target = globalThis, perfNow = () => performance.now(),
} = {}) {
  const startedAt = perfNow();
  const seen = new Set();
  let sent = 0;

  function report(kind, data = {}) {
    try {
      if (sent >= max) return;
      const key = `${kind}|${data.message ?? ''}|${data.source ?? ''}|${data.line ?? ''}|${data.reason ?? ''}`;
      if (kind !== 'stale' && kind !== 'reload' && seen.has(key)) return;
      seen.add(key);
      sent++;
      const body = {
        kind, ...data,
        page: `${globalThis.location?.pathname ?? ''}${globalThis.location?.search ?? ''}`,
        screen: screen() ?? undefined,
        ua: globalThis.navigator?.userAgent,
        uptimeS: Math.round((perfNow() - startedAt) / 1000),
      };
      post(endpoint, JSON.stringify(body));
    } catch { /* reporting must never break the page */ }
  }

  target.addEventListener?.('error', (e) => {
    // Script errors only (ErrorEvent); failed images and the like do not reach a non-capturing window listener.
    if (!e || typeof e.message !== 'string') return;
    report('error', { message: e.message, source: e.filename || undefined, line: e.lineno, col: e.colno, stack: e.error?.stack });
  });
  target.addEventListener?.('unhandledrejection', (e) => {
    const r = e?.reason;
    report('rejection', { message: String(r?.message ?? r ?? 'unknown'), stack: r?.stack });
  });

  return { report, get sent() { return sent; } };
}

function defaultPost(url, body) {
  // keepalive: still delivered when the page is unloading (a reload right after the report)
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
}
