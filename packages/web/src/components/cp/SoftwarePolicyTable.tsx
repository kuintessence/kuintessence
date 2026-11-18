import { Boxes, Eye, Lock, Pencil, RefreshCw, Save, ShieldAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  CpSoftwareAgentView,
  CpSoftwareClusterView,
  CpSoftwareOverview,
  InstallMode,
  MirrorInput,
  PolicyOverlayInput,
  SoftwareAvailabilityNode,
  SoftwareAvailabilityPreview,
} from "../../lib/cp-client";
import { softwareAvailabilityReason } from "../../lib/software-availability-reason";
import {
  useCpSaveAgentSoftwarePolicy,
  useCpSaveClusterSoftwarePolicy,
  useCpSaveProviderSoftwarePolicy,
  useCpSoftwareAvailabilityPreview,
  useCpSoftwareOverview,
} from "../../lib/use-cp-software";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { useOrganizationName } from "../../lib/use-organization-name";
import { toUserFacingError } from "../../lib/user-facing-error";
import { FunctionMaps } from "../function-maps/FunctionMaps";
import { RuntimeAndMaterialPanel } from "../software/EcosystemGovernancePanels";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { PageHeader, PageShell } from "../ui/page";
import { RefreshButton } from "../ui/refresh-button";
import { ResourceSelectField } from "../ui/resource-select-field";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AgentDetailSheet } from "./SoftwarePolicyAgentDetailSheet";
import {
  ControlChannelBadge,
  PolicyDigest,
  StatusBadge,
  usecaseStrategyLabel,
} from "./SoftwarePolicySummary";

const INSTALL_MODES: InstallMode[] = [
  "preinstalled-only",
  "trusted-public-auto-install",
  "explicit-install-grant",
];

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

export function SoftwarePolicyTable({
  canManage: managementAllowed = true,
}: {
  canManage?: boolean;
}) {
  const mobileReadOnly = useMobileMutationBlocked("/cp/software");
  const canManage = managementAllowed && !mobileReadOnly;
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
    if (!canManage) setEditorTarget(null);
  }, [canManage]);

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
      providerOrgId:
        overview?.providerPolicy?.providerOrgId ??
        (overview?.providerOrgIds.length === 1 ? overview.providerOrgIds[0] : undefined),
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
    <PageShell data-testid="cp-software-policy-table">
      <PageHeader
        title={t("cp.software.title")}
        actions={
          <RefreshButton
            variant="outline"
            onClick={() => overviewQuery.refetch()}
            disabled={overviewQuery.isFetching}
            title={t("cp.software.refresh")}
            label={t("cp.software.refresh")}
          >
            <RefreshCw className={overviewQuery.isFetching ? "animate-spin" : ""} />
          </RefreshButton>
        }
      />
      <FunctionMaps ids={["G08"]} />
      {mobileReadOnly && (
        <p className="text-sm text-muted-foreground">{t("cp.software.desktopManage")}</p>
      )}

      {overviewQuery.error ? (
        <div className=" p-3 text-sm">
          {toUserFacingError(overviewQuery.error, t("cp.software.loadFailed"))}
        </div>
      ) : null}

      {overviewQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
      ) : overview ? (
        <>
          <ControlChannelNotice overview={overview} />
          <SummaryCards overview={overview} />
          {overview.providerOrgIds.length === 1 && (
            <ProviderPolicyCard
              overview={overview}
              onEdit={canManage ? openProviderEditor : undefined}
            />
          )}
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
            onEditCluster={
              canManage && overview.providerOrgIds.length === 1 ? openClusterEditor : undefined
            }
          />
        </>
      ) : null}

      <RuntimeAndMaterialPanel canManage={canManage && !!overview} />

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
    </PageShell>
  );
}

function ControlChannelNotice({ overview }: { overview: CpSoftwareOverview }) {
  const { t } = useTranslation();
  const totalAgents = overview.agents.length;
  const onlineAgents = overview.agents.filter((agent) => agent.controlChannelOnline).length;
  if (totalAgents === 0 || onlineAgents > 0) return null;
  return (
    <div
      className="flex items-start gap-3 p-3 text-sm"
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
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="text-sm text-muted-foreground">{t(`cp.software.summary.${item.key}`)}</dt>
          <dd className="text-lg font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
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
  const organizationName = useOrganizationName();
  const policy = overview.providerPolicy ?? DEFAULT_POLICY;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("cp.software.provider.title")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {overview.providerOrgIds.length > 0
              ? overview.providerOrgIds.map(organizationName).join(", ")
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
  const organizationName = useOrganizationName();
  if (overview.agents.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center border-border text-sm text-muted-foreground"
        data-testid="cp-software-empty"
      >
        {t("cp.software.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {overview.clusters.map((cluster) => (
        <div
          key={`${cluster.providerOrgId}:${cluster.cluster}`}
          className="overflow-hidden border-border"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <div className="font-medium">{cluster.cluster}</div>
              <div className="text-sm text-muted-foreground">
                {cluster.providerOrgId ? organizationName(cluster.providerOrgId) : "—"}
              </div>
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
            <Table className="min-w-[58rem] w-full text-sm">
              <TableHeader className=" text-left text-xs uppercase tracking-wide text-muted-foreground">
                <TableRow>
                  <TableHead className="px-3 py-2 font-medium">
                    {t("cp.software.col.agent")}
                  </TableHead>
                  <TableHead className="px-3 py-2 font-medium">
                    {t("cp.software.col.status")}
                  </TableHead>
                  <TableHead className="px-3 py-2 font-medium">
                    {t("cp.software.col.installMode")}
                  </TableHead>
                  <TableHead className="px-3 py-2 font-medium">
                    {t("cp.software.col.installed")}
                  </TableHead>
                  <TableHead className="px-3 py-2 font-medium">
                    {t("cp.software.col.policy")}
                  </TableHead>
                  <TableHead className="px-3 py-2 font-medium text-right">
                    {t("cp.common.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cluster.agents.map((agent) => (
                  <TableRow
                    key={agent.agentId}
                    className=" border-border"
                    data-testid={`cp-software-agent-${agent.agentId}`}
                  >
                    <TableCell className="px-3 py-2">
                      <div className="font-mono text-xs">{agent.agentId}</div>
                      <div className="text-xs text-muted-foreground">
                        {agent.schedulerType} {agent.schedulerVersion}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <StatusBadge
                          status={agent.status}
                          runtimeStatus={agent.runtimeStatus}
                          lastHeartbeat={agent.lastHeartbeat}
                        />
                        <ControlChannelBadge online={agent.controlChannelOnline} />
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      {t(`cp.software.installMode.${agent.effectivePolicy.installMode}`)}
                    </TableCell>
                    <TableCell className="px-3 py-2 tabular-nums">{agent.installedCount}</TableCell>
                    <TableCell className="px-3 py-2">
                      <PolicyBadges agent={agent} />
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right">
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
          <div className=" p-3 text-sm text-status-failed">
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
    <div className=" border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <Badge variant={blocked ? "failed" : "outline"}>{nodes.length}</Badge>
      </div>
      <div className="space-y-2">
        {nodes.slice(0, 8).map((node) => (
          <div key={node.agentId} className=" p-2 text-xs">
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
                <ResourceSelectField
                  resourceType="organizations"
                  value={draft.providerOrgId}
                  onChange={(event) => setDraft({ ...draft, providerOrgId: event.target.value })}
                >
                  <option value="">{t("cp.software.edit.allProviders")}</option>
                  {providerOrgIds.map((orgId) => (
                    <option key={orgId} value={orgId}>
                      {orgId}
                    </option>
                  ))}
                </ResourceSelectField>
              </label>
            ) : null}
            <label className="grid gap-1 text-sm">
              <span>{t("cp.software.col.installMode")}</span>
              <NativeSelect
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
              </NativeSelect>
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
            <div className=" border-border p-3">
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
  return <div className={` px-3 py-2 text-xs ${className}`}>{children}</div>;
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
