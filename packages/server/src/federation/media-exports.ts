import {
  auditLog,
  federationMediaExports,
  federationSites,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  type FederationAnyMediaExportApproval,
  FederationAnyMediaExportApprovalSchema,
  FederationDigestSchema,
  FederationError,
  type FederationMediaKeyQuery,
  type FederationMediaManifest,
  FederationMediaManifestSchema,
  FederationMediaRevocationSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { MediaAge } from "@kuintessence/shared/federation/media-age";
import { encryptFederationMediaIdentity } from "@kuintessence/shared/federation/media-key-crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../auth/secret-cipher";
import { requireMediaAgreement } from "./media-agreement";
import { readMediaExportDataset } from "./media-export-data";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationTaskMediaSources, TaskMediaReader } from "./task-media-source";
import { FederationTrustRegistry } from "./trust-registry";

type Export = typeof federationMediaExports.$inferSelect;
type ExportSnapshot = {
  subject: FederationMediaManifest["subject"];
  files: FederationMediaManifest["files"];
  source: Export["source"];
  authorizedUntil: number;
};
type ExportReaderScope =
  | { actor: FederationActor }
  | { agentId: string }
  | { query: FederationMediaKeyQuery };

export function mediaIdentityDomain(
  row: Pick<Export, "localSiteId" | "packageId" | "manifestDigest">,
) {
  return `kq-federation-media-identity-v1:${row.localSiteId}:${row.packageId}:${row.manifestDigest}`;
}

/** Prepares a consented manifest/key pair; no data is copied and no key is returned to a user. */
export class FederationMediaExportService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly age: Pick<MediaAge, "generateIdentity">,
    private readonly wrappingKey: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly taskSources?: FederationTaskMediaSources,
  ) {
    if (wrappingKey.length < 32) throw new Error("MEDIA_WRAPPING_KEY_REQUIRED");
    this.trust = new FederationTrustRegistry(db);
  }

  async prepare(actor: FederationActor, raw: unknown) {
    const input = FederationAnyMediaExportApprovalSchema.parse(raw);
    const reader = "kind" in input ? await this.taskSources?.authorize(actor, input) : undefined;
    const snapshot = await this.db.transaction(async (tx) => {
      const data = await this.current(tx, actor, input, true, reader);
      const existing = await this.find(tx, input.packageId);
      if (existing) {
        this.matchRequest(existing, actor, input);
        this.matchData(existing, data);
        await this.assertManifestKey(tx, federationMessageKeyId(existing.manifestJws));
        return { existing, data };
      }
      return { data };
    });
    if (snapshot.existing) return view(snapshot.existing);
    const now = this.clock();
    const manifest = this.manifest(input, snapshot.data, now);
    const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now);
    const manifestJws = await signFederationMessage(
      FederationMediaManifestSchema,
      manifest,
      this.signing,
    );
    const { digest: manifestDigest } = await verifyFederationMessage(
      FederationMediaManifestSchema,
      manifestJws,
      own,
      now,
    );
    const key = await this.age.generateIdentity(AbortSignal.timeout(10_000));
    try {
      if (
        !/^age1[0-9a-z]{58}$/.test(key.recipient) ||
        !/^AGE-SECRET-KEY-1[0-9A-Z]{58}\n?$/.test(key.identity.toString("ascii"))
      )
        throw new FederationError("INVALID_MESSAGE");
      const draft = {
        localSiteId: this.signing.siteId,
        packageId: input.packageId,
        localOrgId: actor.orgId,
        recipientSiteId: input.recipientSiteId,
        agreementRevisionId: input.agreementRevisionId,
        ...selectors(input),
        source: snapshot.data.source,
        manifest,
        manifestDigest,
        manifestJws,
        recipient: key.recipient,
        approvedBy: actor.userId,
        approvedAt: now,
        expiresAt: new Date(input.expiresAt),
      };
      const identityEncrypted = await encryptSecret(
        key.identity.toString("ascii"),
        this.wrappingKey,
        mediaIdentityDomain(draft),
      );
      return await this.db.transaction(async (tx) => {
        const current = await this.current(tx, actor, input, true, reader);
        this.matchData(draft, current);
        await this.assertManifestKey(tx, this.signing.keyId);
        const [created] = await tx
          .insert(federationMediaExports)
          .values({ ...draft, identityEncrypted })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          const existing = await this.find(tx, input.packageId);
          if (!existing) throw new FederationError("OPERATION_CONFLICT");
          this.matchRequest(existing, actor, input);
          this.matchData(existing, current);
          await this.assertManifestKey(tx, federationMessageKeyId(existing.manifestJws));
          return view(existing);
        }
        await tx.insert(auditLog).values({
          actor: actor.userId,
          orgId: actor.orgId,
          action: "federation.media.export_approve",
          target: input.packageId,
          diff: {
            after: {
              manifestDigest,
              recipientSiteId: input.recipientSiteId,
              ...selectors(input),
              expiresAt: input.expiresAt,
            },
          },
        });
        return view(created);
      });
    } finally {
      key.identity.fill(0);
    }
  }

  /** Resolve external asset/ledger checks outside locks, then recheck the original approval in each transaction. */
  async reader(packageId: string, scope: ExportReaderScope): Promise<TaskMediaReader | undefined> {
    const row = await this.db.transaction(async (tx) => {
      if ("actor" in scope) await requireFederationCapability(tx, scope.actor, "media.export");
      const row = await this.find(tx, packageId);
      if (!row || row.revokedAt || row.expiresAt <= this.clock())
        throw new FederationError("POLICY_DENIED");
      if ("actor" in scope && row.localOrgId !== scope.actor.orgId)
        throw new FederationError("POLICY_DENIED");
      if ("agentId" in scope && row.source.agentId !== scope.agentId)
        throw new FederationError("POLICY_DENIED");
      if ("query" in scope) this.matchKeyQuery(row, scope.query);
      return row;
    });
    const input = this.request(row);
    if (!("kind" in input)) return undefined;
    if (!this.taskSources) throw new FederationError("POLICY_DENIED");
    return this.taskSources.authorize({ orgId: row.localOrgId, userId: row.approvedBy }, input);
  }

  async assertExportAuthorized(
    tx: PgTransaction,
    orgId: string,
    packageId: string,
    reader?: TaskMediaReader,
  ) {
    const row = await this.find(tx, packageId);
    if (!row || row.localOrgId !== orgId || row.revokedAt)
      throw new FederationError("POLICY_DENIED");
    const input = this.request(row);
    const data = await this.current(tx, { orgId, userId: row.approvedBy }, input, false, reader);
    this.matchData(row, data);
    const keyId = federationMessageKeyId(row.manifestJws);
    await this.assertManifestKey(tx, keyId);
    return { ...row, authorizedUntil: data.authorizedUntil };
  }

  async keyScope(tx: PgTransaction, query: FederationMediaKeyQuery, reader?: TaskMediaReader) {
    const row = await this.find(tx, query.packageId);
    if (!row) throw new FederationError("POLICY_DENIED");
    this.matchKeyQuery(row, query);
    return this.assertExportAuthorized(tx, row.localOrgId, row.packageId, reader);
  }

  private matchKeyQuery(row: Export, query: FederationMediaKeyQuery) {
    if (
      query.recipientSiteId !== row.localSiteId ||
      query.senderSiteId !== row.recipientSiteId ||
      query.manifestDigest !== row.manifestDigest ||
      query.agreementRevisionId !== row.agreementRevisionId ||
      query.maxBytes < row.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    )
      throw new FederationError("POLICY_DENIED");
  }

  /** Only the institution-authenticated key responder may call this; never a human HTTP route. */
  async sealIdentity(row: Export, query: FederationMediaKeyQuery, queryDigest: string) {
    const identity = Buffer.from(
      await decryptSecret(row.identityEncrypted, this.wrappingKey, mediaIdentityDomain(row)),
    );
    try {
      return await encryptFederationMediaIdentity(identity, query.recipientKey, queryDigest);
    } finally {
      identity.fill(0);
    }
  }

  async details(actor: FederationActor, packageId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      const row = await this.find(tx, z.uuid().parse(packageId));
      if (!row || row.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
      return view(row);
    });
  }

  async list(actor: FederationActor, limit = 50, offset = 0) {
    z.number().int().min(1).max(100).parse(limit);
    z.number().int().nonnegative().parse(offset);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      const t = federationMediaExports;
      return tx
        .select({
          packageId: t.packageId,
          recipientSiteId: t.recipientSiteId,
          agreementRevisionId: t.agreementRevisionId,
          versionId: t.versionId,
          locationId: t.locationId,
          taskSelection: t.taskSelection,
          manifestDigest: t.manifestDigest,
          approvedAt: t.approvedAt,
          approvedBy: t.approvedBy,
          expiresAt: t.expiresAt,
          revokedAt: t.revokedAt,
          revocationReason: t.revocationReason,
        })
        .from(t)
        .where(and(eq(t.localSiteId, this.signing.siteId), eq(t.localOrgId, actor.orgId)))
        .orderBy(desc(t.approvedAt), desc(t.packageId))
        .limit(limit)
        .offset(offset);
    });
  }

  async revoke(actor: FederationActor, packageId: string, raw: unknown) {
    const { reason } = FederationMediaRevocationSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.export");
      const row = await this.find(tx, z.uuid().parse(packageId));
      if (!row || row.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) return;
      await tx
        .update(federationMediaExports)
        .set({ revokedAt: this.clock(), revocationReason: reason })
        .where(
          and(
            eq(federationMediaExports.localSiteId, this.signing.siteId),
            eq(federationMediaExports.packageId, packageId),
          ),
        );
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.media.export_revoke",
        target: packageId,
        diff: { after: { reason } },
      });
    });
  }

  private async find(tx: PgTransaction, packageId: string) {
    const [row] = await tx
      .select()
      .from(federationMediaExports)
      .where(
        and(
          eq(federationMediaExports.localSiteId, this.signing.siteId),
          eq(federationMediaExports.packageId, packageId),
        ),
      )
      .for("update");
    return row;
  }

  private async assertManifestKey(tx: PgTransaction, keyId: string) {
    await this.trust.assertKey(tx, this.signing.siteId, keyId, this.clock());
    const key = await this.trust.resolveKey(this.signing.siteId, keyId, this.clock(), tx);
    if (!key.allowedKinds.includes("media-manifest"))
      throw new FederationError("UNTRUSTED_IDENTITY");
  }

  private async current(
    tx: PgTransaction,
    actor: FederationActor,
    input: FederationAnyMediaExportApproval,
    newApproval = true,
    reader?: TaskMediaReader,
  ): Promise<ExportSnapshot> {
    await requireFederationCapability(tx, actor, "media.export");
    const now = this.clock(),
      expiresAt = Date.parse(input.expiresAt);
    if (
      input.recipientSiteId === this.signing.siteId ||
      expiresAt <= now.getTime() ||
      (newApproval && expiresAt > now.getTime() + 7 * 86400_000)
    )
      throw new FederationError("POLICY_DENIED");
    const sites = await tx
      .select()
      .from(federationSites)
      .where(orSites(this.signing.siteId, input.recipientSiteId))
      .orderBy(federationSites.id)
      .for("share");
    if (sites.length !== 2 || sites.some((site) => site.state !== "active"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    if ("kind" in input) {
      if (!reader) throw new FederationError("POLICY_DENIED");
      const data = await reader(tx);
      if (
        data.subject.kind !== input.kind ||
        data.subject.operationId !== input.operationId ||
        data.source.agentId !== input.agentId
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (expiresAt > data.validUntil) throw new FederationError("POLICY_DENIED");
      if (data.authorizedUntil <= this.clock().getTime())
        throw new FederationError("AUTHORIZATION_EXPIRED");
      return data;
    }
    const terms = await requireMediaAgreement(
      tx,
      this.trust,
      { siteId: this.signing.siteId, orgId: actor.orgId, ...input },
      now,
    );
    if (expiresAt > Date.parse(terms.validUntil)) throw new FederationError("POLICY_DENIED");
    const data = await readMediaExportDataset(tx, actor, input, now);
    if (expiresAt > data.authorizationExpiresAt) throw new FederationError("POLICY_DENIED");
    const digest = data.version.manifestDigest ?? "";
    return {
      subject: FederationMediaManifestSchema.shape.subject.parse({
        kind: "dataset",
        asset: {
          originSiteId: this.signing.siteId,
          kind: "dataset",
          id: data.asset.id,
          revision: data.version.version,
          digest: FederationDigestSchema.parse(
            digest.startsWith("sha256:") ? digest : `sha256:${digest}`,
          ),
        },
        license: data.version.manifest.license ?? data.asset.metadata.license ?? null,
        provenance: data.version.provenance,
      }),
      files: data.files,
      source: data.source,
      authorizedUntil: Math.min(data.authorizationExpiresAt, Date.parse(terms.validUntil)),
    };
  }

  private manifest(
    input: Pick<
      FederationAnyMediaExportApproval,
      "packageId" | "agreementRevisionId" | "recipientSiteId"
    >,
    data: ExportSnapshot,
    createdAt: Date,
  ) {
    const raw = {
      protocolVersion: 1,
      kind: "media-manifest",
      packageId: input.packageId,
      senderSiteId: this.signing.siteId,
      recipientSiteId: input.recipientSiteId,
      agreementRevisionId: input.agreementRevisionId,
      createdAt: createdAt.toISOString(),
      subject: data.subject,
      files: data.files,
    };
    federationCanonicalJson(raw);
    return FederationMediaManifestSchema.parse(raw);
  }

  private matchData(row: Pick<Export, "manifest" | "source">, data: ExportSnapshot) {
    const manifest = this.manifest(
      {
        packageId: row.manifest.packageId,
        agreementRevisionId: row.manifest.agreementRevisionId,
        recipientSiteId: row.manifest.recipientSiteId,
      },
      data,
      new Date(row.manifest.createdAt),
    );
    if (
      federationCanonicalJson(manifest) !== federationCanonicalJson(row.manifest) ||
      federationCanonicalJson(data.source) !== federationCanonicalJson(row.source)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }

  private request(row: Export): FederationAnyMediaExportApproval {
    return FederationAnyMediaExportApprovalSchema.parse({
      packageId: row.packageId,
      agreementRevisionId: row.agreementRevisionId,
      recipientSiteId: row.recipientSiteId,
      ...(row.taskSelection ?? { versionId: row.versionId, locationId: row.locationId }),
      expiresAt: row.expiresAt.toISOString(),
    });
  }

  private matchRequest(
    row: Export,
    actor: FederationActor,
    input: FederationAnyMediaExportApproval,
  ) {
    if (
      row.revokedAt ||
      row.localOrgId !== actor.orgId ||
      row.approvedBy !== actor.userId ||
      federationCanonicalJson(this.request(row)) !== federationCanonicalJson(input)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
}

function orSites(local: string, remote: string) {
  return or(eq(federationSites.id, local), eq(federationSites.id, remote));
}

function view(row: Export) {
  return {
    packageId: row.packageId,
    recipientSiteId: row.recipientSiteId,
    agreementRevisionId: row.agreementRevisionId,
    versionId: row.versionId,
    locationId: row.locationId,
    taskSelection: row.taskSelection,
    manifest: row.manifest,
    manifestDigest: row.manifestDigest,
    signedManifest: row.manifestJws,
    recipient: row.recipient,
    approvedAt: row.approvedAt,
    approvedBy: row.approvedBy,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
  };
}

function selectors(input: FederationAnyMediaExportApproval) {
  return "kind" in input
    ? {
        versionId: null,
        locationId: null,
        taskSelection: { kind: input.kind, operationId: input.operationId, agentId: input.agentId },
      }
    : { versionId: input.versionId, locationId: input.locationId, taskSelection: null };
}
