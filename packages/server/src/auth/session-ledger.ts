import { createHash } from "node:crypto";
import { authSessions, type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

export type SessionRotationResult =
  | { status: "rotated"; expiresAt: Date }
  | { status: "invalid" | "revoked" | "expired" | "replayed" };

export interface CreateBrowserSessionInput {
  sessionId: string;
  familyId: string;
  userId: string;
  refreshTokenId: string;
  expiresAt: Date;
}

export interface RotateBrowserSessionInput {
  sessionId: string;
  userId: string;
  currentRefreshTokenId: string;
  nextRefreshTokenId: string;
}

export async function activateCliSession(
  db: PgDb,
  input: {
    sessionId: string;
    userId: string;
    currentRefreshTokenId: string;
    consumedRefreshTokenId: string;
    expiresAt: Date;
  },
): Promise<boolean> {
  const now = new Date();
  const [activated] = await db
    .update(authSessions)
    .set({
      currentRefreshJtiHash: hashRefreshTokenId(input.consumedRefreshTokenId),
      expiresAt: input.expiresAt,
      lastUsedAt: now,
      rotatedAt: now,
    })
    .where(
      and(
        eq(authSessions.id, input.sessionId),
        eq(authSessions.userId, input.userId),
        eq(authSessions.currentRefreshJtiHash, hashRefreshTokenId(input.currentRefreshTokenId)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    )
    .returning({ id: authSessions.id });
  return Boolean(activated);
}

export function hashRefreshTokenId(refreshTokenId: string): string {
  return createHash("sha256").update(refreshTokenId).digest("hex");
}

export async function createBrowserSession(
  db: PgDb,
  input: CreateBrowserSessionInput,
): Promise<void> {
  const [user] = await db
    .select({ defaultOrgId: users.orgId })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const [defaultMembership] = user?.defaultOrgId
    ? await db
        .select({ orgId: userOrgMemberships.orgId })
        .from(userOrgMemberships)
        .where(
          and(
            eq(userOrgMemberships.userId, input.userId),
            eq(userOrgMemberships.orgId, user.defaultOrgId),
          ),
        )
        .limit(1)
    : [];
  await db.insert(authSessions).values({
    id: input.sessionId,
    familyId: input.familyId,
    userId: sql`${input.userId}::uuid`,
    activeOrgId: defaultMembership?.orgId ?? null,
    currentRefreshJtiHash: hashRefreshTokenId(input.refreshTokenId),
    expiresAt: input.expiresAt,
  });
}

/**
 * Refresh tokens are strictly single-use. The first request atomically moves
 * the current JTI; any later valid use of the replaced JTI revokes its family.
 * The web client coalesces refresh requests, so concurrent browser refreshes
 * never rely on a permissive replay window.
 */
export async function rotateBrowserSession(
  db: PgDb,
  input: RotateBrowserSessionInput,
): Promise<SessionRotationResult> {
  const now = new Date();
  const currentHash = hashRefreshTokenId(input.currentRefreshTokenId);
  const nextHash = hashRefreshTokenId(input.nextRefreshTokenId);

  return db.transaction(async (tx) => {
    const [rotated] = await tx
      .update(authSessions)
      .set({
        currentRefreshJtiHash: nextHash,
        lastUsedAt: now,
        rotatedAt: now,
      })
      .where(
        and(
          eq(authSessions.id, input.sessionId),
          eq(authSessions.userId, input.userId),
          eq(authSessions.currentRefreshJtiHash, currentHash),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .returning({ expiresAt: authSessions.expiresAt });
    if (rotated) return { status: "rotated", expiresAt: rotated.expiresAt };

    const [session] = await tx
      .select({
        familyId: authSessions.familyId,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
      })
      .from(authSessions)
      .where(and(eq(authSessions.id, input.sessionId), eq(authSessions.userId, input.userId)))
      .limit(1);

    if (!session) return { status: "invalid" };
    if (session.revokedAt) return { status: "revoked" };
    if (session.expiresAt <= now) return { status: "expired" };

    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "replay" })
      .where(and(eq(authSessions.familyId, session.familyId), isNull(authSessions.revokedAt)));
    return { status: "replayed" };
  });
}

export async function revokeBrowserSession(
  db: PgDb,
  input: { sessionId: string; userId: string; reason?: "logout" | "admin" },
): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date(), revokedReason: input.reason ?? "logout" })
    .where(
      and(
        eq(authSessions.id, input.sessionId),
        eq(authSessions.userId, input.userId),
        isNull(authSessions.revokedAt),
      ),
    );
}

export async function isBrowserSessionActive(
  db: PgDb,
  input: { sessionId: string; userId: string },
): Promise<boolean> {
  const [session] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.id, input.sessionId),
        eq(authSessions.userId, input.userId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(session);
}
