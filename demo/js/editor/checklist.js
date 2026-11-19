// Getting-started checklist for the layout editor (DECISIONS D5), computed from the layout and editor state —
// nothing is stored. Pure ESM — unit-tested in Node.

/**
 * @typedef {{ id: string, title: string, detail: string, done: boolean, optional?: boolean, action: string }} Step
 */

/**
 * @param {object} doc  layout being edited
 * @param {{ dirty?: boolean, everSaved?: boolean, live?: boolean }} [state]
 *   dirty: unsaved changes; everSaved: the layout exists on the server; live: it is the active layout
 * @returns {{ steps: Step[], done: number, total: number, complete: boolean }}
 *   done/total: ticked steps of all listed steps (optional ones included); complete: every required step is done
 */
export function gettingStarted(doc, { dirty = false, everSaved = true, live = false } = {}) {
  const machines = Array.isArray(doc?.machines) ? doc.machines.filter(Boolean) : [];
  const walls = Array.isArray(doc?.walls) ? doc.walls.filter(Boolean) : [];
  const rooms = Array.isArray(doc?.rooms) ? doc.rooms.filter(Boolean) : [];
  const linked = machines.filter((m) => m.source && typeof m.source === 'object').length;
  const photo = typeof doc?.background?.src === 'string' && doc.background.src !== '';
  const steps = [
    {
      id: 'photo', action: 'photo', optional: true, done: photo,
      title: 'Add a photo of your floor plan',
      detail: photo ? 'Trace photo added — line it up with "Fit photo"' : 'Optional: a phone photo of a sketch to trace over',
    },
    {
      id: 'walls', action: 'wall', done: walls.length > 0,
      title: 'Draw the walls',
      detail: walls.length ? `${walls.length} wall${walls.length === 1 ? '' : 's'}` : 'Click corner points; Enter or double-click to finish',
    },
    {
      id: 'rooms', action: 'room', optional: true, done: rooms.length > 0,
      title: 'Mark rooms and areas',
      detail: rooms.length ? `${rooms.length} room${rooms.length === 1 ? '' : 's'}` : 'Offices, inventory, shipping … (optional)',
    },
    {
      id: 'machines', action: 'machine', done: machines.length > 0,
      title: 'Place your machines',
      detail: machines.length ? `${machines.length} machine${machines.length === 1 ? '' : 's'}` : 'Drag out a rectangle for each machine',
    },
    {
      id: 'link', action: 'link', done: machines.length > 0 && linked === machines.length,
      title: 'Link each machine to its controller',
      detail: machines.length ? `${linked} of ${machines.length} linked — drag a device onto a machine` : 'Place machines first',
    },
    {
      id: 'save', action: 'save', done: everSaved && !dirty,
      title: 'Save the layout',
      detail: dirty ? 'You have unsaved changes' : 'Saved',
    },
    {
      id: 'live', action: 'live', done: !!live && everSaved,
      title: 'Show it on the shop TV',
      detail: live ? 'This layout is live' : '"Make live" switches the TVs to this layout',
    },
  ];
  // The counter and progress bar count the same steps the card lists (ticked of listed), so "6 of 7"
  // matches six ticks on a seven-step card. `complete` ("All set") needs only the required steps.
  const complete = steps.every((s) => s.optional || s.done);
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, complete };
}
