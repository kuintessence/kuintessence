import {
  auditLog,
  federationMediaImportAuthorizations as authorizations,
  federationMediaExports as exports,
  federationSites,
  federationMediaKeyGrants as grants,
  federationMediaImportOperations as imports,
  type PgDb,
  type PgTransaction,
  federationMediaPackages as packages,
  federationMediaReceipts as receipts,
} from "@kuintessence/db";
import {
  assertMediaReceiptAck,
  FederationError,
  FederationMediaKeyGrantSchema,
  type FederationMediaReceipt,
  FederationMediaReceiptAckSchema,
  FederationMediaReceiptSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { decodeJwt } from "jose";
import { z } from "zod";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

export function mediaImportReceipt(
  operation: typeof imports.$inferSelect,
  inventory: typeof packages.$inferSelect,
) {
  const grant = operation.latestGrant;
  if (
    operation.state !== "verified" ||
    !operation.verifiedAt ||
    operation.verifiedBytes === null ||
    !grant ||
    grant.binding.generation !== operation.generation ||
    grant.binding.authorizationId !== operation.authorizationId ||
    grant.binding.packageId !== inventory.packageId ||
    grant.binding.manifestDigest !== inventory.manifestDigest
  )
    throw new FederationError("OPERATION_CONFLICT");
  return FederationMediaReceiptSchema.parse({
    protocolVersion: 1,
    kind: "media-import-receipt",
    receiptId: operation.authorizationId,
    generation: operation.generation,
    senderSiteId: inventory.localSiteId,
    recipientSiteId: inventory.senderSiteId,
    packageId: inventory.packageId,
    agreementRevisionId: inventory.agreementRevisionId,
    manifestDigest: inventory.manifestDigest,
    keyQueryId: grant.query.queryId,
    keyQueryDigest: grant.queryDigest,
    state: "verified-private",
    fileCount: inventory.manifest.files.length,
    sizeBytes: operation.verifiedBytes,
    receivedAt: operation.verifiedAt.toISOString(),
  });
}

/** Receipts report an immutable past import. Expiring or revoking use does not erase that fact. */
export class FederationMediaReceiptSender {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private query(tx: PgTransaction) {
    return tx
      .select({ operation: imports, inventory: packages })
      .from(imports)
      .innerJoin(authorizations, eq(authorizations.authorizationId, imports.authorizationId))
      .innerJoin(
        packages,
        and(
          eq(packages.localSiteId, authorizations.localSiteId),
          eq(packages.packageId, authorizations.packageId),
        ),
      );
  }
  private async locked(tx: PgTransaction, id: string) {
    const [row] = await this.query(tx)
      .where(and(eq(imports.authorizationId, id), eq(packages.localSiteId, this.signing.siteId)))
      .for("update", { of: imports });
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }
  async status(actor: FederationActor, packageId: string, id: string) {
    z.uuid().parse(packageId);
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      const row = await this.locked(tx, id);
      if (row.inventory.localOrgId !== actor.orgId || row.inventory.packageId !== packageId)
        throw new FederationError("POLICY_DENIED");
      return {
        state:
          row.operation.state !== "verified"
            ? "awaiting-import"
            : row.operation.receiptAck
              ? "recorded"
              : "pending",
        receipt: row.operation.receipt,
        signedReceipt: row.operation.receiptJws,
        acknowledgement: row.operation.receiptAck,
        signedAcknowledgement: row.operation.receiptAckJws,
        lastError: row.operation.receiptLastError,
        nextAttemptAt: row.operation.receiptNextAttemptAt,
      };
    });
  }
  async retry(actor: FederationActor, packageId: string, id: string) {
    z.uuid().parse(packageId);
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.import");
      const row = await this.locked(tx, id);
      if (row.inventory.localOrgId !== actor.orgId || row.inventory.packageId !== packageId)
        throw new FederationError("POLICY_DENIED");
      if (row.operation.state !== "verified") throw new FederationError("OPERATION_CONFLICT");
      if (row.operation.receiptAck) return;
      await tx
        .update(imports)
        .set({ receiptToken: null, receiptNextAttemptAt: this.clock(), receiptLastError: null })
        .where(eq(imports.authorizationId, id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.media.receipt_retry",
        target: id,
      });
    });
  }
  private async authorize(tx: PgTransaction, receipt: FederationMediaReceipt, jws: string) {
    const ownId = federationMessageKeyId(jws);
    await this.trust.assertKey(tx, this.signing.siteId, ownId, this.clock());
    const own = await this.trust.resolveKey(this.signing.siteId, ownId, this.clock(), tx);
    const verified = await verifyFederationMessage(
      FederationMediaReceiptSchema,
      jws,
      own,
      this.clock(),
    );
    if (
      federationCanonicalJson(verified.payload) !== federationCanonicalJson(receipt) ||
      receipt.senderSiteId !== this.signing.siteId
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, receipt.recipientSiteId))
      .for("share");
    if (!site || site.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    return { endpoint: site.endpoint, digest: verified.digest };
  }
  async deliverNext(): Promise<boolean> {
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await this.query(tx)
        .where(
          and(
            eq(packages.localSiteId, this.signing.siteId),
            eq(imports.state, "verified"),
            isNull(imports.receiptAck),
            lte(imports.receiptNextAttemptAt, this.clock()),
          ),
        )
        .orderBy(asc(imports.receiptNextAttemptAt), asc(imports.authorizationId))
        .limit(1)
        .for("update", { of: imports, skipLocked: true });
      if (!row) return null;
      let receipt: FederationMediaReceipt;
      try {
        receipt = mediaImportReceipt(row.operation, row.inventory);
        if (
          row.operation.receipt &&
          federationCanonicalJson(row.operation.receipt) !== federationCanonicalJson(receipt)
        )
          throw new FederationError("OPERATION_CONFLICT");
      } catch {
        await tx
          .update(imports)
          .set({
            receiptLastError: "RECEIPT_CONFLICT",
            receiptToken: null,
            receiptNextAttemptAt: new Date(this.clock().getTime() + 30_000),
          })
          .where(eq(imports.authorizationId, row.operation.authorizationId));
        return { invalid: true as const };
      }
      const token = crypto.randomUUID();
      await tx
        .update(imports)
        .set({
          receipt,
          receiptToken: token,
          receiptNextAttemptAt: new Date(this.clock().getTime() + 30_000),
        })
        .where(eq(imports.authorizationId, row.operation.authorizationId));
      return { ...row, receipt, token, invalid: false as const };
    });
    if (!claimed) return false;
    if (claimed.invalid) return true;
    const { receipt, token } = claimed;
    const identity = and(
      eq(imports.authorizationId, receipt.receiptId),
      eq(imports.receiptToken, token),
      isNull(imports.receiptAck),
    );
    try {
      const prepared = await this.db.transaction(async (tx) => {
        const { operation, inventory } = await this.locked(tx, receipt.receiptId);
        if (operation.receiptAck || operation.receiptToken !== token) return null;
        if (
          federationCanonicalJson(mediaImportReceipt(operation, inventory)) !==
            federationCanonicalJson(receipt) ||
          federationCanonicalJson(operation.receipt) !== federationCanonicalJson(receipt)
        )
          throw new FederationError("OPERATION_CONFLICT");
        const jws =
          operation.receiptJws &&
          federationMessageKeyId(operation.receiptJws) === this.signing.keyId
            ? operation.receiptJws
            : await signFederationMessage(FederationMediaReceiptSchema, receipt, this.signing);
        const authorized = await this.authorize(tx, receipt, jws);
        await tx.update(imports).set({ receiptJws: jws }).where(identity);
        return { ...authorized, jws };
      });
      if (!prepared) return true;
      const ackJws = await this.send(
        prepared.endpoint,
        prepared.jws,
        "/federation/v1/media-receipts",
      );
      await this.db.transaction(async (tx) => {
        const { operation, inventory } = await this.locked(tx, receipt.receiptId);
        if (
          operation.receiptAck ||
          operation.receiptToken !== token ||
          operation.receiptJws !== prepared.jws
        )
          return;
        if (
          federationCanonicalJson(mediaImportReceipt(operation, inventory)) !==
            federationCanonicalJson(receipt) ||
          federationCanonicalJson(operation.receipt) !== federationCanonicalJson(receipt)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if ((await this.authorize(tx, receipt, prepared.jws)).endpoint !== prepared.endpoint)
          throw new FederationError("UNTRUSTED_IDENTITY");
        const keyId = federationMessageKeyId(ackJws);
        await this.trust.assertKey(tx, receipt.recipientSiteId, keyId, this.clock());
        const peer = await this.trust.resolveKey(receipt.recipientSiteId, keyId, this.clock(), tx);
        const { payload: ack } = await verifyFederationMessage(
          FederationMediaReceiptAckSchema,
          ackJws,
          peer,
          this.clock(),
        );
        assertMediaReceiptAck(receipt, prepared.digest, ack, this.clock());
        await tx
          .update(imports)
          .set({
            receiptAck: ack,
            receiptAckJws: ackJws,
            receiptToken: null,
            receiptLastError: null,
          })
          .where(identity);
        await tx.insert(auditLog).values({
          actor: operation.requestedBy,
          orgId: inventory.localOrgId,
          action: "federation.media.receipt_recorded",
          target: receipt.receiptId,
          diff: { after: { digest: prepared.digest } },
        });
      });
    } catch (error) {
      const code =
        error instanceof FederationError || error instanceof FederationDeliveryError
          ? error.code
          : "RECEIPT_DELIVERY_FAILED";
      await this.db
        .update(imports)
        .set({
          receiptLastError: code,
          receiptToken: null,
          receiptNextAttemptAt: new Date(this.clock().getTime() + 30_000),
        })
        .where(identity);
    }
    return true;
  }
}

export class FederationMediaReceiptReceiver {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      this.clock(),
    );
    const initial = await verifyFederationMessage(
      FederationMediaReceiptSchema,
      jws,
      peer,
      this.clock(),
    );
    return this.db.transaction(async (tx) => {
      for (const site of [peer.siteId, this.signing.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, this.clock());
        else await this.trust.assertKey(tx, site, this.signing.keyId, this.clock());
      }
      const currentPeer = await this.trust.resolveKey(peer.siteId, peer.keyId, this.clock(), tx);
      const { payload: receipt, digest } = await verifyFederationMessage(
        FederationMediaReceiptSchema,
        jws,
        currentPeer,
        this.clock(),
      );
      if (
        receipt.senderSiteId !== peer.siteId ||
        receipt.recipientSiteId !== this.signing.siteId ||
        digest !== initial.digest ||
        Date.parse(receipt.receivedAt) > this.clock().getTime() + 60_000
      )
        throw new FederationError("INVALID_MESSAGE");
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        this.clock(),
        tx,
      );
      if (!own.allowedKinds.includes("media-import-receipt-ack"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const [source] = await tx
        .select()
        .from(exports)
        .where(
          and(
            eq(exports.localSiteId, this.signing.siteId),
            eq(exports.packageId, receipt.packageId),
          ),
        )
        .for("update");
      const [grant] = await tx
        .select()
        .from(grants)
        .where(
          and(eq(grants.localSiteId, this.signing.siteId), eq(grants.queryId, receipt.keyQueryId)),
        )
        .for("share");
      if (
        !source ||
        !grant ||
        source.recipientSiteId !== peer.siteId ||
        source.agreementRevisionId !== receipt.agreementRevisionId ||
        source.manifestDigest !== receipt.manifestDigest ||
        grant.packageId !== receipt.packageId ||
        grant.queryDigest !== receipt.keyQueryDigest ||
        source.manifest.files.length !== receipt.fileCount ||
        source.manifest.files.reduce((n, f) => n + f.sizeBytes, 0) !== receipt.sizeBytes
      )
        throw new FederationError("OPERATION_CONFLICT");
      // This is the source's own durably-issued response, not caller-supplied unsigned content.
      const issued = FederationMediaKeyGrantSchema.parse(decodeJwt(grant.responseJws));
      if (
        issued.authorizationId !== receipt.receiptId ||
        issued.queryId !== receipt.keyQueryId ||
        issued.queryDigest !== receipt.keyQueryDigest ||
        issued.senderSiteId !== this.signing.siteId ||
        issued.recipientSiteId !== peer.siteId ||
        issued.manifestDigest !== receipt.manifestDigest ||
        issued.packageId !== receipt.packageId ||
        issued.agreementRevisionId !== receipt.agreementRevisionId ||
        Date.parse(receipt.receivedAt) < Date.parse(issued.issuedAt) - 60_000 ||
        Date.parse(receipt.receivedAt) > Date.parse(issued.expiresAt)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const identity = and(
        eq(receipts.localSiteId, this.signing.siteId),
        eq(receipts.senderSiteId, peer.siteId),
        eq(receipts.receiptId, receipt.receiptId),
      );
      const [existing] = await tx.select().from(receipts).where(identity).for("update");
      if (existing && existing.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
      const acknowledgement =
        existing?.acknowledgement ??
        FederationMediaReceiptAckSchema.parse({
          protocolVersion: 1,
          kind: "media-import-receipt-ack",
          receiptId: receipt.receiptId,
          packageId: receipt.packageId,
          senderSiteId: this.signing.siteId,
          recipientSiteId: peer.siteId,
          receiptDigest: digest,
          recordedAt: this.clock().toISOString(),
        });
      if (existing && federationMessageKeyId(existing.acknowledgementJws) === this.signing.keyId)
        return existing.acknowledgementJws;
      const acknowledgementJws = await signFederationMessage(
        FederationMediaReceiptAckSchema,
        acknowledgement,
        this.signing,
      );
      await verifyFederationMessage(
        FederationMediaReceiptAckSchema,
        acknowledgementJws,
        own,
        this.clock(),
      );
      if (existing) {
        await tx.update(receipts).set({ acknowledgementJws }).where(identity);
        return acknowledgementJws;
      }
      const [inserted] = await tx
        .insert(receipts)
        .values({
          localSiteId: this.signing.siteId,
          senderSiteId: peer.siteId,
          receiptId: receipt.receiptId,
          packageId: receipt.packageId,
          receipt,
          digest,
          receiptJws: jws,
          acknowledgement,
          acknowledgementJws,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        const [concurrent] = await tx.select().from(receipts).where(identity);
        if (!concurrent || concurrent.digest !== digest)
          throw new FederationError("OPERATION_CONFLICT");
        return concurrent.acknowledgementJws;
      }
      await tx.insert(auditLog).values({
        actor: `federation:${peer.siteId}`,
        orgId: source.localOrgId,
        action: "federation.media.receipt_received",
        target: receipt.receiptId,
        diff: { after: { packageId: receipt.packageId, digest } },
      });
      return acknowledgementJws;
    });
  }
  async list(actor: FederationActor, packageId: string, limit = 50, offset = 0) {
    z.uuid().parse(packageId);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      const [source] = await tx
        .select()
        .from(exports)
        .where(
          and(
            eq(exports.localSiteId, this.signing.siteId),
            eq(exports.localOrgId, actor.orgId),
            eq(exports.packageId, packageId),
          ),
        );
      if (!source) throw new FederationError("POLICY_DENIED");
      return tx
        .select({
          receipt: receipts.receipt,
          signedReceipt: receipts.receiptJws,
          acknowledgement: receipts.acknowledgement,
          signedAcknowledgement: receipts.acknowledgementJws,
        })
        .from(receipts)
        .where(
          and(eq(receipts.localSiteId, this.signing.siteId), eq(receipts.packageId, packageId)),
        )
        .orderBy(asc(receipts.receiptId))
        .limit(limit)
        .offset(offset);
    });
  }
}
