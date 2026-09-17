/**
 * Edge renderer — a single bezier "flow" edge. Node relations are plain
 * directed edges (`fromId` → `toId`); branch semantics live in CEL `when`
 * guards on the relation, not in distinct edge colors, so one renderer covers
 * every relation.
 */

import { type Edge, type EdgeProps, getBezierPath } from "@xyflow/react";
import { memo } from "react";

export interface WorkflowEdgeVisualData extends Record<string, unknown> {
  active: boolean;
  hidden: boolean;
  logicalEdgeId: string;
  mapped: boolean;
}

type WorkflowVisualEdge = Edge<WorkflowEdgeVisualData>;

function FlowEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<WorkflowVisualEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const active = data?.active ?? false;
  const hidden = data?.hidden ?? false;
  return (
    <g
      data-testid={`rf-edge-flow-${id}`}
      className="transition-opacity duration-150 ease-out"
      style={{ opacity: hidden ? 0 : 1, pointerEvents: hidden ? "none" : "auto" }}
    >
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
      <path
        id={id}
        d={path}
        className="react-flow__edge-path transition-[stroke,opacity,filter] duration-150"
        style={{
          filter: active
            ? "drop-shadow(0 0 3px color-mix(in oklab, var(--brand) 55%, transparent))"
            : undefined,
          stroke: active ? "var(--brand)" : "var(--muted-foreground)",
        }}
        strokeWidth={active ? 2 : 1.5}
        strokeDasharray={active ? "8 6" : undefined}
        fill="none"
        markerEnd={markerEnd}
      >
        {active ? (
          <animate
            attributeName="stroke-dashoffset"
            from="28"
            to="0"
            dur="0.65s"
            repeatCount="indefinite"
          />
        ) : null}
      </path>
    </g>
  );
}

export const FlowEdge = memo(FlowEdgeImpl);

export const EDGE_TYPE_MAP = {
  flow: FlowEdge,
} as const;
