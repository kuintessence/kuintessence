import { runWithMtlsContext } from "./mtls-context";
import { type MtlsHeaderGuardConfig, mtlsHeaderGuard } from "./mtls-wire";

/**
 * wrap a fetch-style handler with the mTLS header guard.
 *
 * Used by the Server gRPC bootstrap to inject the verified agentId into the
 * request scope so the agent-handler can pin every message in the bidi
 * stream to the cert-bound identity.
 */
export function wrapWithMtls(
  inner: (req: Request) => Promise<Response>,
  config: MtlsHeaderGuardConfig,
): (req: Request) => Promise<Response> {
  const guard = mtlsHeaderGuard(config);
  return async function mtlsWrapped(req: Request): Promise<Response> {
    const verdict = await guard(req);
    if (!verdict.ok) return verdict.response;
    return runWithMtlsContext(
      {
        agentId: verdict.agentId,
        fingerprintSha256: verdict.fingerprintSha256,
      },
      () => inner(req),
    );
  };
}
