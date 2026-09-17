import { AppError, ErrorCode } from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";

/**
 * admin route for issuing & revoking Agent client certs.
 *
 * Server admin (platform_admin or super_admin) submits a CSR on behalf of (or
 * forwarded by) an Agent enrolling for the first time. The Server signs with
 * the local CA and ledgers the issuance in `agent_certs`. Returns the
 * signed cert plus the CA bundle so the Agent can pin the trust root.
 *
 * Out of scope for B3: enrollment-token gating (Agent-direct CSR flow with
 * AGENT_ENROLL_TOKEN), CRL distribution endpoint, OCSP responder, Web UI.
 */

const IssueCertBodySchema = z.object({
  csrPem: z.string().min(1, "csrPem is required"),
});

const RevokeCertBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export interface IssuedCertView {
  readonly certPem: string;
  readonly caCertPem: string;
  readonly fingerprintSha256: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface CertIssuanceService {
  listCerts(agentId: string): Promise<
    Array<{
      id: string;
      fingerprintSha256: string;
      subjectCn: string;
      issuedAt: Date;
      expiresAt: Date;
      revokedAt: Date | null;
      issuedBy: string | null;
    }>
  >;
  issueCert(input: { agentId: string; csrPem: string; issuedBy: string }): Promise<IssuedCertView>;
  revokeCert(input: {
    agentId: string;
    fingerprintSha256: string;
    revokedBy: string;
    reason?: string;
  }): Promise<void>;
}

export interface AdminAgentRouteOptions {
  authz?: AuthzService;
}

export function createAdminAgentRoutes(
  service: CertIssuanceService,
  options: AdminAgentRouteOptions = {},
): Hono {
  const r = new Hono();

  r.get("/admin/agents/:id/certs", async (c) => {
    await requirePlatformPermission(c, options.authz, "manage", "admin-agents");
    const agentId = c.req.param("id");
    if (!agentId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId path param required", 400);
    }
    const certs = await service.listCerts(agentId);
    return c.json({
      certs: certs.map((cert) => ({
        id: cert.id,
        fingerprintSha256: cert.fingerprintSha256,
        subjectCn: cert.subjectCn,
        issuedAt: cert.issuedAt.toISOString(),
        expiresAt: cert.expiresAt.toISOString(),
        revokedAt: cert.revokedAt?.toISOString() ?? null,
        issuedBy: cert.issuedBy,
      })),
    });
  });

  r.post("/admin/agents/:id/cert", async (c) => {
    await requirePlatformPermission(c, options.authz, "manage", "admin-agents");
    const agentId = c.req.param("id");
    if (!agentId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId path param required", 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid JSON body", 400);
    }
    const parsed = IssueCertBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }

    const issuedBy = requireCanonicalAdminActor(c);
    let issued: IssuedCertView;
    try {
      issued = await service.issueCert({
        agentId,
        csrPem: parsed.data.csrPem,
        issuedBy,
      });
    } catch (err) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        err instanceof Error ? err.message : "CSR signing failed",
        400,
      );
    }

    return c.json(
      {
        success: true,
        certPem: issued.certPem,
        caCertPem: issued.caCertPem,
        fingerprintSha256: issued.fingerprintSha256,
        issuedAt: issued.issuedAt.toISOString(),
        expiresAt: issued.expiresAt.toISOString(),
      },
      201,
    );
  });

  r.delete("/admin/agents/:id/cert/:fingerprint", async (c) => {
    await requirePlatformPermission(c, options.authz, "manage", "admin-agents");
    const agentId = c.req.param("id");
    const fingerprint = c.req.param("fingerprint");
    if (!agentId || !fingerprint) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId and fingerprint required", 400);
    }
    const revokedBy = requireCanonicalAdminActor(c);
    await service.revokeCert({
      agentId,
      fingerprintSha256: fingerprint,
      revokedBy,
    });
    return c.body(null, 204);
  });

  r.post("/admin/agents/:id/cert/:fingerprint/revoke", async (c) => {
    await requirePlatformPermission(c, options.authz, "manage", "admin-agents");
    const agentId = c.req.param("id");
    const fingerprint = c.req.param("fingerprint");
    if (!agentId || !fingerprint) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "agentId and fingerprint required", 400);
    }
    const parsed = RevokeCertBodySchema.safeParse(await readOptionalJson(c));
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }
    await service.revokeCert({
      agentId,
      fingerprintSha256: fingerprint,
      revokedBy: requireCanonicalAdminActor(c),
      reason: parsed.data.reason,
    });
    return c.json({ success: true });
  });

  return r;
}

async function readOptionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid JSON body", 400);
  }
}

function requireCanonicalAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}
