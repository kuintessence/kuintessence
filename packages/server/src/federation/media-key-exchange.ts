import {
  auditLog,
  federationMediaKeyGrants,
  federationSites,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationError,
  FederationMediaKeyGrantSchema,
  type FederationMediaKeyQuery,
  FederationMediaKeyQuerySchema,
  type FederationMediaRecipientKey,
} from "@kuintessence/shared/federation";
import { and, eq, sql } from "drizzle-orm";
import type { FederationMediaExportService } from "./media-exports";
import type { FederationMediaPackageService } from "./media-packages";
import type { FederationSend } from "./outbound-client";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

export class FederationMediaKeyResponder {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly exports: FederationMediaExportService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async respond(jws: string, fingerprint: string): Promise<string> {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      this.clock(),
    );
    const verified = await verifyFederationMessage(
      FederationMediaKeyQuerySchema,
      jws,
      peer,
      this.clock(),
    );
    const query = verified.payload;
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    return this.db.transaction(async (tx) => {
      // All retries of a query ID preserve its original Agent key and original response.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`media-key:${this.signing.siteId}:${query.queryId}`}, 0))`,
      );
      assertFederationStatusQueryFresh(query, this.clock());
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, this.clock());
      const currentPeer = await this.trust.resolveKey(peer.siteId, peer.keyId, this.clock(), tx);
      if (!currentPeer.allowedKinds.includes("media-key-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const source = await this.exports.keyScope(tx, query);
      const [existing] = await tx
        .select()
        .from(federationMediaKeyGrants)
        .where(
          and(
            eq(federationMediaKeyGrants.localSiteId, this.signing.siteId),
            eq(federationMediaKeyGrants.queryId, query.queryId),
          ),
        );
      if (existing) {
        if (existing.queryDigest !== verified.digest || existing.packageId !== query.packageId)
          throw new FederationError("OPERATION_CONFLICT");
        if (existing.expiresAt <= this.clock()) throw new FederationError("AUTHORIZATION_EXPIRED");
        await this.signingAuthority(tx, federationMessageKeyId(existing.responseJws));
        return existing.responseJws;
      }
      await this.signingAuthority(tx, this.signing.keyId);
      const now = this.clock();
      const expiresAt = new Date(
        Math.min(Date.parse(query.expiresAt), source.expiresAt.getTime(), now.getTime() + 60_000),
      );
      if (expiresAt <= now) throw new FederationError("AUTHORIZATION_EXPIRED");
      const encryptedIdentity = await this.exports.sealIdentity(source, query, verified.digest);
      const responseJws = await signFederationMessage(
        FederationMediaKeyGrantSchema,
        {
          protocolVersion: 1,
          kind: "media-key-grant",
          queryId: query.queryId,
          senderSiteId: this.signing.siteId,
          recipientSiteId: peer.siteId,
          packageId: query.packageId,
          agreementRevisionId: query.agreementRevisionId,
          manifestDigest: query.manifestDigest,
          authorizationId: query.authorizationId,
          agentId: query.agentId,
          managedRootId: query.managedRootId,
          queryDigest: verified.digest,
          issuedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          encryptedIdentity,
        },
        this.signing,
      );
      assertFederationStatusQueryFresh(
        { issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() },
        this.clock(),
      );
      await tx.insert(federationMediaKeyGrants).values({
        localSiteId: this.signing.siteId,
        queryId: query.queryId,
        packageId: query.packageId,
        queryDigest: verified.digest,
        responseJws,
        createdAt: now,
        expiresAt,
      });
      await tx.insert(auditLog).values({
        actor: source.approvedBy,
        orgId: source.localOrgId,
        action: "federation.media.key_issue",
        target: query.queryId,
        diff: {
          after: {
            packageId: query.packageId,
            recipientSiteId: peer.siteId,
            queryDigest: verified.digest,
            authorizationId: query.authorizationId,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
      return responseJws;
    });
  }

  private async signingAuthority(tx: PgTransaction, keyId: string) {
    await this.trust.assertKey(tx, this.signing.siteId, keyId, this.clock());
    const key = await this.trust.resolveKey(this.signing.siteId, keyId, this.clock(), tx);
    if (!key.allowedKinds.includes("media-key-grant"))
      throw new FederationError("UNTRUSTED_IDENTITY");
  }
}

/** Internal Agent-operation transport; no human/API route returns a key response. */
export class FederationMediaKeyRequester {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly packages: FederationMediaPackageService,
    private readonly send: FederationSend,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async request(input: {
    orgId: string;
    packageId: string;
    authorizationId: string;
    authenticatedAgentId: string;
    recipientKey: FederationMediaRecipientKey;
  }) {
    const current = (tx: PgTransaction) =>
      this.packages.assertImportAuthorized(tx, input.orgId, input.packageId, input.authorizationId);
    const prepared = await this.db.transaction(async (tx) => {
      const scope = await current(tx);
      if (scope.authorization.agentId !== input.authenticatedAgentId)
        throw new FederationError("POLICY_DENIED");
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, this.clock());
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        this.clock(),
        tx,
      );
      if (!own.allowedKinds.includes("media-key-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const now = this.clock();
      const query = FederationMediaKeyQuerySchema.parse({
        protocolVersion: 1,
        kind: "media-key-query",
        queryId: crypto.randomUUID(),
        senderSiteId: this.signing.siteId,
        recipientSiteId: scope.package.senderSiteId,
        packageId: input.packageId,
        agreementRevisionId: scope.package.agreementRevisionId,
        manifestDigest: scope.package.manifestDigest,
        authorizationId: input.authorizationId,
        agentId: input.authenticatedAgentId,
        managedRootId: scope.authorization.managedRootId,
        recipientKey: input.recipientKey,
        maxBytes: scope.authorization.maxBytes,
        authorizationExpiresAt: scope.authorization.expiresAt.toISOString(),
        issuedAt: now.toISOString(),
        expiresAt: new Date(
          Math.min(now.getTime() + 60_000, scope.authorization.expiresAt.getTime()),
        ).toISOString(),
      });
      const [site] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, scope.package.senderSiteId))
        .for("share");
      if (!site || site.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      const jws = await signFederationMessage(FederationMediaKeyQuerySchema, query, this.signing);
      const verified = await verifyFederationMessage(
        FederationMediaKeyQuerySchema,
        jws,
        own,
        this.clock(),
      );
      return { query, jws, digest: verified.digest, endpoint: site.endpoint };
    });
    const responseJws = await this.send(
      prepared.endpoint,
      prepared.jws,
      "/federation/v1/media-keys",
    );
    return this.db.transaction(async (tx) => {
      const scope = await current(tx);
      if (
        scope.authorization.agentId !== input.authenticatedAgentId ||
        scope.authorization.managedRootId !== prepared.query.managedRootId ||
        scope.package.manifestDigest !== prepared.query.manifestDigest
      )
        throw new FederationError("POLICY_DENIED");
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, this.clock());
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        this.clock(),
        tx,
      );
      if (!own.allowedKinds.includes("media-key-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const keyId = federationMessageKeyId(responseJws);
      await this.trust.assertKey(tx, prepared.query.recipientSiteId, keyId, this.clock());
      const key = await this.trust.resolveKey(
        prepared.query.recipientSiteId,
        keyId,
        this.clock(),
        tx,
      );
      const grant = await verifyFederationMessage(
        FederationMediaKeyGrantSchema,
        responseJws,
        key,
        this.clock(),
      );
      assertMediaKeyGrant(prepared.query, prepared.digest, grant.payload, this.clock());
      return {
        query: prepared.query,
        queryDigest: prepared.digest,
        grant: grant.payload,
        signedGrant: responseJws,
      };
    });
  }
}

export function assertMediaKeyGrant(
  query: FederationMediaKeyQuery,
  queryDigest: string,
  grant: ReturnType<typeof FederationMediaKeyGrantSchema.parse>,
  now: Date,
) {
  assertFederationStatusQueryFresh(query, now);
  assertFederationStatusQueryFresh(grant, now);
  if (
    grant.senderSiteId !== query.recipientSiteId ||
    grant.recipientSiteId !== query.senderSiteId ||
    grant.queryDigest !== queryDigest ||
    Date.parse(grant.expiresAt) > Date.parse(query.expiresAt) ||
    Date.parse(grant.issuedAt) < Date.parse(query.issuedAt) - 60_000 ||
    (
      [
        "queryId",
        "packageId",
        "agreementRevisionId",
        "manifestDigest",
        "authorizationId",
        "agentId",
        "managedRootId",
      ] as const
    ).some((key) => grant[key] !== query[key])
  )
    throw new FederationError("INVALID_MESSAGE");
}
