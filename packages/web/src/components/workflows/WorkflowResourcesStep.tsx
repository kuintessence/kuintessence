import type { workflowDsl } from "@kuintessence/shared/browser";
import { CircleDollarSign, Clock3, Cpu, MapPin, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { estimateWorkflow } from "../../lib/workflow-estimate";
import { graphToYaml, yamlToGraph } from "../../lib/yaml-graph-sync";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { WorkflowReviewGraph } from "./WorkflowReviewGraph";

export interface WorkflowQueueOption {
  queueId: string;
  name: string;
  agentId: string;
  schedulerType: string;
  queueName: string;
  qos: string | null;
  clusterName?: string | null;
  costRate?: number | null;
}

export interface WorkflowPlacementDraft {
  plannerMode: "Global" | "Lookahead" | "Greedy";
  budgetCap: string;
  nodeConstraints: Record<string, workflowDsl.PlacementConstraint>;
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWorkflowQueueUuid(queueId: string): boolean {
  return UUID_PATTERN.test(queueId);
}

export function WorkflowResourcesStep({
  draft,
  onDraftChange,
  onYamlChange,
  queues,
  queuesLoading,
  yaml,
}: {
  draft: WorkflowPlacementDraft;
  onDraftChange: (draft: WorkflowPlacementDraft) => void;
  onYamlChange: (yaml: string) => void;
  queues: WorkflowQueueOption[];
  queuesLoading: boolean;
  yaml: string;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(() => yamlToGraph(yaml), [yaml]);
  const estimate = useMemo(() => estimateWorkflow(yaml, queues), [queues, yaml]);
  const selectableQueues = useMemo(
    () => queues.filter((queue) => isWorkflowQueueUuid(queue.queueId)),
    [queues],
  );
  const schedulableNodes = useMemo(
    () =>
      parsed.ok
        ? parsed.graph.nodes.filter(
            (node) =>
              node.data.raw.type === "SoftwareUsecaseComputing" || node.data.raw.type === "Script",
          )
        : [],
    [parsed],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    schedulableNodes[0]?.id ?? null,
  );
  const selectedNode = schedulableNodes.find((node) => node.id === selectedNodeId) ?? null;

  useEffect(() => {
    if (selectedNodeId && schedulableNodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(schedulableNodes[0]?.id ?? null);
  }, [schedulableNodes, selectedNodeId]);

  const strategy =
    selectedNode?.data.raw.type === "SoftwareUsecaseComputing" ||
    selectedNode?.data.raw.type === "Script"
      ? (selectedNode.data.raw.schedulingStrategy ?? { type: "Auto" as const })
      : { type: "Auto" as const };
  const selectedQueueId = strategy.type === "Auto" ? "" : (strategy.queues[0] ?? "");
  const constraint = selectedNode ? draft.nodeConstraints[selectedNode.id] : undefined;

  function patchSchedulingStrategy(type: workflowDsl.SchedulingStrategy["type"], queueId?: string) {
    if (!parsed.ok || !selectedNode) return;
    const fallbackQueueId = queueId || selectedQueueId || selectableQueues[0]?.queueId;
    if (type !== "Auto" && !fallbackQueueId) return;
    const nextStrategy: workflowDsl.SchedulingStrategy =
      type === "Auto" ? { type: "Auto" } : { type, queues: [fallbackQueueId as string] };
    const nextNodes = parsed.graph.nodes.map((node) => {
      if (node.id !== selectedNode.id) return node;
      const raw = node.data.raw;
      if (raw.type !== "SoftwareUsecaseComputing" && raw.type !== "Script") return node;
      return {
        ...node,
        data: { ...node.data, raw: { ...raw, schedulingStrategy: nextStrategy } },
      };
    });
    onYamlChange(graphToYaml(parsed.graph.header, nextNodes, parsed.graph.edges));

    if (type !== "Auto") {
      onDraftChange({
        ...draft,
        nodeConstraints: {
          ...draft.nodeConstraints,
          [selectedNode.id]: {
            mode: type === "Manual" ? "Require" : "Prefer",
            siteIds: constraint?.siteIds ?? [],
            clusterIds: constraint?.clusterIds ?? [],
            dataMovement: constraint?.dataMovement ?? "Allow",
          },
        },
      });
    }
  }

  function patchDataMovement(dataMovement: "Allow" | "Forbid") {
    if (!selectedNode) return;
    onDraftChange({
      ...draft,
      nodeConstraints: {
        ...draft.nodeConstraints,
        [selectedNode.id]: {
          mode: strategy.type === "Manual" ? "Require" : "Prefer",
          siteIds: constraint?.siteIds ?? [],
          clusterIds: constraint?.clusterIds ?? [],
          dataMovement,
        },
      },
    });
  }

  return (
    <div className="space-y-4" data-testid="workflow-resources-step">
      <Card className="rounded-xl shadow-none">
        <CardHeader>
          <div>
            <CardTitle>{t("workflows.creation.resources.title")}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("workflows.creation.resources.description")}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Route className="h-4 w-4 text-brand" />
                {t("workflows.creation.resources.plannerMode")}
              </span>
              <select
                data-testid="workflow-resource-planner-mode"
                className={SELECT_CLASS}
                value={draft.plannerMode}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    plannerMode: event.target.value as WorkflowPlacementDraft["plannerMode"],
                  })
                }
              >
                <option value="Global">
                  {t("workflows.creation.resources.algorithms.Global.name")}
                </option>
                <option value="Lookahead">
                  {t("workflows.creation.resources.algorithms.Lookahead.name")}
                </option>
                <option value="Greedy">
                  {t("workflows.creation.resources.algorithms.Greedy.name")}
                </option>
              </select>
              <span className="block text-xs leading-5 text-muted-foreground">
                {t(`workflows.creation.resources.algorithms.${draft.plannerMode}.description`)}
              </span>
            </label>
            <div className="space-y-1.5">
              <label
                htmlFor="workflow-placement-budget"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Cpu className="h-4 w-4 text-brand" />
                {t("workflows.creation.resources.budgetCap")}
              </label>
              <Input
                data-testid="workflow-resource-budget-cap"
                id="workflow-placement-budget"
                min="0"
                step="0.01"
                type="number"
                value={draft.budgetCap}
                placeholder={t("workflows.creation.resources.noBudgetCap")}
                onChange={(event) => onDraftChange({ ...draft, budgetCap: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                <MapPin className="h-4 w-4 text-brand" />
                {t("workflows.creation.resources.queueStatus")}
              </span>
              <div className="flex min-h-9 items-center rounded-md border border-border bg-muted/30 px-3">
                <Badge variant="outline">
                  {queuesLoading
                    ? t("common.loading")
                    : t("workflows.creation.resources.queueCount", { count: queues.length })}
                </Badge>
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2" data-testid="workflow-resource-estimate">
            <EstimateCard
              icon={Clock3}
              label={t("workflows.creation.resources.estimatedDuration")}
              value={formatDuration(estimate.durationSec, t)}
              hint={t("workflows.creation.resources.durationBasis", {
                count: estimate.fallbackNodeCount,
              })}
            />
            <EstimateCard
              icon={CircleDollarSign}
              label={t("workflows.creation.resources.estimatedCost")}
              value={formatCost(estimate.minCost, estimate.maxCost, t)}
              hint={t("workflows.creation.resources.costBasis", {
                count: estimate.unpricedNodeCount,
              })}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-xl shadow-none">
        <CardHeader>
          <div>
            <CardTitle>{t("workflows.creation.resources.nodeTitle")}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("workflows.creation.resources.nodeDescription")}
            </p>
          </div>
        </CardHeader>
        <CardContent
          className="grid min-h-96 items-stretch gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]"
          style={{ height: "calc(100dvh - 20rem)" }}
        >
          <WorkflowReviewGraph
            mode="fill"
            yaml={yaml}
            selectedNodeId={selectedNodeId}
            onNodeSelect={setSelectedNodeId}
          />
          <section className="rounded-lg border border-border bg-muted/20 p-4">
            {selectedNode ? (
              <div className="space-y-4">
                <div>
                  <p className="font-semibold">{selectedNode.data.name}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{selectedNode.id}</p>
                </div>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("workflows.creation.resources.schedulingStrategy")}
                  </span>
                  <select
                    data-testid="workflow-resource-node-strategy"
                    className={SELECT_CLASS}
                    value={strategy.type}
                    onChange={(event) =>
                      patchSchedulingStrategy(
                        event.target.value as workflowDsl.SchedulingStrategy["type"],
                      )
                    }
                  >
                    <option value="Auto">{t("workflows.creation.resources.auto")}</option>
                    <option value="Prefer" disabled={selectableQueues.length === 0}>
                      {t("workflows.creation.resources.prefer")}
                    </option>
                    <option value="Manual" disabled={selectableQueues.length === 0}>
                      {t("workflows.creation.resources.manual")}
                    </option>
                  </select>
                </label>
                {strategy.type !== "Auto" ? (
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium">
                      {t("workflows.creation.resources.targetQueue")}
                    </span>
                    <select
                      data-testid="workflow-resource-target-queue"
                      className={SELECT_CLASS}
                      value={selectedQueueId}
                      onChange={(event) =>
                        patchSchedulingStrategy(strategy.type, event.target.value)
                      }
                    >
                      {selectableQueues.map((queue) => (
                        <option key={queue.queueId} value={queue.queueId}>
                          {queue.name} · {queue.schedulerType}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("workflows.creation.resources.dataMovement")}
                  </span>
                  <select
                    data-testid="workflow-resource-data-movement"
                    className={SELECT_CLASS}
                    value={constraint?.dataMovement ?? "Allow"}
                    onChange={(event) =>
                      patchDataMovement(event.target.value as "Allow" | "Forbid")
                    }
                  >
                    <option value="Allow">{t("workflows.creation.resources.allow")}</option>
                    <option value="Forbid">{t("workflows.creation.resources.forbid")}</option>
                  </select>
                </label>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("workflows.creation.resources.noSchedulableNode")}
              </p>
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  );
}

function EstimateCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-4 w-4 text-brand" />
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
    </div>
  );
}

export function formatDuration(seconds: number, t: ReturnType<typeof useTranslation>["t"]): string {
  if (seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.ceil((seconds % 3_600) / 60);
  if (hours === 0) return t("workflows.creation.resources.durationMinutes", { count: minutes });
  if (minutes === 0) return t("workflows.creation.resources.durationHours", { count: hours });
  return t("workflows.creation.resources.durationHoursMinutes", { hours, minutes });
}

export function formatCost(
  minCost: number | null,
  maxCost: number | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (minCost === null || maxCost === null)
    return t("workflows.creation.resources.costUnavailable");
  const value =
    Math.abs(maxCost - minCost) < 0.005
      ? minCost.toFixed(2)
      : `${minCost.toFixed(2)} – ${maxCost.toFixed(2)}`;
  return t("workflows.creation.resources.costValue", { value });
}
