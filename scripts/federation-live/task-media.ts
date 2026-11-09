import assert from "node:assert/strict";
import {
  agents,
  clusterFileRoots,
  createPgDb,
  federationInputAttempts,
  federationInputImports,
  federationOutbound,
  federationPreparations,
  federationResultAttempts,
  federationResultImports,
  federationTaskMediaClaims,
  jobs,
  netdriveFiles,
  workflowRuns,
} from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";

assert.equal(process.env.LAB_SCENARIO, "task-media");
const root = z.string().min(1).parse(process.env.LAB_ROOT);
const url = z.url().parse(process.env.DATABASE_URL);
assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
const db = createPgDb(url);
try {
  const command = z.enum(["setup-source", "setup-target", "inspect"]).parse(process.argv[2]);
  if (command !== "inspect") {
    const actor = z
      .object({ orgId: z.uuid(), userId: z.uuid() })
      .parse(
        await Bun.file(
          `${root}/${command === "setup-source" ? "source-actor" : "registration"}.json`,
        ).json(),
      );
    const agentId = z.string().min(1).parse(process.env.LAB_AGENT);
    const [agent] = await db.select().from(agents).where(eq(agents.agentId, agentId));
    assert.equal(agent?.providerOrgId, actor.orgId);
    await new FederationPermissionService(db).set(
      { ...actor, capability: "asset.read", enabled: true },
      actor.userId,
    );
    await db.insert(clusterFileRoots).values({
      id: z.uuid().parse(process.env.LAB_MEDIA_ROOT_ID),
      agentId,
      providerOrgId: actor.orgId,
      label: "Private task media",
      path: "/var/lib/kuintessence/datasets",
    });
  } else {
    const state = {
      outbound: await db
        .select({
          operationId: federationOutbound.operationId,
          state: federationOutbound.state,
          receipt: federationOutbound.receipt,
          lastError: federationOutbound.lastError,
        })
        .from(federationOutbound),
      preparations: await db
        .select({ state: federationPreparations.state, blocker: federationPreparations.blocker })
        .from(federationPreparations),
      runs: await db
        .select({
          id: workflowRuns.id,
          status: workflowRuns.status,
          errorMessage: workflowRuns.errorMessage,
        })
        .from(workflowRuns),
      jobs: await db
        .select({ id: jobs.id, status: jobs.status, schedulerJobId: jobs.schedulerJobId })
        .from(jobs),
      files: await db
        .select({ id: netdriveFiles.id, size: netdriveFiles.size, sha256: netdriveFiles.sha256 })
        .from(netdriveFiles),
      inputs: await db
        .select({
          id: federationInputImports.id,
          reservationId: federationInputImports.reservationId,
          state: federationInputImports.state,
          delivery: federationInputImports.delivery,
          reservedBytes: federationInputImports.reservedBytes,
          lastError: federationInputImports.lastError,
        })
        .from(federationInputImports),
      results: await db
        .select({
          id: federationResultImports.id,
          operationId: federationResultImports.operationId,
          state: federationResultImports.state,
          delivery: federationResultImports.delivery,
          reservedBytes: federationResultImports.reservedBytes,
          lastError: federationResultImports.lastError,
          receiptAck: federationResultImports.receiptAck,
        })
        .from(federationResultImports),
      claims: await db
        .select({
          id: federationTaskMediaClaims.id,
          inputId: federationTaskMediaClaims.taskInputImportId,
          resultId: federationTaskMediaClaims.taskResultImportId,
          authorizationId: federationTaskMediaClaims.authorizationId,
          generation: federationTaskMediaClaims.generation,
          releasedAt: federationTaskMediaClaims.releasedAt,
        })
        .from(federationTaskMediaClaims),
      inputAttempts: await db
        .select({
          generation: federationInputAttempts.generation,
          claimId: federationInputAttempts.mediaClaimId,
          state: federationInputAttempts.state,
          verifiedAt: federationInputAttempts.verifiedAt,
          versionId: federationInputAttempts.destinationVersionId,
        })
        .from(federationInputAttempts),
      resultAttempts: await db
        .select({
          generation: federationResultAttempts.generation,
          claimId: federationResultAttempts.mediaClaimId,
          state: federationResultAttempts.state,
          verifiedAt: federationResultAttempts.verifiedAt,
          versionId: federationResultAttempts.destinationVersionId,
        })
        .from(federationResultAttempts),
    };
    await Bun.write(`${root}/task-media-state.json`, JSON.stringify(state));
  }
} finally {
  await db.$client.end();
}
