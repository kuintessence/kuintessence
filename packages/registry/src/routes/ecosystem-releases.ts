import { zValidator } from "@hono/zod-validator";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import { createPrincipalMiddleware, type RegistryEnv } from "../middleware/principal";
import type { EcosystemOciReference } from "../services/ecosystem-oci-reader";
import type {
  EcosystemReleaseService,
  EntitlementClaimInput,
  SignedEcosystemBundle,
} from "../services/ecosystem-release-service";
import {
  EntitlementClaimInputSchema,
  LicensedMaterialMappingInputSchema,
  RuntimeContractBindingInputSchema,
} from "../services/ecosystem-release-service";
import type { RegistryRole } from "../services/namespace";

interface EcosystemRouteOptions {
  authMode?: "dev" | "jwt";
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  publisherRoles?: RegistryRole[];
}

export function createEcosystemReleaseRoutes(
  service: EcosystemReleaseService,
  opts: EcosystemRouteOptions = {},
) {
  const r = new Hono<RegistryEnv>();
  const requirePrincipal = createPrincipalMiddleware(opts);

  r.post("/ecosystem-releases/import", requirePrincipal, async (c) => {
    assertPlatformAdmin(c.get("principal").role);
    const body = await c.req.json<SignedEcosystemBundle | { oci: EcosystemOciReference }>();
    const release =
      "oci" in body
        ? await service.stageFromOci(body.oci, c.get("principal").sub)
        : await service.stage(body, c.get("principal").sub);
    return c.json(release, 201);
  });

  r.get("/ecosystem-releases", async (c) => {
    return c.json({ releases: await service.list(c.req.query("releaseKey")) });
  });

  r.get("/ecosystem-releases/:releaseKey/status", async (c) => {
    const status = await service.status(c.req.param("releaseKey"));
    if (!status) throw new AppError(ErrorCode.NOT_FOUND, "No active ecosystem release", 404);
    return c.json(status);
  });

  r.post("/ecosystem-releases/:releaseId/activate", requirePrincipal, async (c) => {
    const principal = c.get("principal");
    assertPlatformAdmin(principal.role);
    return c.json(await service.activate(c.req.param("releaseId"), principal.sub));
  });

  r.post(
    "/ecosystem-releases/:releaseKey/rollback/:targetReleaseId",
    requirePrincipal,
    async (c) => {
      const principal = c.get("principal");
      assertPlatformAdmin(principal.role);
      return c.json(
        await service.rollback(
          c.req.param("releaseKey"),
          c.req.param("targetReleaseId"),
          principal.sub,
        ),
      );
    },
  );

  r.post(
    "/license-entitlement-claims",
    requirePrincipal,
    zValidator("json", EntitlementClaimInputSchema),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      assertClaimScope(input, principal);
      return c.json(await service.submitEntitlementClaim(input, principal.sub), 201);
    },
  );

  r.get("/license-entitlement-claims", requirePrincipal, async (c) => {
    assertPlatformAdmin(c.get("principal").role);
    return c.json({ claims: await service.listEntitlementClaims(c.req.query("status")) });
  });

  r.post("/license-entitlement-claims/:id/:decision", requirePrincipal, async (c) => {
    const principal = c.get("principal");
    assertPlatformAdmin(principal.role);
    const decision = c.req.param("decision");
    if (decision !== "approved" && decision !== "rejected" && decision !== "revoked") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid entitlement decision", 422);
    }
    const body = await optionalJson(c);
    return c.json(
      await service.decideEntitlementClaim(c.req.param("id"), decision, principal.sub, body.reason),
    );
  });

  r.post(
    "/runtime-contract-bindings",
    requirePrincipal,
    zValidator("json", RuntimeContractBindingInputSchema),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      assertProviderScope(input.providerOrgId, principal.orgIds, principal.role);
      return c.json(await service.bindRuntimeContract(input, principal.sub), 201);
    },
  );

  r.get("/runtime-contract-bindings", requirePrincipal, async (c) => {
    const principal = c.get("principal");
    const providerOrgId = c.req.query("providerOrgId");
    if (providerOrgId) assertProviderScope(providerOrgId, principal.orgIds, principal.role);
    return c.json({ bindings: await service.listRuntimeContractBindings(providerOrgId) });
  });

  r.post(
    "/licensed-material-mappings",
    requirePrincipal,
    zValidator("json", LicensedMaterialMappingInputSchema),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      assertProviderScope(input.providerOrgId, principal.orgIds, principal.role);
      return c.json(await service.registerLicensedMaterial(input, principal.sub), 201);
    },
  );

  r.get("/licensed-material-mappings", requirePrincipal, async (c) => {
    const principal = c.get("principal");
    const providerOrgId = c.req.query("providerOrgId");
    if (providerOrgId) assertProviderScope(providerOrgId, principal.orgIds, principal.role);
    return c.json({ mappings: await service.listLicensedMaterials(providerOrgId) });
  });

  return r;
}

function assertPlatformAdmin(role: RegistryRole): void {
  if (role === "platform_admin" || role === "super_admin") return;
  throw new AppError(ErrorCode.FORBIDDEN, "Platform administrator role required", 403);
}

function assertOrgAdmin(role: RegistryRole): void {
  if (role === "org_admin" || role === "platform_admin" || role === "super_admin") return;
  throw new AppError(ErrorCode.FORBIDDEN, "Organization administrator role required", 403);
}

function assertProviderScope(providerOrgId: string, orgIds: string[], role: RegistryRole): void {
  assertOrgAdmin(role);
  if (role === "platform_admin" || role === "super_admin" || orgIds.includes(providerOrgId)) return;
  throw new AppError(ErrorCode.FORBIDDEN, "Provider organization membership required", 403);
}

function assertClaimScope(
  input: EntitlementClaimInput,
  principal: { sub: string; orgIds: string[]; role: RegistryRole },
): void {
  const isPlatformAdmin = principal.role === "platform_admin" || principal.role === "super_admin";
  if (input.claimantKind === "user") {
    if (!isPlatformAdmin && input.claimantId !== principal.sub) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Users and organization administrators may only submit their own user claim",
        403,
      );
    }
  } else {
    assertProviderScope(input.claimantId, principal.orgIds, principal.role);
  }
  if (input.entitlement === "provider-source-install") {
    if (input.claimantKind !== "org" || input.providerOrgId !== input.claimantId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Provider source/install claims must target the claimant provider organization",
        422,
      );
    }
    assertProviderScope(input.claimantId, principal.orgIds, principal.role);
  }
}

async function optionalJson(c: {
  req: { header(name: string): string | undefined; json<T>(): Promise<T> };
}) {
  if (!c.req.header("Content-Type")?.includes("application/json")) return { reason: undefined };
  const body = await c.req.json<{ reason?: unknown }>();
  return { reason: typeof body.reason === "string" ? body.reason : undefined };
}
