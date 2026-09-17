import {
  netdriveFiles,
  netdriveTransferLog,
  type PgDb,
  storageQuotaGrants,
  storageQuotaPolicies,
  storageQuotaRequests,
  users,
} from "@kuintessence/db";
import {
  AppError,
  type CloudStorageOverview,
  ErrorCode,
  type StorageQuotaGrantCreate,
  type StorageQuotaPolicyInput,
  type StorageQuotaRequestCreate,
  type StorageQuotaRequestDecision,
  type StorageQuotaSummary,
  type StorageScope,
} from "@kuintessence/shared";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

const DEFAULT_CLOUD_QUOTA_BYTES = 50 * 1024 * 1024 * 1024;
const METERING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface EffectivePolicy {
  defaultQuotaBytes: number;
  maxQuotaBytes: number | null;
  requestMode: "auto" | "manual" | "disabled";
  autoApproveLimitBytes: number | null;
}

export class StorageQuotaService {
  constructor(
    private readonly db: PgDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getSummary(
    userId: string,
    scope: StorageScope = "cloud",
    scopeId = "global",
  ): Promise<StorageQuotaSummary> {
    const policy = await this.getEffectivePolicy(scope, scopeId);
    const activeGrant = await this.getActiveGrant(userId, scope, scopeId);
    const quotaBytes = Math.max(policy.defaultQuotaBytes, activeGrant?.quotaBytes ?? 0);
    const usage =
      scope === "cloud"
        ? await this.getCloudUsage(userId)
        : {
            usedBytes: 0,
            fileCount: 0,
            uploadedBytes30d: 0,
            downloadedBytes30d: 0,
            storedByteHours30d: 0,
          };
    return {
      scope,
      scopeId,
      ...usage,
      quotaBytes,
      availableBytes: Math.max(0, quotaBytes - usage.usedBytes),
      usagePercent:
        quotaBytes === 0 ? (usage.usedBytes > 0 ? 100 : 0) : (usage.usedBytes / quotaBytes) * 100,
      policy,
      activeGrant: activeGrant
        ? {
            quotaBytes: activeGrant.quotaBytes,
            expiresAt: activeGrant.expiresAt?.toISOString() ?? null,
            source: activeGrant.source,
          }
        : null,
    };
  }

  async assertCloudWriteAllowed(userId: string, path: string, size: number): Promise<void> {
    if (size < 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Storage object size cannot be negative", 400);
    }
    const summary = await this.getSummary(userId);
    const [existing] = await this.db
      .select({ size: netdriveFiles.size })
      .from(netdriveFiles)
      .where(
        and(
          eq(netdriveFiles.ownerId, userId),
          eq(netdriveFiles.path, path),
          isNull(netdriveFiles.deletedAt),
        ),
      )
      .limit(1);
    const projectedBytes = summary.usedBytes - (existing?.size ?? 0) + size;
    if (projectedBytes <= summary.quotaBytes) return;
    throw new AppError(
      ErrorCode.STORAGE_QUOTA_EXCEEDED,
      "云存储空间不足，请清理文件或申请更高配额",
      413,
      {
        usedBytes: summary.usedBytes,
        quotaBytes: summary.quotaBytes,
        requestedWriteBytes: size,
        projectedBytes,
      },
    );
  }

  async createRequest(userId: string, input: StorageQuotaRequestCreate) {
    const policy = await this.getEffectivePolicy(input.scope, input.scopeId);
    if (policy.requestMode === "disabled") {
      throw new AppError(ErrorCode.FORBIDDEN, "当前存储范围暂不接受配额申请", 403);
    }
    if (policy.maxQuotaBytes != null && input.requestedQuotaBytes > policy.maxQuotaBytes) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "申请配额超过当前策略允许的上限", 400, {
        maxQuotaBytes: policy.maxQuotaBytes,
      });
    }
    const requestedExpiresAt = input.requestedExpiresAt ? new Date(input.requestedExpiresAt) : null;
    if (requestedExpiresAt && requestedExpiresAt <= this.now()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "临时配额到期时间必须晚于当前时间", 400);
    }
    const [pendingRequest] = await this.db
      .select({ id: storageQuotaRequests.id })
      .from(storageQuotaRequests)
      .where(
        and(
          eq(storageQuotaRequests.userId, userId),
          eq(storageQuotaRequests.scope, input.scope),
          eq(storageQuotaRequests.scopeId, input.scopeId),
          eq(storageQuotaRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (pendingRequest) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "当前存储范围已有待审批的配额申请", 409, {
        requestId: pendingRequest.id,
      });
    }
    const autoApproved =
      policy.requestMode === "auto" &&
      (policy.autoApproveLimitBytes == null ||
        input.requestedQuotaBytes <= policy.autoApproveLimitBytes);
    const timestamp = this.now();
    const [request] = await this.db
      .insert(storageQuotaRequests)
      .values({
        userId,
        scope: input.scope,
        scopeId: input.scopeId,
        requestedQuotaBytes: input.requestedQuotaBytes,
        requestedExpiresAt,
        reason: input.reason,
        status: autoApproved ? "approved" : "pending",
        decidedBy: autoApproved ? userId : null,
        decisionNote: autoApproved ? "根据配额策略自动批准" : null,
        decidedAt: autoApproved ? timestamp : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning();
    if (!request) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Failed to create storage quota request", 500);
    }
    if (autoApproved) {
      await this.createGrantRow({
        userId,
        scope: input.scope,
        scopeId: input.scopeId,
        quotaBytes: input.requestedQuotaBytes,
        expiresAt: requestedExpiresAt,
        source: "auto",
        requestId: request.id,
        grantedBy: userId,
        note: "根据配额策略自动批准",
      });
    }
    return request;
  }

  async listUserRequests(userId: string) {
    return this.db
      .select()
      .from(storageQuotaRequests)
      .where(eq(storageQuotaRequests.userId, userId))
      .orderBy(desc(storageQuotaRequests.createdAt));
  }

  async listRequests(scope: StorageScope, scopeId: string) {
    return this.db
      .select()
      .from(storageQuotaRequests)
      .where(and(eq(storageQuotaRequests.scope, scope), eq(storageQuotaRequests.scopeId, scopeId)))
      .orderBy(desc(storageQuotaRequests.createdAt));
  }

  async getRequest(requestId: string) {
    const [request] = await this.db
      .select()
      .from(storageQuotaRequests)
      .where(eq(storageQuotaRequests.id, requestId))
      .limit(1);
    return request ?? null;
  }

  async decideRequest(requestId: string, actorUserId: string, input: StorageQuotaRequestDecision) {
    const [request] = await this.db
      .select()
      .from(storageQuotaRequests)
      .where(eq(storageQuotaRequests.id, requestId))
      .limit(1);
    if (!request) {
      throw new AppError(ErrorCode.NOT_FOUND, "Storage quota request not found", 404);
    }
    if (request.status !== "pending") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "该配额申请已经处理", 409);
    }
    const policy = await this.getEffectivePolicy(request.scope as StorageScope, request.scopeId);
    if (
      input.decision === "approved" &&
      policy.maxQuotaBytes != null &&
      request.requestedQuotaBytes > policy.maxQuotaBytes
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "申请配额已超过当前策略上限", 409, {
        maxQuotaBytes: policy.maxQuotaBytes,
      });
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : request.requestedExpiresAt;
    if (input.decision === "approved" && expiresAt && expiresAt <= this.now()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "临时配额到期时间必须晚于当前时间", 400);
    }
    const timestamp = this.now();
    const [updated] = await this.db
      .update(storageQuotaRequests)
      .set({
        status: input.decision,
        decidedBy: actorUserId,
        decisionNote: input.note,
        decidedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(storageQuotaRequests.id, requestId))
      .returning();
    if (input.decision === "approved") {
      await this.createGrantRow({
        userId: request.userId,
        scope: request.scope as StorageScope,
        scopeId: request.scopeId,
        quotaBytes: request.requestedQuotaBytes,
        expiresAt,
        source: "request",
        requestId,
        grantedBy: actorUserId,
        note: input.note,
      });
    }
    return updated;
  }

  async upsertPolicy(actorUserId: string, input: StorageQuotaPolicyInput) {
    const timestamp = this.now();
    const [row] = await this.db
      .insert(storageQuotaPolicies)
      .values({
        ...input,
        providerOrgId: input.providerOrgId ?? null,
        maxQuotaBytes: input.maxQuotaBytes ?? null,
        autoApproveLimitBytes: input.autoApproveLimitBytes ?? null,
        updatedBy: actorUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [storageQuotaPolicies.scope, storageQuotaPolicies.scopeId],
        set: {
          providerOrgId: input.providerOrgId ?? null,
          defaultQuotaBytes: input.defaultQuotaBytes,
          maxQuotaBytes: input.maxQuotaBytes ?? null,
          requestMode: input.requestMode,
          autoApproveLimitBytes: input.autoApproveLimitBytes ?? null,
          enabled: input.enabled,
          updatedBy: actorUserId,
          updatedAt: timestamp,
        },
      })
      .returning();
    return row;
  }

  async getPolicy(scope: StorageScope, scopeId: string) {
    const [row] = await this.db
      .select()
      .from(storageQuotaPolicies)
      .where(and(eq(storageQuotaPolicies.scope, scope), eq(storageQuotaPolicies.scopeId, scopeId)))
      .limit(1);
    return row ?? null;
  }

  async createGrant(actorUserId: string, input: StorageQuotaGrantCreate) {
    const [targetUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!targetUser) {
      throw new AppError(ErrorCode.NOT_FOUND, "目标用户不存在", 404);
    }
    const policy = await this.getEffectivePolicy(input.scope, input.scopeId);
    if (policy.maxQuotaBytes != null && input.quotaBytes > policy.maxQuotaBytes) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "分配配额超过策略上限", 400);
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= this.now()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "临时配额到期时间必须晚于当前时间", 400);
    }
    return this.createGrantRow({
      userId: input.userId,
      scope: input.scope,
      scopeId: input.scopeId,
      quotaBytes: input.quotaBytes,
      expiresAt,
      source: input.expiresAt ? "temporary" : "manual",
      requestId: null,
      grantedBy: actorUserId,
      note: input.note,
    });
  }

  async getCloudOverview(): Promise<CloudStorageOverview> {
    const now = this.now();
    const windowStart = new Date(now.getTime() - METERING_WINDOW_MS);
    const [objects] = await this.db
      .select({
        usedBytes: sql<number>`coalesce(sum(${netdriveFiles.size}), 0)`,
        fileCount: sql<number>`count(*)`,
      })
      .from(netdriveFiles)
      .where(isNull(netdriveFiles.deletedAt));
    const transfers = await this.db
      .select({
        direction: netdriveTransferLog.direction,
        bytes: sql<number>`coalesce(sum(${netdriveTransferLog.bytes}), 0)`,
      })
      .from(netdriveTransferLog)
      .where(gt(netdriveTransferLog.occurredAt, windowStart))
      .groupBy(netdriveTransferLog.direction);
    const lifecycleRows = await this.db
      .select({
        size: netdriveFiles.size,
        createdAt: netdriveFiles.createdAt,
        deletedAt: netdriveFiles.deletedAt,
      })
      .from(netdriveFiles)
      .where(or(isNull(netdriveFiles.deletedAt), gt(netdriveFiles.deletedAt, windowStart)));
    const [grantAggregate] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(storageQuotaGrants)
      .where(
        and(
          eq(storageQuotaGrants.scope, "cloud"),
          eq(storageQuotaGrants.scopeId, "global"),
          lte(storageQuotaGrants.startsAt, now),
          isNull(storageQuotaGrants.revokedAt),
          or(isNull(storageQuotaGrants.expiresAt), gt(storageQuotaGrants.expiresAt, now)),
        ),
      );
    const [requestAggregate] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(storageQuotaRequests)
      .where(
        and(
          eq(storageQuotaRequests.scope, "cloud"),
          eq(storageQuotaRequests.scopeId, "global"),
          eq(storageQuotaRequests.status, "pending"),
        ),
      );
    const storedByteHours30d = lifecycleRows.reduce((total, row) => {
      const start = Math.max(windowStart.getTime(), row.createdAt.getTime());
      const end = Math.min(now.getTime(), row.deletedAt?.getTime() ?? now.getTime());
      return total + row.size * (Math.max(0, end - start) / 3_600_000);
    }, 0);
    const byDirection = new Map(transfers.map((row) => [row.direction, Number(row.bytes)]));
    return {
      usedBytes: Number(objects?.usedBytes ?? 0),
      fileCount: Number(objects?.fileCount ?? 0),
      uploadedBytes30d: byDirection.get("upload") ?? 0,
      downloadedBytes30d: byDirection.get("download") ?? 0,
      storedByteHours30d,
      activeGrantCount: Number(grantAggregate?.count ?? 0),
      pendingRequestCount: Number(requestAggregate?.count ?? 0),
    };
  }

  private async getEffectivePolicy(scope: StorageScope, scopeId: string): Promise<EffectivePolicy> {
    const row = await this.getPolicy(scope, scopeId);
    if (!row?.enabled) {
      return {
        defaultQuotaBytes: scope === "cloud" ? DEFAULT_CLOUD_QUOTA_BYTES : 0,
        maxQuotaBytes: null,
        requestMode: "manual",
        autoApproveLimitBytes: null,
      };
    }
    return {
      defaultQuotaBytes: row.defaultQuotaBytes,
      maxQuotaBytes: row.maxQuotaBytes,
      requestMode: row.requestMode as EffectivePolicy["requestMode"],
      autoApproveLimitBytes: row.autoApproveLimitBytes,
    };
  }

  private async getActiveGrant(userId: string, scope: StorageScope, scopeId: string) {
    const now = this.now();
    const [grant] = await this.db
      .select()
      .from(storageQuotaGrants)
      .where(
        and(
          eq(storageQuotaGrants.userId, userId),
          eq(storageQuotaGrants.scope, scope),
          eq(storageQuotaGrants.scopeId, scopeId),
          lte(storageQuotaGrants.startsAt, now),
          isNull(storageQuotaGrants.revokedAt),
          or(isNull(storageQuotaGrants.expiresAt), gt(storageQuotaGrants.expiresAt, now)),
        ),
      )
      .orderBy(desc(storageQuotaGrants.quotaBytes), desc(storageQuotaGrants.createdAt))
      .limit(1);
    return grant ?? null;
  }

  private async getCloudUsage(userId: string) {
    const [aggregate] = await this.db
      .select({
        usedBytes: sql<number>`coalesce(sum(${netdriveFiles.size}), 0)`,
        fileCount: sql<number>`count(*)`,
      })
      .from(netdriveFiles)
      .where(and(eq(netdriveFiles.ownerId, userId), isNull(netdriveFiles.deletedAt)));
    const windowStart = new Date(this.now().getTime() - METERING_WINDOW_MS);
    const transfers = await this.db
      .select({
        direction: netdriveTransferLog.direction,
        bytes: sql<number>`coalesce(sum(${netdriveTransferLog.bytes}), 0)`,
      })
      .from(netdriveTransferLog)
      .where(
        and(
          eq(netdriveTransferLog.actorId, userId),
          gt(netdriveTransferLog.occurredAt, windowStart),
        ),
      )
      .groupBy(netdriveTransferLog.direction);
    const lifecycleRows = await this.db
      .select({
        size: netdriveFiles.size,
        createdAt: netdriveFiles.createdAt,
        deletedAt: netdriveFiles.deletedAt,
      })
      .from(netdriveFiles)
      .where(
        and(
          eq(netdriveFiles.ownerId, userId),
          or(isNull(netdriveFiles.deletedAt), gt(netdriveFiles.deletedAt, windowStart)),
        ),
      );
    const windowEndMs = this.now().getTime();
    const storedByteHours30d = lifecycleRows.reduce((total, row) => {
      const start = Math.max(windowStart.getTime(), row.createdAt.getTime());
      const end = Math.min(windowEndMs, row.deletedAt?.getTime() ?? windowEndMs);
      return total + row.size * (Math.max(0, end - start) / 3_600_000);
    }, 0);
    const byDirection = new Map(transfers.map((row) => [row.direction, Number(row.bytes)]));
    return {
      usedBytes: Number(aggregate?.usedBytes ?? 0),
      fileCount: Number(aggregate?.fileCount ?? 0),
      uploadedBytes30d: byDirection.get("upload") ?? 0,
      downloadedBytes30d: byDirection.get("download") ?? 0,
      storedByteHours30d,
    };
  }

  private async createGrantRow(input: {
    userId: string;
    scope: StorageScope;
    scopeId: string;
    quotaBytes: number;
    expiresAt: Date | null;
    source: "manual" | "temporary" | "auto" | "request";
    requestId: string | null;
    grantedBy: string;
    note: string;
  }) {
    const timestamp = this.now();
    const [grant] = await this.db
      .insert(storageQuotaGrants)
      .values({ ...input, startsAt: timestamp, createdAt: timestamp })
      .returning();
    if (!grant) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Failed to create storage quota grant", 500);
    }
    return grant;
  }
}
