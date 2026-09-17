// Principal extraction for Registry.
//
// Production uses Authorization: Bearer JWTs with explicit issuer/audience
// validation. Tests and local dev may still opt into X-Test-Principal via
// REGISTRY_ALLOW_TEST_PRINCIPAL=1; jwt mode never honors that header unless
// a test passes allowTestHeader explicitly.
//
// The middleware sets the principal on `c.var.principal` (typed via the
// `RegistryEnv` Hono variables map) so downstream handlers can call
// `c.get('principal')` without type juggling.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
  assertPublisherRole,
  DEFAULT_PUBLISHER_ROLES,
  type RbacPrincipal,
  type RegistryRole,
} from "../services/namespace";

export interface RegistryEnv {
  Variables: {
    principal: RbacPrincipal;
  };
}

/** Lightweight Zod-free check — keeps the middleware allocation-free. */
function isRbacPrincipal(value: unknown): value is RbacPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.sub !== "string") return false;
  if (
    v.role !== "super_admin" &&
    v.role !== "platform_admin" &&
    v.role !== "operator" &&
    v.role !== "org_admin" &&
    v.role !== "user" &&
    v.role !== "guest"
  )
    return false;
  if (!Array.isArray(v.orgIds) || v.orgIds.some((id) => typeof id !== "string")) return false;
  return true;
}

export interface PrincipalMiddlewareOptions {
  authMode?: "dev" | "jwt";
  allowTestHeader?: boolean;
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  requirePublisher?: boolean;
  requireCanonicalPrincipal?: boolean;
  publisherRoles?: RegistryRole[];
  resolveCanonicalPrincipal?: (
    subject: string,
  ) => Promise<{ sub: string; role: RegistryRole; orgIds: string[]; suspended: boolean } | null>;
}

export function createPrincipalMiddleware(
  opts: PrincipalMiddlewareOptions = {},
): MiddlewareHandler<RegistryEnv> {
  const authMode = opts.authMode ?? "dev";
  const allowTestHeader =
    opts.allowTestHeader ??
    (authMode === "dev" && process.env.REGISTRY_ALLOW_TEST_PRINCIPAL === "1");
  return async (c, next) => {
    if (allowTestHeader) {
      const raw = c.req.header("X-Test-Principal");
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isRbacPrincipal(parsed)) {
            assertPublisherIfNeeded(parsed, opts);
            c.set("principal", parsed);
            return next();
          }
        } catch (err) {
          if (err instanceof PublisherRoleError) {
            return ociErrorJson(c, 403, "PUBLISHER_ROLE_REQUIRED", err.message);
          }
          // fall through to 401
        }
      }
    }
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return ociErrorJson(c, 401, "UNAUTHORIZED", "missing or invalid principal");
    }
    if (authMode !== "jwt" || !opts.jwtSecret) {
      return ociErrorJson(c, 401, "UNAUTHORIZED", "JWT auth is not configured");
    }
    try {
      let principal = verifyJwtPrincipal(auth.slice(7), {
        secret: opts.jwtSecret,
        issuer: opts.jwtIssuer,
        audience: opts.jwtAudience,
      });
      if (opts.requireCanonicalPrincipal && !opts.resolveCanonicalPrincipal) {
        throw new Error("canonical principal resolution is not configured");
      }
      if (opts.resolveCanonicalPrincipal) {
        const canonical = await opts.resolveCanonicalPrincipal(principal.sub);
        if (!canonical || canonical.suspended) throw new Error("principal is inactive");
        principal = {
          ...principal,
          sub: canonical.sub,
          role: canonical.role,
          orgIds: canonical.orgIds,
        };
      }
      assertPublisherIfNeeded(principal, opts);
      c.set("principal", principal);
      return next();
    } catch (err) {
      const isPublisherError = err instanceof PublisherRoleError;
      return ociErrorJson(
        c,
        isPublisherError ? 403 : 401,
        isPublisherError ? "PUBLISHER_ROLE_REQUIRED" : "INVALID_TOKEN",
        err instanceof Error ? err.message : "invalid token",
      );
    }
  };
}

export async function readOptionalPrincipal(
  c: Context<RegistryEnv> | Context,
  opts: PrincipalMiddlewareOptions = {},
): Promise<RbacPrincipal | null> {
  const authMode = opts.authMode ?? "dev";
  const allowTestHeader =
    opts.allowTestHeader ??
    (authMode === "dev" && process.env.REGISTRY_ALLOW_TEST_PRINCIPAL === "1");
  if (allowTestHeader) {
    const raw = c.req.header("X-Test-Principal");
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRbacPrincipal(parsed)) return parsed;
      throw new Error("test principal is invalid");
    }
  }
  const auth = c.req.header("Authorization");
  if (!auth) return null;
  if (!auth.startsWith("Bearer ")) {
    throw new Error("missing or invalid principal");
  }
  if (authMode !== "jwt" || !opts.jwtSecret) {
    throw new Error("JWT auth is not configured");
  }
  let principal = verifyJwtPrincipal(auth.slice(7), {
    secret: opts.jwtSecret,
    issuer: opts.jwtIssuer,
    audience: opts.jwtAudience,
  });
  if (opts.resolveCanonicalPrincipal) {
    const canonical = await opts.resolveCanonicalPrincipal(principal.sub);
    if (!canonical || canonical.suspended) throw new Error("principal is inactive");
    principal = {
      ...principal,
      sub: canonical.sub,
      role: canonical.role,
      orgIds: canonical.orgIds,
    };
  }
  return principal;
}

export class PublisherRoleError extends Error {
  constructor(message = "Registry write requires a publisher role") {
    super(message);
    this.name = "PublisherRoleError";
  }
}

function assertPublisherIfNeeded(principal: RbacPrincipal, opts: PrincipalMiddlewareOptions): void {
  if (!opts.requirePublisher) return;
  try {
    assertPublisherRole(principal, opts.publisherRoles ?? DEFAULT_PUBLISHER_ROLES);
  } catch (err) {
    throw new PublisherRoleError(err instanceof Error ? err.message : undefined);
  }
}

interface JwtVerifyOptions {
  secret: string;
  issuer?: string;
  audience?: string;
}

interface JwtPayload {
  sub?: unknown;
  role?: unknown;
  orgIds?: unknown;
  orgId?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

export function verifyJwtPrincipal(token: string, opts: JwtVerifyOptions): RbacPrincipal {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT must have three parts");
  const [rawHeader, rawPayload, rawSig] = parts;
  if (!rawHeader || !rawPayload || !rawSig) throw new Error("JWT is incomplete");
  const header = parseJsonObject(decodeBase64Url(rawHeader));
  if (header.alg !== "HS256") throw new Error("JWT alg must be HS256");

  const expected = createHmac("sha256", opts.secret).update(`${rawHeader}.${rawPayload}`).digest();
  const actual = decodeBase64Url(rawSig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("JWT signature mismatch");
  }

  const payload = parseJsonObject(decodeBase64Url(rawPayload)) as JwtPayload;
  if (opts.issuer && payload.iss !== opts.issuer) throw new Error("JWT issuer mismatch");
  if (opts.audience && !audienceMatches(payload.aud, opts.audience)) {
    throw new Error("JWT audience mismatch");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp <= now) throw new Error("JWT expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new Error("JWT not yet valid");

  const principal = {
    sub: payload.sub,
    role: payload.role,
    orgIds: normalizeOrgIds(payload.orgIds, payload.orgId),
  };
  if (!isRbacPrincipal(principal)) throw new Error("JWT principal claims are invalid");
  return principal;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JWT JSON part must be an object");
  }
  return parsed as Record<string, unknown>;
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.some((item) => item === expected);
}

function normalizeOrgIds(orgIds: unknown, orgId: unknown): string[] {
  if (Array.isArray(orgIds) && orgIds.every((id) => typeof id === "string")) return orgIds;
  return typeof orgId === "string" ? [orgId] : [];
}

export type OciErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 416 | 500;

/**
 * Emit an OCI Distribution v2 error envelope. The buildcache routes mount
 * a separate handler with the regular `AppError` envelope; this helper is
 * /v2-shaped and useful from the principal middleware too.
 *
 * Typed against the generic `Context` so it can be called from any
 * Hono router regardless of its specific Variables map.
 */
export function ociErrorJson(
  c: Context<RegistryEnv> | Context,
  status: OciErrorStatus,
  code: string,
  message: string,
  detail?: unknown,
) {
  return c.json(
    {
      errors: [
        {
          code,
          message,
          ...(detail !== undefined ? { detail } : {}),
        },
      ],
    },
    status,
  );
}
