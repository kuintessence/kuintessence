import { describe, expect, test } from "bun:test";
import type { RunResult, WorkflowRunGraph } from "@kuintessence/shared";
import { WorkflowAsyncRunner } from "./async-runner";
import type { WorkflowRunRegistry } from "./run-registry";

const validYaml = `
name: async-wf
spec:
  nodeDrafts:
    - type: NoAction
      id: a
      name: a
`;

function makeRegistry(events: string[]) {
  let status = "submitted";
  let startedAt: Date | null = null;
  return {
    createRun: async (name: string, submittedBy: string, graph: WorkflowRunGraph) => {
      events.push(`create:${name}:${submittedBy}:${graph.nodes.length}`);
      return "run-1";
    },
    queueAuthorizedRun: async (runId: string) => {
      if (status !== "submitted") return false;
      status = "queued";
      events.push(`queued:${runId}`);
      return true;
    },
    claimForExecution: async (runId: string) => {
      if (status !== "queued") return false;
      status = "running";
      startedAt = new Date();
      events.push(`running:${runId}`);
      return true;
    },
    completeRun: async (runId: string, result: RunResult) => {
      status = "completed";
      events.push(`complete:${runId}:${result.status.a}`);
      return true;
    },
    failRun: async (runId: string, err: unknown) => {
      status = "failed";
      events.push(`fail:${runId}:${err instanceof Error ? err.message : String(err)}`);
      return true;
    },
    requestCancel: async (runId: string) => {
      status = "cancelling";
      events.push(`request-cancel:${runId}`);
      return "cancelling";
    },
    cancelRun: async (runId: string) => {
      status = "cancelled";
      events.push(`cancel:${runId}`);
      return true;
    },
    requestInterrupt: async (runId: string) => {
      status = "cancelling";
      events.push(`interrupt:${runId}`);
      return true;
    },
    failInterruptedRun: async (runId: string) => {
      status = "failed";
      events.push(`interrupted-fail:${runId}`);
      return true;
    },
    getById: async (runId: string) => ({ id: runId, status, startedAt }),
    listRecoverableRuns: async () => [],
  } as unknown as WorkflowRunRegistry;
}

describe("WorkflowAsyncRunner", () => {
  test("creates a submitted run and schedules execution without awaiting it", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      makeRunner: () => async () => {
        events.push("execute");
        return { status: { a: "Succeeded" }, values: { a: { status: "Succeeded", values: {} } } };
      },
      schedule: (task) => scheduled.push(task),
    });

    const result = await runner.submit({
      yaml: validYaml,
      submittedBy: "user-1",
      role: "user",
      authorizeRun: async (runId) => {
        events.push(`authorize:${runId}`);
      },
    });

    expect(result).toEqual({ runId: "run-1", name: "async-wf", status: "submitted" });
    expect(events).toEqual(["create:async-wf:user-1:1", "authorize:run-1", "queued:run-1"]);
    expect(scheduled).toHaveLength(1);

    await scheduled[0]?.();
    expect(events).toEqual([
      "create:async-wf:user-1:1",
      "authorize:run-1",
      "queued:run-1",
      "running:run-1",
      "execute",
      "complete:run-1:Succeeded",
    ]);
  });

  test("fails closed before scheduling when run authorization rejects", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    let failureCode: string | undefined;
    const registry = {
      ...makeRegistry(events),
      failRun: async (runId: string, err: unknown, errorCode?: string) => {
        failureCode = errorCode;
        events.push(`fail:${runId}:${err instanceof Error ? err.message : String(err)}`);
      },
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: () => async () => {
        throw new Error("must not execute");
      },
      schedule: (task) => scheduled.push(task),
    });

    await expect(
      runner.submit({
        yaml: validYaml,
        submittedBy: "user-1",
        role: "user",
        authorizeRun: async () => {
          throw new Error("SpiceDB unavailable");
        },
      }),
    ).rejects.toThrow("SpiceDB unavailable");

    expect(events).toEqual(["create:async-wf:user-1:1", "fail:run-1:SpiceDB unavailable"]);
    expect(failureCode).toBe("WORKFLOW_AUTHORIZATION_FAILED");
    expect(scheduled).toHaveLength(0);
  });

  test("marks the run failed when background execution rejects", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      makeRunner: () => async () => {
        throw new Error("boom");
      },
      schedule: (task) => scheduled.push(task),
    });

    await runner.submit({
      yaml: validYaml,
      submittedBy: "user-1",
      role: "user",
      authorizeRun: async () => {},
    });
    await scheduled[0]?.();

    expect(events).toEqual([
      "create:async-wf:user-1:1",
      "queued:run-1",
      "running:run-1",
      "fail:run-1:boom",
    ]);
  });

  test("passes the canonical principal to named-reference resolution before persisting the run", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const principal = {
      sub: "subject",
      role: "user",
      email: "scientist@example.test",
      userId: "11111111-1111-4111-8111-111111111111",
      orgId: null,
      orgIds: [],
      memberships: [],
      capabilities: [],
    };
    let receivedUserId: string | null | undefined;
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      resolveNamedReferences: async (workflow, receivedPrincipal) => {
        receivedUserId = receivedPrincipal?.userId;
        return workflow;
      },
      makeRunner: () => async () => ({ status: {}, values: {} }),
      schedule: (task) => scheduled.push(task),
    });

    await runner.submit({
      yaml: validYaml,
      submittedBy: principal.userId,
      role: "user",
      principal,
      authorizeRun: async () => {},
    });

    expect(receivedUserId).toBe(principal.userId);
    expect(events).toEqual([
      "create:async-wf:11111111-1111-4111-8111-111111111111:1",
      "queued:run-1",
    ]);
  });

  test("persists the active organization from the submitting principal", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    let persistedOrgId: string | null | undefined;
    const registry = {
      ...makeRegistry(events),
      createRun: async (...args: Parameters<WorkflowRunRegistry["createRun"]>) => {
        persistedOrgId = args[3]?.orgId;
        return "run-1";
      },
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: () => async () => ({ status: {}, values: {} }),
      schedule: (task) => scheduled.push(task),
    });

    await runner.submit({
      yaml: validYaml,
      submittedBy: "user-1",
      role: "user",
      principal: {
        sub: "subject",
        role: "user",
        email: "scientist@example.test",
        userId: "user-1",
        orgId: "org-active",
        orgIds: ["org-active", "org-other"],
        memberships: [],
        capabilities: [],
      },
      authorizeRun: async () => {},
    });

    expect(persistedOrgId).toBe("org-active");
  });

  test("rejects a submission when the submitter left its active organization", async () => {
    const events: string[] = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      assertExecutionPrincipal: async (principal) => {
        expect(principal).toEqual({ userId: "user-1", orgId: "org-active" });
        throw new Error("Workflow submitter is no longer a member of the active organization");
      },
      makeRunner: () => async () => ({ status: {}, values: {} }),
    });

    await expect(
      runner.submit({
        yaml: validYaml,
        submittedBy: "user-1",
        role: "user",
        principal: {
          sub: "subject",
          role: "user",
          email: "scientist@example.test",
          userId: "user-1",
          orgId: "org-active",
          orgIds: ["org-active"],
          memberships: [],
          capabilities: [],
        },
        authorizeRun: async () => {},
      }),
    ).rejects.toThrow("Workflow submitter is no longer a member of the active organization");

    expect(events).toEqual([]);
  });

  test("rejects Dataset preflight failures before creating a run", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const principal = {
      sub: "subject",
      role: "user",
      email: "scientist@example.test",
      userId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      orgIds: ["22222222-2222-4222-8222-222222222222"],
      memberships: [],
      capabilities: [],
    };
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      validateWorkflow: async (_workflow, receivedPrincipal) => {
        expect(receivedPrincipal).toBe(principal);
        throw new Error("DATASET_INPUT_REQUIRED: trainingData");
      },
      makeRunner: () => async () => {
        throw new Error("must not execute");
      },
      schedule: (task) => scheduled.push(task),
    });

    await expect(
      runner.submit({
        yaml: validYaml,
        submittedBy: principal.userId,
        role: "user",
        principal,
        authorizeRun: async () => {
          throw new Error("must not authorize");
        },
      }),
    ).rejects.toThrow("DATASET_INPUT_REQUIRED: trainingData");

    expect(events).toEqual([]);
    expect(scheduled).toHaveLength(0);
  });

  test("rejects revoked or forged Dataset references before creating a run", async () => {
    const events: string[] = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      validateWorkflow: async () => {
        throw new Error("Not authorized to use the selected Data Market version");
      },
      makeRunner: () => async () => ({ status: {}, values: {} }),
    });

    await expect(
      runner.submit({
        yaml: validYaml,
        submittedBy: "user-1",
        role: "user",
        authorizeRun: async () => {},
      }),
    ).rejects.toThrow("Not authorized to use the selected Data Market version");

    expect(events).toEqual([]);
  });

  test("fails the submission after persisting a placement preparation failure", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      makeRunner: () => async () => ({ status: {}, values: {} }),
      preparePlacement: async () => {
        throw new Error("runtime profile unavailable");
      },
      schedule: (task) => scheduled.push(task),
    });

    await expect(
      runner.submit({
        yaml: validYaml,
        submittedBy: "user-1",
        role: "user",
        authorizeRun: async () => {},
      }),
    ).rejects.toThrow("runtime profile unavailable");
    expect(events).toEqual(["create:async-wf:user-1:1", "fail:run-1:runtime profile unavailable"]);
    expect(scheduled).toHaveLength(0);
  });

  test("does not revive a run cancelled while placement is finishing", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      queueAuthorizedRun: async () => false,
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: () => async () => {
        throw new Error("must not execute");
      },
      preparePlacement: async () => "within-cap",
      schedule: (task) => scheduled.push(task),
    });

    await expect(
      runner.submit({
        yaml: validYaml,
        submittedBy: "user-1",
        role: "user",
        authorizeRun: async () => {},
      }),
    ).rejects.toThrow("left submitted state");

    expect(events).toEqual(["create:async-wf:user-1:1"]);
    expect(scheduled).toHaveLength(0);
  });

  test("leaves the placement store as the sole awaiting-approval state writer", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      makeRunner: () => async () => {
        throw new Error("must not execute");
      },
      preparePlacement: async () => "awaiting-approval",
      schedule: (task) => scheduled.push(task),
    });

    const result = await runner.submit({
      yaml: validYaml,
      submittedBy: "user-1",
      role: "user",
      authorizeRun: async () => {},
    });

    expect(result.status).toBe("awaiting_approval");
    expect(events).toEqual(["create:async-wf:user-1:1"]);
    expect(scheduled).toHaveLength(0);
  });

  test("cancels a submitted run before it starts", async () => {
    const events: string[] = [];
    const runner = new WorkflowAsyncRunner({
      registry: makeRegistry(events),
      makeRunner: () => async () => {
        throw new Error("should not run");
      },
      schedule: () => {},
    });

    const status = await runner.cancel("run-1");

    expect(status).toBe("cancelled");
    expect(events).toEqual(["request-cancel:run-1", "cancel:run-1"]);
  });

  test("requests cancellation for submitted jobs when cancelling a running run", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      requestCancel: async (runId: string) => {
        events.push(`request-cancel:${runId}`);
        return "cancelling";
      },
      getById: async (runId: string) => ({
        id: runId,
        status: "cancelling",
        startedAt: new Date(),
      }),
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: () => async () => {
        throw new Error("should not run");
      },
      cancelSubmittedJobs: async (runId) => {
        events.push(`cancel-jobs:${runId}`);
      },
      schedule: (task) => scheduled.push(task),
    });

    const status = await runner.cancel("run-1");
    await scheduled[0]?.();

    expect(status).toBe("cancelling");
    expect(events).toEqual(["request-cancel:run-1", "cancel-jobs:run-1", "cancel:run-1"]);
  });

  test("approval and recovery scheduling execute a queued run exactly once", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      getById: async () => ({
        id: "run-queued",
        status: "queued",
        submittedBy: "user-1",
        input: { yaml: validYaml, role: "user", placementConfig: {} },
      }),
    } as unknown as WorkflowRunRegistry;
    await registry.queueAuthorizedRun("run-queued");
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: () => async () => {
        events.push("execute-approved");
        return { status: { a: "Succeeded" }, values: { a: { status: "Succeeded", values: {} } } };
      },
      schedule: (task) => scheduled.push(task),
    });

    expect(await runner.resumeAfterApproval("run-queued")).toBe("queued");
    expect(await runner.resumeAfterApproval("run-queued")).toBe("queued");
    expect(scheduled).toHaveLength(2);
    await Promise.all(scheduled.map((task) => task()));

    expect(events.filter((event) => event === "execute-approved")).toHaveLength(1);
  });

  test("passes persisted organizations to runners resumed after approval and recovery", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const receivedOrgIds: Array<string | null | undefined> = [];
    const registry = {
      ...makeRegistry(events),
      getById: async (runId: string) =>
        runId === "run-approved"
          ? {
              id: runId,
              status: "queued",
              submittedBy: "user-1",
              input: { yaml: validYaml, role: "user", placementConfig: {}, orgId: "org-approved" },
            }
          : { id: runId, status: "queued" },
      listRecoverableRuns: async () => [
        {
          id: "run-recovered",
          status: "queued",
          submittedBy: "user-2",
          input: { yaml: validYaml, role: "user", placementConfig: {}, orgId: "org-recovered" },
        },
      ],
      claimForExecution: async () => true,
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: (_submittedBy, _role, _runId, _placementConfig, orgId) => async () => {
        receivedOrgIds.push(orgId);
        return { status: { a: "Succeeded" }, values: { a: { status: "Succeeded", values: {} } } };
      },
      schedule: (task) => scheduled.push(task),
    });

    expect(await runner.resumeAfterApproval("run-approved")).toBe("queued");
    expect(await runner.recoverInterruptedRuns()).toEqual({ resumed: 1, failedInterrupted: 0 });
    await Promise.all(scheduled.map((task) => task()));

    expect(receivedOrgIds).toEqual(["org-approved", "org-recovered"]);
  });

  test("revalidates a queued workflow before approval recovery executes it", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      getById: async () => ({
        id: "run-approved",
        status: "queued",
        submittedBy: "user-1",
        input: { yaml: validYaml, role: "user", placementConfig: {}, orgId: "org-approved" },
      }),
      claimForExecution: async () => true,
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      validateWorkflow: async (_workflow, principal) => {
        expect(principal).toEqual({ userId: "user-1", orgId: "org-approved" });
        throw new Error("Usecase package is outside the active organization");
      },
      makeRunner: () => async () => {
        events.push("must-not-execute");
        return { status: {}, values: {} };
      },
      schedule: (task) => scheduled.push(task),
    });

    expect(await runner.resumeAfterApproval("run-approved")).toBe("queued");
    await scheduled[0]?.();

    expect(events).not.toContain("must-not-execute");
    expect(events).toContain(
      "fail:run-approved:Usecase package is outside the active organization",
    );
  });

  test("fails an approval recovery when the submitter left the frozen organization", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      getById: async () => ({
        id: "run-approved",
        status: "queued",
        submittedBy: "user-1",
        input: { yaml: validYaml, role: "user", placementConfig: {}, orgId: "org-frozen" },
      }),
      claimForExecution: async () => true,
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      assertExecutionPrincipal: async (principal) => {
        expect(principal).toEqual({ userId: "user-1", orgId: "org-frozen" });
        throw new Error("Workflow submitter is no longer a member of the active organization");
      },
      makeRunner: () => async () => {
        events.push("must-not-execute");
        return { status: {}, values: {} };
      },
      schedule: (task) => scheduled.push(task),
    });

    expect(await runner.resumeAfterApproval("run-approved")).toBe("queued");
    await scheduled[0]?.();

    expect(events).not.toContain("must-not-execute");
    expect(events).toContain(
      "fail:run-approved:Workflow submitter is no longer a member of the active organization",
    );
  });

  test("fails a Server restart recovery when the submitter left the frozen organization", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      listRecoverableRuns: async () => [
        {
          id: "run-recovered",
          status: "queued",
          submittedBy: "user-1",
          input: { yaml: validYaml, role: "user", placementConfig: {}, orgId: "org-frozen" },
        },
      ],
      claimForExecution: async () => true,
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      assertExecutionPrincipal: async () => {
        throw new Error("Workflow submitter is no longer a member of the active organization");
      },
      makeRunner: () => async () => {
        events.push("must-not-execute");
        return { status: {}, values: {} };
      },
      schedule: (task) => scheduled.push(task),
    });

    expect(await runner.recoverInterruptedRuns()).toEqual({ resumed: 1, failedInterrupted: 0 });
    await scheduled[0]?.();

    expect(events).not.toContain("must-not-execute");
    expect(events).toContain(
      "fail:run-recovered:Workflow submitter is no longer a member of the active organization",
    );
  });

  test("recovers authorized queued runs and fails interrupted non-queued runs", async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const registry = {
      ...makeRegistry(events),
      listRecoverableRuns: async () => [
        {
          id: "run-queued",
          status: "queued",
          submittedBy: "user-1",
          input: { yaml: validYaml, role: "user" },
        },
        {
          id: "run-submitted",
          status: "submitted",
          submittedBy: "user-1",
          input: { yaml: validYaml, role: "user" },
        },
        { id: "run-running", status: "running", submittedBy: "user-1", input: null },
      ],
      failRun: async (runId: string, err: unknown) => {
        events.push(`recover-fail:${runId}:${err instanceof Error ? err.message : String(err)}`);
        return true;
      },
      requestInterrupt: async (runId: string) => {
        events.push(`recover-interrupt:${runId}`);
        return true;
      },
      getById: async (runId: string) => ({
        id: runId,
        status: "cancelling",
        startedAt: new Date(),
        stepJobs: {},
        errorCode: runId === "run-running" ? "WORKFLOW_INTERRUPTED" : null,
      }),
    } as unknown as WorkflowRunRegistry;
    const runner = new WorkflowAsyncRunner({
      registry,
      makeRunner: () => async () => {
        events.push("recovered-execute");
        return { status: { a: "Succeeded" }, values: { a: { status: "Succeeded", values: {} } } };
      },
      schedule: (task) => scheduled.push(task),
    });

    const report = await runner.recoverInterruptedRuns();

    expect(report).toEqual({ resumed: 2, failedInterrupted: 2 });
    expect(scheduled).toHaveLength(2);
    expect(events.some((event) => event.startsWith("recover-fail:run-submitted:"))).toBe(true);
    expect(events).toContain("recover-interrupt:run-running");
  });
});
