import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import type { Context } from "hono";
import { type TokenPayload, verifyToken } from "../services/auth";
import { readAuthSessionCookie } from "./session-cookie";
import { isBrowserSessionActive } from "./session-ledger";

/**
 * Extract the JWT from one of three locations, in priority order:
 *   1. `Authorization: Bearer …` header (HTTP-style, used by `kq` CLI / curl)
 *   2. `Sec-WebSocket-Protocol: Bearer, <token>` (browser-friendly)
 *   3. `?token=…` query parameter (browser fallback when subprotocol is awkward)
 *   4. HttpOnly auth session cookie (OIDC/browser primary path)
 *
 * Browsers can't set arbitrary headers on `new WebSocket()`, so (2) and (3)
 * exist for the React SPA. The query-param fallback is fine because:
 *   - the URL is over the same TLS that protects the WebSocket payload,
 *   - JWTs are short-lived (300s in dev) and bound to a user role,
 *   - we never log full request URLs in production.
 */
export function extractToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const proto = c.req.header("Sec-WebSocket-Protocol");
  if (proto) {
    const parts = proto.split(",").map((s) => s.trim());
    const idx = parts.indexOf("Bearer");
    if (idx >= 0 && parts[idx + 1]) {
      return parts[idx + 1] ?? null;
    }
  }
  const tokQ = c.req.query("token");
  if (tokQ) return tokQ;
  return readAuthSessionCookie(c) ?? null;
}

export async function authenticateWs(
  c: Context,
  jwtSecret: string,
  db?: PgDb,
): Promise<TokenPayload> {
  const tok = extractToken(c);
  if (!tok) {
    throw new AppError(ErrorCode.UNAUTHORIZED, "Missing token for WebSocket upgrade", 401);
  }
  try {
    const user = await verifyToken(tok, jwtSecret);
    if (
      db &&
      user.sessionId &&
      !(await isBrowserSessionActive(db, { sessionId: user.sessionId, userId: user.sub }))
    ) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Session has been revoked or expired", 401);
    }
    return user;
  } catch {
    throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid or expired token", 401);
  }
}
