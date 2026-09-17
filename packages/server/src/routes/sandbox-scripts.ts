import {
  type PgDb,
  sandboxRuntimeProfiles,
  scriptAttestations,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  hasRole,
  type RoleName,
  SoftwareAssetPayloadSchema,
  workflowDsl,
} from "@kuintessence/shared";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  softwareAssetGrantTuples,
  softwareAssetOwnerOrgTuple,
  softwareAssetOwnerTuple,
  softwareAssetPlatformTuple,
} from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { writeAudit } from "../services/audit-log-writer";
import { hashSandboxScript, renderSandboxPrompt } from "../services/sandbox-script";
import { registerWorkflowAuthorization } from "../services/workflow-authorization";

const ScriptBodySchema = z.strictObject({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(100).default("0.1.0"),
  language: workflowDsl.SandboxLanguageSchema,
  runtimeProfileId: z.string().uuid(),
  entrypoint: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  content: z.string().max(1_000_000),
  inputs: z.record(z.string().min(1), workflowDsl.ScriptInputSpecSchema).default({}),
  outputs: z.record(z.string().min(1), workflowDsl.ScriptOutputSpecSchema).default({}),
});

const RevisionBodySchema = ScriptBodySchema.extend({
  changelog: z.string().max(5_000).optional(),
});

const PromptBodySchema = z.strictObject({
  locale: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
  sourceApp: z.string().max(255).optional(),
  targetApp: z.string().max(255).optional(),
  usecase: z.string().max(255).optional(),
});

const AttestationBodySchema = z.strictObject({
  runtimeProfileId: z.string().uuid(),
  runtimeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  scope: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("Platform") }),
    z.strictObject({ type: z.literal("Provider"), providerOrgId: z.string().uuid() }),
  ]),
  scanResultHash: z.string().regex(/^[0-9a-f]{64}$/),
  allowedIdentities: z.array(workflowDsl.ExecutionIdentitySchema).min(1),
  expiresAt: z.coerce.date().optional(),
});

const RuntimeBodySchema = z.strictObject({
  name: z.string().min(1).max(255),
  language: workflowDsl.SandboxLanguageSchema,
  languageVersion: z.string().min(1).max(100),
  ociDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  sifDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  signature: z.string().min(1),
  dependencies: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        version: z.string().min(1),
        license: z.string().optional(),
      }),
    )
    .default([]),
  documentation: z.record(z.string().min(2), z.string()).default({}),
  adapters: z.array(z.enum(["slurm", "pbs-pro", "torque", "kubernetes"])).min(1),
  securityRequirements: z.strictObject({
    networkDisabled: z.literal(true),
    readOnlyRootFilesystem: z.literal(true),
    runAsNonRoot: z.literal(true),
    seccompRequired: z.boolean(),
    signatureVerificationRequired: z.literal(true),
  }),
  lifecycle: z.enum(["draft", "active", "deprecated", "revoked"]).default("draft"),
});

const TestRunBodySchema = z.strictObject({
  fixtures: z.record(z.string().min(1), z.unknown()).default({}),
  mappingId: z.string().uuid().optional(),
  plannerMode: z.enum(["Global", "Lookahead", "Greedy"]).default("Lookahead"),
});

export interface SandboxScriptRoutesDeps {
  db: PgDb;
  authz?: AuthzService;
  submitTestRun?: (input: {
    yaml: string;
    submittedBy: string;
    role: RoleName;
    plannerMode: "Global" | "Lookahead" | "Greedy";
    mappingId?: string;
    authorizeRun: (runId: string) => Promise<void>;
  }) => Promise<{ runId: string }>;
}

type AssetRow = typeof softwareAssets.$inferSelect;
type GrantRow = typeof softwareAssetGrants.$inferSelect;
type CanonicalPrincipal = BoundPrincipal & { userId: string };
type SandboxScriptPayload = Extract<
  z.infer<typeof SoftwareAssetPayloadSchema>,
  { kind: "sandbox-script" }
>;

function principal(c: Context): CanonicalPrincipal {
  const value = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!value?.userId) throw new AppError(ErrorCode.FORBIDDEN, "Bound principal required", 403);
  return value as CanonicalPrincipal;
}

function isPlatform(value: BoundPrincipal): boolean {
  return hasRole(value.role as RoleName, "platform_admin");
}

function grantMatches(grant: GrantRow, value: BoundPrincipal): boolean {
  if (grant.subjectKind === "user") return grant.subjectId === value.userId;
  if (grant.subjectKind === "platform") return true;
  return value.orgIds.includes(grant.subjectId);
}

function canView(asset: AssetRow, grants: readonly GrantRow[], value: BoundPrincipal): boolean {
  if (isPlatform(value) || asset.ownerUserId === value.userId) return true;
  if (asset.ownerOrgId && value.orgIds.includes(asset.ownerOrgId)) return true;
  if (asset.visibility === "platform-public" && asset.lifecycle === "published") return true;
  return grants.some(
    (grant) =>
      grantMatches(grant, value) &&
      grant.capabilities.some((item) => ["view", "use", "install", "edit", "admin"].includes(item)),
  );
}

function canEdit(asset: AssetRow, value: BoundPrincipal): boolean {
  if (isPlatform(value) || asset.ownerUserId === value.userId) return true;
  return Boolean(
    asset.ownerOrgId &&
      value.orgIds.includes(asset.ownerOrgId) &&
      hasRole(value.role as RoleName, "org_admin"),
  );
}

async function loadScript(db: PgDb, assetId: string): Promise<AssetRow> {
  const [asset] = await db
    .select()
    .from(softwareAssets)
    .where(eq(softwareAssets.id, assetId))
    .limit(1);
  if (!asset || asset.kind !== "sandbox-script") {
    throw new AppError(ErrorCode.NOT_FOUND, "Sandbox script not found", 404);
  }
  return asset;
}

async function loadGrants(db: PgDb, assetIds: readonly string[]): Promise<GrantRow[]> {
  if (assetIds.length === 0) return [];
  return db
    .select()
    .from(softwareAssetGrants)
    .where(inArray(softwareAssetGrants.assetId, [...assetIds]));
}

async function assertView(
  deps: SandboxScriptRoutesDeps,
  asset: AssetRow,
  value: CanonicalPrincipal,
): Promise<void> {
  const grants = await loadGrants(deps.db, [asset.id]);
  const localAllowed = canView(asset, grants, value);
  if (!deps.authz || deps.authz.mode === "off") {
    if (!localAllowed) throw new AppError(ErrorCode.FORBIDDEN, "Script access denied", 403);
    return;
  }
  const check = {
    actorUserId: value.userId,
    actorEmail: value.email,
    resource: { type: "software_asset", id: asset.id },
    permission: "view",
    subject: { type: "user", id: value.userId },
    context: { source: "sandbox-script", localAllowed },
  };
  if (deps.authz.mode === "shadow") {
    await deps.authz.shadowCheck({ ...check, localAllowed });
    if (!localAllowed) throw new AppError(ErrorCode.FORBIDDEN, "Script access denied", 403);
    return;
  }
  if (
    asset.ownerUserId === value.userId &&
    (await deps.authz.hasPendingRelationship(
      softwareAssetOwnerTuple({ assetId: asset.id, userId: value.userId }),
    ))
  ) {
    return;
  }
  await deps.authz.requirePermission(check, isPlatform(value));
}

async function loadRuntime(db: PgDb, runtimeProfileId: string) {
  const [runtime] = await db
    .select()
    .from(sandboxRuntimeProfiles)
    .where(eq(sandboxRuntimeProfiles.id, runtimeProfileId))
    .limit(1);
  if (!runtime) throw new AppError(ErrorCode.NOT_FOUND, "Runtime profile not found", 404);
  return runtime;
}

function payload(
  body: z.infer<typeof ScriptBodySchema> | z.infer<typeof RevisionBodySchema>,
): SandboxScriptPayload {
  const sha256 = hashSandboxScript(body.content);
  const parsed = SoftwareAssetPayloadSchema.parse({
    kind: "sandbox-script",
    language: body.language,
    runtimeProfileId: body.runtimeProfileId,
    entrypoint: body.entrypoint,
    content: body.content,
    sha256,
    inputs: body.inputs,
    outputs: body.outputs,
  });
  if (parsed.kind !== "sandbox-script") {
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Unexpected script payload kind", 500);
  }
  return parsed;
}

function runtimeView(row: typeof sandboxRuntimeProfiles.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function createSandboxScriptRoutes(deps: SandboxScriptRoutesDeps): Hono {
  const r = new Hono();
  const { db } = deps;

  r.get("/sandbox/scripts", async (c) => {
    const value = principal(c);
    const rows = await db
      .select()
      .from(softwareAssets)
      .where(eq(softwareAssets.kind, "sandbox-script"))
      .orderBy(desc(softwareAssets.updatedAt));
    const grants = await loadGrants(
      db,
      rows.map((row) => row.id),
    );
    const visible = rows.filter((row) =>
      canView(
        row,
        grants.filter((grant) => grant.assetId === row.id),
        value,
      ),
    );
    if (visible.length === 0) return c.json({ success: true, data: [] });
    const revisions = await db
      .select()
      .from(softwareAssetRevisions)
      .where(
        inArray(
          softwareAssetRevisions.assetId,
          visible.map((row) => row.id),
        ),
      )
      .orderBy(desc(softwareAssetRevisions.revision));
    const latestByAsset = new Map<string, (typeof revisions)[number]>();
    for (const revision of revisions) {
      if (!latestByAsset.has(revision.assetId)) latestByAsset.set(revision.assetId, revision);
    }
    const latestRevisionIds = [...latestByAsset.values()].map((revision) => revision.id);
    const attestations =
      latestRevisionIds.length === 0
        ? []
        : await db
            .select()
            .from(scriptAttestations)
            .where(inArray(scriptAttestations.assetRevisionId, latestRevisionIds));
    const now = new Date();
    const sharedAttestedRevisionIds = new Set(
      attestations
        .filter(
          (attestation) =>
            attestation.status === "active" &&
            (attestation.expiresAt === null || attestation.expiresAt > now) &&
            attestation.allowedIdentities.some((identity) => identity.type === "SharedService"),
        )
        .map((attestation) => attestation.assetRevisionId),
    );
    return c.json({
      success: true,
      data: visible.map((asset) => ({
        ...asset,
        sharedAccountEligible:
          asset.lifecycle === "published" &&
          sharedAttestedRevisionIds.has(latestByAsset.get(asset.id)?.id ?? ""),
      })),
    });
  });

  r.post("/sandbox/scripts", async (c) => {
    const value = principal(c);
    const body = ScriptBodySchema.parse(await c.req.json());
    const runtime = await loadRuntime(db, body.runtimeProfileId);
    if (runtime.lifecycle !== "active" || runtime.language !== body.language) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Runtime is not active for this language",
        400,
      );
    }
    const revisionPayload = payload(body);
    const result = await db.transaction(async (tx) => {
      const [asset] = await tx
        .insert(softwareAssets)
        .values({
          kind: "sandbox-script",
          name: body.name,
          version: body.version,
          source: isPlatform(value) ? "platform-fork" : "sp-draft",
          lifecycle: "draft",
          visibility: "private",
          ownerUserId: value.userId,
          ownerOrgId: value.orgId,
          payload: revisionPayload,
          provenance: { source: "inline", frozenAt: new Date().toISOString() },
          createdBy: value.userId,
        })
        .returning();
      if (!asset) throw new AppError(ErrorCode.INTERNAL_ERROR, "Script asset insert failed", 500);
      const [revision] = await tx
        .insert(softwareAssetRevisions)
        .values({
          assetId: asset.id,
          revision: 1,
          payload: revisionPayload,
          provenance: { source: "inline" },
          contentSha256: revisionPayload.sha256,
          createdBy: value.userId,
        })
        .returning();
      await tx.insert(softwareAssetGrants).values({
        assetId: asset.id,
        subjectKind: "user",
        subjectId: value.userId,
        capabilities: ["view", "use", "edit", "publish", "admin"],
        reason: "script owner",
        createdBy: value.userId,
      });
      return { asset, revision };
    });
    const tuples: AuthzTuple[] = [
      softwareAssetPlatformTuple(result.asset.id),
      softwareAssetOwnerTuple({ assetId: result.asset.id, userId: value.userId }),
    ];
    if (value.orgId) {
      tuples.push(softwareAssetOwnerOrgTuple({ assetId: result.asset.id, orgId: value.orgId }));
    }
    await deps.authz?.enqueueMany(tuples);
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.script.create",
      target: result.asset.id,
    });
    return c.json({ success: true, data: result }, 201);
  });

  r.get("/sandbox/scripts/:id", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    await assertView(deps, asset, value);
    const revisionIds = db
      .select({ id: softwareAssetRevisions.id })
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, asset.id));
    const [revisions, attestations] = await Promise.all([
      db
        .select()
        .from(softwareAssetRevisions)
        .where(eq(softwareAssetRevisions.assetId, asset.id))
        .orderBy(desc(softwareAssetRevisions.revision)),
      db
        .select()
        .from(scriptAttestations)
        .where(inArray(scriptAttestations.assetRevisionId, revisionIds)),
    ]);
    return c.json({ success: true, data: { asset, revisions, attestations } });
  });

  r.post("/sandbox/scripts/:id/revisions", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    if (!canEdit(asset, value)) throw new AppError(ErrorCode.FORBIDDEN, "Script edit denied", 403);
    const body = RevisionBodySchema.parse(await c.req.json());
    const runtime = await loadRuntime(db, body.runtimeProfileId);
    if (runtime.lifecycle !== "active" || runtime.language !== body.language) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Runtime is not active for this language",
        400,
      );
    }
    const revisionPayload = payload(body);
    const revision = await db.transaction(async (tx) => {
      const [latest] = await tx
        .select()
        .from(softwareAssetRevisions)
        .where(eq(softwareAssetRevisions.assetId, asset.id))
        .orderBy(desc(softwareAssetRevisions.revision))
        .limit(1);
      const [created] = await tx
        .insert(softwareAssetRevisions)
        .values({
          assetId: asset.id,
          revision: (latest?.revision ?? 0) + 1,
          payload: revisionPayload,
          provenance: { source: "inline", changelog: body.changelog },
          contentSha256: revisionPayload.sha256,
          createdBy: value.userId,
        })
        .returning();
      if (!created) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Script revision insert failed", 500);
      }
      await tx
        .update(softwareAssets)
        .set({
          name: body.name,
          payload: revisionPayload,
          version: body.version,
          lifecycle: "draft",
          visibility: "private",
          trustedForGlobalUse: false,
          updatedAt: sql`now()`,
        })
        .where(eq(softwareAssets.id, asset.id));
      return created;
    });
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.script.revision.create",
      target: asset.id,
      diff: {
        before: { name: asset.name, version: asset.version },
        after: {
          name: body.name,
          version: body.version,
          revision: revision.revision,
          sha256: revisionPayload.sha256,
        },
      },
    });
    return c.json({ success: true, data: revision }, 201);
  });

  r.delete("/sandbox/scripts/:id", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    if (!canEdit(asset, value))
      throw new AppError(ErrorCode.FORBIDDEN, "Script delete denied", 403);
    if (asset.lifecycle !== "draft") {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Only draft Sandbox scripts can be deleted",
        400,
      );
    }
    const grants = await loadGrants(db, [asset.id]);
    await db.delete(softwareAssets).where(eq(softwareAssets.id, asset.id));
    const tuples: AuthzTuple[] = [
      { ...softwareAssetPlatformTuple(asset.id), operation: "delete" },
      ...(asset.ownerUserId
        ? [
            {
              ...softwareAssetOwnerTuple({ assetId: asset.id, userId: asset.ownerUserId }),
              operation: "delete" as const,
            },
          ]
        : []),
      ...(asset.ownerOrgId
        ? [
            {
              ...softwareAssetOwnerOrgTuple({ assetId: asset.id, orgId: asset.ownerOrgId }),
              operation: "delete" as const,
            },
          ]
        : []),
      ...grants.flatMap((grant) =>
        softwareAssetGrantTuples({
          assetId: asset.id,
          subjectKind: grant.subjectKind,
          subjectId: grant.subjectId,
          capabilities: grant.capabilities,
          operation: "delete",
        }),
      ),
    ];
    await deps.authz?.enqueueMany(tuples);
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.script.delete",
      target: asset.id,
      diff: { before: { name: asset.name, version: asset.version, lifecycle: asset.lifecycle } },
    });
    return c.json({ success: true });
  });

  r.post("/sandbox/scripts/:id/render-prompt", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    await assertView(deps, asset, value);
    const body = PromptBodySchema.parse(await c.req.json());
    const parsed = SoftwareAssetPayloadSchema.parse(asset.payload);
    if (parsed.kind !== "sandbox-script")
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid script payload", 400);
    if (!parsed.runtimeProfileId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Sandbox script requires a pinned runtime profile",
        400,
      );
    }
    const runtime = await loadRuntime(db, parsed.runtimeProfileId);
    return c.json({
      success: true,
      data: {
        prompt: renderSandboxPrompt({
          ...body,
          language: parsed.language,
          runtimeName: runtime.name,
          runtimeDependencies: runtime.dependencies,
          inputs: parsed.inputs,
          outputs: parsed.outputs,
        }),
      },
    });
  });

  r.post("/sandbox/scripts/:id/test-runs", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    await assertView(deps, asset, value);
    if (!deps.submitTestRun) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Sandbox test runner is unavailable", 503);
    }
    const body = TestRunBodySchema.parse(await c.req.json());
    const [revision] = await db
      .select()
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, asset.id))
      .orderBy(desc(softwareAssetRevisions.revision))
      .limit(1);
    if (!revision?.contentSha256) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Script revision hash is missing", 400);
    }
    const script = SoftwareAssetPayloadSchema.parse(revision.payload);
    if (script.kind !== "sandbox-script") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid script revision payload", 400);
    }
    const parameters: Array<Record<string, unknown>> = [];
    const inputSlots: Array<Record<string, unknown>> = [];
    for (const [descriptor, spec] of Object.entries(script.inputs)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(descriptor)) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Test fixture descriptor '${descriptor}' is not CEL-safe`,
          400,
        );
      }
      const fixture = body.fixtures[descriptor];
      if (fixture === undefined && spec.required) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Required test fixture '${descriptor}' is missing`,
          400,
        );
      }
      if (fixture === undefined) continue;
      if (spec.type === "File" || spec.type === "FileBatch") {
        const contents = Array.isArray(fixture) ? fixture : [fixture];
        inputSlots.push({
          type: "File",
          descriptor,
          contents,
          isBatch: spec.type === "FileBatch",
        });
      } else {
        parameters.push({
          name: descriptor,
          type: spec.type === "JSON" ? "json" : "string",
          default: fixture,
        });
        inputSlots.push({ type: "Text", descriptor, from: { param: descriptor } });
      }
    }
    const yaml = JSON.stringify({
      name: `${asset.name} test`,
      parameters,
      spec: {
        nodeDrafts: [
          {
            type: "Script",
            id: "sandbox_test",
            name: asset.name,
            source: {
              type: "AssetRevision",
              assetId: asset.id,
              revision: revision.revision,
              sha256: revision.contentSha256,
            },
            runtimeProfileId: script.runtimeProfileId,
            executionIdentity: body.mappingId
              ? { type: "MappedAccount", mappingId: body.mappingId }
              : { type: "MappedAuto" },
            schedulingStrategy: { type: "Auto" },
            inputs: script.inputs,
            outputs: script.outputs,
            inputSlots,
          },
        ],
      },
    });
    const result = await deps.submitTestRun({
      yaml,
      submittedBy: value.userId,
      role: value.role as RoleName,
      plannerMode: body.plannerMode,
      ...(body.mappingId ? { mappingId: body.mappingId } : {}),
      authorizeRun: (runId) =>
        registerWorkflowAuthorization(
          deps.authz,
          runId,
          value.userId,
          value.orgId ?? value.orgIds[0] ?? null,
        ),
    });
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.script.test-run",
      target: asset.id,
      diff: { after: { revision: revision.revision, plannerMode: body.plannerMode } },
    });
    return c.json({ success: true, data: result }, 202);
  });

  r.get("/sandbox/scripts/:id/attestations", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    await assertView(deps, asset, value);
    const revisionIds = db
      .select({ id: softwareAssetRevisions.id })
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, asset.id));
    const rows = await db
      .select()
      .from(scriptAttestations)
      .where(inArray(scriptAttestations.assetRevisionId, revisionIds))
      .orderBy(desc(scriptAttestations.signedAt));
    return c.json({ success: true, data: rows });
  });

  r.post("/sandbox/scripts/:id/attestations", async (c) => {
    const value = principal(c);
    const asset = await loadScript(db, c.req.param("id"));
    if (asset.lifecycle !== "published")
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Only published scripts can be attested", 400);
    const body = AttestationBodySchema.parse(await c.req.json());
    const providerOrgId = body.scope.type === "Provider" ? body.scope.providerOrgId : null;
    if (
      body.scope.type === "Platform"
        ? !isPlatform(value)
        : !value.orgIds.includes(body.scope.providerOrgId) ||
          !hasRole(value.role as RoleName, "org_admin")
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Attestation scope denied", 403);
    }
    const runtime = await loadRuntime(db, body.runtimeProfileId);
    if (![runtime.ociDigest, runtime.sifDigest].includes(body.runtimeDigest)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Runtime digest does not match profile", 400);
    }
    const [revision] = await db
      .select()
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, asset.id))
      .orderBy(desc(softwareAssetRevisions.revision))
      .limit(1);
    if (!revision?.contentSha256)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Revision content hash missing", 400);
    const [created] = await db
      .insert(scriptAttestations)
      .values({
        assetRevisionId: revision.id,
        scriptSha256: revision.contentSha256,
        runtimeProfileId: body.runtimeProfileId,
        runtimeDigest: body.runtimeDigest,
        scope: body.scope.type === "Platform" ? "platform" : "provider",
        providerOrgId,
        scanResultHash: body.scanResultHash,
        allowedIdentities: body.allowedIdentities,
        signedBy: value.userId,
        expiresAt: body.expiresAt,
      })
      .returning();
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.script.attestation.create",
      target: asset.id,
      diff: { after: { attestationId: created?.id, providerOrgId } },
    });
    return c.json({ success: true, data: created }, 201);
  });

  r.get("/sandbox/runtime-profiles", async (c) => {
    principal(c);
    const rows = await db
      .select()
      .from(sandboxRuntimeProfiles)
      .orderBy(sandboxRuntimeProfiles.name);
    return c.json({ success: true, data: rows.map(runtimeView) });
  });

  r.post("/sandbox/runtime-profiles", async (c) => {
    const value = principal(c);
    if (!isPlatform(value)) throw new AppError(ErrorCode.FORBIDDEN, "Platform admin required", 403);
    const body = RuntimeBodySchema.parse(await c.req.json());
    if (!body.ociDigest && !body.sifDigest)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Runtime digest required", 400);
    if (body.adapters.includes("kubernetes") && !body.ociDigest)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Kubernetes requires OCI digest", 400);
    if (body.adapters.some((adapter) => adapter !== "kubernetes") && !body.sifDigest)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "HPC adapters require SIF digest", 400);
    const [created] = await db
      .insert(sandboxRuntimeProfiles)
      .values({ ...body, createdBy: value.userId })
      .returning();
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.runtime.create",
      target: created?.id ?? "unknown",
    });
    return c.json({ success: true, data: created ? runtimeView(created) : null }, 201);
  });

  return r;
}
