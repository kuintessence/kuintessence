import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { FileTransferRequestSchema, ServerMessageSchema } from "@kuintessence/proto";
import pino from "pino";
import { AgentStream, type AgentStreamDeps } from "./stream";

type Request = {
  requestId: string;
  direction: string;
  sourceUrl: string;
  sourcePath: string;
  targetUrl: string;
  targetPath: string;
  totalBytes: number;
  expectedSha256?: string;
  uploadId: string;
  partSize: number;
};
function setup() {
  const stream = new AgentStream({
    client: {} as AgentStreamDeps["client"],
    adapter: {
      type: "slurm",
      version: "fixture",
      submit: async () => {
        throw new Error("download must not submit");
      },
      cancel: async () => {},
      status: async () => ({ status: "queued" }),
    },
    agentId: "agent",
    siteName: "fixture",
    heartbeatIntervalMs: 60_000,
    logger: pino({ level: "silent" }),
    fileTransferMaxRetries: 1,
  });
  return {
    stream,
    harness: stream as unknown as {
      handleServerMessage(message: unknown): Promise<void>;
      runFileTransfer(request: Request, signal: AbortSignal): Promise<void>;
      emitProgress(
        id: string,
        copied: number,
        state: string,
        error?: string,
        sha256?: string,
      ): void;
    },
  };
}

test("wire download carries the trusted digest and size to host staging", async () => {
  const { stream, harness } = setup();
  const seen = Promise.withResolvers<Request>();
  harness.runFileTransfer = async (request) => {
    seen.resolve(request);
  };
  try {
    await harness.handleServerMessage(
      create(ServerMessageSchema, {
        payload: {
          case: "fileTransferRequest",
          value: create(FileTransferRequestSchema, {
            requestId: "download",
            direction: "cloud_to_cluster",
            sourceUrl: "https://objects.invalid/file",
            targetPath: "/shared/input",
            totalBytes: 6n,
            expectedSha256: "a".repeat(64),
          }),
        },
      }),
    );
    expect((await seen.promise).expectedSha256).toBe("a".repeat(64));
    expect((await seen.promise).totalBytes).toBe(6);
  } finally {
    await stream.stop();
  }
});

test("superseded download emits no false failure and a new transfer reuses verified partial bytes", async () => {
  const { stream, harness } = setup();
  const directory = await mkdtemp(join(tmpdir(), "kq-stream-download-"));
  const originalFetch = globalThis.fetch;
  const request: Request = {
    requestId: "download",
    direction: "cloud_to_cluster",
    sourceUrl: "https://object.invalid/key",
    targetPath: join(directory, "input"),
    sourcePath: "",
    targetUrl: "",
    totalBytes: 6,
    expectedSha256: createHash("sha256").update("abcdef").digest("hex"),
    uploadId: "",
    partSize: 0,
  };
  const first = new AbortController();
  const events: { state: string; digest?: string }[] = [];
  harness.emitProgress = (_id, bytes, state, _error, digest) => {
    events.push({ state, digest });
    if (bytes === 3 && state === "running") first.abort(new Error("superseded"));
  };
  globalThis.fetch = Object.assign(
    async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
      if (first.signal.aborted) {
        expect(new Headers(init?.headers).get("Range")).toBe("bytes=3-");
        return new Response("def", { status: 206, headers: { "Content-Range": "bytes 3-5/6" } });
      }
      return new Response("abc");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await harness.runFileTransfer(request, first.signal);
    expect(events.some((event) => event.state === "failed")).toBe(false);
    await harness.runFileTransfer(request, new AbortController().signal);
    expect(events.at(-1)).toEqual({ state: "succeeded", digest: request.expectedSha256 });
    expect(await readFile(request.targetPath, "utf8")).toBe("abcdef");
  } finally {
    globalThis.fetch = originalFetch;
    await stream.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
