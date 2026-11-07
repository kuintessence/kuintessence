import { federationSites, type PgDb, type PgTransaction } from "@kuintessence/db";
import {
  assertFederationReportIdentity,
  FederationDataOriginSchema,
  FederationError,
  type FederationInputCopyBinding,
  FederationInputDownloadGrantSchema,
  FederationInputDownloadQuerySchema,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { signedDownloadExpiry } from "./download-credential";
import type { FederationInputTransfers } from "./input-transfers";
import type { FederationSend } from "./outbound-client";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Verifies a source credential against the accepted task and the receiver's currently active copy. */
export class FederationInputReader {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly transfers: FederationInputTransfers,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async downloadGrant(
    agentId: string,
    input: FederationInputCopyBinding,
    allowedOrigins: readonly string[],
  ) {
    const current = await this.transfers.copyAuthorization(agentId, input);
    const { scope, binding } = current;
    const { request, saved } = scope;
    if (request.recipientSiteId !== this.signing.siteId) throw new FederationError("POLICY_DENIED");
    const origins = new Set(
      allowedOrigins.map((value) => new URL(FederationDataOriginSchema.parse(value)).origin),
    );
    if (!origins.size) throw new FederationError("POLICY_DENIED");
    const [source] = await this.db
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, request.senderSiteId));
    if (!source || source.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    const authorize = async (tx: PgTransaction, peerKeyId?: string) => {
      const copy = await current.authorize(tx);
      const [site] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, source.id))
        .for("share");
      if (!site || site.state !== "active" || site.endpoint !== source.endpoint)
        throw new FederationError("UNTRUSTED_IDENTITY");
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, this.clock());
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        this.clock(),
        tx,
      );
      if (!own.allowedKinds.includes("input-download-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      let keyDeadline = own.validUntil.getTime();
      if (peerKeyId) {
        await this.trust.assertKey(tx, source.id, peerKeyId, this.clock());
        const peer = await this.trust.resolveKey(source.id, peerKeyId, this.clock(), tx);
        if (!peer.allowedKinds.includes("input-download-grant"))
          throw new FederationError("UNTRUSTED_IDENTITY");
        keyDeadline = Math.min(keyDeadline, peer.validUntil.getTime());
      }
      return { ...copy, own, deadline: Math.min(copy.leaseUntil.getTime(), keyDeadline) };
    };
    const before = await this.db.transaction((tx) => authorize(tx));
    const query = FederationInputDownloadQuerySchema.parse({
      protocolVersion: 1,
      kind: "input-download-query",
      queryId: crypto.randomUUID(),
      senderSiteId: this.signing.siteId,
      recipientSiteId: source.id,
      operationId: request.operationId,
      agreementRevisionId: request.agreementRevisionId,
      taskId: request.taskId,
      attempt: request.attempt,
      reservationId: saved.reservation.id,
      requestDigest: saved.reservation.requestDigest,
      binding,
      issuedAt: this.clock().toISOString(),
      expiresAt: new Date(Math.min(this.clock().getTime() + 30_000, before.deadline)).toISOString(),
    });
    const jws = await signFederationMessage(
      FederationInputDownloadQuerySchema,
      query,
      this.signing,
    );
    const verified = await verifyFederationMessage(
      FederationInputDownloadQuerySchema,
      jws,
      before.own,
      this.clock(),
    );
    await this.db.transaction(async (tx) => {
      const after = await authorize(tx);
      if (
        Date.parse(query.expiresAt) > after.deadline ||
        Date.parse(query.expiresAt) <= this.clock().getTime()
      )
        throw new FederationError("AUTHORIZATION_EXPIRED");
    });
    let response: string;
    try {
      response = await this.send(source.endpoint, jws, "/federation/v1/input-downloads");
    } catch {
      throw new FederationError("DATA_WAITING");
    }
    const peerKeyId = federationMessageKeyId(response);
    const peer = await this.trust.resolveKey(source.id, peerKeyId, this.clock());
    const { payload: grant } = await verifyFederationMessage(
      FederationInputDownloadGrantSchema,
      response,
      peer,
      this.clock(),
    );
    const validate = (deadline: number) => {
      assertFederationReportIdentity(query, verified.digest, grant, this.clock());
      const expires = Date.parse(grant.expiresAt),
        url = new URL(grant.url);
      const version = url.searchParams.get("versionId");
      if (
        federationMaterialDigest(grant.binding) !== federationMaterialDigest(binding) ||
        !origins.has(url.origin) ||
        url.searchParams.getAll("versionId").length !== 1 ||
        !version ||
        version === "null" ||
        expires > Date.parse(grant.observedAt) + 30_000 ||
        signedDownloadExpiry(
          grant.url,
          this.clock().getTime(),
          Math.min(deadline, Date.parse(query.expiresAt), this.clock().getTime() + 30_000),
        ) !== grant.expiresAt
      )
        throw new FederationError("INVALID_MESSAGE");
    };
    validate(Math.min(before.deadline, peer.validUntil.getTime()));
    const after = await this.db.transaction(async (tx) => {
      const after = await authorize(tx, peerKeyId);
      if (after.storageKey !== before.storageKey || after.uploadId !== before.uploadId)
        throw new FederationError("OPERATION_CONFLICT");
      validate(after.deadline);
      return after;
    });
    // Only the active Agent path receives this bearer URL; never persist the grant or its JWS.
    return {
      grant: {
        binding,
        direction: "download" as const,
        url: grant.url,
        expiresAt: grant.expiresAt,
      },
      leaseExpiresAt: after.leaseUntil.toISOString(),
    };
  }
}
