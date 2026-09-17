import {
  AppError,
  type CloudObject,
  type CloudObjectCreate,
  type CloudObjectRename,
  type ClusterEntry,
  ErrorCode,
  type Transfer,
  type TransferCreate,
  type TransferState,
} from "@kuintessence/shared";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { ShellExecRegistry } from "./shell-exec-registry";
import type { TransferProgressEvent } from "./transfer-registry";

/**
 * POSIX single-quote a string for safe inclusion in a shell command: wrap in
 * single quotes and escape any embedded single quote as `'\''`. Inside single
 * quotes the shell performs NO expansion, so `$(...)`, backticks, `;`, `"`, etc.
 * are all literal — the correct way to pass an untrusted path to a shell.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the agent shell command that lists a cluster directory. The path is
 * user-controlled (`?path=`), so it is single-quoted — NOT interpolated into a
 * double-quoted string (where `$(...)`/backticks would execute → RCE).
 *
 * Read-only: it must NOT create the directory. This is reached from a `GET`,
 * which must be side-effect-free; a prior `mkdir -p` here let any authenticated
 * user create arbitrary directory trees on the cluster as the agent's identity.
 * A missing path now just fails `ls` so the route can report that the path is unavailable.
 */
export function buildClusterLsCommand(path: string): string {
  return `ls -la --time-style=long-iso ${shellSingleQuote(path)}`;
}

export function buildClusterDownloadCommand(path: string): string {
  return `test -f ${shellSingleQuote(path)} && base64 ${shellSingleQuote(path)} | tr -d '\\n'`;
}

export function buildClusterSourceFileCheckCommand(path: string): string {
  return `test -f ${shellSingleQuote(path)}`;
}

export function buildClusterTargetParentCheckCommand(path: string): string {
  return [
    `dir=$(dirname -- ${shellSingleQuote(path)})`,
    'while [ ! -e "$dir" ]; do parent=$(dirname -- "$dir"); if [ "$parent" = "$dir" ]; then echo MISSING; exit 2; fi; dir="$parent"; done',
    'if [ ! -d "$dir" ]; then echo MISSING; exit 2; fi',
    'if [ ! -x "$dir" ] || [ ! -w "$dir" ]; then echo NOT_WRITABLE; exit 3; fi',
  ].join("; ");
}

export function buildClusterRootCheckCommand(path: string): string {
  return [
    `root=${shellSingleQuote(path)}`,
    'if [ ! -d "$root" ]; then echo MISSING; exit 2; fi',
    'if [ ! -r "$root" ] || [ ! -x "$root" ]; then echo NOT_READABLE; exit 4; fi',
    'if [ ! -w "$root" ]; then echo NOT_WRITABLE; exit 3; fi',
  ].join("; ");
}

export type RealClusterListResult =
  | { status: "unavailable" }
  | { status: "ok"; entries: ClusterEntry[] }
  | { status: "failed" };

export type RealClusterDownloadResult =
  | { status: "unavailable" }
  | { status: "ok"; body: Buffer }
  | { status: "failed" };

export type ClusterTransferPathCheckResult =
  | { status: "unavailable" }
  | { status: "ok" }
  | { status: "missing" }
  | { status: "not_writable" };

export type ClusterFileRootCheckResult =
  | { status: "unavailable" }
  | { status: "ok" }
  | { status: "missing" }
  | { status: "not_readable" }
  | { status: "not_writable" };

export type FileTransferPatch = Partial<
  Pick<
    Transfer,
    | "copiedBytes"
    | "state"
    | "startedAt"
    | "finishedAt"
    | "error"
    | "clusterRootId"
    | "clusterRootRevision"
    | "rootPolicyChangedAt"
    | "netdriveFileIds"
  >
>;

export interface TransferDispatchAuthorization {
  clusterRootId: string | null;
  clusterRootRevision: string | null;
}

export interface FileTransferRunner {
  canHandle(data: TransferCreate): boolean;
  start(
    actorUserId: string | null | undefined,
    transferId: string,
    data: TransferCreate,
    onProgress: (event: TransferProgressEvent) => void,
  ): Promise<void>;
  cancel(transferId: string): Promise<boolean>;
}

export interface TransferDispatchOptions {
  beforeDispatch?: () => Promise<TransferDispatchAuthorization | undefined>;
}

export interface FileTransferListFilter {
  state?: TransferState;
  error?: string;
}

export interface FileTransferStore {
  listByUser(userId: string, filter?: FileTransferListFilter): Promise<Transfer[]>;
  getByUser(userId: string, id: string): Promise<Transfer | null>;
  create(transfer: Transfer): Promise<Transfer>;
  update(userId: string, id: string, patch: FileTransferPatch): Promise<Transfer | null>;
  transition(
    userId: string,
    id: string,
    from: TransferState,
    patch: FileTransferPatch,
  ): Promise<Transfer | null>;
  markRunningRootPolicyChanged(rootId: string, changedAt: string): Promise<Transfer[]>;
  markInterrupted(error: string): Promise<number>;
}

export class InMemoryFileTransferStore implements FileTransferStore {
  private readonly transfers = new Map<string, Transfer>();

  async listByUser(userId: string, filter: FileTransferListFilter = {}): Promise<Transfer[]> {
    return [...this.transfers.values()]
      .filter((t) => t.userId === userId)
      .filter((t) => (filter.state ? t.state === filter.state : true))
      .filter((t) => (filter.error ? t.error === filter.error : true))
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  }

  async getByUser(userId: string, id: string): Promise<Transfer | null> {
    const transfer = this.transfers.get(id);
    return transfer?.userId === userId ? transfer : null;
  }

  async create(transfer: Transfer): Promise<Transfer> {
    this.transfers.set(transfer.id, transfer);
    return transfer;
  }

  async update(userId: string, id: string, patch: FileTransferPatch): Promise<Transfer | null> {
    const current = await this.getByUser(userId, id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.transfers.set(id, updated);
    return updated;
  }

  async transition(
    userId: string,
    id: string,
    from: TransferState,
    patch: FileTransferPatch,
  ): Promise<Transfer | null> {
    const current = await this.getByUser(userId, id);
    if (!current || current.state !== from) return null;
    const updated = { ...current, ...patch };
    this.transfers.set(id, updated);
    return updated;
  }

  async markRunningRootPolicyChanged(rootId: string, changedAt: string): Promise<Transfer[]> {
    const affected: Transfer[] = [];
    for (const [id, transfer] of this.transfers.entries()) {
      if (transfer.state !== "running" || transfer.clusterRootId !== rootId) continue;
      const updated = { ...transfer, rootPolicyChangedAt: changedAt };
      this.transfers.set(id, updated);
      affected.push(updated);
    }
    return affected;
  }

  async markInterrupted(error: string): Promise<number> {
    let count = 0;
    const finishedAt = new Date().toISOString();
    for (const [id, transfer] of this.transfers.entries()) {
      if (transfer.state !== "running" && transfer.state !== "queued") continue;
      this.transfers.set(id, {
        ...transfer,
        state: "failed",
        finishedAt,
        error,
      });
      count += 1;
    }
    return count;
  }
}

/**
 * In-memory file compatibility service.
 *
 * Legacy cloud objects live in a per-user map and mock transfers tick copiedBytes so older
 * clients can still exercise the compatibility surface. Cluster listings always come from a
 * live Agent shell channel; production NetDrive transfers use the attached TransferRunner.
 */
export class FileService {
  private readonly cloud = new Map<string, CloudObject>();
  private readonly tickers = new Map<string, ReturnType<typeof setInterval>>();
  private runner: FileTransferRunner | null = null;
  private dispatcher: AgentDispatcher | null = null;
  private shellExecRegistry: ShellExecRegistry | null = null;

  constructor(
    private readonly transferStore: FileTransferStore = new InMemoryFileTransferStore(),
  ) {}

  attachRunner(runner: FileTransferRunner): void {
    this.runner = runner;
  }

  attachShell(dispatcher: AgentDispatcher, registry: ShellExecRegistry): void {
    this.dispatcher = dispatcher;
    this.shellExecRegistry = registry;
  }

  async listClusterReal(
    path: string,
    target: { agentId?: string; siteId?: string } = {},
  ): Promise<RealClusterListResult> {
    if (!this.dispatcher || !this.shellExecRegistry) return { status: "unavailable" };
    const agentId = this.selectOnlineAgent(target);
    if (!agentId) return { status: "unavailable" };
    const requestId = crypto.randomUUID();
    const pending = this.shellExecRegistry.await(requestId, 10_000);
    const queued = this.dispatcher.pushShellExec(
      agentId,
      requestId,
      buildClusterLsCommand(path),
      10,
    );
    if (!queued) {
      this.shellExecRegistry.discard(requestId);
      return { status: "unavailable" };
    }
    try {
      const r = await pending;
      if (r.exitCode !== 0) return { status: "failed" };
      return { status: "ok", entries: parseLsLa(r.stdout) };
    } catch {
      return { status: "failed" };
    }
  }

  async downloadClusterReal(
    path: string,
    target: { agentId?: string; siteId?: string } = {},
  ): Promise<RealClusterDownloadResult> {
    if (!this.dispatcher || !this.shellExecRegistry) return { status: "unavailable" };
    const agentId = this.selectOnlineAgent(target);
    if (!agentId) return { status: "unavailable" };
    const requestId = crypto.randomUUID();
    const pending = this.shellExecRegistry.await(requestId, 30_000);
    const queued = this.dispatcher.pushShellExec(
      agentId,
      requestId,
      buildClusterDownloadCommand(path),
      30,
    );
    if (!queued) {
      this.shellExecRegistry.discard(requestId);
      return { status: "unavailable" };
    }
    try {
      const r = await pending;
      if (r.exitCode !== 0 || !r.stdout) return { status: "failed" };
      return { status: "ok", body: Buffer.from(r.stdout.trim(), "base64") };
    } catch {
      return { status: "unavailable" };
    }
  }

  async checkClusterTransferPath(
    direction: "cloud_to_cluster" | "cluster_to_cloud",
    path: string,
    target: { agentId?: string; siteId?: string } = {},
  ): Promise<ClusterTransferPathCheckResult> {
    if (!this.dispatcher || !this.shellExecRegistry) return { status: "unavailable" };
    const agentId = this.selectOnlineAgent(target);
    if (!agentId) return { status: "unavailable" };
    const requestId = crypto.randomUUID();
    const pending = this.shellExecRegistry.await(requestId, 10_000);
    const command =
      direction === "cluster_to_cloud"
        ? buildClusterSourceFileCheckCommand(path)
        : buildClusterTargetParentCheckCommand(path);
    const queued = this.dispatcher.pushShellExec(agentId, requestId, command, 10);
    if (!queued) {
      this.shellExecRegistry.discard(requestId);
      return { status: "unavailable" };
    }
    try {
      const r = await pending;
      if (r.exitCode === 0) return { status: "ok" };
      if (r.stdout.trim() === "NOT_WRITABLE" || r.exitCode === 3) {
        return { status: "not_writable" };
      }
      return { status: "missing" };
    } catch {
      return { status: "missing" };
    }
  }

  async checkClusterFileRoot(
    path: string,
    target: { agentId?: string; siteId?: string } = {},
  ): Promise<ClusterFileRootCheckResult> {
    if (!this.dispatcher || !this.shellExecRegistry) return { status: "unavailable" };
    const agentId = this.selectOnlineAgent(target);
    if (!agentId) return { status: "unavailable" };
    const requestId = crypto.randomUUID();
    const pending = this.shellExecRegistry.await(requestId, 10_000);
    const queued = this.dispatcher.pushShellExec(
      agentId,
      requestId,
      buildClusterRootCheckCommand(path),
      10,
    );
    if (!queued) {
      this.shellExecRegistry.discard(requestId);
      return { status: "unavailable" };
    }
    try {
      const r = await pending;
      if (r.exitCode === 0) return { status: "ok" };
      if (r.stdout.trim() === "NOT_READABLE" || r.exitCode === 4) {
        return { status: "not_readable" };
      }
      if (r.stdout.trim() === "NOT_WRITABLE" || r.exitCode === 3) {
        return { status: "not_writable" };
      }
      return { status: "missing" };
    } catch {
      return { status: "missing" };
    }
  }

  // -------- Cloud objects --------

  listCloud(userId: string, prefix = ""): CloudObject[] {
    return [...this.cloud.values()]
      .filter((o) => o.userId === userId && o.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  createCloud(userId: string, data: CloudObjectCreate): CloudObject {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const obj: CloudObject = {
      id,
      userId,
      key: data.key,
      size: data.size,
      contentType: data.contentType,
      createdAt: now,
      modifiedAt: now,
      etag: hashKey(`${userId}:${data.key}:${data.size}`),
      uploadUrl: `/api/files/cloud/${id}/upload`,
    };
    this.cloud.set(id, obj);
    return obj;
  }

  rename(userId: string, id: string, data: CloudObjectRename): CloudObject {
    const o = this.requireOwnedCloud(userId, id);
    const updated: CloudObject = {
      ...o,
      key: data.key,
      modifiedAt: new Date().toISOString(),
    };
    this.cloud.set(id, updated);
    return updated;
  }

  deleteCloud(userId: string, id: string): void {
    const o = this.requireOwnedCloud(userId, id);
    this.cloud.delete(o.id);
  }

  // -------- Transfers --------

  listTransfers(userId: string, filter?: FileTransferListFilter): Promise<Transfer[]> {
    return this.transferStore.listByUser(userId, filter);
  }

  async createTransfer(
    userId: string,
    data: TransferCreate,
    actorUserId?: string | null,
    options: TransferDispatchOptions = {},
  ): Promise<Transfer> {
    const id = crypto.randomUUID();
    const total = data.totalBytes ?? null;
    const canRun = this.runner?.canHandle(data) ?? false;
    const now = new Date().toISOString();
    const netdriveFileIds =
      data.netdriveFileIds ?? (data.sourceFileId ? [data.sourceFileId] : undefined);
    const t: Transfer = {
      id,
      userId,
      direction: data.direction,
      source: data.source,
      target: data.target,
      sourceFileId: data.sourceFileId,
      agentId: data.agentId ?? null,
      siteId: data.siteId ?? null,
      totalBytes: total,
      copiedBytes: 0,
      state: canRun ? "queued" : "failed",
      startedAt: null,
      finishedAt: canRun ? null : now,
      error: canRun ? null : "real transfer backend unavailable or no online agent",
      clusterRootId: null,
      clusterRootRevision: null,
      rootPolicyChangedAt: null,
      jobId: data.jobId,
      workflowRunId: data.workflowRunId,
      netdriveFileIds,
    };
    await this.transferStore.create(t);
    if (this.runner && canRun) {
      void this.dispatchTransfer(userId, actorUserId, id, data, options);
    }
    return t;
  }

  async cancelTransfer(userId: string, id: string): Promise<Transfer> {
    const t = await this.requireOwnedTransfer(userId, id);
    if (t.state !== "running" && t.state !== "queued") return t;
    if (t.state === "running") {
      const accepted = (await this.runner?.cancel(id)) ?? true;
      if (!accepted) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Transfer can no longer be cancelled because completion has already started",
          409,
          { reason: "TRANSFER_CANCELLATION_NOT_ACCEPTED" },
        );
      }
    }
    this.stopTicker(id);
    const updated = await this.transferStore.transition(userId, id, t.state, {
      state: "cancelled",
      finishedAt: new Date().toISOString(),
    });
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, "Transfer not found", 404);
    }
    return updated;
  }

  reconcileInterruptedTransfers(): Promise<number> {
    return this.transferStore.markInterrupted("TRANSFER_INTERRUPTED_BY_SERVER_RESTART");
  }

  markRunningTransfersRootPolicyChanged(rootId: string, changedAt: string): Promise<Transfer[]> {
    return this.transferStore.markRunningRootPolicyChanged(rootId, changedAt);
  }

  /**
   * Cancel all timers — call from process shutdown.
   * Public so the test harness can clean up between runs.
   */
  shutdown(): void {
    for (const id of this.tickers.keys()) this.stopTicker(id);
  }

  // -------- internals --------

  private stopTicker(id: string): void {
    const tick = this.tickers.get(id);
    if (tick) {
      clearInterval(tick);
      this.tickers.delete(id);
    }
  }

  private async dispatchTransfer(
    userId: string,
    actorUserId: string | null | undefined,
    id: string,
    data: TransferCreate,
    options: TransferDispatchOptions,
  ): Promise<void> {
    try {
      const authorization = await options.beforeDispatch?.();
      const running = await this.transferStore.transition(userId, id, "queued", {
        state: "running",
        startedAt: new Date().toISOString(),
        error: null,
        ...(authorization
          ? {
              clusterRootId: authorization.clusterRootId,
              clusterRootRevision: authorization.clusterRootRevision,
            }
          : {}),
      });
      if (!running || !this.runner) return;
    } catch (error) {
      const reason =
        error instanceof Error && error.message === "TRANSFER_ROOT_AUTHORIZATION_REVOKED"
          ? error.message
          : "TRANSFER_ROOT_AUTHORIZATION_UNAVAILABLE";
      await this.transferStore.transition(userId, id, "queued", {
        state: "failed",
        finishedAt: new Date().toISOString(),
        error: reason,
      });
      return;
    }

    try {
      await this.runner.start(actorUserId, id, data, (event) => {
        void this.applyTransferProgress(userId, id, event);
      });
    } catch (error) {
      await this.transferStore.transition(userId, id, "running", {
        state: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyTransferProgress(
    userId: string,
    id: string,
    event: TransferProgressEvent,
  ): Promise<void> {
    const current = await this.transferStore.getByUser(userId, id);
    if (!current || current.state !== "running") return;
    const finished = event.state !== "running";
    await this.transferStore.update(userId, id, {
      copiedBytes: event.copiedBytes || current.copiedBytes,
      state: event.state,
      finishedAt: finished ? new Date().toISOString() : null,
      error: event.error ?? null,
      ...(event.netdriveFileIds ? { netdriveFileIds: event.netdriveFileIds } : {}),
    });
  }

  private requireOwnedCloud(userId: string, id: string): CloudObject {
    const o = this.cloud.get(id);
    if (!o || o.userId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND, "Cloud object not found", 404);
    }
    return o;
  }

  private async requireOwnedTransfer(userId: string, id: string): Promise<Transfer> {
    const t = await this.transferStore.getByUser(userId, id);
    if (!t || t.userId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND, "Transfer not found", 404);
    }
    return t;
  }

  private selectOnlineAgent(target: { agentId?: string; siteId?: string }): string | null {
    if (!this.dispatcher) return null;
    const online = this.dispatcher.onlineAgentIds();
    if (target.agentId) return online.includes(target.agentId) ? target.agentId : null;
    if (target.siteId) return online.includes(target.siteId) ? target.siteId : null;
    return online[0] ?? null;
  }
}

function parseLsLa(stdout: string): ClusterEntry[] {
  const out: ClusterEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || line.startsWith("total ")) continue;
    // Format: drwxr-xr-x  2 user group  4096 2026-05-13 02:54 name
    const m = line.match(/^([-d])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+)\s+(.+)$/);
    if (!m) continue;
    const [, type, sizeStr, dateStr, rawName] = m;
    if (!rawName) continue;
    const name = rawName.trim();
    if (name === "." || name === "..") continue;
    out.push({
      name,
      kind: type === "d" ? "dir" : "file",
      size: type === "d" ? null : Number.parseInt(sizeStr ?? "0", 10),
      modifiedAt: new Date(`${dateStr ?? ""}Z`).toISOString(),
    });
  }
  return out;
}

function hashKey(s: string): string {
  // Lightweight non-cryptographic hash adequate for an ETag in the in-memory mock.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `"${(h >>> 0).toString(16).padStart(8, "0")}"`;
}
