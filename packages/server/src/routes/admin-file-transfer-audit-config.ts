import { auditLog, fileTransferAuditConfig, type PgDb } from "@kuintessence/db";
import {
  AppError,
  DEFAULT_PLATFORM_CLUSTER_RETENTION_DAYS,
  DEFAULT_USER_PLATFORM_RETENTION_DAYS,
  ErrorCode,
  FileTransferAuditConfigUpdateSchema,
  type FileTransferAuditConfigView,
  FileTransferDownloadEvidenceModeSchema,
} from "@kuintessence/shared";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

const SINGLETON_ID = "default";

export interface AdminFileTransferAuditConfigRouteOptions {
  authz?: AuthzService;
}

export function createAdminFileTransferAuditConfigRoutes(
  db: PgDb,
  opts: AdminFileTransferAuditConfigRouteOptions = {},
): Hono {
  const routes = new Hono();

  routes.get("/admin/file-transfer-audit/config", async (c) => {
    await requirePlatformPermission(c, opts.authz, "view", "admin-file-transfer-audit-config");
    return c.json(await loadConfig(db));
  });

  routes.put(
    "/admin/file-transfer-audit/config",
    kqValidator(
      "json",
      FileTransferAuditConfigUpdateSchema,
      "Invalid file-transfer audit config body",
    ),
    async (c) => {
      await requirePlatformPermission(c, opts.authz, "manage", "admin-file-transfer-audit-config");
      const actorUserId = requireCanonicalAdminActor(c);
      const input = c.req.valid("json");

      const after = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${fileTransferAuditConfig} IN EXCLUSIVE MODE`);
        const before = await loadConfig(tx);
        if (
          before.userPlatformRetentionDays === input.userPlatformRetentionDays &&
          before.platformClusterRetentionDays === input.platformClusterRetentionDays &&
          before.downloadEvidenceMode === input.downloadEvidenceMode
        ) {
          return before;
        }

        const updatedAt = new Date();
        const next: FileTransferAuditConfigView = {
          userPlatformRetentionDays: input.userPlatformRetentionDays,
          platformClusterRetentionDays: input.platformClusterRetentionDays,
          downloadEvidenceMode: input.downloadEvidenceMode,
          policyVersion: before.policyVersion + 1,
          updatedAt: updatedAt.toISOString(),
          updatedBy: actorUserId,
        };
        await tx
          .insert(fileTransferAuditConfig)
          .values({
            singletonId: SINGLETON_ID,
            userPlatformRetentionDays: next.userPlatformRetentionDays,
            platformClusterRetentionDays: next.platformClusterRetentionDays,
            downloadEvidenceMode: next.downloadEvidenceMode,
            policyVersion: next.policyVersion,
            updatedAt,
            updatedBy: actorUserId,
          })
          .onConflictDoUpdate({
            target: fileTransferAuditConfig.singletonId,
            set: {
              userPlatformRetentionDays: next.userPlatformRetentionDays,
              platformClusterRetentionDays: next.platformClusterRetentionDays,
              downloadEvidenceMode: next.downloadEvidenceMode,
              policyVersion: next.policyVersion,
              updatedAt,
              updatedBy: actorUserId,
            },
          });
        await tx.insert(auditLog).values({
          actor: actorUserId,
          orgId: null,
          action: "file_transfer_audit.config.update",
          target: "file_transfer_audit_config",
          diff: {
            before: configAuditView(before),
            after: { ...configAuditView(next), changeReason: input.changeReason },
          },
        });
        return next;
      });

      return c.json(after);
    },
  );

  return routes;
}

async function loadConfig(db: Pick<PgDb, "select">): Promise<FileTransferAuditConfigView> {
  const [row] = await db
    .select()
    .from(fileTransferAuditConfig)
    .where(eq(fileTransferAuditConfig.singletonId, SINGLETON_ID))
    .limit(1);
  if (!row) {
    return {
      userPlatformRetentionDays: DEFAULT_USER_PLATFORM_RETENTION_DAYS,
      platformClusterRetentionDays: DEFAULT_PLATFORM_CLUSTER_RETENTION_DAYS,
      downloadEvidenceMode: "controlled_gateway",
      policyVersion: 1,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const downloadEvidenceMode = FileTransferDownloadEvidenceModeSchema.safeParse(
    row.downloadEvidenceMode,
  );
  return {
    userPlatformRetentionDays: row.userPlatformRetentionDays,
    platformClusterRetentionDays: row.platformClusterRetentionDays,
    downloadEvidenceMode: downloadEvidenceMode.success
      ? downloadEvidenceMode.data
      : "controlled_gateway",
    policyVersion: row.policyVersion,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

function configAuditView(config: FileTransferAuditConfigView) {
  return {
    userPlatformRetentionDays: config.userPlatformRetentionDays,
    platformClusterRetentionDays: config.platformClusterRetentionDays,
    downloadEvidenceMode: config.downloadEvidenceMode,
    policyVersion: config.policyVersion,
  };
}

function requireCanonicalAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}
