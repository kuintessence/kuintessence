import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { PatternRouter } from "hono/router/pattern-router";
import { createPrincipalMiddleware, type RegistryEnv } from "../middleware/principal";
import type { AppTemplateService } from "../services/app-template-service";
import type { RegistryService } from "../services/registry-service";
import type { SpackCatalogService } from "../services/spack-catalog-service";
import type { UsecasePackageService } from "../services/usecase-package-service";
import type { WorkflowTemplateService } from "../services/workflow-template-service";
import { createAppTemplateRoutes } from "./app-templates";
import { createBuildcacheRoutes } from "./buildcache";
import { createOciRoutes } from "./oci";
import { createSpackCatalogRoutes } from "./spack-catalog";
import { createUsecasePackageRoutes } from "./usecase-packages";
import { createWorkflowTemplateRoutes } from "./workflow-templates";

const SECRET = "registry-route-auth-secret";
const ISSUER = "https://issuer.example";
const AUDIENCE = "kuintessence-registry";

interface RouteCalls {
  appCreates: number;
  buildcachePuts: number;
  ociEnsureRepository: number;
  ociStartUploads: number;
  spackCreates: number;
  spackLists: number;
  usecaseCreates: number;
  workflowCreates: number;
}

type CanonicalPrincipalResolver = (subject: string) => Promise<{
  sub: string;
  role: "platform_admin" | "user";
  orgIds: string[];
  suspended: boolean;
} | null>;

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function tokenFor(
  role: "platform_admin" | "user",
  overrides: Partial<Record<"aud" | "iss", string>> = {},
): string {
  return sign({
    sub: `${role}-1`,
    role,
    orgIds: [],
    iss: overrides.iss ?? ISSUER,
    aud: overrides.aud ?? AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60,
  });
}

function jsonAuth(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function createRouteApp(
  resolveCanonicalPrincipal: CanonicalPrincipalResolver = async (subject) => ({
    sub: subject,
    role: subject.startsWith("platform_admin") ? "platform_admin" : "user",
    orgIds: [],
    suspended: false,
  }),
) {
  const calls: RouteCalls = {
    appCreates: 0,
    buildcachePuts: 0,
    ociEnsureRepository: 0,
    ociStartUploads: 0,
    spackCreates: 0,
    spackLists: 0,
    usecaseCreates: 0,
    workflowCreates: 0,
  };
  const opts = {
    authMode: "jwt" as const,
    jwtAudience: AUDIENCE,
    jwtIssuer: ISSUER,
    jwtSecret: SECRET,
    resolveCanonicalPrincipal,
  };
  const appService = {
    create: async (data: unknown) => {
      calls.appCreates += 1;
      return { id: "app-template-id", ...(data as object) };
    },
  } as unknown as AppTemplateService;
  const workflowService = {
    create: async (data: unknown) => {
      calls.workflowCreates += 1;
      return { id: "workflow-template-id", ...(data as object) };
    },
    createWithStatus: async (data: unknown) => {
      calls.workflowCreates += 1;
      return { created: true, template: { id: "workflow-template-id", ...(data as object) } };
    },
  } as unknown as WorkflowTemplateService;
  const usecaseService = {
    create: async (data: unknown) => {
      calls.usecaseCreates += 1;
      return { id: "usecase-package-id", ...(data as object) };
    },
  } as unknown as UsecasePackageService;
  const spackService = {
    create: async (data: unknown) => {
      calls.spackCreates += 1;
      return { id: "spack-package-id", ...(data as object) };
    },
    list: async (data: unknown) => {
      calls.spackLists += 1;
      return {
        generatedAt: "2026-07-10",
        packageCount: 0,
        packages: [],
        page: 1,
        pageSize: 24,
        principalSub: (data as { principal?: { sub?: string } | null }).principal?.sub ?? null,
        source: "spack",
        sourceRef: "develop",
        sourceRepository: "spack/spack-packages",
        totalCount: 0,
        totalPages: 1,
        upstreamCount: 0,
        customCount: 0,
        hasNext: false,
        hasPrevious: false,
      };
    },
  } as unknown as SpackCatalogService;
  const app = new Hono();
  app.route("/api", createAppTemplateRoutes(appService, opts));
  app.route("/api", createWorkflowTemplateRoutes(workflowService, opts));
  app.route("/api", createUsecasePackageRoutes(usecaseService, opts));
  app.route("/api", createSpackCatalogRoutes(spackService, opts));
  return { app, calls };
}

function createRegistryRouteApp() {
  const calls: RouteCalls = {
    appCreates: 0,
    buildcachePuts: 0,
    ociEnsureRepository: 0,
    ociStartUploads: 0,
    spackCreates: 0,
    spackLists: 0,
    usecaseCreates: 0,
    workflowCreates: 0,
  };
  const opts = {
    authMode: "jwt" as const,
    jwtAudience: AUDIENCE,
    jwtIssuer: ISSUER,
    jwtSecret: SECRET,
  };
  const registryService = {
    ensureRepository: async () => {
      calls.ociEnsureRepository += 1;
      return { id: "repo-id" };
    },
    startUpload: async () => {
      calls.ociStartUploads += 1;
      return { uploadId: "upload-id" };
    },
    putSpackArtifact: async () => {
      calls.buildcachePuts += 1;
      return {
        arch: "linux-x86_64",
        hash: BUILD_HASH,
        package: "gromacs",
        sizeBytes: 0,
        spec: "gromacs@unknown",
      };
    },
  } as unknown as RegistryService;
  const app = new Hono({ router: new PatternRouter() });
  const oci = new Hono<RegistryEnv>({ router: new PatternRouter() });
  oci.use("*", createPrincipalMiddleware(opts));
  oci.route("/", createOciRoutes({ service: registryService }));
  app.route("/v2", oci);
  app.route("/v2/", oci);

  const buildcache = new Hono<RegistryEnv>();
  buildcache.use("*", createPrincipalMiddleware(opts));
  buildcache.route("/", createBuildcacheRoutes({ service: registryService }));
  app.route("/buildcache", buildcache);
  app.route("/buildcache/", buildcache);
  return { app, calls };
}

const usecaseSpec = {
  usecase: {
    commandFile: "simpleFoam",
    inputSlots: [],
  },
  software: {
    kind: "Spack",
    name: "openfoam@2312",
    argumentList: [],
  },
  arguments: [],
  environments: [],
  filesomeInputs: [],
  filesomeOutputs: [],
  valueOutputs: [],
};

const BUILD_HASH = "1".repeat(32);
const BUILD_FILENAME = `gromacs-${BUILD_HASH}.spack`;

describe("Registry write route auth", () => {
  test("rejects non-publisher JWTs before REST write services are called", async () => {
    const { app, calls } = createRouteApp();
    const headers = jsonAuth(tokenFor("user"));
    const writes = [
      {
        path: "/api/app-templates",
        body: { name: "app-auth-test", version: "1.0.0", spec: "zlib@1.3", specKind: "spack" },
      },
      {
        path: "/api/workflow-templates",
        body: { name: "workflow-auth-test", version: "1.0.0", yamlContent: "name: wf\n" },
      },
      {
        path: "/api/usecase-packages",
        body: { name: "usecase-auth-test", version: "1.0.0", spec: usecaseSpec },
      },
      {
        path: "/api/spack/catalog/packages",
        body: { name: "spack-auth-test", source: "official" },
      },
    ];

    for (const write of writes) {
      const res = await app.request(write.path, {
        method: "POST",
        headers,
        body: JSON.stringify(write.body),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { errors: Array<{ code: string }> };
      expect(body.errors[0]?.code).toBe("PUBLISHER_ROLE_REQUIRED");
    }
    expect(calls).toEqual({
      appCreates: 0,
      buildcachePuts: 0,
      ociEnsureRepository: 0,
      ociStartUploads: 0,
      spackCreates: 0,
      spackLists: 0,
      usecaseCreates: 0,
      workflowCreates: 0,
    });
  });

  test("rejects wrong JWT issuer at the real route gate", async () => {
    const { app, calls } = createRouteApp();
    const res = await app.request("/api/app-templates", {
      method: "POST",
      headers: jsonAuth(tokenFor("platform_admin", { iss: "https://wrong.example" })),
      body: JSON.stringify({
        name: "issuer-auth-test",
        version: "1.0.0",
        spec: "zlib@1.3",
        specKind: "spack",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("INVALID_TOKEN");
    expect(calls.appCreates).toBe(0);
  });

  test("rejects wrong JWT audience at the real route gate", async () => {
    const { app, calls } = createRouteApp();
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: jsonAuth(tokenFor("platform_admin", { aud: "other-service" })),
      body: JSON.stringify({
        name: "audience-auth-test",
        version: "1.0.0",
        yamlContent: "name: wf\n",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("INVALID_TOKEN");
    expect(calls.workflowCreates).toBe(0);
  });

  test("workflow publication rejects stale, missing, and suspended canonical principals", async () => {
    const scenarios: Array<{
      resolver: CanonicalPrincipalResolver;
      status: number;
      code: string;
    }> = [
      { resolver: async () => null, status: 401, code: "INVALID_TOKEN" },
      {
        resolver: async (subject) => ({
          sub: subject,
          role: "platform_admin",
          orgIds: [],
          suspended: true,
        }),
        status: 401,
        code: "INVALID_TOKEN",
      },
      {
        resolver: async (subject) => ({ sub: subject, role: "user", orgIds: [], suspended: false }),
        status: 403,
        code: "PUBLISHER_ROLE_REQUIRED",
      },
    ];

    for (const scenario of scenarios) {
      const { app, calls } = createRouteApp(scenario.resolver);
      const res = await app.request("/api/workflow-templates", {
        method: "POST",
        headers: jsonAuth(tokenFor("platform_admin")),
        body: JSON.stringify({
          name: "canonical-principal-test",
          version: "1.0.0",
          yamlContent: "name: wf\n",
        }),
      });
      expect(res.status).toBe(scenario.status);
      const body = (await res.json()) as { errors: Array<{ code: string }> };
      expect(body.errors[0]?.code).toBe(scenario.code);
      expect(calls.workflowCreates).toBe(0);
    }
  });

  test("does not honor test principal headers in JWT mode", async () => {
    const { app, calls } = createRouteApp();
    const res = await app.request("/api/usecase-packages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Principal": JSON.stringify({
          sub: "test-admin",
          role: "platform_admin",
          orgIds: [],
        }),
      },
      body: JSON.stringify({
        name: "test-header-auth-test",
        version: "1.0.0",
        spec: usecaseSpec,
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("UNAUTHORIZED");
    expect(calls.usecaseCreates).toBe(0);
  });

  test("keeps vendor catalog reads principal-scoped while public catalog reads stay public", async () => {
    const { app, calls } = createRouteApp();

    const publicCatalog = await app.request("/api/spack/catalog?source=all");
    expect(publicCatalog.status).toBe(200);
    const publicBody = (await publicCatalog.json()) as { principalSub: string | null };
    expect(publicBody.principalSub).toBeNull();

    const anonymousVendor = await app.request("/api/spack/catalog?source=vendor");
    expect(anonymousVendor.status).toBe(401);
    const anonymousVendorBody = (await anonymousVendor.json()) as {
      errors: Array<{ code: string }>;
    };
    expect(anonymousVendorBody.errors[0]?.code).toBe("UNAUTHORIZED");

    const vendor = await app.request("/api/spack/catalog?source=vendor", {
      headers: { Authorization: `Bearer ${tokenFor("platform_admin")}` },
    });
    expect(vendor.status).toBe(200);
    const vendorBody = (await vendor.json()) as { principalSub: string | null };
    expect(vendorBody.principalSub).toBe("platform_admin-1");
    expect(calls.spackLists).toBe(2);
  });

  test("rejects invalid vendor catalog read principals before listing packages", async () => {
    const { app, calls } = createRouteApp();

    const invalidToken = await app.request("/api/spack/catalog?source=all", {
      headers: { Authorization: `Bearer ${tokenFor("platform_admin", { iss: "wrong-issuer" })}` },
    });
    expect(invalidToken.status).toBe(401);
    const invalidTokenBody = (await invalidToken.json()) as { errors: Array<{ code: string }> };
    expect(invalidTokenBody.errors[0]?.code).toBe("INVALID_TOKEN");

    const testPrincipal = await app.request("/api/spack/catalog?source=vendor", {
      headers: {
        "X-Test-Principal": JSON.stringify({
          sub: "test-admin",
          role: "platform_admin",
          orgIds: [],
        }),
      },
    });
    expect(testPrincipal.status).toBe(401);
    const testPrincipalBody = (await testPrincipal.json()) as { errors: Array<{ code: string }> };
    expect(testPrincipalBody.errors[0]?.code).toBe("UNAUTHORIZED");
    expect(calls.spackLists).toBe(0);
  });

  test("rejects non-publisher JWTs before OCI and buildcache write services are called", async () => {
    const { app, calls } = createRegistryRouteApp();
    const headers = jsonAuth(tokenFor("user"));

    const oci = await app.request("/v2/public/oci-auth-test/blobs/uploads/", {
      method: "POST",
      headers,
    });
    expect(oci.status).toBe(403);
    const ociBody = (await oci.json()) as { errors: Array<{ code: string }> };
    expect(ociBody.errors[0]?.code).toBe("DENIED");

    const buildcache = await app.request(
      `/buildcache/public/buildcache-auth-test/build_cache/${BUILD_FILENAME}`,
      {
        method: "PUT",
        headers,
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(buildcache.status).toBe(403);
    const buildcacheBody = (await buildcache.json()) as { errors: Array<{ code: string }> };
    expect(buildcacheBody.errors[0]?.code).toBe("DENIED");

    expect(calls.ociEnsureRepository).toBe(0);
    expect(calls.ociStartUploads).toBe(0);
    expect(calls.buildcachePuts).toBe(0);
  });

  test("rejects wrong JWT issuer and audience on OCI and buildcache route gates", async () => {
    const { app, calls } = createRegistryRouteApp();

    const oci = await app.request("/v2/public/oci-issuer-test/blobs/uploads/", {
      method: "POST",
      headers: jsonAuth(tokenFor("platform_admin", { iss: "https://wrong.example" })),
    });
    expect(oci.status).toBe(401);
    const ociBody = (await oci.json()) as { errors: Array<{ code: string }> };
    expect(ociBody.errors[0]?.code).toBe("INVALID_TOKEN");

    const buildcache = await app.request(
      `/buildcache/public/buildcache-audience-test/build_cache/${BUILD_FILENAME}`,
      {
        method: "PUT",
        headers: jsonAuth(tokenFor("platform_admin", { aud: "other-service" })),
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(buildcache.status).toBe(401);
    const buildcacheBody = (await buildcache.json()) as { errors: Array<{ code: string }> };
    expect(buildcacheBody.errors[0]?.code).toBe("INVALID_TOKEN");

    expect(calls.ociEnsureRepository).toBe(0);
    expect(calls.ociStartUploads).toBe(0);
    expect(calls.buildcachePuts).toBe(0);
  });

  test("does not honor test principal headers on OCI and buildcache in JWT mode", async () => {
    const { app, calls } = createRegistryRouteApp();
    const headers = {
      "Content-Type": "application/octet-stream",
      "X-Test-Principal": JSON.stringify({
        sub: "test-admin",
        role: "platform_admin",
        orgIds: [],
      }),
    };

    const oci = await app.request("/v2/public/oci-test-header/blobs/uploads/", {
      method: "POST",
      headers,
    });
    expect(oci.status).toBe(401);
    const ociBody = (await oci.json()) as { errors: Array<{ code: string }> };
    expect(ociBody.errors[0]?.code).toBe("UNAUTHORIZED");

    const buildcache = await app.request(
      `/buildcache/public/buildcache-test-header/build_cache/${BUILD_FILENAME}`,
      {
        method: "PUT",
        headers,
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(buildcache.status).toBe(401);
    const buildcacheBody = (await buildcache.json()) as { errors: Array<{ code: string }> };
    expect(buildcacheBody.errors[0]?.code).toBe("UNAUTHORIZED");

    expect(calls.ociEnsureRepository).toBe(0);
    expect(calls.ociStartUploads).toBe(0);
    expect(calls.buildcachePuts).toBe(0);
  });
});
