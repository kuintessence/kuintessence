import { apiErrorReason, type Transfer } from "@kuintessence/shared/browser";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { relativeFromNow } from "../../lib/format";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type Filter = "ACTIVE" | "FAILED" | "COMPLETED" | "ALL";

const TRANSFER_ERROR_KEYS: Record<string, string> = {
  CLUSTER_SOURCE_FILE_UNAVAILABLE: "files.transfers.error.clusterSourceUnavailable",
  CLUSTER_TARGET_DIR_UNAVAILABLE: "files.transfers.error.clusterTargetDirUnavailable",
  CLUSTER_TARGET_DIR_NOT_WRITABLE: "files.transfers.error.clusterTargetDirNotWritable",
  CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE:
    "files.transfers.error.clusterTransferPreflightUnavailable",
  INVALID_FILE_REFERENCE_KIND: "files.transfers.error.invalidFileReferenceKind",
  NETDRIVE_SOURCE_FILE_UNAVAILABLE: "files.transfers.error.netdriveSourceUnavailable",
  NETDRIVE_SOURCE_PATH_AMBIGUOUS: "files.transfers.error.invalidFileReferenceKind",
  TRANSFER_INTERRUPTED_BY_SERVER_RESTART: "files.transfers.error.interruptedByServerRestart",
  TRANSFER_PATH_OUTSIDE_ALLOWED_ROOT: "files.transfers.error.transferPathOutsideAllowedRoot",
  TRANSFER_ROOT_AUTHORIZATION_REVOKED: "files.transfers.error.rootAuthorizationRevoked",
  TRANSFER_ROOT_AUTHORIZATION_UNAVAILABLE: "files.transfers.error.rootAuthorizationUnavailable",
};

export interface TransfersTrayProps {
  transfers: Transfer[];
  onChanged: () => void | Promise<void>;
  loadError?: string | null;
  isLoading?: boolean;
  onRetryLoad?: () => void;
  isRetryingLoad?: boolean;
  highlightTransferId?: string | null;
  embedded?: boolean;
}

const STATE_DOT: Record<string, string> = {
  queued: "bg-[var(--status-pending)]",
  running: "bg-[var(--status-running)]",
  succeeded: "bg-[var(--status-succeeded)]",
  failed: "bg-[var(--status-failed)]",
  cancelled: "bg-[var(--status-cancelled)]",
};

function fmtBytes(b: number | null | undefined): string {
  if (b == null || b === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function TransfersTray({
  transfers,
  onChanged,
  loadError = null,
  isLoading = false,
  onRetryLoad,
  isRetryingLoad = false,
  highlightTransferId,
  embedded = false,
}: TransfersTrayProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set());
  const pendingActionsRef = useRef(new Set<string>());

  const runTransferAction = async (
    actionKey: string,
    request: () => Promise<Transfer>,
    fallbackErrorKey: string,
  ) => {
    if (pendingActionsRef.current.has(actionKey)) return;
    pendingActionsRef.current.add(actionKey);
    setPendingActions(new Set(pendingActionsRef.current));
    try {
      await request();
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError && apiErrorReason(err) === "TRANSFER_CANCELLATION_NOT_ACCEPTED"
          ? t("files.transfers.cancelTooLate")
          : toUserFacingError(err, t(fallbackErrorKey)),
      );
    } finally {
      pendingActionsRef.current.delete(actionKey);
      setPendingActions(new Set(pendingActionsRef.current));
    }
  };

  const counts = {
    ACTIVE: transfers.filter((t) => t.state === "running" || t.state === "queued").length,
    FAILED: transfers.filter((t) => t.state === "failed").length,
    COMPLETED: transfers.filter((t) => t.state === "succeeded" || t.state === "cancelled").length,
    ALL: transfers.length,
  };

  const visible = transfers.filter((t) => {
    if (filter === "ALL") return true;
    if (filter === "ACTIVE") return t.state === "running" || t.state === "queued";
    if (filter === "FAILED") return t.state === "failed";
    return t.state === "succeeded" || t.state === "cancelled";
  });
  const orderedVisible =
    filter === "FAILED"
      ? [...visible].sort((a, b) => transferTriageRank(a) - transferTriageRank(b))
      : visible;

  return (
    <aside
      className={cn(
        "flex h-full flex-col overflow-hidden bg-card",
        embedded ? "" : "rounded-md border border-border",
      )}
      data-testid="files-transfers-tray"
      aria-label={t("files.transfers.ariaLabel")}
    >
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-semibold">{t("files.transfers.title")}</span>
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          {(["ACTIVE", "FAILED", "COMPLETED", "ALL"] as const).map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`files-transfers-filter-${f.toLowerCase()}`}
              onClick={() => setFilter(f)}
              className={cn(
                "min-h-11 rounded-full border px-2 py-1 font-mono uppercase tracking-wide sm:min-h-0 sm:py-0.5",
                filter === f
                  ? "border-brand bg-brand-soft text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/60",
              )}
            >
              {filterLabel(f, t)} ({counts[f]})
            </button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div
          className="flex items-center gap-2 border-b border-status-failed/30 bg-status-failed/5 px-3 py-2 text-xs text-status-failed"
          data-testid="files-transfers-load-error"
          role="alert"
          title={loadError}
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{t("files.transfers.loadFailed")}</span>
          {onRetryLoad ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isRetryingLoad}
              onClick={onRetryLoad}
            >
              {isRetryingLoad ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("files.transfers.retryLoad")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        {isLoading && orderedVisible.length === 0 ? (
          <div
            className="flex h-24 items-center justify-center gap-2 text-xs text-muted-foreground"
            data-testid="files-transfers-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : orderedVisible.length === 0 && !loadError ? (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
            {t("files.transfers.emptyFilter")}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {orderedVisible.map((transfer) => {
              const cancelActionKey = `cancel:${transfer.id}`;
              const retryActionKey = `retry:${transfer.id}`;
              const cancelling = pendingActions.has(cancelActionKey);
              const retrying = pendingActions.has(retryActionKey);
              return (
                <li
                  key={transfer.id}
                  data-testid={`files-transfer-${transfer.id}`}
                  className={cn(
                    transfer.id === highlightTransferId ? "kq-motion kq-motion--item" : "",
                    "space-y-1 px-3 py-2 text-xs",
                    transfer.id === highlightTransferId ? "bg-brand-soft/40" : "",
                  )}
                  data-state={transfer.id === highlightTransferId ? "open" : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {transfer.state === "succeeded" ? (
                        <CheckCircle2 className="h-3 w-3 text-[var(--status-succeeded)]" />
                      ) : (
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            STATE_DOT[transfer.state],
                          )}
                        />
                      )}
                      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                        {t(`files.transfers.state.${transfer.state}`)}
                      </span>
                      {isInterruptedTransfer(transfer) ? (
                        <span
                          className="rounded-full border border-status-failed/40 px-1.5 py-0.5 text-[10px] text-status-failed"
                          data-testid={`files-transfer-badge-interrupted-${transfer.id}`}
                        >
                          {t("files.transfers.badge.interrupted")}
                        </span>
                      ) : null}
                      {isRetryableTransfer(transfer) ? (
                        <span
                          className="rounded-full border border-brand/40 px-1.5 py-0.5 text-[10px] text-brand"
                          data-testid={`files-transfer-badge-retryable-${transfer.id}`}
                        >
                          {t("files.transfers.badge.retryable")}
                        </span>
                      ) : null}
                      {transfer.rootPolicyChangedAt ? (
                        <span
                          className="rounded-full border border-status-warning/40 px-1.5 py-0.5 text-[10px] text-status-warning"
                          data-testid={`files-transfer-badge-root-policy-changed-${transfer.id}`}
                        >
                          {t("files.transfers.badge.rootPolicyChanged")}
                        </span>
                      ) : null}
                    </span>
                    {transfer.state === "running" || transfer.state === "queued" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                        aria-label={t("files.transfers.cancel")}
                        data-testid={`files-transfer-cancel-${transfer.id}`}
                        disabled={cancelling}
                        onClick={() =>
                          void runTransferAction(
                            cancelActionKey,
                            () => api.post<Transfer>(`/files/transfers/${transfer.id}/cancel`),
                            "files.transfers.cancelFailed",
                          )
                        }
                      >
                        {cancelling ? <Loader2 className="animate-spin" /> : <X />}
                      </Button>
                    ) : null}
                    {isRetryableTransfer(transfer) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                        aria-label={t("files.transfers.retry")}
                        data-testid={`files-transfer-retry-${transfer.id}`}
                        disabled={retrying}
                        onClick={() =>
                          void runTransferAction(
                            retryActionKey,
                            () =>
                              api.post<Transfer>("/files/transfers", {
                                direction: transfer.direction,
                                source: transfer.source,
                                target: transfer.target,
                                agentId: transfer.agentId ?? undefined,
                                siteId: transfer.siteId ?? undefined,
                                totalBytes: transfer.totalBytes ?? undefined,
                                ...(transfer.sourceFileId
                                  ? { sourceFileId: transfer.sourceFileId }
                                  : {}),
                              }),
                            "files.transfer.startFailed",
                          )
                        }
                      >
                        {retrying ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      </Button>
                    ) : null}
                  </div>
                  <div
                    className="truncate font-mono text-[11px]"
                    title={`${transfer.source} → ${transfer.target}`}
                  >
                    {transfer.source} → {transfer.target}
                  </div>
                  {transfer.totalBytes != null ? (
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-brand"
                        style={{
                          width: `${
                            transfer.totalBytes > 0
                              ? Math.min(
                                  100,
                                  Math.round((transfer.copiedBytes / transfer.totalBytes) * 100),
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  ) : null}
                  <div className="flex justify-between font-mono text-[10px] text-muted-foreground tabular-nums">
                    <span>
                      {fmtBytes(transfer.copiedBytes)} / {fmtBytes(transfer.totalBytes)}
                    </span>
                    <span title={transfer.startedAt ?? undefined}>
                      {transfer.finishedAt
                        ? t("files.transfers.finishedAt", {
                            time: relativeFromNow(transfer.finishedAt),
                          })
                        : transfer.startedAt
                          ? t("files.transfers.startedAt", {
                              time: relativeFromNow(transfer.startedAt),
                            })
                          : t("files.transfers.queued")}
                    </span>
                  </div>
                  {transfer.error ? (
                    <div className="text-[10px] text-status-failed">
                      {formatTransferError(transfer.error, t)}
                    </div>
                  ) : null}
                  {transfer.rootPolicyChangedAt ? (
                    <div
                      className="text-[10px] text-status-warning"
                      title={transfer.rootPolicyChangedAt}
                    >
                      {t("files.transfers.rootPolicyChanged")}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          {t("files.transfers.totalActive", {
            total: transfers.length,
            active: counts.ACTIVE,
          })}
        </span>
      </div>
    </aside>
  );
}

function formatTransferError(error: string, t: (key: string) => string): string {
  const key = TRANSFER_ERROR_KEYS[error];
  if (key) return t(key);
  if (isRawClusterTargetNotWritableError(error)) {
    return t("files.transfers.error.clusterTargetDirNotWritable");
  }
  return isRawMissingClusterSourceError(error)
    ? t("files.transfers.error.clusterSourceUnavailable")
    : t("files.transfers.error.generic");
}

function isInterruptedTransfer(transfer: Transfer): boolean {
  return transfer.error === "TRANSFER_INTERRUPTED_BY_SERVER_RESTART";
}

function isRawMissingClusterSourceError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("enoent") ||
    lower.includes("no such file or directory") ||
    lower.includes("cannot access") ||
    lower.includes("statx")
  );
}

function isRawClusterTargetNotWritableError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("permission denied") ||
    lower.includes("failed writing body") ||
    lower.includes("curl: (23)") ||
    lower.includes("could not create file") ||
    lower.includes("read-only file system")
  );
}

function isRetryableTransfer(transfer: Transfer): boolean {
  if (transfer.state !== "failed") return false;
  if (transfer.error === "TRANSFER_ROOT_AUTHORIZATION_REVOKED") return false;
  if (transfer.rootPolicyChangedAt) return false;
  return transfer.direction === "cluster_to_cloud" || Boolean(transfer.sourceFileId);
}

function transferTriageRank(transfer: Transfer): number {
  if (isInterruptedTransfer(transfer)) return 0;
  if (isRetryableTransfer(transfer)) return 1;
  return 2;
}

function filterLabel(filter: Filter, t: (key: string) => string): string {
  if (filter === "ACTIVE") return t("files.transfers.active");
  if (filter === "COMPLETED") return t("files.transfers.completed");
  if (filter === "ALL") return t("files.transfers.all");
  return t("files.transfers.failed");
}
