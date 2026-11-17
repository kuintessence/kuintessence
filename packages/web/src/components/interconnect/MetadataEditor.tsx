import {
  CenterInputSchema,
  ClusterInputSchema,
  type InterconnectSnapshot,
  LinkInputSchema,
  type ResourceStatus,
} from "@kuintessence/shared/browser";
import { cloneElement, type ReactElement, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { ResourceSelectField } from "../ui/resource-select-field";
import { computeTypeLabel, getStatusLabels } from "./model";

export type EditTarget = { kind: "centers" | "clusters" | "links"; id?: string };
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
  const { t } = useTranslation();
  const statusLabels = getStatusLabels(t);
  const center = snapshot.centers.find((c) => c.id === target.id);
  const cluster = snapshot.clusters.find((c) => c.id === target.id);
  const link = snapshot.links.find((c) => c.id === target.id);
  const [centerId, setCenterId] = useState(cluster?.centerId ?? snapshot.centers[0]?.id ?? "");
  const selectedCenter = snapshot.centers.find((c) => c.id === centerId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const metadata = center?.metadata ?? cluster?.metadata ?? link?.metadata;
  const kindName = {
    centers: t("interconnect.centerRecord"),
    clusters: t("interconnect.clusterRecord"),
    links: t("interconnect.linkRecord"),
  }[target.kind];
  const defaults = link?.metadata;
  const [networkType, setNetworkType] = useState(defaults?.networkType ?? "standard");
  const [fromCenterId, setFromCenterId] = useState(link?.fromCenterId ?? "");
  const [toCenterId, setToCenterId] = useState(link?.toCenterId ?? "");
  const [fromClusterId, setFromClusterId] = useState(defaults?.fromClusterId ?? "");
  const [toClusterId, setToClusterId] = useState(defaults?.toClusterId ?? "");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        dismissible={!busy}
        dirty
        outsideDismissPolicy="never"
      >
        <DialogHeader>
          <DialogTitle>
            {t(target.id ? "interconnect.editTitle" : "interconnect.createTitle", {
              kind: kindName,
            })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col overflow-hidden"
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
                      fromCenterId,
                      toCenterId,
                      metadata: {
                        ...common,
                        networkType,
                        fromClusterId: fromClusterId || null,
                        toClusterId: toClusterId || null,
                        configuredBandwidthMbps: number("configuredBandwidthMbps"),
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
                t("interconnect.invalidFields", {
                  fields: [
                    ...new Set(
                      body.error.issues.map((issue) => {
                        const constraints: Record<string, string> = {
                          经纬度须同时填写或同时留空: t("interconnect.coordinatePair"),
                          链路状态和指标须提供观测时间及来源: t("interconnect.observationRequired"),
                          观测时间不能在未来: t("interconnect.futureObservation"),
                          链路两端必须不同: t("interconnect.differentEndpoints"),
                        };
                        if (issue.code === "custom" && constraints[issue.message])
                          return constraints[issue.message];
                        const fields: Record<string, string> = {
                          name: t("interconnect.name"),
                          status: t("interconnect.runningStatus"),
                          orgId: t("interconnect.organization"),
                          country: t("interconnect.country"),
                          province: t("interconnect.state"),
                          city: t("interconnect.city"),
                          longitude: t("interconnect.longitude"),
                          latitude: t("interconnect.latitude"),
                          centerId: t("interconnect.parentCenter"),
                          agentIds: t("interconnect.linkedAgents"),
                          cpuCores: t("interconnect.cpuTotal"),
                          storageBytes: t("interconnect.storageGiB"),
                          computeTypes: t("interconnect.computeTypes"),
                          storageTypes: t("interconnect.storageTypesField"),
                          applications: t("interconnect.applicationsField"),
                          fromCenterId: t("interconnect.from"),
                          toCenterId: t("interconnect.to"),
                          configuredBandwidthMbps: t("interconnect.configuredBandwidth"),
                          fromClusterId: t("interconnect.fromCluster"),
                          toClusterId: t("interconnect.toCluster"),
                          bandwidthMbps: t("interconnect.bandwidthMbps"),
                          throughputMbps: t("interconnect.throughputMbps"),
                          latencyMs: t("interconnect.latencyMs"),
                          packetLossPercent: t("interconnect.packetLossPercent"),
                          observedAt: t("interconnect.localObservationTime"),
                          source: t("interconnect.observationSource"),
                        };
                        return (
                          issue.path
                            .map(String)
                            .map((part) => fields[part])
                            .find(Boolean) ?? kindName
                        );
                      }),
                    ),
                  ].join(", "),
                }),
              );
              return;
            }
            setBusy(true);
            try {
              await onSave(body.data);
              onClose();
            } catch (e) {
              setError(toUserFacingError(e, t("interconnect.saveFailed")));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto p-5">
            <Field label={t("interconnect.name")}>
              <Input name="name" required maxLength={120} defaultValue={metadata?.name ?? ""} />
            </Field>
            <Field label={t("interconnect.runningStatus")}>
              <NativeSelect
                name="status"
                className="w-full"
                defaultValue={metadata?.status ?? "unknown"}
              >
                {Object.entries(statusLabels).map(([s, label]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {target.kind === "centers" && (
              <>
                <Field label={t("interconnect.organization")}>
                  <ResourceSelectField
                    resourceType="organizations"
                    name="orgId"
                    className="w-full"
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
                  </ResourceSelectField>
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label={t("interconnect.country")}>
                    <Input
                      name="country"
                      required
                      defaultValue={center?.metadata.country ?? "中国"}
                    />
                  </Field>
                  <Field label={t("interconnect.state")}>
                    <Input
                      name="province"
                      defaultValue={center?.metadata.province ?? ""}
                      placeholder={t("interconnect.provinceExample")}
                    />
                  </Field>
                  <Field label={t("interconnect.city")}>
                    <Input name="city" defaultValue={center?.metadata.city ?? ""} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field label={t("interconnect.longitude")}>
                    <Input
                      name="longitude"
                      type="number"
                      step="any"
                      min={-180}
                      max={180}
                      defaultValue={center?.metadata.longitude ?? ""}
                    />
                  </Field>
                  <Field label={t("interconnect.latitude")}>
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
                <Field label={t("interconnect.parentCenter")}>
                  <ResourceSelectField
                    resourceType="compute-centers"
                    className="w-full"
                    value={centerId}
                    onChange={(e) => setCenterId(e.target.value)}
                    required
                  >
                    {snapshot.centers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.metadata.name}
                      </option>
                    ))}
                  </ResourceSelectField>
                </Field>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm">{t("interconnect.computeTypes")}</legend>
                  <div className="flex flex-wrap gap-4">
                    {["CPU", "国产 CPU", "GPU", "其他"].map((type) => (
                      <label key={type} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="computeTypes"
                          value={computeTypeLabel(type, t)}
                          defaultChecked={cluster?.metadata.computeTypes.some((t) => t === type)}
                        />
                        {computeTypeLabel(type, t)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t("interconnect.cpuTotal")}>
                    <Input
                      name="cpuCores"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={cluster?.metadata.cpuCores ?? ""}
                      placeholder={t("interconnect.unknownBlank")}
                    />
                  </Field>
                  <Field label={t("interconnect.storageGiB")}>
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
                      placeholder={t("interconnect.unknownBlank")}
                    />
                  </Field>
                </div>
                <Field label={t("interconnect.storageTypesField")}>
                  <Input
                    name="storageTypes"
                    defaultValue={cluster?.metadata.storageTypes.join(", ") ?? ""}
                    placeholder="NFS, Ceph, Lustre"
                  />
                </Field>
                <Field label={t("interconnect.applicationsField")}>
                  <Input
                    name="applications"
                    defaultValue={cluster?.metadata.applications.join(", ") ?? ""}
                    placeholder={t("interconnect.applicationsHint")}
                  />
                </Field>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm">{t("interconnect.linkedAgents")}</legend>
                  <div className="max-h-40 space-y-2 overflow-y-auto border-border p-3">
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
                    ) && (
                      <p className="text-sm text-muted-foreground">
                        {t("interconnect.noAvailableAgents")}
                      </p>
                    )}
                  </div>
                </fieldset>
              </>
            )}
            {target.kind === "links" && (
              <>
                <p className="text-xs text-muted-foreground">{t("interconnect.networkHint")}</p>
                <Field label={t("interconnect.connectionType")}>
                  <NativeSelect
                    value={networkType}
                    onChange={(event) => setNetworkType(event.target.value as typeof networkType)}
                  >
                    <option value="standard">{t("interconnect.standard")}</option>
                    <option value="high-speed">{t("interconnect.highSpeed")}</option>
                    <option value="dedicated">{t("interconnect.dedicated")}</option>
                  </NativeSelect>
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {(["from", "to"] as const).map((side) => {
                    const zoneId = side === "from" ? fromCenterId : toCenterId;
                    return (
                      <div key={side} className="space-y-3">
                        <Field label={t(`interconnect.${side}`)}>
                          <ResourceSelectField
                            resourceType="compute-centers"
                            value={zoneId}
                            required
                            onChange={(event) => {
                              if (side === "from") {
                                setFromCenterId(event.target.value);
                                setFromClusterId("");
                              } else {
                                setToCenterId(event.target.value);
                                setToClusterId("");
                              }
                            }}
                          >
                            <option value="">{t("interconnect.chooseCenter")}</option>
                            {snapshot.centers.map((zone) => (
                              <option key={zone.id} value={zone.id}>
                                {snapshot.organizations.find((org) => org.id === zone.orgId)?.name}{" "}
                                / {zone.metadata.name}
                              </option>
                            ))}
                          </ResourceSelectField>
                        </Field>
                        <Field label={t(`interconnect.${side}Cluster`)}>
                          <ResourceSelectField
                            resourceType="clusters"
                            disabled={!zoneId}
                            value={side === "from" ? fromClusterId : toClusterId}
                            onChange={(event) =>
                              (side === "from" ? setFromClusterId : setToClusterId)(
                                event.target.value,
                              )
                            }
                          >
                            <option value="">{t("interconnect.allZoneClusters")}</option>
                            {snapshot.clusters
                              .filter((cluster) => cluster.centerId === zoneId)
                              .map((cluster) => (
                                <option key={cluster.id} value={cluster.id}>
                                  {cluster.metadata.name}
                                </option>
                              ))}
                          </ResourceSelectField>
                        </Field>
                      </div>
                    );
                  })}
                </div>
                <Field label={t("interconnect.configuredBandwidth")}>
                  <Input
                    name="configuredBandwidthMbps"
                    type="number"
                    min={0}
                    step="any"
                    defaultValue={defaults?.configuredBandwidthMbps ?? ""}
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["bandwidthMbps", t("interconnect.bandwidthMbps")],
                      ["throughputMbps", t("interconnect.throughputMbps")],
                      ["latencyMs", t("interconnect.latencyMs")],
                      ["packetLossPercent", t("interconnect.packetLossPercent")],
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
                        placeholder={t("interconnect.notMeasuredBlank")}
                      />
                    </Field>
                  ))}
                </div>
                <Field label={t("interconnect.localObservationTime")}>
                  <Input
                    name="observedAt"
                    type="datetime-local"
                    defaultValue={
                      defaults?.observedAt
                        ? new Date(
                            Date.parse(defaults.observedAt) -
                              new Date().getTimezoneOffset() * 60_000,
                          )
                            .toISOString()
                            .slice(0, 16)
                        : ""
                    }
                  />
                </Field>
                <Field label={t("interconnect.observationSource")}>
                  <Input
                    name="source"
                    maxLength={240}
                    defaultValue={defaults?.source ?? ""}
                    placeholder={t("interconnect.sourceHint")}
                  />
                </Field>
              </>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-status-failed">
                {error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 border-border px-5 py-4">
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
                    setError(
                      e && typeof e === "object" && "status" in e && e.status === 409
                        ? t("interconnect.connectionsRequired")
                        : toUserFacingError(e, t("interconnect.deleteFailed")),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {confirmDelete ? t("interconnect.deleteConfirm") : t("interconnect.delete")}
              </Button>
            )}
            <Button
              type="button"
              className="ml-auto"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t("interconnect.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("interconnect.saving") : t("interconnect.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
