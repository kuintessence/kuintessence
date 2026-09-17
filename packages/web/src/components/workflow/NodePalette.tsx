/**
 * Sidebar palette listing a curated subset of workflow node types. Drag an item onto
 * the React Flow canvas to add a node — the canvas reads
 * `application/x-kuintessence-node-kind` from the dataTransfer payload to know
 * which type to instantiate.
 *
 * Scope note: not every node type is offered here. Types that are only
 * meaningful with upstream wiring (Generate / Reduce) are authored in the YAML
 * pane; the palette covers the common authoring entry points.
 */

import {
  Box,
  Flag,
  GitBranch,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Repeat,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GraphNodeKind } from "../../lib/yaml-graph-sync";
import { Button } from "../ui/button";

export const PALETTE_DRAG_MIME = "application/x-kuintessence-node-kind";

interface PaletteItem {
  kind: GraphNodeKind;
  labelKey: string;
  hintKey: string;
  icon: ReactNode;
}

const ITEMS: PaletteItem[] = [
  {
    kind: "SoftwareUsecaseComputing",
    labelKey: "workflow.editor.palette.usecase",
    hintKey: "workflow.editor.palette.usecaseHint",
    icon: <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />,
  },
  {
    kind: "Script",
    labelKey: "workflow.editor.palette.script",
    hintKey: "workflow.editor.palette.scriptHint",
    icon: <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />,
  },
  {
    kind: "NoAction",
    labelKey: "workflow.editor.palette.noAction",
    hintKey: "workflow.editor.palette.noActionHint",
    icon: <Box className="h-4 w-4 text-muted-foreground" aria-hidden="true" />,
  },
  {
    kind: "Switch",
    labelKey: "workflow.editor.palette.switch",
    hintKey: "workflow.editor.palette.switchHint",
    icon: <GitBranch className="h-4 w-4 text-sky-500" aria-hidden="true" />,
  },
  {
    kind: "Loop",
    labelKey: "workflow.editor.palette.loop",
    hintKey: "workflow.editor.palette.loopHint",
    icon: <Repeat className="h-4 w-4 text-sky-500" aria-hidden="true" />,
  },
  {
    kind: "Milestone",
    labelKey: "workflow.editor.palette.milestone",
    hintKey: "workflow.editor.palette.milestoneHint",
    icon: <Flag className="h-4 w-4 text-emerald-500" aria-hidden="true" />,
  },
  {
    kind: "SubWorkflow",
    labelKey: "workflow.editor.palette.subWorkflow",
    hintKey: "workflow.editor.palette.subWorkflowHint",
    icon: <Network className="h-4 w-4 text-violet-500" aria-hidden="true" />,
  },
];

export interface NodePaletteProps {
  /** Optional click-to-add fallback for environments where drag isn't viable
   * (touch / accessibility). */
  onAdd?: (kind: GraphNodeKind) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  connectionDropKind?: GraphNodeKind | null;
}

export function NodePalette({
  onAdd,
  collapsed = false,
  onToggleCollapsed,
  connectionDropKind = null,
}: NodePaletteProps) {
  const { t } = useTranslation();
  const title = t("workflow.editor.palette.title");
  if (collapsed) {
    return (
      <aside
        className="flex h-10 w-full shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-2 lg:h-full lg:w-10 lg:flex-col lg:border-b-0 lg:border-r lg:py-2"
        data-testid="rf-palette-collapsed"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("workflow.editor.expandPalette")}
          data-testid="rf-palette-expand"
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpen />
        </Button>
        <span className="text-[11px] text-muted-foreground lg:mt-1 lg:[writing-mode:vertical-rl]">
          {title}
        </span>
      </aside>
    );
  }
  return (
    <aside
      className="flex max-h-72 w-full shrink-0 flex-col gap-3 overflow-y-auto border-b border-border bg-muted/20 p-3 lg:h-full lg:max-h-none lg:border-b-0"
      data-testid="rf-palette"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {onToggleCollapsed ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("workflow.editor.collapsePalette")}
            data-testid="rf-palette-collapse"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose />
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {ITEMS.map((item) => (
          <li key={item.kind}>
            <button
              type="button"
              draggable
              data-node-kind={item.kind}
              data-testid={`rf-palette-${item.kind}`}
              onDragStart={(e) => {
                e.dataTransfer.setData(PALETTE_DRAG_MIME, item.kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd?.(item.kind)}
              className="relative flex w-full cursor-grab flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-card p-2.5 text-left text-xs transition-colors hover:border-ring hover:bg-background active:scale-[0.99]"
            >
              <span className="flex items-center gap-1 font-medium">
                {item.icon}
                {t(item.labelKey)}
              </span>
              <span className="text-[10px] text-muted-foreground">{t(item.hintKey)}</span>
              {connectionDropKind === item.kind ? (
                <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/75 px-3 text-center font-medium text-brand backdrop-blur-sm">
                  {t("workflow.editor.palette.releaseToAdd", { name: t(item.labelKey) })}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
