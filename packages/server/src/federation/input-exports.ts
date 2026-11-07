import { createHash } from "node:crypto";
import {
  auditLog,
  federationWorkflowInputExports,
  type PgTransaction,
  workflowExecutionDelegations,
} from "@kuintessence/db";
import { type NodeInvocation, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import {
  type FederationAgreement,
  type FederationDelegation,
  FederationError,
  FederationInputFilesSchema,
  FederationInputSelectionSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import { federationMaterialDigest } from "./assets";
import { ownedNetdriveFiles } from "./netdrive-inputs";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { assertWorkflowDelegationOwner } from "./workflow-delegations";

type Export = typeof federationWorkflowInputExports.$inferSelect;

/** Source preparation only. Peer disclosure must additionally authorize an accepted delegation. */
export class FederationWorkflowInputExports {
  async capture(
    actor: FederationActor,
    lease: LeasedWorkflowJournal,
    nodeId: string,
    invocation: NodeInvocation,
    raw: unknown,
  ) {
    const path = invocation.path;
    if (!path || Buffer.byteLength(path) > 16_384 || !nodeId || Buffer.byteLength(nodeId) > 1024)
      throw new WorkflowExecutionInterrupted("Invalid durable input invocation", {
        retryable: false,
      });
    let input: unknown;
    try {
      input = JSON.parse(federationCanonicalJson(raw));
    } catch {
      throw new FederationError("INVALID_MESSAGE");
    }
    const parsed = FederationInputSelectionSchema.safeParse(input);
    if (!parsed.success) throw new FederationError("INVALID_MESSAGE");
    const selection = parsed.data;
    const members = selection.flatMap((input) => input.files);
    if (members.length > 256) throw new FederationError("INVALID_MESSAGE");
    const intentDigest = federationMaterialDigest(selection);
    const pathHash = createHash("sha256").update(path).digest("hex");
    return lease.transaction(async (tx) => {
      await assertWorkflowDelegationOwner(tx, lease.runId, actor);
      await requireFederationCapability(tx, actor, "delegation.submit");
      const [existing] = await tx
        .select()
        .from(federationWorkflowInputExports)
        .where(
          and(
            eq(federationWorkflowInputExports.runId, lease.runId),
            eq(federationWorkflowInputExports.pathHash, pathHash),
          ),
        );
      if (
        existing &&
        (existing.path !== path ||
          existing.nodeId !== nodeId ||
          existing.localOrgId !== actor.orgId ||
          existing.ownerId !== actor.userId ||
          existing.intentDigest !== intentDigest)
      )
        throw new WorkflowExecutionInterrupted("Workflow invocation changed its file inputs", {
          retryable: false,
        });
      const files = await ownedNetdriveFiles(
        tx,
        members.map((file) => file.fileId),
        actor.userId,
        true,
      );
      const bindings = selection.flatMap((input) =>
        input.files.map((member) => {
          const file = files.find((file) => file.id === member.fileId);
          if (!file?.storageVersionId || file.storageVersionId === "null" || !file.storageKey)
            throw new FederationError("DATA_WAITING");
          return {
            descriptor: input.descriptor,
            path: member.path,
            fileId: file.id,
            storageKey: file.storageKey,
            versionId: file.storageVersionId,
            sha256: file.sha256,
            sizeBytes: file.size,
          };
        }),
      );
      const portable = FederationInputFilesSchema.safeParse({
        protocolVersion: 1,
        kind: "workflow-input-files",
        inputs: selection.map((input) => ({
          descriptor: input.descriptor,
          type: input.type,
          files: bindings
            .filter((file) => file.descriptor === input.descriptor)
            .map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes })),
        })),
      });
      if (!portable.success) throw new FederationError("INVALID_MESSAGE");
      const manifest = portable.data;
      const manifestDigest = federationMaterialDigest(manifest);
      if (existing) {
        if (
          federationCanonicalJson(existing.bindings) !== federationCanonicalJson(bindings) ||
          federationCanonicalJson(existing.manifest) !== federationCanonicalJson(manifest) ||
          existing.manifestDigest !== manifestDigest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return this.summary(existing);
      }
      const [created] = await tx
        .insert(federationWorkflowInputExports)
        .values({
          runId: lease.runId,
          pathHash,
          path,
          nodeId,
          localOrgId: actor.orgId,
          ownerId: actor.userId,
          intentDigest,
          manifest,
          manifestDigest,
          bindings,
        })
        .returning();
      if (!created) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.input.snapshot",
        target: created.id,
        diff: {
          after: {
            runId: lease.runId,
            manifestDigest,
            files: bindings.length,
            bytes: bindings.reduce((sum, file) => sum + file.sizeBytes, 0),
          },
        },
      });
      return this.summary(created);
    });
  }

  /** Local version recheck; this does not authenticate a peer or issue a download permit. */
  async resolve(tx: PgTransaction, actor: FederationActor, runId: string, exportId: string) {
    const run = await assertWorkflowDelegationOwner(tx, runId, actor);
    if (run.status !== "running") throw new FederationError("CANCELLATION_REQUESTED");
    await requireFederationCapability(tx, actor, "delegation.submit");
    const [saved] = await tx
      .select()
      .from(federationWorkflowInputExports)
      .where(
        and(
          eq(federationWorkflowInputExports.id, exportId),
          eq(federationWorkflowInputExports.runId, runId),
          eq(federationWorkflowInputExports.localOrgId, actor.orgId),
          eq(federationWorkflowInputExports.ownerId, actor.userId),
        ),
      )
      .for("share");
    if (!saved) throw new FederationError("POLICY_DENIED");
    const files = await ownedNetdriveFiles(
      tx,
      saved.bindings.map((file) => file.fileId),
      actor.userId,
      true,
    );
    for (const binding of saved.bindings) {
      const file = files.find((file) => file.id === binding.fileId);
      if (
        !file ||
        file.storageKey !== binding.storageKey ||
        file.storageVersionId !== binding.versionId ||
        file.sha256 !== binding.sha256 ||
        file.size !== binding.sizeBytes
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    if (
      !FederationInputFilesSchema.safeParse(saved.manifest).success ||
      federationMaterialDigest(saved.manifest) !== saved.manifestDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
    const selection = saved.manifest.inputs.map((input) => ({
      descriptor: input.descriptor,
      type: input.type,
      files: saved.bindings
        .filter((file) => file.descriptor === input.descriptor)
        .map(({ path, fileId }) => ({ path, fileId })),
    }));
    const manifest = {
      ...saved.manifest,
      inputs: saved.manifest.inputs.map((input) => ({
        ...input,
        files: saved.bindings
          .filter((file) => file.descriptor === input.descriptor)
          .map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes })),
      })),
    };
    if (
      selection.flatMap((input) => input.files).length !== saved.bindings.length ||
      federationMaterialDigest(selection) !== saved.intentDigest ||
      federationMaterialDigest(manifest) !== saved.manifestDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
    return saved;
  }

  private summary(row: Export) {
    return { exportId: row.id, manifestDigest: row.manifestDigest, manifest: row.manifest };
  }

  /** Internal scope check; peer authentication and bilateral signature checks belong to outbound. */
  async forDelegation(
    tx: PgTransaction,
    actor: FederationActor,
    request: FederationDelegation,
    terms: FederationAgreement,
  ) {
    if (!request.inputFilesDigest) return undefined;
    if (!terms.inputPolicy) throw new FederationError("POLICY_DENIED");
    const [binding] = await tx
      .select()
      .from(workflowExecutionDelegations)
      .where(
        and(
          eq(workflowExecutionDelegations.localSiteId, request.senderSiteId),
          eq(workflowExecutionDelegations.operationId, request.operationId),
        ),
      );
    if (!binding || federationCanonicalJson(binding.request) !== federationCanonicalJson(request))
      throw new FederationError("POLICY_DENIED");
    const [snapshot] = await tx
      .select({ id: federationWorkflowInputExports.id })
      .from(federationWorkflowInputExports)
      .where(
        and(
          eq(federationWorkflowInputExports.runId, binding.runId),
          eq(federationWorkflowInputExports.pathHash, binding.pathHash),
          eq(federationWorkflowInputExports.path, binding.path),
          eq(federationWorkflowInputExports.nodeId, binding.nodeId),
          eq(federationWorkflowInputExports.manifestDigest, request.inputFilesDigest),
        ),
      );
    if (!snapshot) throw new FederationError("POLICY_DENIED");
    const saved = await this.resolve(tx, actor, binding.runId, snapshot.id);
    const files = saved.manifest.inputs.flatMap((input) => input.files);
    if (
      files.length > terms.inputPolicy.maxFiles ||
      files.reduce((sum, file) => sum + file.sizeBytes, 0) > terms.inputPolicy.maxBytes
    )
      throw new FederationError("POLICY_DENIED");
    return saved;
  }
}
