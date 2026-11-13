import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { netdriveFiles, type PgDb } from "@kuintessence/db";
import type { MinioBackend } from "../storage/minio-client";
import { NetDriveService } from "./netdrive";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  type Row = {
    id: string;
    ownerId: string;
    path: string;
    size: number;
    sha256: string;
    storageKey: string;
    contentType: string;
    etag: string;
    deletedAt: null;
    createdAt: Date;
    mtime: Date;
  };
  let rows: Row[] = [];
  let object: string | undefined;
  let loseResponse = false;
  let creates = 0;
  let completions = 0;
  let grants = 0;
  const db = {
    execute: async () => {},
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const selectedRows = table === netdriveFiles ? rows : [];
          const result = Promise.resolve(selectedRows);
          return Object.assign(result, {
            limit: async () => selectedRows,
            groupBy: async () => [],
            orderBy: () => ({ limit: async () => [] }),
          });
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({
      values: (value: Omit<Row, "id" | "createdAt" | "deletedAt">) => ({
        returning: async () => {
          creates++;
          const row = { ...value, id: "file", deletedAt: null, createdAt: new Date() };
          rows.push(row);
          return [row];
        },
      }),
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      const snapshot = [...rows];
      try {
        return await callback({ ...db });
      } catch (err) {
        rows = snapshot;
        throw err;
      }
    },
  } as unknown as PgDb;
  const backend = {
    createMultipartUpload: async () => ({ uploadId: "upload" }),
    head: async () =>
      object === undefined ? null : { size: Buffer.byteLength(object), etag: "etag" },
    sha256: async () => (object === undefined ? null : digest(object)),
    completeMultipartUpload: async () => {
      completions++;
      object = "real";
      if (loseResponse) throw new Error("response lost");
      return { etag: "etag" };
    },
  } as unknown as MinioBackend;
  const service = new NetDriveService(db, backend, { commitSecret: "completion-unit-secret" });
  return {
    service,
    setObject: (value: string) => {
      object = value;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    counts: () => ({ creates, completions, grants }),
    grant: async () => {
      grants++;
    },
  };
}

async function request(f: ReturnType<typeof fixture>) {
  const init = await f.service.initiateMultipart("owner", { path: "output", size: 4 });
  return {
    ...init,
    path: "output",
    size: 4,
    sha256: digest("real"),
    parts: [{ partNumber: 1, etag: "part" }],
  };
}

test("lost complete response is reconciled using actual object digest; retry has no extra row or grants", async () => {
  const f = fixture();
  const req = await request(f);
  f.loseResponse();
  const first = await f.service.completeMultipartWithReplacements("owner", req, undefined, f.grant);
  const retry = await f.service.completeMultipartWithReplacements("owner", req, undefined, f.grant);
  expect(retry.file.id).toBe(first.file.id);
  expect(f.counts()).toEqual({ creates: 1, completions: 1, grants: 1 });
  await expect(
    f.service.completeMultipart("owner", { ...req, sha256: digest("fake") }),
  ).rejects.toThrow("binding changed");
  await expect(f.service.completeMultipart("owner", { ...req, path: "other" })).rejects.toThrow(
    "path or size",
  );
  await expect(f.service.completeMultipart("intruder", req)).rejects.toThrow("owner mismatch");
  await expect(f.service.completeMultipart("owner", { ...req, uploadId: "other" })).rejects.toThrow(
    "uploadId mismatch",
  );
});

test("crash after object assembly and rolled-back DB transaction can finalize once", async () => {
  const f = fixture();
  const req = await request(f);
  await expect(
    f.service.completeMultipartWithReplacements("owner", req, undefined, async () => {
      throw new Error("crash before commit");
    }),
  ).rejects.toThrow("crash before commit");
  await f.service.completeMultipartWithReplacements("owner", req, undefined, f.grant);
  expect(f.counts()).toEqual({ creates: 2, completions: 1, grants: 1 });
});

test("same-size wrong object and missing digest never become a success", async () => {
  const f = fixture();
  const req = await request(f);
  f.setObject("fake");
  await expect(f.service.completeMultipart("owner", req)).rejects.toThrow("sha256 mismatch");
  await expect(f.service.completeMultipart("owner", { ...req, sha256: "" })).rejects.toThrow(
    "Invalid multipart sha256",
  );
  expect(f.counts()).toEqual({ creates: 0, completions: 0, grants: 0 });
});
