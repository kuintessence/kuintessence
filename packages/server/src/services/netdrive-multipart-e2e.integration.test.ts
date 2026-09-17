// End-to-end real-MinIO smoke for the full multipart-upload contract. This
// stitches together the three pieces that cross the connectRPC wire in prod —
// `NetDriveService.initiateMultipart`, the agent helper
// `multipartUploadFromFile` (driven by `NetDriveService.mintPartUrls`), and
// `NetDriveService.completeMultipart` — and proves the assembled MinIO object
// is byte-for-byte the spooled file. It is the only test exercising that whole
// chain against a live MinIO + Postgres, minus the wire.
//
// Gated on `NETDRIVE_ENDPOINT` (mirrors minio-client.integration.test.ts):
// skipped by default so `bun test` stays green without infra. Run with:
//   NETDRIVE_ENDPOINT=localhost NETDRIVE_ACCESS_KEY=minioadmin \
//   NETDRIVE_SECRET_KEY=minioadmin NETDRIVE_BUCKET=kq-netdrive \
//   DATABASE_URL=postgres://kq:kq@localhost:5432/kuintessence \
//   JWT_SECRET=test-secret-test-secret-test-secret-32 \
//   bun test packages/server/src/services/netdrive-multipart-e2e.integration.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multipartUploadFromFile } from "@kuintessence/agent/staging";
import { createPgDb, netdriveFiles, orgs, type PgDb, users } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { createRealMinioBackend, type MinioBackendConfig } from "../storage/minio-client";
import { NetDriveService } from "./netdrive";

const ENDPOINT = process.env.NETDRIVE_ENDPOINT;
const suite = ENDPOINT ? test : test.skip;

// 5 MiB is the S3/MinIO part-size floor; an ~11 MiB file over a 5 MiB part
// size yields exactly 3 parts (5 + 5 + ~1 MiB).
const PART_SIZE = 5 * 1024 * 1024;
const FILE_SIZE = 11 * 1024 * 1024;
const OBJECT_PATH = "e2e/big.bin";

function testConfig(): MinioBackendConfig {
  return {
    endpoint: ENDPOINT ?? "localhost",
    port: Number.parseInt(process.env.NETDRIVE_PORT ?? "9000", 10),
    useSSL: (process.env.NETDRIVE_USE_SSL ?? "false").toLowerCase() === "true",
    accessKey: process.env.NETDRIVE_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.NETDRIVE_SECRET_KEY ?? "minioadmin",
    bucket: process.env.NETDRIVE_BUCKET ?? "kq-netdrive",
    dataMarketStagingBucket: process.env.DATA_MARKET_STAGING_BUCKET ?? "kq-data-market-staging",
    dataMarketImmutableBucket:
      process.env.DATA_MARKET_IMMUTABLE_BUCKET ?? "kq-data-market-immutable",
    immutableRetentionDays: 365,
  };
}

function deterministicBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = i % 251;
  }
  return buf;
}

let db: PgDb;
let ownerId: string;
let orgId: string;
let tmpDir: string;

beforeAll(async () => {
  if (!ENDPOINT) return;
  db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");

  const [org] = await db.insert(orgs).values({ name: "netdrive-e2e-org" }).returning();
  if (!org) throw new Error("failed to seed org");
  orgId = org.id;

  const [user] = await db
    .insert(users)
    .values({ email: `netdrive-e2e-${crypto.randomUUID()}@example.test`, orgId })
    .returning();
  if (!user) throw new Error("failed to seed user");
  ownerId = user.id;

  tmpDir = await mkdtemp(join(tmpdir(), "netdrive-e2e-"));
});

afterAll(async () => {
  if (!ENDPOINT) return;
  await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

suite("end-to-end multipart upload assembles a >5 MiB object", async () => {
  const backend = await createRealMinioBackend(testConfig());
  const service = new NetDriveService(db, backend, {
    commitSecret: "netdrive-e2e-commit-secret-netdrive-e2e",
    multipartPartSize: PART_SIZE,
  });

  const bytes = deterministicBytes(FILE_SIZE);
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const tmpFile = join(tmpDir, "big.bin");
  await writeFile(tmpFile, bytes);

  const init = await service.initiateMultipart(ownerId, {
    path: OBJECT_PATH,
    size: 0,
    contentType: "application/octet-stream",
  });

  const result = await multipartUploadFromFile({
    filePath: tmpFile,
    size: FILE_SIZE,
    partSize: init.partSize,
    getPartUrls: (partNumbers) =>
      service
        .mintPartUrls(ownerId, {
          storageKey: init.storageKey,
          uploadId: init.uploadId,
          commitToken: init.commitToken,
          partNumbers,
        })
        .then((r) => r.urls),
  });

  expect(result.parts.length).toBe(3);

  const file = await service.completeMultipart(ownerId, {
    path: OBJECT_PATH,
    size: result.size,
    sha256: result.sha256,
    contentType: "application/octet-stream",
    storageKey: init.storageKey,
    uploadId: init.uploadId,
    commitToken: init.commitToken,
    parts: result.parts,
  });

  expect(file.size).toBe(FILE_SIZE);
  expect(file.sha256).toBe(expectedSha256);

  const blob = await backend.getBlob(init.storageKey);
  expect(blob.length).toBe(FILE_SIZE);
  expect(createHash("sha256").update(blob).digest("hex")).toBe(expectedSha256);

  await backend.delete(init.storageKey);
});
