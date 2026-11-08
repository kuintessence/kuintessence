import { createHash } from "node:crypto";
import { federationSites, type PgDb, type PgTransaction } from "@kuintessence/db";
import {
  type FederationDatasetUseLease,
  type FederationDatasetUseQuery,
  FederationDatasetUseQuerySchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { verifyDatasetUseLease } from "./dataset-authority";
import type { FederationSend } from "./outbound-client";
import { type FederationSigningKey, signFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";
export type DatasetUseScope = Omit<
  FederationDatasetUseQuery,
  "protocolVersion" | "kind" | "queryId" | "issuedAt" | "expiresAt"
>;

/** Callers fence their local publication/renewal both before and after this network operation. */
export class FederationDatasetUseClient {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async request(scope: DatasetUseScope): Promise<FederationDatasetUseLease> {
    if (scope.senderSiteId !== this.signing.siteId) throw new FederationError("POLICY_DENIED");
    const prepared = await this.db.transaction(async (tx) => {
      const now = this.clock();
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      const key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
      if (!key.allowedKinds.includes("dataset-use-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const endpoint = await this.endpoint(tx, scope.recipientSiteId);
      const query = FederationDatasetUseQuerySchema.parse({
        ...scope,
        protocolVersion: 1,
        kind: "dataset-use-query",
        queryId: crypto.randomUUID(),
        issuedAt: now.toISOString(),
        expiresAt: new Date(
          Math.min(now.getTime() + 60_000, key.validUntil.getTime()),
        ).toISOString(),
      });
      return {
        query,
        endpoint,
        jws: await signFederationMessage(FederationDatasetUseQuerySchema, query, this.signing),
      };
    });
    const signedGrant = await this.send(
      prepared.endpoint,
      prepared.jws,
      "/federation/v1/dataset-use",
    );
    return this.db.transaction(async (tx) => {
      if ((await this.endpoint(tx, scope.recipientSiteId)) !== prepared.endpoint)
        throw new FederationError("UNTRUSTED_IDENTITY");
      const lease = {
        query: prepared.query,
        queryDigest: `sha256:${createHash("sha256").update(JSON.stringify(prepared.query)).digest("hex")}`,
        queryKeyId: this.signing.keyId,
        signedGrant,
      };
      await verifyDatasetUseLease(tx, scope, lease, this.clock());
      return lease;
    });
  }
  private async endpoint(tx: PgTransaction, siteId: string) {
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId))
      .for("share");
    if (!site || site.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    return site.endpoint;
  }
}
