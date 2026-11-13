import {
  federationAgreementApprovals,
  federationOutbound,
  federationResultAttempts,
  federationResultImports,
  federationResultTransfers,
  netdriveFiles,
  type PgDb,
} from "@kuintessence/db";
import {
  type NodeExecutionResult,
  type NodeInvocation,
  type usecase,
  WorkflowExecutionInterrupted,
  WorkflowNodeWaiting,
  type workflowDsl,
} from "@kuintessence/shared";
import {
  FederationAgreementSchema,
  FederationError,
  type FederationInputSelection,
  type FederationParameterOverrides,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import { FabricClientFailure } from "./fabric-client";
import type { FederationOutboundService } from "./outbound";
import { FederationDeliveryError } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";
import {
  assertWorkflowDelegationBinding,
  assertWorkflowDelegationOwner,
} from "./workflow-delegations";

type Node = Extract<workflowDsl.WorkflowNode, { type: "Federation" }>;

export class FederationWorkflowExecutor {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly outbound: FederationOutboundService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    actor: FederationActor,
    lease: LeasedWorkflowJournal,
    node: Node,
    invocation: NodeInvocation,
    parameters: FederationParameterOverrides = {},
    files?: FederationInputSelection,
  ): Promise<NodeExecutionResult> {
    let waitingReason: "DATA_WAITING" | "RESULT_WAITING" = "DATA_WAITING";
    try {
      const terms = await lease.transaction(async (tx) => {
        await assertWorkflowDelegationOwner(tx, lease.runId, actor);
        await requireFederationCapability(tx, actor, "delegation.submit");
        const [approval] = await tx
          .select()
          .from(federationAgreementApprovals)
          .where(
            and(
              eq(federationAgreementApprovals.localSiteId, this.siteId),
              eq(federationAgreementApprovals.localOrgId, actor.orgId),
              eq(federationAgreementApprovals.revisionId, node.agreementRevisionId),
            ),
          );
        if (!approval || approval.state !== "active" || !approval.counterpartyApprovalJws)
          throw new FederationError("AGREEMENT_UNAVAILABLE");
        return FederationAgreementSchema.parse(approval.terms);
      });
      const operation = await this.outbound.enqueueForWorkflow(
        actor,
        lease,
        node.id,
        invocation,
        {
          protocolVersion: 1,
          kind: "delegation",
          senderSiteId: this.siteId,
          recipientSiteId: terms.targetSiteId,
          agreementRevisionId: terms.agreementRevisionId,
          mode: terms.mode,
          budgetDomainId: terms.budgetDomainId,
          epoch: terms.epoch,
          unit: terms.unit,
          template: node.template,
          inputManifestDigest: node.inputManifestDigest,
          ...(node.inputDelivery ? { inputDelivery: node.inputDelivery } : {}),
          ...(node.resultDelivery ? { resultDelivery: node.resultDelivery } : {}),
          environmentLockDigest: node.environmentLockDigest,
          ...(node.arbitration ? { arbitration: node.arbitration } : {}),
          resources: node.resources,
          maxAmount: node.maxAmount,
          executionExpiresAt: node.executionExpiresAt ?? terms.validUntil,
        },
        node.admissionWindowSec,
        parameters,
        files,
        node.market,
      );
      const observed = await lease.transaction(async (tx) => {
        await requireFederationCapability(tx, actor, "delegation.read");
        await assertWorkflowDelegationBinding(
          tx,
          lease.runId,
          actor,
          this.siteId,
          operation.operationId,
        );
        const [row] = await tx
          .select()
          .from(federationOutbound)
          .where(
            and(
              eq(federationOutbound.localSiteId, this.siteId),
              eq(federationOutbound.operationId, operation.operationId),
            ),
          );
        if (!row) throw new FederationError("OPERATION_CONFLICT");
        if (row.statusReportJws)
          await new FederationTrustRegistry(this.db).assertKey(
            tx,
            row.request.recipientSiteId,
            federationMessageKeyId(row.statusReportJws),
            this.clock(),
          );
        return row;
      });
      if (observed.cancelState)
        return {
          status: "Failed",
          values: {},
          failure: { message: "Remote workflow was cancelled." },
        };
      const status = observed.statusReport?.workflow?.status;
      if (status === "failed")
        return { status: "Failed", values: {}, failure: { message: "Remote workflow failed." } };
      if (status === "cancelled")
        return {
          status: "Failed",
          values: {},
          failure: { message: "Remote workflow was cancelled." },
        };
      if (status !== "completed")
        throw new WorkflowNodeWaiting(
          observed.statusReport?.preparation?.state === "waiting"
            ? "DATA_WAITING"
            : "REMOTE_WAITING",
        );
      if (!node.outputs.length) return { status: "Succeeded", values: {} };
      waitingReason = "RESULT_WAITING";
      // The operation UUID is a stable import key; an existing identical manifest may deduplicate it.
      const imported = await this.outbound.resultImports.enqueue(
        actor,
        operation.operationId,
        operation.operationId,
        lease,
      );
      if (imported.state === "cancelled")
        return {
          status: "Failed",
          values: {},
          failure: { message: "Remote result import was cancelled." },
        };
      if (imported.state !== "available") throw new WorkflowNodeWaiting("RESULT_WAITING");
      return {
        status: "Succeeded",
        values: await this.files(actor, lease, operation.operationId, imported.id, node.outputs),
      };
    } catch (error) {
      if (error instanceof WorkflowNodeWaiting || error instanceof WorkflowExecutionInterrupted)
        throw error;
      if (error instanceof FabricClientFailure) {
        if (!error.needsReview) throw new WorkflowNodeWaiting("LEDGER_WAITING");
        return {
          status: "Failed",
          values: {},
          failure: { message: `Federation ledger requires review: ${error.code}` },
        };
      }
      if (error instanceof FederationError) {
        if (error.code === "STORAGE_PRESSURE") throw new WorkflowNodeWaiting("STORAGE_WAITING");
        if (error.code === "DATA_WAITING") throw new WorkflowNodeWaiting(waitingReason);
        return {
          status: "Failed",
          values: {},
          failure: { message: `Federation execution refused: ${error.code}` },
        };
      }
      if (error instanceof FederationDeliveryError) throw new WorkflowNodeWaiting("RESULT_WAITING");
      throw new WorkflowExecutionInterrupted("Federation workflow operation requires recovery", {
        cause: error,
      });
    }
  }

  private async files(
    actor: FederationActor,
    lease: LeasedWorkflowJournal,
    operationId: string,
    importId: string,
    outputs: Node["outputs"],
  ) {
    return lease.transaction(async (tx) => {
      await assertWorkflowDelegationBinding(tx, lease.runId, actor, this.siteId, operationId);
      await requireFederationCapability(tx, actor, "result.read");
      const [parent] = await tx
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, importId))
        .for("share");
      if (
        !parent ||
        parent.state !== "available" ||
        parent.requestedBy !== actor.userId ||
        parent.localOrgId !== actor.orgId ||
        parent.localSiteId !== this.siteId ||
        parent.operationId !== operationId
      )
        throw new FederationError("POLICY_DENIED");
      const members = await tx
        .select({
          member: federationResultTransfers,
          attempt: federationResultAttempts,
          file: netdriveFiles,
        })
        .from(federationResultTransfers)
        .innerJoin(
          federationResultAttempts,
          and(
            eq(federationResultAttempts.transferId, federationResultTransfers.id),
            eq(federationResultAttempts.state, "available"),
          ),
        )
        .innerJoin(netdriveFiles, eq(netdriveFiles.id, federationResultTransfers.id))
        .where(eq(federationResultTransfers.importId, importId));
      const values: Record<string, usecase.FileInputValue> = {};
      for (const output of outputs) {
        const matching = parent.report.manifest.outputs.filter(
          (item) =>
            item.nodeId === output.from.nodeId && item.descriptor === output.from.descriptor,
        );
        const selected = matching[0];
        if (matching.length !== 1 || !selected || selected.type !== output.type)
          throw new FederationError("OPERATION_CONFLICT");
        const files = selected.files.map((expected) => {
          const found = members.find(
            ({ member }) => member.outputId === selected.outputId && member.path === expected.path,
          );
          if (!found) throw new FederationError("POLICY_DENIED");
          const { file, member, attempt } = found;
          if (
            file.ownerId !== actor.userId ||
            file.deletedAt ||
            member.state !== "available" ||
            attempt.state !== "available" ||
            file.sha256 !== expected.sha256 ||
            member.sha256 !== expected.sha256 ||
            file.size !== expected.sizeBytes ||
            member.sizeBytes !== expected.sizeBytes ||
            !attempt.destinationVersionId ||
            file.storageVersionId !== attempt.destinationVersionId ||
            file.storageKey !== attempt.storageKey
          )
            throw new FederationError("POLICY_DENIED");
          return { fileMetadataId: file.id, fileMetadataName: expected.path };
        });
        if (output.type === "File") {
          if (files.length !== 1 || !files[0]) throw new FederationError("OPERATION_CONFLICT");
          values[output.descriptor] = files[0];
        } else values[output.descriptor] = files;
      }
      return values;
    });
  }
}
