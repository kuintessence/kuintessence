import { agents, type PgDb, sandboxPolicyOverlays } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  hasRole,
  type RoleName,
  SandboxPolicyOverlaySchema,
} from "@kuintessence/shared";
import { and, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { writeAudit } from "../services/audit-log-writer";
import type { SandboxPolicyService } from "../services/sandbox-policy";

const PolicyWriteSchema = z.strictObject({
  providerOrgId: z.string().uuid().optional(),
  clusterId: z.string().min(1).max(255).optional(),
  agentId: z.string().min(1).max(255).optional(),
  policy: SandboxPolicyOverlaySchema,
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

function assertProviderAdmin(value: BoundPrincipal, providerOrgId: string): void {
  if (!value.orgIds.includes(providerOrgId) || !hasRole(value.role as RoleName, "org_admin")) {
    throw new AppError(ErrorCode.FORBIDDEN, "Provider policy management denied", 403);
  }
}

export function createSandboxPolicyRoutes(input: {
  db: PgDb;
  service: SandboxPolicyService;
}): Hono {
  const r = new Hono();

  r.get("/sandbox/policies", async (c) => {
    const value = principal(c);
    if (!isPlatform(value) && !hasRole(value.role as RoleName, "org_admin")) {
      throw new AppError(ErrorCode.FORBIDDEN, "Sandbox policy access denied", 403);
    }
    const rows = isPlatform(value)
      ? await input.db.select().from(sandboxPolicyOverlays)
      : value.orgIds.length > 0
        ? await input.db
            .select()
            .from(sandboxPolicyOverlays)
            .where(inArray(sandboxPolicyOverlays.providerOrgId, value.orgIds))
        : [];
    return c.json({ success: true, data: rows });
  });

  r.get("/sandbox/policies/effective/:agentId", async (c) => {
    const value = principal(c);
    const agentId = c.req.param("agentId");
    const [agent] = await input.db
      .select({ providerOrgId: agents.providerOrgId, clusterId: agents.clusterId })
      .from(agents)
      .where(eq(agents.agentId, agentId))
      .limit(1);
    if (!agent) throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    if (!isPlatform(value)) {
      if (!agent.providerOrgId) {
        throw new AppError(ErrorCode.FORBIDDEN, "Unowned Agent policy is platform-only", 403);
      }
      assertProviderAdmin(value, agent.providerOrgId);
    }
    const effective = await input.service.effectiveFor({
      providerOrgId: agent.providerOrgId,
      clusterId: agent.clusterId,
      agentId,
    });
    return c.json({ success: true, data: effective });
  });

  r.put("/sandbox/policies/:scope", async (c) => {
    const value = principal(c);
    const scope = z.enum(["platform", "provider", "cluster", "agent"]).parse(c.req.param("scope"));
    const body = PolicyWriteSchema.parse(await c.req.json());
    if (scope === "platform") {
      if (!isPlatform(value)) {
        throw new AppError(ErrorCode.FORBIDDEN, "Platform admin required", 403);
      }
      if (body.providerOrgId || body.clusterId || body.agentId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Platform policy cannot target a CP", 400);
      }
    } else {
      if (!body.providerOrgId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "providerOrgId is required", 400);
      }
      assertProviderAdmin(value, body.providerOrgId);
      if (scope === "provider" && (body.clusterId || body.agentId)) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Provider policy target is too specific",
          400,
        );
      }
      if (scope === "cluster" && (!body.clusterId || body.agentId)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "clusterId is required", 400);
      }
      if (scope === "agent" && !body.agentId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId is required", 400);
      }
      if (scope === "agent") {
        const [agent] = await input.db
          .select({ providerOrgId: agents.providerOrgId })
          .from(agents)
          .where(eq(agents.agentId, body.agentId as string))
          .limit(1);
        if (!agent || agent.providerOrgId !== body.providerOrgId) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Agent does not belong to provider", 400);
        }
      }
      if (scope === "cluster") {
        const [clusterAgent] = await input.db
          .select({ agentId: agents.agentId })
          .from(agents)
          .where(
            and(
              eq(agents.clusterId, body.clusterId as string),
              eq(agents.providerOrgId, body.providerOrgId),
            ),
          )
          .limit(1);
        if (!clusterAgent) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Cluster does not belong to provider",
            400,
          );
        }
      }
    }
    const updated = await input.service.upsert({
      scope,
      ...(body.providerOrgId ? { providerOrgId: body.providerOrgId } : {}),
      ...(body.clusterId ? { clusterId: body.clusterId } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      policy: body.policy,
      updatedBy: value.userId,
    });
    await writeAudit(input.db, {
      actor: value.userId,
      action: `sandbox.policy.${scope}.update`,
      target: updated?.id ?? scope,
      diff: { after: body },
    });
    return c.json({ success: true, data: updated });
  });

  return r;
}
