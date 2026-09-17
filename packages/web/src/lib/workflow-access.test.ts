import { describe, expect, test } from "vitest";
import { canCreateWorkflow } from "./workflow-access";

describe("canCreateWorkflow", () => {
  test("allows local mode without Server capabilities", () => {
    expect(canCreateWorkflow(true, new Set())).toBe(true);
  });

  test("requires workflow.submit in Server mode", () => {
    expect(canCreateWorkflow(false, new Set(["workflow.submit"]))).toBe(true);
    expect(canCreateWorkflow(false, new Set(["workspace.ecosystem.view"]))).toBe(false);
  });
});
