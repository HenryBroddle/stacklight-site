// Door symbols for the floor plan (pure geometry, no DOM; drawn by floorplan.js).
//
// In a door's local frame the opening runs along x from -w/2 to w/2 at y = 0, and `inward` (+1 or -1) is the side
// the door opens toward. As on an architect's plan, each leaf is drawn open at 90° from its hinge, and its swing is
// the quarter circle the leaf's free edge travels: centred on the hinge, radius = the leaf's width, from the open
// edge back to the closed position at the far jamb (or the middle of a double door). The arc therefore bulges away
// from the hinge; an arc that bows in toward the hinge is the circle centred on the wrong corner.

const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * One door leaf: hinge at (hingeX, 0), closing toward +x (`closesTo` = 1) or -x (-1), opening toward `inward`.
 * SVG's sweep flag 1 draws the arc toward increasing angle. Measured at the hinge, the open edge is at
 * ±90° and the closed edge at 0° (closing toward +x) or 180° (toward -x), so the flag is 0 when the closing
 * direction and the opening side have the same sign, else 1.
 */
function leaf(hingeX, len, closesTo, inward) {
  const ly = inward * len;
  const sweep = (closesTo > 0) === (inward > 0) ? 0 : 1;
  return {
    leaf: `M${r4(hingeX)} 0 V${r4(ly)}`,
    arc: `M${r4(hingeX)} ${r4(ly)} A${r4(len)} ${r4(len)} 0 0 ${sweep} ${r4(hingeX + closesTo * len)} 0`,
  };
}

/**
 * Leaf lines and swing arcs of a door, or null for kinds without a swing (roll-up, opening, entrance) and for a
 * single door whose swing is "none".
 * @param {{ width: number, kind?: string, swing?: string, inward?: number }} d  swing 'left' | 'right' | 'none'
 * @returns {{ leaves: string, arcs: string } | null}  SVG path data in the door's local frame
 */
export function doorSwingPaths({ width: w, kind = 'door', swing, inward = 1 }) {
  if (!(typeof w === 'number' && Number.isFinite(w) && w > 0)) return null;
  const dir = inward < 0 ? -1 : 1;
  const parts = [];
  if (kind === 'door') {
    const s = swing ?? 'left';
    if (s === 'none') return null;
    parts.push(s === 'right' ? leaf(w / 2, w, -1, dir) : leaf(-w / 2, w, 1, dir));
  } else if (kind === 'double') {
    parts.push(leaf(-w / 2, w / 2, 1, dir), leaf(w / 2, w / 2, -1, dir));
  } else {
    return null;
  }
  return { leaves: parts.map((p) => p.leaf).join(' '), arcs: parts.map((p) => p.arc).join(' ') };
}
