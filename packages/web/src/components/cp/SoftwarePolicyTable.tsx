import { decideSpackPolicy } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  Loader2,
  Lock,
  PackageCheck,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import type {
  CpSoftwareAgentView,
  CpSoftwareClusterView,
  CpSoftwareOverview,
  InstallMode,
  MirrorInput,
  PolicyOverlayInput,
  SoftwareAvailabilityNode,
  SoftwareAvailabilityPreview,
  SoftwareOperation,
  SoftwareOperationAction,
} from "../../lib/cp-client";
import { softwareAvailabilityReason } from "../../lib/software-availability-reason";
import {
  listSpackCatalog,
  type SpackCatalog,
  type SpackCatalogPackage,
  type SpackCatalogSourceFilter,
  type SpackVariantMetadata,
} from "../../lib/software-client";
import {
  useCpRequestSoftwareOperation,
  useCpRequestSoftwareOperationsBatch,
  useCpReviewPreinstalledMapping,
  useCpSaveAgentSoftwarePolicy,
  useCpSaveClusterSoftwarePolicy,
  useCpSaveProviderSoftwarePolicy,
  useCpSoftwareAvailabilityPreview,
  useCpSoftwareOperations,
  useCpSoftwareOverview,
} from "../../lib/use-cp-software";
import { toUserFacingError } from "../../lib/user-facing-error";
import { RuntimeAndMaterialPanel } from "../software/EcosystemGovernancePanels";
import { Badge, badgeVariants } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";

const INSTALL_MODES: InstallMode[] = [
  "preinstalled-only",
  "trusted-public-auto-install",
  "explicit-install-grant",
];

const SOFTWARE_OPERATION_ACTIONS: SoftwareOperationAction[] = [
  "install",
  "uninstall",
  "load",
  "import_preinstalled",
];

const BULK_SOFTWARE_OPERATION_ACTIONS = ["install", "import_preinstalled"] as const;
const COLLAPSED_OPERATION_HISTORY_LIMIT = 12;
const COLLAPSED_SPEC_LIST_LIMIT = 60;
const COLLAPSED_USECASE_POLICY_LIST_LIMIT = 8;
const BATCH_POLICY_REJECTION_PREVIEW_LIMIT = 5;
const MAX_BATCH_SOFTWARE_OPERATION_SPECS = 200;
const MAX_BATCH_SOFTWARE_OPERATION_RAW_LINES = 2000;
const MAX_INLINE_OPERATION_FAILURE_LENGTH = 160;

type BulkSoftwareOperationAction = (typeof BULK_SOFTWARE_OPERATION_ACTIONS)[number];

const DEFAULT_POLICY: PolicyOverlayInput = {
  installMode: "explicit-install-grant",
  allowList: [],
  denyList: [],
  lockEnabled: false,
  trustedPublicAutoInstall: false,
  usecaseDefaultAllow: true,
  usecaseAllowList: [],
  usecaseDenyList: [],
  mirrors: [],
  preinstallList: [],
};

const EMPTY_PROVIDER_ORG_IDS: string[] = [];

type EditorTarget =
  | { type: "provider"; policy: PolicyOverlayInput; providerOrgId?: string }
  | { type: "cluster"; cluster: CpSoftwareClusterView; policy: PolicyOverlayInput }
  | { type: "agent"; agent: CpSoftwareAgentView; policy: PolicyOverlayInput };

interface PolicyDraft {
  providerOrgId: string;
  installMode: InstallMode;
  allowText: string;
  denyText: string;
  lockEnabled: boolean;
  trustedPublicAutoInstall: boolean;
  usecaseDefaultAllow: boolean;
  usecaseAllowText: string;
  usecaseDenyText: string;
  mirrorsText: string;
  preinstallText: string;
}

export function SoftwarePolicyTable({ canManage = true }: { canManage?: boolean }) {
  const { t } = useTranslation();
  const overviewQuery = useCpSoftwareOverview();
  const saveProvider = useCpSaveProviderSoftwarePolicy();
  const saveCluster = useCpSaveClusterSoftwarePolicy();
  const saveAgent = useCpSaveAgentSoftwarePolicy();
  const preview = useCpSoftwareAvailabilityPreview();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [rawSpec, setRawSpec] = useState("");
  const [previewUsecase, setPreviewUsecase] = useState("");
  const [previewUsecaseVersion, setPreviewUsecaseVersion] = useState("");

  const overview = overviewQuery.error ? undefined : overviewQuery.data;
  const selectedAgent = useMemo(
    () => overview?.agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [overview, selectedAgentId],
  );

  useEffect(() => {
    if (!overviewQuery.error) return;
    setSelectedAgentId(null);
    setEditorTarget(null);
  }, [overviewQuery.error]);

  useEffect(() => {
    if (!overview || selectedAgentId === null) return;
    if (!overview.agents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [overview, selectedAgentId]);

  const openProviderEditor = () => {
    const policy = overview?.providerPolicy ?? DEFAULT_POLICY;
    setEditorTarget({
      type: "provider",
      policy,
      providerOrgId: overview?.providerPolicy?.providerOrgId ?? undefined,
    });
  };

  const openAgentEditor = (agent: CpSoftwareAgentView) => {
    setEditorTarget({
      type: "agent",
      agent,
      policy: agent.agentPolicy ?? agent.effectivePolicy,
    });
  };

  const openClusterEditor = (cluster: CpSoftwareClusterView) => {
    setEditorTarget({
      type: "cluster",
      cluster,
      policy: cluster.clusterPolicy ?? cluster.agents[0]?.effectivePolicy ?? DEFAULT_POLICY,
    });
  };

  const handleSavePolicy = (draft: PolicyDraft) => {
    const policy = draftToPolicy(draft);
    if (editorTarget?.type === "agent") {
      saveAgent.mutate(
        { agentId: editorTarget.agent.agentId, policy },
        {
          onSuccess: () => {
            toast.success(t("cp.software.edit.saved"));
            setEditorTarget(null);
          },
          onError: (err) => toast.error(toUserFacingError(err, t("cp.software.edit.saveFailed"))),
        },
      );
      return;
    }
    if (editorTarget?.type === "cluster") {
      saveCluster.mutate(
        { clusterId: editorTarget.cluster.cluster, policy },
        {
          onSuccess: () => {
            toast.success(t("cp.software.edit.saved"));
            setEditorTarget(null);
          },
          onError: (err) => toast.error(toUserFacingError(err, t("cp.software.edit.saveFailed"))),
        },
      );
      return;
    }
    saveProvider.mutate(
      {
        ...policy,
        ...(draft.providerOrgId ? { providerOrgId: draft.providerOrgId } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t("cp.software.edit.saved"));
          setEditorTarget(null);
        },
        onError: (err) => toast.error(toUserFacingError(err, t("cp.software.edit.saveFailed"))),
      },
    );
  };

  const handlePreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const spec = rawSpec.trim();
    if (!spec) return;
    const usecaseRef = buildPreviewUsecaseRef(previewUsecase, previewUsecaseVersion);
    preview.mutate({
      rawSpec: spec,
      installable: true,
      ...(usecaseRef ? { usecaseRef } : {}),
    });
  };

  return (
    <div className="space-y-5" data-testid="cp-software-policy-table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.software.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("cp.software.subtitle")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => overviewQuery.refetch()}
          disabled={overviewQuery.isFetching}
          title={t("cp.software.refresh")}
        >
          <RefreshCw className={overviewQuery.isFetching ? "animate-spin" : ""} />
          {t("cp.software.refresh")}
        </Button>
      </div>
      <RuntimeAndMaterialPanel />

      {overviewQuery.error ? (
        <div className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm">
          {toUserFacingError(overviewQuery.error, t("cp.software.loadFailed"))}
        </div>
      ) : null}

      {overviewQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
      ) : overview ? (
        <>
          <ControlChannelNotice overview={overview} />
          <SummaryCards overview={overview} />
          <ProviderPolicyCard
            overview={overview}
            onEdit={canManage ? openProviderEditor : undefined}
          />
          <AvailabilityPreviewForm
            rawSpec={rawSpec}
            setRawSpec={setRawSpec}
            usecase={previewUsecase}
            setUsecase={setPreviewUsecase}
            usecaseVersion={previewUsecaseVersion}
            setUsecaseVersion={setPreviewUsecaseVersion}
            onPreview={handlePreview}
            result={preview.data ?? null}
            error={preview.error ?? null}
            isPending={preview.isPending}
          />
          <ClusterAgentTable
            overview={overview}
            onInspect={(agent) => setSelectedAgentId(agent.agentId)}
            onEdit={canManage ? openAgentEditor : undefined}
            onEditCluster={canManage ? openClusterEditor : undefined}
          />
        </>
      ) : null}

      <AgentDetailSheet
        agent={selectedAgent}
        open={selectedAgent !== null}
        onOpenChange={(open) => !open && setSelectedAgentId(null)}
        canManage={canManage}
        onEdit={openAgentEditor}
      />

      {canManage ? (
        <PolicyEditorSheet
          target={editorTarget}
          providerOrgIds={overview?.providerOrgIds ?? EMPTY_PROVIDER_ORG_IDS}
          open={editorTarget !== null}
          onOpenChange={(open) => !open && setEditorTarget(null)}
          onSave={handleSavePolicy}
          isSaving={saveProvider.isPending || saveCluster.isPending || saveAgent.isPending}
        />
      ) : null}
    </div>
  );
}

function ControlChannelNotice({ overview }: { overview: CpSoftwareOverview }) {
  const { t } = useTranslation();
  const totalAgents = overview.agents.length;
  const onlineAgents = overview.agents.filter((agent) => agent.controlChannelOnline).length;
  if (totalAgents === 0 || onlineAgents > 0) return null;
  return (
    <div
      className="flex items-start gap-3 rounded-md border border-status-warning/40 bg-[color-mix(in_oklab,var(--status-warning)_12%,transparent)] p-3 text-sm"
      data-testid="cp-software-control-channel-notice"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
      <div>
        <div className="font-medium">{t("cp.software.controlChannelNotice.title")}</div>
        <p className="mt-1 text-muted-foreground">
          {t("cp.software.controlChannelNotice.description", { count: totalAgents })}
        </p>
      </div>
    </div>
  );
}

function SummaryCards({ overview }: { overview: CpSoftwareOverview }) {
  const { t } = useTranslation();
  const items = [
    { key: "clusters", value: overview.summary.clusters },
    { key: "agents", value: overview.summary.agents },
    { key: "lockedAgents", value: overview.summary.lockedAgents },
    { key: "installedSpecs", value: overview.summary.installedSpecs },
    { key: "mirrors", value: overview.summary.mirrors },
    { key: "overrides", value: overview.summary.overrides },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
      {items.map((item) => (
        <Card key={item.key}>
          <CardHeader>
            <CardTitle>{t(`cp.software.summary.${item.key}`)}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">{item.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ProviderPolicyCard({
  overview,
  onEdit,
}: {
  overview: CpSoftwareOverview;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const policy = overview.providerPolicy ?? DEFAULT_POLICY;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("cp.software.provider.title")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {overview.providerOrgIds.length > 0
              ? overview.providerOrgIds.join(", ")
              : t("cp.software.provider.noProvider")}
          </p>
        </div>
        {onEdit ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil />
            {t("cp.common.edit")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <PolicyDigest policy={policy} />
      </CardContent>
    </Card>
  );
}

function buildPreviewUsecaseRef(identifier: string, version: string) {
  const trimmedIdentifier = identifier.trim();
  const trimmedVersion = version.trim();
  if (trimmedIdentifier.length === 0 && trimmedVersion.length === 0) return null;
  const [identifierPart, inlineVersion] =
    trimmedVersion.length === 0 && trimmedIdentifier.includes("@")
      ? trimmedIdentifier.split("@", 2)
      : [trimmedIdentifier, ""];
  const ref: { id?: string; name?: string; version?: string } = {};
  const normalizedIdentifier = identifierPart?.trim() ?? "";
  if (normalizedIdentifier.length === 0) return null;
  if (normalizedIdentifier.startsWith("asset:")) {
    const id = normalizedIdentifier.slice("asset:".length).trim();
    if (id) ref.id = id;
  } else if (normalizedIdentifier.startsWith("usecase:")) {
    const name = normalizedIdentifier.slice("usecase:".length).trim();
    if (name) ref.name = name;
  } else if (normalizedIdentifier.length > 0) {
    ref.name = normalizedIdentifier;
  }
  const normalizedVersion = trimmedVersion || (inlineVersion?.trim() ?? "");
  if (normalizedVersion.length > 0) ref.version = normalizedVersion;
  return Object.keys(ref).length > 0 ? ref : null;
}

function ClusterAgentTable({
  overview,
  onInspect,
  onEdit,
  onEditCluster,
}: {
  overview: CpSoftwareOverview;
  onInspect: (agent: CpSoftwareAgentView) => void;
  onEdit?: (agent: CpSoftwareAgentView) => void;
  onEditCluster?: (cluster: CpSoftwareClusterView) => void;
}) {
  const { t } = useTranslation();
  if (overview.agents.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
        data-testid="cp-software-empty"
      >
        {t("cp.software.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {overview.clusters.map((cluster) => (
        <div key={cluster.cluster} className="overflow-hidden rounded-md border border-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
            <div>
              <div className="font-medium">{cluster.cluster}</div>
              <div className="text-xs text-muted-foreground">
                {t("cp.software.cluster.meta", {
                  agents: cluster.agents.length,
                  installed: cluster.installedCount,
                  mirrors: cluster.mirrorCount,
                })}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {cluster.clusterPolicy ? (
                <Badge variant="brand">{t("cp.software.policy.clusterOverride")}</Badge>
              ) : null}
              {cluster.installModes.map((mode) => (
                <Badge key={mode} variant="outline">
                  {t(`cp.software.installMode.${mode}`)}
                </Badge>
              ))}
              {cluster.lockedAgents > 0 ? (
                <Badge variant="cancelled">
                  <Lock className="h-3 w-3" />
                  {t("cp.software.cluster.lockedAgents", { count: cluster.lockedAgents })}
                </Badge>
              ) : null}
              {onEditCluster ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditCluster(cluster)}
                  title={t("cp.software.cluster.editOverride")}
                >
                  <Pencil />
                  {t("cp.software.cluster.editOverride")}
                </Button>
              ) : null}
            </div>
          </div>
          <div
            className="overflow-x-auto overscroll-x-contain"
            data-testid={`cp-software-cluster-table-scroll-${cluster.cluster}`}
          >
            <table className="min-w-[58rem] w-full text-sm">
              <thead className="bg-muted/20 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("cp.software.col.agent")}</th>
                  <th className="px-3 py-2 font-medium">{t("cp.software.col.status")}</th>
                  <th className="px-3 py-2 font-medium">{t("cp.software.col.installMode")}</th>
                  <th className="px-3 py-2 font-medium">{t("cp.software.col.installed")}</th>
                  <th className="px-3 py-2 font-medium">{t("cp.software.col.policy")}</th>
                  <th className="px-3 py-2 font-medium text-right">{t("cp.common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {cluster.agents.map((agent) => (
                  <tr
                    key={agent.agentId}
                    className="border-t border-border"
                    data-testid={`cp-software-agent-${agent.agentId}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{agent.agentId}</div>
                      <div className="text-xs text-muted-foreground">
                        {agent.schedulerType} {agent.schedulerVersion}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <StatusBadge
                          status={agent.status}
                          runtimeStatus={agent.runtimeStatus}
                          lastHeartbeat={agent.lastHeartbeat}
                        />
                        <ControlChannelBadge online={agent.controlChannelOnline} />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {t(`cp.software.installMode.${agent.effectivePolicy.installMode}`)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{agent.installedCount}</td>
                    <td className="px-3 py-2">
                      <PolicyBadges agent={agent} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onInspect(agent)}
                          title={t("cp.software.agent.inspect")}
                        >
                          <Eye />
                          {t("cp.software.agent.inspect")}
                        </Button>
                        {onEdit ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onEdit(agent)}
                            title={t("cp.software.agent.editOverride")}
                          >
                            <Pencil />
                            {t("cp.common.edit")}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function PolicyBadges({ agent }: { agent: CpSoftwareAgentView }) {
  const { t } = useTranslation();
  const usecaseLabel = usecaseStrategyLabel(t, agent.effectivePolicy);
  return (
    <div className="flex flex-wrap gap-1">
      {agent.agentPolicy ? (
        <Badge variant="brand">{t("cp.software.policy.agentOverride")}</Badge>
      ) : agent.clusterPolicy ? (
        <Badge variant="brand">{t("cp.software.policy.clusterOverride")}</Badge>
      ) : agent.providerPolicy ? (
        <Badge variant="outline">{t("cp.software.policy.inherited")}</Badge>
      ) : (
        <Badge variant="outline">{t("cp.software.policy.unconfigured")}</Badge>
      )}
      {agent.effectivePolicy.lockEnabled ? (
        <Badge variant="cancelled">
          <Lock className="h-3 w-3" />
          {t("cp.software.policy.locked")}
        </Badge>
      ) : null}
      <Badge
        variant={agent.effectivePolicy.usecaseDefaultAllow ? "outline" : "brand"}
        title={t("cp.software.usecase.policySummary", {
          allow: agent.effectivePolicy.usecaseAllowList.length,
          deny: agent.effectivePolicy.usecaseDenyList.length,
        })}
      >
        {usecaseLabel}
      </Badge>
    </div>
  );
}

function StatusBadge({
  status,
  runtimeStatus,
  lastHeartbeat,
}: {
  status: string;
  runtimeStatus?: string;
  lastHeartbeat?: string | null;
}) {
  const { t } = useTranslation();
  const visibleStatus = runtimeStatus ?? status;
  const variant =
    visibleStatus === "online" ? "succeeded" : visibleStatus === "unhealthy" ? "failed" : "outline";
  return (
    <Badge
      variant={variant}
      title={t("cp.software.agent.statusTooltip", {
        dbStatus: status,
        lastHeartbeat: lastHeartbeat ?? "-",
      })}
    >
      {visibleStatus}
    </Badge>
  );
}

function ControlChannelBadge({ online }: { online: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge variant={online ? "succeeded" : "failed"}>
      {online
        ? t("cp.software.agent.controlChannelOnline")
        : t("cp.software.agent.controlChannelOffline")}
    </Badge>
  );
}

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

function policyRejectionMessage(reason: string, t: ReturnType<typeof useTranslation>["t"]): string {
  if (reason === "spec is empty") return t("cp.software.operations.policyReason.specEmpty");
  if (reason === "install lock enabled and no allowList configured") {
    return t("cp.software.operations.policyReason.lockWithoutAllowList");
  }
  if (/^spec '.+' matches denyList$/.test(reason)) {
    return t("cp.software.operations.policyReason.denyList");
  }
  if (/^spec '.+' not in allowList(?: while lock enabled)?$/.test(reason)) {
    return t("cp.software.operations.policyReason.allowList");
  }
  return t("cp.software.operations.policyReason.generic");
}

function formatBatchPolicyRejection(
  item: { spec: string; reason: string } | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return item ? `${item.spec}: ${policyRejectionMessage(item.reason, t)}` : "-";
}

function formatSoftwareOperationFailure(
  operation: SoftwareOperation,
  fallback: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return operation.status === "rejected" && isKnownPolicyRejection(operation.error)
    ? policyRejectionMessage(operation.error, t)
    : fallback;
}

function isKnownPolicyRejection(reason: string | null): reason is string {
  if (!reason) return false;
  return (
    reason === "spec is empty" ||
    reason === "install lock enabled and no allowList configured" ||
    /^spec '.+' matches denyList$/.test(reason) ||
    /^spec '.+' not in allowList(?: while lock enabled)?$/.test(reason)
  );
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

function AvailabilityPreviewForm({
  rawSpec,
  setRawSpec,
  usecase,
  setUsecase,
  usecaseVersion,
  setUsecaseVersion,
  onPreview,
  result,
  error,
  isPending,
}: {
  rawSpec: string;
  setRawSpec: (value: string) => void;
  usecase: string;
  setUsecase: (value: string) => void;
  usecaseVersion: string;
  setUsecaseVersion: (value: string) => void;
  onPreview: (event: FormEvent<HTMLFormElement>) => void;
  result: SoftwareAvailabilityPreview | null;
  error: Error | null;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("cp.software.preview.title")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("cp.software.preview.subtitle")}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="grid gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_160px_auto]"
          onSubmit={onPreview}
        >
          <div className="grid gap-1">
            <label className="text-xs font-medium" htmlFor="cp-software-preview-spec">
              {t("cp.software.preview.spec")}
            </label>
            <Input
              id="cp-software-preview-spec"
              value={rawSpec}
              onChange={(event) => setRawSpec(event.target.value)}
              placeholder={t("cp.software.preview.placeholder")}
              data-testid="cp-software-preview-input"
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs font-medium" htmlFor="cp-software-preview-usecase">
              {t("cp.software.preview.usecase")}
            </label>
            <Input
              id="cp-software-preview-usecase"
              value={usecase}
              onChange={(event) => setUsecase(event.target.value)}
              placeholder={t("cp.software.preview.usecasePlaceholder")}
              data-testid="cp-software-preview-usecase"
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs font-medium" htmlFor="cp-software-preview-usecase-version">
              {t("cp.software.preview.usecaseVersion")}
            </label>
            <Input
              id="cp-software-preview-usecase-version"
              value={usecaseVersion}
              onChange={(event) => setUsecaseVersion(event.target.value)}
              placeholder={t("cp.software.preview.usecaseVersionPlaceholder")}
              data-testid="cp-software-preview-usecase-version"
            />
          </div>
          <Button
            type="submit"
            disabled={isPending || rawSpec.trim().length === 0}
            className="self-end"
          >
            <Boxes />
            {isPending ? t("cp.common.loading") : t("cp.software.preview.submit")}
          </Button>
        </form>
        {error ? (
          <div className="rounded-md border border-status-failed/40 p-3 text-sm text-status-failed">
            {toUserFacingError(error, t("cp.software.operations.failed"))}
          </div>
        ) : null}
        {result ? <AvailabilityPreviewResult result={result} /> : null}
      </CardContent>
    </Card>
  );
}

function AvailabilityPreviewResult({ result }: { result: SoftwareAvailabilityPreview }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 lg:grid-cols-3" data-testid="cp-software-preview-result">
      <AvailabilityColumn
        title={t("cp.software.preview.installed")}
        nodes={result.installedAvailable}
      />
      <AvailabilityColumn
        title={t("cp.software.preview.installable")}
        nodes={result.installableAvailable}
      />
      <AvailabilityColumn title={t("cp.software.preview.blocked")} nodes={result.blocked} blocked />
    </div>
  );
}

function AvailabilityColumn({
  title,
  nodes,
  blocked = false,
}: {
  title: string;
  nodes: SoftwareAvailabilityNode[];
  blocked?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <Badge variant={blocked ? "failed" : "outline"}>{nodes.length}</Badge>
      </div>
      <div className="space-y-2">
        {nodes.slice(0, 8).map((node) => (
          <div key={node.agentId} className="rounded-md bg-muted/30 p-2 text-xs">
            <div className="font-mono">{node.agentId}</div>
            <div className="text-muted-foreground">{node.siteName}</div>
            {node.reasons.length > 0 ? (
              <ul className="mt-1 list-inside list-disc text-status-failed">
                {node.reasons.map((reason) => (
                  <li key={reason}>{softwareAvailabilityReason(reason, t)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentDetailSheet({
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
                <div className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] p-3 text-sm text-status-failed">
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
                >
                  <select
                    className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                    value={operationAction}
                    onChange={(event) =>
                      changeOperationAction(event.target.value as SoftwareOperationAction)
                    }
                  >
                    {SOFTWARE_OPERATION_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {t(`cp.software.operations.action.${action}`)}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={operationSpec}
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
                {operationPolicyRejection ? (
                  <PolicyRejectionHint reason={operationPolicyRejection} />
                ) : null}
                <form
                  className="rounded-md border border-border p-3"
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
                    <select
                      className="h-9 rounded-md border border-border bg-card px-3 text-sm"
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
                    </select>
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
                        className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] p-2 text-xs text-status-failed md:col-start-2"
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
                        className="rounded-md border border-border p-2 text-xs"
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

function isFailedOperation(operation: SoftwareOperation): boolean {
  return operation.status === "failed" || operation.status === "rejected";
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
    <div className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] p-2 text-xs text-status-failed">
      {t("cp.software.operations.policyRejected", {
        reason: policyRejectionMessage(reason, t),
      })}
    </div>
  );
}

function PolicyDigest({ policy }: { policy: PolicyOverlayInput }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <DigestCell label={t("cp.software.col.installMode")}>
        {t(`cp.software.installMode.${policy.installMode}`)}
      </DigestCell>
      <DigestCell label={t("cp.software.col.locked")}>
        {policy.lockEnabled ? t("cp.common.yes") : t("cp.common.no")}
      </DigestCell>
      <DigestCell label={t("cp.software.col.whitelist")}>{policy.allowList.length}</DigestCell>
      <DigestCell label={t("cp.software.col.blacklist")}>{policy.denyList.length}</DigestCell>
      <DigestCell label={t("cp.software.policy.mirrors")}>{policy.mirrors.length}</DigestCell>
      <DigestCell label={t("cp.software.policy.preinstallList")}>
        {policy.preinstallList.length}
      </DigestCell>
      <DigestCell label={t("cp.software.policy.trustedAutoInstall")}>
        {policy.trustedPublicAutoInstall ? t("cp.common.yes") : t("cp.common.no")}
      </DigestCell>
      <DigestCell label={t("cp.software.usecase.strategy")}>
        {usecaseStrategyLabel(t, policy)}
      </DigestCell>
      <DigestCell label={t("cp.software.usecase.allowList")}>
        {policy.usecaseAllowList.length}
      </DigestCell>
      <DigestCell label={t("cp.software.usecase.denyList")}>
        {policy.usecaseDenyList.length}
      </DigestCell>
    </div>
  );
}

function DigestCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="shrink-0 text-sm font-semibold tabular-nums">{children}</div>
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
    <div className="rounded-md border border-border p-3">
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
    <div className="min-w-0 rounded-md bg-muted/30 p-2 text-xs">
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
    <div className="min-w-0 rounded-md bg-muted/30 p-2 text-xs">
      <div className="mb-1 font-medium">{title}</div>
      {items.length === 0 ? (
        <div className="text-muted-foreground">{empty}</div>
      ) : (
        <>
          <div className="space-y-1">
            {visibleItems.map((item) => (
              <code key={item} className="block truncate rounded bg-background px-2 py-1 font-mono">
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

function usecaseStrategyLabel(t: (key: string) => string, policy: PolicyOverlayInput): string {
  if (policy.usecaseDenyList.length > 0 && policy.usecaseDefaultAllow) {
    return t("cp.software.usecase.strategyDefaultAllowWithBlacklist");
  }
  if (policy.usecaseDefaultAllow) {
    return t("cp.software.usecase.strategyDefaultAllow");
  }
  if (policy.usecaseAllowList.length > 0) {
    return t("cp.software.usecase.strategyWhitelist");
  }
  return t("cp.software.usecase.strategyAuthorization");
}

function SpecList({
  specs,
  empty,
  onLoad,
  onUninstall,
  actionRejection,
  disabled,
}: {
  specs: string[];
  empty: string;
  onLoad?: (spec: string) => void;
  onUninstall?: (spec: string) => void;
  actionRejection?: (action: SoftwareOperationAction, spec: string) => string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");

  if (specs.length === 0) return <div className="text-sm text-muted-foreground">{empty}</div>;
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredSpecs =
    normalizedFilter.length === 0
      ? specs
      : specs.filter((spec) => spec.toLowerCase().includes(normalizedFilter));
  const visibleSpecs = expanded ? filteredSpecs : filteredSpecs.slice(0, COLLAPSED_SPEC_LIST_LIMIT);
  const hasHiddenSpecs = filteredSpecs.length > COLLAPSED_SPEC_LIST_LIMIT;
  const showFilter = specs.length > COLLAPSED_SPEC_LIST_LIMIT;
  return (
    <div className="grid gap-2">
      {showFilter ? (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setExpanded(false);
            }}
            placeholder={t("cp.software.agent.installedFilterPlaceholder")}
            className="h-9 pl-8 font-mono text-xs"
            data-testid="cp-software-installed-filter"
          />
        </div>
      ) : null}
      {visibleSpecs.length > 0 ? (
        visibleSpecs.map((spec) => {
          const loadRejection = onLoad ? (actionRejection?.("load", spec) ?? null) : null;
          const uninstallRejection = onUninstall
            ? (actionRejection?.("uninstall", spec) ?? null)
            : null;
          return (
            <div
              key={spec}
              className="grid gap-2 rounded-md border border-border p-2 text-xs md:grid-cols-[1fr_auto]"
            >
              <code className="min-w-0 truncate bg-muted px-2 py-1 font-mono" title={spec}>
                {spec}
              </code>
              {onLoad || onUninstall ? (
                <div className="flex gap-1">
                  {onLoad ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onLoad(spec)}
                      disabled={disabled || Boolean(loadRejection)}
                      title={
                        loadRejection
                          ? policyRejectionMessage(loadRejection, t)
                          : t("cp.software.operations.action.load")
                      }
                      data-testid={`cp-software-installed-load-${spec}`}
                    >
                      <PackageCheck />
                    </Button>
                  ) : null}
                  {onUninstall ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onUninstall(spec)}
                      disabled={disabled || Boolean(uninstallRejection)}
                      title={
                        uninstallRejection
                          ? policyRejectionMessage(uninstallRejection, t)
                          : t("cp.software.operations.action.uninstall")
                      }
                      data-testid={`cp-software-installed-uninstall-${spec}`}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {t("cp.software.agent.installedFilterEmpty")}
        </div>
      )}
      {hasHiddenSpecs ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {t("cp.software.agent.installedCountHint", {
              visible: visibleSpecs.length,
              total: filteredSpecs.length,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t("cp.software.agent.installedShowLess", { count: COLLAPSED_SPEC_LIST_LIMIT })
              : t("cp.software.agent.installedShowAll", { count: specs.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OperationHistory({
  controlChannelOnline,
  operations,
  actionFilter,
  onActionFilterChange,
  statusFilter,
  onStatusFilterChange,
  loading,
  error,
  onRefresh,
  onRetry,
  refreshing,
}: {
  controlChannelOnline: boolean;
  operations: SoftwareOperation[];
  actionFilter: SoftwareOperationAction | null;
  onActionFilterChange: (action: SoftwareOperationAction | null) => void;
  statusFilter: SoftwareOperation["status"] | null;
  onStatusFilterChange: (status: SoftwareOperation["status"] | null) => void;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
  onRetry: (operation: SoftwareOperation) => void;
  refreshing: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredOperations =
    normalizedFilter.length === 0
      ? operations
      : operations.filter((operation) =>
          operationMatchesHistoryFilter(operation, normalizedFilter),
        );
  const visibleOperations = expanded
    ? filteredOperations
    : filteredOperations.slice(0, COLLAPSED_OPERATION_HISTORY_LIMIT);
  const hasHiddenOperations = filteredOperations.length > COLLAPSED_OPERATION_HISTORY_LIMIT;
  const showFilter =
    operations.length > COLLAPSED_OPERATION_HISTORY_LIMIT || normalizedFilter.length > 0;
  const hasServerFilter = actionFilter !== null || statusFilter !== null;
  const changeActionFilter = (action: SoftwareOperationAction | null) => {
    onActionFilterChange(action);
    setFilter("");
    setExpanded(false);
  };
  const clearStatusFilter = () => {
    onStatusFilterChange(null);
    setFilter("");
    setExpanded(false);
  };
  const clearAllServerFilters = () => {
    onActionFilterChange(null);
    onStatusFilterChange(null);
    setFilter("");
    setExpanded(false);
  };
  const activeServerFilters = hasServerFilter ? (
    <OperationHistoryActiveServerFilters
      actionFilter={actionFilter}
      onClearActionFilter={() => changeActionFilter(null)}
      statusFilter={statusFilter}
      onClearStatusFilter={clearStatusFilter}
      onClearAll={clearAllServerFilters}
    />
  ) : null;
  if (loading) {
    return (
      <div className="space-y-2">
        <OperationHistoryToolbar
          onRefresh={onRefresh}
          refreshing={refreshing}
          actionFilter={actionFilter}
          onActionFilterChange={changeActionFilter}
        />
        {activeServerFilters}
        <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
      </div>
    );
  }
  if (error && operations.length === 0) {
    return (
      <div className="space-y-2">
        <OperationHistoryToolbar
          onRefresh={onRefresh}
          refreshing={refreshing}
          actionFilter={actionFilter}
          onActionFilterChange={changeActionFilter}
        />
        {activeServerFilters}
        <div className="rounded-md border border-status-failed/30 bg-status-failed/5 px-3 py-2 text-sm text-status-failed">
          {toUserFacingError(error, t("cp.software.operations.failed"))}
        </div>
      </div>
    );
  }
  if (operations.length === 0) {
    return (
      <div className="space-y-2">
        <OperationHistoryToolbar
          onRefresh={onRefresh}
          refreshing={refreshing}
          actionFilter={actionFilter}
          onActionFilterChange={changeActionFilter}
        />
        {activeServerFilters}
        <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          <History className="h-4 w-4" />
          {t(
            hasServerFilter
              ? "cp.software.operations.historyFilterEmpty"
              : "cp.software.operations.empty",
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <OperationHistoryToolbar
        onRefresh={onRefresh}
        refreshing={refreshing}
        actionFilter={actionFilter}
        onActionFilterChange={changeActionFilter}
      />
      {activeServerFilters}
      {error ? (
        <div className="rounded-md border border-status-failed/30 bg-status-failed/5 px-3 py-2 text-xs text-status-failed">
          {toUserFacingError(error, t("cp.software.operations.failed"))}
        </div>
      ) : null}
      <OperationHistoryStatusSummary
        operations={operations}
        onStatusSelect={(status) => {
          onStatusFilterChange(status);
          setFilter("");
          setExpanded(false);
        }}
        statusFilter={statusFilter}
      />
      {showFilter ? (
        <div className="grid gap-1.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setExpanded(false);
              }}
              placeholder={t("cp.software.operations.historyFilterPlaceholder")}
              className="h-9 pl-8 pr-9 font-mono text-xs"
              data-testid="cp-software-operation-history-filter"
            />
            {normalizedFilter.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
                onClick={() => {
                  setFilter("");
                  setExpanded(false);
                }}
                title={t("cp.software.operations.historyFilterClear")}
                data-testid="cp-software-operation-history-filter-clear"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
          {normalizedFilter.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              {t("cp.software.operations.historyFilterCount", {
                count: filteredOperations.length,
                total: operations.length,
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {visibleOperations.length > 0 ? (
        <div
          className="overflow-x-auto overscroll-x-contain rounded-md border border-border"
          data-testid="cp-software-history-table-scroll"
        >
          <table className="min-w-[40rem] w-full text-xs">
            <thead className="bg-muted/20 text-left uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2">{t("cp.software.operations.col.action")}</th>
                <th className="px-2 py-2">{t("cp.software.operations.col.spec")}</th>
                <th className="px-2 py-2">{t("cp.software.operations.col.status")}</th>
                <th className="px-2 py-2">{t("cp.software.operations.col.updatedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleOperations.map((operation) => (
                <OperationHistoryRow
                  key={operation.id}
                  controlChannelOnline={controlChannelOnline}
                  operation={operation}
                  onRetry={onRetry}
                  retryDisabled={error !== null}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {t("cp.software.operations.historyFilterEmpty")}
        </div>
      )}
      {hasHiddenOperations ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t("cp.software.operations.historyShowLess", {
                  count: COLLAPSED_OPERATION_HISTORY_LIMIT,
                })
              : t("cp.software.operations.historyShowAll", { count: filteredOperations.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const SOFTWARE_OPERATION_STATUS_ORDER = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rejected",
] satisfies SoftwareOperation["status"][];

function OperationHistoryStatusSummary({
  operations,
  onStatusSelect,
  statusFilter,
}: {
  operations: SoftwareOperation[];
  onStatusSelect: (status: SoftwareOperation["status"]) => void;
  statusFilter: SoftwareOperation["status"] | null;
}) {
  const { t } = useTranslation();
  const counts = countSoftwareOperationStatuses(operations);
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="cp-software-operation-status-summary">
      {SOFTWARE_OPERATION_STATUS_ORDER.map((status) => {
        const count = counts[status] ?? 0;
        if (count === 0) return null;
        return (
          <button
            key={status}
            type="button"
            className={`${badgeVariants({ variant: operationStatusVariant(status) })} ${
              statusFilter === status ? "ring-2 ring-[var(--ring)] ring-offset-1" : ""
            }`}
            onClick={() => onStatusSelect(status)}
            title={t("cp.software.operations.historyFilterStatus", {
              status: t(`cp.software.operations.status.${status}`),
            })}
            data-testid={`cp-software-operation-status-summary-${status}`}
          >
            {t(`cp.software.operations.status.${status}`)}: {count}
          </button>
        );
      })}
    </div>
  );
}

function countSoftwareOperationStatuses(
  operations: SoftwareOperation[],
): Partial<Record<SoftwareOperation["status"], number>> {
  const counts: Partial<Record<SoftwareOperation["status"], number>> = {};
  for (const operation of operations) {
    counts[operation.status] = (counts[operation.status] ?? 0) + 1;
  }
  return counts;
}

function operationMatchesHistoryFilter(
  operation: SoftwareOperation,
  normalizedFilter: string,
): boolean {
  return [
    operation.action,
    operation.status,
    operation.spec,
    operation.requestedBy ?? "",
    operation.exitCode === null ? "" : String(operation.exitCode),
  ].some((value) => value.toLowerCase().includes(normalizedFilter));
}

function OperationHistoryToolbar({
  onRefresh,
  refreshing,
  actionFilter,
  onActionFilterChange,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  actionFilter: SoftwareOperationAction | null;
  onActionFilterChange: (action: SoftwareOperationAction | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-xs font-medium">{t("cp.software.operations.historyTitle")}</div>
        <div className="text-xs text-muted-foreground">
          {t("cp.software.operations.historySubtitle")}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-border bg-card px-2 text-xs"
          value={actionFilter ?? "all"}
          onChange={(event) =>
            onActionFilterChange(
              event.target.value === "all" ? null : (event.target.value as SoftwareOperationAction),
            )
          }
          title={t("cp.software.operations.historyActionFilter")}
          data-testid="cp-software-operation-action-filter"
        >
          <option value="all">{t("cp.software.operations.historyActionFilterAll")}</option>
          {SOFTWARE_OPERATION_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(`cp.software.operations.action.${action}`)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          title={t("cp.software.operations.historyRefresh")}
        >
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          {t("cp.software.operations.historyRefresh")}
        </Button>
      </div>
    </div>
  );
}

function OperationHistoryActiveServerFilters({
  actionFilter,
  onClearActionFilter,
  statusFilter,
  onClearStatusFilter,
  onClearAll,
}: {
  actionFilter: SoftwareOperationAction | null;
  onClearActionFilter: () => void;
  statusFilter: SoftwareOperation["status"] | null;
  onClearStatusFilter: () => void;
  onClearAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
      <span className="font-medium text-muted-foreground">
        {t("cp.software.operations.historyServerFilters")}
      </span>
      {actionFilter ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1"
          onClick={onClearActionFilter}
          data-testid="cp-software-operation-action-filter-clear"
          title={t("cp.software.operations.historyServerActionFilterClear")}
        >
          {t("cp.software.operations.historyServerActionFilter", {
            action: t(`cp.software.operations.action.${actionFilter}`),
          })}
          <X className="h-3 w-3" />
        </button>
      ) : null}
      {statusFilter ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1"
          onClick={onClearStatusFilter}
          data-testid="cp-software-operation-status-filter-clear"
          title={t("cp.software.operations.historyServerStatusFilterClear")}
        >
          {t("cp.software.operations.historyServerStatusFilter", {
            status: t(`cp.software.operations.status.${statusFilter}`),
          })}
          <X className="h-3 w-3" />
        </button>
      ) : null}
      {actionFilter && statusFilter ? (
        <button type="button" className="text-brand hover:underline" onClick={onClearAll}>
          {t("cp.software.operations.historyServerFiltersClearAll")}
        </button>
      ) : null}
    </div>
  );
}

function OperationHistoryRow({
  controlChannelOnline,
  operation,
  onRetry,
  retryDisabled,
}: {
  controlChannelOnline: boolean;
  operation: SoftwareOperation;
  onRetry: (operation: SoftwareOperation) => void;
  retryDisabled: boolean;
}) {
  const { t } = useTranslation();
  const deliveryUncertain = operation.status === "queued" && !controlChannelOnline;
  const failureSummary = operationFailureSummary(operation, t("cp.software.operations.failed"), t);
  const hasDetails =
    deliveryUncertain ||
    Boolean(operation.requestedBy) ||
    isFailedOperation(operation) ||
    operation.exitCode !== null;
  const retryable = isFailedOperation(operation);
  return (
    <>
      <tr className="border-t border-border">
        <td className="px-2 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>
              <OperationActionIcon action={operation.action} />
              {t(`cp.software.operations.action.${operation.action}`)}
            </span>
            {retryable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRetry(operation)}
                title={t("cp.software.operations.retry")}
                disabled={retryDisabled}
                data-testid={`cp-software-operation-retry-${operation.id}`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("cp.software.operations.retry")}
              </Button>
            ) : null}
          </div>
        </td>
        <td className="max-w-64 truncate px-2 py-2 font-mono">{operation.spec}</td>
        <td className="px-2 py-2">
          <OperationStatusBadge operation={operation} />
          {failureSummary ? (
            <div
              className="mt-1 max-w-56 truncate text-[11px] text-status-failed"
              data-testid={`cp-software-operation-error-summary-${operation.id}`}
              title={failureSummary}
            >
              {failureSummary}
            </div>
          ) : null}
          {deliveryUncertain ? (
            <div
              className="mt-1 max-w-56 truncate text-[11px] text-[var(--status-pending)]"
              data-testid={`cp-software-operation-delivery-summary-${operation.id}`}
              title={t("cp.software.operations.queuedDeliveryUncertain")}
            >
              {t("cp.software.operations.queuedDeliveryUncertainShort")}
            </div>
          ) : null}
        </td>
        <td className="px-2 py-2 font-mono text-muted-foreground">
          {new Date(operation.updatedAt).toLocaleString()}
        </td>
      </tr>
      {hasDetails ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={4} className="px-2 py-2">
            <details>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {t("cp.software.operations.details")}
              </summary>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {deliveryUncertain ? (
                  <div className="rounded-md border border-border bg-background p-2 text-xs text-muted-foreground md:col-span-3">
                    {t("cp.software.operations.queuedDeliveryUncertain")}
                  </div>
                ) : null}
                {isFailedOperation(operation) ? (
                  <div className="rounded-md border border-status-failed/30 bg-status-failed/5 p-2 text-xs text-status-failed md:col-span-3">
                    {formatSoftwareOperationFailure(
                      operation,
                      t("cp.software.operations.failed"),
                      t,
                    )}
                  </div>
                ) : null}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {t("cp.software.operations.requestedBy")}:{" "}
                <span className="font-mono">{operation.requestedBy ?? "-"}</span>
                {operation.exitCode !== null ? (
                  <>
                    {" · "}
                    {t("cp.software.operations.exitCode")}:{" "}
                    <span className="font-mono">{operation.exitCode}</span>
                  </>
                ) : null}
              </div>
            </details>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function operationFailureSummary(
  operation: SoftwareOperation,
  fallback: string,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!isFailedOperation(operation)) return null;
  return truncateInlineText(
    formatSoftwareOperationFailure(operation, fallback, t),
    MAX_INLINE_OPERATION_FAILURE_LENGTH,
  );
}

function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function OperationActionIcon({ action }: { action: SoftwareOperationAction }) {
  const className = "mr-1 inline h-3.5 w-3.5";
  if (action === "uninstall") return <Trash2 className={className} />;
  if (action === "load") return <PackageCheck className={className} />;
  if (action === "import_preinstalled") return <Upload className={className} />;
  return <Play className={className} />;
}

function OperationStatusBadge({ operation }: { operation: SoftwareOperation }) {
  const { t } = useTranslation();
  return (
    <Badge variant={operationStatusVariant(operation.status)}>
      {operation.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {t(`cp.software.operations.status.${operation.status}`)}
    </Badge>
  );
}

function operationStatusVariant(status: SoftwareOperation["status"]) {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "rejected") return "failed";
  if (status === "running") return "brand";
  return "outline";
}

function buildSpackCatalogSpec(
  pkg: SpackCatalogPackage,
  version: string,
  variantOverrides: Record<string, string>,
) {
  const versionPart = version.trim().length > 0 ? `@${version.trim()}` : "";
  const variantSpecs =
    pkg.metadata?.variants
      .map((variant) => {
        const override = variantOverrides[variant.name]?.trim();
        if (!override) return null;
        if (override === "+") return `+${variant.name}`;
        if (override === "~") return `~${variant.name}`;
        return `${variant.name}=${override}`;
      })
      .filter((spec): spec is string => spec !== null) ?? [];
  const variantPart = variantSpecs.length > 0 ? ` ${variantSpecs.join(" ")}` : "";
  return `${pkg.name}${versionPart}${variantPart}`;
}

function isBooleanSpackVariant(variant: SpackVariantMetadata) {
  const values = variant.values.map((value) => value.toLowerCase());
  const defaultValue = variant.default?.toLowerCase();
  return (
    (values.length === 0 && (defaultValue === "true" || defaultValue === "false")) ||
    (values.length > 0 &&
      values.length <= 2 &&
      values.every((value) => value === "true" || value === "false"))
  );
}

function SpackCatalogPickerDialog({
  catalog,
  error,
  loading,
  onOpenChange,
  onPageChange,
  onRefresh,
  onSelect,
  open,
  search,
  setSearch,
  setSource,
  source,
}: {
  catalog: SpackCatalog | null;
  error: Error | null;
  loading: boolean;
  onOpenChange: (value: boolean) => void;
  onPageChange: (value: number) => void;
  onRefresh: () => void;
  onSelect: (spec: string) => void;
  open: boolean;
  search: string;
  setSearch: (value: string) => void;
  setSource: (value: SpackCatalogSourceFilter) => void;
  source: SpackCatalogSourceFilter;
}) {
  const { t } = useTranslation();
  const packages = catalog?.packages ?? [];
  const [selectedPackage, setSelectedPackage] = useState<SpackCatalogPackage | null>(null);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [variantOverrides, setVariantOverrides] = useState<Record<string, string>>({});
  const selectedSpec = selectedPackage
    ? buildSpackCatalogSpec(selectedPackage, selectedVersion, variantOverrides)
    : "";
  const selectedVariants = selectedPackage?.metadata?.variants ?? [];
  const invalidVariantValue = selectedVariants.find((variant) => {
    if (isBooleanSpackVariant(variant)) return false;
    const override = variantOverrides[variant.name]?.trim();
    return override ? /\s/.test(override) : false;
  });

  const resetCatalogSelection = useCallback(() => {
    setSelectedPackage(null);
    setSelectedVersion("");
    setVariantOverrides({});
  }, []);

  useEffect(() => {
    if (!open) {
      resetCatalogSelection();
    }
  }, [open, resetCatalogSelection]);

  useEffect(() => {
    if (!selectedPackage) return;
    const stillVisible = packages.some(
      (pkg) => pkg.source === selectedPackage.source && pkg.name === selectedPackage.name,
    );
    if (!stillVisible) {
      resetCatalogSelection();
    }
  }, [packages, resetCatalogSelection, selectedPackage]);

  const choosePackage = (pkg: SpackCatalogPackage) => {
    setSelectedPackage(pkg);
    setSelectedVersion("");
    setVariantOverrides({});
  };

  const changeCatalogPage = (page: number) => {
    resetCatalogSelection();
    onPageChange(page);
  };

  const setVariantOverride = (name: string, value: string) => {
    setVariantOverrides((current) => {
      const next = { ...current };
      const normalized = value.trim();
      if (normalized.length === 0) {
        delete next[name];
      } else {
        next[name] = normalized;
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,860px)] w-[min(calc(100vw-1rem),1120px)]"
        data-testid="cp-software-catalog-picker"
      >
        <DialogHeader>
          <DialogTitle>{t("cp.software.operations.catalogTitle")}</DialogTitle>
          <DialogDescription>{t("cp.software.operations.catalogDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="relative min-w-0">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  resetCatalogSelection();
                  setSearch(event.target.value);
                  onPageChange(1);
                }}
                placeholder={t("cp.software.operations.catalogSearch")}
                className="pl-8"
                data-testid="cp-software-catalog-search"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(["all", "upstream", "official", "vendor"] satisfies SpackCatalogSourceFilter[]).map(
                (item) => (
                  <Button
                    key={item}
                    type="button"
                    variant={source === item ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      resetCatalogSelection();
                      setSource(item);
                      onPageChange(1);
                    }}
                  >
                    {t(`cp.software.operations.catalogSource.${item}`)}
                  </Button>
                ),
              )}
            </div>
          </div>
          <CatalogPagination catalog={catalog} onPageChange={changeCatalogPage} />
          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-status-failed/40 p-3 text-sm text-status-failed">
              <span>{toUserFacingError(error, t("cp.software.operations.catalogRetry"))}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={loading}
                data-testid="cp-software-catalog-retry"
              >
                <RotateCcw />
                {t("cp.software.operations.catalogRetry")}
              </Button>
            </div>
          ) : null}
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div
              className="grid min-h-72 auto-rows-max content-start gap-3 overflow-auto rounded-md border border-border bg-background p-2 sm:grid-cols-2"
              data-testid="cp-software-catalog-grid"
            >
              {loading ? (
                <div className="col-span-full flex h-32 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("cp.common.loading")}
                </div>
              ) : packages.length === 0 ? (
                <div className="col-span-full flex h-32 items-center justify-center text-sm text-muted-foreground">
                  {t("cp.software.operations.catalogEmpty")}
                </div>
              ) : (
                packages.map((pkg) => (
                  <button
                    key={`${pkg.source}:${pkg.name}`}
                    type="button"
                    className={`grid min-h-32 min-w-0 content-between gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/30 ${
                      selectedPackage?.source === pkg.source && selectedPackage.name === pkg.name
                        ? "border-primary ring-1 ring-primary/30"
                        : "border-border"
                    }`}
                    onClick={() => choosePackage(pkg)}
                    data-testid={`cp-software-catalog-package-${pkg.source}-${pkg.name}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="break-all font-mono text-sm font-semibold">
                          {pkg.name}
                        </span>
                        <Badge variant={pkg.source === "upstream" ? "outline" : "brand"}>
                          {t(`cp.software.operations.catalogSource.${pkg.source}`)}
                        </Badge>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                        {pkg.description ?? t("cp.software.operations.catalogNoDescription")}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {pkg.metadata
                          ? t("cp.software.operations.catalogMeta", {
                              versions: pkg.metadata.versions.length,
                              variants: pkg.metadata.variants.length,
                            })
                          : t("cp.software.operations.catalogNoMetadata")}
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-primary">
                        <Check className="h-3.5 w-3.5" />
                        {t("cp.software.operations.catalogChoose")}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="flex min-h-0 flex-col gap-3 rounded-md border border-border bg-background p-3">
              <div>
                <div className="text-sm font-medium">
                  {t("cp.software.operations.catalogSpecTitle")}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {selectedPackage
                    ? (selectedPackage.description ??
                      t("cp.software.operations.catalogNoDescription"))
                    : t("cp.software.operations.catalogSpecEmpty")}
                </div>
              </div>
              {selectedPackage ? (
                <>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium" htmlFor="cp-spack-catalog-version">
                      {t("cp.software.operations.catalogVersion")}
                    </label>
                    <select
                      id="cp-spack-catalog-version"
                      className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                      value={selectedVersion}
                      onChange={(event) => setSelectedVersion(event.target.value)}
                      data-testid="cp-software-catalog-version"
                    >
                      <option value="">{t("cp.software.operations.catalogVersionDefault")}</option>
                      {(selectedPackage.metadata?.versions ?? []).map((version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="min-h-0">
                    <div className="mb-1.5 text-xs font-medium">
                      {t("cp.software.operations.catalogVariants")}
                    </div>
                    {selectedVariants.length > 0 ? (
                      <div className="max-h-44 space-y-1 overflow-auto rounded-md border border-border bg-card p-2">
                        {selectedVariants.map((variant) => {
                          const booleanVariant = isBooleanSpackVariant(variant);
                          const variantInputId = `cp-spack-catalog-variant-${variant.name}`;
                          const variantListId = `${variantInputId}-values`;
                          return (
                            <div
                              key={variant.name}
                              className="grid min-w-0 gap-1 rounded-sm px-1.5 py-1 text-xs hover:bg-muted/50"
                            >
                              <label
                                className="flex min-w-0 items-center justify-between gap-2"
                                htmlFor={`cp-spack-catalog-variant-${variant.name}`}
                              >
                                <span className="min-w-0">
                                  <span className="font-mono">{variant.name}</span>
                                  {variant.default ? (
                                    <span className="ml-1 text-muted-foreground">
                                      {t("cp.software.operations.catalogVariantDefault", {
                                        value: variant.default,
                                      })}
                                    </span>
                                  ) : null}
                                </span>
                                {booleanVariant ? (
                                  <select
                                    id={variantInputId}
                                    className="h-8 max-w-32 rounded-md border border-border bg-background px-2 text-xs"
                                    value={variantOverrides[variant.name] ?? ""}
                                    onChange={(event) =>
                                      setVariantOverride(variant.name, event.target.value)
                                    }
                                    data-testid={`cp-software-catalog-variant-${variant.name}`}
                                  >
                                    <option value="">
                                      {t("cp.software.operations.catalogVariantUseDefault")}
                                    </option>
                                    <option value="+">
                                      {t("cp.software.operations.catalogVariantEnable")}
                                    </option>
                                    <option value="~">
                                      {t("cp.software.operations.catalogVariantDisable")}
                                    </option>
                                  </select>
                                ) : (
                                  <span className="grid gap-1">
                                    <Input
                                      id={variantInputId}
                                      list={variant.values.length > 0 ? variantListId : undefined}
                                      className="h-8 max-w-36 bg-background px-2 text-xs"
                                      value={variantOverrides[variant.name] ?? ""}
                                      onChange={(event) =>
                                        setVariantOverride(variant.name, event.target.value)
                                      }
                                      placeholder={t(
                                        "cp.software.operations.catalogVariantValuePlaceholder",
                                      )}
                                      data-testid={`cp-software-catalog-variant-${variant.name}`}
                                    />
                                    {variant.values.length > 0 ? (
                                      <datalist id={variantListId}>
                                        {variant.values.map((value) => (
                                          <option key={value} value={value} />
                                        ))}
                                      </datalist>
                                    ) : null}
                                  </span>
                                )}
                              </label>
                              {variant.description ? (
                                <span className="text-muted-foreground">{variant.description}</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-md border border-border bg-card p-2 text-xs text-muted-foreground">
                        {t("cp.software.operations.catalogVariantsEmpty")}
                      </div>
                    )}
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium" htmlFor="cp-spack-catalog-spec">
                      {t("cp.software.operations.catalogSpec")}
                    </label>
                    <Input
                      id="cp-spack-catalog-spec"
                      value={selectedSpec}
                      readOnly
                      className="font-mono text-xs"
                      data-testid="cp-software-catalog-spec"
                    />
                    {invalidVariantValue ? (
                      <div
                        className="text-xs text-status-failed"
                        data-testid="cp-software-catalog-spec-validation"
                      >
                        {t("cp.software.operations.catalogVariantValueInvalid", {
                          name: invalidVariantValue.name,
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-auto grid gap-2">
                    <Button
                      type="button"
                      onClick={() => onSelect(selectedSpec)}
                      disabled={Boolean(invalidVariantValue)}
                    >
                      <Check />
                      {t("cp.software.operations.catalogUseSpec")}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <CatalogPagination catalog={catalog} onPageChange={changeCatalogPage} compact />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CatalogPagination({
  catalog,
  compact = false,
  onPageChange,
}: {
  catalog: SpackCatalog | null;
  compact?: boolean;
  onPageChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  if (!catalog) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {t("cp.software.operations.catalogPage", {
          page: catalog.page,
          totalPages: catalog.totalPages,
          totalCount: catalog.totalCount,
        })}
      </span>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.max(1, catalog.page - 1))}
          disabled={!catalog.hasPrevious}
          title={t("cp.software.operations.catalogPrev")}
        >
          <ChevronLeft />
          {compact ? null : t("cp.software.operations.catalogPrev")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(catalog.page + 1)}
          disabled={!catalog.hasNext}
          title={t("cp.software.operations.catalogNext")}
        >
          {compact ? null : t("cp.software.operations.catalogNext")}
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function PolicyEditorSheet({
  target,
  providerOrgIds,
  open,
  onOpenChange,
  onSave,
  isSaving,
}: {
  target: EditorTarget | null;
  providerOrgIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: PolicyDraft) => void;
  isSaving: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PolicyDraft>(() => targetToDraft(target, providerOrgIds));
  const diagnostics = useMemo(() => policyDraftDiagnostics(draft), [draft]);

  useEffect(() => {
    setDraft(targetToDraft(target, providerOrgIds));
  }, [target, providerOrgIds]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (diagnostics.specConflicts.length > 0) {
      toast.error(
        t("cp.software.edit.specConflict", {
          items: diagnostics.specConflicts.slice(0, 3).join(", "),
        }),
      );
      return;
    }
    if (diagnostics.usecaseConflicts.length > 0) {
      toast.error(
        t("cp.software.edit.usecaseConflict", {
          items: diagnostics.usecaseConflicts.slice(0, 3).join(", "),
        }),
      );
      return;
    }
    onSave(draft);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="max-w-2xl" data-testid="cp-software-policy-editor">
        <SheetHeader>
          <SheetTitle>
            {target?.type === "agent"
              ? t("cp.software.edit.agentTitle", { agentId: target.agent.agentId })
              : target?.type === "cluster"
                ? t("cp.software.edit.clusterTitle", { cluster: target.cluster.cluster })
                : t("cp.software.edit.providerTitle")}
          </SheetTitle>
          <SheetDescription>{t("cp.software.edit.description")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id="cp-software-policy-editor-form" className="space-y-4" onSubmit={submit}>
            {target?.type === "provider" && providerOrgIds.length > 1 ? (
              <label className="grid gap-1 text-sm">
                <span>{t("cp.software.edit.providerOrg")}</span>
                <select
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                  value={draft.providerOrgId}
                  onChange={(event) => setDraft({ ...draft, providerOrgId: event.target.value })}
                >
                  <option value="">{t("cp.software.edit.allProviders")}</option>
                  {providerOrgIds.map((orgId) => (
                    <option key={orgId} value={orgId}>
                      {orgId}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="grid gap-1 text-sm">
              <span>{t("cp.software.col.installMode")}</span>
              <select
                className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                value={draft.installMode}
                onChange={(event) =>
                  setDraft({ ...draft, installMode: event.target.value as InstallMode })
                }
              >
                {INSTALL_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`cp.software.installMode.${mode}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.lockEnabled}
                  onChange={(event) => setDraft({ ...draft, lockEnabled: event.target.checked })}
                />
                {t("cp.software.edit.lockEnabled")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.trustedPublicAutoInstall}
                  onChange={(event) =>
                    setDraft({ ...draft, trustedPublicAutoInstall: event.target.checked })
                  }
                />
                {t("cp.software.policy.trustedAutoInstall")}
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <TextAreaField
                label={t("cp.software.col.whitelist")}
                value={draft.allowText}
                onChange={(value) => setDraft({ ...draft, allowText: value })}
                placeholder={t("cp.software.edit.specsPlaceholder")}
                dataTestId="cp-software-policy-allow"
              />
              <TextAreaField
                label={t("cp.software.col.blacklist")}
                value={draft.denyText}
                onChange={(value) => setDraft({ ...draft, denyText: value })}
                placeholder={t("cp.software.edit.specsPlaceholder")}
                dataTestId="cp-software-policy-deny"
              />
            </div>
            {diagnostics.specConflicts.length > 0 ? (
              <PolicyEditorNotice tone="danger">
                {t("cp.software.edit.specConflict", {
                  items: diagnostics.specConflicts.slice(0, 3).join(", "),
                })}
              </PolicyEditorNotice>
            ) : null}
            <div className="rounded-md border border-border p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{t("cp.software.usecase.title")}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("cp.software.usecase.description")}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.usecaseDefaultAllow}
                    onChange={(event) =>
                      setDraft({ ...draft, usecaseDefaultAllow: event.target.checked })
                    }
                  />
                  {t("cp.software.usecase.defaultAllow")}
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <TextAreaField
                  label={t("cp.software.usecase.allowList")}
                  value={draft.usecaseAllowText}
                  onChange={(value) => setDraft({ ...draft, usecaseAllowText: value })}
                  placeholder={t("cp.software.edit.usecasePlaceholder")}
                  dataTestId="cp-software-policy-usecase-allow"
                />
                <TextAreaField
                  label={t("cp.software.usecase.denyList")}
                  value={draft.usecaseDenyText}
                  onChange={(value) => setDraft({ ...draft, usecaseDenyText: value })}
                  placeholder={t("cp.software.edit.usecasePlaceholder")}
                  dataTestId="cp-software-policy-usecase-deny"
                />
              </div>
              <div className="mt-3 space-y-2">
                {diagnostics.usecaseConflicts.length > 0 ? (
                  <PolicyEditorNotice tone="danger">
                    {t("cp.software.edit.usecaseConflict", {
                      items: diagnostics.usecaseConflicts.slice(0, 3).join(", "),
                    })}
                  </PolicyEditorNotice>
                ) : null}
                {diagnostics.usecaseNoGrant ? (
                  <PolicyEditorNotice tone="warning">
                    {t("cp.software.edit.usecaseNoGrant")}
                  </PolicyEditorNotice>
                ) : null}
              </div>
            </div>
            <TextAreaField
              label={t("cp.software.policy.mirrors")}
              value={draft.mirrorsText}
              onChange={(value) => setDraft({ ...draft, mirrorsText: value })}
              placeholder={t("cp.software.edit.mirrorsPlaceholder")}
            />
            <TextAreaField
              label={t("cp.software.policy.preinstallList")}
              value={draft.preinstallText}
              onChange={(value) => setDraft({ ...draft, preinstallText: value })}
              placeholder={t("cp.software.edit.preinstallPlaceholder")}
            />
          </form>
        </SheetBody>
        <SheetFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cp.common.cancel")}
          </Button>
          <Button type="submit" form="cp-software-policy-editor-form" disabled={isSaving}>
            <Save />
            {isSaving ? t("cp.common.loading") : t("cp.common.save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  dataTestId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  dataTestId?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      <Textarea
        id={id}
        className="min-h-28 font-mono text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        data-testid={dataTestId}
      />
    </div>
  );
}

function PolicyEditorNotice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "danger" | "warning";
}) {
  const className =
    tone === "danger"
      ? "border-status-failed/40 bg-status-failed/10 text-status-failed"
      : "border-[var(--status-pending)]/40 bg-[var(--status-pending)]/10 text-[var(--status-pending)]";
  return <div className={`rounded-md border px-3 py-2 text-xs ${className}`}>{children}</div>;
}

function targetToDraft(target: EditorTarget | null, providerOrgIds: string[]): PolicyDraft {
  const policy = target?.policy ?? DEFAULT_POLICY;
  const providerOrgId =
    target?.type === "provider"
      ? (target.providerOrgId ?? "")
      : target?.type === "cluster"
        ? (target.cluster.providerOrgId ?? providerOrgIds[0] ?? "")
        : (target?.agent.providerOrgId ?? providerOrgIds[0] ?? "");
  return {
    providerOrgId,
    installMode: policy.installMode,
    allowText: policy.allowList.join("\n"),
    denyText: policy.denyList.join("\n"),
    lockEnabled: policy.lockEnabled,
    trustedPublicAutoInstall: policy.trustedPublicAutoInstall,
    usecaseDefaultAllow: policy.usecaseDefaultAllow,
    usecaseAllowText: policy.usecaseAllowList.join("\n"),
    usecaseDenyText: policy.usecaseDenyList.join("\n"),
    mirrorsText: policy.mirrors.map(formatMirrorLine).join("\n"),
    preinstallText: policy.preinstallList.join("\n"),
  };
}

function draftToPolicy(draft: PolicyDraft): PolicyOverlayInput {
  return {
    installMode: draft.installMode,
    allowList: splitUniqueLines(draft.allowText),
    denyList: splitUniqueLines(draft.denyText),
    lockEnabled: draft.lockEnabled,
    trustedPublicAutoInstall: draft.trustedPublicAutoInstall,
    usecaseDefaultAllow: draft.usecaseDefaultAllow,
    usecaseAllowList: splitUniqueLines(draft.usecaseAllowText),
    usecaseDenyList: splitUniqueLines(draft.usecaseDenyText),
    mirrors: parseMirrors(draft.mirrorsText),
    preinstallList: splitUniqueLines(draft.preinstallText),
  };
}

function splitUniqueLines(value: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const item = line.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    lines.push(item);
  }
  return lines;
}

function policyDraftDiagnostics(draft: PolicyDraft): {
  specConflicts: string[];
  usecaseConflicts: string[];
  usecaseNoGrant: boolean;
} {
  const specConflicts = intersectLines(draft.allowText, draft.denyText);
  const usecaseAllowList = splitUniqueLines(draft.usecaseAllowText);
  const usecaseConflicts = intersectLineSets(
    usecaseAllowList,
    splitUniqueLines(draft.usecaseDenyText),
  );
  return {
    specConflicts,
    usecaseConflicts,
    usecaseNoGrant: !draft.usecaseDefaultAllow && usecaseAllowList.length === 0,
  };
}

function intersectLines(left: string, right: string): string[] {
  return intersectLineSets(splitUniqueLines(left), splitUniqueLines(right));
}

function intersectLineSets(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function formatMirrorLine(mirror: MirrorInput): string {
  return [mirror.name, mirror.url, mirror.priority ?? null]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" ");
}

function parseMirrors(value: string): MirrorInput[] {
  return splitUniqueLines(value).flatMap((line) => {
    const [name, url, priority] = line.split(/\s+/);
    if (!name || !url) return [];
    const parsedPriority = priority ? Number.parseInt(priority, 10) : undefined;
    return [
      {
        name,
        url,
        ...(parsedPriority !== undefined && Number.isFinite(parsedPriority)
          ? { priority: parsedPriority }
          : {}),
      },
    ];
  });
}
