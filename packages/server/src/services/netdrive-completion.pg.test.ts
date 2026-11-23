import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPgDb, netdriveFiles, netdriveUploadReservations, users } from "@kuintessence/db";
import { count, eq } from "drizzle-orm";
import type { MinioBackend } from "../storage/minio-client";
import { NetDriveService } from "./netdrive";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("NetDrive completion tests require an isolated unit database");
const db = createPgDb(url);
const owner = crypto.randomUUID();
beforeAll(async () => {
  await db.insert(users).values({ id: owner, email: `${owner}@example.invalid`, role: "user" });
});
async function clearFiles() {
  await db.delete(netdriveUploadReservations).where(eq(netdriveUploadReservations.ownerId, owner));
  await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, owner));
}
beforeEach(clearFiles);
afterAll(async () => {
  await clearFiles();
  await db.delete(users).where(eq(users.id, owner));
  await db.$client.end();
});
async function committedFiles() {
  const [row] = await db
    .select({ n: count() })
    .from(netdriveFiles)
    .where(eq(netdriveFiles.ownerId, owner));
  return row?.n;
}

function fixture() {
  let object: string | undefined;
  let loseResponse = false;
  let completions = 0;
  let grants = 0;
  const backend = {
    createMultipartUpload: async () => ({ uploadId: "upload" }),
    head: async () =>
      object === undefined
        ? null
        : { size: Buffer.byteLength(object), etag: "etag", versionId: "version-1" },
    sha256: async () => (object === undefined ? null : digest(object)),
    completeMultipartUpload: async () => {
      completions++;
      object = "real";
      if (loseResponse) throw new Error("response lost");
      return { etag: "etag", versionId: "version-1" };
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
    counts: () => ({ completions, grants }),
    grant: async () => {
      grants++;
    },
  };
}

async function request(f: ReturnType<typeof fixture>) {
  const init = await f.service.initiateMultipart(owner, { path: "output", size: 4 });
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
  const first = await f.service.completeMultipartWithReplacements(owner, req, undefined, f.grant);
  const retry = await f.service.completeMultipartWithReplacements(owner, req, undefined, f.grant);
  expect(retry.file.id).toBe(first.file.id);
  expect(await committedFiles()).toBe(1);
  expect(f.counts()).toEqual({ completions: 1, grants: 1 });
  await expect(
    f.service.completeMultipart(owner, { ...req, sha256: digest("fake") }),
  ).rejects.toThrow("binding changed");
  await expect(f.service.completeMultipart(owner, { ...req, path: "other" })).rejects.toThrow(
    "path or size",
  );
  await expect(f.service.completeMultipart("intruder", req)).rejects.toThrow("owner mismatch");
  await expect(f.service.completeMultipart(owner, { ...req, uploadId: "other" })).rejects.toThrow(
    "uploadId mismatch",
  );
});

test("crash after object assembly and rolled-back DB transaction can finalize once", async () => {
  const f = fixture();
  const req = await request(f);
  await expect(
    f.service.completeMultipartWithReplacements(owner, req, undefined, async () => {
      throw new Error("crash before commit");
    }),
  ).rejects.toThrow("crash before commit");
  expect(await committedFiles()).toBe(0);
  await f.service.completeMultipartWithReplacements(owner, req, undefined, f.grant);
  expect(await committedFiles()).toBe(1);
  expect(f.counts()).toEqual({ completions: 1, grants: 1 });
});

test("same-size wrong object and missing digest never become a success", async () => {
  const f = fixture();
  const req = await request(f);
  f.setObject("fake");
  await expect(f.service.completeMultipart(owner, req)).rejects.toThrow("sha256 mismatch");
  await expect(f.service.completeMultipart(owner, { ...req, sha256: "" })).rejects.toThrow(
    "Invalid multipart sha256",
  );
  expect(await committedFiles()).toBe(0);
  expect(f.counts()).toEqual({ completions: 0, grants: 0 });
});
