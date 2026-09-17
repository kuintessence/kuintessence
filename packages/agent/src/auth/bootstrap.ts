import type { CertBundle } from "./cert-store";
import { hasCert, loadCertBundle, persistCertBundle } from "./cert-store";
import { generateCsr } from "./csr";

/**
 * Agent enrollment bootstrap.
 *
 * Returns the cert bundle the connectRPC client needs. On a fresh deploy:
 *   1. generate keypair + CSR locally,
 *   2. POST CSR to the Server admin enrollment endpoint with `enrollmentToken`,
 *   3. persist the returned cert + the locally-generated key + the Server CA.
 *
 * On subsequent starts, just load the bundle off disk.
 *
 * The HTTP transport is injected via `EnrollmentClient` so the bootstrap
 * function stays testable without an HTTP server.
 */
export type EnrollmentClient = (input: {
  agentId: string;
  csrPem: string;
  enrollmentToken: string;
}) => Promise<{ certPem: string; caCertPem: string }>;

export interface EnsureCertBundleInput {
  readonly dir: string;
  readonly agentId: string;
  readonly enrollmentToken: string;
  readonly client: EnrollmentClient;
}

export async function ensureCertBundle(input: EnsureCertBundleInput): Promise<CertBundle> {
  if (hasCert(input.dir)) {
    return loadCertBundle(input.dir);
  }

  if (!input.enrollmentToken || input.enrollmentToken.trim() === "") {
    throw new Error(
      "no cert bundle on disk and AGENT_ENROLL_TOKEN is empty — cannot enroll with the Server",
    );
  }

  const { csrPem, privateKeyPem } = generateCsr({ agentId: input.agentId });
  // If the Server call fails, we deliberately do NOT touch the cert dir, so
  // the next Agent start cleanly retries enrollment with a fresh CSR.
  const issued = await input.client({
    agentId: input.agentId,
    csrPem,
    enrollmentToken: input.enrollmentToken,
  });

  const bundle: CertBundle = {
    certPem: issued.certPem,
    keyPem: privateKeyPem,
    caCertPem: issued.caCertPem,
  };
  await persistCertBundle(input.dir, bundle);
  return bundle;
}
