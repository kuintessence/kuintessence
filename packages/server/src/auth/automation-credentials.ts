import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { automationCredentials, type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";

export const AutomationScopeSchema = z.enum([
  "agents:read",
  "software:read",
  "queues:read",
  "workflows:submit",
  "workflows:read",
  "workflows:cancel",
  "jobs:read",
  "files:read",
]);
export type AutomationScope = z.infer<typeof AutomationScopeSchema>;
export interface AutomationIdentity {
  id: string;
  userId: string;
  orgId: string;
  email: string;
  scopes: AutomationScope[];
}

declare module "hono" {
  interface ContextVariableMap {
    automation: AutomationIdentity | undefined;
  }
}

export function hashAutomationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newAutomationToken(id: string): string {
  return `kqac_${id}.${randomBytes(32).toString("base64url")}`;
}

export async function authenticateAutomationToken(
  db: PgDb,
  token: string,
): Promise<AutomationIdentity | null> {
  const match = /^kqac_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !z.string().uuid().safeParse(match[1]).success) return null;
  const now = new Date();
  const [row] = await db
    .select({ credential: automationCredentials, email: users.email })
    .from(automationCredentials)
    .innerJoin(users, eq(users.id, automationCredentials.userId))
    .innerJoin(
      userOrgMemberships,
      and(
        eq(userOrgMemberships.userId, users.id),
        eq(userOrgMemberships.orgId, automationCredentials.orgId),
      ),
    )
    .where(
      and(
        eq(automationCredentials.id, match[1] as string),
        isNull(automationCredentials.revokedAt),
        gt(automationCredentials.expiresAt, now),
        eq(users.suspended, false),
        eq(users.serviceAccount, true),
        eq(users.role, "user"),
        eq(userOrgMemberships.role, "member"),
      ),
    )
    .limit(1);
  if (
    !row ||
    !/^[a-f0-9]{64}$/.test(row.credential.secretHash) ||
    !timingSafeEqual(
      Buffer.from(row.credential.secretHash, "hex"),
      Buffer.from(hashAutomationToken(token), "hex"),
    )
  )
    return null;
  const scopes = z.array(AutomationScopeSchema).min(1).safeParse(row.credential.scopes);
  if (!scopes.success) return null;
  const [active] = await db
    .update(automationCredentials)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(automationCredentials.id, row.credential.id),
        isNull(automationCredentials.revokedAt),
        gt(automationCredentials.expiresAt, now),
      ),
    )
    .returning({ id: automationCredentials.id });
  return active
    ? {
        id: active.id,
        userId: row.credential.userId,
        orgId: row.credential.orgId,
        email: row.email,
        scopes: scopes.data,
      }
    : null;
}
