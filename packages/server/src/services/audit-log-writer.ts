// Migration 0013 — audit-log write helper.
//
// `audit_log.org_id` was added so `AuditServicePort.search` can scope by
// `inArray(audit_log.org_id, orgIds)` directly. There is no central audit
// writer in the Server today — every route that mutates state inserts its own
// row. Rather than refactor all of them through one service, this helper
// encapsulates the (small) common shape each insert needs and resolves the
// actor's org by email or by user id.
//
// `actor` semantics in the audit_log table is "string identifier the
// caller chose to record" — historically email for OIDC routes and user.sub
// (UUID) for software-policy routes. We accept either form: if the value
// parses as a UUID we look up by id; otherwise we look up by email. A
// failed lookup falls back to NULL — the writer never fails the request
// over an audit metadata miss.

import { auditLog, type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { asc, eq } from "drizzle-orm";

const logger = createLogger("audit-log-writer");

/**
 * Insert one audit-log row, resolving the actor's org-id at write time.
 *
 * Encapsulates the common `{ actor, orgId: resolveActorOrgId(actor), action,
 * target, diff }` shape repeated across mutating routes. `actor` is recorded
 * verbatim (email or user-id) and is the same value used for the org lookup —
 * callers whose audit `actor` differs from the org-lookup key must not use
 * this helper. The insert is a plain `await`; it can throw and is caught by
 * the caller's route error handling, preserving today's semantics.
 */
export async function writeAudit(
  db: PgDb,
  entry: {
    actor: string;
    action: string;
    target: string;
    diff?: { before?: unknown; after?: unknown } | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    orgId: await resolveActorOrgId(db, entry.actor),
    action: entry.action,
    target: entry.target,
    diff: entry.diff,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an audit-row `actor` string to the acting user's primary membership org.
 * Returns null on miss / lookup failure / null org membership.
 */
export async function resolveActorOrgId(db: PgDb, actor: string): Promise<string | null> {
  if (!actor) return null;
  try {
    const isUuid = UUID_RE.test(actor);
    const [row] = isUuid
      ? await db
          .select({ orgId: userOrgMemberships.orgId })
          .from(userOrgMemberships)
          .where(eq(userOrgMemberships.userId, actor))
          .orderBy(asc(userOrgMemberships.createdAt))
          .limit(1)
      : await db
          .select({ orgId: userOrgMemberships.orgId })
          .from(userOrgMemberships)
          .innerJoin(users, eq(userOrgMemberships.userId, users.id))
          .where(eq(users.email, actor))
          .orderBy(asc(userOrgMemberships.createdAt))
          .limit(1);
    return row?.orgId ?? null;
  } catch (err) {
    logger.warn({ actor, err }, "resolveActorOrgId lookup failed; storing NULL");
    return null;
  }
}

/**
 * Resolve an `actor` (UUID or email) to the canonical `users.id` UUID.
 * Callers that need a column-typed UUID (e.g. netdrive_files.owner_id FK)
 * must use this instead of passing `user.sub` straight through.
 */
export async function resolveActorUserId(db: PgDb, actor: string): Promise<string | null> {
  if (!actor) return null;
  if (UUID_RE.test(actor)) return actor;
  try {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, actor))
      .limit(1);
    return row?.id ?? null;
  } catch (err) {
    logger.warn({ actor, err }, "resolveActorUserId lookup failed");
    return null;
  }
}
