/**
 * Custom React Flow node renderers for the workflow node types.
 *
 * The nine node types share a single `NodeShell` driven by a per-type descriptor
 * table (icon, border accent, badge, one-line detail extractor). This keeps the canvas
 * scannable — a user can tell a Loop from a Switch from a usecase-compute node
 * at a glance — without nine near-identical components.
 */

import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import {
  Box,
  Flag,
  GitBranch,
  Layers,
  type LucideIcon,
  Network,
  Repeat,
  Sigma,
  Terminal,
  Wand2,
} from "lucide-react";
import { createContext, memo, type ReactNode, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import type { GraphNodeData, GraphNodeKind } from "../../lib/yaml-graph-sync";
import { workflowInputSlots, workflowOutputSlots } from "./WorkflowSlotMappingDialog";

export interface NodeRenderProps {
  data: GraphNodeData;
  selected?: boolean;
}

const baseClasses =
  "group relative min-w-[200px] max-w-[260px] rounded-md border bg-card p-3 shadow-sm transition-shadow";

interface ConnectionAssistState {
  activeHandleType: "source" | "target" | null;
  activeNodeId: string | null;
  activeSlotType: "Dataset" | "File" | "Text" | null;
  enabled: boolean;
  revealedInputs: Record<string, string[]>;
  revealedOutputs: Record<string, string[]>;
}

const ConnectionAssistContext = createContext<ConnectionAssistState>({
  activeHandleType: null,
  activeNodeId: null,
  activeSlotType: null,
  enabled: false,
  revealedInputs: {},
  revealedOutputs: {},
});

export function ConnectionAssistProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ConnectionAssistState;
}) {
  return (
    <ConnectionAssistContext.Provider value={value}>{children}</ConnectionAssistContext.Provider>
  );
}

interface NodeDescriptor {
  icon: LucideIcon;
  iconClass: string;
  borderClass: string;
  badgeKey: string;
}

function whenDetail(data: GraphNodeData): string | undefined {
  return data.when ? `when: ${data.when.expr}` : undefined;
}

const DESCRIPTORS: Record<GraphNodeKind, NodeDescriptor> = {
  SoftwareUsecaseComputing: {
    icon: Terminal,
    iconClass: "text-muted-foreground",
    borderClass: "border-border",
    badgeKey: "SoftwareUsecaseComputing",
  },
  Script: {
    icon: Terminal,
    iconClass: "text-muted-foreground",
    borderClass: "border-border",
    badgeKey: "Script",
  },
  NoAction: {
    icon: Box,
    iconClass: "text-muted-foreground",
    borderClass: "border-dashed border-border",
    badgeKey: "NoAction",
  },
  Milestone: {
    icon: Flag,
    iconClass: "text-emerald-500",
    borderClass: "border-emerald-500/60",
    badgeKey: "Milestone",
  },
  Generate: {
    icon: Wand2,
    iconClass: "text-amber-500",
    borderClass: "border-dashed border-amber-500/60",
    badgeKey: "Generate",
  },
  Loop: {
    icon: Repeat,
    iconClass: "text-sky-500",
    borderClass: "border-2 border-sky-500/60",
    badgeKey: "Loop",
  },
  Reduce: {
    icon: Sigma,
    iconClass: "text-sky-500",
    borderClass: "border-sky-500/60",
    badgeKey: "Reduce",
  },
  Switch: {
    icon: GitBranch,
    iconClass: "text-sky-500",
    borderClass: "border-2 border-sky-500/60",
    badgeKey: "Switch",
  },
  SubWorkflow: {
    icon: Network,
    iconClass: "text-violet-500",
    borderClass: "border-violet-500/60 bg-violet-500/5",
    badgeKey: "SubWorkflow",
  },
};

function NodeShell({ data, selected }: NodeRenderProps) {
  const { t } = useTranslation();
  const connectionAssist = useContext(ConnectionAssistContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const measuredLayout = useRef("");
  const desc = DESCRIPTORS[data.kind] ?? {
    icon: Layers,
    iconClass: "text-muted-foreground",
    borderClass: "border-border",
    badgeKey: data.kind,
  };
  const Icon = desc.icon;
  const detail = nodeDetail(data, t);
  const graphNode = { id: data.id, data, position: { x: 0, y: 0 }, type: data.kind };
  const allInputs = workflowInputSlots(graphNode);
  const allOutputs = workflowOutputSlots(graphNode);
  const inputs = allInputs.filter(
    (slot) => !connectionAssist.activeSlotType || slot.type === connectionAssist.activeSlotType,
  );
  const outputs = allOutputs.filter(
    (slot) => !connectionAssist.activeSlotType || slot.type === connectionAssist.activeSlotType,
  );
  const showInputSlots =
    connectionAssist.enabled &&
    (connectionAssist.activeHandleType !== "target" || connectionAssist.activeNodeId === data.id) &&
    inputs.length > 0;
  const showOutputSlots =
    connectionAssist.enabled &&
    (connectionAssist.activeHandleType !== "source" || connectionAssist.activeNodeId === data.id) &&
    outputs.length > 0;
  const keepInputSlotsVisible =
    connectionAssist.activeHandleType === "source" ||
    (connectionAssist.activeHandleType === "target" && connectionAssist.activeNodeId === data.id) ||
    (connectionAssist.revealedInputs[data.id]?.length ?? 0) > 0;
  const keepOutputSlotsVisible =
    connectionAssist.activeHandleType === "target" ||
    (connectionAssist.activeHandleType === "source" && connectionAssist.activeNodeId === data.id) ||
    (connectionAssist.revealedOutputs[data.id]?.length ?? 0) > 0;
  const connectionHandleLayout = [
    data.id,
    showInputSlots ? inputs.map((slot) => slot.descriptor).join(",") : "",
    showOutputSlots ? outputs.map((slot) => slot.descriptor).join(",") : "",
  ].join("|");

  useEffect(() => {
    if (measuredLayout.current === connectionHandleLayout) return;
    measuredLayout.current = connectionHandleLayout;
    updateNodeInternals(data.id);
  }, [connectionHandleLayout, data.id, updateNodeInternals]);

  function slotOffset(index: number, count: number): number {
    return (index - (count - 1) / 2) * 42;
  }

  return (
    <div
      data-testid={`rf-node-${data.kind}-${data.id}`}
      data-selected={selected ? "true" : "false"}
      className={cn(
        baseClasses,
        desc.borderClass,
        selected ? "ring-2 ring-ring shadow-md" : "hover:shadow-md",
      )}
    >
      <Handle
        id="input"
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !bg-muted-foreground"
      />
      {showInputSlots
        ? inputs.map((slot) => {
            const revealed = connectionAssist.revealedInputs[data.id]?.includes(slot.descriptor);
            return (
              <div
                key={slot.descriptor}
                className={cn(
                  "pointer-events-auto absolute right-full z-20 mr-3 flex min-w-max items-center whitespace-nowrap rounded-md border border-brand/30 bg-popover px-2.5 py-1.5 text-[10px] text-popover-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100",
                  (keepInputSlotsVisible || revealed) && "opacity-100",
                  revealed && "border-brand/60 bg-brand-soft/90",
                )}
                style={{
                  top: "50%",
                  transform: `translateY(calc(-50% + ${slotOffset(
                    allInputs.findIndex((candidate) => candidate.descriptor === slot.descriptor),
                    allInputs.length,
                  )}px))`,
                }}
              >
                <Handle
                  id={`input:${slot.descriptor}`}
                  type="target"
                  position={Position.Left}
                  isConnectable
                  className="!pointer-events-auto !-left-1.5 !z-30 !h-3.5 !w-3.5 !border-2 !border-background !bg-brand"
                />
                <span className="pointer-events-none">
                  {slot.descriptor} · {slot.type}
                </span>
              </div>
            );
          })
        : null}
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        <span className="flex items-center gap-1 truncate">
          <Icon className={cn("h-3 w-3", desc.iconClass)} aria-hidden="true" />
          <span className="truncate">{data.name}</span>
        </span>
        <span className="text-[10px] text-muted-foreground">
          {t(`workflow.editor.nodeTypes.${desc.badgeKey}`, { defaultValue: desc.badgeKey })}
        </span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground truncate">{data.id}</div>
      {detail ? (
        <div
          className="mt-1 text-[11px] text-muted-foreground line-clamp-2"
          data-testid={`rf-node-${data.kind}-${data.id}-detail`}
        >
          {detail}
        </div>
      ) : null}
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !bg-muted-foreground"
      />
      {showOutputSlots
        ? outputs.map((slot) => {
            const revealed = connectionAssist.revealedOutputs[data.id]?.includes(slot.descriptor);
            return (
              <div
                key={slot.descriptor}
                className={cn(
                  "pointer-events-auto absolute left-full z-20 ml-3 flex min-w-max items-center whitespace-nowrap rounded-md border border-brand/30 bg-popover px-2.5 py-1.5 text-[10px] text-popover-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100",
                  (keepOutputSlotsVisible || revealed) && "opacity-100",
                  revealed && "border-brand/60 bg-brand-soft/90",
                )}
                style={{
                  top: "50%",
                  transform: `translateY(calc(-50% + ${slotOffset(
                    allOutputs.findIndex((candidate) => candidate.descriptor === slot.descriptor),
                    allOutputs.length,
                  )}px))`,
                }}
              >
                <span className="pointer-events-none">
                  {slot.descriptor} · {slot.type}
                </span>
                <Handle
                  id={`output:${slot.descriptor}`}
                  type="source"
                  position={Position.Right}
                  isConnectable
                  className="!pointer-events-auto !-right-1.5 !z-30 !h-3.5 !w-3.5 !border-2 !border-background !bg-brand"
                />
              </div>
            );
          })
        : null}
    </div>
  );
}

function nodeDetail(
  data: GraphNodeData,
  t: ReturnType<typeof useTranslation>["t"],
): string | undefined {
  const raw = data.raw;
  if (raw.type === "SoftwareUsecaseComputing") {
    const usecaseReference = raw.usecaseVersionId ?? raw.usecaseRef?.name;
    if (!usecaseReference) return undefined;
    return t("workflow.editor.nodeDetails.usecaseVersion", {
      id: `${usecaseReference.slice(0, 8)}…`,
    });
  }
  if (raw.type === "Script") {
    const source = raw.source;
    if (!source) return raw.scriptRef?.name;
    return source.type === "Inline"
      ? t("workflow.editor.nodeDetails.inlineScript", { language: source.language })
      : t("workflow.editor.nodeDetails.assetScript", { revision: source.revision });
  }
  if (raw.type === "Loop") {
    return t("workflow.editor.nodeDetails.loopMode", { mode: raw.mode });
  }
  if (raw.type === "Switch") {
    return t("workflow.editor.nodeDetails.switchCases", { count: raw.cases.length });
  }
  if (raw.type === "SubWorkflow") {
    return t("workflow.editor.nodeDetails.subWorkflowRef", { kind: raw.ref.kind });
  }
  if (raw.type === "Milestone") return raw.customMessage;
  return whenDetail(data);
}

const NodeComponent = memo(NodeShell);

/**
 * Type map consumed by `<ReactFlow nodeTypes={…}>`. The keys MUST match the
 * `node.type` strings emitted by yamlToGraph. Every type maps to the same
 * shell renderer (differentiated by the descriptor table above).
 */
export const NODE_TYPE_MAP: Record<GraphNodeKind, typeof NodeComponent> = {
  SoftwareUsecaseComputing: NodeComponent,
  Script: NodeComponent,
  NoAction: NodeComponent,
  Milestone: NodeComponent,
  Generate: NodeComponent,
  Loop: NodeComponent,
  Reduce: NodeComponent,
  Switch: NodeComponent,
  SubWorkflow: NodeComponent,
};
