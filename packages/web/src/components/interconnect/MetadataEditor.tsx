import {
  CenterInputSchema,
  ClusterInputSchema,
  type InterconnectSnapshot,
  LinkInputSchema,
  type ResourceStatus,
} from "@kuintessence/shared/browser";
import { cloneElement, type ReactElement, useId, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { STATUS_LABELS } from "./model";

export type EditTarget = { kind: "centers" | "clusters" | "links"; id?: string };
const selectClass = "w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm";
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid min-w-0 gap-1.5 text-sm">
      <span>{label}</span>
      {cloneElement(children, { id })}
    </label>
  );
}
export function MetadataEditor({
  target,
  snapshot,
  onClose,
  onSave,
  onDelete,
}: {
  target: EditTarget;
  snapshot: InterconnectSnapshot;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const center = snapshot.centers.find((c) => c.id === target.id);
  const cluster = snapshot.clusters.find((c) => c.id === target.id);
  const link = snapshot.links.find((c) => c.id === target.id);
  const [centerId, setCenterId] = useState(cluster?.centerId ?? snapshot.centers[0]?.id ?? "");
  const selectedCenter = snapshot.centers.find((c) => c.id === centerId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const metadata = center?.metadata ?? cluster?.metadata ?? link?.metadata;
  const kindName = { centers: "算力中心", clusters: "集群", links: "互联链路" }[target.kind];
  const defaults = link?.metadata;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined} dirty outsideDismissPolicy="never">
        <DialogHeader>
          <DialogTitle>
            {target.id ? "编辑" : "新增"}
            {kindName}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 overflow-y-auto p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            const form = new FormData(event.currentTarget);
            const text = (name: string) => String(form.get(name) ?? "").trim();
            const number = (name: string) => (text(name) === "" ? null : Number(text(name)));
            const list = (name: string) => [
              ...new Set(
                text(name)
                  .split(/[,，\n]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ];
            const common = { name: text("name"), status: text("status") as ResourceStatus };
            const body =
              target.kind === "centers"
                ? CenterInputSchema.safeParse({
                    orgId: text("orgId"),
                    metadata: {
                      ...common,
                      country: text("country"),
                      province: text("province"),
                      city: text("city"),
                      longitude: number("longitude"),
                      latitude: number("latitude"),
                    },
                  })
                : target.kind === "clusters"
                  ? ClusterInputSchema.safeParse({
                      centerId,
                      agentIds: form.getAll("agentIds"),
                      metadata: {
                        ...common,
                        cpuCores: number("cpuCores"),
                        storageBytes:
                          number("storageGiB") === null
                            ? null
                            : Math.round((number("storageGiB") ?? 0) * 1024 ** 3),
                        computeTypes: form.getAll("computeTypes"),
                        storageTypes: list("storageTypes"),
                        applications: list("applications"),
                      },
                    })
                  : LinkInputSchema.safeParse({
                      fromCenterId: text("fromCenterId"),
                      toCenterId: text("toCenterId"),
                      metadata: {
                        ...common,
                        bandwidthMbps: number("bandwidthMbps"),
                        throughputMbps: number("throughputMbps"),
                        latencyMs: number("latencyMs"),
                        packetLossPercent: number("packetLossPercent"),
                        observedAt: text("observedAt")
                          ? new Date(text("observedAt")).toISOString()
                          : null,
                        source: text("source"),
                      },
                    });
            if (!body.success) {
              setError(
                body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
              );
              return;
            }
            setBusy(true);
            try {
              await onSave(body.data);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "保存失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="名称">
            <Input name="name" required maxLength={120} defaultValue={metadata?.name ?? ""} />
          </Field>
          <Field label="运行状态">
            <select
              name="status"
              className={selectClass}
              defaultValue={metadata?.status ?? "unknown"}
            >
              {Object.entries(STATUS_LABELS).map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {target.kind === "centers" && (
            <>
              <Field label="所属组织">
                <select
                  name="orgId"
                  className={selectClass}
                  defaultValue={center?.orgId ?? snapshot.organizations[0]?.id}
                  required
                >
                  {snapshot.organizations
                    .filter((o) => !center || o.id === center.orgId)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="国家">
                  <Input
                    name="country"
                    required
                    defaultValue={center?.metadata.country ?? "中国"}
                  />
                </Field>
                <Field label="省／州">
                  <Input
                    name="province"
                    defaultValue={center?.metadata.province ?? ""}
                    placeholder="例如：北京"
                  />
                </Field>
                <Field label="城市">
                  <Input name="city" defaultValue={center?.metadata.city ?? ""} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="经度">
                  <Input
                    name="longitude"
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    defaultValue={center?.metadata.longitude ?? ""}
                  />
                </Field>
                <Field label="纬度">
                  <Input
                    name="latitude"
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    defaultValue={center?.metadata.latitude ?? ""}
                  />
                </Field>
              </div>
            </>
          )}
          {target.kind === "clusters" && (
            <>
              <Field label="所属算力中心">
                <select
                  className={selectClass}
                  value={centerId}
                  onChange={(e) => setCenterId(e.target.value)}
                  required
                >
                  {snapshot.centers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.metadata.name}
                    </option>
                  ))}
                </select>
              </Field>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm">算力类型</legend>
                <div className="flex flex-wrap gap-4">
                  {["CPU", "国产 CPU", "GPU", "其他"].map((type) => (
                    <label key={type} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="computeTypes"
                        value={type}
                        defaultChecked={cluster?.metadata.computeTypes.some((t) => t === type)}
                      />
                      {type}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="CPU 核心总数">
                  <Input
                    name="cpuCores"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={cluster?.metadata.cpuCores ?? ""}
                    placeholder="未知请留空"
                  />
                </Field>
                <Field label="存储容量（GiB）">
                  <Input
                    name="storageGiB"
                    type="number"
                    min={0}
                    step="any"
                    defaultValue={
                      cluster?.metadata.storageBytes === null || !cluster
                        ? ""
                        : cluster.metadata.storageBytes / 1024 ** 3
                    }
                    placeholder="未知请留空"
                  />
                </Field>
              </div>
              <Field label="存储类型（逗号分隔）">
                <Input
                  name="storageTypes"
                  defaultValue={cluster?.metadata.storageTypes.join(", ") ?? ""}
                  placeholder="NFS, Ceph, Lustre"
                />
              </Field>
              <Field label="登记软件（逗号分隔）">
                <Input
                  name="applications"
                  defaultValue={cluster?.metadata.applications.join(", ") ?? ""}
                  placeholder="软件名称；已绑定 Agent 上报的软件自动汇入"
                />
              </Field>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm">关联 Agent</legend>
                <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border border-border p-3">
                  {snapshot.agents
                    .filter(
                      (a) =>
                        a.orgId === selectedCenter?.orgId &&
                        (!a.clusterId || a.clusterId === target.id),
                    )
                    .map((a) => (
                      <label key={a.id} className="flex items-center gap-2 text-sm">
                        <input
                          name="agentIds"
                          value={a.id}
                          type="checkbox"
                          defaultChecked={cluster?.agentIds.includes(a.id)}
                        />
                        {a.name} <span className="text-muted-foreground">{a.id}</span>
                      </label>
                    ))}
                  {!snapshot.agents.some(
                    (a) =>
                      a.orgId === selectedCenter?.orgId &&
                      (!a.clusterId || a.clusterId === target.id),
                  ) && <p className="text-sm text-muted-foreground">没有可绑定的 Agent</p>}
                </div>
              </fieldset>
            </>
          )}
          {target.kind === "links" && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {["fromCenterId", "toCenterId"].map((name, index) => (
                  <Field key={name} label={index === 0 ? "起点" : "终点"}>
                    <select
                      className={selectClass}
                      name={name}
                      required
                      defaultValue={index === 0 ? link?.fromCenterId : link?.toCenterId}
                    >
                      <option value="">选择算力中心</option>
                      {snapshot.centers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.metadata.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {(
                  [
                    ["bandwidthMbps", "带宽（Mbps）"],
                    ["throughputMbps", "吞吐量（Mbps）"],
                    ["latencyMs", "时延（ms）"],
                    ["packetLossPercent", "丢包率（%）"],
                  ] as const
                ).map(([name, label]) => (
                  <Field key={name} label={label}>
                    <Input
                      name={name}
                      type="number"
                      step="any"
                      min={0}
                      max={name === "packetLossPercent" ? 100 : undefined}
                      defaultValue={defaults?.[name] ?? ""}
                      placeholder="未采集请留空"
                    />
                  </Field>
                ))}
              </div>
              <Field label="观测时间（本地时区）">
                <Input
                  name="observedAt"
                  type="datetime-local"
                  defaultValue={
                    defaults?.observedAt
                      ? new Date(
                          Date.parse(defaults.observedAt) - new Date().getTimezoneOffset() * 60_000,
                        )
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                />
              </Field>
              <Field label="观测来源">
                <Input
                  name="source"
                  maxLength={240}
                  defaultValue={defaults?.source ?? ""}
                  placeholder="监控系统、测量记录等"
                />
              </Field>
            </>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            {target.id && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  setBusy(true);
                  setError("");
                  try {
                    await onDelete();
                    onClose();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "删除失败");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {confirmDelete ? "确认删除档案" : "删除"}
              </Button>
            )}
            <Button
              type="button"
              className="ml-auto"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
