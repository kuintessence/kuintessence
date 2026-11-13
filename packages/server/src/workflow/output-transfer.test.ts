import { expect, spyOn, test } from "bun:test";
import type { TransferProgressEvent } from "../services/transfer-registry";
import {
  type OutputTransferInput,
  type OutputTransferRecord,
  type OutputTransferRunner,
  type OutputTransferStore,
  sandboxArtifactTransferId,
  waitForOutputTransfer,
} from "./output-transfer";

const input: OutputTransferInput = {
  transferId: sandboxArtifactTransferId("artifact", "replica"),
  ownerId: "owner",
  agentId: "agent",
  source: "/work/result",
  target: "workflow-runs/run/artifacts/artifact/result",
  workflowRunId: "run",
  totalBytes: 7,
};

function fixture() {
  let row: OutputTransferRecord | undefined;
  let callback: ((event: TransferProgressEvent) => void) | undefined;
  let starts = 0;
  let finishes = 0;
  let activations = 0;
  const started = Promise.withResolvers<void>();
  const store: OutputTransferStore = {
    ensure: async (value) => {
      row ??= {
        userId: value.ownerId,
        direction: "cluster_to_cloud",
        source: value.source,
        target: value.target,
        agentId: value.agentId,
        jobId: value.jobId ?? null,
        workflowRunId: value.workflowRunId ?? null,
        totalBytes: value.totalBytes ?? null,
        state: "queued",
        netdriveFileIds: [],
      };
      return row;
    },
    activate: async (_value, previousState) => {
      if (!row || row.state !== previousState) return false;
      row.state = "running";
      activations++;
      return true;
    },
    finish: async (_value, event) => {
      finishes++;
      if (!row || row.state === "cancelled" || row.state === "succeeded") return false;
      row.state = event.state;
      row.netdriveFileIds = event.netdriveFileIds ?? [];
      return true;
    },
  };
  const runner: OutputTransferRunner = {
    start: async (ownerId, transferId, data, onProgress) => {
      expect(row).toBeDefined();
      expect(row?.state).toBe("running");
      expect(ownerId).toBe(input.ownerId);
      expect(transferId).toBe(input.transferId);
      expect(data).toMatchObject({
        source: input.source,
        target: input.target,
        agentId: input.agentId,
        totalBytes: input.totalBytes,
      });
      starts++;
      callback = onProgress;
      started.resolve();
    },
  };
  return {
    deps: { store, runner },
    started: started.promise,
    get row() {
      return row;
    },
    get starts() {
      return starts;
    },
    get finishes() {
      return finishes;
    },
    get activations() {
      return activations;
    },
    fire(event: TransferProgressEvent) {
      callback?.(event);
    },
  };
}

test("Sandbox transfer identity is stable per artifact replica and separate from artifact IDs", () => {
  const artifact = "00000000-0000-4000-8000-000000000001";
  const id = sandboxArtifactTransferId(artifact, "replica");
  expect(id).toBe(sandboxArtifactTransferId(artifact, "replica"));
  expect(id).not.toBe(artifact);
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(id).not.toBe(sandboxArtifactTransferId(artifact, "other-replica"));
  expect(sandboxArtifactTransferId("a:b", "c")).not.toBe(sandboxArtifactTransferId("a", "b:c"));
});

test("transfer row exists before start and durable success is reused without redispatch", async () => {
  const h = fixture();
  const saved = Promise.withResolvers<boolean>();
  const finish = h.deps.store.finish;
  h.deps.store.finish = async (value, event) => {
    await saved.promise;
    return finish(value, event);
  };
  let settled = false;
  const wait = waitForOutputTransfer(h.deps, input).then((ids) => {
    settled = true;
    return ids;
  });
  await h.started;
  h.fire({ state: "running", copiedBytes: 3 });
  h.fire({ state: "succeeded", copiedBytes: 7, netdriveFileIds: ["committed"] });
  h.fire({ state: "failed", copiedBytes: 0 });
  expect(settled).toBe(false);
  saved.resolve(true);
  expect(await wait).toEqual(["committed"]);
  expect(h.finishes).toBe(1);
  expect(await waitForOutputTransfer(h.deps, input)).toEqual(["committed"]);
  expect(h.starts).toBe(1);
});

test.each([
  { userId: "other" },
  { direction: "cloud_to_cluster" },
  { source: "/changed" },
  { target: "changed" },
  { agentId: "other-agent" },
  { jobId: "other-job" },
  { workflowRunId: "other-run" },
  { totalBytes: 8 },
  { state: "cancelled" },
])("changed or cancelled durable binding cannot dispatch: %j", async (changed) => {
  const h = fixture();
  await h.deps.store.ensure(input);
  Object.assign(h.row ?? {}, changed);
  await expect(waitForOutputTransfer(h.deps, input)).rejects.toThrow(
    "cancelled or binding changed",
  );
  expect(h.starts).toBe(0);
});

test("aborted wait preserves the transfer session and ignores late callbacks before resume", async () => {
  const h = fixture();
  const controller = new AbortController();
  const wait = waitForOutputTransfer(h.deps, input, controller.signal);
  await h.started;
  controller.abort();
  await expect(wait).rejects.toThrow("interrupted");
  h.fire({ state: "succeeded", copiedBytes: 7, netdriveFileIds: ["late"] });
  expect(h.finishes).toBe(0);
  expect(h.row?.state).toBe("running");
  const resumed = waitForOutputTransfer(h.deps, input);
  await Promise.resolve();
  h.fire({ state: "succeeded", copiedBytes: 7, netdriveFileIds: ["resumed"] });
  expect(await resumed).toEqual(["resumed"]);
  expect(h.starts).toBe(2);
});

test("start failure removes the abort listener and retains the same row for retry", async () => {
  const h = fixture();
  h.deps.runner.start = async () => {
    throw new Error("Agent offline");
  };
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  try {
    await expect(waitForOutputTransfer(h.deps, input, controller.signal)).rejects.toThrow(
      "Agent offline",
    );
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(h.row?.state).toBe("running");
    expect(h.finishes).toBe(0);
  } finally {
    remove.mockRestore();
  }
});

test("terminal failure is durably recorded and the same transfer can resume", async () => {
  const h = fixture();
  const wait = waitForOutputTransfer(h.deps, input);
  await h.started;
  h.fire({ state: "failed", copiedBytes: 3, error: "connection lost" });
  await expect(wait).rejects.toThrow("connection lost");
  expect(h.row?.state).toBe("failed");
  const retry = waitForOutputTransfer(h.deps, input);
  await Promise.resolve();
  await Promise.resolve();
  h.fire({ state: "succeeded", copiedBytes: 7, netdriveFileIds: ["committed"] });
  expect(await retry).toEqual(["committed"]);
  expect(h.starts).toBe(2);
  expect(h.row?.state).toBe("succeeded");
  expect(h.activations).toBe(2);
});

test("already-running recovery can resume without requiring a queued or failed CAS", async () => {
  const h = fixture();
  await h.deps.store.ensure(input);
  if (h.row) h.row.state = "running";
  h.deps.store.activate = async () => {
    throw new Error("must not CAS a running recovery");
  };
  const wait = waitForOutputTransfer(h.deps, input);
  await h.started;
  h.fire({ state: "succeeded", copiedBytes: 7, netdriveFileIds: ["committed"] });
  expect(await wait).toEqual(["committed"]);
  expect(h.activations).toBe(0);
});

test.each([
  "cancelled",
  "succeeded",
])("activation cannot overwrite a concurrent %s terminal record", async (state) => {
  const h = fixture();
  h.deps.store.activate = async () => {
    if (h.row) h.row.state = state;
    return false;
  };
  await expect(waitForOutputTransfer(h.deps, input)).rejects.toThrow("changed before dispatch");
  expect(h.row?.state).toBe(state);
  expect(h.starts).toBe(0);
});

test("cancellation that wins durable terminal save cannot be reported as success", async () => {
  const h = fixture();
  const wait = waitForOutputTransfer(h.deps, input);
  await h.started;
  if (h.row) h.row.state = "cancelled";
  h.fire({ state: "succeeded", copiedBytes: 7, netdriveFileIds: ["committed"] });
  await expect(wait).rejects.toThrow("cancelled or already finalized");
  expect(h.row?.state).toBe("cancelled");
});
