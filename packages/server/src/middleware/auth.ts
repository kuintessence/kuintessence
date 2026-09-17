import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { readAuthSessionCookie } from "../auth/session-cookie";
import { isBrowserSessionActive } from "../auth/session-ledger";
import { type TokenPayload, verifyToken } from "../services/auth";

declare module "hono" {
  interface ContextVariableMap {
    user: TokenPayload;
  }
}

export function authMiddleware(jwtSecret: string, db?: PgDb) {
  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const token = bearerToken ?? readAuthSessionCookie(c);
    if (!token) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Missing or invalid token", 401);
    }
    if (!bearerToken) {
      assertCookieRequestBoundary(c);
    }
    try {
      const user = await verifyToken(token, jwtSecret);
      if (
        db &&
        user.sessionId &&
        !(await isBrowserSessionActive(db, { sessionId: user.sessionId, userId: user.sub }))
      ) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Session has been revoked or expired", 401);
      }
      c.set("user", user);
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid or expired token", 401);
    }
    await next();
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function assertCookieRequestBoundary(c: Context): void {
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  const fetchSite = c.req.header("Sec-Fetch-Site");
  if (fetchSite === "cross-site") {
    throw new AppError(ErrorCode.FORBIDDEN, "Cross-site cookie request rejected", 403);
  }
  if (fetchSite === "same-origin" || fetchSite === "same-site") return;
  const origin = c.req.header("Origin");
  if (!origin) return;
  const requestOrigin = requestOriginFromHeaders(c) ?? requestOriginFromUrl(c.req.url);
  if (!requestOrigin) return;
  if (origin !== requestOrigin) {
    throw new AppError(ErrorCode.FORBIDDEN, "Cross-origin cookie request rejected", 403);
  }
}

function requestOriginFromHeaders(c: Context): string | null {
  const host = firstHeaderValue(c.req.header("X-Forwarded-Host")) ?? c.req.header("Host");
  const proto = firstHeaderValue(c.req.header("X-Forwarded-Proto"));
  if (!host || !proto) return null;
  return `${proto}://${host}`;
}

function requestOriginFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | undefined): string | null {
  return value?.split(",")[0]?.trim() || null;
}
