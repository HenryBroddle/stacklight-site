// Pure board rules (no DOM, no imports; unit-tested in test/unit/board-model.test.js).

/**
 * The line under the "RUNNING n/N" headline.
 * While the display is stale the attention counts are unknown, so it says so instead of "Nothing needs attention".
 * @param {{ total: number, attention: number, service: number, unbound: number }} counts
 * @param {{ machines: number, kiosk?: boolean, outsideShift?: boolean, stale?: boolean, asOfText?: string }} o
 * @returns {string}
 */
export function boardSubline(counts, { machines, kiosk = false, outsideShift = false, stale = false, asOfText = '' }) {
  const nb = (n, word) => `${n} ${word}`; // keep a count on the same line as its label
  const sub = [];
  if (counts.total === 0) {
    sub.push(machines ? `${nb(machines, `machine${machines === 1 ? '' : 's'}`)} on this layout` : 'No machines on this layout');
    if (machines && !kiosk) sub.push('link them in the editor');
    return sub.join(' · ');
  }
  if (stale) sub.push(asOfText ? `Data as of ${asOfText} — status unknown` : 'Status unknown');
  else if (outsideShift) sub.push('Outside shift hours');
  else sub.push(counts.attention ? `${nb(counts.attention, `need${counts.attention === 1 ? 's' : ''}`)} attention` : 'Nothing needs attention');
  if (counts.service) sub.push(`${nb(counts.service, 'out of service')}`);
  if (counts.unbound) sub.push(`${nb(counts.unbound, 'not linked')}`);
  return sub.join(' · ');
}

/** A row the attention-only board (more machines than fit) lists. */
export const needsRow = (vm) => vm.attention.level > 0 || vm.status === 'ESTOP' || vm.status === 'ALARM';

/**
 * Which machines the attention-only board lists. While stale, the attention levels have been reset (the data may be
 * out of date), so the last live row set is kept, frozen, instead of being filtered on the reset levels.
 * @template {{ id: string }} V
 * @param {V[]} vms
 * @param {{ stale?: boolean, frozenIds?: string[]|null }} o
 * @returns {V[]}
 */
export function attentionRows(vms, { stale = false, frozenIds = null } = {}) {
  if (stale && frozenIds) {
    const keep = new Set(frozenIds);
    return vms.filter((vm) => keep.has(vm.id) || vm.status === 'ESTOP' || vm.status === 'ALARM');
  }
  return vms.filter(needsRow);
}

/** Rows that keep their fault line (code + message) even at the densest board settings. */
export const keepsDetail = (vm, detail) => !!detail && (vm.status === 'ESTOP' || vm.status === 'ALARM');
