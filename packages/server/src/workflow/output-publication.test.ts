import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { usecase } from "@kuintessence/shared";
import {
  type PublicationInput,
  type PublicationRecord,
  type PublicationStore,
  publicationRunAllowsDelivery,
  WorkflowOutputPublisher,
} from "./output-publication";

// Disk-backed fake survives recreation of both store and publisher without PostgreSQL.
class DiskStore implements PublicationStore {
  constructor(private path: string) {}
  async get(_id: string): Promise<PublicationRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(record: PublicationRecord) {
    await writeFile(this.path, JSON.stringify(record));
  }
  async enqueue(input: PublicationInput) {
    const old = await this.get(input.jobId);
    if (old) return old;
    const record = { input, files: {}, released: false };
    await this.write(record);
    return record;
  }
  async pending() {
    const row = await this.get("job");
    return row && !row.released ? [row.input.jobId] : [];
  }
  async renew() {
    return true;
  }
  async claim() {
    return true;
  }
  async save(id: string, _token: string, files: PublicationRecord["files"]) {
    const record = await this.get(id);
    if (!record) throw new Error("missing");
    await this.write({ ...record, files });
  }
  async finish(id: string) {
    const record = await this.get(id);
    if (!record) throw new Error("missing");
    await this.write({ ...record, released: true });
  }
  async retry() {}
}
const input: PublicationInput = {
  jobId: "job",
  ownerId: "owner",
  agentId: "agent",
  workflowRunId: "run",
  outputs: [{ descriptor: "results", path: "*", isBatch: true, paths: ["one", "two"] }],
  files: ["one", "two"].map((name) => ({
    descriptor: "results",
    batch: true,
    source: `/work/${name}`,
    target: `/results/${name}`,
    fileName: name,
    transferId: `transfer-${name}`,
  })),
};
const value = (name: string): usecase.FileValue => ({
  fileMetadataId: `file-${name}`,
  fileMetadataName: name,
});

test("upload failure retains outputs; restarted publisher reuses stable IDs and published files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-publication-"));
  const path = join(dir, "publication.json");
  try {
    const published: string[] = [];
    let releases = 0;
    const first = new WorkflowOutputPublisher({
      store: new DiskStore(path),
      authorize: async () => {},
      publish: async (_, file) => {
        published.push(file.transferId);
        if (file.fileName === "two") throw new Error("offline");
        return value(file.fileName);
      },
      release: async () => {
        releases++;
      },
    });
    await expect(first.collect(input)).rejects.toThrow("offline");
    expect(releases).toBe(0);
    expect((await new DiskStore(path).get("job"))?.files).toEqual({ "transfer-one": value("one") });
    const restarted = new WorkflowOutputPublisher({
      store: new DiskStore(path),
      authorize: async () => {},
      publish: async (binding, file) => {
        expect(binding).toEqual(input);
        published.push(file.transferId);
        return value(file.fileName);
      },
      release: async () => {
        releases++;
      },
    });
    await restarted.recover();
    expect(published).toEqual(["transfer-one", "transfer-two", "transfer-two"]);
    expect(releases).toBe(1);
    expect(await restarted.process("job")).toEqual({ results: [value("one"), value("two")] });
    await restarted.recover();
    expect(releases).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revoked authorization and cancellation block background publication and cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-revoked-"));
  try {
    const store = new DiskStore(join(dir, "row.json"));
    await store.enqueue(input);
    let attempted = false;
    const publisher = new WorkflowOutputPublisher({
      store,
      authorize: async () => {
        throw new Error("cancelled or revoked");
      },
      publish: async () => {
        attempted = true;
        return value("bad");
      },
      release: async () => {
        attempted = true;
      },
    });
    await publisher.recover();
    expect(attempted).toBe(false);
    expect((await store.get("job"))?.released).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed release retries only cleanup after durable publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-release-"));
  try {
    const store = new DiskStore(join(dir, "row.json"));
    let published = 0;
    let released = 0;
    const publisher = new WorkflowOutputPublisher({
      store,
      authorize: async () => {},
      publish: async (_, file) => {
        published++;
        return value(file.fileName);
      },
      release: async () => {
        if (++released === 1) throw new Error("release unavailable");
      },
    });
    await expect(publisher.collect(input)).rejects.toThrow("release unavailable");
    await publisher.recover();
    expect(published).toBe(2);
    expect(released).toBe(2);
    expect((await store.get("job"))?.released).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("long transfers renew the claim and lost leases never release the work root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-lease-"));
  try {
    for (const lose of [false, true]) {
      const store = new DiskStore(join(dir, lose ? "lost.json" : "long.json"));
      let renewals = 0;
      let released = false;
      store.renew = async () => ++renewals < 3 || !lose;
      const publisher = new WorkflowOutputPublisher({
        store,
        heartbeatMs: 3,
        transferTimeoutMs: 1000,
        authorize: async () => {},
        publish: async (_, file, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 30);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("lost"));
              },
              { once: true },
            );
          });
          return value(file.fileName);
        },
        release: async () => {
          released = true;
        },
      });
      if (lose) await expect(publisher.collect(input)).rejects.toThrow();
      else await publisher.collect(input);
      expect(renewals).toBeGreaterThan(2);
      expect(released).toBe(!lose);
      if (lose) expect((await store.get("job"))?.files).toEqual({});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unresponsive upload waits are bounded and persisted results still require authorization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-timeout-"));
  try {
    const store = new DiskStore(join(dir, "row.json"));
    const publisher = new WorkflowOutputPublisher({
      store,
      transferTimeoutMs: 10,
      authorize: async () => {},
      publish: async () => new Promise(() => {}),
      release: async () => {
        throw new Error("must retain outputs");
      },
    });
    await expect(publisher.collect(input)).rejects.toThrow("timed out");
    await store.write({
      input,
      files: { "transfer-one": value("one"), "transfer-two": value("two") },
      released: true,
    });
    const revoked = new WorkflowOutputPublisher({
      store,
      authorize: async () => {
        throw new Error("revoked");
      },
      publish: async () => value("bad"),
      release: async () => {},
    });
    await expect(revoked.process("job")).rejects.toThrow("revoked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed outputs can recover after DAG interruption while explicit cancellation stays blocked", () => {
  const interrupted = { status: "failed", submittedBy: "owner", errorCode: "WORKFLOW_INTERRUPTED" };
  expect(publicationRunAllowsDelivery(interrupted, "owner")).toBe(true);
  expect(publicationRunAllowsDelivery({ ...interrupted, status: "cancelling" }, "owner")).toBe(
    false,
  );
  expect(publicationRunAllowsDelivery({ ...interrupted, status: "cancelled" }, "owner")).toBe(
    false,
  );
  expect(publicationRunAllowsDelivery(interrupted, "other")).toBe(false);
});

test("inspection exposes counts and file IDs without paths, tickets or side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-summary-"));
  try {
    const store = new DiskStore(join(dir, "row.json"));
    await store.write({ input, files: { "transfer-one": value("one") }, released: false });
    const publisher = new WorkflowOutputPublisher({
      store,
      authorize: async () => {},
      publish: async () => {
        throw new Error("read only");
      },
      release: async () => {
        throw new Error("read only");
      },
    });
    expect(await publisher.inspect("job")).toEqual({
      jobId: "job",
      state: "pending",
      totalFiles: 2,
      publishedFiles: 1,
      files: { results: [value("one")] },
      transferIds: ["transfer-one", "transfer-two"],
    });
    await store.write({
      input,
      files: { "transfer-one": value("one"), "transfer-two": value("two") },
      released: false,
    });
    expect((await publisher.inspect("job"))?.state).toBe("published");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("overlapping recovery scans keep at most four upload tasks active", async () => {
  let started = 0;
  const store: PublicationStore = {
    enqueue: async (input) => ({ input, files: {}, released: false }),
    get: async (id) => ({ input: { ...input, jobId: id }, files: {}, released: false }),
    pending: async () => Array.from({ length: 10 }, (_, index) => `job-${index}`),
    claim: async () => true,
    renew: async () => true,
    save: async () => {},
    finish: async () => {},
    retry: async () => {},
  };
  const publisher = new WorkflowOutputPublisher({
    store,
    transferTimeoutMs: 20,
    authorize: async () => {},
    publish: async () => {
      started++;
      return new Promise(() => {});
    },
    release: async () => {
      throw new Error("never published");
    },
  });
  await Promise.all([publisher.recover(), publisher.recover()]);
  expect(started).toBe(4);
});

test("claim rereads the latest persisted file map before uploading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-reread-"));
  try {
    const store = new DiskStore(join(dir, "row.json"));
    await store.enqueue(input);
    store.claim = async () => {
      await store.write({ input, files: { "transfer-one": value("one") }, released: false });
      return true;
    };
    const uploads: string[] = [];
    const publisher = new WorkflowOutputPublisher({
      store,
      authorize: async () => {},
      publish: async (_, file) => {
        uploads.push(file.transferId);
        return value(file.fileName);
      },
      release: async () => {},
    });
    await publisher.process("job");
    expect(uploads).toEqual(["transfer-two"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
