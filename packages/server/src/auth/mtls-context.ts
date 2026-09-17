import { AsyncLocalStorage } from "node:async_hooks";

/**
 * per-request mTLS context propagation.
 *
 * The connectRPC bidirectional stream handler doesn't accept arbitrary
 * per-call context, so we use Node's AsyncLocalStorage to attach the
 * verified agentId from the mTLS layer (or the header guard, see
 * `mtls-wire.ts`) to the request scope. The agent-handler reads it inside
 * the bidi loop to pin the agentId on every register/heartbeat/jobStatus
 * message and reject mismatches.
 */
export interface MtlsContextStore {
  /** Verified agentId from the cert. Null when mTLS is disabled. */
  readonly agentId: string | null;
  readonly fingerprintSha256: string | null;
}

export const mtlsContext = new AsyncLocalStorage<MtlsContextStore>();

export function runWithMtlsContext<T>(store: MtlsContextStore, fn: () => Promise<T>): Promise<T> {
  return mtlsContext.run(store, fn);
}
