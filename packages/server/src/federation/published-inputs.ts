import {
  federationInputAttempts,
  federationInputImports,
  federationInputTransfers,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationError,
  FederationInputFilesSchema,
  type FederationReceivedInputFiles,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import { and, eq, inArray } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { ownedNetdriveFiles } from "./netdrive-inputs";
import type { FederationExecutionPreparation } from "./preparation";

/** Caller holds the original material scope; publication and cancellation cannot cross this snapshot. */
export async function readFederationPublishedInputs(
  tx: PgTransaction,
  scope: Pick<FederationExecutionPreparation, "saved" | "request" | "identity">,
): Promise<FederationReceivedInputFiles | undefined> {
  if (!scope.request.inputFilesDigest) return undefined;
  const [inventory] = await tx
    .select()
    .from(federationInputImports)
    .where(eq(federationInputImports.reservationId, scope.saved.reservation.id))
    .for("share");
  if (!inventory) throw new FederationError("DATA_WAITING");
  if (
    inventory.localSiteId !== scope.request.recipientSiteId ||
    inventory.ownerId !== scope.identity.userId ||
    inventory.localOrgId !== scope.identity.orgId ||
    inventory.manifestDigest !== scope.request.inputFilesDigest ||
    !FederationInputFilesSchema.safeParse(inventory.manifest).success ||
    federationMaterialDigest(inventory.manifest) !== inventory.manifestDigest ||
    inventory.expiresAt.getTime() !== federationExecutionDeadline(scope.request)
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (["cancelling", "cancelled"].includes(inventory.state))
    throw new FederationError("CANCELLATION_REQUESTED");
  if (inventory.state !== "available") throw new FederationError("DATA_WAITING");
  if (!inventory.publishedAt || inventory.reservedBytes !== 0)
    throw new FederationError("OPERATION_CONFLICT");
  const members = await tx
    .select()
    .from(federationInputTransfers)
    .where(eq(federationInputTransfers.importId, inventory.id))
    .orderBy(federationInputTransfers.id)
    .for("share");
  const attempts = members.length
    ? await tx
        .select()
        .from(federationInputAttempts)
        .where(
          and(
            inArray(
              federationInputAttempts.transferId,
              members.map((member) => member.id),
            ),
            eq(federationInputAttempts.state, "available"),
          ),
        )
        .orderBy(federationInputAttempts.generation)
        .for("share")
    : [];
  const count = inventory.manifest.inputs.reduce((sum, input) => sum + input.files.length, 0);
  if (count !== members.length || count !== attempts.length)
    throw new FederationError("OPERATION_CONFLICT");
  const files = await ownedNetdriveFiles(
    tx,
    members.map((member) => member.id),
    scope.identity.userId,
    true,
  );
  return {
    importId: inventory.id,
    manifestDigest: inventory.manifestDigest,
    inputs: inventory.manifest.inputs.map((input) => ({
      descriptor: input.descriptor,
      type: input.type,
      files: input.files.map((expected) => {
        const member = members.find(
          (member) => member.descriptor === input.descriptor && member.path === expected.path,
        );
        const attempt = attempts.find((attempt) => attempt.transferId === member?.id);
        const file = files.find((file) => file.id === member?.id);
        if (
          !member ||
          member.state !== "available" ||
          member.sizeBytes !== expected.sizeBytes ||
          member.sha256 !== expected.sha256 ||
          !attempt?.verifiedAt ||
          !attempt.destinationVersionId ||
          attempt.destinationVersionId === "null" ||
          !attempt.destinationEtag ||
          attempt.storageKey !== `federation-inputs/${inventory.id}/${attempt.generation}` ||
          !file ||
          file.path !== `federation-inputs/${inventory.id}/${input.descriptor}/${expected.path}` ||
          file.storageKey !== attempt.storageKey ||
          file.storageVersionId !== attempt.destinationVersionId ||
          file.etag !== attempt.destinationEtag ||
          file.sha256 !== expected.sha256 ||
          file.size !== expected.sizeBytes
        )
          throw new FederationError("OPERATION_CONFLICT");
        return {
          ...expected,
          fileId: file.id,
          generation: attempt.generation,
          storageKey: file.storageKey,
          versionId: attempt.destinationVersionId,
          etag: attempt.destinationEtag,
        };
      }),
    })),
  };
}
