import { agents, clusterFileRoots, type PgDb } from "@kuintessence/db";
import {
  AppError,
  type ClusterFileRootCreate,
  type ClusterFileRootUpdate,
  type ClusterFileRootView,
  ErrorCode,
  hasRole,
  type RoleName,
} from "@kuintessence/shared";
import { eq, or } from "drizzle-orm";
import {
  clusterFileRootPlatformTuple,
  clusterFileRootProviderTuple,
  clusterFileRootVisibleOrgTuple,
} from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";

export interface ClusterFileRootAccessContext {
  role: RoleName;
  orgId: string | null;
  orgIds?: string[];
  userId?: string | null;
  email?: string | null;
  sub?: string | null;
}

export interface AllowedClusterFileRoots {
  paths: string[];
  hasConfiguredRoots: boolean;
  roots?: Array<{ id: string; path: string; updatedAt: string }>;
}

type ClusterFileRootRow = typeof clusterFileRoots.$inferSelect;

function toView(row: ClusterFileRootRow): ClusterFileRootView {
  return {
    id: row.id,
    label: row.label,
    providerOrgId: row.providerOrgId,
    agentId: row.agentId,
    path: row.path,
    capacityBytes: row.capacityBytes,
    visibleOrgIds: row.visibleOrgIds,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isPlatformWide(role: RoleName): boolean {
  return hasRole(role, "platform_admin");
}

function canManage(providerOrgId: string, ctx: ClusterFileRootAccessContext): boolean {
  if (isPlatformWide(ctx.role)) return true;
  return hasRole(ctx.role, "org_admin") && contextOrgIds(ctx).includes(providerOrgId);
}

function canUse(row: ClusterFileRootRow, ctx: ClusterFileRootAccessContext): boolean {
  if (isPlatformWide(ctx.role)) return true;
  const orgIds = contextOrgIds(ctx);
  if (orgIds.length === 0) return false;
  return (
    orgIds.includes(row.providerOrgId) || row.visibleOrgIds.some((orgId) => orgIds.includes(orgId))
  );
}

function assertManage(providerOrgId: string, ctx: ClusterFileRootAccessContext): void {
  if (canManage(providerOrgId, ctx)) return;
  throw new AppError(ErrorCode.FORBIDDEN, "Cannot manage cluster file roots outside your org", 403);
}

export function normalizeClusterRootPath(path: string): string {
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

export class ClusterFileRootService {
  constructor(
    private readonly db: PgDb,
    private readonly authz?: AuthzService,
  ) {}

  async create(
    input: ClusterFileRootCreate,
    ctx: ClusterFileRootAccessContext,
  ): Promise<ClusterFileRootView> {
    const providerOrgId = input.providerOrgId ?? ctx.orgId;
    if (!providerOrgId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "providerOrgId is required", 400);
    }
    const localAllowed = canManage(providerOrgId, ctx);
    if (this.authz?.mode !== "enforce") {
      assertManage(providerOrgId, ctx);
    }
    await this.assertProviderThroughSpice(providerOrgId, ctx, localAllowed);

    const now = new Date();
    const [row] = await this.db
      .insert(clusterFileRoots)
      .values({
        label: input.label,
        providerOrgId,
        agentId: input.agentId ?? null,
        path: normalizeClusterRootPath(input.path),
        capacityBytes: input.capacityBytes ?? null,
        visibleOrgIds: input.visibleOrgIds,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Cluster file root insert returned no rows",
        500,
      );
    }
    await this.authz?.enqueueMany(clusterFileRootTuples(row, "create"));
    return toView(row);
  }

  async listAdmin(ctx: ClusterFileRootAccessContext): Promise<ClusterFileRootView[]> {
    const rows = await this.db.select().from(clusterFileRoots);
    const visible: ClusterFileRootRow[] = [];
    for (const row of rows) {
      const localAllowed =
        isPlatformWide(ctx.role) || contextOrgIds(ctx).includes(row.providerOrgId);
      if (await this.filterThroughSpice(row, "manage", ctx, localAllowed)) {
        visible.push(row);
      }
    }
    return visible.map(toView);
  }

  async getAdmin(id: string, ctx: ClusterFileRootAccessContext): Promise<ClusterFileRootView> {
    const row = await this.getRow(id);
    const localAllowed = canManage(row.providerOrgId, ctx);
    if (this.authz?.mode !== "enforce") {
      assertManage(row.providerOrgId, ctx);
    }
    await this.assertThroughSpice(row, "manage", ctx, localAllowed);
    return toView(row);
  }

  async update(
    id: string,
    patch: ClusterFileRootUpdate,
    ctx: ClusterFileRootAccessContext,
  ): Promise<ClusterFileRootView> {
    const row = await this.getRow(id);
    const localAllowed = canManage(row.providerOrgId, ctx);
    if (this.authz?.mode !== "enforce") {
      assertManage(row.providerOrgId, ctx);
    }
    await this.assertThroughSpice(row, "manage", ctx, localAllowed);
    const [updated] = await this.db
      .update(clusterFileRoots)
      .set({
        ...patch,
        agentId: patch.agentId === undefined ? undefined : patch.agentId,
        path: patch.path === undefined ? undefined : normalizeClusterRootPath(patch.path),
        capacityBytes: patch.capacityBytes === undefined ? undefined : patch.capacityBytes,
        updatedAt: new Date(),
      })
      .where(eq(clusterFileRoots.id, id))
      .returning();
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, `Cluster file root ${id} not found`, 404);
    }
    await this.authz?.enqueueMany([
      ...clusterFileRootTuples(row, "delete"),
      ...clusterFileRootTuples(updated, "create"),
    ]);
    return toView(updated);
  }

  async resolveAllowedRootPaths(
    ctx: ClusterFileRootAccessContext,
    options: { agentId?: string; siteId?: string } = {},
  ): Promise<AllowedClusterFileRoots> {
    const rows = await this.db.select().from(clusterFileRoots);
    const enabled = rows.filter((row) => row.enabled);
    const scopedAgentIds = await this.resolveScopedAgentIds(options);
    const matchingAgent = enabled.filter((row) => {
      if (row.agentId === null) return true;
      if (!scopedAgentIds) return true;
      return scopedAgentIds.includes(row.agentId);
    });
    const usable: ClusterFileRootRow[] = [];
    for (const row of matchingAgent) {
      if (await this.filterThroughSpice(row, "use", ctx, canUse(row, ctx))) {
        usable.push(row);
      }
    }
    return {
      paths: usable.map((row) => row.path),
      hasConfiguredRoots: rows.length > 0,
      roots: usable.map((row) => ({
        id: row.id,
        path: row.path,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  private async filterThroughSpice(
    row: ClusterFileRootRow,
    permission: "view" | "use" | "manage",
    ctx: ClusterFileRootAccessContext,
    localAllowed: boolean,
  ): Promise<boolean> {
    if (!this.authz || this.authz.mode === "off") return localAllowed;
    const check = clusterFileRootCheck(row.id, permission, ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return localAllowed;
    }
    try {
      await this.authz.requirePermission(check, isPlatformWide(ctx.role));
      return true;
    } catch {
      return false;
    }
  }

  private async assertThroughSpice(
    row: ClusterFileRootRow,
    permission: "manage",
    ctx: ClusterFileRootAccessContext,
    localAllowed: boolean,
  ): Promise<void> {
    if (!this.authz || this.authz.mode === "off") return;
    const check = clusterFileRootCheck(row.id, permission, ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return;
    }
    await this.authz.requirePermission(check, isPlatformWide(ctx.role));
  }

  private async assertProviderThroughSpice(
    providerOrgId: string,
    ctx: ClusterFileRootAccessContext,
    localAllowed: boolean,
  ): Promise<void> {
    if (!this.authz || this.authz.mode === "off") return;
    const check = providerCheck(providerOrgId, ctx, localAllowed);
    if (this.authz.mode === "shadow") {
      await this.authz.shadowCheck(check);
      return;
    }
    await this.authz.requirePermission(check, isPlatformWide(ctx.role));
  }

  private async resolveScopedAgentIds(options: {
    agentId?: string;
    siteId?: string;
  }): Promise<string[] | null> {
    if (options.agentId) return [options.agentId];
    if (!options.siteId) return null;
    const rows = await this.db
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(
        or(
          eq(agents.agentId, options.siteId),
          eq(agents.siteId, options.siteId),
          eq(agents.siteName, options.siteId),
          eq(agents.clusterId, options.siteId),
        ),
      );
    return rows.map((row) => row.agentId);
  }

  private async getRow(id: string): Promise<ClusterFileRootRow> {
    const [row] = await this.db
      .select()
      .from(clusterFileRoots)
      .where(eq(clusterFileRoots.id, id))
      .limit(1);
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, `Cluster file root ${id} not found`, 404);
    }
    return row;
  }
}

function contextOrgIds(ctx: ClusterFileRootAccessContext): string[] {
  return [
    ...new Set([...(ctx.orgIds ?? []), ctx.orgId].filter((orgId): orgId is string => !!orgId)),
  ];
}

function clusterFileRootCheck(
  rootId: string,
  permission: "view" | "use" | "manage",
  ctx: ClusterFileRootAccessContext,
  localAllowed: boolean,
) {
  const subjectId = ctx.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return {
    actorUserId: ctx.userId ?? null,
    actorEmail: ctx.email ?? null,
    resource: { type: "cluster_file_root", id: rootId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { localAllowed },
    localAllowed,
  };
}

function providerCheck(
  providerOrgId: string,
  ctx: ClusterFileRootAccessContext,
  localAllowed: boolean,
) {
  const subjectId = ctx.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return {
    actorUserId: ctx.userId ?? null,
    actorEmail: ctx.email ?? null,
    resource: { type: "provider", id: providerOrgId },
    permission: "manage",
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source: "cluster-file-root-create" },
    localAllowed,
  };
}

function clusterFileRootTuples(
  row: ClusterFileRootRow,
  operation: "create" | "delete",
): AuthzTuple[] {
  return [
    {
      ...clusterFileRootProviderTuple({ rootId: row.id, providerOrgId: row.providerOrgId }),
      operation,
    },
    { ...clusterFileRootPlatformTuple(row.id), operation },
    ...row.visibleOrgIds.map((orgId) => ({
      ...clusterFileRootVisibleOrgTuple({ rootId: row.id, orgId }),
      operation,
    })),
  ];
}
