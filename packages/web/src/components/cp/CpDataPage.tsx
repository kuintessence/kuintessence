import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, HardDriveDownload, Network, ShieldCheck } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import {
  type DataAccessRequest,
  type DataAssetSummary,
  type DataAssetVersion,
  dataMarketClient,
} from "../../lib/data-market-client";
import { useCpAgentClusterFileRoots, useCpAgents } from "../../lib/use-cp-agents";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { PageHeader, PageShell } from "../ui/page";

export function CpDataPage() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const activeOrganizationId = useActiveOrganizationId();
  const previousOrganizationId = useRef(activeOrganizationId);
  const activeOrganizationIdRef = useRef(activeOrganizationId);
  const selectedAssetIdRef = useRef<string | null>(null);
  const [asset, setAsset] = useState<DataAssetSummary | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<DataAssetVersion | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("v1");
  const [managedRootId, setManagedRootId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [agentId, setAgentId] = useState("");
  const [isCreatingAsset, setIsCreatingAsset] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const agents = useCpAgents();
  const roots = useCpAgentClusterFileRoots(agentId || null);
  const enabledRoots = (roots.data ?? []).filter(
    (root) => root.enabled && root.agentId === agentId,
  );
  const assets = useQuery({
    enabled: Boolean(activeOrganizationId),
    queryKey: ["cp-data", activeOrganizationId, "assets"],
    queryFn: () => dataMarketClient.cpAssets(),
  });
  const versions = useQuery({
    enabled: Boolean(activeOrganizationId && asset),
    queryKey: ["cp-data", activeOrganizationId, "versions", asset?.id],
    queryFn: () => dataMarketClient.cpVersions(asset?.id ?? ""),
  });
  const replicas = useQuery({
    enabled: Boolean(activeOrganizationId && selectedVersion),
    queryKey: ["cp-data", activeOrganizationId, "replicas", selectedVersion?.id],
    queryFn: () => dataMarketClient.cpReplicas(selectedVersion?.id ?? ""),
  });
  const imports = useQuery({
    enabled: Boolean(activeOrganizationId),
    queryKey: ["cp-data", activeOrganizationId, "imports"],
    queryFn: () => dataMarketClient.cpImports(),
    refetchInterval: (query) =>
      query.state.data?.imports.some(
        (dataImport) => dataImport.status === "pending" || dataImport.status === "running",
      )
        ? 5_000
        : false,
  });
  const accessRequests = useQuery({
    enabled: Boolean(activeOrganizationId),
    queryKey: ["cp-data", activeOrganizationId, "access-requests"],
    queryFn: () => dataMarketClient.cpAccessRequests(),
  });
  const accessRequestDetail = useQuery({
    enabled: Boolean(activeOrganizationId && selectedRequestId),
    queryKey: ["cp-data", activeOrganizationId, "access-request", selectedRequestId],
    queryFn: () => dataMarketClient.cpAccessRequest(selectedRequestId ?? ""),
  });

  useLayoutEffect(() => {
    activeOrganizationIdRef.current = activeOrganizationId;
  }, [activeOrganizationId]);

  useLayoutEffect(() => {
    selectedAssetIdRef.current = asset?.id ?? null;
  }, [asset]);

  useEffect(() => {
    const previous = previousOrganizationId.current;
    previousOrganizationId.current = activeOrganizationId;
    if (previous === activeOrganizationId) return;
    setAsset(null);
    setSelectedVersion(null);
    setSelectedRequestId(null);
    setAgentId("");
    setManagedRootId("");
    setRelativePath("");
    cache.removeQueries({ queryKey: ["cp-data", previous] });
  }, [activeOrganizationId, cache]);

  async function refreshOrganization(organizationId: string): Promise<void> {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["cp-data", organizationId, "assets"] }),
      cache.invalidateQueries({ queryKey: ["cp-data", organizationId, "versions"] }),
      cache.invalidateQueries({ queryKey: ["cp-data", organizationId, "replicas"] }),
      cache.invalidateQueries({ queryKey: ["cp-data", organizationId, "imports"] }),
      cache.invalidateQueries({ queryKey: ["cp-data", organizationId, "access-requests"] }),
    ]);
  }

  async function createAsset(): Promise<void> {
    if (!name.trim() || !activeOrganizationId || assets.isError || isCreatingAsset) return;
    const operationOrganizationId = activeOrganizationId;
    setIsCreatingAsset(true);
    try {
      const created = await dataMarketClient.createCpAsset({
        name: name.trim(),
        visibility: "organization",
      });
      await refreshOrganization(operationOrganizationId);
      if (activeOrganizationIdRef.current !== operationOrganizationId) return;
      setAsset(created);
      setSelectedVersion(null);
      setName("");
      toast.success(t("cp.data.created"));
    } catch (error) {
      if (activeOrganizationIdRef.current === operationOrganizationId) {
        toast.error(toUserFacingError(error, t("cp.data.failed")));
      }
    } finally {
      setIsCreatingAsset(false);
    }
  }

  async function importVersion(): Promise<void> {
    if (!asset || !activeOrganizationId || !version.trim() || versions.isError || isImporting)
      return;
    if (!agentId.trim() || !managedRootId.trim() || !relativePath.trim()) {
      toast.error(t("cp.data.managedRootRequired"));
      return;
    }
    const operationOrganizationId = activeOrganizationId;
    setIsImporting(true);
    try {
      const result = await dataMarketClient.startCpImport(asset.id, version.trim(), {
        agentId: agentId.trim(),
        kind: "cp-local",
        managedRootId: managedRootId.trim(),
        relativePath: relativePath.trim(),
      });
      await refreshOrganization(operationOrganizationId);
      if (activeOrganizationIdRef.current !== operationOrganizationId) return;
      if (selectedAssetIdRef.current !== result.version.assetId) return;
      setSelectedVersion(result.version);
      if (result.replayed && result.dataImport.status === "failed") {
        toast.error(toUserFacingError(result.dataImport.errorMessage, t("cp.data.importFailed")));
        return;
      }
      if (result.replayed && result.dataImport.status === "completed") {
        toast.success(t("cp.data.importAvailable"));
        return;
      }
      if (result.replayed && result.dataImport.status === "canceled") {
        toast.error(t("cp.data.importCanceled"));
        return;
      }
      toast.success(
        t(
          result.dispatchState === "dispatched"
            ? "cp.data.importDispatched"
            : "cp.data.importQueued",
        ),
      );
    } catch (error) {
      if (activeOrganizationIdRef.current !== operationOrganizationId) return;
      const message = toUserFacingError(error, t("cp.data.failed"));
      toast.error(
        message.includes("DATA_IMPORT_UNAVAILABLE") ? t("cp.data.importUnavailable") : message,
      );
    } finally {
      setIsImporting(false);
    }
  }

  async function review(request: DataAccessRequest, decision: "approve" | "reject"): Promise<void> {
    if (!activeOrganizationId || accessRequests.isError || reviewingRequestId) return;
    const operationOrganizationId = activeOrganizationId;
    setReviewingRequestId(request.id);
    try {
      await dataMarketClient.reviewCpAccessRequest(request.id, { decision });
      await refreshOrganization(operationOrganizationId);
      if (activeOrganizationIdRef.current !== operationOrganizationId) return;
      await cache.invalidateQueries({
        queryKey: ["cp-data", operationOrganizationId, "access-request", request.id],
      });
      toast.success(t("cp.data.reviewed"));
    } catch (error) {
      if (activeOrganizationIdRef.current === operationOrganizationId) {
        toast.error(toUserFacingError(error, t("cp.data.failed")));
      }
    } finally {
      setReviewingRequestId(null);
    }
  }

  return (
    <PageShell data-testid="cp-data-page">
      <PageHeader title={t("cp.data.title")} subtitle={t("cp.data.subtitle")} />
      {!activeOrganizationId ? (
        <p className="text-sm text-muted-foreground">{t("cp.data.organizationRequired")}</p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <Database /> {t("cp.data.createAsset")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("dataMarket.name")}
            />
            <Button
              disabled={!activeOrganizationId || assets.isError || isCreatingAsset}
              onClick={() => void createAsset()}
            >
              {t("cp.data.create")}
            </Button>
            <QueryFeedback query={assets} onRetry={() => void assets.refetch()} />
            {!assets.isError ? (
              <AssetList
                assets={assets.data?.assets ?? []}
                selected={asset?.id ?? null}
                onSelect={(next) => {
                  setAsset(next);
                  setSelectedVersion(null);
                }}
              />
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <HardDriveDownload /> {t("cp.data.import")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="v1"
            />
            <p className="text-xs text-muted-foreground">{t("cp.data.cpLocalOnly")}</p>
            <label className="space-y-1 text-sm">
              <span className="font-medium">{t("cp.data.agent")}</span>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value);
                  setManagedRootId("");
                }}
                disabled={!activeOrganizationId || agents.isLoading || agents.isError}
                data-testid="cp-data-agent-select"
              >
                <option value="">{t("cp.data.agentPlaceholder")}</option>
                {(agents.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.hostname} ({agent.siteId})
                  </option>
                ))}
              </select>
            </label>
            <QueryFeedback query={agents} onRetry={() => void agents.refetch()} />
            {!agents.isLoading && !agents.isError && (agents.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{t("cp.data.agentEmpty")}</p>
            ) : null}
            <label className="space-y-1 text-sm">
              <span className="font-medium">{t("cp.data.managedRoot")}</span>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={managedRootId}
                onChange={(event) => setManagedRootId(event.target.value)}
                disabled={!agentId || roots.isLoading || roots.isError || enabledRoots.length === 0}
                data-testid="cp-data-root-select"
              >
                <option value="">{t("cp.data.managedRootPlaceholder")}</option>
                {enabledRoots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.label} - {root.path}
                  </option>
                ))}
              </select>
            </label>
            {agentId ? <QueryFeedback query={roots} onRetry={() => void roots.refetch()} /> : null}
            {agentId && !roots.isLoading && !roots.isError && enabledRoots.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("cp.data.managedRootEmpty")}</p>
            ) : null}
            <Input
              value={relativePath}
              onChange={(event) => setRelativePath(event.target.value)}
              placeholder={t("cp.data.relativePath")}
            />
            <p className="text-xs text-muted-foreground">{t("cp.data.cpLocalHint")}</p>
            <Button
              disabled={
                !activeOrganizationId ||
                !asset ||
                !agentId ||
                !managedRootId ||
                !relativePath.trim() ||
                isImporting ||
                versions.isError
              }
              onClick={() => void importVersion()}
            >
              {t("cp.data.import")}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <Network /> {t("cp.data.replica")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!versions.isError ? (
              <VersionList
                versions={versions.data?.versions ?? []}
                selected={selectedVersion?.id ?? null}
                onSelect={setSelectedVersion}
              />
            ) : null}
            <QueryFeedback query={versions} onRetry={() => void versions.refetch()} />
            <QueryFeedback query={replicas} onRetry={() => void replicas.refetch()} />
            {!replicas.isError ? <ReplicaList replicas={replicas.data?.replicas ?? []} /> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <ShieldCheck /> {t("cp.data.permissions")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("cp.data.permissionHint")}</p>
            {!accessRequests.isError ? (
              <AccessRequestList
                requests={accessRequests.data?.requests ?? []}
                onReview={review}
                reviewDisabled={!activeOrganizationId || accessRequests.isError}
                reviewingRequestId={reviewingRequestId}
                onSelect={setSelectedRequestId}
              />
            ) : null}
            <QueryFeedback query={accessRequests} onRetry={() => void accessRequests.refetch()} />
            <QueryFeedback
              query={accessRequestDetail}
              onRetry={() => void accessRequestDetail.refetch()}
            />
            {!accessRequestDetail.isError && accessRequestDetail.data ? (
              <AccessRequestDetail request={accessRequestDetail.data} />
            ) : null}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("cp.data.imports")}</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryFeedback query={imports} onRetry={() => void imports.refetch()} />
          {!imports.isError ? <ImportList imports={imports.data?.imports ?? []} /> : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function QueryFeedback({
  query,
  onRetry,
}: {
  query: { error: unknown; isError: boolean; isLoading: boolean };
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (query.isLoading) {
    return <p className="text-xs text-muted-foreground">{t("common.loading")}</p>;
  }
  if (!query.isError) return null;
  return (
    <div className="flex flex-wrap items-start gap-2 text-xs text-status-failed" role="alert">
      <span className="min-w-0 break-words">
        {toUserFacingError(query.error, t("cp.data.failed"))}
      </span>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        {t("common.refresh")}
      </Button>
    </div>
  );
}

function AssetList({
  assets,
  selected,
  onSelect,
}: {
  assets: DataAssetSummary[];
  selected: string | null;
  onSelect: (asset: DataAssetSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {assets.map((asset) => (
        <button
          className="flex w-full items-center justify-between gap-2 rounded border p-2 text-left text-xs"
          data-testid={`cp-data-asset-${asset.id}`}
          key={asset.id}
          onClick={() => onSelect(asset)}
          type="button"
        >
          <span className="min-w-0 truncate" title={asset.name}>
            {asset.name}
          </span>
          <span className="shrink-0">
            {selected === asset.id
              ? t("cp.data.selected")
              : t("dataMarket.lifecycle", { lifecycle: asset.lifecycle })}
          </span>
        </button>
      ))}
    </div>
  );
}

function VersionList({
  versions,
  selected,
  onSelect,
}: {
  versions: DataAssetVersion[];
  selected: string | null;
  onSelect: (version: DataAssetVersion) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("cp.data.versionEmpty")}</p>
      ) : null}
      {versions.map((version) => (
        <button
          className={`flex w-full items-center justify-between gap-2 rounded border p-2 text-left text-xs ${
            selected === version.id ? "border-brand bg-brand-soft" : ""
          }`}
          data-testid={`cp-data-version-${version.id}`}
          key={version.id}
          onClick={() => onSelect(version)}
          type="button"
        >
          <span className="min-w-0 truncate" title={version.version}>
            {version.version}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {selected === version.id ? (
              <span className="text-brand">{t("cp.data.selected")}</span>
            ) : null}
            <Badge variant="outline">{version.status}</Badge>
          </span>
        </button>
      ))}
    </div>
  );
}

function ReplicaList({
  replicas,
}: {
  replicas: Awaited<ReturnType<typeof dataMarketClient.cpReplicas>>["replicas"];
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {replicas.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("cp.data.replicaEmpty")}</p>
      ) : null}
      {replicas.map((replica) => (
        <p className="rounded bg-muted p-2 text-xs" key={replica.id}>
          {t("cp.data.runnableCenter", {
            center: `${replica.siteId}/${replica.clusterId}`,
            status: replica.status,
          })}
        </p>
      ))}
    </div>
  );
}

function ImportList({
  imports,
}: {
  imports: Awaited<ReturnType<typeof dataMarketClient.cpImports>>["imports"];
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {imports.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("cp.data.importEmpty")}</p>
      ) : null}
      {imports.map((item) => {
        const statusKey =
          item.status === "completed"
            ? "cp.data.importAvailable"
            : item.status === "failed"
              ? "cp.data.importFailed"
              : item.status === "running"
                ? "cp.data.importScanning"
                : item.status === "pending"
                  ? "cp.data.importWaiting"
                  : "cp.data.importCanceled";
        return (
          <div className="rounded bg-muted p-2 text-xs" key={item.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {item.version} · {item.sourceKind}
              </span>
              <Badge variant={item.status === "failed" ? "failed" : "outline"}>
                {t(statusKey)}
              </Badge>
            </div>
            {item.errorMessage ? (
              <p className="mt-1 break-words text-status-failed">
                {toUserFacingError(item.errorMessage, t("cp.data.importFailed"))}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AccessRequestList({
  requests,
  onReview,
  reviewDisabled,
  reviewingRequestId,
  onSelect,
}: {
  requests: DataAccessRequest[];
  onReview: (request: DataAccessRequest, decision: "approve" | "reject") => void;
  reviewDisabled: boolean;
  reviewingRequestId: string | null;
  onSelect: (requestId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {requests.map((request) => (
        <div className="rounded border p-2 text-xs" key={request.id}>
          <button className="w-full text-left" onClick={() => onSelect(request.id)} type="button">
            <p>
              {request.capability} · {request.status}
            </p>
            <p className="text-muted-foreground">{request.reason ?? t("cp.data.noReason")}</p>
          </button>
          {request.status === "pending" ? (
            <div className="mt-2 flex gap-2">
              <Button
                disabled={reviewDisabled || reviewingRequestId !== null}
                onClick={() => onReview(request, "approve")}
                size="sm"
              >
                {t("cp.data.approve")}
              </Button>
              <Button
                disabled={reviewDisabled || reviewingRequestId !== null}
                onClick={() => onReview(request, "reject")}
                size="sm"
                variant="outline"
              >
                {t("cp.data.reject")}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AccessRequestDetail({ request }: { request: DataAccessRequest }) {
  const { t } = useTranslation();
  return (
    <div className="rounded bg-muted p-2 text-xs" data-testid="cp-data-access-request-detail">
      <p>{t("cp.data.requestSubject", { subject: request.subjectId })}</p>
      <p>{t("cp.data.requestDecision", { decision: request.decisionReason ?? request.status })}</p>
    </div>
  );
}
