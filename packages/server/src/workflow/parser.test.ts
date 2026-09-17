import { describe, expect, test } from "bun:test";
import { parseWorkflowYaml } from "./parser";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("parseWorkflowYaml", () => {
  test("parses a valid workflow", () => {
    const wf = parseWorkflowYaml(`
name: w
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: a
      name: a
      usecaseVersionId: ${UUID}
      softwareVersionId: ${UUID}
`);
    expect(wf.name).toBe("w");
  });

  test("throws on a schema violation (empty workflow name)", () => {
    expect(() => parseWorkflowYaml('name: ""\nspec:\n  nodeDrafts: []\n')).toThrow();
  });

  test("throws on a static validation error (duplicate node id)", () => {
    expect(() =>
      parseWorkflowYaml(`
name: w
spec:
  nodeDrafts:
    - { type: NoAction, id: dup, name: x }
    - { type: NoAction, id: dup, name: y }
`),
    ).toThrow(/duplicate/);
  });
});
