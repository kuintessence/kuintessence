/**
 * Controlled React Flow host. Owns no graph state of its own — the parent
 * (`WorkflowEditorShell`) drives `nodes` / `edges` and re-emits via `onChange`.
 *
 * The host is responsible for three pieces of behavior the shell does not want
 * to know about:
 *   1. Drag-drop from the palette using the `application/x-kuintessence-node-kind`
 *      MIME type. Drop position is mapped from screen pixels to flow space via
 *      `useReactFlow().screenToFlowPosition` so dropped nodes land where the
 *      cursor was, not at the origin.
 *   2. Selection routing — node clicks bubble up as a single id (or null when
 *      clicking the empty pane).
 *   3. Wiring of standard chrome (Background / Controls / MiniMap) so the
 *      shell only renders the layout grid.
 */

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type EdgeMouseHandler,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnConnectStart,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { workflowDsl } from "@kuintessence/shared/browser";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode, GraphNodeKind } from "../../lib/yaml-graph-sync";
import { EDGE_TYPE_MAP, type WorkflowEdgeVisualData } from "./EdgeTypes";
import { PALETTE_DRAG_MIME } from "./NodePalette";
import { ConnectionAssistProvider, NODE_TYPE_MAP } from "./NodeTypes";
import {
  WorkflowSlotMappingDialog,
  workflowInputSlots,
  workflowOutputSlots,
} from "./WorkflowSlotMappingDialog";

/** Node types the palette can drag-create. A subset of all nine types. */
const CREATABLE_KINDS: ReadonlyArray<GraphNodeKind> = [
  "SoftwareUsecaseComputing",
  "Script",
  "NoAction",
  "Switch",
  "Loop",
  "Milestone",
  "SubWorkflow",
];

const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Build a minimal-but-schema-valid node body for a freshly-dropped node.
 * Placeholders (UUIDs, literal expressions) keep the round-trip schema-valid;
 * the author refines the body in the YAML pane.
 */
function makeRawNode(
  kind: GraphNodeKind,
  id: string,
  name: string,
  binding?: UsecaseNodeBinding,
  scriptBinding?: ScriptNodeBinding,
): workflowDsl.WorkflowNode {
  const common = { id, name };
  switch (kind) {
    case "SoftwareUsecaseComputing":
      return {
        ...common,
        type: "SoftwareUsecaseComputing",
        usecaseVersionId: binding?.usecaseVersionId ?? PLACEHOLDER_UUID,
        softwareVersionId: binding?.softwareVersionId ?? PLACEHOLDER_UUID,
        inputSlots: binding?.inputSlots,
        outputSlots: binding?.outputSlots,
      };
    case "Script":
      return {
        ...common,
        type: "Script",
        source: scriptBinding?.source ?? { type: "Inline", language: "python", content: "" },
        ...(scriptBinding?.runtimeContractRef
          ? { runtimeContractRef: scriptBinding.runtimeContractRef }
          : {
              runtimeProfileId: scriptBinding?.runtimeProfileId ?? PLACEHOLDER_UUID,
            }),
        executionIdentity: { type: "MappedAuto" },
        schedulingStrategy: { type: "Auto" },
        inputs: scriptBinding?.inputs ?? {},
        outputs: scriptBinding?.outputs ?? {},
        inputSlots: scriptBinding
          ? Object.entries(scriptBinding.inputs).map(([descriptor, spec]) =>
              spec.type === "File" || spec.type === "FileBatch"
                ? {
                    type: "File" as const,
                    descriptor,
                    optional: !spec.required,
                    isBatch: spec.type === "FileBatch",
                  }
                : { type: "Text" as const, descriptor, optional: !spec.required },
            )
          : undefined,
      };
    case "Milestone":
      return { ...common, type: "Milestone", url: "", customMessage: "" };
    case "Switch":
      return {
        ...common,
        type: "Switch",
        cases: [{ when: { expr: "true", lang: "cel" }, to: id }],
      };
    case "Loop":
      return {
        ...common,
        type: "Loop",
        mode: "ForEach",
        maxIterations: 1,
        over: { expr: "[]", lang: "cel" },
        body: { nodeDrafts: [], nodeRelations: [] },
      };
    case "SubWorkflow":
      return {
        ...common,
        type: "SubWorkflow",
        ref: { kind: "ByVersion", workflowVersionId: PLACEHOLDER_UUID },
        maxDepth: 1,
      };
    default:
      return { ...common, type: "NoAction" };
  }
}

export interface ReactFlowEditorProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onChange: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  onSelectionChange?: (id: string | null) => void;
  onEdgeSelectionChange?: (id: string | null) => void;
  onRequestCreate?: (request: NodeCreationRequest) => void;
  connectionAssist?: boolean;
  externalConnection?: { key: number; source: string; target: string } | null;
  onConnectionPaletteHover?: (kind: GraphNodeKind | null) => void;
  flowAnimationMode?: WorkflowFlowAnimationMode;
}

export type WorkflowFlowAnimationMode = "off" | "hover" | "click" | "always";

export interface NodeCreationRequest {
  kind: GraphNodeKind;
  position: { x: number; y: number };
  connectFrom?: string;
}

export interface UsecaseNodeBinding {
  usecaseVersionId: string;
  softwareVersionId: string;
  inputSlots?: Extract<
    workflowDsl.WorkflowNode,
    { type: "SoftwareUsecaseComputing" }
  >["inputSlots"];
  outputSlots?: Extract<
    workflowDsl.WorkflowNode,
    { type: "SoftwareUsecaseComputing" }
  >["outputSlots"];
}

type ScriptNode = Extract<workflowDsl.WorkflowNode, { type: "Script" }>;

export interface ScriptNodeBinding {
  source: Extract<ScriptNode["source"], { type: "AssetRevision" }>;
  runtimeProfileId?: string;
  runtimeContractRef?: ScriptNode["runtimeContractRef"];
  inputs: ScriptNode["inputs"];
  outputs: ScriptNode["outputs"];
}

/**
 * Generate a unique id for newly-dropped nodes. Format `<kind>_<n>` where n is
 * the next free integer suffix; this keeps ids short and human-debuggable.
 */
function nextId(kind: GraphNodeKind, existing: ReadonlyArray<GraphNode>): string {
  const used = new Set(existing.map((n) => n.id));
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${kind}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // Fallback — pathological case where 10k nodes share a kind. Time-suffix
  // guarantees uniqueness without an unbounded loop.
  return `${kind}_${Date.now()}`;
}

/**
 * Build a fresh GraphNode for a given node kind at a position. The id is
 * filled by the caller (via nextId) before insertion.
 */
export function createWorkflowNode(
  kind: GraphNodeKind,
  existing: ReadonlyArray<GraphNode>,
  position: { x: number; y: number },
  name?: string,
  binding?: UsecaseNodeBinding,
  scriptBinding?: ScriptNodeBinding,
): GraphNode {
  const id = nextId(kind, existing);
  const displayName = name ?? id;
  const raw = makeRawNode(kind, id, displayName, binding, scriptBinding);
  return {
    id,
    position,
    type: kind,
    data: {
      id,
      name: displayName,
      kind,
      raw,
    },
  };
}

export function ReactFlowEditor({
  nodes,
  edges,
  onChange,
  onSelectionChange,
  onEdgeSelectionChange,
  onRequestCreate,
  connectionAssist = false,
  externalConnection = null,
  onConnectionPaletteHover,
  flowAnimationMode = "hover",
}: ReactFlowEditorProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [pendingRelation, setPendingRelation] = useState<{
    source: string;
    target: string;
    edge: GraphEdge | null;
    initialMappings: NonNullable<GraphEdge["slotRelations"]>;
  } | null>(null);
  const [activeConnection, setActiveConnection] = useState<{
    handleType: "source" | "target";
    nodeId: string;
    slotType: "Dataset" | "File" | "Text" | null;
  } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const handledExternalConnectionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!externalConnection || handledExternalConnectionRef.current === externalConnection.key) {
      return;
    }
    handledExternalConnectionRef.current = externalConnection.key;
    setPendingRelation({
      source: externalConnection.source,
      target: externalConnection.target,
      edge: null,
      initialMappings: [],
    });
  }, [externalConnection]);

  // React Flow's `Node<T>` constrains `T` to `Record<string, unknown>`, but
  // our `GraphNodeData` is a closed-shape interface. We bridge the two with a
  // single untyped cast at the boundary — every value that crosses still has
  // the full graph shape; we just don't pay TypeScript to re-verify it for
  // every React Flow internal helper.
  const activeVisualNodeIds = useMemo(() => {
    const active = new Set<string>();
    const addEdgeNodes = (edgeId: string | null) => {
      if (!edgeId) return;
      const edge = edges.find((candidate) => candidate.id === edgeId);
      if (!edge) return;
      active.add(edge.source);
      active.add(edge.target);
    };
    if (flowAnimationMode === "always" && !focusedNodeId && !focusedEdgeId) {
      for (const node of nodes) active.add(node.id);
      return active;
    }
    if (flowAnimationMode === "hover") {
      if (hoveredNodeId) active.add(hoveredNodeId);
      addEdgeNodes(hoveredEdgeId);
      return active;
    }
    if (flowAnimationMode === "click" || flowAnimationMode === "always") {
      if (focusedNodeId) active.add(focusedNodeId);
      addEdgeNodes(focusedEdgeId);
    }
    return active;
  }, [edges, flowAnimationMode, focusedEdgeId, focusedNodeId, hoveredEdgeId, hoveredNodeId, nodes]);
  const rfNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        selected: activeVisualNodeIds.has(node.id),
      })) as unknown as Node[],
    [activeVisualNodeIds, nodes],
  );
  const expandedEdgeIds = useMemo(
    () =>
      new Set(
        connectionAssist && hoveredNodeId
          ? edges
              .filter(
                (edge) =>
                  (edge.source === hoveredNodeId || edge.target === hoveredNodeId) &&
                  (edge.slotRelations?.length ?? 0) > 0,
              )
              .map((edge) => edge.id)
          : [],
      ),
    [connectionAssist, edges, hoveredNodeId],
  );
  const revealedSlots = useMemo(() => {
    const revealedInputs: Record<string, string[]> = {};
    const revealedOutputs: Record<string, string[]> = {};
    for (const edge of edges) {
      if (!expandedEdgeIds.has(edge.id)) continue;
      for (const relation of edge.slotRelations ?? []) {
        revealedOutputs[edge.source] = [
          ...new Set([...(revealedOutputs[edge.source] ?? []), relation.fromSlot]),
        ];
        revealedInputs[edge.target] = [
          ...new Set([...(revealedInputs[edge.target] ?? []), relation.toSlot]),
        ];
      }
    }
    return { revealedInputs, revealedOutputs };
  }, [edges, expandedEdgeIds]);
  const rfEdges = useMemo<Edge<WorkflowEdgeVisualData>[]>(() => {
    function animationActive(edge: GraphEdge): boolean {
      if (flowAnimationMode === "off") return false;
      if (flowAnimationMode === "always" && !focusedNodeId && !focusedEdgeId) return true;
      if (flowAnimationMode === "hover") {
        return (
          hoveredEdgeId === edge.id ||
          hoveredNodeId === edge.source ||
          hoveredNodeId === edge.target
        );
      }
      return (
        focusedEdgeId === edge.id || focusedNodeId === edge.source || focusedNodeId === edge.target
      );
    }

    return edges.flatMap((edge) => {
      const active = animationActive(edge);
      const base: Edge<WorkflowEdgeVisualData> = {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "flow",
        data: {
          active,
          hidden: expandedEdgeIds.has(edge.id),
          logicalEdgeId: edge.id,
          mapped: false,
        },
      };
      if (!expandedEdgeIds.has(edge.id)) return [base];
      return [
        base,
        ...(edge.slotRelations ?? []).map((relation, index) => ({
          id: `${edge.id}::${index}:${relation.fromSlot}->${relation.toSlot}`,
          source: edge.source,
          target: edge.target,
          sourceHandle: `output:${relation.fromSlot}`,
          targetHandle: `input:${relation.toSlot}`,
          type: "flow",
          data: {
            active: true,
            hidden: false,
            logicalEdgeId: edge.id,
            mapped: true,
          },
        })),
      ];
    });
  }, [
    edges,
    expandedEdgeIds,
    flowAnimationMode,
    focusedEdgeId,
    focusedNodeId,
    hoveredEdgeId,
    hoveredNodeId,
  ]);

  const nodeTypes = useMemo(() => NODE_TYPE_MAP, []);
  const edgeTypes = useMemo(() => EDGE_TYPE_MAP, []);

  useEffect(() => {
    if (activeConnection?.handleType !== "source" || !onConnectionPaletteHover) return;
    const updateTarget = (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY);
      const kind = target?.closest<HTMLElement>("[data-node-kind]")?.dataset.nodeKind as
        | GraphNodeKind
        | undefined;
      onConnectionPaletteHover(kind && CREATABLE_KINDS.includes(kind) ? kind : null);
    };
    const handlePointerMove = (event: PointerEvent) => updateTarget(event.clientX, event.clientY);
    document.addEventListener("pointermove", handlePointerMove);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      onConnectionPaletteHover(null);
    };
  }, [activeConnection?.handleType, onConnectionPaletteHover]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      const next = applyNodeChanges<Node>(changes, rfNodes);
      onChange(next as unknown as GraphNode[], edges);
    },
    [rfNodes, edges, onChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const removed = new Set(
        changes
          .filter((change) => change.type === "remove")
          .map((change) => {
            const visual = rfEdges.find((edge) => edge.id === change.id);
            return visual?.data?.logicalEdgeId ?? change.id;
          }),
      );
      if (removed.size > 0)
        onChange(
          nodes,
          edges.filter((edge) => !removed.has(edge.id)),
        );
    },
    [edges, rfEdges, nodes, onChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const fromSlot = connection.sourceHandle?.startsWith("output:")
        ? connection.sourceHandle.slice("output:".length)
        : null;
      const toSlot = connection.targetHandle?.startsWith("input:")
        ? connection.targetHandle.slice("input:".length)
        : null;

      if (fromSlot && toSlot) {
        const matchingEdges = edges.filter(
          (edge) => edge.source === connection.source && edge.target === connection.target,
        );
        const directMapping: NonNullable<GraphEdge["slotRelations"]>[number] = {
          fromSlot,
          toSlot,
          transferStrategy: { type: "Network" },
        };
        const mappings = [
          ...matchingEdges.flatMap((edge) => edge.slotRelations ?? []),
          directMapping,
        ];
        const uniqueMappings = Array.from(
          new Map(
            mappings.map((mapping) => [`${mapping.fromSlot}\u0000${mapping.toSlot}`, mapping]),
          ).values(),
        );
        const existing = matchingEdges[0];
        const nextEdge: GraphEdge = {
          id: existing?.id ?? `${connection.source}->${connection.target}`,
          source: connection.source,
          target: connection.target,
          when: existing?.when,
          slotRelations: uniqueMappings,
        };
        onChange(nodes, [
          ...edges.filter(
            (edge) => edge.source !== connection.source || edge.target !== connection.target,
          ),
          nextEdge,
        ]);
        return;
      }

      setPendingRelation({
        source: connection.source,
        target: connection.target,
        edge: null,
        initialMappings: [],
      });
    },
    [edges, nodes, onChange],
  );

  const onConnectStart = useCallback<OnConnectStart>(
    (_event, params) => {
      if (!params.nodeId || !params.handleType) return;
      const node = nodes.find((candidate) => candidate.id === params.nodeId);
      const descriptor = params.handleId?.split(":").slice(1).join(":") ?? "";
      const slots =
        params.handleType === "source"
          ? node
            ? workflowOutputSlots(node)
            : []
          : node
            ? workflowInputSlots(node)
            : [];
      setActiveConnection({
        handleType: params.handleType,
        nodeId: params.nodeId,
        slotType: slots.find((slot) => slot.descriptor === descriptor)?.type ?? null,
      });
    },
    [nodes],
  );

  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      setActiveConnection(null);
      onConnectionPaletteHover?.(null);
      if (
        connectionState.isValid ||
        connectionState.fromHandle?.type !== "source" ||
        !onRequestCreate
      ) {
        return;
      }
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const target = document.elementFromPoint(point.clientX, point.clientY);
      const paletteButton = target?.closest<HTMLElement>("[data-node-kind]");
      const kind = paletteButton?.dataset.nodeKind as GraphNodeKind | undefined;
      if (!kind || !CREATABLE_KINDS.includes(kind)) return;
      const sourceNode = nodes.find((node) => node.id === connectionState.fromNode?.id);
      onRequestCreate({
        kind,
        connectFrom: connectionState.fromNode?.id,
        position: {
          x: (sourceNode?.position.x ?? 0) + 300,
          y: sourceNode?.position.y ?? 0,
        },
      });
    },
    [nodes, onConnectionPaletteHover, onRequestCreate],
  );

  const onEdgeDoubleClick = useCallback<EdgeMouseHandler<Edge>>(
    (_event, edge) => {
      const logicalEdgeId = (edge.data as WorkflowEdgeVisualData | undefined)?.logicalEdgeId;
      const graphEdge = edges.find((candidate) => candidate.id === (logicalEdgeId ?? edge.id));
      if (!graphEdge) return;
      setPendingRelation({
        source: graphEdge.source,
        target: graphEdge.target,
        edge: graphEdge,
        initialMappings: [],
      });
    },
    [edges],
  );

  function confirmRelation(slotRelations: NonNullable<GraphEdge["slotRelations"]>) {
    if (!pendingRelation) return;
    const nextEdge: GraphEdge = {
      id: pendingRelation.edge?.id ?? `${pendingRelation.source}->${pendingRelation.target}`,
      source: pendingRelation.source,
      target: pendingRelation.target,
      when: pendingRelation.edge?.when,
      slotRelations,
    };
    const nextEdges = edges.filter((edge) =>
      pendingRelation.edge
        ? edge.id !== pendingRelation.edge.id
        : edge.source !== pendingRelation.source || edge.target !== pendingRelation.target,
    );
    onChange(nodes, [...nextEdges, nextEdge]);
    setPendingRelation(null);
  }

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const kindRaw = event.dataTransfer?.getData(PALETTE_DRAG_MIME);
      if (!kindRaw) return;
      if (!CREATABLE_KINDS.includes(kindRaw as GraphNodeKind)) {
        return;
      }
      const kind = kindRaw as GraphNodeKind;
      const clientX = Number.isFinite(event.clientX) ? event.clientX : 0;
      const clientY = Number.isFinite(event.clientY) ? event.clientY : 0;
      // happy-dom doesn't always have a viewport-aware screenToFlowPosition;
      // fall back to raw client coordinates if React Flow's helper bails.
      let position: { x: number; y: number };
      try {
        position = screenToFlowPosition({ x: clientX, y: clientY });
      } catch {
        position = { x: clientX, y: clientY };
      }
      if (onRequestCreate) {
        onRequestCreate({ kind, position });
        return;
      }
      const created = createWorkflowNode(kind, nodes, position);
      onChange([...nodes, created], edges);
    },
    [nodes, edges, onChange, onRequestCreate, screenToFlowPosition],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<Node>>(
    (_e, node) => {
      setFocusedNodeId(node.id);
      setFocusedEdgeId(null);
      onSelectionChange?.(node.id);
      onEdgeSelectionChange?.(null);
    },
    [onEdgeSelectionChange, onSelectionChange],
  );

  const handleEdgeClick = useCallback<EdgeMouseHandler<Edge>>(
    (_event, edge) => {
      const logicalEdgeId =
        (edge.data as WorkflowEdgeVisualData | undefined)?.logicalEdgeId ?? edge.id;
      setFocusedNodeId(null);
      setFocusedEdgeId(logicalEdgeId);
      onSelectionChange?.(null);
      onEdgeSelectionChange?.(logicalEdgeId);
    },
    [onEdgeSelectionChange, onSelectionChange],
  );

  const handlePaneClick = useCallback(() => {
    setFocusedNodeId(null);
    setFocusedEdgeId(null);
    onSelectionChange?.(null);
    onEdgeSelectionChange?.(null);
  }, [onEdgeSelectionChange, onSelectionChange]);

  return (
    <div ref={wrapperRef} data-testid="rf-editor" className="relative h-full w-full">
      {/*
        Drop handlers live on this dropzone div instead of <ReactFlow> itself
        because React Flow's own `onDrop` requires forwarding through the
        pane; routing the event through a wrapper keeps the API simpler and
        makes happy-dom drop simulation possible without a real flow viewport.
        The `application` role tells assistive tech that this region is a
        custom interactive surface, satisfying biome's a11y rule.
      */}
      <div
        data-testid="rf-editor-dropzone"
        className="absolute inset-0"
        role="application"
        aria-label="Workflow canvas"
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <ConnectionAssistProvider
          value={{
            activeHandleType: activeConnection?.handleType ?? null,
            activeNodeId: activeConnection?.nodeId ?? null,
            activeSlotType: activeConnection?.slotType ?? null,
            enabled: connectionAssist,
            revealedInputs: revealedSlots.revealedInputs,
            revealedOutputs: revealedSlots.revealedOutputs,
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            autoPanOnConnect={false}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onEdgeClick={handleEdgeClick}
            onEdgeMouseEnter={(_event, edge) =>
              setHoveredEdgeId(
                (edge.data as WorkflowEdgeVisualData | undefined)?.logicalEdgeId ?? edge.id,
              )
            }
            onEdgeMouseLeave={() => setHoveredEdgeId(null)}
            onNodeClick={handleNodeClick}
            onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
            onNodeMouseLeave={() => setHoveredNodeId(null)}
            onPaneClick={handlePaneClick}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
            <MiniMap
              className="hidden !h-28 !w-36 rounded-lg border border-border bg-card/90 shadow-sm xl:block"
              pannable
              zoomable
            />
          </ReactFlow>
        </ConnectionAssistProvider>
      </div>
      <WorkflowSlotMappingDialog
        edge={pendingRelation?.edge ?? null}
        initialMappings={pendingRelation?.initialMappings}
        onConfirm={confirmRelation}
        onOpenChange={(open) => {
          if (!open) setPendingRelation(null);
        }}
        open={pendingRelation !== null}
        source={nodes.find((node) => node.id === pendingRelation?.source) ?? null}
        target={nodes.find((node) => node.id === pendingRelation?.target) ?? null}
      />
    </div>
  );
}
