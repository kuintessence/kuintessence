import { createHash, randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationTerminalChunks as chunks,
  federationCommercialAgreements as contracts,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationSites as sites,
  federationTerminalSyncs as syncs,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import {
  assertFederationReportIdentity,
  assertFederationStatusQueryFresh,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  CommercialReservationSchema,
  CommercialTerminalSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  TERMINAL_CHUNK_BYTES,
  TERMINAL_MAX_BYTES,
  TerminalAckSchema,
  TerminalChunkSchema,
  TerminalDeliverySchema,
  TerminalQuerySchema,
} from "@kuintessence/shared/federation/terminal-exchange";
import { FederationTerminalProposalSchema } from "@kuintessence/shared/federation/terminal-proposal";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Sync = typeof syncs.$inferSelect;
type Query = z.infer<typeof TerminalQuerySchema>;
type Delivery = z.infer<typeof TerminalDeliverySchema>;
class TerminalLeaseLost extends Error {}
const wireDigest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const syncKey = (site: string, id: string) =>
  and(eq(syncs.localSiteId, site), eq(syncs.reservationId, id));
const terminalKey = (site: string, id: string) =>
  and(eq(terminals.localSiteId, site), eq(terminals.reservationId, id));

/** Transport never approves a terminal: source approval remains a separate local business decision. */
export class FederationTerminalExchange {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private async scope(tx: PgTransaction, id: string, actor?: FederationActor, revisionId?: string) {
    if (actor) await requireFederationCapability(tx, actor, "agreement.read");
    const [row] = await tx
      .select({ approval: approvals, contract: contracts })
      .from(approvals)
      .innerJoin(
        contracts,
        and(
          eq(contracts.localSiteId, approvals.localSiteId),
          eq(contracts.revisionId, approvals.agreementRevisionId),
          eq(contracts.localOrgId, approvals.localOrgId),
        ),
      )
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.recordId, id),
          actor ? eq(approvals.localOrgId, actor.orgId) : undefined,
          revisionId ? eq(approvals.agreementRevisionId, revisionId) : undefined,
        ),
      )
      .for("share");
    if (!row?.approval.counterpartyJws || !row.contract.counterpartyJws)
      throw new FederationError("POLICY_DENIED");
    const reserve = CommercialReservationSchema.parse(row.approval.payload);
    const request = reserve.request;
    if (
      request.mode !== "ledger_coordinated" ||
      reserve.reservationId !== id ||
      wireDigest(reserve) !== row.approval.digest ||
      reserve.agreementDigest !== row.contract.digest ||
      reserve.domainId !== row.contract.terms.domainId ||
      request.agreementRevisionId !== row.contract.revisionId ||
      request.senderSiteId !== row.contract.terms.agreement.sourceSiteId ||
      request.recipientSiteId !== row.contract.terms.agreement.targetSiteId ||
      ![request.senderSiteId, request.recipientSiteId].includes(this.signing.siteId)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [terminal] = await tx
      .select()
      .from(terminals)
      .where(terminalKey(this.signing.siteId, id));
    return { ...row, reserve, request, terminal, requestDigest: wireDigest(request) };
  }
  private async inbound(
    tx: PgTransaction,
    q: Query | Delivery,
    fingerprint: string,
    keyId: string,
  ) {
    const scope = await this.scope(tx, q.reservationId);
    const request = scope.request;
    if (
      q.senderSiteId !== request.senderSiteId ||
      q.recipientSiteId !== request.recipientSiteId ||
      q.recipientSiteId !== this.signing.siteId ||
      q.agreementDigest !== scope.contract.digest ||
      q.operationId !== request.operationId ||
      q.taskId !== request.taskId ||
      q.attempt !== request.attempt ||
      q.agreementRevisionId !== request.agreementRevisionId ||
      q.requestDigest !== scope.requestDigest
    )
      throw new FederationError("POLICY_DENIED");
    assertFederationStatusQueryFresh(q, new Date());
    for (const site of [q.senderSiteId, this.signing.siteId].sort()) {
      if (site === q.senderSiteId)
        await this.trust.assertPeer(tx, fingerprint, site, keyId, new Date());
      else await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
    }
    const peer = await this.trust.resolveKey(q.senderSiteId, keyId, new Date(), tx);
    if (!peer.allowedKinds.includes(q.kind)) throw new FederationError("UNTRUSTED_IDENTITY");
    return scope;
  }
  private reply(q: Query | Delivery, digest: string) {
    return {
      protocolVersion: 1 as const,
      queryId: q.queryId,
      senderSiteId: this.signing.siteId,
      recipientSiteId: q.senderSiteId,
      operationId: q.operationId,
      agreementRevisionId: q.agreementRevisionId,
      taskId: q.taskId,
      attempt: q.attempt,
      reservationId: q.reservationId,
      requestDigest: q.requestDigest,
      agreementDigest: q.agreementDigest,
      queryDigest: digest,
      observedAt: new Date().toISOString(),
    };
  }
  async receiveQuery(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const { payload: q, digest } = await verifyFederationMessage(
      TerminalQuerySchema,
      jws,
      peer,
      new Date(),
    );
    if (peer.siteId !== q.senderSiteId) throw new FederationError("POLICY_DENIED");
    return this.db.transaction(async (tx) => {
      const scope = await this.inbound(tx, q, fingerprint, peer.keyId);
      let item: z.infer<typeof TerminalChunkSchema>["item"] = null;
      if (scope.terminal) {
        const terminal = scope.terminal;
        const proposal = FederationTerminalProposalSchema.parse({
          payload: terminal.payload,
          evidence: terminal.evidence,
          providerJws: terminal.approvalJws,
        });
        let bytes: Buffer;
        try {
          bytes = Buffer.from(federationCanonicalJson(proposal, TERMINAL_MAX_BYTES));
        } catch {
          throw new FederationError("INVALID_MESSAGE");
        }
        const proposalDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (
          bytes.length > TERMINAL_MAX_BYTES ||
          q.offset >= bytes.length ||
          (q.terminalId &&
            (q.terminalId !== terminal.terminalId || q.proposalDigest !== proposalDigest))
        )
          throw new FederationError("OPERATION_CONFLICT");
        item = {
          terminalId: terminal.terminalId,
          proposalDigest,
          offset: q.offset,
          totalBytes: bytes.length,
          bytes: bytes.subarray(q.offset, q.offset + TERMINAL_CHUNK_BYTES).toString("base64"),
        };
      } else if (q.terminalId || q.offset) throw new FederationError("OPERATION_CONFLICT");
      const response = TerminalChunkSchema.parse({
        ...this.reply(q, digest),
        kind: "terminal-chunk",
        item,
      });
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const signed = await signFederationMessage(TerminalChunkSchema, response, this.signing);
      await verifyFederationMessage(TerminalChunkSchema, signed, own, new Date());
      assertFederationStatusQueryFresh(q, new Date());
      return signed;
    });
  }
  async receiveDelivery(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const { payload: q, digest } = await verifyFederationMessage(
      TerminalDeliverySchema,
      jws,
      peer,
      new Date(),
    );
    if (peer.siteId !== q.senderSiteId) throw new FederationError("POLICY_DENIED");
    return this.db.transaction(async (tx) => {
      const scope = await this.inbound(tx, q, fingerprint, peer.keyId);
      const [terminal] = await tx
        .select()
        .from(terminals)
        .where(terminalKey(this.signing.siteId, q.reservationId))
        .for("update");
      if (
        !terminal ||
        terminal.terminalId !== q.terminalId ||
        terminal.digest !== q.terminalDigest ||
        terminal.payload.sourceSiteId !== q.senderSiteId ||
        terminal.payload.targetSiteId !== this.signing.siteId ||
        terminal.payload.reservationDigest !== scope.approval.digest ||
        Date.parse(q.reviewedAt) < Date.parse(terminal.payload.issuedAt) ||
        Date.parse(q.reviewedAt) > Date.now()
      )
        throw new FederationError("OPERATION_CONFLICT");
      const keyId = federationMessageKeyId(q.sourceJws);
      const at = new Date(q.reviewedAt);
      await this.trust.assertKey(tx, peer.siteId, keyId, at);
      const key = await this.trust.resolveKey(peer.siteId, keyId, at, tx);
      const verified = await verifyFederationMessage(
        CommercialTerminalSchema,
        q.sourceJws,
        key,
        at,
      );
      if (
        verified.digest !== terminal.digest ||
        federationMaterialDigest(verified.payload) !== federationMaterialDigest(terminal.payload) ||
        (terminal.counterpartyJws && terminal.counterpartyJws !== q.sourceJws)
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (!terminal.counterpartyJws) {
        await tx
          .update(terminals)
          .set({ counterpartyJws: q.sourceJws })
          .where(terminalKey(this.signing.siteId, q.reservationId));
        await tx.insert(auditLog).values({
          actor: terminal.authorizationPolicyId
            ? `terminal-policy:${terminal.authorizationPolicyId}`
            : terminal.approvedBy,
          orgId: scope.approval.localOrgId,
          action: "federation.execution.terminal_receive_signature",
          target: terminal.terminalId,
          diff: {
            after: {
              sourceSiteId: peer.siteId,
              digest: terminal.digest,
              reviewedAt: q.reviewedAt,
            },
          },
        });
      }
      const response = TerminalAckSchema.parse({
        ...this.reply(q, digest),
        kind: "terminal-ack",
        terminalId: terminal.terminalId,
        terminalDigest: terminal.digest,
      });
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const signed = await signFederationMessage(TerminalAckSchema, response, this.signing);
      await verifyFederationMessage(TerminalAckSchema, signed, own, new Date());
      assertFederationStatusQueryFresh(q, new Date());
      return signed;
    });
  }
  async discover() {
    if (!this.send) return;
    const rows = await this.db
      .select({ localSiteId: approvals.localSiteId, reservationId: approvals.recordId })
      .from(approvals)
      .innerJoin(
        outbound,
        and(
          eq(outbound.localSiteId, approvals.localSiteId),
          eq(outbound.localOrgId, approvals.localOrgId),
          sql`${outbound.operationId}::text = ${approvals.payload}->'request'->>'operationId'`,
        ),
      )
      .leftJoin(
        syncs,
        and(
          eq(syncs.localSiteId, approvals.localSiteId),
          eq(syncs.reservationId, approvals.recordId),
        ),
      )
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          isNotNull(approvals.counterpartyJws),
          eq(outbound.state, "accepted"),
          isNotNull(outbound.receipt),
          isNull(syncs.reservationId),
          sql`${approvals.payload}->'request'->>'mode' = 'ledger_coordinated'`,
          sql`${approvals.payload}->'request'->>'senderSiteId' = ${this.signing.siteId}`,
        ),
      )
      .orderBy(asc(approvals.recordId))
      .limit(8);
    if (rows.length) await this.db.insert(syncs).values(rows).onConflictDoNothing();
  }
  private async source(tx: PgTransaction, id: string) {
    const scope = await this.scope(tx, id);
    if (scope.request.senderSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const [sent] = await tx
      .select()
      .from(outbound)
      .where(
        and(
          eq(outbound.localSiteId, this.signing.siteId),
          eq(outbound.operationId, scope.request.operationId),
          eq(outbound.localOrgId, scope.approval.localOrgId),
        ),
      )
      .for("share");
    if (
      sent?.state !== "accepted" ||
      sent.receipt?.reservationId !== id ||
      sent.requestDigest !== scope.requestDigest ||
      federationMaterialDigest(sent.request) !== federationMaterialDigest(scope.request)
    )
      throw new FederationError("OPERATION_CONFLICT");
    for (const site of [this.signing.siteId, scope.request.recipientSiteId].sort()) {
      if (site === this.signing.siteId)
        await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      else {
        const [peer] = await tx.select().from(sites).where(eq(sites.id, site)).for("share");
        if (!peer || peer.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
        if (peer.endpoint !== sent.endpoint) throw new FederationError("OPERATION_CONFLICT");
      }
    }
    return { ...scope, endpoint: sent.endpoint };
  }
  private async lock(tx: PgTransaction, claim: Sync) {
    if (!claim.leaseToken) throw new TerminalLeaseLost();
    const [current] = await tx
      .select()
      .from(syncs)
      .where(
        and(
          syncKey(this.signing.siteId, claim.reservationId),
          eq(syncs.leaseToken, claim.leaseToken),
          sql`${syncs.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!current) throw new TerminalLeaseLost();
    return current;
  }
  private async advance(claim: Sync) {
    if (!this.send) return;
    const scope = await this.db.transaction((tx) => this.source(tx, claim.reservationId));
    const base = {
      protocolVersion: 1 as const,
      queryId: randomUUID(),
      senderSiteId: this.signing.siteId,
      recipientSiteId: scope.request.recipientSiteId,
      operationId: scope.request.operationId,
      agreementRevisionId: scope.request.agreementRevisionId,
      agreementDigest: scope.contract.digest,
      taskId: scope.request.taskId,
      attempt: scope.request.attempt,
      reservationId: claim.reservationId,
      requestDigest: scope.requestDigest,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const terminal = scope.terminal;
    if (
      terminal &&
      ((claim.terminalId && claim.terminalId !== terminal.terminalId) ||
        (claim.proposal &&
          (claim.proposal.providerJws !== terminal.counterpartyJws ||
            federationMaterialDigest(claim.proposal.payload) !==
              federationMaterialDigest(terminal.payload))))
    )
      throw new FederationError("OPERATION_CONFLICT");
    const query = terminal
      ? TerminalDeliverySchema.parse({
          ...base,
          kind: "terminal-delivery",
          terminalId: terminal.terminalId,
          terminalDigest: terminal.digest,
          sourceJws: terminal.approvalJws,
          reviewedAt: terminal.sourceReview?.reviewedAt,
        })
      : TerminalQuerySchema.parse({
          ...base,
          kind: "terminal-query",
          terminalId: claim.terminalId,
          proposalDigest: claim.proposalDigest,
          offset: claim.nextOffset,
        });
    const schema = z.union([TerminalQuerySchema, TerminalDeliverySchema]);
    const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date());
    const requestJws = await signFederationMessage(schema, query, this.signing);
    const { digest } = await verifyFederationMessage(schema, requestJws, own, new Date());
    await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      await this.source(tx, claim.reservationId);
      const current = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      if (!current.allowedKinds.includes(query.kind))
        throw new FederationError("UNTRUSTED_IDENTITY");
    });
    const responseJws = await this.send(
      scope.endpoint,
      requestJws,
      terminal ? "/federation/v1/terminal-signatures" : "/federation/v1/terminals",
    );
    const peer = await this.trust.resolveKey(
      query.recipientSiteId,
      federationMessageKeyId(responseJws),
      new Date(),
    );
    const { payload: response } = await verifyFederationMessage(
      z.union([TerminalChunkSchema, TerminalAckSchema]),
      responseJws,
      peer,
      new Date(),
    );
    await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, claim);
      const saved = await this.source(tx, claim.reservationId);
      await this.trust.assertKey(tx, peer.siteId, peer.keyId, new Date());
      const currentPeer = await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx);
      if (!currentPeer.allowedKinds.includes(response.kind))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const currentOwn = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      if (!currentOwn.allowedKinds.includes(query.kind))
        throw new FederationError("UNTRUSTED_IDENTITY");
      assertFederationReportIdentity(query, digest, response, new Date());
      if (
        response.agreementDigest !== query.agreementDigest ||
        saved.contract.digest !== scope.contract.digest ||
        current.nextOffset !== claim.nextOffset ||
        current.proposalDigest !== claim.proposalDigest
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (query.kind === "terminal-delivery") {
        if (
          response.kind !== "terminal-ack" ||
          response.terminalId !== terminal?.terminalId ||
          response.terminalDigest !== terminal.digest ||
          saved.terminal?.digest !== terminal.digest ||
          saved.terminal.approvalJws !== terminal.approvalJws
        )
          throw new FederationError("INVALID_MESSAGE");
        await tx
          .update(syncs)
          .set({
            state: "complete",
            ...(!current.proposal
              ? { terminalId: null, proposalDigest: null, totalBytes: null, nextOffset: 0 }
              : {}),
            acknowledgementJws: responseJws,
            verifiedAt: sql`clock_timestamp()`,
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
          })
          .where(syncKey(this.signing.siteId, claim.reservationId));
        await tx
          .delete(chunks)
          .where(
            and(
              eq(chunks.localSiteId, this.signing.siteId),
              eq(chunks.reservationId, claim.reservationId),
            ),
          );
        await tx.insert(auditLog).values({
          actor: terminal.authorizationPolicyId
            ? `terminal-policy:${terminal.authorizationPolicyId}`
            : terminal.approvedBy,
          orgId: saved.approval.localOrgId,
          action: "federation.execution.terminal_signature_ack",
          target: terminal.terminalId,
          diff: { after: { digest: terminal.digest, peerSiteId: peer.siteId } },
        });
        return;
      }
      if (response.kind !== "terminal-chunk") throw new FederationError("INVALID_MESSAGE");
      const item = response.item;
      if (!item) {
        if (claim.terminalId) throw new FederationError("OPERATION_CONFLICT");
        await tx
          .update(syncs)
          .set({
            nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
          })
          .where(syncKey(this.signing.siteId, claim.reservationId));
        return;
      }
      const bytes = Buffer.from(item.bytes, "base64");
      if (
        item.offset !== claim.nextOffset ||
        item.offset >= item.totalBytes ||
        bytes.toString("base64") !== item.bytes ||
        bytes.length !== Math.min(TERMINAL_CHUNK_BYTES, item.totalBytes - item.offset) ||
        (claim.terminalId &&
          (item.terminalId !== claim.terminalId ||
            item.proposalDigest !== claim.proposalDigest ||
            item.totalBytes !== claim.totalBytes))
      )
        throw new FederationError("INVALID_MESSAGE");
      await tx.insert(chunks).values({
        localSiteId: this.signing.siteId,
        reservationId: claim.reservationId,
        offset: item.offset,
        bytes: item.bytes,
      });
      const nextOffset = item.offset + bytes.length;
      let proposal: Sync["proposal"] = null;
      if (nextOffset === item.totalBytes) {
        const parts = await tx
          .select()
          .from(chunks)
          .where(
            and(
              eq(chunks.localSiteId, this.signing.siteId),
              eq(chunks.reservationId, claim.reservationId),
            ),
          )
          .orderBy(asc(chunks.offset));
        if (
          parts.length !== Math.ceil(item.totalBytes / TERMINAL_CHUNK_BYTES) ||
          parts.some((p, i) => p.offset !== i * TERMINAL_CHUNK_BYTES)
        )
          throw new FederationError("INVALID_MESSAGE");
        const data = Buffer.concat(parts.map((p) => Buffer.from(p.bytes, "base64")));
        if (
          data.length !== item.totalBytes ||
          `sha256:${createHash("sha256").update(data).digest("hex")}` !== item.proposalDigest
        )
          throw new FederationError("INVALID_MESSAGE");
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
        } catch {
          throw new FederationError("INVALID_MESSAGE");
        }
        try {
          if (federationCanonicalJson(raw, TERMINAL_MAX_BYTES) !== data.toString("utf8"))
            throw new Error("Noncanonical terminal");
        } catch {
          throw new FederationError("INVALID_MESSAGE");
        }
        proposal = FederationTerminalProposalSchema.parse(raw);
        const at = new Date(proposal.payload.issuedAt);
        await this.trust.assertKey(
          tx,
          peer.siteId,
          federationMessageKeyId(proposal.providerJws),
          at,
        );
        const historical = await this.trust.resolveKey(
          peer.siteId,
          federationMessageKeyId(proposal.providerJws),
          at,
          tx,
        );
        const verified = await verifyFederationMessage(
          CommercialTerminalSchema,
          proposal.providerJws,
          historical,
          at,
        );
        if (
          at > new Date() ||
          verified.digest !== wireDigest(proposal.payload) ||
          federationMaterialDigest(verified.payload) !==
            federationMaterialDigest(proposal.payload) ||
          proposal.payload.terminalId !== item.terminalId ||
          proposal.payload.reservationId !== claim.reservationId ||
          proposal.payload.reservationDigest !== saved.approval.digest ||
          proposal.payload.domainId !== saved.reserve.domainId ||
          proposal.payload.sourceSiteId !== this.signing.siteId ||
          proposal.payload.targetSiteId !== peer.siteId ||
          federationMaterialDigest(proposal.evidence, TERMINAL_MAX_BYTES) !==
            proposal.payload.executionEvidenceDigest
        )
          throw new FederationError("INVALID_MESSAGE");
        await tx
          .delete(chunks)
          .where(
            and(
              eq(chunks.localSiteId, this.signing.siteId),
              eq(chunks.reservationId, claim.reservationId),
            ),
          );
        await tx.insert(auditLog).values({
          actor: saved.approval.approvedBy,
          orgId: saved.approval.localOrgId,
          action: "federation.execution.terminal_receive_proposal",
          target: item.terminalId,
          diff: { after: { digest: verified.digest, proposalDigest: item.proposalDigest } },
        });
      }
      await tx
        .update(syncs)
        .set({
          terminalId: item.terminalId,
          proposalDigest: item.proposalDigest,
          totalBytes: item.totalBytes,
          nextOffset,
          proposal,
          state: proposal ? "ready" : "pending",
          verifiedAt: sql`clock_timestamp()`,
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp()`,
        })
        .where(syncKey(this.signing.siteId, claim.reservationId));
    });
  }
  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            sql`(${syncs.state} = 'pending' OR (${syncs.state} = 'ready' AND EXISTS (SELECT 1 FROM ${terminals} terminal
          WHERE terminal.local_site_id = ${syncs.localSiteId} AND terminal.reservation_id = ${syncs.reservationId} AND terminal.source_review IS NOT NULL)))`,
            sql`${syncs.nextAttemptAt} <= clock_timestamp()`,
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(syncs.nextAttemptAt), asc(syncs.reservationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      const [claimed] = await tx
        .update(syncs)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(syncKey(this.signing.siteId, row.reservationId))
        .returning();
      return claimed;
    });
    if (!claim?.leaseToken) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof TerminalLeaseLost) return true;
      await this.db
        .update(syncs)
        .set({
          state:
            error instanceof FederationError ||
            error instanceof z.ZodError ||
            (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE")
              ? "needs_review"
              : "pending",
          lastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "EXCHANGE_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            syncKey(this.signing.siteId, claim.reservationId),
            eq(syncs.leaseToken, claim.leaseToken),
          ),
        );
    }
    return true;
  }
  async get(actor: FederationActor, revisionId: string, reservationId: string) {
    return this.db.transaction(async (tx) => {
      await this.scope(tx, reservationId, actor, revisionId);
      const [row] = await tx
        .select({
          state: syncs.state,
          nextOffset: syncs.nextOffset,
          totalBytes: syncs.totalBytes,
          proposal: syncs.proposal,
          verifiedAt: syncs.verifiedAt,
          lastError: syncs.lastError,
          acknowledgementJws: syncs.acknowledgementJws,
        })
        .from(syncs)
        .where(syncKey(this.signing.siteId, reservationId));
      return { enabled: !!this.send, sync: row ?? null };
    });
  }
  async retry(actor: FederationActor, revisionId: string, reservationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await this.scope(tx, reservationId, actor, revisionId);
      if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
      const [row] = await tx
        .select()
        .from(syncs)
        .where(syncKey(this.signing.siteId, reservationId))
        .for("update");
      if (!row || row.state === "complete" || (row.leaseUntil && row.leaseUntil > new Date()))
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(syncs)
        .set({
          state: row.proposal ? "ready" : "pending",
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp()`,
        })
        .where(syncKey(this.signing.siteId, reservationId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.execution.terminal_exchange_retry",
        target: reservationId,
        diff: { after: { nextOffset: row.nextOffset } },
      });
    });
  }
}
