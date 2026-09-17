/**
 * OIDC client facade (PRD F1.1 / F1.3).
 *
 * Wraps `openid-client` v6 for the three things the Server actually needs:
 *
 *   1. discover()         — fetch provider metadata (cached per issuer+clientId)
 *   2. buildAuthUrl()     — produce an authorization URL with PKCE+state
 *   3. completeCallback() — exchange code, fetch userinfo, extract group claims
 *
 * The discovery cache is process-local and keyed by `(issuerUrl, clientId)`
 * so a config rotation invalidates the cached `Configuration` automatically
 * when the new config writes new values. Tests can swap the underlying
 * client via `setOidcClientImplForTesting` so HTTP traffic is not required.
 *
 * Group-claim extraction tolerates a few common shapes:
 *   - array of strings (Keycloak default `groups` claim)
 *   - space- or comma-separated string
 *   - missing claim → "no groups", role defaults to `user`
 *
 * Refresh tokens, single sign-out, and SAML/LDAP are explicitly out of
 * scope for this OIDC client.
 */

import { type RoleName, resolveRoleFromGroups, type SsoGroupMapping } from "@kuintessence/shared";
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretPost,
  type Configuration,
  calculatePKCECodeChallenge,
  type DiscoveryRequestOptions,
  discovery,
  fetchUserInfo,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";

export interface DiscoveredEndpoints {
  issuer: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
}

/**
 * Minimal client interface so tests can mock the openid-client runtime
 * without standing up an HTTP server.
 */
export interface OidcClientImpl {
  discover(input: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    allowInsecureIssuer?: boolean;
  }): Promise<{
    config: Configuration;
    endpoints: DiscoveredEndpoints;
  }>;
  buildAuthUrl(
    config: Configuration,
    params: {
      redirectUri: string;
      scope: string;
      state: string;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      nonce?: string;
    },
  ): URL;
  exchangeCode(
    config: Configuration,
    currentUrl: URL,
    expectedState: string,
    codeVerifier: string,
  ): Promise<{
    accessToken: string;
    idToken: string | null;
    sub: string | null;
    claims?: Record<string, unknown>;
  }>;
  fetchUserInfo(config: Configuration, accessToken: string, sub: string): Promise<UserInfoLite>;
}

/** Lightweight subset of `UserInfoResponse` that the callback actually uses. */
export interface UserInfoLite {
  sub: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  preferredUsername: string | null;
  /** Whatever shape the IdP returned (we normalize with `extractGroups`). */
  rawGroups: unknown;
}

let impl: OidcClientImpl = createDefaultImpl();
const cache = new Map<string, Configuration>();

function cacheKey(issuerUrl: string, clientId: string): string {
  return `${issuerUrl}::${clientId}`;
}

function createDefaultImpl(): OidcClientImpl {
  return {
    async discover({ issuerUrl, clientId, clientSecret, allowInsecureIssuer }) {
      const discoveryOptions: DiscoveryRequestOptions | undefined = allowInsecureIssuer
        ? { execute: [allowInsecureRequests] }
        : undefined;
      const config = await discovery(
        new URL(issuerUrl),
        clientId,
        undefined,
        clientSecret ? ClientSecretPost(clientSecret) : undefined,
        discoveryOptions,
      );
      const meta = config.serverMetadata();
      return {
        config,
        endpoints: {
          issuer: meta.issuer,
          authorizationEndpoint: meta.authorization_endpoint ?? null,
          tokenEndpoint: meta.token_endpoint ?? null,
          userinfoEndpoint: meta.userinfo_endpoint ?? null,
          jwksUri: meta.jwks_uri ?? null,
        },
      };
    },
    buildAuthUrl(config, params) {
      return buildAuthorizationUrl(config, {
        redirect_uri: params.redirectUri,
        scope: params.scope,
        state: params.state,
        code_challenge: params.codeChallenge,
        code_challenge_method: params.codeChallengeMethod,
        ...(params.nonce ? { nonce: params.nonce } : {}),
      });
    },
    async exchangeCode(config, currentUrl, expectedState, codeVerifier) {
      const tokens = await authorizationCodeGrant(config, currentUrl, {
        expectedState,
        pkceCodeVerifier: codeVerifier,
      });
      const claims = tokens.claims();
      return {
        accessToken: tokens.access_token,
        idToken: tokens.id_token ?? null,
        sub: claims?.sub ?? null,
        claims: claims ? { ...claims } : undefined,
      };
    },
    async fetchUserInfo(config, accessToken, sub) {
      const info = await fetchUserInfo(config, accessToken, sub);
      const get = (k: string) => {
        const v = (info as Record<string, unknown>)[k];
        return typeof v === "string" ? v : null;
      };
      const verified = (info as Record<string, unknown>).email_verified;
      return {
        sub: info.sub,
        email: get("email"),
        emailVerified: typeof verified === "boolean" ? verified : null,
        name: get("name"),
        preferredUsername: get("preferred_username"),
        rawGroups: (info as Record<string, unknown>).groups,
      };
    },
  };
}

/** Test seam: swap the backing client. Restore via `resetOidcClientImpl()`. */
export function setOidcClientImplForTesting(next: OidcClientImpl): void {
  impl = next;
  cache.clear();
}

export function resetOidcClientImpl(): void {
  impl = createDefaultImpl();
  cache.clear();
}

/**
 * Pure helper. Exposed for tests + reused by `completeOidcCallback`.
 */
export function extractGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === "string");
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
  }
  return [];
}

function stringClaim(claims: Record<string, unknown> | undefined, key: string): string | null {
  const value = claims?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanClaim(claims: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = claims?.[key];
  return typeof value === "boolean" ? value : null;
}

export interface DiscoverOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  allowInsecureIssuer?: boolean;
  /** When true, force a re-discover (bypasses the cache). */
  force?: boolean;
}

export interface DiscoverResult {
  config: Configuration;
  endpoints: DiscoveredEndpoints;
}

export async function discoverOidc(opts: DiscoverOptions): Promise<DiscoverResult> {
  const key = cacheKey(opts.issuerUrl, opts.clientId);
  if (!opts.force) {
    const cached = cache.get(key);
    if (cached) {
      const meta = cached.serverMetadata();
      return {
        config: cached,
        endpoints: {
          issuer: meta.issuer,
          authorizationEndpoint: meta.authorization_endpoint ?? null,
          tokenEndpoint: meta.token_endpoint ?? null,
          userinfoEndpoint: meta.userinfo_endpoint ?? null,
          jwksUri: meta.jwks_uri ?? null,
        },
      };
    }
  }
  const result = await impl.discover(opts);
  cache.set(key, result.config);
  return result;
}

export interface BuildAuthUrlOptions {
  redirectUri: string;
  scope?: string;
}

export interface BuildAuthUrlResult {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function buildOidcAuthUrl(
  config: Configuration,
  opts: BuildAuthUrlOptions,
): Promise<BuildAuthUrlResult> {
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = randomState();
  const url = impl.buildAuthUrl(config, {
    redirectUri: opts.redirectUri,
    scope: opts.scope ?? "openid profile email groups",
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
  });
  return { url: url.toString(), state, codeVerifier };
}

export interface CompleteCallbackOptions {
  config: Configuration;
  callbackUrl: URL;
  expectedState: string;
  codeVerifier: string;
  groupMapping: SsoGroupMapping;
}

export interface CompleteCallbackResult {
  /** Subject claim from the ID token (stable opaque IdP ID). */
  sub: string;
  email: string | null;
  emailVerified: boolean | null;
  displayName: string | null;
  groups: string[];
  resolvedRole: RoleName;
}

export async function completeOidcCallback(
  opts: CompleteCallbackOptions,
): Promise<CompleteCallbackResult> {
  const exchanged = await impl.exchangeCode(
    opts.config,
    opts.callbackUrl,
    opts.expectedState,
    opts.codeVerifier,
  );
  if (!exchanged.sub) {
    throw new Error("OIDC token exchange returned no subject claim");
  }
  const userinfo = await impl.fetchUserInfo(opts.config, exchanged.accessToken, exchanged.sub);
  const userinfoGroups = extractGroups(userinfo.rawGroups);
  const tokenGroups = extractGroups(exchanged.claims?.groups);
  const groups = userinfoGroups.length > 0 ? userinfoGroups : tokenGroups;
  const resolvedRole = resolveRoleFromGroups(groups, opts.groupMapping);
  return {
    sub: userinfo.sub,
    email: userinfo.email ?? stringClaim(exchanged.claims, "email"),
    emailVerified: userinfo.emailVerified ?? booleanClaim(exchanged.claims, "email_verified"),
    displayName:
      userinfo.name ??
      userinfo.preferredUsername ??
      stringClaim(exchanged.claims, "name") ??
      stringClaim(exchanged.claims, "preferred_username"),
    groups,
    resolvedRole,
  };
}

/**
 * Helper for the dev-mode case where the IdP uses http:// (e.g. a local
 * Keycloak in a Docker network). openid-client v6 requires HTTPS by
 * default; the Server flips this only when `NODE_ENV !== 'production'`.
 *
 * Defensive: when the implementation has been swapped via
 * `setOidcClientImplForTesting()` the `Configuration` is a stub and the
 * underlying `allowInsecureRequests()` will throw on the missing internal
 * symbol. We swallow that case so route tests can still flip the flag
 * without standing up the real openid-client runtime.
 */
export function relaxInsecureForTesting(config: Configuration): void {
  try {
    allowInsecureRequests(config);
  } catch {
    // stub Configuration — no-op
  }
}
