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
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { useTheme } from "../ThemeProvider";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { PageHeader } from "../ui/page";
import { InterconnectMap } from "./InterconnectMap";
import { type EditTarget, MetadataEditor } from "./MetadataEditor";
import {
  filterClusters,
  formatCapacity,
  type ResourceFilter,
  STATUS_COLORS,
  STATUS_LABELS,
} from "./model";

const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "未提供");
const status = (value: keyof typeof STATUS_LABELS) => (
  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLORS[value] }} />
    {STATUS_LABELS[value]}
  </span>
);
function Table({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: ReactNode;
  empty: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-muted/40">
          <tr>
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:px-4 [&_td]:py-3 [&_tr]:border-b [&_tr]:border-border [&_tr:last-child]:border-0">
          {children}
        </tbody>
      </table>
      {empty && <p className="p-8 text-center text-muted-foreground">没有符合条件的记录</p>}
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
  const { resolved } = useTheme();
  const textColor = resolved === "dark" ? "#cbd5e1" : "#4a5060";
  const gridColor = resolved === "dark" ? "#334155" : "#e2e8f0";
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
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
                    ? `${row.name}: ${row.missing ? "未提供" : format ? format(row.value) : `${row.value}${unit}`}`
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
                      : new Intl.NumberFormat("zh", { notation: "compact" }).format(value),
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
            <summary className="cursor-pointer">查看数值</summary>
            <div className="mt-2 max-h-48 overflow-auto">
              {items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="flex w-full justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => onClick(i.id)}
                >
                  <span>{i.name}</span>
                  <span>
                    {i.missing ? "未提供" : format ? format(i.value) : `${i.value}${unit}`}
                  </span>
                </button>
              ))}
            </div>
          </details>
        </>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">暂无数据</p>
      )}
    </section>
  );
}

export function InterconnectDashboard({ mode }: { mode: "provider" | "operator" }) {
  const orgId = useActiveOrganizationId();
  const access = usePlatformCapability(
    mode === "provider" ? "workspace.provider.view" : "workspace.platform.view",
  );
  if (!access.ready) return <p>加载权限…</p>;
  if (access.error)
    return (
      <div role="alert">
        权限加载失败 <Button onClick={access.retry}>重试</Button>
      </div>
    );
  if (!access.allowed) return <p>无权访问此仪表盘</p>;
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
    if (query.data && !viewLoaded) {
      setView(query.data.defaultView ?? DEFAULT_MAP_VIEW);
      setViewLoaded(true);
    }
  }, [query.data, viewLoaded]);
  const saveView = useMutation({
    mutationFn: () => api.put(`${endpoint}/default-view`, view),
    onSuccess: () => {
      toast.success("默认地图视图已保存");
    },
    onError: (e) => toast.error(e.message),
  });
  if (query.isPending) return <p>加载算力资源…</p>;
  if (query.error || !query.data)
    return (
      <div role="alert" className="rounded-md border border-border p-4">
        {query.error?.message ?? "加载失败"}{" "}
        <Button variant="outline" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
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
      name,
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
        label: "算力中心",
        value: summary.centers,
        state: `${summary.operational} 正常 · ${summary.centers - summary.operational} 其他状态`,
        filter: { kind: "centers" },
      },
      {
        label: "CPU 核心",
        value: data.clusters.length > summary.missingCpu ? summary.cpuCores.toLocaleString() : "—",
        state: `${data.clusters.length - summary.missingCpu}/${data.clusters.length} 集群已登记`,
        filter: { kind: "clusters", metric: "cpu" },
      },
      {
        label: "算力类型",
        value: summary.computeTypes,
        state: `${data.clusters.filter((c) => c.metadata.computeTypes.length === 0).length} 集群未提供`,
        filter: { kind: "clusters" },
      },
      {
        label: "存储空间",
        value:
          data.clusters.length > summary.missingStorage
            ? formatCapacity(summary.storageBytes)
            : "—",
        state: `${data.clusters.length - summary.missingStorage}/${data.clusters.length} 集群已登记`,
        filter: { kind: "clusters", metric: "storage" },
      },
      {
        label: "存储类型",
        value: summary.storageTypes,
        state: `${data.clusters.filter((c) => c.metadata.storageTypes.length === 0).length} 集群未提供`,
        filter: { kind: "clusters" },
      },
      {
        label: "应用软件",
        value: summary.applications,
        state: `${data.clusters.filter((c) => c.software.some((s) => s.source === "inventory")).length} 集群有上报清单`,
        filter: { kind: "applications" },
      },
    ];
  return (
    <div className="space-y-5" data-testid="interconnect-dashboard">
      <PageHeader title="多算力中心互联仪表盘" />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="mr-auto text-muted-foreground">
          {mode === "operator" ? "平台范围" : "当前授权组织"} · 更新于 {time(data.generatedAt)}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新
        </Button>
        {data.canManage &&
          (
            [
              ["centers", "新增中心"],
              ["clusters", "新增集群"],
              ["links", "新增链路"],
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {metricCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => setFilter(card.filter)}
            className="min-w-0 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
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
          className="rounded-lg border border-border px-4 py-3 text-left text-sm hover:border-primary"
        >
          24 小时作业成功率{" "}
          <strong className="float-right">
            {terminals ? `${((summary.succeeded / terminals) * 100).toFixed(1)}%` : "暂无完成作业"}
          </strong>
          <p className="mt-1 text-xs text-muted-foreground">
            {summary.succeeded} 成功 / {summary.failed} 失败；已绑定集群
          </p>
        </button>
        <button
          type="button"
          onClick={() => setFilter({ kind: "clusters", metric: "agents" })}
          className="rounded-lg border border-border px-4 py-3 text-left text-sm hover:border-primary"
        >
          Agent 在线健康率{" "}
          <strong className="float-right">
            {boundAgents.length
              ? `${((healthyAgents / boundAgents.length) * 100).toFixed(1)}%`
              : "未绑定 Agent"}
          </strong>
          <p className="mt-1 text-xs text-muted-foreground">
            {healthyAgents} / {boundAgents.length}；5 分钟内心跳
          </p>
        </button>
        <button
          type="button"
          onClick={() => setFilter({ kind: "links" })}
          className="rounded-lg border border-border px-4 py-3 text-left text-sm hover:border-primary"
        >
          互联链路 <strong className="float-right">{data.links.length}</strong>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.links.filter((l) => isObservationStale(l.metadata.observedAt)).length}{" "}
            条观测过期或缺失
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
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">资源分布</h2>
        {(
          [
            ["center", "按算力中心"],
            ["cluster", "按集群"],
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
          title="中心状态"
          items={Object.entries(STATUS_LABELS).map(([id, name]) => ({
            id,
            name,
            value: data.centers.filter((c) => c.metadata.status === id).length,
          }))}
          onClick={(status) => setFilter({ kind: "centers", status })}
        />
        <Distribution
          title="CPU 核心分布"
          items={grouped.map((g) => ({
            id: g.id,
            name: g.name,
            value: g.clusters.reduce((n, c) => n + (c.metadata.cpuCores ?? 0), 0),
            missing: !g.clusters.some((c) => c.metadata.cpuCores !== null),
          }))}
          onClick={(id) => chooseGroup(id, { metric: "cpu" })}
        />
        <Distribution
          title="存储容量分布"
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
          title="算力类型 · 集群数"
          items={typeRows("computeTypes")}
          onClick={(computeType) => setFilter({ kind: "clusters", computeType })}
        />
        <Distribution
          title="存储类型 · 集群数"
          items={typeRows("storageTypes")}
          onClick={(storageType) => setFilter({ kind: "clusters", storageType })}
        />
        <Distribution
          title="应用软件分布"
          items={grouped.map((g) => ({
            id: g.id,
            name: g.name,
            value: new Set(g.clusters.flatMap((c) => c.software.map((s) => s.name))).size,
          }))}
          onClick={(id) => chooseGroup(id, { kind: "applications" })}
        />
      </div>
      <section className="rounded-xl border border-border bg-card" aria-label="资源明细">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <h2 className="mr-auto font-semibold">资源明细</h2>
          {(
            [
              ["centers", "算力中心"],
              ["clusters", "集群"],
              ["applications", "应用软件"],
              ["links", "链路"],
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
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4 text-sm">
          <span>筛选：</span>
          <select
            aria-label="筛选算力中心"
            className="max-w-full rounded border border-border bg-background p-1.5"
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
            <option value="">全部算力中心</option>
            {data.centers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.metadata.name}
              </option>
            ))}
          </select>
          {[
            filter.clusterId ? clusterName(filter.clusterId) : null,
            filter.centerIds ? `${filter.centerIds.length} 个地图节点` : null,
            filter.computeType,
            filter.storageType,
            filter.application,
            filter.status ? STATUS_LABELS[filter.status as keyof typeof STATUS_LABELS] : null,
            filter.metric
              ? {
                  cpu: "CPU 核心",
                  storage: "存储容量",
                  jobs: "24 小时作业成功率",
                  agents: "Agent 在线健康率",
                }[filter.metric]
              : null,
          ]
            .filter(Boolean)
            .map((label) => (
              <span key={label} className="rounded bg-muted px-2 py-1">
                {label}
              </span>
            ))}
          <Button size="sm" variant="ghost" onClick={() => setFilter({ kind: filter.kind })}>
            清除筛选
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
              {data.clusters.filter((c) => c.centerId === selectedCenter.id).length} 个集群
            </span>
            {data.canManage && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditor({ kind: "centers", id: selectedCenter.id })}
              >
                编辑中心
              </Button>
            )}
          </div>
        )}
        {filter.kind === "centers" && (
          <Table
            headers={["算力中心", "位置", "状态", "集群", "CPU 核心", "存储", "操作"]}
            empty={!centers.length}
          >
            {centers.map((c) => {
              const children = data.clusters.filter((x) => x.centerId === c.id);
              return (
                <tr key={c.id}>
                  <td>
                    <button
                      className="text-primary underline-offset-4 hover:underline"
                      type="button"
                      onClick={() => setFilter({ kind: "clusters", centerId: c.id })}
                    >
                      {c.metadata.name}
                    </button>
                  </td>
                  <td>
                    {[c.metadata.country, c.metadata.province, c.metadata.city]
                      .filter(Boolean)
                      .join(" / ")}
                  </td>
                  <td>{status(c.metadata.status)}</td>
                  <td>{children.length}</td>
                  <td>
                    {children.some((r) => r.metadata.cpuCores !== null)
                      ? children
                          .reduce((n, r) => n + (r.metadata.cpuCores ?? 0), 0)
                          .toLocaleString()
                      : "未提供"}
                  </td>
                  <td>
                    {formatCapacity(
                      children.some((r) => r.metadata.storageBytes !== null)
                        ? children.reduce((n, r) => n + (r.metadata.storageBytes ?? 0), 0)
                        : null,
                    )}
                  </td>
                  <td>
                    {data.canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditor({ kind: "centers", id: c.id })}
                      >
                        编辑
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        {filter.kind === "clusters" && (
          <Table
            headers={[
              "集群",
              "算力中心",
              "状态",
              "CPU 核心",
              "算力类型",
              "存储容量",
              "存储类型",
              "软件",
              ...(filter.metric === "jobs"
                ? ["24h 成功 / 失败"]
                : filter.metric === "agents"
                  ? ["在线健康 / Agent"]
                  : []),
              "更新时间",
            ]}
            empty={!clusters.length}
          >
            {clusters.map((c) => (
              <tr key={c.id}>
                <td>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setSelection({ kind: "cluster", id: c.id })}
                  >
                    {c.metadata.name}
                  </button>
                </td>
                <td>{centerName(c.centerId)}</td>
                <td>{status(c.metadata.status)}</td>
                <td>{c.metadata.cpuCores?.toLocaleString() ?? "未提供"}</td>
                <td>{c.metadata.computeTypes.join("、") || "未提供"}</td>
                <td>{formatCapacity(c.metadata.storageBytes)}</td>
                <td>{c.metadata.storageTypes.join("、") || "未提供"}</td>
                <td>
                  <button
                    type="button"
                    className="text-primary"
                    onClick={() => setFilter({ ...filter, kind: "applications", clusterId: c.id })}
                  >
                    {c.software.length}
                  </button>
                </td>
                {filter.metric === "jobs" && (
                  <td>
                    {c.jobs24h.succeeded} / {c.jobs24h.failed}
                  </td>
                )}
                {filter.metric === "agents" && (
                  <td>
                    {
                      c.agents.filter(
                        (a) => a.status === "online" && !isObservationStale(a.observedAt),
                      ).length
                    }{" "}
                    / {c.agents.length}
                  </td>
                )}
                <td className="whitespace-nowrap text-xs">{time(c.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
        {filter.kind === "applications" && (
          <>
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {new Set(applications.map((r) => r.software.name)).size} 种软件 ·{" "}
              {applications.length} 条集群关联
            </p>
            <Table
              headers={["应用软件", "算力中心", "集群", "来源", "状态／上报时间"]}
              empty={!applications.length}
            >
              {applications.map(({ cluster: c, software: s }) => (
                <tr key={`${c.id}:${s.name}`}>
                  <td>
                    <button
                      type="button"
                      className="text-primary"
                      onClick={() => setFilter({ ...filter, application: s.name })}
                    >
                      {s.name}
                    </button>
                  </td>
                  <td>{centerName(c.centerId)}</td>
                  <td>
                    <button
                      type="button"
                      className="text-primary"
                      onClick={() => setSelection({ kind: "cluster", id: c.id })}
                    >
                      {c.metadata.name}
                    </button>
                  </td>
                  <td>{s.source === "inventory" ? "Agent 上报" : "人工登记"}</td>
                  <td>
                    {s.source === "declared"
                      ? "安装状态未验证"
                      : `${isObservationStale(s.observedAt) ? "上报已过期 · " : "已安装 · "}${time(s.observedAt)}`}
                  </td>
                </tr>
              ))}
            </Table>
          </>
        )}
        {filter.kind === "links" && (
          <Table headers={["链路", "起点", "终点", "状态", "观测时间"]} empty={!links.length}>
            {links.map((l) => (
              <tr key={l.id}>
                <td>
                  <button
                    type="button"
                    className="text-primary"
                    onClick={() => setSelection({ kind: "link", id: l.id })}
                  >
                    {l.metadata.name}
                  </button>
                </td>
                <td>{centerName(l.fromCenterId)}</td>
                <td>{centerName(l.toCenterId)}</td>
                <td>
                  {status(
                    isObservationStale(l.metadata.observedAt) ? "unknown" : l.metadata.status,
                  )}
                  {isObservationStale(l.metadata.observedAt) && (
                    <span className="ml-2 text-xs text-muted-foreground">观测过期或缺失</span>
                  )}
                </td>
                <td>{time(l.metadata.observedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">统计口径</summary>
        <p className="mt-2 leading-6">
          仅统计当前权限内已登记的中心与集群，未绑定 Agent
          不计入集群监控。容量按集群登记值求和，每个集群只计一次；共享存储应只登记一次，不在多个集群重复填报。空值表示未提供，部分已知的总量为已知值小计。类型分布按含该类型的集群计数，多类型分类不可相加。软件以名称区分，版本和多
          Agent 安装去重；登记软件不代表已安装。作业成功率为绑定 Agent 最近 24 小时完成数
          /（完成数＋失败数），取消和运行中作业不计入。中心及集群运行状态来自档案登记，Agent
          状态来自心跳；链路状态来自注明来源的观测值，超过 5 分钟显示未知。
        </p>
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
                    <dt>CPU 核心</dt>
                    <dd>{selectedCluster.metadata.cpuCores ?? "未提供"}</dd>
                    <dt>算力类型</dt>
                    <dd>{selectedCluster.metadata.computeTypes.join("、") || "未提供"}</dd>
                    <dt>存储容量</dt>
                    <dd>{formatCapacity(selectedCluster.metadata.storageBytes)}</dd>
                    <dt>存储类型</dt>
                    <dd>{selectedCluster.metadata.storageTypes.join("、") || "未提供"}</dd>
                    <dt>档案更新时间</dt>
                    <dd>{time(selectedCluster.updatedAt)}</dd>
                  </dl>
                  <h3 className="font-semibold">Agent</h3>
                  {selectedCluster.agents.length ? (
                    selectedCluster.agents.map((a) => (
                      <div key={a.id} className="break-words rounded border border-border p-2">
                        {a.id} · {isObservationStale(a.observedAt) ? "心跳过期或缺失" : a.status}
                        <p className="text-xs text-muted-foreground">{time(a.observedAt)}</p>
                      </div>
                    ))
                  ) : (
                    <p>未绑定 Agent</p>
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
                    查看软件（{selectedCluster.software.length}）
                  </Button>
                </>
              )}
              {selectedLink && (
                <>
                  <p>
                    <button
                      type="button"
                      className="text-primary"
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
                      className="text-primary"
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
                      ` · 观测过期或缺失，上次记录：${STATUS_LABELS[selectedLink.metadata.status]}`}
                  </p>
                  <dl className="grid grid-cols-2 gap-3">
                    {(
                      [
                        ["bandwidthMbps", "带宽", "Mbps"],
                        ["throughputMbps", "吞吐量", "Mbps"],
                        ["latencyMs", "时延", "ms"],
                        ["packetLossPercent", "丢包率", "%"],
                      ] as const
                    ).map(([key, label, unit]) => (
                      <div key={key} className="contents">
                        <dt>{label}</dt>
                        <dd>
                          {selectedLink.metadata[key] === null
                            ? "未采集"
                            : `${selectedLink.metadata[key]} ${unit}`}
                        </dd>
                      </div>
                    ))}
                    <dt>观测时间</dt>
                    <dd>{time(selectedLink.metadata.observedAt)}</dd>
                    <dt>来源</dt>
                    <dd>{selectedLink.metadata.source || "未提供"}</dd>
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
                  编辑档案
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {editor && (
        <MetadataEditor
          target={editor}
          snapshot={data}
          onClose={() => setEditor(null)}
          onSave={async (body) => {
            if (editor.id) await api.put(`${endpoint}/${editor.kind}/${editor.id}`, body);
            else await api.post(`${endpoint}/${editor.kind}`, body);
            await queryClient.invalidateQueries({ queryKey: ["interconnect"] });
            toast.success("档案已保存");
          }}
          onDelete={async () => {
            await api.delete(`${endpoint}/${editor.kind}/${editor.id}`);
            await queryClient.invalidateQueries({ queryKey: ["interconnect"] });
            toast.success("档案已删除");
          }}
        />
      )}
    </div>
  );
}
