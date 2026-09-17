import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type ClusterFileRootCreate,
  type ClusterFileRootUpdate,
  ErrorCode,
  type Transfer,
  type TransferCreate,
} from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { ClusterFileRootAccessContext } from "../services/cluster-file-root";
import {
  buildClusterDownloadCommand,
  buildClusterRootCheckCommand,
  buildClusterSourceFileCheckCommand,
  buildClusterTargetParentCheckCommand,
  FileService,
  type FileTransferRunner,
  InMemoryFileTransferStore,
} from "../services/file-service";
import {
  createFileRoutes,
  type FileRouteOptions,
  fallbackClusterFileRootAccessContext,
  normalizeClusterPath,
} from "./files";

const silent = pino({ level: "silent" });

class ClusterListOkService extends FileService {
  override async listClusterReal() {
    return { status: "ok" as const, entries: [] };
  }
}

function makeApp(
  role: "user" | "org_admin" | "platform_admin",
  options: {
    authz?: AuthzService;
    email?: string;
    principalEmail?: string;
    principalRole?: string | null;
    principalUserId?: string | null;
    userEmail?: string;
    agentProviderOrgId?: string | null;
    service?: FileService;
  } = {},
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const userEmail = options.userEmail ?? options.email ?? `${role}@files.test`;
    const principalEmail = options.principalEmail ?? userEmail;
    const principalRole = options.principalRole === undefined ? role : options.principalRole;
    c.set("user", { sub: userEmail, email: userEmail, role });
    c.set("principal" as never, {
      sub: userEmail,
      email: principalEmail,
      userId: options.principalUserId === undefined ? `${role}-user-id` : options.principalUserId,
      role: principalRole,
      orgId: "org-a",
      orgIds: ["org-a"],
      memberships: [{ orgId: "org-a", role: role === "user" ? "member" : "admin" }],
    });
    await next();
  });
  app.onError(createErrorHandler(silent));
  app.route(
    "/api",
    createFileRoutes(options.service ?? new ClusterListOkService(), {
      clusterFileRoots: ["/home", "/scratch"],
      authz: options.authz,
      ...("agentProviderOrgId" in options
        ? { resolveAgentProviderOrg: async () => options.agentProviderOrgId }
        : {}),
    }),
  );
  return app;
}

function makeAppWithFileService(
  service: FileService,
  authz?: AuthzService,
  options: {
    email?: string;
    netdriveTransferSource?: {
      getFile: (ownerId: string, fileId: string) => Promise<{ id: string; path: string } | null>;
      getFileById?: (
        fileId: string,
      ) => Promise<{ id: string; ownerId: string; path: string } | null>;
      findFilesByPath: (
        ownerId: string,
        path: string,
        limit?: number,
      ) => Promise<Array<{ id: string; path: string }>>;
    };
    principalEmail?: string;
    principalUserId?: string | null;
    userEmail?: string;
  } = {},
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const userEmail = options.userEmail ?? options.email ?? "org_admin@files.test";
    const principalEmail = options.principalEmail ?? userEmail;
    c.set("user", {
      sub: userEmail,
      email: userEmail,
      role: "org_admin",
    });
    c.set("principal" as never, {
      sub: userEmail,
      email: principalEmail,
      userId: options.principalUserId === undefined ? "org-admin-user-id" : options.principalUserId,
      role: "org_admin",
      orgId: "org-a",
      orgIds: ["org-a"],
      memberships: [{ orgId: "org-a", role: "admin" }],
    });
    await next();
  });
  app.onError(createErrorHandler(silent));
  app.route(
    "/api",
    createFileRoutes(service, {
      clusterFileRoots: ["/home", "/scratch"],
      netdriveTransferSource: options.netdriveTransferSource,
      authz,
    }),
  );
  return app;
}

class TransferPathOkService extends FileService {
  override async checkClusterTransferPath() {
    return { status: "ok" as const };
  }
}

function enforcingAuthz(handler: (check: AuthzCheck) => Promise<void> | void): AuthzService {
  return {
    mode: "enforce",
    requirePermission: handler,
    shadowCheck: async () => undefined,
  } as unknown as AuthzService;
}

function makeAppWithRootResolver(
  resolveAllowedRootPaths: (
    ctx: ClusterFileRootAccessContext,
  ) => Promise<{ paths: string[]; hasConfiguredRoots: boolean }>,
  options: {
    role?: "user" | "org_admin" | "platform_admin";
    authz?: AuthzService;
    getAdmin?: (
      id: string,
      ctx: ClusterFileRootAccessContext,
    ) => Promise<{
      id: string;
      path: string;
      agentId: string | null;
    }>;
    listAdmin?: (ctx: ClusterFileRootAccessContext) => Promise<unknown[]>;
    service?: FileService;
    clusterFileRoots?: string[];
    auditRootPolicyChange?: FileRouteOptions["auditRootPolicyChange"];
  } = {},
) {
  const role = options.role ?? "org_admin";
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", {
      sub: `${role}@files.test`,
      email: `${role}@files.test`,
      role,
    });
    c.set("principal" as never, {
      sub: `${role}@files.test`,
      email: `${role}@files.test`,
      userId: `${role}-user-id`,
      role,
      orgId: "org-a",
      orgIds: ["org-a", "org-b"],
    });
    await next();
  });
  app.onError(createErrorHandler(silent));
  app.route(
    "/api",
    createFileRoutes(options.service ?? new ClusterListOkService(), {
      clusterFileRoots: options.clusterFileRoots ?? ["/home", "/scratch"],
      clusterFileRootService: {
        resolveAllowedRootPaths,
        listAdmin: options.listAdmin ?? (async () => []),
        getAdmin:
          options.getAdmin ??
          (async (id: string) => ({
            id,
            path: "/shared",
            agentId: "agent-a",
          })),
        create: async (input: ClusterFileRootCreate) => input,
        update: async (_id: string, patch: ClusterFileRootUpdate) => patch,
      },
      authz: options.authz,
      auditRootPolicyChange: options.auditRootPolicyChange,
    }),
  );
  return app;
}

describe("legacy file routes", () => {
  test("legacy cloud ownership uses canonical principal user id instead of token email", async () => {
    const service = new FileService();
    const oldEmailApp = makeAppWithFileService(service, undefined, {
      email: "old-cloud@files.test",
      principalUserId: "canonical-cloud-user",
    });
    const created = await oldEmailApp.request("/api/files/cloud", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "inputs/a.dat",
        size: 128,
        contentType: "application/octet-stream",
      }),
    });
    expect(created.status).toBe(201);
    const object = (await created.json()) as { id: string; userId: string };
    expect(object.userId).toBe("canonical-cloud-user");

    const newEmailApp = makeAppWithFileService(service, undefined, {
      email: "new-cloud@files.test",
      principalUserId: "canonical-cloud-user",
    });
    const listed = await newEmailApp.request("/api/files/cloud");
    const listedBody = (await listed.json()) as { entries: Array<{ id: string }> };
    expect(listedBody.entries.map((entry) => entry.id)).toContain(object.id);

    const renamed = await newEmailApp.request(`/api/files/cloud/${object.id}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "inputs/renamed.dat" }),
    });
    expect(renamed.status).toBe(200);

    const deleted = await newEmailApp.request(`/api/files/cloud/${object.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
  });

  test("normalizes cluster paths without escaping above root", () => {
    expect(normalizeClusterPath("/home/alice/../bob")).toBe("/home/bob");
    expect(normalizeClusterPath("../../etc")).toBe("/etc");
  });

  test("cluster file root fallback context does not trust stale JWT role", () => {
    const ctx = fallbackClusterFileRootAccessContext({
      sub: "stale-admin",
      email: "stale-admin@files.test",
      orgId: "legacy-org",
    });

    expect(ctx.role).toBe("guest");
    expect(ctx.orgId).toBe("legacy-org");
    expect(ctx.orgIds).toEqual([]);
    expect(ctx.userId).toBeNull();
  });

  test("GET /api/files/cluster rejects plain users", async () => {
    const res = await makeApp("user").request("/api/files/cluster?path=/home");
    expect(res.status).toBe(403);
  });

  test("GET /api/files/cluster allows plain users through a persistent shared root", async () => {
    const app = makeAppWithRootResolver(
      async () => ({ paths: ["/shared"], hasConfiguredRoots: true }),
      { role: "user" },
    );

    const res = await app.request("/api/files/cluster?path=/shared/project-a");
    const body = (await res.json()) as { path: string; roots: string[] };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/shared/project-a");
    expect(body.roots).toEqual(["/shared"]);
  });

  test("GET /api/files/cluster rejects paths outside configured roots", async () => {
    const res = await makeApp("org_admin").request("/api/files/cluster?path=/etc");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("PATH_OUTSIDE_ALLOWED_ROOT");
  });

  test("GET /api/files/cluster allows org admins under configured roots", async () => {
    const res = await makeApp("org_admin").request("/api/files/cluster?path=/home/alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; roots: string[]; entries: unknown[] };
    expect(body.path).toBe("/home/alice");
    expect(body.roots).toEqual(["/home", "/scratch"]);
    expect(body.entries).toBeInstanceOf(Array);
  });

  test("GET /api/files/cluster selects the first authorized root when path is omitted", async () => {
    const res = await makeApp("org_admin").request("/api/files/cluster");
    const body = (await res.json()) as { path: string; roots: string[] };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/home");
    expect(body.roots).toEqual(["/home", "/scratch"]);
  });

  test("GET /api/files/cluster normalizes roots into a deterministic order", async () => {
    const app = makeAppWithRootResolver(async () => ({ paths: [], hasConfiguredRoots: false }), {
      clusterFileRoots: ["/scratch/", "/home", "/scratch"],
    });

    const res = await app.request("/api/files/cluster");
    const body = (await res.json()) as { path: string; roots: string[] };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/home");
    expect(body.roots).toEqual(["/home", "/scratch"]);
  });

  test("GET /api/files/cluster fails closed when the Agent listing channel is unavailable", async () => {
    const res = await makeAppWithFileService(new FileService()).request(
      "/api/files/cluster?path=/scratch/me/inputs",
    );
    const body = (await res.json()) as {
      error?: { code?: string; details?: { reason?: string; path?: string } };
    };

    expect(res.status).toBe(503);
    expect(body.error?.code).toBe("AGENT_OFFLINE");
    expect(body.error?.details).toEqual({
      reason: "CLUSTER_LIST_UNAVAILABLE",
      path: "/scratch/me/inputs",
    });
  });

  test("GET /api/files/cluster returns not found when the real listing fails", async () => {
    class FailingRealListService extends FileService {
      override async listClusterReal() {
        return { status: "failed" as const };
      }
    }
    const res = await makeAppWithFileService(new FailingRealListService()).request(
      "/api/files/cluster?path=/scratch/me/inputs",
    );
    const body = (await res.json()) as { error?: { message?: string } };

    expect(res.status).toBe(404);
    expect(body.error?.message).toContain("Cluster path not found or unavailable");
  });

  test("GET /api/files/cluster prefers persisted roots over static fallback", async () => {
    const app = makeAppWithRootResolver(async () => ({
      paths: ["/project-a"],
      hasConfiguredRoots: true,
    }));

    const staticRoot = await app.request("/api/files/cluster?path=/home/alice");
    expect(staticRoot.status).toBe(403);

    const persistedRoot = await app.request("/api/files/cluster?path=/project-a/run-1");
    expect(persistedRoot.status).toBe(200);
  });

  test("GET /api/files/cluster does not fallback when persisted roots exist but are invisible", async () => {
    const app = makeAppWithRootResolver(async () => ({
      paths: [],
      hasConfiguredRoots: true,
    }));

    const res = await app.request("/api/files/cluster?path=/home/alice");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details?: { allowedRoots?: string[] } } };
    expect(body.error.details?.allowedRoots).toEqual([]);
  });

  test("GET /api/files/cluster falls back to static roots before any persisted root exists", async () => {
    const app = makeAppWithRootResolver(async () => ({
      paths: [],
      hasConfiguredRoots: false,
    }));

    const res = await app.request("/api/files/cluster?path=/home/alice");
    expect(res.status).toBe(200);
  });

  test("GET /api/files/cluster fails closed when neither persisted nor static roots exist", async () => {
    const app = makeAppWithRootResolver(
      async () => ({
        paths: [],
        hasConfiguredRoots: false,
      }),
      { clusterFileRoots: [] },
    );

    const res = await app.request("/api/files/cluster?path=/home/alice");
    const body = (await res.json()) as { error: { details?: { allowedRoots?: string[] } } };

    expect(res.status).toBe(403);
    expect(body.error.details?.allowedRoots).toEqual([]);
  });

  test("GET /api/files/cluster returns an explicit empty root state when path is omitted", async () => {
    class UnexpectedListingService extends FileService {
      override async listClusterReal(): Promise<never> {
        throw new Error("listing must not run without an authorized root");
      }
    }
    const app = makeAppWithRootResolver(async () => ({ paths: [], hasConfiguredRoots: false }), {
      clusterFileRoots: [],
      service: new UnexpectedListingService(),
    });

    const res = await app.request("/api/files/cluster");
    const body = (await res.json()) as { entries: unknown[]; path: null; roots: string[] };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ entries: [], path: null, roots: [] });
  });

  test("GET /api/files/cluster passes all bound org memberships to root resolution", async () => {
    const contexts: ClusterFileRootAccessContext[] = [];
    const app = makeAppWithRootResolver(async (ctx) => {
      contexts.push(ctx);
      return {
        paths: ["/shared"],
        hasConfiguredRoots: true,
      };
    });

    const res = await app.request("/api/files/cluster?path=/shared/run-1");
    expect(res.status).toBe(200);
    expect(contexts[0]?.orgIds).toEqual(["org-a", "org-b"]);
  });

  test("GET /api/files/cluster allows SpiceDB-enforced non-admin access through root resolution", async () => {
    const contexts: ClusterFileRootAccessContext[] = [];
    const app = makeAppWithRootResolver(
      async (ctx) => {
        contexts.push(ctx);
        return {
          paths: ["/shared"],
          hasConfiguredRoots: true,
        };
      },
      {
        role: "user",
        authz: { mode: "enforce" } as unknown as AuthzService,
      },
    );

    const res = await app.request("/api/files/cluster?path=/shared/run-1");

    expect(res.status).toBe(200);
    expect(contexts[0]?.role).toBe("user");
  });

  test("buildClusterDownloadCommand single-quotes the requested path", () => {
    const command = buildClusterDownloadCommand("/scratch/me/a'$(touch pwned).txt");
    expect(command).toContain("base64 '/scratch/me/a'\\''$(touch pwned).txt'");
    expect(command).toContain("test -f '/scratch/me/a'\\''$(touch pwned).txt'");
  });

  test("cluster transfer preflight commands single-quote requested paths", () => {
    const path = "/scratch/me/a'$(touch pwned).txt";

    expect(buildClusterSourceFileCheckCommand(path)).toBe(
      "test -f '/scratch/me/a'\\''$(touch pwned).txt'",
    );
    expect(buildClusterTargetParentCheckCommand(path)).toContain(
      "dirname -- '/scratch/me/a'\\''$(touch pwned).txt'",
    );
  });

  test("cloud-to-cluster preflight accepts a missing nested target under a writable ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-transfer-target-"));
    try {
      const target = join(root, "me", "inputs", "result.txt");
      const process = Bun.spawn(["sh", "-c", buildClusterTargetParentCheckCommand(target)], {
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(await process.exited).toBe(0);
      expect(existsSync(join(root, "me"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cluster file root check command single-quotes requested paths", () => {
    const command = buildClusterRootCheckCommand("/scratch/me/a'$(touch pwned)");

    expect(command).toContain("root='/scratch/me/a'\\''$(touch pwned)'");
    expect(command).toContain('[ ! -d "$root" ]');
  });

  test("GET /api/files/cluster/download rejects paths outside configured roots", async () => {
    const res = await makeApp("org_admin").request("/api/files/cluster/download?path=/etc/passwd");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("PATH_OUTSIDE_ALLOWED_ROOT");
  });

  test("GET /api/files/cluster/download returns an attachment from the file service", async () => {
    class DownloadService extends FileService {
      override async downloadClusterReal() {
        return { status: "ok" as const, body: Buffer.from("cluster-bytes") };
      }
    }
    const res = await makeAppWithFileService(new DownloadService()).request(
      "/api/files/cluster/download?path=/scratch/me/result.txt",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="result.txt"');
    expect(await res.text()).toBe("cluster-bytes");
  });

  test("GET /api/files/cluster/download distinguishes an unavailable Agent channel", async () => {
    const res = await makeAppWithFileService(new FileService()).request(
      "/api/files/cluster/download?agentId=agent-offline&path=/scratch/me/result.txt",
    );
    const body = (await res.json()) as {
      error?: { code?: string; details?: { reason?: string; path?: string } };
    };

    expect(res.status).toBe(503);
    expect(body.error?.code).toBe("AGENT_OFFLINE");
    expect(body.error?.details).toEqual({
      reason: "CLUSTER_DOWNLOAD_UNAVAILABLE",
      path: "/scratch/me/result.txt",
    });
  });

  test("GET /api/files/cluster/download returns 404 for a failed file command", async () => {
    class MissingDownloadService extends FileService {
      override async downloadClusterReal() {
        return { status: "failed" as const };
      }
    }
    const res = await makeAppWithFileService(new MissingDownloadService()).request(
      "/api/files/cluster/download?agentId=agent-a&path=/scratch/me/missing.txt",
    );
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(404);
    expect(body.error?.details?.reason).toBe("CLUSTER_FILE_UNAVAILABLE");
  });

  test("GET /api/admin/cluster-file-roots allows SpiceDB-enforced non-admin admin listing", async () => {
    const contexts: ClusterFileRootAccessContext[] = [];
    const app = makeAppWithRootResolver(async () => ({ paths: [], hasConfiguredRoots: true }), {
      role: "user",
      authz: { mode: "enforce" } as unknown as AuthzService,
      listAdmin: async (ctx) => {
        contexts.push(ctx);
        return [{ id: "root-1", path: "/shared" }];
      },
    });

    const res = await app.request("/api/admin/cluster-file-roots");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { roots: Array<{ id: string }> };
    expect(body.roots[0]?.id).toBe("root-1");
    expect(contexts[0]?.role).toBe("user");
  });

  test("POST /api/admin/cluster-file-roots/:id/check returns live root diagnostics", async () => {
    class NotWritableRootService extends FileService {
      override async checkClusterFileRoot() {
        return { status: "not_writable" as const };
      }
    }
    const rootId = "00000000-0000-4000-8000-000000000001";
    const contexts: ClusterFileRootAccessContext[] = [];
    const app = makeAppWithRootResolver(async () => ({ paths: [], hasConfiguredRoots: true }), {
      service: new NotWritableRootService(),
      getAdmin: async (_id, ctx) => {
        contexts.push(ctx);
        return {
          id: rootId,
          path: "/scratch/me",
          agentId: "agent-a",
        };
      },
    });

    const res = await app.request(`/api/admin/cluster-file-roots/${rootId}/check`, {
      method: "POST",
    });
    const body = (await res.json()) as {
      rootId: string;
      path: string;
      agentId: string | null;
      status: string;
      checkedAt: string;
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      rootId,
      path: "/scratch/me",
      agentId: "agent-a",
      status: "not_writable",
    });
    expect(Date.parse(body.checkedAt)).toBeGreaterThan(0);
    expect(contexts[0]?.role).toBe("org_admin");
  });

  test("POST /api/files/transfers rejects when cluster path preflight is unavailable", async () => {
    const res = await makeApp("org_admin").request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(503);
    expect(body.error?.details?.reason).toBe("CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE");
  });

  test("POST /api/files/transfers rejects cluster paths outside allowed roots", async () => {
    const app = makeAppWithRootResolver(async () => ({
      paths: ["/project-a"],
      hasConfiguredRoots: true,
    }));

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });
    const body = (await res.json()) as { error?: { message?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.message).toContain("Transfer cluster path is outside allowed roots");
  });

  test("POST /api/files/transfers rejects a missing cluster source before starting upload", async () => {
    class MissingSourceService extends FileService {
      override async checkClusterTransferPath() {
        return { status: "missing" as const };
      }
    }
    const app = makeAppWithFileService(new MissingSourceService());

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cluster_to_cloud",
        source: "/scratch/me/inputs/README.md",
        target: "users/me/README.md",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(404);
    expect(body.error?.details?.reason).toBe("CLUSTER_SOURCE_FILE_UNAVAILABLE");
  });

  test("POST /api/files/transfers rejects an unwritable cluster target before download", async () => {
    class UnwritableTargetService extends FileService {
      override async checkClusterTransferPath() {
        return { status: "not_writable" as const };
      }
    }
    const app = makeAppWithFileService(new UnwritableTargetService());

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "users/me/all-suno-prompts.txt",
        target: "/scratch/me/inputs/all-suno-prompts.txt",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 3_700_000,
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(403);
    expect(body.error?.details?.reason).toBe("CLUSTER_TARGET_DIR_NOT_WRITABLE");
  });

  test("POST /api/files/transfers rejects missing NetDrive source id before download", async () => {
    let clusterPreflightCalls = 0;
    class RecordingPreflightService extends TransferPathOkService {
      override async checkClusterTransferPath() {
        clusterPreflightCalls += 1;
        return { status: "ok" as const };
      }
    }
    const app = makeAppWithFileService(new RecordingPreflightService(), undefined, {
      netdriveTransferSource: {
        getFile: async () => null,
        findFilesByPath: async () => [],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/missing.dat",
        sourceFileId: "00000000-0000-4000-8000-000000000111",
        target: "/scratch/me/inputs/missing.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(404);
    expect(body.error?.details?.reason).toBe("NETDRIVE_SOURCE_FILE_UNAVAILABLE");
    expect(clusterPreflightCalls).toBe(0);
  });

  test("POST /api/files/transfers rejects unresolved NetDrive source path before download", async () => {
    const app = makeAppWithFileService(new TransferPathOkService(), undefined, {
      netdriveTransferSource: {
        getFile: async () => null,
        findFilesByPath: async () => [],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/missing.dat",
        target: "/scratch/me/inputs/missing.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(404);
    expect(body.error?.details?.reason).toBe("NETDRIVE_SOURCE_FILE_UNAVAILABLE");
  });

  test("POST /api/files/transfers resolves a unique legacy source path to its canonical id", async () => {
    const sourceFileId = "00000000-0000-4000-8000-000000000111";
    const app = makeAppWithFileService(new TransferPathOkService(), undefined, {
      netdriveTransferSource: {
        getFile: async () => null,
        findFilesByPath: async () => [{ id: sourceFileId, path: "inputs/source.dat" }],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/source.dat",
        target: "/scratch/me/inputs/source.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });
    const body = (await res.json()) as Transfer;

    expect(res.status).toBe(201);
    expect(body.source).toBe("inputs/source.dat");
    expect(body.sourceFileId).toBe(sourceFileId);
    expect(body.netdriveFileIds).toEqual([sourceFileId]);
  });

  test("POST /api/files/transfers rejects an ambiguous legacy source path", async () => {
    const app = makeAppWithFileService(new TransferPathOkService(), undefined, {
      netdriveTransferSource: {
        getFile: async () => null,
        findFilesByPath: async () => [
          { id: "00000000-0000-4000-8000-000000000111", path: "inputs/source.dat" },
          { id: "00000000-0000-4000-8000-000000000112", path: "inputs/source.dat" },
        ],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/source.dat",
        target: "/scratch/me/inputs/source.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(409);
    expect(body.error?.details?.reason).toBe("NETDRIVE_SOURCE_PATH_AMBIGUOUS");
  });

  test("POST /api/files/transfers accepts sourceFileId even when the display path drifted", async () => {
    const app = makeAppWithFileService(new TransferPathOkService(), undefined, {
      netdriveTransferSource: {
        getFile: async (_ownerId, fileId) =>
          fileId === "00000000-0000-4000-8000-000000000111"
            ? { id: fileId, path: "inputs/renamed.dat" }
            : null,
        findFilesByPath: async () => [],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/old-display-name.dat",
        sourceFileId: "00000000-0000-4000-8000-000000000111",
        target: "/scratch/me/inputs/renamed.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Transfer;
    expect(body.source).toBe("inputs/renamed.dat");
    expect(body.sourceFileId).toBe("00000000-0000-4000-8000-000000000111");
    expect(body.netdriveFileIds).toEqual(["00000000-0000-4000-8000-000000000111"]);
    expect(body.state).toBe("failed");
    expect(body.error).toContain("real transfer backend unavailable");

    const listed = await app.request("/api/files/transfers");
    const listedBody = (await listed.json()) as { transfers: Transfer[] };
    expect(listedBody.transfers).toContainEqual(
      expect.objectContaining({
        id: body.id,
        sourceFileId: "00000000-0000-4000-8000-000000000111",
        netdriveFileIds: ["00000000-0000-4000-8000-000000000111"],
      }),
    );
  });

  test("POST /api/files/transfers accepts a shared source only after netdrive_file use authorization", async () => {
    const sourceFileId = "00000000-0000-4000-8000-000000000111";
    const checks: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      checks.push(check);
    });
    const app = makeAppWithFileService(new TransferPathOkService(), authz, {
      netdriveTransferSource: {
        getFile: async () => null,
        getFileById: async (fileId) => ({
          id: fileId,
          ownerId: "shared-owner",
          path: "shared/input.dat",
        }),
        findFilesByPath: async () => [],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "stale/display.dat",
        sourceFileId,
        target: "/scratch/me/input.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });

    expect(res.status).toBe(201);
    expect(checks).toContainEqual(
      expect.objectContaining({
        actorUserId: "org-admin-user-id",
        resource: { type: "netdrive_file", id: sourceFileId },
        permission: "use",
        subject: { type: "user", id: "org-admin-user-id" },
      }),
    );
  });

  test("POST /api/files/transfers rejects a shared source without netdrive_file use authorization", async () => {
    const sourceFileId = "00000000-0000-4000-8000-000000000111";
    const authz = enforcingAuthz(() => {
      throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
    });
    const app = makeAppWithFileService(new TransferPathOkService(), authz, {
      netdriveTransferSource: {
        getFile: async () => null,
        getFileById: async (fileId) => ({
          id: fileId,
          ownerId: "shared-owner",
          path: "shared/input.dat",
        }),
        findFilesByPath: async () => [],
      },
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "shared/input.dat",
        sourceFileId,
        target: "/scratch/me/input.dat",
        agentId: "agent-a",
        siteId: "site-a",
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { details: { reason: "NETDRIVE_SOURCE_FILE_UNAVAILABLE" } },
    });
  });

  test("reconcileInterruptedTransfers fails only non-terminal transfer records", async () => {
    const store = new InMemoryFileTransferStore();
    const service = new FileService(store);
    const base = {
      userId: "canonical-file-transfer-user",
      direction: "cloud_to_cluster",
      source: "inputs/a.dat",
      target: "/scratch/me/inputs/a.dat",
      agentId: "agent-a",
      siteId: "site-a",
      totalBytes: 128,
      copiedBytes: 0,
      startedAt: "2026-07-08T00:00:00.000Z",
      finishedAt: null,
      error: null,
      sourceFileId: "00000000-0000-4000-8000-000000000111",
      netdriveFileIds: ["00000000-0000-4000-8000-000000000111"],
    } satisfies Omit<Transfer, "id" | "state">;
    await store.create({
      ...base,
      id: "00000000-0000-4000-8000-000000000201",
      state: "running",
    });
    await store.create({
      ...base,
      id: "00000000-0000-4000-8000-000000000202",
      state: "queued",
    });
    await store.create({
      ...base,
      id: "00000000-0000-4000-8000-000000000203",
      state: "succeeded",
      finishedAt: "2026-07-08T00:01:00.000Z",
    });

    const interrupted = await service.reconcileInterruptedTransfers();
    expect(interrupted).toBe(2);
    const transfers = await store.listByUser("canonical-file-transfer-user");

    expect(transfers).toContainEqual(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000201",
        state: "failed",
        error: "TRANSFER_INTERRUPTED_BY_SERVER_RESTART",
      }),
    );
    expect(transfers).toContainEqual(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000202",
        state: "failed",
        error: "TRANSFER_INTERRUPTED_BY_SERVER_RESTART",
      }),
    );
    expect(transfers).toContainEqual(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000203",
        state: "succeeded",
        error: null,
      }),
    );
  });

  test("GET /api/files/transfers filters by state and exact error code", async () => {
    const store = new InMemoryFileTransferStore();
    const service = new FileService(store);
    const base = {
      userId: "transfer-filter-user",
      direction: "cloud_to_cluster",
      source: "inputs/a.dat",
      target: "/scratch/me/inputs/a.dat",
      agentId: "agent-a",
      siteId: "site-a",
      totalBytes: 128,
      copiedBytes: 0,
      startedAt: null,
      finishedAt: "2026-07-08T00:00:00.000Z",
      sourceFileId: "00000000-0000-4000-8000-000000000111",
      netdriveFileIds: ["00000000-0000-4000-8000-000000000111"],
    } satisfies Omit<Transfer, "id" | "state" | "error">;
    await store.create({
      ...base,
      id: "00000000-0000-4000-8000-000000000211",
      state: "failed",
      error: "TRANSFER_INTERRUPTED_BY_SERVER_RESTART",
    });
    await store.create({
      ...base,
      id: "00000000-0000-4000-8000-000000000212",
      state: "failed",
      error: "other failure",
    });
    await store.create({
      ...base,
      id: "00000000-0000-4000-8000-000000000213",
      state: "running",
      error: null,
      finishedAt: null,
      startedAt: "2026-07-08T00:00:00.000Z",
    });
    const app = makeAppWithFileService(service, undefined, {
      principalUserId: "transfer-filter-user",
    });

    const filtered = await app.request(
      "/api/files/transfers?state=failed&error=TRANSFER_INTERRUPTED_BY_SERVER_RESTART",
    );
    const body = (await filtered.json()) as { transfers: Transfer[] };

    expect(filtered.status).toBe(200);
    expect(body.transfers.map((transfer) => transfer.id)).toEqual([
      "00000000-0000-4000-8000-000000000211",
    ]);

    const invalid = await app.request("/api/files/transfers?state=bogus");
    expect(invalid.status).toBe(400);
  });

  test("POST /api/files/transfers passes canonical user id to the real transfer runner seam", async () => {
    class CapturingTransferService extends TransferPathOkService {
      actorUserIds: Array<string | null | undefined> = [];
      override async createTransfer(
        userId: string,
        data: TransferCreate,
        actorUserId?: string | null,
      ): Promise<Transfer> {
        this.actorUserIds.push(actorUserId);
        return super.createTransfer(userId, data, actorUserId);
      }
    }
    const service = new CapturingTransferService();
    const app = makeAppWithFileService(service);

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });

    expect(res.status).toBe(201);
    expect(service.actorUserIds).toEqual(["org-admin-user-id"]);
  });

  test("revalidates Cluster File Root authorization immediately before Agent dispatch", async () => {
    const service = new TransferPathOkService();
    const started: string[] = [];
    const runner: FileTransferRunner = {
      canHandle: () => true,
      start: async (_actorUserId, transferId) => {
        started.push(transferId);
      },
      cancel: async () => true,
    };
    service.attachRunner(runner);
    let resolutions = 0;
    const app = makeAppWithRootResolver(
      async () => {
        resolutions += 1;
        return resolutions === 1
          ? { paths: ["/scratch"], hasConfiguredRoots: true }
          : { paths: [], hasConfiguredRoots: true };
      },
      { service },
    );

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cluster_to_cloud",
        source: "/scratch/run/output.dat",
        target: "outputs/output.dat",
        agentId: "agent-a",
      }),
    });
    const created = (await res.json()) as Transfer;

    expect(res.status).toBe(201);
    expect(created.state).toBe("queued");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [transfer] = await service.listTransfers("org_admin-user-id");
      if (transfer?.state === "failed") break;
      await Bun.sleep(5);
    }
    expect(await service.listTransfers("org_admin-user-id")).toContainEqual(
      expect.objectContaining({
        id: created.id,
        state: "failed",
        error: "TRANSFER_ROOT_AUTHORIZATION_REVOKED",
      }),
    );
    expect(resolutions).toBe(2);
    expect(started).toEqual([]);
  });

  test("marks and audits running transfers when their bound root policy changes", async () => {
    const rootId = "00000000-0000-4000-8000-000000000301";
    const service = new TransferPathOkService();
    service.attachRunner({
      canHandle: () => true,
      start: async () => undefined,
      cancel: async () => true,
    });
    const audits: Array<{ transferId: string; rootId: string }> = [];
    const app = makeAppWithRootResolver(
      async () => ({
        paths: ["/scratch"],
        hasConfiguredRoots: true,
        roots: [{ id: rootId, path: "/scratch", updatedAt: "2026-07-13T00:00:00.000Z" }],
      }),
      {
        service,
        auditRootPolicyChange: async (event) => {
          audits.push({ transferId: event.transfer.id, rootId: event.rootId });
        },
      },
    );
    const createdRes = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cluster_to_cloud",
        source: "/scratch/run/output.dat",
        target: "outputs/output.dat",
        agentId: "agent-a",
      }),
    });
    const created = (await createdRes.json()) as Transfer;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [transfer] = await service.listTransfers("org_admin-user-id");
      if (transfer?.state === "running") break;
      await Bun.sleep(5);
    }

    const patchRes = await app.request(`/api/admin/cluster-file-roots/${rootId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const [updated] = await service.listTransfers("org_admin-user-id");

    expect(patchRes.status).toBe(200);
    expect(updated).toEqual(
      expect.objectContaining({
        id: created.id,
        state: "running",
        clusterRootId: rootId,
        rootPolicyChangedAt: expect.any(String),
      }),
    );
    expect(audits).toEqual([{ transferId: created.id, rootId }]);
  });

  test("legacy transfer ownership uses canonical principal user id instead of token email", async () => {
    const service = new TransferPathOkService();
    const makeCanonicalApp = (email: string) => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user", { sub: email, email, role: "org_admin" });
        c.set("principal" as never, {
          sub: email,
          email,
          userId: "canonical-file-transfer-user",
          role: "org_admin",
          orgId: "org-a",
          orgIds: ["org-a"],
          memberships: [{ orgId: "org-a", role: "admin" }],
        });
        await next();
      });
      app.onError(createErrorHandler(silent));
      app.route("/api", createFileRoutes(service, { clusterFileRoots: ["/home", "/scratch"] }));
      return app;
    };

    const created = await makeCanonicalApp("old-email@files.test").request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });
    expect(created.status).toBe(201);
    const transfer = (await created.json()) as { id: string; userId: string };
    expect(transfer.userId).toBe("canonical-file-transfer-user");

    const appAfterEmailChange = makeCanonicalApp("new-email@files.test");
    const listed = await appAfterEmailChange.request("/api/files/transfers");
    const body = (await listed.json()) as { transfers: Transfer[] };
    expect(body.transfers.map((item) => item.id)).toContain(transfer.id);

    const cancelled = await appAfterEmailChange.request(
      `/api/files/transfers/${transfer.id}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);
  });

  test("POST /api/files/transfers delegates authorization to the persistent root", async () => {
    const calls: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      calls.push(check);
      throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
    });
    const app = makeAppWithRootResolver(
      async () => ({ paths: ["/scratch"], hasConfiguredRoots: true }),
      { role: "user", authz, service: new TransferPathOkService() },
    );
    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });

    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
  });

  test("POST /api/files/transfers rejects a missing agent before creating a record", async () => {
    const app = makeApp("org_admin", {
      agentProviderOrgId: undefined,
      service: new TransferPathOkService(),
    });

    const res = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });
    const listed = await app.request("/api/files/transfers");
    const body = (await listed.json()) as { transfers: Transfer[] };

    expect(res.status).toBe(404);
    expect(body.transfers).toEqual([]);
  });

  test("POST /api/files/transfers fails closed without a canonical principal", async () => {
    const res = await makeApp("org_admin", { principalUserId: null }).request(
      "/api/files/transfers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          direction: "cloud_to_cluster",
          source: "inputs/a.dat",
          target: "/scratch/me/inputs/a.dat",
          agentId: "agent-a",
          siteId: "site-a",
          totalBytes: 128,
        }),
      },
    );

    expect(res.status).toBe(403);
  });

  test("POST /api/files/transfers requires an explicit agent id", async () => {
    const res = await makeApp("org_admin").request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });
    const body = (await res.json()) as { error?: { details?: { reason?: string } } };

    expect(res.status).toBe(400);
    expect(body.error?.details?.reason).toBe("TRANSFER_AGENT_REQUIRED");
  });

  test("POST /api/files/transfers/:id/cancel remains available to the transfer owner", async () => {
    const calls: AuthzCheck[] = [];
    const authz = enforcingAuthz((check) => {
      calls.push(check);
      throw new AppError(ErrorCode.FORBIDDEN, "denied", 403);
    });
    const app = makeAppWithFileService(new TransferPathOkService(), authz, {
      principalEmail: "bound-files@files.test",
      userEmail: "stale-token-files@files.test",
    });
    const created = await app.request("/api/files/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "cloud_to_cluster",
        source: "inputs/a.dat",
        target: "/scratch/me/inputs/a.dat",
        agentId: "agent-a",
        siteId: "site-a",
        totalBytes: 128,
      }),
    });
    expect(created.status).toBe(201);
    const transfer = (await created.json()) as { id: string };

    const cancelled = await app.request(`/api/files/transfers/${transfer.id}/cancel`, {
      method: "POST",
    });

    expect(cancelled.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
