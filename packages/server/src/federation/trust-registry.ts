import { X509Certificate } from "node:crypto";
import {
  auditLog,
  federationCertificates,
  federationSigningKeys,
  federationSites,
  type PgDb,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq } from "drizzle-orm";
import { exportSPKI } from "jose";
import { z } from "zod";
import { type FederationVerificationKey, parseFederationPublicKey } from "./signatures";

export { parseFederationPublicKey } from "./signatures";

export type FederationTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
export const FederationSiteInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    }, "Expected HTTPS origin without credentials, path or query"),
});
export const FederationKeyInput = z
  .strictObject({
    keyId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
    publicKeyPem: z.string().min(1).max(16384),
    allowedKinds: z
      .array(
        z.enum([
          "agreement",
          "delegation",
          "acceptance",
          "evidence-batch",
          "status-query",
          "status-report",
          "cancellation",
          "cancellation-receipt",
          "result-query",
          "result-report",
          "result-download-query",
          "result-download-grant",
          "result-receipt",
          "result-receipt-ack",
          "material-query",
          "material-chunk",
        ]),
      )
      .min(1)
      .max(16),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  })
  .refine((v) => Date.parse(v.validFrom) < Date.parse(v.validUntil), "Invalid validity interval");
export const FederationCertificateInput = z.strictObject({
  certificatePem: z.string().min(1).max(16384),
});

function requireValid(
  row: { validFrom: Date; validUntil: Date; revokedAt: Date | null },
  now: Date,
) {
  if (
    !Number.isFinite(now.getTime()) ||
    row.revokedAt ||
    now < row.validFrom ||
    now >= row.validUntil
  )
    throw new FederationError("UNTRUSTED_IDENTITY");
}

/** Local administrator trust decisions; incoming messages can never create or replace trust. */
export class FederationTrustRegistry {
  constructor(private readonly db: PgDb) {}

  async list(limit = 50, offset = 0) {
    return this.db
      .select()
      .from(federationSites)
      .orderBy(asc(federationSites.id))
      .limit(limit)
      .offset(offset);
  }

  async details(siteId: string) {
    const [site] = await this.db
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId));
    if (!site) throw new FederationError("UNTRUSTED_IDENTITY");
    const keys = await this.db
      .select()
      .from(federationSigningKeys)
      .where(eq(federationSigningKeys.siteId, siteId));
    const certificates = await this.db
      .select()
      .from(federationCertificates)
      .where(eq(federationCertificates.siteId, siteId));
    return { ...site, keys, certificates };
  }

  async addSite(raw: z.input<typeof FederationSiteInput>, actor: string) {
    const input = FederationSiteInput.parse(raw);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(federationSites)
        .values(input)
        .onConflictDoNothing()
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, actor, "site.add", input.id, input);
      return row;
    });
  }

  async updateSite(
    siteId: string,
    input: Pick<z.infer<typeof FederationSiteInput>, "name" | "endpoint">,
    actor: string,
  ) {
    const value = FederationSiteInput.parse({ id: siteId, ...input });
    return this.db.transaction(async (tx) => {
      const site = await this.lockSite(tx, siteId);
      if (site.state === "revoked") throw new FederationError("UNTRUSTED_IDENTITY");
      const [row] = await tx
        .update(federationSites)
        .set({ name: value.name, endpoint: value.endpoint })
        .where(eq(federationSites.id, siteId))
        .returning();
      await this.audit(tx, actor, "site.update", siteId, value);
      return row;
    });
  }

  async setState(siteId: string, state: "active" | "suspended" | "revoked", actor: string) {
    return this.db.transaction(async (tx) => {
      const site = await this.lockSite(tx, siteId);
      if (site.state === "revoked" && state !== "revoked")
        throw new FederationError("UNTRUSTED_IDENTITY");
      await tx.update(federationSites).set({ state }).where(eq(federationSites.id, siteId));
      await this.audit(tx, actor, "site.state", siteId, { state });
    });
  }

  async addKey(siteId: string, raw: z.input<typeof FederationKeyInput>, actor: string) {
    const input = FederationKeyInput.parse(raw);
    const publicKeyPem = await exportSPKI(await parseFederationPublicKey(input.publicKeyPem));
    return this.db.transaction(async (tx) => {
      const site = await this.lockSite(tx, siteId);
      if (site.state === "revoked") throw new FederationError("UNTRUSTED_IDENTITY");
      const [row] = await tx
        .insert(federationSigningKeys)
        .values({
          ...input,
          publicKeyPem,
          siteId,
          validFrom: new Date(input.validFrom),
          validUntil: new Date(input.validUntil),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, actor, "key.add", siteId, {
        keyId: input.keyId,
        allowedKinds: input.allowedKinds,
      });
      return row;
    });
  }

  async addCertificate(
    siteId: string,
    raw: z.input<typeof FederationCertificateInput>,
    actor: string,
  ) {
    const { certificatePem } = FederationCertificateInput.parse(raw);
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(certificatePem);
      if (cert.ca || !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.2"))
        throw new Error("Client certificate required");
    } catch {
      throw new FederationError("INVALID_MESSAGE");
    }
    const fingerprint = cert.fingerprint256.replaceAll(":", "").toLowerCase();
    return this.db.transaction(async (tx) => {
      const site = await this.lockSite(tx, siteId);
      if (site.state === "revoked") throw new FederationError("UNTRUSTED_IDENTITY");
      const [row] = await tx
        .insert(federationCertificates)
        .values({
          siteId,
          fingerprint,
          certificatePem: cert.toString(),
          validFrom: new Date(cert.validFrom),
          validUntil: new Date(cert.validTo),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, actor, "certificate.add", siteId, { fingerprint });
      return row;
    });
  }

  async revoke(siteId: string, target: { keyId: string } | { fingerprint: string }, actor: string) {
    await this.db.transaction(async (tx) => {
      await this.lockSite(tx, siteId);
      const rows =
        "keyId" in target
          ? await tx
              .update(federationSigningKeys)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(federationSigningKeys.siteId, siteId),
                  eq(federationSigningKeys.keyId, target.keyId),
                ),
              )
              .returning()
          : await tx
              .update(federationCertificates)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(federationCertificates.siteId, siteId),
                  eq(federationCertificates.fingerprint, target.fingerprint),
                ),
              )
              .returning();
      if (!rows.length) throw new FederationError("UNTRUSTED_IDENTITY");
      await this.audit(tx, actor, "credential.revoke", siteId, target);
    });
  }

  async resolvePeer(
    fingerprint: string,
    keyId: string,
    now: Date,
  ): Promise<FederationVerificationKey> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new FederationError("UNTRUSTED_IDENTITY");
    const [cert] = await this.db
      .select()
      .from(federationCertificates)
      .where(eq(federationCertificates.fingerprint, fingerprint));
    if (!cert) throw new FederationError("UNTRUSTED_IDENTITY");
    requireValid(cert, now);
    return this.resolveKey(cert.siteId, keyId, now);
  }

  async resolveKey(
    siteId: string,
    keyId: string,
    now: Date,
    database: PgDb | FederationTransaction = this.db,
  ): Promise<FederationVerificationKey> {
    const [row] = await database
      .select({ key: federationSigningKeys, site: federationSites })
      .from(federationSigningKeys)
      .innerJoin(federationSites, eq(federationSites.id, federationSigningKeys.siteId))
      .where(and(eq(federationSigningKeys.siteId, siteId), eq(federationSigningKeys.keyId, keyId)));
    if (!row || row.site.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    requireValid(row.key, now);
    return {
      ...row.key,
      publicKey: await parseFederationPublicKey(row.key.publicKeyPem),
      revoked: false,
    };
  }

  /** Share locks serialize admission against revocation, including an already verified request. */
  async assertPeer(
    tx: FederationTransaction,
    fingerprint: string,
    siteId: string,
    keyId: string,
    now: Date,
  ) {
    await this.assertKey(tx, siteId, keyId, now);
    const [row] = await tx
      .select()
      .from(federationCertificates)
      .where(
        and(
          eq(federationCertificates.fingerprint, fingerprint),
          eq(federationCertificates.siteId, siteId),
        ),
      )
      .for("share");
    if (!row) throw new FederationError("UNTRUSTED_IDENTITY");
    requireValid(row, now);
  }

  async assertKey(tx: FederationTransaction, siteId: string, keyId: string, now: Date) {
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId))
      .for("share");
    if (!site || site.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    const [row] = await tx
      .select()
      .from(federationSigningKeys)
      .where(and(eq(federationSigningKeys.siteId, siteId), eq(federationSigningKeys.keyId, keyId)))
      .for("share");
    if (!row) throw new FederationError("UNTRUSTED_IDENTITY");
    requireValid(row, now);
  }

  private async lockSite(tx: FederationTransaction, siteId: string) {
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId))
      .for("update");
    if (!site) throw new FederationError("UNTRUSTED_IDENTITY");
    return site;
  }

  private async audit(
    tx: FederationTransaction,
    actor: string,
    action: string,
    target: string,
    after: unknown,
  ) {
    await tx
      .insert(auditLog)
      .values({ actor, action: `federation.trust.${action}`, target, diff: { after } });
  }
}
