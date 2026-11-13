import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as schema from "@kuintessence/db";
import { runSqliteMigrations } from "@kuintessence/db";
import type { FederationAccountingRequest } from "@kuintessence/shared/federation";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { JobStatusResult, KuintessenceJobLookupResult } from "../adapters/base";
import { InboundAcks } from "../queue/inbound-acks";
import { collectFederationAccounting } from "./accounting";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  runSqliteMigrations(sqlite);
  const db = drizzle(sqlite, { schema }),
    receipts = new InboundAcks(db);
  const request: FederationAccountingRequest = {
    version: 1,
    requestId: randomUUID(),
    jobId: randomUUID(),
    dispatchEpoch: 2,
    schedulerJobId: "42",
    originalEvidenceDigest: `sha256:${"a".repeat(64)}`,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await receipts.persistInbound({
    dispatchId: `${request.jobId}:2`,
    jobId: request.jobId,
    payload: {
      federationExecution: true,
      federationSubmissionStarted: true,
      federationReceipt: { version: 1, epoch: 2, digest: "b".repeat(64), renewableInputs: [] },
      federationSubmission: {
        spec: {
          jobId: request.jobId,
          name: "probe",
          command: "not executed",
          cpus: 1,
          memoryMb: 64,
          gpus: 0,
          wallTimeSec: 60,
          workingDir: "/unused",
          envVars: {},
          federationDispatchEpoch: 2,
          schedulerName: "kf2",
        },
        expectedOutputs: [],
      },
    },
  });
  let queries = 0;
  const adapter = {
    type: "slurm" as const,
    findByKuintessenceJobId: async (): Promise<KuintessenceJobLookupResult> => {
      queries++;
      return { status: "found", schedulerJobId: "42" };
    },
    status: async (): Promise<JobStatusResult> => ({
      status: "completed",
      exitCode: 0,
      accounting: {
        version: 1,
        source: "slurm-sacct",
        schedulerJobId: "42",
        observedAt: new Date().toISOString(),
        cpuTimeMilliseconds: "2018",
      },
    }),
  };
  return { db, receipts, request, adapter, queries: () => queries };
}
test("accounting query resumes from SQLite receipts and preserves partial integer observations", async () => {
  const f = await fixture();
  const response = await collectFederationAccounting(new InboundAcks(f.db), f.adapter, f.request);
  expect(response).toMatchObject({
    state: "observed",
    observation: {
      originalEvidenceDigest: f.request.originalEvidenceDigest,
      dispatchEpoch: 2,
      accounting: { cpuTimeMilliseconds: "2018" },
    },
  });
  expect(f.queries()).toBe(2);
  if (response.state !== "observed") throw new Error("Missing observation");
  expect(response.observation.accounting.elapsedMilliseconds).toBeUndefined();
  expect(JSON.stringify(response)).not.toContain("not executed");
});
test("accounting query rejects wrong epoch, stale deadline and recycled scheduler identity", async () => {
  const f = await fixture();
  expect(
    (await collectFederationAccounting(f.receipts, f.adapter, { ...f.request, dispatchEpoch: 3 }))
      .state,
  ).toBe("identity_mismatch");
  expect(
    (
      await collectFederationAccounting(f.receipts, f.adapter, {
        ...f.request,
        expiresAt: new Date(0).toISOString(),
      })
    ).state,
  ).toBe("unavailable");
  expect(f.queries()).toBe(0);
  let calls = 0;
  f.adapter.findByKuintessenceJobId = async () => ({
    status: "found",
    schedulerJobId: ++calls === 1 ? "42" : "43",
  });
  expect((await collectFederationAccounting(f.receipts, f.adapter, f.request)).state).toBe(
    "unavailable",
  );
});
test("accounting query keeps unavailable and nonterminal facts separate", async () => {
  const f = await fixture();
  f.adapter.status = async () => ({ status: "running" });
  expect((await collectFederationAccounting(f.receipts, f.adapter, f.request)).state).toBe(
    "not_terminal",
  );
  f.adapter.status = async () => ({ status: "completed", exitCode: 0 });
  expect((await collectFederationAccounting(f.receipts, f.adapter, f.request)).state).toBe(
    "unavailable",
  );
});
