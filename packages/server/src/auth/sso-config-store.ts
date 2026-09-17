/**
 * singleton-store wrapper around the `sso_config` table.
 *
 * The schema enforces "single row" via a constant PK + CHECK; this module
 * makes the rest of the Server treat the table as a typed singleton:
 *
 *   - `loadSsoConfig` — returns the parsed row, or a fully-defaulted view
 *     when the row is absent. Callers never see `null`.
 *   - `saveSsoConfig` — UPSERTs the singleton with the given partial. The
 *     caller is responsible for encrypting `clientSecret`; this store
 *     persists `clientSecretEncrypted` as-is. Pass `keepExistingSecret`
 *     to leave the encrypted blob untouched (covers the form's "I didn't
 *     re-enter my secret on save" path).
 *
 * The store deliberately does NOT call into `secret-cipher` — separating
 * persistence from crypto keeps each module testable without DB.
 */
import { type PgDb, ssoConfig } from "@kuintessence/db";
import {
  type SsoGroupMapping,
  SsoGroupMappingSchema,
  type SsoProviderType,
  SsoProviderTypeEnum,
} from "@kuintessence/shared";
import { eq } from "drizzle-orm";

const SINGLETON_ID = "default";

/** Row as the rest of the Server sees it. */
export interface SsoConfigRow {
  enabled: boolean;
  providerType: SsoProviderType;
  providerDisplayName: string;
  loginWelcomeZh: string;
  loginWelcomeEn: string;
  issuerUrl: string;
  clientId: string;
  /** Base64 AES-GCM ciphertext; empty string when no secret is set. */
  clientSecretEncrypted: string;
  redirectUri: string;
  groupMapping: SsoGroupMapping;
  autoCreateUsers: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface SsoConfigSavePartial {
  enabled: boolean;
  providerType: SsoProviderType;
  providerDisplayName?: string;
  loginWelcomeZh?: string;
  loginWelcomeEn?: string;
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  groupMapping: SsoGroupMapping;
  autoCreateUsers: boolean;
  /**
   * If `keepExistingSecret` is true, the existing `client_secret_encrypted`
   * is preserved. Otherwise `clientSecretEncrypted` is written.
   */
  clientSecretEncrypted?: string;
  keepExistingSecret?: boolean;
  updatedBy: string;
}

/** A fully-defaulted view used when no row exists yet. */
export const DEFAULT_SSO_CONFIG: SsoConfigRow = {
  enabled: false,
  providerType: "oidc",
  providerDisplayName: "",
  loginWelcomeZh: "",
  loginWelcomeEn: "",
  issuerUrl: "",
  clientId: "",
  clientSecretEncrypted: "",
  redirectUri: "",
  groupMapping: {},
  autoCreateUsers: true,
  updatedAt: null,
  updatedBy: null,
};

export async function loadSsoConfig(db: PgDb): Promise<SsoConfigRow> {
  const rows = await db
    .select()
    .from(ssoConfig)
    .where(eq(ssoConfig.singletonId, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_SSO_CONFIG;
  // Defensive parse of provider_type / group_mapping in case of legacy rows.
  const providerType = SsoProviderTypeEnum.safeParse(row.providerType);
  const groupMapping = SsoGroupMappingSchema.safeParse(row.groupMapping ?? {});
  return {
    enabled: row.enabled !== 0,
    providerType: providerType.success ? providerType.data : "oidc",
    providerDisplayName: row.providerDisplayName,
    loginWelcomeZh: row.loginWelcomeZh,
    loginWelcomeEn: row.loginWelcomeEn,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    clientSecretEncrypted: row.clientSecretEncrypted,
    redirectUri: row.redirectUri,
    groupMapping: groupMapping.success ? groupMapping.data : {},
    autoCreateUsers: row.autoCreateUsers !== 0,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function saveSsoConfig(db: PgDb, partial: SsoConfigSavePartial): Promise<void> {
  const existing = await loadSsoConfig(db);
  const nextSecret = partial.keepExistingSecret
    ? existing.clientSecretEncrypted
    : (partial.clientSecretEncrypted ?? "");
  const providerDisplayName = partial.providerDisplayName ?? existing.providerDisplayName;
  const loginWelcomeZh = partial.loginWelcomeZh ?? existing.loginWelcomeZh;
  const loginWelcomeEn = partial.loginWelcomeEn ?? existing.loginWelcomeEn;
  const now = new Date();
  await db
    .insert(ssoConfig)
    .values({
      singletonId: SINGLETON_ID,
      enabled: partial.enabled ? 1 : 0,
      providerType: partial.providerType,
      providerDisplayName,
      loginWelcomeZh,
      loginWelcomeEn,
      issuerUrl: partial.issuerUrl,
      clientId: partial.clientId,
      clientSecretEncrypted: nextSecret,
      redirectUri: partial.redirectUri,
      groupMapping: partial.groupMapping,
      autoCreateUsers: partial.autoCreateUsers ? 1 : 0,
      updatedAt: now,
      updatedBy: partial.updatedBy,
    })
    .onConflictDoUpdate({
      target: ssoConfig.singletonId,
      set: {
        enabled: partial.enabled ? 1 : 0,
        providerType: partial.providerType,
        providerDisplayName,
        loginWelcomeZh,
        loginWelcomeEn,
        issuerUrl: partial.issuerUrl,
        clientId: partial.clientId,
        clientSecretEncrypted: nextSecret,
        redirectUri: partial.redirectUri,
        groupMapping: partial.groupMapping,
        autoCreateUsers: partial.autoCreateUsers ? 1 : 0,
        updatedAt: now,
        updatedBy: partial.updatedBy,
      },
    });
}
