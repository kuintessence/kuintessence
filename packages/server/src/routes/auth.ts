/**
 * Auth routes — dev-mode JWT login + OIDC entry/callback.
 *
 * Existing dev login (`POST /auth/login`) is preserved verbatim so existing
 * tests, demos, and the web "switch role" panel keep working. When SSO is
 * enabled in `sso_config`, the route logs a WARN on every dev-login call so
 * production deployments are visible in the operator's logs.
 *
 * OIDC and branding routes:
 *
 *   GET  /auth/oidc/config-public — public; tells the login page whether to
 *                                   show the SSO button + provider name.
 *   GET  /branding                 — public; serves platform identity and
 *                                   image references independently of SSO.
 *   GET  /auth/oidc/login         — public; redirects to IdP authorize URL
 *                                   (PKCE + state stored in HttpOnly cookie).
 *   GET  /auth/oidc/callback      — public; validates state, exchanges code,
 *                                   upserts user, signs JWT into an HttpOnly
 *                                   cookie, 302 to web `/` with non-secret
 *                                   session metadata.
 *
 * State+codeVerifier are persisted in two short-lived HttpOnly cookies. We
 * deliberately avoid a server-side state store so the Server stays stateless on
 * the auth path.
 */
import { createHash } from "node:crypto";
import { authzOutbox, orgs, type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  Role,
  type RoleName,
  type SsoPublicConfig,
} from "@kuintessence/shared";
import { eq, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Logger } from "pino";
import { z } from "zod";
import {
  buildOidcAuthUrl,
  type CompleteCallbackResult,
  completeOidcCallback,
  discoverOidc,
  relaxInsecureForTesting,
} from "../auth/oidc";
import { decryptSecret } from "../auth/secret-cipher";
import {
  clearAuthRefreshCookie,
  clearAuthSessionCookie,
  readAuthRefreshCookie,
  readAuthSessionCookie,
  setAuthRefreshCookie,
  setAuthSessionCookie,
} from "../auth/session-cookie";
import {
  activateCliSession,
  createBrowserSession,
  isBrowserSessionActive,
  revokeBrowserSession,
  rotateBrowserSession,
} from "../auth/session-ledger";
import { loadSsoConfig, type SsoConfigRow } from "../auth/sso-config-store";
import {
  type MembershipRole,
  organizationBaselineTuples,
  organizationMembershipReplacementTuples,
  platformMemberTuple,
  platformRoleReplacementTuples,
} from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";
import { assertCookieRequestBoundary } from "../middleware/auth";
import { kqValidator } from "../middleware/validator";
import { recordIdentityFallback } from "../observability/identity-fallback";
import {
  signSessionRefreshToken,
  signToken,
  type TokenPayload,
  verifySessionRefreshToken,
  verifyToken,
} from "../services/auth";
import { loadPlatformBranding } from "../services/platform-branding-store";

const ROLE_VALUES = Object.values(Role) as [RoleName, ...RoleName[]];

const LoginSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLE_VALUES).default("user"),
});

const CliOidcExchangeSchema = z.object({
  code: z.string().min(1),
});

const ACCESS_TOKEN_TTL_SEC = 15 * 60;
const REFRESH_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;
const OIDC_STATE_COOKIE = "kq_oidc_state";
const OIDC_VERIFIER_COOKIE = "kq_oidc_verifier";
const OIDC_CLI_REDIRECT_COOKIE = "kq_oidc_cli_redirect";
const OIDC_CLI_STATE_COOKIE = "kq_oidc_cli_state";
const OIDC_COOKIE_TTL_SEC = 10 * 60;
const OIDC_CLI_CODE_TTL_SEC = 2 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthRouteOptions {
  /** Wrapping key for the OIDC client_secret cipher. MUST be ≥32 chars. */
  ssoSecretWrappingKey: string;
  /** Web SPA URL to land on after OIDC callback. Default: `/`. */
  webBaseUrl?: string;
  /**
   * When true, allow http:// IdP issuers (development convenience).
   * Default: derived from NODE_ENV by the caller.
   */
  allowInsecureIssuer?: boolean;
  /**
   * Whether the passwordless dev login (`POST /auth/login`) is available. It
   * grants a caller-chosen role (incl. super_admin) with no credential, so it
   * MUST be off in production — the bootstrap passes `NODE_ENV !== "production"`.
   * Defaults to `true` for back-compat with existing dev/test callers.
   */
  devLoginEnabled?: boolean;
  /** Optional logger; falls back to silent. */
  logger?: Logger;
  authz?: AuthzService;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
}

function isSsoFullyConfigured(cfg: SsoConfigRow): boolean {
  return (
    cfg.enabled &&
    cfg.providerType === "oidc" &&
    cfg.issuerUrl.length > 0 &&
    cfg.clientId.length > 0
  );
}

export function createAuthRoutes(jwtSecret: string, db: PgDb, options: AuthRouteOptions): Hono {
  const auth = new Hono();
  const ssoSecretWrappingKey = options.ssoSecretWrappingKey;
  const webBase = options.webBaseUrl ?? "/";
  const devLoginEnabled = options.devLoginEnabled ?? true;
  const log = options.logger;
  const accessTokenTtlSec = options.accessTokenTtlSec ?? ACCESS_TOKEN_TTL_SEC;
  const refreshTokenTtlSec = options.refreshTokenTtlSec ?? REFRESH_TOKEN_TTL_SEC;
  if (ssoSecretWrappingKey.length < 32) {
    throw new Error("ssoSecretWrappingKey must be at least 32 chars");
  }
  if (accessTokenTtlSec < 60 || refreshTokenTtlSec <= accessTokenTtlSec) {
    throw new Error("refreshTokenTtlSec must be greater than accessTokenTtlSec (minimum 60s)");
  }

  async function writeSessionCookies(
    c: Context,
    payload: TokenPayload,
    input: { refreshTokenId: string; expiresAt: Date },
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const remainingSec = Math.floor((input.expiresAt.getTime() - Date.now()) / 1000);
    if (remainingSec <= 0) {
      throw new Error("Browser session has expired");
    }
    const expiresIn = Math.min(accessTokenTtlSec, remainingSec);
    const [accessToken, refreshToken] = await Promise.all([
      signToken(payload, jwtSecret, expiresIn),
      signSessionRefreshToken(payload, jwtSecret, remainingSec, input.refreshTokenId),
    ]);
    const secure = !options.allowInsecureIssuer;
    setAuthSessionCookie(c, accessToken, { maxAgeSec: expiresIn, secure });
    setAuthRefreshCookie(c, refreshToken, { maxAgeSec: remainingSec, secure });
    return { accessToken, expiresIn };
  }

  async function issueSession(
    c: Context,
    payload: TokenPayload,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const sessionId = crypto.randomUUID();
    const refreshTokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + refreshTokenTtlSec * 1000);
    const sessionPayload = {
      ...payload,
      orgIds: await loadSessionOrgIds(db, payload.sub),
      sessionId,
    };
    await createBrowserSession(db, {
      sessionId,
      familyId: crypto.randomUUID(),
      userId: payload.sub,
      refreshTokenId,
      expiresAt,
    });
    return writeSessionCookies(c, sessionPayload, { refreshTokenId, expiresAt });
  }

  function clearSession(c: Context): void {
    clearAuthSessionCookie(c);
    clearAuthRefreshCookie(c);
  }

  // Public — login page reads this to decide whether to show the SSO button.
  auth.get("/auth/oidc/config-public", async (c) => {
    const cfg = await loadSsoConfig(db);
    const branding = await loadPlatformBranding(db);
    const fullyConfigured = isSsoFullyConfigured(cfg);
    const view: SsoPublicConfig = {
      enabled: fullyConfigured,
      providerName: fullyConfigured ? cfg.providerDisplayName : "",
      welcomeMessage: {
        zh: cfg.loginWelcomeZh,
        en: cfg.loginWelcomeEn,
      },
      branding: {
        locales: branding.locales,
        logoUrl: branding.logoUrl,
        faviconUrl: branding.faviconUrl,
      },
    };
    return c.json(view);
  });

  auth.get("/branding", async (c) => {
    const branding = await loadPlatformBranding(db);
    return c.json({
      locales: branding.locales,
      logoUrl: branding.logoUrl,
      faviconUrl: branding.faviconUrl,
    });
  });

  auth.get("/auth/session", async (c) => {
    const token = readAuthSessionCookie(c);
    if (!token) {
      return c.json({ authenticated: false });
    }
    try {
      const user = await verifyToken(token, jwtSecret);
      const identity = await resolveSessionIdentity(db, user, "session_read");
      if (
        user.sessionId &&
        (!identity.userId ||
          !(await isBrowserSessionActive(db, {
            sessionId: user.sessionId,
            userId: identity.userId,
          })))
      ) {
        clearSession(c);
        return c.json({ authenticated: false });
      }
      return c.json({
        authenticated: true,
        user: {
          sub: identity.userId ?? user.sub,
          email: identity.email,
          role: identity.role,
        },
      });
    } catch {
      clearAuthSessionCookie(c);
      return c.json({ authenticated: false });
    }
  });

  auth.post("/auth/session/refresh", async (c) => {
    assertCookieRequestBoundary(c);
    const token = readAuthRefreshCookie(c);
    if (!token) {
      clearSession(c);
      return c.json({ authenticated: false });
    }
    try {
      const user = await verifySessionRefreshToken(token, jwtSecret);
      if (!user.sessionId) {
        log?.info(
          { email: user.email },
          "Legacy browser refresh token rejected; interactive login required",
        );
        clearSession(c);
        return c.json({ authenticated: false });
      }
      const identity = await resolveSessionIdentity(db, user, "session_refresh");
      if (!identity.userId) {
        clearSession(c);
        return c.json({ authenticated: false });
      }
      const nextRefreshTokenId = crypto.randomUUID();
      const rotation = await rotateBrowserSession(db, {
        sessionId: user.sessionId,
        userId: identity.userId,
        currentRefreshTokenId: user.refreshTokenId,
        nextRefreshTokenId,
      });
      if (rotation.status !== "rotated") {
        log?.warn(
          { userId: identity.userId, sessionId: user.sessionId, rotation: rotation.status },
          "Browser session refresh rejected",
        );
        clearSession(c);
        return c.json({ authenticated: false });
      }
      const issued = await writeSessionCookies(
        c,
        {
          sub: identity.userId ?? user.sub,
          email: identity.email,
          role: identity.role,
          orgIds: identity.orgIds,
          sessionId: user.sessionId,
        },
        {
          refreshTokenId: nextRefreshTokenId,
          expiresAt: rotation.expiresAt,
        },
      );
      return c.json({
        authenticated: true,
        expiresIn: issued.expiresIn,
        user: {
          sub: identity.userId ?? user.sub,
          email: identity.email,
          role: identity.role,
        },
      });
    } catch {
      clearSession(c);
      return c.json({ authenticated: false });
    }
  });

  auth.post("/auth/logout", async (c) => {
    const authorization = c.req.header("Authorization");
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (bearerToken) {
      const user = await verifyToken(bearerToken, jwtSecret).catch(() => null);
      if (!user) return c.json({ ok: true });
      try {
        if (user.sessionId && UUID_RE.test(user.sub)) {
          await revokeBrowserSession(db, { sessionId: user.sessionId, userId: user.sub });
        }
      } catch (err) {
        log?.error({ err, sessionId: user.sessionId }, "CLI session revoke failed");
        throw err;
      }
      return c.json({ ok: true });
    }

    assertCookieRequestBoundary(c);
    const refreshToken = readAuthRefreshCookie(c);
    if (refreshToken) {
      try {
        const user = await verifySessionRefreshToken(refreshToken, jwtSecret);
        if (user.sessionId && UUID_RE.test(user.sub)) {
          await revokeBrowserSession(db, { sessionId: user.sessionId, userId: user.sub });
        }
      } catch {
        // Cookie clearing still succeeds when a session has already expired.
      }
    }
    clearSession(c);
    return c.json({ ok: true });
  });

  auth.post(
    "/auth/oidc/exchange",
    kqValidator("json", CliOidcExchangeSchema, "Invalid CLI OIDC exchange body"),
    async (c) => {
      const { code } = c.req.valid("json");
      const grant = await verifySessionRefreshToken(code, jwtSecret).catch(() => null);
      if (!grant) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "CLI OIDC code is invalid or expired", 401);
      }
      if (!grant.sessionId) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "CLI OIDC code has no session", 401);
      }
      const identity = await resolveSessionIdentity(db, grant, "session_refresh");
      if (!identity.userId) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "CLI OIDC identity is unavailable", 401);
      }
      const expiresAt = new Date(Date.now() + refreshTokenTtlSec * 1000);
      const activated = await activateCliSession(db, {
        sessionId: grant.sessionId,
        userId: identity.userId,
        currentRefreshTokenId: grant.refreshTokenId,
        consumedRefreshTokenId: crypto.randomUUID(),
        expiresAt,
      });
      if (!activated) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "CLI OIDC code is invalid or expired", 401);
      }
      const expiresInSec = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      const accessToken = await signToken(
        {
          sub: identity.userId,
          role: identity.role,
          email: identity.email,
          orgIds: identity.orgIds,
          sessionId: grant.sessionId,
        },
        jwtSecret,
        expiresInSec,
      );
      return c.json({
        accessToken,
        expiresAt: expiresAt.toISOString(),
        principal: {
          sub: identity.userId,
          email: identity.email,
        },
      });
    },
  );

  // Dev-mode login — issues JWT directly. Kept for existing dev workflows;
  // emits a WARN whenever called while SSO is enabled.
  auth.post("/auth/login", kqValidator("json", LoginSchema, "Invalid login body"), async (c) => {
    // Passwordless, caller-chosen-role login — disabled outside dev/test so it
    // can never be a production admin backdoor (NODE_ENV-gated by the caller).
    if (!devLoginEnabled) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Dev-mode login is disabled; authenticate via SSO (/auth/oidc/login)",
        403,
      );
    }
    const { email, role } = c.req.valid("json");
    const cfg = await loadSsoConfig(db);
    if (cfg.enabled) {
      log?.warn(
        { email, role },
        "/auth/login (dev-mode) called while SSO is enabled — production should use /auth/oidc/login",
      );
    }

    const userId = await upsertUserAndSeedAuthz(
      db,
      {
        email,
        role,
      },
      Boolean(options.authz),
    );

    const issued = await issueSession(c, { sub: userId, role, email });
    return c.json({ token: issued.accessToken, expiresIn: issued.expiresIn });
  });

  // OIDC login — redirect to IdP authorize URL.
  auth.get("/auth/oidc/login", async (c) => {
    const cfg = await loadSsoConfig(db);
    if (!isSsoFullyConfigured(cfg)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "SSO is not enabled or fully configured", 400);
    }
    const clientSecret = cfg.clientSecretEncrypted
      ? await decryptSecret(cfg.clientSecretEncrypted, ssoSecretWrappingKey)
      : "";
    const discovered = await discoverOidc({
      issuerUrl: cfg.issuerUrl,
      clientId: cfg.clientId,
      clientSecret,
      allowInsecureIssuer: options.allowInsecureIssuer,
    });
    if (options.allowInsecureIssuer) {
      relaxInsecureForTesting(discovered.config);
    }

    const cliRequest = readCliLoginRequest(c);
    const redirectUri = cfg.redirectUri.length > 0 ? cfg.redirectUri : defaultRedirectUri(c);
    const built = await buildOidcAuthUrl(discovered.config, { redirectUri });

    setCookie(c, OIDC_STATE_COOKIE, built.state, {
      httpOnly: true,
      secure: !options.allowInsecureIssuer,
      sameSite: "Lax",
      path: "/api/auth/oidc",
      maxAge: OIDC_COOKIE_TTL_SEC,
    });
    setCookie(c, OIDC_VERIFIER_COOKIE, built.codeVerifier, {
      httpOnly: true,
      secure: !options.allowInsecureIssuer,
      sameSite: "Lax",
      path: "/api/auth/oidc",
      maxAge: OIDC_COOKIE_TTL_SEC,
    });
    if (cliRequest) {
      setCookie(c, OIDC_CLI_REDIRECT_COOKIE, cliRequest.redirectUri, {
        httpOnly: true,
        secure: !options.allowInsecureIssuer,
        sameSite: "Lax",
        path: "/api/auth/oidc",
        maxAge: OIDC_COOKIE_TTL_SEC,
      });
      setCookie(c, OIDC_CLI_STATE_COOKIE, cliRequest.state, {
        httpOnly: true,
        secure: !options.allowInsecureIssuer,
        sameSite: "Lax",
        path: "/api/auth/oidc",
        maxAge: OIDC_COOKIE_TTL_SEC,
      });
    } else {
      deleteCookie(c, OIDC_CLI_REDIRECT_COOKIE, { path: "/api/auth/oidc" });
      deleteCookie(c, OIDC_CLI_STATE_COOKIE, { path: "/api/auth/oidc" });
    }

    return c.redirect(built.url, 302);
  });

  // OIDC callback — exchange code, upsert user, sign JWT, redirect to web.
  auth.get("/auth/oidc/callback", async (c) => {
    const cfg = await loadSsoConfig(db);
    if (!isSsoFullyConfigured(cfg)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "SSO is not enabled", 400);
    }
    const errorParam = c.req.query("error");
    if (errorParam) {
      const desc = c.req.query("error_description") ?? "";
      throw new AppError(
        ErrorCode.UNAUTHORIZED,
        `OIDC provider returned error: ${errorParam}${desc ? ` — ${desc}` : ""}`,
        401,
      );
    }
    const expectedState = getCookie(c, OIDC_STATE_COOKIE);
    const codeVerifier = getCookie(c, OIDC_VERIFIER_COOKIE);
    if (!expectedState || !codeVerifier) {
      throw new AppError(
        ErrorCode.UNAUTHORIZED,
        "OIDC callback missing state/verifier cookie — login may have expired",
        401,
      );
    }

    const clientSecret = cfg.clientSecretEncrypted
      ? await decryptSecret(cfg.clientSecretEncrypted, ssoSecretWrappingKey)
      : "";
    const discovered = await discoverOidc({
      issuerUrl: cfg.issuerUrl,
      clientId: cfg.clientId,
      clientSecret,
      allowInsecureIssuer: options.allowInsecureIssuer,
    });
    if (options.allowInsecureIssuer) {
      relaxInsecureForTesting(discovered.config);
    }

    const url = new URL(c.req.url);
    let result: CompleteCallbackResult;
    try {
      result = await completeOidcCallback({
        config: discovered.config,
        callbackUrl: url,
        expectedState,
        codeVerifier,
        groupMapping: cfg.groupMapping,
      });
    } catch (err) {
      log?.warn({ err: String(err) }, "OIDC callback failed");
      throw new AppError(
        ErrorCode.UNAUTHORIZED,
        err instanceof Error ? err.message : "OIDC callback failed",
        401,
      );
    }

    // Decide identity. We require an email for the existing JWT shape, but
    // some IdPs only return an opaque subject. The fallback must still be a
    // syntactically valid email because JWT verification validates this field.
    const fallbackEmail = fallbackEmailFromSubject(result.sub, cfg.issuerUrl);
    const email = result.email ?? fallbackEmail;
    const role = result.resolvedRole;
    const externalId = oidcExternalIdentityKey(cfg.issuerUrl, result.sub);

    if (!cfg.autoCreateUsers) {
      // Caller policy: SSO must not auto-provision. Verify the user already
      // exists; otherwise refuse the login.
      const existing = await db
        .select()
        .from(users)
        .where(
          or(
            eq(users.externalId, externalId),
            eq(users.externalId, result.sub),
            eq(users.email, email),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "User not provisioned and auto-create is disabled",
          403,
        );
      }
    }

    const userId = await upsertUserAndSeedAuthz(
      db,
      {
        email,
        role,
        externalId,
        legacyExternalId: result.sub,
        displayName: result.displayName,
      },
      Boolean(options.authz),
    );

    const cliRequest = readCliLoginCookies(c);
    deleteCookie(c, OIDC_STATE_COOKIE, { path: "/api/auth/oidc" });
    deleteCookie(c, OIDC_VERIFIER_COOKIE, { path: "/api/auth/oidc" });
    deleteCookie(c, OIDC_CLI_REDIRECT_COOKIE, { path: "/api/auth/oidc" });
    deleteCookie(c, OIDC_CLI_STATE_COOKIE, { path: "/api/auth/oidc" });

    if (cliRequest) {
      const sessionId = crypto.randomUUID();
      const refreshTokenId = crypto.randomUUID();
      await createBrowserSession(db, {
        sessionId,
        familyId: crypto.randomUUID(),
        userId,
        refreshTokenId,
        expiresAt: new Date(Date.now() + OIDC_CLI_CODE_TTL_SEC * 1000),
      });
      const code = await signSessionRefreshToken(
        {
          sub: userId,
          role,
          email,
          orgIds: await loadSessionOrgIds(db, userId),
          sessionId,
        },
        jwtSecret,
        OIDC_CLI_CODE_TTL_SEC,
        refreshTokenId,
      );
      const landing = new URL(cliRequest.redirectUri);
      landing.searchParams.set("code", code);
      landing.searchParams.set("state", cliRequest.state);
      return c.redirect(landing.toString(), 302);
    }

    await issueSession(c, { sub: userId, role, email });

    // Redirect back to the web app with non-secret session metadata. The web
    // resolves display role through /auth/session/refresh after landing.
    const landing = new URL(webBase, c.req.url);
    landing.searchParams.set("session", "cookie");
    landing.searchParams.set("expiresIn", String(accessTokenTtlSec));
    landing.searchParams.set("email", email);
    return c.redirect(landing.toString(), 302);
  });

  return auth;
}

function readCliLoginRequest(c: Context): { redirectUri: string; state: string } | null {
  const redirectUri = c.req.query("redirect_uri");
  const state = c.req.query("state");
  if (!redirectUri && !state) return null;
  if (!redirectUri || !state) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "CLI OIDC redirect and state are required", 400);
  }
  return validateCliLoginRequest(redirectUri, state);
}

function readCliLoginCookies(c: Context): { redirectUri: string; state: string } | null {
  const redirectUri = getCookie(c, OIDC_CLI_REDIRECT_COOKIE);
  const state = getCookie(c, OIDC_CLI_STATE_COOKIE);
  if (!redirectUri && !state) return null;
  if (!redirectUri || !state) {
    throw new AppError(ErrorCode.UNAUTHORIZED, "CLI OIDC context is incomplete", 401);
  }
  return validateCliLoginRequest(redirectUri, state);
}

function validateCliLoginRequest(
  redirectUri: string,
  state: string,
): { redirectUri: string; state: string } {
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "CLI OIDC redirect is invalid", 400);
  }
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== "/callback" ||
    redirect.port.length === 0 ||
    state.length < 16 ||
    state.length > 256
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "CLI OIDC redirect must use a local callback and valid state",
      400,
    );
  }
  return { redirectUri: redirect.toString(), state };
}

function fallbackEmailFromSubject(subject: string, issuerUrl: string): string {
  const localPart = subject.replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/g, "-") || "oidc-user";
  return `${localPart}@${new URL(issuerUrl).hostname}`;
}

export function oidcExternalIdentityKey(issuerUrl: string, subject: string): string {
  const issuer = new URL(issuerUrl);
  issuer.search = "";
  issuer.hash = "";
  issuer.pathname = issuer.pathname.replace(/\/+$/, "");
  const normalizedIssuer = issuer.toString().replace(/\/$/, "");
  const digest = createHash("sha256")
    .update(normalizedIssuer)
    .update("\0")
    .update(subject)
    .digest("hex");
  return `oidc:${digest}`;
}

type AuthSeedDb = Pick<PgDb, "insert" | "select" | "update">;

async function resolveSessionIdentity(
  db: PgDb,
  user: { sub: string; email: string },
  fallbackSurface: "session_read" | "session_refresh",
): Promise<{ userId: string | null; role: RoleName; email: string; orgIds: string[] }> {
  if (!UUID_RE.test(user.sub)) {
    recordIdentityFallback(fallbackSurface);
  }
  const [row] = await db
    .select({ id: users.id, role: users.role, email: users.email })
    .from(users)
    .where(UUID_RE.test(user.sub) ? eq(users.id, user.sub) : eq(users.email, user.email))
    .limit(1);
  return {
    userId: row?.id ?? null,
    role: (row?.role ?? "guest") as RoleName,
    email: row?.email ?? user.email,
    orgIds: row ? await loadSessionOrgIds(db, row.id) : [],
  };
}

async function loadSessionOrgIds(db: PgDb, userId: string): Promise<string[]> {
  const memberships = await db
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, userId))
    .orderBy(userOrgMemberships.createdAt, userOrgMemberships.orgId);
  return memberships.map(({ orgId }) => orgId);
}

async function upsertUserAndSeedAuthz(
  db: PgDb,
  input: {
    email: string;
    role: RoleName;
    externalId?: string;
    legacyExternalId?: string;
    displayName?: string | null;
  },
  authzEnabled: boolean,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [canonicalExternal] = input.externalId
      ? await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.externalId, input.externalId))
          .limit(1)
      : [];
    const [legacyExternal] =
      input.externalId && !canonicalExternal && input.legacyExternalId
        ? await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.externalId, input.legacyExternalId))
            .limit(1)
        : [];
    const existingExternal = canonicalExternal ?? legacyExternal;
    const [upserted] = existingExternal
      ? await tx
          .update(users)
          .set({
            email: input.email,
            role: input.role,
            ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existingExternal.id))
          .returning({ id: users.id })
      : await tx
          .insert(users)
          .values({
            email: input.email,
            role: input.role,
            ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          })
          .onConflictDoUpdate({
            target: users.email,
            set: {
              role: input.role,
              ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
              ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
              updatedAt: new Date(),
            },
          })
          .returning({ id: users.id });
    if (!upserted?.id) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "User upsert returned no row", 500);
    }
    await ensureDefaultAuthzSeed(tx, {
      userId: upserted.id,
      role: input.role,
      authzEnabled,
    });
    return upserted.id;
  });
}

type AuthzSeedInput = {
  userId: string;
  role: RoleName;
  authzEnabled: boolean;
};

async function ensureDefaultAuthzSeed(db: AuthSeedDb, input: AuthzSeedInput): Promise<void> {
  const { userId, role, authzEnabled } = input;
  const orgName = "Development Compute Provider";
  const [existingOrg] = await db.select().from(orgs).where(eq(orgs.name, orgName)).limit(1);
  const org =
    existingOrg ?? (await db.insert(orgs).values({ name: orgName }).returning({ id: orgs.id }))[0];
  if (!org) return;
  const membershipRole = resolveMembershipRole(role);
  await db
    .insert(userOrgMemberships)
    .values({ userId, orgId: org.id, role: membershipRole })
    .onConflictDoUpdate({
      target: [userOrgMemberships.userId, userOrgMemberships.orgId],
      set: { role: membershipRole, updatedAt: new Date() },
    });
  if (!authzEnabled) return;

  await insertAuthzOutboxRows(db, [
    ...organizationBaselineTuples(org.id),
    ...organizationMembershipReplacementTuples({ userId, orgId: org.id, role: membershipRole }),
    platformMemberTuple(userId),
    ...authzRoleProjectionTuples(userId, role),
  ]);
}

function resolveMembershipRole(role: RoleName): MembershipRole {
  return role === "super_admin" || role === "platform_admin" || role === "org_admin"
    ? "admin"
    : "member";
}

function authzRoleProjectionTuples(userId: string, role: RoleName): AuthzTuple[] {
  const platformRole =
    role === "super_admin" || role === "platform_admin" || role === "operator" ? role : null;
  return platformRoleReplacementTuples({ userId, role: platformRole });
}

async function insertAuthzOutboxRows(db: AuthSeedDb, tuples: AuthzTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  await db.insert(authzOutbox).values(
    tuples.map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}

/**
 * Compute a default redirect URI from the request when the operator has not
 * pinned one in `sso_config.redirectUri`. Uses the request's host header so
 * local dev (http://localhost:3000) works without configuration.
 */
function defaultRedirectUri(c: import("hono").Context): string {
  const reqUrl = new URL(c.req.url);
  reqUrl.pathname = "/api/auth/oidc/callback";
  reqUrl.search = "";
  return reqUrl.toString();
}
