import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  NetDriveDownloadUrlResponseSchema,
  NetDriveFileSchema,
  NetDriveListResponseSchema,
  NetDriveUploadUrlResponseSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { type CaseToken, jsonRequest } from "../spack-case/api";

const origin = "https://server:3443";
const maximumBytes = 1024 * 1024;
const EnvelopeSchema = z.object({ success: z.literal(true), data: z.unknown() });
export const FileSnapshotSchema = z.strictObject({
  id: z.string().uuid(),
  path: z.string().min(1),
  size: z.number().int().positive().max(maximumBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FileSnapshot = z.infer<typeof FileSnapshotSchema>;
type Request = (path: string, body?: unknown) => Promise<unknown>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function assertRustfsUrl(value: string): string {
  const url = new URL(value);
  assert.equal(url.origin, "http://rustfs:9000");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.hash, "");
  assert(url.searchParams.has("X-Amz-Signature"));
  return value;
}

export function fileDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBounded(response: Response): Promise<Buffer> {
  assert(response.ok && response.body, "Object download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      assert(length <= maximumBytes, "Acceptance object exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function fileWorkflowNetdrive(
  token: CaseToken,
  options: { request?: Request; fetch?: Fetch } = {},
) {
  const request = options.request ?? ((path, body) => jsonRequest(origin, token, path, body));
  const send = options.fetch ?? fetch;
  const authorization = async () => ({
    Authorization: `Bearer ${typeof token === "string" ? token : await token()}`,
  });
  async function data(path: string, body?: unknown) {
    return EnvelopeSchema.parse(await request(path, body)).data;
  }
  return {
    async upload(text: string) {
      const bytes = Buffer.from(text, "utf8");
      assert(bytes.length > 0 && bytes.length <= maximumBytes);
      const body = {
        path: `pr-file-workflow/${randomUUID()}/input.sam`,
        size: bytes.length,
        contentType: "application/octet-stream",
        sha256: fileDigest(bytes),
      };
      const minted = NetDriveUploadUrlResponseSchema.parse(
        await data("/netdrive/upload-url", body),
      );
      const uploaded = await send(assertRustfsUrl(minted.uploadUrl), {
        method: "PUT",
        headers: { "Content-Type": body.contentType },
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      assert(uploaded.ok, "Acceptance upload failed");
      await uploaded.body?.cancel();
      const file = NetDriveFileSchema.parse(await data("/netdrive/files", {
        ...body,
        storageKey: minted.storageKey,
        commitToken: minted.commitToken,
      }));
      assert.deepEqual(FileSnapshotSchema.parse({
        id: file.id, path: file.path, size: file.size, sha256: file.sha256,
      }), {
        id: file.id, path: body.path, size: body.size, sha256: body.sha256,
      });
      return {
        fileMetadataId: file.id, fileMetadataName: "input.sam",
        hash: file.sha256, size: file.size,
      };
    },
    async download(id: string, previous?: FileSnapshot) {
      z.string().uuid().parse(id);
      const file = NetDriveFileSchema.parse(await data(`/netdrive/files/${id}`));
      const snapshot = FileSnapshotSchema.parse({
        id: file.id, path: file.path, size: file.size, sha256: file.sha256,
      });
      assert.equal(snapshot.id, id);
      if (previous) assert.deepEqual(snapshot, previous);
      const minted = NetDriveDownloadUrlResponseSchema.parse(
        await data(`/netdrive/files/${id}/download-url`),
      );
      const bytes = await readBounded(await send(assertRustfsUrl(minted.downloadUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }));
      assert.equal(bytes.length, snapshot.size);
      assert.equal(fileDigest(bytes), snapshot.sha256);
      return { snapshot, bytes };
    },
    async list(runId: string) {
      z.string().uuid().parse(runId);
      const result = NetDriveListResponseSchema.parse(
        await data(`/netdrive/files?prefix=workflow-runs/${runId}/&limit=100`),
      );
      assert.equal(result.files.length, result.total);
      return result.files;
    },
    async remove(id: string) {
      z.string().uuid().parse(id);
      const response = await send(`${origin}/api/netdrive/files/${id}`, {
        method: "DELETE",
        headers: { ...await authorization(), "Idempotency-Key": randomUUID() },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      assert(response.ok, `/netdrive/files/${id}: HTTP ${response.status}`);
      const deleted = NetDriveFileSchema.parse(EnvelopeSchema.parse(await response.json()).data);
      assert.equal(deleted.id, id);
      const missing = await send(`${origin}/api/netdrive/files/${id}`, {
        headers: await authorization(),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      await missing.body?.cancel();
      assert.equal(missing.status, 404, `/netdrive/files/${id}: HTTP ${missing.status}`);
    },
  };
}
