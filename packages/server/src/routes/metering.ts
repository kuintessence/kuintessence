// `/api/metering/*` REST surface (PRD F23).
//
// Endpoints (mounted behind `protectedApi`):
//   - GET    /api/metering/query   — aggregate query (raw|hourly|daily|monthly)
//   - GET    /api/metering/export  — CSV / JSON export
//   - GET    /api/metering/webhook — list webhooks for the principal's org
//   - POST   /api/metering/webhook — create a webhook
//   - DELETE /api/metering/webhook/:id — delete a webhook
//
// All inputs are Zod-validated. Tenant scope is derived from the JWT
// principal via {@link tenantScopeFromPrincipal} and intersected with any
// `orgIds=` query-string filter via {@link narrowScope} — a principal can
// never widen their reach by asking.
//
// The route layer is intentionally agnostic of the storage backend for
// webhooks: it accepts a small {@link WebhookRepository} port so tests can
// drop an in-memory fake without spinning up Postgres.

import { meteringWebhook, type PgDb } from "@kuintessence/db";
import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AuthzCheck, AuthzService } from "../authz/service";
import {
  type BoundOrgMembership,
  type BoundPrincipal,
  hasAuditReadonlyCapability,
} from "../middleware/principal-binder";
import type { TokenPayload } from "../services/auth";
import {
  type Grouping,
  type MeteringService,
  narrowScope,
  type Period,
  QueryRequestSchema,
  type QueryResult,
  type TenantScope,
  tenantScopeFromPrincipal,
} from "../services/metering";
import { exportCsv } from "../services/metering-export";
import type { WebhookConfig } from "../services/metering-webhook";
import type { WorkflowNetDriveAttributionReader } from "../services/metering-workflow-attribution";
import { isPubliclyRoutableHttpUrl } from "../services/webhook-url-guard";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook repository port — small enough to keep local. The Drizzle adapter
// lives in this file; tests can substitute the in-memory fake.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookRecord {
  id: string;
  orgId: string;
  url: string;
  enabled: boolean;
  events: string[];
  failures: number;
  createdAt: Date;
}

export interface WebhookCreateInput {
  orgId: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
}

export interface WebhookRepository {
  listForOrg(orgId: string): Promise<WebhookRecord[]>;
  insert(input: WebhookCreateInput): Promise<WebhookRecord>;
  delete(id: string, orgId: string): Promise<boolean>;
  /**
   * All enabled webhooks across every org that subscribe to `event`.
   * Unlike {@link WebhookRecord} this returns the dispatcher's
   * {@link WebhookConfig} shape — the `secret` is needed to sign payloads.
   */
  listEnabledForEvent(event: string): Promise<WebhookConfig[]>;
  /**
   * Record a delivery outcome: on success stamp `lastSentAt` and reset the
   * failure counter; on failure increment it so the UI can disable a
   * flapping endpoint.
   */
  recordResult(id: string, ok: boolean): Promise<void>;
}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private readonly db: PgDb) {}

  async listForOrg(orgId: string): Promise<WebhookRecord[]> {
    const rows = await this.db
      .select()
      .from(meteringWebhook)
      .where(eq(meteringWebhook.orgId, orgId))
      .orderBy(desc(meteringWebhook.createdAt));
    return rows.map(rowToRecord);
  }

  async insert(input: WebhookCreateInput): Promise<WebhookRecord> {
    const [row] = await this.db
      .insert(meteringWebhook)
      .values({
        orgId: input.orgId,
        url: input.url,
        secret: input.secret,
        enabled: input.enabled,
        events: input.events,
      })
      .returning();
    if (!row) throw new Error("metering-webhook: insert returned no rows");
    return rowToRecord(row);
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const r = await this.db
      .delete(meteringWebhook)
      .where(and(eq(meteringWebhook.id, id), eq(meteringWebhook.orgId, orgId)))
      .returning({ id: meteringWebhook.id });
    return r.length > 0;
  }

  async listEnabledForEvent(event: string): Promise<WebhookConfig[]> {
    const rows = await this.db
      .select()
      .from(meteringWebhook)
      .where(
        and(eq(meteringWebhook.enabled, true), sql`${event} = ANY(${meteringWebhook.events})`),
      );
    return rows.map(rowToConfig);
  }

  async recordResult(id: string, ok: boolean): Promise<void> {
    if (ok) {
      await this.db
        .update(meteringWebhook)
        .set({ lastSentAt: new Date(), failures: 0 })
        .where(eq(meteringWebhook.id, id));
    } else {
      await this.db
        .update(meteringWebhook)
        .set({ failures: sql`${meteringWebhook.failures} + 1` })
        .where(eq(meteringWebhook.id, id));
    }
  }
}

interface InMemoryWebhookRow extends WebhookRecord {
  secret: string;
  lastSentAt: Date | null;
}

export class InMemoryWebhookRepository implements WebhookRepository {
  private rows: InMemoryWebhookRow[] = [];
  async listForOrg(orgId: string): Promise<WebhookRecord[]> {
    return this.rows.filter((r) => r.orgId === orgId).map(toRecord);
  }
  async insert(input: WebhookCreateInput): Promise<WebhookRecord> {
    const row: InMemoryWebhookRow = {
      id: crypto.randomUUID(),
      orgId: input.orgId,
      url: input.url,
      secret: input.secret,
      enabled: input.enabled,
      events: input.events,
      failures: 0,
      lastSentAt: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return toRecord(row);
  }
  async delete(id: string, orgId: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.id === id && r.orgId === orgId));
    return this.rows.length < before;
  }
  async listEnabledForEvent(event: string): Promise<WebhookConfig[]> {
    return this.rows
      .filter((r) => r.enabled && r.events.includes(event))
      .map((r) => ({
        id: r.id,
        orgId: r.orgId,
        url: r.url,
        secret: r.secret,
        enabled: r.enabled,
        events: r.events,
        failures: r.failures,
      }));
  }
  async recordResult(id: string, ok: boolean): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    if (ok) {
      row.lastSentAt = new Date();
      row.failures = 0;
    } else {
      row.failures += 1;
    }
  }
}

function toRecord(row: InMemoryWebhookRow): WebhookRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    enabled: row.enabled,
    events: row.events,
    failures: row.failures,
    createdAt: row.createdAt,
  };
}

function rowToRecord(row: typeof meteringWebhook.$inferSelect): WebhookRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    enabled: row.enabled,
    events: row.events,
    failures: row.failures,
    createdAt: row.createdAt,
  };
}

function rowToConfig(row: typeof meteringWebhook.$inferSelect): WebhookConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    url: row.url,
    secret: row.secret,
    enabled: row.enabled,
    events: row.events,
    failures: row.failures,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export interface MeteringRoutesDeps {
  service: MeteringService;
  webhookRepo: WebhookRepository;
  workflowAttribution?: WorkflowNetDriveAttributionReader;
  authz?: AuthzService;
}

const QueryStringSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  period: z.enum(["raw", "hourly", "daily", "monthly"]),
  grouping: z.enum(["user", "org", "cluster", "app"]),
  orgIds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ExportQuerySchema = QueryStringSchema.extend({
  format: z.enum(["csv", "json", "parquet"]).default("csv"),
});

const WorkflowRunIdSchema = z.string().uuid();

const WebhookCreateSchema = z
  .object({
    url: z.string().url(),
    secret: z.string().min(8),
    events: z.array(z.string().min(1)).min(1),
    enabled: z.boolean().default(true),
  })
  .refine((v) => isPubliclyRoutableHttpUrl(v.url), {
    message: "webhook url must be a publicly-routable http(s) endpoint",
    path: ["url"],
  });

interface PrincipalContext {
  sub: string;
  role: string;
  email: string | null;
  userId: string | null;
  orgId: string | null;
  orgIds: string[];
  memberships: BoundOrgMembership[];
  capabilities: string[];
}

type BoundMeteringPrincipal = PrincipalContext & { userId: string };

function principalFromContext(c: Context): BoundMeteringPrincipal {
  const user = c.get("user") as TokenPayload | undefined;
  if (!user) {
    throw new Error("metering: missing principal in request context");
  }
  const principal = c.get("principal" as never) as
    | Pick<
        BoundPrincipal,
        "capabilities" | "email" | "memberships" | "orgId" | "orgIds" | "role" | "userId"
      >
    | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const firstOrgId = principal.orgIds[0] ?? null;
  const orgId = principal.orgId ?? (principal.orgIds.length === 1 ? firstOrgId : null);
  return {
    sub: user.sub,
    role: principal?.role ?? "guest",
    email: principal?.email ?? null,
    userId: principal.userId,
    orgId,
    orgIds: principal?.orgIds ?? (orgId ? [orgId] : []),
    memberships: principal.memberships,
    capabilities: principal.capabilities,
  };
}

function localMeteringOrgAllowed(
  principal: PrincipalContext,
  permission: "view" | "manage",
): boolean {
  if (!principal.userId || !principal.orgId) {
    return false;
  }

  if (permission === "manage") {
    return (
      hasRole(principal.role as RoleName, "org_admin") ||
      principal.memberships.some(
        (membership) =>
          membership.orgId === principal.orgId &&
          (membership.role === "owner" || membership.role === "admin"),
      )
    );
  }

  return true;
}

function parseOrgIds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildMeteringRouter(deps: MeteringRoutesDeps) {
  const r = new Hono();

  r.use("*", async (c, next) => {
    const principal = principalFromContext(c);
    if (principal.role === "guest") {
      throw new AppError(ErrorCode.FORBIDDEN, "Metering access requires a user role", 403);
    }
    await next();
  });

  r.get("/metering/query", async (c) => {
    const principal = principalFromContext(c);
    const params = QueryStringSchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const orgIdList = parseOrgIds(params.orgIds);
    const baseScope = hasAuditReadonlyCapability(principal)
      ? ({ kind: "all" } as const)
      : tenantScopeFromPrincipal(principal, orgIdList);
    const effectiveScope = narrowScope(baseScope, orgIdList);
    const authorizedScope = await authorizeMeteringReadScope(
      deps.authz,
      principal,
      effectiveScope,
      orgIdList,
      "metering-query",
    );

    const queryReq = QueryRequestSchema.parse({
      from: new Date(params.from).toISOString(),
      to: new Date(params.to).toISOString(),
      period: params.period as Period,
      grouping: params.grouping as Grouping,
      ...(orgIdList ? { orgIds: orgIdList } : {}),
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    });

    const result = await deps.service.query(authorizedScope, queryReq);
    return c.json(result);
  });

  r.get("/metering/export", async (c) => {
    const principal = principalFromContext(c);
    const params = ExportQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const orgIdList = parseOrgIds(params.orgIds);
    const baseScope = hasAuditReadonlyCapability(principal)
      ? ({ kind: "all" } as const)
      : tenantScopeFromPrincipal(principal, orgIdList);
    const effectiveScope = narrowScope(baseScope, orgIdList);
    const authorizedScope = await authorizeMeteringReadScope(
      deps.authz,
      principal,
      effectiveScope,
      orgIdList,
      "metering-export",
    );

    const queryReq = QueryRequestSchema.parse({
      from: new Date(params.from).toISOString(),
      to: new Date(params.to).toISOString(),
      period: params.period as Period,
      grouping: params.grouping as Grouping,
      ...(orgIdList ? { orgIds: orgIdList } : {}),
      // Cap export rows at the ceiling. Real exports stream — TODO when
      // payloads grow past 1000 rows.
      limit: params.limit ?? 1000,
      offset: params.offset ?? 0,
    });

    if (params.format === "parquet") {
      const err = new AppError(
        ErrorCode.EXPORT_FORMAT_NOT_SUPPORTED,
        "Parquet export is not enabled",
        422,
        { reason: "EXPORT_FORMAT_NOT_SUPPORTED" },
      );
      return c.json(err.toJSON(), 422);
    }

    const result: QueryResult = await deps.service.query(authorizedScope, queryReq);
    if (params.format === "json") {
      return c.json({ rows: result.rows, total: result.total });
    }
    const csv = exportCsv(result);
    const fromDate = new Date(params.from).toISOString().slice(0, 10);
    const toDate = new Date(params.to).toISOString().slice(0, 10);
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="metering-${fromDate}_${toDate}.csv"`);
    return c.body(csv);
  });

  r.get("/metering/workflow-runs/:runId/netdrive-attribution", async (c) => {
    const principal = principalFromContext(c);
    const runId = WorkflowRunIdSchema.parse(c.req.param("runId"));
    const scope = hasAuditReadonlyCapability(principal)
      ? ({ kind: "all" } as const)
      : tenantScopeFromPrincipal(principal);
    const authorizedScope = await authorizeMeteringReadScope(
      deps.authz,
      principal,
      scope,
      undefined,
      "metering-workflow-netdrive-attribution",
    );
    const result = await deps.workflowAttribution?.getWorkflowNetDriveAttribution(
      runId,
      authorizedScope,
    );
    if (!result) {
      const err = new AppError(ErrorCode.NOT_FOUND, "Workflow run attribution not found", 404);
      return c.json(err.toJSON(), 404);
    }
    return c.json(result);
  });

  r.get("/metering/webhook", async (c) => {
    const principal = principalFromContext(c);
    if (!principal.orgId) {
      return c.json({ items: [] });
    }
    if (
      !(await authorizeMeteringOrg(
        deps.authz,
        principal,
        principal.orgId,
        "view",
        "metering-webhook-list",
        localMeteringOrgAllowed(principal, "view"),
      ))
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view metering webhooks", 403);
    }
    const items = await deps.webhookRepo.listForOrg(principal.orgId);
    return c.json({
      items: items.map((w) => ({
        id: w.id,
        orgId: w.orgId,
        url: w.url,
        enabled: w.enabled,
        events: w.events,
        failures: w.failures,
        createdAt: w.createdAt.toISOString(),
      })),
    });
  });

  r.post("/metering/webhook", async (c) => {
    const principal = principalFromContext(c);
    if (!principal.orgId) {
      if (principal.orgIds.length > 1) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Select an active organization before managing metering webhooks",
          409,
        );
      }
      return c.json(
        { error: { code: "NO_ORG_MEMBERSHIP", message: "principal has no orgId" } },
        403,
      );
    }
    if (
      !(await authorizeMeteringOrg(
        deps.authz,
        principal,
        principal.orgId,
        "manage",
        "metering-webhook-create",
        localMeteringOrgAllowed(principal, "manage"),
      ))
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to manage metering webhooks", 403);
    }
    const body = WebhookCreateSchema.parse(await c.req.json());
    const created = await deps.webhookRepo.insert({
      orgId: principal.orgId,
      url: body.url,
      secret: body.secret,
      events: body.events,
      enabled: body.enabled,
    });
    return c.json(
      {
        id: created.id,
        orgId: created.orgId,
        url: created.url,
        enabled: created.enabled,
        events: created.events,
        createdAt: created.createdAt.toISOString(),
      },
      201,
    );
  });

  r.delete("/metering/webhook/:id", async (c) => {
    const principal = principalFromContext(c);
    if (!principal.orgId) {
      if (principal.orgIds.length > 1) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Select an active organization before managing metering webhooks",
          409,
        );
      }
      return c.json(
        { error: { code: "NO_ORG_MEMBERSHIP", message: "principal has no orgId" } },
        403,
      );
    }
    if (
      !(await authorizeMeteringOrg(
        deps.authz,
        principal,
        principal.orgId,
        "manage",
        "metering-webhook-delete",
        localMeteringOrgAllowed(principal, "manage"),
      ))
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to manage metering webhooks", 403);
    }
    const id = c.req.param("id");
    const ok = await deps.webhookRepo.delete(id, principal.orgId);
    if (!ok) {
      return c.json({ error: { code: "NOT_FOUND", message: "webhook not found" } }, 404);
    }
    return c.json({ ok: true });
  });

  return r;
}

async function authorizeMeteringReadScope(
  authz: AuthzService | undefined,
  principal: PrincipalContext,
  localScope: TenantScope,
  requestedOrgIds: string[] | undefined,
  source: string,
): Promise<TenantScope> {
  const isAuditReader = hasAuditReadonlyCapability(principal);
  if (!authz || authz.mode === "off") return localScope;
  const subjectId = principal.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  if (authz.mode === "shadow") {
    if (isAuditReader) {
      await authz.shadowCheck({
        ...platformCheck({ ...principal, userId: subjectId }, "metering_read", source, true),
        localAllowed: true,
      });
    } else {
      await shadowMeteringReadScope(authz, principal, localScope, source);
    }
    return localScope;
  }

  const boundPrincipal: BoundMeteringPrincipal = { ...principal, userId: subjectId };
  if (isAuditReader) {
    await authz.requirePermission(
      platformCheck(boundPrincipal, "metering_read", source, true),
      false,
    );
    return requestedOrgIds && requestedOrgIds.length > 0 && !requestedOrgIds.includes("*")
      ? { kind: "orgs", orgIds: requestedOrgIds }
      : { kind: "all" };
  }
  const requestedAll =
    !requestedOrgIds || requestedOrgIds.length === 0 || requestedOrgIds.includes("*");
  if (await checkPlatformView(authz, boundPrincipal, source)) {
    return requestedAll ? { kind: "all" } : { kind: "orgs", orgIds: requestedOrgIds };
  }

  const visibleOrgIds = await authz.lookupResources({
    resourceType: "organization",
    permission: "view",
    subject: { type: "user", id: subjectId },
  });
  const narrowed = requestedOrgIds?.includes("*")
    ? visibleOrgIds
    : requestedOrgIds && requestedOrgIds.length > 0
      ? requestedOrgIds.filter((orgId) => visibleOrgIds.includes(orgId))
      : visibleOrgIds;
  return { kind: "orgs", orgIds: narrowed };
}

async function shadowMeteringReadScope(
  authz: AuthzService,
  principal: PrincipalContext,
  localScope: TenantScope,
  source: string,
): Promise<void> {
  if (!principal.userId) return;
  const boundPrincipal: BoundMeteringPrincipal = { ...principal, userId: principal.userId };
  if (localScope.kind === "all") {
    await authz.shadowCheck({
      ...platformCheck(boundPrincipal, "view", source, true),
      localAllowed: true,
    });
    return;
  }
  await Promise.all(
    localScope.orgIds.map((orgId) =>
      authz.shadowCheck({
        ...organizationCheck(boundPrincipal, orgId, "view", source, true),
        localAllowed: true,
      }),
    ),
  );
}

async function checkPlatformView(
  authz: AuthzService,
  principal: BoundMeteringPrincipal,
  source: string,
): Promise<boolean> {
  try {
    await authz.requirePermission(
      platformCheck(principal, "view", source, hasRole(principal.role as RoleName, "operator")),
      hasRole(principal.role as RoleName, "platform_admin"),
    );
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

async function authorizeMeteringOrg(
  authz: AuthzService | undefined,
  principal: PrincipalContext,
  orgId: string,
  permission: "view" | "manage",
  source: string,
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  if (!principal.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const boundPrincipal: BoundMeteringPrincipal = { ...principal, userId: principal.userId };
  const check = organizationCheck(boundPrincipal, orgId, permission, source, localAllowed);
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, hasRole(principal.role as RoleName, "platform_admin"));
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

function platformCheck(
  principal: BoundMeteringPrincipal,
  permission: "view" | "metering_read",
  source: string,
  localAllowed: boolean,
): AuthzCheck & { localAllowed: boolean } {
  return {
    actorUserId: principal.userId,
    actorEmail: principal.email,
    resource: { type: "platform", id: "root" },
    permission,
    subject: { type: "user", id: principal.userId },
    context: { localAllowed, source },
    localAllowed,
  };
}

function organizationCheck(
  principal: BoundMeteringPrincipal,
  orgId: string,
  permission: "view" | "manage",
  source: string,
  localAllowed: boolean,
): AuthzCheck & { localAllowed: boolean } {
  return {
    actorUserId: principal.userId,
    actorEmail: principal.email,
    resource: { type: "organization", id: orgId },
    permission,
    subject: { type: "user", id: principal.userId },
    context: { localAllowed, source },
    localAllowed,
  };
}
