import { describe, expect, test } from "bun:test";
import { AppError } from "@kuintessence/shared";
import { Hono } from "hono";
import type { EcosystemReleaseService } from "../services/ecosystem-release-service";
import { createEcosystemReleaseRoutes } from "./ecosystem-releases";

process.env.REGISTRY_ALLOW_TEST_PRINCIPAL = "1";
const PROVIDER_ORG_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const RUNTIME_DIGEST = `sha256:${"a".repeat(64)}`;

function principal(
  role: "platform_admin" | "org_admin" | "user",
  orgIds: string[] = [],
  sub = "actor",
) {
  return {
    "Content-Type": "application/json",
    "X-Test-Principal": JSON.stringify({ sub, role, orgIds }),
  };
}

function appWithService() {
  const calls = { stage: 0, stageFromOci: 0, bind: 0, material: 0, claim: 0 };
  const service = {
    stage: async () => {
      calls.stage += 1;
      return { id: "release" };
    },
    stageFromOci: async () => {
      calls.stageFromOci += 1;
      return { id: "release" };
    },
    list: async () => [],
    status: async () => null,
    activate: async () => ({ id: "release" }),
    rollback: async () => ({ id: "release" }),
    submitEntitlementClaim: async () => {
      calls.claim += 1;
      return { id: "claim" };
    },
    listEntitlementClaims: async () => [],
    decideEntitlementClaim: async () => ({ id: "claim" }),
    bindRuntimeContract: async () => {
      calls.bind += 1;
      return { id: "binding" };
    },
    listRuntimeContractBindings: async () => [],
    registerLicensedMaterial: async () => {
      calls.material += 1;
      return { id: "mapping" };
    },
    listLicensedMaterials: async () => [],
  } as unknown as EcosystemReleaseService;
  const app = new Hono();
  app.onError((error) => {
    if (error instanceof AppError) {
      return new Response(JSON.stringify(error.toJSON()), {
        status: error.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Internal server error", { status: 500 });
  });
  app.route("/api", createEcosystemReleaseRoutes(service));
  return { app, calls };
}

describe("ecosystem release routes", () => {
  test("restricts imports to platform administrators", async () => {
    const { app, calls } = appWithService();
    const body = { manifest: {}, signature: "test", signingKeyId: "key" };
    const denied = await app.request("/api/ecosystem-releases/import", {
      method: "POST",
      headers: principal("user"),
      body: JSON.stringify(body),
    });
    expect(denied.status).toBe(403);

    const accepted = await app.request("/api/ecosystem-releases/import", {
      method: "POST",
      headers: principal("platform_admin"),
      body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(201);
    expect(calls.stage).toBe(1);
  });

  test("requires provider org membership for runtime and restricted material mappings", async () => {
    const { app, calls } = appWithService();
    const binding = {
      providerOrgId: PROVIDER_ORG_ID,
      runtimeContractRef: "python-3.12-stdlib-v1",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      runtimeDigest: RUNTIME_DIGEST,
    };
    const denied = await app.request("/api/runtime-contract-bindings", {
      method: "POST",
      headers: principal("org_admin", []),
      body: JSON.stringify(binding),
    });
    expect(denied.status).toBe(403);

    const accepted = await app.request("/api/runtime-contract-bindings", {
      method: "POST",
      headers: principal("org_admin", [PROVIDER_ORG_ID]),
      body: JSON.stringify(binding),
    });
    expect(accepted.status).toBe(201);
    expect(calls.bind).toBe(1);
  });

  test("allows a user claim only for the authenticated user", async () => {
    const { app, calls } = appWithService();
    const claim = {
      assetId: RUNTIME_PROFILE_ID,
      entitlement: "consumer-use",
      claimantKind: "user",
      claimantId: "another-user",
      evidenceReference: "org-license-record",
      evidenceSummary: "Entitlement is administered outside the platform.",
    };
    const deniedUser = await app.request("/api/license-entitlement-claims", {
      method: "POST",
      headers: principal("user", [], "user-a"),
      body: JSON.stringify(claim),
    });
    expect(deniedUser.status).toBe(403);

    const deniedOrgAdmin = await app.request("/api/license-entitlement-claims", {
      method: "POST",
      headers: principal("org_admin", [PROVIDER_ORG_ID], "admin-a"),
      body: JSON.stringify(claim),
    });
    expect(deniedOrgAdmin.status).toBe(403);

    const accepted = await app.request("/api/license-entitlement-claims", {
      method: "POST",
      headers: principal("user", [], "user-a"),
      body: JSON.stringify({ ...claim, claimantId: "user-a" }),
    });
    expect(accepted.status).toBe(201);
    expect(calls.claim).toBe(1);
  });

  test("requires a provider source/install claim to target the claimant org", async () => {
    const { app, calls } = appWithService();
    const claim = {
      assetId: RUNTIME_PROFILE_ID,
      entitlement: "provider-source-install",
      claimantKind: "org",
      claimantId: PROVIDER_ORG_ID,
      providerOrgId: "33333333-3333-4333-8333-333333333333",
      evidenceReference: "provider-license-record",
      evidenceSummary: "License reviewed outside the platform.",
    };
    const denied = await app.request("/api/license-entitlement-claims", {
      method: "POST",
      headers: principal("org_admin", [PROVIDER_ORG_ID]),
      body: JSON.stringify(claim),
    });
    expect(denied.status).toBe(422);

    const accepted = await app.request("/api/license-entitlement-claims", {
      method: "POST",
      headers: principal("org_admin", [PROVIDER_ORG_ID]),
      body: JSON.stringify({ ...claim, providerOrgId: PROVIDER_ORG_ID }),
    });
    expect(accepted.status).toBe(201);
    expect(calls.claim).toBe(1);
  });

  test("validates entitlement, runtime, and licensed-material request bodies before service calls", async () => {
    const { app, calls } = appWithService();
    const headers = principal("org_admin", [PROVIDER_ORG_ID]);
    const invalidClaim = await app.request("/api/license-entitlement-claims", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const invalidBinding = await app.request("/api/runtime-contract-bindings", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerOrgId: "not-a-uuid" }),
    });
    const invalidMaterial = await app.request("/api/licensed-material-mappings", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerOrgId: PROVIDER_ORG_ID, elementSet: [] }),
    });
    expect(invalidClaim.status).toBe(400);
    expect(invalidBinding.status).toBe(400);
    expect(invalidMaterial.status).toBe(400);
    expect(calls.claim).toBe(0);
    expect(calls.bind).toBe(0);
    expect(calls.material).toBe(0);
  });
});
