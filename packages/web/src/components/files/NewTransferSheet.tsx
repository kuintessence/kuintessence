import {
  apiErrorReason,
  type CloudObject,
  type Transfer,
  type TransferDirection,
} from "@kuintessence/shared/browser";
import { ArrowLeftFromLine, ArrowRightFromLine, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import type { AgentRow } from "../agents/AgentCard";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { PathPickerField, type PathPickerSelection } from "./PathPickerSheet";

const DIRECTIONS: ReadonlyArray<{
  value: TransferDirection;
  icon: typeof ArrowRightFromLine;
  labelKey: string;
  hintKey: string;
}> = [
  {
    value: "cloud_to_cluster",
    icon: ArrowRightFromLine,
    labelKey: "files.transfer.cloudToCluster.label",
    hintKey: "files.transfer.cloudToCluster.hint",
  },
  {
    value: "cluster_to_cloud",
    icon: ArrowLeftFromLine,
    labelKey: "files.transfer.clusterToCloud.label",
    hintKey: "files.transfer.clusterToCloud.hint",
  },
];

function basenameFromPath(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? "";
}

function appendBasename(directory: string, basename: string): string {
  if (!directory.trim()) return basename;
  const normalized = directory.trim();
  return `${normalized.replace(/\/$/, "")}/${basename}`;
}

function buildTargetPath(
  target: string,
  targetSelection: PathPickerSelection | null,
  basename: string,
): string {
  const normalized = target.trim();
  if (!basename) return normalized;
  if (targetSelection?.mode === "directory") return appendBasename(targetSelection.path, basename);
  if (normalized.endsWith("/")) return `${normalized}${basename}`;
  return normalized;
}

const TRANSFER_START_ERROR_KEYS: Record<string, string> = {
  CLUSTER_SOURCE_FILE_UNAVAILABLE: "files.transfer.error.clusterSourceUnavailable",
  CLUSTER_TARGET_DIR_UNAVAILABLE: "files.transfer.error.clusterTargetDirUnavailable",
  CLUSTER_TARGET_DIR_NOT_WRITABLE: "files.transfer.error.clusterTargetDirNotWritable",
  CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE:
    "files.transfer.error.clusterTransferPreflightUnavailable",
  INVALID_FILE_REFERENCE_KIND: "files.transfer.error.invalidFileReferenceKind",
  NETDRIVE_SOURCE_FILE_UNAVAILABLE: "files.transfer.error.netdriveSourceUnavailable",
  NETDRIVE_SOURCE_PATH_AMBIGUOUS: "files.transfer.error.invalidFileReferenceKind",
  TRANSFER_PATH_OUTSIDE_ALLOWED_ROOT: "files.transfer.error.transferPathOutsideAllowedRoot",
};

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

function formatTransferStartError(err: unknown, t: (key: string) => string): string {
  if (!(err instanceof ApiError)) return t("files.transfer.startFailed");
  const reason = apiErrorReason(err);
  if (reason) {
    const key = TRANSFER_START_ERROR_KEYS[reason];
    if (key) return t(key);
  }
  const codeKey = TRANSFER_START_ERROR_KEYS[err.code];
  if (codeKey) return t(codeKey);
  if (isRawClusterTargetNotWritableError(err.message)) {
    return t("files.transfer.error.clusterTargetDirNotWritable");
  }
  if (isRawMissingClusterSourceError(err.message)) {
    return t("files.transfer.error.clusterSourceUnavailable");
  }
  return toUserFacingError(err, t("files.transfer.startFailed"));
}

export interface NewTransferSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDirection: TransferDirection;
  cloudObjects: CloudObject[];
  cloudListVerified: boolean;
  cloudSelected: string | null;
  clusterAgent: AgentRow | null;
  clusterPath: string;
  clusterPathVerified: boolean;
  clusterSelected: string | null;
  onCreated: (t: Transfer) => void;
}

export function NewTransferSheet({
  open,
  onOpenChange,
  initialDirection,
  cloudObjects,
  cloudListVerified,
  cloudSelected,
  clusterAgent,
  clusterPath,
  clusterPathVerified,
  clusterSelected,
  onCreated,
}: NewTransferSheetProps) {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<TransferDirection>(initialDirection);
  const [sourceSelection, setSourceSelection] = useState<PathPickerSelection | null>(null);
  const [target, setTarget] = useState<string>("");
  const [targetSelection, setTargetSelection] = useState<PathPickerSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [clusterContextInvalidated, setClusterContextInvalidated] = useState(false);
  const [cloudSourceInvalidated, setCloudSourceInvalidated] = useState(false);
  const pendingRef = useRef(false);
  const initializedDirection = useRef<TransferDirection | null>(null);
  const previousClusterContext = useRef<string | null>(null);
  const hasVerifiedClusterContext = useRef(false);
  const hadCloudSource = useRef(false);

  const cloudObj = cloudObjects.find((o) => o.id === cloudSelected) ?? null;
  const cloudObjKey = cloudObj?.key ?? null;
  const clusterAgentId = clusterAgent?.agentId ?? null;
  const clusterAgentSiteName = clusterAgent?.siteName ?? null;
  const clusterContext = JSON.stringify({
    agentId: clusterAgentId,
    siteId: clusterAgentSiteName,
    path: clusterPath,
    verified: clusterPathVerified,
    selected: clusterSelected,
  });
  const pageClusterSource = clusterSelected
    ? `${clusterPath.replace(/\/$/, "")}/${clusterSelected}`
    : "";
  const sourcePath =
    sourceSelection?.path ??
    (direction === "cloud_to_cluster" ? (cloudObj?.key ?? "") : pageClusterSource);
  const sourceLabel =
    sourcePath ||
    (direction === "cloud_to_cluster"
      ? t("files.transfer.pickCloudObjectPlaceholder")
      : t("files.transfer.pickClusterFilePlaceholder"));
  const sourceName = basenameFromPath(sourcePath);
  const finalTarget = buildTargetPath(target, targetSelection, sourceName);
  const executionAgentId =
    direction === "cloud_to_cluster"
      ? (targetSelection?.agentId ?? clusterAgent?.agentId)
      : (sourceSelection?.agentId ?? clusterAgent?.agentId);
  const executionSiteId =
    direction === "cloud_to_cluster"
      ? (targetSelection?.siteId ?? clusterAgent?.siteName)
      : (sourceSelection?.siteId ?? clusterAgent?.siteName);
  const executionClusterLabel =
    clusterAgent && clusterAgent.agentId === executionAgentId
      ? `${clusterAgent.siteName} · ${clusterAgent.schedulerType} ${clusterAgent.schedulerVersion}`
      : (executionSiteId ?? executionAgentId ?? "—");

  useEffect(() => {
    if (!open) {
      initializedDirection.current = null;
      previousClusterContext.current = null;
      hasVerifiedClusterContext.current = false;
      return;
    }
    setDirection(initialDirection);
    setSourceSelection(null);
    setTargetSelection(null);
    initializedDirection.current = null;
  }, [open, initialDirection]);

  useEffect(() => {
    if (!open || initializedDirection.current === direction) return;
    initializedDirection.current = direction;
    hasVerifiedClusterContext.current = clusterPathVerified;
    setSourceSelection(null);
    setTargetSelection(null);
    setClusterContextInvalidated(false);
    setCloudSourceInvalidated(false);
    hadCloudSource.current = direction === "cloud_to_cluster" && Boolean(cloudObjKey);
    if (direction === "cloud_to_cluster") {
      if (clusterPathVerified && clusterAgentId && clusterAgentSiteName) {
        setTarget(`${clusterPath.replace(/\/$/, "")}/`);
        setTargetSelection({
          location: "cluster",
          mode: "directory",
          path: clusterPath.replace(/\/$/, "") || "/",
          agentId: clusterAgentId,
          siteId: clusterAgentSiteName,
          name: basenameFromPath(clusterPath) || "/",
        });
      } else {
        setTarget("");
        setClusterContextInvalidated(true);
      }
    } else if (cloudObjKey) {
      setTarget(cloudObjKey.replace(/[^/]+$/, ""));
    } else {
      setTarget("uploads/");
    }
  }, [
    open,
    direction,
    clusterPath,
    clusterPathVerified,
    clusterAgentId,
    clusterAgentSiteName,
    cloudObjKey,
  ]);

  useEffect(() => {
    if (!open) {
      previousClusterContext.current = null;
      return;
    }
    if (previousClusterContext.current === null) {
      previousClusterContext.current = clusterContext;
      return;
    }
    if (previousClusterContext.current === clusterContext) return;
    previousClusterContext.current = clusterContext;
    if (!hasVerifiedClusterContext.current && clusterPathVerified) {
      hasVerifiedClusterContext.current = true;
      if (direction === "cloud_to_cluster" && clusterAgentId && clusterAgentSiteName) {
        setTarget(`${clusterPath.replace(/\/$/, "")}/`);
        setTargetSelection({
          location: "cluster",
          mode: "directory",
          path: clusterPath.replace(/\/$/, "") || "/",
          agentId: clusterAgentId,
          siteId: clusterAgentSiteName,
          name: basenameFromPath(clusterPath) || "/",
        });
        setClusterContextInvalidated(false);
      }
      return;
    }
    if (direction === "cloud_to_cluster") {
      setTargetSelection(null);
      setTarget("");
    } else {
      setSourceSelection(null);
    }
    setClusterContextInvalidated(true);
  }, [
    open,
    direction,
    clusterContext,
    clusterPath,
    clusterPathVerified,
    clusterAgentId,
    clusterAgentSiteName,
  ]);

  const pickSource = (selection: PathPickerSelection) => {
    setSourceSelection(selection);
    if (direction === "cloud_to_cluster" && selection.location === "cloud") {
      hadCloudSource.current = true;
      setCloudSourceInvalidated(false);
    }
    if (direction === "cluster_to_cloud" && selection.location === "cluster") {
      setClusterContextInvalidated(false);
    }
  };

  const pickTarget = (selection: PathPickerSelection) => {
    setTargetSelection(selection);
    setTarget(selection.path);
    if (direction === "cloud_to_cluster" && selection.location === "cluster") {
      setClusterContextInvalidated(false);
    }
  };

  useEffect(() => {
    if (!open || direction !== "cloud_to_cluster") return;
    const pickerSource = sourceSelection?.location === "cloud" ? sourceSelection : null;
    const hasCloudSource = Boolean(pickerSource || cloudObjKey);
    if (hasCloudSource) hadCloudSource.current = true;
    if (!cloudListVerified) {
      if (pickerSource) setSourceSelection(null);
      if (hasCloudSource || hadCloudSource.current) setCloudSourceInvalidated(true);
      return;
    }
    if (
      pickerSource &&
      !cloudObjects.some(
        (object) => object.id === pickerSource.id && object.key === pickerSource.path,
      )
    ) {
      setSourceSelection(null);
      setCloudSourceInvalidated(true);
      return;
    }
    if (hadCloudSource.current && !hasCloudSource) {
      setCloudSourceInvalidated(true);
    }
  }, [open, direction, cloudListVerified, cloudObjects, cloudObjKey, sourceSelection]);

  const cloudContextBlocked =
    !cloudListVerified || (direction === "cloud_to_cluster" && cloudSourceInvalidated);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pendingRef.current) return;
    if (clusterContextInvalidated) {
      toast.error(t("files.transfer.clusterContextChanged"));
      return;
    }
    if (!cloudListVerified) {
      toast.error(t("files.transfer.cloudContextUnavailable"));
      return;
    }
    if (direction === "cloud_to_cluster" && cloudSourceInvalidated) {
      toast.error(t("files.transfer.cloudSourceChanged"));
      return;
    }
    if (!sourcePath) {
      toast.error(
        direction === "cloud_to_cluster"
          ? t("files.transfer.pickCloudObjectFirst")
          : t("files.transfer.pickClusterFileFirst"),
      );
      return;
    }
    if (direction === "cloud_to_cluster" && !cloudObj && sourceSelection?.location !== "cloud") {
      toast.error(t("files.transfer.pickCloudObjectOnLeft"));
      return;
    }
    if (
      direction === "cluster_to_cloud" &&
      !clusterSelected &&
      sourceSelection?.location !== "cluster"
    ) {
      toast.error(t("files.transfer.pickClusterFileOnRight"));
      return;
    }
    if (!target.trim() && targetSelection?.path !== "") {
      toast.error(t("files.transfer.targetRequired"));
      return;
    }
    if (direction === "cloud_to_cluster" && targetSelection?.location !== "cluster") {
      toast.error(t("files.transfer.pickClusterTargetDirectory"));
      return;
    }
    pendingRef.current = true;
    setBusy(true);
    try {
      const source = sourcePath;
      const totalBytes =
        direction === "cloud_to_cluster" ? (sourceSelection?.size ?? cloudObj?.size) : undefined;
      const sourceFileId =
        direction === "cloud_to_cluster" ? (sourceSelection?.id ?? cloudObj?.id) : undefined;
      const normalizedTarget = finalTarget;
      const t = await api.post<Transfer>("/files/transfers", {
        direction,
        source,
        target: normalizedTarget,
        ...(sourceFileId ? { sourceFileId } : {}),
        agentId: executionAgentId,
        siteId: executionSiteId,
        totalBytes,
      });
      onCreated(t);
      onOpenChange(false);
    } catch (err) {
      toast.error(formatTransferStartError(err, t));
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => (!pendingRef.current ? onOpenChange(nextOpen) : undefined)}
    >
      <SheetContent data-testid="files-new-transfer" dismissible={!busy}>
        <SheetHeader>
          <SheetTitle>{t("files.transfer.newTitle")}</SheetTitle>
          <SheetDescription>{t("files.transfer.newDescription")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="files-new-transfer-form"
            onSubmit={onSubmit}
            className="space-y-4"
            data-testid="files-new-transfer-form"
          >
            <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
              <div className="grid grid-cols-1 gap-2">
                {DIRECTIONS.map((d) => {
                  const Icon = d.icon;
                  const selected = direction === d.value;
                  return (
                    <button
                      key={d.value}
                      type="button"
                      data-testid={`files-direction-${d.value}`}
                      onClick={() => setDirection(d.value)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selected
                          ? "border-brand bg-brand-soft text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4" />
                      <span className="flex flex-col">
                        <span className="font-medium text-foreground">{t(d.labelKey)}</span>
                        <span className="text-[11px] text-muted-foreground">{t(d.hintKey)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("files.transfer.source")}
                </span>
                <PathPickerField
                  value={sourceLabel}
                  testId="files-new-transfer-source"
                  mode="file"
                  locations={[direction === "cloud_to_cluster" ? "cloud" : "cluster"]}
                  initialLocation={direction === "cloud_to_cluster" ? "cloud" : "cluster"}
                  initialCloudPrefix={
                    direction === "cloud_to_cluster" && sourcePath
                      ? sourcePath.replace(/[^/]+$/, "")
                      : ""
                  }
                  initialClusterPath={
                    direction === "cluster_to_cloud" ? clusterPath : clusterPath.replace(/\/$/, "")
                  }
                  initialAgentId={clusterAgent?.agentId ?? null}
                  title={t("files.transfer.selectSourceTitle")}
                  description={t("files.transfer.selectSourceDescription")}
                  onSelect={pickSource}
                />
              </div>

              <div className="space-y-1.5">
                <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("files.transfer.executionCluster")}
                </span>
                <div
                  className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
                  data-testid="files-new-transfer-execution-cluster"
                >
                  {executionClusterLabel}
                </div>
              </div>

              {clusterContextInvalidated ? (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                  role="alert"
                  data-testid="files-new-transfer-cluster-context-invalid"
                >
                  {t("files.transfer.clusterContextChanged")}
                </p>
              ) : null}

              {cloudContextBlocked ? (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                  role="alert"
                  data-testid="files-new-transfer-cloud-context-invalid"
                >
                  {cloudListVerified
                    ? t("files.transfer.cloudSourceChanged")
                    : t("files.transfer.cloudContextUnavailable")}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("files.transfer.targetPath")}
                </span>
                <PathPickerField
                  value={target}
                  testId="files-new-transfer-target"
                  mode="directory"
                  locations={[direction === "cloud_to_cluster" ? "cluster" : "cloud"]}
                  initialLocation={direction === "cloud_to_cluster" ? "cluster" : "cloud"}
                  initialCloudPrefix={direction === "cluster_to_cloud" ? target : "uploads/"}
                  initialClusterPath={
                    direction === "cloud_to_cluster" ? target.replace(/\/$/, "") : clusterPath
                  }
                  initialAgentId={clusterAgent?.agentId ?? null}
                  title={t("files.transfer.selectTargetTitle")}
                  description={t("files.transfer.selectTargetDescription")}
                  onSelect={pickTarget}
                />
                <p className="text-[11px] text-muted-foreground">
                  {direction === "cloud_to_cluster"
                    ? t("files.transfer.clusterTargetPathHelp")
                    : t("files.transfer.targetPathHelp")}
                </p>
              </div>

              <div
                className="space-y-2 rounded-md border border-border bg-card/60 p-3"
                data-testid="files-new-transfer-summary"
              >
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("files.transfer.summary")}
                </div>
                <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{t("files.transfer.summaryDirection")}</dt>
                  <dd className="min-w-0 truncate font-mono">
                    {direction === "cloud_to_cluster"
                      ? t("files.transfer.cloudToCluster.label")
                      : t("files.transfer.clusterToCloud.label")}
                  </dd>
                  <dt className="text-muted-foreground">{t("files.transfer.summarySource")}</dt>
                  <dd className="min-w-0 truncate font-mono" title={sourcePath || sourceLabel}>
                    {sourcePath || sourceLabel}
                  </dd>
                  <dt className="text-muted-foreground">{t("files.transfer.summaryCluster")}</dt>
                  <dd className="min-w-0 truncate font-mono" title={executionClusterLabel}>
                    {executionClusterLabel}
                  </dd>
                  <dt className="text-muted-foreground">{t("files.transfer.summaryTarget")}</dt>
                  <dd className="min-w-0 truncate font-mono" title={finalTarget || target}>
                    {finalTarget || target || t("files.pathPicker.emptyValue")}
                  </dd>
                </dl>
              </div>
            </fieldset>
          </form>
        </SheetBody>
        <SheetFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("files.transfer.cancel")}
          </Button>
          <Button
            type="submit"
            form="files-new-transfer-form"
            disabled={busy || clusterContextInvalidated || cloudContextBlocked}
            data-testid="files-new-transfer-submit"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("files.transfer.start")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
