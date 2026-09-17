// Locality scorer — co-located data gets a boost.
//
// Per-rule:
//   - 100 if candidate.siteId is in ctx.dataSites
//   - 60 if some data site is the same region (same prefix before '-')
//   - 30 otherwise
// Tunable via the weight applied by the composite scorer.
import type { Scorer } from "./types";

export const localityScorer: Scorer = {
  name: "locality",
  weight: 0.2,
  score(candidate, ctx) {
    if (ctx.dataSites.length === 0) return 50; // no input data → no preference
    if (ctx.dataSites.includes(candidate.siteId)) return 100;
    const region = regionOf(candidate.siteId);
    if (region && ctx.dataSites.some((s) => regionOf(s) === region)) return 60;
    return 30;
  },
};

function regionOf(siteId: string): string | null {
  const idx = siteId.indexOf("-");
  if (idx <= 0) return null;
  return siteId.slice(0, idx);
}
