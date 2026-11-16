import {
  DEFAULT_MAP_VIEW,
  type InterconnectSnapshot,
  isObservationStale,
  type MapView,
  summarizeInterconnect,
} from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { toUserFacingError } from "../../lib/user-facing-error";
import { FunctionMaps } from "../function-maps/FunctionMaps";
import { useTheme } from "../ThemeProvider";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { PageHeader } from "../ui/page";
import { ResourceSelectField } from "../ui/resource-select-field";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Table as UiTable,
} from "../ui/table";
import { InterconnectMap } from "./InterconnectMap";
import { type EditTarget, MetadataEditor } from "./MetadataEditor";
import {
  computeTypeLabel,
  filterClusters,
  formatCapacity as formatBytes,
  getStatusLabels,
  type ResourceFilter,
  STATUS_COLORS,
} from "./model";

function Table({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: ReactNode;
  empty: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <UiTable className="w-full text-left text-sm">
        <TableHeader className="border-b border-border ">
          <TableRow>
            {headers.map((h) => (
              <TableHead key={h} className="whitespace-nowrap px-4 py-3 font-medium">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className="[&_td]:px-4 [&_td]:py-3 [&_tr]:border-b [&_tr]:border-border ">
          {children}
        </TableBody>
      </UiTable>
      {empty && (
        <p className="p-8 text-center text-muted-foreground">{t("interconnect.noMatches")}</p>
      )}
    </div>
  );
}
function Distribution({
  title,
  items,
  onClick,
  unit = "",
  format,
}: {
  title: string;
  items: { id: string; name: string; value: number; missing?: boolean }[];
  onClick: (id: string) => void;
  unit?: string;
  format?: (n: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const { resolved } = useTheme();
  const textColor = resolved === "dark" ? "#cbd5e1" : "#4a5060";
  const gridColor = resolved === "dark" ? "#334155" : "#e2e8f0";
  return (
    <section className="min-w-0 border-border p-4">
      <h2 className="font-semibold">{title}</h2>
      {items.length ? (
        <>
          <ReactECharts
            style={{ height: Math.max(140, Math.min(320, items.length * 32 + 50)) }}
            option={{
              animation: false,
              grid: { left: 12, right: 45, top: 18, bottom: 10, containLabel: true },
              tooltip: {
                trigger: "item",
                renderMode: "richText",
                formatter: (p: { dataIndex: number }) => {
                  const row = items[p.dataIndex];
                  return row
                    ? `${row.name}: ${row.missing ? t("interconnect.missing") : format ? format(row.value) : `${row.value}${unit}`}`
                    : "";
                },
              },
              xAxis: {
                type: "value",
                minInterval: 1,
                splitNumber: 3,
                splitLine: { lineStyle: { color: gridColor } },
                axisLabel: {
                  color: textColor,
                  hideOverlap: true,
                  formatter: (value: number) =>
                    format
                      ? format(value)
                      : new Intl.NumberFormat(i18n.language, { notation: "compact" }).format(value),
                },
              },
              yAxis: {
                type: "category",
                data: items.map((i) => i.name),
                inverse: true,
                axisLabel: { width: 90, overflow: "truncate", color: textColor },
                axisLine: { lineStyle: { color: gridColor } },
              },
              series: [
                {
                  type: "bar",
                  data: items.map((i) => i.value),
                  itemStyle: { color: "#3b6cf2", borderRadius: [0, 4, 4, 0] },
                  barMaxWidth: 18,
                },
              ],
              dataZoom:
                items.length > 8
                  ? [{ type: "inside", yAxisIndex: 0, start: 0, end: (8 / items.length) * 100 }]
                  : [],
            }}
            onEvents={{
              click: (p: { dataIndex: number }) => {
                const item = items[p.dataIndex];
                if (item) onClick(item.id);
              },
            }}
          />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("interconnect.showValues")}</summary>
            <div className="mt-2 max-h-48 overflow-auto">
              {items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="flex w-full justify-between gap-3 px-2 py-1.5 text-left "
                  onClick={() => onClick(i.id)}
                >
                  <span>{i.name}</span>
                  <span>
                    {i.missing
                      ? t("interconnect.missing")
                      : format
                        ? format(i.value)
                        : `${i.value}${unit}`}
                  </span>
                </button>
              ))}
            </div>
          </details>
        </>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("interconnect.empty")}</p>
      )}
    </section>
  );
}

export function InterconnectDashboard({ mode }: { mode: "provider" | "operator" }) {
  const { t } = useTranslation();
  const orgId = useActiveOrganizationId();
  const access = usePlatformCapability(
    mode === "provider" ? "workspace.provider.view" : "workspace.platform.view",
  );
  if (!access.ready) return <p>{t("interconnect.loadingAccess")}</p>;
  if (access.error)
    return (
      <div role="alert">
        {t("interconnect.accessFailed")}{" "}
        <Button onClick={access.retry}>{t("interconnect.retry")}</Button>
      </div>
    );
  if (!access.allowed) return <p>{t("interconnect.denied")}</p>;
  return (
    <DashboardContent
      key={`${mode}:${orgId}:${getAuthState().revision}`}
      mode={mode}
      orgId={orgId}
    />
  );
}
function DashboardContent({
  mode,
  orgId,
}: {
  mode: "provider" | "operator";
  orgId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const statusLabels = getStatusLabels(t);
  const formatCapacity = (bytes: number | null) =>
    bytes === null ? t("interconnect.missing") : formatBytes(bytes);
  const time = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : t("interconnect.missing");
  const status = (value: keyof typeof statusLabels) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 " style={{ backgroundColor: STATUS_COLORS[value] }} />
      {statusLabels[value]}
    </span>
  );
  const queryClient = useQueryClient();
  const endpoint = `/interconnect/${mode}`;
  const queryKey = ["interconnect", mode, orgId, getAuthState().revision];
  const query = useQuery({
    queryKey,
    queryFn: () => api.get<InterconnectSnapshot>(`${endpoint}/snapshot`),
    refetchInterval: 30_000,
  });
  const [view, setView] = useState<MapView>(DEFAULT_MAP_VIEW);
  const [viewLoaded, setViewLoaded] = useState(false);
  const [filter, setFilter] = useState<ResourceFilter>({ kind: "centers" });
  const [groupBy, setGroupBy] = useState<"center" | "cluster">("center");
  const [editor, setEditor] = useState<EditTarget | null>(null);
  const [selection, setSelection] = useState<{ kind: "cluster" | "link"; id: string } | null>(null);
  useEffect(() => {
    if (query.error || query.data?.canManage === false) setEditor(null);
  }, [query.error, query.data?.canManage]);
  useEffect(() => {
    if (query.data && !viewLoaded) {
      setView(query.data.defaultView ?? DEFAULT_MAP_VIEW);
      setViewLoaded(true);
    }
  }, [query.data, viewLoaded]);
  const saveView = useMutation({
    mutationFn: () => api.put(`${endpoint}/default-view`, view),
    onSuccess: () => {
      toast.success(t("interconnect.viewSaved"));
    },
    onError: (e) => toast.error(toUserFacingError(e)),
  });
  if (query.isPending || query.error || !query.data) {
    const status = query.isPending ? (
      <p role="status">{t("interconnect.loadingResources")}</p>
    ) : (
      <div role="alert" className="border-border p-4">
        {toUserFacingError(query.error, t("interconnect.loadFailed"))}{" "}
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("interconnect.retry")}
        </Button>
      </div>
    );
    return (
      <div className="space-y-5" data-testid="interconnect-dashboard">
        <PageHeader title={t("workspace.nav.interconnect")} />
        {mode === "operator" ? <FunctionMaps ids={["D03", "G11"]} dashboard={status} /> : status}
      </div>
    );
  }
  const data = query.data;
  const summary = summarizeInterconnect(data.centers, data.clusters);
  const centerName = (id: string) => data.centers.find((c) => c.id === id)?.metadata.name ?? id;
  const clusterName = (id: string) => data.clusters.find((c) => c.id === id)?.metadata.name ?? id;
  const clusters = filterClusters(data.clusters, filter);
  const centers = data.centers.filter(
    (c) =>
      (!filter.centerId || c.id === filter.centerId) &&
      (!filter.centerIds || filter.centerIds.includes(c.id)) &&
      (!filter.status || c.metadata.status === filter.status),
  );
  const links = data.links.filter(
    (l) =>
      !filter.centerId || l.fromCenterId === filter.centerId || l.toCenterId === filter.centerId,
  );
  const applications = clusters.flatMap((c) =>
    c.software
      .filter((s) => !filter.application || s.name === filter.application)
      .map((software) => ({ cluster: c, software })),
  );
  const grouped =
    groupBy === "center"
      ? data.centers.map((c) => ({
          id: c.id,
          name: c.metadata.name,
          clusters: data.clusters.filter((r) => r.centerId === c.id),
        }))
      : data.clusters.map((c) => ({
          id: c.id,
          name: `${centerName(c.centerId)} / ${c.metadata.name}`,
          clusters: [c],
        }));
  const chooseGroup = (id: string, extra: Partial<ResourceFilter> = {}) =>
    setFilter({
      kind: "clusters",
      ...(groupBy === "center" ? { centerId: id } : { clusterId: id }),
      ...extra,
    });
  const typeRows = (kind: "computeTypes" | "storageTypes") =>
    [...new Set(data.clusters.flatMap((c) => c.metadata[kind]))].sort().map((name) => ({
      id: name,
      name: kind === "computeTypes" ? computeTypeLabel(name, t) : name,
      value: data.clusters.filter((c) => c.metadata[kind].some((t) => t === name)).length,
    }));
  const selectedCluster =
    selection?.kind === "cluster" ? data.clusters.find((c) => c.id === selection.id) : undefined;
  const selectedLink =
    selection?.kind === "link" ? data.links.find((l) => l.id === selection.id) : undefined;
  const selectedCenter = filter.centerId
    ? data.centers.find((c) => c.id === filter.centerId)
    : undefined;
  const terminals = summary.succeeded + summary.failed;
  const boundAgents = data.clusters.flatMap((c) => c.agents);
  const healthyAgents = boundAgents.filter(
    (a) => a.status === "online" && !isObservationStale(a.observedAt),
  ).length;
  const metricCards: { label: string; value: ReactNode; state: string; filter: ResourceFilter }[] =
    [
      {
        label: t("interconnect.centers"),
        value: summary.centers,
        state: t("interconnect.centerStates", {
          operational: summary.operational,
          other: summary.centers - summary.operational,
        }),
        filter: { kind: "centers" },
      },
      {
        label: t("interconnect.cpu"),
        value: data.clusters.length > summary.missingCpu ? summary.cpuCores.toLocaleString() : "—",
        state: t("interconnect.registeredClusters", {
          known: data.clusters.length - summary.missingCpu,
          total: data.clusters.length,
        }),
        filter: { kind: "clusters", metric: "cpu" },
      },
      {
        label: t("interconnect.computeTypes"),
        value: summary.computeTypes,
        state: t("interconnect.missingClusters", {
          total: data.clusters.filter((c) => c.metadata.computeTypes.length === 0).length,
        }),
        filter: { kind: "clusters" },
      },
      {
        label: t("interconnect.storage"),
        value:
          data.clusters.length > summary.missingStorage
            ? formatCapacity(summary.storageBytes)
            : "—",
        state: t("interconnect.registeredClusters", {
          known: data.clusters.length - summary.missingStorage,
          total: data.clusters.length,
        }),
        filter: { kind: "clusters", metric: "storage" },
      },
      {
        label: t("interconnect.storageTypes"),
        value: summary.storageTypes,
        state: t("interconnect.missingClusters", {
          total: data.clusters.filter((c) => c.metadata.storageTypes.length === 0).length,
        }),
        filter: { kind: "clusters" },
      },
      {
        label: t("interconnect.applications"),
        value: summary.applications,
        state: t("interconnect.inventoryClusters", {
          total: data.clusters.filter((c) => c.software.some((s) => s.source === "inventory"))
            .length,
        }),
        filter: { kind: "applications" },
      },
    ];
  const overview = (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {metricCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => setFilter(card.filter)}
            className="min-w-0 border-border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand"
          >
            <div className="text-sm text-muted-foreground">{card.label}</div>
            <div className="my-2 break-words text-2xl font-semibold tabular-nums">{card.value}</div>
            <div className="text-xs text-muted-foreground">{card.state}</div>
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setFilter({ kind: "clusters", metric: "jobs" })}
          className="border-b border-border px-4 py-3 text-left text-sm hover:border-brand"
        >
          {t("interconnect.jobSuccess")}{" "}
          <strong className="block mt-1 text-base tabular-nums">
            {terminals
              ? `${((summary.succeeded / terminals) * 100).toFixed(1)}%`
              : t("interconnect.noFinishedJobs")}
          </strong>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("interconnect.jobCounts", { succeeded: summary.succeeded, failed: summary.failed })}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setFilter({ kind: "clusters", metric: "agents" })}
          className="border-b border-border px-4 py-3 text-left text-sm hover:border-brand"
        >
          {t("interconnect.agentHealth")}{" "}
          <strong className="block mt-1 text-base tabular-nums">
            {boundAgents.length
              ? `${((healthyAgents / boundAgents.length) * 100).toFixed(1)}%`
              : t("interconnect.noAgents")}
          </strong>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("interconnect.heartbeatCounts", {
              healthy: healthyAgents,
              total: boundAgents.length,
            })}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setFilter({ kind: "links" })}
          className="border-b border-border px-4 py-3 text-left text-sm hover:border-brand"
        >
          {t("interconnect.links")}{" "}
          <strong className="block mt-1 text-base tabular-nums">{data.links.length}</strong>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("interconnect.staleLinks", {
              total: data.links.filter((l) => isObservationStale(l.metadata.observedAt)).length,
            })}
          </p>
        </button>
      </div>
      {viewLoaded && (
        <InterconnectMap
          snapshot={data}
          view={view}
          onView={setView}
          onSave={() => saveView.mutate()}
          saving={saveView.isPending}
          onCenters={(ids) =>
            setFilter(
              ids.length === 1
                ? { kind: "clusters", centerId: ids[0] }
                : { kind: "centers", centerIds: ids },
            )
          }
          onLink={(id) => setSelection({ kind: "link", id })}
        />
      )}
      <div className="kq-fill-row">
        <h2 className="mr-auto font-semibold">{t("interconnect.distributions")}</h2>
        {(
          [
            ["center", t("interconnect.byCenter")],
            ["cluster", t("interconnect.byCluster")],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={groupBy === value ? "default" : "outline"}
            size="sm"
            onClick={() => setGroupBy(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Distribution
          title={t("interconnect.centerStatus")}
          items={Object.entries(statusLabels).map(([id, name]) => ({
            id,
            name,
            value: data.centers.filter((c) => c.metadata.status === id).length,
          }))}
          onClick={(status) => setFilter({ kind: "centers", status })}
        />
        <Distribution
          title={t("interconnect.cpuDistribution")}
          items={grouped.map((g) => ({
            id: g.id,
            name: g.name,
            value: g.clusters.reduce((n, c) => n + (c.metadata.cpuCores ?? 0), 0),
            missing: !g.clusters.some((c) => c.metadata.cpuCores !== null),
          }))}
          onClick={(id) => chooseGroup(id, { metric: "cpu" })}
        />
        <Distribution
          title={t("interconnect.storageDistribution")}
          items={grouped.map((g) => ({
            id: g.id,
            name: g.name,
            value: g.clusters.reduce((n, c) => n + (c.metadata.storageBytes ?? 0), 0),
            missing: !g.clusters.some((c) => c.metadata.storageBytes !== null),
          }))}
          format={formatCapacity}
          onClick={(id) => chooseGroup(id, { metric: "storage" })}
        />
        <Distribution
          title={t("interconnect.computeDistribution")}
          items={typeRows("computeTypes")}
          onClick={(computeType) => setFilter({ kind: "clusters", computeType })}
        />
        <Distribution
          title={t("interconnect.storageTypeDistribution")}
          items={typeRows("storageTypes")}
          onClick={(storageType) => setFilter({ kind: "clusters", storageType })}
        />
        <Distribution
          title={t("interconnect.applicationDistribution")}
          items={grouped.map((g) => ({
            id: g.id,
            name: g.name,
            value: new Set(g.clusters.flatMap((c) => c.software.map((s) => s.name))).size,
          }))}
          onClick={(id) => chooseGroup(id, { kind: "applications" })}
        />
      </div>
    </div>
  );
  return (
    <div className="space-y-5" data-testid="interconnect-dashboard">
      <PageHeader title={t("workspace.nav.interconnect")} />
      <div className="kq-fill-row text-sm">
        <span className="mr-auto text-muted-foreground">
          {mode === "operator"
            ? t("interconnect.platformScope")
            : t("interconnect.organizationScope")}{" "}
          · {t("interconnect.updated", { time: time(data.generatedAt) })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t("interconnect.refresh")}
        </Button>
        {data.canManage &&
          (
            [
              ["centers", t("interconnect.addCenter")],
              ["clusters", t("interconnect.addCluster")],
              ["links", t("interconnect.addLink")],
            ] as const
          ).map(([kind, label]) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              disabled={kind !== "centers" && data.centers.length < (kind === "links" ? 2 : 1)}
              onClick={() => setEditor({ kind })}
            >
              {label}
            </Button>
          ))}
      </div>
      {mode === "operator" ? (
        <FunctionMaps
          ids={["D03", "G11"]}
          dashboard={overview}
          common={
            <p className="text-sm text-muted-foreground">
              {t("interconnect.jobCounts", {
                succeeded: summary.succeeded,
                failed: summary.failed,
              })}
              {" · "}
              {t("interconnect.heartbeatCounts", {
                healthy: healthyAgents,
                total: boundAgents.length,
              })}
            </p>
          }
        />
      ) : (
        overview
      )}
      <section className=" border-border " aria-label={t("interconnect.details")}>
        <div className="kq-fill-row border-b border-border p-4">
          <h2 className="mr-auto font-semibold">{t("interconnect.details")}</h2>
          {(
            [
              ["centers", t("interconnect.centers")],
              ["clusters", t("interconnect.clusters")],
              ["applications", t("interconnect.applications")],
              ["links", t("interconnect.link")],
            ] as const
          ).map(([kind, label]) => (
            <Button
              key={kind}
              size="sm"
              variant={filter.kind === kind ? "default" : "outline"}
              onClick={() => setFilter({ kind })}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="kq-fill-row border-b border-border p-4 text-sm">
          <span>{t("interconnect.filter")}</span>
          <ResourceSelectField
            resourceType="compute-centers"
            aria-label={t("interconnect.filterCenter")}
            className="max-w-full p-1.5"
            value={filter.centerId ?? ""}
            onChange={(e) =>
              setFilter({
                ...filter,
                centerId: e.target.value || undefined,
                centerIds: undefined,
                clusterId: undefined,
              })
            }
          >
            <option value="">{t("interconnect.allCenters")}</option>
            {data.centers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.metadata.name}
              </option>
            ))}
          </ResourceSelectField>
          {[
            filter.clusterId ? clusterName(filter.clusterId) : null,
            filter.centerIds
              ? t("interconnect.mapNodes", { total: filter.centerIds.length })
              : null,
            filter.computeType ? computeTypeLabel(filter.computeType, t) : null,
            filter.storageType,
            filter.application,
            filter.status ? statusLabels[filter.status as keyof typeof statusLabels] : null,
            filter.metric
              ? {
                  cpu: t("interconnect.cpu"),
                  storage: t("interconnect.storageCapacity"),
                  jobs: t("interconnect.jobSuccess"),
                  agents: t("interconnect.agentHealth"),
                }[filter.metric]
              : null,
          ]
            .filter(Boolean)
            .map((label) => (
              <span key={label} className=" px-2 py-1">
                {label}
              </span>
            ))}
          <Button size="sm" variant="ghost" onClick={() => setFilter({ kind: filter.kind })}>
            {t("interconnect.clearFilters")}
          </Button>
        </div>
        {selectedCenter && (
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-sm">
            <strong>{selectedCenter.metadata.name}</strong>
            {status(selectedCenter.metadata.status)}
            <span>
              {[
                selectedCenter.metadata.country,
                selectedCenter.metadata.province,
                selectedCenter.metadata.city,
              ]
                .filter(Boolean)
                .join(" / ")}
            </span>
            <span className="text-muted-foreground">{selectedCenter.id}</span>
            <span>
              {t("interconnect.clusterCount", {
                total: data.clusters.filter((c) => c.centerId === selectedCenter.id).length,
              })}
            </span>
            {data.canManage && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditor({ kind: "centers", id: selectedCenter.id })}
              >
                {t("interconnect.editCenter")}
              </Button>
            )}
          </div>
        )}
        {filter.kind === "centers" && (
          <Table
            headers={[
              t("interconnect.centers"),
              t("interconnect.location"),
              t("interconnect.statusLabel"),
              t("interconnect.clusters"),
              t("interconnect.cpu"),
              t("interconnect.storageShort"),
              t("interconnect.actions"),
            ]}
            empty={!centers.length}
          >
            {centers.map((c) => {
              const children = data.clusters.filter((x) => x.centerId === c.id);
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <button
                      className="text-brand underline-offset-4 hover:underline"
                      type="button"
                      onClick={() => setFilter({ kind: "clusters", centerId: c.id })}
                    >
                      {c.metadata.name}
                    </button>
                  </TableCell>
                  <TableCell>
                    {[c.metadata.country, c.metadata.province, c.metadata.city]
                      .filter(Boolean)
                      .join(" / ")}
                  </TableCell>
                  <TableCell>{status(c.metadata.status)}</TableCell>
                  <TableCell>{children.length}</TableCell>
                  <TableCell>
                    {children.some((r) => r.metadata.cpuCores !== null)
                      ? children
                          .reduce((n, r) => n + (r.metadata.cpuCores ?? 0), 0)
                          .toLocaleString()
                      : t("interconnect.missing")}
                  </TableCell>
                  <TableCell>
                    {formatCapacity(
                      children.some((r) => r.metadata.storageBytes !== null)
                        ? children.reduce((n, r) => n + (r.metadata.storageBytes ?? 0), 0)
                        : null,
                    )}
                  </TableCell>
                  <TableCell>
                    {data.canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditor({ kind: "centers", id: c.id })}
                      >
                        {t("interconnect.edit")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        )}
        {filter.kind === "clusters" && (
          <Table
            headers={[
              t("interconnect.clusters"),
              t("interconnect.centers"),
              t("interconnect.statusLabel"),
              t("interconnect.cpu"),
              t("interconnect.computeTypes"),
              t("interconnect.storageCapacity"),
              t("interconnect.storageTypes"),
              t("interconnect.software"),
              ...(filter.metric === "jobs"
                ? [t("interconnect.jobs24h")]
                : filter.metric === "agents"
                  ? [t("interconnect.agentsHealthy")]
                  : []),
              t("interconnect.updatedAt"),
            ]}
            empty={!clusters.length}
          >
            {clusters.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <button
                    type="button"
                    className="text-brand hover:underline"
                    onClick={() => setSelection({ kind: "cluster", id: c.id })}
                  >
                    {c.metadata.name}
                  </button>
                </TableCell>
                <TableCell>{centerName(c.centerId)}</TableCell>
                <TableCell>{status(c.metadata.status)}</TableCell>
                <TableCell>
                  {c.metadata.cpuCores?.toLocaleString() ?? t("interconnect.missing")}
                </TableCell>
                <TableCell>
                  {c.metadata.computeTypes.map((type) => computeTypeLabel(type, t)).join(", ") ||
                    t("interconnect.missing")}
                </TableCell>
                <TableCell>{formatCapacity(c.metadata.storageBytes)}</TableCell>
                <TableCell>
                  {c.metadata.storageTypes.join(", ") || t("interconnect.missing")}
                </TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="text-brand"
                    onClick={() => setFilter({ ...filter, kind: "applications", clusterId: c.id })}
                  >
                    {c.software.length}
                  </button>
                </TableCell>
                {filter.metric === "jobs" && (
                  <TableCell>
                    {c.jobs24h.succeeded} / {c.jobs24h.failed}
                  </TableCell>
                )}
                {filter.metric === "agents" && (
                  <TableCell>
                    {
                      c.agents.filter(
                        (a) => a.status === "online" && !isObservationStale(a.observedAt),
                      ).length
                    }{" "}
                    / {c.agents.length}
                  </TableCell>
                )}
                <TableCell className="whitespace-nowrap text-xs">{time(c.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
        {filter.kind === "applications" && (
          <>
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {t("interconnect.applicationCounts", {
                software: new Set(applications.map((r) => r.software.name)).size,
                associations: applications.length,
              })}
            </p>
            <Table
              headers={[
                t("interconnect.applications"),
                t("interconnect.centers"),
                t("interconnect.clusters"),
                t("interconnect.source"),
                t("interconnect.reportedAt"),
              ]}
              empty={!applications.length}
            >
              {applications.map(({ cluster: c, software: s }) => (
                <TableRow key={`${c.id}:${s.name}`}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-brand"
                      onClick={() => setFilter({ ...filter, application: s.name })}
                    >
                      {s.name}
                    </button>
                  </TableCell>
                  <TableCell>{centerName(c.centerId)}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-brand"
                      onClick={() => setSelection({ kind: "cluster", id: c.id })}
                    >
                      {c.metadata.name}
                    </button>
                  </TableCell>
                  <TableCell>
                    {s.source === "inventory"
                      ? t("interconnect.inventory")
                      : t("interconnect.declared")}
                  </TableCell>
                  <TableCell>
                    {s.source === "declared"
                      ? t("interconnect.unverified")
                      : `${isObservationStale(s.observedAt) ? t("interconnect.reportStalePrefix") : t("interconnect.installedPrefix")}${time(s.observedAt)}`}
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </>
        )}
        {filter.kind === "links" && (
          <Table
            headers={[
              t("interconnect.link"),
              t("interconnect.from"),
              t("interconnect.to"),
              t("interconnect.statusLabel"),
              t("interconnect.observedAt"),
            ]}
            empty={!links.length}
          >
            {links.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  <button
                    type="button"
                    className="text-brand"
                    onClick={() => setSelection({ kind: "link", id: l.id })}
                  >
                    {l.metadata.name}
                  </button>
                </TableCell>
                <TableCell>{centerName(l.fromCenterId)}</TableCell>
                <TableCell>{centerName(l.toCenterId)}</TableCell>
                <TableCell>
                  {status(
                    isObservationStale(l.metadata.observedAt) ? "unknown" : l.metadata.status,
                  )}
                  {isObservationStale(l.metadata.observedAt) && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("interconnect.stale")}
                    </span>
                  )}
                </TableCell>
                <TableCell>{time(l.metadata.observedAt)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("interconnect.counting")}</summary>
        <p className="mt-2 leading-6">{t("interconnect.countingRules")}</p>
      </details>
      {selection && (selectedCluster || selectedLink) && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelection(null);
          }}
        >
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>
                {selectedCluster?.metadata.name ?? selectedLink?.metadata.name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 overflow-y-auto p-5 text-sm">
              <p className="break-all text-xs text-muted-foreground">{selection.id}</p>
              {selectedCluster && (
                <>
                  <p>
                    {centerName(selectedCluster.centerId)} ·{" "}
                    {status(selectedCluster.metadata.status)}
                  </p>
                  <dl className="grid grid-cols-2 gap-3">
                    <dt>{t("interconnect.cpu")}</dt>
                    <dd>{selectedCluster.metadata.cpuCores ?? t("interconnect.missing")}</dd>
                    <dt>{t("interconnect.computeTypes")}</dt>
                    <dd>
                      {selectedCluster.metadata.computeTypes
                        .map((type) => computeTypeLabel(type, t))
                        .join(", ") || t("interconnect.missing")}
                    </dd>
                    <dt>{t("interconnect.storageCapacity")}</dt>
                    <dd>{formatCapacity(selectedCluster.metadata.storageBytes)}</dd>
                    <dt>{t("interconnect.storageTypes")}</dt>
                    <dd>
                      {selectedCluster.metadata.storageTypes.join(", ") ||
                        t("interconnect.missing")}
                    </dd>
                    <dt>{t("interconnect.recordUpdatedAt")}</dt>
                    <dd>{time(selectedCluster.updatedAt)}</dd>
                  </dl>
                  <h3 className="font-semibold">Agent</h3>
                  {selectedCluster.agents.length ? (
                    selectedCluster.agents.map((a) => (
                      <div key={a.id} className="break-words border-border p-2">
                        {a.id} ·{" "}
                        {isObservationStale(a.observedAt)
                          ? t("interconnect.staleHeartbeat")
                          : a.status}
                        <p className="text-xs text-muted-foreground">{time(a.observedAt)}</p>
                      </div>
                    ))
                  ) : (
                    <p>{t("interconnect.noAgents")}</p>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilter({
                        kind: "applications",
                        centerId: selectedCluster.centerId,
                        clusterId: selectedCluster.id,
                      });
                      setSelection(null);
                    }}
                  >
                    {t("interconnect.viewSoftware", { total: selectedCluster.software.length })}
                  </Button>
                </>
              )}
              {selectedLink && (
                <>
                  <p>
                    <button
                      type="button"
                      className="text-brand"
                      onClick={() => {
                        setFilter({ kind: "clusters", centerId: selectedLink.fromCenterId });
                        setSelection(null);
                      }}
                    >
                      {centerName(selectedLink.fromCenterId)}
                    </button>{" "}
                    ↔{" "}
                    <button
                      type="button"
                      className="text-brand"
                      onClick={() => {
                        setFilter({ kind: "clusters", centerId: selectedLink.toCenterId });
                        setSelection(null);
                      }}
                    >
                      {centerName(selectedLink.toCenterId)}
                    </button>
                  </p>
                  <p>
                    {status(
                      isObservationStale(selectedLink.metadata.observedAt)
                        ? "unknown"
                        : selectedLink.metadata.status,
                    )}
                    {isObservationStale(selectedLink.metadata.observedAt) &&
                      t("interconnect.lastStatus", {
                        status: statusLabels[selectedLink.metadata.status],
                      })}
                  </p>
                  <dl className="grid grid-cols-2 gap-3">
                    {(
                      [
                        ["bandwidthMbps", t("interconnect.bandwidth"), "Mbps"],
                        ["throughputMbps", t("interconnect.throughput"), "Mbps"],
                        ["latencyMs", t("interconnect.latency"), "ms"],
                        ["packetLossPercent", t("interconnect.packetLoss"), "%"],
                      ] as const
                    ).map(([key, label, unit]) => (
                      <div key={key} className="contents">
                        <dt>{label}</dt>
                        <dd>
                          {selectedLink.metadata[key] === null
                            ? t("interconnect.notMeasured")
                            : `${selectedLink.metadata[key]} ${unit}`}
                        </dd>
                      </div>
                    ))}
                    <dt>{t("interconnect.observedAt")}</dt>
                    <dd>{time(selectedLink.metadata.observedAt)}</dd>
                    <dt>{t("interconnect.source")}</dt>
                    <dd>{selectedLink.metadata.source || t("interconnect.missing")}</dd>
                  </dl>
                </>
              )}
              {data.canManage && (
                <Button
                  onClick={() => {
                    setEditor({
                      kind: selection.kind === "cluster" ? "clusters" : "links",
                      id: selection.id,
                    });
                    setSelection(null);
                  }}
                >
                  {t("interconnect.editRecord")}
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {editor && data.canManage && (
        <MetadataEditor
          target={editor}
          snapshot={data}
          onClose={() => setEditor(null)}
          onSave={async (body) => {
            if (editor.id) await api.put(`${endpoint}/${editor.kind}/${editor.id}`, body);
            else await api.post(`${endpoint}/${editor.kind}`, body);
            await queryClient.invalidateQueries({ queryKey: ["interconnect"] });
            toast.success(t("interconnect.saved"));
          }}
          onDelete={async () => {
            await api.delete(`${endpoint}/${editor.kind}/${editor.id}`);
            await queryClient.invalidateQueries({ queryKey: ["interconnect"] });
            toast.success(t("interconnect.deleted"));
          }}
        />
      )}
    </div>
  );
}
