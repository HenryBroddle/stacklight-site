// Override label (docs/DECISIONS.md D25): on a board row while a machine is in cycle with its feed,
// rapid or spindle override away from 100 % (statusStyle activeOverrides). One label per machine steps through the
// active overrides every OVERRIDE_STEP_MS: only its text changes, nothing flashes (flashing is for alarms). A screen
// set to reduced motion (root data-motion) shows them all at once. Every label on the page steps together from one
// timer, so re-drawing a row never restarts it, and each is sized for its longest text, so it never jumps. (The
// plan tile has a bar chart instead: floorplan.js overrideChart.)
export const OVERRIDE_STEP_MS = 2000;

const motionNow = () => (typeof document !== 'undefined' ? document.documentElement?.dataset?.motion : null) || 'full';

/**
 * What a label shows now: one override at a time, or all of them when motion is reduced.
 * @param {string[]} texts  e.g. ['FEED 50%', 'RAPID 25%']
 */
export function overrideText(texts, { now = Date.now(), motion = motionNow() } = {}) {
  if (!Array.isArray(texts) || !texts.length) return '';
  if (motion !== 'full' || texts.length === 1) return texts.join(' · ');
  return texts[Math.floor(now / OVERRIDE_STEP_MS) % texts.length];
}

/** The text a label is sized for, so stepping never changes its size: the longest one, or all of them. */
export function overrideSizingText(texts, motion = motionNow()) {
  if (!Array.isArray(texts) || !texts.length) return '';
  if (motion !== 'full') return texts.join(' · ');
  return texts.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Make `node` an override label for `texts` (empty: no longer one); the ticker keeps its text current. */
export function setOverrideLabel(node, texts) {
  if (!Array.isArray(texts) || !texts.length) {
    if (node.hasAttribute('data-ovr')) node.removeAttribute('data-ovr');
    return;
  }
  const json = JSON.stringify(texts);
  if (node.getAttribute('data-ovr') !== json) node.setAttribute('data-ovr', json);
  const t = overrideText(texts);
  if (node.textContent !== t) node.textContent = t;
}

let ticker = null;
/** One timer for the page: every label shows its current step. */
export function startOverrideTicker(root = document) {
  if (ticker || !root?.querySelectorAll) return;
  ticker = setInterval(() => {
    for (const node of root.querySelectorAll('[data-ovr]')) {
      let texts;
      try { texts = JSON.parse(node.getAttribute('data-ovr')); } catch { continue; }
      const t = overrideText(texts);
      if (node.textContent !== t) node.textContent = t;
    }
  }, 250);
}
