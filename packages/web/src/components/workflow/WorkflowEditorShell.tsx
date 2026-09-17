/**
 * Three-pane visual editor shell that owns graph<->YAML synchronization.
 *
 * Sync model:
 *   - graph -> YAML: synchronous, every onChange from <ReactFlowEditor> flows
 *     through `graphToYaml` and the parent receives the regenerated string.
 *   - imported YAML -> graph: validated before it replaces the visual graph.
 */

import { useQuery } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { Activity, Copy, FileUp, Sparkles, Waypoints } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getSandboxScript,
  listSandboxScripts,
  type SandboxScriptAsset,
} from "../../lib/sandbox-client";
import { listUsecasePackages, type UsecasePackage } from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import {
  type GraphEdge,
  type GraphHeader,
  type GraphNode,
  type GraphNodeData,
  graphToYaml,
  yamlToGraph,
} from "../../lib/yaml-graph-sync";
import { Button } from "../ui/button";
import { WorkflowUsecasePickerDialog } from "../workflows/WorkflowPickerDialogs";
import { WorkflowScriptPickerDialog } from "../workflows/WorkflowScriptPickerDialog";
import { NodePalette } from "./NodePalette";
import { PropertiesPanel } from "./PropertiesPanel";
import {
  createWorkflowNode,
  type NodeCreationRequest,
  ReactFlowEditor,
  type ScriptNodeBinding,
  type UsecaseNodeBinding,
  type WorkflowFlowAnimationMode,
} from "./ReactFlowEditor";

const PALETTE_WIDTH = { default: 200, min: 160, max: 360 };
const PROPERTIES_WIDTH = { default: 224, min: 196, max: 440 };
const FLOW_ANIMATION_STORAGE_KEY = "kq.workflow.flow-animation-mode";
const FLOW_ANIMATION_MODES: WorkflowFlowAnimationMode[] = ["off", "hover", "click", "always"];

function initialFlowAnimationMode(): WorkflowFlowAnimationMode {
  if (typeof window === "undefined") return "hover";
  const stored = window.localStorage.getItem(FLOW_ANIMATION_STORAGE_KEY);
  return FLOW_ANIMATION_MODES.includes(stored as WorkflowFlowAnimationMode)
    ? (stored as WorkflowFlowAnimationMode)
    : "hover";
}

export interface WorkflowEditorShellProps {
  actions?: ReactNode;
  /** Source YAML — flows in from the page. */
  value: string;
  /** Emit a fresh YAML string to the parent (page form, etc). */
  onChange: (yaml: string) => void;
}

interface GraphState {
  header: GraphHeader;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type ParseError = { ok: false; message: string };

/**
 * Initial graph state — try to parse the incoming YAML. If it doesn't parse,
 * we hold a sentinel header and an empty graph so the editor still renders.
 */
function initialState(yaml: string): { graph: GraphState; error: ParseError | null } {
  const parsed = yamlToGraph(yaml);
  if (parsed.ok) {
    return {
      graph: {
        header: parsed.graph.header,
        nodes: parsed.graph.nodes,
        edges: parsed.graph.edges,
      },
      error: null,
    };
  }
  return {
    graph: {
      header: { name: "(invalid)", parameters: [] },
      nodes: [],
      edges: [],
    },
    error: { ok: false, message: parsed.message },
  };
}

export function WorkflowEditorShell({ actions, value, onChange }: WorkflowEditorShellProps) {
  const { t } = useTranslation();
  const [{ graph, error }, setState] = useState(() => initialState(value));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [propsCollapsed, setPropsCollapsed] = useState(false);
  const [connectionAssist, setConnectionAssist] = useState(false);
  const [flowAnimationMode, setFlowAnimationMode] = useState(initialFlowAnimationMode);
  const [externalConnection, setExternalConnection] = useState<{
    key: number;
    source: string;
    target: string;
  } | null>(null);
  const [connectionDropKind, setConnectionDropKind] = useState<GraphNode["data"]["kind"] | null>(
    null,
  );
  const [paletteWidth, setPaletteWidth] = useState(PALETTE_WIDTH.default);
  const [propertiesWidth, setPropertiesWidth] = useState(PROPERTIES_WIDTH.default);
  const [pendingNode, setPendingNode] = useState<NodeCreationRequest | null>(null);
  const [scriptBindingBusy, setScriptBindingBusy] = useState(false);
  const gridTemplateColumns = `${paletteCollapsed ? "36px 0px" : `${paletteWidth}px 6px`} minmax(0,1fr) ${
    propsCollapsed ? "0px 36px" : `6px ${propertiesWidth}px`
  }`;
  const gridStyle = {
    "--workflow-editor-columns": gridTemplateColumns,
  } as CSSProperties;

  // Latest YAML the parent observed. We compare against this before re-emitting
  // so external `value` prop changes (e.g. picking a template) don't trigger
  // a synthetic onChange echo back to the parent.
  const lastEmittedRef = useRef<string>(value);
  const yamlFileInputRef = useRef<HTMLInputElement>(null);
  const connectionRequestKeyRef = useRef(0);
  const usecasesQ = useQuery({
    queryKey: ["software-usecases"],
    queryFn: () => listUsecasePackages(),
    enabled: pendingNode?.kind === "SoftwareUsecaseComputing",
    retry: false,
  });
  const scriptsQ = useQuery({
    queryKey: ["sandbox-scripts"],
    queryFn: () => listSandboxScripts(),
    enabled: pendingNode?.kind === "Script",
    retry: false,
  });

  // Sync from external value (template picks, parent reset). When the parent
  // hands us a new YAML that we haven't seen before, re-parse the graph and
  // resync the YAML draft.
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    const parsed = yamlToGraph(value);
    if (parsed.ok) {
      setState({
        graph: {
          header: parsed.graph.header,
          nodes: parsed.graph.nodes,
          edges: parsed.graph.edges,
        },
        error: null,
      });
    } else {
      setState((prev) => ({
        graph: prev.graph,
        error: { ok: false, message: parsed.message },
      }));
    }
  }, [value]);

  useEffect(() => {
    window.localStorage.setItem(FLOW_ANIMATION_STORAGE_KEY, flowAnimationMode);
  }, [flowAnimationMode]);

  // graph -> YAML emission. Synchronous: every canvas edit produces a fresh
  // string for the parent to persist on submit.
  function handleGraphChange(nextNodes: GraphNode[], nextEdges: GraphEdge[]) {
    const nextGraph: GraphState = {
      header: graph.header,
      nodes: nextNodes,
      edges: nextEdges,
    };
    setState({ graph: nextGraph, error: null });
    const yaml = graphToYaml(nextGraph.header, nextNodes, nextEdges);
    lastEmittedRef.current = yaml;
    onChange(yaml);
  }

  function handlePatch(nodeId: string, patch: Partial<GraphNodeData>) {
    setState((prev) => {
      const nextNodes = prev.graph.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        return {
          ...n,
          data: {
            ...n.data,
            ...patch,
            // Preserve identity fields that callers rarely supply but downstream
            // code depends on. Only overwrite when explicitly provided.
            id: patch.id ?? n.data.id,
            kind: patch.kind ?? n.data.kind,
            raw: patch.raw ?? n.data.raw,
          },
        };
      });
      const nextGraph: GraphState = {
        header: prev.graph.header,
        nodes: nextNodes,
        edges: prev.graph.edges,
      };
      const yaml = graphToYaml(nextGraph.header, nextNodes, prev.graph.edges);
      lastEmittedRef.current = yaml;
      onChange(yaml);
      return { graph: nextGraph, error: null };
    });
  }

  function handleEdgePatch(edgeId: string, patch: Partial<GraphEdge>) {
    const nextEdges = graph.edges.map((edge) =>
      edge.id === edgeId ? { ...edge, ...patch, id: edge.id } : edge,
    );
    handleGraphChange(graph.nodes, nextEdges);
  }

  function formatWorkflow() {
    const normalized = yamlToGraph(graphToYaml(graph.header, graph.nodes, graph.edges));
    if (!normalized.ok) {
      toast.error(t("workflow.editor.formatFailed"));
      return;
    }
    handleGraphChange(normalized.graph.nodes, normalized.graph.edges);
    toast.success(t("workflow.editor.formatted"));
  }

  async function copyYaml() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("workflow.editor.yamlCopied"));
    } catch {
      toast.error(t("workflow.editor.yamlCopyFailed"));
    }
  }

  async function importYaml(file: File | undefined) {
    if (!file) return;
    const imported = await file.text();
    const parsed = yamlToGraph(imported);
    if (!parsed.ok) {
      toast.error(t("workflow.editor.yamlImportFailed"));
      return;
    }
    setState({
      graph: {
        header: parsed.graph.header,
        nodes: parsed.graph.nodes,
        edges: parsed.graph.edges,
      },
      error: null,
    });
    lastEmittedRef.current = imported;
    onChange(imported);
    toast.success(t("workflow.editor.yamlImported"));
  }

  const selectedNode = useMemo<GraphNode | null>(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );
  const selectedEdge = useMemo<GraphEdge | null>(
    () => graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [graph.edges, selectedEdgeId],
  );

  function localizedNodeName(kind: GraphNode["data"]["kind"]): string {
    const count = graph.nodes.filter((node) => node.data.kind === kind).length + 1;
    return `${t(`workflow.editor.nodeTypes.${kind}`, { defaultValue: kind })} ${count}`;
  }

  function addRequestedNode(
    request: NodeCreationRequest,
    name?: string,
    binding?: UsecaseNodeBinding,
    scriptBinding?: ScriptNodeBinding,
  ) {
    const created = createWorkflowNode(
      request.kind,
      graph.nodes,
      request.position,
      name ?? localizedNodeName(request.kind),
      binding,
      scriptBinding,
    );
    handleGraphChange([...graph.nodes, created], graph.edges);
    setSelectedId(created.id);
    setSelectedEdgeId(null);
    if (request.connectFrom) {
      connectionRequestKeyRef.current += 1;
      setExternalConnection({
        key: connectionRequestKeyRef.current,
        source: request.connectFrom,
        target: created.id,
      });
    }
  }

  function requestNodeCreation(request: NodeCreationRequest) {
    if (request.kind === "SoftwareUsecaseComputing" || request.kind === "Script") {
      setPendingNode(request);
      return;
    }
    addRequestedNode(request);
  }

  function addUsecaseNode(pkg: UsecasePackage) {
    if (!pendingNode || !pkg.publishedSoftwareRevisionId) {
      toast.error(t("workflow.editor.usecasePicker.invalidRevision"));
      return;
    }
    addRequestedNode(pendingNode, pkg.name, {
      usecaseVersionId: pkg.id,
      softwareVersionId: pkg.publishedSoftwareRevisionId,
      inputSlots: buildUsecaseInputSlots(pkg),
      outputSlots: (pkg.spec.filesomeOutputs ?? []).map((output) => ({
        type: "File" as const,
        descriptor: output.descriptor,
        optional: false,
        origin: "UsecaseOut" as const,
        isBatch: output.fileKind.kind === "Batched",
      })),
    });
    setPendingNode(null);
  }

  async function addScriptNode(asset: SandboxScriptAsset) {
    if (!pendingNode || pendingNode.kind !== "Script") return;
    setScriptBindingBusy(true);
    try {
      const detail = await getSandboxScript(asset.id);
      const revision = detail.revisions.toSorted(
        (left, right) => right.revision - left.revision,
      )[0];
      if (!revision?.contentSha256 || revision.payload.kind !== "sandbox-script") {
        throw new Error(t("workflow.editor.scriptPicker.invalidRevision"));
      }
      addRequestedNode(pendingNode, asset.name, undefined, {
        source: {
          type: "AssetRevision",
          assetId: asset.id,
          revision: revision.revision,
          sha256: revision.contentSha256,
        },
        ...(revision.payload.runtimeContractRef
          ? { runtimeContractRef: revision.payload.runtimeContractRef }
          : { runtimeProfileId: revision.payload.runtimeProfileId }),
        inputs: revision.payload.inputs,
        outputs: revision.payload.outputs,
      });
      setPendingNode(null);
    } catch (error) {
      toast.error(toUserFacingError(error, t("workflow.editor.scriptPicker.loadFailed")));
    } finally {
      setScriptBindingBusy(false);
    }
  }

  return (
    <div
      data-testid="rf-shell"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-col gap-3 border-b border-border bg-muted/20 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            {t("workflow.editor.title", { defaultValue: "Workflow editor" })}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("workflow.editor.subtitle", {
              defaultValue: "Drag-drop nodes, YAML stays in sync.",
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {error ? (
            <span
              data-testid="rf-shell-sync-error"
              className="rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1 font-mono text-[11px] text-destructive"
            >
              {t("workflow.editor.canvas.syncError", {
                defaultValue: "YAML parse error, edits paused",
              })}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="rf-shell-format"
            onClick={formatWorkflow}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("workflow.editor.format")}
          </Button>
          <Button
            type="button"
            variant={connectionAssist ? "secondary" : "outline"}
            size="sm"
            aria-pressed={connectionAssist}
            data-testid="rf-shell-connection-assist"
            onClick={() => setConnectionAssist((current) => !current)}
          >
            <Waypoints className="h-3.5 w-3.5" />
            {t("workflow.editor.connectionAssist")}
          </Button>
          <label className="relative flex h-8 items-center rounded-md border border-input bg-background pl-8 pr-2 text-xs">
            <Activity className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <span className="sr-only">{t("workflow.editor.flowAnimation.label")}</span>
            <select
              className="h-full max-w-28 bg-transparent pr-1 outline-none"
              aria-label={t("workflow.editor.flowAnimation.label")}
              title={t("workflow.editor.flowAnimation.label")}
              value={flowAnimationMode}
              onChange={(event) =>
                setFlowAnimationMode(event.target.value as WorkflowFlowAnimationMode)
              }
              data-testid="rf-shell-flow-animation"
            >
              {FLOW_ANIMATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`workflow.editor.flowAnimation.${mode}`)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            data-testid="rf-shell-copy-yaml"
            aria-label={t("workflow.editor.copyYaml")}
            title={t("workflow.editor.copyYaml")}
            onClick={() => void copyYaml()}
          >
            <Copy className="h-3.5 w-3.5" />
            <span className="sr-only">{t("workflow.editor.copyYaml")}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            data-testid="rf-shell-import-yaml"
            aria-label={t("workflow.editor.importYaml")}
            title={t("workflow.editor.importYaml")}
            onClick={() => yamlFileInputRef.current?.click()}
          >
            <FileUp className="h-3.5 w-3.5" />
            <span className="sr-only">{t("workflow.editor.importYaml")}</span>
          </Button>
          <input
            ref={yamlFileInputRef}
            type="file"
            accept=".yaml,.yml,text/yaml,application/yaml"
            className="sr-only"
            onChange={(event) => {
              void importYaml(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          {actions}
        </div>
      </div>

      <div
        className="grid min-h-[760px] grid-cols-1 overflow-auto lg:h-[64vh] lg:min-h-0 lg:grid-cols-[var(--workflow-editor-columns)] lg:overflow-hidden"
        style={gridStyle}
        data-testid="rf-shell-grid"
      >
        <NodePalette
          connectionDropKind={connectionDropKind}
          collapsed={paletteCollapsed}
          onToggleCollapsed={() => setPaletteCollapsed((v) => !v)}
          onAdd={(kind) =>
            requestNodeCreation({
              kind,
              position: {
                x: 80 + (graph.nodes.length % 3) * 240,
                y: 80 + Math.floor(graph.nodes.length / 3) * 140,
              },
            })
          }
        />
        <PanelResizeHandle
          side="left"
          value={paletteWidth}
          limits={PALETTE_WIDTH}
          onChange={setPaletteWidth}
          hidden={paletteCollapsed}
          label={t("workflow.editor.resizePalette")}
        />
        <div className="relative min-h-[420px] w-full overflow-hidden border-y border-border bg-background lg:h-full lg:min-h-0 lg:border-x lg:border-y-0">
          <ReactFlowProvider>
            <ReactFlowEditor
              nodes={graph.nodes}
              edges={graph.edges}
              onChange={handleGraphChange}
              onSelectionChange={setSelectedId}
              onEdgeSelectionChange={setSelectedEdgeId}
              onRequestCreate={requestNodeCreation}
              connectionAssist={connectionAssist}
              flowAnimationMode={flowAnimationMode}
              externalConnection={externalConnection}
              onConnectionPaletteHover={setConnectionDropKind}
            />
          </ReactFlowProvider>
        </div>
        <PanelResizeHandle
          side="right"
          value={propertiesWidth}
          limits={PROPERTIES_WIDTH}
          onChange={setPropertiesWidth}
          hidden={propsCollapsed}
          label={t("workflow.editor.resizeProperties")}
        />
        <PropertiesPanel
          selected={selectedNode}
          selectedEdge={selectedEdge}
          onPatch={handlePatch}
          onEdgePatch={handleEdgePatch}
          collapsed={propsCollapsed}
          onToggleCollapsed={() => setPropsCollapsed((v) => !v)}
        />
      </div>
      <WorkflowUsecasePickerDialog
        error={usecasesQ.error ?? null}
        loading={usecasesQ.isLoading}
        onApply={addUsecaseNode}
        onOpenChange={(open) => {
          if (!open) setPendingNode(null);
        }}
        open={pendingNode?.kind === "SoftwareUsecaseComputing"}
        packages={usecasesQ.data ?? []}
      />
      <WorkflowScriptPickerDialog
        busy={scriptBindingBusy}
        error={!!scriptsQ.error}
        loading={scriptsQ.isLoading}
        onApply={addScriptNode}
        onOpenChange={(open) => {
          if (!open) setPendingNode(null);
        }}
        open={pendingNode?.kind === "Script"}
        scripts={scriptsQ.data ?? []}
      />
    </div>
  );
}

export function buildUsecaseInputSlots(
  pkg: UsecasePackage,
): NonNullable<UsecaseNodeBinding["inputSlots"]> {
  const datasets =
    pkg.spec.softwareRef !== undefined
      ? pkg.spec.inputs
          .filter((input) => input.type === "Dataset")
          .map((input) => ({
            type: "Dataset" as const,
            descriptor: input.descriptor,
            optional: !input.required,
            contents: null,
          }))
      : [];
  const datasetDescriptors = new Set(datasets.map((slot) => slot.descriptor));
  const materialSlots = pkg.spec.usecase.inputSlots
    .filter((slot) => !datasetDescriptors.has(slot.descriptor))
    .map((slot) => {
      if (slot.kind === "Text") {
        return { type: "Text" as const, descriptor: slot.descriptor, optional: false };
      }
      const fileReference = slot.refMaterials.find(
        (reference) => reference.kind === "FileInputRef",
      );
      const material = pkg.spec.filesomeInputs.find(
        (candidate) => candidate.descriptor === (fileReference?.descriptor ?? slot.descriptor),
      );
      return {
        type: "File" as const,
        descriptor: slot.descriptor,
        optional: false,
        isBatch: material?.fileKind.kind === "Batched",
        expectedFileName: material?.fileKind.kind === "Normal" ? material.fileKind.name : undefined,
      };
    });
  const seen = new Set<string>();
  return [...materialSlots, ...datasets].filter((slot) => {
    if (seen.has(slot.descriptor)) return false;
    seen.add(slot.descriptor);
    return true;
  });
}

function PanelResizeHandle({
  hidden,
  label,
  limits,
  onChange,
  side,
  value,
}: {
  hidden: boolean;
  label: string;
  limits: { min: number; max: number };
  onChange: (value: number) => void;
  side: "left" | "right";
  value: number;
}) {
  function clamp(next: number) {
    return Math.min(limits.max, Math.max(limits.min, next));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startValue = value;
    const move = (moveEvent: globalThis.PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      onChange(clamp(startValue + (side === "left" ? delta : -delta)));
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    onChange(clamp(value + (side === "left" ? direction : -direction) * 12));
  }

  return (
    <hr
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={value}
      tabIndex={hidden ? -1 : 0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={`relative hidden h-full cursor-col-resize touch-none border-0 bg-border/50 outline-none transition-colors hover:bg-brand focus:bg-brand lg:block ${
        hidden ? "pointer-events-none opacity-0" : ""
      }`}
      data-testid={`rf-${side}-resize-handle`}
    />
  );
}
