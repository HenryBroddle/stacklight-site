// Programs dropped on the dashboard (DECISIONS D16 amendment, 2026-11-20): drag files from the PC onto a machine's
// tile, its name plate or its board row to send them to that machine. The machine's Programs drawer opens and asks
// once ("Send … to …?"); the send then runs as a drop inside the drawer does (programsPanel.dropFiles).
//
// While files are dragged over the page, the machines that take them are marked (data-drop="ok") and the one under
// the pointer is highlighted (data-drop="target"). Data attributes, because the plan and the board rewrite their
// classes on every repaint. Only machines with program transfer on take files. Anywhere else on the dashboard a
// dropped file is refused, so the browser never opens it in place of the HUD. A drop that a drawer already handled
// (the Programs drawer's own list) is left alone, and nothing here runs while the layout editor is open (it takes
// photo drops) or on a kiosk TV.

const MACHINE_SEL = '[data-kind="machine"][data-id], [data-callout-for], .board-rows .row[data-id]';
/** Browsers repeat dragover every ~50 ms while files hover; this long without one means the drag left or ended. */
const QUIET_MS = 400;

const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');

/**
 * @param {{ active: () => boolean, canDrop: (id: string) => boolean, onDrop: (id: string, files: File[]) => void,
 *           onRefused?: (id: string) => void, doc?: Document }} deps
 *   active(): drops on machines are possible here at all (not a TV, not the editor, not a preview)
 *   canDrop(id): this machine takes files (program transfer is on for it)
 *   onRefused(id): files were dropped on a machine that does not take them
 * @returns {{ destroy(): void }}
 */
export function createFileDrop(deps) {
  const doc = deps.doc ?? document;
  let dragging = false;
  let quiet = null;
  /** The machine highlighted as the drop target. */
  let hotId = null;

  /** The machine id under an event target, or null. */
  function machineAt(target) {
    const el = target instanceof Element ? target.closest(MACHINE_SEL) : null;
    if (!el) return null;
    const id = el.getAttribute('data-callout-for') ?? el.getAttribute('data-id');
    return id || null;
  }
  /** Every element that stands for this machine (its tile and its board row; a name plate highlights its tile). */
  function elementsFor(id) {
    const q = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    return [...doc.querySelectorAll(`[data-kind="machine"][data-id="${q}"], .board-rows .row[data-id="${q}"]`)];
  }

  function start() {
    if (dragging) return;
    dragging = true;
    doc.documentElement.classList.add('files-dragging');
    for (const el of doc.querySelectorAll('[data-kind="machine"][data-id], .board-rows .row[data-id]')) {
      const id = el.getAttribute('data-id');
      if (id && deps.canDrop(id)) el.setAttribute('data-drop', 'ok');
    }
  }
  function aim(id) {
    const next = id && deps.canDrop(id) ? id : null;
    if (next === hotId) return;
    for (const el of doc.querySelectorAll('[data-drop="target"]')) el.setAttribute('data-drop', 'ok');
    hotId = next;
    if (next) for (const el of elementsFor(next)) el.setAttribute('data-drop', 'target');
  }
  function stop() {
    clearTimeout(quiet);
    quiet = null;
    if (!dragging) return;
    dragging = false;
    hotId = null;
    doc.documentElement.classList.remove('files-dragging');
    for (const el of doc.querySelectorAll('[data-drop]')) el.removeAttribute('data-drop');
  }
  const keepAlive = () => {
    clearTimeout(quiet);
    quiet = setTimeout(stop, QUIET_MS);
  };

  function onOver(ev) {
    if (!hasFiles(ev) || !deps.active()) { stop(); return; }
    if (ev.defaultPrevented) { aim(null); keepAlive(); return; } // a drawer's own drop area has it
    start();
    keepAlive();
    const id = machineAt(ev.target);
    ev.preventDefault();
    if (id && deps.canDrop(id)) {
      ev.dataTransfer.dropEffect = 'copy';
      aim(id);
    } else {
      ev.dataTransfer.dropEffect = 'none';
      aim(null);
    }
  }
  function onDrop(ev) {
    if (!hasFiles(ev) || !deps.active()) { stop(); return; }
    if (ev.defaultPrevented) { stop(); return; }
    ev.preventDefault();
    const id = machineAt(ev.target);
    const files = [...(ev.dataTransfer?.files ?? [])];
    stop();
    if (!id || !files.length) return;
    if (deps.canDrop(id)) deps.onDrop(id, files);
    else deps.onRefused?.(id);
  }
  function onLeave(ev) {
    // the pointer left the window (no element it went to)
    if (dragging && ev.relatedTarget === null && (ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= innerWidth || ev.clientY >= innerHeight)) stop();
  }

  doc.addEventListener('dragenter', onOver);
  doc.addEventListener('dragover', onOver);
  doc.addEventListener('drop', onDrop);
  doc.addEventListener('dragleave', onLeave);
  return {
    destroy() {
      stop();
      doc.removeEventListener('dragenter', onOver);
      doc.removeEventListener('dragover', onOver);
      doc.removeEventListener('drop', onDrop);
      doc.removeEventListener('dragleave', onLeave);
    },
  };
}
