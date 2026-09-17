import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Cloud,
  Copy,
  FileIcon,
  FileInput,
  FileOutput,
  Link2,
  UploadCloud,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { WorkflowEstimate } from "../../lib/workflow-estimate";
import type {
  WorkflowDatasetCandidate,
  WorkflowFileCandidate,
  WorkflowInputModel,
} from "../../lib/workflow-input-config";
import { resolveWorkflowDatasetBinding } from "../../lib/workflow-input-config";
import { type GraphEdge, type GraphNode, yamlToGraph } from "../../lib/yaml-graph-sync";
import { fmtBytes } from "../files/path-picker-utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  type SlotOption,
  workflowInputSlots,
  workflowOutputSlots,
} from "../workflow/WorkflowSlotMappingDialog";
import { formatCost, formatDuration } from "./WorkflowResourcesStep";
import { WorkflowReviewGraph } from "./WorkflowReviewGraph";

export function WorkflowReviewStep({
  bindings,
  datasetBindings,
  datasetValidity,
  edgeCount,
  estimate,
  model,
  nodeCount,
  prerequisites = [],
  valid,
  values,
  yaml,
}: {
  bindings: Record<string, WorkflowFileCandidate[]>;
  datasetBindings: Record<string, WorkflowDatasetCandidate | null>;
  datasetValidity: Record<string, boolean>;
  edgeCount: number;
  estimate: WorkflowEstimate;
  model: WorkflowInputModel;
  nodeCount: number;
  prerequisites?: Array<{ code: string; message: string; remediation?: string }>;
  valid: boolean;
  values: Record<string, string>;
  yaml: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const parsedGraph = useMemo(() => yamlToGraph(yaml), [yaml]);
  const missingFiles = model.files.filter(
    (requirement) =>
      !requirement.optional &&
      (bindings[requirement.key]?.length ?? requirement.bound.length) === 0,
  );
  const missingValues = model.values.filter(
    (requirement) => requirement.required && !(values[requirement.key] ?? "").trim(),
  );
  const invalidDatasets = model.datasets.filter((requirement) => {
    const selected = resolveWorkflowDatasetBinding(
      datasetBindings,
      requirement.key,
      requirement.bound,
    );
    if (!requirement.usecaseVersionId) return true;
    if (selected === null) return !requirement.optional;
    return datasetValidity[requirement.key] !== true;
  });
  const ready =
    valid &&
    missingFiles.length === 0 &&
    missingValues.length === 0 &&
    invalidDatasets.length === 0;

  function prerequisiteMessage(block: { code: string; message: string; remediation?: string }) {
    const fallback = t("workflows.creation.review.governanceBlockedHint", {
      defaultValue: "当前工作流依赖的资源或权限尚未满足，请按建议处理后重试。",
    });
    const code = block.code.toUpperCase();
    const known: Record<string, string> = {
      SOFTWARE_ACCESS_REQUIRED: t("workflows.creation.review.softwareAccessRequired", {
        defaultValue: "工作流使用的软件尚未获得当前组织的使用许可。",
      }),
      DATASET_ACCESS_REQUIRED: t("workflows.creation.review.datasetAccessRequired", {
        defaultValue: "工作流所需数据集尚未对当前组织开放。",
      }),
      QUEUE_ACCESS_REQUIRED: t("workflows.creation.review.queueAccessRequired", {
        defaultValue: "工作流指定的队列当前不可用或未向当前组织开放。",
      }),
    };
    return known[code] ?? fallback;
  }

  function prerequisiteRemediation(block: { code: string; remediation?: string }) {
    const code = block.code.toUpperCase();
    const known: Record<string, string> = {
      SOFTWARE_ACCESS_REQUIRED: t("workflows.creation.review.softwareAccessRemediation", {
        defaultValue: "请联系组织管理员确认软件许可，或选择已开放的软件版本。",
      }),
      DATASET_ACCESS_REQUIRED: t("workflows.creation.review.datasetAccessRemediation", {
        defaultValue: "请申请数据集访问权限，或改用当前组织可用的数据集版本。",
      }),
      QUEUE_ACCESS_REQUIRED: t("workflows.creation.review.queueAccessRemediation", {
        defaultValue: "请切换到可见队列，或联系计算资源管理员开放目标队列。",
      }),
    };
    return (
      known[code] ??
      t("workflows.creation.review.governanceBlockedHint", {
        defaultValue: "请按资源管理员给出的权限或资源要求处理后重试。",
      })
    );
  }

  async function copyYaml() {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      toast.success(t("workflows.creation.review.yamlCopied"));
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error(t("workflows.creation.review.yamlCopyFailed"));
    }
  }

  return (
    <div className="space-y-4" data-testid="workflow-review-step">
      <Card className="rounded-md shadow-none">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>{t("workflows.creation.review.title")}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("workflows.creation.review.description")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyYaml}
              data-testid="workflow-review-copy-yaml"
            >
              {copied ? <Check /> : <Copy />}
              {copied
                ? t("workflows.creation.review.yamlCopiedShort")
                : t("workflows.creation.review.copyYaml")}
            </Button>
            <Badge variant={ready ? "succeeded" : "failed"}>
              {ready ? <CheckCircle2 /> : <AlertTriangle />}
              {ready
                ? t("workflows.creation.review.ready")
                : t("workflows.creation.review.needsAttention")}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2" data-testid="workflow-review-estimate">
            <ReviewEstimate
              icon={Clock3}
              label={t("workflows.creation.resources.estimatedDuration")}
              value={formatDuration(estimate.durationSec, t)}
            />
            <ReviewEstimate
              icon={CircleDollarSign}
              label={t("workflows.creation.resources.estimatedCost")}
              value={formatCost(estimate.minCost, estimate.maxCost, t)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Summary label={t("workflows.creation.review.nodes")} value={nodeCount} />
            <Summary label={t("workflows.creation.review.edges")} value={edgeCount} />
            <Summary
              label={t("workflows.creation.review.parameters")}
              value={model.values.length}
            />
            <Summary label={t("workflows.creation.review.files")} value={model.files.length} />
          </div>
          {missingFiles.length > 0 || missingValues.length > 0 || invalidDatasets.length > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <p className="font-medium">{t("workflows.creation.review.missingTitle")}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                {missingValues.map((requirement) => (
                  <li key={requirement.key}>{requirement.label}</li>
                ))}
                {missingFiles.map((requirement) => (
                  <li key={requirement.key}>
                    {requirement.nodeName} / {requirement.descriptor}
                  </li>
                ))}
                {invalidDatasets.map((requirement) => (
                  <li key={requirement.key}>
                    {requirement.nodeName} / {requirement.descriptor}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {prerequisites.length > 0 ? (
            <div
              className="rounded-lg border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
              data-testid="workflow-license-prerequisites"
            >
              <p className="font-medium">{t("workflows.creation.review.governanceBlocked")}</p>
              <ul className="mt-2 space-y-2 text-muted-foreground">
                {prerequisites.map((block) => (
                  <li key={`${block.code}:${block.remediation ?? ""}`}>
                    {prerequisiteMessage(block)}
                    <p className="mt-1 text-xs">{prerequisiteRemediation(block)}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("workflows.creation.review.graphTitle")}</h3>
            <WorkflowReviewGraph yaml={yaml} mode="resizable" />
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("workflows.creation.review.ioTitle")}</h3>
            <div className="grid gap-3 lg:grid-cols-2" data-testid="workflow-review-io">
              {parsedGraph.ok
                ? parsedGraph.graph.nodes.map((node) => {
                    const inputs = workflowInputSlots(node);
                    const outputs = workflowOutputSlots(node);
                    if (inputs.length === 0 && outputs.length === 0) return null;
                    return (
                      <article
                        key={node.id}
                        className="overflow-hidden rounded-lg border border-border bg-background"
                      >
                        <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/25 px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{node.data.name}</p>
                            <p className="truncate text-[11px] text-muted-foreground">{node.id}</p>
                          </div>
                          <Badge variant="outline">
                            {t(`workflow.editor.nodeTypes.${node.data.kind}`, {
                              defaultValue: node.data.kind,
                            })}
                          </Badge>
                        </header>
                        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                          <SlotSection
                            accent="input"
                            label={t("workflows.creation.review.inputs")}
                            slots={inputs.map((slot) => ({
                              ...slot,
                              ...configuredInput(
                                node.id,
                                slot.descriptor,
                                model,
                                bindings,
                                datasetBindings,
                                datasetValidity,
                                values,
                                parsedGraph.graph.nodes,
                                parsedGraph.graph.edges,
                                t("workflows.creation.review.notConfigured"),
                              ),
                            }))}
                          />
                          <SlotSection
                            accent="output"
                            label={t("workflows.creation.review.outputs")}
                            slots={outputs.map((slot) => ({
                              ...slot,
                              state: "generated" as const,
                              value: t("workflows.creation.review.outputDescription", {
                                type: slot.type,
                                mode:
                                  slot.type === "Text"
                                    ? t("workflows.creation.review.singleValue")
                                    : slot.batch
                                      ? t("workflows.creation.review.batchOutput")
                                      : t("workflows.creation.review.singleOutput"),
                              }),
                            }))}
                          />
                        </div>
                      </article>
                    );
                  })
                : null}
            </div>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewEstimate({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-base font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

type InputState = "configured" | "connected" | "missing";

function configuredInput(
  nodeId: string,
  descriptor: string,
  model: WorkflowInputModel,
  bindings: Record<string, WorkflowFileCandidate[]>,
  datasetBindings: Record<string, WorkflowDatasetCandidate | null>,
  datasetValidity: Record<string, boolean>,
  values: Record<string, string>,
  nodes: GraphNode[],
  edges: GraphEdge[],
  fallback: string,
): {
  dataset?: WorkflowDatasetCandidate;
  files?: WorkflowFileCandidate[];
  state: InputState;
  value: string;
} {
  const relation = edges
    .filter((edge) => edge.target === nodeId)
    .flatMap((edge) => (edge.slotRelations ?? []).map((mapping) => ({ edge, mapping })))
    .find(({ mapping }) => mapping.toSlot === descriptor);
  if (relation) {
    const source = nodes.find((node) => node.id === relation.edge.source);
    return {
      state: "connected",
      value: `${source?.data.name ?? relation.edge.source} / ${relation.mapping.fromSlot}`,
    };
  }
  const key = `slot:${nodeId}:${descriptor}`;
  const datasetKey = `dataset:${nodeId}:${descriptor}`;
  const datasetRequirement = model.datasets.find((item) => item.key === datasetKey);
  if (datasetRequirement) {
    const selected = resolveWorkflowDatasetBinding(
      datasetBindings,
      datasetKey,
      datasetRequirement.bound,
    );
    const verified = datasetValidity[datasetKey] === true;
    if (!selected) return { state: "missing", value: fallback };
    return {
      dataset: selected,
      state: verified ? "configured" : "missing",
      value: selected.versionId,
    };
  }
  const files = bindings[key] ?? model.files.find((item) => item.key === key)?.bound ?? [];
  if (files.length > 0) {
    return {
      files,
      state: "configured",
      value: files.map((file) => file.name).join(", "),
    };
  }
  const valueRequirement = model.values.find(
    (requirement) => requirement.nodeId === nodeId && requirement.descriptor === descriptor,
  );
  const value = values[valueRequirement?.key ?? key];
  return value?.trim() ? { state: "configured", value } : { state: "missing", value: fallback };
}

type ReviewSlot = SlotOption & {
  dataset?: WorkflowDatasetCandidate;
  files?: WorkflowFileCandidate[];
  state: InputState | "generated";
  value: string;
};

function SlotSection({
  accent,
  label,
  slots,
}: {
  accent: "input" | "output";
  label: string;
  slots: ReviewSlot[];
}) {
  const { t } = useTranslation();
  const Icon = accent === "input" ? FileInput : FileOutput;
  return (
    <section className="min-w-0 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Icon
          className={accent === "input" ? "h-3.5 w-3.5 text-brand" : "h-3.5 w-3.5 text-success"}
        />
        {label}
      </p>
      {slots.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">—</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {slots.map((slot) => {
            const stateClass =
              slot.state === "missing"
                ? "bg-warning/10 text-warning-foreground"
                : slot.state === "connected"
                  ? "bg-brand-soft text-brand"
                  : "bg-success/10 text-success";
            if (slot.type === "Text") {
              return (
                <li
                  key={slot.descriptor}
                  className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2.5 py-2"
                  title={slot.description ?? slot.value}
                >
                  <Badge variant="outline">Text</Badge>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {slot.descriptor}
                  </span>
                  <span
                    className={`max-w-[55%] truncate rounded px-2 py-1 text-[11px] ${stateClass}`}
                  >
                    {slot.value}
                  </span>
                </li>
              );
            }
            if (slot.type === "Dataset") {
              return (
                <li key={slot.descriptor} className="min-w-0 rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Dataset</Badge>
                    <span className="truncate text-xs font-medium">{slot.descriptor}</span>
                  </div>
                  <div className={`mt-2 space-y-1 rounded px-2 py-1 text-[11px] ${stateClass}`}>
                    <p className="truncate">
                      {t("workflows.creation.review.datasetVersion", { version: slot.value })}
                    </p>
                    <p className="truncate">
                      {t("workflows.creation.review.datasetTargetPath", {
                        path:
                          slot.dataset?.targetPath ??
                          t("workflows.creation.review.datasetDefaultTargetPath"),
                      })}
                    </p>
                  </div>
                </li>
              );
            }
            return (
              <li key={slot.descriptor} className="min-w-0 rounded-md border border-border p-2.5">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    File{slot.batch ? ` · ${t("workflows.creation.inputs.fileBatch")}` : ""}
                  </Badge>
                  <span className="truncate text-xs font-medium">{slot.descriptor}</span>
                </div>
                {slot.description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {slot.description}
                  </p>
                ) : null}
                {slot.files?.length ? (
                  <div className="mt-2 space-y-1.5">
                    {slot.files.map((file) => {
                      const SourceIcon = file.source === "local" ? UploadCloud : Cloud;
                      return (
                        <div
                          key={file.id}
                          className="flex min-w-0 items-center gap-2 rounded bg-success/10 px-2 py-1.5 text-[11px] text-success"
                        >
                          <SourceIcon className="h-3.5 w-3.5 shrink-0" />
                          <FileIcon className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{file.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {file.source === "local"
                              ? t("workflows.creation.review.localFile")
                              : t("workflows.creation.review.cloudFile")}
                            {` · ${fmtBytes(file.size)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    className={`mt-2 flex min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-[11px] ${stateClass}`}
                    title={slot.value}
                  >
                    {slot.state === "connected" ? <Link2 className="h-3 w-3 shrink-0" /> : null}
                    <span className="truncate">{slot.value}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold">{value}</p>
    </div>
  );
}
