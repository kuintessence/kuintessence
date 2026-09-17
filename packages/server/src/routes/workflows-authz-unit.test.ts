import { describe, expect, test } from "bun:test";

import type { AuthzService } from "../authz/service";
import { subjectIdForWorkflowAuthz } from "./workflows";

describe("workflow route authz subject binding", () => {
  test("uses the canonical user id in enforce mode", () => {
    expect(subjectIdForWorkflowAuthz({ mode: "enforce" } as AuthzService, "user-uuid")).toBe(
      "user-uuid",
    );
  });

  test("does not use authenticated subject fallback in shadow or off mode", () => {
    expect(subjectIdForWorkflowAuthz({ mode: "shadow" } as AuthzService, null)).toBeNull();
    expect(subjectIdForWorkflowAuthz({ mode: "off" } as AuthzService, null)).toBeNull();
    expect(subjectIdForWorkflowAuthz(undefined, null)).toBeNull();
  });
});
