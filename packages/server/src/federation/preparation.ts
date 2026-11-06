import {
  federationAgreements,
  federationPreparations,
  federationReservations,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { AppError } from "@kuintessence/shared";
import {
  assertDelegationPolicy,
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  type FederationAssetRef,
  type FederationDelegation,
  FederationDelegationSchema,
  type FederationEnvironmentLock,
  FederationError,
  type FederationInputManifest,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import { type FederationAssetService, federationMaterialDigest } from "./assets";
import { type ExecutionIdentity, requireExecutionIdentity } from "./execution-identity";
import { type FederationWorkflowProjection, materializeFederationWorkflow } from "./materialize";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

export interface FederationExecutionPreparation {
  saved: {
    reservation: typeof federationReservations.$inferSelect;
    agreement: typeof federationAgreements.$inferSelect;
  };
  request: FederationDelegation;
  identity: ExecutionIdentity;
  material: { inputs: FederationInputManifest; environment: FederationEnvironmentLock };
  references: Map<string, FederationAssetRef>;
  projection: FederationWorkflowProjection;
  mappings: typeof federationPreparations.$inferSelect.mappings;
}

/** Durable reference readiness only. This record is never a permit to dispatch a Job. */
export class FederationPreparationService {
  constructor(
    private readonly db: PgDb,
    readonly localSiteId: string,
    private readonly assets: FederationAssetService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async prepare(reservationId: string) {
    const reservation = await this.loadReservation(reservationId);
    try {
      const { references, identity } = await this.resolveReservation(reservation);
      const mappings = [];
      for (const reference of references.values()) {
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

  /** Read-only conversion for review; never creates a run or changes reservation state. */
  async plan(actor: FederationActor, reservationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await requireFederationCapability(tx, actor, "asset.read");
      const [row] = await tx
        .select({ id: federationReservations.id })
        .from(federationReservations)
        .innerJoin(
          federationAgreements,
          eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
        )
        .where(
          and(
            eq(federationReservations.id, reservationId),
            eq(federationAgreements.localOrgId, actor.orgId),
          ),
        )
        .for("share", { of: [federationReservations, federationAgreements] });
      if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    });
    const snapshot = await this.executionSnapshot(reservationId, actor);
    const { request, projection } = snapshot;
    return {
      ...projection,
      executionReady: false as const,
      reservationId,
      template: request.template,
      inputManifestDigest: request.inputManifestDigest,
      environmentLockDigest: request.environmentLockDigest,
    };
  }

  /** Internal immutable preparation input; it grants no dispatch authority. */
  async executionSnapshot(
    reservationId: string,
    reviewer?: FederationActor,
  ): Promise<FederationExecutionPreparation> {
    const saved = await this.loadReservation(reservationId);
    const resolved = await this.resolveReservation(saved);
    const local = new Map<string, Awaited<ReturnType<FederationAssetService["resolve"]>>>();
    for (const reference of resolved.references.values()) {
      local.set(
        federationCanonicalJson(reference),
        await this.assets.resolve(resolved.identity, reference),
      );
      if (reviewer) await this.assets.assertView(reviewer, reference);
    }
    const projection = await materializeFederationWorkflow({
      template: resolved.request.template,
      ...resolved.material,
      resolve: async (reference) => {
        const snapshot = local.get(federationCanonicalJson(reference));
        if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
        return snapshot;
      },
    });
    const mappings = [...resolved.references.values()].map((reference) => {
      const snapshot = local.get(federationCanonicalJson(reference));
      if (!snapshot) throw new FederationError("ASSET_UNAVAILABLE");
      return {
        reference,
        mappingId: snapshot.mapping.id,
        localRevisionId:
          snapshot.local.kind === "dataset"
            ? snapshot.local.version.id
            : snapshot.local.revision.id,
      };
    });
    return { ...resolved, saved, projection, mappings };
  }

  /** Recheck after external policy resolution, while the caller atomically binds the run. */
  async lockExecutionSnapshot(tx: PgTransaction, snapshot: FederationExecutionPreparation) {
    const { saved, request, identity } = snapshot;
    const trust = new FederationTrustRegistry(this.db);
    await trust.assertKey(
      tx,
      saved.agreement.sourceSiteId,
      federationMessageKeyId(saved.reservation.requestJws),
      this.clock(),
    );
    await requireExecutionIdentity(tx, identity);
    const [agreement] = await tx
      .select()
      .from(federationAgreements)
      .where(eq(federationAgreements.revisionId, saved.agreement.revisionId))
      .for("share");
    const [reservation] = await tx
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.id, saved.reservation.id))
      .for("update");
    if (
      !agreement ||
      agreement.state !== "active" ||
      !reservation ||
      reservation.state !== "reserved" ||
      !reservation.receiptJws
    )
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    if (
      agreement.localOrgId !== identity.orgId ||
      agreement.executionUserId !== identity.userId ||
      agreement.targetSiteId !== this.localSiteId ||
      agreement.sourceSiteId !== request.senderSiteId ||
      federationMaterialDigest(agreement.terms) !==
        federationMaterialDigest(saved.agreement.terms) ||
      reservation.agreementRevisionId !== agreement.revisionId ||
      reservation.requestDigest !== saved.reservation.requestDigest ||
      reservation.requestJws !== saved.reservation.requestJws ||
      reservation.receiptJws !== saved.reservation.receiptJws ||
      federationCanonicalJson(reservation.receipt) !==
        federationCanonicalJson(saved.reservation.receipt) ||
      reservation.amount !== saved.reservation.amount ||
      reservation.senderSiteId !== request.senderSiteId ||
      reservation.operationId !== request.operationId ||
      reservation.taskId !== request.taskId ||
      reservation.attempt !== request.attempt
    )
      throw new FederationError("OPERATION_CONFLICT");
    for (const mapping of snapshot.mappings) {
      const current = await this.assets.assertResolved(
        tx,
        identity,
        mapping.reference,
        mapping.mappingId,
      );
      if (
        (current.local.kind === "dataset"
          ? current.local.version.id
          : current.local.revision.id) !== mapping.localRevisionId
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    // These rows also stay locked through the binding commit.
    await this.assets.readMaterial(
      tx,
      identity.orgId,
      request.senderSiteId,
      request.inputManifestDigest,
    );
    await this.assets.readMaterial(
      tx,
      identity.orgId,
      request.senderSiteId,
      request.environmentLockDigest,
    );
    assertDelegationPolicy(
      FederationAgreementSchema.parse(agreement.terms),
      request,
      this.clock(),
      "execution",
    );
    await trust.assertKey(
      tx,
      saved.agreement.sourceSiteId,
      federationMessageKeyId(reservation.requestJws),
      this.clock(),
    );
    await trust.assertKey(
      tx,
      this.localSiteId,
      federationMessageKeyId(reservation.receiptJws),
      this.clock(),
    );
  }

  private async loadReservation(reservationId: string) {
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
    return saved;
  }

  private async resolveReservation(
    saved: Awaited<ReturnType<FederationPreparationService["loadReservation"]>>,
  ) {
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
      request.recipientSiteId !== this.localSiteId ||
      request.agreementRevisionId !== saved.reservation.agreementRevisionId ||
      request.senderSiteId !== saved.reservation.senderSiteId ||
      request.operationId !== saved.reservation.operationId ||
      request.taskId !== saved.reservation.taskId ||
      request.attempt !== saved.reservation.attempt
    )
      throw new FederationError("OPERATION_CONFLICT");
    const receiptKey = await trust.resolveKey(
      this.localSiteId,
      federationMessageKeyId(saved.reservation.receiptJws),
      this.clock(),
    );
    const receipt = (
      await verifyFederationMessage(
        FederationAcceptanceSchema,
        saved.reservation.receiptJws,
        receiptKey,
        this.clock(),
      )
    ).payload;
    if (
      federationCanonicalJson(receipt) !== federationCanonicalJson(saved.reservation.receipt) ||
      receipt.reservationId !== saved.reservation.id ||
      receipt.requestDigest !== verified.digest ||
      receipt.senderSiteId !== this.localSiteId ||
      receipt.recipientSiteId !== request.senderSiteId ||
      receipt.operationId !== request.operationId ||
      receipt.agreementRevisionId !== request.agreementRevisionId ||
      receipt.taskId !== request.taskId ||
      receipt.attempt !== request.attempt ||
      receipt.mode !== request.mode ||
      receipt.budgetDomainId !== request.budgetDomainId ||
      receipt.epoch !== request.epoch ||
      receipt.unit !== request.unit ||
      receipt.reservedAmount !== request.maxAmount ||
      receipt.reservedAmount !== saved.reservation.amount ||
      Date.parse(receipt.acceptedAt) < Date.parse(request.issuedAt) - 60000 ||
      Date.parse(receipt.acceptedAt) >= Date.parse(request.expiresAt)
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
        "execution",
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
        JSON.stringify([reference.originSiteId, reference.kind, reference.id, reference.revision]),
      );
      if (matching?.digest !== reference.digest) throw new FederationError("OPERATION_CONFLICT");
    }
    return { request, identity, material, references: unique };
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
