import {
  accountAssignmentDelegations,
  agents,
  clusterExecutionAccounts,
  type PgDb,
  userClusterAccountMappings,
} from "@kuintessence/db";
import { AppError, ErrorCode, hasRole, type RoleName } from "@kuintessence/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { writeAudit } from "../services/audit-log-writer";

const UnixAccountSchema = z.strictObject({
  providerOrgId: z.string().uuid(),
  agentId: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  backendType: z.literal("unix"),
  username: z.string().min(1).max(255),
  uid: z.number().int().min(1),
  gid: z.number().int().min(1),
  schedulerAccount: z.string().min(1).max(255).optional(),
  allowedQueues: z.array(z.string().min(1).max(255)).default([]),
  sharedService: z.boolean().default(false),
});

const KubernetesAccountSchema = z.strictObject({
  providerOrgId: z.string().uuid(),
  agentId: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  backendType: z.literal("kubernetes"),
  namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  serviceAccount: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  quotaPolicy: z.record(z.string(), z.string()).default({}),
  sharedService: z.boolean().default(false),
});

const AccountBodySchema = z.discriminatedUnion("backendType", [
  UnixAccountSchema,
  KubernetesAccountSchema,
]);
const MappingRequestSchema = z.strictObject({ accountId: z.string().uuid() });
const MappingDecisionSchema = z.strictObject({
  status: z.enum(["approved", "rejected", "revoked"]),
  expiresAt: z.coerce.date().optional(),
});
const DelegationSchema = z.strictObject({ delegated: z.boolean() });
const AllowedQueuesBodySchema = z.strictObject({
  allowedQueues: z
    .array(z.string().min(1).max(255))
    .refine((queues) => new Set(queues).size === queues.length, "Queue names must be unique"),
});

type CanonicalPrincipal = BoundPrincipal & { userId: string };

function principal(c: Context): CanonicalPrincipal {
  const value = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!value?.userId) throw new AppError(ErrorCode.FORBIDDEN, "Bound principal required", 403);
  return value as CanonicalPrincipal;
}

function isPlatform(value: BoundPrincipal): boolean {
  return hasRole(value.role as RoleName, "platform_admin");
}

function isProviderAdmin(value: BoundPrincipal, providerOrgId: string): boolean {
  return value.orgIds.includes(providerOrgId) && hasRole(value.role as RoleName, "org_admin");
}

async function platformDelegated(db: PgDb, providerOrgId: string): Promise<boolean> {
  const [row] = await db
    .select({ delegated: accountAssignmentDelegations.delegated })
    .from(accountAssignmentDelegations)
    .where(eq(accountAssignmentDelegations.providerOrgId, providerOrgId))
    .limit(1);
  return row?.delegated ?? false;
}

async function assertAccountManager(
  db: PgDb,
  value: BoundPrincipal,
  providerOrgId: string,
): Promise<void> {
  if (isProviderAdmin(value, providerOrgId)) return;
  if (isPlatform(value) && (await platformDelegated(db, providerOrgId))) return;
  throw new AppError(ErrorCode.FORBIDDEN, "Execution account management denied", 403);
}

async function loadAccount(db: PgDb, accountId: string) {
  const [account] = await db
    .select()
    .from(clusterExecutionAccounts)
    .where(eq(clusterExecutionAccounts.id, accountId))
    .limit(1);
  if (!account) throw new AppError(ErrorCode.NOT_FOUND, "Execution account not found", 404);
  return account;
}

export interface SandboxAccountRoutesDeps {
  db: PgDb;
}

export function createSandboxAccountRoutes({ db }: SandboxAccountRoutesDeps): Hono {
  const r = new Hono();

  r.get("/sandbox/account-mappings", async (c) => {
    const value = principal(c);
    const requestedUserId = c.req.query("userId");
    const userId = requestedUserId && isPlatform(value) ? requestedUserId : value.userId;
    const rows = await db
      .select({ mapping: userClusterAccountMappings, account: clusterExecutionAccounts })
      .from(userClusterAccountMappings)
      .innerJoin(
        clusterExecutionAccounts,
        eq(userClusterAccountMappings.accountId, clusterExecutionAccounts.id),
      )
      .where(eq(userClusterAccountMappings.userId, userId));
    return c.json({ success: true, data: rows });
  });

  r.get("/sandbox/account-candidates", async (c) => {
    principal(c);
    const rows = await db
      .select({
        id: clusterExecutionAccounts.id,
        providerOrgId: clusterExecutionAccounts.providerOrgId,
        agentId: clusterExecutionAccounts.agentId,
        displayName: clusterExecutionAccounts.displayName,
        backendType: clusterExecutionAccounts.backendType,
        schedulerType: agents.schedulerType,
        siteName: agents.siteName,
      })
      .from(clusterExecutionAccounts)
      .innerJoin(agents, eq(clusterExecutionAccounts.agentId, agents.agentId))
      .where(
        and(
          eq(clusterExecutionAccounts.enabled, true),
          eq(clusterExecutionAccounts.sharedService, false),
        ),
      );
    return c.json({ success: true, data: rows });
  });

  r.post("/sandbox/account-mappings", async (c) => {
    const value = principal(c);
    const body = MappingRequestSchema.parse(await c.req.json());
    const account = await loadAccount(db, body.accountId);
    if (!account.enabled || account.sharedService) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Only enabled personal execution accounts can be requested",
        400,
      );
    }
    const [mapping] = await db
      .insert(userClusterAccountMappings)
      .values({ userId: value.userId, accountId: account.id, status: "pending" })
      .onConflictDoUpdate({
        target: [userClusterAccountMappings.userId, userClusterAccountMappings.accountId],
        set: {
          status: "pending",
          requestedAt: sql`now()`,
          reviewedAt: null,
          reviewedBy: null,
          expiresAt: null,
          revokedAt: null,
          isDefault: false,
        },
      })
      .returning();
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.account-mapping.request",
      target: mapping?.id ?? body.accountId,
    });
    return c.json({ success: true, data: mapping }, 201);
  });

  r.put("/sandbox/account-mappings/:id/default", async (c) => {
    const value = principal(c);
    const mappingId = z.string().uuid().parse(c.req.param("id"));
    const [mapping] = await db
      .select()
      .from(userClusterAccountMappings)
      .where(
        and(
          eq(userClusterAccountMappings.id, mappingId),
          eq(userClusterAccountMappings.userId, value.userId),
          eq(userClusterAccountMappings.status, "approved"),
        ),
      )
      .limit(1);
    if (!mapping || mapping.revokedAt || (mapping.expiresAt && mapping.expiresAt <= new Date())) {
      throw new AppError(ErrorCode.NOT_FOUND, "Approved account mapping not found", 404);
    }
    await db.transaction(async (tx) => {
      await tx
        .update(userClusterAccountMappings)
        .set({ isDefault: false })
        .where(eq(userClusterAccountMappings.userId, value.userId));
      await tx
        .update(userClusterAccountMappings)
        .set({ isDefault: true })
        .where(eq(userClusterAccountMappings.id, mapping.id));
    });
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.account-mapping.default",
      target: mapping.id,
    });
    return c.json({ success: true, data: { id: mapping.id, isDefault: true } });
  });

  r.get("/sandbox/accounts", async (c) => {
    const value = principal(c);
    const providerOrgId = c.req.query("providerOrgId");
    const providerIds = isPlatform(value) ? (providerOrgId ? [providerOrgId] : []) : value.orgIds;
    if (!isPlatform(value) && !hasRole(value.role as RoleName, "org_admin")) {
      throw new AppError(ErrorCode.FORBIDDEN, "Provider admin required", 403);
    }
    const rows =
      providerIds.length > 0
        ? await db
            .select()
            .from(clusterExecutionAccounts)
            .where(inArray(clusterExecutionAccounts.providerOrgId, providerIds))
        : await db.select().from(clusterExecutionAccounts);
    return c.json({ success: true, data: rows });
  });

  r.post("/sandbox/accounts", async (c) => {
    const value = principal(c);
    const body = AccountBodySchema.parse(await c.req.json());
    await assertAccountManager(db, value, body.providerOrgId);
    const [agent] = await db
      .select({ providerOrgId: agents.providerOrgId, schedulerType: agents.schedulerType })
      .from(agents)
      .where(eq(agents.agentId, body.agentId))
      .limit(1);
    if (!agent || agent.providerOrgId !== body.providerOrgId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Agent does not belong to provider", 400);
    }
    if ((agent.schedulerType === "kubernetes") !== (body.backendType === "kubernetes")) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Execution account backend does not match scheduler",
        400,
      );
    }
    const [created] = await db
      .insert(clusterExecutionAccounts)
      .values(
        body.backendType === "unix"
          ? {
              ...body,
              schedulerAccount: body.schedulerAccount ?? null,
              createdBy: value.userId,
            }
          : { ...body, createdBy: value.userId },
      )
      .returning();
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.execution-account.create",
      target: created?.id ?? body.agentId,
    });
    return c.json({ success: true, data: created }, 201);
  });

  r.patch("/sandbox/accounts/:id/allowed-queues", async (c) => {
    const value = principal(c);
    const accountId = z.string().uuid().parse(c.req.param("id"));
    const body = AllowedQueuesBodySchema.parse(await c.req.json());
    const account = await loadAccount(db, accountId);
    await assertAccountManager(db, value, account.providerOrgId);
    const [updated] = await db
      .update(clusterExecutionAccounts)
      .set({ allowedQueues: body.allowedQueues, updatedAt: sql`now()` })
      .where(eq(clusterExecutionAccounts.id, account.id))
      .returning();
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, "Execution account not found", 404);
    }
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.execution-account.allowed-queues.update",
      target: account.id,
      diff: {
        before: { allowedQueues: account.allowedQueues },
        after: { allowedQueues: updated.allowedQueues },
      },
    });
    return c.json({ success: true, data: updated });
  });

  r.get("/sandbox/account-mapping-review-queue", async (c) => {
    const value = principal(c);
    if (!isPlatform(value) && !hasRole(value.role as RoleName, "org_admin")) {
      throw new AppError(ErrorCode.FORBIDDEN, "Account mapping review denied", 403);
    }
    const base = db
      .select({ mapping: userClusterAccountMappings, account: clusterExecutionAccounts })
      .from(userClusterAccountMappings)
      .innerJoin(
        clusterExecutionAccounts,
        eq(userClusterAccountMappings.accountId, clusterExecutionAccounts.id),
      );
    const rows = isPlatform(value)
      ? await base.where(eq(userClusterAccountMappings.status, "pending"))
      : value.orgIds.length > 0
        ? await base.where(
            and(
              eq(userClusterAccountMappings.status, "pending"),
              inArray(clusterExecutionAccounts.providerOrgId, value.orgIds),
            ),
          )
        : [];
    return c.json({ success: true, data: rows });
  });

  r.patch("/sandbox/account-mappings/:id", async (c) => {
    const value = principal(c);
    const mappingId = z.string().uuid().parse(c.req.param("id"));
    const body = MappingDecisionSchema.parse(await c.req.json());
    const [row] = await db
      .select({ mapping: userClusterAccountMappings, account: clusterExecutionAccounts })
      .from(userClusterAccountMappings)
      .innerJoin(
        clusterExecutionAccounts,
        eq(userClusterAccountMappings.accountId, clusterExecutionAccounts.id),
      )
      .where(eq(userClusterAccountMappings.id, mappingId))
      .limit(1);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Account mapping not found", 404);
    await assertAccountManager(db, value, row.account.providerOrgId);
    const revoked = body.status === "revoked";
    const [updated] = await db
      .update(userClusterAccountMappings)
      .set({
        status: body.status,
        reviewedAt: new Date(),
        reviewedBy: value.userId,
        expiresAt: body.status === "approved" ? (body.expiresAt ?? null) : null,
        revokedAt: revoked ? new Date() : null,
        isDefault: body.status === "approved" ? row.mapping.isDefault : false,
      })
      .where(eq(userClusterAccountMappings.id, mappingId))
      .returning();
    await writeAudit(db, {
      actor: value.userId,
      action: `sandbox.account-mapping.${body.status}`,
      target: mappingId,
      diff: { after: { status: body.status, expiresAt: body.expiresAt?.toISOString() } },
    });
    return c.json({ success: true, data: updated });
  });

  r.put("/sandbox/account-delegations/:providerOrgId", async (c) => {
    const value = principal(c);
    const providerOrgId = z.string().uuid().parse(c.req.param("providerOrgId"));
    if (!isProviderAdmin(value, providerOrgId)) {
      throw new AppError(ErrorCode.FORBIDDEN, "Provider admin required", 403);
    }
    const body = DelegationSchema.parse(await c.req.json());
    const [updated] = await db
      .insert(accountAssignmentDelegations)
      .values({ providerOrgId, delegated: body.delegated, updatedBy: value.userId })
      .onConflictDoUpdate({
        target: accountAssignmentDelegations.providerOrgId,
        set: { delegated: body.delegated, updatedBy: value.userId, updatedAt: sql`now()` },
      })
      .returning();
    await writeAudit(db, {
      actor: value.userId,
      action: "sandbox.account-delegation.update",
      target: providerOrgId,
      diff: { after: { delegated: body.delegated } },
    });
    return c.json({ success: true, data: updated });
  });

  return r;
}
