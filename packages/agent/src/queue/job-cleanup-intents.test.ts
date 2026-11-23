import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "@kuintessence/db";
import { JobCleanupIntents, JobRevocationTombstones } from "./job-cleanup-intents";

describe("JobCleanupIntents", () => {
  test("returns undefined when a job has no revocation tombstone", async () => {
    const tombstones = new JobRevocationTombstones(createSqliteDb(":memory:"));

    expect(await tombstones.revokedEpoch("never-revoked")).toBeUndefined();
  });

  test("persists deduplicated target-only cleanup work", async () => {
    const intents = new JobCleanupIntents(createSqliteDb(":memory:"));

    await intents.recordDataDelivery("job-1", {
      bindingId: "binding-1",
      targetPath: "/agent/jobs/job-1/inputs/data.txt",
      method: "object-download",
    });
    await intents.recordDataDelivery("job-1", {
      bindingId: "binding-1",
      targetPath: "/agent/jobs/job-1/inputs/data.txt",
      method: "object-download",
    });
    await intents.recordLicensedMount("job-1", {
      selectorId: "potcar-pbe",
      targetPath: "/agent/jobs/job-1/POTCAR",
    });
    await intents.recordSchedulerSubmitted("job-1", "scheduler-42");
    await intents.recordRestrictedWorkRoot("job-1");
    await intents.recordRevoked("job-1", {
      reason: "DATA_GRANT_REVOKED",
      destroyRestrictedWorkRoot: true,
    });

    expect(await intents.list()).toEqual([
      {
        jobId: "job-1",
        dataDeliveries: [
          {
            bindingId: "binding-1",
            targetPath: "/agent/jobs/job-1/inputs/data.txt",
            method: "object-download",
          },
        ],
        licensedMounts: [{ selectorId: "potcar-pbe", targetPath: "/agent/jobs/job-1/POTCAR" }],
        schedulerJobId: "scheduler-42",
        restrictedWorkRoot: true,
        revoked: true,
        revokeReason: "DATA_GRANT_REVOKED",
      },
    ]);

    await intents.clear("job-1");
    expect(await intents.list()).toEqual([]);
  });

  test("atomically merges concurrent scheduler submission and revocation", async () => {
    const intents = new JobCleanupIntents(createSqliteDb(":memory:"));

    await Promise.all([
      intents.recordSchedulerSubmitted("job-race", "scheduler-42"),
      intents.recordRevoked("job-race", {
        reason: "DATA_GRANT_REVOKED",
        destroyRestrictedWorkRoot: true,
      }),
    ]);

    expect(await intents.list()).toEqual([
      expect.objectContaining({
        jobId: "job-race",
        schedulerJobId: "scheduler-42",
        restrictedWorkRoot: true,
        revoked: true,
        revokeReason: "DATA_GRANT_REVOKED",
      }),
    ]);
  });

  test("keeps the highest revocation epoch after cleanup state is removed", async () => {
    const db = createSqliteDb(":memory:");
    const tombstones = new JobRevocationTombstones(db);
    const intents = new JobCleanupIntents(db);

    await tombstones.record("job-fence", 3);
    await tombstones.record("job-fence", 2);
    await intents.recordRevoked("job-fence", {
      reason: "DATA_GRANT_REVOKED",
      destroyRestrictedWorkRoot: false,
    });
    await intents.clear("job-fence");

    expect(await tombstones.revokedEpoch("job-fence")).toBe(3);
  });
});

test("PVC cleanup survives restart, preserves a failed binding and isolates adjacent jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-pvc-"));
  const path = join(root, "agent.db");
  const db = createSqliteDb(path);
  const next = createSqliteDb(path);
  try {
    const intents = new JobCleanupIntents(db);
    const binding = {
      claimUid: crypto.randomUUID(),
      namespace: "mapped",
      serviceAccount: "worker",
      claim: "materials",
      image: "pinned",
    };
    const first = { jobId: crypto.randomUUID(), preparationId: crypto.randomUUID(), binding };
    const sibling = { ...first, jobId: crypto.randomUUID(), preparationId: crypto.randomUUID() };
    await intents.recordPvc(first);
    await intents.recordPvc(sibling);
    await intents.recordPvc(first);
    await expect(
      intents.recordPvc({ ...first, binding: { ...binding, claimUid: crypto.randomUUID() } }),
    ).rejects.toThrow("binding changed");
    const restored = new JobCleanupIntents(next);
    await expect(
      restored.releasePvcs(first.jobId, async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
    const removed: string[] = [];
    const remove = async (entry: { preparationId: string }) => {
      removed.push(entry.preparationId);
    };
    await restored.releasePvcs(first.jobId, remove);
    await restored.releasePvcs(first.jobId, remove);
    expect(removed).toEqual([first.preparationId]);
    await restored.releasePvcs(sibling.jobId, remove);
    expect(removed).toEqual([first.preparationId, sibling.preparationId]);
  } finally {
    db.$client.close();
    next.$client.close();
    await rm(root, { recursive: true, force: true });
  }
});
