import type { PgDb } from "@kuintessence/db";
import { SsoGroupMappingSchema } from "@kuintessence/shared";
import type { Logger } from "pino";
import { encryptSecret } from "./secret-cipher";
import { loadSsoConfig, saveSsoConfig } from "./sso-config-store";

export interface SsoBootstrapOptions {
  enabled: boolean;
  force: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  groupMappingJson: string;
  autoCreateUsers: boolean;
  secretWrappingKey: string;
  logger?: Logger;
}

export async function bootstrapSsoConfig(db: PgDb, options: SsoBootstrapOptions): Promise<void> {
  if (!options.enabled) return;
  if (options.issuerUrl.length === 0 || options.clientId.length === 0) {
    throw new Error("SSO bootstrap requires issuer URL and client ID");
  }

  const current = await loadSsoConfig(db);
  const hasExistingConfig =
    current.enabled || current.issuerUrl.length > 0 || current.clientId.length > 0;
  if (hasExistingConfig && !options.force) {
    options.logger?.info(
      { issuerUrl: current.issuerUrl, clientId: current.clientId },
      "SSO bootstrap skipped because sso_config is already configured",
    );
    return;
  }

  const parsedMapping = SsoGroupMappingSchema.safeParse(JSON.parse(options.groupMappingJson));
  if (!parsedMapping.success) {
    throw new Error(`Invalid SSO bootstrap group mapping: ${parsedMapping.error.message}`);
  }

  const clientSecretEncrypted =
    options.clientSecret.length > 0
      ? await encryptSecret(options.clientSecret, options.secretWrappingKey)
      : "";

  await saveSsoConfig(db, {
    enabled: true,
    providerType: "oidc",
    issuerUrl: options.issuerUrl,
    clientId: options.clientId,
    clientSecretEncrypted,
    keepExistingSecret: false,
    redirectUri: options.redirectUri,
    groupMapping: parsedMapping.data,
    autoCreateUsers: options.autoCreateUsers,
    updatedBy: "sso-bootstrap",
  });
  options.logger?.info(
    { issuerUrl: options.issuerUrl, clientId: options.clientId },
    "SSO configuration bootstrapped",
  );
}
