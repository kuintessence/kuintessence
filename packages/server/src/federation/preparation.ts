import {
  federationAgreements,
  federationPreparations,
  federationReservations,
  type PgDb,
} from "@kuintessence/db";
import { AppError } from "@kuintessence/shared";
import {
  assertDelegationPolicy,
  FederationAgreementSchema,
  FederationDelegationSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import type { FederationAssetService } from "./assets";
import { requireExecutionIdentity } from "./execution-identity";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Durable reference readiness only. This record is never a permit to dispatch a Job. */
export class FederationPreparationService {
  constructor(
    private readonly db: PgDb,
    readonly localSiteId: string,
    private readonly assets: FederationAssetService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async prepare(reservationId: string) {
    const [saved] = await this.db
      .select({ reservation: federationReservations, agreement: federationAgreements })
      .from(federationReservations)
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
      )
      .where(eq(federationReservations.id, reservationId));
    if (!saved || saved.agreement.targetSiteId !== this.localSiteId)
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    try {
      if (saved.reservation.state !== "reserved" || !saved.reservation.receiptJws)
        throw new FederationError("AGREEMENT_UNAVAILABLE");
      const trust = new FederationTrustRegistry(this.db);
      const key = await trust.resolveKey(
        saved.agreement.sourceSiteId,
        federationMessageKeyId(saved.reservation.requestJws),
        this.clock(),
      );
      const verified = await verifyFederationMessage(
        FederationDelegationSchema,
        saved.reservation.requestJws,
        key,
        this.clock(),
      );
      const request = verified.payload;
      if (
        verified.digest !== saved.reservation.requestDigest ||
        request.recipientSiteId !== this.localSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      const identity = {
        orgId: saved.agreement.localOrgId,
        userId: saved.agreement.executionUserId,
      };
      const material = await this.db.transaction(async (tx) => {
        await trust.assertKey(tx, key.siteId, key.keyId, this.clock());
        await requireExecutionIdentity(tx, identity);
        const [current] = await tx
          .select()
          .from(federationAgreements)
          .where(eq(federationAgreements.revisionId, saved.agreement.revisionId))
          .for("share");
        if (!current || current.state !== "active")
          throw new FederationError("AGREEMENT_UNAVAILABLE");
        assertDelegationPolicy(
          FederationAgreementSchema.parse(current.terms),
          request,
          this.clock(),
        );
        const inputs = await this.assets.readMaterial(
          tx,
          identity.orgId,
          request.senderSiteId,
          request.inputManifestDigest,
        );
        const environment = await this.assets.readMaterial(
          tx,
          identity.orgId,
          request.senderSiteId,
          request.environmentLockDigest,
        );
        if (inputs.kind !== "inputs" || environment.kind !== "environment-lock")
          throw new FederationError("INVALID_MESSAGE");
        return { inputs, environment };
      });
      const references = [
        request.template,
        ...material.inputs.bindings.map((v) => v.asset),
        ...material.inputs.datasets.map((v) => v.asset),
        ...material.environment.software.map((v) => v.asset),
      ];
      const unique = new Map(
        references.map((ref) => [
          JSON.stringify([ref.originSiteId, ref.kind, ref.id, ref.revision]),
          ref,
        ]),
      );
      // Conflicting references must not be collapsed by de-duplication.
      for (const reference of references) {
        const matching = unique.get(
          JSON.stringify([
            reference.originSiteId,
            reference.kind,
            reference.id,
            reference.revision,
          ]),
        );
        if (matching?.digest !== reference.digest) throw new FederationError("OPERATION_CONFLICT");
      }
      const mappings = [];
      for (const reference of unique.values()) {
        const resolved = await this.assets.resolve(identity, reference);
        mappings.push({
          reference,
          mappingId: resolved.mapping.id,
          localRevisionId:
            resolved.local.kind === "dataset"
              ? resolved.local.version.id
              : resolved.local.revision.id,
        });
      }
      return this.store(reservationId, "resolved", null, mappings);
    } catch (error) {
      if (error instanceof FederationError)
        return this.store(
          reservationId,
          error.code === "DATA_WAITING" || error.code === "ASSET_UNAVAILABLE"
            ? "waiting"
            : "blocked",
          error.code,
          [],
        );
      if (error instanceof AppError && error.statusCode === 403)
        return this.store(reservationId, "blocked", "POLICY_DENIED", []);
      throw error;
    }
  }

  private async store(
    reservationId: string,
    state: "resolved" | "waiting" | "blocked",
    blocker: string | null,
    mappings: typeof federationPreparations.$inferInsert.mappings,
  ) {
    const values = { state, blocker, mappings, updatedAt: this.clock() };
    const [row] = await this.db
      .insert(federationPreparations)
      .values({ reservationId, ...values })
      .onConflictDoUpdate({ target: federationPreparations.reservationId, set: values })
      .returning();
    if (!row) throw new Error("Preparation update returned no row");
    return row;
  }
}
