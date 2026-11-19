// Pure tile-content rules shared by the floor plan (no DOM, no imports; unit-tested in test/unit/tile-content.test.js).

/**
 * What a status tile shows when its status word does not fit (DECISIONS D4). The glyph (icon) stands in for the
 * word, and whatever else fitted (name, timer, fault line …) stays. Only a tile too small for its whole name falls
 * back to fill, ring and a single large glyph.
 * @param {{ key: string, kind: string, size: number }[]} lines  the best fitted lines (fitLines result)
 * @param {{ unbound?: boolean, keepName?: boolean, glyph: number, floor: number, boxW: number, boxH: number }} o
 *   glyph = preferred glyph size, floor = smallest legible size, boxW/boxH = content box (all px);
 *   keepName = the layout editor, which has no name plates: a fitted name (even a cut one) is kept rather than
 *   swapped for the lone glyph, so every tile stays identifiable
 * @returns {{ key: string, kind: string, size: number }[]}
 */
export function tileLinesWithoutWord(lines, { unbound = false, keepName = false, glyph, floor, boxW, boxH }) {
  if (unbound || lines.some((l) => l.key === 'word')) return lines;
  if (keepName && lines.some((l) => l.key === 'name')) return lines;
  const hasIcon = lines.some((l) => l.kind === 'icon' || l.inlineIcon);
  // the whole name must fit: "3-Axi…" does not tell 3-Axis A from 3-Axis B
  const name = lines.find((l) => l.key === 'name');
  const wholeName = !!name && (name.fullText === undefined || (name.text === name.fullText && !name.rows));
  if (hasIcon && wholeName) return lines;
  const g = Math.min(Math.max(glyph, Math.min(boxW, boxH) * 0.6), glyph * 1.6, boxW, boxH);
  return g >= floor * 0.9 ? [{ kind: 'icon', key: 'icon', size: g, prio: 0, order: 1 }] : [];
}

/**
 * Shorter forms of a "since 3:14 PM" / "since Fri 4:12 PM" tile timer, tried before the text would be cut
 * ("since 3:14…" loses AM/PM): "since 3:14p", then "3:14p" (12-hour clocks), then the text without "since".
 * @param {string} text
 * @returns {string[]}
 */
export function compactSinceTexts(text) {
  const out = [];
  const t = String(text ?? '');
  const short = t.replace(/(\d)\s?([AaPp])\.?\s?[Mm]\.?$/, (_, d, ap) => `${d}${ap.toLowerCase()}`);
  if (short !== t) out.push(short);
  const bare = short.replace(/^since\s+/i, '');
  if (bare !== short) out.push(bare);
  const bareLong = t.replace(/^since\s+/i, '');
  if (bareLong !== t && !out.includes(bareLong)) out.push(bareLong);
  return out;
}
