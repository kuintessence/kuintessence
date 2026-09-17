import {
  AppError,
  CloudObjectCreateSchema,
  CloudObjectRenameSchema,
  type ClusterFileRootCheckResponse,
  type ClusterFileRootCreate,
  ClusterFileRootCreateSchema,
  ClusterFileRootIdSchema,
  type ClusterFileRootUpdate,
  ClusterFileRootUpdateSchema,
  ErrorCode,
  type Transfer,
  type TransferCreate,
  TransferCreateSchema,
  TransferStateEnum,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { type AgentProviderOrgResolver, ownershipPrincipalFromContext } from "../auth/ownership";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { assertRole } from "../middleware/rbac";
import { kqValidator } from "../middleware/validator";
import type {
  AllowedClusterFileRoots,
  ClusterFileRootAccessContext,
} from "../services/cluster-file-root";
import type { FileService } from "../services/file-service";
import { authorizeNetDriveThroughSpice } from "./netdrive";

interface ClusterFileRootRouteService {
  resolveAllowedRootPaths(
    ctx: ClusterFileRootAccessContext,
    options?: { agentId?: string; siteId?: string },
  ): Promise<AllowedClusterFileRoots>;
  listAdmin(ctx: ClusterFileRootAccessContext): Promise<unknown[]>;
  getAdmin(
    id: string,
    ctx: ClusterFileRootAccessContext,
  ): Promise<{
    id: string;
    path: string;
    agentId: string | null;
  }>;
  create(input: ClusterFileRootCreate, ctx: ClusterFileRootAccessContext): Promise<unknown>;
  update(
    id: string,
    patch: ClusterFileRootUpdate,
    ctx: ClusterFileRootAccessContext,
  ): Promise<unknown>;
}

interface NetDriveTransferSourceService {
  getFile(ownerId: string, fileId: string): Promise<{ id: string; path: string } | null>;
  getFileById?(fileId: string): Promise<{ id: string; ownerId: string; path: string } | null>;
  findFilesByPath(
    ownerId: string,
    path: string,
    limit?: number,
  ): Promise<Array<{ id: string; path: string }>>;
}

export interface FileRouteOptions {
  clusterFileRoots?: string[];
  clusterFileRootService?: ClusterFileRootRouteService;
  netdriveTransferSource?: NetDriveTransferSourceService;
  resolveAgentProviderOrg?: AgentProviderOrgResolver;
  authz?: AuthzService;
  auditRootPolicyChange?: (event: {
    actorUserId: string;
    rootId: string;
    changedAt: string;
    transfer: Transfer;
  }) => Promise<void>;
}

export function createFileRoutes(service: FileService, options: FileRouteOptions = {}) {
  const routes = new Hono();
  const clusterFileRootService = options.clusterFileRootService;
  const clusterFileRoots = normalizeRoots(options.clusterFileRoots ?? []);

  // -------- Cloud objects --------

  routes.get("/files/cloud", (c) => {
    const actorUserId = requireLegacyFileActorUserId(c);
    const prefix = c.req.query("prefix") ?? "";
    return c.json({ entries: service.listCloud(actorUserId, prefix) });
  });

  routes.post(
    "/files/cloud",
    kqValidator("json", CloudObjectCreateSchema, "Invalid cloud object body"),
    (c) => {
      const actorUserId = requireLegacyFileActorUserId(c);
      return c.json(service.createCloud(actorUserId, c.req.valid("json")), 201);
    },
  );

  routes.post(
    "/files/cloud/:id/rename",
    kqValidator("json", CloudObjectRenameSchema, "Invalid cloud rename body"),
    (c) => {
      const actorUserId = requireLegacyFileActorUserId(c);
      return c.json(service.rename(actorUserId, c.req.param("id"), c.req.valid("json")));
    },
  );

  routes.delete("/files/cloud/:id", (c) => {
    const actorUserId = requireLegacyFileActorUserId(c);
    service.deleteCloud(actorUserId, c.req.param("id"));
    return c.json({ ok: true });
  });

  // -------- Cluster listings --------

  routes.get("/files/cluster", async (c) => {
    assertClusterFileRouteAccess(c, options);
    const siteId = c.req.query("siteId") ?? "default";
    const agentId = c.req.query("agentId") ?? undefined;
    const allowedRoots = await resolveAllowedClusterRoots(c, options, clusterFileRoots, {
      agentId,
      siteId,
    });
    const requestedPath = c.req.query("path");
    if (!requestedPath && allowedRoots.length === 0) {
      return c.json({ entries: [], siteId, path: null, roots: [] });
    }
    const path = normalizeClusterPath(requestedPath ?? allowedRoots[0] ?? "/");
    if (!isUnderAllowedRoot(path, allowedRoots)) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cluster path is outside allowed roots", 403, {
        reason: "PATH_OUTSIDE_ALLOWED_ROOT",
        allowedRoots,
      });
    }
    const real = await service.listClusterReal(path, { agentId, siteId });
    if (real.status === "unavailable") {
      throw new AppError(ErrorCode.AGENT_OFFLINE, "Cluster listing is unavailable", 503, {
        reason: "CLUSTER_LIST_UNAVAILABLE",
        path,
      });
    }
    if (real.status === "failed") {
      throw new AppError(ErrorCode.NOT_FOUND, "Cluster path not found or unavailable", 404, {
        reason: "CLUSTER_PATH_UNAVAILABLE",
        path,
      });
    }
    return c.json({ entries: real.entries, siteId, path, roots: allowedRoots });
  });

  routes.get("/files/cluster/download", async (c) => {
    assertClusterFileRouteAccess(c, options);
    const siteId = c.req.query("siteId") ?? "default";
    const agentId = c.req.query("agentId") ?? undefined;
    const allowedRoots = await resolveAllowedClusterRoots(c, options, clusterFileRoots, {
      agentId,
      siteId,
    });
    const path = normalizeClusterPath(c.req.query("path") ?? "");
    if (!isUnderAllowedRoot(path, allowedRoots)) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cluster path is outside allowed roots", 403, {
        reason: "PATH_OUTSIDE_ALLOWED_ROOT",
        allowedRoots,
      });
    }
    const result = await service.downloadClusterReal(path, { agentId, siteId });
    if (result.status === "unavailable") {
      throw new AppError(ErrorCode.AGENT_OFFLINE, "Cluster download is unavailable", 503, {
        reason: "CLUSTER_DOWNLOAD_UNAVAILABLE",
        path,
      });
    }
    if (result.status === "failed") {
      throw new AppError(ErrorCode.NOT_FOUND, "Cluster file not found or unavailable", 404, {
        reason: "CLUSTER_FILE_UNAVAILABLE",
        path,
      });
    }
    const filename = path.split("/").filter(Boolean).pop() ?? "cluster-file";
    return new Response(result.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  });

  if (clusterFileRootService) {
    routes.get("/admin/cluster-file-roots", async (c) => {
      assertClusterFileRouteAccess(c, options);
      const roots = await clusterFileRootService.listAdmin(clusterFileRootAccessContext(c));
      return c.json({ roots });
    });

    routes.post(
      "/admin/cluster-file-roots",
      kqValidator("json", ClusterFileRootCreateSchema, "Invalid cluster file root body"),
      async (c) => {
        assertClusterFileRouteAccess(c, options);
        const root = await clusterFileRootService.create(
          c.req.valid("json"),
          clusterFileRootAccessContext(c),
        );
        return c.json(root, 201);
      },
    );

    routes.post("/admin/cluster-file-roots/:id/check", async (c) => {
      assertClusterFileRouteAccess(c, options);
      const id = ClusterFileRootIdSchema.parse(c.req.param("id"));
      const root = await clusterFileRootService.getAdmin(id, clusterFileRootAccessContext(c));
      const check = await service.checkClusterFileRoot(root.path, {
        agentId: root.agentId ?? undefined,
      });
      const response: ClusterFileRootCheckResponse = {
        rootId: root.id,
        path: root.path,
        agentId: root.agentId,
        status: check.status,
        checkedAt: new Date().toISOString(),
      };
      return c.json(response);
    });

    routes.patch(
      "/admin/cluster-file-roots/:id",
      kqValidator("json", ClusterFileRootUpdateSchema, "Invalid cluster file root patch body"),
      async (c) => {
        assertClusterFileRouteAccess(c, options);
        const id = ClusterFileRootIdSchema.parse(c.req.param("id"));
        const patch = c.req.valid("json");
        const root = await clusterFileRootService.update(
          id,
          patch,
          clusterFileRootAccessContext(c),
        );
        if (rootAuthorizationChanged(patch)) {
          const changedAt = new Date().toISOString();
          const affected = await service.markRunningTransfersRootPolicyChanged(id, changedAt);
          const actorUserId = requireLegacyFileActorUserId(c);
          await Promise.all(
            affected.map((transfer) =>
              options.auditRootPolicyChange?.({ actorUserId, rootId: id, changedAt, transfer }),
            ),
          );
        }
        return c.json(root);
      },
    );
  }

  // -------- Transfers --------

  routes.get("/files/transfers", async (c) => {
    const actorUserId = requireLegacyFileActorUserId(c);
    const stateRaw = c.req.query("state");
    const state = stateRaw ? TransferStateEnum.safeParse(stateRaw) : null;
    if (stateRaw && !state?.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid transfer state filter", 400, {
        state: stateRaw,
      });
    }
    return c.json({
      transfers: await service.listTransfers(actorUserId, {
        state: state?.success ? state.data : undefined,
        error: c.req.query("error"),
      }),
    });
  });

  routes.post(
    "/files/transfers",
    kqValidator("json", TransferCreateSchema, "Invalid transfer body"),
    async (c) => {
      const actorUserId = requireLegacyFileActorUserId(c);
      const data = c.req.valid("json");
      const rootAccessContext = clusterFileRootAccessContext(c);
      await requireTransferAgentExists(options.resolveAgentProviderOrg, data.agentId ?? null);
      const resolvedData = await resolveCloudTransferSource(c, actorUserId, options, data);
      await requireTransferClusterPath(
        rootAccessContext,
        service,
        options,
        clusterFileRoots,
        resolvedData,
      );
      return c.json(
        await service.createTransfer(actorUserId, resolvedData, actorUserId, {
          beforeDispatch: () =>
            requireTransferRootAuthorization(
              rootAccessContext,
              options,
              clusterFileRoots,
              resolvedData,
            ),
        }),
        201,
      );
    },
  );

  routes.post("/files/transfers/:id/cancel", async (c) => {
    const actorUserId = requireLegacyFileActorUserId(c);
    const transfer = (await service.listTransfers(actorUserId)).find(
      (item) => item.id === c.req.param("id"),
    );
    if (!transfer) {
      throw new AppError(ErrorCode.NOT_FOUND, "Transfer not found", 404);
    }
    return c.json(await service.cancelTransfer(actorUserId, c.req.param("id")));
  });

  return routes;
}

function assertClusterFileRouteAccess(c: Context, options: FileRouteOptions): void {
  if (options.clusterFileRootService) return;
  assertRole(c, "org_admin");
}

async function resolveAllowedClusterRoots(
  c: Context,
  options: FileRouteOptions,
  staticRoots: string[],
  target: { agentId?: string; siteId?: string },
): Promise<string[]> {
  return resolveAllowedClusterRootsForContext(
    clusterFileRootAccessContext(c),
    options,
    staticRoots,
    target,
  );
}

async function resolveAllowedClusterRootsForContext(
  accessContext: ClusterFileRootAccessContext,
  options: FileRouteOptions,
  staticRoots: string[],
  target: { agentId?: string; siteId?: string },
): Promise<string[]> {
  const rootSelection = options.clusterFileRootService
    ? await options.clusterFileRootService.resolveAllowedRootPaths(accessContext, {
        agentId: target.agentId,
        siteId: target.siteId,
      })
    : { paths: staticRoots, hasConfiguredRoots: false };
  const roots =
    rootSelection.paths.length > 0 || rootSelection.hasConfiguredRoots
      ? rootSelection.paths
      : staticRoots;
  return normalizeRoots(roots);
}

async function requireTransferClusterPath(
  accessContext: ClusterFileRootAccessContext,
  service: FileService,
  options: FileRouteOptions,
  staticRoots: string[],
  data: {
    direction: "cloud_to_cluster" | "cluster_to_cloud";
    source: string;
    target: string;
    agentId?: string;
    siteId?: string;
  },
): Promise<void> {
  const clusterPath =
    data.direction === "cloud_to_cluster"
      ? normalizeClusterPath(data.target)
      : normalizeClusterPath(data.source);
  const allowedRoots = await resolveAllowedClusterRootsForContext(
    accessContext,
    options,
    staticRoots,
    {
      agentId: data.agentId,
      siteId: data.siteId,
    },
  );
  if (!isUnderAllowedRoot(clusterPath, allowedRoots)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Transfer cluster path is outside allowed roots", 403, {
      reason: "TRANSFER_PATH_OUTSIDE_ALLOWED_ROOT",
      allowedRoots,
    });
  }
  const check = await service.checkClusterTransferPath(data.direction, clusterPath, {
    agentId: data.agentId,
    siteId: data.siteId,
  });
  if (check.status === "unavailable") {
    throw new AppError(ErrorCode.AGENT_OFFLINE, "Cluster transfer preflight is unavailable", 503, {
      reason: "CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE",
      path: clusterPath,
    });
  }
  if (check.status === "missing") {
    const isSource = data.direction === "cluster_to_cloud";
    throw new AppError(
      ErrorCode.NOT_FOUND,
      isSource
        ? "Cluster source file not found or unavailable"
        : "Cluster target directory not found or unavailable",
      404,
      {
        reason: isSource ? "CLUSTER_SOURCE_FILE_UNAVAILABLE" : "CLUSTER_TARGET_DIR_UNAVAILABLE",
        path: clusterPath,
      },
    );
  }
  if (check.status === "not_writable") {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Cluster target directory is not writable by the agent user",
      403,
      {
        reason: "CLUSTER_TARGET_DIR_NOT_WRITABLE",
        path: clusterPath,
      },
    );
  }
}

async function requireTransferRootAuthorization(
  accessContext: ClusterFileRootAccessContext,
  options: FileRouteOptions,
  staticRoots: string[],
  data: {
    direction: "cloud_to_cluster" | "cluster_to_cloud";
    source: string;
    target: string;
    agentId?: string;
    siteId?: string;
  },
): Promise<{ clusterRootId: string | null; clusterRootRevision: string | null }> {
  const clusterPath = normalizeClusterPath(
    data.direction === "cloud_to_cluster" ? data.target : data.source,
  );
  const rootSelection = options.clusterFileRootService
    ? await options.clusterFileRootService.resolveAllowedRootPaths(accessContext, {
        agentId: data.agentId,
        siteId: data.siteId,
      })
    : { paths: staticRoots, hasConfiguredRoots: false, roots: [] };
  const allowedRoots = normalizeRoots(
    rootSelection.paths.length > 0 || rootSelection.hasConfiguredRoots
      ? rootSelection.paths
      : staticRoots,
  );
  if (!isUnderAllowedRoot(clusterPath, allowedRoots)) {
    throw new Error("TRANSFER_ROOT_AUTHORIZATION_REVOKED");
  }
  const root = [...(rootSelection.roots ?? [])]
    .filter((candidate) => isUnderAllowedRoot(clusterPath, [candidate.path]))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return {
    clusterRootId: root?.id ?? null,
    clusterRootRevision: root?.updatedAt ?? null,
  };
}

function rootAuthorizationChanged(patch: ClusterFileRootUpdate): boolean {
  return (
    patch.agentId !== undefined ||
    patch.path !== undefined ||
    patch.visibleOrgIds !== undefined ||
    patch.enabled !== undefined
  );
}

async function resolveCloudTransferSource(
  c: Context,
  actorUserId: string,
  options: FileRouteOptions,
  data: TransferCreate,
): Promise<TransferCreate> {
  if (data.direction !== "cloud_to_cluster" || !options.netdriveTransferSource) return data;
  if (data.sourceFileId) {
    const file = options.netdriveTransferSource.getFileById
      ? await options.netdriveTransferSource.getFileById(data.sourceFileId)
      : await options.netdriveTransferSource.getFile(actorUserId, data.sourceFileId);
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, "NetDrive source file not found", 404, {
        reason: "NETDRIVE_SOURCE_FILE_UNAVAILABLE",
        sourceFileId: data.sourceFileId,
      });
    }
    const allowed = await authorizeNetDriveThroughSpice(
      c,
      options.authz,
      actorUserId,
      file.id,
      "use",
      !("ownerId" in file) || file.ownerId === actorUserId,
    );
    if (!allowed) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to use this NetDrive file", 403, {
        reason: "NETDRIVE_SOURCE_FILE_UNAVAILABLE",
        sourceFileId: data.sourceFileId,
      });
    }
    return {
      ...data,
      source: file.path,
      sourceFileId: file.id,
      netdriveFileIds: [file.id],
    };
  }
  const exact = await options.netdriveTransferSource.findFilesByPath(actorUserId, data.source, 2);
  if (exact.length === 0) {
    throw new AppError(ErrorCode.NOT_FOUND, "NetDrive source file not found", 404, {
      reason: "NETDRIVE_SOURCE_FILE_UNAVAILABLE",
      source: data.source,
    });
  }
  if (exact.length > 1) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "NetDrive source path is ambiguous", 409, {
      reason: "NETDRIVE_SOURCE_PATH_AMBIGUOUS",
      source: data.source,
    });
  }
  const file = exact[0];
  if (!file) {
    throw new AppError(ErrorCode.NOT_FOUND, "NetDrive source file not found", 404);
  }
  return {
    ...data,
    source: file.path,
    sourceFileId: file.id,
    netdriveFileIds: [file.id],
  };
}

function requireLegacyFileActorUserId(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

async function requireTransferAgentExists(
  resolveAgentProviderOrg: AgentProviderOrgResolver | undefined,
  agentId: string | null,
): Promise<void> {
  if (!agentId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "File transfer requires an agent", 400, {
      reason: "TRANSFER_AGENT_REQUIRED",
    });
  }
  if (!resolveAgentProviderOrg) return;
  if ((await resolveAgentProviderOrg(agentId)) === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
  }
}

export function normalizeClusterPath(path: string): string {
  const input = path.trim();
  const absolute = input.startsWith("/") ? input : `/${input}`;
  const out: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map(normalizeClusterPath).filter((root) => root !== "/"))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function isUnderAllowedRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function fallbackClusterFileRootAccessContext(
  user: { orgId?: string | null; email?: string | null; sub?: string | null } | undefined,
): ClusterFileRootAccessContext {
  return {
    role: "guest",
    orgId: user?.orgId ?? null,
    orgIds: [],
    userId: null,
    email: user?.email ?? null,
    sub: user?.sub ?? null,
  };
}

function clusterFileRootAccessContext(c: Context): ClusterFileRootAccessContext {
  const principal = ownershipPrincipalFromContext(c);
  if (principal) {
    const bound = c.get("principal" as never) as
      | {
          userId?: string | null;
          email?: string | null;
          sub?: string | null;
        }
      | undefined;
    return {
      role: principal.role,
      orgId: principal.orgId ?? null,
      orgIds: principal.orgIds,
      userId: bound?.userId ?? null,
      email: bound?.email ?? null,
      sub: bound?.sub ?? null,
    };
  }
  const user = c.get("user") as
    | { orgId?: string | null; email?: string | null; sub?: string | null }
    | undefined;
  return fallbackClusterFileRootAccessContext(user);
}
