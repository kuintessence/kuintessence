import type { PreferenceSpec } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  LayoutTemplate,
  Loader2,
  Save,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import {
  consumePendingTemplate,
  getWorkflowTemplate,
  listWorkflowTemplatePage,
  type WorkflowTemplate,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { estimateWorkflow } from "../../lib/workflow-estimate";
import {
  applyWorkflowInputConfiguration,
  extractWorkflowInputModel,
  resolveWorkflowDatasetBinding,
  resolveWorkflowInputModel,
  type WorkflowDatasetCandidate,
  type WorkflowFileCandidate,
} from "../../lib/workflow-input-config";
import { parseWorkflowYaml } from "../../lib/workflow-parser";
import { graphToYaml, yamlToGraph } from "../../lib/yaml-graph-sync";
import type { AgentRow } from "../agents/AgentCard";
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
import { WorkflowEditorShell } from "../workflow/WorkflowEditorShell";
import { type WorkflowCreationStep, WorkflowCreationStepper } from "./WorkflowCreationStepper";
import { WorkflowInputsStep, type WorkflowInputsStepHandle } from "./WorkflowInputsStep";
import { WorkflowTemplatePickerDialog } from "./WorkflowPickerDialogs";
import {
  type WorkflowPlacementDraft,
  type WorkflowQueueOption,
  WorkflowResourcesStep,
} from "./WorkflowResourcesStep";
import { WorkflowReviewStep } from "./WorkflowReviewStep";
import { WorkflowStartOverlay } from "./WorkflowStartOverlay";

interface SubmitResp {
  runId: string;
  name?: string;
  status: string;
}

interface WorkflowPrerequisiteBlock {
  code: string;
  message: string;
  remediation?: string;
}

function workflowPrerequisiteBlocks(error: ApiError): WorkflowPrerequisiteBlock[] {
  const details = error.details;
  const candidates = Array.isArray(details)
    ? details
    : details &&
        typeof details === "object" &&
        Array.isArray((details as { blocks?: unknown }).blocks)
      ? (details as { blocks: unknown[] }).blocks
      : [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const value = candidate as Record<string, unknown>;
    return typeof value.code === "string" && typeof value.message === "string"
      ? [
          {
            code: value.code,
            message: value.message,
            ...(typeof value.remediation === "string" ? { remediation: value.remediation } : {}),
          },
        ]
      : [];
  });
}

interface VisibleQueuesResp {
  queues: WorkflowQueueOption[];
}

interface WorkflowDraftResp {
  id: string;
  name: string;
  placementConfig: {
    budgetCap?: number | null;
    nodeConstraints?: WorkflowPlacementDraft["nodeConstraints"];
    plannerMode?: WorkflowPlacementDraft["plannerMode"];
  };
  yaml: string;
}

async function loadVisibleQueues(): Promise<VisibleQueuesResp> {
  const response = await api.get<VisibleQueuesResp>("/queues/visible");
  const [agentsResult, preferencesResult] = await Promise.allSettled([
    api.get<{ agents: AgentRow[] }>("/agents"),
    api.get<{ spec: PreferenceSpec | null }>("/preferences/global"),
  ]);
  const agents =
    agentsResult.status === "fulfilled" && Array.isArray(agentsResult.value.agents)
      ? agentsResult.value.agents
      : [];
  const costRates =
    preferencesResult.status === "fulfilled" && preferencesResult.value.spec
      ? (preferencesResult.value.spec.costRates ?? {})
      : {};
  const agentsById = new Map(agents.map((agent) => [agent.agentId, agent]));
  return {
    queues: response.queues.map((queue) => {
      const agent = agentsById.get(queue.agentId);
      const clusterName = agent?.clusterId ?? agent?.siteName ?? null;
      return {
        ...queue,
        clusterName,
        costRate: clusterName === null ? null : (costRates[clusterName] ?? null),
      };
    }),
  };
}

interface QueueReference {
  nodeId: string;
  nodeName: string;
  type: "Manual" | "Prefer";
  queueId: string;
}

type ParsedWorkflow = ReturnType<typeof parseWorkflowYaml>;
type WorkflowSpec = Extract<ParsedWorkflow, { ok: true }>["workflow"]["spec"];

function defaultWorkflowName(now = new Date()): string {
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `工作流${year}${month}${day}-1`;
}

function emptyWorkflowYaml(name: string): string {
  return `name: ${name}
description: ""
parameters: []
spec:
  nodeDrafts: []
  nodeRelations: []
`;
}

function collectQueueReferencesFromSpec(spec: WorkflowSpec): QueueReference[] {
  const refs: QueueReference[] = [];
  for (const node of spec.nodeDrafts) {
    if (node.type === "SoftwareUsecaseComputing" || node.type === "Script") {
      const strategy = node.schedulingStrategy;
      if (strategy?.type === "Manual" || strategy?.type === "Prefer") {
        for (const queueId of strategy.queues) {
          refs.push({ nodeId: node.id, nodeName: node.name, type: strategy.type, queueId });
        }
      }
    }
    if (node.type === "Loop" || node.type === "SubWorkflow") {
      const nested =
        node.type === "Loop" ? node.body : node.ref.kind === "Inline" ? node.ref.body : null;
      if (nested) refs.push(...collectQueueReferencesFromSpec(nested));
    }
  }
  return refs;
}

export function NewWorkflowPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [initialDraft] = useState(() => {
    const pending = consumePendingTemplate();
    const name = defaultWorkflowName();
    return {
      yaml: pending?.yaml ?? emptyWorkflowYaml(name),
      name,
      showStart: !pending?.yaml,
    };
  });
  const [yaml, setYaml] = useState(initialDraft.yaml);
  const [workflowName, setWorkflowName] = useState(() => {
    const initial = parseWorkflowYaml(initialDraft.yaml);
    return initial.ok ? initial.workflow.name : initialDraft.name;
  });
  const [startOverlayOpen, setStartOverlayOpen] = useState(initialDraft.showStart);
  const [activeStep, setActiveStep] = useState<WorkflowCreationStep>("edit");
  const [busy, setBusy] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templatePage, setTemplatePage] = useState(1);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateTag, setTemplateTag] = useState("");
  const updateTemplateFilters = useCallback((next: { query: string; tag: string }) => {
    setTemplatePage(1);
    setTemplateQuery(next.query);
    setTemplateTag(next.tag);
  }, []);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [fileDraftId] = useState(() => crypto.randomUUID());
  const [savedDraftId, setSavedDraftId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("draftId");
  });
  const [savingDraft, setSavingDraft] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<WorkflowFileCandidate[]>([]);
  const [bindings, setBindings] = useState<Record<string, WorkflowFileCandidate[]>>({});
  const [datasetBindings, setDatasetBindings] = useState<
    Record<string, WorkflowDatasetCandidate | null>
  >({});
  const [datasetValidity, setDatasetValidity] = useState<Record<string, boolean>>({});
  const [inputsConfirmed, setInputsConfirmed] = useState(false);
  const [associationPromptOpen, setAssociationPromptOpen] = useState(false);
  const [pendingStep, setPendingStep] = useState<WorkflowCreationStep | null>(null);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [submissionBlocks, setSubmissionBlocks] = useState<WorkflowPrerequisiteBlock[]>([]);
  const inputsStepRef = useRef<WorkflowInputsStepHandle>(null);
  const [placementDraft, setPlacementDraft] = useState<WorkflowPlacementDraft>({
    plannerMode: "Global",
    budgetCap: "",
    nodeConstraints: {},
  });

  const patchDatasetBinding = useCallback(
    (key: string, binding: WorkflowDatasetCandidate | null) => {
      setDatasetBindings((current) => ({ ...current, [key]: binding }));
    },
    [],
  );
  const patchDatasetValidity = useCallback((key: string, valid: boolean) => {
    setDatasetValidity((current) => ({ ...current, [key]: valid }));
  }, []);

  const parsed = useMemo(() => parseWorkflowYaml(yaml), [yaml]);
  const baseInputModel = useMemo(() => extractWorkflowInputModel(yaml), [yaml]);
  const byVersionInputsQ = useQuery({
    queryKey: ["workflow-by-version-inputs", yaml],
    queryFn: () => resolveWorkflowInputModel(yaml, getWorkflowTemplate),
    enabled: parsed.ok && baseInputModel.unresolvedSubworkflowRefs.length > 0,
    retry: false,
  });
  const inputModel = byVersionInputsQ.data ?? baseInputModel;

  useEffect(() => {
    setValues((current) =>
      Object.fromEntries(
        inputModel.values.map((requirement) => [
          requirement.key,
          current[requirement.key] ?? requirement.initialValue,
        ]),
      ),
    );
    setBindings((current) =>
      Object.fromEntries(
        inputModel.files.map((requirement) => [
          requirement.key,
          current[requirement.key] ?? requirement.bound,
        ]),
      ),
    );
    setDatasetBindings((current) =>
      Object.fromEntries(
        inputModel.datasets.map((requirement) => [
          requirement.key,
          resolveWorkflowDatasetBinding(current, requirement.key, requirement.bound),
        ]),
      ),
    );
    setDatasetValidity((current) =>
      Object.fromEntries(
        inputModel.datasets.map((requirement) => [
          requirement.key,
          Object.hasOwn(current, requirement.key)
            ? (current[requirement.key] ?? false)
            : requirement.bound === null,
        ]),
      ),
    );
  }, [inputModel]);
  useEffect(() => {
    if (parsed.ok) setWorkflowName(parsed.workflow.name);
  }, [parsed]);

  useEffect(() => {
    if (!savedDraftId) return;
    let cancelled = false;
    api
      .get<WorkflowDraftResp>(`/workflows/drafts/${savedDraftId}`)
      .then((draft) => {
        if (cancelled) return;
        setYaml(draft.yaml);
        setWorkflowName(draft.name);
        setPlacementDraft({
          plannerMode: draft.placementConfig.plannerMode ?? "Global",
          budgetCap:
            draft.placementConfig.budgetCap == null ? "" : String(draft.placementConfig.budgetCap),
          nodeConstraints: draft.placementConfig.nodeConstraints ?? {},
        });
        setStartOverlayOpen(false);
      })
      .catch((error) => {
        if (!cancelled) toast.error(toUserFacingError(error, t("common.error")));
      });
    return () => {
      cancelled = true;
    };
  }, [savedDraftId, t]);

  function commitWorkflowName() {
    const name = workflowName.trim();
    const graph = yamlToGraph(yaml);
    if (!name || !graph.ok || graph.graph.header.name === name) return;
    setYaml(graphToYaml({ ...graph.graph.header, name }, graph.graph.nodes, graph.graph.edges));
  }

  function yamlWithCurrentName(): string {
    const name = workflowName.trim();
    const graph = yamlToGraph(yaml);
    if (!name || !graph.ok || graph.graph.header.name === name) return yaml;
    return graphToYaml({ ...graph.graph.header, name }, graph.graph.nodes, graph.graph.edges);
  }
  const queueReferences = useMemo(
    () => (parsed.ok ? collectQueueReferencesFromSpec(parsed.workflow.spec) : []),
    [parsed],
  );
  const queuesQ = useQuery({
    queryKey: ["queues-visible"],
    queryFn: loadVisibleQueues,
    enabled:
      parsed.ok &&
      (activeStep === "resources" || activeStep === "review" || queueReferences.length > 0),
    retry: false,
  });
  const templatesQ = useQuery({
    queryKey: ["software-workflow-templates", templatePage, templateQuery, templateTag],
    queryFn: () =>
      listWorkflowTemplatePage({
        page: templatePage,
        pageSize: 24,
        q: templateQuery,
        tag: templateTag || undefined,
      }),
    enabled: templatePickerOpen,
    retry: false,
  });
  const visibleQueueIds = useMemo(
    () => new Set((queuesQ.data?.queues ?? []).map((queue) => queue.queueId)),
    [queuesQ.data],
  );
  const hiddenQueueRefs = queueReferences.filter((ref) => !visibleQueueIds.has(ref.queueId));
  const parsedNodeCount = parsed.ok ? parsed.workflow.spec.nodeDrafts.length : 0;
  const parsedEdgeCount = parsed.ok ? (parsed.workflow.spec.nodeRelations?.length ?? 0) : 0;
  const workflowEstimate = useMemo(
    () => estimateWorkflow(yaml, queuesQ.data?.queues ?? []),
    [queuesQ.data?.queues, yaml],
  );
  const missingRequiredFiles = inputModel.files.filter(
    (requirement) =>
      !requirement.optional &&
      (bindings[requirement.key]?.length ?? requirement.bound.length) === 0,
  );
  const missingRequiredValues = inputModel.values.filter(
    (requirement) => requirement.required && !(values[requirement.key] ?? "").trim(),
  );
  const invalidDatasetBindings = inputModel.datasets.filter((requirement) => {
    const selected = resolveWorkflowDatasetBinding(
      datasetBindings,
      requirement.key,
      requirement.bound,
    );
    if (!requirement.usecaseVersionId) return true;
    if (selected === null) return !requirement.optional;
    return datasetValidity[requirement.key] !== true;
  });
  const unresolvedSubworkflowRefs = inputModel.unresolvedSubworkflowRefs;
  const queueReferencesReady =
    queueReferences.length === 0 ||
    (!queuesQ.isLoading && !queuesQ.error && hiddenQueueRefs.length === 0);
  const workflowReady =
    parsed.ok &&
    parsedNodeCount > 0 &&
    missingRequiredFiles.length === 0 &&
    missingRequiredValues.length === 0 &&
    invalidDatasetBindings.length === 0 &&
    unresolvedSubworkflowRefs.length === 0 &&
    !byVersionInputsQ.isLoading &&
    !byVersionInputsQ.error &&
    (inputModel.files.length === 0 || inputsConfirmed) &&
    queueReferencesReady;

  const readinessMessage = !parsed.ok
    ? t("workflows.creation.readiness.fixYaml")
    : parsedNodeCount === 0
      ? t("workflows.creation.readiness.addNode")
      : missingRequiredValues.length > 0
        ? t("workflows.creation.readiness.fillParameters", {
            count: missingRequiredValues.length,
          })
        : missingRequiredFiles.length > 0
          ? t("workflows.creation.readiness.matchFiles", { count: missingRequiredFiles.length })
          : inputModel.files.length > 0 && !inputsConfirmed
            ? t("workflows.creation.readiness.confirmFiles")
            : invalidDatasetBindings.length > 0
              ? t("workflows.creation.readiness.chooseDatasets", {
                  count: invalidDatasetBindings.length,
                })
              : unresolvedSubworkflowRefs.length > 0
                ? t("workflows.creation.readiness.resolveSubworkflows", {
                    count: unresolvedSubworkflowRefs.length,
                    versions: unresolvedSubworkflowRefs
                      .map((block) => block.workflowVersionId)
                      .join(", "),
                  })
                : byVersionInputsQ.error
                  ? toUserFacingError(
                      byVersionInputsQ.error,
                      t("workflows.creation.readiness.loadSubworkflowInputs"),
                    )
                  : byVersionInputsQ.isLoading
                    ? t("workflows.creation.readinessChecking")
                    : queueReferences.length > 0 && queuesQ.isLoading
                      ? t("workflows.creation.readinessChecking")
                      : queuesQ.error
                        ? t("workflows.creation.readiness.loadQueues")
                        : hiddenQueueRefs.length > 0
                          ? t("workflows.creation.readiness.chooseQueue", {
                              count: hiddenQueueRefs.length,
                            })
                          : t("workflows.creation.readyToSubmit");

  async function saveDraft() {
    if (savingDraft || !workflowName.trim()) return;
    let nextYaml: string;
    try {
      nextYaml = applyWorkflowInputConfiguration(
        yamlWithCurrentName(),
        inputModel,
        values,
        bindings,
        datasetBindings,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("workflows.validationFailed"));
      return;
    }
    setSavingDraft(true);
    try {
      const budgetCap = placementDraft.budgetCap.trim();
      const payload = {
        name: workflowName.trim(),
        yaml: nextYaml,
        placementConfig: {
          plannerMode: placementDraft.plannerMode,
          budgetCap: budgetCap ? Number(budgetCap) : null,
          nodeConstraints: placementDraft.nodeConstraints,
        },
      };
      const saved = savedDraftId
        ? await api.put<WorkflowDraftResp>(`/workflows/drafts/${savedDraftId}`, payload)
        : await api.post<WorkflowDraftResp>("/workflows/drafts", payload);
      setYaml(nextYaml);
      setSavedDraftId(saved.id);
      const search = new URLSearchParams(window.location.search);
      search.set("draftId", saved.id);
      window.history.replaceState({}, "", `${window.location.pathname}?${search.toString()}`);
      toast.success(t("workflows.creation.draftSaved"));
    } catch (error) {
      toast.error(toUserFacingError(error, t("workflows.creation.draftSaveFailed")));
    } finally {
      setSavingDraft(false);
    }
  }
  async function onSubmit() {
    if (busy) return;
    let submissionYaml: string;
    try {
      submissionYaml = applyWorkflowInputConfiguration(
        yaml,
        inputModel,
        values,
        bindings,
        datasetBindings,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("workflows.validationFailed"));
      return;
    }
    const submission = parseWorkflowYaml(submissionYaml);
    if (!submission.ok) {
      toast.error(submission.message);
      return;
    }
    setYaml(submissionYaml);
    setSubmissionBlocks([]);
    setBusy(true);
    try {
      const budgetCap = placementDraft.budgetCap.trim();
      const r = await api.post<SubmitResp>("/workflows", {
        yaml: submissionYaml,
        plannerMode: placementDraft.plannerMode,
        budgetCap: budgetCap ? Number(budgetCap) : null,
        nodePlacementConstraints: placementDraft.nodeConstraints,
      });
      toast.success(
        t("workflows.started", {
          name: r.name ?? "workflow",
          count: parsedNodeCount,
        }),
      );
      navigate({ to: "/workflows/$runId", params: { runId: r.runId } });
    } catch (err) {
      if (err instanceof ApiError) setSubmissionBlocks(workflowPrerequisiteBlocks(err));
      toast.error(toUserFacingError(err, t("workflows.submitFailed")));
    } finally {
      setBusy(false);
    }
  }

  function applyTemplate(template: WorkflowTemplate) {
    setYaml(template.yamlContent);
    setSelectedTemplateId(template.id);
    setTemplatePickerOpen(false);
    setStartOverlayOpen(false);
    setActiveStep("edit");
    setCandidates([]);
    setValues({});
    setBindings({});
    setDatasetBindings({});
    setDatasetValidity({});
    setInputsConfirmed(false);
    setPlacementDraft({ plannerMode: "Global", budgetCap: "", nodeConstraints: {} });
  }

  function commitInputConfiguration(
    nextBindings: Record<string, WorkflowFileCandidate[]> = bindings,
  ): string | null {
    try {
      const nextYaml = applyWorkflowInputConfiguration(
        yaml,
        inputModel,
        values,
        nextBindings,
        datasetBindings,
      );
      setYaml(nextYaml);
      return nextYaml;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("workflows.validationFailed"));
      return null;
    }
  }

  async function goToStep(step: WorkflowCreationStep) {
    if (startOverlayOpen) return;
    if (step === "edit") {
      setActiveStep(step);
      return;
    }
    if (!parsed.ok) {
      toast.error(parsed.message);
      return;
    }
    if (
      activeStep === "inputs" &&
      step !== "inputs" &&
      inputModel.files.length > 0 &&
      !inputsConfirmed
    ) {
      setPendingStep(step);
      setAssociationPromptOpen(true);
      return;
    }
    if (activeStep === "inputs" && commitInputConfiguration() === null) return;
    setActiveStep(step);
  }

  async function confirmAssociationsAndContinue() {
    if (!pendingStep || missingRequiredFiles.length > 0) return;
    setAssociationPromptOpen(false);
    const confirmedBindings = await inputsStepRef.current?.confirmAssociations();
    if (!confirmedBindings || commitInputConfiguration(confirmedBindings) === null) return;
    setBindings(confirmedBindings);
    setActiveStep(pendingStep);
    setPendingStep(null);
  }

  return (
    <div className="space-y-5" data-testid="new-workflow-page">
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="p-4 sm:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <input
                aria-label={t("workflows.creation.workflowName")}
                className="min-w-0 max-w-full border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight outline-none ring-0 sm:text-3xl"
                value={workflowName}
                onChange={(event) => setWorkflowName(event.target.value)}
                onBlur={commitWorkflowName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                data-testid="workflow-name-input"
              />
            </div>
            <div
              className="flex flex-wrap items-center gap-2 xl:justify-end"
              data-testid="workflow-title-actions"
            >
              <SubmissionReadinessStatus
                blocking={!parsed.ok || Boolean(queuesQ.error) || Boolean(byVersionInputsQ.error)}
                loading={
                  byVersionInputsQ.isLoading || (queueReferences.length > 0 && queuesQ.isLoading)
                }
                message={readinessMessage}
                ready={workflowReady}
                t={t}
              />
              <Button
                type="button"
                size="sm"
                className="bg-[var(--status-succeeded)] text-white hover:bg-[color-mix(in_oklab,var(--status-succeeded)_88%,black)]"
                disabled={savingDraft || !workflowName.trim()}
                onClick={() => void saveDraft()}
                data-testid="workflow-save-draft"
              >
                {savingDraft ? <Loader2 className="animate-spin" /> : <Save />}
                {t("workflows.creation.saveDraft")}
              </Button>
              {!startOverlayOpen && activeStep === "edit" ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void goToStep("inputs")}
                  disabled={!parsed.ok || parsedNodeCount === 0}
                  data-testid="workflow-title-next"
                >
                  {t("common.next")}
                  <ArrowRight />
                </Button>
              ) : null}
              {!startOverlayOpen && activeStep === "inputs" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void goToStep("edit")}
                    data-testid="workflow-title-previous"
                  >
                    <ArrowLeft />
                    {t("common.previous")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void goToStep("resources")}
                    data-testid="workflow-title-next"
                  >
                    {t("common.next")}
                    <ArrowRight />
                  </Button>
                </>
              ) : null}
              {!startOverlayOpen && activeStep === "resources" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void goToStep("inputs")}
                    data-testid="workflow-title-previous"
                  >
                    <ArrowLeft />
                    {t("common.previous")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void goToStep("review")}
                    data-testid="workflow-title-next"
                  >
                    {t("common.next")}
                    <ArrowRight />
                  </Button>
                </>
              ) : null}
              {!startOverlayOpen && activeStep === "review" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void goToStep("resources")}
                    data-testid="workflow-title-previous"
                  >
                    <ArrowLeft />
                    {t("common.previous")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!workflowReady || busy}
                    onClick={() => setSubmitConfirmOpen(true)}
                    data-testid="submit-workflow"
                  >
                    {busy ? <Loader2 className="animate-spin" /> : <Send />}
                    {t("workflows.submitWorkflow")}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <WorkflowCreationStepper
          blocked={startOverlayOpen}
          current={activeStep}
          embedded
          onChange={(step) => void goToStep(step)}
        />
      </div>

      <WorkflowTemplatePickerDialog
        error={templatesQ.error ?? null}
        hasNext={templatesQ.data?.hasNext ?? false}
        loading={templatesQ.isLoading}
        onApply={applyTemplate}
        onFiltersChange={updateTemplateFilters}
        onOpenChange={setTemplatePickerOpen}
        onPageChange={setTemplatePage}
        open={templatePickerOpen}
        page={templatesQ.data?.page ?? templatePage}
        selectedId={selectedTemplateId}
        tags={templatesQ.data?.tags ?? []}
        templates={templatesQ.data?.templates ?? []}
        total={templatesQ.data?.total ?? 0}
      />

      <Dialog open={associationPromptOpen} onOpenChange={setAssociationPromptOpen}>
        <DialogContent
          data-testid="workflow-association-confirm-dialog"
          outsideDismissPolicy="never"
        >
          <DialogHeader>
            <DialogTitle>{t("workflows.creation.inputs.leaveConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {missingRequiredFiles.length > 0
                ? t("workflows.creation.inputs.leaveConfirmMissing", {
                    count: missingRequiredFiles.length,
                  })
                : t("workflows.creation.inputs.leaveConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {t("workflows.creation.inputs.leaveConfirmHint")}
            </p>
          </DialogBody>
          <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setAssociationPromptOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={missingRequiredFiles.length > 0}
              onClick={() => void confirmAssociationsAndContinue()}
              data-testid="workflow-association-confirm-continue"
            >
              <CheckCircle2 />
              {t("workflows.creation.inputs.confirmAssociations")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={submitConfirmOpen} onOpenChange={setSubmitConfirmOpen}>
        <DialogContent data-testid="workflow-submit-confirm-dialog" outsideDismissPolicy="never">
          <DialogHeader>
            <DialogTitle>{t("workflows.creation.review.submitConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("workflows.creation.review.submitConfirmDescription", {
                edges: parsedEdgeCount,
                nodes: parsedNodeCount,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {t("workflows.creation.review.submitConfirmHint")}
            </p>
          </DialogBody>
          <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setSubmitConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy || !workflowReady}
              onClick={() => {
                setSubmitConfirmOpen(false);
                void onSubmit();
              }}
              data-testid="workflow-submit-confirm"
            >
              <Send />
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeStep === "edit" ? (
        <div className="space-y-4">
          <div className="relative min-h-80">
            <WorkflowEditorShell
              value={yaml}
              onChange={(nextYaml) => {
                setYaml(nextYaml);
                setInputsConfirmed(false);
                setSubmissionBlocks([]);
              }}
              actions={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTemplatePickerOpen(true)}
                  data-testid="workflow-template-picker-open"
                >
                  <LayoutTemplate />
                  {t("workflows.templates.choose")}
                </Button>
              }
            />
            {startOverlayOpen ? (
              <WorkflowStartOverlay
                onScratch={() => {
                  setYaml(emptyWorkflowYaml(workflowName));
                  setStartOverlayOpen(false);
                }}
                onTemplate={() => setTemplatePickerOpen(true)}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {activeStep === "inputs" ? (
        <WorkflowInputsStep
          ref={inputsStepRef}
          bindings={bindings}
          candidates={candidates}
          confirmed={inputsConfirmed}
          datasetBindings={datasetBindings}
          draftId={fileDraftId}
          model={inputModel}
          onBindingsChange={(nextBindings) => {
            setBindings(nextBindings);
            setInputsConfirmed(false);
          }}
          onCandidatesChange={(nextCandidates) => {
            setCandidates(nextCandidates);
            setInputsConfirmed(false);
          }}
          onConfirmedChange={setInputsConfirmed}
          onDatasetBindingChange={patchDatasetBinding}
          onDatasetValidityChange={patchDatasetValidity}
          onValuesChange={(nextValues) => {
            setValues(nextValues);
            setInputsConfirmed(false);
          }}
          values={values}
        />
      ) : null}

      {activeStep === "review" ? (
        <WorkflowReviewStep
          bindings={bindings}
          datasetBindings={datasetBindings}
          datasetValidity={datasetValidity}
          edgeCount={parsedEdgeCount}
          estimate={workflowEstimate}
          model={inputModel}
          nodeCount={parsedNodeCount}
          valid={parsed.ok}
          prerequisites={submissionBlocks}
          values={values}
          yaml={yaml}
        />
      ) : null}
      {activeStep === "resources" ? (
        <WorkflowResourcesStep
          draft={placementDraft}
          onDraftChange={setPlacementDraft}
          onYamlChange={setYaml}
          queues={queuesQ.data?.queues ?? []}
          queuesLoading={queuesQ.isLoading}
          yaml={yaml}
        />
      ) : null}
    </div>
  );
}

function SubmissionReadinessStatus({
  ready,
  blocking,
  loading,
  message,
  t,
}: {
  ready: boolean;
  blocking: boolean;
  loading: boolean;
  message: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  if (loading) {
    return (
      <Badge
        variant="outline"
        className="h-9 whitespace-nowrap px-3"
        data-testid="workflow-readiness-loading"
      >
        <Loader2 className="animate-spin" />
        {t("workflows.creation.readinessChecking")}
      </Badge>
    );
  }
  return (
    <Badge
      variant={ready ? "succeeded" : blocking ? "failed" : "pending"}
      className="h-9 whitespace-nowrap px-3"
      data-testid="workflow-readiness"
    >
      {ready ? <CheckCircle2 /> : blocking ? <AlertTriangle /> : null}
      {ready ? t("workflows.creation.readyToSubmit") : message}
    </Badge>
  );
}
