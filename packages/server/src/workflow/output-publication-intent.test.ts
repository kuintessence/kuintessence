import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usecase } from "@kuintessence/shared";
import type { PublicationInput, PublicationRecord } from "./output-publication";
import {
  type PublicationIntentJob,
  type PublicationIntentStore,
  WorkflowPublicationIntentRecovery,
} from "./output-publication-intent";

type State = {
  intents: Record<
    string,
    { job: PublicationIntentJob; nextAttemptAt: number; attempts: number; error?: string }
  >;
  publications: Record<string, PublicationRecord>;
};
const completed = (jobId = "completed"): PublicationIntentJob => ({
  jobId,
  workflowRunId: "original-run",
  status: "completed",
  submittedBy: "original-owner",
  agentId: "original-agent",
  workingDir: "/shared/original-job",
  restrictedNoEgress: false,
  sandboxExecution: null,
  expectedOutputs: [{ descriptor: "result", path: "out.dat", isBatch: false, pathsOnly: true }],
  fileOutputDescriptors: ["result"],
  collectedOutputs: { [usecase.batchOutputPathsDescriptor("result")]: '["out.dat"]' },
});

class DiskRecovery {
  now = 0;
  removeFails = false;
  constructor(private readonly path: string) {}
  async read(): Promise<State> {
    return JSON.parse(await readFile(this.path, "utf8"));
  }
  async write(state: State) {
    await writeFile(this.path, JSON.stringify(state));
  }
  store: PublicationIntentStore = {
    pending: async (limit) =>
      Object.entries((await this.read()).intents)
        .filter(([, value]) => value.job.status === "completed" && value.nextAttemptAt <= this.now)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
        .map(([id]) => id),
    load: async (id) => (await this.read()).intents[id]?.job,
    remove: async (id) => {
      if (this.removeFails) throw new Error("crash after durable enqueue");
      const state = await this.read();
      delete state.intents[id];
      await this.write(state);
    },
    retry: async (id) => {
      const state = await this.read();
      const row = state.intents[id];
      if (row) {
        row.nextAttemptAt = this.now + Math.min(300_000, 30_000 * 2 ** Math.min(row.attempts, 4));
        row.attempts++;
        row.error = "Workflow output intent pending; metadata or publication retry required";
      }
      await this.write(state);
    },
  };
  publications = {
    get: async (id: string) => (await this.read()).publications[id],
    enqueue: async (input: PublicationInput) => {
      const state = await this.read();
      const previous = state.publications[input.jobId];
      if (previous) return previous;
      const record = { input, files: {}, released: false };
      state.publications[input.jobId] = record;
      await this.write(state);
      return record;
    },
  };
  recovery() {
    return new WorkflowPublicationIntentRecovery({
      store: this.store,
      publications: this.publications,
    });
  }
}

async function fixture(
  jobs: PublicationIntentJob[],
  run: (disk: DiskRecovery, path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "kq-publication-intent-"));
  const path = join(directory, "durable.json");
  const disk = new DiskRecovery(path);
  await disk.write({
    intents: Object.fromEntries(
      jobs.map((job) => [job.jobId, { job, attempts: 0, nextAttemptAt: 0 }]),
    ),
    publications: {},
  });
  try {
    await run(disk, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("restart reconstructs publication from persisted completed job facts without resubmitting or releasing", async () => {
  await fixture([completed()], async (_firstProcess, path) => {
    const restarted = new DiskRecovery(path);
    expect(await restarted.recovery().recover()).toEqual({ enqueued: 1, failed: 0 });
    const state = await restarted.read();
    const row = state.publications.completed;
    if (!row) throw new Error("Missing recovered publication");
    expect(row?.input).toMatchObject({
      jobId: "completed",
      ownerId: "original-owner",
      agentId: "original-agent",
      workflowRunId: "original-run",
    });
    expect(row?.input.files[0]?.source).toBe("/shared/original-job/out.dat");
    expect(row?.released).toBe(false);
    expect(state.intents).toEqual({});
    expect(await restarted.recovery().enqueue("completed")).toEqual(row);
  });
});

test("crash after enqueue before deleting intent preserves the first transfer IDs on retry", async () => {
  await fixture([completed()], async (disk, path) => {
    disk.removeFails = true;
    expect(await disk.recovery().recover()).toEqual({ enqueued: 0, failed: 1 });
    const ids = (await disk.read()).publications.completed?.input.files.map(
      (file) => file.transferId,
    );
    const restarted = new DiskRecovery(path);
    restarted.now = 30_000;
    expect(await restarted.recovery().recover()).toEqual({ enqueued: 1, failed: 0 });
    expect(
      (await restarted.read()).publications.completed?.input.files.map((file) => file.transferId),
    ).toEqual(ids);
    expect((await restarted.read()).intents).toEqual({});
  });
});

test("bad paths back off without starving a later completed job or releasing its root", async () => {
  const bad = completed("a-bad");
  bad.collectedOutputs = { [usecase.batchOutputPathsDescriptor("result")]: '["../secret"]' };
  await fixture([bad, completed("b-good")], async (disk) => {
    expect(await disk.recovery().recover()).toEqual({ enqueued: 1, failed: 1 });
    const state = await disk.read();
    expect(state.publications["a-bad"]).toBeUndefined();
    expect(state.intents["a-bad"]).toMatchObject({ attempts: 1, nextAttemptAt: 30_000 });
    expect(state.intents["a-bad"]?.error).not.toContain("secret");
    expect(await disk.recovery().recover()).toEqual({ enqueued: 0, failed: 0 });
    disk.now = 30_000;
    await disk.recovery().recover();
    expect((await disk.read()).intents["a-bad"]).toMatchObject({
      attempts: 2,
      nextAttemptAt: 90_000,
    });
  });
});

test.each([
  { agentId: null },
  { workingDir: null },
  { submittedBy: null },
  { collectedOutputs: null },
  { restrictedNoEgress: true },
  { sandboxExecution: { language: "python" } },
])("incomplete or excluded durable facts never create publication: %j", async (change) => {
  await fixture([{ ...completed(), ...change }], async (disk) => {
    expect(await disk.recovery().recover()).toEqual({ enqueued: 0, failed: 1 });
    const state = await disk.read();
    expect(state.publications).toEqual({});
    expect(state.intents.completed).toBeDefined();
  });
});

test("only real completed jobs are eligible and each scan is capped at 25 records", async () => {
  const pending = { ...completed("pending"), status: "running" };
  await fixture(
    [pending, ...Array.from({ length: 30 }, (_, index) => completed(`done-${index}`))],
    async (disk) => {
      expect(await disk.recovery().recover()).toEqual({ enqueued: 25, failed: 0 });
      expect((await disk.read()).intents.pending).toBeDefined();
      expect(await disk.recovery().recover()).toEqual({ enqueued: 5, failed: 0 });
      expect(Object.keys((await disk.read()).intents)).toEqual(["pending"]);
    },
  );
});

test("ordinary synchronous Workflow keeps a null run binding instead of inventing a workflow run", async () => {
  await fixture([{ ...completed(), workflowRunId: null }], async (disk) => {
    await disk.recovery().recover();
    const row = (await disk.read()).publications.completed;
    expect(row?.input.workflowRunId).toBeUndefined();
    expect(row?.input.files[0]?.target).toStartWith("workflow-runs/sync/jobs/completed/");
  });
});
