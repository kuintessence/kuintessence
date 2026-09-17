/**
 * Nearest-rank percentile of a numeric sample. `p` in [0,1] (clamped). Returns
 * 0 for an empty sample. Copies + sorts ascending (does not mutate input).
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(clamped * sorted.length)));
  return sorted[rank - 1] ?? 0;
}
