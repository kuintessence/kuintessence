/**
 * Viewport windowing for large lists. HPC job queues can hold thousands of
 * rows; rendering them all rebuilds the whole terminal tree every tick. These
 * helpers render only a window around the selection, with counts of the rows
 * hidden above/below so the panes can show scroll indicators.
 */

/** Fallback visible-row budget when the terminal height is unknown. */
export const DEFAULT_VIEWPORT_ROWS = 20;

/** Lines of fixed chrome around a list pane: tab bar, top/bottom margins, the
 *  column header, two scroll hints, and the footer. */
const LIST_CHROME_ROWS = 9;
const MIN_VIEWPORT_ROWS = 5;

/**
 * Visible-row budget for the active list, derived from the terminal height so
 * panes fill a tall terminal and don't overflow a short one. Clamps to a sane
 * minimum; falls back to a typical 24-row terminal when the height is unknown.
 */
export function computeViewportRows(terminalRows: number | undefined): number {
  const rows = terminalRows && terminalRows > 0 ? terminalRows : 24;
  return Math.max(MIN_VIEWPORT_ROWS, rows - LIST_CHROME_ROWS);
}

export interface RowWindow<T> {
  /** The slice of items to render. */
  rows: T[];
  /** Index in the full list of `rows[0]` — add to a local row index to recover
   *  the absolute index (for selection highlighting). */
  startIndex: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * Window `items` to at most `height` rows, keeping `selectedIndex` visible and
 * roughly centred. `height <= 0` renders nothing; lists shorter than `height`
 * are returned whole.
 */
export function windowRows<T>(items: T[], selectedIndex: number, height: number): RowWindow<T> {
  if (height <= 0) {
    return { rows: [], startIndex: 0, hiddenAbove: 0, hiddenBelow: items.length };
  }
  if (items.length <= height) {
    return { rows: items, startIndex: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const clampedSel = Math.max(0, Math.min(selectedIndex, items.length - 1));
  let start = clampedSel - Math.floor(height / 2);
  start = Math.max(0, Math.min(start, items.length - height));
  return {
    rows: items.slice(start, start + height),
    startIndex: start,
    hiddenAbove: start,
    hiddenBelow: items.length - (start + height),
  };
}

/**
 * Like {@link windowRows} but each item occupies a variable number of rows
 * (`heightOf`). Keeps `selectedIndex` visible and grows the window outward —
 * alternating below/above to keep the selection roughly centred — until the
 * next item would exceed `budget`. A single item taller than the budget still
 * renders (the selection must stay visible). Used by the Metrics pane, where a
 * node with disk + multiple GPUs is several rows taller than a bare one.
 */
export function windowByHeight<T>(
  items: T[],
  selectedIndex: number,
  heightOf: (item: T) => number,
  budget: number,
): RowWindow<T> {
  const n = items.length;
  if (budget <= 0) {
    return { rows: [], startIndex: 0, hiddenAbove: 0, hiddenBelow: n };
  }
  const total = items.reduce((sum, it) => sum + heightOf(it), 0);
  if (total <= budget) {
    return { rows: items, startIndex: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const sel = Math.max(0, Math.min(selectedIndex, n - 1));
  let lo = sel;
  let hi = sel;
  let used = heightOf(items[sel] as T);
  let preferBelow = true;
  while (true) {
    const belowIdx = hi + 1;
    const aboveIdx = lo - 1;
    const canBelow = belowIdx < n && used + heightOf(items[belowIdx] as T) <= budget;
    const canAbove = aboveIdx >= 0 && used + heightOf(items[aboveIdx] as T) <= budget;
    if (!canBelow && !canAbove) break;
    const goBelow = preferBelow ? canBelow : !canAbove;
    if (goBelow) {
      hi = belowIdx;
      used += heightOf(items[hi] as T);
    } else {
      lo = aboveIdx;
      used += heightOf(items[lo] as T);
    }
    preferBelow = !preferBelow;
  }
  return {
    rows: items.slice(lo, hi + 1),
    startIndex: lo,
    hiddenAbove: lo,
    hiddenBelow: n - (hi + 1),
  };
}
