import { describe, expect, test } from "vitest";
import {
  buildSchedulingStrategy,
  isPlacementSelectionAvailable,
  queueEligibility,
  queueTargetMode,
} from "./queue-selection";

const defaultQueue = {
  queueId: "queue-default",
  name: "Scheduler default",
  providerOrgId: "11111111-1111-4111-8111-111111111111",
  visibleOrgIds: [],
  agentId: "agent-1",
  schedulerType: "slurm" as const,
  queueName: null,
  target: { mode: "default" as const },
  qos: null,
  submitEligibility: undefined,
  enabled: true,
  policyTags: [],
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

const namedQueue = {
  ...defaultQueue,
  queueId: "queue-named",
  name: "Named queue",
  queueName: "compute",
  target: { mode: "named" as const },
};

describe("queue selection", () => {
  test("uses no scheduling strategy for Auto and a stable queueId for explicit modes", () => {
    expect(buildSchedulingStrategy({ mode: "auto" })).toBeUndefined();
    expect(buildSchedulingStrategy({ mode: "default", queueId: "queue-default" })).toEqual({
      queueId: "queue-default",
    });
    expect(buildSchedulingStrategy({ mode: "named", queueId: "queue-named" })).toEqual({
      queueId: "queue-named",
    });
  });

  test("keeps legacy named responses compatible and requires a matching explicit mode", () => {
    const legacyNamedQueue = { ...namedQueue, target: undefined };
    expect(queueTargetMode(defaultQueue)).toBe("default");
    expect(queueTargetMode(legacyNamedQueue)).toBe("named");
    expect(
      isPlacementSelectionAvailable({ mode: "default", queueId: "queue-default" }, [
        defaultQueue,
        namedQueue,
      ]),
    ).toBe(true);
    expect(
      isPlacementSelectionAvailable({ mode: "named", queueId: "queue-default" }, [
        defaultQueue,
        namedQueue,
      ]),
    ).toBe(false);
  });

  test("defaults additive eligibility to ready for older Server responses", () => {
    expect(queueEligibility(defaultQueue)).toEqual({
      state: "ready",
      reason: null,
      retryable: false,
    });
    expect(
      queueEligibility({
        ...namedQueue,
        submitEligibility: { state: "blocked" as const, reason: "stale" as const, retryable: true },
      }),
    ).toEqual({ state: "blocked", reason: "stale", retryable: true });
  });
});
