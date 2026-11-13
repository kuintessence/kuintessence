import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPgDb, jobs, sandboxRuntimeProfiles, scriptExecutionStats } from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { SandboxExecutionStatsService } from "./sandbox-execution-stats";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Sandbox statistics tests require an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const service = new SandboxExecutionStatsService(db);
const runtimeProfileId = randomUUID();
const jobIds: string[] = [];
const sample = {
  assetRevisionId: null,
  inlineScriptHash: "a".repeat(64),
  runtimeProfileId,
  inputBytes: 100,
  predictedOutputBytes: 100,
  actualOutputBytes: 200,
  succeeded: true,
};

beforeAll(async () => {
  await db.insert(sandboxRuntimeProfiles).values({
    id: runtimeProfileId,
    name: "Isolated statistics runtime",
    language: "python",
    languageVersion: "3",
    sifDigest: `sha256:${"a".repeat(64)}`,
    signature: "isolated fixture",
    securityRequirements: {},
  });
});
afterAll(async () => {
  if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
  await db.delete(sandboxRuntimeProfiles).where(eq(sandboxRuntimeProfiles.id, runtimeProfileId));
  await db.$client.end({ timeout: 5 });
});

async function job(status = "completed") {
  const id = randomUUID();
  jobIds.push(id);
  await db.insert(jobs).values({
    id,
    name: "Statistics fixture",
    command: "sandbox-manifest",
    status,
    cpus: 1,
    memoryMb: 64,
  });
  return id;
}

async function marker(id: string) {
  const [row] = await db
    .select({ recordedAt: jobs.sandboxStatsRecordedAt })
    .from(jobs)
    .where(eq(jobs.id, id));
  return row?.recordedAt;
}

test("concurrent replays count once per Job, including failed and cancelled jobs", async () => {
  const success = await job();
  const failure = await job("failed");
  const cancelled = await job("cancelled");
  const inputs = [
    { ...sample, jobId: success },
    { ...sample, jobId: failure, succeeded: false, actualOutputBytes: 0 },
    { ...sample, jobId: cancelled, succeeded: false, actualOutputBytes: 0 },
  ];
  await Promise.all(
    inputs.flatMap((input) => Array.from({ length: 8 }, () => service.record(input))),
  );
  const [row] = await db
    .select()
    .from(scriptExecutionStats)
    .where(eq(scriptExecutionStats.runtimeProfileId, runtimeProfileId));
  expect(row?.sampleCount).toBe(3);
  expect(row?.successCount).toBe(1);
  expect(row?.averageOutputBytes).toBeCloseTo(200 / 3);
  const recordedAt = await marker(success);
  expect(recordedAt).toBeInstanceOf(Date);
  await new SandboxExecutionStatsService(db).record({ ...sample, jobId: success });
  expect(await marker(success)).toEqual(recordedAt);
  await expect(service.record({ ...sample, jobId: failure })).rejects.toThrow("disagree");
});

test("failed aggregate writes roll back the Job marker so retry is possible", async () => {
  const jobId = await job();
  const input = { ...sample, jobId, inlineScriptHash: "b".repeat(64) };
  await expect(service.record({ ...input, runtimeProfileId: randomUUID() })).rejects.toThrow();
  expect(await marker(jobId)).toBeNull();
  await service.record(input);
  expect(await marker(jobId)).toBeInstanceOf(Date);
  const [row] = await db
    .select()
    .from(scriptExecutionStats)
    .where(eq(scriptExecutionStats.inlineScriptHash, input.inlineScriptHash));
  expect(row?.sampleCount).toBe(1);
});

test("missing or unfinished Jobs cannot contribute statistics", async () => {
  const jobId = await job("running");
  await expect(service.record({ ...sample, jobId })).rejects.toThrow("terminal Job");
  await expect(service.record({ ...sample, jobId: randomUUID() })).rejects.toThrow("terminal Job");
  expect(await marker(jobId)).toBeNull();
});
