/**
 * CP-admin SSH credential vault endpoints (PRD F17).
 *
 * Gated through ownership: platform-wide admins can manage every credential;
 * provider org admins can manage credentials for agents their org owns.
 *
 *   GET    /api/admin/ssh-credentials          — list agents, NO secrets
 *   PUT    /api/admin/ssh-credentials/:agentId — set/rotate; encrypts at rest
 *   DELETE /api/admin/ssh-credentials/:agentId — remove
 *
 * The auth material is encrypted via `secret-cipher` (the `kq-ssh-cred-v1`
 * domain) inside `saveSshCredential` before it touches the row, and is never
 * written to the audit log — the diff records only host/port/username and
 * whether a secret was supplied.
 */
import type { PgDb } from "@kuintessence/db";
import {
  AppError,
  authorizeResourceAccess,
  ErrorCode,
  SshCredentialUpsertSchema,
} from "@kuintessence/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  type AgentProviderOrgResolver,
  agentResourceFromProviderOrg,
  createAgentProviderOrgResolver,
  isPlatformPrincipal,
  ownershipPrincipalFromContext,
} from "../auth/ownership";
import {
  deleteSshCredential,
  listSshCredentials,
  listSshCredentialsByAgentIds,
  saveSshCredential,
} from "../auth/ssh-credential-store";
import { sshCredentialAgentTuple, sshCredentialPlatformTuple } from "../authz/projection";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { assertRole } from "../middleware/rbac";
import { kqValidator } from "../middleware/validator";
import { writeAudit } from "../services/audit-log-writer";

export interface AdminSshCredentialRouteOptions {
  /** Wrapping key for secret-cipher. MUST be ≥32 chars. */
  secretWrappingKey: string;
  resolveAgentProviderOrg?: AgentProviderOrgResolver;
  authz?: AuthzService;
}

export function createAdminSshCredentialRoutes(
  db: PgDb,
  opts: AdminSshCredentialRouteOptions,
): Hono {
  if (opts.secretWrappingKey.length < 32) {
    throw new Error("secretWrappingKey must be at least 32 chars");
  }
  const r = new Hono();
  const resolveAgentProviderOrg =
    opts.resolveAgentProviderOrg ?? createAgentProviderOrgResolver(db);

  async function credentialLocalAllowed(c: Context, agentId: string, action: "read" | "manage") {
    const resource = agentResourceFromProviderOrg(
      agentId,
      "ssh_credential",
      await resolveAgentProviderOrg(agentId),
    );
    if (!resource) throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    return authorizeResourceAccess(ownershipPrincipalFromContext(c), resource, action).allowed;
  }

  r.get("/admin/ssh-credentials", async (c) => {
    assertLocalAdminSurface(c, opts.authz);
    const actorUserId = requireCanonicalSshCredentialAdminActor(c);
    if (opts.authz?.mode === "enforce") {
      const visibleIds = await lookupSshCredentialIds(opts.authz, actorUserId);
      return c.json({ credentials: await listSshCredentialsByAgentIds(db, visibleIds) });
    }
    const credentials = await listSshCredentials(db);
    const visible: typeof credentials = [];
    for (const credential of credentials) {
      const resource = agentResourceFromProviderOrg(
        credential.agentId,
        "ssh_credential",
        await resolveAgentProviderOrg(credential.agentId),
      );
      if (!resource) continue;
      const localAllowed = authorizeResourceAccess(
        ownershipPrincipalFromContext(c),
        resource,
        "read",
      ).allowed;
      if (
        await checkSshCredentialPermission(c, opts.authz, credential.agentId, "view", localAllowed)
      ) {
        visible.push(credential);
      }
    }
    return c.json({ credentials: visible });
  });

  r.put(
    "/admin/ssh-credentials/:agentId",
    kqValidator("json", SshCredentialUpsertSchema, "Invalid SSH credential body"),
    async (c) => {
      assertLocalAdminSurface(c, opts.authz);
      const actorUserId = requireCanonicalSshCredentialAdminActor(c);
      const agentId = c.req.param("agentId");
      if (!agentId) throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing agentId", 400);
      const localAllowed = await credentialLocalAllowed(c, agentId, "manage");
      await requireSshCredentialPermission(c, opts.authz, agentId, "manage", localAllowed);
      const input = c.req.valid("json");

      await saveSshCredential(db, opts.secretWrappingKey, {
        agentId,
        host: input.host,
        port: input.port,
        username: input.username,
        secret: {
          password: input.password,
          privateKey: input.privateKey,
          passphrase: input.passphrase,
        },
        hostKeySha256: input.hostKeySha256,
        updatedBy: actorUserId,
      });
      await opts.authz?.enqueueMany([
        sshCredentialAgentTuple(agentId),
        sshCredentialPlatformTuple(agentId),
      ]);

      await writeAudit(db, {
        actor: actorUserId,
        action: "ssh.credential.update",
        target: `agent:${agentId}`,
        diff: {
          after: {
            host: input.host,
            port: input.port,
            username: input.username,
            // Never log the secret; record only that one was supplied.
            secretSupplied: Boolean(input.password || input.privateKey),
          },
        },
      });

      return c.json({ ok: true }, 200);
    },
  );

  r.delete("/admin/ssh-credentials/:agentId", async (c) => {
    assertLocalAdminSurface(c, opts.authz);
    const actorUserId = requireCanonicalSshCredentialAdminActor(c);
    const agentId = c.req.param("agentId");
    if (!agentId) throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing agentId", 400);
    const localAllowed = await credentialLocalAllowed(c, agentId, "manage");
    await requireSshCredentialPermission(c, opts.authz, agentId, "manage", localAllowed);

    await deleteSshCredential(db, agentId);
    await opts.authz?.enqueueMany([
      { ...sshCredentialAgentTuple(agentId), operation: "delete" },
      { ...sshCredentialPlatformTuple(agentId), operation: "delete" },
    ]);
    await writeAudit(db, {
      actor: actorUserId,
      action: "ssh.credential.delete",
      target: `agent:${agentId}`,
      diff: { after: { deleted: true } },
    });
    return c.json({ ok: true }, 200);
  });

  return r;
}

async function lookupSshCredentialIds(authz: AuthzService, actorUserId: string): Promise<string[]> {
  try {
    return await authz.lookupResources({
      resourceType: "ssh_credential",
      permission: "view",
      subject: { type: "user", id: actorUserId },
    });
  } catch (err) {
    throw authorizationUnavailable(err);
  }
}

function authorizationUnavailable(err: unknown): AppError {
  return new AppError(
    ErrorCode.FORBIDDEN,
    `Authorization unavailable: ${err instanceof Error ? err.message : String(err)}`,
    403,
  );
}

function requireCanonicalSshCredentialAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

function assertLocalAdminSurface(c: Context, authz: AuthzService | undefined): void {
  if (authz?.mode === "enforce") return;
  assertRole(c, "org_admin");
}

async function requireSshCredentialPermission(
  c: Context,
  authz: AuthzService | undefined,
  agentId: string,
  permission: "view" | "manage",
  localAllowed: boolean,
): Promise<void> {
  if (authz?.mode !== "enforce" && !localAllowed) {
    throw new AppError(ErrorCode.NOT_FOUND, "Resource not found", 404);
  }
  if (!(await checkSshCredentialPermission(c, authz, agentId, permission, localAllowed))) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
  }
}

async function checkSshCredentialPermission(
  c: Context,
  authz: AuthzService | undefined,
  agentId: string,
  permission: "view" | "manage",
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const subjectId = principal?.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const resourceType = permission === "manage" ? "agent" : "ssh_credential";
  const check = {
    actorUserId: subjectId,
    actorEmail: principal.email,
    resource: { type: resourceType, id: agentId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { route: `${resourceType}#${permission}` },
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, isPlatformPrincipal(c));
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}
