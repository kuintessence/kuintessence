/**
 * admin SSO config endpoints (PRD F1.1).
 *
 * Three routes, all gated to `platform_admin`:
 *
 *   GET  /api/admin/sso/config — current config with secret redacted
 *   PUT  /api/admin/sso/config — UPSERT; encrypts secret at rest; audit-log
 *   POST /api/admin/sso/test   — discovery probe; does not persist
 *
 * The PUT endpoint encrypts `clientSecret` via `secret-cipher` before
 * calling `saveSsoConfig`. When the body omits `clientSecret` (or sends
 * the redacted placeholder), the existing encrypted blob is preserved
 * — that's how the form's "I didn't re-enter the secret" path works.
 *
 * Audit-log entries always omit the secret. The diff records issuer,
 * clientId, enabled, group mapping size, and autoCreateUsers; that's
 * enough for compliance without leaking what was rotated.
 */
import type { PgDb } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  SSO_SECRET_REDACTED,
  SsoConfigUpdateSchema,
  type SsoConfigView,
  SsoTestRequestSchema,
  type SsoTestResult,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { discoverOidc } from "../auth/oidc";
import { encryptSecret } from "../auth/secret-cipher";
import { loadSsoConfig, saveSsoConfig } from "../auth/sso-config-store";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import { writeAudit } from "../services/audit-log-writer";

export interface AdminSsoRouteOptions {
  /** Wrapping key passed to secret-cipher. MUST be ≥32 chars. */
  secretWrappingKey: string;
  allowInsecureIssuer?: boolean;
  authz?: AuthzService;
}

function toView(row: Awaited<ReturnType<typeof loadSsoConfig>>): SsoConfigView {
  return {
    enabled: row.enabled,
    providerType: row.providerType,
    providerDisplayName: row.providerDisplayName,
    loginWelcomeZh: row.loginWelcomeZh,
    loginWelcomeEn: row.loginWelcomeEn,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    clientSecret: row.clientSecretEncrypted ? SSO_SECRET_REDACTED : "",
    redirectUri: row.redirectUri,
    groupMapping: row.groupMapping,
    autoCreateUsers: row.autoCreateUsers,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    updatedBy: row.updatedBy,
  };
}

export function createAdminSsoRoutes(db: PgDb, opts: AdminSsoRouteOptions): Hono {
  if (opts.secretWrappingKey.length < 32) {
    throw new Error("secretWrappingKey must be at least 32 chars");
  }
  const r = new Hono();

  r.get("/admin/sso/config", async (c) => {
    await requirePlatformPermission(c, opts.authz, "view", "admin-sso");
    const cfg = await loadSsoConfig(db);
    return c.json(toView(cfg));
  });

  r.put(
    "/admin/sso/config",
    kqValidator("json", SsoConfigUpdateSchema, "Invalid SSO config body"),
    async (c) => {
      await requirePlatformPermission(c, opts.authz, "manage", "admin-sso");
      const actorUserId = requireCanonicalSsoAdminActor(c);
      const input = c.req.valid("json");

      const before = await loadSsoConfig(db);

      // "I did not change the secret" if the field is absent OR explicitly
      // sent as the redacted placeholder (the form keeps the placeholder in
      // the password input until the user types something new).
      const keepExistingSecret =
        input.clientSecret === undefined || input.clientSecret === SSO_SECRET_REDACTED;

      let clientSecretEncrypted: string | undefined;
      if (!keepExistingSecret) {
        clientSecretEncrypted = await encryptSecret(
          input.clientSecret ?? "",
          opts.secretWrappingKey,
        );
      }

      await saveSsoConfig(db, {
        enabled: input.enabled,
        providerType: input.providerType,
        providerDisplayName: input.providerDisplayName,
        loginWelcomeZh: input.loginWelcomeZh,
        loginWelcomeEn: input.loginWelcomeEn,
        issuerUrl: input.issuerUrl,
        clientId: input.clientId,
        clientSecretEncrypted,
        keepExistingSecret,
        redirectUri: input.redirectUri,
        groupMapping: input.groupMapping,
        autoCreateUsers: input.autoCreateUsers,
        updatedBy: actorUserId,
      });

      await writeAudit(db, {
        actor: actorUserId,
        action: "sso.config.update",
        target: "sso_config",
        diff: {
          before: {
            enabled: before.enabled,
            providerType: before.providerType,
            providerDisplayName: before.providerDisplayName,
            loginWelcomeZh: before.loginWelcomeZh,
            loginWelcomeEn: before.loginWelcomeEn,
            issuerUrl: before.issuerUrl,
            clientId: before.clientId,
            redirectUri: before.redirectUri,
            groupMappingKeys: Object.keys(before.groupMapping),
            autoCreateUsers: before.autoCreateUsers,
            secretWasSet: before.clientSecretEncrypted.length > 0,
          },
          after: {
            enabled: input.enabled,
            providerType: input.providerType,
            providerDisplayName: input.providerDisplayName,
            loginWelcomeZh: input.loginWelcomeZh,
            loginWelcomeEn: input.loginWelcomeEn,
            issuerUrl: input.issuerUrl,
            clientId: input.clientId,
            redirectUri: input.redirectUri,
            groupMappingKeys: Object.keys(input.groupMapping),
            autoCreateUsers: input.autoCreateUsers,
            secretRotated: !keepExistingSecret,
          },
        },
      });

      const after = await loadSsoConfig(db);
      return c.json(toView(after));
    },
  );

  r.post(
    "/admin/sso/test",
    kqValidator("json", SsoTestRequestSchema, "Invalid SSO test body"),
    async (c) => {
      await requirePlatformPermission(c, opts.authz, "manage", "admin-sso");
      const actorUserId = requireCanonicalSsoAdminActor(c);
      const input = c.req.valid("json");

      let result: SsoTestResult;
      try {
        const discovered = await discoverOidc({
          issuerUrl: input.issuerUrl,
          clientId: input.clientId,
          clientSecret: input.clientSecret ?? "",
          allowInsecureIssuer: opts.allowInsecureIssuer,
          force: true,
        });
        result = {
          success: true,
          issuer: discovered.endpoints.issuer,
          authorizationEndpoint: discovered.endpoints.authorizationEndpoint,
          tokenEndpoint: discovered.endpoints.tokenEndpoint,
          userinfoEndpoint: discovered.endpoints.userinfoEndpoint,
          jwksUri: discovered.endpoints.jwksUri,
          error: null,
        };
      } catch (err) {
        result = {
          success: false,
          issuer: null,
          authorizationEndpoint: null,
          tokenEndpoint: null,
          userinfoEndpoint: null,
          jwksUri: null,
          error: err instanceof Error ? err.message : "Discovery failed",
        };
      }

      await writeAudit(db, {
        actor: actorUserId,
        action: "sso.config.test",
        target: "sso_config",
        diff: {
          after: {
            issuerUrl: input.issuerUrl,
            clientId: input.clientId,
            success: result.success,
          },
        },
      });

      return c.json(result);
    },
  );

  return r;
}

function requireCanonicalSsoAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}
