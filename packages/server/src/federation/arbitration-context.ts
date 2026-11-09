import { randomUUID } from "node:crypto";
import {
  federationEvidenceCases as cases,
  federationSites,
  federationArbitrationRevocationNotices as notices,
  type PgDb,
  type PgTransaction,
  federationCommercialPayments as payments,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  ArbitrationContextQuerySchema,
  ArbitrationContextSchema,
  ArbitrationContextViewSchema,
  type ArbitrationEvidenceReferenceSchema,
  ArbitrationFinancialContextSchema,
  ArbitrationFinancialViewSchema,
  assertArbitrationContext,
} from "@kuintessence/shared/federation/arbitration-context";
import { CommercialArbitrationPolicySchema } from "@kuintessence/shared/federation/arbitration-policy";
import { CommercialBillSchema } from "@kuintessence/shared/federation/commercial";
import { CommercialEvidenceCaseInputSchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { CommercialDisputeFreezeSchema } from "@kuintessence/shared/federation/disputes";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import { FederationDisputeService } from "./disputes";
import type { FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

export class FederationArbitrationContextResponder {
  private readonly trust: FederationTrustRegistry;
  private readonly disputes: FederationDisputeService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.disputes = new FederationDisputeService(db, signing);
  }
  private async financial(
    tx: PgTransaction,
    caseId: string,
    policy: z.infer<typeof CommercialArbitrationPolicySchema>,
  ) {
    const freeze = await new FederationDisputeFreezeExchange(
      this.db,
      this.signing,
    ).arbitrationSnapshot(tx, caseId);
    if (!freeze) return null;
    const refs: z.infer<typeof ArbitrationEvidenceReferenceSchema>[] = [];
    const needed = new Set<string>(policy.disclosures.map((e) => e.recordType));
    const { record } = freeze.current;
    const add = (ref: z.infer<typeof ArbitrationEvidenceReferenceSchema>) => {
      if (
        needed.has(ref.recordType) &&
        !refs.some(
          (r) =>
            r.recordType === ref.recordType &&
            r.recordId === ref.recordId &&
            r.recordDigest === ref.recordDigest,
        )
      )
        refs.push(ref);
    };
    add({
      recordType: "agreement",
      recordId: record.agreementRevisionId,
      recordDigest: record.payload.agreementDigest,
    });
    add(record.payload.subject);
    for (const ref of freeze.financial.records) {
      if (ref.recordType !== "refund")
        add({ recordType: ref.recordType, recordId: ref.recordId, recordDigest: ref.recordDigest });
      if (ref.recordType !== "bill") continue;
      if (needed.has("usage")) {
        const original = await this.disputes.disclosureOriginal(
          tx,
          { orgId: record.localOrgId },
          record.agreementRevisionId,
          { caseId, recordType: "bill", recordId: ref.recordId, recordDigest: ref.recordDigest },
        );
        const bill = CommercialBillSchema.parse(original.payload);
        const usage = {
          recordType: "usage" as const,
          recordId: bill.reportId,
          recordDigest: bill.reportDigest,
        };
        await this.disputes.disclosureOriginal(
          tx,
          { orgId: record.localOrgId },
          record.agreementRevisionId,
          { caseId, ...usage },
        );
        add(usage);
      }
      if (needed.has("payment")) {
        const rows = await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.localSiteId, this.signing.siteId),
              eq(payments.localOrgId, record.localOrgId),
              eq(payments.agreementRevisionId, record.agreementRevisionId),
              eq(payments.billId, ref.recordId),
            ),
          );
        for (const row of rows) {
          if (!row.counterpartyJws) continue;
          const payment = {
            recordType: "payment" as const,
            recordId: row.receiptId,
            recordDigest: row.digest,
          };
          await this.disputes.disclosureOriginal(
            tx,
            { orgId: record.localOrgId },
            record.agreementRevisionId,
            { caseId, ...payment },
          );
          add(payment);
        }
      }
    }
    refs.sort((a, b) =>
      `${a.recordType}:${a.recordId}`.localeCompare(`${b.recordType}:${b.recordId}`),
    );
    return ArbitrationFinancialContextSchema.parse({
      ...freeze.financial,
      evidenceReferences: refs,
    });
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const verified = await verifyFederationMessage(
      ArbitrationContextQuerySchema,
      jws,
      peer,
      new Date(),
    );
    const query = verified.payload;
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    assertFederationStatusQueryFresh(query, new Date());
    return this.db.transaction(async (tx) => {
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      const currentPeer = await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx);
      await verifyFederationMessage(ArbitrationContextQuerySchema, jws, currentPeer, new Date());
      const snapshot = await this.disputes.arbitrationSnapshot(tx, query.scope.caseId);
      const { binding, sourceJws, targetJws, policy, subject } = snapshot;
      // The original admission selects R. Site registration alone gives no access to this policy.
      if (binding.arbitratorSiteId !== peer.siteId) throw new FederationError("POLICY_DENIED");
      const financial = await this.financial(tx, query.scope.caseId, policy);
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      let until = Math.min(
        Date.parse(query.expiresAt),
        Date.parse(policy.validUntil),
        own.validUntil.getTime(),
        currentPeer.validUntil.getTime(),
      );
      for (const [siteId, original] of [
        [policy.sourceSiteId, sourceJws],
        [policy.targetSiteId, targetJws],
        ...(financial
          ? ([
              [policy.sourceSiteId, financial.sourceJws],
              [policy.targetSiteId, financial.targetJws],
            ] as const)
          : []),
      ] as const) {
        const key = await this.trust.resolveKey(
          siteId,
          federationMessageKeyId(original),
          new Date(),
          tx,
        );
        until = Math.min(until, key.validUntil.getTime());
      }
      const now = new Date();
      if (until <= now.getTime()) throw new FederationError("AUTHORIZATION_EXPIRED");
      const response = ArbitrationContextSchema.parse({
        ...query,
        kind: "arbitration-context",
        senderSiteId: this.signing.siteId,
        recipientSiteId: peer.siteId,
        queryDigest: verified.digest,
        binding,
        subject,
        financial,
        sourceJws,
        targetJws,
        issuedAt: now.toISOString(),
        expiresAt: new Date(Math.min(until, now.getTime() + 30000)).toISOString(),
      });
      assertArbitrationContext(query, verified.digest, response, now);
      const signed = await signFederationMessage(ArbitrationContextSchema, response, this.signing);
      await verifyFederationMessage(ArbitrationContextSchema, signed, own, new Date());
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      assertArbitrationContext(query, verified.digest, response, new Date());
      return signed;
    });
  }
}

export class FederationArbitrationContextService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async visible(tx: PgTransaction, actor: FederationActor, caseId: string) {
    await requireFederationCapability(tx, actor, "arbitration.read");
    const [row] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.localOrgId, actor.orgId),
          eq(cases.caseId, caseId),
        ),
      )
      .for("share");
    if (!row || row.closedAt) throw new FederationError("POLICY_DENIED");
    const scope = CommercialEvidenceCaseInputSchema.parse(row.context);
    if (scope.caseId !== caseId || scope.evidenceRecipientSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    return scope;
  }
  private async endpoint(tx: PgTransaction, siteId: string) {
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId))
      .for("share");
    if (site?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    return site.endpoint;
  }
  async read(actor: FederationActor, caseId: string) {
    const proof = await this.prepare(actor, caseId);
    return this.db.transaction((tx) => this.verify(tx, actor, caseId, proof));
  }
  async prepare(actor: FederationActor, caseId: string) {
    const send = this.send;
    if (!send) throw new FederationError("ASSET_UNAVAILABLE");
    const prepared = await this.db.transaction(async (tx) => {
      const scope = await this.visible(tx, actor, caseId);
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const readId = randomUUID(),
        requests = [];
      for (const siteId of [scope.sourceSiteId, scope.targetSiteId]) {
        const endpoint = await this.endpoint(tx, siteId),
          now = new Date();
        const query = ArbitrationContextQuerySchema.parse({
          protocolVersion: 1,
          kind: "arbitration-context-query",
          readId,
          queryId: randomUUID(),
          senderSiteId: this.signing.siteId,
          recipientSiteId: siteId,
          scope,
          issuedAt: now.toISOString(),
          expiresAt: new Date(
            Math.min(now.getTime() + 30000, own.validUntil.getTime()),
          ).toISOString(),
        });
        const jws = await signFederationMessage(ArbitrationContextQuerySchema, query, this.signing);
        const signed = await verifyFederationMessage(
          ArbitrationContextQuerySchema,
          jws,
          own,
          new Date(),
        );
        requests.push({ query, digest: signed.digest, jws, endpoint });
      }
      return { scope, readId, requests };
    });
    // Never hold a database transaction while either institution is offline.
    const received = await Promise.allSettled(
      prepared.requests.map(async (request) => ({
        ...request,
        responseJws: await send(
          request.endpoint,
          request.jws,
          "/federation/v1/arbitration-contexts",
        ),
      })),
    );
    const responses = received.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return { ...prepared, responses };
  }
  async verify(
    tx: PgTransaction,
    actor: FederationActor,
    caseId: string,
    prepared: Awaited<ReturnType<FederationArbitrationContextService["prepare"]>>,
  ) {
    const responses = prepared.responses;
    const scope = await this.visible(tx, actor, caseId);
    if (federationCanonicalJson(scope) !== federationCanonicalJson(prepared.scope))
      throw new FederationError("POLICY_DENIED");
    const results = [];
    for (const response of responses) {
      const query = response.query;
      if ((await this.endpoint(tx, query.recipientSiteId)) !== response.endpoint)
        throw new FederationError("UNTRUSTED_IDENTITY");
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      await verifyFederationMessage(ArbitrationContextQuerySchema, response.jws, own, new Date());
      const keyId = federationMessageKeyId(response.responseJws);
      await this.trust.assertKey(tx, query.recipientSiteId, keyId, new Date());
      const key = await this.trust.resolveKey(query.recipientSiteId, keyId, new Date(), tx);
      const signed = await verifyFederationMessage(
        ArbitrationContextSchema,
        response.responseJws,
        key,
        new Date(),
      );
      const context = signed.payload;
      assertArbitrationContext(query, response.digest, context, new Date());
      let until = Math.min(own.validUntil.getTime(), key.validUntil.getTime());
      const policies = [];
      for (const [siteId, jws] of [
        [scope.sourceSiteId, context.sourceJws],
        [scope.targetSiteId, context.targetJws],
      ] as const) {
        const policyKeyId = federationMessageKeyId(jws);
        await this.trust.assertKey(tx, siteId, policyKeyId, new Date());
        const policyKey = await this.trust.resolveKey(siteId, policyKeyId, new Date(), tx);
        const policy = await verifyFederationMessage(
          CommercialArbitrationPolicySchema,
          jws,
          policyKey,
          new Date(),
        );
        const p = policy.payload,
          b = context.binding;
        if (
          policy.digest !== b.policyDigest ||
          p.arbitratorSiteId !== this.signing.siteId ||
          p.unit !== b.unit ||
          !p.subjectTypes.includes(context.subject.recordType) ||
          (
            [
              "policyId",
              "domainId",
              "agreementRevisionId",
              "agreementDigest",
              "sourceSiteId",
              "targetSiteId",
            ] as const
          ).some((k) => p[k] !== b[k])
        )
          throw new FederationError("POLICY_DENIED");
        if (Date.parse(p.validFrom) > Date.now())
          throw new FederationError("AUTHORIZATION_EXPIRED");
        until = Math.min(until, policyKey.validUntil.getTime(), Date.parse(p.validUntil));
        policies.push(p);
      }
      if (federationCanonicalJson(policies[0]) !== federationCanonicalJson(policies[1]))
        throw new FederationError("POLICY_DENIED");
      if (Date.parse(context.expiresAt) > until) throw new FederationError("AUTHORIZATION_EXPIRED");
      const financial = context.financial;
      if (financial) {
        const b = context.binding;
        const expectedHead = federationMaterialDigest({
          caseId: b.caseId,
          caseDigest: b.caseDigest,
          agreementRevisionId: b.agreementRevisionId,
          taskId: b.taskId,
          attempt: b.attempt,
          mode: b.mode,
          records: financial.records,
        });
        if (
          financial.records.some((r) => r.state !== "ready") ||
          expectedHead !== financial.headDigest ||
          (b.mode === "ledger_coordinated"
            ? financial.ledgerReceipt?.recordId !== b.caseId ||
              financial.ledgerReceipt.digest !== financial.freezeDigest
            : financial.ledgerReceipt !== null)
        )
          throw new FederationError("POLICY_DENIED");
        for (const [siteId, jws] of [
          [scope.sourceSiteId, financial.sourceJws],
          [scope.targetSiteId, financial.targetJws],
        ] as const) {
          const kid = federationMessageKeyId(jws);
          await this.trust.assertKey(tx, siteId, kid, new Date());
          const freezeKey = await this.trust.resolveKey(siteId, kid, new Date(), tx);
          const freeze = await verifyFederationMessage(
            CommercialDisputeFreezeSchema,
            jws,
            freezeKey,
            new Date(),
          );
          if (
            Date.parse(freeze.payload.issuedAt) > Date.now() + 60000 ||
            freeze.digest !== financial.freezeDigest ||
            freeze.payload.headDigest !== expectedHead ||
            (
              [
                "caseId",
                "caseDigest",
                "agreementRevisionId",
                "taskId",
                "attempt",
                "mode",
                "sourceSiteId",
                "targetSiteId",
              ] as const
            ).some((k) => freeze.payload[k] !== b[k])
          )
            throw new FederationError("POLICY_DENIED");
          if (Date.parse(context.expiresAt) > freezeKey.validUntil.getTime())
            throw new FederationError("AUTHORIZATION_EXPIRED");
        }
      }
      results.push({ query, digest: response.digest, context, policy: policies[0] });
    }
    const [source, target] = results;
    if (!source || !target || !source.policy) throw new FederationError("POLICY_DENIED");
    const { observedAt: sourceAt, ...sourceBinding } = source.context.binding;
    const { observedAt: targetAt, ...targetBinding } = target.context.binding;
    if (
      federationCanonicalJson(sourceBinding) !== federationCanonicalJson(targetBinding) ||
      source.context.sourceJws !== target.context.sourceJws ||
      source.context.targetJws !== target.context.targetJws ||
      federationCanonicalJson(source.context.subject) !==
        federationCanonicalJson(target.context.subject) ||
      federationCanonicalJson(source.context.financial) !==
        federationCanonicalJson(target.context.financial)
    )
      throw new FederationError("OPERATION_CONFLICT");
    // Serialize the final observation with R's incoming withdrawal, including an absent policy row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-policy:${this.signing.siteId}:${source.context.binding.policyId}`}, 0))`,
    );
    const [notice] = await tx
      .select({ id: notices.noticeId })
      .from(notices)
      .where(
        and(
          eq(notices.localSiteId, this.signing.siteId),
          eq(notices.policyId, source.context.binding.policyId),
          eq(notices.policyDigest, source.context.binding.policyDigest),
        ),
      )
      .limit(1);
    if (notice) throw new FederationError("AUTHORIZATION_EXPIRED");
    for (const result of results)
      assertArbitrationContext(result.query, result.digest, result.context, new Date());
    return ArbitrationContextViewSchema.parse({
      readId: prepared.readId,
      binding: source.context.binding,
      policy: source.policy,
      subject: source.context.subject,
      financial: source.context.financial
        ? ArbitrationFinancialViewSchema.parse({
            headDigest: source.context.financial.headDigest,
            freezeDigest: source.context.financial.freezeDigest,
            records: source.context.financial.records,
            evidenceReferences: source.context.financial.evidenceReferences,
            ledgerReceipt: source.context.financial.ledgerReceipt,
          })
        : null,
      observations: [
        { siteId: scope.sourceSiteId, observedAt: sourceAt },
        { siteId: scope.targetSiteId, observedAt: targetAt },
      ],
      expiresAt: new Date(
        Math.min(...results.map((r) => Date.parse(r.context.expiresAt))),
      ).toISOString(),
    });
  }
}
