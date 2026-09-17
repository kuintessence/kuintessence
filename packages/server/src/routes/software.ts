import {
  agents,
  type PgDb,
  softwareAccessRequests,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
  softwareMirrorCache,
  userCapabilities,
} from "@kuintessence/db";
import type {
  OwnershipPrincipal,
  SoftwareAssetCapability,
  SoftwareAssetKind,
  SoftwareAssetSource,
  SoftwareAssetSummary,
  SoftwareAssetVisibility,
} from "@kuintessence/shared";
import {
  AppError,
  authorizeResourceAccess,
  ErrorCode,
  hasRole,
  type MirrorCacheRecord,
  MirrorSpecSchema,
  type RoleName,
  type SoftwareAccessRequest,
  SoftwareAssetCapabilitySchema,
  SoftwareAssetLifecycleSchema,
  SoftwareAssetRefSchema,
  SoftwareAvailabilityRequestSchema,
  SoftwareGrantSubjectSchema,
  UpstreamVersionSupersededReviewStateSchema,
} from "@kuintessence/shared";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  agentOwnedResource,
  agentResourceFromProviderOrg,
  assertOwnedResourceAccess,
  ownershipPrincipalFromContext,
} from "../auth/ownership";
import { requirePlatformPermission } from "../authz/platform-guard";
import {
  softwareAssetGrantTuples,
  softwareAssetPlatformTuple,
  softwareAssetPublicGrantTuples,
} from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { assertRole } from "../middleware/rbac";
import { writeAudit } from "../services/audit-log-writer";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import type { InstalledRegistry } from "../software-governance/installed-registry";
import type { PolicyPusher } from "../software-governance/policy-pusher";
import type { PolicyBundle, PolicyStore, StoredPolicy } from "../software-governance/policy-store";

const PolicyBodySchema = z.object({
  allowList: z.array(z.string().min(1)).default([]),
  denyList: z.array(z.string().min(1)).default([]),
  lockEnabled: z.boolean().default(false),
  mirrors: z.array(MirrorSpecSchema).default([]),
  preinstallList: z.array(z.string().min(1)).default([]),
});

const DistributeBodySchema = z.object({
  spec: z.string().min(1),
  targetAgentIds: z.array(z.string().min(1)).min(1),
  buildcacheUrl: z.string().url().optional(),
  signKeyId: z.string().optional(),
});

const AvailabilityBodySchema = SoftwareAvailabilityRequestSchema.omit({ subject: true });

const SubmitAssetBodySchema = z.object({
  reason: z.string().optional(),
});

const ReviewAssetBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().min(1),
});

const LifecycleBodySchema = z.object({
  lifecycle: SoftwareAssetLifecycleSchema,
  visibility: z
    .enum(["private", "shared-to-orgs", "platform-public", "pending-review", "hidden"])
    .optional(),
  reason: z.string().min(1),
});

const GrantInputSchema = z.object({
  subject: SoftwareGrantSubjectSchema,
  capabilities: z.array(SoftwareAssetCapabilitySchema).min(1),
  reason: z.string().optional(),
});

const GrantsBodySchema = z.object({
  grants: z.array(GrantInputSchema),
});

const CompleteDownstreamBodySchema = z.object({
  assetRef: SoftwareAssetRefSchema,
  subject: SoftwareGrantSubjectSchema.optional(),
  capabilities: z.array(SoftwareAssetCapabilitySchema).default(["use"]),
  reason: z.string().optional(),
});

const AccessRequestCreateBodySchema = z.object({
  assetRef: SoftwareAssetRefSchema,
  capability: z.enum(["view", "use", "install"]),
  subject: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("user"), userId: z.string().min(1) }),
      z.strictObject({ kind: z.literal("org"), orgId: z.string().uuid() }),
    ])
    .optional(),
  reason: z.string().optional(),
});

const AccessRequestReviewBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().min(1),
});

async function parseJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid JSON body", 400);
  }
}

export interface SoftwareRoutesDeps {
  db: PgDb;
  installedRegistry: InstalledRegistry;
  policyStore: PolicyStore;
  policyPusher: PolicyPusher;
  dispatcher: AgentDispatcher;
  availability?: SoftwareAvailabilityService;
  authz?: AuthzService;
}

/**
 * software governance REST surface (PRD F19).
 *
 * Endpoints:
 *  - GET    /api/software/agents/:id/installed   org_admin+ — list installed
 *  - GET    /api/software/policies               org_admin+ — list all policies
 *  - GET    /api/software/policies/:agentId      org_admin+ — single policy
 *  - PUT    /api/software/policies/:agentId      org_admin+ — upsert + push
 *  - POST   /api/software/distribute             org_admin+ — push spec to agents
 *
 * RBAC: org_admin or above. Local/shadow reads and writes are scoped by the
 * Agent provider organization; enforce mode delegates resource access to SpiceDB.
 */
export function createSoftwareRoutes(deps: SoftwareRoutesDeps): Hono {
  const r = new Hono();
  const { db, installedRegistry, policyStore, policyPusher, dispatcher, availability } = deps;

  async function assertAgentAccess(
    c: Context,
    agentId: string,
    resourceType: "agent" | "software_policy",
    action: "read" | "manage",
    permission: "view" | "manage",
  ): Promise<void> {
    requireCanonicalSoftwareRouteActor(c);
    if (deps.authz?.mode !== "enforce") {
      assertRole(c, "org_admin");
    }
    const resource = await agentOwnedResource(db, agentId, resourceType);
    if (!resource) throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    const localAllowed = authorizeResourceAccess(
      ownershipPrincipalFromContext(c),
      resource,
      action,
    ).allowed;
    await checkAgentPermission(c, deps.authz, agentId, permission, localAllowed);
    if (deps.authz?.mode !== "enforce" && !localAllowed) {
      assertOwnedResourceAccess(c, resource, action);
    }
  }

  r.get("/software/agents/:id/installed", async (c) => {
    const agentId = c.req.param("id");
    if (!agentId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId path param required", 400);
    }
    await assertAgentAccess(c, agentId, "agent", "read", "view");
    const rows = await installedRegistry.listForAgent(agentId);
    return c.json({ success: true, data: rows });
  });

  r.get("/software/policies", async (c) => {
    await checkSoftwarePolicyListAccess(c, deps.authz);
    const rows = await policyStore.listAll();
    const visibleRows =
      deps.authz?.mode === "enforce" ? rows : await locallyVisiblePolicies(c, db, rows);
    return c.json({ success: true, data: visibleRows });
  });

  r.get("/software/policies/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!agentId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId path param required", 400);
    }
    await assertAgentAccess(c, agentId, "software_policy", "read", "manage");
    const policy = await policyStore.getForAgent(agentId);
    if (!policy) {
      throw new AppError(ErrorCode.NOT_FOUND, "No policy for this agent", 404);
    }
    return c.json({ success: true, data: policy });
  });

  r.put("/software/policies/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!agentId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId path param required", 400);
    }
    await assertAgentAccess(c, agentId, "software_policy", "manage", "manage");
    const actor = requireCanonicalSoftwareRouteActor(c);
    const body = await parseJson(c);
    const parsed = PolicyBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }
    const bundle: PolicyBundle = {
      allowList: parsed.data.allowList,
      denyList: parsed.data.denyList,
      lockEnabled: parsed.data.lockEnabled,
      mirrors: parsed.data.mirrors,
      preinstallList: parsed.data.preinstallList,
    };
    const stored = await policyStore.upsertForAgent(agentId, bundle);

    // Push to the agent if it's online; if offline, the next reconnect
    // logic in a future commit will lazy-push the latest stored policy.
    let pushed = false;
    if (dispatcher.isOnline(agentId)) {
      pushed = policyPusher.pushToAgent(agentId, {
        version: stored.version,
        allowList: stored.allowList,
        denyList: stored.denyList,
        lockEnabled: stored.lockEnabled,
        mirrors: stored.mirrors,
        preinstallList: stored.preinstallList,
      });
    }

    // Audit log: every policy edit produces one row keyed by canonical actor + agent.
    await writeAudit(db, {
      actor,
      action: "software.policy.upsert",
      target: agentId,
      diff: {
        after: { ...bundle, version: stored.version, pushed },
      },
    });

    return c.json({ success: true, data: stored, pushed });
  });

  r.post("/software/distribute", async (c) => {
    const body = await parseJson(c);
    const parsed = DistributeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }
    const { spec, targetAgentIds, buildcacheUrl, signKeyId } = parsed.data;
    for (const agentId of targetAgentIds) {
      await assertAgentAccess(c, agentId, "software_policy", "manage", "manage");
    }
    const actor = requireCanonicalSoftwareRouteActor(c);
    const results = targetAgentIds.map((agentId) => {
      const ok = policyPusher.pushSpecDistribute(agentId, {
        spec,
        buildcacheUrl: buildcacheUrl ?? "",
        signKeyId,
      });
      return { agentId, pushed: ok };
    });
    await writeAudit(db, {
      actor,
      action: "software.spec.distribute",
      target: spec,
      diff: { after: { targetAgentIds, results } },
    });
    return c.json({ success: true, data: { spec, results } });
  });

  r.post("/software/resolve-availability", async (c) => {
    if (!availability) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Software availability service is not wired",
        500,
      );
    }
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Missing bound principal", 401);
    }
    requireCanonicalPrincipalUserId(principal);
    const body = await parseJson(c);
    const parsed = AvailabilityBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }
    return c.json({ success: true, data: await availability.resolve(parsed.data, principal) });
  });

  r.get("/software/access-requests", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const url = new URL(c.req.url);
    const mine = url.searchParams.get("mine") === "true";
    const status = url.searchParams.get("status");
    const filters = [];
    if (status) filters.push(eq(softwareAccessRequests.status, status));
    if (mine || !hasPlatformRole(principal)) {
      filters.push(eq(softwareAccessRequests.requesterUserId, actorUserId));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;
    const rows = await db
      .select({ request: softwareAccessRequests, asset: softwareAssets })
      .from(softwareAccessRequests)
      .innerJoin(softwareAssets, eq(softwareAccessRequests.assetId, softwareAssets.id))
      .where(where)
      .orderBy(desc(softwareAccessRequests.updatedAt))
      .limit(500);
    return c.json({
      success: true,
      data: rows.map(({ request, asset }) => accessRequestView(request, asset)),
    });
  });

  r.post("/software/access-requests", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const body = AccessRequestCreateBodySchema.parse(await parseJson(c));
    const asset = await resolveAssetRef(db, body.assetRef);
    const subject = body.subject ?? { kind: "user" as const, userId: actorUserId };
    if (
      subject.kind === "org" &&
      !hasPlatformRole(principal) &&
      !principal.orgIds.includes(subject.orgId)
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cannot request access for another org", 403);
    }
    const subjectColumnsValue =
      subject.kind === "user"
        ? { subjectKind: "user" as const, subjectId: subject.userId }
        : { subjectKind: "org" as const, subjectId: subject.orgId };
    const [created] = await db
      .insert(softwareAccessRequests)
      .values({
        assetId: asset.id,
        capability: body.capability,
        requesterUserId: actorUserId,
        requesterOrgId: principal.orgId ?? null,
        ...subjectColumnsValue,
        reason: body.reason ?? null,
      })
      .returning();
    if (!created) throw new AppError(ErrorCode.INTERNAL_ERROR, "Access request insert failed", 500);
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.access_request.create",
      target: asset.id,
      diff: { after: { requestId: created.id, capability: body.capability, subject } },
    });
    return c.json({ success: true, data: accessRequestView(created, asset) }, 201);
  });

  r.post("/software/access-requests/:requestId/review", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const body = AccessRequestReviewBodySchema.parse(await parseJson(c));
    const [loaded] = await db
      .select({ request: softwareAccessRequests, asset: softwareAssets })
      .from(softwareAccessRequests)
      .innerJoin(softwareAssets, eq(softwareAccessRequests.assetId, softwareAssets.id))
      .where(eq(softwareAccessRequests.id, c.req.param("requestId")))
      .limit(1);
    if (!loaded) throw new AppError(ErrorCode.NOT_FOUND, "Access request not found", 404);
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      loaded.asset.id,
      "manage",
      canManageGrants(loaded.asset, principal),
    );
    if (loaded.request.status !== "pending") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Access request already reviewed", 400);
    }
    if (body.decision === "approved") {
      await upsertGrant(
        db,
        loaded.asset.id,
        {
          subjectKind: loaded.request.subjectKind as "user" | "org",
          subjectId: loaded.request.subjectId,
          capabilities: [loaded.request.capability as SoftwareAssetCapability],
          reason: `access request ${loaded.request.id}: ${body.reason}`,
          createdBy: actorUserId,
        },
        deps.authz,
      );
    }
    const [updated] = await db
      .update(softwareAccessRequests)
      .set({
        status: body.decision === "approved" ? "approved" : "rejected",
        decisionReason: body.reason,
        decidedBy: actorUserId,
        decidedAt: new Date(),
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAccessRequests.id, loaded.request.id))
      .returning();
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, "Access request not found", 404);
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.access_request.review",
      target: loaded.asset.id,
      diff: {
        before: accessRequestView(loaded.request, loaded.asset),
        after: accessRequestView(updated, loaded.asset),
      },
    });
    return c.json({ success: true, data: accessRequestView(updated, loaded.asset) });
  });

  r.get("/software/review-queue", async (c) => {
    await requirePlatformPermission(c, deps.authz, "view", "software-review-queue");
    const rows = await db
      .select()
      .from(softwareAssets)
      .where(
        or(
          eq(softwareAssets.lifecycle, "submitted"),
          eq(softwareAssets.visibility, "pending-review"),
        ),
      )
      .orderBy(desc(softwareAssets.updatedAt))
      .limit(500);
    return c.json({ success: true, data: rows.map(assetSummary) });
  });

  r.get("/software/assets/:assetId/review-detail", async (c) => {
    const principal = requireBoundPrincipal(c);
    requireCanonicalPrincipalUserId(principal);
    const asset = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      asset.id,
      "manage",
      hasPlatformRole(principal),
    );
    const [latest, previous, fork, impact] = await Promise.all([
      latestRevision(db, asset.id),
      previousRevision(db, asset.id),
      findOfficialFork(db, asset.id),
      loadAssetImpact(db, asset),
    ]);
    return c.json({
      success: true,
      data: {
        asset: assetSummary(asset),
        latestRevision: latest ? revisionView(latest) : null,
        previousRevision: previous ? revisionView(previous) : null,
        officialFork: fork ? assetSummary(fork) : null,
        dependencyRefs: collectDownstreamRefs(asset.payload),
        impact,
      },
    });
  });

  r.get("/software/assets/:assetId/impact", async (c) => {
    const principal = requireBoundPrincipal(c);
    requireCanonicalPrincipalUserId(principal);
    const asset = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      asset.id,
      "manage",
      canManageGrants(asset, principal),
    );
    return c.json({ success: true, data: await loadAssetImpact(db, asset) });
  });

  r.get("/software/mirror-cache/status", async (c) => {
    await requirePlatformPermission(c, deps.authz, "view", "software-mirror-cache");
    const assetId = new URL(c.req.url).searchParams.get("assetId");
    const rows = assetId
      ? await db
          .select()
          .from(softwareMirrorCache)
          .where(eq(softwareMirrorCache.assetId, assetId))
          .orderBy(desc(softwareMirrorCache.updatedAt))
          .limit(500)
      : await db
          .select()
          .from(softwareMirrorCache)
          .orderBy(desc(softwareMirrorCache.updatedAt))
          .limit(500);
    return c.json({ success: true, data: rows.map(mirrorCacheView) });
  });

  r.post("/software/assets/:assetId/submit", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const body = SubmitAssetBodySchema.parse(await parseJson(c));
    const asset = await loadAsset(db, c.req.param("assetId"));
    await assertCanSubmitAsset(db, asset, principal);
    await checkSoftwareAssetPermission(c, deps.authz, principal, asset.id, "manage", true);
    const [updated] = await db
      .update(softwareAssets)
      .set({
        lifecycle: "submitted",
        visibility: "pending-review",
        reviewState: {
          submittedBy: actorUserId,
          submittedAt: new Date().toISOString(),
          reason: body.reason ?? null,
        },
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAssets.id, asset.id))
      .returning();
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, "Asset not found", 404);
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.asset.submit",
      target: asset.id,
      diff: { before: assetSummary(asset), after: assetSummary(updated) },
    });
    return c.json({ success: true, data: assetSummary(updated) });
  });

  r.post("/software/assets/:assetId/review", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const body = ReviewAssetBodySchema.parse(await parseJson(c));
    const asset = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      asset.id,
      "manage",
      hasPlatformRole(principal),
    );
    const [updated] = await db
      .update(softwareAssets)
      .set({
        lifecycle: body.decision === "approved" ? "approved" : "archived",
        visibility: body.decision === "approved" ? "pending-review" : "hidden",
        reviewState: {
          ...(asset.reviewState ?? {}),
          decision: body.decision,
          reason: body.reason,
          reviewedBy: actorUserId,
          reviewedAt: new Date().toISOString(),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAssets.id, asset.id))
      .returning();
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, "Asset not found", 404);
    await enqueueSoftwareAssetDerivedReplacement(deps.authz, db, asset, updated);
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.asset.review",
      target: asset.id,
      diff: { before: assetSummary(asset), after: assetSummary(updated) },
    });
    return c.json({ success: true, data: assetSummary(updated) });
  });

  r.post("/software/assets/:assetId/fork-official", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const source = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      source.id,
      "manage",
      hasPlatformRole(principal),
    );
    const existing = await findOfficialFork(db, source.id);
    if (existing) return c.json({ success: true, data: assetSummary(existing), reused: true });
    const [fork] = await db
      .insert(softwareAssets)
      .values({
        kind: source.kind,
        name: source.name,
        version: source.version,
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        payload: source.payload,
        provenance: {
          ...(source.provenance ?? {}),
          source: "platform-fork",
          officialForkOfAssetId: source.id,
        },
        trustedForGlobalUse: true,
        officialForkOfAssetId: source.id,
        createdBy: actorUserId,
      })
      .returning();
    if (!fork) throw new AppError(ErrorCode.INTERNAL_ERROR, "Official fork insert failed", 500);
    await enqueueSoftwareAssetDerivedCreate(deps.authz, fork);
    const latest = await latestRevision(db, source.id);
    await db.insert(softwareAssetRevisions).values({
      assetId: fork.id,
      revision: 1,
      payload: latest?.payload ?? source.payload,
      provenance: {
        ...(latest?.provenance ?? source.provenance ?? {}),
        source: "platform-fork",
        officialForkOfAssetId: source.id,
      },
      recipeSha256: latest?.recipeSha256 ?? null,
      createdBy: actorUserId,
    });
    await upsertGrant(
      db,
      fork.id,
      {
        subjectKind: "platform",
        subjectId: "platform",
        capabilities: ["view", "use", "install"],
        reason: "official platform fork",
        createdBy: actorUserId,
      },
      deps.authz,
    );
    const [updatedSource] = await db
      .update(softwareAssets)
      .set({
        lifecycle: "forked",
        visibility: "hidden",
        reviewState: {
          ...(source.reviewState ?? {}),
          officialForkAssetId: fork.id,
          forkedBy: actorUserId,
          forkedAt: new Date().toISOString(),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAssets.id, source.id))
      .returning();
    if (updatedSource) {
      await enqueueSoftwareAssetDerivedReplacement(deps.authz, db, source, updatedSource);
    }
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.asset.fork_official",
      target: source.id,
      diff: {
        before: assetSummary(source),
        after: {
          source: updatedSource ? assetSummary(updatedSource) : null,
          fork: assetSummary(fork),
        },
      },
    });
    return c.json({ success: true, data: assetSummary(fork), reused: false });
  });

  r.post("/software/assets/:assetId/lifecycle", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const body = LifecycleBodySchema.parse(await parseJson(c));
    const asset = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      asset.id,
      "manage",
      hasPlatformRole(principal),
    );
    const visibility = body.visibility ?? lifecycleVisibility(body.lifecycle);
    if (isGovernedSupersededUpstreamAsset(asset)) {
      if (body.lifecycle === "archived" && visibility === "hidden") {
        return c.json({ success: true, data: assetSummary(asset) });
      }
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "A superseded upstream asset must remain archived and hidden",
        409,
      );
    }
    const [updated] = await db
      .update(softwareAssets)
      .set({
        lifecycle: body.lifecycle,
        visibility,
        reviewState: {
          ...(asset.reviewState ?? {}),
          lifecycleReason: body.reason,
          lifecycleChangedBy: actorUserId,
          lifecycleChangedAt: new Date().toISOString(),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAssets.id, asset.id))
      .returning();
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, "Asset not found", 404);
    await enqueueSoftwareAssetDerivedReplacement(deps.authz, db, asset, updated);
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.asset.lifecycle",
      target: asset.id,
      diff: { before: assetSummary(asset), after: assetSummary(updated) },
    });
    return c.json({ success: true, data: assetSummary(updated) });
  });

  r.get("/software/assets/:assetId/grants", async (c) => {
    const principal = requireBoundPrincipal(c);
    requireCanonicalPrincipalUserId(principal);
    const asset = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      asset.id,
      "manage",
      canManageGrants(asset, principal),
    );
    const grants = await db
      .select()
      .from(softwareAssetGrants)
      .where(eq(softwareAssetGrants.assetId, asset.id))
      .orderBy(desc(softwareAssetGrants.createdAt));
    return c.json({ success: true, data: grants.map(grantView) });
  });

  r.put("/software/assets/:assetId/grants", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const asset = await loadAsset(db, c.req.param("assetId"));
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      asset.id,
      "manage",
      canManageGrants(asset, principal),
    );
    const body = GrantsBodySchema.parse(await parseJson(c));
    const existingGrants = await db
      .select()
      .from(softwareAssetGrants)
      .where(eq(softwareAssetGrants.assetId, asset.id));
    await deps.authz?.enqueueMany(
      existingGrants.flatMap((grant) => softwareGrantTuples(grant, "delete")),
    );
    await db.delete(softwareAssetGrants).where(eq(softwareAssetGrants.assetId, asset.id));
    for (const grant of body.grants) {
      const subject = subjectColumns(grant.subject);
      await upsertGrant(
        db,
        asset.id,
        {
          ...subject,
          capabilities: grant.capabilities,
          reason: grant.reason ?? null,
          createdBy: actorUserId,
        },
        deps.authz,
      );
    }
    const grants = await db
      .select()
      .from(softwareAssetGrants)
      .where(eq(softwareAssetGrants.assetId, asset.id));
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.asset.grants.replace",
      target: asset.id,
      diff: { after: grants.map(grantView) },
    });
    return c.json({ success: true, data: grants.map(grantView) });
  });

  r.post("/software/grants/complete-downstream", async (c) => {
    const principal = requireBoundPrincipal(c);
    const actorUserId = requireCanonicalPrincipalUserId(principal);
    const body = CompleteDownstreamBodySchema.parse(await parseJson(c));
    const root = await resolveAssetRef(db, body.assetRef);
    await checkSoftwareAssetPermission(
      c,
      deps.authz,
      principal,
      root.id,
      "manage",
      canManageGrants(root, principal),
    );
    const subject = body.subject
      ? subjectColumns(body.subject)
      : defaultGrantSubject(root, principal);
    const downstream = await loadDownstreamAssets(db, root);
    const completed: SoftwareAssetSummary[] = [];
    for (const target of downstream) {
      const existing = await db
        .select()
        .from(softwareAssetGrants)
        .where(
          and(
            eq(softwareAssetGrants.assetId, target.id),
            eq(softwareAssetGrants.subjectKind, subject.subjectKind),
            eq(softwareAssetGrants.subjectId, subject.subjectId),
          ),
        )
        .limit(1);
      const capabilities = mergeCapabilities(existing[0]?.capabilities ?? [], body.capabilities);
      if (sameCapabilities(existing[0]?.capabilities ?? [], capabilities)) continue;
      await upsertGrant(
        db,
        target.id,
        {
          ...subject,
          capabilities,
          reason: body.reason ?? `downstream grant completion from ${root.id}`,
          createdBy: actorUserId,
        },
        deps.authz,
      );
      completed.push(assetSummary(target));
    }
    await writeAudit(db, {
      actor: actorUserId,
      action: "software.asset.grants.complete_downstream",
      target: root.id,
      diff: { after: { subject, completed } },
    });
    return c.json({ success: true, data: { root: assetSummary(root), completed } });
  });

  return r;
}

type SoftwareAssetRow = typeof softwareAssets.$inferSelect;

function requireBoundPrincipal(c: Context): BoundPrincipal {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal) throw new AppError(ErrorCode.UNAUTHORIZED, "Missing bound principal", 401);
  return principal;
}

function requireCanonicalPrincipalUserId(principal: BoundPrincipal): string {
  if (!principal.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

async function loadAsset(db: PgDb, assetId: string): Promise<SoftwareAssetRow> {
  const [asset] = await db
    .select()
    .from(softwareAssets)
    .where(eq(softwareAssets.id, assetId))
    .limit(1);
  if (!asset) throw new AppError(ErrorCode.NOT_FOUND, "Software asset not found", 404);
  return asset;
}

async function resolveAssetRef(
  db: PgDb,
  ref: z.infer<typeof SoftwareAssetRefSchema>,
): Promise<SoftwareAssetRow> {
  if (ref.id) return loadAsset(db, ref.id);
  const conditions = [eq(softwareAssets.kind, ref.kind)];
  if (ref.name) conditions.push(eq(softwareAssets.name, ref.name));
  if (ref.version) conditions.push(eq(softwareAssets.version, ref.version));
  if (ref.source) conditions.push(eq(softwareAssets.source, ref.source));
  const [asset] = await db
    .select()
    .from(softwareAssets)
    .where(and(...conditions))
    .limit(1);
  if (!asset) throw new AppError(ErrorCode.NOT_FOUND, "Software asset ref not found", 404);
  return asset;
}

async function assertCanSubmitAsset(
  db: PgDb,
  asset: SoftwareAssetRow,
  principal: BoundPrincipal,
): Promise<void> {
  if (principal.role === "super_admin" || principal.role === "platform_admin") return;
  const actorUserId = requireCanonicalPrincipalUserId(principal);
  const owns =
    asset.ownerUserId === actorUserId ||
    asset.supplierUserId === actorUserId ||
    (asset.ownerOrgId ? principal.orgIds.includes(asset.ownerOrgId) : false) ||
    (asset.supplierOrgId ? principal.orgIds.includes(asset.supplierOrgId) : false);
  if (!owns) {
    throw new AppError(ErrorCode.FORBIDDEN, "Cannot submit an asset owned by another subject", 403);
  }
  if (principal.role === "org_admin") return;
  const [capability] = await db
    .select()
    .from(userCapabilities)
    .where(
      and(
        eq(userCapabilities.userId, actorUserId),
        eq(userCapabilities.capability, "software_provider"),
      ),
    )
    .limit(1);
  if (!capability) {
    throw new AppError(ErrorCode.FORBIDDEN, "software_provider capability is required", 403);
  }
}

function canManageGrants(asset: SoftwareAssetRow, principal: BoundPrincipal): boolean {
  if (principal.role === "super_admin" || principal.role === "platform_admin") return true;
  const actorUserId = principal.userId;
  if (actorUserId && (asset.ownerUserId === actorUserId || asset.supplierUserId === actorUserId)) {
    return true;
  }
  if (asset.ownerOrgId && principal.orgIds.includes(asset.ownerOrgId)) return true;
  if (asset.providerOrgId && principal.orgIds.includes(asset.providerOrgId)) return true;
  return false;
}

async function findOfficialFork(db: PgDb, assetId: string): Promise<SoftwareAssetRow | null> {
  const [row] = await db
    .select()
    .from(softwareAssets)
    .where(eq(softwareAssets.officialForkOfAssetId, assetId))
    .limit(1);
  return row ?? null;
}

async function latestRevision(db: PgDb, assetId: string) {
  const [row] = await db
    .select()
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.assetId, assetId))
    .orderBy(desc(softwareAssetRevisions.revision))
    .limit(1);
  return row ?? null;
}

async function previousRevision(db: PgDb, assetId: string) {
  const rows = await db
    .select()
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.assetId, assetId))
    .orderBy(desc(softwareAssetRevisions.revision))
    .limit(2);
  return rows[1] ?? null;
}

function lifecycleVisibility(
  lifecycle: z.infer<typeof SoftwareAssetLifecycleSchema>,
): SoftwareAssetVisibility {
  if (lifecycle === "published") return "platform-public";
  if (lifecycle === "submitted") return "pending-review";
  if (lifecycle === "hidden" || lifecycle === "revoked" || lifecycle === "archived") {
    return "hidden";
  }
  return "private";
}

function isGovernedSupersededUpstreamAsset(asset: SoftwareAssetRow): boolean {
  if (
    asset.kind !== "spack-package" ||
    asset.source !== "official-upstream" ||
    asset.lifecycle !== "archived" ||
    asset.visibility !== "hidden"
  ) {
    return false;
  }
  const reviewState = UpstreamVersionSupersededReviewStateSchema.safeParse(asset.reviewState);
  return (
    reviewState.success &&
    reviewState.data.upstreamVersionSupersession.canonicalIdentity ===
      `${asset.source}/${asset.name}/${asset.version}`
  );
}

function hasPlatformRole(principal: BoundPrincipal): boolean {
  return principal.role === "super_admin" || principal.role === "platform_admin";
}

function hasPlatformFallbackRole(
  principal: BoundPrincipal | undefined,
  user: { role: RoleName },
): boolean {
  return hasRole(localSoftwareRole(user, principal), "platform_admin");
}

export function localSoftwareRole(
  _user: { role: RoleName },
  principal: Pick<BoundPrincipal, "role"> | undefined,
): RoleName {
  return (principal?.role ?? "guest") as RoleName;
}

function requireCanonicalSoftwareRouteActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

async function checkAgentPermission(
  c: Context,
  authz: AuthzService | undefined,
  agentId: string,
  permission: "view" | "manage",
  localAllowed: boolean,
): Promise<void> {
  if (!authz || authz.mode === "off") return;
  const user = c.get("user") as { sub: string; email?: string; role: RoleName };
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const subjectId = subjectIdForSoftwareAuthz(authz, principal?.userId ?? null);
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: principal?.userId ?? null,
    actorEmail: principal?.email ?? null,
    resource: { type: "agent", id: agentId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source: "software-governance", path: c.req.path },
    localAllowed,
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    return;
  }
  await authz.requirePermission(check, hasPlatformFallbackRole(principal, user));
}

async function checkSoftwarePolicyListAccess(
  c: Context,
  authz: AuthzService | undefined,
): Promise<void> {
  const user = c.get("user") as { sub: string; email?: string; role: RoleName };
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const localAllowed = hasRole(localSoftwareRole(user, principal), "org_admin");
  if (!authz || authz.mode === "off") {
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Need org_admin", 403);
    }
    return;
  }
  const subjectId = subjectIdForSoftwareAuthz(authz, principal?.userId ?? null);
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: principal?.userId ?? null,
    actorEmail: principal?.email ?? null,
    resource: { type: "platform", id: "root" },
    permission: "view",
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source: "software-policies" },
    localAllowed,
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Need org_admin", 403);
    }
    return;
  }
  await authz.requirePermission(check, hasPlatformFallbackRole(principal, user));
}

async function locallyVisiblePolicies(
  c: Context,
  db: PgDb,
  rows: StoredPolicy[],
): Promise<StoredPolicy[]> {
  const principal = ownershipPrincipalFromContext(c);
  if (principal && hasRole(principal.role, "platform_admin")) return rows;
  const agentRows = await db
    .select({ agentId: agents.agentId, providerOrgId: agents.providerOrgId })
    .from(agents);
  const providerOrgByAgent = new Map(
    agentRows.map((agent) => [agent.agentId, agent.providerOrgId] as const),
  );
  return rows.filter((row) => {
    if (!providerOrgByAgent.has(row.agentId)) return false;
    return softwarePolicyVisibleToPrincipal(
      principal,
      row.agentId,
      providerOrgByAgent.get(row.agentId),
    );
  });
}

export function softwarePolicyVisibleToPrincipal(
  principal: OwnershipPrincipal | null,
  agentId: string,
  providerOrgId: string | null | undefined,
): boolean {
  const resource = agentResourceFromProviderOrg(agentId, "software_policy", providerOrgId);
  return resource ? authorizeResourceAccess(principal, resource, "read").allowed : false;
}

export function subjectIdForSoftwareAuthz(
  authz: AuthzService | undefined,
  actorUserId: string | null,
): string | null {
  if (!authz || authz.mode === "off") {
    return actorUserId;
  }
  return actorUserId;
}

async function checkSoftwareAssetPermission(
  c: Context,
  authz: AuthzService | undefined,
  principal: BoundPrincipal,
  assetId: string,
  permission: "view" | "use" | "install" | "manage",
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") {
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
    }
    return true;
  }
  const subjectId = principal.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: principal.userId,
    actorEmail: principal.email,
    resource: { type: "software_asset", id: assetId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { route: `software_asset#${permission}`, path: c.req.path },
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    if (!localAllowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
    }
    return true;
  }
  await authz.requirePermission(check, hasPlatformRole(principal));
  return true;
}

function assetSummary(row: SoftwareAssetRow): SoftwareAssetSummary {
  return {
    id: row.id,
    kind: row.kind as SoftwareAssetKind,
    name: row.name,
    version: row.version,
    source: row.source as SoftwareAssetSource,
    lifecycle: row.lifecycle as z.infer<typeof SoftwareAssetLifecycleSchema>,
    visibility: row.visibility as SoftwareAssetVisibility,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    providerOrgId: row.providerOrgId,
    supplierUserId: row.supplierUserId,
    supplierOrgId: row.supplierOrgId,
    officialForkOfAssetId: row.officialForkOfAssetId,
    trustedForGlobalUse: row.trustedForGlobalUse,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function accessRequestView(
  row: typeof softwareAccessRequests.$inferSelect,
  asset: SoftwareAssetRow,
): SoftwareAccessRequest {
  return {
    id: row.id,
    asset: assetSummary(asset),
    capability: row.capability as "view" | "use" | "install",
    requesterUserId: row.requesterUserId,
    requesterOrgId: row.requesterOrgId,
    subject:
      row.subjectKind === "org"
        ? { kind: "org", orgId: row.subjectId }
        : { kind: "user", userId: row.subjectId },
    status: row.status as SoftwareAccessRequest["status"],
    reason: row.reason,
    decisionReason: row.decisionReason,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function revisionView(row: typeof softwareAssetRevisions.$inferSelect) {
  return {
    id: row.id,
    assetId: row.assetId,
    revision: row.revision,
    payload: row.payload,
    provenance: row.provenance,
    recipeSha256: row.recipeSha256,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function subjectColumns(subject: z.infer<typeof SoftwareGrantSubjectSchema>) {
  if (subject.kind === "platform") {
    return { subjectKind: "platform" as const, subjectId: "platform" };
  }
  if (subject.kind === "user") return { subjectKind: "user" as const, subjectId: subject.userId };
  if (subject.kind === "org") return { subjectKind: "org" as const, subjectId: subject.orgId };
  return { subjectKind: "provider-org" as const, subjectId: subject.orgId };
}

async function upsertGrant(
  db: PgDb,
  assetId: string,
  grant: {
    subjectKind: "user" | "org" | "provider-org" | "platform";
    subjectId: string;
    capabilities: SoftwareAssetCapability[];
    reason?: string | null;
    createdBy?: string | null;
  },
  authz?: AuthzService,
): Promise<typeof softwareAssetGrants.$inferSelect> {
  const [existing] = await db
    .select()
    .from(softwareAssetGrants)
    .where(
      and(
        eq(softwareAssetGrants.assetId, assetId),
        eq(softwareAssetGrants.subjectKind, grant.subjectKind),
        eq(softwareAssetGrants.subjectId, grant.subjectId),
      ),
    )
    .limit(1);
  if (existing) {
    await authz?.enqueueMany(softwareGrantTuples(existing, "delete"));
  }
  const [updated] = await db
    .insert(softwareAssetGrants)
    .values({
      assetId,
      subjectKind: grant.subjectKind,
      subjectId: grant.subjectId,
      capabilities: mergeCapabilities([], grant.capabilities),
      reason: grant.reason ?? null,
      createdBy: grant.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        softwareAssetGrants.assetId,
        softwareAssetGrants.subjectKind,
        softwareAssetGrants.subjectId,
      ],
      set: {
        capabilities: mergeCapabilities([], grant.capabilities),
        reason: grant.reason ?? null,
      },
    })
    .returning();
  if (!updated) throw new AppError(ErrorCode.INTERNAL_ERROR, "Software grant upsert failed", 500);
  await authz?.enqueueMany(softwareGrantTuples(updated, "create"));
  return updated;
}

function softwareGrantTuples(
  grant: typeof softwareAssetGrants.$inferSelect,
  operation: "create" | "delete",
): AuthzTuple[] {
  return softwareAssetGrantTuples({
    assetId: grant.assetId,
    subjectKind: grant.subjectKind,
    subjectId: grant.subjectId,
    capabilities: grant.capabilities,
    operation,
  });
}

async function enqueueSoftwareAssetDerivedCreate(
  authz: AuthzService | undefined,
  asset: SoftwareAssetRow,
): Promise<void> {
  await authz?.enqueueMany(softwareAssetDerivedTuples(asset, "create"));
}

async function enqueueSoftwareAssetDerivedReplacement(
  authz: AuthzService | undefined,
  db: PgDb,
  before: SoftwareAssetRow,
  after: SoftwareAssetRow,
): Promise<void> {
  if (!authz) return;
  const grants = await db
    .select()
    .from(softwareAssetGrants)
    .where(eq(softwareAssetGrants.assetId, after.id));
  await authz.enqueueMany([
    ...softwareAssetDerivedTuples(before, "delete"),
    ...softwareAssetDerivedTuples(after, "create"),
    ...grants.flatMap((grant) => softwareGrantTuples(grant, "create")),
  ]);
}

function softwareAssetDerivedTuples(
  asset: SoftwareAssetRow,
  operation: "create" | "delete",
): AuthzTuple[] {
  const tuples: AuthzTuple[] = [{ ...softwareAssetPlatformTuple(asset.id), operation }];
  if (
    asset.visibility === "platform-public" &&
    (operation === "delete" || asset.lifecycle === "published")
  ) {
    tuples.push(
      ...softwareAssetPublicGrantTuples({
        assetId: asset.id,
        trustedForGlobalUse: asset.trustedForGlobalUse,
        operation,
      }),
    );
  }
  return tuples;
}

function grantView(row: typeof softwareAssetGrants.$inferSelect) {
  return {
    id: row.id,
    assetId: row.assetId,
    subject: { kind: row.subjectKind, id: row.subjectId },
    capabilities: row.capabilities,
    inheritedFromAssetId: row.inheritedFromAssetId,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function defaultGrantSubject(asset: SoftwareAssetRow, principal: BoundPrincipal) {
  if (asset.ownerOrgId) return { subjectKind: "org" as const, subjectId: asset.ownerOrgId };
  const orgId = principal.orgId;
  if (orgId) return { subjectKind: "org" as const, subjectId: orgId };
  return { subjectKind: "user" as const, subjectId: requireCanonicalPrincipalUserId(principal) };
}

async function loadDownstreamAssets(db: PgDb, root: SoftwareAssetRow): Promise<SoftwareAssetRow[]> {
  const refs = collectDownstreamRefs(root.payload);
  const rows: SoftwareAssetRow[] = [];
  for (const ref of refs) {
    try {
      rows.push(await resolveAssetRef(db, ref));
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) continue;
      throw err;
    }
  }
  return rows;
}

async function loadAssetImpact(db: PgDb, root: SoftwareAssetRow) {
  const [allAssets, grants, pendingRequests, mirrorRows] = await Promise.all([
    db.select().from(softwareAssets),
    db.select().from(softwareAssetGrants).where(eq(softwareAssetGrants.assetId, root.id)),
    db
      .select()
      .from(softwareAccessRequests)
      .where(
        and(
          eq(softwareAccessRequests.assetId, root.id),
          eq(softwareAccessRequests.status, "pending"),
        ),
      ),
    db.select().from(softwareMirrorCache).where(eq(softwareMirrorCache.assetId, root.id)),
  ]);
  const downstream = allAssets
    .filter((asset) => asset.id !== root.id && payloadReferencesAsset(asset.payload, root))
    .map(assetSummary);
  const explanations = [];
  if (root.lifecycle === "revoked") {
    explanations.push("revoked asset blocks new runs");
  } else if (root.lifecycle === "deprecated") {
    explanations.push("deprecated asset remains runnable but should be replaced");
  }
  if (downstream.length > 0) {
    explanations.push(`${downstream.length} downstream assets reference this asset`);
  }
  return {
    asset: assetSummary(root),
    downstream,
    grants: grants.length,
    pendingRequests: pendingRequests.length,
    mirrorCache: mirrorRows.map(mirrorCacheView),
    explanations,
  };
}

function payloadReferencesAsset(
  payload: Record<string, unknown>,
  target: SoftwareAssetRow,
): boolean {
  return collectDownstreamRefs(payload).some((ref) => {
    if (ref.id && ref.id === target.id) return true;
    if (ref.kind !== target.kind) return false;
    if (ref.name && ref.name !== target.name) return false;
    if (ref.version && ref.version !== target.version) return false;
    if (ref.source && ref.source !== target.source) return false;
    return Boolean(ref.name || ref.version || ref.source);
  });
}

function mirrorCacheView(row: typeof softwareMirrorCache.$inferSelect): MirrorCacheRecord {
  return {
    kind: row.kind as MirrorCacheRecord["kind"],
    status: row.status as MirrorCacheRecord["status"],
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    ...(row.localUrl ? { localUrl: row.localUrl } : {}),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.cachedAt ? { cachedAt: row.cachedAt.toISOString() } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function collectDownstreamRefs(
  payload: Record<string, unknown>,
): Array<z.infer<typeof SoftwareAssetRefSchema>> {
  const refs: Array<z.infer<typeof SoftwareAssetRefSchema>> = [];
  for (const key of ["usecaseRefs", "packageRefs"]) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const parsed = SoftwareAssetRefSchema.safeParse(item);
      if (parsed.success) refs.push(parsed.data);
    }
  }
  return refs;
}

function mergeCapabilities(
  current: string[],
  next: SoftwareAssetCapability[],
): SoftwareAssetCapability[] {
  return [...new Set([...current, ...next])].filter(isSoftwareAssetCapability).sort();
}

function sameCapabilities(left: string[], right: SoftwareAssetCapability[]): boolean {
  const normalizedLeft = left.filter(isSoftwareAssetCapability).sort();
  return (
    normalizedLeft.length === right.length &&
    normalizedLeft.every((value, index) => value === right[index])
  );
}

function isSoftwareAssetCapability(value: string): value is SoftwareAssetCapability {
  return SoftwareAssetCapabilitySchema.safeParse(value).success;
}
