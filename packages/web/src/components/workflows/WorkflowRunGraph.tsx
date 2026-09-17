/**
 * Read-only React Flow view of a workflow run's persisted node/edge graph,
 * colored by each node's live status. Nodes cannot be dragged or connected,
 * and the view does not expose an onChange handler.
 */

import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type CSSProperties, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { statusToBadgeVariant } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useTheme } from "../ThemeProvider";
import { Badge } from "../ui/badge";

export interface WorkflowRunGraphProps {
  graph: {
    nodes: { id: string; name: string; kind: string }[];
    edges: { source: string; target: string; when?: string }[];
  };
  statusByNode: Record<string, string>;
}

interface RunNodeData extends Record<string, unknown> {
  nodeId: string;
  label: string;
  kind: string;
  status: string;
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 76;

/** Tailwind/CSS-var class for each normalized status. */
const STATUS_CLASS: Record<string, string> = {
  succeeded:
    "border-[var(--status-succeeded)] bg-[color-mix(in_oklab,var(--status-succeeded)_8%,var(--card))] text-[var(--status-succeeded)]",
  running:
    "border-[var(--status-running)] bg-[color-mix(in_oklab,var(--status-running)_8%,var(--card))] text-[var(--status-running)]",
  failed:
    "border-[var(--status-failed)] bg-[color-mix(in_oklab,var(--status-failed)_8%,var(--card))] text-[var(--status-failed)]",
  cancelled:
    "border-[var(--status-cancelled)] bg-[color-mix(in_oklab,var(--status-cancelled)_8%,var(--card))] text-muted-foreground",
  pending: "border-border bg-card text-muted-foreground",
};

function normalizeStatus(status: string): keyof typeof STATUS_CLASS {
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "completed" || s === "done") return "succeeded";
  if (s === "running" || s === "starting") return "running";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled" || s === "skipped" || s === "stopped") {
    return "cancelled";
  }
  return "pending";
}

function edgeColor(source: string, target: string): string {
  const sourceStatus = normalizeStatus(source);
  const targetStatus = normalizeStatus(target);
  if (sourceStatus === "failed" || targetStatus === "failed") return "var(--status-failed)";
  if (sourceStatus === "succeeded" && targetStatus === "succeeded") {
    return "var(--status-succeeded)";
  }
  if (
    (sourceStatus === "running" && targetStatus === "succeeded") ||
    (sourceStatus === "succeeded" && targetStatus === "running") ||
    (sourceStatus === "running" && targetStatus === "running")
  ) {
    return "var(--status-running)";
  }
  return "var(--status-pending)";
}

function RunNode({ data }: { data: RunNodeData }) {
  const { t } = useTranslation();
  const variant = normalizeStatus(data.status);
  return (
    <div
      data-testid={`run-node-${data.nodeId}`}
      data-status={data.status}
      className={cn(
        "relative flex flex-col gap-1 rounded-lg border-2 p-2.5 shadow-sm",
        STATUS_CLASS[variant],
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"
      />
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
        <span className="truncate">{data.label}</span>
        <Badge variant={statusToBadgeVariant(variant)} className="shrink-0 text-[10px]">
          {t(`workflows.run.status.${variant}`, { defaultValue: data.status })}
        </Badge>
      </div>
      <div className="truncate text-[10px] text-muted-foreground">
        {t(`workflow.editor.nodeTypes.${data.kind}`, { defaultValue: data.kind })}
      </div>
      <div className="font-mono text-[10px] text-muted-foreground truncate">{data.nodeId}</div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}

const NODE_TYPES = { run: RunNode };

function layout(graph: WorkflowRunGraphProps["graph"]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", marginx: 24, marginy: 24, nodesep: 30, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const laid = g.node(node.id);
    positions.set(node.id, {
      x: (laid?.x ?? 0) - NODE_WIDTH / 2,
      y: (laid?.y ?? 0) - NODE_HEIGHT / 2,
    });
  }
  return positions;
}

export function WorkflowRunGraph({ graph, statusByNode }: WorkflowRunGraphProps) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  const rfNodes = useMemo<Node<RunNodeData>[]>(() => {
    const positions = layout(graph);
    return graph.nodes.map((node) => ({
      id: node.id,
      type: "run",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        nodeId: node.id,
        label: node.name,
        kind: node.kind,
        status: statusByNode[node.id] ?? "Pending",
      },
    }));
  }, [graph, statusByNode]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const sourceStatus = statusByNode[edge.source] ?? "Pending";
        const targetStatus = statusByNode[edge.target] ?? "Pending";
        const color = edgeColor(sourceStatus, targetStatus);
        return {
          id: `${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
          label: edge.when,
          animated: normalizeStatus(targetStatus) === "running",
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: { stroke: color, transition: "stroke 150ms ease-out" },
        };
      }),
    [graph.edges, statusByNode],
  );

  const wrapStyle: CSSProperties = {
    height: "62vh",
    background: isDark ? "var(--muted)" : "color-mix(in oklab, var(--muted) 35%, transparent)",
  };

  return (
    <div
      className="overflow-hidden rounded-xl border border-border"
      style={wrapStyle}
      data-testid="run-graph-wrap"
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        proOptions={{ hideAttribution: true }}
        fitViewOptions={{ maxZoom: 1 }}
        data-testid="run-graph"
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
