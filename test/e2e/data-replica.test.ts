import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCerts,
  agents,
  clusterFileRoots,
  createPgDb,
  dataAccessPolicies,
  dataAssetFiles,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  dataReplicas,
  netdriveTransferLog,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  type DataReplicaCommand,
  REPLICA_RANGE_BYTES,
  type ReplicaRangeRead,
  type ReplicaRangeResult,
  type ServerMessage,
} from "@kuintessence/proto";
import { eq } from "drizzle-orm";
import { AgentReplicaStore } from "../../packages/agent/src/data-market/data-replica";
import { AgentDataRoots } from "../../packages/agent/src/data-market/local-data-security";
import { deriveDataSites } from "../../packages/server/src/scheduler/data-locality";
import { PgDataMarketRepository } from "../../packages/server/src/services/data-market-repository-drizzle";
import { PgDataPrerequisiteRepository } from "../../packages/server/src/services/data-prerequisite-repository-drizzle";
import { DataReplicaCoordinator } from "../../packages/server/src/services/data-replica";
import { NetDriveService } from "../../packages/server/src/services/netdrive";
import { FakeMinioBackend } from "../../packages/server/src/storage/minio-client.test";

const databaseUrl = process.env.KQ_REPLICA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("managed object replicas", () => {
  const db = createPgDb(databaseUrl ?? "postgres://localhost/unused", { max: 4 });
  const user = randomUUID(),
    org = randomUUID(),
    root = randomUUID(),
    agent = randomUUID();
  const asset = randomUUID(),
    version = randomUUID(),
    location = randomUUID(),
    file = randomUUID();
  const sourceAgent = randomUUID(),
    sourceRoot = randomUUID(),
    sourceCert = "2".repeat(64);
  const reads: ReplicaRangeRead[] = [],
    replies: ReplicaRangeResult[] = [];
  const cert = "1".repeat(64);
  const hash = createHash("sha256").update("good").digest("hex");
  const key = `data-market/immutable/${hash}`;
  const input = {
    versionId: version,
    locationKind: "cp-local" as const,
    agentId: agent,
    managedRootId: root,
  };
  const clock = () => new Date(Date.now() + offset);
  let directory: string,
    roots: AgentDataRoots,
    store: AgentReplicaStore,
    content: string,
    online: boolean,
    offset: number;
  let coordinator: DataReplicaCoordinator;
  const commands: DataReplicaCommand[] = [];
  const dispatch = {
    replicaChannel: (id: string) => (online ? (id === sourceAgent ? sourceCert : cert) : undefined),
    pushReplicaRange: (
      id: string,
      _cert: string,
      payload: Extract<
        ServerMessage["payload"],
        { case: "replicaRangeRead" | "replicaRangeResult" }
      >,
    ) => {
      if (payload.case === "replicaRangeRead") {
        expect(id).toBe(sourceAgent);
        reads.push(payload.value);
      } else {
        expect(id).toBe(agent);
        replies.push(payload.value);
      }
      return true;
    },
    pushReplica: (_agent: string, _cert: string, command: DataReplicaCommand) => {
      commands.push(command);
      return true;
    },
  };
  const storage = {
    dataMarketImmutableBucket: "objects",
    async presignImmutableDownload(k: string, _ttl: number, v: string) {
      expect([k, v]).toEqual([key, "v1"]);
      return "https://store.invalid/v1";
    },
  };
  const createReplica = (k = "copy") => coordinator.create(input, user, org, hash, k);
  const next = async () => {
    await coordinator.tick();
    const command = commands.shift();
    if (!command) throw new Error("No replica command dispatched");
    return command;
  };
  const visible = async () =>
    (await new PgDataPrerequisiteRepository(db, { now: clock }).listLocations(version)).filter(
      (r) => r.kind === "cp-local",
    );
  const status = async (id: string) =>
    (await db.select().from(dataReplicas).where(eq(dataReplicas.id, id)))[0]?.status;
  beforeEach(async () => {
    online = true;
    offset = 0;
    content = "good";
    commands.length = 0;
    reads.length = 0;
    replies.length = 0;
    directory = await mkdtemp(join(tmpdir(), "kq-replica-files-"));
    roots = new AgentDataRoots({
      datasetRoot: join(directory, "data"),
      managedRoots: { [root]: "." },
      jobWorkRoot: join(directory, "jobs"),
    });
    await roots.initialize();
    store = new AgentReplicaStore(roots, async (url) => {
      expect(url).toBe("https://store.invalid/v1");
      return new Response(content);
    });
    coordinator = new DataReplicaCoordinator(db, storage, dispatch, clock);
    await db.insert(users).values({ id: user, email: `${user}@test.invalid` });
    await db.insert(orgs).values({ id: org, name: org });
    await db.insert(userOrgMemberships).values({ userId: user, orgId: org, role: "admin" });
    await db.insert(agents).values({
      agentId: agent,
      providerOrgId: org,
      siteId: "site",
      siteName: "center",
      clusterId: "cluster",
      schedulerType: "slurm",
      schedulerVersion: "1",
      topology: { managedDatasetRootIds: [root] },
    });
    await db.insert(agentCerts).values({
      agentId: agent,
      subjectCn: agent,
      certPem: "test ledger",
      fingerprintSha256: cert,
      expiresAt: new Date(Date.now() + 2 * 86400000),
    });
    await db
      .insert(clusterFileRoots)
      .values({ id: root, label: "target", providerOrgId: org, agentId: agent, path: "/datasets" });
    await db.insert(dataAssets).values({
      id: asset,
      providerOrgId: org,
      ownerKind: "provider",
      visibility: "organization",
      lifecycle: "published",
      name: "input",
    });
    await db.insert(dataAssetVersions).values({
      id: version,
      dataAssetId: asset,
      version: "v1",
      status: "ready",
      manifestDigest: hash,
      sizeBytes: 4,
      immutableAt: new Date(),
    });
    await db.insert(dataLocations).values({
      id: location,
      dataAssetVersionId: version,
      uri: `s3://objects/${key}`,
      kind: "platform-object",
    });
    await db.insert(dataAssetFiles).values({
      id: file,
      dataAssetVersionId: version,
      locationId: location,
      path: "inputs/x",
      digest: hash,
      sizeBytes: 4,
      metadata: { objectKey: key, objectVersionId: "v1" },
    });
    await db.insert(dataAssetManifestEntries).values({
      dataAssetVersionId: version,
      dataAssetFileId: file,
      entryPath: "inputs/x",
      digest: hash,
      sizeBytes: 4,
    });
    await db.insert(dataAccessPolicies).values({
      dataAssetId: asset,
      dataAssetVersionId: version,
      subjectKind: "org",
      subjectId: org,
      capabilities: ["export"],
      downloadPolicy: "allow",
      redistributionPolicy: "allow",
      crossCenterReplicationPolicy: "allow",
    });
  });
  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
    await db.delete(netdriveTransferLog).where(eq(netdriveTransferLog.actorId, user));
    await db.delete(dataAssets).where(eq(dataAssets.id, asset));
    await db.delete(agents).where(eq(agents.agentId, agent));
    await db.delete(agents).where(eq(agents.agentId, sourceAgent));
    await db.delete(orgs).where(eq(orgs.id, org));
    await db.delete(users).where(eq(users.id, user));
  });
  test("confirmed NetDrive imports influence locality while eligible and meter the first copy once", async () => {
    const backend = new FakeMinioBackend();
    const drive = new NetDriveService(db, backend, {
      commitSecret: "test-secret-test-secret-test-secret",
    });
    const path = "inputs/original.txt";
    const contentType = "text/plain";
    const upload = await drive.mintUploadUrl(user, { path, size: 4, contentType });
    await backend.putBlob(upload.storageKey, Buffer.from("good"), contentType);
    const original = await drive.commitFile(user, {
      path,
      size: 4,
      sha256: hash,
      contentType,
      storageKey: upload.storageKey,
      commitToken: upload.commitToken,
    });
    const market = new PgDataMarketRepository(db, { backend, retentionDays: 365 });
    const imported = await market.importNetDriveFile({
      assetId: asset,
      version: "from-drive",
      requesterId: user,
      netdriveFileId: original.id,
      idempotencyKey: "import",
    });
    const versionId = imported.version.id;
    await db.insert(dataAccessPolicies).values({
      dataAssetId: asset,
      dataAssetVersionId: versionId,
      subjectKind: "org",
      subjectId: org,
      capabilities: ["export"],
      downloadPolicy: "allow",
      redistributionPolicy: "allow",
      crossCenterReplicationPolicy: "allow",
    });
    coordinator = new DataReplicaCoordinator(db, backend, dispatch, clock);
    store = new AgentReplicaStore(roots, async (url) => {
      const objectKey = decodeURIComponent(
        new URL(url).pathname.slice("/immutable-download/".length),
      );
      return new Response(new Uint8Array(await backend.getImmutableBlob(objectKey)));
    });
    const task = await coordinator.create({ ...input, versionId }, user, org, hash, "from-drive");
    const sites = (owner = user, organization = org) =>
      deriveDataSites(db, [original.id], owner, organization, clock());
    const ledger = () =>
      db.select().from(netdriveTransferLog).where(eq(netdriveTransferLog.fileId, original.id));
    const receipt = await store.execute(await next());
    expect(receipt.outcome).toBe("copied");
    await coordinator.accept(agent, "wrong certificate", receipt);
    expect(await sites()).toEqual([]);
    expect((await ledger()).filter((r) => r.direction === "mirror")).toHaveLength(0);
    await Promise.all([
      coordinator.accept(agent, cert, receipt),
      coordinator.accept(agent, cert, receipt),
    ]);
    expect(await sites()).toEqual(["site"]);
    expect(await sites(randomUUID())).toEqual([]);
    expect(await sites(user, randomUUID())).toEqual([]);
    const mirror = (await ledger()).filter((r) => r.direction === "mirror");
    expect(mirror).toMatchObject([
      { actorId: user, orgId: org, bytes: 4, siteId: "site", netdriveFileIds: [original.id] },
    ]);
    await db
      .update(dataReplicas)
      .set({ verifiedAt: new Date(clock().getTime() - 86_400_000) })
      .where(eq(dataReplicas.id, task.id));
    expect(await sites()).toEqual([]);
    const confirmation = await store.execute(await next());
    await coordinator.accept(agent, cert, confirmation);
    expect(await sites()).toEqual(["site"]);
    await db
      .update(dataAccessPolicies)
      .set({ status: "revoked" })
      .where(eq(dataAccessPolicies.dataAssetVersionId, versionId));
    expect(await sites()).toEqual([]);
    expect((await ledger()).filter((r) => r.direction === "mirror")).toEqual(mirror);
  });
  test("queues offline and publishes measured bytes once on the registered site and cluster", async () => {
    const [a, b] = await Promise.all([createReplica(), createReplica()]);
    expect(a.id).toBe(b.id);
    await expect(
      coordinator.create({ ...input, agentId: "other" }, user, org, hash, "copy"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(createReplica("other")).rejects.toMatchObject({ statusCode: 409 });
    online = false;
    await coordinator.tick();
    expect(commands).toHaveLength(0);
    expect(await status(a.id)).toBe("pending");
    expect(await visible()).toEqual([]);
    online = true;
    offset = 31_000;
    coordinator = new DataReplicaCoordinator(db, storage, dispatch, clock);
    const command = await next();
    const receipt = await store.execute(command);
    expect(receipt.outcome).toBe("copied");
    const bytes = join(directory, "data", ".kq-replicas", a.id, "inputs/x");
    expect(await readFile(bytes, "utf8")).toBe("good");
    expect(await visible()).toEqual([]);
    await expect(roots.scanManagedDataset(root, `.kq-replicas/${a.id}`)).rejects.toThrow(
      "replicas",
    );
    await coordinator.accept("other", cert, receipt);
    await coordinator.accept(agent, "other", receipt);
    expect(await status(a.id)).toBe("syncing");
    await coordinator.accept(agent, cert, receipt);
    await coordinator.accept(agent, cert, receipt);
    expect(await status(a.id)).toBe("available");
    expect(await visible()).toMatchObject([
      { agentId: agent, siteId: "site", clusterId: "cluster" },
    ]);
    await db
      .update(dataAccessPolicies)
      .set({ status: "revoked" })
      .where(eq(dataAccessPolicies.dataAssetId, asset));
    expect(await visible()).toEqual([]);
    await coordinator.tick();
    expect(await status(a.id)).toBe("failed");
    await coordinator.accept(agent, cert, await store.execute(await next()));
    await expect(stat(bytes)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test.each([
    "cancel",
    "revoke",
    "root",
    "receipt",
  ] as const)("rejects publication after %s and collects verified bytes", async (mode) => {
    const task = await createReplica();
    const receipt = await store.execute(await next());
    if (mode === "cancel") {
      await coordinator.cancel(version, task.id, org);
      await coordinator.cancel(version, task.id, org);
    } else if (mode === "root") {
      await db
        .update(clusterFileRoots)
        .set({ path: "/changed" })
        .where(eq(clusterFileRoots.id, root));
    } else if (mode === "revoke") {
      await db
        .update(dataAccessPolicies)
        .set({ status: "revoked" })
        .where(eq(dataAccessPolicies.dataAssetId, asset));
    } else {
      receipt.files = [];
    }
    await coordinator.accept(agent, cert, receipt);
    expect(await status(task.id)).toBe(
      mode === "cancel" ? "deleted" : mode === "receipt" ? "mismatch" : "failed",
    );
    expect(await visible()).toEqual([]);
    const cleanup = await next();
    expect(cleanup.release).toBe(true);
    await coordinator.accept(agent, cert, await store.execute(cleanup));
    await coordinator.accept(agent, cert, receipt);
    await expect(stat(join(directory, "data", ".kq-replicas", task.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  test("a newly started Agent resumes at the persisted byte offset", async () => {
    const task = await createReplica();
    const short = new AgentReplicaStore(roots, async () => new Response("go"));
    const first = await short.execute(await next());
    expect(first.outcome).toBe("retry");
    await coordinator.accept(agent, cert, first);
    expect(await status(task.id)).toBe("pending");
    expect(await visible()).toEqual([]);
    offset = 11_000;
    const resumed = new AgentReplicaStore(roots, async (_url, init) => {
      expect(new Headers(init.headers).get("range")).toBe("bytes=2-");
      return new Response("od", { status: 206, headers: { "content-range": "bytes 2-3/4" } });
    });
    const receipt = await resumed.execute(await next());
    expect(receipt.outcome).toBe("copied");
    await coordinator.accept(agent, cert, receipt);
    expect(
      await readFile(join(directory, "data", ".kq-replicas", task.id, "inputs/x"), "utf8"),
    ).toBe("good");
    expect(await visible()).toHaveLength(1);
  });
  test("rejects wrong bytes and discards partial files", async () => {
    const task = await createReplica();
    content = "evil";
    const receipt = await store.execute(await next());
    expect(receipt.outcome).toBe("mismatch");
    await coordinator.accept(agent, cert, receipt);
    expect(await status(task.id)).toBe("mismatch");
    expect(await visible()).toEqual([]);
    for (const suffix of ["", ".partial"])
      await expect(
        stat(join(directory, "data", ".kq-replicas", task.id + suffix)),
      ).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("rechecks existing bytes after loss of a receipt and fences the expired attempt", async () => {
    const task = await createReplica();
    const old = await store.execute(await next());
    offset = 301_000;
    await coordinator.accept(agent, cert, old);
    expect(await visible()).toEqual([]);
    const retry = await next();
    expect(retry.attemptId).not.toBe(old.attemptId);
    await coordinator.accept(agent, cert, old);
    expect(await status(task.id)).toBe("syncing");
    await coordinator.accept(agent, cert, await store.execute(retry));
    expect(await status(task.id)).toBe("available");
  });
  test.each([
    false,
    true,
  ])("reverifies expired target bytes after reconnection (corrupt=%s)", async (corrupt) => {
    const task = await createReplica();
    const first = await store.execute(await next());
    await coordinator.accept(agent, cert, first);
    await db
      .update(dataReplicas)
      .set({ verifiedAt: new Date(clock().getTime() - 86_400_000) })
      .where(eq(dataReplicas.id, task.id));
    expect(await visible()).toEqual([]);
    online = false;
    await coordinator.tick();
    expect(await status(task.id)).toBe("pending");
    const target = join(directory, "data", ".kq-replicas", task.id, "inputs/x");
    if (corrupt) await writeFile(target, "evil");
    online = true;
    offset = 31_000;
    const reconnected = new AgentReplicaStore(roots, async () => {
      throw new Error("existing target must be measured locally");
    });
    const attempt = await next();
    expect(attempt.attemptId).not.toBe(first.attemptId);
    await coordinator.accept(agent, cert, first);
    expect(await visible()).toEqual([]);
    const receipt = await reconnected.execute(attempt);
    await coordinator.accept(agent, cert, receipt);
    expect(await status(task.id)).toBe(corrupt ? "mismatch" : "available");
    expect(await visible()).toHaveLength(corrupt ? 0 : 1);
    if (corrupt) {
      await coordinator.accept(agent, cert, await reconnected.execute(await next()));
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  test.each([
    "copy",
    "revoke",
    "replace",
    "wrong-sender",
    "empty",
    "resume",
  ])("CP-local range transfer validates both centers and the pinned bytes (%s)", async (mode) => {
    const bytes = Buffer.alloc(mode === "empty" ? 0 : REPLICA_RANGE_BYTES + 7, "x");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const sourceRoots = new AgentDataRoots({
      datasetRoot: join(directory, "origin"),
      jobWorkRoot: join(directory, "origin-jobs"),
      managedRoots: { [sourceRoot]: "." },
    });
    await sourceRoots.initialize();
    await mkdir(join(directory, "origin", "dataset", "inputs"), { recursive: true });
    const path = join(directory, "origin", "dataset", "inputs", "x");
    await writeFile(path, bytes);
    const reader = new AgentReplicaStore(sourceRoots).reader;
    await db.insert(agents).values({
      agentId: sourceAgent,
      providerOrgId: org,
      siteId: "origin",
      siteName: "origin",
      clusterId: "origin",
      schedulerType: "slurm",
      schedulerVersion: "1",
      topology: { managedDatasetRootIds: [sourceRoot] },
    });
    await db.insert(agentCerts).values({
      agentId: sourceAgent,
      subjectCn: sourceAgent,
      certPem: "fixture",
      fingerprintSha256: sourceCert,
      expiresAt: new Date(Date.now() + 86400000),
    });
    await db.insert(clusterFileRoots).values({
      id: sourceRoot,
      label: "origin",
      providerOrgId: org,
      agentId: sourceAgent,
      path: "/datasets",
    });
    await db
      .update(dataLocations)
      .set({
        agentId: sourceAgent,
        providerOrgId: org,
        siteId: "origin",
        managedRootId: sourceRoot,
        kind: "cp-local",
        uri: null,
        relativePath: "dataset",
      })
      .where(eq(dataLocations.id, location));
    await db
      .update(dataAssetVersions)
      .set({ manifest: { attestedBy: sourceAgent }, sizeBytes: bytes.length })
      .where(eq(dataAssetVersions.id, version));
    await db
      .update(dataAssetFiles)
      .set({ sizeBytes: bytes.length, digest: sha, metadata: {} })
      .where(eq(dataAssetFiles.id, file));
    await db
      .update(dataAssetManifestEntries)
      .set({ sizeBytes: bytes.length, digest: sha })
      .where(eq(dataAssetManifestEntries.dataAssetVersionId, version));
    coordinator = new DataReplicaCoordinator(db, undefined, dispatch, clock);
    const task = await createReplica();
    const command = await next();
    expect(command.managedSource).toBe(true);
    let interrupted = false;
    const copy = (targetStore: AgentReplicaStore, cmd: DataReplicaCommand) =>
      targetStore.execute(cmd, async (range) => {
        if (mode === "resume" && range.offset > 0n && !interrupted) {
          interrupted = true;
          throw new Error("connection lost");
        }
        await coordinator.relay(agent, cert, range);
        const read = reads.shift();
        if (!read) throw new Error("missing source read");
        if (mode === "replace" && range.offset > 0n)
          await writeFile(path, Buffer.alloc(bytes.length, "y"));
        const result = await reader.read(read);
        if (mode === "revoke")
          await db
            .update(dataAccessPolicies)
            .set({ status: "revoked" })
            .where(eq(dataAccessPolicies.dataAssetId, asset));
        await coordinator.relay(
          mode === "wrong-sender" ? agent : sourceAgent,
          mode === "wrong-sender" ? cert : sourceCert,
          range,
          result,
        );
        const reply = replies.shift();
        if (!reply) throw new Error("no authorized reply");
        return reply;
      });
    let receipt = await copy(store, command);
    if (mode === "resume") {
      expect(receipt.outcome).toBe("retry");
      await coordinator.accept(agent, cert, receipt);
      offset = 11_000;
      receipt = await copy(new AgentReplicaStore(roots), await next());
    }
    await coordinator.accept(agent, cert, receipt);
    const target = join(directory, "data", ".kq-replicas", task.id, "inputs", "x");
    if (["copy", "empty", "resume"].includes(mode)) {
      expect(receipt.outcome).toBe("copied");
      expect(await status(task.id)).toBe("available");
      expect(await readFile(target)).toEqual(bytes);
      await coordinator.accept(agent, cert, receipt);
      expect((await visible()).some((r) => r.agentId === agent)).toBe(true);
    } else {
      expect(receipt.outcome).toBe(mode === "replace" ? "mismatch" : "retry");
      expect(replies).toHaveLength(0);
      expect((await visible()).some((r) => r.agentId === agent)).toBe(false);
      if (mode !== "replace") await coordinator.cancel(version, task.id, org);
      await coordinator.accept(agent, cert, await store.execute(await next()));
      await expect(
        stat(join(directory, "data", ".kq-replicas", task.id + ".partial")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  test("requires explicit current disclosure consent before enqueueing", async () => {
    await db.delete(dataAccessPolicies).where(eq(dataAccessPolicies.dataAssetId, asset));
    await expect(createReplica()).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await db.select().from(dataReplicas).where(eq(dataReplicas.dataAssetVersionId, version)),
    ).toEqual([]);
  });
});
