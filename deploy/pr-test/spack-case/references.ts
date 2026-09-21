import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  createPgDb,
  softwareOperations,
  spackMaterialBindings,
  spackMaterialOperationReferences,
  SpackMaterialReferences,
} from "@kuintessence/db";
import { SpackMaterialBindingSchema } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ReleaseSchema } from "./api";

const PhaseSchema = z.enum([
  "configured",
  "native-terminal",
  "native-restart",
  "managed-terminal",
  "managed-restart",
  "managed-uninstall",
]);
type Stage =
  | "guard"
  | "release"
  | "bindings"
  | "operations"
  | "release-counts"
  | "persisted-identity"
  | "close";
let phase: z.infer<typeof PhaseSchema> | "guard" = "guard";
let stage: Stage = "guard";
// Server restart retains its private writable layer; project cleanup removes these hashes.
const baseline = "/tmp/kq-pr-spack-references";
const CountSchema = z.object({
  bindingCount: z.number().int().nonnegative(),
  activeOperationCount: z.number().int().nonnegative(),
  orphanedOperationCount: z.number().int().nonnegative(),
});

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  assert(
    process.env.KQ_PR_TEST === "1" &&
      process.env.SPACK_MATERIAL_DELIVERY_ENABLED === "true" &&
      process.env.AGENT_ID === undefined,
    "Reference checks require the disposable Server workspace",
  );
  assert(process.argv.length === 3, "Expected one reference check phase");
  phase = PhaseSchema.parse(process.argv[2]);
  const connectionString = process.env.DATABASE_URL;
  assert(connectionString, "Server database configuration is required");

  stage = "release";
  const release = ReleaseSchema.parse(
    JSON.parse(await readFile("/case-control/release.json", "utf8")),
  );
  const configured = z.record(z.string(), SpackMaterialBindingSchema).parse(
    JSON.parse(await readFile("/case-control/bindings.json", "utf8")),
  );
  assert(
    Object.keys(configured).length === 1 &&
      configured[release.spec]?.repositoryId === release.binding.repositoryId &&
      configured[release.spec]?.manifestDigest === release.binding.manifestDigest,
    "Expected exactly the published release configuration",
  );

  const db = createPgDb(connectionString, { max: 1, idle_timeout: 5 });
  let counts: z.infer<typeof CountSchema>;
  let referenceCount: number;
  try {
    stage = "bindings";
    // The disposable project contains one release. Do not filter away unexpected rows.
    const bindings = await db.select().from(spackMaterialBindings).limit(2);
    const binding = bindings[0];
    assert(bindings.length === 1 && binding, "Expected one durable configured binding");
    assert(
      binding.spec === release.spec &&
        binding.repositoryId === release.binding.repositoryId &&
        binding.manifestDigest === release.binding.manifestDigest,
      "Durable binding does not match configuration",
    );

    stage = "operations";
    const references = await db.select().from(spackMaterialOperationReferences).limit(2);
    referenceCount = references.length;
    // Do not load operation stdout/stderr/errors, which may contain Agent output.
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
      .where(
        and(
          eq(softwareOperations.agentId, "pr-scheduler"),
          eq(softwareOperations.action, "install"),
        ),
      )
      .limit(2);
    if (phase === "configured") {
      assert(
        references.length === 0 && operations.length === 0,
        "Configured binding must precede installation",
      );
    } else {
      const operation = operations[0];
      const reference = references[0];
      assert(
        operations.length === 1 && operation && references.length === 1 && reference,
        "Expected one real install operation and one durable reference",
      );
      assert(
        operation.spec === release.spec &&
          operation.requestedBy !== null &&
          operation.finishedAt !== null &&
          operation.status === (phase.startsWith("native-") ? "rejected" : "succeeded"),
        "Real install operation did not reach the expected terminal state",
      );
      assert(
        reference.operationId === operation.id &&
          reference.agentId === operation.agentId &&
          reference.requestedBy === operation.requestedBy &&
          reference.spec === operation.spec &&
          reference.repositoryId === binding.repositoryId &&
          reference.manifestDigest === binding.manifestDigest,
        "Operation reference does not match its exact operation and release",
      );
    }

    stage = "release-counts";
    counts = CountSchema.parse(
      await new SpackMaterialReferences(db).listReleaseReferences(release.binding),
    );
    assert(
      counts.bindingCount === 1 &&
        counts.activeOperationCount === 0 &&
        counts.orphanedOperationCount === 0,
      "Terminal operation must stop blocking without removing the configured binding",
    );

    stage = "persisted-identity";
    const bindingDigest = fingerprint(binding);
    if (phase === "configured") {
      await writeFile(`${baseline}-binding`, bindingDigest, { mode: 0o600, flag: "wx" });
    } else {
      assert(
        (await readFile(`${baseline}-binding`, "utf8")) === bindingDigest,
        "Configured binding identity changed",
      );
      const operationDigest = fingerprint({ reference: references[0], operation: operations[0] });
      if (phase === "native-terminal" || phase === "managed-terminal") {
        await writeFile(`${baseline}-operation`, operationDigest, { mode: 0o600, flag: "wx" });
      } else {
        assert(
          (await readFile(`${baseline}-operation`, "utf8")) === operationDigest,
          "Persisted operation or reference identity changed after restart",
        );
      }
    }
    stage = "close";
  } finally {
    await db.$client.end({ timeout: 5 });
  }
  console.log(
    `Spack references: stage=${phase} code=OK bindingCount=${counts.bindingCount} ` +
      `operationReferenceCount=${referenceCount} activeOperationCount=${counts.activeOperationCount} ` +
      `orphanedOperationCount=${counts.orphanedOperationCount}`,
  );
}

const deadline = setTimeout(() => {
  console.error(`Spack references: stage=${phase}:${stage} code=TIMEOUT`);
  process.exit(1);
}, 50_000);
try {
  await main();
} catch (error) {
  // Never print SQL, connection strings, assertion values, Zod issues or Agent logs.
  const code =
    error instanceof z.ZodError
      ? "SCHEMA_INVALID"
      : error instanceof assert.AssertionError
        ? "ASSERTION_FAILED"
        : error instanceof SyntaxError
          ? "INVALID_JSON"
          : "REFERENCE_CHECK_FAILED";
  console.error(`Spack references: stage=${phase}:${stage} code=${code}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
