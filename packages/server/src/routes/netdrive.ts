import { auditLog, type PgDb } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  hasRole,
  NetDriveCommitRequestSchema,
  NetDriveListPartsRequestSchema,
  NetDriveListQuerySchema,
  NetDriveMultipartAbortRequestSchema,
  NetDriveMultipartCompleteRequestSchema,
  NetDriveMultipartInitRequestSchema,
  NetDrivePartUrlsRequestSchema,
  NetDriveUploadUrlRequestSchema,
  type RoleName,
} from "@kuintessence/shared";
import { type Context, Hono } from "hono";
import { netdriveFileTuples, netdriveOwnerTuple } from "../authz/projection";
import type { AuthzCheck, AuthzService, AuthzTuple } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { NetDriveCommitResult, NetDriveService } from "../services/netdrive";

interface NetDriveActor {
  ownerId: string;
  orgId: string | null;
}

export function netDriveActorFromPrincipal(principal: BoundPrincipal | undefined): NetDriveActor {
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return {
    ownerId: principal.userId,
    orgId: principal.orgId ?? null,
  };
}

function requireNetDriveActor(c: Context): NetDriveActor {
  return netDriveActorFromPrincipal(c.get("principal" as never) as BoundPrincipal | undefined);
}

/**
 * NetDrive REST surface (PRD F18).
 *
 * Endpoints (all require auth via the parent `authMiddleware`):
 *  - POST   /api/netdrive/upload-url       presigned PUT URL + commit token
 *  - POST   /api/netdrive/files            commit metadata after client uploads
 *  - GET    /api/netdrive/files            list owner-scoped files (paginated)
 *  - GET    /api/netdrive/files/:id        single file metadata
 *  - GET    /api/netdrive/files/:id/download-url   presigned GET URL
 *  - DELETE /api/netdrive/files/:id        soft-delete + best-effort blob delete
 *
 * RBAC: any authenticated user manipulates their own files. `platform_admin`
 * and above can act on any user's file by passing `?asOwner=<userId>` on the
 * GET-style routes. The mutation routes always use the JWT subject as owner
 * and do not support writing on another user's behalf.
 *
 * Audit log: writes (`upload-url`, `files` commit, `delete`) emit one row
 * keyed by canonical Server `users.id` + `target` (file id or storage key).
 */
export interface NetDriveRoutesDeps {
  db: PgDb;
  service: NetDriveService;
  authz?: AuthzService;
}

export function createNetDriveRoutes(deps: NetDriveRoutesDeps): Hono {
  const r = new Hono();
  const { db, service } = deps;

  r.post(
    "/netdrive/upload-url",
    kqValidator("json", NetDriveUploadUrlRequestSchema, "Invalid upload-url body"),
    async (c) => {
      const body = c.req.valid("json");
      const actor = requireNetDriveActor(c);
      const ownerId = actor.ownerId;
      const minted = await service.mintUploadUrl(ownerId, body);
      await db.insert(auditLog).values({
        actor: actor.ownerId,
        orgId: actor.orgId,
        action: "netdrive.upload-url.mint",
        target: minted.storageKey,
        diff: { after: { path: body.path, size: body.size } },
      });
      return c.json({ success: true, data: minted });
    },
  );

  r.post(
    "/netdrive/uploads/multipart",
    kqValidator("json", NetDriveMultipartInitRequestSchema, "Invalid multipart init body"),
    async (c) => {
      const body = c.req.valid("json");
      const actor = requireNetDriveActor(c);
      const ownerId = actor.ownerId;
      const res = await service.initiateMultipart(ownerId, body);
      await db.insert(auditLog).values({
        actor: actor.ownerId,
        orgId: actor.orgId,
        action: "netdrive.multipart.init",
        target: res.storageKey,
        diff: { after: { path: body.path, size: body.size, uploadId: res.uploadId } },
      });
      return c.json({ success: true, data: res });
    },
  );

  r.post(
    "/netdrive/uploads/multipart/part-urls",
    kqValidator("json", NetDrivePartUrlsRequestSchema, "Invalid part-urls body"),
    async (c) => {
      const body = c.req.valid("json");
      const ownerId = requireNetDriveActor(c).ownerId;
      const res = await service.mintPartUrls(ownerId, body);
      return c.json({ success: true, data: res });
    },
  );

  r.post(
    "/netdrive/uploads/multipart/list-parts",
    kqValidator("json", NetDriveListPartsRequestSchema, "Invalid list-parts body"),
    async (c) => {
      const body = c.req.valid("json");
      const ownerId = requireNetDriveActor(c).ownerId;
      const res = await service.listUploadParts(ownerId, body);
      return c.json({ success: true, data: res });
    },
  );

  r.post(
    "/netdrive/uploads/multipart/complete",
    kqValidator("json", NetDriveMultipartCompleteRequestSchema, "Invalid multipart complete body"),
    async (c) => {
      const body = c.req.valid("json");
      const actor = requireNetDriveActor(c);
      const ownerId = actor.ownerId;
      const commit = await service.completeMultipartWithReplacements(ownerId, body);
      const file = commit.file;
      await enqueueNetDriveCommitAuthorization(deps.authz, commit, ownerId, actor.orgId);
      await db.insert(auditLog).values({
        actor: actor.ownerId,
        orgId: actor.orgId,
        action: "netdrive.multipart.complete",
        target: file.id,
        diff: { after: { path: file.path, size: file.size, sha256: file.sha256 } },
      });
      return c.json({ success: true, data: file }, 201);
    },
  );

  r.delete(
    "/netdrive/uploads/multipart",
    kqValidator("json", NetDriveMultipartAbortRequestSchema, "Invalid multipart abort body"),
    async (c) => {
      const body = c.req.valid("json");
      const actor = requireNetDriveActor(c);
      const ownerId = actor.ownerId;
      await service.abortMultipart(ownerId, body);
      await db.insert(auditLog).values({
        actor: actor.ownerId,
        orgId: actor.orgId,
        action: "netdrive.multipart.abort",
        target: body.storageKey,
        diff: { before: { uploadId: body.uploadId } },
      });
      return c.json({ success: true, data: { aborted: true } });
    },
  );

  r.post(
    "/netdrive/files",
    kqValidator("json", NetDriveCommitRequestSchema, "Invalid commit body"),
    async (c) => {
      const body = c.req.valid("json");
      const actor = requireNetDriveActor(c);
      const ownerId = actor.ownerId;
      const commit = await service.commitFileWithReplacements(ownerId, body);
      const file = commit.file;
      await enqueueNetDriveCommitAuthorization(deps.authz, commit, ownerId, actor.orgId);
      await db.insert(auditLog).values({
        actor: actor.ownerId,
        orgId: actor.orgId,
        action: "netdrive.file.commit",
        target: file.id,
        diff: { after: { path: file.path, size: file.size, sha256: file.sha256 } },
      });
      return c.json({ success: true, data: file }, 201);
    },
  );

  r.get("/netdrive/files", async (c) => {
    const parsed = NetDriveListQuerySchema.safeParse({
      prefix: c.req.query("prefix"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
      );
    }
    const { prefix, limit, offset } = parsed.data;
    const callerOwnerId = requireNetDriveActor(c).ownerId;
    if (deps.authz?.mode === "enforce") {
      const pendingOwnerIds = await deps.authz.lookupPendingRelationshipResources({
        operation: "create",
        resourceType: "netdrive_file",
        relation: "owner",
        subject: { type: "user", id: callerOwnerId },
      });
      const visibleIds = await deps.authz.lookupResources({
        resourceType: "netdrive_file",
        permission: "view",
        subject: { type: "user", id: callerOwnerId },
      });
      const authorizedIds = [...new Set([...visibleIds, ...pendingOwnerIds])];
      const { files, total } = await service.listFilesByIds(authorizedIds, {
        prefix,
        limit,
        offset,
      });
      const canUse = await resolveNetDriveUseCapabilities(c, deps.authz, callerOwnerId, files);
      return c.json({
        success: true,
        data: {
          files: files.map((file) => ({
            ...file,
            canUse: canUse.get(file.id) === true,
            canDelete: file.ownerId === callerOwnerId,
          })),
          total,
          limit,
          offset,
        },
      });
    }
    const ownerId = resolveOwnerOverride(c, callerOwnerId);
    const { files, total } = await service.listFiles(ownerId, { prefix, limit, offset });
    for (const file of files) {
      await authorizeNetDriveThroughSpice(c, deps.authz, callerOwnerId, file.id, "view", true);
    }
    return c.json({
      success: true,
      data: {
        files: files.map((file) => ({
          ...file,
          canUse: file.ownerId === callerOwnerId,
          canDelete: file.ownerId === callerOwnerId,
        })),
        total,
        limit,
        offset,
      },
    });
  });

  r.get("/netdrive/files/:id", async (c) => {
    const callerOwnerId = requireNetDriveActor(c).ownerId;
    if (deps.authz?.mode === "enforce") {
      const file = await service.getFileById(c.req.param("id"));
      if (!file) {
        throw new AppError(ErrorCode.NOT_FOUND, "NetDrive file not found", 404);
      }
      const allowed = await authorizeNetDriveThroughSpice(
        c,
        deps.authz,
        callerOwnerId,
        file.id,
        "view",
        file.ownerId === callerOwnerId,
      );
      if (!allowed) {
        throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view this NetDrive file", 403);
      }
      return c.json({ success: true, data: file });
    }
    const ownerId = resolveOwnerOverride(c, callerOwnerId);
    const file = await service.getFile(ownerId, c.req.param("id"));
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, "NetDrive file not found", 404);
    }
    await authorizeNetDriveThroughSpice(c, deps.authz, callerOwnerId, file.id, "view", true);
    return c.json({ success: true, data: file });
  });

  r.get("/netdrive/files/:id/download-url", async (c) => {
    const callerOwnerId = requireNetDriveActor(c).ownerId;
    const id = c.req.param("id");
    if (deps.authz?.mode === "enforce") {
      const file = await service.getFileById(id);
      if (!file) {
        throw new AppError(ErrorCode.NOT_FOUND, "NetDrive file not found", 404);
      }
      const allowed = await authorizeNetDriveThroughSpice(
        c,
        deps.authz,
        callerOwnerId,
        id,
        "use",
        file.ownerId === callerOwnerId,
      );
      if (!allowed) {
        throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to use this NetDrive file", 403);
      }
      const minted = await service.mintDownloadUrlForAuthorizedFile(callerOwnerId, file);
      return c.json({ success: true, data: minted });
    }
    const ownerId = resolveOwnerOverride(c, callerOwnerId);
    const file = await service.getFile(ownerId, id);
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, "NetDrive file not found", 404);
    }
    await authorizeNetDriveThroughSpice(c, deps.authz, callerOwnerId, id, "use", true);
    const minted = await service.mintDownloadUrl(ownerId, id);
    return c.json({ success: true, data: minted });
  });

  r.delete("/netdrive/files/:id", async (c) => {
    const id = c.req.param("id");
    // Mutation paths do not honor `?asOwner`.
    const actor = requireNetDriveActor(c);
    const ownerId = actor.ownerId;
    const existing = await service.getFile(ownerId, id);
    if (!existing) {
      throw new AppError(ErrorCode.NOT_FOUND, "NetDrive file not found", 404);
    }
    if (!(await authorizeNetDriveThroughSpice(c, deps.authz, ownerId, id, "delete", true))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to delete this NetDrive file", 403);
    }
    const file = await service.deleteFile(ownerId, id);
    await enqueueNetDriveAuthorization(deps.authz, file.id, ownerId, actor.orgId, "delete");
    await db.insert(auditLog).values({
      actor: actor.ownerId,
      orgId: actor.orgId,
      action: "netdrive.file.delete",
      target: file.id,
      diff: { before: { path: file.path, size: file.size } },
    });
    return c.json({ success: true, data: file });
  });

  return r;
}

async function resolveNetDriveUseCapabilities(
  c: Context,
  authz: AuthzService,
  actorUserId: string,
  files: Array<{ id: string; ownerId: string }>,
): Promise<Map<string, boolean>> {
  const capabilities = new Map<string, boolean>();
  const checks: AuthzCheck[] = [];
  const checkFileIds: string[] = [];
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  for (const file of files) {
    if (file.ownerId === actorUserId) {
      capabilities.set(file.id, true);
      continue;
    }
    checkFileIds.push(file.id);
    checks.push({
      actorUserId,
      actorEmail: principal.email,
      resource: { type: "netdrive_file", id: file.id },
      permission: "use",
      subject: { type: "user", id: actorUserId },
      context: { route: "netdrive_file#use" },
    });
  }
  const decisions = await authz.checkBulk(checks);
  for (const [index, fileId] of checkFileIds.entries()) {
    capabilities.set(fileId, decisions[index] === true);
  }
  return capabilities;
}

async function enqueueNetDriveAuthorization(
  authz: AuthzService | undefined,
  fileId: string,
  ownerId: string,
  orgId: string | null,
  operation: AuthzTuple["operation"] = "create",
): Promise<void> {
  await authz?.enqueueMany(netdriveFileTuples({ fileId, userId: ownerId, orgId }, operation));
}

async function enqueueNetDriveCommitAuthorization(
  authz: AuthzService | undefined,
  commit: NetDriveCommitResult,
  ownerId: string,
  orgId: string | null,
): Promise<void> {
  const tuples = [
    ...commit.replacedFiles.flatMap((file) =>
      netdriveFileTuples({ fileId: file.id, userId: ownerId, orgId }, "delete"),
    ),
    ...netdriveFileTuples({ fileId: commit.file.id, userId: ownerId, orgId }),
  ];
  await authz?.enqueueMany(tuples);
}

/**
 * Read-only `?asOwner=<uuid>` admin override for owner-scoped GETs.
 * Anyone below `platform_admin` is silently scoped to their own JWT subject.
 */
function resolveOwnerOverride(c: Context, fallback: string): string {
  const override = c.req.query("asOwner");
  if (!override || override === fallback) return fallback;
  if (!hasRole(platformFallbackRole(c), "platform_admin")) {
    throw new AppError(ErrorCode.FORBIDDEN, "asOwner override requires platform_admin", 403);
  }
  return override;
}

export async function authorizeNetDriveThroughSpice(
  c: Context,
  authz: AuthzService | undefined,
  actorUserId: string,
  fileId: string,
  permission: "view" | "use" | "delete",
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId,
    actorEmail: principal.email,
    resource: { type: "netdrive_file", id: fileId },
    permission,
    subject: { type: "user", id: actorUserId },
    context: { route: `netdrive_file#${permission}` },
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return localAllowed;
  }
  if (
    localAllowed &&
    (await authz.hasPendingRelationship(netdriveOwnerTuple({ fileId, userId: actorUserId })))
  ) {
    return true;
  }
  try {
    await authz.requirePermission(check, hasRole(platformFallbackRole(c), "platform_admin"));
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

function platformFallbackRole(c: Context): RoleName {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return (principal?.role ?? "guest") as RoleName;
}
