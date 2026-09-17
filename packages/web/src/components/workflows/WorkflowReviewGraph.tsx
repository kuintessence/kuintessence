import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { yamlToGraph } from "../../lib/yaml-graph-sync";

const NODE_WIDTH = 198;
const NODE_HEIGHT = 69;
const PADDING = 24;

export function WorkflowReviewGraph({
  yaml,
  selectedNodeId,
  onNodeSelect,
  mode = "compact",
}: {
  yaml: string;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  mode?: "compact" | "fill" | "resizable";
}) {
  const { t } = useTranslation();
  const parsed = useMemo(() => yamlToGraph(yaml), [yaml]);
  if (!parsed.ok || parsed.graph.nodes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t("workflows.creation.review.graphEmpty")}
      </div>
    );
  }

  const nodes = parsed.graph.nodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const width = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH)) + PADDING * 2;
  const height = Math.max(...nodes.map((node) => node.position.y + NODE_HEIGHT)) + PADDING * 2;

  return (
    <div
      className={`flex justify-center rounded-lg border border-border bg-muted/20 ${
        mode === "fill"
          ? "h-full min-h-96 overflow-hidden"
          : mode === "resizable"
            ? "h-64 min-h-52 max-h-[70vh] resize-y overflow-hidden"
            : "h-56 overflow-hidden"
      }`}
      data-testid="workflow-review-graph"
    >
      <svg
        aria-label={t("workflows.creation.review.graphTitle")}
        className="block h-full max-w-full"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={`0 0 ${width} ${Math.max(height, 176)}`}
        width={width}
      >
        <defs>
          <marker
            id="review-arrow"
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="7"
            refY="4"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="fill-brand" />
          </marker>
        </defs>
        {parsed.graph.edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const x1 = source.position.x + PADDING + NODE_WIDTH;
          const y1 = source.position.y + PADDING + NODE_HEIGHT / 2;
          const x2 = target.position.x + PADDING;
          const y2 = target.position.y + PADDING + NODE_HEIGHT / 2;
          const curve = Math.max(40, Math.abs(x2 - x1) / 2);
          return (
            <path
              key={edge.id}
              d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
              className="fill-none stroke-brand"
              markerEnd="url(#review-arrow)"
              strokeWidth="1.5"
            />
          );
        })}
        {nodes.map((node) => {
          const x = node.position.x + PADDING;
          const y = node.position.y + PADDING;
          return (
            <g key={node.id} data-testid={`workflow-review-node-${node.id}`}>
              <rect
                x={x}
                y={y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx="8"
                className={
                  selectedNodeId === node.id
                    ? "fill-brand-soft stroke-brand"
                    : "fill-card stroke-border"
                }
                strokeWidth={selectedNodeId === node.id ? "2" : "1.5"}
              />
              <text x={x + 12} y={y + 23} className="fill-foreground text-[11px] font-semibold">
                {node.data.name.slice(0, 22)}
              </text>
              <text x={x + 12} y={y + 43} className="fill-muted-foreground text-[10px]">
                {t(`workflow.editor.nodeTypes.${node.data.kind}`, {
                  defaultValue: node.data.kind,
                })}
              </text>
              <text x={x + 12} y={y + 59} className="fill-muted-foreground font-mono text-[9px]">
                {node.id.slice(0, 28)}
              </text>
              {onNodeSelect ? (
                <foreignObject x={x} y={y} width={NODE_WIDTH} height={NODE_HEIGHT}>
                  <button
                    type="button"
                    className="h-full w-full cursor-pointer rounded-lg bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    aria-label={t("workflows.creation.resources.selectNode", {
                      name: node.data.name,
                    })}
                    onClick={() => onNodeSelect(node.id)}
                  />
                </foreignObject>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
