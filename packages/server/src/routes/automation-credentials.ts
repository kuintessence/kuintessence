import {
  auditLog,
  authzOutbox,
  automationCredentials,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, desc, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  AutomationScopeSchema,
  hashAutomationToken,
  newAutomationToken,
} from "../auth/automation-credentials";
import { organizationMembershipTuple, platformMemberTuple } from "../authz/projection";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { parseUuidParam } from "../middleware/uuid-param";

const CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    orgId: z.string().uuid(),
    scopes: z
      .array(AutomationScopeSchema)
      .min(1)
      .max(8)
      .transform((scopes) => [...new Set(scopes)]),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(90 * 86400),
    rotateFrom: z.string().uuid().optional(),
  })
  .strict();

const { secretHash: _secretHash, ...publicColumns } = getTableColumns(automationCredentials);

export function createAutomationCredentialRoutes(db: PgDb) {
  const r = new Hono();
  async function administrator(c: Context): Promise<string> {
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (c.get("automation") || !principal?.userId)
      throw new AppError(ErrorCode.FORBIDDEN, "Platform administrator required", 403);
    const [actor] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, principal.userId),
          inArray(users.role, ["platform_admin", "super_admin"]),
          eq(users.suspended, false),
          eq(users.serviceAccount, false),
        ),
      )
      .limit(1);
    if (!actor) throw new AppError(ErrorCode.FORBIDDEN, "Platform administrator required", 403);
    return actor.id;
  }

  r.post("/automation/credentials", async (c) => {
    const actor = await administrator(c);
    const input = CreateSchema.parse(await c.req.json());
    const id = crypto.randomUUID();
    const token = newAutomationToken(id);
    const credential = await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: orgs.id })
        .from(orgs)
        .where(eq(orgs.id, input.orgId))
        .limit(1);
      if (!org) throw new AppError(ErrorCode.NOT_FOUND, "Organization not found", 404);
      let userId: string;
      if (input.rotateFrom) {
        const [previous] = await tx
          .select({ userId: automationCredentials.userId })
          .from(automationCredentials)
          .innerJoin(users, eq(users.id, automationCredentials.userId))
          .innerJoin(
            userOrgMemberships,
            and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, input.orgId)),
          )
          .where(
            and(
              eq(automationCredentials.id, input.rotateFrom),
              eq(automationCredentials.orgId, input.orgId),
              eq(users.suspended, false),
              eq(users.serviceAccount, true),
              eq(users.role, "user"),
              eq(userOrgMemberships.role, "member"),
            ),
          )
          .limit(1);
        if (!previous)
          throw new AppError(
            ErrorCode.NOT_FOUND,
            "Automation identity not available in this organization",
            404,
          );
        userId = previous.userId;
      } else {
        userId = crypto.randomUUID();
        await tx.insert(users).values({
          id: userId,
          email: `${userId}@automation.invalid`,
          displayName: input.name,
          role: "user",
          orgId: input.orgId,
          serviceAccount: true,
        });
        await tx.insert(userOrgMemberships).values({ userId, orgId: input.orgId, role: "member" });
        const tuples = [
          platformMemberTuple(userId),
          organizationMembershipTuple({ userId, orgId: input.orgId, role: "member" }),
        ];
        await tx.insert(authzOutbox).values(
          tuples.map((tuple) => ({
            operation: tuple.operation,
            resourceType: tuple.resource.type,
            resourceId: tuple.resource.id,
            relation: tuple.relation,
            subjectType: tuple.subject.type,
            subjectId: tuple.subject.id,
          })),
        );
      }
      const [created] = await tx
        .insert(automationCredentials)
        .values({
          id,
          userId,
          orgId: input.orgId,
          createdBy: actor,
          name: input.name,
          secretHash: hashAutomationToken(token),
          scopes: input.scopes,
          expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
        })
        .returning(publicColumns);
      await tx.insert(auditLog).values({
        actor,
        orgId: input.orgId,
        action: "automation.credential.create",
        target: `automation_credential:${id}`,
        diff: {
          after: {
            userId,
            scopes: input.scopes,
            rotateFrom: input.rotateFrom ?? null,
            expiresAt: created?.expiresAt,
          },
        },
      });
      return created;
    });
    c.header("Cache-Control", "no-store");
    return c.json({ credential, token }, 201);
  });

  r.get("/automation/credentials", async (c) => {
    await administrator(c);
    const orgId = parseUuidParam(c.req.query("orgId") ?? "", "organization id");
    const credentials = await db
      .select(publicColumns)
      .from(automationCredentials)
      .where(eq(automationCredentials.orgId, orgId))
      .orderBy(desc(automationCredentials.createdAt))
      .limit(100);
    c.header("Cache-Control", "no-store");
    return c.json({ credentials });
  });

  r.post("/automation/credentials/:id/revoke", async (c) => {
    const actor = await administrator(c);
    const id = parseUuidParam(c.req.param("id"), "credential id");
    await db.transaction(async (tx) => {
      const [credential] = await tx
        .update(automationCredentials)
        .set({ revokedAt: new Date() })
        .where(and(eq(automationCredentials.id, id), isNull(automationCredentials.revokedAt)))
        .returning(publicColumns);
      if (credential)
        await tx.insert(auditLog).values({
          actor,
          orgId: credential.orgId,
          action: "automation.credential.revoke",
          target: `automation_credential:${id}`,
        });
    });
    return c.json({ revoked: true });
  });
  return r;
}
