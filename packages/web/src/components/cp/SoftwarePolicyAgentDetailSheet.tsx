import { decideSpackPolicy } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Play, Search, ShieldAlert, Upload, X } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import {
  type CpSoftwareAgentView,
  estimateInstallation,
  type PolicyOverlayInput,
  type SoftwareOperation,
  type SoftwareOperationAction,
} from "../../lib/cp-client";
import {
  listSpackCatalog,
  type SpackCatalog,
  type SpackCatalogSourceFilter,
} from "../../lib/software-client";
import {
  useCpRequestSoftwareOperation,
  useCpRequestSoftwareOperationsBatch,
  useCpReviewPreinstalledMapping,
  useCpSoftwareOperations,
} from "../../lib/use-cp-software";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { SpecList } from "./SoftwareInstalledSpecList";
import {
  formatSoftwareOperationFailure,
  isFailedOperation,
  OperationHistory,
  policyRejectionMessage,
  SOFTWARE_OPERATION_ACTIONS,
} from "./SoftwareOperations";
import {
  ControlChannelBadge,
  PolicyDigest,
  StatusBadge,
  usecaseStrategyLabel,
} from "./SoftwarePolicySummary";
import { SpackCatalogPickerDialog } from "./SpackCatalogPickerDialog";

const BULK_SOFTWARE_OPERATION_ACTIONS = ["install", "import_preinstalled"] as const;

const COLLAPSED_USECASE_POLICY_LIST_LIMIT = 8;

const BATCH_POLICY_REJECTION_PREVIEW_LIMIT = 5;

const MAX_BATCH_SOFTWARE_OPERATION_SPECS = 200;

const MAX_BATCH_SOFTWARE_OPERATION_RAW_LINES = 2000;

type BulkSoftwareOperationAction = (typeof BULK_SOFTWARE_OPERATION_ACTIONS)[number];

function parseSpecLines(value: string): string[] {
  return summarizeSpecLines(value).specs;
}

function summarizeSpecLines(value: string): {
  duplicateCount: number;
  lineCount: number;
  lines: string[];
  nonEmptyCount: number;
  specs: string[];
} {
  const lines = value.length === 0 ? [] : value.split(/\r?\n/);
  const seen = new Set<string>();
  const specs: string[] = [];
  let duplicateCount = 0;
  let nonEmptyCount = 0;
  for (const line of lines) {
    const spec = line.trim();
    if (spec.length === 0) continue;
    nonEmptyCount += 1;
    if (seen.has(spec)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(spec);
    specs.push(spec);
  }
  return { duplicateCount, lineCount: lines.length, lines, nonEmptyCount, specs };
}

function appendSpecLine(value: string, spec: string): string {
  const specs = parseSpecLines(value);
  if (!specs.includes(spec)) specs.push(spec);
  return specs.join("\n");
}

function formatBatchPolicyRejection(
  item: { spec: string; reason: string } | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return item ? `${item.spec}: ${policyRejectionMessage(item.reason, t)}` : "-";
}

function formatBatchOperationFailure(
  operation: SoftwareOperation | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!operation) return "-";
  return `${operation.spec}: ${formatSoftwareOperationFailure(
    operation,
    t("cp.software.operations.failed"),
    t,
  )}`;
}

export function AgentDetailSheet({
  agent,
  canManage,
  open,
  onOpenChange,
  onEdit,
}: {
  agent: CpSoftwareAgentView | null;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (agent: CpSoftwareAgentView) => void;
}) {
  const { t } = useTranslation();
  const activeOrganizationId = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const requestOperation = useCpRequestSoftwareOperation();
  const requestBatchOperation = useCpRequestSoftwareOperationsBatch();
  const reviewMapping = useCpReviewPreinstalledMapping();
  const [operationStatusFilter, setOperationStatusFilter] = useState<
    SoftwareOperation["status"] | null
  >(null);
  const [operationActionFilter, setOperationActionFilter] =
    useState<SoftwareOperationAction | null>(null);
  const operations = useCpSoftwareOperations(agent?.agentId ?? null, {
    action: operationActionFilter,
    status: operationStatusFilter,
  });
  const [operationSpec, setOperationSpec] = useState("");
  const [operationSpecFromCatalog, setOperationSpecFromCatalog] = useState(false);
  const [operationAction, setOperationAction] = useState<SoftwareOperationAction>("install");
  const [batchAction, setBatchAction] = useState<BulkSoftwareOperationAction>("install");
  const [batchSpecText, setBatchSpecText] = useState("");
  const [catalogTarget, setCatalogTarget] = useState<"single" | "batch" | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogSource, setCatalogSource] = useState<SpackCatalogSourceFilter>("all");
  const [catalogPage, setCatalogPage] = useState(1);
  const agentId = agent?.agentId ?? null;
  const batchSummary = useMemo(() => summarizeSpecLines(batchSpecText), [batchSpecText]);
  const batchSpecs = batchSummary.specs;
  const operationDisabled = !agent?.controlChannelOnline;
  const operationSubmitting = requestOperation.isPending || requestBatchOperation.isPending;
  const singleCatalogAvailable = isCatalogBackedOperation(operationAction);
  const batchCopyPrefix =
    batchAction === "import_preinstalled"
      ? "cp.software.operations.batchImport"
      : "cp.software.operations.batchInstall";
  const operationPolicyRejection = agent
    ? softwareOperationPolicyRejection(agent.effectivePolicy, operationAction, operationSpec)
    : null;
  const batchPolicyRejectedSpecs = useMemo(
    () =>
      agent && batchAction === "install"
        ? batchSpecs
            .map((spec) => ({
              spec,
              reason: softwareOperationPolicyRejection(agent.effectivePolicy, batchAction, spec),
            }))
            .filter((item): item is { spec: string; reason: string } => item.reason !== null)
        : [],
    [agent, batchAction, batchSpecs],
  );
  const batchLimitExceeded = batchSpecs.length > MAX_BATCH_SOFTWARE_OPERATION_SPECS;
  const batchRawLineLimitExceeded = batchSummary.lineCount > MAX_BATCH_SOFTWARE_OPERATION_RAW_LINES;
  const catalog = useQuery<SpackCatalog>({
    queryKey: [
      "cp",
      "software",
      "spack-catalog",
      catalogSearch,
      catalogSource,
      catalogPage,
      activeOrganizationId ?? "all",
    ],
    queryFn: () => listSpackCatalog(catalogSearch, 18, catalogSource, catalogPage),
    enabled: catalogTarget !== null,
  });
  const terminalOperationSignature = useMemo(
    () =>
      operations.data
        ?.filter((operation) => isTerminalOperation(operation))
        .map((operation) => `${operation.id}:${operation.status}:${operation.updatedAt}`)
        .join("|") ?? "",
    [operations.data],
  );

  const resetOperationDrafts = useCallback(() => {
    setOperationSpec("");
    setOperationSpecFromCatalog(false);
    setOperationAction("install");
    setBatchAction("install");
    setBatchSpecText("");
    setOperationActionFilter(null);
    setOperationStatusFilter(null);
    setCatalogTarget(null);
    setCatalogSearch("");
    setCatalogSource("all");
    setCatalogPage(1);
  }, []);

  useEffect(() => {
    if (!open) {
      resetOperationDrafts();
    }
  }, [open, resetOperationDrafts]);

  useEffect(() => {
    if (agentId === null) return;
    resetOperationDrafts();
  }, [agentId, resetOperationDrafts]);

  useEffect(() => {
    if (terminalOperationSignature.length === 0) return;
    queryClient.invalidateQueries({ queryKey: ["cp", "software", "overview"] });
  }, [queryClient, terminalOperationSignature]);

  const changeOperationAction = (action: SoftwareOperationAction) => {
    setOperationAction(action);
    if (!isCatalogBackedOperation(action) && operationSpecFromCatalog) {
      setOperationSpec("");
      setOperationSpecFromCatalog(false);
    }
  };

  const changeOperationSpec = (spec: string) => {
    setOperationSpec(spec);
    setOperationSpecFromCatalog(false);
  };

  const submitOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const spec = operationSpec.trim();
    if (!agent) return;
    if (!spec) {
      toast.error(t("cp.software.operations.specRequired"));
      return;
    }
    if (operationDisabled) {
      toast.error(t("cp.software.operations.controlChannelOfflineHint"));
      return;
    }
    if (operationPolicyRejection) {
      toast.error(
        t("cp.software.operations.policyRejected", {
          reason: policyRejectionMessage(operationPolicyRejection, t),
        }),
      );
      return;
    }
    if (operationSubmitting) {
      toast.error(t("cp.software.operations.pending"));
      return;
    }
    if (
      operationAction === "uninstall" &&
      !window.confirm(t("cp.software.operations.confirmUninstall", { spec }))
    ) {
      return;
    }
    requestOperation.mutate(
      {
        agentId: agent.agentId,
        action: operationAction,
        spec,
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: (operation) => {
          if (isFailedOperation(operation)) {
            toast.error(
              formatSoftwareOperationFailure(operation, t("cp.software.operations.failed"), t),
            );
          } else {
            toast.success(
              t("cp.software.operations.queued", {
                action: t(`cp.software.operations.action.${operation.action}`),
              }),
            );
            setOperationSpec("");
          }
        },
        onError: (err) => toast.error(toUserFacingError(err, t("cp.software.operations.failed"))),
      },
    );
  };

  const submitBatchOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!agent) return;
    if (batchSpecs.length === 0) {
      toast.error(t("cp.software.operations.batchEmptyHint"));
      return;
    }
    if (batchLimitExceeded) {
      toast.error(
        t("cp.software.operations.batchLimitExceeded", {
          count: batchSpecs.length,
          max: MAX_BATCH_SOFTWARE_OPERATION_SPECS,
        }),
      );
      return;
    }
    if (batchRawLineLimitExceeded) {
      toast.error(
        t("cp.software.operations.batchRawLimitExceeded", {
          count: batchSummary.lineCount,
          max: MAX_BATCH_SOFTWARE_OPERATION_RAW_LINES,
        }),
      );
      return;
    }
    if (operationDisabled) {
      toast.error(t("cp.software.operations.controlChannelOfflineHint"));
      return;
    }
    if (batchPolicyRejectedSpecs.length > 0) {
      const first = formatBatchPolicyRejection(batchPolicyRejectedSpecs[0], t);
      toast.error(
        t("cp.software.operations.policyRejectedBatch", {
          count: batchPolicyRejectedSpecs.length,
          first,
        }),
      );
      return;
    }
    if (operationSubmitting) {
      toast.error(t("cp.software.operations.pending"));
      return;
    }
    requestBatchOperation.mutate(
      {
        agentId: agent.agentId,
        action: batchAction,
        specs: batchSummary.lines,
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: ({ items, summary }) => {
          if (items.length === 0) {
            toast.error(t("cp.software.operations.batchEmptyResult"));
            return;
          }
          const failedItems = items.filter(isFailedOperation);
          const failedCount = failedItems.length;
          const ignoredCount = summary.ignoredEmptyCount + summary.ignoredDuplicateCount;
          if (failedCount > 0) {
            toast.error(
              ignoredCount > 0
                ? t("cp.software.operations.batchPartialFailedWithIgnored", {
                    accepted: items.length - failedCount,
                    failed: failedCount,
                    total: items.length,
                    first: formatBatchOperationFailure(failedItems[0], t),
                    ignoredEmpty: summary.ignoredEmptyCount,
                    ignoredDuplicate: summary.ignoredDuplicateCount,
                  })
                : t("cp.software.operations.batchPartialFailed", {
                    accepted: items.length - failedCount,
                    failed: failedCount,
                    total: items.length,
                    first: formatBatchOperationFailure(failedItems[0], t),
                  }),
            );
          } else {
            toast.success(
              ignoredCount > 0
                ? t("cp.software.operations.batchQueuedWithIgnored", {
                    count: items.length,
                    action: t(`cp.software.operations.action.${batchAction}`),
                    ignoredEmpty: summary.ignoredEmptyCount,
                    ignoredDuplicate: summary.ignoredDuplicateCount,
                  })
                : t("cp.software.operations.batchQueued", {
                    count: items.length,
                    action: t(`cp.software.operations.action.${batchAction}`),
                  }),
            );
            setBatchSpecText("");
          }
        },
        onError: (err) =>
          toast.error(toUserFacingError(err, t("cp.software.operations.batchFailed"))),
      },
    );
  };

  const quickOperation = (action: SoftwareOperationAction, spec: string) => {
    if (!agent) return;
    if (operationDisabled) {
      toast.error(t("cp.software.operations.controlChannelOfflineHint"));
      return;
    }
    const rejection = softwareOperationPolicyRejection(agent.effectivePolicy, action, spec);
    if (rejection) {
      toast.error(
        t("cp.software.operations.policyRejected", {
          reason: policyRejectionMessage(rejection, t),
        }),
      );
      return;
    }
    if (operationSubmitting) {
      toast.error(t("cp.software.operations.pending"));
      return;
    }
    if (
      action === "uninstall" &&
      !window.confirm(t("cp.software.operations.confirmUninstall", { spec }))
    ) {
      return;
    }
    requestOperation.mutate(
      { agentId: agent.agentId, action, spec, idempotencyKey: crypto.randomUUID() },
      {
        onSuccess: (operation) => {
          if (isFailedOperation(operation)) {
            toast.error(
              formatSoftwareOperationFailure(operation, t("cp.software.operations.failed"), t),
            );
          } else {
            toast.success(
              t("cp.software.operations.queued", {
                action: t(`cp.software.operations.action.${action}`),
              }),
            );
          }
        },
        onError: (err) => toast.error(toUserFacingError(err, t("cp.software.operations.failed"))),
      },
    );
  };

  const retryOperation = (operation: SoftwareOperation) => {
    setOperationAction(operation.action);
    setOperationSpec(operation.spec);
    setOperationSpecFromCatalog(false);
    toast.success(t("cp.software.operations.retryFilled"));
  };

  const reviewPreinstalledMapping = (mappingId: string, decision: "approve" | "reject") => {
    if (!agent) return;
    reviewMapping.mutate(
      { agentId: agent.agentId, mappingId, decision },
      {
        onSuccess: () => {
          toast.success(
            t(
              decision === "approve"
                ? "cp.software.agent.mappingApproved"
                : "cp.software.agent.mappingRejected",
            ),
          );
        },
        onError: (err) =>
          toast.error(toUserFacingError(err, t("cp.software.agent.mappingReviewFailed"))),
      },
    );
  };

  const selectCatalogSpec = (spec: string) => {
    if (catalogTarget === "batch") {
      setBatchSpecText((current) => appendSpecLine(current, spec));
      toast.success(t("cp.software.operations.catalogBatchAdded", { spec }));
    } else {
      setOperationSpec(spec);
      setOperationSpecFromCatalog(true);
      toast.success(t("cp.software.operations.catalogSingleSelected", { spec }));
    }
    setCatalogTarget(null);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="max-w-3xl" data-testid="cp-software-agent-sheet">
        <SheetHeader>
          <SheetTitle>{agent?.agentId ?? ""}</SheetTitle>
          <SheetDescription>{agent?.cluster ?? ""}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4">
          {agent ? (
            <>
              <div className="flex flex-wrap gap-2">
                <StatusBadge
                  status={agent.status}
                  runtimeStatus={agent.runtimeStatus}
                  lastHeartbeat={agent.lastHeartbeat}
                />
                <ControlChannelBadge online={agent.controlChannelOnline} />
                <Badge variant="outline">{agent.schedulerType}</Badge>
                {agent.effectivePolicy.lockEnabled ? (
                  <Badge variant="cancelled">
                    <ShieldAlert className="h-3 w-3" />
                    {t("cp.software.policy.locked")}
                  </Badge>
                ) : null}
              </div>
              {operationDisabled ? (
                <div className=" p-3 text-sm text-status-failed">
                  {t("cp.software.operations.controlChannelOfflineHint")}
                </div>
              ) : null}
              <PolicyDigest policy={agent.effectivePolicy} />
              <UsecasePolicyPanel policy={agent.effectivePolicy} />
              {canManage ? (
                <Button variant="outline" size="sm" onClick={() => onEdit(agent)}>
                  <Pencil />
                  {t("cp.software.agent.editOverride")}
                </Button>
              ) : null}
              <DetailSection title={t("cp.software.agent.installed")}>
                <SpecList
                  key={`${agent.agentId}:${agent.installedSpecs.join("\n")}`}
                  specs={agent.installedSpecs}
                  empty={t("cp.software.agent.noInstalled")}
                  onLoad={(spec) => quickOperation("load", spec)}
                  onUninstall={(spec) => quickOperation("uninstall", spec)}
                  actionRejection={(action, spec) =>
                    softwareOperationPolicyRejection(agent.effectivePolicy, action, spec)
                  }
                  disabled={operationDisabled || operationSubmitting}
                />
              </DetailSection>
              <DetailSection title={t("cp.software.operations.title")}>
                <form
                  className="grid gap-2 md:grid-cols-[160px_1fr_auto_auto]"
                  onSubmit={submitOperation}
                  data-testid="cp-software-operation-form"
                >
                  <NativeSelect
                    value={operationAction}
                    data-testid="cp-software-operation-action"
                    onChange={(event) =>
                      changeOperationAction(event.target.value as SoftwareOperationAction)
                    }
                  >
                    {SOFTWARE_OPERATION_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {t(`cp.software.operations.action.${action}`)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input
                    value={operationSpec}
                    data-testid="cp-software-operation-spec"
                    onChange={(event) => changeOperationSpec(event.target.value)}
                    placeholder={t("cp.software.operations.specPlaceholder")}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCatalogTarget("single")}
                    disabled={operationDisabled || operationSubmitting || !singleCatalogAvailable}
                    title={
                      singleCatalogAvailable
                        ? t("cp.software.operations.catalogOpen")
                        : t("cp.software.operations.catalogUnavailableForAction")
                    }
                  >
                    <Search />
                    {t("cp.software.operations.catalogOpen")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      operationDisabled ||
                      operationSubmitting ||
                      operationSpec.trim().length === 0 ||
                      operationPolicyRejection !== null
                    }
                  >
                    {operationSubmitting ? <Loader2 className="animate-spin" /> : <Play />}
                    {t("cp.software.operations.submit")}
                  </Button>
                </form>
                {operationAction === "install" && operationSpec.trim() && canManage && (
                  <InstallEstimate
                    agentId={agent.agentId}
                    spec={operationSpec.trim()}
                    orgId={activeOrganizationId}
                  />
                )}
                {operationPolicyRejection ? (
                  <PolicyRejectionHint reason={operationPolicyRejection} />
                ) : null}
                <form
                  className="border-b border-border p-3"
                  onSubmit={submitBatchOperation}
                  data-testid="cp-software-batch-form"
                >
                  <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-medium">{t(`${batchCopyPrefix}Title`)}</h4>
                      <p className="text-xs text-muted-foreground">
                        {t(`${batchCopyPrefix}Subtitle`)}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {t("cp.software.operations.batchCount", { count: batchSpecs.length })}
                    </Badge>
                  </div>
                  <div className="grid gap-2 md:grid-cols-[180px_1fr_auto]">
                    <NativeSelect
                      value={batchAction}
                      onChange={(event) =>
                        setBatchAction(event.target.value as BulkSoftwareOperationAction)
                      }
                      data-testid="cp-software-batch-action"
                    >
                      {BULK_SOFTWARE_OPERATION_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {t(`cp.software.operations.action.${action}`)}
                        </option>
                      ))}
                    </NativeSelect>
                    <Textarea
                      value={batchSpecText}
                      onChange={(event) => setBatchSpecText(event.target.value)}
                      placeholder={t(`${batchCopyPrefix}Placeholder`)}
                      className="min-h-28 font-mono text-xs"
                      data-testid="cp-software-batch-specs"
                    />
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setCatalogTarget("batch")}
                        disabled={operationDisabled || operationSubmitting}
                      >
                        <Search />
                        {t("cp.software.operations.catalogAdd")}
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          operationDisabled ||
                          operationSubmitting ||
                          batchSpecs.length === 0 ||
                          batchLimitExceeded ||
                          batchRawLineLimitExceeded ||
                          batchPolicyRejectedSpecs.length > 0
                        }
                      >
                        {operationSubmitting ? <Loader2 className="animate-spin" /> : <Upload />}
                        {t("cp.software.operations.batchSubmit")}
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground md:col-start-2">
                      {batchSummary.nonEmptyCount > 0 ? (
                        <span>
                          {t("cp.software.operations.batchParsedCount", {
                            count: batchSpecs.length,
                            raw: batchSummary.nonEmptyCount,
                          })}
                        </span>
                      ) : (
                        <span>{t("cp.software.operations.batchEmptyHint")}</span>
                      )}
                      {batchSummary.duplicateCount > 0 ? (
                        <span className="ml-2 text-[var(--status-pending)]">
                          {t("cp.software.operations.batchDuplicateCount", {
                            count: batchSummary.duplicateCount,
                          })}
                        </span>
                      ) : null}
                      {batchPolicyRejectedSpecs.length > 0 ? (
                        <span className="ml-2 text-status-failed">
                          {t("cp.software.operations.batchPolicyRejectedCount", {
                            count: batchPolicyRejectedSpecs.length,
                            first: formatBatchPolicyRejection(batchPolicyRejectedSpecs[0], t),
                          })}
                        </span>
                      ) : null}
                      {batchLimitExceeded ? (
                        <span className="ml-2 text-status-failed">
                          {t("cp.software.operations.batchLimitExceeded", {
                            count: batchSpecs.length,
                            max: MAX_BATCH_SOFTWARE_OPERATION_SPECS,
                          })}
                        </span>
                      ) : null}
                      {batchRawLineLimitExceeded ? (
                        <span className="ml-2 text-status-failed">
                          {t("cp.software.operations.batchRawLimitExceeded", {
                            count: batchSummary.lineCount,
                            max: MAX_BATCH_SOFTWARE_OPERATION_RAW_LINES,
                          })}
                        </span>
                      ) : null}
                    </div>
                    {batchPolicyRejectedSpecs.length > 0 ? (
                      <div
                        className=" p-2 text-xs text-status-failed md:col-start-2"
                        data-testid="cp-software-batch-policy-rejections"
                      >
                        <div className="mb-1 font-medium">
                          {t("cp.software.operations.batchPolicyRejectedPreview")}
                        </div>
                        <ul className="list-inside list-disc space-y-1">
                          {batchPolicyRejectedSpecs
                            .slice(0, BATCH_POLICY_REJECTION_PREVIEW_LIMIT)
                            .map((item) => (
                              <li key={item.spec}>{formatBatchPolicyRejection(item, t)}</li>
                            ))}
                        </ul>
                        {batchPolicyRejectedSpecs.length > BATCH_POLICY_REJECTION_PREVIEW_LIMIT ? (
                          <div className="mt-1 text-muted-foreground">
                            {t("cp.software.operations.batchPolicyRejectedMore", {
                              count:
                                batchPolicyRejectedSpecs.length -
                                BATCH_POLICY_REJECTION_PREVIEW_LIMIT,
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </form>
                <OperationHistory
                  key={agent.agentId}
                  controlChannelOnline={agent.controlChannelOnline}
                  operations={operations.data ?? []}
                  actionFilter={operationActionFilter}
                  onActionFilterChange={setOperationActionFilter}
                  statusFilter={operationStatusFilter}
                  onStatusFilterChange={setOperationStatusFilter}
                  loading={operations.isLoading}
                  error={operations.error as Error | null}
                  onRefresh={() => operations.refetch()}
                  onRetry={retryOperation}
                  refreshing={operations.isFetching}
                />
              </DetailSection>
              <DetailSection title={t("cp.software.agent.mappings")}>
                {agent.preinstalledMappings.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    {t("cp.software.agent.noMappings")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {agent.preinstalledMappings.map((mapping) => (
                      <div
                        key={mapping.id}
                        className=" border-border p-2 text-xs"
                        data-testid={`cp-software-preinstalled-mapping-${mapping.id}`}
                      >
                        <div className="font-mono">{mapping.localSpec}</div>
                        <div className="text-muted-foreground">{mapping.assetId}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge variant={mapping.auditedAt ? "succeeded" : "outline"}>
                            {mapping.confidence}
                          </Badge>
                          {mapping.auditedAt ? (
                            <span className="text-muted-foreground">
                              {t("cp.software.agent.mappingAudited", {
                                at: new Date(mapping.auditedAt).toLocaleString(),
                              })}
                              {mapping.auditedBy ? ` · ${mapping.auditedBy}` : ""}
                            </span>
                          ) : canManage ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => reviewPreinstalledMapping(mapping.id, "approve")}
                                disabled={reviewMapping.isPending}
                                data-testid={`cp-software-preinstalled-approve-${mapping.id}`}
                              >
                                <Check />
                                {t("cp.software.agent.mappingApprove")}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => reviewPreinstalledMapping(mapping.id, "reject")}
                                disabled={reviewMapping.isPending}
                                data-testid={`cp-software-preinstalled-reject-${mapping.id}`}
                              >
                                <X />
                                {t("cp.software.agent.mappingReject")}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>
            </>
          ) : null}
        </SheetBody>
      </SheetContent>
      <SpackCatalogPickerDialog
        catalog={catalog.error ? null : (catalog.data ?? null)}
        error={catalog.error as Error | null}
        loading={catalog.isLoading || catalog.isFetching}
        onOpenChange={(value) => setCatalogTarget(value ? (catalogTarget ?? "single") : null)}
        onPageChange={setCatalogPage}
        onRefresh={() => catalog.refetch()}
        onSelect={selectCatalogSpec}
        open={catalogTarget !== null}
        search={catalogSearch}
        setSearch={setCatalogSearch}
        setSource={setCatalogSource}
        source={catalogSource}
      />
    </Sheet>
  );
}

function isTerminalOperation(operation: SoftwareOperation): boolean {
  return (
    operation.status === "succeeded" ||
    operation.status === "failed" ||
    operation.status === "rejected"
  );
}

function isCatalogBackedOperation(action: SoftwareOperationAction): boolean {
  return action === "install" || action === "import_preinstalled";
}

function softwareOperationPolicyRejection(
  policy: PolicyOverlayInput,
  action: SoftwareOperationAction,
  spec: string,
): string | null {
  if (action === "import_preinstalled") return null;
  const normalizedSpec = spec.trim();
  if (normalizedSpec.length === 0) return null;
  const decision = decideSpackPolicy(normalizedSpec, {
    lockEnabled: policy.lockEnabled,
    allowList: policy.allowList,
    denyList: policy.denyList,
  });
  return decision === "allow" ? null : decision.reject;
}

function PolicyRejectionHint({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <div className=" p-2 text-xs text-status-failed">
      {t("cp.software.operations.policyRejected", {
        reason: policyRejectionMessage(reason, t),
      })}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function UsecasePolicyPanel({ policy }: { policy: PolicyOverlayInput }) {
  const { t } = useTranslation();
  return (
    <div className=" border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">{t("cp.software.usecase.title")}</div>
        <Badge variant={policy.usecaseDefaultAllow ? "succeeded" : "brand"}>
          {usecaseStrategyLabel(t, policy)}
        </Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <UsecasePolicyStatus policy={policy} />
        <UsecasePolicyList
          title={t("cp.software.usecase.allowList")}
          items={policy.usecaseAllowList}
          empty={t("cp.software.usecase.noAllowList")}
        />
        <UsecasePolicyList
          title={t("cp.software.usecase.denyList")}
          items={policy.usecaseDenyList}
          empty={t("cp.software.usecase.noDenyList")}
        />
      </div>
    </div>
  );
}

function UsecasePolicyStatus({ policy }: { policy: PolicyOverlayInput }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 p-2 text-xs">
      <div className="mb-1 font-medium">{t("cp.software.usecase.authorization")}</div>
      <div className="text-muted-foreground">
        {policy.usecaseDefaultAllow
          ? t("cp.software.usecase.defaultAllowDescription")
          : t("cp.software.usecase.explicitGrantDescription")}
      </div>
    </div>
  );
}

function UsecasePolicyList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, COLLAPSED_USECASE_POLICY_LIST_LIMIT);
  const hasHiddenItems = items.length > COLLAPSED_USECASE_POLICY_LIST_LIMIT;
  return (
    <div className="min-w-0 p-2 text-xs">
      <div className="mb-1 font-medium">{title}</div>
      {items.length === 0 ? (
        <div className="text-muted-foreground">{empty}</div>
      ) : (
        <>
          <div className="space-y-1">
            {visibleItems.map((item) => (
              <code key={item} className="block truncate px-2 py-1 font-mono">
                {item}
              </code>
            ))}
          </div>
          {hasHiddenItems ? (
            <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground">
              <span>
                {t("cp.software.usecase.listCountHint", {
                  visible: visibleItems.length,
                  total: items.length,
                })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? t("cp.software.usecase.showLess", {
                      count: COLLAPSED_USECASE_POLICY_LIST_LIMIT,
                    })
                  : t("cp.software.usecase.showAll", { count: items.length })}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function InstallEstimate({
  agentId,
  spec,
  orgId,
}: {
  agentId: string;
  spec: string;
  orgId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const [cores, setCores] = useState("1");
  const [minutes, setMinutes] = useState("");
  const query = useQuery({
    queryKey: ["cp-install-estimate", orgId, agentId, spec, cores, minutes],
    queryFn: () =>
      estimateInstallation(agentId, spec, Number(cores), minutes ? Number(minutes) : undefined),
    enabled: false,
    retry: false,
  });
  return (
    <details className="my-2 text-sm">
      <summary className="cursor-pointer">{t("cp.software.operations.estimate.title")}</summary>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void query.refetch();
        }}
      >
        <label>
          {t("cp.software.operations.estimate.cpus")}
          <Input
            type="number"
            min={1}
            max={65536}
            required
            value={cores}
            onChange={(e) => setCores(e.target.value)}
          />
        </label>
        <label>
          {t("cp.software.operations.estimate.minutes")}
          <Input
            type="number"
            min="0.01"
            max={525600}
            step="any"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={query.isFetching}>
          {t("cp.software.operations.estimate.calculate")}
        </Button>
      </form>
      {query.isError && (
        <p role="alert">{toUserFacingError(query.error, t("software.unreachable"))}</p>
      )}
      {query.isSuccess && (
        <p role="status" className="mt-2">
          {!minutes && t("cp.software.operations.estimate.samples", { count: query.data.samples })}{" "}
          {query.data.seconds === null
            ? t("cp.software.operations.estimate.noDuration")
            : t("cp.software.operations.estimate.hours", {
                hours: query.data.cpuHours?.toLocaleString(undefined, {
                  maximumSignificantDigits: 4,
                }),
              })}{" "}
          {query.data.rate === null
            ? t("cp.software.operations.estimate.noRate")
            : t("cp.software.operations.estimate.rate", { rate: query.data.rate })}{" "}
          {query.data.cost !== null &&
            t("cp.software.operations.estimate.cost", {
              cost: query.data.cost.toLocaleString(undefined, { maximumSignificantDigits: 4 }),
            })}
        </p>
      )}
    </details>
  );
}
