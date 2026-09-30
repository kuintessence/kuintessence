import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assertRustfsUrl,
  fileDigest,
  fileWorkflowNetdrive,
} from "./file-workflow-netdrive";
import { managedSession } from "./session";

const signedUrl = "http://rustfs:9000/pr-files/object?X-Amz-Signature=fixture";
const envelope = (data: unknown) => ({ success: true, data });
const bytes = Buffer.from("synthetic-input\n");
function metadata() {
  return {
    id: randomUUID(), ownerId: randomUUID(), path: "pr-file-workflow/input.sam",
    size: bytes.length, sha256: fileDigest(bytes), contentType: "application/octet-stream",
    etag: null, storageKey: "fixture-key", mtime: "2026-09-24T00:00:00Z",
    createdAt: "2026-09-24T00:00:00Z",
  };
}

describe("file workflow NetDrive acceptance", () => {
  test("only accepts presigned internal RustFS URLs without credential rewriting", () => {
    expect(assertRustfsUrl(signedUrl)).toBe(signedUrl);
    for (const value of [
      "http://rustfs:9000/object",
      "http://localhost:9000/object?X-Amz-Signature=x",
      "http://rustfs:9001/object?X-Amz-Signature=x",
      "http://user:password@rustfs:9000/object?X-Amz-Signature=x",
      `${signedUrl}#fragment`,
      "https://external.example/object?X-Amz-Signature=x",
    ]) {
      expect(() => assertRustfsUrl(value)).toThrow();
    }
  });

  test("uploads exact bytes then commits the bound digest without persisting credentials", async () => {
    const file = metadata();
    const calls: string[] = [];
    const api = fileWorkflowNetdrive("fixture-token", {
      request: async (path, body) => {
        calls.push(path);
        if (path === "/netdrive/upload-url") {
          expect(body).toMatchObject({ size: bytes.length, sha256: fileDigest(bytes) });
          return envelope({
            uploadUrl: signedUrl, storageKey: "fixture-key", commitToken: "fixture-commit",
            expiresAt: "2026-09-24T01:00:00Z",
          });
        }
        expect(path).toBe("/netdrive/files");
        expect(body).toMatchObject({
          storageKey: "fixture-key", commitToken: "fixture-commit", sha256: fileDigest(bytes),
        });
        const input = body as { path: string };
        return envelope({ ...file, path: input.path });
      },
      fetch: async (url, init) => {
        calls.push("PUT");
        expect(url).toBe(signedUrl);
        expect(init?.method).toBe("PUT");
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toEqual({ "Content-Type": "application/octet-stream" });
        expect(init?.body).toEqual(bytes);
        return new Response(null, { status: 200 });
      },
    });
    expect(await api.upload(bytes.toString())).toEqual({
      fileMetadataId: file.id, fileMetadataName: "input.sam",
      hash: file.sha256, size: file.size,
    });
    expect(calls).toEqual(["/netdrive/upload-url", "PUT", "/netdrive/files"]);
  });

  test("download verifies stored digest, size and previous receipt", async () => {
    const file = metadata();
    const api = fileWorkflowNetdrive("fixture-token", {
      request: async (path) => envelope(path.endsWith("/download-url")
        ? { downloadUrl: signedUrl, expiresAt: "2026-09-24T01:00:00Z" }
        : file),
      fetch: async (url, init) => {
        expect(url).toBe(signedUrl);
        expect(init?.headers).toBeUndefined();
        expect(init?.redirect).toBe("error");
        return new Response(bytes);
      },
    });
    const downloaded = await api.download(file.id);
    expect(downloaded.bytes).toEqual(bytes);
    expect(await api.download(file.id, downloaded.snapshot)).toEqual(downloaded);
    await expect(api.download(file.id, { ...downloaded.snapshot, sha256: "0".repeat(64) }))
      .rejects.toThrow();
  });

  test.each(["digest", "size", "oversize", "identity"])("rejects %s mismatch", async (kind) => {
    const file = metadata();
    const altered = {
      ...file,
      ...(kind === "digest" ? { sha256: "0".repeat(64) } : {}),
      ...(kind === "size" ? { size: bytes.length + 1 } : {}),
      ...(kind === "identity" ? { id: randomUUID() } : {}),
    };
    const api = fileWorkflowNetdrive("fixture-token", {
      request: async (path) => envelope(path.endsWith("/download-url")
        ? { downloadUrl: signedUrl, expiresAt: "2026-09-24T01:00:00Z" }
        : altered),
      fetch: async () => new Response(kind === "oversize" ? Buffer.alloc(1024 * 1024 + 1) : bytes),
    });
    await expect(api.download(file.id)).rejects.toThrow();
  });

  test("deletion verifies the Server tombstone instead of accepting DELETE alone", async () => {
    const file = metadata();
    const methods: string[] = [];
    const api = fileWorkflowNetdrive("fixture-token", {
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
        return init?.method === "DELETE"
          ? Response.json(envelope(file))
          : new Response(null, { status: 404 });
      },
    });
    await api.remove(file.id);
    expect(methods).toEqual(["DELETE", "GET"]);
  });

  test("deletion readback obtains a renewed credential when the previous one expires", async () => {
    const mode = process.env.KQ_PR_TEST;
    process.env.KQ_PR_TEST = "1";
    let time = 0;
    let logins = 0;
    const file = metadata();
    const token = managedSession({
      now: () => time,
      login: async () => ({ token: `fixture-${++logins}`, expiresIn: 900 }),
    });
    const api = fileWorkflowNetdrive(token, {
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") {
          expect(init.headers).toMatchObject({ Authorization: "Bearer fixture-1" });
          time = 870_000;
          return Response.json(envelope(file));
        }
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-2" });
        return new Response(null, { status: 404 });
      },
    });
    try {
      await api.remove(file.id);
      expect(logins).toBe(2);
    } finally {
      if (mode === undefined) delete process.env.KQ_PR_TEST;
      else process.env.KQ_PR_TEST = mode;
    }
  });
});
