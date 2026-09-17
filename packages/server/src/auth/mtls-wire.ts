import type { AgentCertLookup } from "../middleware/mtls";

/**
 * fingerprint-ledger guard shared by the HTTP/2 Agent endpoint
 * and the legacy Bun TLS test seam.
 *
 * Bun's `node:https` does not currently expose the verified peer cert per
 * request, which prevents the textbook mTLS server pattern (parse peer
 * cert -> map fingerprint -> lookup agentId) from working under Bun.
 * The trust check is split across two layers:
 *
 *   1. **TLS handshake** — the production Node HTTP/2 server enforces
 *      `requestCert: true` + `rejectUnauthorized: true` against the Server
 *      CA. Any client without a chain-valid cert is dropped before the
 *      fetch handler runs. This is the strong guarantee.
 *   2. **Fingerprint ledger guard (`mtlsHeaderGuard`)** — direct mode derives
 *      the fingerprint from Node's verified TLS peer certificate and overwrites
 *      the request header before this guard runs. Trusted-proxy mode accepts the
 *      fingerprint header only after the HTTP/2 source address matches the
 *      configured proxy CIDRs. The Server looks the fingerprint
 *      up in `agent_certs`, rejecting unknown / revoked entries and
 *      mapping the rest to a verified `agentId`.
 *
 * When Bun ships per-request peer cert access, this can collapse back to
 * a single `createMtlsVerifier(peerCertPem)` call. Tracked as B3 follow-up.
 *
 * The `mtlsHeaderGuard` accepts an `enabled` flag so dev environments can
 * keep plain HTTP/2 connectRPC working without TLS, matching the
 * `MTLS_REQUIRED=false` config story.
 */

export interface BuildMtlsTlsOptionsInput {
  readonly caCertPem: string;
  readonly serverCertPem: string;
  readonly serverKeyPem: string;
}

export interface BunMtlsTlsOptions {
  readonly cert: string;
  readonly key: string;
  readonly ca: string;
  readonly requestCert: true;
  readonly rejectUnauthorized: true;
}

export function buildMtlsTlsOptions(input: BuildMtlsTlsOptionsInput): BunMtlsTlsOptions {
  return {
    cert: input.serverCertPem,
    key: input.serverKeyPem,
    ca: input.caCertPem,
    requestCert: true,
    rejectUnauthorized: true,
  };
}

export type MtlsHeaderVerdict =
  | {
      readonly ok: true;
      /** null when mTLS is disabled (dev mode passthrough). */
      readonly agentId: string | null;
      readonly fingerprintSha256: string | null;
    }
  | { readonly ok: false; readonly response: Response };

const FINGERPRINT_HEADER = "x-agent-cert-fingerprint";
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export interface MtlsHeaderGuardConfig {
  readonly lookup: AgentCertLookup;
  readonly enabled: boolean;
  readonly fingerprintHeader?: string;
}

export type MtlsHeaderGuard = (req: Request) => Promise<MtlsHeaderVerdict>;

export function mtlsHeaderGuard(config: MtlsHeaderGuardConfig): MtlsHeaderGuard {
  return async (req: Request): Promise<MtlsHeaderVerdict> => {
    if (!config.enabled) {
      return { ok: true, agentId: null, fingerprintSha256: null };
    }

    const header = config.fingerprintHeader ?? FINGERPRINT_HEADER;
    const fp = req.headers.get(header)?.trim().toLowerCase();
    if (!fp) {
      return { ok: false, response: rejection("missing X-Agent-Cert-Fingerprint header") };
    }
    if (!FINGERPRINT_RE.test(fp)) {
      return { ok: false, response: rejection("malformed fingerprint header") };
    }

    const row = await config.lookup(fp);
    if (!row) {
      return { ok: false, response: rejection("unknown client cert: not in agent_certs ledger") };
    }
    if (row.revokedAt) {
      return {
        ok: false,
        response: rejection(`client cert revoked at ${row.revokedAt.toISOString()}`),
      };
    }
    return { ok: true, agentId: row.agentId, fingerprintSha256: fp };
  };
}

function rejection(message: string): Response {
  return new Response(JSON.stringify({ error: { code: "MTLS_REJECTED", message } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
