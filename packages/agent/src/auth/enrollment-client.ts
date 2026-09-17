import type { EnrollmentClient } from "./bootstrap";

/**
 * HTTP-backed enrollment client.
 *
 * Calls `POST /admin/agents/:agentId/cert` on the Server with a Bearer token
 * (the AGENT_ENROLL_TOKEN). The Server admin route is platform_admin-gated;
 * the enrollment token is an admin JWT provisioned out-of-band by site ops.
 * This client does not issue a dedicated short-lived enrollment grant.
 *
 * `fetchImpl` is injectable so tests don't need an HTTP server. Production
 * callers pass `globalThis.fetch`.
 */
export interface CreateHttpEnrollmentClientInput {
  readonly serverBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

interface CertEnvelope {
  success?: boolean;
  certPem?: string;
  caCertPem?: string;
  error?: { code: string; message: string };
}

export function createHttpEnrollmentClient(
  input: CreateHttpEnrollmentClientInput,
): EnrollmentClient {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const base = input.serverBaseUrl.replace(/\/+$/, "");

  return async ({ agentId, csrPem, enrollmentToken }) => {
    const url = `${base}/admin/agents/${encodeURIComponent(agentId)}/cert`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${enrollmentToken}`,
      },
      body: JSON.stringify({ csrPem }),
    });

    let body: CertEnvelope;
    try {
      body = (await res.json()) as CertEnvelope;
    } catch (err) {
      throw new Error(
        `Server enrollment response was not JSON (status ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `Server enrollment failed (status ${res.status}): ${body.error?.message ?? "unknown error"}`,
      );
    }
    if (!body.certPem || !body.caCertPem) {
      throw new Error(
        `Server enrollment response missing certPem or caCertPem (status ${res.status})`,
      );
    }
    return { certPem: body.certPem, caCertPem: body.caCertPem };
  };
}
