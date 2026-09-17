// `/api/cp/*` REST surface for the Compute Provider console.
//
// Every route here applies `cpRbac()` middleware, which sets `cpScope`
// on the Hono context. Handlers read `cpScope` and pass it to the
// CpConsoleService for tenant-scoped operations.

import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AuthzService } from "../authz/service";
import { type CpScope, cpRbac } from "../middleware/cp-rbac";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { AgentRegistrationService } from "../services/agent-registration";
import type { CpConsoleService } from "../services/cp-console";
import {
  isLegacyCpGovernanceWrite,
  rejectLegacyCpGovernanceWrite,
} from "../services/cp-governance-write-gate";
import type {
  CpDataImportInput,
  DataAccessReviewInput,
  DataAssetInput,
  DataMarketService,
} from "../services/data-market";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import type { SoftwareOperationService, SoftwareOperationView } from "../software-governance";
import type { CertIssuanceService } from "./admin-agents";
import {
  CpDataImportInputSchema,
  DataMarketAssetInputSchema,
  DataMarketReplicaInputSchema,
} from "./data-market";

export interface CpRoutesDeps {
  consoleService: CpConsoleService;
  availability?: SoftwareAvailabilityService;
  softwareOperations?: SoftwareOperationService;
  agentRegistration?: AgentRegistrationService;
  agentCerts?: Pick<CertIssuanceService, "listCerts" | "revokeCert">;
  authz?: AuthzService;
  dataMarket?: DataMarketService;
}

const SoftwarePolicyEditSchema = z.object({
  cluster: z.string().min(1),
  list: z.enum(["whitelist", "blacklist"]),
  specs: z.array(z.string()).min(0).max(2000),
});

const InstallModeSchema = z.enum([
  "preinstalled-only",
  "trusted-public-auto-install",
  "explicit-install-grant",
]);

const MirrorSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  priority: z.number().int().nonnegative().optional(),
});

const PolicyOverlayBaseSchema = z.object({
  providerOrgId: z.string().uuid().optional(),
  installMode: InstallModeSchema,
  allowList: z.array(z.string()).default([]),
  denyList: z.array(z.string()).default([]),
  lockEnabled: z.boolean(),
  trustedPublicAutoInstall: z.boolean().default(false),
  usecaseDefaultAllow: z.boolean().default(true),
  usecaseAllowList: z.array(z.string()).default([]),
  usecaseDenyList: z.array(z.string()).default([]),
  mirrors: z.array(MirrorSchema).default([]),
  preinstallList: z.array(z.string()).default([]),
});

const PolicyOverlaySchema = PolicyOverlayBaseSchema.superRefine(validatePolicyOverlayConflicts);
const AgentPolicyOverlaySchema = PolicyOverlayBaseSchema.omit({
  providerOrgId: true,
}).superRefine(validatePolicyOverlayConflicts);
const ClusterPolicyOverlaySchema = PolicyOverlayBaseSchema.omit({
  providerOrgId: true,
}).superRefine(validatePolicyOverlayConflicts);

const AvailabilityPreviewSchema = z.object({
  rawSpec: z.string().trim().min(1),
  usecaseRef: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  targetAgentIds: z.array(z.string()).optional(),
  installable: z.boolean().default(true),
});

const SoftwareOperationActionSchema = z.enum([
  "install",
  "uninstall",
  "load",
  "import_preinstalled",
]);
const MAX_SOFTWARE_OPERATION_BATCH_SPECS = 200;
const MAX_SOFTWARE_OPERATION_BATCH_RAW_LINES = 2000;

const SoftwareOperationRequestSchema = z.object({
  agentId: z.string().min(1),
  action: SoftwareOperationActionSchema,
  spec: z.string().trim().min(1),
});

const SoftwareOperationBatchRequestSchema = z.object({
  agentId: z.string().min(1),
  action: z.enum(["install", "import_preinstalled"]),
  specs: z.array(z.string()).min(1).max(MAX_SOFTWARE_OPERATION_BATCH_RAW_LINES),
});

const SoftwareOperationListQuerySchema = z.object({
  agentId: z.string().optional(),
  action: SoftwareOperationActionSchema.optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const PreinstalledMappingReviewSchema = z.object({
  agentId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

const UsersListQuerySchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const UserSuspendSchema = z.object({ suspended: z.boolean() });
const UserQuotaSchema = z.object({ quota: z.number().int().min(0) });

const AuditSearchSchema = z.object({
  from: z.string(),
  to: z.string(),
  text: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const AgentRegistrationTokenCreateSchema = z.object({
  providerOrgId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(255),
  siteName: z.string().min(1).max(255),
  expiresInSec: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 60 * 60)
    .default(24 * 60 * 60),
});

const AgentCertRevokeSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const CpDataPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    query: z.string().trim().min(1).max(200).optional(),
    tag: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const CpDataAccessRequestQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(["pending", "approved", "rejected", "canceled", "expired"]).optional(),
  })
  .strict();

const CpDataAccessReviewSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
      reason: z.string().trim().min(1).max(2000).optional(),
      expiresAt: z
        .string()
        .datetime()
        .transform((value) => new Date(value))
        .optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      reason: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
]);

const AGENT_REGISTRATION_SCHEDULERS = ["slurm", "pbs-pro", "torque", "kubernetes"] as const;

export function buildCpRouter(deps: CpRoutesDeps) {
  const r = new Hono<{ Variables: { principal?: unknown; cpScope?: CpScope } }>();
  r.use(
    "*",
    cpRbac({
      allowEmptyScope: deps.authz?.mode === "enforce" ? isDeferredCpAgentAuthorizationRoute : false,
    }),
  );
  r.use("*", async (c, next) => {
    if (isCpMutation(c.req.method, c.req.path)) {
      const scope = c.get("cpScope") as CpScope;
      const resourceAuthorization = cpResourceMutationAuthorization(c.req.method, c.req.path);
      const requiresLocalManage =
        resourceAuthorization === null ||
        (resourceAuthorization === "manage" && deps.authz?.mode !== "enforce");
      if (requiresLocalManage) requireCpManage(scope);
      if (isLegacyCpGovernanceWrite(c.req.method, c.req.path)) {
        rejectLegacyCpGovernanceWrite();
      }
      requireActiveOrganizationForCpMutation(scope);
    }
    await next();
  });

  r.get("/dashboard", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const kpis = await deps.consoleService.getDashboardKpis(scope);
    return c.json({ kpis });
  });

  r.post("/data/assets", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const body = DataMarketAssetInputSchema.parse(await c.req.json());
    const providerOrgId = requireCpDataMutationOrganization(scope);
    if (body.providerOrgId && body.providerOrgId !== providerOrgId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Provider data assets must belong to the active organization",
        403,
      );
    }
    const asset = await service.createProviderAsset(
      cpDataActor(c, scope),
      {
        ...body,
        providerOrgId,
      } as DataAssetInput,
      requireCpIdempotencyKey(c),
    );
    return c.json({ success: true, data: asset }, 201);
  });

  r.get("/data/assets", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const data = await service.listProviderAssets(cpDataActor(c, scope), parseCpDataPageQuery(c));
    return c.json({ success: true, data });
  });

  r.get("/data/assets/:assetId/versions", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const data = await service.listProviderVersions(
      cpDataActor(c, scope),
      c.req.param("assetId"),
      parseCpDataPageQuery(c),
    );
    return c.json({ success: true, data });
  });

  r.get("/data/versions/:versionId/replicas", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const data = await service.listProviderReplicas(
      cpDataActor(c, scope),
      c.req.param("versionId"),
      parseCpDataPageQuery(c),
    );
    return c.json({ success: true, data });
  });

  r.post("/data/versions/:versionId/replicas", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    requireCpDataMutationOrganization(scope);
    const body = DataMarketReplicaInputSchema.parse(await c.req.json());
    const data = await service.createReplica(
      cpDataActor(c, scope),
      { versionId: c.req.param("versionId"), ...body },
      requireCpIdempotencyKey(c),
    );
    return c.json({ success: true, data }, 201);
  });

  r.get("/data/imports", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const data = await service.listProviderImports(cpDataActor(c, scope), parseCpDataPageQuery(c));
    return c.json({ success: true, data });
  });

  r.post("/data/imports", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    requireCpDataMutationOrganization(scope);
    const body = CpDataImportInputSchema.parse(await c.req.json());
    const data = await service.startProviderImport(
      cpDataActor(c, scope),
      body as CpDataImportInput,
      requireCpIdempotencyKey(c),
    );
    return c.json({ success: true, data }, 201);
  });

  r.get("/data/access-requests", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const data = await service.listProviderAccessRequests(
      cpDataActor(c, scope),
      parseCpDataAccessRequestQuery(c),
    );
    return c.json({ success: true, data });
  });

  r.get("/data/access-requests/:requestId", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    const data = await service.getProviderAccessRequest(
      cpDataActor(c, scope),
      c.req.param("requestId"),
    );
    return c.json({ success: true, data });
  });

  r.post("/data/access-requests/:requestId/review", async (c) => {
    const service = requireDataMarket(deps);
    const scope = c.get("cpScope") as CpScope;
    requireCpDataMutationOrganization(scope);
    const body = CpDataAccessReviewSchema.parse(await c.req.json());
    const data = await service.reviewProviderAccessRequest(
      cpDataActor(c, scope),
      c.req.param("requestId"),
      body as DataAccessReviewInput,
    );
    return c.json({ success: true, data });
  });

  r.get("/software/policies", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const items = await deps.consoleService.listSoftwarePolicies(scope);
    return c.json({ items });
  });

  r.get("/software/overview", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const overview = await deps.consoleService.getSoftwareOverview(scope);
    return c.json(overview);
  });

  r.post("/software/policies", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = SoftwarePolicyEditSchema.parse(await c.req.json());
    await deps.consoleService.editSoftwarePolicy(scope, body);
    return c.json({ ok: true });
  });

  r.put("/software/policies/provider", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = PolicyOverlaySchema.parse(await c.req.json());
    const overview = await deps.consoleService.saveProviderSoftwarePolicy(scope, body);
    return c.json(overview);
  });

  r.put("/software/policies/clusters/:clusterId", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = ClusterPolicyOverlaySchema.parse(await c.req.json());
    const overview = await deps.consoleService.saveClusterSoftwarePolicy(
      scope,
      c.req.param("clusterId"),
      body,
    );
    return c.json(overview);
  });

  r.put("/software/policies/agents/:agentId", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = AgentPolicyOverlaySchema.parse(await c.req.json());
    const overview = await deps.consoleService.saveAgentSoftwarePolicy(
      scope,
      c.req.param("agentId"),
      body,
    );
    return c.json(overview);
  });

  r.post("/software/preinstalled-mappings/:mappingId/review", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = PreinstalledMappingReviewSchema.parse(await c.req.json());
    await verifyCpAgentAccess(
      deps,
      scope,
      c,
      body.agentId,
      "manage",
      "cp-software-preinstalled-mapping",
    );
    const overview = await deps.consoleService.reviewPreinstalledMapping(scope, {
      agentId: body.agentId,
      mappingId: c.req.param("mappingId"),
      decision: body.decision,
      reviewedBy: requireCanonicalCpActor(c),
    });
    return c.json(overview);
  });

  r.post("/software/availability-preview", async (c) => {
    const availability = deps.availability;
    if (!availability) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "software availability resolver is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const principal = c.get("principal") as BoundPrincipal;
    const body = AvailabilityPreviewSchema.parse(await c.req.json());
    const providerOrgIds = scope.orgIds.length > 0 ? scope.orgIds : undefined;
    const result = await availability.resolve(
      {
        rawSpec: body.rawSpec,
        ...(body.usecaseRef ? { usecaseRef: body.usecaseRef } : {}),
        installable: body.installable,
        ...(body.targetAgentIds ? { targetAgentIds: body.targetAgentIds } : {}),
        ...(providerOrgIds ? { providerOrgIds } : {}),
      },
      principal,
    );
    return c.json(result);
  });

  r.get("/software/operations", async (c) => {
    const service = deps.softwareOperations;
    if (!service) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "software operation service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const q = SoftwareOperationListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (q.agentId) {
      await verifyCpAgentScope(service, scope, deps.authz, c, q.agentId, "operate");
    }
    const items = await service.listOperations({
      scope,
      ...(q.agentId ? { agentId: q.agentId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.status ? { status: q.status } : {}),
      limit: q.limit,
      agentScopeVerified: Boolean(q.agentId),
    });
    return c.json({ items });
  });

  r.post("/software/operations", async (c) => {
    const service = deps.softwareOperations;
    if (!service) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "software operation service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const body = SoftwareOperationRequestSchema.parse(await c.req.json());
    const idempotencyKey = requireCpIdempotencyKey(c);
    await verifyCpAgentScope(service, scope, deps.authz, c, body.agentId, "operate");
    const requestedBy = requireCanonicalCpActor(c);
    const item = await service.requestOperation({
      scope,
      agentId: body.agentId,
      action: body.action,
      spec: body.spec,
      requestedBy,
      idempotencyKey,
      agentScopeVerified: true,
    });
    return c.json(item, 202);
  });

  r.post("/software/operations/batch", async (c) => {
    const service = deps.softwareOperations;
    if (!service) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "software operation service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const body = SoftwareOperationBatchRequestSchema.parse(await c.req.json());
    const batch = summarizeBatchSpecs(body.specs);
    if (batch.specs.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "At least one non-empty spec is required",
        400,
      );
    }
    if (batch.specs.length > MAX_SOFTWARE_OPERATION_BATCH_SPECS) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `At most ${MAX_SOFTWARE_OPERATION_BATCH_SPECS} unique specs can be submitted at once`,
        400,
      );
    }
    const idempotencyKey = requireCpIdempotencyKey(c);
    await verifyCpAgentScope(service, scope, deps.authz, c, body.agentId, "operate");
    const requestedBy = requireCanonicalCpActor(c);
    const items: SoftwareOperationView[] = [];
    for (const spec of batch.specs) {
      const item = await service.requestOperation({
        scope,
        agentId: body.agentId,
        action: body.action,
        spec,
        requestedBy,
        idempotencyKey,
        idempotencyItemIndex: items.length,
        idempotencyItemCount: batch.specs.length,
        agentScopeVerified: true,
      });
      items.push(item);
    }
    return c.json({ items, summary: batch.summary }, 202);
  });

  r.get("/users", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const q = UsersListQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const r = await deps.consoleService.listUsers(scope, q);
    return c.json(r);
  });

  r.post("/users/:userId/suspend", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = UserSuspendSchema.parse(await c.req.json());
    const userId = c.req.param("userId");
    await deps.consoleService.setUserSuspended(scope, userId, body.suspended, {
      actor: requireCanonicalCpActor(c),
      orgId: requireCpMutationOrgId(scope),
    });
    return c.json({ ok: true });
  });

  r.post("/users/:userId/quota", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = UserQuotaSchema.parse(await c.req.json());
    const userId = c.req.param("userId");
    await deps.consoleService.setUserQuota(scope, userId, body.quota, {
      actor: requireCanonicalCpActor(c),
      orgId: requireCpMutationOrgId(scope),
    });
    return c.json({ ok: true });
  });

  r.post("/audit/search", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const body = AuditSearchSchema.parse(await c.req.json());
    const r = await deps.consoleService.searchAudit(scope, body);
    return c.json(r);
  });

  r.get("/agents", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const items =
      deps.authz?.mode === "enforce"
        ? await listAgentsThroughSpice(deps, c, scope)
        : await deps.consoleService.listAgents(scope);
    return c.json({ items });
  });

  r.get("/agents/:agentId/certs", async (c) => {
    if (!deps.agentCerts) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "agent cert service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const agentId = c.req.param("agentId");
    await verifyCpAgentAccess(deps, scope, c, agentId, "operate");
    const certs = await deps.agentCerts.listCerts(agentId);
    return c.json({
      certs: certs.map((cert) => ({
        id: cert.id,
        fingerprintSha256: cert.fingerprintSha256,
        subjectCn: cert.subjectCn,
        issuedAt: cert.issuedAt.toISOString(),
        expiresAt: cert.expiresAt.toISOString(),
        revokedAt: cert.revokedAt?.toISOString() ?? null,
        issuedBy: cert.issuedBy,
      })),
    });
  });

  r.delete("/agents/:agentId/certs/:fingerprint", async (c) => {
    if (!deps.agentCerts) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "agent cert service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const agentId = c.req.param("agentId");
    const fingerprintSha256 = c.req.param("fingerprint");
    await verifyCpAgentAccess(deps, scope, c, agentId, "manage");
    await deps.agentCerts.revokeCert({
      agentId,
      fingerprintSha256,
      revokedBy: requireCanonicalCpActor(c),
    });
    return c.body(null, 204);
  });

  r.post("/agents/:agentId/certs/:fingerprint/revoke", async (c) => {
    if (!deps.agentCerts) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "agent cert service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const agentId = c.req.param("agentId");
    const fingerprintSha256 = c.req.param("fingerprint");
    await verifyCpAgentAccess(deps, scope, c, agentId, "manage");
    const parsed = AgentCertRevokeSchema.safeParse(await readOptionalJson(c));
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }
    await deps.agentCerts.revokeCert({
      agentId,
      fingerprintSha256,
      revokedBy: requireCanonicalCpActor(c),
      reason: parsed.data.reason,
    });
    return c.json({ success: true });
  });

  r.get("/agent-registration-context", async (c) => {
    const scope = c.get("cpScope") as CpScope;
    const providerOrgs = await deps.consoleService.listRegistrationProviderOrgs(scope);
    return c.json({
      providerOrgs,
      isPlatformWide: scope.isPlatformWide,
      schedulers: AGENT_REGISTRATION_SCHEDULERS,
    });
  });

  r.get("/agent-registration-tokens", async (c) => {
    if (!deps.agentRegistration) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "agent registration service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const tokens = await deps.agentRegistration.listActive({
      providerOrgIds: scope.orgIds,
      isPlatformWide: scope.isPlatformWide,
    });
    return c.json({
      items: tokens.map((token) => ({
        id: token.id,
        agentId: token.agentId,
        siteName: token.siteName,
        providerOrgId: token.providerOrgId,
        expiresAt: token.expiresAt.toISOString(),
        createdAt: token.createdAt.toISOString(),
      })),
    });
  });

  r.post("/agent-registration-tokens", async (c) => {
    if (!deps.agentRegistration) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "agent registration service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    const body = AgentRegistrationTokenCreateSchema.parse(await c.req.json());
    const providerOrgId = resolveRegistrationProviderOrg(scope, body.providerOrgId);
    const actor = requireCanonicalCpActor(c);
    const token = await deps.agentRegistration.createToken({
      agentId: body.agentId,
      siteName: body.siteName,
      providerOrgId,
      expiresInSec: body.expiresInSec,
      createdBy: actor,
    });
    return c.json(
      {
        id: token.id,
        agentId: token.agentId,
        siteName: token.siteName,
        providerOrgId: token.providerOrgId,
        token: token.token,
        expiresAt: token.expiresAt.toISOString(),
      },
      201,
    );
  });

  r.delete("/agent-registration-tokens/:id", async (c) => {
    if (!deps.agentRegistration) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "agent registration service is not wired");
    }
    const scope = c.get("cpScope") as CpScope;
    await deps.agentRegistration.revoke({
      id: c.req.param("id"),
      providerOrgIds: scope.orgIds,
      isPlatformWide: scope.isPlatformWide,
      revokedBy: requireCanonicalCpActor(c),
    });
    return c.body(null, 204);
  });

  return r;
}

function isCpMutation(method: string, path: string): boolean {
  if (method === "GET") return false;
  return path !== "/software/availability-preview" && path !== "/audit/search";
}

function cpResourceMutationAuthorization(
  method: string,
  requestPath: string,
): "operate" | "manage" | null {
  const path = requestPath.replace(/^\/api\/cp(?=\/|$)/, "");
  if (
    method === "POST" &&
    (path === "/software/operations" || path === "/software/operations/batch")
  ) {
    return "operate";
  }
  if (method === "POST" && /^\/software\/preinstalled-mappings\/[^/]+\/review$/.test(path)) {
    return "manage";
  }
  if (
    (method === "DELETE" && /^\/agents\/[^/]+\/certs\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/agents\/[^/]+\/certs\/[^/]+\/revoke$/.test(path))
  ) {
    return "manage";
  }
  return null;
}

function requireCpMutationOrgId(scope: CpScope): string | null {
  if (scope.isPlatformWide) return null;
  const orgId = scope.activeOrganizationId ?? (scope.orgIds.length === 1 ? scope.orgIds[0] : null);
  if (!orgId) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Select an active provider organization before changing a user",
      409,
    );
  }
  return orgId;
}

function requireActiveOrganizationForCpMutation(scope: CpScope): void {
  if (scope.isPlatformWide || scope.activeOrganizationId || scope.orgIds.length <= 1) return;
  throw new AppError(
    ErrorCode.VALIDATION_ERROR,
    "Select an active provider organization before changing compute-provider settings",
    409,
  );
}

function requireCpDataMutationOrganization(scope: CpScope): string {
  if (scope.isPlatformWide) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Select an active provider organization before changing provider data",
      409,
    );
  }
  const orgId = scope.activeOrganizationId ?? (scope.orgIds.length === 1 ? scope.orgIds[0] : null);
  if (!orgId) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Select an active provider organization before changing provider data",
      409,
    );
  }
  return orgId;
}

function requireCpManage(scope: CpScope): void {
  if (scope.canManage === true) return;
  throw new AppError(
    ErrorCode.FORBIDDEN,
    "Provider owner or administrator membership is required for this operation",
    403,
  );
}

async function readOptionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid JSON body", 400);
  }
}

function resolveRegistrationProviderOrg(scope: CpScope, requested: string | undefined): string {
  if (scope.isPlatformWide) {
    if (!requested) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "providerOrgId is required for platform-wide token creation",
        400,
      );
    }
    return requested;
  }
  if (requested) {
    if (!scope.orgIds.includes(requested)) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized for this provider org", 403);
    }
    return requested;
  }
  if (scope.orgIds.length === 1) {
    const providerOrgId = scope.orgIds[0];
    if (providerOrgId) return providerOrgId;
  }
  throw new AppError(
    ErrorCode.VALIDATION_ERROR,
    "providerOrgId is required when the CP scope has multiple provider orgs",
    400,
  );
}

function summarizeBatchSpecs(specs: string[]): {
  specs: string[];
  summary: {
    inputCount: number;
    nonEmptyCount: number;
    uniqueSpecCount: number;
    ignoredEmptyCount: number;
    ignoredDuplicateCount: number;
  };
} {
  const seen = new Set<string>();
  const normalized: string[] = [];
  let nonEmptyCount = 0;
  for (const value of specs) {
    const spec = value.trim();
    if (spec.length === 0) continue;
    nonEmptyCount += 1;
    if (seen.has(spec)) continue;
    seen.add(spec);
    normalized.push(spec);
  }
  return {
    specs: normalized,
    summary: {
      inputCount: specs.length,
      nonEmptyCount,
      uniqueSpecCount: normalized.length,
      ignoredEmptyCount: specs.length - nonEmptyCount,
      ignoredDuplicateCount: nonEmptyCount - normalized.length,
    },
  };
}

function requireCanonicalCpActor(c: Context): string {
  const principal = c.get("principal") as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

async function requireCpAgentPermission(
  authz: AuthzService | undefined,
  c: Context,
  agentId: string,
  permission: "view" | "operate" | "manage",
  localAllowed: boolean,
  source = "cp-software",
): Promise<void> {
  if (!authz || authz.mode === "off") return;
  const principal = c.get("principal") as BoundPrincipal | undefined;
  const scope = c.get("cpScope") as CpScope;
  const subjectId = principal?.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: principal?.userId ?? null,
    actorEmail: principal?.email ?? null,
    resource: { type: "agent", id: agentId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source },
    localAllowed,
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    return;
  }
  await authz.requirePermission(check, hasRole(scope.principal.role as RoleName, "platform_admin"));
}

async function verifyCpAgentScope(
  service: Pick<SoftwareOperationService, "assertAgentInScope">,
  scope: CpScope,
  authz: AuthzService | undefined,
  c: Context,
  agentId: string,
  permission: "view" | "operate" | "manage",
): Promise<void> {
  if (authz?.mode === "enforce") {
    const localAllowed = await cpAgentLocalAllowed(service, scope, agentId);
    await requireCpAgentPermission(authz, c, agentId, permission, localAllowed);
    return;
  }
  await service.assertAgentInScope(scope, agentId);
  await requireCpAgentPermission(authz, c, agentId, permission, true);
}

async function cpAgentLocalAllowed(
  service: Pick<SoftwareOperationService, "assertAgentInScope">,
  scope: CpScope,
  agentId: string,
): Promise<boolean> {
  if (scope.localAllowed === false) return false;
  try {
    await service.assertAgentInScope(scope, agentId);
    return true;
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 403 || err.statusCode === 404)) {
      return false;
    }
    throw err;
  }
}

async function verifyCpAgentAccess(
  deps: Pick<CpRoutesDeps, "authz" | "consoleService">,
  scope: CpScope,
  c: Context,
  agentId: string,
  permission: "operate" | "manage",
  source = "cp-agent-certs",
): Promise<void> {
  if (deps.authz?.mode === "enforce") {
    const localAllowed = await cpAgentListedLocally(deps.consoleService, scope, agentId);
    await requireCpAgentPermission(deps.authz, c, agentId, permission, localAllowed, source);
    return;
  }
  const localAllowed = await cpAgentListedLocally(deps.consoleService, scope, agentId);
  if (!localAllowed) {
    throw new AppError(ErrorCode.FORBIDDEN, "Agent is outside CP scope", 403);
  }
  await requireCpAgentPermission(deps.authz, c, agentId, permission, true, source);
}

async function cpAgentListedLocally(
  service: Pick<CpConsoleService, "listAgents">,
  scope: CpScope,
  agentId: string,
): Promise<boolean> {
  if (scope.localAllowed === false) return false;
  const agents = await service.listAgents(scope);
  return agents.some((agent) => agent.id === agentId);
}

async function listAgentsThroughSpice(
  deps: CpRoutesDeps,
  c: Context,
  scope: CpScope,
): Promise<Awaited<ReturnType<CpConsoleService["listAgents"]>>> {
  const authz = deps.authz;
  if (!authz || authz.mode !== "enforce") return deps.consoleService.listAgents(scope);
  const principal = c.get("principal") as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  let visibleIds: string[];
  try {
    visibleIds = await authz.lookupResources({
      resourceType: "agent",
      permission: "operate",
      subject: { type: "user", id: principal.userId },
    });
  } catch (err) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      `Authorization unavailable: ${err instanceof Error ? err.message : String(err)}`,
      403,
    );
  }
  if (visibleIds.length === 0) {
    if (scope.localAllowed === false) {
      throw new AppError(ErrorCode.FORBIDDEN, "No delegated compute-provider access", 403);
    }
    return [];
  }
  const visible = new Set(visibleIds);
  return deps.consoleService.listAgentsByIds([...visible]);
}

function isDeferredCpAgentAuthorizationRoute(request: {
  method: string;
  path: string;
  url: string;
}): boolean {
  const path = request.path.replace(/^\/api\/cp(?=\/|$)/, "");
  if (request.method === "GET" && path === "/agents") return true;
  if (/^\/agents\/[^/]+\/certs(?:\/[^/]+(?:\/revoke)?)?$/.test(path)) return true;
  if (request.method === "POST" && path === "/software/operations") return true;
  if (request.method === "POST" && path === "/software/operations/batch") return true;
  if (request.method === "GET" && path === "/software/operations") {
    return Boolean(new URL(request.url).searchParams.get("agentId")?.trim());
  }
  return (
    request.method === "POST" && /^\/software\/preinstalled-mappings\/[^/]+\/review$/.test(path)
  );
}

function validatePolicyOverlayConflicts(
  value: {
    allowList?: string[];
    denyList?: string[];
    usecaseAllowList?: string[];
    usecaseDenyList?: string[];
  },
  ctx: z.RefinementCtx,
) {
  const specConflicts = findTrimmedConflicts(value.allowList ?? [], value.denyList ?? []);
  if (specConflicts.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["denyList"],
      message: `Spack specs cannot be both allowed and denied: ${specConflicts.slice(0, 3).join(", ")}`,
    });
  }
  const usecaseConflicts = findTrimmedConflicts(
    value.usecaseAllowList ?? [],
    value.usecaseDenyList ?? [],
  );
  if (usecaseConflicts.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usecaseDenyList"],
      message: `Software usecases cannot be both granted and denied: ${usecaseConflicts.slice(0, 3).join(", ")}`,
    });
  }
}

function findTrimmedConflicts(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map((item) => item.trim()).filter((item) => item.length > 0));
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const raw of left) {
    const item = raw.trim();
    if (item.length === 0 || seen.has(item) || !rightSet.has(item)) continue;
    seen.add(item);
    conflicts.push(item);
  }
  return conflicts;
}

function requireDataMarket(deps: CpRoutesDeps): DataMarketService {
  if (!deps.dataMarket) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Data Market service is not wired", 503);
  }
  return deps.dataMarket;
}

function parseCpDataPageQuery(c: Context) {
  const result = CpDataPageQuerySchema.safeParse({
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
    query: c.req.query("query"),
    tag: c.req.query("tag"),
  });
  if (!result.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid CP data pagination query", 400);
  }
  return result.data;
}

function parseCpDataAccessRequestQuery(c: Context) {
  const result = CpDataAccessRequestQuerySchema.safeParse({
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
    status: c.req.query("status"),
  });
  if (!result.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid CP data access request query", 400);
  }
  return result.data;
}

function cpDataActor(c: Context, scope: CpScope) {
  const principal = c.get("principal") as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return {
    userId: principal.userId,
    role: principal.role as RoleName,
    orgId:
      scope.activeOrganizationId ?? (scope.orgIds.length === 1 ? (scope.orgIds[0] ?? null) : null),
    orgIds: scope.orgIds,
    providerManagerOrgIds: scope.canManage ? scope.orgIds : [],
  };
}

function requireCpIdempotencyKey(c: Context): string {
  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 255) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Idempotency-Key header is required", 400);
  }
  return key;
}
