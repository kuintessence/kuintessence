import { agents, type PgDb, type PgTransaction } from "@kuintessence/db";
import {
  FederationError,
  type FederationMediaManifest,
  FederationMediaManifestSchema,
  FederationMediaObjectBindingSchema,
  type FederationTaskMediaExportApproval,
  FederationTaskMediaExportApprovalSchema,
  type FederationTaskMediaSource,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import type { FederationOutboundService } from "./outbound";
import { type FederationActor, requireFederationCapability } from "./permissions";
import type { FederationResultResponder } from "./results";

export type TaskMediaSnapshot = {
  subject: FederationMediaManifest["subject"];
  files: FederationMediaManifest["files"];
  source: FederationTaskMediaSource;
  validUntil: number;
  authorizedUntil: number;
};
export type TaskMediaReader = (tx: PgTransaction) => Promise<TaskMediaSnapshot>;

/** Uses the original workflow owner and result release policy; media operators cannot choose private files. */
export class FederationTaskMediaSources {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly outbound: FederationOutboundService,
    private readonly results: FederationResultResponder,
  ) {}

  private async operator(tx: PgTransaction, actor: FederationActor, agentId: string) {
    await requireFederationCapability(tx, actor, "media.export");
    const [agent] = await tx
      .select({ id: agents.agentId })
      .from(agents)
      .where(and(eq(agents.agentId, agentId), eq(agents.providerOrgId, actor.orgId)))
      .for("share");
    if (!agent) throw new FederationError("POLICY_DENIED");
  }

  async authorize(
    actor: FederationActor,
    input: FederationTaskMediaExportApproval,
  ): Promise<TaskMediaReader> {
    input = FederationTaskMediaExportApprovalSchema.parse(input);
    await this.db.transaction((tx) => this.operator(tx, actor, input.agentId));
    const readInput =
      input.kind === "task-input"
        ? await this.outbound.mediaInputs(actor, input.operationId)
        : undefined;
    return async (tx) => {
      await this.operator(tx, actor, input.agentId);
      let subject: TaskMediaSnapshot["subject"], validUntil: number, authorizedUntil: number;
      const objects: FederationTaskMediaSource["objects"] = [];
      if (readInput) {
        const snapshot = await readInput(tx),
          request = snapshot.request;
        if (
          request.senderSiteId !== this.siteId ||
          request.recipientSiteId !== input.recipientSiteId ||
          request.agreementRevisionId !== input.agreementRevisionId ||
          request.operationId !== input.operationId
        )
          throw new FederationError("POLICY_DENIED");
        subject = {
          kind: "task-input",
          operationId: request.operationId,
          taskId: request.taskId,
          attempt: request.attempt,
          requestDigest: snapshot.requestDigest,
          contentDigest: snapshot.contentDigest,
        };
        for (const member of snapshot.manifest.inputs)
          for (const file of member.files) {
            const binding = snapshot.bindings.find(
              (row) => row.descriptor === member.descriptor && row.path === file.path,
            );
            if (!binding || binding.sha256 !== file.sha256 || binding.sizeBytes !== file.sizeBytes)
              throw new FederationError("OPERATION_CONFLICT");
            objects.push({
              fileId: binding.fileId,
              storageKey: binding.storageKey,
              versionId: binding.versionId,
              path: objectPath(objects.length),
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
            });
          }
        validUntil = snapshot.validUntil;
        authorizedUntil = snapshot.authorizedUntil;
      } else {
        const snapshot = await this.results.mediaResults(tx, actor, input);
        subject = {
          kind: "task-result",
          operationId: snapshot.operationId,
          taskId: snapshot.taskId,
          attempt: snapshot.attempt,
          requestDigest: snapshot.requestDigest,
          contentDigest: federationMaterialDigest(snapshot.manifest),
        };
        for (const member of snapshot.manifest.outputs)
          for (const file of member.files) {
            const binding = snapshot.sources.get(`${member.outputId}/${file.path}`);
            if (
              !binding?.storageKey ||
              !binding.storageVersionId ||
              binding.storageVersionId === "null"
            )
              throw new FederationError("ASSET_UNAVAILABLE");
            objects.push({
              fileId: binding.id,
              storageKey: binding.storageKey,
              versionId: binding.storageVersionId,
              path: objectPath(objects.length),
              sha256: file.sha256,
              sizeBytes: file.sizeBytes,
            });
          }
        validUntil = Date.parse(snapshot.manifest.availableUntil);
        authorizedUntil = snapshot.authorizedUntil;
      }
      if (
        !objects.length ||
        objects.some(
          (file) =>
            !FederationMediaObjectBindingSchema.shape.versionId.safeParse(file.versionId).success,
        )
      )
        throw new FederationError("ASSET_UNAVAILABLE");
      // Netdrive members currently have no license/provenance columns; missing metadata is explicit.
      const files = FederationMediaManifestSchema.shape.files.parse(
        objects.map(({ path, sizeBytes, sha256 }) => ({
          path,
          sizeBytes,
          sha256,
          license: null,
          provenance: null,
        })),
      );
      return {
        subject,
        files,
        source: { agentId: input.agentId, objects },
        validUntil,
        authorizedUntil,
      };
    };
  }
}
function objectPath(index: number) {
  return `objects/${index.toString().padStart(6, "0")}`;
}
