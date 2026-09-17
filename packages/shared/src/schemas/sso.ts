/**
 * SSO/OIDC configuration schemas (PRD F1.1 / F1.3).
 *
 * Single SSO config row exists at any time (singleton). The Server stores the
 * client_secret encrypted at rest; this schema represents the server-facing
 * shape used by the admin config API. The web UI reads back the same shape
 * with `clientSecret` replaced by a redacted placeholder so the password
 * input can stay empty unless the operator wants to rotate it.
 *
 * Group→role mapping uses a flat object whose keys are IdP group names and
 * whose values are platform `RoleName` values. The OIDC callback computes
 * the user's resolved role as the highest-priority role implied by the union
 * of their group memberships, defaulting to `user` when no group matches.
 *
 * Provider type field is a forward-compatible string union; only `oidc` is
 * supported in v1. The web form shows `saml`/`ldap` as disabled options so
 * operators can see they are on the roadmap without us promising a date.
 */
import { z } from "zod";
import { Role, type RoleName } from "../constants/roles";
import { PlatformBrandingSchema } from "./branding";

const ROLE_VALUES = Object.values(Role) as [RoleName, ...RoleName[]];

export const SsoProviderTypeEnum = z.enum(["oidc", "saml", "ldap"]);
export type SsoProviderType = z.infer<typeof SsoProviderTypeEnum>;

/** Placeholder returned in lieu of the real `client_secret` over the wire. */
export const SSO_SECRET_REDACTED = "__redacted__";

export const SsoGroupMappingSchema = z.record(z.string().min(1), z.enum(ROLE_VALUES));
export type SsoGroupMapping = z.infer<typeof SsoGroupMappingSchema>;

/**
 * Wire shape for `PUT /api/admin/sso/config`. The server receives this from
 * the admin form. `clientSecret` is optional on update; an absent field
 * means "keep the existing secret unchanged" so the form does not have to
 * round-trip the encrypted value through the browser.
 */
export const SsoConfigUpdateSchema = z.object({
  enabled: z.boolean().default(false),
  providerType: SsoProviderTypeEnum.default("oidc"),
  providerDisplayName: z.string().trim().max(80).default(""),
  loginWelcomeZh: z.string().trim().max(240).default(""),
  loginWelcomeEn: z.string().trim().max(240).default(""),
  issuerUrl: z.string().url().or(z.literal("")).default(""),
  clientId: z.string().default(""),
  /** Optional — when omitted on PUT, the existing encrypted secret is kept. */
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().or(z.literal("")).default(""),
  groupMapping: SsoGroupMappingSchema.default({}),
  autoCreateUsers: z.boolean().default(true),
});
export type SsoConfigUpdate = z.infer<typeof SsoConfigUpdateSchema>;

/**
 * Wire shape for `GET /api/admin/sso/config`. Always redacts the secret so
 * the value never leaves the Server once it has been encrypted at rest.
 */
export const SsoConfigViewSchema = z.object({
  enabled: z.boolean(),
  providerType: SsoProviderTypeEnum,
  providerDisplayName: z.string(),
  loginWelcomeZh: z.string(),
  loginWelcomeEn: z.string(),
  issuerUrl: z.string(),
  clientId: z.string(),
  /** Always redacted; the form must accept "" to mean "no change". */
  clientSecret: z.literal(SSO_SECRET_REDACTED).or(z.literal("")),
  redirectUri: z.string(),
  groupMapping: SsoGroupMappingSchema,
  autoCreateUsers: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type SsoConfigView = z.infer<typeof SsoConfigViewSchema>;

/** Body for `POST /api/admin/sso/test`. */
export const SsoTestRequestSchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  /** Optional: discovery + endpoint shape don't need it; we only check it is non-empty. */
  clientSecret: z.string().optional(),
});
export type SsoTestRequest = z.infer<typeof SsoTestRequestSchema>;

/** Response from the test endpoint — discovered endpoints + flag. */
export const SsoTestResultSchema = z.object({
  success: z.boolean(),
  /** Issuer URL echoed back from discovery (provider's canonical issuer). */
  issuer: z.string().nullable(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
  userinfoEndpoint: z.string().nullable(),
  jwksUri: z.string().nullable(),
  /** Human-readable error when success=false. */
  error: z.string().nullable(),
});
export type SsoTestResult = z.infer<typeof SsoTestResultSchema>;

/** Public read used by the login page to decide whether to show the SSO button. */
export const SsoPublicConfigSchema = z.object({
  enabled: z.boolean(),
  providerName: z.string(),
  welcomeMessage: z.object({
    zh: z.string(),
    en: z.string(),
  }),
  /** Optional while older Server deployments are rolling forward. */
  branding: PlatformBrandingSchema.optional(),
});
export type SsoPublicConfig = z.infer<typeof SsoPublicConfigSchema>;

/**
 * Compute the platform role that a user with `groups` should land on.
 *
 * Strategy: take the union of (group → role) lookups from the mapping; pick
 * the highest-priority role per ROLE_HIERARCHY; default to `user` when no
 * group matches. Returning `user` (not `guest`) matches the PRD intent that
 * a freshly auto-created user with at least one valid IdP login is a normal
 * platform user, not a guest.
 *
 * Pure / no I/O so the OIDC callback can call it after fetching userinfo.
 */
const ROLE_PRIORITY: Record<RoleName, number> = {
  super_admin: 5,
  platform_admin: 4,
  operator: 3,
  org_admin: 2,
  user: 1,
  guest: 0,
};

export function resolveRoleFromGroups(
  groups: ReadonlyArray<string>,
  mapping: SsoGroupMapping,
): RoleName {
  if (groups.length === 0) return Role.USER;
  let bestRole: RoleName | null = null;
  let bestPriority = -1;
  for (const g of groups) {
    const mapped = mapping[g];
    if (!mapped) continue;
    const priority = ROLE_PRIORITY[mapped];
    if (priority > bestPriority) {
      bestPriority = priority;
      bestRole = mapped;
    }
  }
  return bestRole ?? Role.USER;
}
