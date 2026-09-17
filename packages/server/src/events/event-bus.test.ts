import { describe, expect, test } from "bun:test";
import { EventBus, type JobStatusChangedEvent, type WorkflowStateChangedEvent } from "./event-bus";

describe("EventBus", () => {
  test("delivers a job event to a single subscriber", () => {
    const bus = new EventBus();
    const received: JobStatusChangedEvent[] = [];
    bus.subscribeJob("job-1", (evt) => received.push(evt));
    bus.publishJobStatus({ jobId: "job-1", status: "running" });
    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe("running");
  });

  test("does not deliver job events to subscribers of a different jobId", () => {
    const bus = new EventBus();
    const received: JobStatusChangedEvent[] = [];
    bus.subscribeJob("job-A", (evt) => received.push(evt));
    bus.publishJobStatus({ jobId: "job-B", status: "completed" });
    expect(received).toHaveLength(0);
  });

  test("delivers a single job event to multiple subscribers in subscription order", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribeJob("job-1", () => order.push("a"));
    bus.subscribeJob("job-1", () => order.push("b"));
    bus.subscribeJob("job-1", () => order.push("c"));
    bus.publishJobStatus({ jobId: "job-1", status: "running" });
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("unsubscribe stops further job event delivery to that subscriber only", () => {
    const bus = new EventBus();
    const a: JobStatusChangedEvent[] = [];
    const b: JobStatusChangedEvent[] = [];
    const unsubA = bus.subscribeJob("job-1", (evt) => a.push(evt));
    bus.subscribeJob("job-1", (evt) => b.push(evt));
    bus.publishJobStatus({ jobId: "job-1", status: "running" });
    unsubA();
    bus.publishJobStatus({ jobId: "job-1", status: "completed" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  test("workflow events are isolated by runId", () => {
    const bus = new EventBus();
    const r1: WorkflowStateChangedEvent[] = [];
    const r2: WorkflowStateChangedEvent[] = [];
    bus.subscribeWorkflow("run-1", (e) => r1.push(e));
    bus.subscribeWorkflow("run-2", (e) => r2.push(e));
    bus.publishWorkflowState({
      runId: "run-1",
      stepId: "a",
      jobId: "job-a",
      status: "completed",
    });
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(0);
  });

  test("workflow subscriber receives stepId/jobId/status fields", () => {
    const bus = new EventBus();
    const received: WorkflowStateChangedEvent[] = [];
    bus.subscribeWorkflow("run-1", (e) => received.push(e));
    bus.publishWorkflowState({
      runId: "run-1",
      stepId: "step-a",
      jobId: "job-a",
      status: "running",
    });
    expect(received[0]).toEqual({
      runId: "run-1",
      stepId: "step-a",
      jobId: "job-a",
      status: "running",
    });
  });

  test("subscriber errors do not abort delivery to remaining subscribers", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.subscribeJob("job-1", () => {
      throw new Error("boom");
    });
    bus.subscribeJob("job-1", (e) => received.push(e.status));
    // Should not throw
    bus.publishJobStatus({ jobId: "job-1", status: "running" });
    expect(received).toEqual(["running"]);
  });

  test("subscriberCount tracks active subscriptions", () => {
    const bus = new EventBus();
    expect(bus.jobSubscriberCount("job-1")).toBe(0);
    const u1 = bus.subscribeJob("job-1", () => {});
    const u2 = bus.subscribeJob("job-1", () => {});
    expect(bus.jobSubscriberCount("job-1")).toBe(2);
    u1();
    expect(bus.jobSubscriberCount("job-1")).toBe(1);
    u2();
    expect(bus.jobSubscriberCount("job-1")).toBe(0);
  });

  test("publishing with no subscribers is a no-op", () => {
    const bus = new EventBus();
    expect(() => bus.publishJobStatus({ jobId: "lonely", status: "completed" })).not.toThrow();
    expect(() =>
      bus.publishWorkflowState({
        runId: "lonely",
        stepId: "x",
        jobId: "y",
        status: "completed",
      }),
    ).not.toThrow();
  });
});
