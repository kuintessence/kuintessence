import { agents, type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import {
  AppError,
  createLogger,
  ErrorCode,
  type NetDriveFile,
  type TransferCreate,
} from "@kuintessence/shared";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { netdriveFileTuples } from "../authz/projection";
import type { AuthzService } from "../authz/service";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { NetDriveCommitDb, NetDriveCommitResult, NetDriveService } from "./netdrive";
import type { TransferProgressEvent, TransferRegistry } from "./transfer-registry";
import type { TransferSessionStore } from "./transfer-session-store";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_CANCEL_GUARD_MS = 60_000;

export interface TransferRunnerDeps {
  db: PgDb;
  dispatcher: AgentDispatcher;
  netdriveService: NetDriveService;
  transferRegistry: TransferRegistry;
  authz?: AuthzService;
  sessionStore?: TransferSessionStore;
}

export type TransferProgressCallback = (e: TransferProgressEvent) => void;

interface ActiveTransfer {
  agentId: string;
  cancelled: boolean;
  terminalStarted: boolean;
}

export class TransferRunner {
  private readonly logger = createLogger("transfer-runner");

  private readonly pendingMultipart = new Map<
    string,
    {
      ownerId: string;
      path: string;
      storageKey: string;
      uploadId: string;
      commitToken: string;
      partSize: number;
    }
  >();

  private readonly activeTransfers = new Map<string, ActiveTransfer>();
  private readonly cancelledBeforeDispatch = new Set<string>();
  private readonly terminalTransfers = new Map<string, symbol>();

  constructor(private readonly deps: TransferRunnerDeps) {}

  canHandle(data: TransferCreate): boolean {
    if (this.deps.dispatcher.onlineAgentIds().length === 0) return false;
    return data.direction === "cloud_to_cluster" || data.direction === "cluster_to_cloud";
  }

  async canResume(ownerId: string, transferId: string, data: TransferCreate): Promise<boolean> {
    if (data.direction !== "cluster_to_cloud") return false;
    const saved = await this.deps.sessionStore?.load(ownerId, transferId);
    return (
      !!saved?.completion &&
      (!data.agentId || data.agentId === saved.agentId) &&
      saved.source === data.source &&
      saved.target === data.target &&
      saved.size === (data.totalBytes ?? 0)
    );
  }

  async start(
    actorUserId: string | null | undefined,
    transferId: string,
    data: TransferCreate,
    onProgress: TransferProgressCallback,
  ): Promise<void> {
    if (!actorUserId) {
      this.markTerminal(transferId);
      onProgress({ copiedBytes: 0, state: "failed", error: "user not found" });
      return;
    }
    const saved =
      data.direction === "cluster_to_cloud"
        ? await this.deps.sessionStore?.load(actorUserId, transferId)
        : undefined;
    const agentId =
      saved?.completion && (!data.agentId || data.agentId === saved.agentId)
        ? saved.agentId
        : await this.resolveAgentId(data);
    if (this.cancelledBeforeDispatch.delete(transferId)) {
      return;
    }
    if (!agentId) {
      this.markTerminal(transferId);
      onProgress({ copiedBytes: 0, state: "failed", error: "no matching online agent" });
      return;
    }
    this.terminalTransfers.delete(transferId);
    const active: ActiveTransfer = {
      agentId,
      cancelled: false,
      terminalStarted: false,
    };
    this.activeTransfers.set(transferId, active);

    if (data.direction === "cloud_to_cluster") {
      await this.startCloudToCluster(actorUserId, active, transferId, data, onProgress);
      return;
    }
    if (data.direction === "cluster_to_cloud") {
      await this.startClusterToCloud(actorUserId, active, transferId, data, onProgress);
      return;
    }
    if (this.activeTransfers.get(transferId) === active) this.activeTransfers.delete(transferId);
    this.markTerminal(transferId);
    onProgress({
      copiedBytes: 0,
      state: "failed",
      error: `unsupported direction ${data.direction}`,
    });
  }

  async cancel(transferId: string, ownerId?: string): Promise<boolean> {
    if (ownerId && this.deps.sessionStore && !this.activeTransfers.has(transferId)) {
      const saved = await this.deps.sessionStore.load(ownerId, transferId);
      if (saved) {
        const credential = await this.deps.netdriveService.restoreMultipartSession(ownerId, saved);
        await this.deps.netdriveService.abortMultipart(ownerId, credential);
        await this.deps.sessionStore.save(ownerId, transferId, null);
      }
    }
    if (this.terminalTransfers.has(transferId)) return false;
    const active = this.activeTransfers.get(transferId);
    if (!active) {
      this.cancelledBeforeDispatch.add(transferId);
      return true;
    }
    if (active.terminalStarted) return false;

    active.cancelled = true;
    this.deps.transferRegistry.cancel(transferId);
    this.deps.dispatcher.pushFileTransferCancel(active.agentId, transferId);
    const multipart = this.pendingMultipart.get(transferId);
    if (multipart) {
      await this.deps.netdriveService
        .abortMultipart(multipart.ownerId, {
          storageKey: multipart.storageKey,
          uploadId: multipart.uploadId,
          commitToken: multipart.commitToken,
        })
        .catch(() => {});
      if (this.activeTransfers.get(transferId) !== active) return true;
      await this.deps.sessionStore?.save(multipart.ownerId, transferId, null);
      if (this.activeTransfers.get(transferId) === active) this.pendingMultipart.delete(transferId);
    }
    if (this.activeTransfers.get(transferId) === active) this.activeTransfers.delete(transferId);
    return true;
  }

  private async startCloudToCluster(
    ownerId: string,
    active: ActiveTransfer,
    transferId: string,
    data: TransferCreate,
    onProgress: TransferProgressCallback,
  ): Promise<void> {
    const fileId = data.sourceFileId;
    if (!fileId) {
      onProgress({
        copiedBytes: 0,
        state: "failed",
        error: "NETDRIVE_SOURCE_FILE_ID_REQUIRED",
      });
      return;
    }
    const file = await this.deps.netdriveService.getFileById(fileId);
    if (!file || !(await this.canUseNetDriveFile(ownerId, file))) {
      throw new Error("NETDRIVE_SOURCE_FILE_UNAVAILABLE");
    }
    const { downloadUrl } = await this.deps.netdriveService.mintDownloadUrlForAuthorizedFile(
      ownerId,
      file,
      {
        jobId: data.jobId,
        workflowRunId: data.workflowRunId,
        netdriveFileIds: data.netdriveFileIds ?? [fileId],
      },
    );

    if (active.cancelled || this.activeTransfers.get(transferId) !== active) return;

    const wrapped: TransferProgressCallback = (event) => {
      if (active.cancelled || this.activeTransfers.get(transferId) !== active) return;
      if (event.state !== "running") {
        active.terminalStarted = true;
        this.markTerminal(transferId);
        if (this.activeTransfers.get(transferId) === active)
          this.activeTransfers.delete(transferId);
      }
      onProgress(event);
    };
    this.deps.transferRegistry.register(transferId, wrapped, TRANSFER_TIMEOUT_MS);
    const queued = this.deps.dispatcher.pushFileTransfer(active.agentId, transferId, {
      direction: "cloud_to_cluster",
      sourceUrl: downloadUrl,
      targetPath: data.target,
      totalBytes: file.size,
      expectedSha256: file.sha256,
    });
    if (!queued) {
      this.deps.transferRegistry.cancel(transferId);
      if (this.activeTransfers.get(transferId) === active) this.activeTransfers.delete(transferId);
      this.markTerminal(transferId);
      onProgress({ copiedBytes: 0, state: "failed", error: "agent channel closed" });
    }
  }

  private async startClusterToCloud(
    ownerId: string,
    active: ActiveTransfer,
    transferId: string,
    data: TransferCreate,
    onProgress: TransferProgressCallback,
  ): Promise<void> {
    // Size is unknown at dispatch time (the agent spools first), so we always
    // pre-initiate a multipart upload with size 0 and let completeMultipart's
    // head-check validate the agent-reported size. A 1-part multipart is valid
    // for small outputs, so this single path covers all sizes.
    const saved = await this.deps.sessionStore?.load(ownerId, transferId);
    if (
      saved &&
      (saved.agentId !== active.agentId ||
        saved.source !== data.source ||
        saved.target !== data.target ||
        saved.size !== (data.totalBytes ?? 0))
    )
      throw new Error("Persisted transfer binding changed");
    const minted = saved
      ? await this.deps.netdriveService.restoreMultipartSession(ownerId, saved)
      : await this.deps.netdriveService.initiateMultipart(ownerId, {
          path: data.target,
          size: data.totalBytes ?? 0,
          contentType: "application/octet-stream",
        });
    if (this.activeTransfers.get(transferId) !== active) {
      if (!this.deps.sessionStore)
        await this.deps.netdriveService.abortMultipart(ownerId, minted).catch(() => {});
      return;
    }
    const proposedSession = {
      storageKey: minted.storageKey,
      uploadId: minted.uploadId,
      partSize: minted.partSize,
      agentId: active.agentId,
      source: data.source,
      target: data.target,
      size: data.totalBytes ?? 0,
      ...(saved?.completion ? { completion: saved.completion } : {}),
    };
    const session =
      (await this.deps.sessionStore?.save(ownerId, transferId, proposedSession)) ?? proposedSession;
    if (this.activeTransfers.get(transferId) !== active) return;
    this.pendingMultipart.set(transferId, {
      ownerId,
      path: data.target,
      storageKey: minted.storageKey,
      uploadId: minted.uploadId,
      commitToken: minted.commitToken,
      partSize: minted.partSize,
    });

    if (active.cancelled) {
      await this.deps.netdriveService
        .abortMultipart(ownerId, {
          storageKey: minted.storageKey,
          uploadId: minted.uploadId,
          commitToken: minted.commitToken,
        })
        .catch(() => {});
      if (this.activeTransfers.get(transferId) === active) this.pendingMultipart.delete(transferId);
      return;
    }

    // Wrap the progress callback so terminal events finalize the multipart:
    // success → completeMultipart (assemble + head-check + insert row);
    // failure → best-effort abortMultipart so MinIO sheds the orphaned upload.
    const wrapped: TransferProgressCallback = async (e) => {
      if (
        active.cancelled ||
        active.terminalStarted ||
        this.activeTransfers.get(transferId) !== active
      )
        return;
      if (e.state !== "running") {
        active.terminalStarted = true;
        this.markTerminal(transferId);
      }
      if (e.state === "succeeded") {
        try {
          if (!/^[a-f0-9]{64}$/i.test(e.sha256 ?? ""))
            throw new AppError(
              ErrorCode.VALIDATION_ERROR,
              "Multipart completion sha256 missing or invalid",
              400,
            );
          const completion = {
            copiedBytes: e.copiedBytes,
            sha256: e.sha256 ?? "",
            parts: e.parts ?? [],
          };
          if (
            session.completion &&
            JSON.stringify(session.completion) !== JSON.stringify(completion)
          )
            throw new AppError(
              ErrorCode.VALIDATION_ERROR,
              "Persisted completion content changed",
              400,
            );
          await this.deps.sessionStore?.save(ownerId, transferId, { ...session, completion });
          const commit = await this.deps.netdriveService.completeMultipartWithReplacements(
            ownerId,
            {
              path: data.target,
              size: e.copiedBytes,
              sha256: e.sha256 ?? "",
              contentType: "application/octet-stream",
              storageKey: minted.storageKey,
              uploadId: minted.uploadId,
              commitToken: minted.commitToken,
              parts: e.parts ?? [],
            },
            {
              jobId: data.jobId,
              workflowRunId: data.workflowRunId,
              netdriveFileIds: data.netdriveFileIds,
            },
            (result, db) => this.enqueueNetDriveAuthorization(ownerId, result, db),
          );
          if (this.activeTransfers.get(transferId) !== active) return;
          // Retain the completion receipt until the transfer row is terminal in durable storage.
          this.pendingMultipart.delete(transferId);
          this.activeTransfers.delete(transferId);
          onProgress({
            ...e,
            netdriveFileIds: [commit.file.id],
          });
          return;
        } catch (err) {
          if (this.activeTransfers.get(transferId) !== active) return;
          this.logger.error({ transferId, err }, "Failed to complete cluster_to_cloud multipart");
          // Keep the durable completion request: object completion or DB commit may have succeeded.
          this.pendingMultipart.delete(transferId);
          this.activeTransfers.delete(transferId);
          onProgress({
            copiedBytes: e.copiedBytes,
            state: "failed",
            error: err instanceof AppError ? err.message : "MULTIPART_FINALIZATION_RETRY_REQUIRED",
          });
          return;
        }
      } else if (e.state === "failed") {
        if (!this.deps.sessionStore)
          await this.deps.netdriveService
            .abortMultipart(ownerId, {
              storageKey: minted.storageKey,
              uploadId: minted.uploadId,
              commitToken: minted.commitToken,
            })
            .catch(() => {});
        if (this.activeTransfers.get(transferId) !== active) return;
        this.pendingMultipart.delete(transferId);
        this.activeTransfers.delete(transferId);
      }
      onProgress(e);
    };

    if (session.completion) {
      await wrapped({ ...session.completion, state: "succeeded" });
      return;
    }
    this.deps.transferRegistry.register(transferId, wrapped, TRANSFER_TIMEOUT_MS);
    const queued = this.deps.dispatcher.pushFileTransfer(active.agentId, transferId, {
      direction: "cluster_to_cloud",
      sourcePath: data.source,
      uploadId: minted.uploadId,
      commitToken: minted.commitToken,
      partSize: minted.partSize,
      totalBytes: data.totalBytes ?? 0,
    });
    if (!queued) {
      this.deps.transferRegistry.cancel(transferId);
      if (this.activeTransfers.get(transferId) === active) this.pendingMultipart.delete(transferId);
      if (this.activeTransfers.get(transferId) === active) this.activeTransfers.delete(transferId);
      this.markTerminal(transferId);
      if (!this.deps.sessionStore)
        await this.deps.netdriveService
          .abortMultipart(ownerId, {
            storageKey: minted.storageKey,
            uploadId: minted.uploadId,
            commitToken: minted.commitToken,
          })
          .catch(() => {});
      onProgress({ copiedBytes: 0, state: "failed", error: "agent channel closed" });
    }
  }

  private markTerminal(transferId: string): void {
    const generation = Symbol();
    this.terminalTransfers.set(transferId, generation);
    setTimeout(() => {
      if (this.terminalTransfers.get(transferId) === generation)
        this.terminalTransfers.delete(transferId);
    }, TERMINAL_CANCEL_GUARD_MS).unref?.();
  }

  /**
   * Resolve presigned part URLs for an in-flight cluster->cloud upload. Called
   * by the agent-handler when the agent sends a PartUrlsRequest; the ownerId is
   * looked up from the Server's own dispatch bookkeeping so the agent never
   * asserts an owner.
   */
  async mintPartUrlsFor(
    requestId: string,
    partNumbers: number[],
    agentId?: string,
    expectedUploadId?: string,
  ): Promise<{ partNumber: number; url: string }[]> {
    if (agentId && this.activeTransfers.get(requestId)?.agentId !== agentId)
      throw new Error("Transfer Agent binding mismatch");
    const entry = this.pendingMultipart.get(requestId);
    if (!entry) {
      throw new Error(`no pending multipart upload for transfer ${requestId}`);
    }
    if (expectedUploadId !== undefined && expectedUploadId !== entry.uploadId)
      throw new Error("Transfer upload binding mismatch");
    const res = await this.deps.netdriveService.mintPartUrls(entry.ownerId, {
      storageKey: entry.storageKey,
      uploadId: entry.uploadId,
      commitToken: entry.commitToken,
      partNumbers,
    });
    return res.urls;
  }

  private async enqueueNetDriveAuthorization(
    ownerId: string,
    commit: NetDriveCommitResult,
    db?: NetDriveCommitDb,
  ): Promise<void> {
    if (!this.deps.authz) return;
    const orgId = await this.resolvePrimaryOrgId(ownerId, db);
    const tuples = [
      ...commit.replacedFiles.flatMap((file) =>
        netdriveFileTuples({ fileId: file.id, userId: ownerId, orgId }, "delete"),
      ),
      ...netdriveFileTuples({ fileId: commit.file.id, userId: ownerId, orgId }),
    ];
    await this.deps.authz.enqueueMany(tuples, db);
  }

  private async resolvePrimaryOrgId(
    userId: string,
    db: Pick<PgDb, "select"> = this.deps.db,
  ): Promise<string | null> {
    const [row] = await db
      .select({ orgId: userOrgMemberships.orgId })
      .from(userOrgMemberships)
      .where(eq(userOrgMemberships.userId, userId))
      .orderBy(asc(userOrgMemberships.createdAt))
      .limit(1);
    return row?.orgId ?? null;
  }

  private async canUseNetDriveFile(actorUserId: string, file: NetDriveFile): Promise<boolean> {
    if (file.ownerId === actorUserId) return true;
    if (this.deps.authz?.mode !== "enforce") return false;
    const [actor] = await this.deps.db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);
    if (!actor) return false;
    try {
      await this.deps.authz.requirePermission(
        {
          actorUserId,
          actorEmail: actor.email,
          resource: { type: "netdrive_file", id: file.id },
          permission: "use",
          subject: { type: "user", id: actorUserId },
          context: { route: "file_transfer#source" },
        },
        actor.role === "platform_admin" || actor.role === "super_admin",
      );
      return true;
    } catch {
      return false;
    }
  }

  private async resolveAgentId(data: TransferCreate): Promise<string | null> {
    const online = this.deps.dispatcher.onlineAgentIds();
    if (online.length === 0) return null;
    if (data.agentId) return online.includes(data.agentId) ? data.agentId : null;
    if (!data.siteId) return online[0] ?? null;
    if (online.includes(data.siteId)) return data.siteId;
    const [row] = await this.deps.db
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(
        and(
          inArray(agents.agentId, online),
          or(
            eq(agents.siteId, data.siteId),
            eq(agents.siteName, data.siteId),
            eq(agents.clusterId, data.siteId),
          ),
        ),
      )
      .limit(1);
    return row?.agentId ?? null;
  }
}
