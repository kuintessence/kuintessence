import { describe, expect, test } from "bun:test";
import type { ObjectStat } from "../storage/minio-client";
import { FakeMinioBackend } from "../storage/minio-client.test";
import {
  type DataMarketObjectUploadRepository,
  DataMarketObjectUploadService,
  type StoredDataUploadSession,
} from "./data-market-upload";

const now = new Date("2026-07-24T00:00:00.000Z");
const SHA256_GOOD = "770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c";

class MemoryUploadRepository implements DataMarketObjectUploadRepository {
  sessions = new Map<string, StoredDataUploadSession>();
  completed = 0;
  readonly commits: Array<{
    objectVersionId?: string;
    objectLock: { mode: "COMPLIANCE"; retainUntil: Date };
  }> = [];

  async createSession(
    input: Omit<
      StoredDataUploadSession,
      "id" | "status" | "committedVersionId" | "committedSha256"
    >,
  ) {
    const session: StoredDataUploadSession = {
      ...input,
      id: `session-${this.sessions.size + 1}`,
      status: "pending",
      committedVersionId: null,
      committedSha256: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  async expireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, status: "expired" });
  }

  async failSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, status: "failed" });
  }

  async completeSession(input: {
    sessionId: string;
    ownerUserId: string;
    sha256: string;
    stat: ObjectStat;
    committedStorageKey: string;
    objectVersionId?: string;
    objectLock: { mode: "COMPLIANCE"; retainUntil: Date };
    committedAt: Date;
  }) {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error("missing session");
    if (session.status === "completed") {
      if (session.committedSha256 !== input.sha256.toLowerCase()) throw new Error("conflict");
    } else {
      this.completed += 1;
      this.commits.push({
        objectVersionId: input.objectVersionId,
        objectLock: input.objectLock,
      });
      this.sessions.set(session.id, {
        ...session,
        status: "completed",
        committedVersionId: "version-1",
        committedSha256: input.sha256.toLowerCase(),
      });
    }
    return {
      id: "version-1",
      assetId: session.assetId,
      version: session.version,
      status: "ready" as const,
      manifestDigest: input.sha256.toLowerCase(),
      manifest: { source: session.locationKind },
      immutableAt: input.committedAt,
      createdBy: session.ownerUserId,
      createdAt: input.committedAt,
    };
  }
}

describe("DataMarketObjectUploadService", () => {
  test("persists a private namespace session before presigning direct upload", async () => {
    const repository = new MemoryUploadRepository();
    const presigns: string[] = [];
    const service = new DataMarketObjectUploadService(
      repository,
      {
        presignStagingUpload: async (key) => {
          presigns.push(key);
          return `https://object.test/${key}`;
        },
        headStaging: async () => null,
        sha256Staging: async () => null,
        copyStagingToImmutable: async () => ({
          etag: "",
          versionId: "version-1",
          lock: { mode: "COMPLIANCE", retainUntil: now },
        }),
        headImmutable: async () => null,
        sha256Immutable: async () => null,
        deleteStaging: async () => {},
      },
      { now: () => now },
    );

    const session = await service.createUploadSession({
      assetId: "asset-1",
      version: "v1",
      ownerUserId: "user-1",
      locationKind: "user-private-object",
      objectPath: "inputs/cohort.csv",
      sizeBytes: 4,
      mediaType: "text/csv",
    });

    expect(session).toMatchObject({ locationKind: "user-private-object" });
    expect(session.objectKey).toStartWith("data-market/staging/");
    expect(repository.sessions.get(session.id)).toMatchObject({ status: "pending" });
    expect(presigns).toEqual([session.objectKey]);
    expect(session).not.toHaveProperty("commitToken");
  });

  test("commits an immutable copy and leaves a stale upload URL unable to change committed bytes", async () => {
    const repository = new MemoryUploadRepository();
    const minio = new FakeMinioBackend();
    const service = new DataMarketObjectUploadService(repository, minio, { now: () => now });
    const session = await service.createUploadSession({
      assetId: "asset-1",
      version: "v1",
      ownerUserId: "user-1",
      locationKind: "platform-object",
      objectPath: "cohort.csv",
      sizeBytes: 4,
      mediaType: "text/csv",
    });
    await minio.putStagingBlob(session.objectKey, Buffer.from("good"), "text/csv");
    const sha256 = SHA256_GOOD;

    await expect(
      service.commitUploadSession({ sessionId: session.id, ownerUserId: "user-1", sha256 }),
    ).resolves.toMatchObject({ status: "ready", version: "v1" });
    await expect(
      service.commitUploadSession({ sessionId: session.id, ownerUserId: "user-1", sha256 }),
    ).resolves.toMatchObject({ id: "version-1" });
    expect(repository.completed).toBe(1);
    const committedKey = `data-market/immutable/sha256/${sha256}`;
    expect((await minio.getImmutableBlob(committedKey)).toString()).toBe("good");
    expect(repository.commits).toEqual([
      {
        objectVersionId: "version-2",
        objectLock: { mode: "COMPLIANCE", retainUntil: new Date("2027-07-24T00:00:00.000Z") },
      },
    ]);
    expect(minio.copyAttempts).toEqual([committedKey]);
    expect(await minio.headStaging(session.objectKey)).toBeNull();
    await minio.putStagingBlob(session.objectKey, Buffer.from("evil"), "text/csv");
    expect((await minio.getImmutableBlob(committedKey)).toString()).toBe("good");
  });

  test("concurrent same-digest commits persist their own fixed immutable versions", async () => {
    const repository = new MemoryUploadRepository();
    const minio = new FakeMinioBackend();
    const service = new DataMarketObjectUploadService(repository, minio, { now: () => now });
    const results = await Promise.all(
      ["asset-1", "asset-2"].map(async (assetId) => {
        const session = await service.createUploadSession({
          assetId,
          version: "v1",
          ownerUserId: "user-1",
          locationKind: "platform-object",
          objectPath: "cohort.csv",
          sizeBytes: 4,
          mediaType: "text/csv",
        });
        await minio.putStagingBlob(session.objectKey, Buffer.from("good"), "text/csv");
        return service.commitUploadSession({ sessionId: session.id, ownerUserId: "user-1" });
      }),
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.manifestDigest === SHA256_GOOD)).toBe(true);
    expect(minio.copyAttempts).toHaveLength(2);
    expect(
      minio.copyAttempts.every(
        (attempt) => attempt === `data-market/immutable/sha256/${SHA256_GOOD}`,
      ),
    ).toBe(true);
    expect(repository.commits).toHaveLength(2);
    expect(await minio.sha256Immutable(`data-market/immutable/sha256/${SHA256_GOOD}`)).toBe(
      SHA256_GOOD,
    );
  });

  test("retries staging cleanup after metadata commit without copying immutable bytes again", async () => {
    const repository = new MemoryUploadRepository();
    const minio = new FakeMinioBackend();
    const service = new DataMarketObjectUploadService(repository, minio, { now: () => now });
    const session = await service.createUploadSession({
      assetId: "asset-1",
      version: "v1",
      ownerUserId: "user-1",
      locationKind: "platform-object",
      objectPath: "cohort.csv",
      sizeBytes: 4,
      mediaType: "text/csv",
    });
    await minio.putStagingBlob(session.objectKey, Buffer.from("good"), "text/csv");
    const deleteStaging = minio.deleteStaging.bind(minio);
    let cleanupAttempts = 0;
    minio.deleteStaging = async (key) => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("staging delete unavailable");
      await deleteStaging(key);
    };

    await expect(
      service.commitUploadSession({
        sessionId: session.id,
        ownerUserId: "user-1",
        sha256: SHA256_GOOD,
      }),
    ).rejects.toThrow("staging delete unavailable");
    expect(repository.sessions.get(session.id)?.status).toBe("completed");
    expect(minio.copyAttempts).toHaveLength(1);

    await expect(
      service.commitUploadSession({
        sessionId: session.id,
        ownerUserId: "user-1",
        sha256: SHA256_GOOD,
      }),
    ).resolves.toMatchObject({ id: "version-1" });
    expect(cleanupAttempts).toBe(2);
    expect(minio.copyAttempts).toHaveLength(1);
    expect(await minio.headStaging(session.objectKey)).toBeNull();
  });

  test("marks mismatched objects failed and never permits a retry", async () => {
    const repository = new MemoryUploadRepository();
    const service = new DataMarketObjectUploadService(
      repository,
      {
        presignStagingUpload: async () => "https://object.test/upload",
        headStaging: async () => ({
          size: 5,
          contentType: "text/csv",
          etag: "etag",
          lastModified: now,
        }),
        sha256Staging: async () => "a".repeat(64),
        copyStagingToImmutable: async () => ({
          etag: "",
          versionId: "version-1",
          lock: { mode: "COMPLIANCE", retainUntil: now },
        }),
        headImmutable: async () => null,
        sha256Immutable: async () => null,
        deleteStaging: async () => {},
      },
      { now: () => now },
    );
    const session = await service.createUploadSession({
      assetId: "asset-1",
      version: "v1",
      ownerUserId: "user-1",
      locationKind: "platform-object",
      objectPath: "cohort.csv",
      sizeBytes: 4,
      mediaType: "text/csv",
    });

    await expect(
      service.commitUploadSession({
        sessionId: session.id,
        ownerUserId: "user-1",
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("metadata does not match");
    expect(repository.sessions.get(session.id)?.status).toBe("failed");
    await expect(
      service.commitUploadSession({
        sessionId: session.id,
        ownerUserId: "user-1",
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("not usable");
  });

  test("rejects a client digest that does not match the streamed object digest", async () => {
    const repository = new MemoryUploadRepository();
    const minio = new FakeMinioBackend();
    const service = new DataMarketObjectUploadService(repository, minio, { now: () => now });
    const session = await service.createUploadSession({
      assetId: "asset-1",
      version: "v1",
      ownerUserId: "user-1",
      locationKind: "platform-object",
      objectPath: "cohort.csv",
      sizeBytes: 4,
      mediaType: "text/csv",
    });
    await minio.putStagingBlob(session.objectKey, Buffer.from("real"), "text/csv");

    await expect(
      service.commitUploadSession({
        sessionId: session.id,
        ownerUserId: "user-1",
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("sha256 does not match");
    expect(repository.sessions.get(session.id)?.status).toBe("failed");
  });
});
