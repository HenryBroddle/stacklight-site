// Undo/redo for the layout editor (DECISIONS D5: ≥ 200 steps, one step per gesture). Each step stores the
// document before and after a change plus the selection on both sides; documents are immutable and share
// unchanged items, so a step costs little memory. Pure ESM — unit-tested in Node.

/**
 * @typedef {{ before: object, after: object, label: string, selBefore: string[], selAfter: string[],
 *             coalesceKey: string|null, time: number }} Step
 */

export class UndoStack {
  /**
   * @param {{ limit?: number, coalesceMs?: number }} [o]  limit = steps kept (oldest dropped first)
   */
  constructor({ limit = 500, coalesceMs = 1200 } = {}) {
    this.limit = Math.max(1, limit);
    this.coalesceMs = coalesceMs;
    /** @type {Step[]} */
    this.undoSteps = [];
    /** @type {Step[]} */
    this.redoSteps = [];
    /** Bumped on every change, so views can tell whether to refresh. */
    this.version = 0;
  }

  /**
   * Record one change. Steps with the same `coalesceKey` that follow each other within `coalesceMs` merge into
   * one (typing in a field, repeated arrow nudges). No-op changes (before === after) are ignored.
   * @param {object} before
   * @param {object} after
   * @param {{ label?: string, selBefore?: string[], selAfter?: string[], coalesceKey?: string|null, now?: number }} [o]
   * @returns {boolean} true when a step was recorded or merged
   */
  record(before, after, { label = 'Change', selBefore = [], selAfter = [], coalesceKey = null, now = Date.now() } = {}) {
    if (before === after) return false;
    const last = this.undoSteps[this.undoSteps.length - 1];
    if (coalesceKey && last && last.coalesceKey === coalesceKey && last.after === before && now - last.time <= this.coalesceMs) {
      last.after = after;
      last.selAfter = [...selAfter];
      last.time = now;
      this.redoSteps.length = 0;
      this.version++;
      return true;
    }
    this.undoSteps.push({ before, after, label, selBefore: [...selBefore], selAfter: [...selAfter], coalesceKey, time: now });
    if (this.undoSteps.length > this.limit) this.undoSteps.splice(0, this.undoSteps.length - this.limit);
    this.redoSteps.length = 0;
    this.version++;
    return true;
  }

  /** Stop the last step from absorbing further coalescing changes (end of a gesture or field edit). */
  seal() {
    const last = this.undoSteps[this.undoSteps.length - 1];
    if (last) last.coalesceKey = null;
  }

  /** @returns {{ doc: object, selection: string[], label: string }|null} the state to go back to */
  undo() {
    const step = this.undoSteps.pop();
    if (!step) return null;
    step.coalesceKey = null;
    this.redoSteps.push(step);
    this.version++;
    return { doc: step.before, selection: [...step.selBefore], label: step.label };
  }

  /** @returns {{ doc: object, selection: string[], label: string }|null} the state to go forward to */
  redo() {
    const step = this.redoSteps.pop();
    if (!step) return null;
    this.undoSteps.push(step);
    this.version++;
    return { doc: step.after, selection: [...step.selAfter], label: step.label };
  }

  get canUndo() { return this.undoSteps.length > 0; }
  get canRedo() { return this.redoSteps.length > 0; }
  get undoLabel() { return this.undoSteps[this.undoSteps.length - 1]?.label ?? null; }
  get redoLabel() { return this.redoSteps[this.redoSteps.length - 1]?.label ?? null; }
  get size() { return this.undoSteps.length; }

  /** Labels of the undo steps, newest first (History panel). */
  labels(max = 50) {
    return this.undoSteps.slice(-max).reverse().map((s) => ({ label: s.label, time: s.time }));
  }

  clear() {
    this.undoSteps.length = 0;
    this.redoSteps.length = 0;
    this.version++;
  }
}
