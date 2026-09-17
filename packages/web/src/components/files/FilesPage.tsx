import {
  apiErrorReason,
  type CloudObject,
  type ClusterEntry,
  type StorageQuotaSummary,
  type Transfer,
  type TransferDirection,
} from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  ChevronDown,
  ChevronUp,
  DatabaseZap,
  ListChecks,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api, downloadAuthedFile, uploadFileToNetDrive } from "../../lib/api-client";
import { listAllNetDriveFiles } from "../../lib/netdrive-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import type { AgentRow } from "../agents/AgentCard";
import { Button } from "../ui/button";
import { PageHeader, PageShell } from "../ui/page";
import { CloudPane, type CloudPaneEntry } from "./CloudPane";
import { ClusterPane } from "./ClusterPane";
import { DeleteCloudFileDialog } from "./DeleteCloudFileDialog";
import { NewTransferSheet } from "./NewTransferSheet";
import {
  canNavigateClusterUp,
  findClusterRoot,
  isClusterPathWithinRoots,
  parentCloudPrefix,
} from "./path-picker-utils";
import { StorageQuotaRequestDialog } from "./StorageQuotaRequestDialog";
import { TransfersTray } from "./TransfersTray";

interface NetDriveListResp {
  success: true;
  data: {
    files: Array<{
      id: string;
      path: string;
      size: number;
      mtime: string;
      ownerId?: string;
      canUse: boolean;
      canDelete: boolean;
    }>;
    total: number;
  };
}
interface ClusterResp {
  entries: ClusterEntry[];
  siteId: string;
  path: string | null;
  roots?: string[];
}
interface TransfersResp {
  transfers: Transfer[];
}
interface NetDriveDownloadUrlResp {
  success: true;
  data: {
    downloadUrl: string;
    expiresAt: string;
  };
}

const TERMINAL_TRANSFER_STATES = new Set(["succeeded", "failed", "cancelled"]);

export function FilesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const initialSearch = useMemo(() => new URLSearchParams(window.location.search), []);
  const [cloudSelected, setCloudSelected] = useState<string | null>(
    initialSearch.get("cloudFileId"),
  );
  const [clusterSelected, setClusterSelected] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [requestedClusterPath, setRequestedClusterPath] = useState("");
  const [selectedClusterRoot, setSelectedClusterRoot] = useState("");
  const [knownClusterRoots, setKnownClusterRoots] = useState<string[]>([]);
  const [cloudPrefix, setCloudPrefix] = useState<string>(
    normalizeCloudPrefix(initialSearch.get("cloudPrefix") ?? ""),
  );
  const [newTransferOpen, setNewTransferOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<TransferDirection>("cloud_to_cluster");
  const [showTransfers, setShowTransfers] = useState(true);
  const [highlightTransferId, setHighlightTransferId] = useState<string | null>(null);
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CloudPaneEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingCloudId, setDeletingCloudId] = useState<string | null>(null);
  const deletePendingRef = useRef<string | null>(null);
  const seenFinishedTransfers = useRef(new Map<string, string | null>());

  const agentsQ = useQuery({
    queryKey: ["agents-list"],
    queryFn: () => api.get<{ agents: AgentRow[] }>("/agents"),
    refetchInterval: 30_000,
  });
  const onlineAgents = useMemo(
    () => (agentsQ.data?.agents ?? []).filter((a) => a.status.toLowerCase() === "online"),
    [agentsQ.data],
  );
  const selectedAgent = onlineAgents.find((a) => a.agentId === agentId) ?? onlineAgents[0] ?? null;

  const cloudQ = useQuery({
    queryKey: ["files-cloud"],
    queryFn: () => listAllNetDriveFiles() as Promise<NetDriveListResp>,
    refetchInterval: 30_000,
  });
  const storageSummaryQ = useQuery({
    queryKey: ["storage-summary", "cloud", "global"],
    queryFn: () => api.get<StorageQuotaSummary>("/storage/summary?scope=cloud&scopeId=global"),
    refetchInterval: 30_000,
  });
  const clusterQ = useQuery({
    queryKey: ["files-cluster", selectedAgent?.siteName, requestedClusterPath],
    queryFn: () => {
      const query = new URLSearchParams({
        agentId: selectedAgent?.agentId ?? "",
        siteId: selectedAgent?.siteName ?? "default",
      });
      if (requestedClusterPath) query.set("path", requestedClusterPath);
      return api.get<ClusterResp>(`/files/cluster?${query.toString()}`);
    },
    enabled: !!selectedAgent,
    refetchInterval: 30_000,
  });
  const transfersQ = useQuery({
    queryKey: ["files-transfers"],
    queryFn: () => api.get<TransfersResp>("/files/transfers"),
    refetchInterval: 2_000,
  });
  const netdriveError = cloudQ.error instanceof ApiError ? cloudQ.error : null;
  const cloudListError = cloudQ.error instanceof Error ? cloudQ.error : null;
  const agentListError = agentsQ.error instanceof Error ? agentsQ.error : null;
  const clusterListError = clusterQ.error instanceof Error ? clusterQ.error : null;
  const netdriveDisabled =
    netdriveError?.code === "NETDRIVE_DISABLED" ||
    netdriveError?.status === 404 ||
    netdriveError?.status === 503;
  const cloudActionsDisabled = cloudQ.isLoading || Boolean(cloudListError);
  const transferActionsDisabled = cloudActionsDisabled || netdriveDisabled;
  const clusterPath = requestedClusterPath || clusterQ.data?.path || "";
  const responseClusterRoots = useMemo(
    () => clusterQ.data?.roots ?? (clusterQ.data?.path ? [clusterQ.data.path] : []),
    [clusterQ.data],
  );
  const clusterRoots = clusterQ.data ? responseClusterRoots : knownClusterRoots;
  const activeClusterRoot =
    selectedClusterRoot && clusterRoots.includes(selectedClusterRoot)
      ? selectedClusterRoot
      : findClusterRoot(clusterPath, clusterRoots);
  const clusterActionsDisabled =
    agentsQ.isLoading ||
    Boolean(agentListError) ||
    clusterQ.isLoading ||
    Boolean(clusterListError) ||
    !selectedAgent ||
    !clusterPath;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agents-list"] }),
      queryClient.invalidateQueries({ queryKey: ["files-cloud"] }),
      queryClient.invalidateQueries({ queryKey: ["files-cluster"] }),
      queryClient.invalidateQueries({ queryKey: ["files-transfers"] }),
      queryClient.invalidateQueries({ queryKey: ["storage-summary"] }),
    ]);
  };

  const handleUpload = async (files: FileList) => {
    const prefix = cloudPrefix.replace(/\/$/, "") || "users/me";
    for (const file of Array.from(files)) {
      try {
        await uploadFileToNetDrive(file, prefix);
        toast.success(`Uploaded ${file.name}`);
      } catch (err) {
        toast.error(toUserFacingError(err, `Failed to upload ${file.name}`));
      }
    }
    queryClient.invalidateQueries({ queryKey: ["files-cloud"] });
    queryClient.invalidateQueries({ queryKey: ["storage-summary"] });
  };

  const cloudObjects: CloudPaneEntry[] = useMemo(
    () =>
      (cloudQ.data?.data.files ?? []).map((f) => ({
        id: f.id,
        userId: f.ownerId ?? "",
        key: f.path,
        size: f.size,
        contentType: "application/octet-stream",
        createdAt: f.mtime,
        modifiedAt: f.mtime,
        etag: "",
        canUse: f.canUse === true,
        canDelete: f.canDelete === true,
      })),
    [cloudQ.data],
  );
  const clusterEntries = clusterQ.data?.entries ?? [];
  const selectedClusterEntry =
    clusterSelected && clusterQ.data?.path === clusterPath
      ? (clusterEntries.find((entry) => entry.kind === "file" && entry.name === clusterSelected) ??
        null)
      : null;
  const transfers = transfersQ.data?.transfers ?? [];
  const transfersLoadError = transfersQ.error
    ? toUserFacingError(transfersQ.error, t("files.transfers.loadFailed"))
    : null;
  const activeTransferCount = transfers.filter(
    (t) => t.state === "queued" || t.state === "running",
  ).length;
  const selectedCloudObject = cloudObjects.find((entry) => entry.id === cloudSelected) ?? null;
  const cloudSelectionVerified =
    cloudQ.isSuccess && !cloudActionsDisabled && Boolean(selectedCloudObject);
  const cloudSelectionUsable = cloudSelectionVerified && selectedCloudObject?.canUse === true;
  const clusterPathVerified = clusterQ.isSuccess && clusterQ.data.path === clusterPath;
  const clusterSelectionVerified =
    clusterPathVerified && !clusterActionsDisabled && Boolean(selectedClusterEntry);

  useEffect(() => {
    if (!cloudQ.isSuccess || !cloudSelected || !selectedCloudObject) return;
    const targetPrefix = parentCloudPrefix(selectedCloudObject.key);
    if (targetPrefix !== null && targetPrefix !== cloudPrefix) {
      setCloudPrefix(targetPrefix);
    }
  }, [cloudQ.isSuccess, cloudSelected, selectedCloudObject, cloudPrefix]);

  useEffect(() => {
    if (!cloudQ.isSuccess || !cloudSelected || selectedCloudObject) return;
    setCloudSelected(null);
  }, [cloudQ.isSuccess, cloudSelected, selectedCloudObject]);

  useEffect(() => {
    if (!clusterQ.isSuccess || !clusterSelected || selectedClusterEntry) return;
    setClusterSelected(null);
  }, [clusterQ.isSuccess, clusterSelected, selectedClusterEntry]);

  useEffect(() => {
    if (!clusterQ.isSuccess || !clusterPath) return;
    const inferredRoot = findClusterRoot(clusterPath, clusterRoots);
    if (!inferredRoot) return;
    setSelectedClusterRoot((current) =>
      current && clusterRoots.includes(current) && isClusterPathWithinRoots(clusterPath, [current])
        ? current
        : inferredRoot,
    );
  }, [clusterQ.isSuccess, clusterPath, clusterRoots]);

  useEffect(() => {
    if (!clusterQ.isSuccess) return;
    setKnownClusterRoots((current) =>
      current.length === responseClusterRoots.length &&
      current.every((root, index) => root === responseClusterRoots[index])
        ? current
        : responseClusterRoots,
    );
  }, [clusterQ.isSuccess, responseClusterRoots]);

  useEffect(() => {
    if (
      !requestedClusterPath ||
      !(clusterQ.error instanceof ApiError) ||
      clusterQ.error.status !== 403 ||
      apiErrorReason(clusterQ.error) !== "PATH_OUTSIDE_ALLOWED_ROOT"
    ) {
      return;
    }
    setRequestedClusterPath("");
    setSelectedClusterRoot("");
    setKnownClusterRoots([]);
    setClusterSelected(null);
  }, [clusterQ.error, requestedClusterPath]);

  useEffect(() => {
    let shouldRefreshFiles = false;
    const next = new Map<string, string | null>();
    for (const transfer of transfers) {
      const finishedAt = transfer.finishedAt ?? null;
      next.set(transfer.id, finishedAt);
      if (
        finishedAt &&
        TERMINAL_TRANSFER_STATES.has(transfer.state) &&
        seenFinishedTransfers.current.get(transfer.id) !== finishedAt
      ) {
        shouldRefreshFiles = true;
      }
    }
    seenFinishedTransfers.current = next;
    if (shouldRefreshFiles) {
      queryClient.invalidateQueries({ queryKey: ["files-cloud"] });
      queryClient.invalidateQueries({ queryKey: ["files-cluster"] });
      queryClient.invalidateQueries({ queryKey: ["storage-summary"] });
    }
  }, [transfers, queryClient]);

  const openTransfer = (direction?: TransferDirection) => {
    const inferred =
      direction ??
      (clusterSelectionVerified && !cloudSelectionVerified
        ? "cluster_to_cloud"
        : "cloud_to_cluster");
    setTransferDirection(inferred);
    setNewTransferOpen(true);
  };

  const downloadFromUrl = (url: string, filename: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const filenameFromPath = (value: string) => value.split("/").filter(Boolean).pop() ?? "download";

  const handleCloudDownload = async (obj: CloudObject) => {
    try {
      const minted = await api.get<NetDriveDownloadUrlResp>(
        `/netdrive/files/${encodeURIComponent(obj.id)}/download-url`,
      );
      downloadFromUrl(minted.data.downloadUrl, filenameFromPath(obj.key));
    } catch (err) {
      toast.error(toUserFacingError(err, t("files.downloadNetdriveFailed")));
    }
  };

  const requestCloudDelete = (obj: CloudPaneEntry) => {
    if (!obj.canDelete || deletePendingRef.current) return;
    setDeleteError(null);
    setDeleteTarget(obj);
  };

  const confirmCloudDelete = async () => {
    if (!deleteTarget || deletePendingRef.current) return;
    const target = deleteTarget;
    deletePendingRef.current = target.id;
    setDeletingCloudId(target.id);
    setDeleteError(null);
    try {
      await api.delete(`/netdrive/files/${encodeURIComponent(target.id)}`);
      setCloudSelected((current) => (current === target.id ? null : current));
      setDeleteTarget(null);
      toast.success(t("files.deleteDialog.succeeded", { name: filenameFromPath(target.key) }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["files-cloud"] }),
        queryClient.invalidateQueries({ queryKey: ["storage-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["command-workdir-cloud-files"] }),
        queryClient.invalidateQueries({ queryKey: ["data-market", "netdrive"] }),
      ]);
    } catch (err) {
      const message = toUserFacingError(err, t("files.deleteDialog.failed"));
      setDeleteError(message);
      toast.error(message);
    } finally {
      deletePendingRef.current = null;
      setDeletingCloudId(null);
    }
  };

  const handleClusterDownload = async (entry: ClusterEntry) => {
    if (!selectedAgent || entry.kind !== "file") return;
    const fullPath = `${clusterPath.replace(/\/$/, "")}/${entry.name}`;
    try {
      await downloadAuthedFile(
        `/files/cluster/download?agentId=${encodeURIComponent(selectedAgent.agentId)}&siteId=${encodeURIComponent(selectedAgent.siteName)}&path=${encodeURIComponent(fullPath)}`,
        entry.name,
      );
    } catch (err) {
      toast.error(toUserFacingError(err, t("files.downloadClusterFailed")));
    }
  };

  const totalBytes = storageSummaryQ.data?.usedBytes ?? 0;
  const quotaBytes = storageSummaryQ.data?.quotaBytes ?? 0;
  const pct = Math.min(100, Math.round(storageSummaryQ.data?.usagePercent ?? 0));

  return (
    <PageShell data-testid="files-page">
      <PageHeader
        title={t("files.title")}
        subtitle={t("files.subtitle")}
        actions={
          <>
            <div
              className="hidden flex-col items-end gap-1 sm:flex"
              data-testid="files-storage-meter"
              title={t("files.netdriveUsageTitle")}
            >
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {t("files.storage", {
                  used: (totalBytes / 1024 / 1024 / 1024).toFixed(1),
                  total: storageSummaryQ.isLoading
                    ? "—"
                    : (quotaBytes / 1024 / 1024 / 1024).toFixed(1),
                })}
              </span>
              <span className="h-1 w-32 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-brand" style={{ width: `${pct}%` }} />
              </span>
            </div>
            <Button variant="outline" onClick={() => setQuotaDialogOpen(true)}>
              <DatabaseZap />
              {t("files.quota.action")}
            </Button>
            <Button
              data-testid="files-new-transfer-button"
              disabled={transferActionsDisabled}
              title={transferActionsDisabled ? t("files.transfer.netdriveUnavailable") : undefined}
              onClick={() => openTransfer()}
            >
              <Plus />
              {t("files.newTransfer")}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/90 p-3 shadow-sm lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("files.selectionBar")}
          </div>
          <div className="mt-0.5 grid gap-1 font-mono text-[11px] text-muted-foreground md:grid-cols-2">
            <span className="truncate" title={selectedCloudObject?.key ?? t("files.globalCloud")}>
              {cloudSelectionVerified
                ? t("files.cloudSelected", { value: selectedCloudObject?.key ?? "" })
                : t("files.globalCloud")}
            </span>
            <span
              className="truncate"
              title={
                clusterSelectionVerified && clusterSelected
                  ? `${clusterPath}/${clusterSelected}`
                  : ""
              }
            >
              {t("files.clusterSelection", {
                value:
                  clusterSelectionVerified && clusterSelected
                    ? `${clusterPath.replace(/\/$/, "")}/${clusterSelected}`
                    : t("files.selectedNoneShort"),
              })}
            </span>
          </div>
        </div>
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-center"
          data-testid="files-actions"
        >
          <Button
            variant="outline"
            className="justify-center"
            aria-label={t("files.pushToCluster")}
            title={t("files.pushToCluster")}
            data-testid="files-push"
            disabled={
              transferActionsDisabled ||
              !cloudSelectionUsable ||
              !selectedAgent ||
              !clusterPathVerified
            }
            onClick={() => openTransfer("cloud_to_cluster")}
          >
            <ArrowRightFromLine />
            {t("files.pushToCluster")}
          </Button>
          <Button
            variant="outline"
            className="justify-center"
            aria-label={t("files.pullToCloud")}
            title={t("files.pullToCloud")}
            data-testid="files-pull"
            disabled={transferActionsDisabled || !clusterSelectionVerified}
            onClick={() => openTransfer("cluster_to_cloud")}
          >
            <ArrowLeftFromLine />
            {t("files.pullToCloud")}
          </Button>
        </div>
      </div>

      <StorageQuotaRequestDialog
        open={quotaDialogOpen}
        onOpenChange={setQuotaDialogOpen}
        summary={storageSummaryQ.data ?? null}
        summaryLoading={storageSummaryQ.isLoading}
        summaryError={
          storageSummaryQ.error
            ? toUserFacingError(storageSummaryQ.error, t("files.quota.summaryLoadFailed"))
            : null
        }
        onRetrySummary={() => void storageSummaryQ.refetch()}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CloudPane
          title={t("files.netdriveTitle")}
          emptyMessage={t("files.netdriveEmpty")}
          disabledMessage={
            cloudQ.isLoading
              ? t("common.loading")
              : cloudListError
                ? netdriveDisabled
                  ? t("files.netdriveDisabled")
                  : toUserFacingError(cloudListError, t("files.pathPicker.loadFailed"))
                : undefined
          }
          prefix={cloudPrefix}
          entries={cloudActionsDisabled ? [] : cloudObjects}
          selected={cloudSelectionVerified ? cloudSelected : null}
          onSelect={(next) => {
            if (!cloudActionsDisabled) setCloudSelected(next);
          }}
          onRefresh={refresh}
          onUpload={cloudActionsDisabled ? undefined : handleUpload}
          onDownload={cloudActionsDisabled ? undefined : handleCloudDownload}
          onDelete={cloudActionsDisabled ? undefined : requestCloudDelete}
          deletingId={deletingCloudId}
          onPrefixChange={(next) => {
            setCloudPrefix(next);
            setCloudSelected(null);
          }}
        />
        <ClusterPane
          title={t("files.clusterTitle")}
          emptyMessage={t("files.clusterEmpty")}
          noAgentMessage={t("files.clusterNoAgent")}
          disabledMessage={
            agentsQ.isLoading
              ? t("common.loading")
              : agentListError
                ? t("files.clusterAgentsLoadFailed")
                : clusterQ.isLoading
                  ? t("common.loading")
                  : clusterListError
                    ? toUserFacingError(clusterListError, t("files.pathPicker.loadFailed"))
                    : clusterQ.isSuccess && !clusterPath
                      ? t("files.clusterNoAuthorizedRoot")
                      : undefined
          }
          agent={selectedAgent}
          path={clusterPath}
          roots={clusterRoots}
          activeRoot={activeClusterRoot}
          canNavigateUp={canNavigateClusterUp(clusterPath, [activeClusterRoot])}
          entries={clusterActionsDisabled ? [] : clusterEntries}
          selected={clusterSelectionVerified ? clusterSelected : null}
          onSelect={(next) => {
            if (!clusterActionsDisabled) setClusterSelected(next);
          }}
          onAgentChange={(next) => {
            setAgentId(next);
            setRequestedClusterPath("");
            setSelectedClusterRoot("");
            setKnownClusterRoots([]);
            setClusterSelected(null);
          }}
          onRootChange={(next) => {
            if (!clusterRoots.includes(next)) return;
            setSelectedClusterRoot(next);
            setRequestedClusterPath(next);
            setClusterSelected(null);
          }}
          onRefresh={refresh}
          onPathChange={(next) => {
            if (!isClusterPathWithinRoots(next, [activeClusterRoot])) return;
            setRequestedClusterPath(next);
            setClusterSelected(null);
          }}
          onDownload={clusterActionsDisabled ? undefined : handleClusterDownload}
          agents={onlineAgents}
        />
      </div>

      <section
        className="overflow-hidden rounded-md border border-border bg-card"
        data-testid="files-transfers-section"
      >
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left hover:bg-muted/40"
          onClick={() => setShowTransfers((value) => !value)}
          data-testid="files-transfers-toggle"
        >
          <span className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t("files.transfers.recentTitle")}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {t("files.transfers.totalActive", {
                total: transfers.length,
                active: activeTransferCount,
              })}
            </span>
          </span>
          {showTransfers ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {showTransfers ? (
          <TransfersTray
            transfers={transfers}
            onChanged={refresh}
            loadError={transfersLoadError}
            isLoading={transfersQ.isLoading}
            onRetryLoad={() => void transfersQ.refetch()}
            isRetryingLoad={transfersQ.isFetching}
            highlightTransferId={highlightTransferId}
            embedded
          />
        ) : null}
      </section>

      <NewTransferSheet
        open={newTransferOpen}
        onOpenChange={setNewTransferOpen}
        initialDirection={transferDirection}
        cloudObjects={cloudActionsDisabled ? [] : cloudObjects}
        cloudListVerified={cloudQ.isSuccess && !cloudActionsDisabled}
        cloudSelected={cloudSelectionUsable ? cloudSelected : null}
        clusterAgent={selectedAgent}
        clusterPath={clusterPath}
        clusterPathVerified={clusterPathVerified}
        clusterSelected={clusterSelectionVerified ? clusterSelected : null}
        onCreated={(transfer) => {
          setHighlightTransferId(transfer.id);
          setShowTransfers(true);
          queryClient.invalidateQueries({ queryKey: ["files-transfers"] });
        }}
      />
      <DeleteCloudFileDialog
        file={deleteTarget}
        error={deleteError}
        pending={deletingCloudId !== null}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void confirmCloudDelete()}
      />
    </PageShell>
  );
}

function normalizeCloudPrefix(value: string): string {
  const trimmed = value.replace(/^\/+/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}
