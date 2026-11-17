import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { getAuthState, subscribeAuthState } from "../../lib/auth";

export type MapDisplay = "diagram" | "data" | "expanded" | "collapsed";
export type MapPresentation = "dual" | "single";
const mode = z.enum(["memory", "fixed", "recommended"]);
const display = z.enum(["diagram", "data", "expanded", "collapsed"]);
const rule = z.object({ mode, fixed: display });
const schema = z.object({
  appearance: z.object({
    flow: z.boolean(),
    color: z.enum(["muted-foreground", "brand", "foreground"]),
    lineWidth: z.number().min(1).max(3),
    duration: z.number().min(1).max(5),
  }),
  dual: rule,
  single: rule,
  pages: z.record(z.string(), rule.partial().extend({ last: display.optional() })),
});
export type MapPreferences = z.infer<typeof schema>;
export type MapRule = z.infer<typeof rule>;
export const DEFAULT_MAP_PREFERENCES: MapPreferences = {
  appearance: { flow: false, color: "muted-foreground", lineWidth: 1.5, duration: 2 },
  dual: { mode: "memory", fixed: "data" },
  single: { mode: "memory", fixed: "expanded" },
  pages: {},
};
const CHANGE = "kq:map-preferences";
function subscribe(listener: () => void) {
  window.addEventListener(CHANGE, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE, listener);
    window.removeEventListener("storage", listener);
  };
}
export function parseMapPreferences(raw: string | null): MapPreferences {
  if (!raw) return DEFAULT_MAP_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_MAP_PREFERENCES;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MAP_PREFERENCES;
}
export function mapRule(
  prefs: MapPreferences,
  page: string,
  presentation: MapPresentation,
): MapRule {
  const saved = prefs.pages[page];
  return {
    mode: saved?.mode ?? prefs[presentation].mode,
    fixed: saved?.fixed ?? prefs[presentation].fixed,
  };
}
export function validDisplay(value: unknown, presentation: MapPresentation): value is MapDisplay {
  return presentation === "dual"
    ? value === "diagram" || value === "data"
    : value === "expanded" || value === "collapsed";
}
export function initialMapDisplay({
  prefs,
  page,
  presentation,
  recommended,
  nodeTarget,
  url,
}: {
  prefs: MapPreferences;
  page: string;
  presentation: MapPresentation;
  recommended: MapDisplay;
  nodeTarget?: boolean;
  url?: unknown;
}): MapDisplay {
  if (nodeTarget) return presentation === "dual" ? "diagram" : "expanded";
  if (validDisplay(url, presentation)) return url;
  const preference = mapRule(prefs, page, presentation);
  const candidate =
    preference.mode === "fixed"
      ? preference.fixed
      : preference.mode === "memory"
        ? prefs.pages[page]?.last
        : undefined;
  return validDisplay(candidate, presentation) ? candidate : recommended;
}
export function useMapPreferences() {
  const account = useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().email ?? "",
    () => "",
  );
  const key = `kq.function-maps.v1:${encodeURIComponent(account)}`;
  const raw = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(key),
    () => null,
  );
  const prefs = useMemo(() => parseMapPreferences(raw), [raw]);
  function update(change: (current: MapPreferences) => MapPreferences) {
    // Read again so simultaneous regions cannot overwrite each other's remembered choices.
    const next = schema.parse(change(parseMapPreferences(window.localStorage.getItem(key))));
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE));
  }
  return { prefs, update };
}
