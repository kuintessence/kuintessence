import { describe, expect, test } from "vitest";
import { isWorkflowQueueUuid } from "./WorkflowResourcesStep";

describe("isWorkflowQueueUuid", () => {
  test("accepts queue registry UUIDs and rejects scheduler slugs", () => {
    expect(isWorkflowQueueUuid("88888888-8888-4888-8888-888888888301")).toBe(true);
    expect(isWorkflowQueueUuid("torque-workq")).toBe(false);
  });
});
