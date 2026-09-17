import { describe, expect, test } from "vitest";
import { parseWorkflowYaml } from "../../lib/workflow-parser";
import { TEMPLATES } from "./templates";

describe("workflow templates", () => {
  test.each(TEMPLATES.map((t) => [t.slug, t] as const))("%s parses", (_slug, t) => {
    const r = parseWorkflowYaml(t.yaml);
    if (!r.ok) throw new Error(`${t.slug} failed to parse: ${r.message}`);
    expect(r.ok).toBe(true);
  });

  test("every template has a unique slug and non-empty name/blurb", () => {
    const slugs = new Set<string>();
    for (const t of TEMPLATES) {
      expect(slugs.has(t.slug)).toBe(false);
      slugs.add(t.slug);
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.blurb.trim().length).toBeGreaterThan(0);
    }
  });
});
