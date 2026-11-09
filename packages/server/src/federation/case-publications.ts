import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  type PgDb,
  type PgTransaction,
  federationCasePublications as publications,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CaseProposal,
  CaseProposalSchema,
  type CasePublication,
  CasePublicationDraftSchema,
  CasePublicationSchema,
  CaseRevocationSchema,
  type FabricCaseTrust,
  FabricCaseTrustSchema,
} from "@kuintessence/shared/federation/case-ledger";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import { CommercialDisclosurePolicySchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { parseFederationPublicKey } from "@kuintessence/shared/federation/signatures";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { FederationDisclosureService } from "./disclosure";
import { FederationDisclosurePolicyService } from "./disclosure-policy";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Durable storage consent is independently signed; reading a disclosure never enqueues publication. */
export class FederationCasePublicationService {
  private readonly trust: FederationTrustRegistry;
  private readonly disclosures: FederationDisclosureService;
  private readonly policies: FederationDisclosurePolicyService;
  private readonly ledger: FabricCaseTrust;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    ledger: FabricCaseTrust,
  ) {
    this.ledger = FabricCaseTrustSchema.parse(ledger);
    this.trust = new FederationTrustRegistry(db);
    this.disclosures = new FederationDisclosureService(db, signing);
    this.policies = new FederationDisclosurePolicyService(db, signing);
    if (!this.ledger.organizations.some((org) => org.siteId === signing.siteId))
      throw new Error("Unknown local case institution");
  }
  private key(actor: Pick<FederationActor, "orgId">, revisionId: string, publicationId: string) {
    return and(
      eq(publications.localSiteId, this.signing.siteId),
      eq(publications.localOrgId, actor.orgId),
      eq(publications.agreementRevisionId, revisionId),
      eq(publications.publicationId, publicationId),
    );
  }
  private async verify<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    const signed = await verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(siteId, keyId, new Date(), tx),
      new Date(),
    );
    const key = this.ledger.organizations
      .find((org) => org.siteId === siteId)
      ?.keys.find((key) => key.keyId === keyId);
    const purpose = this.ledger.keyPurposes.find(
      (value) => value.siteId === siteId && value.keyId === keyId,
    );
    if (!key || !purpose) throw new FederationError("UNTRUSTED_IDENTITY");
    await verifyFederationMessage(
      schema,
      jws,
      {
        siteId,
        keyId,
        publicKey: await parseFederationPublicKey(key.publicKeyPem),
        validFrom: new Date(key.validFrom),
        validUntil: new Date(key.validUntil),
        revoked: false,
        allowedKinds: purpose.kinds,
      },
      new Date(),
    );
    return signed;
  }
  private async original(
    tx: PgTransaction,
    actor: Pick<FederationActor, "orgId">,
    revisionId: string,
    grantId: string,
  ) {
    const record = await this.disclosures.exchangeRecord(tx, actor.orgId, revisionId, grantId);
    if (!record?.row.counterpartyJws) throw new FederationError("POLICY_DENIED");
    const { row: policy } = await this.policies.verified(
      tx,
      actor,
      revisionId,
      record.row.policyId,
    );
    if (!policy.counterpartyJws) throw new FederationError("POLICY_DENIED");
    for (const [site, jws] of [
      [this.signing.siteId, record.row.approvalJws],
      [record.other, record.row.counterpartyJws],
    ]) {
      if (!site || !jws) throw new FederationError("INVALID_MESSAGE");
      if (
        (await this.verify(tx, CommercialDisclosureSchema, jws, site)).digest !== record.row.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    for (const [site, jws] of [
      [this.signing.siteId, policy.approvalJws],
      [record.other, policy.counterpartyJws],
    ]) {
      if (!site || !jws) throw new FederationError("INVALID_MESSAGE");
      if (
        (await this.verify(tx, CommercialDisclosurePolicySchema, jws, site)).digest !==
        policy.digest
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    const g = record.row.payload.grant;
    return {
      record,
      policy,
      scope: {
        grantId: g.grantId,
        disclosureDigest: record.row.digest,
        caseId: g.caseId,
        policyId: policy.policyId,
        policyDigest: policy.digest,
        domainId: g.domainId,
        agreementRevisionId: revisionId,
        agreementDigest: policy.payload.agreementDigest,
        sourceSiteId: g.sourceSiteId,
        targetSiteId: g.targetSiteId,
        evidenceRecipientSiteId: g.recipientSiteId,
      },
    };
  }
  private async validate(
    tx: PgTransaction,
    actor: Pick<FederationActor, "orgId">,
    revisionId: string,
    value: CasePublication,
  ) {
    const original = await this.original(tx, actor, revisionId, value.scope.grantId);
    const domain = this.ledger.domains.find((domain) => domain.domainId === value.caseDomainId);
    if (
      !domain ||
      ![domain.sourceSiteId, domain.targetSiteId].includes(this.signing.siteId) ||
      domain.commercialDomainId !== original.scope.domainId ||
      domain.sourceSiteId !== original.scope.sourceSiteId ||
      domain.targetSiteId !== original.scope.targetSiteId ||
      domain.recipientSiteId !== original.scope.evidenceRecipientSiteId ||
      federationCanonicalJson(original.scope) !== federationCanonicalJson(value.scope)
    )
      throw new FederationError("POLICY_DENIED");
    const now = Date.now();
    if (
      Date.parse(value.issuedAt) > now ||
      Date.parse(value.validUntil) <= now ||
      Date.parse(value.validUntil) >
        Math.min(
          Date.parse(original.policy.payload.validUntil),
          Date.parse(original.record.row.payload.grant.validUntil),
        )
    )
      throw new FederationError("AUTHORIZATION_EXPIRED");
    return original;
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    raw: z.infer<typeof CasePublicationDraftSchema>,
  ) {
    const input = CasePublicationDraftSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "case.publish");
      const original = await this.original(tx, actor, revisionId, input.grantId);
      const value = CasePublicationSchema.parse({
        protocolVersion: 1,
        kind: "case-evidence-publication",
        publicationId: input.publicationId,
        caseDomainId: input.caseDomainId,
        scope: original.scope,
        issuedAt: new Date().toISOString(),
        validUntil: input.validUntil,
        salt: randomBytes(32).toString("hex"),
      });
      await this.validate(tx, actor, revisionId, value);
      return value;
    });
  }
  private async saved(tx: PgTransaction, row: typeof publications.$inferSelect, other: string) {
    const own = await this.verify(tx, CasePublicationSchema, row.approvalJws, this.signing.siteId);
    if (
      own.digest !== row.digest ||
      federationCanonicalJson(own.payload) !== federationCanonicalJson(row.payload) ||
      (row.counterpartyJws &&
        (await this.verify(tx, CasePublicationSchema, row.counterpartyJws, other)).digest !==
          row.digest)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  async approve(actor: FederationActor, revisionId: string, raw: CasePublication) {
    const value = CasePublicationSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "case.publish");
      const { record } = await this.validate(tx, actor, revisionId, value);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`case-publication:${this.signing.siteId}:${value.publicationId}`}, 0))`,
      );
      const [prior] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.localSiteId, this.signing.siteId),
            eq(publications.publicationId, value.publicationId),
          ),
        )
        .for("update");
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          prior.agreementRevisionId !== revisionId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (prior.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
        await this.saved(tx, prior, record.other);
        await this.validate(tx, actor, revisionId, value);
        return prior;
      }
      const jws = await signFederationMessage(CasePublicationSchema, value, this.signing);
      const signed = await this.verify(tx, CasePublicationSchema, jws, this.signing.siteId);
      await this.validate(tx, actor, revisionId, value);
      const [row] = await tx
        .insert(publications)
        .values({
          localSiteId: this.signing.siteId,
          publicationId: value.publicationId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          grantId: value.scope.grantId,
          caseId: value.scope.caseId,
          payload: value,
          digest: signed.digest,
          approvalJws: jws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.case_publication.approve",
        target: value.publicationId,
        diff: {
          after: {
            digest: signed.digest,
            caseDomainId: value.caseDomainId,
            grantId: value.scope.grantId,
          },
        },
      });
      return row;
    });
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    publicationId: string,
    jws: string,
  ) {
    return this.attach(revisionId, publicationId, jws, actor);
  }
  async exchangeRecord(
    tx: PgTransaction,
    orgId: string,
    revisionId: string,
    publicationId: string,
  ) {
    const actor = { orgId };
    const [scope] = await tx
      .select()
      .from(publications)
      .where(this.key(actor, revisionId, publicationId));
    if (!scope) return null;
    const { record } = await this.validate(tx, actor, revisionId, scope.payload);
    const [row] = await tx
      .select()
      .from(publications)
      .where(this.key(actor, revisionId, publicationId))
      .for("share");
    if (!row || row.digest !== scope.digest) throw new FederationError("OPERATION_CONFLICT");
    if (row.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
    await this.saved(tx, row, record.other);
    await this.validate(tx, actor, revisionId, row.payload);
    return { row, other: record.other };
  }
  async ledgerProposal(
    tx: PgTransaction,
    publicationId: string,
    operation: CaseProposal["operation"],
  ) {
    const [row] = await tx
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.localSiteId, this.signing.siteId),
          eq(publications.publicationId, publicationId),
        ),
      );
    if (!row) throw new FederationError("ASSET_UNAVAILABLE");
    if (operation === "revoke-case-publication") {
      const [current] = await tx
        .select()
        .from(publications)
        .where(this.key({ orgId: row.localOrgId }, row.agreementRevisionId, publicationId))
        .for("share");
      if (!current?.revocationJws || !current.revocationPayload)
        throw new FederationError("POLICY_DENIED");
      const signed = await this.verify(
        tx,
        CaseRevocationSchema,
        current.revocationJws,
        this.signing.siteId,
      );
      if (
        signed.payload.publicationId !== publicationId ||
        signed.payload.publicationDigest !== current.digest ||
        signed.payload.caseDomainId !== current.payload.caseDomainId ||
        signed.payload.issuerSiteId !== this.signing.siteId ||
        federationCanonicalJson(signed.payload) !==
          federationCanonicalJson(current.revocationPayload)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const domain = this.ledger.domains.find(
        (value) => value.domainId === signed.payload.caseDomainId,
      );
      if (
        !domain ||
        domain.commercialDomainId !== current.payload.scope.domainId ||
        domain.sourceSiteId !== current.payload.scope.sourceSiteId ||
        domain.targetSiteId !== current.payload.scope.targetSiteId ||
        domain.recipientSiteId !== current.payload.scope.evidenceRecipientSiteId ||
        ![domain.sourceSiteId, domain.targetSiteId].includes(this.signing.siteId)
      )
        throw new FederationError("POLICY_DENIED");
      if (Date.parse(signed.payload.issuedAt) > Date.now())
        throw new FederationError("AUTHORIZATION_EXPIRED");
      return CaseProposalSchema.parse({
        operation,
        domainId: signed.payload.caseDomainId,
        recordId: signed.payload.revocationId,
        digest: signed.digest,
        envelope: { issuerSiteId: this.signing.siteId, jws: current.revocationJws },
      });
    }
    const record = await this.exchangeRecord(
      tx,
      row.localOrgId,
      row.agreementRevisionId,
      publicationId,
    );
    if (!record?.row.counterpartyJws) throw new FederationError("POLICY_DENIED");
    const { policy, record: disclosure } = await this.original(
      tx,
      { orgId: row.localOrgId },
      row.agreementRevisionId,
      row.grantId,
    );
    if (Date.parse(record.row.payload.validUntil) <= Date.now())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    const { sourceSiteId, targetSiteId } = record.row.payload.scope;
    const pair = (own: string, other: string | null) => {
      if (!other) throw new FederationError("POLICY_DENIED");
      return {
        sourceSiteId,
        targetSiteId,
        sourceJws: this.signing.siteId === sourceSiteId ? own : other,
        targetJws: this.signing.siteId === targetSiteId ? own : other,
      };
    };
    return CaseProposalSchema.parse({
      operation,
      domainId: record.row.payload.caseDomainId,
      recordId: publicationId,
      digest: record.row.digest,
      envelope: {
        publication: pair(record.row.approvalJws, record.row.counterpartyJws),
        evidence: {
          policy: pair(policy.approvalJws, policy.counterpartyJws),
          disclosure: pair(disclosure.row.approvalJws, disclosure.row.counterpartyJws),
        },
      },
    });
  }
  async attachExchanged(
    revisionId: string,
    publicationId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.attach(revisionId, publicationId, jws, undefined, authorize);
  }
  private async attach(
    revisionId: string,
    publicationId: string,
    jws: string,
    human?: FederationActor,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (human) await requireFederationCapability(tx, human, "case.publish");
      const [scope] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.localSiteId, this.signing.siteId),
            eq(publications.publicationId, publicationId),
            eq(publications.agreementRevisionId, revisionId),
            human ? eq(publications.localOrgId, human.orgId) : undefined,
          ),
        );
      if (!scope) throw new FederationError("POLICY_DENIED");
      const actor = { orgId: scope.localOrgId };
      const { record } = await this.validate(tx, actor, revisionId, scope.payload);
      const [row] = await tx
        .select()
        .from(publications)
        .where(this.key(actor, revisionId, publicationId))
        .for("update");
      if (!row || row.digest !== scope.digest) throw new FederationError("OPERATION_CONFLICT");
      if (row.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
      await this.saved(tx, row, record.other);
      if ((await this.verify(tx, CasePublicationSchema, jws, record.other)).digest !== row.digest)
        throw new FederationError("OPERATION_CONFLICT");
      await this.validate(tx, actor, revisionId, row.payload);
      await authorize?.(tx);
      if (row.counterpartyJws) {
        if (row.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return row;
      }
      const [saved] = await tx
        .update(publications)
        .set({ counterpartyJws: jws, confirmedAt: new Date() })
        .where(this.key(actor, revisionId, publicationId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: human ? human.userId : `case-publication-exchange:${this.signing.siteId}`,
        orgId: actor.orgId,
        action: "federation.case_publication.confirm",
        target: publicationId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  async revoke(actor: FederationActor, revisionId: string, publicationId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "case.publish");
      const [row] = await tx
        .select()
        .from(publications)
        .where(this.key(actor, revisionId, publicationId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) return row;
      // Revocation remains possible after disclosure closure/expiry; only the new revocation signer must be current.
      const payload = CaseRevocationSchema.parse({
        protocolVersion: 1,
        kind: "case-publication-revocation",
        revocationId: randomUUID(),
        caseDomainId: row.payload.caseDomainId,
        publicationId,
        publicationDigest: row.digest,
        issuerSiteId: this.signing.siteId,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const jws = await signFederationMessage(CaseRevocationSchema, payload, this.signing);
      await this.verify(tx, CaseRevocationSchema, jws, this.signing.siteId);
      const [saved] = await tx
        .update(publications)
        .set({
          revokedAt: new Date(),
          revokedBy: actor.userId,
          revocationPayload: payload,
          revocationJws: jws,
        })
        .where(this.key(actor, revisionId, publicationId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.case_publication.revoke",
        target: publicationId,
        diff: { after: { digest: row.digest, revocationId: payload.revocationId } },
      });
      return saved;
    });
  }
  async list(
    actor: FederationActor,
    revisionId: string,
    limit = 50,
    offset = 0,
    filter: { caseId?: string; publicationId?: string } = {},
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "case.publish");
      const rows = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.localSiteId, this.signing.siteId),
            eq(publications.localOrgId, actor.orgId),
            eq(publications.agreementRevisionId, revisionId),
            filter.caseId ? eq(publications.caseId, filter.caseId) : undefined,
            filter.publicationId ? eq(publications.publicationId, filter.publicationId) : undefined,
          ),
        )
        .orderBy(desc(publications.createdAt), desc(publications.publicationId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
