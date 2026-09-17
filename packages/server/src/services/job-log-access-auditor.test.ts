import { describe, expect, test } from "bun:test";
import { JobLogAccessAuditor, type JobLogAccessEvent } from "./job-log-access-auditor";

const privilegedEvent: JobLogAccessEvent = {
  actorUserId: "consumer-admin",
  jobId: "job-1",
  access: "tail",
  scope: "consumer_admin",
};

describe("JobLogAccessAuditor", () => {
  test("records privileged access once within the deduplication window", async () => {
    const events: JobLogAccessEvent[] = [];
    let now = 1_000;
    const auditor = new JobLogAccessAuditor(
      async (event) => {
        events.push(event);
      },
      300,
      () => now,
    );

    await auditor.record(privilegedEvent);
    await auditor.record(privilegedEvent);
    now = 1_301;
    await auditor.record(privilegedEvent);

    expect(events).toEqual([privilegedEvent, privilegedEvent]);
  });

  test("does not audit owner reads", async () => {
    const events: JobLogAccessEvent[] = [];
    const auditor = new JobLogAccessAuditor(async (event) => {
      events.push(event);
    });

    await auditor.record({ ...privilegedEvent, scope: "owner" });

    expect(events).toEqual([]);
  });

  test("retries after an audit sink failure", async () => {
    let attempts = 0;
    const auditor = new JobLogAccessAuditor(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("audit unavailable");
    });

    await expect(auditor.record(privilegedEvent)).rejects.toThrow("audit unavailable");
    await expect(auditor.record(privilegedEvent)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
