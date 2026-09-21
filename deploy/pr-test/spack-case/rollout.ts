import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createPgDb,
  type PgDb,
  softwareOperations,
  spackMaterialBindings,
  spackMaterialOperationReferences,
  SpackMaterialReferences,
  SpackMaterialRollout,
  spackMaterialRollouts,
  users,
} from "@kuintessence/db";
import { SpackMaterialBindingSchema, SpackMaterialManifestSchema } from "@kuintessence/shared";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { login, ReleaseSchema } from "./api";

const ModeSchema = z.enum(["activate", "verify"]);
const EpochSchema = z.string().length(36).uuid();
const SnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  epoch: EpochSchema.nullable(),
  phase: z.enum(["observe", "paused", "ready"]),
  action: z.enum(["pause", "reconcile", "activate"]).nullable(),
  inventoryDigest: z.string().length(71).regex(/^sha256:[a-f0-9]{64}$/),
  bindingCount: z.literal(1),
  operationReferenceCount: z.literal(1),
  activeInstallCount: z.literal(0),
  orphanedOperationCount: z.literal(0),
});
type Release = z.infer<typeof ReleaseSchema>;
type Snapshot = z.infer<typeof SnapshotSchema>;
type Stage =
  | "guard"
  | "fixture"
  | "admin"
  | "server"
  | "inventory"
  | "observe"
  | "manifest-before"
  | "pause"
  | "paused-reference"
  | "paused-registry"
  | "reconcile"
  | "activate"
  | "ready-registry"
  | "ready-journal"
  | "verify-reference"
  | "verify-manifest"
  | "close"
  | "complete";
let mode: z.infer<typeof ModeSchema> | "guard" = "guard";
let stage: Stage = "guard";
const server = "http://127.0.0.1:3000";
const registry = "http://registry:3100";
const repository = "public/pr-hello-sources";
const seedEmail = "scheduler-compose-seed@kuintessence.test";

function progress(next: Stage): void {
  stage = next;
  console.error(`Spack rollout: mode=${mode} stage=${stage} code=START`);
}

function repositoryId(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

async function checkInventory(db: PgDb, release: Release, operatorId: string): Promise<void> {
  // Inspect the entire disposable material inventory, not a filtered subset.
  const bindings = await db.select().from(spackMaterialBindings).limit(2);
  const references = await db.select().from(spackMaterialOperationReferences).limit(2);
  const operations = await db
    .select({
      id: softwareOperations.id,
      agentId: softwareOperations.agentId,
      requestedBy: softwareOperations.requestedBy,
      spec: softwareOperations.spec,
      status: softwareOperations.status,
      finishedAt: softwareOperations.finishedAt,
    })
    .from(softwareOperations)
    .where(eq(softwareOperations.action, "install"))
    .limit(2);
  const binding = bindings[0];
  const reference = references[0];
  const operation = operations[0];
  assert(bindings.length === 1 && binding && references.length === 1 && reference);
  assert(operations.length === 1 && operation);
  assert(
    binding.spec === release.spec &&
      binding.repositoryId === release.binding.repositoryId &&
      binding.manifestDigest === release.binding.manifestDigest,
  );
  assert(
    operation.agentId === "pr-scheduler" &&
      operation.requestedBy === operatorId &&
      operation.spec === release.spec &&
      operation.finishedAt !== null &&
      (operation.status === "rejected" || operation.status === "succeeded"),
  );
  assert(
    reference.operationId === operation.id &&
      reference.agentId === operation.agentId &&
      reference.requestedBy === operation.requestedBy &&
      reference.spec === operation.spec &&
      reference.repositoryId === binding.repositoryId &&
      reference.manifestDigest === binding.manifestDigest,
  );
}

async function checkManifest(token: string, release: Release, status: 200 | 503): Promise<void> {
  const response = await fetch(
    `${registry}/api/spack/material-repositories/${release.binding.repositoryId}/releases/${release.binding.manifestDigest}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  try {
    assert.equal(response.status, status);
    if (status === 503) return;
    assert(response.body);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      assert(size <= release.manifestSize);
      chunks.push(chunk);
    }
    assert.equal(size, release.manifestSize);
    const bytes = Buffer.concat(chunks);
    assert.equal(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      release.binding.manifestDigest,
    );
    const manifest = SpackMaterialManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    assert(
      manifest.repository === repository &&
        manifest.spec === release.spec &&
        manifest.target === release.target &&
        manifest.spackVersion === "1.0.0" &&
        manifest.recipes.length === 1 &&
        manifest.recipes[0]?.repositoryId === release.recipeId &&
        manifest.recipes[0]?.commit === release.commit,
    );
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel();
  }
}

async function checkReadyJournal(db: PgDb, snapshot: Snapshot, operatorId: string): Promise<void> {
  const [journal] = await db
    .select()
    .from(spackMaterialRollouts)
    .orderBy(desc(spackMaterialRollouts.revision))
    .limit(1);
  assert(
    snapshot.phase === "ready" &&
      snapshot.action === "activate" &&
      snapshot.revision === 3 &&
      journal?.phase === "ready" &&
      journal.action === "activate" &&
      journal.revision === snapshot.revision &&
      journal.epoch === snapshot.epoch &&
      journal.operatorId === operatorId &&
      journal.inventoryDigest === snapshot.inventoryDigest &&
      journal.evidence?.legacyProcessesStoppedAndDrained === true &&
      journal.evidence.legacyAccessRevoked === true &&
      journal.evidence.legacyInventoryComplete === true,
  );
}

async function main(): Promise<string | undefined> {
  assert(
    process.env.KQ_PR_TEST === "1" &&
      process.env.AGENT_ID === undefined &&
      process.env.SPACK_MATERIAL_DELIVERY_ENABLED === "true" &&
      process.env.NODE_ENV === "development" &&
      process.env.MTLS_MODE === "direct" &&
      process.env.SERVER_CA_DIR === "/case-server/ca" &&
      process.env.SPACK_REGISTRY_URL === registry,
  );
  assert.equal(process.argv.length, 3);
  mode = ModeSchema.parse(process.argv[2]);
  const configuredEpoch = process.env.SPACK_MATERIAL_EPOCH;
  if (mode === "activate") assert(configuredEpoch === undefined || configuredEpoch === "");
  else EpochSchema.parse(configuredEpoch);
  const connectionString = process.env.DATABASE_URL;
  assert(connectionString);
  const address = new URL(connectionString);
  assert(
    address.protocol === "postgres:" &&
      address.hostname === "postgres" &&
      address.port === "5432" &&
      address.username === "kq" &&
      address.password.length > 0 &&
      address.pathname === "/kuintessence" &&
      !address.search &&
      !address.hash,
  );

  progress("fixture");
  const release = ReleaseSchema.parse(
    JSON.parse(await readFile("/case-control/release.json", "utf8")),
  );
  const bindings = z.record(z.string(), SpackMaterialBindingSchema).parse(
    JSON.parse(await readFile("/case-control/bindings.json", "utf8")),
  );
  assert(
    release.spec === "hello@2.12.1" &&
      release.manifestSize <= 2 * 1024 ** 2 &&
      release.binding.repositoryId === repositoryId(repository) &&
      release.recipeId === repositoryId("public/pr-hello-recipes") &&
      Object.keys(bindings).length === 1 &&
      bindings[release.spec]?.repositoryId === release.binding.repositoryId &&
      bindings[release.spec]?.manifestDigest === release.binding.manifestDigest,
  );

  const db = createPgDb(connectionString, { max: 1, idle_timeout: 5 });
  let readyEpoch: string | undefined;
  try {
    progress("admin");
    const [admin] = await db
      .select({ id: users.id, role: users.role, suspended: users.suspended })
      .from(users)
      .where(eq(users.email, seedEmail))
      .limit(1);
    assert(admin?.role === "platform_admin" && !admin.suspended);
    const operatorId = EpochSchema.parse(admin.id);
    progress("server");
    const health = await fetch(`${server}/api/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(health.status, 200);
    z.object({ status: z.literal("ok") }).parse(await health.json());
    // Use the running Server's auth route; never synthesize or print its token.
    const token = await login(server);
    progress("inventory");
    await checkInventory(db, release, operatorId);
    const rollout = new SpackMaterialRollout(db);
    const inspect = async () => SnapshotSchema.parse(await rollout.execute({ action: "inspect" }));

    if (mode === "activate") {
      progress("observe");
      const observed = await inspect();
      assert(observed.revision === 0 && observed.phase === "observe");
      assert(observed.epoch === null && observed.action === null);
      const references = new SpackMaterialReferences(db);
      await references.registerBindings({});
      progress("manifest-before");
      await checkManifest(token, release, 200);
      progress("pause");
      const paused = SnapshotSchema.parse(
        await rollout.execute({ action: "pause", operatorId, expectedRevision: observed.revision }),
      );
      assert(paused.phase === "paused" && paused.action === "pause" && paused.revision === 1);
      const epoch = EpochSchema.parse(paused.epoch);
      assert.equal(paused.inventoryDigest, observed.inventoryDigest);
      progress("paused-reference");
      let denied = false;
      try {
        await references.registerBindings({});
      } catch (error) {
        assert(
          error instanceof Error &&
            "code" in error &&
            error.code === "SPACK_MATERIAL_REFERENCE_ERROR",
        );
        denied = true;
      }
      assert(denied);
      progress("paused-registry");
      await checkManifest(token, release, 503);
      progress("reconcile");
      const reconciled = SnapshotSchema.parse(
        await rollout.execute({
          action: "reconcile",
          operatorId,
          expectedRevision: paused.revision,
          epoch,
          bindings: [bindings],
        }),
      );
      assert(reconciled.phase === "paused" && reconciled.action === "reconcile");
      assert(reconciled.revision === 2 && reconciled.epoch === epoch);
      assert.equal(reconciled.inventoryDigest, observed.inventoryDigest);
      progress("activate");
      const ready = SnapshotSchema.parse(
        await rollout.execute({
          action: "activate",
          operatorId,
          expectedRevision: reconciled.revision,
          epoch,
          inventoryDigest: reconciled.inventoryDigest,
          // Test evidence only: run.sh creates fresh isolated volumes/credentials and
          // runs only this checkout's images, with no legacy deployment or credentials.
          // This is NOT a production legacy-drain or credential-revocation verifier.
          evidence: {
            legacyProcessesStoppedAndDrained: true,
            legacyAccessRevoked: true,
            legacyInventoryComplete: true,
          },
        }),
      );
      assert.equal(ready.epoch, epoch);
      assert.equal(ready.inventoryDigest, observed.inventoryDigest);
      progress("ready-registry");
      // The same still-running Registry has no epoch, even though the journal is ready.
      await checkManifest(token, release, 503);
      progress("ready-journal");
      await checkReadyJournal(db, await inspect(), operatorId);
      readyEpoch = epoch;
    } else {
      progress("ready-journal");
      const ready = await inspect();
      assert.equal(ready.epoch, configuredEpoch);
      await checkReadyJournal(db, ready, operatorId);
      progress("verify-reference");
      await new SpackMaterialReferences(db, configuredEpoch).registerBindings(bindings);
      await checkInventory(db, release, operatorId);
      // Recreation discards /tmp; compare the current inventory to the persisted journal.
      const after = await inspect();
      assert.equal(after.epoch, configuredEpoch);
      assert.equal(after.inventoryDigest, ready.inventoryDigest);
      await checkReadyJournal(db, after, operatorId);
      progress("verify-manifest");
      await checkManifest(token, release, 200);
    }
    progress("close");
  } finally {
    await db.$client.end({ timeout: 5 });
  }
  stage = "complete";
  console.error(`Spack rollout: mode=${mode} stage=${stage} code=OK`);
  return readyEpoch;
}

const deadline = setTimeout(() => {
  console.error(`Spack rollout: mode=${mode} stage=${stage} code=TIMEOUT`);
  process.exit(1);
}, 50_000);
try {
  const epoch = await main();
  // stdout is a machine-only handoff to run.sh, emitted only after full success.
  if (epoch !== undefined) console.log(epoch);
} catch (error) {
  const code =
    error instanceof z.ZodError
      ? "SCHEMA_INVALID"
      : error instanceof assert.AssertionError
        ? "ASSERTION_FAILED"
        : error instanceof SyntaxError
          ? "INVALID_JSON"
          : "ROLLOUT_CHECK_FAILED";
  // Never print assertion values, auth responses, SQL, connection strings or Agent logs.
  console.error(`Spack rollout: mode=${mode} stage=${stage} code=${code}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
