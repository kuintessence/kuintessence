import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAP_PREFERENCES,
  initialMapDisplay,
  type MapPreferences,
  parseMapPreferences,
} from "./preferences";

function prefs(mode: "memory" | "fixed" | "recommended"): MapPreferences {
  return {
    ...DEFAULT_MAP_PREFERENCES,
    dual: { mode, fixed: "diagram" },
    single: { mode, fixed: "collapsed" },
    pages: { D02: { last: "data" }, D05: { last: "expanded" } },
  };
}
describe("diagram entry preferences", () => {
  test.each([
    ["dual", "memory", "data"],
    ["dual", "fixed", "diagram"],
    ["dual", "recommended", "data"],
    ["single", "memory", "expanded"],
    ["single", "fixed", "collapsed"],
    ["single", "recommended", "expanded"],
  ] as const)("%s in %s mode resolves to %s", (presentation, mode, result) => {
    expect(
      initialMapDisplay({
        prefs: prefs(mode),
        page: presentation === "dual" ? "D02" : "D05",
        presentation,
        recommended: presentation === "dual" ? "data" : "expanded",
      }),
    ).toBe(result);
  });
  test("a valid node target precedes an explicit URL, which precedes a fixed preference", () => {
    const input = {
      prefs: prefs("fixed"),
      page: "D02",
      presentation: "dual",
      recommended: "data",
      url: "data",
    } as const;
    expect(initialMapDisplay({ ...input, nodeTarget: true })).toBe("diagram");
    expect(initialMapDisplay(input)).toBe("data");
    expect(initialMapDisplay({ ...input, url: "invalid" })).toBe("diagram");
  });
  test("first visit uses memory mode with the current page recommendation, without creating a remembered choice", () => {
    const stored = structuredClone(DEFAULT_MAP_PREFERENCES);
    expect(
      initialMapDisplay({
        prefs: stored,
        page: "D02",
        presentation: "dual",
        recommended: "diagram",
      }),
    ).toBe("diagram");
    expect(stored.pages).toEqual({});
    expect(
      initialMapDisplay({ prefs: stored, page: "D02", presentation: "dual", recommended: "data" }),
    ).toBe("data");
  });
  test("corrupt storage and incompatible display values fall back to a valid recommendation", () => {
    expect(parseMapPreferences("not JSON")).toEqual(DEFAULT_MAP_PREFERENCES);
    expect(parseMapPreferences('{"appearance":{"color":"red"}}')).toEqual(DEFAULT_MAP_PREFERENCES);
    const stored = prefs("fixed");
    stored.pages.D05 = { mode: "fixed", fixed: "data" };
    expect(
      initialMapDisplay({
        prefs: stored,
        page: "D05",
        presentation: "single",
        recommended: "expanded",
      }),
    ).toBe("expanded");
  });
});
