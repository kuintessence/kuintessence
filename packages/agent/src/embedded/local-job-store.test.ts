import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "@kuintessence/db";
import { SqliteLocalJobStore } from "./local-job-store";

function store(): SqliteLocalJobStore {
  return new SqliteLocalJobStore(createSqliteDb(":memory:"));
}

const base = {
  jobId: "u1",
  schedulerJobId: "100",
  name: "wrf",
  status: "running",
  command: "echo hi",
  cpus: 4,
  memoryMb: 8192,
  gpus: 2,
  wallTimeSec: 3600,
  submittedAt: new Date(1_000_000),
};

describe("SqliteLocalJobStore", () => {
  test("record then list round-trips the job fields", () => {
    const s = store();
    s.record(base);
    const all = s.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      jobId: "u1",
      schedulerJobId: "100",
      name: "wrf",
      status: "running",
      command: "echo hi",
      cpus: 4,
      memoryMb: 8192,
      gpus: 2,
      wallTimeSec: 3600,
    });
    expect(all[0]?.submittedAt).toBeInstanceOf(Date);
  });

  test("recording the same jobId again upserts (no duplicate row)", () => {
    const s = store();
    s.record(base);
    s.record({ ...base, schedulerJobId: "101", status: "queued" });
    const all = s.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ schedulerJobId: "101", status: "queued" });
  });

  test("updateStatusBySchedulerId updates status + exit code; unknown id is a no-op", () => {
    const s = store();
    s.record(base);
    s.updateStatusBySchedulerId("100", "completed", 0);
    expect(s.list()[0]).toMatchObject({ status: "completed", exitCode: 0 });
    s.updateStatusBySchedulerId("does-not-exist", "failed", 1);
    expect(s.list()[0]).toMatchObject({ status: "completed", exitCode: 0 });
  });

  test("list returns most-recently-submitted first", () => {
    const s = store();
    s.record({ ...base, jobId: "old", schedulerJobId: "1", submittedAt: new Date(1_000) });
    s.record({ ...base, jobId: "new", schedulerJobId: "2", submittedAt: new Date(9_000) });
    expect(s.list().map((j) => j.jobId)).toEqual(["new", "old"]);
  });

  test("list(limit) caps to the most-recent N", () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      s.record({
        ...base,
        jobId: `j${i}`,
        schedulerJobId: `${i}`,
        submittedAt: new Date(i * 1000),
      });
    }
    expect(s.list(2).map((j) => j.jobId)).toEqual(["j4", "j3"]);
    expect(s.list().length).toBe(5);
  });

  test("record prunes the store to the most-recent maxRows (bounds growth)", () => {
    const s = new SqliteLocalJobStore(createSqliteDb(":memory:"), 3);
    for (let i = 0; i < 6; i++) {
      s.record({
        ...base,
        jobId: `j${i}`,
        schedulerJobId: `${i}`,
        submittedAt: new Date(i * 1000),
      });
    }
    const all = s.list();
    expect(all).toHaveLength(3); // older rows pruned from storage, not just hidden
    expect(all.map((j) => j.jobId)).toEqual(["j5", "j4", "j3"]);
  });

  test("findBySchedulerId matches scheduler id or job id, else undefined", () => {
    const s = store();
    s.record({ ...base, jobId: "u9", schedulerJobId: "900" });
    expect(s.findBySchedulerId("900")?.jobId).toBe("u9");
    expect(s.findBySchedulerId("u9")?.jobId).toBe("u9");
    expect(s.findBySchedulerId("nope")).toBeUndefined();
  });

  test("a status-only update preserves a previously-recorded exit code", () => {
    const s = store();
    s.record(base);
    s.updateStatusBySchedulerId("100", "completed", 0);
    s.updateStatusBySchedulerId("100", "completed"); // status-only re-poll
    expect(s.findBySchedulerId("100")?.exitCode).toBe(0);
  });

  test("findBySchedulerId returns the most recent on scheduler-id reuse", () => {
    const s = store();
    s.record({ ...base, jobId: "old", schedulerJobId: "100", submittedAt: new Date(1_000) });
    s.record({ ...base, jobId: "new", schedulerJobId: "100", submittedAt: new Date(9_000) });
    expect(s.findBySchedulerId("100")?.jobId).toBe("new");
  });

  test("a file-backed store survives reopen (the restart guarantee)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-store-"));
    const path = join(dir, "local.db");
    try {
      new SqliteLocalJobStore(createSqliteDb(path)).record(base);
      // A fresh store at the same path = a TUI restart.
      const reopened = new SqliteLocalJobStore(createSqliteDb(path));
      expect(reopened.list()).toHaveLength(1);
      expect(reopened.list()[0]).toMatchObject({ jobId: "u1", name: "wrf", status: "running" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
