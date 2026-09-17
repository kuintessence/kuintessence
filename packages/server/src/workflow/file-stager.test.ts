import { describe, expect, test } from "bun:test";
import { createFileStager, type FileStagerDeps } from "./file-stager";

type Listener = (e: { copiedBytes: number; state: string; error?: string }) => void;

function harness(over: Partial<FileStagerDeps> = {}) {
  const pushes: Array<{ agentId: string; requestId: string; payload: Record<string, unknown> }> =
    [];
  const presigns: Array<{
    actorUserId: string;
    fileId: string;
    context?: { jobId?: string; workflowRunId?: string; netdriveFileIds?: string[] };
  }> = [];
  let listener: Listener | undefined;
  const deps: FileStagerDeps = {
    dispatcher: {
      pushFileTransfer: (agentId, requestId, payload) => {
        pushes.push({ agentId, requestId, payload });
        return true;
      },
    },
    transferRegistry: {
      register: (_id, l) => {
        listener = l as Listener;
      },
    },
    mintDownloadUrl: async (actorUserId, fileId, context) => {
      presigns.push({ actorUserId, fileId, context });
      return { downloadUrl: `https://minio/get/${fileId}` };
    },
    newTransferId: () => "t-1",
    ...over,
  };
  return {
    deps,
    pushes,
    presigns,
    fire: (e: Parameters<Listener>[0]) => listener?.(e),
    stager: createFileStager(deps),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createFileStager", () => {
  test("presigns + dispatches a cloud_to_cluster transfer and resolves on success", async () => {
    const h = harness();
    const p = h.stager(
      "agent-1",
      "owner-1",
      { fileMetadataId: "fm-1", stagePath: "mesh" },
      "/run/mesh",
      {
        jobId: "00000000-0000-4000-8000-000000000201",
        workflowRunId: "00000000-0000-4000-8000-000000000202",
      },
    );
    await tick();
    expect(h.presigns[0]).toEqual({
      actorUserId: "owner-1",
      fileId: "fm-1",
      context: {
        jobId: "00000000-0000-4000-8000-000000000201",
        workflowRunId: "00000000-0000-4000-8000-000000000202",
        netdriveFileIds: ["fm-1"],
      },
    });
    expect(h.pushes[0]?.payload).toEqual({
      direction: "cloud_to_cluster",
      sourceUrl: "https://minio/get/fm-1",
      targetPath: "/run/mesh",
      totalBytes: 0,
    });
    h.fire({ copiedBytes: 100, state: "succeeded" });
    await p; // resolves
  });

  test("rejects when the transfer reports failure", async () => {
    const h = harness();
    const p = h.stager("a", "o", { fileMetadataId: "fm", stagePath: "x" }, "/run/x");
    await tick();
    h.fire({ copiedBytes: 0, state: "failed", error: "disk full" });
    let threw = false;
    try {
      await p;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("rejects when the agent channel is closed", async () => {
    const h = harness({
      dispatcher: { pushFileTransfer: () => false },
    });
    let threw = false;
    try {
      await h.stager("a", "o", { fileMetadataId: "fm", stagePath: "x" }, "/run/x");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
