import type {
  QueueInventoryAdminView,
  QueueInventoryFactView,
  QueueInventoryStatus,
  QueueRegistryCreate,
  QueueRegistryUpdate,
  QueueRegistryView,
  QueueTargetMode,
  SchedulerType,
} from "@kuintessence/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleAlert, Loader2, Pencil, Plus, Power, RefreshCw } from "lucide-react";
import { type FormEvent, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { queueTargetMode } from "../../lib/queue-selection";
import { useAgentRegistrationContext } from "../../lib/use-cp-agent-registration";
import { useCpAgents } from "../../lib/use-cp-agents";
import {
  useCpQueueInventory,
  useCpQueues,
  useCreateCpQueue,
  useUpdateCpQueue,
} from "../../lib/use-cp-queues";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

type Translate = ReturnType<typeof useTranslation>["t"];
type QueueView = "managed" | "inventory";

interface QueueFormState {
  queueId: string;
  name: string;
  providerOrgId: string;
  visibleOrgIds: string;
  agentId: string;
  schedulerType: SchedulerType;
  targetMode: QueueTargetMode;
  queueName: string;
  qos: string;
  enabled: boolean;
  policyTags: string;
}

interface InventoryManageIntent {
  agentId: string;
  inventory: QueueInventoryAdminView;
  fact: QueueInventoryFactView;
}

function newQueueForm(providerOrgId = ""): QueueFormState {
  return {
    queueId: "",
    name: "",
    providerOrgId,
    visibleOrgIds: "",
    agentId: "",
    schedulerType: "slurm",
    targetMode: "named",
    queueName: "",
    qos: "",
    enabled: true,
    policyTags: "",
  };
}

function editQueueForm(queue: QueueRegistryView): QueueFormState {
  return {
    queueId: queue.queueId,
    name: queue.name,
    providerOrgId: queue.providerOrgId,
    visibleOrgIds: queue.visibleOrgIds.join("\n"),
    agentId: queue.agentId,
    schedulerType: queue.schedulerType,
    targetMode: queueTargetMode(queue) ?? "named",
    queueName: queue.queueName ?? "",
    qos: queue.qos ?? "",
    enabled: queue.enabled,
    policyTags: queue.policyTags.join("\n"),
  };
}

function inventoryQueueForm(intent: InventoryManageIntent): QueueFormState {
  const mode: QueueTargetMode = intent.fact.isDefault ? "default" : "named";
  return {
    ...newQueueForm(intent.inventory.providerOrgId ?? ""),
    agentId: intent.agentId,
    schedulerType: intent.inventory.schedulerType,
    targetMode: mode,
    ...(mode === "named" ? { queueName: intent.fact.queueName } : {}),
    enabled: intent.inventory.status === "available",
  };
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function createPayload(form: QueueFormState, schedulerType: SchedulerType): QueueRegistryCreate {
  const providerOrgId = form.providerOrgId.trim();
  const qos = form.qos.trim();
  return {
    queueId: form.queueId.trim(),
    name: form.name.trim(),
    ...(providerOrgId ? { providerOrgId } : {}),
    visibleOrgIds: parseList(form.visibleOrgIds),
    agentId: form.agentId.trim(),
    schedulerType,
    target: { mode: form.targetMode },
    ...(form.targetMode === "named" ? { queueName: form.queueName.trim() } : {}),
    qos: qos ? qos : null,
    enabled: form.enabled,
    policyTags: parseList(form.policyTags),
  };
}

function updatePayload(form: QueueFormState, schedulerType: SchedulerType): QueueRegistryUpdate {
  const qos = form.qos.trim();
  return {
    name: form.name.trim(),
    visibleOrgIds: parseList(form.visibleOrgIds),
    agentId: form.agentId.trim(),
    schedulerType,
    target: { mode: form.targetMode },
    ...(form.targetMode === "named" ? { queueName: form.queueName.trim() } : {}),
    qos: qos ? qos : null,
    enabled: form.enabled,
    policyTags: parseList(form.policyTags),
  };
}

function queueReason(t: Translate, reason: string | null | undefined): string | null {
  if (!reason) return null;
  return t(`cp.queues.reason.${reason}`, { defaultValue: reason });
}

function inventoryStatusLabel(t: Translate, status: QueueInventoryStatus): string {
  return t(`cp.queues.inventoryStatus.${status}`, { defaultValue: status });
}

function inventoryStatusVariant(status: QueueInventoryStatus) {
  if (status === "available") return "running";
  if (status === "stale") return "outline";
  if (status === "unavailable") return "failed";
  return "cancelled";
}

function QueuePolicyTags({ queue }: { queue: QueueRegistryView }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {queue.policyTags.length === 0 ? (
        <span className="text-xs text-muted-foreground">{t("cp.queues.noPolicyTags")}</span>
      ) : (
        queue.policyTags.map((tag) => (
          <Badge key={tag} variant="outline">
            {tag}
          </Badge>
        ))
      )}
    </div>
  );
}

function TimeValue({ value, label }: { value: string | null; label: string }) {
  const { t } = useTranslation();
  if (!value) return <span className="text-muted-foreground">{t("cp.queues.timeUnknown")}</span>;
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {label}: {date.toLocaleString()}
    </time>
  );
}

function PublicationBadge({ enabled, t }: { enabled: boolean; t: Translate }) {
  return (
    <Badge variant={enabled ? "running" : "cancelled"} className="whitespace-nowrap">
      {enabled ? t("cp.queues.enabled") : t("cp.queues.disabled")}
    </Badge>
  );
}

function ObservationBadge({ queue, t }: { queue: QueueRegistryView; t: Translate }) {
  const availability = queue.availability;
  if (!availability) {
    return <Badge variant="cancelled">{t("cp.queues.inventoryStatus.unknown")}</Badge>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Badge variant={inventoryStatusVariant(availability.state)} className="whitespace-nowrap">
        {inventoryStatusLabel(t, availability.state)}
      </Badge>
      {queueReason(t, availability.reason) ? (
        <span className="break-words text-xs text-muted-foreground">
          {queueReason(t, availability.reason)}
        </span>
      ) : null}
    </div>
  );
}

function ManagedQueueMobileDetails({ queue }: { queue: QueueRegistryView }) {
  const { t } = useTranslation();
  const targetMode = queueTargetMode(queue);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
      <dt className="text-muted-foreground">{t("cp.queues.field.queueId")}</dt>
      <dd className="break-all font-mono">{queue.queueId}</dd>
      <dt className="text-muted-foreground">{t("cp.queues.field.providerOrgId")}</dt>
      <dd className="break-all font-mono">{queue.providerOrgId}</dd>
      <dt className="text-muted-foreground">{t("cp.queues.col.target")}</dt>
      <dd className="break-words">
        {targetMode === "default"
          ? t("cp.queues.targetDefault")
          : targetMode === "named"
            ? queue.queueName
            : t("cp.queues.targetUnknown")}
      </dd>
      <dt className="text-muted-foreground">{t("cp.queues.col.visibility")}</dt>
      <dd className="break-words">
        {queue.visibleOrgIds.length === 0
          ? t("cp.queues.allProviderUsers")
          : queue.visibleOrgIds.join(", ")}
      </dd>
      <dt className="text-muted-foreground">{t("cp.queues.col.policy")}</dt>
      <dd>
        <QueuePolicyTags queue={queue} />
      </dd>
    </dl>
  );
}

function ManagedQueueTable({
  queues,
  togglingQueueIds,
  expandedQueueId,
  onEdit,
  onToggle,
  onExpandedChange,
}: {
  queues: QueueRegistryView[];
  togglingQueueIds: Set<string>;
  expandedQueueId: string | null;
  onEdit: (queue: QueueRegistryView) => void;
  onToggle: (queue: QueueRegistryView) => void;
  onExpandedChange: (queueId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-md border border-border sm:overflow-x-auto sm:overscroll-x-contain"
      data-testid="cp-queues-table-scroll"
    >
      <table className="w-full text-sm sm:min-w-[76rem]">
        <caption className="sr-only">{t("cp.queues.managedTableCaption")}</caption>
        <thead className="sr-only bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground sm:not-sr-only sm:table-header-group">
          <tr>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.queue")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.target")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.agent")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.publication")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.observation")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.visibility")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.policy")}
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              {t("cp.queues.col.actions")}
            </th>
          </tr>
        </thead>
        <tbody className="block divide-y divide-border sm:table-row-group sm:divide-y-0">
          {queues.map((queue) => {
            const targetMode = queueTargetMode(queue);
            const expanded = expandedQueueId === queue.queueId;
            const enableBlockedByInventory =
              !queue.enabled &&
              targetMode === "named" &&
              queue.availability !== undefined &&
              queue.availability.state !== "available";
            return (
              <Fragment key={queue.queueId}>
                <tr
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-4 sm:table-row sm:border-t sm:border-border sm:p-0"
                  data-testid={`cp-queue-row-${queue.queueId}`}
                >
                  <td className="order-1 min-w-0 sm:table-cell sm:px-3 sm:py-2">
                    <div className="break-words font-medium">{queue.name}</div>
                    <div className="hidden font-mono text-xs text-muted-foreground sm:block">
                      {queue.queueId}
                    </div>
                  </td>
                  <td className="order-2 col-span-2 min-w-0 sm:table-cell sm:px-3 sm:py-2">
                    {targetMode === "default" ? (
                      <div className="space-y-1">
                        <span className="text-xs font-medium sm:text-sm">
                          {t("cp.queues.targetDefault")}
                        </span>
                        <div className="text-xs text-muted-foreground">
                          {queue.resolvedQueueName
                            ? t("cp.queues.currentResolution", {
                                queueName: queue.resolvedQueueName,
                                defaultValue: `Current resolution: ${queue.resolvedQueueName}`,
                              })
                            : t("cp.queues.unresolved")}
                        </div>
                      </div>
                    ) : targetMode === "named" ? (
                      <div className="space-y-1">
                        <span className="font-mono text-xs sm:text-sm">{queue.queueName}</span>
                        {queue.qos ? (
                          <div className="text-xs text-muted-foreground">QoS: {queue.qos}</div>
                        ) : null}
                      </div>
                    ) : (
                      <Badge variant="cancelled">{t("cp.queues.targetUnknown")}</Badge>
                    )}
                  </td>
                  <td className="order-3 col-span-2 min-w-0 sm:table-cell sm:px-3 sm:py-2">
                    <div className="font-mono text-xs">
                      <span className="mr-2 font-sans text-muted-foreground sm:hidden">
                        {t("cp.queues.col.agent")}
                      </span>
                      <span className="break-all sm:break-normal">{queue.agentId}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{queue.schedulerType}</div>
                  </td>
                  <td className="order-1 sm:table-cell sm:px-3 sm:py-2">
                    <PublicationBadge enabled={queue.enabled} t={t} />
                  </td>
                  <td className="order-4 col-span-2 sm:table-cell sm:px-3 sm:py-2">
                    <ObservationBadge queue={queue} t={t} />
                  </td>
                  <td className="hidden px-3 py-2 text-xs sm:table-cell">
                    {queue.visibleOrgIds.length === 0
                      ? t("cp.queues.allProviderUsers")
                      : queue.visibleOrgIds.join(", ")}
                  </td>
                  <td className="hidden px-3 py-2 sm:table-cell">
                    <QueuePolicyTags queue={queue} />
                  </td>
                  <td className="order-5 col-span-2 sm:table-cell sm:px-3 sm:py-2">
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-8"
                        onClick={() => onEdit(queue)}
                        data-testid={`cp-queue-edit-${queue.queueId}`}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("cp.queues.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-8"
                        disabled={togglingQueueIds.has(queue.queueId) || enableBlockedByInventory}
                        aria-busy={togglingQueueIds.has(queue.queueId)}
                        onClick={() => onToggle(queue)}
                        data-testid={`cp-queue-toggle-${queue.queueId}`}
                        title={
                          enableBlockedByInventory
                            ? t("cp.queues.cannotEnableUntilFresh", {
                                defaultValue:
                                  "A named target needs a fresh scheduler observation before it can be enabled.",
                              })
                            : undefined
                        }
                      >
                        {togglingQueueIds.has(queue.queueId) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Power className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {queue.enabled ? t("cp.queues.disable") : t("cp.queues.enable")}
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-2 min-h-11 w-full justify-between sm:hidden"
                      aria-expanded={expanded}
                      aria-controls={expanded ? `cp-queue-detail-${queue.queueId}` : undefined}
                      onClick={() => onExpandedChange(expanded ? null : queue.queueId)}
                      data-testid={`cp-queue-details-${queue.queueId}`}
                    >
                      {t("cp.queues.details")}
                      <ChevronDown
                        className={expanded ? "rotate-180" : undefined}
                        aria-hidden="true"
                      />
                    </Button>
                  </td>
                </tr>
                {expanded ? (
                  <tr
                    id={`cp-queue-detail-${queue.queueId}`}
                    className="block bg-muted/20 sm:hidden"
                  >
                    <td className="block space-y-3 px-4 py-3" colSpan={8}>
                      <ManagedQueueMobileDetails queue={queue} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QueueInventoryAgentSection({
  agent,
  onlyAttention,
  onManage,
}: {
  agent: { id: string; hostname: string };
  onlyAttention: boolean;
  onManage: (intent: InventoryManageIntent) => void;
}) {
  const { t } = useTranslation();
  const inventoryQuery = useCpQueueInventory(agent.id);
  const inventory = inventoryQuery.data;

  useEffect(() => {
    if (!inventory?.freshUntil || inventory.status !== "available") return;
    const refreshAt = new Date(inventory.freshUntil).getTime();
    const refetchWhenVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= refreshAt) {
        void inventoryQuery.refetch();
      }
    };
    const delay = Math.max(0, refreshAt - Date.now());
    const timer = window.setTimeout(refetchWhenVisible, delay);
    document.addEventListener("visibilitychange", refetchWhenVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refetchWhenVisible);
    };
  }, [inventory?.freshUntil, inventory?.status, inventoryQuery.refetch]);

  if (inventoryQuery.isLoading) {
    return (
      <div className="flex min-h-24 items-center gap-2 border-b border-border px-3 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {agent.hostname}
      </div>
    );
  }
  if (inventoryQuery.error) {
    return (
      <section
        className="border-b border-border px-3 py-4"
        data-testid={`cp-queue-inventory-error-${agent.id}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">{agent.hostname}</div>
            <p className="mt-1 text-sm text-status-failed">
              {t("cp.queues.inventoryLoadFailed", { defaultValue: "Queue inventory unavailable" })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            onClick={() => void inventoryQuery.refetch()}
            aria-label={t("cp.queues.reloadInventoryForAgent", {
              hostname: agent.hostname,
              agentId: agent.id,
              defaultValue: `Reload ${agent.hostname} (${agent.id}) Server queue snapshot`,
            })}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
      </section>
    );
  }
  if (!inventory) return null;
  const attention =
    inventory.status !== "available" || inventory.queues.some((fact) => !fact.managed);
  if (onlyAttention && !attention) return null;
  const statusReason = queueReason(t, inventory.reason);
  const canManageFacts = inventory.status === "available";

  return (
    <section
      className="border-b border-border last:border-b-0"
      data-testid={`cp-queue-inventory-agent-${agent.id}`}
    >
      <header className="flex flex-col gap-3 border-b border-border bg-muted/20 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words font-medium">{agent.hostname}</h3>
            <Badge variant="outline" className="font-mono">
              {agent.id}
            </Badge>
            <Badge variant="outline">{inventory.schedulerType}</Badge>
            <Badge variant={inventoryStatusVariant(inventory.status)}>
              {inventoryStatusLabel(t, inventory.status)}
            </Badge>
          </div>
          {statusReason ? <p className="text-sm text-muted-foreground">{statusReason}</p> : null}
          {inventory.defaultQueueName ? (
            <p className="text-sm text-muted-foreground">
              {t("cp.queues.schedulerDefault")}:{" "}
              <span className="font-mono">{inventory.defaultQueueName}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <TimeValue
              value={inventory.lastAttemptAt}
              label={t("cp.queues.lastAttempt", { defaultValue: "Last collection attempt" })}
            />
            {inventory.lastSuccessfulObservedAt !== inventory.lastAttemptAt ? (
              <TimeValue
                value={inventory.lastSuccessfulObservedAt}
                label={t("cp.queues.lastSuccessfulObserved", {
                  defaultValue: "Last successful observation",
                })}
              />
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          onClick={() => void inventoryQuery.refetch()}
          aria-label={t("cp.queues.reloadInventoryForAgent", {
            hostname: agent.hostname,
            agentId: agent.id,
            defaultValue: `Reload ${agent.hostname} (${agent.id}) Server queue snapshot`,
          })}
          title={t("cp.queues.reloadSnapshotHint", {
            defaultValue: "Reload Server queue snapshot",
          })}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </header>
      {inventory.queues.length === 0 ? (
        <div
          className="px-3 py-4 text-sm text-muted-foreground"
          data-testid={`cp-queue-inventory-empty-${agent.id}`}
        >
          {inventory.status === "unavailable" || inventory.status === "stale"
            ? t("cp.queues.noLastKnownFacts", {
                defaultValue: "No queue observations to show yet.",
              })
            : t("cp.queues.inventoryEmpty", {
                defaultValue: "Waiting for first queue observation.",
              })}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <caption className="sr-only">
              {t("cp.queues.inventoryTableCaption", { hostname: agent.hostname })}
            </caption>
            <thead className="bg-muted/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium" scope="col">
                  {t("cp.queues.inventoryCol.queue")}
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  {t("cp.queues.inventoryCol.discovery")}
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  {t("cp.queues.inventoryCol.runtime")}
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  {t("cp.queues.inventoryCol.governance")}
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  {t("cp.queues.inventoryCol.observedAt")}
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  {t("cp.queues.col.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {inventory.queues.map((fact) => (
                <tr key={fact.queueName} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono">{fact.queueName}</span>
                      <Badge variant="outline">{fact.queueType}</Badge>
                      {fact.isDefault ? (
                        <Badge variant="brand">{t("cp.queues.schedulerDefault")}</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="running">{t("cp.queues.discovered")}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={
                          fact.state === "up" && fact.acceptsSubmissions ? "running" : "failed"
                        }
                      >
                        {fact.acceptsSubmissions && fact.state === "up"
                          ? t("cp.queues.accepting")
                          : t("cp.queues.notAccepting")}
                      </Badge>
                      {fact.hasComputeTargets === false ? (
                        <Badge variant="outline">{t("cp.queues.noComputeTargets")}</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {fact.managed ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="running">{t("cp.queues.managed")}</Badge>
                        {fact.managedQueueIds.map((queueId) => (
                          <span key={queueId} className="font-mono text-xs text-muted-foreground">
                            {queueId}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <Badge variant="outline">{t("cp.queues.unmanaged")}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    <TimeValue
                      value={fact.observedAt}
                      label={
                        inventory.status === "available"
                          ? t("cp.queues.observedAt", { defaultValue: "Observed" })
                          : t("cp.queues.lastSuccessfulObserved", {
                              defaultValue: "Last successful observation",
                            })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    {!fact.managed &&
                    (canManageFacts || (inventory.status === "stale" && !fact.isDefault)) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-8"
                        onClick={() => onManage({ agentId: agent.id, inventory, fact })}
                        data-testid={`cp-queue-manage-${agent.id}-${fact.queueName}`}
                      >
                        <Plus aria-hidden="true" />
                        {t("cp.queues.manageFact", { defaultValue: "Manage" })}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inventory.managedTargets.some((target) => !target.available) ? (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {inventory.managedTargets
            .filter((target) => !target.available)
            .map((target) => (
              <div key={target.queueId}>
                <span className="font-mono">{target.queueId}</span>: {t("cp.queues.notDiscovered")}
                {queueReason(t, target.reason) ? ` · ${queueReason(t, target.reason)}` : ""}
              </div>
            ))}
        </div>
      ) : null}
    </section>
  );
}

export function CpQueuesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useCpQueues();
  const createQueue = useCreateCpQueue();
  const updateQueue = useUpdateCpQueue();
  const agentsQuery = useCpAgents();
  const registrationContext = useAgentRegistrationContext();
  const loadError = query.error as Error | null;
  const queues = useMemo(() => (loadError ? [] : (query.data ?? [])), [loadError, query.data]);
  const [view, setView] = useState<QueueView>("managed");
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit" | null>(null);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [expandedQueueId, setExpandedQueueId] = useState<string | null>(null);
  const [togglingQueueIds, setTogglingQueueIds] = useState<Set<string>>(() => new Set());
  const [form, setForm] = useState<QueueFormState>(() => newQueueForm());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const providerOrgs = registrationContext.data?.providerOrgs ?? [];
  const agents = agentsQuery.data ?? [];
  const selectedInventoryQuery = useCpQueueInventory(form.agentId || null, dialogMode !== null);
  const selectedInventory = selectedInventoryQuery.data;
  const schedulerType = selectedInventory?.schedulerType ?? form.schedulerType;
  const staleNamedPrebuild =
    dialogMode === "create" && form.targetMode === "named" && selectedInventory?.status === "stale";
  const namedTargetNeedsFreshInventory =
    form.targetMode === "named" &&
    selectedInventory !== undefined &&
    selectedInventory.status !== "available";
  const pending = createQueue.isPending || updateQueue.isPending;

  const filteredQueues = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return queues.filter((queue) => {
      if (agentFilter && queue.agentId !== agentFilter) return false;
      if (onlyAttention && queue.availability?.state === "available") return false;
      if (!needle) return true;
      return [queue.name, queue.queueId, queue.agentId, queue.queueName ?? "", queue.schedulerType]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [agentFilter, onlyAttention, queues, search]);

  const filteredAgents = useMemo(
    () => agents.filter((agent) => !agentFilter || agent.id === agentFilter),
    [agentFilter, agents],
  );

  useEffect(() => {
    if (!loadError) return;
    setDialogMode(null);
    setEditingQueueId(null);
    setExpandedQueueId(null);
    setTogglingQueueIds(new Set());
  }, [loadError]);

  useEffect(() => {
    if (!selectedInventory || selectedInventory.agentId !== form.agentId) return;
    setForm((current) => {
      const shouldDisableStaleNamedTarget =
        dialogMode === "create" &&
        current.targetMode === "named" &&
        selectedInventory.status === "stale";
      if (
        current.schedulerType === selectedInventory.schedulerType &&
        (!shouldDisableStaleNamedTarget || !current.enabled)
      ) {
        return current;
      }
      return {
        ...current,
        schedulerType: selectedInventory.schedulerType,
        ...(shouldDisableStaleNamedTarget ? { enabled: false } : {}),
      };
    });
  }, [dialogMode, form.agentId, selectedInventory]);

  function closeDialog() {
    setDialogMode(null);
    setEditingQueueId(null);
    setFormErrors({});
  }

  function openCreate() {
    if (loadError) return;
    setEditingQueueId(null);
    setForm(newQueueForm(providerOrgs[0]?.id ?? ""));
    setFormErrors({});
    setDialogMode("create");
  }

  function openEdit(queue: QueueRegistryView) {
    if (loadError) return;
    setEditingQueueId(queue.queueId);
    setForm(editQueueForm(queue));
    setFormErrors({});
    setDialogMode("edit");
  }

  function openManageFact(intent: InventoryManageIntent) {
    if (loadError) return;
    setEditingQueueId(null);
    setForm(inventoryQueueForm(intent));
    setFormErrors({});
    setDialogMode("create");
  }

  function changeAgent(agentId: string) {
    setForm((current) => ({ ...current, agentId, queueName: "", targetMode: "named" }));
    setFormErrors((current) => ({ ...current, agentId: "", queueName: "" }));
  }

  function changeTargetMode(targetMode: QueueTargetMode) {
    const fresh = selectedInventory?.status === "available";
    setForm((current) => ({
      ...current,
      targetMode,
      queueName: targetMode === "default" ? "" : current.queueName,
      ...(dialogMode === "create" && !fresh ? { enabled: false } : {}),
    }));
    setFormErrors((current) => ({ ...current, queueName: "" }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadError) return;
    const nextErrors: Record<string, string> = {};
    const discovered = selectedInventory?.queues.map((fact) => fact.queueName) ?? [];
    if (!form.agentId) nextErrors.agentId = t("cp.queues.validation.agentRequired");
    if (!selectedInventory) nextErrors.agentId = t("cp.queues.validation.inventoryRequired");
    const staleNamedFact =
      dialogMode === "create" &&
      form.targetMode === "named" &&
      selectedInventory?.status === "stale" &&
      discovered.includes(form.queueName);
    if (
      form.targetMode === "named" &&
      (!form.queueName ||
        (dialogMode === "create" && !discovered.includes(form.queueName) && !staleNamedFact) ||
        (dialogMode === "create" && selectedInventory?.status !== "available" && !staleNamedFact))
    ) {
      nextErrors.queueName = t("cp.queues.validation.discoveredQueueRequired");
    }
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      return;
    }
    try {
      if (dialogMode === "create") {
        await createQueue.mutateAsync(
          createPayload(staleNamedPrebuild ? { ...form, enabled: false } : form, schedulerType),
        );
        toast.success(t("cp.queues.toast.created"));
      } else if (dialogMode === "edit" && editingQueueId) {
        await updateQueue.mutateAsync({
          queueId: editingQueueId,
          patch: updatePayload(form, schedulerType),
        });
        toast.success(t("cp.queues.toast.updated"));
      }
      closeDialog();
    } catch (err) {
      toast.error(toUserFacingError(err, t("cp.queues.toast.failed")));
    }
  }

  async function toggleEnabled(queue: QueueRegistryView) {
    if (loadError || togglingQueueIds.has(queue.queueId)) return;
    setTogglingQueueIds((current) => new Set(current).add(queue.queueId));
    try {
      await updateQueue.mutateAsync({ queueId: queue.queueId, patch: { enabled: !queue.enabled } });
      toast.success(queue.enabled ? t("cp.queues.toast.disabled") : t("cp.queues.toast.enabled"));
    } catch (err) {
      toast.error(toUserFacingError(err, t("cp.queues.toast.failed")));
    } finally {
      setTogglingQueueIds((current) => {
        const next = new Set(current);
        next.delete(queue.queueId);
        return next;
      });
    }
  }

  function reloadSnapshots() {
    void query.refetch();
    void queryClient.invalidateQueries({ queryKey: ["cp", "queue-inventory"] });
  }

  const titleKey = dialogMode === "create" ? "cp.queues.dialog.create" : "cp.queues.dialog.edit";
  const discoveredQueues = selectedInventory?.queues ?? [];
  const namedQueueMissing =
    form.targetMode === "named" &&
    form.queueName.length > 0 &&
    !discoveredQueues.some((fact) => fact.queueName === form.queueName);

  return (
    <div className="min-w-0 space-y-4" data-testid="cp-queues-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.queues.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("cp.queues.subtitle")}</p>
        </div>
        <Button
          type="button"
          onClick={openCreate}
          disabled={Boolean(loadError)}
          data-testid="cp-queues-create"
        >
          <Plus aria-hidden="true" />
          {t("cp.queues.create")}
        </Button>
      </div>

      {loadError ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
          data-testid="cp-queues-error"
          role="alert"
        >
          {toUserFacingError(loadError, t("cp.queues.toast.failed"))}
        </div>
      ) : null}

      {loadError ? null : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label htmlFor="cp-queues-search" className="grid min-w-0 flex-1 gap-1 text-sm">
              <span className="sr-only">{t("cp.queues.search")}</span>
              <Input
                id="cp-queues-search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder={t("cp.queues.search")}
                data-testid="cp-queues-search"
              />
            </label>
            <select
              value={agentFilter}
              onChange={(event) => setAgentFilter(event.currentTarget.value)}
              aria-label={t("cp.queues.filterAgent")}
              className="h-11 min-w-0 rounded-md border border-border bg-card px-3 text-sm sm:h-9 sm:w-56"
              data-testid="cp-queues-agent-filter"
            >
              <option value="">{t("cp.queues.allAgents")}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.hostname} · {agent.id}
                </option>
              ))}
            </select>
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm sm:min-h-9">
              <input
                type="checkbox"
                checked={onlyAttention}
                onChange={(event) => setOnlyAttention(event.currentTarget.checked)}
              />
              {t("cp.queues.onlyAttention")}
            </label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              onClick={reloadSnapshots}
              aria-label={t("cp.queues.reloadSnapshots", {
                defaultValue: "Reload Server queue snapshots",
              })}
              title={t("cp.queues.reloadSnapshotHint", {
                defaultValue: "Reload Server queue snapshots",
              })}
              data-testid="cp-queues-reload"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>

          <Tabs value={view} onValueChange={(value) => setView(value as QueueView)}>
            <TabsList className="h-auto max-w-full flex-wrap" data-testid="cp-queues-tabs">
              <TabsTrigger value="managed" data-testid="cp-queues-tab-managed">
                {t("cp.queues.managedTargets")}
              </TabsTrigger>
              <TabsTrigger value="inventory" data-testid="cp-queues-tab-inventory">
                {t("cp.queues.schedulerInventory")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="managed" className="min-w-0">
              {query.isLoading ? (
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t("cp.common.loading")}
                </div>
              ) : filteredQueues.length === 0 ? (
                <div
                  className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
                  data-testid="cp-queues-empty"
                >
                  {queues.length === 0 ? t("cp.queues.empty") : t("cp.queues.noMatchingQueues")}
                </div>
              ) : (
                <ManagedQueueTable
                  queues={filteredQueues}
                  togglingQueueIds={togglingQueueIds}
                  expandedQueueId={expandedQueueId}
                  onEdit={openEdit}
                  onToggle={toggleEnabled}
                  onExpandedChange={setExpandedQueueId}
                />
              )}
            </TabsContent>
            <TabsContent value="inventory" className="min-w-0 rounded-md border border-border">
              {agentsQuery.isLoading ? (
                <div
                  className="flex min-h-28 items-center gap-2 px-3 text-sm text-muted-foreground"
                  role="status"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t("cp.common.loading")}
                </div>
              ) : filteredAgents.length === 0 ? (
                <div className="px-3 py-6 text-sm text-muted-foreground">
                  {t("cp.queues.noAgents")}
                </div>
              ) : (
                filteredAgents.map((agent) => (
                  <QueueInventoryAgentSection
                    key={agent.id}
                    agent={agent}
                    onlyAttention={onlyAttention}
                    onManage={openManageFact}
                  />
                ))
              )}
            </TabsContent>
          </Tabs>
        </>
      )}

      <Dialog
        open={dialogMode !== null && !loadError}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent>
          <form onSubmit={onSubmit} noValidate>
            <DialogHeader>
              <DialogTitle>{t(titleKey)}</DialogTitle>
              <DialogDescription>{t("cp.queues.dialog.description")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="cp-queue-field-queue-id" label={t("cp.queues.field.queueId")}>
                <Input
                  id="cp-queue-field-queue-id"
                  value={form.queueId}
                  disabled={dialogMode === "edit"}
                  required
                  onChange={(event) => setForm({ ...form, queueId: event.currentTarget.value })}
                  data-testid="cp-queue-field-queue-id"
                />
              </Field>
              <Field htmlFor="cp-queue-field-name" label={t("cp.queues.field.name")}>
                <Input
                  id="cp-queue-field-name"
                  value={form.name}
                  required
                  onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
                  data-testid="cp-queue-field-name"
                />
              </Field>
              {registrationContext.data?.isPlatformWide && providerOrgs.length > 1 ? (
                <Field
                  htmlFor="cp-queue-field-provider-org-id"
                  label={t("cp.queues.field.providerOrgId")}
                >
                  <select
                    id="cp-queue-field-provider-org-id"
                    value={form.providerOrgId}
                    required
                    onChange={(event) =>
                      setForm({ ...form, providerOrgId: event.currentTarget.value })
                    }
                    data-testid="cp-queue-field-provider-org-id"
                    className="flex h-11 w-full rounded-md border border-border bg-card px-3 py-1 text-sm shadow-sm sm:h-9"
                  >
                    {providerOrgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <input
                  type="hidden"
                  value={form.providerOrgId}
                  data-testid="cp-queue-field-provider-org-id"
                />
              )}
              <Field htmlFor="cp-queue-field-agent-id" label={t("cp.queues.field.agentId")}>
                <select
                  id="cp-queue-field-agent-id"
                  value={form.agentId}
                  required
                  aria-invalid={Boolean(formErrors.agentId)}
                  aria-describedby={formErrors.agentId ? "cp-queue-agent-error" : undefined}
                  onChange={(event) => changeAgent(event.currentTarget.value)}
                  data-testid="cp-queue-field-agent-id"
                  className="flex h-11 w-full rounded-md border border-border bg-card px-3 py-1 text-sm shadow-sm sm:h-9"
                >
                  <option value="">{t("cp.queues.field.chooseAgent")}</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.hostname} · {agent.id}
                    </option>
                  ))}
                </select>
                {formErrors.agentId ? (
                  <p id="cp-queue-agent-error" className="text-xs text-status-failed" role="alert">
                    {formErrors.agentId}
                  </p>
                ) : null}
              </Field>
              <Field
                htmlFor="cp-queue-field-scheduler-type"
                label={t("cp.queues.field.schedulerType")}
              >
                <output
                  id="cp-queue-field-scheduler-type"
                  className="flex min-h-11 items-center rounded-md border border-border bg-muted/30 px-3 font-mono text-sm sm:min-h-9"
                  data-testid="cp-queue-field-scheduler-type"
                >
                  {selectedInventoryQuery.isLoading && form.agentId
                    ? t("cp.common.loading")
                    : schedulerType}
                </output>
              </Field>
              <fieldset
                className="grid gap-2 sm:col-span-2"
                data-testid="cp-queue-target-mode-group"
              >
                <legend className="text-sm font-medium">{t("cp.queues.field.targetMode")}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm">
                    <input
                      type="radio"
                      name="queue-target-mode"
                      value="default"
                      checked={form.targetMode === "default"}
                      onChange={() => changeTargetMode("default")}
                      data-testid="cp-queue-target-default"
                    />
                    {t("cp.queues.targetDefault")}
                  </label>
                  <label className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm">
                    <input
                      type="radio"
                      name="queue-target-mode"
                      value="named"
                      checked={form.targetMode === "named"}
                      onChange={() => changeTargetMode("named")}
                      data-testid="cp-queue-target-named"
                    />
                    {t("cp.queues.targetNamed")}
                  </label>
                </div>
              </fieldset>
              {form.targetMode === "default" ? (
                <div className="grid gap-1.5 text-sm sm:col-span-2">
                  <span className="font-medium">{t("cp.queues.field.schedulerQueue")}</span>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    {selectedInventory?.defaultQueueName ? (
                      <>
                        <span className="font-mono">{selectedInventory.defaultQueueName}</span>
                        {" · "}
                        <TimeValue
                          value={selectedInventory.lastSuccessfulObservedAt}
                          label={t("cp.queues.lastSuccessfulObserved", {
                            defaultValue: "Last successful observation",
                          })}
                        />
                      </>
                    ) : (
                      t("cp.queues.defaultNotObserved")
                    )}
                  </div>
                </div>
              ) : (
                <Field
                  className="sm:col-span-2"
                  htmlFor="cp-queue-field-queue-name"
                  label={t("cp.queues.field.queueName")}
                >
                  <select
                    id="cp-queue-field-queue-name"
                    value={form.queueName}
                    required
                    disabled={!form.agentId || selectedInventoryQuery.isLoading}
                    aria-invalid={Boolean(formErrors.queueName)}
                    aria-describedby={formErrors.queueName ? "cp-queue-name-error" : undefined}
                    onChange={(event) => {
                      setForm({ ...form, queueName: event.currentTarget.value });
                      setFormErrors((current) => ({ ...current, queueName: "" }));
                    }}
                    data-testid="cp-queue-field-queue-name"
                    className="flex h-11 w-full rounded-md border border-border bg-card px-3 py-1 text-sm shadow-sm sm:h-9"
                  >
                    <option value="">{t("cp.queues.field.chooseDiscoveredQueue")}</option>
                    {namedQueueMissing ? (
                      <option value={form.queueName}>
                        {form.queueName} · {t("cp.queues.notDiscovered")}
                      </option>
                    ) : null}
                    {discoveredQueues.map((fact) => (
                      <option key={fact.queueName} value={fact.queueName}>
                        {fact.queueName}
                        {fact.isDefault ? ` · ${t("cp.queues.schedulerDefault")}` : ""}
                      </option>
                    ))}
                  </select>
                  {formErrors.queueName ? (
                    <p id="cp-queue-name-error" className="text-xs text-status-failed" role="alert">
                      {formErrors.queueName}
                    </p>
                  ) : namedQueueMissing ? (
                    <p className="text-xs text-muted-foreground">{t("cp.queues.notDiscovered")}</p>
                  ) : null}
                </Field>
              )}
              {staleNamedPrebuild ? (
                <div className="flex gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground sm:col-span-2">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {t("cp.queues.inventoryNotFreshSaveDisabled", {
                      defaultValue:
                        "This stale last-known named target is saved disabled. A fresh scheduler observation is required before it can be enabled.",
                    })}
                  </span>
                </div>
              ) : null}
              <Field htmlFor="cp-queue-field-qos" label={t("cp.queues.field.qos")}>
                <Input
                  id="cp-queue-field-qos"
                  value={form.qos}
                  onChange={(event) => setForm({ ...form, qos: event.currentTarget.value })}
                  data-testid="cp-queue-field-qos"
                />
              </Field>
              <label className="flex min-h-11 items-center gap-2 self-end text-sm sm:min-h-9">
                <input
                  type="checkbox"
                  checked={staleNamedPrebuild ? false : form.enabled}
                  disabled={namedTargetNeedsFreshInventory}
                  onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })}
                  data-testid="cp-queue-field-enabled"
                />
                {t("cp.queues.field.enabled")}
              </label>
              <fieldset
                className="grid gap-2 sm:col-span-2"
                data-testid="cp-queue-field-visible-org-ids-group"
              >
                <legend className="text-sm font-medium">
                  {t("cp.queues.field.visibleOrgIds")}
                </legend>
                <p className="text-xs text-muted-foreground">
                  {t("cp.queues.field.visibleOrgHint")}
                </p>
                <input
                  type="hidden"
                  value={form.visibleOrgIds}
                  onChange={(event) =>
                    setForm({ ...form, visibleOrgIds: event.currentTarget.value })
                  }
                  data-testid="cp-queue-field-visible-org-ids"
                />
                <div className="flex flex-wrap gap-2">
                  {providerOrgs.map((org) => {
                    const selected = parseList(form.visibleOrgIds).includes(org.id);
                    return (
                      <label
                        key={org.id}
                        className="flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm sm:min-h-9"
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => {
                            const values = new Set(parseList(form.visibleOrgIds));
                            if (event.currentTarget.checked) values.add(org.id);
                            else values.delete(org.id);
                            setForm({ ...form, visibleOrgIds: [...values].join("\n") });
                          }}
                        />
                        {org.name}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <Field
                className="sm:col-span-2"
                htmlFor="cp-queue-field-policy-tags"
                label={t("cp.queues.field.policyTags")}
              >
                <Input
                  id="cp-queue-field-policy-tags"
                  value={form.policyTags}
                  onChange={(event) => setForm({ ...form, policyTags: event.currentTarget.value })}
                  data-testid="cp-queue-field-policy-tags"
                  placeholder={t("cp.queues.field.policyTagsPlaceholder")}
                />
              </Field>
            </DialogBody>
            <DialogFooter className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeDialog}>
                {t("cp.common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={pending || Boolean(loadError) || selectedInventoryQuery.isLoading}
                data-testid="cp-queue-submit"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {t("cp.common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  children,
  className,
  htmlFor,
  label,
}: {
  children: ReactNode;
  className?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className={`grid gap-1.5 text-sm ${className ?? ""}`}>
      <label className="font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
