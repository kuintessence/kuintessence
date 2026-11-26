import { Link } from "@tanstack/react-router";
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
  type NodeProps,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type CSSProperties, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { statusLabel, statusToBadgeVariant } from "../../lib/format";
import { useCompactLayout } from "../../lib/use-compact-layout";
import { cn } from "../../lib/utils";
import { useTheme } from "../ThemeProvider";
import { Badge } from "../ui/badge";

export interface WorkflowRunGraphProps {
  graph: {
    nodes: { id: string; name: string; kind: string }[];
    edges: { source: string; target: string; when?: string }[];
  };
  statusByNode: Record<string, string>;
  missingNodeStatus?: "Pending" | "Unknown";
  jobIdsByNode?: Record<string, string>;
}

interface RunNodeData extends Record<string, unknown> {
  nodeId: string;
  jobId?: string;
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

function RunNode({ data, sourcePosition, targetPosition }: NodeProps<Node<RunNodeData>>) {
  const { t, i18n } = useTranslation();
  const variant = normalizeStatus(data.status);
  return (
    <div
      data-testid={`run-node-${data.nodeId}`}
      data-status={data.status}
      className={cn("relative flex flex-col gap-1 p-2.5 ", STATUS_CLASS[variant])}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle
        type="target"
        position={targetPosition ?? Position.Left}
        isConnectable={false}
        className="pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"
      />
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-foreground">
        {data.jobId ? (
          <Link
            to="/jobs/$jobId"
            params={{ jobId: data.jobId }}
            className="nodrag nopan min-w-0 truncate text-brand underline decoration-brand/40 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
            title={data.label}
            data-testid={`run-node-job-${data.nodeId}`}
          >
            {data.label}
          </Link>
        ) : (
          <span className="truncate" title={data.label}>
            {data.label}
          </span>
        )}
        <Badge variant={statusToBadgeVariant(variant)} className="shrink-0 text-[10px]">
          {statusLabel(data.status, i18n.resolvedLanguage ?? i18n.language)}
        </Badge>
      </div>
      <div className="truncate text-[10px] text-muted-foreground">
        {t(`workflow.editor.nodeTypes.${data.kind}`, { defaultValue: data.kind })}
      </div>
      <div className="font-mono text-[10px] text-muted-foreground truncate">{data.nodeId}</div>
      <Handle
        type="source"
        position={sourcePosition ?? Position.Right}
        isConnectable={false}
        className="pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}

const NODE_TYPES = { run: RunNode };

function layout(
  graph: WorkflowRunGraphProps["graph"],
  compact: boolean,
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: compact ? "TB" : "LR",
    marginx: 24,
    marginy: 24,
    nodesep: 30,
    ranksep: 80,
  });
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

function FitRunGraphOnResize({ compact }: { compact: boolean }) {
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!width || !height) return;
    const timer = window.setTimeout(() => {
      void fitView({ maxZoom: 1, padding: compact ? "8px" : 0.1 });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [width, height, compact, fitView]);

  return null;
}

export function WorkflowRunGraph({
  graph,
  statusByNode,
  jobIdsByNode,
  missingNodeStatus = "Pending",
}: WorkflowRunGraphProps) {
  const { resolved } = useTheme();
  const [measure, compact] = useCompactLayout(704);
  const isDark = resolved === "dark";

  const rfNodes = useMemo<Node<RunNodeData>[]>(() => {
    const positions = layout(graph, compact);
    return graph.nodes.map((node) => ({
      id: node.id,
      type: "run",
      sourcePosition: compact ? Position.Bottom : Position.Right,
      targetPosition: compact ? Position.Top : Position.Left,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        nodeId: node.id,
        jobId: jobIdsByNode?.[node.id],
        label: node.name,
        kind: node.kind,
        status: statusByNode[node.id] ?? missingNodeStatus,
      },
    }));
  }, [graph, statusByNode, jobIdsByNode, compact, missingNodeStatus]);

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
      ref={measure}
      className="overflow-hidden border-border"
      style={wrapStyle}
      data-testid="run-graph-wrap"
    >
      <ReactFlow
        key={compact ? "vertical" : "horizontal"}
        colorMode={resolved}
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        proOptions={{ hideAttribution: true }}
        fitViewOptions={{ maxZoom: 1, padding: compact ? "8px" : 0.1 }}
        data-testid="run-graph"
      >
        <FitRunGraphOnResize compact={compact} />
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
